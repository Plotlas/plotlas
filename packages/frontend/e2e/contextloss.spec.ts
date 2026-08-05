import { test, expect } from "@playwright/test";
import {
  authenticate,
  forceContextLoss,
  forceContextRestore,
  openViewerV2,
  readViz,
  residentTotal,
  wheelZoom,
  waitForDrawn,
  canvasPngBytes,
  BLANK_PNG_BYTES,
  type VizV2,
} from "./helpers.ts";

// §0.6 — WebGL context-loss recovery ON THE v2 TILE-PYRAMID LOADER (D-33).
//
// A lost GL context wipes every GPU resource. The v2 loader recovers IN PLACE
// (renderer/tilePyramid.ts onContextLost / onContextRestored): preventDefault so the
// browser will restore, haltRenderLoop, drop the dead handles + bump the generation
// (aborting in-flight loads), then on restore reset the cells' bindings, resume the
// loop, and refresh the SAME view so the visible tiles re-fetch + re-bind. A bounded
// watchdog (CONTEXT_RESTORE_TIMEOUT_MS) drives onUnrecoverable → the ViewerScreen
// reload prompt if a loss never restores.
//
// The recovery orchestration is covered HEADLESSLY in tile_pyramid_loader.test.ts
// ("WebGL context loss halts + clears, restore resumes + re-binds", and the
// re-fetch invariant). This browser spec adds the visual/formal surface: on a real
// SwiftShader context it forces the loss with the WEBGL_lose_context extension and
// asserts the acceptance against the v2 __vizDebug shape (renderer/debug.ts,
// published by tilePyramid.ts + cells.ts) — the SAME fields the render gate reads:
// selectedZ / residentByZ / cameraCenter / cameraZoom, plus the read-only
// `contextLosses` counter that positively confirms the loss handler engaged (the
// browser cannot read world.ts's internal `running` flag, and residentByZ is not
// re-published on loss — so without this counter a test could not tell a real
// handled loss from SwiftShader silently absorbing it).
//
// Drives the live compose stack booted by render-gate.yml (calib_small_v2, z_cap=1:
// a real coarse band + a fine band). Auth/signup + SwiftShader launch flags mirror
// render-gate.spec.ts; the fixture is the CI stack's dataset.

const DATASET = process.env.E2E_DATASET ?? "calib_small_v2";

// Wheel-zoom batches to drive the camera from the fit view toward the fine level.
// calib_small_v2 has a shallow pyramid (z_cap=1); a handful of batches reaches fine.
const ZOOM_BATCHES = Number(process.env.ZOOM_BATCHES ?? "20");

