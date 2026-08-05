// DOM tier (T2-57) — the search interaction: the debounce/submit tier split and the
// WAI-ARIA combobox keyboard nav, driven through a real input + the SHIPPED helpers
// (searchKeydown / searchReducer / SearchResults). The harness below reproduces the
// search wiring ViewerScreen binds — the debounce → runSearch("default"), the
// Enter-no-active-row → runSearch("all"), the ArrowDown/Enter → activate — over those
// helpers, with a spy client.search and a spy jump, which is what lets these tests
// assert on the CALLS (tier, count) rather than only on rendered output.
//
// This header used to claim ViewerScreen "cannot mount in jsdom (it builds a WebGL
// renderer stack)". That is false — measured 2026-07-31 (UI-S1): the WebGL failure is
// caught by the mount effect's own .catch and becomes the error banner, and the shell
// renders. Panel/ARIA behaviour that needs the real component is pinned against it in
// viewer_panels.dom.test.ts; these stay on the harness for the call-level spies.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, useReducer, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  SearchResults,
  searchReducer,
  searchKeydown,
  initialSearchState,
} from "../../src/ui/SearchResults.ts";
import type { SearchRow } from "../../src/ui/SearchResults.ts";
import type { SearchHit, SearchResponse } from "../../src/api-client/types.ts";
import type { LabelAnnotation, LayoutEntry } from "../../src/renderer/layout.ts";

afterEach(() => cleanup());

const DEBOUNCE_MS = 15;

interface Calls {
  search: { q: string; tier: "default" | "all" }[];
  activated: SearchRow[];
}

/** A harness reproducing ViewerScreen's search wiring over the shipped helpers. */
function Harness(props: {
  respond: (q: string, tier: "default" | "all") => SearchResponse;
  calls: Calls;
}): ReturnType<typeof h> {
  const [query, setQuery] = useState("");
  const [state, dispatch] = useReducer(searchReducer, initialSearchState);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function run(q: string, tier: "default" | "all"): void {
    const t = q.trim();
    if (t === "") {
      dispatch({ type: "clear" });
      return;
    }
    const s = ++seq.current;
    props.calls.search.push({ q: t, tier });
    dispatch({ type: "loading", query: t, tier });
    Promise.resolve(props.respond(t, tier)).then((resp) => {
      if (seq.current === s) dispatch({ type: "results", query: t, tier, hits: resp.hits, capped: resp.capped });
    });
  }

  function onInput(v: string): void {
    setQuery(v);
    if (timer.current !== null) clearTimeout(timer.current);
    if (v.trim() === "") {
      dispatch({ type: "clear" });
      return;
    }
    // Mirrors ViewerScreen: enter the searching state on the keystroke, not when the
    // debounced request fires, so the panel never shows its idle prompt mid-typing.
    dispatch({ type: "loading", query: v.trim(), tier: "default" });
    timer.current = setTimeout(() => run(v, "default"), DEBOUNCE_MS);
  }

  function onKey(e: { key: string; preventDefault: () => void }): void {
    const action = searchKeydown(e.key, state.rows.length, state.activeIndex);
    if (action === null) return;
    e.preventDefault();
    if (action.type === "move") dispatch({ type: "move", index: action.index });
    else if (action.type === "activate") props.calls.activated.push(state.rows[action.index]);
    else if (action.type === "submit") {
      if (timer.current !== null) clearTimeout(timer.current);
      run(query, "all");
    } else {
      setQuery("");
      dispatch({ type: "clear" });
    }
  }

  return h(
    "div",
    null,
    h("input", {
      role: "combobox",
      "aria-label": "Search",
      "aria-activedescendant": state.activeIndex >= 0 ? `opt-${state.activeIndex}` : undefined,
      value: query,
      onChange: (e: { currentTarget: { value: string } }) => onInput(e.currentTarget.value),
      onKeyDown: onKey,
    }),
    h(SearchResults, {
      state,
      listboxId: "lb",
      optionId: (i: number) => `opt-${i}`,
      onActivate: (row: SearchRow) => props.calls.activated.push(row),
      onHover: (i: number) => dispatch({ type: "move", index: i }),
    }),
  );
}

const hit = (id: number, role: string, snippet: string): SearchHit => ({
  id,
  field: role === "categorical" ? "artist" : "title",
  role,
  label: role === "categorical" ? "Artist" : "Title",
  snippet,
});

function newCalls(): Calls {
  return { search: [], activated: [] };
}

const band = (text: string, count: number): LabelAnnotation => ({ text, extent: [0.1, 0.2, 0.6, 0.8], count });

/** The active "Artist" categorical layout carrying v2.5 band annotations. */
const artistLayout: LayoutEntry = {
  layout_id: "categorical_artist",
  label: "Artist",
  type: "categorical",
  bbox: [0, 0, 1, 1],
  pyramid: {
    container: "pmtiles",
    path: "x.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [{ z: 0, tile_count: 1 }],
    z_cap: 0,
  },
  annotations: { labels: [band("Rembrandt van Rijn", 4508)] },
};

