// The search results-list panel (T2-57 / T2-71 W2). Since UI-S1 (PR #227) it renders in
// the search DROPDOWN under the top-bar pill; it began as the "Inspector-as-results-list"
// third body (hence the name). It is the PRIMARY search surface (the operator's decisive addendum: "a results
// LIST is the primary UI, not just canvas highlighting"). The user reads matching works
// and JUMPS from a list entry to its cell (centerOnCell + pulseHighlight) or, for a
// category value, SNAPS to the category's band (D-3 positions-bbox fallback) — both
// through the already-landed controller surface, so this seam edits no renderer file.
//
// Presentational + pure: this module owns the state machine (searchReducer), the
// WAI-ARIA combobox keyboard model (searchKeydown), the categorical grouping
// (toDisplayRows), the category-snap bbox (unionBBoxFromRects), and the no-results
// copy (noResultsCopy) — all exported and unit-tested — plus the listbox component. The
// stateful orchestration (debounce, the tier-0-keystroke / tier-2-Enter split, the
// fetch) lives in ViewerScreen, which drives this via props. .ts + createElement,
// runtime imports bare-only (see LayoutSwitcher.ts).
//
// THUMBNAILS: v1 is TITLE-ONLY (no per-row image). The only per-cell image available is
// the full-resolution DETAIL original (client.detailUrl / cellPreview.ts) — too heavy to
// burst for up to 50 rows on every keystroke, and there is no cheap 64px per-cell thumb
// endpoint (the fine-tier thumbs are packed inside PMTiles, not individually addressable).
// A row is structured so a lazy thumbnail slot can be added later without a reflow.
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { SearchHit } from "../api-client/types";
// Type-only (erased at runtime — never pulls the renderer/THREE into the node test tier):
// the ACTIVE layout's manifest entry + its v2.5 band-label shape, read to snap a category
// hit to its TRUE band extent and show its EXACT member count (T2-72 Seam 2 consumer).
import type { LayoutEntry, LabelAnnotation } from "../renderer/layout";
import { blockedControl } from "./blockedControl";

// ---------------------------------------------------------------------------
// Display rows: group categorical hits; keep cell hits individual
// ---------------------------------------------------------------------------

/** A category value that matched (e.g. artist "Rembrandt van Rijn"): the row is a
 *  GROUP HEADER; activating it SNAPS the camera to the union of its member cells. */
export interface CategoryRow {
  kind: "category";
  field: string;
  label: string;
  value: string;
  memberIds: number[];
  count: number;
}

/** A single work that matched (title/filename/description/…): activating it JUMPS
 *  to the cell (centerOnCell + pulseHighlight). */
export interface CellRow {
  kind: "cell";
  id: number;
  field: string;
  role: string;
  label: string;
  snippet: string;
}

export type SearchRow = CategoryRow | CellRow;

/** Fold the server's flat hits into display rows: categorical hits collapse to one
 *  group-header row per (field, value) with member counts (compressing a broad query
 *  — spike §3.5), every other hit stays an individual cell row. Categories LEAD (they
 *  offer the snap and head the list — the "Rembrandt" headline case); cell rows follow
 *  in the server's importance order (prefix→substring→id). Insertion order is
 *  preserved, so ranking survives the grouping. */
export function toDisplayRows(hits: SearchHit[]): SearchRow[] {
  const groups = new Map<string, CategoryRow>();
  const cells: CellRow[] = [];
  for (const hit of hits) {
    if (hit.role === "categorical") {
      // JSON-encoded pair, not a delimiter-joined string: it cannot collide however
      // the column name or the value is punctuated, and it keeps this file free of the
      // control character a raw separator would need (a literal NUL here made git
      // classify the whole module as BINARY — no reviewable diff, no eol normalization).
      const key = JSON.stringify([hit.field, hit.snippet]);
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          kind: "category",
          field: hit.field,
          label: hit.label,
          value: hit.snippet,
          memberIds: [hit.id],
          count: 1,
        });
      } else {
        existing.memberIds.push(hit.id);
        existing.count += 1;
      }
    } else {
      cells.push({
        kind: "cell",
        id: hit.id,
        field: hit.field,
        role: hit.role,
        label: hit.label,
        snippet: hit.snippet,
      });
    }
  }
  return [...groups.values(), ...cells];
}

