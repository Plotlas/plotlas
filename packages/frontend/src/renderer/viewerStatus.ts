// The renderer's cockpit-status observable (T2-54). A small renderer-OWNED
// subscription surface the UI status bar + minimap consume, following the existing
// renderer↔UI callback convention (a `subscribe(cb)` returning an unsubscribe, like
// world.onCameraChange). It NEVER imports ui/*: the UI subscribes and renders the
// numbers; the renderer produces them.
//
// It carries the live view read-out — zoom, cells-in-view, cursor cell, fps, and the
// loader's in-flight / resident tile counts — COALESCED to at most one emit per
// animation frame (world.onCameraChange fires synchronously on every raw
// pointermove/wheel, 60-120+/s; the tile loader coalesces the same way). fps is a
// rolling average over recent frame ticks. Everything is null-tolerant: a dataset
// with no position table reports `inView: null` (the bar shows "—"), exactly like
// the pre-wired stub.
//
// GL-free and framework-free: the factory takes plain closures (a camera
// subscription, a cells-in-view counter, loader count getters). The stack
// (ViewerScreen) builds it after world/cells/pyramid/controller exist and wires
// world.start()'s render loop to `frameTick()` for fps. The node unit tests drive it
// with a fake camera + fake clock, no rAF and no GL.
import type { CameraState, Viewport } from "./world.ts";
import { guardScheduledWork } from "./health.ts";
import type { RendererFailureSink } from "./health.ts";

/** The renderer-owned status payload (T2-54). Distinct from the UI-shaped
 *  `ViewerStatus` in ui/StatusBar.ts, which the shell composes by merging THESE
 *  renderer fields with what it already knows (layout id, tags-highlighted,
 *  selected cell). Null means "not derivable" (e.g. no position table ⇒ inView) and
 *  the bar renders an em dash — the null-tolerant stub contract is preserved. */
export interface RendererStatus {
  /** world units per screen px (world.ts CameraState.zoom); null before the first
   *  camera emit. */
  zoom: number | null;
  /** cells whose rect overlaps the camera view rect, from the position table; null
   *  when the active layout baked no table (pre-2.2 / images-only) — the counter
   *  closure returns null there. */
  inView: number | null;
  /** the cell id currently under the cursor (the hover/pick path), or null. */
  cursorCell: number | null;
  /** rolling frames-per-second over the recent frame-tick window; null until enough
   *  ticks have accrued to estimate it. */
  fps: number | null;
  /** in-flight tile fetches for the current view (the loader's live count). */
  loadingTiles: number;
  /** tile textures currently DRAWN (the loader's active working set). */
  residentTiles: number;
}

/** The renderer-owned status surface (T2-54). `subscribe` returns an unsubscribe;
 *  emits are coalesced to at most one per animation frame. `setCursorCell` and
 *  `frameTick` are the two inputs the renderer stack pushes (a hover/pick updates
 *  the cursor cell; the render loop calls frameTick once per rendered frame for
 *  fps). `snapshot` reads the latest value synchronously (tests / an initial paint). */
export interface ViewerStatusHandle {
  subscribe(cb: (status: RendererStatus) => void): () => void;
  snapshot(): RendererStatus;
  /** Set the cell id under the cursor (null clears). Schedules a coalesced emit. */
  setCursorCell(id: number | null): void;
  /** Record one rendered frame (drives the rolling fps). Schedules a coalesced emit
   *  only when the fps figure actually changes, so a still 60fps loop does not spam
   *  subscribers every frame. */
  frameTick(now?: number): void;
  /** Seam R2 P2: re-arm the emit guard after the shell decides the renderer recovered.
   *  A latched emit freezes the whole read-out — zoom, in-view, fps, the minimap box —
   *  so it has to be releasable, and by the same event that releases the other sites. */
  resume(): void;
  dispose(): void;
}

/** Injected data sources (all GL-free closures). The stack supplies real ones; the
 *  unit tests supply fakes + a manual scheduler + a fake clock. */
export interface ViewerStatusDeps {
  /** Subscribe to camera changes; returns an unsubscribe. In production this is
   *  world.onCameraChange (which immediate-emits the current camera on subscribe, so
   *  `zoom` is populated without waiting for input). */
  onCameraChange(cb: (state: CameraState, viewport: Viewport) => void): () => void;
  /** Count the cells whose rect overlaps the view world-rect, or null when the
   *  active layout has no position table. O(N) over the table — this is why emits
   *  are throttled to one per frame (see the scheduler). */
  countCellsInView(view: { xMin: number; yMin: number; xMax: number; yMax: number }): number | null;
  /** The loader's in-flight tile-fetch count for the current view. */
  getLoadingTiles(): number;
  /** The loader's drawn (resident) tile count. */
  getResidentTiles(): number;
  /** Coalescing scheduler: run `fn` on the next animation frame, returning a cancel
   *  handle. Defaults to requestAnimationFrame; the node tests inject a manual queue
   *  so they can flush deterministically without rAF. Falls back to a microtask when
   *  requestAnimationFrame is unavailable (SSR / node). */
  schedule?: (fn: () => void) => (() => void);
  /** Seam R2 P2 (site 3): where a throw inside a COALESCED EMIT is published. This is
   *  the single point both inputs funnel through — the camera subscription and frameTick
   *  both only call `scheduleEmit`, and everything that can actually throw (the O(N)
   *  in-view scan, the subscribers' own work) runs in `emit` on the scheduler's callback,
   *  where nothing was catching it. Optional: omitted ⇒ a throw is logged and latched but
   *  not published. */
  health?: RendererFailureSink;
  /** Monotonic clock for fps (defaults to performance.now()); injectable for tests. */
  now?: () => number;
}

