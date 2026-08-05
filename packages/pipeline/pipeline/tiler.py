"""The v2 per-layout spatial tile pyramid baker (decision D-33).

Replaces the v1 shared id-ordered atlas + the fixed-capacity ``quadfeather`` tile
writer (NEITHER is reusable — Phase-0 S3). For ONE layout it:

  1. **fixed-area tiler** — assigns the layout's cells to web-map ``{z}/{x}/{y}``
     tiles by world position (2^z tiles per axis at level z, over the layout bbox),
     subdividing until every tile's cell count <= ``cap`` = floor(tile_px/thumb_px)^2.
     For exact-coincident points (degenerate scatter) it stops at a max depth and
     in-tile subsamples, recording ``subsampled.dropped`` per tile.
  2. **fine (mini-atlas) tiles** at the deepest level (z == z_cap): a self-contained
     ``tile_px`` square mini-atlas packing the tile's cell thumbnails (cropped to a
     filled ``thumb_px`` square, D-32) PLUS the per-cell record list
     (id,x,y,w,h,u,v,uw,uh per cell_record.schema.json — no atlas_page/lod).
  3. **mosaic-composite (coarse) tiles** for z < z_cap: a down-rendered mosaic of
     the 4 child tiles into 1 parent (mip-style), pixels only, no records.
  4. **PMTiles writer** — packs the whole pyramid into ONE version-stamped
     ``.pmtiles`` container, addressed ``{z}/{x}/{y}``. A fine tile's body BUNDLES
     the mini-atlas image + its Arrow record list (resolved Q4); a coarse tile's
     body is the mosaic WebP only. The tile *kind* is derived from z vs z_cap (no
     per-tile band flag) — the single source of truth is the manifest's z_cap.

Hybrid simplification (Phase 1): the only level at which every tile fits <= cap is
the deepest one, so **z_cap == z_max** — that single deepest level is FINE; every
shallower level (0 .. z_max-1) is a COARSE mosaic. A tiny dataset whose root tile
already holds <= cap cells is a one-level all-fine pyramid (z_cap == levels[0].z),
which is the smallest valid pyramid the schema allows.

The fine-tile body is a length-prefixed bundle the consumer (renderer/API seam)
unpacks:  ``[uint32 BE image_len][webp bytes][arrow IPC bytes]``.  Coarse tile
body = the raw WebP bytes (no prefix).  Both framings are DOCUMENTED in
schemas/v2/tile.schema.json (the "TILE BODY BYTE FRAMING" note, added in the v2.1
MINOR bump) — ``unpack_fine_body`` below is the canonical inverse.

Coincident-point subsampling (v2.1 reconciliation): when a deepest-level fine tile
holds more than ``cap`` (near-)coincident cells, ``_group_fine_tiles`` keeps the
lowest-id ``cap`` and drops the surplus; the dropped *count* is stamped into the
tile's Arrow record table schema metadata under ``subsampled.dropped`` (so a
consumer/the contract gate can read it) and the dropped ids remain in
metadata.parquet + the detail tier. The dense id NUMBERING [0, image_count) is
untouched — only fine-tile PLACEMENT is relaxed (see cell_record.schema.json id).

...and it is never quiet (T2-143). ``bake_pyramid`` WARNS with the layout, the count, the
fraction and the stop reason ``_choose_z_max`` chose, on the tiler's own logger; the
worker re-emits it into the DATASET's ingest.log (the job logger does not propagate).
Nothing is refused: a subsampled cell keeps its ``positions_ref`` row, so it is still
counted in the viewer's pile chip — the honest description is "not baked into the fine
tier", not "discarded". What the count cannot yet tell you is WHICH kind it is: under the
coincidence / cell-size stops the surplus is occluded (drawn on top of other cells, which
no tiling can separate), while under the tile-budget stop it would have separated at a
deeper level. ``dropped_total`` sums both — splitting them is T2-145. The depth ceiling
that used to reach these states on ordinary data was fixed here: see ``_choose_z_max``'s
``overflow_packable``.
"""
from __future__ import annotations

import contextlib
import functools
import gzip
import io
import logging
import math
import os
import struct
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather
import pyvips

from pipeline.atlas import ThumbnailCache, read_thumbnail, thumbnail_to_image

logger = logging.getLogger(__name__)

# Hard ceiling on subdivision depth so exact-coincident points (degenerate scatter:
# every cell at one world coordinate) terminate instead of recursing forever. At the
# chosen depth a still-overflowing tile is in-tile subsampled to <= cap. _MAX_DEPTH is
# the absolute ceiling; _choose_z_max stops WELL before it for any non-degenerate set —
# only a genuinely (near-)coincident overflow ever reaches it.
_MAX_DEPTH = 24

# Cap on how many fine tiles the chosen level may carry, as a multiple of the ideal
# ceil(n/cap). It bounds z_max so a (near-)coincident DISTINCT cluster (cells sub-
# resolution apart — visually one blob) cannot force a deep GLOBAL fine level and drive
# the tile count toward ~n; that cluster is in-tile subsampled instead. The factor must
# clear the tile demand of an HONEST clustered layout: resolving a gaussian/UMAP/t-SNE
# scatter fully takes ~0.1-0.33 n occupied tiles — MORE than the uniform ideal n/cap,
# because one global fine level over-resolves the sparse periphery in order to isolate
# the dense core — so a too-tight factor (an earlier 4x) mass-subsampled 20-40% of those
# DISTINCT cells. 16x (cap ~0.25 n) resolves embedding scatter (gaussian/UMAP/t-SNE,
# ~0.1-0.33 n) and every grid/datetime/categorical layout (all ~n/cap) with ~0% drop,
# while capping a genuinely near-coincident pile (which would otherwise need ~0.9 n tiles).
# It does NOT fully resolve a WIDE GEOGRAPHIC / heavy-tailed scatter: a sparse global tail
# makes aspect-fit compress the dense hotspots. On such a layout the BUDGET is no longer the
# binding bound — the T2-118b CELL-SIZE CEILING (_choose_z_max) is: no layout-layer
# transform un-piles wide lon/lat (a log scale could never apply to origin-spanning axes,
# and scatter's fit is linear — per-axis scale knobs are a DECLARED option, D-35 Seam G1),
# the compressed hotspots would need cells drawn many tiles wide, and the ceiling caps depth
# well short of both this budget and full resolution. The dense hotspot regions then in-tile
# subsample MUCH higher than the pre-ceiling budget did — measured ~81% on the #67 wide-geo
# test shape (vs the ~5-46% the budget alone used to drop). That is the HONEST TRADE, not a
# regression: before the ceiling those same cells were drawn at up to ~74x tile size
# (magnified center-crops), so the overview is now correct where it was mush. Dropped ids
# stay in metadata + the detail tier (reconcilable, reachable); the principled cure is a
# NON-uniform fine depth (per-tile z_cap, #67) — future, out of this baker's scope. (A
# scatter-side bbox clip was tried and then removed by Seam S1: near-worthless at this cap and
# it margin-jammed the tail — see scatter._aspect_fit / spike_scatter_deep_dive.md.)
_TILE_BUDGET_FACTOR = 16

# Coverage gate for the coarse-mip dilation floor (Seam A / b2, decision D-iv). A
# coarse parent whose cell coverage (the mean-alpha occupancy of its combined
# children — fraction of the tile that is NON-TRANSPARENT) is below this threshold is
# a SPARSE overview region (a datetime histogram-stack leaves ~90% of [0,1]^2 empty:
# measured world-overview coverage datetime 9.63% vs categorical 69.75%). Such a tile
# gets its cells max-filter/dilated by one pixel before the 4->1 mean shrink, so every
# cell keeps ~1px of COLORED, OPAQUE presence at every overview level instead of the
# mean shrink dimming it toward the transparent pad and vanishing it (measured: a lone
# 1px cell in a 512px tile drops to alpha 0 by the world overview without the floor).
# Applied at every coarse level below the gate, the per-level 1px dilation compounds to
# the spike's 2^(z_cap-z) cumulative growth. Dense layouts (grid/categorical, coverage
# 70-100% >= this gate) NEVER enter the dilation branch, so their coarse bytes are
# UNCHANGED by b2 (only b1's RGBA pad changes them). The value sits in the spike's
# recommended 0.4-0.5 band: high enough that a genuinely sparse overview always trips
# it, low enough that a merely-partial dense tile (a grid tile's thin inter-cell gaps,
# a half-full edge quadrant) never does. Max-filter (not mean) is what preserves the
# cell COLOR — a per-band window max grows the opaque colored cell over the [0,0,0,0]
# pad, dilating RGB and alpha TOGETHER (never smearing alpha independently of color).
MIN_COARSE_COVERAGE = 0.45

# NO REFUSAL THRESHOLD (operator decision, T2-143). An earlier draft of this seam refused
# to bake above a 50 % drop, with an environment-variable opt-out. Both are gone, because
# a percentage cannot justify the refusal: a subsampled cell keeps its ``positions_ref``
# row and is still counted in the viewer's pile chip, so the common case is OCCLUSION —
# cells drawn on top of other cells, which no amount of tiling can separate — and there is
# nothing to refuse over. The case that WOULD justify it (the tile-budget stop, where the
# cells would have separated at a deeper level) is not distinguishable from the benign one
# in ``dropped_total`` today; making it distinguishable is T2-145. Until it is, the bake
# reports and proceeds. The opt-out went with the threshold rather than being documented:
# it existed only to escape a refusal that no longer happens.

# Fine-tile body framing: a big-endian uint32 image-length prefix, then the WebP
# mini-atlas bytes, then the Arrow IPC (Feather) record table. One PMTiles range
# request yields both (resolved Q4 — bundled).
_FINE_PREFIX = struct.Struct(">I")

