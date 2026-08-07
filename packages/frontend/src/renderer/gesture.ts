// Pure gesture math for the renderer's input model — Seam M1 of the mobile-viewer
// workstream (docs/plan/SCOPE_mobile-viewer.md §1b faults I1/I3/I4/I6, decisions D3/D4;
// brief docs/prompts/brief_touch_input_seam.md §2c).
//
// PURE BY CONSTRUCTION: no DOM, no THREE, no React, no module-level state. The single
// import is `import type`, which is erased at emit (verbatimModuleSyntax) and by node's
// type stripping — so at runtime this module imports nothing at all. That is what makes
// every decision in here pinnable in the free test tier: `createWorld` needs a real
// WebGL canvas (tests/frontend_skeleton.test.ts pins it), so anything left inside it is
// unreachable there.
//
// The camera convention this file is written against: `zoom` is WORLD UNITS PER SCREEN
// PIXEL. Zooming IN therefore makes `zoom` SMALLER. Every sign in here follows from
// that one fact.
import type { CameraState, Viewport } from "./world.ts";

/** One active pointer's position, in client (screen) pixels. */
export interface PointerSample {
  x: number;
  y: number;
}

/** Two pointers reduced to what a pinch step needs: where the gesture is anchored
 *  (the midpoint) and how far apart the fingers are. */
export interface PinchFrame {
  midX: number;
  midY: number;
  dist: number;
}

/** A completed tap: where and when, for double-tap detection. `t` is milliseconds
 *  from any monotonic-enough clock — the caller owns timekeeping so this file stays
 *  pure (world.ts passes `Date.now()`). */
export interface TapRecord {
  x: number;
  y: number;
  t: number;
}

// --- constants, each derived or carrying what would make it wrong -----------------

/** Mouse/pen tap tolerance. This is the 4px literal that used to live in
 *  `ui/ViewerScreen.ts`'s `handleCanvasClick`, moved here UNCHANGED so desktop keeps
 *  the tolerance it shipped with. */
const MOUSE_TAP_TOLERANCE_PX = 4;

/** Touch tap tolerance. Derived from the platform threshold for the SAME decision:
 *  Android's `ViewConfiguration` touch slop is 8 dp — the value the OS itself uses to
 *  call a finger movement a scroll rather than a tap — and 1 dp is 1 CSS px in a
 *  browser at default page zoom. Rounded up to cover the top of the 5-10px jitter band
 *  SCOPE §1b I4 attributes to finger taps. NOTE that band is the scope's assertion, not
 *  a device measurement (nothing in this workstream has run on a phone — SCOPE §6), so
 *  the number that can settle it is the D6 real-device pass.
 *  What would make this WRONG: if a deliberate short finger pan of under 10px starts
 *  selecting cells instead of panning, it is too large; if taps on a phone are still
 *  swallowed as drags, too small. */
const TOUCH_TAP_TOLERANCE_PX = 10;

/** Double-tap window. `ViewConfiguration.DOUBLE_TAP_TIMEOUT` on Android is 300ms — the
 *  platform's own answer to this exact question, so it is not a fresh pick.
 *  What would make this WRONG: too long and two deliberate taps on two different images
 *  zoom instead of selecting; too short and a natural double-tap does not register. */
export const DOUBLE_TAP_MS = 300;

/** How far one double-tap zooms IN, as a linear factor. 2x is one map zoom level, the
 *  step every map UI uses for this gesture. Applied as `zoom / 2` because `zoom` is
 *  world units per screen pixel.
 *  What would make this WRONG: it is a FEEL constant — if a double-tap overshoots past
 *  the image the user aimed at, or is so small it reads as no response, this is the
 *  number to move, and only the D6 real-device pass can see either. */
export const DOUBLE_TAP_ZOOM_STEP = 2;

/** Pixels of `wheel` delta one detent produces. Two INHERITED platform conventions, not
 *  measurements taken here: Chromium reports a notch as ~100px in `deltaMode: 0`, and
 *  Firefox reports the same physical notch as 3 LINES (`deltaY: 3, deltaMode: 1`).
 *  Equating one notch across the two is what derives the line and page conversions
 *  below instead of picking them. The arithmetic that IS checked here: at the shipped
 *  WHEEL_ZOOM_RATE of 0.0015, exp(100 * 0.0015) is a 16.2% zoom step and exp(3 * 0.0015)
 *  is 0.45% — the "far too little per notch" of fault I6.
 *  What would make this WRONG: a browser whose notch is not 3 lines, or a Chromium that
 *  changes its per-notch pixel count (which would move the FEEL of the wheel on every
 *  platform, not just the line-mode one). The pins only lock that the two modes agree. */
const WHEEL_NOTCH_PX = 100;
const WHEEL_LINES_PER_NOTCH = 3;

// --- the surface -----------------------------------------------------------------

/**
 * The pinch frame for two active pointers, or null for fewer than two. The caller
 * passes the pointers it considers active, first two by insertion order — a third
 * finger must not move the anchor mid-gesture, so anything past `[0]` and `[1]` is
 * ignored here rather than averaged in.
 */
export function pinchFrame(pointers: PointerSample[]): PinchFrame | null {
  if (pointers.length < 2) return null;
  const a = pointers[0];
  const b = pointers[1];
  return {
    midX: (a.x + b.x) / 2,
    midY: (a.y + b.y) / 2,
    dist: Math.hypot(b.x - a.x, b.y - a.y),
  };
}

