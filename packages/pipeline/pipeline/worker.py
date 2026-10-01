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

import jsonschema  # `set-roles` degrades on an unparseable COMMITTED roles map (below)
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
    _GEO_KNOB_DEFAULTS,      # the knob NAMES, so `_GEO_KNOBS` cannot drift from the emitter
    _SCATTER_KNOB_DEFAULTS,  # ditto for `_SCATTER_KNOBS` -- see the two tuples below
    _roles_to_dict,  # the EMITTER's role serializer -- set-roles must write the bake's bytes
    append_manifest_layouts,
    drop_retired_roles,
    fingerprint_to_json,
    revalidate_and_write,
    role_entry_fingerprints,  # the ONE tuple rule -- never re-implemented here (v2.10)
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
    import pyvips

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

# The per-family SHAPING KNOBS — the fields of a scatter (D-35 Seam G1) / geographic
# (Seam G2) role entry that change how the column is READ, as opposed to how it is
# labelled. Named once because two places must agree about them and neither can notice
# if they drift: `_guard_no_stale_scatter_config` / `_guard_no_stale_geographic_config`
# (a roles override must not silently re-describe a layout the run does not re-bake and
# that records no `source_fingerprint`, so could never report it — D-xxx) and
# `manifest.role_entry_fingerprints`, which every staleness answer is built on (a knob
# change STALES the layouts built on those columns). A knob added to one list and not the
# other is either an unguarded contradiction or a staleness the designer never reports.
#
# DERIVED, not transcribed (2026-09-09 review finding 12): they are the KEYS of
# `manifest._SCATTER_KNOB_DEFAULTS` / `_GEO_KNOB_DEFAULTS` — the same dicts the emitter
# iterates to decide which knobs to serialize — so a fifth knob added to the serializer
# arrives here with no edit. Written out as literals, this was a third copy of the knob
# names that nothing could notice going stale: a knob missing here silently disarms BOTH
# `_guard_no_stale_scatter_config` and `_role_fingerprints`, and no test can see it,
# because both would simply stop looking at the new knob.
_SCATTER_KNOBS = tuple(_SCATTER_KNOB_DEFAULTS)
_GEO_KNOBS = tuple(_GEO_KNOB_DEFAULTS)


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
    # Per-id opt-in to RE-BAKING a committed layout (seam L2 /
    # [[T2-add-layouts-cannot-replace-a-committed-layout]]). Each id here must ALSO be
    # requested in `layout_specs` and must already be committed. Empty (the default) ⇒
    # `_guard_no_collision` behaves exactly as it always has and refuses every collision:
    # the silent overwrite is the footgun this whole area was hardened against, so
    # replace is opt-in per layout and never a mode.
    replace: tuple[str, ...] = ()


@dataclass(frozen=True)
class DeleteLayoutJobPayload:
    """Remove ONE committed layout from a dataset (seam L2 /
    [[T2-a-layout-cannot-be-deleted-only-the-whole]]): rewrite the manifest without
    that entry and sweep the bytes it owned. No decode, no thumbs, no bake — but a
    WORKER job all the same, because ``layout_manifest.json`` is worker-written and
    only worker-written (D-xv / D-15)."""

    dataset_id: str
    owner: str                  # a LABEL for ingest.log only (see cli._OWNER_HELP); ownership is API app-state
    layout_id: str              # the committed layout_id to remove
    output_root: Path


@dataclass(frozen=True)
class SetRolesJobPayload:
    """RE-DECLARE a committed dataset's ``column_roles`` with NO bake (seam L2 /
    [[T2-a-role-cannot-be-changed-without-also-queueing]]). The roles are re-validated
    against the committed ``metadata.parquet`` exactly as ``add-layouts --column-roles``
    validates them (D-11: the pipeline is the validator of record, not the client), then
    written into the committed manifest — nothing under ``tiles/``, ``positions/``,
    ``tags/`` or ``detail/`` is read or written."""

    dataset_id: str
    owner: str                  # a LABEL for ingest.log only (see cli._OWNER_HELP)
    column_roles: dict          # the FULL replacement role map, not a patch
    output_root: Path


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
    replace: list[str] | None = None,
) -> dict:
    """Primitive-kwargs entry point for the RQ / enqueue boundary (T2-42).

    Mirrors ``run_ingest_job``: the lean API image carries no pipeline dependency
    (decision D-15), so it can neither import nor construct ``AddLayoutsJobPayload``.
    The API enqueues THIS dotted path — ``pipeline.worker.run_add_layouts_job`` —
    with JSON-primitive kwargs only; this wrapper rebuilds the typed payload and
    delegates to ``run_add_layouts``. ``cli.py`` and the native tests call
    ``run_add_layouts(payload)`` directly.

    ``column_roles`` defaults to None (⇒ reuse the committed manifest's roles).

    ``replace`` (seam L1, closing [[T2-the-add-layouts-enqueue-contract-cannot-carry]])
    is the per-id opt-in to RE-BAKING a committed layout — a ``list[str]`` here rather
    than the payload's ``tuple`` because only JSON primitives cross the RQ boundary.
    None and ``[]`` are the same thing and are today's behaviour exactly: an empty
    ``replace`` leaves ``_guard_no_collision`` refusing every collision, so the silent
    overwrite this area was hardened against stays impossible unless the caller names
    the id. Seam L2 landed the whole ``--replace`` path but stopped at this signature,
    because its parameter SET is transcribed in two places OUTSIDE
    ``packages/pipeline/`` and asserted exactly — ``tests/smoke/test_enqueue_contract``'s
    ``ADD_LAYOUTS_ENQUEUE_KWARGS`` and ``api/queue.py``'s ``enqueue_add_layouts`` — so
    the enqueue contract moves as ONE change across all three files, and two of them
    belong to seam L1. Treat a rename here as breaking.
    """
    payload = AddLayoutsJobPayload(
        dataset_id=dataset_id,
        owner=owner,
        images_dir=Path(images_dir),
        layout_specs=list(layout_specs),
        output_root=Path(output_root),
        column_roles=column_roles,
        replace=tuple(replace or ()),
    )
    return run_add_layouts(payload)


def run_delete_layout_job(
    dataset_id: str,
    owner: str,
    output_root: str,
    layout_id: str,
) -> dict:
    """Primitive-kwargs entry point for the RQ / enqueue boundary (seam L2).

    Mirrors ``run_add_layouts_job``: the lean API image carries no pipeline dependency
    (decision D-15), so it can neither import nor construct ``DeleteLayoutJobPayload``.
    The API enqueues THIS dotted path — ``pipeline.worker.run_delete_layout_job`` —
    with JSON-primitive kwargs only; this wrapper rebuilds the typed payload and
    delegates to ``run_delete_layout``. ``cli.py`` and the tests call
    ``run_delete_layout(payload)`` directly.

    These parameter names ARE the cross-process contract (seam L1's delete route
    enqueues them by name), so treat a rename here as a breaking change.
    """
    payload = DeleteLayoutJobPayload(
        dataset_id=dataset_id,
        owner=owner,
        layout_id=layout_id,
        output_root=Path(output_root),
    )
    return run_delete_layout(payload)


