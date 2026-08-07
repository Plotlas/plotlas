// DOM tier — Seam M2 (narrow-screen layout model) of the mobile-viewer workstream
// (docs/plan/SCOPE_mobile-viewer.md, T2-202; brief
// docs/prompts/brief_responsive_cockpit_seam.md).
//
// What this tier can and cannot see, so every pin below is honest about which it is:
//
//  * jsdom does NO layout. `getBoundingClientRect()` is all zeroes, no stylesheet is
//    applied, and `scrollWidth`/`clientWidth` are 0 on everything. So NOTHING here
//    asserts a pixel. The geometry acceptance — the desktop rails still at x = 14…250 /
//    979…1251, and Constraint M-1's sheet-vs-minimap rects — is the e2e case in
//    `e2e/narrow-cockpit.spec.ts` (SCOPE decision D6(c)).
//  * What jsdom CAN drive is the DECISION and the STRUCTURE: the pure mode helper fed
//    explicit widths, and the real ViewerScreen re-rendered with a holder whose
//    clientWidth is defined by this file. `clientWidth` is the one measurement the mode
//    reads, so overriding it is a faithful narrow holder rather than a mode flag — the
//    component runs its own derivation on the way through.
//  * The reveal rule is jsdom-unreachable through the canvas (handleCanvasClick returns
//    early while the renderer stack is null), which is exactly why it is an exported
//    hook — the same extraction `bandSnapBBox` / `runLocate` / `layoutFitRect` made.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViewerScreen, useRevealOnSelection } from "../../src/ui/ViewerScreen.ts";
import { ViewerMenu } from "../../src/ui/ViewerMenu.ts";
import { InspectorSheet } from "../../src/ui/InspectorSheet.ts";
import {
  FALLBACK_COCKPIT_LENGTHS,
  cockpitFloor,
  isNarrowCockpit,
  measureTopbarFloor,
  railsFloor,
  topbarFloorFrom,
} from "../../src/ui/viewerLayoutMode.ts";
import type { SheetDetail } from "../../src/ui/InspectorSheet.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { LayoutInfo, SearchHit } from "../../src/api-client/types.ts";

// Same WebGL-less mount as viewer_panels / mobile_containment: getContext returns null
// so THREE fails with its own clean error instead of jsdom's thrower.
const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof realGetContext;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  cleanup();
});

// ---------------------------------------------------------------------------
// §3.1 pin 1 — the mode switch is DERIVED. Fed widths, asserted on the decision.
// ---------------------------------------------------------------------------

// Deliberately NOT the shipped numbers: a test that restates app.css would pass against
// a helper that ignores its inputs entirely and returned a hardcoded threshold.
const RAILS = { inset: 10, tagRailWidth: 200, inspectorWidth: 300 };

test("the rails floor is arithmetic over the rails' own widths, not a chosen number", () => {
  // 200 + 300 + 2·10 = 520 before the atlas gets anything, and the atlas floor is the
  // WIDER rail (300) — the canvas may not be narrower than the panel floating over it.
  assert.equal(railsFloor(RAILS), 820);

  // The property a constant would not have: widen the Inspector and the floor follows.
  assert.equal(railsFloor({ ...RAILS, inspectorWidth: 360 }), 360 + 200 + 20 + 360);
  // ...and it tracks the WIDER rail, whichever that is — swap them and the answer is
  // the same, so this is not accidentally reading one named field.
  assert.equal(
    railsFloor({ ...RAILS, tagRailWidth: 300, inspectorWidth: 200 }),
    railsFloor(RAILS),
  );
});

test("the mode switch takes the WORSE of the two terms, and the top-bar term is what makes it dataset-dependent", () => {
  const wide = { ...RAILS, holderWidth: 900, topbarFloor: null };
  assert.equal(isNarrowCockpit(wide), false, "900px clears the 820px rails floor");
  assert.equal(cockpitFloor(wide), 820);

  // The rails term alone.
  assert.equal(isNarrowCockpit({ ...wide, holderWidth: 819 }), true);
  assert.equal(isNarrowCockpit({ ...wide, holderWidth: 820 }), false, "the floor itself still fits");

  // The TOP-BAR term alone — the same 900px holder, the same rails, a collection whose
  // tab row needs more room. This is the case a `max-width: 700px` breakpoint gets
  // wrong: nothing about the viewport changed, only the number of layouts baked into
  // the collection (SCOPE §1a: ~855px for rijks_pilot's five, "this number moves with
  // the layout count").
  assert.equal(isNarrowCockpit({ ...wide, topbarFloor: 1180 }), true);
  assert.equal(cockpitFloor({ ...wide, topbarFloor: 1180 }), 1180);
  // ...and a top bar that needs LESS than the rails cannot pull the threshold down.
  assert.equal(cockpitFloor({ ...wide, topbarFloor: 400 }), 820);

  // An unmeasured holder answers NULL — "no information" — not `false` (#271 F15). A
  // ResizeObserver reports 0 whenever the holder is transiently out of layout, and
  // reading that as WIDE flipped an already-narrow viewer back to desktop, re-mounting
  // both rails over an open Tags panel. The caller keeps its current mode instead; the
  // INITIAL mode is still desktop, which is ViewerScreen's useState default.
  assert.equal(isNarrowCockpit({ ...wide, holderWidth: 0 }), null);
  assert.equal(isNarrowCockpit({ ...wide, holderWidth: -1 }), null);
});

