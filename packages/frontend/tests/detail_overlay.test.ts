// Tier-1 (T2-26): the renderer detail overlay (src/renderer/detailOverlay.ts).
// GL-free via the DI seam (createDetailOverlay's `deps`: a fake fetch that records
// signals + returns canned statuses, a stub decode that returns a bare THREE.Texture)
// + the GL-free stub world — so the orchestration (gate hysteresis, LRU byte
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
  largestCellWidth,
  COINCIDENCE_MERGE_PX,
  DEFAULT_DETAIL_OVERLAY_CONFIG,
  RENDER_ORDER_OVERLAY,
} from "../src/renderer/detailOverlay.ts";
import type { DecodedDetail } from "../src/renderer/detailOverlay.ts";
import { countPositionsInView, scanPositionsInView } from "../src/renderer/cells.ts";
import type { CellCandidate, PositionTable } from "../src/renderer/cells.ts";
import type { DetailDescriptor, LayoutManifest } from "../src/renderer/layout.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { CameraState, Viewport } from "../src/renderer/world.ts";
import { bboxFromCamera, RETRY_ATTEMPT_BACKOFF_MS } from "../src/renderer/tilePyramid.ts";
import { createStubWorld } from "./fake_client.ts";

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

/** The REFERENCE implementation of the overlay's candidate collection: what
 *  `collectPositionsInView` in `cells.ts` did until PR #409 (round-3 review, D2) moved it
 *  here once `scanPositionsInView` replaced it in production. Up to `maxN` in-view cells in
 *  dense-id order, coincident cells (`dedupeCellWorld` grid) collapsed to their lowest id
 *  DURING the scan, so a pile costs one slot of the `maxN` cap (the PR-179 review finding).
 *  The property test checks `scanPositionsInView`'s candidates against it. */
function collectReference(
  table: PositionTable,
  view: { xMin: number; yMin: number; xMax: number; yMax: number },
  maxN: number,
  dedupeCellWorld?: number,
): CellCandidate[] {
  const { x, y, w, h, count } = table;
  const dedupe = dedupeCellWorld !== undefined && dedupeCellWorld > 0 ? new Set<string>() : null;
  const cell = dedupeCellWorld ?? 0;
  const out: CellCandidate[] = [];
  for (let i = 0; i < count && out.length < maxN; i++) {
    const hw = w[i] / 2;
    const hh = h[i] / 2;
    if (x[i] + hw > view.xMin && x[i] - hw < view.xMax && y[i] + hh > view.yMin && y[i] - hh < view.yMax) {
      if (dedupe !== null) {
        const key = `${Math.round(x[i] / cell)},${Math.round(y[i] / cell)}`;
        if (dedupe.has(key)) continue; // coincident with a kept lower-id representative
        dedupe.add(key);
      }
      out.push({ id: i, x: x[i], y: y[i], w: w[i], h: h[i] });
    }
  }
  return out;
}

/** A PositionTable whose x/y/w/h are Proxy-wrapped to COUNT numeric-index reads — so a
 *  test can prove the O(N) position scan is (or is not) touched on a given refresh (R1). */
function countingPosTable(cells: { x: number; y: number; w: number; h: number }[]): {
  table: PositionTable;
  reads: () => number;
  /** Reads of the `w` column alone (a scan reads each row's width once per pass). */
  wReads: () => number;
} {
  let n = 0;
  let nW = 0;
  const wrap = (values: number[], isW = false): Float32Array => {
    const arr = Float32Array.from(values);
    return new Proxy(arr, {
      get(target, prop) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          n++; // an x[i]/y[i]/w[i]/h[i] read
          if (isW) nW++;
        }
        return Reflect.get(target, prop);
      },
    }) as unknown as Float32Array;
  };
  return {
    table: {
      x: wrap(cells.map((c) => c.x)),
      y: wrap(cells.map((c) => c.y)),
      w: wrap(cells.map((c) => c.w), true),
      h: wrap(cells.map((c) => c.h)),
      count: cells.length,
    },
    reads: () => n,
    wReads: () => nW,
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
  const out = scanPositionsInView(table, view, 100, coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX)).candidates;
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
  const out = scanPositionsInView(table, view, 100, coincidenceMergeWorld(deep, COINCIDENCE_MERGE_PX)).candidates;
  assert.equal(out.length, 3, "resolved cloud kept");
});

test("a pile no longer starves the candidate budget — dedupe runs BEFORE the maxN cap (PR-179 review)", () => {
  // 300 coincident cells (one pile, ids 0..299) followed by 50 spread cells (ids 300..349),
  // budget 40. The old post-hoc dedupe let the pile consume 300 of the slots during the
  // scan, so the spread cells were never collected; the scan-time dedupe charges the pile
  // ONE slot and the spread cells fill the rest.
  // Since PR #409 (round-3 review, D2) this pins the REFERENCE implementation, collectReference:
  // its 350 in-view cells are over a budget of 40, and production's scanPositionsInView returns
  // no candidates over its cap by contract. The scan's own pile behaviour is pinned by the next
  // test and by the property test.
  const state: CameraState = { center: [0.5, 0.5], zoom: 1 / 2000 };
  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < 300; i++) cells.push({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 });
  for (let i = 0; i < 50; i++) cells.push({ x: 0.1 + i * 0.015, y: 0.2, w: 0.001, h: 0.001 });
  const table = posTable(cells);
  const view = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const out = collectReference(table, view, 40, coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX));
  assert.equal(out.length, 40, "the budget fills");
  const pileMembers = out.filter((c) => c.id < 300);
  assert.equal(pileMembers.length, 1, "the pile costs exactly one slot");
  assert.equal(pileMembers[0].id, 0, "…and it is the lowest-id representative");
  assert.equal(out.filter((c) => c.id >= 300).length, 39, "the spread cells fill the remaining budget");
});

test("scanPositionsInView: a pile is one candidate, and every pile member still counts toward the cap", () => {
  // The same 300-cell pile + 50 spread cells, within the scan's cap (350 ≤ 400).
  const state: CameraState = { center: [0.5, 0.5], zoom: 1 / 2000 };
  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < 300; i++) cells.push({ x: 0.5, y: 0.5, w: 0.001, h: 0.001 });
  for (let i = 0; i < 50; i++) cells.push({ x: 0.1 + i * 0.015, y: 0.2, w: 0.001, h: 0.001 });
  const table = posTable(cells);
  const view = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const merge = coincidenceMergeWorld(state, COINCIDENCE_MERGE_PX);
  const within = scanPositionsInView(table, view, 400, merge);
  assert.equal(within.inView, 350, "the raw count counts every pile member");
  const pile = within.candidates.filter((c) => c.id < 300);
  assert.deepEqual(pile.map((c) => c.id), [0], "the pile is ONE candidate: its lowest id");
  assert.equal(within.candidates.length, 51, "…beside the 50 spread cells");
  // The same view against a cap of 340: the pile's members push the raw count over it.
  const over = scanPositionsInView(table, view, 340, merge);
  assert.equal(over.inView, 341, "over the cap: the count stops at cap + 1");
  assert.deepEqual(over.candidates, [], "over the cap: no candidates");
});

// ---------------------------------------------------------------------------
// Overlay engage / release + explicit renderOrder (drives the real refresh path)
// ---------------------------------------------------------------------------

test("overlay engages past the gate (drawing detail quads above the cells) and releases below it", async () => {
  const w = createStubWorld();
  const client = overlayClient();
  const urls: string[] = [];
  const deps = {
    fetch: async (url: string) => {
      urls.push(url);
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const client = overlayClient();
  const deps = { fetch: async () => fakeResponse(200), decode: decodeStub() };
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
  const { table, reads } = countingPosTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]);
  overlay.setContext({ manifest: detailManifest(), positions: table });
  const readsAtBind = reads();

  // Zoomed OUT: cellPx = 0.02/0.01 = 2 ≪ 128 → the gate is false on the px axis alone,
  // so the table scan (scanPositionsInView) does not run — no row is touched.
  w.emit(cam(0.01), VP);
  await settle();
  assert.equal(overlay.isEngaged(), false, "zoomed out → disengaged");
  assert.equal(reads() - readsAtBind, 0, "no position-table row read while zoomed out (the O(N) scan is skipped)");

  // Zoomed IN past the gate: NOW the table IS scanned (count + candidates) — proving the
  // zero above is the px short-circuit, not a dead/unreachable table.
  w.emit(cam(0.0001), VP);
  await settle();
  assert.equal(overlay.isEngaged(), true, "zoomed in → engaged");
  assert.ok(reads() > 0, "engaged → the position table is scanned");
});

