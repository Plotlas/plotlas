// DOM tier — Seam R1: the shell's half of the recovery seam.
//
// What this tier CAN and CANNOT see, so every pin below is honest about which it is:
//
//  * jsdom has NO WebGL, so `createWorld` throws inside the mount effect and a healthy
//    boot is UNREACHABLE here. That is not only a limitation: it is exactly detection
//    point 1 (a browser with no WebGL 2), so the real component really does drive the
//    P1 shell pin — the failure it reaches is the failure under test.
//  * Everything the shell does AFTER a successful boot (the queued tap actually
//    applying) is therefore unreachable, and is pinned as the pure decision
//    `layoutTapIntent` plus a WIRING pin over the source — the same split
//    mobile_containment.dom.test.ts makes for the boot fit, because a pure pin cannot
//    notice its own call being deleted.
//  * jsdom applies no stylesheet, so "the blocked control is VISIBLE" is pinned as the
//    DECLARATION in app.css, the move mobile_containment.dom.test.ts already makes.
//
// `queryBy... === null` is compared as a BOOLEAN, never as a node: handing a live node
// to assert.equal makes util.inspect walk the tree, and a test that hangs at 90s is
// indistinguishable from one that passed.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViewerScreen, bootLayoutId, layoutTapIntent } from "../../src/ui/ViewerScreen.ts";
import { LayoutSwitcher } from "../../src/ui/LayoutSwitcher.ts";
import { ViewerMenu } from "../../src/ui/ViewerMenu.ts";
import { BLOCKED_CONTROL_CLASS } from "../../src/ui/blockedControl.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { LayoutInfo } from "../../src/api-client/types.ts";
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

const LAYOUTS: LayoutInfo[] = [
  { layout_id: "grid", label: "Grid", type: "grid" },
  { layout_id: "datetime", label: "By date", type: "datetime" },
];

function manifest(withTags: boolean): LayoutManifest {
  return {
    manifest_version: "2.5",
    dataset_id: "ds",
    dataset_version: 1,
    dataset_metadata: { image_count: 3 },
    column_roles: { columns: [] },
    layouts: LAYOUTS.map((l) => ({
      layout_id: l.layout_id,
      label: l.label,
      type: l.type,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      pyramid: {
        container: "pmtiles",
        path: `${l.layout_id}.pmtiles`,
        z_cap: 1,
        max_z: 2,
        tile_px: 256,
        thumb_px: 32,
        format: "webp",
      },
    })),
    tags: withTags ? { path: "tags/tags_v1.arrow", version: 1, count: 1 } : null,
  } as unknown as LayoutManifest;
}

/** A client that boots as far as the tag sidecar, then STOPS there until released. That
 *  await is the boot window P6 is about: the layout tabs are on screen and live, the
 *  renderer stack does not exist yet, and on a real collection the sidecar is megabytes. */
function stubClient(holdTags: boolean): { client: ApiClient; releaseTags: () => void } {
  let release: () => void = () => {};
  const tags = new Promise<never>((_resolve, reject) => {
    release = () => reject(new Error("no sidecar in this test"));
  });
  const client = {
    async listLayouts() {
      return LAYOUTS;
    },
    async getPresentation() {
      return {}; // no presentation record — today's behaviour (D-xvi)
    },
    async getManifest() {
      return manifest(holdTags);
    },
    async getDataset() {
      return { dataset_id: "ds", display_name: "DS" };
    },
    tagsUrl: () => "tags",
    async fetchTags() {
      return tags;
    },
    authHeaders: () => ({}),
    pyramidUrl: () => "p.pmtiles",
  } as unknown as ApiClient;
  return { client, releaseTags: () => release() };
}

function mount(client: ApiClient): void {
  render(
    h(ViewerScreen, {
      datasetId: "ds",
      client,
      onBack: () => {},
      onAuthExpired: () => {},
    }),
  );
}

/** aria-pressed of each layout tab, in order — the highlight, as the DOM reports it. */
function tabHighlight(): boolean[] {
  return [...document.querySelectorAll(".layout-tab")].map((t) => t.getAttribute("aria-pressed") === "true");
}

// --- P1 (shell half): a failure that never fires webglcontextlost is SHOWN -----