def run_set_roles_job(
    dataset_id: str,
    owner: str,
    output_root: str,
    column_roles: dict,
) -> dict:
    """Primitive-kwargs entry point for the RQ / enqueue boundary (seam L2).

    Mirrors ``run_add_layouts_job`` — see ``run_delete_layout_job`` for why the wrapper
    exists at all. ``column_roles`` is the FULL replacement role map (the same JSON
    object ``add-layouts --column-roles`` accepts), never a patch: a partial map would
    make "the user cleared this role" indistinguishable from "the user did not mention
    it", and the roles form always has the whole map in hand.

    These parameter names ARE the cross-process contract — seam L1's roles-only edit
    route enqueues them by name — so treat a rename here as a breaking change.
    """
    payload = SetRolesJobPayload(
        dataset_id=dataset_id,
        owner=owner,
        column_roles=column_roles,
        output_root=Path(output_root),
    )
    return run_set_roles(payload)


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
                # RECORDED, NOT A FAULT. The API's versioned detail route
                # (`get_detail_versioned`) reads the live version off the manifest's own
                # `detail.path_prefix` via `_detail_prefix_version`, falling back to
                # `dataset_version` only for the pre-T2-46 flat `detail/` shape. So a
                # STAMPED prefix that disagrees with dataset_version resolves correctly
                # (T2-178 / PR #211) and the click-through lightbox works.
                #
                # This comment previously said the OPPOSITE -- that the route 404s unless
                # the URL version equals dataset_version -- and cited
                # test_get_detail_versioned_wrong_version_is_404 for it. That test proves
                # the PREFIX behaviour, not the dataset_version one: its own docstring says
                # a version segment "that does not name the tier the manifest's
                # detail.path_prefix points at is a 404", and it asserts v2 is absent while
                # the prefix is detail/v1/. The citation was carried forward unread after
                # PR #211 changed what it meant.
                #
                # Two facts worth keeping: the frontend composes the URL from THIS prefix
                # (api-client/client.ts `detailUrl` -> `detailVersionFromPrefix`), and the
                # shape is not introduced here -- every committed `add-layouts` run
                # publishes it (test_add_layouts.py: dataset_version 2 with `detail/v1/`).
                logger.warning(
                    "detail tier: manifest detail prefix %s does not match "
                    "dataset_version=%d. The API's versioned detail route validates the "
                    "URL version against the MANIFEST PREFIX (get_detail_versioned / "
                    "_detail_prefix_version, T2-178 / PR #211), so this resolves "
                    "correctly and the click-through lightbox works. Logged because the "
                    "mismatch is worth seeing, not because it is a fault. (Same shape an "
                    "add-layouts run publishes.)",
                    detail_path_prefix, version,
                )
        else:
            reporter.start_stage("detail", "Detail tier", "images", len(survivor_paths))
            detail_ref_by_id = _bake_detail_tier(
                survivor_paths, staging / _DETAIL_DIR / f"v{version}",
                logger,  # the JOB logger, so its lines reach this dataset's ingest.log
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
    the committed manifest is a collision error UNLESS it was named in
    ``payload.replace``.

    ``payload.replace`` — RE-BAKE a committed layout in place (seam L2 /
    [[T2-add-layouts-cannot-replace-a-committed-layout]]). Opt-in PER ID: without it
    ``_guard_no_collision`` behaves exactly as it always has, because a silent overwrite
    is the footgun this area was hardened against. What a replace does and does not
    change:

      * it keeps the whole append path — bake into staging, flip through
        ``_commit_one_layout``, per-layout failure isolation. A replace is a normal
        per-layout commit whose flip happens to splice over an existing entry
        (``append_manifest_layouts``) instead of appending, so it inherits the atomicity
        and the isolation rather than re-deriving them;
      * it PRESERVES the ``layout_id`` and the entry's POSITION in ``layouts``. D-xvi
        keys ``presentation.json`` by ``layout_id``, so minting a fresh id would silently
        discard the user's rename and their default-layout choice; and ``layouts`` order
        is the switcher order and the dangling-``default_layout`` fallback;
      * it keeps ``_align_cache_to_committed``: the id set the new bake places must match
        the committed ``metadata.parquet`` exactly. A replace that re-keyed coordinates
        to a different corpus is the one way this could corrupt a live dataset;
      * it SWEEPS the superseded ``tiles/{layout_id}/{layout_id}_v{old}.pmtiles`` and
        ``positions/{layout_id}_v{old}.arrow`` — but only AFTER that layout's flip has
        succeeded, so an in-flight reader still on the old manifest resolves its old
        paths through the flip window (the ordering ``_sweep_stale_detail`` uses);
      * it exempts the replaced ids from ``_guard_no_stale_scatter_config`` /
        ``_guard_no_stale_geographic_config``. Those guards refuse an override that
        changes a committed pair's knobs when the run does not re-bake the pair's layout
        and that layout records no ``source_fingerprint`` (baked before manifest 2.10;
        LAYOUT_DESIGNER D-xxx): the manifest would then contradict its baked positions
        with nothing to say so. A replace IS the re-bake, so for those ids there is
        nothing to contradict, and on a pre-2.10 tree it is the way to change such a
        layout's knobs without a re-ingest.

    Logs are APPENDED to the dataset's existing ``ingest.log`` (the dataset exists by
    precondition) — the operator's progress view for a multi-hour 1M bake, alongside
    the live O1 progress channel (``job.meta`` / staging ``progress.json``). On full
    success returns ``{"dataset_version", "committed", "replaced", "failed": []}``
    (``committed`` is the layout_ids that landed, in order; ``replaced`` the subset of
    those that overwrote a committed layout); a partial failure RAISES the summary error
    above rather than returning (so ``failed`` in the return is always empty).
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
    # A pre-2.9 tree still carries column_roles.url, which this schema no longer
    # declares -- drop it, but ONLY once presentation.json demonstrably holds the same
    # setting, else refuse and name the migration (D-xvii; see drop_retired_roles).
    committed_manifest = drop_retired_roles(committed_manifest, dataset_dir)
    roles, roles_overridden = _effective_roles(committed_manifest, payload.column_roles)
    # Value-level re-validation of the effective roles against the READ-ONLY
    # committed parquet (no CSV re-join — metadata.parquet is the frozen source here).
    _validate_roles_against_parquet(roles, metadata_path, committed_manifest)

    # Resolve specs -> concrete layout_ids (bare type => all its entries; expanded id
    # => that one), against the effective roles, then collision-guard.
    resolved = _resolve_layout_specs(payload.layout_specs, roles)
    existing_ids = {layout["layout_id"] for layout in committed_manifest.get("layouts", [])}
    replacing = _guard_replace_targets(payload.replace, resolved, existing_ids)
    _guard_no_collision(resolved, existing_ids, replacing)
    if roles_overridden:
        # Which committed layouts record a fingerprint is read ONCE, for both guards.
        fingerprinted = _fingerprinted_layout_ids(committed_manifest)
        # An override must not silently re-describe the knobs of a COMMITTED
        # scatter/geographic layout that this run does not re-bake and that records no
        # `source_fingerprint` (baked before manifest 2.10): the manifest would contradict
        # the bake and nothing would say so. A layout that records one reports that
        # staleness itself, so the guards stand down for it (LAYOUT_DESIGNER D-xxx).
        # D-35 Seam G2 extends the guard to the geographic family (projection).
        # A layout being REPLACED is exempt: this run re-bakes it, so its positions and
        # its `options` echo will be rewritten from the new knobs and there is nothing
        # left to contradict. On a pre-2.10 tree that exemption is the one way to change
        # such a layout's knobs without a re-ingest.
        _guard_no_stale_scatter_config(
            committed_manifest, roles, existing_ids - replacing, fingerprinted
        )
        _guard_no_stale_geographic_config(
            committed_manifest, roles, existing_ids - replacing, fingerprinted
        )

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
                    if layout_id in replacing:
                        # The flip above re-pointed this entry at `_v{version}`, so the
                        # SUPERSEDED container + position table are now unreferenced.
                        # Derived from the just-flipped manifest on disk (never from an
                        # assumed version): add-layouts builds MIXED-version trees, so
                        # "anything but the current dataset_version" would delete live
                        # siblings. AFTER the flip, inside the lock — an in-flight reader
                        # still on the old manifest resolved its old paths through the
                        # flip window, exactly as the detail tier is lifecycled.
                        swept, swept_bytes = _sweep_layout_assets(
                            dataset_dir,
                            json.loads(
                                (dataset_dir / "layout_manifest.json").read_text(
                                    encoding="utf-8"
                                )
                            ),
                            [layout_id],
                        )
                        logger.info(
                            "replaced layout %s: swept %d superseded file(s), %d bytes: %s",
                            layout_id, len(swept), swept_bytes,
                            [p.name for p in swept] or "none",
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
            "add-layouts done: committed=%s (dataset_version=%d, replaced=%s)",
            committed_layout_ids, version,
            [lid for lid in committed_layout_ids if lid in replacing] or "none",
        )
        return {
            "dataset_version": str(version),
            "committed": list(committed_layout_ids),
            # Which of those OVERWROTE a committed layout rather than adding one. The
            # screen needs the distinction (a re-bake resolves a stale flag; an append
            # does not), and it is not recoverable from `committed` alone.
            "replaced": [lid for lid in committed_layout_ids if lid in replacing],
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


class LayoutLifecycleError(ValueError):
    """A ``delete-layout`` / ``set-roles`` run that REFUSED to proceed — the layout is
    not committed, removing it would leave the dataset with zero layouts, or another
    writer changed ``layout_manifest.json`` while this job was validating. Carries a
    human-readable message the CLI prints cleanly (no traceback for the expected
    refusals), exactly as ``RefreshManifestError`` does for ``refresh-manifest``.

    A ``ValueError`` subclass on purpose: every other refusal in this module
    (``_guard_no_collision``, ``_align_cache_to_committed``, ``ColumnRoleError``) is a
    ``ValueError``, so a caller that already catches that keeps working and the
    dedicated type only buys the CLI a clean message."""


def run_delete_layout(payload: "DeleteLayoutJobPayload") -> dict:
    """Remove ONE committed layout from a dataset — the manifest entry and the bytes it
    owned ([[T2-a-layout-cannot-be-deleted-only-the-whole]]; LAYOUT_DESIGNER D-xxii).
    No decode, no thumbs, no bake: this is a manifest rewrite plus a scoped sweep, and
    it is a WORKER job only because ``layout_manifest.json`` is worker-written and only
    worker-written (D-xv / D-15).

    REFUSES (``LayoutLifecycleError``, nothing written) when the layout is not committed,
    or when removing it would leave ZERO layouts. D-viii moved the guarantee from "grid
    always exists" to "the DEFAULT LAYOUT RESOLVES", and it cannot resolve against an
    empty list; ``layouts`` is also ``minItems: 1`` in
    ``schemas/v2/layout_manifest.schema.json``, so this is a validation failure too. It
    is checked BEFORE the write rather than left to the validator so the operator gets a
    sentence instead of a jsonschema traceback.

    WHAT IT TOUCHES. ``layout_manifest.json`` (rewritten through ``manifest.py``'s sole
    writer, ``revalidate_and_write`` — validate then temp+rename), then, only AFTER that
    flip has succeeded, ``tiles/{layout_id}/`` and that layout's
    ``positions/{layout_id}_v{N}.arrow``. The sweep is LAST for the reason
    ``_sweep_stale_detail`` is last: a crash mid-operation must leave orphaned bytes,
    never a live manifest pointing at files that are gone. Every surviving layout entry
    is carried through BYTE-PRESERVED (the exact dict the prior bake wrote), so their
    version-stamped pyramid/positions/detail paths keep resolving.

    WHAT IT DOES NOT TOUCH. ``presentation.json``, ``metadata.parquet``, the detail tier,
    ``tags/``, and every sibling layout. A ``layouts.<id>.label`` override or a
    ``dataset.default_layout`` naming the layout just deleted is deliberately LEFT
    DANGLING: D-xvi says a dangling reference falls back on read and is never an error,
    and repairing it here would make the worker a second writer of the presentation
    record — the exact failure the two-record split exists to prevent (D-xv). The
    ``column_roles`` entry the layout was derived from is left alone too: the role is a
    declaration about the METADATA, not about this bake, so deleting the layout must not
    silently un-declare the column (and ``add-layouts`` can then re-bake it).

    ``dataset_version`` BUMPS. Reasoning, because the next reader will ask and the two
    existing precedents point opposite ways — the append path always bumps,
    ``refresh-manifest`` deliberately does not:

      * The line between them is not "did a bake run", it is **did the set of live
        assets change**. ``refresh-manifest`` re-describes the SAME bake (its own
        docstring: "the version-stamped pyramids/positions/tags are unchanged, so
        re-stamping the version would only invalidate immutable caches for no new
        bytes"). A delete changes which ``pyramid.path`` and ``positions_ref`` blocks
        resolve at all, and then DELETES the files the old manifest named — a reader
        holding the previous manifest now 404s. That is the first category.
      * ``dataset_version`` is a client-side cache GENERATION for manifest-derived
        state, not only a path stamp. Measured 2026-09-09 in
        ``packages/frontend/src/renderer/detailOverlay.ts``: line 303 keys the detail
        cache as ``{dataset_id}/v{dataset_version}/{cellId}`` and line 710 drops the
        cache when ``dataset_version`` changes. Bumping is how a client is told the
        dataset moved under it.
      * It costs nothing here. The bump allocates a NUMBER, not a path: this verb writes
        no version-stamped file, so unlike a bake it does not have to. (The API's
        versioned tile route gates on the detail block's own ``v{N}`` prefix and NOT on
        ``dataset_version`` — ``routers/tiles.py`` — so the bump cannot orphan the
        retained detail tier.)

    ``manifest_version`` is NOT re-stamped. ``append_manifest_layouts`` and
    ``refresh-manifest`` re-stamp because they ADD current-MINOR fields, so the file has
    to self-describe what it now contains. This verb only removes an entry and carries
    the rest byte-preserved, so the committed minor stays truthful; re-stamping would be
    a claim about content that is not there.

    CONCURRENCY. The read-modify-write is a COMPARE-AND-SET under ``_commit_lock``: the
    manifest bytes are re-read inside the lock and the run refuses if they changed while
    it was validating, so this verb can never write from a stale snapshot. The reverse
    direction is NOT closed and is not closeable here — an ``add-layouts`` run that
    STARTED BEFORE this one assembles its flip from the manifest it read at job start,
    so it will resurrect the deleted entry (pointing at files this verb just swept). That
    is a pre-existing property of ``run_add_layouts`` shared with ``refresh-manifest``,
    the pipeline has no per-dataset view of RQ state with which to detect it, and the
    refusal therefore belongs in the API, which does (``DatasetSummary.active_job_id``).
    Filed as [[T2-a-manifest-rewrite-can-be-reverted-by-an-in]].

    Returns ``{"dataset_id", "deleted", "dataset_version", "layouts", "swept"}`` —
    ``layouts`` is the surviving layout_ids in manifest order, ``swept`` the files
    actually removed (dataset-relative, sorted)."""
    output_root = Path(payload.output_root)
    dataset_dir = output_root / payload.dataset_id
    manifest_path = dataset_dir / "layout_manifest.json"

    # --- Preconditions (before any side effect, including the log) ------------------
    # Every refusal below this line is raised BEFORE `_setup_logger`, so a refused run
    # leaves no `ingest.log` at all — see the `except LayoutLifecycleError` handler, which
    # therefore only ever sees the compare-and-set refusal.
    if not dataset_dir.is_dir():
        raise FileNotFoundError(
            f"delete-layout: dataset {payload.dataset_id!r} not found at {dataset_dir}"
        )
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"delete-layout: {manifest_path} missing — not a committed dataset"
        )

    committed_bytes = manifest_path.read_bytes()
    manifest = json.loads(committed_bytes.decode("utf-8"))
    # A pre-2.9 tree still carries column_roles.url, which this schema no longer declares
    # -- drop it, but ONLY once presentation.json demonstrably holds the same setting,
    # else refuse and name the migration (D-xvii; see drop_retired_roles). Without this
    # the `revalidate_and_write` below would fail the whole delete on an unrelated field.
    manifest = drop_retired_roles(manifest, dataset_dir)

    layouts = list(manifest.get("layouts", []))
    committed_ids = [layout.get("layout_id") for layout in layouts]
    if payload.layout_id not in committed_ids:
        raise LayoutLifecycleError(
            f"delete-layout: {payload.layout_id!r} is not a committed layout of "
            f"{payload.dataset_id!r}; committed layouts are {committed_ids}."
        )
    survivors = [
        layout for layout in layouts if layout.get("layout_id") != payload.layout_id
    ]
    if not survivors:
        raise LayoutLifecycleError(
            f"delete-layout: {payload.layout_id!r} is the ONLY layout of "
            f"{payload.dataset_id!r} and removing it would leave the dataset with none. "
            f"D-viii's guarantee is that the default layout RESOLVES, which it cannot "
            f"against an empty list (`layouts` is minItems: 1 in the v2 schema). Bake a "
            f"replacement with `pixscope add-layouts` first, or delete the whole dataset."
        )

    manifest["layouts"] = survivors
    manifest["dataset_version"] = int(manifest.get("dataset_version", 0)) + 1

    logger, handler = _setup_logger(dataset_dir / "ingest.log")
    try:
        logger.info(
            "delete-layout start dataset=%s owner=%s layout=%s committed=%s",
            payload.dataset_id, payload.owner, payload.layout_id, committed_ids,
        )
        with _commit_lock(payload.dataset_id):
            # COMPARE-AND-SET: another writer (an add-layouts flip, a refresh-manifest)
            # may have landed between the read above and this lock. Refuse rather than
            # clobber it -- the whole plan, including the "would leave zero layouts"
            # check, was computed against bytes that are no longer current.
            if manifest_path.read_bytes() != committed_bytes:
                raise LayoutLifecycleError(
                    f"delete-layout: layout_manifest.json of {payload.dataset_id!r} "
                    f"changed while this job was validating (another bake or manifest "
                    f"rewrite committed). Nothing was written — re-run once it finishes."
                )
            revalidate_and_write(manifest, manifest_path)
            # AFTER the flip, never before (the ordering `_sweep_stale_detail` uses): a
            # crash here leaves orphaned bytes, which is recoverable, instead of a live
            # manifest pointing at files that are gone, which is not.
            swept, swept_bytes = _sweep_layout_assets(
                dataset_dir, manifest, [payload.layout_id]
            )
        logger.info(
            "delete-layout done: removed %s (dataset_version=%d, %d layout(s) remain: "
            "%s); swept %d file(s), %d bytes: %s",
            payload.layout_id, manifest["dataset_version"], len(survivors),
            [layout.get("layout_id") for layout in survivors],
            len(swept), swept_bytes, [p.name for p in swept] or "none",
        )
        return {
            "dataset_id": payload.dataset_id,
            "deleted": payload.layout_id,
            "dataset_version": str(manifest["dataset_version"]),
            "layouts": [layout.get("layout_id") for layout in survivors],
            "swept": sorted(_dataset_relative(p, dataset_dir) for p in swept),
        }
    except LayoutLifecycleError as exc:
        # THE COMPARE-AND-SET REFUSAL, and only that one. The other two refusals — "not a
        # committed layout" and "would leave the dataset with none" — are raised in the
        # preconditions block ABOVE `_setup_logger`, so they never reach here, and that is
        # deliberate rather than a gap (2026-09-08 review finding 10 corrected the
        # opposite claim, which this comment used to make). A guard that costs nothing and
        # writes nothing must not be the thing that conjures an `ingest.log` onto a
        # dataset that had none — `run_refresh_manifest` states the same rule and
        # `test_delete_layout_refuses_the_last_layout_and_changes_nothing` pins it.
        # The compare-and-set refusal is different in kind: by the time it fires the log
        # is already open and already records this run's `start` line, so leaving it
        # without its outcome would be the actual omission.
        logger.warning("delete-layout REFUSED: %s (nothing was written)", exc)
        raise
    except BaseException:
        logger.exception("delete-layout FAILED for layout %s", payload.layout_id)
        raise
    finally:
        _close_logger(logger, handler)


