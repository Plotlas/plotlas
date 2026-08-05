// DOM tier (UI-S1) — the search dropdown / Inspector split, pinned against the REAL
// ViewerScreen.
//
// ViewerScreen DOES mount in jsdom. The older comments in ViewerScreen.ts and
// search_results.dom.test.ts say it "cannot" because it builds a WebGL renderer stack;
// measured 2026-07-31, it can: createWorld throws inside the mount effect's async IIFE,
// which the shipped `.catch(surface)` turns into the error banner, and the entire React
// shell (top bar, combobox, rails, Inspector, minimap) renders. So every pin below drives
// the SHIPPED component through real DOM events — not a harness reproducing its wiring.
//
// The ONE link a headless mount cannot drive is a canvas cell click: handleCanvasClick
// returns early while stackRef.current is null, and there is no WebGL context to build a
// stack from. That link is the reveal-on-selection rule, which is therefore pinned
// directly as the exported `useRevealOnSelection` hook (the same extraction bandSnapBBox
// / runLocate made for their own jsdom-unreachable steps).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ViewerScreen, useRevealOnSelection } from "../../src/ui/ViewerScreen.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { SearchHit, SearchResponse } from "../../src/api-client/types.ts";

// Return null from getContext rather than let jsdom's "not implemented" thrower run:
// THREE then fails with its own clean "Error creating WebGL context" (the same branch a
// real browser without WebGL takes) and the Minimap's 2d guard (`if (ctx === null)`)
// takes its documented no-op path. Restored after each test.
const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof realGetContext;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  cleanup();
});

const hit = (id: number, snippet: string): SearchHit => ({
  id,
  field: "title",
  role: "title",
  label: "Title",
  snippet,
});

/** A client answering only what a ViewerScreen mount + a search needs. */
function stubClient(hits: SearchHit[]): ApiClient {
  return {
    async listLayouts() {
      return [{ layout_id: "grid", label: "Grid", type: "grid" }];
    },
    async getManifest() {
      return {
        manifest_version: "2.5",
        dataset_id: "ds",
        dataset_version: 1,
        dataset_metadata: { image_count: 3 },
        column_roles: { columns: [] },
        layouts: [
          {
            layout_id: "grid",
            label: "Grid",
            type: "grid",
            bbox: [0, 0, 1, 1],
            pyramid: {
              container: "pmtiles",
              path: "grid.pmtiles",
              tile_px: 512,
              thumb_px: 64,
              cap: 64,
              levels: [{ z: 0, tile_count: 1 }],
              z_cap: 0,
            },
          },
        ],
      };
    },
    async search(): Promise<SearchResponse> {
      return { query: "rem", hits, capped: false };
    },
    authHeaders() {
      return {};
    },
  } as unknown as ApiClient;
}

/** Mount the real ViewerScreen and let its (failing) stack build settle. */
async function mountViewer(hits: SearchHit[] = [hit(7, "Night Watch")]): Promise<HTMLElement> {
  const r = render(
    h(ViewerScreen, {
      datasetId: "ds",
      client: stubClient(hits),
      onBack: () => {},
      onAuthExpired: () => {},
    }),
  );
  await screen.findByRole("combobox");
  return r.container as HTMLElement;
}

/** Type into the search box and wait for the debounced results to render. Deliberately
 *  a querySelector rather than findByRole: a regression that renders the results TWICE
 *  must fail its own pin below, not blow up every test in this file on
 *  "found multiple elements with the role option". */
async function searchFor(text: string): Promise<void> {
  fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
  await waitFor(() => assert.ok(document.querySelector('[role="option"]') !== null), {
    timeout: 2000,
  });
}

const listbox = (): HTMLElement | null => document.querySelector('[role="listbox"]');
/** Assert on a BOOLEAN, never on the element itself. Measured: `assert.equal(el, null)`
 *  makes node util.inspect a jsdom node to build its diff, which walks the whole tree and
 *  OOM-killed the runner (SIGKILL after 78s) the first time a mutation made one fail. */
const listboxShown = (): boolean => listbox() !== null;
const hideSearch = (): HTMLElement => screen.getByLabelText("Hide search results");
const collapseInspector = (): HTMLElement => screen.getByLabelText("Collapse inspector");

// ---------------------------------------------------------------------------
// §3 — the combobox contract survives the move out of the Inspector
// ---------------------------------------------------------------------------