test("a browser with no WebGL 2 gets a named failure, not a canvas that never resolves", async () => {
  mount(stubClient(false).client);
  const panel = await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
  // NAMED: it says what is wrong with THIS browser, not "rendering was interrupted".
  assert.match(panel.textContent ?? "", /WebGL 2/);
  assert.equal(panel.getAttribute("role"), "alert");
});

// --- P5: a control that cannot work says why, on BOTH surfaces ----------------

test("a renderer failure blocks the desktop tab row, which says why and stays reachable", async () => {
  mount(stubClient(false).client);
  await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
  const tabs = [...document.querySelectorAll(".layout-tab")];
  assert.equal(tabs.length, LAYOUTS.length, "the tab row is gone — a blocked control must stay REACHABLE");
  for (const tab of tabs) {
    assert.equal(tab.getAttribute("aria-disabled"), "true", "a dead tab did not say it was disabled");
    // NOT the native attribute: a natively disabled button is unfocusable, carries no
    // ARIA state, and browsers suppress its title — the explanation disappears exactly
    // when it is needed.
    assert.equal((tab as HTMLButtonElement).disabled, false, "native disabled makes the reason unreachable");
    // Seam R2 P1 reworded this reason to name the STATE rather than the control: it is now
    // attached to the ⤢ Fit button and the minimap too, neither of which switches
    // anything. The assertion's intent is unchanged — the blocked tab still carries the
    // reason on the control itself.
    assert.match(tab.getAttribute("title") ?? "", /viewer controls are unavailable/i);
    assert.equal(tab.classList.contains(BLOCKED_CONTROL_CLASS), true, "no blocked class ⇒ nothing to style");
  }
});

/** A ResizeObserver the test can fire, so the shell's narrow-mode measurement can be
 *  driven in jsdom (which implements none). The narrow_layout suite uses the same shape;
 *  this is a local copy, not an import of another test's internals. */
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

test("the ☰ — the ONLY switcher below ~855px — is blocked by a renderer failure too", async () => {
  // R1-11(a): the ☰'s `blockedReason` was wired but never pinned through the shell, and
  // it is the surface where being wrong costs the most: on a phone there is no tab row to
  // fall back to. The component pin below covers the presentation; this one covers that
  // ViewerScreen actually HANDS it the reason in the mode where it matters.
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = DrivableResizeObserver;
  try {
    mount(stubClient(false).client);
    await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
    const holder = document.querySelector(".canvas-holder") as HTMLElement;
    Object.defineProperty(holder, "clientWidth", { value: 390, configurable: true });
    act(() => {
      DrivableResizeObserver.last?.fire();
    });
    assert.equal(
      document.querySelector(".viewer-screen.cockpit-narrow") !== null,
      true,
      "the holder measured 390px and the cockpit did not go narrow",
    );
    // Open the ☰ and read its layout rows.
    fireEvent.click(screen.getByRole("button", { name: /Views, filters and search/ }));
    const rows = [...document.querySelectorAll(".viewer-menu-layout")];
    assert.equal(rows.length, LAYOUTS.length, "the ☰ lists no layouts to block");
    for (const row of rows) {
      assert.equal(row.getAttribute("aria-disabled"), "true", "a dead ☰ row did not say it was disabled");
      assert.equal((row as HTMLButtonElement).disabled, false, "native disabled removes the row from the menu");
      // Seam R2 P1 reworded this reason — see the desktop pin above. Intent unchanged.
      assert.match(row.getAttribute("title") ?? "", /viewer controls are unavailable/i);
      assert.equal(row.classList.contains(BLOCKED_CONTROL_CLASS), true);
    }
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  }
});

