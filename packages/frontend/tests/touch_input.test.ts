// Seam M1 — the touch input model (docs/plan/SCOPE_mobile-viewer.md §1b, brief
// docs/prompts/brief_touch_input_seam.md; ledger row T2-202).
//
// §3.0 FIRST: reproduce fault I2. The scope states it as source-derived and NOT
// reproduced — "the headless pane never completed the renderer boot chain", so nobody
// had watched two fingers corrupt the pan. It reproduced; measured on the pre-seam
// model at commit ce48930, a 10px finger move panned 190.0px and the finger surviving
// a lift panned 0.000px. Both tests below were red there and are the regression net now.
//
// `createWorld` cannot be constructed in either test tier (tests/frontend_skeleton.test.ts
// pins that it needs a real WebGL canvas), so the bookkeeping is driven through
// `createPointerInput` — the same handler bodies `createWorld` wires to its canvas —
// against a recording camera. The pure decisions (`gesture.ts`) need no harness at all.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { createPointerInput } from "../src/renderer/world.ts";
import type { CameraState, PointerLike, Viewport } from "../src/renderer/world.ts";
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_ZOOM_STEP,
  isDoubleTap,
  pinchCamera,
  pinchFrame,
  tapTolerancePx,
  wheelPixels,
  zoomAt,
} from "../src/renderer/gesture.ts";

// A portrait phone viewport (the 390 x 844 CSS px SCOPE §1a measured against, less the
// status bar). Only the half-extents matter to the math.
const VIEWPORT: Viewport = { width: 390, height: 800, devicePixelRatio: 2 };
// A zoom well inside the clamps, so no assertion below silently measures a clamp.
const Z0 = 0.001;
// The rate world.ts applies to a wheel delta (the pre-seam constant, unchanged).
const WHEEL_ZOOM_RATE = 0.0015;

interface Harness {
  input: ReturnType<typeof createPointerInput>;
  cam: CameraState;
  drives: { partial: Partial<CameraState>; focal?: [number, number] }[];
  captured: Set<number>;
  down(pointerId: number, x: number, y: number, pointerType?: string): void;
  move(pointerId: number, x: number, y: number, pointerType?: string): void;
  up(pointerId: number, x: number, y: number, pointerType?: string): void;
  cancel(pointerId: number, x: number, y: number, pointerType?: string): void;
  wheel(x: number, y: number, deltaY: number, deltaMode?: number): void;
}

/** A `createPointerInput` over a recording camera + a canvas stub. The camera APPLIES
 *  what it is driven with (so consecutive events compose exactly as they do live) and
 *  records every drive. `clampZoom` has the real world's shape around Z0. */
function harness(zoom = Z0): Harness {
  const cam: CameraState = { center: [0.5, 0.5], zoom };
  const drives: { partial: Partial<CameraState>; focal?: [number, number] }[] = [];
  const captured = new Set<number>();
  const input = createPointerInput(
    {
      setPointerCapture(id: number): void {
        captured.add(id);
      },
      hasPointerCapture(id: number): boolean {
        return captured.has(id);
      },
      releasePointerCapture(id: number): void {
        captured.delete(id);
      },
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    },
    {
      camera: () => cam,
      viewport: () => VIEWPORT,
      clampZoom: (z: number) => Math.min(Z0 * 8, Math.max(Z0 / 4096, z)),
      drive(partial: Partial<CameraState>, focal?: [number, number]): void {
        if (partial.center !== undefined) cam.center = [partial.center[0], partial.center[1]];
        if (partial.zoom !== undefined) cam.zoom = partial.zoom;
        drives.push({ partial, focal });
      },
    },
  );
  const ev = (pointerId: number, x: number, y: number, pointerType: string): PointerLike => ({
    pointerId,
    pointerType,
    clientX: x,
    clientY: y,
  });
  return {
    input,
    cam,
    drives,
    captured,
    down: (id, x, y, t = "touch") => input.onPointerDown(ev(id, x, y, t)),
    move: (id, x, y, t = "touch") => input.onPointerMove(ev(id, x, y, t)),
    up: (id, x, y, t = "touch") => input.onPointerUp(ev(id, x, y, t)),
    cancel: (id, x, y, t = "touch") => input.onPointerCancel(ev(id, x, y, t)),
    wheel: (x, y, deltaY, deltaMode = 0) =>
      input.onWheel({ clientX: x, clientY: y, deltaY, deltaMode, preventDefault() {} }),
  };
}

