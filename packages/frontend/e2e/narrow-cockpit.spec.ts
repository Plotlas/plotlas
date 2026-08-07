import { test, expect } from "@playwright/test";
import { authenticate, openViewerV2, waitForDrawn, wheelZoom } from "./helpers.ts";

// Seam M2 — the narrow-screen layout model (SCOPE_mobile-viewer T2-202, decisions D1/D2,
// and Constraint M-1 from D5). Brief §5.6 / §5.7.
//
// WHY THIS IS AN E2E CASE AND NOT A FREE-TIER PIN. jsdom does no layout: every
// getBoundingClientRect() is zero and no stylesheet is applied, so the DOM tier
// (tests/dom/narrow_layout.dom.test.ts) can pin the DERIVATION and the STRUCTURE and
// nothing else. Two of this seam's acceptance criteria are irreducibly geometric:
//
//   * the desktop cockpit's rails are still at x = 14…250 and x = 979…1251 at 1265px
//     (the non-regression the whole workstream is bounded by — SCOPE §4.1); and
//   * CONSTRAINT M-1: at 390px the Inspector sheet AT PEEK does not intersect the
//     minimap. That is the condition SCOPE D5 was approved under — the minimap is the
//     visitor's "where am I relative to the whole collection" instrument, and it shipped
//     at right:14px/bottom:40px, exactly where a bottom sheet goes.
//
// Both are single rect comparisons in a real engine, and neither is expressible in the
// tier below.
//
// WHERE THIS RUNS: the `render-gate.yml` workflow, as a named step on the stack the
// render / context-loss / mobile-containment / mobile-pinch gates already boot. NOT
// e2e-nightly.yml — that workflow hard-fails without a `vars.E2E_BASE_URL` repo variable
// which is not set, so a spec parked there has never executed anywhere but a developer's
// machine, and a gate that never runs is worse than none because it reads as coverage.
//
// NO `projects[]` ENTRY: this file sets its own viewport per test, so neither assertion
// can quietly pass at the wrong width, and it needs no touch emulation. A second project
// would multiply every other spec by two.

const DATASET = process.env.E2E_DATASET ?? "calib_small_v2";

// The two viewports the brief pins, both measured on the live build 2026-08-05.
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1265, height: 900 };

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/** One element's rect, or null when it is not rendered. Rounded to 0.1px so a failure
 *  message quotes a number a human can compare with the brief. */
async function rectOf(page: import("@playwright/test").Page, selector: string): Promise<Rect | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    const round = (n: number): number => Math.round(n * 10) / 10;
    return {
      left: round(r.left),
      right: round(r.right),
      top: round(r.top),
      bottom: round(r.bottom),
      width: round(r.width),
      height: round(r.height),
    };
  }, selector);
}

// ---------------------------------------------------------------------------
// §5.6 — desktop non-regression
// ---------------------------------------------------------------------------

test("the desktop cockpit is unchanged at 1265x900", async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DESKTOP);

  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.clientWidth).toBe(DESKTOP.width);
  expect(doc.scrollWidth, `the page scrolls sideways: ${doc.scrollWidth} vs ${doc.clientWidth}`).toBe(
    doc.clientWidth,
  );

  // The mode is DERIVED, so "desktop is untouched" is first of all a claim that the
  // derivation said desktop here. Assert it directly rather than inferring it.
  expect(
    await page.locator(".viewer-screen.cockpit-narrow").count(),
    "a 1265px viewport went NARROW — the derived threshold is over-firing",
  ).toBe(0);

  // The rails, at the exact coordinates SCOPE §1a measured on the live build.
  const tagRail = await rectOf(page, ".tag-rail");
  expect(tagRail, "no .tag-rail rendered at desktop width").not.toBeNull();
  expect([tagRail!.left, tagRail!.right]).toEqual([14, 250]);

  const inspector = await rectOf(page, ".inspector");
  expect(inspector, "no .inspector rendered at desktop width").not.toBeNull();
  expect([inspector!.left, inspector!.right]).toEqual([979, 1251]);

  // One tab per layout, from the manifest rather than from a number written here — the
  // count is dataset-dependent and that is the whole point of the derived threshold.
  const layoutCount = await page.evaluate(async () => {
    const el = document.querySelectorAll(".layout-switcher .layout-tab");
    return el.length;
  });
  const manifestLayouts = await page.evaluate(() => {
    // The switcher renders one button per manifest layout; the menu must not exist here.
    return {
      tabs: document.querySelectorAll(".layout-switcher .layout-tab").length,
      menus: document.querySelectorAll(".viewer-menu-wrap").length,
    };
  });
  expect(layoutCount, "the desktop tab row rendered no tabs").toBeGreaterThan(0);
  expect(manifestLayouts.menus, "the narrow ☰ menu leaked into the desktop cockpit").toBe(0);

  // The search pill is still a child of the top bar (D2 moves it into the menu on
  // narrow ONLY).
  expect(await page.locator(".cockpit-topbar > .topbar-search").count()).toBe(1);
  // ...and the interim scroll strip M0 left for this seam is gone.
  const stripOverflow = await page.evaluate(() => {
    const el = document.querySelector(".layout-switcher");
    return el === null ? null : getComputedStyle(el).overflowX;
  });
  expect(stripOverflow, "the layout tabs are still a horizontal scroll strip").not.toBe("auto");
});

