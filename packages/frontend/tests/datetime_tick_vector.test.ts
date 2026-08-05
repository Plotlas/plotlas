// THE SHARED TICK VECTOR, renderer half — D-36 seam H4.
//
// `tests/fixtures/datetime_tick_vector.json` is one committed file read by TWO suites: this
// one, which runs the real renderer path over each case, and
// `tests/contract/test_datetime_tick_vector.py`, which checks every tick in the same file
// against the PRODUCER's own `_floor_interval`. That is what makes producer/renderer tick
// lock-step structural rather than documented: a change on either side fails the other
// side's suite, because neither side can edit the fixture to suit itself without breaking
// the other.
//
// Deliberately THIN. It asserts the committed vector and nothing else — the behavioural pins
// (thinning stays on bin edges, graceful absence, per-rung label formats) live beside their
// siblings in overlay_layer.test.ts. Its job is the CROSS-LANGUAGE identity.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { axisDomainToTimeDomain, axisTimeTicks, domainToX } from "../src/renderer/overlayLayer.ts";
import type { AxisAnnotation } from "../src/renderer/layout.ts";

interface VectorTick {
  t: string;
  x: number;
  label: string;
}
interface VectorCase {
  name: string;
  note: string;
  axis: AxisAnnotation;
  view: [number, number];
  ticks: VectorTick[];
}

const vector = JSON.parse(
  readFileSync(new URL("../../../tests/fixtures/datetime_tick_vector.json", import.meta.url), "utf-8"),
) as { target: number; cases: VectorCase[] };

// The fixture's `x` is stored at 12 dp; the identity itself is exact in float64 up to the
// slope/intercept round trip (measured residual 3.3e-11 on the tightest case, the 5-minute
// span). 1e-9 clears both by ~30x without going blind on a real placement change: one whole
// bin is 1.5e-2 wide even on the densest case here.
const X_TOL = 1e-9;

test("the shared tick vector: the renderer draws exactly the committed ticks", () => {
  assert.ok(vector.cases.length > 0, "the vector must not be empty");
  for (const c of vector.cases) {
    const domain = axisDomainToTimeDomain(c.axis);
    assert.ok(domain !== null, `${c.name}: the case's axis must convert to a time domain`);
    // The visible world-x window, mapped to time exactly as renderAxis does.
    const tLo = domain!.slope * c.view[0] + domain!.intercept;
    const tHi = domain!.slope * c.view[1] + domain!.intercept;
    const ticks = axisTimeTicks(tLo, tHi, vector.target, c.axis.interval ?? null);

    assert.deepEqual(
      ticks.map((t) => new Date(t.t).toISOString().replace(".000Z", "+00:00")),
      c.ticks.map((t) => t.t),
      `${c.name}: tick INSTANTS differ from the shared vector`,
    );
    assert.deepEqual(
      ticks.map((t) => t.label),
      c.ticks.map((t) => t.label),
      `${c.name}: tick LABELS differ from the shared vector`,
    );
    for (let i = 0; i < ticks.length; i++) {
      const x = domainToX(domain!, ticks[i].t);
      assert.ok(
        Math.abs(x - c.ticks[i].x) < X_TOL,
        `${c.name}: tick ${c.ticks[i].label} lands at world-x ${x}, not the vector's ${c.ticks[i].x}`,
      );
    }
  }
});

test("the shared tick vector covers every rung KIND the producer can bin at", () => {
  // The python half gates this set against `_INTERVAL_LADDER` itself, so a rung kind added
  // upstream fails THERE and forces a case here, which in turn forces a label format. This
  // side just states the six the renderer must format, so a kind silently dropped from the
  // fixture is caught in both suites rather than only in the one that owns the ladder.
  const kinds = new Set(vector.cases.map((c) => c.axis.interval?.kind).filter((k) => k !== undefined));
  assert.deepEqual(
    [...kinds].sort(),
    ["day", "hour", "minute", "month", "second", "year"],
    "every ladder kind needs a vector case — that is what pins its label format",
  );
  assert.ok(
    vector.cases.some((c) => c.axis.interval === undefined),
    "the vector must carry the pre-2.7 (no `interval`) case — graceful absence is contract",
  );
});