test("the combobox's aria-controls / aria-activedescendant still RESOLVE after the listbox moves out of the Inspector", async () => {
  const container = await mountViewer();
  await searchFor("rem");

  const input = screen.getByRole("combobox");

  // aria-controls is an IDREF: the id it names must exist in the document and be the
  // listbox. This is the half that fails silently — the panel renders and the mouse
  // works either way.
  const controls = input.getAttribute("aria-controls");
  assert.ok(controls !== null && controls !== "", "combobox has no aria-controls");
  const popup = document.getElementById(controls);
  assert.ok(popup !== null, `aria-controls="${controls}" resolves to nothing in the document`);
  assert.equal(popup.getAttribute("role"), "listbox");
  assert.equal(input.getAttribute("aria-expanded"), "true");

  // ...and it resolves to the listbox in its NEW home, not the Inspector's body.
  assert.ok(
    container.querySelector(".topbar-search")?.contains(popup),
    "the listbox is not inside the top-bar search pill",
  );
  assert.equal(
    container.querySelector(".inspector-body")?.contains(popup) ?? false,
    false,
    "the listbox is still inside the Inspector's body",
  );

  // Keyboard navigation: ArrowDown must point aria-activedescendant at an option that
  // actually exists, or screen-reader/keyboard nav is silently dead.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => assert.ok(input.getAttribute("aria-activedescendant")));
  const activeId = input.getAttribute("aria-activedescendant") as string;
  const activeOption = document.getElementById(activeId);
  assert.ok(activeOption !== null, `aria-activedescendant="${activeId}" resolves to nothing`);
  assert.equal(activeOption.getAttribute("role"), "option");
  assert.equal(activeOption.getAttribute("aria-selected"), "true");
  assert.ok(popup.contains(activeOption), "the active option is not inside the controlled listbox");
});

test("a HIDDEN dropdown reports aria-expanded=false and names no activedescendant", async () => {
  await mountViewer();
  await searchFor("rem");
  const input = screen.getByRole("combobox");

  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => assert.ok(input.getAttribute("aria-activedescendant")));

  fireEvent.click(hideSearch());

  // The popup is gone, so neither attribute may keep claiming it is there — an
  // activedescendant naming an unrendered option is exactly the silent break.
  await waitFor(() => assert.equal(listboxShown(), false));
  assert.equal(input.getAttribute("aria-expanded"), "false");
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  // #227: aria-controls must not dangle either — the id it names is not in the document
  // while hidden, so the IDREF is dropped alongside the other two combobox attributes.
  assert.equal(input.getAttribute("aria-controls"), null);
  // #227: hiding unmounts the toggle button; focus must return to the (persistent)
  // combobox input, not fall to <body>. (Boolean compare — never inspect a jsdom node.)
  assert.equal(document.activeElement === input, true, "focus was dropped to <body> when the dropdown was hidden");
});

test("re-showing a hidden dropdown starts with no active row, and keeps focus in the input (#227)", async () => {
  await mountViewer();
  await searchFor("rem");
  const input = screen.getByRole("combobox");

  // Arrow to an option, then hide the dropdown.
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() => assert.ok(input.getAttribute("aria-activedescendant")));
  fireEvent.click(hideSearch());
  await waitFor(() => assert.equal(listboxShown(), false));

  // Re-show via the in-pill chevron.
  fireEvent.click(screen.getByLabelText("Show search results"));
  await waitFor(() => assert.equal(listboxShown(), true));

  // The active row was cleared on hide, so the re-shown list advertises NO active option:
  // otherwise Enter would activate a row the user last saw a hide ago, and a stale
  // aria-activedescendant would mislead a screen reader.
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  assert.equal(document.querySelector('[role="option"][aria-selected="true"]') === null, true);
  assert.equal(document.activeElement === input, true, "focus was dropped to <body> when the dropdown was re-shown");
});

// ---------------------------------------------------------------------------
// §6 — hidden → shown transitions (not "does it render when visible")
// ---------------------------------------------------------------------------

test("the search dropdown reveals itself on typing — every time, including after a manual hide", async () => {
  await mountViewer();

  // 1st reveal: from the never-shown state.
  await searchFor("rem");
  assert.equal(listboxShown(), true, "the dropdown did not open on the first search");

  // Hide it, then type again — it must come BACK.
  fireEvent.click(hideSearch());
  await waitFor(() => assert.equal(listboxShown(), false));

  await searchFor("rembrandt");
  assert.equal(listboxShown(), true, "the dropdown did not re-open after a manual hide");

  // Hide once more; arrowing into the list is the other reveal trigger.
  fireEvent.click(hideSearch());
  await waitFor(() => assert.equal(listboxShown(), false));
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
  await waitFor(() =>
    assert.equal(listboxShown(), true, "arrowing into the list did not re-open the dropdown"),
  );
});

/** Probe over the SHIPPED reveal rule: a stable useState setter, exactly as
 *  ViewerScreen passes `setInspectorCollapsed`. An inline closure here would be a new
 *  function every render and would mask a wrong dependency list. */
