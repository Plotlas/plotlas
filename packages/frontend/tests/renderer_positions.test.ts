// T2-66 / T2-48 (v2.2): pick-at-any-zoom via the per-layout position table.
//   * parsePositionsTable turns the (x,y,w,h) Arrow body (row index == dense id, no
//     id column) into flat typed arrays;
//   * hitTestPositionTable resolves a world point to a cell id with the SAME overlap
//     semantics as the fine-tier hitTestCells (nearest centre wins; ties -> higher id);
//   * cells.pick() falls back to a registered coarse scan when NO fine cell is under
//     the point (the coarse/overview case where only mosaic quads are drawn — the T2-66
//     cure), and returns the fine-tier hit when there IS one;
//   * the LayoutController loads the table on activate + registers the fallback, a
//     dataset/layout with NO positions_ref registers no fallback (graceful absence),
//     and a layout SWITCH re-points the fallback (release-on-switch) — single-flight.
//
// GL-free: createStubWorld + createCells is the same real-Cells harness
// renderer_transition.test.ts uses; the controller runs over a fake client + stub
// pyramid.
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Float32, vectorFromArray, tableToIPC, tableFromIPC } from "apache-arrow";

import {
  createCells,
  parsePositionsTable,
  hitTestPositionTable,
} from "../src/renderer/cells.ts";
import type { PositionTable } from "../src/renderer/cells.ts";
import { createLayoutController } from "../src/renderer/layout.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import {
  createFakeClient,
  createStubCells,
  createStubPyramid,
  createStubWorld,
} from "./fake_client.ts";

// --- pure parse + hit-test -------------------------------------------------

/** Build a position table exactly as the producer writes it (four float32 columns,
 *  NO id column — row index is the dense id) and round-trip it through Arrow IPC so
 *  the parse path is identical to the real static asset. */
function positionsTable(cells: { x: number; y: number; w: number; h: number }[]): Table {
  const f32 = (a: number[]) => vectorFromArray(a, new Float32());
  return new Table({
    x: f32(cells.map((c) => c.x)),
    y: f32(cells.map((c) => c.y)),
    w: f32(cells.map((c) => c.w)),
    h: f32(cells.map((c) => c.h)),
  });
}

function parseOf(cells: { x: number; y: number; w: number; h: number }[]): PositionTable {
  return parsePositionsTable(positionsTable(cells));
}

