// Tier-1: the D-35 Seam G3 (T2-125) layout-option VOCABULARY — the viewer's baked-options
// summary (describeBakedOptions over the manifest `options` echo), the switcher family badge,
// the shared option defaults, the cross-knob lock rule (the one combination ingest rejects),
// and the per-knob microcopy invariants (every option value ships a plain-language sentence
// that stands alone without the not-yet-built G5 explainer page; the reserved overlap modes
// are flagged disabled/"coming").
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NORMALIZE,
  DEFAULT_OVERLAP,
  DEFAULT_PROJECTION,
  DEFAULT_SCALE,
  NORMALIZE_OPTIONS,
  OVERLAP_OPTIONS,
  PROJECTION_OPTIONS,
  SCALE_OPTIONS,
  describeBakedOptions,
  familyBadge,
  scatterKnobLocks,
} from "../src/ui/layoutOptions.ts";
import type { LayoutOptions } from "../src/renderer/layout.ts";

test("describeBakedOptions: scatter summarizes scale + placement (the D-35 examples)", () => {
  // A DEFAULT scatter bake omits the manifest `options` echo — still explainable as auto-fit.
  assert.equal(describeBakedOptions("scatter", undefined), "auto-fit");
  // A log bake reads "log × log, fit" (the operator's example).
  assert.equal(describeBakedOptions("scatter", { x_scale: "log", y_scale: "log" }), "log × log, fit");
  assert.equal(describeBakedOptions("scatter", { x_scale: "log" }), "log × linear, fit");
  // Pass-through.
  assert.equal(describeBakedOptions("scatter", { normalize: "none" }), "pass-through");
  // An explicit linear/fit echo collapses back to the default summary.
  assert.equal(describeBakedOptions("scatter", { x_scale: "linear", y_scale: "linear", normalize: "fit" }), "auto-fit");
});

test("describeBakedOptions: geographic always names its projection (the map explainer)", () => {
  assert.equal(describeBakedOptions("geographic", { projection: "equirectangular" }), "equirectangular");
  assert.equal(describeBakedOptions("geographic", { projection: "mercator" }), "mercator");
  // Absent projection ⇒ the default (equirectangular) — still explainable.
  assert.equal(describeBakedOptions("geographic", undefined), "equirectangular");
});

test("describeBakedOptions: a non-default overlap is appended; families with no shaping options are null", () => {
  const opts: LayoutOptions = { projection: "mercator", overlap: "jitter" };
  assert.equal(describeBakedOptions("geographic", opts), "mercator, jitter");
  assert.equal(describeBakedOptions("scatter", { overlap: "overdraw" }), "auto-fit"); // default overlap not shown
  for (const type of ["grid", "datetime", "categorical", "umap", "network", "custom"]) {
    assert.equal(describeBakedOptions(type, undefined), null, `${type} has no shaping options`);
  }
});

test("familyBadge marks the two coordinate families apart, mirroring the wizard section names", () => {
  assert.equal(familyBadge("geographic"), "map");
  assert.equal(familyBadge("scatter"), "x/y");
  for (const type of ["grid", "datetime", "categorical"]) {
    assert.equal(familyBadge(type), null);
  }
});

test("every knob option ships a non-empty label + microcopy; the reserved overlap modes are disabled", () => {
  const all = [...SCALE_OPTIONS, ...NORMALIZE_OPTIONS, ...PROJECTION_OPTIONS, ...OVERLAP_OPTIONS];
  for (const o of all) {
    assert.ok(o.label.length > 0, `option ${o.value} missing a label`);
    assert.ok(o.microcopy.length > 0, `option ${o.value} missing microcopy (options + information)`);
  }
  // D-35 G4 lands the behaviors; today jitter/aggregate are DISABLED ("coming"), overdraw is not.
  const overlap = Object.fromEntries(OVERLAP_OPTIONS.map((o) => [o.value, o.disabled === true]));
  assert.deepEqual(overlap, { overdraw: false, jitter: true, aggregate: true });
});

test("every knob explains itself WITHOUT an external page (the G5 explainer does not exist yet)", () => {
  // D-35's seam map schedules the option deep-links in G3, but the "Layout options
  // explained" page they point at is G5's deliverable. Rather than ship a link to a
  // placeholder, the microcopy carries the whole explanation — so it must READ as a
  // complete sentence, not as a teaser that needs a click to finish.
  for (const o of [...SCALE_OPTIONS, ...NORMALIZE_OPTIONS, ...PROJECTION_OPTIONS, ...OVERLAP_OPTIONS]) {
    assert.ok(o.microcopy.trim().endsWith("."), `${o.value} microcopy is not a full sentence`);
    assert.ok(o.microcopy.split(" ").length >= 6, `${o.value} microcopy is too thin to stand alone`);
  }
});

test("scatterKnobLocks names the one combination ingest rejects, in both directions", () => {
  // Defaults are freely combinable.
  assert.deepEqual(scatterKnobLocks("linear", "fit"), { logLock: null, passThroughLock: null });
  // Pass-through locks log...
  const underPassThrough = scatterKnobLocks("linear", "none");
  assert.match(underPassThrough.logLock ?? "", /apply any log scaling upstream/);
  assert.equal(underPassThrough.passThroughLock, null);
  // ...and log locks pass-through, so the pair can never reach the rejected state from
  // either side (pipeline/ingest.py: "'log' is incompatible with normalize 'none'").
  const underLog = scatterKnobLocks("log", "fit");
  assert.match(underLog.passThroughLock ?? "", /apply any log scaling upstream/);
  assert.equal(underLog.logLock, null);
});

test("the exported defaults are the ones describeBakedOptions falls back to", () => {
  // One definition, so the picker (which keeps a default-valued knob ABSENT) and the viewer
  // (which explains an ABSENT echo) can never disagree about what "default" means.
  assert.equal(describeBakedOptions("geographic", { projection: DEFAULT_PROJECTION }), describeBakedOptions("geographic", undefined));
  assert.equal(
    describeBakedOptions("scatter", { x_scale: DEFAULT_SCALE, y_scale: DEFAULT_SCALE, normalize: DEFAULT_NORMALIZE }),
    describeBakedOptions("scatter", undefined),
  );
  assert.equal(describeBakedOptions("scatter", { overlap: DEFAULT_OVERLAP }), "auto-fit");
  // Each default is a real option value in its knob.
  assert.ok(SCALE_OPTIONS.some((o) => o.value === DEFAULT_SCALE));
  assert.ok(NORMALIZE_OPTIONS.some((o) => o.value === DEFAULT_NORMALIZE));
  assert.ok(PROJECTION_OPTIONS.some((o) => o.value === DEFAULT_PROJECTION));
  assert.ok(OVERLAP_OPTIONS.some((o) => o.value === DEFAULT_OVERLAP));
});