/** Where world point `w` sits on screen under camera `cam` — the inverse of the camera
 *  projection, written from the projection's DEFINITION (world.ts applyCamera) rather
 *  than from any code under test. */
function screenOf(cam: CameraState, vp: Viewport, w: [number, number]): [number, number] {
  return [
    (w[0] - cam.center[0]) / cam.zoom + vp.width / 2,
    (w[1] - cam.center[1]) / cam.zoom + vp.height / 2,
  ];
}

// ---------------------------------------------------------------------------
// §3.0 / §3.1 — fault I2: a second finger corrupts the pan
// ---------------------------------------------------------------------------

test("a second finger does not lurch the pan by the distance between the fingers (I2)", () => {
  // The pre-seam model kept ONE `lastX`/`lastY` pair with no pointerId map, so the
  // second pointerdown overwrote them: the next move of the FIRST finger was
  // differenced against the SECOND finger's position. Measured against that model:
  // finger A moves 10px and the camera pans 190px worth — the gap between the fingers.
  const h = harness();
  h.down(1, 100, 400);
  h.down(2, 300, 400);
  const before = h.cam.center[0];

  h.move(1, 110, 400); // finger A moves 10 screen px to the right

  const movedPx = Math.abs(h.cam.center[0] - before) / Z0;
  assert.ok(
    movedPx <= 2 * 10,
    `a 10px finger move panned the camera ${movedPx.toFixed(1)}px — the second finger's ` +
      `position leaked into the pan delta`,
  );
});

test("lifting the FIRST of two fingers leaves the survivor panning (I2)", () => {
  // The pre-seam `onPointerUp` cleared one `dragging` boolean, so the first lift killed
  // the gesture and the remaining finger went dead: it moved 20px and the camera did
  // not move at all.
  const h = harness();
  h.down(1, 100, 400);
  h.down(2, 300, 400);
  h.up(1, 100, 400);
  const before = h.cam.center[0];

  h.move(2, 320, 400); // the surviving finger drags 20px right

  const movedPx = (h.cam.center[0] - before) / Z0;
  // Content follows the finger: dragging right moves the camera centre LEFT by 20px.
  assert.ok(
    Math.abs(movedPx - -20) < 1e-6,
    `the surviving finger panned ${movedPx.toFixed(3)}px, expected -20px (0 means it went dead)`,
  );
});

test("a third finger is tracked but does not move the pinch anchor", () => {
  // §3.1: use the first two by insertion order and ignore the rest — a third finger
  // landing mid-pinch must not jump the camera.
  const h = harness();
  h.down(1, 100, 400);
  h.down(2, 300, 400);
  const drivesBefore = h.drives.length;
  h.down(3, 200, 700); // a third finger arrives
  h.move(3, 240, 760); // ...and moves a long way
  assert.equal(h.drives.length, drivesBefore, "the third finger drove the camera");
});

// ---------------------------------------------------------------------------
// §4.2 — pinch direction (the sign error the brief warns about)
// ---------------------------------------------------------------------------

test("pinchCamera: spreading the fingers zooms IN, pinching them zooms OUT", () => {
  // `zoom` is WORLD UNITS PER SCREEN PIXEL, so zooming in makes it SMALLER. Get the
  // ratio the wrong way round and pinch-out zooms out — invisible to an anchor test,
  // which is why this is its own pin.
  const cam: CameraState = { center: [0.5, 0.5], zoom: Z0 };
  const prev = { midX: 195, midY: 400, dist: 100 };
  const spread = { midX: 195, midY: 400, dist: 200 }; // fingers move apart
  const squeeze = { midX: 195, midY: 400, dist: 50 }; // fingers come together

  const out = pinchCamera(cam, VIEWPORT, prev, spread);
  assert.ok(out.zoom < cam.zoom, `spreading gave zoom ${out.zoom}, not < ${cam.zoom} (zoomed OUT)`);
  assert.ok(Math.abs(out.zoom - Z0 / 2) < 1e-15, "doubling the finger distance halves `zoom`");

  const inn = pinchCamera(cam, VIEWPORT, prev, squeeze);
  assert.ok(inn.zoom > cam.zoom, `pinching gave zoom ${inn.zoom}, not > ${cam.zoom} (zoomed IN)`);
  assert.ok(Math.abs(inn.zoom - Z0 * 2) < 1e-15, "halving the finger distance doubles `zoom`");
});

