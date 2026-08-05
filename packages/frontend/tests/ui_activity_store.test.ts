// Tier-1 (Seam O3): the activity store's pure reducer, selectors, and localStorage
// (de)serialization — the multi-job lifecycle, adopt-from-listDatasets, terminal→
// dismiss, and persist/restore, all with no React and no timers.
import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_ACTIVITY_STATE,
  activityReducer,
  isJobFailed,
  isJobRunning,
  isJobUnreachable,
  parseStoredActivity,
  pillSummary,
  runningJobs,
  serializeActivity,
} from "../src/ui/activity/activityStore.ts";
import type { ActivityState, TrackedJob } from "../src/ui/activity/activityStore.ts";
import type { DatasetSummary, JobStatus } from "../src/api-client/types.ts";

function jobStatus(jobId: string, state: string, extra: Partial<JobStatus> = {}): JobStatus {
  return { job_id: jobId, state, dataset_id: "ds", log_tail: [], error: null, ...extra };
}

/** A TrackedJob with sensible defaults (status null, no error, reachable). */
function job(over: Partial<TrackedJob> & { jobId: string; dsId: string }): TrackedJob {
  return { status: null, pollError: null, unreachable: false, ...over };
}

function summary(
  id: string,
  status: DatasetSummary["status"],
  activeJobId: string | null = null,
): DatasetSummary {
  return {
    dataset_id: id,
    dataset_version: status === "ready" ? 1 : 0,
    image_count: 0,
    ingest_timestamp: "2026-07-13T00:00:00Z",
    layout_ids: status === "ready" ? ["grid"] : [],
    owner: "ada",
    status,
    active_job_id: activeJobId,
  };
}

test("register adds a placeholder job, and is idempotent on the same jobId (refreshing dsId)", () => {
  let state = activityReducer(EMPTY_ACTIVITY_STATE, { type: "register", dsId: "ds1", jobId: "j1" });
  assert.equal(state.jobs.length, 1);
  assert.deepEqual({ jobId: state.jobs[0].jobId, dsId: state.jobs[0].dsId, status: state.jobs[0].status }, {
    jobId: "j1",
    dsId: "ds1",
    status: null,
  });
  // Re-registering the SAME job does not duplicate it; the dsId association refreshes.
  state = activityReducer(state, { type: "register", dsId: "ds1-renamed", jobId: "j1" });
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].dsId, "ds1-renamed");
});

test("adopt tracks each active_job_id from a listDatasets refresh, idempotently", () => {
  const datasets = [
    summary("a", "ready", "job-a"), // ready + active job ⇒ adopt
    summary("b", "ready", null), // ready, no job ⇒ ignore
    summary("c", "processing", null), // first-bake processing, no active_job_id ⇒ ignore
    summary("d", "ready", ""), // empty string ⇒ ignore (no job)
  ];
  let state = activityReducer(EMPTY_ACTIVITY_STATE, { type: "adopt", datasets });
  assert.deepEqual(state.jobs.map((j) => j.jobId), ["job-a"]);
  // Re-adopting the same list is a no-op AND returns the SAME state reference (so a
  // React provider bails out of re-rendering — the useReducer identity contract).
  const again = activityReducer(state, { type: "adopt", datasets });
  assert.equal(again, state, "no new job ⇒ same state reference");
  // A new active job on a later refresh is picked up.
  state = activityReducer(state, { type: "adopt", datasets: [summary("e", "ready", "job-e")] });
  assert.deepEqual(state.jobs.map((j) => j.jobId), ["job-a", "job-e"]);
});

test("update replaces a job's status and clears a prior pollError; pollError notes but keeps it", () => {
  let state = activityReducer(EMPTY_ACTIVITY_STATE, { type: "register", dsId: "ds", jobId: "j1" });
  state = activityReducer(state, { type: "pollError", jobId: "j1", message: "network down" });
  assert.equal(state.jobs[0].pollError, "network down");
  assert.equal(state.jobs[0].status, null, "the job stays listed through a transport blip");
  state = activityReducer(state, { type: "update", jobId: "j1", status: jobStatus("j1", "started") });
  assert.equal(state.jobs[0].status?.state, "started");
  assert.equal(state.jobs[0].pollError, null, "a successful poll clears the blip note");
});

