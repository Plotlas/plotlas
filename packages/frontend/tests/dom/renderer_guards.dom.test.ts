// DOM tier — Seam R2 P1 (a control that reaches the stack refuses when the stack cannot
// serve it) and P3's surface (the status bar says when images stop loading).
//
// What this tier CAN and CANNOT see, so every pin is honest about which it is:
//
//  * jsdom has NO WebGL, so `createWorld` throws inside the mount effect and
//    `stackRef.current` stays null. Every guarded handler therefore returns at its
//    existing `stack === null` check before the new guard is reached — so "the guarded
//    call was refused" is pinned as the DECISION (`whenStackUsable`, on a call COUNT)
//    plus a WIRING pin over the source, the split renderer_recovery.dom.test.ts and
//    mobile_containment.dom.test.ts already make for the same reason.
//  * jsdom applies no stylesheet, so "a blocked control is VISIBLE" is pinned as the
//    DECLARATION in app.css — but keyed off the classes the REAL component tree renders,
//    not off a hard-coded list, so blocking a new control without styling it fails here.
//
// `queryBy... === null` is compared as a BOOLEAN, never as a node: handing a live node to
// assert.equal makes util.inspect walk the tree, and a test that hangs at 90s is
// indistinguishable from one that passed.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViewerScreen, sameTagSelection, whenStackUsable } from "../../src/ui/ViewerScreen.ts";
import { StatusBar } from "../../src/ui/StatusBar.ts";
import type { ViewerStatus } from "../../src/ui/StatusBar.ts";
import { TagControls, TagTableContext } from "../../src/ui/TagControls.ts";
import { SearchResults } from "../../src/ui/SearchResults.ts";
import { BLOCKED_CONTROL_CLASS } from "../../src/ui/blockedControl.ts";
import type { RendererHealth } from "../../src/renderer/health.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { LayoutInfo } from "../../src/api-client/types.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";

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

function manifest(): LayoutManifest {
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
    tags: null,
  } as unknown as LayoutManifest;
}

function stubClient(): ApiClient {
  return {
    async listLayouts() {
      return LAYOUTS;
    },
    async getPresentation() {
      return {}; // no presentation record — today's behaviour (D-xvi)
    },
    async getManifest() {
      return manifest();
    },
    async getDataset() {
      return { dataset_id: "ds", display_name: "DS" };
    },
    authHeaders: () => ({}),
    pyramidUrl: () => "p.pmtiles",
  } as unknown as ApiClient;
}

function mount(): void {
  render(
    h(ViewerScreen, {
      datasetId: "ds",
      client: stubClient(),
      onBack: () => {},
      onAuthExpired: () => {},
    }),
  );
}

/** A ResizeObserver the test can fire, so the shell's narrow-mode measurement can be
 *  driven in jsdom (which implements none). A local copy, not an import of another
 *  test's internals. */
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

// --- P1 (a): the guarded call is REFUSED, counted ------------------------------

test("whenStackUsable runs the stack call only while the renderer can serve it", () => {
  const failed = (code: "render-loop-failed" | "layout-assets-failed"): RendererHealth => ({
    kind: "failed",
    failure: { code, layoutId: null, detail: null },
  });
  let calls = 0;
  const bump = (): number => ++calls;

  // Blocked: a dead stack and a lost context. `aria-disabled` does NOT stop a click, so
  // the refusal has to happen HERE or the control looks blocked and still fires.
  whenStackUsable(failed("render-loop-failed"), bump);
  whenStackUsable({ kind: "context-lost" }, bump);
  assert.equal(calls, 0, "a control reached the stack while the renderer could not serve it");

  // Live: healthy, booting (a tap is queued, never refused, for an ordinary boot), and a
  // LAYOUT-scoped failure, which keeps its stack — blocking there would trap the user on
  // the one view that does not work.
  whenStackUsable({ kind: "ready" }, bump);
  whenStackUsable({ kind: "starting" }, bump);
  whenStackUsable(failed("layout-assets-failed"), bump);
  assert.equal(calls, 3, "a healthy renderer refused a control");

  // It hands back what the action returned, so a caller that needs the outcome (the
  // Lightbox's "Locate on canvas" only pulses when the centre actually happened) does
  // not need a second copy of the decision.
  assert.equal(whenStackUsable({ kind: "ready" }, () => true), true);
  assert.equal(whenStackUsable(failed("render-loop-failed"), () => true), false);
});

