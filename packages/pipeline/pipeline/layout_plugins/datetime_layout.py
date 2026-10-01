"""Datetime layout: positions cells along a time axis from the datetime role.

X is the normalized timestamp (so temporal gaps are visible); cells sharing a time
bucket stack vertically into a temporal-histogram column. Buckets are CALENDAR-ALIGNED
(T2-138): the interval is auto-picked from a nice ladder (…hour / day / month / year /
decade…) — the finest whose column count fits the budget — and each cell is placed at its
bucket's floored calendar START (Jan 1 for years, the 1st for months, midnight for days).
The emitted v2.5 axis describes THAT SAME line, so every bin's BLOCK LEFT EDGE lands exactly
on its own axis tick, and since v2.7 (H3 / D-36) it also carries the CHOSEN RUNG itself
(`interval: {kind, step}`) so the renderer ticks the producer's own bin boundaries instead
of a separately-maintained ladder that only happened to agree at year rungs. (Before T2-138 the columns were a sqrt(n) EQUAL-TIME grid placed at
bucket CENTRES — ~4.2 yr wide for rijks — so interior columns drifted up to ±2 yr from the
ticks while only the endpoints aligned.) Cells are drawn as SQUARES (side = fill * the cell
pitch; T2-117) so a temporally-peaked dataset does not bake "smashed" rectangles. The cell
PITCH comes from the CELL SIZE, not from the band width (H1 / D-36): a deep-stacked histogram
packs its bins tight instead of spreading a few hairlines across a mostly empty box, so
`range` reaches `1-margin` only when the bin width binds. A bin is `k` images WIDE and its
cells WRAP row-major from the bottom (H2 / D-36): a histogram bar FILLS its bin instead of
being a one-image hairline stretched away from its neighbours, which is what fixes the
1:341-ish drawn aspect a peaked corpus used to bake. `k` is UNIFORM across bins (so bar
height still reads as count) and is sized off the SHORTEST interval of the chosen rung, with
a `_BIN_GUTTER_CELLS` residual left unfilled at each block's RIGHT end so bin boundaries stay
visually distinct. A histogram narrower than the frame is CENTRED in it (H5 / D-36 §7.5): the
slack H1 leaves is split evenly instead of all landing on the right, by translating BOTH
descriptions of the placement line — the placement and the emitted axis `range` — by one
offset. UNDATED cells are NOT on the chart
(U1 / T2-140): the histogram lives in world-y [0, STRIP_Y_MIN] and undated images go in the
unplaced strip below it (scatter's `_placement.band_strip`), counted onto the LAYOUT as
`missing_count` — so no image is ever drawn at a date it does not have, and the number of
undated images no longer sets the scale of the time axis. Coordinates are explicit [0,1]^2
floats.
"""
from __future__ import annotations

import datetime as _dt
import logging
import math
from collections import Counter, defaultdict
from typing import TYPE_CHECKING, NamedTuple

from pipeline.layout_plugins._placement import STRIP_Y_MIN, band_strip, strip_cell_side
from pipeline.layout_plugins.base import (
    ColumnRoles,
    LayoutPlugin,
    LayoutResult,
    Role,
    build_spatial_cells,
    packed_ids,
    spatial_bbox,
)
# The ONE per-entry fingerprint rule (v2.10). Imported from the EMITTER, which is where the
# knob default maps the tuple is derived from already live, so no plugin hand-copies a tuple.
from pipeline.manifest import role_entry_fingerprints

if TYPE_CHECKING:
    import pyarrow as pa

    from pipeline.atlas import ThumbnailCache


logger = logging.getLogger(__name__)


def _to_epoch(value: object, fmt: str) -> float | None:
    """Map a parsed metadata datetime value to REAL UTC SECONDS. ingest.py already
    validated/parsed the column (TIMESTAMP for iso8601, BIGINT epoch for unix_*).

    The format scales an INTEGER value only. A stored timestamp is already an instant, so
    no format moves it. Until #391 the ÷1000 for `unix_millis` was applied to every value
    after this function, a timestamp's included: `unix_millis` committed over a stored
    timestamp baked every date at a thousandth of itself (golden's axis on 1970-01-19)."""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        # ingest stored a naive TIMESTAMP; treat as UTC for a deterministic order.
        return value.replace(tzinfo=_dt.timezone.utc).timestamp()
    if isinstance(value, _dt.date):
        return _dt.datetime(value.year, value.month, value.day, tzinfo=_dt.timezone.utc).timestamp()
    if isinstance(value, (int, float)):
        seconds = float(value)  # unix_seconds / unix_millis are BIGINT
        return seconds / 1000.0 if fmt == "unix_millis" else seconds
    raise TypeError(f"unexpected datetime value {value!r} ({type(value).__name__})")


_EPOCH = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)


# --- Calendar-aligned bucketing (T2-138) --------------------------------------
# The datetime layout is a temporal HISTOGRAM: cells sharing a time bucket stack into a
# column. Buckets align to NICE CALENDAR boundaries (Jan 1 / month 1st / midnight …) rather
# than a sqrt(n) equal-TIME grid, so every column lands exactly on the axis tick for its
# interval. The old grid placed each cell at its bucket CENTRE on a ~span/sqrt(n)-wide
# bucket (~4.2 yr for rijks over 1100-2020), so an image could sit ±2 yr from its true
# date — inconsistent drift the v2.5 axis exposed. The interval is auto-picked (finest that
# keeps the column count in budget) and LOGGED (the "we inform" half of the knob doctrine;
# a UI surface + override is the Seam-2 follow-on).

# Finest→coarsest ladder: (kind, step, average_seconds). Month/year lengths vary, so
# average_seconds is ONLY the estimate that picks the rung; real boundaries come from
# _floor_interval (true calendar flooring).
_MIN_S = 60.0
_HOUR_S = 3600.0
_DAY_S = 86400.0
_MONTH_S = 2629746.0  # 30.436875 d
_YEAR_S = 31556952.0  # 365.2425 d
_INTERVAL_LADDER: list[tuple[str, int, float]] = [
    ("second", 1, 1.0), ("second", 5, 5.0), ("second", 15, 15.0), ("second", 30, 30.0),
    ("minute", 1, _MIN_S), ("minute", 5, 5 * _MIN_S), ("minute", 15, 15 * _MIN_S), ("minute", 30, 30 * _MIN_S),
    ("hour", 1, _HOUR_S), ("hour", 3, 3 * _HOUR_S), ("hour", 6, 6 * _HOUR_S), ("hour", 12, 12 * _HOUR_S),
    ("day", 1, _DAY_S),
    ("month", 1, _MONTH_S), ("month", 3, 3 * _MONTH_S),
    ("year", 1, _YEAR_S), ("year", 2, 2 * _YEAR_S), ("year", 5, 5 * _YEAR_S), ("year", 10, 10 * _YEAR_S),
    ("year", 25, 25 * _YEAR_S), ("year", 50, 50 * _YEAR_S), ("year", 100, 100 * _YEAR_S),
    ("year", 250, 250 * _YEAR_S), ("year", 500, 500 * _YEAR_S), ("year", 1000, 1000 * _YEAR_S),
]
# Column budget = the classic SQUARE-ROOT histogram rule, RELAXED by _BUCKET_RELAX.
#
# sqrt(n) is the aspect-optimal bin count (it balances columns against stack depth, which is
# what the pre-T2-138 grid used), but on its own it is too coarse for calendar alignment:
# sqrt(48_779) ≈ 221 columns over rijks's 920 years snaps to 5-YEAR buckets, so a 1637 work
# still lands on the 1635 tick — aligned, yet visibly not its own year. Relaxing by 5×
# buys per-YEAR precision there (5·221 ≈ 1104 ≥ 920 columns) while still refusing splits so
# fine that the histogram stops being one: cells are squares of side min(column pitch, stack
# pitch), so a 1-image-per-column split makes every cell as thin as one column (256 images
# over 256 distinct days → a hairline of specks; the tiler then can't even build a coarse
# tier). The relaxed rule keeps that case at MONTHS, and delivers the "1-3 years is better
# by month" case (100 images / 2 years → 24 months, not 730 near-empty days), while a
# 10-photo/10-day set still resolves per DAY. _MAX_BUCKETS_HARD caps the column count
# outright (tile/vertex sanity at 1M).
_MAX_BUCKETS_HARD = 2000
_BUCKET_RELAX = 5.0
# datetime spans years 1..9999; a malformed role (e.g. a unix_seconds role fed millis →
# year ~52,000) can't be calendar-floored, so those fall back to the legacy equal-time grid
# + a declined axis.
_MIN_SEC = (_dt.datetime(1, 1, 1, tzinfo=_dt.timezone.utc) - _EPOCH).total_seconds()
_MAX_SEC = (_dt.datetime(9999, 12, 31, 23, 59, 59, tzinfo=_dt.timezone.utc) - _EPOCH).total_seconds()