def run_set_roles(payload: "SetRolesJobPayload") -> dict:
    """RE-DECLARE a committed dataset's ``column_roles`` with NO bake, and report what
    that stales ([[T2-a-role-cannot-be-changed-without-also-queueing]]; D-ix's
    declared-but-INVALIDATING tier, which until now had no write path at all —
    ``column_roles`` could only ride as a passenger on ``POST /datasets`` or on an
    ``add-layouts`` bake).

    NOTHING IS BAKED. No thumbnails are decoded, no tile is written, no pyramid, position
    table or detail original is read or written, and the only file this WRITES is
    ``layout_manifest.json`` (plus lines in ``ingest.log``). That is the entire point:
    changing the role is the cheap half, the bake is the expensive half, and the product
    fused them. Two files are READ and never written: ``metadata.parquet`` (the validator
    of record's source, D-11) and — schema only, its column names, not a row of data —
    the committed tag sidecar, so the fourth bucket below can be reported at all.

    VALIDATION is the SAME validation ``add-layouts --column-roles`` performs, reused and
    not re-written (D-11: the pipeline is the validator of record, not the client) —
    ``ColumnRoles.from_config`` for shape, then ``_validate_roles_against_parquet`` for
    values against the READ-ONLY committed ``metadata.parquet``: the ``filename`` join key
    and every referenced enrichment column present, the typed columns typed as ingest
    wrote them, and the scatter/geographic knob preconditions (log => strictly positive,
    none => within [0,1], lon/lat range, unimplemented overlap). The roles are a FULL
    replacement, never a patch.

    The COMMITTED map is parsed too, but ONLY for the advisory diff, and a failure there
    does not refuse the run — it degrades to "no before state", so every column reads as
    changed and the run still repairs the map. See the ``try`` around
    ``_effective_roles`` below for why the one verb that can fix a stale roles map must
    not be stopped by that map.

    THE STALE SET is returned, not inferred downstream: ``stale_layouts`` are the
    committed layouts one of whose OWN role-entry fingerprints the new map no longer
    declares (v2.10 — per ENTRY, not per column, so a second pair landing on a column an
    untouched layout shares does not stale it), and ``unknown_layouts`` are the pre-2.9
    entries that recorded no provenance and therefore cannot be judged — see
    ``_classify_layout_staleness`` for why absence is never read as "depends on nothing"
    and why "no entry to compare" reads as stale. ``changed_columns`` is returned
    alongside so the caller can name the cause, and a pure LABEL edit changes nothing and
    stales nothing (D-xx: labels are a free tier-1 edit).

    WHAT IT DOES *NOT* GUARD, deliberately. ``add-layouts`` refuses a roles override that
    changes the knobs of a committed scatter/geographic layout it does not re-bake, when
    that layout records no ``source_fingerprint`` (``_guard_no_stale_scatter_config``;
    since LAYOUT_DESIGNER D-xxx only then — a layout baked since manifest 2.10 reports the
    staleness itself), because nothing would ever say that its manifest contradicts its
    baked positions. Those guards are NOT applied here, and the difference is the whole seam: a
    declared/baked divergence IS what "stale" means (LAYOUT_DESIGNER §5 — *"changing
    date_made's format on a collection with a baked datetime layout flags exactly that
    layout stale ... and leaves its tiles byte-identical until a re-bake commits"*), the
    layout's own ``options`` echo still records what was actually baked so no consumer is
    misled, and ``add-layouts --replace`` now exists as the way back. Refusing here would
    make the designed flow — change a role, see what it staled, re-bake it — unreachable.

    THE TAG SIDECAR IS THE FOURTH BUCKET. ``tag`` roles are declared in ``column_roles``
    but SERVED from ``tags/tags_v{N}.arrow``, which only a bake writes — so a roles-only
    edit can declare a tag role the committed sidecar cannot serve (an empty filter, and
    silent), or strip the last tag role while ``manifest.tags`` still points at a live
    sidecar. ``unserved_tag_roles`` and ``stale_tag_sidecar`` name both; see
    ``_classify_tag_sidecar``. The SIDECAR is never re-staged here (that needs a bake),
    but the second case is also FIXED and not just named: with no tag role declared, the
    ``tags`` block is removed from the manifest this verb is already rewriting, because no
    bake would ever have repointed it (2026-09-10 round-2 review finding B2 — see the
    ``manifest.pop("tags")`` below). The sidecar file is left on disk, unreferenced.

    ``dataset_version`` does NOT bump and no version-stamped asset moves: this is the
    same bake, differently DECLARED. ``manifest_version`` is re-stamped ONLY when every
    committed layout entry already carries ``source_columns`` — the stamp describes the
    whole FILE, and the entries are carried forward untouched, so re-stamping a pre-2.9
    tree to 2.9 would claim a key those entries do not have. Same rule
    ``run_delete_layout`` states; see the write below.

    UNPRODUCIBLE LAYOUTS ARE REPORTED, NOT REFUSED, and split by CAUSE. A committed id the
    new roles cannot produce is either RENAMED (an entry with the SAME source columns, in
    the same order, is still declared; only the family's naming convention moved, because
    the entry count crossed 1 — ``renamed_layouts`` maps old id -> new id) or ORPHANED
    (nothing declared reproduces that provenance — the role is gone, or a pair family was
    re-paired; ``orphaned_layouts``). They get opposite advice — re-bake under the new id
    and delete the old one, versus delete it or restore the role — and conflating them
    recommends deleting a live, untouched layout. See ``_classify_unproducible_layouts``.
    Refusing either was the alternative and is wrong for this seam: the same state is already
    reachable through ``add-layouts --column-roles``, ``refresh-manifest`` already refuses
    to touch an orphan with a message that names it, and blocking a legitimate role edit
    behind a layout the user may well be about to delete inverts the order the designer
    works in.

    CONCURRENCY: compare-and-set under ``_commit_lock``, exactly as ``run_delete_layout``
    — the manifest bytes are re-read inside the lock and the run refuses if they moved
    while it was validating. The reverse direction (an ``add-layouts`` run that started
    earlier flipping from its own start-of-job snapshot and losing this write) is a
    pre-existing property of ``run_add_layouts``, is not detectable from inside the
    pipeline, and is filed as [[T2-a-manifest-rewrite-can-be-reverted-by-an-in]]; the
    refusal belongs in the API, which can see ``DatasetSummary.active_job_id``.

    Preconditions (else a clear error, no side effects): the dataset dir, its
    ``layout_manifest.json`` and its ``metadata.parquet`` all exist. Returns
    ``{"dataset_id", "dataset_version", "manifest_version", "changed_columns",
    "stale_layouts", "unknown_layouts", "orphaned_layouts", "renamed_layouts",
    "unserved_tag_roles", "stale_tag_sidecar"}`` — ``renamed_layouts`` an
    ``{old id: new id}`` map, ``stale_tag_sidecar`` a dataset-relative path or None."""
    output_root = Path(payload.output_root)
    dataset_dir = output_root / payload.dataset_id
    manifest_path = dataset_dir / "layout_manifest.json"
    metadata_path = dataset_dir / "metadata.parquet"

    # --- Preconditions (before any side effect, including the log) ------------------
    # As in `run_delete_layout`: everything down to `_setup_logger` refuses without
    # opening `ingest.log`, so a rejected roles map leaves the tree byte-identical.
    if not dataset_dir.is_dir():
        raise FileNotFoundError(
            f"set-roles: dataset {payload.dataset_id!r} not found at {dataset_dir}"
        )
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"set-roles: {manifest_path} missing — not a committed dataset"
        )
    # This is NOT the images-only case, and saying so would be wrong: measured 2026-09-09,
    # an images-only ingest (decision D-25) still writes a metadata.parquet -- it holds
    # id + filename and the manifest simply omits `column_roles`
    # (`tests/fixtures/golden_dataset_images_only_v2` is exactly that shape). Such a tree
    # reaches `_validate_roles_against_parquet` normally and is refused there PER ROLE,
    # with the columns it does have named, which is the more useful message. This branch
    # is only for a tree missing the file outright.
    if not metadata_path.is_file():
        raise FileNotFoundError(
            f"set-roles: {metadata_path} missing — roles are validated against the "
            f"committed parquet (D-11), and there is nothing to validate against."
        )

    committed_bytes = manifest_path.read_bytes()
    manifest = json.loads(committed_bytes.decode("utf-8"))
    # A pre-2.9 tree still carries column_roles.url, which this schema no longer declares.
    # Drop it only once presentation.json demonstrably holds the equivalent, else refuse
    # and name the migration (D-xvii; see drop_retired_roles). Runs BEFORE the diff so the
    # retired key cannot register as a role this edit removed.
    manifest = drop_retired_roles(manifest, dataset_dir)

    # The COMMITTED map is parsed for ONE purpose — the advisory diff — so a committed map
    # the current schema no longer accepts must not be able to refuse this run. It is the
    # one verb that can repair such a map, and `column_roles.schema.json` is
    # `additionalProperties: false`, so the next retirement (`url` was the last, and
    # `drop_retired_roles` special-cases it) would otherwise arm a
    # `jsonschema.ValidationError` about the OLD roles that aborts the write of the new
    # ones — surfacing as a traceback, since the CLI catches only `LayoutLifecycleError`
    # (2026-09-09 review finding 6). Degrade to None instead: `_role_fingerprints(None)`
    # is `{}`, so every column of the new map reads as CHANGED and every judgeable layout
    # comes back stale. Over-reporting staleness is the safe direction — the operator is
    # told to re-bake more than strictly necessary, rather than told nothing.
    try:
        committed_roles, _ = _effective_roles(manifest, None)
    except jsonschema.ValidationError as exc:
        committed_roles = None
        unparseable_committed_roles = str(exc.message)
    else:
        unparseable_committed_roles = ""
    # `_effective_roles`' override branch, verbatim and called directly: the override is
    # REQUIRED here (a roles edit with no roles is not a thing), so the `| None` that
    # function returns for the images-only DEFAULT has no meaning on this path.
    roles = ColumnRoles.from_config(payload.column_roles)  # shape-validates
    _validate_roles_against_parquet(roles, metadata_path, manifest)

    changed_columns = _changed_role_columns(committed_roles, roles)
    # `changed_columns` stays WHOLE-COLUMN — it answers "which columns changed?", which is
    # a question about columns. The stale set is PER ENTRY (v2.10): see
    # `_classify_layout_staleness`, which takes both role maps rather than that list.
    stale_layouts, unknown_layouts = _classify_layout_staleness(
        manifest,
        committed_roles,
        roles,
        # The dataset-level fail-safe, and the reason it is a FLAG rather than
        # `committed_roles is None`: an images-only dataset also has no roles, and has no
        # column-reading layout to report. Only an UNREADABLE map means "re-check
        # everything" — and it is the sentence logged to ingest.log just below.
        roles_unreadable=bool(unparseable_committed_roles),
    )
    renamed_layouts, orphaned_layouts = _classify_unproducible_layouts(manifest, roles)
    unserved_tag_roles, stale_tag_sidecar = _classify_tag_sidecar(
        manifest, dataset_dir, roles
    )

    # The roles are re-serialized through the EMITTER (`manifest._roles_to_dict`), never
    # written back as the caller supplied them: that is what makes the committed bytes
    # identical to what a bake would have written for the same roles — defaults applied,
    # non-default knobs echoed, retired keys structurally absent — instead of whatever
    # shape the client happened to post.
    manifest["column_roles"] = _roles_to_dict(roles)
    # NO TAG ROLE => NO `tags` BLOCK, cleared HERE (2026-09-10 round-2 review finding B2).
    # This verb used to only REPORT the leftover block and name `add-layouts
    # --column-roles` as the remedy — which cannot work: `_stage_tags_sidecar` returns None
    # the moment the effective roles carry no tag role, so `_commit_one_layout` passes
    # `tags_path=None` and `append_manifest_layouts` carries the committed `tags` dict
    # straight through. Measured 2026-09-10 by driving `append_manifest_layouts` directly
    # on the `golden_dataset_full_v2` manifest: the block survives every add-layouts run,
    # however complete the command, so the warning named a state with no way out short of
    # a full re-ingest.
    #
    # Fixing it HERE, at the verb that creates the state, rather than on the bake path:
    # `set-roles` already rewrites this manifest, the schema's own words for the block are
    # *"Null or absent when the dataset has no tag-role columns"* (so a roles map with no
    # tag role and a `tags` block is a file contradicting itself), and it leaves
    # `append_manifest_layouts` — the sole writer of a committed manifest, shared with the
    # ingest path — untouched. The equivalent hole on `add-layouts --column-roles` is
    # filed as [[T2-add-layouts-carries-a-stale-tags-block-through]].
    #
    # The sidecar FILE is NOT removed. It is a version-stamped baked asset, this verb
    # bakes nothing and sweeps nothing, and an unreferenced file costs bytes while a
    # deleted one costs a re-bake if the role comes back. `stale_tag_sidecar` returns its
    # path so the caller can say which file is now referenced by nothing.
    if not roles.tag:
        manifest.pop("tags", None)
    # THE STAMP MOVES ONLY WHEN THE WHOLE FILE EARNS IT (2026-09-09 review finding 4). The
    # `column_roles` block just written IS current-minor content, which is why this used to
    # re-stamp unconditionally — but the stamp describes the FILE, and the layout entries
    # are carried forward untouched. On a pre-2.9 tree those entries record no
    # `source_columns`, so a 2.9 stamp claims a key they do not carry: the CLI would print
    # "baked before manifest 2.9, so they record no source_columns" about a manifest it
    # had just stamped 2.9. Not writing `url` is valid under 2.8 and 2.9 alike, so leaving
    # the committed stamp is truthful, and it makes this verb obey the rule
    # `run_delete_layout` already states ("re-stamping would be a claim about content that
    # is not there"). The keys at issue are the ones a MINOR added to a carried-forward
    # entry: `source_columns` (2.9) and now `source_fingerprint` (2.10). This verb writes
    # NEITHER — a roles-only commit bakes nothing, and after it the committed roles are
    # exactly not what the bake read — so the stamp waits until a bake or a Gate-B-checked
    # `refresh-manifest` has put the key on every entry.
    manifest_version = manifest.get("manifest_version")
    if all(
        isinstance(entry.get("source_columns"), list)
        and isinstance(entry.get("source_fingerprint"), dict)
        for entry in manifest.get("layouts", [])
    ):
        manifest_version = MANIFEST_VERSION
        manifest["manifest_version"] = manifest_version
    # `dataset_version` is deliberately NOT touched: same bake, new declaration.

    logger, handler = _setup_logger(dataset_dir / "ingest.log")
    try:
        logger.info(
            "set-roles start dataset=%s owner=%s changed_columns=%s",
            payload.dataset_id, payload.owner, changed_columns or "none",
        )
        if unparseable_committed_roles:
            # Say WHY everything reads as changed, or the diff looks like a bug. The write
            # goes ahead: this verb is the repair path for exactly this manifest.
            logger.warning(
                "set-roles: the COMMITTED column_roles of %s do not parse under the "
                "current schema (%s), so no before/after diff was possible — every "
                "column of the new map is reported as changed and every judgeable layout "
                "as stale. The new roles below REPLACE that map and are valid.",
                payload.dataset_id, unparseable_committed_roles,
            )
        with _commit_lock(payload.dataset_id):
            # COMPARE-AND-SET — see run_delete_layout. The stale set above describes a
            # diff against bytes that must still be the committed ones when we write.
            if manifest_path.read_bytes() != committed_bytes:
                raise LayoutLifecycleError(
                    f"set-roles: layout_manifest.json of {payload.dataset_id!r} changed "
                    f"while this job was validating (another bake or manifest rewrite "
                    f"committed). Nothing was written — re-run once it finishes."
                )
            revalidate_and_write(manifest, manifest_path)
        # EVERY COMMAND IN THE MESSAGES BELOW IS COMPLETE AND RUNNABLE (2026-09-10 round-2
        # review finding B1). They used to name fragments — `pixscope delete-layout`,
        # `pixscope add-layouts --column-roles <this file>` — which exit 2 if pasted. The
        # dataset id and the output root are known here and are interpolated; the images
        # directory and the roles FILE are not (this job receives a roles dict, not a
        # path), so those are single-token `<placeholders>`, per
        # `cli._print_ownership_next_steps`. The same commands are printed by
        # `cli._run_set_roles_cmd`, which can fill the roles path in.
        bake = (
            f"pixscope add-layouts --images <original-images-dir> "
            f"--dataset-id {payload.dataset_id} --output-root {payload.output_root}"
        )
        delete = (
            f"pixscope delete-layout --dataset-id {payload.dataset_id} "
            f"--output-root {payload.output_root}"
        )
        for old_id, new_id in sorted(renamed_layouts.items()):
            # NOT a warning and NOT the orphan message: nothing is wrong with these
            # layouts. Their role entry is still declared with exactly the same columns in
            # the same order; the family's naming convention moved under them because the
            # entry COUNT crossed 1. Logged one line per pair rather than one line for the
            # map, so the re-bake command can name the REAL ids instead of a placeholder.
            logger.info(
                "set-roles: layout %s keeps its column(s) but would now be baked as %s — "
                "the family's naming changed when the number of declared entries crossed "
                "one. Its committed tiles are untouched and still served. To adopt the "
                "new id, re-bake it with `%s --layout %s --sync` (add `--replace %s` if "
                "that id is itself already committed) and then remove the old entry with "
                "`%s --layout %s`.",
                old_id, new_id, bake, new_id, new_id, delete, old_id,
            )
        if orphaned_layouts:
            # LOUD, because it is the one outcome the caller cannot fix by re-baking: the
            # roles no longer describe these layouts at all, so `refresh-manifest` will
            # refuse the tree until they are deleted or the role is restored. The cause is
            # deliberately NOT asserted here — a renamed layout is reported above instead,
            # and an entry with no recorded provenance lands here without anyone being
            # able to say which column it lost (2026-09-09 review finding 1). A pair family
            # that was RE-PAIRED lands here too, and "restore the role they were baked
            # from" is the honest remedy for it (2026-09-10 round-2 finding A).
            logger.warning(
                "set-roles: layout(s) %s can no longer be produced from the new roles — "
                "no declared role reproduces those layout_ids from the column(s) they "
                "were baked from. They keep serving their committed tiles, but nothing "
                "can re-bake them: remove them with `%s --layout <layout-id>`, or restore "
                "the role — for a scatter or geographic layout, the exact column PAIR — "
                "they were baked from.",
                orphaned_layouts, delete,
            )
        if unserved_tag_roles:
            # The sidecar is a BAKED asset and this verb bakes nothing, so a tag role can
            # be declared over a column the committed sidecar does not carry. Nothing else
            # reports it and the frontend fails silently on it (an empty filter). The
            # re-stage is a bake, so it needs a layout to bake: naming a committed one with
            # `--replace` is the form that always exists.
            logger.warning(
                "set-roles: tag role(s) %s are declared but the committed tag sidecar "
                "does not carry them — the filter for each will come back EMPTY. Only a "
                "bake writes the sidecar: re-stage it with `%s --layout <layout-id> "
                "--replace <layout-id> --column-roles <column-roles.json> --sync`, naming "
                "any one committed layout (it is re-baked; the sidecar is staged once for "
                "the run).",
                unserved_tag_roles, bake,
            )
        if stale_tag_sidecar:
            # An action taken, not a defect left behind: the block was removed above,
            # because no bake would ever have repointed it (finding B2, and the comment at
            # the `manifest.pop` for why the fix lives at this verb).
            logger.info(
                "set-roles: these roles declare no tag column, so the manifest's `tags` "
                "block — which pointed at %s — was REMOVED, and the UI stops offering "
                "filters for the role that is gone. The sidecar file itself is left on "
                "disk, now referenced by nothing: no bake reads it and no verb sweeps it.",
                stale_tag_sidecar,
            )
        logger.info(
            "set-roles done: dataset_version=%s UNCHANGED, manifest_version=%s; "
            "changed columns %s; stale layouts %s; provenance unknown for %s; renamed %s",
            manifest.get("dataset_version"), manifest_version,
            changed_columns or "none", stale_layouts or "none",
            unknown_layouts or "none", renamed_layouts or "none",
        )
        return {
            "dataset_id": payload.dataset_id,
            "dataset_version": str(manifest.get("dataset_version")),
            "manifest_version": manifest_version,
            "changed_columns": changed_columns,
            "stale_layouts": stale_layouts,
            "unknown_layouts": unknown_layouts,
            "orphaned_layouts": orphaned_layouts,
            "renamed_layouts": renamed_layouts,
            "unserved_tag_roles": unserved_tag_roles,
            "stale_tag_sidecar": stale_tag_sidecar,
        }
    except LayoutLifecycleError as exc:
        # Same shape as `run_delete_layout`'s handler, and the same scope: the ONLY
        # `LayoutLifecycleError` this verb can raise is the compare-and-set refusal, which
        # fires with the log already open. Every other refusal (a missing dataset dir,
        # manifest or parquet; a role the parquet cannot serve) is raised in the
        # preconditions/validation block above `_setup_logger` and leaves no log behind.
        logger.warning("set-roles REFUSED: %s (nothing was written)", exc)
        raise
    except BaseException:
        logger.exception("set-roles FAILED for dataset %s", payload.dataset_id)
        raise
    finally:
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


