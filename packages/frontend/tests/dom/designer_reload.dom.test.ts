// DOM tier — how the designer RELOADS (review of #368, findings 2 and 3).
//
// DesignerScreen polls while something is queued or baking, and re-reads everything when
// the dataset version moves (a bake committed). Two defects lived there:
//
//   2. every poll tick after a version bump started ANOTHER full load until one landed,
//      and overlapping loads could finish out of order — an older result overwriting a
//      newer one, including the manifest the pending draft is based on;
//   3. a reload that failed once the designer had loaded was never shown: the error
//      only rendered in the "nothing loaded yet" branch.
//
// The poll interval is shortened through the `refreshMs` prop, which exists for this.
// Everything else is the golden full fixture as the API serves it (designerDom.ts); the
// one production-shaped twist per test is named where it is made.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatasetSummary, JobStatus } from "../../src/api-client/types.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import { DesignerScreen } from "../../src/ui/designer/DesignerScreen.ts";
import { DS_ID, MANIFEST_29, OWNER, designerClient, summary } from "./designerDom.ts";
import type { DesignerRecorder } from "./designerDom.ts";

const POLL_MS = 25;

function clearStorage(): void {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
}
beforeEach(clearStorage);
afterEach(() => {
  cleanup();
  clearStorage();
});

function mount(rec: DesignerRecorder): void {
  // These datasets declare an active job (`active_job_id`), and since seam L5 the designer
  // follows the collection's job on every tab (JobFollower), so the fake answers for it as
  // the API would: the job is running.
  const client = rec.client as unknown as { getJob?: (id: string) => Promise<JobStatus> };
  client.getJob ??= async (id) => ({ job_id: id, state: "started", dataset_id: DS_ID, log_tail: [], progress: null, result: null });
  render(
    h(DesignerScreen, {
      client: rec.client,
      datasetId: DS_ID,
      tab: "overview",
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted: () => {},
      onAuthExpired: () => {},
      refreshMs: POLL_MS,
    }),
  );
}

/** Let `n` poll intervals pass for real, flushing React around them. */
async function ticks(n: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, POLL_MS * n));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The dataset as the API serves it while an add-layouts job runs on v1 (the poll only
 *  runs while something is in flight), and after that bake committed as v2. */
const V1_BAKING: DatasetSummary = summary({ active_job_id: "job-1" });
const V2_BAKING: DatasetSummary = summary({ dataset_version: 2, active_job_id: "job-2" });
const V2_DONE: DatasetSummary = summary({ dataset_version: 2, active_job_id: null });
const manifestAt = (version: number, source: string): LayoutManifest => ({
  ...MANIFEST_29,
  dataset_version: version,
  dataset_metadata: { ...MANIFEST_29.dataset_metadata, source },
});

/** The meta line under the tabs: "256 images · v{n} · {source}". */
function meta(): string {
  return document.querySelector(".designer-meta")?.textContent ?? "";
}

test("a version bump starts ONE full load, however many poll ticks pass before it lands", async () => {
  const rec = designerClient({ dataset: V1_BAKING });
  let server = V1_BAKING;
  let manifestCalls = 0;
  let slow: ReturnType<typeof deferred<LayoutManifest>> | null = null;
  rec.client.getDataset = async () => server;
  rec.client.getManifest = async () => {
    manifestCalls += 1;
    // The first load is served at once; the one after the bump is held, as a slow
    // manifest read would be, across several poll intervals.
    return slow === null ? manifestAt(1, "metadata.csv") : slow.promise;
  };
  mount(rec);
  await waitFor(() => assert.match(meta(), /v1 · metadata\.csv/));
  assert.equal(manifestCalls, 1);

  slow = deferred<LayoutManifest>();
  server = V2_BAKING; // the bake committed, and another job is still running
  await ticks(8);
  assert.equal(manifestCalls, 2, "one load per version change, not one per tick while it is in flight");

  await act(async () => slow?.resolve(manifestAt(2, "metadata.csv")));
  await waitFor(() => assert.match(meta(), /v2/));
  await ticks(4);
  assert.equal(manifestCalls, 2, "and none once the new version is on screen");
});

test("a reload that fails after the first load is SHOWN, over the content it could not refresh", async () => {
  const rec = designerClient({ dataset: V1_BAKING });
  let server = V1_BAKING;
  let failManifest = false;
  rec.client.getDataset = async () => server;
  rec.client.getManifest = async () => {
    // A manifest read that 500s, as `GET .../layouts/{id}` does when the server errors.
    if (failManifest) throw { status: 500, detail: "Internal Server Error" };
    return manifestAt(server.dataset_version, "metadata.csv");
  };
  mount(rec);
  await screen.findByRole("heading", { name: DS_ID });

  failManifest = true;
  server = V2_DONE;
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /Couldn't refresh this collection — Internal Server Error/);
  // The last good content is still there, and still says what it was read as.
  assert.ok(screen.getByRole("heading", { name: DS_ID }));
  assert.match(meta(), /v1/);
  assert.ok(screen.getByRole("contentinfo", { name: "Pending changes" }));

  // Retry succeeds → the banner goes and the new version is shown.
  failManifest = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.equal(screen.queryAllByRole("alert").length, 0));
  assert.match(meta(), /v2/);
});