/** Total CELLS represented by the shown rows (a category row counts its members) —
 *  the honest numerator for the "N of many" line when the server capped the payload. */
export function countShownCells(rows: SearchRow[]): number {
  return rows.reduce((n, row) => n + (row.kind === "category" ? row.count : 1), 0);
}

// ---------------------------------------------------------------------------
// Category snap: union the member cells' rects into a fly-to bbox (D-3 fallback)
// ---------------------------------------------------------------------------

export interface WorldBBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** The bounding box (world coords) of a set of cells, from each cell's centre+size
 *  rect (the controller's `cellRect`, read from the resident positions_ref table —
 *  D-3's "compute the category bbox client-side" fallback, no T2-72 dependency).
 *  `rectOf` returns null for a cell with no rect (pre-2.2 / out-of-range); null when
 *  NONE of the ids resolve, so the caller can degrade to a single-cell center. Pure —
 *  the controller dependency is injected as a function so it is unit-testable. */
export function unionBBoxFromRects(
  ids: number[],
  rectOf: (id: number) => { x: number; y: number; w: number; h: number } | null,
): WorldBBox | null {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  let any = false;
  for (const id of ids) {
    const r = rectOf(id);
    if (r === null) continue;
    any = true;
    xMin = Math.min(xMin, r.x - r.w / 2);
    xMax = Math.max(xMax, r.x + r.w / 2);
    yMin = Math.min(yMin, r.y - r.h / 2);
    yMax = Math.max(yMax, r.y + r.h / 2);
  }
  return any ? { xMin, yMin, xMax, yMax } : null;
}

// ---------------------------------------------------------------------------
// Category snap via v2.5 band annotations (T2-72 Seam 2) — the TRUE extent + count
// ---------------------------------------------------------------------------

/** The v2.5 band-annotation match for a category row against the ACTIVE layout entry:
 *  the label whose `text` EXACTLY equals the row's category value, when `entry` is the
 *  categorical layout FOR THIS ROW'S COLUMN and carries `annotations.labels`. The match's
 *  `extent` is the band's TRUE world region (the snap-to target — fitting it frames the
 *  whole category, whereas the ≤50 capped members cluster in the band's top strip and
 *  under-frame it: the #172 defect) and its `count` is the band's EXACT member total (the
 *  authoritative count read-out, even when the payload was capped). Returns null on EVERY
 *  fallback branch — a null/absent entry, a non-categorical active layout, a DIFFERENT
 *  column's categorical layout, a pre-2.5 bake (no annotations), no exact-text band, or
 *  the structurally-missing bucket — so the caller keeps the capped-member behaviour.
 *
 *  Column gate: both the search hit's `label` (→ `row.label`) and the categorical layout
 *  entry's `label` are the column's display label from `column_roles` (the producer sets
 *  the layout label to the role label), so equal labels ⇒ the same column. The missing
 *  bucket (`missing: true`, `text: ""`) is skipped explicitly — its text can equal no real
 *  searched value anyway, but never snap to "no label". Match is EXACT (`text === value`):
 *  the producer emits the raw category value verbatim, so no prefix/fuzzy guess; a value
 *  longer than the server's 160-char snippet cap simply falls back (categoricals are short).
 *  Pure. */
export function matchCategoryLabel(
  row: CategoryRow,
  entry: LayoutEntry | null | undefined,
): LabelAnnotation | null {
  if (entry === null || entry === undefined) return null;
  if (entry.type !== "categorical" || entry.label !== row.label) return null;
  const labels = entry.annotations?.labels;
  if (labels === undefined) return null; // pre-2.5 bake / a categorical layout with no bands
  for (const label of labels) {
    if (label.missing === true) continue; // never match the structurally-missing bucket
    if (label.text === row.value) return label;
  }
  return null;
}

/** The world bbox to fly to for a CATEGORY row's TRUE band extent (T2-72 Seam 2): the
 *  matched band's `extent` unpacked into a WorldBBox, or null when there is no v2.5 band
 *  match — a cell row, or any `matchCategoryLabel` fallback (null/non-matching/pre-2.5
 *  entry) — so the caller degrades to the D-3 positions-bbox snap. Extracting this off
 *  `ViewerScreen.jumpToRow` pins the ONE wiring step a jsdom mount cannot reach — the
 *  `extent` element order `[x_min, y_min, x_max, y_max]` into the fly-to rect — as a pure,
 *  unit-tested unit (T2-136), mirroring how `matchCategoryLabel` was extracted. Pure. */
export function bandSnapBBox(
  row: SearchRow,
  entry: LayoutEntry | null | undefined,
): WorldBBox | null {
  if (row.kind !== "category") return null;
  const band = matchCategoryLabel(row, entry);
  if (band === null) return null;
  const [xMin, yMin, xMax, yMax] = band.extent;
  return { xMin, yMin, xMax, yMax };
}

// ---------------------------------------------------------------------------
// The state machine (reducer) — the results-list lifecycle
// ---------------------------------------------------------------------------

export type SearchStatus = "idle" | "loading" | "ready" | "error";
export type SearchTier = "default" | "all";

export interface SearchViewState {
  /** The query the current `rows` correspond to (for the no-results copy + a stale
   *  guard); "" while idle. */
  query: string;
  status: SearchStatus;
  rows: SearchRow[];
  /** true when the server returned fewer hits than matched — the "N of many" signal. */
  capped: boolean;
  /** Which tier produced `rows` — drives the no-results copy (default vs catch-all). */
  tier: SearchTier;
  error: string | null;
  /** The active option index for the ARIA combobox: -1 ⇒ focus in the input, no row
   *  active; else an index into `rows`. */
  activeIndex: number;
}

export const initialSearchState: SearchViewState = {
  query: "",
  status: "idle",
  rows: [],
  capped: false,
  tier: "default",
  error: null,
  activeIndex: -1,
};

export type SearchEvent =
  | { type: "loading"; query: string; tier: SearchTier }
  | { type: "results"; query: string; tier: SearchTier; hits: SearchHit[]; capped: boolean }
  | { type: "error"; query: string; tier: SearchTier; message: string }
  | { type: "move"; index: number }
  | { type: "clear" };

/** Pure transition for the results panel. `loading`/`results`/`error` carry the query
 *  they are for so a caller-guarded stale response can be ignored upstream; a fresh
 *  result resets the active row to the input (-1). `clear` returns to idle (box
 *  emptied / Escape). */
export function searchReducer(state: SearchViewState, event: SearchEvent): SearchViewState {
  switch (event.type) {
    case "loading":
      return { ...state, query: event.query, tier: event.tier, status: "loading", error: null };
    case "results":
      return {
        ...state,
        query: event.query,
        tier: event.tier,
        status: "ready",
        rows: toDisplayRows(event.hits),
        capped: event.capped,
        error: null,
        activeIndex: -1,
      };
    case "error":
      return { ...state, query: event.query, tier: event.tier, status: "error", error: event.message };
    case "move":
      return { ...state, activeIndex: event.index };
    case "clear":
      return { ...initialSearchState };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// The keyboard model (WAI-ARIA combobox) — focus stays in the input
// ---------------------------------------------------------------------------

export type SearchAction =
  | { type: "move"; index: number } // move the active option (aria-activedescendant)
  | { type: "activate"; index: number } // Enter on an active row → jump/snap
  | { type: "submit" } // Enter with no active row → run the tier-2 catch-all
  | { type: "close" }; // Escape → clear the search

/** The WAI-ARIA combobox key contract (spike §3.3/§6.3), focus staying in the input:
 *  ↓ moves the active row down (from the input, -1, to the first row), ↑ moves up (and
 *  from the first row back to the input), Enter ACTIVATES the active row (jump/snap) or,
 *  with no active row, SUBMITS the tier-2 catch-all (the "Enter also searches
 *  descriptions" reach — D-4), Escape closes. Pure over primitives (rowCount +
 *  activeIndex); the caller maps an `activate` index to its row. Returns null for keys
 *  it does not own (so typing falls through to the input). */
export function searchKeydown(
  key: string,
  rowCount: number,
  activeIndex: number,
): SearchAction | null {
  switch (key) {
    case "ArrowDown":
      if (rowCount === 0) return null;
      return { type: "move", index: Math.min(activeIndex + 1, rowCount - 1) };
    case "ArrowUp":
      if (rowCount === 0) return null;
      return { type: "move", index: Math.max(activeIndex - 1, -1) };
    case "Enter":
      if (activeIndex >= 0 && activeIndex < rowCount) return { type: "activate", index: activeIndex };
      return { type: "submit" };
    case "Escape":
      return { type: "close" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// No-results copy (NN/g rules, spike §6.5): explain + next step, never a joke
// ---------------------------------------------------------------------------

/** The no-results message: echo the query, say WHAT was searched, and offer the wider
 *  scope as the next step (never a dead end). The default tier points at the Enter
 *  catch-all; the catch-all tier (already the widest) suggests refining the term. */
export function noResultsCopy(query: string, tier: SearchTier): { message: string; hint: string } {
  const q = query.trim();
  if (tier === "all") {
    return {
      message: `No matches for “${q}”.`,
      hint: "Searched titles, artists, filenames, and descriptions. Try a shorter or a different term.",
    };
  }
  return {
    message: `No matches for “${q}”.`,
    hint: "Searched titles, artists, and filenames. Press Enter to also search descriptions.",
  };
}

// ---------------------------------------------------------------------------
// The panel component (the body of the UI-S1 search dropdown; formerly the Inspector's third body)
// ---------------------------------------------------------------------------

export interface SearchResultsProps {
  state: SearchViewState;
  /** DOM id of the listbox (the combobox input's aria-controls points here). */
  listboxId: string;
  /** DOM id for the option at `index` (matches the input's aria-activedescendant). */
  optionId: (index: number) => string;
  /** Activate a row (click / Enter): jump-to-cell or snap-to-category. */
  onActivate: (row: SearchRow) => void;
  /** Set the active row (pointer hover) so mouse + keyboard stay in sync. */
  onHover: (index: number) => void;
  /** Seam R2 P1: why the renderer cannot serve a row activation right now, or null/absent
   *  when it can. Applied to CATEGORY rows only, and that asymmetry is the point: a
   *  category row is nothing but a camera snap, so on a dead renderer activating it does
   *  literally nothing — while a CELL row still selects the cell and fills the Inspector,
   *  which the API serves, and only its camera move is refused (the same reasoning that
   *  leaves `handleCanvasClick` unguarded). Per-option `aria-disabled` is exactly what a
   *  listbox is for. */
  blockedReason?: string | null;
  /** The ACTIVE layout's manifest entry (T2-72 Seam 2), or null. When it is the
   *  categorical layout for a category row's column and carries band annotations, that row
   *  shows the band's EXACT member total instead of the capped "N+" floor (matchCategoryLabel).
   *  Absent / non-matching ⇒ the floor is kept. Optional so render smokes need not supply it. */
  activeLayout?: LayoutEntry | null;
}

/** Group an integer with thousands separators ("4508" → "4,508") — a band's exact member
 *  total can be large (rijks artists run to thousands of works). Deterministic + ICU-free
 *  (no `toLocaleString`) so the node test tier renders identically everywhere. */
function withThousands(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function rowSecondary(row: SearchRow, capped: boolean, trueCount: number | null): string {
  if (row.kind === "category") {
    // v2.5 (T2-72 Seam 2): when the ACTIVE categorical layout's band annotation carries this
    // category's EXACT member total, show it verbatim ("4,508 works") — authoritative even
    // when the payload was capped (this closes the #172 "N+" floor residual). Absent (pre-2.5
    // bake / not this column's categorical layout) ⇒ the historical read below.
    if (trueCount !== null) {
      return `${withThousands(trueCount)} ${trueCount === 1 ? "work" : "works"} · ${row.label}`;
    }
    // A group only holds the members that fit the capped page, so `count` is a LOWER
    // BOUND once the server capped — render "N+ works" rather than assert an exact
    // total we never received. (The true per-category total needs the T2-72 band
    // extents above; without them an honest floor beats a confident undercount.)
    const n = capped ? `${row.count}+` : `${row.count}`;
    const noun = !capped && row.count === 1 ? "work" : "works";
    return `${n} ${noun} · ${row.label}`;
  }
  return `in ${row.label}`;
}

function rowPrimary(row: SearchRow): string {
  return row.kind === "category" ? row.value : row.snippet;
}

/** The results body shown in the search dropdown while a search is active (UI-S1 / PR #227;
 *  it was the Inspector's body before the move). Renders the
 *  loading / error / no-results / results states as first-class surfaces. The results
 *  state is a `role="listbox"` of `role="option"` rows (the combobox's popup); the
 *  input (in the top bar, owned by ViewerScreen) carries the combobox role + the
 *  aria-activedescendant that references `optionId(activeIndex)`. */
export function SearchResults(props: SearchResultsProps): ReactElement {
  const { state } = props;

  if (state.status === "loading") {
    return h(
      "section",
      { className: "search-results" },
      h("p", { className: "muted search-status" }, "Searching…"),
    );
  }

  if (state.status === "error") {
    return h(
      "section",
      { className: "search-results" },
      h("p", { className: "error-text search-status", role: "alert" }, "Search failed."),
      h("p", { className: "muted" }, state.error ?? "Try again in a moment."),
    );
  }

  if (state.status === "ready" && state.rows.length === 0) {
    const copy = noResultsCopy(state.query, state.tier);
    return h(
      "section",
      { className: "search-results" },
      h("p", { className: "search-status", role: "status" }, copy.message),
      h("p", { className: "muted" }, copy.hint),
    );
  }

  if (state.status === "ready") {
    const shown = countShownCells(state.rows);
    return h(
      "section",
      { className: "search-results" },
      state.capped
        ? h(
            "p",
            { className: "muted search-count" },
            `Showing ${shown} of many — refine your search to narrow it.`,
          )
        : h(
            "p",
            { className: "muted search-count" },
            `${shown} ${shown === 1 ? "match" : "matches"}`,
          ),
      h(
        "ul",
        { className: "search-list", role: "listbox", id: props.listboxId, "aria-label": "Search results" },
        state.rows.map((row, index) => {
          // The band's EXACT member total when this row's category matches the ACTIVE
          // categorical layout's v2.5 annotations (else null ⇒ the capped "N+" floor).
          const trueCount =
            row.kind === "category" ? matchCategoryLabel(row, props.activeLayout)?.count ?? null : null;
          // Seam R2 P1 — see `blockedReason`. PRESENTATION ONLY: the refusal belongs to
          // `jumpToRow`, which dismisses the ☰ the user just acted in BEFORE it declines
          // the camera work (review #271 F2). Refusing here short-circuited that dismiss,
          // so on a narrow holder the popover stuck over the canvas with nothing
          // explaining why — and only for the mouse, since the keyboard path reaches
          // `jumpToRow` directly and never saw this branch.
          const { blocked: _refusedByJumpToRow, ...blockedProps } = blockedControl(
            row.kind === "category" ? props.blockedReason : null,
            { className: `search-row${index === state.activeIndex ? " active" : ""}` },
          );
          return h(
            "li",
            {
              key: row.kind === "category" ? `c:${row.field}:${row.value}` : `x:${row.id}`,
              id: props.optionId(index),
              role: "option",
              ...blockedProps,
              "aria-selected": index === state.activeIndex,
              onMouseEnter: () => props.onHover(index),
              onClick: () => props.onActivate(row),
            },
            h("span", { className: "search-row-primary" }, rowPrimary(row)),
            h("span", { className: "search-row-secondary muted" }, rowSecondary(row, state.capped, trueCount)),
          );
        }),
      ),
    );
  }

  // idle: the box is empty — invite a query (the panel only mounts while searching).
  return h(
    "section",
    { className: "search-results" },
    h("p", { className: "muted" }, "Type to search titles, artists, and filenames."),
  );
}
