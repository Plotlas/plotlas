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
// WHERE THIS RUNS (SCOPE_e2e-strategy.md §2c). Browser-only — not part of the
// GL-free `make test-frontend` tier. It now runs in the PR-blocking render gate
// against `golden_dataset_full_v2`, the committed 6-layout fixture that
// docker-compose.yml already mounts into api + worker + caddy (E2E_DATASET +
// E2E_SWITCH_LAYOUT="By date"). Before that it was parked in e2e-nightly.yml and had
// NEVER EXECUTED ANYWHERE: that workflow hard-failed on a repo variable nobody had
// set, 50 runs, 0 tests, 18 of them green. Its cited blocker — "needs a real
// multi-layout bake" — was about `golden_dataset_v2` (single layout, no coarse
// band); `golden_dataset_full_v2` is a different, richer fixture and was already
// sitting in the same stack.
//
// The env knobs also drive the [[T2-41]] SCALE path (inat_10k / inat_100k / inat_1m),
// which runs LOCALLY — recipe in ./README.md. There is deliberately no live-target
// input on the render gate: the only correct target would be a dev-build stack a
// GitHub runner can reach, and none exists.
//
// WHICH STACK: the BASE compose profile (`docker compose up`) runs the vite DEV
// server, so `import.meta.env.DEV` is true and `window.__vizDebug` is published —
// that is the supported target. The PROD OVERLAY (`-f docker-compose.prod.yml`)
// serves a built bundle where it is never published, and NO spec here can be driven
// against it: they all wait on that object. Check with
// `curl -s localhost:8080/ | grep @vite/client` before blaming a spec.
//
// NB compose mounts `.:/repo`, so `docker compose up` serves whichever CHECKOUT it
// was invoked from. Run it from the worktree you mean to test, or you will be
// measuring main while believing you are measuring your branch.
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
  // The config default is 90 s, and this spec is documented (above, and in README.md)
  // as the [[T2-41]] scale path. `render-gate.spec.ts` already measured 2.2 min against
  // inat1m_v2, and `openViewer` alone can eat most of 90 s there before
  // SETTLE_TIMEOUT_MS even starts — so the documented run would die as a bare test
  // timeout naming no phase. Matches render-gate.spec.ts for the same reason.
  test.setTimeout(300_000);
  const auth = await authenticate(request, baseURL ?? "");
  await openViewer(page, auth, DATASET);

  // Resolve the target layout's id from the manifest listing so the network
  // trace can discriminate its pyramid container URL (…/pyramid/{layout_id}…).
  // GET /api/datasets/{id}/layouts answers with an OBJECT — `LayoutListResponse`,
  // `{ layouts: [...] }` (api/routers/layouts.py), which is exactly what the app's own
  // api-client `listLayouts` unwraps. This spec read the body as a BARE ARRAY, and had
  // done since it was written: the `as` cast made the type checker agree, and because
  // the spec had never executed anywhere, nothing else ever disagreed. It surfaced on
  // the very first run, as `TypeError: layouts.find is not a function`.
  const body = (await (
    await request.get(`${baseURL}/api/datasets/${DATASET}/layouts`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
  ).json()) as { layouts: { layout_id: string; label: string }[] };
  // A PRECONDITION, not one of the three gated properties: if this route's shape drifts
  // again, say so in one line instead of throwing a TypeError from inside `.find`.
  expect(
    Array.isArray(body?.layouts),
    `GET /api/datasets/${DATASET}/layouts did not answer { layouts: [...] } — got ${JSON.stringify(body).slice(0, 200)}`,
  ).toBe(true);
  const target = body.layouts.find((l) => l.label === TARGET_LAYOUT || l.layout_id === TARGET_LAYOUT);
  expect(target, `dataset ${DATASET} declares layout '${TARGET_LAYOUT}'`).toBeTruthy();

  // The pyramid CONTAINER PATH, read from the manifest exactly as the app's own
  // api-client `pyramidUrl` reads it — not spelled out here. This spec used to look for
  // `/pyramid/{layout_id}` in the request URL, which is the API FALLBACK route
  // (`/api/datasets/{ds}/pyramid/{id}.pmtiles`) that the renderer in practice never
  // takes: `pyramidUrl` prefers the STATIC, version-embedded Caddy path from the
  // manifest (`/datasets/{ds}/tiles/{id}/{id}_v1.pmtiles`) whenever the manifest is
  // cached, and `LayoutController.activate` always fetches the manifest before opening
  // the archive. So the discriminator could only ever fail to match, and — because this
  // spec had never executed anywhere — nothing said so. Deriving it from the manifest
  // means the next producer-side path change cannot silently blind this assertion.
  const layoutManifest = (await (
    await request.get(`${baseURL}/api/datasets/${DATASET}/layouts/${target!.layout_id}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
  ).json()) as { layouts: { layout_id: string; pyramid?: { path?: string } }[] };
  const pyramidPath = layoutManifest.layouts?.find((l) => l.layout_id === target!.layout_id)
    ?.pyramid?.path;
  expect(
    pyramidPath,
    `layout ${target!.layout_id} declares no pyramid.path in its manifest, so the network` +
      ` trace below would have nothing to look for`,
  ).toBeTruthy();

  // ---- assertion 1's instrument: measured ENTIRELY INSIDE THE PAGE, on one clock ----
  //
  // The design claim is narrow — "the switch path is SYNCHRONOUS with the click" — so the
  // window being measured has to be click-event -> first-target-request and nothing else.
  // Stamping the start in the Node process (`Date.now()` before `switchLayout`) does not
  // do that: it also swallows Playwright resolving the locator, its four actionability
  // checks, and the CDP round trip, none of which is the renderer. Measured that way the
  // same commit produced 141 / 313 / 332 / 477 / 507 ms against a 250 ms budget — a 3.6x
  // spread with nothing changing but the runner's mood, which is the signature of harness
  // noise, not of a synchronous code path. So the probe below runs in the page:
  //
  //   * a CAPTURE-phase listener on the switcher stamps `performance.now()` when the real
  //     click event arrives — ahead of React's own bubble-phase onClick, so it cannot
  //     include any of the switch work it is timing;
  //   * a PerformanceObserver over `resource` entries catches the pyramid fetch. PMTiles
  //     Range-reads the one container, so every tile read carries the same URL, and the
  //     stack is same-origin (caddy serves both the app and /datasets) so the entries
  //     carry real timings rather than being opaque.
  //
  // Both readings are `performance.now()` in the SAME document, so the subtraction is
  // exact and no clock is crossed. The Node-side number is still collected below, but it
  // is LOGGED ONLY — keeping it visible is what makes the harness cost measurable instead
  // of assumed the next time this drifts.
  await page.evaluate(
    ([needle, fallback]) => {
      const w = window as unknown as { __switchProbe?: unknown };
      const probe = { clickedAt: null as number | null, firstAt: null as number | null };
      w.__switchProbe = probe;
      // Deliberately NOT optional-chained. A markup rename would otherwise make this
      // probe a silent no-op, and the failure would surface far below as "the tab was
      // found but the click did not land" — naming the wrong cause and sending the next
      // debugger at the click path. Fail here, where the cause is.
      const switcher = document.querySelector(".layout-switcher");
      if (switcher === null) throw new Error("no .layout-switcher to attach the click probe to");
      switcher.addEventListener(
        "click",
        () => {
          if (probe.clickedAt === null) probe.clickedAt = performance.now();
        },
        { capture: true },
      );
      const record = (name: string, startTime: number): void => {
        // Only entries AFTER the click count: `buffered: true` replays everything the
        // document has already fetched, and boot's own requests must not be mistaken for
        // the switch's first one (that would report a negative delay).
        if (probe.clickedAt === null || startTime < probe.clickedAt) return;
        if (probe.firstAt === null && (name.includes(needle) || name.includes(fallback))) {
          probe.firstAt = startTime;
        }
      };
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) record(e.name, e.startTime);
      }).observe({ type: "resource", buffered: true });
    },
    [pyramidPath as string, `/pyramid/${target!.layout_id}.pmtiles`] as const,
  );

  // The Node-side view of the same event — DIAGNOSTIC ONLY, never asserted. Its gap from
  // the in-page number IS the harness cost.
  let harnessFirstAt: number | null = null;
  // A Set, not an array: PMTiles Range-reads the SAME container URL once per tile, so on
  // the documented 1M run an array reaches thousands of identical strings held for the
  // test's lifetime. Only 25 unique values are ever printed — dedupe on insert rather
  // than paying for the duplicates and discarding them at print time.
  const seenUrls = new Set<string>();
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes(DATASET) && seenUrls.size < 50) seenUrls.add(url);
    if (harnessFirstAt === null && url.includes(pyramidPath as string)) harnessFirstAt = Date.now();
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
  const probe = await page.evaluate(
    () =>
      (window as unknown as {
        __switchProbe?: { clickedAt: number | null; firstAt: number | null };
      }).__switchProbe ?? null,
  );
  expect(probe, "the in-page switch probe was not installed").not.toBeNull();
  expect(
    probe!.clickedAt,
    "the layout switcher never received a click event — the tab was found but the click did not land",
  ).not.toBeNull();
  expect(
    probe!.firstAt,
    `the switch requested the target layout's pyramid (${pyramidPath}). Requests seen ` +
      `mentioning ${DATASET}: ${JSON.stringify(Array.from(seenUrls).slice(0, 25), null, 1)}`,
  ).not.toBeNull();
  const delay = Math.round(probe!.firstAt! - probe!.clickedAt!);
  // Logged side by side on purpose: `harness` is the same event measured from the Node
  // process, so the gap between them is Playwright's own cost. If `delay` is ever healthy
  // while `harness` is huge, the runner is loaded and the renderer is not the story.
  const harness = harnessFirstAt === null ? "n/a" : `${harnessFirstAt - clickedAt}ms`;
  console.log(
    `[switch] first ${target!.layout_id} pyramid request ${delay}ms after the click ` +
      `(in-page clock; harness-inclusive ${harness})`,
  );
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
