// DOM tier — Seam M0 (containment & boot fit) of the mobile-viewer workstream
// (docs/plan/SCOPE_mobile-viewer.md, T2-202; brief
// docs/prompts/brief_mobile_containment_seam.md).
//
// What this tier CAN and CANNOT see, so the pins below are honest about which they are:
//
//  * jsdom does NO layout — `getBoundingClientRect()` is all zeroes and no stylesheet is
//    ever applied — so nothing here may assert a pixel width. The pixel acceptance
//    (`documentElement.scrollWidth === clientWidth` at 390px) is the e2e case in
//    `e2e/mobile-viewport.spec.ts`, per SCOPE decision D6(c). What jsdom CAN pin is the
//    DECLARATION that produces it, which is the same move
//    viewer_panels.dom.test.ts already makes for the top-bar padding.
//  * Everything after `createWorld` in the mount effect is unreachable here (no WebGL ⇒
//    createWorld throws and the shipped `.catch` turns it into the error banner). That
//    is where the boot fit lives, so it is pinned as (a) the pure rect decision
//    `layoutFitRect` — the extraction `useRevealOnSelection` / `bandSnapBBox` / `runLocate`
//    already made for their own unreachable wiring — plus (b) a WIRING pin over the
//    source, because a pure pin cannot notice its own call being deleted, and deleting
//    that call is exactly how the defect comes back.
//  * The ResizeObserver, by contrast, is installed in the SYNCHRONOUS part of the mount
//    effect, so that one drives the real component.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";

import { ViewerScreen, layoutFitRect } from "../../src/ui/ViewerScreen.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";

// Same WebGL-less mount as viewer_panels.dom.test.ts: getContext returns null so THREE
// fails with its own clean "Error creating WebGL context" instead of jsdom's thrower.
const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof realGetContext;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  cleanup();
});

/** A manifest whose layout bbox is a SUB-region of [0,1]² — the whole point of the boot
 *  fit is that these two are different. The second layout has a different bbox so a
 *  "fits whatever it finds first" regression cannot pass. */
function manifestWith(...boxes: [string, [number, number, number, number]][]): LayoutManifest {
  return {
    manifest_version: "2.5",
    dataset_id: "ds",
    dataset_version: 1,
    dataset_metadata: { image_count: 3 },
    column_roles: { columns: [] },
    layouts: boxes.map(([layout_id, bbox]) => ({
      layout_id,
      label: layout_id,
      type: "grid",
      bbox,
      pyramid: {
        container: "pmtiles",
        path: `${layout_id}.pmtiles`,
        tile_px: 512,
        thumb_px: 64,
        cap: 64,
        levels: [{ z: 0, tile_count: 1 }],
        z_cap: 0,
      },
    })),
  } as unknown as LayoutManifest;
}

/** A client answering only what a ViewerScreen mount needs (viewer_panels.dom.test.ts). */
function stubClient(): ApiClient {
  return {
    async listLayouts() {
      return [{ layout_id: "grid", label: "Grid", type: "grid" }];
    },
    async getManifest() {
      return manifestWith(["grid", [0.25, 0.25, 0.75, 0.75]]);
    },
    authHeaders() {
      return {};
    },
  } as unknown as ApiClient;
}

// ---------------------------------------------------------------------------
// §3.4 — boot fit: which rect, and is it actually wired in
// ---------------------------------------------------------------------------

test("layoutFitRect fits the NAMED layout's bbox — not the [0,1]² coordinate space", () => {
  const mf = manifestWith(
    ["grid", [0.25, 0.25, 0.75, 0.75]],
    ["by_date", [0, 0.4, 1, 0.6]],
  );

  // The defect this closes: the boot camera framed the whole coordinate space. A rect
  // covering [0,1]² would be indistinguishable from no fit at all, so the fixture's
  // bboxes are deliberately proper sub-regions.
  assert.deepEqual(layoutFitRect(mf, "grid"), { xMin: 0.25, yMin: 0.25, xMax: 0.75, yMax: 0.75 });

  // ...and it is the bbox of the layout ASKED FOR, not of the first one in the manifest.
  assert.deepEqual(layoutFitRect(mf, "by_date"), { xMin: 0, yMin: 0.4, xMax: 1, yMax: 0.6 });

  // null means "do not move the camera" — every caller treats it as a no-op.
  assert.equal(layoutFitRect(mf, "not_baked"), null);
  assert.equal(layoutFitRect(mf, null), null);
  assert.equal(layoutFitRect(null, "grid"), null);
});