/**
 * Camera for a zoom step anchored at a screen point: the world point currently under
 * `(px, py)` is still under `(px, py)` afterwards. This IS the expression the wheel
 * handler shipped with (world.ts, pre-M1) — extracted rather than re-derived, so the
 * mouse path is provably the same math, and shared with double-tap.
 *
 * The returned `focal` is that anchored world point: `world.ts` forwards it as
 * `setCameraState`'s focal so the tile loader orders loads outward from where the user
 * is looking instead of the bbox centre (§0.4 / audit A2).
 *
 * `newZoom` is used as given — the caller clamps FIRST (see `InputCamera.clampZoom`),
 * because a center placed for a zoom that then gets clamped away leaves the anchor
 * drifting.
 */
export function zoomAt(
  cam: CameraState,
  vp: Viewport,
  px: number,
  py: number,
  newZoom: number,
): CameraState {
  const ox = px - vp.width / 2;
  const oy = py - vp.height / 2;
  const wx = cam.center[0] + ox * cam.zoom;
  const wy = cam.center[1] + oy * cam.zoom;
  return { center: [wx - ox * newZoom, wy - oy * newZoom], zoom: newZoom, focal: [wx, wy] };
}

/**
 * Camera for one pinch step (SCOPE decision D3, the FULL version): zoom by the
 * distance ratio, and keep the world point that was under `prev`'s midpoint under
 * `next`'s midpoint — so zoom and reposition are one gesture and content follows the
 * drift every real pinch has.
 *
 * The ratio is `prev.dist / next.dist`, NOT the other way round: `zoom` is world units
 * per screen pixel, so spreading the fingers (`next.dist` larger) must make `zoom`
 * SMALLER. Pinned by "pinchCamera: spreading the fingers zooms IN".
 *
 * `clampZoom` is the caller's existing camera clamp, applied BEFORE the anchor math for
 * the same reason `zoomAt` documents; it defaults to identity so the function is usable
 * unclamped in a test. Degenerate frames (a zero distance — two pointers at the same
 * point) hold the zoom and pan by the midpoint alone.
 */
export function pinchCamera(
  cam: CameraState,
  vp: Viewport,
  prev: PinchFrame,
  next: PinchFrame,
  clampZoom: (zoom: number) => number = (zoom) => zoom,
): CameraState {
  const scalable = prev.dist > 0 && next.dist > 0;
  const newZoom = clampZoom(scalable ? cam.zoom * (prev.dist / next.dist) : cam.zoom);
  // The world point under the PREVIOUS midpoint...
  const wx = cam.center[0] + (prev.midX - vp.width / 2) * cam.zoom;
  const wy = cam.center[1] + (prev.midY - vp.height / 2) * cam.zoom;
  // ...placed under the NEXT midpoint, at the new zoom.
  return {
    center: [wx - (next.midX - vp.width / 2) * newZoom, wy - (next.midY - vp.height / 2) * newZoom],
    zoom: newZoom,
    focal: [wx, wy],
  };
}

/**
 * Movement past which an interaction is a drag, not a tap. Mouse and pen keep the 4px
 * the click path shipped with (so desktop is unchanged); a finger gets more, because
 * coarse pointers jitter — fault I4, "tapping an image on a phone often does nothing".
 */
export function tapTolerancePx(pointerType: string): number {
  return pointerType === "touch" ? TOUCH_TAP_TOLERANCE_PX : MOUSE_TAP_TOLERANCE_PX;
}

/**
 * Is `next` the second tap of a double-tap on `prev`? Within `DOUBLE_TAP_MS` and within
 * the touch tap tolerance — deliberately the SAME radius §3.4 already derives rather
 * than a second constant of its own. (If the D6 real-device pass finds double-tap hard
 * to trigger, this radius is the number to revisit; platforms use a wider slop for the
 * gap between two taps than for one tap's own jitter.)
 */
export function isDoubleTap(prev: TapRecord | null, next: TapRecord): boolean {
  if (prev === null) return false;
  const dt = next.t - prev.t;
  if (!(dt >= 0 && dt <= DOUBLE_TAP_MS)) return false;
  const tol = tapTolerancePx("touch");
  return Math.abs(next.x - prev.x) <= tol && Math.abs(next.y - prev.y) <= tol;
}

/**
 * Normalize a `wheel` event's `deltaY` to pixels — fault I6. `deltaMode` 0 is already
 * pixels and passes through untouched (so Chrome/Safari, and every measurement taken
 * against them, are unchanged). Mode 1 is lines, which is what Firefox sends: a notch
 * arrives as `deltaY: 3` and, read as 3 pixels, zooms by exp(3 * 0.0015) = 0.45% per
 * notch instead of 16.2% — "far too little per notch". Mode 2 is pages; no mainstream
 * browser emits it for `wheel`, and a pure function cannot know a page's height, so it
 * is mapped to ONE notch in the scroll's direction — an unexpected event should behave
 * like one detent rather than like an unbounded jump. Note that is a `Math.sign`, not a
 * multiply: scaling `deltaY` by the notch would be the unbounded jump the sentence
 * above rules out, and would only coincide with one detent at `|deltaY| === 1`.
 */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return (deltaY * WHEEL_NOTCH_PX) / WHEEL_LINES_PER_NOTCH;
  if (deltaMode === 2) return Math.sign(deltaY) * WHEEL_NOTCH_PX;
  return deltaY;
}
