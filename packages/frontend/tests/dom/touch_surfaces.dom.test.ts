// DOM tier — Seam M3 (touch-reachable surfaces) of the mobile-viewer workstream
// (docs/plan/SCOPE_mobile-viewer.md, T2-202; brief
// docs/prompts/brief_touch_surfaces_seam.md). Closes SCOPE S1/S2/S5 and [[T2-131]].
//
// WHAT THIS TIER CAN AND CANNOT SEE, so every pin below is honest about which it is:
//
//  * jsdom does NO layout and applies NO stylesheet. Every getBoundingClientRect() is
//    zero, so NOTHING here asserts a pixel. The geometry acceptance — the status bar's
//    natural-content total at 390px, the lightbox's stacked image column, the 44px hit
//    areas — is the e2e case in `e2e/touch-surfaces.spec.ts` (SCOPE decision D6(c)), and
//    the numbers it asserts were measured in headless Blink before being written down.
//  * What jsdom CAN drive is (a) the real components' rendered STRUCTURE and (b) the CSS
//    DECLARATIONS that produce the geometry — the same move mobile_containment.dom and
//    narrow_layout.dom already make for M0's and M2's rules.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { StatusBar, tagStatusIdle } from "../../src/ui/StatusBar.ts";
import type { TagStatusView, ViewerStatus } from "../../src/ui/StatusBar.ts";
import { LayoutSwitcher } from "../../src/ui/LayoutSwitcher.ts";
import { ViewerMenu } from "../../src/ui/ViewerMenu.ts";
import { attributionCredit } from "../../src/ui/attributionCredit.ts";
import type { LayoutInfo } from "../../src/api-client/types.ts";

afterEach(cleanup);

const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every declaration block whose selector list is EXACTLY `selector` (the helper
 *  mobile_containment.dom.test.ts uses, kept identical so the two files read alike). */
function decls(selector: string): string {
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css)) !== null) {
    if (m[1].trim() === selector) out.push(m[2]);
  }
  assert.ok(out.length > 0, `app.css declares no rule for ${selector}`);
  return out.join(" ");
}

/** The declaration blocks of every rule whose selector LIST CONTAINS `selector`. §3.2's
 *  hit-area rules are deliberately one shared declaration over many selectors, so an
 *  exact-list match cannot find them. */
