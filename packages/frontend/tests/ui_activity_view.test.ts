// Tier-1 (Seam O3): react-dom/server renderToString smokes for the activity views —
// the shared StageChecklist (NO-FAKE determinate vs indeterminate bars, per-layout
// committed/baking/queued/failed rows, the estimate-labelled ETA, the aria-live current
// line), the ActivityPanel sections, jobOverall / updatingBadge, and JobProgressView's
// real-progress path vs its pre-progress fallback. `now` is injected so ETA is fixed.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import {
  StageChecklist,
  currentStatusAnnouncement,
  currentStatusLine,
} from "../src/ui/activity/stageChecklist.ts";
import { ActivityPanel, jobOverall } from "../src/ui/activity/ActivityPanel.ts";
import { updatingBadge } from "../src/ui/admin/DatasetList.ts";
import { JobProgressView } from "../src/ui/admin/JobProgress.ts";
import type { TrackedJob } from "../src/ui/activity/activityStore.ts";
import type { JobProgress, JobProgressStage, JobStatus } from "../src/api-client/types.ts";

const SEC = 1000;

function stage(over: Partial<JobProgressStage>): JobProgressStage {
  return { key: "s", label: "S", unit: "images", done: 0, total: null, state: "queued", ...over };
}
function progress(stages: JobProgressStage[], over: Partial<JobProgress> = {}): JobProgress {
  return { progress_version: 1, spec_layouts: [], stages, ...over };
}

test("StageChecklist: a running stage with a real total renders a DETERMINATE bar + count + ETA", () => {
  const p = progress([stage({ key: "thumbs", label: "Thumbnails", done: 25, total: 100, state: "running", t_start: 1000 })]);
  const html = renderToString(h(StageChecklist, { progress: p, now: (1000 + 40) * SEC }));
  assert.match(html, /Thumbnails/);
  assert.match(html, /progress-fill/);
  assert.match(html, /width:25%/); // done/total, a REAL fraction
  assert.match(html, /25 \/ 100 images/);
  assert.match(html, /≈ 2 min/); // 75 remaining at 25-in-40s ⇒ 120s
  assert.ok(!/progress-indeterminate/.test(html), "a real total ⇒ never the shimmer");
  // aria-live current line for screen readers.
  assert.match(html, /role="status" aria-live="polite"|aria-live="polite"[^>]*role="status"/);
});

test("StageChecklist: a running stage with a NULL total is INDETERMINATE — no fabricated fill (NO-FAKE)", () => {
  const p = progress([stage({ key: "scan", label: "Scanning", unit: null, done: 5, total: null, state: "running", t_start: 1000 })]);
  const html = renderToString(h(StageChecklist, { progress: p, now: 2000 * SEC }));
  assert.match(html, /progress-indeterminate/);
  assert.ok(!/progress-fill/.test(html), "no determinate fill without a real total");
  assert.ok(!/activity-stage-count/.test(html), "no count readout without a total");
});

test("StageChecklist: per-layout rows read committed / baking / queued / failed from layout:* stages", () => {
  const p = progress([
    stage({ key: "layout:grid", label: "grid", unit: "tiles", done: 400, total: 400, state: "done" }),
    stage({ key: "layout:kingdom", label: "kingdom", unit: "tiles", done: 120, total: 400, state: "running" }),
    stage({ key: "layout:datetime", label: "datetime", unit: "tiles", state: "queued" }),
    stage({ key: "layout:phylum", label: "phylum", unit: "tiles", state: "failed" }),
  ]);
  const html = renderToString(h(StageChecklist, { progress: p, now: 0 }));
  assert.match(html, /activity-layouts/);
  for (const id of ["grid", "kingdom", "datetime", "phylum"]) assert.match(html, new RegExp(id));
  assert.match(html, /committed/);
  assert.match(html, /baking/);
  assert.match(html, /queued/);
  assert.match(html, /failed/);
  // The baking layout gets a determinate bar (120/400 = 30%); queued/committed do not.
  assert.match(html, /width:30%/);
});

