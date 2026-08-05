// Tier-1 (T2-121 / T2-127): the renderer tag-highlight overlay (src/renderer/highlightOverlay.ts).
// GL-free — THREE data objects (InstancedBufferGeometry / ShaderMaterial / Mesh / Frustum)
// construct without a WebGL context, and the createStubWorld stub records added meshes +
// drives camera events explicitly. Covers the brief-mandated groups:
//   1. the selection→instance-buffer PARTITION (buildMarkerGroups) incl. its diffing
//      across selection changes and the out-of-range/all-match/all-dim edges;
//   2. the MIN-SIZE clamp math (clampMarkerWorldSize / markerScreenPx — the GLSL
//      shader's exact JS mirror), proving a match never renders below minMarkerPx;
//   3. overlay orchestration — build on (selection + positions), the explicit render
//      orders (dim below borders, both above the tiers), clear on empty/absent, LAYOUT
//      SWITCH rebuild WITHOUT stale marks, the per-camera uZoom write, and dispose (incl.
//      self-teardown on world.dispose);
//   4. T2-127 SPATIAL CHUNKING + FRUSTUM CULLING — the per-frame GPU lever. These assert
//      BOTH halves of the contract: that culling actually cuts the instance count a
//      zoomed-in view pays for (the perf win), and that it never drops a mark that
//      intersects the view (the correctness guard — including world.ts's y-FLIPPED
//      camera, where a silently mis-derived frustum would make marks vanish at some
//      zooms and no visual unit test would catch it).
//
// The GL VISUAL result (does the gold actually read on beige drawings) needs a human
// eyeball — the T2-93 convention; see the PR's verification script.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  createHighlightOverlay,
  buildMarkerGroups,
  chooseChunkGrid,
  groupBoundingSphere,
  clampMarkerWorldSize,
  markerScreenPx,
  DEFAULT_HIGHLIGHT_OVERLAY_CONFIG,
  MARKER_CHUNK_TARGET,
  MARKER_CHUNK_MAX_GRID,
  RENDER_ORDER_HIGHLIGHT_DIM,
  RENDER_ORDER_HIGHLIGHT_BORDER,
} from "../src/renderer/highlightOverlay.ts";
import type { MarkerGroup } from "../src/renderer/highlightOverlay.ts";
import type { PositionTable } from "../src/renderer/cells.ts";
import type { CameraState, Viewport } from "../src/renderer/world.ts";
import { createStubWorld } from "./fake_client.ts";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const VP: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
function cam(zoom: number, cx = 0.5, cy = 0.5): CameraState {
  return { center: [cx, cy], zoom };
}

function posTable(cells: { x: number; y: number; w: number; h: number }[]): PositionTable {
  return {
    x: Float32Array.from(cells.map((c) => c.x)),
    y: Float32Array.from(cells.map((c) => c.y)),
    w: Float32Array.from(cells.map((c) => c.w)),
    h: Float32Array.from(cells.map((c) => c.h)),
    count: cells.length,
  };
}

/** A `side`×`side` space-filling grid over [0,1]², every `matchEvery`-th cell a match.
 *  Sized above MARKER_CHUNK_TARGET so the overlay actually chunks. */
function gridDataset(side: number, matchEvery: number): { positions: PositionTable; visibility: Uint8Array } {
  const n = side * side;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const w = new Float32Array(n);
  const h = new Float32Array(n);
  const visibility = new Uint8Array(n);
  const cell = 1 / side;
  for (let i = 0; i < n; i++) {
    x[i] = ((i % side) + 0.5) * cell;
    y[i] = (Math.floor(i / side) + 0.5) * cell;
    w[i] = cell;
    h[i] = cell;
    visibility[i] = i % matchEvery === 0 ? 1 : 0;
  }
  return { positions: { x, y, w, h, count: n }, visibility };
}

