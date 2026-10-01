// T2-26 — the renderer DETAIL OVERLAY (spike docs/spikes/spike_detail_tier_render.md,
// recommendation O3). Past a screen-space cell-size threshold, fetch each visible
// cell's already-baked detail original (`detail/v{N}/{id}.webp`, an aspect-preserving
// WebP capped at 2048px) and draw it as an individually-textured quad ON TOP of the
// cell, so images keep sharpening as the user zooms in — while the pyramid keeps
// rendering beneath it untouched.
//
// It is PURELY ADDITIVE (this is the load-bearing property): deleting this module's
// wiring restores today's rendering byte-for-byte. It never touches the tile
// residency, the coarse floor, or any existing texture cache; a missing / failed /
// aborted detail fetch leaves the 64px pyramid cell rendering exactly as before.
//
// Bounded by construction, four ways:
//   * a GATE — engage only when the cells IN VIEW are big enough on screen to be blurry
//     (the upper median of their widths in the active layout's position table / zoom ×
//     dpr ≥ engageCellPx) AND few enough cells are in view. An O(1) short cut runs before
//     that scan: the table's largest width, found once when the table binds, bounds any
//     in-view median, so while even it is under the threshold no position row is read.
//     The short cut is only as good as that bound: it assumes the largest width is close
//     to the median (measured 2026-09-29 over 30 layouts: largest ÷ median ≤ 1.7). One
//     outsized cell would keep it from firing, and every zoomed-out refresh would then scan
//     the table with nothing to say so. Since the scan stops at the in-view cap + 1 (#409),
//     that costs little when the in-view cells come early in id order (a whole-table view:
//     0.21 ms on 1,010,469 rows, measured on #409) and up to a full pass when they come late. A view with NO candidates (a gap wider than the view)
//     holds the gate's state rather than releasing it: an empty view is not evidence that
//     cells are small. The gate reads the table, not the cells the pyramid has bound, because
//     binding happens with no camera event to re-run the gate, and a layout switch keeps
//     the old layout's tiles bound until the new ones cover them;
//   * a FETCH QUEUE — at most maxInFlight detail fetches at once, first fetches and rung
//     upgrades together. Each engaged refresh keeps its in-view candidates, nearest the
//     focal point first, as the REFILL list; when a fetch settles or a backoff timer fires,
//     the refill starts the next cells on that list at once, so the view keeps loading on
//     a still camera. If the camera or the context changed since the list was built, the
//     refill waits: the refresh already scheduled rebuilds the list and fills the free
//     slots. Liveness, PROVIDED every fetch settles (there is no fetch timeout, so a
//     request that stalls holds its slot until the camera moves it out of view): on a
//     still camera every candidate at or above the per-cell floor ends drawn (at its target
//     rung, or its natural ceiling), 404-skipped, or out of retries — none is left idle.
//     After that: a 404 cell is never fetched again; a drawn cell is fetched again only for
//     a sharper rung; an OUT-OF-RETRIES cell is not fetched again until the next camera or
//     context change, and then it gets exactly one fetch (the retry budget is not reset by
//     a camera move, only by a release);
//   * DECODE-TO-NEED — each detail image reaches the GPU at the rung its cell needs on
//     screen now (a decode-rung ladder), not the 2048px file. A cell that gets bigger is
//     re-decoded UP a rung; one that gets smaller is re-decoded DOWN to its target rung once
//     its texture is above even `rungFor(px × engageCellPx / releaseCellPx)` (the gate's own
//     hysteresis ratio: a 2048 texture is kept down to 768 device px). A step-down re-reads
//     the same immutable-cached file, keeps the larger texture drawn until the smaller one
//     is decoded, and starts only when no blurry cell (a first fetch or an upgrade) wants the
//     slot. One the camera has since zoomed back in past is aborted, or discarded if it
//     lands first, so a cell is never left below its target. So the drawn set follows the
//     current zoom: see textureBudgetBytes for the measured figures. Its cost: each
//     step-down is a full-size decode of the original (up to 16 MiB of RGBA for a 2048 px
//     image, transiently) and, on a browser-cache miss, a second download of it; per-rung
//     baked files would remove both (T2-100, T2-a-still-deep-zoom-view-downloads-every-in-view);
//   * an own byte-budgeted LRU of decoded textures, keyed by (dataset, version,
//     cellId) so it SURVIVES layout switches (cell ids are layout-invariant — this
//     is a feature). It never evicts a drawn quad, and its budget counts only the
//     recently-left textures (see textureBudgetBytes).
//
// Fetches ride the DB-free static Caddy edge (`client.staticDetailUrl`, the `viz_ds`
// cookie, immutable cache) with the same single-flight 401→refresh→retry-once dance
// the pyramid range Source uses — NOT the per-request-SQLite authed API detail route,
// which is fine for one click but wrong for a viewport-sized burst.
//
// A renderer module (beside tilePyramid.ts / cells.ts): it never imports React/UI
// (module-map rule 4) and consumes only the api-client URL/auth helpers. It is
// created + driven by layout.ts (the LayoutController pushes the active manifest +
// position table); its per-frame work runs off its OWN camera subscription (coalesced
// to one refresh per animation frame, like the loader), and it self-tears-down on the
// World's dispose (symmetric with the tile-pyramid loader).
import * as THREE from "three";
import type { ApiClient } from "../api-client/client.ts";
import type { CellCandidate, PositionTable } from "./cells.ts";
import { scanPositionsInView } from "./cells.ts";
import type { DetailDescriptor, LayoutManifest } from "./layout.ts";
import type { CameraState, Viewport, World, WorldHandle } from "./world.ts";
import { bboxFromCamera, MAX_DPR_FOR_LEVEL, RETRY_ATTEMPT_BACKOFF_MS } from "./tilePyramid.ts";
import { rendererDebug, publishRendererDebug, vizDebugAvailable } from "./debug.ts";

// ---------------------------------------------------------------------------
// Config (ONE runtime-mutable object — the T2-101 settings-panel scaffolding)
// ---------------------------------------------------------------------------

/** All of the overlay's thresholds and budgets in one place, runtime-mutable so a
 *  future settings panel (T2-101) can adjust them live. Decided 2026-07-10: the
 *  adjustability ships as scaffolding now; the exposed default is these constants. */
