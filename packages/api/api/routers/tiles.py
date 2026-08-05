"""Serve a layout's PMTiles pyramid container and the optional detail-tier originals.

v2 (decision D-33, schemas/v2/) replaces the v1 shared id-ordered atlas + per-LOD
quadtree of pointer-only `.feather` tiles. Each layout now owns ONE spatial tile
pyramid baked into a single PMTiles container (`layout["pyramid"]["path"]`, e.g.
`tiles/grid/grid_v1.pmtiles`); the frontend's PMTiles client addresses a tile by
issuing an HTTP Range request for `{z}/{x}/{y}` WITHIN that one immutable file. So
the API serves the WHOLE container with native byte-range support — there is NO
per-tile extraction route (resolved decision Q6: dev serving is whole-file range
requests; the PMTiles client does the seeking). Starlette's `FileResponse` emits
`Accept-Ranges: bytes` and answers a `Range` request with `206 Partial Content`,
exactly what the PMTiles client needs.

Two routes (both read-only; visibility-scoped per D-34 — an OPTIONAL identity
[get_optional_user] + appstate.may_read, so a public dataset's tiles/cover/detail
serve anonymously while a private one 404s a non-owner, the same 404 as a missing
dataset):

* GET /api/datasets/{ds_id}/pyramid/{layout_id}.pmtiles
    The layout's PMTiles container, composed from the manifest's `pyramid.path`
    (the single source of truth — version-embedded, so the `immutable` cache header
    is honest). 404 on an unknown layout or a missing container file.

* GET /api/datasets/{ds_id}/detail/{cell_id}.{ext}
    One full-resolution original for the deepest DETAIL tier (manifest
    `layout.detail`, `mode: "image_ref"`), addressed by DENSE cell id — the
    click-through preview source. Resolved under the manifest's CURRENT
    `detail.path_prefix` as `{path_prefix}/{cell_id}.{ext}`. The detail tier is
    OPTIONAL (decision D-33): 404 when no layout declares an `image_ref` detail block
    or the file is absent. This URL is UNVERSIONED — a re-ingest reuses it with new
    bytes (it resolves to whatever the current manifest's `path_prefix` names) — so it
    does NOT claim `immutable`; it uses a short, revalidated cache (`_DETAIL_CACHE`).
    This is the path the current frontend (`client.detailUrl`) uses.

* GET /api/datasets/{ds_id}/detail/v{version}/{cell_id}.{ext}
    The SAME original addressed by a VERSION-STAMPED URL (T2-46). Since the detail
    tier is now baked under `detail/v{dataset_version}/` (mirroring the pyramid/tag
    version-stamp conventions), a URL that carries the version resolves to a fixed,
    immutable byte set — so this route DOES serve `Cache-Control: ...immutable`
    (restoring the win the un-versioned route deferred). `version` is validated
    against the version stamped into the manifest's own `detail.path_prefix` — the
    same source the file is resolved through — and a mismatch 404s rather than
    serving a swept/stale version. NOT against `dataset_version`: the two diverge
    whenever a bake KEEPS a tier it did not create (`add-layouts` carries the prefix
    forward while bumping the version; `--detail-tier retain`, T2-175, does so by
    design), and gating on the dataset version 404'd the click-through for exactly
    those datasets (T2-178). A pre-T2-46 flat `detail/`
    prefix carries no stamp and still falls back to `dataset_version`. Available for the
    static Caddy edge and a future frontend
    that opts into versioned detail URLs; the un-versioned route above stays for the
    current frontend, which is why the weak cache is retained there.

In production Caddy serves the pyramid's static versioned path; the detail routes are
the dev fallback. Path resolution composes from the manifest and path-jails every
segment via `db.resolve_under` (the D-30 disjoint-roots jail under the dataset dir).
Does not import another router; does not regenerate tiles.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db

router = APIRouter()

# PMTiles single-file archive. `application/vnd.pmtiles` is the conventional type
# the PMTiles ecosystem uses; the frontend range-requests into it regardless.
_PMTILES_MEDIA_TYPE = "application/vnd.pmtiles"
_IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

# The UN-VERSIONED detail URL (`/detail/{cell_id}.{ext}`) is a STABLE URL whose bytes
# change on a re-ingest (it resolves to whatever the current manifest's `path_prefix`
# names — now `detail/v{version}/`), so it must NOT be `immutable`: a short, revalidated
# max-age lets a re-ingest propagate. Starlette's FileResponse stamps an ETag/
# Last-Modified from the file's mtime+size, so a stale client revalidates with a cheap
# 304. The VERSIONED route below carries the version IN THE URL and so serves
# `_IMMUTABLE_CACHE` honestly (T2-46 — the deferred restore).
_DETAIL_CACHE = "public, max-age=300, must-revalidate"

# Detail-tier originals are renderer-decodable images (schemas/v2/ detail.format).
_DETAIL_MEDIA_TYPES = {
    "webp": "image/webp",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
}

# The version stamped into a detail `path_prefix`'s last segment (`detail/v2/` -> 2).
# Mirrors the pipeline's own `worker._DETAIL_VERSION_RE` and the frontend's
# `detailVersionFromPrefix` (kept in sync by hand — the API never imports pipeline code).
# A `\d+` regex, NOT `str.isdigit()` (which accepts non-decimal digits `int()` rejects),
# so an unparseable segment yields None -> the `dataset_version` fallback, never a 500.
_DETAIL_PREFIX_VERSION_RE = re.compile(r"^v(\d+)$")

# The Library-card COVER (T2-55): the pipeline writes an UNVERSIONED `cover.webp` (the
# grid pyramid's z=0 whole-world overview) at the dataset root; a re-ingest replaces its
# bytes in place. Like the un-versioned detail route, its URL carries no version, so it
# reuses the SAME weak revalidated cache — NOT `immutable` (a re-ingest reuses the URL
# with new bytes). Starlette's FileResponse stamps an ETag from mtime+size, so a stale
# card revalidates with a cheap 304. A dataset baked before this feature simply has no
# cover file → 404 (the card falls back to its flat surface block).
# CROSS-PACKAGE CONTRACT: this filename mirrors the pipeline's own (`worker._COVER_NAME`).
# The API never imports pipeline code (one-way pipeline→api), so the two constants are
# kept in sync by hand — pinned by the contract test that asserts the fixture's cover
# equals the grid z0 overview bytes at exactly this name.
_COVER_NAME = "cover.webp"
_COVER_CACHE = _DETAIL_CACHE  # public, max-age=300, must-revalidate


def _find_layout(manifest: dict[str, Any], layout_id: str) -> dict[str, Any]:
    """The matching layout entry, or a 404 (a layout_id naming no layout in the
    manifest is a clean miss, not a path probe)."""
    layout = next(
        (lay for lay in manifest["layouts"] if lay["layout_id"] == layout_id), None
    )
    if layout is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found"
        )
    return layout


@router.get("/api/datasets/{ds_id}/pyramid/{layout_id}.pmtiles")
async def get_pyramid(
    ds_id: str,
    layout_id: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> FileResponse:
    """Serve a layout's whole PMTiles pyramid container with native HTTP Range
    support (Starlette `FileResponse` => Accept-Ranges + 206 Partial Content). The
    frontend's PMTiles client range-requests {z}/{x}/{y} into this single file
    (Q6 — no per-tile route). 404 on unknown layout / missing container.

    D-34: gated by may_read (public ∪ owner). NOTE this is the DEV serving path — in
    production Caddy's static file_server serves the versioned pyramid and the authz
    gate (routers/authz.py, with the visibility cache) does the per-fetch check, so
    the may_read app-state read here is not on the production fan-out hot path."""
    data_root = db.resolve_data_root()
    ds_dir = db.dataset_dir(data_root, ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    manifest = db.load_manifest(ds_dir)  # 404 if absent; major-version guarded
    layout = _find_layout(manifest, layout_id)
    # pyramid.path is manifest-authored (schema-validated, relative, version-embedded,
    # e.g. "tiles/grid/grid_v1.pmtiles"). Split into segments and path-jail under the
    # dataset dir — we never reconstruct the path from a convention, so the API cannot
    # drift from what the pipeline wrote.
    pyramid = layout.get("pyramid")
    if not isinstance(pyramid, dict) or not pyramid.get("path"):
        # A v2 layout always carries a pyramid (schema-required); a manifest without
        # one is malformed for serving, not a client error.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Pyramid not found"
        )
    pmtiles_path = db.resolve_under(ds_dir, *PurePosixPath(pyramid["path"]).parts)
    if not pmtiles_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Pyramid not found"
        )
    return FileResponse(
        pmtiles_path,
        media_type=_PMTILES_MEDIA_TYPE,
        headers={"Cache-Control": _IMMUTABLE_CACHE},
    )


@router.get("/api/datasets/{ds_id}/cover")
async def get_cover(
    ds_id: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> FileResponse:
    """Serve a dataset's Library-card COVER (T2-55): the UNVERSIONED `cover.webp` the
    pipeline wrote from the grid pyramid's z=0 whole-world overview at the dataset root.
    Visibility-scoped (D-34, may_read) and path-jailed exactly like the pyramid/detail
    routes (the cover name is a fixed constant, not client input, but it is still
    resolved through `db.resolve_under` so the serving path can never escape the dataset
    dir). Weak revalidated cache (`_COVER_CACHE`) — the bytes change on a re-ingest, so
    NOT `immutable`. 404 when the dataset has no cover (baked before this feature, or a
    legacy dataset): the card then falls back to its flat surface block."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    # Confirm the dataset exists (major-version-guarded 404 for an unknown/unsupported
    # dataset), mirroring the other read routes — then serve the fixed cover file.
    db.load_manifest(ds_dir)  # 404 if absent; major-version guarded
    cover_path = db.resolve_under(ds_dir, _COVER_NAME)
    if not cover_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Cover not found"
        )
    return FileResponse(
        cover_path,
        media_type="image/webp",
        headers={"Cache-Control": _COVER_CACHE},
    )


