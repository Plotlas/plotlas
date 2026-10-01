"""Tier-1 scatter tests (non-native): role parsing (v1.1, D-26), ingest-time
fail-fast on scatter values (D-11), placement/normalization, the unplaced strip,
and the worker's multi-entry naming for the scatter family.
"""
from __future__ import annotations

import csv
import json
import math
import random
import statistics
from pathlib import Path
from types import SimpleNamespace

import jsonschema
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import worker
from pipeline.ingest import ColumnRoleError, ingest_metadata
from pipeline.layout_plugins.base import (
    ColumnRoles,
    LayoutResult,
    ScatterRoleEntry,
    build_spatial_cells,
)
# The median-centred aspect fit + placed-box constants were EXTRACTED from scatter.py
# into the shared _placement module at D-35 Seam G2 (scatter + geographic reuse them);
# scatter.py's behaviour is byte-identical (these tests + the golden fixture prove it).
# The FIT path was untouched by the G1 hardening, so these are the same functions.
from pipeline.layout_plugins._placement import (
    PLACED_X_MAX as _PLACED_X_MAX,
    PLACED_Y_MAX as _PLACED_Y_MAX,
    aspect_fit as _aspect_fit,
)
from pipeline.layout_plugins.scatter import ScatterLayout
from pipeline.manifest import (
    MANIFEST_VERSION,
    _layout_entry,
    _scatter_entry_to_dict,
    _validate_manifest,
    append_manifest_layouts,
)


def _fake_atlas(n: int) -> SimpleNamespace:
    """A v2 ThumbnailCache stand-in: layouts read only ``.ids`` (dense [0, n))."""
    return SimpleNamespace(ids=list(range(n)), thumb_px=64, cache_dir=None, skipped=[])


def _roles(*pairs: tuple[str, str, str]) -> ColumnRoles:
    """A validated ColumnRoles with the given scatter (x, y, label) entries."""
    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "scatter": [
                {"x_column": x, "y_column": y, "label": label} for x, y, label in pairs
            ],
        }
    )


def _meta(xs: list[float | None], ys: list[float | None], x_col: str = "u", y_col: str = "v") -> pa.Table:
    n = len(xs)
    return pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            x_col: pa.array(xs, pa.float64()),
            y_col: pa.array(ys, pa.float64()),
        }
    )


# --- 1. from_config round-trip (v1.1 role map) -------------------------------


def test_from_config_parses_two_scatter_entries() -> None:
    roles = _roles(("umap_x", "umap_y", "UMAP"), ("tsne_x", "tsne_y", "t-SNE"))
    assert roles.scatter == [
        ScatterRoleEntry(x_column="umap_x", y_column="umap_y", label="UMAP"),
        ScatterRoleEntry(x_column="tsne_x", y_column="tsne_y", label="t-SNE"),
    ]


def test_from_config_defaults_scatter_to_empty() -> None:
    roles = ColumnRoles.from_config({"filename": {"column": "filename", "label": "F"}})
    assert roles.scatter == []


def test_scatter_entry_missing_y_column_fails_schema_validation() -> None:
    # The pair is atomic (D-26): an X without a Y is unrepresentable.
    with pytest.raises(jsonschema.ValidationError):
        ColumnRoles.from_config(
            {
                "filename": {"column": "filename", "label": "F"},
                "scatter": [{"x_column": "umap_x", "label": "UMAP"}],
            }
        )


# --- 2. placement ------------------------------------------------------------


def test_aspect_preserving_fit_keeps_data_ratio() -> None:
    # O2-C: ONE scale for both axes preserves the data's true 2-D aspect. A
    # 10-wide x 5-tall point set renders with extents in 2:1 ratio, centred in the
    # [0,1] x [0,0.95] box — NOT stretched per-axis to fill it.
    meta = _meta([0.0, 10.0, 0.0, 10.0], [0.0, 0.0, 5.0, 5.0])
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(4), {})

    assert result.layout_type == "scatter"
    assert result.edges is None
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    x_extent, y_extent = max(xs) - min(xs), max(ys) - min(ys)
    assert abs(x_extent / y_extent - 2.0) < 1e-6, "10:5 data aspect must be preserved 2:1"
    assert min(xs) >= -1e-6 and max(xs) <= 1.0 + 1e-6
    assert min(ys) >= -1e-6 and max(ys) <= 0.95 + 1e-6
    assert abs((min(ys) + max(ys)) / 2 - 0.475) < 1e-6, "centred vertically in [0,0.95]"
    # Uniform square cell size for all cells.
    ws = set(result.cells.column("w").to_pylist())
    hs = set(result.cells.column("h").to_pylist())
    assert len(ws) == 1 and ws == hs


def test_square_input_renders_square() -> None:
    # A square data extent stays square (equal rendered extents), centred — not
    # stretched to the box's 1 x 0.95 aspect.
    meta = _meta([0.0, 10.0, 0.0, 10.0], [0.0, 0.0, 10.0, 10.0])
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(4), {})
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    assert abs((max(xs) - min(xs)) - (max(ys) - min(ys))) < 1e-6, "square data stays square"
    assert max(ys) <= 0.95 + 1e-6


def test_degenerate_both_axes_collapse_to_centre() -> None:
    # Both axes degenerate -> the aspect-fit has no span to scale by, so cells
    # collapse to the placed-box centre (0.5, 0.475): never NaN, never outside the
    # box. Triggered by all placed points sharing one (x, y), or a single placed
    # cell (exercises scatter.py's `if not candidates` branch).
    for xs_in, ys_in, n in (
        ([3.0, 3.0, 3.0], [7.0, 7.0, 7.0], 3),  # many coincident points
        ([3.0], [7.0], 1),  # a single placed cell
    ):
        meta = _meta(xs_in, ys_in)
        result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(n), {})
        xs = result.cells.column("x").to_pylist()
        ys = result.cells.column("y").to_pylist()
        assert all(abs(x - 0.5) < 1e-6 for x in xs), f"x->centre for {xs_in}"
        assert all(abs(y - 0.475) < 1e-6 for y in ys), f"y->centre for {ys_in}"