export interface DetailOverlayConfig {
  /** Engage when the in-view cells' on-screen size (the upper median of their world
   *  widths / zoom × dpr) reaches this many CSS px (decided 2026-07-10: 128 ≈ 2×
   *  magnification of the 64px thumb — acceptable, before it softens). */
  engageCellPx: number;
  /** Disengage below this (hysteresis, so a jittering zoom does not flap). */
  releaseCellPx: number;
  /** Hard skip: never engage while more than this many cells are in view (dense
   *  scatter piles at high magnification stay on the pyramid; bounds the burst). */
  maxOverlayCells: number;
  /** Byte ceiling for the recently-LEFT textures: decoded textures whose quad is no longer
   *  drawn, kept for an instant pan-back / re-engage. Only those count against it. A
   *  currently-DRAWN quad is never evicted (that would blank an on-screen cell) and does
   *  not count, so live overlay VRAM = the drawn quads + up to this many bytes of
   *  recently-left textures. Counting the drawn quads against this budget as well (the code
   *  until the PR #409 review) let a full view evict its own pan-back cache: measured on #409
   *  with this default and two 350-cell views, 34 of 350 left textures survived and the pan
   *  back re-fetched 316.
   *
   *  The DRAWN set is bounded by the in-view cap (maxOverlayCells) in count, and by
   *  decode-to-need in size: each drawn texture is at the rung its cell needs at the current
   *  zoom, because a texture above even the hysteresis band steps down (see needsStepDown).
   *  Measured through this overlay, 1920×1080 CSS px at dpr 2, square 2048 px originals:
   *      cell 80 CSS px: 375 drawn, 94 MiB · 129 px: 135, 135 MiB · 258 px: 45, 180 MiB ·
   *      515 px: 15, 240 MiB (one emit on a fresh overlay; the PR #409 re-review).
   *  A zoom in to 515 px and back out gives the same 240 → 180 → 135 → 94 MiB (measured on the
   *  step-down PR with the re-review's instrument); before the step-down, textures never went
   *  back down a rung and the same path grew to 240 → 360 → 450 → 510 MiB. Inside the
   *  hysteresis band a drawn texture can stay one rung above its target (2048 held down to
   *  768 device px) for as long as the zoom stays there: up to 4× the bytes a fresh load
   *  would give that cell. This cache adds up to its budget on top. A 3:2 image scales the figures by about ×0.67. (The
   *  spike's §4.4 put the overlay at ~33 MB at the gate on 1080p; its ~136 MB is the TILE
   *  PYRAMID's per-view demand, S2/S3.) */
  textureBudgetBytes: number;
  /** Entry-count ceiling for the recently-left textures (alongside the byte budget). Drawn
   *  quads do not count against it either. */
  maxEntries: number;
  /** Concurrent detail fetches, first fetches and rung upgrades together (like the
   *  loader's inflight cap). It bounds the BURST — a deep zoom or a fast pan never queues
   *  every cell it crosses — not how much of the view loads: on a still camera the refill
   *  tops it up as each fetch settles, until every in-view cell is done. */
  maxInFlight: number;
  /** Fade-in duration for a newly-appearing overlay quad (ms; avoids a hard pop). */
  fadeMs: number;
}

export const DEFAULT_DETAIL_OVERLAY_CONFIG: DetailOverlayConfig = {
  engageCellPx: 128,
  releaseCellPx: 96,
  maxOverlayCells: 400,
  textureBudgetBytes: 96 * 1024 * 1024,
  maxEntries: 512,
  maxInFlight: 12,
  fadeMs: 150,
};

/** Explicit transparent draw order for the overlay quads. THREE sorts transparent
 *  objects by `renderOrder` FIRST, then by distance — so a value above the default
 *  0 (which the coarse overview meshes and the fine cell meshes both keep) guarantees
 *  the overlay draws ON TOP of them regardless of the distance sort. This is the
 *  explicit layering decision the spike requires for the new layer; the existing
 *  coarse-behind-cells order (both at renderOrder 0) is untouched — editing those
 *  meshes would violate the additive mandate and sit outside this seam's file set. */
export const RENDER_ORDER_OVERLAY = 2;

/** Decode-rung ladder (max-edge px). A cell's detail image is decoded to the smallest
 *  rung that covers its on-screen size, so the 2048px file never reaches the GPU
 *  bigger than needed; re-decoded up a rung when zoom-in crosses the next threshold
 *  (the HTTP response is immutable-cached, so the re-fetch is cheap). Kept in one
 *  place — T2-100 will later map rungs to distinct baked files. */
export const DETAIL_RUNGS = [256, 512, 1024, 2048] as const;

// ---------------------------------------------------------------------------
// Pure helpers (GL-free; unit-tested directly)
// ---------------------------------------------------------------------------

/** The engage/release gate with hysteresis. `enabled` folds in "has an image_ref
 *  detail tier AND a position table" (both are structural prerequisites — no table ⇒
 *  no per-cell rects to place; no detail tier ⇒ nothing to fetch). Above the in-view
 *  cap the overlay is hard-skipped regardless of cell size. Otherwise it engages at
 *  `engageCellPx` and holds until below `releaseCellPx`. Pure + exported for tests. */
export function detailGateEngaged(
  prevEngaged: boolean,
  cellScreenPx: number,
  cellsInView: number,
  enabled: boolean,
  config: DetailOverlayConfig,
): boolean {
  if (!enabled) return false;
  if (cellsInView > config.maxOverlayCells) return false; // dense pile → stay on the pyramid
  const threshold = prevEngaged ? config.releaseCellPx : config.engageCellPx;
  return cellScreenPx >= threshold;
}

/** Smallest decode rung (DETAIL_RUNGS) that covers `px` on-screen pixels, capped at
 *  the coarsest baked cap (2048). Pure + exported for tests. */
export function rungFor(px: number): number {
  for (const r of DETAIL_RUNGS) if (px <= r) return r;
  return DETAIL_RUNGS[DETAIL_RUNGS.length - 1];
}

/** Cover-crop UV rect (in [0,1]²) that shows the centered SQUARE of a detail image of
 *  aspect `imgAspect` (= width/height) — reproducing the pipeline's
 *  `thumbnail(crop="centre")` square center-crop, so the overlay shows exactly the
 *  same framing as the 64px thumb beneath and nothing reflows as sharpness fades in.
 *  The quad then stretches that square to the cell's w×h just as the thumb does. Pure
 *  + exported for tests. */
export function coverCropUvs(imgAspect: number): { uMin: number; uMax: number; vMin: number; vMax: number } {
  if (!Number.isFinite(imgAspect) || imgAspect <= 0) return { uMin: 0, uMax: 1, vMin: 0, vMax: 1 };
  if (imgAspect >= 1) {
    // Wider than tall: crop the width to a square, keep full height.
    const span = 1 / imgAspect;
    const min = (1 - span) / 2;
    return { uMin: min, uMax: min + span, vMin: 0, vMax: 1 };
  }
  // Taller than wide: crop the height to a square, keep full width.
  const span = imgAspect;
  const min = (1 - span) / 2;
  return { uMin: 0, uMax: 1, vMin: min, vMax: min + span };
}

/** CSS-px screen distance under which two cells are treated as COINCIDENT (a pile) by the
 *  overlay's de-dup — small enough that only cells at essentially the same screen point merge,
 *  so a normal scatter cloud that resolves apart on zoom is never collapsed. The world-unit
 *  merge grid is `COINCIDENCE_MERGE_PX · zoom` (world units per CSS px == zoom, I-09), fed to
 *  `scanPositionsInView`'s scan-time dedupe, so a 300-cell pile is ONE candidate, not 300
 *  (see coincidenceMergeWorld). The in-view cap still counts every member. */
export const COINCIDENCE_MERGE_PX = 4;

/** The world-unit coincidence grid for the current camera: cells whose centres land in the
 *  same `mergePx`-on-screen bucket are a pile and collapse to their lowest-id member — the
 *  same representative the pyramid keeps and the aggregate chip counts. Zoom-aware: at deep
 *  zoom a genuinely-separated cloud resolves apart and never merges; only true coincidence
 *  (identical positions) collapses. Pure + exported for tests. */