def _detail_block(manifest: dict[str, Any]) -> dict[str, Any]:
    """The first layout's `image_ref` detail block, or a 404. The detail tier is
    dataset-level enrichment declared per layout; the first layout carrying an
    image_ref detail block names the originals' `path_prefix` (every layout shares the
    same per-image originals — they differ only in placement, not pixels). Absent =>
    no detail tier baked => 404 (the tier is OPTIONAL, decision D-33)."""
    detail = next(
        (
            lay["detail"]
            for lay in manifest["layouts"]
            if isinstance(lay.get("detail"), dict)
            and lay["detail"].get("mode") == "image_ref"
            and lay["detail"].get("path_prefix")
        ),
        None,
    )
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Detail tier not found"
        )
    return detail


def _detail_prefix_version(detail: dict[str, Any]) -> int | None:
    """The version stamped into the detail block's own `path_prefix` — `"detail/v2/"`
    -> `2` — or None for the pre-T2-46 flat `detail/` shape the schema still permits
    (and for any last segment that is not `v<digits>`, which likewise falls back).

    THIS, NOT `dataset_version`, is what the versioned route gates on (T2-178). The two
    are equal for a plain re-ingest but NOT in general: `add-layouts` carries the
    committed prefix forward while bumping `dataset_version` (pinned in the pipeline's
    own `test_add_layouts_appends_and_carries_forward`), and `ingest --detail-tier
    retain` (T2-175 / #210) does the same by design. Gating on `dataset_version`
    therefore 404'd the click-through lightbox for exactly those datasets, while the
    file itself resolved fine through `path_prefix` — the route validated one source
    and read another.

    Comparing against the prefix is also strictly MORE correct as a staleness check:
    the pipeline's `_sweep_stale_detail` keeps precisely the version the live
    manifest's prefix names, so the prefix is the authority on which tier exists on
    disk. Same rule the sweep and `_sweep_stale_versioned_assets` already follow: the
    manifest's own asset paths say what is live. NOTE this makes the gate DEPEND on the
    sweep keeping the prefix's tier on disk: a bake that advances the prefix's version
    while leaving `detail/v{N}/` swept (the exact failure T2-175 §3 guards against with
    its `keep_version`) would pass this gate and then 404 at file resolution."""
    name = PurePosixPath(str(detail.get("path_prefix", "")).rstrip("/")).name
    match = _DETAIL_PREFIX_VERSION_RE.match(name)
    return int(match.group(1)) if match is not None else None