def test_null_coordinates_land_in_strip_ordered_by_id() -> None:
    # ids 2 and 5 have a null axis -> unplaced strip y >= 0.96, ordered by id.
    meta = _meta(
        [0.0, 10.0, None, 0.0, 10.0, 4.0],
        [0.0, 0.0, 3.0, 10.0, 10.0, None],
    )
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(6), {})

    ids = result.cells.column("id").to_pylist()
    assert ids == [0, 1, 2, 3, 4, 5]  # every input id present, in id order
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    by_id = {cid: (x, y) for cid, x, y in zip(ids, xs, ys)}

    for placed_id in (0, 1, 3, 4):
        assert by_id[placed_id][1] <= 0.95 + 1e-6
    strip = [by_id[2], by_id[5]]
    for x, y in strip:
        assert y >= 0.96 - 1e-6, f"strip cell at y={y}"
    # Ordered by id within the strip: id 2 before id 5 (row-major, x ascending).
    assert strip[0][0] < strip[1][0]
    # v2.6 (T2-140 / D-36 seam U1): the strip has been here since D-26 and the manifest
    # described it NOWHERE — now the layout reports how many cells are in it, so a viewer
    # can explain the band instead of leaving the user to guess.
    assert result.missing_count == 2


def test_missing_count_is_zero_when_every_cell_places() -> None:
    # manifest.py WRITES this 0 rather than omitting the key: "counted, found none" has to
    # be sayable, or it is indistinguishable from a pre-2.6 producer that never counted.
    meta = _meta([0.0, 10.0, 4.0], [0.0, 10.0, 2.0])
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(3), {})
    assert result.missing_count == 0


def test_degenerate_axis_maps_to_midpoint() -> None:
    # All x equal -> x = 0.5 (midpoint of [0,1]); y still spreads to [0,0.95].
    meta = _meta([7.0, 7.0, 7.0], [0.0, 5.0, 10.0])
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(3), {})

    ids = result.cells.column("id").to_pylist()
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    by_id = {cid: (x, y) for cid, x, y in zip(ids, xs, ys)}
    assert all(abs(x - 0.5) < 1e-6 for x in xs)
    assert abs(min(ys) - 0.0) < 1e-6 and abs(max(ys) - 0.95) < 1e-6
    # DELIBERATELY FLIPPED for the north-up convention (T2-85): y_column increases
    # UPWARD, and screen-y grows downward (renderer/world.ts), so the LARGEST y_column
    # (id 2, value 10) gets the SMALLEST placed y (renders highest) and the smallest
    # y_column (id 0, value 0) the largest placed y. Pre-T2-85 this mapped directly
    # (id 0 -> 0.0, id 2 -> 0.95); the inversion swaps which input lands at which edge.
    assert abs(by_id[0][1] - 0.95) < 1e-6, "smallest y_column -> largest placed y (screen bottom)"
    assert abs(by_id[2][1] - 0.0) < 1e-6, "largest y_column -> smallest placed y (screen top / north-up)"
    assert by_id[0][1] > by_id[1][1] > by_id[2][1], "placed y decreases as y_column increases"


def test_higher_y_column_renders_higher_north_up() -> None:
    # T2-85: the explicit orientation invariant. Two points differing ONLY in
    # y_column (same x) — the LARGER y_column value must get the SMALLER placed y,
    # because y_column increases UPWARD and the world camera's screen-y grows
    # DOWNWARD (renderer/world.ts), so a smaller world y renders HIGHER on screen
    # (north-up for lat/lon). Both stay in the placed band [0, _PLACED_Y_MAX].
    meta = _meta([1.0, 1.0], [3.0, 8.0])  # id 1 has the larger y_column (north)
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(2), {})

    ids = result.cells.column("id").to_pylist()
    ys = result.cells.column("y").to_pylist()
    by_id = dict(zip(ids, ys))
    assert by_id[1] < by_id[0], (
        "the larger y_column must render higher (smaller placed y) — north-up (T2-85)"
    )
    assert all(0.0 - 1e-6 <= y <= _PLACED_Y_MAX + 1e-6 for y in ys), "both in the placed band"


def test_missing_metadata_row_is_unplaced_not_dropped() -> None:
    # A packed cell with no metadata row after the D-25 left join goes to the
    # strip — never dropped (D-10: identical id sets across layouts).
    meta = _meta([0.0, 10.0], [0.0, 10.0])  # ids 0..1 only; atlas has 0..2
    result = ScatterLayout().compute(meta, _roles(("u", "v", "UMAP")), _fake_atlas(3), {})

    ids = result.cells.column("id").to_pylist()
    assert ids == [0, 1, 2]
    assert result.cells.column("y").to_pylist()[2] >= 0.96 - 1e-6


def test_compute_is_deterministic() -> None:
    meta = _meta([0.0, 10.0, None, 4.0], [1.0, 0.0, 2.0, None])
    roles = _roles(("u", "v", "UMAP"))
    a = ScatterLayout().compute(meta, roles, _fake_atlas(4), {})
    b = ScatterLayout().compute(meta, roles, _fake_atlas(4), {})
    assert a.cells.equals(b.cells)
    assert a.bbox == b.bbox


def test_entry_index_selects_the_pair() -> None:
    meta = pa.table(
        {
            "id": pa.array([0, 1], pa.int64()),
            "ax": pa.array([0.0, 10.0], pa.float64()),
            "ay": pa.array([0.0, 10.0], pa.float64()),
            "bx": pa.array([10.0, 0.0], pa.float64()),
            "by": pa.array([0.0, 10.0], pa.float64()),
        }
    )
    roles = _roles(("ax", "ay", "A"), ("bx", "by", "B"))
    a = ScatterLayout().compute(meta, roles, _fake_atlas(2), {"entry_index": 0})
    b = ScatterLayout().compute(meta, roles, _fake_atlas(2), {"entry_index": 1})
    assert a.cells.column("x").to_pylist()[0] < a.cells.column("x").to_pylist()[1]
    assert b.cells.column("x").to_pylist()[0] > b.cells.column("x").to_pylist()[1]


# --- median-centred, unclipped aspect fit (Scatter Seam S1, T2-35) ------------


