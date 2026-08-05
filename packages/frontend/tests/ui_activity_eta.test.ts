// Tier-1 (Seam O3): the honest ETA math. Pure functions with an injected `now` —
// the NO-FAKE guards (null total ⇒ no estimate), the own-rate per-stage ETA, the
// whole-job composition, and the determinate/indeterminate bar decision.
import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDuration,
  isLayoutStage,
  layoutIdFromKey,
  stageBarKind,
  stageDurationSeconds,
  stageEtaSeconds,
  stageFraction,
  wholeJobEtaSeconds,
} from "../src/ui/activity/eta.ts";
import type { JobProgress, JobProgressStage } from "../src/api-client/types.ts";

function stage(over: Partial<JobProgressStage>): JobProgressStage {
  return { key: "s", label: "S", unit: "images", done: 0, total: null, state: "queued", ...over };
}

// t_start is EPOCH SECONDS; nowMs is Date.now()-style MILLISECONDS.
const SEC = 1000;

test("stageEtaSeconds uses the stage's OWN measured rate (elapsed/done × remaining)", () => {
  // 25 of 100 done in 40s ⇒ 1.6 units/s ⇒ 75 remaining ≈ 120s.
  const s = stage({ state: "running", total: 100, done: 25, t_start: 1000 });
  assert.equal(stageEtaSeconds(s, (1000 + 40) * SEC), 120);
});

test("stageEtaSeconds returns null without an honest basis (NO-FAKE)", () => {
  const base = { state: "running" as const, done: 25, t_start: 1000 };
  assert.equal(stageEtaSeconds(stage({ ...base, total: null }), 2000 * SEC), null, "no total ⇒ no ETA");
  assert.equal(stageEtaSeconds(stage({ ...base, total: 100, done: 0 }), 2000 * SEC), null, "done=0 ⇒ no ETA");
  assert.equal(
    stageEtaSeconds(stage({ total: 100, done: 25, t_start: 1000, state: "queued" }), 2000 * SEC),
    null,
    "not running ⇒ no ETA",
  );
  assert.equal(
    stageEtaSeconds(stage({ ...base, total: 100, t_start: null }), 2000 * SEC),
    null,
    "no start time ⇒ no ETA",
  );
  // done >= total ⇒ 0 remaining (not null).
  assert.equal(stageEtaSeconds(stage({ ...base, total: 100, done: 100 }), (1000 + 40) * SEC), 0);
});

test("stageEtaSeconds returns null on zero / negative elapsed (clock skew), not '≈ 0 s' (R2)", () => {
  // A freshly-started stage with real progress but now <= t_start (server clock ahead of
  // the browser, or the same instant): no honest elapsed ⇒ no rate ⇒ null, never 0.
  const s = stage({ state: "running", total: 100, done: 10, t_start: 1000 });
  assert.equal(stageEtaSeconds(s, 1000 * SEC), null, "now == t_start ⇒ no anchor yet");
  assert.equal(stageEtaSeconds(s, (1000 - 5) * SEC), null, "now < t_start (skew) ⇒ no anchor");
  // Once genuine elapsed accrues, the real own-rate ETA returns (guard-doesn't-overreach).
  assert.equal(stageEtaSeconds(s, (1000 + 90) * SEC), 810, "10 in 90s ⇒ 90 remaining ≈ 810s");
});

test("stageBarKind: determinate ONLY with a real positive total; else indeterminate/none", () => {
  assert.equal(stageBarKind(stage({ state: "running", total: 100, done: 5 })), "determinate");
  assert.equal(stageBarKind(stage({ state: "running", total: null, done: 5 })), "indeterminate");
  assert.equal(stageBarKind(stage({ state: "running", total: 0, done: 0 })), "indeterminate");
  assert.equal(stageBarKind(stage({ state: "queued", total: 100 })), "none");
  assert.equal(stageBarKind(stage({ state: "done", total: 100, done: 100 })), "none");
});