test("a poll tick that read BEFORE a reload landed does not overwrite the reload's layout list", async () => {
  // The follow-up review's scenario, driven through the real reload path: a tick reads the
  // layout list and is still on the wire when the job the Layouts view follows lands, and
  // the view's reload() reads the list WITH the newly queued layout and lands first. The
  // tick then lands with its older read. Nothing is loading any more by then, so only the
  // load sequence can tell that its read is stale. (Seam L3 drove this reload through the
  // Add-layouts bridge; seam L5 removed the bridge, and a landed job is the view's reload.)
  //
  // A 400 ms poll leaves one tick (the held one) in the window between release and the
  // assertion; a later tick would re-read and mask the stale write. The job's answer is
  // HELD until then, so the reload happens exactly when the test releases it.
  const SLOW_POLL = 400;
  const rec = designerClient({ dataset: V1_BAKING });
  const jobAnswer = deferred<JobStatus>();
  rec.client.getJob = async () => jobAnswer.promise;
  // The row as api/routers/layouts.py `_pending_layouts` serves a queued layout that is
  // not in the manifest yet: label = id, type "", nothing committed.
  const queued = {
    layout_id: "categorical_caption",
    label: "categorical_caption",
    type: "",
    state: "queued" as const,
    rebake: null,
    committed_at: null,
    source_columns: null,
    options: null,
  };
  const base = await rec.client.listLayouts(DS_ID);
  let listCalls = 0;
  let heldTick: ReturnType<typeof deferred<typeof base>> | null = null;
  let hold = false;
  let queuedServed = false;
  rec.client.getDataset = async () => V1_BAKING;
  rec.client.listLayouts = async () => {
    listCalls += 1;
    if (hold && heldTick === null) {
      heldTick = deferred<typeof base>();
      return heldTick.promise; // the tick, on the wire
    }
    return queuedServed ? [...base, queued] : base;
  };
  render(
    h(DesignerScreen, {
      client: rec.client,
      datasetId: DS_ID,
      tab: "layouts",
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted: () => {},
      onAuthExpired: () => {},
      refreshMs: SLOW_POLL,
    }),
  );
  await screen.findByRole("region", { name: "Live layouts" });
  const rowsNamed = (id: string): number =>
    [...document.querySelectorAll("article")].filter((r) => (r.textContent ?? "").includes(id)).length;
  assert.equal(rowsNamed("categorical_caption"), 0);

  // The next tick's listLayouts is held.
  hold = true;
  await waitFor(() => assert.ok(heldTick !== null, "a poll tick is on the wire"), { timeout: SLOW_POLL * 3 });

  // Meanwhile: the job lands. The Layouts view reads it and calls reload(), which reads the
  // list with the queued row and lands.
  queuedServed = true;
  const callsBeforeReload = listCalls;
  await act(async () => jobAnswer.resolve({ job_id: "job-1", state: "finished", dataset_id: DS_ID, log_tail: [] }));
  await waitFor(() => assert.equal(rowsNamed("categorical_caption"), 1, "the reload brought the queued row in"));
  assert.ok(listCalls > callsBeforeReload);

  // The tick lands last, carrying its read from BEFORE the reload.
  await act(async () => heldTick?.resolve(base));
  assert.equal(
    rowsNamed("categorical_caption"),
    1,
    "a tick whose read predates a reload must not overwrite the reload's list",
  );
});

test("when two loads overlap, the LAST-STARTED one wins, whichever finishes first", async () => {
  const rec = designerClient({ dataset: V1_BAKING });
  let server = V1_BAKING;
  // What each getManifest call does, in order. Production-shaped: after a bake commits,
  // the manifest read 500s for a while (the poll keeps retrying it), then a retry is still
  // on the wire when the user presses Retry. Once the plan is used up every read FAILS, so
  // no poll retry can succeed behind the test's back and muddy which load won.
  const plan: ("v1" | "held" | "fresh")[] = ["v1"];
  let held: ReturnType<typeof deferred<LayoutManifest>> | null = null;
  let manifestCalls = 0;
  rec.client.getDataset = async () => server;
  rec.client.getManifest = async () => {
    manifestCalls += 1;
    const step = plan.shift();
    if (step === "v1") return manifestAt(1, "metadata.csv");
    if (step === "held") {
      held = deferred<LayoutManifest>();
      return held.promise;
    }
    if (step === "fresh") return manifestAt(2, "fresh.csv");
    throw { status: 500, detail: "Internal Server Error" };
  };
  mount(rec);
  await waitFor(() => assert.match(meta(), /v1 · metadata\.csv/));

  // v1 → v2: the poll's loads fail, and the banner (with Retry) appears.
  server = V2_DONE;
  await screen.findByRole("alert");

  // The poll's next retry is load B, held on the wire...
  plan.push("held", "fresh");
  const before = manifestCalls;
  await waitFor(() => assert.ok(held !== null && manifestCalls > before, "load B is waiting on its manifest"));
  // ...and the user's Retry is load C, which answers at once.
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.match(meta(), /fresh\.csv/));

  // B finishes LAST. It started first, so it must not overwrite C.
  await act(async () => held?.resolve(manifestAt(2, "stale.csv")));
  await ticks(3);
  assert.match(meta(), /fresh\.csv/, "an older load finishing late must not overwrite a newer result");
  assert.doesNotMatch(meta(), /stale\.csv/);
});
