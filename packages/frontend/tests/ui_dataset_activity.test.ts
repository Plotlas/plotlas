// Tier-1 (Seam O3 / T2-104): the shared active-job predicate that keeps the AdminScreen
// auto-refresh gate (hasActiveWork) and the DatasetList "updating" badge in lockstep.
// Pure + node-tier importable (type-only src imports), so it is pinned DIRECTLY here
// rather than only transitively through the DOM-tier hasActiveWork test — the empty-string
// guard and the status-independence are the whole point of extracting the predicate.
import assert from "node:assert/strict";
import test from "node:test";

import { hasActiveJob } from "../src/ui/admin/datasetActivity.ts";
import type { DatasetSummary } from "../src/api-client/types.ts";

const READY: DatasetSummary = {
  dataset_id: "shoot",
  dataset_version: 1,
  image_count: 10,
  ingest_timestamp: "2026-07-07T00:00:00Z",
  layout_ids: ["grid"],
  owner: "ada",
  status: "ready",
};

test("hasActiveJob: only a non-null, non-empty active_job_id counts (T2-104)", () => {
  assert.equal(hasActiveJob(READY), false, "absent active_job_id ⇒ no active job");
  assert.equal(hasActiveJob({ ...READY, active_job_id: null }), false, "null ⇒ no active job");
  assert.equal(hasActiveJob({ ...READY, active_job_id: "" }), false, "empty string ⇒ no active job");
  assert.equal(hasActiveJob({ ...READY, active_job_id: "job-1" }), true, "a real id ⇒ active");
  // Independent of the status literal: a re-baking "ready" dataset reads as active, and so
  // would a "processing" one — the badge/gate callers add their own status condition.
  assert.equal(hasActiveJob({ ...READY, status: "processing", active_job_id: "job-2" }), true);
});
