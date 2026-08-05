// The activity store (Seam O3): the pure, framework-free core of the global
// ingest/add-layouts job tracker. A reducer over an immutable ActivityState plus
// selectors and localStorage (de)serialization — no React, no timers, no DOM — so
// the multi-job lifecycle, list-adoption, persistence, and dismiss behaviour are all
// unit-tested directly. The React provider (activityContext.ts) wraps this with
// useReducer + the poller.
//
// Node-test importable (type-only src imports).
import type { DatasetSummary, JobStatus } from "../../api-client/types";
import { TERMINAL_JOB_STATES } from "../admin/jobPoll.ts";

/** One tracked job. `status` is null until its first poll answers; `pollError` notes a
 *  transport blip WITHOUT dropping the job (it stays visible with its last-known state);
 *  `unreachable` is set once the poller GIVES UP after repeated non-404 transport
 *  failures — the job then stops polling and no longer counts as active, but lingers
 *  (dismissable) rather than spinning a phantom "running" pill forever. */
export interface TrackedJob {
  jobId: string;
  dsId: string;
  status: JobStatus | null;
  pollError: string | null;
  unreachable: boolean;
}

export interface ActivityState {
  /** Insertion-ordered; the panel and pill read this directly. */
  jobs: TrackedJob[];
}

export const EMPTY_ACTIVITY_STATE: ActivityState = { jobs: [] };

export type ActivityAction =
  // A wizard registers the job it just enqueued (dsId + jobId), the moment of submit.
  | { type: "register"; dsId: string; jobId: string }
  // Adopt any active_job_id surfaced by a listDatasets refresh (the ready-while-baking
  // rediscovery — gap #3 in the spike). Idempotent: already-tracked ids are ignored.
  | { type: "adopt"; datasets: DatasetSummary[] }
  // A poll answered: replace the job's status (and clear any prior pollError).
  | { type: "update"; jobId: string; status: JobStatus }
  // A poll hit a transport error: note it, keep the job listed with its last status.
  | { type: "pollError"; jobId: string; message: string }
  // The poller gave up after repeated non-404 failures: park the job as unreachable
  // (stops polling + counting active), keeping the last error message for the panel.
  | { type: "unreachable"; jobId: string; message: string }
  // Drop a job: the user dismissed a terminal one, OR its record is gone (getJob 404).
  | { type: "remove"; jobId: string }
  // Rehydrate the tracked set from localStorage on mount (status re-polled fresh).
  | { type: "restore"; jobs: { jobId: string; dsId: string }[] };

function upsertPlaceholder(jobs: TrackedJob[], jobId: string, dsId: string): TrackedJob[] {
  const existing = jobs.find((j) => j.jobId === jobId);
  if (existing !== undefined) {
    // Re-surfacing a job the poller had GIVEN UP on (parked `unreachable`) means the
    // caller just saw it live again — a still-succeeding listDatasets keeps listing its
    // active_job_id, or a wizard re-registered it — so the server is plainly reachable.
    // REVIVE it (clear `unreachable` + the stale give-up note) so it re-enters the poll
    // set; otherwise nothing ever re-polls a parked job and it would read "unreachable"
    // forever despite the app reaching the server on every refresh.
    const revive = existing.unreachable;
    const dsChanged = existing.dsId !== dsId;
    // Already tracked with nothing to change ⇒ return the SAME array (so a no-op adopt
    // yields the same state reference and the provider skips a re-render).
    if (!revive && !dsChanged) return jobs;
    return jobs.map((j) =>
      j.jobId === jobId
        ? revive
          ? { ...j, dsId, pollError: null, unreachable: false }
          : { ...j, dsId }
        : j,
    );
  }
  return [...jobs, { jobId, dsId, status: null, pollError: null, unreachable: false }];
}

/** Pure reducer (spike §5). No side effects — the provider owns persistence + polling. */
export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  switch (action.type) {
    case "register":
      return { jobs: upsertPlaceholder(state.jobs, action.jobId, action.dsId) };
    case "adopt": {
      let jobs = state.jobs;
      for (const ds of action.datasets) {
        const jobId = ds.active_job_id;
        if (jobId === null || jobId === undefined || jobId === "") continue;
        jobs = upsertPlaceholder(jobs, jobId, ds.dataset_id);
      }
      return jobs === state.jobs ? state : { jobs };
    }
    case "update":
      return {
        jobs: state.jobs.map((j) =>
          // A poll landed ⇒ the job is reachable again: refresh status, clear any
          // prior blip note, and lift a stale `unreachable` flag.
          j.jobId === action.jobId
            ? { ...j, status: action.status, pollError: null, unreachable: false }
            : j,
        ),
      };
    case "pollError":
      return {
        jobs: state.jobs.map((j) =>
          j.jobId === action.jobId ? { ...j, pollError: action.message } : j,
        ),
      };
    case "unreachable":
      return {
        jobs: state.jobs.map((j) =>
          j.jobId === action.jobId ? { ...j, pollError: action.message, unreachable: true } : j,
        ),
      };
    case "remove":
      return { jobs: state.jobs.filter((j) => j.jobId !== action.jobId) };
    case "restore": {
      // Rehydrate as placeholders; a genuine subsequent poll fills status. De-duped by
      // jobId, preserving the persisted order.
      const seen = new Set<string>();
      const jobs: TrackedJob[] = [];
      for (const { jobId, dsId } of action.jobs) {
        if (jobId === "" || seen.has(jobId)) continue;
        seen.add(jobId);
        jobs.push({ jobId, dsId, status: null, pollError: null, unreachable: false });
      }
      return { jobs };
    }
    default:
      return state;
  }
}

