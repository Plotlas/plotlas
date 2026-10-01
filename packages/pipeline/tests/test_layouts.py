"""Tier-1 layout tests (non-native): coordinates and bbox stay within [0,1]^2,
categorical regions are population-proportional (recon. #8), and the worker
expands multi-entry families into one layout per role entry (recon. #9).

A duck-typed stand-in for the v2 ThumbnailCache is used so these stay lean
(importing pipeline.atlas would pull in pyvips, absent in the lean test image).
Layouts read only ``packed_ids(atlas)`` == ``sorted(atlas.ids)``.
"""
from __future__ import annotations

import datetime as _dt
import io
import logging
import math
from types import SimpleNamespace

import pyarrow as pa
import pyarrow.feather as feather

from pipeline import worker
from pipeline.layout_plugins._placement import STRIP_Y_MIN
from pipeline.layout_plugins.base import ColumnRoles, LayoutResult, build_spatial_cells
from pipeline.layout_plugins.categorical import _REGION_FILL, CategoricalLayout, _proportional_regions
from pipeline.layout_plugins.datetime_layout import DateTimeLayout, _sec_to_dt
from pipeline.layout_plugins.grid import GridLayout
from pipeline.manifest import MANIFEST_VERSION, _layout_entry, _validate_manifest


def _fake_atlas(n: int) -> SimpleNamespace:
    """A ThumbnailCache stand-in: layouts only need ``.ids`` (the renderable cell
    ids), which packed_ids sorts. Dense [0, n) here."""
    return SimpleNamespace(ids=list(range(n)), thumb_px=64, cache_dir=None, skipped=[])


def _assert_in_unit_square(table: pa.Table) -> None:
    for column in ("x", "y", "w", "h"):
        assert all(0.0 <= v <= 1.0 for v in table.column(column).to_pylist())


def test_grid_requires_no_roles() -> None:
    assert GridLayout().required_columns() == []  # the images-only floor (D-25)


def test_grid_layout_images_only_coords_in_unit_square() -> None:
    n = 8
    # Images-only: roles is None; grid orders by id (= sorted filename).
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "filename": pa.array([f"img_{i:03d}.webp" for i in range(n)], pa.string()),
        }
    )
    result = GridLayout().compute(meta=meta, roles=None, atlas=_fake_atlas(n), config={})

    assert result.cells.num_rows == n
    _assert_in_unit_square(result.cells)
    x_min, y_min, x_max, y_max = result.bbox
    assert 0.0 <= x_min <= x_max <= 1.0
    assert 0.0 <= y_min <= y_max <= 1.0


def test_categorical_layout_coords_in_unit_square(column_roles: dict) -> None:
    n = 8
    roles = ColumnRoles.from_config(column_roles)
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "category": pa.array(
                ["red", "blue", "green", "red", "blue", "green", "red", "blue"], pa.string()
            ),
        }
    )
    result = CategoricalLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(n), config={})

    assert result.cells.num_rows == n
    _assert_in_unit_square(result.cells)
    x_min, y_min, x_max, y_max = result.bbox
    assert 0.0 <= x_min <= x_max <= 1.0
    assert 0.0 <= y_min <= y_max <= 1.0


# --- proportional regions (recon. #8) ----------------------------------------


def _region_area(rect: tuple[float, float, float, float]) -> float:
    return rect[2] * rect[3]


def _overlap_area(
    a: tuple[float, float, float, float], b: tuple[float, float, float, float]
) -> float:
    dx = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    dy = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(0.0, dx) * max(0.0, dy)


def test_proportional_regions_areas_match_8_3_1_shares() -> None:
    counts = [8.0, 3.0, 1.0]
    regions = _proportional_regions(counts)

    assert len(regions) == 3
    total = sum(counts)
    for count, rect in zip(counts, regions):
        share = count / total
        area = _region_area(rect)
        assert abs(area - share) <= 0.2 * share, (  # ±20% bound (areas are exact here)
            f"region area {area} outside ±20% of share {share}"
        )
        # Region inside the unit square.
        x0, y0, w, h = rect
        assert -1e-9 <= x0 and -1e-9 <= y0
        assert x0 + w <= 1.0 + 1e-9 and y0 + h <= 1.0 + 1e-9
        # Aspect ratio clamped (~4:1).
        aspect = max(w / h, h / w)
        assert aspect <= 4.0 + 1e-6, f"aspect {aspect} exceeds 4:1"
    # Regions tile without overlapping (touching edges allowed).
    assert abs(sum(_region_area(r) for r in regions) - 1.0) < 1e-9
    for i in range(len(regions)):
        for j in range(i + 1, len(regions)):
            assert _overlap_area(regions[i], regions[j]) < 1e-9


def test_proportional_regions_single_group_fills_unit_square() -> None:
    # One group ⇒ exactly the unit square (the degenerate base case).
    assert _proportional_regions([7.0]) == [(0.0, 0.0, 1.0, 1.0)]


def test_proportional_regions_is_deterministic() -> None:
    # Pure arithmetic, no RNG (prime directive #3): identical inputs ⇒ identical
    # output, tuple-for-tuple.
    counts = [5.0, 5.0, 3.0, 2.0, 1.0]
    assert _proportional_regions(counts) == _proportional_regions(counts)


