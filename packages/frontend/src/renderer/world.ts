import * as THREE from "three";

import {
  DOUBLE_TAP_ZOOM_STEP,
  isDoubleTap,
  pinchCamera,
  pinchFrame,
  tapTolerancePx,
  wheelPixels,
  zoomAt,
} from "./gesture.ts";
import type { PinchFrame, PointerSample, TapRecord } from "./gesture.ts";
import { errText } from "../api-client/errText.ts";
import { rendererFailureError } from "./health.ts";
import type { RendererFailure, RendererHealthHandle } from "./health.ts";

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
 * The concrete handle `createWorld` returns, extending the catalogue `World` interface
 * (the `World` surface above is implemented verbatim). `World` stays the minimum a
 * consumer may assume — the overlays and the tile loader take a plain `World` and
 * feature-detect the rest — while THIS is the type `ui/ViewerScreen.ts` actually holds.
 *
 * These are therefore part of the cross-package contract, not renderer-internal:
 * measured 2026-08-06, `ui/` calls `setCameraState` (5), `getViewport` (5),
 * `getCameraState` (1) and `consumedGesture` (1). `interface-catalogue.md` documents
 * `WorldHandle` as a section of its own for that reason; keep the two in step.
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
  /** `focal` is the one-shot anchored world point the emit carries (see `CameraState`).
   *  It was missing from this declaration while the implementation has always taken it,
   *  so a consumer typed against `WorldHandle` could not drive an anchored zoom without
   *  silently dropping the loader's focal point — the regression audit A2 added the field
   *  to prevent (review of #267). `interface-catalogue.md` carries the same signature. */
  setCameraState(state: Partial<CameraState>, focal?: [number, number]): void;
  onDispose(cb: () => void): void;
  /** §0.6: halt the render loop on `webglcontextlost` (no point spinning render
   *  calls a lost context no-ops). No-op once disposed. Reversed by
   *  `resumeRenderLoop`. */
  haltRenderLoop(): void;
  /** §0.6: restart the render loop on `webglcontextrestored` so the recovered
   *  context re-uploads the surviving geometry/shaders and the repopulating
   *  textures render. No-op if disposed or already running. */
  resumeRenderLoop(): void;
  /** True when the pointer interaction that just ended must NOT be treated as a click:
   *  it involved more than one pointer (a pinch), or it moved beyond the tap tolerance
   *  for its pointer type. Read by `ViewerScreen.handleCanvasClick`; cleared on the next
   *  `pointerdown` that begins a fresh interaction. Seam M1 / SCOPE §2a — the World owns
   *  ALL pointer bookkeeping, and `ui/` asks this one question instead of keeping its
   *  own (which is how a pinch used to end by selecting a cell). */
  consumedGesture(): boolean;
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

/** The canvas capabilities the input model uses. Declared structurally rather than
 *  taking the canvas so the model can be driven without a DOM: `createWorld` needs a
 *  real WebGL context (pinned by `tests/frontend_skeleton.test.ts` — "createWorld needs
 *  a real WebGL canvas"), so anything left inside its closure is unreachable in both
 *  test tiers. An `HTMLCanvasElement` satisfies this as-is. */
export interface InputSurface {
  setPointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
  releasePointerCapture(pointerId: number): void;
  getBoundingClientRect(): { left: number; top: number };
}

/** The camera the input model drives — `createWorld`'s own closure state, behind
 *  getters because `vp` is REPLACED on resize (a captured reference would go stale). */
export interface InputCamera {
  /** The live camera state; the input model only reads it. */
  camera(): CameraState;
  viewport(): Viewport;
  /** The SAME clamp `drive` (setCameraState) applies — not a second one. The input
   *  model needs it BEFORE the anchor math because `setCameraState` clamps zoom but
   *  not center, so a center computed for a zoom that never lands leaves the anchor
   *  drifting; the shipped wheel handler already pre-clamped for this reason. */
  clampZoom(zoom: number): number;
  drive(partial: Partial<CameraState>, focal?: [number, number]): void;
}

/** The `PointerEvent` fields the input model reads. Structural, so a real
 *  `PointerEvent` is assignable to it and a test can hand it a literal. */
export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** The `WheelEvent` fields the input model reads (see `PointerLike`). */
export interface WheelLike {
  clientX: number;
  clientY: number;
  deltaY: number;
  deltaMode: number;
  preventDefault(): void;
}