# (The `_REFRESH_ENRICHED_MINOR` / `_parse_manifest_version` pair that used to live here is
# gone with the 2026-09-23 review's findings 4 and 7: refresh's "nothing to do" guard reads
# FIELD PRESENCE now, never the stamp, so there is no minor to compare against.)
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
    assume_roles_unchanged: bool = False,
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
    whatever the emitter's current MINOR is, not a fixed literal — but ONLY when every
    entry earns it; see the stamp below), a
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

    THE v2.10 FINGERPRINT BACKFILL, and why it is the ONE thing here that needs the
    operator's word. ``layoutEntry.source_fingerprint`` records HOW a layout read its
    columns, and only a BAKE may assert that — after a roles-only commit the committed
    roles are exactly *not* what the bake read, which is the whole point of D-xxix. Refresh
    is the single exception, because Gate B (``_assert_positions_reproduce``) RAISES unless
    the layout recomputed from the committed roles reproduces the baked position table. So
    for a layout that passes Gate B, *"these are the roles it was baked from"* is CHECKED,
    not asserted, and the fingerprint is written. For a layout Gate B could not run on — no
    ``positions_ref``, i.e. a pre-2.2 bake, the ones reported in ``positions_gate_skipped``
    — nothing has been checked, so the fingerprint is NOT written and any existing one is
    carried through untouched. ``assume_roles_unchanged`` (the CLI's
    ``--assume-roles-unchanged``) is the operator asserting what the software could not:
    *no role has changed since this collection was baked.* It is never implied.

    Returns ``{"dataset_id", "manifest_version", "layouts", "annotations", "backup",
    "backup_written", "positions_gate_skipped", "fingerprints_written"}``
    (``backup_written`` is False when a ``--force`` re-run kept an existing pristine
    ``.bak`` rather than writing a new one; ``fingerprints_written`` names the layouts this
    run recorded a v2.10 fingerprint for).
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
    # Same guard as add-layouts: a pre-2.9 tree carries column_roles.url, which
    # `_validate_manifest` (called by `revalidate_and_write` below) now rejects. Drop it
    # only once presentation.json holds the equivalent, else refuse and name the
    # migration (D-xvii; see `manifest.drop_retired_roles`).
    manifest = drop_retired_roles(manifest, dataset_dir)

    # Refuse a manifest that has NOTHING OUTSTANDING, unless --force (checked BEFORE
    # touching the log — a no-op run leaves ingest.log untouched).
    #
    # KEYED ON FIELD PRESENCE, NOT ON THE STAMP (2026-09-23 review, findings 4 and 7). It
    # used to read `manifest_version >= 2.5 AND some entry carries bbox_exact`, which broke
    # in both directions the moment 2.10 arrived:
    #
    #   * every EXISTING 2.5-2.9 collection — which is every collection — answered
    #     "nothing to do" while carrying no `source_fingerprint` at all, so the migration
    #     the schema, the CHANGELOG and D-xxix all describe as "one refresh-manifest run"
    #     could not be done without `--force`;
    #   * and once refresh stopped re-stamping a file whose entries do not all carry the
    #     key, a fully-enriched tree could sit at an old stamp for ever, so the guard never
    #     fired again and every flagless run re-derived and rewrote the manifest.
    #
    # Field presence is the reader rule this repo states everywhere else ("READERS MUST
    # GATE ON FIELD PRESENCE, NEVER ON manifest_version", manifest.py), and it is the only
    # one that answers the question actually being asked: is there work left to do?
    layouts = manifest.get("layouts", [])
    outstanding = [
        key
        for key in ("bbox_exact", "missing_count", "source_columns")
        if any(key not in layout for layout in layouts)
    ]
    # `source_fingerprint` is outstanding only where THIS RUN COULD FILL IT: Gate B fills a
    # layout that has a baked position table, and `--assume-roles-unchanged` fills the rest.
    # Counting a permanently-unfillable gap as work is what turned the guard into a treadmill
    # — a pre-2.2 layout can never be checked, so every flagless run would re-derive and
    # rewrite the whole manifest for a key it was never going to write.
    if any(
        "source_fingerprint" not in layout
        and (assume_roles_unchanged or layout.get("positions_ref"))
        for layout in layouts
    ):
        outstanding.append("source_fingerprint")
    if not outstanding and not force:
        # NAME THE UNFILLABLE GAP AND THE FLAG THAT FILLS IT (2026-09-24 round-2 review,
        # N3). "Nothing to do" is false when a layout is still unchecked and the only
        # reason this run cannot check it is that Gate B has no position table to check
        # against — the operator can change that answer, and the message has to say so or
        # the refusal reads as "you are done" when the collection is still unchecked.
        unfillable = [
            layout["layout_id"]
            for layout in layouts
            if "source_fingerprint" not in layout
        ]
        remedy = (
            f" Layout(s) {unfillable} still record nothing about how they read their "
            f"columns, and the per-cell reproduction gate cannot check them (no baked "
            f"position table). Re-run with --assume-roles-unchanged to record it anyway — "
            f"which asserts that no role has changed since this collection was baked."
            if unfillable
            else ""
        )
        raise RefreshManifestError(
            f"refresh-manifest: dataset {dataset_id!r} is already at manifest_version "
            f"{manifest.get('manifest_version')!r} and every layout entry carries every "
            f"derived field this run could write (bbox_exact, missing_count, "
            f"source_columns, source_fingerprint) — nothing to do. Re-run with --force to "
            f"re-derive and overwrite (e.g. after a layout-plugin change).{remedy}"
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
        # v2.10: which layouts this run was ALLOWED to record a fingerprint for — the ones
        # Gate B checked, plus every layout when the operator asserted it (see the
        # docstring). Reported, because "how many of your layouts can now say whether they
        # are stale" is the whole point of the run on a pre-2.10 tree.
        fingerprints_written: list[str] = []
        # Layouts whose existing record contradicts the committed roles, where the operator
        # asserted the opposite. Reported, never acted on — see the warning below.
        assumption_contradicted: list[str] = []
        for layout in manifest["layouts"]:
            result = results_by_id[layout["layout_id"]]
            bbox_exact = [float(v) for v in result.bbox]
            _assert_bbox_consistent(layout, bbox_exact)
            gate_b_ran = _assert_positions_reproduce(
                dataset_dir, layout, result, image_count, logger
            )
            if not gate_b_ran:
                positions_gate_skipped.append(layout["layout_id"])
            # THE FLAG FILLS A GAP; IT NEVER OVERWRITES A RECORD (2026-09-23 review,
            # finding 3). `--assume-roles-unchanged` asserts "no role has changed since
            # this collection was baked" — an assertion about layouts that have NOTHING to
            # say. A layout that already carries a `source_fingerprint` has said it, and a
            # record that DISAGREES with the committed roles is the direct evidence that
            # the assertion is false. Overwriting it would launder a durably stale layout
            # to fresh, which is the one outcome this whole seam exists to prevent. So the
            # flag only reaches entries with no record; Gate B, which CHECKS rather than
            # asserts, may still re-derive one.
            has_record = isinstance(layout.get("source_fingerprint"), dict)
            checked = gate_b_ran or (assume_roles_unchanged and not has_record)
            if checked:
                fingerprints_written.append(layout["layout_id"])
            elif assume_roles_unchanged and has_record:
                # Say it rather than silently decline: the operator asked for this layout
                # to be filled in, and is being told why it was not — and, when the record
                # contradicts the roles, that the layout is durably stale and needs a bake.
                recorded = _recorded_fingerprint(layout)
                current = _comparable_fingerprint(result.source_fingerprint)
                if recorded != current:
                    assumption_contradicted.append(layout["layout_id"])
                    logger.warning(
                        "refresh-manifest: layout %s already records how it read its "
                        "columns, and that record DISAGREES with the committed roles — "
                        "which is evidence that a role HAS changed since this collection "
                        "was baked. --assume-roles-unchanged did not overwrite it. This "
                        "layout is durably stale: re-bake it (add-layouts --replace %s) "
                        "rather than re-declaring it.",
                        layout["layout_id"], layout["layout_id"],
                    )
            enriched.append(
                _enrich_layout_entry(
                    layout,
                    bbox_exact,
                    result.annotations,
                    result.missing_count,
                    result.source_columns,
                    result.source_fingerprint if checked else None,
                )
            )
            if result.annotations is not None:
                derived_annotations += 1
            if result.missing_count:
                missing_by_layout[layout["layout_id"]] = result.missing_count

        # THE STAMP MOVES ONLY WHEN THE WHOLE FILE EARNS IT — the rule `run_set_roles` and
        # `run_delete_layout` already state, now obeyed here too (v2.10). This used to be
        # unconditional, which was harmless while every field refresh writes was written on
        # EVERY entry; `source_fingerprint` is the first one it may have to leave off (a
        # layout Gate B could not check), and stamping 2.10 over a file where no entry
        # carries the key is precisely "the stamp claims content that is not there". When
        # it cannot move, the committed stamp is LEFT — under-claiming a minor is safe
        # because readers gate on FIELD PRESENCE, never on `manifest_version`.
        manifest_version = manifest.get("manifest_version")
        if all(isinstance(entry.get("source_fingerprint"), dict) for entry in enriched):
            manifest_version = MANIFEST_VERSION
        manifest["manifest_version"] = manifest_version
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
            "dataset_version %s UNCHANGED; backup=%s; positions gate skipped on %s; "
            "source_fingerprint written for %s",
            len(manifest_ids), manifest_version, derived_annotations,
            missing_by_layout or "none",
            manifest.get("dataset_version"), backup_path.name,
            positions_gate_skipped or "none",
            fingerprints_written or "none",
        )
        return {
            "dataset_id": dataset_id,
            "manifest_version": manifest_version,
            "layouts": manifest_ids,
            "annotations": derived_annotations,
            # v2.6: {layout_id: count} for every layout with something unplaced (empty when
            # every layout placed everything). The CLI prints it; the caller can diff it
            # against the committed manifest to see what this run changed.
            "missing_counts": missing_by_layout,
            "backup": str(backup_path),
            "backup_written": backup_written,
            "positions_gate_skipped": positions_gate_skipped,
            # v2.10: the layouts whose bake record now says HOW they read their columns.
            "fingerprints_written": fingerprints_written,
            # ...and those whose EXISTING record contradicts the roles the operator
            # asserted were unchanged. Empty without the flag.
            "assumption_contradicted": assumption_contradicted,
            # Every layout the REWRITTEN manifest leaves carrying a record, however it got
            # one. The CLI subtracts this from its "still unchecked" list: a layout that
            # already said how it read its columns is not unchecked, and recommending
            # `--assume-roles-unchanged` over it is how a stale layout reads fresh.
            "has_record": [
                layout["layout_id"]
                for layout in enriched
                if isinstance(layout.get("source_fingerprint"), dict)
            ],
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
     "positions_ref", "options", "annotations", "missing_count", "source_columns",
     "source_fingerprint", "detail"}
)


def _enrich_layout_entry(
    layout: dict,
    bbox_exact: list[float],
    annotations: dict | None,
    missing_count: int,
    source_columns: tuple[str, ...],
    source_fingerprint: dict[str, tuple[tuple, ...]] | None,
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
    ``edges`` — is carried through last so refresh never silently drops data.

    The v2.9 ``source_columns`` is written on the same terms, which makes refresh the
    BACKFILL path for provenance: refresh recomputes every layout through the REAL plugins
    from the manifest's own ``column_roles`` — the very thing provenance names — so a
    pre-2.9 tree gains it with no bake and no ``dataset_version`` bump. Unconditional for
    the emitter's reason: ``[]`` is grid's real answer and must stay distinguishable from
    the silence that means pre-2.9.

    The v2.10 ``source_fingerprint`` is the ONE field here that is CONDITIONAL, and the
    caller decides: ``None`` means "this run could not check that the committed roles are
    the ones this layout was baked from", and then an EXISTING recorded fingerprint is
    carried through BYTE-FOR-BYTE and no new one is invented. That is the whole reason
    this key had to be named in ``_LAYOUT_ENTRY_KNOWN`` *and* re-emitted here: adding it to
    that set without writing it back would drop every recorded fingerprint on the floor and
    turn every checkable layout unchecked, silently. A non-None value is written on the
    emitter's terms, ``{}`` included."""
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
    entry["source_columns"] = list(source_columns)
    if source_fingerprint is not None:
        entry["source_fingerprint"] = fingerprint_to_json(source_fingerprint)
    elif "source_fingerprint" in layout:
        entry["source_fingerprint"] = layout["source_fingerprint"]
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
) -> list[tuple[tuple[str, ...], str]] | None:
    """(source columns, label) per role entry for the multi-entry layout families —
    categorical, scatter, and geographic (D-26 / D-35 / recon. #9). None for plugins that
    compute exactly once from no entry list (grid, datetime).

    THE COLUMNS TUPLE IS THE ENTRY'S WHOLE PROVENANCE, byte-for-byte what the plugin
    records as ``LayoutResult.source_columns``: ``(column,)`` for categorical,
    ``tuple(dict.fromkeys((x_column, y_column)))`` for scatter and the lon/lat equivalent
    for geographic — the de-dupe included, so a scatter plotted against itself provenances
    as one column in both places. Its FIRST member is the entry's PRIMARY axis (scatter x
    / geographic lon), whose slug names the expanded layout_id for a multi-entry family.

    ONE ACCESSOR RATHER THAN TWO because a rename is decided by comparing a committed
    entry's whole provenance against a fresh entry's, and the primary column alone cannot
    tell a RE-PAIRED scatter from a renamed one — keeping ``x`` and repointing ``y``
    matched on the primary and was reported as a rename to an id that bakes different data
    (2026-09-10 round-2 review finding A). A second accessor returning just the primary
    would be free to drift from this one; ``columns[0]`` cannot."""
    if roles is None:
        return None
    if plugin.name == "categorical":
        return [((e.column,), e.label) for e in roles.categorical]
    if plugin.name == "scatter":
        return [(tuple(dict.fromkeys((e.x_column, e.y_column))), e.label) for e in roles.scatter]
    if plugin.name == "geographic":
        return [
            (tuple(dict.fromkeys((e.lon_column, e.lat_column))), e.label)
            for e in roles.geographic
        ]
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
    for i, (columns, label) in enumerate(entries):
        layout_id = plugin.name
        if multi:
            # On a slug collision the convention appends "-{i}" (the entry index),
            # re-suffixed until unique so two expanded layouts never write to the
            # same PMTiles container — distinct pyramids are what the D-10
            # identical-id-set transition invariant rests on.
            # The PRIMARY axis names the family member: `columns[0]` is the categorical
            # column / the scatter x / the geographic lon (see `_family_entries`).
            base = layout_id = f"{plugin.name}_{_slug(columns[0])}"
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


