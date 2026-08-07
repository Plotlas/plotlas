import { test, expect } from "@playwright/test";
import { authenticate, openViewerV2, readViz } from "./helpers.ts";

// Seam M1 — a real two-finger pinch changes the zoom (SCOPE_mobile-viewer decision
// D6(c): "pure-function pins in the free tier AND one mobile-viewport e2e assertion").
//
// What this adds over the free-tier pins in tests/touch_input.test.ts, which already
// cover the math and the bookkeeping: those drive `createPointerInput` directly, because
// `createWorld` needs a real WebGL context. This drives the BROWSER — real touch points,
// the browser's own touch-to-pointer translation, `touch-action: none` actually
// delivering the events, real pointer capture, and the live camera. If the listeners
// were never bound, or `touch-action` were relaxed so the browser swallowed the pinch,
// only this can see it.
//
// TOUCH COMES FROM `test.use` BELOW, NOT FROM A PROJECT (settled after review of #266).
// M1 originally required a second `projects[]` entry with `devices["iPhone 13"]`, because
// the single `Desktop Chrome` project has no touch — CDP touch dispatch is rejected there
// and `navigator.maxTouchPoints` is 0. A file-scope `test.use({ hasTouch: true })` gives
// this ONE file its own context options instead, which is strictly better:
//
//   * no second project, so nothing multiplies the OTHER specs by two — the hazard that
//     made the projects[] route need a `testMatch` guard in the first place;
//   * the touch requirement travels WITH the spec that needs it, so it cannot be lost by
//     someone editing the config for an unrelated reason.
//
// The `hasTouch` assertion below is now a real precondition check rather than a skip: if
// this file's context ever comes up without touch, that is a broken harness and the spec
// must FAIL, not quietly pass. A touch assertion that silently ran without touch would be
// worse than none.

const DATASET = process.env.E2E_DATASET ?? "calib_small_v2";

// The iPhone-14-class layout viewport SCOPE §1a measured against.
const PHONE = { width: 390, height: 844 };

// File-scope context options: real touch points + the phone viewport, for this spec only.
// This is the ONE place the viewport is set — the context is created at PHONE, so a
// `page.setViewportSize(PHONE)` in the test body would be a second copy of the same
// number that can drift out of step with this one.
test.use({ hasTouch: true, viewport: PHONE });

interface TouchPoint {
  x: number;
  y: number;
  id: number;
}

test("a two-finger pinch zooms the atlas", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);

  // Precondition, not a skip: `test.use({ hasTouch: true })` above guarantees this. If it
  // is ever false the harness is broken and every touch assertion below would be vacuous,
  // so fail loudly instead of reporting a green skip.
  const hasTouch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  expect(
    hasTouch,
    "this context has no touch despite test.use({ hasTouch: true }) — the pinch assertions " +
      "below would be vacuous, so the harness is the bug",
  ).toBe(true);

  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  const box = await page.locator("canvas.atlas-canvas").boundingBox();
  expect(box, "canvas has no bounding box").not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;

  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: string, points: TouchPoint[]): Promise<void> => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
  };
  /** Drive the two fingers from `from` px apart to `to` px apart, horizontally about
   *  the canvas centre, in steps — one jump would be a single pinch frame and would not
   *  exercise the frame-to-frame differencing at all. */
  const pinch = async (from: number, to: number, steps = 8): Promise<void> => {
    const at = (half: number): TouchPoint[] => [
      { x: cx - half, y: cy, id: 1 },
      { x: cx + half, y: cy, id: 2 },
    ];
    await touch("touchStart", at(from / 2));
    for (let i = 1; i <= steps; i++) {
      await touch("touchMove", at((from + ((to - from) * i) / steps) / 2));
      await page.waitForTimeout(20);
    }
    await touch("touchEnd", []);
  };

  const before = await readViz(page);
  expect(before, "the renderer never published its debug state").not.toBeNull();

  // Spreading the fingers zooms IN. `cameraZoom` is world units per screen pixel, so
  // zooming in makes it SMALLER — the sign the free-tier pin also locks.
  await pinch(80, 320);
  const spread = await readViz(page);
  expect(
    spread!.cameraZoom,
    `spreading two fingers gave zoom ${spread!.cameraZoom}, expected < ${before!.cameraZoom}`,
  ).toBeLessThan(before!.cameraZoom);

  // ...and bringing them together zooms back out.
  await pinch(320, 80);
  const squeezed = await readViz(page);
  expect(
    squeezed!.cameraZoom,
    `pinching in gave zoom ${squeezed!.cameraZoom}, expected > ${spread!.cameraZoom}`,
  ).toBeGreaterThan(spread!.cameraZoom);
});