function sceneMeshes(w: ReturnType<typeof createStubWorld>): THREE.Mesh[] {
  return [...w.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
}

function meshesOfOrder(w: ReturnType<typeof createStubWorld>, order: number): THREE.Mesh[] {
  return sceneMeshes(w).filter((m) => m.renderOrder === order);
}

/** The single mesh of a kind — valid only for the small (un-chunked, grid 1) fixtures. */
function soleMeshOfOrder(w: ReturnType<typeof createStubWorld>, order: number): THREE.Mesh | undefined {
  const found = meshesOfOrder(w, order);
  assert.ok(found.length <= 1, `expected at most one mesh at renderOrder ${order}, got ${found.length}`);
  return found[0];
}

function instanceCount(mesh: THREE.Mesh): number {
  return (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
}

function totalInstances(meshes: THREE.Mesh[]): number {
  return meshes.reduce((n, m) => n + instanceCount(m), 0);
}

function uniforms(mesh: THREE.Mesh): Record<string, { value: unknown }> {
  return (mesh.material as THREE.ShaderMaterial).uniforms;
}

function iCenter(mesh: THREE.Mesh): Float32Array {
  return mesh.geometry.getAttribute("iCenter").array as Float32Array;
}

function approxArray(got: Float32Array, expected: number[], msg: string): void {
  assert.equal(got.length, expected.length, `${msg} length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(got[i] - expected[i]) < 1e-6, `${msg}[${i}] ${got[i]} ≈ ${expected[i]}`);
  }
}

/** Merge one kind's groups back into the flat (centres, sizes) the un-chunked partition
 *  returned, so the partition assertions read the same at any grid. */
function flatten(
  groups: MarkerGroup[],
  kind: "border" | "dim",
): { centers: number[]; sizes: number[]; count: number } {
  const mine = groups.filter((g) => g.kind === kind);
  return {
    centers: mine.flatMap((g) => [...g.centers]),
    sizes: mine.flatMap((g) => [...g.sizes]),
    count: mine.reduce((n, g) => n + g.count, 0),
  };
}

function approxList(got: number[], expected: number[], msg: string): void {
  assert.equal(got.length, expected.length, `${msg} length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(got[i] - expected[i]) < 1e-6, `${msg}[${i}] ${got[i]} ≈ ${expected[i]}`);
  }
}

// --- frustum helpers: world.ts's real camera + THREE's real visibility test ----------

interface ViewRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** An orthographic camera built EXACTLY as world.ts's applyCamera does — INCLUDING the
 *  y-flip (`top` gets the smaller world-y). Culling must survive that flip. */
function worldCamera(zoom: number, cx: number, cy: number, vp: Viewport = VP): THREE.OrthographicCamera {
  const halfW = (vp.width / 2) * zoom;
  const halfH = (vp.height / 2) * zoom;
  const camera = new THREE.OrthographicCamera(-halfW, halfW, -halfH, halfH, 0.1, 100);
  camera.position.set(cx, cy, 10);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

function viewRectOf(zoom: number, cx: number, cy: number, vp: Viewport = VP): ViewRect {
  const halfW = (vp.width / 2) * zoom;
  const halfH = (vp.height / 2) * zoom;
  return { minX: cx - halfW, maxX: cx + halfW, minY: cy - halfH, maxY: cy + halfH };
}

function frustumOf(camera: THREE.OrthographicCamera): THREE.Frustum {
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

/** THREE's own per-object visibility decision — the exact test WebGLRenderer.projectObject
 *  applies before drawing a mesh. */
function survivesCulling(mesh: THREE.Mesh, frustum: THREE.Frustum): boolean {
  mesh.updateMatrixWorld();
  return !mesh.frustumCulled || frustum.intersectsObject(mesh);
}

/** Instances the GPU would actually walk this frame (summed over un-culled meshes). */
function drawnInstances(w: ReturnType<typeof createStubWorld>, camera: THREE.OrthographicCamera): number {
  const frustum = frustumOf(camera);
  return sceneMeshes(w)
    .filter((m) => survivesCulling(m, frustum))
    .reduce((n, m) => n + instanceCount(m), 0);
}

/** How many of a mesh's instances have a DRAWN rect (cell size, min-clamped for borders)
 *  overlapping `view` — i.e. how many marks culling this mesh would wrongly erase. */
function instancesIntersecting(mesh: THREE.Mesh, view: ViewRect, zoom: number): number {
  const centers = iCenter(mesh);
  const sizes = mesh.geometry.getAttribute("iCellSize").array as Float32Array;
  const minPx =
    mesh.renderOrder === RENDER_ORDER_HIGHLIGHT_BORDER ? DEFAULT_HIGHLIGHT_OVERLAY_CONFIG.minMarkerPx : 0;
  let hits = 0;
  for (let i = 0; i < instanceCount(mesh); i++) {
    const hw = clampMarkerWorldSize(sizes[2 * i], zoom, minPx) / 2;
    const hh = clampMarkerWorldSize(sizes[2 * i + 1], zoom, minPx) / 2;
    const cx = centers[2 * i];
    const cy = centers[2 * i + 1];
    if (cx + hw < view.minX || cx - hw > view.maxX) continue;
    if (cy + hh < view.minY || cy - hh > view.maxY) continue;
    hits++;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 1. buildMarkerGroups (pure) — the selection→instance-buffer partition
// ---------------------------------------------------------------------------

test("buildMarkerGroups partitions cells into match (border) and non-match (dim) buffers, in id order", () => {
  const positions = posTable([
    { x: 0.1, y: 0.2, w: 0.01, h: 0.02 }, // 0 match
    { x: 0.3, y: 0.4, w: 0.03, h: 0.04 }, // 1 dim
    { x: 0.5, y: 0.6, w: 0.05, h: 0.06 }, // 2 match
    { x: 0.7, y: 0.8, w: 0.07, h: 0.08 }, // 3 dim
  ]);
  const groups = buildMarkerGroups(positions, Uint8Array.from([1, 0, 1, 0]), 1);
  const border = flatten(groups, "border");
  const dim = flatten(groups, "dim");

  assert.equal(border.count, 2);
  assert.equal(dim.count, 2);
  approxList(border.centers, [0.1, 0.2, 0.5, 0.6], "matchCenters"); // ids 0,2 centres
  approxList(border.sizes, [0.01, 0.02, 0.05, 0.06], "matchSizes"); // ids 0,2 sizes
  approxList(dim.centers, [0.3, 0.4, 0.7, 0.8], "dimCenters"); // ids 1,3 centres
  approxList(dim.sizes, [0.03, 0.04, 0.07, 0.08], "dimSizes"); // ids 1,3 sizes
});

test("buildMarkerGroups: an id beyond the visibility array is a NON-match (no tag membership ⇒ dim)", () => {
  const positions = posTable([
    { x: 0.1, y: 0.1, w: 0.01, h: 0.01 }, // 0
    { x: 0.2, y: 0.2, w: 0.01, h: 0.01 }, // 1
    { x: 0.3, y: 0.3, w: 0.01, h: 0.01 }, // 2
  ]);
  const groups = buildMarkerGroups(positions, Uint8Array.from([1]), 1); // only id 0 has an entry
  assert.equal(flatten(groups, "border").count, 1, "only the in-range match is bordered");
  assert.equal(flatten(groups, "dim").count, 2, "out-of-range ids fall to dim");
});

test("buildMarkerGroups: all-match yields no dim group; all-dim yields no border group; empty table yields none", () => {
  const positions = posTable([
    { x: 0.1, y: 0.1, w: 0.01, h: 0.01 },
    { x: 0.2, y: 0.2, w: 0.01, h: 0.01 },
  ]);
  const allMatch = buildMarkerGroups(positions, Uint8Array.from([1, 1]), 1);
  assert.equal(flatten(allMatch, "border").count, 2);
  assert.equal(flatten(allMatch, "dim").count, 0);
  assert.equal(allMatch.length, 1, "no empty group is emitted");
  const allDim = buildMarkerGroups(positions, Uint8Array.from([0, 0]), 1);
  assert.equal(allDim.length, 1);
  assert.equal(flatten(allDim, "dim").count, 2);
  assert.deepEqual(buildMarkerGroups(posTable([]), new Uint8Array(0), 1), [], "empty table ⇒ no groups");
});

// ---------------------------------------------------------------------------
// 2. min-size clamp (pure) — the GLSL shader's exact JS mirror
// ---------------------------------------------------------------------------

test("clampMarkerWorldSize floors a marker to minMarkerPx CSS px; inert once the cell is larger", () => {
  const minPx = 6;
  // zoom = world units per CSS px. A 0.001-world cell at zoom 0.01 is 0.1 px un-clamped;
  // the clamp lifts it to minPx*zoom = 0.06 world (= 6 px on screen).
  assert.ok(Math.abs(clampMarkerWorldSize(0.001, 0.01, minPx) - 0.06) < 1e-9, "tiny cell clamped up");
  assert.equal(clampMarkerWorldSize(1.0, 0.01, minPx), 1.0, "large cell unchanged (clamp inert)");
  assert.equal(clampMarkerWorldSize(0.06, 0.01, minPx), 0.06, "exactly at the floor → the cell size");
});

test("markerScreenPx is never below minMarkerPx for any positive zoom (the legibility guarantee)", () => {
  const minPx = 6;
  for (const zoom of [1e-4, 1e-3, 0.01, 0.1, 1]) {
    for (const cell of [0, 1e-5, 1e-3, 0.05, 0.5]) {
      assert.ok(
        markerScreenPx(cell, zoom, minPx) >= minPx - 1e-6,
        `a match at cell ${cell} @ zoom ${zoom} is ≥ ${minPx}px on screen`,
      );
    }
  }
  // A cell already larger than the floor renders at its true on-screen size (the border
  // then hugs the cell rect, not the min mark).
  assert.ok(markerScreenPx(0.5, 1e-4, minPx) > minPx, "a large on-screen cell exceeds the min");
  assert.equal(markerScreenPx(0.01, 0, minPx), 0, "zoom 0 guard → 0 (no divide-by-zero)");
});

// ---------------------------------------------------------------------------
// 3. Overlay orchestration
// ---------------------------------------------------------------------------

test("overlay draws a border mesh over matches + a dim mesh over non-matches, at the explicit render orders", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);
  overlay.setContext({
    positions: posTable([
      { x: 0.4, y: 0.5, w: 0.02, h: 0.02 }, // 0 match
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 }, // 1 dim
      { x: 0.5, y: 0.7, w: 0.02, h: 0.02 }, // 2 match
    ]),
  });

  // Positions but no selection → inactive (nothing to distinguish).
  assert.equal(overlay.isActive(), false, "no selection → nothing drawn");
  assert.equal(sceneMeshes(w).length, 0);

  overlay.setSelection(Uint8Array.from([1, 0, 1])); // ids 0,2 match; 1 dims
  assert.equal(overlay.isActive(), true);
  assert.equal(overlay.matchCount(), 2, "two matching cells bordered");
  assert.equal(overlay.dimCount(), 1, "one non-match dimmed");
  assert.equal(sceneMeshes(w).length, 2, "one border mesh + one dim mesh (below the chunk threshold)");

  const border = soleMeshOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER);
  const dim = soleMeshOfOrder(w, RENDER_ORDER_HIGHLIGHT_DIM);
  assert.ok(border !== undefined && dim !== undefined, "dim below borders, both above the tiers + detail overlay");
  assert.ok(RENDER_ORDER_HIGHLIGHT_BORDER > RENDER_ORDER_HIGHLIGHT_DIM, "borders paint above the dim");
  // The border mesh carries the min-size clamp; the dim mesh covers the exact footprint.
  assert.equal(uniforms(border).uMinPx.value, DEFAULT_HIGHLIGHT_OVERLAY_CONFIG.minMarkerPx, "border clamped to min px");
  assert.equal(uniforms(dim).uMinPx.value, 0, "dim uses the exact cell footprint (no clamp)");
  assert.equal(instanceCount(border), 2);
  assert.equal(instanceCount(dim), 1);
});

test("the border mark uses the RAW sRGB accent (#F0B429) so it reads as the exact CSS gold", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);
  overlay.setContext({ positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });
  overlay.setSelection(Uint8Array.from([1]));
  const border = soleMeshOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER);
  assert.ok(border !== undefined);
  const c = uniforms(border).uColor.value as THREE.Vector3;
  // Raw sRGB components of 0xF0B429 (NOT linearised — the shader writes to an sRGB buffer).
  assert.ok(
    Math.abs(c.x - 0xf0 / 255) < 1e-6 && Math.abs(c.y - 0xb4 / 255) < 1e-6 && Math.abs(c.z - 0x29 / 255) < 1e-6,
    "border colour is the raw sRGB accent",
  );
});

