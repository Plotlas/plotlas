"""Geographic layout: places cells at real-world **lon/lat**, projected to the plane
then flowed through the shared scatter placement machinery (D-35 Seam G2 / T2-35).

A FIRST-CLASS layout family DISTINCT from scatter (operator 2026-07-19): the columns
MEAN longitude/latitude, so this plugin **projects first** — ``equirectangular`` (x from
lon, y from lat, 1° = 1°) or Web ``mercator`` (``y = ln(tan(π/4 + φ/2))``) — and THEN
reuses ``_placement`` verbatim: the median-centred, aspect-preserving fit (so the map
keeps its real proportions and frames without margin-jamming — Seam S1), the T2-85
north-up inversion, and the unplaced strip for cells with a missing coordinate. There
are NO scale knobs (degrees are degrees — D-35); the ONLY new pipeline step is the
projection, and everything downstream is the identical scatter code path.

**North-up (both projections).** Each projection's northing is MONOTONE INCREASING in
latitude (equirectangular: ``y = lat``; mercator: ``ln(tan(π/4 + φ/2))`` is strictly
increasing), so a larger latitude yields a larger fitted y and — after the shared T2-85
reflection within ``[0, PLACED_Y_MAX]`` — a SMALLER world y, which the y-flipped world
camera (``renderer/world.ts``) renders HIGHER on screen. So north is up for both
(``test_geographic`` proves it end to end).

**Mercator scale.** Longitude is projected to RADIANS and the northing uses the standard
dimensionless Web-Mercator formula, so at the equator ``dx/dλ = dy/dφ = 1`` (conformal) —
the aspect fit's single shared scale then preserves local shape. ``mercator`` is only
reached with ``|lat| <= 85.051129`` (the Web-Mercator clip latitude, beyond which the
northing diverges); ingest fail-fasts otherwise (D-11), so the projection never sees a
pole here.

**Options echo.** The baked ``projection`` (and ``overlap``) are echoed into the manifest
``options`` object so the UI can EXPLAIN the map and the future T2-86 continent underlay
can align by construction: ``projection`` IS this family's ``fit_transform.kind``
(spike §3 — ``mercator``|``equirectangular``), so a reader dispatches the underlay's own
projection from ``type == "geographic"`` + ``options.projection`` (D-35 Decision 5).
Missing/unparseable lon/lat → the standard unplaced strip; never dropped, so every layout
carries the identical id set (D-10).
"""
from __future__ import annotations

import math
from typing import TYPE_CHECKING, Callable

