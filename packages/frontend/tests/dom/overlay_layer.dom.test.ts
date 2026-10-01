// T2-72 Seam 1 — DOM lifecycle for the overlay substrate (src/renderer/overlayLayer.ts),
// run under global-jsdom. Covers the substrate's lifecycle contract the brief mandates:
//   * camera emit → chips positioned over the canvas via worldToScreen;
//   * a camera update → reposition (rAF-coalesced);
//   * a layout switch (context null → new) → clear then rebuild (no stale-layout elements);
//   * the ON-by-default toggle hides/shows chips;
//   * a datetime layout → axis ticks render from an (injected) derived domain;
//   * dispose → the DOM layer is removed and the camera subscription released.
import assert from "node:assert/strict";
import test from "node:test";

import { createOverlayLayer, DEFAULT_OVERLAY_LAYER_CONFIG, worldToScreen } from "../../src/renderer/overlayLayer.ts";
import type { OverlayContext, TimeDomain } from "../../src/renderer/overlayLayer.ts";
import type { PositionTable } from "../../src/renderer/cells.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { CameraState, Viewport, World } from "../../src/renderer/world.ts";

const VP: Viewport = { width: 1000, height: 800, devicePixelRatio: 1 };

// A controllable rAF so the coalesced reposition runs deterministically.
let rafQueue: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
}) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeDomWorld(): {
  world: World;
  holder: HTMLElement;
  emit: (s: CameraState, v: Viewport) => void;
  dispose: () => void;
} {
  const holder = document.createElement("div");
  holder.className = "canvas-holder";
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);
  document.body.appendChild(holder);
  const subs = new Set<(s: CameraState, v: Viewport) => void>();
  const disposeHooks = new Set<() => void>();
  let disposed = false;
  const world = {
    scene: { add() {}, remove() {} },
    camera: {},
    renderer: { domElement: canvas },
    maxTextureSize: 4096,
    resize() {},
    onCameraChange(cb: (s: CameraState, v: Viewport) => void): () => void {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    start() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cb of disposeHooks) cb();
    },
    onDispose(cb: () => void) {
      if (disposed) cb();
      else disposeHooks.add(cb);
    },
    haltRenderLoop() {},
    resumeRenderLoop() {},
  } as unknown as World;
  return {
    world,
    holder,
    emit(s, v) {
      for (const cb of subs) cb(s, v);
    },
    dispose() {
      (world as unknown as { dispose(): void }).dispose();
    },
  };
}

const stubClient = { getMetadata: async () => [] } as unknown as ApiClient;

function posTable(cells: { x: number; y: number }[]): PositionTable {
  return {
    x: Float32Array.from(cells.map((c) => c.x)),
    y: Float32Array.from(cells.map((c) => c.y)),
    w: Float32Array.from(cells.map(() => 0.001)),
    h: Float32Array.from(cells.map(() => 0.001)),
    count: cells.length,
  };
}

/** A scatter layout whose z=1 tile (0,0) holds a 5-cell pile (cap 2) → one hotspot. */
function pileContext(): { manifest: LayoutManifest; positions: PositionTable } {
  const positions = posTable([
    { x: 0.1, y: 0.1 },
    { x: 0.11, y: 0.11 },
    { x: 0.12, y: 0.1 },
    { x: 0.1, y: 0.12 },
    { x: 0.11, y: 0.1 },
    { x: 0.9, y: 0.9 },
  ]);
  const manifest = {
    manifest_version: "2.4",
    dataset_id: "rijks_pilot",
    dataset_version: 2,
    layouts: [
      {
        layout_id: "scatter_dims",
        label: "Dimensions",
        type: "scatter",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 2, z_cap: 1, levels: [] },
      },
    ],
    dataset_metadata: { image_count: 6, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;
  return { manifest, positions };
}

/** A datetime layout with `n` dated cells spread linearly across x∈[0,1] (the two endpoints
 *  carry t_min / t_max). Drives the axis-domain path — with a real or an injected resolver. */
function dateContext(n = 2): { manifest: LayoutManifest; positions: PositionTable } {
  const cells: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) cells.push({ x: n > 1 ? i / (n - 1) : 0, y: 0.5 });
  const positions = posTable(cells);
  const manifest = {
    manifest_version: "2.4",
    dataset_id: "rijks_pilot",
    dataset_version: 2,
    layouts: [
      {
        layout_id: "by_date",
        label: "By date",
        type: "datetime",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 7, levels: [] },
      },
    ],
    column_roles: { filename: { column: "f", label: "F" }, datetime: { column: "date", label: "Date", format: "iso8601" } },
    dataset_metadata: { image_count: n, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;
  return { manifest, positions };
}

test("chips render over the canvas at the pile anchor after a camera emit (ON by default)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();

  assert.equal(layer.hotspotCount(), 1, "one over-cap pile derived");
  assert.equal(layer.chipCount(), 1, "one chip drawn");
  const chip = w.holder.querySelector<HTMLElement>(".overlay-chip[style*='inline-flex']");
  assert.ok(chip !== null, "a visible chip element exists in .canvas-holder");
  assert.match(chip!.textContent ?? "", /~5/, "tilde-prefixed count");
  layer.dispose();
  w.holder.remove();
});

