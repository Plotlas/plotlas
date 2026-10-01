// T2-72 Seam 1 — pure-helper unit tests for the DOM overlay substrate
// (src/renderer/overlayLayer.ts). The DOM lifecycle is covered in
// tests/dom/overlay_layer.dom.test.ts; here we prove the GL/DOM-free math:
//   * worldToScreen is the exact inverse of cells.ts's screenToWorld (memo's one insight);
//   * the pile hotspot derivation reproduces the tiler's finest-tier binning + drop counts;
//   * the chip declutter is count-priority; the datetime-domain derivation + nice ticks.
import assert from "node:assert/strict";
import test from "node:test";

import {
  worldToScreen,
  tileXY,
  deriveHotspots,
  createHotspotScan,
  declutterChips,
  formatCount,
  pickDomainSampleIds,
  fitTimeDomain,
  domainToX,
  niceTimeTicks,
  axisTimeTicks,
  intervalTimeTicks,
  axisDomainToTimeDomain,
  producerTimeAxis,
  labelGapSlot,
  declutterLabels,
  DEFAULT_OVERLAY_LAYER_CONFIG,
  LABEL_FONT_SIZE_PX,
  LABEL_FONT_LINE_HEIGHT,
  type PlacedChip,
  type LabelCandidate,
} from "../src/renderer/overlayLayer.ts";
import { datetimeInstant } from "../src/api-client/datetimeValue.ts";
import { screenToWorld } from "../src/renderer/cells.ts";
import type { PositionTable } from "../src/renderer/cells.ts";
import type { AxisAnnotation, LayoutEntry } from "../src/renderer/layout.ts";
import type { CameraState, Viewport } from "../src/renderer/world.ts";

const VP: Viewport = { width: 1280, height: 800, devicePixelRatio: 1 };

function posTable(cells: { x: number; y: number; w?: number; h?: number }[]): PositionTable {
  return {
    x: Float32Array.from(cells.map((c) => c.x)),
    y: Float32Array.from(cells.map((c) => c.y)),
    w: Float32Array.from(cells.map((c) => c.w ?? 0.001)),
    h: Float32Array.from(cells.map((c) => c.h ?? 0.001)),
    count: cells.length,
  };
}

// ---------------------------------------------------------------------------
// worldToScreen — the inverse of screenToWorld
// ---------------------------------------------------------------------------

test("worldToScreen round-trips screenToWorld at deep zoom (float64 precision)", () => {
  const state: CameraState = { center: [0.312345, 0.678901], zoom: 0.0004 };
  for (const [wx, wy] of [
    [0.3, 0.6],
    [0.312345, 0.678901],
    [0.9, 0.1],
    [0.0, 1.0],
  ] as [number, number][]) {
    const [sx, sy] = worldToScreen(state, VP, wx, wy);
    const [rx, ry] = screenToWorld(state, VP, sx, sy);
    assert.ok(Math.abs(rx - wx) < 1e-9, `x round-trip ${rx} vs ${wx}`);
    assert.ok(Math.abs(ry - wy) < 1e-9, `y round-trip ${ry} vs ${wy}`);
  }
});

test("worldToScreen places the camera centre at the viewport centre", () => {
  const state: CameraState = { center: [0.4, 0.6], zoom: 0.001 };
  const [sx, sy] = worldToScreen(state, VP, 0.4, 0.6);
  assert.equal(sx, VP.width / 2);
  assert.equal(sy, VP.height / 2);
});

// ---------------------------------------------------------------------------
// tileXY — verbatim tiler._tile_xy
// ---------------------------------------------------------------------------

test("tileXY matches the producer's _tile_xy (binning, clamping, degenerate axis)", () => {
  const bbox = [0, 0, 1, 1] as const;
  assert.deepEqual(tileXY(0.1, 0.1, bbox, 1), [0, 0]);
  assert.deepEqual(tileXY(0.9, 0.9, bbox, 1), [1, 1]);
  // right/bottom edge clamps into the last tile (not 2^z)
  assert.deepEqual(tileXY(1.0, 1.0, bbox, 1), [1, 1]);
  // z=2 → 4 tiles/axis
  assert.deepEqual(tileXY(0.6, 0.1, bbox, 2), [2, 0]);
  // degenerate (zero-span) x-axis maps every cell to column 0
  assert.deepEqual(tileXY(0.7, 0.3, [0, 0, 0, 1], 3), [0, 2]);
});

test("bbox precision: the full-precision bbox reproduces the tiler's boundary attribution", () => {
  // A cell sitting EXACTLY on a tile boundary under the FULL bbox (x1 = 0.8 → fx = 0.5 at
  // cx = 0.4 → tile 2 of 4 at z=2), which is what the tiler binned. The 6-dp-rounded bbox
  // stand-in (x1 = 0.800001 — the round(v,6) drift) pushes the same cell into tile 1. The
  // v2.5 `bbox_exact` path bins over the full bbox → matches the bake; the rounded `bbox`
  // path drifts — the exact class of boundary misattribution PR #179 measured.
  const cx = 0.4;
  const cy = 0.5;
  assert.deepEqual(tileXY(cx, cy, [0, 0, 0.8, 1], 2), [2, 2], "full-precision bbox → the tiler's tile");
  assert.notDeepEqual(
    tileXY(cx, cy, [0, 0, 0.800001, 1], 2),
    [2, 2],
    "the 6-dp-rounded bbox misattributes the boundary cell (the drift bbox_exact removes)",
  );
});

// ---------------------------------------------------------------------------
// deriveHotspots — pile occupancy re-derived from the position table
// ---------------------------------------------------------------------------