// ---------------------------------------------------------------------------
// §5.7 — narrow acceptance, including Constraint M-1
// ---------------------------------------------------------------------------

test("at 390x844 the atlas is the screen, and the sheet at peek clears the minimap", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);

  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  // The whole page still contains itself (M0's assertion, re-checked because M2 replaces
  // the chrome that was making it fail).
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.clientWidth).toBe(PHONE.width);
  expect(doc.scrollWidth, `the page scrolls sideways: ${doc.scrollWidth} vs ${doc.clientWidth}`).toBe(
    doc.clientWidth,
  );

  await expect(page.locator(".viewer-screen.cockpit-narrow")).toHaveCount(1);

  // "The rails are not collapsed on narrow — they are not rendered" (brief §3.3). The
  // collapsed chevrons too: a rail reachable behind a 36px chevron is still the rail.
  expect(await page.locator(".tag-rail").count(), "the tag rail is rendered at 390px").toBe(0);
  expect(await page.locator(".inspector").count(), "the inspector rail is rendered at 390px").toBe(0);
  expect(await page.locator(".rail-collapsed").count(), "a rail chevron is rendered at 390px").toBe(0);

  // Every layout is reachable from the ☰ — the "hidden layouts" risk D2 was decided
  // against. The expected count comes from the API, not from a number written here: the
  // count is dataset-dependent and hardcoding it would make this spec pass on a fixture
  // and lie about a real collection.
  const layoutsResp = await request.get(`${baseURL}/api/datasets/${DATASET}/layouts`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(layoutsResp.ok(), `GET layouts failed (${layoutsResp.status()})`).toBe(true);
  const baked = ((await layoutsResp.json()) as { layouts: unknown[] }).layouts.length;
  expect(baked, "the collection declares no layouts to compare against").toBeGreaterThan(0);

  await expect(page.locator(".viewer-menu-wrap")).toHaveCount(1);
  await page.locator(".viewer-menu-btn").click();
  expect(
    await page.locator(".viewer-menu-layout").count(),
    `the menu lists fewer layouts than the collection bakes (${baked})`,
  ).toBe(baked);
  // The trigger is labelled, not a bare glyph (D2's one designed-against risk).
  const triggerText = (await page.locator(".viewer-menu-btn").innerText()).trim();
  expect(triggerText.replace("☰", "").trim().length, "the ☰ trigger carries no label").toBeGreaterThan(0);
  await page.keyboard.press("Escape");

  // --- CONSTRAINT M-1 ------------------------------------------------------
  // Select a cell so the sheet opens. A canvas tap is the honest route — it is the
  // interaction fault S3 is about — and the sheet must land on PEEK, not full.
  //
  // Zoom in first: these fixtures OPEN COARSE (helpers.openViewerV2 documents why it
  // waits on `maxZ >= 0` rather than `totalCells > 0`) and `cells.pick` can only hit a
  // RESIDENT fine-tier cell, so a tap at the boot camera correctly selects nothing.
  await wheelZoom(page, 3);
  await waitForDrawn(page);
  const canvas = await page.locator("canvas.atlas-canvas").boundingBox();
  expect(canvas, "canvas has no bounding box").not.toBeNull();
  const cx = canvas!.x + canvas!.width / 2;
  const cy = canvas!.y + canvas!.height / 2;

  // Tap the atlas until a cell is actually selected. Measured 2026-08-06 against
  // golden_dataset_full_v2 at 5.9×: the EXACT canvas centre picks nothing (it lands
  // between cell rects) while every offset tried selects on the first tap — so a
  // single centre tap would make this spec's real subject (the sheet) hostage to where
  // one fixture's cell boundaries happen to fall. The picker is not what is under test
  // here; tests/dom + the render gate cover it.
  const taps: [number, number][] = [[0, 0], [-60, -60], [60, 60], [-30, 45], [45, -30]];
  let selected = false;
  for (const [dx, dy] of taps) {
    await page.mouse.click(cx + dx, cy + dy);
    if ((await page.locator(".inspector-sheet").count()) === 1) {
      selected = true;
      break;
    }
  }
  expect(
    selected,
    `no tap on the atlas selected a cell (tried ${JSON.stringify(taps)} around ` +
      `${Math.round(cx)},${Math.round(cy)}) — the sheet never opened`,
  ).toBe(true);
  await expect(page.locator(".inspector-sheet")).toHaveCount(1);
  expect(
    await page.locator(".inspector-sheet-full").count(),
    "a tap opened the sheet to FULL — it must open to peek so the atlas stays visible",
  ).toBe(0);

  const sheet = await rectOf(page, ".inspector-sheet");
  const minimap = await rectOf(page, ".minimap");
  const fitBtn = await rectOf(page, ".fit-view-btn");
  expect(sheet, "no .inspector-sheet rendered").not.toBeNull();
  expect(minimap, "no .minimap rendered").not.toBeNull();
  expect(fitBtn, "no .fit-view-btn rendered").not.toBeNull();

  const intersects = (a: Rect, b: Rect): boolean =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  expect(
    intersects(sheet!, minimap!),
    `CONSTRAINT M-1 VIOLATED — the sheet at peek occludes the minimap. ` +
      `sheet ${JSON.stringify(sheet)} vs minimap ${JSON.stringify(minimap)}`,
  ).toBe(false);
  // ...and the fit-view control, which sits in the same zone, rides clear with it.
  expect(
    intersects(sheet!, fitBtn!),
    `the sheet at peek occludes the fit-view button. sheet ${JSON.stringify(sheet)} vs ` +
      `fit ${JSON.stringify(fitBtn)}`,
  ).toBe(false);
  // Both must be inside the holder, not merely non-overlapping by being off-screen.
  const holder = await rectOf(page, ".canvas-holder");
  expect(minimap!.top).toBeGreaterThanOrEqual(holder!.top);
  expect(minimap!.bottom).toBeLessThanOrEqual(holder!.bottom);
  expect(fitBtn!.top).toBeGreaterThanOrEqual(holder!.top);

  // The atlas stays visible above the sheet — the whole point of peek over full.
  expect(
    sheet!.top - holder!.top,
    `the sheet at peek leaves only ${sheet!.top - holder!.top}px of atlas above it`,
  ).toBeGreaterThan(holder!.height / 2);
});

