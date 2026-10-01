// Node tier — Seam R2 P2: renderer-driven SCHEDULED work that throws is caught, named,
// and stops re-arming — and COMES BACK when the condition that broke it has passed.
//
// `guardRenderFrame` (R1) wraps `renderer.render` and nothing else, and its only
// anti-loop mechanism is a RE-THROW — justified solely by three's animation chain
// re-arming on the line after it calls back. None of P2's four targets has that shape:
// the tile-loader rAF re-arms from `world.onCameraChange`, the fps proxy re-arms itself
// by name, the overview poll is re-armed by the platform, and a context-restored
// listener does not loop at all. So the guard here wraps the SCHEDULING call and owns a
// LATCH plus the failure code for its site.
//
// EVERY test below drives a REAL `createRendererHealth()`, never an array sink. The
// first version of this file used a sink, and that is exactly how a blocker survived
// fourteen mutations: `fail()` DROPS a layout-scoped failure while the context is lost,
// and drops any `"none"` failure over a standing one — so a guard that latched on the
// strength of a publish it never checked could be switched off for the life of the page
// by a transient throw. Directive 6 one level up: pin the COMPOSITION.
//
// Two of the four sites live in `ui/ViewerScreen.ts` (the fps proxy and the 750 ms
// overview poll) and are UNREACHABLE in both free tiers: they are created inside the
// mount effect, after `createWorld`, which jsdom cannot build (no WebGL). They are
// covered by the helper's own behaviour below plus a wiring pin over the source in
// tests/dom/renderer_guards.dom.test.ts — deliberately labelled as that.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { tableFromArrays, tableToIPC } from "apache-arrow";

import {
  clearResumedReadoutFailure,
  createRendererHealth,
  failureResolvedBySwitch,
  guardScheduledWork,
  recoveryAction,
  rendererControlState,
} from "../src/renderer/health.ts";
import type { RendererFailureCode, RendererHealth, RendererHealthHandle } from "../src/renderer/health.ts";
import { createTilePyramid } from "../src/renderer/tilePyramid.ts";
import type { LayoutManifest, PyramidDescriptor } from "../src/renderer/layout.ts";
import type { CameraState, Viewport, World } from "../src/renderer/world.ts";
import { createViewerStatus } from "../src/renderer/viewerStatus.ts";
import { createStubWorld, createStubCells, createFakeArchive } from "./fake_client.ts";
import type { StubCells } from "./fake_client.ts";

/** The failure code standing on a health handle, or its kind when it is not a failure. */
function standing(health: RendererHealthHandle): RendererFailureCode | RendererHealth["kind"] {
  const h = health.snapshot();
  return h.kind === "failed" ? h.failure.code : h.kind;
}

/** Run `fn` with console.error captured, so a pin can read what the guard logged. */
function captureErrors<T>(fn: (lines: unknown[][]) => T): T {
  const real = console.error;
  const lines: unknown[][] = [];
  console.error = (...args: unknown[]): void => {
    lines.push(args);
  };
  try {
    return fn(lines);
  } finally {
    console.error = real;
  }
}

// --- the helper itself, composed with the real observable ---------------------

test("a guarded site publishes ITS OWN code, latches, and re-arms only when reset", () => {
  const health = createRendererHealth();
  health.markReady();
  let ran = 0;
  let boom = true;
  const guarded = guardScheduledWork({
    work: () => {
      ran += 1;
      if (boom) throw new Error("streamView: bad focal");
    },
    code: "tile-stream-failed",
    fail: health.fail,
  });

  captureErrors(() => {
    assert.doesNotThrow(guarded, "the guard re-threw: none of P2's four sites can absorb that");
  });
  assert.equal(ran, 1);
  assert.equal(standing(health), "tile-stream-failed", "the guard published someone else's code");
  const failed = health.snapshot();
  assert.match(failed.kind === "failed" ? failed.failure.detail ?? "" : "", /bad focal/);

  // The latch is what ends the loop, since the re-throw cannot: the platform re-arms an
  // interval regardless, the fps proxy re-arms itself, and the loader re-arms from the
  // next camera event.
  guarded();
  guarded();
  assert.equal(ran, 1, "a latched site ran its work again — one throw per frame, forever");

  // ...and the latch is NOT permanent. A site whose precondition has been re-established
  // must come back, or one transient throw disables it for the life of the page.
  boom = false;
  guarded.reset();
  guarded();
  assert.equal(ran, 2, "a reset site never ran again — the latch outlived the condition that set it");
  guarded();
  assert.equal(ran, 3, "a site that recovered is still latched");
});