test("an empty selection (pushed as null by the controller) clears the overlay; a real selection re-builds it", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);
  overlay.setContext({
    positions: posTable([
      { x: 0.4, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });
  overlay.setSelection(Uint8Array.from([1, 0]));
  assert.equal(overlay.isActive(), true);

  overlay.setSelection(null); // controller sends null for the empty selection
  assert.equal(overlay.isActive(), false, "cleared — no gold-on-everything");
  assert.equal(sceneMeshes(w).length, 0, "meshes removed from the scene");

  // A different selection re-partitions (diffing across selection changes = full rebuild).
  overlay.setSelection(Uint8Array.from([0, 1]));
  assert.equal(overlay.matchCount(), 1, "the other cell now matches");
  assert.equal(overlay.dimCount(), 1);
  const border = soleMeshOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER);
  assert.ok(border !== undefined);
  approxArray(iCenter(border).slice(0, 2), [0.6, 0.5], "match centre followed the new selection");
});

test("layout switch: marks clear during the switch window then rebuild at the NEW positions (retained selection, no stale marks)", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);

  overlay.setContext({
    positions: posTable([
      { x: 0.1, y: 0.1, w: 0.02, h: 0.02 }, // id 0 (matches)
      { x: 0.2, y: 0.2, w: 0.02, h: 0.02 }, // id 1
    ]),
  });
  overlay.setSelection(Uint8Array.from([1, 0]));
  assert.equal(overlay.matchCount(), 1);
  const borderA = soleMeshOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER);
  assert.ok(borderA !== undefined);
  approxArray(iCenter(borderA).slice(0, 2), [0.1, 0.1], "match at the layout-A position");

  // The controller nulls positions FIRST on a switch (applyPickFallback), THEN binds the
  // new table — so the marks clear (no stale-layout marks, #167) and rebuild in place.
  overlay.setContext(null);
  assert.equal(overlay.isActive(), false, "marks cleared during the switch window");
  assert.equal(sceneMeshes(w).length, 0);

  overlay.setContext({
    positions: posTable([
      { x: 0.8, y: 0.8, w: 0.02, h: 0.02 }, // id 0 moved
      { x: 0.9, y: 0.9, w: 0.02, h: 0.02 }, // id 1
    ]),
  });
  assert.equal(overlay.matchCount(), 1, "same (retained, layout-invariant) selection rebuilt");
  const borderB = soleMeshOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER);
  assert.ok(borderB !== undefined);
  approxArray(iCenter(borderB).slice(0, 2), [0.8, 0.8], "match redrawn at the NEW layout-B position");
});