def test_proportional_regions_extreme_skew_keeps_hard_invariants() -> None:
    # The ±20%-area / ≤4:1-aspect bounds are "where feasible". Under extreme skew
    # (one dominant group + a long tail of singletons) the tail CAN exceed 4:1,
    # but the HARD invariants must still hold: areas exactly proportional, the
    # regions tile the unit square, and none escape [0,1].
    counts = [100.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    regions = _proportional_regions(counts)

    assert len(regions) == len(counts)
    total = sum(counts)
    for count, rect in zip(counts, regions):
        share = count / total
        assert abs(_region_area(rect) - share) <= 1e-9, "area not proportional"
        x0, y0, w, h = rect
        assert -1e-9 <= x0 and -1e-9 <= y0
        assert x0 + w <= 1.0 + 1e-9 and y0 + h <= 1.0 + 1e-9
    assert abs(sum(_region_area(r) for r in regions) - 1.0) < 1e-9
    for i in range(len(regions)):
        for j in range(i + 1, len(regions)):
            assert _overlap_area(regions[i], regions[j]) < 1e-9
    # The dominant group still gets a near-square region — the algorithm spends
    # its aspect budget where it matters; only the tiny tail regions degrade.
    dx0, dy0, dw, dh = regions[0]
    assert max(dw / dh, dh / dw) <= 4.0 + 1e-6


def _skewed_meta(n: int = 12) -> pa.Table:
    # 8/3/1 group sizes, plus a second categorical column for expansion tests.
    category = ["red"] * 8 + ["blue"] * 3 + ["green"]
    place = ["indoor" if i % 2 == 0 else "outdoor" for i in range(n)]
    return pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "category": pa.array(category, pa.string()),
            "place": pa.array(place, pa.string()),
        }
    )


def _two_categorical_roles() -> ColumnRoles:
    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "categorical": [
                {"column": "category", "label": "Category"},
                {"column": "place", "label": "Place"},
            ],
        }
    )


def _cells_bytes(result: LayoutResult) -> bytes:
    sink = io.BytesIO()
    feather.write_feather(result.cells, sink)
    return sink.getvalue()


def test_categorical_groups_occupy_disjoint_size_ordered_footprints() -> None:
    # Through compute(): every cell present, coords in [0,1]^2, per-group cell
    # footprints disjoint between groups, and the 8-member group's footprint
    # area exceeds the 3-member group's, which exceeds the 1-member group's
    # (the output-level face of region-area ∝ population).
    meta = _skewed_meta()
    result = CategoricalLayout().compute(
        meta=meta, roles=_two_categorical_roles(), atlas=_fake_atlas(12), config={}
    )
    _assert_in_unit_square(result.cells)
    assert sorted(result.cells.column("id").to_pylist()) == list(range(12))

    cat_of = {i: ("red" if i < 8 else "blue" if i < 11 else "green") for i in range(12)}
    boxes: dict[str, list[float]] = {}
    rows = zip(*(result.cells.column(c).to_pylist() for c in ("id", "x", "y", "w", "h")))
    for cid, x, y, w, h in rows:
        box = boxes.setdefault(cat_of[int(cid)], [1.0, 1.0, 0.0, 0.0])
        box[0] = min(box[0], x - w / 2)
        box[1] = min(box[1], y - h / 2)
        box[2] = max(box[2], x + w / 2)
        box[3] = max(box[3], y + h / 2)

    def area(box: list[float]) -> float:
        return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])

    def overlap(a: list[float], b: list[float]) -> float:
        dx = min(a[2], b[2]) - max(a[0], b[0])
        dy = min(a[3], b[3]) - max(a[1], b[1])
        return max(0.0, dx) * max(0.0, dy)

    keys = list(boxes)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            assert overlap(boxes[keys[i]], boxes[keys[j]]) < 1e-9, (
                f"group footprints {keys[i]}/{keys[j]} overlap"
            )
    assert area(boxes["red"]) > area(boxes["blue"]) > area(boxes["green"]) > 0.0


def test_categorical_compute_is_deterministic_byte_identical() -> None:
    meta = _skewed_meta()
    roles = _two_categorical_roles()
    a = CategoricalLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(12), config={})
    b = CategoricalLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(12), config={})
    assert _cells_bytes(a) == _cells_bytes(b)  # byte-identical across runs
    assert a.bbox == b.bbox and a.layout_id == b.layout_id and a.label == b.label


def test_missing_category_groups_under_empty_string() -> None:
    meta = pa.table(
        {
            "id": pa.array([0, 1, 2], pa.int64()),
            "category": pa.array(["red", None, "red"], pa.string()),
            "place": pa.array(["a", "b", "c"], pa.string()),
        }
    )
    result = CategoricalLayout().compute(
        meta=meta, roles=_two_categorical_roles(), atlas=_fake_atlas(3), config={}
    )
    # The null-category cell is retained (grouped under ""), not dropped.
    assert sorted(result.cells.column("id").to_pylist()) == [0, 1, 2]


# --- datetime square cells (T2-117) -------------------------------------------