function rulesListing(selector: string): { selectors: string[]; body: string }[] {
  const out: { selectors: string[]; body: string }[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css)) !== null) {
    const selectors = m[1].split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) out.push({ selectors, body: m[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §3.3.1 — [[T2-131]](a): the baked-options summary is CONTENT, not a tooltip
// ---------------------------------------------------------------------------

const LAYOUTS: LayoutInfo[] = [
  { layout_id: "grid", label: "Grid", type: "grid" },
  { layout_id: "by_place", label: "By place", type: "geographic" },
  { layout_id: "by_size", label: "Dimensions (cm)", type: "scatter" },
];
const BAKED = { grid: null, by_place: "equirectangular", by_size: "log × log, fit" };

test("a NON-ACTIVE layout's baked options are reachable without a mouse — in the tab and in the ☰ row", () => {
  // T2-131(a): the summary used to exist for a non-active layout ONLY in the tab's
  // `title`, so a keyboard or touch user could not compare layouts before switching.
  // "grid" is the active one here precisely so both surfaces are asked about layouts the
  // user has NOT chosen — the case the defect was about.
  const r = render(
    h(LayoutSwitcher, {
      layouts: LAYOUTS,
      activeLayoutId: "grid",
      onSwitch: () => {},
      bakedSummary: BAKED,
    }),
  );
  const tabs = [...(r.container as HTMLElement).querySelectorAll(".layout-tab")];
  assert.equal(tabs.length, 3);

  // Real content, on the tabs for the layouts NOT in use.
  const noteText = (tab: Element): string =>
    (tab.querySelector(".layout-tab-note")?.textContent ?? "").trim();
  assert.equal(noteText(tabs[1]), "equirectangular", "the non-active geographic tab explains nothing");
  assert.equal(noteText(tabs[2]), "log × log, fit", "the non-active scatter tab explains nothing");
  // ...and a layout with no shaping options gets no empty second line.
  assert.equal(tabs[0].querySelector(".layout-tab-note") === null, true);

  // The information must not be reachable ONLY through `title` any more. Stripping every
  // title attribute must leave the summaries standing — that is the whole defect, and
  // asserting the presence of `.layout-tab-note` alone would still pass if the component
  // rendered it as a title-bearing element and nothing else.
  for (const tab of tabs) tab.removeAttribute("title");
  assert.equal(
    (r.container as HTMLElement).textContent?.includes("equirectangular"),
    true,
    "the summary vanished with the title attribute — it is still mouse-only",
  );
  cleanup();

  // The NARROW half, same rule: on a phone there is no tab row, the layouts are ☰ rows.
  const menu = render(
    h(ViewerMenu, {
      layouts: LAYOUTS,
      activeLayoutId: "grid",
      onSwitch: () => {},
      open: true,
      setOpen: () => {},
      bakedSummary: BAKED,
    }),
  );
  const rows = [...(menu.container as HTMLElement).querySelectorAll(".viewer-menu-layout")];
  assert.equal(rows.length, 3);
  assert.equal(
    (rows[1].querySelector(".viewer-menu-row-note")?.textContent ?? "").trim(),
    "equirectangular",
    "the ☰ row for a non-active layout explains nothing",
  );
  assert.equal(rows[0].querySelector(".viewer-menu-row-note") === null, true);
});

test("the active-layout caption is gone — T2-131(b), the switch that resized the canvas", () => {
  // (b): `.layout-baked-note` appeared for a coordinate layout and vanished for
  // grid/datetime, changing `.topbar-layouts` height and therefore the canvas, on every
  // such switch. Measured in headless Blink at 1265x900 AFTER this change:
  // `.topbar-layouts` is 64.9px tall with `by_place` active (which has a summary) and
  // 64.9px with `grid` active (which has none) — the row's height is a max over ALL tabs
  // and no longer depends on which one is active.
  for (const activeLayoutId of ["grid", "by_place"]) {
    const r = render(
      h(LayoutSwitcher, { layouts: LAYOUTS, activeLayoutId, onSwitch: () => {}, bakedSummary: BAKED }),
    );
    assert.equal(
      (r.container as HTMLElement).querySelector(".layout-baked-note") === null,
      true,
      `the caption is still rendered with ${activeLayoutId} active`,
    );
    // The number of summary lines is a property of the COLLECTION, not of the selection —
    // that is the invariant which makes the height stable.
    assert.equal(
      (r.container as HTMLElement).querySelectorAll(".layout-tab-note").length,
      2,
      `the summary count changed with ${activeLayoutId} active`,
    );
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The ☰ holds two KINDS of thing, and says so (operator 2026-08-06)
// ---------------------------------------------------------------------------

function MenuProbe(props: { onOpenTags?: () => void }): ReturnType<typeof h> {
  const [open, setOpen] = useState(true);
  return h(ViewerMenu, {
    layouts: LAYOUTS,
    activeLayoutId: "grid",
    onSwitch: () => {},
    open,
    setOpen,
    onOpenTags: props.onOpenTags,
  });
}

test("Tags is a FILTER, in its own named list — not an item under a heading that says Views", () => {
  const r = render(h(MenuProbe, { onOpenTags: () => {} }));
  const container = r.container as HTMLElement;

  const menus = [...container.querySelectorAll('[role="menu"]')];
  assert.equal(menus.length, 2, `expected a Views menu and a Filters menu, got ${menus.length}`);
  assert.deepEqual(
    menus.map((m) => m.getAttribute("aria-label")),
    ["Views", "Filters"],
  );

  // The defect: the filter used to sit INSIDE the list labelled "Views", so a screen
  // reader announced it as one. It must now be owned by the Filters list and by nothing
  // else. Boolean compares — never hand a jsdom node to assert's differ (a failing
  // node comparison makes util.inspect walk the tree and the runner is SIGKILLed at 90s,
  // so the mutation "hangs" instead of reporting; narrow_layout.dom documents the same).
  assert.equal(menus[0].querySelector(".viewer-menu-tags") === null, true, "Tags is still filed under Views");
  assert.equal(menus[1].querySelector(".viewer-menu-tags") !== null, true, "Tags is not in the Filters list");
  assert.equal(menus[0].querySelectorAll('[role="menuitemradio"]').length, LAYOUTS.length);

  // M2's #271 F5 invariant, unchanged and now checked over BOTH menus: a `role="menu"`
  // may own only menuitem / menuitemradio / group / separator, so a heading must stay
  // outside it. This is the stricter form — every direct child's role, not just the
  // absence of one class — because a second section is exactly how the old proxy would
  // have been satisfied while the rule was broken.
  const allowed = new Set(["menuitem", "menuitemradio", "menuitemcheckbox", "group", "separator"]);
  for (const menu of menus) {
    for (const child of [...menu.children]) {
      assert.equal(
        allowed.has(child.getAttribute("role") ?? ""),
        true,
        `role="menu" owns a <${child.tagName.toLowerCase()} role=${child.getAttribute("role")}>`,
      );
    }
  }

  // Both sections carry a VISIBLE heading, and both headings are aria-hidden because the
  // menu they label already carries the same word as its accessible name.
  const headings = [...container.querySelectorAll(".viewer-menu-section")];
  assert.deepEqual(
    headings.map((p) => (p.textContent ?? "").trim()),
    ["Views", "Filters"],
  );
  assert.equal(
    headings.every((p) => p.getAttribute("aria-hidden") === "true"),
    true,
  );

  // The trigger names what the menu now contains.
  const trigger = container.querySelector(".viewer-menu-btn") as HTMLElement;
  assert.match(trigger.getAttribute("aria-label") ?? "", /Views, filters and search/);
});

test("a collection with no tags surface renders no empty Filters section", () => {
  // `onOpenTags` is optional (M2), so the section must be conditional on the item, not a
  // heading that is always drawn over nothing.
  const r = render(h(MenuProbe, {}));
  const container = r.container as HTMLElement;
  assert.equal(container.querySelectorAll('[role="menu"]').length, 1);
  assert.deepEqual(
    [...container.querySelectorAll(".viewer-menu-section")].map((p) => (p.textContent ?? "").trim()),
    ["Views"],
  );
});

test("choosing Tags still closes the ☰, and the accessible name is still exactly Tags…", () => {
  // The row moved between containers; neither its behaviour nor the name two existing
  // gates address it by (narrow_layout.dom + e2e narrow-cockpit) may move with it.
  let opened = 0;
  const r = render(h(MenuProbe, { onOpenTags: () => (opened += 1) }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Tags…" }));
  assert.equal(opened, 1);
  assert.equal((r.container as HTMLElement).querySelector(".viewer-menu") === null, true, "the ☰ stayed open");
});

// ---------------------------------------------------------------------------
// §3.4 — the narrow status bar shows fewer read-outs, and never fewer than the credit
// ---------------------------------------------------------------------------

const STATUS: ViewerStatus = {
  layoutId: "grid",
  zoom: 2.4,
  inView: 2371,
  loadingTiles: 0,
  tags: { status: "none", selected: 0, matched: 0, total: 1199 },
  selectedCell: null,
  cursor: null,
  fps: 60,
};

/** The read-outs the narrow bar drops, by the class each is targeted through. */
const CULLED = [
  "status-layout",
  "status-zoom",
  "status-inview",
  "status-tiles",
  "status-selection",
  "status-cursor",
  "status-fps",
];

test("every status read-out is individually targetable — the mechanism the narrow cull needs", () => {
  const r = render(
    h(StatusBar, {
      status: STATUS,
      credit: attributionCredit("Rijksmuseum, Amsterdam", null, "status-item status-credit"),
    }),
  );
  const container = r.container as HTMLElement;
  // Ten read-outs, ten distinct hooks. A cull rule can only name what carries a name, and
  // before this seam `cursor` and `fps` "carried no class of their own to target" — the
  // reason M0's app.css comment gives for squeezing instead of dropping.
  for (const cls of [...CULLED, "status-tags", "status-credit", "status-brand"]) {
    assert.equal(
      container.querySelectorAll(`.${cls}`).length,
      1,
      `no unique .${cls} in the status bar`,
    );
  }
});

test("the narrow cull hides exactly the instrumentation, and CANNOT hide the credit", () => {
  // The rule is keyed on M2's `.cockpit-narrow` — the derived mode's only output to this
  // stylesheet. jsdom applies no CSS, so this pins the DECLARATION; the e2e case measures
  // what it produces.
  const rules = rulesListing(".cockpit-narrow .status-cursor");
  assert.equal(rules.length, 1, "the narrow status-bar cull is not one rule");
  const [cull] = rules;
  assert.match(cull.body, /display:\s*none/);

  for (const cls of CULLED) {
    assert.equal(
      cull.selectors.includes(`.cockpit-narrow .${cls}`),
      true,
      `.${cls} is still rendered at 390px — 620px of read-outs do not fit in a 390px bar`,
    );
  }
  // The tag read-out is kept whenever it has something to say; only the IDLE state goes.
  assert.equal(cull.selectors.includes(".cockpit-narrow .status-tags-idle"), true);
  assert.equal(
    cull.selectors.includes(".cockpit-narrow .status-tags"),
    false,
    "an ACTIVE tag filter is the one thing on that bar a visitor cannot infer from the atlas",
  );

  // The attribution obligation. It may ellipsize; it may not disappear — so it must not
  // be culled here, and no `display: none` may reach it from anywhere.
  assert.equal(cull.selectors.some((s) => s.includes("status-credit")), false, "the credit is culled");
  assert.doesNotMatch(decls(".status-credit"), /display:\s*none/);

  // No second definition of narrow, and no shrink ladder: the cull must not key on a
  // position (`:nth-child`) or on a media query of its own.
  assert.equal(
    cull.selectors.some((s) => /nth-child|nth-of-type|:first|:last/.test(s)),
    false,
    "the cull is position-based — a shrink ladder is exactly what the brief forbids",
  );
});

test("the tag read-out is culled by what it SAYS, not by how wide it is", () => {
  const idle: TagStatusView = { status: "none", selected: 0, matched: 0, total: 1199 };
  assert.equal(tagStatusIdle(idle), true, "'0 tags highlighted' reports nothing");
  assert.equal(tagStatusIdle({ ...idle, selected: 3 }), false, "an active filter must be announced");
  assert.equal(
    tagStatusIdle({ status: "ok", selected: 2, matched: 41, total: 1199 }),
    false,
    "a live match count must be announced",
  );
  assert.equal(
    tagStatusIdle({ ...idle, status: "unavailable" }),
    false,
    "a failed sidecar must be announced — never silently dropped to save room",
  );

  // ...and the component actually marks it, so the CSS above has something to bite on.
  const r = render(h(StatusBar, { status: STATUS }));
  assert.equal((r.container as HTMLElement).querySelectorAll(".status-tags-idle").length, 1);
  cleanup();
  const busy = render(
    h(StatusBar, { status: { ...STATUS, tags: { status: "ok", selected: 2, matched: 41, total: 1199 } } }),
  );
  assert.equal((busy.container as HTMLElement).querySelectorAll(".status-tags-idle").length, 0);
});

test("the status bar's type floor rose — the trade SCOPE §4.2 named this seam as mitigating", () => {
  // SCOPE_mobile-viewer §4.2 (AMENDED 2026-08-06): the viewer suppresses PAGE zoom, so a
  // low-vision visitor can no longer pinch-enlarge 10px chrome. The amendment records
  // "M3 raises the status bar's type floor" as the accepted trade's partial mitigation.
  // Pinned as a PROPERTY (>= 12px), not as the literal, so the floor cannot be walked
  // back to 10px while still matching a string.
  const size = /font-size:\s*([\d.]+)(px|rem)/.exec(decls(".status-bar"));
  assert.ok(size !== null, ".status-bar declares no font-size");
  const px = size[2] === "rem" ? Number(size[1]) * 16 : Number(size[1]);
  assert.ok(px >= 12, `the status bar's type floor is ${px}px — SCOPE §4.2 raised it above 10px`);
});

// ---------------------------------------------------------------------------
// §3.1 — the lightbox at a narrow width (SCOPE S1)
// ---------------------------------------------------------------------------

test("the narrow lightbox stacks, and the inspector can no longer be wider than its box", () => {
  // Measured in headless Blink at 390x844 BEFORE this seam: the backdrop's 3.5rem padding
  // left a 278px content box, `.lightbox-inspector` was `flex: none; width: 328px`, and
  // `.lightbox-image-col` came out **0px wide** with the image 0x0. The overlay whose
  // purpose is showing the picture showed none.
  //
  // The content-derived cap the brief asked for in preference to a breakpoint: at desktop
  // the 328px term binds (measured 1265x900: the content box is 1153px, so 40% = 461px)
  // and nothing changes; it simply cannot exceed its container any more.
  assert.match(decls(".lightbox-inspector"), /width:\s*min\(328px,\s*40%\)/);

  // ...and on narrow the two columns stack, so the image gets the full width.
  assert.match(decls(".cockpit-narrow .lightbox-content"), /flex-direction:\s*column/);
  const stacked = decls(".cockpit-narrow .lightbox-inspector");
  assert.match(stacked, /width:\s*auto/);
  const cap = /max-height:\s*([\d.]+)%/.exec(stacked);
  assert.ok(cap !== null, "the stacked inspector has no height cap — it would take the whole screen");
  assert.ok(
    Number(cap[1]) < 50,
    `the stacked inspector may take ${cap[1]}% of the content box — the image must keep the majority`,
  );

  // The backdrop's padding is the cockpit's own inset, not a new number.
  assert.match(decls(".cockpit-narrow .lightbox-backdrop"), /padding:\s*var\(--cockpit-inset\)/);

  // THE TOUCH TRAP (M2's ⚠️): `.viewer-screen` is `touch-action: none` and every scroller
  // re-enables its own axis. Stacking must not introduce a NEW scrollable region — and it
  // does not: the element that scrolls when stacked is the same one that scrolls
  // side-by-side, and it already declares pan-y. Pinned so a later "make the stacked panel
  // its own scroller" change has to notice.
  assert.match(decls(".lightbox-inspector-body"), /overflow-y:\s*auto/);
  assert.match(decls(".lightbox-inspector-body"), /touch-action:\s*pan-y/);
  assert.doesNotMatch(decls(".cockpit-narrow .lightbox-inspector"), /overflow/);
});

// ---------------------------------------------------------------------------
// §3.2 — touch targets (SCOPE S2)
// ---------------------------------------------------------------------------

test("hit areas are grown from ONE declared minimum, and the visual chrome is not", () => {
  assert.match(decls(".viewer-screen"), /--touch-min:\s*44px/);

  // The overlay technique: a transparent pseudo-element that expands the hit area only
  // where the control is smaller than the minimum. `max(100%, …)` is what makes it a
  // FLOOR rather than a resize — a control already big enough is untouched, and no
  // control's own box grows.
  const overlay = rulesListing(".viewer-screen .rail-toggle::after");
  assert.equal(overlay.length, 1, "the both-axes hit-area overlay is not one rule");
  assert.match(overlay[0].body, /width:\s*max\(100%,\s*var\(--touch-min\)\)/);
  assert.match(overlay[0].body, /height:\s*max\(100%,\s*var\(--touch-min\)\)/);
  assert.match(overlay[0].body, /position:\s*absolute/);
  // Transparent: it declares no paint of its own.
  assert.doesNotMatch(overlay[0].body, /background|border|color/);

  // The height-only variant exists for controls in a tight horizontal row, where a wider
  // hit area would reach into the neighbour's and a mis-tap picks the wrong control.
  const heightOnly = rulesListing(".viewer-screen .chip:not(.chip-static)::after");
  assert.equal(heightOnly.length, 1);
  assert.match(heightOnly[0].body, /width:\s*100%/);
  assert.match(heightOnly[0].body, /height:\s*max\(100%,\s*var\(--touch-min\)\)/);
});

test("an ALREADY-POSITIONED control is never given position: relative", () => {
  // Found by measurement, not by review: `.viewer-screen .fit-view-btn` is more specific
  // than `.fit-view-btn`, so listing it among the `position: relative` hosts silently
  // returned it to the normal flow — measured at x = -172…-125 on a 390px screen, i.e.
  // entirely off the left edge, because its `right: 172px` became a relative offset.
  // These three are `position: absolute` already, which is a containing block too.
  const hosts = rulesListing(".viewer-screen .rail-toggle");
  assert.equal(hosts.length, 1, "the hit-area hosts are not one rule");
  assert.match(hosts[0].body, /position:\s*relative/);
  for (const already of [".fit-view-btn", ".view-full-btn", ".lightbox-nav"]) {
    assert.match(decls(already), /position:\s*absolute/, `${already} is no longer absolutely positioned`);
    assert.equal(
      hosts[0].selectors.includes(`.viewer-screen ${already}`),
      false,
      `${already} is absolutely positioned; position: relative here drops it out of place`,
    );
  }
});

test("where two grown hit areas would touch, the gap between them is DERIVED from the minimum", () => {
  // This is the half that is easy to miss and worse than the defect it fixes: overlapping
  // hit areas mean a tap near the seam fires the WRONG control, and a mis-tapped tag chip
  // silently filters the atlas.
  //
  // Chips wrap, so the ROW GAP is the vertical distance between two hit areas. Measured
  // 2026-08-06: a chip renders 24.8px tall at a 30px pitch, so a 44px hit area overlapped
  // the row above by 14px. Expressing the gap as `--touch-min - --chip-h` is what keeps
  // the two in step — a chip restyled taller narrows the gap by exactly as much.
  assert.match(decls(".chip-row"), /row-gap:\s*calc\(var\(--touch-min\)\s*-\s*var\(--chip-h\)\)/);
  assert.match(decls(".chip"), /min-height:\s*var\(--chip-h\)/);
  assert.match(decls(".viewer-screen"), /--chip-h:\s*25px/);

  // Same shape for the lightbox's two chrome buttons, 6.4px apart before this seam and
  // needing (44 - 32) = 12px once each is expanded by 6px on every side.
  assert.match(
    decls(".lightbox-chrome"),
    /gap:\s*calc\(var\(--touch-min\)\s*-\s*var\(--lightbox-chrome-size\)\)/,
  );
  assert.match(decls(".lightbox-chrome-btn"), /width:\s*var\(--lightbox-chrome-size\)/);
  assert.match(decls(".lightbox-chrome-btn"), /height:\s*var\(--lightbox-chrome-size\)/);
});

test("no viewer media query was added — M2's derived mode is still the only switch", () => {
  // The third copy of this pin (mobile_containment for M0, narrow_layout for M2). M3 is
  // the seam with the most reasons to reach for a breakpoint — a lightbox layout, a status
  // bar cull, a target-size pass — and it must not, because the threshold is
  // dataset-dependent and measured against the HOLDER.
  const widthQueries = [...css.matchAll(/@media[^{]*\((?:min|max)-width[^{]*?\)/g)].map((m) =>
    m[0].replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(widthQueries, ["@media (max-width: 1100px)", "@media (max-width: 700px)"]);
});

test("the ☰ label is all-or-nothing: a name that cannot fit whole is replaced by the glyph", () => {
  // Operator, on a real phone 2026-08-06: "if text cannot fit, just the hamburger is likely
  // better (all I see is 'G...')". Measured at 390x844 against rijks_pilot, the label
  // truncated on every layout name that collection ships except `Grid` — `Datetime` wanted
  // 57px and got 47, `Categorical: object type` wanted 146 and got 94.
  //
  // jsdom does no layout, so it cannot decide the fit; what it CAN pin is that the two
  // halves of the mechanism exist and agree. Boolean/count compares only — never a raw node
  // handed to assert's differ, which turns a mutation into a 90s hang that reads as a pass.
  assert.equal(/\.viewer-menu-label-hidden\s*\{[^}]*display:\s*none/.test(css), true,
    "the collapsed label is not actually removed from the flex row, so its gap survives");

  const src = readFileSync(new URL("../../src/ui/ViewerMenu.ts", import.meta.url), "utf8");
  // The decision is settled ONCE per (label, width): un-hide, reflow, measure, commit. A
  // feedback loop would oscillate, because hiding the label frees the width that made it
  // not fit.
  assert.equal(src.includes("classList.remove(\"viewer-menu-label-hidden\")"), true,
    "the settle step never un-hides before measuring, so it can only ever hide once");
  assert.equal(/scrollWidth\s*>\s*\w+\.clientWidth/.test(src), true,
    "the fit test does not compare natural width against allotted width");
  // …and it must NOT add a second holder observer — SCOPE §3.1 gives ViewerScreen the one.
  assert.equal(src.includes("new ResizeObserver"), false,
    "ViewerMenu added a competing ResizeObserver; the holder's observer is ViewerScreen's");
});

test("the sheet's dismiss control points the way the sheet moves", () => {
  // Operator, real phone: "the hide button is not... correct (it should point down)". The
  // desktop rail collapses SIDEWAYS and keeps `›`; the bottom sheet dismisses DOWNWARD, and
  // shipping the rail's glyph there contradicts the motion. Parameterised, not replaced —
  // one component still serves both, the way collapseLabel already is.
  const header = readFileSync(new URL("../../src/ui/InspectorHeader.ts", import.meta.url), "utf8");
  const sheet = readFileSync(new URL("../../src/ui/InspectorSheet.ts", import.meta.url), "utf8");
  assert.equal(header.includes("props.collapseGlyph ?? \"›\""), true,
    "InspectorHeader no longer defaults to the rail's glyph, so the DESKTOP rail changed too");
  assert.equal(/collapseGlyph:\s*"⌄"/.test(sheet), true,
    "the sheet does not override the glyph — it still points sideways for a downward dismiss");
});