test("a v2.5 full-precision bbox_exact makes chip counts EXACT (drops the ~ approximation)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  // Upgrade the layout to a v2.5 bake carrying the full-precision bbox the tiler binned:
  // the chip derivation then bins IDENTICALLY to the bake, so the count is exact and the
  // ~/≈ approximation is dropped (PR #179 root-cause fix).
  (manifest.layouts[0] as unknown as { bbox_exact: number[] }).bbox_exact = [0, 0, 1, 1];
  // Frame the pile mid-screen (world (0.1,0.1) → screen (300,200)) so the hover
  // hit-test — where the microcopy now lives — can reach it.
  w.emit({ center: [0.3, 0.3], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  const chip = w.holder.querySelector<HTMLElement>(".overlay-chip[style*='inline-flex']");
  assert.ok(chip !== null);
  assert.doesNotMatch(chip!.textContent ?? "", /~/, "no tilde — the count is exact with bbox_exact");
  w.holder.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 183, bubbles: true }));
  const tip = w.holder.querySelector<HTMLElement>(".overlay-chip-tooltip");
  assert.ok(tip !== null, "tooltip shown for the exact chip");
  assert.match(tip!.textContent ?? "", /^5 images share this area; 2 shown$/, "exact count, no ≈ prefix");
  assert.doesNotMatch(tip!.textContent ?? "", /approximate/, "no approximation caveat for a 2.5 bbox_exact bake");
  layer.dispose();
  w.holder.remove();
});

test("chips are pointer-inert; only the tray's toggle opts back in (no canvas dead zones)", () => {
  // The substrate is a SIBLING of the canvas, so any pointer-events:auto child would eat
  // the canvas's wheel/drag/click for the area it covers (the PR-179 dead-zone finding).
  // pointer-events:none is the property browser hit-testing keys on — assert it everywhere
  // except the real controls (the toggle tray's buttons).
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.3, 0.3], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();

  const chip = w.holder.querySelector<HTMLElement>(".overlay-chip");
  assert.ok(chip !== null);
  assert.equal(chip!.style.pointerEvents, "none", "a chip never intercepts the canvas gesture");
  const substrate = w.holder.querySelector<HTMLElement>(".overlay-substrate");
  assert.equal(substrate!.style.pointerEvents, "none", "the substrate root passes through");
  const toggle = w.holder.querySelector<HTMLElement>(".overlay-chip-toggle");
  assert.ok(toggle !== null, "the piles toggle exists (this layout has piles)");
  assert.equal(toggle!.style.pointerEvents, "auto", "the toggle is a real control");
  assert.equal(toggle!.closest(".overlay-toggle-tray") !== null, true, "the toggle lives in the tray");
  assert.equal(toggle!.getAttribute("aria-pressed"), "true", "toggle state is accessible");
  assert.equal(toggle!.getAttribute("aria-label"), "Pile count chips", "glyph-free accessible name");
  layer.dispose();
  w.holder.remove();
});

test("hovering a chip shows the honest microcopy tooltip; leaving hides it", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  // Camera framing the pile mid-screen: world (0.1,0.1) → screen (300, 200).
  w.emit({ center: [0.3, 0.3], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  assert.equal(layer.chipCount(), 1);

  // Hover the pill (its visual centre sits ~17px above the anchor). jsdom does no CSS
  // hit-testing, so the hover path is the host-level pointermove hit-test — dispatch there.
  w.holder.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 183, bubbles: true }));
  const tip = w.holder.querySelector<HTMLElement>(".overlay-chip-tooltip");
  assert.ok(tip !== null, "tooltip element created on hover");
  assert.equal(tip!.style.display, "block", "tooltip shown");
  assert.match(tip!.textContent ?? "", /≈5 images share this area; 2 shown/, "honest microcopy: true occupancy + kept");
  assert.equal(tip!.style.pointerEvents, "none", "the tooltip itself never intercepts");

  // Move far away → hidden.
  w.holder.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, clientY: 600, bubbles: true }));
  assert.equal(tip!.style.display, "none", "tooltip hides when the pointer leaves the pill");

  // Hover again, then toggle chips off → the tooltip must not survive.
  w.holder.dispatchEvent(new MouseEvent("pointermove", { clientX: 300, clientY: 183, bubbles: true }));
  assert.equal(tip!.style.display, "block");
  layer.setChipsEnabled(false);
  flushRaf();
  assert.equal(tip!.style.display, "none", "tooltip cleared with the chips");
  layer.dispose();
  w.holder.remove();
});

test("warm camera frames allocate ZERO new elements (the pool invariant, PR-179 review)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf(); // pools warm: chip div + its two spans exist
  assert.equal(layer.chipCount(), 1);

  const realCreate = document.createElement.bind(document);
  let created = 0;
  (document as { createElement: typeof document.createElement }).createElement = ((tag: string) => {
    created += 1;
    return realCreate(tag);
  }) as typeof document.createElement;
  try {
    for (let i = 0; i < 10; i++) {
      w.emit({ center: [0.5 - i * 0.001, 0.5], zoom: 1 / 1000 }, VP);
      flushRaf();
    }
  } finally {
    (document as { createElement: typeof document.createElement }).createElement = realCreate;
  }
  assert.equal(layer.chipCount(), 1, "chip still drawn across the pan");
  assert.equal(created, 0, "10 warm frames created 0 elements (was 2 spans/chip/frame)");
  layer.dispose();
  w.holder.remove();
});