from pipeline.layout_plugins._placement import (
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


def _project_equirectangular(lon: float, lat: float) -> tuple[float, float]:
    """Equirectangular (plate carrée): x = lon, y = lat, 1° lon = 1° lat. The identity
    the current implicit scatter fit already approximates, so a regional lon/lat scatter
    keeps its shape on re-bake (D-35 §6.1). Valid for the full sphere incl. the poles
    (|lat| up to 90)."""
    return lon, lat


def _project_mercator(lon: float, lat: float) -> tuple[float, float]:
    """Web Mercator: x = lon in RADIANS, y = ``ln(tan(π/4 + φ/2))`` (φ = lat in radians).
    Longitude in radians keeps x on the same scale as the dimensionless northing, so at
    the equator the projection is conformal (``dx/dλ = dy/dφ = 1``) and the shared aspect
    fit preserves local shape. Monotone increasing in lat (north-up preserved). Only
    reached with ``|lat| <= 85.051129`` (ingest fail-fasts beyond — the northing diverges
    at the poles). E.g. y(0°) = 0, y(45°) ≈ 0.8814."""
    phi = math.radians(lat)
    return math.radians(lon), math.log(math.tan(math.pi / 4.0 + phi / 2.0))


# The two shipped projections (D-35: BOTH ship; default is a §6.1 bless item —
# equirectangular as proposed). Keyed by the GeographicRoleEntry.projection enum.
_PROJECTIONS: dict[str, Callable[[float, float], tuple[float, float]]] = {
    "equirectangular": _project_equirectangular,
    "mercator": _project_mercator,
}


class GeographicLayout(LayoutPlugin):
    name = "geographic"

    def required_columns(self) -> list[Role]:
        return [Role.GEOGRAPHIC]

    def compute(
        self,
        meta: "pa.Table",
        roles: ColumnRoles | None,
        atlas: "ThumbnailCache",
        config: dict,
    ) -> LayoutResult:
        if roles is None or not roles.geographic:
            raise ValueError("geographic layout requires a geographic role")
        entry = roles.geographic[int(config.get("entry_index", 0))]
        project = _PROJECTIONS[entry.projection]

        ids = packed_ids(atlas)
        meta_ids = [int(v) for v in meta.column("id").to_pylist()]
        lon_raw = meta.column(entry.lon_column).to_pylist()
        lat_raw = meta.column(entry.lat_column).to_pylist()
        coord_by_id: dict[int, tuple[object, object]] = {
            cid: (lon, lat) for cid, lon, lat in zip(meta_ids, lon_raw, lat_raw)
        }

        placed, placed_lon, placed_lat, unplaced = partition_placed(ids, coord_by_id)
        # Uniform square cell size from the placed count (grid.py's fill-factor spirit;
        # the geographic family always fits, so — unlike scatter's pass-through — there is
        # no extent-derived rescale).
        side = cell_side(len(placed), len(ids))

        coords: dict[int, tuple[float, float]] = {}
        if placed:
            # PROJECT first (lon/lat -> planar x/y), THEN the shared median-centred aspect
            # fit + T2-85 north-up — the IDENTICAL machinery scatter runs for its `fit`
            # mode. Projection is monotone in lat, so a larger latitude yields a larger
            # fitted y and (after the north-up reflection) renders HIGHER on screen:
            # north-up for BOTH projections. Ingest validated lon/lat ranges (and mercator
            # |lat|) on BOTH producer entry points, so the projection never diverges here.
            proj_x: list[float] = []
            proj_y: list[float] = []
            for lon, lat in zip(placed_lon, placed_lat):
                px, py = project(lon, lat)
                proj_x.append(px)
                proj_y.append(py)
            fx, fy = aspect_fit_north_up(proj_x, proj_y)
            coords.update({cid: (x, y) for cid, x, y in zip(placed, fx, fy)})
        if unplaced:
            # The geographic family always FITS (there is no pass-through), so its
            # missing-coordinate cells use the shared ABSOLUTE-BAND strip (the fit-mode
            # strip) — never scatter's pass-through data-adjacent block, which geographic
            # never runs. Never dropped, so every layout carries the identical id set (D-10).
            coords.update(band_strip(unplaced, side))

        xs = [coords[cid][0] for cid in ids]
        ys = [coords[cid][1] for cid in ids]
        ws = [side] * len(ids)
        hs = [side] * len(ids)

        # D-35 Seam G2: echo the baked projection (+ overlap) into the manifest so the UI
        # can EXPLAIN the map and a future T2-86 continent underlay can dispatch its own
        # projection from type=="geographic" + options.projection — this mode-name echo
        # RECORDS the projection (the spike §3 fit_transform *kind*); the fully
        # PARAMETERIZED transform record (kind/domain/scale/offset) that gives by-construction
        # underlay alignment is its own later work, not built here (G1-hardening scoping).
        # Always emitted (unlike scatter's default-omit): projection is load-bearing and
        # geographic is a NEW type, so every geographic bake is self-describing.
        options = {"projection": entry.projection, "overlap": entry.overlap}

        return LayoutResult(
            layout_id=self.name,   # worker applies the multi-entry naming convention
            layout_type="geographic",
            label=entry.label or "Location",
            cells=build_spatial_cells(ids, xs, ys, ws, hs),
            bbox=spatial_bbox(xs, ys, ws, hs),
            edges=None,
            options=options,
            # v2.6 (U1 / T2-140): the cells with no usable lon/lat — `partition_placed` gates
            # on FINITENESS, so a null coordinate and a NaN both land here — drawn in the
            # unplaced strip, counted so the viewer can explain that band. manifest.py writes
            # the key unconditionally, 0 included.
            missing_count=len(unplaced),
            # v2.9 provenance: BOTH coordinate columns, lon then lat — like scatter, a
            # geographic layout consumes a PAIR and a change to either stales it. The
            # `projection` is a shaping knob echoed in `options`, not a dependency, so it is
            # not recorded here. `dict.fromkeys` collapses the degenerate lon == lat case.
            source_columns=tuple(dict.fromkeys((entry.lon_column, entry.lat_column))),
            # v2.10: this PAIR's two tuples, lon then lat, each naming its partner and the
            # projection/overlap knobs — a re-projection moves every cell, so it is in the
            # tuple even though `options` echoes it too. Scatter's rules apply identically.
            source_fingerprint=role_entry_fingerprints("geographic", entry),
        )
