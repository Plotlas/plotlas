// T2-72 Seam 1 — the DOM OVERLAY SUBSTRATE (spike docs/spikes/spike_overlay_substrate.md
// §5 "Seam 1", premise docs/spikes/spike_labels_aggregate_premise.md ✅ ratified 2026-07-21).
//
// This is "Layer A" of the substrate memo: a pointer-events:none DOM layer pinned OVER the
// canvas in `.canvas-holder`, camera-locked via `worldToScreen` (the float64-JS inverse of
// cells.ts's `screenToWorld`), repositioned per camera event and rAF-coalesced (the
// viewerStatus / detailOverlay pattern). Unlike detailOverlay.ts and highlightOverlay.ts —
// its in-canvas WebGL siblings — this substrate owns crisp DOM text/marks that re-rasterize
// at native DPI and are immune to the float32 deep-zoom jitter the memo §2 warns about.
//
// FIRST CONSUMERS (this seam):
//   1. AGGREGATE COUNT CHIPS (D-35 Seam G4b): the honest occupancy of scatter/geo PILES.
//      Real scatter/geo layouts silently subsample 10–36 % of co-located cells at the finest
//      baked tile (rijks log/log dims 35.5 %, inat100k geo 17.8 %). The tiler drops the
//      surplus with ZERO on-screen signal. A chip states the truth: "N here" at each over-cap
//      pile. The count is RE-DERIVED render-time from the client-resident `positions_ref`
//      table by replicating the tiler's binning (tiler._tile_xy + _group_fine_tiles at
//      z_cap==z_max) — NO re-bake, NO schema change, and it works at OVERVIEW where fine
//      tiles (which carry the baked `subsampled.dropped`) are not resident. ON by default
//      with a viewer toggle. See deriveHotspots.
//   2. DATETIME AXES (T2-69): year/era nice-ticks along the datetime layout's time axis. The
//      time domain now rides the manifest as a v2.5 producer annotation (`annotations.axes` —
//      the datetime plugin's t_min/t_max, previously discarded), converted to the linear
//      t↔world-x fit synchronously (producerTimeAxis / axisDomainToTimeDomain). A datetime
//      dataset baked PRE-2.5 carries no axis annotation, so it GRACEFULLY DEGRADES to the
//      Seam-1 shim (deriving the domain from real dates via getMetadata) — the tick RENDER
//      path (niceTimeTicks / renderAxis) is identical either way. See rebuild().
//
// SEAM 2 CONSUMER — CATEGORICAL BAND LABELS (T2-69, this seam): the categorical treemap's
// per-band `annotations.labels` ({text, extent, count, missing?}). Placement follows the
// ratified 2026-07-21 rule — a label sits in the IMAGE-FREE GAP beside its band (the band's
// top-gutter strip; the treemap insets its images so that strip carries no image),
// NEVER over the images (labelGapSlot + the fit gate in renderLabels prove it geometrically).
// The map convention: label everything, but a small band's label REVEALS only once the band
// is big enough on screen for the label to fit its gap (zoom-reveal); collisions are
// greedy-culled by count (== area for the treemap) via declutterLabels. The structurally-
// MISSING bucket (missing:true) renders muted grey; a viewer TOGGLE appends the count to the
// text ("Rembrandt (247)", default OFF). See renderLabels / displayLabelText / labelGapSlot.
//
// A renderer module beside detailOverlay.ts / highlightOverlay.ts: it never imports React/UI
// (module-map rule 4 — it uses the raw DOM API + the global :root theme tokens), it is
// created + driven by layout.ts (the LayoutController pushes the active manifest + layout +
// position table via setContext), it runs off its OWN coalesced camera subscription, and it
// self-tears-down on the World's dispose (symmetric with its two siblings).
import type { ApiClient } from "../api-client/client.ts";
import { datetimeInstant } from "../api-client/datetimeValue.ts";
import type { PositionTable } from "./cells.ts";
import type { AxisAnnotation, AxisInterval, LabelAnnotation, LayoutEntry, LayoutManifest } from "./layout.ts";
import type { CameraState, Viewport, World, WorldHandle } from "./world.ts";

// ---------------------------------------------------------------------------
// Config (ONE runtime-mutable object — the T2-101 settings-panel scaffolding
// pattern, mirroring DetailOverlayConfig / HighlightOverlayConfig)
// ---------------------------------------------------------------------------

export interface OverlayLayerConfig {
  /** Min on-screen gap (CSS px) between two rendered chips: a candidate closer than this to
   *  an already-placed (higher-count) chip is ABSORBED, so an overview where hundreds of
   *  over-cap tiles collapse to a few screen pixels renders a legible handful, not a wall of
   *  overlapping pills. The bigger pile wins the spot (count-priority). */
  chipMinGapPx: number;
  /** Hard cap on chips rendered in one frame (DOM budget guard — the memo §1 "dozens–low
   *  hundreds" ceiling). Layout-wide there are 16–227 hotspots; the declutter keeps far
   *  fewer on screen, but this bounds a pathological view. */
  chipMaxCount: number;
  /** Approximate datetime-axis tick count at any zoom (premise §A.2: ~9 across a span). */
  axisTickTarget: number;
  /** Cells sampled at EACH x-extreme to derive the datetime domain from real dates
   *  (getMetadata cap is 250; 2·this must stay well under it). A small robust batch so one
   *  odd endpoint value cannot skew the linear fit. Only the PRE-2.5 fallback shim uses it. */
  domainSampleCount: number;
  /** Fraction of a categorical band's HEIGHT the label's gap-slot occupies — the band's
   *  top-gutter strip, which the treemap keeps image-free by insetting its members
   *  ((1 − _REGION_FILL)/2 = 0.05 in the producer). Kept ≤ that inset so a label placed in
   *  the slot is provably never over an image (the ratified placement rule). */
  labelGapFrac: number;
  /** Label box height (CSS px) used for the reveal gate + collision declutter — ~11px font
   *  + line-height/padding (the premise's ~11px min-legible math). A band reveals its label
   *  only when its gap-slot is at least this tall on screen. */
  labelHeightPx: number;
  /** Estimated glyph advance (CSS px) for the label width gate — labelWidthPx ≈
   *  text.length·labelCharPx + labelPadPx. A band reveals its label only when its gap-slot
   *  is at least that wide on screen, so a long name never spills past its band. */
  labelCharPx: number;
  /** Horizontal padding (CSS px) added to the estimated label width. */
  labelPadPx: number;
  /** Hard cap on band labels rendered in one frame (DOM budget guard; the declutter keeps
   *  far fewer on screen but this bounds a pathological all-tiny-bands view). */
  labelMaxCount: number;
}

export const DEFAULT_OVERLAY_LAYER_CONFIG: OverlayLayerConfig = {
  chipMinGapPx: 40,
  chipMaxCount: 120,
  axisTickTarget: 9,
  domainSampleCount: 16,
  labelGapFrac: 0.05,
  labelHeightPx: 14,
  labelCharPx: 7,
  labelPadPx: 12,
  labelMaxCount: 60,
};

// ---------------------------------------------------------------------------
// Pure helpers (DOM-free; unit-tested directly in tests/overlay_layer.test.ts)
// ---------------------------------------------------------------------------

/** `screen = worldToScreen(world, camera)` — the inverse of cells.ts `screenToWorld`
 *  (`world = center + (screen − viewport/2)·zoom`), so `screen = (world − center)/zoom +
 *  viewport/2`. 4 multiply-adds, evaluated in float64 JS (the memo §2 reason DOM text is
 *  immune to the deep-zoom float32 jitter). Returns CSS px relative to the canvas/holder
 *  top-left (the canvas fills the position:relative `.canvas-holder`). Pure + exported. */
export function worldToScreen(
  state: CameraState,
  viewport: Viewport,
  worldX: number,
  worldY: number,
): [number, number] {
  const zoom = state.zoom > 0 ? state.zoom : 1;
  return [
    (worldX - state.center[0]) / zoom + viewport.width / 2,
    (worldY - state.center[1]) / zoom + viewport.height / 2,
  ];
}

/** The web-map tile (tx, ty) at level z for a cell centre over the layout bbox — a faithful
 *  transcription of the producer's `tiler._tile_xy` (packages/pipeline/pipeline/tiler.py
 *  :197-209): 2^z tiles/axis, a degenerate (zero-span) axis maps every cell to 0.
 *
 *  APPROXIMATE, not exact (PR #179 adversarial verification, ground-truthed): the tiler
 *  binned against the full-float64 layout bbox, but the manifest rounds bbox to 6 decimals
 *  (manifest.py `round(v, 6)`) — so cells hugging a tile boundary can attribute to the
 *  adjacent tile vs the bake. Measured on real trees: rijks scatter 17,403 re-derived vs
 *  17,405 baked (23 boundary tiles off by up to ±14, ≈5% worst-tile); inat10k 980 vs 979.
 *  Every counted cell is real (positions_ref holds all cells) — only boundary ATTRIBUTION
 *  drifts. Becomes EXACT when binned over the v2.5 `bbox_exact` (the unrounded bbox the tiler
 *  used); the chip derivation passes it when present, falling back to the rounded `bbox` for a
 *  pre-2.5 bake (see rebuild). Pure + exported. */
export function tileXY(
  cx: number,
  cy: number,
  bbox: readonly [number, number, number, number],
  z: number,
): [number, number] {
  const [x0, y0, x1, y1] = bbox;
  const nAxis = 2 ** z;
  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const fx = spanX > 0 ? (cx - x0) / spanX : 0;
  const fy = spanY > 0 ? (cy - y0) / spanY : 0;
  const tx = Math.min(nAxis - 1, Math.max(0, Math.floor(fx * nAxis)));
  const ty = Math.min(nAxis - 1, Math.max(0, Math.floor(fy * nAxis)));
  return [tx, ty];
}

/** One over-cap PILE: a finest-tier tile whose true occupancy exceeds the mini-atlas packing
 *  cap. `anchor` = the LOWEST-ID member's centre (the tiler keeps the lowest-id `cap` cells;
 *  the lowest-id kept cell is the "representative"). `count` = TRUE occupancy (all members,
 *  incl. the ones the tiler subsampled out — they remain in positions_ref). `dropped` =
 *  count − cap (== the tile's baked `subsampled.dropped`); `shown` = cap. */
export interface Hotspot {
  x: number;
  y: number;
  count: number;
  dropped: number;
  shown: number;
}

/** An INCREMENTAL pile scan over a position table — the chunkable form of deriveHotspots.
 *  `step(budget)` advances by up to `budget` cells and returns true once the scan is
 *  complete; `result()` is valid only then. The factory drives this in ~10 ms rAF slices so
 *  a 1M-cell table never blocks the layout switch (measured ~230–310 ms as one synchronous
 *  pass — exactly the freeze the instant-swap rework removed); node tests and the no-rAF
 *  path run it to completion in one step(Infinity). Pure + exported. */
