import { test, expect } from "@playwright/test";
import { authenticate, openViewerV2 } from "./helpers.ts";

// Seam M3 — touch-reachable surfaces (SCOPE_mobile-viewer T2-202, faults S1/S2/S5, and
// [[T2-131]]). Brief §5.6 / §5.7.
//
// WHY THIS IS AN E2E CASE AND NOT A FREE-TIER PIN. jsdom does no layout and applies no
// stylesheet, so tests/dom/touch_surfaces.dom.test.ts can pin the DECLARATIONS and the
// component STRUCTURE and nothing else. Three of this seam's acceptance criteria are
// irreducibly geometric:
//
//   * §3.4 — at 390px every rendered `.status-item` shows its FULL TEXT. Before this seam
//     all ten ellipsized to ~24% of their natural width (measured 2026-08-06 in headless
//     Blink: 687px of text + 144px of gap + 25.6px of padding = 856.6px in a 390px bar).
//     "Is this string clipped" is a layout question and only an engine can answer it.
//   * §3.2 — a hit area is a rect. The ::after overlays that grow one are invisible to
//     every tier below this.
//   * §3.1 — the lightbox's image column measured **0px wide** at 390px. Its width is
//     produced by flex, not declared.
//
// WHERE THIS RUNS: the `render-gate.yml` workflow, as a named step on the stack the
// render / context-loss / mobile-containment / mobile-pinch / narrow-cockpit gates already
// boot. NOT e2e-nightly.yml — that workflow hard-fails without a `vars.E2E_BASE_URL` repo
// variable which is not set, so a spec parked there has never executed anywhere but a
// developer's machine, and a gate that never runs is worse than none.
//
// NO `projects[]` ENTRY: this file sets its own viewport per test, so no assertion can
// quietly pass at the wrong width, and it needs no touch emulation.

const DATASET = process.env.E2E_DATASET ?? "calib_small_v2";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1265, height: 900 };

/** The platform minimum SCOPE S2 measured 109 viewer controls against. */
const TOUCH_MIN = 44;

/** Controls this seam DELIBERATELY leaves under the minimum, each with the reason it is
 *  the smaller of two harms. Anything not on this list failing the check is a regression,
 *  which is what stops the count assertion below from being a number nobody maintains. */
const ALLOWED_UNDER = [
  // The docked status bar is a 28px strip; a 44px hit area on a link inside it would
  // extend over the canvas and eat atlas taps.
  ".status-credit a",
  // The two BUTTONS in the search pill sit ~4px apart inside it: widening them to 44 would
  // overlap each other, and "clear my search" firing instead of "show results" is a worse
  // outcome than a small target. They do reach 44px TALL via the ::after overlay.
  //
  // `.search-input` stays listed, but the OLD reason was false and is replaced. It read
  // "they keep their WIDTH … they do reach 44px TALL": the input is 240px wide and ~25px
  // tall, so width was never its problem and the height claim was simply wrong — the
  // allow-list was masking the defect (review of #272, finding #2).
  //
  // It is now fixed where it matters and still listed here because this list is shared by
  // the narrow and desktop cases: NARROW gives it `min-height: var(--touch-min)` (the ☰'s
  // full-width field, which is the one a phone user taps), while DESKTOP deliberately keeps
  // today's ~25px — growing it there makes the search pill 66.8px and occludes the rails
  // pinned at `top: 72px` by 9px. Deferred to [[T2-210]], which derives that band instead
  // of picking it; lift this entry when that lands.
  ".search-input",
  ".search-clear",
  ".search-reveal",
  // A tag chip whose label renders narrower than 44px keeps its width for the same
  // reason — the chip row's column gap is 4.8px. Every chip is 44px tall.
  ".chip",
];

interface Box {
  sel: string;
  label: string;
  w: number;
  h: number;
}