def test_datetime_peaked_distribution_bakes_square_cells() -> None:
    # T2-117: a temporally-PEAKED dataset (one busy time-bucket → max_stack >> ncols)
    # must bake SQUARE cells (w == h) instead of the old "smashed" wide rectangles
    # (rijks_pilot baked 7.4:1 from ncols=222 / max_stack=1643), while the column
    # x-positions and stack y-positions stay UNCHANGED (histogram shape preserved).
    n = 50
    # 48 cells at one instant (a tall stack) + 2 at a later instant (establishes a span).
    epochs = [1000] * 48 + [2000] * 2
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "captured": pa.array(epochs, pa.int64()),
        }
    )
    roles = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "datetime": {"column": "captured", "label": "Captured", "format": "unix_seconds"},
        }
    )
    result = DateTimeLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(n), config={})
    _assert_in_unit_square(result.cells)
    assert result.cells.num_rows == n

    ws = result.cells.column("w").to_pylist()
    hs = result.cells.column("h").to_pylist()
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()

    # SQUARE: every cell w == h (the fix). The side is min(col_w, row_h) * 0.85.
    assert all(abs(w - h) < 1e-7 for w, h in zip(ws, hs)), "datetime cells must be square (w == h)"
    ncols = math.ceil(math.sqrt(n))            # 8 columns
    col_w = 1.0 / ncols                         # 0.125 (the column pitch)
    # The busiest column stacks 48 cells across the HISTOGRAM's box, which U1 (T2-140)
    # shortened to STRIP_Y_MIN so the unplaced strip's band below it is always free.
    row_h = STRIP_Y_MIN / 48
    expected_side = min(col_w, row_h) * 0.85
    assert all(abs(w - expected_side) < 1e-7 for w in ws), "side must be min(col_w, row_h) * fill"
    # The peaked precondition holds (max_stack > ncols), so the fix actually did something:
    # the pre-fix width (col_w * fill) was > 3x the (square) height — the "smashed" case.
    assert col_w > row_h, "test must be peaked (max_stack > ncols) to exercise the fix"
    assert col_w * 0.85 > expected_side * 3.0, "pre-fix cells were > 3:1 wide (the smashed rectangle)"

    # POSITIONS UNCHANGED: the 48 same-time cells occupy ONE column (a single centre x) and
    # stack into 48 DISTINCT y-slots; the 2 later cells sit in a SEPARATE column.
    busy_x = {round(x, 9) for x, e in zip(xs, epochs) if e == 1000}
    late_x = {round(x, 9) for x, e in zip(xs, epochs) if e == 2000}
    assert len(busy_x) == 1, "the 48 same-time cells must share exactly one column x-position"
    assert busy_x.isdisjoint(late_x), "the later cells must fall in a different time column"
    busy_y = {round(y, 9) for y, e in zip(ys, epochs) if e == 1000}
    assert len(busy_y) == 48, "the busy column must stack into 48 distinct y-slots (histogram preserved)"


def test_datetime_spread_distribution_uses_column_pitch() -> None:
    # T2-117 (mirror of the peaked case): a temporally-SPREAD dataset (many time-buckets,
    # short stacks → max_stack < ncols) must ALSO bake SQUARE cells, but here the square side
    # comes from the COLUMN pitch (col_w), the smaller of the two — exercising the OTHER arm of
    # min(col_w, row_h) that the peaked test (where row_h is smaller) does not.
    n = 20
    # 20 distinct, evenly-spaced instants → the 5 columns each stack exactly 4 (max_stack=4 < 5).
    epochs = list(range(1000, 1000 + n))
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "captured": pa.array(epochs, pa.int64()),
        }
    )
    roles = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "datetime": {"column": "captured", "label": "Captured", "format": "unix_seconds"},
        }
    )
    result = DateTimeLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(n), config={})
    _assert_in_unit_square(result.cells)
    assert result.cells.num_rows == n

    ws = result.cells.column("w").to_pylist()
    hs = result.cells.column("h").to_pylist()
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()

    # SQUARE regardless of which pitch is smaller.
    assert all(abs(w - h) < 1e-7 for w, h in zip(ws, hs)), "datetime cells must be square (w == h)"

    # The TICK pitch is observable in the output (T2-138: it is now ONE calendar interval
    # wide, not 1/ceil(sqrt(n)) — these 20 one-second-apart cells bucket per SECOND, so each
    # gets its own bin): the smallest gap between adjacent distinct bin x's IS that pitch.
    col_xs = sorted({round(x, 9) for x in xs})
    assert len(col_xs) > 1, "a spread distribution must occupy several bins"
    tick_pitch = min(b - a for a, b in zip(col_xs, col_xs[1:]))
    # H2 (D-36): a tick pitch is `(1 + _BIN_GUTTER_CELLS)` CELL pitches, not one — the gutter
    # is spent at every bin boundary, `k = 1` included. So the cell (and with it the drawn
    # side) is the tick pitch DIVIDED by that, where pre-H2 the two were the same number.
    col_w = tick_pitch / 1.25
    # max_stack is observable in the output: y depends ONLY on the row, and the busiest bin
    # fills rows 0..max_stack-1, so the number of DISTINCT y-values IS max_stack — no need to
    # replicate the internal bucketing to know it.
    max_stack = len({round(y, 9) for y in ys})
    # The histogram box is STRIP_Y_MIN tall since U1 (the band y in [STRIP_Y_MIN, 1] is reserved
    # for the unplaced strip), so the height bound is STRIP_Y_MIN/max_stack — NOT 1.0/max_stack,
    # which was the pre-U1 box and would assert against a box the layout no longer draws into if
    # this fixture ever became stack-bound. Its sibling peaked test carries the same STRIP_Y_MIN.
    row_h = STRIP_Y_MIN / max_stack
    expected_side = min(col_w, row_h) * 0.85
    assert all(abs(w - expected_side) < 1e-7 for w in ws), "side must be min(col_w, row_h) * fill"

    # SPREAD precondition: this fixture exercises the col_w arm (the mirror of the peaked
    # test's `col_w > row_h`), and the square side comes from the CELL pitch.
    assert col_w < row_h, "test must be SPREAD (short stacks) to exercise the col_w arm"
    assert abs(expected_side - col_w * 0.85) < 1e-12, "the square side must come from the cell pitch"

    # ONE COLUMN PER TIME BUCKET, on CALENDAR boundaries (T2-138): these 20 instants are one
    # second apart over a 19-second span, which earns the finest (per-SECOND) rung — so each
    # keeps its own column x. The temporal histogram is preserved, now aligned to clock
    # boundaries rather than sitting on a sqrt(n) grid at bucket centres.
    assert len(col_xs) == n, f"one column per 1-second bucket (got {len(col_xs)})"


# --- multi-entry family expansion (recon. #9) ---------------------------------


