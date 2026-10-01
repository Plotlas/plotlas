// Node tier — Seam R2 P3: while tiles are failing, the loader SAYS SO, and stops saying
// it when they load again.
//
// The gap an operator found in a browser after R1 merged: with the backend down and a
// view already on screen you can pan while every tile 502s, scroll until cached tiles
// blank out, and never be told anything. R1's view-level report cannot fire there —
// `ensureActive` returns early for tiles already drawn or cached, so they are never
// re-requested, never fail, and "every wanted tile failed" never becomes true.
//
// The signal is built on a ledger at the `loadTile` choke point (a landed read where the
// load clears its retry budget, a failed read in the non-abort catch). NOT on
// `failedKeys`, which is wiped every stream pass, and NOT on a reads-issued counter,
// which does not exist.
//
// It counts KEYS, not attempts, and the verdict has two independent halves:
//   * the RATIO, over PERSISTENT sets. Every tile the current view wants sits in exactly
//     one of "failing" or "landed", by the outcome of its last read, pruned to `wanted` so
//     both stay viewport-bounded. ON needs the failing side to STRICTLY outnumber the
//     landed one. Per-WINDOW sets could not do this: after a window of healthy landings
//     the outage's first window was judged against them and lost, costing an extra window
//     before the signal appeared. MEASURED against this fixture: 2 windows, now 1.
//   * the RECENCY, per window: something must have failed DURING it. That half, and only
//     that half, clears the signal over an idle camera. It cannot be keyed on a success,
//     because a still camera issues no reads at all, so a success-only clear would be
//     permanent by construction over a backend that came back. And it cannot be keyed on
//     the latest outcome: `Cache-Control: immutable` on /datasets/* means cached ranges
//     succeed OFFLINE while uncached neighbours 502, which would strobe across one pan.
//
// Counting ATTEMPTS made a failing key worth 4x a landed one (its whole retry ladder), so
// a 20% minority read as a total outage. And per-KEY latest-outcome is what keeps the
// ladder's own job invisible: a key that 502s and then serves on retry has LANDED, so a
// blip the ladder absorbed over a fully drawn atlas says nothing at all.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { Table } from "apache-arrow";

import { createTilePyramid, TILE_FAILURE_WINDOW_MS } from "../src/renderer/tilePyramid.ts";
import type { LayoutManifest, PyramidDescriptor } from "../src/renderer/layout.ts";
import type { CameraState, Viewport, World } from "../src/renderer/world.ts";
import { createStubWorld, createStubCells } from "./fake_client.ts";
import type { FakeArchive } from "./fake_client.ts";

// --- fixture: the 4x4 fine grid the loader tests already use ------------------

function recordTable(cells: { id: number; x: number; y: number }[]): Table {
  return tableFromArrays({
    id: BigInt64Array.from(cells.map((c) => BigInt(c.id))),
    x: Float32Array.from(cells.map((c) => c.x)),
    y: Float32Array.from(cells.map((c) => c.y)),
    w: Float32Array.from(cells.map(() => 0.1)),
    h: Float32Array.from(cells.map(() => 0.1)),
    u: Float32Array.from(cells.map(() => 0)),
    v: Float32Array.from(cells.map(() => 0)),
    uw: Float32Array.from(cells.map(() => 0.125)),
    uh: Float32Array.from(cells.map(() => 0.125)),
  });
}

const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

function fineBody(cells: { id: number; x: number; y: number }[]): Uint8Array {
  const arrow = tableToIPC(recordTable(cells), "file");
  const out = new Uint8Array(4 + FAKE_WEBP.byteLength + arrow.byteLength);
  new DataView(out.buffer).setUint32(0, FAKE_WEBP.byteLength, false);
  out.set(FAKE_WEBP, 4);
  out.set(arrow, 4 + FAKE_WEBP.byteLength);
  return out;
}

function fineGridBodies(): Map<string, Uint8Array | null> {
  const out = new Map<string, Uint8Array | null>();
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) out.set(`2/${x}/${y}`, fineBody([{ id: y * 4 + x, x: 0.5, y: 0.5 }]));
  }
  // The `small` layout's own four tiles (z=1). A SECOND layout is what makes the
  // layout-prefixed keys observable: `grid`'s failures must not be judged against
  // `small`'s landings (review A3).
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) out.set(`1/${x}/${y}`, fineBody([{ id: y * 2 + x, x: 0.5, y: 0.5 }]));
  }
  return out;
}

