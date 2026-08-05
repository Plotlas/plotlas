// Tier-1 (issue #4, v2 / D-33): getManifest validates the fetched JSON with the
// hand-written structural validator (no JSON-schema library). Both v2 fixture
// manifests pass; structural breakage is rejected with errors NAMING the
// offending field; manifest_version accepts exactly "2.x" and rejects any other
// major. GL-free; mocked globalThis.fetch.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiClient, validateLayoutManifest } from "../src/api-client/client.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));

function fixtureManifest(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, name, "layout_manifest.json"), "utf8"),
  ) as Record<string, unknown>;
}

function clone(doc: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

const GOLDEN = "golden_dataset_v2";

/** Run one document through the public getManifest path with a mocked fetch. */
async function getManifestOf(doc: unknown): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(doc), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const client = createApiClient("http://edge", () => "tok");
    return await client.getManifest("ds", "grid");
  } finally {
    globalThis.fetch = original;
  }
}

test("both committed v2 fixture manifests validate (issue #4 valid cases)", async () => {
  const golden = await getManifestOf(fixtureManifest(GOLDEN));
  assert.equal((golden as { dataset_id: string }).dataset_id, "golden_dataset_v2");
  const imagesOnly = await getManifestOf(fixtureManifest("golden_dataset_images_only_v2"));
  assert.equal((imagesOnly as { dataset_id: string }).dataset_id, "golden_dataset_images_only_v2");
});

test("a v2 manifest with a scatter layout entry passes (D-26)", async () => {
  const doc = clone(fixtureManifest(GOLDEN));
  (doc.layouts as unknown[]).push({
    layout_id: "scatter_umap",
    label: "UMAP",
    type: "scatter",
    bbox: [0, 0, 1, 1],
    pyramid: {
      container: "pmtiles",
      path: "tiles/scatter_umap/scatter_umap_v1.pmtiles",
      tile_px: 512,
      thumb_px: 64,
      cap: 64,
      levels: [{ z: 0, tile_count: 1 }],
      z_cap: 0,
    },
  });
  const manifest = (await getManifestOf(doc)) as { layouts: { type: string }[] };
  assert.equal(manifest.layouts[1].type, "scatter");
});

test("positions_ref (v2.2): a valid string passes, null is allowed, a non-string is rejected", async () => {
  // A valid per-layout position-table ref passes.
  const withRef = clone(fixtureManifest(GOLDEN));
  (withRef.layouts as Record<string, unknown>[])[0].positions_ref = "positions/grid_v1.arrow";
  withRef.manifest_version = "2.2";
  const ok = (await getManifestOf(withRef)) as { layouts: { positions_ref?: string }[] };
  assert.equal(ok.layouts[0].positions_ref, "positions/grid_v1.arrow");

  // Null is valid (graceful absence — a pre-2.2 layout).
  const withNull = clone(fixtureManifest(GOLDEN));
  (withNull.layouts as Record<string, unknown>[])[0].positions_ref = null;
  await getManifestOf(withNull); // does not throw

  // A non-string (or empty string) is rejected, naming the field.
  const badType = clone(fixtureManifest(GOLDEN));
  (badType.layouts as Record<string, unknown>[])[0].positions_ref = 7;
  await assert.rejects(getManifestOf(badType), /layouts\[0\]\.positions_ref/);
});