// --- P1 (b): every control blocked resolves to a REAL css rule ------------------

// Comments are stripped first: a `/* … */` above a rule otherwise lands inside the
// selector capture below and its commas split it into fragments that match nothing.
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

/** The classes the blocked elements currently in the document are marked with, paired
 *  with the element that carries them. DERIVED from the rendered tree — this is the
 *  whole point: the shipped pin iterates a hard-coded two-element array, so a newly
 *  blocked control with no styling is invisible to it. */
function blockedClassSets(): string[][] {
  return [...document.querySelectorAll(`.${BLOCKED_CONTROL_CLASS}`)].map((el) =>
    [...el.classList].filter((c) => c !== BLOCKED_CONTROL_CLASS),
  );
}

/** Does app.css ship a `:hover` rule for `cls` that a BLOCKED control would still match?
 *  A selector like `.mode-btn:hover:not(:disabled)` does — `aria-disabled` is not
 *  `:disabled` — unless it also excludes `.is-blocked`. */
function hoversWithoutExcludingBlocked(cls: string): boolean {
  const rule = /([^{}]+)\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(APP_CSS)) !== null) {
    for (const sel of m[1].split(",")) {
      const s = sel.trim();
      if (!s.startsWith(`.${cls}:hover`) && !s.startsWith(`.${cls}.`)) continue;
      if (!s.includes(":hover")) continue;
      if (s.includes(BLOCKED_CONTROL_CLASS)) continue; // excluded, or a counter-rule
      return true;
    }
  }
  return false;
}

/** Assert one blocked element resolves to a rule keyed on one of ITS OWN classes. */
function assertStyledBlocked(classes: string[]): void {
  const resting = classes.filter((c) => {
    const rules = cssRulesFor(`.${c}.${BLOCKED_CONTROL_CLASS}`);
    return rules.length > 0 && /opacity/.test(rules.join(" "));
  });
  assert.equal(
    resting.length > 0,
    true,
    `no app.css rule makes a blocked .${classes.join(".")} look any different from a live one`,
  );
  // ...and it must not still light up under the cursor. The shipped hover rules are
  // `:hover:not(:disabled)`, which an aria-disabled control still matches — so EITHER the
  // shipped rule excludes the blocked class, OR a counter-rule overrides it. This asserts
  // the PROPERTY over both mechanisms: pinning only the counter-rule is what kept three
  // provable no-ops alive purely to satisfy a text-existence check.
  // `some`, not `every`: an element carries several classes and only the one its hover
  // treatment is keyed on matters. Deciding which needs real specificity resolution, which
  // is more CSS engine than a pin should contain — this keeps the shipped pin's strength
  // and adds the second mechanism.
  const quiet = classes.some(
    (c) => cssRulesFor(`.${c}.${BLOCKED_CONTROL_CLASS}:hover`).length > 0 || !hoversWithoutExcludingBlocked(c),
  );
  assert.equal(quiet, true, `a blocked .${classes.join(".")} still hover-highlights`);
}

test("every control the WIDE shell blocks is styled as blocked", async () => {
  mount();
  await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
  const sets = blockedClassSets();
  // The two layout tabs, the ⤢ Fit button and the minimap: four, not two. A count, so
  // that dropping a control's blocked treatment fails here rather than passing vacuously.
  assert.equal(sets.length >= 4, true, `only ${sets.length} controls were blocked on a dead renderer`);
  for (const classes of sets) assertStyledBlocked(classes);
});