test("a large table's hotspot scan runs in rAF slices and is superseded by a switch", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  // > one 32768-cell chunk: 40k cells piled into one z=1 tile (cap 2) → one hotspot, but
  // the scan must NOT complete inside setContext (the 1M switch-freeze fix).
  const n = 40_000;
  const positions: PositionTable = {
    x: new Float32Array(n).fill(0.1),
    y: new Float32Array(n).fill(0.1),
    w: new Float32Array(n).fill(0.001),
    h: new Float32Array(n).fill(0.001),
    count: n,
  };
  const { manifest } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  assert.equal(layer.hotspotCount(), 0, "the switch returns before the scan finishes (no freeze)");
  flushRaf(); // slice 2 → scan completes → refresh scheduled
  flushRaf(); // reposition draws
  assert.equal(layer.hotspotCount(), 1, "the chunked scan lands the same pile");
  assert.equal(layer.chipCount(), 1);

  // Supersede: a switch mid-scan drops the partial result (token-guarded, like the domain).
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  assert.equal(layer.hotspotCount(), 0, "rebuild cleared, scan pending again");
  layer.setContext(null); // the #167 swap-clear push
  flushRaf();
  flushRaf();
  assert.equal(layer.hotspotCount(), 0, "the superseded scan never lands its result");
  layer.dispose();
  w.holder.remove();
});

test("a camera update repositions the chip (camera-locked)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  const chip = w.holder.querySelector<HTMLElement>(".overlay-chip");
  const left1 = chip!.style.left;
  // Pan the camera; the chip must move to track the same world point.
  w.emit({ center: [0.3, 0.5], zoom: 1 / 1000 }, VP);
  flushRaf();
  assert.notEqual(chip!.style.left, left1, "chip left tracks the camera");
  layer.dispose();
  w.holder.remove();
});

test("the toggle turns chips off and on (ON default)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  assert.equal(layer.chipsEnabled(), true, "chips ON by default");
  assert.equal(layer.chipCount(), 1);
  layer.setChipsEnabled(false);
  flushRaf();
  assert.equal(layer.chipCount(), 0, "toggle off hides chips");
  layer.setChipsEnabled(true);
  flushRaf();
  assert.equal(layer.chipCount(), 1, "toggle on shows them again");
  layer.dispose();
  w.holder.remove();
});

test("a layout switch clears chips during the swap window, then rebuilds (no stale layer)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  assert.equal(layer.chipCount(), 1);
  // The controller pushes null FIRST on switch (#167 atomic clear)...
  layer.setContext(null);
  flushRaf();
  assert.equal(layer.hotspotCount(), 0, "hotspots cleared during the swap");
  assert.equal(layer.chipCount(), 0, "no stale-layout chips");
  // ...then the new (here: a grid layout with no piles) binds.
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  assert.equal(layer.chipCount(), 1, "rebuilt for the re-bound layout");
  layer.dispose();
  w.holder.remove();
});

test("datetime axis renders year ticks from a derived domain", async () => {
  const w = makeDomWorld();
  // Inject the domain (Seam-2 will supply it from the producer; here we bypass getMetadata).
  const domain: TimeDomain = { slope: (Date.UTC(2020, 0, 1) - Date.UTC(1100, 0, 1)) / 1, intercept: Date.UTC(1100, 0, 1) };
  const layer = createOverlayLayer(w.world, stubClient, undefined, {
    resolveTimeDomain: async () => domain,
  });
  const positions = posTable([
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
  ]);
  const manifest = {
    manifest_version: "2.4",
    dataset_id: "rijks_pilot",
    dataset_version: 2,
    layouts: [
      {
        layout_id: "by_date",
        label: "By date",
        type: "datetime",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 7, levels: [] },
      },
    ],
    column_roles: { filename: { column: "f", label: "F" }, datetime: { column: "date", label: "Date", format: "iso8601" } },
    dataset_metadata: { image_count: 2, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;

  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext);
  await settle(); // let the injected domain resolve
  flushRaf();
  assert.ok(layer.hasAxis(), "axis is active once the domain resolves");
  assert.ok(layer.axisTickCount() >= 3, "several year ticks rendered");
  const tick = w.holder.querySelector<HTMLElement>(".overlay-axis-tick .overlay-axis-label");
  assert.ok(tick !== null && /^\d{3,4}$/.test(tick!.textContent ?? ""), "a year label is shown");
  layer.dispose();
  w.holder.remove();
});

test("the datetime domain resolve is deferred OFF the synchronous switch path (no swap freeze, PR-179 review)", async () => {
  const w = makeDomWorld();
  let calls = 0;
  const domain: TimeDomain = { slope: (Date.UTC(2020, 0, 1) - Date.UTC(1900, 0, 1)) / 1, intercept: Date.UTC(1900, 0, 1) };
  const layer = createOverlayLayer(w.world, stubClient, undefined, {
    resolveTimeDomain: async () => {
      calls += 1;
      return domain;
    },
  });
  const { manifest, positions } = dateContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  // The switch must return BEFORE the resolver's O(n) endpoint scan runs — otherwise the
  // domain derivation blocks the swap at scale (the finding: it ran in the async prefix,
  // which executes synchronously). setContext only SCHEDULES the resolve.
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext);
  assert.equal(calls, 0, "resolver not invoked synchronously during the switch");
  await settle();
  assert.equal(calls, 1, "resolver runs on a later macrotask (off the switch path)");
  flushRaf();
  assert.ok(layer.hasAxis(), "the axis lands a beat after the swap");
  layer.dispose();
  w.holder.remove();
});

