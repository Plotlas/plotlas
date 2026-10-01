"""Datetime layout — calendar-aligned bucketing + the axis/bin ALIGNMENT contract (T2-138).

LEAN (no pyvips): the layout is pure geometry over a pyarrow table, so these run in the
lean test image. The headline test is `test_every_column_lands_on_its_bucket_tick`, which
reconstructs the CONSUMER's t->x map from the emitted annotation exactly as
`overlayLayer.axisDomainToTimeDomain` does and asserts every baked cell sits on its own
bucket's tick — the property whose absence was the operator-reported drift. Since H2 (D-36)
that tick marks the LEFT EDGE of the bin's `k`-wide block rather than a column centre, so
the identity is "x, minus the cell's own within-block offset `(col + 0.5)*p_c`, is the
tick"; `_assert_on_its_tick` is the one place that is written down.
"""
from __future__ import annotations

import datetime as _dt
import json
import logging
import math
import re
from collections import defaultdict

import pyarrow as pa
import pytest

from pipeline.layout_plugins._placement import STRIP_Y_MIN, band_strip, strip_cell_side
from pipeline.layout_plugins.base import ColumnRoles, _schema_dir
from pipeline.layout_plugins.datetime_layout import (
    _INTERVAL_LADDER,
    DateTimeLayout,
    _floor_interval,
    _min_interval_sec,
    _sec_to_dt,
    _select_interval,
    _solve_bin_width,
)

UTC = _dt.timezone.utc
_DAY = 86400.0

# Baked cell coords are stored as FLOAT32 (`build_spatial_cells`), so an exact-line
# assertion cannot be tighter than float32 precision (~6e-8 near x=0.5, ~7e-9 near x=0.08).
#
# This is the SAME rule the refresh-manifest reproduction gate uses (T2-143 —
# `worker._positions_tol`): `min(1e-6, max(1e-4 * drawn_extent, 4 float32 ULPs))`, i.e. a
# fraction of the layout's OWN extent, floored at float32 noise and capped at 1e-6. An
# absolute 1e-6 goes blind on a layout that draws itself into a sliver of the box — a
# packed 1M histogram is 3.3e-3 wide on a 1.7e-6 column pitch, where 1e-6 is no longer
# small relative to anything the layout does.
#
# Below is that rule applied to the NARROWEST layout this file builds, so the constant is
# never looser than the rule for any of them. Re-measured after H2 (the whole point of that
# seam is that these layouts got WIDER, so the old figures are stale), by BBOX SPAN — which
# is what the rule takes, not the drawn extent, which is smaller by one cell and is the
# wrong quantity to feed it:
#
#     0.008500  n=100, ONE column   (`_meta([...]*100)` — the LEGACY branch, all cells share
#                                    an x, so the span IS the cell width; x carries no
#                                    information and no alignment assertion is made on it)
#     0.224923  n=801, 3 bins       (the narrowest MULTI-bin layout here — the year-clamp
#                                    fixture; no alignment assertion is made on it either)
#     0.909471  n=100, 3 bins       (the packed 100-over-11-weeks fixture: 0.0688 pre-H2)
#
# 1e-4 * 0.0085 = 8.5e-7, under the 1e-6 ceiling — so the rule's answer for this file is
# 8.5e-7, not the ceiling, and it is unchanged by H2 because the legacy branch is. What DID
# change is the residual: it is float32 storage at the layout's own scale, and H2 pushes the
# far bin out to x ~ 0.95, where a float32 ULP is 6.0e-8 rather than the 7.5e-9 it was at
# x ~ 0.09. Measured 4.05e-08 on the packed fixture (was 2.25e-09), i.e. 21x of headroom
# under this tolerance rather than 378x. That is why `test_range_precision_is_load_bearing`
# now states its headroom against a float32 ULP instead of against ALIGN_TOL/100.
ALIGN_TOL = min(1e-6, max(1e-4 * 0.0085, 4 * 2.0 ** -24))  # -> 8.5e-07


class _Atlas:
    """Minimal ThumbnailCache stand-in: the layout only reads `packed_ids`."""

    def __init__(self, n: int) -> None:
        self.ids = list(range(n))

    def packed_ids(self) -> list[int]:
        return self.ids


def _roles(fmt: str = "iso8601") -> ColumnRoles:
    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "File"},
            "datetime": {"column": "when", "label": "When", "format": fmt},
        }
    )


def _meta(values: list, column_type: pa.DataType = pa.timestamp("s")) -> pa.Table:
    n = len(values)
    return pa.table(
        {
            "id": pa.array(range(n), pa.int64()),
            "filename": pa.array([f"{i:04d}.png" for i in range(n)], pa.string()),
            "when": pa.array(values, column_type),
        }
    )


def _years(years: list[int]) -> list[_dt.datetime]:
    return [_dt.datetime(y, 1, 1) for y in years]