test("the mount effect fits the layout at boot, after activate() and before world.start()", () => {
  // A WIRING pin, deliberately over the SOURCE: the boot fit is jsdom-unreachable (no
  // WebGL ⇒ createWorld throws first), and a pure pin on layoutFitRect cannot fail when
  // its call site is deleted — which is precisely how fault L5 comes back. Ordering is
  // load-bearing in both directions: before activate() there is no active layout to
  // frame, and after world.start() the user would see one frame of the old whole-world
  // camera. Anchors are asserted UNIQUE so a "single" perturbation cannot be compound.
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const uniqueIndexOf = (anchor: string): number => {
    const first = src.indexOf(anchor);
    assert.notEqual(first, -1, `anchor missing from ViewerScreen.ts: ${anchor}`);
    assert.equal(src.lastIndexOf(anchor), first, `anchor is not unique in ViewerScreen.ts: ${anchor}`);
    return first;
  };

  const activate = uniqueIndexOf("await controller.activate(firstLayout);");
  const chooseRect = uniqueIndexOf("layoutFitRect(mf, firstLayout)");
  const driveCamera = uniqueIndexOf("world.setCameraState(fitCamera(bootRect, world.getViewport()))");
  const start = uniqueIndexOf("world.start();");

  assert.ok(activate < chooseRect, "the boot fit runs BEFORE controller.activate() — no layout is active yet");
  assert.ok(chooseRect < driveCamera, "the boot rect is chosen but never applied to the camera");
  assert.ok(driveCamera < start, "the boot fit runs AFTER world.start() — the first frame is still whole-world");

  // It must read the manifest the effect HOLDS. `fitToLayout` reads the `manifest`
  // state, which inside this effect's closure is still null, so a call to it here is a
  // silent no-op — the failure mode that looks correct in review and does nothing.
  assert.equal(
    src.slice(activate, start).includes("fitToLayout("),
    false,
    "the boot fit calls fitToLayout, which reads the not-yet-rendered `manifest` state and no-ops",
  );
});

// ---------------------------------------------------------------------------
// §3.5 — the canvas is re-measured when the HOLDER resizes (fault I5)
// ---------------------------------------------------------------------------

let observed: Element[] = [];
let disconnects = 0;

class FakeResizeObserver implements ResizeObserver {
  observe(target: Element): void {
    observed.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnects += 1;
  }
}

test("the viewer observes its canvas holder for resizes, and disconnects on unmount", async () => {
  // jsdom implements no ResizeObserver, so the component feature-detects it and this
  // test supplies one. (That detection is why every other DOM-tier mount still works.)
  observed = [];
  disconnects = 0;
  const real = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  try {
    const r = render(
      h(ViewerScreen, {
        datasetId: "ds",
        client: stubClient(),
        onBack: () => {},
        onAuthExpired: () => {},
      }),
    );
    await screen.findByRole("combobox");

    // The observed element must be the HOLDER — the element `measure()` reads
    // clientWidth/Height from. Observing the window, the canvas or the document would
    // all "pass" a looser assertion and none of them is what sizes the drawing buffer.
    const holder = (r.container as HTMLElement).querySelector(".canvas-holder");
    assert.equal(observed.length, 1, `expected exactly one observe(), got ${observed.length}`);
    // Boolean compare — never hand a jsdom node to assert's differ (viewer_panels.dom
    // measured util.inspect walking the tree and OOM-killing the runner).
    assert.equal(observed[0] === holder, true, "the ResizeObserver is not watching .canvas-holder");

    r.unmount();
    assert.equal(disconnects, 1, "the ResizeObserver outlived the viewer it was measuring");
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = real;
  }
});

// ---------------------------------------------------------------------------
// §3.1 / §3.2 / §3.3 — the containment DECLARATIONS
// ---------------------------------------------------------------------------

const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every declaration block whose selector list is EXACTLY `selector`, concatenated
 *  (a selector may legitimately be declared more than once — .layout-switcher is).
 *  The regex skips `@media` preludes for free: `[^{}]+` cannot span the nested brace,
 *  so only the inner rule ever matches. */
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