def test_aspect_fit_is_median_centred_and_unclipped_heavy_tail() -> None:
    # Scatter Seam S1 (T2-35): the fit centres on the data MEDIAN and clips NOTHING.
    # This mimics the iNat "California clipped left" case — a dense bulk plus a sparse far
    # tail so the per-axis MEDIAN sits far from the span midpoint (min+max)/2. Both
    # assertions FAIL against the old robust-span + edge-clip fit (which centred on the
    # span midpoint and pinned the tail onto a single margin value).
    rng = random.Random(7)
    n = 200
    xs: list[float] = []
    ys: list[float] = []
    for _ in range(n - 4):  # 196-cell dense bulk near the origin
        xs.append(rng.uniform(0.0, 10.0))
        ys.append(rng.uniform(0.0, 10.0))
    for k in range(4):  # 4 far outliers at DISTINCT coords -> a heavy up-right tail
        xs.append(900.0 + 30.0 * k)  # 900, 930, 960, 990
        ys.append(900.0 + 30.0 * k)
    # The median stays in the bulk (~5); the span midpoint is dragged out to ~(495, 495).

    px, py = _aspect_fit(xs, ys, _PLACED_X_MAX, _PLACED_Y_MAX)

    # (a) NOTHING is clipped: every point — tail included — lands inside the box…
    assert all(-1e-9 <= x <= _PLACED_X_MAX + 1e-9 for x in px)
    assert all(-1e-9 <= y <= _PLACED_Y_MAX + 1e-9 for y in py)
    # …and the 4 far outliers keep DISTINCT, true relative positions (strictly increasing),
    # NOT crushed onto one margin value the way the old percentile clip did (all -> 1.0).
    tail_px = px[-4:]
    assert tail_px == sorted(tail_px) and len(set(tail_px)) == 4, (
        f"tail crushed or reordered — a clip is still cropping outliers: {tail_px}"
    )

    # (b) The fit is centred on the DATA MEDIAN, not the span midpoint: because the map is
    # a monotone affine transform, median(output) == the box centre EXACTLY on both axes.
    # Under the old (min+max)/2 centring the right-skew pulled this far below centre (~0.18),
    # so this pins the S1 re-centre.
    assert abs(statistics.median(px) - _PLACED_X_MAX / 2.0) < 1e-9
    assert abs(statistics.median(py) - _PLACED_Y_MAX / 2.0) < 1e-9


def test_symmetric_cloud_matches_plain_midpoint_fit_exactly() -> None:
    # PARITY: when the data is symmetric (median == span midpoint) median-centring reduces
    # EXACTLY to the plain full-extent aspect fit — S1's re-centre only moves skewed data.
    # Build a point set symmetric about (0, 0) so median == midpoint on both axes, then
    # compare to an inline plain (span-midpoint, full-extent, no-clip) fit bit-for-bit.
    rng = random.Random(3)
    half = [0.2 + 0.6 * rng.random() for _ in range(300)]
    xs = [+v for v in half] + [-v for v in half]  # symmetric about 0 -> median 0 == midpoint
    ys = [-v for v in half] + [+v for v in half]

    px, py = _aspect_fit(xs, ys, _PLACED_X_MAX, _PLACED_Y_MAX)

    xlo, xhi, ylo, yhi = min(xs), max(xs), min(ys), max(ys)
    xspan, yspan = xhi - xlo, yhi - ylo
    scale = min(_PLACED_X_MAX / xspan, _PLACED_Y_MAX / yspan)
    ox = (_PLACED_X_MAX - xspan * scale) / 2.0
    oy = (_PLACED_Y_MAX - yspan * scale) / 2.0
    exp_px = [ox + (x - xlo) * scale for x in xs]
    exp_py = [oy + (y - ylo) * scale for y in ys]
    assert max(abs(a - b) for a, b in zip(px, exp_px)) < 1e-9, "symmetric fit diverged from plain fit"
    assert max(abs(a - b) for a, b in zip(py, exp_py)) < 1e-9, "symmetric fit diverged from plain fit"
    # Nothing clips, everything in-box, and a square symmetric cloud stays square.
    assert all(0.0 <= x <= _PLACED_X_MAX for x in px)
    assert all(0.0 <= y <= _PLACED_Y_MAX for y in py)
    assert abs((max(px) - min(px)) - (max(py) - min(py))) < 1e-6, "square cloud must stay square"


# --- ingest-time value handling (D-11 fail-fast) ------------------------------


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return path


def _scatter_roles_config() -> dict:
    return {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [{"x_column": "x", "y_column": "y", "label": "UMAP"}],
    }


def test_non_numeric_scatter_value_raises_at_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "1.0", "2.0"] for name in sorted(names)]
    rows[3][1] = "not-a-number"  # non-empty, unparseable -> fail fast (D-11)
    csv_path = _write_csv(tmp_path / "bad.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError):
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config())


def test_non_finite_scatter_value_raises_at_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "1.0", "2.0"] for name in sorted(names)]
    rows[0][2] = "inf"  # parses as a float but is not finite
    csv_path = _write_csv(tmp_path / "inf.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError):
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config())


def test_scatter_column_missing_from_header_raises(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "1.0"] for name in sorted(names)]  # no "y" column
    csv_path = _write_csv(tmp_path / "noy.csv", ["filename", "x"], rows)
    with pytest.raises(ColumnRoleError):
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config())


def test_scatter_columns_stored_as_nullable_float64(
    tmp_path: Path, images_dir: Path, metadata_csv: Path, column_roles: dict
) -> None:
    result = ingest_metadata(images_dir, "ds", tmp_path / "out", metadata_csv, column_roles)

    table = pq.read_table(result.metadata_path)
    assert table.schema.field("x").type.equals(pa.float64())
    assert table.schema.field("y").type.equals(pa.float64())
    # Empty values became nulls (rows 3 and 7 in the conftest fixture)…
    xs = table.column("x").to_pylist()
    ys = table.column("y").to_pylist()
    assert xs[3] is None and xs[7] is None
    assert ys[3] is None and ys[7] is None
    # …and the rest are the parsed floats.
    assert xs[0] == -2.0 and ys[0] == 10.0
    assert result.column_roles is not None
    assert result.column_roles.scatter == [
        ScatterRoleEntry(x_column="x", y_column="y", label="UMAP")
    ]


def test_reserved_name_collision_repoints_scatter_columns(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # A scatter column literally named "id" shadows the reserved pipeline column:
    # it is stored as meta_id and the role entry is repointed (PR #12 rules).
    rows = [[name, str(float(i)), str(float(i * 2))] for i, name in enumerate(sorted(names))]
    csv_path = _write_csv(tmp_path / "shadow.csv", ["filename", "id", "y"], rows)
    roles_config = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [{"x_column": "id", "y_column": "y", "label": "UMAP"}],
    }
    result = ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, roles_config)

    table = pq.read_table(result.metadata_path)
    assert table.schema.field("id").type.equals(pa.int64())        # canonical key intact
    assert table.schema.field("meta_id").type.equals(pa.float64())  # repointed storage
    assert result.column_roles is not None
    assert result.column_roles.scatter == [
        ScatterRoleEntry(x_column="meta_id", y_column="y", label="UMAP")
    ]


# --- 3. multi-entry naming for the scatter family -----------------------------


def test_two_scatter_entries_expand_to_slugged_layouts() -> None:
    meta = pa.table(
        {
            "id": pa.array([0, 1], pa.int64()),
            "umap_x": pa.array([0.0, 1.0], pa.float64()),
            "umap_y": pa.array([0.0, 1.0], pa.float64()),
            "tsne X": pa.array([0.0, 1.0], pa.float64()),
            "tsne_y": pa.array([0.0, 1.0], pa.float64()),
        }
    )
    roles = _roles(("umap_x", "umap_y", "UMAP"), ("tsne X", "tsne_y", "t-SNE"))
    results = worker._expand_layouts(ScatterLayout(), meta, roles, _fake_atlas(2))

    assert [r.layout_id for r in results] == ["scatter_umap_x", "scatter_tsne-x"]
    assert [r.label for r in results] == ["UMAP", "t-SNE"]
    assert all(r.layout_type == "scatter" for r in results)