test("terminal → dismiss: a finished job stays listed until removed", () => {
  let state = activityReducer(EMPTY_ACTIVITY_STATE, { type: "register", dsId: "ds", jobId: "j1" });
  state = activityReducer(state, { type: "update", jobId: "j1", status: jobStatus("j1", "finished") });
  assert.equal(state.jobs.length, 1, "a terminal job lingers (until dismissed)");
  assert.equal(isJobRunning(state.jobs[0]), false);
  state = activityReducer(state, { type: "remove", jobId: "j1" });
  assert.equal(state.jobs.length, 0, "dismiss removes it");
});

test("restore rehydrates placeholders from persisted identity, de-duped and ordered", () => {
  const state = activityReducer(EMPTY_ACTIVITY_STATE, {
    type: "restore",
    jobs: [
      { jobId: "j1", dsId: "a" },
      { jobId: "j2", dsId: "b" },
      { jobId: "j1", dsId: "a" }, // dupe dropped
      { jobId: "", dsId: "x" }, // empty id dropped
    ],
  });
  assert.deepEqual(state.jobs.map((j) => j.jobId), ["j1", "j2"]);
  assert.ok(state.jobs.every((j) => j.status === null), "restored jobs re-poll fresh (no stale status)");
});

test("isJobRunning / isJobFailed classify by RQ state (null = unknown-yet = active)", () => {
  assert.equal(isJobRunning(job({ jobId: "j", dsId: "d", status: null })), true);
  for (const s of ["queued", "started", "deferred"]) {
    assert.equal(isJobRunning(job({ jobId: "j", dsId: "d", status: jobStatus("j", s) })), true, s);
  }
  for (const s of ["finished", "failed", "stopped", "canceled"]) {
    assert.equal(isJobRunning(job({ jobId: "j", dsId: "d", status: jobStatus("j", s) })), false, s);
  }
  // An unreachable job (poller gave up) is NOT running even with an unknown status.
  assert.equal(isJobRunning(job({ jobId: "j", dsId: "d", status: null, unreachable: true })), false);
  assert.equal(isJobFailed(job({ jobId: "j", dsId: "d", status: jobStatus("j", "failed") })), true);
  assert.equal(isJobFailed(job({ jobId: "j", dsId: "d", status: jobStatus("j", "finished") })), false);
  assert.equal(isJobUnreachable(job({ jobId: "j", dsId: "d", unreachable: true })), true);
  assert.equal(isJobUnreachable(job({ jobId: "j", dsId: "d" })), false);
});

test("unreachable action parks a job: stops running/polling, keeps it listed with the reason", () => {
  let state = activityReducer(EMPTY_ACTIVITY_STATE, { type: "register", dsId: "ds", jobId: "j1" });
  state = activityReducer(state, { type: "unreachable", jobId: "j1", message: "network down" });
  assert.equal(state.jobs[0].unreachable, true);
  assert.equal(state.jobs[0].pollError, "network down");
  assert.equal(isJobRunning(state.jobs[0]), false, "unreachable ⇒ no longer polled/counted");
  assert.deepEqual(runningJobs(state).map((j) => j.jobId), [], "dropped from the poll set");
  // A later successful poll (e.g. the id membership changed and it got re-polled) clears it.
  state = activityReducer(state, { type: "update", jobId: "j1", status: jobStatus("j1", "started") });
  assert.equal(state.jobs[0].unreachable, false, "a poll landing lifts the unreachable flag");
  assert.equal(isJobRunning(state.jobs[0]), true);
});

