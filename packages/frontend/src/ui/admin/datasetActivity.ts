// Derived "is this dataset being worked on?" predicates for the Library surface
// (Seam O3 / T2-104). The SINGLE source of truth for the non-empty `active_job_id`
// test, shared by the AdminScreen auto-refresh gate (`hasActiveWork`) and the
// DatasetList "updating" badge — so the two can never drift apart (a badge that
// shows but never auto-clears, or a refresh that runs with no badge to clear).
//
// Pure, node-test importable (type-only src imports).
import type { DatasetSummary } from "../../api-client/types";

/** True when a dataset carries an ACTIVE (queued|started) recorded job — a non-null,
 *  non-empty `active_job_id` (T2-104 / Seam O1). The status literal is UNCHANGED by an
 *  active job (a "ready" dataset stays "ready" while a re-bake runs), so this is the sole
 *  signal that a ready dataset is being updated. An empty string is treated as NO job (a
 *  defensive guard against a server that sends "" rather than null/absent). */
export function hasActiveJob(ds: DatasetSummary): boolean {
  return ds.active_job_id != null && ds.active_job_id !== "";
}
