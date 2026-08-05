// Tier-1 (Seam O3): the resilient single-job poll loop's give-up path (review finding
// 2). A 404 drops the job; a persistent non-404 transport error is retried then PARKED
// as `unreachable` after ACTIVITY_POLL_MAX_RETRIES *consecutive* failures (a successful
// poll resets the streak); a terminal state finishes cleanly. Both the retry backoff and
// pollJob's inter-poll wait are the injected no-op `sleep`, so the whole loop runs with
// no real timers.
import assert from "node:assert/strict";
import test from "node:test";

import { pollOneJob, ACTIVITY_POLL_MAX_RETRIES } from "../src/ui/activity/activityContext.ts";
import type { ActivityAction } from "../src/ui/activity/activityStore.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { JobStatus } from "../src/api-client/types.ts";

const NEVER_CANCELLED = (): boolean => false;
const NO_SLEEP = async (): Promise<void> => {};

function httpError(status: number): Error {
  // Structural ApiError (isApiError checks status:number + detail:string).
  return Object.assign(new Error(`API error ${status}`), { status, detail: `err ${status}` });
}
function jobStatus(state: string): JobStatus {
  return { job_id: "j1", state, dataset_id: "ds", log_tail: [], error: null };
}
/** A fake ApiClient whose getJob invokes `next()` (throw or return) each call. */
function clientFrom(next: () => JobStatus): ApiClient {
  return { async getJob(): Promise<JobStatus> { return next(); } } as unknown as ApiClient;
}

test("pollOneJob parks a job as unreachable after MAX_RETRIES consecutive non-404 errors", async () => {
  const actions: ActivityAction[] = [];
  const client = clientFrom(() => {
    throw httpError(503); // always unreachable, never a 404
  });
  await pollOneJob(client, "j1", (a) => actions.push(a), NEVER_CANCELLED, {
    sleep: NO_SLEEP,
    maxRetries: ACTIVITY_POLL_MAX_RETRIES,
  });
  const types = actions.map((a) => a.type);
  // (MAX_RETRIES - 1) pollError notes, then exactly one terminal `unreachable`, then stop.
  assert.equal(types.filter((t) => t === "pollError").length, ACTIVITY_POLL_MAX_RETRIES - 1);
  assert.equal(types.filter((t) => t === "unreachable").length, 1);
  assert.equal(types.at(-1), "unreachable");
  const last = actions.at(-1);
  assert.ok(last?.type === "unreachable" && last.message === "err 503", "parks with the last error");
});

test("pollOneJob drops a job immediately on a 404 (record gone) — never marks it unreachable", async () => {
  const actions: ActivityAction[] = [];
  const client = clientFrom(() => {
    throw httpError(404);
  });
  await pollOneJob(client, "j1", (a) => actions.push(a), NEVER_CANCELLED, { sleep: NO_SLEEP });
  assert.deepEqual(actions.map((a) => a.type), ["remove"]);
});

test("pollOneJob finishes cleanly when the job reaches a terminal state (no error, no give-up)", async () => {
  const actions: ActivityAction[] = [];
  const client = clientFrom(() => jobStatus("finished"));
  await pollOneJob(client, "j1", (a) => actions.push(a), NEVER_CANCELLED, { sleep: NO_SLEEP });
  assert.deepEqual(actions.map((a) => a.type), ["update"]);
});

test("pollOneJob resets the failure streak after a successful poll (a blip mid-run does not accumulate)", async () => {
  // maxRetries = 2. Sequence: 503, then a NON-terminal success (resets the streak), then
  // 503, 503 → give-up. WITHOUT the reset, the 2nd overall failure would give up one
  // step sooner (1 pollError); WITH it, the success restarts the count (2 pollErrors).
  const actions: ActivityAction[] = [];
  let i = 0;
  const client = clientFrom(() => {
    i += 1;
    if (i === 2) return jobStatus("started"); // reachable again on the 2nd call
    throw httpError(503);
  });
  await pollOneJob(client, "j1", (a) => actions.push(a), NEVER_CANCELLED, {
    sleep: NO_SLEEP,
    maxRetries: 2,
  });
  const types = actions.map((a) => a.type);
  assert.equal(types.filter((t) => t === "pollError").length, 2, "streak reset by the success");
  assert.ok(types.includes("update"), "the successful poll was recorded");
  assert.equal(types.at(-1), "unreachable", "gives up only after 2 fresh failures");
});
