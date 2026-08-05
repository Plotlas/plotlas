#!/usr/bin/env python3
"""End-to-end acceptance harness for the PRD student scenario (seam 13, WP-A item 1).

This drives the **live** docker-compose stack THROUGH THE CADDY EDGE
(``http://localhost:8080`` by default) exactly as a browser would — it imports no
application code and talks only HTTP + static assets. It is a MANUAL acceptance
tool, **not** a CI gate: it needs the full stack (api + worker + redis + caddy)
running, which the lean CI image does not provide.

Scenario (PRD §"What Done Looks Like", student path), end to end at small scale:

    signup → login → open upload → push image parts + a ZIP carrying a CSV
    → finalize → create dataset (with column_roles + layouts) → poll to "ready"
    → fetch the manifest, list layouts (which ISSUES the viz_ds edge credential)
    → for each layout RANGE-READ a tile out of its PMTiles pyramid and decode both
    bands (WebP mini-atlas + Arrow IPC cell records), fetch + decode the tag sidecar
    (Arrow IPC) → assert the observed Content-Encoding on the static assets (PR30-2)
    → probe that the edge refuses a `..` traversal (R-S10) → delete the dataset
    (204) and confirm it is gone.

Two edge contracts every /datasets/* fetch here depends on:

* **The gate (T2-09 / D-A).** The static edge is behind a Caddy forward_auth
  sub-request, so an un-credentialed asset fetch 401s before file_server is reached.
  Each fetch carries the dataset-scoped ``viz_ds`` cookie the manifest GET issues. A
  browser replays it from its jar; this harness has none (it stays dependency-free),
  so it threads the header by hand — see ``edge_cookie``.
* **Range reads (D-33).** Tiles are not individual files: each layout is ONE PMTiles
  container and the renderer HTTP-Range-reads {z}/{x}/{y} out of it. This harness
  reads it the same way — the real ``pmtiles`` Reader driven by an HTTP Range source
  (``pmtiles_range_source``) — so a broken Range/206 path fails here as it would in
  the browser.

It also asserts **PR12-3**: one input image is intentionally UNDECODABLE (an image
extension with garbage bytes). The manifest's ``image_count`` must EXCLUDE it (it
counts renderable/packed cells), while its metadata row is RETAINED (the id set
stays stable) — checked via the metadata endpoint.

Parametrized by image count (``--images N``; default 10, the fixture-input scale).
The operator points ``--images`` at a larger number, or runs the much bigger real
corpora through the admin UI for the researcher scenario (operator ceremony O1).

Run (host Python is gated in this repo — run inside the test image, which has
pyarrow; reach the host-published edge via host.docker.internal on Docker Desktop):

    docker compose up -d --build          # from this worktree (isolated by dir name)
    docker build -f docker/Dockerfile.test -t image-viz-test .
    MSYS_NO_PATHCONV=1 docker run --rm --add-host host.docker.internal:host-gateway \\
        -e ACCEPTANCE_BASE_URL=http://host.docker.internal:8080 \\
        -v "$(pwd):/repo" image-viz-test python tests/e2e/run_acceptance.py
    docker compose down -v

Or, if you have a host venv with pyarrow and the stack's :8080 is reachable
directly, simply: ``python tests/e2e/run_acceptance.py``.

Exit code 0 = every assertion held; non-zero = a step failed (the failing step and
the full step/timing report are printed first).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import zlib
from dataclasses import dataclass, field
from http.cookies import SimpleCookie

import pyarrow as pa
import pyarrow.ipc as ipc

# The SAME reader the pipeline writes with (pmtiles>=3.7,<4, pinned into the test
# image via the Makefile's test-extra.in). Using the real library rather than
# hand-rolling the v3 spec keeps this harness honest about the container the
# renderer actually consumes — directory traversal, gzipped internal directories
# and Hilbert tile addressing all come for free. It is a third-party library, not
# application code, so the "imports no application code" rule still holds.
from pmtiles.reader import Reader, all_tiles

# ---------------------------------------------------------------------------
# Tiny HTTP client (stdlib only — the harness is a black-box browser stand-in).
# ---------------------------------------------------------------------------

DEFAULT_BASE_URL = "http://localhost:8080"
_IMAGE_EXTS_NOTE = "png"  # the pipeline whitelist accepts .png; we emit PNGs

# The cell-record columns a decoded FINE tile must carry — kept EQUAL to the
# `required` list in schemas/v2/cell_record.schema.json, which
# tests/contract/test_acceptance_harness_assumptions.py enforces in CI. That pin is
# deliberate: this harness is manual-only, so a schema change that invalidates it
# would otherwise sit undetected until someone happened to run it (exactly how it
# rotted from D-33 in June until July).
REQUIRED_CELL_COLUMNS = {"id", "x", "y", "w", "h", "u", "v", "uw", "uh"}


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))


def _request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    cookie: str | None = None,
    byte_range: tuple[int, int] | None = None,
    json_body: object | None = None,
    multipart: tuple[str, str, bytes] | None = None,
    timeout: float = 30.0,
) -> Response:
    """One HTTP request. `multipart` is (field_name, filename, content) for an
    upload part. `cookie` is a raw Cookie header value (the jar is a single string —
    the edge only ever needs viz_ds). `byte_range` is an inclusive (first, last)
    pair sent as `Range: bytes=first-last`. Returns the response even on 4xx/5xx (no
    raise) so callers assert the status themselves.

    Dot-segments in `url` reach the wire VERBATIM: urllib does not resolve `..`
    (verified against a raw socket). That is what makes the R-S10 traversal probe a
    real probe and not a request for an already-normalized path — note curl does the
    opposite and normalizes unless given --path-as-is."""
    data: bytes | None = None
    headers: dict[str, str] = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    if cookie is not None:
        headers["Cookie"] = cookie
    if byte_range is not None:
        headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif multipart is not None:
        field, filename, content = multipart
        boundary = f"----acceptance{uuid.uuid4().hex}"
        buf = io.BytesIO()
        pre = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode("utf-8")
        buf.write(pre)
        buf.write(content)
        buf.write(f"\r\n--{boundary}--\r\n".encode("utf-8"))
        data = buf.getvalue()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return Response(
                status=resp.status,
                headers={k.lower(): v for k, v in resp.headers.items()},
                body=resp.read(),
            )
    except urllib.error.HTTPError as exc:
        return Response(
            status=exc.code,
            headers={k.lower(): v for k, v in (exc.headers or {}).items()},
            body=exc.read(),
        )


# ---------------------------------------------------------------------------
# Dependency-free image generation: valid PNGs (no pyvips needed to PRODUCE the
# inputs — only pyarrow to DECODE the outputs). A 1×1 solid-color PNG per id keeps
# every input a genuinely decodable image while staying tiny and distinct.
# ---------------------------------------------------------------------------


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def make_png(r: int, g: int, b: int) -> bytes:
    """A minimal valid 1×1 RGB PNG of the given color (libvips decodes it fine)."""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)  # 1×1, 8-bit, truecolor
    raw = bytes([0]) + bytes([r, g, b])  # one scanline: filter byte + RGB pixel
    idat = zlib.compress(raw, 9)
    return sig + _png_chunk(b"IHDR", ihdr) + _png_chunk(b"IDAT", idat) + _png_chunk(b"IEND", b"")


def build_inputs(n_images: int) -> tuple[list[tuple[str, bytes]], list[tuple[str, bytes]], bytes, str, str]:
    """Construct the student bundle inputs.

    Returns (plain_parts, zip_entries, csv_bytes, undecodable_name, expected_no_meta).
    - plain_parts: (filename, bytes) pushed as individual image parts.
    - zip_entries: (archive_path, bytes) packed into a ZIP part (nested dirs + the CSV).
    - csv_bytes: the metadata CSV (root of the ZIP), joined by filename.
    - undecodable_name: an image-extension file with garbage bytes (PR12-3): it is
      ingested (metadata row kept) but never packs, so image_count excludes it.
    - expected_no_meta: a decodable image present in images but ABSENT from the CSV,
      proving the left-join keeps images without metadata.

    Layout of the n images: half pushed as plain parts, half inside the ZIP, so the
    harness exercises BOTH the plain-part path and the D-27 ZIP-extraction path. The
    CSV gives every image a `year` (categorical) so categorical+grid both build.
    """
    if n_images < 3:
        n_images = 3  # need room for: undecodable, no-meta, and >=1 plain/zip each
    names = [f"img_{i:05d}.png" for i in range(n_images)]
    # Distinct solid colors so each PNG differs (not strictly required, but realistic).
    images = {name: make_png((i * 37) % 256, (i * 91) % 256, (i * 53) % 256) for i, name in enumerate(names)}

    undecodable_name = "img_broken.png"  # image extension, NOT a real image
    images[undecodable_name] = b"\x89PNG\r\n\x1a\nGARBAGE-not-a-valid-png-body"

    # Split decodable images across plain parts and the ZIP.
    decodable = list(names)
    half = max(1, len(decodable) // 2)
    plain_names = decodable[:half] + [undecodable_name]  # push the broken one as a plain part
    zip_names = decodable[half:]

    plain_parts = [(nm, images[nm]) for nm in plain_names]
    zip_image_entries = {f"shoebox/2019/{nm}": images[nm] for nm in zip_names}

    # CSV: filename + year (categorical) + tags (TAG role, '|'-delimited) for every
    # image EXCEPT one decodable image (no-meta proof), and including a row for the
    # undecodable one (its row must survive ingest). The tag role is what makes the
    # pipeline write the Arrow tag sidecar the harness then fetches + decodes.
    expected_no_meta = decodable[-1] if len(decodable) >= 2 else ""
    csv_lines = ["filename,year,tags"]
    for i, nm in enumerate(names):
        if nm == expected_no_meta:
            continue  # leave this image out of the CSV
        tag_values = f"col{i % 3}|all"  # 2 tags per cell, '|'-delimited
        csv_lines.append(f"{nm},{2000 + (i % 5)},{tag_values}")
    csv_lines.append(f"{undecodable_name},1999,col0|all")  # row kept even though it won't pack
    csv_bytes = ("\n".join(csv_lines) + "\n").encode("utf-8")

    zip_entries = dict(zip_image_entries)
    zip_entries["metadata.csv"] = csv_bytes  # root-level CSV becomes the bundle metadata
    zip_entry_list = list(zip_entries.items())
    return plain_parts, zip_entry_list, csv_bytes, undecodable_name, expected_no_meta


def make_zip(entries: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Step/timing report.
# ---------------------------------------------------------------------------


@dataclass
class Step:
    name: str
    seconds: float
    detail: str = ""


@dataclass
class Report:
    steps: list[Step] = field(default_factory=list)

    def add(self, name: str, seconds: float, detail: str = "") -> None:
        self.steps.append(Step(name, seconds, detail))

    def print(self) -> None:
        print("\n=== acceptance step/timing report ===")
        width = max((len(s.name) for s in self.steps), default=10)
        total = 0.0
        for s in self.steps:
            total += s.seconds
            extra = f"  {s.detail}" if s.detail else ""
            print(f"  {s.name.ljust(width)}  {s.seconds * 1000:8.0f} ms{extra}")
        print(f"  {'TOTAL'.ljust(width)}  {total * 1000:8.0f} ms")


class StepTimer:
    """Context manager that records a step's wall time into the report."""

    def __init__(self, report: Report, name: str) -> None:
        self.report = report
        self.name = name
        self.detail = ""
        self._t0 = 0.0

    def __enter__(self) -> "StepTimer":
        self._t0 = time.monotonic()
        return self

    def __exit__(self, *exc: object) -> None:
        self.report.add(self.name, time.monotonic() - self._t0, self.detail)


