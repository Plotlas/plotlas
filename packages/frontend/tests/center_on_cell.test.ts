// T2-54 / T2-67 / T2-71: centerOnCell + fit-view math + the D-B auto-fit rule.
//   * cameraForCell (pure): a cell rect → camera {center, zoom} so the cell spans ~a
//     fraction of the viewport;
//   * fitCamera (pure): a layout bbox → camera that fits it letterboxed;
//   * shouldAutoFit (pure): the D-B rule (zero in-view ⇒ fit, else hold, null ⇒ hold);
//   * the controller's centerOnCell / cellRect / countCellsInView / pulseHighlight over
//     a resident position table, incl. the graceful-absence fallbacks (no world / no
//     table ⇒ centerOnCell returns false, cellRect/countCellsInView null).
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Float32, vectorFromArray, tableToIPC, tableFromIPC } from "apache-arrow";

import { cameraForCell, fitCamera } from "../src/renderer/world.ts";
import type { CameraState, Viewport, WorldHandle } from "../src/renderer/world.ts";
import { createCells } from "../src/renderer/cells.ts";
import { createLayoutController, shouldAutoFit } from "../src/renderer/layout.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import { createFakeClient, createStubPyramid, createStubWorld } from "./fake_client.ts";

const VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };

// ---------------------------------------------------------------------------
// cameraForCell (pure)
// ---------------------------------------------------------------------------

test("cameraForCell centres the cell and zooms so it spans ~1/3 of the viewport", () => {
  // A cell of world width 0.1 in a 100px viewport, target fraction 1/3.
  const rect = { xMin: 0.45, yMin: 0.45, xMax: 0.55, yMax: 0.55 };
  const cam = cameraForCell(rect, VIEWPORT, 1 / 3);
  assert.deepEqual(cam.center, [0.5, 0.5], "centred on the cell");
  // zoom = cellEdge / (fraction * viewportEdge) = 0.1 / ((1/3)*100) = 0.003
  assert.ok(Math.abs(cam.zoom - 0.003) < 1e-9, `zoom ${cam.zoom} ≈ 0.003`);
  // Sanity: the cell's on-screen size = cellEdge / zoom = 0.1 / 0.003 ≈ 33px ≈ 1/3 of 100.
  assert.ok(Math.abs(0.1 / cam.zoom - 100 / 3) < 1e-6);
});

test("cameraForCell takes the larger zoom of the two axes so the whole cell fits", () => {
  // A tall, thin cell: height (0.2) binds over width (0.05).
  const rect = { xMin: 0.475, yMin: 0.4, xMax: 0.525, yMax: 0.6 };
  const cam = cameraForCell(rect, VIEWPORT, 1 / 3);
  const zx = 0.05 / ((1 / 3) * 100);
  const zy = 0.2 / ((1 / 3) * 100);
  assert.ok(Math.abs(cam.zoom - Math.max(zx, zy)) < 1e-9, "the taller axis binds the zoom");
});

test("cameraForCell falls back to the whole-world fit zoom for a zero-size cell", () => {
  const rect = { xMin: 0.3, yMin: 0.3, xMax: 0.3, yMax: 0.3 };
  const cam = cameraForCell(rect, VIEWPORT, 1 / 3);
  assert.deepEqual(cam.center, [0.3, 0.3]);
  assert.ok(cam.zoom > 0, "a finite fit zoom, not NaN/Infinity");
});

// ---------------------------------------------------------------------------
// fitCamera (pure)
// ---------------------------------------------------------------------------

test("fitCamera fits a layout bbox to the viewport, letterboxed, with a small pad", () => {
  // A bbox covering the left half of the world in a square viewport.
  const rect = { xMin: 0, yMin: 0, xMax: 0.5, yMax: 1 };
  const cam = fitCamera(rect, VIEWPORT, 0); // no pad for a clean assertion
  assert.deepEqual(cam.center, [0.25, 0.5]);
  // The binding (taller) axis is y (extent 1.0): zoom = 1.0 / 100 = 0.01.
  assert.ok(Math.abs(cam.zoom - 0.01) < 1e-9, `zoom ${cam.zoom} ≈ 0.01`);
});

