// v2 spatial tile-pyramid loader / residency (decision D-33, renderer-rework-plan).
//
// Replaces the id-ordered atlas pager (the deleted lod.ts) and its ~14 guards
// with the web-map model: each layout owns a self-describing pyramid of square
// tiles addressed {z}/{x}/{y} inside one PMTiles container. To draw a frame:
//   1. pick the level matching the camera zoom (slippy-map level selection),
//   2. enumerate the tiles overlapping the viewport at that level,
//   3. fetch exactly those (AbortSignal-cancellable, focal/distance-ordered),
//   4. FINE tile (z >= z_cap): unpack [uint32 BE len][webp][arrow] → decode the
//      mini-atlas to a texture + parse the records → feed cells.ts (the instanced
//      core) the per-cell sub-rects (u,v,uw,uh),
//   5. COARSE tile (z < z_cap): decode the mosaic webp → draw it as one overview
//      quad.
//
// Two-tier residency (the web-map / Leaflet model), which is what bounds the
// renderer by construction AND keeps it never-grey:
//   * COARSE FALLBACK BAND — the finest coarse (mosaic) level covering the view
//     is kept resident as the always-available floor UNDER the fine cells. It is
//     a handful of standalone overview quads, independent of fine-cell residency,
//     so a region that is loading or has been evicted shows a low-res image, never
//     grey, and a returning region shows something immediately.
//   * FINE OVERLAY — the per-cell instanced buckets in cells.ts for the visible
//     fine tiles. These are TRANSIENT: when a fine tile leaves the view it is
//     evicted, its cells DROPPED (cells.dropTile) and its draw call reclaimed, so
//     the resident set is bounded by the viewport, NOT by how far the user has
//     panned (the v1 pager leaked a bucket per visited tile forever). The evicted
//     tile's decoded texture + records move to a bounded LRU CACHE, so panning
//     back to a recently-seen region re-binds it instantly with no re-fetch.
//
// This module owns the streaming surface `layout.ts` consumes (the v2 replacement
// for lod.ts's LodManager/LodManagerHandle). The PURE policy/geometry below
// (level selection, tile enumeration, focal ordering, LRU choice) is GL-free and
// unit-tested directly; the fetch/decode/GPU path lives in the factory and is
// exercised via the DI seam (deps) in the node unit tests and in the browser.
import * as THREE from "three";
import { errText } from "../api-client/errText.ts";
import type { ApiClient } from "../api-client/client.ts";
import type { CellBuffers, Cells, CellsHandle } from "./cells.ts";
import type { LayoutManifest, LayoutEntry, PyramidDescriptor } from "./layout.ts";
import type { CameraState, Viewport, World, WorldHandle } from "./world.ts";
import {
  createWorkerFineBundleDecoder,
  createSyncFineBundleDecoder,
} from "./fineBundleDecoder.ts";
import type { DecodedFineBundle, FineBundleDecoder } from "./fineBundleDecoder.ts";
import { openPyramidArchive } from "./pmtilesClient.ts";
import type { PyramidArchive } from "./pmtilesClient.ts";
import { guardScheduledWork } from "./health.ts";
import type { RendererFailureSink } from "./health.ts";
import { rendererDebug, publishRendererDebug, vizDebugAvailable } from "./debug.ts";

// ---------------------------------------------------------------------------
// Public geometry types (relocated from the deleted lod.ts)
// ---------------------------------------------------------------------------

export interface BBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number; // world [0,1]^2
}

/** One tile address within a layout's pyramid. */
export interface TileRef {
  layoutId: string;
  z: number;
  x: number;
  y: number;
  /** World-space bbox this tile covers (a sub-rect of the layout bbox). */
  bbox: BBox;
  /** True when z >= z_cap (a self-contained mini-atlas tile carrying records);
   *  false for a coarse mosaic overview tile. */
  fine: boolean;
}

/**
 * The streaming surface `layout.ts` (the LayoutController) consumes — the v2
 * replacement for lod.ts's LodManager/LodManagerHandle. A single coherent model:
 * point it at a layout, and on every camera change it enumerates + loads the
 * visible tiles, drawing the coarse floor under the streaming fine cells.
 */
export interface TilePyramid {
  /** The manifest this loader currently streams from. */
  readonly manifest: LayoutManifest;
  activeLayoutId(): string | null;
  /** Recompute the visible tile set from the camera and stream them.
   *
   *  NO PRODUCTION CALLER (verified 2026-08-22): the loader subscribes to
   *  `world.onCameraChange` itself, and `viewerStatus` / `ViewerScreen` use the WORLD's
   *  method of the same name. It survives only because `tests/frontend_skeleton.test.ts`
   *  asserts the interface shape, which this seam may not edit — so deleting it is
   *  [[T2-236]]. Until then it goes through the SAME guard the camera path does, because
   *  a public member that reaches `streamView` unguarded is the hazard whether or not
   *  anything calls it today. */
  onCameraChange(state: CameraState, viewport: Viewport): void;
  /** Point streaming at a layout: drop the old layout's FINE cells, keep its
   *  COARSE overview meshes drawn as a condemned backdrop (released when the new
   *  coarse floor has SETTLED, or by a watchdog), open the target pyramid (cached per
   *  layout URL), and stream the live view's tiles coarse-first. The NEW layout's
   *  COARSE and FINE binds are both STAGED while that backdrop is up and flushed
   *  atomically the tick it releases (T2-119), so the swap never draws both layouts at
   *  once. State is set synchronously — a camera event mid-switch streams new-layout
   *  tiles only. */
  activateLayout(manifest: LayoutManifest, layoutId: string, frame: BBox | null): Promise<void>;
  /** Bump the stale-drop generation at the START of a layout switch (drops
   *  in-flight old-layout tiles immediately, before activateLayout runs). */
  beginLayoutSwitch(): void;
  /** Register the callback driven when the CURRENT view cannot be rendered at all —
   *  EVERY tile it wants has terminally failed to load (Seam R1 P1, R1-05). It reports
   *  an observation (which layout, and the underlying error text); the shell decides
   *  what health state that is, exactly as `onUnrecoverable` already does for the
   *  context-restore watchdog. One listener; a second registration replaces it. */
  setViewFailureListener(cb: (layoutId: string, detail: string) => void): void;
  /** Register the callback driven when "images aren't loading right now" starts or stops
   *  being true (Seam R2 P3). Pushed only on a CHANGE, so the shell is woken twice per
   *  outage rather than once per failed read. One listener; a second replaces it. */
  setTilesFailingListener(cb: (failing: boolean) => void): void;
  /** Whether the last closed window of tile reads was dominated by failures — the pull
   *  form of the signal above, and the loader's own answer to "is anything landing?".
   *  Distinct from R1-05's view-level verdict, which asks whether THIS VIEW is a total
   *  loss and cannot fire at all for tiles already drawn or cached. Always `false` until
   *  a listener is registered: the ledger is not kept for a loader nobody is watching. */
  tilesFailing(): boolean;
  /** Re-stream the LIVE view: re-issue the loads for every tile it wants, including the
   *  ones that gave up at their retry cap (streamView resets the per-tile budgets). This
   *  is what "Retry this view" drives when the failed layout is the one already active —
   *  `switchTo` no-ops against its own target (layout.ts), so a switch there would clear
   *  the panel and re-fetch nothing. A no-op before any camera has emitted. */
  restreamView(): void;
  /** Number of tile textures currently DRAWN (the active working set; perf/test
   *  introspection). Excludes the LRU cache of evicted-but-retained tiles. */
  residentTileCount(): number;
  /** In-flight tile fetches for the current view (T2-54): the formal read of the
   *  count the ViewerStatus observable / status bar shows, instead of scraping the
   *  DEV-only `__vizDebug` mirror (which is stripped from a prod build). Live count
   *  of the loader's `inflight` map. */
  loadingTileCount(): number;
  /** A snapshot of the resident COARSE overview tiles for the minimap (T2-54): each
   *  resident mosaic tile's decoded source image + the world sub-rect it covers,
   *  plus the active layout's world bbox to map them into the minimap canvas. The
   *  coarse floor is resident by design (the always-available overview band), so this
   *  is a cheap read of already-decoded textures — the minimap draws them once per
   *  layout activation. `tiles` is empty when no coarse tile is resident yet (a fresh
   *  activation, or an all-fine dataset with z_cap 0); the minimap then shows a
   *  neutral field with just the viewport box. null when no layout is active. */
  coarseOverview(): CoarseOverview | null;
}

/** The minimap's overview snapshot (T2-54): the active layout's world extent plus
 *  the resident coarse mosaic tiles, each with its decoded image source and the
 *  world rect it covers. GL-free to consume — a `TexImageSource` (the ImageBitmap
 *  the loader decoded) draws straight onto a 2D canvas. */
export interface CoarseOverview {
  /** The active layout's world bbox — the coordinate frame the minimap maps into. */
  layoutBBox: BBox;
  tiles: { bbox: BBox; image: CanvasImageSource }[];
}

// ---------------------------------------------------------------------------
// Pure policy / geometry (GL-free; unit-tested directly)
// ---------------------------------------------------------------------------

/** Camera state + viewport -> visible world bbox (zoom = world units / px). */
export function bboxFromCamera(state: CameraState, viewport: Viewport): BBox {
  const halfW = (viewport.width / 2) * state.zoom;
  const halfH = (viewport.height / 2) * state.zoom;
  return {
    xMin: state.center[0] - halfW,
    xMax: state.center[0] + halfW,
    yMin: state.center[1] - halfH,
    yMax: state.center[1] + halfH,
  };
}

/** The list of z values the pyramid baked, coarsest first. */
export function pyramidLevels(pyramid: PyramidDescriptor): number[] {
  return [...pyramid.levels].map((l) => l.z).sort((a, b) => a - b);
}

/** Upper bound on the devicePixelRatio factor applied in level selection. A tile
 *  texel spans `dpr` device px, so a HiDPI display wants ~`dpr`× the tiles to keep
 *  texel≈device-px (one level deeper per doubling). Capped so a 3× (or higher)
 *  display does not fetch a whole extra level's worth of tiles for a marginal
 *  sharpness gain — dpr 2 already covers the common Retina case; the cap bounds
 *  fetch cost on the long tail. */
export const MAX_DPR_FOR_LEVEL = 2;

/**
 * Slippy-map LEVEL SELECTION. Pick the pyramid level whose tiles render at about
 * screen resolution for the current zoom, clamped to the levels the dataset
 * actually baked. `bbox` is the layout's world extent; at level z the bbox is
 * subdivided into 2^z tiles per axis, each carrying `tile_px` pixels. A tile's
 * on-screen pixel size is (tileWorldEdge / zoom). We want that ≈ tile_px, i.e.
 * we want enough levels of subdivision that one baked tile's pixels map ~1:1 to
 * screen pixels. Deeper zoom (smaller `zoom`, more screen px per world unit)
 * selects a deeper level. Returned z is always one of `levels`.
 *
 * `dpr` is the devicePixelRatio: the canvas renders at DEVICE resolution
 * (world.ts setPixelRatio(vp.devicePixelRatio)), so on a HiDPI display one CSS px
 * is `dpr` device px and a texel-≈-CSS-px pick renders soft one level too coarse.
 * Targeting texel≈DEVICE-px multiplies the desired tile count by `dpr` (clamped to
 * MAX_DPR_FOR_LEVEL), selecting one level deeper per doubling. dpr defaults to 1
 * (no HiDPI adjustment) so a caller that has no viewport is unchanged.
 *
 * Pure + exported for unit tests.
 */
export function selectLevel(
  pyramid: PyramidDescriptor,
  bbox: BBox,
  zoom: number,
  dpr = 1,
): number {
  const levels = pyramidLevels(pyramid);
  const coarsest = levels[0];
  const finest = levels[levels.length - 1];
  if (zoom <= 0 || !Number.isFinite(zoom)) return coarsest;

  const worldW = Math.max(bbox.xMax - bbox.xMin, 1e-9);
  const worldH = Math.max(bbox.yMax - bbox.yMin, 1e-9);
  const worldEdge = Math.max(worldW, worldH); // the binding axis of the square pyramid

  // Account for the device pixel ratio: the canvas backing store is `dpr`× the CSS
  // size, so a tile texel that matched a CSS px covers `dpr` device px and renders
  // soft. Ask for `dprFactor`× the tiles so a texel maps ~1:1 to a DEVICE px.
  // Clamped to [1, MAX_DPR_FOR_LEVEL] (a non-finite/absurd dpr never fans out).
  const dprFactor = Math.min(MAX_DPR_FOR_LEVEL, Math.max(1, Number.isFinite(dpr) ? dpr : 1));

  // Desired number of tiles across the binding axis so that one tile's pixels map
  // ~1:1 to DEVICE pixels: tileDevicePx = (worldEdge / 2^z) / zoom * dprFactor ≈ tile_px
  //   => 2^z ≈ dprFactor * worldEdge / (zoom * tile_px)
  //   => z ≈ log2(dprFactor * worldEdge / (zoom * tile_px))
  const idealTilesPerAxis = (dprFactor * worldEdge) / (zoom * pyramid.tile_px);
  const idealZ = Math.ceil(Math.log2(Math.max(idealTilesPerAxis, 1)));

  // Snap to the nearest baked level at or below idealZ (don't ask for a level the
  // dataset never baked); clamp into [coarsest, finest].
  let chosen = coarsest;
  for (const z of levels) {
    if (z <= idealZ) chosen = z;
    else break;
  }
  if (idealZ <= coarsest) chosen = coarsest;
  if (idealZ >= finest) chosen = finest;
  return chosen;
}