# ---------------------------------------------------------------------------
# Assertions helpers.
# ---------------------------------------------------------------------------


class AcceptanceError(AssertionError):
    """A scenario assertion failed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AcceptanceError(message)


def decode_arrow(body: bytes) -> pa.Table:
    """Decode Arrow IPC (Feather) bytes to a table. Tiles and the tag sidecar are
    BOTH Arrow IPC; the renderer (apache-arrow JS) requires them UNCOMPRESSED
    (D-29), and a successful decode here is the byte-level proof the wire format is
    readable. Tries the stream framing then the file framing."""
    try:
        return ipc.open_stream(body).read_all()
    except pa.lib.ArrowInvalid:
        return ipc.open_file(body).read_all()


def edge_cookie(resp: Response) -> str:
    """Pull the `viz_ds` edge credential out of the manifest GET's Set-Cookie.

    Dataset-open is ALSO credential issuance (D-A): the manifest response that tells
    us where the assets live is the one that mints the cookie authorizing them. The
    name is hardcoded rather than imported because this harness is a black-box client
    and imports no application code."""
    raw = resp.headers.get("set-cookie", "")
    jar: SimpleCookie = SimpleCookie()
    jar.load(raw)
    require(
        "viz_ds" in jar,
        f"the manifest GET issued no viz_ds edge cookie (Set-Cookie={raw!r}) — the "
        "static edge is gated by forward_auth (D-A), so every asset fetch would 401",
    )
    return f"viz_ds={jar['viz_ds'].value}"


_FINE_PREFIX = struct.Struct(">I")


def unpack_fine_body(body: bytes) -> tuple[bytes, bytes]:
    """Split a FINE tile body into (webp_mini_atlas, arrow_ipc_records).

    The D-33 fine framing is `[uint32 BE image_len][WebP][Arrow IPC]` — one tile
    bundles its own mini-atlas with the cell records that index into it, which is why
    v2 has no standalone atlas/ tree to fetch. Re-inlined rather than imported from
    pipeline.tiler (this harness takes no application dependency); the canonical
    implementation is `unpack_fine_body` in packages/pipeline/pipeline/tiler.py, and
    tools/calibration/verify_bake.py re-inlines it the same way."""
    require(
        len(body) >= _FINE_PREFIX.size,
        f"fine tile body is {len(body)}B — too short to carry the uint32 length prefix",
    )
    (image_len,) = _FINE_PREFIX.unpack_from(body, 0)
    start = _FINE_PREFIX.size
    require(
        start + image_len <= len(body),
        f"fine tile declares image_len={image_len} but the body is only {len(body)}B",
    )
    return body[start : start + image_len], body[start + image_len :]


def pmtiles_range_source(url: str, cookie: str, on_fetch: list[int]):
    """An HTTP `get_bytes(offset, length)` source for the pmtiles Reader.

    The library takes a source CALLABLE, not a file (`MmapSource` is just a closure
    factory over mmap), so pointing it at the live edge is a drop-in swap — and it
    means this harness exercises the very same directory traversal + Hilbert
    addressing the browser does, over the very same Range requests.

    Strictness matters here: the Reader does NOT re-slice what we return, it trusts
    the source to hand back exactly the requested window. So a 200 (server ignored
    Range and sent the whole file) must be REJECTED rather than passed through — the
    directory decoder would silently misparse it. The frontend's FetchRangeSource
    guards the identical case (packages/frontend/src/renderer/pmtilesClient.ts). We
    allow one narrow exception, offset 0 with a body no longer than asked, since that
    prefix is genuinely what we requested."""

    def get_bytes(offset: int, length: int) -> bytes:
        resp = _request(
            "GET", url, cookie=cookie, byte_range=(offset, offset + length - 1)
        )
        on_fetch.append(len(resp.body))
        if resp.status == 206:
            return resp.body
        if resp.status == 200 and offset == 0 and len(resp.body) <= length:
            return resp.body
        raise AcceptanceError(
            f"range read of {url} [{offset}..{offset + length - 1}] returned "
            f"{resp.status} with {len(resp.body)}B — the edge must answer a Range "
            f"request with 206 Partial Content (Caddy file_server does; a 200 here "
            f"means Range was ignored and the pmtiles directory decode would "
            f"silently misparse the whole file as a directory)"
        )

    return get_bytes


def assert_uncompressed_static(resp: Response, what: str) -> str:
    """PR30-2: a static asset served by Caddy must NOT arrive gzip/deflate/br
    encoded (apache-arrow JS cannot decode a compressed Arrow record batch, and the
    versioned assets are served immutable). Returns the observed encoding string for
    the report. `Content-Encoding` absent ⇒ identity (uncompressed), which is what
    we require."""
    enc = resp.headers.get("content-encoding", "")
    require(
        enc in ("", "identity"),
        f"{what}: expected uncompressed (no Content-Encoding) but observed "
        f"Content-Encoding={enc!r} — apache-arrow JS cannot decode it (PR30-2)",
    )
    return enc or "identity"


# ---------------------------------------------------------------------------
# The scenario.
# ---------------------------------------------------------------------------


def run(base_url: str, n_images: int, poll_timeout: float) -> Report:
    base_url = base_url.rstrip("/")
    report = Report()
    suffix = uuid.uuid4().hex[:8]
    username = f"student_{suffix}"
    password = "s3cretpw-acceptance"
    dataset_id = f"acceptance_{suffix}"

    print(f"base_url={base_url}  images={n_images}  dataset_id={dataset_id}")

    # 0. health (fail fast + clearest error if the stack/edge is not up).
    with StepTimer(report, "health") as st:
        resp = _request("GET", f"{base_url}/api/health")
        require(resp.status == 200, f"health check failed: {resp.status} {resp.body!r}")
        st.detail = "edge reachable"

    # 1. signup + login.
    with StepTimer(report, "signup"):
        resp = _request(
            "POST",
            f"{base_url}/api/auth/signup",
            json_body={"username": username, "email": f"{username}@example.com", "password": password},
        )
        require(resp.status == 200, f"signup failed: {resp.status} {resp.body!r}")
    with StepTimer(report, "login"):
        resp = _request(
            "POST", f"{base_url}/api/auth/login",
            json_body={"username": username, "password": password},
        )
        require(resp.status == 200, f"login failed: {resp.status} {resp.body!r}")
        token = resp.json()["access_token"]  # type: ignore[index]

    # 2. build inputs and run the upload (plain parts + a ZIP carrying the CSV).
    plain_parts, zip_entries, _csv, undecodable_name, expected_no_meta = build_inputs(n_images)
    with StepTimer(report, "upload.create"):
        resp = _request("POST", f"{base_url}/api/uploads", token=token)
        require(resp.status == 200, f"create upload failed: {resp.status} {resp.body!r}")
        upload_id = resp.json()["upload_id"]  # type: ignore[index]

    with StepTimer(report, "upload.parts") as st:
        for name, content in plain_parts:
            resp = _request(
                "POST", f"{base_url}/api/uploads/{upload_id}/parts",
                token=token, multipart=("part", name, content),
            )
            require(resp.status == 200, f"upload part {name} failed: {resp.status} {resp.body!r}")
        # The ZIP part: extracted server-side (D-27); nested image dirs flatten,
        # the root CSV becomes the bundle metadata.
        zip_bytes = make_zip(zip_entries)
        resp = _request(
            "POST", f"{base_url}/api/uploads/{upload_id}/parts",
            token=token, multipart=("part", "shoebox.zip", zip_bytes),
        )
        require(resp.status == 200, f"upload ZIP failed: {resp.status} {resp.body!r}")
        st.detail = f"{len(plain_parts)} parts + 1 zip ({len(zip_entries) - 1} images, 1 csv)"

    with StepTimer(report, "upload.finalize"):
        resp = _request("POST", f"{base_url}/api/uploads/{upload_id}/finalize", token=token)
        require(resp.status == 200, f"finalize failed: {resp.status} {resp.body!r}")

    # 3. create the dataset. Metadata roles: `year` categorical (→ categorical
    #    layout) and `tags` as a TAG role (→ the Arrow tag sidecar we decode below).
    column_roles = {
        "filename": {"column": "filename", "label": "File"},
        "categorical": [{"column": "year", "label": "Year"}],
        "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
    }
    with StepTimer(report, "dataset.create"):
        resp = _request(
            "POST", f"{base_url}/api/datasets", token=token,
            json_body={
                "dataset_id": dataset_id,
                "upload_id": upload_id,
                "column_roles": column_roles,
                "layout_types": ["grid", "categorical"],
            },
        )
        require(resp.status == 200, f"create dataset failed: {resp.status} {resp.body!r}")
        job_id = resp.json()["job_id"]  # type: ignore[index]

    try:
        # 4. poll to ready (the worker decodes/packs/tiles; status derives from D-28).
        with StepTimer(report, "ingest.poll") as st:
            manifest_status, polls = _poll_ready(base_url, token, dataset_id, job_id, poll_timeout)
            require(
                manifest_status == "ready",
                f"dataset did not reach 'ready' within {poll_timeout:.0f}s "
                f"(last status={manifest_status!r}); check worker logs",
            )
            st.detail = f"{polls} polls"

        # 5. fetch the dataset summary + manifest + layouts.
        n_expected_renderable = n_images if n_images >= 3 else 3  # all PNGs decode; broken excluded
        with StepTimer(report, "summary") as st:
            resp = _request("GET", f"{base_url}/api/datasets/{dataset_id}", token=token)
            require(resp.status == 200, f"get dataset failed: {resp.status} {resp.body!r}")
            summary = resp.json()
            require(summary["status"] == "ready", f"summary not ready: {summary}")  # type: ignore[index]
            image_count = summary["image_count"]  # type: ignore[index]
            # PR12-3: the undecodable image is NOT counted (renderable cells only).
            require(
                image_count == n_expected_renderable,
                f"image_count={image_count} but expected {n_expected_renderable} renderable "
                f"cells (the undecodable {undecodable_name!r} must be EXCLUDED — PR12-3)",
            )
            st.detail = f"image_count={image_count} (excludes the undecodable image)"

        with StepTimer(report, "manifest") as st:
            resp = _request("GET", f"{base_url}/api/datasets/{dataset_id}/layouts", token=token)
            require(resp.status == 200, f"list layouts failed: {resp.status} {resp.body!r}")
            layouts = resp.json()["layouts"]  # type: ignore[index]
            layout_ids = [layout["layout_id"] for layout in layouts]
            require("grid" in layout_ids, f"grid layout missing: {layout_ids}")
            # Fetch the full manifest via the first layout's manifest route.
            resp = _request(
                "GET", f"{base_url}/api/datasets/{dataset_id}/layouts/{layout_ids[0]}", token=token,
            )
            require(resp.status == 200, f"get manifest failed: {resp.status} {resp.body!r}")
            manifest = resp.json()
            require(isinstance(manifest, dict) and "layouts" in manifest, "manifest shape unexpected")  # type: ignore[arg-type]
            # Dataset-open is ALSO edge-credential issuance (D-A): this very response
            # mints the viz_ds cookie that authorizes every asset fetch below.
            ds_cookie = edge_cookie(resp)
            st.detail = f"layouts={layout_ids}, edge cookie issued"

        manifest_layouts = {layout["layout_id"]: layout for layout in manifest["layouts"]}  # type: ignore[index]
        # There is deliberately no manifest["atlas"] to read: D-33 folded the atlas
        # into each FINE tile body as a per-tile WebP mini-atlas, so there is no
        # standalone atlas/ tree to fetch. It is asserted in the tiles step below.
        tags_decl = manifest.get("tags")  # type: ignore[union-attr]

        # 6. for each layout: RANGE-READ a tile out of its PMTiles pyramid (D-33) and
        #    decode BOTH bands, asserting the container arrives uncompressed (PR30-2).
        #
        #    There is no per-LOD .feather tree and no tile index to fetch any more: a
        #    layout's whole pyramid is ONE .pmtiles container that the renderer
        #    byte-range-reads {z}/{x}/{y} out of. We read it the same way — the real
        #    pmtiles Reader over an HTTP Range source — so a broken Range/206 path or
        #    a corrupt directory fails here exactly as it would in the browser.
        with StepTimer(report, "tiles.decode") as st:
            encodings: set[str] = set()
            summaries: list[str] = []
            for layout_id, layout in manifest_layouts.items():
                pyramid = layout["pyramid"]
                require(
                    pyramid.get("container") == "pmtiles",
                    f"{layout_id}: pyramid container is {pyramid.get('container')!r}, "
                    f"expected 'pmtiles' (D-33)",
                )
                url = f"{base_url}/datasets/{dataset_id}/{pyramid['path']}"
                z_cap = pyramid["z_cap"]

                # The container itself: served, uncompressed, and Range-able. Caddy's
                # file_server answers Range with 206; the renderer's whole tile path
                # depends on that, so assert it before trusting any read below.
                head = _request("GET", url, cookie=ds_cookie, byte_range=(0, 15))
                require(
                    head.status == 206,
                    f"{layout_id}: pyramid {url} answered {head.status} to a Range "
                    f"request, expected 206 Partial Content",
                )
                encodings.add(assert_uncompressed_static(head, f"pyramid {layout_id}"))
                require(
                    head.body[:7] == b"PMTiles",
                    f"{layout_id}: not a PMTiles container (magic={head.body[:8]!r})",
                )

                reads: list[int] = []
                source = pmtiles_range_source(url, ds_cookie, reads)
                root = Reader(source).get(0, 0, 0)
                require(
                    root is not None,
                    f"{layout_id}: pyramid has no root tile (0,0,0) — z=0 spans the "
                    f"whole layout bbox, so any non-empty layout must have one",
                )

                # z_cap decides the framing, and z=0 is NOT reliably coarse: a tile is
                # FINE when z >= z_cap, so when z_cap == 0 (the small-dataset case, and
                # the default at this harness's scale) the ROOT tile is itself fine.
                # Assuming "z=0 ⇒ raw WebP overview" would corrupt the decode there.
                if 0 >= z_cap:
                    fine_body = root
                else:
                    require(
                        root[:4] == b"RIFF",
                        f"{layout_id}: coarse root tile (z=0 < z_cap={z_cap}) must be "
                        f"a raw WebP overview, got {root[:8]!r}",
                    )
                    # ...and still prove the fine band: walk to the first tile at or
                    # below z_cap. all_tiles/traverse is a generator, so breaking out
                    # early stops fetching rather than pulling the whole pyramid.
                    fine_body = None
                    for (z, _x, _y), data in all_tiles(source):
                        if z >= z_cap:
                            fine_body = data
                            break
                    require(
                        fine_body is not None,
                        f"{layout_id}: no fine tile at z>={z_cap} in the pyramid",
                    )

                # A FINE tile bundles its own mini-atlas with the records that index
                # into it: [uint32 BE image_len][WebP][Arrow IPC]. This is where the
                # v1 standalone atlas page went (D-33), so the WebP assertion that
                # used to be its own step lives here now.
                image, records = unpack_fine_body(fine_body)
                require(
                    image[:4] == b"RIFF",
                    f"{layout_id}: fine tile's mini-atlas band is not a WebP: {image[:8]!r}",
                )
                table = decode_arrow(records)  # the byte-level D-29 proof
                missing = REQUIRED_CELL_COLUMNS - set(table.column_names)
                require(
                    not missing,
                    f"{layout_id}: fine tile records missing required v2 cell-record "
                    f"columns {sorted(missing)} (have {table.column_names})",
                )
                summaries.append(
                    f"{layout_id}(z_cap={z_cap}, {table.num_rows} cells, "
                    f"{len(image)}B webp, {len(reads)} range reads)"
                )
            st.detail = f"{'; '.join(summaries)} | encodings={sorted(encodings)}"

        # 7. tag sidecar: fetch + decode (Arrow IPC), assert uncompressed (D-29/PR30-2).
        #    The CSV declares a TAG role (`tags`), so the pipeline writes the sidecar and
        #    the manifest carries a `tags` declaration whose `path` is version-stamped.
        with StepTimer(report, "tags.decode") as st:
            require(
                tags_decl is not None,
                "manifest declares no tags sidecar despite a TAG role in column_roles — "
                "the pipeline should have written tags/tags_v{ver}.arrow (D-14)",
            )
            require(tags_decl.get("format") == "arrow", f"unexpected tags format: {tags_decl}")  # type: ignore[union-attr]
            tags_url = f"{base_url}/datasets/{dataset_id}/{tags_decl['path']}"  # type: ignore[index]
            resp = _request("GET", tags_url, cookie=ds_cookie)
            require(resp.status == 200, f"tag sidecar 404: {tags_url} ({resp.status})")
            enc = assert_uncompressed_static(resp, "tag sidecar")
            tags_table = decode_arrow(resp.body)  # the byte-level D-29 proof
            require("id" in tags_table.column_names, f"tag sidecar missing 'id': {tags_table.column_names}")
            st.detail = f"{tags_table.num_rows} rows, cols={tags_table.column_names}, encoding={enc}"

        # 8. R-S10 / Seam H2: the forward_auth gate refuses a `..` traversal ON THE
        #    REAL EDGE. The API's unit matrix (packages/api/tests/test_edge_auth.py)
        #    proves only the Python half — that _extract_ds_id rejects. It cannot see
        #    whether the gate is WIRED: that forward_auth runs ahead of file_server,
        #    and that the snippet's `X-Forwarded-Uri {http.request.orig_uri}` really
        #    hands it the un-stripped path. Those are edge-config properties, and this
        #    is the only place they are checked.
        #
        #    Reading a failure: the tiles step above just range-read this dataset's own
        #    pyramid with this very cookie, so the credential is known-good and the only
        #    thing that can refuse a `..` spelling is the gate's own check. urllib puts
        #    dot-segments on the wire verbatim (see _request), so what Caddy receives is
        #    genuinely un-normalized.
        with StepTimer(report, "authz.traversal") as st:
            _first_layout, first = next(iter(manifest_layouts.items()))
            asset = first["pyramid"]["path"]
            # Traverse to a sibling dataset id that does not exist: a PRE-FIX gate
            # reads the id as {dataset_id} — which our cookie matches — and lets the
            # request through, so the 403-vs-404 split is exactly what discriminates.
            other = f"{dataset_id}_traversal_target"
            hints = {
                404: "the gate PASSED the traversal through and file_server went "
                     "looking for the traversed-to dataset — the gate is not seeing "
                     "the `..` (check X-Forwarded-Uri {http.request.orig_uri})",
                200: "another dataset's bytes were served outright",
                401: "the cookie never reached the gate — a harness bug, not a gate bug",
            }
            for spelling, dots in (("literal", ".."), ("encoded", "%2e%2e")):
                uri = f"{base_url}/datasets/{dataset_id}/{dots}/{other}/{asset}"
                resp = _request("GET", uri, cookie=ds_cookie)
                require(
                    resp.status == 403,
                    f"R-S10 REGRESSION: a {spelling} `..` traversal out of "
                    f"{dataset_id} returned {resp.status}, expected 403 from the "
                    f"forward_auth gate — {hints.get(resp.status, 'unexpected status')}"
                    f". URI={uri}",
                )
            st.detail = "literal + encoded `..` refused at the edge (403)"

        # 9. metadata: the undecodable image's row is RETAINED (PR12-3) and an image
        #    absent from the CSV still has a row (left-join). Query a window of ids.
        with StepTimer(report, "metadata") as st:
            ids = ",".join(str(i) for i in range(min(n_images + 1, 250)))
            resp = _request("GET", f"{base_url}/api/datasets/{dataset_id}/metadata?ids={ids}", token=token)
            require(resp.status == 200, f"metadata fetch failed: {resp.status} {resp.body!r}")
            rows = resp.json()["rows"]  # type: ignore[index]
            # Every scanned image (incl. the undecodable one) keeps a metadata row, so
            # the row count tracks the SCANNED images, not the renderable count.
            require(len(rows) >= 1, "metadata returned no rows")
            st.detail = f"{len(rows)} rows (>= renderable {n_expected_renderable}; undecodable row retained)"

        # 10. delete + confirm gone.
        with StepTimer(report, "delete"):
            resp = _request("DELETE", f"{base_url}/api/datasets/{dataset_id}", token=token)
            require(resp.status == 204, f"delete failed: {resp.status} {resp.body!r}")
        with StepTimer(report, "delete.verify"):
            resp = _request("GET", f"{base_url}/api/datasets/{dataset_id}", token=token)
            require(resp.status == 404, f"dataset still present after delete: {resp.status}")

    finally:
        # PR #38 review finding 2: a failed run must not leak its dataset. On the
        # success path the dataset is already deleted (the extra DELETE is a
        # harmless 404); on any post-create failure this is the cleanup.
        try:
            _request("DELETE", f"{base_url}/api/datasets/{dataset_id}", token=token)
        except Exception:
            pass
    return report


def _poll_ready(
    base_url: str, token: str, dataset_id: str, job_id: str, timeout: float
) -> tuple[str, int]:
    """Poll GET /api/datasets/{id} until status is terminal ('ready' or 'error') or
    the timeout elapses. Returns (last_status, poll_count). Also tails the job on
    'error' so the operator sees why."""
    deadline = time.monotonic() + timeout
    polls = 0
    last = "unknown"
    while time.monotonic() < deadline:
        polls += 1
        resp = _request("GET", f"{base_url}/api/datasets/{dataset_id}", token=token)
        if resp.status == 200:
            last = resp.json()["status"]  # type: ignore[index]
            if last == "ready":
                return last, polls
            if last == "error":
                job = _request("GET", f"{base_url}/api/jobs/{job_id}", token=token)
                if job.status == 200:
                    body = job.json()
                    print(f"  job error: {body.get('error')}\n  log tail:")  # type: ignore[union-attr]
                    for line in body.get("log_tail", [])[-15:]:  # type: ignore[union-attr]
                        print(f"    {line}")
                return last, polls
        time.sleep(1.0)
    return last, polls


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="image-viz e2e acceptance harness (student scenario)")
    parser.add_argument(
        "--base-url",
        default=os.environ.get("ACCEPTANCE_BASE_URL", DEFAULT_BASE_URL),
        help="Caddy edge base URL (default %(default)s; env ACCEPTANCE_BASE_URL)",
    )
    parser.add_argument(
        "--images", type=int, default=int(os.environ.get("ACCEPTANCE_IMAGES", "10")),
        help="number of (decodable) input images to synthesize (default 10 — fixture scale)",
    )
    parser.add_argument(
        "--poll-timeout", type=float, default=float(os.environ.get("ACCEPTANCE_POLL_TIMEOUT", "300")),
        help="seconds to wait for ingest to reach 'ready' (default 300)",
    )
    args = parser.parse_args(argv)

    report = Report()
    try:
        report = run(args.base_url, args.images, args.poll_timeout)
    except AcceptanceError as exc:
        report.print()
        print(f"\nFAILED: {exc}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(
            f"\nFAILED: could not reach the stack at {args.base_url} ({exc}).\n"
            "Is the compose stack up (`docker compose up -d --build`)? From a "
            "container, set ACCEPTANCE_BASE_URL=http://host.docker.internal:8080.",
            file=sys.stderr,
        )
        return 2
    report.print()
    print("\nPASSED: student acceptance scenario held end-to-end.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