test("a camera change writes the live zoom into every material's uZoom uniform (drives the on-GPU clamp)", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.005), VP);
  overlay.setContext({
    positions: posTable([
      { x: 0.5, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });
  overlay.setSelection(Uint8Array.from([1, 0]));
  for (const m of sceneMeshes(w)) assert.equal(uniforms(m).uZoom.value, 0.005, "built with the last camera zoom");

  w.emit(cam(0.0002), VP);
  for (const m of sceneMeshes(w)) assert.equal(uniforms(m).uZoom.value, 0.0002, "uZoom tracks the camera");
});

test("dispose removes the meshes, is idempotent, and a subsequent setSelection is a no-op", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);
  overlay.setContext({
    positions: posTable([
      { x: 0.5, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });
  overlay.setSelection(Uint8Array.from([1, 0]));
  assert.equal(sceneMeshes(w).length, 2);

  overlay.dispose();
  assert.equal(sceneMeshes(w).length, 0, "meshes removed on dispose");
  assert.equal(overlay.isActive(), false);
  overlay.dispose(); // idempotent — no throw, no change
  overlay.setSelection(Uint8Array.from([1, 1])); // no-op after dispose
  assert.equal(sceneMeshes(w).length, 0, "no rebuild after dispose");
});

test("the overlay self-tears-down on world.dispose() (symmetric with the loader / detail overlay)", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);
  overlay.setContext({
    positions: posTable([
      { x: 0.5, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });
  overlay.setSelection(Uint8Array.from([1, 0]));
  assert.equal(sceneMeshes(w).length, 2);

  w.dispose(); // fires onDispose hooks → overlay.dispose()
  assert.equal(sceneMeshes(w).length, 0, "world.dispose() tore down the overlay meshes");
  assert.equal(overlay.isActive(), false);
});

test("the per-kind materials are SHARED across chunk meshes and survive a rebuild", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  w.emit(cam(0.001), VP);
  const { positions, visibility } = gridDataset(300, 7); // 90k ⇒ chunked
  overlay.setContext({ positions });
  overlay.setSelection(visibility);

  const borderMats = new Set(meshesOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER).map((m) => m.material));
  const dimMats = new Set(meshesOfOrder(w, RENDER_ORDER_HIGHLIGHT_DIM).map((m) => m.material));
  assert.equal(borderMats.size, 1, "every border chunk shares ONE material (no per-chunk GL state)");
  assert.equal(dimMats.size, 1, "every dim chunk shares ONE material");

  // A rebuild re-uses them rather than constructing new ShaderMaterials per selection.
  const before = [...borderMats][0];
  overlay.setSelection(Uint8Array.from(visibility, (_, i) => (i % 3 === 0 ? 1 : 0)));
  const after = [...new Set(meshesOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER).map((m) => m.material))][0];
  assert.equal(after, before, "the shared material is re-used across rebuilds");
});

