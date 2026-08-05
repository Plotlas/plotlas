// Tier-1 (T2-26): the renderer detail overlay (src/renderer/detailOverlay.ts).
// GL-free via the DI seam (createDetailOverlay's `deps`: a fake fetch that records
// signals + returns canned statuses, a stub decode that returns a bare THREE.Texture)
// + the GL-free stub world/cells — so the orchestration (gate hysteresis, LRU byte
// accounting, fetch discipline, layout-switch survival, teardown) runs without a
// WebGL context or createImageBitmap. Covers the four brief-mandated groups:
//   1. gate hysteresis (engage ≥128, hold to <96, hard-skip above the in-view cap,
//      off without a detail block / positions table);
//   2. LRU byte-accounting (budget respected, oldest non-drawn evicted, keyed by
//      (ds, version, cellId), survives a layout switch, cleared on dispose);
//   3. URL builder — in client_urls.test.ts (staticDetailUrl);
//   4. fetch discipline (abort on leave-view, 404 permanent skip, 401 refresh+retry).
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  createDetailOverlay,
  detailGateEngaged,
  rungFor,
  coverCropUvs,
  coincidenceMergeWorld,
  COINCIDENCE_MERGE_PX,
  DEFAULT_DETAIL_OVERLAY_CONFIG,
  RENDER_ORDER_OVERLAY,
} from "../src/renderer/detailOverlay.ts";
import type { DecodedDetail } from "../src/renderer/detailOverlay.ts";
import { collectPositionsInView } from "../src/renderer/cells.ts";
import type { PositionTable } from "../src/renderer/cells.ts";
import type { DetailDescriptor, LayoutManifest } from "../src/renderer/layout.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { CameraState, Viewport } from "../src/renderer/world.ts";
import { createStubWorld, createStubCells } from "./fake_client.ts";

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

const VP: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
function cam(zoom: number, cx = 0.5, cy = 0.5): CameraState {
  return { center: [cx, cy], zoom };
}

async function settle(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
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

/** A PositionTable whose x/y/w/h are Proxy-wrapped to COUNT numeric-index reads — so a
 *  test can prove the O(N) position scan is (or is not) touched on a given refresh (R1). */
function countingPosTable(cells: { x: number; y: number; w: number; h: number }[]): {
  table: PositionTable;
  reads: () => number;
} {
  let n = 0;
  const wrap = (values: number[]): Float32Array => {
    const arr = Float32Array.from(values);
    return new Proxy(arr, {
      get(target, prop) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) n++; // an x[i]/y[i]/w[i]/h[i] read
        return Reflect.get(target, prop);
      },
    }) as unknown as Float32Array;
  };
  return {
    table: {
      x: wrap(cells.map((c) => c.x)),
      y: wrap(cells.map((c) => c.y)),
      w: wrap(cells.map((c) => c.w)),
      h: wrap(cells.map((c) => c.h)),
      count: cells.length,
    },
    reads: () => n,
  };
}

const IMAGE_REF_DETAIL: DetailDescriptor = { mode: "image_ref", path_prefix: "detail/v1/", format: "webp" };

function detailManifest(detail: DetailDescriptor | null = IMAGE_REF_DETAIL): LayoutManifest {
  return {
    manifest_version: "2.1",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [
      {
        layout_id: "grid",
        label: "Grid",
        type: "grid",
        bbox: [0, 0, 1, 1],
        pyramid: {
          container: "pmtiles",
          path: "tiles/grid/grid_v1.pmtiles",
          tile_px: 512,
          thumb_px: 64,
          cap: 64,
          levels: [{ z: 0, tile_count: 1 }],
          z_cap: 0,
        },
        detail,
      },
    ],
    dataset_metadata: { image_count: 16, ingest_timestamp: "2026-01-01T00:00:00Z" },
  } as LayoutManifest;
}