def _packed_100_over_11_weeks() -> list[_dt.datetime]:
    """THE packed-regime fixture: 100 photos over 11 weeks bucket into 3 MONTH columns,
    41 deep, so the deepest stack — not the band width — sets the pitch. Shared by every
    test that needs the regime H1 exists to fix."""
    return [_dt.datetime(2020, 1, 1) + _dt.timedelta(days=(77 * i) // 100) for i in range(100)]


def _compute(values: list, fmt: str = "iso8601", column_type: pa.DataType = pa.timestamp("s")):
    meta = _meta(values, column_type)
    return DateTimeLayout().compute(meta, _roles(fmt), _Atlas(len(values)), {})


def _cells_xy(result) -> list[tuple[int, float, float]]:
    tab = result.cells
    ids = [int(v) for v in tab.column("id").to_pylist()]
    xs = [float(v) for v in tab.column("x").to_pylist()]
    ys = [float(v) for v in tab.column("y").to_pylist()]
    return list(zip(ids, xs, ys))


def _consumer_x_of(axis: dict):
    """The frontend's inverse map, transcribed from `overlayLayer.ts`
    (`axisDomainToTimeDomain` + `domainToX`): domain ISO -> ms, linear onto `range`."""
    t_start = _dt.datetime.fromisoformat(axis["domain"][0]).timestamp() * 1000.0
    t_end = _dt.datetime.fromisoformat(axis["domain"][1]).timestamp() * 1000.0
    x_lo, x_hi = float(axis["range"][0]), float(axis["range"][1])
    slope = (t_end - t_start) / (x_hi - x_lo)
    intercept = t_start - slope * x_lo
    return lambda t_ms: (t_ms - intercept) / slope


def _ms(dt: _dt.datetime) -> float:
    return dt.replace(tzinfo=UTC).timestamp() * 1000.0


def _axis(result) -> dict:
    axes = result.annotations["axes"]
    assert len(axes) == 1, f"expected one axis, got {axes}"
    return axes[0]


# --- THE alignment contract (T2-138) ------------------------------------------------


def _t_of(axis: dict):
    """The FORWARD map x -> t(ms) (the consumer's inverse), for asking "what instant does
    this column sit on?"."""
    t_start = _dt.datetime.fromisoformat(axis["domain"][0]).timestamp() * 1000.0
    t_end = _dt.datetime.fromisoformat(axis["domain"][1]).timestamp() * 1000.0
    x_lo, x_hi = float(axis["range"][0]), float(axis["range"][1])
    slope = (t_end - t_start) / (x_hi - x_lo)
    intercept = t_start - slope * x_lo
    return lambda x: slope * x + intercept


def _cell_pitch_of(result, only=None) -> float:
    """`p_c` read off the BAKE from the ROW spacing alone: rows of a bar are exactly one cell
    pitch apart. Only valid on a fixture whose deepest bar has two rows — every caller here
    does. (`_assert_on_its_tick` uses a stricter version that also looks within a bin, so it
    still works on a one-row histogram.)"""
    ys = sorted({round(y, 12) for cid, _x, y in _cells_xy(result) if only is None or cid in only})
    gaps = [b - a for a, b in zip(ys, ys[1:]) if b - a > 1e-9]
    assert gaps, "the histogram is one row deep — no cell pitch is observable from it"
    return min(gaps)


def _assert_on_its_tick(result, tick_ms, label: str = "", only=None) -> float | None:
    """THE alignment identity, in H2's form, written down ONCE (D-36 §"The alignment
    invariant"): **each bin's BLOCK LEFT EDGE is where the emitted axis places that bin's
    start** — reconstructed the way the consumer does it (`axisDomainToTimeDomain` +
    `domainToX`), never by re-deriving the producer's formula. `tick_ms(cid)` gives the cell's
    bucket start in epoch ms; `only` restricts the check to a subset of ids (the undated ones
    are off the line entirely). Returns the observed `p_c`, or None where the layout is too
    small to show one. Tolerance `ALIGN_TOL`, unchanged.

    The left edge is read off the bake as `min(x of the bin's cells) - p_c/2`: column 0 is by
    construction the left-most cell of the block, and its centre sits half a pitch inside the
    edge. `p_c` likewise comes from the bake — adjacent ROWS of a bar and adjacent COLUMNS
    WITHIN one bin are exactly one cell pitch apart, and every inter-BIN gap is strictly
    larger (that is the gutter), so the tightest of those spacings IS `p_c`. Grouping by tick
    is what makes "within one bin" well defined here.

    WHY NOT THE LATTICE FORM. The first version of this helper recovered
    `col = round(off/p_c - 0.5)` and asserted `|off - (col+0.5)*p_c| < ALIGN_TOL`. That is a
    LATTICE test: any `x` on `tick + (m+0.5)*p_c` for ANY non-negative integer `m` satisfies
    it, so it is blind at exactly the offsets the gutter lives at. Measured (PR review,
    2026-07-28): inserting a WHOLE CELL PITCH to the left of every block left all three pure
    alignment pins GREEN, while a quarter-cell insert failed six of eight — the hole was
    precisely at integer multiples of `p_c`. D-36 permits this assertion to change from
    "column centre sits on the tick" to "the block's LEFT EDGE sits on the tick"; that is a
    statement about ONE distinguished cell per bin, not about a lattice, and this is it.

    The second assertion — that the bin's distinct x values are `left + (0, 1, ... , k-1 +
    0.5)*p_c` with no gaps — is what stops the left edge being satisfied by an outlier while
    the rest of the block floats.

    A layout with one row AND one image per bin shows no pitch at all. There the identity
    degenerates to "every cell sits the same positive distance right of its own tick, and
    that distance is under half the tightest tick spacing" — the second half is what keeps
    the degenerate arm from inheriting the lattice hole: a whole-cell insert makes the offset
    `1.5*p_c` against a tick spacing of at most `m*(1+g)*p_c`, so it is caught wherever two
    occupied bins are one interval apart."""
    prefix = f"{label}: " if label else ""
    cells = [c for c in _cells_xy(result) if only is None or c[0] in only]
    x_of = _consumer_x_of(_axis(result))
    ticks = {cid: x_of(tick_ms(cid)) for cid, _x, _y in cells}

    by_bin: dict[float, list[float]] = defaultdict(list)
    for cid, x, _y in cells:
        by_bin[round(ticks[cid], 9)].append(x)

    steps: list[float] = []
    ys = sorted({round(y, 12) for _cid, _x, y in cells})
    steps += [b - a for a, b in zip(ys, ys[1:]) if b - a > 1e-9]
    for xs in by_bin.values():
        col_xs = sorted({round(v, 12) for v in xs})
        steps += [b - a for a, b in zip(col_xs, col_xs[1:]) if b - a > 1e-9]
    p_c = min(steps) if steps else None

    if p_c is None:
        offsets = [x - ticks[cid] for cid, x, _y in cells]
        lo, hi = min(offsets), max(offsets)
        bins = sorted(by_bin)
        tick_gap = min((b - a for a, b in zip(bins, bins[1:])), default=float("inf"))
        assert lo > 0 and hi - lo < ALIGN_TOL, (
            f"{prefix}every bin holds one image, so every cell must sit the same positive "
            f"distance right of its own tick; offsets span [{lo!r}, {hi!r}]"
        )
        assert hi < 0.5 * tick_gap, (
            f"{prefix}each cell sits {hi!r} right of its own tick, which is more than half "
            f"the tightest tick spacing {tick_gap!r} — its block is a whole column or more "
            f"clear of the tick, i.e. something was INSERTED to the left of it"
        )
        return None

    for tick, xs in by_bin.items():
        col_xs = sorted({round(v, 12) for v in xs})
        left_edge = col_xs[0] - 0.5 * p_c
        assert abs(left_edge - tick) < ALIGN_TOL, (
            f"{prefix}the bin at tick {tick!r} draws its left-most column at {col_xs[0]!r}, "
            f"so its block's LEFT EDGE is {left_edge!r} — off its own tick by "
            f"{left_edge - tick!r}. The gutter must be residual (space left at the block's "
            f"RIGHT end), never inserted to its left."
        )
        for j, x in enumerate(col_xs):
            assert abs(x - (left_edge + (j + 0.5) * p_c)) < ALIGN_TOL, (
                f"{prefix}the bin at tick {tick!r} has a hole in its block: column {j} is "
                f"drawn at {x!r}, not at {left_edge + (j + 0.5) * p_c!r} (pitch {p_c!r})"
            )
    return p_c


def test_every_column_lands_on_its_bucket_tick() -> None:
    """THE drift-elimination proof, in the general form: for EVERY cell, the baked x is where
    the emitted axis places that cell's own CALENDAR BUCKET START, plus the cell's own offset
    inside its bin's block — whatever interval the producer chose. Pre-T2-138 cells sat at
    the centres of a sqrt(n) equal-TIME grid, which lands on arbitrary instants (rijks:
    ~4.2-yr buckets → a work dated 1637 drawn at ~1638.7), so this assertion fails
    catastrophically on the old code.

    THE ONE PERMITTED EDIT (D-36: "H2 is the only seam permitted to edit the assertion, and
    only its right-hand side"): the identity was "the column CENTRE sits on the tick" and is
    now "the block's LEFT EDGE sits on the tick" — where a histogram bar's boundary belongs
    once a bin is `k` images wide. The tolerance is untouched; `_assert_on_its_tick` holds
    the new right-hand side, and every other alignment pin in this file routes through it so
    the identity exists in exactly one place.

    The interval is read back from the production selector: the claim under test is the
    CONSISTENCY of placement with the emitted axis, not which rung got picked (that is
    pinned separately by the year/month/day selection tests below)."""
    values = _years([1600, 1637, 1637, 1700, 1800, 1900, 2020])
    result = _compute(values)

    secs = [v.replace(tzinfo=UTC).timestamp() for v in values]
    kind, step, _avg = _select_interval(max(secs) - min(secs), len(values))

    def tick_ms(cid: int) -> float:
        return _floor_interval(_sec_to_dt(secs[cid]), kind, step).timestamp() * 1000.0

    assert _assert_on_its_tick(result, tick_ms) is not None, (
        "the fixture must be deep enough to expose the cell pitch (the 1600 bucket holds two)"
    )
    # ...and the bucket starts are ALIGNED to the rung's own calendar grid. This checks the
    # DERIVED bucket year (`year - year % step`), not the midnight H/M/S fields `_floor_interval`
    # CONSTRUCTS for a year rung (those are 0 unconditionally — the assertion that used to be
    # here could never fail), so a wrong-modulo flooring bug fails it. This fixture selects a
    # year rung; the general per-cell alignment identity is `_assert_on_its_tick` above.
    assert kind == "year", f"fixture expected a year rung, got {step} {kind!r}"
    starts = [_floor_interval(_sec_to_dt(s), kind, step) for s in secs]
    assert all(st.year % step == 0 or st.year == 1 for st in starts), (
        "year buckets must align to the step grid (or the year-1 clamp)"
    )


def test_same_bucket_shares_one_column_and_stacks() -> None:
    """Cells in the same time bucket occupy ONE column and stack vertically; a later bucket
    gets its own column."""
    years = [1637, 1637, 1900]
    result = _compute(_years(years))
    cells = _cells_xy(result)
    x_by_id = {cid: x for cid, x, _ in cells}
    y_by_id = {cid: y for cid, _, y in cells}
    assert x_by_id[0] == pytest.approx(x_by_id[1]), "same-bucket cells share a column"
    assert x_by_id[0] != pytest.approx(x_by_id[2]), "a later bucket gets its own column"
    assert y_by_id[0] != pytest.approx(y_by_id[1]), "and they stack"


def test_year_precision_data_lands_on_year_ticks() -> None:
    """The operator's exact complaint, pinned: a work dated 1637 must be drawn ON the 1637
    tick. (Pre-T2-138 rijks bucketed ~4.2 yr wide and placed cells at bucket CENTRES, so
    1637 drew at ~1638.7, 2017 at ~2016, 1929 past 1930.)"""
    years = [1600 + (i % 300) for i in range(4000)]  # 300 yr span, dense -> YEAR buckets
    result = _compute(_years(years))
    _assert_on_its_tick(result, lambda cid: _ms(_dt.datetime(years[cid], 1, 1)))


def test_uniform_multi_century_span_buckets_by_year() -> None:
    """A corpus dense enough to earn the finest rung over a multi-century span picks YEAR
    buckets: the first bin's block starts at the margin, one bin per distinct year, and every
    cell lands on its year tick — the operator's stated ideal.

    NOT rijks-shaped, despite what this test was called before the PR-189 review: the
    fixture is UNIFORM (16 per year, S/I = 0.064), which is why the WIDTH term binds and the
    blocks fill the band. Real rijks_pilot clusters onto round years — measured S/I = 1.30,
    so it is STACK-bound. `test_clustered_years_are_stack_bound` below is the shape the live
    dataset actually has.

    H2 moved `range[1]` off 0.96: the LINE ends at the LAST BIN'S TICK, and that bin's block
    then extends `k*p_c` to its right, so it is the block EDGE — not the tick — that reaches
    `1-margin`. `test_width_bound_case_fills_the_band_to_the_block_edge` owns that identity."""
    years = [1700 + (i % 250) for i in range(4000)]  # 250 yr span, n=4000 (budget 317 >= 250)
    result = _compute(_years(years))
    axis = _axis(result)

    assert axis["range"] == [0.04, 0.957055581], "the last bin's TICK, one block short of 0.96"
    assert axis["domain"][0].startswith("1700-01-01"), axis["domain"]
    xs = sorted({x for _, x, _ in _cells_xy(result)})
    assert len(xs) == len(set(years)), "one column per distinct YEAR (k = 1 here)"
    p_c = _assert_on_its_tick(result, lambda cid: _ms(_dt.datetime(years[cid], 1, 1)))
    assert p_c is not None
    assert min(xs) == pytest.approx(0.04 + 0.5 * p_c, abs=ALIGN_TOL), (
        "the first bin's block starts at the margin, so its single column sits half a cell in"
    )


def test_clustered_years_are_stack_bound() -> None:
    """The shape the DEMO-LEAD dataset actually has, which the suite had no cover for: a
    multi-century year-rung corpus that CLUSTERS (museum works pile onto round years), so the
    deepest stack — not the band — sets the pitch and the line stops short of `1-margin`.

    Every bin must still land on its own year tick: the alignment invariant is what H1/H2
    must not break, and it is the stack-bound branch where `range` is no longer a constant."""
    years = [1700 + (i % 250 // 25) * 25 for i in range(4000)]  # 10 quarter-century piles
    years += [1700 + (i % 250) for i in range(400)]             # a thin spread underneath
    result = _compute(_years(years))
    axis = _axis(result)
    # The block edge reaches 0.96 only where the WIDTH term binds; here the deepest bar does,
    # so the line stops well short of it even after the trailing block is added — it draws
    # 74.62 % of the box. Since H5 (D-36 §7.5) the leftover is SPLIT rather than all left at
    # the right end, so `range[0]` is no longer `margin` either: the line moved right by
    # `slack/2` = 0.086919 (pre-H5 this read `[0.04, 0.783774279]`).
    #
    # BOTH ends are asserted, because post-H5 the pair is the claim: a literal on the upper end
    # alone would pass a bake that shifted `x_hi` and left `x_lo` behind — the two-descriptions
    # -of-one-line defect T2-138 was. `test_the_axis_moves_with_the_centred_placement` is the
    # general form; this is the captured-literal corroboration on the same regime.
    assert axis["range"] == [0.126918831, 0.87069311], (
        f"a clustered corpus is stack-bound AND centred, got {axis['range']}"
    )
    _assert_on_its_tick(
        result, lambda cid: _ms(_dt.datetime(years[cid], 1, 1)), "STACK-BOUND regime"
    )


def test_short_span_buckets_by_month() -> None:
    """The operator's own example — "a dataset over only 1-3 years is better bucketed by
    month": 100 images over 2 years bucket per MONTH (24 columns), not per year (2) and not
    per day (730 near-empty), and every column lands on a month boundary."""
    values = [_dt.datetime(2020, 1, 1) + _dt.timedelta(days=7 * i) for i in range(100)]
    result = _compute(values)
    xs = sorted({x for _, x, _ in _cells_xy(result)})
    assert 12 <= len(xs) <= 30, f"a ~2-yr span buckets by month (got {len(xs)} columns)"
    _assert_on_its_tick(
        result,
        lambda cid: _ms(_dt.datetime(values[cid].year, values[cid].month, 1)),
        "bins land on month boundaries",
    )


def test_small_dated_set_still_resolves_per_day() -> None:
    """A handful of photos over a handful of days must still get ONE COLUMN PER DAY and a
    real axis — the relaxed sqrt budget must not collapse a small set into a single bucket
    (which would decline the axis entirely)."""
    values = [_dt.datetime(2021, 1, 1) + _dt.timedelta(days=i) for i in range(10)]
    result = _compute(values)
    xs = sorted({x for _, x, _ in _cells_xy(result)})
    assert len(xs) == 10, f"one column per day (got {len(xs)})"
    # One image per bin AND one row, so no cell pitch is observable — `_assert_on_its_tick`
    # falls back to its degenerate form (every cell the same positive distance right of its
    # own tick), which is the identity with `col = 0`.
    assert _assert_on_its_tick(result, lambda cid: _ms(values[cid])) is None


def test_stacks_are_shorter_than_the_sqrt_grid() -> None:
    """Calendar bucketing spreads a broad-span corpus over MANY more columns than the old
    ceil(sqrt(n)) grid, so the tallest stack shrinks (the T2-117 niceness, for free).

    The shrink is much smaller on real data than on this UNIFORM fixture, because real dates
    clump: measured on live rijks_pilot the deepest stack drops 1643 -> 1199, not to the
    ~n/columns this fixture shows (an earlier version of this docstring claimed ~175, a ~7x
    underestimate — that is what made rijks look columns-bind when it is stack-bound)."""
    import math

    n = 4000
    years = [1700 + (i % 250) for i in range(n)]
    result = _compute(_years(years))
    xs = [x for _, x, _ in _cells_xy(result)]
    ncols = len(set(xs))
    assert ncols == 250, "one column per year"
    assert ncols > math.ceil(math.sqrt(n)), "far more columns than the old sqrt(n) grid"
    tallest = max(xs.count(x) for x in set(xs))
    assert tallest == 16, f"n/ncols == 16 per column here (got {tallest})"


# --- H1/H2 (D-36): the cell pitch sets the geometry, and a bin is `k` images wide ----


def _month_tick(values: list) -> "callable":
    """`tick_ms` for a month-rung fixture: the cell's own month boundary."""
    return lambda cid: _ms(_dt.datetime(values[cid].year, values[cid].month, 1))


def test_broad_span_stays_one_wide_and_loses_its_vertical_holes() -> None:
    """H2 acceptance #1 — a BROAD, shallow corpus resolves to `k = 1` (one image per bin,
    exactly as before), keeps one bin per year, keeps a cell size close to H1's, and now
    draws a SHORT bar block instead of a full-height one.

    That last part is the whitespace going away. Pre-H2 the row pitch was `box_h/S`, so a
    16-deep histogram was stretched to fill the box vertically and every stacked pair had
    ~6.5 cell-widths of air between them; the bbox was 0.903 tall for 16 images. Now the row
    pitch IS the cell pitch, so the block is `S_eff * p_c` tall and the bar reads as a solid
    bar. Measured on this fixture: bbox height 0.903 -> 0.0467, aspect (h/w) 0.978 -> 0.051.

    Replaces `test_columns_bind_case_reduces_term_for_term` (itself the replacement for
    `test_columns_bind_case_bakes_byte_identically`). That test pinned "the columns-bind
    branch reduces to the pre-H1 line term for term", which H2 deliberately breaks: the
    gutter is spent at EVERY bin boundary including `k = 1`, so a width-bound bake now fits
    `(1+g)` cell pitches per interval instead of 1 and the cell is `1/(1+g)` = 80 % of its
    pre-H2 size. Not "the bytes must not move" — that was never a requirement (operator,
    2026-07-27); existing datasets are re-baked.

    SCOPE, stated honestly: 4000 works UNIFORMLY spread over 250 years, 16 deep. Measured on
    the live datasets, both are STACK-bound (rijks_pilot S/I = 1.30, nasa 2.23), so this is
    NOT the shape a real corpus has; `test_wrapping_fills_a_packed_bin` is."""
    years = [1700 + (i % 250) for i in range(4000)]
    result = _compute(_years(years))

    assert result.annotations == {
        "axes": [
            {
                "orientation": "x",
                "scale": "time",
                "domain": ["1700-01-01T00:00:00+00:00", "1949-01-01T00:00:00+00:00"],
                "range": [0.04, 0.957055581],
                # v2.7 (H3 / D-36): 249 years against a 5*sqrt(4000) = 317-column budget
                # resolves to the per-YEAR rung, which is also what `len(xs) == 250` below
                # says — this whole-dict assertion is where the two meet.
                "interval": {"kind": "year", "step": 1},
                "label": "When",
            }
        ]
    }
    xs = sorted({x for _, x, _ in _cells_xy(result)})
    ys = sorted({y for _, _, y in _cells_xy(result)})
    assert len(xs) == 250, "k = 1: one column per distinct YEAR, as before"
    assert len(ys) == 16, "...and 16 rows, one per image in the deepest bar"
    p_c = 0.0029444089
    assert result.cells.column("w").to_pylist()[0] == 0.0025027566589415073, (
        "pre-H2 0.0031405755 — the gutter costs 1/(1+g) = 80 % of the cell, at every boundary"
    )
    # THE VERTICAL HOLES: the rows are ONE CELL PITCH apart, so the bar is `S_eff*p_c` tall
    # rather than filling the box. Pre-H2 this gap was `STRIP_Y_MIN/16` = 0.06 — 20x the cell
    # side, i.e. 95 % air between two stacked images. (abs=1e-7 throughout for float32 cell
    # storage: these coordinates reach x,y ~ 0.96, where one ULP is 6.0e-08.)
    assert ys[1] - ys[0] == pytest.approx(p_c, abs=1e-7), "rows are ONE cell pitch apart"
    # 1700 -> 1701 is a NON-leap year, i.e. exactly `min_int`, so this gap is the rung's
    # tightest and is `(1 + g)` cell pitches exactly.
    assert xs[1] - xs[0] == pytest.approx(1.25 * p_c, abs=1e-7), (
        "the TICK pitch is (1 + g) cells — the gutter, spent at a k = 1 boundary too"
    )
    bbox = result.bbox
    height = bbox[3] - bbox[1]
    assert height == pytest.approx(16 * p_c, abs=1e-3), "bbox height ~ S_eff * p_c, not ~1.0"
    assert height < 0.05, f"pre-H2 this was 0.903 — the vertical whitespace is gone ({height})"


def test_wrapping_fills_a_packed_bin() -> None:
    """H2 acceptance #3 — THE fix (D-36 §"The geometry"): 100 photos over 11 weeks bucket
    into 3 months, 41 deep. Pre-H1 those three bins were PINNED to the band ends — three
    hairlines with ~95 % air between them. H1 packed them one cell pitch apart, which fixed
    the gaps but left a 3-wide, 41-tall ribbon: bbox 0.0661 x 0.9565, aspect 14.5:1, wasting
    the viewport at every zoom. H2 makes each bin `k` images WIDE and wraps its cells
    row-major, trading stack depth for width at a constant cell count.

    Literals captured from the post-change bake; the PRE-H2 values they replace are quoted
    in the assertion messages."""
    values = _packed_100_over_11_weeks()
    result = _compute(values)
    cells = _cells_xy(result)

    by_bin: dict[float, list[float]] = defaultdict(list)
    for cid, x, _y in cells:
        by_bin[_ms(_dt.datetime(values[cid].year, values[cid].month, 1))].append(x)
    assert len(by_bin) == 3, "11 weeks buckets into 3 MONTH bins"
    widths = {len({round(x, 9) for x in xs}) for xs in by_bin.values()}
    assert widths == {4}, f"every bin is exactly k = 4 images wide, got {widths}"

    rows = len({y for _, _, y in cells})
    assert rows == 11, "41 deep / k=4 -> ceil(41/4) = 11 rows (pre-H2: 41)"
    ys = sorted({y for _, _, y in cells})
    p_c = ys[1] - ys[0]
    assert p_c == pytest.approx(0.070190727, abs=1e-9), (
        "the cell pitch, materially larger than H1's STRIP_Y_MIN/41 = 0.023415 (3.0x)"
    )
    assert result.cells.column("w").to_pylist()[0] == 0.05966212600469589, (
        "pre-H2 the side was 0.019902439787983894"
    )

    axis = _axis(result)
    assert axis["range"] == [0.04, 0.679237057], "pre-H1 [0.04, 0.96]; pre-H2 [0.04, 0.086157105]"
    # ...and the LAST bin's block reaches the band end, which is where the missing width went.
    assert axis["range"][1] + 4 * p_c == pytest.approx(0.96, abs=1e-6)
    bbox = result.bbox
    assert (bbox[3] - bbox[1]) / (bbox[2] - bbox[0]) == pytest.approx(0.837, abs=1e-3), (
        "pre-H2 this ribbon was 14.5:1 tall"
    )


def test_alignment_survives_the_pack_tight_case() -> None:
    """The T2-138 invariant, re-asserted on the geometry H1/H2 change: with `range` no longer
    [margin, 1-margin] AND the bins now `k` cells wide, the emitted axis must STILL be
    exactly the placement line — every cell's baked x is where the axis puts that cell's own
    bucket start plus the cell's own within-block offset, reconstructed the way the consumer
    does it (never by re-deriving the producer's formula).

    This is H2 acceptance #5 on the packed shape: it is the wrapped case (`k = 4`), so
    `_assert_on_its_tick` is exercising the `col > 0` arm, not just the degenerate one."""
    values = _packed_100_over_11_weeks()
    result = _compute(values)
    axis = _axis(result)
    assert axis["range"][1] < 0.96, "the fixture must exercise the PACKED regime"
    p_c = _assert_on_its_tick(result, _month_tick(values), "packed regime")
    assert p_c is not None
    # ...and the fixture really is wrapped, so the helper exercised its multi-column arm and
    # not just the one-column-per-bin degenerate case. Counted off the BAKE (distinct x per
    # bin), never by re-deriving `col` from an offset — that rounding was the lattice hole.
    by_bin: dict[float, set[float]] = defaultdict(set)
    for cid, x, _y in _cells_xy(result):
        by_bin[_month_tick(values)(cid)].add(round(x, 9))
    assert {len(v) for v in by_bin.values()} == {4}, (
        f"the fixture must WRAP for this to test H2, got {[len(v) for v in by_bin.values()]}"
    )


def test_adjacent_columns_never_overlap() -> None:
    """H1 makes the drawn side `fill * pitch` in the stack-bound regime, but `pitch` is one
    AVERAGE interval and adjacent columns sit a REAL interval apart. Where the real/average
    ratio falls below `fill` the squares would overlap.

    `_floor_interval`'s `max(1, dt.year - dt.year % step)` clamp is the reachable case: on
    the 2-year rung, year 1 and year 2 land one year apart against a two-year average
    (0.4997). Pre-H1 this was harmless — `side` took the strictly smaller `row_h`, giving
    2.90 cell-widths of clearance; H1 sets `pitch == row_h` and ate that slack, and the
    unfixed plugin bakes these two 400-deep stacks OVERLAPPING by 41 % of a cell.

    The year anchor itself is NOT the fix: the renderer's tick ladder is
    `Math.ceil(yLo / step) * step` (multiples of the step, anchored at year 0), so
    re-anchoring the producer at year 1 would break the T2-138 lock-step this whole
    decision exists to protect. Capping `side` by the measured tightest spacing is.

    H2 ADDS A SHARPER FAILURE ON THE SAME CLAMP, and the last fixture below is the one that
    reaches it. `_solve_bin_width`'s `gap_sec` filter refuses a `k` whose `k`-wide block would
    not fit the tightest REAL bin spacing. Without it the solve happily picks `k = 3` on a
    clamped 2-year rung, where the tightest spacing is 0.5 of `min_int`: `min_col_gap =
    k_time*gap_sec - (k-1)*p_c` then goes NEGATIVE, `side` follows it negative, and
    `build_spatial_cells`'s `_clamp01` turns the whole layout into ZERO-WIDTH cells. Measured
    with the filter disabled: `side = 0.0` on `[1]*900 + [2]*3 + [200]*3`. The first three
    fixtures resolve to `k <= 2` and pass either way — this test had no cover for the filter
    until that fixture was added (PR review, 2026-07-28)."""
    for label, values in (
        ("year rung, step 2, 1st-century dates", _years([1] * 400 + [3] * 400 + [150])),
        ("year rung, step 5", _years([1] * 200 + [6] * 200 + [400])),
        ("month rung across a non-leap February", [
            _dt.datetime(2021, m, 1) + _dt.timedelta(days=d)
            for m in (1, 2, 3) for d in range(40) if _dt.datetime(2021, m, 1).month == m
        ][:90] + [_dt.datetime(2021, 2, 1)] * 60),
        ("the packed month fixture", _packed_100_over_11_weeks()),
        # The `gap_sec` filter's own fixture: deep enough that the UNFILTERED solve reaches
        # k = 3 on the clamped 2-year rung (900 in one bin against 3 + 3), which is where the
        # block runs past its neighbour's tick.
        ("year rung, step 2, deep enough to want k >= 3", _years([1] * 900 + [2] * 3 + [200] * 3)),
    ):
        result = _compute(values)
        xs = sorted({x for _, x, _ in _cells_xy(result)})
        side = float(result.cells.column("w").to_pylist()[0])
        assert side > 0.0, (
            f"{label}: the layout baked ZERO-WIDTH cells — `side` went negative and "
            "`_clamp01` hid it (the `gap_sec` filter is what stops the solve choosing a `k` "
            "whose block does not fit the tightest real bin spacing)"
        )
        gaps = [b - a for a, b in zip(xs, xs[1:])]
        if not gaps:
            continue
        assert min(gaps) >= side - 1e-12, (
            f"{label}: adjacent columns are {min(gaps)!r} apart but each square is {side!r} "
            f"wide — they overlap by {100 * (1 - min(gaps) / side):.1f} % of a cell"
        )


def test_range_precision_is_load_bearing() -> None:
    """`range` is emitted at 9 dp, not the 6 dp `bbox` uses, because the consumer rebuilds
    the placement line FROM these two numbers — so their rounding lands directly in the
    alignment residual. Pin the PROPERTY rather than a captured literal: re-round the emitted
    axis to 6 dp and the residual must blow up by orders of magnitude.

    Without this, a revert to 6 dp trips only an unrelated captured `range` literal in
    `test_deep_stacks_pack_the_columns_tight` — the kind of value a re-bake is expected to
    update, so the precision decision would be silently reversible.

    U1 NOTE — this test used to compare THIS FIXTURE's 6-dp re-rounding against its 9-dp
    residual (`at_6dp > 50 * at_9dp`), and that comparison was luck, not a margin: the 9-dp
    residual is float32 cell storage (essentially fixed) while the 6-dp one is whatever the
    bake's 7th-9th digits happen to be, anywhere in [0, 5e-7]. Measured, the decision did not
    change but the ratio did — pre-U1 `range[1]` 0.088080318 gave at_9dp 3.78e-09 / at_6dp
    3.17e-07 / ratio 83.8; post-U1 0.086157105 gives 2.25e-09 / 1.06e-07 / ratio 47.1. It
    also degenerates to `0 > 0` on any fixture whose `range[1]` is already exact at 6 dp.

    A worst-case variant (shift `range[1]` by 5e-7 and require the residual to exceed
    ALIGN_TOL/4) was tried and REMOVED as a tautology: the far bin sits exactly at
    `range[1]`, so shifting `range[1]` by delta moves the map by delta there BY
    CONSTRUCTION. It passed on the shipped code (4.991e-07), on `range` emitted at 2 dp
    (3.843e-03), and on a `range` fully decoupled from the placement (`x_hi + 1e-3` ->
    1.000e-03) — including the last case, which is the exact condition its failure message
    claimed to detect.

    H2 NOTE — the headroom is stated against a FLOAT32 ULP at the layout's own scale, not
    against `ALIGN_TOL/100`. H2 widened this bake from x <= 0.096 to x <= 0.955, and a float32
    ULP grows with the value: 7.5e-09 at 0.09, 6.0e-08 at 0.95. The old `ALIGN_TOL/100` =
    8.5e-09 threshold is now BELOW the storage floor and would fail on a CORRECT bake. What
    the test still asserts is the thing that matters and is still deterministic: the emitted
    `range` must not be the dominant error term — float32 cell storage must be.

    Measured on this fixture, which is what makes the one remaining threshold a real gate
    rather than a slogan: residual 4.05e-08 at 9 dp against 9.75e-08 at 6 dp, on a float32
    ULP of 5.5129e-08 at the layout's largest x. The 9-dp emit sits UNDER the ULP and the
    6-dp emit sits OVER it, so `at_9dp < ulp` is itself the revert-detector — mutation-proven,
    not asserted. (The residual exceeds a bare half-ULP because reconstructing the block
    offset multiplies the observed pitch by up to k-0.5; that is part of what a consumer
    would do too.)

    The 6-dp/9-dp RATIO is deliberately not asserted: at 2.4x here against 47x pre-U1 it is
    fixture luck, exactly as the U1 note below already says — the 9-dp residual is a storage
    floor while the 6-dp one is wherever the bake's 7th-9th digits happen to fall in
    [0, 5e-07]."""
    values = _packed_100_over_11_weeks()
    result = _compute(values)
    axis = _axis(result)
    assert axis["range"][1] < 0.96, "the fixture must exercise the PACKED regime"

    def worst_residual(ax: dict) -> float:
        x_of = _consumer_x_of(ax)
        pitch = _cell_pitch_of(result)
        worst = 0.0
        for cid, x, _y in _cells_xy(result):
            off = x - x_of(_ms(_dt.datetime(values[cid].year, values[cid].month, 1)))
            worst = max(worst, abs(off - (round(off / pitch - 0.5) + 0.5) * pitch))
        return worst

    # THE revert-detector: emit `round(x, 6)` and this residual BECOMES the 6-dp error.
    at_9dp = worst_residual(axis)
    ulp = 2.0 ** -24 * max(x for _cid, x, _y in _cells_xy(result))
    assert at_9dp < ulp, (
        f"the emitted `range` must leave float32 cell storage as the dominant error term, "
        f"got {at_9dp!r} against one ULP {ulp!r} — a 6-dp emit makes this 9.75e-08 here"
    )
    # ...and the digits it was emitted with, stated directly, so the decision cannot be
    # reversed by a rounding that happens to land kindly on this fixture.
    assert [round(v, 6) for v in axis["range"]] != axis["range"], (
        f"`range` {axis['range']} carries no digit past the 6th — either the producer "
        "reverted to 6 dp, or this fixture stopped exercising the decision and must be "
        "re-picked (a bake whose `range[1]` is exact at 6 dp cannot exercise it)"
    )


def test_width_bound_case_fills_the_band_to_the_block_edge() -> None:
    """The band-filling claim as a PROPERTY over many shapes, not one fixture and one digest:
    wherever the WIDTH term binds AND the last bin is FULL (so the ink already fills the band),
    the blocks exactly fill `[margin, 1-margin]` — not the LINE, which now stops one block
    short of it.

    This is the H2 restatement of `test_columns_bind_reduces_to_the_pre_h1_line`. That test
    asserted `range == [0.04, 0.96]`, which was the pre-H1 identity preserved through H1 and
    which H2 deliberately breaks in TWO ways: the last bin's block sits to the RIGHT of
    `range[1]`, and the gutter is spent at every boundary so the per-interval allowance is
    `(1+g)` cell pitches rather than 1. What survives — and is the real content — is that a
    band-filling bake wastes no horizontal space: `range[1] + k*p_c == 1 - margin` exactly.

    NOT universal since H5 (D-36 §7.5): a width-bound bake whose LAST bin holds fewer than `k`
    images does not fill the trailing block the width bound budgeted for, so it is genuinely
    narrow, H5 CENTRES it, and `range[1] + min(N_last, k)*p_c == 1 - margin - x_offset`, short
    of `1 - margin`. Every fixture below is UNIFORM (each bucket equally populated) so its last
    bin is full and `x_offset == 0` — that is what keeps the `== 0.96` assertion exact here. The
    sparse-last-bin width-bound regime, which DOES move, is not exercised by any fixture — its
    positive coverage is tracked as [[T2-177]].

    Every live 2.5 dataset on disk was baked in the pre-H1 branch, so the shapes are kept."""
    shapes = [
        _years([1700 + (i % span) for i in range(n)])
        for span, n in ((250, 4000), (300, 4000), (120, 2000), (60, 900), (40, 400))
    ]
    # ...and one on a sub-year rung, so the property is not a year-rung artefact: 2000
    # photos one per day over 2000 days -> ~66 month bins, ~31 deep.
    shapes.append([_dt.datetime(2015, 1, 1) + _dt.timedelta(days=i) for i in range(2000)])
    for values in shapes:
        result = _compute(values)
        cells = _cells_xy(result)
        rows = len({y for _, _, y in cells})
        columns = len({x for _, x, _ in cells})
        assert rows <= columns, (
            f"fixture is not wider-than-deep ({columns} columns, {rows} rows) — it does not "
            "exercise the width-bound branch this test exists for"
        )
        p_c = _cell_pitch_of(result)
        x_hi = _axis(result)["range"][1]
        assert x_hi < 0.96, "the LINE stops short: the last bin's block sits right of it"
        # k is observable: the last block's own right edge, in whole pitches past `range[1]`.
        k = round((max(x for _, x, _ in cells) + 0.5 * p_c - x_hi) / p_c)
        assert x_hi + k * p_c == pytest.approx(0.96, abs=1e-6), (
            f"a wider-than-deep corpus must still fill the band to the last BLOCK EDGE, got "
            f"{x_hi!r} + {k} x {p_c!r}"
        )
    # The inverse, so the assertion above cannot pass vacuously: a deeper-than-wide corpus
    # must NOT reach the band end.
    result = _compute(
        _years([1700 + (i % 250 // 25) * 25 for i in range(4000)] + [1700 + (i % 250) for i in range(400)])
    )
    p_c = _cell_pitch_of(result)
    x_hi = _axis(result)["range"][1]
    k = round((max(x for _, x, _ in _cells_xy(result)) + 0.5 * p_c - x_hi) / p_c)
    assert x_hi + k * p_c < 0.9, (
        f"the stack-bound control must fall short of the band, got {x_hi + k * p_c!r}"
    )


def _bin_gap_in_cells(result, tick_ms) -> float:
    """The gap between two ADJACENT BINS' nearest drawn edges, measured in CELL WIDTHS: the
    quantity `_BIN_GUTTER_CELLS` exists to control. Scaling by the cell makes it comparable
    across bakes whose absolute cell size differs (raising the gutter also shrinks `p_c`
    wherever the width term binds, so an absolute gap is the wrong yardstick)."""
    side = float(result.cells.column("w").to_pylist()[0])
    by_bin: dict[float, list[float]] = defaultdict(list)
    for cid, x, _y in _cells_xy(result):
        by_bin[round(tick_ms(cid), 3)].append(x)
    edges = sorted((min(xs), max(xs)) for xs in by_bin.values())
    gaps = [(b[0] - side / 2) - (a[1] + side / 2) for a, b in zip(edges, edges[1:])]
    assert gaps, "the fixture must have at least two occupied bins"
    return min(gaps) / side


def test_the_bin_gutter_is_a_live_constant() -> None:
    """H2 acceptance #2 — `_BIN_GUTTER_CELLS` is a REAL module constant the solve reads, not
    a number inlined at one call site, and it is spent at EVERY bin boundary INCLUDING k = 1.

    This is the "we can always tune it" guarantee (D-36 §7.1: a half-cell gutter is the
    operator's fallback if a full one looks wasteful against real thumbnails, and that must
    be a one-line edit rather than a re-derivation). Every other test here would pass just as
    happily with 0.25 hard-coded inside `_solve_bin_width` and the `k_time` expression
    disagreeing with it, so this is the only thing standing between the constant and decay.

    Measured on both arms, because the gutter's job differs between them: at k = 1 it is the
    ONLY separation a bin boundary gets beyond `fill`'s 15 %, and at k > 1 it has to stay
    distinguishable from the within-bin gaps or the block reads as one slab. The predicted
    ratio is exact and scale-free — between-bin `(1 - fill + g)/fill` cell widths against
    within-bin `(1 - fill)/fill` — but ONLY where the two nearest bins sit exactly the rung's
    SHORTEST interval apart, so both fixtures are chosen to arrange that: consecutive
    non-leap years on the year rung (365 d == `min_int`), and a non-leap February on the
    month rung (28 d == `min_int`). A leap year or a 31-day month would put the bins further
    apart than `min_int` and widen the gap beyond the prediction — correctly, but the
    prediction would then need the real interval in it and stop being a clean pin."""
    k1_years = [1700 + (i % 250) for i in range(4000)]
    wrapped_values = [
        _dt.datetime(2021, m, 1) + _dt.timedelta(days=d) for m in (1, 2, 3) for d in range(40)
    ][:90] + [_dt.datetime(2021, 2, 1)] * 60

    def measure(gutter: float) -> tuple[float, float]:
        import pipeline.layout_plugins.datetime_layout as mod

        old = mod._BIN_GUTTER_CELLS
        try:
            mod._BIN_GUTTER_CELLS = gutter
            k1 = _bin_gap_in_cells(
                _compute(_years(k1_years)), lambda cid: _ms(_dt.datetime(k1_years[cid], 1, 1))
            )
            wrapped = _compute(wrapped_values)
            return k1, _bin_gap_in_cells(wrapped, _month_tick(wrapped_values))
        finally:
            mod._BIN_GUTTER_CELLS = old

    at_default = measure(0.25)
    at_double = measure(0.75)
    for arm, i in (("k = 1", 0), ("wrapped", 1)):
        assert at_double[i] > at_default[i] + 0.4, (
            f"{arm}: raising `_BIN_GUTTER_CELLS` 0.25 -> 0.75 must visibly widen the "
            f"between-bin gap, got {at_default[i]!r} -> {at_double[i]!r} cell widths"
        )
    # The exact prediction, so a solve that reads the constant in ONE of its two places (the
    # `k` search but not `k_time`, or vice versa) cannot pass by moving the gap a little.
    # Tolerance 5e-4, not 1e-6: the gap is a difference of FLOAT32 cell coordinates divided by
    # a small cell side, so the storage noise is amplified — 6.0e-08 at x ~ 0.95 over a
    # 0.0025-wide cell is 2.4e-05, and the year-rung arm measures 0.470577 against 0.470588.
    for g, observed in ((0.25, at_default), (0.75, at_double)):
        for arm, value in zip(("k = 1", "wrapped"), observed):
            assert value == pytest.approx((1 - 0.85 + g) / 0.85, abs=5e-4), (
                f"{arm} at g={g}: the between-bin gap must be exactly (1-fill+g)/fill cell "
                f"widths, got {value!r}"
            )
    # ...and the within-bin gap must NOT move with it — the gutter is EXTRA space at bin
    # boundaries, not a global re-spacing (D-36: "there are TWO sources of space").
    result = _compute(wrapped_values)
    side = float(result.cells.column("w").to_pylist()[0])
    assert len({round(x, 9) for _cid, x, _y in _cells_xy(result)}) > 3, (
        "the wrapped arm must actually wrap (3 bins, more than 3 columns)"
    )
    within = (_cell_pitch_of(result) - side) / side
    assert within == pytest.approx((1 - 0.85) / 0.85, abs=5e-4)
    assert at_default[1] > 2.5 * within, (
        f"a bin boundary must not look like the gap between two images of one bin: "
        f"{at_default[1]!r} vs {within!r} cell widths"
    )


def test_the_bin_width_solve_breaks_ties_to_the_smaller_k() -> None:
    """`_solve_bin_width` returns the SMALLER `k` when two widths give the same cell pitch
    (D-36 §"The geometry": "choose the k maximising p_c; tie-break to the smaller k") — fewer,
    taller bars read as a histogram more readily than wider, shorter ones at equal cell size.

    A CONTRACT PIN ON THE HELPER, not a bake property, and the distinction is the point. The
    tie needs the HEIGHT term at one `k` to land exactly on the WIDTH term at the next, which
    is a coincidence between an integer-quantised value (`box_h/ceil(N/k)`) and a continuous
    one. Measured by exhaustive scan at the production `usable`/`box_h` over 12,060 sampled
    (bin population, intervals-spanned) pairs — N in [2, 600) plus five larger, 20 interval
    counts — **28 tie**, e.g. N = 180 over exactly 3 shortest-intervals, where k = 6 is
    height-bound at 0.96/30 and k = 7 is width-bound at 0.92/28.75, both 0.032. None of the 28
    is reachable from a real corpus, because `_select_interval` couples the intervals spanned
    to the image count: the N=180/I=3.0 tie would need the YEAR rung over 3 non-leap years,
    which `_bucket_budget` only allows below n = 52. So the pin is on the function, called
    with the production band and box, rather than on a fixture that cannot exist.

    Without it the tie-break is free: flipping `p_c > best_p` to `>=` fails nothing else in
    the suite (measured).

    `box_h` is READ FROM `STRIP_Y_MIN`, not written as 0.96: with the literal, this test kept
    passing when the shipped constant moved, while the production tie it claims to guard no
    longer existed — a pin that survives a change to the constant it is pinned to is pinning
    nothing (PR-198 review)."""
    tie = _solve_bin_width([180], denom=3.0, min_int=1.0, gap_sec=math.inf,
                           usable=1.0 - 2 * 0.04, box_h=STRIP_Y_MIN)
    assert (tie.k, tie.pitch) == (6, STRIP_Y_MIN / 30), (
        f"a p_c tie between k = 6 (height-bound, {STRIP_Y_MIN}/30) and k = 7 (width-bound, "
        f"0.92/28.75) must resolve to the SMALLER k, got {tie}"
    )
    assert not tie.width_bound, "the winning k is the HEIGHT-bound side of the tie"


def test_the_bin_width_solve_is_not_capped() -> None:
    """`k` is SOLVED, not searched to an arbitrary ceiling (PR-198 review).

    H2 shipped an exhaustive loop stopping at `_MAX_BIN_WIDTH_CELLS = 64`, documented as "far
    past the useful range". It was not: the peaked corpus this seam exists for wants far more
    at the scale the project targets, and the cap silently re-created the sliver H2 removes —
    measured, 1M images in one bucket baked 0.8 % of the band wide with cells 10.8x smaller
    than the geometry allows, while the log said "pitch set by the deepest bar", which is what
    a genuine height-bound solve says too.

    The objective needs no ceiling: `k > N` cannot help (`ceil(N/k)` is already 1, so the
    height bound is maxed while the width bound keeps shrinking), so the population IS the
    bound. This pins that a solve whose optimum is past 64 actually returns it."""
    deep = _solve_bin_width([1_000_000, 1], denom=_DAY, min_int=_DAY, gap_sec=_DAY,
                            usable=1.0 - 2 * 0.04, box_h=STRIP_Y_MIN)
    assert deep.k > 64, (
        f"1M images in one bucket wants a bin far wider than the old ceiling, got {deep}"
    )
    # ...and the pitch it found genuinely beats what the ceiling would have allowed, which is
    # the thing the operator sees: the same corpus, cells an order of magnitude bigger.
    capped = min(
        (1.0 - 2 * 0.04) / (64 * (1.0 + 1.0) + 0.25 * 1.0), STRIP_Y_MIN / math.ceil(1_000_000 / 64)
    )
    assert deep.pitch > 10 * capped, (
        f"the uncapped solve must be worth having: {deep.pitch!r} vs {capped!r} at k = 64"
    )


def test_a_single_bucket_reserves_no_room_for_a_line_it_does_not_draw() -> None:
    """A corpus whose dated cells all floor into ONE bucket has NO time extent, and the
    geometry must say zero rather than substitute a placeholder.

    `denom` (last bucket start - first) is genuinely 0 here. It used to be replaced by a
    fabricated `1.0`, which was harmless pre-H1 — it only made the old `column_term` large,
    i.e. non-binding — but became a REAL input once H2 fed `denom` into the width bound. The
    fake then budgeted horizontal room for a placement line that does not exist: measured on
    this fixture it solved k = 11 / p_c = 0.0400 against the truthful k = 16 / p_c = 0.0575,
    every cell 44 % smaller, and the operator log claimed 89 % of the box against a real 43.4 %.

    Reachable with any sub-second datetime column (or a `unix_millis` role), which is ordinary
    EXIF. The block is one bin wide, so `usable/k` against `box_h/ceil(N/k)` is the whole
    solve — no interval term at all."""
    t0 = _dt.datetime(2021, 3, 1, 12, 0, 0)
    values = [t0 + _dt.timedelta(microseconds=i * 3) for i in range(256)]
    result = _compute(values, column_type=pa.timestamp("us"))
    p_c = _cell_pitch_of(result)
    honest = min((1.0 - 2 * 0.04) / 16, STRIP_Y_MIN / math.ceil(256 / 16))
    # 1e-7, not 1e-9: `p_c` is recovered as a DIFFERENCE of two float32-stored coordinates
    # near x ~ 0.5, where one ULP is ~3e-8. The two candidate geometries are 0.0575 against
    # 0.0400, so the pin has ~300x the headroom it needs.
    assert p_c == pytest.approx(honest, abs=1e-7), (
        f"one bucket must solve against a ZERO-length line (k = 16, p_c = {honest!r}); got "
        f"{p_c!r}, which is the fabricated-one-second geometry"
    )
    # ...and the block therefore FILLS the band: with no line to budget, the width bound is
    # `usable/k` exactly, so `margin + k*p_c == 1-margin` and the drawn right edge falls short
    # only by the fill inset, `(0.5 - fill/2)*p_c`. Under the fabricated span it stopped at
    # 0.477 instead — 43 % of the box, while the log claimed 89 %.
    xs = [x for _cid, x, _y in _cells_xy(result)]
    side = result.cells.column("w").to_pylist()[0]
    assert max(xs) + side / 2 == pytest.approx(1.0 - 0.04 - (0.5 * p_c - side / 2), abs=1e-6), (
        f"the single block must fill the band it was given, reaching {1.0 - 0.04!r} less one "
        f"fill inset; got a right edge of {max(xs) + side / 2!r}"
    )


def test_bar_height_still_tracks_count() -> None:
    """H2 acceptance #4 — `k` is UNIFORM across bins, so a bar's height is `ceil(N_i/k)` and
    still reads as its count. This is the property a per-bin `k` would break SILENTLY: sizing
    each bin's width from its own calendar width would give a 28-day February fewer columns
    than a 31-day January, and two bins holding the same number of images would then render
    at different heights (D-36 §"The geometry").

    Three months of equal population plus one of double it, all on the month rung."""
    values: list = []
    for month, count in ((1, 40), (2, 40), (3, 40), (4, 80)):
        values += [_dt.datetime(2021, month, 1) + _dt.timedelta(hours=i) for i in range(count)]
    result = _compute(values)
    by_month: dict[int, set] = defaultdict(set)
    for cid, _x, y in _cells_xy(result):
        by_month[values[cid].month].add(round(y, 9))
    rows = {m: len(ys) for m, ys in by_month.items()}
    assert rows[1] == rows[2] == rows[3], (
        f"three bins of 40 images must be exactly the same height, got {rows}"
    )
    assert rows[4] == 2 * rows[1], (
        f"a bin with 2x the population must be 2x as tall (up to ceil(N/k)), got {rows}"
    )
    # ...and the heights are real world distances, not just row counts.
    p_c = _cell_pitch_of(result)
    spans = {
        m: max(ys) - min(ys) for m, ys in ((m, sorted(v)) for m, v in by_month.items())
    }
    assert spans[1] == pytest.approx(spans[2], abs=1e-9) == pytest.approx(spans[3], abs=1e-9)
    # 1e-7, not 1e-9: the ys are float32 (`build_spatial_cells`), and the doubled bar's span
    # is ~0.91, where one float32 ULP is 6.0e-08.
    assert spans[4] == pytest.approx(spans[1] * 2 + p_c, abs=1e-7), (
        "2x the rows is 2x the centre-to-centre span plus the one pitch the shorter bar's "
        f"own span omits, got {spans}"
    )


def test_bar_height_quantisation_is_reported_not_hidden(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The counterpart to the test above, and the case it CANNOT see. Its 40/40/40/80 fixture
    solves to k = 4 and every count is an exact multiple of 4, so `ceil(N_i/k)` is exact there
    and the quantisation never shows (PR-198 review: it pins uniformity, not proportionality).

    A uniform `k` quantises bar height to `k` images: every bin holding `k` or fewer draws ONE
    row, whatever its count. That is inherent — a per-bin `k` would make equal counts render
    at unequal heights, which is worse — and it is the price of cells big enough to see. So
    the contract is not "height is exact"; it is "the producer SAYS when it is not". This pins
    the saying, because a silent under-report in the one channel the layout exists for is the
    failure mode."""
    t0 = _dt.datetime(2021, 3, 1, 12, 0, 0)
    values = (
        [t0 + _dt.timedelta(microseconds=i) for i in range(100)]
        + [t0 + _dt.timedelta(seconds=1, microseconds=i) for i in range(3)]
        + [t0 + _dt.timedelta(seconds=2, microseconds=i) for i in range(6)]
    )
    with caplog.at_level(logging.WARNING, logger="pipeline.layout_plugins.datetime_layout"):
        result = _compute(values, column_type=pa.timestamp("us"))
    by_bucket: dict[int, set] = defaultdict(set)
    for cid, _x, y in _cells_xy(result):
        by_bucket[values[cid].second].add(round(y, 9))
    rows = {s: len(ys) for s, ys in by_bucket.items()}
    assert rows[1] == rows[2] == 1, (
        "the fixture must REACH the flattened regime — the 3-image and 6-image bins both "
        f"draw ONE row at this k, a 2x count difference rendered identically — got {rows}"
    )
    assert rows[0] > 1, "the deep bin is still visibly taller"
    # ...and the producer SAID so. This is the load-bearing half: the geometry above is
    # allowed, the silence would not be.
    warned = [r.getMessage() for r in caplog.records if "single row" in r.getMessage()]
    assert warned, (
        "the layout flattened two bins of different counts to one row and logged no warning "
        f"— records: {[r.getMessage() for r in caplog.records]}"
    )
    assert "2 of 3 bin(s)" in warned[0], (
        f"the warning must name HOW MANY bins it flattened, got {warned[0]!r}"
    )


def test_wrapping_preserves_chronological_order_across_a_wide_bin() -> None:
    """Within a bin, `col = j % k` fills LEFT TO RIGHT in chronological order and `row = j//k`
    stacks upward — so a bar reads oldest-first however wide it is.

    THIS NEEDS k >= 3 AND NOTHING ELSE PROVIDES IT (PR-198 review, mutation-proven).
    `test_stacking_within_a_bucket_is_chronological` uses populations [4, 40], which solve to
    k = 1, and the golden fixture is k = 2 — so reversing the within-bin fill for bins 3+ wide
    left the ENTIRE suite byte-identical. A later "right-align the partial top row" or a
    column-major fill would then draw the earliest image of a period at the block's right edge
    and the latest at its left, inverting the reading order the layout exists to show, with
    every gate green."""
    t0 = _dt.datetime(2021, 3, 1, 12, 0, 0)
    values = [t0 + _dt.timedelta(microseconds=i) for i in range(100)]
    values.append(t0 + _dt.timedelta(seconds=1))
    result = _compute(values, column_type=pa.timestamp("us"))
    cells = {cid: (x, y) for cid, x, y in _cells_xy(result)}
    # World-y is screen-flipped, so the LARGEST y is the bar's bottom row: sort by -y to read
    # the block bottom-up, then left to right within each row.
    block = sorted(((cells[i], i) for i in range(100)), key=lambda t: (-t[0][1], t[0][0]))
    bottom_y = block[0][0][1]
    k = len({round(x, 9) for (x, y), _cid in block if y == bottom_y})
    assert k >= 3, f"the fixture must produce a bin at least 3 images wide, got k={k}"
    assert [cid for _pos, cid in block] == list(range(100)), (
        "a bin's cells must read in chronological order — row by row from the bottom, and "
        "left to right within each row"
    )


def test_wrapping_fixes_the_drawn_aspect_of_a_peaked_corpus() -> None:
    """H2 DoD §4.7 — THE number this seam exists for. H1 derived the column pitch from the
    cell size, which packed the columns tight but made no image bigger: a datetime layout's
    bbox stayed ~1.0 tall for any depth, `fitCamera` is therefore always height-bound, and
    the width H1 freed just became blank canvas. Wrapping each deep bin into a `k`-wide block
    is the only thing that fixes it, because it trades stack depth for width at a constant
    cell count.

    Measured on this branch against its base (H1+U1+B1), 20,000 images with 60 % on ONE day
    over a 3-year span — the shape a phone-photo or bulk-import corpus has:

        bbox               0.002814 x 0.959994   ->   0.897288 x 0.959800
        aspect (h/w)       341.15                ->   1.07
        cell side          6.6738e-05            ->   1.13333e-03      (17.0x)
        cell @ Fit 1920x1080   0.075 px          ->   1.275 px
        chart width @ Fit      3.2 px            ->   1009 px

    The Fit scale is height-bound in BOTH bakes (1080/0.96 = 1125 px per world unit), so the
    cell-size ratio is exactly the world-side ratio; the arithmetic is quoted rather than
    re-run here because `fitCamera` is the renderer's, not this package's."""
    base = _dt.datetime(2020, 1, 1)
    n, peak = 20_000, 12_000
    values = [base + _dt.timedelta(days=500)] * peak
    values += [base + _dt.timedelta(days=(1095 * i) // (n - peak)) for i in range(n - peak)]
    result = _compute(values)

    x0, y0, x1, y1 = result.bbox
    aspect = (y1 - y0) / (x1 - x0)
    assert aspect < 10.0, (
        f"the drawn aspect must come down to single digits (H1 baked 341.15 on this exact "
        f"corpus), got {aspect!r} from bbox {result.bbox}"
    )
    side = float(result.cells.column("w").to_pylist()[0])
    assert side > 10 * 6.6738e-05, (
        f"the cell must be materially larger than H1's 6.6738e-05 (0.075 px @ Fit), got "
        f"{side!r}"
    )
    assert side == pytest.approx(1.13333e-03, rel=1e-4), "the measured post-H2 cell side"
    # The freed width is genuinely USED, not merely available: the blocks reach the band end.
    assert x1 - x0 > 0.85, f"the histogram must span the box, got {x1 - x0!r}"


# --- H5 (D-36 §7.5): a narrow histogram is CENTRED in the frame ----------------------
#
# WHY THIS SECTION EXISTS AT ALL. H5 shifts `x_norm`, `x_lo` and `x_hi` by ONE offset, which
# makes it a RIGID TRANSLATION of both descriptions of the placement line — so D-36's
# alignment identity is mathematically INVARIANT under it. Measured: with the offset set to
# `slack` (all the slack on the LEFT) and with it set to 0.0, every existing alignment pin —
# `test_every_column_lands_on_its_bucket_tick` included — stays GREEN. They cannot see this
# seam at all. Everything below is written to be able to.
#
# A PITCH-BOUND FIXTURE IS THE PRECONDITION, not a detail. On a bake whose ink already fills
# the band there is no slack, the offset is exactly 0.0, and "the two slacks are equal" is
# ALREADY true on the pre-H5 code — so a width-bound fixture would make the centring pin
# vacuous. Each test below therefore measures its own slack off the bake and refuses to
# proceed unless it is at least one whole cell pitch (a width-bound bake's total slack is
# `2*(0.5 - fill/2)*p_c` = 0.15 of a pitch, so that threshold excludes them exactly).


def _drawn_extent(result) -> tuple[float, float]:
    """The leftmost and rightmost DRAWN SQUARE EDGE — the histogram's real ink, which is the
    thing being centred. That is exactly `spatial_bbox`'s x-extent (`min(x - w/2)` /
    `max(x + w/2)` over the footprints), already computed on the bake and stored as
    `result.bbox = [x_lo, y_lo, x_hi, y_hi]`, so read it straight off rather than re-deriving
    it from the float32-stored cells. Valid only on an ALL-DATED fixture: an unplaced strip
    cell would widen the bbox with `band_strip`'s x and is not on the line."""
    return float(result.bbox[0]), float(result.bbox[2])


# Two PITCH-BOUND shapes, so no assertion below rests on one fixture's arithmetic. Measured on
# this branch 2026-07-30, pre-H5 drawn extents: the clustered year-rung corpus draws 74.62 % of
# the box (slack 0.173838 -> offset 0.086919) and the deep 2-year-rung corpus draws 13.38 %
# (slack 0.786179 -> offset 0.393089). The second is the `_floor_interval` year-clamp shape,
# picked because its slack is 4.5x the first's: a mutation that survives one is very unlikely to
# survive both, and its failure margin is unmissable.
_PITCH_BOUND_SHAPES = (
    (
        "clustered year rung (10 quarter-century piles + a thin spread)",
        [1700 + (i % 250 // 25) * 25 for i in range(4000)] + [1700 + (i % 250) for i in range(400)],
    ),
    ("deep 2-year rung (the year-clamp shape)", [1] * 900 + [2] * 3 + [200] * 3),
)


def test_a_narrow_histogram_is_centred_in_the_frame() -> None:
    """H5 (D-36 §7.5, operator 2026-07-30) — THE property: when the drawn histogram is
    NARROWER than the band, the leftover is split EVENLY between the two ends instead of all
    landing on the right.

    H1 derives the cell pitch from the CELL SIZE rather than stretching the line to fill the
    band, which is deliberate (it prefers margin over hairline cells) — and it is why the slack
    exists at all. Before H5 the line still started at `margin` unconditionally, so every bit of
    that slack sat on the right. The case that prompted the seam is `nasa` — 224,990 rows over
    106.3 yr on the `('month', 1)` rung drawing `x = [0.040, 0.626]`, 58.5 % of the box — which
    is D-36 §7.5's measurement off the live bake, NOT one this suite can reproduce (it has no
    access to that tree). The two fixtures below are this file's own pitch-bound shapes, and
    their numbers were measured here.

    Measured OFF THE BAKE, never from the producer's own offset expression: the two slacks are
    the distance from `margin` to the leftmost drawn square edge and from the rightmost drawn
    square edge to `1 - margin`. Equality of those two IS "centred", and `slack/2` is the only
    offset that produces it — `0.0` and `slack` both fail, by the whole slack.

    Tolerance `ALIGN_TOL` (the file's own derived rule, 8.5e-07): the slacks are differences of
    FLOAT32-stored coordinates, and measured residuals are ~1e-08 on these fixtures, ~85x
    inside it, against mutation failures of 0.17 and 0.79 — five orders of margin."""
    for label, years in _PITCH_BOUND_SHAPES:
        result = _compute(_years(years))
        p_c = _cell_pitch_of(result)
        lo, hi = _drawn_extent(result)
        left, right = lo - 0.04, (1.0 - 0.04) - hi
        # THE PRECONDITION: this fixture must actually be narrow, or the pin is vacuous. A bake
        # whose ink fills the band has `left + right == 0.15 * p_c` exactly (the `fill` inset at
        # each end and nothing else), so "more than one whole pitch of slack" both excludes it
        # and is the smallest narrowness that could be visible. Derived, not picked.
        assert left + right > p_c, (
            f"{label}: the fixture draws {hi - lo!r} of the 0.92 band, i.e. it is NOT "
            f"pitch-bound — there is no slack to split and this pin proves nothing"
        )
        assert left == pytest.approx(right, abs=ALIGN_TOL), (
            f"{label}: the histogram is not centred — {left!r} of slack on the left against "
            f"{right!r} on the right (total {left + right!r}). An offset of `slack/2` is the "
            f"only value that balances them; 0 leaves it all on the right, `slack` all on the left"
        )
        # ...and, positively, it MOVED: the ink no longer starts at the margin. This is what
        # separates "centred" from "unchanged" without reference to the offset's own formula,
        # and it is the half that `offset = 0.0` fails on its own.
        assert lo > 0.04 + p_c, (
            f"{label}: the ink still starts at {lo!r}, within one cell pitch {p_c!r} of the "
            f"margin — a narrow histogram must be shifted right, not left-aligned"
        )


def test_the_axis_moves_with_the_centred_placement() -> None:
    """H5's COUPLING pin — the one D-36 §H5 says the seam needs and the T2-138 pin cannot be:
    after the shift, the emitted axis must still describe EXACTLY where the cells are.

    `x_norm` and `x_lo`/`x_hi` are two descriptions of ONE line. Centring is a rigid
    translation, so the alignment identity is invariant under it and
    `test_every_column_lands_on_its_bucket_tick` keeps passing whether the offset is right,
    wrong, or zero — its fixture draws 92 % of the box, so its offset is 0.0 and there is
    nothing there to get wrong. Run the SAME identity on a corpus whose offset is non-zero and
    it becomes the sharpest test in the file: shift the cells and leave the axis behind (or the
    reverse) and the consumer's reconstruction misses every block by the whole offset. That is
    T2-138's own defect, and without this pin a future edit could reintroduce it with a green
    suite.

    Asserted in both directions on purpose, and IN THIS ORDER: `_assert_on_its_tick` catches
    either side moving alone (it is the identity, so it is the primary claim), and `range[0]`
    moving off `margin` then catches the one case the identity cannot see — both sides staying
    put, i.e. no centring at all.

    NOT a magnitude check, on purpose: a coupled shift of the WRONG size (e.g. all the slack on
    one side) satisfies both assertions here — this pin proves the axis and the cells move
    TOGETHER, and `test_a_narrow_histogram_is_centred_in_the_frame` proves they move by exactly
    `slack/2`. The two are load-bearing AS A PAIR; do not remove or skip the sibling without
    moving a magnitude assertion into this test."""
    for label, years in _PITCH_BOUND_SHAPES:
        result = _compute(_years(years))
        axis = _axis(result)
        p_c = _cell_pitch_of(result)
        lo, hi = _drawn_extent(result)
        assert (lo - 0.04) + ((1.0 - 0.04) - hi) > p_c, (
            f"{label}: the fixture is not pitch-bound, so its offset is 0 and this pin cannot "
            "distinguish a coupled shift from no shift at all"
        )
        # THE IDENTITY, on a bake whose offset is non-zero: the axis and the placement moved by
        # exactly the same amount. Via the CONSUMER's reconstruction
        # (`axisDomainToTimeDomain` + `domainToX`), never the producer's formula. The rung comes
        # back OUT of the emitted annotation, so the bucket starts are floored the way the
        # manifest says they were — the second shape sits on a 2-year rung, where a year and its
        # bucket start are not the same thing in general.
        kind, step = axis["interval"]["kind"], axis["interval"]["step"]
        secs = [_dt.datetime(y, 1, 1, tzinfo=UTC).timestamp() for y in years]
        assert _assert_on_its_tick(
            result,
            lambda cid: _floor_interval(_sec_to_dt(secs[cid]), kind, step).timestamp() * 1000.0,
            f"CENTRED / {label}",
        ) is not None, f"{label}: the fixture must be deep enough to expose the cell pitch"
        # ...and the pair actually MOVED. The identity above is satisfied by two sides that are
        # both still at `margin`, so it cannot tell "coupled and centred" from "coupled and
        # unshifted"; `range[0]` is the first bin's block left edge, which was `margin` on every
        # pre-H5 bake, and this is the assertion that notices.
        assert axis["range"][0] > 0.04 + p_c, (
            f"{label}: the placement and the axis agree, but `range[0]` is "
            f"{axis['range'][0]!r} — still within one pitch of `margin`, so neither moved and "
            f"the narrow histogram is still left-aligned"
        )


def test_the_logged_extent_is_the_centred_one(caplog: pytest.LogCaptureFixture) -> None:
    """The operator-facing half. The log line is where a bake's drawn width is visible at all
    (D-36 / the "we inform" doctrine) — it is otherwise invisible until a much later
    `refresh-manifest` gate failure — so it must report the extent the layout ACTUALLY baked,
    not the pre-shift one.

    This is a live failure mode in this module, not a hypothetical: the fabricated-`denom` bug
    had this same line claiming "x=[0.04, 0.93], 89.0 % of the box" against a real drawn extent
    of [0.043, 0.477], 43.4 %. H5 introduces exactly that opportunity again, because the shift
    happens after the extent is known. The fix is that both read ONE `x_offset`; this is what
    holds them together.

    The two logged numbers must SUM TO 1.0 — the extent straddles the centre of the world box,
    which is what centring means and is the cheapest possible statement of it. Plus `lo` must be
    the emitted `range[0]`, so the log cannot be symmetric about the right point while
    describing a different line. Tolerance 2e-06: the message is formatted `%.6g`, so EACH
    endpoint carries up to 5e-07 of rounding and their SUM up to 1e-06 — 2e-06 keeps a 2x margin
    over that worst case rather than sitting exactly on it (the mutation failures are ~0.4, so
    the extra slack costs no discriminating power)."""
    label, years = _PITCH_BOUND_SHAPES[0]
    with caplog.at_level(logging.INFO, logger="pipeline.layout_plugins.datetime_layout"):
        result = _compute(_years(years))
    spans = [
        re.search(r"spans x=\[([-\d.e+]+), ([-\d.e+]+)\], ([\d.]+)%", r.getMessage())
        for r in caplog.records
    ]
    found = [m for m in spans if m]
    assert found, f"the layout logged no drawn extent — records: {[r.getMessage() for r in caplog.records]}"
    lo, hi, pct = float(found[0][1]), float(found[0][2]), float(found[0][3])
    assert pct < 90.0, (
        f"{label}: the fixture must be pitch-bound for this to test anything (it logged "
        f"{pct!r} % of the box)"
    )
    assert lo + hi == pytest.approx(1.0, abs=2e-6), (
        f"{label}: the logged extent x=[{lo!r}, {hi!r}] is not centred in the box — its "
        f"midpoint is {(lo + hi) / 2!r}, not 0.5. The log is reporting the PRE-SHIFT extent "
        f"while the bake is centred"
    )
    assert lo == pytest.approx(_axis(result)["range"][0], abs=1e-6), (
        f"{label}: the logged extent starts at {lo!r} but the emitted `range[0]` is "
        f"{_axis(result)['range'][0]!r} — the log and the axis describe different lines"
    )


# --- U1 (T2-140): undated images leave the time axis --------------------------------


def test_undated_cells_are_off_the_chart() -> None:
    """THE U1 property: an image with no date is not drawn at a date. It leaves the
    histogram for the unplaced strip — `band_strip`'s band `y in [STRIP_Y_MIN, 1]`, the same
    place scatter/geographic put a cell with a missing coordinate — while the histogram
    vacates that band entirely. Replaces `test_undated_cells_never_overlap_a_dated_column`,
    which pinned the holding fix (an undated cell SHARING a dated column's x, i.e. drawn on
    a real instant) and whose non-overlap property this subsumes.

    MEASURED SCOPE, because the brief asked for the stronger "no undated square intersects
    any dated square" and that is not universally true: the histogram is always wholly above
    STRIP_Y_MIN and every strip cell's CENTRE is always below it, but `band_strip` fits its
    rows into the fixed 0.04-tall band by shrinking the ROW PITCH, not the cells, so once the
    strip is dense the first row's SQUARE reaches back up across the boundary. Measured on
    the acceptance corpus (3000 dated + 2000 undated, side 6.581e-03): centre separation
    5.300e-03 = 0.805 of a cell, so the squares do overlap by ~0.2 of a cell; at 3000 + 10
    the separation is 3.63 cells and they do not. This is `band_strip`'s existing behaviour,
    not something U1 introduced — measured on scatter's own geometry, `cell_side(3000, 5000)`
    + `band_strip(2000 unplaced)` puts the strip's top edge at 0.9524 against a placed-cell
    bottom edge of 0.9582, i.e. the same crossing, and its bottom row escapes y=1 at 1.0076.
    So the pin below asserts the population-level separation (which is exact and is what
    "off the chart" means) plus square-level non-intersection on the sparse fixture.

    THE X HALF IS NOT OPTIONAL. A first draft of this test asserted only `y`, and every one
    of its assertions still passed when the placement was mutated to
    `ys[k] = strip[ids[k]][1]` — overwriting the y and leaving the x at the placeholder. The
    placeholder was `margin`, which is EXACTLY `range[0]`, so under that mutation every
    undated image was drawn on the first bucket's tick — T2-140's own defect, restored, with
    a green suite. Assertions 4 and 5 below pin the x, and the placeholder is now
    `_UNPLACED_X` (outside [0,1]) so a leak can no longer land on a real column at all."""
    n_dated = 94
    dated: list = [_dt.datetime(2020, 1, 1) + _dt.timedelta(days=7 * i) for i in range(n_dated)]
    for n_undated in (1, 40, 2000):
        result = _compute(dated + [None] * n_undated)
        cells = _cells_xy(result)
        side = float(result.cells.column("w").to_pylist()[0])
        chart = [(x, y) for cid, x, y in cells if cid < n_dated]
        strip = [(x, y) for cid, x, y in cells if cid >= n_dated]
        assert len(chart) + len(strip) == n_dated + n_undated, "nothing is dropped"

        # 1. The histogram vacates the strip band — every dated SQUARE is above STRIP_Y_MIN.
        assert max(y for _, y in chart) + side / 2 <= STRIP_Y_MIN + 1e-6, (
            f"{n_undated} undated: the histogram must not reach into the strip band "
            f"(lowest dated edge {max(y for _, y in chart) + side / 2!r} vs {STRIP_Y_MIN})"
        )
        # 2. ...and every undated cell is IN it.
        assert min(y for _, y in strip) >= STRIP_Y_MIN, (
            f"{n_undated} undated: every undated cell sits in the strip band"
        )
        # 3. So every undated cell is BELOW every dated cell on screen (world-y is
        #    screen-flipped: larger world-y = screen bottom), by at least half a stack row.
        #    The row pitch is read OFF THE BAKE. It used to be re-derived as
        #    `STRIP_Y_MIN / (number of rows)`, which was the same number only while the rows
        #    divided the box; since H2 the row pitch IS the cell pitch and a short histogram
        #    leaves the rest of the box empty, so that derivation over-states it (measured
        #    0.192 against a real pitch of 0.031159 on this fixture) and the assertion would
        #    fail on a correct bake.
        row_h = _cell_pitch_of(result, only=set(range(n_dated)))
        assert min(y for _, y in strip) - max(y for _, y in chart) >= row_h / 2 - 1e-9, (
            f"{n_undated} undated: the strip must clear the histogram's base row"
        )

        # 4. THE X HALF — an undated cell's x must not be a claim about time. The sharpest
        #    form: it is never the FIRST BUCKET'S TICK, which is where the pre-strip parking
        #    x (`margin` == `range[0]`) sat. `band_strip`'s column centres are
        #    (col+0.5)/strip_cols, and no integer strip_cols puts one within 1.5e-03 of 0.04
        #    (12 -> 0.041667, 13 -> 0.038462), so this margin is real, not a rounding fudge.
        first_tick = _axis(result)["range"][0]
        assert all(abs(x - first_tick) > 1e-6 for x, _ in strip), (
            f"{n_undated} undated: an undated cell is drawn at range[0]={first_tick!r} — the "
            "first bucket's tick, i.e. AT a date it does not have"
        )
        # 5. ...and, positively: BOTH coordinates come from `band_strip`, not just the y.
        #    Asserted against the helper itself (never a re-derivation of its formula), which
        #    is the contract this seam actually makes: the strip owns the whole placement.
        #
        #    The side handed to it is `strip_cell_side(...)`, NOT the histogram's `side`: H2
        #    tripled the cell size, and a strip that inherited it pushed its last row's squares
        #    past y=1 (measured 1.029 at 50 dated + 50 undated) where `spatial_bbox` clamps the
        #    bbox back and the manifest under-reports the footprint. The strip's cells shrink
        #    to fit the reserved band instead of the band growing, because a growing band
        #    re-couples the DATED geometry to the undated count — measured at up to 11x, the
        #    regression U1 exists to prevent (see `strip_cell_side`'s note).
        strip_side = strip_cell_side(n_undated, side)
        assert strip_side <= side, "the strip never draws LARGER than the histogram"
        expected = band_strip(list(range(n_dated, n_dated + n_undated)), strip_side)
        for cid, x, y in cells:
            if cid < n_dated:
                continue
            assert (x, y) == pytest.approx(expected[cid], abs=1e-6), (
                f"{n_undated} undated: cell {cid} is at ({x!r}, {y!r}) but `band_strip` places "
                f"it at {expected[cid]!r} — the strip must own BOTH coordinates"
            )
        # 6. ...and no strip square escapes the world box, which is what the shrink buys.
        strip_w = {cid: w for cid, w in zip(
            result.cells.column("id").to_pylist(), result.cells.column("h").to_pylist()
        )}
        assert max(y + strip_w[cid] / 2 for cid, _, y in cells if cid >= n_dated) <= 1.0 + 1e-6, (
            f"{n_undated} undated: a strip square hangs past y=1, where `spatial_bbox` clamps "
            "it away and the manifest under-reports the drawn footprint"
        )

    # 4. ...and on a SPARSE strip the drawn squares do not intersect at all.
    result = _compute(dated + [None])
    cells = _cells_xy(result)
    side = float(result.cells.column("w").to_pylist()[0])
    ux, uy = next((x, y) for cid, x, y in cells if cid == n_dated)
    for cid, x, y in cells:
        if cid >= n_dated:
            continue
        assert not (abs(x - ux) < side - 1e-9 and abs(y - uy) < side - 1e-9), (
            f"undated cell at ({ux}, {uy}) overlaps dated cell {cid} at ({x}, {y}), side={side}"
        )


def test_undated_cells_do_not_move_the_axis() -> None:
    """The H1 coupling U1 cuts: `S` counts DATED bins only, so the number of images with NO
    DATE no longer sets the scale of the time axis. Adding undated cells to a corpus must
    leave `range` and every dated cell's `x` bit-for-bit what the corpus WITHOUT them bakes.

    Replaces `test_undated_cells_count_into_the_pitch`, which pinned exactly the inverse (the
    parked cells deepening a column and dragging the pitch down with them) as the deliberate
    holding behaviour. Delete-and-replace is the correct move: the two cannot both hold.

    Both regimes, because the pre-U1 damage took a different form in each. Measured on the
    base plugin with these exact two fixtures, adding the 2000 undated images:

      columns-bind (4000 works / 250 uniform years)
          `range` [0.04, 0.96] -> [0.04, 0.163511385]   (extent 0.92 -> 0.1235, 7.4x narrower)
          `side`  0.003140575 -> 0.000421627            (7.4x smaller)
          rung and column count unchanged (250 year columns)

      stack-bound (100 photos / 11 weeks)
          `range` [0.04, 0.088080318] -> [0.04, 0.115962019]   (extent 0.0481 -> 0.0760, WIDER)
          `domain` 2020-01-01..2020-03-01 -> 2020-01-01..2020-03-17
          3 MONTH columns -> 77 DAY columns; `side` 0.020732 -> 0.000425 (49x smaller)

    The stack-bound case is WIDER, not narrower, because BOTH pre-U1 couplings fire there at
    once and they pull opposite ways: the undated images drag the interval rung finer (month
    -> day, so more intervals span the same time) faster than they shrink the pitch. An
    earlier version of this docstring claimed `[0.04, 0.041022]` there — a number that
    reproduces from no state, arrived at by reasoning about the pitch alone and forgetting
    the rung — and got the direction backwards with it."""
    for label, dated in (
        ("columns-bind", _years([1700 + (i % 250) for i in range(4000)])),
        ("stack-bound", _packed_100_over_11_weeks()),
    ):
        n_dated = len(dated)
        without = _compute(list(dated))
        with_undated = _compute(list(dated) + [None] * 2000)
        assert _axis(with_undated)["range"] == _axis(without)["range"], (
            f"{label}: 2000 undated images moved the placement line "
            f"{_axis(without)['range']} -> {_axis(with_undated)['range']}"
        )
        assert _axis(with_undated)["domain"] == _axis(without)["domain"], f"{label}: domain moved"
        a = {cid: (x, y) for cid, x, y in _cells_xy(without)}
        b = {cid: (x, y) for cid, x, y in _cells_xy(with_undated)}
        assert [a[c] for c in range(n_dated)] == [b[c] for c in range(n_dated)], (
            f"{label}: a dated cell moved when undated images were added"
        )
        assert with_undated.cells.num_rows == n_dated + 2000, "nothing is dropped"


def test_missing_count_is_carried_on_the_layout_not_the_axis() -> None:
    """The v2.6 additive field: `LayoutResult.missing_count` is the COUNT of cells this
    layout could not place. It is 0 when every image is dated, and `manifest._layout_entry`
    WRITES that 0 — the count is a positive claim about the data, so a reader gating on field
    PRESENCE (the contract's rule, never `manifest_version`) reads an absent key as "this
    entry predates 2.6", never as "nothing was unplaced".

    It lives on the LAYOUT, never on the axis: `axes[]` is an object the producer may refuse
    to emit (see `test_declined_axis_still_reports_missing_count`), so a count riding on it
    would vanish exactly where the viewer most needs it."""
    dated = [_dt.datetime(2020, 1, 1) + _dt.timedelta(days=7 * i) for i in range(94)]
    baseline = _compute(list(dated))
    assert baseline.missing_count == 0, "zero when nothing is undated"
    for n_undated in (1, 7, 2000):
        result = _compute(list(dated) + [None] * n_undated)
        assert result.missing_count == n_undated, (
            f"expected missing_count={n_undated}, got {result.missing_count}"
        )
        assert isinstance(result.missing_count, int) and result.missing_count >= 0
        assert "missing" not in _axis(result), (
            "the count must NOT ride on the axis — `missing` there is one word from "
            "`labelAnnotation.missing`'s boolean, and a declined axis carries no count"
        )


def test_declined_axis_still_reports_missing_count() -> None:
    """The reason the count moved off the axis. Forty timestamps half a second apart span a
    real interval but all floor into ONE second-bucket, so the calendar branch runs — the
    undated cells ARE stripped into `y >= STRIP_Y_MIN` — and the axis is then DECLINED for
    having no drawable extent. A count riding on `axes[]` would be unreachable here, and the
    viewer would be left with a strip and nothing explaining it."""
    base = _dt.datetime(2020, 6, 15, 12, 0, 0)
    dated = [base + _dt.timedelta(microseconds=500_000 * (i % 2)) for i in range(40)]
    result = _compute(dated + [None] * 9, column_type=pa.timestamp("us"))
    assert result.annotations == {"axes": []}, "the fixture must exercise the DECLINED axis"
    assert result.missing_count == 9
    ys = {cid: y for cid, _x, y in _cells_xy(result)}
    assert all(ys[cid] >= STRIP_Y_MIN for cid in range(len(dated), len(dated) + 9)), (
        "the undated cells are in the strip even though the axis was declined"
    )


def test_alignment_survives_undated_cells() -> None:
    """The T2-138 invariant on a corpus that has BOTH: every DATED cell's baked `x` is where
    the emitted axis puts that cell's own bucket start, reconstructed the way the consumer
    does it (`axisDomainToTimeDomain` + `domainToX`), never by re-deriving the producer's
    formula. The undated cells are off the line entirely and are not asserted about here —
    `test_undated_cells_are_off_the_chart` owns them."""
    n_dated = 100
    dated = _packed_100_over_11_weeks()
    result = _compute(list(dated) + [None] * 250)
    axis = _axis(result)
    assert axis["range"][1] < 0.96, "the fixture must exercise the PACKED regime"
    assert result.missing_count == 250
    _assert_on_its_tick(
        result, _month_tick(dated), "packed + undated", only=set(range(n_dated))
    )


def test_undated_cells_do_not_move_the_interval_rung() -> None:
    """The SAME coupling one step earlier, and the one the PR-189 review found:
    `_select_interval` is sized by `_bucket_budget(n)` = 5*sqrt(n), so passing the TOTAL let
    undated images buy columns for dates that do not exist and drag the ladder to a rung far
    too fine for the dated cells to fill.

    Measured on the pre-U1 plugin: 200 photos over 200 days alone pick ('month', 1) -> 7
    columns, cell side 2.742e-02; the same 200 plus 19,800 undated picked ('hour', 12) -> 200
    columns of ONE image each, cell side 4.293e-05 — 638x smaller, exactly the
    "1-image-per-column hairline of specks" the `_BUCKET_RELAX` docstring says the budget
    exists to prevent."""
    n_dated = 200
    dated = [_dt.datetime(2021, 1, 1) + _dt.timedelta(days=i) for i in range(n_dated)]
    alone = _compute(list(dated))
    swamped = _compute(list(dated) + [None] * 19_800)
    cols_alone = {x for cid, x, _ in _cells_xy(alone) if cid < n_dated}
    cols_swamped = {x for cid, x, _ in _cells_xy(swamped) if cid < n_dated}
    ticks_alone = {
        round(_ms(_dt.datetime(v.year, v.month, 1)), 3) for v in dated
    }
    assert len(ticks_alone) == 7, "200 photos over 200 days bucket by MONTH"
    # 14 COLUMNS, not 7: since H2 each of those 7 month bins is k = 2 images wide. The rung
    # is what this test is about, so the bin count is asserted from the dates and the column
    # count is the k-scaled consequence.
    assert len(cols_alone) == 14, f"7 month bins x k=2 columns (got {len(cols_alone)})"
    assert cols_swamped == cols_alone, (
        f"19,800 undated images changed the rung: {len(cols_alone)} dated columns became "
        f"{len(cols_swamped)}"
    )
    assert _axis(swamped)["domain"] == _axis(alone)["domain"], "the rung moved the bucket starts"
    assert _axis(swamped)["range"] == _axis(alone)["range"]
    assert (
        swamped.cells.column("w").to_pylist()[0] == alone.cells.column("w").to_pylist()[0]
    ), "the drawn cell size must not depend on how many images have no date"


# --- the emitted bucketing rung (v2.7 / D-36 seam H3) --------------------------------


def test_the_axis_carries_the_rung_it_binned_at() -> None:
    """v2.7 (H3): the axis reports the `(kind, step)` LADDER RUNG the bake bucketed at, so the
    renderer ticks bin boundaries it was TOLD about instead of re-deriving a second ladder.
    That second ladder is the defect: the plugin owns 25 rungs across six kinds while
    `overlayLayer.niceTimeTicks` owned YEARS ONLY, so T2-138's every-bin-on-its-tick guarantee
    only BIT where the two happened to coincide and a month-binned dataset got a correct but
    unlabelled axis.

    TWO RUNGS, asserted as LITERALS — never against `_select_interval`, which is the code that
    produced the value and would be comparing it to itself. The pair is chosen to pin both
    halves of the tuple independently: a 420-year span picks a multi-step YEAR rung (so a
    hard-coded `step: 1` shows up), and an 11-week span picks a step-1 MONTH rung (so a
    hard-coded `kind: "year"` shows up, and so `step: 1` is proved to be EMITTED rather than
    omitted as a default). Measured on this branch 2026-07-29.

    ...and then tied to the GEOMETRY, which is what stops the field being a plausible-looking
    label with nothing behind it: the emitted rung is fed back through `_assert_on_its_tick`,
    so the ticks it implies must be the block left edges actually baked. A manifest advertising
    a rung the placement did not use fails there even where the literal happens to match."""
    for values, expected in (
        (_years([1600, 1637, 1637, 1700, 1800, 1900, 2020]), {"kind": "year", "step": 50}),
        (_packed_100_over_11_weeks(), {"kind": "month", "step": 1}),
    ):
        axis = _axis(_compute(values))
        assert axis["interval"] == expected, (
            f"the axis must report the rung it binned at; got {axis.get('interval')!r}"
        )
        # The rung comes back OUT of the emitted annotation here — the test never asks the
        # producer's selector — and the bins it implies must be the ones on disk.
        kind, step = axis["interval"]["kind"], axis["interval"]["step"]
        secs = [v.replace(tzinfo=UTC).timestamp() for v in values]
        _assert_on_its_tick(
            _compute(values),
            lambda cid: _floor_interval(_sec_to_dt(secs[cid]), kind, step).timestamp() * 1000.0,
            f"rung read back off the manifest ({kind}/{step})",
        )


def test_the_emitted_rung_is_the_dated_one_not_the_swamped_one() -> None:
    """The U1 coupling, now visible in the CONTRACT rather than only in the geometry: the rung
    is chosen from the DATED count (`_bucket_budget(len(known))`), so 19,800 undated images
    must not move the field the renderer reads. Measured on the pre-U1 plugin, the same 200
    photos over 200 days went from `('month', 1)` / 7 columns to `('hour', 12)` / 200
    one-image columns — so a producer that emitted a rung derived from the TOTAL would
    advertise `hour`/12 here while still binning by month, and the renderer would draw 12-hour
    ticks across month-wide bars."""
    dated = [_dt.datetime(2021, 1, 1) + _dt.timedelta(days=i) for i in range(200)]
    alone = _axis(_compute(list(dated)))["interval"]
    swamped = _axis(_compute(list(dated) + [None] * 19_800))["interval"]
    assert alone == {"kind": "month", "step": 1}, alone
    assert swamped == alone, f"undated images moved the ADVERTISED rung: {alone} -> {swamped}"


def test_a_declined_axis_carries_no_interval() -> None:
    """`interval` rides on the AXIS, so a DECLINED axis has none — there is no axis object to
    hang it on. That is the whole placement rule, and it is the opposite of `missing_count`'s
    (which moved ONTO the layout entry precisely so it survives a decline).

    MEASURED CORRECTION to the reasoning this seam was briefed with (2026-07-29). "A declined
    axis has no bucketing to report" is TRUE of two of the three decline causes and FALSE of
    the third: `degenerate span` and `calendar overflow` take the legacy equal-time grid and
    never call `_select_interval` at all, but `single occupied bucket` runs the CALENDAR branch
    and does choose a rung — 256 images inside 0.255 s pick `('second', 1)`, and the plugin
    logs it — and still declines. The clause that actually holds everywhere is the other one:
    a declined axis has no TICKS to draw. A one-bucket histogram has no drawable extent, so
    there is nothing for a tick rung to describe even though something was binned."""
    one_ms_apart = [
        int(_dt.datetime(2021, 1, 1, tzinfo=UTC).timestamp() * 1000) + i for i in range(256)
    ]
    declined = {
        "degenerate span": _compute(_years([1900, 1900, 1900])),
        "all missing": _compute([None, None, None]),
        "calendar overflow": _compute(
            [1_600_000_000_000 + i * 1_000_000 for i in range(9)],
            fmt="unix_seconds",
            column_type=pa.int64(),
        ),
        "single occupied bucket": _compute(
            one_ms_apart, fmt="unix_millis", column_type=pa.int64()
        ),
    }
    for label, result in declined.items():
        assert result.annotations == {"axes": []}, f"{label}: expected the declined marker"

    # ...and the single-bucket case really is the one that picked a rung and dropped it.
    secs = [v / 1000.0 for v in one_ms_apart]
    assert _select_interval(max(secs) - min(secs), len(secs))[:2] == ("second", 1), (
        "the single-bucket fixture must reach the calendar branch and choose a rung — "
        "otherwise this test is not covering the case its docstring describes"
    )


def test_the_schema_interval_kinds_are_exactly_the_ladder_kinds() -> None:
    """The contract's `kind` enum and the producer's `_INTERVAL_LADDER` are TWO HAND-WRITTEN
    LISTS describing one thing, which is the failure this whole seam exists to remove — so
    they are gated against each other rather than kept in step by discipline.

    Measured off the ladder 2026-07-29: 25 rungs over six kinds — second x4, minute x4,
    hour x4, day x1, month x2, year x10, coarsest `('year', 1000)`. There is deliberately no
    `week` (the only sub-month unit that does not nest under its parent; D-36 designs it out)
    and no millennium. A rung added to the ladder under a NEW kind would emit a value the
    schema rejects, and `_validate_manifest` would fail the whole bake AFTER the pyramids were
    written — the same late, expensive failure the 2.6 `axes[].missing` removal describes.
    This fails at the unit tier instead. It gates ONE of the four pairs — schema <-> ladder;
    its sibling `test_every_ladder_rung_has_a_floor_and_min_interval_arm` gates the other two
    (ladder <-> `_floor_interval` and ladder <-> `_min_interval_sec`), so a new kind that is
    added to the ladder but missing a Python arm is caught here too, not merely NAMED."""
    schema = json.loads((_schema_dir() / "layout_manifest.schema.json").read_text("utf-8"))
    enum = schema["$defs"]["axisAnnotation"]["properties"]["interval"]["properties"]["kind"]["enum"]
    ladder_kinds = {kind for kind, _step, _avg in _INTERVAL_LADDER}
    assert set(enum) == ladder_kinds, (
        f"schema `interval.kind` enum {sorted(enum)} != the rung kinds the producer can "
        f"select {sorted(ladder_kinds)}. A new rung needs its kind here AND a `_floor_interval` "
        f"arm AND a `_min_interval_sec` arm — all four tables describe the same ladder."
    )
    assert len(enum) == len(set(enum)), f"duplicate kind in the schema enum: {enum}"


def test_every_ladder_rung_has_a_floor_and_min_interval_arm() -> None:
    """The OTHER two of the four tables, gated the same way
    `test_the_schema_interval_kinds_are_exactly_the_ladder_kinds` gates the schema: every rung
    the producer can `_select_interval` must have a real arm in BOTH `_floor_interval` and
    `_min_interval_sec`, not fall through a default.

    This is the enforcement the sibling test's message only NAMED. `_min_interval_sec` already
    raises for an unarmed kind, but `_floor_interval` used to floor any unknown kind as SECONDS
    silently — so a `('week', 1, ...)` rung added to the ladder + the schema enum, given a
    `_min_interval_sec` arm but not a `_floor_interval` one, would have bucketed by seconds
    while advertising `{kind: "week"}` and passed every gate. Both functions now raise on an
    unarmed kind, and this test walks the whole ladder so that omission fails at the unit tier
    rather than at bake time (or, worse, silently). [[T2-150]] folds both per-rung values into
    the ladder tuple so a new rung cannot omit either at all."""
    probe = _dt.datetime(2021, 3, 15, 12, 34, 56, tzinfo=UTC)
    for kind, step, _avg in _INTERVAL_LADDER:
        floored = _floor_interval(probe, kind, step)   # raises ValueError if the arm is missing
        assert floored <= probe, f"{kind}/{step}: a floor must not move the instant forward"
        assert floored.tzinfo is not None, f"{kind}/{step}: floor dropped the tz"
        assert _min_interval_sec(kind, step) > 0, f"{kind}/{step}: min interval must be positive"


# --- preserved behaviours -----------------------------------------------------------


def test_missing_dates_never_influence_the_axis() -> None:
    """An undated cell never moves the axis domain — and since U1 it is not on the axis at
    all: it sits in the unplaced strip, and is counted onto the LAYOUT as `missing_count`."""
    values = [_dt.datetime(1800, 1, 1), None, _dt.datetime(1900, 1, 1)]
    result = _compute(values)
    y_by_id = {cid: y for cid, _, y in _cells_xy(result)}
    assert y_by_id[1] >= STRIP_Y_MIN, "the undated cell is in the strip, not in a column"
    assert y_by_id[0] < STRIP_Y_MIN and y_by_id[2] < STRIP_Y_MIN
    axis = _axis(result)
    assert axis["domain"][0].startswith("1800-01-01")
    assert axis["domain"][1].startswith("1900-01-01")
    assert result.missing_count == 1


def test_degenerate_span_declines_the_axis() -> None:
    """All-equal dates: no drawable extent -> the explicit declined-axis marker (so the
    client's pre-2.5 shim can't resurrect an axis the producer refused)."""
    result = _compute(_years([1900, 1900, 1900]))
    assert result.annotations == {"axes": []}


def test_all_missing_declines_the_axis() -> None:
    result = _compute([None, None, None])
    assert result.annotations == {"axes": []}
    # `missing_count` is "cells this layout could not date", a property of the DATA — not
    # "cells that reached the strip", a property of which branch ran. This all-undated corpus
    # takes the LEGACY fallback grid (no span ⇒ no strip, the pre-U1 parking is left alone),
    # and reporting 0 here would say the layout placed everything it was asked to.
    assert result.missing_count == 3


def test_calendar_overflow_declines_axis_and_uses_legacy_grid() -> None:
    """R1: a `unix_seconds` role fed MILLISECOND values (~year 52,000) can't be
    calendar-floored — the layout still bakes (legacy equal-time grid) but declines the
    axis rather than emitting year-52,000 ticks."""
    base = 1_600_000_000_000  # ms-as-seconds -> ~year 52,600
    values = [base + i * 1_000_000 for i in range(9)]
    result = _compute(values, fmt="unix_seconds", column_type=pa.int64())
    assert result.annotations == {"axes": []}
    assert len(_cells_xy(result)) == 9  # baked normally


def test_unix_millis_scaling_is_applied() -> None:
    """A `unix_millis` role is scaled to real seconds before bucketing (the same scaling
    `_epoch_to_iso` applies) — otherwise 2020 would floor as 1970."""
    values = [int(_dt.datetime(y, 1, 1, tzinfo=UTC).timestamp() * 1000) for y in (2000, 2010, 2020)]
    result = _compute(values, fmt="unix_millis", column_type=pa.int64())
    axis = _axis(result)
    assert axis["domain"][0].startswith("2000-01-01"), axis["domain"]
    assert axis["domain"][1].startswith("2020-01-01"), axis["domain"]
    _assert_on_its_tick(
        result, lambda cid: _ms(_dt.datetime((2000, 2010, 2020)[cid], 1, 1)), "unix_millis"
    )


def _baked(result) -> dict:
    """Everything a bake hands the manifest and the viewer, for layout-identity checks."""
    return {
        "cells": result.cells.to_pydict(),
        "bbox": result.bbox,
        "annotations": result.annotations,
        "options": result.options,
        "missing_count": result.missing_count,
    }


# The packed fixture plus one undated cell, so the unplaced strip is in play too.
_A_DATE_IS_A_DATE = _packed_100_over_11_weeks() + [None]


def test_a_stored_timestamp_lays_out_alike_under_every_format() -> None:
    """A timestamp column is already an instant, so its format changes nothing (#391).
    Until then the plugin divided every value by 1000 under `unix_millis`, a timestamp's
    included, and a collection holding a committed `unix_millis` over a stored timestamp
    baked in January 1970. Every format must give `iso8601`'s layout, on the true dates."""
    as_iso = _baked(_compute(_A_DATE_IS_A_DATE, fmt="iso8601"))
    assert as_iso["annotations"]["axes"][0]["domain"][0].startswith("2020-01-01"), "premise"
    for fmt in ("unix_seconds", "unix_millis"):
        other = _baked(_compute(_A_DATE_IS_A_DATE, fmt=fmt))
        moved = [part for part, value in other.items() if value != as_iso[part]]
        assert moved == [], f"{fmt} moved {moved}: axis {other['annotations']}"


@pytest.mark.parametrize("fmt, per_second", [("unix_seconds", 1), ("unix_millis", 1000)])
def test_an_int64_column_lays_out_as_the_timestamp_it_denotes(fmt: str, per_second: int) -> None:
    """An int64 column read under its own `unix_*` format lays out exactly as the same
    instants stored as a timestamp do. The reference is the timestamp, which no format
    scales, so this fails if the integer scaling is lost (`unix_millis` would floor as
    year ~52,000 and decline the axis) or applied twice (1970), and it pins that
    `unix_seconds` is unchanged by #391's move of the scaling into `_to_epoch`."""
    as_timestamp = _baked(_compute(_A_DATE_IS_A_DATE))
    as_integers = [
        None if d is None else int(d.replace(tzinfo=UTC).timestamp()) * per_second
        for d in _A_DATE_IS_A_DATE
    ]
    as_int64 = _baked(_compute(as_integers, fmt=fmt, column_type=pa.int64()))
    moved = [part for part, value in as_int64.items() if value != as_timestamp[part]]
    assert moved == [], f"{fmt} moved {moved}: axis {as_int64['annotations']}"


def test_deterministic_across_runs() -> None:
    """Same input -> byte-identical geometry (no clock/random in the placement)."""
    years = _years([1600, 1750, 1750, 1900, 2000])
    a, b = _compute(years), _compute(years)
    assert _cells_xy(a) == _cells_xy(b)
    assert a.annotations == b.annotations
    assert a.bbox == b.bbox


def test_cells_stay_inside_the_unit_square() -> None:
    """The FIRST bin's block starts at `margin + x_offset` and the LAST block ends at
    `1 - margin - x_offset` (H5 centres a narrow histogram); those reach the box edges `margin`
    / `1-margin` only in the tightest, band-filling case (`x_offset == 0`, when the WIDTH term
    sets the pitch and the last bin is full — H1/H2), and are pulled INWARD otherwise. So a
    cell wider than 2*margin would hang outside the [0,1] world box — reachable only on a SMALL,
    shallow dataset (few buckets AND short bars), e.g. the 10-photos-over-10-days case (which is
    band-filling, `x_offset == 0`). `spatial_bbox` would then clamp and UNDER-report the true
    footprint, and the edge bins would be clipped in the coarse tier (#186 verification rider).

    SCOPE — do NOT add a fixture carrying UNDATED cells here expecting it to pass. The
    unplaced strip is `_placement.band_strip`, whose rows are pitched to fit the 0.04-tall
    band while the cells keep the layout's uniform side, so the last row's SQUARE can hang
    below y=1: measured, 10 photos over 10 days + 1 undated puts that cell's lower edge at
    1.014. That is band_strip's existing shipped behaviour — scatter's own
    `cell_side(100, 101)` + `band_strip(1)` reaches 1.025 — so it belongs to a `_placement`
    fix, not to this pin. Every fixture below is all-dated, or all-undated (the LEGACY
    branch, which has no strip)."""
    for values in (
        [_dt.datetime(2021, 1, 1) + _dt.timedelta(days=i) for i in range(10)],  # 10/10 days
        [_dt.datetime(2021, 1, 1), _dt.datetime(2021, 1, 1, 0, 0, 1)],          # 2 cells, 1 s
        _years([1600, 1900]),                                                    # 2 cells, wide
        # H1/H2 (D-36): the PACKED regime — deep bars, few bins, so the pitch comes from the
        # cell size and the bins WRAP (k = 4 here). `x` must still land inside the box
        # without `_clamp01` doing the work — and this is the case where that could go
        # wrong, because the last bin's block extends `k*p_c` to the RIGHT of `range[1]`,
        # which the width bound has to budget for. Without that budget the last block bleeds
        # past 1-margin, `_clamp01` silently squashes it and `spatial_bbox` under-reports
        # (#186's rider 3, in H2's new form).
        _packed_100_over_11_weeks(),
        # ...and a WIDTH-BOUND wrapped case, where the last block lands EXACTLY on 1-margin
        # rather than short of it — the tightest the budget ever is (measured: the right-most
        # cell edge sits at 0.9548, `1-margin` less the `fill` inset).
        [_dt.datetime(2021, 1, 1) + _dt.timedelta(days=i) for i in range(256)],
        _years([1900] * 60 + [1901] * 60),   # 2 columns, 60 deep
        # The LEGACY branch (declined axis), which every fixture above misses — its pitch is
        # 1/ncols with NO relation to the stack depth, so it is the only case where the
        # `row_h` term of `side` actually binds. Without it the cells are drawn ~7x the stack
        # pitch, overlap their neighbours, and escape the box (where `_clamp01` hides it).
        [None] * 100,                             # all dates missing -> x = 0.5, 100 deep
        [_dt.datetime(2000, 1, 1)] * 100,         # all dates EQUAL -> no span, 100 deep
    ):
        result = _compute(values)
        tab = result.cells
        for x, y, w, h in zip(*(tab.column(c).to_pylist() for c in ("x", "y", "w", "h"))):
            assert -1e-6 <= x - w / 2 and x + w / 2 <= 1 + 1e-6, f"cell x-extent escapes [0,1]: {x=} {w=}"
            assert -1e-6 <= y - h / 2 and y + h / 2 <= 1 + 1e-6, f"cell y-extent escapes [0,1]: {y=} {h=}"


def test_stacking_within_a_bucket_is_chronological() -> None:
    """Cells sharing a calendar bucket stack EARLIEST-FIRST (slot 0 = largest world-y = the
    screen bottom), regardless of id order — the pre-T2-138 behaviour, preserved (#186
    verification rider: the column key alone would have stacked by id)."""
    # Ids ascend while dates DESCEND within one year bucket.
    values = [_dt.datetime(1900, m, 1) for m in (12, 9, 6, 3)] + [_dt.datetime(1990, 1, 1)] * 40
    result = _compute(values)
    cells = {cid: (x, y) for cid, x, y in _cells_xy(result)}
    bucket = [cells[i] for i in range(4)]  # the four 1900 cells
    assert len({round(x, 6) for x, _ in bucket}) == 1, "all four share the 1900 column"
    # Earliest (March, id 3) must sit at slot 0 = the LARGEST world-y.
    ys = {cid: cells[cid][1] for cid in range(4)}
    assert ys[3] > ys[2] > ys[1] > ys[0], f"stack must be chronological, got {ys}"


def test_cells_are_square() -> None:
    """T2-117 preserved: every cell is drawn square."""
    result = _compute(_years([1600, 1700, 1800, 1900]))
    tab = result.cells
    ws = [float(v) for v in tab.column("w").to_pylist()]
    hs = [float(v) for v in tab.column("h").to_pylist()]
    assert all(w == pytest.approx(h) for w, h in zip(ws, hs))