# Full cell_record.schema.json column order/types for the FINE-tile record list.
# v2: u/v/uw/uh (the sub-rect into THIS tile's mini-atlas) replace v1's
# atlas_page/atlas_u..h/lod. `level`/`detail_ref` are reserved/nullable; the
# four reserved int32s carry forward.
CELL_RECORD_SCHEMA = pa.schema(
    [
        ("id", pa.int64()),
        ("x", pa.float32()),
        ("y", pa.float32()),
        ("w", pa.float32()),
        ("h", pa.float32()),
        ("u", pa.float32()),
        ("v", pa.float32()),
        ("uw", pa.float32()),
        ("uh", pa.float32()),
        ("level", pa.int32()),       # reserved, nullable (pyramid z); pinned here
        ("detail_ref", pa.string()),  # reserved, nullable (detail tier T2-26)
        ("color", pa.int32()),        # reserved, nullable
        ("cluster_id", pa.int32()),   # reserved, nullable
        ("edge_count", pa.int32()),   # reserved, nullable
        ("embedding_dim", pa.int32()),  # reserved, nullable
    ]
)


def cap_for(tile_px: int, thumb_px: int) -> int:
    """The fine-tile cell cap = floor(tile_px / thumb_px)^2 (the mini-atlas grid is
    floor(tile_px/thumb_px) per axis). This is the exact relation the contract gate
    asserts; it is the single definition the manifest and tiler share."""
    per_axis = tile_px // thumb_px
    return per_axis * per_axis


@dataclass(frozen=True)
class PyramidLevel:
    z: int
    tile_count: int


@dataclass(frozen=True)
class PyramidResult:
    """What the baker emits for one layout, for the manifest pyramid descriptor."""

    path: str               # PMTiles container path relative to the dataset root
    tile_px: int
    thumb_px: int
    cap: int
    levels: list[PyramidLevel]  # coarsest (smallest z) first
    z_cap: int
    detail_path_prefix: str | None  # detail tier originals dir (None if not baked)
    detail_format: str | None       # "webp" when the detail tier is baked
    dropped_total: int = 0   # cells dropped to coincident-point subsampling across
                             # all fine tiles (v2.1). 0 in the common case; >0 only
                             # for degenerate (near-coincident) point sets. The
                             # dropped ids keep their dense numbering + metadata row.
    coarse_dilated: int = 0  # coarse tiles that took the coverage-gated dilation floor
                             # (Seam A / b2). 0 for a DENSE layout (grid/categorical) —
                             # the branch never fires; >0 only for a SPARSE overview
                             # (datetime). Introspection for the surgical-b2 gate.
    z_max_reason: str = ""   # which stop condition _choose_z_max chose ("resolution" /
                             # "coincidence" / "cell-size ceiling" / "tile budget" /
                             # "hard _MAX_DEPTH ceiling"). NOT a manifest field —
                             # manifest.py reads named fields and does not emit this. It
                             # exists so the WORKER can name the reason in the dataset's
                             # ingest.log without re-deriving it (T2-143); it is the only
                             # thing that tells occlusion from a budget truncation.
    # How wide/tall the LARGEST cell is at the chosen fine level, in TILES:
    # max_w / (span_x / 2^z_max) and its y twin. 1.0 means a cell exactly fills a tile.
    # Above ~3 the coarse spatial render's 3x3 neighbour window cannot draw the whole
    # cell, so the overview under-draws it by roughly 3/ratio (T2-147: unbounded and
    # ungated today). Measured 6.07 on a 20k packed datetime corpus — i.e. columns drawn
    # at ~49% of their true width. Reported, not enforced; also not a manifest field.
    cell_tiles_x: float = 0.0
    cell_tiles_y: float = 0.0


@dataclass(frozen=True)
class _Cell:
    """One renderable cell as the tiler sees it: dense id + world placement."""

    id: int
    x: float
    y: float
    w: float
    h: float


def _tile_xy(cx: float, cy: float, bbox: tuple[float, float, float, float], z: int) -> tuple[int, int]:
    """Web-map tile (tx, ty) at level z for a cell centre (cx, cy), over the layout
    bbox. 2^z tiles per axis. A degenerate (zero-width/height) bbox axis maps every
    cell to column/row 0 on that axis."""
    x0, y0, x1, y1 = bbox
    n = 1 << z
    span_x = x1 - x0
    span_y = y1 - y0
    fx = (cx - x0) / span_x if span_x > 0 else 0.0
    fy = (cy - y0) / span_y if span_y > 0 else 0.0
    tx = min(n - 1, max(0, int(fx * n)))
    ty = min(n - 1, max(0, int(fy * n)))
    return tx, ty


def _level_summary(
    cells: list[_Cell],
    bbox: tuple[float, float, float, float],
    z: int,
    cap: int,
    eps_x: float,
    eps_y: float,
    max_w: float,
    max_h: float,
) -> tuple[int, bool, int, bool]:
    """Summarise level z in ONE O(n) pass: ``(max_occupancy, overflow_separable,
    tile_count, overflow_packable)``.

    ``max_occupancy`` is the largest single-tile cell count; ``tile_count`` is the number
    of OCCUPIED tiles. ``overflow_separable`` is True iff SOME tile that exceeds ``cap``
    holds cells whose bounding-box EXTENT exceeds eps on either axis. eps is the FINEST
    tile width (bbox_span / 2^_MAX_DEPTH): extent > eps means the cells are distinct at the
    deepest resolution the pyramid can reach and so WILL land in different tiles by then;
    extent <= eps means they are coincident at that resolution and never separate. Using
    the finest resolution — NOT a cell footprint — is what makes this correct for scatter,
    whose footprint (~0.9/sqrt(n)) is a count-derived nominal size decoupled from the real
    point spacing (aspect-fit can compress a distinct cloud far below it).

    ``overflow_packable`` is True iff SOME over-cap tile's cells could be drawn SIDE BY
    SIDE inside the area their own footprints already span: ``count * max_w * max_h <=
    (extent_x + max_w) * (extent_y + max_h)``. It asks "are these cells a PILE (drawn on
    top of each other) or a LAYOUT (laid out, just too many for one tile)?" — the question
    the T2-143 cell-size ceiling needs and that a span-derived ratio cannot answer. Both
    sides are in ABSOLUTE world units and are measured on the CELLS' OWN EXTENT, never on
    the tile or the bbox, so it is invariant to the layout's drawn aspect: squeezing a
    layout's x-axis without shrinking its cells only makes it False once the cells
    genuinely start to overlap. The ``+ max_w``/``+ max_h`` terms turn a centre extent into
    a FOOTPRINT extent, which also makes the degenerate cases right: cells stacked in one
    column (extent_x == 0) compare ``count*w*h`` against ``w * (extent_y + h)`` — the column
    they actually occupy — and a fully-coincident pile (both extents 0) compares
    ``count*w*h`` against one cell, i.e. ``count`` times over. ``max_w``/``max_h`` are the
    GLOBAL largest cell (the tiler has no per-tile size), so the estimate is conservative:
    it over-states the area needed and therefore calls a borderline tile a pile.

    IT IS A CAPACITY BOUND, NOT A PLACEMENT PROOF. The comparison is area-against-area over
    the extent the cells span; the cells themselves have FIXED positions, so a tile whose
    cells are clustered in one corner of an extent that an outlier stretched can satisfy it
    and still not separate at the next level. That costs a LEVEL, not correctness: the next
    level re-evaluates on the smaller extent, the predicate stops holding, and the ceiling
    binds there instead. Read it as "there is room for these cells side by side", never as
    "these cells will separate"."""
    agg: dict[tuple[int, int], list[float]] = {}  # tile -> [count, xmin, xmax, ymin, ymax]
    for c in cells:
        key = _tile_xy(c.x, c.y, bbox, z)
        a = agg.get(key)
        if a is None:
            agg[key] = [1, c.x, c.x, c.y, c.y]
        else:
            a[0] += 1
            if c.x < a[1]:
                a[1] = c.x
            if c.x > a[2]:
                a[2] = c.x
            if c.y < a[3]:
                a[3] = c.y
            if c.y > a[4]:
                a[4] = c.y
    if not agg:
        return 0, False, 0, False
    max_occ = 0
    overflow_separable = False
    overflow_packable = False
    cell_area = max_w * max_h
    for count, xmin, xmax, ymin, ymax in agg.values():
        if count > max_occ:
            max_occ = int(count)
        if count > cap:
            if xmax - xmin > eps_x or ymax - ymin > eps_y:
                overflow_separable = True
            if count * cell_area <= (xmax - xmin + max_w) * (ymax - ymin + max_h):
                overflow_packable = True
    return max_occ, overflow_separable, len(agg), overflow_packable