test("R2: an exhausted retry budget is RESET on disengage → re-engage retries again", async () => {
  // Capture the retry backoff timers so we can fire them without waiting the real ~7s.
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const client = overlayClient();
    let fetches = 0;
    const deps = {
      fetch: async () => {
        fetches++;
        return fakeResponse(500); // a persistent transient failure (5xx) → bounded retries
      },
      decode: decodeStub(),
    };
    const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    // Engage: the fetch fails (500) → schedules retry 1. Fire retries until the 3-retry
    // budget is exhausted (initial fetch + 3 retries = 4 fetches, then no more scheduled).
    w.emit(cam(0.0001), VP);
    await settle();
    for (let i = 0; i < 6 && clock.pending() > 0; i++) {
      clock.fireAll();
      await settle();
    }
    const fetchesAtExhaust = fetches;
    assert.ok(fetchesAtExhaust >= 4, "initial fetch + 3 backoff retries fired");
    assert.equal(clock.pending(), 0, "budget exhausted — no further retry scheduled");
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
    assert.ok(clock.pending() > 0, "a fresh retry was scheduled after re-engage (budget reset by releaseDrawn)");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("the overlay gates OFF for an image_ref block with NO path_prefix (matches staticDetailUrl's predicate)", async () => {
  const w = createStubWorld();
  const client = overlayClient();
  let fetches = 0;
  const deps = {
    fetch: async () => {
      fetches++;
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const client = overlayClient();
  const urls: string[] = [];
  const deps = {
    fetch: async (url: string) => {
      urls.push(url);
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const client = overlayClient();
  const deps = { fetch: async () => fakeResponse(200), decode: decodeStub(256, 256) };
  const bytesPer = 256 * 256 * 4;
  const config = { ...DEFAULT_DETAIL_OVERLAY_CONFIG, textureBudgetBytes: 3 * bytesPer, maxEntries: 512 };
  const overlay = createDetailOverlay(w.world, client, config, deps);
  // Changed by the operator on 2026-09-29 (PR #409 review, C2): the budget now counts only
  // the recently-LEFT (non-drawn) textures, which is what the textureBudgetBytes doc always
  // said. Counting the drawn quads too let a full view evict its own pan-back cache (measured
  // on #409: 34 of 350 left textures kept, 316 re-fetched on the pan back). So this test now
  // needs a FIFTH visit before anything is evicted, and checks the non-drawn bytes.
  //
  // Five cells 0.2 apart: at zoom 1e-4 the viewport (halfW 0.05) sees exactly one at a
  // time, so visiting them in sequence gives DETERMINISTIC recency (0 oldest … 4 newest).
  overlay.setContext({
    manifest: detailManifest(),
    positions: posTable([
      { x: 0.1, y: 0.5, w: 0.02, h: 0.02 }, // 0
      { x: 0.3, y: 0.5, w: 0.02, h: 0.02 }, // 1
      { x: 0.5, y: 0.5, w: 0.02, h: 0.02 }, // 2
      { x: 0.7, y: 0.5, w: 0.02, h: 0.02 }, // 3
      { x: 0.9, y: 0.5, w: 0.02, h: 0.02 }, // 4
    ]),
  });

  // Visit cells 0..3 in order: each becomes cached; each prior leaves view (cached, not
  // drawn). After cell 3 the left textures are {0,1,2} — exactly the 3-texture budget — and
  // the drawn cell 3 does not count, so nothing has been evicted.
  for (const cx of [0.1, 0.3, 0.5, 0.7]) {
    w.emit(cam(0.0001, cx, 0.5), VP);
    await settle();
  }
  assert.deepEqual(overlay.cachedKeys().sort(), ["ds/v1/0", "ds/v1/1", "ds/v1/2", "ds/v1/3"], "the drawn quad does not count");

  // Visit cell 4: four left textures {0,1,2,3} over the 3-texture budget → the OLDEST
  // non-drawn (cell 0) is evicted; cell 4 (the only drawn quad now) is never evicted.
  w.emit(cam(0.0001, 0.9, 0.5), VP);
  await settle();
  assert.equal(overlay.overlayCount(), 1, "only the current cell is drawn");
  assert.ok(overlay.cachedBytes() - bytesPer <= config.textureBudgetBytes, "the non-drawn bytes are within the budget");
  const keys = overlay.cachedKeys();
  assert.equal(keys.length, 4, "three left textures (the byte budget: 3 × 256 KiB; maxEntries is 512) + the drawn one");
  assert.ok(!keys.includes("ds/v1/0"), "the oldest non-drawn texture (cell 0) was evicted");
  assert.ok(keys.includes("ds/v1/4"), "the drawn quad's texture is never evicted");
});

test("drawn quads alone over the texture budget do not evict a recently-left texture (PR #409 review, C2)", async () => {
  const w = createStubWorld();
  const urls: string[] = [];
  const deps = {
    fetch: async (url: string) => {
      urls.push(url);
      return fakeResponse(200);
    },
    decode: decodeStub(256, 256),
  };
  const bytesPer = 256 * 256 * 4;
  const config = { ...DEFAULT_DETAIL_OVERLAY_CONFIG, textureBudgetBytes: 2 * bytesPer, maxEntries: 512 };
  const overlay = createDetailOverlay(w.world, overlayClient(), config, deps);
  // View A holds cell 0 alone; view B (0.5 away) holds cells 1-3 together.
  overlay.setContext({
    manifest: detailManifest(),
    positions: posTable([
      { x: 0.1, y: 0.5, w: 0.02, h: 0.02 }, // 0: view A
      { x: 0.575, y: 0.5, w: 0.02, h: 0.02 }, // 1: view B
      { x: 0.6, y: 0.5, w: 0.02, h: 0.02 }, // 2: view B
      { x: 0.625, y: 0.5, w: 0.02, h: 0.02 }, // 3: view B
    ]),
  });

  w.emit(cam(0.0001, 0.1, 0.5), VP);
  await settle();
  w.emit(cam(0.0001, 0.6, 0.5), VP);
  await settle();
  assert.equal(overlay.overlayCount(), 3, "fixture: view B draws its three cells");
  assert.ok(3 * bytesPer > config.textureBudgetBytes, "fixture: the drawn bytes alone are over the budget");
  assert.ok(overlay.cachedKeys().includes("ds/v1/0"), "the recently-left texture (cell 0) survives");

  const before = urls.length;
  w.emit(cam(0.0001, 0.1, 0.5), VP); // pan back to A
  await settle();
  assert.equal(overlay.overlayCount(), 1, "view A is drawn again");
  assert.equal(urls.length, before, "from the cache: no re-fetch on the pan back");
});

// ---------------------------------------------------------------------------
// 4. Fetch discipline: abort on leave-view / 404 permanent skip / 401 refresh+retry
// ---------------------------------------------------------------------------

test("a fetch is aborted when its cell leaves the view (supersede, not run-to-completion)", async () => {
  const w = createStubWorld();
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
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const client = overlayClient();
  let cell0Fetches = 0;
  const deps = {
    fetch: async (url: string) => {
      if (url === "detail://ds/0") cell0Fetches++;
      return fakeResponse(404);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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
  const client = overlayClient();
  let fetches = 0;
  const deps = {
    fetch: async () => {
      fetches++;
      return fakeResponse(200);
    },
    decode: decodeStub(),
  };
  const overlay = createDetailOverlay(w.world, client, { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, deps);
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

// ---------------------------------------------------------------------------
// The fetch queue and the in-view gate (T2-the-detail-overlay-leaves-in-view-cells-blurry,
// brief_detail_overlay_loads_every_cell_seam.md §3). Every test above uses 4 cells or fewer
// and a fetch that answers at once, which is why none of them saw the cap go unrefilled.
// The harness below holds each request until the test answers it, counts how many are live
// at one time, and can stand in for requestAnimationFrame.
// ---------------------------------------------------------------------------

/** Past this many calls (the default; a test that expects more passes its own) the deferred
 *  fetch answers with a promise that never settles, so a runaway refill loop fails its test
 *  on the request count instead of hanging the run. */
const FETCH_CALL_CEILING = 60;

interface DeferredCall {
  id: number;
  /** This cell's 0-based request index (0 = its first request). */
  nth: number;
  signal: AbortSignal;
  /** Started, not yet answered, not aborted. */
  live: boolean;
  resolve(status: number): void;
}

interface DeferredFetch {
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  /** Every request, in the order the overlay made it. */
  calls: DeferredCall[];
  pending(): DeferredCall[];
  /** The largest number of requests live at one time (since the last resetMaxLive). */
  maxLive(): number;
  resetMaxLive(): void;
  /** The cell id a response body belongs to (a decode stub can attribute its decode). */
  idOf(blob: Blob): number;
}

/** A fetch that HOLDS each request until the test answers it (`call.resolve(status)`) and,
 *  when the overlay aborts it, rejects with an error named AbortError, as a browser fetch
 *  does. The overlay decides abort-or-failure on OUR signal (`ac.signal.aborted`), not on the
 *  error's name (PR #409 review, C3): a rejection here always comes with our signal aborted,
 *  and the C3 pin sends a foreign AbortError while our signal is NOT aborted.
 *  `auto(id, nth)` answers a request at once with a status, or returns null to hold it. */
function deferredFetch(
  auto: (id: number, nth: number) => number | null = () => null,
  ceiling = FETCH_CALL_CEILING,
): DeferredFetch {
  const calls: DeferredCall[] = [];
  const blobIds = new WeakMap<Blob, number>();
  let live = 0;
  let maxLive = 0;
  const fetch = (url: string, init: { signal: AbortSignal }): Promise<Response> => {
    const id = Number(url.slice(url.lastIndexOf("/") + 1)); // overlayClient: detail://ds/<id>
    const nth = calls.filter((c) => c.id === id).length;
    if (calls.length >= ceiling) {
      calls.push({ id, nth, signal: init.signal, live: false, resolve() {} });
      return new Promise<Response>(() => {});
    }
    let ok: (r: Response) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const promise = new Promise<Response>((res, rej) => {
      ok = res;
      fail = rej;
    });
    const call: DeferredCall = {
      id,
      nth,
      signal: init.signal,
      live: true,
      resolve(status: number): void {
        if (!call.live) return;
        call.live = false;
        live--;
        const blob = new Blob([]);
        blobIds.set(blob, id);
        ok({ status, ok: status >= 200 && status < 300, blob: async () => blob } as unknown as Response);
      },
    };
    init.signal.addEventListener("abort", () => {
      if (!call.live) return;
      call.live = false;
      live--;
      const err = new Error("aborted");
      err.name = "AbortError";
      fail(err);
    });
    calls.push(call);
    live++;
    maxLive = Math.max(maxLive, live);
    const status = auto(id, nth);
    if (status !== null) call.resolve(status);
    return promise;
  };
  return {
    fetch,
    calls,
    pending: () => calls.filter((c) => c.live),
    maxLive: () => maxLive,
    resetMaxLive: () => {
      maxLive = live;
    },
    idOf: (blob) => blobIds.get(blob) ?? -1,
  };
}

interface FakeFrame {
  /** Run the callbacks queued so far, once (a callback queued while they run waits). */
  flush(): void;
  restore(): void;
}

/** Stand in for requestAnimationFrame so a camera emit SCHEDULES its refresh instead of
 *  running it — the only way `refreshScheduled` is ever true between two test steps. Install
 *  it BEFORE createDetailOverlay (the overlay reads the global once, at creation), and
 *  restore it in a `finally`. */
function installFakeFrame(): FakeFrame {
  const g = globalThis as unknown as Record<string, unknown>;
  const prevRaf = g.requestAnimationFrame;
  const prevCaf = g.cancelAnimationFrame;
  let queue = new Map<number, (t: number) => void>();
  let nextHandle = 1;
  g.requestAnimationFrame = (cb: (t: number) => void): number => {
    const h = nextHandle++;
    queue.set(h, cb);
    return h;
  };
  g.cancelAnimationFrame = (h: number): void => {
    queue.delete(h);
  };
  return {
    flush(): void {
      const run = queue;
      queue = new Map();
      for (const cb of run.values()) cb(performance.now());
    },
    restore(): void {
      if (prevRaf === undefined) delete g.requestAnimationFrame;
      else g.requestAnimationFrame = prevRaf;
      if (prevCaf === undefined) delete g.cancelAnimationFrame;
      else g.cancelAnimationFrame = prevCaf;
    },
  };
}

interface FakeTimers {
  /** Backoff callbacks queued and not yet fired or cleared. */
  pending(): number;
  /** Run the callbacks queued so far, once (one queued while they run waits). */
  fireAll(): void;
  restore(): void;
}

/** Stand in for setTimeout and clearTimeout, so a backoff timer fires only when the test
 *  calls fireAll() and a cleared one never fires. Restore it in a `finally`, after
 *  `w.dispose()` (which clears the overlay's timers through the fake). */
function installFakeTimers(): FakeTimers {
  const g = globalThis as unknown as { setTimeout: unknown; clearTimeout: unknown };
  const realSet = g.setTimeout;
  const realClear = g.clearTimeout;
  let queue = new Map<number, () => void>();
  let nextHandle = 1;
  g.setTimeout = (fn: () => void): number => {
    const h = nextHandle++;
    queue.set(h, fn);
    return h;
  };
  g.clearTimeout = (h: number): void => {
    queue.delete(h);
  };
  return {
    pending: () => queue.size,
    fireAll(): void {
      const run = queue;
      queue = new Map();
      for (const fn of run.values()) fn();
    },
    restore(): void {
      g.setTimeout = realSet;
      g.clearTimeout = realClear;
    },
  };
}

/** `cols × rows` equal square cells of side `width` on a `pitch` grid centred on
 *  (cx, cy), in row-major id order (so id order is NOT focal order). */
function gridCells(
  cols: number,
  rows: number,
  cx: number,
  cy: number,
  pitch: number,
  width: number,
): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ x: cx + (c - (cols - 1) / 2) * pitch, y: cy + (r - (rows - 1) / 2) * pitch, w: width, h: width });
    }
  }
  return out;
}

/** Answer every pending request (`statusFor`, default 200), let the fetch chains run, and
 *  flush a frame when one is installed — until nothing is pending. Fails after 50 rounds, so
 *  a loop that keeps refilling cannot pass as a drained queue. */
async function drain(
  f: DeferredFetch,
  statusFor: (id: number, nth: number) => number = () => 200,
  frame?: FakeFrame,
): Promise<void> {
  for (let round = 0; round < 50; round++) {
    for (const c of f.pending()) c.resolve(statusFor(c.id, c.nth));
    await settle();
    frame?.flush();
    await settle();
    if (f.pending().length === 0) return;
  }
  assert.fail(`drain: ${f.pending().length} requests still pending after 50 rounds`);
}

function focalDist2(t: PositionTable, id: number, fx: number, fy: number): number {
  const dx = t.x[id] - fx;
  const dy = t.y[id] - fy;
  return dx * dx + dy * dy;
}

/** The mesh drawn for the only overlay quad in the scene (single-cell tests). */
function onlyQuad(w: ReturnType<typeof createStubWorld>): THREE.Mesh {
  const meshes = [...w.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert.equal(meshes.length, 1, "exactly one overlay quad is drawn");
  return meshes[0];
}

// Geometry shared by T1-T4, G1: at VP 1000×1000 and zoom 1e-4 the view is 0.1 world units
// wide; cells 0.015 wide at a 0.016 pitch are 150 CSS px each, and all 6 × 5 = 30 are in
// view — 2.5× maxInFlight, so finishing the view takes two refills or more.
const ENGAGED_ZOOM = 1e-4;
const GRID_CELLS = (): { x: number; y: number; w: number; h: number }[] => gridCells(6, 5, 0.5, 0.5, 0.016, 0.015);

test("T1: a still camera ends with every in-view cell drawn — freed slots are refilled, nearest first (rows 1, 8, 9)", async () => {
  const w = createStubWorld();
  const table = posTable(GRID_CELLS());
  assert.equal(countPositionsInView(table, bboxFromCamera(cam(ENGAGED_ZOOM), VP)), 30, "fixture: 30 cells in view");
  // The two 404 cells are the far corners (ids 0 and 29): not among the 12 nearest.
  const order = [...Array(30).keys()].sort((a, b) => focalDist2(table, a, 0.5, 0.5) - focalDist2(table, b, 0.5, 0.5));
  const MISSING = new Set([0, 29]);
  assert.ok(order.slice(0, 12).every((id) => !MISSING.has(id)), "fixture: the 404 cells are outside the first 12");
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });
  overlay.setContext({ manifest: detailManifest(), positions: table });

  w.emit(cam(ENGAGED_ZOOM), VP);
  assert.equal(f.calls.length, 12, "the refresh starts exactly maxInFlight fetches");

  // No more camera input: only fetches settling.
  await drain(f, (id) => (MISSING.has(id) ? 404 : 200));
  assert.equal(f.calls.length, 30, "one request for each in-view cell, the two 404 cells included");
  assert.equal(new Set(f.calls.map((c) => c.id)).size, 30, "no cell was requested twice");
  assert.equal(overlay.overlayCount(), 28, "every in-view cell with an original is drawn (the two 404 cells stay on the thumb)");
  assert.equal(overlay.inflightCount(), 0, "nothing left in flight");
  assert.ok(f.maxLive() <= 12, `at most maxInFlight live at once (largest live count ${f.maxLive()})`);
  const dist = f.calls.map((c) => focalDist2(table, c.id, 0.5, 0.5));
  for (let i = 1; i < dist.length; i++) {
    assert.ok(
      dist[i] >= dist[i - 1] - 1e-12,
      `request ${i} (cell ${f.calls[i].id}) is nearer the focal point than request ${i - 1} (cell ${f.calls[i - 1].id})`,
    );
  }
});

test("T2: a rung upgrade reaches every in-view cell, not just the first maxInFlight (rows 2, 9)", async () => {
  const w = createStubWorld();
  const table = posTable(GRID_CELLS());
  const f = deferredFetch(() => null, 120); // 60 expected (30 first fetches + 30 upgrades): 2× headroom
  const rungsOf = new Map<number, number[]>(); // cell id → the rung of each of its decodes
  const decode = async (blob: Blob, rung: number): Promise<DecodedDetail> => {
    const id = f.idOf(blob);
    rungsOf.set(id, [...(rungsOf.get(id) ?? []), rung]);
    return { texture: new THREE.Texture(), width: rung, height: rung }; // never at its ceiling
  };
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode,
  });
  overlay.setContext({ manifest: detailManifest(), positions: table });

  // Settle the view at 150 px a cell → rung 256. The setup pass runs with room for every cell
  // at once, so that this test pins the UPGRADE refill alone (T1 pins the first-fetch one).
  overlay.config.maxInFlight = 30;
  w.emit(cam(ENGAGED_ZOOM), VP);
  await drain(f);
  assert.equal(overlay.overlayCount(), 30, "fixture: the whole view is drawn at rung 256 first");
  const firstPass = f.calls.length;
  overlay.config.maxInFlight = DEFAULT_DETAIL_OVERLAY_CONFIG.maxInFlight;
  f.resetMaxLive();

  // One emit where every cell is 300 px (→ rung 512). A 2000 px viewport at zoom 5e-5 keeps
  // the view 0.1 wide, so all 30 cells are still in view: more upgrades than slots.
  const VP2: Viewport = { width: 2000, height: 2000, devicePixelRatio: 1 };
  assert.equal(countPositionsInView(table, bboxFromCamera(cam(5e-5), VP2)), 30, "fixture: 30 cells in view at 300 px");
  w.emit(cam(5e-5), VP2);
  await drain(f);
  for (let id = 0; id < 30; id++) {
    const rungs = rungsOf.get(id) ?? [];
    assert.equal(rungs[rungs.length - 1], 512, `cell ${id} was last decoded at rung ${rungs[rungs.length - 1]}, not 512`);
  }
  assert.equal(f.calls.length - firstPass, 30, "one upgrade request for each in-view cell");
  assert.ok(f.maxLive() <= 12, `first fetches and upgrades share the cap (largest live count ${f.maxLive()})`);
});

test("T3: the refill waits when the camera moved — no fetch for the old view starts after the move (row 5)", async () => {
  const frame = installFakeFrame();
  const w = createStubWorld();
  try {
    // Two separate groups of 30: view A (ids 0-29) and view B (ids 30-59), 0.4 apart.
    const table = posTable([...gridCells(6, 5, 0.3, 0.5, 0.016, 0.015), ...gridCells(6, 5, 0.7, 0.5, 0.016, 0.015)]);
    const isA = (id: number): boolean => id < 30;
    const f = deferredFetch();
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode: decodeStub(),
    });
    overlay.setContext({ manifest: detailManifest(), positions: table });

    w.emit(cam(ENGAGED_ZOOM, 0.3, 0.5), VP);
    frame.flush();
    assert.equal(f.calls.length, 12, "view A: the refresh starts maxInFlight fetches");
    assert.ok(f.calls.every((c) => isA(c.id)), "view A: every request is for an A cell");

    // Move to view B and do NOT flush: its refresh is scheduled, not run. The A fetches now
    // settle and free all 12 slots.
    w.emit(cam(ENGAGED_ZOOM, 0.7, 0.5), VP);
    for (const c of f.pending()) c.resolve(200);
    await settle();
    assert.equal(f.calls.length, 12, "a slot freed after the camera moved starts no fetch from the old view's list");

    frame.flush();
    assert.ok(f.calls.length > 12, "the scheduled refresh starts view B");
    assert.ok(f.calls.slice(12).every((c) => !isA(c.id)), "every request after the flush is for a B cell");

    await drain(f, () => 200, frame);
    assert.ok(f.calls.slice(12).every((c) => !isA(c.id)), "every request after the move, refills included, is for a B cell");
    assert.equal(overlay.overlayCount(), 30, "all 30 B cells drawn");
    assert.equal(f.calls.filter((c) => isA(c.id)).length, 12, "12 A requests in total");
    assert.ok(f.maxLive() <= 12, `at most maxInFlight live at once (largest live count ${f.maxLive()})`);
  } finally {
    w.dispose();
    frame.restore();
  }
});

test("T4: a retry timer that fires while every slot is in use is not lost (row 7)", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const table = posTable(GRID_CELLS());
    // The first request of all — the cell nearest the focal point — answers 500. Every other
    // request (that cell's retry included) is held until the drain answers it 200.
    const f = deferredFetch(() => (f.calls.length === 1 ? 500 : null));
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode: decodeStub(),
    });
    overlay.setContext({ manifest: detailManifest(), positions: table });

    w.emit(cam(ENGAGED_ZOOM), VP);
    await settle();
    const failing = f.calls[0].id;
    const nearest = Math.min(...[...Array(30).keys()].map((id) => focalDist2(table, id, 0.5, 0.5)));
    assert.ok(focalDist2(table, failing, 0.5, 0.5) <= nearest + 1e-12, "fixture: the failing cell is a nearest cell");
    assert.equal(clock.pending(), 1, "the 500 scheduled one backoff retry");
    assert.equal(f.pending().length, 12, "the failure freed a slot and the refill filled it: all 12 slots are in use");

    // The backoff fires now, while every slot is in use.
    clock.fireAll();
    await settle();
    await drain(f);
    assert.equal(f.calls.filter((c) => c.id === failing).length, 2, "the failed cell was requested again once a slot was free");
    assert.ok(overlay.cachedKeys().includes(`ds/v1/${failing}`), "the failed cell's retry decoded");
    assert.equal(overlay.overlayCount(), 30, "every in-view cell is drawn, the retried one included");
  } finally {
    w.dispose();
    clock.restore();
  }
});

