// v2 (D-33): the PURE policy/geometry of the spatial tile-pyramid loader —
// level selection (slippy-map), visible-tile enumeration, the one parent-fallback
// rule, focal ordering, and LRU eviction choice. GL-free: imports only the pure
// exports of tilePyramid.ts (no World/Cells/PMTiles constructed).
import assert from "node:assert/strict";
import test from "node:test";

import {
  selectLevel,
  enumerateVisibleTiles,
  focalOrder,
  chooseEvictions,
  pyramidLevels,
  tileKey,
  tilePageId,
  bboxFromCamera,
  isAbortError,
  cacheCountForTilePx,
  MAX_PYRAMID_Z,
  MAX_DPR_FOR_LEVEL,
  TILE_CACHE_BUDGET_BYTES,
  MIN_TILE_CACHE,
} from "../src/renderer/tilePyramid.ts";
import type { BBox } from "../src/renderer/tilePyramid.ts";
import type { PyramidDescriptor } from "../src/renderer/layout.ts";

const WHOLE: BBox = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };

function pyramid(levels: number[], zCap: number, tilePx = 512): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/x/x_v1.pmtiles",
    tile_px: tilePx,
    thumb_px: 64,
    cap: 64,
    levels: levels.map((z) => ({ z, tile_count: 4 ** z })),
    z_cap: zCap,
  };
}

test("pyramidLevels returns the baked z list, coarsest first", () => {
  assert.deepEqual(pyramidLevels(pyramid([2, 0, 1], 0)), [0, 1, 2]);
});

test("selectLevel clamps to the coarsest level when zoomed all the way out", () => {
  const py = pyramid([0, 1, 2, 3], 0);
  // Huge zoom (world units per px): the whole world is tiny on screen → coarsest.
  assert.equal(selectLevel(py, WHOLE, 1), 0);
});

test("selectLevel clamps to the finest baked level when zoomed all the way in", () => {
  const py = pyramid([0, 1, 2, 3], 0);
  // Tiny zoom (many screen px per world unit) → wants the deepest level, clamped
  // to the finest the dataset baked (3).
  assert.equal(selectLevel(py, WHOLE, 1e-7), 3);
});

test("selectLevel picks a deeper level as the camera zooms in (exact levels)", () => {
  const py = pyramid([0, 1, 2, 3, 4, 5], 0, /* tile_px */ 512);
  // tile_px=512, worldEdge=1: 2^z ≈ worldEdge/(zoom*tile_px) = 1/(zoom*512).
  //   1/1024 → 1/((1/1024)*512) = 2 tiles → ceil(log2 2) = z1
  //   1/2048 → 4 tiles  → z2
  //   1/4096 → 8 tiles  → z3
  //   1/8192 → 16 tiles → z4
  assert.equal(selectLevel(py, WHOLE, 1 / 1024), 1, "1/1024 selects exactly z=1");
  assert.equal(selectLevel(py, WHOLE, 1 / 2048), 2, "1/2048 selects exactly z=2");
  assert.equal(selectLevel(py, WHOLE, 1 / 4096), 3, "1/4096 selects exactly z=3");
  assert.equal(selectLevel(py, WHOLE, 1 / 8192), 4, "1/8192 selects exactly z=4");
  // Strictly monotonic across that mid-zoom sweep (no plateau / inversion).
  const sweep = [1 / 1024, 1 / 2048, 1 / 4096, 1 / 8192].map((z) => selectLevel(py, WHOLE, z));
  for (let i = 1; i < sweep.length; i++) {
    assert.ok(sweep[i] > sweep[i - 1], `level strictly deepens at step ${i}: ${sweep.join(",")}`);
  }
});

test("selectLevel never returns a z the dataset did not bake (sparse levels)", () => {
  const py = pyramid([0, 2, 5], 0); // gaps at 1,3,4
  for (const zoom of [1, 0.1, 0.01, 1e-3, 1e-5, 1e-7]) {
    const z = selectLevel(py, WHOLE, zoom);
    assert.ok([0, 2, 5].includes(z), `selected ${z} must be a baked level for zoom ${zoom}`);
  }
});