test("a switch before the deferred datetime resolve fires cancels it (token-guarded, no wasted scan)", async () => {
  const w = makeDomWorld();
  let calls = 0;
  const layer = createOverlayLayer(w.world, stubClient, undefined, {
    resolveTimeDomain: async () => {
      calls += 1;
      return null;
    },
  });
  const { manifest, positions } = dateContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext); // schedules the resolve
  layer.setContext(null); // the #167 swap-clear bumps domainToken → supersedes before it fires
  await settle();
  assert.equal(calls, 0, "the superseded resolve never ran its scan or getMetadata");
  assert.equal(layer.hasAxis(), false, "no stale axis");
  layer.dispose();
  w.holder.remove();
});

test("domainSampleCount config drives the endpoint sample size (was inert; PR-179 review)", async () => {
  const w = makeDomWorld();
  let requested: number[] = [];
  const recording = {
    getMetadata: async (_ds: string, ids: number[]) => {
      requested = ids;
      return [];
    },
  } as unknown as ApiClient;
  // No injected resolver ⇒ the REAL defaultResolveTimeDomain runs, reading config.domainSampleCount.
  const layer = createOverlayLayer(w.world, recording, { ...DEFAULT_OVERLAY_LAYER_CONFIG, domainSampleCount: 3 });
  const { manifest, positions } = dateContext(10); // 10 distinct-x cells
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext);
  await settle();
  // 3 lowest-x + 3 highest-x endpoints (deduped) = 6 ids — NOT the 10 the inert default (16,
  // capped at the 10 cells present) would have fetched.
  assert.equal(requested.length, 6, "exactly domainSampleCount cells sampled at each x-extreme");
  layer.dispose();
  w.holder.remove();
});

test("the pre-2.5 axis shim reads a stored timestamp's ISO strings whatever format is committed (#391)", async () => {
  // A collection with `unix_millis` committed over a stored timestamp (set-roles wrote that
  // before D-xxxii's check). The API serves the timestamp as ISO strings, so reading them by
  // the declared format gave NaN for every sample and no axis. They are read by type now.
  const w = makeDomWorld();
  const served = ["1100-01-01T00:00:00", "2020-01-01T00:00:00"];
  const client = {
    getMetadata: async (_ds: string, ids: number[]) => ids.map((id) => ({ id, fields: { date: served[id] } })),
  } as unknown as ApiClient;
  // No injected resolver ⇒ the REAL defaultResolveTimeDomain runs.
  const layer = createOverlayLayer(w.world, client);
  const { manifest, positions } = dateContext(2); // pre-2.5: no producer axis
  const committedMillis = {
    ...manifest,
    column_roles: { ...manifest.column_roles, datetime: { column: "date", label: "Date", format: "unix_millis" } },
  } as unknown as LayoutManifest;
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest: committedMillis, layoutId: "by_date", positions } as OverlayContext);
  await settle();
  flushRaf();
  assert.ok(layer.hasAxis(), "the shim fitted a domain from the ISO strings");
  const years = [...w.holder.querySelectorAll<HTMLElement>(".overlay-axis-tick .overlay-axis-label")]
    .map((el) => Number(el.textContent));
  assert.ok(years.length >= 3, `several year ticks: ${years}`);
  assert.ok(years.every((y) => y >= 1100 && y <= 2020), `ticks on the served dates, 1100..2020: ${years}`);
  layer.dispose();
  w.holder.remove();
});

test("dispose removes the DOM layer and releases the subscription", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  assert.ok(w.holder.querySelector(".overlay-substrate") !== null, "layer mounted");
  layer.dispose();
  assert.equal(w.holder.querySelector(".overlay-substrate"), null, "layer removed on dispose");
  // A post-dispose camera emit must not throw or re-create anything.
  w.emit({ center: [0.2, 0.2], zoom: 1 / 500 }, VP);
  flushRaf();
  assert.equal(w.holder.querySelector(".overlay-substrate"), null, "still removed");
  w.holder.remove();
});

// ---------------------------------------------------------------------------
// v2.5 — categorical band labels (Seam 2 consumer)
// ---------------------------------------------------------------------------

/** A categorical layout with band labels: a big top band, the structurally-missing band
 *  below it, and a TINY band whose gap is sub-pixel (→ reveal-culled). */
function categoricalContext(): { manifest: LayoutManifest; positions: PositionTable } {
  const positions = posTable([
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.3 },
    { x: 0.6, y: 0.7 },
    { x: 0.8, y: 0.9 },
  ]);
  const manifest = {
    manifest_version: "2.5",
    dataset_id: "rijks_pilot",
    dataset_version: 3,
    layouts: [
      {
        layout_id: "categorical_group",
        label: "Group",
        type: "categorical",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 1, levels: [] },
        annotations: {
          labels: [
            { text: "big", extent: [0, 0, 1, 0.5], count: 100 },
            { text: "", extent: [0, 0.5, 1, 1.0], count: 5, missing: true },
            { text: "tiny", extent: [0.95, 0.95, 0.97, 0.97], count: 1 },
          ],
        },
      },
    ],
    dataset_metadata: { image_count: 4, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;
  return { manifest, positions };
}