// ---------------------------------------------------------------------------
// 4. T2-127 — spatial chunking + frustum culling
// ---------------------------------------------------------------------------

test("chooseChunkGrid: no chunking at or below the target, then grows with n, capped", () => {
  assert.equal(chooseChunkGrid(0), 1, "empty ⇒ one group per kind");
  assert.equal(chooseChunkGrid(MARKER_CHUNK_TARGET), 1, "exactly at the target ⇒ still un-chunked");
  assert.equal(chooseChunkGrid(MARKER_CHUNK_TARGET + 1), 2, "just above ⇒ 2×2");
  assert.equal(chooseChunkGrid(4 * MARKER_CHUNK_TARGET), 2, "4× the target ⇒ 2×2 (≈target per bin)");
  assert.equal(
    chooseChunkGrid(1_000_000),
    Math.min(MARKER_CHUNK_MAX_GRID, Math.ceil(Math.sqrt(1_000_000 / MARKER_CHUNK_TARGET))),
    "1M chunks to the sqrt rule",
  );
  assert.equal(chooseChunkGrid(1e9), MARKER_CHUNK_MAX_GRID, "capped — draw calls stay bounded");
  assert.equal(chooseChunkGrid(1e9, 0), 1, "a non-positive target degrades to un-chunked, not a divide-by-zero");
});