def _cell_size_z_ceiling(
    cells: list[_Cell],
    bbox: tuple[float, float, float, float],
    *,
    max_w: float | None = None,
    max_h: float | None = None,
) -> int:
    """The deepest fine level at which the LARGEST cell still fits within ~1 tile — a
    subdivision ceiling that decouples depth from a pile's density so the coarse spatial
    render never has to draw a cell wider than a tile and center-crop it (T2-118b).

    A tile at level z is ``span/2^z`` wide on each axis, so a cell of drawn side ``s`` fits
    while ``s <= span/2^z`` ⇔ ``z <= log2(span/s)``. The largest cell on each axis is taken
    (a cell must fit BOTH axes, so the SMALLER per-axis bound wins). Beyond this z the
    coarse render's 3x3 neighbour window structurally cannot represent the cell (it spans
    more tiles than the window covers), which is exactly the ~6% center-crops the rijks
    scatter pile baked at z_cap=12 with cells ≈16.7 tiles wide. A degenerate axis (zero
    span, or zero-size cells) does not constrain — every cell maps to that axis's single
    row/column regardless (see _tile_xy) — so it is skipped; if neither axis constrains
    (a single all-covering cell / empty set) the ceiling is _MAX_DEPTH (no cell-size cap).
    This is a general robustness guard for any layout that resolves deep with oversized
    cells; on a heavy-tailed positive scatter (whose fit is linear today) it is the
    BINDING guard until a declared per-axis log scale (D-35 Seam G1, the reworked
    T2-118a) un-piles such data at the layout layer.

    T2-143 — WHAT THIS NUMBER IS AND IS NOT. Because a tile DIVIDES THE BBOX, a tile is
    as anisotropic as the layout is: ``span_x/2^z`` by ``span_y/2^z``. So "the cell is
    wider than a tile" fires as soon as the LAYOUT is narrow, whether or not the cells
    have anything to do with each other — and the per-axis ``min`` below means the
    squeezed axis alone decides. Measured: D-36 H1 narrows a packed datetime histogram's
    bbox without shrinking its cells, and on a 20k corpus with 60 % of its images on one
    day this ceiling reads 5 (post-H1 span 0.00293, cell 6.95e-05) where the pre-H1 line
    filled the band and the SAME cells gave 13 — which cost 79.84 % of them. The number is
    still RIGHT about the render — at a deeper z the coarse 3x3 neighbour window really
    cannot draw the cell — it is just not, on its own, a reason to throw the images away.
    That is why ``_choose_z_max`` now treats it as a bound on OVERLAPPING piles only, and
    lets a layout whose cells are merely too numerous for one tile carry on down to the
    tile budget (see the ``overflow_packable`` stop condition there)."""
    span_x = bbox[2] - bbox[0]
    span_y = bbox[3] - bbox[1]
    # `_choose_z_max` computes these once for the whole descent and passes them in; a direct
    # caller (e.g. a test) omits them and they are scanned here.
    if max_w is None:
        max_w = max((c.w for c in cells), default=0.0)
    if max_h is None:
        max_h = max((c.h for c in cells), default=0.0)
    bounds: list[float] = []
    if span_x > 0.0 and max_w > 0.0:
        bounds.append(math.log2(span_x / max_w))
    if span_y > 0.0 and max_h > 0.0:
        bounds.append(math.log2(span_y / max_h))
    if not bounds:
        return _MAX_DEPTH
    return max(0, math.floor(min(bounds)))


def _choose_z_max(
    cells: list[_Cell],
    bbox: tuple[float, float, float, float],
    cap: int,
    *,
    max_w: float | None = None,
    max_h: float | None = None,
) -> tuple[int, str]:
    """The fine level: subdivide while it still separates DISTINCT cells, stopping the
    moment the only over-cap tiles left are (near-)coincident piles OR a deeper level would
    exceed the tile budget OR a deeper level's tiles would be smaller than a cell (the
    cell-size ceiling, T2-118b). The deepest fine tiles that still overflow are in-tile
    subsampled to cap (see _group_fine_tiles). Bounded by _MAX_DEPTH. The chosen bound is
    logged (one INFO line per layout bake).

    Returns ``(z_max, reason)``. The REASON is returned, not just logged, because it is the
    only thing that distinguishes a benign subsample from a costly one: under ``resolution``
    nothing is dropped at all, under ``coincidence`` / ``cell-size ceiling`` the surplus is
    OCCLUDED (cells drawn on top of each other — no tiling separates them), and under
    ``tile budget`` the surplus WOULD have separated one level deeper. ``bake_pyramid``
    puts it in the drop warning so an operator reading "12 % subsampled" can tell which of
    those they are looking at. NOTE it is a per-LAYOUT stop while drops are per-TILE, so at
    a budget stop some over-cap tiles may still be coincident piles — the reason narrows
    the question, it does not split the count (T2-145).

    WHY the stop conditions, and why each prior single-signal attempt failed:

      * Coincidence (``not overflow_separable``) — keep subdividing while SOME over-cap tile
        holds cells spread wider than the FINEST tile width (they are distinct at max
        resolution and WILL separate); stop when every over-cap tile is coincident at that
        resolution. The count-derived ``log4(n/cap)`` ceiling this replaced assumed a 2-D
        spread and mass-subsampled 1-D layouts (datetime ~93% @1M). A fixed-level patience
        window (on max-occupancy OR on the subsample residual) ALSO fails: a compact-but-
        separable region — a scatter cloud compressed into a corner because a far outlier
        inflated the bbox — stays flat for log2(1/relative_width) levels (UNBOUNDED) before
        separating, so any fixed window stops early and drops ~90-99% of distinct cells.
        Keying off extent-vs-FINEST-resolution (not a footprint, which for scatter is
        decoupled from real spacing) is the only signal that distinguishes "compact but will
        separate" from "genuinely coincident" at every compactness.

      * Budget (next level's ``tile_count > _TILE_BUDGET_FACTOR * ceil(n/cap)``) — coincidence
        alone is unbounded: a cluster of > cap cells that are DISTINCT but sub-resolution apart
        (e.g. near-duplicate embeddings) keeps ``overflow_separable`` True and would drive the
        GLOBAL fine level deep, pushing the surrounding spread toward ~n tiles. The budget caps
        z_max so that pile is in-tile subsampled instead (its cells are visually coincident
        anyway). The factor is sized to clear the tile demand of honest clustered layouts
        (embedding/UMAP scatter resolves at ~0.1-0.33 n tiles, grid/datetime/categorical at
        ~n/cap) — see _TILE_BUDGET_FACTOR. A WIDE GEOGRAPHIC / heavy-tailed scatter, whose
        sparse global tail compresses the dense bulk below the budget, can still exceed it and
        is then subsampled (ids kept in metadata + the detail tier, fully reconcilable); the
        cure is a per-tile z_cap (future work) — a scatter-side bbox clip was tried and removed
        by Seam S1 as near-worthless at this cap (see scatter._aspect_fit).

      * Cell-size ceiling (``z >= _cell_size_z_ceiling`` AND the overflow is a PILE,
        T2-118b + T2-143) — subdivision depth was DECOUPLED from cell size: a dense pile
        (heavy-tailed scatter compressed by the aspect fit) kept ``overflow_separable`` true
        and drove z deep (rijks scatter hit the BUDGET at z_cap=12) while the drawn cell side
        stayed fixed — so each cell spanned ≈16.7 tiles and the coarse spatial render (whose
        3x3 neighbour window cannot draw a cell wider than ~3 tiles) baked ~6% magnified
        center-crops. Stopping the moment a deeper level's tiles would be smaller than a cell
        keeps every cell within ~1 tile; the still-piled surplus is in-tile subsampled instead
        (the honest trade — more subsampling of a true pile, no center-crops). It remains the
        binding guard for a heavy-tailed pile until a DECLARED per-axis log scale (D-35 Seam
        G1, the reworked T2-118a) un-piles such data at the layout layer, and the per-tile
        z_cap (#67) remains the future non-uniform-depth cure.

        T2-143 QUALIFIED IT WITH ``overflow_packable``. A tile divides the BBOX, so it
        inherits the layout's aspect; ``_cell_size_z_ceiling``'s per-axis ``min`` therefore
        collapses the instant a layout is NARROW, whatever its cells are doing. Measured
        through this function at the production cap=64 after D-36 H1 narrowed the datetime
        bbox, on corpora whose peak is a real DATE (each stated with its construction, since
        the drop RATE is sensitive to it — the ceiling and the class are not): 20,000 images
        with 12,000 on one day and 8,000 spread evenly over 3 years stopped at the ceiling
        (z=5) and dropped 79.84 % of themselves; 100,000 with 10,000 spread over 28
        consecutive days and 90,000 spread evenly over 10 years dropped 18.03 % at z=7 (the
        PR-189 review's own construction of "100k, 10 % in one month" gives 23.02 % at the
        same ceiling); 1,000,000 with 600,000 on one day and 400,000 spread evenly over 1000
        days dropped 74.11 % at z=11. Those
        cells are gone from the fine tier AND from every coarse mosaic above it, because
        ``_bake_subtree`` mips from the post-drop members. But their cells never overlapped —
        a datetime histogram draws squares at 0.85 of its own pitch — so subdividing was
        still LAYING THEM OUT, not magnifying a pile, and the ceiling was refusing for a
        rendering reason while paying in data. ``overflow_packable`` (see ``_level_summary``)
        separates the two on the cells' OWN extent, in absolute world units, with no
        reference to the tile, the bbox or the drawn aspect: if the over-cap cells could be
        drawn side by side in the area their footprints already span, the ceiling YIELDS and
        the BUDGET (which is what bounds the pyramid) takes over; if they are piled on top of
        each other, the ceiling binds. NOT tile-by-tile, though: ``overflow_packable`` is an OR
        over a level's over-cap tiles, so the yield is a LAYOUT-WIDE decision. When a packable
        tile and a genuine coincident pile share one level, the packable tile carries the yield
        and the pile descends with it — the pile's overview then under-draws (a cell wider than
        the coarse 3x3 window) rather than the ceiling binding on it. That is a bounded
        overview cost, not lost cells, and splitting the decision per tile is the per-tile
        z_cap ([[T2-169]] / #67). Measured on the same corpora: all
        three now drop 0.00 %, while the rijks-shaped compressed pile still stops AT the
        ceiling with the same 97.40 % subsample and every golden-fixture layout keeps its
        committed z_cap and tile counts. The cost of yielding is real and bounded: on an
        extremely anisotropic layout the fine level lands where cells span several tiles on
        the squeezed axis, so the coarse overview under-draws their width (the 3x3 window
        truncates them). An overview that draws a column too thin is not in the same class as
        an overview — and a fine tier — that is missing three quarters of the images."""
    n = len(cells)
    if n == 0:
        return 0, "empty"
    eps_x = (bbox[2] - bbox[0]) / (1 << _MAX_DEPTH)
    eps_y = (bbox[3] - bbox[1]) / (1 << _MAX_DEPTH)
    # Largest cell footprint, scanned ONCE for the whole descent — `_level_summary` (per z) and
    # `_cell_size_z_ceiling` both need it. `bake_pyramid` passes it so it is computed a single
    # time per bake (it also feeds `_cell_tile_spans`); a direct caller (a test) omits it.
    if max_w is None:
        max_w = max((c.w for c in cells), default=0.0)
    if max_h is None:
        max_h = max((c.h for c in cells), default=0.0)
    budget = _TILE_BUDGET_FACTOR * max(1, math.ceil(n / cap))
    z_ceiling = _cell_size_z_ceiling(cells, bbox, max_w=max_w, max_h=max_h)

    summary_by_z: dict[int, tuple[int, bool, int, bool]] = {}

    def summary(zz: int) -> tuple[int, bool, int, bool]:
        s = summary_by_z.get(zz)
        if s is None:
            s = _level_summary(cells, bbox, zz, cap, eps_x, eps_y, max_w, max_h)
            summary_by_z[zz] = s
        return s

    z = 0
    yielded_ceiling = False
    while z < _MAX_DEPTH:
        max_occ, overflow_separable, _, overflow_packable = summary(z)
        if max_occ <= cap or not overflow_separable:
            # resolved (every tile within cap), or only coincident piles remain
            reason = "resolution" if max_occ <= cap else "coincidence"
            logger.info("z_max=%d chosen by %s (n=%d cap=%d)", z, reason, n, cap)
            return z, reason
        if z >= z_ceiling:
            if not overflow_packable:
                logger.info(
                    "z_max=%d chosen by cell-size ceiling (a deeper level's tiles would be "
                    "smaller than a cell; n=%d) — the pile's surplus is in-tile subsampled",
                    z, n,
                )
                return z, "cell-size ceiling"
            if not yielded_ceiling:
                # T2-143: the ceiling is a bound on PILES. These cells are laid out, not
                # piled, so honouring it here would subsample a layout the deeper levels can
                # still separate. Say so once — the trade (a coarse overview that under-draws
                # oversized cells, in exchange for keeping the images) is deliberate.
                yielded_ceiling = True
                logger.info(
                    "cell-size ceiling z=%d passed: the over-cap tiles have ROOM for their "
                    "cells side by side (a layout, not a pile — an area bound, not a proof "
                    "that they separate), so subdividing still places them; the tile budget "
                    "(%d) now bounds the depth. How far past the ceiling this bake ends up, "
                    "and what that costs the coarse overview, is measured and logged per "
                    "layout at the end of the bake (T2-147).",
                    z_ceiling, budget,
                )
        if summary(z + 1)[2] > budget:
            logger.info("z_max=%d chosen by tile budget (next level > %d tiles; n=%d)", z, budget, n)
            return z, "tile budget"
        z += 1
    logger.info("z_max=%d chosen by hard _MAX_DEPTH ceiling (n=%d)", z, n)
    return z, "hard _MAX_DEPTH ceiling"