test("options (v2.3, D-35 G1): valid knobs pass, unknown keys are tolerated, a bad enum is rejected", async () => {
  // A valid scatter-knob echo (a combination the producer actually emits — both
  // axes share one scale, T2-128) passes and round-trips.
  const withOpts = clone(fixtureManifest(GOLDEN));
  (withOpts.layouts as Record<string, unknown>[])[0].options = {
    x_scale: "log", y_scale: "log", normalize: "fit", overlap: "overdraw",
  };
  withOpts.manifest_version = "2.3";
  const ok = (await getManifestOf(withOpts)) as { layouts: { options?: { x_scale?: string } }[] };
  assert.equal(ok.layouts[0].options?.x_scale, "log");

  // An UNKNOWN key is tolerated AND PRESERVED — not stripped (forward-compat for future
  // families; a future UI reading the raw echo must still see it). NB `projection` is now
  // a KNOWN, range-checked key (D-35 G2 landed it — see the dedicated G2 test below), so a
  // genuinely-unknown key stands in for the forward-compat case here.
  const withUnknown = clone(fixtureManifest(GOLDEN));
  (withUnknown.layouts as Record<string, unknown>[])[0].options = { future_knob: "whatever" };
  const tolerated = (await getManifestOf(withUnknown)) as {
    layouts: { options?: Record<string, unknown> }[];
  };
  assert.equal(tolerated.layouts[0].options?.future_knob, "whatever");

  // A bad enum value on ANY known key is rejected, naming the exact field.
  for (const [key, pattern] of [
    ["x_scale", /layouts\[0\]\.options\.x_scale/],
    ["y_scale", /layouts\[0\]\.options\.y_scale/],
    ["normalize", /layouts\[0\]\.options\.normalize/],
    ["overlap", /layouts\[0\]\.options\.overlap/],
  ] as const) {
    const badEnum = clone(fixtureManifest(GOLDEN));
    (badEnum.layouts as Record<string, unknown>[])[0].options = { [key]: "bogus" };
    await assert.rejects(getManifestOf(badEnum), pattern);
  }

  // A non-object `options` is rejected outright.
  const nonObject = clone(fixtureManifest(GOLDEN));
  (nonObject.layouts as Record<string, unknown>[])[0].options = "overdraw";
  await assert.rejects(getManifestOf(nonObject), /layouts\[0\]\.options/);
});

test("options (v2.4, D-35 G2): a geographic layout type + projection echo validate", async () => {
  // The "geographic" layout type is accepted (v2.4) and its options.projection echo is
  // range-checked: a valid projection passes and round-trips.
  const geo = clone(fixtureManifest(GOLDEN));
  const layout0 = (geo.layouts as Record<string, unknown>[])[0];
  layout0.type = "geographic";
  layout0.options = { projection: "equirectangular", overlap: "overdraw" };
  geo.manifest_version = "2.4";
  const ok = (await getManifestOf(geo)) as {
    layouts: { type: string; options?: { projection?: string } }[];
  };
  assert.equal(ok.layouts[0].type, "geographic");
  assert.equal(ok.layouts[0].options?.projection, "equirectangular");

  // A bad projection enum is rejected, naming the field.
  const badProj = clone(fixtureManifest(GOLDEN));
  (badProj.layouts as Record<string, unknown>[])[0].options = { projection: "albers" };
  await assert.rejects(getManifestOf(badProj), /layouts\[0\]\.options\.projection/);
});

test("the full-fixture manifest (v2.7, positions_ref + annotations + bbox_exact + missing_count + interval) validates", async () => {
  const full = await getManifestOf(fixtureManifest("golden_dataset_full_v2"));
  const layouts = full as {
    manifest_version: string;
    layouts: {
      type: string;
      positions_ref?: string;
      bbox_exact?: number[];
      annotations?: { labels?: unknown[]; axes?: { interval?: { kind: string; step: number } }[] };
      missing_count?: number;
    }[];
  };
  // Refreshed (T2-126) + geographic (D-35 G2) + v2.5 annotations & bbox_exact (T2-69/T2-72 Seam 2)
  // + v2.6 `missing_count` (U1 / T2-140) + v2.7 `axes[].interval` (H3 / T2-142). A LITERAL, not
  // MANIFEST_VERSION: this asserts the committed FIXTURE was re-baked by the current emitter,
  // which comparing the constant to itself could never catch. It must be bumped by hand with
  // every fixture re-bake.
  assert.equal(layouts.manifest_version, "2.8");
  for (const layout of layouts.layouts) {
    assert.ok(typeof layout.positions_ref === "string" && layout.positions_ref.length > 0);
    // v2.5: every layout carries the full-precision bbox_exact (exact chip binning).
    assert.ok(Array.isArray(layout.bbox_exact) && layout.bbox_exact.length === 4);
  }
  // v2.6 (U1 / T2-140): EVERY layout carries the count — scatter and geographic each have 9
  // null-coordinate cells in their unplaced strip; the rest place everything and say so with
  // an explicit 0. deepSTRICTEqual, because the loose form treats `undefined` and `null` as
  // equal and so could not tell a written 0 from an omitted key.
  assert.deepStrictEqual(
    layouts.layouts.map((l) => l.missing_count),
    [0, 0, 9, 0, 0, 9],
    "grid, datetime, scatter, categorical x2, geographic",
  );
  // ...and the zeros are really PRESENT, not `undefined` reading as one. An absent key means
  // "this entry predates 2.6", which is a different statement from "counted, found none",
  // and `.map()` flattens both to `undefined`.
  for (const layout of layouts.layouts) {
    assert.ok(
      Object.hasOwn(layout, "missing_count"),
      `layout ${layout.type} omits missing_count — every fresh 2.6 entry carries it`,
    );
  }
  // The validator accepts the real fixture's v2.5 annotations: categorical labels + datetime axis.
  assert.ok(
    layouts.layouts.some((l) => l.type === "categorical" && (l.annotations?.labels?.length ?? 0) > 0),
    "a categorical layout carries band labels",
  );
  assert.ok(
    layouts.layouts.some((l) => l.type === "datetime" && (l.annotations?.axes?.length ?? 0) > 0),
    "the datetime layout carries an axis",
  );
  // v2.7 (H3 / T2-142): ...and that axis reports the rung it binned at, end to end from the
  // real pipeline. The calib corpus is 256 daily dates over 255 days, which the relaxed sqrt
  // budget resolves to MONTHS (measured 2026-07-29) — a literal, so a producer that stopped
  // emitting the field, or emitted a constant, is caught here and not only in the pipeline
  // suite. `step: 1` is asserted explicitly: it is emitted, never implied by omission.
  const dtAxis = layouts.layouts.find((l) => l.type === "datetime")?.annotations?.axes?.[0];
  assert.deepStrictEqual(dtAxis?.interval, { kind: "month", step: 1 });
});