function visibleLabels(holder: HTMLElement): HTMLElement[] {
  return [...holder.querySelectorAll<HTMLElement>(".overlay-band-label")].filter(
    (el) => el.style.display === "block",
  );
}

test("band labels render inside the image-free gap (never over images) + zoom-reveal cull", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = categoricalContext();
  const state: CameraState = { center: [0.5, 0.5], zoom: 1 / 800 }; // whole [0,1] height fits 800px
  w.emit(state, VP);
  layer.setContext({ manifest, layoutId: "categorical_group", positions } as OverlayContext);
  flushRaf();

  assert.equal(layer.labelAnnotationCount(), 3, "three band labels available");
  // NB: 0 because this fixture's 4 cells sit under cap=64 — NOT because "categorical has
  // no piles" (a skewed categorical genuinely piles; see the stacked-toggles test below).
  assert.equal(layer.hotspotCount(), 0, "no tile is over cap in this small fixture → no chips");
  // The tiny band's gap slot is sub-pixel at this zoom → culled; the two big bands reveal.
  assert.equal(layer.labelCount(), 2, "only the big-enough bands reveal their labels (zoom-reveal)");

  const labels = visibleLabels(w.holder);
  assert.equal(labels.length, 2);
  const gapFrac = layer.config.labelGapFrac;
  const labelH = layer.config.labelHeightPx;
  for (const el of labels) {
    const y0 = el.textContent === "big" ? 0 : 0.5; // the two bands' extent tops
    const h = 0.5;
    const slotTop = worldToScreen(state, VP, 0, y0)[1];
    const slotBottom = worldToScreen(state, VP, 0, y0 + gapFrac * h)[1];
    const top = Number.parseFloat(el.style.top);
    // The drawn box [top, top+labelH] lies WITHIN the gap slot [slotTop, slotBottom]; the
    // gap slot is the band's image-free top strip (labelGapSlot unit test), so the label is
    // provably never over an image.
    assert.ok(Math.abs(top - slotTop) < 0.5, `${el.textContent}: label sits at the gap-slot top`);
    assert.ok(top + labelH <= slotBottom + 0.5, `${el.textContent}: label box fits inside the image-free gap`);
  }
  layer.dispose();
  w.holder.remove();
});

test("the structurally-missing bucket renders muted ('no label' placeholder, italic)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = categoricalContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 800 }, VP);
  layer.setContext({ manifest, layoutId: "categorical_group", positions } as OverlayContext);
  flushRaf();

  const missing = visibleLabels(w.holder).find((el) =>
    el.classList.contains("overlay-band-label--missing"),
  );
  assert.ok(missing !== undefined, "the missing band carries the muted modifier class");
  assert.equal(missing!.textContent, "no label", "shows a placeholder, not the empty value");
  assert.equal(missing!.style.fontStyle, "italic", "styled distinctly from a real band");
  const real = visibleLabels(w.holder).find((el) => el.textContent === "big");
  assert.ok(real !== undefined && !real!.classList.contains("overlay-band-label--missing"));
  assert.equal(real!.style.fontStyle, "normal", "a real-valued band is not muted");
  layer.dispose();
  w.holder.remove();
});

test("the counts toggle appends the group size to the label text (default OFF)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = categoricalContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 800 }, VP);
  layer.setContext({ manifest, layoutId: "categorical_group", positions } as OverlayContext);
  flushRaf();

  assert.equal(layer.countsEnabled(), false, "names-only by default");
  const bigLabel = () => visibleLabels(w.holder).find((el) => (el.textContent ?? "").startsWith("big"));
  assert.equal(bigLabel()!.textContent, "big", "names only");
  const toggle = w.holder.querySelector<HTMLElement>(".overlay-counts-toggle");
  assert.ok(toggle !== null && toggle.style.display !== "none", "the counts toggle is shown for a labelled layout");

  layer.setCountsEnabled(true);
  flushRaf();
  assert.equal(layer.countsEnabled(), true);
  assert.equal(bigLabel()!.textContent, "big (100)", "the count is appended when toggled on");
  layer.dispose();
  w.holder.remove();
});

test("the reveal gate uses REAL text measurement, not the Latin char estimate (R2, CJK)", () => {
  // A band whose gap slot is 48px wide on screen at this camera. A 4-char label fits under
  // the Latin char estimate (4·7+12 = 40 ≤ 48 — the jsdom fallback, no 2D canvas) but NOT
  // under a wide-glyph (CJK ~11px/char) measurement (4·11+12 = 56 > 48). Injecting the wide
  // measurer must CULL the label — proof the gate consults TRUE width, so a wide label never
  // spills past its band edge.
  const build = (measureText?: (t: string) => number): number => {
    const w = makeDomWorld();
    const layer = createOverlayLayer(w.world, stubClient, undefined, measureText ? { measureText } : {});
    const positions = posTable([
      { x: 0.43, y: 0.5 },
      { x: 0.43, y: 0.5 },
    ]);
    const manifest = {
      manifest_version: "2.5",
      dataset_id: "ds",
      dataset_version: 1,
      layouts: [
        {
          layout_id: "categorical_group",
          label: "G",
          type: "categorical",
          bbox: [0, 0, 1, 1],
          pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 1, levels: [] },
          annotations: { labels: [{ text: "本本本本", extent: [0.4, 0.3, 0.46, 0.7], count: 10 }] },
        },
      ],
      dataset_metadata: { image_count: 2, ingest_timestamp: "t" },
    } as unknown as LayoutManifest;
    w.emit({ center: [0.5, 0.5], zoom: 1 / 800 }, VP);
    layer.setContext({ manifest, layoutId: "categorical_group", positions } as OverlayContext);
    flushRaf();
    const count = layer.labelCount();
    layer.dispose();
    w.holder.remove();
    return count;
  };
  assert.equal(build(undefined), 1, "the char-estimate fallback reveals the label (fits the 48px slot)");
  assert.equal(build((t) => t.length * 11 + 12), 0, "the true CJK width culls it (it would spill the band)");
});