def _group_fine_tiles(
    cells: list[_Cell], bbox: tuple[float, float, float, float], z: int, cap: int
) -> tuple[dict[tuple[int, int], list[_Cell]], dict[tuple[int, int], int]]:
    """Bucket cells into their (tx, ty) tile at the fine level z, in-tile
    subsampling any tile that still exceeds cap. A tile can exceed cap at
    ``_MAX_DEPTH`` (coincident points) OR at a shallower z that ``_choose_z_max``
    capped short of full resolution — the tile budget, or the T2-118b cell-size
    ceiling on a heavy-tailed pile. Returns the kept buckets and a {tile: dropped}
    map for the overflow (recorded as ``subsampled.dropped``). Cells are kept in id
    order within a tile (deterministic; the surplus tail is dropped)."""
    buckets: dict[tuple[int, int], list[_Cell]] = {}
    for c in cells:  # cells arrive in id order
        buckets.setdefault(_tile_xy(c.x, c.y, bbox, z), []).append(c)
    dropped: dict[tuple[int, int], int] = {}
    for key, members in buckets.items():
        if len(members) > cap:
            dropped[key] = len(members) - cap
            buckets[key] = members[:cap]  # keep the lowest-id cap cells
    return buckets, dropped


# --- fine-tile mini-atlas + records -----------------------------------------


def _decode_tile_thumbs(members: list[_Cell], cache_dir: Path) -> dict[int, pyvips.Image]:
    """Read+wrap each member's cached thumbnail ONCE, keyed by id. A fine tile feeds
    the SAME decoded set to both its mini-atlas (the served body) and its spatial
    render (the coarse-mip source), so a cell's thumbnail is read once per bake instead
    of once per consumer. (The cache holds RAW uchar buffers — thumbnail_to_image is a
    zero-copy memory wrap, not a codec decode — so the saving is one redundant disk read
    + wrap per fine-tile cell; the dominant win is the clearer single-source dataflow.)"""
    return {c.id: thumbnail_to_image(read_thumbnail(cache_dir, c.id)) for c in members}


def _build_mini_atlas(
    members: list[_Cell], tile_thumbs: dict[int, pyvips.Image], tile_px: int, thumb_px: int
) -> pyvips.Image:
    """Pack a fine tile's cell thumbnails into one tile_px square mini-atlas, in a
    per_axis x per_axis grid (per_axis = tile_px // thumb_px), row-major in member
    order. Empty slots stay black (no cell ever points at them). Built with one
    ``arrayjoin`` (the native grid op — no blend, no operation-graph blow-up),
    mirroring the v1 page builder. ``tile_thumbs`` is this tile's decoded thumbnails
    (from _decode_tile_thumbs), keyed by id."""
    per_axis = tile_px // thumb_px
    capacity = per_axis * per_axis
    black = pyvips.Image.black(thumb_px, thumb_px, bands=3).copy(interpretation="srgb")
    tiles: list[pyvips.Image] = []
    for c in members:
        img = tile_thumbs[c.id]
        if img.width != thumb_px or img.height != thumb_px:
            # Defensive: the cache holds thumb_px squares, but resize on the rare
            # mismatch so arrayjoin's uniform stride holds.
            img = img.thumbnail_image(thumb_px, height=thumb_px, crop="centre").copy(
                interpretation="srgb"
            )
        tiles.append(img)
    tiles += [black] * (capacity - len(tiles))
    mosaic = pyvips.Image.arrayjoin(
        tiles, across=per_axis, hspacing=thumb_px, vspacing=thumb_px, background=[0, 0, 0]
    ).copy(interpretation="srgb")
    return mosaic


def _build_spatial_render(
    fine_members: dict[tuple[int, int], list[_Cell]],
    tx: int,
    ty: int,
    z: int,
    bbox: tuple[float, float, float, float],
    cache_dir: Path,
    tile_px: int,
    tile_thumbs: dict[int, pyvips.Image],
) -> pyvips.Image:
    """Render the fine tile (tx,ty)'s world rect as a tile_px square — cells drawn at
    their WORLD positions. THIS — not the mini-atlas — is the image a coarse parent
    shrinks (mip-style), so every coarse level is a faithful low-res OVERVIEW of the
    layout, not a shrunk packing sheet (the padded-mini-atlas banding bug). The
    mini-atlas stays the fine tile's served body (per-cell UV sampling); this render
    is internal-only, never served.

    The canvas is RGBA with a fully-TRANSPARENT pad (alpha 0) and OPAQUE cells (each
    thumbnail bandjoined an alpha=255 plane before insert) — Seam A / b1, decision
    D-iv. Background/pad pixels carry no baked ground color; the renderer composites
    the mosaic OVER its canvas ground (`--ground`) so pad shows the ground and cells
    show content. This unlocks the network-edge underlay (T2-70/D-D) without a second
    re-bake. libvips keeps the RGB channels STRAIGHT (non-premultiplied) through the
    downstream mean shrink — the color never bleeds toward black at a partial-coverage
    edge; only the alpha carries coverage — so the renderer decodes with straight alpha
    and standard over-blending (see tilePyramid.ts drawOverview).

    Cells from the 3x3 neighbouring tiles whose extent OVERLAPS this rect are drawn
    too (clipped at the edges by the composite), so the rect fills EDGE-TO-EDGE with no
    blank margin. That margin — where a tile's own cells don't reach its rect edge,
    because the cell grid doesn't align to the tile grid — is what doubled into the
    thick black seams at the mip-join (and cut off edge cells). Only the thin, uniform
    fill-gap between cells then remains (the real layout spacing, also shown by the
    fine renderer).

    ``tile_thumbs`` holds THIS tile's (tx,ty) own cells' decoded thumbnails (shared
    with the mini-atlas, so they are read once); the 3x3 neighbour cells are not in it
    and are read on demand (only the thin overlapping border, after the skip cull).

    Draw order is fine_members insertion order (= id order); for layouts where cells
    can overlap (scatter/datetime), later-id cells paint over earlier ones, so an
    overlapping cluster's top cell in the coarse overview may differ from the
    mini-atlas (which gives every cell its own slot). Grid cells never overlap, so this
    is a no-op for the only layout that currently bakes coarse tiers."""
    x0, y0, x1, y1 = bbox
    n = 1 << z
    tw = (x1 - x0) / n
    th = (y1 - y0) / n
    tx0 = x0 + tx * tw
    ty0 = y0 + ty * th
    # RGBA canvas, fully TRANSPARENT (alpha 0) — the mosaic pad (b1). A cell's
    # thumbnail is 3-band opaque RGB (atlas.py flattens source alpha away), so it is
    # bandjoined an alpha=255 plane before compositing to stay OPAQUE over the
    # transparent pad. composite needs matching band counts, hence both sides are 4-band.
    canvas = pyvips.Image.black(tile_px, tile_px, bands=4).copy(interpretation="srgb")
    # Collect every overlapping cell as (opaque RGBA image, left, top) and paint them
    # ALL in ONE composite — NOT a chain of ``canvas = canvas.insert(...)``. A per-cell
    # insert chain is O(cells) DEEP and libvips renders it SUPERLINEARLY: copy_memory
    # re-walks the whole chain, re-evaluating each cell's bandjoin every time, so a dense
    # fine tile (up to ~9x cap cells with the 3x3 neighbour bleed — the categorical/grid
    # worst case) cost seconds and made dense-categorical pyramids effectively
    # un-bakeable at 1M (T2-106; measured ~O(K^2.5), ~13 s for one 800-cell tile). A
    # single ``composite(..., "over", ...)`` evaluates each cell ONCE (O(K)) and is
    # BYTE-IDENTICAL here: every cell is fully opaque (alpha 255), so an over-blend
    # equals the old overwrite-insert, and out-of-bounds cells clip the same way
    # (pinned by test_spatial_render_composite_matches_insert).
    cell_imgs: list[pyvips.Image] = []
    xs: list[int] = []
    ys: list[int] = []
    for nty in (ty - 1, ty, ty + 1):
        for ntx in (tx - 1, tx, tx + 1):
            for c in fine_members.get((ntx, nty), ()):
                pw = max(1, round((c.w / tw) * tile_px)) if tw > 0 else tile_px
                ph = max(1, round((c.h / th) * tile_px)) if th > 0 else tile_px
                left = round(((c.x - tx0) / tw) * tile_px - pw / 2) if tw > 0 else 0
                top = round(((c.y - ty0) / th) * tile_px - ph / 2) if th > 0 else 0
                # Skip cells that do not overlap this tile (don't even read their
                # thumb) — only this tile's cells + a thin border of neighbours draw.
                if left + pw <= 0 or left >= tile_px or top + ph <= 0 or top >= tile_px:
                    continue
                # Own cells come from the shared decode; neighbour-tile cells (not in
                # tile_thumbs) are read on demand — only the overlapping border reaches
                # here, so this stays a thin read, not a 9x amplification.
                thumb = tile_thumbs.get(c.id)
                if thumb is None:
                    thumb = thumbnail_to_image(read_thumbnail(cache_dir, c.id))
                if thumb.width != pw or thumb.height != ph:
                    thumb = thumb.thumbnail_image(pw, height=ph, size="force")
                # Opaque cell: append a full alpha plane so the cell body is solid over
                # the transparent pad (bandjoin(255) on the 3-band thumb → RGBA).
                opaque = thumb.copy(interpretation="srgb").bandjoin(255).copy(interpretation="srgb")
                cell_imgs.append(opaque)
                xs.append(left)
                ys.append(top)
    # Paint bottom-to-top in fine_members (id) order — later cells over earlier, matching
    # the old insert chain exactly. composite places overlay i at (xs[i], ys[i]) over the
    # transparent base and clips out-of-bounds cells just as insert did.
    if cell_imgs:
        canvas = canvas.composite(cell_imgs, "over", x=xs, y=ys)
    return canvas.copy(interpretation="srgb").copy_memory()


