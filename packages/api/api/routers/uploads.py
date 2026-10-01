"""Upload session endpoints: create session, upload part(s), finalize -> handle,
query status — plus the Seam O2 resume surface (list / per-file manifest /
pre-check / idempotent re-send / stale-session sweep) and the Seam A2 caps route
(`GET /api/uploads/caps`) that lets a client pre-flight against THIS deployment's
env-tuned ceilings instead of a compiled-in mirror.

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
        .parts-tmp/        # Seam A3 chunked-part staging; a part being assembled across
                           #   requests. Never bundle content, dropped at finalize
        .parts-meta/       # the part_size each in-flight chunked part DECLARED at
                           #   offset 0, so a later chunk cannot substitute another.
                           #   Never bundle content, dropped at finalize

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

Chunked parts (Seam A3, decision D-vii): one part may be delivered across several
requests by adding `chunk_offset` + `part_size` to the SAME multipart POST — a
byte-range append against the existing session, not a second API. Bytes land in
`.parts-tmp/{basename}` and the part is treated as received only when the staged
file reaches `part_size`, at which point it is routed exactly as a whole part
(ZIP → extracted; CSV/TSV → metadata; else → images/). MAX_UPLOAD_PART_BYTES
therefore bounds ONE REQUEST, not one file — which is the point: it is the memory
and disk-per-request bound, and chunking routes around it without weakening it.
What bounds the assembled part instead is MAX_UPLOAD_BUNDLE_BYTES, because bytes
sitting in `.parts-tmp/` are counted against the bundle budget for as long as they
exist. That is what stops an abandoned half-part from parking free disk, and it
means this seam adds NO new ceiling of its own.

The whole-bundle byte ceiling is DERIVED FROM THE DISK (seam L1), not picked. There
is no compiled-in 2 GiB default any more: with MAX_UPLOAD_BUNDLE_BYTES unset, an
upload is bounded by free space on the filesystem holding the upload jail, re-read as
bytes arrive, and a breach is a CAPACITY refusal ("too large to accommodate at this
time — contact an administrator") rather than a policy one. Set, the env var still
takes precedence AS A CAP — but the disk term is always in force too, so a device
smaller than the cap still produces the CAPACITY refusal rather than the cap one. That
is a behaviour change from pre-L1 (where the same case was an ENOSPC 500), and an
earlier draft of this docstring wrongly claimed there was none. The constant it
replaces refused a rijks-shaped corpus at 3,014 images against a PRD target of
1,000,000 — 332x short —
by bounding the wrong thing (`docs/design/LIMITS_REGISTER.md` C-1). The ZIP-bomb guard
D-27 built on that cap is unchanged in mechanism and now bounded by the disk instead:
see `_extract_entry`. The bound is HALF the answer by design — once the served tree
moves to object storage ([[T2-200]]) there is no "full" on that half, only a larger
invoice, and the only honest bound there is a policy one ([[T2-11]] per-user quotas,
which this deliberately does not preclude).

Every cap breach in this module logs at WARNING naming the cap, its value, the observed
figure and what to do ([[T2-no-upload-cap-breach-is-ever-logged]]) — the person refused
is not the person who can lift the refusal, so a 413 alone strands both of them.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
import zipfile
import zlib
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
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

# Seam A3 chunked parts: a part being assembled across several requests lives here
# under its own basename until the staged file reaches the client-declared
# `part_size`, at which point it is routed exactly as a whole part would be.
# Session-local, NEVER bundle content (excluded from `_bundle_files`, like
# `.extract-tmp/`) and dropped at finalize, so a half-part can never be sealed into
# a bundle or counted as a received file.
_PARTS_TMP = ".parts-tmp"
# Seam A3, and the fix for a gate that was advisory: the `part_size` a chunked part
# DECLARED at offset 0, one file per part basename, so a later chunk cannot declare a
# different one. A sibling directory rather than a file inside `.parts-tmp/` because
# every name in there is a client-supplied basename and any reserved name could be
# claimed by a part; keying a separate directory by the same basename cannot collide
# with anything. Session-local, never bundle content, dropped at finalize with
# `.parts-tmp/`.
_PARTS_META = ".parts-meta"
# The temp-file prefix `_write_declared_size` writes under before the atomic rename.
# FIXED-LENGTH on purpose: `mkstemp` appends 8 random chars + the suffix to it, so a
# prefix derived from the part's basename put the temp path past NAME_MAX for any
# basename >= 244 bytes and 500'd the request (see `_write_declared_size`).
_PARTS_META_TMP = ".declared"
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
# as bytes arrive (zip headers are never trusted).
#
# THE BYTE CEILING IS DERIVED FROM THE DISK AND HAS NO COMPILED-IN DEFAULT (seam L1).
# `_DEFAULT_MAX_BUNDLE_BYTES = 2 GiB` used to sit here and it was wrong — not because
# a bound exists, but because it bounded the WRONG THING: it refused a rijks-shaped
# corpus (712,304 bytes/image measured) at 3,014 images against a PRD target of
# 1,000,000, 332x short, while the resource an upload actually consumes is free disk
# (`docs/design/LIMITS_REGISTER.md` C-1). MAX_UPLOAD_BUNDLE_BYTES still works and still
# takes precedence when set, for a deployment that wants an explicit policy ceiling;
# unset, the ceiling is whatever the upload jail's filesystem can hold — see
# `_bundle_budget`.
#
# The whole-bundle file-count ceiling. DEFENDED + TUNABLE + WARNS (AGENT_GUIDE ->
# Limits, rule 2), and it had to be re-decided rather than inherited. The L0 audit
# called it dead, correctly: under the 2 GiB byte cap it could only fire below
# 2,147,483,648 / 250,000 = 8,590 bytes per file, which is a thumbnail set, so it never
# bound on a real image corpus. That finding is CONDITIONAL ON THE BYTE CAP THIS SEAM
# REMOVES — but the arithmetic an earlier draft of this comment used to say what
# replaces it was INVERTED, so state the relation the way round it actually holds:
#
#   at a free-disk budget B and a mean of M bytes/image, the byte bound admits B/M
#   images, so the ENTRY cap C binds first only once B >= C*M.
#
# Every cap therefore has a BREAK-EVEN DEVICE SIZE below which it cannot bind at all.
# Against the measured 712,304 B/image (rijks_pd), 250,000 needs 178.1 GB of budget and
# 1,000,000 needs 712.3 GB. At the 100 GiB the old draft cited, B/M = 150,742 images —
# the DISK still binds first and 250,000 is unreachable, the opposite of what that draft
# claimed. The reason to raise it is therefore not "it binds at 100 GiB" but the one the
# audit found: a bundle ceiling BELOW the number the product claims to serve is a
# contradiction by construction, so on any device big enough to hold the PRD's target
# corpus the cap, not the disk, would have been the thing that refused it.
#
# The value is the PRD's own target (`docs/product_requirements.md:235`: "1,000,000
# images is the target"). It is not free, and BOTH costs are measured (test image,
# Python 3.14; 38-char basenames + a 5-digit size, i.e. `.files.json` as
# `_write_manifest` actually emits it — which reproduces 137.0 bytes/entry exactly):
#
#   * MEMORY — `_read_manifest` peaks at **+772 MB** over an interpreter that has
#     imported this module, at 1,000,000 entries (**+170.9 MB** at 250,000). Re-measured
#     2026-09-04 with `ru_maxrss` in a FRESH process per figure (`execv` does not reset
#     `ru_maxrss`, which is how an earlier attempt got a polluted baseline). The
#     function holds three representations alive at once and the walk ends where the
#     peak is: the 130.7 MiB file as a `str` (+231 MB), the parsed dict (+560 MB), and
#     the revalidated copy it builds while the first is still referenced (+772 MB). An
#     earlier draft of this comment gave that walk as +259/+588/+801 while heading the
#     bullet +772 — a peak cannot be both, and +772 is the one that reproduces. (A
#     reviewer independently measured +801.8 MB; that did not reproduce here across
#     three runs and the discrepancy is unexplained, so the smaller, reproducible figure
#     is the one quoted — including in the user-facing remedy in `_entry_cap_refusal`,
#     which must not disagree with this comment.) Two things sharpen it: nothing sets
#     `mem_limit` on the api service, and `_load_or_rebuild_manifest` is deliberately
#     lock-free, so a second reader can hold a concurrent copy of the same 772 MB.
#   * TIME, and this is the binding cost, not memory — `.files.json` is rewritten IN
#     FULL on every part, so a loose-image upload is QUADRATIC in its own entry count.
#     Measured end to end through the real route: **103.9 s for 5,000 parts**, fitting
#     `t = 0.00636*N + 2.884e-6*N^2` (per-part cost rises linearly, 7.9 ms at N=500 to
#     20.8 ms at N=5,000). That extrapolates to **~2.0 hours for rijks_pd's 49,048
#     files** and **~33 days at this cap**. A ZIP upload amortises it away entirely
#     (one manifest write per archive), which is why nobody has hit it.
#     [[T2-the-per-file-upload-manifest-is-rewritten-in]] — filed, not fixed here: it
#     is pre-existing Seam O2 design and the fix is an append-only journal with its own
#     crash-safety story.
#
# So this cap is defended on memory AND is the thing that makes the quadratic reachable.
#
# WHAT THE BYTE BOUND DOES NOT COVER FOR IT: inodes. An earlier draft of this comment
# said the count needs no disk guard of its own because "every file consumes at least
# one filesystem block, and the byte bound reads real free space" — and that argument
# does not hold. `shutil.disk_usage` exposes free BYTES and no inode figure at all (a
# consequence of the cross-platform choice defended in `_disk_free`), and on ext4 the
# inode table is pre-allocated at `mkfs`, so consuming an inode does not move
# `f_bavail` by one byte. A 16 GiB ext4 volume with mke2fs defaults has ~1,048,576
# inodes; a 1,000,000-file thumbnail set averaging 8 KiB is ~8 GiB, so the byte bound
# reports space free the whole way and the failure arrives as `ENOSPC` from
# `target.open("wb")`. This seam owns that exposure rather than inheriting it: it raised
# the entry cap 4x AND removed the byte cap that previously coupled a high file count to
# a high byte count. What is true is narrower — the byte bound covers the BYTES a large
# file count consumes, and nothing here covers the inodes.
# [[T2-the-byte-bound-is-blind-to-inode-exhaustion]] — filed, deliberately not fixed
# here: the guard needs `os.statvfs`'s `f_favail`, which is POSIX-only, and that is a
# decision about the cross-platform reading, not a line in this module.
# Override via MAX_UPLOAD_ENTRIES; every entry-cap 413 warns (`_cap_refusal`).
_DEFAULT_MAX_ENTRIES = 1_000_000

# Seam O2: per-file content manifest {basename: {"size", "sha256"}}, persisted
# alongside the tally so a resumed client can ask exactly what the server holds.
# `.files.lock` serialises the read-modify-write (an fcntl flock, like the tally —
# an in-process asyncio lock would not serialise across Uvicorn workers). Both are
# session-local, never bundle content, and excluded from `_bundle_files`.
_FILES_FILE = ".files.json"
_FILES_LOCK = ".files.lock"
# A sidecar write that FAILS after its part was already committed leaves the previous
# sidecar complete-LOOKING and one entry short, and NOTHING HERE RECORDS THAT. Three
# recovery designs shipped for it and all three were refuted, because every one of them
# was itself a write to the device that had just refused a write. The fourth is chosen by
# measurement instead: `docs/spikes/spike_upload_session_recovery.md`. Until it runs, the
# behaviour is the status quo ante — the write raises, and the cache may be left behind.

# The fixed part of one `.files.json` row, in bytes: `json.dump` emits each entry as
#
#     "<name>": {"size": <n>, "sha256": "<64 hex>"},
#
# i.e. `: ` (2) + `{"size": ` (9) + `, "sha256": "` (13) + `"}` (2) + the `, ` separator
# (2) + 64 hex characters = 92, on top of the quoted name and the size's digits. See
# `_manifest_row_bytes`, which is the whole of the arithmetic.
_MANIFEST_ROW_FIXED_BYTES = 92
# The widest a size term can be: `2**64 - 1` is 20 decimal digits and no file on any
# filesystem can be larger, so this is a bound rather than a guess. Used only when the
# size is not knowable yet (a plain part is measured as it streams; a ZIP entry's size
# is in a header D-27 never trusts).
_MANIFEST_ROW_MAX_SIZE_DIGITS = len(str(2**64 - 1))

# Seam O2 stale-session sweep: an un-finalized session whose LATEST activity mtime
# is older than this is reaped best-effort (finalized bundles are ingest sources —
# NEVER swept). Override via MAX_UPLOAD_SESSION_AGE_SECONDS.
_DEFAULT_MAX_SESSION_AGE_SECONDS = 7 * 24 * 60 * 60  # 7 days

# GET /{id}/files pagination: default page size and hard cap. A bundle reaches
# MAX_UPLOAD_ENTRIES (1M) files, so the manifest is always served paged; `limit`
# is clamped to this cap (never a 1M-row response).
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


class UploadCaps(BaseModel):
    """The upload ceilings THIS deployment enforces (`GET /api/uploads/caps`).

    Exactly the three caps a client PRE-FLIGHT acts on — per part, whole-bundle
    bytes, whole-bundle file count. `max_part_bytes`/`max_entries` are read through
    the same `_max_*()` helpers the enforcement paths call, so for THOSE TWO the
    advertised number and the enforced number cannot diverge.

    `max_bundle_bytes` is the one that cannot work that way any more (seam L1), and the
    shape here is deliberately UNCHANGED so the frontend needs no coordinated change.
    The enforced bundle bound is now free disk, which varies during an upload and
    between mounts, while `client.ts` caches this read for the lifetime of its
    ApiClient on purpose (*"one read per client, shared by every wizard mount"*). A
    varying value in a cached read lies in both directions, so this advertises a
    STATIC UPPER BOUND instead — the largest bundle the machine could ever hold — and
    capacity becomes a server-side runtime refusal the client cannot predict. See
    `_advertised_max_bundle_bytes` for what that means for the pre-flight's answers.

    Two other caps are deliberately absent, for DIFFERENT reasons — do not collapse
    them into one:

    * MAX_UPLOAD_SESSION_AGE_SECONDS has no client-side consumer at all (verified:
      no mirror of it anywhere under `packages/frontend/src/`).
    * MAX_UPLOAD_CHECK_BODY_BYTES **does** have one, and its absence here is a known
      gap, not a judgement that none exists. `uploadTransport.ts`'s
      `UPLOAD_CHECK_BATCH = 10_000` is a compiled-in mirror sized against this cap
      AND `_MAX_CHECK_FILES`, so lowering the env var breaks `planResume` for any
      bundle past one batch. Exposing it is not enough on its own — the consumer
      needs BOTH numbers to pick a safe batch, and it lives in a module this seam
      does not own. Tracked as
      [[T2-lowering-the-check-body-cap-silently-breaks]]."""

    max_part_bytes: int  # MAX_UPLOAD_PART_BYTES — per part (a ZIP's COMPRESSED bytes)
    # A STATIC UPPER BOUND, not the enforced bound: an explicit MAX_UPLOAD_BUNDLE_BYTES
    # if set, else the upload device's TOTAL capacity. See the docstring above and
    # `_advertised_max_bundle_bytes` — a "no" against it is trustworthy, a "yes" is
    # provisional, and the enforced bound is free disk at the moment of the write.
    max_bundle_bytes: int  # MAX_UPLOAD_BUNDLE_BYTES or the device total
    max_entries: int  # MAX_UPLOAD_ENTRIES — bundle file-count ceiling


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
    is the earliest, `last_activity` the latest mtime `_session_mtimes` can see —
    the session dir and its children, plus the staged prefixes of parts still in
    flight. Every part advances `last_activity`, and so does every CHUNK of one:
    reading only the committed sidecars left it frozen at session-open for a session
    receiving data (review of PR #304, finding 2). It is the signal the stale-session
    sweep uses, so a stale figure is not cosmetic — it reaps a live upload."""

    upload_id: str
    state: str  # "open" | "finalized"
    received_parts: int
    bytes_received: int
    created: float  # epoch seconds (mtime-derived; approximate)
    last_activity: float  # epoch seconds (freshest mtime; advances on every chunk)


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
    bundle reaches MAX_UPLOAD_ENTRIES (1M) files; `total` is the full manifest
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


