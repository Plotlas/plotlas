// Brief §3 test 3 — tag evaluation: the fixture tags/ sidecar loaded through
// the fake client; "or" and "and" selections produce the expected exact
// Uint8Array bytes (D-08: one byte per cell, evaluated O(n) per selection
// change); empty selection => all 1s; images-only dataset => no-op.
//
// Fixture ground truth (tests/fixtures/build_fixture.py): even ids carry
// tags [a, b]; odd ids carry [b, c]; 10 cells.
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Field, List, Utf8, Int64, vectorFromArray } from "apache-arrow";

import {
  createLayoutController,
  parseTagsTable,
  evaluateTagSelection,
  hasTag,
  countFor,
  bitsetFor,
} from "../src/renderer/layout.ts";
import type { TagSelection } from "../src/renderer/layout.ts";
import {
  GOLDEN_DATASET_IMAGES_ONLY_DIR,
  createFakeClient,
  createStubCells,
  createStubPyramid,
} from "./fake_client.ts";

const EVEN = Uint8Array.from([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
const ALL = Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
const NONE = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function sel(mode: "and" | "or", ...values: string[]): TagSelection {
  return { mode, selected: values.map((value) => ({ column: "tags", value })) };
}

const ODD = Uint8Array.from([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
const popcount = (a: Uint8Array): number => a.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);

// Reads the real fixture sidecar end-to-end (uncompressed Arrow per D-29) — this test is
// the regression guard that caught the LZ4 finding in the first place.
//
// T2-121 single-source: applyTags no longer routes the tag selection to the fine-tier
// shader dim (cells.setVisibility) — that dim is invisible at browsing zoom (the coarse
// mosaic quad can't mark cells; T2-120's root cause) AND would double-darken against the
// highlight overlay. The tag VISUAL now goes through the overlay (proven in
// highlight_overlay.test.ts, which owns the exact match/dim partition); here the
// end-to-end guard is the #168 honest match COUNT that applyTags returns, tied to the
// same fixture ground-truth byte arrays via popcount, PLUS the single-source invariant
// (no shader dim applied). This controller has no World → no overlay, so only the pure
// count/return path runs. The exact per-cell bytes remain proven in the
// evaluateTagSelection tests below.
test("fixture sidecar: applyTags reports the honest match count and applies NO shader dim (single source)", async () => {
  const client = createFakeClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const cells = createStubCells();
  const pyramid = createStubPyramid(manifest);
  const controller = createLayoutController(cells, pyramid, client);

  await controller.activate("grid"); // loads + parses the D-14 sidecar once
  assert.equal(pyramid.activations.length, 1);
  assert.deepEqual(pyramid.activations[0], {
    layoutId: "grid",
    frame: { xMin: 0.025, yMin: 0.175, xMax: 0.975, yMax: 0.825 },
  });

  const expectMatch = (selection: TagSelection, expected: Uint8Array) => {
    const state = controller.applyTags(selection);
    assert.deepEqual(state, { status: "ok", matched: popcount(expected), total: 10 });
  };

  expectMatch(sel("or", "a"), EVEN); // only even ids have 'a' → 5
  expectMatch(sel("or", "c"), ODD); // only odd ids have 'c' → 5
  expectMatch(sel("or", "a", "c"), ALL); // every cell has 'a' or 'c' → 10
  expectMatch(sel("and", "a", "b"), EVEN); // even ids have both → 5
  expectMatch(sel("and", "a", "c"), NONE); // no cell has both → 0
  expectMatch(sel("and", "b"), ALL); // everyone has 'b' → 10
  expectMatch(sel("or", "nope"), NONE); // unknown value matches nothing → 0
  expectMatch(sel("or"), ALL); // empty selection => all visible → 10
  expectMatch(sel("and"), ALL); // empty selection, any mode → 10

  // Single source (T2-121): the tag selection is NEVER pushed to the fine-tier shader
  // dim — cells.setVisibility is untouched by applyTags (the Locate pulse still uses it).
  assert.equal(cells.visibilityReceived.length, 0, "applyTags applies no shader dim (routes to the overlay)");
});

test("images-only dataset: applyTags is a no-op that keeps everything visible", async () => {
  const client = createFakeClient(GOLDEN_DATASET_IMAGES_ONLY_DIR);
  const manifest = await client.getManifest("golden_dataset_images_only_v2", "grid");
  assert.equal(manifest.tags, undefined); // the fixture's no-metadata variant
  const cells = createStubCells();
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  await controller.activate("grid");
  controller.applyTags(sel("or", "a"));
  controller.applyTags(sel("and", "a", "b"));
  assert.equal(cells.visibilityReceived.length, 0, "no visibility buffer may be uploaded");
});

// ---------------------------------------------------------------------------
// T2-43 — columnar bitset representation (replaces per-cell heap Sets).
// A small in-memory Arrow tags table (one list<string> "tags" column, mirroring
// the sidecar shape) exercises: a multi-valued cell, an empty-list cell, and a
// genuine null cell — all of which the bitsets must handle. cellCount is larger
// than numRows to prove the dense id space (and byte-length rounding) is sized on
// the manifest's image_count, not the row count.
// ---------------------------------------------------------------------------

/** Build a tags table exactly as the fixture builder does (id int64 + one
 *  list<string> column), so the parse path is identical to the real sidecar. */
function tagsTable(rows: { id: number; tags: string[] | null }[]): Table {
  const idVec = vectorFromArray(rows.map((r) => BigInt(r.id)), new Int64());
  const listType = new List(new Field("item", new Utf8(), true));
  const tagVec = vectorFromArray(rows.map((r) => r.tags), listType);
  return new Table({ id: idVec, tags: tagVec });
}

test("parseTagsTable builds per-value bitsets over dense ids (multi-valued, empty, null cells)", () => {
  // ids 0,2,4,6,8 carry [a,b] (with a duplicate 'a' on id 4 → idempotent set);
  // id 1 is an empty list, id 3 is a null cell, ids 5,7,9 carry [c].
  const table = tagsTable([
    { id: 0, tags: ["a", "b"] },
    { id: 1, tags: [] },
    { id: 2, tags: ["a", "b"] },
    { id: 3, tags: null },
    { id: 4, tags: ["a", "a", "b"] }, // duplicate value
    { id: 5, tags: ["c"] },
    { id: 6, tags: ["a", "b"] },
    { id: 7, tags: ["c"] },
    { id: 8, tags: ["a", "b"] },
    { id: 9, tags: ["c"] },
  ]);
  const cellCount = 12; // > numRows: ids 10,11 have no bits; byteLen = ceil(12/8) = 2
  const tags = parseTagsTable(table, ["tags"], cellCount);

  assert.equal(tags.cellCount, cellCount);
  const values = tags.bitsets.get("tags");
  assert.ok(values !== undefined, "the 'tags' column must be present");
  assert.deepEqual([...values.keys()].sort(), ["a", "b", "c"]);
  // ceil(12/8) = 2 bytes per value bitset.
  assert.equal(bitsetFor(tags, "tags", "a")?.length, 2);

  // countFor is the population count — the columnar analogue of chip counts.
  assert.equal(countFor(tags, "tags", "a"), 5); // ids 0,2,4,6,8 (duplicate on 4 counts once)
  assert.equal(countFor(tags, "tags", "b"), 5);
  assert.equal(countFor(tags, "tags", "c"), 3); // ids 5,7,9
  assert.equal(countFor(tags, "tags", "nope"), 0); // unknown value

  // hasTag per cell, incl. the empty/null cells and out-of-range ids.
  assert.equal(hasTag(tags, 0, "tags", "a"), true);
  assert.equal(hasTag(tags, 4, "tags", "a"), true); // duplicate collapsed to one bit
  assert.equal(hasTag(tags, 1, "tags", "a"), false); // empty-list cell
  assert.equal(hasTag(tags, 3, "tags", "a"), false); // null cell
  assert.equal(hasTag(tags, 5, "tags", "c"), true);
  assert.equal(hasTag(tags, 10, "tags", "a"), false); // beyond numRows, within cellCount
  assert.equal(hasTag(tags, 99, "tags", "a"), false); // out of the dense id space
  assert.equal(hasTag(tags, 0, "tags", "nope"), false); // unknown value
  assert.equal(hasTag(tags, 0, "nocol", "a"), false); // unknown column
});

test("evaluateTagSelection over bitsets: or unions, and intersects, unknowns match nothing", () => {
  const table = tagsTable([
    { id: 0, tags: ["a", "b"] },
    { id: 1, tags: [] }, // empty cell — never highlighted by a value
    { id: 2, tags: ["a", "b"] },
    { id: 3, tags: null }, // null cell — same
    { id: 4, tags: ["c"] },
  ]);
  const cellCount = 5;
  const tags = parseTagsTable(table, ["tags"], cellCount);
  const bytes = (s: TagSelection) => Array.from(evaluateTagSelection(tags, s, cellCount));

  // Empty selection => all visible (any mode).
  assert.deepEqual(bytes(sel("or")), [1, 1, 1, 1, 1]);
  assert.deepEqual(bytes(sel("and")), [1, 1, 1, 1, 1]);
  // 'or a' → ids 0,2 only (empty/null cells stay dim).
  assert.deepEqual(bytes(sel("or", "a")), [1, 0, 1, 0, 0]);
  // 'or a,c' → union: ids 0,2 (a) and 4 (c).
  assert.deepEqual(bytes(sel("or", "a", "c")), [1, 0, 1, 0, 1]);
  // 'and a,b' → intersection: ids 0,2 carry both.
  assert.deepEqual(bytes(sel("and", "a", "b")), [1, 0, 1, 0, 0]);
  // 'and a,c' → no cell carries both → nothing.
  assert.deepEqual(bytes(sel("and", "a", "c")), [0, 0, 0, 0, 0]);
  // Unknown value matches nothing, both modes.
  assert.deepEqual(bytes(sel("or", "nope")), [0, 0, 0, 0, 0]);
  assert.deepEqual(bytes(sel("and", "nope")), [0, 0, 0, 0, 0]);
});
