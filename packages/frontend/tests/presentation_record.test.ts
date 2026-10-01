// Tier-1: the presentation record's READ side — the narrowing at the client boundary and
// the fallback rules the viewer resolves with (D-xv/D-xvi, seam P2-3).
//
// The record is the one contract in this app that is allowed to be wrong: it is keyed by
// identifiers the OTHER file owns, so a dangling reference is the NORMAL consequence of
// two files changing independently, not an exceptional state. Everything here therefore
// asserts the same property from a different angle — nothing throws, and what does not
// resolve is silently today's behaviour.
import assert from "node:assert/strict";
import test from "node:test";

import { coercePresentation, createApiClient } from "../src/api-client/client.ts";
import {
  cellTitle,
  columnLabel,
  isColumnHidden,
  isUrlColumn,
  layoutsWithLabels,
} from "../src/ui/presentation.ts";
import type { LayoutInfo, MetadataRow } from "../src/api-client/types.ts";

const ROW: MetadataRow = {
  id: 4211,
  fields: { title: "The Night Watch", blank: "  ", empty: "", nothing: null, year: 1642, flag: false },
};

// --- cellTitle ------------------------------------------------------------------

test("cellTitle: a declared column with a usable value titles the cell", () => {
  assert.equal(cellTitle(4211, ROW, "title"), "The Night Watch");
});

test("cellTitle: the value is trimmed, so stray CSV whitespace is not a heading", () => {
  assert.equal(cellTitle(1, { id: 1, fields: { t: "  Spaced  " } }, "t"), "Spaced");
});

test("cellTitle: every un-usable state falls back to `Cell {id}`", () => {
  // The enumeration, in one place: no column declared, no row yet, the column gone from
  // the metadata, a null value, an empty string, whitespace only.
  assert.equal(cellTitle(4211, ROW, undefined), "Cell 4211");
  assert.equal(cellTitle(4211, ROW, null), "Cell 4211");
  assert.equal(cellTitle(4211, null, "title"), "Cell 4211");
  assert.equal(cellTitle(4211, ROW, "column_that_was_dropped"), "Cell 4211");
  assert.equal(cellTitle(4211, ROW, "nothing"), "Cell 4211");
  assert.equal(cellTitle(4211, ROW, "empty"), "Cell 4211");
  assert.equal(cellTitle(4211, ROW, "blank"), "Cell 4211");
});

test("cellTitle: a number or a boolean IS a usable title", () => {
  // An accession number or a year is a legitimate title, and String() is non-empty for
  // both — so excluding them would fall back for no reason.
  assert.equal(cellTitle(4211, ROW, "year"), "1642");
  assert.equal(cellTitle(4211, ROW, "flag"), "false");
});

// --- columnLabel / isColumnHidden / isUrlColumn ----------------------------------

test("columnLabel: declared label wins; absent entry and absent map both give the raw name", () => {
  assert.equal(columnLabel("artist", { artist: { label: "Artist" } }), "Artist");
  assert.equal(columnLabel("artist", { other: { label: "Other" } }), "artist");
  assert.equal(columnLabel("artist", undefined), "artist");
});

test("columnLabel: a blank label is not a label — the raw name is better than nothing", () => {
  assert.equal(columnLabel("artist", { artist: { label: "   " } }), "artist");
});

test("isColumnHidden: only an explicit true hides; absent and false show", () => {
  assert.equal(isColumnHidden("x", { x: { hidden: true } }), true);
  assert.equal(isColumnHidden("x", { x: { hidden: false } }), false);
  assert.equal(isColumnHidden("x", { x: { label: "X" } }), false);
  assert.equal(isColumnHidden("x", undefined), false);
});

test("isUrlColumn: only `render: url` is a link", () => {
  assert.equal(isUrlColumn("x", { x: { render: "url" } }), true);
  assert.equal(isUrlColumn("x", { x: { label: "X" } }), false);
  assert.equal(isUrlColumn("x", undefined), false);
});

// --- layoutsWithLabels ----------------------------------------------------------

const LAYOUTS: LayoutInfo[] = [
  { layout_id: "grid", label: "Grid", type: "grid" },
  { layout_id: "datetime", label: "Datetime", type: "datetime" },
];