test("chunking conserves the partition exactly — every cell appears once, in the right kind, inside its bounds", () => {
  const { positions, visibility } = gridDataset(300, 7); // 90,000 cells
  const grid = chooseChunkGrid(positions.count);
  assert.ok(grid > 1, "fixture is large enough to chunk");
  const groups = buildMarkerGroups(positions, visibility, grid);

  const expectedMatches = [...visibility].filter((v) => v !== 0).length;
  assert.equal(flatten(groups, "border").count, expectedMatches, "no match lost or duplicated across bins");
  assert.equal(flatten(groups, "dim").count, positions.count - expectedMatches, "no non-match lost or duplicated");
  assert.equal(
    groups.reduce((n, g) => n + g.count, 0),
    positions.count,
    "the chunks partition the dataset",
  );
  assert.ok(
    groups.every((g) => g.count > 0),
    "no empty group is emitted (an empty bin costs no draw call)",
  );
  // Every instance sits inside its own group's declared bounds — the culling volume is sound.
  for (const g of groups) {
    for (let i = 0; i < g.count; i++) {
      const cx = g.centers[2 * i];
      const cy = g.centers[2 * i + 1];
      const hw = g.sizes[2 * i] / 2;
      const hh = g.sizes[2 * i + 1] / 2;
      assert.ok(
        cx - hw >= g.bounds.minX - 1e-6 &&
          cx + hw <= g.bounds.maxX + 1e-6 &&
          cy - hh >= g.bounds.minY - 1e-6 &&
          cy + hh <= g.bounds.maxY + 1e-6,
        "a cell rect escapes its group's bounds — culling could drop it",
      );
    }
  }
});