function RevealProbe(props: { selectedIds: number[] }): ReturnType<typeof h> {
  const [collapsed, setCollapsed] = useState(true);
  useRevealOnSelection(props.selectedIds, setCollapsed);
  return h(
    "div",
    null,
    h("span", { "data-testid": "state" }, collapsed ? "collapsed" : "expanded"),
    h("button", { type: "button", onClick: () => setCollapsed(true) }, "hide"),
  );
}

test("selecting a cell reveals the Inspector — on EVERY selection, not just the first", async () => {
  const r = render(h(RevealProbe, { selectedIds: [] }));
  const state = (): string => screen.getByTestId("state").textContent ?? "";

  // Nothing selected: an empty selection must NOT force the panel open (a background
  // click that clears the selection is not a reason to reveal).
  assert.equal(state(), "collapsed");

  // --- first selection: hidden → shown
  r.rerender(h(RevealProbe, { selectedIds: [7] }));
  await waitFor(() => assert.equal(state(), "expanded", "1st selection did not reveal"));

  // --- hide it again, then select a DIFFERENT cell: hidden → shown, AGAIN.
  // This half is the operator's actual bug ("it opened the first time, then I hid it,
  // then clicking did nothing"); a pin covering only the first selection reproduces it.
  fireEvent.click(screen.getByText("hide"));
  await waitFor(() => assert.equal(state(), "collapsed"));

  r.rerender(h(RevealProbe, { selectedIds: [42] }));
  await waitFor(() =>
    assert.equal(state(), "expanded", "2nd selection (a DIFFERENT cell, after a manual hide) did not reveal"),
  );

  // --- and a third time, re-selecting the SAME cell (a fresh array each click).
  fireEvent.click(screen.getByText("hide"));
  await waitFor(() => assert.equal(state(), "collapsed"));

  r.rerender(h(RevealProbe, { selectedIds: [42] }));
  await waitFor(() =>
    assert.equal(state(), "expanded", "3rd selection (the SAME cell re-clicked) did not reveal"),
  );
});

// ---------------------------------------------------------------------------
// §2(c) — the two panels are independent
// ---------------------------------------------------------------------------

test("hiding either panel leaves the other's visibility untouched", async () => {
  const container = await mountViewer();
  await searchFor("rem");

  const inspectorShown = (): boolean => container.querySelector(".inspector") !== null;

  // Both are up.
  assert.equal(listboxShown(), true);
  assert.equal(inspectorShown(), true);

  // Collapse the Inspector → the search results must survive it.
  fireEvent.click(collapseInspector());
  await waitFor(() => assert.equal(inspectorShown(), false));
  assert.equal(listboxShown(), true, "collapsing the Inspector also hid the search results");
  assert.ok(screen.getByLabelText("Expand inspector"));

  // Hide the search dropdown → the Inspector must stay exactly as the user left it
  // (collapsed), i.e. this must not re-expand or otherwise disturb it.
  fireEvent.click(hideSearch());
  await waitFor(() => assert.equal(listboxShown(), false));
  assert.equal(inspectorShown(), false, "hiding the search results re-expanded the Inspector");
  assert.ok(screen.getByLabelText("Expand inspector"), "hiding search disturbed the Inspector");

  // Re-expand the Inspector → the search dropdown must stay hidden.
  fireEvent.click(screen.getByLabelText("Expand inspector"));
  await waitFor(() => assert.equal(inspectorShown(), true));
  assert.equal(listboxShown(), false, "expanding the Inspector also re-showed the search results");
});

test("a live search no longer takes over the Inspector's body", async () => {
  const container = await mountViewer();
  await searchFor("rem");

  // With a query live and results on screen, the Inspector still shows its own body.
  const body = container.querySelector(".inspector-body");
  assert.ok(body !== null);
  assert.equal(
    body.querySelector('[role="listbox"]') === null,
    true,
    "the Inspector's body is rendering the search results again",
  );
  assert.ok(body.textContent?.includes("Click a cell to inspect it."));
});

// ---------------------------------------------------------------------------
// §2(a) — the top-bar floats declare the same vertical padding
// ---------------------------------------------------------------------------

test("the search pill's vertical padding matches its top-bar siblings", async () => {
  // jsdom does no layout, so this pins the DECLARATION, not the rendered height (the
  // residual content-height difference is reported in the PR, not tuned here).
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8");
  const verticalPad = (selector: string): string => {
    const rule = new RegExp(`\\${selector}\\s*\\{[^}]*?padding:\\s*([^;]+);`, "s").exec(css);
    assert.ok(rule !== null, `no padding declared for ${selector}`);
    return rule[1].trim().split(/\s+/)[0]; // the vertical (first) term
  };
  assert.equal(verticalPad(".topbar-nav"), "0.35rem");
  assert.equal(verticalPad(".topbar-layouts"), "0.35rem");
  assert.equal(verticalPad(".topbar-search"), "0.35rem");
});