@lru_cache(maxsize=None)
def _warn_malformed_env(name: str, raw: str, consequence: str) -> None:
    """Say once — and exactly once per distinct value — that an env knob is set to
    something this module cannot use.

    ONCE, because the parse runs per charged request. `_explicit_max_bundle_bytes` is
    called from `_bundle_budget` on every part plus again from each refusal builder, so
    an unconditional log turned one typo into one warning PER PART: measured at 206
    chars/line, a 49,048-file loose upload emits 49,048 lines / 10.1 MB and the genuine
    `"upload cap reached"` lines this seam shipped become one in ~50,000. A warning that
    drowns the warnings is not louder, it is quieter.

    `lru_cache` is the dedupe: the key space is (five knob names) x (the values THIS
    PROCESS ever sees), and env vars are process-stable configuration read from
    `os.environ` — nothing request-derived reaches here — so it is bounded by
    construction rather than by a size anybody picked. `cache_clear()` is the reset a
    test needs to observe the warning more than once."""
    _logger.warning(
        "%s=%r is not a positive integer -- ignoring it, %s",
        name,
        raw,
        consequence,
    )


def _env_positive_int(
    name: str, *, consequence: str, minimum: int = 1
) -> int | None:
    """Parse `name` from the environment as an int of at least `minimum` — or None
    when it is UNSET, and None PLUS a warning when it is set to something else.

    The two Nones are the distinction the Limits convention turns on, and conflating
    them is what this fixes. Unset is the documented default and is silent. SET to
    something unusable is a configuration error whose effect is invisible to the person
    who made it: `MAX_UPLOAD_BUNDLE_BYTES=10GB` removes the policy ceiling entirely,
    `UPLOAD_DISK_RESERVE_BYTES=2GB` reserves nothing, `MAX_UPLOAD_ENTRIES=1OOO` (letter
    O) silently restores the 1,000,000 default. Every one of those LOOSENS a limit while
    the key being present in the env reads as "configured", and none of them warned.

    The empty string is the case that actually ships: `MAX_UPLOAD_BUNDLE_BYTES=` in a
    `.env`, or the standard `- FOO=${FOO}` Compose form with the host variable unset,
    substitutes an empty string. `if not raw` treated that as unset and returned before
    the warning, so the two spellings of blank behaved differently (`''` silent, `' '`
    audible). `os.environ.get(name) is None` is the only test for unset.

    Parsing is `int(raw)` and nothing else, deliberately: it is what both parsers this
    replaces used, so every well-formed value keeps its meaning (`'1_000'` -> 1000,
    `' 2048 '` -> 2048, `'+7'` -> 7). `minimum` is the smallest MEANINGFUL value — 1 for
    a ceiling, where 0 could only ever be a typo, and 0 for a reserve, where "reserve
    nothing" is a real setting and the default."""
    raw = os.environ.get(name)
    if raw is None:
        return None  # unset: the default IS the documented behaviour. Never warn.
    try:
        value: int | None = int(raw)
    except ValueError:
        value = None
    if value is not None and value >= minimum:
        return value
    _warn_malformed_env(name, raw, consequence)
    return None


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    """A positive-int env knob: a missing, non-integer, or below-`minimum` value
    falls back to `default` rather than 500-ing an upload on malformed config — and,
    unless it was simply missing, says so (see `_env_positive_int`)."""
    value = _env_positive_int(
        name,
        consequence=f"falling back to the compiled-in default of {default}",
        minimum=minimum,
    )
    return default if value is None else value


def _max_part_bytes() -> int:
    """Per-part byte ceiling from MAX_UPLOAD_PART_BYTES (default 100 MiB). For a
    ZIP part this caps the COMPRESSED archive bytes."""
    return _env_int("MAX_UPLOAD_PART_BYTES", _DEFAULT_MAX_PART_BYTES)


def _explicit_max_bundle_bytes() -> int | None:
    """The operator's EXPLICIT whole-bundle uncompressed byte ceiling, or None when
    there is not one. There is no default (seam L1): unset means the bundle is bounded
    by free disk instead of by a constant, so this returns None rather than a number
    nobody derived. Set, it takes precedence over the disk *as a cap*: it is the tighter
    bound wherever it is tighter, and a deployment that wants a hard policy ceiling
    keeps one. Per-user quotas ([[T2-11]]) remain the right home for a POLICY bound,
    which this is not.

    **It does NOT restore the pre-L1 behaviour exactly, and an earlier draft of this
    docstring claimed it did.** The disk term is always in force: with the cap set to
    100 MiB on a device with 3 MiB free, the DISK refuses and the response is the
    capacity message, not the cap one. That is an improvement — pre-L1 the same
    situation was an `ENOSPC` 500 — but it is a behaviour change, and asserting
    otherwise would send an operator looking for a bug when they see it.

    A malformed or non-positive value does not merely fall back to a default the way
    `_env_int` does for the other caps — here it REMOVES the policy ceiling entirely and
    leaves only the disk. `MAX_UPLOAD_BUNDLE_BYTES=10GB` meant 2 GiB before this seam
    and means disk-only now. A typo that LOOSENS a limit is precisely what the Limits
    convention exists to make audible, so it is never silent — and this used to be a
    hand-rolled copy of `_env_int` that carried the warning while the original did not,
    which is exactly why the other four knobs were mute. The warning lives in the shared
    parser now and this only supplies the consequence."""
    return _env_positive_int(
        "MAX_UPLOAD_BUNDLE_BYTES",
        consequence=(
            "so uploads are bounded ONLY by free disk on the upload jail's "
            "filesystem. Set it to a byte count, or unset it deliberately."
        ),
    )


def _max_entries() -> int:
    """Whole-bundle file-count ceiling from MAX_UPLOAD_ENTRIES (default 1 000 000 —
    the PRD's target; see the constant's derivation) — D-27."""
    return _env_int("MAX_UPLOAD_ENTRIES", _DEFAULT_MAX_ENTRIES)


def _max_check_body_bytes() -> int:
    """POST /check request-body byte ceiling from MAX_UPLOAD_CHECK_BODY_BYTES
    (default 40 MiB) — the memory guard enforced before the body is parsed."""
    return _env_int("MAX_UPLOAD_CHECK_BODY_BYTES", _DEFAULT_MAX_CHECK_BODY_BYTES)


# ---------------------------------------------------------------------------
# Seam L1: the derived upload bound — stop at the disk, not at a guess.
# ---------------------------------------------------------------------------


def _measurable(path: Path) -> Path:
    """`path`, or its nearest existing ancestor — the argument `shutil.disk_usage`
    needs. Every enforcement site already holds an existing session dir; only the caps
    route can be asked before a jail has ever been created, and its answer is about the
    FILESYSTEM either way, which the nearest existing ancestor identifies just as
    well.

    Called ONCE per budget, not once per chunk, and that is a measured decision rather
    than tidiness. It used to sit inside `_disk_free`, so its `Path.exists()` ran on
    every streaming chunk on the event loop, where it was 61-65% of the added per-chunk
    cost and 6,516 us of the 10,062 us a reading costs on the dev stack's Windows bind
    mount — for a probe that returns True on the first try every time, because the
    caller is holding a directory it just created. `_BundleBudget.jail` now carries the
    already-resolved probe."""
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    return probe


def _disk_free(path: Path) -> int:
    """Free bytes on the filesystem holding `path` — the one reading the whole derived
    bound rests on, in one function so a test can inject a disk instead of filling one.
    `path` must EXIST; callers resolve it through `_measurable` once, up front.

    WHAT IS MEASURED, and why it is not `DATA_ROOT`. Callers pass the upload session's
    own directory: the jail under `db.users_root()` the bytes are actually written
    into, never `DATA_ROOT` as an abstraction. They are the same mount today (`/data`
    in the shipped compose holds users/, datasets/ and app-state/ together), but
    [[T2-200]] moves the SERVED tree to object storage and leaves the jail local, at
    which point a check written against the abstraction would silently measure the
    wrong device ([[T2-r2-would-relieve-half-the-disk-and-change-the-other]]).

    `shutil.disk_usage` rather than `os.statvfs`: the same syscall underneath, a
    cross-platform API, and its `free` is already the UNPRIVILEGED-available figure
    (`f_bavail`), so a filesystem that holds blocks back for root — ext4 reserves 5% by
    default — keeps that reserve outside what this module is willing to spend. What it
    does NOT expose is an INODE figure, which is why the byte bound cannot see inode
    exhaustion at all — see `_DEFAULT_MAX_ENTRIES`."""
    return shutil.disk_usage(path).free


def _disk_total(path: Path) -> int:
    """Total capacity of the filesystem holding `path` — the STATIC half of the
    reading, and the only one safe to advertise (see `_advertised_max_bundle_bytes`).
    Separate from `_disk_free` so the two can be reasoned about, and injected,
    independently: one varies second to second and one changes when someone resizes a
    disk. `path` must EXIST, exactly as for `_disk_free`."""
    return shutil.disk_usage(path).total


