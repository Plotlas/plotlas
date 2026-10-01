"""Scatter layout: places cells at user-supplied pre-computed 2-D coordinates
(UMAP/t-SNE/custom — decision D-26).

Placement: an **aspect-preserving** fit of the entry's x/y columns over the
*placed* cells into the box ``x ∈ [0, 1]``, ``y ∈ [0, 0.95]`` — BOTH axes share a
single scale (so the data's true 2-D aspect is preserved; geographic lon/lat keep
their real proportions) and the fit is **centred on the data's per-axis MEDIAN**, with
the scale sized to the FULL data extent so EVERY point — sparse tail included — lands
inside the box with NO clipping (Scatter Seam S1, T2-35; see ``_placement.aspect_fit`` and
``docs/spikes/spike_scatter_deep_dive.md``). Median-centring is the cheap framing fix
for the operator's "California clipped left / why crop at all" review: a globe-spanning
sparse tail no longer shoves the dense bulk into a margin (the visible problem was
span-MIDPOINT centring, not a clip), and no percentile clip crops outliers. O2-C
(2026-06-15) replaced the R1 per-axis-stretch spec, which distorted geographic aspect;
the robust-span + edge-clip framing (#104) is in turn superseded by S1 (the clip was
near-worthless at the production tile budget and pile-jammed ~7% of cells at the margin
— the deep-dive memo). A degenerate axis collapses to the box centre on that axis; the
residual wide-geo tile-budget subsampling is the deferred #67 fix (framing only here).

**Orientation — ``y_column`` increases UPWARD (T2-85, confirmed correct live 2026-07-07).**
After the aspect fit the placed y is INVERTED within the placed band
(``y' = PLACED_Y_MAX − y``), so a
HIGHER ``y_column`` value renders HIGHER on screen — the standard chart convention, and
"north-up" for geographic latitude. The renderer's world camera is y-flipped (an
orthographic projection whose screen-y grows DOWNWARD — see ``renderer/world.ts``
``applyCamera`` / the ``drawOverview`` DoubleSide note in ``renderer/tilePyramid.ts``),
so a larger ``y_column`` must map to a SMALLER world y to sit higher on screen. Without
the inversion lat/lon rendered flipped (north at the bottom — operator-confirmed live,
T2-85). The inversion is a pure vertical REFLECTION within ``[0, PLACED_Y_MAX]``, an
isometry: it preserves the shared-scale, median-centred aspect fit (extents and the
0.475 vertical centring are unchanged; a point at the top edge simply reflects to the
bottom, still inside the box). Embeddings (UMAP/t-SNE) carry no inherent
orientation, so this is semantically neutral for them; it only rights geographic data.
The **unplaced strip stays at the BOTTOM band** (``y ∈ [STRIP_Y_MIN, 1.0]``), unaffected
by the inversion. NB the framing reaches an existing dataset only on RE-BAKE
(baked-before trees keep their old fit until re-ingested). **Declared knobs (D-35 Seam G1,
schema v2.3), never sniffed:** per-axis ``x_scale``/``y_scale`` (``"linear"`` default |
``"log"``) applied BEFORE the fit (order: declared-log → fit → T2-85 y-invert; log is
monotone so north-up holds; both axes must share ONE scale — mixed log/linear is rejected
at the entry points because the shared-scale fit would crush the logged axis, T2-128), and
``normalize`` (``"fit"`` default | ``"none"`` — the T2-34 pass-through, which SKIPS the fit
and preserves the author's already-``[0,1]²`` coords EXACTLY up to one uniform ×0.95 scale
on both axes into the placed band ``[0, PLACED_Y_MAX]²``; no per-axis warp, no
re-centring, no north-up inversion — the author owns the projection. Cell size under
pass-through scales by the occupied raw span, so a sub-region placement keeps a sane
density instead of dragging the tiler's cell-size z-ceiling to 0; its unplaced strip is a
near-square block one gutter BELOW the occupied extent — adjacent, side-sized, so the
bbox stays tight and "no data" cells stay discoverable at the data's own zoom, never
intermixed with real datapoints — falling back to the absolute band when the block cannot
fit, i.e. exactly when the data spans the canvas and the band is adjacent anyway).
Default knobs reproduce the pre-G1 path byte-for-byte; the applied knobs are echoed into
the manifest ``options`` object. The ``overlap`` field is reserved (only ``"overdraw"``
implemented; ``"jitter"``/``"aggregate"`` fail-fast at both producer entry points — D-35
G4). An optional built-in geographic projection is a first-class family in D-35 Seam G2 —
see ``docs/scatter-coordinates.md`` and T2-34 / T2-35. Cells with null coordinates form
the **unplaced strip**: under ``fit``, a sub-grid in ``y ∈ [0.96, 1.0]``, ordered by id —
never dropped, so every layout carries the identical id set (D-10's id-join transitions).
Uniform square cell size for all cells, derived from the placed-cell count (grid.py's
fill-factor spirit; centre-level separation — footprints of adjacent cells can abut or
overlap at very small n, in fit and pass-through alike). Deterministic; coordinates are
explicit ``[0,1]^2`` floats.

The partition / cell-sizing / median-centred aspect fit / T2-85 north-up / absolute-band
strip live in ``_placement`` (shared with the geographic family, which PROJECTS first then
runs the identical fit path — Seam G2 extraction, byte-behaviour unchanged: the fit path
was untouched by the G1 hardening). This module owns the scatter-specific declared-knob
transform, the ``normalize: "none"`` PASS-THROUGH placement (uniform ×0.95 + extent-derived
cell size + the data-adjacent BLOCK strip — the 2026-07-20 hardening), and the ``options``
echo.
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

from pipeline.layout_plugins._placement import (
    PLACED_Y_MAX,
    aspect_fit_north_up,
    band_strip,
    cell_side,
    partition_placed,
)
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


class ScatterLayout(LayoutPlugin):
    name = "scatter"

    def required_columns(self) -> list[Role]:
        return [Role.SCATTER]

    def compute(
        self,
        meta: "pa.Table",
        roles: ColumnRoles | None,
        atlas: "ThumbnailCache",
        config: dict,
    ) -> LayoutResult:
        if roles is None or not roles.scatter:
            raise ValueError("scatter layout requires a scatter role")
        entry = roles.scatter[int(config.get("entry_index", 0))]

        ids = packed_ids(atlas)
        meta_ids = [int(v) for v in meta.column("id").to_pylist()]
        xs_raw = meta.column(entry.x_column).to_pylist()
        ys_raw = meta.column(entry.y_column).to_pylist()
        coord_by_id: dict[int, tuple[object, object]] = {
            cid: (x, y) for cid, x, y in zip(meta_ids, xs_raw, ys_raw)
        }

        placed, placed_x, placed_y, unplaced = partition_placed(ids, coord_by_id)

        # Uniform square cell size for ALL cells, from the placed-cell count
        # (grid.py's fill-factor spirit); all-unplaced falls back to the total.
        # Pass-through additionally scales this by the occupied extent (below).
        side = cell_side(len(placed), len(ids))

        # D-35 Seam G1 knobs (schema v2.3), DECLARED per entry — never sniffed from the
        # values. BOTH producer entry points fail-fasted on the knob preconditions
        # before reaching any plugin (config: unimplemented overlap / mixed scales /
        # none+log; values: log => strictly positive, none => within [0,1]) —
        # ingest_metadata via its hoisted validate_scatter_config + the CSV value
        # checks, run_add_layouts via _validate_roles_against_parquet's parquet twin —
        # so here the transform only APPLIES them. Default knobs (linear/linear/fit/
        # overdraw) reproduce the pre-G1 code path byte-for-byte.
        x_scale, y_scale, normalize = entry.x_scale, entry.y_scale, entry.normalize

        coords: dict[int, tuple[float, float]] = {}
        if placed:
            if normalize == "none":
                # PASS-THROUGH (T2-34): the author's already-normalized [0,1]² coords,
                # preserved EXACTLY up to ONE uniform scale — both axes are multiplied
                # by PLACED_Y_MAX so the user-owned square maps into the placed band
                # [0, 0.95]² and the missing-coordinate strip sits OUTSIDE the data
                # (operator direction 2026-07-20: adjacent BLOCK below the occupied
                # extent, gutter-separated — see the `if unplaced:` section — so a
                # real datapoint and a "no data" cell can never coincide; a single
                # shared factor on both axes preserves aspect, relative geometry, and
                # orientation exactly, and the camera frames content, so absolute
                # world coords are invisible). NO aspect fit, NO per-axis warp, NO
                # re-centring, and NO north-up inversion — the author owns the
                # projection. (A 'log' scale is rejected under 'none', so
                # placed_x/placed_y are the raw values.)
                px = [v * PLACED_Y_MAX for v in placed_x]
                py = [v * PLACED_Y_MAX for v in placed_y]
                # Extent-derived cell size (2026-07-20 review): pass-through does not
                # spread the data, so count-only sizing (calibrated for a full-canvas
                # spread) would dwarf a sub-region placement — oversized cells drag the
                # tiler's cell-size z-ceiling to 0 and the fine tier subsamples ~97%
                # on a regional-geo bake (measured). Scale the side by the occupied
                # raw span so density matches what the fit would give the same shape;
                # a degenerate all-coincident placement keeps the count-only fallback.
                span = max(
                    max(placed_x) - min(placed_x), max(placed_y) - min(placed_y)
                )
                if span > 0.0:
                    side *= span
            else:  # "fit" (default): declared per-axis scale -> aspect fit -> north-up
                # 1. declared per-axis natural log BEFORE the fit — monotone, so the
                #    north-up inversion below still holds; ingest guaranteed positivity.
                sx = [math.log(v) for v in placed_x] if x_scale == "log" else placed_x
                sy = [math.log(v) for v in placed_y] if y_scale == "log" else placed_y
                # 2. Aspect-preserving, MEDIAN-CENTRED fit into [0,1] x [0, PLACED_Y_MAX]
                #    then the T2-85 north-up y-inversion (both in _placement, shared with
                #    the geographic family, which runs this same path after projecting):
                #    one shared scale for both axes, centred on the data median with no
                #    clipping — geographic lon/lat keep their real proportions instead of
                #    being stretched per-axis to fill or jammed at a margin; a HIGHER
                #    y_column then renders HIGHER on screen (see the module docstring).
                px, py = aspect_fit_north_up(sx, sy)
            coords.update({cid: (x, y) for cid, x, y in zip(placed, px, py)})

        if unplaced:
            # Under PASS-THROUGH, place the strip as a near-square block ONE GUTTER
            # BELOW the occupied data extent instead of in the absolute bottom band
            # (2026-07-20 round-2 review): the canvas-fixed band is unreachable-far
            # from a sub-region placement — a SINGLE missing-coordinate cell blew the
            # layout bbox to ~850x the data (fit-view rendered the dataset as a
            # pixel-scale smudge), and the extent-derived `side` made the band a
            # hairline. Adjacent + side-sized, the strip is discoverable at the
            # data's own zoom and the bbox stays tight. Collision with real data is
            # impossible by ACTUAL extent + a one-cell gutter (better than the band's
            # centre-level guarantee — footprints clear too). Falls back to the
            # absolute band (_placement.band_strip) when the block cannot fit below the
            # data (large-span data — exactly the case where the band IS adjacent) or
            # when nothing placed (no extent to be adjacent to) — the fit-mode path.
            block_done = False
            if normalize == "none" and placed:
                cols = max(1, math.ceil(math.sqrt(len(unplaced))))
                rows = math.ceil(len(unplaced) / cols)
                anchor_y = max(py) + side  # one-cell gutter below the lowest data row
                if anchor_y + rows * side <= 1.0 and cols * side <= 1.0:
                    anchor_x = min(max(min(px), 0.0), 1.0 - cols * side)
                    for j, cid in enumerate(unplaced):  # id order — ascending
                        col, row = j % cols, j // cols
                        coords[cid] = (
                            anchor_x + (col + 0.5) * side,
                            anchor_y + (row + 0.5) * side,
                        )
                    block_done = True
            if not block_done:
                # Sub-grid across the absolute strip band, filled row-major in id order
                # (the fit-mode path, byte-for-byte pre-G1) — shared with the geographic
                # family and scatter's own fit mode.
                coords.update(band_strip(unplaced, side))

        xs = [coords[cid][0] for cid in ids]
        ys = [coords[cid][1] for cid in ids]
        ws = [side] * len(ids)
        hs = [side] * len(ids)

        # D-35 Seam G1: echo the APPLIED knobs into the manifest so the UI can EXPLAIN
        # this bake. Emit ONLY when a knob is non-default — an all-default scatter bake
        # carries options=None, so manifest.py omits the object and the output is
        # byte-for-byte pre-G1. (overlap is always 'overdraw' here — jitter/aggregate
        # fail-fast at BOTH producer entry points, ingest and add-layouts — but is
        # echoed for a complete, forward-compatible record.)
        applied = (x_scale, y_scale, normalize, entry.overlap)
        options: dict | None = (
            None
            if applied == ("linear", "linear", "fit", "overdraw")
            else {
                "x_scale": x_scale,
                "y_scale": y_scale,
                "normalize": normalize,
                "overlap": entry.overlap,
            }
        )

        return LayoutResult(
            layout_id=self.name,   # worker applies the multi-entry naming convention
            layout_type="scatter",
            label=entry.label or "Scatter",
            cells=build_spatial_cells(ids, xs, ys, ws, hs),
            bbox=spatial_bbox(xs, ys, ws, hs),
            edges=None,
            options=options,
            # v2.6 (U1 / T2-140): the cells this layout could NOT place — `partition_placed`
            # gates on FINITENESS, so this is null/absent coordinates AND non-finite ones
            # (a NaN in the column counts, and reads to a user as "no coordinate"). They are
            # drawn either in the absolute strip band or, on the `normalize: "none"`
            # pass-through, in the data-adjacent block above — so the count says HOW MANY,
            # never WHERE. The manifest described this population nowhere at all until now.
            # manifest.py writes the key unconditionally, 0 included.
            missing_count=len(unplaced),
            # v2.9 provenance: BOTH axis columns — a scatter layout consumes a PAIR, so a
            # change to either one stales it. `dict.fromkeys` keeps first-seen order (x then
            # y) and collapses the degenerate x_column == y_column case to one name: this is
            # the SET of columns depended on, and the pair structure is already recorded in
            # `column_roles` and echoed in `options`.
            source_columns=tuple(dict.fromkeys((entry.x_column, entry.y_column))),
            # v2.10: this PAIR's two tuples — one per axis, each naming its partner and the
            # four shaping knobs, which DO belong here (a `log` re-scale moves every cell).
            # A second pair sharing `x_column` adds a tuple to that column's union and none
            # to this record, so it cannot stale this layout. On the degenerate
            # x_column == y_column the single key carries BOTH tuples.
            source_fingerprint=role_entry_fingerprints("scatter", entry),
        )
