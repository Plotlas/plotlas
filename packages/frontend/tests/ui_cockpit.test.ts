// Tier-1 component smokes for the Phase B Explorer cockpit: react-dom/server
// renderToString — no jsdom, no testing-library, no new deps. StatusBar and
// Minimap are createElement-based .ts modules so the node test runner can import
// them (it cannot parse JSX/.tsx). Model: ui_components.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { StatusBar } from "../src/ui/StatusBar.ts";
import type { ViewerStatus } from "../src/ui/StatusBar.ts";
import {
  Minimap,
  worldRectToMinimap,
  minimapFractionToWorld,
  paintOverview,
  paintTiles,
  fillGround,
  readGroundColor,
  bboxKey,
  retainedIdentity,
  MINIMAP_GROUND_FALLBACK,
} from "../src/ui/Minimap.ts";
import type { MinimapOverview, MinimapCtx } from "../src/ui/Minimap.ts";
import { runLocate } from "../src/ui/Lightbox.ts";

// ---------------------------------------------------------------------------
// StatusBar (null-heavy status renders em dashes; loadingTiles > 0 is accented)
// ---------------------------------------------------------------------------

test("StatusBar renders em-dash placeholders for a null-heavy status", () => {
  const status: ViewerStatus = {
    layoutId: "grid",
    zoom: null,
    inView: null,
    loadingTiles: 0,
    tags: { status: "none", selected: 0, matched: 0, total: 0 },
    selectedCell: null,
    cursor: null,
    fps: null,
  };
  const html = renderToString(h(StatusBar, { status }));
  // Renderer-owned values arrive null → render as —.
  assert.match(html, /zoom —×/);
  assert.match(html, /— in view/);
  assert.match(html, /— fps/);
  // What the shell knows is filled: layout id, tags (idle), no selection.
  assert.match(html, /grid/);
  assert.match(html, /0 tags highlighted/);
  assert.match(html, /no cell selected/);
  // loadingTiles: 0 is not accented.
  assert.doesNotMatch(html, /status-loading/);
});

test("StatusBar renders loading tile count with the accent class when > 0", () => {
  const status: ViewerStatus = {
    layoutId: "datetime",
    zoom: 3,
    inView: 128,
    loadingTiles: 12,
    // Fix C: an active selection reports the HONEST match count (not the chip count).
    tags: { status: "ok", selected: 2, matched: 4508, total: 49048 },
    selectedCell: 42,
    cursor: "0.50, 0.25",
    fps: 60,
  };
  const html = renderToString(h(StatusBar, { status }));
  assert.match(html, /loading 12 tiles/);
  assert.match(html, /status-loading/);
  // Non-null values render literally (no em dash).
  assert.match(html, /zoom 3×/);
  assert.match(html, /128 in view/);
  assert.match(html, /4508 of 49048 match/);
  assert.match(html, /cell 42 selected/);
  assert.match(html, /0\.50, 0\.25/);
  assert.match(html, /60 fps/);
});

// ---------------------------------------------------------------------------
// Minimap (frame + overview label + canvas + viewport box)
// ---------------------------------------------------------------------------

test("Minimap renders the frame, the overview label, the canvas, and a viewport box", () => {
  const html = renderToString(h(Minimap, { onJump: () => {} }));
  assert.match(html, /minimap panel-float/);
  assert.match(html, /overview/);
  assert.match(html, /minimap-canvas/);
  assert.match(html, /minimap-view/);
  assert.match(html, /aria-label="Overview minimap"/);
});

test("Minimap renders without an onJump handler (degrades to a neutral field + box)", () => {
  const html = renderToString(h(Minimap, {}));
  assert.match(html, /minimap-label/);
  assert.match(html, /minimap-view/); // the static box is still present
});

test("Minimap positions the viewport box from the live view + layout bbox", () => {
  const overview: MinimapOverview = {
    layoutBBox: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
    tiles: [],
  };
  // A view over the middle 40% of the world → box at 30%..70%.
  const view = { xMin: 0.3, yMin: 0.3, xMax: 0.7, yMax: 0.7 };
  const html = renderToString(h(Minimap, { overview, view, onJump: () => {} }));
  // Inline style drives left/top/width/height in % (react serialises style props).
  assert.match(html, /left:30%/);
  assert.match(html, /width:40%/);
});

// --- pure minimap coordinate mapping (world <-> minimap) -------------------