/** Every interactive element in the viewer whose HIT AREA — its own box unioned with the
 *  transparent ::after overlay §3.2 declares — is under the minimum.
 *
 *  This is an UPPER BOUND on the reachable area, not the reachable area itself: it reads
 *  the overlay's declared size, so it cannot see an `overflow: hidden` ancestor clipping
 *  it or a later sibling's overlay painting over it. Both were checked separately, by
 *  probing `elementFromPoint` at the corners of the intended box during the build, and the
 *  two boundaries that turned out to be shared are documented beside the rules in app.css
 *  (`.topbar-brand` clipped left by the nav pill; `.fit-view-btn` sharing its lower band
 *  with the minimap). Automating the corner probe here would flag every control that
 *  merely sits under the top bar's z-index-12 band, which is a pre-existing geometry
 *  question about the rails' `top: 72px` and not this seam's to assert on. */
async function undersizedTargets(page: import("@playwright/test").Page): Promise<Box[]> {
  return page.evaluate(
    ({ min, allowed }) => {
      const sel = ["button", "a[href]", "input", "select", "textarea", "[role=button]"]
        .map((s) => ".viewer-screen " + s)
        .join(", ");
      const out: { sel: string; label: string; w: number; h: number }[] = [];
      for (const el of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        let w = b.width;
        let h = b.height;
        const pa = getComputedStyle(el, "::after");
        if (pa.content !== "none" && pa.position === "absolute") {
          const pw = Number.parseFloat(pa.width);
          const ph = Number.parseFloat(pa.height);
          if (Number.isFinite(pw)) w = Math.max(w, pw);
          if (Number.isFinite(ph)) h = Math.max(h, ph);
        }
        if (w >= min && h >= min) continue;
        if (allowed.some((a) => el.matches(a))) continue;
        out.push({
          sel: el.tagName.toLowerCase() + "." + el.className.toString().split(" ").join("."),
          label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40),
          w: Math.round(w * 10) / 10,
          h: Math.round(h * 10) / 10,
        });
      }
      return out;
    },
    { min: TOUCH_MIN, allowed: ALLOWED_UNDER },
  );
}

/** The status bar's rendered items, their natural (content) width, and whether the engine
 *  had to ellipsize them. `scrollWidth` on a clipped item IS its natural width. */
async function statusBar(page: import("@playwright/test").Page): Promise<{
  clientWidth: number;
  scrollWidth: number;
  naturalContent: number;
  items: { cls: string; text: string; natural: number; clipped: boolean }[];
  credits: number;
  creditWidth: number;
}> {
  return page.evaluate(() => {
    const bar = document.querySelector(".status-bar") as HTMLElement;
    const cs = getComputedStyle(bar);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const groups = [...bar.querySelectorAll(".status-group")];
    let total = padX + Math.max(0, groups.length - 1) * (parseFloat(cs.columnGap) || 0);
    const items: { cls: string; text: string; natural: number; clipped: boolean }[] = [];
    for (const g of groups) {
      const kids = [...g.children].filter((k) => getComputedStyle(k).display !== "none");
      total += Math.max(0, kids.length - 1) * (parseFloat(getComputedStyle(g).columnGap) || 0);
      for (const k of kids) {
        const rendered = k.getBoundingClientRect().width;
        const natural = Math.max(k.scrollWidth, rendered);
        total += natural;
        items.push({
          cls: k.className,
          text: (k.textContent || "").trim(),
          natural: Math.round(natural * 10) / 10,
          clipped: k.scrollWidth > Math.ceil(rendered),
        });
      }
    }
    const credit = bar.querySelector(".status-credit");
    return {
      clientWidth: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
      naturalContent: Math.round(total * 10) / 10,
      items,
      credits: bar.querySelectorAll(".status-credit").length,
      creditWidth: Math.round((credit?.getBoundingClientRect().width ?? 0) * 10) / 10,
    };
  });
}

/** §3.1 is produced by flex over `.lightbox-*`, and the overlay only exists once a cell's
 *  DETAIL original has resolved — which depends on the fixture's pixels, not on this
 *  seam. So the geometry is measured against a PROBE with the shipped structure
 *  (transcribed from `LightboxBody`, whose markup is pinned by tests/ui_lightbox.test.ts)
 *  laid out by the shipped stylesheet at a real viewport. That keeps the assertion about
 *  the CSS this seam changed instead of about whether a fixture happens to bake a detail
 *  tier. */