/** A minimal ApiClient: only staticDetailUrl / authHeaders / refreshDatasetCredential
 *  are reached by the overlay. staticDetailUrl encodes the cell id so a fake fetch can
 *  correlate a request back to its cell. */
function overlayClient(opts: { refresh?: () => Promise<boolean> } = {}): ApiClient {
  return {
    staticDetailUrl: (ds: string, id: number) => `detail://${ds}/${id}`,
    authHeaders: () => ({}),
    refreshDatasetCredential: opts.refresh ?? (async () => false),
  } as unknown as ApiClient;
}

function fakeResponse(status: number): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    async blob() {
      return new Blob([]);
    },
  } as unknown as Response;
}

/** Stub decode: a bare GL-free THREE.Texture with the given decoded dims (for LRU
 *  byte accounting = w×h×4). */
function decodeStub(w = 256, h = 256): (blob: Blob, rung: number) => Promise<DecodedDetail> {
  return async () => ({ texture: new THREE.Texture(), width: w, height: h });
}

// ---------------------------------------------------------------------------
// 1. Gate (pure)
// ---------------------------------------------------------------------------

test("detailGateEngaged engages at engageCellPx and holds until releaseCellPx (hysteresis)", () => {
  const c = DEFAULT_DETAIL_OVERLAY_CONFIG;
  // From disengaged: needs >= 128 to turn on.
  assert.equal(detailGateEngaged(false, 127, 10, true, c), false);
  assert.equal(detailGateEngaged(false, 128, 10, true, c), true);
  // From engaged: holds until below 96.
  assert.equal(detailGateEngaged(true, 96, 10, true, c), true);
  assert.equal(detailGateEngaged(true, 95, 10, true, c), false);
  // In the hysteresis band [96, 128) the state is sticky (no flapping).
  assert.equal(detailGateEngaged(false, 110, 10, true, c), false, "band: disengaged stays off");
  assert.equal(detailGateEngaged(true, 110, 10, true, c), true, "band: engaged stays on");
});

test("detailGateEngaged hard-skips above the in-view cap regardless of cell size", () => {
  const c = DEFAULT_DETAIL_OVERLAY_CONFIG;
  assert.equal(detailGateEngaged(false, 10_000, c.maxOverlayCells + 1, true, c), false);
  assert.equal(detailGateEngaged(true, 10_000, c.maxOverlayCells + 1, true, c), false, "even mid-engage");
  assert.equal(detailGateEngaged(false, 10_000, c.maxOverlayCells, true, c), true, "at the cap it still engages");
});

test("detailGateEngaged is permanently off when disabled (no detail block / no positions)", () => {
  const c = DEFAULT_DETAIL_OVERLAY_CONFIG;
  assert.equal(detailGateEngaged(false, 10_000, 1, false, c), false);
  assert.equal(detailGateEngaged(true, 10_000, 1, false, c), false);
});

// ---------------------------------------------------------------------------
// Pure helpers: rung ladder + cover-crop
// ---------------------------------------------------------------------------

test("rungFor rounds screen px UP into the decode ladder, capped at 2048", () => {
  assert.equal(rungFor(1), 256);
  assert.equal(rungFor(256), 256);
  assert.equal(rungFor(257), 512);
  assert.equal(rungFor(1024), 1024);
  assert.equal(rungFor(1025), 2048);
  assert.equal(rungFor(4000), 2048, "capped at the coarsest baked cap");
});

test("coverCropUvs centre-crops the image to a square (matching the 64px thumb framing)", () => {
  // Square image: no crop.
  assert.deepEqual(coverCropUvs(1), { uMin: 0, uMax: 1, vMin: 0, vMax: 1 });
  // Landscape 2:1: crop width to the centre half; full height.
  const wide = coverCropUvs(2);
  assert.ok(Math.abs(wide.uMin - 0.25) < 1e-9 && Math.abs(wide.uMax - 0.75) < 1e-9, "centre half width");
  assert.deepEqual([wide.vMin, wide.vMax], [0, 1], "full height");
  // Portrait 1:2: crop height to the centre half; full width.
  const tall = coverCropUvs(0.5);
  assert.deepEqual([tall.uMin, tall.uMax], [0, 1], "full width");
  assert.ok(Math.abs(tall.vMin - 0.25) < 1e-9 && Math.abs(tall.vMax - 0.75) < 1e-9, "centre half height");
});