test("a throw is LOGGED even when the health observable drops the publish", () => {
  // The guard neither re-throws nor renders anything for a read-out code, so without a
  // log a dead fps proxy is invisible in every surface at once — where `main` at least
  // produced an uncaught exception. And `fail()` legitimately drops reports: a
  // layout-scoped one while the context is lost, any `"none"` one over a standing
  // failure. The log is the floor that does not depend on precedence.
  const health = createRendererHealth();
  health.markReady();
  health.markContextLost();
  const lines = captureErrors((captured) => {
    const guarded = guardScheduledWork({
      work: () => {
        throw new Error("streamView: bad focal");
      },
      code: "tile-stream-failed",
      fail: health.fail,
    });
    guarded();
    return captured;
  });
  assert.equal(health.snapshot().kind, "context-lost", "re-anchor: this pin needs the publish to be DROPPED");
  assert.equal(lines.length, 1, "a guarded site died in total silence");
  assert.equal(
    lines[0].some((a) => typeof a === "string" && a.includes("tile-stream-failed")),
    true,
    `the log does not name the site: ${JSON.stringify(lines[0].map(String))}`,
  );
});

test("a guard leaves a healthy site alone", () => {
  const health = createRendererHealth();
  health.markReady();
  let ran = 0;
  const healthy = guardScheduledWork({
    work: () => {
      ran += 1;
    },
    code: "status-emit-failed",
    fail: health.fail,
  });
  healthy();
  healthy();
  assert.equal(ran, 2, "the guard interfered with work that did not throw");
  assert.equal(standing(health), "ready");
});

// --- the codes the four sites carry, and what each one COSTS ------------------

test("a read-out failure never blocks a control, and a stack failure always does", () => {
  // The reason `guardRenderFrame`'s hard-coded `render-loop-failed` could not simply be
  // reused: it routes to a full stack rebuild and returns `{usable:false}`, so a throw
  // in a frame counter or a minimap thumbnail would block every control Seam R2 P1 just
  // guarded while the picture is fine.
  for (const code of ["status-emit-failed", "overview-poll-failed"] as const) {
    assert.equal(recoveryAction(code), "none", `${code} offers the user an action it cannot deliver`);
    const state = rendererControlState({ kind: "failed", failure: { code, layoutId: null, detail: null } });
    assert.equal(state.usable, true, `${code} blocked every control over a read-out`);
    assert.equal(state.reason, null);
  }
  // The view stopped streaming: the stack draws, so switching away is the escape and
  // "Retry this view" is the remedy — exactly `layout-assets-failed`'s treatment. That is
  // only honest because BOTH of those recoveries re-arm the latch (pinned below).
  assert.equal(recoveryAction("tile-stream-failed"), "retry-view");
  assert.equal(
    rendererControlState({
      kind: "failed",
      failure: { code: "tile-stream-failed", layoutId: null, detail: null },
    }).usable,
    true,
  );
  // The context came back and the loader could not rebind to it: that IS the stack.
  assert.equal(recoveryAction("context-restore-failed"), "retry-renderer");
  const blocked = rendererControlState({
    kind: "failed",
    failure: { code: "context-restore-failed", layoutId: null, detail: null },
  });
  assert.equal(blocked.usable, false);
  assert.equal(typeof blocked.reason, "string", "a blocked control must carry its reason");
});