test("deriveHotspots finds over-cap tiles with honest counts + lowest-id anchor", () => {
  // z=1 (2×2 tiles), cap=2. Five cells pile into tile (0,0), one sits in (1,1).
  const positions = posTable([
    { x: 0.10, y: 0.10 }, // id 0 — the representative (lowest id in the pile)
    { x: 0.11, y: 0.12 }, // id 1
    { x: 0.09, y: 0.08 }, // id 2
    { x: 0.12, y: 0.11 }, // id 3
    { x: 0.10, y: 0.09 }, // id 4
    { x: 0.90, y: 0.90 }, // id 5 — alone in its tile
  ]);
  const hotspots = deriveHotspots(positions, [0, 0, 1, 1], 1, 2);
  assert.equal(hotspots.length, 1, "only the over-cap tile is a hotspot");
  const h = hotspots[0];
  assert.equal(h.count, 5, "true occupancy = all 5 co-located cells");
  assert.equal(h.shown, 2, "shown = cap");
  assert.equal(h.dropped, 3, "dropped = count - cap (== baked subsampled.dropped)");
  assert.equal(h.x, positions.x[0], "anchor = lowest-id member's x (float32 from the table)");
  assert.equal(h.y, positions.y[0], "anchor = lowest-id member's y");
});

test("deriveHotspots returns nothing when no tile exceeds cap", () => {
  const positions = posTable([
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.1 },
    { x: 0.1, y: 0.9 },
    { x: 0.9, y: 0.9 },
  ]);
  assert.deepEqual(deriveHotspots(positions, [0, 0, 1, 1], 1, 64), []);
});

test("createHotspotScan chunks to the identical result as the one-shot pass", () => {
  // 1000 cells: a 700-cell pile in tile (0,0) plus 300 spread cells. Stepping in uneven
  // budgets must land on exactly deriveHotspots' output — the chunking is a scheduling
  // change, never a result change.
  const cells: { x: number; y: number }[] = [];
  for (let i = 0; i < 700; i++) cells.push({ x: 0.1, y: 0.1 });
  for (let i = 0; i < 300; i++) cells.push({ x: 0.3 + (i % 20) * 0.03, y: 0.3 + Math.floor(i / 20) * 0.04 });
  const positions = posTable(cells);
  const bbox = [0, 0, 1, 1] as const;
  const oneShot = deriveHotspots(positions, bbox, 3, 8);
  const scan = createHotspotScan(positions, bbox, 3, 8);
  let steps = 0;
  while (!scan.step(137)) steps += 1; // deliberately non-divisor budget
  assert.ok(steps >= 6, "the scan genuinely ran in multiple slices");
  assert.deepEqual(scan.result(), oneShot, "chunked result == one-shot result");
  // A degenerate scan (empty table) completes on the first step with no hotspots.
  const empty = createHotspotScan(posTable([]), bbox, 3, 8);
  assert.equal(empty.step(1), true);
  assert.deepEqual(empty.result(), []);
});

// ---------------------------------------------------------------------------
// declutterChips — count-priority greedy screen-space cull
// ---------------------------------------------------------------------------

test("declutterChips keeps the biggest-count chip and absorbs nearby smaller ones", () => {
  const chips: PlacedChip[] = [
    { x: 0, y: 0, count: 10, dropped: 0, shown: 2, screenX: 100, screenY: 100 },
    { x: 0, y: 0, count: 500, dropped: 0, shown: 2, screenX: 110, screenY: 105 }, // near the big one
    { x: 0, y: 0, count: 50, dropped: 0, shown: 2, screenX: 400, screenY: 400 }, // far away
  ];
  const kept = declutterChips(chips, 40, 100);
  assert.equal(kept.length, 2, "the two overlapping merge to the bigger; the far one stays");
  assert.equal(kept[0].count, 500, "the biggest count wins the contested spot");
  assert.ok(
    kept.some((c) => c.count === 50),
    "the well-separated chip survives",
  );
});

test("declutterChips honours the max-count budget", () => {
  const chips: PlacedChip[] = Array.from({ length: 50 }, (_, i) => ({
    x: 0,
    y: 0,
    count: 100 - i,
    dropped: 0,
    shown: 2,
    screenX: i * 100,
    screenY: 0,
  }));
  assert.equal(declutterChips(chips, 10, 8).length, 8);
});

test("formatCount abbreviates thousands + millions", () => {
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1500), "1.5k");
  assert.equal(formatCount(12345), "12k");
  assert.equal(formatCount(1_010_469), "1M");
});

// ---------------------------------------------------------------------------
// datetime domain derivation + nice ticks
// ---------------------------------------------------------------------------

test("datetimeInstant (the axis shim's reader) handles the three declared formats + missing values", () => {
  assert.equal(datetimeInstant("2018-06-01T00:00:00", "iso8601"), Date.parse("2018-06-01T00:00:00"));
  assert.equal(datetimeInstant("1100-01-01", "iso8601"), Date.parse("1100-01-01")); // ancient date
  assert.equal(datetimeInstant(1_600_000_000, "unix_seconds"), 1_600_000_000 * 1000);
  assert.equal(datetimeInstant(1_600_000_000_000, "unix_millis"), 1_600_000_000_000);
  assert.equal(datetimeInstant(null, "iso8601"), null);
  assert.equal(datetimeInstant("not-a-date", "iso8601"), null);
});