// ---------------------------------------------------------------------------
// v2.5 — the datetime axis SHIM REPLACEMENT (producer domain) + graceful degradation
// ---------------------------------------------------------------------------

test("datetime axis uses the v2.5 PRODUCER domain (no getMetadata shim call)", () => {
  const w = makeDomWorld();
  let metadataCalls = 0;
  const client = {
    getMetadata: async () => {
      metadataCalls++;
      return [];
    },
  } as unknown as ApiClient;
  const layer = createOverlayLayer(w.world, client);
  const positions = posTable([
    { x: 0.04, y: 0.5 },
    { x: 0.96, y: 0.5 },
  ]);
  const manifest = {
    manifest_version: "2.5",
    dataset_id: "rijks_pilot",
    dataset_version: 3,
    layouts: [
      {
        layout_id: "by_date",
        label: "By date",
        type: "datetime",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 7, levels: [] },
        annotations: {
          axes: [
            {
              orientation: "x",
              scale: "time",
              domain: ["1100-01-01T00:00:00+00:00", "2020-01-01T00:00:00+00:00"],
              range: [0.04, 0.96],
              label: "Captured",
            },
          ],
        },
      },
    ],
    column_roles: { filename: { column: "f", label: "F" }, datetime: { column: "date", label: "Captured", format: "iso8601" } },
    dataset_metadata: { image_count: 2, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;

  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext);
  flushRaf();
  assert.ok(layer.hasAxis(), "axis active synchronously from the producer domain");
  assert.ok(layer.axisTickCount() >= 3, "several year ticks rendered");
  assert.equal(metadataCalls, 0, "the producer domain REPLACES the getMetadata shim — no call");
  layer.dispose();
  w.holder.remove();
});

test("a pre-2.5 datetime layout (no annotations) gracefully degrades to the getMetadata shim", async () => {
  const w = makeDomWorld();
  const domain: TimeDomain = {
    slope: (Date.UTC(2020, 0, 1) - Date.UTC(1100, 0, 1)) / 1,
    intercept: Date.UTC(1100, 0, 1),
  };
  let resolveCalls = 0;
  const layer = createOverlayLayer(w.world, stubClient, undefined, {
    resolveTimeDomain: async () => {
      resolveCalls++;
      return domain;
    },
  });
  const positions = posTable([
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
  ]);
  const manifest = {
    manifest_version: "2.4", // a pre-2.5 bake: NO annotations
    dataset_id: "rijks_pilot",
    dataset_version: 2,
    layouts: [
      {
        layout_id: "by_date",
        label: "By date",
        type: "datetime",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 7, levels: [] },
      },
    ],
    column_roles: { filename: { column: "f", label: "F" }, datetime: { column: "date", label: "Date", format: "iso8601" } },
    dataset_metadata: { image_count: 2, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;

  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext);
  await settle(); // the shim resolves asynchronously
  flushRaf();
  assert.equal(resolveCalls, 1, "the pre-2.5 datetime layout fell back to the shim");
  assert.ok(layer.hasAxis(), "the axis still renders (graceful degradation)");
  layer.dispose();
  w.holder.remove();
});

test("the DECLINED-axis marker (axes: []) suppresses the shim — the producer's refusal is final", async () => {
  // PR-180 review: the R1 overflow guard was defeated end-to-end — the producer refused
  // the garbage axis, then the client shim re-derived and rendered it (year-52,000
  // ticks). A 2.5 datetime layout that declines its axis now emits axes: [] and the
  // shim must NOT run; only truly-absent annotations (pre-2.5) allow it.
  const w = makeDomWorld();
  let resolveCalls = 0;
  const layer = createOverlayLayer(w.world, stubClient, undefined, {
    resolveTimeDomain: async () => {
      resolveCalls++;
      return { slope: 1, intercept: 0 };
    },
  });
  const positions = posTable([
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
  ]);
  const manifest = {
    manifest_version: "2.5",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [
      {
        layout_id: "by_date",
        label: "By date",
        type: "datetime",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 7, levels: [] },
        annotations: { axes: [] }, // the producer considered an axis and DECLINED
      },
    ],
    column_roles: { filename: { column: "f", label: "F" }, datetime: { column: "date", label: "D", format: "unix_seconds" } },
    dataset_metadata: { image_count: 2, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;

  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "by_date", positions } as OverlayContext);
  await settle();
  flushRaf();
  assert.equal(resolveCalls, 0, "the shim never runs against a declined axis");
  assert.equal(layer.hasAxis(), false, "no axis renders — the refusal is honoured");
  layer.dispose();
  w.holder.remove();
});