/** Fire every backoff timer, and let the fetches it starts settle, until none is left. */
async function runTimersOut(clock: FakeTimers): Promise<void> {
  for (let i = 0; i < 10 && clock.pending() > 0; i++) {
    clock.fireAll();
    await settle();
  }
  await settle();
}

test("T5a: a cell out of retries is not fetched again on a still camera — first fetch (row 6)", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const f = deferredFetch(() => 500); // every request fails
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode: decodeStub(),
    });
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    w.emit(cam(ENGAGED_ZOOM), VP);
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length, 1 + RETRY_ATTEMPT_BACKOFF_MS.length, "the first fetch and its three retries, then nothing more");
    assert.equal(clock.pending(), 0, "no retry pending");
    assert.equal(overlay.inflightCount(), 0, "nothing in flight");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("T5b: a cell out of retries is not fetched again on a still camera — rung upgrade (row 6)", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : 500)); // the first fetch lands; every upgrade fails
    const decoded: THREE.Texture[] = [];
    const decode = async (_blob: Blob, rung: number): Promise<DecodedDetail> => {
      const texture = new THREE.Texture();
      decoded.push(texture);
      return { texture, width: rung, height: rung }; // never at its ceiling
    };
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode,
    });
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    // 200 px → drawn at rung 256.
    w.emit(cam(ENGAGED_ZOOM), VP);
    await settle();
    assert.equal(overlay.overlayCount(), 1, "fixture: the cell is drawn at rung 256");
    const texture256 = decoded[0];

    // One emit at 400 px (→ rung 512); every upgrade request answers 500.
    w.emit(cam(5e-5), VP);
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length - 1, 1 + RETRY_ATTEMPT_BACKOFF_MS.length, "the upgrade and its three retries, then nothing more");
    assert.equal(clock.pending(), 0, "no retry pending");
    assert.equal(overlay.inflightCount(), 0, "nothing in flight");
    assert.equal(overlay.overlayCount(), 1, "the cell is still drawn");
    assert.equal((onlyQuad(w).material as THREE.MeshBasicMaterial).map, texture256, "…with its rung-256 texture");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("a 404 on a rung upgrade is terminal: one upgrade request, and the rung-256 quad stays", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : 404)); // the first fetch lands; the upgrade is gone
    const decoded: THREE.Texture[] = [];
    const decode = async (_blob: Blob, rung: number): Promise<DecodedDetail> => {
      const texture = new THREE.Texture();
      decoded.push(texture);
      return { texture, width: rung, height: rung }; // never at its ceiling
    };
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode,
    });
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    w.emit(cam(ENGAGED_ZOOM), VP); // 200 px → drawn at rung 256
    await settle();
    assert.equal(overlay.overlayCount(), 1, "fixture: the cell is drawn at rung 256");
    const texture256 = decoded[0];

    w.emit(cam(5e-5), VP); // 400 px → wants rung 512; that request answers 404
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length - 1, 1, "exactly one upgrade request, then none");
    assert.equal(clock.pending(), 0, "no retry for a 404");
    assert.equal(overlay.inflightCount(), 0, "nothing in flight");
    assert.equal((onlyQuad(w).material as THREE.MeshBasicMaterial).map, texture256, "the rung-256 quad stays drawn");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("G1: the gate engages after one jump from a zoomed-out view, with no cell bound (row 3)", async () => {
  const w = createStubWorld();
  const table = posTable(GRID_CELLS());
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });
  overlay.setContext({ manifest: detailManifest(), positions: table });

  w.emit(cam(1e-3), VP); // 15 px a cell
  assert.equal(overlay.isEngaged(), false, "zoomed out → not engaged");
  assert.equal(f.calls.length, 0, "zoomed out → no request");

  w.emit(cam(ENGAGED_ZOOM), VP); // one jump to 150 px a cell; the pyramid has bound nothing
  assert.equal(overlay.isEngaged(), true, "the jump engages the gate");
  assert.equal(f.calls.length, 12, "…and starts maxInFlight fetches");
  await drain(f);
  assert.equal(overlay.overlayCount(), 30, "all 30 in-view cells drawn");
});