test("datetimeInstant reads a value by its type, so a stored timestamp's ISO string resolves under any format (#391)", () => {
  // The case #391 fixes: the API serves a stored timestamp as an ISO string whatever format
  // is committed, and reading it by a `unix_*` format was Number("2018-…") = NaN.
  for (const format of ["unix_millis", "unix_seconds"] as const) {
    assert.equal(datetimeInstant("2018-06-01T00:00:00", format), Date.parse("2018-06-01T00:00:00"), format);
    assert.equal(datetimeInstant("1100-01-01", format), Date.parse("1100-01-01"), format);
  }
  // A number under `iso8601` is SECONDS, as the datetime plugin reads an integer under any
  // format but `unix_millis` (`_to_epoch`). No writer produces one: ingest stores `iso8601`
  // as a timestamp, and the worker refuses any datetime role on an int64 column.
  assert.equal(datetimeInstant(1_600_000_000, "iso8601"), 1_600_000_000 * 1000);
  // Past the ECMAScript Date window (±8.64e15 ms) a value is no date: `new Date(t)` is Invalid.
  assert.equal(datetimeInstant(8.64e15, "unix_millis"), 8.64e15);
  assert.equal(datetimeInstant(8.64e15 + 1, "unix_millis"), null);
  assert.equal(datetimeInstant(true, "iso8601"), null);
});

test("pickDomainSampleIds returns the x-extreme cells (t_min / t_max carriers)", () => {
  // x rises with id; the unknown-date cell sits at x=0.5 (never an extreme).
  const positions = posTable([
    { x: 0.04 }, // id 0 — earliest
    { x: 0.20 },
    { x: 0.50 }, // id 2 — unknown-date bucket, mid-axis
    { x: 0.70 },
    { x: 0.96 }, // id 4 — latest
  ]);
  const ids = pickDomainSampleIds(positions, 1);
  assert.ok(ids.includes(0), "includes the min-x (earliest) cell");
  assert.ok(ids.includes(4), "includes the max-x (latest) cell");
  assert.ok(!ids.includes(2), "the mid-axis unknown bucket is not an extreme");
});

test("fitTimeDomain recovers a linear time↔x mapping; rejects degenerate", () => {
  // t = 1000·x + 500 (exactly linear, as the datetime plugin maps time→x).
  const points = [0.04, 0.2, 0.5, 0.7, 0.96].map((x) => ({ x, t: 1000 * x + 500 }));
  const domain = fitTimeDomain(points);
  assert.ok(domain !== null);
  assert.ok(Math.abs(domain!.slope - 1000) < 1e-6);
  assert.ok(Math.abs(domain!.intercept - 500) < 1e-6);
  // inverse: domainToX(domain, t(x)) == x
  assert.ok(Math.abs(domainToX(domain!, 1000 * 0.42 + 500) - 0.42) < 1e-9);
  // degenerate inputs → null (no derivable domain)
  assert.equal(fitTimeDomain([{ x: 0.5, t: 100 }]), null); // < 2 points
  assert.equal(fitTimeDomain([{ x: 0.5, t: 1 }, { x: 0.5, t: 9 }]), null); // all-same x
  assert.equal(fitTimeDomain([{ x: 0.1, t: 5 }, { x: 0.9, t: 5 }]), null); // all-same t
});

test("niceTimeTicks gives ~9 year/era ticks for the premise spans", () => {
  const rijks = niceTimeTicks(Date.UTC(1100, 0, 1), Date.UTC(2020, 0, 1), 9);
  const rijksYears = rijks.map((t) => t.year);
  assert.ok(rijksYears.length >= 7 && rijksYears.length <= 11, `rijks tick count ${rijksYears.length}`);
  assert.ok(rijksYears.includes(1200) && rijksYears.includes(2000), "century boundaries present");
  assert.equal(rijks[0].label, String(rijks[0].year), "label is the year");

  const inat = niceTimeTicks(Date.UTC(1934, 0, 1), Date.UTC(2019, 0, 1), 9);
  assert.ok(inat.length >= 6 && inat.length <= 11, `inat tick count ${inat.length}`);
  assert.ok(inat.every((a, i) => i === 0 || a.year > inat[i - 1].year), "ticks strictly increase");

  assert.deepEqual(niceTimeTicks(100, 100, 9), [], "empty/degenerate range → no ticks");
});

test("niceTimeTicks places 1st-century ticks in the 1st century (no 0–99 → 1900s remap)", () => {
  // A dataset of years 20–80 CE. Date.UTC(y, 0, 1) would remap those tick years to
  // 1920–1980 — epochs ~1900 years off the layout's world-x, so every tick would cull
  // off-screen and the axis silently vanish (PR-179 review). yearEpoch takes them literally.
  const t20 = Date.parse("0020-01-01T00:00:00Z");
  const t80 = Date.parse("0080-01-01T00:00:00Z");
  const ticks = niceTimeTicks(t20, t80, 9);
  assert.ok(ticks.length >= 5, `expected a real tick set, got ${ticks.length}`);
  for (const tick of ticks) {
    assert.equal(new Date(tick.t).getUTCFullYear(), tick.year, `tick ${tick.year} epoch is the literal year`);
    assert.ok(tick.t >= t20 - 1 && tick.t <= t80 + 1, `tick ${tick.year} lies inside the data span`);
  }
});