async function lightboxProbe(page: import("@playwright/test").Page): Promise<{
  flexDirection: string;
  padX: number;
  content: number;
  imageCol: number;
  inspector: number;
}> {
  return page.evaluate(() => {
    const screen = document.querySelector(".viewer-screen") as HTMLElement;
    const probe = document.createElement("div");
    probe.className = "lightbox-backdrop";
    probe.innerHTML =
      '<div class="lightbox-content">' +
      '<div class="lightbox-image-col"><div class="lightbox-image-area"></div></div>' +
      '<aside class="panel-float lightbox-inspector">' +
      '<div class="lightbox-inspector-body"></div></aside></div>';
    screen.appendChild(probe);
    const rect = (sel: string): DOMRect =>
      (probe.querySelector(sel) ?? probe).getBoundingClientRect();
    const cs = getComputedStyle(probe);
    const out = {
      flexDirection: getComputedStyle(probe.querySelector(".lightbox-content") as Element)
        .flexDirection,
      padX: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0),
      content: rect(".lightbox-content").width,
      imageCol: rect(".lightbox-image-col").width,
      inspector: rect(".lightbox-inspector").width,
    };
    probe.remove();
    return out;
  });
}

// ---------------------------------------------------------------------------
// §5.7 — narrow acceptance at 390 x 844
// ---------------------------------------------------------------------------