def test_two_categorical_columns_expand_to_two_layouts() -> None:
    meta = _skewed_meta()
    results = worker._expand_layouts(
        CategoricalLayout(), meta, _two_categorical_roles(), _fake_atlas(12)
    )

    assert [r.layout_id for r in results] == ["categorical_category", "categorical_place"]
    assert [r.label for r in results] == ["Category", "Place"]  # the role entries' labels
    assert all(r.layout_type == "categorical" for r in results)
    # Each expanded layout carries the full id set (D-10 invariant).
    for r in results:
        assert sorted(r.cells.column("id").to_pylist()) == list(range(12))


def test_single_categorical_column_keeps_bare_layout_id() -> None:
    meta = _skewed_meta()
    roles = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "categorical": [{"column": "category", "label": "Category"}],
        }
    )
    results = worker._expand_layouts(CategoricalLayout(), meta, roles, _fake_atlas(12))

    assert [r.layout_id for r in results] == ["categorical"]  # back-compat (D-26 naming)
    assert results[0].label == "Category"


# --- v2.5 annotations (T2-69 / T2-72 Seam 2) ----------------------------------


def _dt_roles(fmt: str = "iso8601", label: str = "Captured") -> ColumnRoles:
    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "datetime": {"column": "captured", "label": label, "format": fmt},
        }
    )


def _fake_pyramid(detail_path_prefix: str | None = None) -> SimpleNamespace:
    """A PyramidResult stand-in — _layout_entry reads only these attributes (mirrors
    test_scatter._fake_pyramid). Pass ``detail_path_prefix`` to make the entry carry a
    ``detail`` block, which is the LAST key in the canonical field order."""
    return SimpleNamespace(
        path="tiles/x/x_v1.pmtiles", tile_px=512, thumb_px=64, cap=64,
        levels=[SimpleNamespace(z=0, tile_count=1)], z_cap=0,
        detail_path_prefix=detail_path_prefix, detail_format=None, dropped_total=0,
    )


def test_categorical_captures_one_label_per_band_with_counts() -> None:
    # The treemap's per-band (text, extent, count) — computed for placement and, until
    # v2.5, discarded — is now captured as the overlay label annotations.
    meta = _skewed_meta()  # category: red*8, blue*3, green*1
    result = CategoricalLayout().compute(
        meta=meta, roles=_two_categorical_roles(), atlas=_fake_atlas(12), config={}
    )
    assert result.annotations is not None
    labels = result.annotations["labels"]
    by = {lab["text"]: lab for lab in labels}
    assert set(by) == {"red", "blue", "green"}  # one label per distinct band
    assert (by["red"]["count"], by["blue"]["count"], by["green"]["count"]) == (8, 3, 1)
    # Every placed cell belongs to exactly one band → counts sum to n.
    assert sum(lab["count"] for lab in labels) == 12
    # Each extent is a normalized [x0,y0,x1,y1] bbox with x0<x1, y0<y1.
    for lab in labels:
        ext = lab["extent"]
        assert len(ext) == 4 and all(0.0 <= v <= 1.0 for v in ext)
        assert ext[0] < ext[2] and ext[1] < ext[3]
    # No real-valued band is flagged missing.
    assert all("missing" not in lab for lab in labels)


def test_categorical_missing_bucket_flagged_structurally_not_value_sniffed() -> None:
    # Null category cells group under the plugin's "" sentinel and ARE flagged
    # missing; a real value literally spelled "unknown" is a NORMAL band — proving the
    # flag is pipeline-known missingness, never a string match on "unknown"/"anonymous".
    meta = pa.table(
        {
            "id": pa.array([0, 1, 2, 3], pa.int64()),
            "category": pa.array(["red", None, "unknown", None], pa.string()),
            "place": pa.array(["a", "b", "c", "d"], pa.string()),
        }
    )
    result = CategoricalLayout().compute(
        meta=meta, roles=_two_categorical_roles(), atlas=_fake_atlas(4), config={}
    )
    by = {lab["text"]: lab for lab in result.annotations["labels"]}
    # The two null cells (ids 1, 3) form the "" band and ARE flagged missing.
    assert by[""]["missing"] is True
    assert by[""]["count"] == 2
    # The real value "unknown" is a normal band — NOT flagged (no value-sniffing).
    assert by["unknown"]["count"] == 1
    assert "missing" not in by["unknown"]
    assert "missing" not in by["red"]
    # v2.6 (T2-140 / D-36 seam U1): the same population is also the layout's `missing_count`.
    # This family gives those cells a labelled band rather than a strip, but the question the
    # field answers — "how many images could this layout not place from its column" — has the
    # same answer in every family, so a reader never has to special-case categorical by
    # walking `labels[].missing` for a number the entry already carries.
    assert result.missing_count == 2
    # A column with no nulls counts none — and says so with a 0 (see `_layout_entry`).
    full = CategoricalLayout().compute(
        meta=meta.set_column(
            meta.schema.get_field_index("category"),
            "category",
            pa.array(["red", "blue", "unknown", "red"], pa.string()),
        ),
        roles=_two_categorical_roles(),
        atlas=_fake_atlas(4),
        config={},
    )
    assert full.missing_count == 0


def test_categorical_label_extent_leaves_an_image_free_gap() -> None:
    # The label extent is the band's FULL region rect, and the band's image footprints
    # sit strictly INSIDE it (members fill only _REGION_FILL) — so the extent's top
    # margin is image-free. This is the producer-side guarantee the renderer relies on
    # to place a label in the gap beside a band without ever covering an image.
    meta = _skewed_meta()
    result = CategoricalLayout().compute(
        meta=meta, roles=_two_categorical_roles(), atlas=_fake_atlas(12), config={}
    )
    cat_of = {i: ("red" if i < 8 else "blue" if i < 11 else "green") for i in range(12)}
    extent_of = {lab["text"]: lab["extent"] for lab in result.annotations["labels"]}
    top_gap: dict[str, float] = {}
    rows = zip(*(result.cells.column(c).to_pylist() for c in ("id", "x", "y", "w", "h")))
    for cid, x, y, w, h in rows:
        cat = cat_of[int(cid)]
        x0, y0, x1, y1 = extent_of[cat]
        # Every cell footprint lies within its band's extent (tol for the 6-dp round).
        assert x0 - 1e-6 <= x - w / 2 and x + w / 2 <= x1 + 1e-6
        assert y0 - 1e-6 <= y - h / 2 and y + h / 2 <= y1 + 1e-6
        top_gap[cat] = min(top_gap.get(cat, 1.0), (y - h / 2) - y0)
    # Every band has a strictly-positive image-free top margin (the label's gap-slot).
    for cat, gap in top_gap.items():
        assert gap > 0.0, f"band {cat} has no image-free top gap for its label"