# Schema-metadata key under which a fine tile's coincident-point drop count rides
# (v2.1 reconciliation, documented in tile.schema.json fineTile.subsampled). The
# value is the decimal-string count; absent => the tile dropped nothing.
SUBSAMPLED_DROPPED_KEY = b"subsampled.dropped"


def _fine_records(
    members: list[_Cell],
    z: int,
    tile_px: int,
    thumb_px: int,
    detail_ref_by_id: dict[int, str] | None,
    dropped: int = 0,
) -> pa.Table:
    """The per-cell record list for a fine tile. The UV sub-rect (u,v,uw,uh) indexes
    into THIS tile's mini-atlas: slot i sits at column i%per_axis, row i//per_axis,
    each thumb_px/tile_px wide. x,y,w,h are the cell's world placement (unchanged).
    ``detail_ref`` is the cell's detail-tier original ref when ``detail_ref_by_id``
    is supplied (else null).

    When ``dropped`` > 0 (coincident-point subsampling decimated this tile to cap),
    the count is stamped into the table's SCHEMA-LEVEL metadata under
    ``subsampled.dropped`` so a consumer / the contract gate can read it without a
    side channel (v2.1 reconciliation — tile.schema.json fineTile.subsampled). The
    dropped ids are absent from this record list but keep their dense numbering."""
    per_axis = tile_px // thumb_px
    uv = thumb_px / tile_px
    n = len(members)
    refs = detail_ref_by_id or {}
    ids, xs, ys, ws, hs, us, vs, drefs = [], [], [], [], [], [], [], []
    for i, c in enumerate(members):
        col, row = i % per_axis, i // per_axis
        ids.append(c.id)
        xs.append(c.x)
        ys.append(c.y)
        ws.append(c.w)
        hs.append(c.h)
        us.append(col * uv)
        vs.append(row * uv)
        drefs.append(refs.get(c.id))
    arrays = [
        pa.array(ids, pa.int64()),
        pa.array(xs, pa.float32()),
        pa.array(ys, pa.float32()),
        pa.array(ws, pa.float32()),
        pa.array(hs, pa.float32()),
        pa.array(us, pa.float32()),
        pa.array(vs, pa.float32()),
        pa.array([uv] * n, pa.float32()),  # uw
        pa.array([uv] * n, pa.float32()),  # uh
        pa.array([z] * n, pa.int32()),     # level (pinned to this fine tile's z)
        pa.array(drefs, pa.string()),      # detail_ref (T2-26)
        pa.array([None] * n, pa.int32()),  # color
        pa.array([None] * n, pa.int32()),  # cluster_id
        pa.array([None] * n, pa.int32()),  # edge_count
        pa.array([None] * n, pa.int32()),  # embedding_dim
    ]
    schema = CELL_RECORD_SCHEMA
    if dropped > 0:
        schema = schema.with_metadata({SUBSAMPLED_DROPPED_KEY: str(dropped).encode("ascii")})
    return pa.Table.from_arrays(arrays, schema=schema)


def _encode_webp(img: pyvips.Image) -> bytes:
    """Lossy WebP bytes for a tile image (the Phase-1 tile format)."""
    return bytes(img.copy(interpretation="srgb").webpsave_buffer())


def _encode_arrow(table: pa.Table) -> bytes:
    """Uncompressed Arrow IPC (Feather) bytes for a fine tile's record list (D-29 —
    apache-arrow JS cannot decode compressed record batches)."""
    sink = io.BytesIO()
    feather.write_feather(table, sink, compression="uncompressed")
    return sink.getvalue()


def _pack_fine_body(mini_atlas: pyvips.Image, records: pa.Table) -> bytes:
    """Bundle a fine tile body: [uint32 BE image_len][webp][arrow] (resolved Q4)."""
    image_bytes = _encode_webp(mini_atlas)
    arrow_bytes = _encode_arrow(records)
    return _FINE_PREFIX.pack(len(image_bytes)) + image_bytes + arrow_bytes


def unpack_fine_body(body: bytes) -> tuple[bytes, bytes]:
    """Inverse of _pack_fine_body: (webp image bytes, arrow record bytes). Provided
    so the contract gate / consumers parse the bundle without re-deriving the
    framing (documented in schemas/v2/tile.schema.json)."""
    (image_len,) = _FINE_PREFIX.unpack_from(body, 0)
    start = _FINE_PREFIX.size
    return body[start:start + image_len], body[start + image_len:]


def read_overview_webp(pmtiles_path: Path, z_cap: int) -> bytes | None:
    """The z=0 (whole-world) tile's WebP overview bytes from a baked pyramid — the
    source of a dataset's Library card cover (T2-55). The z=0 tile always exists (a
    non-empty layout folds up to the single root tile). Its body framing depends on
    whether z=0 is the pyramid's FINE level: when ``z_cap > 0`` the root is a COARSE
    mosaic tile whose body IS the raw WebP; when ``z_cap == 0`` (a tiny all-fine
    pyramid, e.g. the minimal golden fixture) the root is a FINE tile whose body
    bundles the mini-atlas WebP + records, so unwrap it via ``unpack_fine_body``.
    Either way the returned bytes are a decodable WebP of the whole-world overview.
    Returns None only if the container has no z=0 tile (a malformed/empty pyramid)."""
    from pmtiles.reader import MmapSource, Reader

    with pmtiles_path.open("rb") as fh:
        body = Reader(MmapSource(fh)).get(0, 0, 0)
    if body is None:
        return None
    if z_cap <= 0:  # z=0 is the FINE level: the WebP is the first bundle member
        image_bytes, _records = unpack_fine_body(body)
        return image_bytes
    return body  # z=0 is a COARSE mosaic tile: the body is the raw WebP


def read_subsampled_dropped(table: pa.Table) -> int:
    """The coincident-point drop count a fine tile recorded, read from its Arrow
    record table's schema-level metadata (``subsampled.dropped``); 0 when the tile
    dropped nothing. The documented inverse of the stamp in ``_fine_records`` (v2.1
    reconciliation — tile.schema.json fineTile.subsampled)."""
    meta = table.schema.metadata or {}
    raw = meta.get(SUBSAMPLED_DROPPED_KEY)
    return int(raw) if raw is not None else 0


def iter_tiles(pmtiles_path: Path, levels: list) -> "Iterator[tuple[int, int, int, bytes]]":
    """Yield every OCCUPIED ``(z, x, y, body)`` tile in a baked pyramid, given its
    manifest ``levels`` (each carrying ``z``). The PMTiles reader only resolves a
    tile by explicit {z}/{x}/{y}, so this scans the bounded 2^z grid per level and
    yields the tiles that exist (absent coords are skipped). Provided for the
    contract gate / verification; z_max is bounded (see _choose_z_max), so the scan
    is small. ``levels`` items may be PyramidLevel or dicts with a ``z`` key."""
    from pmtiles.reader import MmapSource, Reader

    with pmtiles_path.open("rb") as fh:
        reader = Reader(MmapSource(fh))
        for level in levels:
            z = level.z if isinstance(level, PyramidLevel) else level["z"]
            n_axis = 1 << z
            for x in range(n_axis):
                for y in range(n_axis):
                    body = reader.get(z, x, y)
                    if body is not None:
                        yield z, x, y, body


# --- coarse mosaic composites -----------------------------------------------


@dataclass
class _DilationStats:
    """Mutable per-bake counters for the coverage-gated dilation floor (b2). Threaded
    through the coarse-build recursion so a test can assert — via structure, not
    pixels — whether the dilation branch fired (``applied`` > 0 for a sparse layout,
    == 0 for a dense one). ``considered`` is every coarse tile the gate evaluated."""

    considered: int = 0
    applied: int = 0