test("a read-out failure is the least urgent truth there is", () => {
  // It must not displace a state that still has an action attached — a latched fps
  // ticker publishing over "Retry renderer" would take the user's only exit off screen.
  for (const held of ["render-loop-failed", "layout-assets-failed", "context-unrecoverable"] as const) {
    const health = createRendererHealth();
    health.fail({ code: held, layoutId: null, detail: null });
    health.fail({ code: "status-emit-failed", layoutId: null, detail: null });
    assert.equal(standing(health), held, `a read-out failure displaced ${held}`);
  }
  // ...and it must not swallow a LATER, more urgent one, which is what the old
  // "anything not retry-view is renderer-scoped" reading would have done.
  const health = createRendererHealth();
  health.markReady();
  health.fail({ code: "overview-poll-failed", layoutId: null, detail: null });
  health.markContextLost();
  assert.equal(standing(health), "context-lost", "a lost context was swallowed by a read-out failure");

  const later = createRendererHealth();
  later.markReady();
  later.fail({ code: "status-emit-failed", layoutId: null, detail: null });
  later.fail({ code: "layout-assets-failed", layoutId: "grid", detail: "502" });
  assert.equal(standing(later), "layout-assets-failed", "a view failure could not displace a read-out failure");
});

test("a SECOND read-out failure is discarded, and that is the decision", () => {
  // Reviewed and kept deliberately: the two read-out sites carry no action, so a second
  // one adds nothing a user or a surface could act on, and letting it through would mean
  // the newest trivial failure always wins over the oldest. The console log above is
  // where both are visible. Pinned so it is a decision, not an accident.
  const health = createRendererHealth();
  health.markReady();
  health.fail({ code: "status-emit-failed", layoutId: null, detail: null });
  health.fail({ code: "overview-poll-failed", layoutId: null, detail: null });
  assert.equal(standing(health), "status-emit-failed", "the second read-out failure overwrote the first");
  // ...and a rebuild clears it, which is the only thing that ever needs to.
  health.markStarting();
  assert.equal(standing(health), "starting");
});

test("every code Seam R2 adds has decided its own action", () => {
  const added: RendererFailureCode[] = [
    "tile-stream-failed",
    "context-restore-failed",
    "status-emit-failed",
    "overview-poll-failed",
  ];
  for (const code of added) assert.equal(typeof recoveryAction(code), "string", `${code} has no action`);
  assert.deepEqual(
    [...new Set(added.map((c) => recoveryAction(c)))].sort(),
    ["none", "retry-renderer", "retry-view"],
    "the four sites collapsed onto one consequence",
  );
});

// --- the loader's two sites, against the real loader and the real observable ---
//
// The GL-free tier has no requestAnimationFrame, so this drives the SYNCHRONOUS fallback
// (tilePyramid.ts `hasRaf === false`) inside `world.onCameraChange`'s callback loop —
// which is itself unguarded, so a re-throw there aborts every later camera subscriber.

function fineGridPyramid(): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [{ z: 2, tile_count: 16 }],
    z_cap: 0,
  };
}

const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

/** Fine-tile body framing, as the producer writes it: [u32 BE webp length][webp][arrow
 *  IPC FILE]. The records have to be real: a body that fails to decode never BINDS, and
 *  an unbound tile can never be demoted — which is the synchronous throw these pins
 *  drive. */
function fineBody(id: number): Uint8Array {
  const arrow = tableToIPC(
    tableFromArrays({
      id: BigInt64Array.from([BigInt(id)]),
      x: Float32Array.from([0.5]),
      y: Float32Array.from([0.5]),
      w: Float32Array.from([0.1]),
      h: Float32Array.from([0.1]),
      u: Float32Array.from([0]),
      v: Float32Array.from([0]),
      uw: Float32Array.from([0.125]),
      uh: Float32Array.from([0.125]),
    }),
    "file",
  );
  const out = new Uint8Array(4 + FAKE_WEBP.byteLength + arrow.byteLength);
  new DataView(out.buffer).setUint32(0, FAKE_WEBP.byteLength, false);
  out.set(FAKE_WEBP, 4);
  out.set(arrow, 4 + FAKE_WEBP.byteLength);
  return out;
}

function bodies(): Map<string, Uint8Array | null> {
  const out = new Map<string, Uint8Array | null>();
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) out.set(`2/${x}/${y}`, fineBody(y * 4 + x));
  return out;
}

function manifestFor(): LayoutManifest {
  return {
    manifest_version: "2.1",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [{ layout_id: "grid", label: "grid", type: "grid", bbox: [0, 0, 1, 1], pyramid: fineGridPyramid() }],
    dataset_metadata: { image_count: 16, ingest_timestamp: "2026-01-01T00:00:00Z" },
  } as LayoutManifest;
}

const VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };
const SMALL_VP: Viewport = { width: 10, height: 10, devicePixelRatio: 1 };
const FINE_GRID_ZOOM = 1 / 1024;
const WHOLE_GRID: CameraState = { center: [0.5, 0.5], zoom: FINE_GRID_ZOOM };
const ONE_CORNER: CameraState = { center: [0.06, 0.06], zoom: FINE_GRID_ZOOM };

async function settle(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

interface LoaderHarness {
  world: ReturnType<typeof createStubWorld>;
  pyramid: ReturnType<typeof createTilePyramid>;
  manifest: LayoutManifest;
  health: RendererHealthHandle;
  cells: StubCells;
  reads: () => number;
  /** Arm/disarm a synchronous throw on the demotion path inside streamView. */
  breakDemote: (on: boolean) => void;
  demoteAttempts: () => number;
}

function loaderHarness(): LoaderHarness {
  const world = createStubWorld();
  const cells = createStubCells();
  const manifest = manifestFor();
  const health = createRendererHealth();
  const archive = createFakeArchive(bodies());
  const client = {
    pyramidUrl: (_ds: string, id: string) => `pyramid://${id}`,
    authHeaders: () => ({}),
  } as unknown as Parameters<typeof createTilePyramid>[2];
  const pyramid = createTilePyramid(
    world.world as unknown as World,
    cells,
    client,
    manifest,
    undefined,
    {
      openArchive: (() => archive) as unknown as (url: string, h: () => Record<string, string>) => never,
      decodeImage: () => Promise.resolve(new THREE.Texture()),
    },
    health,
  );
  let broken = false;
  let attempts = 0;
  cells.dropTile = (): void => {
    attempts += 1;
    if (broken) throw new Error("cells.dropTile: bucket 2:9 is gone");
  };
  return {
    world,
    pyramid,
    manifest,
    health,
    cells,
    reads: () => archive.requested.length,
    breakDemote: (on: boolean) => {
      broken = on;
    },
    demoteAttempts: () => attempts,
  };
}

/** Bind the whole grid, then zoom into a corner so most of it leaves `wanted` with
 *  nothing in flight — the retain sweep then demotes SYNCHRONOUSLY inside streamView,
 *  which is a real throw on the loader's own frame path, not an injected camera. */
async function bindThenBreakDemote(h: LoaderHarness): Promise<void> {
  h.world.emit(WHOLE_GRID, VIEWPORT);
  await settle();
  h.breakDemote(true);
  h.world.emit(ONE_CORNER, SMALL_VP);
}

test("a throw inside the loader's coalesced refresh is named, latched, and does not abort the camera", async () => {
  const h = loaderHarness();
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  h.health.markReady();
  h.world.emit(WHOLE_GRID, VIEWPORT);
  await settle();

  // A LATER camera subscriber, registered after the loader's own. `world.ts:643`'s emit
  // is a bare `for (const cb of callbacks) cb(...)`, so a re-throw from the loader would
  // take every subscriber after it down — the status observable and the minimap box.
  let laterSubscriberRuns = 0;
  h.world.world.onCameraChange(() => {
    laterSubscriberRuns += 1;
  });

  h.breakDemote(true);
  captureErrors(() => {
    assert.doesNotThrow(() => h.world.emit(ONE_CORNER, SMALL_VP), "the loader's throw escaped into world.emit");
  });
  assert.equal(laterSubscriberRuns, 1, "a later camera subscriber never ran — the emit loop was aborted");
  assert.equal(standing(h.health), "tile-stream-failed", "the loader claimed the render loop had died");

  // ...and it does not throw once per frame of movement, forever.
  const attemptsAtFailure = h.demoteAttempts();
  h.world.emit(WHOLE_GRID, VIEWPORT);
  h.world.emit(ONE_CORNER, SMALL_VP);
  assert.equal(h.demoteAttempts(), attemptsAtFailure, "the refresh re-armed into the same throw");
  assert.equal(laterSubscriberRuns, 3, "later camera subscribers stopped running after the failure");
});

test("a transient throw during a context loss does not deafen the loader for the life of the page", async () => {
  // THE regression this seam nearly shipped. `onContextLost` does not unsubscribe
  // `world.onCameraChange`, so panning while the context is lost still runs streamView —
  // against buckets the loss just stripped. The guard latches; `fail()` then DROPS the
  // report, because a layout-scoped failure yields to a lost context. Nothing lands on
  // the observable, so nothing downstream can notice, and after the restore repairs
  // everything the coalesced refresh would stay switched off forever — a regression
  // against `main`, where the unguarded throw self-healed on the next camera move.
  const h = loaderHarness();
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  h.health.markReady();

  // BOTH halves, as production does them: `createWorld` publishes the transition to the
  // health observable and the loader reacts to the canvas event. `createStubWorld` has no
  // health wiring, so the test supplies the half the stub omits.
  h.health.markContextLost();
  h.world.fireContextLost();
  assert.equal(standing(h.health), "context-lost");

  // The user pans while it is lost: tiles re-load, then a pan demotes them and throws.
  captureErrors(() => {});
  await bindThenBreakDemote(h);
  assert.equal(
    standing(h.health),
    "context-lost",
    "re-anchor this pin: it needs the publish to be DROPPED by precedence",
  );

  // The context comes back and the loader repairs itself.
  h.breakDemote(false);
  h.health.markContextRestored();
  h.world.fireContextRestored();
  assert.equal(standing(h.health), "ready");

  const readsAtRestore = h.reads();
  h.world.emit(WHOLE_GRID, VIEWPORT);
  await settle();
  assert.equal(
    h.reads() > readsAtRestore,
    true,
    "the loader is deaf to the camera after a restore — the latch outlived the loss",
  );
});

test("'Retry this view' re-arms the stream guard, and is itself guarded", async () => {
  // `tile-stream-failed` offers "Retry this view", which drives `restreamView()`. That
  // used to call `refresh()` DIRECTLY: it bypassed the latch, so the view re-streamed
  // once and was dead again on the next pan — the one action offered doing almost
  // nothing — and a second throw would have escaped into the click handler.
  const h = loaderHarness();
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  h.health.markReady();
  captureErrors(() => {});
  await bindThenBreakDemote(h);
  assert.equal(standing(h.health), "tile-stream-failed");

  // A second failure during the retry must be CAUGHT, not thrown at the caller.
  captureErrors(() => {
    assert.doesNotThrow(() => h.pyramid.restreamView(), "the retry threw into the click that asked for it");
  });

  h.breakDemote(false);
  h.pyramid.restreamView();
  const readsAtRetry = h.reads();
  h.world.emit(WHOLE_GRID, VIEWPORT);
  await settle();
  assert.equal(h.reads() > readsAtRetry, true, "the view re-streamed once and went deaf again on the next pan");
});

test("a layout activation re-arms the stream guard, so a switch that clears the alert is honest", async () => {
  // `failureResolvedBySwitch` is TRUE for `tile-stream-failed`, so a successful layout
  // switch erases the panel. That is only honest if the switch also brings the loader
  // back; otherwise it leaves `{kind:"ready"}` over a loader that is permanently deaf.
  const h = loaderHarness();
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  h.health.markReady();
  captureErrors(() => {});
  await bindThenBreakDemote(h);
  assert.equal(standing(h.health), "tile-stream-failed");

  h.breakDemote(false);
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  const readsAtSwitch = h.reads();
  h.world.emit(WHOLE_GRID, VIEWPORT);
  await settle();
  assert.equal(h.reads() > readsAtSwitch, true, "the switch cleared the alert over a loader that stayed deaf");
});

test("a throw while handling a restored context is named as the stack, not as the view", async () => {
  const h = loaderHarness();
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  h.health.markReady();
  h.world.emit(WHOLE_GRID, VIEWPORT);
  await settle();

  let restoreBroken = true;
  h.cells.handleContextRestored = (): void => {
    if (restoreBroken) throw new Error("cells.handleContextRestored: no program");
    h.cells.contextRestores += 1; // keep the stub's own counter honest when it does work
  };
  h.world.fireContextLost();
  captureErrors(() => {
    assert.doesNotThrow(() => h.world.fireContextRestored(), "the throw escaped the event listener");
  });
  assert.equal(standing(h.health), "context-restore-failed");

  // A FRESH loss is a fresh episode: the restore handler must be allowed to try again,
  // or one bad restore makes every later one a silent no-op.
  restoreBroken = false;
  h.health.markStarting();
  h.world.fireContextLost();
  const restoresBefore = h.cells.contextRestores;
  h.world.fireContextRestored();
  assert.equal(
    h.cells.contextRestores > restoresBefore,
    true,
    "a second restore was swallowed by the first one's latch",
  );
});

// --- site 3, moved to the point where the work actually happens ---------------

/** A manual frame scheduler (flush on demand; no rAF) — the shape viewer_status.test.ts
 *  uses, copied rather than imported from another test file's internals. */
function manualScheduler(): { schedule: (fn: () => void) => () => void; flush: () => void } {
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
  };
}

