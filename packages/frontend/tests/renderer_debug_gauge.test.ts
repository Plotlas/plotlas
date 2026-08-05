// Stage 0 §0.3 debug instrument — the FIELD-OF-VIEW grey gauge (PR #58, follow-up
// to #57). `cells.countPlaceholderInView(bbox)` is the viewport-scoped companion
// to the all-buckets `placeholderCells` total: of the cells on the grey
// placeholder (cells in UN-textured buckets — the real-vs-placeholder signal, NOT
// uHasTex), how many have their layout `target` position inside the camera view rect.
//
// Unlike the rest of the debug surface (publishCellDebug / publishLodDebug are
// gated on vizDebugAvailable — false under the GL-free node runner, so the
// published `rendererDebug` fields are unobservable here), this method is a PURE,
// ungated read on the cells handle, so it is directly unit-testable. Locks the
// three behaviours that could silently regress: textured buckets are skipped, the
// bbox filter includes/excludes by `target` position, and a placeholder-bound
// (evicted/failed) bucket still counts as grey.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { createCells } from "../src/renderer/cells.ts";
import { createStubWorld } from "./fake_client.ts";

const realTexture = () => {
  const t = new THREE.DataTexture(new Uint8Array([10, 20, 30, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};

// One CellBuffers entry per cell from a compact {id,x,y,lod,page} list. Only id /
// position / lod / page matter to the gauge; size and uv are filler.
type Cell = { id: number; x: number; y: number; lod: number; page: number };
const buffersFor = (cells: Cell[]) => ({
  ids: BigInt64Array.from(cells.map((c) => BigInt(c.id))),
  positions: Float32Array.from(cells.flatMap((c) => [c.x, c.y])),
  sizes: Float32Array.from(cells.flatMap(() => [0.1, 0.1])),
  atlasPage: Int32Array.from(cells.map((c) => c.page)),
  atlasUv: Float32Array.from(cells.flatMap(() => [0, 0, 1, 1])),
  lod: Int8Array.from(cells.map((c) => c.lod)),
  count: cells.length,
});

test("countPlaceholderInView: counts only UN-textured cells whose target lies in the bbox", () => {
  const { world } = createStubWorld();
  const cells = createCells(world);

  const inView = cells.countPlaceholderInView;
  // The real handle must implement the (interface-optional) gauge; narrowing here
  // doubles as that assertion.
  if (inView === undefined) throw new Error("createCells must implement countPlaceholderInView");

  // Two LOD-0 atlas pages. Page 0: ids 0,1. Page 1: ids 2,3. Distinct positions
  // so the bbox filter is observable.
  cells.setBuffers(
    buffersFor([
      { id: 0, x: 0.25, y: 0.25, lod: 0, page: 0 },
      { id: 1, x: 0.75, y: 0.75, lod: 0, page: 0 },
      { id: 2, x: 0.25, y: 0.75, lod: 0, page: 1 },
      { id: 3, x: 0.9, y: 0.9, lod: 0, page: 1 },
    ]),
  );
  const unit = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

  // No real texture is bound yet, so every bucket is grey; all four cells sit in
  // the unit rect.
  assert.equal(inView(unit), 4, "all grey cells in view are counted");

  // A cell outside the rect is excluded (target-position filter).
  assert.equal(
    inView({ xMin: 0, xMax: 0.5, yMin: 0, yMax: 0.5 }),
    1,
    "only id0 (0.25,0.25) lies in the lower-left quadrant",
  );

  // Bind page "0:0" with a REAL texture: its two cells are no longer grey.
  cells.setAtlasTexture(0, 0, realTexture());
  assert.equal(inView(unit), 2, "the textured bucket is skipped; only the page-1 grey cells remain");

  // Tight rect over the upper-right quadrant: of the grey page-1 cells only id3
  // (0.9,0.9) qualifies — id2 (0.25,0.75) is out of the rect, and id1 (0.75,0.75)
  // IS in the rect but TEXTURED. Confirms the bbox filter and the textured-skip
  // compose correctly.
  assert.equal(inView({ xMin: 0.5, xMax: 1, yMin: 0.5, yMax: 1 }), 1, "bbox filter + textured-skip compose");

  // Re-bind page "0:0" with the PLACEHOLDER (the eviction/failure path): it reads
  // as grey again. The gauge keys on real-vs-placeholder (texturedPages), NOT
  // uHasTex (which is 1 even for the placeholder), so the page-0 cells return.
  cells.setAtlasTexture(0, 0, realTexture(), true);
  assert.equal(inView(unit), 4, "a placeholder-bound (evicted/failed) bucket counts as grey again");

  cells.dispose();
});

test("countPlaceholderInView: counts a big grey cell whose body overlaps the view even when its CENTRE is off-rect", () => {
  const { world } = createStubWorld();
  const cells = createCells(world);
  const inView = cells.countPlaceholderInView;
  if (inView === undefined) throw new Error("createCells must implement countPlaceholderInView");

  // One grey cell centred at (0.5,0.5) but LARGE (size 0.4 => half-extent 0.2,
  // quad [0.3,0.7]²). At deep zoom a single cell can dwarf the viewport, so its
  // body fills the screen while its centre falls outside a tiny view rect.
  cells.setBuffers({
    ids: BigInt64Array.from([0n]),
    positions: Float32Array.from([0.5, 0.5]),
    sizes: Float32Array.from([0.4, 0.4]),
    atlasPage: Int32Array.from([0]),
    atlasUv: Float32Array.from([0, 0, 1, 1]),
    lod: Int8Array.from([0]),
    count: 1,
  });

  // A view rect in the upper-left that does NOT contain the centre (0.5,0.5) but
  // DOES overlap the quad: rect xMax/yMax 0.35 >= quad xMin/yMin 0.3. A centre-in-
  // rect test would miss it (the old under-count); quad-overlap counts it.
  assert.equal(inView({ xMin: 0, xMax: 0.35, yMin: 0, yMax: 0.35 }), 1, "overlapping big grey cell is counted (centre off-rect)");
  // A rect that neither contains the centre NOR overlaps the quad sees nothing.
  assert.equal(inView({ xMin: 0, xMax: 0.25, yMin: 0, yMax: 0.25 }), 0, "a rect clear of the quad counts nothing");

  cells.dispose();
});