def test_categorical_coerces_non_string_column_values_to_str(caplog) -> None:
    # PR-180 review regression fix: the add-layouts roles-override path can point the
    # categorical role at a TYPED Parquet column (the worker gate is presence-only for
    # categorical). Raw non-string keys used to (a) crash sorted(groups) on int+null
    # mixes and (b) reach label.text as non-string, failing the manifest schema at the
    # END of an expensive bake. Values are now coerced to str at read time — such
    # columns keep baking (the pre-2.5 ability) AND gain honest labels ("1950") — and
    # the coercion is SIGNALLED with a warning naming the column (operator-blessed:
    # defaults + warnings, never prohibition).
    n = 6
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            # int64 WITH a null — the sorted() TypeError case.
            "category": pa.array([1950, 1950, 2000, 1950, None, 2000], pa.int64()),
        }
    )
    roles = ColumnRoles.from_config(
        {"filename": {"column": "filename", "label": "F"}, "categorical": [{"column": "category", "label": "By year"}]}
    )
    with caplog.at_level(logging.WARNING):
        result = CategoricalLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(n), config={})
    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert any("not string-typed" in m and "category" in m and "int" in m for m in warnings), (
        f"the coercion must warn naming the column + example type; got {warnings}"
    )
    assert result.annotations is not None
    labels = result.annotations["labels"]
    assert all(isinstance(lab["text"], str) for lab in labels), "every label text is a str"
    by_text = {lab["text"]: lab for lab in labels}
    assert by_text["1950"]["count"] == 3 and by_text["2000"]["count"] == 2
    assert by_text[""]["missing"] is True and by_text[""]["count"] == 1
    # The full annotation survives the manifest's write-time schema gate (this used to
    # be the failure point) — proven by validating a real layout entry.
    entry = _layout_entry(result, _fake_pyramid())
    assert all(isinstance(lab["text"], str) for lab in entry["annotations"]["labels"])


def test_categorical_coerces_date_column_and_stays_json_serializable() -> None:
    # A date-typed categorical (e.g. "group by capture date") used to raise in
    # json.dumps ("Object of type date is not JSON serializable"). str() coercion
    # yields honest ISO-day labels.
    import json as _json

    n = 4
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "category": pa.array(
                [_dt.date(2021, 1, 1), _dt.date(2021, 1, 1), _dt.date(2021, 6, 15), None],
                pa.date32(),
            ),
        }
    )
    roles = ColumnRoles.from_config(
        {"filename": {"column": "filename", "label": "F"}, "categorical": [{"column": "category", "label": "By day"}]}
    )
    result = CategoricalLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(n), config={})
    assert result.annotations is not None
    _json.dumps(result.annotations)  # must not raise
    texts = {lab["text"] for lab in result.annotations["labels"]}
    assert "2021-01-01" in texts and "2021-06-15" in texts and "" in texts


def test_categorical_caps_labels_at_500_keeping_the_missing_bucket(caplog) -> None:
    # PR-180 review: an uncapped label list ballooned the manifest ~1 MB at 10k distinct
    # values and added seconds of schema validation to EVERY manifest write. The producer
    # emits the top-_MAX_LABELS bands by count; the structurally-missing band is ALWAYS
    # kept — via the explicit SWAP branch when it falls beyond the cap. The verification
    # rider on this test: the missing band must genuinely land OUTSIDE the top-500 head
    # (placement sorts by (-count, key) and "" sorts FIRST among count ties, so the band
    # must have a strictly SMALLER count than 500+ real bands to exercise the swap —
    # here count 1 vs 550 count-2 bands, position 551).
    n_real = 550
    values: list[str | None] = []
    for i in range(n_real):
        values.extend([f"cat_{i:03d}"] * 2)
    values.append(None)  # the missing bucket: count 1, sorted AFTER every count-2 band
    n = len(values)
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "category": pa.array(values, pa.string()),
        }
    )
    roles = ColumnRoles.from_config(
        {"filename": {"column": "filename", "label": "F"}, "categorical": [{"column": "category", "label": "By cat"}]}
    )
    with caplog.at_level(logging.WARNING):
        result = CategoricalLayout().compute(meta=meta, roles=roles, atlas=_fake_atlas(n), config={})
    assert result.annotations is not None
    labels = result.annotations["labels"]
    assert len(labels) == 500, "the emitted list is capped at _MAX_LABELS"
    # The missing bucket (count 1 — placement position 551, beyond the cap) is KEPT via
    # the swap: it replaces the 500th (smallest kept) band. Removing the swap logic makes
    # this fail — the band would be silently truncated.
    missing = [lab for lab in labels if lab.get("missing")]
    assert len(missing) == 1 and missing[0]["count"] == 1, "the missing band never silently vanishes"
    # …and it genuinely displaced a real band: exactly 499 real bands remain, the head of
    # the count-desc placement order (cat_000..cat_498; cat_549 alone would also be legal
    # under a different tiebreak, so pin just the count + arithmetic).
    real = [lab for lab in labels if not lab.get("missing")]
    assert len(real) == 499 and all(lab["count"] == 2 for lab in real)
    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert any("551 distinct values" in m and "category" in m for m in warnings), (
        f"the truncation must be loudly logged naming the column; got {warnings}"
    )
    # Under the cap: no truncation, no warning.
    caplog.clear()
    small = CategoricalLayout().compute(
        meta=_skewed_meta(), roles=_two_categorical_roles(), atlas=_fake_atlas(12), config={}
    )
    assert small.annotations is not None and len(small.annotations["labels"]) == 3
    assert not [r for r in caplog.records if r.levelname == "WARNING"]