export interface PointerInput {
  onPointerDown(e: PointerLike): void;
  onPointerMove(e: PointerLike): void;
  onPointerUp(e: PointerLike): void;
  /** `pointercancel` — on touch this is ROUTINE (the browser reclaiming the gesture),
   *  not exceptional. It shares every bit of `onPointerUp`'s bookkeeping, but the
   *  interaction never COMPLETED, so it is not a tap and must not seed a double-tap.
   *  Bind it separately; routing it to `onPointerUp` is the defect this pair replaced. */
  onPointerCancel(e: PointerLike): void;
  /** `lostpointercapture` — the self-heal for a pointer that ends without either a
   *  `pointerup` or a `pointercancel` (the capturing element leaves the DOM, the browser
   *  reclaims the capture). It shares `onPointerCancel`'s path, and after a normal
   *  up/cancel it is a no-op because the id is already out of the map. Without it a
   *  leaked id makes every later tap read as a pinch — see `onPointerDown`. */
  onLostPointerCapture(e: PointerLike): void;
  onWheel(e: WheelLike): void;
  /** See `WorldHandle.consumedGesture`. */
  consumedGesture(): boolean;
}

/**
 * The camera-input model: one-finger/mouse drag to pan, two-finger pinch to zoom and
 * pan (SCOPE D3), double-tap to zoom in (SCOPE D4), wheel to zoom anchored at the
 * cursor. Seam M1 — this is the SINGLE owner of pointer bookkeeping: `ui/` keeps none
 * and asks `consumedGesture()` instead (SCOPE §2a).
 *
 * All arbitration is on the ACTIVE POINTER MAP — the fix for fault I2, where one
 * `dragging` boolean and one `lastX`/`lastY` pair meant a second finger overwrote the
 * pan origin (measured: a 10px finger move panned 190px) and the first lift killed the
 * survivor (measured: 0px). Every camera change routes through `cam.drive`, which is
 * `setCameraState` — nothing here mutates camera state or clamps zoom itself.
 *
 * Extracted from `createWorld` because `createWorld` needs a real WebGL canvas
 * (tests/frontend_skeleton.test.ts), so bookkeeping left inside it is unreachable from
 * both test tiers.
 */
