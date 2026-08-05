// Tier-1: pollJob's schedule (2s backing off ×1.5 to a 10s cap), terminal-stop
// behavior, and cancellation — with an injected sleep, so no real timers.
import assert from "node:assert/strict";
import test from "node:test";

import { TERMINAL_JOB_STATES, createUnmountGuard, pollJob } from "../src/ui/admin/jobPoll.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { JobStatus } from "../src/api-client/types.ts";

function jobClient(states: string[]): ApiClient {
  let i = 0;
  return {
    async getJob(jobId: string): Promise<JobStatus> {
      const state = states[Math.min(i, states.length - 1)];
      i += 1;
      return { job_id: jobId, state, dataset_id: "ds", log_tail: [`line for ${state}`] };
    },
  } as unknown as ApiClient;
}

test("polls until the terminal state, reporting every status", async () => {
  const sleeps: number[] = [];
  const updates: string[] = [];
  const last = await pollJob(jobClient(["queued", "started", "started", "finished"]), "j1", (s) => {
    updates.push(s.state);
  }, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(updates, ["queued", "started", "started", "finished"]);
  assert.equal(last.state, "finished");
  // 2s, then ×1.5 backoff; no sleep after the terminal poll.
  assert.deepEqual(sleeps, [2000, 3000, 4500]);
  assert.deepEqual(last.log_tail, ["line for finished"]);
});

test("backoff caps at 10s; failed is terminal too", async () => {
  const sleeps: number[] = [];
  const states = ["queued", ...Array.from({ length: 6 }, () => "started"), "failed"];
  const last = await pollJob(jobClient(states), "j1", () => {}, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(last.state, "failed");
  assert.deepEqual(sleeps, [2000, 3000, 4500, 6750, 10000, 10000, 10000]);
});

test("cancellation stops polling without a terminal state", async () => {
  let polls = 0;
  const client = {
    async getJob(): Promise<JobStatus> {
      polls += 1;
      return { job_id: "j1", state: "started", dataset_id: "ds", log_tail: [] };
    },
  } as unknown as ApiClient;
  let cancelled = false;
  const last = await pollJob(client, "j1", () => {}, {
    sleep: async () => {
      cancelled = true; // cancel during the first wait
    },
    isCancelled: () => cancelled,
  });
  assert.equal(polls, 1);
  assert.equal(last.state, "started");
});

test("terminal-state set matches RQ's end states", () => {
  for (const s of ["finished", "failed", "stopped", "canceled"]) {
    assert.ok(TERMINAL_JOB_STATES.has(s), s);
  }
  assert.ok(!TERMINAL_JOB_STATES.has("queued"));
  assert.ok(!TERMINAL_JOB_STATES.has("started"));
});

// ---- item 3: the fast-completion race (progress screen never reached "done") ----

test("transitions on a job already terminal on the FIRST poll (fast-completion path)", async () => {
  // A tiny bake (the operator's 94 images) can be `finished` by the first poll — the
  // poll must REPORT it and stop, not wait for a running→finished transition that
  // already happened. (pollJob checks the ABSOLUTE state each tick, so this holds.)
  const sleeps: number[] = [];
  const updates: string[] = [];
  const last = await pollJob(jobClient(["finished"]), "j1", (s) => updates.push(s.state), {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.deepEqual(updates, ["finished"]);
  assert.equal(last.state, "finished");
  assert.deepEqual(sleeps, [], "no wait before returning on an already-terminal first poll");
});

test("createUnmountGuard re-arms on setup so StrictMode's double-invoke can't wedge the poll", () => {
  // React 18 StrictMode (DEV) runs an effect setup→cleanup→setup at mount. A guard
  // that only cancelled on cleanup would be left stuck cancelled — making pollJob's
  // isCancelled() true from the first tick and freezing the progress screen (the
  // 94-image fast-completion freeze). onMount must re-arm on EVERY setup.
  const guard = createUnmountGuard();
  assert.equal(guard.isCancelled(), false, "armed at creation");
  const teardown1 = guard.onMount(); // initial mount setup
  teardown1(); //                       StrictMode simulated unmount
  assert.equal(guard.isCancelled(), true, "cancelled after teardown");
  const teardown2 = guard.onMount(); // StrictMode remount setup
  assert.equal(guard.isCancelled(), false, "re-armed on remount (NOT stuck cancelled)");
  teardown2(); //                       real unmount
  assert.equal(guard.isCancelled(), true, "cancelled on real unmount");
});

test("a guard stuck cancelled bails after one poll — the frozen-screen regression it prevents", async () => {
  // Model the OLD bug: a cancel flag stuck true from the start (StrictMode-poisoned).
  // pollJob then returns after ONE non-terminal poll and NEVER reaches terminal — the
  // exact freeze createUnmountGuard's re-arm prevents (the guard is armed in practice).
  const updates: string[] = [];
  const last = await pollJob(
    jobClient(["started", "started", "finished"]),
    "j1",
    (s) => updates.push(s.state),
    { sleep: async () => {}, isCancelled: () => true },
  );
  assert.deepEqual(updates, ["started"], "bails after the first poll when cancelled from the start");
  assert.ok(!TERMINAL_JOB_STATES.has(last.state), "never reaches terminal — the frozen-screen condition");
});