def _resolve_detail_file(ds_dir, detail: dict[str, Any], cell_id: int, ext: str):
    """Jail + resolve `{detail.path_prefix}/{cell_id}.{ext}` under the dataset dir,
    returning (path, media_type). 404 on an unwhitelisted extension or a missing file.
    `cell_id` is an int (FastAPI-coerced, no traversal); `ext` is whitelisted; the
    manifest-authored `path_prefix` is relative — so no segment carries `..`, and
    `resolve_under` jails the composed path under the dataset dir regardless.

    The API RECONSTRUCTS the filename as `{cell_id}.{ext}` rather than reading the cell
    record's `detail_ref` (those records live inside the PMTiles tiles, not a file this
    read path can see). That holds only because the producer names detail originals
    `{id}.{format}`; the coupling is pinned by the pipeline contract test
    (`packages/pipeline/tests/test_end_to_end.py::_assert_pyramids`)."""
    media_type = _DETAIL_MEDIA_TYPES.get(ext.lower())
    if media_type is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Detail tier not found"
        )
    detail_path = db.resolve_under(
        ds_dir,
        *PurePosixPath(detail["path_prefix"]).parts,
        f"{cell_id}.{ext}",
    )
    if not detail_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Detail image not found"
        )
    return detail_path, media_type