// Window (ms) over which the rolling fps is averaged. Long enough to be stable, short
// enough to react to a stall within a second.
const FPS_WINDOW_MS = 1000;
// Minimum frame ticks before an fps figure is reported (avoids a wild estimate from
// one or two frames right after start).
const FPS_MIN_TICKS = 4;

function defaultSchedule(fn: () => void): () => void {
  if (typeof globalThis.requestAnimationFrame === "function") {
    const h = globalThis.requestAnimationFrame(() => fn());
    return () => globalThis.cancelAnimationFrame(h);
  }
  // No rAF (node unit tests without an injected scheduler / SSR): microtask fallback.
  let cancelled = false;
  void Promise.resolve().then(() => {
    if (!cancelled) fn();
  });
  return () => {
    cancelled = true;
  };
}

export function createViewerStatus(deps: ViewerStatusDeps): ViewerStatusHandle {
  const schedule = deps.schedule ?? defaultSchedule;
  const now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));

  const subscribers = new Set<(status: RendererStatus) => void>();

  // Latest camera → the view rect the in-view count + zoom are derived from.
  let lastState: CameraState | null = null;
  let lastViewport: Viewport | null = null;
  let cursorCell: number | null = null;

  // Rolling frame-tick timestamps within the fps window.
  const frameTimes: number[] = [];
  let lastFps: number | null = null;

  let disposed = false;
  let cancelScheduled: (() => void) | null = null;

  function viewRect(): { xMin: number; yMin: number; xMax: number; yMax: number } | null {
    if (lastState === null || lastViewport === null) return null;
    const halfW = (lastViewport.width / 2) * lastState.zoom;
    const halfH = (lastViewport.height / 2) * lastState.zoom;
    return {
      xMin: lastState.center[0] - halfW,
      xMax: lastState.center[0] + halfW,
      yMin: lastState.center[1] - halfH,
      yMax: lastState.center[1] + halfH,
    };
  }

  function compute(): RendererStatus {
    const rect = viewRect();
    return {
      zoom: lastState !== null ? lastState.zoom : null,
      inView: rect !== null ? deps.countCellsInView(rect) : null,
      cursorCell,
      fps: lastFps,
      loadingTiles: deps.getLoadingTiles(),
      residentTiles: deps.getResidentTiles(),
    };
  }

  function emit(): void {
    if (disposed) return;
    const status = compute();
    for (const cb of subscribers) cb(status);
  }

  // Coalesce all inputs to one emit per frame: the O(N) in-view scan + the loader
  // reads happen at most once per animation frame regardless of how many camera
  // events / cursor updates arrived, matching the loader's own per-frame coalescing.
  // Seam R2 P2, site 3. THIS is the point that can throw — `compute()` runs the O(N)
  // in-view scan and the loader reads, and the subscriber callbacks are the shell's own
  // setState. Both inputs (the camera subscription and `frameTick`) reach it only through
  // `scheduleEmit`, on the SCHEDULER's callback, where nothing was catching anything: a
  // throw escaped as an unhandled rejection and, because `cancelScheduled` is cleared
  // before the call, the next input re-armed it and it threw again, every frame.
  const guardedEmit = guardScheduledWork({
    work: emit,
    code: "status-emit-failed",
    fail: (failure) => deps.health?.fail(failure),
  });

  function scheduleEmit(): void {
    if (disposed || cancelScheduled !== null) return;
    cancelScheduled = schedule(() => {
      // Cleared OUTSIDE the guard, so a latched emit still releases the coalescing flag —
      // otherwise `resume()` could never get another emit scheduled.
      cancelScheduled = null;
      guardedEmit();
    });
  }

  const unsubCamera = deps.onCameraChange((state, viewport) => {
    lastState = state;
    lastViewport = viewport;
    scheduleEmit();
  });

  /** Recompute the rolling fps from the frame-tick window; returns whether the
   *  integer fps figure changed (so we only wake subscribers on a real change). */
  function recomputeFps(t: number): boolean {
    // Drop ticks older than the window.
    const cutoff = t - FPS_WINDOW_MS;
    while (frameTimes.length > 0 && frameTimes[0] < cutoff) frameTimes.shift();
    let next: number | null = null;
    if (frameTimes.length >= FPS_MIN_TICKS) {
      const span = t - frameTimes[0];
      // (n-1) intervals across `span` ms → frames per second.
      if (span > 0) next = Math.round(((frameTimes.length - 1) / span) * 1000);
    }
    const changed = next !== lastFps;
    lastFps = next;
    return changed;
  }

  return {
    subscribe(cb: (status: RendererStatus) => void): () => void {
      subscribers.add(cb);
      // Immediate snapshot so a subscriber never observes a "before first emit" gap
      // (mirrors world.onCameraChange's immediate-emit contract).
      cb(compute());
      return () => {
        subscribers.delete(cb);
      };
    },

    snapshot(): RendererStatus {
      return compute();
    },

    setCursorCell(id: number | null): void {
      if (id === cursorCell) return;
      cursorCell = id;
      scheduleEmit();
    },

    frameTick(t = now()): void {
      if (disposed) return;
      frameTimes.push(t);
      // Only wake subscribers when the reported fps actually moves — a steady loop
      // must not force a per-frame O(N) in-view rescan.
      if (recomputeFps(t)) scheduleEmit();
    },

    resume(): void {
      guardedEmit.reset();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (cancelScheduled !== null) {
        cancelScheduled();
        cancelScheduled = null;
      }
      unsubCamera();
      subscribers.clear();
      frameTimes.length = 0;
    },
  };
}