test("stageFraction is null for a null total and clamps to [0,1]", () => {
  assert.equal(stageFraction(stage({ total: 100, done: 25 })), 0.25);
  assert.equal(stageFraction(stage({ total: null, done: 25 })), null);
  assert.equal(stageFraction(stage({ total: 100, done: 250 })), 1, "clamped");
});

test("stageDurationSeconds is t_end - t_start, else null", () => {
  assert.equal(stageDurationSeconds(stage({ t_start: 100, t_end: 175 })), 75);
  assert.equal(stageDurationSeconds(stage({ t_start: 100, t_end: null })), null);
});

test("wholeJobEtaSeconds composes the running anchor + estimable queued stages, jumping past unknowns", () => {
  const progress: JobProgress = {
    progress_version: 1,
    spec_layouts: ["grid"],
    stages: [
      // completed images stage ⇒ 1000/100s = 10 images/s learned rate.
      stage({ key: "thumbs", unit: "images", done: 1000, total: 1000, state: "done", t_start: 0, t_end: 100 }),
      // running images stage: (250-200)*(500-100)/100 = 200s anchor.
      stage({ key: "detail", unit: "images", done: 100, total: 500, state: "running", t_start: 200 }),
      // queued images stage with a known total ⇒ 50/10 = 5s added.
      stage({ key: "extra", unit: "images", done: 0, total: 50, state: "queued" }),
      // queued one-shot (null total) ⇒ omitted, no fabrication.
      stage({ key: "tags", unit: null, done: 0, total: null, state: "queued" }),
      // queued tiles stage with NO learned tiles-rate ⇒ omitted (jumps up when it starts).
      stage({ key: "layout:grid", unit: "tiles", done: 0, total: 300, state: "queued" }),
    ],
  };
  assert.equal(wholeJobEtaSeconds(progress, 250 * SEC), 205); // 200 anchor + 5 estimable queued
});

test("wholeJobEtaSeconds degrades to null with no honest anchor", () => {
  const noRunning: JobProgress = {
    progress_version: 1,
    spec_layouts: [],
    stages: [stage({ key: "thumbs", state: "done", total: 100, done: 100, t_start: 0, t_end: 10 })],
  };
  assert.equal(wholeJobEtaSeconds(noRunning, 100 * SEC), null, "nothing running ⇒ no whole-job estimate");

  const runningIndeterminate: JobProgress = {
    progress_version: 1,
    spec_layouts: [],
    stages: [stage({ key: "scan", state: "running", total: null, done: 5, t_start: 0 })],
  };
  assert.equal(wholeJobEtaSeconds(runningIndeterminate, 100 * SEC), null, "no anchor rate ⇒ null");
});

test("formatDuration is human-scaled (seconds / minutes / hours)", () => {
  assert.equal(formatDuration(0), "0 s");
  assert.equal(formatDuration(-5), "0 s");
  assert.equal(formatDuration(45), "45 s");
  assert.equal(formatDuration(120), "2 min");
  assert.equal(formatDuration(300), "5 min");
  assert.equal(formatDuration(5400), "1 h 30 min");
  assert.equal(formatDuration(7200), "2 h");
});

test("formatDuration steps smoothly across the minute boundary (no 89 s → 2 min jump)", () => {
  // Unit boundaries at 60 (not 90): "59 s" → "1 min" → "2 min", never skipping ~1 min.
  assert.equal(formatDuration(59), "59 s");
  assert.equal(formatDuration(60), "1 min");
  assert.equal(formatDuration(89), "1 min"); // was "89 s" before the fix
  assert.equal(formatDuration(90), "2 min");
  assert.equal(formatDuration(3600), "1 h"); // 60 min rolls into hours, not "60 min"
});

test("isLayoutStage / layoutIdFromKey split the per-layout bake stages", () => {
  assert.equal(isLayoutStage(stage({ key: "layout:kingdom" })), true);
  assert.equal(isLayoutStage(stage({ key: "thumbs" })), false);
  assert.equal(layoutIdFromKey("layout:kingdom"), "kingdom");
  assert.equal(layoutIdFromKey("thumbs"), "thumbs");
});