def test_single_scatter_entry_keeps_bare_layout_id() -> None:
    meta = _meta([0.0, 1.0], [0.0, 1.0])
    results = worker._expand_layouts(
        ScatterLayout(), meta, _roles(("u", "v", "UMAP")), _fake_atlas(2)
    )
    assert [r.layout_id for r in results] == ["scatter"]
    assert results[0].label == "UMAP"


def test_slug_collision_appends_entry_index() -> None:
    # Both entries share the same distinguishing x_column -> identical slugs ->
    # the second layout_id gets the "-{i}" suffix.
    meta = pa.table(
        {
            "id": pa.array([0, 1], pa.int64()),
            "u.x": pa.array([0.0, 1.0], pa.float64()),
            "u_x": pa.array([0.0, 1.0], pa.float64()),
            "v": pa.array([0.0, 1.0], pa.float64()),
        }
    )
    roles = _roles(("u.x", "v", "First"), ("u.x", "u_x", "Second"))
    results = worker._expand_layouts(ScatterLayout(), meta, roles, _fake_atlas(2))
    assert [r.layout_id for r in results] == ["scatter_u.x", "scatter_u.x-1"]


# --- D-35 Seam G1: declared knobs (x_scale/y_scale/normalize/overlap) ----------
# All DECLARED, never sniffed; defaults reproduce today's behavior byte-for-byte.


def _roles_with(**knobs: str) -> ColumnRoles:
    """A one-entry scatter ColumnRoles over columns u/v with the given G1 knobs."""
    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "scatter": [{"x_column": "u", "y_column": "v", "label": "S", **knobs}],
        }
    )


def test_from_config_parses_scatter_knobs() -> None:
    e = _roles_with(x_scale="log", y_scale="linear", normalize="none", overlap="overdraw").scatter[0]
    assert (e.x_scale, e.y_scale, e.normalize, e.overlap) == ("log", "linear", "none", "overdraw")


def test_from_config_scatter_knobs_default_to_todays_behavior() -> None:
    # Absent knobs => the exact pre-G1 defaults (so an old role map is unchanged and a
    # no-knob entry serializes back to just {x_column, y_column, label}).
    e = _roles(("u", "v", "S")).scatter[0]
    assert (e.x_scale, e.y_scale, e.normalize, e.overlap) == ("linear", "linear", "fit", "overdraw")


def test_from_config_rejects_unknown_scale_enum() -> None:
    # The schema constrains the enum; a bogus value fails SHAPE validation (before any
    # ingest value-check), so a typo never silently becomes 'linear'.
    with pytest.raises(jsonschema.ValidationError):
        _roles_with(x_scale="sqrt")


def test_declared_log_scale_evenly_spaces_decades_and_keeps_north_up() -> None:
    # x = 1,10,100 is multiplicative: on a LINEAR axis 1 and 10 nearly coincide; a
    # declared 'log' makes the three decades EVENLY spaced (equal ln gaps). Both axes
    # log — the only production-reachable log config (mixed log/linear is rejected at
    # the entry points, T2-128); the ascending y axis re-asserts north-up survives
    # the log (log is monotone).
    meta = _meta([1.0, 10.0, 100.0], [1.0, 10.0, 100.0])
    result = ScatterLayout().compute(
        meta, _roles_with(x_scale="log", y_scale="log"), _fake_atlas(3), {}
    )

    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    # Decades evenly spaced after log+fit (the affine fit preserves equal ln gaps).
    assert abs((xs[1] - xs[0]) - (xs[2] - xs[1])) < 1e-6, "log did not evenly space the decades"
    # A LINEAR x would jam 1 and 10 together — prove the log actually changed the spacing.
    assert (xs[1] - xs[0]) > 0.2, "middle decade sits far from the left (not the linear jam)"
    # north-up preserved (T2-85): the LARGER y_column renders HIGHER (smaller placed y).
    assert ys[0] > ys[1] > ys[2], "north-up broken under a declared log"
    # The applied knobs are echoed (non-default).
    assert result.options == {
        "x_scale": "log", "y_scale": "log", "normalize": "fit", "overlap": "overdraw",
    }


def test_normalize_none_preserves_geometry_up_to_one_uniform_scale() -> None:
    # Pass-through (T2-34): the author's [0,1]^2 coords are preserved EXACTLY up to ONE
    # uniform x0.95 scale on both axes (mapping the user square into the placed band so
    # the unplaced strip sits outside user space — operator direction 2026-07-20). No
    # aspect fit, no per-axis warp, and NO north-up inversion (the author owns
    # orientation); relative geometry is bit-for-bit the input's.
    meta = _meta([0.1, 0.9, 0.5], [0.2, 0.8, 0.6])
    result = ScatterLayout().compute(meta, _roles_with(normalize="none"), _fake_atlas(3), {})

    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    assert xs == pytest.approx([v * 0.95 for v in [0.1, 0.9, 0.5]], abs=1e-6)
    # Uniform scale, NOT inverted: y keeps the given orientation (a 'fit' bake would
    # reflect these) and BOTH axes share the exact same factor (aspect preserved).
    assert ys == pytest.approx([v * 0.95 for v in [0.2, 0.8, 0.6]], abs=1e-6)
    assert result.options == {
        "x_scale": "linear", "y_scale": "linear", "normalize": "none", "overlap": "overdraw",
    }


def test_normalize_none_keeps_unplaced_strip_for_missing_values() -> None:
    # Pass-through still routes null-coordinate cells to the strip (never dropped).
    # A SINGLE placed point (degenerate extent -> count-only side 0.9) means the
    # round-2 adjacent block cannot fit below the data, so the fallback places the
    # strip in the absolute bottom band — the pre-G1 formula.
    meta = _meta([0.1, None, 0.5], [0.2, 0.8, None])
    result = ScatterLayout().compute(meta, _roles_with(normalize="none"), _fake_atlas(3), {})
    ys = result.cells.column("y").to_pylist()
    assert ys[0] == pytest.approx(0.2 * 0.95, abs=1e-6)   # placed: uniform x0.95 scale
    assert ys[1] >= 0.96 - 1e-6 and ys[2] >= 0.96 - 1e-6  # ids 1,2 -> the strip