/**
 * Enumerate the tiles at level `z` whose world sub-rect overlaps `bbox` (the
 * viewport), within the layout `bbox` anchor. At level z the layout bbox is split
 * into 2^z columns/rows; tile (x,y) covers
 *   [bbox.xMin + x*tileW, bbox.xMin + (x+1)*tileW] x [analogous in y].
 * A one-tile prefetch margin is included so a small pan does not strand the edge.
 * `fine` is z >= z_cap. Pure + exported for unit tests.
 */
export function enumerateVisibleTiles(
  layoutId: string,
  layoutBBox: BBox,
  z: number,
  zCap: number,
  view: BBox,
): TileRef[] {
  const n = 2 ** z;
  const worldW = layoutBBox.xMax - layoutBBox.xMin;
  const worldH = layoutBBox.yMax - layoutBBox.yMin;
  const tileW = worldW / n;
  const tileH = worldH / n;
  if (tileW <= 0 || tileH <= 0) return [];

  // Map the view rect into tile-index space, clamped to [0, n-1], grown by one
  // tile of prefetch margin on each side.
  const colMin = Math.max(0, Math.floor((view.xMin - layoutBBox.xMin) / tileW) - 1);
  const colMax = Math.min(n - 1, Math.floor((view.xMax - layoutBBox.xMin) / tileW) + 1);
  const rowMin = Math.max(0, Math.floor((view.yMin - layoutBBox.yMin) / tileH) - 1);
  const rowMax = Math.min(n - 1, Math.floor((view.yMax - layoutBBox.yMin) / tileH) + 1);

  const fine = z >= zCap;
  const refs: TileRef[] = [];
  for (let y = rowMin; y <= rowMax; y++) {
    for (let x = colMin; x <= colMax; x++) {
      const tileBBox: BBox = {
        xMin: layoutBBox.xMin + x * tileW,
        xMax: layoutBBox.xMin + (x + 1) * tileW,
        yMin: layoutBBox.yMin + y * tileH,
        yMax: layoutBBox.yMin + (y + 1) * tileH,
      };
      refs.push({ layoutId, z, x, y, bbox: tileBBox, fine });
    }
  }
  return refs;
}

/**
 * Order tiles NEAREST the focal point first (the cursor on a wheel-zoom, else the
 * viewport centre). Range fetches resolve ≈ in issue order, so loading the focal
 * tile first sharpens the region the user is looking at before the periphery.
 * Returns a sorted COPY. Pure + exported for unit tests.
 */
export function focalOrder(refs: TileRef[], focalX: number, focalY: number): TileRef[] {
  const dist2 = new Map<TileRef, number>();
  for (const r of refs) {
    const dx = (r.bbox.xMin + r.bbox.xMax) / 2 - focalX;
    const dy = (r.bbox.yMin + r.bbox.yMax) / 2 - focalY;
    dist2.set(r, dx * dx + dy * dy);
  }
  return [...refs].sort((a, b) => dist2.get(a)! - dist2.get(b)!);
}

/** Stable string key for a tile address within a layout. */
export function tileKey(ref: { layoutId: string; z: number; x: number; y: number }): string {
  return `${ref.layoutId}/${ref.z}/${ref.x}/${ref.y}`;
}

/** Do two world sub-rects overlap (share any area)? Touching edges do NOT count
 *  as overlap (a tile ends exactly where its neighbour begins). Used by the
 *  retain-until-covered demotion rule to decide whether an active tile leaving the
 *  wanted set still provides the only renderable coverage for a wanted tile whose
 *  own load is still in flight. Pure + exported for unit tests. */
export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin;
}

/** Deepest pyramid z the loader can address. tilePageId packs (z,x,y) into the
 *  cells.ts Int32 atlasPage as y*2^z + x, whose maximum (at x=y=2^z-1) is
 *  2^(2z) - 1; that fits a signed Int32 (< 2^31) only for z <= 15. The manifest
 *  validator (client.ts checkPyramid) rejects a pyramid whose deepest level
 *  exceeds this, and tilePageId asserts it as a defensive backstop. Far beyond any
 *  real bake — ~4^8 fine tiles already cover 1M images, so z stays well under 15. */
export const MAX_PYRAMID_Z = 15;

/**
 * Deterministic cells.ts bucket page id for tile (z,x,y): the row-major index
 * y*2^z + x within the level. STABLE across reloads (unlike a monotonic counter),
 * so a re-visited tile reuses its bucket + cached texture instead of leaking a
 * fresh bucket on every load — the cells.ts bucket key `${z}:${tilePageId}` is
 * the loader's residency key. Throws if z exceeds MAX_PYRAMID_Z, beyond which the
 * row-major index would overflow the Int32 atlas page (cells.ts atlasPage is
 * Int32) into bucket-key collisions. Pure + exported for unit tests.
 */
export function tilePageId(z: number, x: number, y: number): number {
  if (z > MAX_PYRAMID_Z) {
    throw new RangeError(
      `tilePageId: z=${z} exceeds MAX_PYRAMID_Z=${MAX_PYRAMID_Z} — y*2^z+x would overflow the Int32 atlas page`,
    );
  }
  return y * 2 ** z + x;
}

/** AbortError discriminator: a fetch aborted via AbortController rejects with a
 *  DOMException whose `name` is "AbortError" — a supersede, never a real failure. */
export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/**
 * Choose the LRU victims to evict so at most `budget` tiles stay resident, never
 * evicting a tile in the `keep` set. Returns the keys to free, oldest first. Used
 * to trim the texture/record CACHE down to its budget. Pure + exported for tests.
 */
export function chooseEvictions(
  resident: { key: string; lastUsed: number }[],
  keep: Set<string>,
  budget: number,
): string[] {
  if (resident.length <= budget) return [];
  const evictable = resident.filter((e) => !keep.has(e.key)).sort((a, b) => a.lastUsed - b.lastUsed);
  const overBy = resident.length - budget;
  return evictable.slice(0, overBy).map((e) => e.key);
}

// ---------------------------------------------------------------------------
// Loader factory (GL + network; exercised via the DI seam in node tests)
// ---------------------------------------------------------------------------

/** VRAM ceiling for the cache of EVICTED-but-retained tiles (decoded texture +
 *  records), keyed by the cells bucket key. The active (drawn) set is bounded by
 *  the viewport; this caps the VRAM held by the recently-left tiles kept warm for
 *  an instant pan-back. A BYTE budget, NOT a tile count, so the cache bounds VRAM
 *  independent of tile_px: one tile costs ~tile_px²×4 bytes (RGBA8), so the
 *  effective resident tile count is floor(this / tileBytes) (>= MIN_TILE_CACHE).
 *  At the default tile_px=512 this is 128 tiles (≈ the prior fixed budget); at
 *  tile_px=2048 it is 8 tiles — the same ~128 MB ceiling either way, instead of
 *  128 tiles × 16 MB ≈ 2 GB. Total resident VRAM ≈ active (~viewport tiles) + this. */
export const TILE_CACHE_BUDGET_BYTES = 128 * 1024 * 1024;

/** Floor on the cache tile count regardless of tile_px, so a pan-back still finds
 *  a few recently-left tiles warm even at a huge tile_px (where the byte budget
 *  alone would admit very few). */
export const MIN_TILE_CACHE = 8;

/** Resident tile-cache count derived from a VRAM byte budget and the pyramid's
 *  tile_px (an RGBA8 upload is tile_px²×4 bytes per tile), floored at `minTiles`.
 *  Pure + exported for unit tests. */
export function cacheCountForTilePx(byteBudget: number, tilePx: number, minTiles = MIN_TILE_CACHE): number {
  const tileBytes = Math.max(1, tilePx * tilePx * 4);
  return Math.max(minTiles, Math.floor(byteBudget / tileBytes));
}

/** Watchdog for the layout-switch backdrop: the OLD layout's coarse overview
 *  meshes stay drawn (condemned) through a switch so the canvas never blanks,
 *  and are normally released the moment the NEW view's coarse floor has fully
 *  SETTLED (every wanted floor key decoded+staged, null-bodied, or terminally
 *  failed). If that never happens (a floor tile whose fetch HANGS), this bound
 *  disposes them anyway so a stale overview cannot linger under the new layout
 *  indefinitely. */
export const CONDEMNED_COARSE_TTL_MS = 2_000;

/** §0.6 watchdog: how long to wait for `webglcontextrestored` after a loss before
 *  declaring the context unrecoverable and driving `onUnrecoverable` (the
 *  ViewerScreen reload prompt). preventDefault() on the loss is REQUIRED for the
 *  browser to fire `restored`, but it also means a permanent loss never restores —
 *  this bound is the escape hatch so the user is not stranded on a halted canvas. */
export const CONTEXT_RESTORE_TIMEOUT_MS = 10_000;

/** T2-44: backoff delays (ms) for retrying a TRANSIENTLY-failed tile load, indexed
 *  by attempts already spent (0-based). The array length is the per-tile retry CAP:
 *  after this many retries a still-failing tile is left to the coarse parent-fallback
 *  (never-grey floor) instead of tight-looping forever while offline. Exponential:
 *  ~1s, 2s, 4s — long enough to ride out a transient blip, short enough that a
 *  flaky tile self-heals on a still view without a gesture. */
export const RETRY_ATTEMPT_BACKOFF_MS = [1_000, 2_000, 4_000];

/**
 * How long a window of tile reads is judged over (Seam R2 P3) — DERIVED, not picked: one
 * whole retry ladder. A read that failed is only finished trying once its backoff budget
 * is spent, so a ladder is the shortest span over which "these reads are failing" is a
 * fact about the connection rather than a blip the ladder exists to absorb. It is also
 * why the signal takes ~7 s to appear — MEASURED 2026-08-22 at ONE window, from a cold
 * view and from a healthy one alike — and ~7 s of quiet to go away.
 */
export const TILE_FAILURE_WINDOW_MS = RETRY_ATTEMPT_BACKOFF_MS.reduce((a, b) => a + b, 0);

/** Injectable side-effecting dependencies (the GPU/network seam). Production wires
 *  the real PMTiles opener + the createImageBitmap decode; the node unit tests
 *  inject a fake archive + a stub decode so the factory's orchestration (load
 *  order, supersede/abort, eviction, caching, layout switch) is exercised without
 *  a GL context or a browser image decoder. Optional — omitted ⇒ the real impls. */
export interface TilePyramidDeps {
  /** Open a layout's PMTiles pyramid at `url` (default: openPyramidArchive). The
   *  third arg is the T2-09 single-flight static-edge credential refresh the range
   *  Source calls on a 401 (a stale-tab cookie expiry) before retrying once. */
  openArchive?: (
    url: string,
    getAuthHeaders: () => Record<string, string>,
    refreshCredential?: () => Promise<boolean>,
  ) => PyramidArchive;
  /** Decode a WebP byte buffer into a THREE.Texture (default: createImageBitmap
   *  path). The test stub returns a bare THREE.Texture without touching the DOM. */
  decodeImage?: (bytes: Uint8Array) => Promise<THREE.Texture>;
  /** Decode a FINE tile body into its WebP image bytes + SoA CellBuffers (Arrow
   *  parse + record mapping). Default: a Worker in the browser, synchronous
   *  in-process where there is no Worker (node unit tests). Inject to force the
   *  in-process path or a stub. */
  decodeFineBundle?: (body: Uint8Array, level: number, tileSeq: number) => Promise<DecodedFineBundle>;
  /** Override the evicted-tile cache budget as an explicit tile COUNT (default:
   *  derived from TILE_CACHE_BUDGET_BYTES and the layout's tile_px). Lets a unit
   *  test force cache eviction without panning across hundreds of tiles. */
  cacheBudget?: number;
}

/** A tile that is currently DRAWN: a fine tile (cells bucket bound) or a coarse
 *  tile (standalone overview mesh). `buffers` is the fine tile's decoded records,
 *  kept so an evicted tile can be re-applied from the cache without re-parsing. */
interface ResidentTile {
  ref: TileRef;
  texture: THREE.Texture;
  overviewMesh: THREE.Mesh | null;
  buffers: CellBuffers | null;
  lastUsed: number;
}

/** An evicted tile kept warm in the LRU cache: its decoded texture + records,
 *  so a pan-back re-binds instantly (no range fetch, no decode, no Arrow parse). */
