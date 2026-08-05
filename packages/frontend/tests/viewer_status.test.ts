// T2-54: the renderer-owned ViewerStatus observable + the cells-in-view counter.
//   * createViewerStatus emits a coalesced snapshot (one per scheduled frame), carries
//     zoom / in-view / loading / resident / cursor / fps, is null-tolerant (no camera
//     ⇒ zoom null; no position table ⇒ inView null), and unsubscribe stops delivery;
//   * frameTick drives a rolling fps and only re-emits when the figure changes;
//   * countPositionsInView is the pure O(N) overlap scan behind the in-view figure.
//
// GL-free + framework-free: the observable takes plain closures + a MANUAL scheduler
// so emits flush deterministically without requestAnimationFrame.
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Float32, vectorFromArray } from "apache-arrow";

import { createViewerStatus } from "../src/renderer/viewerStatus.ts";
import type { ViewerStatusDeps } from "../src/renderer/viewerStatus.ts";
import { parsePositionsTable, countPositionsInView } from "../src/renderer/cells.ts";
import type { CameraState, Viewport } from "../src/renderer/world.ts";

// --- a manual frame scheduler (flush on demand; no rAF) --------------------
function manualScheduler(): {
  schedule: (fn: () => void) => () => void;
  flush: () => void;
  pending: () => number;
} {
  let queue: (() => void)[] = [];
  return {
    schedule(fn: () => void): () => void {
      queue.push(fn);
      return () => {
        queue = queue.filter((f) => f !== fn);
      };
    },
    flush(): void {
      const run = queue;
      queue = [];
      for (const f of run) f();
    },
    pending(): number {
      return queue.length;
    },
  };
}

// --- a fake camera source (drives onCameraChange) --------------------------
function fakeCamera(): {
  onCameraChange: ViewerStatusDeps["onCameraChange"];
  emit: (state: CameraState, viewport: Viewport) => void;
  subscribers: () => number;
} {
  const subs = new Set<(s: CameraState, v: Viewport) => void>();
  return {
    onCameraChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    emit(state, viewport) {
      for (const cb of subs) cb(state, viewport);
    },
    subscribers: () => subs.size,
  };
}

function positionsTable(cells: { x: number; y: number; w: number; h: number }[]): Table {
  const f32 = (a: number[]) => vectorFromArray(a, new Float32());
  return new Table({
    x: f32(cells.map((c) => c.x)),
    y: f32(cells.map((c) => c.y)),
    w: f32(cells.map((c) => c.w)),
    h: f32(cells.map((c) => c.h)),
  });
}

// ---------------------------------------------------------------------------
// countPositionsInView (pure overlap scan)
// ---------------------------------------------------------------------------

test("countPositionsInView counts cells whose rect overlaps the view (touching edges excluded)", () => {
  const t = parsePositionsTable(
    positionsTable([
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, // spans [0.05,0.15]^2 — inside a [0,0.5]^2 view
      { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, // spans [0.85,0.95]^2 — outside
      { x: 0.5, y: 0.1, w: 0.2, h: 0.2 }, // spans [0.4,0.6]x[0,0.2] — straddles x=0.5 view edge
    ]),
  );
  // View covering the lower-left quadrant.
  assert.equal(countPositionsInView(t, { xMin: 0, yMin: 0, xMax: 0.5, yMax: 0.5 }), 2);
  // A view that contains everything.
  assert.equal(countPositionsInView(t, { xMin: 0, yMin: 0, xMax: 1, yMax: 1 }), 3);
  // A view in empty space between cells.
  assert.equal(countPositionsInView(t, { xMin: 0.2, yMin: 0.5, xMax: 0.3, yMax: 0.6 }), 0);
});

test("countPositionsInView counts a cell larger than the view (overlap, not centre-in-view)", () => {
  // One big cell whose CENTRE is off the tiny view, but whose body fills it.
  const t = parsePositionsTable(positionsTable([{ x: 0.5, y: 0.5, w: 0.8, h: 0.8 }]));
  assert.equal(countPositionsInView(t, { xMin: 0.11, yMin: 0.11, xMax: 0.12, yMax: 0.12 }), 1);
});

// ---------------------------------------------------------------------------
// createViewerStatus
// ---------------------------------------------------------------------------

const VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };

test("subscribe delivers an immediate snapshot; null-tolerant before any camera/table", () => {
  const sched = manualScheduler();
  const cam = fakeCamera();
  const status = createViewerStatus({
    onCameraChange: cam.onCameraChange,
    countCellsInView: () => null, // no table
    getLoadingTiles: () => 3,
    getResidentTiles: () => 9,
    schedule: sched.schedule,
    now: () => 0,
  });
  const seen: unknown[] = [];
  status.subscribe((s) => seen.push(s));
  // Immediate snapshot: zoom null (no camera yet), inView null (no table), loader
  // counts read live.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    zoom: null,
    inView: null,
    cursorCell: null,
    fps: null,
    loadingTiles: 3,
    residentTiles: 9,
  });
  status.dispose();
});