test("at 390x844 every status read-out is legible, the credit survives, and targets are reachable", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(PHONE);
  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  await expect(page.locator(".viewer-screen.cockpit-narrow")).toHaveCount(1);

  // --- §3.4 ---------------------------------------------------------------
  const bar = await statusBar(page);
  expect(bar.clientWidth).toBe(PHONE.width);
  // M0's containment, re-checked: the bar still fits its own box.
  expect(bar.scrollWidth, "the status bar overflows its own box").toBe(bar.clientWidth);

  // THE acceptance: every item the narrow bar renders shows its FULL text. The credit is
  // the one item permitted to ellipsize — it is an attribution obligation of unbounded
  // length, and clipping it is the honest failure mode.
  const clipped = bar.items.filter((i) => i.clipped && !i.cls.includes("status-credit"));
  expect(
    clipped,
    `read-outs are still ellipsized at 390px: ${JSON.stringify(clipped)} ` +
      `(natural content ${bar.naturalContent}px against a ${bar.clientWidth}px bar)`,
  ).toEqual([]);
  expect(
    bar.naturalContent,
    `the narrow bar's content wants ${bar.naturalContent}px in a ${bar.clientWidth}px box`,
  ).toBeLessThanOrEqual(bar.clientWidth);

  // The credit, derived from app-state rather than guessed — the same move
  // mobile-viewport.spec.ts made after its own count assertion turned out to be vacuous.
  const summary = await request.get(`${baseURL}/api/datasets/${DATASET}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  expect(summary.ok(), `GET /api/datasets/${DATASET} failed (${summary.status()})`).toBe(true);
  const { attribution } = (await summary.json()) as { attribution?: string | null };
  const credited = typeof attribution === "string" && attribution.trim() !== "";
  expect(
    bar.credits,
    credited
      ? `'${DATASET}' has attribution '${attribution}' but the narrow bar renders ${bar.credits} credit(s) — the read-out cull dropped an attribution obligation`
      : `'${DATASET}' has no attribution, so none may be rendered (got ${bar.credits})`,
  ).toBe(credited ? 1 : 0);
  if (credited) expect(bar.creditWidth).toBeGreaterThan(0);

  // The instrumentation is gone, not merely squeezed.
  for (const cls of ["status-cursor", "status-fps", "status-zoom", "status-inview"]) {
    expect(
      bar.items.filter((i) => i.cls.includes(cls)),
      `.${cls} is still rendered at 390px`,
    ).toEqual([]);
  }

  // --- §3.2 ---------------------------------------------------------------
  const under = await undersizedTargets(page);
  expect(
    under,
    `interactive elements under ${TOUCH_MIN}x${TOUCH_MIN} that are not documented residuals: ` +
      JSON.stringify(under, null, 1),
  ).toEqual([]);

  // --- §3.1 ---------------------------------------------------------------
  const lb = await lightboxProbe(page);
  expect(lb.flexDirection, "the narrow lightbox is still two columns").toBe("column");
  expect(lb.padX, "the backdrop still spends 112px on padding at 390px").toBeLessThan(56);
  // The image is the point: its column gets the majority of the content box. Before this
  // seam it measured 0px against a 278px box.
  expect(
    lb.imageCol,
    `the lightbox image column is ${lb.imageCol}px of a ${lb.content}px content box`,
  ).toBeGreaterThan(lb.content / 2);
  expect(lb.inspector).toBeLessThanOrEqual(lb.content);
});

// ---------------------------------------------------------------------------
// §5.6 — desktop non-regression at 1265 x 900
// ---------------------------------------------------------------------------

test("at 1265x900 the cockpit is unchanged: nothing shrinks, the lightbox is side by side", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(DESKTOP);
  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  expect(
    await page.locator(".viewer-screen.cockpit-narrow").count(),
    "a 1265px viewport went NARROW",
  ).toBe(0);

  // §3.4's desktop half: every read-out is still present AND at its natural width. The
  // brief's figures (groups 340/340 and 405/405) predate the type floor SCOPE §4.2
  // required, so the substance is asserted rather than the literals — nothing shrinks.
  const bar = await statusBar(page);
  expect(bar.scrollWidth).toBe(bar.clientWidth);
  expect(
    bar.items.filter((i) => i.clipped),
    `desktop read-outs are being squeezed: ${JSON.stringify(bar.items.filter((i) => i.clipped))}`,
  ).toEqual([]);
  expect(
    bar.naturalContent,
    `the desktop bar's content wants ${bar.naturalContent}px in a ${bar.clientWidth}px box`,
  ).toBeLessThanOrEqual(bar.clientWidth);
  // The cull is narrow-only: the pointer read-outs are still here where there IS a pointer.
  expect(bar.items.some((i) => i.cls.includes("status-cursor"))).toBe(true);
  expect(bar.items.some((i) => i.cls.includes("status-fps"))).toBe(true);

  // The layout tabs still read as a TAB ROW — one horizontal band, not a stack. (The
  // summary line went INSIDE each tab; if it had gone beside them, or the row had wrapped,
  // the tops would differ.)
  const tabTops = await page.evaluate(() =>
    [...document.querySelectorAll(".layout-switcher .layout-tab")].map((t) =>
      Math.round(t.getBoundingClientRect().top),
    ),
  );
  expect(tabTops.length, "the desktop tab row rendered no tabs").toBeGreaterThan(0);
  expect(new Set(tabTops).size, `the tab row wrapped: tops ${JSON.stringify(tabTops)}`).toBe(1);
  // [[T2-131]](b): the caption whose appearing and disappearing resized the canvas is gone.
  expect(
    await page.locator(".layout-baked-note").count(),
    "the active-layout caption is back — switching layouts resizes the canvas again",
  ).toBe(0);

  // §3.1's desktop half: image column + a 328px inspector, side by side, unchanged.
  const lb = await lightboxProbe(page);
  expect(lb.flexDirection).toBe("row");
  expect(lb.padX, "the desktop backdrop padding changed").toBe(112);
  expect(lb.inspector, "the desktop inspector is no longer 328px").toBe(328);
  expect(lb.imageCol).toBeGreaterThan(lb.content / 2);

  // §3.2 is an ALL-WIDTHS change, not a narrow-only one — a 21x27px chevron is a poor
  // target with a mouse too.
  const under = await undersizedTargets(page);
  expect(
    under,
    `interactive elements under ${TOUCH_MIN}x${TOUCH_MIN} at desktop width that are not ` +
      `documented residuals: ${JSON.stringify(under, null, 1)}`,
  ).toEqual([]);
});