test("every control the NARROW shell blocks is styled as blocked", async () => {
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = DrivableResizeObserver;
  try {
    mount();
    await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
    const holder = document.querySelector(".canvas-holder") as HTMLElement;
    Object.defineProperty(holder, "clientWidth", { value: 390, configurable: true });
    act(() => {
      DrivableResizeObserver.last?.fire();
    });
    fireEvent.click(screen.getByRole("button", { name: /Views, filters and search/ }));
    const sets = blockedClassSets();
    assert.equal(
      sets.some((s) => s.includes("viewer-menu-layout")),
      true,
      "the ☰ rows — the ONLY switcher below ~855px — were not collected",
    );
    for (const classes of sets) assertStyledBlocked(classes);
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  }
});

test("the ⤢ Fit button says why it cannot fit, and stays reachable", async () => {
  mount();
  await waitFor(() => screen.getByTestId("renderer-recovery-panel"));
  const fit = document.querySelector(".fit-view-btn") as HTMLButtonElement;
  assert.equal(fit !== null, true, "the fit control vanished — a blocked control must stay REACHABLE");
  assert.equal(fit.getAttribute("aria-disabled"), "true");
  assert.equal(fit.disabled, false, "native disabled makes the reason unreachable");
  // The reason names the STATE, not the control: `health.ts` hard-coded "switching views
  // is unavailable", which is a lie on a Fit button and on the minimap.
  const title = fit.getAttribute("title") ?? "";
  assert.equal(title.includes("Fit view"), true, "the control's own tooltip was thrown away");
  assert.equal(/switching views/i.test(title), false, "the Fit button says switching views is unavailable");
  assert.match(title, /unavailable/i, "a blocked control that cannot say why is the defect P5 exists to prevent");
});

// --- P3's surface: the status bar --------------------------------------------

function status(tilesFailing: boolean): ViewerStatus {
  return {
    layoutId: "grid",
    zoom: 1,
    inView: 10,
    loadingTiles: 2,
    tags: { status: "none", selected: 0, matched: 0, total: 3 },
    selectedCell: null,
    cursor: null,
    fps: 60,
    tilesFailing,
  };
}

test("the status bar says when images stop loading, and says nothing when they are", () => {
  const failing = render(h(StatusBar, { status: status(true) }));
  const bar = failing.container.querySelector(".status-bar") as HTMLElement;
  assert.equal(bar.getAttribute("role"), "status", "the read-out is not in a live region");
  const shown = failing.container.querySelector(".status-tiles-failing");
  assert.equal(shown !== null, true, "every tile was 502ing and the status bar said nothing");
  assert.match(shown?.textContent ?? "", /not loading/i);
  cleanup();

  const healthy = render(h(StatusBar, { status: status(false) }));
  assert.equal(
    healthy.container.querySelector(".status-tiles-failing") === null,
    true,
    "a healthy viewer claimed its images were not loading",
  );
});

test("the images-not-loading read-out is styled", () => {
  const rules = cssRulesFor(".status-tiles-failing");
  assert.equal(rules.length > 0, true, "app.css declares no rule for .status-tiles-failing");
  assert.equal(rules.join(" ").trim().length > 0, true, "the rule has no declarations");
});

// --- wiring: the source pins the free tiers cannot replace --------------------

const SRC = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ");

/** The body of one shell function, so a file-wide `includes` cannot pass with the call
 *  deleted from the one place it matters (the R1-20 lesson). */
function slice(from: string, to: string): string {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a + from.length);
  assert.equal(a >= 0 && b > a, true, `re-anchor this pin: ${from} … ${to}`);
  return SRC.slice(a, b);
}