// ---- selectors (pure) ------------------------------------------------------

/** A tracked job is "running" (counts toward the pill, keeps polling) when its status
 *  is not yet known OR its RQ state is non-terminal. Terminal jobs — and jobs the poller
 *  gave up on (`unreachable`) — linger (until dismissed) but no longer poll and no longer
 *  count as active. */
export function isJobRunning(job: TrackedJob): boolean {
  if (job.unreachable) return false; // gave up after repeated transport failures
  if (job.status === null) return true; // unknown-yet ⇒ assume active until a poll says otherwise
  return !TERMINAL_JOB_STATES.has(job.status.state);
}

/** A tracked job whose RQ state is `failed`. */
export function isJobFailed(job: TrackedJob): boolean {
  return job.status !== null && job.status.state === "failed";
}

/** A tracked job the poller gave up on (repeated non-404 transport failures). It is
 *  NOT a job failure — the bake may still be running on the server — just unreachable
 *  from this client, so it reads with an error tone but its own "unreachable" label. */
export function isJobUnreachable(job: TrackedJob): boolean {
  return job.unreachable;
}

/** The jobs that still need polling (running set). */
export function runningJobs(state: ActivityState): TrackedJob[] {
  return state.jobs.filter(isJobRunning);
}

export interface PillSummary {
  /** Chip text, e.g. "2 jobs" while running, "1 failed", "1 unreachable", "Done", or
   *  "Ended" (a stopped/canceled job that did not fail). */
  text: string;
  /** Any job still running → the pill pulses its accent dot. */
  running: boolean;
  /** A terminal `failed` job, or one the poller gave up on (`unreachable`) → error tone. */
  failed: boolean;
}

/** The pill's label + tone, or null when the pill is HIDDEN (nothing tracked —
 *  "zero-and-nothing-to-dismiss"). While anything runs it shows the running count; once
 *  everything is terminal it lingers until dismissed: "N failed" / "N unreachable" (err
 *  tone) when something went wrong, "Done" only when every job finished cleanly, else
 *  "Ended" (a benign stopped/canceled job — not a success to claim, not an error to
 *  alarm). Pure + exported for unit tests. */
export function pillSummary(state: ActivityState): PillSummary | null {
  if (state.jobs.length === 0) return null;
  const running = state.jobs.filter(isJobRunning).length;
  if (running > 0) {
    return { text: `${running} job${running === 1 ? "" : "s"}`, running: true, failed: false };
  }
  const failed = state.jobs.filter(isJobFailed).length;
  const unreachable = state.jobs.filter(isJobUnreachable).length;
  if (failed > 0 || unreachable > 0) {
    // A single count keeps the small pill legible; the panel breaks down the rest.
    const text = failed > 0 ? `${failed} failed` : `${unreachable} unreachable`;
    return { text, running: false, failed: true };
  }
  // No failures and nothing unreachable: "Done" only if EVERY job finished cleanly;
  // a stopped/canceled job is neither a success nor a failure (was mislabeled "Done").
  if (state.jobs.every((j) => j.status !== null && j.status.state === "finished")) {
    return { text: "Done", running: false, failed: false };
  }
  return { text: "Ended", running: false, failed: false };
}

// ---- localStorage persistence ---------------------------------------------

/** localStorage key for the tracked-set. A refresh reattaches these ids and the poller
 *  resumes their live state — the resume affordance the wizard alone lacks. Only IDENTITY
 *  is persisted (jobId + dsId); status is always re-polled fresh so a stale
 *  finished/failed snapshot is never trusted.
 *
 *  Phase-1 scoping caveat: this key is browser-GLOBAL, not per-user (like the token/
 *  username keys it sits beside in App.tsx). Job reads are owner-open today
 *  (`api/routers/jobs.py`, the same forward-pointer that flags per-user visibility), so a
 *  fresh login/logout CLEARS it (App.tsx) to stop a shared browser inheriting the prior
 *  session's jobs; a page refresh never runs those handlers, so resume-after-refresh is
 *  preserved. Namespacing the key per user (and enforcing it server-side) belongs to the
 *  Phase-2 visibility work. */
export const ACTIVITY_STORAGE_KEY = "plotlas.activity";

/** Serialize the tracked set to a JSON string for localStorage (identity only). */
export function serializeActivity(state: ActivityState): string {
  return JSON.stringify(state.jobs.map((j) => ({ jobId: j.jobId, dsId: j.dsId })));
}

/** Parse a persisted tracked-set string into restore payload; [] on any malformed/absent
 *  input (never throws — a corrupt entry must not brick the shell). */
export function parseStoredActivity(raw: string | null): { jobId: string; dsId: string }[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: { jobId: string; dsId: string }[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const jobId = (entry as { jobId?: unknown }).jobId;
      const dsId = (entry as { dsId?: unknown }).dsId;
      if (typeof jobId === "string" && jobId !== "" && typeof dsId === "string") {
        out.push({ jobId, dsId });
      }
    }
    return out;
  } catch {
    return [];
  }
}