test("annotations (v2.5): every checkAnnotations fail branch rejects, NAMING the field (PR-180 review)", async () => {
  // The doc comment promises "a NAMED validation error at the client boundary, not a
  // silent misrender" — previously none of these branches had a test.
  const withAnnotations = (ann: unknown): Record<string, unknown> => {
    const doc = clone(fixtureManifest(GOLDEN));
    (doc.layouts as Record<string, unknown>[])[0].annotations = ann;
    return doc;
  };
  const label = { text: "red", extent: [0, 0, 0.5, 1], count: 3 };
  const axis = {
    orientation: "x", scale: "time",
    domain: ["2021-01-01T00:00:00+00:00", "2021-12-31T00:00:00+00:00"],
    range: [0.04, 0.96], label: "Captured",
  };

  // Baselines that must PASS.
  await getManifestOf(withAnnotations({ labels: [label] }));
  await getManifestOf(withAnnotations({ axes: [axis] }));
  await getManifestOf(withAnnotations({ axes: [] })); // the DECLINED-axis marker is valid
  await getManifestOf(withAnnotations({ future_block: [1] })); // unknown keys tolerated

  const cases: [unknown, RegExp][] = [
    ["not-an-object", /layouts\[0\]\.annotations: must be an object/],
    [{ labels: "x" }, /annotations\.labels: must be an array/],
    [{ labels: [7] }, /annotations\.labels\[0\]: must be an object/],
    [{ labels: [{ ...label, text: 7 }] }, /labels\[0\]\.text: must be a string/],
    [{ labels: [{ ...label, extent: [0, 0, 1] }] }, /labels\[0\]\.extent: must be an array of exactly 4/],
    [{ labels: [{ ...label, extent: [0, 0, 1, 1.5] }] }, /labels\[0\]\.extent\[3\]/],
    [{ labels: [{ ...label, count: -1 }] }, /labels\[0\]\.count/],
    [{ labels: [{ ...label, count: 1.5 }] }, /labels\[0\]\.count/],
    [{ labels: [{ ...label, missing: "yes" }] }, /labels\[0\]\.missing: must be a boolean/],
    [{ labels: [{ ...label, priority: "high" }] }, /labels\[0\]\.priority: must be a number/],
    [{ axes: "x" }, /annotations\.axes: must be an array/],
    [{ axes: [7] }, /axes\[0\]: must be an object/],
    [{ axes: [{ ...axis, orientation: 9 }] }, /axes\[0\]\.orientation/],
    [{ axes: [{ ...axis, scale: "" }] }, /axes\[0\]\.scale/],
    [{ axes: [{ ...axis, domain: ["2021-01-01"] }] }, /axes\[0\]\.domain: must be an array of exactly 2/],
    [{ axes: [{ ...axis, domain: ["2021-01-01", 7] }] }, /axes\[0\]\.domain\[1\]/],
    [{ axes: [{ ...axis, range: [0.04] }] }, /axes\[0\]\.range: must be an array of exactly 2/],
    [{ axes: [{ ...axis, range: [0.04, 1.5] }] }, /axes\[0\]\.range\[1\]/],
    [{ axes: [{ ...axis, label: 7 }] }, /axes\[0\]\.label: must be a string/],
    // v2.7 (H3): structural malformation of `interval` still fails loudly and by name — the
    // VALUE set is open (next test), the SHAPE is not.
    [{ axes: [{ ...axis, interval: "month" }] }, /axes\[0\]\.interval: must be an object/],
    [{ axes: [{ ...axis, interval: { step: 1 } }] }, /axes\[0\]\.interval\.kind/],
    [{ axes: [{ ...axis, interval: { kind: "month" } }] }, /axes\[0\]\.interval\.step/],
    [{ axes: [{ ...axis, interval: { kind: "month", step: 0 } }] }, /axes\[0\]\.interval\.step/],
    [{ axes: [{ ...axis, interval: { kind: "month", step: 1.5 } }] }, /axes\[0\]\.interval\.step/],
    [{ axes: [{ ...axis, interval: { kind: 7, step: 1 } }] }, /axes\[0\]\.interval\.kind/],
  ];
  for (const [ann, pattern] of cases) {
    await assert.rejects(getManifestOf(withAnnotations(ann)), pattern, JSON.stringify(ann));
  }
});