test("chunking handles degenerate spans (all cells on one point / one line) without losing cells", () => {
  const samePoint = posTable(Array.from({ length: 8 }, () => ({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 })));
  const g1 = buildMarkerGroups(samePoint, new Uint8Array(8).fill(1), 4);
  assert.equal(
    g1.reduce((n, g) => n + g.count, 0),
    8,
    "a zero-span dataset collapses onto one bin, losing nothing",
  );
  const oneLine = posTable(Array.from({ length: 8 }, (_, i) => ({ x: i / 8, y: 0.5, w: 0.01, h: 0.01 })));
  const g2 = buildMarkerGroups(oneLine, new Uint8Array(8).fill(1), 4);
  assert.equal(
    g2.reduce((n, g) => n + g.count, 0),
    8,
    "a zero-span AXIS collapses onto row 0, losing nothing",
  );
});

test("groupBoundingSphere covers the AABB and grows with the min-clamp pad (0 for dim)", () => {
  const bounds = { minX: 0, minY: 0, maxX: 0.2, maxY: 0.4 };
  const unpadded = groupBoundingSphere(bounds, 0.001, 0);
  assert.ok(Math.abs(unpadded.x - 0.1) < 1e-9 && Math.abs(unpadded.y - 0.2) < 1e-9, "centred on the AABB");
  assert.ok(Math.abs(unpadded.radius - Math.hypot(0.1, 0.2)) < 1e-9, "circumradius of the AABB");
  // A border group at the same zoom must reach further — the clamp can push a marker
  // minMarkerPx*zoom/2 past its cell rect on every side.
  const padded = groupBoundingSphere(bounds, 0.001, 6);
  assert.ok(padded.radius > unpadded.radius, "the border pad widens the culling sphere");
  assert.ok(Math.abs(padded.radius - Math.hypot(0.1 + 0.003, 0.2 + 0.003)) < 1e-9, "pad = minPx*zoom/2 per side");
  assert.equal(groupBoundingSphere(bounds, -1, 6).radius, unpadded.radius, "a negative zoom cannot shrink the sphere");
});

test("PERF: frustum culling cuts the instances a zoomed-in view pays for by ≫ half (T2-127)", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  const { positions, visibility } = gridDataset(300, 7); // 90,000 cells over [0,1]²
  const n = positions.count;
  w.emit(cam(0.001), VP);
  overlay.setContext({ positions });
  overlay.setSelection(visibility);

  // Nothing is lost by chunking: the meshes still carry every cell.
  assert.equal(totalInstances(sceneMeshes(w)), n, "all cells are still instanced");
  assert.equal(overlay.matchCount() + overlay.dimCount(), n);
  assert.ok(sceneMeshes(w).length > 2, "the dataset is chunked into more than one mesh per kind");
  assert.ok(
    sceneMeshes(w).length <= MARKER_CHUNK_MAX_GRID * MARKER_CHUNK_MAX_GRID * 2,
    "chunk count stays within the draw-call cap",
  );

  // Zoomed into a small corner: the frustum keeps only the bins overlapping it. This is the
  // whole point — the overlay marks the WHOLE dataset (unlike the fine tier, which is
  // viewport-bounded by tile residency), so before chunking the GPU walked all n instances
  // here however little was on screen.
  const deepZoom = 0.00008; // a 1000px viewport ⇒ a 0.08-wide world window
  w.emit(cam(deepZoom, 0.05, 0.05), VP);
  const drawnDeep = drawnInstances(w, worldCamera(deepZoom, 0.05, 0.05));
  assert.ok(drawnDeep > 0, "the marks under the camera are still drawn");
  assert.ok(
    drawnDeep < n / 2,
    `zoomed in, culling must cut the instance load well below half (drawn ${drawnDeep} of ${n})`,
  );

  // The un-chunked baseline for the same view: ONE mesh per kind cannot be culled at all,
  // so it pays the full n. This is the regression this test exists to prevent.
  const flat = buildMarkerGroups(positions, visibility, 1);
  assert.equal(flat.length, 2, "un-chunked ⇒ one world-spanning mesh per kind");
  assert.equal(
    flat.reduce((sum, g) => sum + g.count, 0),
    n,
    "…carrying every instance, with nothing for the frustum to cull",
  );
});

