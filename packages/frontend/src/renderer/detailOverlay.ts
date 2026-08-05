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
// Bounded by construction, three ways:
//   * a GATE — engage only when a resident cell is big enough on screen to be blurry
//     (medianCellWidth/zoom × dpr ≥ engageCellPx) AND few enough cells are in view;
//   * DECODE-TO-NEED — each detail image reaches the GPU no larger than the cell is
//     on screen (a decode-rung ladder), so VRAM is bounded by the viewport, not the
//     2048px file;
//   * an own byte-budgeted LRU of decoded textures, keyed by (dataset, version,
//     cellId) so it SURVIVES layout switches (cell ids are layout-invariant — this
//     is a feature) and never evicts a drawn quad.
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
import { collectPositionsInView, countPositionsInView } from "./cells.ts";
import type { DetailDescriptor, LayoutManifest } from "./layout.ts";
import type { CameraState, Viewport, World, WorldHandle } from "./world.ts";
import { bboxFromCamera, isAbortError, MAX_DPR_FOR_LEVEL, RETRY_ATTEMPT_BACKOFF_MS } from "./tilePyramid.ts";
import { rendererDebug, publishRendererDebug, vizDebugAvailable } from "./debug.ts";

// ---------------------------------------------------------------------------
// Config (ONE runtime-mutable object — the T2-101 settings-panel scaffolding)
// ---------------------------------------------------------------------------

/** All of the overlay's thresholds and budgets in one place, runtime-mutable so a
 *  future settings panel (T2-101) can adjust them live. Decided 2026-07-10: the
 *  adjustability ships as scaffolding now; the exposed default is these constants. */
export interface DetailOverlayConfig {
  /** Engage when a resident cell's on-screen size (median world width / zoom × dpr)
   *  reaches this many CSS px (decided 2026-07-10: 128 ≈ 2× magnification of the
   *  64px thumb — acceptable, before it softens). */
  engageCellPx: number;
  /** Disengage below this (hysteresis, so a jittering zoom does not flap). */
  releaseCellPx: number;
  /** Hard skip: never engage while more than this many cells are in view (dense
   *  scatter piles at high magnification stay on the pyramid; bounds the burst). */
  maxOverlayCells: number;
  /** Byte ceiling for the decoded-texture LRU CACHE. NB this bounds the CACHE, not total
   *  GPU residency: a currently-DRAWN quad is never evicted (that would blank an
   *  on-screen cell), so live VRAM = drawn quads + this cache. Drawn residency is bounded
   *  separately — by the engage gate, the in-view cap, and decode-to-need (the spike's
   *  ~136 MB worst case) — which is the real ceiling; this budget only caps the
   *  recently-LEFT textures kept for an instant pan-back / re-engage. */
  textureBudgetBytes: number;
  /** Entry-count ceiling for the LRU (alongside the byte budget). */
  maxEntries: number;
  /** Concurrent detail fetches (the burst regulator, like the loader's inflight cap). */
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
 *  `collectPositionsInView`'s scan-time dedupe — the pile collapses BEFORE the candidate cap
 *  is consumed, so a 300-cell pile costs one slot, not 300 (see coincidenceMergeWorld). */
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
  cells: { medianCellWidth?(): number },
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
  const retryAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const permanentSkip = new Set<string>();
  const fading = new Set<DrawnQuad>();
  let wanted = new Set<string>();

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