test("axes[].interval (v2.7): a valid rung round-trips, absence is valid, an UNKNOWN kind is tolerated", async () => {
  // T2-142 / D-36 seam H3: the bucketing rung the producer binned at, so the overlay ticks
  // bin boundaries it was TOLD about instead of re-deriving a second ladder. Three claims:
  //
  //  1. a valid rung survives validation with `step` INTACT — the field is useless to H4 if
  //     the client silently drops it, and a `{kind}`-only read would look identical here;
  //  2. an ABSENT `interval` is still valid, because that is every dataset baked before 2.7
  //     and the whole fallback contract H4 implements against;
  //  3. an unknown `kind` from a LATER minor does NOT reject the manifest. The schema's
  //     closed enum (second|minute|hour|day|month|year) is the PRODUCER's write gate; the
  //     reader must degrade to "that axis not drawn" per the version promise that a v2-major
  //     reader accepts any 2.MINOR. This is the same split `scale` already carries, and the
  //     reason `interval.kind` is checked as a string here rather than against the enum.
  const withAxis = (ax: Record<string, unknown>): Record<string, unknown> => {
    const doc = clone(fixtureManifest(GOLDEN));
    (doc.layouts as Record<string, unknown>[])[0].annotations = { axes: [ax] };
    return doc;
  };
  const base = {
    orientation: "x",
    scale: "time",
    domain: ["2021-01-01T00:00:00+00:00", "2021-09-01T00:00:00+00:00"],
    range: [0.04, 0.874525093],
    label: "Captured",
  };
  type Read = { layouts: { annotations?: { axes?: { interval?: { kind: string; step: number } }[] } }[] };

  const ok = (await getManifestOf(
    withAxis({ ...base, interval: { kind: "month", step: 3 } }),
  )) as Read;
  assert.deepStrictEqual(
    ok.layouts[0].annotations?.axes?.[0].interval,
    { kind: "month", step: 3 },
    "a valid rung must survive validation with kind AND step intact",
  );
  // `step: 1` is EMITTED, never implied — a falsy-one bug on this path would erase it.
  const one = (await getManifestOf(withAxis({ ...base, interval: { kind: "year", step: 1 } }))) as Read;
  assert.strictEqual(one.layouts[0].annotations?.axes?.[0].interval?.step, 1);

  // Absent => a pre-2.7 bake. Valid, and the consumer keeps its own ladder.
  const preH3 = (await getManifestOf(withAxis(base))) as Read;
  assert.strictEqual(preH3.layouts[0].annotations?.axes?.[0].interval, undefined);

  // A future minor's rung kind must not brick the dataset open.
  const future = (await getManifestOf(
    withAxis({ ...base, interval: { kind: "fortnight", step: 2 } }),
  )) as Read;
  assert.deepStrictEqual(
    future.layouts[0].annotations?.axes?.[0].interval,
    { kind: "fortnight", step: 2 },
    "an unknown rung kind is accepted + preserved, not a manifest rejection",
  );
});

