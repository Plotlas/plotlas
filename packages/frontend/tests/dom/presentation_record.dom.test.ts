// DOM tier — what the presentation record CHANGES ON SCREEN (D-xvii/D-xviii, seam P2-3).
//
// Phase 2's other two seams are mechanism: a schema, a file, a migration. This is the one
// that a visitor sees, so it is pinned at the render, not at the resolver — a rule that
// returns the right string while the panel draws an empty <h3> is a failure this project
// has hit before.
//
// Every test comes in a pair: the declared case, and the SAME markup with the record
// absent. Absent must mean today's behaviour exactly (D-xvi) — every collection committed
// before 2026-09-07 has no record at all, so the fallback is the common path, not the edge.
//
// Absence is asserted as `queryX() === null, true` rather than `queryX(), null`. That is
// not style. Measured while mutation-proving the hidden-column filter: with a raw node on
// the left, node's assert formats the FOUND jsdom element into the failure message, and
// the file produced no subtest output at all for 164 s before being killed — a pin that
// cannot report its own failure is indistinguishable from one that passed.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { LayoutInfo, MetadataRow } from "../../src/api-client/types.ts";
import type { ColumnPresentationMap } from "../../src/ui/presentation.ts";
import { layoutsWithLabels } from "../../src/ui/presentation.ts";
import { LayoutSwitcher } from "../../src/ui/LayoutSwitcher.ts";
import { MetadataPanelView } from "../../src/ui/MetadataPanel.ts";

afterEach(cleanup);

const ROW: MetadataRow = {
  id: 4211,
  fields: {
    filename: "SK-C-5.jpg",
    object_title: "The Night Watch",
    internal_ref: "RM-0004211",
    blank_title: "   ",
    null_title: null,
  },
};

function renderPanel(opts: { columns?: ColumnPresentationMap; titleColumn?: string | null; row?: MetadataRow } = {}): void {
  render(
    h(MetadataPanelView, {
      selectedCellId: 4211,
      row: opts.row ?? ROW,
      loading: false,
      error: null,
      tagValues: [],
      preview: null,
      columns: opts.columns,
      titleColumn: opts.titleColumn,
    }),
  );
}

// --- (a) the title -------------------------------------------------------------

test("a declared title column heads the panel with the cell's own title", () => {
  renderPanel({ titleColumn: "object_title" });
  assert.ok(screen.getByRole("heading", { name: "The Night Watch" }));
  assert.equal(screen.queryByRole("heading", { name: "Cell 4211" }) === null, true);
});

test("no title column declared ⇒ `Cell {id}`, exactly as today", () => {
  renderPanel();
  assert.ok(screen.getByRole("heading", { name: "Cell 4211" }));
});

test("a title column the row does not carry falls back to `Cell {id}`", () => {
  // D-xvi's dangling case: a metadata update dropped the column, the record still names
  // it. Silent fallback — and never a blank heading, which reads as broken rather than
  // technical.
  renderPanel({ titleColumn: "column_a_metadata_update_removed" });
  assert.ok(screen.getByRole("heading", { name: "Cell 4211" }));
});

test("a whitespace-only title value falls back rather than heading with nothing", () => {
  renderPanel({ titleColumn: "blank_title" });
  assert.ok(screen.getByRole("heading", { name: "Cell 4211" }));
});

test("a null title value falls back rather than heading with 'null'", () => {
  renderPanel({ titleColumn: "null_title" });
  assert.ok(screen.getByRole("heading", { name: "Cell 4211" }));
});

test("no heading in the panel is ever empty, in any of the fallback states", () => {
  // The one assertion that covers the whole enumeration at once: whatever the record
  // says, the <h3> has text. A blank heading is worse than `Cell 4211`.
  for (const titleColumn of [undefined, null, "object_title", "blank_title", "null_title", "gone"]) {
    renderPanel({ titleColumn });
    const headings = screen.getAllByRole("heading");
    assert.equal(headings.length, 1);
    assert.notEqual((headings[0].textContent ?? "").trim(), "", `empty heading for ${String(titleColumn)}`);
    cleanup();
  }
});

test("the cell preview's alt text follows the heading, not the raw id", () => {
  // The second `Cell {id}` on screen. It is the text alternative for the SAME picture the
  // heading names, so leaving it as the ordinal hands a screen-reader user exactly the
  // internal number a sighted user just stopped seeing.
  render(
    h(MetadataPanelView, {
      selectedCellId: 4211,
      row: ROW,
      loading: false,
      error: null,
      tagValues: [],
      preview: { cellId: 4211, imageUrl: "blob:preview" },
      titleColumn: "object_title",
    }),
  );
  assert.ok(screen.getByAltText("The Night Watch preview"));
  cleanup();
  render(
    h(MetadataPanelView, {
      selectedCellId: 4211,
      row: ROW,
      loading: false,
      error: null,
      tagValues: [],
      preview: { cellId: 4211, imageUrl: "blob:preview" },
    }),
  );
  assert.ok(screen.getByAltText("Cell 4211 preview"), "no record ⇒ the alt is unchanged");
});

