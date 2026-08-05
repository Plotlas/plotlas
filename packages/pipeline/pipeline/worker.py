"""The RQ job body (``run_ingest``) that orchestrates a full ingest.

RQ-ignorant: a plain callable resolved by the worker process from the dotted
path the API enqueues (decision D-15). Imports no API code.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import time
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Iterator, Literal, cast

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather
import pyarrow.parquet as pq

from pipeline.ingest import ingest_metadata, write_positions_table, write_tags_sidecar
from pipeline.layout_plugins.base import ColumnRoles, LayoutPlugin, LayoutResult, Role
from pipeline.layout_plugins.categorical import CategoricalLayout
from pipeline.layout_plugins.datetime_layout import DateTimeLayout
from pipeline.layout_plugins.geographic import GeographicLayout
from pipeline.layout_plugins.grid import GridLayout
from pipeline.layout_plugins.scatter import ScatterLayout
from pipeline.manifest import (
    MANIFEST_VERSION,
    append_manifest_layouts,
    revalidate_and_write,
    write_manifest,
)
from pipeline.progress import ProgressReporter

if TYPE_CHECKING:
    # atlas.py / tiler.py pull in pyvips (native, worker-image-only). They must
    # stay out of module import so `pipeline.worker` imports in the lean test image
    # — the architecture-owned smoke test imports it there for the D-15 dotted path.
    # `from __future__ import annotations` keeps the annotations lazy; the heavy
    # bakers are imported inside run_ingest. (ColumnRoles imports lean-safe from
    # base.py — pyvips is only a TYPE_CHECKING import there — so it is imported at
    # module top above for the add-layouts roles-validation path.)
    from pipeline.atlas import ThumbnailCache
    from pipeline.layout_plugins.base import GeographicRoleEntry, ScatterRoleEntry
    from pipeline.tiler import PyramidResult

# v2 spatial tile pyramid params (decision D-33). tile_px is the square tile edge
# (the mini-atlas / mosaic-composite edge); thumb_px is the per-cell mid-tier
# thumbnail resolution, a PER-DATASET BAKE-TIME param from env
# IMAGE_VIZ_TILE_THUMB_PX (default 64). cap = floor(tile_px/thumb_px)^2 is derived.
TILE_PX = 512
_DEFAULT_THUMB_PX = 64
# Detail tier (T2-26, mode=image_ref): the retained originals are transcoded to
# WebP capped at this max edge, VERSION-STAMPED under `detail/v{dataset_version}/`
# (T2-46), and referenced by cell.detail_ref. Version-stamping mirrors the pyramid
# (tiles/{layout}/{layout}_v{version}.pmtiles) and tag sidecar (tags/tags_v{version}
# .arrow) conventions: a re-ingest writes a fresh version dir alongside the old one
# so an in-flight old-manifest reader keeps resolving through the flip window, then
# `_sweep_stale_detail` removes the stale versions AFTER the atomic manifest flip.
_DETAIL_MAX_PX = 2048
_DETAIL_DIR = "detail"
# Internal thumbnail cache (never published): retained in staging until every layout
# is baked (bake_pyramid reads it), then swept with staging (T2-42 per-layout commit).
_THUMB_CACHE_DIR = "_thumb_cache"
_STAGING_TTL_SECONDS = 24 * 3600
# Per-layout POSITION TABLE dir (T2-66 / T2-48, v2.2): positions/{layout_id}_v{version}
# .arrow — the layout's id->(x,y,w,h) rects, for pick-at-any-zoom. Version-stamped so
# a re-ingest writes fresh, immutably-cacheable files; each layout's table MOVES WITH
# its layout's per-layout commit (like tiles/{layout_id}/), so it lands atomically with
# the manifest flip that references it.
_POSITIONS_DIR = "positions"
# Library-card COVER (T2-55): the whole-world overview WebP for a dataset's Library
# card, extracted from the just-committed GRID pyramid's z=0 tile (grid is always
# baked, D-25). Deliberately UNVERSIONED (a tiny card thumbnail needs no immutable
# caching, no manifest field, no schema change): re-ingest atomically REPLACES it,
# and it is NOT `_v{N}`-stamped nor under tiles/tags/positions, so neither
# `_sweep_stale_detail` nor `_sweep_stale_versioned_assets` ever touches it. A
# dataset baked before this simply has no cover (the API 404s, the card falls back).
# CROSS-PACKAGE CONTRACT: the API's cover route reads this exact filename at the dataset
# root (its own `routers.tiles._COVER_NAME`); the packages share no code (one-way
# pipeline→api), so keep the two in sync — the contract test pins cover == grid z0.
_COVER_NAME = "cover.webp"

# Per-job PROGRESS snapshot (Seam O1). Written live to `{staging}/progress.json`
# (the CLI-path sink; the web path uses RQ job.meta), and the TERMINAL snapshot is
# persisted UNVERSIONED at the dataset root beside ingest.log so a completed bake's
# progress record survives the staging sweep. Deliberately NOT `_v{N}`-stamped and
# NOT under tiles/tags/positions/detail, so no version sweep touches it; a re-ingest
# overwrites it (atomic write). Kept OUT of the base commit's merge-move (`_commit`
# skips it, like _thumb_cache) so it is never published half-baked.
_PROGRESS_JSON = "progress.json"

# RQ states meaning a job is IN FLIGHT (mirrors datasets.py / jobs.py, which may not
# import one another — routers rule; the worker re-derives it). Used by the R3
# orphan-staging sweep to protect a live bake's staging dir (even a >24h one) from
# being reclaimed, which a blanket TTL sweep would wrongly do.
_ACTIVE_JOB_STATES = {"queued", "started"}

_PLUGINS: dict[str, type[LayoutPlugin]] = {
    "grid": GridLayout,
    "datetime": DateTimeLayout,
    "categorical": CategoricalLayout,
    "scatter": ScatterLayout,   # user-supplied pre-computed coordinates (D-26)
    "geographic": GeographicLayout,  # real-world lon/lat, projected (D-35 Seam G2)
}


def _thumb_px() -> int:
    """The per-dataset mid-tier thumbnail edge (env IMAGE_VIZ_TILE_THUMB_PX,
    default 64). Recorded in the manifest pyramid descriptor (decision D-33)."""
    raw = os.environ.get("IMAGE_VIZ_TILE_THUMB_PX")
    if raw:
        try:
            value = int(raw)
            if value >= 8:
                return value
        except ValueError:
            pass
        logger_module = logging.getLogger(__name__)
        logger_module.warning("ignoring invalid IMAGE_VIZ_TILE_THUMB_PX=%r; using %d", raw, _DEFAULT_THUMB_PX)
    return _DEFAULT_THUMB_PX


@dataclass(frozen=True)
class IngestJobPayload:
    dataset_id: str
    owner: str                  # recorded on the dataset (decision D-18); from the authenticated identity
    images_dir: Path            # resolved by the API inside the jailed DATA_ROOT/users/{owner}/uploads/{upload_id}/ bundle (decision D-30)
    csv_path: Path | None       # optional metadata source (decision D-25); jailed; None ⇒ images-only
    column_roles: dict | None   # None ⇒ images-only (no metadata to map)
    layout_types: list[str]     # subset of grid/datetime/categorical for Phase 1
    output_root: Path
    # Detail tier opt-out (T2-46) + RETENTION (T2-175). "bake" (default — behaviour
    # unchanged when the field is absent) transcodes every surviving original into the
    # version-stamped detail/ tier; "skip" bakes NO detail tier (no detail/ dir, no
    # per-layout `detail` manifest block, cell detail refs null) — for CI/fixture/
    # fast-iteration bakes and corpora where the originals are not wanted; "retain"
    # transcodes NOTHING and reuses the COMMITTED tier as-is, behind a hard
    # id-integrity guard — for a re-ingest (new geometry, new metadata) over an
    # UNCHANGED image set. The detail transcode is the dominant cost of a real-corpus
    # ingest (measured from rijks_pilot's own ingest.log, 49,048 images, 2026-07-21:
    # 1 h 55 of a 3 h 40 bake, 52 %), so skipping or retaining it is the fast path.
    detail_tier: Literal["bake", "skip", "retain"] = "bake"


@dataclass(frozen=True)
class AddLayoutsJobPayload:
    """Bake ADDITIONAL layouts onto an already-committed dataset without a full
    re-ingest (T2-42; the user-added-layouts prerequisite). The dataset's images,
    metadata.parquet, and detail tier are reused read-only; only the requested new
    per-layout pyramids (+ optionally a fresh tag sidecar) are baked and committed."""

    dataset_id: str
    owner: str                  # recorded on the dataset (decision D-18); from the authenticated identity
    images_dir: Path            # the ORIGINAL source images (must match the committed dataset; not retained in any artifact)
    layout_specs: list[str]     # each: a layout_type ("categorical") OR an expanded layout id ("categorical_kingdom")
    output_root: Path
    column_roles: dict | None = None  # optional roles EXTENSION/override; None ⇒ default to the committed manifest's column_roles


def run_ingest_job(
    dataset_id: str,
    owner: str,
    images_dir: str,
    output_root: str,
    layout_types: list[str],
    csv_path: str | None = None,
    column_roles: dict | None = None,
    detail_tier: str = "bake",
) -> str:
    """Primitive-kwargs entry point for the RQ / enqueue boundary.

    The lean API image carries no pipeline dependency (decision D-15), so it can
    neither import nor construct ``IngestJobPayload``. The API therefore enqueues
    THIS dotted path — ``pipeline.worker.run_ingest_job`` — with JSON-primitive
    kwargs only; this wrapper rebuilds the typed payload and delegates to
    ``run_ingest``. The typed dataclass stays a pipeline-internal detail; ``cli.py``
    and the native end-to-end tests call ``run_ingest(payload)`` directly.

    These parameter names ARE the cross-process contract — pinned by the
    ``tests/smoke`` enqueue drift guard, so a rename here fails CI rather than
    breaking ingest in production. ``csv_path``/``column_roles`` default to None
    (images-only, decision D-25). ``detail_tier`` defaults to ``"bake"`` (T2-46 —
    behaviour unchanged when the enqueuer omits it); ``"skip"`` bakes no detail tier
    and ``"retain"`` reuses the committed one (T2-175). Every OTHER value coerces to
    ``"bake"`` (an unknown mode must not silently skip the originals), but the three
    known modes cross INTACT: coercing ``"retain"`` to ``"bake"`` would hand a caller
    who asked for retention the whole multi-hour transcode without saying so, which is
    the exact failure retention exists to remove.
    """
    payload = IngestJobPayload(
        dataset_id=dataset_id,
        owner=owner,
        images_dir=Path(images_dir),
        csv_path=Path(csv_path) if csv_path is not None else None,
        column_roles=column_roles,
        layout_types=list(layout_types),
        output_root=Path(output_root),
        detail_tier=(
            "skip" if detail_tier == "skip"
            else "retain" if detail_tier == "retain"
            else "bake"
        ),
    )
    return run_ingest(payload)


def run_add_layouts_job(
    dataset_id: str,
    owner: str,
    images_dir: str,
    output_root: str,
    layout_specs: list[str],
    column_roles: dict | None = None,
) -> dict:
    """Primitive-kwargs entry point for the RQ / enqueue boundary (T2-42).

    Mirrors ``run_ingest_job``: the lean API image carries no pipeline dependency
    (decision D-15), so it can neither import nor construct ``AddLayoutsJobPayload``.
    The API would enqueue THIS dotted path — ``pipeline.worker.run_add_layouts_job``
    — with JSON-primitive kwargs only; this wrapper rebuilds the typed payload and
    delegates to ``run_add_layouts``. ``cli.py`` and the native tests call
    ``run_add_layouts(payload)`` directly.

    ``column_roles`` defaults to None (⇒ reuse the committed manifest's roles).
    """
    payload = AddLayoutsJobPayload(
        dataset_id=dataset_id,
        owner=owner,
        images_dir=Path(images_dir),
        layout_specs=list(layout_specs),
        output_root=Path(output_root),
        column_roles=column_roles,
    )
    return run_add_layouts(payload)


def _baked_pyramid_line(pyramid: "PyramidResult") -> str:
    """The tail of the "baked pyramid …" line: how far past "a cell fits one tile" this
    layout ended up, when it went past at all (T2-147). Empty otherwise, so an ordinary
    bake's line is unchanged. The ratio is what the yielded cell-size ceiling costs — a
    cell wider than ~3 tiles cannot be drawn whole by the coarse 3x3 neighbour window —
    and it belongs in the dataset's own record of the bake, not only on the console."""
    widest = max(pyramid.cell_tiles_x, pyramid.cell_tiles_y)
    if widest <= 1.0:
        return ""
    return (
        f"; largest cell spans {pyramid.cell_tiles_x:.2f} x {pyramid.cell_tiles_y:.2f} "
        f"tiles, so the coarse overview draws ~{100.0 * min(1.0, 3.0 / widest):.0f}% of "
        f"its width (T2-147)"
    )


def _log_dropped_cells(
    logger: logging.Logger, layout_id: str, cell_count: int, pyramid: "PyramidResult"
) -> None:
    """Record a bake's in-tile subsampling in THIS DATASET'S ``ingest.log`` (T2-143).

    ``tiler.bake_pyramid`` already warns on its own ``pipeline.tiler`` logger, but the job
    logger ``_setup_logger`` builds is ``pipeline.worker.<staging-dir>`` with
    ``propagate = False`` and a lone FileHandler — so the tiler's record propagates to ROOT
    (stderr on the CLI, the shared worker-container log on the API/RQ path) and never
    reaches this dataset's file. The permanent record of the bake therefore said only
    "baked pyramid X … (z_cap=N)" while a fraction of the cells had not been baked into the
    fine tier. Re-emit it here, where the operator will actually look for it — the tiler
    keeps its own warning for the console/stream half of the same message.

    Worded as a REPORT, not as loss: the ids keep their position-table row (the viewer's
    pile chip still counts them), so under the coincidence / cell-size stops this is
    occlusion and there is nothing to be alarmed by — those go out at INFO. ``z_max_reason``
    is what distinguishes them from the tile-budget stop, where the cells would have
    separated deeper; that one WARNS. The level mapping lives in ``tiler.drop_log_level``
    so this surface and the tiler's can never disagree about how loud the same event is.

    The tiler import is function-level on purpose: ``pipeline.tiler`` pulls in pyvips, which
    the lean test image does not have, and ``pipeline.worker`` must stay importable there.
    By the time this runs a bake has just returned, so the module is already loaded."""
    from pipeline.tiler import DROP_KEEPS_NOTE, describe_drop, drop_log_level

    if pyramid.dropped_total <= 0 or cell_count <= 0:
        return
    logger.log(
        drop_log_level(pyramid.z_max_reason),
        "layout %s: %d of %d cells (%.2f%%) are not baked into the fine tier — the fine "
        "level was chosen by %r and the surplus in each over-cap tile was subsampled to "
        "cap, so %s. " + DROP_KEEPS_NOTE,
        layout_id, pyramid.dropped_total, cell_count,
        100.0 * pyramid.dropped_total / cell_count, pyramid.z_max_reason,
        describe_drop(pyramid.z_max_reason),
    )


def run_ingest(payload: IngestJobPayload) -> str:
    """
    RQ job body. Orchestrates ingest -> decode thumbnails -> layouts -> per-layout
    spatial tile pyramid (PMTiles) -> detail tier -> manifest (decision D-33).

    For each layout the spatial tile baker (tiler.bake_pyramid) writes ONE
    version-stamped PMTiles container at tiles/{layout_id}/{layout_id}_v{version}.pmtiles
    holding the whole pyramid (coarse mosaic composites + the deepest fine
    mini-atlas tiles with per-cell records). There is no shared atlas and no
    per-LOD tile tree in v2.

    The cell ids are made CONTIGUOUS DENSE [0, image_count) before layouts compute
    (decode-failed images consume no id) — the v2 cell_record contract the
    renderer's id-indexed dense buffers depend on. The dense remap re-keys
    metadata.parquet; the tag sidecar, written afterward from that re-keyed
    metadata, inherits the dense ids — so the filename join is preserved.

    PER-LAYOUT COMMIT (T2-42): the layout-independent BASE — metadata.parquet, the
    detail tier, the tag sidecar, and grid's pyramid — commits FIRST, with a manifest
    carrying grid (grid is the guaranteed floor, D-25, so a valid manifest always has
    at least one layout). Each REMAINING layout then bakes and commits on its own —
    its tiles move in + the manifest is atomically flipped with its entry appended
    (reusing the add-layouts flip, ``append_manifest_layouts``). A slow or failing
    layout can no longer hold its committed siblings hostage: the dataset stays live
    and valid with the layouts that landed, and a killed job leaves the base + the
    already-committed layouts on disk. A raised per-layout failure is caught, logged
    per layout, and the run continues to the next requested layout; if any layout
    failed the job re-raises a summary error at the end (so RQ marks it failed and the
    ingest.log tail names the failures) — but only AFTER every requested layout was
    attempted, so an unrelated failure never blocks a good sibling regardless of order.

    Stages all output in a per-job temp dir `.staging-{job_id}` (decision D-19,
    gap #5). Layout-independent work stages there; the base commit merge-moves it into
    /datasets/{ds_id}/ and flips the base manifest atomically (staging is retained for
    the per-layout bakes, then removed on success). All heavy work runs OUTSIDE the
    lock in that staging dir; only the short critical sections — re-validate
    `dataset_version` then commit — run inside a per-`dataset_id` Redis lock (a no-op
    when no broker is configured). No reader ever sees a half-written manifest: every
    flip (base and per-layout) is a complete, schema-valid manifest written atomically.

    Writes a structured log to {output_root}/{ds_id}/ingest.log throughout (staged in
    the job dir, then moved into the dataset by the base commit — the open handle
    follows the moved file, so per-layout progress keeps appending to the live log).
    Returns the dataset version string once the base commits and every requested
    layout is attempted; re-raises on a base-stage failure (nothing committed) or when
    one or more layouts failed after the base landed (dataset live with what landed).

    RE-INGEST / RESUME (T2-42 residual): re-running ingest over an existing dataset is
    a FULL REPLACE at a fresh dataset_version (every layout re-baked) — it does NOT
    resume by skipping already-committed layouts. That contract (version-stamped
    assets + a wholesale manifest rewrite) is deliberately kept intact; the sanctioned
    incremental-add / resume surface is ``run_add_layouts`` (append layouts to a
    committed dataset, with the hard id-integrity guard). Correctness of re-ingest
    beats a partial-run resume here (see the T2-42 ledger row).

    DETAIL TIER (T2-26, T2-46): each surviving original is transcoded into the
    VERSION-STAMPED detail/v{version}/ tier (matching the pyramid/tag version-stamp
    conventions) and referenced per cell. ``payload.detail_tier == "skip"`` bakes NO
    detail tier (no detail/ dir, no per-layout `detail` manifest block, null cell
    detail refs) — the fast path for CI/fixture bakes. On a re-ingest, after the base
    manifest flip, ``_sweep_stale_detail`` removes the superseded detail/v{N}/ dirs so
    re-ingest no longer orphans stale originals; the flip-then-sweep order keeps an
    in-flight old-manifest reader resolving through the window (as tiles are).

    DETAIL RETENTION (T2-175): ``payload.detail_tier == "retain"`` transcodes NOTHING
    and keeps the COMMITTED tier — the new manifest's `detail` block points back at the
    RETAINED ``detail/v{M}/`` while the dataset commits at a fresh ``dataset_version``,
    the same cross-version reference ``run_add_layouts`` already publishes. It is for a
    re-ingest that changes geometry or metadata but NOT the image set, and the image set
    is exactly what the hard id-integrity guard (``_align_cache_to_committed``) proves
    before anything is reused: the committed originals are named by the COMMITTED dense
    id, so a changed corpus would silently re-point every cell at another image's file.
    FAILS CLOSED end to end — no committed dataset, no committed detail tier, or a
    guard rejection all REFUSE the run rather than degrade to a full transcode (see
    ``_committed_manifest_for_retain``), and the pre-check runs before the scan so the
    refusal costs seconds, not a bake. The sweep's ``keep_version`` is then derived from
    the prefix the just-flipped manifest actually names, NOT from ``version``: retaining
    ``detail/v2/`` at ``dataset_version=3`` and sweeping "everything but v3" would
    delete the retained tier moments after publishing a manifest that points at it.
    """
    output_root = Path(payload.output_root)
    images_dir = Path(payload.images_dir)
    csv_path = Path(payload.csv_path) if payload.csv_path is not None else None  # None ⇒ images-only
    dataset_dir = output_root / payload.dataset_id
    job_id = _current_job_id()
    staging = output_root / f".staging-{job_id}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)

    logger, handler = _setup_logger(staging / "ingest.log")
    # Live per-stage progress (Seam O1): RQ job.meta on the web path, progress.json in
    # staging on the CLI path (best-effort — never affects the bake, directive §1.3).
    reporter = ProgressReporter(staging / _PROGRESS_JSON, logger)
    try:
        # R1: log the requested specs (mirror add-layouts' `specs=[...]` form) — during
        # the 1M incident the remaining work of a 24h job was unknowable from its logs.
        logger.info(
            "ingest start dataset=%s owner=%s job=%s specs=%s",
            payload.dataset_id, payload.owner, job_id, payload.layout_types,
        )
        # R3: reclaim orphaned `.staging-{job}` dirs left by dead jobs (best-effort;
        # protects every live bake — sweep_staging was dead code before this seam).
        _sweep_orphan_staging(output_root, job_id, logger)

        # Publish the PLAN immediately — the requested specs are known at entry, and
        # `prepare` is the longest stretch a consumer would otherwise stare at with
        # spec_layouts=[] (the R1 gap, just on the progress channel). image_count is
        # republished below once the scan has measured it (start_job is idempotent).
        reporter.start_job(payload.layout_types, None)

        # Version-stamped paths require the version before heavy work; the commit
        # critical section re-checks it under the lock (optimistic allocation).
        version = _read_current_version(dataset_dir) + 1
        logger.info("allocated dataset_version=%d", version)

        # RETENTION PRE-CHECK (T2-175), BEFORE any heavy work. `--detail-tier retain`
        # reuses the COMMITTED detail tier, so it only means anything over a committed
        # dataset that HAS one — and retention that cannot be honoured must REFUSE, never
        # quietly degrade to a full transcode (an operator who asked for retention and
        # unknowingly got a 9-hour bake has been failed twice). Checking it here, rather
        # than at the detail branch, means the refusal costs a directory read instead of
        # a scan + a multi-hour thumbnail pass. The third way retention can be impossible
        # — the image set changed — needs the decoded corpus and is guarded below.
        retained_manifest = (
            _committed_manifest_for_retain(dataset_dir, payload.dataset_id)
            if payload.detail_tier == "retain"
            else None
        )

        # Lazy import: keeps pyvips out of `pipeline.worker` module import
        # (lean test image) — only needed once ingest actually runs.
        from pipeline.atlas import decode_thumbnails
        from pipeline.tiler import bake_pyramid

        # STAGE prepare (scan + dimension probe + metadata.parquet). The per-image
        # probe loop is the one long serial pass, so it drives `advance` (total =
        # image count, filled on its first tick).
        reporter.start_stage("prepare", "Scan + dimensions + metadata", "images", None)
        ingest_result = ingest_metadata(
            images_dir, payload.dataset_id, staging, csv_path, payload.column_roles,
            on_progress=lambda done, total: reporter.advance("prepare", done, total),
        )
        roles = ingest_result.column_roles
        logger.info("ingested %d image(s) from %s", ingest_result.image_count, images_dir)
        reporter.end_stage("prepare", "done")
        # The corpus size is now measured — republish the job-level fields with
        # image_count filled (the plan itself was published at entry).
        reporter.start_job(payload.layout_types, ingest_result.image_count)

        # STAGE thumbs (decode every image once to a mid-tier thumbnail; ~340/s @1M).
        thumb_px = _thumb_px()
        reporter.start_stage("thumbs", "Thumbnails", "images", len(ingest_result.image_index))
        cache = decode_thumbnails(
            ingest_result.image_index, thumb_px, staging / _THUMB_CACHE_DIR,
            on_progress=lambda done, total: reporter.advance("thumbs", done, total),
        )
        reporter.end_stage("thumbs", "done")
        logger.info("decoded %d thumbnail(s) @ %dpx; skipped=%d", len(cache.ids), thumb_px, len(cache.skipped))
        if not cache.ids:
            # The image set is non-empty (ingest rejects an empty scan), so this
            # means every image failed to decode.
            raise RuntimeError(
                f"no decodable images: all {len(ingest_result.image_index)} scanned "
                f"image(s) failed to decode; nothing to render"
            )

        # CONTIGUOUS DENSE id remap (v2 cell_record contract): surviving (decodable)
        # cells get ids [0, image_count) in ascending original-id order; the thumb
        # cache, metadata.parquet, and the tag sidecar are re-keyed so the filename
        # join is preserved. A no-op when no image was skipped (the common case).
        cache, survivor_paths = _densify_ids(
            cache, ingest_result.image_index, ingest_result.metadata_path
        )
        image_count = len(cache.ids)

        # STAGE tags (one-shot: the D-14 tag sidecar projection).
        reporter.start_stage("tags", "Tag sidecar", None, None)
        tags_path = (
            write_tags_sidecar(
                ingest_result.metadata_path, roles, staging / "tags" / f"tags_v{version}.arrow"
            )
            if roles is not None
            else None
        )
        reporter.end_stage("tags", "done")
        logger.info("tag sidecar: %s", tags_path.name if tags_path else "none (no tag roles)")

        # Detail tier (T2-26, mode=image_ref): transcode each surviving original to
        # a capped WebP under the VERSION-STAMPED detail/v{version}/ (T2-46) and map
        # dense id -> relative ref. OPT-OUT (T2-46): payload.detail_tier == "skip"
        # bakes no detail tier at all (no detail/ dir, no per-layout `detail` manifest
        # block via detail_path_prefix=None below, cell detail refs null) — the fast
        # path for CI/fixture bakes and corpora where originals are not wanted.
        # RETENTION (T2-175): payload.detail_tier == "retain" transcodes nothing and
        # points the new manifest back at the COMMITTED tier, behind the hard
        # id-integrity guard — the fast path for a re-ingest over an unchanged corpus.
        # STAGE detail (per-image transcode of the retained originals — the dominant
        # cost of a real-corpus ingest, ~137/s @1M). Skipped/retained ⇒ the stage
        # completes immediately with no work (total 0), so the stage list is stable
        # across all three modes.
        detail_ref_by_id: dict[int, str] | None
        detail_path_prefix: str | None
        detail_format: str | None
        if payload.detail_tier == "skip":
            reporter.start_stage("detail", "Detail tier", "images", 0)
            reporter.end_stage("detail", "done")
            detail_ref_by_id = None
            detail_path_prefix = None
            detail_format = None
            logger.info("detail tier: skipped (detail_tier=skip)")
        elif payload.detail_tier == "retain":
            # RETAIN (T2-175): reuse the COMMITTED tier — transcode nothing at all.
            # The stage still opens/closes so the stage list is stable across modes;
            # its total is 0 because 0 originals are transcoded (as under skip).
            reporter.start_stage("detail", "Detail tier", "images", 0)
            # THE ID GUARD, FIRST. The committed originals are named by the COMMITTED
            # dense id (`{id}.webp`), so reusing them is safe only if THIS run's dense
            # ids mean the same images. `_align_cache_to_committed` is that guard — the
            # same one add-layouts relies on: it compares the decoded survivors against
            # the committed metadata.parquet's `(id, filename)` and raises, committing
            # nothing, on ANY difference (a missing image, an extra one, or an original
            # that no longer decodes). It is fed the POST-densify index (`survivor_paths`
            # is {dense_id: original path}), so it works in the dense space this run just
            # established; its re-key is then an IDENTITY — ingest assigns ids from a flat
            # scan SORTED BY BASENAME (`ingest._scan_images`) and the guard has just
            # established the two basename sets are equal, and equal sets sort the same
            # way — so the call is here for its GUARD, not for its re-key.
            try:
                cache = _align_cache_to_committed(
                    cache, list(survivor_paths.items()), dataset_dir / "metadata.parquet"
                )
            except ValueError as exc:
                raise ValueError(
                    f"ingest --detail-tier retain: refusing to reuse the committed detail "
                    f"tier of {payload.dataset_id!r} — {exc} Re-run with --detail-tier bake "
                    f"to transcode the changed image set."
                ) from exc
            # Refs against the EXISTING files (never a re-transcode), read off the
            # committed manifest's own `detail` declaration — the same reconstruction
            # add-layouts uses. `retained_manifest` is non-None here by the pre-check.
            detail_ref_by_id, detail_path_prefix, detail_format = _committed_detail_refs(
                cast(dict, retained_manifest), dataset_dir, cache.ids
            )
            if detail_path_prefix is None or not detail_ref_by_id:
                # The tier existed at the pre-check and does not now, or holds no file
                # for any surviving cell. Fail closed rather than commit a tier-less
                # dataset the operator did not ask for.
                raise ValueError(
                    f"ingest --detail-tier retain: the committed detail tier of "
                    f"{payload.dataset_id!r} holds no original for any of the "
                    f"{len(survivor_paths)} surviving cell(s) — nothing to retain. "
                    f"Re-run with --detail-tier bake."
                )
            reporter.end_stage("detail", "done")
            logger.info(
                "detail tier: RETAINED %d of %d original(s) under %s — nothing transcoded "
                "(detail_tier=retain)",
                len(detail_ref_by_id), len(survivor_paths), detail_path_prefix,
            )
            if len(detail_ref_by_id) < len(survivor_paths):
                # A partial tier is a faithful reproduction of the committed one (a bake
                # skips an original that fails to transcode), so it is reported, not
                # refused — but it must never be silent: those cells keep a null
                # detail_ref and their click-through has no original.
                logger.warning(
                    "detail tier: %d of %d surviving cell(s) have NO committed original "
                    "under %s and keep a null detail_ref",
                    len(survivor_paths) - len(detail_ref_by_id), len(survivor_paths),
                    detail_path_prefix,
                )
            retained_version = _detail_prefix_version(detail_path_prefix)
            # Only a VERSION-STAMPED prefix whose version != dataset_version drives the
            # 404: a flat, unversioned `detail/` prefix (retained_version is None) makes
            # the frontend fall through to the un-versioned detail route, which never
            # compares versions — so warning about a 404 there would be a false alarm.
            if retained_version is not None and retained_version != version:
                # MEASURED CONSEQUENCE, recorded in this dataset's own log because it is
                # the operator's only warning: the API's VERSIONED detail route 404s
                # unless the URL's version equals `dataset_version`
                # (api/routers/tiles.py `get_detail_versioned`, pinned by
                # api/tests/test_read_serve.py::test_get_detail_versioned_wrong_version_is_404),
                # and the frontend composes that URL from THIS prefix
                # (api-client/client.ts `detailUrl` -> `detailVersionFromPrefix`). So the
                # click-through lightbox 404s while the renderer's zoom-sharpen overlay
                # (static Caddy path, `staticDetailUrl`) is unaffected. Not introduced
                # here — every committed `add-layouts` run already publishes this shape
                # (test_add_layouts.py: dataset_version 2 with `detail/v1/`).
                logger.warning(
                    "detail tier: manifest detail prefix %s does not match "
                    "dataset_version=%d. The API's versioned detail route validates the "
                    "URL version against dataset_version, so the click-through lightbox "
                    "404s for this dataset until that check resolves through the "
                    "manifest prefix instead; the renderer's static detail overlay is "
                    "unaffected. (Same shape an add-layouts run publishes.)",
                    detail_path_prefix, version,
                )
        else:
            reporter.start_stage("detail", "Detail tier", "images", len(survivor_paths))
            detail_ref_by_id = _bake_detail_tier(
                survivor_paths, staging / _DETAIL_DIR / f"v{version}",
                on_progress=lambda done, total: reporter.advance("detail", done, total),
            )
            reporter.end_stage("detail", "done")
            detail_path_prefix = f"{_DETAIL_DIR}/v{version}/"
            detail_format = "webp"
            logger.info(
                "detail tier: %d original(s) transcoded under %s",
                len(detail_ref_by_id), detail_path_prefix,
            )
        # What `_sweep_stale_detail` must KEEP after the flip (THE hazard of retention):
        # the version the JUST-FLIPPED manifest's detail prefix actually names, never an
        # assumed `version`. bake -> `version` (the prefix is detail/v{version}/, so this
        # is unchanged); retain -> the RETAINED version, or the sweep would delete the
        # tier this run just decided to keep, seconds after publishing a manifest that
        # points at it; skip / a pre-T2-46 flat `detail/` prefix -> None, i.e. keep no
        # version dir, which is what today's `keep_version=version` achieved by the
        # accident that nothing was baked at `version`. Same rule
        # `_sweep_stale_versioned_assets` uses for tiles/tags/positions: the manifest's
        # own asset paths decide what is live.
        detail_keep_version = _detail_prefix_version(detail_path_prefix)

        # NB the internal _thumb_cache is NOT removed here (unlike the old single-commit
        # flow): every layout's bake_pyramid still reads it below, so it lives until the
        # final staging sweep. _commit skips it, so it is never published.

        # The full ordered bake plan: grid (the guaranteed floor, D-25 — always
        # baked, even if not requested) first, then every other requested layout
        # whose required roles are available (others are skipped with a log). Grid
        # anchors the BASE manifest so the base commits with a valid ≥1-layout
        # manifest. The rest commit one at a time after the base. Layouts compute
        # from the re-keyed (dense-id) metadata.parquet.
        meta_table = pq.read_table(ingest_result.metadata_path)
        grid_result, extra_results = _plan_layouts(
            payload.layout_types, roles, meta_table, cache, logger
        )

        # Register every planned layout as a QUEUED stage up front (grid + extras) so a
        # consumer can show the whole bake plan before any tile is cut; each starts
        # RUNNING when its bake begins (in _bake) and fills its tile total from the
        # tiler's first tile (a REAL total, computed before the DFS — NO-FAKE-PROGRESS).
        for planned in [grid_result, *extra_results]:
            reporter.register_stage(
                f"layout:{planned.layout_id}", f"Bake layout: {planned.label}", "tiles", None
            )

        # layout_id -> staged position-table path (T2-66 / T2-48, v2.2), populated by
        # _bake below and threaded into the manifest emitters so each layout entry
        # carries its positions_ref.
        positions_by_id: dict[str, Path] = {}

        def _bake(result: LayoutResult) -> "PyramidResult":
            pmtiles_path = (
                staging / "tiles" / result.layout_id / f"{result.layout_id}_v{version}.pmtiles"
            )
            stage_key = f"layout:{result.layout_id}"
            reporter.start_stage(stage_key)  # RUNNING; label/unit came from register
            # detail_path_prefix is version-stamped (detail/v{version}/) when baked,
            # else None (detail_tier=skip) — then bake_pyramid emits no detail block
            # and writes null cell detail refs (T2-46). detail_format is None when there
            # is no tier, else the tier's format (webp for a fresh bake, the COMMITTED
            # format under retain — so a retained non-webp tier is labelled correctly,
            # matching run_add_layouts rather than assuming webp).
            pyramid = bake_pyramid(
                layout_id=result.layout_id,
                cells_table=result.cells,
                bbox=result.bbox,  # already tuple[float, float, float, float]
                cache=cache,
                output_path=pmtiles_path,
                dataset_version=version,
                tile_px=TILE_PX,
                thumb_px=thumb_px,
                detail_path_prefix=detail_path_prefix,
                detail_format=detail_format,
                detail_ref_by_id=detail_ref_by_id,
                on_tile=lambda done, total: reporter.advance(stage_key, done, total),
            )
            # POSITION TABLE (T2-66 / T2-48, v2.2): the SAME id->(x,y,w,h) rects this
            # layout placed each cell at (taken from result.cells — the identical table
            # the tiler just packed, not re-derived), so the renderer can hit-test a
            # cell at any zoom. Staged beside the pyramid; moved with this layout's flip.
            positions_by_id[result.layout_id] = write_positions_table(
                result.cells,
                image_count,
                staging / _POSITIONS_DIR / f"{result.layout_id}_v{version}.arrow",
            )
            logger.info(
                "baked pyramid %s (%d cells) -> %s (z_cap=%d, levels=%d)%s",
                result.layout_id, result.cells.num_rows, pyramid.path,
                pyramid.z_cap, len(pyramid.levels), _baked_pyramid_line(pyramid),
            )
            _log_dropped_cells(logger, result.layout_id, result.cells.num_rows, pyramid)
            return pyramid

        # --- BASE COMMIT: metadata.parquet + detail tier + tag sidecar + grid ----
        # Bake grid, write a manifest carrying grid only, then merge-move the whole
        # layout-independent base into the dataset and atomically flip the manifest.
        # After this the dataset is LIVE and valid; a slow/failing later layout can
        # no longer hold it (or grid) hostage. Staging is RETAINED for the per-layout
        # bakes below.
        grid_pyramid = _bake(grid_result)
        write_manifest(
            payload.dataset_id, version, [grid_result], {grid_result.layout_id: grid_pyramid},
            roles, image_count, csv_path, staging / "layout_manifest.json", tags_path,
            positions={grid_result.layout_id: positions_by_id[grid_result.layout_id]},
        )
        with _commit_lock(payload.dataset_id):
            committed = _read_current_version(dataset_dir)
            if committed + 1 != version:
                raise RuntimeError(
                    f"dataset_version race for {payload.dataset_id}: staged v{version} but "
                    f"current is v{committed} (concurrent re-ingest; resolved at integration)"
                )
            _commit(staging, dataset_dir, keep_staging=True)
            # SWEEP stale detail versions (T2-46), INSIDE the lock and AFTER the
            # atomic manifest flip: the base manifest now points at the kept prefix
            # (detail/v{version}/ under bake, the RETAINED detail/v{M}/ under retain,
            # or no detail tier at all under skip), so every OTHER detail/v{N}/ is
            # orphaned and removed. Doing it after the flip means an in-flight reader
            # still on the OLD manifest resolved its (old-version) prefix through the
            # flip window, exactly as tiles are lifecycled. `detail_keep_version` is
            # derived from that flipped prefix, NOT from `version` — under retention
            # they differ, and `keep_version=version` would delete the retained tier
            # (T2-175).
            swept = _sweep_stale_detail(dataset_dir, keep_version=detail_keep_version)
            # SWEEP stale version-stamped tiles + tag sidecars (T2-79), same lock/window
            # as the detail sweep. A full re-ingest stamps grid + every extra layout +
            # the tag sidecar at the ONE new `version`, so the just-flipped base manifest
            # references exactly that version's files; every OTHER `_v{N}` pyramid/sidecar
            # merge-moved alongside them is orphaned and removed. Derived from the
            # manifest's actual asset paths (NOT `N != version`), so a mixed-version tree
            # left by a prior add-layouts is pruned correctly to the live version.
            base_manifest_for_sweep = json.loads(
                (dataset_dir / "layout_manifest.json").read_text(encoding="utf-8")
            )
            swept_assets, swept_asset_bytes = _sweep_stale_versioned_assets(
                dataset_dir, base_manifest_for_sweep
            )
        if swept:
            logger.info("swept stale detail version(s): %s", [p.name for p in swept])
        if swept_assets:
            logger.info(
                "swept %d stale version-stamped asset(s) (%d bytes): %s",
                len(swept_assets), swept_asset_bytes, [p.name for p in swept_assets],
            )
        logger.info("committed base dataset_version=%d (layout %s)", version, grid_result.layout_id)
        reporter.end_stage(f"layout:{grid_result.layout_id}", "done")

        # LIBRARY-CARD COVER (T2-55): copy the just-committed grid pyramid's z=0
        # whole-world overview WebP out as the UNVERSIONED cover.webp. Grid is always
        # committed with the base (D-25), so its container is live in dataset_dir now;
        # a re-ingest (full replace) overwrites the cover here atomically. Non-fatal —
        # a cosmetic thumbnail must never fail an otherwise-good ingest. Outside the
        # commit lock: the write is atomic on its own (os.replace) and the cover is not
        # part of the version-flip invariant.
        cover = _write_cover(dataset_dir, grid_pyramid)
        if cover is not None:
            logger.info("wrote library-card cover %s", cover.name)

        # --- PER-LAYOUT COMMIT: each remaining layout, independently ---------------
        # committed_manifest is the base manifest just written (carries grid); each
        # flip appends the extra layouts landed so far (byte-preserving the prior
        # entries) via append_manifest_layouts. roles + tags already live in the base
        # manifest, so no roles_override / tags move here. A raised bake/commit failure
        # is caught, logged, and skipped so a later good layout still lands (order
        # never blocks a sibling); the run re-raises a summary at the end if any failed.
        base_manifest = json.loads(
            (dataset_dir / "layout_manifest.json").read_text(encoding="utf-8")
        )
        committed_ids = [grid_result.layout_id]
        extra_committed: list[str] = []
        results_by_id: dict[str, LayoutResult] = {grid_result.layout_id: grid_result}
        pyramids_by_id: dict[str, "PyramidResult"] = {grid_result.layout_id: grid_pyramid}
        failed: list[str] = []
        failure_reasons: list[str] = []
        for result in extra_results:
            layout_id = result.layout_id
            stage_key = f"layout:{layout_id}"
            try:
                pyramid = _bake(result)
                results_by_id[layout_id] = result
                pyramids_by_id[layout_id] = pyramid
                extra_committed.append(layout_id)
                with _commit_lock(payload.dataset_id):
                    _commit_one_layout(
                        staging, dataset_dir, layout_id,
                        base_manifest, results_by_id, pyramids_by_id,
                        extra_committed, version,
                        None,  # roles already committed with the base manifest
                        None,  # tags already committed with the base
                        move_tags=False,
                        positions_by_id=positions_by_id,
                    )
                committed_ids.append(layout_id)
                reporter.end_stage(stage_key, "done")
                logger.info("committed layout %s (dataset_version=%d)", layout_id, version)
            except Exception as exc:
                extra_committed = [lid for lid in extra_committed if lid != layout_id]
                failed.append(layout_id)
                # Keep the REASON, not just the id: this handler is the only place it
                # exists, and `logger.exception` writes it to ingest.log ONLY — the job
                # logger does not propagate. The summary raise below is what a CLI operator
                # (and RQ) actually sees, and until it carried these lines a bake refused
                # for leaving out most of the dataset reported as a bare
                # "1 layout(s) failed: ['scatter']", with the instruction for what to do
                # about it visible nowhere on the console (T2-143).
                failure_reasons.append(f"{layout_id}: {exc}")
                reporter.end_stage(stage_key, "failed")
                logger.exception(
                    "layout %s failed; the base + already-committed layouts stay live "
                    "(committed=%s). Continuing to the next requested layout.",
                    layout_id, committed_ids,
                )

        if failed:
            # The dataset is LIVE and valid with `committed_ids` (the base + everything
            # that baked). Surface the partial failure so RQ marks the job failed and
            # the ingest.log tail names it; this raise falls through to the outer failure
            # handler, which removes staging (the base already merge-moved into the dataset
            # dir, and re-ingest is a full replace, not a resume, so there is nothing to
            # salvage from staging).
            logger.error(
                "ingest partial: committed=%s failed=%s (dataset_version=%d, live with what landed)",
                committed_ids, failed, version,
            )
            raise RuntimeError(
                f"ingest for {payload.dataset_id!r} committed {committed_ids} but "
                f"{len(failed)} layout(s) failed: {failed}. The dataset is live at "
                f"dataset_version={version} with the layouts that landed; re-bake the "
                f"failed layouts with `pixscope add-layouts` once their cause is fixed."
                + "".join(f"\n  - {reason}" for reason in failure_reasons)
            )
        shutil.rmtree(staging, ignore_errors=True)  # clean success: sweep staging (+ _thumb_cache)
        logger.info("committed dataset_version=%d (layouts=%s)", version, committed_ids)
        return str(version)
    except BaseException:
        # Clean up the staging dir on ANY failure. Nothing here is salvageable — re-ingest
        # is a full REPLACE, not a resume (see the docstring) — and NOTHING ever swept these
        # `.staging-<job_id>` dirs (the only other rmtree is of the CURRENT job's staging at
        # entry, and job-ids are unique), so leaving them leaked forever and the dataset scan
        # surfaced them as phantom datasets. After the base commit the live ingest.log has
        # already moved into the dataset dir (its open handle followed the move), so this
        # never deletes a committed dataset's log; the full traceback is durable in the
        # RQ/worker log via the re-raise below, so nothing is lost.
        logger.exception("ingest failed; removing staging dir %s", staging)
        reporter.mark_failed_running()  # honest terminal snapshot (best-effort)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        # Persist the terminal progress snapshot beside ingest.log so it survives the
        # staging sweep (the live CLI sink was staging/progress.json). Guarded on the
        # dataset dir EXISTING, so a pre-base-commit failure never resurrects it — the
        # base-layout-failure "commits nothing" contract stays intact. Best-effort.
        if dataset_dir.is_dir():
            reporter.persist(dataset_dir / _PROGRESS_JSON)
        _close_logger(logger, handler)


def run_add_layouts(payload: "AddLayoutsJobPayload") -> dict:
    """Bake ADDITIONAL layouts onto an already-committed dataset (T2-42), without a
    full re-ingest. Mirrors ``run_ingest``'s structure (stage in ``.staging-{job_id}``,
    heavy work outside the lock, commit under ``_commit_lock``), but with three
    differences that protect a live dataset:

      * The dataset's ``metadata.parquet``, ``detail/`` tier, and existing pyramids are
        READ-ONLY — never staged, never touched. Layouts compute from the committed
        parquet; new fine records reference the EXISTING committed detail originals.
      * PER-LAYOUT COMMIT with per-layout FAILURE ISOLATION (R4, matching
        ``run_ingest``'s extras loop): each requested layout is baked then committed on
        its own (move its ``tiles/{layout_id}/`` in + atomically flip the manifest with
        its entry appended). A layout's failure is caught, its progress stage marked
        ``failed``, and the run CONTINUES to the next requested layout (order never
        blocks a sibling) — so a middle layout failing still commits the ones after it.
        If ANY layout failed, a summary error is raised at the END (RQ marks the job
        failed and the ingest.log tail names the failures), but only AFTER every layout
        was attempted; the ``.staging-{job_id}`` dir is LEFT for the sweep so a re-run
        with the remaining specs resumes naturally.
      * An ID-INTEGRITY GUARD (hard): the re-decoded survivor dense-id set must EXACTLY
        match the committed parquet's id set, or the run aborts committing NOTHING
        (protects against silent coordinate corruption from a mismatched image dir).

    Preconditions (else a clear error, no side effects): the dataset dir, its
    ``layout_manifest.json``, and its ``metadata.parquet`` all exist. Effective roles
    default to the committed manifest's ``column_roles`` (re-validated); if
    ``payload.column_roles`` is given it REPLACES them (re-validated against the
    existing parquet, not a CSV re-join). Any resolved layout_id already present in
    the committed manifest is a collision error (this tool never overwrites in v1).

    Logs are APPENDED to the dataset's existing ``ingest.log`` (the dataset exists by
    precondition) — the operator's progress view for a multi-hour 1M bake, alongside
    the live O1 progress channel (``job.meta`` / staging ``progress.json``). On full
    success returns ``{"dataset_version", "committed", "failed": []}`` (``committed``
    is the layout_ids that landed, in order); a partial failure RAISES the summary
    error above rather than returning (so ``failed`` in the return is always empty).
    """
    output_root = Path(payload.output_root)
    images_dir = Path(payload.images_dir)
    dataset_dir = output_root / payload.dataset_id
    manifest_path = dataset_dir / "layout_manifest.json"
    metadata_path = dataset_dir / "metadata.parquet"

    # --- Preconditions (before any staging / logging side effect) ---------------
    if not dataset_dir.is_dir():
        raise FileNotFoundError(
            f"add-layouts: dataset {payload.dataset_id!r} not found at {dataset_dir} "
            f"(run an ingest first)"
        )
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"add-layouts: {manifest_path} missing — not a committed dataset"
        )
    if not metadata_path.is_file():
        raise FileNotFoundError(
            f"add-layouts: {metadata_path} missing — cannot compute layouts without it"
        )

    committed_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    roles, roles_overridden = _effective_roles(committed_manifest, payload.column_roles)
    # Value-level re-validation of the effective roles against the READ-ONLY
    # committed parquet (no CSV re-join — metadata.parquet is the frozen source here).
    _validate_roles_against_parquet(roles, metadata_path)

    # Resolve specs -> concrete layout_ids (bare type => all its entries; expanded id
    # => that one), against the effective roles, then collision-guard.
    resolved = _resolve_layout_specs(payload.layout_specs, roles)
    existing_ids = {layout["layout_id"] for layout in committed_manifest.get("layouts", [])}
    _guard_no_collision(resolved, existing_ids)
    if roles_overridden:
        # An override must not silently re-describe a COMMITTED scatter/geographic
        # layout's pair/knobs (never re-baked here → the manifest would contradict the
        # bake). D-35 Seam G2 extends the guard to the geographic family (projection).
        _guard_no_stale_scatter_config(committed_manifest, roles, existing_ids)
        _guard_no_stale_geographic_config(committed_manifest, roles, existing_ids)

    job_id = _current_job_id()
    staging = output_root / f".staging-{job_id}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)

    # Append to the dataset's EXISTING ingest.log (do NOT stage a new log — the
    # dataset is live and the committed log is its history).
    logger, handler = _setup_logger(dataset_dir / "ingest.log")
    # Live per-stage progress (Seam O1), best-effort — RQ job.meta (web) / staging
    # progress.json (CLI); the terminal snapshot is persisted at the dataset root in
    # `finally`. Never affects the bake (directive §1.3).
    reporter = ProgressReporter(staging / _PROGRESS_JSON, logger)
    committed_layout_ids: list[str] = []
    try:
        logger.info(
            "add-layouts start dataset=%s owner=%s job=%s specs=%s",
            payload.dataset_id, payload.owner, job_id, payload.layout_specs,
        )
        # R3: reclaim orphaned staging dirs from dead jobs (best-effort; protects live
        # bakes — see _sweep_orphan_staging).
        _sweep_orphan_staging(output_root, job_id, logger)
        # Publish the plan + corpus size (the committed dense id space every added
        # layout spans); a degenerate manifest without the field just reports null.
        reporter.start_job(
            payload.layout_specs,
            committed_manifest.get("dataset_metadata", {}).get("image_count"),
        )

        version = _read_current_version(dataset_dir) + 1
        logger.info("allocated dataset_version=%d", version)

        from pipeline.atlas import decode_thumbnails
        from pipeline.tiler import bake_pyramid

        # STAGE thumbs — re-decode from the ORIGINAL images (paths are not retained on
        # disk). Same thumb_px the dataset was baked at (committed manifest, else env)
        # so the new tiles are consistent with the existing ones.
        thumb_px = _committed_thumb_px(committed_manifest)
        image_index = _scan_image_index(images_dir)
        reporter.start_stage("thumbs", "Thumbnails", "images", len(image_index))
        cache = decode_thumbnails(
            image_index, thumb_px, staging / "_thumb_cache",
            on_progress=lambda done, total: reporter.advance("thumbs", done, total),
        )
        reporter.end_stage("thumbs", "done")
        logger.info(
            "decoded %d thumbnail(s) @ %dpx; skipped=%d", len(cache.ids), thumb_px, len(cache.skipped)
        )
        # ID-INTEGRITY GUARD (hard) + cache alignment: the re-decoded survivors MUST
        # correspond, BY FILENAME, exactly to the committed metadata.parquet cells
        # (count + membership). On any mismatch this aborts committing NOTHING — a
        # mismatched image dir would otherwise key every new layout's coordinates to a
        # different corpus. On success the thumb cache is re-keyed to the committed
        # DENSE ids (metadata.parquet stays the read-only authority for compute — no
        # densify rewrite here, unlike run_ingest).
        cache = _align_cache_to_committed(cache, image_index, metadata_path)
        logger.info(
            "id-integrity guard passed (%d cells match committed metadata)", len(cache.ids)
        )

        # New fine records reference the EXISTING committed detail originals — the
        # add-layouts run NEVER re-transcodes the detail tier. Build id -> ref from the
        # committed detail block + the files actually present under detail/.
        detail_ref_by_id, detail_prefix, detail_format = _committed_detail_refs(
            committed_manifest, dataset_dir, cache.ids
        )

        # A fresh tag sidecar only when roles were overridden OR none exists for the
        # committed roles (else leave the committed tags refs exactly as they are).
        # Read from the committed (read-only) metadata.parquet.
        tags_path = _stage_tags_sidecar(
            roles, roles_overridden, committed_manifest, dataset_dir,
            metadata_path, staging / "tags" / f"tags_v{version}.arrow",
        )
        if tags_path is not None:
            logger.info("staged fresh tag sidecar: %s", tags_path.name)

        meta_table = pq.read_table(metadata_path)
        # Pre-compute every requested LayoutResult, grouped by plugin family, reusing
        # _expand_layouts' exact naming/collision logic; then bake+commit one at a time.
        want_ids = [layout_id for layout_id, _ in resolved]
        results_by_id = _compute_requested_layouts(want_ids, roles, meta_table, cache)

        # Register every requested layout as a QUEUED stage up front (R4 continues past
        # a failure, so all are planned); each starts RUNNING when its bake begins.
        for wid in want_ids:
            reporter.register_stage(
                f"layout:{wid}", f"Bake layout: {results_by_id[wid].label}", "tiles", None
            )

        # The dense id space [0, image_count) — the committed count (the aligned cache
        # matches it by the id-integrity guard); every ADDED layout's position table
        # spans it. Carried-forward layouts keep their existing positions_ref (v2.2).
        add_image_count = int(committed_manifest["dataset_metadata"]["image_count"])
        pyramids_by_id: dict[str, "PyramidResult"] = {}
        positions_by_id: dict[str, Path] = {}
        first_flip = True
        failed: list[str] = []
        failure_reasons: list[str] = []
        # R4: per-layout FAILURE ISOLATION (mirrors run_ingest's extras loop) — a
        # layout's failure is caught, its stage marked failed, and the run CONTINUES to
        # the next requested layout; a summary is raised at the end if any failed.
        for layout_id in want_ids:
            stage_key = f"layout:{layout_id}"
            result = results_by_id[layout_id]
            try:
                pmtiles_path = (
                    staging / "tiles" / layout_id / f"{layout_id}_v{version}.pmtiles"
                )
                reporter.start_stage(stage_key)  # RUNNING; label/unit from register
                pyramid = bake_pyramid(
                    layout_id=layout_id,
                    cells_table=result.cells,
                    bbox=result.bbox,
                    cache=cache,
                    output_path=pmtiles_path,
                    dataset_version=version,
                    tile_px=TILE_PX,
                    thumb_px=thumb_px,
                    detail_path_prefix=detail_prefix,
                    detail_format=detail_format,
                    detail_ref_by_id=detail_ref_by_id,
                    on_tile=lambda done, total: reporter.advance(stage_key, done, total),
                )
                pyramids_by_id[layout_id] = pyramid
                # POSITION TABLE for this NEW layout (T2-66/T2-48, v2.2): the same
                # id->(x,y,w,h) rects it just placed. Added layouts get a table; the
                # carried-forward layouts keep their committed positions_ref (byte-preserved).
                positions_by_id[layout_id] = write_positions_table(
                    result.cells,
                    add_image_count,
                    staging / _POSITIONS_DIR / f"{layout_id}_v{version}.arrow",
                )
                logger.info(
                    "baked pyramid %s (%d cells) -> %s (z_cap=%d, levels=%d)%s",
                    layout_id, result.cells.num_rows, pyramid.path, pyramid.z_cap,
                    len(pyramid.levels), _baked_pyramid_line(pyramid),
                )
                _log_dropped_cells(logger, layout_id, result.cells.num_rows, pyramid)
                # PER-LAYOUT COMMIT: move this layout's tiles in, then atomically flip the
                # manifest = committed entries (byte-preserved) + the layouts landed so far.
                # The fresh tag sidecar (if any) is MOVED once (first successful flip) but
                # its manifest ref is set on EVERY flip — committed_manifest is never
                # mutated, so a later flip must re-point tags to the fresh sidecar or it
                # would revert. first_flip flips to False only AFTER a successful commit,
                # so a bake failure never strands the tag move onto a not-yet-run layout.
                committed_layout_ids.append(layout_id)
                with _commit_lock(payload.dataset_id):
                    _commit_one_layout(
                        staging, dataset_dir, layout_id,
                        committed_manifest, results_by_id, pyramids_by_id,
                        committed_layout_ids, version,
                        roles if roles_overridden else None,
                        tags_path,
                        move_tags=first_flip,
                        positions_by_id=positions_by_id,
                    )
                first_flip = False
                reporter.end_stage(stage_key, "done")
                logger.info("committed layout %s (dataset_version=%d)", layout_id, version)
            except Exception as exc:
                committed_layout_ids = [lid for lid in committed_layout_ids if lid != layout_id]
                failed.append(layout_id)
                # The reason, not just the id — see run_ingest's twin (T2-143): the job
                # logger does not propagate, so without this the console/RQ summary names
                # the layout and nothing else.
                failure_reasons.append(f"{layout_id}: {exc}")
                reporter.end_stage(stage_key, "failed")
                logger.exception(
                    "layout %s failed; committed=%s stay live. Continuing to the next "
                    "requested layout.", layout_id, committed_layout_ids,
                )

        if failed:
            # The dataset is LIVE and valid with `committed_layout_ids`. Surface the
            # partial failure so RQ marks the job failed and the ingest.log tail names
            # it; this raise falls through to the outer handler, which LEAVES staging
            # for the sweep (unlike run_ingest's full-replace) so a re-run with the
            # remaining spec(s) resumes.
            logger.error(
                "add-layouts partial: committed=%s failed=%s (dataset_version=%d, live)",
                committed_layout_ids, failed, version,
            )
            raise RuntimeError(
                f"add-layouts for {payload.dataset_id!r} committed {committed_layout_ids} "
                f"but {len(failed)} layout(s) failed: {failed}. The dataset is live at "
                f"dataset_version={version} with the layouts that landed; re-run "
                f"`pixscope add-layouts` with the remaining spec(s) once the cause is fixed."
                + "".join(f"\n  - {reason}" for reason in failure_reasons)
            )

        shutil.rmtree(staging / "_thumb_cache", ignore_errors=True)
        shutil.rmtree(staging, ignore_errors=True)
        logger.info(
            "add-layouts done: committed=%s (dataset_version=%d)", committed_layout_ids, version
        )
        return {
            "dataset_version": str(version),
            "committed": list(committed_layout_ids),
            "failed": [],
        }
    except BaseException:
        landed = committed_layout_ids
        remaining = [s for s in payload.layout_specs if s not in landed]
        reporter.mark_failed_running()  # honest terminal snapshot (best-effort)
        logger.exception(
            "add-layouts failed; committed=%s remaining specs=%s; leaving staging %s for sweep",
            landed, remaining, staging,
        )
        raise
    finally:
        # Persist the terminal progress snapshot beside ingest.log (the dataset dir
        # exists for add-layouts by precondition; the is_dir guard mirrors run_ingest's
        # for symmetry + defence should it be removed mid-job). Best-effort; the live
        # CLI sink was staging/progress.json, which the sweep removes.
        if dataset_dir.is_dir():
            reporter.persist(dataset_dir / _PROGRESS_JSON)
        _close_logger(logger, handler)