test("two fingers spreading on the canvas zoom in, through the real handlers", () => {
  // The same direction, end to end: a real two-finger drag on the input model.
  const h = harness();
  h.down(1, 145, 400);
  h.down(2, 245, 400); // 100px apart
  h.move(1, 95, 400);
  h.move(2, 295, 400); // now 200px apart — a spread
  assert.ok(h.cam.zoom < Z0, `spreading two fingers gave zoom ${h.cam.zoom}, expected < ${Z0}`);
  assert.ok(Math.abs(h.cam.zoom - Z0 / 2) < 1e-12, "the total spread was 2x, so `zoom` halves");
});

// ---------------------------------------------------------------------------
// §4.3 — pinch anchor (SCOPE D3, the FULL version: zoom AND reposition)
// ---------------------------------------------------------------------------

test("pinchCamera keeps the world point under the old midpoint under the NEW midpoint", () => {
  // D3: the midpoint's translation pans in the same gesture. The expectation is derived
  // from the camera projection's definition, not from pinchCamera's own arithmetic.
  const cam: CameraState = { center: [0.42, 0.61], zoom: Z0 };
  const prev = { midX: 120, midY: 300, dist: 140 };
  const next = { midX: 250, midY: 505, dist: 210 }; // the fingers spread AND drifted

  // The world point under prev's midpoint, BEFORE the step.
  const w: [number, number] = [
    cam.center[0] + (prev.midX - VIEWPORT.width / 2) * cam.zoom,
    cam.center[1] + (prev.midY - VIEWPORT.height / 2) * cam.zoom,
  ];

  const after = pinchCamera(cam, VIEWPORT, prev, next);
  const [sx, sy] = screenOf(after, VIEWPORT, w);

  assert.ok(Math.abs(sx - next.midX) < 1e-9, `the anchor landed at x=${sx}, not ${next.midX}`);
  assert.ok(Math.abs(sy - next.midY) < 1e-9, `the anchor landed at y=${sy}, not ${next.midY}`);
  // ...and that anchored world point is what gets emitted as the load focal point.
  assert.deepEqual(after.focal, w, "focal is not the midpoint's world position");
});

// ---------------------------------------------------------------------------
// §4.4 — the 2 -> 1 re-seat
// ---------------------------------------------------------------------------

test("lifting one of two fingers does not move the camera, and the survivor resumes cleanly", () => {
  // The single most likely bug in this seam: if the surviving pointer's sample is stale
  // (seated at pinch start rather than kept current), the first move after the lift pans
  // by the whole accumulated difference instead of by the finger.
  const h = harness();
  h.down(1, 100, 400);
  h.down(2, 300, 400);
  h.move(2, 360, 400); // a pinch step: finger B travels 60px

  const centerBefore: [number, number] = [h.cam.center[0], h.cam.center[1]];
  const zoomBefore = h.cam.zoom;
  const drivesBefore = h.drives.length;

  h.up(1, 100, 400); // lift finger A

  assert.equal(h.drives.length, drivesBefore, "lifting a finger drove the camera");
  assert.deepEqual(h.cam.center, centerBefore, "the camera centre moved on a finger lift");
  assert.equal(h.cam.zoom, zoomBefore, "the zoom moved on a finger lift");

  h.move(2, 380, 400); // the survivor drags a further 20px
  const movedPx = (h.cam.center[0] - centerBefore[0]) / h.cam.zoom;
  assert.ok(
    Math.abs(movedPx - -20) < 1e-6,
    `after the lift the survivor's 20px drag panned ${movedPx.toFixed(3)}px — the sample was stale`,
  );
});

// ---------------------------------------------------------------------------
// §4.5 — the desktop non-regression pin: zoomAt IS the old wheel math
// ---------------------------------------------------------------------------