test("G2: a layout switch engages and releases the gate with no camera input (row 4)", async () => {
  const w = createStubWorld();
  const manifest = detailManifest(); // a layout switch keeps the dataset, so the manifest is the same
  const small = posTable(gridCells(6, 5, 0.5, 0.5, 0.016, 0.005)); // layout A: 50 px a cell at 1e-4
  const large = posTable(gridCells(6, 5, 0.5, 0.5, 0.016, 0.02)); // layout B, same ids: 200 px a cell
  assert.equal(countPositionsInView(large, bboxFromCamera(cam(ENGAGED_ZOOM), VP)), 30, "fixture: 30 B cells in view");
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });

  overlay.setContext({ manifest, positions: small });
  w.emit(cam(ENGAGED_ZOOM), VP);
  assert.equal(overlay.isEngaged(), false, "layout A: 50 px cells → not engaged");
  assert.equal(f.calls.length, 0, "layout A: no request");

  overlay.setContext({ manifest, positions: large }); // the switch; no camera input
  await drain(f);
  assert.equal(overlay.isEngaged(), true, "layout B: engaged with no camera input");
  assert.equal(overlay.overlayCount(), 30, "layout B: all 30 in-view cells drawn");

  overlay.setContext({ manifest, positions: small }); // and back; no camera input
  assert.equal(overlay.isEngaged(), false, "back on layout A: released with no camera input");
  assert.equal(overlay.overlayCount(), 0, "back on layout A: no quads");
});