export function coincidenceMergeWorld(state: CameraState, mergePx: number): number {
  if (mergePx <= 0) return 0;
  return mergePx * (state.zoom > 0 ? state.zoom : 1);
}

/** The largest cell width in a position table: one O(N) pass, run once when a table binds,
 *  never per frame. No set of in-view cells has a median above it, so it is the gate's O(1)
 *  short cut. Pure + exported for tests and for measuring the bind cost. */
export function largestCellWidth(table: PositionTable): number {
  const { w, count } = table;
  let max = 0;
  for (let i = 0; i < count; i++) if (w[i] > max) max = w[i];
  return max;
}

/** The gate's cell size: the UPPER median (`sorted[floor(n / 2)]`) of the candidates' world
 *  widths, 0 when there are none. Upper, so a view of one large and one small cell reads
 *  the large one. */
function upperMedianWidth(cands: CellCandidate[]): number {
  if (cands.length === 0) return 0;
  const widths = Float64Array.from(cands, (c) => c.w).sort();
  return widths[Math.floor(widths.length / 2)];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the LayoutController pushes on activate / switch / positions-bind: the active
 *  manifest (dataset id + version + the detail descriptor) and the layout's position
 *  table (per-cell world rects). A same-dataset layout switch keeps the decoded
 *  textures (cell ids are layout-invariant); only the positions move. */
export interface DetailContext {
  manifest: LayoutManifest;
  positions: PositionTable | null;
}

/** A decoded detail image ready to draw: the texture plus its decoded pixel dims (for
 *  cover-crop aspect + LRU byte accounting). */
export interface DecodedDetail {
  texture: THREE.Texture;
  width: number;
  height: number;
}

/** Injectable side-effecting deps (the GPU/network seam), for the GL-free node tests:
 *  a fake `fetch` (records signals + returns canned statuses) and a stub `decode`
 *  (returns a bare THREE.Texture). Omitted ⇒ the real global fetch + createImageBitmap. */
export interface DetailOverlayDeps {
  fetch?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  decode?: (blob: Blob, rung: number) => Promise<DecodedDetail>;
}

/** The overlay handle the LayoutController wires. `overlayCount` is the drawn count
 *  (also published to the debug surface); the rest are introspection parallel to the
 *  loader's residentTileCount/loadingTileCount, used by the unit tests. */
export interface DetailOverlay {
  /** The single runtime-mutable config (T2-101 scaffolding). */
  readonly config: DetailOverlayConfig;
  /** Set the active layout context (manifest + positions); null clears + tears down. */
  setContext(ctx: DetailContext | null): void;
  dispose(): void;
  /** Cells currently showing a detail overlay quad. */
  overlayCount(): number;
  /** Decoded textures held in the LRU (drawn + recently-left). */
  cachedCount(): number;
  /** Total bytes held by the LRU (w×h×4 per decoded texture). */
  cachedBytes(): number;
  /** LRU keys (`${dsId}/v${version}/${cellId}`), for the key-shape + survives-switch test. */
  cachedKeys(): string[];
  /** In-flight detail fetches. */
  inflightCount(): number;
  /** Whether the gate is currently engaged. */
  isEngaged(): boolean;
}

/** One drawn overlay quad. Position/aspect are cached so a layout switch (which moves
 *  the cell) or a rung re-decode can rebuild the geometry only when it actually
 *  changed, not every frame. */
interface DrawnQuad {
  key: string;
  cellId: number;
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  x: number;
  y: number;
  w: number;
  h: number;
  aspect: number;
  fadeStart: number;
  fading: boolean;
}

/** One decoded detail texture in the LRU. `decodedEdge` is the texture's ACTUAL decoded
 *  max-edge in px — NOT the requested rung: it is smaller when the natural image is below
 *  the rung. `atCeiling` is true once the natural resolution is below the requested rung
 *  (so a deeper zoom does not pointlessly re-fetch — it cannot get sharper). The rung
 *  upgrade check compares the target rung against `decodedEdge`. */
interface OverlayTexture {
  key: string;
  cellId: number;
  texture: THREE.Texture;
  width: number;
  height: number;
  bytes: number;
  decodedEdge: number;
  atCeiling: boolean;
  lastUsed: number;
}

// ---------------------------------------------------------------------------
// Factory (GL + network; exercised via the DI seam in node tests)
// ---------------------------------------------------------------------------

export function createDetailOverlay(
  world: World,
  client: ApiClient,
  config: DetailOverlayConfig = { ...DEFAULT_DETAIL_OVERLAY_CONFIG },
  deps: DetailOverlayDeps = {},
): DetailOverlay {
  const fetchImpl = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const decode = deps.decode ?? decodeDetailReal;
  const worldH = world as Partial<WorldHandle> & World;
  const canvasEl = (world.renderer as { domElement?: HTMLCanvasElement }).domElement ?? null;

  // Residency: the DRAWN quads (a subset of `textures`, in view + engaged) and the
  // byte-budgeted LRU of decoded textures (drawn + recently-left, for an instant
  // re-show / pan-back / layout-switch). Both keyed `${dsId}/v${version}/${cellId}`.
  const drawn = new Map<string, DrawnQuad>();
  const textures = new Map<string, OverlayTexture>();
  // In-flight fetches (de-dupe + supersede/abort), and the bounded-backoff retry state
  // (mirrors the loader). A 404 is a PERMANENT skip (skip-tier datasets, #67 subsampled
  // cells) — never retried, never re-fetched.
  const inflight = new Map<string, AbortController>();
  // The rung each in-flight fetch asked for, so the refresh can tell a STALE step-down (one
  // the camera has since zoomed back in past) and abort it.
  const requestedRung = new WeakMap<AbortController, number>();
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const permanentSkip = new Set<string>();
  // Out of retries: the fetch and every backoff retry failed. TERMINAL like a 404 skip, but
  // only until the next camera or context change (each engaged refresh clears it), so the
  // refill never turns a freed slot into one more fetch of a cell the server keeps failing.
  const outOfRetries = new Set<string>();
  const fading = new Set<DrawnQuad>();
  let wanted = new Set<string>();
  // The REFILL list: the last engaged refresh's in-view candidates, nearest the focal point
  // first, with the zoom + dpr they were built for, and their `wanted` keys in the same order
  // (built once per refresh, not per settle). `refillCursor` (first fetches and upgrades)
  // and `stepDownCursor` (step-downs) are the first entries each pass is not done with; see
  // refill.
  let refillList: CellCandidate[] = [];
  let refillKeys: string[] = [];
  let refillCursor = 0;
  let stepDownCursor = 0;
  let refillZoom = 0;
  let refillDpr = 1;
  // The bound position table and its largest cell width (the gate's short cut), computed
  // once per table identity in setContext.
  let boundTable: PositionTable | null = null;
  let tableMaxWidth = 0;

  let ctx: DetailContext | null = null;
  let engaged = false;
  let clock = 0;
  let generation = 0;
  let disposed = false;
  let lastState: CameraState | null = null;
  let lastViewport: Viewport | null = null;

  const hasRaf = typeof globalThis.requestAnimationFrame === "function";
  const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let refreshHandle: number | null = null;
  let refreshScheduled = false;
  let fadeHandle: number | null = null;

  // ---- keys + context reads ----

  function keyOf(cellId: number): string {
    const m = ctx!.manifest;
    return `${m.dataset_id}/v${m.dataset_version}/${cellId}`;
  }

  /** The active layout-independent `image_ref` detail descriptor (the same block the
   *  api-client resolves the URL from), or null when the dataset baked no detail tier.
   *  Requires a `path_prefix` too — the SAME predicate `client.staticDetailUrl` selects
   *  its burst URL from — so the gate can never engage on a block the URL builder would
   *  skip (which would silently fall through to the authed /api route mid-burst).
   *  `path_prefix` is schema-required for mode "image_ref", so this can only diverge on a
   *  malformed manifest; keeping the two predicates identical makes that divergence
   *  impossible by construction. */
  function activeDetail(): DetailDescriptor | null {
    if (ctx === null) return null;
    for (const layout of ctx.manifest.layouts) {
      const d = layout.detail;
      if (d !== undefined && d !== null && d.mode === "image_ref" && d.path_prefix !== undefined) return d;
    }
    return null;
  }

  /** The cell's CURRENT world rect from the live position table (re-read at draw time
   *  so an async fetch that completes after a layout switch draws at the NEW position). */
  function currentCandidate(id: number): CellCandidate | null {
    const p = ctx?.positions ?? null;
    if (p === null || id < 0 || id >= p.count) return null;
    return { id, x: p.x[id], y: p.y[id], w: p.w[id], h: p.h[id] };
  }

  // ---- drawing ----

  function applyCoverCrop(geom: THREE.PlaneGeometry, imgAspect: number): void {
    const { uMin, uMax, vMin, vMax } = coverCropUvs(imgAspect);
    // PlaneGeometry's 4 vertices carry uvs (0,1)(1,1)(0,0)(1,0); remap [0,1]→[min,max]
    // per axis so the quad samples exactly the centered-square sub-rect.
    const uv = geom.getAttribute("uv") as THREE.BufferAttribute;
    uv.setXY(0, uMin, vMax);
    uv.setXY(1, uMax, vMax);
    uv.setXY(2, uMin, vMin);
    uv.setXY(3, uMax, vMin);
    uv.needsUpdate = true;
  }

  function buildGeometry(cand: CellCandidate, aspect: number): THREE.PlaneGeometry {
    const geom = new THREE.PlaneGeometry(cand.w, cand.h);
    applyCoverCrop(geom, aspect);
    // Bake the world position into the geometry + keep an identity mesh matrix, exactly
    // as tilePyramid.drawOverview does (matrixAutoUpdate=false). The y-flipped camera
    // + flipY=false texture then renders it upright, matching the coarse/fine tiers.
    geom.translate(cand.x, cand.y, 0);
    return geom;
  }

  function drawQuad(cand: CellCandidate, entry: OverlayTexture, fade: boolean): void {
    const key = entry.key;
    const aspect = entry.height > 0 ? entry.width / entry.height : 1;
    let d = drawn.get(key);
    if (d === undefined) {
      const geom = buildGeometry(cand, aspect);
      const mat = new THREE.MeshBasicMaterial({
        map: entry.texture,
        transparent: true,
        blending: THREE.NormalBlending,
        premultipliedAlpha: false,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity: fade ? 0 : 1,
      });
      mat.toneMapped = false;
      const mesh = new THREE.Mesh(geom, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = RENDER_ORDER_OVERLAY; // explicit: always above coarse + cells
      world.scene.add(mesh);
      d = {
        key, cellId: cand.id, mesh, material: mat,
        x: cand.x, y: cand.y, w: cand.w, h: cand.h, aspect,
        fadeStart: fade ? now() : 0, fading: false,
      };
      drawn.set(key, d);
      if (fade) startFade(d);
    } else {
      // Existing quad: swap to the (possibly sharper) texture, and rebuild geometry
      // only if the cell MOVED (layout switch) or the crop aspect changed (re-decode).
      if (d.material.map !== entry.texture) {
        d.material.map = entry.texture;
        d.material.needsUpdate = true;
      }
      if (d.x !== cand.x || d.y !== cand.y || d.w !== cand.w || d.h !== cand.h || d.aspect !== aspect) {
        d.mesh.geometry.dispose();
        d.mesh.geometry = buildGeometry(cand, aspect);
        d.x = cand.x; d.y = cand.y; d.w = cand.w; d.h = cand.h; d.aspect = aspect;
      }
    }
  }

  /** Stop drawing a cell's quad (dispose its geometry + material); KEEP its texture in
   *  the LRU so a re-show / pan-back re-binds it instantly. */
  function removeDrawn(key: string): void {
    const d = drawn.get(key);
    if (d === undefined) return;
    drawn.delete(key);
    fading.delete(d);
    world.scene.remove(d.mesh);
    d.mesh.geometry.dispose();
    d.material.dispose();
  }

  // ---- fade ticker ----

  function startFade(d: DrawnQuad): void {
    d.fading = true;
    d.fadeStart = now();
    fading.add(d);
    ensureFadeTicker();
  }

  function ensureFadeTicker(): void {
    if (!hasRaf) {
      // No animation frames (node unit tests) — there is no loop to drive a fade, so
      // snap the quads opaque immediately (the fade is a browser-only nicety).
      for (const d of fading) { d.material.opacity = 1; d.fading = false; }
      fading.clear();
      return;
    }
    if (fadeHandle !== null) return; // already ticking
    const tick = (): void => {
      fadeHandle = null;
      if (disposed) return;
      const t = now();
      for (const d of [...fading]) {
        const p = config.fadeMs > 0 ? Math.min(1, (t - d.fadeStart) / config.fadeMs) : 1;
        d.material.opacity = p;
        if (p >= 1) { d.fading = false; fading.delete(d); }
      }
      if (fading.size > 0) fadeHandle = globalThis.requestAnimationFrame(tick);
    };
    fadeHandle = globalThis.requestAnimationFrame(tick);
  }

  // ---- LRU ----

  function disposeTexture(tex: THREE.Texture): void {
    const img = tex.image as unknown;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
    tex.dispose();
  }

  /** Trim the recently-left textures to the byte + entry budget, evicting oldest-used
   *  first. A texture whose quad is currently DRAWN is never evicted (that would blank an
   *  on-screen cell) and does not count against the budget. */
  function trimTextures(): void {
    // Only the NON-drawn (recently-left) textures count against both limits; see
    // textureBudgetBytes (operator decision on the PR #409 review, 2026-09-29).
    let leftBytes = 0;
    let leftCount = 0;
    for (const e of textures.values()) {
      if (drawn.has(e.key)) continue;
      leftBytes += e.bytes;
      leftCount++;
    }
    if (leftBytes <= config.textureBudgetBytes && leftCount <= config.maxEntries) return;
    const evictable = [...textures.values()]
      .filter((e) => !drawn.has(e.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of evictable) {
      if (leftBytes <= config.textureBudgetBytes && leftCount <= config.maxEntries) break;
      textures.delete(e.key);
      leftBytes -= e.bytes;
      leftCount--;
      disposeTexture(e.texture);
    }
  }

  // ---- fetch ----

  function doFetch(url: string, signal: AbortSignal): Promise<Response> {
    return fetchImpl(url, { headers: client.authHeaders(), signal });
  }

  function startFetch(cand: CellCandidate, key: string, rung: number): void {
    const ac = new AbortController();
    inflight.set(key, ac);
    requestedRung.set(ac, rung);
    const gen = generation;
    const dsId = ctx!.manifest.dataset_id;
    void (async () => {
      try {
        const url = client.staticDetailUrl(dsId, cand.id);
        let res = await doFetch(url, ac.signal);
        // T2-09: a static-edge 401 means the stale-tab `viz_ds` cookie expired.
        // Single-flight refresh (a whole viewport of expiries shares one re-open) +
        // retry ONCE; a post-refresh 401 / cooldown refusal falls through below.
        if (res.status === 401 && (await client.refreshDatasetCredential(dsId))) {
          if (ac.signal.aborted) return;
          res = await doFetch(url, ac.signal);
        }
        if (superseded(gen, ac, key)) return;
        if (res.status === 404) { permanentSkip.add(key); return; } // permanent: skip-tier / #67 subsampled
        if (!res.ok) { scheduleRetry(key, gen); return; } // transient → bounded backoff
        const blob = await res.blob();
        if (superseded(gen, ac, key)) return;
        const decoded = await decode(blob, rung);
        if (superseded(gen, ac, key)) { disposeTexture(decoded.texture); return; }
        const prior = textures.get(key);
        const decodedEdge = Math.max(decoded.width, decoded.height);
        // BACKSTOP for a stale step-down: a result smaller than the texture the cell holds AND
        // smaller than the rung the cell needs at the LATEST camera is discarded, and the cell
        // keeps the larger texture. The refresh aborts such a fetch when it rebuilds the list
        // (see refresh), but a camera event's refresh can still be waiting for its animation
        // frame when the fetch lands, so the target comes from lastState, not the list's zoom.
        // Not a failure (no retry, no outOfRetries), and not a loop: the refill asks for nothing
        // until the pending refresh rebuilds the list at the latest camera, and from that list
        // any fetch for this cell asks for its current target, which this check never discards.
        const latestTarget = latestTargetRung(cand.id);
        if (prior !== undefined && decodedEdge < prior.decodedEdge && latestTarget !== null && decodedEdge < latestTarget) {
          // The fetch itself succeeded (a 200), so its spent retries go: a stale result must
          // not shrink the next step-down's retry budget.
          retryAttempts.delete(key);
          disposeTexture(decoded.texture);
          return;
        }
        const entry: OverlayTexture = {
          key, cellId: cand.id, texture: decoded.texture,
          width: decoded.width, height: decoded.height,
          bytes: decoded.width * decoded.height * 4,
          decodedEdge, atCeiling: decodedEdge < rung,
          lastUsed: ++clock,
        };
        textures.set(key, entry);
        retryAttempts.delete(key);
        // Point a drawn quad at the new texture BEFORE the prior one is disposed, whether or
        // not the cell has a rect right now: during a layout switch the position table is
        // briefly null, and the quad keeps sampling its texture until the release refresh
        // runs. The prior's ImageBitmap was closed after upload, so three could not re-upload it.
        const quad = drawn.get(key);
        if (quad !== undefined && quad.material.map !== entry.texture) {
          quad.material.map = entry.texture;
          quad.material.needsUpdate = true;
        }
        if (prior !== undefined) disposeTexture(prior.texture); // the new rung replaces the old
        const current = currentCandidate(cand.id);
        if (current !== null) drawQuad(current, entry, !drawn.has(key));
        trimTextures();
      } catch {
        // OUR abort (supersede / leave-view / dataset change) is NOT a failure. Anything else
        // this generation still wants is a transient failure and gets a bounded backoff retry
        // — decided on our own signal, NOT on the error's name: a rejection named AbortError
        // that our signal did not cause (Firefox rejects in-flight fetches that way on
        // navigation) would otherwise leave the cell with no timer and no terminal state, and
        // the refill below would restart it at once, in a loop.
        if (!ac.signal.aborted && !disposed && gen === generation && wanted.has(key)) {
          scheduleRetry(key, gen);
        }
      } finally {
        if (inflight.get(key) === ac) inflight.delete(key);
        // Every settle — success, 404, failure, a scheduled retry, an abort — frees a slot
        // or ends a cell. On a still camera nothing else hands that slot on.
        refill();
        publish();
      }
    })();
  }

  /** True when this async load is stale — disposed, a newer generation, aborted, or
   *  the tile is no longer wanted — so it must drop before any GPU work. */
  function superseded(gen: number, ac: AbortController, key: string): boolean {
    return disposed || gen !== generation || ac.signal.aborted || !wanted.has(key);
  }

  function scheduleRetry(key: string, gen: number): void {
    const spent = retryAttempts.get(key) ?? 0;
    if (spent >= RETRY_ATTEMPT_BACKOFF_MS.length) {
      outOfRetries.add(key); // cap: terminal — leave the cell on the pyramid
      return;
    }
    retryAttempts.set(key, spent + 1);
    const delay = RETRY_ATTEMPT_BACKOFF_MS[spent];
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      if (disposed || gen !== generation) return;
      // The retry goes through the refill, so fetchRungFor decides it like any other start
      // (a failed rung UPGRADE included — its cell already has a texture). With every slot
      // in use the refill starts nothing, and the cell (no timer, retries left) is started
      // by the refill of the next fetch to settle; one is in flight, since every slot is.
      refill();
    }, delay);
    retryTimers.set(key, timer);
  }

  function clearRetryTimers(): void {
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
  }

  // ---- the per-frame pass ----

  /** A cell's size on screen in device px: its world width / zoom × dpr. */
  function cellDevicePx(width: number, zoom: number, dpr: number): number {
    return zoom > 0 ? (width / zoom) * dpr : 0;
  }

  /** The dpr the overlay sizes by: capped at 2 (like the loader's MAX_DPR_FOR_LEVEL) so a 3×+
   *  display does not over-engage. */
  function dprOf(viewport: Viewport): number {
    return Math.min(MAX_DPR_FOR_LEVEL, Math.max(1, viewport.devicePixelRatio || 1));
  }

  /** The rung a cell needs at the LATEST camera — which can be newer than the refill list's,
   *  when a camera event's refresh is still waiting for its animation frame — or null with no
   *  camera yet or no rect for the cell. */
  function latestTargetRung(id: number): number | null {
    if (lastState === null || lastViewport === null) return null;
    const c = currentCandidate(id);
    if (c === null) return null;
    return rungFor(cellDevicePx(c.w, lastState.zoom, dprOf(lastViewport)));
  }

  /** The STEP-DOWN test, the one copy (fetchRungFor decides with it, and the refill's
   *  priority classifies with it): a drawn cell's texture is above the rung the cell would
   *  need even at `engageCellPx / releaseCellPx` times its size. That band is the gate's own
   *  hysteresis ratio (128 / 96 by default), so there is no new constant: a 2048 texture is
   *  kept down to 768 device px and replaced below that, and a zoom that hovers at a rung
   *  boundary does not re-decode on every wheel tick. It also requires the TARGET rung itself
   *  to be below the held texture, so a step-down always lowers the rung, whatever the
   *  config: with a ratio below 1 (`engageCellPx < releaseCellPx`, which a live settings
   *  panel, T2-101, could allow) the band test alone is true when the target EQUALS the held
   *  rung, and the same fetch restarted on every settle (PR #409 final review, E2: 61
   *  requests at 96/128 on a still camera, against 1 at the default 128/96). After a
   *  step-down the texture is at `rungFor(px)` (or the image's smaller natural size), which
   *  this test never accepts again for the same px, and which is not below the target, so
   *  the cell is settled. */
  function needsStepDown(entry: OverlayTexture | undefined, cellScreenPx: number): boolean {
    if (entry === undefined) return false;
    return (
      rungFor(cellScreenPx) < entry.decodedEdge &&
      rungFor(cellScreenPx * (config.engageCellPx / config.releaseCellPx)) < entry.decodedEdge
    );
  }

  /** THE fetch decision for one cell, now: the rung to fetch it at, or null when it needs
   *  no fetch. Every fetch start goes through the refill, which asks it, so there is one
   *  decision. It does not look at the slot cap; the refill checks that first. Its three
   *  answers: a first fetch, an upgrade (the target rung is above the held texture), or a
   *  step-down (the held texture is above the target by more than the hysteresis band).
   *  Null when the cell is already fetching or waiting on a backoff timer; when it is
   *  terminal (a 404 skip, or out of retries); when its cached texture fits the target; or,
   *  with nothing cached, when it is under the per-cell floor. It reads only the cell's key
   *  and world width, so the refill can ask it before reading the cell's rect. */
  function fetchRungFor(key: string, width: number, zoom: number, dpr: number): number | null {
    if (inflight.has(key) || retryTimers.has(key)) return null;
    if (permanentSkip.has(key) || outOfRetries.has(key)) return null;
    const cellScreenPx = cellDevicePx(width, zoom, dpr);
    const targetRung = rungFor(cellScreenPx);
    const entry = textures.get(key);
    if (entry !== undefined) {
      // Rung upgrade: a sharper rung when the on-screen size crossed up, unless the image is
      // already at its natural ceiling.
      if (targetRung > entry.decodedEdge && !entry.atCeiling) return targetRung;
      // Step DOWN to the rung the cell needs now, when the held texture is above even the
      // hysteresis band (see needsStepDown).
      if (needsStepDown(entry, cellScreenPx)) return targetRung;
      return null;
    }
    // Per-cell FETCH floor: the gate engages on the upper MEDIAN of the in-view cells' size,
    // but a layout whose cells vary in width — categorical (and datetime on one dataset),
    // per the 2026-09-29 measurement over 30 layouts — can have small cells sharing the
    // view that are not themselves blurry. Don't spend a fetch + decode on a cell below the
    // release px — it is indistinguishable at that size and stays on the pyramid — so the
    // burst is bounded to the cells that actually benefit, not every in-view cell up to the
    // cap. Only the INITIAL fetch is floored: an already-cached quad above still redraws
    // for free (its texture is already decoded), so nothing already-sharp pops out.
    if (cellScreenPx < config.releaseCellPx) return null;
    return targetRung;
  }

  /** Draw a wanted cell's cached texture at once (re-shown with a fade, or updated in
   *  place). Fetches are not started here: the refresh calls the refill once the view's
   *  list is built, so every start — first fetch, upgrade, step-down — goes through the one
   *  decision and the one priority. */
  function drawCached(cand: CellCandidate, key: string): void {
    const entry = textures.get(key);
    if (entry === undefined) return;
    entry.lastUsed = ++clock;
    drawQuad(cand, entry, !drawn.has(key)); // re-show (fade) or update in place
  }

  /** The REFILL: start fetches from the refill list, in its order, until every slot is in
   *  use. It is the only place a fetch starts: the refresh calls it once the view's list is
   *  built, and it runs again when a fetch settles and when a backoff timer fires — the two
   *  inputs that change on a still camera. It asks fetchRungFor with the list's own key and
   *  width, and re-reads the live rect only for a cell it is about to start. It does nothing
   *  when a refresh is scheduled: the camera or the context changed since the list was
   *  built, and that refresh builds the new view's list and fills the free slots itself. It
   *  never calls refresh() or scheduleRefresh(): a refresh scans the whole position table.
   *
   *  PRIORITY, in two passes. A cell that needs a first fetch or an upgrade looks blurry; a
   *  cell that needs a step-down looks fine and only costs memory. So pass 1 starts first
   *  fetches and upgrades and skips step-downs; pass 2 starts step-downs, and runs only when
   *  pass 1 reached the end of the list with a slot still free — when no blurry cell is
   *  left to take it. After a zoom-out the step-down cells sit at the focal point, the front
   *  of the list, and would otherwise take the first slots ahead of the newly visible cells.
   *
   *  CURSORS. Each pass starts past the prefix it is done with for this list.
   *    - `refillCursor` (pass 1) passes an entry that is SETTLED — fetchRungFor has nothing
   *      to start and the cell is not waiting (in flight or on a backoff timer): drawn at its
   *      target rung, terminal (404 or out of retries), or under the per-cell floor — and an
   *      entry whose texture needs a step-down, waiting or not. Neither can become a first
   *      fetch or an upgrade for this list: a drawn quad's texture is never evicted,
   *      outOfRetries is cleared only where the list is replaced, and a step-down never
   *      lands below the target. One started from this list asks for the target (or gets the
   *      image's smaller natural size, which is atCeiling and so never upgraded). One started
   *      from an earlier list that now asks for less than the target is aborted when this
   *      list is built (the stale-step-down sweep in refresh), and if it lands before that
   *      refresh runs it is discarded at completion (the backstop in startFetch). Without
   *      those two, a stale step-down landed below the target and the cell's repair upgrade
   *      waited behind every other upgrade (PR #415 review: 37 of them in a 7 × 7 view).
   *    - `stepDownCursor` (pass 2) passes settled entries only.
   *  A view load therefore walks each entry about once instead of once per settle
   *  (measured on #409: 85,309 loop iterations over a 400-cell first load before the
   *  cursor, 5,509 after). That argument assumes DetailOverlayConfig does not change
   *  mid-view: a runtime change to `releaseCellPx` (the settings panel T2-101 plans) would
   *  leave cells a cursor passed as "under the floor" unfetched until the next camera move,
   *  so that change must reset the cursors or trigger a refresh. */
  function refill(): void {
    if (disposed || !engaged || ctx === null || refreshScheduled) return;
    // Pass 1: first fetches and upgrades.
    for (let i = refillCursor; i < refillList.length; i++) {
      if (inflight.size >= config.maxInFlight) return; // every slot taken: the step-downs wait
      const key = refillKeys[i];
      const width = refillList[i].w;
      const rung = fetchRungFor(key, width, refillZoom, refillDpr);
      const stepDown = needsStepDown(textures.get(key), cellDevicePx(width, refillZoom, refillDpr));
      if (rung === null || stepDown) {
        if (i === refillCursor && (stepDown || (!inflight.has(key) && !retryTimers.has(key)))) refillCursor = i + 1;
        continue;
      }
      startListed(i, key, rung);
    }
    // Pass 2: no blurry cell is left for a free slot, so the step-downs, in list order. Any
    // answer fetchRungFor gives here is a step-down: pass 1 has started every first fetch
    // and upgrade it could, and its cursor passed only entries that cannot become one (see
    // CURSORS above, which holds because a stale step-down is aborted or discarded).
    for (let i = stepDownCursor; i < refillList.length; i++) {
      if (inflight.size >= config.maxInFlight) return;
      const key = refillKeys[i];
      const rung = fetchRungFor(key, refillList[i].w, refillZoom, refillDpr);
      if (rung === null) {
        if (i === stepDownCursor && !inflight.has(key) && !retryTimers.has(key)) stepDownCursor = i + 1;
        continue;
      }
      startListed(i, key, rung);
    }
  }

  /** Start the fetch for refill-list entry `i`, at the rect the live table holds now. */
  function startListed(i: number, key: string, rung: number): void {
    const cand = currentCandidate(refillList[i].id);
    if (cand !== null) startFetch(cand, key, rung);
  }

  function refresh(state: CameraState, viewport: Viewport): void {
    if (disposed) return;
    const detail = activeDetail();
    const positions = ctx?.positions ?? null;
    const enabled = detail !== null && positions !== null;
    const dpr = dprOf(viewport);
    // The gate is an AND (enabled AND px-threshold AND under the in-view cap), and its px
    // axis reads the cells in view — an O(N) scan of the WHOLE position table. So an O(1)
    // short cut runs first: the table's largest width bounds any in-view median, so when
    // even it is under the active threshold (or the overlay is disabled) the gate is false
    // whatever is in view, and the table scan (scanPositionsInView) does not run.
    // This is what keeps a zoomed-out frame on a 1M dataset from re-scanning 1M rows every
    // coalesced frame (duplicating viewerStatus's scan) when engagement is impossible
    // anyway. Uses the SAME threshold detailGateEngaged does (prevEngaged → release, else
    // engage), so it only avoids the scan when the answer is already known false.
    const pxThreshold = engaged ? config.releaseCellPx : config.engageCellPx;
    const maxCellPx = state.zoom > 0 ? (tableMaxWidth / state.zoom) * dpr : 0;
    if (!enabled || maxCellPx < pxThreshold) {
      if (engaged) {
        engaged = false;
        releaseDrawn(); // remove quads + abort in-flight; KEEP the LRU textures cached
      }
      publish();
      return;
    }
    // Past the short cut: ONE scan of the table gives the in-view count, exact up to the cap
    // + 1 — all the hard skip above the in-view cap needs, so over the cap it stops early —
    // and, within the cap, the visible cells. Coincident piles collapse DURING the scan
    // (T2-72): a stack of images at one point becomes its lowest-id representative, so a true
    // pile presents calmly (representative + the aggregate chip's count). The skip asks the
    // pure gate with an unbounded cell size, so the cap rule stays in detailGateEngaged alone.
    const view = bboxFromCamera(state, viewport);
    const { inView, candidates } = scanPositionsInView(
      positions!,
      view,
      config.maxOverlayCells,
      coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX),
    );
    if (!detailGateEngaged(engaged, Number.POSITIVE_INFINITY, inView, enabled, config)) {
      engaged = false;
      releaseDrawn(); // over the in-view cap (dense pile) → release + stay on the pyramid
      publish();
      return;
    }
    // The gate's px is the candidates' upper median width. With NO candidates (a gap wider
    // than the view: between datetime columns, categorical groups, over an ocean) an engaged
    // gate HOLDS: an empty view says nothing about cell size, and releasing there would make
    // the next view need engageCellPx again instead of releaseCellPx. It still goes through
    // detailGateEngaged, so the in-view cap applies.
    const cellPx =
      candidates.length === 0 && engaged
        ? Number.POSITIVE_INFINITY
        : state.zoom > 0
          ? (upperMedianWidth(candidates) / state.zoom) * dpr
          : 0;
    engaged = detailGateEngaged(engaged, cellPx, inView, enabled, config);
    if (!engaged) {
      releaseDrawn();
      publish();
      return;
    }
    // Engaged: order the candidates NEAREST the focal point first (the region the user is
    // looking at sharpens before the periphery).
    const focalX = state.focal?.[0] ?? (view.xMin + view.xMax) / 2;
    const focalY = state.focal?.[1] ?? (view.yMin + view.yMax) / 2;
    candidates.sort((a, b) => dist2(a, focalX, focalY) - dist2(b, focalX, focalY));
    const keys = candidates.map((c) => keyOf(c.id));
    wanted = new Set(keys);
    // Drop quads for cells that left the view (their textures stay cached), and abort
    // in-flight fetches for cells no longer wanted (a fast pan superseded them).
    for (const key of [...drawn.keys()]) if (!wanted.has(key)) removeDrawn(key);
    for (const [key, ac] of [...inflight]) if (!wanted.has(key)) { ac.abort(); inflight.delete(key); }
    // Abort a STALE step-down: a wanted cell's in-flight fetch that asked for a rung below the
    // texture the cell holds (a step-down) AND below the cell's new target. A zoom back in
    // overtook the zoom-out that started it, so its result would only make the cell blurry.
    // The abort frees the slot, and the cell keeps its held texture; the refill then starts
    // an upgrade, or at most a step-down, as for any cell (an upgrade when the held texture is
    // below the new target). A step-down that still asks for at least the new target is
    // kept: aborting it would only restart the same full-size decode. (A result that lands
    // before this refresh runs is caught by the completion backstop in startFetch.)
    for (let i = 0; i < candidates.length; i++) {
      const ac = inflight.get(keys[i]);
      if (ac === undefined) continue;
      const asked = requestedRung.get(ac);
      const held = textures.get(keys[i]);
      const target = rungFor(cellDevicePx(candidates[i].w, state.zoom, dpr));
      if (asked !== undefined && held !== undefined && asked < held.decodedEdge && asked < target) {
        ac.abort();
        inflight.delete(keys[i]);
      }
    }
    // This view's list for the refill. A camera or context change is what makes a terminal
    // out-of-retries cell fetchable again.
    refillList = candidates;
    refillKeys = keys;
    refillCursor = 0;
    stepDownCursor = 0;
    refillZoom = state.zoom;
    refillDpr = dpr;
    outOfRetries.clear();
    for (let i = 0; i < candidates.length; i++) drawCached(candidates[i], keys[i]);
    refill(); // every start goes through the refill's one decision and its priority
    trimTextures();
    publish();
  }

  function dist2(c: CellCandidate, fx: number, fy: number): number {
    const dx = c.x - fx;
    const dy = c.y - fy;
    return dx * dx + dy * dy;
  }

  /** Disengage: remove every drawn quad + abort in-flight/pending fetches, but KEEP the
   *  decoded textures in the LRU so re-engaging (or zooming back in) re-binds instantly. */
  function releaseDrawn(): void {
    for (const key of [...drawn.keys()]) removeDrawn(key);
    for (const ac of inflight.values()) ac.abort();
    inflight.clear();
    clearRetryTimers();
    // Reset the per-cell transient-failure retry budgets: a disengage/re-engage is fresh
    // intent (mirrors the tile loader clearing budgets on a fresh camera move), so a cell
    // that exhausted its 3 backoffs during a transient server hiccup gets a clean budget
    // when the user zooms back in — not a permanent session-long skip after the network
    // recovers. (permanentSkip — the 404 set — is untouched: a 404 stays a 404.)
    retryAttempts.clear();
    outOfRetries.clear();
    wanted = new Set();
    clearRefillList();
  }

  function clearRefillList(): void {
    refillList = [];
    refillKeys = [];
    refillCursor = 0;
    stepDownCursor = 0;
  }

  // ---- camera subscription (coalesced to one refresh per frame, like the loader) ----

  function scheduleRefresh(): void {
    if (refreshScheduled) return;
    refreshScheduled = true;
    const run = (): void => {
      refreshHandle = null;
      refreshScheduled = false;
      if (lastState !== null && lastViewport !== null) refresh(lastState, lastViewport);
    };
    if (hasRaf) refreshHandle = globalThis.requestAnimationFrame(run);
    else run(); // node unit tests: run synchronously per emit
  }

  const unsubscribe = world.onCameraChange((state, viewport) => {
    lastState = state;
    lastViewport = viewport;
    scheduleRefresh();
  });

  // ---- publish + context ----

  function publish(): void {
    if (!vizDebugAvailable) return;
    rendererDebug.overlayCells = drawn.size;
    publishRendererDebug();
  }

  /** Find the largest width of a newly bound position table — one O(N) pass per table
   *  identity, not per frame and not per push (the layout controller re-pushes the same
   *  table object at the end of an activate and on a re-activate). */
  function bindTable(table: PositionTable | null): void {
    if (table === boundTable) return;
    boundTable = table;
    tableMaxWidth = table === null ? 0 : largestCellWidth(table);
  }

  function setContext(next: DetailContext | null): void {
    if (next === null) {
      ctx = null;
      bindTable(null);
      hardReset(); // no active layout/dataset: tear down the drawn layer + caches
      return;
    }
    const prev = ctx?.manifest ?? null;
    ctx = next;
    bindTable(next.positions);
    // A DIFFERENT dataset (id/version) invalidates every cached texture (different cells
    // + originals) — drop them. A SAME-dataset layout switch KEEPS them (cell ids are
    // layout-invariant; only positions move — the feature). In production the whole
    // stack is remounted per dataset (D-31), so a same-instance dataset change is
    // defensive, but the version key makes a re-ingest never serve stale textures.
    if (prev !== null && (prev.dataset_id !== next.manifest.dataset_id || prev.dataset_version !== next.manifest.dataset_version)) {
      hardReset();
    }
    // Re-evaluate for the live camera (a switch moved cells / positions just bound).
    if (lastState !== null && lastViewport !== null) scheduleRefresh();
  }

  /** Drop ALL GPU handles + fetches (dataset change, context clear, WebGL context
   *  loss). Textures whose GL context is lost dispose harmlessly (delete is a no-op on
   *  a lost context); the next refresh re-fetches the visible cells. */
  function hardReset(): void {
    generation++;
    for (const ac of inflight.values()) ac.abort();
    inflight.clear();
    clearRetryTimers();
    for (const key of [...drawn.keys()]) removeDrawn(key);
    for (const e of textures.values()) disposeTexture(e.texture);
    textures.clear();
    engaged = false;
    outOfRetries.clear();
    wanted = new Set();
    clearRefillList();
    publish();
  }

  // ---- WebGL context-loss: drop dead handles so nothing stale renders on restore ----
  // The pyramid loader owns preventDefault + halt/recovery; the overlay only needs to
  // drop its (now-dead) textures on loss and re-fetch the visible cells on restore
  // (bitmaps were closed after upload — the re-fetch is what makes that safe).
  function onContextLost(): void {
    hardReset();
  }
  function onContextRestored(): void {
    if (disposed) return;
    if (lastState !== null && lastViewport !== null) refresh(lastState, lastViewport);
  }
  if (canvasEl !== null) {
    canvasEl.addEventListener("webglcontextlost", onContextLost, false);
    canvasEl.addEventListener("webglcontextrestored", onContextRestored, false);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (refreshHandle !== null && hasRaf) globalThis.cancelAnimationFrame(refreshHandle);
    if (fadeHandle !== null && hasRaf) globalThis.cancelAnimationFrame(fadeHandle);
    refreshHandle = null;
    fadeHandle = null;
    for (const ac of inflight.values()) ac.abort();
    inflight.clear();
    clearRetryTimers();
    if (canvasEl !== null) {
      canvasEl.removeEventListener("webglcontextlost", onContextLost, false);
      canvasEl.removeEventListener("webglcontextrestored", onContextRestored, false);
    }
    for (const key of [...drawn.keys()]) removeDrawn(key);
    for (const e of textures.values()) disposeTexture(e.texture);
    textures.clear();
    permanentSkip.clear();
    outOfRetries.clear();
    clearRefillList();
    boundTable = null;
    tableMaxWidth = 0;
    ctx = null;
    publish();
  }

  // Self-manage teardown on the World's dispose (symmetric with the tile-pyramid
  // loader): ViewerScreen calls world.dispose() on the per-dataset unmount (D-31),
  // which fires this — so layout.ts does not need an explicit dispose call.
  worldH.onDispose?.(dispose);

  return {
    config,
    setContext,
    dispose,
    overlayCount(): number {
      return drawn.size;
    },
    cachedCount(): number {
      return textures.size;
    },
    cachedBytes(): number {
      let n = 0;
      for (const e of textures.values()) n += e.bytes;
      return n;
    },
    cachedKeys(): string[] {
      return [...textures.keys()];
    },
    inflightCount(): number {
      return inflight.size;
    },
    isEngaged(): boolean {
      return engaged;
    },
  };
}