def test_normalize_none_placed_cells_never_coincide_with_strip_cells() -> None:
    # The 2026-07-20 strip-separation guarantee, exercised on the FALLBACK path
    # (large-span data -> the adjacent block cannot fit below -> absolute band): a
    # placed cell at the user-space TOP (y = 1.0) lands at 0.95 — strictly below the
    # band [0.96, 1.0] — so a real datapoint can never render at the same coordinate
    # as a "no data" strip cell (no conditional rule, no rejection).
    meta = _meta([0.2, 0.8, None], [1.0, 0.5, None])
    result = ScatterLayout().compute(meta, _roles_with(normalize="none"), _fake_atlas(3), {})
    ys = result.cells.column("y").to_pylist()
    assert ys[0] == pytest.approx(0.95, abs=1e-6)  # user-space top -> band edge (float32 storage)
    assert max(ys[0], ys[1]) < 0.96 - 1e-6         # every placed centre below the strip
    assert ys[2] >= 0.96 - 1e-6                    # the unplaced cell is IN the strip


def test_normalize_none_strip_is_adjacent_block_and_bbox_stays_tight() -> None:
    # Round-2 review finding #1 (the framing cliff): the absolute bottom band sits
    # unreachable-far from a sub-region pass-through placement — ONE cell without
    # coordinates blew the bbox to ~48x the data on this shape, so fit-view rendered
    # the dataset as a pixel-scale smudge. The strip is now a near-square block one
    # gutter BELOW the occupied extent: adjacent (discoverable at the data's own
    # zoom), side-sized (no hairline — finding #3), and the bbox stays tight.
    n = 100  # 10x10 grid inside [0.5, 0.51]^2 — a realistic author-normalized region
    xs: list[float | None] = [0.5 + 0.01 * (i % 10) / 9 for i in range(n)]
    ys_in: list[float | None] = [0.5 + 0.01 * (i // 10) / 9 for i in range(n)]
    xs.append(None)
    ys_in.append(None)
    result = ScatterLayout().compute(
        _meta(xs, ys_in), _roles_with(normalize="none"), _fake_atlas(n + 1), {}
    )

    gx = result.cells.column("x").to_pylist()
    gy = result.cells.column("y").to_pylist()
    side = result.cells.column("w").to_pylist()[0]
    data_top = max(gy[:n])

    # The strip cell sits one gutter below the data block, at the data's left edge —
    # NOT in the absolute band at y >= 0.96.
    assert gy[n] == pytest.approx(data_top + 1.5 * side, abs=1e-5)
    assert gy[n] < 0.6, "strip cell must be adjacent to the data, not in the far band"
    assert gx[n] == pytest.approx(min(gx[:n]) + 0.5 * side, abs=1e-5)
    # Separation still holds: the strip centre clears every placed centre by > side.
    assert gy[n] - data_top > side - 1e-9

    # THE REGRESSION PIN: the bbox stays data-sized (the cliff made it ~0.49 wide).
    x0, y0, x1, y1 = result.bbox
    assert (x1 - x0) < 0.02 and (y1 - y0) < 0.02, f"bbox blew up: {result.bbox}"


def test_normalize_none_strip_block_falls_back_to_band_when_it_cannot_fit() -> None:
    # Full-span pass-through data: side is large (extent ~= canvas), the block cannot
    # fit below y=1 — and the absolute band IS adjacent for canvas-spanning data, so
    # the fallback is the correct rendering (the band formula, unchanged).
    meta = _meta([0.0, 1.0, 0.5, None], [0.0, 1.0, 0.5, None])
    result = ScatterLayout().compute(meta, _roles_with(normalize="none"), _fake_atlas(4), {})
    ys = result.cells.column("y").to_pylist()
    assert ys[3] >= 0.96 - 1e-6  # the unplaced cell is in the reserved band


def test_normalize_none_cell_size_derives_from_occupied_extent() -> None:
    # Extent-derived sizing (2026-07-20 review): a sub-region pass-through placement
    # gets cells scaled by its occupied RAW span — count-only sizing (calibrated for a
    # full-canvas spread) would dwarf the region and collapse the tiler's cell-size
    # z-ceiling (measured ~97% fine-tier subsampling on a regional-geo bake).
    meta = _meta([0.50, 0.51], [0.70, 0.705])
    result = ScatterLayout().compute(meta, _roles_with(normalize="none"), _fake_atlas(2), {})
    count_side = 0.9 / 2          # _FILL / ceil(sqrt(2 placed))
    span = 0.01                   # max raw span (x: 0.51 - 0.50)
    ws = result.cells.column("w").to_pylist()
    assert ws[0] == pytest.approx(count_side * span, rel=1e-6)
    # Degenerate all-coincident placement keeps the count-only fallback (never size 0).
    lone = ScatterLayout().compute(
        _meta([0.4, 0.4], [0.6, 0.6]), _roles_with(normalize="none"), _fake_atlas(2), {}
    )
    assert lone.cells.column("w").to_pylist()[0] == pytest.approx(count_side, rel=1e-6)


def test_absent_knobs_match_aspect_fit_then_invert_and_echo_nothing() -> None:
    # BYTE-STABILITY: with no knobs the placement is EXACTLY the pre-G1 algorithm
    # (_aspect_fit -> north-up invert) and NO options object is echoed — so a default
    # bake's manifest + column_roles are byte-for-byte their pre-2.3 form.
    xs_in, ys_in = [0.0, 10.0, 3.0, 7.0], [1.0, 0.0, 5.0, 2.0]
    result = ScatterLayout().compute(_meta(xs_in, ys_in), _roles(("u", "v", "S")), _fake_atlas(4), {})

    assert result.options is None, "default knobs must echo NO options (manifest omits it)"
    px, py = _aspect_fit(xs_in, ys_in, _PLACED_X_MAX, _PLACED_Y_MAX)
    py = [_PLACED_Y_MAX - y for y in py]  # the pre-G1 north-up reflection
    assert result.cells.column("x").to_pylist() == pytest.approx(px, abs=1e-6)
    assert result.cells.column("y").to_pylist() == pytest.approx(py, abs=1e-6)


@pytest.mark.parametrize(
    "knobs, expected",
    [
        ({}, None),  # no knobs
        # EXPLICIT defaults still echo nothing (byte-stability: writing linear/fit/overdraw
        # must not start emitting an options object).
        ({"x_scale": "linear", "y_scale": "linear", "normalize": "fit", "overlap": "overdraw"}, None),
        ({"x_scale": "log", "y_scale": "log"}, {"x_scale": "log", "y_scale": "log", "normalize": "fit", "overlap": "overdraw"}),
        ({"normalize": "none"}, {"x_scale": "linear", "y_scale": "linear", "normalize": "none", "overlap": "overdraw"}),
    ],
)
def test_options_echo_present_iff_a_knob_is_non_default(knobs: dict, expected: dict | None) -> None:
    # In-range positive coords so both 'none' and 'log' are valid at the plugin
    # (ingest, which enforces the value preconditions, is not run in this unit).
    meta = _meta([0.1, 0.9], [0.2, 0.8])
    result = ScatterLayout().compute(meta, _roles_with(**knobs), _fake_atlas(2), {})
    assert result.options == expected


# --- D-35 Seam G1: ingest-time fail-fast on the knob value preconditions (D-11) ----


def _scatter_roles_config_with(**knobs: str) -> dict:
    return {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [{"x_column": "x", "y_column": "y", "label": "UMAP", **knobs}],
    }


def test_log_scale_on_nonpositive_value_raises_naming_column_and_value(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "1.0", "2.0"] for name in sorted(names)]
    rows[4][1] = "0.0"  # a zero on the x axis (col index 1) — log is undefined -> fail fast
    csv_path = _write_csv(tmp_path / "logx.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(
            images_dir, "ds", tmp_path / "out", csv_path,
            _scatter_roles_config_with(x_scale="log", y_scale="log"),
        )
    msg = str(exc.value)
    # "contains 0.0" pins the OFFENDING VALUE itself (repr-exact) — a bare "0" would
    # also match the guard's own "(<= 0)" template text and prove nothing.
    assert "x:" in msg and "x_scale" in msg and "log" in msg and "contains 0.0" in msg, msg


def test_log_scale_on_nonpositive_y_value_raises_naming_the_y_column(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # The y-axis mirror of the guard (previously only x was exercised): the error
    # names the Y column and axis, with the exact offending value.
    rows = [[name, "1.0", "2.0"] for name in sorted(names)]
    rows[3][2] = "-3.5"  # a negative on the y axis (col index 2)
    csv_path = _write_csv(tmp_path / "logy.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(
            images_dir, "ds", tmp_path / "out", csv_path,
            _scatter_roles_config_with(x_scale="log", y_scale="log"),
        )
    msg = str(exc.value)
    assert "y:" in msg and "y_scale" in msg and "contains -3.5" in msg, msg


def test_log_scale_exempts_rows_that_cannot_place(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # The pair predicate (2026-07-20 review): a row missing EITHER coordinate is
    # unplaced (bottom strip) and never logged, so a non-positive value on such a row
    # must NOT reject the ingest — validation mirrors placement exactly.
    rows = [[name, "1.0", "2.0"] for name in sorted(names)]
    rows[2][1] = "-5.0"  # x = -5 ...
    rows[2][2] = ""      # ... but y is empty -> the row is unplaced -> exempt
    csv_path = _write_csv(tmp_path / "logexempt.csv", ["filename", "x", "y"], rows)
    result = ingest_metadata(
        images_dir, "ds", tmp_path / "out", csv_path,
        _scatter_roles_config_with(x_scale="log", y_scale="log"),
    )
    assert result.column_roles is not None  # ingest passed


def test_mixed_log_linear_scales_are_rejected(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # T2-128 (2026-07-20 review): the shared-scale aspect fit assumes commensurable
    # axes; a lone log axis is measured in ln-units against a raw-unit axis and is
    # crushed ~144x (measured), collapsing the fine tier. Reject BOTH orientations,
    # naming the entry, before any image probing or CSV reads (pure config check).
    rows = [[name, "1.0", "2.0"] for name in sorted(names)]
    csv_path = _write_csv(tmp_path / "mixed.csv", ["filename", "x", "y"], rows)
    for knobs in ({"x_scale": "log"}, {"y_scale": "log"}):
        with pytest.raises(ColumnRoleError) as exc:
            ingest_metadata(
                images_dir, "ds", tmp_path / "out", csv_path,
                _scatter_roles_config_with(**knobs),
            )
        msg = str(exc.value)
        assert "not supported" in msg and "T2-128" in msg and "UMAP" in msg, msg


def test_normalize_none_out_of_range_raises_naming_column_and_value(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "0.5", "0.5"] for name in sorted(names)]
    rows[2][1] = "1.5"  # x = 1.5 (col index 1) is outside [0,1] for a pass-through placement
    csv_path = _write_csv(tmp_path / "noner.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config_with(normalize="none"))
    msg = str(exc.value)
    assert "x:" in msg and "none" in msg and "1.5" in msg, msg


def test_normalize_none_negative_value_raises_on_the_y_column(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # The NEGATIVE bound + the Y column (previously only x > 1 was exercised).
    rows = [[name, "0.5", "0.5"] for name in sorted(names)]
    rows[1][2] = "-0.25"  # y (col index 2) below 0
    csv_path = _write_csv(tmp_path / "noneneg.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config_with(normalize="none"))
    msg = str(exc.value)
    assert "y:" in msg and "contains -0.25" in msg, msg


def test_normalize_none_exact_boundaries_pass_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # 0.0 and 1.0 are IN range ([0,1] is closed) — the boundary must not reject.
    rows = [[name, "0.5", "0.5"] for name in sorted(names)]
    rows[0][1], rows[0][2] = "0.0", "1.0"
    rows[1][1], rows[1][2] = "1.0", "0.0"
    csv_path = _write_csv(tmp_path / "nonebound.csv", ["filename", "x", "y"], rows)
    result = ingest_metadata(
        images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config_with(normalize="none")
    )
    assert result.column_roles is not None
    assert result.column_roles.scatter[0].normalize == "none"


def test_second_entry_knobs_are_validated_too(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # Multi-entry roles: entry 0 is knob-free, entry 1 declares an unimplemented
    # overlap — the per-entry loop must reach and reject entry 1.
    rows = [[name, "0.5", "0.5"] for name in sorted(names)]
    csv_path = _write_csv(tmp_path / "multi.csv", ["filename", "x", "y"], rows)
    config = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "x", "y_column": "y", "label": "Plain"},
            {"x_column": "y", "y_column": "x", "label": "Flipped", "overlap": "aggregate"},
        ],
    }
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, config)
    msg = str(exc.value)
    assert "aggregate" in msg and "Flipped" in msg and "not implemented yet" in msg, msg


@pytest.mark.parametrize("overlap", ["jitter", "aggregate"])
def test_unimplemented_overlap_raises_at_ingest(
    tmp_path: Path, images_dir: Path, names: list[str], overlap: str
) -> None:
    rows = [[name, "0.5", "0.5"] for name in sorted(names)]
    csv_path = _write_csv(tmp_path / f"ov_{overlap}.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config_with(overlap=overlap))
    msg = str(exc.value)
    assert overlap in msg and "not implemented yet" in msg and "D-35 G4" in msg, msg


def test_normalize_none_with_log_scale_is_rejected_not_silently_dropped(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # A contradictory config: pass-through preserves the author's normalized values,
    # but a log would push a [0,1] value out of range. Reject (naming the axis) rather
    # than silently dropping the declared log — the operator's "never silent"
    # principle. Both axes log so the MIXED-scale guard (its own test above) does not
    # fire first — this exercises the none+log contradiction specifically.
    rows = [[name, "0.5", "0.5"] for name in sorted(names)]
    csv_path = _write_csv(tmp_path / "nonelog.csv", ["filename", "x", "y"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(
            images_dir, "ds", tmp_path / "out", csv_path,
            _scatter_roles_config_with(normalize="none", x_scale="log", y_scale="log"),
        )
    msg = str(exc.value)
    assert "incompatible" in msg and "none" in msg, msg


def test_log_scale_on_strictly_positive_values_passes_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, str(float(i + 1)), str(float(i + 1))] for i, name in enumerate(sorted(names))]
    csv_path = _write_csv(tmp_path / "logok.csv", ["filename", "x", "y"], rows)
    result = ingest_metadata(
        images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config_with(x_scale="log", y_scale="log")
    )
    assert result.column_roles is not None
    entry = result.column_roles.scatter[0]
    assert entry.x_scale == "log" and entry.y_scale == "log"


def test_normalize_none_in_range_passes_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "0.5", "0.25"] for name in sorted(names)]
    csv_path = _write_csv(tmp_path / "noneok.csv", ["filename", "x", "y"], rows)
    result = ingest_metadata(
        images_dir, "ds", tmp_path / "out", csv_path, _scatter_roles_config_with(normalize="none")
    )
    assert result.column_roles is not None
    assert result.column_roles.scatter[0].normalize == "none"


# --- D-35 Seam G1: the manifest `options` echo -------------------------------------


def _fake_pyramid() -> SimpleNamespace:
    """A PyramidResult stand-in — _layout_entry reads only these attributes."""
    return SimpleNamespace(
        path="tiles/scatter/scatter_v1.pmtiles",
        tile_px=512, thumb_px=64, cap=64,
        levels=[SimpleNamespace(z=0, tile_count=1)], z_cap=0,
        detail_path_prefix=None, detail_format=None, dropped_total=0,
    )


def _scatter_result(options: dict | None, layout_id: str = "scatter") -> LayoutResult:
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    return LayoutResult(
        layout_id=layout_id, layout_type="scatter", label="Scatter",
        cells=cells, bbox=(0.0, 0.0, 1.0, 1.0), edges=None, options=options,
    )


def test_layout_entry_emits_options_only_when_present() -> None:
    applied = {"x_scale": "log", "y_scale": "linear", "normalize": "fit", "overlap": "overdraw"}
    with_opts = _layout_entry(_scatter_result(applied), _fake_pyramid())
    assert with_opts["options"] == applied
    # A default bake carries options=None -> the key is OMITTED (byte-stable).
    without = _layout_entry(_scatter_result(None), _fake_pyramid())
    assert "options" not in without


def test_manifest_carrying_options_conforms_to_schema() -> None:
    # SCHEMA CONFORMANCE: a full manifest whose scatter layout carries an `options`
    # echo validates against the REAL schemas/v2 contract (the pipeline's own
    # write-time validator). If `options` were absent from the schema or malformed,
    # this raises jsonschema.ValidationError.
    entry = _layout_entry(
        _scatter_result({"x_scale": "log", "y_scale": "log", "normalize": "fit", "overlap": "overdraw"}),
        _fake_pyramid(),
    )
    manifest = {
        "manifest_version": "2.3",
        "dataset_id": "ds",
        "dataset_version": 1,
        "layouts": [entry],
        "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-01-01T00:00:00Z"},
    }
    _validate_manifest(manifest)  # raises on any nonconformance


# --- D-35 Seam G1 review (2026-07-20): the embedded column_roles serialization ------
# _scatter_entry_to_dict carries the PR's headline byte-stability claim — pin it
# directly, not only through end-to-end reads.


def test_scatter_entry_to_dict_default_is_exactly_the_pre_v23_shape() -> None:
    entry = _roles(("u", "v", "S")).scatter[0]
    out = _scatter_entry_to_dict(entry)
    # Exactly the three pre-2.3 keys, in the pre-2.3 insertion order (the manifest is
    # written without sort_keys, so key order IS byte-visible).
    assert list(out) == ["x_column", "y_column", "label"]
    assert out == {"x_column": "u", "y_column": "v", "label": "S"}


def test_scatter_entry_to_dict_writes_only_non_default_knobs() -> None:
    knobbed = _roles_with(normalize="none").scatter[0]
    assert _scatter_entry_to_dict(knobbed) == {
        "x_column": "u", "y_column": "v", "label": "S", "normalize": "none",
    }
    # An EXPLICITLY-declared default serializes away (absent ≡ default by contract) —
    # the round-trip stays byte-stable with every pre-2.3 bake.
    explicit_default = _roles_with(x_scale="linear", normalize="fit").scatter[0]
    assert list(_scatter_entry_to_dict(explicit_default)) == ["x_column", "y_column", "label"]


def test_append_manifest_layouts_restamps_manifest_version(tmp_path: Path) -> None:
    # 2026-07-20 review: an appended entry may carry current-minor fields (the v2.3
    # `options` echo), so the merged file must self-describe as the current minor —
    # append re-stamps manifest_version (consumers are major-only; behavior-neutral).
    committed_entry = _layout_entry(_scatter_result(None, layout_id="grid"), _fake_pyramid())
    committed = {
        "manifest_version": "2.2",  # an older-minor committed manifest
        "dataset_id": "ds",
        "dataset_version": 1,
        "layouts": [committed_entry],
        "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-01-01T00:00:00Z"},
    }
    new = _scatter_result(
        {"x_scale": "log", "y_scale": "log", "normalize": "fit", "overlap": "overdraw"},
        layout_id="scatter_u",
    )
    out_path = tmp_path / "layout_manifest.json"
    append_manifest_layouts(committed, [new], {"scatter_u": _fake_pyramid()}, 2, out_path)

    merged = json.loads(out_path.read_text(encoding="utf-8"))
    assert merged["manifest_version"] == MANIFEST_VERSION  # re-stamped, not carried
    assert merged["dataset_version"] == 2
    # The committed entry itself is still byte-preserved (carry-forward contract).
    assert merged["layouts"][0] == committed_entry
    assert merged["layouts"][1]["options"]["x_scale"] == "log"


# --- D-35 Seam G1 review (2026-07-20): the add-layouts gate ------------------------
# run_add_layouts validates a roles override via worker._validate_roles_against_parquet
# — the knob preconditions MUST hold there too (the override path is the natural way
# to apply a knob to an existing dataset; before this gate, a declared 'log' over a
# non-positive column reached math.log as an opaque crash and an unimplemented
# overlap baked silently while echoing a false options record).


def _knob_parquet(tmp_path: Path, xs: list[float | None], ys: list[float | None]) -> Path:
    """A committed-style metadata.parquet with float64 scatter columns u/v.

    `filename` is here because a real one always has it: `ingest_metadata` is the sole
    writer of metadata.parquet and always writes `(id, filename, width, height)` beside
    the enrichment columns, then rebinds the filename role to that canonical name. The
    gate under test now checks the JOIN KEY as well (2026-09-09 review finding 7), so a
    parquet without it is not a committed-style one — `_roles_with` declares
    `filename.column == "filename"`, exactly as a committed manifest does.
    """
    path = tmp_path / "metadata.parquet"
    table = pa.table(
        {
            "id": pa.array(range(len(xs)), pa.int64()),
            "filename": pa.array([f"img_{i:03d}.webp" for i in range(len(xs))], pa.string()),
            "u": pa.array(xs, pa.float64()),
            "v": pa.array(ys, pa.float64()),
        }
    )
    pq.write_table(table, path)
    return path


def test_parquet_gate_rejects_log_on_nonpositive_value(tmp_path: Path) -> None:
    path = _knob_parquet(tmp_path, [1.0, 0.0, 3.0], [1.0, 2.0, 3.0])
    with pytest.raises(ColumnRoleError) as exc:
        worker._validate_roles_against_parquet(
            _roles_with(x_scale="log", y_scale="log"), path
        )
    msg = str(exc.value)
    assert "u:" in msg and "x_scale" in msg and "contains 0.0" in msg, msg


def test_parquet_gate_rejects_unimplemented_overlap_and_mixed_scales(tmp_path: Path) -> None:
    path = _knob_parquet(tmp_path, [0.5], [0.5])
    with pytest.raises(ColumnRoleError, match="not implemented yet"):
        worker._validate_roles_against_parquet(_roles_with(overlap="jitter"), path)
    with pytest.raises(ColumnRoleError, match="T2-128"):
        worker._validate_roles_against_parquet(_roles_with(x_scale="log"), path)


def test_parquet_gate_rejects_none_out_of_range(tmp_path: Path) -> None:
    path = _knob_parquet(tmp_path, [0.5, 1.5], [0.5, 0.5])
    with pytest.raises(ColumnRoleError) as exc:
        worker._validate_roles_against_parquet(_roles_with(normalize="none"), path)
    assert "contains 1.5" in str(exc.value)


def test_parquet_gate_pair_exemption_and_nonfinite_rows_do_not_reject(tmp_path: Path) -> None:
    # A row that cannot place is exempt on this path too: (-5, null) never reaches
    # math.log, and a NaN row is unplaced by _as_finite — the is_finite pair mask
    # mirrors placement exactly, so neither poisons the extent.
    path = _knob_parquet(
        tmp_path, [-5.0, float("nan"), 2.0], [None, 1.0, 3.0]
    )
    worker._validate_roles_against_parquet(
        _roles_with(x_scale="log", y_scale="log"), path
    )  # does not raise: the only placeable row is (2.0, 3.0)


def _committed_manifest_with_scatter(**knobs: str) -> dict:
    """A committed-manifest stand-in whose column_roles carry one scatter pair u/v."""
    return {
        "column_roles": {
            "filename": {"column": "filename", "label": "F"},
            "scatter": [{"x_column": "u", "y_column": "v", "label": "S", **knobs}],
        }
    }


def test_stale_knob_guard_rejects_changed_knobs_on_committed_pair() -> None:
    # Round-2 review finding #5: an override can re-describe a committed layout's
    # knobs that will never be re-baked — the manifest would contradict the bake.
    committed = _committed_manifest_with_scatter()  # baked knob-free (all defaults)
    with pytest.raises(ColumnRoleError, match="committed layout 'scatter'"):
        worker._guard_no_stale_scatter_config(
            committed, _roles_with(x_scale="log", y_scale="log"), {"scatter", "grid"}
        )


def test_stale_knob_guard_catches_the_single_to_multi_naming_transition() -> None:
    # Adding a SECOND pair shifts enumeration ids ("scatter" -> "scatter_<slug>"), so
    # an id-keyed comparison would miss this exact case — the guard matches by PAIR.
    committed = _committed_manifest_with_scatter()
    two_pairs = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "scatter": [
                {"x_column": "u", "y_column": "v", "label": "S", "normalize": "none"},
                {"x_column": "a", "y_column": "b", "label": "T"},
            ],
        }
    )
    with pytest.raises(ColumnRoleError, match="u/v"):
        worker._guard_no_stale_scatter_config(committed, two_pairs, {"scatter", "grid"})