class _LiveWriters:
    """How many streaming write loops are running on a THREAD of this process right
    now — the quantity the floor's concurrency term is derived from.

    `_disk_floor` reserved exactly one `_PART_CHUNK_BYTES` because "one chunk is the
    most that can be written between two checks". That is true of ONE writer and false
    of N: `_extract_and_merge_zip` runs under `run_in_threadpool`, so N archive uploads
    are N real OS threads writing between any one of them's two free-space readings, and
    the floor was overshot by (N-1) chunks. Measured on a real tmpfs through real
    uvicorn, 40 MiB ballast, the shipped client's `UPLOAD_CONCURRENCY = 4`: low-water
    free 1.934 MiB at N=1, but 0 bytes at N=4 with 1-3 unhandled `ENOSPC` 500s per run
    (review of PR #304, finding 2).

    **THREADS ONLY, and that is the correction the second review forced.** A first
    version registered `_store_part` and `_append_part_chunk` too — but those are
    `async def` awaited on the event loop, and the `with` wrapped
    `while chunk := await part.read(...)`, so the count was held across every network
    stall. It counted PARKED COROUTINES, which cannot write. Two consequences, both
    executed (round-2 review, finding 3): five sibling 1 KiB parts, each individually
    admissible, made all six in-flight parts refuse — 6 KiB of demand against 4.5 MiB
    free — and one account opening N slow sockets (nothing sets `--limit-concurrency`)
    drove the process-global floor past free space, so every OTHER user was told the
    dataset was too large.

    The event loop needs ONE chunk between all of its writers, not one each, and the
    reason is structural rather than a tuning choice: there is no `await` between a
    coroutine's `budget.check()` and its `fh.write()`, so no other coroutine can write
    in that window, and the next coroutine to write takes its own fresh reading first.
    That one chunk is the `1 +` in `_writer_floor`. Only OS threads can interleave a
    write between another writer's reading and its write, so only they are counted —
    and their number is bounded by the threadpool limiter (anyio's default 40), which
    is why an idle client can no longer inflate this at all.

    Read LIVE inside `_BundleBudget.check`, because a thread that arrives after another
    writer's budget was taken must widen THAT writer's floor too, and an admission-time
    count cannot do that. Cost per check is one uncontended lock acquire, ~0.1 us
    against the 15-221 us of the `statvfs` it guards.

    **Per PROCESS, and that is the honest bound, not the desirable one.** Uvicorn ships
    single-worker here (`docker/Dockerfile.api`), so today the count is complete. With
    `--workers N` it is not, and the same overshoot returns across processes; the file
    locks this module uses for the tally and manifest are the shape that WOULD cross
    that boundary, and an OS-lock-backed reservation is the fix if multi-worker ever
    lands. `_streaming_capacity_refusal` is the backstop either way: a residual overshoot
    on one of the streaming loops is a capacity 413, never an ENOSPC 500."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._live = 0

    def __enter__(self) -> _LiveWriters:
        with self._lock:
            self._live += 1
        return self

    def __exit__(self, *exc: object) -> None:
        with self._lock:
            self._live -= 1

    @property
    def live(self) -> int:
        with self._lock:
            return self._live


_writers = _LiveWriters()


def _writer_floor() -> int:
    """The concurrency term of the floor: one streaming chunk for the event loop, plus
    one per live THREAD writer.

    The `1 +` is not a fudge for the unregistered caller — it is the event loop's whole
    share. However many `_store_part`/`_append_part_chunk` coroutines are in flight, at
    most one of them is between its `budget.check()` and its `fh.write()` at any instant
    (there is no `await` in between), and every other one re-reads free space before it
    writes again. `_writers.live` then adds the writers that genuinely CAN interleave:
    the `run_in_threadpool` ZIP extractions. See `_LiveWriters` for the measurement that
    made the thread term necessary and the one that made the coroutine term wrong."""
    return (1 + _writers.live) * _PART_CHUNK_BYTES


def _disk_reserve_bytes() -> int:
    """UPLOAD_DISK_RESERVE_BYTES — free space uploads must never spend, ON TOP of the
    derived floor below. **Default 0, and that is a finding rather than a choice.**

    The derived terms in `_disk_floor` cover what THIS MODULE needs to stop cleanly.
    What they do not cover is how much free disk the rest of the service needs to keep
    working — app-state SQLite writes, the worker's `ingest.log`, a concurrent bake's
    scratch. Nobody has measured that, and this seam exists because two people typed a
    number instead of measuring one, so it does not type a third: the default bounds
    exactly what is derivable and the knob is here for an operator who knows their
    deployment's working set. What would settle it: peak free-disk consumption of the
    api + worker containers over one full upload -> ingest -> bake cycle, which is a
    measurement nobody has taken.

    0 is a REAL setting here, not a typo, so it is the one knob in this module read with
    `minimum=0` — `UPLOAD_DISK_RESERVE_BYTES=0` means "reserve nothing" and must not
    warn, while `-1` and `2GB` still do."""
    return _env_int("UPLOAD_DISK_RESERVE_BYTES", 0, minimum=0)


def _manifest_row_bytes(name: str, size: int | None = None) -> int:
    """Bytes ONE `.files.json` row costs, COMPUTED from the row rather than averaged
    over a sample of rows.

    `sum(_manifest_row_bytes(n, e["size"]) for n, e in manifest.items())` is EXACTLY
    `len(json.dumps(manifest))` — the per-row `, ` separator that the last row does not
    pay is the pair of braces the whole object does. Pinned that way (against the real
    serialiser, over ASCII, CJK, emoji and escape-bearing names) rather than against
    this arithmetic restated.

    It replaces `_MANIFEST_BYTES_PER_ENTRY = 137`, which was an AVERAGE sold as a bound.
    137 is what this function returns for the shape it was measured on — a 38-char ASCII
    basename and a 5-digit size — but `_safe_part_name` caps no length (nothing in this
    module or `db.resolve_under` checks one) and `json.dump` defaults to
    `ensure_ascii=True`, so at that same 5-digit size a 255-char ASCII basename (ext4's
    `NAME_MAX`) costs 354, 85 CJK characters cost 609, and 63 emoji cost 855 — 6.24x
    the constant, measured 2026-09-05 in the `Dockerfile.test` image (round-2 review,
    finding 12, whose table reads 8 bytes higher throughout because its size term was
    wider). Under-reserving here is what pushes `_write_manifest` onto the ENOSPC path,
    so it must be a bound.

    `size=None` means the size is not knowable yet — a plain part is measured as it
    streams, and a ZIP entry's size lives in a header D-27 never trusts — and reserves
    the widest a byte count can be instead."""
    digits = (
        _MANIFEST_ROW_MAX_SIZE_DIGITS if size is None else len(str(size))
    )
    return len(json.dumps(name)) + digits + _MANIFEST_ROW_FIXED_BYTES


def _sidecar_bytes(upload_dir: Path) -> int:
    """Bytes the session's own sidecars occupy RIGHT NOW (`.tally.json` +
    `.files.json`). Small for a small bundle and NOT small for a big one — 137 bytes for
    a row with a 38-char basename, i.e. 130.7 MiB at the 1,000,000-entry cap for that
    shape (`_manifest_row_bytes`) — which is why the floor scales with it."""
    total = 0
    for name in (_TALLY_FILE, _FILES_FILE):
        try:
            total += (upload_dir / name).stat().st_size
        except OSError:
            continue  # not written yet, or vanished mid-scan — nothing to reserve for
    return total


def _settled_floor(upload_dir: Path, new_entry_bytes: int) -> int:
    """The parts of the floor that do NOT move with concurrency: the sidecar rewrite
    this request is about to force, and the operator's reserve.

    TWICE the sidecar bytes, because `.tally.json` and `.files.json` are written
    temp-then-replace (`_write_tally`, `_write_manifest`) — a rewrite needs their size
    again beside the original. That is what must stay writable for the session to unwind
    and finalize, and it scales with the corpus.

    `new_entry_bytes` is the term that was MISSING and it is the difference between a
    reservation and a snapshot. `_sidecar_bytes` measures the manifest as it is BEFORE
    the request; the rewrite the floor has to cover is of the manifest AFTER it, and a
    ZIP adds thousands of entries at once. Measured on the pre-fix code: a fresh session
    taking one 15,000-entry archive reserved 1,048,576 bytes (sidecar term 0) against a
    post-extraction `.files.json` of 1,650,000 — a 601,424-byte shortfall, which ENOSPCs
    the manifest write AFTER the part is merged and counted, leaving the bundle and its
    manifest silently divergent and the client a 500 (review of PR #304, finding 3).

    It is BYTES rather than a row COUNT, and that is the second correction: a count has
    to be multiplied by a per-row figure, and the per-row figure was an average that a
    long-basename bundle blew through by 6.3x. Callers price their own rows with
    `_manifest_row_bytes`, which is exact for a known size and an upper bound for an
    unknown one. Reserving correctly is now the WHOLE of the defence: nothing records a
    manifest write that fails anyway (`_write_manifest`), so an under-reservation is a
    silent divergence rather than a refusal."""
    projected = _sidecar_bytes(upload_dir) + new_entry_bytes
    return 2 * projected + _disk_reserve_bytes()


def _disk_floor(
    upload_dir: Path, new_entry_bytes: int = 0, *, settled: int | None = None
) -> int:
    """The free bytes this module refuses to spend. Stopping at exactly zero free takes
    the service down with it, so a margin is required — and a PICKED margin would
    reintroduce, one level down, the very defect this seam removes. So it is derived
    from the request, the session and the live shape of the process:

    * `_writer_floor()` — one `_PART_CHUNK_BYTES` for the event loop plus one per LIVE
      THREAD writer, because that is the most that can be written between one writer's
      two free-space readings. It is the loop's own step times a counted quantity, not a
      slab anyone chose; see `_LiveWriters` for the measurement that made the thread
      count necessary and the one that made counting coroutines wrong.
    * `_settled_floor()` — twice the sidecar bytes this request will leave behind
      (current plus what it is about to add) and `UPLOAD_DISK_RESERVE_BYTES`.

    `new_entry_bytes` is what this request will add to `.files.json`, priced row by row
    with `_manifest_row_bytes`: one row for a plain or chunked part, the planned rows
    for an archive (known only after `_plan_zip`, which is why the extraction budget is
    built after the plan). All four `_bundle_budget` call sites pass it; three of them
    took the 0 default until the round-2 review counted them.

    **What this does NOT cover.** Inodes: the byte bound cannot see them at all
    (`shutil.disk_usage` exposes no inode figure) — see `_DEFAULT_MAX_ENTRIES`. And a
    second uvicorn PROCESS: the writer count is per-process, so a multi-worker
    deployment reproduces the concurrency overshoot across processes. Two uploads racing
    for the last gigabyte inside one process are both admitted at their own check and
    one of them meets the floor mid-transfer, which is a refusal, not a corruption —
    and, since `_streaming_capacity_refusal` landed, that stays true even when the
    projection is wrong. A per-user quota ([[T2-11]]) is still the only thing that makes
    it a POLICY rather than a race.

    `settled` lets a caller that already holds the settled terms skip re-`stat`-ing the
    sidecars — `_BundleBudget.check` calls this once per chunk, and it must, since the
    writer count moves. It is the SAME function either way on purpose: a floor with two
    expressions is how one of them stops being the one that runs, which is exactly what
    happened here — a draft of this fix computed the sum separately in `_bundle_budget`
    and in `check`, and a mutation that emptied `_disk_floor` left the suite green
    because nothing on the live path called it any more."""
    if settled is None:
        settled = _settled_floor(upload_dir, new_entry_bytes)
    return settled + _writer_floor()


def _cap_refusal(
    *, cap: str, limit: object, observed: object, detail: str, remedy: str
) -> HTTPException:
    """Build a cap-breach 413 AND log it at WARNING — the two halves of a refusal, in
    one place so no site can do one without the other.

    The shape is `routers/auth.py`'s rate limiter (`:349`), whose comment states the
    reason: *"a silent limiter is indistinguishable from a limit set far too low"*. The
    line names WHAT bound, ITS configured value, the OBSERVED figure and WHAT TO DO,
    because the person refused is not the person who can lift the refusal. Before this,
    every upload cap left the operator nothing but an unattributable
    `"POST /api/uploads/{id}/parts HTTP/1.1" 413` in uvicorn's access log, which cannot
    say which of the caps fired or by how much
    ([[T2-no-upload-cap-breach-is-ever-logged]])."""
    _logger.warning(
        "upload cap reached: cap=%s limit=%s observed=%s -- %s",
        cap,
        limit,
        observed,
        remedy,
    )
    return HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=detail
    )


# The user-facing half of every capacity refusal, in one place because two builders
# now raise it (`_capacity_refusal` before the write, `_write_failure_refusal` after)
# and a client must not be able to tell which one answered — the fact is the same.
_CAPACITY_DETAIL = (
    "This dataset is too large to accommodate at this time — contact an administrator."
)
_CAPACITY_REMEDY = (
    "free space on the filesystem holding the upload jail, move the jail to a larger "
    "device, or lower UPLOAD_DISK_RESERVE_BYTES; no cap value raises this one"
)


def _capacity_refusal(
    *, free: int, floor: int, observed: str, note: str = ""
) -> HTTPException:
    """The 413 for "the disk would fill", which names no constant because there is no
    constant to name. The user message is the operator's own phrasing and it is a
    CAPACITY statement, not a policy refusal: it does not lie about what the product
    can accept, and it names someone who can act. The numbers go to the operator, who
    is the only party that can do anything about a full disk.

    **The `cap=` attribution is READ FROM THE CONFIGURATION, never assumed.** An earlier
    draft hardcoded "no MAX_UPLOAD_BUNDLE_BYTES set" and printed it even when the
    operator HAD set one — the disk term binds first on a small device whether or not a
    cap exists — which is exactly the misattribution
    [[T2-no-upload-cap-breach-is-ever-logged]] exists to end, in the code that closes
    it. A log line that names the wrong cause is worse than none: it sends the operator
    to edit a variable that is already set and is not what refused the user.

    **`free` is PASSED IN, never re-read, and that is the same defect one level down.**
    This used to take the jail and call `_disk_free` again, so the figure it printed was
    not the figure that refused: free rises between the two whenever anything on the
    shared mount finishes — a concurrent `rmtree` of `.extract-tmp/`, a bake completing —
    and the line then reads `9000000000 bytes free` against a 1,000,000-byte floor, i.e.
    it states the refusal condition was NOT met. Every caller holds the reading that
    decided; `_BundleBudget` recovers it as `headroom + floor` for a snapshot refusal.
    It also removes one `statvfs` per refusal.

    **`observed` is a PHRASE, not a byte count**, because three of the call sites refuse
    BEFORE writing anything. They pass the client's declared `part_size`, so the old
    `"after N bytes of this request"` rendered `972335833088 bytes free ... after
    400000000 bytes of this request` for a request that wrote zero. A pre-write refusal
    now says so."""
    explicit = _explicit_max_bundle_bytes()
    configured = (
        "MAX_UPLOAD_BUNDLE_BYTES unset" if explicit is None
        else f"MAX_UPLOAD_BUNDLE_BYTES={explicit} set but NOT the binding term"
    )
    return _cap_refusal(
        cap=f"disk capacity ({configured})",
        limit=f"free must stay above {floor} bytes",
        observed=f"{free} bytes free, {observed}{note}",
        detail=_CAPACITY_DETAIL,
        remedy=_CAPACITY_REMEDY,
    )


def _write_failure_refusal(exc: OSError, where: str) -> HTTPException:
    """The 413 for a write that reported the device FULL — the residual case, where the
    projection was wrong and the filesystem, not this module, made the decision.

    **It names no free/floor reading, deliberately.** `_capacity_refusal`'s contract is
    that `free` is the reading that DECIDED and every caller holds it; this caller holds
    none, because nothing here read the disk — the write did. The version this replaces
    invented `free=0` and re-read the floor AFTER its own recovery had already shrunk
    it, understating it by 10,888,656 bytes (91%) on a 49,048-entry manifest and
    printing "0 bytes free" against a device with 972 GB (round-2 review, finding 10).
    The errno is what is actually known, so the errno is what it prints.

    Reached only through `_streaming_capacity_refusal`, which is the single place that
    decides an `OSError` is about capacity at all."""
    code = errno.errorcode.get(exc.errno, str(exc.errno)) if exc.errno else "no errno"
    return _cap_refusal(
        cap=f"disk capacity ({code}, reported by the filesystem)",
        limit="free disk -- NO reading was taken; the write itself reported the failure",
        observed=f"{where} could not be written ({exc})",
        detail=_CAPACITY_DETAIL,
        remedy=_CAPACITY_REMEDY,
    )


# ENOSPC is "no blocks left"; EDQUOT is "this user's quota is spent", which a
# multi-user self-upload product reaches on a filesystem reporting gigabytes free.
# Both mean the same thing to a client — the bytes cannot be stored — and nothing
# else does. `getattr` because EDQUOT is not defined on every platform Python builds
# for, and an absent name must not take the whole tuple with it.
_CAPACITY_ERRNOS = tuple(
    e for e in (errno.ENOSPC, getattr(errno, "EDQUOT", None)) if e is not None
)


def _streaming_capacity_refusal(
    exc: BaseException, where: str
) -> HTTPException | None:
    """The capacity 413 for a write that reported the device full — or None when the
    failure is not a capacity one and must keep its 500 and its traceback.

    **Called from exactly three places, and the narrowness is the point.** The bound's
    promise is that a RESIDUAL OVERSHOOT ON A STREAMING WRITE is a refusal rather than an
    `ENOSPC` 500: the floor is a projection, a projection can be wrong (unusually long
    basenames, a writer in another uvicorn process), and the write itself is then the
    thing that decides. That is `_store_part`, `_append_part_chunk` and the ZIP
    extraction/merge in `_extract_and_merge_zip` — the three loops that stream client
    bytes onto the device. Nothing else.

    **This replaces an app-wide `add_exception_handler(OSError, ...)`, which reached
    every router in the process.** Measured (review of PR #304, finding 9): `GET
    /api/datasets` — a read route in another router — answered
    **413 "This dataset is too large to accommodate"** for an internal `OSError(ENOSPC)`,
    with a remedy naming `UPLOAD_DISK_RESERVE_BYTES`, which has no effect on that route.
    Registering ANY handler for `OSError` also moved every `OSError` subclass past
    Starlette's `handler is None` early-out into the `response_started` guard, so an
    error during a `FileResponse` body — `tiles.py` has four such routes — surfaced as
    `RuntimeError("Caught handled exception, but response already started")` instead of
    the errno. Both are gone with the registration.

    A read route can therefore no longer answer a capacity 413 at all, which is the
    property `test_a_READ_on_a_device_that_cannot_ALLOCATE_is_never_a_capacity_413`
    pins. A SIDECAR write that fails still raises — a 500, exactly as on `main`, with
    the cache left behind; that is the status quo ante this seam deliberately returns
    to rather than shipping a fourth unmeasured recovery design
    (`docs/spikes/spike_upload_session_recovery.md`)."""
    if not isinstance(exc, OSError) or exc.errno not in _CAPACITY_ERRNOS:
        return None
    return _write_failure_refusal(exc, where)


def _bundle_cap_refusal(
    observed: int, *, spoken_for: int = 0, remaining: int | None = None
) -> HTTPException:
    """The 413 for the operator's EXPLICIT whole-bundle byte ceiling — unchanged text,
    now audible, and now arithmetically consistent with the cap it names.

    Two corrections the log needed and the detail string did not (the user-facing text
    is byte-identical, because the number a user can act on is still the configured cap):

    * `observed` was PER-REQUEST for a CUMULATIVE cap. A bundle holding 900 against a cap
      of 1000, sent 200 more, logged `limit=1000 observed=200` — a stated breach below
      its own limit. `spoken_for` is what the bundle already holds, so the figure logged
      is the cumulative one, which is what the cap is about. All four `_entry_cap_refusal`
      sites already did this; this one is now the same shape.
    * `remaining` is the budget that ACTUALLY bound, which is not always `limit -
      spoken_for`: the Seam A3 re-send allowance can raise it (`max(explicit -
      spoken_for, allowance)`). Cap 5000, bundle 4,990, a stored twin of 800 -> the
      request could have added 800, and the old line printed neither 800 nor anything
      it could be derived from."""
    limit = _explicit_max_bundle_bytes()
    budget = "" if remaining is None else f" (this request could add {remaining})"
    return _cap_refusal(
        cap="MAX_UPLOAD_BUNDLE_BYTES",
        limit=f"{limit}{budget}",
        observed=f"{spoken_for + observed} bundle bytes ({observed} in this request)",
        detail=f"Upload bundle exceeds the {limit}-byte bundle limit",
        remedy=(
            "raise MAX_UPLOAD_BUNDLE_BYTES, or unset it to bound uploads by free disk "
            "instead"
        ),
    )


def _entry_cap_refusal(observed: object) -> HTTPException:
    """The 413 for the whole-bundle file-count ceiling. Now audible, and it has to be:
    the value is defended rather than derived (see `_DEFAULT_MAX_ENTRIES`), so per
    AGENT_GUIDE -> Limits rule 2 a deployment that outgrows it must SAY so instead of
    silently refusing — which is exactly how the 250,000 it replaces survived from
    D-27 (2026-06-11) to the L0 audit without anyone noticing it could not bind."""
    limit = _max_entries()
    return _cap_refusal(
        cap="MAX_UPLOAD_ENTRIES",
        limit=limit,
        observed=observed,
        detail=f"Upload bundle exceeds the {limit}-file entry limit",
        remedy=(
            "raise MAX_UPLOAD_ENTRIES; the default is the PRD's 1,000,000-image "
            "target and costs 137 bytes/entry of .files.json for 38-char basenames "
            "and up to 6x that for long or non-ASCII ones (_manifest_row_bytes), "
            "~772 MB RSS to read it at that count, and quadratic manifest rewriting "
            "for LOOSE parts (~2 h for 49,048; archives amortise it away)"
        ),
    )


class _BundleBudget:
    """How much more one request may write, WHICH bound produced that figure, and what
    to re-read to notice the disk filling underneath it.

    One object rather than the bare int this used to be, because a refusal now has to
    say which bound fired: an explicit MAX_UPLOAD_BUNDLE_BYTES names a number an
    operator can raise, while a capacity refusal names no constant at all.

    * `remaining` — bytes this request may still add to the bundle, or None when the
      write is not charged to the bundle at all (a ZIP part's COMPRESSED archive bytes,
      which D-27 has never counted; the disk still is).
    * `free` / `floor` — the ADMITTING reading and the floor it was judged against,
      both immutable. `headroom` is the DISK term on its own, before an explicit cap is
      folded in — a derived `@property`, because storing it as a third copy of the same
      reading is how the identity `_capacity_refusal` relies on (`headroom + floor ==
      free`) came apart: `check` re-read free in place while `floor` stayed at
      construction time, so a refusal reported `9000000000 bytes free` against a budget
      derived from 4,000,000 (round-2 review, finding 11). The live reading now has its
      own name, `_live_free`, and only the live branch reads it.
    * `from_disk` — True when free space, not an explicit cap, produced `remaining`.
    * `spoken_for` — what the bundle already holds, carried only so a cap refusal can
      state the CUMULATIVE figure its cap is about rather than this request's slice.
    * `jail` / `floor` — re-read per chunk by `check`, and THAT is what makes the bound
      follow the disk rather than a snapshot of it. `remaining` alone would already
      bound this request's own writes exactly (the bytes we write are the free space we
      consume), but it cannot see another process, another user's upload, or the
      worker's own bake eating the disk mid-transfer. The re-read can. `jail` is the
      already-`_measurable`-resolved path, resolved once here instead of once per chunk.

    A plain class rather than the NamedTuple this was, for the mutable fact a
    per-request budget needs and a tuple cannot hold: the LIVE free reading, re-taken as
    the request writes. The third positional argument is now `free` rather than
    `headroom` — the reading itself instead of one of the two quantities derived from
    it; there is one construction site (`_bundle_budget`)."""

    def __init__(
        self,
        jail: Path,
        floor: int,
        free: int,
        remaining: int | None = None,
        from_disk: bool = True,
        *,
        settled: int = 0,
        spoken_for: int = 0,
    ) -> None:
        self.jail = jail
        self.floor = floor
        self.free = free
        self.remaining = remaining
        self.from_disk = from_disk
        self.spoken_for = spoken_for
        # The non-concurrency part of the floor, kept so `check` can re-derive the LIVE
        # floor without re-stat-ing the sidecars on every chunk.
        self._settled = settled
        # The live reading, and the `written` figure it was taken at. It starts as the
        # admitting reading — which is why the first check of a request costs no
        # syscall — and diverges from `free` as `check` re-reads. See `check`.
        self._live_free = free
        self._read_at = 0

    @property
    def headroom(self) -> int:
        """The disk term of the ADMITTING reading: what this request could have added
        before free space met the floor. Derived rather than stored so it cannot drift
        from the pair it is made of — `headroom + floor == free` is an identity
        `_capacity_refusal` states, and it has to stay one."""
        return self.free - self.floor

    def _live_floor(self) -> int:
        """The floor as it is RIGHT NOW: the settled terms plus one chunk per live
        writer. Re-derived per check because a writer that starts after this budget was
        taken widens the floor for every writer already running (`_LiveWriters`), and an
        admission-time number cannot see it. Through `_disk_floor` — the same function
        that produced the admission figure — with the settled terms handed back so no
        `stat` is repeated."""
        return _disk_floor(self.jail, settled=self._settled)

    def refusal(self, observed: int) -> HTTPException:
        """The 413 for exceeding THIS budget — capacity or cap, whichever made it. The
        capacity branch reports the reading that ADMITTED the request, because that is
        the one the `remaining` it just breached was derived from. `free` and `floor`
        are both from that admission and neither moves, so the line is internally
        consistent; the LIVE-floor branch in `check` is the one that reports the live
        pair, and it reports both halves of it."""
        if self.from_disk:
            return _capacity_refusal(
                free=self.free,
                floor=self.floor,
                observed=f"after {observed} bytes of this request",
            )
        return _bundle_cap_refusal(
            observed, spoken_for=self.spoken_for, remaining=self.remaining
        )

    def declared_refusal(self, declared: int, *, note: str = "") -> HTTPException:
        """The 413 for a part whose CLIENT-DECLARED size cannot fit — the one refusal
        this module can give before any byte moves (Seam A3 `part_size`).

        Separate from `refusal` only so the operator's line does not claim bytes that
        were never written. `refusal`'s phrasing is `"after N bytes of this request"`,
        and three pre-write sites were passing a declared figure into it: an operator
        read `972335833088 bytes free after 400000000 bytes of this request` for a
        request that wrote nothing at all."""
        if self.from_disk:
            return _capacity_refusal(
                free=self.free,
                floor=self.floor,
                observed=(
                    f"refusing a declared {declared}-byte part before any byte of it "
                    "is staged"
                ),
                note=note,
            )
        return _bundle_cap_refusal(
            declared, spoken_for=self.spoken_for, remaining=self.remaining
        )

    def check(self, written: int) -> None:
        """Refuse once `written` has crossed the snapshot budget, or once free space has
        fallen to the floor since it was taken. Called once per streaming chunk in every
        loop that writes bytes into a session — AND once for a body with no chunks at
        all, which is the whole of the next paragraph.

        **It must be called at least once per part, and it used to sit only inside
        `while chunk := await part.read(...)`.** A zero-byte body therefore consulted
        neither the disk floor nor the byte cap: with free pinned to 0 a 1-byte part was
        refused 413 and a 0-byte part returned 200, fifty more were accepted on the full
        device, and each one still drove `_apply_tally_delta` + `_apply_manifest_entries`
        — two temp-then-replace writes — onto it (review of PR #304, finding 1). The
        shipped client has no `size > 0` guard, so it reaches this path.

        **Free space is re-read once a CHUNK'S WORTH of this request has been accounted
        for since the last reading.** `_bundle_budget` read free space microseconds
        before the loop started, and nothing of this request has landed yet, so the
        pre-loop check re-reads nothing: 100% overhead removed for a single-chunk part,
        which is what a loose-image upload is (49,048 redundant `statvfs` pairs for one
        rijks-shaped session, on the event loop of a single-worker uvicorn that also
        serves pyramid range reads). Past that, every chunk gets its own reading.

        **The gate was `on_disk > self._read_at` and it was dead on the dominant path.**
        Both counters start at 0, so the first advance can never satisfy `0 > 0` and the
        disk term did not move until the THIRD check — a single-chunk part, 49,048 of
        49,048 in a rijks session, never re-read at all, and the claim one draft of this
        docstring made ("every check from the second chunk on is live") was false
        (round-2 review, finding 6). Gating on `written` instead makes it true from the
        first chunk on, at a cost of one `statvfs` per request (104 syscalls against 103
        for a 100 MiB part; the round-1 win was 204 -> 103).

        **What it still does NOT cover**: a run of checks that advances no bytes. Five
        thousand zero-byte ZIP entries pass `written == 0` five thousand times and the
        gate cannot fire, because there is no byte count to fire on — yet each one costs
        a directory entry and an inode. That is not a bug in this gate but the exposure
        `_DEFAULT_MAX_ENTRIES` names and [[T2-the-byte-bound-is-blind-to-inode-exhaustion]]
        holds: `shutil.disk_usage` reports no inode figure, so no reading taken here
        would see it either.

        The floor's invariant is what makes the gate safe: between any two readings at
        most one chunk of this request is written, and `_writer_floor` reserves one chunk
        for the event loop plus one per live thread writer."""
        if self.remaining is not None and written > self.remaining:
            raise self.refusal(written)
        if written >= self._read_at + _PART_CHUNK_BYTES:
            self._live_free = _disk_free(self.jail)
            self._read_at = written
        floor = self._live_floor()
        if self._live_free <= floor:
            raise _capacity_refusal(
                free=self._live_free,
                floor=floor,
                observed=f"after {written} bytes of this request",
            )


def _bundle_budget(
    upload_dir: Path,
    *,
    spoken_for: int = 0,
    allowance: int = 0,
    charged: bool = True,
    new_entry_bytes: int = 0,
) -> _BundleBudget:
    """The budget for ONE request against `upload_dir`: the explicit operator ceiling
    if there is one, free disk otherwise, whichever binds first.

    `spoken_for` is the bundle budget already consumed (committed tally + `.parts-tmp/`
    staging) and is subtracted from the EXPLICIT cap only — the disk term needs no
    subtraction, because bytes already committed have already consumed the free space
    this reads. `allowance` is the Seam A3 idempotent-re-send exemption, and `charged`
    is False for bytes D-27 does not bill to the bundle (a staged compressed archive),
    which are still bounded by the disk because they are still on it. `new_entry_bytes`
    is what this request will add to `.files.json`, priced with `_manifest_row_bytes`,
    which the floor must reserve the rewrite of — see `_settled_floor`.

    SYNCHRONOUS (two `stat`s, one `exists` and one `statvfs`); call sites already run
    inside the request's threadpool hop or are on the streaming path, where they sit
    beside a `write`."""
    jail = _measurable(upload_dir)
    settled = _settled_floor(upload_dir, new_entry_bytes)
    floor = _disk_floor(upload_dir, settled=settled)
    free = _disk_free(jail)
    headroom = free - floor

    def built(remaining: int | None, from_disk: bool) -> _BundleBudget:
        return _BundleBudget(
            jail,
            floor,
            free,
            remaining,
            from_disk,
            settled=settled,
            spoken_for=spoken_for,
        )

    if not charged:
        return built(None, True)
    explicit = _explicit_max_bundle_bytes()
    if explicit is None:
        return built(headroom, True)
    from_cap = max(explicit - spoken_for, allowance)
    if from_cap <= headroom:
        return built(from_cap, False)
    return built(headroom, True)


def _advertised_max_bundle_bytes() -> int:
    """`max_bundle_bytes` for `GET /api/uploads/caps` — DELIBERATELY STATIC, and a
    SOUND UPPER BOUND rather than the live budget.

    The client caches this read for the lifetime of its ApiClient (`client.ts`
    `getUploadCaps`: *"one read per client, shared by every wizard mount"*), which was
    correct while the caps were a process-lifetime constant. Advertising the live disk
    headroom would make that cache lie in both directions — stale-high gives the
    mid-upload 413 the pre-flight exists to prevent, stale-low refuses a selection the
    server would now accept. So what is advertised is the TOTAL CAPACITY of the device
    the jail is on: derived, moving only when someone resizes a disk (a redeploy-level
    event, not a mid-session one), and an upper bound on any bundle that could ever be
    accepted on this machine.

    **Total, not half of it, and the difference is a false refusal.** The worst-case
    peak of `2 x the bundle bytes` applies to an archive, which is staged and then
    extracted beside itself — but `preflightCaps` compares this number against a sum
    that EXCLUDES archives (`uploadSelection.ts:230`, `parts.filter(p => !p.isZip)`,
    because a ZIP's uncompressed size is unknowable client-side, D-27). Plain parts have
    no transient copy at all: they stream straight into `images/`, and a chunked one is
    `os.replace`d, not copied. So halving would refuse a plain selection between half
    the device and all of it that the server would in fact accept — stale-low, the
    failure mode with no override. Nothing applies that multiplier as an ADMISSION test
    any more: the constant that did (`_PEAK_STAGING_MULTIPLIER`, at the chunked-archive
    gate in `_ingest_part_chunk`) over-charged an archive whose entries are mostly not
    extractable and has been removed — see the comment at that gate. What bounds an
    archive is the live re-read during extraction, which watches the peak instead of
    predicting it.

    The asymmetry this buys is the honest one, and it is what makes a cached read safe:
    a pre-flight "no" is TRUSTWORTHY (nothing larger than the whole device can ever
    fit), while a "yes" is PROVISIONAL (the space may not be free right now, and an
    archive's expansion is not in the sum at all). An explicit MAX_UPLOAD_BUNDLE_BYTES
    still wins, so a deployment that wants clients pre-flighting against a policy
    number sets one.

    SYNCHRONOUS — call via `run_in_threadpool`, like every other helper here that
    touches the filesystem. It is `_measurable`'s ancestor walk plus a `statvfs`:
    37.9-74.5 us on overlayfs but 1,816 us on the dev stack's Windows bind mount, which
    is a hard event-loop stall on the single-worker uvicorn that also serves pyramid
    range reads. `get_upload_caps` called it inline (round-2 review, finding 13)."""
    explicit = _explicit_max_bundle_bytes()
    if explicit is not None:
        return explicit
    return max(1, _disk_total(_measurable(db.users_root())))


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


def _staged_bytes(upload_dir: Path) -> int:
    """Bytes currently parked in `.parts-tmp/` — chunked parts that have arrived but are
    not yet complete (Seam A3). DERIVED from the filesystem on every read rather than
    tracked in a counter: staging is transient, a crashed request can leave a prefix
    behind, and a number that can drift from the disk is exactly the accounting bug the
    whole-bundle cap cannot afford.

    This is what makes an in-flight part visible to the bundle cap. The budget every
    write is checked against is `MAX_UPLOAD_BUNDLE_BYTES - committed_tally -
    _staged_bytes(...)`, so bytes are refused as they arrive whether they are already in
    the bundle or merely staged for it — and an ABANDONED half-part keeps occupying its
    share until the session is finalized (staging dropped) or swept. Without that, a
    client could park unbounded disk in half-parts the tally never sees.

    Cheap by construction: O(parts in flight) — at most a handful — not O(bundle) like
    `_recount_tally`. SYNCHRONOUS `iterdir` + `stat`; call via `run_in_threadpool`."""
    staging = upload_dir / _PARTS_TMP
    if not staging.is_dir():
        return 0
    total = 0
    for path in staging.iterdir():
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue  # vanished mid-scan (a concurrent completion) — nothing to count
    return total


def _committed_and_staged(upload_dir: Path) -> tuple[int, int]:
    """`(committed file count, committed bytes + staged bytes)` — the base EVERY
    whole-bundle byte check subtracts from, so there is exactly one answer to "how
    much of the bundle budget is already spoken for" and no path can forget the
    in-flight half of it. The count is committed-only: a part still assembling is not
    yet a file, and the entry cap counts files.

    SYNCHRONOUS — call via `run_in_threadpool` (the tally's recount branch scans the
    bundle)."""
    count, nbytes = _load_or_recount_tally(upload_dir)
    return count, nbytes + _staged_bytes(upload_dir)


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
    unreadable, malformed JSON, wrong shape, or a negative value. A None return is the
    caller's signal to recount (never to under-count). Writes are atomic-replace
    (`_write_tally`), so a reader never observes a half-written file: it sees either the
    complete old tally or the complete new one.

    **A write that FAILED is invisible here, and that is the deferred defect**, not an
    oversight: what a failed write leaves behind is the previous complete tally, which
    raises no doubt at all. Recording that doubt needs a mechanism that can be written on
    a device refusing writes, and the three that shipped could not be
    (`docs/spikes/spike_upload_session_recovery.md`)."""
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
    half-written file that `_read_tally` would have to salvage.

    **An `OSError` RAISES — a 500 — and the tally is left silently behind.** That is the
    deliberate outcome of seam L1, not an omission: a failing write is exactly the state
    in which no recovery mechanism could be recorded, three designs for one shipped and
    were refuted, and the fourth is being chosen by measurement
    (`docs/spikes/spike_upload_session_recovery.md`). Only a write on one of the three
    STREAMING loops is converted to a capacity 413 — see `_streaming_capacity_refusal`;
    a sidecar is not one of them."""
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
    `run_in_threadpool` (the recount branch scans the bundle).

    **The write-back RAISES if it cannot persist, and the read fails with it.** The
    recount in hand is already the truth, so answering from it would be correct — but
    "persist best-effort, answer anyway" is a recovery design, and the point of seam L1
    is that the fourth one is chosen by measurement rather than by reasoning
    (`docs/spikes/spike_upload_session_recovery.md`). What this costs, measured through
    the real routes on a device with no free inodes: `GET /api/uploads/{id}` 500s while
    the sidecar is in doubt, and `_list_sessions` skips the session entirely — pinned as
    known limitations in `test_derived_upload_bound.py`'s `starved` tier."""
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
    absent, unreadable, malformed JSON, wrong shape, or a negative size. A None return
    is the caller's signal to rebuild (never to serve a torn/partial view). Writes are
    atomic-replace (`_write_manifest`), so a reader sees either the whole old manifest
    or the whole new one.

    **A write that FAILED raises no doubt here, and that is the deferred defect**: what
    it leaves behind is a complete file that is simply out of date, and every later
    append merges onto it. See `_read_tally` for why nothing signals it and
    `docs/spikes/spike_upload_session_recovery.md` for what will."""
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
    `_read_manifest` would have to reject.

    **An `OSError` RAISES, and "leaves the previous complete manifest intact" is the
    WRONG outcome here**: this write runs after the part is already committed, so what
    survives is complete-looking and one entry short, and a resuming client is told it
    is missing a file the server already holds. Nothing records that — deliberately, for
    the reason in `_write_tally`: `docs/spikes/spike_upload_session_recovery.md`."""
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
    hashes the bundle).

    **The write-back RAISES if it cannot persist**, and `GET /{id}/files` /
    `POST /{id}/check` 500 with it — the routes a client polls precisely when an upload
    has just failed. Answering from the rebuilt map anyway is one of the candidate
    recovery designs and is not chosen here; see `_load_or_recount_tally` and
    `docs/spikes/spike_upload_session_recovery.md`. It is a 500, never a capacity 413:
    a read is not a capacity event, and the conversion is scoped to the streaming write
    loops alone (`_streaming_capacity_refusal`)."""
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


async def _record_committed_part(
    upload_dir: Path,
    d_count: int,
    d_bytes: int,
    entries: list[tuple[str, int, str]],
) -> tuple[int, int]:
    """Fold a part that is ALREADY IN THE BUNDLE into the tally and then the manifest,
    off the event loop. Returns the new `(count, bytes)`. The single commit sequence for
    all three routes (plain part, completed chunked part, extracted archive) — one
    function so the ordering is stated once: the tally is always written FIRST.

    **A failure anywhere in here leaves the caches behind the bundle, and nothing repairs
    them.** An `OSError` from `_apply_tally_delta` aborts before `_apply_manifest_entries`
    is reached, so BOTH sidecars keep their previous, complete-looking contents while the
    part is already in `images/`. Measured 2026-09-05 through the real routes, ENOSPC
    injected at the tally's `os.replace`: bundle 2 files, `.tally.json` `{count: 1,
    bytes: 64}`, `.files.json` 1 entry, `POST /check` reporting the committed file as
    `needed`. The low tally also under-counts every later admission check, until
    finalize's reconciliation recount repairs it (T2-53 constraint (c)); the manifest has
    no such reconciliation. Recording the divergence needs a write on a device that has
    just refused one — `docs/spikes/spike_upload_session_recovery.md` is where that
    mechanism is being decided, and
    `test_a_failed_sidecar_write_leaves_BOTH_CACHES_BEHIND_pending_the_spike` pins what
    is accepted meanwhile."""
    count, nbytes = await run_in_threadpool(
        _apply_tally_delta, upload_dir, d_count, d_bytes
    )
    await run_in_threadpool(_apply_manifest_entries, upload_dir, entries)
    return count, nbytes


def _is_metadata_name(name: str) -> bool:
    """True if `name` is the bundle's canonical metadata file (metadata.csv|.tsv) —
    the flag the files route exposes to distinguish it from an image."""
    return name in {f"metadata{ext}" for ext in _CSV_EXTS}


async def _store_part(
    part: UploadFile, target: Path, budget: _BundleBudget, session_dir: Path
) -> tuple[int, str]:
    """Stream an upload part to `target` in bounded memory, enforcing the per-part
    size cap and `budget` (the whole-bundle byte ceiling and the disk floor, D-27 +
    seam L1) as bytes arrive; reading the whole part into RAM (`part.read()`) would
    let an authenticated client exhaust memory. On overflow, or any failure
    mid-write, the partial file is removed so a rejected part leaves nothing behind.
    Returns `(bytes written, sha256-hex of the stored bytes)` — the tally delta
    (T2-53) and the manifest hash (Seam O2), both computed in this one streaming
    pass (the hash is free: the bytes already flow through here).

    A ZIP part's compressed archive passes an UNCHARGED budget (`charged=False`): D-27
    has never billed those bytes to the bundle, only what comes out of them — but they
    are on the disk while they exist, so the floor check still applies to them.

    The budget is checked ONCE BEFORE THE FILE IS CREATED as well as once per chunk.
    Before the loop, because a part with no body never enters it and so used to consult
    neither the disk floor nor the byte cap at all. Before the CREATE, because that is
    where a full device actually fails: on a real 8 MiB tmpfs the eighth 1 MiB part
    raised `ENOSPC` out of `target.open("wb")` — one line above the check that was meant
    to refuse it — so the refusal path itself crashed (round-2 review, finding 5). The
    pre-loop check costs no syscall: `_BundleBudget.check` spends the reading it was
    built from on its first call.

    This loop does NOT register with `_LiveWriters`. It is a coroutine, so it cannot
    write between another coroutine's check and its write, and holding a floor term
    across `await part.read(...)` charged the whole process for requests that were
    merely parked — see `_LiveWriters`.

    An `ENOSPC`/`EDQUOT` out of the create or the write — the residual case, where the
    floor's projection was wrong — becomes the capacity 413 here rather than in an
    app-wide handler; see `_streaming_capacity_refusal`. Every other errno keeps its
    500 and its traceback."""
    limit = _max_part_bytes()
    written = 0
    hasher = hashlib.sha256()
    try:
        budget.check(written)  # a zero-byte body must still meet the bound
        with target.open("wb") as fh:
            while chunk := await part.read(_PART_CHUNK_BYTES):
                written += len(chunk)
                if written > limit:
                    raise _cap_refusal(
                        cap="MAX_UPLOAD_PART_BYTES",
                        limit=limit,
                        observed=f">{written} bytes in one request",
                        detail=(
                            f"Upload part exceeds the {limit}-byte per-part limit"
                        ),
                        remedy=(
                            "the client should send this part in chunks (Seam A3); "
                            "raise MAX_UPLOAD_PART_BYTES only to spend more server "
                            "memory and disk per request"
                        ),
                    )
                budget.check(written)
                hasher.update(chunk)
                fh.write(chunk)
                # Advance the SESSION activity clock. A whole plain part streams
                # straight into images/{name} (_plain_part_target), and a
                # directory mtime moves when an entry is created or removed, NOT
                # when an existing file grows -- so _session_mtimes froze at the
                # instant the part file appeared and _sweep_stale_sessions
                # rmtree'd sessions mid-transfer. Walking images/ instead would
                # cost one stat per committed file on every GET /api/uploads,
                # i.e. a million per poll at the entry cap; this is one metadata
                # syscall per chunk against the 15-221 us statvfs already in this
                # loop. It allocates nothing, so it is safe on the full device the
                # rest of this function exists to refuse, and it is deliberately
                # NOT swallowed: if the session directory cannot be touched it is
                # gone or read-only, and the next fh.write is about to say so.
                os.utime(session_dir, None)
    except BaseException as exc:
        target.unlink(missing_ok=True)
        refusal = _streaming_capacity_refusal(exc, f"upload part {target.name!r}")
        if refusal is None:
            raise
        raise refusal from exc
    return written, hasher.hexdigest()


def _stale_prefix_conflict(name: str, held: int) -> HTTPException:
    """The 409 a chunk gets when the staged prefix it means to continue is not there —
    raised both by the cheap pre-check in `_ingest_part_chunk` and by the authoritative
    fstat inside `_append_part_chunk`. One message, because to a client they are the
    same event: the prefix is gone or short, and the part restarts at offset 0.
    `held` is DIAGNOSTIC — no route resumes from it (see `_ingest_part_chunk`)."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"Chunk offset does not continue part {name!r} (the server holds "
            f"{held} bytes); restart it at offset 0"
        ),
    )


def _declared_size_path(upload_dir: Path, name: str) -> Path:
    """Where the `part_size` a chunked part declared at offset 0 is kept — one file per
    part basename under `.parts-meta/` (see `_PARTS_META`)."""
    return db.resolve_under(upload_dir / _PARTS_META, name)


def _write_declared_size(upload_dir: Path, name: str, part_size: int) -> None:
    """Record the `part_size` this part is being admitted against. Written at offset 0 —
    the restart, the one declaration every later chunk must match — and adopted at a
    later offset when no record exists (see `_ingest_part_chunk`).

    TEMP-THEN-REPLACE like the other sidecars, not `write_text`. `write_text` truncates
    before it writes, so a concurrent `_read_declared_size` could observe `""`, parse it
    as "no record" — and since a missing record is now ADOPTED rather than refused, a
    torn read would silently accept a different `part_size`. The atomic rename is what
    keeps "absent means the server lost it" true.

    An `OSError` here (ENOSPC, or **EDQUOT** on a per-user quota, where the filesystem
    reports gigabytes free) RAISES — a 500, like every other sidecar write in this
    module. It briefly answered a capacity 413 through an app-wide `OSError` handler;
    that handler is gone because it gave every other router this one's vocabulary
    (`_streaming_capacity_refusal`), and this record is not one of the three streaming
    loops the narrowed conversion covers. What is still NOT accounted for is the record's
    own footprint: it is one inode per in-flight part, `_sidecar_bytes` does not see it
    and `_staged_bytes` does not scan `.parts-meta/`, so it is the same exposure as any
    other file-count cost — [[T2-the-byte-bound-is-blind-to-inode-exhaustion]].

    **The temp name is a FIXED prefix, not the record's, and that is a correctness fix
    rather than a tidy-up.** `mkstemp` emits `prefix + 8 random + suffix`, so a prefix of
    `meta.name` made the temp path `len(name) + 12` — past `NAME_MAX` (255) for any
    basename from 244 bytes up. Measured: 243 -> written, **244 -> `OSError` errno 36
    ENAMETOOLONG**, and the route 500'd. The class of file that hits it is exactly the
    class that must chunk: a whole part over `MAX_UPLOAD_PART_BYTES` is refused 413 with
    *"the client should send this part in chunks"*, and the chunked route then 500'd on the
    same basename the whole-part route stores happily — the 413's own remedy (review of
    PR #304, finding 7). A fixed prefix makes the record's write cost nothing in name
    length, which is what the other two sidecar writers already do (`_TALLY_FILE`,
    `_FILES_FILE` are constants), and leaves the only name-length limit the one every
    path in this module shares: the basename itself, under `NAME_MAX`.
    SYNCHRONOUS — call via `run_in_threadpool`."""
    meta = _declared_size_path(upload_dir, name)
    meta.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(meta.parent), prefix=_PARTS_META_TMP, suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(str(part_size))
        os.replace(tmp_name, meta)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _read_declared_size(upload_dir: Path, name: str) -> int | None:
    """The `part_size` this part declared at offset 0, or None on any doubt — no record,
    unreadable, empty, not an integer.

    **None means "this server cannot say what this part was admitted against", and the
    ONE caller resolves it against `_has_declaration_store`, not against the number the
    client just sent.** The docstring here used to promise that "None is a MISMATCH to
    every caller" while that caller adopted the client's figure, so the file shipped a
    contract no code honoured (review of PR #304, findings 6 and 7). What is true now:
    None is a refusal wherever this session has a declaration store, which is every
    session this build opened; it is adopted only where the store itself is absent, which
    no client can arrange. The three causes collapse into one answer deliberately — an
    empty record left by a crashed `os.replace` (which is not fsynced) and a deleted one
    are indistinguishable to a reader and equally untrustworthy. SYNCHRONOUS."""
    try:
        return int(_declared_size_path(upload_dir, name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _has_declaration_store(upload_dir: Path) -> bool:
    """True once this session HAS a `.parts-meta/` dir — i.e. this build has recorded at
    least one `part_size` here, so a record that is missing went missing.

    This is the mechanism the adopt-on-missing branch needed and did not have. A staged
    prefix and its declaration are written by the same request in a fixed order —
    `_write_declared_size` (which creates this dir) strictly before the first byte is
    appended — so within a session this build served, a prefix implies the dir. The
    client controls neither: it can drive a record's *file* away (see
    `_lost_declaration_conflict`), but nothing it can send removes the directory, and
    `_drop_declared_size` unlinks only the file. SYNCHRONOUS."""
    return (upload_dir / _PARTS_META).is_dir()


def _drop_declared_size(upload_dir: Path, name: str) -> None:
    """Forget a part's declaration — called wherever its staging file is dropped, so the
    two never outlive one another. Never raises."""
    try:
        _declared_size_path(upload_dir, name).unlink(missing_ok=True)
    except (OSError, HTTPException):
        pass


def _discard_staged_part(upload_dir: Path, staged: Path, name: str) -> None:
    """Drop a settled part's staging: its DECLARATION first, then its prefix, in ONE
    threadpool hop.

    Both halves are load-bearing and neither was true before. As two hops there was an
    `await` between them, so a concurrent restart of the same basename that wrote a fresh
    record in the gap had it deleted by the completing request — one of the two ways a
    client could reach the adopt-on-missing branch that `_lost_declaration_conflict` now
    refuses (review of PR #304, finding 6). One hop removes the event-loop gap; the
    ORDER decides which inconsistency survives a thread-level one, and it is chosen so
    the survivor is "a record with no prefix", which `_ingest_part_chunk` answers with the
    correct 409 (`_stale_prefix_conflict`, restart at offset 0), rather than "a prefix
    with no record", which is the shape that used to adopt whatever the next chunk
    declared. `unlink` raises exactly as it did as a bare hop — this is a cleanup, not a
    guard, and swallowing an `OSError` here is a separate decision nobody has taken.
    SYNCHRONOUS — call via `run_in_threadpool`."""
    _drop_declared_size(upload_dir, name)  # never raises
    staged.unlink(missing_ok=True)


def _part_size_conflict(name: str, declared: int, sent: int) -> HTTPException:
    """The 409 for a chunk that declares a DIFFERENT `part_size` than the one its
    staged prefix was admitted against.

    Without this the chunk-0 admission gate is advisory: `part_size` is a Form field
    re-read from every chunk request and was never stored, so a client could declare a
    small part at offset 0, pass every up-front check, and then declare the real (large)
    size on chunk 2, which no gate re-runs for. Reproduced against the shipped code:
    `part_size=8192` at offset 0 -> 200, then `chunk_offset=4096, part_size=2 MiB` ->
    200, staging 2,031,616 bytes against a headroom of 3,145,728 (review of PR #304,
    finding 4). It also made a SHRINKING declaration silently complete a truncated part
    as if it were whole, which is the "no chunk is ever silently stitched" promise in
    `_ingest_part_chunk`'s docstring.

    A 409 rather than a 400 because it is the same event as a stale prefix from the
    client's side — the server and the client disagree about what this part is, and the
    answer is to restart it at offset 0.

    `declared` is an int, never None, and the narrowing is the fix for a message that
    blamed the caller for a server-side loss: a missing record rendered as *"was
    declared as no declared size at offset 0, not 409600; a part's part_size may not
    change between chunks"*, which is neither true nor actionable. A missing record has
    its own refusal (`_lost_declaration_conflict`) and its own narrow adopt case
    (`_ingest_part_chunk`), so this one only ever describes two figures that really do
    disagree."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"Part {name!r} was declared as {declared} bytes at offset 0, not {sent}; "
            "a part's part_size may not change between chunks — restart it at offset 0"
        ),
    )


def _lost_declaration_conflict(
    upload_dir: Path, name: str, sent: int, held: int
) -> HTTPException:
    """The 409 for a chunk whose part HAS a declaration store but no record in it — the
    server recorded a `part_size` for this session and this part's is gone.

    **The alternative was to believe the number the client just sent, and that committed
    corruption.** Executed against the adopt-on-missing branch this replaces: a 128-byte
    prefix admitted at `part_size=384`, its record removed, next chunk declaring `129` ->
    200, and a 129-byte truncated image committed to `images/`, hashed, and written to
    the manifest as complete — the exact outcome `_part_size_conflict` says it exists to
    prevent, and unrecoverable, because a re-send of the real file under the same
    basename is then a 409 duplicate. The other direction was reproduced too: 8,192
    declared at offset 0, record removed, `41943040` declared at offset 4,096 -> 200,
    record rewritten to 40 MiB, past gates that only ever run at offset 0 (review of
    PR #304, finding 6).

    Adoption survives for the one shape it was added for — a part in flight across the
    first deploy of `.parts-meta/`, which has no store at all (round-2 review, finding
    8) — and `_has_declaration_store` is what tells the two apart. That is a mechanism
    rather than the claim it replaces (*"A client cannot force the absence: only the
    server writes and removes these"*); a client could force it two ways, both now
    closed at the source as well: `_discard_staged_part` no longer leaves an `await`
    between dropping a record and dropping its prefix, and a torn or empty record left by
    the un-fsynced `os.replace` reads as doubt, which lands here rather than in adoption.

    WARNS, because the two parties differ: the client is told to restart the part, which
    it can do unaided, while the fact worth acting on — this server lost a file it wrote —
    is only visible to the operator, and a lost record that recurs is a device, a quota or
    a concurrent-restart bug rather than a client mistake."""
    _logger.warning(
        "upload session %s lost the part_size record for %r: %d bytes staged, %d "
        "declared by this chunk, no record under %s/ -- refusing rather than adopting "
        "the declared figure (a shrinking one completes a TRUNCATED part); the client "
        "restarts this part at offset 0. Recurrence means the record store is losing "
        "files: check the device, the quota, and concurrent restarts of one basename",
        upload_dir.name,
        name,
        held,
        sent,
        _PARTS_META,
    )
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"The server no longer holds the declared part_size for part {name!r} "
            f"(it holds {held} bytes of it); restart it at offset 0"
        ),
    )


async def _append_part_chunk(
    part: UploadFile, target: Path, offset: int, budget: _BundleBudget
) -> int:
    """Append one chunk of a chunked part (Seam A3) to its staging file at `offset`,
    in bounded memory, enforcing the per-request cap and `budget` as bytes arrive —
    the same two checks `_store_part` makes, on the same 1 MiB streaming loop. Returns
    the staged file's NEW total size.

    No hash is computed here, deliberately: a hasher's state cannot be carried across
    requests (`hashlib` objects are not serialisable), and hashing each chunk in
    isolation would produce per-chunk digests that say nothing about the assembled
    file. The part is hashed once, from the assembled bytes, at completion — see
    `_complete_staged_part`.

    On ANY failure the staging file is TRUNCATED BACK to `offset`, so a rejected chunk
    leaves the session exactly as it was before that chunk (the same transactional
    promise D-27 makes one level up for a ZIP part) and the refused bytes stop counting
    against the bundle budget immediately. SYNCHRONOUS file I/O apart from the awaited
    reads; the append itself is a bounded write per chunk.

    **The open and the length check are on ONE file descriptor, and that is a
    correctness requirement, not tidiness.** Choosing the mode from a `target.exists()`
    probe was a TOCTOU with silent data corruption as its failure mode: if a concurrent
    `chunk_offset=0` restart of the same name — or a concurrent `_complete_staged_part`
    cleanup — unlinked the file between the probe and the open, the open created a fresh
    empty file and `truncate(offset)` ZERO-FILLED `offset` bytes under the chunk. Nothing
    downstream could see it: the ordering check had already passed against the size read
    before the call, and the sha256 is taken from the assembled file, so it hashed the
    NUL padding and wrote a confidently wrong manifest entry for an image that then
    finalizes, ingests and bakes. Measured against the pre-fix code, the racy request
    returned 200 with `bytes_received: 128` and a hash that was not the source's.

    `O_CREAT` is therefore set ONLY at `offset == 0` (the restart — the one case that may
    legitimately create), and past that the file must already exist AND already be at
    least `offset` bytes long, verified by `fstat` on the very fd the write goes through,
    where no unlink or truncate can slip in between. Note `O_CREAT` alone would NOT have
    been enough: a file that exists but is SHORT is zero-filled by `truncate(offset)`
    just the same. A missing or short prefix is a 409 telling the client to restart at 0;
    `ftruncate` is then only ever able to SHORTEN, which is the intended
    overwrite-from-offset semantics and never invents a byte.

    The budget is checked once BEFORE THE OPEN as well as once per chunk, so a chunk
    request with no body still meets the bound and an `O_CREAT` on a device with no room
    for a directory entry is a refusal rather than an `ENOSPC` 500 — see `_store_part`,
    same reasoning and the same zero-syscall cost. A residual `ENOSPC`/`EDQUOT` that
    escapes the bound anyway is converted here, exactly as in `_store_part`
    (`_streaming_capacity_refusal`). It also does not register with `_LiveWriters`, for
    the reason given there."""
    limit = _max_part_bytes()
    written = 0
    budget.check(written)  # a zero-byte chunk must still meet the bound
    flags = os.O_RDWR | os.O_CREAT if offset == 0 else os.O_RDWR
    try:
        fd = os.open(target, flags, 0o600)
    except FileNotFoundError:
        raise _stale_prefix_conflict(target.name, 0) from None
    except OSError as exc:
        refusal = _streaming_capacity_refusal(exc, f"staged part {target.name!r}")
        if refusal is None:
            raise
        raise refusal from exc
    try:
        held = os.fstat(fd).st_size
        if offset > 0 and held < offset:
            raise _stale_prefix_conflict(target.name, held)
    except BaseException:
        os.close(fd)
        raise
    try:
        with os.fdopen(fd, "r+b") as fh:
            fh.seek(offset)
            fh.truncate(offset)
            while chunk := await part.read(_PART_CHUNK_BYTES):
                written += len(chunk)
                if written > limit:
                    raise _cap_refusal(
                        cap="MAX_UPLOAD_PART_BYTES",
                        limit=limit,
                        observed=f">{written} bytes in one chunk request",
                        detail=(
                            f"Upload part exceeds the {limit}-byte per-part limit"
                        ),
                        remedy=(
                            "the client should send smaller chunks; raise "
                            "MAX_UPLOAD_PART_BYTES only to spend more server memory "
                            "and disk per request"
                        ),
                    )
                budget.check(written)
                fh.write(chunk)
    except BaseException as exc:
        try:
            os.truncate(target, offset)
        except OSError:
            target.unlink(missing_ok=True)
        refusal = _streaming_capacity_refusal(exc, f"staged part {target.name!r}")
        if refusal is None:
            raise
        raise refusal from exc
    return offset + written


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
            raise _cap_refusal(
                cap="MAX_UPLOAD_PART_BYTES",
                limit=limit,
                observed=f">{size} bytes in one re-sent request",
                detail=f"Upload part exceeds the {limit}-byte per-part limit",
                remedy=(
                    "the client should send this part in chunks (Seam A3); raise "
                    "MAX_UPLOAD_PART_BYTES only to spend more server memory and disk "
                    "per request"
                ),
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
            raise _entry_cap_refusal(
                observed=f"{accepted} accepted archive entries against a remaining "
                f"budget of {entry_budget}"
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
    budget: _BundleBudget,
) -> tuple[int, str]:
    """Stream one accepted entry to its staged target in ≤1 MiB chunks, counting
    cumulative UNCOMPRESSED bytes against the bundle's remaining budget as they
    arrive — `ZipInfo.file_size` is never trusted (D-27) — and hashing the entry's
    bytes in the same pass (Seam O2, free). Returns `(new cumulative total, sha256-hex
    of THIS entry)`; raises 413 on breach (caller removes the staging dir).

    **This loop is the ZIP-bomb guard**, and it is the one place the seam that removed
    the 2 GiB constant had to leave standing. `MAX_UPLOAD_BUNDLE_BYTES` was previously
    the ONLY bound on uncompressed expansion — there is no per-entry size limit
    anywhere, and the entry cap bounds count, not size — so the audit's probe (64 MiB
    out of a 65,346-byte archive, ~1000:1) would otherwise run until the disk filled.
    It does not: `budget` now carries the disk floor and is re-read per chunk, so
    expansion stops when free space would be spent rather than at a constant, and the
    caller's `finally` removes every staged byte.

    Like the two other streaming loops, the budget is consulted once BEFORE THE TARGET
    IS CREATED so a ZERO-BYTE entry still meets it — an archive of ten thousand empty
    files otherwise creates ten thousand files without ever asking the bound anything —
    and so that the create itself is covered: `target.open("wb")` is what raises `ENOSPC`
    on a full device, and it used to run first. What the check still cannot see is the
    entries themselves: `written_so_far` does not advance for an empty entry, so the
    re-read gate in `check` never fires for a run of them and the inodes they consume
    are outside the byte bound entirely
    ([[T2-the-byte-bound-is-blind-to-inode-exhaustion]])."""
    hasher = hashlib.sha256()
    budget.check(written_so_far)  # a zero-byte entry must still meet the bound
    with zf.open(info) as src, target.open("wb") as dst:
        while chunk := src.read(_PART_CHUNK_BYTES):
            written_so_far += len(chunk)
            budget.check(written_so_far)
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
    sha256)` rows the caller folds into `.files.json` (Seam O2) after the tally.

    **The byte budget is taken AFTER the plan, not before it, and that ordering is the
    fix for a shortfall that was measured.** The floor has to reserve the rewrite of
    `.files.json` this extraction will force, and only `_plan_zip` knows how many entries
    that is — one archive can add thousands at once. Taken before, the reservation was of
    the manifest as it stood BEFORE the request: a fresh session with a 15,000-entry
    archive reserved a sidecar term of 0 against a post-extraction manifest of 1,650,000
    bytes.

    **An `ENOSPC` here is a capacity 413, not a 500 — and the errno, not the block, is
    what decides.** An `OSError` from `dst.write` inside `_extract_entry` was the outcome
    that escaped as an unhandled 500, reachable whenever the floor is overshot (measured:
    1-3 500s per 4-way run, low-water free 0 bytes). The first fix caught `OSError`
    around this whole block, which over-reached in both directions: it reported EACCES on
    a read-only mount and a missing archive as "this dataset is too large", and it did
    not cover the merge loop below it at all (round-2 review, findings 4 and 9). Both
    clauses now go through `_streaming_capacity_refusal`, which switches on errno, so a
    non-capacity failure keeps its 500 and its traceback. The `finally` in both callers
    still removes `.extract-tmp/`."""
    # 2/3. Plan from names, then extract accepted entries with streamed caps. The
    # budgets come from the tally, not a fresh `_bundle_files` scan (T2-53); the byte
    # budget also carries the disk floor and is re-read per chunk (seam L1), which is
    # what bounds an archive whose uncompressed size no header can be trusted for.
    entry_budget = _max_entries() - existing_count
    staged_metadata: Path | None = None
    entries: list[tuple[str, int, str]] = []  # (basename, size, sha256) — Seam O2
    try:
        with zipfile.ZipFile(archive_path) as zf:
            images, metadata, ignored, ignored_total = _plan_zip(
                zf, upload_dir, entry_budget
            )
            # The rows this extraction will add to `.files.json`, priced per row. The
            # size is unknown — it is what the extraction is about to measure, and
            # `ZipInfo.file_size` is a header D-27 never trusts — so each row reserves
            # the widest a size term can be (`_manifest_row_bytes`).
            new_entry_bytes = sum(
                _manifest_row_bytes(base) for _info, base in images
            ) + (
                _manifest_row_bytes(f"metadata{metadata[1]}")
                if metadata is not None
                else 0
            )
            budget = _bundle_budget(
                upload_dir,
                spoken_for=existing_bytes,
                new_entry_bytes=new_entry_bytes,
            )
            # `_writers` opens HERE and not around the plan: `_plan_zip` reads the
            # central directory and writes nothing, so counting it inflated every other
            # writer's floor for a phase that could not consume a byte.
            with _writers:
                extracted = 0
                for info, base in images:
                    # resolve_under: filesystem backstop on top of basename-only
                    # placement (zip-slip-proof by construction).
                    target = db.resolve_under(tmp_dir, _IMAGES_SUBDIR, base)
                    before = extracted
                    extracted, sha = _extract_entry(
                        zf, info, target, extracted, budget
                    )
                    entries.append((base, extracted - before, sha))
                if metadata is not None:
                    info, ext = metadata
                    staged_metadata = tmp_dir / f"metadata{ext}"
                    before = extracted
                    extracted, sha = _extract_entry(
                        zf, info, staged_metadata, extracted, budget
                    )
                    entries.append((f"metadata{ext}", extracted - before, sha))
    except OSError as exc:
        # The residual overshoot on the extraction loop — `target.open("wb")` or
        # `dst.write` reporting the device full. Anything else (EACCES on a read-only
        # mount, ENOENT for a staged archive that vanished) keeps its 500 and its
        # traceback: see `_streaming_capacity_refusal`.
        refusal = _streaming_capacity_refusal(exc, "the ZIP extraction staging")
        if refusal is None:
            raise
        raise refusal from exc
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
    #
    # NOT transactional, and it cannot be made so with renames: a failure partway
    # leaves the entries already renamed in while the caller's `finally` rmtrees the
    # rest of the staging, and neither the tally nor the manifest is updated. Adding a
    # directory entry to `images/` genuinely can `ENOSPC` (ext4 htree block allocation),
    # and `iterdir()` can raise too — this sat OUTSIDE the previous `except OSError`
    # entirely, an unhandled 500 on exactly the device the floor was just overshot on
    # (round-2 review, finding 4), so the capacity conversion covers it.
    #
    # WHAT IS GIVEN UP HERE: a partial merge leaves `.tally.json` at its pre-request
    # value while bytes are already in `images/`, so the tally under-counts the bundle
    # and the explicit MAX_UPLOAD_BUNDLE_BYTES cap can be walked past by the next part
    # (round-3 review of PR #304, finding 3). Recording that needs a write on the device
    # that just refused one — `docs/spikes/spike_upload_session_recovery.md`. The
    # finalize reconciliation recount still repairs it before ingest ever sees it.
    try:
        for staged in (tmp_dir / _IMAGES_SUBDIR).iterdir():
            os.replace(staged, upload_dir / _IMAGES_SUBDIR / staged.name)
        if staged_metadata is not None:
            os.replace(staged_metadata, upload_dir / staged_metadata.name)
    except OSError as exc:
        refusal = _streaming_capacity_refusal(exc, "the ZIP merge into the bundle")
        if refusal is None:
            raise
        raise refusal from exc
    added_count = len(images) + (1 if metadata is not None else 0)
    return _format_ignored(ignored, ignored_total), added_count, extracted, entries


async def _prepare_extract_staging(upload_dir: Path) -> Path:
    """Open a clean `.extract-tmp/images/` for one extraction and return the staging
    root. Stale staging from a crashed request is cleared first: staging is
    transactional, never part of the bundle, so clearing it is always safe."""
    tmp_dir = upload_dir / _EXTRACT_TMP
    if tmp_dir.exists():
        await run_in_threadpool(shutil.rmtree, tmp_dir)
    (tmp_dir / _IMAGES_SUBDIR).mkdir(parents=True)
    return tmp_dir


async def _extract_archive_into_bundle(
    archive_path: Path, upload_dir: Path, upload_id: str, tmp_dir: Path
) -> UploadStatus:
    """Steps 2–5 of the D-27 ZIP branch, shared by the whole-part path
    (`_ingest_zip_part`, archive streamed into `.extract-tmp/`) and the Seam A3
    chunked path (`_extract_assembled_archive`, archive assembled in `.parts-tmp/`):
    plan/extract/merge, then fold the delta into the tally and the per-file hashes
    into the manifest. The caller owns `tmp_dir`'s creation AND its removal.

    The blocking work runs OFF the event loop: the tally read (T2-53), extraction+
    merge in `_extract_and_merge_zip`, the tally update and the manifest update all go
    through `run_in_threadpool`. The tally is updated only AFTER the merge commits, so
    a cancel/failure before then leaves it untouched."""
    # Current tally + anything parked in `.parts-tmp/` drives the D-27 budgets (no
    # per-part bundle rescan, T2-53). This archive is NOT in `.parts-tmp/` — the
    # chunked path moves it into `.extract-tmp/` first — so its own bytes are not
    # charged twice against the budget its entries are about to be extracted under.
    existing_count, existing_bytes = await run_in_threadpool(
        _committed_and_staged, upload_dir
    )
    ignored, added_count, added_bytes, entries = await run_in_threadpool(
        _extract_and_merge_zip,
        archive_path,
        upload_dir,
        tmp_dir,
        existing_count,
        existing_bytes,
    )
    # Commit succeeded → fold the delta into the persisted tally (T2-53), then the
    # per-file hashes into the manifest (Seam O2). Both under their own per-upload
    # locks; a failure of either marks the manifest stale (`_record_committed_part`).
    count, nbytes = await _record_committed_part(
        upload_dir, added_count, added_bytes, entries
    )
    return _status_from_tally(upload_dir, upload_id, count, nbytes, ignored=ignored)


async def _ingest_zip_part(
    part: UploadFile, upload_dir: Path, upload_id: str
) -> UploadStatus:
    """The D-27 ZIP branch of upload_part for a WHOLE archive in one request. Stages
    into `.extract-tmp/` (stream archive -> plan -> extract with streaming caps), then
    merges into the bundle with per-file renames ONLY after the whole archive
    validated. Any failure (4xx, 413, I/O) removes `.extract-tmp/` in the finally —
    the session is left exactly as before the part. Returns the resulting
    `UploadStatus` (with the capped `ignored` report).

    Only the archive streaming (`_store_part`, chunked awaits) stays inline; the
    blocking work is dispatched by `_extract_archive_into_bundle`. If a client
    disconnect cancels the request between threadpool hops the finally's cleanup can be
    skipped — that is exactly the stale-staging case `_prepare_extract_staging`
    self-heals, and staging is transactional (never part of the bundle), so correctness
    is unaffected."""
    tmp_dir = await _prepare_extract_staging(upload_dir)
    try:
        # 1. Stream the COMPRESSED archive to staging; the existing per-part cap
        #    applies to these bytes (bundle caps apply to what gets extracted).
        #    `charged=False` keeps D-27's accounting exactly as it was — these bytes
        #    are not billed to the bundle — while still refusing to write them onto a
        #    disk that is about to fill, which no bundle cap ever covered.
        archive_path = tmp_dir / _ARCHIVE_TMP_NAME
        await _store_part(
            part,
            archive_path,
            await run_in_threadpool(_bundle_budget, upload_dir, charged=False),
            upload_dir,
        )
        return await _extract_archive_into_bundle(
            archive_path, upload_dir, upload_id, tmp_dir
        )
    finally:
        await run_in_threadpool(shutil.rmtree, tmp_dir, ignore_errors=True)


async def _extract_assembled_archive(
    archive_path: Path, upload_dir: Path, upload_id: str
) -> UploadStatus:
    """The D-27 ZIP branch for an archive already ASSEMBLED on disk from chunks (Seam
    A3). Identical from step 2 on — the plan/extract/merge that follows never cared how
    the archive bytes arrived, and ZIP headers are no more trusted here than there.

    The assembled archive is MOVED out of `.parts-tmp/` into `.extract-tmp/` first (a
    rename within the session dir). That is not tidying: while it sits in `.parts-tmp/`
    its compressed bytes count as in-flight against the bundle budget, and the entries
    about to be extracted from it are charged against that same budget — so leaving it
    there would bill one archive twice (pinned by
    `test_an_assembled_archive_is_not_billed_twice_against_the_bundle_cap`, which fails
    with a false 413 if the move is reverted). After the move the on-disk STATE is the
    one `_ingest_zip_part` produces — but not the same BOUND, and the difference
    matters: a whole-part archive is capped at MAX_UPLOAD_PART_BYTES, whereas an
    assembled one can reach the whole remaining bundle budget. So peak staging disk is
    bounded ABOVE by `2 * bundle_cap` and that bound is nearly tight for an archive
    whose contents are all extractable (1.987x driven under review; 1.91x measured
    here). MAX_UPLOAD_PART_BYTES does NOT appear in it: it bounds one REQUEST, not the
    assembled total, so the pre-A3 shape `1 + min(max_part_bytes, bundle_cap) /
    bundle_cap` (~1.05x at shipped defaults) describes the WHOLE-PART path only and must
    not be applied here. [[T2-chunked-assembly-roughly-doubles-peak-staging]].

    **It is an upper bound, not the peak, and it is not what admits a part.** `_plan_zip`
    extracts only `_IMAGE_EXTS` entries plus one root-level CSV, so an archive of RAW
    files (`.dng .cr2 .nef .arw .heic .avif` are all outside `_IMAGE_EXTS`) expands by
    almost nothing and its true peak is ~1x — measured 4,195,558 bytes through this route
    for a 4,195,534-byte archive. A gate sized on `2 x` therefore refused real Lightroom
    exports that fit comfortably, with no workaround above MAX_UPLOAD_PART_BYTES where
    chunking is the only route, so it is gone; the live per-chunk re-read during
    extraction is what holds. The shared `finally` removes the staging on every outcome,
    so this is a peak, not a leak."""
    tmp_dir = await _prepare_extract_staging(upload_dir)
    try:
        staged_archive = tmp_dir / _ARCHIVE_TMP_NAME
        await run_in_threadpool(os.replace, archive_path, staged_archive)
        return await _extract_archive_into_bundle(
            staged_archive, upload_dir, upload_id, tmp_dir
        )
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


async def _stored_size_and_hash(upload_dir: Path, target: Path) -> tuple[int, str]:
    """The `(size, sha256)` the server holds for an already-stored bundle file: its
    manifest entry, or a direct re-hash when the manifest lost it (a crash between
    commit and the manifest update) — so a legitimate re-send is never a false 409."""
    manifest = await run_in_threadpool(_load_or_rebuild_manifest, upload_dir)
    stored = manifest.get(target.name)
    if stored is not None:
        return int(stored["size"]), str(stored["sha256"])
    return await run_in_threadpool(_hash_file, target)


def _duplicate_part_conflict(upload_id: str, name: str) -> HTTPException:
    """The 409 a duplicate-name part with DIFFERENT content gets: the existing file
    wins, and a different file needs a new name (or a `/check` pre-flight)."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"Part {name!r} already exists with different content; pre-check with "
            f"POST /api/uploads/{upload_id}/check, or rename it"
        ),
    )


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
    stored_size, stored_sha = await _stored_size_and_hash(upload_dir, target)
    incoming_size, incoming_sha = await _drain_and_hash(part)
    if incoming_size == stored_size and incoming_sha == stored_sha:
        count, nbytes = await run_in_threadpool(_load_or_recount_tally, upload_dir)
        return _status_from_tally(
            upload_dir, upload_id, count, nbytes, already_present=True
        )
    raise _duplicate_part_conflict(upload_id, target.name)