# The ONLY fields a detail transcode keeps. Everything else libvips has attached to the
# image is removed before the save — an ALLOWLIST, so a carrier nobody here has heard of
# (a new loader, a renamed field, a libvips upgrade) fails CLOSED instead of riding into
# a file served to every viewer. A denylist of known prefixes was the first version of
# this and was rejected in review for exactly that: it is silent about what it does not
# list.
#
# What is kept and why: libvips header/geometry fields, which are not metadata and are
# what the image IS; loader bookkeeping, which savers never write into the output file;
# and `icc-profile-data`, the one deliberate exception — see `_drop_source_metadata`.
_KEEP_FIELDS = frozenset(
    {
        # structure / geometry
        "width", "height", "bands", "format", "coding", "interpretation",
        "xoffset", "yoffset", "xres", "yres", "resolution-unit", "orientation",
        "n-pages", "page-height", "bits-per-sample", "palette",
        # loader bookkeeping (not written into the saved file)
        "filename", "vips-loader", "vips-sequential",
        "jpeg-chroma-subsample", "jpeg-multiscan",
        # the deliberate exception
        "icc-profile-data",
    }
)

# EXIF that libvips writes ITSELF on save — resolution, pixel dimensions, colourspace,
# version stamps. Every JPEG this pipeline reads carries these whether or not a camera
# ever touched it (measured: a `pyvips.Image.black(...).jpegsave()` round-trips with 12
# such fields).
_STRUCTURAL_EXIF_FIELDS = frozenset(
    {
        "exif-data",
        "exif-ifd0-XResolution", "exif-ifd0-YResolution", "exif-ifd0-ResolutionUnit",
        "exif-ifd0-YCbCrPositioning", "exif-ifd0-Orientation",
        "exif-ifd2-ColorSpace", "exif-ifd2-ComponentsConfiguration",
        "exif-ifd2-ExifVersion", "exif-ifd2-FlashpixVersion",
        "exif-ifd2-PixelXDimension", "exif-ifd2-PixelYDimension",
    }
)

# Non-EXIF carriers of what a PHOTOGRAPHER's file holds.
_PHOTOGRAPHER_BLOBS = frozenset({"xmp-data", "iptc-data", "photoshop-data", "jpeg-thumbnail-data"})


def _is_photographer_metadata(field: str) -> bool:
    """Does this field carry data ABOUT the photograph — camera, person, place, time —
    as opposed to how the file is encoded?

    **Only the per-bake count uses this. The drop is the allowlist above and is not
    affected.** That split is deliberate and the two need opposite failure modes: the
    drop must fail CLOSED (an unknown carrier is removed), while a log line must fail
    OPEN (an unknown carrier goes uncounted rather than inflating the number), so this
    one names what it is looking for.

    **Counting "everything the allowlist dropped" was the first version and it was
    wrong for every format except JPEG.** Measured in the worker image on clean 80x60
    originals libvips itself saved, with no metadata added: GIF reported **5**
    (`loop`, `delay`, `background`, `gif-palette`, `palette-bit-depth`), HEIC and AVIF
    **3** each (`heif-primary`, `heif-compression`, `heif-bitdepth`), palette and
    interlaced PNG **1** each. A clean corpus of iPhone photographs — exactly what this
    defect exists to protect — would have logged *"N of N carried photographer
    metadata"*, and an operator learns to ignore a line that is always N of N."""
    if field in _STRUCTURAL_EXIF_FIELDS:
        return False
    return field.startswith(("exif-", "png-comment-")) or field in _PHOTOGRAPHER_BLOBS


def _drop_source_metadata(img: pyvips.Image) -> list[str]:
    """Remove the original's embedded metadata from ``img`` IN PLACE (so it must be a
    private copy), returning the field names dropped — EXIF (camera make and model,
    capture timestamps, serial numbers, GPS), XMP, IPTC, PNG text chunks, and anything
    else not in ``_KEEP_FIELDS``.

    **Two shorter versions of this do not work, both measured on the worker image's
    libvips 8.14.1 against a JPEG carrying EXIF + XMP:**

    - ``webpsave(strip=True)`` left **both** blocks in the output.
    - removing the ``exif-data`` blob alone left the EXIF chunk intact, because the
      saver rebuilds it from the per-tag ``exif-ifd*`` fields, which survive.

    The output still carries a ~186-byte EXIF chunk that libvips SYNTHESISES from the
    image's own resolution and colourspace; that is not source data, so a test must
    assert on fields or on the payload, never on the chunk being absent.

    **`icc-profile-data` is kept, and that is a trade with a residual.** The transcode
    does not ICC-transform, so a wide-gamut original needs its embedded profile to
    render correctly in the browser — but an ICC profile carries text tags (`desc`,
    `dmnd`, `dmdd`, `cprt`) that can name the capturing device or whoever authored a
    custom profile. Converting to sRGB once and dropping the profile would remove the
    residual and make the tiles and the detail image agree on colour, which they do not
    today; that is a rendering change for every baked artifact, so it is
    `T2-the-detail-and-tile-paths-disagree-about-colour` rather than a rider here."""
    dropped = [f for f in img.get_fields() if f not in _KEEP_FIELDS]
    for field in dropped:
        img.remove(field)
    return dropped


def _transcode_detail(dense_id: int, path_str: str, out_path_str: str, max_px: int) -> tuple[int, bool, int]:
    """Transcode ONE surviving original to a capped WebP at ``out_path_str`` (pool
    worker process). Shrink-on-load to fit ``max_px`` (never upscale), aspect
    preserved, alpha flattened on black, sRGB. Returns ``(dense_id, ok, carried)``;
    ``ok`` is False when the original fails to decode — the failure IS the skip signal
    (no detail_ref for that cell), never raised (the one expected skip case) — and
    ``carried`` is how many PHOTOGRAPHER-metadata fields this original held
    (``_is_photographer_metadata``; 0 on a failure, and NOT the number of fields
    dropped, which is larger). The whole encode+write happens here so the multi-MB WebP
    never crosses the process boundary; only those three small values are returned.

    The original's embedded metadata is DROPPED before the save
    (``_drop_source_metadata``): this file is served to every viewer, and libvips
    otherwise copies EXIF and XMP — GPS coordinates included — from the original into
    it. Tiles and thumbnails never had this: they are rebuilt from raw pixel buffers
    (``new_from_memory``), which carry no metadata."""
    import pyvips  # native; deferred so pipeline.worker imports in the lean image

    try:
        img = pyvips.Image.thumbnail(path_str, max_px, size="down")
        if img.hasalpha():
            img = img.flatten(background=[0, 0, 0])
        out = img.colourspace("srgb").copy(interpretation="srgb")
        dropped = _drop_source_metadata(out)
        out.webpsave(out_path_str)
    except pyvips.Error:
        return dense_id, False, 0
    # Everything in `dropped` was removed; the count reports only the subset that is
    # data about the PHOTOGRAPH (see _is_photographer_metadata).
    return dense_id, True, len([f for f in dropped if _is_photographer_metadata(f)])