test("worldRectToMinimap maps a world rect into minimap pixel space over the layout bbox", () => {
  const layoutBBox = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  // The middle-40% view in a 300x188 minimap.
  const r = worldRectToMinimap({ xMin: 0.3, yMin: 0.3, xMax: 0.7, yMax: 0.7 }, layoutBBox, 300, 188);
  assert.ok(Math.abs(r.x - 90) < 1e-6, "0.3 * 300 = 90");
  assert.ok(Math.abs(r.w - 120) < 1e-6, "0.4 * 300 = 120");
  assert.ok(Math.abs(r.y - 0.3 * 188) < 1e-6);
});

test("worldRectToMinimap respects a non-unit layout bbox (e.g. a scatter sub-region)", () => {
  // A layout occupying [0.2,0.6] in x and [0.4,0.8] in y.
  const layoutBBox = { xMin: 0.2, yMin: 0.4, xMax: 0.6, yMax: 0.8 };
  // A view exactly covering the layout maps to the full minimap.
  const r = worldRectToMinimap(layoutBBox, layoutBBox, 300, 188);
  assert.ok(Math.abs(r.x - 0) < 1e-6 && Math.abs(r.y - 0) < 1e-6);
  assert.ok(Math.abs(r.w - 300) < 1e-6 && Math.abs(r.h - 188) < 1e-6);
});

test("minimapFractionToWorld is the inverse mapping (a click → world coords)", () => {
  const layoutBBox = { xMin: 0.2, yMin: 0.4, xMax: 0.6, yMax: 0.8 };
  // Centre of the minimap → centre of the layout bbox.
  const c = minimapFractionToWorld(0.5, 0.5, layoutBBox);
  assert.ok(Math.abs(c.x - 0.4) < 1e-6 && Math.abs(c.y - 0.6) < 1e-6);
  // Round-trip a rect origin through both mappings.
  const origin = worldRectToMinimap({ xMin: 0.4, yMin: 0.6, xMax: 0.4, yMax: 0.6 }, layoutBBox, 1, 1);
  const back = minimapFractionToWorld(origin.x, origin.y, layoutBBox);
  assert.ok(Math.abs(back.x - 0.4) < 1e-6 && Math.abs(back.y - 0.6) < 1e-6);
});

/** A recording fake 2D context implementing the MinimapCtx subset the paint helpers
 *  use (clear + opaque ground fill + scaled image draws). */
function fakeCtx(): MinimapCtx & {
  draws: { x: number; y: number; w: number; h: number }[];
  fills: { style: string; x: number; y: number; w: number; h: number }[];
  cleared: number;
} {
  const draws: { x: number; y: number; w: number; h: number }[] = [];
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  let cleared = 0;
  return {
    fillStyle: "" as string,
    draws,
    fills,
    get cleared() {
      return cleared;
    },
    clearRect: () => {
      cleared++;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: String(this.fillStyle), x, y, w, h });
    },
    drawImage: (_img: CanvasImageSource, x: number, y: number, w: number, h: number) => {
      draws.push({ x, y, w, h });
    },
  };
}

test("paintOverview ground-fills (T2-88) then draws each resident tile scaled into the bbox", () => {
  const ctx = fakeCtx();
  const img = {} as unknown as CanvasImageSource; // a stand-in image source
  const overview: MinimapOverview = {
    layoutBBox: { xMin: 0, yMin: 0, xMax: 1, yMax: 1 },
    tiles: [
      { bbox: { xMin: 0, yMin: 0, xMax: 0.5, yMax: 0.5 }, image: img }, // top-left quadrant
      { bbox: { xMin: 0.5, yMin: 0.5, xMax: 1, yMax: 1 }, image: img }, // bottom-right quadrant
    ],
  };
  paintOverview(ctx, overview, 200, 200, "#0E1116");
  assert.ok(ctx.cleared >= 1, "the canvas was cleared first");
  // Sparse regions read as GROUND, not the transparent canvas' black (bug 1b).
  assert.deepEqual(ctx.fills, [{ style: "#0E1116", x: 0, y: 0, w: 200, h: 200 }], "ground fill covers the whole box");
  assert.equal(ctx.draws.length, 2, "both resident tiles drawn over the ground");
  assert.deepEqual(ctx.draws[0], { x: 0, y: 0, w: 100, h: 100 }, "top-left quadrant → (0,0,100,100)");
  assert.deepEqual(ctx.draws[1], { x: 100, y: 100, w: 100, h: 100 });
});

test("paintOverview defaults to the token ground fallback when no color is passed", () => {
  const ctx = fakeCtx();
  paintOverview(ctx, null, 200, 200);
  assert.deepEqual(ctx.fills, [{ style: MINIMAP_GROUND_FALLBACK, x: 0, y: 0, w: 200, h: 200 }]);
  assert.equal(ctx.draws.length, 0, "nothing drawn without imagery — a pure ground field");
});