def _plain_part_path(upload_dir: Path, name: str, ext: str) -> Path:
    """Where a non-ZIP part lands, as a PATH only — the canonical `metadata{ext}` for a
    CSV/TSV, else `images/{basename}` (jailed by `db.resolve_under`). Asks nothing about
    what is already there, so a caller that only needs to look (does this name exist,
    how big is it) does not risk the one-metadata-source 409 as a side effect."""
    if ext in _CSV_EXTS:
        return upload_dir / f"metadata{ext}"
    return db.resolve_under(upload_dir, _IMAGES_SUBDIR, name)


def _plain_part_target(upload_dir: Path, name: str, ext: str) -> Path:
    """`_plain_part_path` plus the admission rule: a CSV/TSV arriving when a DIFFERENT
    metadata extension is already present is a 409 — one metadata source per bundle (a
    same-ext re-send falls through to the idempotent-re-send check at the call site)."""
    target = _plain_part_path(upload_dir, name, ext)
    if ext in _CSV_EXTS and not target.is_file() and any(
        (upload_dir / f"metadata{e}").is_file() for e in _CSV_EXTS
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A metadata file was already uploaded for this bundle",
        )
    return target


# ---------------------------------------------------------------------------
# Seam A3: chunked parts — a byte-range append against the SAME session.
# ---------------------------------------------------------------------------