test("fitCamera pad grows the fitted extent (zooms out slightly)", () => {
  const rect = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const noPad = fitCamera(rect, VIEWPORT, 0);
  const padded = fitCamera(rect, VIEWPORT, 0.1);
  assert.ok(padded.zoom > noPad.zoom, "padding needs more world per px (a larger zoom value)");
});

// ---------------------------------------------------------------------------
// shouldAutoFit (the D-B rule)
// ---------------------------------------------------------------------------

test("shouldAutoFit: zero in-view ⇒ fit; nonzero ⇒ hold; null (no table) ⇒ hold", () => {
  assert.equal(shouldAutoFit(0), true, "stranded in empty space → fit");
  assert.equal(shouldAutoFit(1), false, "a cell in view → hold (compare across layouts)");
  assert.equal(shouldAutoFit(500), false);
  assert.equal(shouldAutoFit(null), false, "can't tell (no table) → hold, manual fit remains");
});

// ---------------------------------------------------------------------------
// controller centerOnCell / cellRect / countCellsInView / pulseHighlight
// ---------------------------------------------------------------------------

function positionsTable(cells: { x: number; y: number; w: number; h: number }[]): Table {
  const f32 = (a: number[]) => vectorFromArray(a, new Float32());
  return new Table({
    x: f32(cells.map((c) => c.x)),
    y: f32(cells.map((c) => c.y)),
    w: f32(cells.map((c) => c.w)),
    h: f32(cells.map((c) => c.h)),
  });
}

/** A fake client whose grid layout serves a two-cell position table. */
function positionsClient(gridHasRef = true): ReturnType<typeof createFakeClient> {
  const gridTable = tableToIPC(
    positionsTable([
      { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, // id 0
      { x: 0.8, y: 0.8, w: 0.1, h: 0.1 }, // id 1
    ]),
    "stream",
  );
  const base = createFakeClient();
  return {
    ...base,
    positionsUrl(_dsId: string, layoutId: string): string | null {
      if (layoutId === "grid" && !gridHasRef) return null;
      return `pos://${layoutId}`;
    },
    async fetchPositions(): Promise<Table> {
      return tableFromIPC(gridTable);
    },
  };
}

/** A world stub that RECORDS setCameraState + serves a fixed viewport, for the
 *  centerOnCell camera-drive assertion (createStubWorld lacks these methods). */
function recordingWorld(): { world: WorldHandle; sets: Partial<CameraState>[] } {
  const sets: Partial<CameraState>[] = [];
  const world = {
    scene: { add() {}, remove() {} },
    camera: {},
    renderer: { domElement: { addEventListener() {}, removeEventListener() {} } },
    maxTextureSize: 4096,
    resize() {},
    onCameraChange() {
      return () => {};
    },
    start() {},
    dispose() {},
    onDispose() {},
    haltRenderLoop() {},
    resumeRenderLoop() {},
    getViewport(): Viewport {
      return VIEWPORT;
    },
    getCameraState(): CameraState {
      return { center: [0.5, 0.5], zoom: 0.01 };
    },
    setCameraState(partial: Partial<CameraState>): void {
      sets.push(partial);
    },
  } as unknown as WorldHandle;
  return { world, sets };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("centerOnCell drives the camera to the cell's rect (reads the position table)", async () => {
  const { world: stubWorld, emit } = createStubWorld();
  const cells = createCells(stubWorld);
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const { world, sets } = recordingWorld();
  const client = positionsClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client, world);
  await controller.activate("grid");
  await flush();

  // cellRect reads the table (float32 storage → assert with tolerance).
  const r1 = controller.cellRect(1);
  assert.ok(r1 !== null, "cellRect(1) resolved");
  assert.ok(Math.abs(r1.x - 0.8) < 1e-6 && Math.abs(r1.y - 0.8) < 1e-6);
  assert.ok(Math.abs(r1.w - 0.1) < 1e-6 && Math.abs(r1.h - 0.1) < 1e-6);
  assert.equal(controller.cellRect(99), null, "out of range → null");

  const ok = controller.centerOnCell(1);
  assert.equal(ok, true, "centered (world + table present)");
  assert.equal(sets.length, 1, "the camera was set once");
  const center = sets[0].center as [number, number];
  assert.ok(Math.abs(center[0] - 0.8) < 1e-6 && Math.abs(center[1] - 0.8) < 1e-6, "centred on cell 1");
  // zoom = cellEdge / ((1/3)*viewportEdge) = 0.1 / ((1/3)*100) = 0.003
  assert.ok(Math.abs((sets[0].zoom as number) - 0.003) < 1e-6);
  cells.dispose();
});

test("centerOnCell degrades to false when no world handle is wired (graceful absence)", async () => {
  const { world: stubWorld, emit } = createStubWorld();
  const cells = createCells(stubWorld);
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const client = positionsClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  // NO world (3-arg controller) — centerOnCell can't drive the camera.
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);
  await controller.activate("grid");
  await flush();

  assert.equal(controller.centerOnCell(0), false, "no world → false, caller falls back");
  cells.dispose();
});