test("niceTimeTicks still draws an axis when the scan range exceeds the JS Date limit", () => {
  // D-36 H1 made the domain→range slope unbounded (`range` span is min(0.92, I/S)), so a
  // WIDE domain over a DEEP stack maps the viewport past ±8.64e15 ms — measured 1.17e16 for
  // 200k images dated 2020 plus one dated year 1. `new Date(t)` is Invalid there and
  // `getUTCFullYear()` is NaN, which used to poison every derived value and return ZERO
  // ticks: a completely blank time axis, at every zoom. Clamping shows the representable
  // ticks instead. (Distinct from T2-142 (iii)'s tick CLAMP-to-range, which addresses
  // over-labelling and runs after this function has already returned.)
  const beyond = 1.17e16;
  const ticks = niceTimeTicks(-beyond, beyond, 9);
  assert.ok(ticks.length > 0, "a range wider than the Date window must still yield ticks");
  for (const tick of ticks) {
    assert.ok(Number.isFinite(tick.t), `tick ${tick.year} must have a finite epoch`);
    assert.ok(Number.isFinite(tick.year), "tick years must not be NaN");
  }
  // One-sided: entirely beyond the window on the same side collapses to nothing drawable.
  assert.deepEqual(niceTimeTicks(beyond, beyond * 2, 9), [], "wholly out-of-range → no ticks");
  // The ordinary path is untouched: the clamp must never bind inside the Date window.
  const inat = niceTimeTicks(Date.UTC(1934, 0, 1), Date.UTC(2019, 0, 1), 9);
  assert.deepEqual(
    inat.map((t) => t.year),
    [1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010],
    "in-range spans are unaffected by the clamp",
  );
});

// ---------------------------------------------------------------------------
// v2.7 — tick LOCK-STEP with the producer's bins (D-36 seam H4)
//
// The cross-LANGUAGE identity lives in datetime_tick_vector.test.ts + its pytest twin.
// These are the behavioural pins for this module's own loop.
// ---------------------------------------------------------------------------

/** The producer's `_floor_interval`, transcribed for the tests ONLY — an independent second
 *  opinion on where a bin starts, so "the tick is a bin boundary" is checked against
 *  something other than the code under test. Its own agreement with the real producer is
 *  what the shared tick vector's pytest half asserts. */
function producerFloor(t: number, kind: string, step: number): number {
  const d = new Date(t);
  const u = (y: number, mo: number, day: number, h: number, mi: number, s: number): number => {
    const e = new Date(0);
    e.setUTCFullYear(y, mo, day);
    e.setUTCHours(h, mi, s, 0);
    return e.getTime();
  };
  const y = d.getUTCFullYear();
  if (kind === "year") return u(Math.max(1, y - (y % step)), 0, 1, 0, 0, 0);
  if (kind === "month") {
    const tm = y * 12 + d.getUTCMonth();
    const f = tm - (tm % step);
    return u(Math.floor(f / 12), f % 12, 1, 0, 0, 0);
  }
  if (kind === "day") return u(y, d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  if (kind === "hour") {
    return u(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() - (d.getUTCHours() % step), 0, 0);
  }
  if (kind === "minute") {
    const mi = d.getUTCMinutes();
    return u(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), mi - (mi % step), 0);
  }
  const s = d.getUTCSeconds();
  return u(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), s - (s % step));
}

test("axisTimeTicks draws the PRODUCER's bin boundaries, at every rung on the ladder", () => {
  // The defect this closes: 25 producer rungs across six kinds against a years-only
  // NICE_YEAR_STEPS, so a month- or day-binned dataset got a correct-but-unlabelled axis and
  // nothing would have caught it. Each rung below is asserted against an independent
  // transcription of `_floor_interval` — the tick must be a FIXED POINT of it.
  const rungs: [string, number, string, string][] = [
    ["year", 1, "1100-01-01T00:00:00Z", "2020-01-01T00:00:00Z"],
    ["year", 50, "1600-01-01T00:00:00Z", "2000-01-01T00:00:00Z"],
    ["month", 1, "2021-01-01T00:00:00Z", "2021-09-01T00:00:00Z"],
    ["month", 3, "2010-01-01T00:00:00Z", "2019-10-01T00:00:00Z"],
    ["day", 1, "2021-03-01T00:00:00Z", "2021-04-29T00:00:00Z"],
    ["hour", 6, "2021-03-14T00:00:00Z", "2021-03-18T18:00:00Z"],
    ["hour", 12, "2021-03-01T00:00:00Z", "2021-04-01T00:00:00Z"],
    ["minute", 15, "2021-03-14T09:00:00Z", "2021-03-14T15:00:00Z"],
    ["minute", 30, "2021-03-14T00:00:00Z", "2021-03-15T00:00:00Z"],
    ["second", 5, "2021-03-14T09:00:00Z", "2021-03-14T09:05:00Z"],
    ["second", 30, "2021-03-14T09:00:00Z", "2021-03-14T10:00:00Z"],
  ];
  for (const [kind, step, from, to] of rungs) {
    const lo = Date.parse(from);
    const hi = Date.parse(to);
    const ticks = axisTimeTicks(lo, hi, 9, { kind, step });
    assert.ok(ticks.length >= 2, `${kind}/${step}: expected a real tick set, got ${ticks.length}`);
    for (const tick of ticks) {
      assert.equal(
        producerFloor(tick.t, kind, step),
        tick.t,
        `${kind}/${step}: tick ${tick.label} (${new Date(tick.t).toISOString()}) is not a bin start`,
      );
      assert.ok(tick.t >= lo && tick.t <= hi, `${kind}/${step}: tick ${tick.label} is outside the view`);
    }
  }
});