test("G3: the gate reads the cells IN VIEW, not the whole layout", async () => {
  const w = createStubWorld();
  // 30 large cells around (0.5, 0.5): 200 px at 1e-4. 100 small cells around (0.85, 0.85),
  // over 0.2 world units away: 120 px at 1e-4 (large ÷ small = 1.67, inside the 1.7 the
  // brief measured on real categorical layouts). The table's upper median is the small width.
  const table = posTable([...gridCells(6, 5, 0.5, 0.5, 0.016, 0.02), ...gridCells(10, 10, 0.85, 0.85, 0.013, 0.012)]);
  const widths = [...table.w].sort((a, b) => a - b);
  assert.ok(Math.abs(widths[Math.floor(widths.length / 2)] - 0.012) < 1e-6, "fixture: the table's upper median is 0.012 (120 px)");
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });
  overlay.setContext({ manifest: detailManifest(), positions: table });

  w.emit(cam(ENGAGED_ZOOM, 0.5, 0.5), VP);
  assert.equal(overlay.isEngaged(), true, "on the large cells (200 px in view) → engaged");

  w.emit(cam(1e-3, 0.5, 0.5), VP);
  assert.equal(overlay.isEngaged(), false, "zoomed out → released");

  w.emit(cam(ENGAGED_ZOOM, 0.85, 0.85), VP);
  assert.equal(overlay.isEngaged(), false, "on the small cells (120 px in view, under the 128 px engage threshold) → not engaged");
});

// PR #409 review pins.

test("a failed fetch waits for its backoff timer: the refill does not restart it at once", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const f = deferredFetch(() => 500); // every request fails
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode: decodeStub(),
    });
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    w.emit(cam(ENGAGED_ZOOM), VP);
    await settle();
    assert.equal(f.calls.length, 1, "one request until the backoff timer fires (its own settle did not restart it)");
    assert.equal(clock.pending(), 1, "one backoff timer pending");

    clock.fireAll();
    await settle();
    assert.equal(f.calls.length, 2, "the timer firing starts the retry");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("an engaged gate holds across a view with no cells, so 110 px cells past a gap stay sharp", async () => {
  const w = createStubWorld();
  // Two groups of 30 cells 0.011 wide (110 px at 1e-4, 150 px at 7.33e-5), 0.4 apart. At 1e-4
  // the view is 0.1 wide, so a view centred between them holds no cell at all.
  const table = posTable([...gridCells(6, 5, 0.3, 0.5, 0.012, 0.011), ...gridCells(6, 5, 0.7, 0.5, 0.012, 0.011)]);
  assert.equal(countPositionsInView(table, bboxFromCamera(cam(1e-4, 0.5, 0.5), VP)), 0, "fixture: the gap view is empty");
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });
  overlay.setContext({ manifest: detailManifest(), positions: table });

  w.emit(cam(0.011 / 150, 0.3, 0.5), VP); // 150 px → engage
  assert.equal(overlay.isEngaged(), true, "fixture: engaged at 150 px");
  w.emit(cam(1e-4, 0.3, 0.5), VP); // 110 px: inside the hysteresis band
  assert.equal(overlay.isEngaged(), true, "fixture: held at 110 px (the band)");
  const aSignals = f.pending().map((c) => c.signal);
  assert.ok(aSignals.length > 0, "fixture: group A fetches are in flight");

  w.emit(cam(1e-4, 0.5, 0.5), VP); // over the gap: no candidates
  assert.equal(overlay.inflightCount(), 0, "the gap view aborted the group A fetches");
  assert.ok(aSignals.every((s) => s.aborted), "…through the wanted sweep");

  const before = f.calls.length;
  w.emit(cam(1e-4, 0.7, 0.5), VP); // arrive on group B at 110 px
  assert.equal(overlay.isEngaged(), true, "still engaged on arriving at 110 px cells past the gap");
  assert.ok(f.calls.length > before && f.calls.slice(before).every((c) => c.id >= 30), "group B cells are fetched");
});

test("the short cut uses the hysteresis threshold: an engaged gate holds at 110 px", async () => {
  const w = createStubWorld();
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });
  overlay.setContext({ manifest: detailManifest(), positions: posTable(gridCells(6, 5, 0.5, 0.5, 0.012, 0.011)) });

  w.emit(cam(0.011 / 150), VP); // every cell 150 px
  assert.equal(overlay.isEngaged(), true, "fixture: engaged at 150 px");
  w.emit(cam(1e-4), VP); // every cell, the largest included, 110 px: under 128, over 96
  assert.equal(overlay.isEngaged(), true, "held at 110 px: the short cut compares the largest width to releaseCellPx");
});

test("a camera move gives an out-of-retries cell exactly one more fetch", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    const f = deferredFetch(() => 500); // every request fails
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch: f.fetch,
      decode: decodeStub(),
    });
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    w.emit(cam(ENGAGED_ZOOM), VP);
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length, 1 + RETRY_ATTEMPT_BACKOFF_MS.length, "fixture: the fetch and its three retries");

    w.emit(cam(ENGAGED_ZOOM, 0.5 + 1e-9, 0.5), VP); // a camera move far below one pixel
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length, 2 + RETRY_ATTEMPT_BACKOFF_MS.length, "exactly one more request after the camera move");
    assert.equal(clock.pending(), 0, "…and no backoff: the retry budget is not reset by a camera move");
    assert.equal(overlay.inflightCount(), 0, "nothing in flight");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("a rejection named AbortError that our signal did not cause is a transient failure: 1 + 3 requests, then none", async () => {
  const clock = installFakeTimers();
  const w = createStubWorld();
  try {
    // Every request rejects with an AbortError while the overlay's own signal stays live — e.g.
    // Firefox rejecting in-flight fetches on navigation. Counted, and capped at the ceiling so a
    // loop fails on the count.
    const signals: AbortSignal[] = [];
    const fetch = (_url: string, init: { signal: AbortSignal }): Promise<Response> => {
      signals.push(init.signal);
      if (signals.length > FETCH_CALL_CEILING) return new Promise<Response>(() => {});
      const err = new Error("the network layer aborted this request");
      err.name = "AbortError";
      return Promise.reject(err);
    };
    const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
      fetch,
      decode: decodeStub(),
    });
    overlay.setContext({ manifest: detailManifest(), positions: posTable([{ x: 0.5, y: 0.5, w: 0.02, h: 0.02 }]) });

    w.emit(cam(ENGAGED_ZOOM), VP);
    await settle();
    await runTimersOut(clock);
    assert.equal(signals.length, 1 + RETRY_ATTEMPT_BACKOFF_MS.length, "the fetch and its three backoff retries, then nothing more");
    assert.ok(signals.every((s) => !s.aborted), "fixture: the overlay never aborted these requests itself");
    assert.equal(clock.pending(), 0, "no retry pending");
    assert.equal(overlay.inflightCount(), 0, "nothing in flight");
  } finally {
    w.dispose();
    clock.restore();
  }
});