test("nothing floating over the canvas can paint outside it, and the layout tabs clip inside their pill", () => {
  // L1: .canvas-holder is the containing block for every floating panel, so clipping it
  // is what stops the page scrolling sideways.
  assert.match(decls(".canvas-holder"), /overflow:\s*hidden/);

  // L2: a flex item's automatic minimum size is min-content, so the three top-bar pills
  // cannot yield a pixel without this — and clipping the holder without it would hide
  // the search box instead of fitting it.
  assert.match(decls(".cockpit-topbar > .panel-float"), /min-width:\s*0/);
  assert.match(decls(".topbar-nav .viewer-title"), /text-overflow:\s*ellipsis/);
  // ...and the shrink ORDER: the search pill is the one that must NOT shrink. Measured
  // 2026-08-06 at 390px — under proportional shrink the pill came out 51px while the
  // input inside it is capped at 30vw = 117px, so the input hung out to x = 450 and was
  // clipped off the screen. The pills that ellipsize / scroll absorb the pressure.
  assert.match(decls(".topbar-search"), /flex:\s*none/);
  assert.match(decls(".topbar-nav"), /overflow:\s*hidden/);

  // M0's interim scroll strip is GONE (Seam M2 §3.2 — D2 rejected it, the hamburger
  // replaces it). What replaces it is the strict version of M0's own shrink ORDER: the
  // collection NAME is the only elastic part of the bar, so the tab row keeps every
  // layout reachable at every desktop width instead of truncating itself. That is also
  // what makes the bar's requirement measurable — with both non-elastic pills at natural
  // width, `topbarOverflow` reads the bar's MIN-CONTENT deficit, which is the number the
  // narrow-mode threshold is learned from (ui/viewerLayoutMode.ts).
  assert.doesNotMatch(decls(".layout-switcher"), /overflow-x/);
  assert.match(decls(".topbar-layouts"), /flex:\s*none/);
  assert.match(decls(".layout-switcher > .layout-tab"), /flex:\s*none/);
});

test("the status bar fits its own width, and never at the credit's expense", () => {
  // L4. min-width:0 alone was already declared and is not sufficient: it lets the group
  // shrink, but an unclipped overflowing child still counts toward the ancestor's
  // scrollWidth, which is the number the e2e case asserts on.
  assert.match(decls(".status-group"), /min-width:\s*0/);
  assert.match(decls(".status-group"), /overflow:\s*hidden/);
  assert.match(decls(".status-item"), /min-width:\s*0/);
  assert.match(decls(".status-item"), /text-overflow:\s*ellipsis/);

  // The credit is an attribution obligation: it may ellipsize, it may not be removed.
  assert.doesNotMatch(decls(".status-credit"), /display:\s*none/);
  assert.doesNotMatch(decls(".status-item"), /display:\s*none/);
});

test("the shell and both floating panels are sized in dvh, with the vh declaration kept as the fallback", () => {
  // S4: on mobile `vh` resolves against the LARGE viewport (URL bar hidden), so a panel
  // measured in vh extends past what the user can see. Order matters — the fallback has
  // to come FIRST or a browser that understands dvh never sees it.
  assert.match(decls(".app-shell"), /height:\s*100%[\s\S]*height:\s*100dvh/);
  assert.match(decls(".search-dropdown"), /max-height:\s*calc\(100vh[\s\S]*max-height:\s*calc\(100dvh/);
  assert.match(decls(".activity-panel"), /max-height:\s*70vh[\s\S]*max-height:\s*70dvh/);
});

test("no viewer breakpoint was added — Seam M2 derives and owns it", () => {
  // SCOPE §2: M2 replaces the rails and the top bar on narrow screens and owns the
  // threshold, which is dataset-dependent (it scales with the layout count), so a fixed
  // one hardened here would have to be unpicked. The only width queries in the app are
  // the library card grid's, which SCOPE §1d measured as already responsive.
  //
  // M2: when you add yours, extend this list — do not delete the pin.
  const widthQueries = [...css.matchAll(/@media[^{]*\((?:min|max)-width[^{]*?\)/g)].map((m) =>
    m[0].replace(/\s+/g, " ").trim(),
  );
  assert.deepEqual(widthQueries, ["@media (max-width: 1100px)", "@media (max-width: 700px)"]);
});
