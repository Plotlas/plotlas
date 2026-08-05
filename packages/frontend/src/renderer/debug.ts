/// <reference types="vite/client" />
// Dev-only renderer introspection (O1 round-3 diagnosis).
//
// The renderer is the one part of the stack whose real behaviour — GPU texture
// binding + network page latency — is invisible to the GL-free unit tests and
// to the synthetic perf harness. This module is the missing instrument: cells.ts
// and tilePyramid.ts push their live state here on each mutation, the viewer's
// DebugOverlay renders it, and it is mirrored onto `window.__vizDebug` so an
// external browser diagnostic (Playwright / the Chrome devtools console / an
// automated reader) can sample the SAME numbers a human sees.
//
// Pure data, no effect on rendering. The single number that matters for the
// "grey on zoom-in" bug is `placeholderCells`: a cell migrates into a finer-z
// bucket whose tile texture has not arrived yet (uHasTex=0) and renders the flat
// placeholder until the fetch+decode completes. If that count spikes on every
// zoom-in and decays as tiles bind, the migrate-before-bind diagnosis is
// confirmed by observation rather than asserted.

// --- DEV gate + opt-in activation -------------------------------------------
//
// The whole diagnostic surface — the probes below, the DebugOverlay, and the
// window mirrors — is DEV-ONLY. A production `vite build` sets import.meta.env.DEV
// to false, so `vizDebugAvailable` is false, every probe no-ops, and the overlay
// never mounts. The node --experimental-strip-types test runner has no vite env
// at all, so the access is `?.`-guarded (import.meta.env is undefined there →
// false): the probes are inert under unit tests, identically to a prod build.
export const vizDebugAvailable: boolean = import.meta.env?.DEV === true;

/** Per-z-level bucket view (owned by cells.ts). */
export interface LodSlice {
  /** Distinct fine-tile buckets currently instantiated at this z level. */
  pages: number;
  /** Cells bucketed at this z level right now. */
  cells: number;
  /** Of those, how many sit in a bucket whose tile texture is bound (not grey). */
  textured: number;
}

export interface RendererDebugState {
  /** Total cells currently bucketed (summed across z levels). */
  totalCells: number;
  /** Cells rendering the flat grey placeholder right now — NOT bound to a real
   *  page texture (`texturedPages`, the real-vs-placeholder signal the never-grey
   *  guard uses; NOT `uHasTex`, which is 1 even for the placeholder). */
  placeholderCells: number;
  /** Of `placeholderCells`, how many have their RENDERED QUAD overlapping the
   *  current camera view rect — the grey the user actually SEES (the total also
   *  counts off-screen retained tiles). Filled by cells.ts (publishCellDebug)
   *  against its OWN live camera rect, recomputed on every bucket/texture mutation
   *  — so it tracks the grey as the async eviction wave creates it.
   *  Quad-OVERLAP, not centre-in-rect, so a cell larger than the view at
   *  deep zoom is counted. With the §0.3a coarse fallback it settles to ~0 on a
   *  still camera (a transient during a load wave is expected). */
  placeholderCellsInView: number;
  /** Per-z-level bucket breakdown (keyed by pyramid z; from cells.ts publishCellDebug). */
  byLod: Record<number, LodSlice>;
  /** v2 tile-pyramid (D-33): the pyramid level selectLevel chose for the current
   *  zoom (−1 until the loader has streamed once). */
  selectedZ: number;
  /** v2: manifest z_cap — z < z_cap is a COARSE overview tile, z >= z_cap is FINE
   *  (mini-atlas + per-cell records). */
  zCap: number;
  /** v2: the deepest baked level (max z in the manifest pyramid). */
  maxZ: number;
  /** v2: count of RESIDENT (currently drawn) tiles per level z — lets a viewer
   *  read off which levels are actually loaded right now. */
  residentByZ: Record<number, number>;
  /** v2: in-flight tile fetches (network) for the current view. */
  loadingTiles: number;
  /** T2-26 detail overlay: count of cells currently showing an individually-loaded
   *  detail texture ON TOP of the pyramid (0 when the overlay is disengaged, or the
   *  active dataset has no detail tier / no position table). Published by
   *  detailOverlay.ts; the e2e render gate reads it to confirm the overlay engages
   *  and stays BOUNDED (it never scales past the in-view cap). */
  overlayCells: number;
  /** §0.6: monotonic count of WebGL context losses the loader has HANDLED
   *  (incremented in tilePyramid.ts onContextLost, after preventDefault + halt +
   *  drop-residency). A read-only browser probe: it is the positive proof that the
   *  loss handler engaged the halt→in-place-recovery path — the browser cannot read
   *  the render loop's internal `running` flag (world.ts) or `residentByZ` dropping
   *  to 0 (onContextLost does not re-publish), so without this counter an e2e test
   *  could not distinguish a real handled loss from SwiftShader silently absorbing
   *  it. The unit tier asserts the same engagement via `world.halts`
   *  (tile_pyramid_loader.test.ts). Never reset. */
  contextLosses: number;
  /** Camera center in world coords ([0,1]²). §0.6 view-preservation probe: an
   *  external diagnostic reads this before/after a forced context loss to assert
   *  recovery kept the SAME camera (not a reset to the default fit view). */
  cameraCenter: [number, number];
  /** Camera zoom (world units per screen px). Pairs with `cameraCenter` for the
   *  §0.6 view-preservation assertion. */
  cameraZoom: number;
  /** performance.now() of the last publish — lets a reader detect staleness. */
  updatedAt: number;
}