def test_stale_knob_guard_allows_unchanged_explicit_default_and_new_pairs() -> None:
    committed = _committed_manifest_with_scatter()
    # Unchanged (knob-free) roles pass.
    worker._guard_no_stale_scatter_config(committed, _roles(("u", "v", "S")), {"scatter"})
    # EXPLICIT defaults equal the committed absent-=-default knobs — not a change.
    worker._guard_no_stale_scatter_config(
        committed,
        _roles_with(x_scale="linear", y_scale="linear", normalize="fit", overlap="overdraw"),
        {"scatter"},
    )
    # A NEW pair (different columns) is a new layout — never a stale re-description.
    fresh_pair = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "scatter": [{"x_column": "a", "y_column": "b", "label": "T", "normalize": "none"}],
        }
    )
    worker._guard_no_stale_scatter_config(committed, fresh_pair, {"scatter"})
    # A pair whose layout is NOT committed (declared but never baked) may change.
    worker._guard_no_stale_scatter_config(
        committed, _roles_with(x_scale="log", y_scale="log"), {"grid"}
    )


def test_parquet_gate_accepts_valid_knobs(tmp_path: Path) -> None:
    path = _knob_parquet(tmp_path, [1.0, 2.0], [3.0, 4.0])
    worker._validate_roles_against_parquet(_roles_with(x_scale="log", y_scale="log"), path)
    path2 = _knob_parquet(tmp_path, [0.0, 1.0], [0.5, 0.25])
    worker._validate_roles_against_parquet(_roles_with(normalize="none"), path2)
    # An ALL-null column has no placeable rows at all: extent (None, None) -> every
    # value guard no-ops (all cells would land in the unplaced strip; nothing to check).
    path3 = _knob_parquet(tmp_path, [None, None], [1.0, 2.0])
    worker._validate_roles_against_parquet(_roles_with(x_scale="log", y_scale="log"), path3)