# The x an UNDATED cell carries between "the histogram refused it" and "`band_strip` placed
# it" (U1 / T2-140). Deliberately NOT a position: outside [0,1], so it can never be mistaken
# for a column and `build_spatial_cells`'s `_clamp01` pins any leak to x=0 — clear of the
# placement line, which starts at `margin`. It was `margin` in the first draft of this seam,
# which is EXACTLY `range[0]`, the first bucket's tick: a leak there would have re-created
# T2-140's own defect (an undated image drawn on a real date) in its most plausible-looking
# form. Pinned by `test_undated_cells_are_off_the_chart`, whose x half exists for this.
_UNPLACED_X = -1.0


# --- Wrapped multi-image bins (H2 / D-36) -------------------------------------
# A bin is `k` images WIDE, filled row-major from the bottom, so a histogram BAR spans its
# bin instead of being one hairline column stretched away from its neighbours. `k` is
# UNIFORM across bins: with a per-bin `k` a 28-day February would get fewer columns than a
# 31-day January and two bins holding the SAME number of images would render at DIFFERENT
# heights — the histogram reading would break silently. With a uniform `k` a bar's height is
# `ceil(N_i/k)`, still proportional to the count up to that quantisation.

# Extra separation at EVERY bin boundary, in cell widths — the baked GUTTER (D-36 §7.1: a
# baked gutter, not an overlay-drawn rule, because the coarse tier is mosaic WebP and an
# overlay rule is absent exactly at the overview zoom where bin structure matters most).
#
# There are TWO sources of space and they are not the same thing. `fill` (0.85) leaves a
# 15 % margin around EVERY cell, so two images inside one bin are never edge to edge. The
# gutter is an EXTRA fraction of a cell spent only at bin boundaries, so that BIN BOUNDARIES
# ARE ALWAYS VISUALLY DISTINCT — the operator's stated reason (2026-07-27), and the one that
# still applies at `k = 1`, where there are no within-bin gaps to be told apart from. Where a
# bin does hold several images the two are also legible against each other: at the defaults
# the between-bin gap is `(1 - fill + g)*p_c` = 0.40 of a cell against `(1 - fill)*p_c` = 0.15
# within a bin, 2.7x. It is applied at every boundary INCLUDING `k = 1`, which costs
# `1/(1+g)` = 80 % of the pre-H2 cell size wherever the WIDTH term binds — the price of the
# separation, and the reason this is a module constant rather than a literal: the operator
# tunes it after looking at a bake.
#
# TUNING IT IS A ONE-LINE EDIT PLUS A RE-BAKE, not a one-line edit alone. It changes every
# baked coordinate, so committed trees stop reproducing: measured, setting it to 1.0 fails 13
# tests, including the golden fixture's `refresh-manifest` round trip. That is the same
# re-bake any geometry change needs (schemas/v2 CHANGELOG, "Behaviour changes"), not a reason
# not to tune it.
#
# RESIDUAL, NEVER INSERTED (D-36 §"The alignment invariant"): a block is left-aligned at its
# bin's tick and `k` is chosen so the space is left over at the RIGHT end. Nothing is ever
# added to the LEFT of a block, so no block can be pushed off its tick.
_BIN_GUTTER_CELLS = 0.25

# Month lengths in a NON-LEAP year, for `_min_interval_sec`.
_NON_LEAP_MONTH_DAYS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def _sec_to_dt(sec: float) -> _dt.datetime:
    """Real UTC seconds → aware datetime, overflow-safe for years 1..9999 (``_EPOCH +
    timedelta``, never ``utcfromtimestamp`` — which raises on pre-1970 on Windows)."""
    return _EPOCH + _dt.timedelta(seconds=sec)


def _floor_interval(dt: _dt.datetime, kind: str, step: int) -> _dt.datetime:
    """Floor a UTC datetime to its nice-calendar interval boundary (anchored at year 0 /
    month 1 / midnight) so buckets align with the axis ticks."""
    if kind == "year":
        return _dt.datetime(max(1, dt.year - dt.year % step), 1, 1, tzinfo=_dt.timezone.utc)
    if kind == "month":
        tm = dt.year * 12 + (dt.month - 1)
        tm -= tm % step
        y, m = divmod(tm, 12)
        return _dt.datetime(y, m + 1, 1, tzinfo=_dt.timezone.utc)
    if kind == "day":
        return _dt.datetime(dt.year, dt.month, dt.day, tzinfo=_dt.timezone.utc)
    if kind == "hour":
        return dt.replace(hour=dt.hour - dt.hour % step, minute=0, second=0, microsecond=0)
    if kind == "minute":
        return dt.replace(minute=dt.minute - dt.minute % step, second=0, microsecond=0)
    if kind == "second":
        return dt.replace(second=dt.second - dt.second % step, microsecond=0)
    # NOT a fall-through default (the lesson `_min_interval_sec` already learned one function
    # down): flooring an UNKNOWN kind as seconds is silent and wrong. A rung added to
    # `_INTERVAL_LADDER` + the schema enum + `_min_interval_sec` but not here would bucket by
    # seconds while the axis advertises the new kind — the exact producer/renderer drift this
    # seam exists to remove, uncaught. Fail loudly; the ladder<->arm gate is at the unit tier
    # (`test_every_ladder_rung_has_a_floor_and_min_interval_arm`), and [[T2-150]] tracks folding
    # both per-rung tables into the ladder tuple so a new rung cannot omit either at all.
    raise ValueError(
        f"_floor_interval has no arm for interval kind {kind!r} (step {step}). A rung added to "
        "`_INTERVAL_LADDER` needs its calendar-floor rule here AND a `_min_interval_sec` arm — "
        "all three Python tables, plus the schema `interval.kind` enum, describe one ladder."
    )


def _bucket_budget(n: int) -> int:
    """Max columns for ``n`` cells: the relaxed square-root rule, capped (see above). Never
    below 5 (the rule's own floor at n=1), so a tiny dataset still gets several columns
    rather than collapsing into one — which would decline the axis entirely."""
    return min(_MAX_BUCKETS_HARD, math.ceil(_BUCKET_RELAX * math.sqrt(max(1, n))))


def _select_interval(span_sec: float, n: int) -> tuple[str, int, float]:
    """The FINEST ladder rung whose bucket count over ``span_sec`` fits ``_bucket_budget``
    (finest-first, first-fit; the coarsest rung is the floor for an enormous span)."""
    budget = _bucket_budget(n)
    for kind, step, avg in _INTERVAL_LADDER:
        if math.ceil(span_sec / avg) <= budget:
            return kind, step, avg
    return _INTERVAL_LADDER[-1]