async def _ingest_part_chunk(
    part: UploadFile,
    upload_dir: Path,
    upload_id: str,
    name: str,
    ext: str,
    chunk_offset: int,
    part_size: int,
) -> UploadStatus:
    """Append one chunk of a part being assembled across requests (Seam A3), and
    complete the part when the staged file reaches `part_size`.

    Ordering is EXPLICIT and verified, never assumed: a chunk is accepted only when
    `chunk_offset` equals the staged file's current size, so a reordered, duplicated or
    lost chunk can never be silently stitched into the assembled bytes. `chunk_offset
    == 0` is the restart: any stale prefix is discarded (which also releases its share
    of the bundle budget), so a client that lost track of a part simply starts it again
    — that is the whole resume story for a HALF-uploaded part, and it is deliberate.
    `/check` is name+size, and a half-part has neither a final size nor a hash, so it is
    invisible to resume by construction rather than by omission.

    A mid-part chunk that does not continue the staged prefix is a 409 naming the
    offset the server actually holds. That figure is DIAGNOSTIC — there is no route
    that resumes from it and no client reads it — but a bare "409 conflict" for a
    transport-level desync would be unusable.

    Cap accounting, BYTES: the budget every chunk is written against is the bundle
    ceiling minus the committed tally minus everything already parked in `.parts-tmp/`
    (`_staged_bytes`), so an in-flight part is charged for its bytes from the moment
    they land and an abandoned half-part cannot be used to smuggle disk past the cap.
    The declared `part_size` is used ONLY to refuse early — never to admit — which is
    the same asymmetry D-27 applies to `ZipInfo.file_size`: a client that under-declares
    still meets the streaming check as its bytes arrive.

    Cap accounting, ENTRIES: `MAX_UPLOAD_ENTRIES` counts files placed in the bundle, and
    a chunked part becomes one — nothing requires it to be large, so without this a loop
    of 1-byte "chunked" parts would add files without bound. It is checked TWICE, and
    both are needed. Here, at offset 0, so a doomed part costs one request rather than a
    whole transfer — but only when the part would actually ADD a file: a name the bundle
    already holds resolves to an idempotent re-send or a 409, neither of which is a new
    entry, exactly as the whole-part path diffs a duplicate before reaching its own
    entry check. The BINDING check is at completion (`_complete_staged_part`), because a
    part that starts under the cap can be overtaken by others committing while it is
    still in flight. The chunked ZIP branch is covered by `_plan_zip`'s entry budget
    instead, which is why this early check is skipped for a `.zip`."""
    if part_size <= 0 or chunk_offset < 0 or chunk_offset >= part_size:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Invalid chunk coordinates: require 0 <= chunk_offset < part_size "
                "and part_size > 0"
            ),
        )
    staging_dir = upload_dir / _PARTS_TMP
    staging_dir.mkdir(parents=True, exist_ok=True)
    staged = db.resolve_under(staging_dir, name)

    staged_size = await run_in_threadpool(_file_size_or_zero, staged)
    # Whether this part would ADD a bundle file, which is what the entry cap counts. A
    # name the bundle already holds resolves to an idempotent re-send or a 409 at
    # completion — neither adds a file — so it must not be charged an entry, exactly as
    # the whole-part path diffs a duplicate BEFORE it reaches its entry check. Unknown
    # for a ZIP (its entry count is planned at extraction), so no early charge there.
    adds_an_entry = False
    # The same exemption the BYTE cap needs, for the same reason and with a bound. A
    # re-send of a part the bundle already holds adds no bundle bytes either — the whole
    # part route returns 200 `already_present` for it and never touches the byte budget
    # (it drains to nowhere). Charging the chunked path for it made a blind retry of a
    # large part near the cap a 413 where the whole-part route succeeds.
    #
    # BOUNDED at the stored twin's size, not waived: the re-send's bytes really are
    # written to `.parts-tmp/` while it is in flight (unlike the whole-part drain), so an
    # unconditional exemption would let a client park a bundle's worth of extra disk
    # under a name that already exists. The allowance is exactly what the bundle already
    # holds under that name; a "re-send" larger than its twin is not one, and meets the
    # ordinary budget.
    resend_allowance = 0
    if ext != _ZIP_EXT:
        # Read on EVERY chunk, not only the first: the streaming check inside
        # `_append_part_chunk` runs per request, so an allowance that existed only at
        # offset 0 would still 413 the second chunk of a re-send.
        resend_allowance = await run_in_threadpool(
            _file_size_or_zero, _plain_part_path(upload_dir, name, ext)
        )
    if chunk_offset == 0:
        # Restart: drop any stale prefix BEFORE the budget is read. Two things depend on
        # that order and neither is obvious, so do not move it. It stops the discarded
        # bytes being charged twice — and it is the ONLY way a client gives back the
        # budget an abandoned prefix is holding, because the release then happens even
        # when this fresh attempt is itself refused below. Seam O4's per-part retry and
        # the resume path both restart at offset 0, so that release is automatic in the
        # shipped client; it is not, however, discoverable, and there is no discard route
        # — [[T2-an-abandoned-chunked-prefix-is-charged-with-no]]. Pinned by
        # `test_restarting_an_abandoned_part_RELEASES_its_charged_prefix`.
        # Also fails fast on the classification rules the whole-part path checks up
        # front (a conflicting metadata source).
        await run_in_threadpool(staged.unlink, missing_ok=True)
        staged_size = 0
        if ext != _ZIP_EXT:
            adds_an_entry = not _plain_part_target(upload_dir, name, ext).is_file()
    elif staged_size != chunk_offset:
        raise _stale_prefix_conflict(name, staged_size)
    else:
        # The prefix is the one this chunk means to continue — so the SIZE it was
        # admitted against must be the one this chunk declares. `part_size` is a Form
        # field on every request and used to be re-read from each one with nothing to
        # compare it to, which made the offset-0 gates below advisory: declare something
        # small, pass them, then declare the real size on chunk 2. See
        # `_part_size_conflict`.
        #
        # A MISSING record is two different events and they need two different answers.
        # Round-2 finding 8 is the first: `.parts-meta/` is new in this seam, so every
        # chunked part in flight across its first deploy has a valid prefix and no
        # declaration, and refusing those blamed the caller for a server-side gap. The
        # second is a record that went missing from a session that HAS a store — server
        # loss, a crash, or a client driving one of the two races — and adopting the
        # figure the next chunk happens to send is what committed a truncated part as
        # complete (round-3 finding 6). `_has_declaration_store` separates them by the
        # one fact a client cannot arrange: whether this session ever recorded anything.
        # Checked only on this branch, so the steady path pays no extra stat.
        declared = await run_in_threadpool(_read_declared_size, upload_dir, name)
        if declared is None:
            if await run_in_threadpool(_has_declaration_store, upload_dir):
                raise _lost_declaration_conflict(
                    upload_dir, name, sent=part_size, held=staged_size
                )
            await run_in_threadpool(_write_declared_size, upload_dir, name, part_size)
        elif declared != part_size:
            raise _part_size_conflict(name, declared, part_size)

    committed_count, spoken_for = await run_in_threadpool(
        _committed_and_staged, upload_dir
    )
    # The re-send allowance (above): a part may spend either the bundle's free budget or
    # the room its own stored twin already occupies, whichever is larger. `allowance`
    # applies to the CAP term only — a re-send's bytes really are written to
    # `.parts-tmp/`, so the disk term must still charge them, which is what keeps the
    # exemption inside the measured `2 x bundle` peak.
    #
    # **SAY WHAT THAT COSTS, because it silently disables a property Seam A3 shipped.**
    # With no explicit cap — which is the DEFAULT after seam L1 — there is no cap term,
    # so the allowance is discarded entirely and a re-send is charged like any other
    # part. On a nearly-full device that means an idempotent chunked re-send is refused
    # (413) where the WHOLE-PART re-send of the same bytes succeeds with 200
    # `already_present`: the whole-part path drains the body to nowhere and touches no
    # disk, while the chunked path must stage a second copy before it can hash it. That
    # asymmetry is exactly what A3's allowance existed to remove, and it is back by
    # default.
    #
    # It is not a bug that can be fixed here: the allowance cannot lend space the device
    # does not have, and applying it to the disk term would over-admit into an ENOSPC.
    # The real fix is a way to answer "do you already hold this part?" without staging it
    # (POST /check already does, and Seam O4's client calls it — but a blind retry does
    # not). Pinned as SHIPPED BEHAVIOUR by
    # `test_a_chunked_resend_loses_its_allowance_when_no_cap_is_set` so a future fix
    # fails loudly rather than silently, and filed as
    # [[T2-a-chunked-re-send-is-refused-where-a-whole-part]].
    budget = await run_in_threadpool(
        _bundle_budget,
        upload_dir,
        spoken_for=spoken_for,
        allowance=resend_allowance,
        # The one `.files.json` row this part will add when it completes. `part_size` is
        # the declared final size and is pinned across the part's chunks
        # (`_part_size_conflict`), so the row's size term is exact here.
        new_entry_bytes=_manifest_row_bytes(name, part_size),
    )
    if chunk_offset == 0:
        # The ENTRY cap, checked before a byte is staged — the same "one part = one
        # file, exact up front" rule the whole-part path applies before it consumes a
        # body. This is a cheap early refusal only; the binding check is at completion
        # (`_complete_staged_part`), because parts that started under the cap can be
        # overtaken by others committing while this one is still in flight.
        if adds_an_entry and committed_count + 1 > _max_entries():
            raise _entry_cap_refusal(
                observed=f"{committed_count + 1} files after this chunked part"
            )
        if budget.remaining is not None and part_size > budget.remaining:
            # Declared-size refusal: cheap, and it costs a client nothing but the
            # request it was going to lose anyway. Only ever a REFUSAL — see the
            # docstring. This is also the ONE place a capacity answer can be given
            # BEFORE the bytes move, because `part_size` is the only figure a client
            # declares up front; everywhere else the answer has to wait for the write.
            if resend_allowance > 0 and budget.from_disk:
                # ...and the one place the plain capacity message would be a LIE. The
                # bundle already holds a file under this basename, so "this dataset is
                # too large" is false — the dataset is fine, this particular retry
                # cannot be staged. Tell the operator which case they are looking at;
                # the user-facing text stays a capacity statement, because the reason
                # the retry cannot proceed really is that the device is full.
                #
                # `budget.from_disk` is load-bearing and a first draft omitted it: with
                # an explicit cap set and plenty of disk, the CAP is what refused, and
                # emitting a capacity refusal there reproduced exactly the D2
                # misattribution one branch over — the log claimed
                # "MAX_UPLOAD_BUNDLE_BYTES=16 set but NOT the binding term" when it was
                # precisely the binding term. Caught by Seam A3's own
                # `test_the_resend_byte_allowance_is_bounded_by_the_stored_twin`, which
                # asserts the cap 413 still names the cap.
                raise budget.declared_refusal(
                    part_size,
                    note=(
                        f" -- NOTE: a chunked RE-SEND of {name!r}, which the bundle "
                        f"already holds at {resend_allowance} bytes; the whole-part "
                        "route would have answered 200 already_present without "
                        "touching the disk"
                    ),
                )
            raise budget.declared_refusal(part_size)
        # There is deliberately NO second, archive-specific admission gate here. One
        # stood at this line charging `2 x part_size` — the whole archive, twice — on the
        # reasoning that a chunked `.zip` is assembled in `.parts-tmp/`, moved to
        # `.extract-tmp/` and extracted beside itself. Both halves of that were wrong.
        # It was REDUNDANT (the declared-size refusal above already refuses a part that
        # does not fit, and for the disk branch `remaining == headroom`, so `part_size >
        # headroom` can never reach here), and it OVER-CHARGED: `_plan_zip` extracts only
        # `_IMAGE_EXTS` entries plus one root-level CSV, and the archive itself is
        # `os.replace`d rather than copied, so the real peak for a mostly-non-extractable
        # archive is ~1x. Measured on one 4,195,534-byte STORED zip (1 KiB `pic.png` + 4
        # MiB `notes.bin`): true peak through this route 4,195,558 bytes against
        # 8,391,068 demanded, and the chunked route refused at every headroom below
        # 2.01x while the whole-part route accepted the identical archive. `_IMAGE_EXTS`
        # excludes every RAW format (.dng .cr2 .nef .arw .heic .avif), so a Lightroom
        # export was exactly the over-stating shape — and above MAX_UPLOAD_PART_BYTES
        # the chunked route is the only route, so there was no workaround. What actually
        # bounds an archive is the general mechanism: `_extract_and_merge_zip` takes a
        # FRESH budget once the archive is on disk and re-reads free space per chunk, so
        # expansion stops at the floor rather than at a predicted multiple.
        #
        # Admitted: PIN the declared size, so every later chunk of this part is measured
        # against the figure the gates above were applied to and cannot substitute
        # another (`_part_size_conflict`). Written after the refusals so a refused part
        # leaves no record behind, and before any byte is staged so no prefix can exist
        # without one.
        await run_in_threadpool(_write_declared_size, upload_dir, name, part_size)
    # `budget` already accounts for this part's own staged prefix (it is part of
    # `spoken_for`, and its bytes are already off the disk's free figure), so it is the
    # budget for the chunk's NEW bytes.
    staged_size = await _append_part_chunk(part, staged, chunk_offset, budget)
    if staged_size > part_size:
        # More bytes than declared: the part can never complete cleanly, so refuse it
        # and drop the staging rather than leave an un-completable file charged to the
        # budget. The declaration goes with it — the two never outlive one another, and
        # `_discard_staged_part` is what keeps that atomic enough to matter.
        await run_in_threadpool(_discard_staged_part, upload_dir, staged, name)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Part {name!r} received {staged_size} bytes, more than the declared "
                f"part_size of {part_size}"
            ),
        )
    if staged_size < part_size:
        # Still in flight: acknowledge with the bundle's CURRENT figures. A part is
        # "received" only once it is whole, so nothing here touches the tally.
        count, nbytes = await run_in_threadpool(_load_or_recount_tally, upload_dir)
        return _status_from_tally(upload_dir, upload_id, count, nbytes)
    return await _complete_staged_part(upload_dir, upload_id, staged, name, ext)