test("selectLevel picks ONE level deeper at dpr=2 than dpr=1 for the same viewport (T2-45b)", () => {
  // The canvas renders at DEVICE resolution (world.ts setPixelRatio(dpr)), so on a
  // HiDPI display a texel-≈-CSS-px pick renders soft one level too coarse. Passing
  // dpr doubles the desired tile count (texel≈DEVICE-px), selecting one level deeper.
  const py = pyramid([0, 1, 2, 3, 4, 5], 0, /* tile_px */ 512);
  // 1/1024 at dpr=1 wants 2 tiles → z1; at dpr=2 wants 4 tiles → z2 (one deeper).
  assert.equal(selectLevel(py, WHOLE, 1 / 1024, 1), 1, "dpr=1 selects z=1");
  assert.equal(selectLevel(py, WHOLE, 1 / 1024, 2), 2, "dpr=2 selects one level deeper (z=2)");
  // Holds across the mid-zoom sweep: dpr=2 is exactly +1 level of the dpr=1 pick
  // (each dpr doubling is one octave of subdivision).
  for (const zoom of [1 / 1024, 1 / 2048, 1 / 4096]) {
    const z1 = selectLevel(py, WHOLE, zoom, 1);
    const z2 = selectLevel(py, WHOLE, zoom, 2);
    assert.equal(z2, z1 + 1, `dpr=2 is one level deeper than dpr=1 at zoom ${zoom} (${z2} vs ${z1})`);
  }
  // The default dpr (omitted) matches dpr=1 — a caller with no viewport is unchanged.
  assert.equal(selectLevel(py, WHOLE, 1 / 1024), selectLevel(py, WHOLE, 1 / 1024, 1), "default dpr == 1");
});

test("selectLevel clamps dpr at the cap: dpr=3 behaves as dpr=2 (bounds 3× fetch cost) (T2-45b)", () => {
  const py = pyramid([0, 1, 2, 3, 4, 5], 0, /* tile_px */ 512);
  assert.equal(MAX_DPR_FOR_LEVEL, 2, "the dpr factor is capped at 2");
  for (const zoom of [1 / 1024, 1 / 2048, 1 / 4096]) {
    const z2 = selectLevel(py, WHOLE, zoom, 2);
    assert.equal(selectLevel(py, WHOLE, zoom, 3), z2, `dpr=3 clamps to the dpr=2 pick at zoom ${zoom}`);
    assert.equal(selectLevel(py, WHOLE, zoom, 4), z2, `dpr=4 also clamps to the dpr=2 pick at zoom ${zoom}`);
  }
  // A degenerate dpr (0 / negative / non-finite) never fans out — it floors to 1.
  assert.equal(selectLevel(py, WHOLE, 1 / 1024, 0), selectLevel(py, WHOLE, 1 / 1024, 1), "dpr=0 floors to 1");
  assert.equal(
    selectLevel(py, WHOLE, 1 / 1024, Number.NaN),
    selectLevel(py, WHOLE, 1 / 1024, 1),
    "dpr=NaN floors to 1",
  );
});

test("enumerateVisibleTiles covers the whole world at z=0 (one tile)", () => {
  const refs = enumerateVisibleTiles("grid", WHOLE, 0, 0, WHOLE);
  assert.equal(refs.length, 1);
  assert.deepEqual({ z: refs[0].z, x: refs[0].x, y: refs[0].y }, { z: 0, x: 0, y: 0 });
  assert.equal(refs[0].fine, true, "z(0) >= z_cap(0) is fine");
});

test("enumerateVisibleTiles returns only the tiles overlapping the view (+1 margin)", () => {
  // z=3 → 8x8 tiles over [0,1]^2; view the top-left 1/8 quadrant only.
  const view: BBox = { xMin: 0, yMin: 0, xMax: 0.12, yMax: 0.12 };
  const refs = enumerateVisibleTiles("grid", WHOLE, 3, 0, view);
  // Without margin the view spans col/row 0 only; the +1 prefetch margin adds
  // col/row 1, so the set is the 2x2 block {0,1}x{0,1}.
  const coords = refs.map((r) => `${r.x},${r.y}`).sort();
  assert.deepEqual(coords, ["0,0", "0,1", "1,0", "1,1"]);
});