test("both switching surfaces show the SAME reason, from one helper", () => {
  const reason = "Reconnecting to the graphics context — switching views is unavailable.";
  let switches = 0;
  const r = render(
    h(
      "div",
      null,
      h(LayoutSwitcher, {
        layouts: LAYOUTS,
        activeLayoutId: "grid",
        onSwitch: () => {
          switches += 1;
        },
        blockedReason: reason,
      }),
      h(ViewerMenu, {
        layouts: LAYOUTS,
        activeLayoutId: "grid",
        onSwitch: () => {
          switches += 1;
        },
        open: true,
        setOpen: () => {},
        blockedReason: reason,
      }),
    ),
  );
  const container = r.container as HTMLElement;
  const tab = container.querySelector(".layout-tab:not(.layout-tab-active)") as HTMLButtonElement;
  const row = container.querySelector('.viewer-menu-layout:not([aria-checked="true"])') as HTMLButtonElement;
  // Below ~855px the ☰ is the ONLY switcher, so a fix applied to the tab row alone
  // leaves the dead control live on every phone.
  for (const control of [tab, row]) {
    assert.equal(control.getAttribute("aria-disabled"), "true");
    assert.equal(control.disabled, false);
    assert.equal(control.classList.contains(BLOCKED_CONTROL_CLASS), true);
    assert.equal((control.getAttribute("title") ?? "").includes(reason), true, "the reason is not on this surface");
  }
  fireEvent.click(tab);
  fireEvent.click(row);
  assert.equal(switches, 0, "aria-disabled does not stop a click — the handler must");
});

// Comments are stripped first: a `/* ... */` above a rule otherwise lands INSIDE the
// selector capture below, and its own commas split it into fragments that match nothing —
// a parser that silently sees no rule where a rule exists is worse than none. It is also
// what stops `includes(".some-class")` passing on a comment that merely names the class
// (review R1-11(c)).
const APP_CSS = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  " ",
);

/** Every declaration block whose selector list mentions `selector` exactly. */
function cssRulesFor(selector: string): string[] {
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(APP_CSS)) !== null) {
    if (m[1].split(",").some((s) => s.trim() === selector)) out.push(m[2].trim());
  }
  return out;
}

test("the blocked class resolves to a real rule in app.css, hover included", () => {
  const rulesFor = cssRulesFor;
  // #279 shipped the class with NO rule behind it, so a blocked row was pixel-identical
  // to a live one. Both surfaces, and both must actually declare something.
  for (const base of [".layout-tab", ".viewer-menu-layout"]) {
    const resting = rulesFor(`${base}.${BLOCKED_CONTROL_CLASS}`);
    assert.equal(resting.length > 0, true, `app.css declares no rule for ${base}.${BLOCKED_CONTROL_CLASS}`);
    assert.match(resting.join(" "), /opacity/, `${base} blocked state is not visually distinct`);
    // ...and it must not still light up under the cursor: the shipped hover rules are
    // `:hover:not(:disabled)`, which an aria-disabled control still matches.
    const hover = rulesFor(`${base}.${BLOCKED_CONTROL_CLASS}:hover`);
    assert.equal(hover.length > 0, true, `${base} still hover-highlights while blocked`);
  }
});

test("the recovery panel's own surface is styled", () => {
  // R1-11(c): this asserted `css.includes(".renderer-recovery-panel")`, which a COMMENT
  // mentioning the class satisfies — the same blindness the blocked-class pin above was
  // fixed for. It now parses rules and requires real declarations.
  for (const cls of [".renderer-recovery-panel", ".renderer-recovery-status"]) {
    const rules = cssRulesFor(cls);
    assert.equal(rules.length > 0, true, `app.css declares no rule for ${cls}`);
    assert.equal(rules.join(" ").trim().length > 0, true, `${cls} has a rule with no declarations`);
  }
  // The panel floats over the canvas, so it needs a position of its own — without one it
  // lands in normal flow at the bottom of the shell, off-screen under the rails.
  assert.match(cssRulesFor(".renderer-recovery-panel").join(" "), /position:\s*absolute/);
});

// --- P6: the highlight never names a layout the canvas is not showing ---------