export interface HotspotScan {
  step(budget: number): boolean;
  result(): Hotspot[];
}

export function createHotspotScan(
  positions: PositionTable,
  bbox: readonly [number, number, number, number],
  z: number,
  cap: number,
): HotspotScan {
  const n = positions.count;
  const degenerate = n === 0 || cap <= 0 || z < 0;
  const nAxis = 2 ** z;
  const { x, y } = positions;
  // tile key = ty*nAxis + tx (a JS number; safe well past the MAX_PYRAMID_Z grid). The
  // first cell seen in a tile is the lowest id (positions are dense-id ordered), so its
  // centre is the representative anchor.
  const byTile = new Map<number, { count: number; ax: number; ay: number }>();
  let cursor = 0;
  let out: Hotspot[] | null = null;
  return {
    step(budget: number): boolean {
      if (degenerate) {
        out = [];
        return true;
      }
      const end = Math.min(n, cursor + Math.max(1, budget));
      for (let i = cursor; i < end; i++) {
        const [tx, ty] = tileXY(x[i], y[i], bbox, z);
        const key = ty * nAxis + tx;
        const e = byTile.get(key);
        if (e === undefined) byTile.set(key, { count: 1, ax: x[i], ay: y[i] });
        else e.count += 1;
      }
      cursor = end;
      if (cursor < n) return false;
      if (out === null) {
        out = [];
        for (const e of byTile.values()) {
          if (e.count > cap) out.push({ x: e.ax, y: e.ay, count: e.count, dropped: e.count - cap, shown: cap });
        }
      }
      return true;
    },
    result(): Hotspot[] {
      return out ?? [];
    },
  };
}

/** Re-derive the pile hotspots for a layout by replicating the tiler's finest-tier binning
 *  over the client-resident position table: bin every cell CENTRE into a 2^z tile over the
 *  bbox (z == pyramid.z_cap == z_max, tiler.py:1003), then a tile with `count > cap` is a
 *  hotspot (`_group_fine_tiles` keeps the lowest-id `cap` and drops the surplus). Because the
 *  full positions_ref carries EVERY cell (including the dropped ids), the bin count is the
 *  honest occupancy — nothing new is computed to tell the truth. O(n) once per layout (not
 *  per frame) — and the factory runs it CHUNKED (createHotspotScan) so the pass never blocks
 *  a switch. This one-shot form is the pure spec surface the tests diff against the tiler.
 *  Pure + exported. */
export function deriveHotspots(
  positions: PositionTable,
  bbox: readonly [number, number, number, number],
  z: number,
  cap: number,
): Hotspot[] {
  const scan = createHotspotScan(positions, bbox, z, cap);
  scan.step(Infinity);
  return scan.result();
}

/** A hotspot projected to the live screen (CSS px). */
export interface PlacedChip extends Hotspot {
  screenX: number;
  screenY: number;
}

/** Greedy screen-space priority cull for chips: project every in-view hotspot, then keep the
 *  biggest-count chips whose screen position is ≥ `minGapPx` from every already-kept chip
 *  (a candidate closer is absorbed by the bigger nearby pile). O(kept²) over the survivors —
 *  kept is bounded by `maxCount`, and this only runs on the coalesced camera event. This is
 *  the same declutter a Seam-2 labels consumer will reuse with `priority` as the rank. Pure +
 *  exported. */
export function declutterChips(chips: PlacedChip[], minGapPx: number, maxCount: number): PlacedChip[] {
  const ranked = [...chips].sort((a, b) => b.count - a.count);
  const kept: PlacedChip[] = [];
  const gap2 = minGapPx * minGapPx;
  for (const c of ranked) {
    if (kept.length >= maxCount) break;
    let clear = true;
    for (const k of kept) {
      const dx = c.screenX - k.screenX;
      const dy = c.screenY - k.screenY;
      if (dx * dx + dy * dy < gap2) {
        clear = false;
        break;
      }
    }
    if (clear) kept.push(c);
  }
  return kept;
}

/** A short human count: 999 → "999", 1500 → "1.5k", 12345 → "12k", 1500000 → "1.5M" (the
 *  chip stays a small mark, not a long number). Pure + exported. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// ---------------------------------------------------------------------------
// Categorical band labels (pure helpers; DOM-free, unit-tested directly)
// ---------------------------------------------------------------------------

/** The image-free GAP SLOT for a band label: the band extent's TOP-GUTTER strip, world
 *  [x0, y0, x1, y0 + gapFrac·(y1−y0)]. The categorical treemap insets each band's images by
 *  (1 − _REGION_FILL)/2 inside the region edge, so with gapFrac ≤ that inset this strip
 *  carries NO image of the band, AND it lies within the band's OWN extent (so no other
 *  band's image either) — a label placed inside it is provably never over any image (the
 *  ratified placement rule). world-y increases DOWNWARD on screen (worldToScreen), so the
 *  slot sits just ABOVE the band's images, unambiguously associated with it. Pure. */
export function labelGapSlot(
  extent: readonly [number, number, number, number],
  gapFrac: number,
): [number, number, number, number] {
  const [x0, y0, x1, y1] = extent;
  return [x0, y0, x1, y0 + gapFrac * (y1 - y0)];
}

/** A band label projected + gap-fitted to the live screen — its display text, its slot-
 *  centred screen box, and the count/missing it carries for ranking + styling. */
export interface LabelCandidate {
  text: string; // the DISPLAY text (names-only, or "name (count)" when the toggle is on)
  count: number; // member count — the declutter rank (== band area for the treemap)
  missing: boolean; // the structurally-missing bucket → muted styling
  screenX: number; // gap-slot centre x (CSS px)
  screenTop: number; // gap-slot top edge y (CSS px)
  boxLeft: number;
  boxRight: number;
  boxTop: number;
  boxBottom: number;
}

/** Greedy screen-space declutter for band labels: keep the biggest-count labels whose
 *  screen BOX does not overlap an already-kept label's box (text must not collide), ranked
 *  by count desc (area == count for the treemap, so this is the area rank the premise §A.3
 *  specifies). The labels analogue of declutterChips (which uses centre-distance for point
 *  chips; a text label needs box-overlap). O(kept·n), bounded by maxCount, run only on the
 *  coalesced camera event. Pure + exported. */
export function declutterLabels(candidates: LabelCandidate[], maxCount: number): LabelCandidate[] {
  const ranked = [...candidates].sort((a, b) => b.count - a.count);
  const kept: LabelCandidate[] = [];
  for (const c of ranked) {
    if (kept.length >= maxCount) break;
    let clear = true;
    for (const k of kept) {
      if (
        c.boxLeft < k.boxRight &&
        c.boxRight > k.boxLeft &&
        c.boxTop < k.boxBottom &&
        c.boxBottom > k.boxTop
      ) {
        clear = false;
        break;
      }
    }
    if (clear) kept.push(c);
  }
  return kept;
}

/** SINGLE SOURCE for the band-label font metrics (PR-180 review: the measurer's font, the
 *  rendered font, and labelHeightPx were three unpinned literals — the only guard on the
 *  never-over-images rule; drifting any one silently broke the width/height gate). The
 *  rendered CSS font and the canvas measure font both derive from these; a test pins
 *  labelHeightPx >= the line box they imply. Exported for that pin test. */
export const LABEL_FONT_SIZE_PX = 11;
export const LABEL_FONT_LINE_HEIGHT = 1.27;
export const LABEL_FONT_LETTER_SPACING_EM = 0.01;
/** The rendered label font (ensureLabel). */
const LABEL_FONT_CSS = `600 ${LABEL_FONT_SIZE_PX}px/${LABEL_FONT_LINE_HEIGHT} system-ui,sans-serif`;
/** The measure font — same face/size WITHOUT line-height (the canvas font shorthand
 *  rejects a line-height component and would silently keep its default font). */
const LABEL_MEASURE_FONT = `600 ${LABEL_FONT_SIZE_PX}px system-ui, sans-serif`;
/** Bound on the measurer's raw-width cache: label sets accumulate across layout switches
 *  (≤ 2 texts × ≤500 labels × layouts), so cap and clear rather than grow forever. */
const LABEL_MEASURE_CACHE_MAX = 2000;

/** A cached label-width measurer for the reveal gate. Prefers a shared 2D-canvas
 *  `measureText` with the label's ACTUAL font — true width, correct for CJK / full-width
 *  glyphs the Latin `length·charPx` estimate under-counts (a wide label would otherwise spill
 *  ~1-2px past its band edge near the reveal threshold, R2). The canvas cannot apply the
 *  rendered letter-spacing, so its cost (letterSpacingEm·fontSize per glyph) is added
 *  explicitly — the gate measures what the DOM will actually draw. Falls back to the char
 *  estimate only when a 2D canvas is unavailable (jsdom / SSR).
 *
 *  Cache discipline (PR-180 review): only the RAW glyph width is cached (font-dependent,
 *  config-free); `labelPadPx` is added LIVE per call so the runtime-mutable config stays
 *  live (the T2-101 scaffolding contract — the old cache baked the pad in). The cache is
 *  bounded (LABEL_MEASURE_CACHE_MAX). Injectable via OverlayLayerDeps.measureText for
 *  unit tests. */
function createLabelMeasurer(config: OverlayLayerConfig): (text: string) => number {
  const cache = new Map<string, number>(); // text -> RAW width incl. letter-spacing (no pad)
  let ctx: CanvasRenderingContext2D | null | undefined; // undefined = not yet resolved
  return (text: string): number => {
    if (ctx === undefined) {
      ctx = null;
      try {
        const measured = document.createElement("canvas").getContext("2d");
        if (measured !== null) {
          measured.font = LABEL_MEASURE_FONT;
          ctx = measured;
        }
      } catch {
        ctx = null; // no DOM / canvas (SSR / jsdom) — use the char estimate
      }
    }
    if (ctx === null) {
      // The estimate is config-dependent and cheap — computed fresh, never cached.
      return text.length * config.labelCharPx + config.labelPadPx;
    }
    let raw = cache.get(text);
    if (raw === undefined) {
      raw = Math.ceil(
        ctx.measureText(text).width + text.length * LABEL_FONT_LETTER_SPACING_EM * LABEL_FONT_SIZE_PX,
      );
      if (cache.size >= LABEL_MEASURE_CACHE_MAX) cache.clear();
      cache.set(text, raw);
    }
    return raw + config.labelPadPx;
  };
}

// ---------------------------------------------------------------------------
// Datetime axis (pure helpers)
// ---------------------------------------------------------------------------