class RefreshManifestError(RuntimeError):
    """A ``refresh-manifest`` run that REFUSED to proceed — either the manifest is
    already 2.5-enriched (and ``--force`` was not given) or an inconsistency makes
    enrichment UNSAFE (the recompute disagrees with the baked artifacts). Carries a
    human-readable message the CLI prints cleanly (no traceback for the expected refusals)."""


@dataclass(frozen=True)
class _PositionsAtlas:
    """A minimal ``ThumbnailCache`` stand-in for the OFFLINE refresh path. The layout
    plugins read only ``atlas.ids`` (via ``base.packed_ids``), so refresh reconstructs
    the dense id set ``[0, image_count)`` from the committed manifest and NEVER imports
    ``pipeline.atlas`` (which pulls in pyvips — a native dep absent from the lean image).
    Cast to ``ThumbnailCache`` at the ``compute`` call; the two share the id read-surface
    refresh needs, and nothing here decodes an image."""

    ids: list[int]


# A manifest at/above this MINOR already carries the 2.5 enrichment (bbox_exact /
# annotations); refresh refuses to re-derive over it unless --force.
_REFRESH_ENRICHED_MINOR = (2, 5)
# `bbox` in the manifest was emitted as round(compute().bbox, 6); refresh gates the
# recomputed full-precision bbox_exact against it at the SAME 6 dp.
_BBOX_ROUND_DP = 6
# CEILING on |recomputed cell rect - baked float32 rect| for the per-cell reproduction
# gate. It used to be the whole rule, justified as "far BELOW any real layout-geometry
# change (a treemap reorder / axis rescale moves cells by O(0.01–0.5))" — true only while
# every layout spanned the box. A layout is free to draw itself into a sliver of [0,1]²
# (a packed datetime histogram after D-36 H1; a `normalize: none` scatter over one city),
# and then an ABSOLUTE 1e-6 is no longer small relative to anything the layout does.
# Measured: 1,000,000 dated cells (600k on one day + 400k over 1000 days) draw
# 3.3311e-03 wide on a 1.6656e-06 column pitch, so a faithful pre-T2-138-style HALF-COLUMN
# drift of 8.328e-07 PASSES this ceiling — while Gate A is blind by construction, since
# the endpoints are pinned and the bbox is unchanged. refresh-manifest would then accept a
# tree whose geometry disagrees with the current plugin and write derived bbox_exact /
# annotations off it. So the ceiling stays, and `_positions_tol` scales BELOW it with the
# layout's own extent (T2-143).
_POSITIONS_TOL = 1e-6
# The fraction of a layout's own drawn extent (per axis) that a divergence must stay under
# to read as "the same geometry". Sized from the PRODUCER's own bound on how fine a
# layout's structure can get, not from any measured drift: the smallest real geometry
# change a family can make is to move cells by half of its finest feature (one histogram
# column, one categorical band, one grid step), so catching that on a layout with F
# features across its extent needs k <= 1/(2F). datetime caps its columns at
# `_MAX_BUCKETS_HARD` = 2000, a 1M grid is 1000 steps wide, and categorical band counts are
# in the hundreds — k = 1e-4 covers F up to 5000, i.e. every family today with room to
# spare. (A future layout drawing more than 5000 distinct features across its extent would
# need a smaller k; that is the number to revisit, not this comment.)
_POSITIONS_TOL_SPAN_FRACTION = 1e-4
# ...and a FLOOR, so the rule can never demand more precision than float32 can carry. The
# baked position table holds the SAME float32 values `build_spatial_cells` produced, so an
# unchanged plugin reproduces it EXACTLY — measured 0.0 on all four columns of all six
# golden-fixture layouts, not the "~float32 ULP" the old comment assumed. The slack that is
# genuinely needed is for a float64 last-bit difference (a different libm/toolchain)
# tipping a value across a float32 rounding boundary, which moves it by one ULP =
# 2^-24 * |v|. Four of those is the allowance; below ~0.24 % of the box the span term falls
# under it and this takes over, so a hairline layout is never REFUSED for being narrow.
_FLOAT32_RELATIVE_ULP = 2.0 ** -24
_POSITIONS_TOL_ULPS = 4.0