test("largestCellWidth: 0 for an empty table, NaN widths ignored", () => {
  assert.equal(largestCellWidth(posTable([])), 0, "an empty table");
  const t = posTable([
    { x: 0.1, y: 0.1, w: Number.NaN, h: 0.01 },
    { x: 0.2, y: 0.2, w: 0.02, h: 0.02 },
    { x: 0.3, y: 0.3, w: Number.NaN, h: 0.01 },
    { x: 0.4, y: 0.4, w: 0.01, h: 0.01 },
  ]);
  assert.equal(largestCellWidth(t), Math.fround(0.02), "the largest real width, NaN rows ignored");
  assert.equal(largestCellWidth(posTable([{ x: 0.5, y: 0.5, w: Number.NaN, h: 0.01 }])), 0, "an all-NaN table");
});

/** A small seeded PRNG (mulberry32), so a property test is the same run every time. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("scanPositionsInView: the count is exact up to maxN + 1; within the cap the candidates equal the reference's, over it none", () => {
  let within = 0;
  let over = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rnd = seededRandom(seed);
    const cells: { x: number; y: number; w: number; h: number }[] = [];
    for (let i = 0; i < 600; i++) {
      // Every fifth cell joins a coincident pile at one of three points; the rest are spread.
      const pile = i % 5 === 0 ? [[0.3, 0.3], [0.5, 0.52], [0.71, 0.4]][i % 3] : null;
      const s = 0.002 + rnd() * 0.03;
      cells.push(pile !== null
        ? { x: pile[0], y: pile[1], w: s, h: s }
        : { x: rnd(), y: rnd(), w: s, h: s * (0.5 + rnd()) });
    }
    const table = posTable(cells);
    for (let v = 0; v < 6; v++) {
      const cx = rnd();
      const cy = rnd();
      const half = 0.02 + rnd() * 0.3;
      const view = { xMin: cx - half, xMax: cx + half, yMin: cy - half, yMax: cy + half };
      for (const maxN of [5, 400]) {
        for (const dedupe of [undefined, 0.004]) {
          const got = scanPositionsInView(table, view, maxN, dedupe);
          const at = `seed ${seed}, view ${v}, maxN ${maxN}, dedupe ${dedupe}`;
          const count = countPositionsInView(table, view);
          assert.equal(got.inView, Math.min(count, maxN + 1), `count (exact up to maxN + 1), ${at}`);
          if (count <= maxN) {
            within++;
            assert.deepEqual(got.candidates, collectReference(table, view, maxN, dedupe), `candidates, ${at}`);
          } else {
            over++;
            assert.deepEqual(got.candidates, [], `no candidates over the cap, ${at}`);
          }
        }
      }
    }
  }
  assert.ok(within > 0 && over > 0, `fixture: both regimes exercised (${within} within the cap, ${over} over it)`);
});

test("over the in-view cap the scan stops: with the in-view cells early in id order it reads far fewer rows than countPositionsInView", () => {
  // Ids 0-49 are in view (a 40-cell pile and 10 spread cells); ids 50-1,999 are outside it.
  // Cap 5. The scan can stop at the 6th in-view cell; counting on to the end reads every row,
  // and deduping past the cap would read the pile again (PR #409 re-reviews, N2 and D1).
  const cells: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < 40; i++) cells.push({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 });
  for (let i = 0; i < 10; i++) cells.push({ x: 0.3 + i * 0.04, y: 0.3, w: 0.01, h: 0.01 });
  for (let i = 0; i < 1950; i++) cells.push({ x: 2 + (i % 50) * 0.01, y: 2 + Math.floor(i / 50) * 0.01, w: 0.01, h: 0.01 });
  const view = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const maxN = 5;
  const counted = countingPosTable(cells);
  const count = countPositionsInView(counted.table, view);
  const countReads = counted.reads();
  const scanned = countingPosTable(cells);
  const got = scanPositionsInView(scanned.table, view, maxN, 0.004);
  assert.equal(count, 50, "fixture: 50 cells in view, all at the start of id order");
  assert.equal(got.inView, maxN + 1, "over the cap the count stops at maxN + 1");
  assert.deepEqual(got.candidates, [], "…with no candidates");
  assert.ok(
    scanned.reads() < countReads / 10,
    `over the cap the scan stops early: ${scanned.reads()} position reads against the full count's ${countReads}`,
  );
});

test("one engaged refresh reads each position row once (one scan, not a count and a collect)", async () => {
  const w = createStubWorld();
  // 30 cells in view (150 px at 1e-4) and 1,970 small cells far outside it.
  const cells = [...GRID_CELLS()];
  for (let i = 0; i < 1970; i++) cells.push({ x: 0.8 + (i % 40) * 0.004, y: 0.1 + Math.floor(i / 40) * 0.004, w: 0.003, h: 0.003 });
  const { table, wReads } = countingPosTable(cells);
  const f = deferredFetch();
  const overlay = createDetailOverlay(w.world, overlayClient(), { ...DEFAULT_DETAIL_OVERLAY_CONFIG }, {
    fetch: f.fetch,
    decode: decodeStub(),
  });
  overlay.setContext({ manifest: detailManifest(), positions: table });

  const before = wReads();
  w.emit(cam(ENGAGED_ZOOM), VP);
  const during = wReads() - before;
  assert.equal(overlay.isEngaged(), true, "fixture: engaged");
  // One scan reads it rows + candidates times (2030); two scans read it about twice (4030).
  assert.ok(
    during < 1.5 * cells.length,
    `one engaged refresh read the width column ${during} times for ${cells.length} rows (one scan: ~${cells.length}; two scans: ~${2 * cells.length})`,
  );
});

// ---------------------------------------------------------------------------
// The rung step-down (brief_detail_overlay_rung_step_down_seam.md §3,
// T2-a-drawn-detail-texture-never-steps-down-a-rung). A drawn texture above the rung its cell
// needs — by more than the gate's 128/96 hysteresis band — is replaced by one at that rung.
// ---------------------------------------------------------------------------

/** An overlay whose decode returns `width = height = rung` and records, for each texture, the
 *  cell and rung it was decoded for. Drawn bytes are summed over the scene's quads. */
function stepRig(
  cells: { x: number; y: number; w: number; h: number }[],
  f: DeferredFetch,
  config = { ...DEFAULT_DETAIL_OVERLAY_CONFIG },
) {
  const w = createStubWorld();
  const decodedAs = new WeakMap<THREE.Texture, { id: number; rung: number }>();
  const disposed: number[] = []; // the rung of each texture the overlay disposed, in order
  const disposedTextures = new WeakSet<THREE.Texture>();
  const decode = async (blob: Blob, rung: number): Promise<DecodedDetail> => {
    const texture = new THREE.Texture();
    decodedAs.set(texture, { id: f.idOf(blob), rung });
    texture.addEventListener("dispose", () => {
      disposed.push(rung);
      disposedTextures.add(texture);
    });
    return { texture, width: rung, height: rung };
  };
  const overlay = createDetailOverlay(w.world, overlayClient(), config, { fetch: f.fetch, decode });
  overlay.setContext({ manifest: detailManifest(), positions: posTable(cells) });
  const quads = (): { id: number; rung: number; texture: THREE.Texture }[] =>
    [...w.sceneObjects]
      .filter((o): o is THREE.Mesh => o instanceof THREE.Mesh)
      .map((m) => {
        const texture = (m.material as THREE.MeshBasicMaterial).map as THREE.Texture;
        return { ...decodedAs.get(texture)!, texture };
      });
  const drawnBytes = (): number => quads().reduce((s, q) => s + q.rung * q.rung * 4, 0);
  return {
    w,
    overlay,
    quads,
    drawnBytes,
    disposedRungs: (): number[] => [...disposed],
    isDisposed: (t: THREE.Texture): boolean => disposedTextures.has(t),
  };
}