def test_datetime_captures_axis_domain_from_extreme_dates() -> None:
    n = 10
    dates = [_dt.datetime(2021, 1, 1) + _dt.timedelta(days=i) for i in range(n)]
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "captured": pa.array(dates, pa.timestamp("s")),
        }
    )
    result = DateTimeLayout().compute(meta=meta, roles=_dt_roles(), atlas=_fake_atlas(n), config={})
    assert result.annotations is not None
    axes = result.annotations["axes"]
    assert len(axes) == 1
    ax = axes[0]
    assert ax["orientation"] == "x" and ax["scale"] == "time"
    assert ax["label"] == "Captured"
    # T2-138: `range` and `domain` (the FLOORED first bucket start to the LAST bucket start,
    # both real occupied columns) together describe EXACTLY the line the placement uses, so
    # the consumer's inverse reproduces the bake. (Pre-T2-138 `range` was
    # snapped to the extreme sqrt(n) COLUMN CENTRES [0.125, 0.875], which aligned only the
    # two endpoint ticks and left interior columns adrift by up to half a bucket.)
    # `range` runs to the LAST BIN'S TICK. Since H2 (D-36) that bin's block of `k` cells then
    # sits to the RIGHT of it, so even a wide, shallow fixture like this one — where the
    # WIDTH term sets the pitch — stops short of `1-margin` by exactly that block; it is the
    # block EDGE, not the tick, that reaches the band end. Pre-H2 this read [0.04, 0.96].
    assert ax["range"] == [0.04, 0.884897959]
    # ENDPOINT ALIGNMENT: the cells carrying t_min / t_max sit half a cell right of the range
    # ends (k = 1 here, so each block is one cell and its centre is its left edge + p_c/2).
    xs = result.cells.column("x").to_pylist()
    half = (max(xs) - min(xs)) / (len(set(xs)) - 1) / 2.5   # tick pitch = (1+g) cells
    assert abs(min(xs) - (ax["range"][0] + half)) < 1e-6, "earliest cell's BLOCK starts at range[0]"
    assert abs(max(xs) - (ax["range"][1] + half)) < 1e-6, "latest cell's BLOCK starts at range[1]"
    lo, hi = ax["domain"]
    # ISO-8601 UTC, ordered, matching the extreme input dates (these 10 daily dates bucket
    # per DAY, and 2021-01-01 is already a day boundary, so the floor is a no-op here).
    assert lo.startswith("2021-01-01T00:00:00")
    assert hi.startswith("2021-01-10T00:00:00")
    assert lo < hi
    # INTERIOR alignment (the T2-138 fix, beyond the endpoints): EVERY cell's own BLOCK
    # starts exactly where the emitted axis places its day — reconstructed the way the
    # consumer does (overlayLayer.axisDomainToTimeDomain + domainToX). Since H2 that block
    # is `k` cells wide and the cell sits `(col + 0.5)` pitches into it; `k = 1` here, so the
    # offset is the `half` measured above. (The general form lives in the plugin's own suite,
    # `test_datetime_layout._assert_on_its_tick`.)
    t_lo = _dt.datetime.fromisoformat(lo).timestamp() * 1000.0
    t_hi = _dt.datetime.fromisoformat(hi).timestamp() * 1000.0
    slope = (t_hi - t_lo) / (ax["range"][1] - ax["range"][0])
    intercept = t_lo - slope * ax["range"][0]
    for cell_x, date in zip(xs, dates):
        want = (date.replace(tzinfo=_dt.timezone.utc).timestamp() * 1000.0 - intercept) / slope
        assert abs((cell_x - half) - want) < 1e-6, (
            f"cell dated {date:%Y-%m-%d} must have its block's left edge on its own tick"
        )


def test_sec_to_dt_handles_ancient_and_pre_1970_seconds() -> None:
    """`_sec_to_dt` is what renders the emitted axis `domain`, and it is built as
    ``_EPOCH + timedelta`` (never ``datetime.fromtimestamp``) so ancient / pre-1970 dates
    round-trip on every platform — ``fromtimestamp`` raises on negative timestamps on
    Windows. (This replaces the identical pin on ``_epoch_to_iso``, which the PR-189 review
    found had no production caller left: the domain is emitted by
    ``_sec_to_dt(...).isoformat()``, and ``_epoch_to_iso``'s fmt-aware /1000 was a live
    1000x trap for anyone who swapped one for the other. The unix_millis scaling it used to
    cover is pinned end-to-end by ``test_unix_millis_scaling_is_applied``.)"""
    assert _sec_to_dt(0.0).isoformat().startswith("1970-01-01T00:00:00")
    ancient = _dt.datetime(1100, 1, 1, tzinfo=_dt.timezone.utc).timestamp()
    assert _sec_to_dt(ancient).isoformat().startswith("1100-01-01T00:00:00")


def test_datetime_degenerate_span_emits_declined_axis_marker() -> None:
    # All-equal dates → x ≡ 0.5, no derivable domain. The producer emits the EXPLICIT
    # {"axes": []} declined marker (PR-180 review), never None: absent annotations mean
    # "pre-2.5 — the client may shim a domain via getMetadata", so a 2.5 refusal must be
    # distinguishable or the shim resurrects an axis the producer declined.
    n = 5
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "captured": pa.array([1000] * n, pa.int64()),
        }
    )
    result = DateTimeLayout().compute(
        meta=meta, roles=_dt_roles(fmt="unix_seconds"), atlas=_fake_atlas(n), config={}
    )
    assert result.annotations == {"axes": []}