test("the top bar's floor is the sum of what CANNOT give way — and it scales with the layout count", () => {
  // A five-layout collection: nav controls 200, tab row 400, search 256, three pills
  // with two 10px gaps, 28px of insets.
  const five = { navFixed: 200, otherPills: [400, 256], gap: 10, insets: 28 };
  assert.equal(topbarFloorFrom(five), 200 + 400 + 256 + 20 + 28);

  // THE property no breakpoint has: bake more layouts into the collection and the
  // threshold moves with them. Nothing about the viewport changed.
  const fifteen = { ...five, otherPills: [1200, 256] };
  assert.equal(topbarFloorFrom(fifteen) - topbarFloorFrom(five), 800);

  // The collection NAME is deliberately absent from every term: it ellipsizes by design
  // (its id is already the tooltip), so it is not part of any floor. This is the whole
  // reason `navFixed` is the nav's fixed content rather than the nav's width.
  assert.equal(topbarFloorFrom({ ...five, navFixed: 200 }), topbarFloorFrom(five));

  // Gaps are counted between pills, not per pill — one pill has none.
  assert.equal(topbarFloorFrom({ navFixed: 200, otherPills: [], gap: 10, insets: 28 }), 228);
  // ...and a fourth pill (the activity indicator, which only renders while a job runs)
  // brings its own gap.
  assert.equal(topbarFloorFrom({ ...five, otherPills: [400, 256, 90] }), topbarFloorFrom(five) + 100);
});

// ---------------------------------------------------------------------------
// The top-bar term against a REAL bar — the path where the threshold is
// dataset-dependent, and the only place `measureTopbarFloor`'s arithmetic runs
// ---------------------------------------------------------------------------

/** Build a top bar with stubbed geometry: jsdom lays nothing out, so every width here is
 *  supplied. This is the only way to exercise `measureTopbarFloor` at all — and until it
 *  existed the dataset-dependent term never decided the mode in ANY test (review #271
 *  F13), which is exactly how the off-by-one-gap defect F12 survived a full green run. */
function stubTopbar(opts: {
  holderWidth: number;
  barWidth: number;
  navChildren: number[]; // the LAST entry is the elastic .viewer-title
  navGap: number;
  navPad: number;
  pills: { width: number; activity?: boolean }[];
  barGap: number;
}): HTMLElement {
  const holder = document.createElement("div");
  holder.className = "canvas-holder";
  Object.defineProperty(holder, "clientWidth", { value: opts.holderWidth, configurable: true });

  const rect = (el: HTMLElement, width: number): void => {
    el.getBoundingClientRect = (() => ({ width, right: width, left: 0 })) as never;
  };

  const bar = document.createElement("header");
  bar.className = "cockpit-topbar";
  bar.style.columnGap = `${opts.barGap}px`;
  rect(bar, opts.barWidth);

  const nav = document.createElement("div");
  nav.className = "panel-float topbar-nav";
  nav.style.columnGap = `${opts.navGap}px`;
  nav.style.paddingLeft = `${opts.navPad / 2}px`;
  nav.style.paddingRight = `${opts.navPad / 2}px`;
  opts.navChildren.forEach((w, i) => {
    const kid = document.createElement("span");
    // The last child is the collection name — the one elastic part, excluded by WIDTH.
    if (i === opts.navChildren.length - 1) kid.className = "viewer-title";
    rect(kid, w);
    nav.appendChild(kid);
  });
  bar.appendChild(nav);

  for (const p of opts.pills) {
    const pill = document.createElement("div");
    pill.className = p.activity === true ? "panel-float topbar-activity" : "panel-float topbar-layouts";
    rect(pill, p.width);
    bar.appendChild(pill);
  }
  holder.appendChild(bar);
  return holder;
}