def _file_size_or_zero(path: Path) -> int:
    """`path`'s size, or 0 when it does not exist — the staged-prefix probe. Never
    raises for a missing file (a first chunk has no staging yet)."""
    try:
        return path.stat().st_size
    except OSError:
        return 0


async def _complete_staged_part(
    upload_dir: Path, upload_id: str, staged: Path, name: str, ext: str
) -> UploadStatus:
    """Route a fully-assembled chunked part into the bundle the way a whole part in one
    request is routed: a `.zip` is extracted (D-27), a CSV/TSV becomes the metadata
    source, anything else is an image keyed by basename — and it is subject to the same
    whole-bundle caps, including the ENTRY cap, which is re-checked here because this is
    the instant the staged file becomes a bundle entry. (An earlier draft said "routed
    exactly as a whole part would have been" while silently omitting that check, which
    is how the entry cap became evadable on this path. The words were the reason it
    survived a read.)

    The sha256 is computed HERE, from the assembled bytes on disk, and that is the
    answer to "how does a chunked part get the hash Seam O2 computes inside the
    streaming loop". A hasher cannot be carried across requests, but more importantly
    this hashes WHAT WILL ACTUALLY BE INGESTED rather than what happened to arrive:
    chunks are retried and restarted, so a hash accumulated over the wire could
    describe bytes that are no longer on disk. The cost is one extra sequential read
    of the completed part, on the threadpool, once — and for a ZIP part the extractor
    re-reads the archive anyway.

    The staging file is removed on EVERY outcome (merged, duplicate, conflict, cap
    breach, corrupt archive), so a session never carries assembled-but-unrouted bytes
    and the bundle budget is released the moment the part settles. Its `part_size`
    declaration goes with it, so a later part reusing the basename declares afresh — in
    ONE threadpool hop and declaration-first, because the gap between the two used to be
    a way for a client to reach the adopt-on-missing branch (`_discard_staged_part`)."""
    try:
        if ext == _ZIP_EXT:
            return await _extract_assembled_archive(staged, upload_dir, upload_id)
        size, sha = await run_in_threadpool(_hash_file, staged)
        target = _plain_part_target(upload_dir, name, ext)
        if target.is_file():
            # Seam O2 idempotent re-send, decided from the assembled bytes instead of a
            # drained body: byte-identical -> 200 no-op; different -> 409, and the
            # stored file is left untouched either way.
            stored_size, stored_sha = await _stored_size_and_hash(upload_dir, target)
            if (size, sha) == (stored_size, stored_sha):
                count, nbytes = await run_in_threadpool(
                    _load_or_recount_tally, upload_dir
                )
                return _status_from_tally(
                    upload_dir, upload_id, count, nbytes, already_present=True
                )
            raise _duplicate_part_conflict(upload_id, name)
        # The BINDING entry-cap check: this is the instant the staged file becomes a
        # bundle entry, and it is the only point at which the count is current. The
        # early refusal in `_ingest_part_chunk` cannot stand in for it — a part that
        # started under the cap can be overtaken by other parts committing during its
        # transfer, and a client is free to open many chunked parts at once. Checked
        # AFTER the duplicate branch above, because an idempotent re-send adds no file.
        # (Placed outside `.tally.lock` for the same reason the whole-part path is: the
        # check-then-delta race is pre-existing and this seam is not fixing it. It is
        # the same CLASS on both paths but measurably WIDER here -- 8 concurrent 1-byte
        # parts at a cap of 2 landed 8 on this path vs a stable 5 on the whole-part one
        # (adversarial review, 6 runs). The reason is structural: a whole part is in
        # `images/` from its first byte and so is visible to a concurrent recount, while
        # a chunked part sits in `.parts-tmp/` -- excluded from `_bundle_files` -- until
        # the final `os.replace`. Do NOT read this as "redundant with the whole-part
        # behaviour" and delete the check; sequentially it is the only thing that binds.)
        committed_count, _ = await run_in_threadpool(_load_or_recount_tally, upload_dir)
        if committed_count + 1 > _max_entries():
            raise _entry_cap_refusal(
                observed=f"{committed_count + 1} files at chunked-part completion"
            )
        await run_in_threadpool(os.replace, staged, target)
        count, nbytes = await _record_committed_part(
            upload_dir, 1, size, [(target.name, size, sha)]
        )
        return _status_from_tally(upload_dir, upload_id, count, nbytes)
    finally:
        await run_in_threadpool(_discard_staged_part, upload_dir, staged, name)


