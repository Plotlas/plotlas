// Tier-1 unit tests for the search results-list (T2-57): the PURE core — the results
// state machine (searchReducer), the WAI-ARIA combobox keyboard model (searchKeydown),
// categorical grouping (toDisplayRows), the category-snap bbox (unionBBoxFromRects), the
// no-results copy — plus render smokes of the panel's four states via renderToString.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import {
  SearchResults,
  searchReducer,
  searchKeydown,
  toDisplayRows,
  countShownCells,
  unionBBoxFromRects,
  matchCategoryLabel,
  bandSnapBBox,
  noResultsCopy,
  initialSearchState,
} from "../src/ui/SearchResults.ts";
import { escapeClearsSelection } from "../src/ui/ViewerScreen.ts";
import type { CategoryRow, SearchRow, SearchViewState } from "../src/ui/SearchResults.ts";
import type { SearchHit } from "../src/api-client/types.ts";
import type { LabelAnnotation, LayoutEntry } from "../src/renderer/layout.ts";

const hit = (id: number, role: string, snippet: string, field = "f", label = "L"): SearchHit => ({
  id,
  field,
  role,
  label,
  snippet,
});

// A category row + its active-layout context, for the T2-72 band-annotation match.
const catRow = (value: string, label = "Artist", field = "artist"): CategoryRow => ({
  kind: "category",
  field,
  label,
  value,
  memberIds: [1, 2],
  count: 2,
});

const band = (text: string, count: number, extra: Partial<LabelAnnotation> = {}): LabelAnnotation => ({
  text,
  extent: [0.1, 0.2, 0.6, 0.8],
  count,
  ...extra,
});

/** A minimal categorical LayoutEntry carrying `labels` (undefined ⇒ a pre-2.5 bake with
 *  no annotations). Only `type` / `label` / `annotations` gate the match; the rest is the
 *  required manifest shape. */
function catLayout(label: string, labels: LabelAnnotation[] | undefined): LayoutEntry {
  return {
    layout_id: "categorical_x",
    label,
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
    ...(labels === undefined ? {} : { annotations: { labels } }),
  };
}

// ---------------------------------------------------------------------------
// toDisplayRows — categorical grouping + lead ordering
// ---------------------------------------------------------------------------

test("toDisplayRows groups categorical hits into one leading group row with member ids", () => {
  const rows = toDisplayRows([
    hit(1, "categorical", "Rembrandt van Rijn", "artist", "Artist"),
    hit(5, "title", "Night Watch", "title", "Title"),
    hit(2, "categorical", "Rembrandt van Rijn", "artist", "Artist"),
  ]);
  // One category row (both Rembrandts) LEADS, then the individual cell row.
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "category");
  assert.equal(rows[1].kind, "cell");
  const cat = rows[0];
  assert.ok(cat.kind === "category");
  assert.equal(cat.value, "Rembrandt van Rijn");
  assert.deepEqual(cat.memberIds, [1, 2]);
  assert.equal(cat.count, 2);
});

test("toDisplayRows keeps distinct categorical values as separate groups, server order", () => {
  const rows = toDisplayRows([
    hit(1, "categorical", "Rembrandt", "artist", "Artist"),
    hit(3, "categorical", "Vermeer", "artist", "Artist"),
  ]);
  assert.deepEqual(rows.map((r) => (r.kind === "category" ? r.value : "")), ["Rembrandt", "Vermeer"]);
});

test("countShownCells counts a category row by its members", () => {
  const rows = toDisplayRows([
    hit(1, "categorical", "A", "c", "C"),
    hit(2, "categorical", "A", "c", "C"),
    hit(9, "title", "T", "title", "Title"),
  ]);
  assert.equal(countShownCells(rows), 3); // 2 members + 1 cell
});

// ---------------------------------------------------------------------------
// searchKeydown — the WAI-ARIA combobox key contract
// ---------------------------------------------------------------------------