test("scan-time coincidence dedupe collapses a co-located pile to its lowest-id representative (T2-72)", () => {
  const state: CameraState = { center: [0.5, 0.5], zoom: 1 / 2000 }; // ~1 world unit = 2000 px
  // Ids 1,2,3 are coincident (one scatter point — identical rijks dimensions); ids 0 and 4
  // are elsewhere. mergePx*zoom ≈ 4/2000 = 0.002 world units.
  const table = posTable([
    { x: 0.10, y: 0.10, w: 0.001, h: 0.001 },
    { x: 0.5000, y: 0.5000, w: 0.001, h: 0.001 },
    { x: 0.5001, y: 0.5000, w: 0.001, h: 0.001 },
    { x: 0.5000, y: 0.5001, w: 0.001, h: 0.001 },
    { x: 0.90, y: 0.90, w: 0.001, h: 0.001 },
  ]);
  const view = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const out = collectPositionsInView(table, view, 100, coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX));
  const ids = out.map((c) => c.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [0, 1, 4], "the pile collapses to its lowest id (1); 0 and 4 survive");
});

test("scan-time dedupe leaves a resolved cloud untouched at deep zoom (zoom-aware)", () => {
  // The SAME three points, but zoomed in 1000× — now they are hundreds of px apart on screen,
  // so they must NOT merge (only true coincidence collapses).
  const deep: CameraState = { center: [0.5, 0.5], zoom: 1 / 2_000_000 };
  const table = posTable([
    { x: 0.5000, y: 0.5000, w: 0.001, h: 0.001 },
    { x: 0.5001, y: 0.5000, w: 0.001, h: 0.001 },
    { x: 0.5000, y: 0.5001, w: 0.001, h: 0.001 },
  ]);
  const view = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const out = collectPositionsInView(table, view, 100, coincidenceMergeWorld(deep, COINCIDENCE_MERGE_PX));
  assert.equal(out.length, 3, "resolved cloud kept");
});

test("a pile no longer starves the candidate budget — dedupe runs BEFORE the maxN cap (PR-179 review)", () => {
  // 300 coincident cells (one pile, ids 0..299) followed by 50 spread cells (ids 300..349),
  // budget 40. The old post-hoc dedupe let the pile consume 300 of the slots during the
  // scan, so the spread cells were never collected; the scan-time dedupe charges the pile
  // ONE slot and the spread cells fill the rest.
  const state: CameraState = { center: [0.5, 0.5], zoom: 1 / 2000 };
  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < 300; i++) cells.push({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 });
  for (let i = 0; i < 50; i++) cells.push({ x: 0.1 + i * 0.015, y: 0.2, w: 0.001, h: 0.001 });
  const table = posTable(cells);
  const view = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const out = collectPositionsInView(table, view, 40, coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX));
  assert.equal(out.length, 40, "the budget fills");
  const pileMembers = out.filter((c) => c.id < 300);
  assert.equal(pileMembers.length, 1, "the pile costs exactly one slot");
  assert.equal(pileMembers[0].id, 0, "…and it is the lowest-id representative");
  assert.equal(out.filter((c) => c.id >= 300).length, 39, "the spread cells fill the remaining budget");
});

// ---------------------------------------------------------------------------
// Overlay engage / release + explicit renderOrder (drives the real refresh path)
// ---------------------------------------------------------------------------