def _max_session_age_seconds() -> int:
    """Stale-session TTL from MAX_UPLOAD_SESSION_AGE_SECONDS (default 7 days)."""
    return _env_int("MAX_UPLOAD_SESSION_AGE_SECONDS", _DEFAULT_MAX_SESSION_AGE_SECONDS)


# The two session-local dirs whose contents are appended IN PLACE across requests: a
# chunked part's staged prefix (`.parts-tmp/{name}`) and a streamed archive
# (`.extract-tmp/.archive.zip`). They are listed here because a directory's mtime moves
# when an entry is CREATED or REMOVED and not when an existing file GROWS — see
# `_session_mtimes`, which is the only reader.
_APPEND_IN_PLACE_DIRS = (_PARTS_TMP, _EXTRACT_TMP)


def _session_mtimes(upload_dir: Path) -> list[float]:
    """Every mtime that says "this session was touched": the session dir, each of its
    immediate children (images/, the tally/manifest/finalized sidecars, the locks, the
    staging dirs), and the FILES inside `.parts-tmp/` and `.extract-tmp/`. Anything that
    cannot be stat-ed is skipped; empty ONLY if nothing can be stat-ed (total doubt) —
    the sweep keeps the session in that case.

    **The rule is "a directory's mtime moves when an entry is created or removed, not
    when an existing file grows", and skipping the second half deleted live uploads.**
    This read a fixed five paths — the session dir, images/, and the three sidecars — on
    the stated reasoning that "the tally and manifest are rewritten on EVERY part, so
    their mtime is the session's true last-activity clock". That is true only of a part
    that COMMITS. A chunked part's bytes land in `.parts-tmp/{name}`, which is a sibling
    of all five: `upload_dir`'s mtime moved once, when `.parts-tmp/` was created, and the
    in-flight branch only READS the tally. Measured on chunks 0 and 1 of a 3-chunk part
    1.124 s apart: `max(mtimes)` advanced by 0.000 s, `GET /api/uploads` reported
    `last_activity` 1.128 s stale while a chunk had landed 0.005 s ago, and
    `_sweep_stale_sessions` — which runs on every `POST /api/uploads` and every
    `GET /api/uploads`, i.e. on the wizard's own polling — `rmtree`d the session
    mid-transfer, after which chunk 2 answered 404 (review of PR #304, finding 2). There
    is no `DELETE` route and no resume-from-offset, so the assembled prefix was simply
    gone, and seam L1 is what makes a long single-part transfer plausible: it removed the
    2 GiB bundle ceiling.

    Bounded by what is IN FLIGHT, never by the bundle: one `stat` of the session dir, one
    `scandir` + one `stat` per immediate child (5-8 on a live session), and one `scandir`
    + one `stat` per staged prefix. `images/` is NOT walked per file: at the 1,000,000
    entry cap that would be a million stats on every `GET /api/uploads`, and this sweep
    runs on the wizard's own polling. An earlier draft justified the omission by claiming
    a part "arrives there by `os.replace`, which moves the directory's own mtime" — TRUE
    of a chunked part, and FALSE of a whole one, which `_store_part` streams straight
    into `images/{name}` (`_plain_part_target`). So the growth of one long whole part was
    invisible here, and the sweep could reap a session that was actively receiving it.
    It is now visible from the other end: that streaming loop touches the session dir
    once per chunk, which `note` already stats. Reachable only on two non-default knobs —
    a whole part is capped at 100 MiB and the TTL is 7 days — but both are documented
    operator-tunable, and seam L1 removed the 2 GiB ceiling that used to bound how long
    one part could take. SYNCHRONOUS."""
    mtimes: list[float] = []

    def note(p: Path) -> None:
        try:
            mtimes.append(p.stat().st_mtime)
        except OSError:
            pass  # vanished mid-scan / unreadable — a missing signal, never a wrong one

    def note_children(d: Path) -> None:
        try:
            with os.scandir(d) as entries:
                for entry in entries:
                    try:
                        mtimes.append(entry.stat().st_mtime)
                    except OSError:
                        continue
        except OSError:
            return  # the dir does not exist (the common case) or cannot be listed

    note(upload_dir)
    note_children(upload_dir)
    for staging in _APPEND_IN_PLACE_DIRS:
        note_children(upload_dir / staging)
    return mtimes