test("every stack-reaching control routes through the guard, reading LIVE health", () => {
  // Unreachable behaviourally: jsdom cannot build a stack, so each handler returns at its
  // `stack === null` check before the guard runs. This proves the call sites exist, not
  // that they behave — the behaviour is pinned on `whenStackUsable` above.
  // [handler, next anchor, how many guarded calls it holds]. `jumpToRow` holds TWO
  // because it mixes three kinds of work: the ☰ dismiss and the row's selection must
  // survive a dead renderer, and only the camera moves are refused.
  const guarded: [string, string, number][] = [
    ["function handleMinimapJump(", "function fitToLayout(", 1],
    // Review A6: the guard belongs to the BUTTON, not to `fitToLayout` — that function's
    // other caller is `maybeAutoFit`, which is automatic, has no surface to explain a
    // refusal, and whose bounded retry re-arms only for `inView === null`.
    ["function fitToLayout(", "function handleFitView(", 0],
    ["function handleFitView(", "function resetSummary(", 1],
    ["function handleTagChange(", "function handleRetryTags(", 1],
    ["function handleRetryTags(", "function runSearch(", 1],
    ["function jumpToRow(", "const searchDropdownOpen", 2],
    ["onLocate:", "h(StatusBar", 1],
    // Review A10: the recovery effect reaches `controller.applyTags` and was gated only on
    // the React render mirror, which can read `ready` while live health is already
    // `context-lost` again.
    ['prev !== "context-lost"', "}, [rendererHealth]);", 1],
  ];
  let total = 0;
  for (const [from, to, count] of guarded) {
    const found = slice(from, to).split("whenStackUsable(").length - 1;
    assert.equal(
      found,
      count,
      `${from.trim()}: expected ${count} guarded stack call(s), found ${found}`,
    );
    total += count;
  }
  // The exported definition reads `whenStackUsable<T>(`, so it is NOT in this count —
  // every match is a call site.
  assert.equal(
    SRC.split("whenStackUsable(").length - 1,
    total,
    "a stack call was guarded (or unguarded) outside the enumerated set — update the PR description too",
  );

  // R2 directive 7 / R1-13: a decision that GATES a stack call reads the live handle.
  // `rendererControls` is a render-time mirror, and a click already in the task queue is
  // dispatched against a stale `ready`.
  assert.equal(
    SRC.includes("whenStackUsable(rendererHealth"),
    false,
    "a guard decides from the React render mirror instead of the live health snapshot",
  );

  // handleCanvasClick is deliberately NOT guarded: cell inspection is served by the API,
  // not the renderer, and it is the one signal that still works on a dead canvas.
  assert.equal(
    slice("function handleCanvasClick(", "function handleSwitch(").includes("whenStackUsable("),
    false,
    "cell inspection was blocked — it does not need the renderer and is the last signal left",
  );
});

test("the two shell-owned scheduled sites are guarded, each with its own code", () => {
  // P2 sites 3 and 4. Created inside the mount effect, after createWorld — so they are
  // unreachable in jsdom, and the guard's behaviour is pinned in the node tier
  // (tests/renderer_guard_scheduled.test.ts). This pins the wiring and the CODE, which
  // is the half that decides whether a dead frame counter blocks every control.
  // Site 3 is guarded in `viewerStatus.ts`, at the emit — a guard on `frameTick` was code
  // that could never fire, because everything fallible runs in `emit()` on a separate
  // scheduled callback. Its behaviour is pinned in the node tier; this asserts the shell
  // does not grow a second, ineffective copy of it around the tick.
  const fps = slice("const tick = ", "const pollOverview");
  assert.equal(fps.includes("guardScheduledWork("), false, "the shell re-guarded the tick, which cannot throw");
  assert.equal(fps.includes("requestAnimationFrame(tick)"), true, "the fps chain no longer re-arms");

  const poll = slice("const pollOverview", "})().catch(");
  assert.equal(poll.includes("guardScheduledWork("), true, "the 750ms overview poll is unguarded");
  assert.equal(poll.includes('"overview-poll-failed"'), true, "the overview poll publishes the wrong code");
  assert.equal(poll.includes("setInterval("), true, "the overview poll is not scheduled at all");
  // Clearing the interval on a latch left a failed boot with a permanently dead minimap
  // and no way to restart it, because `fail()` had already dropped the only report of it.
  assert.equal(poll.includes("clearInterval("), false, "a latched poll clears the interval its recovery needs");

  // Review A2: ALL THREE `refreshOverview` call sites go through the guard, and the
  // recovery hooks are published BEFORE the first paint — an unguarded first paint threw
  // into the boot chain's catch, was escalated to `boot-failed` over a live canvas, and
  // aborted before the assignment, leaving both hooks permanently null.
  assert.equal(
    SRC.split("refreshOverview(").length - 1,
    2,
    "a `refreshOverview` call escaped the guard — the declaration and the guard's own work are the only two",
  );
  assert.equal(
    poll.indexOf("resumeScheduledRef.current =") < poll.indexOf("pollOverview();"),
    true,
    "the recovery hooks are published after the first paint that can abort the boot",
  );
});

