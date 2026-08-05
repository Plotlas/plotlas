"""Shared placement machinery for the SCATTER and GEOGRAPHIC layout families (D-35).

This module owns the SHARED FIT machinery both families run: partition ids into PLACED
(both coords finite) vs UNPLACED (null/missing coord), size a uniform square cell from
the placed count, the median-centred aspect fit + T2-85 north-up inversion, and the
absolute-band unplaced strip (``band_strip``). The GEOGRAPHIC family PROJECTS lon/lat
first (equirectangular or Web Mercator — Seam G2) and then runs exactly this fit path;
the SCATTER family runs the same fit path for ``normalize: "fit"`` (its default).

The scatter ``normalize: "none"`` PASS-THROUGH path (uniform ×0.95 scale, extent-derived
cell size, and the data-adjacent BLOCK strip — the 2026-07-20 G1 hardening) is
SCATTER-ONLY and lives inline in ``scatter.py``; the geographic family always fits, so it
never touches it. These fit helpers are byte-for-byte the hardened-G1 ``scatter.py`` code
(the fit path was untouched by that hardening); G1's unit tests + the golden fixture prove
scatter's output is unchanged across the extraction, and ``geographic.py`` composes the
same helpers so the two families place identically downstream of their coordinate source.
"""
from __future__ import annotations

import math

# Fraction of the equivalent grid pitch a cell fills (grid.py's fill spirit).
_FILL = 0.9
# Placed cells fit into the box x ∈ [0, PLACED_X_MAX], y ∈ [0, PLACED_Y_MAX];
# the unplaced strip is the band y ∈ [STRIP_Y_MIN, 1.0] below it.
PLACED_X_MAX = 1.0
PLACED_Y_MAX = 0.95
STRIP_Y_MIN = 0.96


