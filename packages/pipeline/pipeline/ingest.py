"""Image-set resolution + optional metadata join → metadata.parquet, plus the
tag-sidecar projection (decision D-14). Sole writer of metadata.parquet.

Images-first (decision D-25): the dataset IS the images. ``images_dir`` is scanned
**flat**; each cell ``id`` (int64) is assigned by **sorted filename**; the
``filename`` (basename) is stored as the join key. Duplicate basenames and an
empty image set are rejected (fail-fast, D-11). Metadata is **optional**: when a
source + ``column_roles`` are given, the enrichment columns are LEFT-JOINED onto
the images by filename (basename) via DuckDB ``read_csv_auto``; absent ⇒ a complete
images-only dataset whose ``metadata.parquet`` is exactly ``(id, filename, width,
height)`` and whose ``column_roles`` is ``None``.

Every row also carries the image's native pixel dimensions ``width`` and ``height``
as **nullable int32** (Seam D2): a cheap libvips header probe (no pixel decode)
captured at ingest, corrected for EXIF orientation so the recorded dims match what
the auto-rotating thumbnail/detail pipeline displays. An unreadable header records
``(null, null)`` — advisory metadata never gates ingest (the image is still scanned
and later decode-skipped as before). Datasets baked before D2 legally lack the two
columns; consumers tolerate their absence.

An enrichment column whose source name shadows a reserved pipeline column (``id``,
``filename``, ``width``, or ``height`` — the metadata.parquet keys/native columns)
is preserved beside the canonical columns under a derived name (``meta_<name>``) and
its ``column_roles`` entry is repointed there — the canonical columns are never
overwritten by user data (code-review follow-up, PR #12; extended for D2).
"""
from __future__ import annotations

import logging
import os
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import TypeVar

import duckdb
import jsonschema
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as feather
import pyarrow.parquet as pq

try:
    # Native (libvips) — used only for the header-only dimension probe (Seam D2).
    # Guarded so this module still imports in the lean test image (docker/
    # Dockerfile.test ships no libvips by design); there the probe returns null
    # dims. Production ingest always runs in the worker image, where pyvips is
    # present. Mirrors worker.py's lean/native discipline (pyvips off module import).
    import pyvips
except ImportError:  # pragma: no cover - exercised only in the lean test image
    pyvips = None  # type: ignore[assignment]

from pipeline.layout_plugins.base import (
    ColumnRoles,
    GeographicRoleEntry,
    RoleEntry,
    ScatterRoleEntry,
)

logger = logging.getLogger(__name__)

# Raster extensions pyvips can decode; the flat image scan whitelist.
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
# Canonical join-key column always written to metadata.parquet (the image basename).
_FILENAME_COL = "filename"
# Native pixel-dimension columns (Seam D2): nullable int32, orientation-corrected,
# always written alongside id + filename (null where the header was unreadable).
_WIDTH_COL = "width"
_HEIGHT_COL = "height"
# Pipeline-owned output columns. An enrichment column whose source name collides
# with one of these is stored under a derived name (see _namespaced) so the
# canonical id/filename (the metadata.parquet keys the API joins/filters on) and the
# native width/height are never overwritten by user data (code-review follow-up,
# PR #12; width/height added for D2).
_RESERVED_COLUMNS = frozenset({"id", _FILENAME_COL, _WIDTH_COL, _HEIGHT_COL})

# EXIF orientation values 5-8 transpose the image (90°/270° rotation), so the
# stored width/height are swapped relative to how it is DISPLAYED. libvips
# thumbnail() auto-rotates (the thumbs + detail originals are post-orientation), so
# the recorded dims must swap to match. Orientations 1-4 (identity/180°/mirror-only)
# keep the stored axes; an absent tag is treated as 1.
_TRANSPOSE_ORIENTATIONS = frozenset({5, 6, 7, 8})

_RoleEntryT = TypeVar("_RoleEntryT", bound=RoleEntry)


@dataclass(frozen=True)
class IngestResult:
    metadata_path: Path                  # written metadata.parquet (id, filename, width, height, + enrichment)
    column_roles: "ColumnRoles | None"   # validated; None for images-only (no metadata)
    image_index: list[tuple[int, Path]]  # (cell id, image path), ordered by id (sorted filename)
    image_count: int


class ColumnRoleError(ValueError):
    """Raised when the column-role config is invalid or a column's values do
    not satisfy its role's type constraint. Carries the offending column name
    and a human-readable reason."""
    def __init__(self, column: str, reason: str) -> None:
        self.column = column
        self.reason = reason
        super().__init__(f"{column}: {reason}")


