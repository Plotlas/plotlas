// DOM tier (T2-93 Seam 1) — container test: AdminScreen's effect-driven list
// fetch + the Library→New-dataset view toggle. Exercises the useEffect that
// calls listDatasets on mount (the "loading… then list" state machine) and the
// tab switch that swaps DatasetList for CreateDatasetWizard — behaviour the pure
// renderToString smokes cannot see (effects never fire there).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { DatasetSummary } from "../../src/api-client/types.ts";
import { AdminScreen, hasActiveWork } from "../../src/ui/admin/AdminScreen.ts";
import { ActivityProvider } from "../../src/ui/activity/activityContext.ts";
import { ACTIVITY_STORAGE_KEY } from "../../src/ui/activity/activityStore.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const READY: DatasetSummary = {
  dataset_id: "shoot",
  dataset_version: 1,
  image_count: 10,
  ingest_timestamp: "2026-07-07T00:00:00Z",
  layout_ids: ["grid"],
  owner: "ada",
  status: "ready",
};

test("AdminScreen fetches the list on mount, then toggles to the create wizard", async () => {
  // The ready card fetches a cover via global fetch (T2-55) — answer 404 so it
  // falls back to the flat block instead of hitting the network.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

  const client = {
    async listDatasets(): Promise<DatasetSummary[]> {
      return [READY];
    },
    coverUrl(dsId: string): string {
      return `/api/datasets/${dsId}/cover`;
    },
    authHeaders(): Record<string, string> {
      return {};
    },
  } as unknown as ApiClient;

  render(
    h(AdminScreen, {
      client,
      username: "ada",
      onOpenDataset: () => {},
      onAuthExpired: () => {},
      onLogout: () => {},
      onLogin: () => {}, // anonymous public entry (D-34 consumer): required prop, unused when authed
    }),
  );

  // The mount effect resolves listDatasets → the count line flips 0 → 1.
  await screen.findByText("1 dataset");
  assert.ok(screen.getByRole("heading", { name: "Library" }), "Library heading renders");

  // Toggle to the create wizard; the header retitles and the wizard mounts.
  fireEvent.click(screen.getByRole("button", { name: "+ New dataset" }));
  await screen.findByRole("heading", { name: "New dataset" });
  await screen.findByRole("button", { name: "Upload & create" });
});

// R1: the ready-while-baking refresh gate. A pure-function test (not the live 5s
// interval, which is a real-timer hang risk in the runner) — it precisely pins the fix:
// active_job_id, not just status==="processing", keeps the list auto-refreshing so the
// "updating" badge (rendered from active_job_id — see ui_dataset_list) clears when the
// server stops reporting the job. It lives here because AdminScreen's transitive value
// imports are extensionless (DOM-shim only), so it cannot be imported at the node tier.
test("R1: hasActiveWork keeps the list refreshing during ready-while-baking (active_job_id)", () => {
  const ready: DatasetSummary = { ...READY };
  const readyBaking: DatasetSummary = { ...READY, active_job_id: "job-1" };
  const processing: DatasetSummary = { ...READY, status: "processing", active_job_id: null };
  assert.equal(hasActiveWork(null), false, "no datasets ⇒ no refresh");
  assert.equal(hasActiveWork([]), false);
  assert.equal(hasActiveWork([ready]), false, "a calm ready dataset needs no refresh");
  assert.equal(hasActiveWork([readyBaking]), true, "ready + active_job_id ⇒ keep refreshing (T2-104)");
  assert.equal(hasActiveWork([processing]), true, "a first bake still refreshes");
  assert.equal(hasActiveWork([{ ...READY, active_job_id: "" }]), false, "empty string is not an active job");
});

// D-xxviii (seam L3, from review): the activity panel names a job's collection through the
// SAME rule as every other surface. The job is for a collection the web intake created a
// moment ago — a minted id — and the list this screen loaded does not carry it yet (the
// create lands between two re-lists). The fallback used to be the raw id: twelve hex
// characters as a name.
test("the activity panel names a job for an unlisted MINTED collection “Untitled collection”", async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const MINTED = "3f9c2a71e0b4";
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify([{ jobId: "j1", dsId: MINTED }]));
  const client = {
    async listDatasets(): Promise<DatasetSummary[]> {
      return [READY]; // not the new collection
    },
    async getJob(jobId: string) {
      // A running ingest, as the job route serves it (no progress written yet).
      return { job_id: jobId, state: "started", dataset_id: MINTED, log_tail: [], error: null, progress: null };
    },
    coverUrl: (dsId: string) => `/api/datasets/${dsId}/cover`,
    authHeaders: () => ({}),
  } as unknown as ApiClient;
  try {
    render(
      h(
        ActivityProvider,
        { client },
        h(AdminScreen, {
          client,
          username: "ada",
          onOpenDataset: () => {},
          onEditDataset: () => {},
          onAuthExpired: () => {},
          onLogout: () => {},
          onLogin: () => {},
        }),
      ),
    );
    await screen.findByText("1 dataset");
    fireEvent.click(await screen.findByRole("button", { name: /^Activity:/ }));
    assert.ok(await screen.findByText("Untitled collection"));
    assert.equal(screen.queryAllByText(MINTED).length, 0, "the minted id is not shown as a name");
  } finally {
    localStorage.removeItem(ACTIVITY_STORAGE_KEY);
  }
});