/** The dense ids at the two x-EXTREMES of a position table — `k` smallest-x and `k`
 *  largest-x — the cells to fetch dates for when deriving the datetime domain (the datetime
 *  layout maps time→x linearly, so the extreme-x cells carry t_min / t_max; unknown-date
 *  cells sit at x≈0.5, never an extreme). A bounded O(n·k) scan (no full sort). Pure +
 *  exported. */
export function pickDomainSampleIds(positions: PositionTable, k: number): number[] {
  const n = positions.count;
  const kk = Math.max(1, Math.min(k, n));
  if (n === 0) return [];
  const { x } = positions;
  // Two small bounded-insertion buffers: the kk lowest-x ids and the kk highest-x ids.
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = 0; i < n; i++) {
    insertBounded(lows, i, x, kk, true);
    insertBounded(highs, i, x, kk, false);
  }
  const ids = new Set<number>([...lows, ...highs]);
  return [...ids];
}

/** Insert id `i` into a size-`kk` buffer kept sorted by x (ascending for `low`, i.e. holding
 *  the smallest; descending-worst for high, holding the largest). Internal to
 *  pickDomainSampleIds. */
function insertBounded(buf: number[], i: number, x: Float32Array, kk: number, low: boolean): void {
  const xi = x[i];
  if (buf.length < kk) {
    buf.push(i);
    buf.sort((a, b) => x[a] - x[b]);
    return;
  }
  // buf is ascending by x. For lows we evict the LARGEST (last) if xi is smaller; for highs
  // we evict the SMALLEST (first) if xi is larger.
  if (low) {
    if (xi < x[buf[buf.length - 1]]) {
      buf[buf.length - 1] = i;
      buf.sort((a, b) => x[a] - x[b]);
    }
  } else if (xi > x[buf[0]]) {
    buf[0] = i;
    buf.sort((a, b) => x[a] - x[b]);
  }
}

/** A linear time↔world-x mapping: `t(ms) = slope·x + intercept`, invertible to place a tick
 *  at time t (`x = (t − intercept)/slope`). */
export interface TimeDomain {
  slope: number;
  intercept: number;
}

/** Least-squares fit of `t = slope·x + intercept` over (x, t) sample points — robust to a
 *  single odd endpoint because it averages the extreme-x clusters. Returns null when the
 *  points are degenerate (< 2, all-same x, or all-same t ⇒ no derivable domain). Pure +
 *  exported. */
export function fitTimeDomain(points: { x: number; t: number }[]): TimeDomain | null {
  const m = points.length;
  if (m < 2) return null;
  let sx = 0;
  let st = 0;
  let sxx = 0;
  let sxt = 0;
  for (const p of points) {
    sx += p.x;
    st += p.t;
    sxx += p.x * p.x;
    sxt += p.x * p.t;
  }
  const denom = m * sxx - sx * sx;
  if (denom === 0) return null; // all-same x
  const slope = (m * sxt - sx * st) / denom;
  if (slope === 0 || !Number.isFinite(slope)) return null; // all-same t / degenerate
  const intercept = (st - slope * sx) / m;
  if (!Number.isFinite(intercept)) return null;
  return { slope, intercept };
}

/** Convert a v2.5 PRODUCER axis annotation ({domain:[isoStart,isoEnd], range:[xLo,xHi]})
 *  into the same linear `t(ms) = slope·x + intercept` TimeDomain the shim's fit produces,
 *  so the tick RENDER path is unchanged. `domain` maps linearly onto `range`: t_start→xLo,
 *  t_end→xHi. Returns null on a degenerate/unparseable axis (bad ISO, zero span) — the
 *  caller then falls back to the getMetadata shim. This is the SHIM REPLACEMENT: exact,
 *  synchronous, no network, decoupled from the plugin's margin math (the shim's flagged
 *  coupling). Pure + exported. */
export function axisDomainToTimeDomain(axis: AxisAnnotation): TimeDomain | null {
  const tStart = Date.parse(axis.domain[0]);
  const tEnd = Date.parse(axis.domain[1]);
  const xLo = axis.range[0];
  const xHi = axis.range[1];
  if (!Number.isFinite(tStart) || !Number.isFinite(tEnd)) return null;
  if (!Number.isFinite(xLo) || !Number.isFinite(xHi) || xHi === xLo) return null;
  const slope = (tEnd - tStart) / (xHi - xLo);
  if (slope === 0 || !Number.isFinite(slope)) return null; // all-same t / degenerate
  const intercept = tStart - slope * xLo;
  if (!Number.isFinite(intercept)) return null;
  return { slope, intercept };
}

/** The FIRST x-oriented time-scaled axis in a layout's v2.5 annotations that converts to a
 *  usable TimeDomain, or null when the layout carries no such axis (pre-2.5 ⇒ the caller may
 *  use the getMetadata shim; the explicit `axes: []` declined marker ⇒ it must not). BOTH
 *  filters matter (PR-180 review): the schema legalizes `orientation: "y"` and a future
 *  minor may add scales — this renderer draws only the x time axis, and an unrecognized
 *  axis is SKIPPED, never an error (the reader-tolerance rule). The AXIS rather than just its
 *  domain, because the v2.7 `interval` rides on it (D-36 H4). Pure + exported. */
export function producerTimeAxis(entry: LayoutEntry): AxisAnnotation | null {
  const axes = entry.annotations?.axes;
  if (axes === undefined) return null;
  for (const axis of axes) {
    if (axis.scale === "time" && axis.orientation === "x") {
      if (axisDomainToTimeDomain(axis) !== null) return axis;
    }
  }
  return null;
}

/** The world-x for a time on a domain (the inverse of the linear fit). Pure + exported. */
export function domainToX(domain: TimeDomain, t: number): number {
  return (t - domain.intercept) / domain.slope;
}

/** One rendered axis tick: an epoch, its calendar year, and the label. `label` reads at the
 *  resolution of the rung the PRODUCER binned at (`2020`, `2021-03`, `2021-03-14 09:35`) —
 *  see `rungLabel`. On the pre-2.7 fallback path it is always the year. */
export interface TimeTick {
  t: number;
  year: number;
  label: string;
}

const NICE_YEAR_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/** The ECMA-262 `Date` window. Past ±8.64e15 ms `new Date(t)` is Invalid and every derived
 *  calendar field is NaN, which yields ZERO ticks — a blank axis, not a wrong one. See
 *  `niceTimeTicks` for how that became reachable (D-36 H1 unbounded the domain→range slope).
 *  Both tick generators clamp through this, so neither can construct an out-of-window Date. */
const MAX_TIME_MS = 8.64e15;

/** The visible span clamped into the `Date` window, ordered, or null when nothing drawable
 *  remains (degenerate, or wholly outside on one side). Clamped on BOTH sides, not just the
 *  one each end can exceed today: a domain lying ENTIRELY past +MAX (pan far enough at
 *  extreme zoom-out) would otherwise leave `lo` unclamped — `Math.max(-MAX, 1e16)` is 1e16 —
 *  and the next use of `lo` added above the emptiness guard would silently inherit it into
 *  `new Date()`. Which is the bug this exists to prevent. */
function clampedSpan(tMin: number, tMax: number): [number, number] | null {
  const clamp = (t: number): number => Math.max(-MAX_TIME_MS, Math.min(MAX_TIME_MS, t));
  const lo = clamp(Math.min(tMin, tMax));
  const hi = clamp(Math.max(tMin, tMax));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  return [lo, hi];
}

/** From `candidates`, the value whose `measure` sits closest to `target` MULTIPLICATIVELY
 *  (ratio, not difference) — the shared "nice step" policy of `niceTimeTicks`'s year step and
 *  `intervalTimeTicks`'s bin stride. `measure` maps a candidate to the quantity compared
 *  against `target` (identity by default). Ties keep the earliest candidate. Pure. */