const STEP_W = 0.015; // every step-down cell is 0.015 world units wide
const STEP_VP: Viewport = { width: 4000, height: 4000, devicePixelRatio: 1 };
const atPx = (px: number, cx = 0.5, cy = 0.5): CameraState => cam(STEP_W / px, cx, cy);

test("S1: zooming out steps every drawn texture down to its cell's target rung; drawn bytes equal a fresh overlay's", async () => {
  const cells = gridCells(10, 10, 0.5, 0.5, 0.016, STEP_W);
  const f = deferredFetch(() => null, 400);
  const rig = stepRig(cells, f);
  // 1200 → 480 → 160 device px: rungs 2048 → 512 → 256. Not "2× then 2×" (brief §3): halving
  // from a 2048 start never lands where the target and rungFor(px × 4/3) differ outside the
  // hysteresis band, so M4 (step to rungFor(px × 4/3)) could not fail; 2.5× then 3× lands at
  // 480 px, where the target is 512 and rungFor(640) is 1024.
  rig.w.emit(atPx(1200), STEP_VP);
  await drain(f);
  assert.ok(rig.quads().length > 0 && rig.quads().every((q) => q.rung === 2048), "fixture: settled at rung 2048");
  for (const px of [480, 160]) {
    rig.w.emit(atPx(px), STEP_VP);
    await drain(f);
    const target = rungFor(px);
    const wrong = rig.quads().filter((q) => q.rung !== target);
    assert.equal(wrong.length, 0, `at ${px} px every drawn texture is at rung ${target}; ${wrong.length} are not (e.g. cell ${wrong[0]?.id} at ${wrong[0]?.rung})`);
    const freshFetch = deferredFetch(() => null, 400);
    const freshRig = stepRig(cells, freshFetch);
    freshRig.w.emit(atPx(px), STEP_VP);
    await drain(freshFetch);
    assert.equal(rig.quads().length, freshRig.quads().length, `at ${px} px the same cells are drawn as on a fresh overlay`);
    assert.equal(rig.drawnBytes(), freshRig.drawnBytes(), `at ${px} px the drawn bytes equal a fresh overlay's`);
    freshRig.w.dispose();
  }
  rig.w.dispose();
});

test("S2: the hysteresis — a 2048 texture is kept at 800 device px and steps down once, to 1024, at 700", async () => {
  const f = deferredFetch(() => 200);
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
  rig.w.emit(atPx(1100), VP1);
  await settle();
  assert.equal(rig.quads()[0]?.rung, 2048, "fixture: drawn at rung 2048");

  rig.w.emit(atPx(800), VP1); // target 1024, but rungFor(800 × 4/3) is 2048: inside the band
  await settle();
  assert.equal(f.calls.length, 1, "no step-down at 800 device px");

  rig.w.emit(atPx(700), VP1); // rungFor(700 × 4/3) is 1024 < 2048: step down to the target, 1024
  await settle();
  assert.equal(f.calls.length, 2, "exactly one step-down request at 700 device px");
  assert.equal(rig.quads()[0]?.rung, 1024, "…to rung 1024");
  rig.w.dispose();
});

test("S3: after a zoom-out, the first maxInFlight requests are first fetches, though the step-down cells are nearer the focal point", async () => {
  const cells = gridCells(10, 10, 0.5, 0.5, 0.016, STEP_W);
  const f = deferredFetch(() => null, 400);
  const rig = stepRig(cells, f);
  rig.w.emit(atPx(1200), STEP_VP);
  await drain(f);
  const deep = new Set(rig.quads().map((q) => q.id));
  assert.ok(deep.size > 0 && deep.size < 100, `fixture: ${deep.size} cells drawn at rung 2048`);
  const before = f.calls.length;

  rig.w.emit(atPx(150), STEP_VP); // all 100 in view at 150 px: the deep cells need a step-down, 100 - deep.size a first fetch
  assert.ok(100 - deep.size > DEFAULT_DETAIL_OVERLAY_CONFIG.maxInFlight, "fixture: more newly visible cells than slots");
  const first = f.calls.slice(before);
  assert.equal(first.length, DEFAULT_DETAIL_OVERLAY_CONFIG.maxInFlight, "the zoom-out fills every slot");
  assert.ok(
    first.every((c) => !deep.has(c.id)),
    `the first ${first.length} requests are all first fetches: ${first.filter((c) => deep.has(c.id)).length} were step-downs`,
  );
  await drain(f);
  assert.equal(f.calls.slice(before).filter((c) => deep.has(c.id)).length, deep.size, "every deep cell then steps down");
  assert.ok(rig.quads().every((q) => q.rung === 256), "every drawn texture ends at rung 256");
  rig.w.dispose();
});

test("S4: after a step-down settles, a still camera starts no request for that cell, nor does the same camera again", async () => {
  const f = deferredFetch(() => 200);
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
  rig.w.emit(atPx(1100), VP1);
  await settle();
  rig.w.emit(atPx(500), VP1); // target 512; rungFor(667) is 1024 < 2048: step down
  await settle();
  assert.equal(f.calls.length, 2, "fixture: the first fetch and one step-down");
  assert.equal(rig.quads()[0]?.rung, 512, "fixture: stepped down to rung 512");
  await settle();
  await settle();
  assert.equal(f.calls.length, 2, "a still camera starts nothing more");
  rig.w.emit(atPx(500), VP1);
  await settle();
  rig.w.emit(atPx(500), VP1);
  await settle();
  assert.equal(f.calls.length, 2, "the same camera again starts nothing more");
  rig.w.dispose();
});

test("S5: while a step-down is in flight, the quad still shows the larger texture", async () => {
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : null)); // the step-down is held
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
  rig.w.emit(atPx(1100), VP1);
  await settle();
  const large = rig.quads()[0];
  assert.equal(large?.rung, 2048, "fixture: drawn at rung 2048");
  rig.w.emit(atPx(500), VP1);
  await settle();
  assert.equal(f.pending().length, 1, "fixture: the step-down is in flight");
  assert.equal(rig.quads().length, 1, "the cell is still drawn");
  assert.equal(rig.quads()[0].texture, large.texture, "…with the larger texture while the step-down is in flight");
  await drain(f);
  assert.equal(rig.quads()[0]?.rung, 512, "the step-down then replaces it");
  rig.w.dispose();
});

test("S6: a step-down that answers 500 follows the retry ladder, then keeps the larger texture: 1 + 3 requests", async () => {
  const clock = installFakeTimers();
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : 500)); // the first fetch lands; every step-down fails
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  try {
    const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
    rig.w.emit(atPx(1100), VP1);
    await settle();
    const large = rig.quads()[0];
    assert.equal(large?.rung, 2048, "fixture: drawn at rung 2048");
    rig.w.emit(atPx(500), VP1);
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length - 1, 1 + RETRY_ATTEMPT_BACKOFF_MS.length, "the step-down and its three retries, then nothing more");
    assert.equal(clock.pending(), 0, "no retry pending");
    assert.equal(rig.quads()[0]?.texture, large.texture, "the cell keeps its larger texture");
  } finally {
    rig.w.dispose();
    clock.restore();
  }
});

// PR #415 review, F1: a step-down still in flight when the camera zooms back in must not land.

test("S7: a zoom back in aborts a stale step-down; the larger texture stays drawn, never below the target", async () => {
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : null)); // the first fetch lands; the rest are held
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
  rig.w.emit(atPx(1100), VP1);
  await settle();
  const large = rig.quads()[0];
  assert.equal(large?.rung, 2048, "fixture: drawn at rung 2048");
  rig.w.emit(atPx(150), VP1); // target 256: a step-down starts
  await settle();
  const stepDown = f.pending()[0];
  assert.ok(stepDown !== undefined && f.calls.length === 2, "fixture: the step-down is in flight");

  rig.w.emit(atPx(1100), VP1); // back in: target 2048 again, before the step-down lands
  assert.equal(stepDown.signal.aborted, true, "the refresh aborted the stale step-down");
  assert.equal(rig.overlay.inflightCount(), 0, "…and freed its slot");
  await drain(f);
  assert.equal(rig.quads()[0]?.texture, large.texture, "the larger texture stays drawn");
  assert.ok((rig.quads()[0]?.rung ?? 0) >= rungFor(1100), "the cell is never below its target");
  assert.equal(f.calls.length, 2, "and nothing needs repairing: no further request");
  rig.w.dispose();
});