test("CORRECTNESS: culling never drops a mark that intersects the view, at any zoom (incl. the y-flipped camera)", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  const { positions, visibility } = gridDataset(300, 7);
  const n = positions.count;
  w.emit(cam(0.001), VP);
  overlay.setContext({ positions });
  overlay.setSelection(visibility);

  // Fully zoomed out (the whole [0,1]² world on screen): nothing may be culled. This also
  // pins world.ts's y-FLIP (camera.top gets the SMALLER world-y) — a frustum mis-derived
  // from that flip would cull live marks, and no other unit test would notice.
  const outZoom = 0.0012; // 1000px ⇒ a 1.2-wide window over a 1.0-wide world
  w.emit(cam(outZoom, 0.5, 0.5), VP);
  assert.equal(drawnInstances(w, worldCamera(outZoom, 0.5, 0.5)), n, "overview zoom draws every mark");

  // At a spread of zooms and centres, no CULLED mesh may hold an instance whose drawn rect
  // (min-clamp included) overlaps the view.
  const views: [number, number, number][] = [
    [0.0012, 0.5, 0.5],
    [0.0004, 0.25, 0.75],
    [0.00015, 0.5, 0.5],
    [0.00008, 0.05, 0.05],
    [0.00008, 0.95, 0.95],
    [0.00003, 0.33, 0.66],
  ];
  for (const [zoom, cx, cy] of views) {
    w.emit(cam(zoom, cx, cy), VP); // refreshes uZoom + the clamp-padded culling spheres
    const frustum = frustumOf(worldCamera(zoom, cx, cy));
    const view = viewRectOf(zoom, cx, cy);
    for (const mesh of sceneMeshes(w)) {
      if (survivesCulling(mesh, frustum)) continue;
      const wrongly = instancesIntersecting(mesh, view, zoom);
      assert.equal(
        wrongly,
        0,
        `a culled mesh held ${wrongly} mark(s) overlapping the view @ zoom ${zoom} centre (${cx},${cy})`,
      );
    }
  }
});

test("the culling spheres are re-padded on camera change, not left at build zoom", () => {
  const w = createStubWorld();
  const overlay = createHighlightOverlay(w.world);
  const { positions, visibility } = gridDataset(300, 7);
  w.emit(cam(1e-5), VP); // built tight: a tiny clamp pad
  overlay.setContext({ positions });
  overlay.setSelection(visibility);
  const border = meshesOfOrder(w, RENDER_ORDER_HIGHLIGHT_BORDER)[0];
  const tight = border.geometry.boundingSphere?.radius ?? 0;
  assert.ok(tight > 0, "an explicit bounding sphere is set (THREE would otherwise measure the base quad)");

  w.emit(cam(0.01), VP); // zoom out hard: markers clamp up, so the sphere must grow
  const wide = border.geometry.boundingSphere?.radius ?? 0;
  assert.ok(wide > tight, "the border sphere grew with the min-clamp at the new zoom");

  // Dim groups never clamp, so their sphere is zoom-invariant.
  const dim = meshesOfOrder(w, RENDER_ORDER_HIGHLIGHT_DIM)[0];
  const dimRadius = dim.geometry.boundingSphere?.radius ?? 0;
  w.emit(cam(1e-5), VP);
  assert.ok(
    Math.abs((dim.geometry.boundingSphere?.radius ?? 0) - dimRadius) < 1e-12,
    "the dim sphere is zoom-invariant (uMinPx = 0)",
  );
});