test("v2 context loss recovers in place — same view, tiles re-bind, canvas non-blank", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  // Zoom into the fine level so the pre-loss view is NON-default (the whole point:
  // recovery must restore THIS view, not reset to the fit-the-world view) and real
  // fine tiles are resident to lose.
  await wheelZoom(page, ZOOM_BATCHES, -400);
  await waitForDrawn(page);
  await page.waitForTimeout(3_000); // let the fine tiles fetch + decode + bind

  // --- capture the pre-loss view + residency ---------------------------------
  const before = await readViz(page);
  expect(before, "renderer never published __vizDebug").not.toBeNull();
  const b = before as VizV2;
  const beforeResident = residentTotal(b);
  const bytesBefore = await canvasPngBytes(page);
  console.log(
    `[ctxloss:${DATASET}] before: selectedZ=${b.selectedZ} zoom=${b.cameraZoom} ` +
      `center=${JSON.stringify(b.cameraCenter)} resident=${beforeResident} ` +
      `losses=${b.contextLosses} png=${bytesBefore}`,
  );
  expect(beforeResident, "no tiles resident before loss — nothing to lose (zoom never drew fine tiles)").toBeGreaterThan(
    0,
  );
  expect(bytesBefore, "canvas looks blank before loss (tiny PNG)").toBeGreaterThan(BLANK_PNG_BYTES);

  // --- force the context loss ------------------------------------------------
  const lossForced = await forceContextLoss(page);
  expect(lossForced, "WEBGL_lose_context unavailable — cannot simulate a context loss").toBeTruthy();

  // The loss HANDLER must engage (preventDefault + halt + drop residency): the
  // read-only contextLosses counter ticks in onContextLost. This is the positive
  // proof the halt→recovery path ran — not that SwiftShader silently absorbed the
  // loss (the browser can't read world.ts's `running` flag; residentByZ is not
  // re-published on loss).
  await page.waitForFunction(
    (baseline) => {
      const d = (window as unknown as { __vizDebug?: { contextLosses?: number } }).__vizDebug;
      return d !== undefined && typeof d.contextLosses === "number" && d.contextLosses > baseline;
    },
    b.contextLosses,
    { timeout: 20_000 },
  );
  console.log(`[ctxloss:${DATASET}] loss handled (contextLosses ticked past ${b.contextLosses})`);

  // --- restore ---------------------------------------------------------------
  const restoreForced = await forceContextRestore(page);
  expect(restoreForced, "WEBGL_lose_context ext missing for restore").toBeTruthy();

  // Recovery: onContextRestored resets the cells' bindings, resumes the loop, and
  // refreshes the SAME view → the visible tiles re-fetch + re-bind. Wait for the
  // drawn tile set to come back (residentByZ re-published by streamView's
  // publishResidencyDebug once tiles re-bind).
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __vizDebug?: { residentByZ?: Record<number, number> } }).__vizDebug;
      if (d === undefined || d.residentByZ === undefined) return false;
      return Object.values(d.residentByZ).reduce((a, b) => a + b, 0) > 0;
    },
    undefined,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(3_000); // let the re-warm settle before sampling

  const after = await readViz(page);
  const a = after as VizV2;
  const afterResident = residentTotal(a);
  const bytesAfter = await canvasPngBytes(page);
  console.log(
    `[ctxloss:${DATASET}] after: selectedZ=${a.selectedZ} zoom=${a.cameraZoom} ` +
      `center=${JSON.stringify(a.cameraCenter)} resident=${afterResident} png=${bytesAfter}`,
  );

  // === the view is PRESERVED (the SAME camera / level) =======================
  // In-place recovery performs NO camera mutation (the ONLY camera movers —
  // setCameraState / resize — each emit onCameraChange, which updates this mirror),
  // so before == after confirms the view was left untouched. A regression that reset
  // to the default fit view would route through setCameraState, move the mirror, and
  // change selectedZ with it — caught here.
  expect(a.cameraZoom, "zoom changed across recovery — the view was reset, not restored in place").toBeCloseTo(
    b.cameraZoom,
    6,
  );
  expect(a.cameraCenter[0], "camera center x moved across recovery").toBeCloseTo(b.cameraCenter[0], 6);
  expect(a.cameraCenter[1], "camera center y moved across recovery").toBeCloseTo(b.cameraCenter[1], 6);
  expect(a.selectedZ, "selected pyramid level changed across recovery (reset toward the default view?)").toBe(
    b.selectedZ,
  );

  // === it RECOVERED (not a dead / permanently-grey canvas) ===================
  expect(afterResident, "no tiles resident after restore — the canvas did not re-bind (stuck grey/dead)").toBeGreaterThan(
    0,
  );
  expect(bytesAfter, "canvas looks blank after restore — did not re-render (dead canvas)").toBeGreaterThan(
    BLANK_PNG_BYTES,
  );
  // Nothing left on the grey placeholder in view on the settled, restored camera.
  expect(a.placeholderCellsInView, "grey placeholder persists in view after recovery").toBeLessThanOrEqual(2);
});

// §0.6 watchdog — the UNRECOVERABLE path. preventDefault() on webglcontextlost is
// required for the browser to fire webglcontextrestored, but it also means a
// PERMANENT loss never restores. Rather than leave the user on a halted, grey canvas
// forever, the loader arms a bounded watchdog (CONTEXT_RESTORE_TIMEOUT_MS ~10s): if
// no restore arrives it calls onUnrecoverable and ViewerScreen surfaces a reload
// prompt (a <p role="alert"> — ViewerScreen.ts). Here we force a loss and
// DELIBERATELY never restore (WEBGL_lose_context holds the context lost until
// restoreContext()), then assert the prompt appears.
test("v2 context loss that never restores surfaces a reload prompt (watchdog)", async ({ page, request, baseURL }) => {
  test.setTimeout(60_000);
  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);
  await waitForDrawn(page); // ensure the loader/loop is live before killing the context

  // Force the loss and NEVER call forceContextRestore — the context stays lost, so
  // webglcontextrestored never fires and the watchdog must take over.
  const lossForced = await forceContextLoss(page);
  expect(lossForced, "WEBGL_lose_context unavailable — cannot simulate a context loss").toBeTruthy();

  // The reload prompt (role="alert", set by ViewerScreen's onUnrecoverable) appears
  // once the watchdog fires (~10s). Generous timeout vs. CONTEXT_RESTORE_TIMEOUT_MS.
  await expect(page.getByRole("alert"), "watchdog never surfaced the reload prompt").toContainText(
    /reload the page/i,
    { timeout: 25_000 },
  );
});