test("fillGround paints an OPAQUE ground rect over the whole box (no transparent black)", () => {
  const ctx = fakeCtx();
  fillGround(ctx, "#0E1116", 300, 188);
  assert.ok(ctx.cleared >= 1);
  assert.deepEqual(ctx.fills, [{ style: "#0E1116", x: 0, y: 0, w: 300, h: 188 }]);
});

test("paintTiles is the UNION primitive — draws tiles WITHOUT clearing (coverage only grows)", () => {
  const ctx = fakeCtx();
  const img = {} as unknown as CanvasImageSource;
  const bbox = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  // First union: one tile binds (top-left quadrant).
  paintTiles(ctx, { layoutBBox: bbox, tiles: [{ bbox: { xMin: 0, yMin: 0, xMax: 0.5, yMax: 0.5 }, image: img }] }, 200, 200);
  // Second union: a DIFFERENT tile binds (bottom-right). No clear between them, so the
  // first tile's paint is retained — this is what makes the retained overview complete
  // rather than erode when the live resident set changes.
  paintTiles(ctx, { layoutBBox: bbox, tiles: [{ bbox: { xMin: 0.5, yMin: 0.5, xMax: 1, yMax: 1 }, image: img }] }, 200, 200);
  assert.equal(ctx.cleared, 0, "paintTiles never clears — it only adds coverage");
  assert.equal(ctx.draws.length, 2, "both unions' tiles drawn (retained across polls)");
  assert.deepEqual(ctx.draws[0], { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(ctx.draws[1], { x: 100, y: 100, w: 100, h: 100 });
});

test("paintTiles with a null overview draws nothing", () => {
  const ctx = fakeCtx();
  paintTiles(ctx, null, 200, 200);
  assert.equal(ctx.draws.length, 0);
  assert.equal(ctx.cleared, 0, "no clear either — the retained buffer is untouched");
});

test("bboxKey rebuilds on a layout id change OR a bbox change, but is stable otherwise", () => {
  const a = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const b = { xMin: 0.2, yMin: 0.4, xMax: 0.6, yMax: 0.8 };
  assert.equal(bboxKey(a, "grid"), bboxKey(a, "grid"), "same id + bbox → same key (no rebuild)");
  assert.notEqual(bboxKey(a, "grid"), bboxKey(a, "datetime"), "layout switch → rebuild");
  assert.notEqual(bboxKey(a, "grid"), bboxKey(b, "grid"), "same id, new extent → rebuild");
  assert.equal(typeof bboxKey(a, null), "string", "a null layout id still yields a stable key");
});

test("readGroundColor falls back to the token value when there is no element/DOM", () => {
  // No element (server render) → the token fallback, never an empty fill.
  assert.equal(readGroundColor(null), MINIMAP_GROUND_FALLBACK);
});

// --- retainedIdentity: the rebuild/keep decision that makes the overview COMPLETE ---

test("retainedIdentity KEEPS its key across polls within a layout (no rebuild ⇒ overview accumulates)", () => {
  const bbox = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const ov: MinimapOverview = { layoutBBox: bbox, tiles: [] };
  // First imagery poll for "grid" → the full bbox key.
  const k1 = retainedIdentity(ov, "grid", null);
  assert.equal(k1, bboxKey(bbox, "grid"));
  // A LATER poll for the SAME layout returns the SAME key → the effect does NOT
  // ground-fill, so the retained buffer keeps everything unioned so far (the fix for
  // the edge black-out: the overview completes, it never erodes).
  assert.equal(retainedIdentity(ov, "grid", k1), k1, "same layout+bbox → stable key (union, no rebuild)");
});

test("retainedIdentity REBUILDS on a layout switch (id change) and on a same-id extent change", () => {
  const a = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const b = { xMin: 0.2, yMin: 0.4, xMax: 0.6, yMax: 0.8 };
  const kGrid = retainedIdentity({ layoutBBox: a, tiles: [] }, "grid", null);
  // Switch grid → datetime: a new key ⇒ the effect ground-fills (clears the old overview).
  const kDate = retainedIdentity({ layoutBBox: a, tiles: [] }, "datetime", kGrid);
  assert.notEqual(kDate, kGrid, "layout switch → rebuild");
  // Same id, new extent (a re-layout) ⇒ a new key ⇒ rebuild.
  assert.notEqual(retainedIdentity({ layoutBBox: b, tiles: [] }, "grid", kGrid), kGrid, "same id, new bbox → rebuild");
});

test("retainedIdentity does NOT rebuild on a TRANSIENT null overview within the same layout", () => {
  const bbox = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const k = retainedIdentity({ layoutBBox: bbox, tiles: [] }, "grid", null); // grid, imagery
  // A poll where overview is momentarily null but the layout is still grid → KEEP the
  // key (a null poll must not wipe the accumulated coverage — the erosion we prevent).
  assert.equal(retainedIdentity(null, "grid", k), k, "null overview, same layout → keep (no erase)");
});

test("retainedIdentity clears a stale overview on a switch whose new floor hasn't bound yet", () => {
  const bbox = { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
  const kGrid = retainedIdentity({ layoutBBox: bbox, tiles: [] }, "grid", null);
  // Switched to datetime but its coarse floor hasn't produced imagery yet (overview
  // null): the id changed, so return a fresh id-only key ⇒ the effect ground-fills and
  // the previous layout's overview is cleared immediately (not left showing under it).
  const kSwitch = retainedIdentity(null, "datetime", kGrid);
  assert.notEqual(kSwitch, kGrid, "id changed with no imagery yet → rebuild (clear the stale overview)");
  assert.match(kSwitch, /^datetime\|/, "the fresh key carries the new layout id");
});

// ---------------------------------------------------------------------------
// Locate on canvas — the close→select→center→highlight order (T2-71)
// ---------------------------------------------------------------------------

test("runLocate runs close → select → center → highlight in order when centered", () => {
  const order: string[] = [];
  runLocate(7, {
    close: () => order.push("close"),
    select: (id) => order.push(`select:${id}`),
    center: (id) => {
      order.push(`center:${id}`);
      return true; // centered (a position table is present)
    },
    highlight: (id) => order.push(`highlight:${id}`),
  });
  assert.deepEqual(order, ["close", "select:7", "center:7", "highlight:7"]);
});

test("runLocate SKIPS the highlight when centering degrades (no position table)", () => {
  const order: string[] = [];
  runLocate(3, {
    close: () => order.push("close"),
    select: (id) => order.push(`select:${id}`),
    center: () => {
      order.push("center");
      return false; // graceful absence — no camera move
    },
    highlight: () => order.push("highlight"),
  });
  // Still closes + selects (today's behaviour); no phantom highlight without a move.
  assert.deepEqual(order, ["close", "select:3", "center"]);
});

// ---------------------------------------------------------------------------
// StatusBar with LIVE renderer values (T2-54: the — placeholders go live)
// ---------------------------------------------------------------------------

test("StatusBar shows live zoom / in-view / fps / cursor when the observable is wired", () => {
  const status: ViewerStatus = {
    layoutId: "grid",
    zoom: 4.5,
    inView: 812,
    loadingTiles: 3,
    tags: { status: "ok", selected: 0, matched: 812, total: 812 },
    selectedCell: null,
    cursor: "cell 91",
    fps: 60,
  };
  const html = renderToString(h(StatusBar, { status }));
  assert.match(html, /zoom 4\.5×/);
  assert.match(html, /812 in view/);
  assert.match(html, /loading 3 tiles/);
  assert.match(html, /status-loading/);
  assert.match(html, /cell 91/);
  assert.match(html, /60 fps/);
});

// ---------------------------------------------------------------------------
// Fix C (T2-120/T2-121): the tag read-out is HONEST — the real match count for an
// active selection, the renderer-side 'unavailable' state instead of a lying 0, and
// the idle chip phrasing otherwise.
// ---------------------------------------------------------------------------

test("StatusBar reports the HONEST match count for an active selection (not the chip count)", () => {
  const base = {
    layoutId: "grid",
    zoom: 2,
    inView: 100,
    loadingTiles: 0,
    selectedCell: null,
    cursor: null,
    fps: 60,
  } as const;
  // Two chips selected, but 4508 cells actually match — the bar reports the MATCH count.
  const html = renderToString(
    h(StatusBar, {
      status: { ...base, tags: { status: "ok", selected: 2, matched: 4508, total: 49048 } },
    }),
  );
  assert.match(html, /4508 of 49048 match/);
  assert.doesNotMatch(html, /2 tags highlighted/); // never the chip count when a selection is active
});

test("StatusBar surfaces 'tags unavailable' instead of a lying 0 when the renderer sidecar failed", () => {
  const status: ViewerStatus = {
    layoutId: "grid",
    zoom: 2,
    inView: 100,
    loadingTiles: 0,
    // Renderer-side load failed: two chips are 'selected' in the UI, but nothing is
    // resident to evaluate — say so, do not report "0 ... match".
    tags: { status: "unavailable", selected: 2, matched: 0, total: 49048 },
    selectedCell: null,
    cursor: null,
    fps: null,
  };
  const html = renderToString(h(StatusBar, { status }));
  assert.match(html, /tags unavailable/);
  assert.match(html, /status-tags-unavailable/);
  assert.doesNotMatch(html, /match/);
});
