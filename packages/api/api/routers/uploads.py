"""Upload session endpoints: create session, upload part(s), finalize -> handle,
query status — plus the Seam O2 resume surface (list / per-file manifest /
pre-check / idempotent re-send / stale-session sweep).

Stores bundles under the jailed DATA_ROOT/users/{owner}/... only (decision D-30 —
disjoint from the dataset tree under DATA_ROOT/datasets/); never accepts a
client-supplied server path and never resolves any path outside DATA_ROOT
(reject `..`/absolute) (decision D-18). All routes require an authenticated
identity. Does not import another router. The upload models live here, per the
catalogue.

Bundle layout (read back by datasets.create_dataset / jobs.start_ingest, which
re-derive the same paths rather than importing this router — module-map rule):

    DATA_ROOT/users/{owner}/uploads/{upload_id}/
        images/            # one file per non-CSV part (basename preserved → D-25 id order)
        metadata.csv|.tsv  # optional single metadata source (the CSV/TSV part)
        .finalized         # marker file; present iff state == "finalized"
        .tally.json        # T2-53 count/bytes tally (+ .tally.lock)
        .files.json        # Seam O2 per-file content manifest {basename: {size, sha256}}
                           #   (+ .files.lock) — server-computed hashes for resume/diff
        .extract-tmp/      # TRANSIENT ZIP staging (D-27); never survives a request

Seam O2 (upload resume, spike §6 + operator decision 2026-07-12): SHA-256 is
computed for FREE inside the existing streaming loops (`_store_part`,
`_extract_entry`) — the bytes already flow through the server — and persisted in
`.files.json` under the same flock discipline as the tally (atomic-replace writes,
lock-free readers never tear, rebuilt from a full re-hash on any doubt). This
backs `GET /api/uploads` (owner-scoped session list), `GET /api/uploads/{id}/files`
(paginated per-file manifest), `POST /api/uploads/{id}/check` (Immich-style
name+size(+hash) pre-check so duplicate bytes are never sent), an idempotent
re-send (a byte-identical duplicate part is a 200 no-op, not a 409), and a
best-effort TTL sweep of abandoned un-finalized sessions (finalized bundles are
ingest sources and are NEVER swept). The stored hashes also seed later duplicate
reporting (T2-109). Server-side hashing ships now; client-side hashing is Seam
O4's opt-in integrity tier.

`part` is typed `bytes` in the interface catalogue; it is elaborated here to
`UploadFile` (the idiomatic FastAPI multipart mechanism `python-multipart` is a
dependency for). The catalogue's "finalize assembles the bundle (images dir +
optional CSV)" cannot be honoured from opaque bytes alone — the part's filename is
what routes the optional CSV apart from images and preserves image basenames for
id-by-filename ordering (D-25). The route shape and `UploadStatus` return type are
unchanged.

ZIP parts (decision D-27): a part whose filename ends `.zip` (case-insensitive)
is EXTRACTED server-side into the bundle instead of stored. Image entries land
flat in images/ by basename regardless of archive nesting (basename-only
placement is zip-slip-proof by construction); a single ROOT-level CSV/TSV
becomes the bundle's metadata file; everything else is ignored and reported in
`UploadStatus.ignored`. Stdlib zipfile only. Extraction is staged into
`.extract-tmp/`, validated whole, then merged with per-file renames — any
violation leaves the session exactly as before the part. Resource caps apply to
the WHOLE bundle (plain parts included): MAX_UPLOAD_BUNDLE_BYTES (uncompressed,
cumulative) and MAX_UPLOAD_ENTRIES, enforced while bytes stream — never trusted
from ZIP headers (ZipInfo.file_size can lie).
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import time
import uuid
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, ValidationError

from api import appstate, db

router = APIRouter()
_logger = logging.getLogger(__name__)

# upload_id charset: exactly what create_upload mints (uuid4 hex) and all the
# charset the consume routes accept. Anchored so a traversal/separator
# (`..`, `/abs`, `a/b`) can never be a valid id — db.resolve_under backstops on
# the filesystem after this cheap first check.
_UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
# Extensions treated as the (optional) metadata source rather than an image. The
# pipeline owns the image-extension whitelist (ingest._scan_images) and rejects an
# empty/duplicate set, so the API does not re-implement it here (avoids drift) —
# EXCEPT for the D-27 ZIP branch below, which must route archive entries.
_CSV_EXTS = (".csv", ".tsv")
_IMAGES_SUBDIR = "images"
_FINALIZED_MARKER = ".finalized"

# T2-53: incremental per-upload tally persisted alongside the bundle, so the
# whole-bundle cap accounting (count + uncompressed bytes) does not rescan every
# file on every part (an O(bundle) `iterdir` + per-file `stat`, quadratic over a
# multi-part session, up to MAX_UPLOAD_ENTRIES entries). `.tally.json` holds
# {"count", "bytes"}; `.tally.lock` serialises the read-modify-write so concurrent
# parts to the same bundle never lose an update (an in-process asyncio lock would
# not serialise across Uvicorn workers — an OS file lock does). Both files are
# session-local, never part of the bundle, and excluded from `_bundle_files`.
_TALLY_FILE = ".tally.json"
_TALLY_LOCK = ".tally.lock"

# D-27 ZIP handling. _IMAGE_EXTS is deliberately a LOCAL MIRRORED CONSTANT of the
# pipeline's whitelist (pipeline/ingest.py `_IMAGE_EXTS`) — the API never imports
# `pipeline` (D-15 / cross-package rule), so the set is duplicated by policy and
# kept in lockstep by hand. It only routes ZIP *entries* (image -> images/, other
# -> ignored); the pipeline still owns the authoritative scan at ingest.
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
_ZIP_EXT = ".zip"
_EXTRACT_TMP = ".extract-tmp"  # session-local staging dir; removed on ANY outcome
_ARCHIVE_TMP_NAME = ".archive.zip"  # streamed compressed bytes, inside .extract-tmp
# UploadStatus.ignored is capped: at most this many entry names, then one
# "+N more" sentinel string (D-27) — a hostile archive cannot bloat the response.
_IGNORED_REPORT_CAP = 100

# Per-part upload ceiling so an authenticated client cannot exhaust server memory
# or disk with one giant part. The part is streamed in fixed chunks (never fully
# buffered) and the limit is enforced as bytes arrive; override via
# MAX_UPLOAD_PART_BYTES. Read per request (env is process-stable config; no
# module-level mutable state — rule #8).
_DEFAULT_MAX_PART_BYTES = 100 * 1024 * 1024  # 100 MiB
_PART_CHUNK_BYTES = 1024 * 1024  # 1 MiB streaming chunk

# Whole-bundle resource caps (D-27): cumulative UNCOMPRESSED bytes and total file
# count across the bundle — plain parts and extracted ZIP entries alike. Enforced
# as bytes arrive (zip headers are never trusted); override via
# MAX_UPLOAD_BUNDLE_BYTES / MAX_UPLOAD_ENTRIES.
_DEFAULT_MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB uncompressed
_DEFAULT_MAX_ENTRIES = 250_000

# Seam O2: per-file content manifest {basename: {"size", "sha256"}}, persisted
# alongside the tally so a resumed client can ask exactly what the server holds.
# `.files.lock` serialises the read-modify-write (an fcntl flock, like the tally —
# an in-process asyncio lock would not serialise across Uvicorn workers). Both are
# session-local, never bundle content, and excluded from `_bundle_files`.
_FILES_FILE = ".files.json"
_FILES_LOCK = ".files.lock"

# Seam O2 stale-session sweep: an un-finalized session whose LATEST activity mtime
# is older than this is reaped best-effort (finalized bundles are ingest sources —
# NEVER swept). Override via MAX_UPLOAD_SESSION_AGE_SECONDS.
_DEFAULT_MAX_SESSION_AGE_SECONDS = 7 * 24 * 60 * 60  # 7 days

# GET /{id}/files pagination: default page size and hard cap. A bundle reaches
# MAX_UPLOAD_ENTRIES (250k) files, so the manifest is always served paged; `limit`
# is clamped to this cap (never a 250k-row response).
_DEFAULT_FILES_LIMIT = 1000
_MAX_FILES_LIMIT = 10_000

# POST /{id}/check request-list ceiling: a client batches a large diff into
# requests of at most this many files (413 past it; batching is documented in the
# interface catalogue).
_MAX_CHECK_FILES = 10_000

# POST /{id}/check body ceiling (bytes): the request body is buffered under this cap
# and rejected (413) BEFORE it is parsed, so an oversized `files` array can never
# force an unbounded buffer/JSON-parse ahead of the _MAX_CHECK_FILES count cap.
# Sized to hold a full _MAX_CHECK_FILES batch of {name,size,sha256} rows with
# generous headroom for long names; override via MAX_UPLOAD_CHECK_BODY_BYTES.
_DEFAULT_MAX_CHECK_BODY_BYTES = 40 * 1024 * 1024  # 40 MiB


class UploadHandle(BaseModel):
    upload_id: str  # referenced by CreateDatasetRequest/IngestRequest once finalized


class UploadStatus(BaseModel):
    upload_id: str
    state: str  # "open" | "finalized"
    received_parts: int
    # Bytes WRITTEN INTO THE BUNDLE — i.e. uncompressed for ZIP parts (D-27);
    # the transient compressed archive is never counted.
    bytes_received: int
    # D-27: ZIP entries skipped by THIS request (nested CSVs, non-image files),
    # capped at 100 names then one "+N more" sentinel. Per-response report — not
    # persisted, so plain parts and GET status return [].
    ignored: list[str] = Field(default_factory=list)
    # Seam O2: True only when a re-sent plain part was found byte-identical to the
    # stored file (idempotent blind retry) — the store is a no-op and the client
    # can treat the part as delivered. Always False for a first store / GET status.
    already_present: bool = False


class UploadSessionSummary(BaseModel):
    """One owner-scoped upload session in the `GET /api/uploads` list (Seam O2).
    Tally-backed — no per-file rescan on the steady path. `created`/`last_activity`
    are mtime-derived (the filesystem keeps no exact creation instant): `created`
    is the earliest, `last_activity` the latest mtime across the session's
    structural files (session dir, images/, tally/manifest/finalized). Every part
    advances `last_activity` — the signal the stale-session sweep uses."""

    upload_id: str
    state: str  # "open" | "finalized"
    received_parts: int
    bytes_received: int
    created: float  # epoch seconds (mtime-derived; approximate)
    last_activity: float  # epoch seconds (freshest mtime; advances on every part)


class UploadFileInfo(BaseModel):
    """One stored file in the per-file manifest (Seam O2). `sha256` is the
    server-computed content hash (streamed during store/extract); `is_metadata`
    flags the single optional metadata source (stored canonically as
    metadata.csv|.tsv) apart from an image."""

    name: str
    size: int
    sha256: str
    is_metadata: bool = False


class UploadFilesPage(BaseModel):
    """A page of the per-file manifest (Seam O2). Paginated (name-sorted) because a
    bundle reaches MAX_UPLOAD_ENTRIES (250k) files; `total` is the full manifest
    size, `limit`/`offset` echo the effective (clamped) window."""

    upload_id: str
    total: int
    limit: int
    offset: int
    files: list[UploadFileInfo]


class CheckFile(BaseModel):
    """One file in a `POST /api/uploads/{id}/check` request (Seam O2). `sha256` is
    optional — the client hashes only in its opt-in integrity tier (Seam O4);
    name+size is the default diff."""

    name: str
    size: int
    sha256: str | None = None


class CheckRequest(BaseModel):
    files: list[CheckFile]


class CheckResponse(BaseModel):
    """Immich-style pre-check result (Seam O2): `present` = files the server already
    holds (name+size match, and hash match when BOTH sides carry one), `mismatched`
    = name exists but size (or provided hash) differs, `needed` = not present. The
    client sends only the `needed` (and renames `mismatched`), so duplicate bytes
    never cross the wire."""

    present: list[str]
    needed: list[str]
    mismatched: list[str]


def _upload_dir(owner: str, upload_id: str) -> Path:
    """Resolve the jailed upload-session dir DATA_ROOT/users/{owner}/uploads/{upload_id}.

    Anchored under db.users_root() (decision D-30 — disjoint from the dataset tree),
    so a `ds_id` equal to `owner` can never share this directory level. `owner` is
    identity-derived (from get_current_user — never the request body) and
    constrained to the username charset; `upload_id` is pattern-checked here and
    db.resolve_under then refuses anything that escapes the users root (the
    filesystem backstop, recomputed at the new anchor — never weakened). 400 on a
    malformed id so nothing touches the filesystem.
    """
    if not _UPLOAD_ID_RE.match(upload_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid upload_id"
        )
    return db.resolve_under(db.users_root(), owner, "uploads", upload_id)


def _safe_part_name(filename: str | None) -> str:
    """Reduce a client-supplied multipart filename to a jailed basename. Normalises
    Windows separators, strips any directory components, and rejects empty/`.`/`..`
    — so a crafted name like `../../evil` can never escape the images dir (the
    db.resolve_under join is a second backstop)."""
    if not filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload part requires a filename",
        )
    base = os.path.basename(filename.replace("\\", "/"))
    if base in ("", ".", ".."):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid part filename"
        )
    return base


def _env_int(name: str, default: int) -> int:
    """A positive-int env knob: a missing, non-integer, or non-positive value
    falls back to `default` rather than 500-ing an upload on malformed config."""
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _max_part_bytes() -> int:
    """Per-part byte ceiling from MAX_UPLOAD_PART_BYTES (default 100 MiB). For a
    ZIP part this caps the COMPRESSED archive bytes."""
    return _env_int("MAX_UPLOAD_PART_BYTES", _DEFAULT_MAX_PART_BYTES)


def _max_bundle_bytes() -> int:
    """Whole-bundle UNCOMPRESSED byte ceiling from MAX_UPLOAD_BUNDLE_BYTES
    (default 2 GiB) — D-27."""
    return _env_int("MAX_UPLOAD_BUNDLE_BYTES", _DEFAULT_MAX_BUNDLE_BYTES)


def _max_entries() -> int:
    """Whole-bundle file-count ceiling from MAX_UPLOAD_ENTRIES (default 250 000)
    — D-27."""
    return _env_int("MAX_UPLOAD_ENTRIES", _DEFAULT_MAX_ENTRIES)


def _max_check_body_bytes() -> int:
    """POST /check request-body byte ceiling from MAX_UPLOAD_CHECK_BODY_BYTES
    (default 40 MiB) — the memory guard enforced before the body is parsed."""
    return _env_int("MAX_UPLOAD_CHECK_BODY_BYTES", _DEFAULT_MAX_CHECK_BODY_BYTES)


def _bundle_files(upload_dir: Path) -> list[Path]:
    """Every file currently IN the bundle (images/* plus the optional metadata
    file). The RECOUNT primitive behind the tally (`_recount_tally`) and the D-27
    bundle-cap fallback; transient staging (`.extract-tmp/`) and the tally files
    are never included."""
    images = upload_dir / _IMAGES_SUBDIR
    files = [p for p in images.iterdir() if p.is_file()] if images.is_dir() else []
    files += [
        upload_dir / f"metadata{ext}"
        for ext in _CSV_EXTS
        if (upload_dir / f"metadata{ext}").is_file()
    ]
    return files


def _has_image_file(images_dir: Path) -> bool:
    """True if `images/` holds at least one file — the finalize gate (the pipeline's
    deeper decodable-image check runs at ingest). Synchronous `iterdir`; call via
    `run_in_threadpool` (finalize does)."""
    return any(p.is_file() for p in images_dir.iterdir())


# ---------------------------------------------------------------------------
# T2-53: incremental per-upload count/bytes tally (persisted, crash-safe).
# ---------------------------------------------------------------------------


def _recount_tally(upload_dir: Path) -> tuple[int, int]:
    """The GROUND-TRUTH bundle tally from a full scan (`_bundle_files` + per-file
    `stat`): (file count, total uncompressed bytes). The authoritative fallback for
    every "on any doubt" path (missing/corrupt/crash-stale `.tally.json`) and for
    finalize reconciliation. SYNCHRONOUS file I/O — always call via
    `run_in_threadpool` (it is the very O(bundle) scan the tally exists to avoid, so
    it runs only on a cache miss / at finalize, never per part on the steady path)."""
    files = _bundle_files(upload_dir)
    return len(files), sum(p.stat().st_size for p in files)


def _read_tally(upload_dir: Path) -> tuple[int, int] | None:
    """Parse `.tally.json` → (count, bytes), or None on ANY doubt — file absent,
    unreadable, malformed JSON, wrong shape, or a negative value. A None return is
    the caller's signal to recount (never to under-count). Writes are atomic-replace
    (`_write_tally`), so a reader never observes a half-written file: it sees either
    the complete old tally or the complete new one."""
    try:
        raw = (upload_dir / _TALLY_FILE).read_text(encoding="utf-8")
        data = json.loads(raw)
        count = int(data["count"])
        nbytes = int(data["bytes"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if count < 0 or nbytes < 0:
        return None
    return count, nbytes


def _write_tally(upload_dir: Path, count: int, nbytes: int) -> None:
    """Atomically persist the tally: write a temp file in the SAME dir, then
    `os.replace` it over `.tally.json` (an atomic rename on one filesystem). A crash
    mid-write therefore leaves the previous complete tally intact — never a
    half-written file that `_read_tally` would have to salvage."""
    fd, tmp_name = tempfile.mkstemp(dir=str(upload_dir), prefix=_TALLY_FILE, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"count": count, "bytes": nbytes}, fh)
        os.replace(tmp_name, upload_dir / _TALLY_FILE)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _load_or_recount_tally(upload_dir: Path) -> tuple[int, int]:
    """Read the tally, or RECOUNT-and-repair on any doubt (constraint (b)): a
    missing/corrupt/crash-stale tally is rebuilt from the filesystem and written
    back, so the returned figure never under-counts what is on disk. Used for the
    per-part cap PRE-CHECKS and for status. SYNCHRONOUS — call via
    `run_in_threadpool` (the recount branch scans the bundle)."""
    tally = _read_tally(upload_dir)
    if tally is not None:
        return tally
    count, nbytes = _recount_tally(upload_dir)
    _write_tally(upload_dir, count, nbytes)
    return count, nbytes


def _apply_tally_delta(
    upload_dir: Path, d_count: int, d_bytes: int
) -> tuple[int, int]:
    """Add (d_count, d_bytes) to the persisted tally under an exclusive per-upload
    file lock, so concurrent parts to the same bundle never lose an update (the
    read-modify-write is serialised even across Uvicorn worker processes — an
    in-process asyncio lock could not do that). Called AFTER a part is committed to
    the bundle. On any doubt the base is a fresh recount (never an under-count).
    Returns the NEW (count, bytes) so the caller's status reflects this commit.
    SYNCHRONOUS (fcntl + file I/O) — call via `run_in_threadpool`.

    Crash safety: the delta is applied after the files are already in the bundle, so
    a crash between commit and this update leaves the tally low — repaired by the
    finalize reconciliation recount (constraint (c)), which is the gate before the
    caps matter (ingest)."""
    lock_path = upload_dir / _TALLY_LOCK
    with open(lock_path, "w") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX)
        try:
            count, nbytes = _load_or_recount_tally(upload_dir)
            new_count, new_bytes = count + d_count, nbytes + d_bytes
            _write_tally(upload_dir, new_count, new_bytes)
            return new_count, new_bytes
        finally:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# Seam O2: per-file content manifest (.files.json) — {basename: {size, sha256}}.
# Mirrors the T2-53 tally's crash-safety discipline exactly: atomic-replace writes
# (a reader never tears), an exclusive per-upload flock serialises the
# read-modify-write across Uvicorn workers, and on ANY doubt (missing/corrupt) the
# manifest is rebuilt from a full re-hash of the bundle rather than trusted to lie.
# ---------------------------------------------------------------------------


def _hash_file(path: Path) -> tuple[int, str]:
    """`(size, sha256-hex)` of one file, streamed in <=1 MiB chunks (never fully
    buffered). The rebuild + stored-file-compare primitive — SYNCHRONOUS file I/O,
    always call via `run_in_threadpool`."""
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as fh:
        while chunk := fh.read(_PART_CHUNK_BYTES):
            size += len(chunk)
            hasher.update(chunk)
    return size, hasher.hexdigest()


def _rebuild_manifest(upload_dir: Path) -> dict[str, dict[str, Any]]:
    """The GROUND-TRUTH manifest from a full re-hash of every bundle file
    (`_bundle_files`, keyed by basename). The authoritative fallback for every "on
    any doubt" path (missing/corrupt/crash-stale `.files.json`). SYNCHRONOUS (opens
    + hashes each file) — always via `run_in_threadpool`; it runs only on a cache
    miss, never per part on the steady path."""
    manifest: dict[str, dict[str, Any]] = {}
    for path in _bundle_files(upload_dir):
        size, sha = _hash_file(path)
        manifest[path.name] = {"size": size, "sha256": sha}
    return manifest


def _read_manifest(upload_dir: Path) -> dict[str, dict[str, Any]] | None:
    """Parse `.files.json` -> {name: {size, sha256}}, or None on ANY doubt — file
    absent, unreadable, malformed JSON, wrong shape, or a negative size. A None
    return is the caller's signal to rebuild (never to serve a torn/partial view).
    Writes are atomic-replace (`_write_manifest`), so a reader sees either the whole
    old manifest or the whole new one."""
    try:
        raw = (upload_dir / _FILES_FILE).read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    out: dict[str, dict[str, Any]] = {}
    for name, entry in data.items():
        if not isinstance(name, str) or not isinstance(entry, dict):
            return None
        try:
            size = int(entry["size"])
            sha = str(entry["sha256"])
        except (KeyError, ValueError, TypeError):
            return None
        if size < 0:
            return None
        out[name] = {"size": size, "sha256": sha}
    return out


def _write_manifest(upload_dir: Path, manifest: dict[str, dict[str, Any]]) -> None:
    """Atomically persist the manifest: temp file in the SAME dir, then `os.replace`
    over `.files.json` (an atomic rename on one filesystem). A crash mid-write
    leaves the previous complete manifest intact — never a half-written file
    `_read_manifest` would have to reject."""
    fd, tmp_name = tempfile.mkstemp(
        dir=str(upload_dir), prefix=_FILES_FILE, suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh)
        os.replace(tmp_name, upload_dir / _FILES_FILE)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _read_or_rebuild_manifest_locked(
    upload_dir: Path,
) -> dict[str, dict[str, Any]]:
    """Read `.files.json`, or a fresh full-rehash rebuild on any doubt
    (missing/corrupt), returned IN MEMORY — the caller persists it. The caller MUST
    already hold `.files.lock`: this is the read-modify base for
    `_apply_manifest_entries` and the doubt-path body of `_load_or_rebuild_manifest`,
    so the eventual write-back is serialised against every concurrent append and can
    never clobber one. SYNCHRONOUS — call via `run_in_threadpool` (the rebuild branch
    hashes the bundle; the steady path is a cheap read)."""
    manifest = _read_manifest(upload_dir)
    return manifest if manifest is not None else _rebuild_manifest(upload_dir)


def _load_or_rebuild_manifest(upload_dir: Path) -> dict[str, dict[str, Any]]:
    """Read the manifest, or REBUILD-and-repair on any doubt: a missing/corrupt
    `.files.json` is re-hashed from the filesystem and written back, so the returned
    map always reflects what is on disk. Used by the files/check/re-send read paths.

    The steady read is LOCK-FREE (atomic-replace writes mean a reader never tears),
    but the rebuild-on-doubt repair is persisted UNDER `.files.lock` — the same lock
    the append side takes. An unlocked write-back could otherwise clobber a concurrent
    locked append (the reader's stale rebuild lands last), and — unlike the T2-53
    tally, which finalize reconciles — the manifest has no later reconciliation to
    repair the lost entry. Locking only on the doubt path keeps the common read
    lock-free; `_read_or_rebuild_manifest_locked` re-reads inside the lock, a
    double-check that serves a concurrent writer's fresh manifest rather than
    overwriting it. SYNCHRONOUS — call via `run_in_threadpool` (the rebuild branch
    hashes the bundle)."""
    manifest = _read_manifest(upload_dir)
    if manifest is not None:
        return manifest
    lock_path = upload_dir / _FILES_LOCK
    with open(lock_path, "w") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX)
        try:
            manifest = _read_or_rebuild_manifest_locked(upload_dir)
            _write_manifest(upload_dir, manifest)
            return manifest
        finally:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)


def _apply_manifest_entries(
    upload_dir: Path, entries: list[tuple[str, int, str]]
) -> None:
    """Merge `(basename, size, sha256)` rows into `.files.json` under an exclusive
    per-upload file lock, so concurrent parts to the same bundle never lose a
    manifest update (the read-modify-write is serialised even across Uvicorn worker
    processes — an in-process asyncio lock could not do that, exactly as for the
    tally). Called AFTER the part is committed to the bundle. On any doubt the base
    is a fresh rebuild (never a partial map). SYNCHRONOUS (fcntl + file I/O) — call
    via `run_in_threadpool`.

    Crash safety: like the tally, the manifest is best-effort resume metadata that
    self-heals — a crash between commit and this update leaves an entry missing,
    repaired by the rebuild-on-doubt at the next files/check read. It never blocks
    the part (the bytes are already committed and the tally already counts them)."""
    if not entries:
        return
    lock_path = upload_dir / _FILES_LOCK
    with open(lock_path, "w") as lock_fh:
        fcntl.flock(lock_fh, fcntl.LOCK_EX)
        try:
            manifest = _read_or_rebuild_manifest_locked(upload_dir)
            for name, size, sha in entries:
                manifest[name] = {"size": size, "sha256": sha}
            _write_manifest(upload_dir, manifest)
        finally:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)


def _is_metadata_name(name: str) -> bool:
    """True if `name` is the bundle's canonical metadata file (metadata.csv|.tsv) —
    the flag the files route exposes to distinguish it from an image."""
    return name in {f"metadata{ext}" for ext in _CSV_EXTS}


async def _store_part(
    part: UploadFile, target: Path, *, bundle_remaining: int | None = None
) -> tuple[int, str]:
    """Stream an upload part to `target` in bounded memory, enforcing the per-part
    size cap — and, when `bundle_remaining` is given, the whole-bundle byte cap
    (D-27) — as bytes arrive; reading the whole part into RAM (`part.read()`) would
    let an authenticated client exhaust memory. On overflow, or any failure
    mid-write, the partial file is removed so a rejected part leaves nothing behind.
    Returns `(bytes written, sha256-hex of the stored bytes)` — the tally delta
    (T2-53) and the manifest hash (Seam O2), both computed in this one streaming
    pass (the hash is free: the bytes already flow through here)."""
    limit = _max_part_bytes()
    written = 0
    hasher = hashlib.sha256()
    try:
        with target.open("wb") as fh:
            while chunk := await part.read(_PART_CHUNK_BYTES):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=f"Upload part exceeds the {limit}-byte per-part limit",
                    )
                if bundle_remaining is not None and written > bundle_remaining:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=(
                            f"Upload bundle exceeds the {_max_bundle_bytes()}-byte "
                            "bundle limit"
                        ),
                    )
                hasher.update(chunk)
                fh.write(chunk)
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    return written, hasher.hexdigest()


async def _drain_and_hash(part: UploadFile) -> tuple[int, str]:
    """Stream an incoming part to NOWHERE (no disk write), computing `(size,
    sha256-hex)` under the per-part cap — the idempotent-re-send probe (Seam O2). A
    blind retry of an existing file is hashed and compared to the stored file
    WITHOUT overwriting it, so a genuine content mismatch leaves the existing file
    intact (the existing file wins; a different file needs a new name)."""
    limit = _max_part_bytes()
    size = 0
    hasher = hashlib.sha256()
    while chunk := await part.read(_PART_CHUNK_BYTES):
        size += len(chunk)
        if size > limit:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=f"Upload part exceeds the {limit}-byte per-part limit",
            )
        hasher.update(chunk)
    return size, hasher.hexdigest()


def _status_from_tally(
    upload_dir: Path,
    upload_id: str,
    count: int,
    nbytes: int,
    ignored: list[str] | None = None,
    already_present: bool = False,
) -> UploadStatus:
    """Build the status from the ALREADY-RESOLVED tally figures (T2-53): each counted
    file is one received part; `bytes_received` is the total uncompressed bytes — for
    ZIP parts that is the bytes merged into the bundle (D-27); `state` is "finalized"
    iff the marker exists, else "open". `ignored` is the current request's D-27 skip
    report (already capped), never read from disk; `already_present` flags a Seam O2
    idempotent re-send. The `(count, nbytes)` come from the tally
    (`_load_or_recount_tally`), so this no longer stats every file per request — the
    O(bundle) scan the tally exists to avoid."""
    state = "finalized" if (upload_dir / _FINALIZED_MARKER).exists() else "open"
    return UploadStatus(
        upload_id=upload_id,
        state=state,
        received_parts=count,
        bytes_received=nbytes,
        ignored=ignored if ignored is not None else [],
        already_present=already_present,
    )


# ---------------------------------------------------------------------------
# D-27 ZIP extraction: plan (names only) -> extract (streamed, capped) -> merge.
# ---------------------------------------------------------------------------


def _zip_basename(entry_name: str) -> str:
    """Reduce a ZIP entry name to its basename for flat placement (D-27).
    Normalises backslash separators first (some Windows archivers emit them, and
    `PurePosixPath` would otherwise treat `a\\evil.png` as one component) — the
    same normalisation `_safe_part_name` applies to multipart filenames. Basename-
    only placement makes zip-slip impossible by construction; `db.resolve_under`
    still backstops every staged write."""
    return PurePosixPath(entry_name.replace("\\", "/")).name


def _plan_zip(
    zf: zipfile.ZipFile, upload_dir: Path, entry_budget: int
) -> tuple[
    list[tuple[zipfile.ZipInfo, str]],  # image entries -> flat basename
    tuple[zipfile.ZipInfo, str] | None,  # the single root-level CSV/TSV -> its ext
    list[str],  # ignored entry names, CAPPED at _IGNORED_REPORT_CAP (see total)
    int,  # TRUE ignored count (>= len(ignored)); caller renders the '+N more' tail
]:
    """Classify every archive entry by NAME ONLY (no entry bytes are read), and
    reject whole-archive rule violations up front: duplicate flattened basenames
    (in-archive or vs the already-uploaded bundle) and a second metadata source
    are 400; an accepted-entry count beyond the bundle's remaining entry budget
    is 413. Byte caps are NOT checked here — sizes in the central directory can
    lie, so bytes are counted during extraction (`_extract_entry`)."""
    images: list[tuple[zipfile.ZipInfo, str]] = []
    metadata: tuple[zipfile.ZipInfo, str] | None = None
    ignored: list[str] = []
    ignored_total = 0
    seen_basenames: set[str] = set()
    images_dir = upload_dir / _IMAGES_SUBDIR
    bundle_has_metadata = any(
        (upload_dir / f"metadata{ext}").is_file() for ext in _CSV_EXTS
    )

    def _ignore(name: str) -> None:
        # Cap the RETAINED names in memory (PR24-4), not just in the response: a
        # hostile archive of millions of skipped entries must not balloon RAM. The
        # true count keeps flowing so the response's '+N more' tail stays accurate.
        nonlocal ignored_total
        ignored_total += 1
        if len(ignored) < _IGNORED_REPORT_CAP:
            ignored.append(name)

    for info in zf.infolist():
        if info.is_dir():
            continue
        if info.flag_bits & 0x1:  # standard ZIP encryption flag
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Encrypted ZIP archives are not supported",
            )
        base = _zip_basename(info.filename)
        if base in ("", ".", ".."):
            # No placeable name (e.g. an entry literally called ".."): not an
            # image, not metadata — falls under "everything else" (D-27).
            _ignore(info.filename)
            continue
        ext = PurePosixPath(base).suffix.lower()
        if ext in _IMAGE_EXTS:
            if base in seen_basenames or (images_dir / base).exists():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Duplicate image basename {base!r} (archive entries are "
                        "flattened into images/ by basename)"
                    ),
                )
            seen_basenames.add(base)
            images.append((info, base))
        elif ext in _CSV_EXTS and _is_root_level(info.filename):
            if metadata is not None or bundle_has_metadata:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "A metadata file was already provided for this bundle "
                        "(one root-level CSV/TSV per bundle)"
                    ),
                )
            metadata = (info, ext)
        else:
            # Nested CSV/TSVs land here too — only a ROOT-level one is metadata.
            _ignore(info.filename)
        accepted = len(images) + (1 if metadata is not None else 0)
        if accepted > entry_budget:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=(
                    f"Upload bundle exceeds the {_max_entries()}-file entry limit"
                ),
            )
    return images, metadata, ignored, ignored_total


def _is_root_level(entry_name: str) -> bool:
    """True when the archive path has no directory component (after separator
    normalisation) — the D-27 condition for a CSV/TSV to count as metadata."""
    return "/" not in entry_name.replace("\\", "/").strip("/")


def _extract_entry(
    zf: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    target: Path,
    written_so_far: int,
    byte_budget: int,
) -> tuple[int, str]:
    """Stream one accepted entry to its staged target in ≤1 MiB chunks, counting
    cumulative UNCOMPRESSED bytes against the bundle's remaining byte budget as
    they arrive — `ZipInfo.file_size` is never trusted (D-27) — and hashing the
    entry's bytes in the same pass (Seam O2, free). Returns `(new cumulative total,
    sha256-hex of THIS entry)`; raises 413 on breach (caller removes the staging
    dir)."""
    hasher = hashlib.sha256()
    with zf.open(info) as src, target.open("wb") as dst:
        while chunk := src.read(_PART_CHUNK_BYTES):
            written_so_far += len(chunk)
            if written_so_far > byte_budget:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=(
                        f"Upload bundle exceeds the {_max_bundle_bytes()}-byte "
                        "bundle limit (uncompressed)"
                    ),
                )
            hasher.update(chunk)
            dst.write(chunk)
    return written_so_far, hasher.hexdigest()


def _extract_and_merge_zip(
    archive_path: Path,
    upload_dir: Path,
    tmp_dir: Path,
    existing_count: int,
    existing_bytes: int,
) -> tuple[list[str], int, int, list[tuple[str, int, str]]]:
    """Steps 2–4 of the D-27 ZIP branch: plan from names, extract accepted entries
    with streamed caps, then merge into the bundle with per-file renames ONLY after
    the whole archive validated. SYNCHRONOUS by design — decompressing a bundle
    (up to ~2 GiB uncompressed) is blocking CPU + file I/O, so the caller MUST run
    this via `run_in_threadpool`; inline in the async route it froze the whole API
    (every concurrent request, including pyramid range-reads) for the duration of
    one user's extraction. Thread-safety: touches only session-local paths (staging
    under `tmp_dir`, merge targets under this session's `upload_dir`) via per-call
    file handles — no shared mutable state crosses threads.

    `existing_count`/`existing_bytes` are the CURRENT tally (T2-53), so the budgets
    no longer rescan the bundle. Returns `(ignored_report, added_count, added_bytes,
    manifest_entries)` where `manifest_entries` is the per-file `(basename, size,
    sha256)` rows the caller folds into `.files.json` (Seam O2) after the tally."""
    # 2/3. Plan from names, then extract accepted entries with streamed caps. The
    # budgets come from the tally, not a fresh `_bundle_files` scan (T2-53).
    entry_budget = _max_entries() - existing_count
    byte_budget = _max_bundle_bytes() - existing_bytes
    staged_metadata: Path | None = None
    entries: list[tuple[str, int, str]] = []  # (basename, size, sha256) — Seam O2
    try:
        with zipfile.ZipFile(archive_path) as zf:
            images, metadata, ignored, ignored_total = _plan_zip(
                zf, upload_dir, entry_budget
            )
            extracted = 0
            for info, base in images:
                # resolve_under: filesystem backstop on top of basename-only
                # placement (zip-slip-proof by construction).
                target = db.resolve_under(tmp_dir, _IMAGES_SUBDIR, base)
                before = extracted
                extracted, sha = _extract_entry(
                    zf, info, target, extracted, byte_budget
                )
                entries.append((base, extracted - before, sha))
            if metadata is not None:
                info, ext = metadata
                staged_metadata = tmp_dir / f"metadata{ext}"
                before = extracted
                extracted, sha = _extract_entry(
                    zf, info, staged_metadata, extracted, byte_budget
                )
                entries.append((f"metadata{ext}", extracted - before, sha))
    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Corrupt ZIP archive: {exc}",
        ) from exc
    except zlib.error as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Corrupt ZIP archive (bad compressed data): {exc}",
        ) from exc
    except NotImplementedError as exc:
        # zf.open raises this for a compression method the stdlib can't decode
        # (e.g. WinZip AES, method 99). A client-supplied archive must not 500
        # the server (PR24-3) — report it as an unsupported bad request.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported ZIP compression: {exc}",
        ) from exc

    # 4. Merge — the whole archive validated; per-file renames within the
    #    session dir (same filesystem), "atomically-enough" per the brief.
    for staged in (tmp_dir / _IMAGES_SUBDIR).iterdir():
        os.replace(staged, upload_dir / _IMAGES_SUBDIR / staged.name)
    if staged_metadata is not None:
        os.replace(staged_metadata, upload_dir / staged_metadata.name)
    added_count = len(images) + (1 if metadata is not None else 0)
    return _format_ignored(ignored, ignored_total), added_count, extracted, entries


async def _ingest_zip_part(
    part: UploadFile, upload_dir: Path, upload_id: str
) -> UploadStatus:
    """The D-27 ZIP branch of upload_part. Stages into `.extract-tmp/` (stream
    archive -> plan -> extract with streaming caps), then merges into the bundle
    with per-file renames ONLY after the whole archive validated. Any failure
    (4xx, 413, I/O) removes `.extract-tmp/` in the finally — the session is left
    exactly as before the part. Returns the resulting `UploadStatus` (with the
    capped `ignored` report).

    The blocking work runs OFF the event loop: the tally read (T2-53), extraction+
    merge in `_extract_and_merge_zip`, the tally update, and the staging rmtree (a
    failed extract can leave GiBs / thousands of files to remove) all go through
    `run_in_threadpool`; only the archive streaming (`_store_part`, chunked awaits)
    stays inline. If a client disconnect cancels the request between threadpool hops
    the finally's cleanup can be skipped — that is exactly the stale-staging case the
    guard at the top already self-heals, and staging is transactional (never part of
    the bundle), so correctness is unaffected. The tally is updated only AFTER the
    merge commits, so a cancel/failure before then leaves it untouched."""
    tmp_dir = upload_dir / _EXTRACT_TMP
    if tmp_dir.exists():
        # Stale staging from a crashed request: staging is transactional, never
        # part of the bundle, so clearing it is always safe.
        await run_in_threadpool(shutil.rmtree, tmp_dir)
    staged_images = tmp_dir / _IMAGES_SUBDIR
    staged_images.mkdir(parents=True)
    try:
        # Current tally drives the D-27 budgets (no per-part bundle rescan, T2-53).
        existing_count, existing_bytes = await run_in_threadpool(
            _load_or_recount_tally, upload_dir
        )
        # 1. Stream the COMPRESSED archive to staging; the existing per-part cap
        #    applies to these bytes (bundle caps apply to what gets extracted).
        archive_path = tmp_dir / _ARCHIVE_TMP_NAME
        await _store_part(part, archive_path)

        # 2–4. Plan/extract/merge — blocking, so off the event loop.
        ignored, added_count, added_bytes, entries = await run_in_threadpool(
            _extract_and_merge_zip,
            archive_path,
            upload_dir,
            tmp_dir,
            existing_count,
            existing_bytes,
        )
        # Commit succeeded → fold the delta into the persisted tally (T2-53), then
        # the per-file hashes into the manifest (Seam O2). Both under their own
        # per-upload locks; the manifest is best-effort (rebuilds on any doubt).
        count, nbytes = await run_in_threadpool(
            _apply_tally_delta, upload_dir, added_count, added_bytes
        )
        await run_in_threadpool(_apply_manifest_entries, upload_dir, entries)
        return _status_from_tally(upload_dir, upload_id, count, nbytes, ignored=ignored)
    finally:
        await run_in_threadpool(shutil.rmtree, tmp_dir, ignore_errors=True)


def _format_ignored(names: list[str], total: int) -> list[str]:
    """Render the D-27 skip report: the (already-capped, PR24-4) `names` followed
    by one '+N more' sentinel when `total` ran past _IGNORED_REPORT_CAP — so a
    hostile archive cannot bloat the response and the count stays truthful."""
    if total <= _IGNORED_REPORT_CAP:
        return names
    return names + [f"+{total - _IGNORED_REPORT_CAP} more"]


# ---------------------------------------------------------------------------
# Seam O2: idempotent re-send, the stale-session sweep, and the list/files views.
# ---------------------------------------------------------------------------


async def _resend_or_conflict(
    part: UploadFile, upload_dir: Path, upload_id: str, target: Path
) -> UploadStatus:
    """Decide a duplicate-name plain part (Seam O2 idempotent re-send). Drain the
    incoming body to compute its `(size, sha256)` WITHOUT overwriting the stored
    file, then compare to the stored file (its manifest entry, or a direct re-hash
    if the manifest lost it): byte-identical -> 200 with `already_present=True` (a
    safe blind retry — the store is a no-op, tally + manifest untouched); genuinely
    different -> 409 pointing at /check (the existing file wins; a different file
    needs a new name). This is what makes a blind retry safe."""
    name = target.name
    manifest = await run_in_threadpool(_load_or_rebuild_manifest, upload_dir)
    stored = manifest.get(name)
    if stored is not None:
        stored_size, stored_sha = int(stored["size"]), str(stored["sha256"])
    else:
        # The manifest lost this file (a crash between commit and the manifest
        # update) — re-hash the stored file directly so a legit re-send is never a
        # false 409.
        stored_size, stored_sha = await run_in_threadpool(_hash_file, target)
    incoming_size, incoming_sha = await _drain_and_hash(part)
    if incoming_size == stored_size and incoming_sha == stored_sha:
        count, nbytes = await run_in_threadpool(_load_or_recount_tally, upload_dir)
        return _status_from_tally(
            upload_dir, upload_id, count, nbytes, already_present=True
        )
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"Part {name!r} already exists with different content; pre-check with "
            f"POST /api/uploads/{upload_id}/check, or rename it"
        ),
    )


def _max_session_age_seconds() -> int:
    """Stale-session TTL from MAX_UPLOAD_SESSION_AGE_SECONDS (default 7 days)."""
    return _env_int("MAX_UPLOAD_SESSION_AGE_SECONDS", _DEFAULT_MAX_SESSION_AGE_SECONDS)


def _session_mtimes(upload_dir: Path) -> list[float]:
    """The mtimes of a session's structural files — the session dir, images/, and
    the tally/manifest/finalized sidecars — skipping any that cannot be stat-ed. The
    tally and manifest are rewritten (atomic replace) on EVERY part, so their mtime
    is the session's true last-activity clock; images/ advances as image parts land.
    Empty ONLY if nothing can be stat-ed (total doubt) — the sweep keeps the session
    in that case."""
    mtimes: list[float] = []
    for p in (
        upload_dir,
        upload_dir / _IMAGES_SUBDIR,
        upload_dir / _TALLY_FILE,
        upload_dir / _FILES_FILE,
        upload_dir / _FINALIZED_MARKER,
    ):
        try:
            mtimes.append(p.stat().st_mtime)
        except OSError:
            continue
    return mtimes


def _sweep_stale_sessions(uploads_root: Path, ttl_seconds: int) -> list[Path]:
    """Reap un-finalized upload sessions idle past ``ttl_seconds`` — best-effort and
    conservative, mirroring the O1 staging sweep's shape:

      * a FINALIZED bundle is NEVER swept — it is an ingest source
        (`_latest_finalized_bundle` depends on it; T2-103 revisits retained corpora);
      * the TTL is a FRESHNESS FLOOR — anything whose latest structural mtime is
        within the window is kept (every part advances that mtime);
      * on ANY doubt the session is KEPT — an unreadable finalize marker or a session
        with no readable mtime is never reaped.

    NEVER raises — cleanup must not fail the request it rides (create_upload /
    GET /api/uploads). Returns the swept dirs (never a blanket delete)."""
    try:
        sessions = [p for p in uploads_root.iterdir() if p.is_dir()]
    except OSError:
        return []  # no uploads root yet (or unreadable) — nothing to sweep
    now = time.time()
    swept: list[Path] = []
    for session in sessions:
        # Keep-signal 1: a finalized bundle is an ingest source — never reaped
        # (on doubt reading the marker, keep).
        try:
            if (session / _FINALIZED_MARKER).exists():
                continue
        except OSError:
            continue
        # Keep-signal 2: the freshness floor. No readable mtime (total doubt) -> keep;
        # touched within the TTL -> keep. ONLY a stale, un-finalized session is reaped.
        mtimes = _session_mtimes(session)
        if not mtimes or now - max(mtimes) < ttl_seconds:
            continue
        shutil.rmtree(session, ignore_errors=True)
        swept.append(session)
    return swept


async def _sweep_owner_sessions(owner: str) -> None:
    """Run the stale-session sweep across the caller's own upload jail, off the event
    loop. Best-effort hygiene — `_sweep_stale_sessions` never raises — so it never
    fails the request it rides (create_upload / GET /api/uploads)."""
    uploads_root = db.resolve_under(db.users_root(), owner, "uploads")
    swept = await run_in_threadpool(
        _sweep_stale_sessions, uploads_root, _max_session_age_seconds()
    )
    for path in swept:
        _logger.info("swept stale upload session %s (owner=%s)", path.name, owner)


def _list_sessions(uploads_root: Path) -> list[UploadSessionSummary]:
    """Build the owner's session summaries from the filesystem (SYNCHRONOUS — call
    via `run_in_threadpool`). Tally-backed (no per-file rescan on the steady path);
    a dir that is not a valid session (no images/) or vanished mid-scan is skipped."""
    try:
        session_dirs = sorted(p for p in uploads_root.iterdir() if p.is_dir())
    except OSError:
        return []  # no uploads yet
    summaries: list[UploadSessionSummary] = []
    for session in session_dirs:
        try:
            if not (session / _IMAGES_SUBDIR).is_dir():
                continue  # not a session opened by create_upload
            count, nbytes = _load_or_recount_tally(session)
            mtimes = _session_mtimes(session)
            state = "finalized" if (session / _FINALIZED_MARKER).exists() else "open"
            summaries.append(
                UploadSessionSummary(
                    upload_id=session.name,
                    state=state,
                    received_parts=count,
                    bytes_received=nbytes,
                    created=min(mtimes) if mtimes else 0.0,
                    last_activity=max(mtimes) if mtimes else 0.0,
                )
            )
        except OSError as exc:
            # One session that vanished / became unreadable mid-scan — e.g.
            # `_recount_tally`'s per-file `stat()` racing a concurrent delete, or a
            # permission change — must not 500 the caller's WHOLE upload list. Skip it
            # (the function's documented "vanished mid-scan is skipped"); it reappears or
            # settles on the next poll. Same isolation contract as the dataset listing.
            _logger.warning(
                "Skipping upload session %r in listing: %s", session.name, exc
            )
            continue
    return summaries


def _files_page(
    upload_dir: Path, upload_id: str, limit: int, offset: int
) -> UploadFilesPage:
    """A name-sorted page of the per-file manifest (SYNCHRONOUS — call via
    `run_in_threadpool`; the rebuild-on-doubt branch hashes the bundle). `total` is
    the full manifest size; the page is `[offset : offset + limit]`."""
    manifest = _load_or_rebuild_manifest(upload_dir)
    names = sorted(manifest)
    page = names[offset : offset + limit]
    files = [
        UploadFileInfo(
            name=name,
            size=int(manifest[name]["size"]),
            sha256=str(manifest[name]["sha256"]),
            is_metadata=_is_metadata_name(name),
        )
        for name in page
    ]
    return UploadFilesPage(
        upload_id=upload_id, total=len(names), limit=limit, offset=offset, files=files
    )


@router.post("/api/uploads")
async def create_upload(
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> UploadHandle:
    """Open a fresh upload session in the caller's jail. The server mints the
    `upload_id` (no client path is ever trusted, D-18); the session exists once its
    images/ dir does, and starts in the "open" state.

    Seam O2: reaps the caller's stale un-finalized sessions FIRST (best-effort TTL
    sweep — before the new dir exists, so it is never a sweep candidate) so
    abandoned bundles do not hold disk forever."""
    await _sweep_owner_sessions(user.username)
    upload_id = uuid.uuid4().hex
    (_upload_dir(user.username, upload_id) / _IMAGES_SUBDIR).mkdir(
        parents=True, exist_ok=True
    )
    return UploadHandle(upload_id=upload_id)


@router.get("/api/uploads")
async def list_uploads(
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> list[UploadSessionSummary]:
    """List the caller's upload sessions (Seam O2 resume surface): tally-backed
    count/bytes + state + mtime-derived created/last_activity for each, jailed to
    the caller's OWN jail (a user never sees another's sessions). Reaps stale
    un-finalized sessions first (best-effort TTL sweep) so the list never shows a
    bundle already past its TTL."""
    await _sweep_owner_sessions(user.username)
    uploads_root = db.resolve_under(db.users_root(), user.username, "uploads")
    return await run_in_threadpool(_list_sessions, uploads_root)


@router.post("/api/uploads/{upload_id}/parts")
async def upload_part(
    upload_id: str,
    part: UploadFile = File(...),
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> UploadStatus:
    """Store one part in the session's jail. A `.zip` part is EXTRACTED into the
    bundle (D-27: images flattened by basename, one root-level CSV/TSV as
    metadata, the rest ignored + reported); a `.csv`/`.tsv` part is the (single)
    optional metadata source; everything else is an image keyed by its basename.
    Rejects parts after finalize, a second (different) metadata source, and any
    breach of the whole-bundle caps (413). A duplicate-name plain part is diffed
    (Seam O2 idempotent re-send): byte-identical to the stored file -> 200 with
    `already_present=True`; genuinely different -> 409 pointing at /check."""
    upload_dir = _upload_dir(user.username, upload_id)
    if not (upload_dir / _IMAGES_SUBDIR).is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Upload session not found"
        )
    if (upload_dir / _FINALIZED_MARKER).exists():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Upload already finalized"
        )

    name = _safe_part_name(part.filename)
    ext = Path(name).suffix.lower()

    if ext == _ZIP_EXT:  # D-27: extract, never store the archive itself
        return await _ingest_zip_part(part, upload_dir, upload_id)

    # Resolve the target and classify BEFORE consuming the body, so a duplicate part
    # is diffed (Seam O2 idempotent re-send) rather than streamed to disk only to be
    # discarded. The metadata source is the canonical `metadata{ext}`.
    if ext in _CSV_EXTS:
        target = upload_dir / f"metadata{ext}"
        if not target.is_file() and any(
            (upload_dir / f"metadata{e}").is_file() for e in _CSV_EXTS
        ):
            # A DIFFERENT metadata source already present — one CSV/TSV per bundle
            # (a same-ext re-send falls through to the idempotent check below).
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A metadata file was already uploaded for this bundle",
            )
    else:
        target = db.resolve_under(upload_dir, _IMAGES_SUBDIR, name)

    # Idempotent re-send (Seam O2): a duplicate whose bytes match the stored file is
    # a safe blind-retry no-op (200, already_present); a genuine mismatch stays 409
    # pointing at /check. The body is drained + hashed but never written over the
    # stored file, so a mismatch leaves the bundle exactly as it was.
    if target.is_file():
        return await _resend_or_conflict(part, upload_dir, upload_id, target)

    # A genuinely new part shares the whole-bundle accounting with ZIP extraction
    # (D-27): the entry cap is exact up front (one part = one file); the byte cap is
    # enforced while the part streams (`bundle_remaining`). The cap PRE-CHECKS read
    # the incremental tally instead of rescanning + stat-ing the whole bundle (T2-53,
    # off the loop — the recount branch of `_load_or_recount_tally` can scan).
    existing_count, existing_bytes = await run_in_threadpool(
        _load_or_recount_tally, upload_dir
    )
    if existing_count + 1 > _max_entries():
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Upload bundle exceeds the {_max_entries()}-file entry limit",
        )
    bundle_remaining = _max_bundle_bytes() - existing_bytes
    written, sha = await _store_part(part, target, bundle_remaining=bundle_remaining)
    # The part is now committed to the bundle → fold its delta into the tally under
    # the per-upload lock (serialised, so a concurrent part cannot lose it, T2-53),
    # then record its size+hash in the manifest (Seam O2, its own per-upload lock).
    count, nbytes = await run_in_threadpool(_apply_tally_delta, upload_dir, 1, written)
    await run_in_threadpool(
        _apply_manifest_entries, upload_dir, [(target.name, written, sha)]
    )
    return _status_from_tally(upload_dir, upload_id, count, nbytes)


@router.post("/api/uploads/{upload_id}/finalize")
async def finalize_upload(
    upload_id: str,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> UploadHandle:
    """Seal the bundle for ingest. Requires at least one file in images/ (the
    pipeline's deeper "decodable image" check runs at ingest); writes the
    `.finalized` marker so create_dataset / start_ingest will accept the bundle.

    T2-53: also RECONCILES the tally against a full recount (constraint (c)) — a
    once-per-session, threadpooled scan that repairs any drift a mid-session crash
    left in `.tally.json` before the bundle is handed to ingest. This is the hard
    backstop that makes the tally impossible to under-count across a crash: the
    reconciled totals are the truth the caps were being tracked against."""
    upload_dir = _upload_dir(user.username, upload_id)
    images = upload_dir / _IMAGES_SUBDIR
    if not images.is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Upload session not found"
        )
    if not await run_in_threadpool(_has_image_file, images):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload bundle has no image files",
        )
    # Reconcile the persisted tally to reality before the bundle is consumed.
    count, nbytes = await run_in_threadpool(_recount_tally, upload_dir)
    await run_in_threadpool(_write_tally, upload_dir, count, nbytes)
    (upload_dir / _FINALIZED_MARKER).touch()
    return UploadHandle(upload_id=upload_id)


@router.get("/api/uploads/{upload_id}")
async def get_upload_status(
    upload_id: str,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> UploadStatus:
    """Report received parts / bytes / state for the caller's upload session. Reads
    the incremental tally (repairing it from a full recount on any doubt) rather than
    stat-ing every file per request (T2-53), off the event loop."""
    upload_dir = _upload_dir(user.username, upload_id)
    if not (upload_dir / _IMAGES_SUBDIR).is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Upload session not found"
        )
    count, nbytes = await run_in_threadpool(_load_or_recount_tally, upload_dir)
    return _status_from_tally(upload_dir, upload_id, count, nbytes)


@router.get("/api/uploads/{upload_id}/files")
async def list_upload_files(
    upload_id: str,
    limit: int = Query(_DEFAULT_FILES_LIMIT, ge=1),
    offset: int = Query(0, ge=0),
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> UploadFilesPage:
    """The per-file manifest for the caller's session (Seam O2 resume surface): each
    stored file's name + server-computed size/sha256, the metadata file flagged.
    PAGINATED (name-sorted `limit`/`offset`) because a bundle reaches
    MAX_UPLOAD_ENTRIES (250k) files; `limit` is clamped to _MAX_FILES_LIMIT. The
    manifest is rebuilt from a full re-hash on any doubt (missing/corrupt sidecar),
    off the event loop."""
    upload_dir = _upload_dir(user.username, upload_id)
    if not (upload_dir / _IMAGES_SUBDIR).is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Upload session not found"
        )
    limit = min(limit, _MAX_FILES_LIMIT)
    return await run_in_threadpool(_files_page, upload_dir, upload_id, limit, offset)


async def _read_capped_body(request: Request, limit: int) -> bytes:
    """Buffer the request body but never more than `limit` bytes — the /check memory
    guard. A declared Content-Length over the cap is refused up front; the streamed
    read is then hard-capped too, so a missing or lying Content-Length can never force
    an unbounded buffer. Raises 413 on breach; returns the raw bytes (the caller
    validates them)."""
    too_large = HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        detail=f"check request body exceeds the {limit}-byte limit; batch the diff",
    )
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise too_large
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise too_large
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/uploads/{upload_id}/check")
async def check_upload_files(
    upload_id: str,
    http_request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> CheckResponse:
    """Immich-style pre-check for resume (Seam O2): the client asks which of a batch
    of files the server already holds so duplicate bytes are never sent. `present` =
    name+size match (and hash match when BOTH sides carry a hash), `mismatched` =
    name exists but size (or provided hash) differs, `needed` = not present.

    The body is read as a raw request under a hard byte cap
    (MAX_UPLOAD_CHECK_BODY_BYTES) and only then validated as a CheckRequest, so an
    oversized `files` array is a 413 BEFORE it is buffered/parsed — ahead of the
    per-request _MAX_CHECK_FILES count cap (also 413; a large diff is batched, see the
    interface catalogue). The manifest is rebuilt on any doubt, off the event loop."""
    raw = await _read_capped_body(http_request, _max_check_body_bytes())
    try:
        check = CheckRequest.model_validate_json(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Invalid check request body",
        ) from exc
    if len(check.files) > _MAX_CHECK_FILES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"check accepts at most {_MAX_CHECK_FILES} files per request; "
                "batch the diff"
            ),
        )
    upload_dir = _upload_dir(user.username, upload_id)
    if not (upload_dir / _IMAGES_SUBDIR).is_dir():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Upload session not found"
        )
    manifest = await run_in_threadpool(_load_or_rebuild_manifest, upload_dir)
    present: list[str] = []
    needed: list[str] = []
    mismatched: list[str] = []
    for f in check.files:
        stored = manifest.get(f.name)
        if stored is None:
            needed.append(f.name)
        elif f.size != int(stored["size"]) or (
            f.sha256 is not None and f.sha256 != str(stored["sha256"])
        ):
            mismatched.append(f.name)
        else:
            present.append(f.name)
    return CheckResponse(present=present, needed=needed, mismatched=mismatched)