test("a tap during boot is QUEUED, then adopted by the boot itself", async () => {
  // Review R1-11(b): the previous shape of this pin could not tell "queue" from `main`'s
  // "drop" — the stack is null at tap time either way, so the DOM was identical and
  // deleting `pendingSwitchRef.current = layoutId` left the whole gate green. The queue is
  // observable now because the BOOT consumes it: the tap changes which layout boot brings
  // up, which is also what removes R1-12's discarded activation.
  const { client, releaseTags } = stubClient(true);
  mount(client);
  // The tabs exist and are LIVE while the tag sidecar is still in flight: this is an
  // ordinary healthy boot as far as the user can tell, and refusing the control here
  // would be worse than the rare wait.
  await waitFor(() => assert.equal(document.querySelectorAll(".layout-tab").length, LAYOUTS.length));
  const tabs = [...document.querySelectorAll(".layout-tab")] as HTMLButtonElement[];
  assert.deepEqual(tabHighlight(), [true, false], "boot did not start on the first layout");
  assert.equal(tabs[1].getAttribute("aria-disabled"), null, "the tabs were blocked during an ordinary boot");

  fireEvent.click(tabs[1]);
  // Held, NOT applied: the highlight must not move before the switch does. Moving it here
  // is what #279 did, and boot's own setActiveLayoutId then overwrote it.
  assert.deepEqual(tabHighlight(), [true, false], "the highlight moved before the switch applied");

  releaseTags();
  // Boot resumes, adopts the queued layout as the one it brings up, and the highlight
  // follows THAT — one activation, of the layout the user actually asked for.
  await waitFor(() => assert.deepEqual(tabHighlight(), [false, true]));
});

test("a boot that dies before the renderer exists cannot leave health hung at `starting`", async () => {
  // R1-03 (BLOCKER). `starting` renders both switching surfaces fully live and
  // un-annotated while every tap is queued into a ref, and several boot exits published no
  // transition at all — so a transient 503 behind "Retry renderer" left a viewer whose
  // tabs swallowed every click, with no panel and no way out but a browser reload.
  const client = {
    async listLayouts() {
      return LAYOUTS;
    },
    async getPresentation() {
      return {}; // no presentation record — today's behaviour (D-xvi)
    },
    async getManifest() {
      throw Object.assign(new Error("Service Unavailable"), { status: 503 });
    },
    async getDataset() {
      return { dataset_id: "ds", display_name: "DS" };
    },
    authHeaders: () => ({}),
  } as unknown as ApiClient;
  mount(client);

  const panel = await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
  // ...and it offers the action that can actually help a transient API failure: rebuilding
  // re-runs the whole boot chain.
  assert.equal(screen.queryByRole("button", { name: "Retry renderer" }) !== null, true);
  assert.match(panel.textContent ?? "", /Service Unavailable/);
  // ONE surface, not two: the banner would otherwise say the same thing beside it.
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1, "the banner and the panel both fired");
});

test("layoutTapIntent: queue during boot, apply when ready, refuse when the renderer cannot serve it", () => {
  // The half jsdom cannot reach — a healthy boot completing — pinned as the decision the
  // shell makes, with the wiring pinned separately below.
  assert.equal(layoutTapIntent({ kind: "starting" }, false), "queue");
  // R1-12: once the stack EXISTS, a tap applies. Queueing it there meant boot ran a whole
  // layout activation — every visible tile fetched, decoded and uploaded, plus an
  // un-abortable position table (~16 MB at 1M) — and the drain then threw all of it away.
  assert.equal(layoutTapIntent({ kind: "starting" }, true), "apply", "a post-stack tap was queued and discarded");
  // R1-03: and a boot that died refuses rather than swallowing taps into a ref forever.
  assert.equal(
    layoutTapIntent({ kind: "failed", failure: { code: "boot-failed", layoutId: null, detail: null } }, false),
    "refuse",
  );
  assert.equal(layoutTapIntent({ kind: "ready" }, true), "apply");
  assert.equal(layoutTapIntent({ kind: "ready" }, false), "refuse", "no stack to switch");
  assert.equal(layoutTapIntent({ kind: "context-lost" }, true), "refuse", "switching a lost context is destructive");
  assert.equal(
    layoutTapIntent({ kind: "failed", failure: { code: "render-loop-failed", layoutId: null, detail: null } }, true),
    "refuse",
  );
  // A layout-scoped failure keeps its stack, and switching away IS the escape route.
  assert.equal(
    layoutTapIntent(
      { kind: "failed", failure: { code: "layout-assets-failed", layoutId: "grid", detail: null } },
      true,
    ),
    "apply",
  );
});

// --- R1-02/R1-10: what "Retry renderer" preserves ------------------------------