def test_datetime_out_of_range_epoch_skips_axis_without_failing(caplog) -> None:
    # R1 (verification rider): a unix_seconds role fed MILLISECOND-magnitude values (~year
    # 52,000) overflows the ISO calendar-date conversion. The layout must still BAKE (x is
    # normalized — a huge span merely skews it, the pre-2.5 behaviour) — emit NO axis
    # annotation + a warning naming the column, and NEVER fail the bake.
    n = 4
    epochs = [1_600_000_000_000, 1_600_000_000_001, 1_600_000_000_002, 1_600_000_000_003]
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "captured": pa.array(epochs, pa.int64()),
        }
    )
    with caplog.at_level(logging.WARNING):
        result = DateTimeLayout().compute(
            meta=meta, roles=_dt_roles(fmt="unix_seconds"), atlas=_fake_atlas(n), config={}
        )
    # The layout baked (cells present, coords in [0,1]) — only the axis is declined, via
    # the EXPLICIT {"axes": []} marker (so the client shim cannot resurrect the garbage
    # year-52,000 axis the producer refused — PR-180 review).
    assert result.cells.num_rows == n
    _assert_in_unit_square(result.cells)
    assert result.annotations == {"axes": []}, "an out-of-range domain emits the declined-axis marker"
    warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert any("axis domain omitted" in m and "captured" in m for m in warnings), (
        f"a warning must name the column; got {warnings}"
    )


def test_grid_emits_no_annotations() -> None:
    n = 6
    meta = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "filename": pa.array([f"img_{i:03d}.webp" for i in range(n)], pa.string()),
        }
    )
    result = GridLayout().compute(meta=meta, roles=None, atlas=_fake_atlas(n), config={})
    assert result.annotations is None


def test_region_fill_gutter_covers_the_frontend_label_gap_frac() -> None:
    # R3 — LOAD-BEARING COUPLING (mirror: the frontend test `label gap fraction stays within
    # the treemap gutter`). The frontend places each band label in the band's top-gutter strip
    # of fractional height `DEFAULT_OVERLAY_LAYER_CONFIG.labelGapFrac` (0.05, in
    # packages/frontend/src/renderer/overlayLayer.ts). That strip is image-free ONLY while it
    # is <= this plugin's per-edge inset (1 - _REGION_FILL)/2. If a future edit shrinks
    # _REGION_FILL's gutter below the frontend's labelGapFrac, labels would render OVER images
    # — so this side of the coupling is pinned here, and the frontend side pins its own literal
    # (each test names the OTHER side so an editor of either is told about the coupling).
    # The 1e-9 tolerance absorbs binary-float representation only: _REGION_FILL 0.9 makes
    # (1 - 0.9)/2 evaluate to 0.049999999999999996, nominally EQUAL to 0.05 (a ~1e-17 gap,
    # sub-atomic at any screen scale). A real reduction of the gutter (e.g. _REGION_FILL 0.95 →
    # 0.025) still trips this well outside the tolerance.
    assert (1.0 - _REGION_FILL) / 2.0 >= 0.05 - 1e-9, (
        "the categorical per-edge image-free gutter dropped below the frontend labelGapFrac "
        "(overlayLayer.ts DEFAULT_OVERLAY_LAYER_CONFIG.labelGapFrac = 0.05) — band labels would "
        "render over images; keep the two in sync"
    )


def test_manifest_version_is_the_current_minor() -> None:
    """The stamp the pipeline writes, as a LITERAL — a bump must be a deliberate edit here,
    never a side effect. 2.10 is the per-layout `source_fingerprint` MINOR — HOW a layout
    read its columns, so staleness outlives the commit that caused it (LAYOUT_DESIGNER
    D-xxix); 2.9 was the per-layout `source_columns` provenance MINOR, which also removed
    `column_roles.url` (INTAKE_REDESIGN §6c D-xvii); 2.8 was `column_roles.url`; 2.7
    was the datetime `annotations.axes[].interval` bucketing rung (T2-142 / D-36 seam H3).
    Named for the role rather than the value: `test_manifest_version_is_2_5` outlived
    2.5 by one seam and had to be renamed, so the name is a claim that goes stale."""
    assert MANIFEST_VERSION == "2.10"


def test_layout_entry_emits_annotations_only_when_present() -> None:
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    ann = {"labels": [{"text": "red", "extent": [0.0, 0.0, 0.5, 1.0], "count": 2}]}
    with_ann = _layout_entry(
        LayoutResult("categorical", "categorical", "Cat", cells, (0.0, 0.0, 1.0, 1.0), None, annotations=ann),
        _fake_pyramid(),
    )
    assert with_ann["annotations"] == ann
    # grid/scatter/geographic carry annotations=None → the key is OMITTED (byte-stable).
    without = _layout_entry(
        LayoutResult("grid", "grid", "Grid", cells, (0.0, 0.0, 1.0, 1.0), None),
        _fake_pyramid(),
    )
    assert "annotations" not in without