def _coverage(img: pyvips.Image) -> float:
    """Fraction of ``img`` that is NON-TRANSPARENT, as the mean of its alpha band
    normalized to [0,1] (a fully-opaque image is 1.0, a fully-transparent pad 0.0). A
    3-band image (no alpha) reads as fully covered (1.0) — the coarse path is always
    RGBA, but this keeps the helper total. This is the cell-coverage signal the
    dilation gate (MIN_COARSE_COVERAGE) reads."""
    if not img.hasalpha():
        return 1.0
    return float(img.extract_band(img.bands - 1).avg()) / 255.0


def _dilate_opaque(img: pyvips.Image, radius: int) -> pyvips.Image:
    """Grow the opaque, COLORED cell footprint by ``radius`` px into the surrounding
    TRANSPARENT [0,0,0,0] pad, WITHOUT altering any already-opaque pixel. A per-band
    window max (morphological dilate) raises the pad pixels bordering a cell to the
    cell's RGB+alpha (dilating color and alpha TOGETHER, never smearing alpha apart
    from color); an ``ifthenelse`` mask then keeps every originally-covered pixel
    (alpha>0) BYTE-EXACT and lets only the grown value fill originally-transparent pad.
    Masking the interior matters where a SPARSE parent holds a locally-DENSE child: the
    coverage gate is a per-parent average, so a dense child among sparse siblings is
    dilated too, and an unmasked per-band max would raise a dark cell toward a bright
    neighbour — distorting the dense interior's color. The mask confines the change to
    the cell/pad rim, so the dense interior is preserved exactly (PR #111 review). An
    isolated cell (all neighbours transparent) grows identically either way, so the
    sparse-legibility floor is unchanged. Radius 1 exactly compensates one 2x mean
    shrink, so applying it before each coarse 4->1 shrink compounds to the spike's
    2^(z_cap-z) cumulative growth. The window is clamped to the image size (rank raises
    on a window larger than the image); a <2px image is returned unchanged (nothing to
    dilate into)."""
    size = 2 * radius + 1
    size = min(size, img.width, img.height)
    if size < 2:
        return img
    if size % 2 == 0:  # rank uses an odd, symmetric window
        size -= 1
    if size < 2:
        return img
    grown = img.rank(size, size, size * size - 1)  # last index = window maximum
    if not img.hasalpha():
        return grown
    # Keep every originally-covered pixel (alpha>0) EXACT; only the grown value fills
    # the originally-transparent (alpha==0) pad, so a dense interior is untouched and
    # only the pad-facing rim grows (cond!=0 -> in1=img, cond==0 -> in2=grown).
    covered = img.extract_band(img.bands - 1) > 0
    return covered.ifthenelse(img, grown)


def _shrink_children_to_parent(
    children: dict[tuple[int, int], pyvips.Image],
    parent_key: tuple[int, int],
    tile_px: int,
    stats: _DilationStats | None = None,
) -> pyvips.Image:
    """Mosaic the (up to 4) child tiles of ``parent_key`` into one tile_px parent
    (mip-style): each child is shrunk to tile_px/2 and placed in its quadrant; a
    missing child quadrant stays the transparent pad. ``children`` maps the child's
    (tx, ty) at the finer level to its decoded RGBA image (spatial renders at the
    fine level, coarse mosaics above). Quadrant order (dy outer, dx inner) is fixed so
    the composite is byte-reproducible.

    COVERAGE-GATED DILATION FLOOR (b2, decision D-iv): when the combined children's
    cell coverage (mean alpha) is below ``MIN_COARSE_COVERAGE`` — a SPARSE overview
    region — each child is max-filter/dilated by 1px BEFORE the shrink, so every cell
    keeps ~1px of colored, opaque presence at this level instead of the mean shrink
    dimming it toward the transparent pad. Dense layouts (grid/categorical, coverage
    >= the gate) skip the branch entirely, so their coarse bytes are unchanged by b2.
    ``stats`` (optional) counts whether the branch fired for a structural test."""
    px, py = parent_key
    half = tile_px // 2
    parent = pyvips.Image.black(tile_px, tile_px, bands=4).copy(interpretation="srgb")

    present = [children[(px * 2 + dx, py * 2 + dy)]
               for dy in (0, 1) for dx in (0, 1)
               if (px * 2 + dx, py * 2 + dy) in children]
    # Gate on the mean coverage across the present children: a sparse overview region
    # (below MIN_COARSE_COVERAGE) gets the dilation floor; a dense one does not. Only
    # the alpha means are read (cheap, ~0.15ms/tile), never a decode.
    dilate = False
    if present:
        combined_cov = sum(_coverage(c) for c in present) / len(present)
        dilate = combined_cov < MIN_COARSE_COVERAGE
    if stats is not None:
        stats.considered += 1
        if dilate:
            stats.applied += 1

    for dy in (0, 1):
        for dx in (0, 1):
            child = children.get((px * 2 + dx, py * 2 + dy))
            if child is None:
                continue
            img = child.colourspace("srgb").copy(interpretation="srgb")
            if dilate:
                # Restore ~1px of colored, opaque presence per cell before the mean
                # shrink halves resolution (compounds up the sparse subtree).
                img = _dilate_opaque(img, 1).copy(interpretation="srgb")
            shrunk = img.thumbnail_image(half, height=half).copy(interpretation="srgb")
            parent = parent.insert(shrunk, dx * half, dy * half)
    # copy_memory MATERIALIZES the mosaic into a standalone buffer, severing the lazy
    # pyvips pipeline's references to the child images. Without this, the returned
    # `parent` is a lazy op tree that transitively pins every descendant tile's image
    # (and their thumbnails) until the ROOT is finally rendered — so `children.clear()`
    # in _bake_subtree frees nothing and peak memory scales with the cell count (the
    # 1M-readiness regression the scale gate caught: 4.5 GB at 40k). Materializing here
    # makes the DFS resident set genuinely O(subtree) and renders each tile exactly once.
    return parent.copy(interpretation="srgb").copy_memory()


# --- spill-to-disk body store (streaming bake) ------------------------------


class _BodySpill:
    """An append-only on-disk store for encoded tile bodies, with a tiny in-memory
    ``{(z,x,y) -> (offset, length)}`` index — the mechanism that lets the baker hold
    only the CURRENT DFS subtree in memory (the 1M-readiness fix).

    The pyramid is built FINE-first (bottom up: a coarse parent needs its children's
    decoded images), but the PMTiles writer requires bodies in TILE-ID order (which
    is coarse-first). That reversal is exactly why the old baker buffered every body
    in RAM at once. Spilling each finished body here and replaying it in tile-id order
    from the index breaks that dependency: peak resident memory becomes O(subtree),
    not O(pyramid)."""

    def __init__(self, path: Path) -> None:
        self._fh = path.open("w+b")
        self._index: dict[tuple[int, int, int], tuple[int, int]] = {}
        self._offset = 0

    def put(self, z: int, x: int, y: int, body: bytes) -> None:
        self._fh.write(body)
        self._index[(z, x, y)] = (self._offset, len(body))
        self._offset += len(body)

    def keys(self) -> list[tuple[int, int, int]]:
        return list(self._index)

    def get(self, z: int, x: int, y: int) -> bytes:
        offset, length = self._index[(z, x, y)]
        self._fh.seek(offset)
        return self._fh.read(length)

    def close(self) -> None:
        self._fh.close()