test("StageChecklist: the whole-job line is ALWAYS labelled an estimate (never a bare fact)", () => {
  const p = progress([stage({ key: "detail", unit: "images", done: 100, total: 500, state: "running", t_start: 200 })]);
  const html = renderToString(h(StageChecklist, { progress: p, now: 250 * SEC }));
  assert.match(html, /≈ 3 min remaining/); // (250-200)*(500-100)/100 = 200s ⇒ 3 min
  assert.match(html, /estimate/);
});

test("StageChecklist: no whole-job ETA line when there is no honest basis (degrade to nothing)", () => {
  const p = progress([stage({ key: "scan", unit: null, done: 5, total: null, state: "running", t_start: 0 })]);
  const html = renderToString(h(StageChecklist, { progress: p, now: 100 * SEC }));
  assert.ok(!/remaining/.test(html), "no fabricated whole-job estimate");
});

test("jobOverall maps RQ state to a label + status-chip tone", () => {
  assert.deepEqual(jobOverall(null), { label: "Queued", tone: "processing" });
  assert.deepEqual(jobOverall({ job_id: "j", state: "started", dataset_id: "d", log_tail: [] }), {
    label: "Processing",
    tone: "processing",
  });
  assert.deepEqual(jobOverall({ job_id: "j", state: "finished", dataset_id: "d", log_tail: [] }), {
    label: "Done",
    tone: "ready",
  });
  assert.deepEqual(jobOverall({ job_id: "j", state: "failed", dataset_id: "d", log_tail: [] }), {
    label: "Failed",
    tone: "error",
  });
});

test("updatingBadge renders an accent status-chip button (T2-104)", () => {
  const html = renderToString(updatingBadge(() => {}));
  assert.match(html, /status-chip status-updating updating-badge/);
  assert.match(html, />updating</);
  assert.match(html, /<button/); // clickable (opens the panel)
});

function trackedJob(over: Partial<TrackedJob> & { jobId: string; dsId: string }): TrackedJob {
  return { status: null, pollError: null, unreachable: false, ...over };
}
function jobStatus(state: string, over: Partial<JobStatus> = {}): JobStatus {
  return { job_id: "j", state, dataset_id: "ds", log_tail: [], error: null, ...over };
}

test("ActivityPanel renders one section per job: ds id, overall chip, checklist, dismiss on terminal", () => {
  const running = trackedJob({
    jobId: "j1",
    dsId: "shoot",
    status: jobStatus("started", {
      progress: progress([stage({ key: "thumbs", label: "Thumbnails", done: 10, total: 100, state: "running", t_start: 0 })]),
    }),
  });
  const finished = trackedJob({ jobId: "j2", dsId: "birds", status: jobStatus("finished") });
  const html = renderToString(h(ActivityPanel, { jobs: [running, finished], onDismiss: () => {} }));
  assert.match(html, /shoot/);
  assert.match(html, /birds/);
  assert.match(html, /status-chip status-processing/); // running ⇒ processing tone
  assert.match(html, /status-chip status-ready/); // finished ⇒ ready tone
  assert.match(html, /Thumbnails/); // the running job's checklist
  // Dismiss appears for the TERMINAL job only (a running job cannot be dismissed).
  const dismissCount = (html.match(/Dismiss/g) ?? []).length;
  assert.equal(dismissCount, 1, "exactly one Dismiss (the finished job)");
});

test("ActivityPanel: nameFor names the collection, keeping the id as the tooltip", () => {
  // Part D §2c: given a resolver, the panel shows the display name, not the raw id —
  // both the library and the viewer thread one. Identity (raw id) is the default, already
  // covered by the sections test above (dsId "shoot"/"birds" render verbatim there).
  const job = trackedJob({ jobId: "j1", dsId: "rijks_pilot", status: jobStatus("started") });
  const html = renderToString(
    h(ActivityPanel, {
      jobs: [job],
      onDismiss: () => {},
      nameFor: (dsId) => (dsId === "rijks_pilot" ? "Rijksmuseum Collection" : dsId),
    }),
  );
  assert.match(html, /Rijksmuseum Collection/); // the resolved name is shown
  assert.match(html, /title="rijks_pilot"/); // ...with the id preserved as the tooltip
});