test("axisTimeTicks THINS a dense axis by keeping every n-th bin edge — never another ladder", () => {
  // rijks_pilot's shape: one bin per year over 1100–2020 is 921 boundaries, ~1.4 px apart on
  // a 1280 px canvas. Thinning must therefore happen, and every survivor must still be a bin
  // edge — the property a "switch to a coarser ladder" implementation loses the moment the
  // two ladders stop agreeing (which for every non-year rung they already did).
  const lo = Date.parse("1100-01-01T00:00:00Z");
  const hi = Date.parse("2020-01-01T00:00:00Z");
  const all = axisTimeTicks(lo, hi, 9, { kind: "year", step: 1 });
  assert.ok(all.length > 5 && all.length < 20, `expected a readable tick count, got ${all.length}`);
  const years = all.map((t) => t.year);
  assert.deepEqual(years, [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000]);
  // Every drawn tick is a bin edge, and the kept ones are a UNIFORM stride in bin index —
  // an assorted subset near nice-looking dates would satisfy the first half but not this.
  const gaps = new Set(years.slice(1).map((y, i) => y - years[i]));
  assert.equal(gaps.size, 1, `thinning must be a single stride, got gaps ${[...gaps]}`);
  for (const tick of all) assert.equal(producerFloor(tick.t, "year", 1), tick.t);

  // A stride is chosen per rung, not per kind: the same span binned at 50-year rungs is
  // already sparse enough to draw one for one.
  const coarse = axisTimeTicks(Date.parse("1600-01-01T00:00:00Z"), Date.parse("2000-01-01T00:00:00Z"), 9, {
    kind: "year",
    step: 50,
  });
  assert.deepEqual(
    coarse.map((t) => t.year),
    [1600, 1650, 1700, 1750, 1800, 1850, 1900, 1950, 2000],
    "a 50-year rung over 400 years needs no thinning at all",
  );

  // The kept set is anchored on the BIN GRID, not on the camera: shifting the window by a
  // few years must slide the tick set, never renumber it (a pan would otherwise reshuffle
  // every tick).
  const panned = axisTimeTicks(Date.parse("1103-06-01T00:00:00Z"), Date.parse("2020-01-01T00:00:00Z"), 9, {
    kind: "year",
    step: 1,
  });
  assert.deepEqual(panned.map((t) => t.year), [1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000]);
});

test("axisTimeTicks labels each rung at its own resolution, locale-independently", () => {
  // 12 of the producer's 25 rungs are second/minute/hour, so a format ladder that stops at
  // "month/day/hour" leaves a third of them falling back to a year label. The formats are
  // the ISO calendar prefix at the rung's resolution: locale-free (no "Mar", no 3/14 vs
  // 14/3), each a strict prefix of the next, and reversible — which is what lets the shared
  // vector's pytest half parse a label back to the instant it marks.
  const at = (iso: string, kind: string, step: number): string => {
    const t = Date.parse(iso);
    const ticks = axisTimeTicks(t, t + 1, 9, { kind, step });
    assert.equal(ticks.length, 1, `${kind}/${step}: expected exactly the boundary tick`);
    return ticks[0].label;
  };
  assert.equal(at("2020-01-01T00:00:00Z", "year", 1), "2020");
  assert.equal(at("2021-03-01T00:00:00Z", "month", 1), "2021-03");
  assert.equal(at("2021-03-14T00:00:00Z", "day", 1), "2021-03-14");
  assert.equal(at("2021-03-14T09:00:00Z", "hour", 1), "2021-03-14 09:00");
  assert.equal(at("2021-03-14T09:35:00Z", "minute", 5), "2021-03-14 09:35");
  assert.equal(at("2021-03-14T09:35:20Z", "second", 5), "2021-03-14 09:35:20");
  // The YEAR rung keeps the bare year the pre-2.7 path emits, so a year-binned dataset's
  // axis reads exactly as it does today.
  assert.equal(at("0020-01-01T00:00:00Z", "year", 1), "20");
  // ...but a sub-year label zero-pads the year, or a 1st-century dataset would render
  // "20-03-14" — ambiguous with a two-digit year, and unparseable.
  assert.equal(at("0020-03-14T00:00:00Z", "day", 1), "0020-03-14");
});

test("a manifest with NO interval renders exactly the ticks it does today (graceful absence)", () => {
  // Every dataset baked before 2.7 — including whatever is on disk right now — carries no
  // `interval`, and an unknown `kind` from a later minor must degrade the same way (the
  // api-client keeps `kind` an open string deliberately). In both cases the axis is still
  // fully drawable from domain/range, so it falls back — it must NOT go blank.
  const lo = Date.parse("1934-01-01T00:00:00Z");
  const hi = Date.parse("2019-01-01T00:00:00Z");
  const legacy = niceTimeTicks(lo, hi, 9);
  assert.deepEqual(axisTimeTicks(lo, hi, 9, null), legacy, "absent interval → today's ladder");
  assert.deepEqual(axisTimeTicks(lo, hi, 9, undefined), legacy, "undefined interval → today's ladder");
  assert.deepEqual(
    axisTimeTicks(lo, hi, 9, { kind: "week", step: 1 }),
    legacy,
    "an unknown rung kind degrades like an ABSENT interval — axis still drawn",
  );
  // A rung whose grid the producer's flooring does NOT make uniform degrades too, rather
  // than silently mis-ticking: `_floor_interval`'s day arm ignores `step`, and its sub-day
  // arms nest inside the unit above (so a 7-hour step would leave a short bucket every day).
  assert.deepEqual(axisTimeTicks(lo, hi, 9, { kind: "day", step: 5 }), legacy, "day/5 is not uniform");
  assert.deepEqual(axisTimeTicks(lo, hi, 9, { kind: "hour", step: 7 }), legacy, "hour/7 is not uniform");
  assert.ok(legacy.length > 0, "the fallback must be a real tick set, not an empty one");
});