test("a rebuild comes back on the layout the user was on, a fresh mount on the first", () => {
  // "Retry renderer" re-runs the mount effect, which used to boot layouts[0] — so
  // recovering from a render-loop failure silently moved the user to a different view.
  assert.equal(bootLayoutId(LAYOUTS, null), "grid", "a fresh mount opens the first layout");
  assert.equal(bootLayoutId(LAYOUTS, "datetime"), "datetime", "a rebuild discarded the active layout");
  // A collection re-baked without that layout falls back rather than activating a
  // layout the manifest no longer declares.
  assert.equal(bootLayoutId(LAYOUTS, "gone"), "grid");
  assert.equal(bootLayoutId([], "grid"), null);
});

// --- D-iv: the declared default opens the collection, and never yanks a rebuild ---

test("a fresh mount opens the DECLARED default layout", () => {
  // The showcase half of Phase 2: an anonymous visitor lands on the layout that shows the
  // collection best, not on whatever the bake emitted first.
  assert.equal(bootLayoutId(LAYOUTS, null, "datetime"), "datetime");
});

test("a REBUILD still returns the user's layout even when a DIFFERENT default is declared", () => {
  // The review finding (R1-02) that bootLayoutId exists to hold, now under pressure from
  // D-iv. "Retry renderer" tears the whole stack down; coming back on the collection's
  // declared default rather than the layout on screen is the same silent move R1-02
  // fixed, one indirection further away. Precedence: active BEFORE default, always.
  assert.equal(bootLayoutId(LAYOUTS, "grid", "datetime"), "grid");
});

test("a default_layout naming nothing falls back silently to the first (D-xvi)", () => {
  // The record is keyed by ids the OTHER file owns, so a re-bake that drops a layout
  // leaves a dangling default. Operator: "if it disappears it should fallback to the
  // default (e.g. first layout)." Never an error, never a throw.
  assert.equal(bootLayoutId(LAYOUTS, null, "no_such_layout"), "grid");
  assert.equal(bootLayoutId(LAYOUTS, null, null), "grid");
  assert.equal(bootLayoutId(LAYOUTS, null, undefined), "grid");
  assert.equal(bootLayoutId([], null, "datetime"), null, "no layouts is still fatal-null");
});

test("the shell actually passes default_layout to bootLayoutId", () => {
  // A pure pin cannot notice its own argument being dropped at the call site, and a
  // dropped third argument is silently "no default declared" — the exact shape of a
  // feature that tests green and does nothing in the app (#251).
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const calls = src.split("bootLayoutId(layoutInfos, activeLayoutId, record.dataset?.default_layout)").length - 1;
  assert.equal(calls, 1, "ViewerScreen must call bootLayoutId with the record's default_layout");
});


test("the shell actually routes its layout taps through layoutTapIntent", () => {
  // A pure pin cannot notice its own call being deleted, and deleting it is exactly how
  // the optimistic highlight comes back (mobile_containment.dom.test.ts, same move).
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const calls = src.split("layoutTapIntent(").length - 1;
  assert.equal(calls >= 2, true, "handleSwitch no longer asks layoutTapIntent what a tap should do");
});