def _occupied_coords_by_level(
    fine_keys: set[tuple[int, int]], z_max: int
) -> dict[int, set[tuple[int, int]]]:
    """Occupied (tx, ty) tile coords at every level 0..z_max, derived from the fine
    (deepest) buckets by folding each level's coords up to their parents. A coarse
    tile is occupied iff any of its 4 children is — so the upward fold gives the
    exact sparse occupied set per level (no scan of an empty 2^z grid)."""
    by_level: dict[int, set[tuple[int, int]]] = {z_max: set(fine_keys)}
    for z in range(z_max - 1, -1, -1):
        by_level[z] = {(cx // 2, cy // 2) for (cx, cy) in by_level[z + 1]}
    return by_level


def _bake_subtree(
    z: int,
    key: tuple[int, int],
    z_max: int,
    occupied: dict[int, set[tuple[int, int]]],
    fine_members: dict[tuple[int, int], list[_Cell]],
    dropped: dict[tuple[int, int], int],
    spill: _BodySpill,
    *,
    layout_id: str,
    cache_dir: Path,
    tile_px: int,
    thumb_px: int,
    bbox: tuple[float, float, float, float],
    detail_ref_by_id: dict[int, str] | None,
    dilation_stats: _DilationStats,
    report_tile: Callable[[], None],
) -> pyvips.Image:
    """DEPTH-FIRST bake of the subtree rooted at tile (z, key): spill this tile's
    encoded body and RETURN its decoded image (its parent shrinks it into a mosaic).

    The recursion keeps only the current root-to-leaf path plus the (up to 4) child
    images being mosaicked resident at once — a working set of ~O(z_max) images,
    INDEPENDENT of the cell count. Each child's decoded image is freed the moment
    this parent has shrunk it into its quadrant (the dict drops the reference at
    return), so memory does not scale with N (the 1M-readiness fix). A fine tile's
    body is spilled coarse-of-its-own bundle; a coarse tile's body is the raw WebP."""
    if z == z_max:
        members = fine_members[key]
        # Read this fine tile's thumbnails once and share them between the mini-atlas
        # (served body) and the spatial render (coarse-mip source) below.
        tile_thumbs = _decode_tile_thumbs(members, cache_dir)
        # .copy_memory(): materialize the mini-atlas so the image returned up the DFS
        # is a flat buffer, not a lazy pipeline still referencing the source thumbnails
        # (see _shrink_children_to_parent — same O(subtree)-memory reason).
        mini = _build_mini_atlas(members, tile_thumbs, tile_px, thumb_px).copy_memory()
        drop = dropped.get(key, 0)
        records = _fine_records(members, z, tile_px, thumb_px, detail_ref_by_id, drop)
        spill.put(z, key[0], key[1], _pack_fine_body(mini, records))
        report_tile()  # one tile spilled (O1 per-tile progress; done via the closure)
        if drop:
            logger.info(
                "layout %s tile %d/%d/%d subsampled: dropped=%d (ids remain in "
                "metadata + detail tier; dense numbering untouched)",
                layout_id, z, key[0], key[1], drop,
            )
        # Hand the coarse mip a SPATIAL render (cells at world positions), NOT the
        # padded mini-atlas. The mini-atlas stays this tile's served body above, so
        # the fine tier is unchanged; only the source the coarse overviews shrink
        # from changes — fixing the banded "shrunk packing sheet" coarse tiles.
        return _build_spatial_render(
            fine_members, key[0], key[1], z, bbox, cache_dir, tile_px, tile_thumbs
        )

    # Coarse tile: recurse into its occupied children, mosaic them, free them.
    px, py = key
    children: dict[tuple[int, int], pyvips.Image] = {}
    child_level = occupied[z + 1]
    for dy in (0, 1):
        for dx in (0, 1):
            child_key = (px * 2 + dx, py * 2 + dy)
            if child_key in child_level:
                children[child_key] = _bake_subtree(
                    z + 1, child_key, z_max, occupied, fine_members, dropped, spill,
                    layout_id=layout_id, cache_dir=cache_dir, tile_px=tile_px,
                    thumb_px=thumb_px, bbox=bbox, detail_ref_by_id=detail_ref_by_id,
                    dilation_stats=dilation_stats, report_tile=report_tile,
                )
    parent = _shrink_children_to_parent(children, key, tile_px, dilation_stats)
    children.clear()  # drop the child images — this subtree is done with them
    spill.put(z, px, py, _encode_webp(parent))
    report_tile()  # one tile spilled (O1 per-tile progress; done via the closure)
    return parent


# --- the top-level baker -----------------------------------------------------


# What each _choose_z_max stop implies about the cells a fine tile could not fit. The
# reason is per-LAYOUT and the drops are per-TILE, so these are the shape of the answer,
# not a partition of the count — see T2-145.
_DROP_MEANING = {
    "coincidence": (
        "they are (near-)coincident with cells that WERE baked — drawn on top of each "
        "other, so no subdivision separates them"
    ),
    "cell-size ceiling": (
        "they are piled at a scale below one cell, so no subdivision separates them "
        "without drawing cells many tiles wide"
    ),
    "tile budget": (
        "subdivision was still separating them when the tile budget stopped it, so unlike "
        "the occlusion cases these WOULD have been placed at a deeper level (the count may "
        "still include coincident piles in other tiles — T2-145)"
    ),
    "hard _MAX_DEPTH ceiling": (
        "subdivision hit the absolute depth ceiling while cells were still separating, so "
        "like the budget stop these WOULD have been placed deeper (T2-145)"
    ),
}

# The stops whose surplus is OCCLUSION — cells behind other cells at every resolution the
# pyramid can reach. Everything else is reported at WARNING.
#
# WHY THE LEVEL DEPENDS ON THE REASON (operator decision): "a genuine pile does not matter.
# We don't need to be warned about it or hear about it." An occluded cell keeps its
# `positions_ref` row, so the viewer's pile chip already reports the true count, and no
# amount of subdividing would have shown it — there is nothing for an operator to act on.
# The `tile budget` stop is the opposite: it is only ever REACHED while `overflow_separable`
# is still True (the coincidence branch returns first), so every cell it drops is one that
# demonstrably would have separated at a deeper level. That is the lossy case, and the one
# worth interrupting someone over. `hard _MAX_DEPTH ceiling` is grouped WITH the budget: the
# loop only reaches _MAX_DEPTH by passing the resolution/coincidence check at every level,
# so those cells are separable too — it is the same lossy shape, just bounded by depth
# rather than by tile count. An unrecognised reason also warns, so a stop added later is
# loud until someone classifies it.
_OCCLUSION_DROP_REASONS = frozenset({"coincidence", "cell-size ceiling"})


def drop_log_level(reason: str) -> int:
    """``logging.INFO`` when a subsample is occlusion, ``logging.WARNING`` when it dropped
    cells that would have separated. Shared by the tiler and the worker so the two surfaces
    can never disagree about how loud the same event is."""
    return logging.INFO if reason in _OCCLUSION_DROP_REASONS else logging.WARNING


def describe_drop(reason: str) -> str:
    """The clause explaining what a subsample under ``reason`` means for the cells left
    out — shared with the worker's dataset-log line so both surfaces say the same thing."""
    return _DROP_MEANING.get(reason, "the cause is not one this message knows about")


# The closing sentence of BOTH drop reports — the tiler's (``_report_drop``, on the tiler's
# own logger) and the worker's (``_log_dropped_cells``, re-emitted into the dataset's
# ingest.log). Single-sourced like ``drop_log_level``/``describe_drop`` so the "nothing is
# lost" reassurance cannot drift between the two surfaces (it had: "Every id keeps its…" vs
# "Those ids keep their…"). No ``%`` — safe to concatenate into a logging format string.
DROP_KEEPS_NOTE = (
    "Every id keeps its metadata.parquet row, its position-table entry (the viewer still "
    "counts it) and its detail-tier original."
)


def _cell_tile_spans(
    cells: list[_Cell],
    bbox: tuple[float, float, float, float],
    z_max: int,
    *,
    max_w: float | None = None,
    max_h: float | None = None,
) -> tuple[float, float]:
    """How many TILES wide/tall the largest cell is at the chosen fine level — the number
    that says how far a bake went past the point where a cell fits one tile (T2-147).

    ``_choose_z_max`` now yields the cell-size ceiling whenever the over-cap cells are laid
    out rather than piled, which is what stops a narrow layout losing most of itself. The
    price is paid here: past the ceiling a cell spans more than one tile on the squeezed
    axis, and the coarse spatial render only draws cells from the 3x3 neighbour window, so
    an overview under-draws such a cell to roughly ``3 / ratio`` of its width. That was
    previously reported as the adjective "may under-draw"; this is the measurement. A
    degenerate axis (zero span) reads 0.0 — every cell maps to that axis's single row."""
    span_x = bbox[2] - bbox[0]
    span_y = bbox[3] - bbox[1]
    tiles = 1 << z_max
    # Passed in by `bake_pyramid` (computed once per bake); scanned here only for a direct caller.
    if max_w is None:
        max_w = max((c.w for c in cells), default=0.0)
    if max_h is None:
        max_h = max((c.h for c in cells), default=0.0)
    return (
        max_w / (span_x / tiles) if span_x > 0.0 else 0.0,
        max_h / (span_y / tiles) if span_y > 0.0 else 0.0,
    )


def _report_drop(
    layout_id: str, dropped_total: int, n: int, tiles: int, cap: int, z_cap: int, reason: str
) -> None:
    """Say what this bake could not fit into the fine tier, and what that does and does not
    mean (T2-143). Reports only — nothing is refused; see the no-threshold note at the top.

    Deliberately NOT worded as data loss. Every id keeps its ``metadata.parquet`` row, its
    ``positions_ref`` entry (so the viewer's pile chip still counts it) and its detail-tier
    original; what it loses is a slot in this layout's fine tile. Under the coincidence and
    cell-size stops that is OCCLUSION, which is not a defect — the cells are underneath
    other cells. Under the tile-budget stop the same count means something worse, so the
    stop reason is named rather than left to be guessed. ``dropped_total`` cannot yet
    SPLIT the two (T2-145), and this message must not pretend otherwise.

    The LEVEL follows the reason (see ``_OCCLUSION_DROP_REASONS``): occlusion is INFO,
    because there is nothing an operator could do about a cell that is behind another cell
    at every resolution; a budget/depth truncation is WARNING, because those cells would
    have been placed. Per-tile detail stays at ``info`` in ``_bake_subtree``."""
    if dropped_total <= 0 or n <= 0:
        return
    logger.log(
        drop_log_level(reason),
        "layout %s: %d of %d cells (%.2f%%) are not baked into the fine tier — %d tile(s) "
        "held more than cap=%d at z_cap=%d and were subsampled to it. The fine level was "
        "chosen by %s, so %s. " + DROP_KEEPS_NOTE,
        layout_id, dropped_total, n, 100.0 * dropped_total / n, tiles, cap, z_cap,
        reason, describe_drop(reason),
    )


def bake_pyramid(
    layout_id: str,
    cells_table: pa.Table,
    bbox: tuple[float, float, float, float],
    cache: ThumbnailCache,
    output_path: Path,
    dataset_version: int,
    tile_px: int,
    thumb_px: int,
    detail_path_prefix: str | None = None,
    detail_format: str | None = None,
    detail_ref_by_id: dict[int, str] | None = None,
    on_tile: Callable[[int, int], None] | None = None,
) -> PyramidResult:
    """Bake ONE layout's whole spatial pyramid into a single PMTiles container.

    ``cells_table`` is the layout's spatial cells (id, x, y, w, h — the LOD-
    independent fields the layout plugin produced, with DENSE ids). ``cache`` is
    the shared per-cell thumbnail cache (``decode_thumbnails``). Returns a
    ``PyramidResult`` the manifest emitter turns into the layout's ``pyramid``
    descriptor.

    Writes the PMTiles to ``output_path`` (the worker passes a version-stamped
    path). The pyramid is levels 0..z_max with z_cap == z_max (the deepest level is
    FINE — mini-atlas + records; shallower levels are COARSE mosaics built bottom-up
    from their children). ``dataset_version`` is stamped into the PMTiles container's
    JSON metadata (provenance, alongside layout_id + z_cap).

    MEMORY (1M-readiness): the pyramid is baked DEPTH-FIRST (``_bake_subtree``) so
    only the current root-to-leaf subtree of decoded images is resident at any time
    (~O(z_max) images, INDEPENDENT of cell count); each finished tile's encoded body
    is spilled to a temp file (``_BodySpill``) keyed by (z,x,y). The bodies are then
    streamed to the PMTiles writer in tile-id (coarse-first) order by reading them
    back from the spill via its index — which is the REVERSE of the fine-first build
    order, the dependency the old (whole-pyramid-resident) baker could only satisfy
    by buffering everything. Output is byte-identical to that baker (the spill is a
    pure memory optimization; the PMTiles writer sorts by tile-id regardless).

    PROGRESS (Seam O1, optional): ``on_tile(done, total)`` is invoked once per tile
    as each tile's body is spilled (both spill sites in ``_bake_subtree``), where
    ``total`` is the exact tile count computed BEFORE the DFS from the occupied sets.
    The tiler stays API/RQ-agnostic — the worker supplies the closure (throttled).
    None (the default) makes tile reporting a no-op; it never affects the bake.

    NOTHING IS SUBSAMPLED QUIETLY (T2-143). A non-zero ``dropped_total`` is a WARNING
    naming the layout, the count, the fraction and the stop reason ``_choose_z_max``
    chose — not the two ``info`` lines it used to be. It is a report, not a refusal:
    those cells keep their position-table row, so the honest description is "not baked
    into the fine tier", and the stop reason is what says whether that means occlusion
    or a budget truncation (T2-145). The worker re-emits the same facts into the
    DATASET's ingest.log, which this logger does not reach.
    """
    cap = cap_for(tile_px, thumb_px)
    cells = [
        _Cell(
            id=int(i),
            x=float(x),
            y=float(y),
            w=float(w),
            h=float(h),
        )
        for i, x, y, w, h in zip(
            cells_table.column("id").to_pylist(),
            cells_table.column("x").to_pylist(),
            cells_table.column("y").to_pylist(),
            cells_table.column("w").to_pylist(),
            cells_table.column("h").to_pylist(),
        )
    ]
    cells.sort(key=lambda c: c.id)  # deterministic, id order

    # Largest cell footprint, scanned ONCE and threaded into every consumer (`_choose_z_max` ->
    # `_level_summary` + `_cell_size_z_ceiling`, and `_cell_tile_spans` below) instead of each
    # re-scanning `cells` (up to 1M) for the same two numbers.
    max_w = max((c.w for c in cells), default=0.0)
    max_h = max((c.h for c in cells), default=0.0)
    z_max, z_max_reason = _choose_z_max(cells, bbox, cap, max_w=max_w, max_h=max_h)
    z_cap = z_max
    cache_dir = cache.cache_dir

    # Bucket cells into their deepest (fine) tiles + per-tile coincident-point drops;
    # only the cell-to-tile assignment is held here (light), not any decoded image.
    fine_members, dropped = _group_fine_tiles(cells, bbox, z_max, cap)
    dropped_total = sum(dropped.values())
    _report_drop(layout_id, dropped_total, len(cells), len(dropped), cap, z_cap, z_max_reason)
    # How far past "a cell fits one tile" this bake went (T2-147). Emitted for EVERY bake
    # that went past it — not once at the first level, as the yield note in _choose_z_max
    # was — so the number lands beside z_cap in the record of the bake.
    cell_tiles_x, cell_tiles_y = _cell_tile_spans(cells, bbox, z_max, max_w=max_w, max_h=max_h)
    if max(cell_tiles_x, cell_tiles_y) > 1.0:
        logger.info(
            "layout %s: at z_cap=%d the largest cell spans %.2f x %.2f tiles; the coarse "
            "3x3 neighbour window draws at most ~3, so the overview shows about %.0f%% of "
            "its width (unbounded + ungated — T2-147)",
            layout_id, z_cap, cell_tiles_x, cell_tiles_y,
            100.0 * min(1.0, 3.0 / max(cell_tiles_x, cell_tiles_y)),
        )
    occupied = _occupied_coords_by_level(set(fine_members), z_max)

    # Per-tile progress (O1): the EXACT tile total is the sum of every level's
    # occupied set, known here BEFORE the DFS — so ``on_tile`` reports a real
    # fraction from the first tile (NO-FAKE-PROGRESS). The closure holds the running
    # count and is threaded into ``_bake_subtree``; each spill site calls it once.
    total_tiles = sum(len(coords) for coords in occupied.values())
    tiles_done = 0

    def _report_tile() -> None:
        nonlocal tiles_done
        tiles_done += 1
        if on_tile is not None:
            on_tile(tiles_done, total_tiles)

    # --- DEPTH-FIRST bake: spill bodies, hold only the current subtree resident ---
    # The spill name carries the pid so a hard-killed prior bake's stale file (the
    # try/finally below unlinks it on any normal/exception exit, but not on SIGKILL)
    # can never be mistaken for or collide with this run's; it is a private temp,
    # never part of the output, so the pid does not affect byte-reproducibility.
    spill_path = output_path.parent / f".{output_path.stem}.{os.getpid()}.spill"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    spill = _BodySpill(spill_path)
    dilation_stats = _DilationStats()
    try:
        # A non-empty layout always folds up to the single root tile (0, 0); recurse
        # from it. (cells is non-empty: ingest rejects an empty scan and the worker
        # guards on no decodable images, so occupied[0] == {(0, 0)} here.)
        for root_key in sorted(occupied[0]):
            _bake_subtree(
                0, root_key, z_max, occupied, fine_members, dropped, spill,
                layout_id=layout_id, cache_dir=cache_dir, tile_px=tile_px,
                thumb_px=thumb_px, bbox=bbox, detail_ref_by_id=detail_ref_by_id,
                dilation_stats=dilation_stats, report_tile=_report_tile,
            )

        # --- level list (coarsest first), tile counts from the occupied sets ---
        levels = [PyramidLevel(z=z, tile_count=len(occupied[z])) for z in range(0, z_max + 1)]

        # --- stream bodies to the PMTiles writer in tile-id order from the spill ---
        _write_pmtiles(
            output_path,
            spill,
            metadata={
                "layout": "image-viz spatial pyramid (D-33)",
                "layout_id": layout_id,
                "dataset_version": dataset_version,
                "z_cap": z_cap,
            },
        )
    finally:
        spill.close()
        spill_path.unlink(missing_ok=True)

    rel_path = _relative_path(output_path, output_path.parents[2])  # dataset root = .../{ds}/
    return PyramidResult(
        path=rel_path,
        tile_px=tile_px,
        thumb_px=thumb_px,
        cap=cap,
        levels=levels,
        z_cap=z_cap,
        detail_path_prefix=detail_path_prefix,
        detail_format=detail_format,
        dropped_total=dropped_total,
        coarse_dilated=dilation_stats.applied,
        z_max_reason=z_max_reason,
        cell_tiles_x=cell_tiles_x,
        cell_tiles_y=cell_tiles_y,
    )


def _relative_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


@contextlib.contextmanager
def _deterministic_gzip() -> Iterator[None]:
    """Force ``gzip.compress`` to a fixed mtime so the PMTiles container is
    byte-reproducible.

    REPRODUCIBILITY: ``pmtiles.writer.Writer.finalize`` gzip-compresses the root
    directory (``pmtiles.tile.serialize_directory``) and the JSON metadata via
    ``gzip.compress(...)`` with no ``mtime`` argument. With ``mtime=None`` Python
    stamps the *current wall-clock time* into each gzip header's 4-byte MTIME field,
    so two regens of byte-IDENTICAL tile bodies still produce containers that differ
    byte-for-byte (the only drift, localized at the root-dir + metadata gzip headers).
    The ``pmtiles`` lib exposes no hook for this, so we patch ``gzip.compress`` to
    default ``mtime=0`` for the duration of the write (restored on exit). Tile bodies,
    Arrow records and WebP are unaffected — they were already deterministic. This
    makes a pyramid bake byte-reproducible across regens on a fixed toolchain (the
    golden-fixture byte-stability claim — see tests/fixtures/build_fixture.py)."""
    original = gzip.compress

    @functools.wraps(original)
    def _fixed_mtime(data, compresslevel=9, *, mtime=None):  # type: ignore[no-untyped-def]
        return original(data, compresslevel, mtime=0 if mtime is None else mtime)

    gzip.compress = _fixed_mtime  # type: ignore[assignment]
    try:
        yield
    finally:
        gzip.compress = original  # type: ignore[assignment]


def _write_pmtiles(
    output_path: Path,
    spill: "_BodySpill",
    metadata: dict,
) -> None:
    """Pack the spilled ``(z,x,y) -> body`` tiles into one PMTiles container at
    ``output_path``, streaming each body back from the spill file in tile-id order.

    PMTiles stores arbitrary blobs per {z}/{x}/{y} (verified: pmtiles.writer.Writer
    + zxy_to_tileid). We use TileType.UNKNOWN + Compression.NONE because a tile body
    is our own bundle (WebP image, or WebP+Arrow for a fine tile), not a standard
    map tile. Tiles are written in tile-id order (the writer requires ascending id);
    only ONE body is resident at a time (read from the spill just before writing),
    so the writer step is also cell-count-independent in memory.

    NOTE: ``Writer.finalize`` recomputes ``min_zoom``/``max_zoom`` from the actual
    written tile entries (it overwrites whatever we pass), so we do NOT supply them
    — they would be dead. ``metadata`` is stamped into the container's JSON metadata
    blob (provenance: layout_id, dataset_version, z_cap).

    The whole write runs under ``_deterministic_gzip`` so the container is
    byte-reproducible (the gzip MTIME the writer stamps into the root directory +
    metadata is the sole non-determinism — see that helper).
    """
    from pmtiles.tile import Compression, TileType, zxy_to_tileid
    from pmtiles.writer import Writer

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as handle, _deterministic_gzip():
        writer = Writer(handle)
        for (z, x, y) in sorted(spill.keys(), key=lambda k: zxy_to_tileid(k[0], k[1], k[2])):
            writer.write_tile(zxy_to_tileid(z, x, y), spill.get(z, x, y))
        writer.finalize(
            {
                "tile_type": TileType.UNKNOWN,
                "tile_compression": Compression.NONE,
                # min_zoom/max_zoom are recomputed by finalize() from the tile
                # entries; do not pass them.
                "min_lon_e7": 0,
                "min_lat_e7": 0,
                "max_lon_e7": 0,
                "max_lat_e7": 0,
                "center_zoom": 0,
                "center_lon_e7": 0,
                "center_lat_e7": 0,
            },
            metadata,
        )