interface CachedTile {
  ref: TileRef;
  texture: THREE.Texture;
  buffers: CellBuffers | null;
  lastUsed: number;
}

/** An OLD layout's coarse overview tile kept DRAWN through a layout switch as
 *  the backdrop under the incoming layout (so the canvas never blanks). Released
 *  when the new view's coarse floor has fully SETTLED, or by the
 *  CONDEMNED_COARSE_TTL_MS watchdog — whichever comes first. */
interface CondemnedTile {
  ref: TileRef;
  texture: THREE.Texture;
  mesh: THREE.Mesh;
}

/** A NEW-layout tile that finished decoding while a condemned backdrop is still drawn
 *  (T2-119). Held OUT of `active`/cells/scene so it cannot draw OVER the old coarse
 *  backdrop (the double-layout), and applied atomically the tick the backdrop releases
 *  (flushStaged, from disposeCondemned — the coarse floor SETTLING OR the TTL watchdog).
 *  A supersede/teardown drops it instead (dropStaged, via abortInflight). BOTH tiers
 *  stage: a FINE tile carries its mini-atlas texture + records (`buffers`) and flushes
 *  into a cells bucket; a COARSE tile carries its mosaic texture with `buffers` null and
 *  flushes into a standalone overview mesh. */
interface StagedBind {
  ref: TileRef;
  texture: THREE.Texture;
  /** Fine: the decoded SoA records to migrate into the cells bucket. Coarse: null — a
   *  coarse staged tile flushes to a drawOverview mesh, carrying no cell records. */
  buffers: CellBuffers | null;
}

