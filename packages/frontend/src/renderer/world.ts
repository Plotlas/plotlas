import * as THREE from "three";

export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface CameraState {
  center: [number, number]; // world coords in [0,1]^2
  // world units per screen pixel: a cell of world width w spans (w / zoom)
  // screen pixels. The LOD trigger uses cellPx = cell_w_world / zoom
  // (gap analysis #1); there is no viewport-px term.
  zoom: number;
  // Optional cursor focal point in world coords (Stage 0 §0.4 / audit A2): the
  // world point under the cursor for a wheel-zoom event, so the loader can order
  // loads by distance to where the user is looking instead of the bbox centre.
  // Present ONLY on cursor-anchored wheel events; absent for pan / resize /
  // programmatic drives, where the loader falls back to the viewport centre.
  // Consumers that only need {center, zoom} ignore it (backward compatible).
  focal?: [number, number];
}

export interface World {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly maxTextureSize: number; // from gl.getParameter; drives atlas fallback
  resize(viewport: Viewport): void;
  onCameraChange(cb: (state: CameraState, viewport: Viewport) => void): () => void;
  start(): void; // begin render loop
  dispose(): void;
}

/**
 * Renderer-internal extension of the catalogue `World` interface (the catalogue
 * surface above is implemented verbatim; these extras are consumed only inside
 * `src/renderer/` and by the perf harness — never by `ui/*`).
 *
 * - `getCameraState`/`getViewport`: synchronous reads for picking math and for
 *   modules that need state before any input event fires.
 * - `setCameraState`: programmatic camera drive (the perf harness's scripted
 *   pan/zoom sweep). Input handlers route through the same path.
 * - `onDispose`: register a teardown callback fired synchronously from
 *   `dispose()`. The tile-pyramid loader uses it to abort its in-flight fetches on
 *   the per-dataset unmount — without it, the orphaned loader's loads run to
 *   completion against a torn-down stack. Renderer-internal only.
 * - `haltRenderLoop`/`resumeRenderLoop`: stop and restart the animation loop for
 *   WebGL context-loss recovery. Unlike `dispose()`, the World SURVIVES — these
 *   are reversible, so recovery happens IN PLACE.
 */
export interface WorldHandle extends World {
  getCameraState(): CameraState;
  getViewport(): Viewport;
  setCameraState(state: Partial<CameraState>): void;
  onDispose(cb: () => void): void;
  /** §0.6: halt the render loop on `webglcontextlost` (no point spinning render
   *  calls a lost context no-ops). No-op once disposed. Reversed by
   *  `resumeRenderLoop`. */
  haltRenderLoop(): void;
  /** §0.6: restart the render loop on `webglcontextrestored` so the recovered
   *  context re-uploads the surviving geometry/shaders and the repopulating
   *  textures render. No-op if disposed or already running. */
  resumeRenderLoop(): void;
}

// Zoom clamps relative to the "fit the [0,1]^2 world" zoom: allow zooming out
// to 8x past fit and in until one world unit spans ~4096x the fit pixel count.
const MAX_ZOOM_OUT_FACTOR = 8;
const MAX_ZOOM_IN_FACTOR = 1 / 4096;
const WHEEL_ZOOM_RATE = 0.0015;

/** Zoom at which the whole [0,1]^2 world fits the viewport (letterboxed on
 *  aspect mismatch: the binding axis is the one needing more world per px). */
export function fitZoom(viewport: Viewport): number {
  return Math.max(1 / Math.max(1, viewport.width), 1 / Math.max(1, viewport.height));
}

/** A world rectangle (the `[0,1]²` sub-region a layout/cell occupies). Mirrors the
 *  loader's `BBox` shape without importing it (world.ts is the camera-math home and
 *  must not depend on the tile-pyramid loader). */