test("enumerateVisibleTiles marks coarse vs fine by z relative to z_cap", () => {
  // z_cap = 2: z<2 coarse, z>=2 fine.
  const coarse = enumerateVisibleTiles("grid", WHOLE, 1, 2, WHOLE);
  const fine = enumerateVisibleTiles("grid", WHOLE, 2, 2, WHOLE);
  assert.ok(coarse.every((r) => r.fine === false), "z=1 < z_cap=2 → coarse");
  assert.ok(fine.every((r) => r.fine === true), "z=2 >= z_cap=2 → fine");
});

test("enumerateVisibleTiles honours a non-unit layout bbox anchor", () => {
  const lb: BBox = { xMin: 0.2, yMin: 0.4, xMax: 0.6, yMax: 0.8 };
  const refs = enumerateVisibleTiles("grid", lb, 1, 0, lb); // 2x2 over the sub-rect
  assert.equal(refs.length, 4);
  // tile (0,0) covers the lower-left quadrant of the bbox.
  const t00 = refs.find((r) => r.x === 0 && r.y === 0)!;
  assert.ok(Math.abs(t00.bbox.xMin - 0.2) < 1e-9 && Math.abs(t00.bbox.xMax - 0.4) < 1e-9);
  assert.ok(Math.abs(t00.bbox.yMin - 0.4) < 1e-9 && Math.abs(t00.bbox.yMax - 0.6) < 1e-9);
});

test("tilePageId is the row-major y*2^z + x index (stable per address)", () => {
  // The cells.ts bucket page id the loader keys residency on. Deterministic, so a
  // re-visited tile reuses its bucket/texture instead of leaking a fresh one.
  assert.equal(tilePageId(0, 0, 0), 0);
  assert.equal(tilePageId(1, 1, 0), 1, "z1 (x=1,y=0) → 0*2+1");
  assert.equal(tilePageId(1, 0, 1), 2, "z1 (x=0,y=1) → 1*2+0");
  assert.equal(tilePageId(1, 1, 1), 3, "z1 (x=1,y=1) → 1*2+1");
  assert.equal(tilePageId(3, 5, 6), 6 * 8 + 5, "z3 (x=5,y=6) → 6*8+5");
  // Distinct addresses at a level never collide (unique bucket per tile).
  const seen = new Set<number>();
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) seen.add(tilePageId(3, x, y));
  assert.equal(seen.size, 64, "all 64 z=3 tiles map to distinct page ids");
});

test("tilePageId throws past MAX_PYRAMID_Z (Int32 atlas-page overflow guard)", () => {
  // z=15 is the deepest addressable level (2^(2*15)-1 < 2^31); z=16 overflows.
  assert.equal(MAX_PYRAMID_Z, 15);
  assert.doesNotThrow(() => tilePageId(15, 0, 0), "z=15 is in range");
  assert.throws(() => tilePageId(16, 0, 0), /exceeds MAX_PYRAMID_Z/, "z=16 overflows Int32");
});

test("cacheCountForTilePx bounds the cache by VRAM bytes, not a fixed tile count", () => {
  // RGBA8: one tile costs tile_px^2 * 4 bytes; count = floor(budget / tileBytes).
  // 128 MB / (512^2*4 = 1 MB) = 128 tiles (≈ the prior fixed budget).
  assert.equal(cacheCountForTilePx(TILE_CACHE_BUDGET_BYTES, 512), 128, "512px ⇒ 128 tiles");
  // 128 MB / (1024^2*4 = 4 MB) = 32; / (2048^2*4 = 16 MB) = 8 — same VRAM ceiling.
  assert.equal(cacheCountForTilePx(TILE_CACHE_BUDGET_BYTES, 1024), 32, "1024px ⇒ 32 tiles");
  assert.equal(cacheCountForTilePx(TILE_CACHE_BUDGET_BYTES, 2048), 8, "2048px ⇒ 8 tiles");
  // The floor keeps a few tiles warm even if a tile is larger than the whole budget.
  assert.equal(cacheCountForTilePx(1024, 2048, MIN_TILE_CACHE), MIN_TILE_CACHE, "clamped to the floor");
});