test("producerTimeAxis hands back the AXIS, so the rung reaches the tick path at all", () => {
  // A bare TimeDomain (slope/intercept) carries no rung, which is why the interval could not
  // have been read through one; producerTimeAxis hands back the axis instead. Same filters,
  // same skip-don't-fail tolerance — an axis is only returned when it also converts, so a
  // caller never has to re-check.
  const mk = (extra: Record<string, unknown>): LayoutEntry =>
    ({
      annotations: {
        axes: [
          {
            orientation: "x",
            scale: "time",
            domain: ["2021-01-01", "2021-12-31"],
            range: [0.04, 0.96],
            label: "d",
            ...extra,
          },
        ],
      },
    }) as unknown as LayoutEntry;
  assert.deepEqual(producerTimeAxis(mk({ interval: { kind: "month", step: 3 } }))?.interval, {
    kind: "month",
    step: 3,
  });
  assert.equal(producerTimeAxis(mk({}))?.interval, undefined, "a pre-2.7 axis carries none");
  assert.equal(producerTimeAxis({} as LayoutEntry), null, "no annotations → null");
  // A degenerate axis is skipped, so the interval of an unusable axis is never read.
  assert.equal(producerTimeAxis(mk({ range: [0.5, 0.5] })), null);
});

test("an interval axis never renders BLANK — the clamp survives the new tick path", () => {
  // The clamp exists because an unbounded domain→range slope pushed epochs past the ECMA
  // Date window, where getUTCFullYear is NaN and the axis rendered ZERO ticks (not wrong
  // ticks — none). D-36 H1 made that reachable; the interval path must not reintroduce it.
  const beyond = 1.17e16;
  for (const rung of [{ kind: "year", step: 1 }, { kind: "month", step: 3 }, { kind: "day", step: 1 }]) {
    const ticks = axisTimeTicks(-beyond, beyond, 9, rung);
    assert.ok(ticks.length > 0, `${rung.kind}/${rung.step}: a beyond-window scan must still tick`);
    for (const tick of ticks) {
      assert.ok(Number.isFinite(tick.t), `${rung.kind}: tick ${tick.label} must have a finite epoch`);
      assert.ok(Number.isFinite(tick.year), `${rung.kind}: tick years must not be NaN`);
      assert.ok(tick.label.length > 0, `${rung.kind}: a tick must carry a label`);
    }
    // This scan crosses year 1 from the BCE side, where rungStart's `max(1, ...)` year clamp
    // collapses every pre-year-1 index onto year 1 — so the ticks must be DISTINCT instants,
    // not the same one stacked several times (the intervalTimeTicks dedup).
    assert.equal(
      new Set(ticks.map((t) => t.t)).size,
      ticks.length,
      `${rung.kind}: ticks must be distinct instants, not duplicates stacked at the year clamp`,
    );
    // Wholly outside on one side is the one case with nothing drawable — and it must be an
    // empty set rather than a hang, whatever the rung's resolution.
    assert.deepEqual(axisTimeTicks(beyond, beyond * 2, 9, rung), [], `${rung.kind}: out of range → no ticks`);
  }
});

// A UTC epoch for a possibly-BCE year — Date.parse rejects negative years and Date.UTC applies
// the 0–99 → 1900s remap, so neither is usable for the proleptic scans below.
const utcMs = (y: number, mo: number, d: number): number => {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo, d);
  return dt.getTime();
};

test("axisTimeTicks does not stack duplicate ticks at year 1 when the view crosses into BCE", () => {
  // rungStart's `max(1, index*step)` year clamp (a faithful transcription of the producer's
  // _floor_interval) is NON-INJECTIVE: every bin index <= 0 collapses onto year 1. Walking a
  // stride across a view whose left edge is before year 1 CE visits several such indices, so
  // without a dedup each pushes an identical {t, label:"1"} tick — rendered as DOM nodes
  // stacked on one pixel. The shared producer fixture cannot cover this (Python's datetime
  // MINYEAR == 1 can't floor a pre-year-1 instant), so it is pinned renderer-side here.
  for (const rung of [{ kind: "year", step: 1 }, { kind: "year", step: 50 }, { kind: "year", step: 100 }]) {
    const lo = utcMs(-2000, 0, 1); // 2001 BCE
    const hi = utcMs(2020, 0, 1);
    const ticks = axisTimeTicks(lo, hi, 9, rung);
    assert.equal(
      new Set(ticks.map((t) => t.t)).size,
      ticks.length,
      `${rung.kind}/${rung.step}: emitted duplicate instants ${JSON.stringify(ticks.map((t) => t.label))}`,
    );
    assert.ok(
      ticks.filter((t) => t.year === 1).length <= 1,
      `${rung.kind}/${rung.step}: year 1 (the clamp target) is drawn more than once`,
    );
    // Every surviving tick is still a real bin boundary (a fixed point of the producer floor).
    for (const tick of ticks) assert.equal(producerFloor(tick.t, rung.kind, rung.step), tick.t);
  }
});