def _min_interval_sec(kind: str, step: int) -> float:
    """The SHORTEST real span one ``(kind, step)`` bucket can have, in seconds.

    `k` is sized off THIS, not off the ladder's ``average_seconds`` (D-36 §7.2), so a
    `k`-wide block provably fits EVERY bin of the rung rather than the average one. Sizing
    off the average would recover the difference (31/28 for months ≈ 10 % of `k`, ~2 % for
    quarters, ~0.3 % for years) but lets the narrowest bin's block overhang its neighbour by
    `(avg-min)/avg · k` cells — absorbed by the gutter at `k = 4` and not at `k = 20`, i.e.
    safe only for small `k`, which is a trap rather than a rule.

    The year arm returns a whole non-leap year per step, which is a floor rather than the
    exact shortest aligned window (an aligned 5-year window always contains at least one leap
    day). Under-estimating is the SAFE direction — it only makes `k` more conservative."""
    if kind == "year":
        return step * 365.0 * _DAY_S
    if kind == "month":
        # The shortest ALIGNED run of `step` months. The ladder's month rungs are 1 (Feb, 28 d)
        # and 3 (Q1 of a non-leap year, 90 d), both of which divide the year; any future step
        # that does not falls back to the conservative all-Februaries floor.
        if 12 % step == 0:
            return _DAY_S * min(
                float(sum(_NON_LEAP_MONTH_DAYS[i:i + step])) for i in range(0, 12, step)
            )
        return step * 28.0 * _DAY_S
    if kind == "day":
        return step * _DAY_S          # UTC — no DST, so every day is exactly 86400 s
    if kind == "hour":
        return step * _HOUR_S
    if kind == "minute":
        return step * _MIN_S
    if kind == "second":
        return float(step)
    # NOT a fall-through default. This function is a SECOND per-rung table alongside
    # `_INTERVAL_LADDER` and `_floor_interval`, and the three must agree for every rung. A
    # silent seconds default is the worst possible failure: measured, adding a ('week', 1)
    # rung to the ladder AND a `week` arm to `_floor_interval` — the two edits the change
    # obviously needs — left this returning 1.0 instead of 604800, which makes `k_time`
    # ~600,000x too large and bakes a layout of 2.0e-08-wide cells with a zero-height bbox:
    # invisible, with no error. Fail loudly instead, and see [[T2-150]] for folding the
    # minimum into the ladder tuple so a new rung cannot omit it at all.
    raise ValueError(
        f"_min_interval_sec has no arm for interval kind {kind!r} (step {step}). A rung "
        "added to `_INTERVAL_LADDER` needs its SHORTEST real span here and a matching "
        "`_floor_interval` arm — all three tables describe the same ladder."
    )


class BinSolve(NamedTuple):
    """What `_solve_bin_width` decided: the bin width, the cell pitch, the resulting row
    count, and WHICH bound set the pitch. The caller logs `width_bound` rather than
    re-deriving it — one authority for the decision, so a third bound added here cannot
    leave the operator-facing log quietly reporting one of the old two."""

    k: int
    pitch: float
    rows: int
    width_bound: bool