export function createTilePyramid(
  world: World,
  cells: Cells,
  client: ApiClient,
  manifest: LayoutManifest,
  onUnrecoverable?: () => void,
  deps: TilePyramidDeps = {},
  // Seam R2 P2: where a guarded SCHEDULED site publishes. Report-only and optional, the
  // same shape and for the same reason as `createWorld`'s `health` — the loader can say
  // what broke, and can neither claim readiness nor read what it is writing over.
  health?: RendererFailureSink,
): TilePyramid {
  // The injectable GPU/network seam (DI for the node unit tests): the real
  // PMTiles opener + the createImageBitmap decode unless a test overrides them.
  const openArchive = deps.openArchive ?? openPyramidArchive;
  // The renderer-internal Cells surface (dropTile / handleContextRestored live
  // here; a GL-free test double may omit them — call through the optional cast).
  const cellsH = cells as Partial<CellsHandle> & Cells;

  let activeManifest = manifest;
  let layoutId: string | null = null;
  let layoutEntry: LayoutEntry | null = null;
  let archive: PyramidArchive | null = null;
  let generation = 0;
  let disposed = false;
  let clock = 0;

  // The DRAWN working set: fine tiles (cells bucket) + coarse tiles (overview
  // mesh). Bounded by the viewport (a fixed screen overlaps a fixed, small number
  // of uniform tiles). Keys embed the LAYOUT id (`${layoutId}/${z}:${tilePageId}`)
  // so a layout switch can never collide two layouts' tiles in these maps — the
  // cells.ts bucket key stays `${z}:${page}` because the old layout's fine cells
  // are dropped at switch entry (activateLayout), before the new layout binds.
  const active = new Map<string, ResidentTile>();
  // Evicted-but-retained tiles (LRU), so a pan-back re-binds without a re-fetch.
  const cache = new Map<string, CachedTile>();
  // In-flight tile loads (de-dupe + supersede), keyed like `active`. The value is
  // the load's AbortController so a camera change can CANCEL a tile it no longer
  // wants — abort the range fetch instead of running it to completion only to drop
  // the result — and a generation bump / teardown can abort them all at once.
  const inflight = new Map<string, AbortController>();
  // The keys the latest stream wants drawn. A load that completes for a
  // no-longer-wanted tile is dropped (handles fast pan/zoom superseding a load).
  let wanted = new Set<string>();
  // The TileRefs the latest stream wants (parallel to `wanted`), kept so the
  // retain-until-covered demotion sweep can be re-run when an async load binds —
  // it needs the world bboxes of the still-in-flight wanted tiles to decide which
  // retained tiles are now fully covered and can finally demote.
  let wantedRefs: TileRef[] = [];
  const NO_KEEP: Set<string> = new Set(); // cache trim keeps nothing back

  // ---- bounded retry for TRANSIENTLY-failed tile loads (T2-44) ----
  // A tile whose range fetch/decode failed for a NON-abort reason (a flaky network,
  // a transient 5xx) previously stayed missing until the next camera move / layout
  // activation re-ran streamView — a hole on a still view, defeating the never-grey
  // parent-fallback intent for exactly the flaky-network case it exists to paper
  // over. We re-arm a bounded, backed-off retry: up to RETRY_ATTEMPT_BACKOFF_MS.length
  // attempts per tile key with exponential backoff, still guarded by the SAME
  // generation / disposed / wanted checks the load itself uses (so a supersede or a
  // layout switch cancels the retry), and never retrying an abort. The cap is the
  // ceiling: an offline tile stops after its budget instead of tight-looping.
  //   * `retryAttempts` — attempts SPENT per tile key (persists across the re-arms).
  //   * `retryTimers`   — the pending backoff timer per key, so it can be cleared on
  //     a generation bump / dispose (a stale retry must never fire for a torn-down
  //     or superseded load). A key is in AT MOST one of retryTimers / inflight.
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  //   * `failedKeys`    — the keys that reached that cap for the CURRENT stream pass,
  //     i.e. terminally failed (R1-05). Reset alongside retryAttempts in streamView,
  //     because a fresh pass re-arms every budget: the two ledgers describe the SAME
  //     window and would lie about each other if they aged differently.
  const failedKeys = new Set<string>();

  function bucketKeyOf(ref: { layoutId: string; z: number; x: number; y: number }): string {
    return `${ref.layoutId}/${ref.z}:${tilePageId(ref.z, ref.x, ref.y)}`;
  }

  /** Cancel + forget every pending retry backoff timer. Called wherever in-flight
   *  loads are aborted (generation bump / teardown) so a scheduled retry can never
   *  fire for a superseded or torn-down load. Does NOT clear `retryAttempts` — the
   *  spent-attempt budget is reset only on real new intent (camera move / layout
   *  activation), not on a supersede, so a flapping generation cannot reset the cap
   *  and tight-loop. */
  function clearRetryTimers(): void {
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
  }

  /** Abort + forget every in-flight streaming tile load. Clearing inflight lets a
   *  still-wanted tile re-load fresh under the new generation (the old load drops
   *  itself on the gen check and its finally no longer matches this key). */
  function abortInflight(): void {
    for (const ac of inflight.values()) ac.abort();
    inflight.clear();
    clearRetryTimers(); // pending retries belong to the same superseded intent
    dropStaged(); // decoded-but-unbound fine binds belong to the same intent (T2-119)
  }

  function bumpGeneration(): void {
    generation++;
    abortInflight(); // cancel streaming tile loads
  }

  function pyramidOf(entry: LayoutEntry): PyramidDescriptor {
    return entry.pyramid;
  }

  function layoutBBoxOf(entry: LayoutEntry): BBox {
    return { xMin: entry.bbox[0], yMin: entry.bbox[1], xMax: entry.bbox[2], yMax: entry.bbox[3] };
  }

  function authHeaders(): Record<string, string> {
    // The PMTiles range Source attaches the same identity-only bearer the client
    // would (harmless on the static Caddy path, required by the dev FastAPI
    // fallback). The client exposes its header builder so a token refresh is
    // picked up per request without recreating the archive.
    return client.authHeaders();
  }

  /** Decode a WebP byte buffer into a THREE.Texture (browser-only path; the node
   *  tests inject `deps.decodeImage` so this createImageBitmap path never runs).
   *  `keepImage` (COARSE tiles only) skips the close-after-upload so the decoded
   *  ImageBitmap stays drawable for the minimap snapshot (T2-54): the coarse floor is
   *  a small bounded set, so retaining a few bitmaps is cheap; the many FINE mini-atlas
   *  bitmaps still close after upload to release their CPU pixel buffers. */
  async function decodeImageTextureReal(bytes: Uint8Array, keepImage = false): Promise<THREE.Texture> {
    // Copy into a fresh ArrayBuffer-backed view so the Blob part is typed as a
    // plain ArrayBuffer (a Uint8Array over a potentially-shared buffer is not a
    // valid BlobPart under the strict DOM lib).
    const ab = bytes.slice().buffer as ArrayBuffer;
    const blob = new Blob([ab], { type: "image/webp" });
    // premultiplyAlpha:"none" — decode to STRAIGHT (un-premultiplied) alpha. The v2
    // coarse mosaic pad is baked transparent (Seam A / b1) and libvips writes its RGB
    // STRAIGHT (color preserved through the mip shrink, never bled toward black); the
    // browser's default ("premultiply") would darken the RGB by alpha, so the coarse
    // overview quad (drawn with NormalBlending + premultipliedAlpha:false — straight
    // over-blend) would fringe sparse cell edges dark. Forcing "none" here keeps the
    // texture straight to MATCH that blend. The fine mini-atlas WebP decoded through
    // this same path is fully opaque (alpha 1), so this is a no-op for the fine tier.
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: "none",
      premultiplyAlpha: "none",
    });
    const tex = new THREE.Texture(bitmap);
    tex.flipY = false; // atlas v measured from the image top (matches cells.ts base quad)
    tex.premultiplyAlpha = false; // the ImageBitmap is straight; do not re-premultiply on upload
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // Close the decoded ImageBitmap after its FIRST GPU upload to release its
    // (potentially large) CPU-side pixel buffer for the texture's lifetime.
    // CLOSE STRATEGY = close-after-upload, and it is safe here because the WebGL
    // context-loss RECOVERY path REFETCHES rather than re-uploading from
    // texture.image: onContextLost disposes every resident/cached texture and
    // onContextRestored calls refresh() → loadTile → archive.getTile + a fresh
    // createImageBitmap, so the retained bitmap is never needed for a second
    // upload. (`tile_pyramid_loader.test.ts` "context loss … re-binds" proves the
    // refetch — it asserts residentTileCount()>0 AFTER the old textures were
    // dropped, only possible because restore re-fetches.) Three calls
    // Texture.onUpdate exactly once, right after the upload completes and before
    // it clears needsUpdate, so this fires post-upload; guarded on ImageBitmap
    // existing (a data-URI/HTMLImage source has no close()). SKIPPED for coarse tiles
    // (keepImage): the minimap draws their decoded ImageBitmap (coarseOverview →
    // paintOverview), which a closed bitmap would fault on — the coarse floor is a
    // small bounded set so keeping those bitmaps costs little.
    if (!keepImage) {
      tex.onUpdate = () => {
        const img = tex.image as unknown;
        if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) {
          img.close();
        }
      };
    }
    tex.needsUpdate = true;
    return tex;
  }
  // The DI seam's decodeImage stays a 1-arg contract (test stubs return a bare
  // THREE.Texture with no real ImageBitmap, so keepImage is meaningless to them);
  // only the real createImageBitmap path honours keepImage (coarse tiles → the minimap
  // needs their bitmap drawable).
  const decodeImageTexture = (bytes: Uint8Array, keepImage = false): Promise<THREE.Texture> =>
    deps.decodeImage !== undefined ? deps.decodeImage(bytes) : decodeImageTextureReal(bytes, keepImage);

  /** Dispose a tile's texture AND close its decoded `ImageBitmap` if still open.
   *  `THREE.Texture.dispose()` frees the GL texture but NEVER closes the bitmap, so
   *  every tile whose bitmap outlived its upload-time close leaks it here otherwise:
   *  coarse tiles skip that close by design (keepImage — the minimap draws them), and
   *  any tile aborted before its first upload never fired the close hook. Closing
   *  reclaims the decoded pixels immediately instead of waiting for GC to collect the
   *  Texture. Idempotent — close() on an already-closed/absent bitmap is a no-op — so
   *  it is safe on the fine path too. (A coarse bitmap may still be referenced by the
   *  minimap's last overview snapshot; `Minimap.paintOverview` already guards a
   *  released source with try/catch and self-heals on its next re-snapshot.) */
  function disposeTileTexture(texture: THREE.Texture): void {
    const img = texture.image as unknown;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
    texture.dispose();
  }

  // Fine-tile decode (Arrow parse + record mapping). Off-thread in the browser so a
  // burst of tile loads during a pan does not jank the frame; synchronous in-process
  // where there is no Worker (node unit tests) so the loader tests are unchanged. An
  // injected `deps.decodeFineBundle` wins (no worker to terminate).
  const bundleDecoder: FineBundleDecoder =
    deps.decodeFineBundle !== undefined
      ? { decode: deps.decodeFineBundle, terminate: () => {} }
      : typeof window !== "undefined" && typeof Worker !== "undefined"
        ? createWorkerFineBundleDecoder()
        : createSyncFineBundleDecoder();
  const decodeFineBundle = bundleDecoder.decode;

  /** Draw a COARSE mosaic tile as one textured overview quad spanning its world
   *  sub-rect. Minimal standalone mesh (cells.ts only knows per-cell quads). */
  function drawOverview(ref: TileRef, texture: THREE.Texture): THREE.Mesh {
    const w = ref.bbox.xMax - ref.bbox.xMin;
    const h = ref.bbox.yMax - ref.bbox.yMin;
    const geom = new THREE.PlaneGeometry(w, h);
    geom.translate(ref.bbox.xMin + w / 2, ref.bbox.yMin + h / 2, -1); // behind the cells
    // DoubleSide is REQUIRED: the world camera uses a y-flipped orthographic
    // projection (world.ts applyCamera sets top < bottom so world-y grows downward
    // on screen), which reverses triangle winding. A default FrontSide material is
    // then back-face culled and the overview never renders — the cells material is
    // DoubleSide for exactly this reason (world.ts notes "the projection flip is
    // harmless; cell materials render DoubleSide"). Omitting it here is what made
    // coarse-overview tiles (z < z_cap) render blank.
    //
    // NB the y-flip is compensated at BAKE time, per layout plugin — scatter inverts
    // its placed y (scatter.py, T2-85) and datetime stacks so counts grow upward
    // (datetime_layout.py) — NOT with a global camera flip. Do NOT "correct" the flip
    // here or in world.ts applyCamera: those plugins already account for it, so a
    // camera-level flip would double-invert scatter/datetime. Screen orientation is a
    // layout-plugin concern; the renderer draws world coords as given.
    //
    // transparent + STRAIGHT-alpha over-blend (Seam A / b1, decision D-iv): the v2
    // mosaic pad is baked TRANSPARENT (alpha 0), cells opaque, so a sparse overview
    // (datetime: ~90% empty) must composite OVER the canvas ground (`--ground`, the
    // transparent WebGL canvas over a CSS ground) rather than paint an opaque black
    // pad. transparent:true enables blending; NormalBlending with premultipliedAlpha
    // FALSE is the standard straight-alpha `src.rgb*src.a + dst.rgb*(1-src.a)` — the
    // MATCH for the texture, which is decoded with premultiplyAlpha:"none"
    // (decodeImageTextureReal) so its RGB is straight (un-premultiplied). Getting this
    // pairing wrong (a premultiplied texture with straight blending, or vice versa)
    // fringes the sparse pad's cell edges dark. The mini-atlas WebP the fine tier
    // decodes through the SAME path is fully opaque (alpha 1 everywhere sampled), so
    // premultiplyAlpha:"none" is a no-op there — the fine tier is unaffected.
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.NormalBlending,
      premultipliedAlpha: false,
      depthTest: false,
      // depthWrite:false to MATCH the fine cells (cells.ts): the overview is a coplanar
      // transparent backdrop drawn behind the cells by add/z order, not by the depth
      // buffer (depthTest:false). MeshBasicMaterial defaults depthWrite:true, which
      // would have this transparent quad write depth it never tests against — harmless
      // today (nothing depth-tests; picking is CPU-side) but a latent trap for any
      // future depth-testing pass. Off is the correct, consistent setting.
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    world.scene.add(mesh);
    return mesh;
  }

  /** Stop drawing a coarse tile's overview mesh (dispose its geometry/material;
   *  the texture is handled by the caller — cached or disposed). */
  function disposeOverviewMesh(t: ResidentTile): void {
    if (t.overviewMesh === null) return;
    world.scene.remove(t.overviewMesh);
    t.overviewMesh.geometry.dispose();
    (t.overviewMesh.material as THREE.Material).dispose();
    t.overviewMesh = null;
  }

  // ---- layout-switch backdrop (condemned old-coarse overview meshes) ----
  // On a layout switch the old layout's FINE cells are dropped immediately, but
  // its COARSE overview meshes stay in the scene as a backdrop so the window
  // between "old layout freed" and "new coarse floor ready" never shows a blank
  // canvas. They live only here (never in cells.ts buckets), keyed out of
  // `active` entirely, and are disposed when the new view's coarse floor has
  // SETTLED (maybeReleaseCondemned) or when the watchdog fires.
  let condemned: CondemnedTile[] = [];
  let condemnedWatchdog: ReturnType<typeof setTimeout> | null = null;
  // The coarse floor keys the CURRENT view wants drawn (set by streamView).
  let coarseFloorWanted = new Set<string>();
  // The coarse floor keys that have SETTLED this switch — reached a terminal outcome:
  // decoded+staged, null body (the tile was never baked), or a non-abort fetch failure
  // past its retry cap. The backdrop releases when EVERY coarseFloorWanted key has
  // settled. Reset in disposeCondemned (each switch entry runs disposeCondemned before
  // condemning the new backdrop, so it starts empty). "Settled, not bound" is the
  // T2-119 residual fix: a SPARSE layout (scatter z>=2, datetime z>=1) has floor
  // positions that were never baked, whose fetches return a null body and are dropped
  // WITHOUT entering `active` — so the pre-fix "every wanted floor key in `active`"
  // release was UNSATISFIABLE and the backdrop always hung the full TTL, letting the
  // transparent mosaic gaps show the OLD layout through (the reported double). Settling
  // on the null-body / terminal-failure outcomes makes the release condition reachable.
  let coarseFloorSettled = new Set<string>();

  // ---- staged NEW-layout binds (T2-119: atomic layout swap) ----
  // While a condemned backdrop is drawn, a NEW-layout tile that finishes decoding is
  // NOT applied yet — a fine tile's sharp cells would draw OVER the old coarse backdrop
  // and a new coarse tile would composite its (transparent-padded) mosaic OVER it,
  // either way showing BOTH layouts at once. BOTH tiers are held here instead, keyed
  // like `active`/`inflight` (bucket key), and applied in the SAME synchronous tick the
  // backdrop releases (flushStaged, from disposeCondemned) — whether the release is the
  // new coarse floor SETTLING or the TTL watchdog — so the new layout appears exactly as
  // the backdrop leaves (an atomic swap). With NO backdrop (first activation / same-
  // layout re-stream) binds apply immediately: staging is scoped to the switch window.
  // MEMORY: this holds one switch's worth of decoded textures (≈ a viewport of tiles)
  // for ≤ CONDEMNED_COARSE_TTL_MS; both dropStaged (supersede/teardown) and flushStaged
  // clear it, so it never accumulates across switches.
  const staged = new Map<string, StagedBind>();

  function disposeCondemned(): void {
    if (condemnedWatchdog !== null) {
      clearTimeout(condemnedWatchdog);
      condemnedWatchdog = null;
    }
    for (const c of condemned) {
      world.scene.remove(c.mesh);
      c.mesh.geometry.dispose();
      (c.mesh.material as THREE.Material).dispose();
      disposeTileTexture(c.texture); // coarse: also close the kept-open ImageBitmap
    }
    condemned = [];
    coarseFloorSettled = new Set(); // switch over — clear the per-switch settle ledger
    // The backdrop is gone THIS tick — flush ALL staged NEW-layout binds (coarse then
    // fine, inside flushStaged) in the SAME synchronous block so the new layout appears
    // exactly as the backdrop leaves (T2-119, atomic swap). On a supersede/teardown path
    // abortInflight already ran dropStaged, so `staged` is empty here and this is a no-op.
    flushStaged();
  }

  /** Apply every STAGED new-layout bind and move it into `active` — the atomic flush
   *  that pairs with the backdrop release (disposeCondemned). COARSE staged tiles flush
   *  FIRST (their overview meshes are the floor the fine cells draw over — mirrors
   *  streamView's coarse-before-fine order), then the FINE tiles bind their cells. Every
   *  staged bind is current-generation by construction (a supersede runs dropStaged
   *  before this can be reached), so no per-bind generation check is needed here. A
   *  staged tile the view no longer wants is applied too, then demoted by the next
   *  streamView's retain sweep — harmless (it is off-screen) and self-reconciling. */
  function flushStaged(): void {
    if (staged.size === 0) return;
    // Coarse floor first: the new overview meshes must be in the scene under the fine
    // cells that draw over them.
    for (const [key, s] of staged) {
      if (s.ref.fine) continue;
      const mesh = drawOverview(s.ref, s.texture);
      active.set(key, { ref: s.ref, texture: s.texture, overviewMesh: mesh, buffers: null, lastUsed: ++clock });
    }
    for (const [key, s] of staged) {
      if (!s.ref.fine) continue;
      const page = tilePageId(s.ref.z, s.ref.x, s.ref.y);
      cells.setAtlasTexture(s.ref.z, page, s.texture, false);
      cells.setBuffers(s.buffers!); // a FINE staged tile always carries its decoded records
      active.set(key, { ref: s.ref, texture: s.texture, overviewMesh: null, buffers: s.buffers, lastUsed: ++clock });
    }
    staged.clear();
  }

  /** Discard every staged bind (coarse or fine), disposing its decoded texture. Called
   *  on a generation bump (a supersede: the staged binds belong to the now-abandoned
   *  switch) and on teardown — the exact parallel to abortInflight dropping the
   *  superseded in-flight fetches, which is why it rides inside abortInflight.
   *  disposeTileTexture also closes a coarse tile's kept-open ImageBitmap. */
  function dropStaged(): void {
    for (const s of staged.values()) disposeTileTexture(s.texture);
    staged.clear();
  }

  /** (Re-)arm the condemned-backdrop watchdog: clear any pending timer and start a fresh
   *  CONDEMNED_COARSE_TTL_MS window. Used both when a switch first condemns coarse
   *  (condemnOldCoarse) and when a rapid double-switch TRANSFERS an existing backdrop
   *  (transferCondemnedBackdrop) — a transfer must RESTART the window so a switch landing
   *  late in the previous window does not fire the backstop almost immediately. */
  function armCondemnedWatchdog(): void {
    if (condemnedWatchdog !== null) clearTimeout(condemnedWatchdog);
    condemnedWatchdog = setTimeout(() => {
      condemnedWatchdog = null;
      disposeCondemned();
    }, CONDEMNED_COARSE_TTL_MS);
  }

  /** Move every still-active OLD-layout coarse overview (layout != `targetId`)
   *  from `active` to the condemned backdrop, and arm the release watchdog. */
  function condemnOldCoarse(targetId: string): void {
    for (const [key, t] of [...active.entries()]) {
      if (t.ref.layoutId === targetId || t.overviewMesh === null) continue;
      active.delete(key);
      condemned.push({ ref: t.ref, texture: t.texture, mesh: t.overviewMesh });
    }
    if (condemned.length > 0) armCondemnedWatchdog();
  }

  /** BACKDROP TRANSFER (T2-119, rapid double-switch A→B→C): the incoming `active` holds
   *  NO coarse to condemn, but a backdrop from the PREVIOUS switch is still drawn (its
   *  floor never settled). Retain those condemned meshes as THIS switch's backdrop —
   *  re-arm the watchdog (RESTART the 2s window) and reset the settle ledger so the
   *  release re-keys on the NEW target's floor (coarseFloorWanted re-derives per
   *  streamView pass). No dispose, no flush: bumpGeneration → dropStaged already cleared
   *  the superseded staged binds, so the retained backdrop holds until the new floor
   *  settles (or the fresh watchdog fires), and the eventual disposeCondemned frees the
   *  transferred meshes' textures exactly once (it is the same `condemned` list — the
   *  meshes are never re-pushed, so never double-disposed). Without this, disposing the
   *  backdrop here would strand the new target with no floor and flash a BLANK during its
   *  cold coarse fetch (the regression the atomic-swap otherwise introduced). */
  function transferCondemnedBackdrop(): void {
    armCondemnedWatchdog();
    coarseFloorSettled = new Set();
  }

  /** Release the backdrop once EVERY wanted coarse-floor key has SETTLED (not merely
   *  bound). Called when a floor key settles (settleCoarseFloor) and at the end of each
   *  streamView (which covers a pan that shrinks the wanted floor to already-settled
   *  keys). The atomic flip lives in disposeCondemned → flushStaged: the backdrop
   *  dispose + the staged coarse/fine flush happen in one synchronous pass, so the
   *  canvas never shows both layouts and never blanks. */
  function maybeReleaseCondemned(): void {
    if (condemned.length === 0) return;
    // Vacuous-pass note: an EMPTY coarseFloorWanted releases immediately (the loop body
    // never runs). Unreachable while a backdrop is up — a condemned backdrop implies the
    // dataset baked a coarse band (z_cap >= 1) that the outgoing view drew, and the
    // incoming view over the SAME dataset enumerates a non-empty coarse floor too. The
    // condemned.length guard above is the real gate regardless.
    for (const key of coarseFloorWanted) if (!coarseFloorSettled.has(key)) return;
    disposeCondemned();
  }

  /** Record that a wanted coarse-floor tile reached a TERMINAL outcome this switch —
   *  decoded+staged, null body (not baked), or a non-abort failure past its retry cap —
   *  and re-check the release condition. A no-op outside a switch (no backdrop) or for a
   *  key the current view no longer wants. This is what lets a SPARSE floor (some keys
   *  never bake ⇒ null body, never entering `active`) satisfy the release at all, instead
   *  of hanging the backdrop until the TTL and showing the old layout through the
   *  transparent gaps (the T2-119 residual). */
  function settleCoarseFloor(key: string): void {
    if (condemned.length === 0) return;
    if (!coarseFloorWanted.has(key)) return;
    coarseFloorSettled.add(key);
    maybeReleaseCondemned();
  }

  /** Demote an ACTIVE tile to the cache: stop drawing it (drop its fine cells /
   *  remove its overview mesh) but KEEP its texture + records, so a pan-back
   *  re-binds it instantly. This is what bounds the drawn set by the viewport. */
  function demote(key: string): void {
    const t = active.get(key);
    if (t === undefined) return;
    active.delete(key);
    if (t.overviewMesh !== null) {
      disposeOverviewMesh(t);
    } else {
      cellsH.dropTile?.(t.ref.z, tilePageId(t.ref.z, t.ref.x, t.ref.y));
    }
    cache.set(key, { ref: t.ref, texture: t.texture, buffers: t.buffers, lastUsed: t.lastUsed });
  }

  /** Promote a cached tile back to the active (drawn) set, re-binding its texture
   *  + records (fine) or re-drawing its overview quad (coarse). No fetch/decode.
   *  Fine binds here are NOT staged behind a layout-switch backdrop (T2-119): a
   *  switch enters with the incoming layout's cache EMPTY (freeCache keeps only the
   *  target's tiles, and the target's cache was cleared when the view last left it),
   *  so no target-layout tile is cache-promotable inside the switch window — only
   *  loadTile's fresh binds are, and those take the staged path. */
  function promote(key: string, cached: CachedTile): void {
    cache.delete(key);
    const ref = cached.ref;
    const lastUsed = ++clock;
    if (ref.fine) {
      cells.setAtlasTexture(ref.z, tilePageId(ref.z, ref.x, ref.y), cached.texture, false);
      if (cached.buffers !== null) cells.setBuffers(cached.buffers);
      active.set(key, { ref, texture: cached.texture, overviewMesh: null, buffers: cached.buffers, lastUsed });
    } else {
      const mesh = drawOverview(ref, cached.texture);
      active.set(key, { ref, texture: cached.texture, overviewMesh: mesh, buffers: null, lastUsed });
    }
  }

  /** Free active tiles matching `pred` (default: all). For a coarse tile: remove
   *  its overview mesh. For a fine tile: drop its cells iff `dropCells` (teardown
   *  leaves cells to cells.dispose(); a layout switch / GPU loss drops them). Then
   *  dispose the texture (the loader owns it). */
  function freeActive(opts: { dropCells: boolean }, pred?: (t: ResidentTile) => boolean): void {
    for (const [key, t] of [...active.entries()]) {
      if (pred !== undefined && !pred(t)) continue;
      active.delete(key);
      if (t.overviewMesh !== null) {
        disposeOverviewMesh(t);
      } else if (opts.dropCells) {
        cellsH.dropTile?.(t.ref.z, tilePageId(t.ref.z, t.ref.x, t.ref.y));
      }
      disposeTileTexture(t.texture);
    }
  }

  /** Dispose cached tiles matching `pred` (default: all) — their decoded textures. */
  function freeCache(pred?: (c: CachedTile) => boolean): void {
    for (const [key, c] of [...cache.entries()]) {
      if (pred !== undefined && !pred(c)) continue;
      cache.delete(key);
      disposeTileTexture(c.texture);
    }
  }

  /** The evicted-tile cache budget as a tile COUNT. An explicit test override wins;
   *  otherwise it is derived per-layout from the VRAM byte budget and the active
   *  pyramid's tile_px, so a large-tile dataset caches fewer tiles for the same
   *  VRAM ceiling (512px ⇒ 128 tiles, 2048px ⇒ 8 tiles, both ~128 MB). */
  function cacheCountBudget(): number {
    if (deps.cacheBudget !== undefined) return deps.cacheBudget;
    const tilePx = layoutEntry !== null ? pyramidOf(layoutEntry).tile_px : 512;
    return cacheCountForTilePx(TILE_CACHE_BUDGET_BYTES, tilePx);
  }

  /** Trim the LRU cache down to its budget, disposing the oldest evicted tiles'
   *  textures — the second (and final) bound on resident VRAM. */
  function trimCache(): void {
    const budget = cacheCountBudget();
    if (cache.size <= budget) return;
    const snapshot = [...cache.entries()].map(([key, c]) => ({ key, lastUsed: c.lastUsed }));
    for (const key of chooseEvictions(snapshot, NO_KEEP, budget)) {
      const c = cache.get(key);
      if (c === undefined) continue;
      cache.delete(key);
      disposeTileTexture(c.texture);
    }
  }

  /** Ensure a tile is drawn: touch it if active, promote it from the cache, or
   *  start an async load (de-duped against in-flight loads AND a pending retry). */
  function ensureActive(ref: TileRef, gen: number): void {
    const key = bucketKeyOf(ref);
    const a = active.get(key);
    if (a !== undefined) {
      a.lastUsed = ++clock;
      return;
    }
    const cached = cache.get(key);
    if (cached !== undefined) {
      promote(key, cached);
      return;
    }
    // Decoded and STAGED behind the layout-switch backdrop (T2-119): already loaded —
    // it flushes to `active` when the backdrop releases; do not re-fetch it.
    if (staged.has(key)) return;
    // Already loading, or waiting out a retry backoff — either will bind the tile.
    if (inflight.has(key) || retryTimers.has(key)) return;
    void loadTile(ref, key, gen);
  }

  /** Whoever wants to be told this view cannot be drawn (R1-05); null until the shell
   *  registers. Renderer-owned and UI-free: it hands out an observation, never a
   *  health state (module-map rule 4). */
  let viewFailureListener: ((layoutId: string, detail: string) => void) | null = null;

  /** Declare the CURRENT view unrenderable when every tile it wants has terminally
   *  failed — the moment a user would call "nothing loaded", as opposed to "a tile is
   *  missing", which the coarse floor and the retain sweep already cover.
   *
   *  The predicate is DERIVED, not a picked threshold: `wanted` is the set streamView
   *  already computes as "what this view needs drawn", and a key leaves `failedKeys`
   *  only by a fresh stream pass clearing it. So one capped tile at the edge of the
   *  viewport cannot fire this, and a view of exactly one tile that fails legitimately
   *  can — it IS the whole view. A tile that came back null (never baked, the sparse
   *  case) never enters `failedKeys`, so a legitimately empty region stays quiet.
   *
   *  Latency is likewise derived: the last tile settles one whole retry ladder
   *  (RETRY_ATTEMPT_BACKOFF_MS, ~7s) after the outage starts, because publishing sooner
   *  would raise a panel over a blip the ladder is there to absorb. */
  function reportViewFailureIfUnrenderable(detail: string): void {
    if (viewFailureListener === null || layoutId === null || wanted.size === 0) return;
    for (const key of wanted) if (!failedKeys.has(key)) return;
    viewFailureListener(layoutId, detail);
  }

  // --- "images aren't loading right now" (Seam R2 P3) ------------------------------
  //
  // R1-05's view-level verdict cannot cover the case an operator found in a browser:
  // with the API stopped and a view already on screen you can pan while every tile 502s
  // and never be told anything, because `ensureActive` returns early for tiles already
  // drawn or cached — they are never re-requested, never fail, and "every wanted tile
  // failed" never becomes true. It clears only by switching layouts.
  //
  // So this ledgers TILE KEYS at the `loadTile` choke point. Not `failedKeys`, which
  // every stream pass wipes (`retryAttempts.clear()` / `failedKeys.clear()` below run
  // once per animation frame while the camera moves, and a key only enters it after the
  // whole retry ladder, which a panning user never reaches — measured against the outage
  // fixture: 208 reads, all 502, 0 terminal failures recorded). And not a reads-issued
  // counter, because there was none.
  //
  // KEYS, not ATTEMPTS, and that is load-bearing twice over. Counting attempts made a
  // failing key worth 4x a landed one — its whole retry ladder — so `failed >= landed`
  // armed at k >= N/5 (measured on the 4x4 fixture: 3 of 16 silent, 4 of 16 firing),
  // which put this publisher in direct contradiction with `reportViewFailureIfUnrenderable`
  // above, pinned to stay SILENT for a view that still draws. And it made the ladder's own
  // successes invisible: a blip where every tile 502s once and serves on retry counted 16
  // failures against 16 landings and raised an outage over a COMPLETE atlas. Per key, the
  // latest outcome wins, so that blip reads as sixteen landed keys and says nothing.
  //
  // The verdict has TWO INDEPENDENT HALVES, and keeping them apart is the whole design:
  //
  //  * the RATIO is over PERSISTENT sets — every key the view wants is in exactly one of
  //    `failingKeys` / `landedKeys`, by the outcome of its LAST read, pruned to `wanted`
  //    at each window close so both stay viewport-bounded. ON needs the failing side to
  //    STRICTLY outnumber the landed one; an even split is not "images aren't loading".
  //    Per-WINDOW sets could not carry this. Judged that way, and compared against the
  //    PREVIOUS window's landed count to stop a lone retry straggler reading as an outage,
  //    the operator's own case cost an extra window: the outage's first window was measured
  //    against a full window of healthy landings and lost. MEASURED 2026-08-22 against the
  //    4x4 fixture (load a view, close a window, switch layouts with the archive down):
  //    2 windows to the verdict, versus 1 with persistent sets. Persistent sets also fix
  //    the straggler for free — that key is one entry against a viewport of landed ones —
  //    because a key that fails MOVES rather than being outvoted by its own history.
  //  * the RECENCY is per window: something must have FAILED during it. That half, and
  //    only that half, is what clears the signal over an idle camera. It cannot be keyed
  //    on a success — the natural response to a broken picture is to stop moving, and a
  //    still camera issues no reads at all (the ladder caps; only a camera move issues a
  //    fresh one), so a success-only clear would be permanent by construction over a
  //    backend that came back. And it cannot be keyed on the latest outcome:
  //    `Cache-Control: immutable` on /datasets/* means cached ranges succeed OFFLINE while
  //    uncached neighbours 502, so the two interleave for a whole pan.
  //
  // The window re-arms while reads are still happening and then stops, so a viewer nobody
  // is using runs no timer — and the last window to close is the one that clears the
  // signal, because a window with no reads cannot meet the recency half.
  let failingListener: ((failing: boolean) => void) | null = null;
  let tilesFailingNow = false;
  // The two sets are PERSISTENT, not per-window: a key sits in exactly one of them, by the
  // outcome of its last read, until the view stops wanting it. What the window supplies is
  // only the "right now" half — whether anything failed during it.
  const failingKeys = new Set<string>();
  const landedKeys = new Set<string>();
  let windowSawFailedRead = false;
  let windowSawAnyRead = false;
  let failureWindow: ReturnType<typeof setTimeout> | null = null;

  /** Close the current window: judge it, tell the shell if the answer changed, and start
   *  another only while there is something left to watch. */
  function closeFailureWindow(): void {
    failureWindow = null;
    // Only the tiles the CURRENT view wants count, which is also what bounds these sets —
    // otherwise they would grow with every distinct key panned over in a session.
    for (const k of failingKeys) if (!wanted.has(k)) failingKeys.delete(k);
    for (const k of landedKeys) if (!wanted.has(k)) landedKeys.delete(k);
    // "images aren't loading RIGHT NOW" = something failed during this window, AND more of
    // the view is failing than is landing. The two halves are separate on purpose: the
    // ratio is a fact about the view and must not be chopped at a window boundary, while
    // the recency is a fact about time and is the only thing that can clear the signal
    // over an idle camera.
    const next = windowSawFailedRead && failingKeys.size > landedKeys.size;
    const sawReads = windowSawAnyRead;
    windowSawFailedRead = false;
    windowSawAnyRead = false;
    publishTilesFailing(next);
    // `sawReads` alone, not `next || sawReads` (review C2): `next` requires
    // `windowSawFailedRead`, which requires a read, so `next ⟹ sawReads` and the first
    // disjunct could never fire on its own. Keep watching while reads are happening, and
    // stop when they are not — a viewer nobody is using runs no timer, and the signal is
    // cleared by the last window that closes.
    if (sawReads) armFailureWindow();
  }

  function publishTilesFailing(next: boolean): void {
    if (next === tilesFailingNow) return;
    tilesFailingNow = next;
    failingListener?.(next);
  }

  function armFailureWindow(): void {
    if (failureWindow !== null || disposed) return;
    failureWindow = setTimeout(closeFailureWindow, TILE_FAILURE_WINDOW_MS);
  }

  /** One tile READ reached a terminal outcome for `key`. `landed` covers a decoded tile
   *  AND a null body (the address is simply not baked): both mean the range request was
   *  answered, which is what this signal is about. A superseded / aborted load records
   *  nothing — it never asked the network a question it waited for the answer to.
   *
   *  The LATEST outcome per key wins within the window, so a key's retries never inflate
   *  it and a key the ladder healed counts as landed.
   *
   *  Nothing is recorded and no window is armed until the shell registers a listener, the
   *  same gate `reportViewFailureIfUnrenderable` already applies: a periodic verdict
   *  nobody reads is a timer running for nothing. In production the shell registers
   *  immediately after construction, before the first activation, so no read is missed. */
  function recordTileRead(key: string, landed: boolean): void {
    if (failingListener === null) return;
    windowSawAnyRead = true;
    if (landed) {
      landedKeys.add(key);
      failingKeys.delete(key);
    } else {
      failingKeys.add(key);
      landedKeys.delete(key);
      windowSawFailedRead = true;
    }
    armFailureWindow();
  }

  /** Re-arm a bounded, backed-off retry for a tile whose load failed for a NON-abort
   *  reason (T2-44). Consumes one attempt from the tile's budget; if the budget is
   *  spent the tile is left to the coarse parent-fallback (never tight-loops). The
   *  scheduled load re-checks the SAME generation / disposed / wanted guards before
   *  re-issuing (a supersede or teardown between the failure and the timer cancels
   *  the retry — see clearRetryTimers), and re-enters via loadTile so a successful
   *  retry binds through the normal path (parent-fallback + retain sweep intact).
   *  `detail` is the failing load's error text, carried so the view-level verdict at
   *  the cap can say WHY rather than just that it happened. */
  function scheduleRetry(ref: TileRef, key: string, gen: number, detail: string): void {
    const spent = retryAttempts.get(key) ?? 0;
    if (spent >= RETRY_ATTEMPT_BACKOFF_MS.length) {
      // Cap reached — stop (never offline-loop). A TERMINAL fetch failure: if this is a
      // wanted coarse-floor key mid-switch, count it SETTLED so a floor tile that will
      // never load cannot hang the backdrop past the release condition (the TTL remains
      // the backstop for a tile that HANGS rather than fails).
      settleCoarseFloor(key);
      // ...and record it against the VIEW (R1-05). Settling above is about the switch
      // backdrop; this is about whether the user is looking at anything at all.
      failedKeys.add(key);
      reportViewFailureIfUnrenderable(detail);
      return;
    }
    retryAttempts.set(key, spent + 1);
    const delay = RETRY_ATTEMPT_BACKOFF_MS[spent];
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      // Re-validate against the CURRENT state: a layout switch / teardown / camera
      // move away cancels this retry (a stale generation or an unwanted key just
      // drops it — the backoff is not a promise the tile is still relevant).
      if (disposed || gen !== generation || archive === null || !wanted.has(key)) return;
      if (active.has(key) || cache.has(key) || inflight.has(key)) return; // already handled
      void loadTile(ref, key, gen);
    }, delay);
    retryTimers.set(key, timer);
  }

  async function loadTile(ref: TileRef, key: string, gen: number): Promise<void> {
    if (archive === null) return;
    // Per-tile AbortController: a camera change that no longer wants this tile (see
    // streamView), a generation bump, or teardown aborts THIS load's range fetch.
    const ac = new AbortController();
    inflight.set(key, ac);
    const signal = ac.signal;
    try {
      const body = await archive.getTile(ref.z, ref.x, ref.y, signal);
      // Supersede / unmount / no-longer-wanted checks before any GPU work.
      if (disposed || gen !== generation || signal.aborted || !wanted.has(key)) return;
      if (body === null) {
        // No tile baked here → the coarse floor stays drawn under this gap. During a
        // layout switch this is a SETTLED outcome for a floor key: a sparse layout's
        // un-baked floor tiles MUST count toward the release, or the backdrop hangs
        // waiting for a bind that can never happen (the T2-119 residual). A no-op for a
        // fine-tile miss or outside a switch (settleCoarseFloor guards both).
        settleCoarseFloor(key);
        recordTileRead(key, true); // the archive ANSWERED — a sparse gap is not an outage (P3)
        return;
      }

      if (ref.fine) {
        const page = tilePageId(ref.z, ref.x, ref.y);
        // Off-thread Arrow parse + record mapping (the worker in the browser).
        const bundle = await decodeFineBundle(body, ref.z, page);
        // A supersede/abort can land during the worker round-trip — bail before the
        // (also async) texture decode so we do not do GPU work for a dropped tile.
        if (disposed || gen !== generation || signal.aborted || !wanted.has(key)) return;
        const texture = await decodeImageTexture(bundle.image);
        if (disposed || gen !== generation || signal.aborted || !wanted.has(key)) {
          disposeTileTexture(texture); // aborted pre-upload: the close hook never fired
          return;
        }
        // T2-119 (atomic layout swap): while a condemned backdrop is still drawn,
        // HOLD this bind instead of migrating the new layout's sharp cells over the
        // old coarse backdrop (the reported double-layout). The staged bind flushes
        // to cells.ts atomically when the backdrop releases (flushStaged). With NO
        // backdrop (first activation / same-layout re-stream) it binds immediately —
        // zero behaviour change outside the switch window.
        if (condemned.length > 0) {
          staged.set(key, { ref, texture, buffers: bundle.cells });
        } else {
          // Bind the tile's mini-atlas texture, THEN apply its cells: cells.ts binds
          // a bucket keyed `${z}:${page}` and migrates this tile's cells onto it.
          cells.setAtlasTexture(ref.z, page, texture, false);
          cells.setBuffers(bundle.cells);
          active.set(key, { ref, texture, overviewMesh: null, buffers: bundle.cells, lastUsed: ++clock });
        }
        retryAttempts.delete(key); // a successful load clears the failure budget
        recordTileRead(key, true); // ...and counts toward "images ARE loading" (P3)
      } else {
        // Coarse (overview) tile: keep the decoded ImageBitmap drawable so the minimap
        // (coarseOverview → paintOverview) can draw it — a small bounded set.
        const texture = await decodeImageTexture(body, true);
        if (disposed || gen !== generation || signal.aborted || !wanted.has(key)) {
          disposeTileTexture(texture); // coarse: close the kept-open ImageBitmap too
          return;
        }
        retryAttempts.delete(key); // a successful decode clears the failure budget
        recordTileRead(key, true); // ...and counts toward "images ARE loading" (P3)
        if (condemned.length > 0) {
          // T2-119 (atomic layout swap): while the condemned backdrop is drawn, do NOT
          // scene.add this new coarse mosaic — its (transparent-padded) quad would
          // composite OVER the old backdrop at the same z=-1 plane (the double-layout,
          // visible through the sparse gaps). STAGE it (buffers null ⇒ a coarse bind)
          // and mark the floor key SETTLED; it flushes to a drawOverview mesh atomically
          // when the backdrop releases (flushStaged). settleCoarseFloor re-checks the
          // release condition, so the LAST floor key to settle triggers the flip here.
          staged.set(key, { ref, texture, buffers: null });
          settleCoarseFloor(key);
        } else {
          // No backdrop (first activation / same-layout re-stream): bind immediately —
          // zero behaviour change outside the switch window.
          const mesh = drawOverview(ref, texture);
          active.set(key, { ref, texture, overviewMesh: mesh, buffers: null, lastUsed: ++clock });
        }
      }
    } catch (err) {
      // An ABORT (supersede / generation bump / teardown) is NOT a failure — never
      // retry it (the abort/generation/wanted checks above already dropped the load
      // silently). A genuine non-abort failure that this generation STILL wants gets
      // a bounded backoff retry (T2-44), so a transient blip self-heals on a still
      // camera instead of leaving a hole until the next gesture.
      //
      // T2-09 residual (D-i addendum) interplay: a stale-tab 401 is NOT handled
      // here — the range Source (pmtilesClient) intercepts a 401, does a
      // single-flight credential refresh (one manifest re-open re-issues the
      // `viz_ds` cookie), and retries the read ONCE, all BEFORE any error reaches
      // this catch. So the common expiry case binds transparently and spends ZERO
      // of the T2-44 backoff budget. Only a 401 that PERSISTS after a fresh refresh
      // (revoked access / wrong dataset / server trouble) — or one the refresh
      // cooldown declined — surfaces here, and it correctly takes the SAME bounded
      // backoff as any other transient failure (then rests on the never-grey coarse
      // floor). No loop: the refresh cooldown (30s) exceeds the whole T2-44 retry
      // budget (~7s), so the refresh fires at most once per expiry, never per retry.
      if (!isAbortError(err) && !signal.aborted) {
        console.error(`[tilePyramid] tile ${key} failed to load`, err);
        // Every failed read counts, including the ones a retry will re-issue (P3): the
        // signal is about whether images are landing, not about whether a KEY has
        // exhausted its ladder — the case it exists for never reaches the cap at all.
        recordTileRead(key, false);
        if (!disposed && gen === generation && wanted.has(key)) scheduleRetry(ref, key, gen, errText(err));
      }
    } finally {
      // Only clear our own entry: a generation bump may have cleared inflight and a
      // fresh load re-registered this key under a different controller.
      if (inflight.get(key) === ac) inflight.delete(key);
      // This load just left `inflight` (bound, missed, superseded, or aborted). If
      // it was the last in-flight wanted tile covering a RETAINED ancestor, that
      // ancestor is now fully replaced and must demote — even on a still camera
      // (no streamView will run). Re-run the retain sweep against the drained
      // in-flight set. Guarded on !disposed so a late resolution after teardown
      // does not touch cells/scene (freeActive already ran).
      if (!disposed && layoutEntry !== null) sweepRetainedCoverage();
      // Reflect the new residency / in-flight counts in the debug overlay even
      // though no camera change ran streamView: tiles bind asynchronously AFTER the
      // view settled, so without this the overlay's resident/loading readout lags
      // until the next pan (#34). DEV-gated + DOM-only inside the helper.
      publishResidencyDebug();
    }
  }

  /** Refresh the DYNAMIC renderer-debug counts (resident tiles per z + in-flight
   *  fetch count) from the live active/inflight maps. streamView owns the
   *  view-level fields (selectedZ/zCap/maxZ); this is called both at the end of
   *  streamView and whenever a tile load settles, so the overlay tracks residency
   *  on a STILL camera (not only on the next camera move). DEV-gated; no GPU cost. */
  function publishResidencyDebug(): void {
    if (!vizDebugAvailable) return;
    const byZ: Record<number, number> = {};
    for (const t of active.values()) byZ[t.ref.z] = (byZ[t.ref.z] ?? 0) + 1;
    // Condemned old-layout coarse tiles are still DRAWN (the switch backdrop), so
    // they count as resident here — this is what lets an external never-blank
    // gate assert the canvas shows something at every instant of a layout switch.
    for (const c of condemned) byZ[c.ref.z] = (byZ[c.ref.z] ?? 0) + 1;
    rendererDebug.residentByZ = byZ;
    rendererDebug.loadingTiles = inflight.size;
    publishRendererDebug();
  }

  /** Retain-until-covered demotion sweep. Demote every active tile that is NOT in
   *  `wanted` AND is no longer the only renderable coverage for a wanted tile whose
   *  load is still in flight; hold the rest drawn. Runs at the end of each
   *  streamView pass AND whenever an async load binds (so a retained ancestor
   *  demotes the instant its replacements finish, not only on the next camera
   *  move). Returns the number of tiles retained this sweep. See the block comment
   *  at the streamView call site for the coverage rule + the residency bound. */
  function sweepRetainedCoverage(): number {
    // The wanted tiles whose loads are still in flight — the pending coverage the
    // retained tiles are standing in for. Reconstructed from the live `inflight`
    // set (which drains on every bind/miss), so retention can never outlive it.
    const inFlightWanted: TileRef[] = [];
    for (const ref of wantedRefs) if (inflight.has(bucketKeyOf(ref))) inFlightWanted.push(ref);
    let retained = 0;
    for (const [key, t] of [...active.entries()]) {
      if (wanted.has(key)) continue;
      const stillCovering = inFlightWanted.some((w) => bboxesIntersect(t.ref.bbox, w.bbox));
      if (stillCovering) {
        retained++;
        continue; // hold this tile drawn until its replacement(s) bind
      }
      demote(key);
    }
    return retained;
  }

  /** The core streaming pass: for a world `view` at `zoom`, draw the coarse floor
   *  + the visible fine tiles, demote everything else to the cache. `dpr` is the
   *  viewport devicePixelRatio (level selection targets texel≈device-px, so a
   *  HiDPI view picks one level deeper); it defaults to 1 for the no-camera path. */
  function streamView(view: BBox, zoom: number, focal: [number, number], dpr = 1): void {
    if (disposed || layoutEntry === null || archive === null) return;
    // A camera move / layout activation is fresh intent: reset the per-tile retry
    // budgets (T2-44) so a tile that exhausted its retries on a PRIOR view gets a
    // clean slate now that the user re-engaged. The cap only has to hold on a STILL
    // camera (which never reaches here) to prevent an offline tight-loop; an active
    // gesture re-arming is fine (every retry is still ≥1s backed off). Pending
    // backoff timers keep running — a retry mid-flight for a still-wanted tile is
    // not cancelled here (that is abortInflight's job on a supersede).
    retryAttempts.clear();
    // Same window, same reset (R1-05): every key is retryable again, so none of them is
    // terminally failed any more. Keeping the old verdicts would let the FIRST tile to
    // cap on this pass find a `wanted` set still marked failed from the last one and
    // declare the view dead while its siblings were mid-flight.
    failedKeys.clear();
    const lb = layoutBBoxOf(layoutEntry);
    const py = pyramidOf(layoutEntry);
    const z = selectLevel(py, lb, zoom, dpr);
    const visible = enumerateVisibleTiles(layoutId!, lb, z, py.z_cap, view);

    // The coarse mosaic FALLBACK band: the finest coarse level covering the view,
    // kept resident as the always-available floor under the streaming fine cells —
    // so a loading/evicted region degrades to a low-res image (never grey) and a
    // returning region shows something immediately. Only when the selected level
    // is fine AND the dataset baked a coarse band (z_cap >= 1).
    const cz = py.z_cap - 1;
    const coarse =
      z >= py.z_cap && cz >= 0 ? enumerateVisibleTiles(layoutId!, lb, cz, py.z_cap, view) : [];

    // Load the coarse floor FIRST, then the fine tiles focal-first (the region the
    // user is looking at sharpens before the periphery). Focal order is applied
    // WITHIN each tier and the tiers concatenated, so the coarse-before-fine
    // guarantee is never destroyed by a single global distance sort (the v1 bug
    // where a fine child could load before its coarse fallback and a late parent
    // then downgraded the focal cells).
    const order = [...focalOrder(coarse, focal[0], focal[1]), ...focalOrder(visible, focal[0], focal[1])];
    wanted = new Set(order.map(bucketKeyOf));
    wantedRefs = order; // parallel to `wanted`, for the retain-until-covered sweep

    // The coarse tiles this view wants drawn — the fallback band when the
    // selected level is fine, or the visible tiles themselves when it is coarse.
    // When ALL of them are active, a layout-switch backdrop (condemned old-coarse
    // meshes) is fully covered by the new layout and can be released.
    coarseFloorWanted = new Set((z >= py.z_cap ? coarse : visible).map(bucketKeyOf));

    const gen = generation;
    for (const ref of order) ensureActive(ref, gen);

    // Cancel in-flight loads this view no longer wants (a fast pan/zoom superseded
    // them): abort the range fetch now instead of running it to completion only to
    // discard the result at the `wanted` gate. Newly-issued loads above are all
    // wanted, so this only touches genuinely-stale fetches.
    for (const [key, ac] of [...inflight]) {
      if (!wanted.has(key)) {
        ac.abort();
        inflight.delete(key);
      }
    }

    // RETAIN-UNTIL-COVERED demotion (the web-map residency rule; no black flash on
    // zoom). An active tile whose key just left `wanted` is the coverage the user
    // is currently seeing for its region. Demoting it in the SAME pass that only
    // *starts* the async replacement loads (fetch→decode→bind land frames later)
    // is what strands the region as the empty (page-background) canvas until the
    // new tiles bind — the black flash. Instead, sweepRetainedCoverage holds an
    // active tile leaving `wanted` drawn while ANY wanted tile intersecting its
    // footprint is still IN FLIGHT (its load has not yet bound). Uniform across:
    //   * zoom-in  (z→z+1): the deeper children covering the old tile are in
    //     flight → the old tile stays until they all bind, then it demotes;
    //   * zoom-out (z→z-1): the shallower ancestor replacing the old tiles is in
    //     flight → the old deeper tiles stay until it binds;
    //   * coarse→coarse and fine→fine: identical (coarse overview meshes are
    //     `active` too), closing the gap the old single-band `z_cap-1` floor left
    //     for both the fine→fine and the whole coarse→coarse zoom range.
    // The nearest-resident-ancestor fallback (rule B) falls out of this: the tile
    // held is exactly the previous (shallower-or-parent) coverage; the `z_cap-1`
    // coarse floor stays the terminal backstop (it is in `wanted` at every fine
    // level, loaded first, so a still-missing sub-region degrades to the mosaic,
    // never grey/black).
    //
    // BOUNDED (rule D): retention is keyed on the LIVE `inflight` set, which DRAINS
    // — every wanted load resolves (a bind OR a null-body miss) and removes itself
    // from `inflight` in loadTile's finally, and is not re-added; a miss's region
    // then rests on the coarse floor, not on the retained tile forever. The sweep
    // re-runs every streamView pass AND on every async bind (loadTile), so a
    // retained tile demotes the instant the tiles that superseded it finish, even
    // on a still camera. Worst-case transient residency during a continuous z2→z6
    // zoom is the previous view's tiles alongside the new view's (≈ 2× the viewport
    // tile count, a fixed small multiple of the ~3×3 visible block), released
    // within the new tiles' fetch latency — NOT the whole zoom trail (intermediate
    // levels demote as their successors' loads drain). The LRU cache budget /
    // trimCache below are unchanged.
    sweepRetainedCoverage();
    trimCache();

    // Re-check the backdrop release against the (possibly changed) coarse floor: a pan
    // can shrink coarseFloorWanted to keys that ALREADY settled on a prior pass (staged,
    // null-bodied, or failed), so no new settle event fires this pass — the end-of-pass
    // check releases the backdrop in that case. settleCoarseFloor drives the common
    // path as each floor key reaches its outcome.
    maybeReleaseCondemned();

    // Dev-only: publish the level/tier the loader is actually on so the debug
    // overlay can report which z is selected + which levels are resident RIGHT NOW
    // (the v1 LOD fields don't apply to the v2 pyramid). DOM-only, no GPU cost.
    // The view-level fields are set here; the dynamic resident/loading counts are
    // refreshed via publishResidencyDebug (also called on async tile bind/evict).
    if (vizDebugAvailable) {
      const zs = pyramidLevels(py);
      rendererDebug.selectedZ = z;
      rendererDebug.zCap = py.z_cap;
      rendererDebug.maxZ = zs[zs.length - 1];
      publishResidencyDebug();
    }
  }

  function refresh(state: CameraState, viewport: Viewport): void {
    if (disposed || layoutEntry === null || archive === null) return;
    const view = bboxFromCamera(state, viewport);
    const focalX = state.focal?.[0] ?? (view.xMin + view.xMax) / 2;
    const focalY = state.focal?.[1] ?? (view.yMin + view.yMax) / 2;
    // Pass the viewport dpr so level selection targets device (not CSS) pixels on
    // a HiDPI canvas (world.ts renders at setPixelRatio(vp.devicePixelRatio)).
    streamView(view, state.zoom, [focalX, focalY], viewport.devicePixelRatio);
  }

  // ---- camera subscription ----
  // Track the latest camera so context-loss recovery can re-issue the visible
  // tile loads for the SAME view without waiting for the next input event.
  let lastState: CameraState | null = null;
  let lastViewport: Viewport | null = null;

  // PERF: coalesce refresh to at most ONCE PER ANIMATION FRAME. world.onCameraChange
  // fires synchronously on every raw pointermove/wheel (60-120+/s on a high-Hz
  // device); running the full streamView (enumerate + focal-sort + Set-build +
  // ensureActive over hundreds of tiles) on every one of those events is the
  // dominant pan/zoom jank. Instead we record the latest camera and schedule a
  // single refresh on the next frame. The GL-free loader tests have no
  // requestAnimationFrame, so we fall back to a synchronous call there — which
  // preserves their existing "emit -> refresh ran by the next await" contract.
  //
  // NOTE (hidden tab): rAF is paused while the tab is backgrounded, so a camera
  // change that arrived while hidden would defer its refresh to the next foreground
  // frame. That never strands a live view: camera changes come from pointer/wheel
  // input (which requires a visible tab), and the context-restore path calls
  // refresh() directly rather than through this scheduler.
  const hasRaf = typeof globalThis.requestAnimationFrame === "function";
  let rafHandle: number | null = null;
  let refreshScheduled = false;
  // Seam R2 P2, site 1. `streamView` throwing synchronously — a NaN focal from a
  // degenerate bbox, a malformed pyramid entry, a cells bucket that has gone — is the
  // loader's likeliest silent death: `rafHandle`/`refreshScheduled` are cleared BEFORE
  // the call, so the next camera event re-arms it and it throws once per frame of
  // movement, forever, while `renderer.render` keeps succeeding and health stays `ready`.
  //
  // The GUARDED callable is what gets scheduled, so the latch reaches every re-arm — and
  // the guard does not re-throw, because `world.onCameraChange`'s emit is a bare
  // `for (const cb of callbacks) cb(...)`: a throw there aborts every LATER camera
  // subscriber (the status observable, the minimap viewport box), which is the same
  // silence one level up. `tile-stream-failed`, not `render-loop-failed`: whatever is
  // already bound still draws, so this is the view's failure, not the stack's.
  //
  // The latch is RELEASED by the three things that repair this site — a restored context,
  // a (re-)activated layout, an explicit re-stream. Without that, panning while the
  // context was lost (which `onContextLost` does NOT stop: it never unsubscribes the
  // camera) threw against the buckets the loss had just stripped, latched, and had its
  // report DROPPED by precedence — leaving the loader deaf to the camera for the life of
  // the page even after the restore repaired everything.
  const streamGuard = guardScheduledWork({
    work: () => {
      if (lastState !== null && lastViewport !== null) refresh(lastState, lastViewport);
    },
    code: "tile-stream-failed",
    fail: (failure) => health?.fail(failure),
  });
  // The scheduler's own bookkeeping is cleared OUTSIDE the guard: a latched site must
  // still release `refreshScheduled`, or `scheduleRefresh` wedges on its own flag and no
  // amount of resetting the guard could bring the site back.
  function runRefresh(): void {
    rafHandle = null;
    refreshScheduled = false;
    streamGuard();
  }
  function scheduleRefresh(): void {
    if (refreshScheduled) return;
    refreshScheduled = true;
    // no rAF (node unit tests) -> run synchronously, one refresh per emit.
    if (hasRaf) rafHandle = globalThis.requestAnimationFrame(runRefresh);
    else runRefresh();
  }
  // Cancel a frame scheduled but not yet run — called on dispose so no stray refresh
  // fires after teardown and the frame callback is released promptly. refresh() also
  // early-returns when `disposed`, so dropping the callback is belt-and-suspenders.
  // rafHandle is only ever set on the hasRaf path, so cancelAnimationFrame is present
  // whenever the handle is non-null.
  function cancelScheduledRefresh(): void {
    if (rafHandle !== null) globalThis.cancelAnimationFrame(rafHandle);
    rafHandle = null;
    refreshScheduled = false;
  }

  world.onCameraChange((state, viewport) => {
    lastState = state;
    lastViewport = viewport;
    scheduleRefresh();
  });

  // ---- lifecycle: teardown + in-place WebGL context-loss recovery ----
  // The renderer-internal WorldHandle surface (onDispose / halt+resume render
  // loop) is what the catalogue `World` hides; ViewerScreen always passes the
  // concrete WorldHandle from createWorld, so this cast is sound. A GL-free test
  // double may omit onDispose / renderer.domElement — the registration below is
  // guarded so construction stays robust against a minimal stub.
  const worldH = world as Partial<WorldHandle> & World;
  const canvasEl = (world.renderer as { domElement?: HTMLCanvasElement }).domElement ?? null;
  let restoreWatchdog: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (restoreWatchdog !== null) {
      clearTimeout(restoreWatchdog);
      restoreWatchdog = null;
    }
  }

  function onContextLost(event: Event): void {
    // preventDefault() is REQUIRED for the browser to subsequently fire
    // `webglcontextrestored`; without it the context is gone for good.
    event.preventDefault();
    // Seam R2 P2: a FRESH loss is a fresh episode, so the restore handler gets to try
    // again. Without this one bad restore makes every later one a silent no-op for the
    // life of the loader.
    guardedRestore.reset();
    worldH.haltRenderLoop?.();
    // Drop the dead GPU handles: every resident/cached tile's texture upload is
    // gone. bumpGeneration() aborts in-flight loads + invalidates stale responses.
    // freeActive(dropCells:false) keeps the cells' buckets + positions (so the
    // VIEW is preserved); cells.handleContextRestored resets their bindings on
    // restore. The cache is dropped (its textures are dead too), as is any
    // layout-switch backdrop (its texture uploads are equally dead).
    bumpGeneration();
    freeActive({ dropCells: false });
    freeCache();
    disposeCondemned();
    // Publish the handled-loss event so an external diagnostic can confirm the
    // halt→recovery path engaged (the browser cannot read world's `running` flag,
    // and residentByZ is not re-published on loss). Read-only, DEV-gated.
    if (vizDebugAvailable) {
      rendererDebug.contextLosses += 1;
      publishRendererDebug();
    }
    // Arm the unrecoverable watchdog: if no restore arrives, prompt a reload
    // instead of leaving the user on a halted, grey canvas.
    clearWatchdog();
    restoreWatchdog = setTimeout(() => {
      restoreWatchdog = null;
      if (!disposed && onUnrecoverable !== undefined) onUnrecoverable();
    }, CONTEXT_RESTORE_TIMEOUT_MS);
  }

  function onContextRestored(): void {
    clearWatchdog();
    if (disposed) return;
    // Seam R2 P2: the bindings this repairs are exactly what a pan during the loss threw
    // against, so this is where the stream guard's latch is released.
    streamGuard.reset();
    // Three r0.169 re-creates the GL context itself; we own only texture
    // residency. Reset cells' texture bindings (uAtlas=null/uHasTex=0, buckets +
    // positions kept), resume the loop, then refresh the SAME view so the visible
    // tiles re-fetch + re-bind — the view is preserved, only textures repopulate.
    cellsH.handleContextRestored?.();
    worldH.resumeRenderLoop?.();
    if (lastState !== null && lastViewport !== null) refresh(lastState, lastViewport);
  }

  // Seam R2 P2, site 2. The restore handler resets the cells' texture bindings, resumes
  // the render loop and re-streams the held view; a throw in any of those leaves a live
  // context nothing is drawing into, and an exception in a DOM listener goes nowhere.
  // `context-restore-failed`, not the view's code: the context came back and the loader
  // could not rebind to it, which only a rebuilt stack can re-attempt. An event listener
  // re-arms nothing, so the latch alone stops a repeat of the SAME restore — and
  // `onContextLost` releases it, because a fresh loss is a fresh episode.
  const guardedRestore = guardScheduledWork({
    work: onContextRestored,
    code: "context-restore-failed",
    fail: (failure) => health?.fail(failure),
  });
  if (canvasEl !== null) {
    canvasEl.addEventListener("webglcontextlost", onContextLost, false);
    canvasEl.addEventListener("webglcontextrestored", guardedRestore, false);
  }

  worldH.onDispose?.(() => {
    disposed = true;
    abortInflight(); // cancel streaming tile loads
    clearWatchdog();
    cancelScheduledRefresh(); // drop a coalesced refresh scheduled but not yet run
    // P3: no verdict after teardown — and RETRACT the one standing, because
    // `armFailureWindow` refuses to re-arm once disposed, so a `true` left here could
    // never be moved again by anything.
    if (failureWindow !== null) {
      clearTimeout(failureWindow);
      failureWindow = null;
    }
    failingKeys.clear();
    landedKeys.clear();
    windowSawFailedRead = false;
    windowSawAnyRead = false;
    publishTilesFailing(false);
    if (canvasEl !== null) {
      canvasEl.removeEventListener("webglcontextlost", onContextLost, false);
      // The GUARDED wrapper is what was registered — removing `onContextRestored` here
      // would leave the real listener attached to a torn-down loader.
      canvasEl.removeEventListener("webglcontextrestored", guardedRestore, false);
    }
    // cells.dispose() (called by ViewerScreen before world.dispose()) owns the
    // bucket teardown, so we only dispose the textures + remove overview meshes.
    freeActive({ dropCells: false });
    freeCache();
    disposeCondemned(); // release a pending layout-switch backdrop + its watchdog
    archives.clear(); // drop the per-layout PMTiles handles (plain fetch wrappers)
    bundleDecoder.terminate(); // stop the decode worker + reject any in-flight decode
  });

  // One opened PyramidArchive per layout URL, kept for the loader's lifetime, so
  // toggling back to a layout reuses the already-fetched PMTiles header/root
  // directory instead of re-reading it on every switch. The container URL embeds
  // the dataset version (immutable), so a cached handle can never go stale.
  // SYNCHRONOUS by design (H1): activateLayout must set its layout state and
  // archive without an intervening await, so a camera event landing mid-switch
  // can only ever stream the NEW layout's tiles.
  const archives = new Map<string, PyramidArchive>();
  function openArchiveFor(entry: LayoutEntry): void {
    const dsId = activeManifest.dataset_id;
    const url = client.pyramidUrl(dsId, entry.layout_id);
    let handle = archives.get(url);
    if (handle === undefined) {
      // T2-09 residual (D-i addendum): the range Source calls this on a 401 (the
      // stale-tab `viz_ds` cookie expired) to re-issue the cookie via ONE manifest
      // re-open, then retries the read once. Single-flight + cooldown live in the
      // client, so a whole viewport of tiles expiring together shares one refresh.
      // The client is a capability the loader already holds (no cross-layer import
      // — AGENT_GUIDE: renderer modules never import UI/api-client concretely).
      const refreshCredential = (): Promise<boolean> => client.refreshDatasetCredential(dsId);
      handle = openArchive(url, authHeaders, refreshCredential);
      archives.set(url, handle);
    }
    archive = handle;
  }

  return {
    get manifest(): LayoutManifest {
      return activeManifest;
    },

    activeLayoutId(): string | null {
      return layoutId;
    },

    onCameraChange(state: CameraState, viewport: Viewport): void {
      // Through the guard, not straight to `refresh` — see the interface docblock.
      lastState = state;
      lastViewport = viewport;
      streamGuard();
    },

    setViewFailureListener(cb: (layoutId: string, detail: string) => void): void {
      viewFailureListener = cb;
    },

    setTilesFailingListener(cb: (failing: boolean) => void): void {
      failingListener = cb;
    },

    tilesFailing(): boolean {
      return tilesFailingNow;
    },

    restreamView(): void {
      // The same re-issue the context-restore path makes (onContextRestored): the view
      // is unchanged, only the tiles need fetching again. `refresh` re-derives the level
      // and the wanted set from the held camera and streamView clears the retry budgets,
      // so the tiles that gave up at their cap are requested afresh.
      //
      // Seam R2 P2: this IS "Retry this view", the action `tile-stream-failed` offers, so
      // it releases the latch first — and then goes THROUGH the guard. Calling `refresh`
      // directly bypassed the latch, so the view re-streamed once and was dead again on
      // the next pan, and a second throw escaped into the click that asked for the retry.
      streamGuard.reset();
      streamGuard();
    },

    async activateLayout(next: LayoutManifest, id: string, frame: BBox | null): Promise<void> {
      const entry = next.layouts.find((l) => l.layout_id === id);
      if (entry === undefined) throw new Error(`tilePyramid: layout '${id}' is not in the manifest`);
      // Seam R2 P2: a new view is a new subject for the stream guard. `tile-stream-failed`
      // is cleared by `failureResolvedBySwitch` on a successful switch, so without this
      // the switch would erase the alert over a loader that stayed deaf.
      streamGuard.reset();
      bumpGeneration();
      // A layout switch invalidates the previous layout's tiles: its tile
      // addresses index a different PMTiles container. The old FINE cells are
      // dropped immediately (their cells.ts buckets are reclaimed before the new
      // layout binds fresh tiles at the same `${z}:${page}` keys) and the old
      // layout's cache is cleared — but the old COARSE overview meshes are NOT
      // freed yet: they move to the `condemned` backdrop and keep drawing until
      // the new view's coarse floor has SETTLED (or the watchdog fires), so the
      // switch never shows a blank canvas. The new layout's COARSE and FINE binds
      // are STAGED behind that backdrop (loadTile) and flushed atomically when it
      // releases (T2-119), so the sharp new cells / new mosaic never draw over the
      // old backdrop. Loader-map collisions are impossible: active/cache/inflight
      // keys embed the layout id.
      //
      // BACKDROP TRANSFER (rapid double-switch A→B→C): the outgoing coarse is
      // condemnable only if it is BOUND in `active`, but the incoming layout's coarse
      // STAGES behind the backdrop (above) — so a switch arriving BEFORE the previous
      // switch's floor settled finds NO coarse in `active` to condemn (B's coarse was
      // staged, and the bumpGeneration → dropStaged above just dropped it) while an old
      // backdrop is STILL drawn. Disposing it here would strand the new target with no
      // floor and flash a BLANK during its cold coarse fetch. So decide retain-vs-dispose
      // BEFORE disposeCondemned: peek whether any outgoing coarse is bound; when there is
      // NONE to condemn AND a backdrop is up, TRANSFER it (retain the meshes + restart the
      // watchdog + re-key the settle ledger) instead of disposing. The normal single
      // switch (outgoing coarse bound) and the cold start (nothing drawn) are unchanged.
      const hasCoarseToCondemn = [...active.values()].some(
        (t) => t.overviewMesh !== null && t.ref.layoutId !== id,
      );
      const transferBackdrop = !hasCoarseToCondemn && condemned.length > 0;
      if (!transferBackdrop) disposeCondemned(); // dispose a stale backdrop (normal) / no-op (cold)
      freeActive({ dropCells: true }, (t) => t.ref.layoutId !== id && t.ref.fine);
      if (transferBackdrop) transferCondemnedBackdrop(); // rapid double-switch: keep the backdrop up
      else condemnOldCoarse(id); // normal: condemn the outgoing coarse + arm the watchdog
      freeCache((c) => c.ref.layoutId !== id);
      activeManifest = next;
      // Layout state + archive are set SYNCHRONOUSLY — no await anywhere in this
      // function (H1) — so a camera event landing mid-switch enumerates and
      // streams the NEW layout only; a stale in-flight old-layout response is
      // already dropped by the generation bump above.
      layoutId = id;
      layoutEntry = entry;
      openArchiveFor(entry);
      if (frame !== null) {
        // Initial stream. Prefer the LIVE camera via the proven `refresh` path: the
        // world immediate-emits the fit camera at construction, so lastState/
        // lastViewport are populated before this first activate. refresh derives
        // BOTH the view rect and the zoom from that ONE camera state, so it (a)
        // selects the FIT-VIEW level — e.g. ~z2 on a 1280px viewport — instead of
        // the coarsest (the "initial open is over-coarse" bug: the synthesized
        // frameEdge/tile_px zoom below pins any full-extent frame to
        // idealTilesPerAxis==1 => z0), and (b) bounds enumeration to what is
        // actually on screen. NB enumerating the passed FULL-EXTENT `frame` with a
        // separately-sourced live zoom would fan out the ENTIRE deep level if a
        // wheel event deepened the camera during the awaited manifest fetch —
        // refresh avoids that by taking the view from the same state as the zoom.
        // Fall back to the synthesized coarse frame only when no camera has emitted
        // (the GL-free loader tests drive activate with no world emit). This
        // no-camera branch is a dev↔prod divergence — production always has a live
        // camera (the World immediate-emits on subscribe), so only the stub omits
        // it; slated for removal with the `frame` param once the test stub honors
        // that contract. See phase1-plan.md §4 "Merge dev ↔ prod".
        if (lastState !== null && lastViewport !== null) {
          refresh(lastState, lastViewport);
        } else {
          const py = pyramidOf(entry);
          const frameEdge = Math.max(frame.xMax - frame.xMin, frame.yMax - frame.yMin);
          const frameZoom = frameEdge / py.tile_px || 1e-9;
          streamView(frame, frameZoom, [(frame.xMin + frame.xMax) / 2, (frame.yMin + frame.yMax) / 2]);
        }
      }
    },

    beginLayoutSwitch(): void {
      bumpGeneration();
    },

    residentTileCount(): number {
      return active.size;
    },

    loadingTileCount(): number {
      return inflight.size;
    },

    coarseOverview(): CoarseOverview | null {
      if (layoutEntry === null) return null;
      const layoutBBox = layoutBBoxOf(layoutEntry);
      const tiles: { bbox: BBox; image: CanvasImageSource }[] = [];
      // The resident COARSE tiles carry a standalone overview mesh (fine tiles feed
      // cells.ts buckets and have no mesh). Their decoded texture.image is the mosaic
      // ImageBitmap — a valid CanvasImageSource the minimap draws directly. A texture
      // whose source isn't yet a drawable image (defensive) is skipped.
      for (const t of active.values()) {
        if (t.overviewMesh === null) continue;
        const image = t.texture.image as unknown;
        if (isDrawableImage(image)) tiles.push({ bbox: t.ref.bbox, image });
      }
      return { layoutBBox, tiles };
    },
  };
}

/** True when a texture's `.image` is something a 2D canvas `drawImage` accepts — an
 *  ImageBitmap (the loader's decode output) or an HTML image/canvas element. Guards
 *  the minimap snapshot against a texture whose source is a raw pixel buffer or not
 *  yet populated. */
function isDrawableImage(image: unknown): image is CanvasImageSource {
  if (image === null || image === undefined) return false;
  if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) return true;
  if (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) return true;
  if (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement) return true;
  return false;
}