test("searchKeydown ArrowDown steps the active row down, clamped, from the input", () => {
  assert.deepEqual(searchKeydown("ArrowDown", 3, -1), { type: "move", index: 0 });
  assert.deepEqual(searchKeydown("ArrowDown", 3, 1), { type: "move", index: 2 });
  assert.deepEqual(searchKeydown("ArrowDown", 3, 2), { type: "move", index: 2 }); // clamped
  assert.equal(searchKeydown("ArrowDown", 0, -1), null); // no rows → nothing to move
});

test("searchKeydown ArrowUp steps up and back to the input (-1)", () => {
  assert.deepEqual(searchKeydown("ArrowUp", 3, 2), { type: "move", index: 1 });
  assert.deepEqual(searchKeydown("ArrowUp", 3, 0), { type: "move", index: -1 }); // back to input
  assert.deepEqual(searchKeydown("ArrowUp", 3, -1), { type: "move", index: -1 }); // stays
});

test("searchKeydown Enter activates the active row, else submits the catch-all", () => {
  assert.deepEqual(searchKeydown("Enter", 3, 1), { type: "activate", index: 1 });
  assert.deepEqual(searchKeydown("Enter", 3, -1), { type: "submit" }); // no active row → tier-2
  assert.deepEqual(searchKeydown("Enter", 0, -1), { type: "submit" }); // no results → still submit
});

test("searchKeydown Escape closes; other keys fall through to the input", () => {
  assert.deepEqual(searchKeydown("Escape", 3, 1), { type: "close" });
  assert.equal(searchKeydown("a", 3, 1), null);
  assert.equal(searchKeydown("Home", 3, 1), null);
});

// T2-204: Escape as the clear-selection key. Escape has two prior owners (the search
// box clears its query, the Lightbox closes) and this rule must YIELD to both — that
// is the whole content of the guard, so each owner gets its own assertion.
test("escapeClearsSelection: only Escape, only with a selection, never over search/lightbox", () => {
  const base = { typing: false, lightboxOpen: false, selectionCount: 1 };
  assert.equal(escapeClearsSelection("Escape", base), true, "a selection + Escape clears");
  assert.equal(escapeClearsSelection("Escape", { ...base, selectionCount: 5 }), true, "multi too");

  assert.equal(
    escapeClearsSelection("Escape", { ...base, typing: true }),
    false,
    "focus in a field: the search box owns Escape (clear the query)",
  );
  assert.equal(
    escapeClearsSelection("Escape", { ...base, lightboxOpen: true }),
    false,
    "lightbox open: it owns Escape (close)",
  );
  assert.equal(
    escapeClearsSelection("Escape", { ...base, selectionCount: 0 }),
    false,
    "nothing selected: Escape stays free",
  );
  assert.equal(escapeClearsSelection("Enter", base), false, "other keys fall through");
  assert.equal(escapeClearsSelection("esc", base), false, "the key name is exact");
});

// ---------------------------------------------------------------------------
// searchReducer — the results-panel lifecycle
// ---------------------------------------------------------------------------

test("searchReducer: loading → results → move → clear", () => {
  let s = searchReducer(initialSearchState, { type: "loading", query: "rem", tier: "default" });
  assert.equal(s.status, "loading");
  assert.equal(s.query, "rem");

  s = searchReducer(s, {
    type: "results",
    query: "rem",
    tier: "default",
    hits: [hit(1, "categorical", "Rembrandt", "artist", "Artist"), hit(2, "categorical", "Rembrandt", "artist", "Artist")],
    capped: false,
  });
  assert.equal(s.status, "ready");
  assert.equal(s.rows.length, 1); // grouped
  assert.equal(s.activeIndex, -1); // a fresh result resets the active row to the input

  s = searchReducer(s, { type: "move", index: 0 });
  assert.equal(s.activeIndex, 0);

  s = searchReducer(s, { type: "clear" });
  assert.deepEqual(s, initialSearchState);
});