test("measureTopbarFloor sums the bar's parts — and counts EVERY nav gap, including the elastic title's", () => {
  // nav: brand 16, divider 1, back 101, title 160 (elastic) → 4 children, 3 gaps of 10,
  // padding 20. The title's WIDTH is excluded; its GAPS are not, because it stays in
  // flow. navFixed = 16 + 1 + 101 + 3·10 + 20 = 168.
  const holder = stubTopbar({
    holderWidth: 1000,
    barWidth: 972,
    navChildren: [16, 1, 101, 160],
    navGap: 10,
    navPad: 20,
    pills: [{ width: 500 }, { width: 256 }],
    barGap: 10,
  });
  // 168 + 500 + 256 + 2 gaps of 10 + insets (1000 - 972 = 28) = 972.
  assert.equal(measureTopbarFloor(holder), 972);
});

test("the top-bar term is what decides the mode on a many-layout collection", () => {
  // The regression F13 names: with the rails floor at 808, only a collection whose TAB
  // ROW is wide enough pushes the threshold past it — and that is the PR's headline
  // claim. A 6-layout-sized bar at a 1000px holder wants 972 (above), so 950 is narrow
  // and 1000 is not, and neither answer comes from the rails.
  const parts = {
    holderWidth: 1000,
    barWidth: 972,
    navChildren: [16, 1, 101, 160],
    navGap: 10,
    navPad: 20,
    pills: [{ width: 500 }, { width: 256 }],
    barGap: 10,
  };
  const topbarFloor = measureTopbarFloor(stubTopbar(parts));
  assert.ok(topbarFloor !== null);
  assert.ok(topbarFloor > railsFloor(FALLBACK_COCKPIT_LENGTHS), "the rails term still dominates — this fixture proves nothing");

  const at = (holderWidth: number): boolean | null =>
    isNarrowCockpit({ ...FALLBACK_COCKPIT_LENGTHS, holderWidth, topbarFloor });
  assert.equal(at(950), true, "950px is above the rails floor, so ONLY the top-bar term can call it narrow");
  assert.equal(at(1000), false);

  // A ONE-layout collection at the same widths is wide at both — same code, same CSS,
  // different collection. This is the property a breakpoint cannot have.
  const oneLayout = measureTopbarFloor(stubTopbar({ ...parts, pills: [{ width: 90 }, { width: 256 }] }));
  assert.ok(oneLayout !== null && oneLayout < 950);
  assert.equal(
    isNarrowCockpit({ ...FALLBACK_COCKPIT_LENGTHS, holderWidth: 950, topbarFloor: oneLayout }),
    false,
    "a one-layout collection went narrow at a width where only a six-layout one should",
  );
});

test("the transient activity pill is not part of the bar's minimum", () => {
  // #271 F11: a job starting or ending is not a re-measure trigger, so a width baked in
  // while the pill happened to be up would outlive it and could wedge the mode narrow.
  const base = {
    holderWidth: 1000,
    barWidth: 972,
    navChildren: [16, 1, 101, 160],
    navGap: 10,
    navPad: 20,
    barGap: 10,
  };
  const without = measureTopbarFloor(stubTopbar({ ...base, pills: [{ width: 500 }, { width: 256 }] }));
  const withPill = measureTopbarFloor(
    stubTopbar({ ...base, pills: [{ width: 500 }, { width: 256 }, { width: 90, activity: true }] }),
  );
  assert.equal(withPill, without, "the activity pill changed the bar's measured minimum");
});

test("measureTopbarFloor declines to answer when there is no desktop bar to measure", () => {
  // Narrow mode has no tab row; the caller must CARRY its previous belief rather than
  // learn a number about the wrong bar.
  const holder = stubTopbar({
    holderWidth: 1000,
    barWidth: 972,
    navChildren: [16, 1, 101, 160],
    navGap: 10,
    navPad: 20,
    pills: [{ width: 256 }],
    barGap: 10,
  });
  (holder.querySelector(".topbar-layouts") as HTMLElement).className = "panel-float topbar-search";
  assert.equal(measureTopbarFloor(holder), null);
});

// ---------------------------------------------------------------------------
// The one place the mode's inputs could drift: the fallback lengths vs app.css
// ---------------------------------------------------------------------------

const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

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

