import { test, expect } from "@playwright/test";
import { authenticate, openViewerV2 } from "./helpers.ts";

// Seam M0 — the viewer CONTAINS itself at a phone viewport (SCOPE_mobile-viewer,
// T2-202, decision D6(c)).
//
// This is the one assertion class the free tiers cannot make. jsdom does no layout, so
// the DOM tier can only pin the CSS DECLARATIONS
// (tests/dom/mobile_containment.dom.test.ts); a real engine at a real viewport is the
// only thing that can say whether the page actually scrolls sideways. And it is ONE
// line for three of the four layout faults SCOPE §1a measured on the live build at
// 390 × 844 CSS px:
//
//   L1  documentElement.scrollWidth 860 vs clientWidth 390  — 470px of sideways scroll
//   L2  .topbar-search right edge at x = 860, 484px past its container
//   L4  .status-bar scrollWidth 453 vs clientWidth 390      — 63px over
//
// `scrollWidth === clientWidth` on the document catches all three at once: any of them
// widens the page. The two narrower assertions are kept beside it because they say
// WHICH containment broke — a bare scrollWidth failure does not.
//
// WHERE THIS RUNS (settled after review of PR #266): the `render-gate.yml` workflow, as a
// third named step on the stack the render + context-loss gates already boot. It is
// PR-blocking there and green today.
//
// It is deliberately NOT parked in `e2e-nightly.yml`, where SCOPE decision D6 first put
// it: that workflow hard-fails without a `vars.E2E_BASE_URL` repo variable, which is not
// set, so a spec left there runs nowhere but a developer's local stack. A gate that never
// executes is worse than no gate, because it reads as coverage.
//
// It needs NO `projects[]` entry: this file sets its own viewport below, so it cannot
// quietly pass at desktop width, and it asserts layout only — no touch emulation. (The
// pinch spec, which DOES need touch, gets it from a file-scope `test.use({ hasTouch })`
// rather than a project — a second project would multiply every other spec by two.)

const DATASET = process.env.E2E_DATASET ?? "calib_small_v2";

// The iPhone-14-class layout viewport SCOPE §1a measured against. Set here, not left to
// the project, so the assertion cannot quietly pass at desktop width.
const PHONE = { width: 390, height: 844 };

test("the viewer does not scroll sideways at a 390px viewport", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);

  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  // The whole page: nothing anywhere may make the document wider than the screen.
  const doc = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(doc.scrollWidth, `the page scrolls sideways: ${doc.scrollWidth} vs ${doc.clientWidth}`).toBe(
    doc.clientWidth,
  );
  expect(doc.clientWidth).toBe(PHONE.width);

  // L4: the docked status bar is a fixed-height strip of nowrap read-outs; it must fit
  // its own box rather than push the document wider.
  const bar = await page.evaluate(() => {
    const el = document.querySelector(".status-bar");
    if (el === null) return null;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(bar, "no .status-bar rendered").not.toBeNull();
  expect(bar!.scrollWidth, "the status bar overflows its own box").toBe(bar!.clientWidth);

  // L2: clipping .canvas-holder must FIT the search box, not hide it — a control pushed
  // outside the clip is a worse defect than the one being fixed.
  //
  // UPDATED BY SEAM M2 (SCOPE D2): at this width the search pill is no longer a top-bar
  // child at all — the layouts and the search moved into the ☰ menu, which is what makes
  // the bar fit rather than merely shrink. The ASSERTION is unchanged in substance and
  // stronger in reach: the control must still be reachable and still inside the
  // viewport, now including the popover it lives in. Reaching it through the menu is
  // also what proves the move did not simply drop it.
  await page.locator(".viewer-menu-btn").click();
  const searchRight = await page
    .locator(".viewer-menu .topbar-search input.search-input")
    .evaluate((el) => el.getBoundingClientRect().right);
  expect(searchRight, "the search input is pushed outside the viewport").toBeLessThanOrEqual(
    doc.clientWidth,
  );
  await page.keyboard.press("Escape");

  // The credit is an attribution obligation: it may ellipsize under pressure, it may not
  // be dropped.
  //
  // REVIEW FIX (PR #266): this was `expect(count).toBeLessThanOrEqual(1)`, which a DROPPED
  // credit satisfies (0 <= 1) — it only ever caught a duplicate, the opposite of what the
  // comment claimed, and was fully vacuous on a fixture carrying no attribution at all.
  // The expectation is now DERIVED from app-state rather than guessed, so the assertion
  // fails in the direction that matters. This is the test nominally guarding M3 §3.4's
  // status-bar read-out cull, which is the change most likely to drop the credit at 390px.
  const summary = await request.get(`${baseURL}/api/datasets/${DATASET}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(summary.ok(), `GET /api/datasets/${DATASET} failed (${summary.status()})`).toBe(true);
  const { attribution } = (await summary.json()) as { attribution?: string | null };
  const credited = typeof attribution === "string" && attribution.trim() !== "";

  const credits = await page.locator(".status-credit").count();
  expect(
    credits,
    credited
      ? `'${DATASET}' has attribution '${attribution}' but the status bar renders ${credits} credit(s) — an attribution obligation was dropped`
      : `'${DATASET}' has no attribution, so the status bar must render none (got ${credits})`,
  ).toBe(credited ? 1 : 0);

  // A credit that is present but clipped to nothing is dropped in every sense that matters.
  if (credited) {
    const width = await page
      .locator(".status-credit")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(width, "the credit is present in the DOM but collapsed to zero width").toBeGreaterThan(0);
  }
});