export interface WorldRect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * Camera (center, zoom) that FITS a world rectangle to the viewport, letterboxed on
 * aspect mismatch — the generalization of `fitZoom` to an arbitrary sub-region (a
 * layout's bbox), for the cockpit "fit view" button and the D-B auto-fit. The
 * binding axis is the one needing more world per screen px, so the whole rect is
 * visible with a small margin (`pad`, a fraction of the rect grown on every side;
 * default 2%). Empty/degenerate rects fall back to the whole-world fit. Pure +
 * exported for unit tests (no GL, no camera clamps — the caller's setCameraState
 * clamps zoom into the world's min/max range).
 */
export function fitCamera(rect: WorldRect, viewport: Viewport, pad = 0.02): CameraState {
  const w = Math.max(0, rect.xMax - rect.xMin);
  const h = Math.max(0, rect.yMax - rect.yMin);
  const cx = (rect.xMin + rect.xMax) / 2;
  const cy = (rect.yMin + rect.yMax) / 2;
  // Degenerate rect (a point, or unset): fall back to the whole-world fit centred here.
  if (w <= 0 && h <= 0) return { center: [cx, cy], zoom: fitZoom(viewport) };
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const factor = 1 + 2 * Math.max(0, pad);
  // zoom = world units per px; the binding axis is whichever needs the larger zoom
  // (more world per px) to fit. A zero-extent axis contributes no constraint.
  const zx = w > 0 ? (w * factor) / vw : 0;
  const zy = h > 0 ? (h * factor) / vh : 0;
  return { center: [cx, cy], zoom: Math.max(zx, zy) };
}

/**
 * Camera (center, zoom) that CENTERS a single cell's world rect and zooms so the
 * cell's larger edge spans about `fraction` of the viewport's matching edge — the
 * math behind `centerOnCell` / the lightbox's "Locate on canvas". `fraction`
 * defaults to 1/3 (the cell fills ~a third of the view — recognizable without
 * over-zooming). A zero-size cell falls back to the whole-world fit zoom, centred on
 * the cell. Pure + exported for unit tests; the caller (`setCameraState`) clamps the
 * zoom into the world's allowed range.
 */
export function cameraForCell(rect: WorldRect, viewport: Viewport, fraction = 1 / 3): CameraState {
  const w = Math.max(0, rect.xMax - rect.xMin);
  const h = Math.max(0, rect.yMax - rect.yMin);
  const cx = (rect.xMin + rect.xMax) / 2;
  const cy = (rect.yMin + rect.yMax) / 2;
  if (w <= 0 && h <= 0) return { center: [cx, cy], zoom: fitZoom(viewport) };
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  const f = Math.min(1, Math.max(1e-3, fraction));
  // Each axis wants zoom so cellEdge/zoom ≈ f*viewportEdge; take the LARGER zoom
  // (the more-out one) so the whole cell fits within the target fraction.
  const zx = w > 0 ? w / (f * vw) : 0;
  const zy = h > 0 ? h / (f * vh) : 0;
  return { center: [cx, cy], zoom: Math.max(zx, zy) };
}

export function createWorld(canvas: HTMLCanvasElement, viewport: Viewport): WorldHandle {
  const scene = new THREE.Scene();

  // Orthographic camera over the [0,1]^2 world. The frustum is recomputed from
  // (center, zoom, viewport) on every change. `top` is assigned the SMALLER
  // world-y so world y grows downward on screen, matching tile/atlas row order
  // (the projection flip is harmless; cell materials render DoubleSide).
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 100);
  camera.position.set(0.5, 0.5, 10);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: "high-performance",
  });

  const gl = renderer.getContext();
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

  let vp: Viewport = { ...viewport };
  const state: CameraState = { center: [0.5, 0.5], zoom: fitZoom(viewport) };
  let minZoom = state.zoom * MAX_ZOOM_IN_FACTOR;
  let maxZoom = state.zoom * MAX_ZOOM_OUT_FACTOR;

  const callbacks = new Set<(state: CameraState, viewport: Viewport) => void>();
  const disposeCallbacks = new Set<() => void>();
  let running = false;
  let disposed = false;

  function applyCamera(): void {
    const halfW = (vp.width / 2) * state.zoom;
    const halfH = (vp.height / 2) * state.zoom;
    camera.position.set(state.center[0], state.center[1], 10);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = -halfH; // smaller world-y at screen top => y-down world
    camera.bottom = halfH;
    camera.updateProjectionMatrix();
  }

  // `focal` is a one-shot per emit (the cursor point for THIS wheel event); it is
  // never stored on the persistent `state`, so a later pan/resize emit does not
  // carry a stale focal — absent focal ⇒ the loader orders by viewport centre.
  function emit(focal?: [number, number]): void {
    const snapshot: CameraState = { center: [state.center[0], state.center[1]], zoom: state.zoom };
    if (focal !== undefined) snapshot.focal = [focal[0], focal[1]];
    const v: Viewport = { ...vp };
    for (const cb of callbacks) cb(snapshot, v);
  }

  function setCameraState(partial: Partial<CameraState>, focal?: [number, number]): void {
    if (partial.center !== undefined) {
      state.center = [partial.center[0], partial.center[1]];
    }
    if (partial.zoom !== undefined) {
      state.zoom = Math.min(maxZoom, Math.max(minZoom, partial.zoom));
    }
    applyCamera();
    emit(focal);
  }

  // ---- input: drag-to-pan, wheel-to-zoom anchored at the cursor ----
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e: PointerEvent): void {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Content follows the cursor: dragging right moves the camera center left.
    setCameraState({
      center: [state.center[0] - dx * state.zoom, state.center[1] - dy * state.zoom],
    });
  }

  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const newZoom = Math.min(
      maxZoom,
      Math.max(minZoom, state.zoom * Math.exp(e.deltaY * WHEEL_ZOOM_RATE)),
    );
    // Keep the world point under the cursor fixed while zooming. (wx,wy) is also
    // the load focal point (§0.4 / audit A2): emit it so the pager orders loads
    // outward from the cursor instead of the bbox centre.
    const wx = state.center[0] + (px - vp.width / 2) * state.zoom;
    const wy = state.center[1] + (py - vp.height / 2) * state.zoom;
    setCameraState(
      {
        center: [wx - (px - vp.width / 2) * newZoom, wy - (py - vp.height / 2) * newZoom],
        zoom: newZoom,
      },
      [wx, wy],
    );
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  function renderFrame(): void {
    // Allocation-free hot path: a single render call. Cell positions and texture
    // bindings are uploaded to the GPU buffers on tile arrival (cells.ts), not
    // recomputed per frame — there is no per-frame mesh hook.
    renderer.render(scene, camera);
  }

  renderer.setSize(vp.width, vp.height, false);
  renderer.setPixelRatio(vp.devicePixelRatio);
  applyCamera();

  return {
    scene,
    camera,
    renderer,
    maxTextureSize,
    resize(next: Viewport): void {
      vp = { ...next };
      // Re-derive the zoom clamps so deep resizes keep sane bounds; preserve
      // the current zoom (clamped) rather than resetting the camera.
      const fz = fitZoom(vp);
      minZoom = fz * MAX_ZOOM_IN_FACTOR;
      maxZoom = fz * MAX_ZOOM_OUT_FACTOR;
      state.zoom = Math.min(maxZoom, Math.max(minZoom, state.zoom));
      renderer.setSize(vp.width, vp.height, false);
      renderer.setPixelRatio(vp.devicePixelRatio);
      applyCamera();
      emit();
    },
    onCameraChange(cb: (state: CameraState, viewport: Viewport) => void): () => void {
      callbacks.add(cb);
      // Emit the current state immediately so subscribers never observe a
      // "before first input" gap (lod.ts and cells.ts rely on this).
      cb({ center: [state.center[0], state.center[1]], zoom: state.zoom }, { ...vp });
      return () => {
        callbacks.delete(cb);
      };
    },
    start(): void {
      if (running || disposed) return;
      running = true;
      renderer.setAnimationLoop(renderFrame);
    },
    haltRenderLoop(): void {
      // §0.6: on webglcontextlost, stop driving frames. THREE no-ops render()
      // while the context is lost, so this only avoids spinning the loop; the
      // real point is the reversible pair with resumeRenderLoop (no remount).
      if (disposed) return;
      running = false;
      renderer.setAnimationLoop(null);
    },
    resumeRenderLoop(): void {
      // §0.6: on webglcontextrestored, restart the loop so THREE re-uploads the
      // surviving geometry/shaders (and the repopulating page textures) and the
      // preserved view renders again. Never restart a disposed World.
      if (disposed || running) return;
      running = true;
      renderer.setAnimationLoop(renderFrame);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      running = false;
      renderer.setAnimationLoop(null);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      // Fire teardown hooks (the tile-pyramid loader aborts in-flight fetches)
      // BEFORE we drop the camera subscriptions, then clear both sets.
      for (const cb of disposeCallbacks) {
        try {
          cb();
        } catch (err) {
          console.error("[world] dispose callback failed", err);
        }
      }
      disposeCallbacks.clear();
      callbacks.clear();
      renderer.dispose();
    },
    getCameraState(): CameraState {
      return { center: [state.center[0], state.center[1]], zoom: state.zoom };
    },
    getViewport(): Viewport {
      return { ...vp };
    },
    setCameraState,
    onDispose(cb: () => void): void {
      if (disposed) {
        cb();
        return;
      }
      disposeCallbacks.add(cb);
    },
  };
}