def ingest_metadata(
    images_dir: Path,
    dataset_id: str,
    output_dir: Path,
    csv_path: Path | None = None,
    column_roles: dict | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> IngestResult:
    """
    Resolve the image set and (optionally) join a metadata source, writing
    metadata.parquet. The dataset IS the images (decision D-25): images_dir is
    scanned flat, each cell `id` is assigned by sorted filename, and `filename`
    (basename) is stored as the join key. Duplicate basenames are rejected; an
    empty image set is rejected.

    Every row carries the image's native pixel `width`/`height` as nullable int32
    (Seam D2): a cheap header-only libvips probe, EXIF-orientation-corrected so the
    dims match the auto-rotated thumbnail/detail output; an unreadable header
    records null dims and never blocks ingest.

    No metadata (csv_path/column_roles omitted) ⇒ write metadata.parquet as
    (id, filename, width, height) and return column_roles=None. Metadata present ⇒
    `column_roles` must validate against column_roles.schema.json (its `filename`
    role names the join column) and the enrichment columns are LEFT-JOINED onto the
    images by filename; a datetime column whose values do not parse under its
    declared format raises ColumnRoleError (gap #9 — validation at ingest time).
    Metadata rows with no matching image are dropped (logged).

    Sole writer of metadata.parquet (always carries id, filename, width, height).
    Does not generate thumbnails, atlases, layouts, or the manifest.

    ``on_progress(done, total)`` (optional, Seam O1) is invoked from the per-image
    dimension-probe loop — the one long, serial pass of this stage — with the running
    count and the known-upfront image total; the worker's ``prepare`` stage reporter
    supplies it. None makes it a no-op.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = output_dir / "metadata.parquet"

    image_paths = _scan_images(images_dir)
    filenames = [p.name for p in image_paths]
    ids = list(range(len(image_paths)))  # id = sorted-filename position (decision D-25)
    image_index = [(i, image_paths[i].resolve()) for i in ids]

    # Resolve + schema-validate the metadata config BEFORE the header probe, so a
    # malformed config fails fast rather than after probing every image's header (a
    # large corpus is minutes of header I/O). The CSV-CONTENT checks (column
    # presence, datetime/scatter parsing, knob VALUE preconditions) still run in
    # _join_metadata, which needs the probed base table; this hoists the cheap
    # presence + config-schema gate AND the pure-config scatter-knob checks
    # (validate_scatter_config — no I/O needed, so e.g. an unimplemented `overlap`
    # rejects before, not after, a 1M-image header probe).
    if (csv_path is None) != (column_roles is None):
        raise ColumnRoleError(
            "column_roles", "a metadata ingest needs both a source and column_roles"
        )
    roles: ColumnRoles | None = None
    if column_roles is not None:
        try:
            roles = ColumnRoles.from_config(column_roles)
        except jsonschema.ValidationError as exc:
            raise ColumnRoleError(
                "column_roles", f"config does not conform to schema: {exc.message}"
            ) from exc
        validate_scatter_config(roles)
        validate_geographic_config(roles)

    widths, heights = _probe_dimensions(image_paths, on_progress)  # native, orientation-corrected (Seam D2)
    base = pa.table(
        {
            "id": pa.array(ids, pa.int64()),
            _FILENAME_COL: pa.array(filenames, pa.string()),
            _WIDTH_COL: pa.array(widths, pa.int32()),    # nullable int32 (null on bad header)
            _HEIGHT_COL: pa.array(heights, pa.int32()),
        }
    )

    if roles is None:
        pq.write_table(base, metadata_path)  # images-only floor
        logger.info("ingested %d image(s), no metadata", len(ids))
        return IngestResult(metadata_path, None, image_index, len(image_index))

    assert csv_path is not None  # both-or-neither enforced above ⇒ roles set means csv_path set
    table, renamed = _join_metadata(base, filenames, csv_path, roles)
    pq.write_table(table, metadata_path)
    # Repoint any enrichment role whose column was namespaced to dodge a reserved
    # name, then bind the filename role to the canonical column we actually wrote.
    roles = _apply_renames(roles, renamed)
    roles = replace(roles, filename=RoleEntry(_FILENAME_COL, roles.filename.label))
    return IngestResult(metadata_path, roles, image_index, len(image_index))


def _scan_images(images_dir: Path) -> list[Path]:
    """Flat top-level scan for image files, sorted by basename. Rejects an empty
    set and duplicate basenames (fail-fast, decision D-25 / D-11)."""
    paths = sorted(
        (p for p in images_dir.iterdir() if p.is_file() and p.suffix.lower() in _IMAGE_EXTS),
        key=lambda p: p.name,
    )
    if not paths:
        raise ValueError(
            f"no image files found in {images_dir} (extensions: {sorted(_IMAGE_EXTS)})"
        )
    duplicates = [name for name, count in Counter(p.name for p in paths).items() if count > 1]
    if duplicates:
        raise ValueError(f"duplicate image basenames in {images_dir}: {sorted(duplicates)}")
    return paths


def _probe_dimensions(
    image_paths: list[Path], on_progress: Callable[[int, int], None] | None = None
) -> tuple[list[int | None], list[int | None]]:
    """Header-probe each image (in id order) for its native, EXIF-orientation-
    corrected ``(width, height)``, returning two id-aligned lists of ``int | None``
    (null where the header was unreadable). Advisory only (Seam D2): a null never
    gates ingest — a bad-header image is still scanned and later decode-skipped by
    the thumbnail pass exactly as before.

    A libvips header read is cheap (just the header — no pixel decode), so this runs
    inline-serial; the dominant ingest passes (thumbnail decode, detail transcode)
    are the ones that use atlas.vips_pool_map. When libvips is absent (the lean test
    image, docker/Dockerfile.test), no probe is possible and every image records null
    dims; production ingest runs in the worker image, where pyvips is present."""
    if pyvips is None:
        return [None] * len(image_paths), [None] * len(image_paths)

    widths: list[int | None] = []
    heights: list[int | None] = []
    unreadable = 0
    total = len(image_paths)
    for i, path in enumerate(image_paths):
        dims = _probe_one(path)
        if dims is None:
            unreadable += 1
            widths.append(None)
            heights.append(None)
        else:
            widths.append(dims[0])
            heights.append(dims[1])
        if on_progress is not None:
            on_progress(i + 1, total)  # absolute count; the reporter throttles
    if unreadable:
        # Aggregate (not per-image): a 1M corpus must not emit 1M log lines. The
        # thumbnail pass logs the actual per-image decode skips.
        logger.info(
            "dimension probe: %d/%d image header(s) unreadable (null dims)",
            unreadable, len(image_paths),
        )
    return widths, heights


def _probe_one(path: Path) -> tuple[int, int] | None:
    """One image's DISPLAYED (post-EXIF-orientation) pixel dimensions from a
    header-only read, or None if the header is unreadable. ``new_from_file`` is
    lazy — ``.width``/``.height``/the orientation tag are read from the header with
    no pixel decode. libvips reports the RAW stored dims plus an ``orientation``
    field; values 5-8 transpose the image, so its displayed size swaps the axes
    (matching the auto-rotating thumbnail/detail output). A missing tag ⇒ no swap.
    Never raises: an unreadable header OR an exotic non-int orientation value records
    null dims (advisory-skip) — a bad image must never gate ingest (Seam D2)."""
    try:
        img = pyvips.Image.new_from_file(str(path))
        width, height = img.width, img.height
        # get_typeof(name) == 0 ⇒ field absent (avoids get() raising on no tag).
        orientation = img.get("orientation") if img.get_typeof("orientation") != 0 else 1
        # int() inside the try (libvips loaders always store orientation as a GINT, but
        # a hand-crafted non-int tag would raise TypeError/ValueError — advisory-skip it
        # rather than crash the whole ingest).
        if int(orientation) in _TRANSPOSE_ORIENTATIONS:
            width, height = height, width
    except (pyvips.Error, TypeError, ValueError):
        return None
    return width, height


def _join_metadata(
    base: pa.Table, filenames: list[str], csv_path: Path, roles: ColumnRoles
) -> tuple[pa.Table, dict[str, str]]:
    """Left-join a metadata source's enrichment columns onto the (id, filename,
    width, height) base, matched by basename. Returns the joined table (id,
    filename, width, height, <enrichment…>) and a {source_name: stored_name} map of
    any enrichment columns renamed to avoid shadowing a reserved pipeline column
    (id/filename/width/height)."""
    source = _read_source(csv_path)
    con = duckdb.connect()  # short-lived, in-memory; NOT the API's shared DB
    try:
        description = con.execute(f"SELECT * FROM {source} LIMIT 0").description or []
        header = [str(d[0]) for d in description]
        _validate_columns_present(roles, header)
        if roles.datetime is not None:
            _validate_datetime(con, source, roles.datetime.column, roles.datetime.format)
        for scatter_col in _scatter_columns(roles):
            _validate_scatter(con, source, scatter_col)
        _validate_scatter_options(con, source, roles)
        # D-35 Seam G2 geographic: the SAME finite-float coordinate check (reusing
        # _validate_scatter — it is column-generic, the message names no family) then the
        # geographic-specific value checks (lon/lat range; mercator |lat|). The pure-config
        # geographic check (unimplemented overlap) already ran in the hoisted early gate
        # (validate_geographic_config), like validate_scatter_config.
        for geo_col in _geographic_columns(roles):
            _validate_scatter(con, source, geo_col)
        _validate_geographic_options(con, source, roles)
        enrichment = con.execute(f"SELECT {_enrichment_select(roles)} FROM {source}").to_arrow_table()
    finally:
        con.close()

    # Basename-normalize the join key; first row wins on duplicate basenames.
    keys = [os.path.basename(v) if v is not None else None for v in enrichment.column("_join_key").to_pylist()]
    enrichment = enrichment.select([c for c in enrichment.column_names if c != "_join_key"])
    first_index: dict[str, int] = {}
    for i, key in enumerate(keys):
        if key is not None and key not in first_index:
            first_index[key] = i

    take_indices = pa.array([first_index.get(fn) for fn in filenames], pa.int64())
    aligned = enrichment.take(take_indices)  # null row where an image had no metadata
    matched = sum(1 for fn in filenames if fn in first_index)
    logger.info("metadata: %d/%d image(s) matched a metadata row", matched, len(filenames))

    # Merge enrichment beside the canonical (id, filename, width, height). A column
    # whose source name shadows a reserved key is stored under a derived,
    # collision-free name so it never overwrites the canonical column (PR #12; D2
    # extends this to width/height); the rename is recorded so the caller can repoint
    # its role.
    columns = {
        "id": base.column("id"),
        _FILENAME_COL: base.column(_FILENAME_COL),
        _WIDTH_COL: base.column(_WIDTH_COL),
        _HEIGHT_COL: base.column(_HEIGHT_COL),
    }
    taken = set(columns) | set(aligned.column_names)
    renamed: dict[str, str] = {}
    for name in aligned.column_names:
        stored = name
        if name in _RESERVED_COLUMNS:
            stored = _namespaced(name, taken)
            taken.add(stored)
            renamed[name] = stored
            logger.warning(
                "metadata column %r shadows the reserved pipeline column; stored as %r",
                name, stored,
            )
        columns[stored] = aligned.column(name)
    return pa.table(columns), renamed


def _namespaced(name: str, taken: set[str]) -> str:
    """A collision-free physical name for an enrichment column whose source name
    shadows a reserved pipeline column: ``meta_<name>``, prefixed with extra
    underscores until unique among the names already taken."""
    candidate = f"meta_{name}"
    while candidate in taken:
        candidate = f"_{candidate}"
    return candidate


def _apply_renames(roles: ColumnRoles, renamed: dict[str, str]) -> ColumnRoles:
    """Repoint every enrichment role whose source column was stored under a derived
    name (a reserved-name collision in _join_metadata) to that physical name, so the
    manifest's role.column matches the column actually in metadata.parquet. The
    filename role is the dropped join key (rebound by the caller) and is left as-is."""
    if not renamed:
        return roles

    def repoint(entry: _RoleEntryT) -> _RoleEntryT:
        stored = renamed.get(entry.column)
        return replace(entry, column=stored) if stored else entry

    def repoint_scatter(entry: ScatterRoleEntry) -> ScatterRoleEntry:
        # Scatter entries carry a column PAIR, not a single `column` — repoint
        # each axis independently (the reserved-collision rules apply to scatter
        # columns like any enrichment column).
        return replace(
            entry,
            x_column=renamed.get(entry.x_column, entry.x_column),
            y_column=renamed.get(entry.y_column, entry.y_column),
        )

    def repoint_geographic(entry: GeographicRoleEntry) -> GeographicRoleEntry:
        # Geographic entries carry a lon/lat column PAIR (D-35 Seam G2) — repoint each
        # axis independently, exactly like scatter's x/y.
        return replace(
            entry,
            lon_column=renamed.get(entry.lon_column, entry.lon_column),
            lat_column=renamed.get(entry.lat_column, entry.lat_column),
        )

    return replace(
        roles,
        datetime=repoint(roles.datetime) if roles.datetime is not None else None,
        categorical=[repoint(e) for e in roles.categorical],
        tag=[repoint(e) for e in roles.tag],
        freeform=[repoint(e) for e in roles.freeform],
        embedding=repoint(roles.embedding) if roles.embedding is not None else None,
        scatter=[repoint_scatter(e) for e in roles.scatter],
        geographic=[repoint_geographic(e) for e in roles.geographic],
    )


def _validate_columns_present(roles: ColumnRoles, header: list[str]) -> None:
    present = set(header)
    referenced: list[tuple[str, str]] = [("filename", roles.filename.column)]
    if roles.datetime is not None:
        referenced.append(("datetime", roles.datetime.column))
    referenced += [("categorical", e.column) for e in roles.categorical]
    referenced += [("scatter", c) for e in roles.scatter for c in (e.x_column, e.y_column)]
    referenced += [("geographic", c) for e in roles.geographic for c in (e.lon_column, e.lat_column)]
    referenced += [("tag", e.column) for e in roles.tag]
    referenced += [("freeform", e.column) for e in roles.freeform]
    # No `url` entry here any more (schema v2.9, D-xvii): the role left column_roles for
    # `presentation.json`'s `columns.<name>.render`. The two guards it used to carry — the
    # column exists, and it is also a categorical/freeform column so its value is actually
    # stored — went with it and are NOT replaced at bake time. That is deliberate (D-xvi):
    # `presentation.json` is keyed by identifiers this file owns, and a key that no longer
    # resolves falls back on read instead of failing a bake. A bake-time check would have to
    # read the other file, which is the coupling the two-file split exists to remove.
    for role, column in referenced:
        if column not in present:
            raise ColumnRoleError(column, f"{role} column not found in metadata header {sorted(present)}")


def _validate_datetime(con: duckdb.DuckDBPyConnection, source: str, dt_col: str, fmt: str) -> None:
    col = _sql_ident(dt_col)
    cast_type = "TIMESTAMP" if fmt == "iso8601" else "BIGINT"
    row = con.execute(
        f"SELECT count({col}), count(TRY_CAST({col} AS {cast_type})) FROM {source}"
    ).fetchone()
    assert row is not None  # aggregate query always returns one row
    nonnull, parsed = row
    if parsed != nonnull:
        raise ColumnRoleError(dt_col, f"values do not all parse as {fmt}")


def _scatter_columns(roles: ColumnRoles) -> list[str]:
    """Distinct scatter coordinate columns in first-seen entry order (an axis
    column may be shared between entries; it is validated/projected once)."""
    seen: dict[str, None] = {}
    for entry in roles.scatter:
        seen.setdefault(entry.x_column, None)
        seen.setdefault(entry.y_column, None)
    return list(seen)


def _geographic_columns(roles: ColumnRoles) -> list[str]:
    """Distinct geographic lon/lat columns in first-seen entry order (D-35 Seam G2; a
    column may be shared between entries; it is validated/projected once)."""
    seen: dict[str, None] = {}
    for entry in roles.geographic:
        seen.setdefault(entry.lon_column, None)
        seen.setdefault(entry.lat_column, None)
    return list(seen)


def _coordinate_columns(roles: ColumnRoles) -> list[str]:
    """Distinct float-coordinate columns — scatter x/y THEN geographic lon/lat — in
    first-seen order, each projected ONCE to nullable float64 in the enrichment SELECT.
    A column shared between a scatter axis and a geographic axis is projected once. A
    scatter-only dataset gets exactly the old ``_scatter_columns`` set (byte-for-byte)."""
    seen: dict[str, None] = {}
    for entry in roles.scatter:
        seen.setdefault(entry.x_column, None)
        seen.setdefault(entry.y_column, None)
    for geo in roles.geographic:
        seen.setdefault(geo.lon_column, None)
        seen.setdefault(geo.lat_column, None)
    return list(seen)


def _validate_scatter(con: duckdb.DuckDBPyConnection, source: str, sc_col: str) -> None:
    """Fail-fast at ingest (D-11, decision D-26 directive): every NON-EMPTY value
    of a scatter coordinate column must parse as a finite float. Empty/null values
    are allowed — they become unplaced cells in the scatter layout."""
    col = _sql_ident(sc_col)
    row = con.execute(
        f"SELECT count(NULLIF({col}, '')), "
        f"count(CASE WHEN isfinite(TRY_CAST(NULLIF({col}, '') AS DOUBLE)) THEN 1 END) "
        f"FROM {source}"
    ).fetchone()
    assert row is not None  # aggregate query always returns one row
    nonempty, parsed = row
    if parsed != nonempty:
        raise ColumnRoleError(sc_col, "values do not all parse as finite floats")


def _fmt_value(value: float) -> str:
    """The offending scatter value, rendered EXACTLY, for an error message. ``repr``
    of a float is the shortest string that round-trips to the same value, so a value
    one ULP past a bound prints distinguishably — ``1.0000000000000002`` never
    collapses to a ``1`` that reads as in-range (the ``%g`` this replaces did exactly
    that, making a `normalize: "none"` rejection unactionable)."""
    return repr(float(value))


# The per-axis (axis-name, column, declared-scale) triples of one scatter entry —
# shared by the config- and value-level validators below.
def _axis_scales(entry: ScatterRoleEntry) -> tuple[tuple[str, str, str], ...]:
    return (
        ("x_scale", entry.x_column, entry.x_scale),
        ("y_scale", entry.y_column, entry.y_scale),
    )


def validate_scatter_config(roles: ColumnRoles) -> None:
    """Fail-fast (D-11) on D-35 Seam G1 knob COMBINATIONS that are invalid regardless
    of the data values — pure config checks, no I/O. Called from BOTH producer entry
    points: ``ingest_metadata`` (hoisted before the image header probe, so a config
    error never waits behind minutes of header I/O) and ``run_add_layouts`` (via
    ``worker._validate_roles_against_parquet`` — the roles-override path must enforce
    the same contract; the knobs' promises hold on every path, not just a CSV ingest).
    Nothing is ever silently ignored or fallen back (knobs, never sniffing; the user
    decides, we inform):

      * ``overlap`` other than ``"overdraw"`` (``"jitter"``/``"aggregate"``) — valid
        contract values but NOT YET IMPLEMENTED (D-35 Seam G4);
      * ``x_scale != y_scale`` (mixed log/linear) — the shared-scale aspect fit
        assumes commensurable axes; a lone log axis is measured in ln-units against a
        raw-unit axis, and the shared scale then crushes the logged axis (measured
        ~144x on the schema's own artwork-dimensions example, collapsing the fine
        tier). Rejected until a per-axis fit mode exists (T2-128);
      * ``normalize: "none"`` together with a ``"log"`` axis scale — contradictory
        (pass-through preserves the author's normalized values; a log would push an
        in-[0,1] value out of range); reject rather than silently drop the declared
        log.
    """
    for entry in roles.scatter:
        if entry.overlap != "overdraw":
            raise ColumnRoleError(
                entry.x_column,
                f"overlap '{entry.overlap}' on scatter entry '{entry.label}' is not "
                "implemented yet (coming — D-35 G4)",
            )
        if entry.x_scale != entry.y_scale:
            raise ColumnRoleError(
                entry.x_column,
                f"x_scale '{entry.x_scale}' with y_scale '{entry.y_scale}' on scatter "
                f"entry '{entry.label}' is not supported: the shared-scale aspect fit "
                "assumes both axes share one unit system, and a lone log axis would be "
                "crushed against the linear one — declare log on both axes or neither "
                "(a per-axis fit mode is tracked as T2-128)",
            )
        for axis, column, scale in _axis_scales(entry):
            if scale == "log" and entry.normalize == "none":
                raise ColumnRoleError(
                    column,
                    f"{axis} 'log' is incompatible with normalize 'none' — pass-through "
                    "preserves your normalized coordinates, so apply any scaling "
                    "upstream before normalizing into [0,1]",
                )


# An extent function: (x_column, y_column, measure_column) -> (min, max) of
# measure_column over the rows where BOTH axis columns are present/finite — the
# exact placement predicate (scatter.py places a cell only when both axes parse;
# any other row lands in the unplaced strip and is never transformed).
_PairExtent = Callable[[str, str, str], tuple[float | None, float | None]]


def _validate_scatter_values(roles: ColumnRoles, pair_extent: _PairExtent) -> None:
    """Fail-fast (D-11) on the D-35 Seam G1 knob VALUE preconditions, PER ENTRY — the
    data-dependent counterpart to ``validate_scatter_config``. Every message names the
    column and the offending value (rendered exactly — see ``_fmt_value``):

      * ``x_scale``/``y_scale``: ``"log"`` — that axis must be STRICTLY POSITIVE over
        the placeable rows (log is undefined at 0 and negatives); a row missing either
        coordinate is unplaced (bottom strip), never logged, and therefore exempt;
      * ``normalize: "none"`` — both axes' placeable values must lie within ``[0,1]``
        (pass-through preserves them up to one uniform scale, so out-of-range would
        land outside the canvas).

    The extents are measured over the rows of the metadata SOURCE that carry both
    coordinates (see ``_PairExtent``). On the CSV path this is a superset of the
    placed cells (a source row that matches no image, or loses the first-row-wins
    dedup, is counted here but never placed) — deliberately fail-closed: rejecting on
    a value that is in the user's source but not in the bake is over-strict, never
    unsafe, and the message says "the metadata source" accordingly. On the
    add-layouts path the parquet IS the joined table, so the extent is exact.
    """
    for entry in roles.scatter:
        for axis, column, scale in _axis_scales(entry):
            if scale == "log":
                low, _high = pair_extent(entry.x_column, entry.y_column, column)
                if low is not None and low <= 0.0:
                    raise ColumnRoleError(
                        column,
                        f"{axis} 'log' requires strictly-positive values, but the "
                        f"metadata source contains {_fmt_value(low)} (<= 0)",
                    )
        if entry.normalize == "none":
            for column in (entry.x_column, entry.y_column):
                low, high = pair_extent(entry.x_column, entry.y_column, column)
                offending: float | None = None
                if low is not None and low < 0.0:
                    offending = low
                elif high is not None and high > 1.0:
                    offending = high
                if offending is not None:
                    raise ColumnRoleError(
                        column,
                        f"normalize 'none' requires values already within [0,1], but "
                        f"the metadata source contains {_fmt_value(offending)}",
                    )


def _validate_scatter_options(
    con: duckdb.DuckDBPyConnection, source: str, roles: ColumnRoles
) -> None:
    """CSV-ingest adapter for the knob VALUE checks (``validate_scatter_config``
    already ran in the hoisted early gate). The pair predicate mirrors placement:
    only rows with BOTH coordinates non-empty are measured — ``_validate_scatter``
    guaranteed every non-empty value parses finite, so non-empty ≡ placeable here."""

    def pair_extent(
        x_column: str, y_column: str, column: str
    ) -> tuple[float | None, float | None]:
        cx, cy, col = _sql_ident(x_column), _sql_ident(y_column), _sql_ident(column)
        row = con.execute(
            f"SELECT min(v), max(v) FROM "
            f"(SELECT TRY_CAST(NULLIF({col}, '') AS DOUBLE) AS v FROM {source} "
            f"WHERE NULLIF({cx}, '') IS NOT NULL AND NULLIF({cy}, '') IS NOT NULL)"
        ).fetchone()
        assert row is not None  # aggregate query always returns one row
        return row[0], row[1]

    _validate_scatter_values(roles, pair_extent)


def validate_scatter_options_parquet(roles: ColumnRoles, metadata_path: Path) -> None:
    """add-layouts twin of the ingest-time knob VALUE checks (D-35 Seam G1): validate
    the declared knobs against the READ-ONLY committed ``metadata.parquet`` (there is
    no CSV on this path — the parquet is the frozen source). Called from
    ``worker._validate_roles_against_parquet`` AFTER its column presence/type checks
    (so the reads below never hit a missing column). The pair predicate uses
    ``is_finite`` — exactly ``scatter.py``'s ``_as_finite`` placement rule, so a NaN
    smuggled in by a hand-seeded parquet counts as unplaced here just as it would at
    layout time, never poisoning an extent."""
    needed = sorted({c for e in roles.scatter for c in (e.x_column, e.y_column)})
    if not needed:
        return
    table = pq.read_table(metadata_path, columns=needed)

    def pair_extent(
        x_column: str, y_column: str, column: str
    ) -> tuple[float | None, float | None]:
        # and_/is_finite/min_max are dynamically-registered compute kernels the
        # pyarrow stubs do not model — real at runtime (pinned by the parquet-gate
        # tests in test_scatter.py).
        both = pc.and_(  # type: ignore[attr-defined]
            pc.is_finite(table.column(x_column)),  # type: ignore[attr-defined]
            pc.is_finite(table.column(y_column)),  # type: ignore[attr-defined]
        )
        values = table.column(column).filter(pc.fill_null(both, False))
        if len(values) == 0:
            return None, None
        extremes = pc.min_max(values)  # type: ignore[attr-defined]
        return extremes["min"].as_py(), extremes["max"].as_py()

    _validate_scatter_values(roles, pair_extent)


# D-35 Seam G2 geographic value bounds (fail-fast at ingest, D-11, on BOTH producer entry
# points). Longitude/latitude are real-world degrees; Web Mercator additionally diverges
# past the clip latitude (its northing -> infinity), so mercator rejects |lat| beyond it
# rather than silently clamping.
_GEO_LON_MIN, _GEO_LON_MAX = -180.0, 180.0
_GEO_LAT_MIN, _GEO_LAT_MAX = -90.0, 90.0
_MERCATOR_MAX_LAT = 85.051129


def validate_geographic_config(roles: ColumnRoles) -> None:
    """Fail-fast (D-11) on D-35 Seam G2 geographic knob COMBINATIONS invalid regardless of
    the data values — pure config, no I/O. Called from BOTH producer entry points, exactly
    like ``validate_scatter_config``: ``ingest_metadata`` (hoisted before the image header
    probe) and ``run_add_layouts`` (via ``worker._validate_roles_against_parquet``). The
    geographic family has NO scale knobs, so the only config check is an unimplemented
    ``overlap`` (jitter/aggregate — D-35 Seam G4). Names a real column (the ``.column``
    invariant); the label rides in the message text."""
    for entry in roles.geographic:
        if entry.overlap != "overdraw":
            raise ColumnRoleError(
                entry.lon_column,
                f"overlap '{entry.overlap}' on geographic entry '{entry.label}' is not "
                "implemented yet (coming — D-35 G4)",
            )


def _guard_coord_range(
    column: str, what: str, low: float | None, high: float | None, min_v: float, max_v: float
) -> None:
    """Fail-fast (D-11) if a geographic column's PLACING extent falls outside
    ``[min_v, max_v]``, naming the column + the offending EXTREME value (rendered exactly —
    see ``_fmt_value``). Empty/null (unplaced) values are exempt (the extent is over the
    rows that place)."""
    offending: float | None = None
    if low is not None and low < min_v:
        offending = low
    elif high is not None and high > max_v:
        offending = high
    if offending is not None:
        raise ColumnRoleError(
            column,
            f"{what} must be within [{min_v:g}, {max_v:g}], but the metadata source "
            f"contains {_fmt_value(offending)}",
        )


def _validate_geographic_values(roles: ColumnRoles, pair_extent: _PairExtent) -> None:
    """Fail-fast (D-11) on the D-35 Seam G2 geographic VALUE preconditions, PER ENTRY — the
    data-dependent counterpart to ``validate_geographic_config``, mirroring
    ``_validate_scatter_values``. The extent is measured over the rows carrying BOTH
    coordinates (the placement predicate — see ``_PairExtent``); a row missing lon or lat is
    unplaced (the strip) and exempt. Every message names the column + the exact value:

      * longitude within [-180, 180], latitude within [-90, 90] (a real coordinate);
      * under projection ``"mercator"``, additionally ``|latitude| <= 85.051129`` — the
        Web-Mercator clip latitude, beyond which the northing diverges (NO silent clamp,
        §6.2 as proposed): the message points at ``equirectangular`` for polar data
        (equirectangular is valid to the poles).
    """
    for entry in roles.geographic:
        lon_lo, lon_hi = pair_extent(entry.lon_column, entry.lat_column, entry.lon_column)
        _guard_coord_range(entry.lon_column, "longitude", lon_lo, lon_hi, _GEO_LON_MIN, _GEO_LON_MAX)
        lat_lo, lat_hi = pair_extent(entry.lon_column, entry.lat_column, entry.lat_column)
        _guard_coord_range(entry.lat_column, "latitude", lat_lo, lat_hi, _GEO_LAT_MIN, _GEO_LAT_MAX)
        if entry.projection == "mercator":
            offending: float | None = None
            if lat_lo is not None and lat_lo < -_MERCATOR_MAX_LAT:
                offending = lat_lo
            elif lat_hi is not None and lat_hi > _MERCATOR_MAX_LAT:
                offending = lat_hi
            if offending is not None:
                raise ColumnRoleError(
                    entry.lat_column,
                    f"projection 'mercator' requires |latitude| <= {_MERCATOR_MAX_LAT} "
                    f"(the Web-Mercator limit), but the metadata source contains "
                    f"{_fmt_value(offending)}; use projection 'equirectangular' for polar "
                    f"data or filter the out-of-range rows",
                )


def _validate_geographic_options(
    con: duckdb.DuckDBPyConnection, source: str, roles: ColumnRoles
) -> None:
    """CSV-ingest adapter for the geographic VALUE checks (``validate_geographic_config``
    already ran in the hoisted early gate). The pair predicate mirrors placement — only rows
    with BOTH coordinates non-empty are measured (``_validate_scatter`` guaranteed non-empty
    ≡ finite, so non-empty ≡ placeable here). Same DuckDB extent SQL as the scatter twin."""

    def pair_extent(
        lon_column: str, lat_column: str, column: str
    ) -> tuple[float | None, float | None]:
        clon, clat, col = _sql_ident(lon_column), _sql_ident(lat_column), _sql_ident(column)
        row = con.execute(
            f"SELECT min(v), max(v) FROM "
            f"(SELECT TRY_CAST(NULLIF({col}, '') AS DOUBLE) AS v FROM {source} "
            f"WHERE NULLIF({clon}, '') IS NOT NULL AND NULLIF({clat}, '') IS NOT NULL)"
        ).fetchone()
        assert row is not None  # aggregate query always returns one row
        return row[0], row[1]

    _validate_geographic_values(roles, pair_extent)


def validate_geographic_options_parquet(roles: ColumnRoles, metadata_path: Path) -> None:
    """add-layouts twin of the ingest-time geographic VALUE checks (D-35 Seam G2): validate
    lon/lat range (+ mercator |lat|) against the READ-ONLY committed ``metadata.parquet``.
    Called from ``worker._validate_roles_against_parquet`` AFTER its presence/type checks.
    The pair predicate uses ``is_finite`` — exactly ``_placement.as_finite``'s placement rule
    — so a hand-seeded NaN counts as unplaced here just as at layout time. Mirrors
    ``validate_scatter_options_parquet``."""
    needed = sorted({c for e in roles.geographic for c in (e.lon_column, e.lat_column)})
    if not needed:
        return
    table = pq.read_table(metadata_path, columns=needed)

    def pair_extent(
        lon_column: str, lat_column: str, column: str
    ) -> tuple[float | None, float | None]:
        both = pc.and_(  # type: ignore[attr-defined]
            pc.is_finite(table.column(lon_column)),  # type: ignore[attr-defined]
            pc.is_finite(table.column(lat_column)),  # type: ignore[attr-defined]
        )
        values = table.column(column).filter(pc.fill_null(both, False))
        if len(values) == 0:
            return None, None
        extremes = pc.min_max(values)  # type: ignore[attr-defined]
        return extremes["min"].as_py(), extremes["max"].as_py()

    _validate_geographic_values(roles, pair_extent)


def _enrichment_select(roles: ColumnRoles) -> str:
    """SELECT list projecting the join key (as `_join_key`) plus the enrichment
    columns: datetime -> parsed, tags -> list<string>, scatter -> nullable
    float64 (D-26), categorical/freeform -> string. The filename role is the
    join key only; the canonical `filename` column (the image basename) is
    supplied by the base table."""
    parts: list[str] = [f"{_sql_ident(roles.filename.column)} AS _join_key"]

    if roles.datetime is not None:
        col = _sql_ident(roles.datetime.column)
        cast_type = "TIMESTAMP" if roles.datetime.format == "iso8601" else "BIGINT"
        parts.append(f"CAST({col} AS {cast_type}) AS {col}")

    for entry in roles.categorical:
        col = _sql_ident(entry.column)
        parts.append(f"{col} AS {col}")

    for name in _coordinate_columns(roles):
        # Nullable float64 (decision D-26; D-35 Seam G2 geographic lon/lat share this
        # projection): empty -> null (an unplaced cell); _validate_scatter already
        # guaranteed every non-empty value parses as a finite float, so the TRY_CAST is
        # exact here. Projected once even if a column is both a scatter axis and a
        # geographic axis (scatter-only datasets get the identical old projection set).
        col = _sql_ident(name)
        parts.append(f"TRY_CAST(NULLIF({col}, '') AS DOUBLE) AS {col}")

    for entry in roles.tag:
        col = _sql_ident(entry.column)
        if entry.delimiter:
            parts.append(f"string_split({col}, {_sql_str(entry.delimiter)}) AS {col}")
        else:
            # Single-value tag column: wrap the whole value as a one-element
            # list<string> (empty list for null/empty), never split on '' chars.
            parts.append(
                f"CASE WHEN {col} IS NULL OR {col} = '' "
                f"THEN CAST([] AS VARCHAR[]) ELSE [{col}] END AS {col}"
            )

    for entry in roles.freeform:
        col = _sql_ident(entry.column)
        parts.append(f"{col} AS {col}")

    return ", ".join(parts)


def _read_source(csv_path: Path) -> str:
    """A DuckDB table expression reading the CSV as all-VARCHAR (so this module
    owns every cast/validation explicitly rather than inheriting auto-inference)."""
    return f"read_csv_auto({_sql_str(str(csv_path))}, all_varchar=true)"


def _sql_str(value: str) -> str:
    """Quote a value as a DuckDB string literal."""
    return "'" + value.replace("'", "''") + "'"


def _sql_ident(name: str) -> str:
    """Quote an identifier (column name) for DuckDB, doubling any embedded double-quote
    so a crafted name cannot terminate the quotes and inject SQL.

    Security-load-bearing and duplicated by design: the API package has a
    behaviour-identical twin, ``api/routers/metadata.py`` ``_sql_ident`` (the
    cross-package rule forbids importing across packages). Keep the two in sync — if
    either quoter changes, change the other identically (T2-115, the second-order SQLi
    hotfix)."""
    return '"' + name.replace('"', '""') + '"'


def write_tags_sidecar(
    metadata_path: Path,        # the metadata.parquet just written
    roles: "ColumnRoles",
    output_path: Path,          # tags/tags_v{dataset_version}.arrow
) -> Path | None:
    """
    Project the per-dataset tag sidecar (decision D-14): select `id` plus the
    tag-role columns (already split into Arrow list<string> at ingest) from
    metadata.parquet and write them as a single UNCOMPRESSED Arrow IPC file
    (decision D-29 — apache-arrow JS cannot decode compressed record batches).
    Returns the written path, or None if the dataset has no tag-role columns.

    Layout-independent by construction — written once per dataset version, not
    per layout. The filename embeds the dataset version so the asset is safe to
    serve immutable. Staged with the rest of the output and committed by the
    atomic rename in worker.run_ingest (gap analysis #5).
    """
    if not roles.tag:
        return None

    columns = ["id"] + [entry.column for entry in roles.tag]
    table = pq.read_table(metadata_path, columns=columns)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # D-29: browser-read Arrow MUST be uncompressed — apache-arrow JS cannot
    # decode compressed record batches, and write_feather defaults to lz4.
    feather.write_feather(table, str(output_path), compression="uncompressed")
    return output_path


def write_positions_table(
    cells: "pa.Table",         # the layout's LayoutResult.cells (id + x,y,w,h + reserved)
    image_count: int,          # the dense id space [0, image_count)
    output_path: Path,         # positions/{layout_id}_v{dataset_version}.arrow
) -> Path:
    """
    Project ONE layout's POSITION TABLE (T2-66 / T2-48): the per-cell world rects
    (`x, y, w, h`, float32) that layout places each cell at, written as a single
    UNCOMPRESSED Arrow IPC file (decision D-29 — apache-arrow JS cannot decode
    compressed record batches). Written PER LAYOUT (each layout places the same cell
    at a different (x,y)); the filename embeds the dataset version so the asset is
    safe to serve immutable. Referenced by the layout's ``positions_ref`` manifest
    entry (v2.2 MINOR).

    The values are the SAME normalized [0,1]^2 rects the fine-tier cell records
    carry: they are TAKEN from ``cells`` (the layout result the bake already
    computed — the tiler reads the identical table), never re-derived. The renderer
    scans this table to hit-test a cell at ANY zoom, including the coarse/overview
    tier where the fine tier has no per-cell geometry to pick against.

    DENSE-BY-CONSTRUCTION, NO `id` COLUMN: the layout's ``cells.id`` is the
    contiguous-dense range [0, image_count) (the v2 cell_record contract the worker
    pins by densifying decode-failed gaps away before layouts compute). We reorder by
    ``id`` and write ONLY the four spatial columns, so the ROW INDEX is the cell id
    (row i == cell id i). Dropping the id column is cheaper on disk (four float32s =
    16 bytes/cell → ~16 MB/layout at 1M) and unambiguous — the consumer indexes the
    typed arrays directly by id. Requires the id set to be exactly [0, image_count)
    (asserted); a hole would misalign every row past it.
    """
    ids = [int(v) for v in cells.column("id").to_pylist()]
    if sorted(ids) != list(range(image_count)):
        # The v2 cell_record contract pins ids contiguous-dense [0, image_count); the
        # position table's row-index==id encoding depends on it. Surface a mismatch
        # loudly rather than write a silently-misaligned table.
        raise ValueError(
            f"position table for {output_path.name}: layout cell ids are not the dense "
            f"range [0,{image_count}) (got {len(ids)} ids, "
            f"min={min(ids) if ids else None}, max={max(ids) if ids else None}); "
            f"the row-index==id encoding requires a gap-free id space"
        )
    # Reorder rows so row i carries cell id i (the cells table is already id-ascending
    # in the common path, but sort defensively so the encoding never depends on the
    # layout's emission order).
    row_of_id = {cid: i for i, cid in enumerate(ids)}
    order = pa.array([row_of_id[i] for i in range(image_count)], pa.int64())
    ordered = cells.take(order)
    table = pa.table(
        {
            "x": ordered.column("x").cast(pa.float32()),
            "y": ordered.column("y").cast(pa.float32()),
            "w": ordered.column("w").cast(pa.float32()),
            "h": ordered.column("h").cast(pa.float32()),
        }
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # D-29: browser-read Arrow MUST be uncompressed.
    feather.write_feather(table, str(output_path), compression="uncompressed")
    return output_path