test("annotations (v2.5): unknown axis scale/orientation VALUES are tolerated — the next minor must not brick the dataset (PR-180 review)", async () => {
  // The schema's version promise: a v2-major reader accepts any 2.MINOR. Adding
  // scale:"linear" (the D-35 scatter/geo axes) must degrade to "axis not drawn", never
  // to a manifest rejection that fails the whole dataset open. Structure stays strict;
  // only the VALUE set is open (the producer's schema enums still gate writes).
  const doc = clone(fixtureManifest(GOLDEN));
  (doc.layouts as Record<string, unknown>[])[0].annotations = {
    axes: [
      { orientation: "x", scale: "linear", domain: ["0", "100"], range: [0.04, 0.96], label: "Size" },
      { orientation: "y", scale: "time", domain: ["2021-01-01", "2021-12-31"], range: [0.1, 0.9], label: "D" },
    ],
  };
  const ok = (await getManifestOf(doc)) as {
    layouts: { annotations?: { axes?: { scale: string }[] } }[];
  };
  assert.equal(ok.layouts[0].annotations?.axes?.[0].scale, "linear", "future scale accepted + preserved");
});

test("pyramid.dropped_total (v2.5): valid values pass, absent is valid, bad values are named", async () => {
  const withDropped = (value: unknown): Record<string, unknown> => {
    const doc = clone(fixtureManifest(GOLDEN));
    ((doc.layouts as Record<string, unknown>[])[0].pyramid as Record<string, unknown>).dropped_total = value;
    return doc;
  };
  const ok = (await getManifestOf(withDropped(177))) as {
    layouts: { pyramid: { dropped_total?: number } }[];
  };
  assert.equal(ok.layouts[0].pyramid.dropped_total, 177);
  await getManifestOf(withDropped(0));
  await getManifestOf(clone(fixtureManifest(GOLDEN))); // absent (pre-2.5) is valid
  await assert.rejects(getManifestOf(withDropped(-1)), /pyramid\.dropped_total/);
  await assert.rejects(getManifestOf(withDropped(1.5)), /pyramid\.dropped_total/);
  await assert.rejects(getManifestOf(withDropped("many")), /pyramid\.dropped_total/);
});

test("missing_count (v2.6): valid counts pass, 0 is a value, absent is valid, bad values are named", async () => {
  // T2-140 / D-36 seam U1: the count of cells a layout could not place, on the LAYOUT ENTRY
  // (a declined axis emits no axis object to hang it on, and scatter/geographic emit no
  // annotations at all). A fresh 2.6 producer always writes it, 0 included; absent stays
  // VALID here because `golden_dataset_v2` is a genuine pre-2.6 entry and add-layouts carries
  // such entries forward untouched. A malformed value is a NAMED error at the client boundary.
  const withCount = (value: unknown): Record<string, unknown> => {
    const doc = clone(fixtureManifest(GOLDEN));
    (doc.layouts as Record<string, unknown>[])[0].missing_count = value;
    return doc;
  };
  const ok = (await getManifestOf(withCount(9))) as { layouts: { missing_count?: number }[] };
  assert.strictEqual(ok.layouts[0].missing_count, 9);
  // 0 must survive validation as a VALUE — it is the "counted, found none" claim, and a
  // falsy-zero bug anywhere on this path would erase it back into the pre-2.6 silence.
  const zero = (await getManifestOf(withCount(0))) as { layouts: { missing_count?: number }[] };
  assert.strictEqual(zero.layouts[0].missing_count, 0);
  await getManifestOf(clone(fixtureManifest(GOLDEN))); // absent (a pre-2.6 entry) is valid
  await assert.rejects(getManifestOf(withCount(-1)), /layouts\[0\]\.missing_count/);
  await assert.rejects(getManifestOf(withCount(1.5)), /layouts\[0\]\.missing_count/);
  await assert.rejects(getManifestOf(withCount("nine")), /layouts\[0\]\.missing_count/);
  await assert.rejects(getManifestOf(withCount(null)), /layouts\[0\]\.missing_count/);
});

test("manifest_version: major != 2 is rejected, naming the field", async () => {
  const doc = clone(fixtureManifest(GOLDEN));
  doc.manifest_version = "1.0";
  await assert.rejects(getManifestOf(doc), /manifest_version.*major version "1\.0"/);
});

test("missing layouts is rejected, naming the field", async () => {
  const doc = clone(fixtureManifest(GOLDEN));
  delete doc.layouts;
  await assert.rejects(getManifestOf(doc), /layouts: must be an array/);
});