// ---------------------------------------------------------------------------
// v2.7 — tick lock-step end to end (D-36 seam H4)
// ---------------------------------------------------------------------------

/** A datetime manifest whose axis optionally carries the v2.7 rung. Same shape as the v2.5
 *  producer-domain test above, so the ONLY difference between the two runs below is the
 *  presence of `interval` — which is the whole gate. */
function datetimeManifest(interval?: { kind: string; step: number }): LayoutManifest {
  return {
    manifest_version: interval === undefined ? "2.5" : "2.7",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [
      {
        layout_id: "by_date",
        label: "By date",
        type: "datetime",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 64, z_cap: 7, levels: [] },
        annotations: {
          axes: [
            {
              orientation: "x",
              scale: "time",
              domain: ["2021-01-01T00:00:00+00:00", "2021-09-01T00:00:00+00:00"],
              range: [0.04, 0.96],
              ...(interval === undefined ? {} : { interval }),
              label: "Captured",
            },
          ],
        },
      },
    ],
    column_roles: { filename: { column: "f", label: "F" }, datetime: { column: "date", label: "Captured", format: "iso8601" } },
    dataset_metadata: { image_count: 2, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;
}

function renderedTickLabels(interval?: { kind: string; step: number }): string[] {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const positions = posTable([
    { x: 0.04, y: 0.5 },
    { x: 0.96, y: 0.5 },
  ]);
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest: datetimeManifest(interval), layoutId: "by_date", positions } as OverlayContext);
  flushRaf();
  const labels = [...w.holder.querySelectorAll<HTMLElement>(".overlay-axis-tick")]
    .filter((el) => el.style.display !== "none")
    .map((el) => (el.lastChild as HTMLElement).textContent ?? "");
  layer.dispose();
  w.holder.remove();
  return labels;
}

test("a MONTH-binned bake renders month ticks; the same bake without the rung renders none", () => {
  // The defect, end to end. An eight-month dataset has no year boundary inside it, so the
  // pre-2.7 years-only ladder emits a single 2021-01-01 tick that maps to the very left edge
  // of the placement line — measured below as ZERO or ONE surviving tick. The producer knew
  // it binned by month all along; since v2.7 it says so, and the axis becomes readable.
  const withRung = renderedTickLabels({ kind: "month", step: 1 });
  assert.deepEqual(
    withRung,
    ["2021-01", "2021-02", "2021-03", "2021-04", "2021-05", "2021-06", "2021-07", "2021-08", "2021-09"],
    "every month bin boundary is drawn and labelled at month resolution",
  );
  const without = renderedTickLabels(undefined);
  assert.ok(
    without.length <= 1 && without.every((l) => /^\d{4}$/.test(l)),
    `a pre-2.7 bake keeps the years-only ladder (got ${JSON.stringify(without)})`,
  );
});

test("pyramid.dropped_total === 0 skips the pile scan; > 0 scans as before (the v2.5 shortcut)", () => {
  const build = (droppedTotal: number | undefined): number => {
    const w = makeDomWorld();
    const layer = createOverlayLayer(w.world, stubClient);
    const { manifest, positions } = pileContext(); // 5-cell pile over cap 2 → 1 real hotspot
    const pyramid = (manifest.layouts[0] as unknown as { pyramid: Record<string, unknown> }).pyramid;
    if (droppedTotal !== undefined) pyramid.dropped_total = droppedTotal;
    w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
    layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
    flushRaf();
    const count = layer.hotspotCount();
    layer.dispose();
    w.holder.remove();
    return count;
  };
  assert.equal(build(undefined), 1, "pre-2.5 (absent): the scan runs and finds the pile");
  assert.equal(build(3), 1, "dropped_total > 0: the scan runs (the pile is real)");
  assert.equal(build(0), 0, "dropped_total === 0: the O(n) scan is skipped entirely");
});