def _bake_detail_tier(
    survivor_paths: dict[int, Path],
    detail_dir: Path,
    log: logging.Logger,
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
    # `log` is the JOB logger (`_setup_logger`'s `pipeline.worker.<staging-dir>`:
    # `propagate = False` + a lone FileHandler) and is REQUIRED, not defaulted. The
    # first version logged on this module's logger instead, and that reached the
    # operator's permanent record nowhere: records propagate UP, never down, so the
    # job's file never saw them. On the web path (an `rq` worker, no root handler
    # configured) the INFO count was dropped entirely; the transcode-failed WARNINGs
    # did surface, but only on the shared container stderr via `logging.lastResort`,
    # never in this dataset's file. A default would set the same trap for the next
    # caller; the missing argument is now a TypeError.
    #
    # Both surfaces are kept deliberately, which is what the tiler's `_log_dropped_cells`
    # does above ("the tiler keeps its own warning for the console/stream half"): the
    # job logger writes the dataset's file, and the module logger reaches the CLI
    # console, which `cli.py`'s basicConfig(INFO) configures. Dropping the second half
    # would have taken the count and the skip list off an operator's terminal.
    module_log = logging.getLogger(__name__)

    def emit(level: int, msg: str, *args: object) -> None:
        """One line, two sinks: this dataset's `ingest.log`, and the console/stream."""
        log.log(level, msg, *args)
        module_log.log(level, msg, *args)
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
    carried_metadata = 0
    for processed, (dense_id, ok, dropped) in enumerate(results, start=1):
        if ok:
            refs[dense_id] = f"{dense_id}.webp"
            if dropped:
                carried_metadata += 1
        else:
            emit(
                logging.WARNING,
                "detail-tier transcode failed for %s; no detail_ref",
                survivor_paths[dense_id],
            )
        if on_progress is not None:
            on_progress(processed, total)  # absolute count; the reporter throttles
    # The count the privacy defect had to be measured BY HAND to establish
    # (T2-the-detail-tier-republishes-every-source-image sampled baked trees file by
    # file). Logging it makes every future bake self-reporting: a corpus whose
    # originals carry EXIF says so in ingest.log, in one line, at bake time.
    emit(
        logging.INFO,
        "detail tier: %d of %d original(s) carried photographer metadata "
        "(EXIF beyond libvips' own block, XMP, IPTC, text chunks); dropped before encode",
        carried_metadata,
        len(refs),
    )
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


def _role_entries(roles: "ColumnRoles | None") -> list[tuple[str, object]]:
    """``(role kind, entry)`` for every entry the role map declares, in declaration order.
    The one place that walks a ``ColumnRoles``' fields, so the per-entry fingerprint rule
    (``manifest.role_entry_fingerprints``) and the per-column union below cannot disagree
    about which entries exist. ``None`` (an images-only dataset) declares none."""
    if roles is None:
        return []
    entries: list[tuple[str, object]] = [("filename", roles.filename)]
    if roles.datetime is not None:
        entries.append(("datetime", roles.datetime))
    entries += [("categorical", e) for e in roles.categorical]
    entries += [("scatter", e) for e in roles.scatter]
    entries += [("geographic", e) for e in roles.geographic]
    entries += [("tag", e) for e in roles.tag]
    entries += [("freeform", e) for e in roles.freeform]
    if roles.embedding is not None:
        entries.append(("embedding", roles.embedding))
    return entries


def _role_fingerprints(roles: "ColumnRoles | None") -> dict[str, frozenset[tuple]]:
    """``column -> the set of ways this role map says that column is INTERPRETED``.

    The comparison key behind the stale set (seam L2 / D-ix tier 2). Two role maps are
    diffed by diffing these, so "did this column's role change?" is a value comparison
    rather than a hand-written case analysis per family.

    WHAT IS IN THE TUPLE — the role kind, every knob that changes how the column is READ,
    and for a pair its partner and axis; and what is deliberately OUT — ``label`` — is
    ``manifest.role_entry_fingerprints``' docstring, because that function is now the sole
    definition of the tuple (v2.10). This one is the UNION of every entry's contribution,
    which is what a two-role-maps diff needs.

    A ``set`` per column, not a single value, because nothing stops a column from
    carrying two roles (categorical AND tag, say) and the union is what changed or did
    not. ``None`` (an images-only dataset) fingerprints as ``{}``.

    NOT what a layout RECORDS. ``layoutEntry.source_fingerprint`` records the subset one
    role ENTRY contributes, because a union written into a bake record would never clear —
    see ``role_entry_fingerprints`` and ``_classify_layout_staleness``."""
    out: dict[str, set[tuple]] = {}
    for kind, entry in _role_entries(roles):
        for column, fingerprints in role_entry_fingerprints(kind, entry).items():
            out.setdefault(column, set()).update(fingerprints)
    return {column: frozenset(kinds) for column, kinds in out.items()}


def _changed_role_columns(
    before: "ColumnRoles | None", after: "ColumnRoles | None"
) -> list[str]:
    """The columns whose ROLE moved between two role maps, sorted. A column that gained a
    role, lost one, or had one re-parameterised is changed; a column present in both with
    the same fingerprint set is not. This is the ``changed_column`` half of D-ix's
    staleness predicate ``any(changed_column in entry.source_columns)``."""
    old, new = _role_fingerprints(before), _role_fingerprints(after)
    return sorted(
        column for column in set(old) | set(new) if old.get(column) != new.get(column)
    )


# The role kinds that produce a LAYOUT, and so the ones whose entries a committed layout
# entry can have been baked from. `filename`/`tag`/`freeform`/`embedding` are read by the
# dataset but arrange no cells, so no layout ever provenances to them.
_LAYOUT_ROLE_KINDS = frozenset({"datetime", "categorical", "scatter", "geographic"})


def _entry_fingerprints_by_source_columns(
    roles: "ColumnRoles | None",
) -> dict[tuple[str, tuple[str, ...]], list[dict[str, tuple[tuple, ...]]]]:
    """``(layout_type, the entry's WHOLE source-column tuple) -> the entries that key
    names``, each as the fingerprints that one entry contributes.

    THE KEY COSTS NOTHING TO DERIVE, because ``role_entry_fingerprints`` is already keyed
    by column, in first-seen order, with duplicates collapsed by dict semantics — which is
    exactly what ``source_columns`` is. ``tuple(fingerprints)`` therefore IS the provenance
    tuple, and this function does not re-implement the per-family column order or the
    ``(sx, sx)`` de-dupe. The 2026-09-23 review counted three hand-written copies of that
    rule per language; a copy that drifts makes the lookup find no candidate, and every
    layout of that family reads stale for ever.

    A LIST, NOT ONE ENTRY, BECAUSE THE KEY IS NOT UNIQUE. Nothing stops a role map
    declaring two entries of one family over the same columns in the same order — the
    naming convention contemplates it and hands the second a ``-1`` suffix — so
    ``scatter_sx`` and ``scatter_sx-1`` both provenance as ``["sx", "sy"]``.

    Walks ``_role_entries``, the one place that walks a ``ColumnRoles``' fields, and keeps
    the kinds that arrange cells. ``grid`` is not here: it has no role entry at all, and
    its ``[]`` provenance is the positive claim the caller handles."""
    out: dict[tuple[str, tuple[str, ...]], list[dict[str, tuple[tuple, ...]]]] = {}
    for kind, entry in _role_entries(roles):
        if kind not in _LAYOUT_ROLE_KINDS:
            continue
        fingerprints = role_entry_fingerprints(kind, entry)
        out.setdefault((kind, tuple(fingerprints)), []).append(fingerprints)
    return out


def _comparable_fingerprint(fingerprints: dict[str, tuple[tuple, ...]]) -> dict[str, frozenset]:
    """A fingerprint map as an order-insensitive value, for the identity comparisons below.
    Sets, never lists: the schema forbids nothing about the order two tuples are recorded
    in, and the two sides of the contract sort them differently (``json.dumps`` escapes
    non-ASCII, ``JSON.stringify`` does not)."""
    return {column: frozenset(fps) for column, fps in fingerprints.items()}


def _recorded_fingerprint(entry: dict) -> dict[str, frozenset] | None:
    """A committed entry's ``source_fingerprint`` as the same comparable value, or None when
    it records none (a pre-2.10 entry). The JSON arrays become tuples so they compare equal
    to a freshly-built fingerprint.

    A column whose value is not a list is DROPPED rather than crashing — the API passes this
    block through without re-validating it (deliberately: an unexpected shape must not 500
    the layout list), so a hand-edited manifest reaches here. Dropping it can only make the
    record smaller, i.e. match fewer declarations, i.e. read stale — never fresh."""
    recorded = entry.get("source_fingerprint")
    if not isinstance(recorded, dict):
        return None
    return {
        column: frozenset(tuple(fp) for fp in fingerprints)
        for column, fingerprints in recorded.items()
        if isinstance(fingerprints, list)
    }


def _locate_entry_fingerprints(
    candidates: list[dict[str, tuple[tuple, ...]]],
) -> dict[str, frozenset] | None:
    """The PRE-2.10 FALLBACK ONLY: which role entry a layout that recorded no fingerprint
    was baked from, inferred from its provenance alone — or None when that cannot be told,
    which the caller reads as STALE.

    Exactly one candidate is the only answer this can give. With several, a layout with no
    bake record carries nothing that could tell them apart, and guessing would report a
    moved declaration as fresh; with none, its provenance names nothing the roles declare.
    Both are "no entry to compare", and absence is never a positive claim of freshness.

    A 2.10 entry never reaches here: its own ``source_fingerprint`` IS what it was baked
    with, so there is nothing to infer (2026-09-23 review, finding 1)."""
    if len(candidates) != 1:
        return None
    return _comparable_fingerprint(candidates[0])


def _own_fingerprint(
    entry: dict, before_entries: dict[tuple[str, tuple[str, ...]], list[dict]]
) -> dict[str, frozenset] | None:
    """WHAT THIS LAYOUT WAS BAKED WITH — the question every staleness answer starts from.

    THE BAKE RECORD WINS, and that is the whole point of manifest 2.10: a 2.10 entry says
    what it read, so nothing has to be inferred from a role map that may have moved since.
    Inferring it from the BEFORE roles instead is wrong whenever the roles have changed
    more than once between bakes — round-trip a datetime format ``iso8601 -> unix_seconds
    -> iso8601`` and the before-state says ``unix_seconds`` while the tiles are ``iso8601``,
    so the commit report and the prediction both say stale while the durable record says
    fresh. That is the three-way disagreement the seam exists to prevent (2026-09-23 review,
    finding 1).

    Only a PRE-2.10 entry falls back to locating its entry in the before roles, because
    there is nothing else to go on."""
    recorded = _recorded_fingerprint(entry)
    if recorded is not None:
        return recorded
    sources = entry.get("source_columns")
    key = (str(entry.get("type")), tuple(sources if isinstance(sources, list) else ()))
    return _locate_entry_fingerprints(before_entries.get(key, []))
def _classify_layout_staleness(
    manifest: dict,
    before: "ColumnRoles | None",
    after: "ColumnRoles | None",
    roles_unreadable: bool = False,
) -> tuple[list[str], list[str]]:
    """``(stale, unknown)`` — which committed layouts a role change invalidates, and
    which ones cannot be judged at all. The v2.9 ``source_columns`` provenance list is
    what makes this a LOOKUP rather than an inference from ``column_roles`` + ``type`` +
    whatever convention a ``layout_id`` happened to follow (with three categorical
    columns and three categorical layouts, that was guessing).

    PER ENTRY, NOT PER COLUMN (v2.10 / LAYOUT_DESIGNER D-xxix), and in two halves:

      * WHAT THIS LAYOUT WAS BAKED WITH is ``_own_fingerprint`` — its own 2.10 record,
        falling back to its entry in the BEFORE roles only when it predates 2.10;
      * WHETHER THAT IS STILL DECLARED is matched against the AFTER roles' ENTRIES, not
        against their per-column union. A union answers a different question and answers
        it wrongly in both directions. It OVER-reports across families — adding a second
        scatter pair over ``lon``/``lat`` changes those columns while leaving the
        geographic layout's own two tuples exactly where they were, and D-xxix pre-queues
        a re-bake for every layout reported here, so an over-report pre-ticks a multi-hour
        bake that changes no pixel. And it UNDER-reports within one: with two entries over
        one pair, changing only the first leaves the second contributing the old tuples to
        the union, so the changed layout reads FRESH over tiles that no longer match it
        (2026-09-23 review, finding 2).

    DUPLICATES ARE COUNTED, not just matched. Two layouts that recorded the same
    fingerprint need two entries still declaring it; if only one survives, one of them is
    stale and NOTHING can say which — they are indistinguishable by construction — so both
    are reported. Over-reporting is the safe direction here; picking one arbitrarily would
    let the genuinely stale layout read fresh.

    ``stale`` IS WHAT THIS EDIT NEWLY STALES — stale under the new roles and NOT already
    stale under the committed ones (2026-09-24 round-2 review, N1). Reading the bake record
    makes the "already stale" population visible for the first time, and putting it in this
    report would make D-xxix re-queue a re-bake for it on every later unrelated commit,
    including one the operator had just removed from the queue. There is no second bucket
    here on purpose: the STILL-stale set is computable from the record alone, without a
    before-state, so the client derives it (``derived.baked``) and this verb answers only
    the question a commit can answer.

    The same rule decides the client's prediction (``pending.ts``) and the durable
    ``source_fingerprint`` comparison, so the commit's report, the prediction and the bake
    record cannot disagree within one session.

    THE THIRD BUCKET IS THE POINT. ``source_columns`` is optional in the schema for
    exactly one reason — ``append_manifest_layouts`` carries PRE-2.9 entries forward
    byte-preserved under a re-stamped version — so an ABSENT key means "this entry
    predates 2.9 and recorded nothing", NOT "this layout depends on no column". Reading
    absence as ``[]`` would silently clear the stale flag on precisely the oldest,
    least-understood layouts in a tree. ``[]`` *present* is the opposite: a positive
    claim, and the honest value a grid layout carries, which is why the predicate is
    false for grid by construction rather than by exception.

    So an entry with no ``source_columns`` is reported as UNKNOWN and never as fresh, and
    the caller decides how to say so. It is not folded into ``stale`` either: "we cannot
    tell" and "we can tell, and it is" are different sentences, and a screen that renders
    them the same trains people to ignore both.

    AND "NO ENTRY TO COMPARE" IS STALE, NEVER FRESH — the fail-safe a naive per-entry test
    silently switches off. Two ways to get there, one answer:

      * ``roles_unreadable`` — the COMMITTED roles do not parse. ``run_set_roles`` degrades
        them to ``None`` so that the one verb able to repair a broken roles map is never
        refused by it (2026-09-09 review finding 6), and reports EVERY judgeable layout as
        stale: *the operator is told to re-bake more than strictly necessary, rather than
        told nothing.* It is a DATASET-level fail-safe and stays one even now that a 2.10
        entry could be judged exactly from its own record — because the file is
        self-inconsistent, because `run_set_roles` logs that very sentence to `ingest.log`
        on this path, and because a repair is the wrong moment to narrow a warning.
        ``test_set_roles_still_writes_when_the_committed_roles_no_longer_parse`` pins it;
      * a PRE-2.10 layout whose entry cannot be LOCATED in the committed roles — a
        hand-edited manifest, a shape the current schema no longer expresses, or two
        entries sharing one provenance that nothing can tell apart
        (``_locate_entry_fingerprints``).

    Absence is never a positive claim of freshness — the same rule the absent
    ``source_columns`` follows, one level down."""
    before_entries = _entry_fingerprints_by_source_columns(before)
    after_entries = _entry_fingerprints_by_source_columns(after)
    stale: list[str] = []
    unknown: list[str] = []
    # Pass 1: what each judgeable layout was baked with, and how many layouts want it.
    judgeable: list[tuple[str, tuple[str, tuple[str, ...]], dict[str, frozenset] | None]] = []
    demand: dict[tuple, int] = {}
    for entry in manifest.get("layouts", []):
        layout_id = entry.get("layout_id")
        sources = entry.get("source_columns")
        if not isinstance(sources, list):
            unknown.append(layout_id)
            continue
        if not sources:
            continue  # grid: a POSITIVE "reads no column", so nothing can stale it
        key = (str(entry.get("type")), tuple(sources))
        own = None if roles_unreadable else _own_fingerprint(entry, before_entries)
        judgeable.append((layout_id, key, own))
        if own is not None:
            demand[(key, _hashable(own))] = demand.get((key, _hashable(own)), 0) + 1
    # Pass 2: how many entries each role map still declares for what each layout recorded.
    # THE ANSWER IS WHAT THIS EDIT NEWLY STALES, not what is stale (2026-09-24 round-2
    # review, N1). `own` is the bake record, so testing it against the AFTER roles alone
    # also catches layouts an EARLIER roles-only commit already staled — and this verb's
    # report drives D-xxix, which pre-queues a re-bake for everything in it. Reported that
    # way, an already-stale layout is re-queued on EVERY later unrelated commit, including
    # after the operator deliberately removed it from the queue. The client says the same
    # thing (`derivePending`), and the still-stale set is the client's to read off the
    # record (`derived.baked`) — it needs no round trip to compute it.
    def _missing(roles_entries: dict, key: tuple, own: dict[str, frozenset]) -> bool:
        supply = sum(
            1
            for candidate in roles_entries.get(key, [])
            if _comparable_fingerprint(candidate) == own
        )
        return supply < demand[(key, _hashable(own))]

    for layout_id, key, own in judgeable:
        if own is None:  # no before-state to compare — see the fail-safe above
            stale.append(layout_id)
            continue
        if _missing(after_entries, key, own) and not _missing(before_entries, key, own):
            stale.append(layout_id)
    return stale, unknown


def _hashable(fingerprint: dict[str, frozenset]) -> tuple:
    """A comparable fingerprint as a dict KEY, for the duplicate count above. Sorted by
    column so two equal fingerprints hash alike whatever order they were built in."""
    return tuple(sorted(fingerprint.items()))


def _family_ids_by_source_columns(
    roles: "ColumnRoles | None",
) -> dict[tuple[str, tuple[str, ...]], str]:
    """``(layout_type, the entry's WHOLE source-column tuple) -> the layout_id that entry
    would bake under NOW``, for the multi-entry families only (categorical, scatter,
    geographic).

    Keyed on the full tuple, in order, because that tuple is exactly what a committed
    entry records as ``source_columns`` — so a committed entry's provenance is enough to
    name the id the SAME role entry is now called, which is what makes the rename report
    actionable rather than just a denial.

    KEYED ON THE WHOLE TUPLE AND NOT THE PRIMARY COLUMN (2026-09-10 round-2 review finding
    A). Keyed on ``source_columns[0]``, a pair family that keeps its primary column and
    re-pairs it looked identical to a rename: committed ``scatter`` over ``['sx','sy']``
    against roles declaring ``(sx, sz)`` and ``(sq, sy)`` reported
    ``renamed == {'scatter': 'scatter_sx'}``, and ``scatter_sx`` bakes a DIFFERENT PAIR.
    The advice that followed — re-bake as ``scatter_sx``, then delete ``scatter`` — swaps
    the operator's data under a name they believe is their layout. A partial match is not
    a rename; it is a changed input, which is what the STALE flag says."""
    out: dict[tuple[str, tuple[str, ...]], str] = {}
    for layout_type, plugin_cls in _PLUGINS.items():
        plugin = plugin_cls()
        entries = _family_entries(plugin, roles)
        names = _family_layout_names(plugin, roles)
        if entries is None or names is None:  # single-compute family (grid, datetime)
            continue
        for index, layout_id, _label in names:
            out[(layout_type, entries[index][0])] = layout_id
    return out


def _classify_unproducible_layouts(
    manifest: dict, roles: "ColumnRoles | None"
) -> tuple[dict[str, str], list[str]]:
    """``(renamed, orphaned)`` — the committed layouts the NEW roles cannot produce under
    their committed id, split by WHY, because the two need opposite advice.

    THE FAMILY NAMING BOUNDARY IS THE REASON THIS IS NOT ONE BUCKET. ``_family_layout_names``
    names a multi-entry family's sole layout with the BARE plugin name and switches to
    ``{name}_{slug}`` the moment a second entry appears (``multi = len(entries) > 1``) —
    and back again when one is removed. So adding a second categorical column RENAMES the
    first column's layout from ``categorical`` to ``categorical_<slug>``, and removing one
    renames the survivor back. Both directions make a live, untouched layout absent from
    ``_enumerate_layout_ids``, and reporting that as "the column it was baked from lost its
    role — delete it" is both a misattributed cause and destructive advice (2026-09-09
    review finding 1).

    THE TEST, from the same review and NARROWED by the round-2 one (finding A): a
    committed id absent from ``producible`` is a RENAME when the new roles still declare an
    entry of the same layout_type whose WHOLE source-column tuple equals the committed
    entry's ``source_columns`` — same columns, same order — and that entry now bakes under
    a different id (``_family_ids_by_source_columns``). Anything else is an ORPHAN.

    THE WHOLE TUPLE, NOT THE PRIMARY COLUMN. The first cut of this looked up
    ``source_columns[0]`` and separately checked that every committed column was still
    declared SOMEWHERE under the same role kind. A pair family that keeps its primary
    column and re-pairs it passes both: committed ``scatter`` over ``['sx','sy']``, roles
    declaring ``(sx, sz)`` and ``(sq, sy)``, reported a rename to ``scatter_sx`` — a
    layout that bakes ``sx`` against ``sz``. "Re-bake it under the new id and delete the
    old one" then substitutes different data under the operator's name for their layout.
    A PARTIAL match is not a rename: the layout's inputs changed, which is what the STALE
    flag says (that same run reports ``stale_layouts == ['scatter']``), and its committed
    id is genuinely unproducible, which is what the orphan bucket says — "nothing can
    re-bake this; restore the role it was baked from" is true of a broken pair too, and
    unlike the rename note it recommends nothing destructive to the DATA. Categorical is
    unaffected either way: one column per entry, so the primary IS the whole tuple.

    An entry with no recorded provenance lands in ORPHANED, unjudgeable either way, and is
    already reported separately as UNKNOWN.

    Neither is refused. A rename says "re-bake under the new id, then delete the old one";
    an orphan says "nothing produces this id — delete the layout, or restore the role"."""
    producible = {layout_id for layout_id, _ in _enumerate_layout_ids(roles)}
    fresh_ids = _family_ids_by_source_columns(roles)
    renamed: dict[str, str] = {}
    orphaned: list[str] = []
    for entry in manifest.get("layouts", []):
        layout_id = entry.get("layout_id")
        if layout_id in producible:
            continue
        layout_type = entry.get("type")
        sources = entry.get("source_columns")
        # `isinstance` guards the pre-2.9 entries that record no provenance at all (an
        # absent key, reported as UNKNOWN) and `bool` the positive empty list grid carries.
        new_id = (
            fresh_ids.get((layout_type, tuple(sources)))
            if isinstance(sources, list) and sources
            else None
        )
        if new_id is not None and new_id != layout_id:
            renamed[layout_id] = new_id
        else:
            orphaned.append(layout_id)
    return renamed, orphaned


def _classify_tag_sidecar(
    manifest: dict, dataset_dir: Path, roles: "ColumnRoles | None"
) -> tuple[list[str], str | None]:
    """``(tag-role columns the committed sidecar cannot serve, a sidecar left with no tag
    role at all)`` — the FOURTH bucket beside stale / unknown / orphaned (2026-09-09
    review finding 3).

    WHY A ROLES-ONLY EDIT NEEDS IT. ``set-roles`` writes ``column_roles`` — ``tag``
    entries included — and bakes nothing, but the tag filter is served from
    ``tags/tags_v{N}.arrow``, a version-stamped sidecar only a bake writes
    (``_stage_tags_sidecar`` / ``write_tags_sidecar``, whose columns are exactly ``id`` +
    the tag-role columns). So the two halves can disagree in both directions and neither
    is a layout:

      * DECLARING a tag role whose column is not in the committed sidecar produces a
        filter with nothing behind it. The frontend fetches ``manifest.tags.path`` and
        decodes a sidecar with no such column — an empty filter, silently.
      * REMOVING the last tag role leaves ``manifest.tags`` pointing at a live sidecar,
        which contradicts the schema's own words for that block (*"Null or absent when
        the dataset has no tag-role columns"*) and keeps the UI offering a filter for a
        role that no longer exists.

    THE SIDECAR IS NEVER RE-STAGED HERE, for the same reason the orphan case is only
    reported: this verb bakes nothing, and re-projecting the sidecar would be a write to a
    version-stamped asset outside any bake — a second writer of the exact thing
    ``add-layouts --column-roles`` already owns (``_stage_tags_sidecar``). So
    ``unserved_tag_roles`` is a report and its remedy is an ``add-layouts`` run.

    THE SECOND VALUE IS NOW ALSO AN INSTRUCTION, not only a report (2026-09-10 round-2
    review finding B2). ``add-layouts`` cannot repoint the block either —
    ``_stage_tags_sidecar`` returns ``None`` whenever the effective roles carry no tag
    role, so ``append_manifest_layouts`` carries the committed ``tags`` dict through
    unchanged — which left the reported state with no remedy at all. ``run_set_roles``
    therefore DROPS the block from the manifest it is already rewriting, and this return
    value names the file that drop leaves unreferenced. Deciding it here rather than
    there keeps one reader of ``manifest["tags"]``.

    Only the sidecar's SCHEMA is read — the Arrow IPC footer, i.e. its column names, not
    one row of data. A sidecar the manifest names but that is missing or unreadable counts
    every declared tag role as unserved, which is the honest reading."""
    declared = sorted({entry.column for entry in roles.tag}) if roles is not None else []
    block = manifest.get("tags")
    path = block.get("path") if isinstance(block, dict) else None
    if not declared:
        # No tag role left: any `tags` block still in the manifest points at a sidecar
        # nothing declares. (No block and no roles is the ordinary silent case.)
        return [], path if isinstance(path, str) else None
    if not isinstance(path, str):
        return declared, None  # roles declare tags; the manifest names no sidecar at all
    sidecar = dataset_dir.joinpath(*PurePosixPath(path).parts)
    try:
        with pa.ipc.open_file(str(sidecar)) as reader:
            served = set(reader.schema.names)
    except (OSError, pa.ArrowInvalid):
        return declared, None  # named but missing/unreadable ⇒ it serves nothing
    return [column for column in declared if column not in served], None


# The datetime formats a roles commit may declare on a STORED TIMESTAMP column, besides its
# committed one (D-xxxii). Ingest stores a column as a timestamp only when it parsed it as
# `iso8601` (the CSV is read all-VARCHAR and `_enrichment_select` casts `unix_*` to BIGINT),
# and a bake re-parses nothing, so `iso8601` is the only format that describes the column.
# This is POLICY, not protection of positions: after upload a date has no format (D-xxxiii;
# operator, 2026-09-26). Since #391 the datetime plugin scales integer values only, so no
# format moves a stored timestamp's cells. Before that, `unix_millis` moved golden's axis to
# 1970-01-19 (measured 2026-09-25). The refusal stays because a `unix_*` format tells
# consumers the values are numbers while the API serves ISO strings. This is an interim
# guard until ingest stores every date the same way. Pinned, with each format's measured
# effect, by `test_no_format_moves_a_stored_timestamp_though_only_iso8601_is_accepted`.
_TIMESTAMP_DATETIME_FORMATS = frozenset({"iso8601"})


def _validate_roles_against_parquet(
    roles: "ColumnRoles | None", metadata_path: Path, committed_manifest: dict | None = None
) -> None:
    """Value-level check of the effective roles against the READ-ONLY committed
    metadata.parquet (there is no CSV re-join in add-layouts — the parquet is the
    frozen source). The `filename` JOIN KEY and every referenced enrichment column
    must be present, the typed
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
    an images-only dataset (roles is None).

    ``committed_manifest`` is the manifest these roles would replace. On a datetime column
    stored as a TIMESTAMP, its format is always accepted besides `iso8601`, so re-sending
    the committed roles of a collection whose date column is a stored timestamp is never
    refused on its format (D-xxxii). The exemption is for stored timestamps only: a
    collection ingested with a `unix_*` format stores the column as int64, and the type
    check below refuses every datetime role on it, a byte-identical re-send included
    ([[T2-the-datetime-format-is-fixed-at-ingest-but-set]]). Refusing the other formats on
    a timestamp is policy (D-xxxiii), not protection of positions: since #391 the datetime
    plugin scales integer values only, so no format moves a stored timestamp's cells."""
    if roles is None:
        return
    from pipeline.ingest import (  # lean-safe; avoids a module-top cycle
        ColumnRoleError,
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

    # The JOIN KEY first. `ingest_metadata` rebinds the filename role to the canonical
    # `filename` column it actually wrote (`ingest.py`: `replace(roles, filename=
    # RoleEntry(_FILENAME_COL, ...))`), so every committed manifest names a column the
    # parquet has — and a roles map that names anything else is a typo or a pre-rename
    # CSV header, not a valid override. Unchecked (2026-09-09 review finding 7), it
    # committed a join-key role naming a column that does not exist, and `set-roles` —
    # the one verb whose entire subject is the role map — then reported that nonexistent
    # name in `changed_columns`.
    require(roles.filename.column, "filename")
    if roles.datetime is not None:
        dt_type = require(roles.datetime.column, "datetime")
        if not pa.types.is_timestamp(dt_type):
            raise ColumnRoleError(
                roles.datetime.column, f"datetime column is {dt_type} in metadata.parquet, not a timestamp"
            )
        # D-xxxii: the format is fixed at ingest, so a stored timestamp takes `iso8601` only.
        # Policy since #391 (D-xxxiii): no format moves a stored timestamp's cells any more.
        # The committed format is exempt, so re-sending the committed roles over a stored
        # timestamp is never refused; one committed before this check existed can still be
        # put back to `iso8601`, which is always accepted here. Only a timestamp reaches
        # this line: the int64 a `unix_*` ingest stores was refused just above, committed
        # roles included ([[T2-the-datetime-format-is-fixed-at-ingest-but-set]]).
        committed_dt = ((committed_manifest or {}).get("column_roles") or {}).get("datetime") or {}
        dt_format = roles.datetime.format
        if dt_format not in _TIMESTAMP_DATETIME_FORMATS and (
            committed_dt.get("column") != roles.datetime.column
            or committed_dt.get("format") != dt_format
        ):
            raise ColumnRoleError(
                roles.datetime.column,
                f"datetime format is fixed at ingest: this column was parsed into timestamps "
                f"as 'iso8601' there, and a re-bake re-parses nothing, so it cannot become "
                f"{dt_format!r}. Keep 'iso8601'",
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
    # There is deliberately NO `url` check here any more (schema v2.9, D-xvii). The role is
    # gone from column_roles: the bake only ever VALIDATED it — nothing was computed from it
    # and no cell moved — so it was presentation collected on the bake's input path, and it
    # now lives in `presentation.json` as `columns.<name>.render: "url"`. NOTHING REPLACES
    # THE CHECK AT BAKE TIME, and that is the design (D-xvi): the two files change
    # independently, so correctness for a presentation fact is validate-on-WRITE (the API,
    # against presentation.schema.json) plus fall-back-on-READ (a `render` naming a column
    # that does not exist is ignored, never an error). A bake-time check would have to read
    # the other file and would re-couple exactly what the split separates.

    # Value-level knob checks LAST — the presence/type loop above guaranteed every
    # scatter/geographic axis column exists as a float, so the parquet reads inside never
    # miss. D-35 Seam G2 geographic gets its lon/lat range + mercator-|lat| twin here.
    validate_scatter_options_parquet(roles, metadata_path)
    validate_geographic_options_parquet(roles, metadata_path)


def _fingerprinted_layout_ids(committed_manifest: dict) -> set[str]:
    """The committed layouts that record a ``source_fingerprint`` (manifest 2.10, seam L7) —
    the ones that report their OWN staleness, durably, so the two stale-knob guards below
    stand down for them (LAYOUT_DESIGNER D-xxx).

    ``isinstance(..., dict)`` is the one predicate every reader of the key uses
    (``_recorded_fingerprint``, refresh's ``has_record``, the API's ``LayoutInfo``
    pass-through), so a pre-2.10 entry — absent key — and a hand-edited non-dict are both
    "records nothing". An id the guards are given that has no entry here at all is likewise
    NOT in this set, so it is guarded: absence is never a claim that staleness will be
    reported."""
    return {
        layout["layout_id"]
        for layout in committed_manifest.get("layouts", [])
        if isinstance(layout.get("source_fingerprint"), dict)
    }


def _knob_values(
    entry: "ScatterRoleEntry | GeographicRoleEntry", knobs: tuple[str, ...]
) -> tuple[object, ...]:
    """A role entry's shaping knobs, in ``knobs`` order — equal exactly when every knob is."""
    return tuple(getattr(entry, f) for f in knobs)


def _unfingerprinted_knob_change(
    committed: list[tuple[str, tuple[str, str], tuple[object, ...]]],
    override: list[tuple[tuple[str, str], tuple[object, ...]]],
    existing_ids: set[str],
    fingerprinted: set[str],
) -> tuple[tuple[str, str], str, bool] | None:
    """The narrowing both stale-knob guards share (LAYOUT_DESIGNER D-xxx), written once so
    the two families cannot drift from each other: the first override pair whose knobs
    differ from the pair's committed entry while a committed layout on that pair records no
    fingerprint, as ``(pair, the layout to name, exact)`` — or None, and the guard stands
    down.

    ``committed`` is ``(layout_id, pair, knob values)`` per committed role entry, in
    declaration order, the id being the one the committed roles give it; ``override`` is
    ``(pair, knob values)`` per override entry; ``existing_ids`` the committed layouts this
    run does NOT re-bake. Per pair ONE map entry: the knobs to compare against (the LAST
    committed entry on the pair — [[T2-the-stale-knob-guards-compare-a-pair-declared]]) and
    the layout to name (the last on the pair that records no fingerprint), None when every
    one records a fingerprint. The rule itself is stated on
    ``_guard_no_stale_scatter_config``.

    ``exact`` is whether the pair is declared ONCE in the committed roles and once in the
    override. Only then was the comparison the named layout's own entry against its own
    override, so only then is "its knobs changed" known. Otherwise either side of the
    comparison may be another layout's: the committed knobs are the pair's last entry, which
    may be a layout that records a fingerprint, and the override declaration may be one this
    run re-bakes, or a new one. So the layout named may be unchanged (review of #392,
    finding 1). ``_stale_knob_refusal`` words the two differently."""
    on_pair: dict[tuple[str, str], tuple[tuple[object, ...], str | None]] = {}
    for layout_id, pair, knobs in committed:
        if layout_id in existing_ids:
            _, unchecked = on_pair.get(pair, ((), None))
            on_pair[pair] = (knobs, unchecked if layout_id in fingerprinted else layout_id)
    for pair, knobs in override:
        committed_knobs, unchecked = on_pair.get(pair, ((), None))
        if unchecked is None:
            continue  # nothing committed on the pair, or every layout on it reports itself
        if knobs != committed_knobs:
            exact = (
                sum(p == pair for _, p, _ in committed) == 1
                and sum(p == pair for p, _ in override) == 1
            )
            return pair, unchecked, exact
    return None


def _stale_knob_refusal(
    what: str, noun: str, new: str, pair: tuple[str, str], unchecked: str, exact: bool
) -> str:
    """The refusal both stale-knob guards raise: the override changes ``what`` on ``pair``,
    and committed ``noun`` ``unchecked`` there records no fingerprint and is not re-baked.

    EXACT — the pair declared once on each side — it names the layout whose knobs changed,
    so ``--replace`` is the way out. Otherwise the guard cannot tell whose knobs changed
    (``_unfingerprinted_knob_change``), and ``--replace`` could re-bake a layout that did not
    change, which on a large collection costs hours for nothing. That refusal says what it
    cannot tell, and gives the way out that re-bakes only what changed: the roles alone
    through ``set-roles``, which no stale-knob guard holds, then a re-bake of each changed
    layout from the committed roles. It never tells the operator to ``--replace`` the layout
    it names. Until the per-entry comparison lands
    ([[T2-the-stale-knob-guards-compare-a-pair-declared]]), that is the most it can say."""
    a, b = pair
    if exact:
        return (
            f"the roles override changes the {what} of committed {noun} '{unchecked}' "
            f"(pair {a}/{b}), but this run does not re-bake it — the manifest would then "
            f"contradict the baked positions and their options echo. Pass --replace "
            f"{unchecked} (with --layout {unchecked}) to re-bake it under the {new}, or "
            f"re-ingest the dataset"
        )
    return (
        f"the {what} the roles override declares on pair {a}/{b} differ from the pair's last "
        f"committed declaration, and committed {noun} '{unchecked}' on that pair records no "
        f"fingerprint and is not re-baked by this run. The pair is declared more than once, "
        f"so this check cannot tell which layout's {what} changed, if any; if they changed "
        f"for '{unchecked}', the manifest would contradict its baked positions and their "
        f"options echo. Commit the new roles on their own with set-roles, then re-bake each "
        f"layout on the pair whose {what} you changed with --replace and no --column-roles, "
        f"or re-ingest the dataset"
    )


def _guard_no_stale_scatter_config(
    committed_manifest: dict,
    roles: "ColumnRoles | None",
    existing_ids: set[str],
    fingerprinted: set[str] | None = None,
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
    either side has no scatter roles.

    ONLY FOR LAYOUTS THAT RECORD NO FINGERPRINT (LAYOUT_DESIGNER D-xxx, operator
    2026-09-25). The premise above — that nothing would ever say the manifest contradicts
    the bake — stopped being true for a layout baked since manifest 2.10: its
    ``source_fingerprint`` records the knobs it was baked with, so after this run it reads
    stale on its own, durably, which is the state D-xxix designs for and the one
    ``set-roles`` already leaves. Refusing it here made one edit legal alone and illegal
    beside a bake ([[T2-an-unticked-knob-change-cannot-ride-a-bake-run]]). A layout that
    records none (baked before 2.10) cannot say so, so the guard stays for those — but only
    for the ones it can SEE. It finds a pair's committed layout through the id the committed
    roles give that pair now, so it misses a layout whose id those roles no longer produce
    (the bare ``scatter`` after ``set-roles`` added a second pair —
    [[T2-set-roles-disarms-the-stale-knob-guards-and]]) and can consult the wrong one after a
    reorder ([[T2-the-stale-knob-guards-find-a-pair-s-layout-by]]).

    SEVERAL LAYOUTS ON ONE PAIR — the rule, decided here: the guard refuses a pair whose
    knobs the override changes iff ANY committed, non-replaced layout of THIS family on
    that pair records no fingerprint, and names that layout (the last in declaration order,
    when several record none); if every one of them records a fingerprint, it
    stands down. "Any", because one unfingerprinted layout left contradicted is exactly the
    silent state the guard exists for, and a fingerprinted sibling cannot report on its
    behalf — each record speaks only for its own layout. Only an EXACT pair of the same
    family is "on the pair": a scatter over ``(sx, sz)`` shares an axis with ``(sx, sy)``
    but not the knobs of its entry, and a geographic layout over the same two columns is
    the twin guard's to judge — the per-entry fingerprint rule already keeps a scatter knob
    change from staling it (``_classify_layout_staleness``). The knob COMPARISON is
    unchanged by D-xxx: still against the last committed entry on the pair, which on a pair
    declared twice is order-dependent — and was before this rule
    ([[T2-the-stale-knob-guards-compare-a-pair-declared]]). So on a pair declared more than
    once the layout it names may be one whose knobs did not change, and the refusal says
    that instead of advising ``--replace`` for it (``_stale_knob_refusal``).

    ``layoutsCommit.knobConflicts`` transcribes this rule for the designer's review, and must
    stay identical: the client may never let through a run this refuses.

    ``fingerprinted`` is ``_fingerprinted_layout_ids(committed_manifest)``, which the
    ``run_add_layouts`` call site reads once for both guards; a direct caller that passes
    none gets it read here."""
    committed_config = committed_manifest.get("column_roles")
    if committed_config is None or roles is None or not roles.scatter:
        return
    from pipeline.ingest import ColumnRoleError  # lean-safe; avoids a module-top cycle

    old_roles = ColumnRoles.from_config(committed_config)
    if not old_roles.scatter:
        return
    if fingerprinted is None:
        fingerprinted = _fingerprinted_layout_ids(committed_manifest)
    old = old_roles.scatter
    names = _family_layout_names(_PLUGINS["scatter"](), old_roles) or []
    change = _unfingerprinted_knob_change(
        [
            (layout_id, (old[i].x_column, old[i].y_column), _knob_values(old[i], _SCATTER_KNOBS))
            for i, layout_id, _label in names
        ],
        [((e.x_column, e.y_column), _knob_values(e, _SCATTER_KNOBS)) for e in roles.scatter],
        existing_ids,
        fingerprinted,
    )
    if change is None:
        return
    pair, unchecked, exact = change
    raise ColumnRoleError(
        pair[0],
        _stale_knob_refusal("scatter knobs", "layout", "new knobs", pair, unchecked, exact),
    )


def _guard_no_stale_geographic_config(
    committed_manifest: dict,
    roles: "ColumnRoles | None",
    existing_ids: set[str],
    fingerprinted: set[str] | None = None,
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
    no-op when either side has no geographic roles.

    ONLY FOR LAYOUTS THAT RECORD NO FINGERPRINT (LAYOUT_DESIGNER D-xxx) — the same
    narrowing, and the same several-layouts-on-one-pair rule, as the scatter twin, through
    the same ``_unfingerprinted_knob_change``; its docstring carries the reasoning, and
    ``fingerprinted`` is passed the same way."""
    committed_config = committed_manifest.get("column_roles")
    if committed_config is None or roles is None or not roles.geographic:
        return
    from pipeline.ingest import ColumnRoleError  # lean-safe; avoids a module-top cycle

    old_roles = ColumnRoles.from_config(committed_config)
    if not old_roles.geographic:
        return
    if fingerprinted is None:
        fingerprinted = _fingerprinted_layout_ids(committed_manifest)
    old = old_roles.geographic
    names = _family_layout_names(_PLUGINS["geographic"](), old_roles) or []
    change = _unfingerprinted_knob_change(
        [
            (layout_id, (old[i].lon_column, old[i].lat_column), _knob_values(old[i], _GEO_KNOBS))
            for i, layout_id, _label in names
        ],
        [((e.lon_column, e.lat_column), _knob_values(e, _GEO_KNOBS)) for e in roles.geographic],
        existing_ids,
        fingerprinted,
    )
    if change is None:
        return
    pair, unchecked, exact = change
    raise ColumnRoleError(
        pair[0],
        _stale_knob_refusal(
            "projection/overlap", "geographic layout", "new projection", pair, unchecked, exact
        ),
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


def _guard_no_collision(
    resolved: list[tuple[str, str]],
    existing_ids: set[str],
    replacing: frozenset[str] = frozenset(),
) -> None:
    """Any resolved layout_id already committed is a hard error — this tool never
    overwrites a live layout by accident. The message tells the operator to re-run with
    only the not-yet-present specs (which is also how a partial-failure re-run
    resumes), and now also names the opt-out.

    ``replacing`` is the set of ids the caller passed ``--replace`` for (seam L2 /
    [[T2-add-layouts-cannot-replace-a-committed-layout]]): those, and ONLY those, are
    exempt. The default is empty, so behaviour with no ``--replace`` is byte-for-byte
    what it always was — the guard is NARROWED per id, never softened into a mode. A
    silent overwrite is the exact footgun this area was hardened against, and an opt-out
    that applied to a whole run would re-create it the first time someone passed a bare
    layout_type spec and got more layouts than they were thinking about."""
    clashes = sorted(
        layout_id
        for layout_id, _ in resolved
        if layout_id in existing_ids and layout_id not in replacing
    )
    if clashes:
        raise ValueError(
            f"add-layouts: layout(s) {clashes} already exist in the dataset — this tool does "
            f"not overwrite. Re-run with only the layouts not yet present, or pass "
            f"--replace for each layout you mean to RE-BAKE over "
            f"(e.g. {' '.join('--replace ' + c for c in clashes)})."
        )


def _guard_replace_targets(
    replace: tuple[str, ...], resolved: list[tuple[str, str]], existing_ids: set[str]
) -> frozenset[str]:
    """Validate the ``--replace`` opt-in and return it as a set. Refuses rather than
    guesses, because both mistakes it catches would otherwise do something the operator
    did not ask for:

      * an id that is NOT committed — a typo, or a layout already deleted. Treating it as
        a harmless no-op would let ``--replace scater`` silently degrade into a plain
        append, which is the one outcome a replace must never become;
      * an id that was not also requested with ``--layout``. A replace is a RE-BAKE, so
        the layout has to be in the bake plan; a bare ``--replace`` would otherwise read
        as "delete and re-add later" and quietly do nothing at all. ``delete-layout`` is
        the verb for removing one.

    A layout whose FAMILY or source columns the (possibly just-updated) roles can no
    longer resolve never reaches here: ``_resolve_layout_specs`` already refuses its
    ``--layout`` spec, listing the specs the current roles do produce."""
    if not replace:
        return frozenset()
    requested = {layout_id for layout_id, _ in resolved}
    unknown = sorted(set(replace) - existing_ids)
    if unknown:
        raise ValueError(
            f"add-layouts: --replace {unknown} names layout(s) that are not committed in "
            f"this dataset; committed layouts are {sorted(existing_ids)}. Replace re-bakes "
            f"an EXISTING layout — drop the --replace to add a new one."
        )
    unrequested = sorted(set(replace) - requested)
    if unrequested:
        raise ValueError(
            f"add-layouts: --replace {unrequested} was given but those layouts were not "
            f"requested with --layout, so nothing would be baked for them. Pass "
            f"{' '.join('--layout ' + u for u in unrequested)} as well, or use "
            f"`pixscope delete-layout` if you meant to remove them."
        )
    return frozenset(replace)


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
    # There is deliberately NO whole-directory `os.rename` fast path for a fresh dataset.
    # One stood here, guarded by `not dataset_dir.exists() and not keep_staging`, and it
    # could not run: the sole production caller passes `keep_staging=True`, and the only
    # test using the default commits onto a dataset dir that already exists. It was still
    # load-bearing as PROSE — `api/presentation.write()` and `create_dataset` both
    # justified their write ordering by citing it — so it was deleted and the reason
    # recorded here rather than left as a branch a reader would trust (review of PR #346,
    # finding 5).
    #
    # RESTORING IT WOULD BE UNSAFE, and not for the reason it was written. The API may now
    # create a dataset directory to hold `presentation.json` before any bake (D-xvii: a
    # presentation choice needs only the METADATA to exist). The lock that serialises that
    # write is `dataset-mutate:{id}` (`api/queue.py`), while this commit holds
    # `ingest-commit:{id}` (`:3108`) — DIFFERENT Redis keys, so they do not exclude each
    # other. A `ds_dir.mkdir` landing between the existence check and the rename would
    # fail the ingest with `ENOTEMPTY`. The merge-move below has no such window: it
    # creates the directory itself and moves staged items onto whatever is already there,
    # which is also what makes it leave a root-level file it did not stage exactly where
    # it was.
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
# NOTE: `.+` is GREEDY, so the stem group of `_POSITIONS_VERSION_RE` captures everything
# up to the LAST `_v{N}` — `scatter_v2_run_v1.arrow` yields stem `scatter_v2_run`,
# version `1`, which is what makes an equality test on the stem exact.
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
_POSITIONS_VERSION_RE = re.compile(r"^(?P<layout_id>.+)_v(?P<version>\d+)\.arrow$")


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


def _unlink_swept(entry: Path) -> int | None:
    """Unlink one superseded version-stamped asset, returning the bytes reclaimed, or
    ``None`` when it could not be removed.

    NON-FATAL by design, like ``_sweep_stale_detail``'s ``ignore_errors``: every caller
    runs AFTER a successful manifest flip, so the dataset is already committed and a
    cleanup failure (a permission error, a file held open by a reader) must be logged and
    skipped rather than fail a job whose work has landed. Shared by both sweeps so that
    policy has one home — ``_sweep_stale_versioned_assets`` (the re-ingest's global,
    manifest-derived prune) and ``_sweep_layout_assets`` (seam L2's per-layout prune)."""
    try:  # size BEFORE unlink (cheap for a file); a vanished file just counts 0
        size = entry.stat().st_size
    except OSError:
        size = 0
    try:
        entry.unlink(missing_ok=True)
    except OSError as exc:
        logging.getLogger(__name__).warning(
            "stale-asset sweep could not remove %s: %s", entry, exc
        )
        return None
    return size


def _rmdir_if_empty(directory: Path) -> None:
    """Remove ``directory`` if it is now empty, silently. Leaves no stray ``tiles/{layout}/``,
    ``tags/`` or ``positions/`` dir behind after a sweep emptied it; a still-populated dir
    (or a race with a concurrent writer) is left exactly as it is."""
    try:
        if not any(directory.iterdir()):
            directory.rmdir()
    except OSError:
        pass


def _dataset_relative(path: Path, dataset_dir: Path) -> str:
    """A swept file's path as the operator sees it — relative to the dataset root when it
    is under it (it always is), else the bare posix path. Report-only."""
    try:
        return path.relative_to(dataset_dir).as_posix()
    except ValueError:
        return path.as_posix()


def _sweep_layout_assets(
    dataset_dir: Path, manifest: dict, layout_ids: list[str]
) -> tuple[list[Path], int]:
    """Remove the version-stamped ``tiles/{layout_id}/{layout_id}_v{N}.pmtiles`` and
    ``positions/{layout_id}_v{N}.arrow`` of the NAMED layouts that the JUST-FLIPPED
    ``manifest`` no longer references, returning ``(swept files, bytes reclaimed)``.
    Seam L2's sweep, for the two verbs that make a layout's old bytes garbage:
    ``delete-layout`` (the entry is gone, so everything under its tile dir is
    unreferenced and the emptied dir goes too) and ``add-layouts --replace`` (the entry
    now names ``_v{new}``, so only the superseded ``_v{old}`` files are unreferenced and
    the dir stays).

    SCOPED, unlike ``_sweep_stale_versioned_assets``, which walks every layout dir. That
    one is a re-ingest's global prune and is right to be; a delete or a replace of ONE
    layout must not quietly garbage-collect bytes belonging to a layout it was not asked
    about, because a scoped verb that reaches outside its scope is exactly what makes an
    operator distrust it.

    MANIFEST-DERIVED, like every other sweep here: what is live comes from the
    just-flipped manifest's OWN asset paths (``_manifest_referenced_asset_names``), never
    from an assumed version number. A mixed-version tree — grid at v1, a categorical
    added at v2 — is normal after ``add-layouts``, so "not the current dataset_version"
    would delete live files. Deriving it also makes the replace case fall out with no
    special casing: the flip already re-pointed the entry, so the old container is
    unreferenced by construction.

    CALLERS MUST CALL THIS AFTER THE FLIP, never before — the ordering
    ``_sweep_stale_detail`` and ``_sweep_stale_versioned_assets`` already use. A crash
    between flip and sweep then leaves orphaned bytes (recoverable, and the next
    re-ingest's global sweep reclaims them); a crash the other way round leaves a live
    manifest pointing at files that no longer exist."""
    referenced_pmtiles, _referenced_tags, referenced_positions = (
        _manifest_referenced_asset_names(manifest)
    )
    swept: list[Path] = []
    swept_bytes = 0

    def _remove(entry: Path) -> None:
        nonlocal swept_bytes
        size = _unlink_swept(entry)
        if size is None:
            return
        swept_bytes += size
        swept.append(entry)

    positions_root = dataset_dir / _POSITIONS_DIR
    for layout_id in layout_ids:
        layout_dir = dataset_dir / "tiles" / layout_id
        if layout_dir.is_dir():
            keep = referenced_pmtiles.get(layout_id, set())
            for entry in sorted(layout_dir.iterdir()):
                if not entry.is_file() or _TILE_PMTILES_VERSION_RE.match(entry.name) is None:
                    continue
                if entry.name in keep:
                    continue
                _remove(entry)
            # Empty ⇒ this layout has no live container at all (the delete case). A
            # replace leaves its fresh `_v{new}.pmtiles` behind, so the dir survives.
            _rmdir_if_empty(layout_dir)
        if positions_root.is_dir():
            # `positions/` is FLAT and shared by every layout, so this layout's tables are
            # identified by NAME rather than by sweeping the dir. The test is the parsed
            # stem compared for EQUALITY, never a prefix: a prefix test with a `_v` anchor
            # keeps `categorical_group` from matching `categorical_group_extra`, but it
            # does NOT stop `scatter` from matching a sibling layout whose own id begins
            # `scatter_v` — `scatter_v2_run` is a legal `_slug` output, and
            # `positions/scatter_v2_run_v1.arrow` both matches the version pattern and
            # starts with `scatter_v` (2026-09-09 review finding 8). Only superseded
            # generations were ever at risk, since a sibling's LIVE table is in
            # `referenced_positions` — but "this verb touches only the layout it was asked
            # about" is the whole claim a scoped sweep is trusted on.
            for entry in sorted(positions_root.iterdir()):
                match = _POSITIONS_VERSION_RE.match(entry.name)
                if not entry.is_file() or match is None:
                    continue
                if match.group("layout_id") != layout_id:
                    continue
                if entry.name in referenced_positions:
                    continue
                _remove(entry)
    if positions_root.is_dir():
        _rmdir_if_empty(positions_root)
    return swept, swept_bytes


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

    def _remove(entry: Path) -> None:
        nonlocal swept_bytes
        size = _unlink_swept(entry)
        if size is None:
            return
        swept_bytes += size
        swept.append(entry)

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