test("the mode helper's fallback lengths are the ones app.css actually declares", () => {
  // viewerLayoutMode reads these off the live stylesheet and only falls back when none
  // is applied (jsdom). The fallback is therefore load-bearing for every DOM-tier mount
  // in this repo, and a CSS-side change that left it behind would move the threshold
  // silently in one tier and not the other.
  const viewer = decls(".viewer-screen");
  assert.match(viewer, new RegExp(`--cockpit-inset:\\s*${FALLBACK_COCKPIT_LENGTHS.inset}px`));
  assert.match(viewer, new RegExp(`--rail-tags-w:\\s*${FALLBACK_COCKPIT_LENGTHS.tagRailWidth}px`));
  assert.match(viewer, new RegExp(`--rail-inspector-w:\\s*${FALLBACK_COCKPIT_LENGTHS.inspectorWidth}px`));

  // ...and the rails are sized FROM those properties, so the rule and the geometry it
  // reasons about cannot come apart.
  assert.match(decls(".tag-rail"), /width:\s*var\(--rail-tags-w\)/);
  assert.match(decls(".inspector"), /width:\s*var\(--rail-inspector-w\)/);
});

test("CONSTRAINT M-1 is structural: the minimap's narrow offset is expressed IN the sheet's peek height", () => {
  // SCOPE §3 D5 — the minimap is the "where am I relative to the whole collection"
  // instrument and D5 was approved on condition it stays visible. jsdom cannot measure
  // the rects (the e2e case does, and quotes them); what it CAN pin is that the
  // clearance is derived from the peek height rather than being a second number that
  // has to be kept in step with it. If the sheet's peek changes, this moves with it.
  assert.match(decls(".inspector-sheet"), /height:\s*var\(--sheet-peek-h\)/);
  // The lift is still DERIVED from the peek — what makes the clearance exact at any peek
  // height instead of a second number kept in step by hand.
  assert.match(
    decls(".cockpit-narrow:has(.inspector-sheet)"),
    /--minimap-bottom:\s*calc\(var\(--sheet-peek-h\)\s*\+/,
  );
  // …but CONDITIONAL on the sheet existing (operator, real phone 2026-08-06: "the mini map
  // floats in the middle of the screen; it should pin to the bottom"). Lifting whenever the
  // layout was narrow held the minimap up for a sheet that is closed most of the time —
  // measured at 390x844 with `.inspector-sheet` absent: bottom 289.438px, 289px of empty
  // canvas beneath it. The gate is the sheet's OWN presence via :has(), not a class
  // mirrored from React state, so there is one source of truth and no flag to drift.
  // Asserted over the RAW stylesheet, not via decls(), because the property of interest is
  // an ABSENCE — that no rule lifts the minimap without gating on the sheet. Every rule
  // that sets the peek-derived lift must carry the :has() gate.
  const lifts = [...css.matchAll(/([^{}]+)\{([^{}]*--minimap-bottom[^{}]*)\}/g)].filter((m) =>
    /var\(--sheet-peek-h\)/.test(m[2]),
  );
  assert.equal(lifts.length, 1, `expected exactly one peek-derived lift rule, got ${lifts.length}`);
  assert.equal(
    lifts[0][1].includes(":has(.inspector-sheet)"),
    true,
    `the minimap is lifted by a rule that does not gate on the sheet ("${lifts[0][1].trim()}") — ` +
      "it will float mid-canvas whenever the sheet is closed",
  );
  // Both resolve against .canvas-holder, so a PERCENTAGE peek makes the clearance exact
  // — a dvh peek would be measured against a different box and the arithmetic would be
  // approximate at exactly the moment (a collapsing URL bar) it matters most.
  const peek = /--sheet-peek-h:([^;]*);/.exec(decls(".viewer-screen"));
  assert.ok(peek !== null, ".viewer-screen declares no --sheet-peek-h");
  assert.match(peek[1], /%/, "the peek height is not holder-relative");
  assert.doesNotMatch(peek[1], /\bd?vh\b/, "the peek height is measured against the viewport");
  // ...and it is BOUNDED by the room the minimap needs above it (#271 F10). Without this
  // the minimap's top is 0.66·H - 106, which slides behind the top bar on a short holder
  // (landscape split-screen) and clips the instrument M-1 exists to protect. The bound
  // reads the minimap's OWN height, so it tracks a resize of the thing it is clearing.
  assert.match(peek[1], /min\(/, "the peek height is not bounded for a short holder");
  assert.match(peek[1], /var\(--minimap-h\)/, "the short-holder bound does not derive from the minimap");
  // The fit-view button rides on the same one override rather than repeating it.
  assert.match(decls(".fit-view-btn"), /bottom:\s*calc\(var\(--minimap-bottom\)/);
  assert.match(decls(".minimap"), /bottom:\s*var\(--minimap-bottom\)/);
});

test("no viewer media query was added — the mode reaches CSS as a class", () => {
  // The companion to mobile_containment's "no viewer breakpoint" pin, from the other
  // side: M2 is the seam that would have added one. It did not, because the threshold
  // is dataset-dependent and measured against the HOLDER — neither of which a media
  // query can express.
  const widthQueries = [...css.matchAll(/@media[^{]*\((?:min|max)-width[^{]*?\)/g)].map((m) =>
    m[0].replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(widthQueries, ["@media (max-width: 1100px)", "@media (max-width: 700px)"]);
});

// ---------------------------------------------------------------------------
// §3.3 pin 2 — the reveal rule: wide reveals, narrow opens to PEEK and never full
// ---------------------------------------------------------------------------

/** Probe over the SHIPPED reveal rule with the sheet's detail wired in, exactly as
 *  ViewerScreen wires it: two stable useState setters. */
function RevealProbe(props: { selectedIds: number[] }): ReturnType<typeof h> {
  const [collapsed, setCollapsed] = useState(true);
  const [detail, setDetail] = useState<SheetDetail>("full");
  useRevealOnSelection(props.selectedIds, setCollapsed, setDetail);
  return h(
    "div",
    null,
    h("span", { "data-testid": "state" }, collapsed ? "collapsed" : "expanded"),
    h("span", { "data-testid": "detail" }, detail),
    h("button", { type: "button", onClick: () => setDetail("full") }, "pull full"),
  );
}

test("a selection opens the Inspector, and on a narrow holder it opens the SHEET to peek — never to full", async () => {
  const r = render(h(RevealProbe, { selectedIds: [] }));
  const state = (): string => screen.getByTestId("state").textContent ?? "";
  const detail = (): string => screen.getByTestId("detail").textContent ?? "";

  // Nothing selected: neither half fires. A background click that clears the selection
  // is not a reason to reveal anything (the shipped rule, unchanged).
  assert.equal(state(), "collapsed");
  assert.equal(detail(), "full");

  // A selection reveals AND lands on peek — the atlas stays visible above the sheet,
  // which is the whole of fault S3 ("tapping an image hides the atlas").
  r.rerender(h(RevealProbe, { selectedIds: [7] }));
  assert.equal(state(), "expanded", "the selection did not reveal the Inspector");
  assert.equal(detail(), "peek", "the selection opened the sheet past peek");

  // The half that is easy to lose: the user pulls the sheet FULL to read the metadata,
  // then taps another image. That must come back to peek, or every subsequent tap is
  // answered by a screenful of text over the thing that was tapped.
  fireEvent.click(screen.getByText("pull full"));
  assert.equal(detail(), "full");
  r.rerender(h(RevealProbe, { selectedIds: [42] }));
  assert.equal(detail(), "peek", "a selection made while the sheet was full left it full");
  assert.equal(state(), "expanded");
});

// ---------------------------------------------------------------------------
// §3.2 pin 3 — the menu lists EVERY layout (the "hidden layouts" risk D2 decided
// against), and its trigger is labelled rather than a bare glyph
// ---------------------------------------------------------------------------

const LAYOUTS: LayoutInfo[] = [
  { layout_id: "grid", label: "Grid", type: "grid" },
  { layout_id: "by_date", label: "By date", type: "datetime" },
  { layout_id: "by_place", label: "By place", type: "geographic" },
  { layout_id: "by_size", label: "By size", type: "scatter" },
  { layout_id: "by_kind", label: "By kind", type: "categorical" },
];

function MenuProbe(props: { onSwitch: (id: string) => void }): ReturnType<typeof h> {
  const [open, setOpen] = useState(false);
  return h(ViewerMenu, {
    layouts: LAYOUTS,
    activeLayoutId: "grid",
    onSwitch: props.onSwitch,
    open,
    setOpen,
  });
}

test("the ☰ menu lists every layout and each row switches to it", () => {
  const switched: string[] = [];
  render(h(MenuProbe, { onSwitch: (id) => switched.push(id) }));

  // The trigger is LABELLED with the active layout, not a bare glyph — D2's one
  // designed-against risk is that `☰` does not say "there are five ways to see this
  // collection", and layout-switching IS the product's idea.
  const trigger = screen.getByRole("button", { name: /Views, filters and search — showing Grid/ });
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.ok(
    (trigger.textContent ?? "").includes("Grid"),
    "the trigger renders no visible label — a bare glyph is what D2 rejected",
  );

  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");

  // Every layout, not the two that happened to fit a strip. With 5 in, 5 rows out.
  const rows = document.querySelectorAll(".viewer-menu-layout");
  assert.equal(rows.length, LAYOUTS.length, `expected ${LAYOUTS.length} layout rows, got ${rows.length}`);
  assert.deepEqual(
    [...rows].map((r) => r.textContent),
    LAYOUTS.map((l) => l.label),
  );
  // The active one is marked, so the menu answers "which am I looking at" as well as
  // "what else is there".
  assert.equal(rows[0].getAttribute("aria-checked"), "true");
  assert.equal(rows[1].getAttribute("aria-checked"), "false");

  // ...and each NON-active row actually fires the switch. Choosing CLOSES the menu (a
  // popover that stayed open after a choice would sit over the layout it just switched
  // to), so re-open before each row that is not already reachable.
  for (let i = 1; i < LAYOUTS.length; i++) {
    if (document.querySelectorAll(".viewer-menu-layout").length === 0) fireEvent.click(trigger);
    fireEvent.click(document.querySelectorAll(".viewer-menu-layout")[i]);
  }
  assert.deepEqual(switched, LAYOUTS.slice(1).map((l) => l.layout_id));
});

// ---------------------------------------------------------------------------
// §3.3 / §5.7 (structure only) — a narrow HOLDER renders no rails
// ---------------------------------------------------------------------------

/** A ResizeObserver that keeps its callback so a test can drive one observation.
 *  (No constructor PARAMETER PROPERTY: node's strip-only type removal rejects those.) */
class DrivableResizeObserver implements ResizeObserver {
  static last: DrivableResizeObserver | null = null;
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    DrivableResizeObserver.last = this;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  fire(): void {
    this.cb();
  }
}

function stubClient(layouts: LayoutInfo[], hits: SearchHit[] = []): ApiClient {
  return {
    async listLayouts() {
      return layouts;
    },
    async search() {
      return { query: "rem", hits, capped: false };
    },
    async getManifest() {
      return {
        manifest_version: "2.5",
        dataset_id: "ds",
        dataset_version: 1,
        dataset_metadata: { image_count: 3 },
        column_roles: { columns: [] },
        layouts: layouts.map((l) => ({
          layout_id: l.layout_id,
          label: l.label,
          type: l.type,
          bbox: [0, 0, 1, 1],
          pyramid: {
            container: "pmtiles",
            path: `${l.layout_id}.pmtiles`,
            tile_px: 512,
            thumb_px: 64,
            cap: 64,
            levels: [{ z: 0, tile_count: 1 }],
            z_cap: 0,
          },
        })),
      };
    },
    authHeaders() {
      return {};
    },
  } as unknown as ApiClient;
}

/** Mount the real ViewerScreen, then report a holder of `holderWidth` px through the
 *  component's OWN ResizeObserver path. Nothing here sets a mode: `clientWidth` is the
 *  single measurement `measureCockpit` reads, so the component runs its real derivation
 *  (and, with no stylesheet applied, its real fallback lengths). */
async function mountAtHolderWidth(
  holderWidth: number,
  layouts = LAYOUTS,
  hits: SearchHit[] = [],
): Promise<HTMLElement> {
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = DrivableResizeObserver;
  try {
    const r = render(
      h(ViewerScreen, {
        datasetId: "ds",
        client: stubClient(layouts, hits),
        onBack: () => {},
        onAuthExpired: () => {},
      }),
    );
    await screen.findByRole("combobox");
    const container = r.container as HTMLElement;
    const holder = container.querySelector(".canvas-holder") as HTMLElement;
    Object.defineProperty(holder, "clientWidth", { value: holderWidth, configurable: true });
    act(() => {
      DrivableResizeObserver.last?.fire();
    });
    return container;
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  }
}

test("a narrow holder renders NO rails — it renders the sheet, the full-screen Tags panel and the ☰", async () => {
  // 390px is the iPhone-14-class layout viewport SCOPE §1a measured against; the rails
  // floor is 808px with the shipped lengths, so this is comfortably narrow.
  const container = await mountAtHolderWidth(390);

  assert.equal(container.querySelector(".viewer-screen.cockpit-narrow") !== null, true,
    "the holder measured 390px and the cockpit did not go narrow");
  // "The rails are not collapsed on narrow — they are not rendered" (brief §3.3). The
  // collapsed-chevron affordance must be gone too, or the rails are merely hidden.
  assert.equal(container.querySelector(".tag-rail") === null, true, "the tag rail is still rendered");
  assert.equal(container.querySelector(".inspector") === null, true, "the inspector rail is still rendered");
  assert.equal(container.querySelector(".rail-collapsed") === null, true, "a rail chevron is still rendered");
  // The desktop tab row and the top-bar search pill are gone from the BAR...
  assert.equal(container.querySelector(".topbar-layouts") === null, true, "the desktop tab row survived");
  assert.equal(container.querySelector(".cockpit-topbar > .topbar-search") === null, true,
    "the search pill is still a top-bar child");
  // ...and there is still exactly ONE combobox in the document: search MOVED into the
  // menu, it was not duplicated, so the #227 ARIA contract has one owner.
  fireEvent.click(screen.getByRole("button", { name: /Views, filters and search/ }));
  assert.equal(document.querySelectorAll('[role="combobox"]').length, 1);
  assert.equal(container.querySelector(".viewer-menu .topbar-search") !== null, true,
    "the search pill did not move into the menu");

  // The Tags panel is a DESTINATION: closed until asked for, even though the desktop
  // rail it replaces is expanded by default.
  assert.equal(container.querySelector(".tags-panel") === null, true,
    "the full-screen Tags panel opened itself over the atlas");
  fireEvent.click(screen.getByRole("menuitem", { name: "Tags…" }));
  assert.equal(container.querySelector(".tags-panel") !== null, true, "the menu did not open Tags");
  fireEvent.click(screen.getByLabelText("Close tags"));
  assert.equal(container.querySelector(".tags-panel") === null, true, "Tags has no way out");
});

// ---------------------------------------------------------------------------
// Review #271 — the behaviours the fixes restored
// ---------------------------------------------------------------------------

test("the ☰'s section heading is not a child of role=menu, and choosing a layout returns focus (F5, F7)", async () => {
  const container = await mountAtHolderWidth(390);
  fireEvent.click(screen.getByRole("button", { name: /Views, filters and search/ }));

  // F5: a menu's children must be menuitem / menuitemradio / group / separator. A bare
  // <p> inside one is invalid and assistive tech may skip it or mis-count the items.
  const menu = container.querySelector('[role="menu"]') as HTMLElement;
  assert.ok(menu !== null, "the ☰ renders no menu");
  assert.equal(
    menu.querySelector(".viewer-menu-section") === null,
    true,
    "the section heading is still inside role=menu",
  );
  assert.ok(container.querySelector(".viewer-menu-section") !== null, "the heading was dropped entirely");
  assert.equal(menu.getAttribute("aria-label"), "Views");

  // F7: choosing unmounts the focused row, so focus must land back on the trigger rather
  // than fall to <body> — the same return the Escape path does.
  const trigger = screen.getByRole("button", { name: /Views, filters and search/ });
  fireEvent.click(container.querySelectorAll(".viewer-menu-layout")[1]);
  assert.equal(document.activeElement === trigger, true, "choosing a layout dropped focus to <body>");
});

test("Escape over the Tags panel closes it and is not seen by anything below (F1)", async () => {
  const container = await mountAtHolderWidth(390);
  fireEvent.click(screen.getByRole("button", { name: /Views, filters and search/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Tags…" }));
  assert.ok(container.querySelector(".tags-panel") !== null);
  // Focus moves INTO the dialog on open, so a screen reader is reading the panel the
  // user just asked for rather than staying on an unmounted menu item.
  assert.equal(
    document.activeElement === container.querySelector(".tags-panel"),
    true,
    "opening the Tags panel left focus outside it",
  );

  // The panel owns Escape. Without this the key fell through to the window-level
  // clear-selection (T2-204) and silently emptied the selection BEHIND a panel that
  // stayed open. `window` is where that listener lives, so a capture-phase consumer on
  // `document` must stop it before it arrives.
  let reachedWindow = false;
  const spy = (): void => {
    reachedWindow = true;
  };
  window.addEventListener("keydown", spy);
  try {
    fireEvent.keyDown(document, { key: "Escape" });
  } finally {
    window.removeEventListener("keydown", spy);
  }
  // Boolean compare — never hand a jsdom node to assert's differ. Measured on this very
  // pin: a failing `assert.equal(el, null)` makes node util.inspect walk the whole DOM to
  // build a diff and the runner is SIGKILLed at 90s, so the mutation "hangs" instead of
  // reporting. viewer_panels.dom.test.ts documents the same trap.
  assert.equal(
    container.querySelector(".tags-panel") === null,
    true,
    "Escape did not close the Tags panel",
  );
  assert.equal(reachedWindow, false, "Escape carried on past the dialog to the clear-selection handler");
});

test("the sheet's dismiss is announced as a close, and the desktop rail is untouched (F6)", async () => {
  // Mounted DIRECTLY: the sheet only exists once a cell is selected, and a jsdom mount
  // cannot produce a canvas selection (handleCanvasClick returns early with no renderer
  // stack). Guarding the assertion on the sheet's presence instead would make this pin
  // silently vacuous, which is worse than not having it.
  const r = render(
    h(InspectorSheet, {
      detail: "peek",
      setDetail: () => {},
      selectionCount: 1,
      onClear: () => {},
      onClose: () => {},
    }),
  );
  const sheetBtn = (r.container as HTMLElement).querySelector(".rail-toggle") as HTMLElement;
  assert.ok(sheetBtn !== null, "the sheet renders no dismiss control");
  // A dismiss has no collapsed state to return from, so it must not promise one: the
  // sheet leaves no chevron behind, unlike the desktop rail it borrows this header from.
  assert.equal(sheetBtn.getAttribute("aria-label"), "Close inspector");
  assert.equal(sheetBtn.getAttribute("aria-expanded"), null, "the sheet's close still claims an expanded state");
  cleanup();

  const wide = await mountAtHolderWidth(1400);
  const railBtn = wide.querySelector(".inspector .rail-toggle") as HTMLElement;
  assert.ok(railBtn !== null, "no desktop inspector rail rendered");
  assert.equal(railBtn.getAttribute("aria-label"), "Collapse inspector", "the desktop rail's label changed");
  assert.equal(railBtn.getAttribute("aria-expanded"), "true", "the desktop rail lost aria-expanded");
});

test("activating a search result closes the ☰ it was chosen from (F2)", async () => {
  const container = await mountAtHolderWidth(390, LAYOUTS, [
    { id: 7, field: "title", role: "title", label: "Title", snippet: "Night Watch" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: /Views, filters and search/ }));

  // In narrow the results list lives INSIDE the popover, so the outside-pointerdown
  // dismiss cannot fire for a click on a row — the click IS inside the menu. Without an
  // explicit close the menu sat over the very cell it just flew to.
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "rem" } });
  await waitFor(() => assert.ok(document.querySelector('[role="option"]') !== null), { timeout: 2000 });
  assert.ok(container.querySelector(".viewer-menu") !== null, "the menu closed before the row was clicked");

  fireEvent.click(document.querySelector('[role="option"]') as HTMLElement);
  // Boolean compare (see the F1 pin above): a node handed to assert's differ OOM-kills
  // the runner on failure, so the mutation would hang rather than report.
  await waitFor(() =>
    assert.equal(
      container.querySelector(".viewer-menu") === null,
      true,
      "the ☰ stayed open over the destination",
    ),
  );
});

test("the mode is measured BEFORE paint, not after (F9)", () => {
  // A WIRING pin over the SOURCE, the same move mobile_containment.dom.test.ts makes for
  // the boot fit: jsdom cannot observe a frame, and the defect here IS a frame — `narrow`
  // starts false, so a passive effect corrects it only after the browser has painted one
  // frame of the desktop cockpit with both rails overlapping at 390px. Anchors asserted
  // UNIQUE so a "single" perturbation cannot be compound.
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const uniqueIndexOf = (anchor: string): number => {
    const first = src.indexOf(anchor);
    assert.notEqual(first, -1, `anchor missing from ViewerScreen.ts: ${anchor}`);
    assert.equal(src.lastIndexOf(anchor), first, `anchor is not unique in ViewerScreen.ts: ${anchor}`);
    return first;
  };
  const hook = uniqueIndexOf("useLayoutEffect(() => {\n    measureCockpit();");
  assert.ok(hook > 0);
});

test("widening the holder brings the desktop cockpit back", async () => {
  const container = await mountAtHolderWidth(390);
  assert.equal(container.querySelector(".viewer-screen.cockpit-narrow") !== null, true);

  const holder = container.querySelector(".canvas-holder") as HTMLElement;
  Object.defineProperty(holder, "clientWidth", { value: 1265, configurable: true });
  act(() => {
    DrivableResizeObserver.last?.fire();
  });

  assert.equal(container.querySelector(".viewer-screen.cockpit-narrow") === null, true,
    "a 1265px holder is still reporting narrow");
  assert.equal(container.querySelector(".tag-rail") !== null, true, "the tag rail did not come back");
  assert.equal(container.querySelector(".inspector") !== null, true, "the inspector rail did not come back");
  assert.equal(container.querySelector(".topbar-layouts") !== null, true, "the tab row did not come back");
  assert.equal(container.querySelector(".viewer-menu-wrap") === null, true, "the ☰ survived into desktop");
});