test("empty layouts is rejected (minItems 1)", async () => {
  const doc = clone(fixtureManifest(GOLDEN));
  doc.layouts = [];
  await assert.rejects(getManifestOf(doc), /layouts: must contain at least one/);
});

test("layout-entry shape: bad type enum and bbox arity are named", async () => {
  const badType = clone(fixtureManifest(GOLDEN));
  (badType.layouts as Record<string, unknown>[])[0].type = "spiral";
  await assert.rejects(getManifestOf(badType), /layouts\[0\]\.type: must be one of/);

  const badBbox = clone(fixtureManifest(GOLDEN));
  (badBbox.layouts as Record<string, unknown>[])[0].bbox = [0, 0, 1];
  await assert.rejects(getManifestOf(badBbox), /layouts\[0\]\.bbox: must be an array of exactly 4/);

  const outOfRange = clone(fixtureManifest(GOLDEN));
  (outOfRange.layouts as Record<string, unknown>[])[0].bbox = [0, 0, 1, 1.5];
  await assert.rejects(getManifestOf(outOfRange), /layouts\[0\]\.bbox\[3\]/);
});

test("pyramid descriptor is checked: container/tile_px enums, thumb_px bound, levels arity", async () => {
  const missingPyramid = clone(fixtureManifest(GOLDEN));
  delete (missingPyramid.layouts as Record<string, unknown>[])[0].pyramid;
  await assert.rejects(getManifestOf(missingPyramid), /layouts\[0\]\.pyramid: must be an object/);

  const badContainer = clone(fixtureManifest(GOLDEN));
  ((badContainer.layouts as Record<string, unknown>[])[0].pyramid as Record<string, unknown>).container =
    "loose";
  await assert.rejects(getManifestOf(badContainer), /layouts\[0\]\.pyramid\.container: must be one of/);

  const badTilePx = clone(fixtureManifest(GOLDEN));
  ((badTilePx.layouts as Record<string, unknown>[])[0].pyramid as Record<string, unknown>).tile_px = 333;
  await assert.rejects(getManifestOf(badTilePx), /layouts\[0\]\.pyramid\.tile_px: must be one of/);

  const badThumb = clone(fixtureManifest(GOLDEN));
  ((badThumb.layouts as Record<string, unknown>[])[0].pyramid as Record<string, unknown>).thumb_px = 9999;
  await assert.rejects(getManifestOf(badThumb), /layouts\[0\]\.pyramid\.thumb_px: must be at most 512/);

  const emptyLevels = clone(fixtureManifest(GOLDEN));
  ((emptyLevels.layouts as Record<string, unknown>[])[0].pyramid as Record<string, unknown>).levels = [];
  await assert.rejects(getManifestOf(emptyLevels), /layouts\[0\]\.pyramid\.levels: must be a non-empty array/);
});

test("pyramid invariants the loader assumes are enforced: contiguous levels, z_cap range, cap formula", async () => {
  // Helper: a multi-level pyramid that DOES satisfy the invariants (the baseline
  // we then break one field at a time). tile_px 512 / thumb_px 64 ⇒ cap 64.
  const okPyramid = {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [
      { z: 0, tile_count: 1 },
      { z: 1, tile_count: 4 },
      { z: 2, tile_count: 16 },
    ],
    z_cap: 1,
  };
  const withPyramid = (mut: (p: Record<string, unknown>) => void): Record<string, unknown> => {
    const doc = clone(fixtureManifest(GOLDEN));
    const p = clone(okPyramid);
    mut(p);
    (doc.layouts as Record<string, unknown>[])[0].pyramid = p;
    return doc;
  };

  // The baseline (3 contiguous levels, z_cap in range, cap = formula) validates.
  await getManifestOf(withPyramid(() => {}));

  // A gap in the z ladder is rejected.
  await assert.rejects(
    getManifestOf(withPyramid((p) => { p.levels = [{ z: 0, tile_count: 1 }, { z: 2, tile_count: 16 }]; })),
    /levels: z values must be contiguous/,
  );
  // A duplicate z is rejected.
  await assert.rejects(
    getManifestOf(withPyramid((p) => { p.levels = [{ z: 0, tile_count: 1 }, { z: 0, tile_count: 1 }]; })),
    /levels: z values must be unique/,
  );
  // z_cap above the baked range is rejected.
  await assert.rejects(
    getManifestOf(withPyramid((p) => { p.z_cap = 5; })),
    /z_cap: must be within the baked level range \[0\.\.2\]/,
  );
  // cap that does not equal floor(tile_px/thumb_px)^2 is rejected.
  await assert.rejects(
    getManifestOf(withPyramid((p) => { p.cap = 63; })),
    /cap: must equal floor\(tile_px\/thumb_px\)\^2/,
  );
  // A deepest level beyond MAX_PYRAMID_Z (15) is rejected: tilePageId = y*2^z + x
  // would overflow the Int32 atlas page into bucket-key collisions.
  await assert.rejects(
    getManifestOf(
      withPyramid((p) => {
        p.levels = [{ z: 15, tile_count: 1 }, { z: 16, tile_count: 4 }];
        p.z_cap = 15;
      }),
    ),
    /levels: deepest level z=16 exceeds the renderer's maximum 15/,
  );
});