test("zoomAt reproduces the pre-seam wheel expression exactly", () => {
  // The pre-M1 handler, transcribed from world.ts at 5cf2c00 (git show 5cf2c00 --
  // packages/frontend/src/renderer/world.ts, lines 244-252):
  //
  //   const wx = state.center[0] + (px - vp.width / 2) * state.zoom;
  //   const wy = state.center[1] + (py - vp.height / 2) * state.zoom;
  //   setCameraState({ center: [wx - (px - vp.width/2) * newZoom,
  //                            wy - (py - vp.height/2) * newZoom], zoom: newZoom }, [wx, wy]);
  //
  // If this and `zoomAt` ever disagree, mouse wheel zoom has changed. Several
  // off-centre anchors, because an anchor at the viewport centre passes any center math.
  const cases: [CameraState, number, number, number][] = [
    [{ center: [0.5, 0.5], zoom: Z0 }, 0, 0, Z0 * 0.5],
    [{ center: [0.5, 0.5], zoom: Z0 }, 390, 800, Z0 * 2],
    [{ center: [0.17, 0.83], zoom: 0.004 }, 37, 611, 0.004 * Math.exp(-100 * WHEEL_ZOOM_RATE)],
    [{ center: [0.61, 0.29], zoom: 0.00025 }, 301, 42, 0.00025 * Math.exp(120 * WHEEL_ZOOM_RATE)],
  ];
  for (const [cam, px, py, newZoom] of cases) {
    const wx = cam.center[0] + (px - VIEWPORT.width / 2) * cam.zoom;
    const wy = cam.center[1] + (py - VIEWPORT.height / 2) * cam.zoom;
    const expected = {
      center: [
        wx - (px - VIEWPORT.width / 2) * newZoom,
        wy - (py - VIEWPORT.height / 2) * newZoom,
      ],
      zoom: newZoom,
      focal: [wx, wy],
    };
    assert.deepEqual(zoomAt(cam, VIEWPORT, px, py, newZoom), expected, `wheel math drifted at (${px},${py})`);
  }
});

test("a mouse drag pans exactly as before, and a mouse wheel notch zooms as before", () => {
  // Desktop end to end, through the same handlers a touch gesture uses.
  const h = harness();
  h.down(9, 200, 300, "mouse");
  h.move(9, 260, 340, "mouse");
  assert.ok(Math.abs((h.cam.center[0] - 0.5) / Z0 - -60) < 1e-9, "x pan is not the mouse delta");
  assert.ok(Math.abs((h.cam.center[1] - 0.5) / Z0 - -40) < 1e-9, "y pan is not the mouse delta");
  h.up(9, 260, 340, "mouse");

  const h2 = harness();
  h2.wheel(37, 611, -100); // Chrome: one notch up, deltaMode 0
  const expected = Z0 * Math.exp(-100 * WHEEL_ZOOM_RATE);
  assert.ok(Math.abs(h2.cam.zoom - expected) < 1e-15, `a notch gave ${h2.cam.zoom}, expected ${expected}`);
  assert.equal(h2.drives.length, 1);
  assert.notEqual(h2.drives[0].focal, undefined, "the wheel stopped emitting a load focal point");
});

// ---------------------------------------------------------------------------
// §3.4 / §3.5 — tap tolerance and click suppression (faults I4, I1/I3)
// ---------------------------------------------------------------------------

test("tapTolerancePx: mouse and pen keep the shipped 4px; a finger gets more", () => {
  assert.equal(tapTolerancePx("mouse"), 4, "the desktop tolerance changed");
  assert.equal(tapTolerancePx("pen"), 4);
  assert.ok(tapTolerancePx("touch") > 4, "a finger gets no more room than a mouse (fault I4)");
});

test("a finger that jitters within the touch tolerance still selects (I4)", () => {
  // The defect: `handleCanvasClick` discarded any click whose pointer moved > 4px, a
  // MOUSE tolerance, so a normal finger tap "did nothing". 6px is inside the touch
  // tolerance and outside the mouse one, which is exactly the band I4 describes.
  const h = harness();
  h.down(1, 200, 400);
  h.move(1, 204, 404);
  h.move(1, 206, 403);
  h.up(1, 206, 403);
  assert.equal(h.input.consumedGesture(), false, "a 6px finger tap was still swallowed as a drag");

  // ...and the same 6px from a MOUSE is still a drag, so desktop is unchanged.
  const m = harness();
  m.down(1, 200, 400, "mouse");
  m.move(1, 206, 403, "mouse");
  m.up(1, 206, 403, "mouse");
  assert.equal(m.input.consumedGesture(), true, "the mouse tolerance widened past 4px");
});