/** A four-tile pyramid, so the escape layout is smaller than the one being escaped. */
function smallPyramid(): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/small/small_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [{ z: 1, tile_count: 4 }],
    z_cap: 0,
  };
}

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

function manifestFor(): LayoutManifest {
  return {
    manifest_version: "2.1",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [
      { layout_id: "grid", label: "grid", type: "grid", bbox: [0, 0, 1, 1], pyramid: fineGridPyramid() },
      { layout_id: "date", label: "date", type: "datetime", bbox: [0, 0, 1, 1], pyramid: fineGridPyramid() },
      { layout_id: "small", label: "small", type: "grid", bbox: [0, 0, 1, 1], pyramid: smallPyramid() },
    ],
    dataset_metadata: { image_count: 16, ingest_timestamp: "2026-01-01T00:00:00Z" },
  } as LayoutManifest;
}

const VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };
const FINE_GRID_ZOOM = 1 / 1024;
/** A view that wants all sixteen tiles (the prefetch margin grows a centred 100px
 *  viewport at 1/1024 to the whole 4x4 grid — the view the R1-05 pins measured). */
const WHOLE_GRID: CameraState = { center: [0.5, 0.5], zoom: FINE_GRID_ZOOM };
/** The same view nudged, so a re-emit is a fresh camera event rather than a no-op. */
const NUDGED: CameraState = { center: [0.5001, 0.5], zoom: FINE_GRID_ZOOM };

async function settle(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** A fake timer with a VIRTUAL CLOCK — copied rather than imported from
 *  tile_pyramid_loader.test.ts (importing another test file's internals would re-run its
 *  whole suite), and deliberately NOT that file's fire-everything-at-once version: this
 *  seam's window timer is longer than the whole retry ladder, so a fireAll() that ignores
 *  delays would run them in the wrong order and manufacture a flicker the code does not
 *  have. */
function fakeTimers(): {
  pending: { id: number; at: number; fn: () => void }[];
  advance: (ms: number) => Promise<void>;
  restore: () => void;
} {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending: { id: number; at: number; fn: () => void }[] = [];
  let nextId = 1;
  let now = 0;
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms = 0) => {
    const id = nextId++;
    pending.push({ id, at: now + ms, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: unknown) => {
    const idx = pending.findIndex((p) => p.id === id);
    if (idx >= 0) pending.splice(idx, 1);
  }) as typeof clearTimeout;
  return {
    pending,
    /** Move the virtual clock forward, firing each timer at ITS OWN due time (in due
     *  order) and letting the microtask queue drain between batches. */
    async advance(ms: number): Promise<void> {
      const target = now + ms;
      for (let guard = 0; guard < 200; guard++) {
        const due = pending.filter((p) => p.at <= target);
        if (due.length === 0) break;
        const at = Math.min(...due.map((p) => p.at));
        now = at;
        for (const p of pending.filter((q) => q.at <= at)) {
          const idx = pending.indexOf(p);
          if (idx >= 0) pending.splice(idx, 1);
          p.fn();
        }
        await settle();
      }
      now = target;
    },
    restore(): void {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
      (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = realClearTimeout;
    },
  };
}

/** Build a fake archive whose per-tile outcome is decided by `serves`. */
function archiveWhere(serves: (key: string) => boolean): FakeArchive {
  const bodies = fineGridBodies();
  const archive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      await Promise.resolve();
      if (signal?.aborted === true) {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      if (!serves(key)) throw new Error(`502 Bad Gateway for ${key}`);
      return bodies.get(key) ?? null;
    },
  };
  return archive;
}

function harness(archive: FakeArchive): {
  world: ReturnType<typeof createStubWorld>;
  pyramid: ReturnType<typeof createTilePyramid>;
  manifest: LayoutManifest;
  pushed: boolean[];
} {
  const world = createStubWorld();
  const cells = createStubCells();
  const manifest = manifestFor();
  const client = {
    pyramidUrl: (_ds: string, id: string) => `pyramid://${id}`,
    authHeaders: () => ({}),
  } as unknown as Parameters<typeof createTilePyramid>[2];
  const pyramid = createTilePyramid(world.world as unknown as World, cells, client, manifest, undefined, {
    openArchive: (() => archive) as unknown as (url: string, h: () => Record<string, string>) => never,
    decodeImage: () => Promise.resolve(new THREE.Texture()),
  });
  const pushed: boolean[] = [];
  pyramid.setTilesFailingListener((failing) => pushed.push(failing));
  return { world, pyramid, manifest, pushed };
}

// --- direction 1: it comes on ------------------------------------------------

test("a view whose reads are all 502ing says so — without the whole view being lost first", async () => {
  const archive = archiveWhere(() => false); // the API is stopped: every range request 502s
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    assert.equal(h.pyramid.tilesFailing(), false, "a loader that has read nothing claimed images were failing");

    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    // The verdict is taken per WINDOW, so it is deliberately not instant: the same
    // ~7s the retry ladder already spends. The acceptance recipe has to wait for it.
    assert.equal(h.pyramid.tilesFailing(), false, "a verdict was published before its window closed");

    await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(h.pyramid.tilesFailing(), true, "every read 502'd and the viewer said nothing");
    assert.deepEqual(h.pushed, [true], "the shell was not told exactly once");
  } finally {
    timers.restore();
  }
});