// --- C2: the controls that are refused SAY they are refused ------------------

test("the tag rail says why it cannot filter, and refuses the change", () => {
  // Every control in the rail routes through `onChange`/`onRetryTags`, both of which the
  // shell refuses while the stack cannot serve them. Without a marking the chips and the
  // mode buttons toggle, the canvas does not move, and nothing says why — the inverse of
  // the rule blockedControl.ts states in its own header.
  const reason = "The viewer's graphics stopped — viewer controls are unavailable until it recovers.";
  let changes = 0;
  let retries = 0;
  // A minimal stand-in for the D-14 sidecar Table: TagControls reads only `getChild` and
  // `numRows` from it, and the subject here is the blocked treatment, not chip
  // derivation — but it has to be non-null, or the component returns its
  // "tag values unavailable" note before rendering a single control.
  const table = { getChild: () => null, numRows: 0 } as never;
  const r = render(
    h(
      TagTableContext.Provider,
      { value: table },
      h(TagControls, {
        roles: { tag: [{ column: "artist", label: "Artist" }] } as never,
        selection: { selected: [{ column: "artist", value: "Rembrandt" }], mode: "or" } as never,
        onChange: () => {
          changes += 1;
        },
        rendererTagsFailed: true,
        onRetryTags: () => {
          retries += 1;
        },
        blockedReason: reason,
      }),
    ),
  );
  // EVERY button in the rail, not "at least one": the retry affordance takes its blocked
  // treatment from its own `blockedControl` call, so a pin that only counted marked
  // controls passed with the mode buttons and chips left live — caught by mutation.
  const buttons = [...r.container.querySelectorAll("button")] as HTMLButtonElement[];
  const controls = [...r.container.querySelectorAll(`.${BLOCKED_CONTROL_CLASS}`)] as HTMLButtonElement[];
  assert.equal(buttons.length > 1, true, "re-anchor this pin: the rail renders no controls to block");
  assert.equal(
    controls.length,
    buttons.length,
    `${buttons.length - controls.length} control(s) in a blocked rail are unmarked: ` +
      buttons.filter((b) => !b.classList.contains(BLOCKED_CONTROL_CLASS)).map((b) => b.className).join(", "),
  );
  assert.equal(
    controls.some((c) => c.classList.contains("mode-btn")),
    true,
    "the combine-mode buttons drive the same refused handler and were left live",
  );
  for (const c of controls) {
    assert.equal(c.getAttribute("aria-disabled"), "true");
    assert.equal(c.disabled, false, "native disabled makes the reason unreachable");
    assert.equal((c.getAttribute("title") ?? "").includes(reason), true, "the reason is not on this control");
    fireEvent.click(c);
  }
  assert.equal(changes, 0, "aria-disabled does not stop a click — the handler must");
  assert.equal(retries, 0, "the tag retry fired on a renderer that cannot serve it");
  for (const el of [...r.container.querySelectorAll(`.${BLOCKED_CONTROL_CLASS}`)]) {
    assertStyledBlocked([...el.classList].filter((c) => c !== BLOCKED_CONTROL_CLASS));
  }
});