test("ActivityPanel: a FAILED job shows the error + a log disclosure (closed)", () => {
  const failed = trackedJob({
    jobId: "j1",
    dsId: "ds",
    status: jobStatus("failed", { error: "boom at tiler", log_tail: ["l1", "l2"] }),
  });
  const html = renderToString(h(ActivityPanel, { jobs: [failed], onDismiss: () => {} }));
  assert.match(html, /boom at tiler/);
  assert.match(html, /▸ show log/);
  assert.ok(!/l1\nl2/.test(html), "log body hidden until the disclosure opens");
});

test("ActivityPanel: empty job list shows the calm empty copy", () => {
  const html = renderToString(h(ActivityPanel, { jobs: [], onDismiss: () => {} }));
  assert.match(html, /No active jobs/);
});

test("ActivityPanel: an unreachable job reads 'Unreachable' (error tone), dismissable, names the reason", () => {
  const gone = trackedJob({
    jobId: "j1",
    dsId: "vanished",
    pollError: "503 Service Unavailable",
    unreachable: true,
  });
  const html = renderToString(h(ActivityPanel, { jobs: [gone], onDismiss: () => {} }));
  assert.match(html, /vanished/);
  assert.match(html, /Unreachable/); // its own chip label (not the false "Queued")
  assert.match(html, /status-chip status-error/); // error tone
  assert.match(html, /Gave up polling: 503 Service Unavailable/);
  assert.match(html, /Could not reach this job/);
  assert.equal((html.match(/Dismiss/g) ?? []).length, 1, "an unreachable job can be dismissed");
});

test("StageChecklist: the aria-live region announces the coarse stage (transition-stable), not the live count", () => {
  const p = progress([stage({ key: "thumbs", label: "Thumbnails", done: 25, total: 100, state: "running", t_start: 1000 })]);
  // The announcement is the running stage LABEL only — no live count/ETA — so a screen
  // reader hears it once per stage, not on every count tick.
  assert.equal(currentStatusAnnouncement(p), "Thumbnails — in progress");
  // The VISIBLE line still carries the live detail sighted users read.
  assert.match(currentStatusLine(p, (1000 + 40) * SEC), /25 \/ 100 images/);
  // Rendered: the coarse announcement lives in the visually-hidden aria-live region.
  const html = renderToString(h(StageChecklist, { progress: p, now: (1000 + 40) * SEC }));
  assert.match(html, /class="sr-only"[^>]*aria-live="polite"/);
  assert.match(html, /Thumbnails — in progress/);
});

// --- JobProgressView: real progress path vs the pre-progress fallback --------

test("JobProgressView renders the shared checklist when JobStatus.progress is present", () => {
  const status = jobStatus("started", {
    progress: progress([stage({ key: "thumbs", label: "Thumbnails", done: 40, total: 100, state: "running", t_start: 0 })]),
  });
  const html = renderToString(h(JobProgressView, { jobId: "j1", status, pollError: null }));
  assert.match(html, /Processing…/); // overall state label kept
  assert.match(html, /Thumbnails/); // the real stage checklist
  assert.match(html, /progress-fill/);
  assert.match(html, /width:40%/);
  // The pre-progress fallback copy is gone once real stages arrive.
  assert.ok(!/keeps running; the Library shows live status/.test(html), "wait-copy superseded by real progress");
});

test("JobProgressView keeps the indeterminate fallback + wait copy when progress is absent (pre-O1)", () => {
  const status = jobStatus("started"); // no progress
  const html = renderToString(h(JobProgressView, { jobId: "j1", status, pollError: null, imageCount: 94 }));
  assert.match(html, /progress-indeterminate/);
  assert.match(html, /94 images detected/);
  assert.ok(!/stage-checklist/.test(html), "no checklist without a progress payload");
});