test("focalOrder sorts nearest-the-focal first", () => {
  const refs = enumerateVisibleTiles("grid", WHOLE, 2, 0, WHOLE); // 4x4 = 16 tiles
  // Focal at the centre of tile (3,3): its centre is nearest.
  const focal = { x: 0.875, y: 0.875 };
  const ordered = focalOrder(refs, focal.x, focal.y);
  assert.deepEqual({ x: ordered[0].x, y: ordered[0].y }, { x: 3, y: 3 });
  // The farthest (0,0) is last.
  assert.deepEqual({ x: ordered[ordered.length - 1].x, y: ordered[ordered.length - 1].y }, { x: 0, y: 0 });
});

test("chooseEvictions evicts oldest non-kept tiles down to the budget", () => {
  const resident = [
    { key: "a", lastUsed: 1 },
    { key: "b", lastUsed: 2 },
    { key: "c", lastUsed: 3 },
    { key: "d", lastUsed: 4 },
  ];
  const keep = new Set(["d"]);
  const victims = chooseEvictions(resident, keep, 2);
  // 4 resident, budget 2 → drop 2 oldest non-kept: a, b.
  assert.deepEqual(victims, ["a", "b"]);
});

test("chooseEvictions never evicts a kept (visible/parent) tile even over budget", () => {
  const resident = [
    { key: "a", lastUsed: 1 },
    { key: "b", lastUsed: 2 },
    { key: "c", lastUsed: 3 },
  ];
  // budget 1 but all 3 are kept → nothing can be evicted (working set wins).
  const victims = chooseEvictions(resident, new Set(["a", "b", "c"]), 1);
  assert.deepEqual(victims, []);
});

test("chooseEvictions is a no-op under budget", () => {
  assert.deepEqual(chooseEvictions([{ key: "a", lastUsed: 1 }], new Set(), 8), []);
});

test("tileKey is the stable layout/z/x/y address", () => {
  assert.equal(tileKey({ layoutId: "grid", z: 2, x: 1, y: 3 }), "grid/2/1/3");
});

test("isAbortError is true only for an AbortError-named rejection", () => {
  assert.equal(isAbortError({ name: "AbortError" }), true, "a DOMException-shaped AbortError");
  // A real AbortController abort rejects with a DOMException named AbortError.
  const ac = new AbortController();
  ac.abort();
  assert.equal(isAbortError(ac.signal.reason), true, "AbortController's abort reason");
  // Everything else is a real failure, not a supersede.
  assert.equal(isAbortError(new Error("network")), false, "a plain Error is not an abort");
  assert.equal(isAbortError({ name: "TypeError" }), false, "a differently-named object");
  assert.equal(isAbortError(null), false, "null");
  assert.equal(isAbortError(undefined), false, "undefined");
  assert.equal(isAbortError("AbortError"), false, "a bare string is not an abort object");
  assert.equal(isAbortError({}), false, "an object with no name");
});

test("bboxFromCamera derives the visible world rect from center+zoom", () => {
  const view = bboxFromCamera({ center: [0.5, 0.5], zoom: 0.001 }, { width: 800, height: 600, devicePixelRatio: 1 });
  assert.ok(Math.abs(view.xMin - (0.5 - 0.4)) < 1e-9);
  assert.ok(Math.abs(view.xMax - (0.5 + 0.4)) < 1e-9);
  assert.ok(Math.abs(view.yMin - (0.5 - 0.3)) < 1e-9);
  assert.ok(Math.abs(view.yMax - (0.5 + 0.3)) < 1e-9);
});