test("axisTimeTicks falls back to the years-only ladder inside a single coarse-year bin (not blank)", () => {
  // A coarse year rung (step >= 2 — what _select_interval picks for a wide, sparse span) viewed
  // BETWEEN two bin boundaries has no bin edge to draw, so intervalTimeTicks returns []. The
  // axis must NOT go blank: it falls back to niceTimeTicks, exactly as an absent interval does
  // (D-36 §7.4 — a coarser tick inside a bin is fine). (For year/1 and the sub-day kinds a
  // sub-bin view is legitimately blank on BOTH paths, so there is nothing to fall back to.)
  const lo = Date.parse("1701-01-01T00:00:00Z");
  const hi = Date.parse("1705-01-01T00:00:00Z");
  const legacy = niceTimeTicks(lo, hi, 9);
  assert.ok(legacy.length > 1, "precondition: the years-only ladder ticks this sub-bin span");
  for (const rung of [{ kind: "year", step: 10 }, { kind: "year", step: 50 }, { kind: "year", step: 250 }]) {
    assert.equal(
      intervalTimeTicks(lo, hi, 9, rung.kind, rung.step).length,
      0,
      `${rung.kind}/${rung.step}: precondition — no bin boundary sits in a sub-bin view`,
    );
    assert.deepEqual(
      axisTimeTicks(lo, hi, 9, rung),
      legacy,
      `${rung.kind}/${rung.step}: a sub-bin view falls back to the ladder, not a blank axis`,
    );
  }
});

test("axisTimeTicks thinning is a uniform, pan-stable stride on a CYCLE-kind rung too", () => {
  // The THINS test above only exercises the no-cycle (year) branch of tickSpacings. The
  // cycle-divisor branch (second/minute/hour/month) must give the same guarantee: kept ticks
  // are a uniform stride in bin index, anchored on the global grid so a pan slides them.
  const H6 = 6 * 3600 * 1000; // a 6-hour bin, in ms
  const lo = Date.parse("2021-03-14T00:00:00Z");
  const hi = Date.parse("2021-03-24T00:00:00Z"); // ~10 days of 6-hour bins ⇒ thinning forced
  const ticks = axisTimeTicks(lo, hi, 9, { kind: "hour", step: 6 });
  assert.ok(ticks.length >= 5 && ticks.length <= 18, `expected a thinned set, got ${ticks.length}`);
  for (const tick of ticks) assert.equal(producerFloor(tick.t, "hour", 6), tick.t, "every tick is a 6-hour bin edge");
  const idx = ticks.map((t) => Math.round(t.t / H6));
  const gaps = new Set(idx.slice(1).map((v, i) => v - idx[i]));
  assert.equal(gaps.size, 1, `thinning must be a single stride, got ${[...gaps]}`);
  assert.equal(idx[0] % (idx[1] - idx[0]), 0, "the kept set is anchored on the global bin grid, not the camera");
  // Pan by 7 hours (not a whole stride): the set slides by whole strides, never renumbers.
  const panned = axisTimeTicks(lo + 7 * 3600 * 1000, hi + 7 * 3600 * 1000, 9, { kind: "hour", step: 6 });
  const pIdx = panned.map((t) => Math.round(t.t / H6));
  const pGaps = new Set(pIdx.slice(1).map((v, i) => v - pIdx[i]));
  assert.equal(pGaps.size, 1, "panned set is still a single stride");
  assert.equal(pIdx[0] % (pIdx[1] - pIdx[0]), 0, "panned set stays anchored on the global bin grid");
});

// ---------------------------------------------------------------------------
// v2.5 — the producer axis domain (the Seam-1 getMetadata-shim replacement)
// ---------------------------------------------------------------------------

test("axisDomainToTimeDomain converts a producer axis to the shim's linear t↔x fit", () => {
  const axis: AxisAnnotation = {
    orientation: "x",
    scale: "time",
    domain: ["2021-01-01T00:00:00+00:00", "2021-01-11T00:00:00+00:00"],
    range: [0.04, 0.96],
    label: "Captured",
  };
  const d = axisDomainToTimeDomain(axis);
  assert.ok(d !== null);
  // The range endpoints map to the domain endpoints exactly (t(range[i]) == domain[i]).
  assert.ok(Math.abs(d!.slope * 0.04 + d!.intercept - Date.parse(axis.domain[0])) < 1);
  assert.ok(Math.abs(d!.slope * 0.96 + d!.intercept - Date.parse(axis.domain[1])) < 1);
  // A tick placed via domainToX round-trips (the midpoint time → the midpoint of the range).
  const mid = (Date.parse(axis.domain[0]) + Date.parse(axis.domain[1])) / 2;
  assert.ok(Math.abs(domainToX(d!, mid) - 0.5) < 1e-9);
});

test("axisDomainToTimeDomain rejects a degenerate / unparseable axis (→ caller uses the shim)", () => {
  const base: AxisAnnotation = {
    orientation: "x", scale: "time", domain: ["2021-01-01", "2021-01-02"], range: [0.04, 0.96], label: "d",
  };
  assert.equal(axisDomainToTimeDomain({ ...base, domain: ["nope", "2021-01-02"] }), null); // bad ISO
  assert.equal(axisDomainToTimeDomain({ ...base, range: [0.5, 0.5] }), null); // zero-width range
  assert.equal(axisDomainToTimeDomain({ ...base, domain: ["2021-01-01", "2021-01-01"] }), null); // zero span
});

test("producerTimeAxis reads the first time axis, else null (pre-2.5 → shim)", () => {
  const withAxis = {
    annotations: {
      axes: [{ orientation: "x", scale: "time", domain: ["2021-01-01", "2021-12-31"], range: [0.04, 0.96], label: "d" }],
    },
  } as unknown as LayoutEntry;
  assert.ok(producerTimeAxis(withAxis) !== null, "a producer axis is found");
  assert.equal(producerTimeAxis({} as LayoutEntry), null, "no annotations → null (falls back to the shim)");
  assert.equal(producerTimeAxis({ annotations: {} } as unknown as LayoutEntry), null, "no axes → null");
});