function chooseClosestRatio(
  candidates: number[],
  target: number,
  measure: (candidate: number) => number = (candidate) => candidate,
): number {
  let best = candidates[0];
  let bestRatio = Infinity;
  for (const candidate of candidates) {
    const value = measure(candidate);
    const ratio = value >= target ? value / target : target / value;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

/** d3-style nice YEAR/ERA ticks across a millisecond range: pick the year step from a
 *  1·2·5-decade ladder (up to millennia) whose resulting tick count is closest (in ratio) to
 *  `target`, then emit ticks on that year boundary (Jan 1 UTC). ~8–10 ticks at any zoom for
 *  the premise spans (rijks 1100–2020 → centuries: 1100,1200,…,2000; inat 1934–2019 →
 *  decades), and no cardinality wall as you zoom. Pure + exported. */
export function niceTimeTicks(tMin: number, tMax: number, target: number): TimeTick[] {
  // Clamp to the ECMA-262 Date range BEFORE constructing one. Past +-8.64e15 ms
  // `new Date(t)` is Invalid and `getUTCFullYear()` is NaN, which poisons `span`, `ideal`
  // and `first` and returns ZERO ticks — a completely blank axis, not a wrong one. The
  // `Number.isFinite` guard inside `clampedSpan` does not catch it: 1.2e16 is perfectly
  // finite, it is the Date constructor that clips. Reachable since D-36 H1 made the
  // domain->range slope unbounded (`range` span is min(0.92, intervals/deepest-stack), so a
  // WIDE domain over a DEEP stack blows it up): measured 1.17e16 at the fit camera for 200k
  // images dated 2020 plus one dated year 1 — a single corrupt or placeholder EXIF date.
  // Pre-H1 unreachable, because a 0.92-wide range needed a ~279,000-year domain and calendar
  // years stop at 9999. Showing the ticks that ARE representable beats showing none.
  const span01 = clampedSpan(tMin, tMax);
  if (span01 === null) return [];
  const [lo, hi] = span01;
  const yLo = new Date(lo).getUTCFullYear();
  const yHi = new Date(hi).getUTCFullYear();
  const span = Math.max(1, yHi - yLo);
  const ideal = span / Math.max(1, target);
  // The nice step nearest `ideal` multiplicatively (so 920 y / 9 ≈ 102 → 100-year centuries,
  // not 200; 85 y / 9 ≈ 9.4 → 10-year decades).
  const step = chooseClosestRatio(NICE_YEAR_STEPS, ideal);
  const first = Math.ceil(yLo / step) * step;
  const ticks: TimeTick[] = [];
  for (let y = first; y <= yHi; y += step) {
    ticks.push({ t: utcEpoch(y, 0, 1, 0, 0, 0), year: y, label: String(y) });
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Tick LOCK-STEP with the producer's bins (v2.7 `axes[].interval`; D-36 seam H4)
//
// The defect this replaces: the plugin owns a 25-rung ladder across six kinds and this
// module owned NICE_YEAR_STEPS — years only. T2-138's "every bin lands on its own tick"
// guarantee therefore only BIT where the two lists happened to coincide, so a month- or
// day-binned dataset drew a correct-but-unlabelled axis, and nothing would have caught a
// divergence. H3 made the producer SAY which rung it binned at; the rule below is that
// every drawn tick is one of the producer's OWN bin boundaries, so the two cannot diverge
// at all rather than being kept in step by discipline.
//
// A DENSE axis is thinned by drawing every n-th bin boundary — never by switching to a
// second ladder of instants, which is exactly the drift being removed. `n` is the ONLY
// choice made here, and every value of it keeps every tick on a real bin edge.
// ---------------------------------------------------------------------------

const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

/** A UTC epoch from literal calendar parts. `setUTCFullYear`-first, NOT `Date.UTC(y, …)`:
 *  that constructor applies the JS legacy two-digit remap (years 0–99 → 1900–1999), so a
 *  1st-century dataset (years 20–80 CE) would land at 1920–1980 — off the layout, culled, the
 *  axis silently blank. `setUTCFullYear` takes the year literally. `month0` and the rest may
 *  be out of range and normalize, which is what makes month arithmetic a one-liner. Pure. */
function utcEpoch(y: number, month0: number, day: number, h: number, min: number, s: number): number {
  const d = new Date(0);
  d.setUTCFullYear(y, month0, day);
  d.setUTCHours(h, min, s, 0);
  return d.getTime();
}

/** Whether the producer's flooring for `(kind, step)` really produces a UNIFORM grid — the
 *  precondition for indexing bins arithmetically below.
 *
 *  `_floor_interval` floors year/month on a GLOBAL count (years since 0, months since 0), so
 *  those are uniform at any step. The sub-day arms are NESTED — `hour - hour % step` inside
 *  the day, `minute - minute % step` inside the hour, `second - second % step` inside the
 *  minute — so the last bucket of each cycle is SHORT unless the step divides the cycle. And
 *  the `day` arm takes `datetime(y, m, d)`, which IGNORES `step` entirely: only `("day", 1)`
 *  means what it says. Every rung on today's ladder passes (second/minute 1·5·15·30 | 60,
 *  hour 1·3·6·12 | 24, day 1, month 1·3, year 1…1000); a future rung that did not would
 *  otherwise be silently mis-ticked, so it degrades to the pre-2.7 ladder instead. */
function rungIsUniform(kind: string, step: number): boolean {
  if (!Number.isInteger(step) || step < 1) return false;
  if (kind === "year" || kind === "month") return true;
  if (kind === "day") return step === 1;
  if (kind === "hour") return 24 % step === 0;
  if (kind === "minute" || kind === "second") return 60 % step === 0;
  return false; // an unknown kind from a later minor — degrade like an ABSENT interval
}

/** The GLOBAL index of the bin containing `t` on the `(kind, step)` grid — the transcription
 *  of `_floor_interval`, expressed as a count so a stride can be anchored to it. Requires
 *  `rungIsUniform`. Index 0 is the bin containing the anchor the producer floors to (year 0 /
 *  month 1 / the epoch's midnight), so the kept-tick set does not shift as the camera pans. */
function rungIndex(t: number, kind: string, step: number): number {
  const d = new Date(t);
  if (kind === "year") return Math.floor(d.getUTCFullYear() / step);
  if (kind === "month") return Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / step);
  if (kind === "day") return Math.floor(t / MS_DAY);
  const unit = kind === "hour" ? MS_HOUR : kind === "minute" ? MS_MINUTE : MS_SECOND;
  return Math.floor(t / (step * unit));
}

/** The START INSTANT of bin `index` — the exact value `_floor_interval` returns for any date
 *  inside it, including its `max(1, ...)` year clamp (a multi-year rung's bin 0 spans years
 *  1..step-1 and starts at year 1, OFF the step grid; the interface catalogue flags it). */
function rungStart(index: number, kind: string, step: number): number {
  if (kind === "year") return utcEpoch(Math.max(1, index * step), 0, 1, 0, 0, 0);
  if (kind === "month") {
    const tm = index * step;
    const y = Math.floor(tm / 12);
    return utcEpoch(y, tm - y * 12, 1, 0, 0, 0);
  }
  if (kind === "day") return index * MS_DAY;
  const unit = kind === "hour" ? MS_HOUR : kind === "minute" ? MS_MINUTE : MS_SECOND;
  return index * step * unit;
}

/** The tick LABEL for an instant, at the resolution of the rung the producer binned at — the
 *  tick's own resolution, not the stride's, so a label always states the bin boundary it
 *  marks rather than a rounded version of it.
 *
 *  FORMAT: the ISO-8601 calendar prefix down to that resolution (`2020`, `2021-03`,
 *  `2021-03-14`, `2021-03-14 09:00`, `... 09:35`, `... 09:35:20`). Chosen because it is
 *  (a) LOCALE-INDEPENDENT — this is a data axis, and "Mar" / "14/03" / "3/14" are prose that
 *  reads differently per reader; (b) UNAMBIGUOUS at every rung, since each format is a strict
 *  prefix of the next and the field order never changes; and (c) REVERSIBLE — the shared tick
 *  vector's python half parses each label back to the instant it labels and compares against
 *  the producer's own `_floor_interval`, which a decorative format could not support. The
 *  date/time separator is a space rather than `T`: still ISO-legal, and easier to read at
 *  10 px. The YEAR rung keeps the bare `String(y)` the pre-2.7 path emits (so a year-binned
 *  dataset's axis is untouched by this seam); the sub-year formats zero-pad the year to four
 *  digits, without which a 1st-century dataset would render `20-03-14` — ambiguous with a
 *  two-digit-year convention, and unparseable. */
function rungLabel(t: number, kind: string): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  if (kind === "year") return String(y);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const date = `${y < 0 ? "-" : ""}${String(Math.abs(y)).padStart(4, "0")}-${p2(d.getUTCMonth() + 1)}`;
  if (kind === "month") return date;
  const day = `${date}-${p2(d.getUTCDate())}`;
  if (kind === "day") return day;
  const hm = `${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  if (kind === "hour" || kind === "minute") return hm;
  return `${hm}:${p2(d.getUTCSeconds())}`;
}

/** The 1·2·5 mantissas — the standard decimal axis ladder, already the shape of
 *  `NICE_YEAR_STEPS`. Used only to COARSEN a stride, never to choose an instant. */
const DECADE_MANTISSAS = [1, 2, 5];

/** How many of a rung's unit make up the next calendar unit: 60 s in a minute, 60 min in an
 *  hour, 24 h in a day, 12 months in a year. Calendar facts, not preferences. `day` and
 *  `year` have none — month lengths vary, and a year has no coarser calendar unit — so they
 *  coarsen on the plain decade ladder. Note this map only shapes WHICH bin boundaries are
 *  drawn; a tick is a real bin boundary at every entry, so nothing here can put a tick off a
 *  bin edge (that is the structural difference from the second ladder H4 removes). */
const RUNG_CYCLE: Record<string, number> = { second: 60, minute: 60, hour: 24, month: 12 };

/** Candidate tick SPACINGS for a `(kind, step)` rung, in units of `kind`. Every candidate is
 *  a whole multiple of `step`, so drawing at any of them is still "every n-th bin boundary".
 *
 *  For a kind with a cycle these are the divisors of that cycle (a month rung thins to
 *  quarters, an hour rung to 3-/6-/12-hourly) and then the decade ladder ON the cycle (a
 *  year, 2 years, 5 years, …), which keeps every spacing a round count of a real calendar
 *  unit rather than, say, every 25 seconds. Divisibility by `step` is free there:
 *  `rungIsUniform` has already established `step | cycle` for those kinds.
 *
 *  `day` and `year` have no cycle, so they take the decade ladder on the RUNG itself.
 *
 *  The loop is self-bounding: it stops only after a pass whose base spacing already exceeds
 *  the visible span, so the set always contains a spacing that yields exactly one tick —
 *  which is what puts a ceiling on the caller's tick count without a chosen constant. */
function tickSpacings(kind: string, step: number, unitsSpan: number): number[] {
  const out = new Set<number>([step]); // stride 1 — drawing EVERY bin boundary
  const cycle = RUNG_CYCLE[kind];
  if (cycle !== undefined) {
    for (let d = step; d <= cycle; d += step) if (cycle % d === 0) out.add(d);
  }
  const base = cycle ?? step;
  const bounded = Number.isFinite(unitsSpan) && unitsSpan > 0 ? unitsSpan : 1;
  for (let pow = 1; ; pow *= 10) {
    for (const mant of DECADE_MANTISSAS) {
      const m = base * mant * pow;
      if (m % step === 0) out.add(m);
    }
    if (base * pow > bounded) break; // the last pass added a spacing wider than the view
  }
  return [...out].sort((a, b) => a - b);
}

/** Nice ticks at the PRODUCER'S OWN bin boundaries for a v2.7 `interval` rung. Every tick is
 *  an instant `_floor_interval` would return for that `(kind, step)`; a dense axis is thinned
 *  by keeping every n-th one, anchored on the global bin index so panning slides the ticks
 *  instead of reshuffling them.
 *
 *  `n` is picked exactly the way `niceTimeTicks` picks its year step — the candidate whose
 *  resulting tick COUNT is closest to `target` multiplicatively. The loop that materialises
 *  them is bounded without a magic ceiling: `tickSpacings` always contains a spacing wider
 *  than the visible span, whose count is 1 and whose ratio is therefore `target`, so the
 *  winner's count cannot exceed `target²`.
 *
 *  Returns [] for a rung whose grid is not uniform (`rungIsUniform`) — the caller then falls
 *  back to the pre-2.7 ladder. Pure + exported. */
export function intervalTimeTicks(
  tMin: number,
  tMax: number,
  target: number,
  kind: string,
  step: number,
): TimeTick[] {
  if (!rungIsUniform(kind, step)) return [];
  const span = clampedSpan(tMin, tMax);
  if (span === null) return [];
  const [lo, hi] = span;

  // Bin indices of the two edges. `idxLo` is nudged to the first boundary AT OR AFTER `lo`
  // so no tick is emitted left of the view (matching niceTimeTicks's `ceil(yLo/step)*step`).
  let idxLo = rungIndex(lo, kind, step);
  if (rungStart(idxLo, kind, step) < lo) idxLo += 1;
  const idxHi = rungIndex(hi, kind, step);
  if (!Number.isFinite(idxLo) || !Number.isFinite(idxHi) || idxHi < idxLo) return [];

  const goal = Math.max(1, target);
  const spacing = chooseClosestRatio(
    tickSpacings(kind, step, (idxHi - idxLo + 1) * step),
    goal,
    (m) => Math.floor(((idxHi - idxLo) * step) / m) + 1,
  );
  const stride = Math.max(1, Math.round(spacing / step));

  const ticks: TimeTick[] = [];
  let lastT = Number.NaN;
  for (let i = Math.ceil(idxLo / stride) * stride; i <= idxHi; i += stride) {
    const t = rungStart(i, kind, step);
    // Skip a boundary pulled outside the view (the year clamp can push bin 0 past `lo`), and
    // DEDUP repeats: `rungStart`'s `max(1, ...)` year clamp collapses every pre-year-1 index
    // onto year 1, so a view reaching into BCE would otherwise emit that instant several times
    // (stacked DOM ticks). Ticks are monotonic in `i`, so a consecutive-equal check fully dedups.
    if (t < lo || t > hi || t === lastT) continue;
    lastT = t;
    ticks.push({ t, year: new Date(t).getUTCFullYear(), label: rungLabel(t, kind) });
  }
  return ticks;
}

/** The axis's ticks: the producer's own bin boundaries when the v2.7 `interval` is present
 *  and usable, else the pre-2.7 years-only ladder.
 *
 *  GRACEFUL ABSENCE is the contract, not a nicety: every dataset baked before 2.7 — including
 *  whatever is on disk today — has no `interval` and must render exactly the ticks it renders
 *  now. An UNKNOWN `kind` from a later minor degrades the same way (the api-client keeps it
 *  as an open string deliberately): the axis is still fully drawable from `domain`/`range`,
 *  so it falls back rather than going blank. Pure + exported. */
export function axisTimeTicks(
  tMin: number,
  tMax: number,
  target: number,
  interval: AxisInterval | null | undefined,
): TimeTick[] {
  if (interval != null && rungIsUniform(interval.kind, interval.step)) {
    const ticks = intervalTimeTicks(tMin, tMax, target, interval.kind, interval.step);
    // A uniform rung yields bin-boundary ticks — UNLESS the visible window sits entirely
    // inside one bin (no boundary to draw), where `intervalTimeTicks` returns []. Fall back to
    // the years-only ladder there rather than a blank axis (D-36 §7.4: a coarser tick inside a
    // bin is fine — a weekly histogram with monthly gridlines). A wholly-out-of-range view
    // stays [] because `niceTimeTicks` clamps to empty too, so the "never blank" contract holds
    // without re-blanking that case.
    if (ticks.length > 0) return ticks;
  }
  return niceTimeTicks(tMin, tMax, target);
}

// ---------------------------------------------------------------------------
// Context + handle
// ---------------------------------------------------------------------------

/** What the LayoutController pushes on activate / switch / positions-bind: the active
 *  manifest, WHICH layout is active (for its bbox / pyramid / type / roles), and the layout's
 *  position table. null clears everything (a layout switch pushes null FIRST — no stale-layout
 *  chips during the swap window, #167 — then the new context once the table binds). */
export interface OverlayContext {
  manifest: LayoutManifest;
  layoutId: string;
  positions: PositionTable | null;
}

export interface OverlayLayer {
  /** The single runtime-mutable config (T2-101 scaffolding). */
  readonly config: OverlayLayerConfig;
  /** Set the active layout context; null clears the layer. */
  setContext(ctx: OverlayContext | null): void;
  /** Turn the aggregate count chips on/off (the viewer toggle; ON by default). */
  setChipsEnabled(on: boolean): void;
  chipsEnabled(): boolean;
  /** Turn counts-in-label-text on/off ("Rembrandt (247)"); the viewer toggle, OFF by
   *  default (names-only). Only affects categorical band labels. */
  setCountsEnabled(on: boolean): void;
  countsEnabled(): boolean;
  dispose(): void;
  // ---- introspection (tests / debug) ----
  /** Hotspots derived for the active layout — 0 when no finest-tier tile is over cap.
   *  NOTE: any layout TYPE can pile, not just scatter/geo: a skewed categorical column can
   *  cap z_max early (tiler `_cell_size_z_ceiling` keys off the LARGEST cell) and leave
   *  over-cap tiles. Never assume type ⇒ no piles. */
  hotspotCount(): number;
  /** Chip elements currently drawn (after the in-view + declutter cull). */
  chipCount(): number;
  /** Band labels available for the active layout (categorical only; before the cull). */
  labelAnnotationCount(): number;
  /** Band labels currently drawn (after the reveal-gate + declutter cull). */
  labelCount(): number;
  /** Whether a datetime axis is currently rendered (domain derived + a datetime layout). */
  hasAxis(): boolean;
  /** Axis ticks currently drawn. */
  axisTickCount(): number;
}

// ---------------------------------------------------------------------------
// Factory (DOM; the pure helpers above are exercised GL/DOM-free)
// ---------------------------------------------------------------------------

/** Injectable seam for the (async) datetime-domain resolver, so the DOM lifecycle test can
 *  run without a real getMetadata round-trip. Omitted ⇒ the real getMetadata derivation. */
export interface OverlayLayerDeps {
  resolveTimeDomain?: (
    manifest: LayoutManifest,
    entry: LayoutEntry,
    positions: PositionTable,
  ) => Promise<TimeDomain | null>;
  /** Injectable label-width measurer for the reveal gate (R2). Omitted ⇒ the real 2D-canvas
   *  `measureText` (falling back to the char estimate when no canvas is available, e.g. jsdom).
   *  Unit tests inject a wide-glyph (CJK) measurer to prove the gate uses TRUE width. */
  measureText?: (text: string) => number;
}

export function createOverlayLayer(
  world: World,
  client: ApiClient,
  config: OverlayLayerConfig = { ...DEFAULT_OVERLAY_LAYER_CONFIG },
  deps: OverlayLayerDeps = {},
): OverlayLayer {
  const worldH = world as Partial<WorldHandle> & World;
  const hasDom = typeof document !== "undefined";
  const canvasEl = (world.renderer as { domElement?: { parentElement?: HTMLElement | null } }).domElement ?? null;
  const host: HTMLElement | null = hasDom ? (canvasEl?.parentElement ?? null) : null;
  const resolveDomain = deps.resolveTimeDomain ?? defaultResolveTimeDomain(client, config);
  const measureLabel = deps.measureText ?? createLabelMeasurer(config);

  const hasRaf = typeof globalThis.requestAnimationFrame === "function";

  // ---- DOM scaffolding (all absolute children of `.canvas-holder`) ----
  let root: HTMLElement | null = null;
  let chipRoot: HTMLElement | null = null;
  let axisRoot: HTMLElement | null = null;
  let labelRoot: HTMLElement | null = null;
  let toggleTray: HTMLElement | null = null;
  let toggleEl: HTMLElement | null = null;
  let countsToggleEl: HTMLElement | null = null;
  let tooltipEl: HTMLElement | null = null;
  if (host !== null) {
    root = document.createElement("div");
    root.className = "overlay-substrate";
    root.setAttribute("data-testid", "overlay-substrate");
    // inset:0 over the canvas; events fall THROUGH to the canvas (memo §2). NOTHING that
    // tracks the data plane may opt back in: the substrate is a SIBLING of the canvas, so a
    // pointer-events:auto child swallows wheel/drag/click for the canvas underneath (the
    // PR-179 review's dead-zone finding). Only the toggle TRAY's buttons — real controls in
    // the corner gutter — opt in; chip tooltips are handled by a host-level hover hit-test.
    root.style.cssText =
      "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:5;";
    chipRoot = document.createElement("div");
    chipRoot.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    axisRoot = document.createElement("div");
    axisRoot.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    labelRoot = document.createElement("div");
    labelRoot.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    // The toggle tray: a bottom-left flex COLUMN every self-owned control stacks into.
    // One shared anchor point means two visible controls can never overlap (the PR-180
    // review proved a skewed categorical layout CAN have piles and labels at once — the
    // "mutually exclusive" assumption is false; see hotspotCount's doc).
    toggleTray = document.createElement("div");
    toggleTray.className = "overlay-toggle-tray";
    toggleTray.style.cssText =
      "position:absolute;left:12px;bottom:12px;display:flex;flex-direction:column;" +
      "align-items:flex-start;gap:6px;pointer-events:none;";
    root.appendChild(axisRoot);
    root.appendChild(chipRoot);
    root.appendChild(labelRoot); // band labels on top of chips/axis
    root.appendChild(toggleTray);
    host.appendChild(root);
  }

  // ---- retained state ----
  let ctx: OverlayContext | null = null;
  let hotspots: Hotspot[] = [];
  let labels: LabelAnnotation[] = []; // the active categorical layout's band labels (v2.5)
  let timeDomain: TimeDomain | null = null;
  // v2.7 (D-36 H4): the rung the producer binned at, so the ticks are ITS bin boundaries.
  // null on a pre-2.7 bake AND on the getMetadata shim path — both keep the years-only ladder.
  let timeInterval: AxisInterval | null = null;
  let domainToken = 0; // supersede a stale async domain resolve on switch/dispose
  let hotspotToken = 0; // supersede an in-flight chunked hotspot scan on switch/dispose
  let hotspotRafHandle: number | null = null;
  let chipsOn = true;
  let chipsExact = false; // true when the chip binning used the v2.5 full-precision bbox_exact
  let countsOn = false; // counts-in-label-text toggle ("Rembrandt (247)"); OFF by default
  let disposed = false;
  let lastState: CameraState | null = null;
  let lastViewport: Viewport | null = null;

  // DOM element pools (reused across frames — never rebuild the node set per camera event;
  // ensureChip/ensureTick build each node's full subtree ONCE and per-frame writes are
  // style/textContent only).
  const chipPool: HTMLElement[] = [];
  const tickPool: HTMLElement[] = [];
  const labelPool: HTMLElement[] = [];
  let drawnChips = 0;
  let drawnTicks = 0;
  let drawnLabels = 0;
  // The kept, on-screen chips of the LAST render — the hover hit-test set for the tooltip.
  let placedChips: PlacedChip[] = [];
  let lastPointer: [number, number] | null = null; // host-relative CSS px
  let tooltipChip: PlacedChip | null = null; // dirty guard: rewrite only on change

  // ---- rAF-coalesced reposition (the viewerStatus / detailOverlay pattern) ----
  let refreshHandle: number | null = null;
  let refreshScheduled = false;
  function scheduleRefresh(): void {
    if (refreshScheduled || disposed) return;
    refreshScheduled = true;
    const run = (): void => {
      refreshHandle = null;
      refreshScheduled = false;
      reposition();
    };
    if (hasRaf) refreshHandle = globalThis.requestAnimationFrame(run);
    else run(); // node unit tests: synchronous per emit
  }

  // ---- chips ----
  function ensureChip(index: number): HTMLElement {
    let el = chipPool[index];
    if (el === undefined) {
      el = document.createElement("div");
      el.className = "overlay-chip";
      // Unobtrusive: the surface pill with a hairline border — information, not decoration
      // (accent is used SPARINGLY, only for the count text, per the design language). Reads
      // over both the light mosaic and dark ground. pointer-events:NONE — a chip must never
      // swallow the canvas's wheel/drag/click (the PR-179 dead-zone finding: the substrate
      // is a canvas SIBLING, so an auto child eats the gesture); the microcopy tooltip is
      // served by the host-level hover hit-test instead (see updateTooltip).
      el.style.cssText =
        "position:absolute;transform:translate(-50%,-140%);pointer-events:none;" +
        "display:inline-flex;align-items:center;gap:3px;white-space:nowrap;" +
        "padding:1px 6px;border-radius:var(--r-ctrl,6px);font:600 11px/1.4 system-ui,sans-serif;" +
        "background:var(--surface,#171B22);color:var(--text-2,#AEB6C6);" +
        "border:1px solid var(--line,#2A303B);box-shadow:0 1px 4px rgba(0,0,0,0.35);" +
        "user-select:none;";
      // The pill subtree is built ONCE (the pool invariant): per-frame updates write ONLY
      // the count span's textContent — never createElement in the camera path.
      const num = document.createElement("span");
      num.className = "overlay-chip-num";
      num.style.color = "var(--accent,#F0B429)";
      const suffix = document.createElement("span");
      suffix.className = "overlay-chip-suffix";
      suffix.textContent = "here";
      suffix.style.opacity = "0.75";
      el.appendChild(num);
      el.appendChild(suffix);
      chipRoot?.appendChild(el);
      chipPool[index] = el;
    }
    return el;
  }

  function renderChips(state: CameraState, viewport: Viewport): void {
    if (!chipsOn || hotspots.length === 0) {
      hideFrom(chipPool, 0);
      drawnChips = 0;
      placedChips = [];
      updateTooltip();
      return;
    }
    // Project the in-view hotspots, then declutter by count-priority.
    const margin = 24;
    const placed: PlacedChip[] = [];
    for (const hspot of hotspots) {
      const [sx, sy] = worldToScreen(state, viewport, hspot.x, hspot.y);
      if (sx < -margin || sy < -margin || sx > viewport.width + margin || sy > viewport.height + margin) continue;
      placed.push({ ...hspot, screenX: sx, screenY: sy });
    }
    const kept = declutterChips(placed, config.chipMinGapPx, config.chipMaxCount);
    for (let i = 0; i < kept.length; i++) {
      const c = kept[i];
      const el = ensureChip(i);
      el.style.left = `${c.screenX}px`;
      el.style.top = `${c.screenY}px`;
      el.style.display = "inline-flex";
      // The count is EXACT when the layout carries the v2.5 full-precision `bbox_exact`
      // (the client then bins IDENTICALLY to the tiler); otherwise it is APPROXIMATE near
      // tile boundaries — the manifest `bbox` is 6-dp-rounded vs the bake's float64
      // (PR #179, ≈5% worst-tile attribution drift). The ~ is dropped in the exact case;
      // honest either way. Pool invariant: only the count span's textContent is written.
      (el.firstChild as HTMLElement).textContent = chipsExact
        ? formatCount(c.count)
        : `~${formatCount(c.count)}`;
    }
    hideFrom(chipPool, kept.length);
    drawnChips = kept.length;
    placedChips = kept;
    // Chips moved under a resting pointer — re-run the hover hit-test at the last position.
    updateTooltip();
  }

  // ---- chip tooltip (host-level hover hit-test; chips themselves are pointer-inert) ----

  /** Approximate hover target around a drawn chip pill: the pill is anchored at
   *  (screenX, screenY) with translate(-50%,-140%), so its visual centre sits ~17 px above
   *  the anchor. The box half-width (30) can exceed half the chipMinGapPx gap, so two
   *  adjacent chips' hover boxes may overlap — the NEAREST hit wins, so the closer pile is
   *  always the one described. */
  const CHIP_HOVER_HALF_W = 30;
  const CHIP_HOVER_HALF_H = 14;
  const CHIP_PILL_CENTER_DY = -17;

  function hoveredChipAt(px: number, py: number): PlacedChip | null {
    let best: PlacedChip | null = null;
    let bestD2 = Infinity;
    for (const c of placedChips) {
      const cy = c.screenY + CHIP_PILL_CENTER_DY;
      const dx = px - c.screenX;
      const dy = py - cy;
      if (Math.abs(dx) > CHIP_HOVER_HALF_W || Math.abs(dy) > CHIP_HOVER_HALF_H) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best;
  }

  /** The honest microcopy for a pile (the ratified G4b wording): true occupancy + how many
   *  the pyramid actually kept. Exactness-aware: a v2.5 `bbox_exact` bake bins identically
   *  to the tiler, so the ≈ and the approximation caveat are dropped (chipsExact). */
  function chipTooltipText(c: PlacedChip): string {
    return chipsExact
      ? `${c.count.toLocaleString()} images share this area; ${c.shown} shown`
      : `≈${c.count.toLocaleString()} images share this area; ${c.shown} shown (counts are approximate near region edges)`;
  }

  function updateTooltip(): void {
    if (root === null) return;
    const hit = lastPointer !== null && chipsOn ? hoveredChipAt(lastPointer[0], lastPointer[1]) : null;
    if (hit === null) {
      if (tooltipEl !== null && tooltipChip !== null) tooltipEl.style.display = "none";
      tooltipChip = null;
      return;
    }
    if (tooltipEl === null) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "overlay-chip-tooltip";
      tooltipEl.setAttribute("role", "tooltip");
      tooltipEl.style.cssText =
        "position:absolute;transform:translate(-50%,-100%);pointer-events:none;" +
        "max-width:280px;white-space:normal;text-align:center;" +
        "padding:4px 8px;border-radius:var(--r-ctrl,6px);font:500 11px/1.35 system-ui,sans-serif;" +
        "background:var(--surface,#171B22);color:var(--text,#E7EAF0);" +
        "border:1px solid var(--line,#2A303B);box-shadow:0 2px 8px rgba(0,0,0,0.4);z-index:6;";
      root.appendChild(tooltipEl);
    }
    // Dirty guard: identical chip hovered across frames ⇒ position-only writes.
    if (tooltipChip !== hit) {
      tooltipEl.textContent = chipTooltipText(hit);
      tooltipChip = hit;
    }
    tooltipEl.style.left = `${hit.screenX}px`;
    tooltipEl.style.top = `${hit.screenY - 26}px`; // clear of the pill above the anchor
    tooltipEl.style.display = "block";
  }

  function onHostPointerMove(ev: PointerEvent): void {
    if (disposed || host === null) return;
    const rect = host.getBoundingClientRect();
    lastPointer = [ev.clientX - rect.left, ev.clientY - rect.top];
    updateTooltip();
  }

  function onHostPointerLeave(): void {
    lastPointer = null;
    updateTooltip();
  }

  if (host !== null) {
    // Passive OBSERVERS on the holder — they never intercept or cancel the canvas's own
    // gesture handling (the canvas is the event TARGET; these fire on the bubble path).
    host.addEventListener("pointermove", onHostPointerMove, { passive: true });
    host.addEventListener("pointerleave", onHostPointerLeave, { passive: true });
  }

  // ---- band labels (v2.5) ----
  function ensureLabel(index: number): HTMLElement {
    let el = labelPool[index];
    if (el === undefined) {
      el = document.createElement("div");
      el.className = "overlay-band-label";
      // Crisp DOM text (re-rasterized at native DPI — immune to the deep-zoom float32
      // jitter, memo §2). Centred over its gap-slot (translateX -50%), growing DOWN from
      // the slot top. pointer-events:none — a label never eats a pan. A text-shadow keeps
      // it legible over both the mosaic and the ground WITHOUT a background plate that
      // would occlude an image (labels sit in the empty gap, not over images).
      el.style.cssText =
        "position:absolute;transform:translateX(-50%);pointer-events:none;white-space:nowrap;" +
        `font:${LABEL_FONT_CSS};letter-spacing:${LABEL_FONT_LETTER_SPACING_EM}em;` +
        "text-shadow:0 1px 3px rgba(0,0,0,0.65),0 0 2px rgba(0,0,0,0.5);";
      labelRoot?.appendChild(el);
      labelPool[index] = el;
    }
    return el;
  }

  /** The text a band label shows: its value, with the count appended ONLY when the counts
   *  toggle is on ("Rembrandt (247)"); the structurally-missing bucket shows a muted
   *  placeholder ("no label") in place of its empty value — INCLUDING its count when the
   *  toggle is on ("no label (1,893)"): on sparse metadata the missing band is often the
   *  LARGEST group, and hiding exactly its size defeated the toggle's whole point
   *  (PR-180 review). */
  function displayLabelText(label: LabelAnnotation): string {
    const base = label.missing === true ? "no label" : label.text;
    return countsOn ? `${base} (${label.count.toLocaleString()})` : base;
  }

  function renderLabels(state: CameraState, viewport: Viewport): void {
    if (labels.length === 0) {
      hideFrom(labelPool, 0);
      drawnLabels = 0;
      return;
    }
    const candidates: LabelCandidate[] = [];
    for (const label of labels) {
      // CHEAP GATES FIRST (PR-180 review): geometry-only rejections run before the text is
      // built or measured, so an off-screen or too-small band costs a few multiply-adds —
      // never a measureText — per frame.
      const [gx0, gy0, gx1, gy1] = labelGapSlot(label.extent, config.labelGapFrac);
      const [sx0, sTop] = worldToScreen(state, viewport, gx0, gy0);
      const [sx1, sBot] = worldToScreen(state, viewport, gx1, gy1);
      const slotH = sBot - sTop;
      if (slotH < config.labelHeightPx) continue; // zoom-reveal: the band is too small yet
      // The VISIBLE portion of the gap strip (PR-180 review: the old cull dropped the label
      // the moment the band's top edge left the viewport — zooming INTO a band erased its
      // name). The label clamps into the on-screen part of the strip instead; only when NO
      // usable strip remains visible (fully scrolled past, or deep inside the band's image
      // interior) does it hide — the rule-correct behaviour, since everything outside the
      // strip is images.
      const visTop = Math.max(sTop, 0);
      const visBot = Math.min(sBot, viewport.height);
      if (visBot - visTop < config.labelHeightPx) continue;
      if (sx1 < 0 || sx0 > viewport.width) continue; // fully off-screen horizontally
      const text = displayLabelText(label);
      if (text.length === 0) continue; // a real empty value (non-missing) — nothing to draw
      const boxW = measureLabel(text); // R2: TRUE text width (CJK-correct), not a char estimate
      // REVEAL GATE (never-over-images + zoom-reveal): show the label ONLY when it fits
      // INSIDE the image-free gap slot — the FULL slot's screen width >= the text width
      // (a small band stays unlabeled until zoom makes its gap big enough)...
      const slotW = sx1 - sx0;
      if (slotW < boxW) continue;
      // ...AND enough of the slot is actually on screen to hold the box.
      const visLeft = Math.max(sx0, 0);
      const visRight = Math.min(sx1, viewport.width);
      if (visRight - visLeft < boxW) continue;
      // Clamp the label into the visible sub-strip. Still inside the image-free slot by
      // construction (vis* are intersections of the slot with the viewport).
      const halfW = boxW / 2;
      const cx = Math.min(Math.max((sx0 + sx1) / 2, visLeft + halfW), visRight - halfW);
      const top = Math.min(Math.max(sTop, visTop), visBot - config.labelHeightPx);
      candidates.push({
        text,
        count: label.count,
        missing: label.missing === true,
        screenX: cx,
        screenTop: top,
        boxLeft: cx - halfW,
        boxRight: cx + halfW,
        boxTop: top,
        boxBottom: top + config.labelHeightPx,
      });
    }
    const kept = declutterLabels(candidates, config.labelMaxCount);
    for (let i = 0; i < kept.length; i++) {
      const c = kept[i];
      const el = ensureLabel(i);
      el.style.left = `${c.screenX}px`;
      el.style.top = `${c.screenTop}px`;
      el.style.display = "block";
      el.textContent = c.text;
      // The structurally-missing bucket reads as a muted, italic "no label" (--muted, the
      // theme's labels/hints grey); a real-valued band reads in bright primary text (--text)
      // — data is king, so real bands are prominent and the missing one recedes. A modifier
      // class makes the two states a clean CSS/test hook alongside the inline color.
      el.classList.toggle("overlay-band-label--missing", c.missing);
      el.style.color = c.missing ? "var(--muted,#838C9E)" : "var(--text,#E7EAF0)";
      el.style.fontStyle = c.missing ? "italic" : "normal";
    }
    hideFrom(labelPool, kept.length);
    drawnLabels = kept.length;
  }

  // ---- datetime axis ----
  function ensureTick(index: number): HTMLElement {
    let el = tickPool[index];
    if (el === undefined) {
      el = document.createElement("div");
      el.className = "overlay-axis-tick";
      // A short bottom-pinned tick + year label (screen-edge gutter — natural in DOM, memo
      // §1). The vertical rule is a faint hairline; the year reads in the secondary text.
      el.style.cssText =
        "position:absolute;bottom:0;transform:translateX(-50%);pointer-events:none;" +
        "display:flex;flex-direction:column;align-items:center;font:500 10px/1.2 system-ui,sans-serif;" +
        "color:var(--text-2,#AEB6C6);";
      const rule = document.createElement("div");
      rule.className = "overlay-axis-rule";
      rule.style.cssText = "width:1px;height:8px;background:var(--line,#2A303B);margin-bottom:2px;";
      const label = document.createElement("div");
      label.className = "overlay-axis-label";
      label.style.cssText =
        "padding:0 4px 3px;background:var(--ground,#0E1116);border-radius:2px;opacity:0.85;";
      el.appendChild(rule);
      el.appendChild(label);
      axisRoot?.appendChild(el);
      tickPool[index] = el;
    }
    return el;
  }

  function renderAxis(state: CameraState, viewport: Viewport): void {
    if (timeDomain === null) {
      hideFrom(tickPool, 0);
      drawnTicks = 0;
      return;
    }
    // Visible world-x sub-range from the two screen edges (screenToWorld at x=0 and x=width),
    // mapped to time, then ticks across it — recomputed per camera event so they re-nice as
    // you zoom (storing the domain, not pre-rendered ticks; memo §4a). Since v2.7 (D-36 H4)
    // those ticks are the PRODUCER's own bin boundaries when it told us the rung; the draw,
    // cull and label placement below are unchanged either way.
    const zoom = state.zoom > 0 ? state.zoom : 1;
    const worldXLeft = state.center[0] + (0 - viewport.width / 2) * zoom;
    const worldXRight = state.center[0] + (viewport.width - viewport.width / 2) * zoom;
    const tLeft = timeDomain.slope * worldXLeft + timeDomain.intercept;
    const tRight = timeDomain.slope * worldXRight + timeDomain.intercept;
    const ticks = axisTimeTicks(tLeft, tRight, config.axisTickTarget, timeInterval);
    let drawn = 0;
    for (const tick of ticks) {
      const wx = domainToX(timeDomain, tick.t);
      const [sx] = worldToScreen(state, viewport, wx, 0);
      if (sx < 0 || sx > viewport.width) continue;
      const el = ensureTick(drawn);
      el.style.left = `${sx}px`;
      el.style.display = "flex";
      const label = el.lastChild as HTMLElement;
      label.textContent = tick.label;
      drawn += 1;
    }
    hideFrom(tickPool, drawn);
    drawnTicks = drawn;
  }

  function hideFrom(pool: HTMLElement[], from: number): void {
    for (let i = from; i < pool.length; i++) pool[i].style.display = "none";
  }

  function reposition(): void {
    // `root === null` ⇒ no DOM host (headless): nothing to draw, and it also keeps
    // renderChips/renderAxis from reaching document.createElement (syncToggle/updateTooltip
    // already self-guard on host/root). In production a real World always carries a canvas.
    if (disposed || root === null || lastState === null || lastViewport === null) return;
    renderAxis(lastState, lastViewport);
    renderChips(lastState, lastViewport);
    renderLabels(lastState, lastViewport);
    syncToggle();
    syncCountsToggle();
  }

  // ---- toggle (self-owned, appears only when the active layout HAS piles) ----
  // Rendered-state dirty guard: syncToggle runs per coalesced camera frame, so the DOM
  // writes must be conditional (a resting camera stream would otherwise rewrite
  // textContent/title 60×/s for nothing).
  let toggleShown = false;
  let toggleOnRendered: boolean | null = null;
  function syncToggle(): void {
    if (host === null || toggleTray === null) return;
    const relevant = hotspots.length > 0;
    if (!relevant) {
      if (toggleEl !== null && toggleShown) {
        toggleEl.style.display = "none";
        toggleShown = false;
      }
      return;
    }
    if (toggleEl === null) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "overlay-chip-toggle";
      // A real control in the bottom-left TRAY (stacked with any sibling toggle — never
      // overlapping; the tray owns the anchor). pointer-events:auto on the button only.
      // The accessible name is stable and glyph-free; the visible glyph is decoration.
      btn.setAttribute("aria-label", "Pile count chips");
      btn.style.cssText =
        "pointer-events:auto;" +
        "padding:4px 10px;border-radius:var(--r-ctrl,6px);font:600 11px/1.4 system-ui,sans-serif;" +
        "border:1px solid var(--line,#2A303B);background:var(--surface,#171B22);cursor:pointer;";
      btn.addEventListener("click", () => setChipsEnabled(!chipsOn));
      toggleTray.appendChild(btn);
      toggleEl = btn;
    }
    if (toggleShown && toggleOnRendered === chipsOn) return; // no state change — no writes
    toggleEl.style.display = "inline-flex";
    toggleEl.style.color = chipsOn ? "var(--accent,#F0B429)" : "var(--text-2,#AEB6C6)";
    toggleEl.textContent = chipsOn ? "◉ Piles" : "○ Piles";
    toggleEl.setAttribute("aria-pressed", String(chipsOn));
    toggleEl.title = chipsOn
      ? "Pile counts on — a chip marks each spot where images overlap. Click to hide."
      : "Pile counts off — click to show where images overlap.";
    toggleShown = true;
    toggleOnRendered = chipsOn;
  }

  function setChipsEnabled(on: boolean): void {
    if (chipsOn === on) return;
    chipsOn = on;
    scheduleRefresh();
  }

  // ---- counts toggle (self-owned, appears only when the active layout HAS band labels) ----
  // Stacks INTO the shared toggle tray with the piles toggle (PR-180 review): the old
  // "mutually exclusive — a categorical layout has labels but no piles" premise is FALSE
  // (a skewed categorical column caps z_max early via the tiler's cell-size ceiling and
  // genuinely piles — proven against the real producer), and both buttons hard-coded the
  // same absolute corner, so Counts painted over Piles and ate its clicks. The tray is a
  // flex column: both visible ⇒ stacked, either alone ⇒ sits at the corner.
  let countsToggleShown = false;
  let countsOnRendered: boolean | null = null;
  function syncCountsToggle(): void {
    if (host === null || toggleTray === null) return;
    const relevant = labels.length > 0;
    if (!relevant) {
      if (countsToggleEl !== null && countsToggleShown) {
        countsToggleEl.style.display = "none";
        countsToggleShown = false;
      }
      return;
    }
    if (countsToggleEl === null) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "overlay-counts-toggle";
      btn.setAttribute("aria-label", "Label counts");
      btn.style.cssText =
        "pointer-events:auto;" +
        "padding:4px 10px;border-radius:var(--r-ctrl,6px);font:600 11px/1.4 system-ui,sans-serif;" +
        "border:1px solid var(--line,#2A303B);background:var(--surface,#171B22);cursor:pointer;";
      btn.addEventListener("click", () => setCountsEnabled(!countsOn));
      toggleTray.appendChild(btn);
      countsToggleEl = btn;
    }
    if (countsToggleShown && countsOnRendered === countsOn) return; // dirty guard — no writes
    countsToggleEl.style.display = "inline-flex";
    countsToggleEl.style.color = countsOn ? "var(--accent,#F0B429)" : "var(--text-2,#AEB6C6)";
    countsToggleEl.textContent = countsOn ? "◉ Counts" : "○ Counts";
    countsToggleEl.setAttribute("aria-pressed", String(countsOn));
    countsToggleEl.title = countsOn
      ? 'Counts on — each label shows its group size, e.g. "Rembrandt (247)". Click to hide.'
      : "Counts off — labels show names only. Click to show each group's size.";
    countsToggleShown = true;
    countsOnRendered = countsOn;
  }

  function setCountsEnabled(on: boolean): void {
    if (countsOn === on) return;
    countsOn = on;
    scheduleRefresh();
  }

  // ---- context / hotspot derivation / domain resolution ----

  /** Cells binned per rAF slice of the chunked hotspot scan — sized so one slice stays
   *  well inside a frame (~10 ms at the measured ~300 ms/1M single-pass rate). */
  const HOTSPOT_SCAN_CHUNK = 32768;

  /** Derive the pile hotspots for the bound positions WITHOUT blocking the switch: a full
   *  synchronous pass costs ~230–310 ms at 1M cells (PR-179 review, measured), which would
   *  re-introduce exactly the freeze the instant layout swap removed. The FIRST slice runs
   *  inline — a table under the chunk size (most datasets) completes synchronously, exactly
   *  the pre-rider behaviour — and only a genuinely large table continues in ~10 ms rAF
   *  slices (its chips appear a few frames after the swap — they are annotation, not the
   *  layout). Without rAF (node tests) it always completes synchronously so introspection
   *  stays deterministic. Token-superseded by the next rebuild/dispose, like the domain
   *  resolve. */
  function startHotspotScan(
    positions: PositionTable,
    bbox: readonly [number, number, number, number],
    z: number,
    cap: number,
  ): void {
    const token = hotspotToken;
    const scan = createHotspotScan(positions, bbox, z, cap);
    if (!hasRaf) {
      scan.step(Infinity);
      hotspots = scan.result();
      return;
    }
    if (scan.step(HOTSPOT_SCAN_CHUNK)) {
      hotspots = scan.result(); // small table — done inline, no deferred frame
      return;
    }
    const slice = (): void => {
      hotspotRafHandle = null;
      if (disposed || token !== hotspotToken) return; // superseded — drop the partial scan
      if (scan.step(HOTSPOT_SCAN_CHUNK)) {
        hotspots = scan.result();
        scheduleRefresh();
      } else {
        hotspotRafHandle = globalThis.requestAnimationFrame(slice);
      }
    };
    hotspotRafHandle = globalThis.requestAnimationFrame(slice);
  }

  function rebuild(): void {
    hotspots = [];
    labels = [];
    chipsExact = false;
    timeDomain = null;
    timeInterval = null;
    domainToken += 1; // cancel any in-flight domain resolve for a superseded context
    hotspotToken += 1; // cancel any in-flight chunked hotspot scan likewise
    const active = ctx;
    if (active === null) {
      // Cleared (a switch pushed null, #167) — drop everything.
      if (lastState !== null && lastViewport !== null) reposition();
      return;
    }
    const entry = active.manifest.layouts.find((l) => l.layout_id === active.layoutId);
    if (entry === undefined) {
      if (lastState !== null && lastViewport !== null) reposition();
      return;
    }
    // Labels FIRST, and independent of the position table (PR-180 review): band labels are
    // pure manifest data, but they were gated behind `positions !== null` — a failed or
    // slow positions_ref fetch silently erased every label. Now a labels-capable context
    // renders them even while (or if) the table never binds; only the CHIPS and the shim
    // (below) genuinely need positions.
    labels = entry.annotations?.labels ?? [];
    if (active.positions !== null) {
      // Chips: over-cap piles re-derived from the position table at the finest tier —
      // chunked off the switch path (see startHotspotScan). Bin over the v2.5
      // FULL-PRECISION `bbox_exact` when present (→ EXACT counts, matching the tiler's
      // bake); a pre-2.5 bake lacks it, so fall back to the 6-dp `bbox` and keep the
      // honest ~ approximation (PR #179 verification). chipsExact drives the microcopy's
      // tilde. SHORT-CIRCUIT (PR-180 review): a v2.5 bake records the bake's total
      // subsample count. The chip scan bins at `z_cap`, which the current tiler always
      // sets EQUAL to z_max (the single fine level; tiler.py `z_cap = z_max`) — so the
      // scan bins at exactly the level `dropped_total` is summed over, and
      // `pyramid.dropped_total === 0` proves the scan would find nothing. The O(n) scan
      // (~300 ms at 1M, wasted even chunked) is then skipped entirely for the common
      // no-pile layout. Absent (pre-2.5) or >0 ⇒ scan as before. CAVEAT: if a future
      // tiler ever emits a hybrid pyramid (z_cap < z_max), revisit this — a z_cap tile can
      // exceed cap while every z_max child stays under it, so `dropped_total` would have
      // to sum every fine level, not just z_max, for the skip to stay sound.
      chipsExact = entry.bbox_exact !== undefined;
      if (entry.pyramid.dropped_total !== 0) {
        startHotspotScan(active.positions, entry.bbox_exact ?? entry.bbox, entry.pyramid.z_cap, entry.pyramid.cap);
      }
    }
    // Axis: datetime layouts only. Prefer the v2.5 PRODUCER domain (annotations.axes) —
    // exact + synchronous, decoupled from the plugin's margin math. The getMetadata shim
    // runs ONLY when `annotations.axes` is ABSENT (a pre-2.5 datetime bake) — the explicit
    // `[]` DECLINED marker suppresses it (PR-180 review: the shim used to resurrect exactly
    // the axis the producer refused, e.g. year-52,000 ticks from the R1 overflow case).
    // Either path feeds the SAME renderAxis tick path. When the shim IS used it is DEFERRED
    // off the synchronous switch path (PR-179 review): the default resolver's first act is an
    // O(n) extreme-id scan of the position table, and an async function runs its prefix
    // synchronously up to the first await, so invoking it inline would block the swap at 1M
    // cells. Defer to a macrotask so the swap paints first; the token/disposed recheck skips
    // a superseded context (and its getMetadata round-trip) entirely.
    if (entry.type === "datetime") {
      const producerAxis = producerTimeAxis(entry);
      const producer = producerAxis === null ? null : axisDomainToTimeDomain(producerAxis);
      if (producer !== null) {
        timeDomain = producer;
        // v2.7 (D-36 H4). ABSENT on a pre-2.7 bake, which is the ONLY thing its absence
        // means — the producer emits it unconditionally with a real axis — so presence is
        // the whole gate and a missing rung is never defaulted. The shim path below cannot
        // have one at all: it derives a domain from sampled dates and knows no bucketing.
        timeInterval = producerAxis?.interval ?? null;
      } else if (
        entry.annotations?.axes === undefined &&
        active.manifest.column_roles?.datetime != null &&
        active.positions !== null
      ) {
        const token = domainToken;
        const positions = active.positions;
        const manifestForDomain = active.manifest;
        const startResolve = (): void => {
          if (disposed || token !== domainToken) return;
          void resolveDomain(manifestForDomain, entry, positions)
            .then((domain) => {
              if (disposed || token !== domainToken) return; // superseded by a switch/dispose
              timeDomain = domain;
              scheduleRefresh();
            })
            .catch((err: unknown) => {
              if (token === domainToken) console.warn("[overlay] datetime domain unavailable; axis hidden", err);
            });
        };
        setTimeout(startResolve, 0);
      }
    }
    if (lastState !== null && lastViewport !== null) reposition();
  }

  // ---- camera subscription ----
  const unsubscribe = world.onCameraChange((state, viewport) => {
    lastState = state;
    lastViewport = viewport;
    scheduleRefresh();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    domainToken += 1;
    hotspotToken += 1;
    unsubscribe();
    if (refreshHandle !== null && hasRaf) globalThis.cancelAnimationFrame(refreshHandle);
    refreshHandle = null;
    if (hotspotRafHandle !== null && hasRaf) globalThis.cancelAnimationFrame(hotspotRafHandle);
    hotspotRafHandle = null;
    if (host !== null) {
      // The host is NOT owned by this layer (it's .canvas-holder) — the hover observers
      // must be removed explicitly (the detailOverlay teardown rule for borrowed nodes).
      host.removeEventListener("pointermove", onHostPointerMove);
      host.removeEventListener("pointerleave", onHostPointerLeave);
    }
    if (root !== null && root.parentElement !== null) root.parentElement.removeChild(root);
    root = null;
    chipRoot = null;
    axisRoot = null;
    labelRoot = null;
    toggleTray = null;
    toggleEl = null;
    countsToggleEl = null;
    tooltipEl = null;
    tooltipChip = null;
    placedChips = [];
    lastPointer = null;
    chipPool.length = 0;
    tickPool.length = 0;
    labelPool.length = 0;
    ctx = null;
    hotspots = [];
    labels = [];
    timeDomain = null;
    timeInterval = null;
  }

  // Self-manage teardown on the World's dispose (symmetric with detailOverlay/highlightOverlay):
  // ViewerScreen calls world.dispose() on the per-dataset unmount (D-31), which fires this — so
  // layout.ts needs no explicit dispose call.
  worldH.onDispose?.(dispose);

  return {
    config,
    setContext(next: OverlayContext | null): void {
      if (disposed) return;
      ctx = next;
      rebuild();
    },
    setChipsEnabled,
    chipsEnabled(): boolean {
      return chipsOn;
    },
    setCountsEnabled,
    countsEnabled(): boolean {
      return countsOn;
    },
    dispose,
    hotspotCount(): number {
      return hotspots.length;
    },
    chipCount(): number {
      return drawnChips;
    },
    labelAnnotationCount(): number {
      return labels.length;
    },
    labelCount(): number {
      return drawnLabels;
    },
    hasAxis(): boolean {
      return timeDomain !== null && drawnTicks > 0;
    },
    axisTickCount(): number {
      return drawnTicks;
    },
  };
}

/** The real datetime-domain resolver: fetch the actual dates at the axis-endpoint cells and
 *  least-squares fit t↔world-x. The datetime plugin maps time→x LINEARLY (datetime_layout.py:
 *  x_norm = margin + (1−2·margin)·(t−t_min)/span), so the extreme-x cells carry t_min / t_max
 *  and two well-separated (x, t) samples define the axis. Honest (real dates, no faked
 *  domain), client-reachable (the existing getMetadata API), no schema change. Seam 2 replaces
 *  this shim with a producer `annotations.axes.domain`; the caller's render path is unchanged.
 *
 *  KNOWN LIMITATION (flagged): this couples to the plugin's (stable but non-contract) linear
 *  mapping. A non-linear future datetime mode would need the Seam-2 producer domain. */
function defaultResolveTimeDomain(
  client: ApiClient,
  config: OverlayLayerConfig,
): (manifest: LayoutManifest, entry: LayoutEntry, positions: PositionTable) => Promise<TimeDomain | null> {
  return async (manifest, _entry, positions) => {
    const dt = manifest.column_roles?.datetime;
    if (dt == null) return null;
    // The INSTANCE config (not the module default) drives the sample count, so a caller that
    // raises domainSampleCount actually gets more endpoint samples — the field was inert before
    // the PR-179 review. Read live so a T2-101 runtime settings change takes effect.
    const ids = pickDomainSampleIds(positions, config.domainSampleCount);
    if (ids.length < 2) return null;
    const rows = await client.getMetadata(manifest.dataset_id, ids);
    const points: { x: number; t: number }[] = [];
    for (const row of rows) {
      if (row.id < 0 || row.id >= positions.count) continue;
      // By the value's type, not the declared format: the one reader the selection summary
      // shares, so a stored timestamp committed as `unix_*` still fits (#391).
      const t = datetimeInstant(row.fields[dt.column], dt.format);
      if (t !== null) points.push({ x: positions.x[row.id], t });
    }
    return fitTimeDomain(points);
  };
}