test("overlay engages past the gate (drawing detail quads above the cells) and releases below it", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02); // median world cell width 0.02
  const client = overlayClient();
  const urls: string[] = [];
  const deps = {
    fetch: async (url: string) => {
      urls.push(url);
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({
    manifest: detailManifest(),
    positions: posTable([
      { x: 0.49, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.51, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });

  // Zoomed OUT: cellPx = median/zoom×dpr = 0.02/0.001 = 20 < 128 → disengaged.
  w.emit(cam(0.001), VP);
  await settle();
  assert.equal(overlay.isEngaged(), false, "zoomed out → disengaged");
  assert.equal(overlay.overlayCount(), 0, "no overlay quads while disengaged");
  assert.equal(urls.length, 0, "no fetches while disengaged");

  // Zoomed IN: cellPx = 0.02/0.0001 = 200 ≥ 128 → engaged; both in-view cells fetched + drawn.
  w.emit(cam(0.0001), VP);
  await settle();
  assert.equal(overlay.isEngaged(), true, "zoomed in past the gate → engaged");
  assert.equal(overlay.overlayCount(), 2, "both visible cells got detail quads");
  assert.equal(urls.length, 2, "one fetch per visible cell");

  // Overlay meshes carry the explicit renderOrder (DoD #4 — above coarse + cells).
  const meshes = [...w.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert.ok(meshes.length >= 2, "overlay drew quads into the scene");
  assert.ok(meshes.every((m) => m.renderOrder === RENDER_ORDER_OVERLAY), "overlay quads set renderOrder explicitly");

  // Zoom back out → release (quads removed) but the decoded textures stay CACHED.
  w.emit(cam(0.001), VP);
  await settle();
  assert.equal(overlay.isEngaged(), false, "zoom back out → released");
  assert.equal(overlay.overlayCount(), 0, "quads removed on release");
  assert.equal(overlay.cachedCount(), 2, "decoded textures survive the release for an instant re-engage");
});

test("R1: a zoomed-out refresh reads ZERO position-table rows (px short-circuit before the O(N) scan)", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  const deps = { fetch: async () => fakeResponse(200), decode: decodeStub() };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  const { table, reads } = countingPosTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]);
  overlay.setContext({ manifest: detailManifest(), positions: table });

  // Zoomed OUT: cellPx = 0.02/0.01 = 2 ≪ 128 → the gate is false on the px axis alone,
  // so NEITHER countPositionsInView NOR collectPositionsInView runs — no row is touched.
  w.emit(cam(0.01), VP);
  await settle();
  assert.equal(overlay.isEngaged(), false, "zoomed out → disengaged");
  assert.equal(reads(), 0, "no position-table row read while zoomed out (the O(N) scan is skipped)");

  // Zoomed IN past the gate: NOW the table IS scanned (count + candidates) — proving the
  // zero above is the px short-circuit, not a dead/unreachable table.
  w.emit(cam(0.0001), VP);
  await settle();
  assert.equal(overlay.isEngaged(), true, "zoomed in → engaged");
  assert.ok(reads() > 0, "engaged → the position table is scanned");
});

test("R2: an exhausted retry budget is RESET on disengage → re-engage retries again", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  let fetches = 0;
  const deps = {
    fetch: async () => {
      fetches++;
      return fakeResponse(500); // a persistent transient failure (5xx) → bounded retries
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

  // Capture the retry backoff timers so we can fire them without waiting the real ~7s.
  const realSetTimeout = globalThis.setTimeout;
  const pending: Array<() => void> = [];
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    pending.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    // Engage: the fetch fails (500) → schedules retry 1. Fire retries until the 3-retry
    // budget is exhausted (initial fetch + 3 retries = 4 fetches, then no more scheduled).
    w.emit(cam(0.0001), VP);
    await settle();
    for (let i = 0; i < 6 && pending.length > 0; i++) {
      for (const fn of pending.splice(0)) fn();
      await settle();
    }
    const fetchesAtExhaust = fetches;
    assert.ok(fetchesAtExhaust >= 4, "initial fetch + 3 backoff retries fired");
    assert.equal(pending.length, 0, "budget exhausted — no further retry scheduled");
    assert.equal(overlay.overlayCount(), 0, "nothing drawn while the server fails");

    // Disengage (zoom out) → releaseDrawn resets the per-cell retry budget (R2).
    w.emit(cam(0.001), VP);
    await settle();

    // Re-engage with the server STILL failing: WITH the budget reset, a fresh retry is
    // scheduled; WITHOUT R2, scheduleRetry sees the spent budget and gives up (the cell
    // would be permanently skipped for the rest of the session even after recovery).
    w.emit(cam(0.0001), VP);
    await settle();
    assert.ok(fetches > fetchesAtExhaust, "re-engage issued a fresh fetch");
    assert.ok(pending.length > 0, "a fresh retry was scheduled after re-engage (budget reset by releaseDrawn)");
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
});

test("the overlay gates OFF for an image_ref block with NO path_prefix (matches staticDetailUrl's predicate)", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02); // median 0.02 → 200px at zoom 1e-4 → would engage
  const client = overlayClient();
  let fetches = 0;
  const deps = {
    fetch: async () => {
      fetches++;
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  // mode image_ref but NO path_prefix: staticDetailUrl would SKIP this block (and fall to
  // the authed /api route mid-burst), so activeDetail must skip it too — the overlay stays
  // OFF. Schema-illegal (path_prefix is required for image_ref), but keeping the enable
  // predicate identical to the URL builder's makes the divergence impossible by construction.
  overlay.setContext({
    manifest: detailManifest({ mode: "image_ref", format: "webp" } as DetailDescriptor),
    positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]),
  });
  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  assert.equal(overlay.isEngaged(), false, "no path_prefix → overlay disabled (gate never engages)");
  assert.equal(fetches, 0, "nothing fetched without a resolvable detail prefix");
  assert.equal(overlay.overlayCount(), 0, "no quads drawn");
});