test("adopt REVIVES a parked (unreachable) job when it resurfaces — connectivity is back", () => {
  // The poller gave up on j1 (repeated non-404 blips), parking it as unreachable.
  let state = activityReducer(EMPTY_ACTIVITY_STATE, { type: "register", dsId: "ds1", jobId: "j1" });
  state = activityReducer(state, { type: "unreachable", jobId: "j1", message: "503" });
  assert.deepEqual(runningJobs(state).map((j) => j.jobId), [], "parked ⇒ dropped from the poll set");
  // A later listDatasets STILL lists the dataset's active job — the server is reachable
  // again — so adopting it must revive the parked job so the poller re-attaches (otherwise
  // nothing ever re-polls it and it reads "unreachable" forever while the app is online).
  const revived = activityReducer(state, { type: "adopt", datasets: [summary("ds1", "ready", "j1")] });
  assert.notEqual(revived, state, "re-surfacing a parked job yields new state (not a no-op)");
  assert.equal(revived.jobs[0].unreachable, false, "unreachable cleared");
  assert.equal(revived.jobs[0].pollError, null, "stale give-up note cleared");
  assert.deepEqual(runningJobs(revived).map((j) => j.jobId), ["j1"], "back in the poll set");
  // A REACHABLE already-tracked job is still a no-op (the same-reference contract holds).
  const noop = activityReducer(revived, { type: "adopt", datasets: [summary("ds1", "ready", "j1")] });
  assert.equal(noop, revived, "reachable + same dsId ⇒ same state reference");
});

test("pillSummary drives the pill: hidden when empty, running count, then Done / failed", () => {
  assert.equal(pillSummary(EMPTY_ACTIVITY_STATE), null, "nothing tracked ⇒ pill hidden");

  const twoRunning: ActivityState = {
    jobs: [
      job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "started") }),
      job({ jobId: "j2", dsId: "b", status: null }), // unknown-yet counts as running
    ],
  };
  assert.deepEqual(pillSummary(twoRunning), { text: "2 jobs", running: true, failed: false });

  const oneRunning: ActivityState = { jobs: [twoRunning.jobs[0]] };
  assert.equal(pillSummary(oneRunning)?.text, "1 job", "singular");

  const allDone: ActivityState = {
    jobs: [job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "finished") })],
  };
  assert.deepEqual(pillSummary(allDone), { text: "Done", running: false, failed: false });

  const failed: ActivityState = {
    jobs: [job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "failed") })],
  };
  assert.deepEqual(pillSummary(failed), { text: "1 failed", running: false, failed: true });

  // A job we gave up polling → error tone, its own label (not the false "Done").
  const unreachable: ActivityState = {
    jobs: [job({ jobId: "j1", dsId: "a", status: null, unreachable: true })],
  };
  assert.deepEqual(pillSummary(unreachable), { text: "1 unreachable", running: false, failed: true });

  // A stopped/canceled job is neither success nor failure → neutral "Ended", NOT "Done".
  const stopped: ActivityState = {
    jobs: [job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "canceled") })],
  };
  assert.deepEqual(pillSummary(stopped), { text: "Ended", running: false, failed: false });

  // Failures take precedence over the softer categories in the single-count label.
  const mixed: ActivityState = {
    jobs: [
      job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "failed") }),
      job({ jobId: "j2", dsId: "b", status: null, unreachable: true }),
    ],
  };
  assert.deepEqual(pillSummary(mixed), { text: "1 failed", running: false, failed: true });
});

test("runningJobs returns only the still-active jobs (the poll set)", () => {
  const state: ActivityState = {
    jobs: [
      job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "started") }),
      job({ jobId: "j2", dsId: "b", status: jobStatus("j2", "finished") }),
      job({ jobId: "j3", dsId: "c", status: null }),
      job({ jobId: "j4", dsId: "d", status: null, unreachable: true }), // gave up ⇒ not polled
    ],
  };
  assert.deepEqual(runningJobs(state).map((j) => j.jobId), ["j1", "j3"]);
});

test("serialize / parseStored round-trips identity only; parseStored tolerates garbage", () => {
  const state: ActivityState = {
    jobs: [
      job({ jobId: "j1", dsId: "a", status: jobStatus("j1", "finished") }),
      job({ jobId: "j2", dsId: "b", status: null }),
    ],
  };
  const raw = serializeActivity(state);
  assert.deepEqual(parseStoredActivity(raw), [
    { jobId: "j1", dsId: "a" },
    { jobId: "j2", dsId: "b" },
  ]);
  // Robustness: null / non-array / malformed entries never throw, just yield [].
  assert.deepEqual(parseStoredActivity(null), []);
  assert.deepEqual(parseStoredActivity("not json"), []);
  assert.deepEqual(parseStoredActivity('{"nope":1}'), []);
  assert.deepEqual(parseStoredActivity('[{"jobId":123},{"jobId":"ok","dsId":"d"}]'), [
    { jobId: "ok", dsId: "d" },
  ]);
});