test("a CATEGORY search row is marked blocked; a CELL row is not, because it still works", () => {
  // The worst case in the review: on a wide holder a category row's whole branch is
  // camera work, so activating it did literally nothing with no marking. A CELL row is
  // deliberately left live — it still selects the cell and fills the Inspector, which the
  // API serves, and only its camera move is refused (the same carve-out as
  // handleCanvasClick).
  const reason = "The viewer's graphics stopped — viewer controls are unavailable until it recovers.";
  const rows = [
    { kind: "category", field: "artist", label: "Artist", value: "Rembrandt", memberIds: [1, 2], count: 2 },
    { kind: "cell", id: 7, field: "title", role: "title", label: "Title", snippet: "a night watch" },
  ];
  const activated: string[] = [];
  const r = render(
    h(SearchResults, {
      state: { status: "ready", query: "rem", tier: "default", rows, activeIndex: -1, capped: false } as never,
      listboxId: "lb",
      optionId: (i: number) => `opt-${i}`,
      onActivate: (row: { kind: string }) => activated.push(row.kind),
      onHover: () => {},
      blockedReason: reason,
    }),
  );
  const options = [...r.container.querySelectorAll('[role="option"]')] as HTMLElement[];
  assert.equal(options.length, 2, "re-anchor this pin: the fixture no longer renders two rows");
  const [category, cell] = options;
  assert.equal(category.getAttribute("aria-disabled"), "true", "a dead category row did not say so");
  assert.equal(category.classList.contains(BLOCKED_CONTROL_CLASS), true);
  assert.equal((category.getAttribute("title") ?? "").includes(reason), true);
  assert.equal(cell.getAttribute("aria-disabled"), null, "a cell row that still selects was marked dead");
  assert.equal(cell.classList.contains(BLOCKED_CONTROL_CLASS), false);

  // BOTH still reach `onActivate` — the marking is presentation only. `jumpToRow` is
  // where the refusal belongs, because it dismisses the ☰ the user just acted in BEFORE
  // declining the camera work (#271 F2). Short-circuiting here left the popover stuck
  // over the canvas on a narrow holder, and only for the mouse: the keyboard path calls
  // `jumpToRow` directly and never saw the component's own refusal.
  fireEvent.click(category);
  fireEvent.click(cell);
  assert.deepEqual(
    activated,
    ["category", "cell"],
    "a blocked row swallowed the activation the handler needs in order to dismiss the menu",
  );
  assertStyledBlocked([...category.classList].filter((c) => c !== BLOCKED_CONTROL_CLASS));
});

test("the shell subscribes to the loader's images-not-loading signal", () => {
  // P3's surface only says anything if the shell is listening. Source-level for the same
  // reason as the R1-05 pin beside it: the loader exists only after a successful
  // createWorld. The BEHAVIOUR is pinned GL-free in tests/tile_pyramid_failing.test.ts.
  assert.equal(
    SRC.split("setTilesFailingListener(").length - 1,
    1,
    "nothing subscribes to the loader's failing-reads signal — the status bar can never say it",
  );
});

// --- C1 + root cause A: what has to happen when the renderer comes BACK -------