const A_VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };

test("a throw inside the status observable's coalesced emit is caught, named, and re-armable", () => {
  // The guard used to wrap `status.frameTick()`, which is `frameTimes.push` plus
  // arithmetic plus `scheduleEmit()` — it cannot throw. Everything fallible (the O(N)
  // `countCellsInView` scan, and the subscribers' own setState) runs inside `emit()`, on
  // a SEPARATE scheduled callback, outside that guard. So the code could never fire and
  // the real throw escaped as an unhandled rejection — and because `scheduleEmit` clears
  // `cancelScheduled` BEFORE calling, the next input re-armed it every time.
  const health = createRendererHealth();
  health.markReady();
  const sched = manualScheduler();
  let boom = true;
  let scans = 0;
  let cameraCb: ((s: CameraState, v: Viewport) => void) | null = null;
  const status = createViewerStatus({
    onCameraChange: (cb) => {
      cameraCb = cb;
      return () => {};
    },
    countCellsInView: () => {
      scans += 1;
      if (boom) throw new Error("countCellsInView: positions table is gone");
      return 1;
    },
    getLoadingTiles: () => 0,
    getResidentTiles: () => 0,
    schedule: sched.schedule,
    now: () => 0,
    health,
  });
  let emits = 0;
  status.subscribe(() => {
    emits += 1;
  });
  const drive = cameraCb as unknown as (s: CameraState, v: Viewport) => void;
  assert.equal(typeof drive, "function", "re-anchor: the observable never subscribed to the camera");

  drive({ center: [0.5, 0.5], zoom: 1 }, A_VIEWPORT);
  captureErrors(() => {
    assert.doesNotThrow(() => sched.flush(), "the emit threw out of its own scheduled callback");
  });
  assert.equal(standing(health), "status-emit-failed", "a dead status read-out was never named");

  // ...and it does not re-arm into a throw loop on the next camera event.
  const scansAtFailure = scans;
  drive({ center: [0.6, 0.5], zoom: 1 }, A_VIEWPORT);
  sched.flush();
  assert.equal(scans, scansAtFailure, "the emit re-armed into the same throw");

  // The read-out comes back when the shell says the renderer recovered.
  boom = false;
  status.resume();
  const emitsBeforeResume = emits;
  drive({ center: [0.7, 0.5], zoom: 1 }, A_VIEWPORT);
  sched.flush();
  assert.equal(emits > emitsBeforeResume, true, "the status bar stayed frozen after the renderer recovered");
  status.dispose();
});