/** The single shared instance. Mutated in place so the overlay and window mirror
 *  always observe the latest values without re-wiring references. */
export const rendererDebug: RendererDebugState = {
  totalCells: 0,
  placeholderCells: 0,
  placeholderCellsInView: 0,
  byLod: {},
  selectedZ: -1,
  zCap: -1,
  maxZ: -1,
  residentByZ: {},
  loadingTiles: 0,
  overlayCells: 0,
  contextLosses: 0,
  cameraCenter: [0.5, 0.5],
  cameraZoom: 0,
  updatedAt: 0,
};

/** Mirror the shared state onto window.__vizDebug (same object reference) so an
 *  external diagnostic can read it. Called by cells.ts / tilePyramid.ts after they
 *  write their slice. */
export function publishRendererDebug(): void {
  rendererDebug.updatedAt = typeof performance !== "undefined" ? performance.now() : 0;
  (globalThis as { __vizDebug?: RendererDebugState }).__vizDebug = rendererDebug;
}

// --- DEV-only camera DRIVE (window.__vizCamera) ------------------------------
//
// `rendererDebug` above is read-only introspection. This is its write-side twin: a
// dev-only handle that lets an external driver SET the camera, so a script can move
// it along a computed, eased path instead of dispatching discrete wheel events
// (helpers.wheelZoom) whose stepping is fine for a gate assertion but visibly jerky
// in a recording.
//
// Not a new capability — `WorldHandle.setCameraState` already exists and is
// documented as "programmatic camera drive (the perf harness's scripted pan/zoom
// sweep)". This only exposes that existing path to an out-of-page driver, under the
// SAME `vizDebugAvailable` DEV gate as every other probe here: a production
// `vite build` sets import.meta.env.DEV false, so nothing is published and the
// handle does not exist. Zoom stays clamped by setCameraState's own
// [minZoom, maxZoom] — a driver cannot escape the world's limits.
//
// Introduced for the marketing hero capture (docs/launch/SEAM_hero-capture.md);
// equally useful for any future scripted fly-through or deterministic screenshot.

/** The dev camera handle mirrored onto `window.__vizCamera`. */
export interface CameraDriveHandle {
  /** Current camera, as the renderer holds it. */
  get(): { center: [number, number]; zoom: number };
  /** Drive the camera. Zoom is clamped by the world's own limits. */
  set(center: [number, number], zoom: number): void;
  /** Zoom at which the whole [0,1]² world fits the current viewport — the anchor a
   *  driver needs to express a path in fit-relative terms rather than raw units. */
  fitZoom(): number;
}

/** Publish (or, with null, withdraw) the dev camera drive. No-op unless DEV.
 *  The viewer publishes on mount and withdraws on teardown, so the handle never
 *  outlives the world it drives. */
export function publishCameraDrive(handle: CameraDriveHandle | null): void {
  if (!vizDebugAvailable) return;
  const g = globalThis as { __vizCamera?: CameraDriveHandle };
  if (handle === null) delete g.__vizCamera;
  else g.__vizCamera = handle;
}