test("one bad tile in a view that still draws is not 'images aren't loading'", async () => {
  const archive = archiveWhere((key) => key !== "2/1/1"); // fifteen land, one fails forever
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    await timers.advance(TILE_FAILURE_WINDOW_MS * 2);
    assert.equal(
      h.pyramid.tilesFailing(),
      false,
      "one failing tile among fifteen that landed raised the outage signal",
    );
    assert.deepEqual(h.pushed, [], "the shell was woken about a view that is drawing");
  } finally {
    timers.restore();
  }
});

// --- direction 2: it goes off ------------------------------------------------

test("the signal clears itself when the failures stop, with no success to trigger it", async () => {
  // Stopping is the natural response to a broken picture, and a still camera issues no
  // reads at all: the ladder caps and only a camera move issues a fresh one. So the
  // clear cannot be keyed on a success — it has to be keyed on the absence of failures.
  const archive = archiveWhere(() => false);
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(h.pyramid.tilesFailing(), true);
    assert.equal(archive.requested.length > 0, true);
    const readsAtVerdict = archive.requested.length;

    // Nothing happens but time. No camera move, no read, and therefore no success. It
    // takes a couple of windows because the ladder's last retries land in the one after
    // the verdict; what matters is that it ends WITHOUT a success and without asking the
    // network anything.
    for (let i = 0; i < 4 && h.pyramid.tilesFailing(); i++) await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(archive.requested.length, readsAtVerdict, "the idle clear was bought with fresh network reads");
    assert.equal(h.pyramid.tilesFailing(), false, "the signal stuck on over an idle camera");
    assert.deepEqual(h.pushed, [true, false], "the shell was never told the outage ended");
    // ...and having settled, it holds no timer at all: an idle viewer must not tick.
    assert.equal(timers.pending.length, 0, "a settled loader left a window timer re-arming forever");
  } finally {
    timers.restore();
  }
});

test("the signal clears when the backend comes back and the tiles land", async () => {
  let down = true;
  const archive = archiveWhere(() => !down);
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(h.pyramid.tilesFailing(), true);

    down = false;
    h.pyramid.restreamView(); // what "Retry this view" drives; a pan does the same
    await settle();
    const readsAtRecovery = archive.requested.length;
    for (let i = 0; i < 4 && h.pyramid.tilesFailing(); i++) await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(h.pyramid.tilesFailing(), false, "the tiles landed and the viewer still said they were failing");
    assert.deepEqual(h.pushed, [true, false]);
    assert.equal(
      archive.requested.length,
      readsAtRecovery,
      "the recovery needed more reads than the one re-stream — re-anchor this pin",
    );
  } finally {
    timers.restore();
  }
});

test("a pan that mixes cached hits with 502s does not strobe the signal", async () => {
  // Caddy sets `Cache-Control: immutable` on /datasets/* and pmtilesClient fetches
  // without `no-store`, so during the acceptance recipe some ranges succeed OFFLINE
  // while their neighbours 502. Three windows of that, with the camera moving through
  // each one, must produce ONE transition. One column of four still serves, so twelve
  // keys are failing against four that land — a strict majority, which is what the
  // signal now requires (an even split is not "images aren't loading").
  const archive = archiveWhere((key) => key.split("/")[1] === "0");
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    for (const camera of [WHOLE_GRID, NUDGED, WHOLE_GRID]) {
      h.world.emit(camera, VIEWPORT);
      await settle();
      await timers.advance(TILE_FAILURE_WINDOW_MS);
    }
    assert.equal(h.pyramid.tilesFailing(), true, "half the grid 502'd and the viewer said nothing");
    assert.deepEqual(h.pushed, [true], `the signal strobed across a pan: ${JSON.stringify(h.pushed)}`);
  } finally {
    timers.restore();
  }
});