test("releasing a read-out latch also retracts the report it made obsolete (T2-232)", () => {
  // The latch and the health state need ONE owner. The successful-switch path already
  // decides a switch IS these sites' recovery event by releasing their latches — and then
  // declined to retract the report that event makes obsolete, leaving `snapshot().kind`
  // reading `"failed"` over a viewer whose read-out is running again.
  const health = createRendererHealth();
  health.markReady();
  health.fail({ code: "status-emit-failed", layoutId: null, detail: "boom" });
  assert.equal(standing(health), "status-emit-failed");
  clearResumedReadoutFailure(health);
  assert.equal(standing(health), "ready", "the latch was released and the report left standing");

  // It must NOT touch a failure that still has an action attached — those are cleared by
  // the action, not by a background job coming back.
  for (const code of ["render-loop-failed", "layout-assets-failed", "context-unrecoverable"] as const) {
    const other = createRendererHealth();
    other.fail({ code, layoutId: null, detail: null });
    clearResumedReadoutFailure(other);
    assert.equal(standing(other), code, `resuming a read-out cleared ${code}`);
  }
  // ...and it is a no-op on a healthy viewer.
  const fine = createRendererHealth();
  fine.markReady();
  clearResumedReadoutFailure(fine);
  assert.equal(standing(fine), "ready");
});