test("a cell below the per-cell release px is NOT fetched, even when a larger median engaged the gate", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02); // median 0.02 → 200px at zoom 1e-4 → gate engaged
  const client = overlayClient();
  const urls: string[] = [];
  const deps = {
    fetch: async (url: string) => {
      urls.push(url);
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  // Two cells in view: cell 0 is large (0.02 → 200px ≥ 96 release-px floor); cell 1 is tiny
  // (0.005 → 50px < 96). The median (0.02) engages the gate, but the tiny cell is not itself
  // blurry, so it must stay on the pyramid — only the large cell is fetched/drawn.
  overlay.setContext({
    manifest: detailManifest(),
    positions: posTable([
      { x: 0.49, y: 0.5, w: 0.02, h: 0.02 }, // 0: 200px on screen
      { x: 0.51, y: 0.5, w: 0.005, h: 0.005 }, // 1: 50px on screen — below the floor
    ]),
  });
  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  assert.equal(overlay.isEngaged(), true, "the median cell size engaged the gate");
  assert.equal(overlay.overlayCount(), 1, "only the large cell got a detail quad");
  assert.deepEqual(urls, ["detail://ds/0"], "the sub-floor tiny cell was never fetched");
});

// ---------------------------------------------------------------------------
// 2. LRU: keying + survives layout switch + cleared on dispose
// ---------------------------------------------------------------------------