test("a blip the retry ladder absorbed says nothing at all", () => {
  // Every tile 502s once and serves on retry — the exact case RETRY_ATTEMPT_BACKOFF_MS
  // exists to absorb. Seven seconds later the atlas is COMPLETE, so a status bar saying
  // "images not loading" is a false alarm over a fully drawn view. Counting attempts
  // made this arm (16 failed attempts vs 16 landed ones); counting KEYS does not,
  // because every key's latest outcome is "landed".
  const attempts = new Map<string, number>();
  const archive = archiveWhere((key) => {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    return n > 1;
  });
  const timers = fakeTimers();
  return (async () => {
    try {
      const h = harness(archive);
      await h.pyramid.activateLayout(h.manifest, "grid", null);
      h.world.emit(WHOLE_GRID, VIEWPORT);
      await settle();
      await timers.advance(TILE_FAILURE_WINDOW_MS * 2);
      assert.equal(h.pyramid.tilesFailing(), false, "a blip the ladder healed raised the outage signal");
      assert.deepEqual(h.pushed, [], "the shell was woken about a view that fully drew");
    } finally {
      timers.restore();
    }
  })();
});

test("a MINORITY of failing tiles says nothing; a majority says it", async () => {
  // Attempt-counting armed at k >= N/5 — measured on this very fixture: 3 of 16 silent,
  // 4 of 16 firing. That also put this publisher in direct contradiction with its
  // sibling in the same file: `reportViewFailureIfUnrenderable` is pinned to stay SILENT
  // for a view that still draws, so at 4 of 16 one said the view was fine and the other
  // said images were not loading.
  for (const [bad, expected] of [
    [4, false],
    [8, false], // an even split is not a majority: the atlas is half there
    [13, true],
  ] as const) {
    const failing = new Set<string>();
    for (let i = 0; i < bad; i++) failing.add(`2/${i % 4}/${Math.floor(i / 4)}`);
    const timers = fakeTimers();
    try {
      const h = harness(archiveWhere((key) => !failing.has(key)));
      await h.pyramid.activateLayout(h.manifest, "grid", null);
      h.world.emit(WHOLE_GRID, VIEWPORT);
      await settle();
      await timers.advance(TILE_FAILURE_WINDOW_MS);
      assert.equal(
        h.pyramid.tilesFailing(),
        expected,
        `${bad} of 16 tiles failing: expected tilesFailing ${String(expected)}`,
      );
    } finally {
      timers.restore();
    }
  }
});

test("a torn-down loader does not keep claiming its images are failing", async () => {
  // The teardown cleared the window timer but left the verdict standing, and
  // `armFailureWindow` refuses to re-arm once disposed — so `tilesFailing()` was frozen
  // `true` for the rest of the handle's life with nothing able to move it.
  const timers = fakeTimers();
  try {
    const h = harness(archiveWhere(() => false));
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(h.pyramid.tilesFailing(), true);

    h.world.dispose();
    assert.equal(h.pyramid.tilesFailing(), false, "a disposed loader still reports an outage it can no longer see");
    assert.deepEqual(h.pushed, [true, false], "teardown never told the shell to stop showing it");
    assert.equal(timers.pending.length, 0, "teardown left a window timer armed");
  } finally {
    timers.restore();
  }
});

test("MEASURED: how long the signal takes when the outage follows a HEALTHY view (review A4)", async () => {
  // Every other pin here starts from a cold loader, where `previousLandedKeys` is 0 by
  // construction. The operator's path is not that: the view is already loaded, so the
  // window before the outage closed with a full set of LANDED keys, and the first outage
  // window is measured against them. This records what that actually costs, because the
  // acceptance step and three docblocks claimed one window.
  let down = false;
  const archive = archiveWhere(() => !down);
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    await timers.advance(TILE_FAILURE_WINDOW_MS); // a healthy window closes: 16 landed keys
    assert.equal(h.pyramid.tilesFailing(), false, "a fully drawn view reported an outage");

    down = true;
    // Switching layouts is what makes this fixture issue fresh reads: a SAME-layout
    // re-activation frees nothing (its `freeActive` filter is `layoutId !== id`), so every
    // tile stays active and `ensureActive` just touches them. On a real atlas the same
    // fresh reads come from panning onto tiles that were never resident; sixteen tiles
    // cannot model that, and the point being measured — an outage window judged after a
    // window of healthy landings — is identical either way.
    await h.pyramid.activateLayout(h.manifest, "date", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();

    let windows = 0;
    while (!h.pyramid.tilesFailing() && windows < 6) {
      await timers.advance(TILE_FAILURE_WINDOW_MS);
      windows += 1;
    }
    assert.equal(h.pyramid.tilesFailing(), true, "the signal never arrived over a total outage");
    // MEASURED 2026-08-22 against this fixture: ONE window, the same as the cold-start
    // pins, so the "~7 s" the acceptance step and the docblocks claim holds for the
    // operator's path too.
    //
    // It did not. The arithmetic this replaced compared the window's failing keys against
    // the PREVIOUS window's landed count — harmless from cold, where that count is 0, and
    // an extra window here, because the outage's first window was judged against a full
    // window of healthy landings and lost. Measured at 2 windows under the same fixture
    // (mutation M32). The sets are persistent now, so a key that fails MOVES out of the
    // landed set instead of being outvoted by its own history.
    assert.equal(windows, 1, `expected 1 window to the verdict after a healthy view, got ${windows}`);
  } finally {
    timers.restore();
  }
});