// ---------------------------------------------------------------------------
// D1 — the viewer refuses a page-level pinch, WITHOUT freezing its own scrollers
// ---------------------------------------------------------------------------

test.describe("touch", () => {
  // Real touch points for this block only — a second `projects[]` entry would multiply
  // every other spec by two (the pattern mobile-pinch.spec.ts established).
  test.use({ hasTouch: true, viewport: PHONE });

  test("touch is suppressed on the viewer only, and its scrollable panels still scroll", async ({
    page,
    request,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(PHONE);
    const auth = await authenticate(request, baseURL ?? "");
    await openViewerV2(page, auth, DATASET);

    // WHAT THIS CAN AND CANNOT SEE. The defect D1 closes — a two-finger pinch starting
    // on the header or footer triggering iOS's page zoom — is driven by WebKit's
    // non-standard `gesturestart`/`gesturechange`, which Chromium never fires. So no run
    // on this stack can observe the fix; it belongs to the real-device pass (SCOPE D6),
    // and ViewerScreen's `gesturestart` handler says so at its definition. Writing a
    // Chromium assertion for it would be a test that cannot fail.
    //
    // What IS assertable here is the RISK the fix introduces: `touch-action: none` over
    // the whole viewer would freeze every panel that scrolls under a finger, on every
    // platform, which is a far worse regression than the one being fixed.
    const suppression = await page.evaluate(() => ({
      viewer: getComputedStyle(document.querySelector(".viewer-screen") as Element).touchAction,
      shell: getComputedStyle(document.querySelector(".app-shell") as Element).touchAction,
      html: getComputedStyle(document.documentElement).touchAction,
    }));
    expect(suppression.viewer, "the viewer does not suppress touch").toBe("none");
    // Confinement: the shell and the document are shared with the library, admin and
    // wizard screens, which scroll and must keep native touch.
    expect(suppression.shell, "touch suppression leaked onto the shared app shell").toBe("auto");
    expect(suppression.html, "touch suppression leaked onto the document").toBe("auto");

    // Now drive a real finger inside the full-screen Tags panel.
    await page.locator(".viewer-menu-btn").click();
    await page.getByRole("menuitem", { name: "Tags…" }).click();
    const body = page.locator(".tags-panel-body");
    await expect(body).toHaveCount(1);
    expect(await body.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");

    // The fixture's tag list may be short (calib_small_v2 is images-only), and how tall
    // it happens to be is not the subject — the touch-action chain is. So make the body
    // overflow deterministically rather than let the assertion be vacuous on a fixture
    // whose content happens to fit.
    await body.evaluate((el) => {
      const filler = document.createElement("div");
      filler.style.height = "2000px";
      el.appendChild(filler);
    });

    const box = (await body.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: cx, y: cy, id: 1 }],
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: cx, y: cy - i * 15, id: 1 }],
      });
      await page.waitForTimeout(20);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect
      .poll(async () => body.evaluate((el) => el.scrollTop), {
        message:
          "a finger dragged up inside the Tags panel and it did not scroll — the viewer-wide " +
          "touch suppression swallowed the panel's own panning",
      })
      .toBeGreaterThan(0);
  });
});
