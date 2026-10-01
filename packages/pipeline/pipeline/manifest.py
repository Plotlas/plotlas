"""Assemble and write the v2 layout manifest JSON. Sole writer of the manifest.

v2 (decision D-33): the manifest declares, PER LAYOUT, a self-describing spatial
tile pyramid (``pyramid``) — there is no shared global ``atlas`` block and no
``tile_root`` any more. ``manifest_version`` is ``"2.10"`` (the v2.10 MINOR added the per-layout
``source_fingerprint`` — HOW each layout read its source columns, so staleness outlives the
commit that caused it, LAYOUT_DESIGNER D-xxix; the v2.9 MINOR added the
per-layout ``source_columns`` provenance list and removed ``column_roles.url``, which was
presentation and moved to ``presentation.json`` — INTAKE_REDESIGN §6c D-xvii; the v2.8
MINOR added ``column_roles.url``, and this docstring said ``"2.7"`` throughout it — the
version sentences below were not updated at the time and are corrected here; the v2.7 MINOR
added the
datetime axis's ``annotations.axes[].interval`` — the ``{kind, step}`` calendar bucketing
rung the producer binned at, so the renderer ticks bin boundaries it was told about,
T2-142 / D-36 seam H3; the v2.6 MINOR added the
optional per-layout ``missing_count`` COUNT of cells a layout could not place — the
datetime layout's undated images and the scatter/geographic families' null-coordinate
cells, T2-140 / D-36 seam U1; the v2.5 MINOR added the
optional per-layout ``annotations`` — categorical band labels + the datetime axis domain,
T2-69/T2-72 Seam 2; the v2.4 MINOR added the ``"geographic"`` layout type + the
``options.projection`` echo — D-35 Seam G2; the v2.3
MINOR added the optional per-layout ``options`` echo of the applied scatter knobs — D-35
Seam G1; the v2.2 MINOR added the optional per-layout ``positions_ref`` position table for
pick-at-any-zoom, T2-66; the v2.1 MINOR reconciled coincident-point subsampling with
the dense-id contract) and the manifest is validated against
``schemas/v2/layout_manifest.schema.json``.

``write_manifest`` emits the whole manifest for a fresh/re-ingest bake.
``append_manifest_layouts`` (T2-42, the ``add-layouts`` path) merges NEW layout
entries onto a committed manifest, carrying its existing ``layouts`` through
byte-preserved so the already-baked pyramids' version-stamped paths keep resolving;
an entry whose ``layout_id`` collides is REPLACED IN PLACE, keeping its position in the
list — the ``add-layouts --replace`` path (seam L2), which the caller gates.
``revalidate_and_write`` is the third writer: it re-validates and atomically replaces an
already-assembled manifest, for the rewrites that bake nothing (``refresh-manifest``,
and seam L2's ``delete-layout`` / ``set-roles``).
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, cast

import jsonschema
from referencing import Registry, Resource

from pipeline.layout_plugins.base import _schema_dir  # shared schemas/v2/ locator

if TYPE_CHECKING:
    from pipeline.layout_plugins.base import (
        ColumnRoles,
        DatetimeRoleEntry,
        EmbeddingRoleEntry,
        GeographicRoleEntry,
        LayoutResult,
        RoleEntry,
        ScatterRoleEntry,
        TagRoleEntry,
    )
    from pipeline.tiler import PyramidResult

# The default scatter knobs (D-35 Seam G1). A knob is serialized into the embedded
# column_roles ONLY when it differs from its default, so a scatter role declared
# without knobs round-trips to exactly {x_column, y_column, label} — byte-for-byte the
# pre-2.3 shape the committed fixtures carry.
_SCATTER_KNOB_DEFAULTS = {
    "x_scale": "linear",
    "y_scale": "linear",
    "normalize": "fit",
    "overlap": "overdraw",
}

# The default geographic knobs (D-35 Seam G2), same omit-when-default rule as the scatter
# knobs — so a geographic role declared with the default projection round-trips to exactly
# {lon_column, lat_column, label}. (The projection default is a §6.1 bless item —
# equirectangular as proposed.)
_GEO_KNOB_DEFAULTS = {
    "projection": "equirectangular",
    "overlap": "overdraw",
}

# The pipeline writes manifest_version "2.10" — see the v2.10/v2.9/v2.8 note just above the
# constant below; the chain that follows picks up at v2.7 and was written when "2.7" was
# current, so read it as history rather than as the current value.
# (decision D-33; the v2.7 MINOR added the
# datetime axis's `annotations.axes[].interval` — the {kind, step} calendar bucketing rung
# the producer binned at, emitted UNCONDITIONALLY with the axis so its absence means exactly
# "baked before 2.7"; it is what makes producer/renderer tick lock-step STRUCTURAL rather
# than a matter of keeping two ladders in sync by discipline, T2-142 / D-36 seam H3; the
# v2.6 MINOR added the
# optional per-layout `missing_count` COUNT of cells a layout could not place — the
# datetime layout's UNDATED images, which since U1 are drawn in an unplaced strip rather
# than parked on a real date, plus the scatter/geographic families' null-coordinate cells,
# T2-140 / D-36 seam U1; the v2.5 MINOR added the
# optional per-layout `annotations` — categorical band labels + the datetime axis domain,
# T2-69/T2-72 Seam 2 — plus `bbox_exact`, `pyramid.dropped_total`; the v2.4 MINOR added
# the `"geographic"` layout type + the `options.projection` echo — D-35 Seam G2; the v2.3
# MINOR added the optional per-layout `options` echo of the applied scatter knobs — D-35
# Seam G1; the v2.2 MINOR added the optional per-layout positions_ref position table —
# T2-66/T2-48; the v2.1 MINOR reconciled coincident-point subsampling with the dense-id
# contract). The v2 schema's pattern ^2\.(0|[1-9][0-9]*)$ accepts it and rejects every
# v1.x manifest; a v2-major reader (SUPPORTED_MANIFEST_MAJOR == 2) accepts any 2.x.
#
# The new fields are additive/optional but NOT no-op on a fresh bake: EVERY freshly-baked
# layoutEntry gains `bbox_exact` + `pyramid.dropped_total` (a fresh 2.5 bake is therefore
# never byte-identical to its 2.4 form — the PR-180 review corrected an earlier claim
# here), and a datetime layout always gains `annotations` (a real axis or the {"axes":[]}
# declined marker). What IS guaranteed: `append_manifest_layouts` carries prior entries
# forward BYTE-PRESERVED while re-stamping the version — so a manifest stamped "2.7" can
# legitimately hold pre-2.5 entries with none of the new fields. READERS MUST GATE ON
# FIELD PRESENCE, NEVER ON manifest_version. (`missing_count` is the cleanest case: every
# FRESH 2.6 entry carries it, 0 included, so an absent key means exactly one thing — a
# carried-forward pre-2.6 entry — and 0 is a positive claim rather than a silence. The 2.7
# `axes[].interval` follows the same always-emit rule, scoped to the axis it describes: a
# fresh datetime axis always carries it, so an axis WITHOUT it is a pre-2.7 entry.)
#
# v2.9 (T2-a-layout-does-not-record-which-column-it-was / INTAKE_REDESIGN §6c) adds the
# per-layout `source_columns` PROVENANCE list — which metadata columns each layout was
# derived from — and REMOVES `column_roles.url`, which was presentation collected on the
# bake's input path (the bake only validated it; nothing was computed from it and no cell
# moved) and now lives in `presentation.json` as `columns.<name>.render: "url"` (D-xvii).
# `source_columns` follows the same always-emit rule as `missing_count`: EVERY fresh entry
# carries it, INCLUDING the empty list a grid layout carries, so absence means exactly
# "carried forward from a pre-2.9 bake" and never "depends on nothing".
#
# v2.10 (T2-a-layout-cannot-say-it-is-stale-once-the-job / LAYOUT_DESIGNER D-xxix) adds the
# per-layout `source_fingerprint`: HOW those columns were read — the fingerprint tuples the
# layout's OWN role entry contributed, keyed by column. 2.9 made "which layouts does this
# metadata change stale?" a lookup; 2.10 makes it answerable AFTER the commit, because a
# roles-only edit rewrites `column_roles` and bakes nothing, so without a bake-time record
# the only evidence is the finished job's `result`, which RQ drops after 500 s. Same
# always-emit rule again: EVERY fresh entry carries it, INCLUDING the `{}` a grid layout
# carries, so absence means exactly "carried forward from a pre-2.10 bake".
_logger = logging.getLogger(__name__)

MANIFEST_VERSION = "2.10"


PRESENTATION_FILENAME = "presentation.json"

# The roles the v2.9 MINOR RETIRED from `column_roles` because they were presentation
# collected on the bake's input path (D-xvii). `column_roles.schema.json` no longer
# declares them and is `additionalProperties: false`, so a manifest committed before 2.9
# fails BOTH `ColumnRoles.from_config` and `_validate_manifest` — which means every
# producer operation on such a dataset (`add-layouts`, `refresh-manifest`) is blocked
# until the key leaves the file. Measured 2026-09-07: FOUR of the six real dataset trees
# carry `column_roles.url`, including `rijks_pilot`, the live public demo.
_RETIRED_ROLES = ("url",)


class RetiredRoleNotMigrated(ValueError):
    """A committed manifest still carries a role the v2.9 MINOR retired, and
    `presentation.json` does not yet hold the equivalent — so dropping it would DESTROY
    the setting. The remedy is an operator command, not a data fix, so this is its own
    error rather than a `ColumnRoleError`."""


def drop_retired_roles(manifest: dict, dataset_dir: Path) -> dict:
    """Return `manifest` with any v2.9-retired `column_roles` key removed — but ONLY once
    `presentation.json` demonstrably carries the same information.

    **Why this is conditional rather than an unconditional strip.** The obvious fix to
    "old manifests no longer validate" is to drop the retired key on read and warn. That
    is self-healing and it silently loses data: the API's `migrate-presentation` COPIES
    `column_roles.url` into `presentation.json` and cannot remove it from the manifest
    (the API never writes `layout_manifest.json` — D-xv, and the whole point of the
    two-file split), so an unconditional strip run FIRST destroys the user's link
    settings with no way back. Ordering that hazard away with documentation is how a
    silent divergence ships; checking is ~10 lines and cannot be forgotten.

    So: covered => drop it and say so at WARNING (the operator should know their manifest
    was rewritten, and why). Not covered => refuse, naming the command that fixes it.
    Neither branch can lose a setting.

    Coverage for `url` means every column the manifest names is present in
    `presentation.json` as `columns.<name>.render == "url"`. A column named in the
    manifest but absent from the record is NOT covered — that is exactly the
    half-migrated state this guard exists to catch.

    **This is the pipeline READING `presentation.json`, which is deliberate and bounded.**
    D-xv makes the API its sole WRITER; nothing here writes it, and nothing here validates
    it (that is the API's job, on write). The read exists only to answer "may this key be
    dropped without losing anything", and it fails CLOSED — an unreadable or malformed
    record is treated as not covering anything.

    A manifest with no retired key is returned unchanged, identity-equal, so the ordinary
    2.9-onwards path pays one `dict.get`.
    """
    roles = manifest.get("column_roles")
    if not isinstance(roles, dict):
        return manifest
    present = [r for r in _RETIRED_ROLES if r in roles]
    if not present:
        return manifest

    record = _read_presentation(dataset_dir)
    columns = record.get("columns") if isinstance(record, dict) else None
    covered: dict[str, list[str]] = {}
    for role in present:
        named = [c for c in (roles.get(role) or []) if isinstance(c, str)]
        if not named:
            # The role is present and names NOTHING -- `{"url": []}`, or a list of
            # non-strings. There is no setting to lose, so there is nothing to migrate
            # and nothing to check: drop it. Without this short-circuit the tree WEDGES,
            # and the loop is closed rather than merely slow: `all(... for c in [])` is
            # vacuously True, so `has` turned on `isinstance(columns, dict)` alone and a
            # dataset with no `presentation.json` was refused -- while the command the
            # refusal names computes `legacy_url_columns(roles) == []`, finds no updates,
            # reports "current" and writes nothing. The operator retries forever, doing
            # the right thing each time (review of PR #346, finding 3).
            covered[role] = []
            continue
        if role == "url":
            # OWNERSHIP, not `render == "url"`. The read path
            # (`api/presentation.effective`) applies the legacy role only to a column the
            # record does NOT describe: `if name not in columns`. So the moment the file
            # carries an entry for a column, the manifest's role for it is already dead
            # letter — dropping it takes nothing away. Asking for `render == "url"`
            # instead looks stricter and is wrong twice over: it would refuse a dataset
            # whose migration had correctly reported success, blocking add-layouts and
            # refresh-manifest with no message saying why; and it would deny that
            # describing a column WITHOUT a render is how "this is not a link" is
            # expressed at all — the schema has no null and blank means removed, so an
            # entry with no `render` is the only way to clear one. Pinned by
            # `test_migrate_does_not_overwrite_an_existing_column_entry` on the API side,
            # which is what caught this: a first draft of this guard used the stricter
            # test and broke that spec.
            has = isinstance(columns, dict) and all(c in columns for c in named)
        else:  # pragma: no cover - _RETIRED_ROLES has one member today
            has = False
        if not has:
            raise RetiredRoleNotMigrated(
                f"{dataset_dir.name}: layout_manifest.json still carries the retired "
                f"role column_roles.{role} ({named!r}), and {PRESENTATION_FILENAME} does "
                f"not carry the equivalent. Dropping it here would lose the setting. "
                f"Run `python -m api.admin migrate-presentation` against this dataset "
                f"first, then retry — and note that a `refresh-manifest` retry on a tree "
                f"already carrying the 2.5 enrichment needs `--force`, since the "
                f"already-enriched gate downstream answers 'nothing to do' before it "
                f"reaches the rewrite that drops this key."
            )
        covered[role] = named

    out = dict(manifest)
    out["column_roles"] = {k: v for k, v in roles.items() if k not in covered}
    _logger.warning(
        "%s: dropped retired column_roles %s from layout_manifest.json -- already "
        "carried by %s, so nothing was lost. The v2.9 MINOR moved these to the "
        "presentation record (D-xvii); this rewrite is what unblocks add-layouts and "
        "refresh-manifest on a pre-2.9 tree.",
        dataset_dir.name,
        {k: v for k, v in covered.items()},
        PRESENTATION_FILENAME,
    )
    return out


def _read_presentation(dataset_dir: Path) -> dict | None:
    """`presentation.json` as a dict, or None on ANY doubt — absent, unreadable, not
    JSON, not an object. FAILS CLOSED on purpose: this feeds a "may I delete something"
    decision, so doubt must mean "no", never "probably fine"."""
    try:
        raw = (dataset_dir / PRESENTATION_FILENAME).read_text(encoding="utf-8")
        record = json.loads(raw)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


@lru_cache(maxsize=None)
def _manifest_schema() -> dict:
    text = (_schema_dir() / "layout_manifest.schema.json").read_text(encoding="utf-8")
    return json.loads(text)


def _registry() -> Registry:
    """Resolve the manifest's external ``$ref`` (column_roles.schema.json) by
    basename from the schema dir (schemas/v2/), mirroring the architecture-owned
    contract test."""

    def retrieve(uri: str) -> Resource:
        name = uri.rsplit("/", 1)[-1]
        contents = json.loads((_schema_dir() / name).read_text(encoding="utf-8"))
        return Resource.from_contents(contents)

    return Registry(retrieve=retrieve)  # type: ignore[call-arg]


def write_manifest(
    dataset_id: str,
    dataset_version: int,
    layouts: list["LayoutResult"],
    pyramids: dict[str, "PyramidResult"],
    roles: "ColumnRoles | None",
    image_count: int,
    source: Path | None,
    output_path: Path,
    tags_path: Path | None = None,
    ingest_timestamp: str | None = None,
    positions: dict[str, Path] | None = None,
) -> Path:
    """
    Assemble and write the v2 layout manifest JSON (validated against
    schemas/v2/layout_manifest.schema.json), atomically (temp + rename). Sole writer
    of the manifest. Emits manifest_version "2.10" (decision D-33; v2.10 added the per-layout
    ``source_fingerprint`` record of HOW each layout read its columns; v2.9 added the per-layout
    ``source_columns`` provenance list and removed ``column_roles.url``; v2.8 added
    ``column_roles.url``; v2.7 added the datetime
    ``annotations.axes[].interval`` bucketing rung, T2-142 / D-36 seam H3; v2.6 added the
    optional
    per-layout ``missing_count`` unplaced-cell count, T2-140 / D-36 seam U1; v2.5 added the
    optional per-layout ``annotations`` — categorical labels + datetime axis domain,
    T2-69/T2-72
    Seam 2; v2.4 added the ``"geographic"`` layout type + the ``options.projection`` echo
    — D-35 Seam G2; v2.3
    added the optional per-layout ``options`` echo — D-35 Seam G1; v2.2 added the optional
    per-layout ``positions_ref`` position table; v2.1 reconciled coincident-point
    subsampling with the dense-id contract).

    ``pyramids`` maps layout_id -> the PyramidResult the tiler baked for that layout
    (its PMTiles path + tile_px/thumb_px/cap/levels/z_cap + optional detail tier).
    Each layout entry's ``pyramid`` (and optional ``detail``) is derived from it.

    ``roles`` is None for images-only datasets — the manifest then omits
    ``column_roles`` (decision D-25). ``source`` is the optional provenance of the
    metadata source; None => omit ``dataset_metadata.source``. ``tags_path``, when
    present, is recorded as the optional ``tags`` declaration (D-14).

    ``positions`` maps layout_id -> the layout's position-table path (T2-66 / T2-48,
    v2.2). A layout present in the map gets a ``positions_ref`` (relativized to the
    dataset root); a layout absent from it (or ``positions`` is None) omits the field
    — so the renderer falls back to fine-tier-only picking with no error.

    ``ingest_timestamp`` overrides the stamped time (ISO-8601 ``...Z``); used by the
    deterministic fixture builder so the committed fixtures regenerate byte-stable.
    Defaults to ``now()`` (the production path).
    """
    dataset_root = output_path.parent
    dataset_metadata: dict = {
        "image_count": image_count,
        "ingest_timestamp": ingest_timestamp
        or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if source is not None:
        dataset_metadata["source"] = source.name
    manifest: dict = {
        "manifest_version": MANIFEST_VERSION,
        "dataset_id": dataset_id,
        "dataset_version": dataset_version,
        "layouts": [
            _layout_entry(
                layout,
                pyramids[layout.layout_id],
                _positions_ref(positions, layout.layout_id, dataset_root),
            )
            for layout in layouts
        ],
        "dataset_metadata": dataset_metadata,
    }
    if roles is not None:  # absent => images-only dataset (decision D-25)
        manifest["column_roles"] = _roles_to_dict(roles)
    if tags_path is not None:
        manifest["tags"] = {
            "path": _relative_to_root(tags_path, dataset_root),
            "format": "arrow",
        }

    _validate_manifest(manifest)
    _atomic_write_json(manifest, output_path)
    return output_path


def append_manifest_layouts(
    committed_manifest: dict,
    new_layouts: list["LayoutResult"],
    new_pyramids: dict[str, "PyramidResult"],
    dataset_version: int,
    output_path: Path,
    roles: "ColumnRoles | None" = None,
    tags_path: Path | None = None,
    positions: dict[str, Path] | None = None,
) -> Path:
    """Assemble and write a MERGED manifest for the ``add-layouts`` path (T2-42):
    the committed manifest's existing ``layouts`` are carried through BYTE-PRESERVED
    (the exact JSON objects the prior bake wrote — their version-stamped pyramid
    ``path``, ``detail``, and ``positions_ref`` blocks stay valid so the OLD pyramids
    + position tables keep resolving), with the newly-baked ``new_layouts`` appended.
    Sole writer of the manifest, alongside ``write_manifest``; atomic (temp + rename),
    re-validated against ``schemas/v2/layout_manifest.schema.json`` before the write.

    ``committed_manifest`` is the parsed prior ``layout_manifest.json``. Its
    top-level fields (``dataset_id``, ``dataset_metadata``, and
    ``column_roles``/``tags`` unless overridden below) are preserved verbatim;
    ``dataset_version`` is bumped, ``layouts`` grows, and ``manifest_version`` is
    re-stamped to the current ``MANIFEST_VERSION`` ONLY WHEN EVERY MERGED ENTRY EARNS IT
    (2026-09-24 round-2 review, N4, correcting this sentence): the merged file may carry
    fields of the newest minor on the APPENDED layouts (e.g. a v2.3 ``options`` echo), so
    the stamp must be able to describe what the file contains — but the carried-forward
    entries are byte-preserved, and on a pre-2.10 tree they record no ``source_fingerprint``,
    so stamping unconditionally claimed a key five of six entries did not have. Consumers
    are major-only, so both the re-stamp and its withholding are behavior-neutral for them.

    ``roles`` REPLACES the committed ``column_roles`` when given (the add-layouts
    roles-override path — the effective roles were re-validated against the existing
    metadata.parquet); None leaves the committed ``column_roles`` untouched.
    ``tags_path``, when given, REPLACES the committed ``tags`` declaration (the
    add-layouts run wrote a fresh version-stamped sidecar); None leaves ``tags`` as
    committed. ``positions`` maps each NEW layout_id -> its position-table path
    (T2-66 / T2-48, v2.2), setting the added entry's ``positions_ref``; the
    carried-forward layouts keep whatever ``positions_ref`` they were committed with
    (byte-preserved above).

    A new layout_id that COLLIDES with a committed one REPLACES that entry IN PLACE,
    keeping its position in the list — the ``add-layouts --replace <layout_id>`` path
    (seam L2 / [[T2-add-layouts-cannot-replace-a-committed-layout]]). Two consequences
    are deliberate:

      * **In place, not appended.** ``layouts`` order is the display order in the layout
        switcher, and it is also what a ``presentation.json`` ``default_layout`` falls
        back to when it dangles ("the first layout", D-xvi). Re-baking a layout must not
        silently reorder the switcher or move which layout is the fallback default.
      * **The ID is preserved**, which is the whole point of a replace: D-xvi keys
        ``presentation.json`` by ``layout_id``, so a re-bake that minted a fresh id would
        silently discard the user's rename and their default-layout choice.

    WHETHER a collision is permitted is the CALLER'S decision, not this function's:
    ``worker._guard_no_collision`` still refuses every collision by default and only the
    explicit per-id ``--replace`` opt-out narrows it. This function is unchanged for the
    ordinary append — with no colliding id the loop below produces exactly
    ``prior + [new...]``.
    """
    dataset_root = output_path.parent
    prior = list(committed_manifest.get("layouts", []))
    fresh = {
        layout.layout_id: _layout_entry(
            layout,
            new_pyramids[layout.layout_id],
            _positions_ref(positions, layout.layout_id, dataset_root),
        )
        for layout in new_layouts
    }
    merged: list[dict] = []
    for entry in prior:
        # `pop`, not `get`: a spliced entry must not ALSO be appended below, and a second
        # prior entry with the same id (which the schema does not forbid) then keeps its
        # committed bytes rather than being duplicated by the replacement.
        replacement = fresh.pop(entry.get("layout_id"), None)
        merged.append(entry if replacement is None else replacement)
    merged.extend(fresh.values())  # genuinely NEW layouts, appended in request order

    manifest: dict = dict(committed_manifest)  # shallow copy; carry every top-level field
    # Re-stamp the schema minor — but ONLY WHEN EVERY ENTRY EARNS IT (2026-09-23 review,
    # finding 8). The merged file may carry current-minor fields on the appended entries,
    # so it must be able to self-describe as such; the carried-forward entries, however,
    # are byte-preserved, and on a pre-2.10 tree they record no `source_fingerprint`. This
    # used to stamp unconditionally, which is the same "the stamp claims content that is
    # not there" bug `run_set_roles` and `refresh-manifest` already refuse to commit — and
    # add-layouts is the path that reaches it most often, because appending one layout to
    # an old collection is an ordinary thing to do. Under-claiming the minor is safe:
    # readers gate on FIELD PRESENCE, never on `manifest_version`.
    if all(isinstance(entry.get("source_fingerprint"), dict) for entry in merged):
        manifest["manifest_version"] = MANIFEST_VERSION
    manifest["dataset_version"] = dataset_version
    manifest["layouts"] = merged
    if roles is not None:  # roles overridden this run => re-emit column_roles
        manifest["column_roles"] = _roles_to_dict(roles)
    if tags_path is not None:  # a fresh sidecar was baked => repoint tags
        manifest["tags"] = {
            "path": _relative_to_root(tags_path, dataset_root),
            "format": "arrow",
        }

    _validate_manifest(manifest)
    _atomic_write_json(manifest, output_path)
    return output_path


def _validate_manifest(manifest: dict) -> None:
    """Validate a fully-assembled manifest against the v2 schema (resolving the
    external column_roles $ref). Shared by ``write_manifest`` and
    ``append_manifest_layouts``."""
    jsonschema.Draft202012Validator(
        _manifest_schema(),
        registry=_registry(),
        format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
    ).validate(manifest)


def revalidate_and_write(manifest: dict, output_path: Path) -> Path:
    """Re-validate an ALREADY-ASSEMBLED manifest dict against ``schemas/v2`` and write it
    atomically (temp + rename). The public rewrite entry point for the ``refresh-manifest``
    path (T2-69/T2-72 Seam 2 backfill): it enriches a committed manifest IN PLACE — adds
    the v2.5 ``bbox_exact`` + ``annotations`` (derived from the baked artifacts) and
    re-stamps ``manifest_version`` — rather than re-assembling from a fresh bake. Kept HERE
    so ``manifest.py`` stays the SOLE writer of ``layout_manifest.json`` (the schema gate +
    atomic write live in one place, never re-implemented in the caller), alongside
    ``write_manifest`` and ``append_manifest_layouts``."""
    _validate_manifest(manifest)
    _atomic_write_json(manifest, output_path)
    return output_path


def _layout_entry(
    layout: "LayoutResult", pyramid: "PyramidResult", positions_ref: str | None = None
) -> dict:
    entry: dict = {
        "layout_id": layout.layout_id,
        "label": layout.label,
        "type": layout.layout_type,
        "bbox": [round(float(v), 6) for v in layout.bbox],
        # v2.5 (T2-72 Seam 2): the FULL-PRECISION (unrounded) bbox the tiler actually binned
        # cell centres against. `bbox` above is rounded to 6 dp for tidiness, but a consumer
        # replicating the tiler's binning (the aggregate count chips) drifts on boundary tiles
        # when it uses the rounded value (PR #179 verification: rijks 17,403 vs 17,405 baked).
        # Emitted on every layout so a 2.5-aware chip derivation bins EXACTLY; a pre-2.5 bake
        # lacks it and the consumer falls back to the rounded `bbox` (honest approximation).
        "bbox_exact": [float(v) for v in layout.bbox],
        "pyramid": {
            "container": "pmtiles",
            "path": pyramid.path,
            "tile_px": pyramid.tile_px,
            "thumb_px": pyramid.thumb_px,
            "cap": pyramid.cap,
            "levels": [{"z": lv.z, "tile_count": lv.tile_count} for lv in pyramid.levels],
            "z_cap": pyramid.z_cap,
            # v2.5 (PR-180 review): the bake's TOTAL subsampled-out cell count across all
            # fine tiles — the tiler always computed this and discarded it manifest-side.
            # 0 ⇔ no over-cap tile exists, which lets the viewer SKIP its O(n) pile
            # re-derivation entirely for the common no-pile layout (grid, most
            # datetime/categorical bakes) instead of scanning 1M cells to find nothing.
            # Absent on a pre-2.5 bake ⇒ the viewer scans (chunked) as before.
            "dropped_total": pyramid.dropped_total,
        },
    }
    if positions_ref is not None:
        # v2.2 (T2-66/T2-48): the layout's id->(x,y,w,h) position table, for
        # pick-at-any-zoom. Omitted (not null) when the layout baked no table, so a
        # pre-2.2 dataset carries no positions_ref and the renderer falls back cleanly.
        entry["positions_ref"] = positions_ref
    if layout.options is not None:
        # v2.3 (D-35 Seam G1): echo the layout-shaping options APPLIED at bake time
        # (scatter: x_scale/y_scale/normalize/overlap). The layout that applied them is
        # the authority (LayoutResult.options); it is None — and this key omitted — for
        # every layout baked with all-default knobs, so a default bake is byte-for-byte
        # its pre-2.3 form.
        entry["options"] = layout.options
    if layout.annotations is not None:
        # v2.5 (T2-69 / T2-72 Seam 2): the overlay annotations the LayoutResult captured —
        # the categorical treemap's per-band {text, extent, count, missing?} labels, or
        # the datetime layout's {orientation, scale, domain, range, label} x-axis. A
        # datetime layout that DECLINES its axis (degenerate span / calendar overflow)
        # emits the explicit {"axes": []} marker — never omitted — so the client's
        # pre-2.5 shim does not resurrect an axis the producer refused (PR-180 review).
        # None — and this key omitted — only for the families that emit no annotations
        # at all (grid/scatter/geographic).
        entry["annotations"] = layout.annotations
    # v2.6 (T2-140 / D-36 seam U1): how many cells this layout could NOT place from the
    # column it arranges by — datetime's undated images, scatter/geographic's null
    # coordinates, categorical's structurally-missing band. Emitted UNCONDITIONALLY,
    # including 0 — the same rule `pyramid.dropped_total` has used since 2.5, and the only
    # rule that makes the contract's presence gate mean anything: 0 says "this producer
    # counted and found none", and an ABSENT key says "this entry predates 2.6". An earlier
    # draft omitted it at zero and claimed that distinction anyway, which is exactly the
    # pair omitting collapses. On the LAYOUT, not on `annotations.axes[]`: a datetime layout
    # that DECLINES its axis still strips its undated cells, and scatter/geographic emit no
    # annotations at all, so an axis-borne count could describe neither.
    entry["missing_count"] = layout.missing_count
    # v2.9 (T2-a-layout-does-not-record-which-column-it-was): which metadata columns this
    # layout was DERIVED from, so "which layouts does this metadata change stale?" is a
    # lookup rather than an inference from column_roles + type + a layout_id convention.
    # Emitted UNCONDITIONALLY — including the EMPTY list a grid layout carries — for the
    # same reason `missing_count` is: `[]` is the positive claim "this producer recorded
    # its sources and there are none", while an ABSENT key means "this entry predates 2.9".
    # Omitting at empty would collapse those two, and grid is the case that matters (it
    # genuinely depends on nothing, so a reader must be able to tell that from silence).
    # `list(...)` because the LayoutResult carries an immutable tuple and JSON wants an array.
    entry["source_columns"] = list(layout.source_columns)
    # v2.10 (T2-a-layout-cannot-say-it-is-stale-once-the-job): HOW this layout read those
    # columns — the fingerprint tuples ITS OWN role entry contributed, so "is this bake out
    # of date?" is answerable from the tree forever instead of only from a finished job's
    # `result` (which RQ drops after 500 s). Same always-emit rule as `source_columns`, and
    # the same reason: `{}` is grid's positive "reads no column, so there is no way of
    # reading to record" and an ABSENT key means "this entry predates 2.10". Its keys are
    # exactly `source_columns` because both are set by the plugin from one role entry.
    entry["source_fingerprint"] = fingerprint_to_json(layout.source_fingerprint)
    if pyramid.detail_path_prefix is not None:
        entry["detail"] = {
            "mode": "image_ref",
            "path_prefix": pyramid.detail_path_prefix,
            "format": pyramid.detail_format or "webp",
        }
    # Phase-1 layouts are non-network (edges is None); the per-layout `edges`
    # declaration lands with Phase 2.
    return entry


def _positions_ref(
    positions: dict[str, Path] | None, layout_id: str, dataset_root: Path
) -> str | None:
    """The dataset-relative ``positions_ref`` for ``layout_id`` (v2.2), or None when
    this layout baked no position table (``positions`` is None or lacks the id) — in
    which case ``_layout_entry`` omits the field entirely."""
    if positions is None:
        return None
    path = positions.get(layout_id)
    return None if path is None else _relative_to_root(path, dataset_root)


def role_entry_fingerprints(kind: str, entry: object) -> dict[str, tuple[tuple, ...]]:
    """``column -> the fingerprint tuples THIS ONE role entry contributes`` — the single
    definition of the tuple, for ONE entry (v2.10).

    THE TUPLE IS THE SAME VOCABULARY IT HAS ALWAYS BEEN. In it: the ROLE KIND, so
    freeform -> categorical registers; every knob that changes how the column is READ
    (``datetime.format``, ``tag.delimiter``, the scatter scale/normalize/overlap set, the
    geographic projection/overlap set, ``embedding.dim``); and, for the PAIR families, the
    partner column and the axis position, because repointing a scatter's y changes what
    its x means. Deliberately OUT: ``label`` — a free tier-1 edit that costs nothing and
    stales nothing (LAYOUT_DESIGNER D-xx).

    WHY IT IS PER ENTRY AND NOT PER COLUMN. ``worker._role_fingerprints`` answers "every
    way this role MAP reads this column" and is built on top of this function; the
    ``layoutEntry.source_fingerprint`` record answers "how did THIS layout read it", which
    is a subset. The union is wrong in the record: a second scatter pair sharing an axis
    column, or a tag role added to a categorical column, would change the column's whole
    set and make an untouched layout read stale forever (LAYOUT_DESIGNER D-xxix).

    A SELF-PAIR IS THE CASE TO GET RIGHT: ``(sx, sx)`` returns ONE key carrying TWO tuples
    (the x tuple and the y tuple), because the entry's ``source_columns`` de-duplicates the
    column while both axes are still declared on it.

    The knob NAMES come from ``_SCATTER_KNOB_DEFAULTS``/``_GEO_KNOB_DEFAULTS`` — the same
    dicts the emitter iterates to decide what to serialize — so a fifth knob cannot reach
    the manifest without reaching the fingerprint. ``kind`` is the role name as
    ``column_roles`` declares it; an unknown one raises rather than fingerprinting to
    nothing, which would read as "this column is not interpreted at all"."""
    out: dict[str, list[tuple]] = {}

    def add(column: str, fingerprint: tuple) -> None:
        out.setdefault(column, []).append(fingerprint)

    if kind == "scatter":
        sc = cast("ScatterRoleEntry", entry)
        knobs = tuple(getattr(sc, knob) for knob in _SCATTER_KNOB_DEFAULTS)
        add(sc.x_column, ("scatter", "x", sc.y_column) + knobs)
        add(sc.y_column, ("scatter", "y", sc.x_column) + knobs)
    elif kind == "geographic":
        geo = cast("GeographicRoleEntry", entry)
        knobs = tuple(getattr(geo, knob) for knob in _GEO_KNOB_DEFAULTS)
        add(geo.lon_column, ("geographic", "lon", geo.lat_column) + knobs)
        add(geo.lat_column, ("geographic", "lat", geo.lon_column) + knobs)
    elif kind == "datetime":
        dt = cast("DatetimeRoleEntry", entry)
        add(dt.column, ("datetime", dt.format))
    elif kind == "tag":
        tag = cast("TagRoleEntry", entry)
        add(tag.column, ("tag", tag.delimiter))
    elif kind == "embedding":
        emb = cast("EmbeddingRoleEntry", entry)
        add(emb.column, ("embedding", emb.dim))
    elif kind in ("filename", "categorical", "freeform"):
        add(cast("RoleEntry", entry).column, (kind,))
    else:
        raise ValueError(
            f"role_entry_fingerprints: unknown role kind {kind!r}. A role with no "
            f"fingerprint would read as 'this column is not interpreted', which is a "
            f"claim, so a new role must be added here rather than defaulted."
        )
    return {column: tuple(fingerprints) for column, fingerprints in out.items()}


def fingerprint_to_json(fingerprints: dict[str, tuple[tuple, ...]]) -> dict[str, list[list]]:
    """``source_fingerprint`` as the manifest carries it: the tuples become JSON arrays.
    Sorted by column and then by encoded tuple ONLY so a diff of two manifests is
    readable — nothing may compare these by position (Python's ``json.dumps`` escapes
    non-ASCII and ``JSON.stringify`` does not, so the two sides sort differently on a
    column like ``é``; the comparison is by SET MEMBERSHIP everywhere)."""
    return {
        column: sorted((list(fp) for fp in fingerprints[column]), key=repr)
        for column in sorted(fingerprints)
    }


def _roles_to_dict(roles: "ColumnRoles") -> dict:
    out: dict = {"filename": {"column": roles.filename.column, "label": roles.filename.label}}
    if roles.datetime is not None:
        out["datetime"] = {
            "column": roles.datetime.column,
            "label": roles.datetime.label,
            "format": roles.datetime.format,
        }
    if roles.categorical:
        out["categorical"] = [{"column": e.column, "label": e.label} for e in roles.categorical]
    if roles.scatter:
        out["scatter"] = [_scatter_entry_to_dict(e) for e in roles.scatter]
    if roles.geographic:
        out["geographic"] = [_geographic_entry_to_dict(e) for e in roles.geographic]
    if roles.tag:
        out["tag"] = [
            {"column": e.column, "label": e.label, "delimiter": e.delimiter} for e in roles.tag
        ]
    if roles.freeform:
        out["freeform"] = [{"column": e.column, "label": e.label} for e in roles.freeform]
    # No `url` key: schema v2.9 removed the role (D-xvii). It is presentation and now lives
    # in `presentation.json`, which this module must never write.
    if roles.embedding is not None:
        out["embedding"] = {
            "column": roles.embedding.column,
            "label": roles.embedding.label,
            "dim": roles.embedding.dim,
        }
    return out


def _scatter_entry_to_dict(entry: "ScatterRoleEntry") -> dict:
    """Serialize one scatter role entry for the embedded column_roles. The four D-35
    Seam G1 knobs (x_scale/y_scale/normalize/overlap) are written ONLY when non-default,
    so an entry with no knobs is exactly {x_column, y_column, label} — byte-stable with
    every pre-2.3 bake."""
    out: dict = {"x_column": entry.x_column, "y_column": entry.y_column, "label": entry.label}
    for knob, default in _SCATTER_KNOB_DEFAULTS.items():
        value = getattr(entry, knob)
        if value != default:
            out[knob] = value
    return out


def _geographic_entry_to_dict(entry: "GeographicRoleEntry") -> dict:
    """Serialize one geographic role entry for the embedded column_roles (D-35 Seam G2).
    The projection/overlap knobs are written ONLY when non-default (same rule as the
    scatter knobs), so a default-equirectangular entry is exactly {lon_column, lat_column,
    label}. (The per-layout `options` echo — which the geographic plugin ALWAYS emits with
    the applied projection — is the self-describing record of what was baked; this is the
    minimal DECLARED config.)"""
    out: dict = {
        "lon_column": entry.lon_column,
        "lat_column": entry.lat_column,
        "label": entry.label,
    }
    for knob, default in _GEO_KNOB_DEFAULTS.items():
        value = getattr(entry, knob)
        if value != default:
            out[knob] = value
    return out


def _relative_to_root(path: Path, dataset_root: Path) -> str:
    """A manifest asset ref, relative to the dataset root. The staged/committed asset
    paths the emitters pass are ``{root}/tags/…`` / ``{root}/positions/…`` / etc.; the
    manifest records them WITHOUT the root prefix. Works whether the output root is
    ABSOLUTE (``/data/datasets`` — DATA_ROOT set) or RELATIVE (``datasets`` — the CLI
    default with DATA_ROOT unset): try ``relative_to`` in both cases (it handles a
    relative prefix too), and only fall back to the bare posix path when ``path`` is
    genuinely not under ``dataset_root`` (already a bare ref). Without the relative-root
    handling, grid's base-commit ``positions_ref``/``tags`` would keep the full
    ``datasets/.staging-…/…`` staging prefix under a relative root, because — unlike
    tags, which the per-layout commit re-points — grid's entry is carried forward
    byte-preserved and never corrected."""
    try:
        return path.relative_to(dataset_root).as_posix()
    except ValueError:
        return path.as_posix()


def _atomic_write_json(manifest: dict, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(output_path.parent), suffix=".json.tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2)
            handle.write("\n")
        os.replace(tmp, output_path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