def _positions_tol(span: float, magnitude: float) -> float:
    """The per-axis reproduction tolerance: a fraction of the layout's own ``span`` on that
    axis, floored at a few float32 ULPs of the axis's largest coordinate ``magnitude`` and
    capped at ``_POSITIONS_TOL``. Never LOOSER than the old absolute rule (the cap), and
    tighter exactly where the old rule went blind — on a layout that draws itself narrow."""
    return min(
        _POSITIONS_TOL,
        max(
            _POSITIONS_TOL_SPAN_FRACTION * span,
            _POSITIONS_TOL_ULPS * _FLOAT32_RELATIVE_ULP * magnitude,
        ),
    )


def run_refresh_manifest(
    dataset_id: str,
    output_root: Path,
    force: bool = False,
) -> dict:
    """Enrich an already-baked dataset's ``layout_manifest.json`` IN PLACE with the
    v2.5 annotations (categorical band labels + the datetime axis domain) and the
    per-layout ``bbox_exact``, DERIVED from the committed artifacts — ``metadata.parquet``
    + the baked ``positions/*.arrow`` tables — so a pre-2.5 bake (rijks_pilot, nasa, the
    inat trees) gains labels/axes/exact-binning in MINUTES with NO re-bake. No tiles,
    thumbnails or detail originals are read or written; the pyramids stay byte-for-byte.

    SEMANTIC — the ``dataset_version`` does NOT bump. This is the SAME bake with a richer
    description, not a new one: the version-stamped pyramids/positions/tags are unchanged,
    so re-stamping the version would only invalidate immutable caches for no new bytes.
    Only ``layout_manifest.json`` is rewritten (``manifest_version`` is re-stamped to
    ``manifest.MANIFEST_VERSION`` — named rather than quoted, because refresh writes
    whatever the emitter's current MINOR is, not a fixed literal), a
    ``layout_manifest.json.bak`` is written first, and a line is appended to ``ingest.log``.
    The ``.bak`` is written ONCE — an existing backup is never clobbered, so a ``--force``
    re-run preserves the pristine pre-enrichment copy rather than replacing it with the
    previously-enriched manifest (delete the ``.bak`` to re-arm, e.g. after a re-bake).

    DERIVATION (never a from-scratch placement the emitted values then rest on): each
    layout is RE-RUN through its real plugin ``compute()`` with the committed ids +
    metadata + roles. The region tiling (categorical), the axis domain/range (datetime)
    and the per-cell rects are PURE FUNCTIONS of those inputs, so ``compute()`` reproduces
    exactly what a fresh 2.5 bake emits — ``bbox_exact`` (= the unrounded ``compute().bbox``
    the emitter would write) and ``annotations`` are taken straight off the ``LayoutResult``.
    Deriving ``bbox_exact`` from the baked float32 positions instead would NOT be
    bit-identical (the bake computes ``bbox`` over the raw float64 coords, before the
    float32 store), which is why the recompute is the source of truth and the baked
    positions are the CONSISTENCY ANCHOR:

      * Gate A (every layout): the recomputed ``bbox_exact`` must round (6 dp) to the
        ``bbox`` the manifest already carries — else the recompute disagrees with the
        committed framing (the baked tree predates a layout-geometry change) and refresh
        STOPS rather than emit inconsistent values.
      * Gate B (every layout with a ``positions_ref``): the recomputed per-cell rects must
        reproduce the baked position table to within ``_POSITIONS_TOL``. This ties the
        derived annotations to the ACTUAL baked geometry — a change that preserved the
        bbox but moved cells (Gate A blind) is caught here. Skipped when a layout has no
        position table (a pre-2.2 bake); ``bbox_exact`` then rests on Gate A alone, and
        the skip is SURFACED — in ``ingest.log``, in the returned
        ``positions_gate_skipped`` list, and (via the CLI) on the console — so the
        reduced safety margin is never silent.

    Refuses (``RefreshManifestError``, cleanly) when the manifest is already at
    ``manifest_version`` >= 2.5 WITH the enrichment present, unless ``force`` re-derives
    and overwrites (e.g. after a plugin change). Preconditions (else ``FileNotFoundError``,
    no side effect): the dataset dir + its ``layout_manifest.json`` exist, and
    ``metadata.parquet`` exists when the manifest declares ``column_roles``. Runs OFFLINE
    against the tree — no Redis, no API, no lock (single local writer of the manifest).

    Returns ``{"dataset_id", "manifest_version", "layouts", "annotations", "backup",
    "backup_written", "positions_gate_skipped"}`` (``backup_written`` is False when a
    ``--force`` re-run kept an existing pristine ``.bak`` rather than writing a new one).
    """
    output_root = Path(output_root)
    dataset_dir = output_root / dataset_id
    manifest_path = dataset_dir / "layout_manifest.json"
    metadata_path = dataset_dir / "metadata.parquet"

    # --- Preconditions (before any side effect) --------------------------------
    if not dataset_dir.is_dir():
        raise FileNotFoundError(
            f"refresh-manifest: dataset {dataset_id!r} not found at {dataset_dir} "
            f"(run an ingest first)"
        )
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"refresh-manifest: {manifest_path} missing — not a committed dataset"
        )

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Refuse an already-enriched manifest unless --force (checked BEFORE touching the
    # log — a no-op run leaves ingest.log untouched).
    version_tuple = _parse_manifest_version(manifest.get("manifest_version", ""))
    already_enriched = version_tuple >= _REFRESH_ENRICHED_MINOR and any(
        ("bbox_exact" in layout or "annotations" in layout)
        for layout in manifest.get("layouts", [])
    )
    if already_enriched and not force:
        raise RefreshManifestError(
            f"refresh-manifest: dataset {dataset_id!r} is already at manifest_version "
            f"{manifest.get('manifest_version')!r} carrying the 2.5 enrichment "
            f"(bbox_exact / annotations present) — nothing to do. Re-run with --force to "
            f"re-derive and overwrite (e.g. after a layout-plugin change)."
        )

    roles = _roles_from_manifest(manifest)
    image_count = int(manifest["dataset_metadata"]["image_count"])
    if roles is not None and not metadata_path.is_file():
        raise FileNotFoundError(
            f"refresh-manifest: {metadata_path} missing but the manifest declares "
            f"column_roles — cannot recompute datetime/categorical/scatter/geographic "
            f"layouts without it"
        )
    # metadata.parquet is the join source for the enrichment columns; grid ignores it, so
    # an images-only dataset (no parquet) still recomputes its grid bbox_exact.
    meta = (
        pq.read_table(metadata_path)
        if metadata_path.is_file()
        else pa.table({"id": pa.array(range(image_count), pa.int64())})
    )
    atlas = _PositionsAtlas(ids=list(range(image_count)))

    # Every committed layout must be reproducible from the committed roles under the SAME
    # naming the bake applied (_family_layout_names); a manifest id absent from that
    # enumeration means the roles drifted from the bake, so refresh can't safely derive it.
    manifest_ids = [layout["layout_id"] for layout in manifest["layouts"]]
    producible = {lid for lid, _ in _enumerate_layout_ids(roles)}
    unmappable = [lid for lid in manifest_ids if lid not in producible]
    if unmappable:
        raise RefreshManifestError(
            f"refresh-manifest: cannot reproduce layout(s) {unmappable} from the "
            f"manifest's column_roles — the roles have drifted from the bake, so their "
            f"annotations/bbox_exact cannot be derived safely. Re-ingest instead."
        )

    logger, handler = _setup_logger(dataset_dir / "ingest.log")
    # Bound BEFORE the try so the failure handlers below can report what actually happened
    # on disk rather than assert it (T2-143 review): everything up to `revalidate_and_write`
    # is side-effect-free, but the backup copy is NOT, so "nothing was written" stops being
    # true the moment `backup_created` flips.
    backup_path = dataset_dir / "layout_manifest.json.bak"
    backup_created = False
    manifest_rewritten = False
    try:
        logger.info(
            "refresh-manifest start dataset=%s manifest_version=%s layouts=%s force=%s",
            dataset_id, manifest.get("manifest_version"), manifest_ids, force,
        )
        # Recompute every layout through the REAL plugins (reusing the exact naming +
        # compute path a full ingest uses), keyed by layout_id.
        results_by_id = _compute_requested_layouts(
            manifest_ids, roles, meta, cast("ThumbnailCache", atlas)
        )

        # Build the enriched entries + run the safety gates. NOTHING is written until every
        # layout passes, so a STOP-AND-RAISE leaves the committed manifest untouched.
        enriched: list[dict] = []
        derived_annotations = 0
        positions_gate_skipped: list[str] = []
        # v2.6 (T2-140 / D-36 seam U1): refresh both INTRODUCES and OVERWRITES a
        # user-visible count, so it reports it — same reason `derived_annotations` and
        # `positions_gate_skipped` are surfaced. Only layouts with something unplaced are
        # named; a silent rewrite of "how many of your images this layout could not place"
        # is exactly the class of change the operator has to be able to see.
        missing_by_layout: dict[str, int] = {}
        for layout in manifest["layouts"]:
            result = results_by_id[layout["layout_id"]]
            bbox_exact = [float(v) for v in result.bbox]
            _assert_bbox_consistent(layout, bbox_exact)
            gate_b_ran = _assert_positions_reproduce(
                dataset_dir, layout, result, image_count, logger
            )
            if not gate_b_ran:
                positions_gate_skipped.append(layout["layout_id"])
            enriched.append(
                _enrich_layout_entry(
                    layout, bbox_exact, result.annotations, result.missing_count
                )
            )
            if result.annotations is not None:
                derived_annotations += 1
            if result.missing_count:
                missing_by_layout[layout["layout_id"]] = result.missing_count

        manifest["manifest_version"] = MANIFEST_VERSION
        manifest["layouts"] = enriched

        # Safety copy BEFORE the rewrite — but written ONCE: an existing .bak holds the
        # pristine pre-enrichment manifest, and a --force re-run must not clobber it with
        # the previously-enriched one. (Delete the .bak to re-arm, e.g. after a re-bake.)
        backup_written = not backup_path.exists()
        if backup_written:
            shutil.copyfile(manifest_path, backup_path)
            backup_created = True
        # Re-validate against schemas/v2 + atomically replace, THROUGH manifest.py (its
        # sole-writer boundary) so refresh's bytes match the emitter's exactly.
        revalidate_and_write(manifest, manifest_path)
        manifest_rewritten = True
        logger.info(
            "refresh-manifest done: enriched %d layout(s) -> manifest_version %s "
            "(bbox_exact on all; annotations on %d; unplaced cells %s); "
            "dataset_version %s UNCHANGED; backup=%s; positions gate skipped on %s",
            len(manifest_ids), MANIFEST_VERSION, derived_annotations,
            missing_by_layout or "none",
            manifest.get("dataset_version"), backup_path.name,
            positions_gate_skipped or "none",
        )
        return {
            "dataset_id": dataset_id,
            "manifest_version": MANIFEST_VERSION,
            "layouts": manifest_ids,
            "annotations": derived_annotations,
            # v2.6: {layout_id: count} for every layout with something unplaced (empty when
            # every layout placed everything). The CLI prints it; the caller can diff it
            # against the committed manifest to see what this run changed.
            "missing_counts": missing_by_layout,
            "backup": str(backup_path),
            "backup_written": backup_written,
            "positions_gate_skipped": positions_gate_skipped,
        }
    except RefreshManifestError as exc:
        # A REFUSAL is the expected, load-bearing outcome of the gates — and until now it
        # left the dataset's permanent ingest.log holding a "refresh-manifest start …" line
        # and nothing else, while the reason went only to the console (the Gate-B SKIP path
        # did log its warning here, so the log recorded the weaker event and not the
        # stronger one). Every live dataset carrying a datetime layout will hit this after
        # D-36 H1, once per attempt. Record why, where the operator will look.
        #
        # What was written is DERIVED, not asserted: every RefreshManifestError raise sits
        # above the backup copy today, but a gate added below it would silently make a
        # fixed "nothing was written" false.
        logger.warning(
            "refresh-manifest REFUSED: %s (%s)",
            exc, _refresh_side_effects(backup_created, manifest_rewritten),
        )
        raise
    except BaseException:
        # NOT "nothing was written": a failure inside `revalidate_and_write` happens AFTER
        # the .bak has been copied, and the .bak is deliberately write-once — so a later
        # --force run finds it present and skips creating one. Telling the operator nothing
        # was written would leave them believing their pristine copy does not exist when it
        # does. The .bak is NOT removed here: whenever it exists it holds the manifest as it
        # was before this run touched anything, which is exactly what a backup is for —
        # deleting it on failure would discard the only copy at the moment it is most
        # likely to be wanted.
        logger.exception(
            "refresh-manifest FAILED (%s)",
            _refresh_side_effects(backup_created, manifest_rewritten),
        )
        raise
    finally:
        _close_logger(logger, handler)


def _refresh_side_effects(backup_created: bool, manifest_rewritten: bool) -> str:
    """What a failed/refused ``refresh-manifest`` run actually left on disk, for its
    ingest.log line. The two side effects are ordered as they happen (the ``.bak`` copy,
    then the atomic manifest replace), so any prefix of them is a reachable state."""
    if manifest_rewritten:
        return "layout_manifest.json WAS rewritten"
    if backup_created:
        return "nothing written except layout_manifest.json.bak, which this run created"
    return "nothing was written"


def _parse_manifest_version(raw: str) -> tuple[int, int]:
    """``(major, minor)`` from a ``manifest_version`` string like ``"2.5"`` (a bare
    ``"2"`` reads as ``(2, 0)``); an unparseable value reads as ``(0, 0)`` so the
    already-enriched guard treats it as pre-2.5 and proceeds."""
    parts = str(raw).split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return (0, 0)
    return (major, minor)


def _roles_from_manifest(manifest: dict) -> "ColumnRoles | None":
    """The dataset's roles from the committed manifest's ``column_roles`` (None for an
    images-only dataset — decision D-25), shape-validated via ``ColumnRoles.from_config``."""
    config = manifest.get("column_roles")
    return None if config is None else ColumnRoles.from_config(config)


def _assert_bbox_consistent(layout: dict, bbox_exact: list[float]) -> None:
    """Gate A: the recomputed FULL-PRECISION bbox must round (6 dp) to the ``bbox`` the
    manifest already carries (which the bake emitted as ``round(compute().bbox, 6)``). A
    mismatch means the recompute disagrees with the committed framing — the baked tree
    predates a layout-geometry change — so enrichment is UNSAFE. STOP rather than emit."""
    rounded = [round(v, _BBOX_ROUND_DP) for v in bbox_exact]
    committed = [float(v) for v in layout["bbox"]]
    if rounded != committed:
        raise RefreshManifestError(
            f"refresh-manifest: layout {layout['layout_id']!r} bbox mismatch — recomputed "
            f"{rounded} (6 dp) != committed bbox {committed}. The baked tree predates a "
            f"layout-geometry change; refresh cannot safely derive its bbox_exact/annotations."
        )


def _assert_positions_reproduce(
    dataset_dir: Path,
    layout: dict,
    result: "LayoutResult",
    image_count: int,
    logger: logging.Logger,
) -> bool:
    """Gate B: the recomputed per-cell rects must reproduce the layout's BAKED position
    table (``positions_ref``) to within ``_positions_tol`` — a tolerance derived PER AXIS
    from the recomputed layout's own extent (see the constants above), so a layout that
    draws itself into a sliver of the box is checked at its own scale rather than against
    a fixed 1e-6 that is larger than its whole column pitch. This anchors the derived
    annotations to the ACTUAL baked geometry — a treemap/axis change that preserved the
    bbox (Gate A blind) but moved cells is caught here. Raises on divergence; returns
    whether the gate RAN — False when the layout carries no position table (a pre-2.2
    bake), so the caller can surface the reduced margin (``bbox_exact`` rests on Gate A
    then; the warning below lands only in ingest.log, since the job logger doesn't
    propagate to the console)."""
    ref = layout.get("positions_ref")
    if not ref:
        logger.warning(
            "layout %s has no positions_ref — skipping the per-cell reproduction gate "
            "(bbox_exact rests on the 6dp bbox gate only)", layout["layout_id"]
        )
        return False
    table = feather.read_table(dataset_dir / ref)
    if table.num_rows != image_count:
        raise RefreshManifestError(
            f"refresh-manifest: layout {layout['layout_id']!r} position table has "
            f"{table.num_rows} rows but the manifest declares image_count {image_count}; "
            f"refusing to derive against a misaligned table."
        )
    # The baked table is row-index==id; reorder the recomputed cells to id order to align
    # (the SAME id->row alignment write_positions_table used when it wrote the table). The
    # per-column diff then runs in Arrow's C++ kernels rather than a per-cell Python loop, so
    # Gate B stays cheap on the 1M-cell layouts (inat1m_v2) it must verify.
    cells = result.cells
    ids = [int(v) for v in cells.column("id").to_pylist()]
    row_of = {cid: i for i, cid in enumerate(ids)}
    try:
        order = pa.array([row_of[i] for i in range(image_count)], pa.int64())
    except KeyError:
        # The recompute didn't cover the dense [0, image_count) id space the row-index==id
        # encoding requires (an upstream invariant the dense atlas guarantees) — surface it
        # cleanly rather than as a bare KeyError.
        raise RefreshManifestError(
            f"refresh-manifest: layout {layout['layout_id']!r} recomputed cell ids are not "
            f"the dense range [0,{image_count}); refresh cannot align them to the baked "
            f"position table. Re-ingest instead."
        ) from None
    ordered = cells.take(order)
    # Per-AXIS tolerances off the RECOMPUTED bbox (full precision; Gate A has already
    # forced it to agree with the committed 6-dp bbox). `w`/`h` are checked at their own
    # axis's tolerance: a size and a position on the same axis live in the same coordinate
    # space, and a size drift below the layout's own resolution is invisible for the same
    # reason a position drift is.
    x0, y0, x1, y1 = (float(v) for v in result.bbox)
    tol_by_col = {
        "x": _positions_tol(x1 - x0, max(abs(x0), abs(x1))),
        "w": _positions_tol(x1 - x0, max(abs(x0), abs(x1))),
        "y": _positions_tol(y1 - y0, max(abs(y0), abs(y1))),
        "h": _positions_tol(y1 - y0, max(abs(y0), abs(y1))),
    }
    for col in ("x", "y", "w", "h"):
        # Compare in float64 (the baked column is float32 — promote both) so the delta is
        # measured in the precision the tolerance was chosen against. `worst` is None only
        # for an empty layout (image_count == 0), which trivially reproduces. The
        # attr-defined ignores follow ingest.py: pyarrow.compute funcs are runtime-generated
        # and absent from the stubs.
        delta = pc.subtract(  # type: ignore[attr-defined]
            ordered.column(col).cast(pa.float64()),
            table.column(col).cast(pa.float64()),
        )
        worst = pc.max(pc.abs(delta)).as_py()  # type: ignore[attr-defined]
        tol = tol_by_col[col]
        if worst is not None and worst > tol:
            raise RefreshManifestError(
                f"refresh-manifest: layout {layout['layout_id']!r} recomputed {col} "
                f"positions diverge from the baked position table by {worst:g} "
                f"(> {tol:g}, this layout's own scale — {_POSITIONS_TOL:g} ceiling, "
                f"{_POSITIONS_TOL_SPAN_FRACTION:g} of its drawn extent). The baked tree "
                f"predates a layout-geometry change; refresh is unsafe — re-ingest to "
                f"regenerate its annotations/bbox_exact."
            )
    return True


# The fields manifest._layout_entry emits, in order — refresh rebuilds each enriched entry
# in this exact order so a refreshed entry is byte-indistinguishable from a fresh bake at
# the CURRENT minor. Keep in lock-step with `manifest._layout_entry`: a key missing from
# this set is appended verbatim by the catch-all loop below, i.e. OUT of canonical order.
_LAYOUT_ENTRY_KNOWN = frozenset(
    {"layout_id", "label", "type", "bbox", "bbox_exact", "pyramid",
     "positions_ref", "options", "annotations", "missing_count", "detail"}
)


def _enrich_layout_entry(
    layout: dict, bbox_exact: list[float], annotations: dict | None, missing_count: int
) -> dict:
    """Rebuild a layout entry with ``bbox_exact`` (right after ``bbox``), the v2.6
    ``missing_count`` (after ``annotations``, before ``detail``) and — when the family emits
    them — ``annotations`` (after ``options``) inserted, EVERY other field carried through
    byte-for-byte in the canonical field order ``manifest._layout_entry`` emits, so a
    refreshed entry equals a fresh 2.6 bake's. A pre-existing
    ``bbox_exact``/``annotations``/``missing_count`` (a ``--force`` re-run) is replaced by
    the freshly-derived value. ``missing_count`` is written UNCONDITIONALLY, 0 included, to
    match the emitter — a refreshed entry that recomputes 0 must say 0, not fall back to the
    silence that means "pre-2.6". Any field the emitter doesn't (yet) write — e.g. a future
    ``edges`` — is carried through last so refresh never silently drops data."""
    entry: dict = {
        "layout_id": layout["layout_id"],
        "label": layout["label"],
        "type": layout["type"],
        "bbox": layout["bbox"],
        "bbox_exact": bbox_exact,
        "pyramid": layout["pyramid"],
    }
    if "positions_ref" in layout:
        entry["positions_ref"] = layout["positions_ref"]
    if "options" in layout:
        entry["options"] = layout["options"]
    if annotations is not None:
        entry["annotations"] = annotations
    entry["missing_count"] = missing_count
    if "detail" in layout:
        entry["detail"] = layout["detail"]
    for key, value in layout.items():
        if key not in _LAYOUT_ENTRY_KNOWN:
            entry[key] = value
    return entry


def _make_plugin(layout_type: str) -> LayoutPlugin:
    try:
        return _PLUGINS[layout_type]()
    except KeyError:
        raise ValueError(
            f"unknown layout type {layout_type!r}; Phase 1 supports {sorted(_PLUGINS)}"
        ) from None


def _slug(column: str) -> str:
    """A column name as a layout_id slug: lowercased, with runs of characters
    outside [a-z0-9._-] collapsed to '-' (matches the manifest's layout_id
    pattern ^[A-Za-z0-9._-]+$)."""
    return re.sub(r"[^a-z0-9._-]+", "-", column.lower())


def _family_entries(
    plugin: LayoutPlugin, roles: "ColumnRoles | None"
) -> list[tuple[str, str]] | None:
    """(distinguishing column, label) per role entry for the multi-entry layout
    families — categorical, scatter, and geographic (D-26 / D-35 / recon. #9). None for
    plugins that compute exactly once from no entry list (grid, datetime). The
    distinguishing column is the entry's PRIMARY axis (scatter x / geographic lon), whose
    slug names the expanded layout_id for a multi-entry family."""
    if roles is None:
        return None
    if plugin.name == "categorical":
        return [(e.column, e.label) for e in roles.categorical]
    if plugin.name == "scatter":
        return [(e.x_column, e.label) for e in roles.scatter]
    if plugin.name == "geographic":
        return [(e.lon_column, e.label) for e in roles.geographic]
    return None


def _family_layout_names(
    plugin: LayoutPlugin, roles: "ColumnRoles | None"
) -> list[tuple[int, str, str]] | None:
    """The (entry_index, layout_id, label) per role entry for a multi-entry family,
    applying the naming convention PURELY (no compute): a SINGLE entry keeps the bare
    plugin name as layout_id (back-compat — existing datasets keep
    layout_id="categorical"); MULTIPLE entries get f"{name}_{slug}" from the entry's
    distinguishing column, with "-{i}" appended (and re-suffixed until unique) on a
    slug collision so every layout_id is distinct. None for single-compute plugins
    (grid, datetime), whose sole layout_id is the bare plugin name.

    The single source of truth for expanded layout_ids: both ``_expand_layouts`` (the
    ingest bake) and add-layouts' spec resolution enumerate ids from here, so the two
    can never drift."""
    entries = _family_entries(plugin, roles)
    if entries is None:
        return None
    names: list[tuple[int, str, str]] = []
    used: set[str] = set()
    multi = len(entries) > 1
    for i, (column, label) in enumerate(entries):
        layout_id = plugin.name
        if multi:
            # On a slug collision the convention appends "-{i}" (the entry index),
            # re-suffixed until unique so two expanded layouts never write to the
            # same PMTiles container — distinct pyramids are what the D-10
            # identical-id-set transition invariant rests on.
            base = layout_id = f"{plugin.name}_{_slug(column)}"
            suffix = i
            while layout_id in used:
                layout_id = f"{base}-{suffix}"
                suffix += 1
        used.add(layout_id)
        names.append((i, layout_id, label))
    return names


def _expand_layouts(
    plugin: LayoutPlugin,
    meta: pa.Table,
    roles: "ColumnRoles | None",
    atlas: "ThumbnailCache",
) -> list[LayoutResult]:
    """Invoke `plugin.compute()` once per role entry for multi-entry families
    (config={"entry_index": i}), applying the ``_family_layout_names`` naming
    convention. label = the role entry's label (the plugin's own "By category"-style
    label only if the entry's is somehow empty). Single-compute plugins (grid,
    datetime) pass through unchanged."""
    names = _family_layout_names(plugin, roles)
    if names is None:
        return [plugin.compute(meta, roles, atlas, {})]
    results: list[LayoutResult] = []
    for i, layout_id, label in names:
        result = plugin.compute(meta, roles, atlas, {"entry_index": i})
        results.append(replace(result, layout_id=layout_id, label=label or result.label))
    return results


def _available_roles(roles: "ColumnRoles | None") -> set[Role]:
    """Which roles a layout can rely on. None ⇒ images-only (no roles), so only
    role-free layouts (grid) are satisfiable (decision D-25)."""
    if roles is None:
        return set()
    available = {Role.FILENAME}
    if roles.datetime is not None:
        available.add(Role.DATETIME)
    if roles.categorical:
        available.add(Role.CATEGORICAL)
    if roles.scatter:
        available.add(Role.SCATTER)
    if roles.geographic:
        available.add(Role.GEOGRAPHIC)
    if roles.tag:
        available.add(Role.TAG)
    if roles.freeform:
        available.add(Role.FREEFORM)
    if roles.embedding is not None:
        available.add(Role.EMBEDDING)
    return available


def _densify_ids(
    cache: "ThumbnailCache",
    image_index: list[tuple[int, Path]],
    metadata_path: Path,
) -> tuple["ThumbnailCache", dict[int, Path]]:
    """Re-map the surviving (decodable) cell ids to a CONTIGUOUS DENSE range
    [0, image_count) in ascending original-id order — the v2 cell_record contract
    (decision D-33): the renderer's id-indexed dense buffers require no gaps, so a
    decode-failed image must consume no id.

    Renames the thumbnail-cache blobs old_id.thumb -> new_id.thumb and rewrites
    metadata.parquet's `id` column so the filename join is preserved (the surviving
    rows keep their filename/enrichment, re-keyed to the dense id; decode-failed
    rows are dropped — they are unreferenceable, the join is by filename, and the
    renderer never indexes them).

    Fast path: when NO image was skipped (len(survivors) == len(image_index), the
    common case) the original ids are already the contiguous dense range [0, N) and
    metadata.parquet is already keyed to them, so this returns the cache untouched —
    no blob renames, no metadata rewrite. NB the guard is the survivor COUNT, not a
    dense survivor LIST: if only the highest id was skipped the survivors are still
    [0..N-1] yet metadata.parquet carries a trailing (decode-failed) row that must be
    dropped, so that case correctly takes the slow path below.

    Returns the dense-id ThumbnailCache and a {dense_id: original_image_path} map
    (for the detail tier, which transcodes the original of each survivor).
    """
    from pipeline.atlas import ThumbnailCache  # type-only; native import deferred

    path_by_orig = {orig: path for orig, path in image_index}
    survivors = sorted(cache.ids)  # ascending original ids
    survivor_paths = {dense: path_by_orig[orig] for dense, orig in enumerate(survivors)}

    if len(survivors) == len(image_index):
        # No image was skipped: ids are already dense [0, N) and metadata.parquet is
        # already keyed to them. Nothing to remap (the common case).
        return cache, survivor_paths

    remap = {orig: dense for dense, orig in enumerate(survivors)}
    already_dense = survivors == list(range(len(survivors)))

    if not already_dense:
        # Rename thumbnail blobs to the dense id. Two-phase via a temp suffix so a
        # forward shift (e.g. 4->3) never clobbers a not-yet-moved blob.
        cache_dir = cache.cache_dir
        for orig in survivors:
            (cache_dir / f"{orig}.thumb").rename(cache_dir / f"{orig}.thumb.tmp")
        for orig in survivors:
            (cache_dir / f"{orig}.thumb.tmp").rename(cache_dir / f"{remap[orig]}.thumb")

    # Rewrite metadata.parquet: keep survivor rows only, re-keyed to the dense id,
    # in dense-id order. (ingest wrote id == original sorted-filename position.)
    meta = pq.read_table(metadata_path)
    orig_ids = [int(v) for v in meta.column("id").to_pylist()]
    row_of_orig = {oid: i for i, oid in enumerate(orig_ids)}
    keep_rows = [row_of_orig[orig] for orig in survivors if orig in row_of_orig]
    kept = meta.take(pa.array(keep_rows, pa.int64()))
    dense_id_col = pa.array(list(range(len(survivors))), pa.int64())
    kept = kept.set_column(kept.schema.get_field_index("id"), "id", dense_id_col)
    pq.write_table(kept, metadata_path)

    dense_cache = ThumbnailCache(
        cache_dir=cache.cache_dir,
        thumb_px=cache.thumb_px,
        ids=list(range(len(survivors))),
        skipped=cache.skipped,
    )
    return dense_cache, survivor_paths


def _transcode_detail(dense_id: int, path_str: str, out_path_str: str, max_px: int) -> tuple[int, bool]:
    """Transcode ONE surviving original to a capped WebP at ``out_path_str`` (pool
    worker process). Shrink-on-load to fit ``max_px`` (never upscale), aspect
    preserved, alpha flattened on black, sRGB. Returns ``(dense_id, ok)``; ``ok`` is
    False when the original fails to decode — the failure IS the skip signal (no
    detail_ref for that cell), never raised (the one expected skip case). The whole
    encode+write happens here so the multi-MB WebP never crosses the process
    boundary; only the ``(dense_id, ok)`` pair is returned."""
    import pyvips  # native; deferred so pipeline.worker imports in the lean image

    try:
        img = pyvips.Image.thumbnail(path_str, max_px, size="down")
        if img.hasalpha():
            img = img.flatten(background=[0, 0, 0])
        img.colourspace("srgb").copy(interpretation="srgb").webpsave(out_path_str)
    except pyvips.Error:
        return dense_id, False
    return dense_id, True


def _bake_detail_tier(
    survivor_paths: dict[int, Path],
    detail_dir: Path,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[int, str]:
    """Detail tier (T2-26, mode=image_ref): transcode each surviving cell's original
    to a WebP capped at _DETAIL_MAX_PX under ``detail_dir`` (the caller passes the
    VERSION-STAMPED detail/v{version}/ dir — T2-46), named by dense id, and return
    {dense_id: relative_ref} for cell_record.detail_ref. The ref stays the bare
    ``{dense_id}.webp`` (RELATIVE to the manifest's version-stamped ``detail.path_prefix``
    — the API composes ``{path_prefix}/{cell_id}.{ext}``), so version-stamping the dir
    needs no schema or ref-format change. Aspect is preserved (shrink-on-load to fit,
    never upscale). An original that fails to decode here is skipped (no detail_ref for
    that cell) — its thumbnail still rendered, so the cell is not lost. Sole producer
    of the detail/ originals tree; called only when detail_tier == "bake" (T2-46).

    The transcode is embarrassingly parallel (each original is independent; output is
    detail/v{version}/{dense_id}.webp), and on a real corpus it dominates ingest, so it runs
    across ``atlas.vips_pool_map`` — the same bounded ``spawn`` pool / one-thread
    libvips machinery the thumbnail decode uses. ``vips_pool_map`` yields in input
    order, and ``survivor_paths`` is keyed by dense id 0..N-1 in ascending insertion
    order, so the skip-log order stays deterministic. Each worker writes its own
    uniquely-named file, so the on-disk output is order-independent regardless. A
    trivial corpus (≤1 image) or a single core runs inline (handled inside
    ``vips_pool_map``)."""
    # Deferred (atlas.py imports pyvips at module top): native, worker-image only, and
    # atlas is already imported by run_ingest before this is reached.
    from pipeline.atlas import vips_pool_map

    detail_dir.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger(__name__)
    refs: dict[int, str] = {}
    total = len(survivor_paths)
    results = vips_pool_map(
        _transcode_detail,
        [
            (dense_id, str(path), str(detail_dir / f"{dense_id}.webp"), _DETAIL_MAX_PX)
            for dense_id, path in survivor_paths.items()
        ],
    )
    # vips_pool_map yields in input order (parent-side consumer loop), so a positional
    # count is monotonic and the on_progress tick tracks originals transcoded (O1).
    for processed, (dense_id, ok) in enumerate(results, start=1):
        if ok:
            refs[dense_id] = f"{dense_id}.webp"
        else:
            log.warning("detail-tier transcode failed for %s; no detail_ref", survivor_paths[dense_id])
        if on_progress is not None:
            on_progress(processed, total)  # absolute count; the reporter throttles
    return refs


def _write_cover(dataset_dir: Path, grid_pyramid: "PyramidResult") -> Path | None:
    """Write the Library-card COVER (T2-55): the just-committed GRID pyramid's z=0
    whole-world overview WebP, copied out as ``{dataset_dir}/cover.webp`` — UNVERSIONED
    and atomically replaced. Called AFTER the base commit, so grid's PMTiles container
    is already live in ``dataset_dir``; the z=0 tile is the coarse mosaic overview
    (or the sole fine tile's mini-atlas when the pyramid is a single all-fine level),
    already WebP bytes inside the container (``tiler.read_overview_webp`` unwraps the
    fine framing when needed). No re-encode, no schema/manifest change.

    Written to a temp sibling then ``os.replace``d onto ``cover.webp`` so a concurrent
    card fetch (the API serves this file) never observes a half-written cover; a
    re-ingest overwrites the previous cover the same way. NON-FATAL: the cover is a
    cosmetic card thumbnail, and the dataset is already committed when this runs (the
    base manifest flip landed) — so ANY failure here (I/O, or an unexpected read of the
    just-baked container) is LOGGED and skipped rather than propagated: it must never
    fail an otherwise-good ingest, exactly like ``_sweep_stale_versioned_assets``'s
    post-commit cleanup. The card falls back to its flat surface block. Returns the
    cover path on success, else None."""
    from pipeline.tiler import read_overview_webp

    log = logging.getLogger(__name__)
    grid_pmtiles = dataset_dir / grid_pyramid.path
    try:
        webp = read_overview_webp(grid_pmtiles, grid_pyramid.z_cap)
        if webp is None:
            log.warning("cover: grid pyramid %s has no z=0 tile; no cover written", grid_pmtiles)
            return None
        cover_path = dataset_dir / _COVER_NAME
        tmp = cover_path.with_suffix(".webp.tmp")
        tmp.write_bytes(webp)
        os.replace(tmp, cover_path)  # atomic swap: no reader sees a half-written cover
        return cover_path
    except Exception:
        # Post-commit + cosmetic: never fail the completed ingest over the card thumb.
        # Logged (not silent) so a genuine container-read bug is still visible.
        log.warning("cover: could not write %s; skipping", dataset_dir / _COVER_NAME, exc_info=True)
        return None


def _plan_layouts(
    layout_types: list[str],
    roles: "ColumnRoles | None",
    meta: "pa.Table",
    cache: "ThumbnailCache",
    logger: logging.Logger,
) -> tuple[LayoutResult, list[LayoutResult]]:
    """Compute the ingest bake plan as ``(grid_result, extra_results)`` for the
    per-layout commit (T2-42). grid — the guaranteed floor (needs no roles, D-25) — is
    always computed and returned first so the BASE manifest commits with a valid
    ≥1-layout manifest; ``extra_results`` is every OTHER requested layout whose
    required roles are available, in request order, with multi-entry families
    (categorical, scatter) expanded to one result per role entry (D-26 / recon. #9).

    A requested layout whose roles are unmet is skipped with a log (same behaviour the
    single-commit bake had). grid is de-duplicated (never repeated in the extras) even
    when explicitly requested. Reuses ``_expand_layouts`` so an ingest layout is baked
    from byte-identical coordinates whether it lands via the base or a per-layout
    commit."""
    available = _available_roles(roles)
    grid_results = _expand_layouts(_make_plugin("grid"), meta, roles, cache)
    grid_result = grid_results[0]  # grid is single-compute (needs no roles)

    extra_results: list[LayoutResult] = []
    emitted: set[str] = {"grid"}
    for layout_type in layout_types:
        if layout_type in emitted:
            continue
        emitted.add(layout_type)
        plugin = _make_plugin(layout_type)
        required = set(plugin.required_columns())
        if not required.issubset(available):
            logger.info(
                "skipping layout %r: needs %s, available %s",
                layout_type,
                sorted(r.value for r in required),
                sorted(r.value for r in available),
            )
            continue
        extra_results.extend(_expand_layouts(plugin, meta, roles, cache))
    return grid_result, extra_results


# --- add-layouts (T2-42) helpers --------------------------------------------


def _effective_roles(
    committed_manifest: dict, override: dict | None
) -> tuple["ColumnRoles | None", bool]:
    """The roles the add-layouts run computes against, and whether they were
    overridden. Default = the committed manifest's ``column_roles`` (None for an
    images-only dataset). ``override`` (when given) REPLACES them wholesale. Both are
    shape-validated via ``ColumnRoles.from_config`` (raising on a malformed config)."""
    if override is not None:
        return ColumnRoles.from_config(override), True
    committed = committed_manifest.get("column_roles")
    if committed is None:
        return None, False
    return ColumnRoles.from_config(committed), False


def _validate_roles_against_parquet(roles: "ColumnRoles | None", metadata_path: Path) -> None:
    """Value-level check of the effective roles against the READ-ONLY committed
    metadata.parquet (there is no CSV re-join in add-layouts — the parquet is the
    frozen source). Every referenced enrichment column must be present, the typed
    columns must have the type ingest wrote (datetime => timestamp, scatter/geographic =>
    float, tag => list), and the D-35 Seam G1 scatter knobs (+ Seam G2 geographic
    lon/lat range + mercator |lat|) must satisfy the SAME config + value preconditions
    ingest enforces (unimplemented overlap, mixed/contradictory scales, log => strictly
    positive, none => within [0,1]; geographic lon/lat range) — the roles-override path
    is the natural way to apply a knob to an existing dataset, and without this gate
    a declared 'log' over a non-positive column reached ``math.log`` as an opaque
    ``math domain error`` while an unimplemented ``overlap`` baked silently and echoed
    a false ``options`` record (2026-07-20 review of the G1 seam). Raises
    ``ColumnRoleError`` on any mismatch (mirrors ingest's error surface). A no-op for
    an images-only dataset (roles is None)."""
    if roles is None:
        return
    from pipeline.ingest import (  # lean-safe; avoids a module-top cycle
        _URL_NOT_SHOWN_MSG,
        ColumnRoleError,
        _shown_scalar_columns,
        validate_geographic_config,
        validate_geographic_options_parquet,
        validate_scatter_config,
        validate_scatter_options_parquet,
    )

    # Pure-config knob checks first (no I/O — reject an unimplemented overlap or a
    # mixed/contradictory scale before touching the parquet). D-35 Seam G2: the
    # geographic role gets the SAME both-entry-points treatment (unimplemented overlap).
    validate_scatter_config(roles)
    validate_geographic_config(roles)

    schema = pq.read_schema(metadata_path)
    fields = {name: schema.field(name).type for name in schema.names}

    def require(column: str, role: str) -> "pa.DataType":
        if column not in fields:
            raise ColumnRoleError(
                column, f"{role} column not in metadata.parquet {sorted(fields)}"
            )
        return fields[column]

    if roles.datetime is not None:
        dt_type = require(roles.datetime.column, "datetime")
        if not pa.types.is_timestamp(dt_type):
            raise ColumnRoleError(
                roles.datetime.column, f"datetime column is {dt_type} in metadata.parquet, not a timestamp"
            )
    for cat in roles.categorical:
        require(cat.column, "categorical")
    for sc in roles.scatter:
        for column in (sc.x_column, sc.y_column):
            sc_type = require(column, "scatter")
            if not pa.types.is_floating(sc_type):
                raise ColumnRoleError(
                    column, f"scatter column is {sc_type} in metadata.parquet, not a float"
                )
    for geo in roles.geographic:
        for column in (geo.lon_column, geo.lat_column):
            geo_type = require(column, "geographic")
            if not pa.types.is_floating(geo_type):
                raise ColumnRoleError(
                    column, f"geographic column is {geo_type} in metadata.parquet, not a float"
                )
    for tag in roles.tag:
        tag_type = require(tag.column, "tag")
        if not pa.types.is_list(tag_type):
            raise ColumnRoleError(
                tag.column, f"tag column is {tag_type} in metadata.parquet, not a list"
            )
    for ff in roles.freeform:
        require(ff.column, "freeform")
    # Schema v2.8: url holds bare column names — each must be PRESENT in the frozen parquet (a
    # dangling url would bake a link naming a phantom column), AND must also be a categorical
    # or freeform column so its value is a shown scalar the panel can render as a link (parity
    # with ingest's _validate_columns_present).
    url_shown = _shown_scalar_columns(roles)
    for column in roles.url:
        require(column, "url")
        if column not in url_shown:
            raise ColumnRoleError(column, _URL_NOT_SHOWN_MSG)

    # Value-level knob checks LAST — the presence/type loop above guaranteed every
    # scatter/geographic axis column exists as a float, so the parquet reads inside never
    # miss. D-35 Seam G2 geographic gets its lon/lat range + mercator-|lat| twin here.
    validate_scatter_options_parquet(roles, metadata_path)
    validate_geographic_options_parquet(roles, metadata_path)


def _guard_no_stale_scatter_config(
    committed_manifest: dict, roles: "ColumnRoles | None", existing_ids: set[str]
) -> None:
    """add-layouts roles-override honesty guard (2026-07-20 round-2 review): the
    override REPLACES the committed ``column_roles`` wholesale, but committed layouts
    are never re-baked (``_guard_no_collision`` forbids requesting an existing id) —
    so an override that CHANGES THE KNOBS of a scatter pair whose layout is already
    committed would write the new knobs into the manifest's ``column_roles`` while
    the baked positions (and the layout's ``options`` echo — the record Seam G3
    reads) still reflect the old ones: a self-contradictory manifest. Reject, naming
    the layout — changing a baked scatter layout's knobs requires a re-ingest.

    Matching is BY AXIS PAIR (x_column, y_column) — the stable key: layout ids shift
    across the single-entry/multi-entry naming transition ("scatter" gains a slug
    when a second pair is added), so an id-keyed comparison would miss exactly the
    add-a-second-pair case. A pair ABSENT from the override (repointed/removed) is
    the pre-existing roles-staleness semantic, tracked, not this guard's scope;
    labels are exempt (display-only). Call only on the override path; a no-op when
    either side has no scatter roles."""
    committed_config = committed_manifest.get("column_roles")
    if committed_config is None or roles is None or not roles.scatter:
        return
    from pipeline.ingest import ColumnRoleError  # lean-safe; avoids a module-top cycle

    old_roles = ColumnRoles.from_config(committed_config)
    if not old_roles.scatter:
        return
    plugin = _PLUGINS["scatter"]()
    committed_by_pair: dict[tuple[str, str], tuple[str, "ScatterRoleEntry"]] = {}
    for i, layout_id, _label in _family_layout_names(plugin, old_roles) or []:
        entry = old_roles.scatter[i]
        if layout_id in existing_ids:
            committed_by_pair[(entry.x_column, entry.y_column)] = (layout_id, entry)

    knobs = ("x_scale", "y_scale", "normalize", "overlap")
    for new in roles.scatter:
        hit = committed_by_pair.get((new.x_column, new.y_column))
        if hit is None:
            continue
        layout_id, old = hit
        if any(getattr(old, f) != getattr(new, f) for f in knobs):
            raise ColumnRoleError(
                new.x_column,
                f"the roles override changes the scatter knobs of committed layout "
                f"'{layout_id}' (pair {new.x_column}/{new.y_column}), but add-layouts "
                f"never re-bakes an existing layout — the manifest would then "
                f"contradict the baked positions and their options echo. Re-ingest "
                f"the dataset to change a baked layout's knobs",
            )


def _guard_no_stale_geographic_config(
    committed_manifest: dict, roles: "ColumnRoles | None", existing_ids: set[str]
) -> None:
    """add-layouts roles-override honesty guard for the GEOGRAPHIC family (D-35 Seam G2 —
    the geographic twin of ``_guard_no_stale_scatter_config``). An override that CHANGES a
    committed geographic pair's projection/overlap would write the new knobs into the
    manifest's ``column_roles`` while the baked positions (and the layout's ``options`` echo
    — the projection record) still reflect the old projection: a self-contradictory
    manifest. Reject, naming the layout — changing a baked geographic layout's projection
    requires a re-ingest.

    Matching is BY LON/LAT PAIR (the stable key across the single→multi naming transition,
    exactly like scatter — "geographic" gains a slug when a second pair is added, so an
    id-keyed comparison would miss the add-a-second-pair case). A pair ABSENT from the
    override (repointed/removed) is the pre-existing roles-staleness semantic, not this
    guard's scope; the label is exempt (display-only). Call only on the override path; a
    no-op when either side has no geographic roles."""
    committed_config = committed_manifest.get("column_roles")
    if committed_config is None or roles is None or not roles.geographic:
        return
    from pipeline.ingest import ColumnRoleError  # lean-safe; avoids a module-top cycle

    old_roles = ColumnRoles.from_config(committed_config)
    if not old_roles.geographic:
        return
    plugin = _PLUGINS["geographic"]()
    committed_by_pair: dict[tuple[str, str], tuple[str, "GeographicRoleEntry"]] = {}
    for i, layout_id, _label in _family_layout_names(plugin, old_roles) or []:
        entry = old_roles.geographic[i]
        if layout_id in existing_ids:
            committed_by_pair[(entry.lon_column, entry.lat_column)] = (layout_id, entry)

    knobs = ("projection", "overlap")
    for new in roles.geographic:
        hit = committed_by_pair.get((new.lon_column, new.lat_column))
        if hit is None:
            continue
        layout_id, old = hit
        if any(getattr(old, f) != getattr(new, f) for f in knobs):
            raise ColumnRoleError(
                new.lon_column,
                f"the roles override changes the projection/overlap of committed "
                f"geographic layout '{layout_id}' (pair {new.lon_column}/{new.lat_column}), "
                f"but add-layouts never re-bakes an existing layout — the manifest would "
                f"then contradict the baked positions and their options echo. Re-ingest "
                f"the dataset to change a baked layout's projection",
            )


def _enumerate_layout_ids(roles: "ColumnRoles | None") -> list[tuple[str, str]]:
    """Every layout_id the effective roles can produce, as (layout_id, layout_type),
    in a deterministic order (plugin registry order; then role-entry order within a
    multi-entry family). grid is always present (needs no roles); a role-gated family
    with unmet roles or no entries contributes nothing. Uses the SAME naming
    (``_family_layout_names``) the ingest bake uses, so the ids match exactly."""
    available = _available_roles(roles)
    out: list[tuple[str, str]] = []
    for layout_type, plugin_cls in _PLUGINS.items():
        plugin = plugin_cls()
        if not set(plugin.required_columns()).issubset(available):
            continue
        names = _family_layout_names(plugin, roles)
        if names is None:  # single-compute family (grid, datetime)
            out.append((plugin.name, layout_type))
        else:
            for _i, layout_id, _label in names:
                out.append((layout_id, layout_type))
    return out


def _resolve_layout_specs(
    layout_specs: list[str], roles: "ColumnRoles | None"
) -> list[tuple[str, str]]:
    """Resolve requested specs to concrete (layout_id, layout_type), de-duped in
    request order. A bare layout_type ("categorical") expands to ALL its role
    entries; an expanded id ("categorical_kingdom") selects exactly that entry. An
    unknown spec (a type with no entries, or an id no role produces) raises
    ``ValueError`` listing the valid specs."""
    if not layout_specs:
        raise ValueError("add-layouts: no layouts requested (pass at least one --layout SPEC)")
    catalogue = _enumerate_layout_ids(roles)  # [(layout_id, layout_type)]
    by_id = {layout_id: layout_type for layout_id, layout_type in catalogue}
    ids_by_type: dict[str, list[str]] = {}
    for layout_id, layout_type in catalogue:
        ids_by_type.setdefault(layout_type, []).append(layout_id)

    resolved: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(layout_id: str, layout_type: str) -> None:
        if layout_id not in seen:
            seen.add(layout_id)
            resolved.append((layout_id, layout_type))

    for spec in layout_specs:
        if spec in _PLUGINS:  # a bare layout_type => the whole family
            expanded = ids_by_type.get(spec, [])
            if not expanded:
                raise ValueError(
                    f"add-layouts: layout type {spec!r} has no producible layouts for this "
                    f"dataset's roles; valid specs: {_valid_specs(catalogue)}"
                )
            for layout_id in expanded:
                add(layout_id, spec)
        elif spec in by_id:  # an exact expanded layout_id
            add(spec, by_id[spec])
        else:
            raise ValueError(
                f"add-layouts: unknown layout spec {spec!r}; valid specs: {_valid_specs(catalogue)}"
            )
    return resolved


def _valid_specs(catalogue: list[tuple[str, str]]) -> list[str]:
    """The specs an operator may pass: every producible layout_id plus each bare
    layout_type that has at least one producible layout, sorted for a stable error."""
    ids = {layout_id for layout_id, _ in catalogue}
    types = {layout_type for _, layout_type in catalogue}
    return sorted(ids | types)


def _guard_no_collision(resolved: list[tuple[str, str]], existing_ids: set[str]) -> None:
    """Any resolved layout_id already committed is a hard error — this tool never
    overwrites a live layout in v1. The message tells the operator to re-run with
    only the not-yet-present specs (which is also how a partial-failure re-run
    resumes)."""
    clashes = sorted(layout_id for layout_id, _ in resolved if layout_id in existing_ids)
    if clashes:
        raise ValueError(
            f"add-layouts: layout(s) {clashes} already exist in the dataset — this tool does "
            f"not overwrite. Re-run with only the layouts not yet present."
        )


def _committed_thumb_px(committed_manifest: dict) -> int:
    """The thumb_px the dataset was baked at, read from any layout's pyramid
    descriptor so the new tiles are consistent with the existing ones. Falls back to
    the env/default (``_thumb_px``) only when the committed manifest carries no
    pyramid to read (e.g. a degenerate zero-layout manifest)."""
    for layout in committed_manifest.get("layouts", []):
        pyramid = layout.get("pyramid")
        if isinstance(pyramid, dict) and "thumb_px" in pyramid:
            return int(pyramid["thumb_px"])
    return _thumb_px()


def _scan_image_index(images_dir: Path) -> list[tuple[int, Path]]:
    """The (original sorted-filename id, resolved path) index for the source images,
    exactly as ingest assigns ids (D-25). Reuses ingest's flat scan (rejects an empty
    set / duplicate basenames)."""
    from pipeline.ingest import _scan_images  # sole image-scan authority (D-25)

    paths = _scan_images(images_dir)
    return [(i, paths[i].resolve()) for i in range(len(paths))]


def _align_cache_to_committed(
    cache: "ThumbnailCache",
    image_index: list[tuple[int, Path]],
    metadata_path: Path,
) -> "ThumbnailCache":
    """ID-INTEGRITY GUARD (hard) + thumb-cache alignment. The one guard for both paths
    that reuse a committed dataset's artifacts: ``run_add_layouts`` (T2-42) and
    ``run_ingest --detail-tier retain`` (T2-175).

    The committed metadata.parquet's ``(id, filename)`` is the ground truth: its ids
    are the DENSE [0, image_count) space every existing layout's coordinates and the
    detail tier's ``{id}.webp`` filenames are keyed to. This re-keys the freshly-decoded
    thumb cache onto those committed dense ids BY FILENAME, and guards that the two
    corpora match EXACTLY.

    Aborts (``ValueError``) — committing nothing — when the decoded-survivor filename
    set differs from the committed filename set at all (a missing image, an extra
    image, or an original that now fails to decode). Also spot-checks count + max id
    after the re-key. This is what protects a live 1M dataset from a mismatched
    images_dir silently corrupting every new layout's coordinates, and a retained
    detail tier from re-pointing every cell at a different image's original.

    ``image_index`` is the ``(id, resolved path)`` index whose ids KEY ``cache``:
    add-layouts passes the current scan's original sorted-filename positions;
    ``--detail-tier retain`` passes the post-``_densify_ids`` ``{dense_id: path}`` map,
    so the guard runs in the dense space that run has already established (where the
    re-key is an identity — the scan is sorted by basename, so equal basename sets
    produce equal dense ids).

    Renames the cache blobs ``{orig_id}.thumb -> {dense_id}.thumb`` (two-phase via a
    temp suffix so a forward shift never clobbers a not-yet-moved blob) and returns a
    new ``ThumbnailCache`` keyed by the committed dense ids. metadata.parquet is NOT
    rewritten here (``run_ingest`` rewrites its OWN staged copy in ``_densify_ids``;
    the committed one is read-only to this function either way)."""
    from pipeline.atlas import ThumbnailCache  # type-only; native import deferred

    committed = pq.read_table(metadata_path, columns=["id", "filename"])
    committed_ids = [int(v) for v in committed.column("id").to_pylist()]
    committed_names = [str(v) for v in committed.column("filename").to_pylist()]
    dense_id_by_name = dict(zip(committed_names, committed_ids))
    committed_name_set = set(committed_names)

    path_by_orig = {orig: path for orig, path in image_index}
    decoded_names = {path_by_orig[orig].name for orig in cache.ids}

    missing = committed_name_set - decoded_names  # in committed, did not decode / absent now
    extra = decoded_names - committed_name_set    # decoded now, not in the committed dataset
    if missing or extra:
        raise ValueError(
            "id-integrity guard: images_dir does not match the committed dataset — "
            f"{len(missing)} committed image(s) missing/undecodable "
            f"(e.g. {sorted(missing)[:5]}), {len(extra)} extra image(s) present "
            f"(e.g. {sorted(extra)[:5]}). The committed metadata.parquet's "
            "(id, filename) keys both the existing layouts' coordinates and the detail "
            "tier's filenames, so anything reusing them must run over the SAME images. "
            "Aborted; nothing committed."
        )

    # Re-key blobs {orig_id}.thumb -> {dense_id}.thumb by filename. committed_name_set
    # == decoded_names is established above, so every survivor maps and the dense-id
    # target set is exactly the committed id set.
    cache_dir = cache.cache_dir
    remap: dict[int, int] = {}
    for orig in cache.ids:
        remap[orig] = dense_id_by_name[path_by_orig[orig].name]
    for orig in cache.ids:
        (cache_dir / f"{orig}.thumb").rename(cache_dir / f"{orig}.thumb.tmp")
    for orig in cache.ids:
        (cache_dir / f"{orig}.thumb.tmp").rename(cache_dir / f"{remap[orig]}.thumb")

    dense_ids = sorted(remap.values())
    # Spot-check the invariant the guard promises: count + max id match the committed.
    if len(dense_ids) != len(committed_ids) or (dense_ids and dense_ids[-1] != max(committed_ids)):
        raise ValueError(
            "id-integrity guard: spot-check failed after re-key "
            f"(decoded {len(dense_ids)} cells, max id {dense_ids[-1] if dense_ids else None}; "
            f"committed {len(committed_ids)} cells, max id {max(committed_ids) if committed_ids else None})."
        )
    return ThumbnailCache(
        cache_dir=cache_dir, thumb_px=cache.thumb_px, ids=dense_ids, skipped=cache.skipped
    )


def _committed_detail_refs(
    committed_manifest: dict, dataset_dir: Path, ids: list[int]
) -> tuple[dict[int, str] | None, str | None, str | None]:
    """Reconstruct ``{id: "{id}.{format}"}`` referencing the EXISTING committed detail
    originals, plus the (path_prefix, format) for the manifest's ``detail`` block —
    from the committed manifest's per-layout ``detail`` declaration + the files
    actually present under ``detail/``. add-layouts NEVER re-transcodes the detail
    tier; a new layout's fine records simply point at the same ``detail/{id}.webp``.

    Returns ``(None, None, None)`` when the committed dataset has no detail tier (no
    ``detail`` block on any layout, or the dir is absent). Only ids whose original was
    actually transcoded (file present) get a ref — matching run_ingest, where a
    decode-failed original has no ref."""
    detail = None
    for layout in committed_manifest.get("layouts", []):
        candidate = layout.get("detail")
        if isinstance(candidate, dict) and candidate.get("mode") == "image_ref":
            detail = candidate
            break
    if detail is None:
        return None, None, None

    prefix = detail.get("path_prefix", f"{_DETAIL_DIR}/")
    fmt = detail.get("format", "webp")
    detail_dir = dataset_dir / prefix.rstrip("/")
    if not detail_dir.is_dir():
        return None, None, None

    refs: dict[int, str] = {}
    for cell_id in ids:
        ref = f"{cell_id}.{fmt}"
        if (detail_dir / ref).is_file():
            refs[cell_id] = ref
    return refs, prefix, fmt


def _committed_manifest_for_retain(dataset_dir: Path, dataset_id: str) -> dict:
    """The committed manifest whose detail tier a ``--detail-tier retain`` re-ingest
    will reuse (T2-175) — or a hard refusal.

    FAILS CLOSED: retention that cannot be honoured must never degrade silently into a
    full transcode. An operator who asked for retention (because the corpus is
    unchanged and the transcode is over half the bake) and unknowingly got the whole
    9-hour pass has been failed twice — once by the missing tier, once by the silence.

    Refuses (``ValueError``, nothing staged, nothing committed) when the dataset is not
    committed at all, when its manifest or ``metadata.parquet`` is missing/unreadable,
    when the manifest's detail block is malformed or declares no ``image_ref`` tier /
    the tier's directory is gone, or when that directory holds no original at all.
    ``run_ingest`` calls this BEFORE the scan, so every one of those refusals costs a
    directory read rather than a multi-hour thumbnail pass; the remaining way retention
    can be impossible — the image set changed — needs the decoded corpus and is guarded
    at the detail branch by ``_align_cache_to_committed``."""
    manifest_path = dataset_dir / "layout_manifest.json"
    if not manifest_path.is_file():
        raise ValueError(
            f"ingest --detail-tier retain: dataset {dataset_id!r} has no committed "
            f"manifest at {manifest_path}, so there is no detail tier to retain. "
            f"Re-run with --detail-tier bake (the first bake of a dataset must "
            f"transcode its originals)."
        )
    # The id-integrity guard (at the detail branch) reads the committed metadata.parquet
    # to verify the image set; refuse HERE with an actionable message when it is missing,
    # rather than let the guard's `pq.read_table` raise a non-ValueError that escapes its
    # `except ValueError` wrapper as a raw traceback (run_add_layouts guards this too).
    metadata_path = dataset_dir / "metadata.parquet"
    if not metadata_path.is_file():
        raise ValueError(
            f"ingest --detail-tier retain: dataset {dataset_id!r} has a committed "
            f"manifest but no metadata.parquet at {metadata_path}, so the id-integrity "
            f"guard cannot verify the image set. Re-run with --detail-tier bake."
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:  # json.JSONDecodeError is a ValueError
        raise ValueError(
            f"ingest --detail-tier retain: could not read the committed manifest "
            f"{manifest_path} ({exc}); refusing rather than re-transcoding silently."
        ) from exc
    # Probe the committed tier without building refs — no dense ids exist yet at
    # pre-check time. `_committed_detail_refs` returns (None, None, None) exactly when
    # there is no image_ref detail block or its directory is absent, which is the same
    # question this pre-check asks. A malformed (e.g. non-string) path_prefix must fail
    # CLOSED here too, not escape as an AttributeError past this fail-closed gate.
    try:
        _, prefix, fmt = _committed_detail_refs(manifest, dataset_dir, [])
    except (AttributeError, TypeError) as exc:
        raise ValueError(
            f"ingest --detail-tier retain: the committed manifest for {dataset_id!r} has "
            f"a malformed detail block ({exc}); refusing rather than re-transcoding "
            f"silently. Re-run with --detail-tier bake."
        ) from exc
    if prefix is None:
        raise ValueError(
            f"ingest --detail-tier retain: the committed manifest for {dataset_id!r} "
            f"declares no image_ref detail tier, or its directory is gone — there is "
            f"nothing to retain. Re-run with --detail-tier bake to transcode one."
        )
    # Require at least one original actually on disk, so an EMPTY-but-present tier
    # refuses now — the directory read this pre-check already promised — rather than
    # after the full scan + multi-hour thumbnail pass (the detail branch's second guard
    # at `not detail_ref_by_id` would otherwise be the first to notice).
    detail_dir = dataset_dir / prefix.rstrip("/")
    if not any(detail_dir.glob(f"*.{fmt}")):
        raise ValueError(
            f"ingest --detail-tier retain: the committed detail tier of {dataset_id!r} "
            f"at {prefix} holds no {fmt} original — nothing to retain. Re-run with "
            f"--detail-tier bake to transcode one."
        )
    return manifest


def _stage_tags_sidecar(
    roles: "ColumnRoles | None",
    roles_overridden: bool,
    committed_manifest: dict,
    dataset_dir: Path,
    source_metadata_path: Path,
    output_path: Path,
) -> Path | None:
    """Stage a fresh version-stamped tag sidecar for add-layouts, ONLY when the
    effective roles carry tag roles AND (roles were overridden OR the committed
    dataset has no usable tag sidecar). Otherwise return None — the merged manifest
    then keeps the committed ``tags`` refs exactly as they are.

    Written from the READ-ONLY committed metadata.parquet (``source_metadata_path``);
    ``write_tags_sidecar`` reads only ``id`` + the tag columns, both of which are
    frozen in the committed parquet."""
    if roles is None or not roles.tag:
        return None
    committed_tags = committed_manifest.get("tags")
    committed_sidecar_ok = (
        not roles_overridden
        and isinstance(committed_tags, dict)
        and (dataset_dir / committed_tags.get("path", "")).is_file()
    )
    if committed_sidecar_ok:
        return None  # keep the committed sidecar + its manifest ref untouched
    return write_tags_sidecar(source_metadata_path, roles, output_path)


def _compute_requested_layouts(
    want_ids: list[str],
    roles: "ColumnRoles | None",
    meta: "pa.Table",
    cache: "ThumbnailCache",
) -> dict[str, LayoutResult]:
    """Compute exactly the requested layout_ids, keyed by layout_id. Reuses
    ``_expand_layouts`` per plugin family (its exact naming/collision logic), then
    filters to the wanted ids — so an add-layouts layout is baked from byte-identical
    coordinates to what a full ingest would have produced. A family is computed only
    if one of its ids was requested."""
    wanted = set(want_ids)
    types_wanted = {
        layout_type
        for layout_id, layout_type in _enumerate_layout_ids(roles)
        if layout_id in wanted
    }
    results: dict[str, LayoutResult] = {}
    for layout_type in types_wanted:
        plugin = _make_plugin(layout_type)
        for result in _expand_layouts(plugin, meta, roles, cache):
            if result.layout_id in wanted:
                results[result.layout_id] = result
    missing = wanted - set(results)
    if missing:  # defensive: enumeration and compute must agree
        raise RuntimeError(f"add-layouts: internal error, could not compute {sorted(missing)}")
    return results


def _commit_one_layout(
    staging: Path,
    dataset_dir: Path,
    layout_id: str,
    committed_manifest: dict,
    results_by_id: dict[str, LayoutResult],
    pyramids_by_id: dict[str, "PyramidResult"],
    committed_so_far: list[str],
    version: int,
    roles_override: "ColumnRoles | None",
    tags_path: Path | None,
    move_tags: bool,
    positions_by_id: dict[str, Path] | None = None,
) -> None:
    """PER-LAYOUT COMMIT (T2-42): move THIS layout's ``tiles/{layout_id}/`` (and its
    ``positions/{layout_id}_v{version}.arrow`` position table, v2.2) into the dataset
    dir, then atomically flip ``layout_manifest.json`` = the committed entries
    (byte-preserved) + entries for every layout landed so far this run,
    ``dataset_version`` bumped, roles/tags updated if overridden/refreshed.
    Re-validated against the schema by ``append_manifest_layouts`` before the flip.

    ``tags_path`` (a fresh sidecar staged this run) is MOVED into the dataset only when
    ``move_tags`` (the first flip) AND the staged file still exists — a prior flip that
    failed after its tags move (R4 continues past it) leaves the sidecar already at the
    committed path, and retrying the move would cascade-fail every later commit. Its
    manifest ref is set on EVERY flip regardless — the committed_manifest is never
    mutated, so a later flip must re-point tags to the fresh sidecar or the earlier
    flip's fresh ref would revert. None ⇒ keep the committed ``tags`` refs untouched.

    ``positions_by_id`` maps each layout landed this run -> its STAGED position-table
    path (T2-66 / T2-48). THIS layout's table is moved into ``positions/`` here (so it
    lands atomically with the flip that references it — the position file moves with
    its layout's flip), and the manifest ref for every layout landed so far is set from
    the (now dataset-relative) committed path via ``append_manifest_layouts``. None ⇒
    no position tables (a caller that did not bake them).

    The ``pyramid`` descriptors come from the ``PyramidResult`` the baker returned
    (its ``path`` is already the dataset-root-relative ``tiles/{layout_id}/…`` — the
    version lives in the path, identical staged or committed). Runs inside the
    caller's ``_commit_lock``; a later layout's failure leaves this flip live and the
    manifest valid (each flip is a complete, valid manifest)."""
    _move_merge(staging / "tiles" / layout_id, dataset_dir / "tiles" / layout_id)
    committed_tags_path: Path | None = None
    if tags_path is not None:
        committed_tags_path = dataset_dir / "tags" / tags_path.name
        staged_tags = staging / "tags" / tags_path.name
        # `staged_tags.exists()`: move_tags stays True until a flip SUCCEEDS, but the
        # physical move may already have happened inside a PREVIOUS flip that failed
        # AFTER it (R4 continues to the next layout) — the source is then gone and the
        # sidecar already sits at committed_tags_path, so retrying the move here would
        # raise and cascade-fail every remaining layout's commit.
        if move_tags and staged_tags.exists():
            _move_merge(staged_tags, committed_tags_path)
    # v2.2 (T2-66/T2-48): move THIS layout's position table into the dataset and build
    # the id->committed-path map every flip re-points from. The committed path (under
    # the dataset dir) is what append_manifest_layouts relativizes into positions_ref;
    # committed_manifest is never mutated, so — like tags — every flip must re-point the
    # positions of all layouts landed so far, not just this one.
    committed_positions: dict[str, Path] | None = None
    if positions_by_id is not None:
        staged = positions_by_id.get(layout_id)
        if staged is not None:
            _move_merge(staging / _POSITIONS_DIR / staged.name, dataset_dir / _POSITIONS_DIR / staged.name)
        committed_positions = {
            lid: dataset_dir / _POSITIONS_DIR / positions_by_id[lid].name
            for lid in committed_so_far
            if lid in positions_by_id
        }
    new_layouts = [results_by_id[lid] for lid in committed_so_far]
    new_pyramids = {lid: pyramids_by_id[lid] for lid in committed_so_far}
    append_manifest_layouts(
        committed_manifest=committed_manifest,
        new_layouts=new_layouts,
        new_pyramids=new_pyramids,
        dataset_version=version,
        output_path=dataset_dir / "layout_manifest.json",
        roles=roles_override,
        tags_path=committed_tags_path,
        positions=committed_positions,
    )


def _read_current_version(dataset_dir: Path) -> int:
    """Current committed dataset_version (0 if the dataset does not exist yet)."""
    manifest = dataset_dir / "layout_manifest.json"
    if not manifest.exists():
        return 0
    try:
        return int(json.loads(manifest.read_text(encoding="utf-8"))["dataset_version"])
    except (ValueError, KeyError, json.JSONDecodeError):
        return 0


def _commit(staging: Path, dataset_dir: Path, keep_staging: bool = False) -> None:
    """Publish the staged tree. New dataset: a single atomic rename. Re-ingest:
    move the version-stamped assets alongside the existing ones, then atomically
    flip layout_manifest.json last (version lives in every asset path, so new and
    old versions never collide — gap §7).

    Only the manifest flip is atomic across versions; non-version-stamped artifacts
    (metadata.parquet, ingest.log) are replaced in place, so a reader still on the
    old manifest may briefly observe the new metadata.parquet. Acceptable for the
    seam — true re-ingest concurrency is resolved at integration.

    ``keep_staging`` (T2-42 per-layout commit, the BASE commit): merge-move every
    staged item (never the whole-dir ``os.rename`` fast path — it would consume the
    staging dir the later per-layout bakes still write into, and move the open
    ingest.log handle's directory out from under the logger) and do NOT rmtree
    staging afterward. The caller removes staging once all per-layout commits land.
    A NEW dataset dir is created first so the top-level moves have a target. The
    internal ``_thumb_cache`` is never published: it is retained in staging (the
    per-layout bakes still read it) and swept with staging at the end of the run."""
    manifest_name = "layout_manifest.json"
    if not dataset_dir.exists() and not keep_staging:
        os.rename(staging, dataset_dir)
        return
    dataset_dir.mkdir(parents=True, exist_ok=True)  # keep_staging on a new dataset
    for item in list(staging.iterdir()):
        # `progress.json` (O1) is the live CLI-path sink, kept in staging and swept
        # with it; the worker persists its TERMINAL snapshot into the dataset dir
        # separately, so it is never published half-baked by this merge-move.
        if item.name in (manifest_name, _THUMB_CACHE_DIR, _PROGRESS_JSON):
            continue
        _move_merge(item, dataset_dir / item.name)
    os.replace(staging / manifest_name, dataset_dir / manifest_name)  # atomic version flip
    if not keep_staging:
        shutil.rmtree(staging, ignore_errors=True)


def _move_merge(src: Path, dst: Path) -> None:
    """Move src onto dst, recursing into directories that already exist so
    existing (older-version) siblings are preserved."""
    if src.is_dir() and dst.is_dir():
        for child in list(src.iterdir()):
            _move_merge(child, dst / child.name)
        src.rmdir()
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)


# The version-stamped detail-tier subdir pattern (detail/v{N}/), matched to identify
# stale versions to sweep on a re-ingest (T2-46).
_DETAIL_VERSION_RE = re.compile(r"^v(\d+)$")

# The version-stamped tile-container (`{layout_id}_v{N}.pmtiles`) and tag-sidecar
# (`tags_v{N}.arrow`) filename patterns, matched to identify stale versions to sweep
# on a re-ingest (T2-79). The `_v{N}` version suffix is the same convention the detail
# tier uses; these files are what `_commit`/`_move_merge` deliberately keep alongside
# their older-version siblings (so the manifest flip is atomic across versions), so
# nothing pruned the superseded ones before.
_TILE_PMTILES_VERSION_RE = re.compile(r"^.+_v(\d+)\.pmtiles$")
_TAGS_VERSION_RE = re.compile(r"^tags_v(\d+)\.arrow$")
# The per-layout position-table (`positions/{layout_id}_v{N}.arrow`, schema v2.2,
# T2-66/T2-48) filename pattern — the third version-stamped asset class sharing the
# same merge-move lifecycle, swept by the same manifest-derived rule.
_POSITIONS_VERSION_RE = re.compile(r"^.+_v(\d+)\.arrow$")


def _detail_prefix_version(path_prefix: str | None) -> int | None:
    """The version stamped into a manifest ``detail.path_prefix`` — ``"detail/v2/"``
    -> ``2`` — or ``None`` when there is no tier (``path_prefix is None``, i.e.
    detail_tier=skip) or the prefix carries no ``v{N}`` segment (the pre-T2-46 flat
    ``detail/`` shape, which the schema still permits: only ``mode`` is required).

    This is the sole source of ``_sweep_stale_detail``'s ``keep_version``. The sweep
    must keep exactly the version the JUST-FLIPPED manifest points at, which is the
    fresh ``dataset_version`` for a bake but the RETAINED, older version under
    ``--detail-tier retain`` (T2-175) — deriving it from the number rather than the
    prefix is what would delete a retained tier. Same rule
    ``_sweep_stale_versioned_assets`` applies to tiles/tags/positions: the manifest's
    own asset paths say what is live."""
    if path_prefix is None:
        return None
    match = _DETAIL_VERSION_RE.match(PurePosixPath(path_prefix.rstrip("/")).name)
    return int(match.group(1)) if match is not None else None


def _sweep_stale_detail(dataset_dir: Path, keep_version: int | None) -> list[Path]:
    """Remove every version-stamped detail/v{N}/ subdir where N != ``keep_version``
    (T2-46), returning the swept dirs. Called by ``run_ingest`` INSIDE the commit lock
    and AFTER the base manifest flip, so the live manifest already points at the kept
    version. This is what stops a re-ingest orphaning stale ``detail/`` files forever
    (the merge-move commit preserved older-version siblings; nothing pruned them
    before). It touches ONLY the ``vN`` version dirs — any non-matching entry under
    detail/ (there are none in Phase 1) is left untouched — and removes an empty
    ``detail/`` dir afterward so a skip re-ingest leaves no stray directory.

    ``keep_version`` is the version the JUST-FLIPPED manifest's ``detail.path_prefix``
    names — ``_detail_prefix_version`` derives it, never the caller's fresh
    ``dataset_version``. Under a bake the two are the same number; under
    ``--detail-tier retain`` (T2-175) they are NOT, and sweeping "everything but the
    new dataset_version" would delete the very tier the new manifest points at.
    ``None`` (detail_tier=skip, or a pre-T2-46 flat ``detail/`` prefix that names no
    version) means keep NO version dir: every ``detail/v{N}/`` is then unreferenced.

    Add-layouts NEVER sweeps (it reuses the committed detail tier read-only and its
    carried refs keep pointing at the old version's files); only ``run_ingest`` prunes
    the superseded ones."""
    detail_root = dataset_dir / _DETAIL_DIR
    if not detail_root.is_dir():
        return []
    swept: list[Path] = []
    for entry in list(detail_root.iterdir()):
        if not entry.is_dir():
            continue
        match = _DETAIL_VERSION_RE.match(entry.name)
        if match is None or int(match.group(1)) == keep_version:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        swept.append(entry)
    # Sweep an emptied detail/ (e.g. a re-ingest that flipped to detail_tier=skip):
    # leave no stray directory behind. Guarded so a still-populated dir is kept.
    try:
        if not any(detail_root.iterdir()):
            detail_root.rmdir()
    except OSError:
        pass
    return swept


def _manifest_referenced_asset_names(
    manifest: dict,
) -> tuple[dict[str, set[str]], str | None, set[str]]:
    """The version-stamped assets the JUST-FLIPPED manifest actually references, as
    ``({layout_id: {referenced pmtiles filenames}}, referenced tags filename | None,
    {referenced position-table filenames})``.

    This is the single source of truth for which version-stamped files are LIVE — the
    T2-79 sweep must be derived from these actual manifest paths, NOT from a blanket
    ``N != current_version`` rule. ``add-layouts`` builds MIXED-VERSION trees (a layout
    added later carries a higher version than the base ingest's assets), so a valid
    manifest can legitimately reference several different versions at once; and a full
    re-ingest replaces everything at one new version. In both cases the newly-committed
    manifest — not an assumed version number — is what says which files are live.

    Only the leaf filename (keyed by its layout dir, for pyramids) is kept: the sweep
    scans one dir at a time, so comparing bare filenames within that dir is sufficient
    and avoids re-deriving the ``tiles/{layout_id}/`` / ``positions/`` prefix. A pyramid
    path with no parent dir (never emitted by this pipeline — it always writes
    ``tiles/{layout_id}/…``) contributes nothing and leaves that dir untouched.

    ``positions_ref`` (schema v2.2, T2-66/T2-48) joined the same version-stamped
    merge-move lifecycle as tiles/tags, so its per-layout ``positions/{layout}_v{N}
    .arrow`` files are collected here too; a pre-2.2 manifest simply has no refs (an
    empty set — then every versioned file in ``positions/`` is stale, which is right:
    nothing references them)."""
    referenced_pmtiles: dict[str, set[str]] = {}
    referenced_positions: set[str] = set()
    for layout in manifest.get("layouts", []):
        pos_ref = layout.get("positions_ref")
        if isinstance(pos_ref, str) and pos_ref:
            referenced_positions.add(Path(pos_ref).name)
        pyramid = layout.get("pyramid")
        if not isinstance(pyramid, dict):
            continue
        raw_path = pyramid.get("path")
        if not isinstance(raw_path, str):
            continue
        # The pipeline always emits tiles/{layout_id}/{layout_id}_v{N}.pmtiles; key the
        # referenced leaf filename under its immediate parent dir (the layout dir).
        parts = Path(raw_path).parts
        if len(parts) >= 2:
            referenced_pmtiles.setdefault(parts[-2], set()).add(parts[-1])
    tags = manifest.get("tags")
    referenced_tags: str | None = None
    if isinstance(tags, dict):
        raw_tags = tags.get("path")
        if isinstance(raw_tags, str):
            referenced_tags = Path(raw_tags).name
    return referenced_pmtiles, referenced_tags, referenced_positions


def _sweep_stale_versioned_assets(dataset_dir: Path, manifest: dict) -> tuple[list[Path], int]:
    """Remove every version-stamped ``tiles/{layout}/{layout}_v{N}.pmtiles``,
    ``tags/tags_v{N}.arrow``, and ``positions/{layout}_v{N}.arrow`` the JUST-FLIPPED
    ``manifest`` does NOT reference (T2-79), returning ``(swept files, total bytes
    reclaimed)``. The disk-growth cousin of ``_sweep_stale_detail``:
    ``_commit``/``_move_merge`` deliberately move a re-ingest's fresh version-stamped
    assets ALONGSIDE the older-version siblings (the version lives in every asset path,
    so new and old never collide and the manifest flip stays atomic across versions) —
    which means nothing ever pruned the superseded pyramids + tag sidecars, and they
    grew on disk forever.

    Called by ``run_ingest`` INSIDE the commit lock and AFTER the atomic base-manifest
    flip, exactly where ``_sweep_stale_detail`` runs: the live manifest already points at
    the kept version's files, so every OTHER version-stamped file in those dirs is
    orphaned. Doing it after the flip means an in-flight reader still on the OLD manifest
    resolved its (old-version) paths through the flip window, exactly as tiles and the
    detail tier are lifecycled.

    CORRECTNESS — the "referenced versions" come from the manifest's ACTUAL asset paths
    (``_manifest_referenced_asset_names``), never a blanket ``N != current_version``: a
    full re-ingest stamps grid + every extra layout + the tag sidecar at the ONE new
    version, so the just-flipped base manifest's referenced set is exactly that version
    and every other is stale. (``run_add_layouts`` NEVER calls this — its byte-preserved
    manifest legitimately references a MIX of versions, e.g. grid at v1 + a categorical
    added at v2, and both must survive.)

    Only ``_v{N}``-stamped files are touched — an unversioned or non-matching entry (there
    are none in Phase 1) is left alone. An emptied ``tags/`` / ``positions/`` dir is
    removed so nothing stray is left behind, and a ``tiles/{layout}/`` dir emptied
    because this re-ingest DROPPED that layout (fewer ``layout_types`` than the prior
    bake) is removed too — a dir whose layout is still live always keeps its container.

    ``positions/{layout}_v{N}.arrow`` position tables (schema v2.2, T2-66/T2-48) share
    the exact tiles/tags lifecycle (version-stamped, merge-moved alongside older
    siblings at commit) and are swept by the same manifest-derived rule.

    NON-FATAL by design, like ``_sweep_stale_detail``'s ``ignore_errors``: the dataset
    is already committed when this runs, so a cleanup failure (e.g. a permission error
    on one file) is logged and skipped — it must never fail the completed job."""
    referenced_pmtiles, referenced_tags, referenced_positions = (
        _manifest_referenced_asset_names(manifest)
    )
    swept: list[Path] = []
    swept_bytes = 0
    log = logging.getLogger(__name__)

    def _remove(entry: Path) -> None:
        nonlocal swept_bytes
        try:  # size BEFORE unlink (cheap for a file); a vanished file just counts 0
            size = entry.stat().st_size
        except OSError:
            size = 0
        try:
            entry.unlink(missing_ok=True)
        except OSError as exc:
            # The dataset committed fine; a failed cleanup must not fail the job.
            log.warning("stale-asset sweep could not remove %s: %s", entry, exc)
            return
        swept_bytes += size
        swept.append(entry)

    def _rmdir_if_empty(directory: Path) -> None:
        try:
            if not any(directory.iterdir()):
                directory.rmdir()
        except OSError:
            pass

    tiles_root = dataset_dir / "tiles"
    if tiles_root.is_dir():
        for layout_dir in list(tiles_root.iterdir()):
            if not layout_dir.is_dir():
                continue
            keep = referenced_pmtiles.get(layout_dir.name, set())
            for entry in list(layout_dir.iterdir()):
                if not entry.is_file() or _TILE_PMTILES_VERSION_RE.match(entry.name) is None:
                    continue
                if entry.name in keep:
                    continue
                _remove(entry)
            # A layout DROPPED by this re-ingest (absent from the new manifest) has no
            # live container left — remove the emptied dir, not just its stale files.
            _rmdir_if_empty(layout_dir)

    tags_root = dataset_dir / "tags"
    if tags_root.is_dir():
        for entry in list(tags_root.iterdir()):
            if not entry.is_file() or _TAGS_VERSION_RE.match(entry.name) is None:
                continue
            if entry.name == referenced_tags:
                continue
            _remove(entry)
        # An images-only re-ingest (no tag roles) references no sidecar, so a prior
        # dataset's tags/ can empty out entirely — leave no stray directory behind.
        _rmdir_if_empty(tags_root)

    positions_root = dataset_dir / "positions"
    if positions_root.is_dir():
        for entry in list(positions_root.iterdir()):
            if not entry.is_file() or _POSITIONS_VERSION_RE.match(entry.name) is None:
                continue
            if entry.name in referenced_positions:
                continue
            _remove(entry)
        # A manifest with no positions_ref at all (a hypothetical positions-less
        # re-bake over a v2.2 tree) sweeps every table — leave no stray dir behind.
        _rmdir_if_empty(positions_root)

    return swept, swept_bytes


def sweep_staging(
    output_root: Path,
    active_job_ids: set[str] | None = None,
    ttl_seconds: int = _STAGING_TTL_SECONDS,
) -> list[Path]:
    """Reclaim orphaned ``.staging-{job_id}`` dirs, with TWO independent keep-signals so
    a LIVE bake is never clobbered — a dir is reaped only when BOTH agree it is dead:

      1. its job is NOT in ``active_job_ids`` (the RQ active set; None/unknown ⇒ this
         signal abstains and every dir relies on the mtime floor), AND
      2. its mtime is older than ``ttl_seconds`` (the TTL FRESHNESS FLOOR).

    The mtime floor is the load-bearing safety net (Seam O1 V1 fix): a live
    progress-reporting bake rewrites ``{staging}/progress.json`` at ~1 Hz (temp +
    ``os.replace`` in the dir ROOT, which advances the DIRECTORY's own mtime), so its
    dir stays fresh throughout. That makes the floor reliable even for a dir the active
    set cannot vouch for — a CLI ``--sync`` bake whose uuid is never in RQ (its
    ``Job.fetch`` NoSuchJobErrors ⇒ absent from the active set), or an RQ peer whose
    ``Job.fetch`` transiently failed — so NEITHER is reaped mid-run. A dir that IS in the
    active set is kept even when stale (a genuinely long-running >24h job the RQ registry
    confirms). Returns the swept dirs; never a blanket delete."""
    root = Path(output_root)
    if not root.exists():
        return []
    now = time.time()
    swept: list[Path] = []
    for entry in root.glob(".staging-*"):
        if not entry.is_dir():
            continue
        job_id = entry.name[len(".staging-"):]
        # Keep-signal 1: an RQ-confirmed active job is never reaped, even if its dir is
        # stale (a real >24h bake).
        if active_job_ids is not None and job_id in active_job_ids:
            continue
        # Keep-signal 2 (the freshness floor, ALWAYS applied — the V1 fix): a dir
        # touched within the TTL is live (progress.json self-refreshes its mtime), so
        # keep it. ONLY a stale dir NOT in the active set is reaped.
        try:
            if now - entry.stat().st_mtime < ttl_seconds:
                continue
        except OSError:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        swept.append(entry)
    return swept


def _sweep_orphan_staging(output_root: Path, keep_job_id: str, logger: logging.Logger) -> None:
    """R3: best-effort reclamation of orphaned ``.staging-{job_id}`` dirs — the ones a
    killed/failed job leaves behind. Nothing swept them before (``sweep_staging`` had
    ZERO call sites — worker.py's dead code, its docstring's "wired in at the worker
    entrypoint" was untrue). Called at the top of every ingest / add-layouts run
    (chosen over a Dockerfile entrypoint bootstrap — no image change, and it runs on
    the CLI ``--sync`` path too).

    Builds the RQ active-job set, then hands it to ``sweep_staging``, which reaps a dir
    only when it is BOTH not-active AND stale past the TTL (see there). Protection is
    TWO-LAYERED, not active-set-alone: (1) this job (``keep_job_id``) and any RQ-active
    peer are in the active set; (2) the TTL FRESHNESS FLOOR covers everything the active
    set cannot vouch for — a CLI ``--sync`` peer (uuid never in RQ) and an RQ peer whose
    ``Job.fetch`` transiently failed both keep a FRESH dir, because a live bake rewrites
    ``{staging}/progress.json`` at ~1 Hz, advancing its dir mtime (this PR's progress
    channel is what makes the floor reliable — the earlier "mtime does not advance"
    assumption no longer holds). RQ is queried per leftover dir (bounded, usually zero):
    a ``NoSuchJobError`` (job genuinely gone) leaves the dir to the mtime floor, while a
    transport error (``RedisError``-family / any other read failure) is UNKNOWN and the
    dir is KEPT this pass (added to the active set), never conflated with orphaned. NEVER
    raises — cleanup must not affect a bake (directive §1.3). With no broker (CLI
    ``--sync``) it degrades to the pure TTL floor."""
    try:
        redis_url = os.environ.get("REDIS_URL")
        if not redis_url:
            swept = sweep_staging(output_root)  # no broker → pure TTL floor (see sweep_staging)
        else:
            import redis
            from rq.exceptions import NoSuchJobError
            from rq.job import Job

            # Bounded socket timeouts: this sweep runs BEFORE any bake work, and a
            # blackholed (not refused) broker would otherwise stall each per-dir
            # Job.fetch at the OS TCP timeout (~minutes). A timeout lands in the
            # except-Exception branch below → UNKNOWN → dir kept, sweep skipped —
            # delay bounded, correctness unchanged.
            connection = redis.Redis.from_url(
                redis_url, socket_connect_timeout=5, socket_timeout=5
            )
            active: set[str] = {keep_job_id}
            for entry in Path(output_root).glob(".staging-*"):
                job_id = entry.name[len(".staging-"):]
                if job_id in active:
                    continue
                try:
                    raw = Job.fetch(job_id, connection=connection).get_status(refresh=False)
                except NoSuchJobError:
                    continue  # job genuinely gone → not active; the mtime floor keeps a fresh dir
                except Exception:
                    # Transport/read failure (RedisError-family, etc.) → state UNKNOWN.
                    # Keep the dir THIS pass rather than risk reaping a live peer.
                    active.add(job_id)
                    continue
                if str(getattr(raw, "value", raw)) in _ACTIVE_JOB_STATES:
                    active.add(job_id)
            swept = sweep_staging(output_root, active_job_ids=active)
        if swept:
            logger.info("swept %d orphaned staging dir(s): %s", len(swept), [p.name for p in swept])
    except Exception:
        logger.warning("orphan-staging sweep failed (non-fatal)", exc_info=True)


def _current_job_id() -> str:
    """The RQ job id when running under a worker; a fresh uuid for a `--sync` run."""
    try:
        from rq import get_current_job

        job = get_current_job()
        if job is not None and job.id:
            return str(job.id)
    except Exception:
        pass
    return uuid.uuid4().hex


@contextmanager
def _commit_lock(dataset_id: str) -> Iterator[None]:
    """Per-dataset commit lock via Redis. A no-op when REDIS_URL is unset (e.g. a
    single-process `--sync` run), which must commit correctly with no live broker."""
    redis_url = os.environ.get("REDIS_URL")
    if not redis_url:
        yield
        return
    import redis

    client = redis.Redis.from_url(redis_url)
    lock = client.lock(f"ingest-commit:{dataset_id}", timeout=60, blocking_timeout=120)
    if not lock.acquire():
        raise RuntimeError(f"could not acquire commit lock for {dataset_id}")
    try:
        yield
    finally:
        try:
            lock.release()
        except Exception:  # lock may have expired; commit already done
            pass


def _setup_logger(log_path: Path) -> tuple[logging.Logger, logging.Handler]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(f"pipeline.worker.{log_path.parent.name}")  # unique per job dir
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return logger, handler


def _close_logger(logger: logging.Logger, handler: logging.Handler) -> None:
    handler.flush()
    handler.close()
    logger.removeHandler(handler)