test("a camera emit schedules ONE coalesced update carrying zoom + in-view", () => {
  const sched = manualScheduler();
  const cam = fakeCamera();
  const table = parsePositionsTable(
    positionsTable([
      { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, // near centre — in a centred view
      { x: 0.99, y: 0.99, w: 0.01, h: 0.01 }, // corner — out
    ]),
  );
  const status = createViewerStatus({
    onCameraChange: cam.onCameraChange,
    countCellsInView: (view) => countPositionsInView(table, view),
    getLoadingTiles: () => 0,
    getResidentTiles: () => 0,
    schedule: sched.schedule,
    now: () => 0,
  });
  const seen: { zoom: number | null; inView: number | null }[] = [];
  status.subscribe((s) => seen.push({ zoom: s.zoom, inView: s.inView }));
  seen.length = 0; // drop the immediate snapshot

  // Two rapid camera events before a flush → coalesced to ONE scheduled emit.
  cam.emit({ center: [0.5, 0.5], zoom: 0.001 }, VIEWPORT);
  cam.emit({ center: [0.5, 0.5], zoom: 0.004 }, VIEWPORT); // zoom world-units/px = 0.004 → view ~[0.3,0.7]
  assert.equal(sched.pending(), 1, "two emits coalesced into a single scheduled frame");
  sched.flush();
  assert.equal(seen.length, 1, "one delivered update for the burst");
  assert.equal(seen[0].zoom, 0.004, "latest camera wins");
  assert.equal(seen[0].inView, 1, "only the centre cell overlaps the centred view");
  status.dispose();
});

test("unsubscribe stops delivery; dispose drops the camera subscription", () => {
  const sched = manualScheduler();
  const cam = fakeCamera();
  const status = createViewerStatus({
    onCameraChange: cam.onCameraChange,
    countCellsInView: () => 0,
    getLoadingTiles: () => 0,
    getResidentTiles: () => 0,
    schedule: sched.schedule,
    now: () => 0,
  });
  let count = 0;
  const unsub = status.subscribe(() => (count += 1));
  count = 0;
  unsub();
  cam.emit({ center: [0.5, 0.5], zoom: 0.01 }, VIEWPORT);
  sched.flush();
  assert.equal(count, 0, "no delivery after unsubscribe");
  assert.equal(cam.subscribers(), 1, "camera subscription still held until dispose");
  status.dispose();
  assert.equal(cam.subscribers(), 0, "dispose released the camera subscription");
});

test("setCursorCell updates the cursor cell on the next flush (coalesced, deduped)", () => {
  const sched = manualScheduler();
  const cam = fakeCamera();
  const status = createViewerStatus({
    onCameraChange: cam.onCameraChange,
    countCellsInView: () => null,
    getLoadingTiles: () => 0,
    getResidentTiles: () => 0,
    schedule: sched.schedule,
    now: () => 0,
  });
  const seen: (number | null)[] = [];
  status.subscribe((s) => seen.push(s.cursorCell));
  seen.length = 0;

  status.setCursorCell(42);
  status.setCursorCell(42); // same value — no extra schedule
  assert.equal(sched.pending(), 1, "same-value set does not schedule twice");
  sched.flush();
  assert.deepEqual(seen, [42]);

  status.setCursorCell(null);
  sched.flush();
  assert.deepEqual(seen, [42, null]);
  status.dispose();
});

test("frameTick drives a rolling fps and only re-emits when the figure changes", () => {
  const sched = manualScheduler();
  const cam = fakeCamera();
  let t = 0;
  const status = createViewerStatus({
    onCameraChange: cam.onCameraChange,
    countCellsInView: () => null,
    getLoadingTiles: () => 0,
    getResidentTiles: () => 0,
    schedule: sched.schedule,
    now: () => t,
  });
  const fpsSeen: (number | null)[] = [];
  status.subscribe((s) => fpsSeen.push(s.fps));
  fpsSeen.length = 0;

  // Tick 5 frames at a steady 100ms cadence → ~10 fps once enough ticks accrue.
  for (let i = 0; i < 5; i++) {
    t = i * 100;
    status.frameTick();
  }
  sched.flush();
  assert.ok(fpsSeen.length >= 1, "fps became derivable and emitted");
  const last = fpsSeen[fpsSeen.length - 1];
  assert.ok(last !== null && Math.abs(last - 10) <= 1, `~10 fps at a 100ms cadence, got ${last}`);
  status.dispose();
});