test("detail descriptor is checked when present: mode enum + path_prefix for image_ref", async () => {
  const badMode = clone(fixtureManifest(GOLDEN));
  ((badMode.layouts as Record<string, unknown>[])[0].detail as Record<string, unknown>).mode = "nope";
  await assert.rejects(getManifestOf(badMode), /layouts\[0\]\.detail\.mode: must be one of/);

  const missingPrefix = clone(fixtureManifest(GOLDEN));
  delete ((missingPrefix.layouts as Record<string, unknown>[])[0].detail as Record<string, unknown>)
    .path_prefix;
  await assert.rejects(getManifestOf(missingPrefix), /layouts\[0\]\.detail\.path_prefix/);
});

test("tags / dataset_metadata / column_roles structure is checked and named", async () => {
  const badTags = clone(fixtureManifest(GOLDEN));
  (badTags.tags as Record<string, unknown>).format = "parquet";
  await assert.rejects(getManifestOf(badTags), /tags\.format/);

  const badMeta = clone(fixtureManifest(GOLDEN));
  delete (badMeta.dataset_metadata as Record<string, unknown>).image_count;
  await assert.rejects(getManifestOf(badMeta), /dataset_metadata\.image_count/);

  const badRoles = clone(fixtureManifest(GOLDEN));
  delete (badRoles.column_roles as Record<string, unknown>).filename;
  await assert.rejects(getManifestOf(badRoles), /column_roles\.filename/);

  const badDelim = clone(fixtureManifest(GOLDEN));
  ((badDelim.column_roles as Record<string, unknown>).tag as Record<string, unknown>[])[0].delimiter = 7;
  await assert.rejects(getManifestOf(badDelim), /column_roles\.tag\[0\]\.delimiter/);
});

test("column_roles.url is validated as an array of non-empty strings (schema v2.8)", () => {
  // A well-formed url role passes.
  const ok = clone(fixtureManifest(GOLDEN));
  (ok.column_roles as Record<string, unknown>).url = ["source_url"];
  assert.doesNotThrow(() => validateLayoutManifest(ok));

  // A bare string (a hand-patch typo) is rejected at the client boundary, not trusted.
  const notArray = clone(fixtureManifest(GOLDEN));
  (notArray.column_roles as Record<string, unknown>).url = "source_url";
  assert.throws(() => validateLayoutManifest(notArray), /column_roles\.url: must be an array/);

  // Non-string / empty-string entries are rejected (matches the schema's minLength: 1).
  const notString = clone(fixtureManifest(GOLDEN));
  (notString.column_roles as Record<string, unknown>).url = [7];
  assert.throws(() => validateLayoutManifest(notString), /column_roles\.url\[0\]/);

  const empty = clone(fixtureManifest(GOLDEN));
  (empty.column_roles as Record<string, unknown>).url = [""];
  assert.throws(() => validateLayoutManifest(empty), /column_roles\.url\[0\].*non-empty/);
});

test("validator is exported directly and rejects non-objects", () => {
  assert.throws(() => validateLayoutManifest(null), /manifest: must be a JSON object/);
  assert.throws(() => validateLayoutManifest([]), /manifest: must be a JSON object/);
  assert.throws(() => validateLayoutManifest("2.1"), /manifest: must be a JSON object/);
  // And accepts the fixture document directly.
  const ok = validateLayoutManifest(fixtureManifest(GOLDEN));
  assert.equal(ok.manifest_version, "2.1");
});