test("producerTimeAxis SKIPS non-x / unknown-scale axes — reader tolerance (PR-180 review)", () => {
  const mkAxis = (orientation: string, scale: string): AxisAnnotation =>
    ({ orientation, scale, domain: ["2021-01-01", "2021-12-31"], range: [0.04, 0.96], label: "d" }) as AxisAnnotation;
  const entry = (axes: AxisAnnotation[]): LayoutEntry => ({ annotations: { axes } }) as unknown as LayoutEntry;
  // A y-oriented time axis is NOT the x time domain (the schema legalizes "y"; consuming
  // it as x silently mis-rendered — the review's contract/consumer mismatch).
  assert.equal(producerTimeAxis(entry([mkAxis("y", "time")])), null);
  // A future minor's unknown scale is skipped, never an error (the version promise).
  assert.equal(producerTimeAxis(entry([mkAxis("x", "linear")])), null);
  // The declined-axis marker: axes present but empty → null (and the CALLER must not shim).
  assert.equal(producerTimeAxis(entry([])), null);
  // Mixed: the first x/time axis wins even after unknowns.
  const mixed = entry([mkAxis("y", "time"), mkAxis("x", "linear"), mkAxis("x", "time")]);
  assert.ok(producerTimeAxis(mixed) !== null, "the x/time axis is found among skipped ones");
});

test("label font metrics pin: labelHeightPx covers the rendered line box (the three-literal coupling)", () => {
  // PR-180 review: the reveal gate's labelHeightPx, the measure font, and the rendered
  // font were three unpinned literals — the ONLY guard on the ratified never-over-images
  // rule. The fonts now derive from one exported constant pair; this pins the third:
  // the gate's box height must cover the real rendered line box, else a label could
  // draw taller than the image-free strip the gate approved.
  const lineBox = LABEL_FONT_SIZE_PX * LABEL_FONT_LINE_HEIGHT;
  assert.ok(
    DEFAULT_OVERLAY_LAYER_CONFIG.labelHeightPx >= lineBox,
    `labelHeightPx ${DEFAULT_OVERLAY_LAYER_CONFIG.labelHeightPx} < the rendered line box ${lineBox} — ` +
      "the reveal gate would approve strips shorter than the drawn label",
  );
});

// ---------------------------------------------------------------------------
// v2.5 — categorical band labels: gap geometry + declutter
// ---------------------------------------------------------------------------

test("labelGapSlot is the band's image-free top-gutter strip (never over images)", () => {
  // A band region extent [x0,y0,x1,y1] = [0.2, 0.5, 0.8, 0.9]. The treemap insets its
  // images by (1 − _REGION_FILL)/2 = 0.05 of the band height, so the images START at
  // y0 + 0.05·h. The gap slot (top gapFrac of the band) ends AT that line, so it is
  // provably image-free (and lies within the band's own extent, so over no other band).
  const extent = [0.2, 0.5, 0.8, 0.9] as const;
  const h = extent[3] - extent[1];
  const slot = labelGapSlot(extent, 0.05);
  assert.deepEqual([slot[0], slot[1], slot[2]], [0.2, 0.5, 0.8], "same x span + top edge as the band");
  assert.ok(Math.abs(slot[3] - (extent[1] + 0.05 * h)) < 1e-12, "slot bottom = y0 + gapFrac·h");
  const imagesTop = extent[1] + 0.05 * h; // where the band's images begin (the _REGION_FILL inset)
  assert.ok(slot[3] <= imagesTop + 1e-12, "the gap slot never reaches the band's images");
});

test("label gap fraction stays within the treemap gutter (coupling with categorical._REGION_FILL)", () => {
  // R3 — LOAD-BEARING COUPLING (mirror: the pipeline test
  // `test_region_fill_gutter_covers_the_frontend_label_gap_frac`). labelGapSlot places a label
  // in the band's top-gutter strip of THIS fractional height. The producer keeps that strip
  // image-free by insetting members (1 - _REGION_FILL)/2 = 0.05 per edge, in
  // packages/pipeline/pipeline/layout_plugins/categorical.py. If a future edit raises
  // labelGapFrac past that inset, labels would sit over images — so this side of the coupling
  // is pinned here (the pipeline side pins _REGION_FILL; each test names the OTHER side).
  assert.ok(
    DEFAULT_OVERLAY_LAYER_CONFIG.labelGapFrac <= 0.05,
    "labelGapFrac exceeds the categorical image-free gutter (categorical.py _REGION_FILL ⇒ (1-0.9)/2 = 0.05) — band labels would overlap images",
  );
});

test("declutterLabels keeps the biggest-count labels and rejects overlapping boxes", () => {
  const mk = (count: number, left: number): LabelCandidate => ({
    text: "x",
    count,
    missing: false,
    screenX: left + 30,
    screenTop: 100,
    boxLeft: left,
    boxRight: left + 60,
    boxTop: 100,
    boxBottom: 114,
  });
  const cands = [mk(10, 0), mk(500, 20), mk(50, 400)]; // first two boxes overlap; the third is far
  const kept = declutterLabels(cands, 100);
  assert.equal(kept.length, 2, "the overlapping pair collapses to the bigger; the far one stays");
  assert.equal(kept[0].count, 500, "the biggest count (== band area) wins the contested spot");
  assert.ok(kept.some((c) => c.count === 50), "the well-separated label survives");
  // Budget cap honoured.
  const many = Array.from({ length: 30 }, (_, i) => mk(100 - i, i * 200));
  assert.equal(declutterLabels(many, 5).length, 5);
});