// --- B1: the "one field, no drift" guarantee, over ALL the codes --------------

test("every failure code's blockedness agrees with its offered action", () => {
  // R1's pins iterate the four codes it shipped, so five of the nine now in the union are
  // unpinned for the seam's central guarantee — including all four Seam R2 added, which
  // are exactly the ones whose consequences differ.
  const codes: RendererFailureCode[] = [
    "webgl2-unavailable",
    "render-loop-failed",
    "context-unrecoverable",
    "layout-assets-failed",
    "boot-failed",
    "tile-stream-failed",
    "context-restore-failed",
    "status-emit-failed",
    "overview-poll-failed",
  ];
  for (const code of codes) {
    const action = recoveryAction(code);
    const state = rendererControlState({ kind: "failed", failure: { code, layoutId: null, detail: null } });
    // A control is blocked exactly when the remedy replaces the stack. One field decides
    // both, so they cannot disagree — this asserts the derivation, not a second copy.
    const stackRemedy = action === "retry-renderer" || action === "reload";
    assert.equal(state.usable, !stackRemedy, `${code}: blockedness disagreed with the action`);
    assert.equal(
      state.reason === null,
      !stackRemedy,
      `${code}: a blocked control with no reason, or a live one carrying one`,
    );
    // ...and what a switch may clear is the same one field the panel's button reads.
    assert.equal(
      failureResolvedBySwitch({ kind: "failed", failure: { code, layoutId: null, detail: null } }),
      action === "retry-view",
      `${code}: what a switch clears disagreed with what the panel offers`,
    );
  }
  // Every action in the union is actually reachable from some code — a dead action is a
  // branch no test can drive.
  assert.deepEqual(
    [...new Set(codes.map((c) => recoveryAction(c)))].sort(),
    ["none", "reload", "retry-renderer", "retry-view"],
  );
});

// --- A13: the REPORTING half is inside the guard too --------------------------

test("a throwing report cannot escape the guard back into the camera loop (review A13)", () => {
  // The no-re-throw contract is stated for `deps.work()` and was only implemented there.
  // `deps.fail` → `health.fail` → `set()` → `for (const cb of subscribers) cb(next)` has
  // no try of its own, so one throwing subscriber turned a REPORT into an exception
  // escaping `run()` into `world.onCameraChange`'s emit loop — killing the status
  // observable and the minimap box, the exact outcome the contract exists to prevent. And
  // with the latch already set, the site was dead AND unreported: worst of both.
  const health = createRendererHealth();
  health.markReady();
  let deliveries = 0;
  health.subscribe(() => {
    deliveries += 1;
    if (deliveries > 1) throw new Error("subscriber: setState on an unmounted tree");
  });

  let ran = 0;
  const guarded = guardScheduledWork({
    work: () => {
      ran += 1;
      throw new Error("streamView: bad focal");
    },
    code: "tile-stream-failed",
    fail: health.fail,
  });
  captureErrors(() => {
    assert.doesNotThrow(guarded, "a throwing SUBSCRIBER escaped the guard into the camera emit loop");
  });
  assert.equal(ran, 1);
  guarded();
  assert.equal(ran, 1, "the latch did not survive a throwing report");

  // ...and the same for the log, which a browser extension or analytics shim can patch.
  const healthy = createRendererHealth();
  healthy.markReady();
  let alsoRan = 0;
  const logging = guardScheduledWork({
    work: () => {
      alsoRan += 1;
      throw new Error("refreshOverview: no layout");
    },
    code: "overview-poll-failed",
    fail: healthy.fail,
  });
  const realError = console.error;
  console.error = (): void => {
    throw new Error("console.error: patched by an extension");
  };
  try {
    assert.doesNotThrow(logging, "a throwing console.error escaped the guard");
  } finally {
    console.error = realError;
  }
  assert.equal(alsoRan, 1);
});