test("both layout-activation paths publish a layout-scoped failure", () => {
  // P1's third source — a layout whose tiles cannot be made renderable — is published
  // from the boot activation and from a switch. NEITHER is reachable in this tier: jsdom
  // has no WebGL, so createWorld throws before the boot activation runs, and a switch is
  // refused for want of a stack. A source pin is therefore the ONLY coverage this repo's
  // free tiers can give the wiring, and it is deliberately labelled as that: it proves
  // the call sites exist, not that they behave.
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const calls = src.split("layoutFailureFrom(").length - 1;
  assert.equal(calls, 2, `expected the boot + switch catches to publish a layout failure, found ${calls}`);

  // ...and the shell never decides for itself WHICH failure it may clear. Both clear
  // sites ask `failureResolvedBySwitch`; a bare `kind === "failed"` here is the defect
  // review caught — a successful switch erasing a halted render loop. The behaviour is
  // pinned in the node tier (renderer_health.test.ts); this only stops the shell growing
  // a second, weaker copy of the predicate. Deliberately a source assertion, not
  // behavioural coverage: the switch path needs a stack, which jsdom cannot build.
  // Comments stripped first — the same lesson the CSS pin above learned: a text
  // assertion must read CODE, not prose. The docblock at the clear site quotes the very
  // comparison it exists to warn against, and matching that would make this pin fire on
  // its own explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.equal(
    code.includes('kind === "failed"'),
    false,
    "ViewerScreen compares the health kind itself instead of asking renderer/health.ts",
  );

  // R1-13: every health-dependent decision reads the LIVE handle, never the React render
  // mirror. A click already queued in the task queue is dispatched before React commits a
  // transition published from a native listener or a setTimeout, so the mirror can say
  // `ready` while the context is already lost. Source-level because the window is
  // sub-frame and jsdom cannot build a stack to switch.
  assert.equal(
    code.includes("layoutTapIntent(rendererHealth"),
    false,
    "handleSwitch decides from the render mirror; the live snapshot is what the other two sites read",
  );

  // R1-16: a 404 from the boot ACTIVATE must still reach the deep-link hand-back. The
  // local catch this PR added intercepts the rejection before the outer catch's 404
  // branch can see it. Unreachable in jsdom (createWorld throws first), so this asserts
  // the branch exists rather than that it fires.
  assert.equal(
    code.includes("props.onUnavailable"),
    true,
    "the deep-link hand-back is gone entirely",
  );
  const activateCatch = code.slice(code.indexOf("await controller.activate("), code.indexOf("world.start()"));
  assert.equal(
    activateCatch.includes("onUnavailable"),
    true,
    "a 404 from the boot activate no longer reaches onUnavailable — the visitor is stranded on a dead retry",
  );

  // R1-20: an epoch rebuild revokes every preview object URL. The `preview` state is not
  // the effect's, so it must be reset with them or an in-flight <img src> is revoked
  // mid-load and stays broken. Unreachable in jsdom (no way to trigger a rebuild).
  // Scoped to the MOUNT EFFECT's own prologue, not to the file: `resolvePreview` has its
  // own `setPreview(null)`, so a file-wide `includes` passed with this reset deleted —
  // caught by running the mutation, and the same weakness R1-11(b) flagged in the
  // `calls >= 2` count above.
  const effectPrologue = code.slice(
    code.indexOf("health.markStarting();"),
    code.indexOf("let cancelled = false;"),
  );
  assert.equal(effectPrologue.length > 0, true, "the mount effect's prologue moved — re-anchor this pin");
  assert.equal(
    effectPrologue.includes("setPreview(null)"),
    true,
    "the rebuild revokes preview object URLs but leaves the preview state pointing at them",
  );
});

test("the shell subscribes to the loader's view failures, and its retry re-streams them", () => {
  // R1-05. A tile-asset failure was completely invisible: on a healthy boot the switch
  // path awaits no network (the controller holds the manifest), tiles load
  // fire-and-forget, and the retry ladder's cap published nothing — so stopping the API
  // and switching layouts gave an empty viewer with healthy-looking chrome and no error.
  // The loader now reports a whole-view failure; these two lines are what turn it into
  // the panel and what makes the panel's button do something.
  //
  // Source pins, deliberately: the loader only exists after a successful `createWorld`,
  // which jsdom cannot reach. The BEHAVIOUR they stand for is pinned GL-free in
  // tests/tile_pyramid_loader.test.ts ("a view whose EVERY tile fails terminally…").
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.equal(
    code.split("setViewFailureListener(").length - 1,
    1,
    "the shell never subscribes to the loader's view failures — a dead view stays silent",
  );

  // ...and the retry has to RE-STREAM, not just switch: `switchTo` no-ops against the
  // layout it is already on (layout.ts), so a "Retry this view" for the view that is
  // already active would clear the panel and re-fetch nothing — the user's one offered
  // action would do exactly nothing. Scoped to retryView's own body, not the file: a
  // file-wide `includes` would pass with the call deleted from the one place it matters.
  const retryViewBody = code.slice(code.indexOf("function retryView()"), code.indexOf("function retryRenderer()"));
  assert.equal(retryViewBody.length > 0, true, "retryView moved — re-anchor this pin");
  assert.equal(
    retryViewBody.includes("restreamView()"),
    true,
    "Retry this view cannot recover a view whose layout is already active",
  );
});