test("a pinch consumes its click; a plain tap does not; the flag clears on the next interaction", () => {
  const h = harness();
  // A single tap: the click must survive and select.
  h.down(1, 200, 400);
  h.up(1, 200, 400);
  assert.equal(h.input.consumedGesture(), false, "a plain tap was treated as a gesture");

  // A pinch: two pointers is a gesture whether or not either finger moved.
  h.down(1, 100, 400);
  h.down(2, 300, 400);
  h.up(2, 300, 400);
  h.up(1, 100, 400);
  assert.equal(h.input.consumedGesture(), true, "a pinch would end by selecting a cell");

  // ...and it is cleared by the pointerdown that begins the NEXT interaction (§2b), or
  // every tap after a pinch would be swallowed.
  h.down(1, 200, 400);
  assert.equal(h.input.consumedGesture(), false, "the consumed flag outlived its gesture");
});

test("a finger drag past the touch tolerance consumes its click", () => {
  const h = harness();
  h.down(1, 200, 400);
  h.move(1, 260, 400);
  h.up(1, 260, 400);
  assert.equal(h.input.consumedGesture(), true, "a 60px pan ended by selecting a cell");
});

test("handleCanvasClick asks the world and keeps no pointer state of its own (SCOPE §2a)", () => {
  // A SOURCE pin: `handleCanvasClick` is unreachable in both test tiers (it returns
  // early while stackRef.current is null, and createWorld throws without WebGL), and
  // the failure mode this closes is `ui/` growing a second copy of pointer state —
  // which M2 must not inherit. Anchors are asserted UNIQUE so a mutation cannot be
  // compound.
  const src = readFileSync(new URL("../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const uniqueIndexOf = (anchor: string): number => {
    const first = src.indexOf(anchor);
    assert.notEqual(first, -1, `anchor missing from ViewerScreen.ts: ${anchor}`);
    assert.equal(src.lastIndexOf(anchor), first, `anchor is not unique: ${anchor}`);
    return first;
  };

  const click = uniqueIndexOf("function handleCanvasClick(e: {");
  const guard = uniqueIndexOf("if (stack.world.consumedGesture()) return;");
  const pick = uniqueIndexOf("stack.cells.pick(px, py).cellId");
  assert.ok(click < guard && guard < pick, "the gesture guard does not run before the pick");

  // The state that used to live here is GONE, not duplicated or widened (fault I4 was
  // fixed by deleting it, not by growing the constant). Comments are stripped first —
  // the guard's own comment names what it replaced, and prose is not state.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(code.includes("pointerDownRef"), false, "ViewerScreen still keeps pointer state");
  assert.equal(code.includes("onPointerDown"), false, "the canvas still has its own pointerdown prop");
  assert.equal(
    /Math\.abs\(e\.clientX - down\.x\) > 4/.test(code),
    false,
    "the 4px mouse literal is still in the click path",
  );
});

// ---------------------------------------------------------------------------
// §3.3 — double-tap to zoom in (SCOPE D4)
// ---------------------------------------------------------------------------

test("isDoubleTap: within the window AND the touch tolerance, and nothing else", () => {
  const first = { x: 200, y: 400, t: 1_000 };
  const tol = tapTolerancePx("touch");
  assert.equal(isDoubleTap(null, { x: 200, y: 400, t: 1_050 }), false, "no first tap");
  assert.equal(isDoubleTap(first, { x: 200, y: 400, t: 1_050 }), true);
  assert.equal(isDoubleTap(first, { x: 200 + tol, y: 400, t: 1_050 }), true, "at the radius");
  assert.equal(isDoubleTap(first, { x: 200 + tol + 1, y: 400, t: 1_050 }), false, "too far");
  assert.equal(
    isDoubleTap(first, { x: 200, y: 400, t: 1_000 + DOUBLE_TAP_MS + 1 }),
    false,
    "too slow",
  );
});

test("a double-tap zooms IN at the tap point and consumes only the SECOND tap's click", () => {
  const h = harness();
  // First tap — its click is the selection and must survive (SCOPE D4: no tap delay).
  h.down(1, 300, 200);
  h.up(1, 300, 200);
  assert.equal(h.input.consumedGesture(), false, "the FIRST tap's selection was suppressed");
  const zoomAfterFirst = h.cam.zoom;
  assert.equal(zoomAfterFirst, Z0, "the first tap moved the camera");

  // Second tap, immediately and in the same place.
  const w: [number, number] = [
    h.cam.center[0] + (300 - VIEWPORT.width / 2) * h.cam.zoom,
    h.cam.center[1] + (200 - VIEWPORT.height / 2) * h.cam.zoom,
  ];
  h.down(1, 300, 200);
  h.up(1, 300, 200);

  // Direction first, and asserted against Z0 alone: `zoom` is world units per screen
  // pixel, so zooming IN makes it smaller. This half cannot be satisfied by rescaling
  // DOUBLE_TAP_ZOOM_STEP, which both sides of the next assertion share.
  assert.ok(h.cam.zoom < Z0, `a double-tap gave zoom ${h.cam.zoom}, expected < ${Z0} — it zoomed OUT`);
  assert.ok(
    Math.abs(h.cam.zoom - Z0 / DOUBLE_TAP_ZOOM_STEP) < 1e-15,
    `a double-tap gave zoom ${h.cam.zoom}, expected ${Z0 / DOUBLE_TAP_ZOOM_STEP} (zoomed in ${DOUBLE_TAP_ZOOM_STEP}x)`,
  );
  const [sx, sy] = screenOf(h.cam, VIEWPORT, w);
  assert.ok(Math.abs(sx - 300) < 1e-9 && Math.abs(sy - 200) < 1e-9, "the zoom was not anchored at the tap");
  assert.equal(h.input.consumedGesture(), true, "the second tap's click was not suppressed");
});

test("a CANCELLED touch is not a completed tap, so it cannot seed a double-tap", () => {
  // Review finding on #267. `pointercancel` is the browser RECLAIMING the gesture — an
  // OS interruption, palm rejection, a system edge-swipe. `touch-action: none` removes
  // the browser's own scroll/zoom takeovers, so those are what is left, and they are
  // real. Recorded as a tap, the next genuine tap pairs with it and fires a zoom the
  // user never asked for.
  const h = harness();
  h.down(1, 300, 200);
  h.cancel(1, 300, 200); // the browser takes the gesture away
  assert.equal(h.cam.zoom, Z0, "a cancel moved the camera by itself");

  // ...and now a real, single, deliberate tap in the same place.
  h.down(1, 300, 200);
  h.up(1, 300, 200);
  assert.equal(h.cam.zoom, Z0, "a lone tap after a cancel zoomed — the cancel was recorded as a tap");
  assert.equal(h.input.consumedGesture(), false, "that lone tap's selection was suppressed");

  // The contrast that isolates the cancel as the cause: two REAL taps, same place, same
  // harness — this pair does zoom. (The full double-tap behaviour is pinned separately.)
  const real = harness();
  real.down(1, 300, 200);
  real.up(1, 300, 200);
  real.down(1, 300, 200);
  real.up(1, 300, 200);
  assert.ok(real.cam.zoom < Z0, "two real taps did not zoom — the contrast case is broken");
});

test("a cancel mid-pinch still re-seats, and the survivor pans without jumping", () => {
  // Everything OTHER than tap-recording must be identical to a pointerup: the pointer
  // leaves the map, the pinch re-seats, and the remaining finger keeps working. A cancel
  // on touch is routine, not exceptional.
  const h = harness();
  h.down(1, 100, 400);
  h.down(2, 300, 400);
  h.move(2, 360, 400);
  const centerBefore = h.cam.center[0];
  const drivesBefore = h.drives.length;

  h.cancel(1, 100, 400); // the browser reclaims ONE of the two fingers

  assert.equal(h.drives.length, drivesBefore, "a cancel drove the camera");
  h.move(2, 380, 400);
  const movedPx = (h.cam.center[0] - centerBefore) / h.cam.zoom;
  assert.ok(
    Math.abs(movedPx - -20) < 1e-6,
    `after the cancel the survivor's 20px drag panned ${movedPx.toFixed(3)}px`,
  );
});

test("a MOUSE double-click does not zoom — desktop gains no new gesture", () => {
  const h = harness();
  h.down(1, 300, 200, "mouse");
  h.up(1, 300, 200, "mouse");
  h.down(1, 300, 200, "mouse");
  h.up(1, 300, 200, "mouse");
  assert.equal(h.cam.zoom, Z0, "double-click started zooming on desktop");
  assert.equal(h.input.consumedGesture(), false, "double-click now swallows a desktop selection");
});

// ---------------------------------------------------------------------------
// §3.6 — wheel deltaMode (fault I6)
// ---------------------------------------------------------------------------

test("wheelPixels: pixel mode passes through; a line-mode notch matches a pixel-mode notch", () => {
  assert.equal(wheelPixels(-100, 0), -100, "Chrome/Safari pixel deltas changed");
  assert.equal(wheelPixels(53, 0), 53);
  // Firefox sends one notch as deltaY 3, deltaMode 1. Read as 3 PIXELS it zoomed by
  // exp(3*0.0015) = 0.45% instead of exp(100*0.0015) = 16.2% — fault I6.
  assert.equal(wheelPixels(3, 1), 100, "a Firefox notch no longer equals a Chrome notch");
  assert.equal(wheelPixels(-3, 1), -100);
  // Page mode is ONE detent in the scroll's direction, whatever `deltaY` says — the
  // magnitude must not scale with it, or the "not an unbounded jump" the comment
  // promises is only true at |deltaY| === 1 (review finding on #267).
  assert.equal(wheelPixels(1, 2), 100, "page mode should behave as one detent, not one pixel");
  assert.equal(wheelPixels(4, 2), 100, "page mode scaled with deltaY instead of being one detent");
  assert.equal(wheelPixels(-4, 2), -100, "page mode lost the scroll direction");
  assert.equal(wheelPixels(0, 2), 0, "a zero page delta should move nothing");
});

test("a Firefox line-mode notch and a Chrome pixel notch zoom by the same amount", () => {
  const chrome = harness();
  chrome.wheel(195, 400, -100, 0);
  const firefox = harness();
  firefox.wheel(195, 400, -3, 1);
  assert.ok(
    Math.abs(chrome.cam.zoom - firefox.cam.zoom) < 1e-18,
    `chrome ${chrome.cam.zoom} vs firefox ${firefox.cam.zoom} for the same physical notch`,
  );
});

// ---------------------------------------------------------------------------
// pinchFrame + the clamp
// ---------------------------------------------------------------------------

test("pinchFrame needs two pointers and reads only the first two", () => {
  assert.equal(pinchFrame([]), null);
  assert.equal(pinchFrame([{ x: 1, y: 2 }]), null);
  const two = pinchFrame([
    { x: 100, y: 400 },
    { x: 200, y: 400 },
  ]);
  assert.deepEqual(two, { midX: 150, midY: 400, dist: 100 });
  const three = pinchFrame([
    { x: 100, y: 400 },
    { x: 200, y: 400 },
    { x: 999, y: 999 },
  ]);
  assert.deepEqual(three, two, "a third pointer moved the anchor");
});

test("pinchCamera clamps the zoom BEFORE placing the anchor, so the anchor holds at the limit", () => {
  // setCameraState clamps zoom but not center: an anchor placed for a zoom that then
  // gets clamped away drifts, which reads as the content sliding when you pinch past
  // the zoom-out limit.
  const cam: CameraState = { center: [0.5, 0.5], zoom: Z0 };
  const maxZoom = Z0 * 1.5; // a clamp that BINDS on this step
  const prev = { midX: 100, midY: 200, dist: 200 };
  const next = { midX: 140, midY: 260, dist: 50 }; // a 4x squeeze, well past the clamp
  const w: [number, number] = [
    cam.center[0] + (prev.midX - VIEWPORT.width / 2) * cam.zoom,
    cam.center[1] + (prev.midY - VIEWPORT.height / 2) * cam.zoom,
  ];
  const after = pinchCamera(cam, VIEWPORT, prev, next, (z) => Math.min(maxZoom, z));
  assert.equal(after.zoom, maxZoom, "the clamp was not applied");
  const [sx, sy] = screenOf(after, VIEWPORT, w);
  assert.ok(
    Math.abs(sx - next.midX) < 1e-9 && Math.abs(sy - next.midY) < 1e-9,
    `the anchor drifted to (${sx}, ${sy}) once the clamp bound`,
  );
});
