// DOM tier (Seam O3): the ActivityProvider's top-level poller + the pill + the panel,
// end-to-end under jsdom AND React 18 StrictMode (the same double-invoke that poisoned
// the old ref-based poll guard — jobPoll.createUnmountGuard). A fake ApiClient emits
// progressive JobStatus.progress payloads; the test drives register → pill → open panel
// → the real StageChecklist → the job reaching `finished`, plus the adopt-from-
// listDatasets rediscovery path. localStorage is cleared between tests (jsdom shares it).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, StrictMode, useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { DatasetSummary, JobProgress, JobStatus } from "../../src/api-client/types.ts";
import { ActivityProvider, useActivity } from "../../src/ui/activity/activityContext.ts";
import { ActivityPill } from "../../src/ui/activity/ActivityPill.ts";

afterEach(() => {
  cleanup();
  localStorage.clear(); // jsdom persists localStorage across tests — reset the tracked set
});

const runningProgress: JobProgress = {
  progress_version: 1,
  spec_layouts: ["grid"],
  image_count: 100,
  current: "thumbs",
  stages: [
    { key: "prepare", label: "Prepare", unit: null, done: 0, total: null, state: "done", t_start: 0, t_end: 5 },
    { key: "thumbs", label: "Thumbnails", unit: "images", done: 40, total: 100, state: "running", t_start: 10 },
    { key: "layout:grid", label: "grid", unit: "tiles", done: 0, total: null, state: "queued" },
  ],
};
const doneProgress: JobProgress = {
  progress_version: 1,
  spec_layouts: ["grid"],
  image_count: 100,
  current: null,
  stages: [
    { key: "prepare", label: "Prepare", unit: null, done: 0, total: null, state: "done", t_start: 0, t_end: 5 },
    { key: "thumbs", label: "Thumbnails", unit: "images", done: 100, total: 100, state: "done", t_start: 10, t_end: 60 },
    { key: "layout:grid", label: "grid", unit: "tiles", done: 400, total: 400, state: "done", t_start: 60, t_end: 120 },
  ],
};

/** getJob answers "started" (with a running checklist) until the test flips `finish()`,
 *  then "finished". A FLAG (not a call counter) so StrictMode's double-invoke — which
 *  fires two quick polls at mount — cannot race the observable "1 job" → "Done"
 *  transition the test asserts. */
function progressiveClient(): { client: ApiClient; finish: () => void } {
  let finished = false;
  const client = {
    async getJob(jobId: string): Promise<JobStatus> {
      return {
        job_id: jobId,
        state: finished ? "finished" : "started",
        dataset_id: "ds1",
        log_tail: [`ingest: ${finished ? "finished" : "started"}`],
        error: null,
        progress: finished ? doneProgress : runningProgress,
      };
    },
  } as unknown as ApiClient;
  return {
    client,
    finish: () => {
      finished = true;
    },
  };
}

function RegisterHarness(): ReturnType<typeof ActivityPill> {
  const { register } = useActivity();
  useEffect(() => register("ds1", "j1"), [register]);
  return h(ActivityPill, {});
}

test("register → pill → open panel → real checklist → reaches finished under StrictMode", { timeout: 20_000 }, async () => {
  const { client, finish } = progressiveClient();
  render(
    // ★ StrictMode forces the mount-effect double-invoke — the poll manager must not
    // leak or wedge (jobPoll.createUnmountGuard's guarantee, exercised at the provider).
    h(StrictMode, null, h(ActivityProvider, { client }, h(RegisterHarness))),
  );

  // The pill appears the moment the job registers (status unknown-yet ⇒ running ⇒ "1 job").
  const pill = await screen.findByRole("button", { name: /Activity: 1 job/ });
  fireEvent.click(pill);

  // The panel opens on the dataset id; once the first poll lands, the REAL checklist
  // (determinate Thumbnails bar) replaces the "waiting" copy.
  await screen.findByText("ds1");
  await screen.findByText("Thumbnails", undefined, { timeout: 15_000 });

  // Flip the job to finished — the poller (still live under StrictMode, past its first
  // non-terminal ticks) picks it up and the pill flips to "Done" (the freeze the
  // createUnmountGuard prevents would leave it stuck on the running "1 job" state).
  finish();
  await screen.findByRole("button", { name: /Activity: Done/ }, { timeout: 15_000 });
});

test("Escape and an outside pointerdown each dismiss the open panel (popover a11y)", async () => {
  const { client } = progressiveClient();
  render(h(StrictMode, null, h(ActivityProvider, { client }, h(RegisterHarness))));

  const pill = await screen.findByRole("button", { name: /Activity: 1 job/ });

  // Open, then Escape closes it AND returns focus to the pill (not <body>).
  fireEvent.click(pill);
  await screen.findByText("ds1");
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(screen.queryByText("ds1"), null, "Escape closes the panel");
  assert.equal(document.activeElement, pill, "Escape returns focus to the pill");

  // Reopen, then a pointerdown OUTSIDE the pill+panel closes it.
  fireEvent.click(pill);
  await screen.findByText("ds1");
  fireEvent.pointerDown(document.body);
  assert.equal(screen.queryByText("ds1"), null, "an outside click closes the panel");
});

function readyWithJob(activeJobId: string): DatasetSummary {
  return {
    dataset_id: "reingesting",
    dataset_version: 2,
    image_count: 500,
    ingest_timestamp: "2026-07-13T00:00:00Z",
    layout_ids: ["grid"],
    owner: "ada",
    status: "ready",
    active_job_id: activeJobId,
  };
}

function AdoptHarness(): ReturnType<typeof ActivityPill> {
  const { adopt } = useActivity();
  useEffect(() => adopt([readyWithJob("j-adopted")]), [adopt]);
  return h(ActivityPill, {});
}

test("adopt(listDatasets) surfaces a ready-with-active-job dataset in the pill", { timeout: 20_000 }, async () => {
  // getJob stays "started" so the adopted job reads as running (the pill shows a count).
  const client = {
    async getJob(jobId: string): Promise<JobStatus> {
      return { job_id: jobId, state: "started", dataset_id: "reingesting", log_tail: [], error: null };
    },
  } as unknown as ApiClient;

  render(h(StrictMode, null, h(ActivityProvider, { client }, h(AdoptHarness))));

  // The re-bake of a "ready" dataset is now visible — the ready-while-baking blind spot,
  // closed via active_job_id adoption.
  const pill = await screen.findByRole("button", { name: /Activity: 1 job/ });
  fireEvent.click(pill);
  await screen.findByText("reingesting");
});