test("layoutsWithLabels: an override replaces one label and leaves the others alone", () => {
  const out = layoutsWithLabels(LAYOUTS, { datetime: { label: "By date" } });
  assert.deepEqual(
    out.map((l) => l.label),
    ["Grid", "By date"],
  );
  assert.deepEqual(
    out.map((l) => l.layout_id),
    ["grid", "datetime"],
    "ids and order stay the bake's — they are what the renderer keys off",
  );
});

test("layoutsWithLabels: a dangling override adds no entry", () => {
  const out = layoutsWithLabels(LAYOUTS, { removed_by_a_rebake: { label: "Ghost" } });
  assert.equal(out.length, 2);
  assert.equal(
    out.some((l) => l.label === "Ghost"),
    false,
  );
});

test("layoutsWithLabels: no overrides returns the SAME array identity", () => {
  // Not cosmetic: `layouts` is a dependency of the cockpit's measure effect, so a fresh
  // array every render would re-measure on every render for a collection that declared
  // nothing.
  assert.strictEqual(layoutsWithLabels(LAYOUTS, undefined), LAYOUTS);
  assert.strictEqual(layoutsWithLabels(LAYOUTS, {}), LAYOUTS);
  assert.strictEqual(layoutsWithLabels(LAYOUTS, { grid: { label: "Grid" } }), LAYOUTS, "a no-op override too");
});

// --- coercePresentation ---------------------------------------------------------

test("coercePresentation: a well-formed record survives whole", () => {
  const body = {
    presentation_version: "1.0",
    dataset: { display_name: "Rijks", default_layout: "artist", title_column: "object_title" },
    layouts: { artist: { label: "By artist" } },
    columns: { object_url: { label: "Source", render: "url" }, internal: { hidden: true } },
  };
  assert.deepEqual(coercePresentation(body), body);
});

test("coercePresentation: anything that is not an object is an ABSENT record", () => {
  for (const body of [null, undefined, 42, "nope", [], true]) {
    assert.deepEqual(coercePresentation(body), {}, `for ${JSON.stringify(body) ?? "undefined"}`);
  }
});

test("coercePresentation: one malformed entry does not cost the user the rest", () => {
  // Per-key rather than all-or-nothing: a bad `columns` entry must not throw away a
  // perfectly good default_layout.
  const out = coercePresentation({
    dataset: { default_layout: "artist", title_column: 7 },
    columns: { good: { render: "url" }, bad: "not an object", alsoBad: { render: "email" } },
    layouts: { good: { label: "Good" }, bad: { label: 5 } },
  });
  assert.deepEqual(out.dataset, { default_layout: "artist" });
  assert.deepEqual(out.columns, { good: { render: "url" } });
  assert.deepEqual(out.layouts, { good: { label: "Good" } });
});

test("coercePresentation: an unknown render kind degrades to plain text, not to a link", () => {
  // A newer API serving `render: "image"` must not make an old client draw an anchor
  // around a value it was never told how to render.
  assert.deepEqual(coercePresentation({ columns: { c: { render: "image" } } }), {});
});

test("coercePresentation: empty maps are dropped, so absent stays absent", () => {
  assert.deepEqual(coercePresentation({ dataset: {}, layouts: {}, columns: {} }), {});
});

// --- the client read never rejects ----------------------------------------------

function withFetch(impl: typeof globalThis.fetch, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = real;
  });
}

test("getPresentation resolves to {} on a 404 — an absent record is not an error", async () => {
  await withFetch(
    (async () => new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } })) as typeof globalThis.fetch,
    async () => {
      const client = createApiClient("http://x");
      assert.deepEqual(await client.getPresentation("ds"), {});
    },
  );
});

test("getPresentation resolves to {} when the network is down", async () => {
  await withFetch(
    (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof globalThis.fetch,
    async () => {
      const client = createApiClient("http://x");
      assert.deepEqual(await client.getPresentation("ds"), {});
    },
  );
});

test("getPresentation returns the narrowed record on a 200", async () => {
  await withFetch(
    (async (url: string) => {
      assert.equal(url, "http://x/api/datasets/ds/presentation");
      return new Response(JSON.stringify({ dataset: { default_layout: "artist" }, junk: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
    async () => {
      const client = createApiClient("http://x");
      assert.deepEqual(await client.getPresentation("ds"), { dataset: { default_layout: "artist" } });
    },
  );
});