def _solve_bin_width(
    populations: list[int],
    denom: float,
    min_int: float,
    gap_sec: float,
    usable: float,
    box_h: float,
) -> BinSolve:
    """Solve the bin width ``k`` (images per bin, UNIFORM across bins) and the per-image cell
    pitch ``p_c`` JOINTLY — H2 / D-36 §"The geometry".

    The two are coupled: a wider bin trades stack DEPTH for WIDTH at a constant cell count,
    so raising `k` relaxes the height constraint and tightens the width one. For a given `k`
    the largest feasible pitch is the smaller of

      * ``W(k) = usable / (k·(I+1) + g·I)`` with ``I = denom/min_int`` — the WIDTH bound. One
        shortest-rung interval is `(k+g)` cell pitches wide, so the placement line is
        `(k+g)·p_c·I` long and the LAST bin's block adds `k·p_c` to the RIGHT of it: together
        they must fit the band. Budgeting that trailing block is what stops the last bin
        bleeding past `1-margin`, where ``build_spatial_cells``'s `_clamp01` would silently
        squash it and `spatial_bbox` would under-report (#186's rider 3). STRICTLY DECREASING.
      * ``H(k) = box_h / ceil(N/k)``, ``N = max(populations)`` — the HEIGHT bound: the tallest
        block must fit the histogram's box. NON-DECREASING, and a step function.
        `max_i ceil(N_i/k) == ceil(max_i N_i / k)` because `ceil(·/k)` is monotone in the
        population, so only the DEEPEST bin is needed — verified over 30,000 random
        population sets.

    SOLVED, NOT SEARCHED (the D-36 H2 review; there is no `_MAX_BIN_WIDTH_CELLS` any more).
    `H − W` is non-decreasing, so `{k : H(k) ≤ W(k)}` is a PREFIX and `min(W, H)` rises across
    it (`p_c = H`, non-decreasing) then falls after it (`p_c = W`, decreasing). The optimum is
    therefore the prefix boundary — found by bisection, with its two neighbours evaluated
    because `H` is a step function. Ties go to the SMALLER `k` (fewer, taller bars read as a
    histogram more readily than wider, shorter ones at equal cell size).

    The old exhaustive loop stopped at an arbitrary `k ≤ 64` "far past the useful range". It
    was not: measured, 1M images in one bucket wants `k = 692`, and stopping at 64 baked a
    0.8 %-wide ribbon with cells 10.8x smaller than the geometry allows — the very sliver this
    seam exists to remove, at the scale the project targets. Nothing needs a ceiling: `k > N`
    can never help (`ceil(N/k)` is already 1, so `H` is maxed while `W` keeps shrinking), so
    `N` IS the bound, derived rather than chosen.

    THE `gap_sec` FILTER exists for one reachable case, not for tidiness. `min_int` is the
    shortest interval the RUNG can produce, but `_floor_interval`'s `max(1, year - year%step)`
    clamp can produce a bucket SHORTER than that (year 1 → year 2 is one year on the 2-year
    rung, 0.5 of `min_int`), and then a `k`-wide block would run past its neighbour's tick.
    Feasibility is `k ≤ (k+g)·r` for `r = gap_sec/min_int`, i.e. `k·(1−r) ≤ g·r` — closed
    form, no loop: unbounded when `r ≥ 1`, else `k ≤ g·r/(1−r)`. `k = 1` is returned even when
    it is itself infeasible on that clamp; there H1's `side` cap (`min_col_gap` in `compute`)
    takes over, exactly as it did pre-H2."""
    g = _BIN_GUTTER_CELLS
    intervals = denom / min_int
    deepest = max(populations)

    def width_at(k: int) -> float:
        return usable / (k * (intervals + 1.0) + g * intervals)

    def height_at(k: int) -> float:
        return box_h / -(-deepest // k)

    # `k > deepest` cannot help (see the docstring), and the clamp's feasibility bound is
    # closed-form. Both are DERIVED bounds, not chosen ones.
    k_cap = deepest
    r = gap_sec / min_int
    if r < 1.0:
        k_cap = min(k_cap, int(g * r / (1.0 - r)))
    k_cap = max(1, k_cap)

    # Largest k in [1, k_cap] with H(k) <= W(k) — the prefix boundary. `lo` stays 1 when the
    # prefix is empty, which is correct: p_c = W there and W is decreasing, so k = 1 wins.
    lo, hi = 1, k_cap
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if height_at(mid) <= width_at(mid):
            lo = mid
        else:
            hi = mid - 1

    best = BinSolve(1, 0.0, deepest, False)
    for k in dict.fromkeys((1, lo, min(lo + 1, k_cap))):   # ordered, de-duplicated
        w, h = width_at(k), height_at(k)
        p_c = min(w, h)
        if p_c > best.pitch:                              # strict: ties keep the smaller k
            best = BinSolve(k, p_c, -(-deepest // k), w < h)
    return best


class DateTimeLayout(LayoutPlugin):
    name = "datetime"

    def required_columns(self) -> list[Role]:
        return [Role.DATETIME]

    def compute(
        self,
        meta: "pa.Table",
        roles: ColumnRoles | None,
        atlas: "ThumbnailCache",
        config: dict,
    ) -> LayoutResult:
        if roles is None or roles.datetime is None:
            raise ValueError("datetime layout requires a datetime role")

        ids = packed_ids(atlas)
        n = len(ids)

        meta_ids = [int(v) for v in meta.column("id").to_pylist()]
        raw = meta.column(roles.datetime.column).to_pylist()
        epoch_by_id = {cid: _to_epoch(val, roles.datetime.format) for cid, val in zip(meta_ids, raw)}
        times = [epoch_by_id.get(cid) for cid in ids]

        margin = 0.04
        known = [t for t in times if t is not None]
        # min/max over `known` (up to 1M) scanned ONCE, reused by `have_span`, `calendar_ok`,
        # and the calendar branch below (they were three back-to-back O(n) scans of the same
        # values). 0.0 when empty is a placeholder never read while `have_span` is False.
        if known:
            t_min, t_max = min(known), max(known)
            have_span = t_max > t_min
        else:
            t_min = t_max = 0.0
            have_span = False
        # The TIGHTEST real distance between the last cell of one block and the first cell of
        # the next, filled in by the calendar branch below and used to cap the drawn cell side
        # (see `side`). inf = "no constraint" — the legacy branch's columns are uniformly
        # `col_pitch` apart, which is already wider than `fill * col_pitch`.
        min_col_gap = float("inf")
        # H2: the bin WIDTH in images and the per-image cell pitch, solved jointly by
        # `_solve_bin_width` in the calendar branch. The legacy branch has no calendar bins,
        # so it keeps one image per column (`bin_k = 1`) and its own separate column/stack
        # pitches — `stack_pitch` stays None there and becomes `box_h/max_stack` below.
        bin_k = 1
        col_pitch = 0.0
        stack_pitch: float | None = None
        n_undated = n - len(known)
        # The cells the time axis CANNOT place (U1 / T2-140), by position in `ids`. Filled in
        # by the calendar branch only: they leave the histogram for the unplaced strip. The
        # legacy branch declines its axis, so nothing there maps an x to an instant and the
        # holding behaviour (undated cells snap into a real column) is left alone.
        strip_k: list[int] = []
        # The histogram's usable HEIGHT, and equivalently the TOP of the unplaced band below
        # it. The calendar branch always reserves `y in [STRIP_Y_MIN, 1]` — unconditionally,
        # even with nothing to put there, so the geometry is independent of the undated COUNT
        # and of whether any image is undated at all (D-36 §"Backlog reconciliation": "reserve
        # the band"). It is a FIXED reservation, not a growing one: sizing it to hold the
        # strip's rows at this layout's cell size was tried and measured to shrink every DATED
        # cell up to 11x, re-creating the coupling U1 exists to remove. Where the reserved band
        # cannot hold the rows, `strip_cell_side` shrinks the STRIP's own cells instead.
        box_h = 1.0

        # `times` are REAL UTC SECONDS under every format: `_to_epoch` is the ONLY place the
        # format scaling is applied, and it applies it to integer values only. Everything
        # downstream — bucketing, `denom`, `k_time`, and the ISO `domain` rendered by
        # `_sec_to_dt` — reads them as they are.
        # Calendar bucketing needs floorable extremes (years 1..9999); a malformed role can
        # exceed that, so fall back to the legacy equal-time grid (axis declined below).
        calendar_ok = have_span and all(_MIN_SEC <= t <= _MAX_SEC for t in (t_min, t_max))

        # bucket_x: the per-cell x BEFORE stacking; col_key groups cells into columns.
        if have_span and calendar_ok:
            box_h = STRIP_Y_MIN
            sec_min, sec_max = t_min, t_max
            # U1: the rung is chosen from the DATED count. `_bucket_budget` is 5*sqrt(count),
            # so passing `n` let undated images buy columns for dates that do not exist and
            # drag the ladder far finer than the dated cells can fill. Measured on this
            # plugin: 200 photos over 200 days alone pick ('month', 1) -> 7 columns, cell
            # side 2.742e-02; the same 200 photos plus 19,800 undated picked ('hour', 12) ->
            # 200 columns of ONE image each, cell side 4.293e-05 (638x smaller) — precisely
            # the "hairline of specks" the `_BUCKET_RELAX` note says the budget prevents.
            # Same coupling as `S` below, one step earlier. Pinned by
            # `test_undated_cells_do_not_move_the_interval_rung`.
            # The ladder's average-seconds column picks the RUNG and nothing else since H2;
            # the geometry runs on `_min_interval_sec` (the shortest real bucket) instead.
            kind, step, _ = _select_interval(sec_max - sec_min, len(known))
            base_dt = _floor_interval(_sec_to_dt(sec_min), kind, step)
            base_sec = (base_dt - _EPOCH).total_seconds()
            usable = 1.0 - 2 * margin
            bucket_sec: list[float | None] = [
                (_floor_interval(_sec_to_dt(t), kind, step) - _EPOCH).total_seconds()
                if t is not None
                else None
            for t in times
            ]
            # The placement line runs FIRST bucket start -> LAST bucket start (both are real
            # occupied bins), so the emitted axis range never extends past the images. Ending
            # it at the raw t_max instead would leave the last bin short of the line's end
            # (t_max sits INSIDE its bucket) and push `range` outside the framed bbox. (Pre-H1
            # the columns then filled [margin, 1-margin] exactly; since H1 the LINE is
            # [margin, margin + k_time*denom], and since H2 the last bin's block adds
            # `bin_k*p_c` of cells to the RIGHT of it — so it is the block edges, not the
            # line, that reach 1-margin when the WIDTH term binds.)
            last_sec = max(bs for bs in bucket_sec if bs is not None)
            # ZERO when every dated cell floors into ONE bucket, and left at zero. It used to
            # be replaced with a fabricated 1.0, which was inert pre-H1 (it only made the old
            # `column_term` large, i.e. non-binding) but is a REAL INPUT since H2: `denom`
            # feeds `intervals` in the width bound, so a fabricated one-second span budgets
            # horizontal room for a placement line that does not exist. Measured on 256 images
            # inside one second: the fake solved k=11 / p_c=0.0400 where the truthful zero
            # solves k=16 / p_c=0.0575 — every cell 44 % smaller for nothing — and the log
            # below reported "x=[0.04, 0.93], 89.0 % of the box" against a real drawn extent
            # of [0.043, 0.477], 43.4 %. Zero is not a divisor anywhere downstream: `intervals`
            # multiplies, `k_time` divides by `min_int`, and `x_hi = margin + k_time*denom`
            # correctly collapses to `margin` for a line with no length.
            denom = last_sec - base_sec
            # One column per distinct DATED bucket. UNDATED cells have no bucket, so they get
            # no column and no x on this line at all (U1 / T2-140): they leave the histogram
            # for the unplaced strip below it, `band_strip`'s band `y in [STRIP_Y_MIN, 1]` —
            # the same off-chart treatment scatter/geographic give a cell with a missing
            # coordinate. Until U1 they were PARKED in the dated column nearest the middle of
            # the placement line, which drew them at an x the emitted axis maps to a real
            # instant: an image with no date rendered as though it had one. Nothing is
            # dropped — every image is still a row in the positions table, still drawn, just
            # visibly separated (dropping one needs an `id` column the positions table does
            # not have — [[T2-139]] / seam U2).
            dated_pop = Counter(bs for bs in bucket_sec if bs is not None)
            strip_k = [k for k in range(n) if bucket_sec[k] is None]
            # H1 (D-36): the cell PITCH comes from the CELL SIZE, not from the band width, and
            # the time scale `k_time` is derived FROM it. H2 (D-36) adds the second half: a bin
            # is `bin_k` images WIDE, so the pitch solve trades stack DEPTH for bin WIDTH at a
            # constant cell count. `_solve_bin_width` owns both terms and says why; here the
            # only thing to know is that `p_c` is the pitch of ONE IMAGE (in x AND in y), and
            # one shortest-rung interval is `(bin_k + gutter)` of them wide.
            #
            # `x` stays exactly LINEAR IN SECONDS (never in interval index — months differ in
            # length), so temporal gaps stay visible and the emitted axis is still exactly the
            # placement line; only the scale factor changes. Before H1 `k_time` was pinned to
            # the band (`usable/denom`), which forced the extreme columns to `margin` /
            # `1-margin` however few they were; before H2 a bin was one image wide, so a deep
            # bin could only be stretched away from its neighbours, never filled.
            #
            # WHICH TERM BINDS is about PEAKEDNESS, not span: a broad span raises the interval
            # count and the interval length together and they cancel, so broad-span corpora
            # are NOT automatically width-bound. Measured on the live datasets at H1, both are
            # STACK-bound: rijks_pilot I=920 / S=1199 and nasa I=1275 / S=2842. Real
            # collections cluster — museum works pile onto round years, phone photos onto
            # trips, bulk imports onto one timestamp — so the peaked regime is the COMMON case
            # for user uploads, not the exception, and it is the one H2 exists for.
            #
            # The bin POPULATIONS are needed BEFORE placement (they set `ceil(N_i/k)`), so
            # they are counted from `dated_pop` rather than read off the stacking loop below.
            # `max(dated_pop.values())` IS that loop's `max_stack`: bins are keyed by x, x is
            # injective in the bucket start, and — since U1 — only DATED cells are in a bin.
            #
            # U1 (T2-140) CUT the undated cells out of those populations. Counting them in
            # meant the number of images with NO DATE set the scale of the time axis: they all
            # landed in ONE parking column and made it the deepest. Measured on the pre-U1
            # plugin, adding 2000 undated images to 4000 works over 250 uniform years took
            # `range` from [0.04, 0.96] to [0.04, 0.163511385] — the drawn extent 7.4x
            # narrower and every cell 7.4x smaller (side 0.003141 -> 0.000422) — for no gain
            # whatever. On the DoD's own corpus, 3000 photos over 900 days, it was
            # [0.04, 0.273693611] -> [0.04, 0.053865075], 16.9x. The populations are dated-bin
            # only, so `range` and every dated `x` are exactly what the same corpus WITHOUT
            # the undated images bakes — pinned by `test_undated_cells_do_not_move_the_axis`.
            #
            # DATED bins only for the tightest spacing too: undated cells no longer occupy a
            # bin, so the tightest real bin spacing is a property of the dated buckets alone.
            col_secs = sorted(dated_pop)
            gap_sec = min(
                (b - a for a, b in zip(col_secs, col_secs[1:])), default=float("inf")
            )
            min_int = _min_interval_sec(kind, step)
            solve = _solve_bin_width(
                list(dated_pop.values()), denom, min_int, gap_sec, usable, box_h
            )
            bin_k, p_c = solve.k, solve.pitch
            col_pitch = stack_pitch = p_c
            k_time = (bin_k + _BIN_GUTTER_CELLS) * p_c / min_int   # world units per second
            # The tightest real distance between two ADJACENT CELLS of different bins: the
            # tick-to-tick distance less the `bin_k - 1` pitches the left block spends getting
            # to its own last column. `_solve_bin_width`'s `gap_sec` filter guarantees this is
            # >= `p_c` for every `bin_k` it can return above 1, so the cap below only ever
            # binds at `bin_k == 1` — which is exactly the H1 case it was added for.
            #
            # It is needed because `min_int` is the shortest interval the RUNG can produce,
            # while _floor_interval's `max(1, ...)` year clamp can make a REAL bucket shorter
            # still (year 1 -> year 2 is 0.4997 of the 2-year rung). Below `fill` those squares
            # OVERLAP — measured 41 % of a cell on a ('year', 2) bake carrying 1st-century
            # dates, where pre-H1 the same fixture had 2.9 cell-widths of clearance because
            # `side` took the strictly smaller `row_h`. Measuring the real tightest spacing is
            # O(bins), not O(cells), and caps `side` so no ladder rung — present or future —
            # can draw one cell on top of another.
            #
            # The year clamp has a SECOND consequence this cap does not address, recorded so
            # the next reader does not have to re-derive it: `max(1, ...)` makes that first
            # bucket START on year 1, which is not a boundary of the rung it belongs to (the
            # 2-year rung's boundaries are even years). The alignment invariant still holds —
            # `domain[0]` IS that bucket start, so the axis places the block exactly where it
            # is drawn — but no tick the ladder emits can land on it, in a plugin whose whole
            # purpose is that bins land on ticks. Reachable only with 1st-century dates on a
            # multi-year rung, which is why it is a comment and not a fix; the honest fix is
            # to let the first bucket keep its true (year <= 0) start rather than clamping,
            # which needs a calendar representation that goes below year 1.
            min_col_gap = k_time * gap_sec - (bin_k - 1) * p_c
            # H5 (D-36 §7.5): CENTRE the histogram in the frame. Since H1 the pitch comes from
            # the CELL SIZE rather than from the band width, so a pitch-bound layout is
            # NARROWER than the band — and before H5 every bit of that slack sat on the RIGHT,
            # because the line starts at `margin` unconditionally. The case that prompted this
            # (D-36 §7.5, measured on the live nasa bake 2026-07-30 — NOT re-measured here,
            # this plugin's suite has no access to that tree): 224,990 rows over 106.3 yr on
            # the ('month', 1) rung drew x = [0.040, 0.626], 58.5 % of the box, so a third of
            # the frame was empty on one side while the chart hugged the left edge.
            #
            # `drawn` is the DRAWN width: the placement line plus the LAST bin's own block,
            # which is only as wide as the images it holds, so a sparse tail bin does not
            # reserve `bin_k` pitches of extent (the same `min(N_last, k)` the schema's
            # `range`/`bbox_exact` gap relation uses). It is computed HERE, once, and the
            # operator log below reports the same value — the log's whole job is to say how
            # wide the bake came out, so a second derivation is a second thing to go stale.
            #
            # ONE offset, applied to `x_norm` here AND to `x_lo`/`x_hi` in the annotation
            # below. They are two descriptions of ONE line: shift one and the axis lies about
            # where the cells are, which is exactly the class of defect T2-138 was. It is a
            # RIGID TRANSLATION, so the alignment invariant is mathematically INVARIANT under
            # it — which is why the T2-138 pin cannot validate this and
            # `test_the_axis_moves_with_the_centred_placement` exists.
            #
            # WHICH BAKES MOVE is "does the ink already fill the band", NOT "which term set the
            # pitch". `drawn <= usable` always — `p_c <= usable/(bin_k*(I+1) + g*I)` and
            # `drawn = p_c*((bin_k+g)*I + min(N_last, bin_k))` — so the slack is never
            # genuinely negative and `max(0.0, ...)` guards FLOAT ERROR alone (measured
            # -1.1e-16 on a width-bound bake), leaving such a bake bit-for-bit untouched. A
            # width-bound bake is usually one of those, but not always: with a last bin sparser
            # than `bin_k` the trailing block the width bound budgeted for is not filled, and
            # that bake is genuinely narrow and genuinely centres — measured, 41/37/1 images
            # over three month bins solves k = 4 width-bound yet draws only 70.94 % of the box,
            # so it shifts by 0.105. Centring it is the point, not an exception to it.
            last_block = min(dated_pop[last_sec], bin_k)
            drawn = k_time * denom + last_block * p_c
            x_offset = max(0.0, (usable - drawn) / 2.0)
            # The placement line's LEFT EDGE, bound ONCE and reused by every description of the
            # line — `x_norm` here, the operator log below, and the axis `x_lo`/`x_hi`. They are
            # the SAME line (T2-138); one shared binding makes that structural, instead of three
            # far-apart expressions each re-adding `margin + x_offset` and kept in agreement by
            # hand — which is precisely the "second expression that happens to agree" the axis
            # comment below warns against.
            x_start = margin + x_offset
            # An undated cell has no place on this line; `_UNPLACED_X` is a non-position that
            # `band_strip` overwrites below (BOTH coordinates — the x half is the load-bearing
            # one; see the constant's note).
            #
            # H2 SEMANTIC CHANGE: `x_norm` is now the block's LEFT EDGE, not a column centre —
            # where a histogram bar's boundary belongs. The cells of the bin sit at
            # `x_norm + (col + 0.5)*p_c` (added below, once the wrap is known), so they extend
            # to the RIGHT of the tick and the LAST bin's block reaches `k*p_c` past `range[1]`
            # — which `_solve_bin_width`'s width bound budgets for.
            #
            # H5's centring lives in `x_start` (= margin + x_offset). UNDATED cells are NOT on
            # this line, so they are NOT shifted: they keep `_UNPLACED_X` exactly as-is.
            x_norm = [
                _UNPLACED_X if bs is None else x_start + k_time * (bs - base_sec)
                for bs in bucket_sec
            ]
            col_key: list[float] = [x for x in x_norm]
            # The "we inform" half of the knob doctrine, for all three automatic decisions: the
            # rung, the bin width, and which term set the pitch (so how wide the histogram
            # therefore came out). The drawn extent is the number an operator needs to spot a
            # stack-bound bake that has packed into a sliver of the box (it is also the input
            # that drags the tiler's fine-tier depth ceiling down, T2-143), and it is otherwise
            # invisible until a much later `refresh-manifest` gate failure. Since H5 it is the
            # CENTRED extent — the same `x_start` and `drawn` the placement used, so the reported
            # span is where the ink actually is (it straddles 0.5 rather than starting at
            # `margin`). Reporting the pre-shift one is the failure this shares a
            # variable to avoid: the fabricated-`denom` bug already had this log claiming
            # "x=[0.04, 0.93], 89.0 %" against a real extent of [0.043, 0.477], 43.4 %.
            deepest = max(dated_pop.values())
            logger.info(
                "datetime layout: %d dated cell(s) bucketed by %s%s (%d bin(s) over "
                "%s..%s), %d image(s) wide x %d row(s) deep; pitch set by the %s -> the "
                "histogram spans x=[%.6g, %.6g], %.1f%% of the box",
                len(known),
                f"{step} " if step != 1 else "",
                kind + ("s" if step != 1 else ""),
                len(dated_pop),
                _sec_to_dt(base_sec).date().isoformat(),
                _sec_to_dt(sec_max).date().isoformat(),
                bin_k,
                solve.rows,
                "bin width" if solve.width_bound
                else f"deepest bar ({deepest} cells over {solve.rows} rows)",
                x_start,
                x_start + drawn,
                100.0 * drawn,
            )
            # A bar is `ceil(N_i/bin_k)` rows tall, so bins holding `bin_k` images or fewer ALL
            # draw exactly one row and their counts become indistinguishable. That is inherent
            # to a uniform `k` (a per-bin `k` would make equal counts render at unequal heights
            # — a worse lie), and the trade is real: a wider bin buys bigger, visible images
            # and costs height resolution. It is the operator's call which they want, so SAY
            # SO rather than let the chart quietly under-report. [[T2-151]] tracks exposing the
            # trade as a knob.
            flattened = sum(1 for pop in dated_pop.values() if pop <= bin_k)
            if bin_k > 1 and flattened:
                logger.warning(
                    "datetime layout: bins are %d image(s) wide, so the %d of %d bin(s) "
                    "holding <= %d image(s) all draw a single row — bar height cannot "
                    "distinguish their counts (deepest bin %d images -> %d rows). Bar height "
                    "is quantised to %d image(s); the alternative is smaller cells",
                    bin_k, flattened, len(dated_pop), bin_k, deepest, solve.rows, bin_k,
                )
            if len(dated_pop) == 1:
                # Not an error: the bake is valid and the axis is declined below, so nothing
                # renders a time scale. But a one-bucket histogram shows no distribution OVER
                # TIME — it is a grid with extra steps — and the operator should know their
                # datetime layout is not telling them anything grid does not. Declining to
                # emit the layout at all is the better answer and needs a plugin-level
                # "decline" signal this module cannot add on its own; [[T2-152]].
                logger.warning(
                    "datetime layout: all %d dated image(s) fall in ONE %s%s bucket (%s), so "
                    "this layout shows no distribution over time — it draws a single block "
                    "and its axis is declined. Consider a finer datetime column, or drop the "
                    "datetime layout for this dataset",
                    len(known),
                    f"{step} " if step != 1 else "",
                    kind + ("s" if step != 1 else ""),
                    _sec_to_dt(base_sec).date().isoformat(),
                )
            if strip_k:
                # The "we inform" half again, for the one thing the axis alone cannot say:
                # how many images this layout could NOT date. Also emitted into the manifest
                # as the layout entry's `missing_count` (U1b surfaces it to the user).
                logger.info(
                    "datetime layout: %d of %d image(s) have no date and are drawn in the "
                    "unplaced strip below the histogram (world y >= %g), not on the time "
                    "axis; the count is emitted as the layout's `missing_count`",
                    len(strip_k),
                    n,
                    STRIP_Y_MIN,
                )
        else:
            # LEGACY equal-time grid: no span (all-equal/all-missing → x ≡ 0.5) or a
            # calendar-unrepresentable extreme. The axis is declined in both cases.
            if have_span:
                t_min, t_max = min(known), max(known)
                span = t_max - t_min
                x_norm = [
                    margin + (1.0 - 2 * margin) * ((t - t_min) / span) if t is not None else 0.5
                    for t in times
                ]
            else:
                t_min = t_max = 0.0
                x_norm = [0.5] * n
            if have_span:
                # R1: a malformed role (classically a `unix_seconds` role fed MILLISECOND
                # values → year ~52,000) can't be calendar-floored. The LAYOUT is still
                # valid (x is normalized, so a huge span merely skews it — the pre-2.5
                # behaviour), so DEGRADE GRACEFULLY: legacy grid + declined axis + a warning
                # naming the column and the offending extremes (D-11 spirit: informative,
                # never fatal).
                logger.warning(
                    "datetime axis domain omitted for column %r: an extreme timestamp "
                    "(t_min=%r, t_max=%r, format=%r) falls outside representable calendar "
                    "years 1-9999 (e.g. a unix_seconds role fed millisecond values); the "
                    "layout baked normally (legacy equal-time grid) — only the axis "
                    "annotation and calendar bucketing are skipped, both of which need "
                    "floorable dates",
                    roles.datetime.column,
                    t_min,
                    t_max,
                    roles.datetime.format,
                )
            ncols = max(1, math.ceil(math.sqrt(n)))
            col_pitch = 1.0 / ncols
            col_key = [float(min(ncols - 1, max(0, int(x / col_pitch)))) for x in x_norm]
            # The column's LEFT EDGE, matching H2's calendar convention — the shared placement
            # below adds the `(col + 0.5)*col_pitch` centring, and this branch is always
            # `bin_k == 1`, so it lands on the same `(c + 0.5)*pitch` it always did. There is
            # no wrapping here: no calendar bins, no rung, no `min_int` to size `k` off.
            x_norm = [c * col_pitch for c in col_key]
            calendar_ok = False
            bucket_sec = [None] * n

        # v2.5 (T2-69 / T2-72 Seam 2): capture the x-axis TIME DOMAIN the layout computes
        # then otherwise discards, so the renderer draws the datetime axis from a real
        # producer domain (replacing the Seam-1 getMetadata-sampling shim).
        #
        # The axis describes THE SAME LINE the placement uses (T2-138): a bin's block starts
        # at `margin + x_offset + k_time*(bucket_start - base)`, so the axis maps
        # `domain=[first bucket start, LAST bucket start] → range=[x_lo, x_lo + k_time*denom]`
        # (both endpoints are real occupied bins — see the denom note above). H1 (D-36)
        # narrowed that upper end: `range[1]` is short of `1-margin` whenever the pitch comes
        # from the cell size. H2 (D-36) narrows it again and changes what a tick MEANS: with
        # `bin_k > 1` the tick marks the block's LEFT EDGE — where a histogram bar's boundary
        # belongs — not a column centre, and the block's cells extend `bin_k*p_c` to its right.
        # H5 (D-36) translates BOTH ends by `x_offset` so the whole line sits centred in the
        # frame; because it is the SAME offset the placement used, the identity below is
        # untouched by it (which is also why the T2-138 pin cannot detect an error in it).
        # The consumer's t→x inverse then reproduces the bake EXACTLY, and because buckets are
        # floored to nice calendar boundaries, the tick for an interval lands ON that
        # interval's bar — every bin, not just the endpoints. (The pre-T2-138 code snapped
        # `range` to the extreme sqrt(n) column CENTRES, which fixed only the endpoints and
        # left interior columns up to half a ~4-yr bucket adrift.) `domain` starts at the
        # FLOORED first bucket start, NOT the raw t_min — that is where the first bar begins.
        #
        # An axis the producer DECLINES emits the explicit ``{"axes": []}`` marker rather
        # than nothing (PR-180 review): absent annotations mean "pre-2.5 bake — the client
        # may derive a domain via its getMetadata shim", so a 2.5 refusal must be
        # distinguishable or the shim resurrects exactly the axis the producer refused
        # (e.g. the R1 overflow case would fit + render year-52,000 ticks). Declined cases:
        # a degenerate span (all-equal / all-missing dates → x ≡ 0.5), a single occupied
        # column (no drawable extent), and the R1 calendar overflow below.
        annotations: dict | None = {"axes": []}
        if have_span and calendar_ok:
            # EXACTLY the placement line: base_sec → x_lo, last_sec → x_lo + k_time*denom
            # (short of 1-margin by the last block's `bin_k*p_c` when the WIDTH term binds,
            # shorter still when the cell size sets the pitch — H1/H2 — and no longer starting
            # at `margin` at all once H5's centring shifts a narrow line right). `range` is
            # emitted at 9 dp, NOT the 6 dp `bbox` uses:
            # 6 dp costs up to 5e-7 at the far endpoint, and since the consumer reconstructs
            # the line FROM these two numbers that error lands directly in the alignment
            # identity — measured 3.2e-7 on a packed fixture, i.e. 90 % of the 1e-6 pin's
            # budget spent on rounding rather than on float32 storage (which is ~3e-8). At
            # 9 dp the endpoint error is <= 5e-10 and the pin keeps its ~33x headroom in
            # BOTH regimes instead of 33x in one and 3x in the other. The digits are free;
            # `bbox_exact` exists in this schema because 6 dp was not enough for the same
            # class of reason. 9 dp still prints exactly 0.96 where the columns bind.
            # CONSEQUENCE of the mismatched precisions: `range` is the containment partner of
            # `bbox_exact`, NOT of the 6-dp `bbox`. Equal-precision rounding was monotone, so
            # pre-H1 `range[1] <= bbox[2]` held at 6 dp too; now `bbox[2] = round(x_hi +
            # side/2, 6)` can round BELOW `round(x_hi, 9)` once `side/2 < 5e-7`, i.e. one
            # bucket holding >= ~851k cells. The contract gate already checks `bbox_exact`.
            # H5 (D-36 §7.5): the SAME `x_start` the placement above used — the shared binding,
            # not a second expression that happens to agree. These two numbers and `x_norm` are
            # the two descriptions of one line, and the whole T2-138 guarantee is that they match.
            x_lo = x_start
            x_hi = x_start + k_time * denom
            # A single occupied bucket has no drawable extent → decline (all cells share one x).
            if len(dated_pop) > 1:
                # R1 (verification rider): rendering the domain endpoints to ISO calendar
                # dates is only defined for years 1..9999. A malformed role — classically a
                # `unix_seconds` role fed MILLISECOND values (~year 52,000) — overflows
                # datetime here. The LAYOUT itself is still valid (x is normalized, so a
                # huge span merely skews it — exactly the pre-2.5 behaviour), so DEGRADE
                # GRACEFULLY: emit the declined-axis marker + warn (naming the column + the
                # offending extremes — the D-11 spirit: informative, never fatal), rather
                # than fail the whole datetime bake.
                try:
                    domain = [
                        _sec_to_dt(base_sec).isoformat(),
                        _sec_to_dt(last_sec).isoformat(),
                    ]
                except (OverflowError, ValueError, OSError):
                    logger.warning(
                        "datetime axis domain omitted for column %r: an extreme timestamp "
                        "(t_min=%r, t_max=%r, format=%r) falls outside representable calendar "
                        "years 1-9999 (e.g. a unix_seconds role fed millisecond values); the "
                        "layout baked normally — only the axis annotation is skipped",
                        roles.datetime.column,
                        t_min,
                        t_max,
                        roles.datetime.format,
                    )
                else:
                    axis: dict = {
                        "orientation": "x",
                        "scale": "time",
                        "domain": domain,
                        "range": [round(x_lo, 9), round(x_hi, 9)],
                        # v2.7 (H3 / D-36): the LADDER RUNG this bake binned at, so the
                        # renderer can put its ticks on bin boundaries it was TOLD about
                        # rather than re-deriving a second ladder that has to be kept in
                        # sync by discipline — which is precisely what failed: the plugin
                        # owns 25 rungs across six kinds and `overlayLayer.niceTimeTicks`
                        # owned YEARS ONLY, so T2-138's every-bin-lands-on-its-tick
                        # guarantee only BIT where the two lists happened to coincide, and
                        # a month- or day-binned dataset got a correct but UNLABELLED axis.
                        #
                        # `kind`/`step` are the selector's own answer, passed through
                        # unchanged — never re-derived here, or this would be the same two
                        # ladders one function apart. `_floor_interval` is the flooring rule
                        # they name, and `domain[0]` is the first bucket start it produced,
                        # so a consumer has everything it needs to walk the bin boundaries.
                        # Emitted UNCONDITIONALLY with the axis (no default, never omitted),
                        # so its ABSENCE means exactly one thing to H4: a pre-2.7 bake.
                        "interval": {"kind": kind, "step": step},
                        "label": roles.datetime.label,
                    }
                    annotations = {"axes": [axis]}

        # Fill each bin in CHRONOLOGICAL order (the bin KEY is the bucket's x — cells sharing
        # a calendar bucket share a bin, and within it the earliest-dated takes slot 0). STRIP
        # cells are excluded: they are not in any bin, so they must not deepen one (that is
        # the population coupling, seen from the filling side — `max_stack` still equals the
        # `deepest` the pitch was solved from). `slot` is the within-bin index `j` that H2
        # wraps: `col = j % bin_k`, `row = j // bin_k`.
        _LAST = float("inf")
        order_t = [_LAST if t is None else t for t in times]
        on_chart = [True] * n
        for k in strip_k:
            on_chart[k] = False
        running: dict[float, int] = defaultdict(int)
        slot = [0] * n
        chart_k = [k for k in range(n) if on_chart[k]]
        for k in sorted(chart_k, key=lambda k: (col_key[k], order_t[k], ids[k])):
            slot[k] = running[col_key[k]]
            running[col_key[k]] += 1
        max_stack = max(running.values()) if running else 1
        # The row pitch. In the calendar branch it IS the cell pitch `p_c` (H2): a bin's block
        # is a lattice of square cells one `p_c` apart in BOTH axes, so a short histogram stays
        # short instead of being stretched to fill the box — that vertical stretch was where
        # the pre-H2 width-bound bake put its whitespace (holes BETWEEN stacked cells).
        # `_solve_bin_width` capped `p_c` at `box_h/ceil(N/k)`, so the tallest bar still fits.
        # The LEGACY branch has no `p_c`: its rows divide the box by the deepest stack, as
        # before.
        row_h = stack_pitch if stack_pitch is not None else box_h / max_stack

        # SQUARE cells (T2-117): draw every cell as a single square whose side is `fill` of
        # the cell pitch, so a temporally-peaked dataset no longer bakes "smashed" wide
        # rectangles (rijks_pilot baked 7.4:1 from ncols=222 / max_stack=1643, drawn
        # faithfully by the isotropic renderer). Only the DRAWN size is squared — the bin
        # x-positions and the row y-positions are set by the pitches above.
        fill = 0.85
        # `2*margin` is a LEGACY-BRANCH cap only. That branch has `col_pitch = 1/ncols` with no
        # relation to the stack depth, so without it a cell can be drawn many stack-pitches
        # wide, overlapping its neighbours and hanging outside the box where `_clamp01` hides
        # it and `spatial_bbox` under-reports. Pinned by the [None]*n case in
        # `test_cells_stay_inside_the_unit_square`, which is why `row_h` stays in the `min`.
        #
        # It is NOT applied on the calendar branch any more, because H2's width bound makes it
        # unreachable there and H5's centring only tightens that. The rightmost drawn edge sits
        # at `x_start + drawn - 0.5*p_c + fill*p_c/2 = margin + (usable + drawn)/2 - 0.5*p_c +
        # fill*p_c/2` (H5: `x_offset + drawn = (usable + drawn)/2`), and `drawn <= usable` makes
        # it `<= 1 - margin - 0.075*p_c`; the leftmost is `margin + x_offset + 0.075*p_c >=
        # margin + 0.075*p_c` for ANY `p_c` (`x_offset >= 0`) — centring only moves both extremes
        # INWARD, so the pre-H5 bound still holds. The y bound follows from
        # `p_c <= box_h/rows`. Kept, it only SHRANK cells — measured, 5.11x on a two-cells-
        # one-second-apart bake (`p_c = 0.4089` drawn at `0.85*0.08 = 0.068`) — buying an
        # escape that cannot happen. One fewer arbitrary constant on the path that has a real
        # geometric bound.
        #
        # ...then capped by the TIGHTEST REAL adjacent-BLOCK cell distance (`min_col_gap`
        # above), because `min_int` is the shortest interval the RUNG can produce while
        # `_floor_interval`'s year clamp can produce a shorter bucket still. The cap is applied
        # ONLY WHEN IT BINDS, and carries `fill` when it does:
        #
        #   * it must not fold into the `min(...)` above. Pre-H2 `min_col_gap` was *always*
        #     slightly under `pitch` (a real interval is shorter than its rung's average — the
        #     month rung's February is 0.9199 of it), so folding it in shrank EVERY month-rung
        #     layout by 8 %, buying nothing: at 0.9199 there was no overlap to prevent.
        #     Measured, and it moved the golden fixture — do not "simplify" to that form. Since
        #     H2 the gap is measured against `min_int` rather than the average, so this is
        #     doubly true: `min_col_gap >= p_c > fill*p_c` for every `bin_k > 1` the solve can
        #     return, and folding it in would still cost the year-clamp case its own cap.
        #   * where it does bind, `fill * min_col_gap` rather than the bare gap, so the pair
        #     keeps the same 15 % visual separation every other pair has instead of ending up
        #     edge-to-edge. Bin boundaries stay visually distinct (D-36 §Gutter, operator
        #     2026-07-27; H2 generalises this with `_BIN_GUTTER_CELLS`) — one rule, rather
        #     than two that disagree at the edge case.
        #
        # Binds only on the `_floor_interval` year clamp today (a 2-year rung's first bucket
        # sits 1 year from its neighbour, 0.4997 of the rung minimum) — where pre-H1 the same
        # fixture had 2.9 cell-widths of clearance, and uncapped H1 overlapped by 41 % of a
        # cell. Also a standing guard for any rung added later. Pinned by
        # `test_adjacent_columns_never_overlap`.
        uncapped = min(col_pitch, row_h) * fill
        if stack_pitch is None:                     # LEGACY branch only — see above
            uncapped = min(uncapped, 2 * margin * fill)
        side = uncapped if uncapped <= min_col_gap else fill * min_col_gap
        w = h = side
        # H2: WRAP each bin's chronological fill index `j` into a `bin_k`-wide block —
        # `col = j % bin_k` left to right, `row = j // bin_k` bottom to top — so a histogram
        # BAR spans its bin instead of being one hairline column. `x_norm` is the block's LEFT
        # EDGE (the bin's tick), and the cell sits `(col + 0.5)` pitches to the RIGHT of it:
        # the gutter is the space left over at the block's right end, NEVER an offset added to
        # its left (which would push every bin off its tick — D-36 §"The alignment invariant").
        # STRIP cells keep `_UNPLACED_X` untouched; `band_strip` overwrites both coordinates
        # below, and leaving the placeholder exactly as-is keeps it clear of [0,1] even if a
        # future edit ever lets one leak through.
        xs = [
            x_norm[k] + (slot[k] % bin_k + 0.5) * col_pitch if on_chart[k] else x_norm[k]
            for k in range(n)
        ]
        # row 0 (first-filled in a bin) gets the LARGEST world-y here. The renderer's camera
        # is y-flipped (large world-y = screen BOTTOM — see renderer/world.ts and scatter.py's
        # orientation note), so row 0 sits at the bottom and taller bars grow UPWARD on
        # screen: "count increases upward", the same convention scatter bakes north-up
        # (T2-85). (The prior note "earliest stacks at top" described the [0,1] coordinate
        # VALUE, not the flipped screen position, and read backwards.)
        #
        # The bar BASE is `box_h`, not 1.0: row 0's centre sits half a row above it, so its
        # lower edge lands exactly ON `box_h` (side <= row_h) and the band below is free for
        # the strip. Since box_h == STRIP_Y_MIN in the calendar branch, the histogram ends
        # precisely where `band_strip`'s band begins.
        ys = [box_h - (slot[k] // bin_k + 0.5) * row_h for k in range(n)]
        if strip_k:
            # U1 (T2-140): the UNPLACED STRIP, scatter's/geographic's `band_strip` — an
            # id-ordered sub-grid across `y in [box_h, 1]`. Reusing their helper (rather than
            # a datetime-local strip) keeps "this cell has no value for the column this layout
            # arranges by" reading identically in every family.
            #
            # SEPARATION, re-measured on this branch after the H2 cell-size change (the
            # figures that were here had been carried over unchanged from pre-H2 and had gone
            # stale by 2.4x-12x — `side`, which every one of them depends on, is exactly what
            # H2 tripled). The two POPULATIONS never mix: every histogram square is wholly
            # above STRIP_Y_MIN (row 0's lower edge lands exactly on it) and every strip
            # cell's CENTRE is below it.
            #
            # The drawn SQUARES no longer touch or escape either. Pre-fix the strip inherited
            # the histogram's `side` and `band_strip` absorbed the density in its ROW PITCH
            # alone, so H2's larger cells hung past y=1 — measured, 100 photos over 11 weeks
            # plus ONE undated went from a last-row bottom edge of 0.98995 (inside) to 1.00983,
            # 50 + 50 reached 1.029, and `spatial_bbox` clamped `bbox[3]` back to 1.0 so the
            # manifest under-reported it. `strip_cell_side` sizes the strip's OWN cells to the
            # band instead. Growing the band to fit the histogram's cells was the other
            # candidate and is measured in that function's note: it shrinks every DATED cell up
            # to 11x, which is the coupling U1 exists to prevent.
            strip_side = strip_cell_side(len(strip_k), side)
            strip = band_strip([ids[k] for k in strip_k], strip_side)
            for k in strip_k:
                xs[k], ys[k] = strip[ids[k]]
        ws, hs = [w] * n, [h] * n
        if strip_k and strip_side < side:
            for k in strip_k:
                ws[k] = hs[k] = strip_side

        return LayoutResult(
            layout_id=self.name,
            layout_type="datetime",
            label="By date",
            cells=build_spatial_cells(ids, xs, ys, ws, hs),
            bbox=spatial_bbox(xs, ys, ws, hs),
            edges=None,
            # v2.5: the time-axis domain — plus, since v2.7 (H3 / D-36), the `interval` rung
            # it was binned at — or the explicit {"axes": []} declined-axis marker
            # (degenerate span / single column / calendar overflow — see above).
            annotations=annotations,
            # v2.6 (U1 / T2-140): how many images this layout could NOT date — a null,
            # absent, or UNPARSEABLE datetime value (`known` keeps only what `_to_epoch`
            # resolved, so a malformed string counts here too). Emitted on the LAYOUT, not
            # the axis, precisely so a DECLINED axis still reports it: a
            # single-occupied-bucket decline runs the CALENDAR branch, so its undated cells
            # ARE in the strip and a count that vanished with the axis would leave the viewer
            # an unexplained band. manifest.py writes it unconditionally, 0 included.
            #
            # It counts what could not be DATED, and promises nothing about where those cells
            # went: only the CALENDAR branch strips them. The legacy fallback below (no span,
            # or a calendar-unrepresentable extreme) still parks them mid-canvas — which is
            # not the T2-140 lie, because that branch declines the axis outright, so no x
            # maps to an instant. A consumer must read `annotations.axes` to know which
            # regime it is in; the count alone does not say.
            #
            # `n_undated`, not `len(strip_k)`: the two are EQUAL in the calendar branch
            # (`strip_k` is exactly the null-date cells), and they differ only in the LEGACY
            # fallback, which keeps the pre-U1 parking (see the `else:` above) and would
            # otherwise report 0 for a corpus that is, say, entirely undated. The honest
            # number is "images this layout could not date" — a property of the DATA — not
            # "images that reached the strip", a property of which branch ran.
            missing_count=n_undated,
            # v2.9 provenance: the ONE timestamp column this layout arranges by. The role's
            # `format` is a parsing knob, not a dependency — it lives in `column_roles` and
            # changing it re-reads the same column — so only the column NAME is recorded.
            source_columns=(roles.datetime.column,),
            # v2.10: HOW it read that column — this entry's own tuple, which DOES carry the
            # `format` knob, because a layout baked under `iso8601` no longer matches a
            # declaration that says `unix_seconds`. Built from the same role entry the line
            # above names, by the one tuple function, never by hand.
            source_fingerprint=role_entry_fingerprints("datetime", roles.datetime),
        )