test("searchReducer error carries the tier + message and keeps the query", () => {
  const s = searchReducer(initialSearchState, {
    type: "error",
    query: "x",
    tier: "all",
    message: "boom",
  });
  assert.equal(s.status, "error");
  assert.equal(s.error, "boom");
  assert.equal(s.tier, "all");
});

// ---------------------------------------------------------------------------
// unionBBoxFromRects — the D-3 category-snap fallback (positions bbox)
// ---------------------------------------------------------------------------

test("unionBBoxFromRects unions member cell rects into a world bbox", () => {
  const rects: Record<number, { x: number; y: number; w: number; h: number }> = {
    1: { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // spans [0.15,0.25]²
    2: { x: 0.6, y: 0.8, w: 0.2, h: 0.2 }, // spans [0.5,0.7]×[0.7,0.9]
  };
  const bbox = unionBBoxFromRects([1, 2], (id) => rects[id] ?? null);
  assert.ok(bbox !== null);
  assert.ok(Math.abs(bbox.xMin - 0.15) < 1e-9);
  assert.ok(Math.abs(bbox.yMin - 0.15) < 1e-9);
  assert.ok(Math.abs(bbox.xMax - 0.7) < 1e-9);
  assert.ok(Math.abs(bbox.yMax - 0.9) < 1e-9);
});

test("unionBBoxFromRects skips cells with no rect and returns null when none resolve", () => {
  const only = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
  const bbox = unionBBoxFromRects([1, 2], (id) => (id === 2 ? only : null));
  assert.ok(bbox !== null && Math.abs(bbox.xMin - 0.45) < 1e-9);
  assert.equal(unionBBoxFromRects([1, 2], () => null), null); // pre-2.2 / no positions table
});

// ---------------------------------------------------------------------------
// matchCategoryLabel — the T2-72 Seam 2 band-annotation match (true extent + count)
// ---------------------------------------------------------------------------

test("matchCategoryLabel returns the exact-text band (its true extent + count) on the active categorical layout", () => {
  const entry = catLayout("Artist", [band("Vermeer", 34), band("Rembrandt van Rijn", 4508)]);
  const m = matchCategoryLabel(catRow("Rembrandt van Rijn"), entry);
  assert.ok(m !== null);
  assert.equal(m.count, 4508);
  assert.deepEqual(m.extent, [0.1, 0.2, 0.6, 0.8]); // the snap-to target
});

test("matchCategoryLabel column-gates on the label: a DIFFERENT column's categorical layout does not match", () => {
  // Active layout is the "Nationality" categorical; the row is an "Artist" value → no match,
  // even though a same-named band exists here (the label gate rejects before any text scan).
  const entry = catLayout("Nationality", [band("Rembrandt van Rijn", 4508)]);
  assert.equal(matchCategoryLabel(catRow("Rembrandt van Rijn", "Artist"), entry), null);
});

test("matchCategoryLabel type-gates: a non-categorical active layout never matches", () => {
  const grid: LayoutEntry = { ...catLayout("Artist", [band("Rembrandt van Rijn", 4508)]), type: "grid" };
  assert.equal(matchCategoryLabel(catRow("Rembrandt van Rijn"), grid), null);
});

test("matchCategoryLabel falls back on a pre-2.5 bake (no annotations) and a null/absent entry", () => {
  assert.equal(matchCategoryLabel(catRow("Rembrandt van Rijn"), catLayout("Artist", undefined)), null);
  assert.equal(matchCategoryLabel(catRow("Rembrandt van Rijn"), null), null);
  assert.equal(matchCategoryLabel(catRow("Rembrandt van Rijn"), undefined), null);
});

test("matchCategoryLabel never matches the structurally-missing bucket, and requires an EXACT text", () => {
  // The missing band carries text "" + missing:true; a real value never equals it, and the
  // flag is skipped explicitly. A prefix near-miss does not match — exact only.
  const entry = catLayout("Artist", [band("", 12, { missing: true }), band("Rembrandt van Rijn", 4508)]);
  assert.equal(matchCategoryLabel(catRow(""), entry), null); // "" IS the missing bucket → skipped
  assert.equal(matchCategoryLabel(catRow("Rembrandt"), entry), null); // prefix, not exact
  assert.equal(matchCategoryLabel(catRow("Rembrandt van Rijn"), entry)?.count, 4508);
});

// ---------------------------------------------------------------------------
// no-results copy — NN/g rules: explain + next step, never a joke
// ---------------------------------------------------------------------------

test("noResultsCopy echoes the query and offers the wider scope as the next step", () => {
  const def = noResultsCopy("zorp", "default");
  assert.ok(def.message.includes("zorp"));
  assert.ok(/press enter/i.test(def.hint)); // points at the tier-2 catch-all
  const all = noResultsCopy("zorp", "all");
  assert.ok(all.message.includes("zorp"));
  assert.ok(/different term/i.test(all.hint)); // already the widest scope → refine
});

// ---------------------------------------------------------------------------
// Render smokes — the four panel states (renderToString, no jsdom)
// ---------------------------------------------------------------------------

const baseProps = {
  listboxId: "lb",
  optionId: (i: number) => `opt-${i}`,
  onActivate: () => {},
  onHover: () => {},
};

function renderState(state: SearchViewState): string {
  return renderToString(h(SearchResults, { ...baseProps, state }));
}

function renderStateWith(state: SearchViewState, activeLayout: LayoutEntry | null): string {
  return renderToString(h(SearchResults, { ...baseProps, state, activeLayout }));
}

test("SearchResults renders the loading state", () => {
  const html = renderState({ ...initialSearchState, status: "loading", query: "rem" });
  assert.ok(html.includes("Searching"));
});

test("SearchResults renders the error state", () => {
  const html = renderState({ ...initialSearchState, status: "error", query: "rem", error: "network down" });
  assert.ok(html.includes("Search failed"));
  assert.ok(html.includes("network down"));
});

test("SearchResults renders the no-results state with the next-step hint", () => {
  const html = renderState({ ...initialSearchState, status: "ready", query: "zorp", tier: "default" });
  assert.ok(html.includes("No matches"));
  assert.ok(html.includes("zorp"));
  assert.ok(/press enter/i.test(html));
});

test("SearchResults renders a listbox of options with the N-of-many line when capped", () => {
  const state = searchReducer(
    { ...initialSearchState, status: "loading", query: "art", tier: "default" },
    {
      type: "results",
      query: "art",
      tier: "default",
      hits: [hit(0, "title", "Artwork One", "title", "Title"), hit(1, "title", "Artwork Two", "title", "Title")],
      capped: true,
    },
  );
  const html = renderState(state);
  assert.ok(html.includes('role="listbox"'));
  assert.ok(html.includes('role="option"'));
  assert.ok(html.includes("Artwork One"));
  assert.ok(html.includes('id="opt-0"')); // aria-activedescendant target
  assert.ok(/of many/i.test(html)); // the honest capped line
});

test("a capped category row reports its member count as a floor, not an exact total", () => {
  const hits = [
    hit(1, "categorical", "Rembrandt van Rijn", "artist", "Artist"),
    hit(2, "categorical", "Rembrandt van Rijn", "artist", "Artist"),
  ];
  const results = (capped: boolean): string =>
    renderState(
      searchReducer(initialSearchState, { type: "results", query: "rem", tier: "default", hits, capped }),
    );
  // Capped ⇒ the group only holds the members that fit the page, so the count is a
  // LOWER BOUND ("2+ works") — never a confident undercount of a much larger category.
  assert.ok(/2\+ works/.test(results(true)));
  // Uncapped ⇒ every member came back, so the count IS exact.
  const exact = results(false);
  assert.ok(/2 works/.test(exact));
  assert.ok(!/2\+ works/.test(exact));
});

// ---------------------------------------------------------------------------
// True counts (T2-72 Seam 2): the band annotation replaces the "N+" floor
// ---------------------------------------------------------------------------

const remHits = [
  hit(1, "categorical", "Rembrandt van Rijn", "artist", "Artist"),
  hit(2, "categorical", "Rembrandt van Rijn", "artist", "Artist"),
];
const cappedRem = (): SearchViewState =>
  searchReducer(initialSearchState, { type: "results", query: "rem", tier: "default", hits: remHits, capped: true });

test("a category row shows the EXACT band total from annotations — even when the payload was capped", () => {
  const entry = catLayout("Artist", [band("Rembrandt van Rijn", 4508)]);
  const html = renderStateWith(cappedRem(), entry);
  assert.ok(/4,508 works/.test(html)); // exact total, thousands-separated
  assert.ok(!/2\+ works/.test(html)); // the capped floor is REPLACED, not shown alongside
});

test("the count reverts to the honest floor when no annotation matches (byte-for-byte the old behavior)", () => {
  // No active layout (grid / pre-2.5), and a DIFFERENT column's categorical layout, both floor.
  assert.ok(/2\+ works/.test(renderStateWith(cappedRem(), null)));
  assert.ok(/2\+ works/.test(renderStateWith(cappedRem(), catLayout("Nationality", [band("Dutch", 900)]))));
  assert.ok(/2\+ works/.test(renderStateWith(cappedRem(), catLayout("Artist", undefined)))); // pre-2.5
});

test("an exact band total of 1 uses the singular noun", () => {
  const state = searchReducer(initialSearchState, {
    type: "results",
    query: "x",
    tier: "default",
    hits: [hit(1, "categorical", "Solo", "artist", "Artist")],
    capped: false,
  });
  const html = renderStateWith(state, catLayout("Artist", [band("Solo", 1)]));
  assert.ok(/\b1 work\b/.test(html));
  assert.ok(!/1 works/.test(html));
});

// ---------------------------------------------------------------------------
// bandSnapBBox — the snap-target extraction off ViewerScreen.jumpToRow (T2-136)
// ---------------------------------------------------------------------------

test("bandSnapBBox unpacks the matched band extent into a fly-to bbox in [xMin,yMin,xMax,yMax] order", () => {
  const entry = catLayout("Artist", [band("Rembrandt van Rijn", 4508)]); // extent [0.1, 0.2, 0.6, 0.8]
  // The pure snap-target jumpToRow feeds to fitCamera: the band's world extent maps element-
  // for-element onto the WorldBBox. This is the one wiring step a jsdom mount cannot reach,
  // so the element order is pinned HERE — swap two of them and this assertion fails.
  assert.deepEqual(bandSnapBBox(catRow("Rembrandt van Rijn"), entry), {
    xMin: 0.1,
    yMin: 0.2,
    xMax: 0.6,
    yMax: 0.8,
  });
});

test("bandSnapBBox returns null on every non-match, so the caller keeps the D-3 positions-bbox fallback", () => {
  const entry = catLayout("Artist", [band("Rembrandt van Rijn", 4508)]);
  assert.equal(bandSnapBBox(catRow("Rembrandt van Rijn"), null), null); // no active entry (grid / pre-2.5)
  assert.equal(bandSnapBBox(catRow("Vermeer"), entry), null); // exact-text miss
  // A DIFFERENT column's categorical layout is active (label gate) → no snap.
  assert.equal(bandSnapBBox(catRow("Rembrandt van Rijn"), catLayout("Nationality", [band("Rembrandt van Rijn", 4508)])), null);
  // A CELL row is never a band snap (jumpToRow routes it to centerOnCell + pulse instead).
  const cell: SearchRow = { kind: "cell", id: 7, field: "title", role: "freeform", label: "Title", snippet: "x" };
  assert.equal(bandSnapBBox(cell, entry), null);
});