test("the recovery re-apply is skipped when the user changed nothing (review A9)", () => {
  // `applyTags` is not free: measured 26.6 ms at 1M on every context restore, 2.85 ms even
  // for an empty selection, plus a full instanced-mesh rebuild. A context loss is common
  // and usually brief, and in almost every one of them the user touched nothing — so the
  // re-apply has to be conditional on the selection having actually MOVED while blocked.
  const a = { selected: [{ column: "artist", value: "Rembrandt" }], mode: "or" } as never;
  const b = { selected: [{ column: "artist", value: "Rembrandt" }], mode: "or" } as never;
  assert.equal(sameTagSelection(a, b), true, "an identical selection would be re-applied for nothing");
  assert.equal(
    sameTagSelection(a, { selected: [{ column: "artist", value: "Vermeer" }], mode: "or" } as never),
    false,
    "a changed value was treated as unchanged — the canvas would keep the old filter",
  );
  assert.equal(
    sameTagSelection(a, { selected: [{ column: "artist", value: "Rembrandt" }], mode: "and" } as never),
    false,
    "a changed COMBINE MODE was treated as unchanged",
  );
  // Clearing while blocked is the case that made the re-apply unconditional in the first
  // place: the rail shows nothing while the canvas is still filtered.
  assert.equal(sameTagSelection(a, { selected: [], mode: "or" } as never), false, "a cleared filter was missed");
  assert.equal(sameTagSelection({ selected: [], mode: "or" } as never, { selected: [], mode: "or" } as never), true);
});

test("the shell re-applies the tag selection a lost context refused", () => {
  // Review C1. `handleTagChange` records the selection and refuses to push it, which is
  // right for a STACK failure — the rebuild's boot chain re-applies it. A `context-lost`
  // also refuses, and recovers IN PLACE with no rebuild, so nothing re-ran that
  // re-apply: the rail said "dogs", the canvas still highlighted cats and the status bar
  // still reported the old match count, permanently. Source-level because reaching it
  // needs a live stack, which jsdom cannot build; the refusal itself is pinned on
  // `whenStackUsable` above.
  const recover = slice('prev !== "context-lost"', "}, [rendererHealth]);");
  assert.equal(
    recover.includes("applyTags("),
    true,
    "a context loss refuses tag changes and nothing re-applies them when it comes back",
  );
  assert.equal(
    recover.includes("setTagState("),
    true,
    "the re-applied selection never reaches the status bar's match count",
  );
  // Review A9, and caught by mutation: a pin on `sameTagSelection` alone passed with the
  // predicate wired to nothing, so the 26.6 ms rebuild ran on every context loss anyway.
  assert.equal(
    recover.includes("sameTagSelection("),
    true,
    "the recovery re-applies unconditionally — 26.6 ms at 1M, plus a mesh rebuild, for nothing",
  );
});

test("the shell re-arms its scheduled sites when a view recovers", () => {
  // Root cause A2: a failed boot latches the 750ms overview poll, `fail()` drops the
  // publish (a `"none"` report over a standing failure), and "Retry this view" then
  // succeeds — leaving the minimap frozen for the life of the page with nothing on the
  // observable saying so. The latch has to be released by the recovery.
  for (const [from, to] of [
    ["function retryView()", "function retryRenderer()"],
    ["maybeAutoFit(layoutId);", "failureResolvedBySwitch(health.snapshot())"],
    // Review A7: a context loss is the one window where these sites CANNOT report for
    // themselves — a `"none"` failure raised while health is `context-lost` is dropped by
    // precedence, guaranteed — so the transition back is the only chance to release them.
    ['prev !== "context-lost"', "}, [rendererHealth]);"],
  ] as const) {
    assert.equal(
      slice(from, to).includes("resumeScheduled()"),
      true,
      `${from.trim()} recovers the view but leaves the shell's scheduled sites latched off`,
    );
  }
  // ...and every one of those goes through the owner that ALSO retracts the report, so
  // the latch and the health state cannot drift ([[T2-232]]).
  assert.equal(
    slice("function resumeScheduled()", "const prevHealthKindRef").includes("clearResumedReadoutFailure("),
    true,
    "the latch is released and the report it made obsolete is left standing",
  );
  // ...and the mount effect has to publish them, or that ref is null forever and the two
  // calls above are no-ops that read as wired.
  assert.equal(
    SRC.includes("resumeScheduledRef.current = () =>"),
    true,
    "nothing ever populates the resume hook",
  );
});