  /** Trim the LRU to its byte + entry budget, evicting oldest-used first but NEVER a
   *  texture whose quad is currently DRAWN (that would blank an on-screen cell). */
  function trimTextures(): void {
    let totalBytes = 0;
    for (const e of textures.values()) totalBytes += e.bytes;
    if (totalBytes <= config.textureBudgetBytes && textures.size <= config.maxEntries) return;
    const evictable = [...textures.values()]
      .filter((e) => !drawn.has(e.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of evictable) {
      if (totalBytes <= config.textureBudgetBytes && textures.size <= config.maxEntries) break;
      textures.delete(e.key);
      totalBytes -= e.bytes;
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
        if (!res.ok) { scheduleRetry(cand, key, rung, gen); return; } // transient → bounded backoff
        const blob = await res.blob();
        if (superseded(gen, ac, key)) return;
        const decoded = await decode(blob, rung);
        if (superseded(gen, ac, key)) { disposeTexture(decoded.texture); return; }
        const prior = textures.get(key);
        if (prior !== undefined) disposeTexture(prior.texture); // a sharper rung replaces the coarser
        const decodedEdge = Math.max(decoded.width, decoded.height);
        const entry: OverlayTexture = {
          key, cellId: cand.id, texture: decoded.texture,
          width: decoded.width, height: decoded.height,
          bytes: decoded.width * decoded.height * 4,
          decodedEdge, atCeiling: decodedEdge < rung,
          lastUsed: ++clock,
        };
        textures.set(key, entry);
        retryAttempts.delete(key);
        const current = currentCandidate(cand.id);
        if (current !== null) drawQuad(current, entry, !drawn.has(key));
        trimTextures();
      } catch (err) {
        // An abort (supersede / leave-view / dataset change) is NOT a failure. A real
        // transient failure this generation still wants gets a bounded backoff retry.
        if (!isAbortError(err) && !ac.signal.aborted && !disposed && gen === generation && wanted.has(key)) {
          scheduleRetry(cand, key, rung, gen);
        }
      } finally {
        if (inflight.get(key) === ac) inflight.delete(key);
        publish();
      }
    })();
  }

  /** True when this async load is stale — disposed, a newer generation, aborted, or
   *  the tile is no longer wanted — so it must drop before any GPU work. */
  function superseded(gen: number, ac: AbortController, key: string): boolean {
    return disposed || gen !== generation || ac.signal.aborted || !wanted.has(key);
  }

  function scheduleRetry(cand: CellCandidate, key: string, rung: number, gen: number): void {
    const spent = retryAttempts.get(key) ?? 0;
    if (spent >= RETRY_ATTEMPT_BACKOFF_MS.length) return; // cap: leave the cell on the pyramid
    retryAttempts.set(key, spent + 1);
    const delay = RETRY_ATTEMPT_BACKOFF_MS[spent];
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      if (disposed || gen !== generation || ctx === null || !wanted.has(key)) return;
      if (textures.has(key) || inflight.has(key)) return;
      if (inflight.size >= config.maxInFlight) return;
      const c = currentCandidate(cand.id);
      if (c !== null) startFetch(c, key, rung);
    }, delay);
    retryTimers.set(key, timer);
  }

  function clearRetryTimers(): void {
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
  }

  // ---- the per-frame pass ----

  /** Ensure a wanted cell is drawn or fetching. A cached texture is drawn immediately
   *  (re-shown with a fade, or updated in place); a sharper rung is fetched when the
   *  on-screen size crossed up and the image is not already at its natural ceiling. */
  function ensureDetail(cand: CellCandidate, state: CameraState, dpr: number): void {
    const key = keyOf(cand.id);
    const cellScreenPx = state.zoom > 0 ? (cand.w / state.zoom) * dpr : 0;
    const targetRung = rungFor(cellScreenPx);
    const entry = textures.get(key);
    if (entry !== undefined) {
      entry.lastUsed = ++clock;
      drawQuad(cand, entry, !drawn.has(key)); // re-show (fade) or update in place
      if (targetRung > entry.decodedEdge && !entry.atCeiling && !inflight.has(key) && !retryTimers.has(key)) {
        if (inflight.size < config.maxInFlight) startFetch(cand, key, targetRung);
      }
      return;
    }
    // Per-cell FETCH floor: the gate engages on the resident MEDIAN cell size, but a
    // variable-size layout (scatter/geo) can have small cells sharing the view that are
    // not themselves blurry. Don't spend a fetch + decode on a cell below the release px
    // — it is indistinguishable at that size and stays on the pyramid — so the burst is
    // bounded to the cells that actually benefit, not every in-view cell up to the cap.
    // Only the INITIAL fetch is floored: an already-cached quad above still redraws for
    // free (its texture is already decoded), so nothing already-sharp pops out.
    if (cellScreenPx < config.releaseCellPx) return;
    if (permanentSkip.has(key) || inflight.has(key) || retryTimers.has(key)) return;
    if (inflight.size >= config.maxInFlight) return; // capped this frame; a later frame retries
    startFetch(cand, key, targetRung);
  }

  function refresh(state: CameraState, viewport: Viewport): void {
    if (disposed) return;
    const detail = activeDetail();
    const positions = ctx?.positions ?? null;
    const enabled = detail !== null && positions !== null;
    // Cap DPR at 2 (like the loader's MAX_DPR_FOR_LEVEL) so a 3×+ display does not
    // over-engage. cellPx = resident median world width / zoom × dpr.
    const dpr = Math.min(MAX_DPR_FOR_LEVEL, Math.max(1, viewport.devicePixelRatio || 1));
    const median = cells.medianCellWidth?.() ?? 0;
    const cellPx = median > 0 && state.zoom > 0 ? (median / state.zoom) * dpr : 0;
    // The gate is an AND (enabled AND px-threshold AND under the in-view cap). The px
    // axis is O(1); the in-view count is an O(N) scan of the WHOLE position table. So
    // decide the px axis FIRST — below the active threshold (or disabled) the gate is
    // false regardless of the count, so skip BOTH countPositionsInView and
    // collectPositionsInView entirely. This is what keeps a zoomed-out frame on a 1M
    // dataset from re-scanning 1M rows every coalesced frame (duplicating viewerStatus's
    // scan) when engagement is impossible anyway. Uses the SAME threshold
    // detailGateEngaged does (prevEngaged → release, else engage), so the outcome is
    // identical — this only avoids the scan when the answer is already known false.
    const pxThreshold = engaged ? config.releaseCellPx : config.engageCellPx;
    if (!enabled || cellPx < pxThreshold) {
      if (engaged) {
        engaged = false;
        releaseDrawn(); // remove quads + abort in-flight; KEEP the LRU textures cached
      }
      publish();
      return;
    }
    // Above the px threshold: NOW consult the O(N) count for the hard-skip, then the
    // candidates. detailGateEngaged re-checks px (cheap) so the pure gate stays the
    // single decision function — from here it can only flip false via the in-view cap.
    const view = bboxFromCamera(state, viewport);
    const inView = countPositionsInView(positions!, view);
    engaged = detailGateEngaged(engaged, cellPx, inView, enabled, config);
    if (!engaged) {
      releaseDrawn(); // over the in-view cap (dense pile) → release + stay on the pyramid
      publish();
      return;
    }
    // Engaged: enumerate the visible cells, ordered NEAREST the focal point first (the
    // region the user is looking at sharpens before the periphery), bounded by the cap.
    // Coincident piles collapse DURING the scan (T2-72): a stack of images at one point
    // becomes its lowest-id representative BEFORE the candidate cap is consumed, so a true
    // pile presents calmly (representative + the aggregate chip's count) AND the pile's
    // surplus members never starve the budget for the surrounding cells.
    const candidates = collectPositionsInView(
      positions!,
      view,
      config.maxOverlayCells,
      coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX),
    );
    const focalX = state.focal?.[0] ?? (view.xMin + view.xMax) / 2;
    const focalY = state.focal?.[1] ?? (view.yMin + view.yMax) / 2;
    candidates.sort((a, b) => dist2(a, focalX, focalY) - dist2(b, focalX, focalY));
    wanted = new Set(candidates.map((c) => keyOf(c.id)));
    // Drop quads for cells that left the view (their textures stay cached), and abort
    // in-flight fetches for cells no longer wanted (a fast pan superseded them).
    for (const key of [...drawn.keys()]) if (!wanted.has(key)) removeDrawn(key);
    for (const [key, ac] of [...inflight]) if (!wanted.has(key)) { ac.abort(); inflight.delete(key); }
    for (const cand of candidates) ensureDetail(cand, state, dpr);
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
    wanted = new Set();
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

  function setContext(next: DetailContext | null): void {
    if (next === null) {
      ctx = null;
      hardReset(); // no active layout/dataset: tear down the drawn layer + caches
      return;
    }
    const prev = ctx?.manifest ?? null;
    ctx = next;
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
    wanted = new Set();
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
 *  texture is bounded by screen need, aspect preserved. Texture settings MATCH the
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