test("overlay LRU keys by (ds, version, cellId), survives a layout switch, and clears on dispose", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  const urls: string[] = [];
  const deps = {
    fetch: async (url: string) => {
      urls.push(url);
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const manifest = detailManifest();
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({
    manifest,
    positions: posTable([
      { x: 0.49, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.51, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });
  w.emit(cam(0.0001), VP);
  await settle();

  assert.deepEqual(
    overlay.cachedKeys().sort(),
    ["ds/v1/0", "ds/v1/1"],
    "LRU keys embed dataset id + version + dense cell id",
  );
  const fetchesBefore = urls.length;
  assert.equal(fetchesBefore, 2);

  // Layout SWITCH: same manifest (same dataset+version), the SAME cell ids but MOVED —
  // the decoded textures must survive (cell ids are layout-invariant) and NOT re-fetch.
  overlay.setContext({
    manifest,
    positions: posTable([
      { x: 0.48, y: 0.5, w: 0.02, h: 0.02 },
      { x: 0.52, y: 0.5, w: 0.02, h: 0.02 },
    ]),
  });
  await settle();
  assert.deepEqual(overlay.cachedKeys().sort(), ["ds/v1/0", "ds/v1/1"], "textures survive the layout switch");
  assert.equal(urls.length, fetchesBefore, "no re-fetch across a layout switch (cache reused)");
  assert.equal(overlay.overlayCount(), 2, "cells redrawn at their new positions from cache");

  overlay.dispose();
  assert.equal(overlay.cachedCount(), 0, "LRU disposed on teardown");
  assert.equal(overlay.overlayCount(), 0, "quads removed on teardown");
});

// ---------------------------------------------------------------------------
// 2. LRU: byte-budget eviction (oldest non-drawn first; a drawn quad is never evicted)
// ---------------------------------------------------------------------------

test("overlay LRU byte budget evicts the oldest NON-drawn texture; drawn quads are never evicted", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  const deps = { fetch: async () => fakeResponse(200), decode: decodeStub(256, 256) };
  const bytesPer = 256 * 256 * 4;
  const config = { ...DEFAULT_DETAIL_OVERLAY_CONFIG, textureBudgetBytes: 3 * bytesPer, maxEntries: 512 };
  const overlay = createDetailOverlay(w.world, cells, client, config, deps);
  // Four cells 0.25 apart: at zoom 1e-4 the viewport (halfW 0.05) sees exactly one at a
  // time, so visiting them in sequence gives DETERMINISTIC recency (0 oldest … 3 newest).
  overlay.setContext({
    manifest: detailManifest(),
    positions: posTable([
      { x: 0.1, y: 0.5, w: 0.02, h: 0.02 }, // 0
      { x: 0.35, y: 0.5, w: 0.02, h: 0.02 }, // 1
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 }, // 2
      { x: 0.85, y: 0.5, w: 0.02, h: 0.02 }, // 3
    ]),
  });

  // Visit cells 0,1,2 in order: each becomes cached; each prior leaves view (cached,
  // not drawn). After cell 2 the cache holds {0,1,2} — exactly the 3-texture budget.
  for (const cx of [0.1, 0.35, 0.6]) {
    w.emit(cam(0.0001, cx, 0.5), VP);
    await settle();
  }
  assert.deepEqual(overlay.cachedKeys().sort(), ["ds/v1/0", "ds/v1/1", "ds/v1/2"]);

  // Visit cell 3: a 4th texture over the 3-texture budget → the OLDEST non-drawn (cell
  // 0) is evicted; cell 3 (the only drawn quad now) is never evicted.
  w.emit(cam(0.0001, 0.85, 0.5), VP);
  await settle();
  assert.equal(overlay.overlayCount(), 1, "only the current cell is drawn");
  assert.ok(overlay.cachedBytes() <= config.textureBudgetBytes, "cache trimmed to the byte budget");
  const keys = overlay.cachedKeys();
  assert.equal(keys.length, 3, "cache held to the entry budget");
  assert.ok(!keys.includes("ds/v1/0"), "the oldest non-drawn texture (cell 0) was evicted");
  assert.ok(keys.includes("ds/v1/3"), "the drawn quad's texture is never evicted");
});

// ---------------------------------------------------------------------------
// 4. Fetch discipline: abort on leave-view / 404 permanent skip / 401 refresh+retry
// ---------------------------------------------------------------------------

test("a fetch is aborted when its cell leaves the view (supersede, not run-to-completion)", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  const signals = new Map<string, AbortSignal>();
  const deps = {
    // Never resolves: the load stays in-flight across the pan so we can inspect its abort.
    fetch: (url: string, init: { signal: AbortSignal }) => {
      signals.set(url, init.signal);
      return new Promise<Response>(() => {});
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

  // View the cell: issues an in-flight fetch.
  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  const sig = signals.get("detail://ds/0");
  assert.ok(sig !== undefined, "the visible cell issued a detail fetch");
  assert.equal(sig!.aborted, false, "it starts un-aborted");
  assert.equal(overlay.inflightCount(), 1, "one fetch in flight");

  // Pan away: the cell leaves the view → its in-flight fetch is aborted.
  w.emit(cam(0.0001, 0.05, 0.5), VP);
  await settle();
  assert.equal(sig!.aborted, true, "leaving the view aborted the in-flight detail fetch");
  assert.equal(overlay.inflightCount(), 0, "the aborted fetch left the in-flight set");
});

test("a 404 is a PERMANENT skip for (dataset, version, cellId) — never re-fetched", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  let cell0Fetches = 0;
  const deps = {
    fetch: async (url: string) => {
      if (url === "detail://ds/0") cell0Fetches++;
      return fakeResponse(404);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  assert.equal(cell0Fetches, 1, "the cell was fetched once");
  assert.equal(overlay.cachedCount(), 0, "a 404 caches nothing (cell stays on the pyramid)");

  // Pan away and back: the 404'd cell must NOT be re-fetched (no retry storm; covers
  // skip-tier datasets + #67 subsampled cells).
  w.emit(cam(0.0001, 0.9, 0.5), VP);
  await settle();
  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  assert.equal(cell0Fetches, 1, "404 is permanent — no re-fetch on re-visit");
  assert.equal(overlay.overlayCount(), 0, "still nothing drawn for the absent original");
});

test("a static-edge 401 triggers ONE credential refresh then a single retry", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  let refreshes = 0;
  const client = overlayClient({
    refresh: async () => {
      refreshes++;
      return true; // cookie re-issued
    },
  });
  let fetches = 0;
  const deps = {
    fetch: async () => {
      fetches++;
      return fakeResponse(fetches === 1 ? 401 : 200); // first 401, retry 200
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  assert.equal(refreshes, 1, "the 401 triggered exactly one credential refresh");
  assert.equal(fetches, 2, "the read was retried once after the refresh");
  assert.equal(overlay.overlayCount(), 1, "the retry succeeded and the cell got its detail quad");
});

// ---------------------------------------------------------------------------
// WebGL context loss: drop the dead textures, re-fetch on restore (additive safety)
// ---------------------------------------------------------------------------

test("a WebGL context loss drops the overlay's textures; restore re-fetches them", async () => {
  const w = createStubWorld();
  const cells = createStubCells(0.02);
  const client = overlayClient();
  let fetches = 0;
  const deps = {
    fetch: async () => {
      fetches++;
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, cells, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });
  w.emit(cam(0.0001, 0.5, 0.5), VP);
  await settle();
  assert.equal(overlay.overlayCount(), 1, "cell drawn before the loss");
  const fetchesBeforeLoss = fetches;

  // Loss: dead GPU handles dropped so nothing stale renders on restore.
  w.fireContextLost();
  assert.equal(overlay.overlayCount(), 0, "drawn quads dropped on context loss");
  assert.equal(overlay.cachedCount(), 0, "cached textures dropped on context loss");

  // Restore: the same view re-fetches + re-binds (bitmaps were closed after upload; the
  // re-fetch is what makes that safe — the overlay never re-uploads a dead texture).
  w.fireContextRestored();
  await settle();
  assert.ok(fetches > fetchesBeforeLoss, "restore re-fetched the visible cell");
  assert.equal(overlay.overlayCount(), 1, "the cell re-bound its detail quad after restore");
});