def test_layout_entry_always_emits_missing_count_including_zero() -> None:
    """v2.6 (T2-140 / D-36 seam U1): the count of cells the layout could not place rides on
    the LAYOUT ENTRY, and is emitted UNCONDITIONALLY — `0` included, the same rule
    `pyramid.dropped_total` has used since 2.5.

    Emitting the zero is the whole point, and the earlier draft of this MINOR got it
    backwards: it OMITTED the key at zero while claiming that let a reader tell "counted,
    found none" from "producer predates the field". Omitting is exactly what collapses those
    two into one absent key. With the zero written, `0` is a positive claim and an ABSENT key
    means one thing only — a pre-2.6 entry carried forward by add-layouts."""
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    bbox = (0.0, 0.0, 1.0, 1.0)
    with_missing = _layout_entry(
        LayoutResult("datetime", "datetime", "By date", cells, bbox, None, missing_count=7),
        _fake_pyramid(),
    )
    assert with_missing["missing_count"] == 7
    # It is on the ENTRY, not tucked into `annotations` — that is the whole point of the
    # field's home (a declined axis emits no axis object to hang it on).
    assert "annotations" not in with_missing
    none_missing = _layout_entry(
        LayoutResult("grid", "grid", "Grid", cells, bbox, None), _fake_pyramid()
    )
    assert none_missing["missing_count"] == 0, (
        "a fully-placed layout must SAY zero, not fall silent — an absent key is reserved "
        "for a pre-2.6 entry and must never be readable as a counted zero"
    )
    # And it conforms: the schema types it as a non-negative integer on the layoutEntry,
    # whose `additionalProperties: false` would reject it if the schema had not been updated.
    _validate_manifest(
        {
            "manifest_version": MANIFEST_VERSION,
            "dataset_id": "ds",
            "dataset_version": 1,
            "layouts": [with_missing, none_missing],
            "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-01-01T00:00:00Z"},
        }
    )


def test_layout_entry_field_order_survives_annotations_and_missing_count_together() -> None:
    """The canonical field order, pinned for the one shape no fixture has: an entry carrying
    `annotations` AND `missing_count` AND `detail` at once. `manifest._layout_entry` and
    `worker._enrich_layout_entry` each write this order independently, and refresh's
    byte-identity guarantee is that the two agree — but the golden fixture's annotated layout
    (datetime) has `missing_count` 0 while its counted layouts (scatter/geographic) carry no
    annotations, so before this pin the two `if` blocks could be swapped in either writer with
    every test still green. The first real artifact to carry both is a refreshed rijks/nasa
    datetime layout with undated images."""
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    entry = _layout_entry(
        LayoutResult(
            "datetime", "datetime", "By date", cells, (0.0, 0.0, 1.0, 1.0), None,
            options={"overlap": "overdraw"},
            annotations={"axes": []},
            missing_count=7,
            source_columns=("captured",),
            source_fingerprint={"captured": (("datetime", "iso8601"),)},
        ),
        _fake_pyramid(detail_path_prefix="images"),
        positions_ref="positions/datetime_v1.arrow",
    )
    assert list(entry) == [
        "layout_id", "label", "type", "bbox", "bbox_exact", "pyramid",
        "positions_ref", "options", "annotations", "missing_count", "source_columns",
        "source_fingerprint", "detail",
    ]
    # `_enrich_layout_entry` rebuilds a committed entry from scratch; it must land on the
    # SAME sequence or a refreshed manifest stops matching a fresh bake byte-for-byte.
    rebuilt = worker._enrich_layout_entry(
        entry,
        entry["bbox_exact"],
        entry["annotations"],
        entry["missing_count"],
        tuple(entry["source_columns"]),
        {"captured": (("datetime", "iso8601"),)},
    )
    assert list(rebuilt) == list(entry)
    assert rebuilt == entry, "refresh must reproduce the emitter's entry exactly"


def test_layout_entry_emits_full_precision_bbox_exact() -> None:
    # v2.5 (T2-72 Seam 2): `bbox` is rounded to 6 dp, but `bbox_exact` preserves the unrounded
    # float64 the tiler binned cell centres against — so the chip derivation bins EXACTLY
    # (PR #179 root-cause fix). Emitted on every layout.
    cells = build_spatial_cells([0], [0.5], [0.5], [0.1], [0.1])
    bbox = (0.1234567891, 0.0, 0.8620857143, 1.0)
    entry = _layout_entry(LayoutResult("scatter", "scatter", "S", cells, bbox, None), _fake_pyramid())
    assert entry["bbox"] == [round(v, 6) for v in bbox], "bbox stays 6-dp rounded"
    assert entry["bbox_exact"] == [float(v) for v in bbox], "bbox_exact is the unrounded value"
    assert entry["bbox_exact"] != entry["bbox"], "the two differ where rounding mattered"


def test_manifest_carrying_annotations_conforms_to_schema() -> None:
    # SCHEMA CONFORMANCE against the REAL schemas/v2 contract (the pipeline's write-time
    # validator): a categorical layout's labels (incl. the empty-text missing bucket) and
    # a datetime layout's axis both validate. Raises jsonschema.ValidationError otherwise.
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    labels_entry = _layout_entry(
        LayoutResult(
            "categorical", "categorical", "Cat", cells, (0.0, 0.0, 1.0, 1.0), None,
            annotations={
                "labels": [
                    {"text": "red", "extent": [0.0, 0.0, 0.5, 1.0], "count": 8},
                    {"text": "", "extent": [0.5, 0.0, 1.0, 1.0], "count": 2, "missing": True},
                ]
            },
        ),
        _fake_pyramid(),
    )
    axis_entry = _layout_entry(
        LayoutResult(
            "datetime", "datetime", "By date", cells, (0.0, 0.0, 1.0, 1.0), None,
            annotations={
                "axes": [
                    {
                        "orientation": "x", "scale": "time",
                        "domain": ["2021-01-01T00:00:00+00:00", "2021-09-13T00:00:00+00:00"],
                        "range": [0.04, 0.96], "label": "Captured",
                    }
                ]
            },
        ),
        _fake_pyramid(),
    )
    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "dataset_id": "ds",
        "dataset_version": 1,
        "layouts": [labels_entry, axis_entry],
        "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-01-01T00:00:00Z"},
    }
    _validate_manifest(manifest)  # raises on any nonconformance