@router.get("/api/datasets/{ds_id}/detail/{cell_id}.{ext}")
async def get_detail(
    ds_id: str,
    cell_id: int,
    ext: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> FileResponse:
    """Serve one detail-tier original by DENSE cell id for click-through preview
    (manifest `detail`, mode `image_ref`), resolving the manifest's CURRENT
    `path_prefix` (`detail/v{version}/`). UN-VERSIONED URL, so a re-ingest reuses it
    with new bytes => `_DETAIL_CACHE` (short, revalidated), NOT `immutable`. This is
    the route the current frontend (`client.detailUrl`) uses; the versioned route
    below is the immutable variant (T2-46). Visibility-scoped (D-34, may_read)."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    manifest = db.load_manifest(ds_dir)  # 404 if absent; major-version guarded
    detail = _detail_block(manifest)
    detail_path, media_type = _resolve_detail_file(ds_dir, detail, cell_id, ext)
    return FileResponse(
        detail_path,
        media_type=media_type,
        headers={"Cache-Control": _DETAIL_CACHE},
    )


@router.get("/api/datasets/{ds_id}/detail/v{version}/{cell_id}.{ext}")
async def get_detail_versioned(
    ds_id: str,
    version: int,
    cell_id: int,
    ext: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> FileResponse:
    """Serve one detail-tier original by a VERSION-STAMPED URL (T2-46) — the immutable
    variant of `get_detail`. Because the detail tier is baked under `detail/v{version}/`
    and the version is IN THE URL, the byte set is fixed => this route serves
    `_IMMUTABLE_CACHE` honestly (the deferred restore). `version` must equal the
    version stamped into the manifest's own `detail.path_prefix` (else 404 — a
    swept/stale version is not served), which is ALSO what the file is resolved
    through, so the route validates and reads the same source. It is deliberately NOT
    `dataset_version`: the two diverge after `add-layouts` and under `--detail-tier
    retain` (T2-175), and gating on the dataset version 404'd the click-through for
    exactly those datasets while the bytes sat there resolvable (T2-178). The API never
    reconstructs the versioned dir from a convention.
    404 when no detail tier is baked, on a version mismatch, or a missing file.
    Visibility-scoped (D-34, may_read)."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    manifest = db.load_manifest(ds_dir)  # 404 if absent; major-version guarded
    detail = _detail_block(manifest)
    # The version the LIVE tier is stamped with. For the pre-T2-46 flat `detail/`
    # shape there is no stamp, so fall back to `dataset_version` — the only version
    # that could mean anything there, and what this route accepted before T2-178.
    # Narrowing the change to versioned prefixes is the point: it must alter
    # behaviour ONLY where the prefix is stamped AND disagrees with dataset_version.
    live_version = _detail_prefix_version(detail)
    if live_version is None:
        live_version = manifest.get("dataset_version")
    if version != live_version:
        # The URL's version does not name the tier that is live — it was swept, or
        # never existed. 404 rather than serve mismatched/absent bytes. Gated on the
        # detail block's OWN prefix, not on `dataset_version`: the two diverge after
        # `add-layouts` and under `--detail-tier retain` (T2-175), and the prefix is
        # what the file below is resolved through (T2-178).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Detail version not found"
        )
    detail_path, media_type = _resolve_detail_file(ds_dir, detail, cell_id, ext)
    return FileResponse(
        detail_path,
        media_type=media_type,
        headers={"Cache-Control": _IMMUTABLE_CACHE},
    )