export function createPointerInput(surface: InputSurface, cam: InputCamera): PointerInput {
  // Active pointers, in insertion order — a Map preserves it, which is what makes
  // "the first two fingers own the pinch" well-defined.
  const pointers = new Map<number, PointerSample>();
  // The pinch frame the next pinch step is differenced against. Re-seated whenever the
  // leading PAIR changes (a finger down or up), never carried across a different pair.
  let pinchPrev: PinchFrame | null = null;
  // True when the interaction that just ended must not be treated as a click.
  let consumed = false;
  // Where the current interaction started + the tolerance for the pointer that started
  // it, so "did this move far enough to be a drag" is answered per pointer TYPE.
  let tapOrigin: PointerSample | null = null;
  let tapTolerance = tapTolerancePx("mouse");
  // The previous completed tap, for double-tap detection (SCOPE D4).
  let lastTap: TapRecord | null = null;

  // The leading pair, cached: a REUSED two-slot array plus its two ids, re-seated only
  // when the pointer SET changes (a finger down or up). `pointermove` is the hot path —
  // it fires at input rate for the whole gesture — so it must not allocate an id array,
  // a sample array and a Map iterator per frame just to ask "is this one of the two?".
  // The entries are the same objects the map holds, so `held.x = ...` in onPointerMove
  // keeps them current with no re-seat.
  const leadPair: PointerSample[] = [];
  let leadIdA = -1;
  let leadIdB = -1;

  function reseatLead(): void {
    leadPair.length = 0;
    leadIdA = -1;
    leadIdB = -1;
    for (const id of pointers.keys()) {
      const p = pointers.get(id);
      if (p === undefined) continue;
      if (leadPair.length === 0) {
        leadIdA = id;
      } else {
        leadIdB = id;
      }
      leadPair.push(p);
      if (leadPair.length === 2) break;
    }
  }

  /**
   * The leading pair's pinch frame in CANVAS-RELATIVE pixels.
   *
   * `pinchFrame` reads the samples, which are CLIENT coordinates, but `pinchCamera`
   * measures its anchor from the viewport's own centre (`midX - vp.width / 2`) — a
   * canvas-relative frame. `onWheel` and the double-tap in `endPointer` both subtract
   * `getBoundingClientRect()` for exactly that reason, and the pinch must too: without
   * it the anchored world point, and the `focal` the tile loader orders its loads by,
   * are off by the canvas's own offset within the viewport.
   *
   * That offset is (0,0) today because `.canvas-holder` starts at the viewport top —
   * which is an ASSUMPTION app.css already flags as due to break (`env(safe-area-inset-
   * top)` / notch handling, SCOPE §5). Neither tier could see it: the free-tier harness
   * hands the model a `{left: 0, top: 0}` rect, and `e2e/mobile-pinch.spec.ts` asserts
   * only the DIRECTION of the zoom. `tests/touch_input.test.ts` now drives an offset
   * surface for this reason. `dist` is a difference, so it needs no offset.
   */
  function localPinchFrame(): PinchFrame | null {
    const frame = pinchFrame(leadPair);
    if (frame === null) return null;
    const rect = surface.getBoundingClientRect();
    frame.midX -= rect.left;
    frame.midY -= rect.top;
    return frame;
  }

  function onPointerDown(e: PointerLike): void {
    if (pointers.size === 0) {
      // A fresh interaction: this is the one place `consumed` is cleared (§2b).
      consumed = false;
      tapOrigin = { x: e.clientX, y: e.clientY };
      tapTolerance = tapTolerancePx(e.pointerType);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    reseatLead();
    if (pointers.size >= 2) {
      // More than one pointer means a pinch, and a pinch is never a click (§2b) —
      // without this every pinch would end by selecting whatever is under a finger.
      consumed = true;
      pinchPrev = localPinchFrame();
    }
    // Capture LAST: it is the one call here that can throw (setPointerCapture rejects a
    // pointerId with no active pointer), and no bookkeeping should be lost if it does.
    //
    // ...but if it DOES throw, the entry we just made is a LEAK, and this map is the one
    // place a leak is unrecoverable: `consumed` and `tapOrigin` are only reset while
    // `pointers.size === 0`, so one id that can never be ended makes every later tap read
    // as a pinch — `consumedGesture()` wedges true and tap-to-select is dead for the rest
    // of the session. The pre-M1 model self-healed for free because it kept one boolean it
    // reset on every press. The id the browser rejected has no active pointer behind it by
    // definition, so no `pointerup`/`pointercancel` is coming for it: drop it (review of
    // #267). `lostpointercapture` — bound alongside the other handlers — covers the other
    // half, a capture lost without either event (the element leaving the DOM, the browser
    // reclaiming it).
    try {
      surface.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn("[world] setPointerCapture rejected a pointer; dropping it", err);
      pointers.delete(e.pointerId);
      reseatLead();
      pinchPrev = localPinchFrame();
    }
  }

  function onPointerMove(e: PointerLike): void {
    const held = pointers.get(e.pointerId);
    if (held === undefined) return; // a hover move with nothing down
    const fromX = held.x;
    const fromY = held.y;
    // Keep EVERY tracked pointer current, including a third finger the pinch ignores.
    // This is what makes 2->1 and 3->2 seamless: whoever survives resumes from its own
    // last position, so there is no accumulated difference to jump by.
    held.x = e.clientX;
    held.y = e.clientY;

    if (pointers.size >= 2) {
      // A third finger must not move the anchor mid-gesture: it is tracked (above) but
      // does not drive. Checked BEFORE any camera read, so an ignored pointer costs
      // nothing.
      if (e.pointerId !== leadIdA && e.pointerId !== leadIdB) return;
      const next = localPinchFrame();
      if (next === null || pinchPrev === null) return;
      const step = pinchCamera(cam.camera(), cam.viewport(), pinchPrev, next, cam.clampZoom);
      pinchPrev = next;
      // `focal` is the midpoint's world position — the same contract the wheel handler
      // honours; without it the loader silently falls back to the bbox centre.
      cam.drive({ center: step.center, zoom: step.zoom }, step.focal);
      return;
    }

    // One pointer: pan. Content follows the cursor, so dragging right moves the camera
    // center left — unchanged from pre-M1.
    if (
      tapOrigin !== null &&
      (Math.abs(e.clientX - tapOrigin.x) > tapTolerance ||
        Math.abs(e.clientY - tapOrigin.y) > tapTolerance)
    ) {
      consumed = true; // fault I4: the tolerance is now the POINTER TYPE's, not a 4px literal
    }
    const state = cam.camera();
    const dx = e.clientX - fromX;
    const dy = e.clientY - fromY;
    cam.drive({
      center: [state.center[0] - dx * state.zoom, state.center[1] - dy * state.zoom],
    });
  }

  /**
   * A pointer left the surface. `cancelled` distinguishes `pointercancel` from
   * `pointerup`, and it is NOT a cosmetic difference: a cancel is the browser
   * explicitly RECLAIMING the gesture (an OS interruption, palm rejection, a system
   * edge-swipe), so the interaction never completed and must not be recorded as a tap —
   * otherwise the next real tap pairs with it and fires a double-tap zoom the user
   * never asked for. Everything else about the two is identical: the pointer leaves the
   * map, capture is released, and the pinch re-seats.
   */
  function endPointer(e: PointerLike, cancelled: boolean): void {
    const tracked = pointers.delete(e.pointerId);
    if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
    if (!tracked) return;

    // Re-seat against whoever is left: 3->2 changes WHICH pair leads, and a frame from
    // the old pair would be applied as one huge zoom+pan step. null below two pointers.
    reseatLead();
    pinchPrev = localPinchFrame();
    // A finger lifting is not a camera event — nothing is driven here, which is half of
    // why 2->1 does not jump; the other half is that every move kept samples current.
    if (pointers.size > 0) return;

    // The interaction is over. A gesture (pinch, or a drag past tolerance) is not a tap,
    // and neither is a cancelled interaction — none of them may seed a double-tap.
    if (cancelled || consumed || e.pointerType !== "touch") {
      lastTap = null;
      return;
    }
    // SCOPE D4: double-tap zooms in one step at the tap point. Deliberately NO delay on
    // the first tap — the accepted consequence is that a double-tap also selects.
    const tap: TapRecord = { x: e.clientX, y: e.clientY, t: Date.now() };
    if (!isDoubleTap(lastTap, tap)) {
      lastTap = tap;
      return;
    }
    lastTap = null; // a third tap starts a fresh pair rather than chaining
    consumed = true; // suppress the SECOND tap's click; the first tap's selection stands
    const state = cam.camera();
    const vp = cam.viewport();
    const rect = surface.getBoundingClientRect();
    const step = zoomAt(
      state,
      vp,
      tap.x - rect.left,
      tap.y - rect.top,
      cam.clampZoom(state.zoom / DOUBLE_TAP_ZOOM_STEP),
    );
    cam.drive({ center: step.center, zoom: step.zoom }, step.focal);
  }

  function onPointerUp(e: PointerLike): void {
    endPointer(e, false);
  }

  function onPointerCancel(e: PointerLike): void {
    // `cancelled` deliberately suppresses ONE thing — tap-recording — and `consumed`
    // stays false here. That looks like a gap and is not: no `click` is dispatched after
    // a `pointercancel`, so `consumedGesture()` is never read for this interaction, and
    // the next `pointerdown` resets it anyway. Setting it to true was considered and
    // REJECTED (review of #267): it would guard a path that cannot fire, so no pin could
    // hold it in place, and by this project's own rule a mutation that causes no failure
    // is a finding rather than a gap to paper over. Seam M2 shares this path — if you
    // are about to "fix" this, that is the reasoning you are overriding.
    endPointer(e, true);
  }

  function onLostPointerCapture(e: PointerLike): void {
    // Treated exactly as a cancel: the interaction did not complete, so it must not seed
    // a double-tap. A no-op on the ordinary path — the browser fires this right after
    // `pointerup`/`pointercancel`, by which time `pointers.delete` has already returned
    // false and `endPointer` bails on its `!tracked` guard.
    endPointer(e, true);
  }

  function onWheel(e: WheelLike): void {
    e.preventDefault();
    const state = cam.camera();
    const vp = cam.viewport();
    const rect = surface.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // Fault I6: `deltaMode` was ignored, so Firefox's line-mode notch (deltaY 3) was
    // read as 3 pixels. Mode 0 passes through untouched — Chrome/Safari are unchanged.
    const deltaPx = wheelPixels(e.deltaY, e.deltaMode);
    const newZoom = cam.clampZoom(state.zoom * Math.exp(deltaPx * WHEEL_ZOOM_RATE));
    // Keep the world point under the cursor fixed while zooming; `zoomAt` IS the
    // expression this handler shipped with, and its `focal` is that world point — the
    // load focal point (§0.4 / audit A2), so the pager orders loads outward from the
    // cursor instead of the bbox centre.
    const step = zoomAt(state, vp, px, py, newZoom);
    cam.drive({ center: step.center, zoom: step.zoom }, step.focal);
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onWheel,
    consumedGesture: () => consumed,
  };
}

/** The health transitions `createWorld` drives (Seam R1). A `Pick` of the full handle
 *  rather than the handle itself, so the world can only report — it can never mark
 *  itself starting or tear the observable down, both of which belong to whoever owns
 *  the stack's lifetime (`ui/ViewerScreen.ts`). */
export type WorldHealthSink = Pick<RendererHealthHandle, "markContextLost" | "markContextRestored" | "fail">;

/** Injected pieces of one guarded animation frame (Seam R1 P1). Extracted and exported
 *  for the same reason `createPointerInput` was: `createWorld` needs a real WebGL canvas,
 *  so anything left inside its closure is unreachable from BOTH test tiers — and "a
 *  throw inside the render loop is caught" is precisely a behaviour that must be pinned. */
export interface FrameGuardDeps {
  render(): void;
  /** Stop driving frames. A loop that throws once throws every frame, and 60 identical
   *  failures a second is not more information than one. */
  halt(): void;
  fail(failure: RendererFailure): void;
}

/**
 * Wrap one render call so a throw inside the animation loop becomes a NAMED failure
 * instead of a frozen canvas with nothing on screen — then RE-THROW it.
 *
 * The re-throw is not a detail, it is the contract (review R1-01/R1-14). three's animation
 * chain re-arms itself on the line AFTER it calls us:
 *
 *   three.module.js:13516  animationLoop( time, frame );
 *   three.module.js:13518  requestId = context.requestAnimationFrame( onAnimationFrame );
 *
 * so a swallowed throw leaves a DEAD loop being driven every frame forever, where `main`'s
 * unguarded `renderer.render(...)` threw out of the callback and the chain simply died.
 * Halting cannot substitute: `stop()` is `cancelAnimationFrame(requestId)` and, called from
 * inside the callback, that id is the frame already executing — a no-op
 * (three.module.js:13535-13541). Only the throw ends the chain. It also hands devtools and
 * `window.onerror` the real stack, which a caught-and-summarised error loses.
 *
 * `halt()` still runs first, and is NOT redundant with the throw: it clears three's
 * `isAnimating`, and `start()` early-returns while that is true (13526), so without it a
 * later `resumeRenderLoop()` builds a SECOND chain and every frame renders twice. Both
 * numbers are pinned in tests/renderer_health.test.ts.
 *
 * The health observable's value-equality is what keeps a caller that ignores the halt from
 * re-publishing on every frame.
 *
 * The hot path stays allocation-free: `try`/`catch` costs nothing until it catches.
 */
export function guardRenderFrame(deps: FrameGuardDeps): () => void {
  return () => {
    try {
      deps.render();
    } catch (err) {
      deps.halt();
      deps.fail({
        code: "render-loop-failed",
        layoutId: null,
        detail: errText(err),
      });
      throw err;
    }
  };
}

export function createWorld(canvas: HTMLCanvasElement, viewport: Viewport, health?: WorldHealthSink): WorldHandle {
  const scene = new THREE.Scene();

  // Orthographic camera over the [0,1]^2 world. The frustum is recomputed from
  // (center, zoom, viewport) on every change. `top` is assigned the SMALLER
  // world-y so world y grows downward on screen, matching tile/atlas row order
  // (the projection flip is harmless; cell materials render DoubleSide).
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 100);
  camera.position.set(0.5, 0.5, 10);

  // Seam R1 P1, detection point 1. three r169 asks the canvas for `'webgl2'` and NOTHING
  // else, throwing `Error creating WebGL context.` when it comes back null (measured
  // 2026-08-20, node_modules/three/build/three.module.js:28966-28984) — so this catch IS
  // the WebGL 2 capability check, and a probe for a WebGL 1 context would be code that
  // can never run. Classifying it here (rather than letting an unlabelled throw reach the
  // shell's generic catch) is what lets the user be told the browser has no WebGL 2
  // instead of that "rendering was interrupted".
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch (err) {
    // Review R1-06: classify on the CONDITION, not on the fact that construction threw.
    // three raises two different construction errors — one when webgl2 is unobtainable,
    // one when it IS obtainable but our attributes are refused — and `initGLContext` can
    // throw for reasons of its own. Labelling all of them `webgl2-unavailable` told a user
    // whose browser has WebGL 2 to reload the page for a browser problem they do not have,
    // and made the "rebuild the stack" remedy unreachable for every construction failure.
    //
    // Asking the canvas is the same discrimination three itself makes one line above its
    // two `throw`s. Safe HERE and only here: it runs after construction has already
    // failed, on a canvas the shell replaces before any retry (ViewerScreen keys the
    // element on the retry epoch), so the default-attribute context this may create can
    // never become the one we render through.
    if (canvas.getContext("webgl2") === null) {
      throw rendererFailureError("webgl2-unavailable", errText(err), err);
    }
    throw err; // unclassified: the shell falls back to the rebuild remedy
  }

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
  // The bookkeeping lives in `createPointerInput` (above) so it is reachable from a
  // test; this is the wiring of that model to THIS world's canvas and camera.
  const input = createPointerInput(canvas, {
    camera: () => state,
    viewport: () => vp,
    clampZoom: (zoom: number) => Math.min(maxZoom, Math.max(minZoom, zoom)),
    drive: setCameraState,
  });

  canvas.addEventListener("pointerdown", input.onPointerDown);
  canvas.addEventListener("pointermove", input.onPointerMove);
  canvas.addEventListener("pointerup", input.onPointerUp);
  canvas.addEventListener("pointercancel", input.onPointerCancel);
  canvas.addEventListener("lostpointercapture", input.onLostPointerCapture);
  canvas.addEventListener("wheel", input.onWheel, { passive: false });

  function haltLoop(): void {
    if (disposed) return;
    running = false;
    renderer.setAnimationLoop(null);
  }

  // Allocation-free hot path: a single render call. Cell positions and texture
  // bindings are uploaded to the GPU buffers on tile arrival (cells.ts), not
  // recomputed per frame — there is no per-frame mesh hook. Seam R1 P1, detection
  // point 2: the call is guarded, so a throw halts the loop and publishes a named
  // failure rather than leaving a frozen canvas and no signal at all.
  const renderFrame = guardRenderFrame({
    render: () => renderer.render(scene, camera),
    halt: haltLoop,
    fail: (failure) => health?.fail(failure),
  });

  // Seam R1 P5: make the LOST-CONTEXT window observable, so a control that cannot work
  // during it can say why. Recovery itself is the loader's (§0.6, tilePyramid.ts) and is
  // untouched here — these two listeners only publish: no preventDefault, no loop
  // change, no camera change. three registers its own pair on the same canvas before the
  // context even exists, and detailOverlay.ts a third, so the ordering is already
  // established: independent listeners, none of which observes the others.
  const onHealthContextLost = (): void => health?.markContextLost();
  // Reports the EVENT, not a verdict on the stack (review R1-04). This used to call
  // `markReady`, which cleared any failure standing at the time — including the watchdog's
  // terminal one. `markContextRestored` applies only to the loss it ended; whether the view
  // is renderable again is the shell's to say, which is why `WorldHealthSink` no longer
  // carries `markReady` at all.
  const onHealthContextRestored = (): void => health?.markContextRestored();
  canvas.addEventListener("webglcontextlost", onHealthContextLost, false);
  canvas.addEventListener("webglcontextrestored", onHealthContextRestored, false);

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
      haltLoop();
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
      canvas.removeEventListener("pointerdown", input.onPointerDown);
      canvas.removeEventListener("pointermove", input.onPointerMove);
      canvas.removeEventListener("pointerup", input.onPointerUp);
      canvas.removeEventListener("pointercancel", input.onPointerCancel);
      canvas.removeEventListener("lostpointercapture", input.onLostPointerCapture);
      canvas.removeEventListener("wheel", input.onWheel);
      canvas.removeEventListener("webglcontextlost", onHealthContextLost, false);
      canvas.removeEventListener("webglcontextrestored", onHealthContextRestored, false);
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
    consumedGesture: input.consumedGesture,
    onDispose(cb: () => void): void {
      if (disposed) {
        cb();
        return;
      }
      disposeCallbacks.add(cb);
    },
  };
}