/** Decode a detail WebP blob into a screen-sized THREE.Texture (browser-only; node
 *  tests inject `deps.decode`). Decodes to the natural size, then downscales via
 *  createImageBitmap(bitmap, resize) when the max edge exceeds `rung` — so the GPU
 *  texture is bounded by the screen need at fetch time, aspect preserved. Texture settings MATCH the
 *  tile path (decodeImageTextureReal): straight alpha, sRGB, LinearFilter min+mag, no
 *  mipmaps, flipY=false, ImageBitmap closed after the first upload. */
async function decodeDetailReal(blob: Blob, rung: number): Promise<DecodedDetail> {
  const full = await createImageBitmap(blob, { imageOrientation: "none", premultiplyAlpha: "none" });
  let bitmap = full;
  const maxEdge = Math.max(full.width, full.height);
  if (maxEdge > rung) {
    const scale = rung / maxEdge;
    const rw = Math.max(1, Math.round(full.width * scale));
    const rh = Math.max(1, Math.round(full.height * scale));
    bitmap = await createImageBitmap(full, { resizeWidth: rw, resizeHeight: rh, resizeQuality: "high" });
    full.close(); // the natural-size decode is transient; keep only the screen-sized one
  }
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.onUpdate = () => {
    const img = texture.image as unknown;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) img.close();
  };
  texture.needsUpdate = true;
  return { texture, width: bitmap.width, height: bitmap.height };
}