test("labels + piles CAN coexist; both toggles stack in the tray, neither occludes the other", () => {
  // PR-180 review, proven against the real producer: a skewed categorical column caps
  // z_max early (the tiler's cell-size ceiling keys off the LARGEST cell) and leaves
  // over-cap tiles — so a layout can carry band labels AND piles at once. The old code
  // hard-coded both toggles to the same absolute corner on the false "mutually
  // exclusive" premise; Counts painted over Piles and ate its clicks.
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  // A categorical layout with labels AND a 5-cell pile over cap 2.
  const positions = posTable([
    { x: 0.1, y: 0.1 },
    { x: 0.11, y: 0.11 },
    { x: 0.12, y: 0.1 },
    { x: 0.1, y: 0.12 },
    { x: 0.11, y: 0.1 },
    { x: 0.9, y: 0.9 },
  ]);
  const manifest = {
    manifest_version: "2.5",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [
      {
        layout_id: "categorical_skew",
        label: "Skewed",
        type: "categorical",
        bbox: [0, 0, 1, 1],
        pyramid: { container: "pmtiles", path: "p", tile_px: 512, thumb_px: 64, cap: 2, z_cap: 1, levels: [] },
        annotations: { labels: [{ text: "dominant", extent: [0, 0, 1, 0.9], count: 5 }] },
      },
    ],
    dataset_metadata: { image_count: 6, ingest_timestamp: "t" },
  } as unknown as LayoutManifest;

  w.emit({ center: [0.5, 0.5], zoom: 1 / 800 }, VP);
  layer.setContext({ manifest, layoutId: "categorical_skew", positions } as OverlayContext);
  flushRaf();

  assert.ok(layer.hotspotCount() > 0, "the skewed categorical layout genuinely piles");
  assert.ok(layer.labelAnnotationCount() > 0, "…and carries band labels — both at once");
  const piles = w.holder.querySelector<HTMLElement>(".overlay-chip-toggle");
  const counts = w.holder.querySelector<HTMLElement>(".overlay-counts-toggle");
  assert.ok(piles !== null && piles.style.display !== "none", "Piles toggle visible");
  assert.ok(counts !== null && counts.style.display !== "none", "Counts toggle visible");
  // Both live in the shared tray (a flex COLUMN — stacking is structural, so the two can
  // never overlap; jsdom does no layout, so the tray membership IS the guarantee).
  const tray = w.holder.querySelector<HTMLElement>(".overlay-toggle-tray");
  assert.ok(tray !== null);
  assert.equal(piles!.parentElement, tray, "Piles stacks in the tray");
  assert.equal(counts!.parentElement, tray, "Counts stacks in the tray");
  // Neither carries its own absolute anchor any more (the collision mechanism).
  assert.equal(piles!.style.position, "", "no per-button absolute positioning");
  assert.equal(counts!.style.position, "", "no per-button absolute positioning");
  assert.equal(counts!.getAttribute("aria-pressed"), "false", "Counts state is accessible");
  layer.dispose();
  w.holder.remove();
});

test("band labels render WITHOUT a position table (a failed positions fetch must not erase them)", () => {
  // PR-180 review: labels are pure manifest data but were gated on positions !== null —
  // a failed/absent positions_ref silently removed every band label.
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest } = categoricalContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 800 }, VP);
  layer.setContext({ manifest, layoutId: "categorical_group", positions: null } as OverlayContext);
  flushRaf();
  assert.equal(layer.labelAnnotationCount(), 3, "labels bound from the manifest alone");
  assert.ok(layer.labelCount() >= 2, "labels render with no table");
  assert.equal(layer.hotspotCount(), 0, "chips (which DO need positions) stay off");
  layer.dispose();
  w.holder.remove();
});

test("Counts ON shows the missing bucket's size too — 'no label (N)' (PR-180 review)", () => {
  // On sparse metadata the missing band is often the LARGEST group; the toggle exists to
  // reveal group sizes, so hiding exactly that one defeated it.
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = categoricalContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 800 }, VP);
  layer.setContext({ manifest, layoutId: "categorical_group", positions } as OverlayContext);
  layer.setCountsEnabled(true);
  flushRaf();
  const missing = visibleLabels(w.holder).find((el) =>
    el.classList.contains("overlay-band-label--missing"),
  );
  assert.ok(missing !== undefined);
  assert.equal(missing!.textContent, "no label (5)", "the missing band's size shows with Counts on");
  layer.dispose();
  w.holder.remove();
});

test("zooming INTO a band keeps its label clamped inside the visible gutter (PR-180 review)", () => {
  // The old cull dropped the label the moment the band's TOP edge left the viewport —
  // zooming in to browse a group erased its name. The label now clamps into the visible
  // part of the image-free strip, and hides only when NO usable strip remains on screen.
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = categoricalContext(); // "big" band extent [0,0,1,0.5], gapFrac 0.05
  layer.setContext({ manifest, layoutId: "categorical_group", positions } as OverlayContext);

  // zoom 1/2000: the big band's gutter strip is world [0, 0.025] → 50 px tall. Camera at
  // y=0.215 puts the strip's top at −30 px (off-screen — the OLD cull dropped it at −24)
  // while 20 px of strip remain visible — enough for the 14 px label, clamped to top 0.
  w.emit({ center: [0.5, 0.215], zoom: 1 / 2000 }, VP);
  flushRaf();
  const drawn = visibleLabels(w.holder);
  assert.equal(drawn.length, 1, "the big band's label survives the zoom-in");
  assert.equal(drawn[0].textContent, "big");
  assert.equal(Number.parseFloat(drawn[0].style.top), 0, "clamped to the visible strip top");

  // Deeper — the whole gutter strip is above the viewport (inside the band's image
  // interior, where everything visible is images): the label correctly hides.
  w.emit({ center: [0.5, 0.3], zoom: 1 / 2000 }, VP);
  flushRaf();
  assert.equal(visibleLabels(w.holder).length, 0, "no image-free strip on screen → no label");
  layer.dispose();
  w.holder.remove();
});

test("self-tears-down on world.dispose (symmetric with the sibling overlays)", () => {
  const w = makeDomWorld();
  const layer = createOverlayLayer(w.world, stubClient);
  const { manifest, positions } = pileContext();
  w.emit({ center: [0.5, 0.5], zoom: 1 / 1000 }, VP);
  layer.setContext({ manifest, layoutId: "scatter_dims", positions } as OverlayContext);
  flushRaf();
  assert.ok(w.holder.querySelector(".overlay-substrate") !== null);
  w.dispose(); // ViewerScreen calls world.dispose() on unmount (D-31)
  assert.equal(w.holder.querySelector(".overlay-substrate"), null, "torn down via world.onDispose");
  w.holder.remove();
});