test("escaping a failing layout does not carry its failures into the new one (review A3)", async () => {
  // Tile keys are LAYOUT-PREFIXED, so a per-view ledger that `activateLayout` does not
  // reset judges the old layout's failures against the new layout's landings. Probe: grid
  // (16 tiles) 502ing; inside the same window the user escapes to a layout that serves —
  // the one thing that fixes it — and the status bar reads "images not loading" over a
  // view that fully drew, while `failureResolvedBySwitch` simultaneously clears the
  // recovery panel. Two read-outs contradicting each other on screen.
  const archive = archiveWhere((key) => key.startsWith("1/")); // only the small layout serves
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    // Escape to the layout that works, WITHOUT letting the grid's window close first.
    await h.pyramid.activateLayout(h.manifest, "small", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(
      h.pyramid.tilesFailing(),
      false,
      "the escape switch drew a whole view and the status bar still called it an outage",
    );
    assert.deepEqual(h.pushed, [], "the shell was woken about a view the user had already left");
  } finally {
    timers.restore();
  }
});

test("one broken tile nudged AFTER residency settles is still not an outage (review A5)", async () => {
  // The existing minority pin only measures the FIRST load, where the landed keys arrive
  // in the same window as the failure. Once a view has settled, a camera nudge issues
  // reads ONLY for tiles that never bound — so a lone permanently-broken tile is the only
  // read in the window, and a verdict measured against that window alone sees
  // `failed=1, landed=0` and fires over a 15-of-16-drawn atlas.
  //
  // The reproduction precondition matters and is easy to get wrong: at least one window
  // must close with NO READS AT ALL before the nudge, which is the normal idle case in the
  // field. Nudging earlier leaves the initial load's landings in scope and correctly
  // reports no defect.
  const archive = archiveWhere((key) => key !== "2/1/1");
  const timers = fakeTimers();
  try {
    const h = harness(archive);
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit(WHOLE_GRID, VIEWPORT);
    await settle();
    // Drain every armed timer — the retry ladder AND the windows — down to idle.
    for (let i = 0; i < 6 && timers.pending.length > 0; i++) await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(timers.pending.length, 0, "re-anchor: the loader never settled to idle");
    assert.equal(h.pyramid.tilesFailing(), false);

    // Now the nudge: 15 tiles are resident, so 2/1/1 is the only read this window sees.
    const readsBefore = archive.requested.length;
    h.world.emit(NUDGED, VIEWPORT);
    await settle();
    assert.equal(
      archive.requested.length > readsBefore,
      true,
      "re-anchor: the nudge issued no reads, so this measures nothing",
    );
    await timers.advance(TILE_FAILURE_WINDOW_MS);
    assert.equal(
      h.pyramid.tilesFailing(),
      false,
      "one broken tile among fifteen drawn ones read as an outage once residency had settled",
    );
    assert.deepEqual(h.pushed, [], "the shell was woken about a view that is 15/16 drawn");
  } finally {
    timers.restore();
  }
});

test("the window is the retry ladder, not a picked number", () => {
  // A read that failed is only finished trying once its whole T2-44 ladder is spent
  // (RETRY_ATTEMPT_BACKOFF_MS = [1000, 2000, 4000]), so one ladder is the shortest span
  // over which "these reads are failing" is a fact rather than a blip. Derived from that
  // constant rather than chosen — and it is why the acceptance recipe waits ~7s.
  assert.equal(TILE_FAILURE_WINDOW_MS, 1000 + 2000 + 4000);
});