def _sweep_stale_sessions(uploads_root: Path, ttl_seconds: int) -> list[Path]:
    """Reap un-finalized upload sessions idle past ``ttl_seconds`` — best-effort and
    conservative, mirroring the O1 staging sweep's shape:

      * a FINALIZED bundle is NEVER swept — it is an ingest source
        (`_latest_finalized_bundle` depends on it; T2-103 revisits retained corpora);
      * the TTL is a FRESHNESS FLOOR — anything whose latest mtime is within the window
        is kept. `_session_mtimes` reads the staged prefixes too, so a chunk that lands
        advances it even though nothing commits; before that it did not, and this
        function deleted parts mid-transfer (review of PR #304, finding 2);
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


# DECLARED BEFORE `GET /api/uploads/{upload_id}`, and must stay there: FastAPI
# matches in declaration order and "caps" is a syntactically valid upload_id, so
# the parameterised route would otherwise shadow this one. No minted id can
# actually collide (they are uuid4 hex), but the ordering is what makes the
# static path reachable at all.
@router.get("/api/uploads/caps", dependencies=[Depends(appstate.get_current_user)])
async def get_upload_caps() -> UploadCaps:
    """The upload ceilings this deployment enforces, so a client pre-flight refuses
    an over-cap selection against THESE limits instead of a compiled-in mirror —
    raising MAX_UPLOAD_PART_BYTES now changes what the browser will accept.

    Read per request through the same `_max_*()` helpers `_store_part`,
    `_plan_zip`, `_extract_entry` and `upload_part` enforce with — never the
    `_DEFAULT_*` constants, or an env override would be enforced but not
    advertised. Session-independent (the caps are server-wide), so this is
    reachable on every path that pre-flights, including a resume that never opens
    a new session. Authenticated like every other route here: this seam does not
    widen who may read the deployment's limits.

    Seam L1 breaks that "advertised == enforced" identity for `max_bundle_bytes`
    ALONE, and it is worth being explicit rather than letting a reader assume it still
    holds: the enforced bundle bound is now live free disk. What is advertised is a
    static UPPER bound on it, so the number here is never lower than what the server
    would accept, and a pre-flight "no" against it stays trustworthy. It does not
    check capacity, deliberately — a check at wizard mount answers a question nobody
    has asked yet and is the most stale by the time it matters.

    `_advertised_max_bundle_bytes` goes through the threadpool because it reads the
    filesystem, and this is the one route where that read is the whole request: measured
    1,816 us of event-loop stall per caps request on the dev stack's bind mount when it
    ran inline. The two env reads beside it are `os.environ` lookups and stay here."""
    return UploadCaps(
        max_part_bytes=_max_part_bytes(),
        max_bundle_bytes=await run_in_threadpool(_advertised_max_bundle_bytes),
        max_entries=_max_entries(),
    )


@router.post("/api/uploads/{upload_id}/parts")
async def upload_part(
    upload_id: str,
    part: UploadFile = File(...),
    chunk_offset: int | None = Form(default=None),
    part_size: int | None = Form(default=None),
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
) -> UploadStatus:
    """Store one part in the session's jail. A `.zip` part is EXTRACTED into the
    bundle (D-27: images flattened by basename, one root-level CSV/TSV as
    metadata, the rest ignored + reported); a `.csv`/`.tsv` part is the (single)
    optional metadata source; everything else is an image keyed by its basename.
    Rejects parts after finalize, a second (different) metadata source, and any
    breach of the whole-bundle caps (413). A duplicate-name plain part is diffed
    (Seam O2 idempotent re-send): byte-identical to the stored file -> 200 with
    `already_present=True`; genuinely different -> 409 pointing at /check.

    Seam A3 — CHUNKED parts: sending `chunk_offset` + `part_size` alongside the part
    makes this request a byte-range APPEND to a part being assembled across several
    requests, rather than a whole part. The two fields are all-or-nothing (one without
    the other is a 400 — a client that half-sends the coordinates would otherwise have
    its chunk stored as a complete file under the same name). Both forms share this one
    route on purpose: the session, the tally, the manifest, the caps, the ZIP branch and
    the duplicate/re-send rules are the substrate either way, and a second API would
    have to reimplement all of it to say the same things. Every response is the same
    `UploadStatus`; while a part is still in flight it reports the bundle's current
    figures, because a part is "received" only once it is whole."""
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

    if (chunk_offset is None) != (part_size is None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "A chunked part requires BOTH chunk_offset and part_size; send "
                "neither for a whole part"
            ),
        )
    if chunk_offset is not None and part_size is not None:
        return await _ingest_part_chunk(
            part, upload_dir, upload_id, name, ext, chunk_offset, part_size
        )

    if ext == _ZIP_EXT:  # D-27: extract, never store the archive itself
        return await _ingest_zip_part(part, upload_dir, upload_id)

    # Resolve the target and classify BEFORE consuming the body, so a duplicate part
    # is diffed (Seam O2 idempotent re-send) rather than streamed to disk only to be
    # discarded. The metadata source is the canonical `metadata{ext}`; a DIFFERENT
    # one already present is a 409 (a same-ext re-send falls through to the
    # idempotent check below).
    target = _plain_part_target(upload_dir, name, ext)

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
    # off the loop — the recount branch of `_load_or_recount_tally` can scan), plus
    # whatever a chunked part has parked in `.parts-tmp/` (Seam A3): those bytes are on
    # disk and inside the bundle's budget, so a whole part cannot spend them again.
    existing_count, existing_bytes = await run_in_threadpool(
        _committed_and_staged, upload_dir
    )
    if existing_count + 1 > _max_entries():
        raise _entry_cap_refusal(
            observed=f"{existing_count + 1} files after this part"
        )
    budget = await run_in_threadpool(
        _bundle_budget,
        upload_dir,
        spoken_for=existing_bytes,
        # The one `.files.json` row this part will add. Its SIZE is what the streaming
        # loop is about to measure, so the row reserves the widest a size can be.
        new_entry_bytes=_manifest_row_bytes(target.name),
    )
    written, sha = await _store_part(part, target, budget, upload_dir)
    # The part is now committed to the bundle → fold its delta into the tally under
    # the per-upload lock (serialised, so a concurrent part cannot lose it, T2-53),
    # then record its size+hash in the manifest (Seam O2, its own per-upload lock).
    count, nbytes = await _record_committed_part(
        upload_dir, 1, written, [(target.name, written, sha)]
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
    reconciled totals are the truth the caps were being tracked against.

    Seam A3: any chunked part still half-assembled in `.parts-tmp/` is DROPPED here,
    before the reconciliation. A half-part is not bundle content — sealing one would
    hand ingest a truncated image — and dropping it is also what makes the
    reconciled figures honest, since the recount only ever sees committed files."""
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
    for transient in (_PARTS_TMP, _PARTS_META):
        await run_in_threadpool(
            shutil.rmtree, upload_dir / transient, ignore_errors=True
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
    MAX_UPLOAD_ENTRIES (1M) files; `limit` is clamped to _MAX_FILES_LIMIT. The
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
    def too_large(observed: object) -> HTTPException:
        return _cap_refusal(
            cap="MAX_UPLOAD_CHECK_BODY_BYTES",
            limit=limit,
            observed=observed,
            detail=f"check request body exceeds the {limit}-byte limit; batch the diff",
            remedy=(
                "raise MAX_UPLOAD_CHECK_BODY_BYTES; note uploadTransport.ts's "
                "UPLOAD_CHECK_BATCH is sized against this cap and _MAX_CHECK_FILES "
                "together ([[T2-lowering-the-check-body-cap-silently-breaks]])"
            ),
        )

    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise too_large(f"{int(declared)} bytes declared by Content-Length")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise too_large(f">{total} bytes streamed (Content-Length absent or low)")
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
        raise _cap_refusal(
            cap="_MAX_CHECK_FILES",
            limit=_MAX_CHECK_FILES,
            observed=f"{len(check.files)} files in one check request",
            detail=(
                f"check accepts at most {_MAX_CHECK_FILES} files per request; "
                "batch the diff"
            ),
            remedy=(
                "the client should batch the diff; this cap is compiled in and not "
                "env-tunable ([[T2-lowering-the-check-body-cap-silently-breaks]])"
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
