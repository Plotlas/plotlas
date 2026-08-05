import { test, expect } from "@playwright/test";
import { authenticate, openViewer, startRecorder, stopRecorder, switchLayout } from "./helpers.ts";

// v2 INSTANT layout switch (feat/fast-layout-switch). The old spec gated the
// D-10 position tween, which is DELETED: switchTo no longer stages the target
// layout's full fine tier (>= 15,625 tiles at 1M) and lerps — it swaps
// instantly, camera preserved, keeping the OLD layout's coarse overview drawn
// as a backdrop (the loader's condemned set) while the NEW layout streams
// coarse-first for the live view. This spec gates the three user-visible
// properties of that design:
//   1. IMMEDIATE START — the first request against the target layout's pyramid
//      container is issued within a breath of the click (design bound ~100ms:
//      the switch path is synchronous; the budget below allows headless
//      scheduling noise), instead of after a full-tier staging download.
//   2. NEVER BLANK — at every sampled instant of the switch something is drawn
//      (rendererDebug.residentByZ counts active tiles PLUS the condemned
//      backdrop, so the sum only reaches 0 if the canvas really blanked).
//   3. SHARPENS — after the switch settles, the new layout's tiles are bound
//      (in-flight drains to 0) and no in-view cell is left on the grey
//      placeholder.
//
// Browser-only (NOT part of the `make test-frontend` CI gate); run against a
// live stack with a REAL multi-layout bake (e.g. inat_10k / inat_100k — the
// golden fixture has a single layout and no coarse band). NB the live dev stack
// bind-mounts the MAIN repo checkout, not a worktree — run from main after
// merge, or swap the frontend container (see project notes).
const DATASET = process.env.E2E_DATASET ?? "inat_10k";
const TARGET_LAYOUT = process.env.E2E_SWITCH_LAYOUT ?? "Observation location";

/** Design bound is ~100ms (the switch path is synchronous with the click); the
 *  budget allows headless CI scheduling noise without masking the old failure
 *  mode, which was tens of SECONDS of staging download before the first
 *  new-layout request. */
const FIRST_REQUEST_BUDGET_MS = 250;
const SETTLE_TIMEOUT_MS = 30_000;

test("layout switch starts streaming the target layout immediately, never blanks, and sharpens", async ({
  page,
  request,
  baseURL,
}) => {
  const auth = await authenticate(request, baseURL ?? "");
  await openViewer(page, auth, DATASET);

  // Resolve the target layout's id from the manifest listing so the network
  // trace can discriminate its pyramid container URL (…/pyramid/{layout_id}…).
  const layouts = (await (
    await request.get(`${baseURL}/api/datasets/${DATASET}/layouts`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
  ).json()) as { layout_id: string; label: string }[];
  const target = layouts.find((l) => l.label === TARGET_LAYOUT || l.layout_id === TARGET_LAYOUT);
  expect(target, `dataset ${DATASET} declares layout '${TARGET_LAYOUT}'`).toBeTruthy();

  // Network trace: first request that touches the TARGET layout's pyramid.
  let firstTargetRequestAt: number | null = null;
  page.on("request", (req) => {
    if (firstTargetRequestAt === null && req.url().includes(`/pyramid/${target!.layout_id}`)) {
      firstTargetRequestAt = Date.now();
    }
  });

  // Record the debug state across the whole switch (80ms cadence).
  await startRecorder(page);
  const clickedAt = Date.now();
  await switchLayout(page, TARGET_LAYOUT);

  // 3. SHARPENS: the switch settles — tiles bound for the new layout, nothing
  // in flight, and no in-view cell left on the grey placeholder.
  await page.waitForFunction(
    () => {
      const d = (
        window as unknown as {
          __vizDebug?: {
            residentByZ: Record<number, number>;
            loadingTiles: number;
            placeholderCellsInView: number;
          };
        }
      ).__vizDebug;
      if (d === undefined) return false;
      const drawn = Object.values(d.residentByZ).reduce((a, b) => a + b, 0);
      return drawn > 0 && d.loadingTiles === 0 && d.placeholderCellsInView === 0;
    },
    undefined,
    { timeout: SETTLE_TIMEOUT_MS },
  );
  const samples = await stopRecorder(page);

  // 1. IMMEDIATE START: the first new-layout pyramid request follows the click
  // within the budget — not after a full-fine-tier staging download.
  expect(firstTargetRequestAt, "the switch requested the target layout's pyramid").not.toBeNull();
  const delay = firstTargetRequestAt! - clickedAt;
  console.log(`[switch] first ${target!.layout_id} pyramid request ${delay}ms after the click`);
  expect(delay, `first new-layout request took ${delay}ms`).toBeLessThanOrEqual(FIRST_REQUEST_BUDGET_MS);

  // 2. NEVER BLANK: at every sampled instant something was drawn — the old
  // layout's condemned coarse backdrop covers the window before the new coarse
  // floor binds, so the drawn-tile sum never touches 0 mid-switch.
  const drawnPerSample = samples.map((s) =>
    Object.values(s.residentByZ ?? {}).reduce((a, b) => a + b, 0),
  );
  console.log(`[switch] samples=${samples.length} drawnPerSample=${JSON.stringify(drawnPerSample)}`);
  expect(samples.length, "recorder captured the switch").toBeGreaterThan(2);
  expect(
    drawnPerSample.every((n) => n > 0),
    `canvas went blank mid-switch (drawn-tile counts: ${JSON.stringify(drawnPerSample)})`,
  ).toBeTruthy();
});