test("centerOnCell degrades to false with no position table (pre-2.2 layout)", async () => {
  const { world: stubWorld, emit } = createStubWorld();
  const cells = createCells(stubWorld);
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const { world, sets } = recordingWorld();
  const client = positionsClient(false); // grid declares NO positions_ref
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client, world);
  await controller.activate("grid");
  await flush();

  assert.equal(controller.cellRect(0), null, "no table → cellRect null");
  assert.equal(controller.countCellsInView({ xMin: 0, yMin: 0, xMax: 1, yMax: 1 }), null);
  assert.equal(controller.centerOnCell(0), false, "no table → false");
  assert.equal(sets.length, 0, "camera never touched");
  cells.dispose();
});

test("countCellsInView returns the overlap count against the resident table", async () => {
  const { world: stubWorld, emit } = createStubWorld();
  const cells = createCells(stubWorld);
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  const { world } = recordingWorld();
  const client = positionsClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(cells, createStubPyramid(manifest), client, world);
  await controller.activate("grid");
  await flush();

  // Whole world: both cells; lower-left quadrant: only id 0 (at 0.2,0.2).
  assert.equal(controller.countCellsInView({ xMin: 0, yMin: 0, xMax: 1, yMax: 1 }), 2);
  assert.equal(controller.countCellsInView({ xMin: 0, yMin: 0, xMax: 0.5, yMax: 0.5 }), 1);
  assert.equal(controller.countCellsInView({ xMin: 0.4, yMin: 0.4, xMax: 0.6, yMax: 0.6 }), 0);
  cells.dispose();
});

test("pulseHighlight emphasizes one cell then restores; reuses the visibility path", async () => {
  const { world: stubWorld, emit } = createStubWorld();
  const cells = createCells(stubWorld);
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });

  // Record setVisibility calls by wrapping the real cells' method.
  const vis: Uint8Array[] = [];
  const realSetVis = cells.setVisibility.bind(cells);
  cells.setVisibility = (v: Uint8Array): void => {
    vis.push(v.slice());
    realSetVis(v);
  };

  const client = createFakeClient(); // golden fixture: image_count is small
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const count = manifest.dataset_metadata.image_count;
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);
  await controller.activate("grid");

  await new Promise<void>((resolve) => {
    controller.pulseHighlight(2, 20); // 20ms pulse
    setTimeout(resolve, 60); // wait past the restore
  });

  assert.ok(vis.length >= 2, "a pulse (emphasize) then a restore were applied");
  const pulse = vis[0];
  assert.equal(pulse.length, count, "sized over the dense id space");
  assert.equal(pulse[2], 1, "the located cell is emphasized (visible)");
  // Every other cell de-emphasized during the pulse.
  for (let i = 0; i < count; i++) if (i !== 2) assert.equal(pulse[i], 0, `cell ${i} dimmed`);
  // The restore (no tag selection) returns everything to visible.
  const restore = vis[vis.length - 1];
  for (let i = 0; i < count; i++) assert.equal(restore[i], 1, `cell ${i} restored visible`);
  cells.dispose();
});
