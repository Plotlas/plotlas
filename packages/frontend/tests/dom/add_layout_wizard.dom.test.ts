// DOM tier (T2-92 Seam 1) — the AddLayoutWizard end to end in jsdom: it loads the
// dataset's stored column_roles from the manifest, PRE-FILLS the reused
// RoleAssignmentForm, gates the offered layouts on the roles (already-baked shown
// disabled vs new as a checkbox), and submits ONLY the new expanded layout_id with the
// compiled column_roles override. Runs under jsdom via
//   node --import global-jsdom/register --import ./tests/dom/ts-extension-resolver.mjs …
// (the test:dom script). The wizard is a createElement .ts component, so react-dom +
// @testing-library/react drive it with no bundler/JSX transform.
//
// Rendered under <StrictMode> (the mount-effect double-invoke that poisoned the #133 ref
// guard — the wizard reuses jobPoll.createUnmountGuard, which survives it). This is the
// stateful-container class the pure renderToString smokes cannot see (effects, the
// manifest fetch, the role→gating→submit→poll state machine).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type {
  AddLayoutsRequest,
  AddLayoutsResponse,
  DatasetSummary,
  JobStatus,
} from "../../src/api-client/types.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import { AddLayoutWizard } from "../../src/ui/admin/AddLayoutWizard.ts";

afterEach(() => cleanup());

// A dataset with grid + datetime already baked. `categorical` (from the stored kingdom
// column) is producible but NOT yet baked → the wizard must offer it as NEW.
const DATASET: DatasetSummary = {
  dataset_id: "shoot",
  dataset_version: 3,
  image_count: 120,
  ingest_timestamp: "2026-07-08T00:00:00Z",
  layout_ids: ["grid", "datetime"],
  owner: "ada",
  status: "ready",
};

/** Stored roles the manifest embeds (D-16): filename + a datetime (already baked) + a
 *  categorical column (kingdom — stored but NOT baked into a layout) + a freeform column
 *  (habitat). The wizard seeds its role draft from exactly this. */
function manifest(dsId: string): LayoutManifest {
  return {
    manifest_version: "2.0",
    dataset_id: dsId,
    dataset_version: 3,
    layouts: [],
    column_roles: {
      filename: { column: "file", label: "Filename" },
      datetime: { column: "shot_date", label: "shot_date", format: "iso8601" },
      categorical: [{ column: "kingdom", label: "kingdom" }],
      freeform: [{ column: "habitat", label: "habitat" }],
    },
    dataset_metadata: { image_count: 120, ingest_timestamp: "2026-07-08T00:00:00Z" },
  };
}

/** A mock ApiClient exposing only the methods the wizard's load→submit→poll path calls.
 *  getJob answers a terminal "finished" (the poll-continuation regression is guarded by
 *  wizard_progress.dom.test.ts; here the concern is the roles+gating+wire). */
function wizardClient(): { client: ApiClient; addLayoutsCalls: () => AddLayoutsRequest[] } {
  const calls: AddLayoutsRequest[] = [];
  const client = {
    async getManifest(dsId: string): Promise<LayoutManifest> {
      return manifest(dsId);
    },
    async addLayouts(_dsId: string, req: AddLayoutsRequest): Promise<AddLayoutsResponse> {
      calls.push(req);
      return { job_id: "job-al" };
    },
    async getJob(jobId: string): Promise<JobStatus> {
      return { job_id: jobId, state: "finished", dataset_id: "shoot", log_tail: ["add-layouts: finished"], error: null };
    },
  } as unknown as ApiClient;
  return { client, addLayoutsCalls: () => calls };
}

test("AddLayoutWizard pre-fills the role form from the manifest and gates layouts on the roles", async () => {
  const { client } = wizardClient();
  render(
    h(
      StrictMode,
      null,
      h(AddLayoutWizard, { client, dataset: DATASET, onDone: () => {}, onAuthExpired: () => {} }),
    ),
  );

  // The manifest resolves → the role table renders, its per-column dropdowns PRE-FILLED
  // from the stored roles (rolesDraftFromColumnRoles).
  const shotDate = (await screen.findByLabelText("Role for column shot_date")) as HTMLSelectElement;
  assert.equal(shotDate.value, "datetime");
  assert.equal((screen.getByLabelText("Role for column kingdom") as HTMLSelectElement).value, "categorical");
  assert.equal((screen.getByLabelText("Role for column habitat") as HTMLSelectElement).value, "freeform");
  assert.equal((screen.getByLabelText("Role for column file") as HTMLSelectElement).value, "filename");

  // Layout gating (Step 2): the baked datetime is shown as existing (disabled); the
  // producible-but-unbaked categorical is offered as new.
  assert.ok(screen.getByText("datetime · already baked"), "the baked datetime layout is shown as existing");
  assert.ok(screen.getByText("categorical · new"), "the producible categorical layout is offered as new");
});

test("AddLayoutWizard submits ONLY the new layout_id + the role override, then reaches done", async () => {
  const { client, addLayoutsCalls } = wizardClient();
  render(
    h(
      StrictMode,
      null,
      h(AddLayoutWizard, { client, dataset: DATASET, onDone: () => {}, onAuthExpired: () => {} }),
    ),
  );

  await screen.findByText("categorical · new");

  // Add is disabled until a new layout is ticked.
  assert.ok(
    (screen.getByRole("button", { name: "Add layouts" }) as HTMLButtonElement).disabled,
    "the submit is disabled with nothing selected",
  );

  // Only the NEW categorical checkbox is enabled (the already-baked datetime one is
  // disabled). Tick it, then submit. NB the role form now also renders per-column
  // "render as link" toggles (schema v2.8) — those are checkboxes too, so scope this to the
  // LAYOUT-selection checkboxes (exclude the link toggles) to keep the assertion meaningful.
  const enabled = screen
    .getAllByRole("checkbox")
    .filter((cb) => !(cb as HTMLInputElement).disabled)
    .filter((cb) => !(cb.getAttribute("aria-label") ?? "").startsWith("Render column "));
  assert.equal(enabled.length, 1, "only the new layout is tickable");
  fireEvent.click(enabled[0]);

  fireEvent.click(await screen.findByRole("button", { name: "Add 1 layout" }));

  // Reaches the done screen, and the enqueue carried EXACTLY the expanded new id (not the
  // bare type — that would collision-error on the baked family) plus the role override.
  await screen.findByText(/Finished — the dataset is ready\./);
  const calls = addLayoutsCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].layout_specs, ["categorical"]);
  assert.ok(calls[0].column_roles, "the compiled role override is forwarded");
  assert.deepEqual(calls[0].column_roles?.categorical, [{ column: "kingdom", label: "kingdom" }]);
  await screen.findByRole("button", { name: "Back to Library" });
});