test("parsePositionsTable reads (x,y,w,h) into id-indexed typed arrays; no id column", () => {
  const table = parseOf([
    { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    { x: 0.8, y: 0.8, w: 0.1, h: 0.1 },
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  ]);
  assert.equal(table.count, 3);
  assert.equal(table.x.length, 3);
  // Row index IS the id: table.x[2] is cell id 2's centre.
  assert.ok(Math.abs(table.x[2] - 0.5) < 1e-6);
  assert.ok(Math.abs(table.h[1] - 0.1) < 1e-6);
});

test("parsePositionsTable throws on a malformed table (missing column)", () => {
  const f32 = (a: number[]) => vectorFromArray(a, new Float32());
  const missingH = new Table({ x: f32([0.1]), y: f32([0.1]), w: f32([0.1]) });
  assert.throws(() => parsePositionsTable(missingH), /missing the 'h' column/);
});

test("hitTestPositionTable: hit inside a rect returns its id; a miss returns null", () => {
  const t = parseOf([
    { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // id 0 spans [0.15,0.25]^2
    { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, // id 1 spans [0.75,0.85]^2
  ]);
  assert.equal(hitTestPositionTable(0.2, 0.2, t), 0);
  assert.equal(hitTestPositionTable(0.8, 0.8, t), 1);
  assert.equal(hitTestPositionTable(0.5, 0.5, t), null, "gap between cells is a miss");
  assert.equal(hitTestPositionTable(0.24, 0.16, t), 0, "inside id 0's AABB corner");
});

test("hitTestPositionTable overlap: nearest centre wins; ties break to the higher id", () => {
  // Two overlapping cells; the point is inside BOTH. The nearer centre wins.
  const overlap = parseOf([
    { x: 0.4, y: 0.4, w: 0.4, h: 0.4 }, // id 0 spans [0.2,0.6]^2, centre 0.4
    { x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, // id 1 spans [0.3,0.7]^2, centre 0.5
  ]);
  assert.equal(hitTestPositionTable(0.5, 0.5, overlap), 1, "point at id 1's centre -> id 1");
  assert.equal(hitTestPositionTable(0.35, 0.35, overlap), 0, "point nearer id 0's centre -> id 0");

  // Exactly-coincident cells (same centre + size): the tie breaks to the HIGHER id,
  // matching the fine-tier hitTestCells 'topmost' rule.
  const coincident = parseOf([
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, // id 0
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, // id 1 (identical) -> wins the tie
  ]);
  assert.equal(hitTestPositionTable(0.5, 0.5, coincident), 1, "coincident tie -> higher id");
});

// CHARACTERIZATION, not a regression pin. It documents that the scan itself is
// size-blind, but it cannot fail against the floor T2-204 removed: that floor lived in
// the CALLER (layout.ts multiplied ~3 CSS px by the camera zoom) and the old signature
// defaulted `minWorldSize = 0`, so pre-change code satisfies every assertion here. The
// pin that actually carries T2-204 is the controller-level one further down, which
// drives cells.pick through the registered fallback.
test("hitTestPositionTable is size-blind: a sub-pixel cell hits (characterization)", () => {
  const t = parseOf([
    { x: 0.2, y: 0.2, w: 0.001, h: 0.001 }, // id 0 — far below any plausible px floor
    { x: 0.8, y: 0.8, w: 0.3, h: 0.05 }, // id 1 — a thin bar
  ]);
  assert.equal(hitTestPositionTable(0.2, 0.2, t), 0, "tiny cell is pickable, like the fine tier");
  assert.equal(hitTestPositionTable(0.8, 0.8, t), 1, "a thin cell is pickable");
  assert.equal(hitTestPositionTable(0.5, 0.5, t), null, "a genuine gap is still a miss");
});

// --- cells.pick() fallback (the T2-66 integration) -------------------------

test("cells.pick falls back to the position table when NO fine cell is under the point", () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  // screen coords == world coords (center 0, zoom 1, 0-size viewport).
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  // The whole layout's rects, but NO fine cells resident (the zoomed-out/coarse case:
  // the loader has drawn only mosaic overview quads, so cells has no per-cell geometry).
  const table = parseOf([
    { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // id 0
    { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, // id 1
  ]);
  // Before a fallback is registered, a coarse-view pick misses (pre-2.2 behaviour).
  assert.equal(cells.pick(0.2, 0.2).cellId, null, "no fine cells + no fallback -> miss");

  cells.setCoarsePickFallback((wx, wy) => hitTestPositionTable(wx, wy, table));
  assert.equal(cells.pick(0.2, 0.2).cellId, 0, "coarse pick resolves via the position table");
  assert.equal(cells.pick(0.8, 0.8).cellId, 1);
  assert.equal(cells.pick(0.5, 0.5).cellId, null, "still a miss where no cell is");

  // Clearing the fallback restores fine-tier-only picking (graceful absence).
  cells.setCoarsePickFallback(null);
  assert.equal(cells.pick(0.2, 0.2).cellId, null, "fallback cleared -> fine-tier-only miss");
  cells.dispose();
});

test("a resident fine cell wins over the position-table fallback (fine tier is authoritative)", () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  // A fine cell id 5 resident at (0.2,0.2)...
  cells.setBuffers({
    ids: BigInt64Array.from([5n]),
    positions: Float32Array.from([0.2, 0.2]),
    sizes: Float32Array.from([0.1, 0.1]),
    atlasPage: Int32Array.from([0]),
    atlasUv: Float32Array.from([0, 0, 1, 1]),
    lod: Int8Array.from([0]),
    count: 1,
  });
  // ...and a position table that would resolve the SAME point to a different id.
  const table = parseOf(
    Array.from({ length: 6 }, (_v, i) => ({ x: i === 0 ? 0.2 : 0.9, y: 0.2, w: 0.1, h: 0.1 })),
  );
  cells.setCoarsePickFallback((wx, wy) => hitTestPositionTable(wx, wy, table));

  // The fine-tier hit (id 5) wins; the fallback is only consulted on a fine MISS.
  assert.equal(cells.pick(0.2, 0.2).cellId, 5, "resident fine cell wins over the table");
  cells.dispose();
});

// --- controller: load + register + graceful absence + release-on-switch ----

/** A fake client over the golden fixture with a two-layout manifest (grid + alt),
 *  each optionally declaring a positions_ref. `has(layoutId)` is false ⇒ that layout
 *  declares NO positions_ref (graceful absence). fetchPositions serves an in-memory
 *  table keyed by the layout id parsed from the URL; onFetch records each fetch. */
function positionsClient(opts: {
  gridHasRef?: boolean; // default true
  onFetch?: (layoutId: string) => void;
} = {}): ReturnType<typeof createFakeClient> {
  const gridHasRef = opts.gridHasRef ?? true;
  const gridTable = tableToIPC(
    positionsTable([
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // grid id 0
      { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, // grid id 1
    ]),
    "stream",
  );
  const altTable = tableToIPC(
    positionsTable([
      { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, // alt id 0 (swapped vs grid)
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // alt id 1
    ]),
    "stream",
  );
  // A two-layout manifest (grid + alt) so switchTo has a target.
  const base = createFakeClient(undefined, {
    doctorManifest: (m: LayoutManifest): LayoutManifest => ({
      ...m,
      layouts: [...m.layouts, { ...m.layouts[0], layout_id: "alt", label: "Alt" }],
    }),
  });
  return {
    ...base,
    positionsUrl(_dsId: string, layoutId: string): string | null {
      if (layoutId === "grid" && !gridHasRef) return null; // graceful absence
      return `pos://${layoutId}`; // a synthetic url carrying the layout id
    },
    async fetchPositions(url: string): Promise<Table> {
      const layoutId = url.slice("pos://".length);
      opts.onFetch?.(layoutId);
      return tableFromIPC(layoutId === "grid" ? gridTable : altTable);
    },
  };
}

/** Await microtasks so the controller's fire-and-forget ensurePositions settles. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("controller loads the position table on activate and registers the coarse-pick fallback", async () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  // zoom 0.01 world/px: screen (20,20) -> world (0.2,0.2), where a 0.1-world cell is.
  emit({ center: [0, 0], zoom: 0.01 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const fetched: string[] = [];
  const client = positionsClient({ onFetch: (id) => fetched.push(id) });
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  await controller.activate("grid");
  await flush(); // ensurePositions is fire-and-forget

  assert.deepEqual(fetched, ["grid"], "the grid position table was fetched once");
  // With NO fine cells resident, a coarse pick now resolves via the registered table.
  assert.equal(cells.pick(20, 20).cellId, 0, "grid table: world (0.2,0.2) -> id 0");
  assert.equal(cells.pick(80, 80).cellId, 1);
  cells.dispose();
});

// T2-204 regression pin. The fallback the CONTROLLER registers used to multiply a
// ~3 CSS px floor by the camera zoom, so a cell that drew smaller than that was a
// deliberate miss. At zoom 1 world/px the 0.1-world cells below are 0.1 CSS px —
// 30x under the old floor — so this asserts on the registered fallback, the only
// place the floor ever lived (the pure hitTestPositionTable defaulted to none).
test("coarse pick has no floor: a sub-pixel cell is pickable at any zoom (T2-204)", async () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  // zoom 1 world/px + a 0-size viewport: screen coords == world coords.
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const client = positionsClient({});
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  await controller.activate("grid");
  await flush();

  assert.equal(cells.pick(0.2, 0.2).cellId, 0, "0.1 CSS px cell still resolves");
  assert.equal(cells.pick(0.8, 0.8).cellId, 1);
  assert.equal(cells.pick(0.5, 0.5).cellId, null, "a genuine gap is still a miss");

  // Zoom-INVARIANT: the same world point resolves the same cell at 0.01 world/px,
  // where that cell draws 10 CSS px. Only the aim changes, never the answer.
  emit({ center: [0, 0], zoom: 0.01 }, { width: 0, height: 0, devicePixelRatio: 1 });
  assert.equal(cells.pick(20, 20).cellId, 0, "same cell, zoomed in");
  cells.dispose();
});

// T2-204: countCellsInView memoizes on the view rect, because the status observable
// calls it on every coalesced emit and an unfloored pick makes hover emit constantly.
// The memo is keyed on the RECT ALONE, so it must be dropped when the position table
// changes — a layout switch preserves the camera, so an unmoved camera over a different
// layout is exactly the case a rect key cannot see. Grid and alt below have DIFFERENT
// counts in the same rect, so a surviving memo reports grid's answer for alt.
test("countCellsInView memo is invalidated by a layout switch (T2-204)", async () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  emit({ center: [0, 0], zoom: 0.01 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const gridIpc = tableToIPC(
    positionsTable([
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // inside the probe rect
      { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, // outside it
    ]),
    "stream",
  );
  const altIpc = tableToIPC(
    positionsTable([
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // BOTH inside the probe rect
      { x: 0.3, y: 0.3, w: 0.1, h: 0.1 },
    ]),
    "stream",
  );
  const base = createFakeClient(undefined, {
    doctorManifest: (m: LayoutManifest): LayoutManifest => ({
      ...m,
      layouts: [...m.layouts, { ...m.layouts[0], layout_id: "alt", label: "Alt" }],
    }),
  });
  const client = {
    ...base,
    positionsUrl: (_dsId: string, layoutId: string): string | null => `pos://${layoutId}`,
    fetchPositions: async (url: string): Promise<Table> =>
      tableFromIPC(url.endsWith("alt") ? altIpc : gridIpc),
  };

  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);
  await controller.activate("grid");
  await flush();

  const probe = { xMin: 0, yMin: 0, xMax: 0.5, yMax: 0.5 };
  assert.equal(controller.countCellsInView(probe), 1, "grid: one cell in the probe rect");
  assert.equal(controller.countCellsInView(probe), 1, "memo hit returns the same answer");

  await controller.switchTo("alt");
  await flush();
  assert.equal(controller.countCellsInView(probe), 2, "alt's count, not grid's memoized 1");
  cells.dispose();
});

test("no positions_ref => no fallback registered (graceful absence, fine-tier-only pick)", async () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  // Same zoom as the loaded-table test: screen (20,20) -> world (0.2,0.2), INSIDE
  // cell 0's rect — so the miss below is the absence of a fallback, not a bad aim.
  emit({ center: [0, 0], zoom: 0.01 }, { width: 0, height: 0, devicePixelRatio: 1 });

  let fetches = 0;
  // grid declares NO positions_ref (a pre-2.2 dataset).
  const client = positionsClient({ gridHasRef: false, onFetch: () => (fetches += 1) });
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  await controller.activate("grid");
  await flush();

  assert.equal(fetches, 0, "no positions_ref -> nothing fetched");
  // No fine cells + no fallback -> a coarse pick misses, exactly as pre-2.2.
  assert.equal(cells.pick(20, 20).cellId, null, "graceful absence: fine-tier-only picking");
  cells.dispose();
});

test("switchTo re-points the fallback to the target layout (release-on-switch)", async () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  emit({ center: [0, 0], zoom: 0.01 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const fetched: string[] = [];
  const client = positionsClient({ onFetch: (id) => fetched.push(id) });
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  await controller.activate("grid");
  await flush();
  assert.equal(cells.pick(20, 20).cellId, 0, "grid: world (0.2,0.2) -> id 0");

  // Switch to alt, whose table SWAPS the positions: world (0.2,0.2) is now id 1.
  await controller.switchTo("alt");
  await flush();
  assert.deepEqual(fetched, ["grid", "alt"], "each layout's table fetched once");
  assert.equal(cells.pick(20, 20).cellId, 1, "alt table now drives the fallback");
  assert.equal(cells.pick(80, 80).cellId, 0, "alt: world (0.8,0.8) -> id 0");
  cells.dispose();
});

test("a layout switch mid-Locate-pulse restores visibility (no stuck-dim on the new layout)", async () => {
  // Regression (T2-85 review C-1): pulseHighlight dims all-but-one via cells.visById,
  // relying on a timed restore. A switch cancels that timer — it must ALSO restore the
  // steady visibility, or the new layout's cells inherit the dim (setBuffers reads
  // visById on arrival) and render stuck-dimmed. Uses a very long pulse so ONLY the
  // switch can undo the dim (the pulse's own timer never fires during the test).
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  emit({ center: [0, 0], zoom: 0.01 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const applied: Uint8Array[] = [];
  const realSetVis = cells.setVisibility.bind(cells);
  cells.setVisibility = (v: Uint8Array): void => {
    applied.push(v.slice());
    realSetVis(v);
  };

  const client = positionsClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const count = manifest.dataset_metadata.image_count;
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  await controller.activate("grid");
  await flush();

  controller.pulseHighlight(0, 100_000); // long-lived: only the switch can undo it
  const dimmed = applied[applied.length - 1];
  assert.equal(dimmed[0], 1, "pulse: the located cell stays bright");
  assert.ok([...dimmed].some((b) => b === 0), "pulse: the other cells are dimmed");

  await controller.switchTo("alt");
  await flush();

  const final = applied[applied.length - 1];
  assert.equal(final.length, count, "the restore is sized over the dense id space");
  for (let i = 0; i < count; i++) assert.equal(final[i], 1, `cell ${i} visible after the switch`);
  cells.dispose();
});