def _quantile(sorted_vals: list[float], q: float) -> float:
    """The ``q``-quantile (0..1) of an ascending list by linear interpolation between
    order statistics (NumPy's default ``method="linear"`` / Hyndman–Fan type 7). No
    NumPy dependency — a per-axis sort + one interpolation is enough here."""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    pos = q * (n - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return sorted_vals[lo]
    frac = pos - lo
    return sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac


def aspect_fit(
    xs: list[float], ys: list[float], box_w: float, box_h: float
) -> tuple[list[float], list[float]]:
    """Fit ``(xs, ys)`` into the box ``[0, box_w] x [0, box_h]`` with a SINGLE uniform
    scale, centred on the data's per-axis MEDIAN — so the data's true 2-D aspect ratio is
    preserved (no per-axis stretch) and the dense data mass sits in the middle of the box.
    Geographic lon/lat keep their real proportions; embeddings keep their shape (O2-C). A
    degenerate axis (all values equal) collapses to the box centre on that axis; an
    all-identical point set maps to the box centre.

    Framing (Scatter Seam S1, T2-35): the fit centres on the per-axis MEDIAN (not the raw
    span midpoint ``(min+max)/2``), and the shared scale is sized to the FULL data extent
    measured FROM the median — the larger of each axis's two median-to-extreme reaches — so
    EVERY point, sparse tail included, lands inside the box with NO clipping. Median-centring
    un-jams the asymmetric case the operator flagged ("California clipped left"): a
    globe-spanning sparse tail no longer shoves the dense western-hemisphere bulk into the
    left margin, because the data MASS (median) — not the span midpoint — is centred; no
    percentile clip crops outliers (it was near-worthless at the production tile budget —
    see ``docs/spikes/spike_scatter_deep_dive.md``). When the median coincides with the span
    midpoint (a symmetric cloud) this reduces to the plain aspect fit. The wide-geo
    tile-budget subsampling that remains is the deferred #67 fix, NOT a clip."""
    xs_sorted, ys_sorted = sorted(xs), sorted(ys)
    xmed, ymed = _quantile(xs_sorted, 0.5), _quantile(ys_sorted, 0.5)
    # Size the shared scale so the FURTHER of each axis's two median-to-extreme reaches
    # still fits in the box half-extent — then every point is within half a box of the
    # median, so nothing spills past an edge (no clip) while the median stays centred and
    # the aspect is preserved (one scale for both axes). A degenerate axis has reach 0 and
    # contributes no candidate; its points map exactly to the box centre (x - med == 0).
    reach_x = max(xmed - xs_sorted[0], xs_sorted[-1] - xmed)
    reach_y = max(ymed - ys_sorted[0], ys_sorted[-1] - ymed)
    candidates: list[float] = []
    if reach_x > 0:
        candidates.append((box_w / 2.0) / reach_x)
    if reach_y > 0:
        candidates.append((box_h / 2.0) / reach_y)
    if not candidates:  # single point / all-identical — both axes degenerate
        return [box_w / 2.0] * len(xs), [box_h / 2.0] * len(ys)
    scale = min(candidates)
    px = [box_w / 2.0 + (x - xmed) * scale for x in xs]
    py = [box_h / 2.0 + (y - ymed) * scale for y in ys]
    return px, py


def aspect_fit_north_up(xs: list[float], ys: list[float]) -> tuple[list[float], list[float]]:
    """The default (``fit``) placement shared by scatter and geographic: the
    median-centred, aspect-preserving fit into the placed box, then the T2-85 north-up
    y-inversion within ``[0, PLACED_Y_MAX]``. A HIGHER input y renders HIGHER on screen
    (the standard chart convention, and north-up for geographic latitude): the renderer's
    world camera is y-flipped (screen-y grows DOWNWARD — see ``renderer/world.ts``), so a
    larger input y must map to a SMALLER world y. The inversion is a pure vertical
    reflection, an isometry, so the fit's extents + centring are preserved."""
    px, py = aspect_fit(xs, ys, PLACED_X_MAX, PLACED_Y_MAX)
    return px, [PLACED_Y_MAX - y for y in py]


def as_finite(value: object) -> float | None:
    """The value as a finite float, or None (⇒ the cell is unplaced). ingest
    fail-fasts on non-finite non-empty values (D-11), so in the real path only
    nulls land here; the guard keeps compute() total — never raising, never
    dropping a cell — on hand-built tables too."""
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def partition_placed(
    ids: list[int], coord_by_id: dict[int, tuple[object, object]]
) -> tuple[list[int], list[float], list[float], list[int]]:
    """Split ``ids`` (ascending) into ``(placed, placed_a, placed_b, unplaced)`` by
    coordinate finiteness: a cell is PLACED iff BOTH its coords are finite floats, else
    UNPLACED (a null/missing coord, or no metadata row after the D-25 left join)."""
    placed: list[int] = []
    placed_a: list[float] = []
    placed_b: list[float] = []
    unplaced: list[int] = []
    for cid in ids:
        raw_a, raw_b = coord_by_id.get(cid, (None, None))
        fa, fb = as_finite(raw_a), as_finite(raw_b)
        if fa is not None and fb is not None:
            placed.append(cid)
            placed_a.append(fa)
            placed_b.append(fb)
        else:  # no metadata row after the D-25 left join, or a null coord
            unplaced.append(cid)
    return placed, placed_a, placed_b, unplaced


def cell_side(placed_count: int, total_count: int) -> float:
    """The uniform square cell size for ALL cells, from the placed-cell count (grid.py's
    fill-factor spirit); all-unplaced falls back to the total."""
    basis = placed_count if placed_count else total_count
    return _FILL / max(1, math.ceil(math.sqrt(max(basis, 1))))


def strip_cell_side(unplaced_count: int, max_side: float) -> float:
    """The largest square side ``<= max_side`` whose rows fit the unplaced band
    ``[STRIP_Y_MIN, 1]``, so ``band_strip`` never draws a cell past ``y = 1``.

    ``band_strip`` fits its rows by shrinking the ROW PITCH, not the cells, so a band too
    short for its content does not crush — it OVERFLOWS: the last row's squares hang past
    ``y = 1``, where ``_clamp01``/``spatial_bbox`` clamp the bbox back to 1.0 and the manifest
    silently under-reports the real footprint (the tiler then bakes no tile for the sliver, and
    "fit view" frames it out). A caller whose cells are sized independently of the strip — the
    datetime histogram, whose D-36 H2 cells are ~3x the pre-H2 size — asks for a side that
    actually fits instead.

    THE BAND ITSELF DOES NOT GROW, and that is the point. Growing it to hold the rows at the
    caller's own cell size was tried and measured: it re-couples the PLACED geometry to the
    unplaced COUNT, which is exactly what T2-140 / D-36 seam U1 removed. On 200 dated images
    over 200 days, a band grown in proportion to its content shrank every DATED cell by 1.90x
    at 500 undated, 3.26x at 2000, and 11.07x at 19,800 — the same order as the 7.4x-16.9x
    pre-U1 regression. Absorbing the shortfall in the STRIP's own cell size instead leaves the
    chart untouched, and is the honest place for it: a parked cell is not a placed one.

    Bisection on the same arithmetic ``band_strip`` uses (``cols = floor(1/s)``,
    ``rows = ceil(m/cols)``, fits iff ``s <= (1-STRIP_Y_MIN)/rows``) rather than a closed
    form, because both floors make the predicate a step function. It is monotone in ``s`` — a
    smaller cell gives more columns and so never more rows — so bisection is exact.

    Callers that do NOT ask for this keep the shipped overflowing behaviour: scatter and
    geographic size their cells from the placed count, and shrinking them here would move
    every one of their baked coordinates. Their overflow is [[T2-144]]."""
    if unplaced_count <= 0 or max_side <= 0.0:
        return max_side
    band = 1.0 - STRIP_Y_MIN

    def fits(s: float) -> bool:
        rows = math.ceil(unplaced_count / max(1, math.floor(1.0 / s)))
        return s <= band / rows

    if fits(max_side):
        return max_side
    lo, hi = 0.0, max_side
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if fits(mid):
            lo = mid
        else:
            hi = mid
    return lo


def band_strip(unplaced: list[int], side: float) -> dict[int, tuple[float, float]]:
    """The ABSOLUTE-BAND unplaced strip (the fit-mode strip): cells with a null/missing
    coordinate placed in a small id-ordered sub-grid across the bottom band
    ``y ∈ [STRIP_Y_MIN, 1.0]``, so no cell is ever dropped (D-10: the id set is identical
    across a dataset's layouts). Used by the geographic family and by scatter's ``fit``
    path (and as the fallback for scatter's pass-through block when the data spans the
    canvas). Scatter's pass-through data-adjacent BLOCK strip is a separate, scatter-only
    layout that lives in ``scatter.py``.

    Rows are pitched to fill the band whatever ``side`` is; pass a ``side`` from
    ``strip_cell_side`` if the cells must also FIT it (see that function for why the band
    does not simply grow instead)."""
    strip_cols = max(1, math.floor(1.0 / side))
    strip_rows = math.ceil(len(unplaced) / strip_cols)
    row_pitch = (1.0 - STRIP_Y_MIN) / strip_rows
    out: dict[int, tuple[float, float]] = {}
    for j, cid in enumerate(unplaced):  # id order — `unplaced` is ascending
        col, row = j % strip_cols, j // strip_cols
        out[cid] = ((col + 0.5) / strip_cols, STRIP_Y_MIN + (row + 0.5) * row_pitch)
    return out