test("S8: a stale step-down that lands while the zoom-in's refresh is still pending is discarded (the completion backstop)", async () => {
  const frame = installFakeFrame();
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : null));
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  try {
    const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
    rig.w.emit(atPx(1100), VP1);
    frame.flush();
    await settle();
    frame.flush();
    const large = rig.quads()[0];
    assert.equal(large?.rung, 2048, "fixture: drawn at rung 2048");
    rig.w.emit(atPx(150), VP1);
    frame.flush(); // the refresh runs: the step-down starts
    await settle();
    const stepDown = f.pending()[0];
    assert.ok(stepDown !== undefined, "fixture: the step-down is in flight");

    rig.w.emit(atPx(1100), VP1); // back in, NOT flushed: its refresh (and its abort sweep) is pending
    stepDown.resolve(200); // the stale step-down lands before that refresh runs
    await settle();
    assert.equal(stepDown.signal.aborted, false, "fixture: the sweep has not run, so nothing aborted it");
    assert.equal(rig.quads()[0]?.texture, large.texture, "the larger texture stays drawn");
    assert.deepEqual(rig.disposedRungs(), [256], "the smaller (rung 256) texture was disposed, and only it");
    frame.flush(); // the pending refresh now runs at 1100 px
    await settle();
    assert.equal(rig.quads()[0]?.texture, large.texture, "still the larger texture after the refresh");
    assert.equal(f.calls.length, 2, "no repair request");
  } finally {
    rig.w.dispose();
    frame.restore();
  }
});

test("S9: after a stale step-down, the focal cell is never left below its target behind the other upgrades", async () => {
  // The review's 7 × 7 shape: cell 24 is the centre (the focal point).
  const cells = gridCells(7, 7, 0.5, 0.5, STEP_W, STEP_W);
  const f = deferredFetch(() => null, 400);
  const rig = stepRig(cells, f);
  const centre = 24;
  const centreRung = (): number | undefined => rig.quads().find((q) => q.id === centre)?.rung;
  rig.w.emit(atPx(3000), STEP_VP); // deep: the centre (and its neighbours' edges) at rung 2048
  await drain(f);
  assert.equal(centreRung(), 2048, "fixture: the centre is drawn at rung 2048");

  rig.w.emit(atPx(150), STEP_VP); // out: first fetches, then the step-downs
  for (let k = 0; k < 30; k++) {
    const others = f.pending().filter((c) => c.id !== centre);
    if (others.length === 0) break;
    for (const c of others) c.resolve(200);
    await settle();
  }
  const centreStep = f.pending().find((c) => c.id === centre);
  assert.ok(centreStep !== undefined, "fixture: only the centre's step-down is still in flight");

  rig.w.emit(atPx(600), STEP_VP); // back in to 600 px: target 1024 for every cell
  const target = rungFor(600);
  centreStep.resolve(200); // the stale step-down's answer arrives (a no-op once aborted)
  await settle();
  for (let k = 0; k < 60; k++) {
    assert.ok((centreRung() ?? 0) >= target, `the centre is never below its target ${target}: drawn ${centreRung()} (step ${k})`);
    const p = f.pending();
    if (p.length === 0) break;
    p[0].resolve(200); // one at a time, so the order matters
    await settle();
  }
  assert.equal(f.pending().length, 0, "the view settles");
  assert.ok(rig.quads().every((q) => q.rung === target), "every drawn texture ends at the target rung");
  rig.w.dispose();
});

test("S10: the sweep keeps a step-down whose rung is still the target (a sub-pixel pan, a zoom inside the band)", async () => {
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : null)); // the first fetch lands; the step-down is held
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
  rig.w.emit(atPx(1100), VP1);
  await settle();
  assert.equal(rig.quads()[0]?.rung, 2048, "fixture: drawn at rung 2048");
  rig.w.emit(atPx(400), VP1); // target 512; rungFor(533) is 1024 < 2048: the step-down to 512 starts
  await settle();
  const stepDown = f.pending()[0];
  assert.ok(stepDown !== undefined && f.calls.length === 2, "fixture: the step-down to 512 is in flight");

  rig.w.emit(atPx(400, 0.5 + 1e-9), VP1); // a sub-pixel pan: the target is still 512
  rig.w.emit(atPx(450), VP1); // a zoom that keeps the target at 512
  await settle();
  assert.equal(stepDown.signal.aborted, false, "a step-down that still asks for the target is not aborted");
  assert.equal(f.calls.length, 2, "…and no request restarted it");
  rig.w.dispose();
});

test("a stale step-down's discarded 200 clears the cell's spent retries: the next step-down gets 1 + 3 requests", async () => {
  const frame = installFakeFrame();
  const clock = installFakeTimers();
  // nth 0: the first fetch lands. nth 1-2: the step-down fails twice. nth 3: its third attempt is
  // held, then answers 200 after the camera zoomed back in (the backstop discards it). nth ≥ 4:
  // every later step-down fails.
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : nth <= 2 ? 500 : nth === 3 ? null : 500));
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  try {
    const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
    rig.w.emit(atPx(1100), VP1);
    frame.flush();
    await settle();
    assert.equal(rig.quads()[0]?.rung, 2048, "fixture: drawn at rung 2048");

    rig.w.emit(atPx(400), VP1);
    frame.flush(); // the step-down starts and fails (nth 1)
    await settle();
    clock.fireAll(); // retry 1 (nth 2) fails
    await settle();
    clock.fireAll(); // retry 2 (nth 3) is held
    await settle();
    const third = f.pending()[0];
    assert.ok(third !== undefined && f.calls.length === 4, "fixture: the step-down's third attempt is in flight");

    rig.w.emit(atPx(1100), VP1); // back in, NOT flushed: the sweep has not run
    third.resolve(200); // it lands, and the backstop discards it
    await settle();
    assert.equal(rig.quads()[0]?.rung, 2048, "fixture: the discarded result left the 2048 texture drawn");
    frame.flush();
    await settle();

    const before = f.calls.length;
    rig.w.emit(atPx(400), VP1); // the next zoom-out: a fresh step-down, failing every time
    frame.flush();
    await settle();
    await runTimersOut(clock);
    assert.equal(f.calls.length - before, 1 + RETRY_ATTEMPT_BACKOFF_MS.length, "the next step-down gets its full budget: 1 + 3 requests");
  } finally {
    rig.w.dispose();
    clock.restore();
    frame.restore();
  }
});

test("a texture that lands while the position table is briefly null never leaves the drawn quad on a disposed texture", async () => {
  const frame = installFakeFrame();
  const f = deferredFetch((_id, nth) => (nth === 0 ? 200 : null));
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f);
  try {
    const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
    rig.w.emit(atPx(1100), VP1);
    frame.flush();
    await settle();
    assert.equal(rig.quads()[0]?.rung, 2048, "fixture: drawn at rung 2048");
    rig.w.emit(atPx(500), VP1);
    frame.flush(); // the step-down to 512 starts
    await settle();
    const stepDown = f.pending()[0];
    assert.ok(stepDown !== undefined, "fixture: the step-down is in flight");

    // A layout switch: the position table is null until the new one binds. Its refresh is
    // pending (not flushed), so the quad is still drawn when the step-down lands.
    rig.overlay.setContext({ manifest: detailManifest(), positions: null });
    stepDown.resolve(200);
    await settle();
    const meshes = [...rig.w.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    assert.equal(meshes.length, 1, "fixture: the quad is still in the scene");
    const map = (meshes[0].material as THREE.MeshBasicMaterial).map as THREE.Texture;
    assert.equal(rig.isDisposed(map), false, "the drawn quad never samples a disposed texture");
    frame.flush(); // the release refresh runs
    await settle();
  } finally {
    rig.w.dispose();
    frame.restore();
  }
});

test("a step-down always lowers the rung: with engageCellPx < releaseCellPx a still camera settles after one request", async () => {
  // PR #409 final review, E2. With the ratio 96/128 = 0.75, at 300 device px the band test
  // alone reads rungFor(225) = 256 < the held 512, though the target, rungFor(300), IS 512.
  // Not reachable with the default 128/96; reachable once the config is live (T2-101).
  const f = deferredFetch(() => 200); // every request lands; the call ceiling (60) stops a loop
  const rig = stepRig([{ x: 0.5, y: 0.5, w: STEP_W, h: STEP_W }], f, {
    ...DEFAULT_DETAIL_OVERLAY_CONFIG,
    engageCellPx: 96,
    releaseCellPx: 128,
  });
  const VP1: Viewport = { width: 1000, height: 1000, devicePixelRatio: 1 };
  rig.w.emit(atPx(300), VP1);
  for (let k = 0; k < 40; k++) await settle();
  assert.equal(rig.quads()[0]?.rung, 512, "fixture: drawn at the target rung, 512");
  assert.equal(f.calls.length, 1, "one request, then none on a still camera");
  rig.w.emit(atPx(300), VP1); // the same camera again
  for (let k = 0; k < 10; k++) await settle();
  assert.equal(f.calls.length, 1, "…and none after the same camera again");
  rig.w.dispose();
});