test("a keystroke debounces one tier-0 (default) search and renders the results list", async () => {
  const calls = newCalls();
  render(
    h(Harness, {
      calls,
      respond: () => ({ query: "rem", hits: [hit(1, "title", "Night Watch")], capped: false }),
    }),
  );
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "rem" } });

  await waitFor(() => assert.equal(calls.search.length, 1));
  assert.deepEqual(calls.search[0], { q: "rem", tier: "default" }); // keystroke ⇒ tier-0
  await screen.findByRole("option");
  assert.ok(screen.getByText("Night Watch"));
});

test("Enter with no active row submits the tier-2 (all) catch-all", async () => {
  const calls = newCalls();
  render(
    h(Harness, {
      calls,
      respond: (_q, tier) => ({
        query: "militia",
        hits: tier === "all" ? [hit(2, "freeform", "…a militia company…")] : [],
        capped: false,
      }),
    }),
  );
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "militia" } });
  await waitFor(() => assert.equal(calls.search.length, 1)); // the debounced tier-0

  fireEvent.keyDown(input, { key: "Enter" }); // no active row → submit the catch-all
  await waitFor(() => assert.equal(calls.search.length, 2));
  assert.deepEqual(calls.search[1], { q: "militia", tier: "all" }); // Enter ⇒ tier-2
});

test("ArrowDown then Enter activates the highlighted row (jump), not a submit", async () => {
  const calls = newCalls();
  render(
    h(Harness, {
      calls,
      respond: () => ({ query: "rem", hits: [hit(7, "title", "Night Watch")], capped: false }),
    }),
  );
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "rem" } });
  await screen.findByRole("option");

  fireEvent.keyDown(input, { key: "ArrowDown" }); // activate the first row
  await waitFor(() => assert.equal(input.getAttribute("aria-activedescendant"), "opt-0"));

  const searchesBefore = calls.search.length;
  fireEvent.keyDown(input, { key: "Enter" }); // Enter on an active row → jump, NOT submit
  assert.equal(calls.activated.length, 1);
  assert.equal(calls.activated[0].kind === "cell" ? calls.activated[0].id : -1, 7);
  assert.equal(calls.search.length, searchesBefore); // no extra search fired
});

test("Escape clears the box and dismisses the results", async () => {
  const calls = newCalls();
  render(
    h(Harness, {
      calls,
      respond: () => ({ query: "rem", hits: [hit(1, "title", "Night Watch")], capped: false }),
    }),
  );
  const input = screen.getByRole("combobox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "rem" } });
  await screen.findByRole("option");

  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("option"), null));
  assert.equal(input.value, "");
});

test("clearing the box returns to idle without another search", async () => {
  const calls = newCalls();
  render(
    h(Harness, {
      calls,
      respond: () => ({ query: "rem", hits: [hit(1, "title", "Night Watch")], capped: false }),
    }),
  );
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "rem" } });
  await waitFor(() => assert.equal(calls.search.length, 1));

  fireEvent.change(input, { target: { value: "" } });
  await waitFor(() => assert.equal(screen.queryByRole("option"), null));
  assert.equal(calls.search.length, 1); // emptying the box does not fire a search
});

test("typing enters the searching state immediately, before the debounce fires", async () => {
  const calls = newCalls();
  render(
    h(Harness, {
      calls,
      respond: () => ({ query: "rem", hits: [hit(1, "title", "Night Watch")], capped: false }),
    }),
  );
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "rem" } });

  // Synchronously after the keystroke the request has NOT fired yet, but the panel is
  // already in the searching state: the results body mounts as soon as the box is
  // non-empty, so it must never show the idle prompt back at a user who is mid-type.
  assert.equal(calls.search.length, 0);
  assert.ok(screen.getByText(/searching/i));
  assert.equal(screen.queryByText(/type to search/i), null);

  await waitFor(() => assert.equal(calls.search.length, 1)); // the debounce still fires
});

test("a capped category row renders the EXACT band count with annotations, the '+' floor without", () => {
  // A capped Rembrandt group (2 members on the page, a much larger true category).
  const state = searchReducer(initialSearchState, {
    type: "results",
    query: "rem",
    tier: "default",
    hits: [hit(1, "categorical", "Rembrandt van Rijn"), hit(2, "categorical", "Rembrandt van Rijn")],
    capped: true,
  });
  const props = {
    state,
    listboxId: "lb",
    optionId: (i: number) => `opt-${i}`,
    onActivate: () => {},
    onHover: () => {},
  };

  // On the active Artist categorical layout the band annotation gives the EXACT total.
  const withAnn = render(h(SearchResults, { ...props, activeLayout: artistLayout }));
  assert.ok(withAnn.getByText(/4,508 works/));
  assert.equal(withAnn.queryByText(/2\+ works/), null);
  cleanup();

  // Pre-2.5 / not this column's layout ⇒ the honest capped floor is kept unchanged.
  const noAnn = render(h(SearchResults, { ...props, activeLayout: null }));
  assert.ok(noAnn.getByText(/2\+ works/));
  assert.equal(noAnn.queryByText(/4,508 works/), null);
});