// --- (b) column display names ---------------------------------------------------

test("a labelled column renders its label; an unlabelled one renders the raw name", () => {
  renderPanel({ columns: { object_title: { label: "Title" } } });
  assert.ok(screen.getByText("Title"), "the declared label is drawn");
  assert.equal(screen.queryByText("object_title") === null, true, "the raw name is replaced, not added");
  assert.ok(screen.getByText("internal_ref"), "an unlabelled column keeps its raw header name");
});

test("no record ⇒ every column renders its raw name, exactly as today", () => {
  renderPanel();
  assert.ok(screen.getByText("object_title"));
  assert.ok(screen.getByText("internal_ref"));
});

test("a label for a column that no longer exists renders nothing at all", () => {
  // Dangling again: the label is keyed by a name the metadata may have dropped. It must
  // not conjure a row for a column with no value.
  renderPanel({ columns: { deleted_column: { label: "Ghost" } } });
  assert.equal(screen.queryByText("Ghost") === null, true);
  assert.ok(screen.getByText("object_title"));
});

// --- (c) show / hide ------------------------------------------------------------

test("a column marked hidden is absent from the panel", () => {
  renderPanel({ columns: { internal_ref: { hidden: true } } });
  assert.equal(screen.queryByText("internal_ref") === null, true, "the name is gone");
  assert.equal(screen.queryByText("RM-0004211") === null, true, "and so is the value");
  assert.ok(screen.getByText("object_title"), "its neighbours are untouched");
});

test("hidden:false is shown — absent and false both mean today's behaviour", () => {
  renderPanel({ columns: { internal_ref: { hidden: false } } });
  assert.ok(screen.getByText("internal_ref"));
});

test("hiding a column does not disturb the label or link of another", () => {
  renderPanel({
    columns: {
      internal_ref: { hidden: true },
      object_title: { label: "Title" },
    },
  });
  assert.equal(screen.queryByText("RM-0004211") === null, true);
  assert.ok(screen.getByText("Title"));
});

// --- layout labels (D-xviii) ----------------------------------------------------

const LAYOUTS: LayoutInfo[] = [
  { layout_id: "grid", label: "Grid", type: "grid" },
  { layout_id: "categorical_artist", label: "Categorical artist", type: "categorical" },
];

test("a declared layout label is what the switcher shows", () => {
  render(
    h(LayoutSwitcher, {
      layouts: layoutsWithLabels(LAYOUTS, { categorical_artist: { label: "By artist" } }),
      activeLayoutId: "grid",
      onSwitch: () => {},
    }),
  );
  assert.ok(screen.getByRole("button", { name: /By artist/ }));
  assert.equal(screen.queryByRole("button", { name: /Categorical artist/ }) === null, true);
  assert.ok(screen.getByRole("button", { name: /Grid/ }), "an un-overridden layout keeps the bake's label");
});

test("an override for a layout that does not exist adds NOTHING to the switcher", () => {
  // The phantom-entry case. `layoutsWithLabels` maps over the BAKE's layouts, so a
  // dangling override cannot contribute a tab — it is unrepresentable, not filtered.
  const relabelled = layoutsWithLabels(LAYOUTS, { deleted_layout: { label: "Ghost layout" } });
  assert.equal(relabelled.length, 2);
  render(
    h(LayoutSwitcher, { layouts: relabelled, activeLayoutId: "grid", onSwitch: () => {} }),
  );
  assert.equal(screen.getAllByRole("button").length, 2, "still exactly the baked layouts");
  assert.equal(screen.queryByRole("button", { name: /Ghost layout/ }) === null, true);
});

// --- the shell actually threads it ----------------------------------------------

test("ViewerScreen threads the record into BOTH inspector surfaces", () => {
  // #251's failure mode: a render rule that passes every unit test while no real caller
  // supplies it. ViewerScreen drives a WebGL renderer and is not mountable in jsdom, so
  // the thread is pinned by reading the source — the same instrument the layout-tap pin
  // uses (renderer_recovery.dom.test.ts). Both surfaces, because the rail inspector and
  // the lightbox are separate call sites and dropping either is invisible in the other.
  const src = readFileSync(new URL("../../src/ui/ViewerScreen.ts", import.meta.url), "utf8");
  assert.equal(src.split("columns: declaredColumns,").length - 1, 2, "MetadataPanel + Lightbox");
  assert.equal(src.split("titleColumn: declaredTitleColumn,").length - 1, 2);
  assert.equal(
    src.split("layoutsWithLabels(baked, record.layouts)").length - 1,
    1,
    "the layout list handed to the switcher is the relabelled one",
  );
});

test("no overrides ⇒ the switcher renders the bake's labels, unchanged", () => {
  render(
    h(LayoutSwitcher, {
      layouts: layoutsWithLabels(LAYOUTS, undefined),
      activeLayoutId: "grid",
      onSwitch: () => {},
    }),
  );
  assert.ok(screen.getByRole("button", { name: /Categorical artist/ }));
});
