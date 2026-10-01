// DOM tier — the designer's LAYOUTS view and REVIEW & COMMIT (seam L5; brief
// docs/prompts/brief_designer_layouts_seam.md §3, the nine tier-1 tests).
//
// Everything is driven through the real shell (DesignerScreen) over designerDom.ts's fake
// client, so the pending model, the derivation and the bar are the production ones.
// FIXTURES, and the production state each reproduces:
//   - tests/designer_fixture/layout_manifest_2.10.json — the golden full fixture refreshed
//     by the real producer: every layout records `source_fingerprint`. `infos()` builds
//     `LayoutInfo` from it as api/routers/layouts.py does (designerDom.ts's `layoutInfos`
//     is the 2.9 builder and does not carry the fingerprint, so it is extended here, not
//     edited there);
//   - tests/designer_fixture/layout_manifest_2.9.json — no fingerprint: every non-grid
//     layout is UNCHECKED;
//   - tests/fixtures/golden_dataset_images_only_v2/layout_manifest.json — an images-only
//     collection: grid alone, no `column_roles`; `GET .../columns` answers `images_only`.
//   - AFTER A ROLES-ONLY COMMIT: the 2.10 manifest with `column_roles` rewritten and the
//     layout entries untouched — exactly what `run_set_roles` writes (it re-declares roles
//     and bakes nothing), and the state D-xxix's durable stale flag exists for.
//   - IN-FLIGHT JOBS as the API serves them: a queued job's `progress` is null; a
//     `layout:{id}` stage exists only once that layout's bake has started; `rebake`
//     "baking" is derived from exactly that running stage (`_rebake_state`).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  AddLayoutsRequest,
  ColumnListResponse,
  DatasetSummary,
  JobStatus,
  LayoutInfo,
} from "../../src/api-client/types.ts";
import type { ColumnRoles } from "../../src/generated/column_roles.ts";
import type { Presentation } from "../../src/generated/presentation.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import type { RolesDraft } from "../../src/ui/admin/roles.ts";
import { DesignerScreen } from "../../src/ui/designer/DesignerScreen.ts";
import { addBake, pendingStorageKey, seedPending, serializePending, withDraft } from "../../src/ui/designer/pending.ts";
import type { BakeEntry, PendingState } from "../../src/ui/designer/pending.ts";
import type { DesignerTab } from "../../src/ui/urlState.ts";
import { COLUMNS, DS_ID, OWNER, designerClient, summary } from "./designerDom.ts";

type FixtureManifest = LayoutManifest & {
  layouts: (LayoutManifest["layouts"][number] & { source_columns?: string[]; source_fingerprint?: Record<string, unknown[][]> })[];
};

function readManifest(url: URL): FixtureManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FixtureManifest;
}

const M210 = readManifest(new URL("../designer_fixture/layout_manifest_2.10.json", import.meta.url));
const M29 = readManifest(new URL("../designer_fixture/layout_manifest_2.9.json", import.meta.url));
const IMAGES_ONLY = readManifest(new URL("../../../../tests/fixtures/golden_dataset_images_only_v2/layout_manifest.json", import.meta.url));

function infos(manifest: FixtureManifest): LayoutInfo[] {
  return manifest.layouts.map((l) => ({
    layout_id: l.layout_id,
    label: l.label,
    type: l.type,
    state: "live",
    rebake: null,
    committed_at: "2026-09-21T09:00:00Z",
    source_columns: l.source_columns ?? null,
    source_fingerprint: l.source_fingerprint ?? null,
    options: (l as { options?: Record<string, unknown> }).options ?? null,
  }));
}

/** The 2.10 tree after a roles-only commit re-declared `captured` as unix seconds. */
function afterRolesCommit(): FixtureManifest {
  const m = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  if (m.column_roles?.datetime) m.column_roles.datetime.format = "unix_seconds";
  return m;
}

// ---------------------------------------------------------------------------
// The fake: designerDom.ts's client, plus the four routes a job goes through
// ---------------------------------------------------------------------------

interface Rig {
  rec: ReturnType<typeof designerClient>;
  addLayouts: AddLayoutsRequest[];
  setColumnRoles: ColumnRoles[];
  deleteLayout: string[];
  getJob: string[];
  datasetReads: number;
}

function rig(opts: {
  manifest?: () => FixtureManifest;
  layouts?: () => LayoutInfo[];
  dataset?: () => DatasetSummary;
  presentation?: Presentation;
  columns?: ColumnListResponse;
  job?: (id: string, n: number) => JobStatus;
} = {}): Rig {
  const rec = designerClient({ presentation: opts.presentation });
  const r: Rig = { rec, addLayouts: [], setColumnRoles: [], deleteLayout: [], getJob: [], datasetReads: 0 };
  const manifest = opts.manifest ?? (() => M210);
  rec.client.getManifest = async () => {
    rec.manifestReads += 1;
    return manifest();
  };
  rec.client.listLayouts = async () => (opts.layouts ?? (() => infos(manifest())))();
  rec.client.getDataset = async () => {
    r.datasetReads += 1;
    return (opts.dataset ?? (() => summary()))();
  };
  if (opts.columns !== undefined) {
    const columns = opts.columns;
    rec.client.listColumns = async () => columns;
  }
  rec.client.addLayouts = async (_ds: string, req: AddLayoutsRequest) => {
    r.addLayouts.push(req);
    return { job_id: "job-bake" };
  };
  rec.client.setColumnRoles = async (_ds: string, roles: ColumnRoles) => {
    r.setColumnRoles.push(roles);
    return { job_id: "job-roles" };
  };
  rec.client.deleteLayout = async (_ds: string, id: string) => {
    r.deleteLayout.push(id);
    return { job_id: "job-delete" };
  };
  rec.client.getJob = async (id: string) => {
    r.getJob.push(id);
    const answer = opts.job?.(id, r.getJob.length);
    return answer ?? { job_id: id, state: "queued", dataset_id: DS_ID, log_tail: [], progress: null, result: null };
  };
  return r;
}

function networkWrites(r: Rig): number {
  return r.addLayouts.length + r.setColumnRoles.length + r.deleteLayout.length + r.rec.patches.length;
}

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

function mount(r: Rig, tab: DesignerTab = "layouts", opts: { refreshMs?: number } = {}): void {
  render(
    h(DesignerScreen, {
      client: r.rec.client,
      datasetId: DS_ID,
      tab,
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted: () => {},
      onAuthExpired: () => {},
      ...opts,
    }),
  );
}

/** Let `ms` pass in short `act` slices, so React commits and runs effects BETWEEN them. One
 *  long `act` holds every update until it ends, and a loop driven by re-renders never runs
 *  inside it — a pin that claims "bounded" over one long `act` cannot see the loop it rules
 *  out (verification of #385, round 3, N7c). */
async function elapse(ms: number, slice = 50): Promise<void> {
  for (let t = 0; t < ms; t += slice) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, slice));
    });
  }
}

const JOB_KEY = "plotlas.designer.job." + DS_ID;

function layoutsTab(): string {
  return screen.getByRole("tab", { name: /^Layouts/ }).textContent ?? "";
}

/** Persist a pending model, as a previous visit's edits would have left it. */
function persist(state: PendingState, version = 1): void {
  localStorage.setItem(pendingStorageKey(DS_ID), serializePending(state, version));
}

function seeded(manifest: FixtureManifest = M210): PendingState {
  return seedPending(manifest.column_roles);
}

function edited(state: PendingState, change: (d: RolesDraft) => void): PendingState {
  const draft = JSON.parse(JSON.stringify(state.draft)) as RolesDraft;
  change(draft);
  return withDraft(state, draft);
}

function stored(): { draft: RolesDraft | null; bakes: BakeEntry[] } | null {
  const raw = localStorage.getItem(pendingStorageKey(DS_ID));
  return raw === null ? null : (JSON.parse(raw) as { draft: RolesDraft | null; bakes: BakeEntry[] });
}

/** The pending edit that stales a live layout: Location's projection moved to Mercator.
 *
 *  Until D-xxxiii these tests used a datetime format change (`unix_seconds`). There is no
 *  format control now, and a saved draft's format is put back to the committed one on
 *  restore, so that draft no longer survives a reload. A projection is the one pair knob
 *  `set-roles` accepts on this data — MEASURED 2026-09-26 with main's worker on a copy of
 *  the 2.10 tree: `mercator` exit 0, Location reported stale. Refused: scatter log scale and
 *  pass-through (`sx` holds −900), scatter overlap jitter and aggregate, and geographic
 *  overlap jitter (both "not implemented yet").
 *
 *  Since seam L8 this IS an edit the cards make: Location's baked card writes exactly this
 *  draft when its Projection is set to Mercator (designer_baked_settings.dom.test.ts, test 1).
 *  These tests persist it rather than drive the card, so they exercise the pricing and the
 *  commit on their own. */
const MERCATOR = (d: RolesDraft): void => {
  d.geoPairs[0].projection = "mercator";
};

/** The 2.10 tree after a roles-only commit of MERCATOR — what `set-roles` wrote (the one key
 *  `column_roles.geographic[0].projection`, measured as above), layouts untouched. */
function afterMercatorCommit(): FixtureManifest {
  const m = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  if (m.column_roles?.geographic) m.column_roles.geographic[0].projection = "mercator";
  return m;
}

async function layoutsView(): Promise<void> {
  await screen.findByRole("region", { name: "Live layouts" });
}

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

function statesOf(): string[] {
  return [...document.querySelectorAll("[data-state]")].map((e) => e.getAttribute("data-state") ?? "");
}

function bar(): string {
  return screen.getByRole("contentinfo", { name: "Pending changes" }).textContent ?? "";
}

async function openReview(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /Review & commit/ }));
  return screen.findByRole("dialog", { name: "Review & commit" });
}

// --- 1. every card state, from the state that produces it -----------------------------

test("baked: an untouched 2.10 collection shows six solid, baked cards", async () => {
  mount(rig());
  await layoutsView();
  assert.deepEqual(statesOf(), ["baked", "baked", "baked", "baked", "baked", "baked"]);
});

test("unchecked: a 2.9 bake records no fingerprint, so its layouts are never shown healthy", async () => {
  mount(rig({ manifest: () => M29 }));
  await layoutsView();
  assert.deepEqual(statesOf(), ["baked", "unchecked", "unchecked", "unchecked", "unchecked", "unchecked"]);
  assert.match(card("By date").textContent ?? "", /can't tell whether it still matches the roles/);
  assert.ok(within(card("By date")).getByRole("button", { name: "Re-bake to check" }));
});

test("stale after a roles-only commit: the card says why, and Re-bake QUEUES — no network call", async () => {
  const r = rig({ manifest: afterRolesCommit });
  mount(r);
  await layoutsView();
  const byDate = card("By date");
  assert.equal(byDate.getAttribute("data-state"), "stale");
  assert.match(byDate.textContent ?? "", /captured changed since this layout was baked/);
  assert.equal(statesOf().filter((s) => s === "stale").length, 1, "only the layout reading captured");

  fireEvent.click(within(byDate).getByRole("button", { name: "Re-bake" }));
  await waitFor(() => assert.match(bar(), /1 bake to run/));
  assert.deepEqual(stored()?.bakes, [{ kind: "rebake", layout_id: "datetime" }]);
  assert.ok(within(card("By date")).getByRole("button", { name: "Remove from queue" }));
  assert.equal(networkWrites(r), 0, "Re-bake queues; only the review starts a bake (D-xxi)");
});

test("stale from the pending edit is told apart from stale since the bake", async () => {
  persist(edited(seeded(), MERCATOR));
  mount(rig());
  await layoutsView();
  assert.equal(card("Location").getAttribute("data-state"), "stale");
  assert.match(card("Location").textContent ?? "", /your pending change stales it/);
  assert.doesNotMatch(card("Location").textContent ?? "", /changed since this layout was baked/);
});

test("baking: real progress from the job's own layout stage; a queued layout in the run is dashed", async () => {
  const layouts = (): LayoutInfo[] => [
    ...infos(M210).map((l) => (l.layout_id === "datetime" ? { ...l, rebake: "baking" as const } : l)),
    { layout_id: "categorical_caption", label: "categorical_caption", type: "", state: "queued", rebake: null, committed_at: null, source_columns: null, options: null },
  ];
  const job = (id: string): JobStatus => ({
    job_id: id,
    state: "started",
    dataset_id: DS_ID,
    log_tail: [],
    progress: {
      progress_version: 1,
      spec_layouts: ["datetime", "categorical_caption"],
      image_count: 256,
      current: "layout:datetime",
      stages: [
        { key: "thumbs", label: "Thumbnails", unit: "images", done: 256, total: 256, state: "done" },
        { key: "layout:datetime", label: "Bake layout: By date", unit: "tiles", done: 4, total: 16, state: "running" },
      ],
    },
  });
  mount(rig({ layouts, job, dataset: () => summary({ active_job_id: "job-9" }) }));
  await layoutsView();
  await waitFor(() => assert.match(card("By date").textContent ?? "", /25% · 4 \/ 16 tiles/));
  assert.equal(card("By date").getAttribute("data-state"), "baking");
  assert.equal(within(card("By date")).getByRole("progressbar").getAttribute("aria-valuenow"), "25");
  assert.match(card("By date").textContent ?? "", /No cancel/);
  const queued = screen.getByRole("article", { name: "categorical_caption" });
  assert.equal(queued.getAttribute("data-state"), "queued");
  assert.equal(within(queued).queryAllByRole("progressbar").length, 0, "no bar before its own stage starts");
});

test("a layout whose stage has no total yet is indeterminate — never a made-up percentage", async () => {
  const layouts = (): LayoutInfo[] => infos(M210).map((l) => (l.layout_id === "datetime" ? { ...l, rebake: "baking" as const } : l));
  const job = (id: string): JobStatus => ({
    job_id: id,
    state: "started",
    dataset_id: DS_ID,
    log_tail: [],
    progress: {
      progress_version: 1,
      spec_layouts: ["datetime"],
      current: "layout:datetime",
      stages: [{ key: "layout:datetime", label: "Bake layout: By date", unit: "tiles", done: 0, total: null, state: "running" }],
    },
  });
  mount(rig({ layouts, job, dataset: () => summary({ active_job_id: "job-9" }) }));
  await layoutsView();
  await waitFor(() => assert.equal(within(card("By date")).getByRole("progressbar").getAttribute("aria-label"), "Bake progress (indeterminate)"));
  assert.doesNotMatch(card("By date").textContent ?? "", /%/);
});

test("unavailable: an images-only collection shows every family, dimmed, with the reason on its face", async () => {
  const r = rig({ manifest: () => IMAGES_ONLY, columns: { source: "images_only", columns: [] } });
  r.rec.client.getDataset = async () => summary({ layout_ids: ["grid"], image_count: IMAGES_ONLY.dataset_metadata.image_count });
  mount(r);
  await layoutsView();
  for (const action of ["Add a timeline", "Add a grouping", "Add a scatter layout", "Add a map layout"]) {
    const el = screen.getByLabelText(`${action} — unavailable`);
    assert.match(el.textContent ?? "", /No metadata/);
  }
  assert.equal(within(screen.getByRole("group", { name: "Add a layout" })).queryAllByRole("button").length, 0);
  // Its grid (manifest 2.1) records no provenance, but grid reads no column: never a check.
  assert.equal(card("Grid").getAttribute("data-state"), "baked");
  assert.equal(within(card("Grid")).queryAllByRole("button", { name: "Re-bake to check" }).length, 0);
});

// --- 2. a pair is picked on the card that consumes it ---------------------------------------

test("picking a pair writes the draft AND queues the entry; the bar prices the rename it causes", async () => {
  mount(rig());
  await layoutsView();
  fireEvent.click(within(screen.getByRole("group", { name: "Add a layout" })).getByRole("button", { name: "Scatter" }));
  const picker = await screen.findByRole("article", { name: "New scatter layout" });
  fireEvent.change(within(picker).getByLabelText("New scatter layout X column"), { target: { value: "lon" } });
  fireEvent.change(within(picker).getByLabelText("New scatter layout Y column"), { target: { value: "lat" } });

  await waitFor(() => assert.match(bar(), /1 bake to run/));
  const model = stored();
  assert.ok(model !== null);
  assert.equal(model.draft?.scatterPairs.filter((p) => p.x === "lon" && p.y === "lat").length, 1, "the pair is in the draft");
  assert.deepEqual(model.bakes, [{ kind: "new", type: "scatter", source_columns: ["lon", "lat"] }]);
  // A second pair renames the committed scatter layout — RoleConsequences' words. It is ONE
  // role change, the pair, however many columns it reads (operator, 2026-09-28).
  assert.match(bar(), /1 invalidating role change(?!s)/);
  assert.match(bar(), /lat, lon · nothing stale/);
  assert.match(card("Scatter").textContent ?? "", /its next bake files it as scatter_sx/);
  assert.ok(screen.getByRole("article", { name: "Queued: lon / lat" }));
});

// --- user #2: repointing a queued pair never declares a pair twice --------------------------

function queuedPairs(pairs: { family: "scatter" | "geographic"; a: string; b: string }[]): PendingState {
  let s = seeded();
  for (const { family, a, b } of pairs) {
    s = edited(s, (d) => {
      if (family === "scatter") d.scatterPairs.push({ x: a, y: b, label: "" });
      else d.geoPairs.push({ lon: a, lat: b, label: "" });
    });
    s = addBake(s, { kind: "new", type: family, source_columns: [a, b] });
  }
  return s;
}

function countPair(family: "scatter" | "geographic", a: string, b: string): number {
  const d = stored()?.draft;
  if (d == null) return -1;
  return family === "scatter" ? d.scatterPairs.filter((p) => p.x === a && p.y === b).length : d.geoPairs.filter((g) => g.lon === a && g.lat === b).length;
}

test("user #2: repointing a queued scatter onto the COMMITTED pair drops the card's pair — never two (sx, sy)", async () => {
  persist(queuedPairs([{ family: "scatter", a: "lon", b: "lat" }]));
  mount(rig());
  await layoutsView();
  fireEvent.change(screen.getByLabelText("lon / lat X column"), { target: { value: "sx" } });
  fireEvent.change(await screen.findByLabelText("sx / lat Y column"), { target: { value: "sy" } });
  await waitFor(() => assert.equal(countPair("scatter", "sx", "sy"), 1));
  assert.equal(stored()?.draft?.scatterPairs.length, 1, "only the committed pair is left");
});

test("user #2: repointing a queued scatter onto a pair ANOTHER card queued keeps one pair and one bake", async () => {
  persist(queuedPairs([{ family: "scatter", a: "lon", b: "lat" }, { family: "scatter", a: "lon", b: "sx" }]));
  mount(rig());
  await layoutsView();
  fireEvent.change(screen.getByLabelText("lon / sx Y column"), { target: { value: "lat" } });
  await waitFor(() => assert.equal(countPair("scatter", "lon", "sx"), 0));
  assert.equal(countPair("scatter", "lon", "lat"), 1);
  assert.deepEqual(stored()?.bakes, [{ kind: "new", type: "scatter", source_columns: ["lon", "lat"] }]);
});

test("user #2: the geographic twin — repointing onto the committed (lon, lat) drops the card's pair", async () => {
  persist(queuedPairs([{ family: "geographic", a: "sx", b: "sy" }]));
  mount(rig());
  await layoutsView();
  fireEvent.change(screen.getByLabelText("sx / sy Longitude"), { target: { value: "lon" } });
  fireEvent.change(await screen.findByLabelText("lon / sy Latitude"), { target: { value: "lat" } });
  await waitFor(() => assert.equal(countPair("geographic", "lon", "lat"), 1));
  assert.equal(stored()?.draft?.geoPairs.length, 1);
});

// --- 3. D-xxix: the review pre-queues what the edit newly stales ---------------------------

test("the review pre-ticks a re-bake of the newly staled layout, and unticking says what that means", async () => {
  persist(edited(seeded(), MERCATOR));
  mount(rig());
  await layoutsView();
  const review = await openReview();
  const tick = within(review).getByRole("checkbox", { name: "Re-bake Location" }) as HTMLInputElement;
  assert.equal(tick.checked, true);
  assert.ok(within(review).getByRole("button", { name: "Start bake — 1 layout" }));

  fireEvent.click(tick);
  assert.equal(tick.checked, false);
  assert.match(review.textContent ?? "", /Location stays stale\. It keeps serving the tiles it has/);
  assert.ok(within(review).getByRole("button", { name: "Commit role change — no bake" }));
});

test("the review never pre-ticks an UNCHECKED layout — its answer is not knowable", async () => {
  persist(edited(seeded(M29), MERCATOR));
  mount(rig({ manifest: () => M29 }));
  await layoutsView();
  const review = await openReview();
  assert.equal(within(review).queryAllByRole("checkbox", { name: "Re-bake Location" }).length, 0);
  const optIn = within(review).getByRole("checkbox", { name: "Re-bake Location to check it" }) as HTMLInputElement;
  assert.equal(optIn.checked, false);
  assert.ok(within(review).getByRole("button", { name: "Commit role change — no bake" }));
});

// --- R2 (review of #385): putting a failed commit back never silently overwrites -----------

function failingLater(): { fail: () => void; job: (id: string) => JobStatus } {
  let failed = false;
  return {
    fail: () => {
      failed = true;
    },
    job: (id) =>
      failed
        ? { job_id: id, state: "failed", dataset_id: DS_ID, log_tail: [], error: "ColumnRoleError: the worker refused it", result: null }
        : { job_id: id, state: "queued", dataset_id: DS_ID, log_tail: [], progress: null, result: null },
  };
}

async function commitRolesOnly(): Promise<void> {
  const review = await openReview();
  const tick = within(review).queryAllByRole("checkbox", { name: /^Re-bake / });
  for (const box of tick) if ((box as HTMLInputElement).checked) fireEvent.click(box);
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Committed" })).getByRole("button", { name: "Close" }));
}

test("R2: edits made while the job ran are not overwritten — putting the commit back asks first, naming them", async () => {
  // The review's probe: commit a projection change; while it is queued, add a lon/lat
  // scatter; the job fails; put the commit back.
  persist(edited(seeded(), MERCATOR));
  const j = failingLater();
  mount(rig({ job: j.job }));
  await layoutsView();
  await commitRolesOnly();
  fireEvent.click(within(screen.getByRole("group", { name: "Add a layout" })).getByRole("button", { name: "Scatter" }));
  const picker = await screen.findByRole("article", { name: "New scatter layout" });
  fireEvent.change(within(picker).getByLabelText("New scatter layout X column"), { target: { value: "lon" } });
  fireEvent.change(within(picker).getByLabelText("New scatter layout Y column"), { target: { value: "lat" } });
  await waitFor(() => assert.equal(stored()?.bakes.length, 1));
  j.fail();
  fireEvent.click(await screen.findByRole("button", { name: "Put the changes back" }, { timeout: 8000 }));
  const banner = document.querySelector(".layouts-follow")?.textContent ?? "";
  // The lon/lat scatter is one role change (the pair), and its one bake.
  assert.match(banner, /You have changed things since that commit \(1 role change, 1 bake queued\)/);
  assert.deepEqual(stored()?.bakes, [{ kind: "new", type: "scatter", source_columns: ["lon", "lat"] }], "nothing replaced yet");
  assert.equal(stored()?.draft?.scatterPairs.length, 2);
  fireEvent.click(screen.getByRole("button", { name: "Replace my changes" }));
  await waitFor(() => assert.equal(stored()?.draft?.geoPairs[0]?.projection, "mercator"));
  assert.deepEqual(stored()?.bakes, [], "replaced, because the owner said so");
});

test("R2: a draft the form refuses, made since the commit, is not counted as role changes on the banner", async () => {
  // Operator's review of #400, finding 3. With a refused draft there is no compiled map, so
  // there is nothing to count: before the fix the banner read "(2 role changes)" — Location
  // and Scatter counted as left — and the bar priced the same phantom beside the problem.
  // The commit is a stored record from an earlier visit (the follower reads it at mount); the
  // refused draft is what the owner left since, as an older build's saved draft can be.
  localStorage.setItem(
    JOB_KEY,
    JSON.stringify({ v: 1, jobId: "job-roles", kind: "roles", phase: "running", prediction: null, moves: [], restore: serializePending(edited(seeded(), MERCATOR), 1), deleting: null }),
  );
  persist(
    edited(seeded(), (d) => {
      d.choice.lat = "categorical";
    }),
  );
  const j = failingLater();
  mount(rig({ job: j.job }));
  await layoutsView();
  assert.match(bar(), /Can't commit yet — "lat" is a geographic latitude/, "premise: the form refuses the draft");
  assert.doesNotMatch(bar(), /invalidating/, "the bar shows the problem, and no count");
  j.fail();
  fireEvent.click(await screen.findByRole("button", { name: "Put the changes back" }, { timeout: 8000 }));
  const banner = document.querySelector(".layouts-follow")?.textContent ?? "";
  assert.match(banner, /You have changed things since that commit \(an edit to the roles\)/);
});

test("R2: with nothing edited since the commit, putting it back restores at once — no question", async () => {
  persist(edited(seeded(), MERCATOR));
  const j = failingLater();
  mount(rig({ job: j.job }));
  await layoutsView();
  await commitRolesOnly();
  await waitFor(() => assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null, "committed and cleared"));
  j.fail();
  fireEvent.click(await screen.findByRole("button", { name: "Put the changes back" }, { timeout: 8000 }));
  await waitFor(() => assert.equal(stored()?.draft?.geoPairs[0]?.projection, "mercator"));
  assert.equal(screen.queryAllByRole("button", { name: "Replace my changes" }).length, 0, "nothing to ask about");
});

test("R2: bakes queued while the job ran are KEPT when the commit is put back — merged, not asked", async () => {
  // After a roles-only commit set Location to Mercator, Location is durably stale. The owner
  // puts the projection back, commits it; while that job is queued, queues Location's
  // re-bake (a bake, no role edit); the job fails. (A datetime format change until
  // D-xxxiii; see MERCATOR.)
  persist(
    edited(seeded(afterMercatorCommit()), (d) => {
      d.geoPairs[0].projection = "equirectangular";
    }),
  );
  const j = failingLater();
  mount(rig({ manifest: afterMercatorCommit, job: j.job }));
  await layoutsView();
  await commitRolesOnly();
  fireEvent.click(within(card("Location")).getByRole("button", { name: "Re-bake" }));
  await waitFor(() => assert.deepEqual(stored()?.bakes, [{ kind: "rebake", layout_id: "geographic" }]));
  j.fail();
  fireEvent.click(await screen.findByRole("button", { name: "Put the changes back" }, { timeout: 8000 }));
  await waitFor(() => assert.equal(stored()?.draft?.geoPairs[0]?.projection, "equirectangular"));
  assert.deepEqual(stored()?.bakes, [{ kind: "rebake", layout_id: "geographic" }], "the bake queued since is kept");
  assert.equal(screen.queryAllByRole("button", { name: "Replace my changes" }).length, 0, "nothing needed asking");
});

// --- R3 / R4 (review of #385): one honest line per layout, and a heading that fits it ------

const M28 = readManifest(new URL("../../../../tests/fixtures/golden_dataset_full_v2/layout_manifest.json", import.meta.url));
const SECOND_PAIR = (d: RolesDraft): void => {
  d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
};

function consequences(review: HTMLElement, id: string): string[] {
  return [...review.querySelectorAll(`.layouts-consequences li[data-layout="${id}"]`)].map((li) => li.textContent ?? "");
}

test("R4: a change that only renames a layout is not headed “makes tiles wrong”; a projection change is", async () => {
  persist(addBake(edited(seeded(), SECOND_PAIR), { kind: "new", type: "scatter", source_columns: ["lon", "lat"] }));
  mount(rig());
  await layoutsView();
  let review = await openReview();
  assert.match(review.textContent ?? "", /Role change · no layout goes stale/);
  assert.doesNotMatch(review.textContent ?? "", /makes tiles wrong/);
  assert.match(consequences(review, "scatter")[0] ?? "", /Scatter is not affected/);
  cleanup();
  clearStorage();
  persist(edited(seeded(), MERCATOR));
  mount(rig());
  await layoutsView();
  review = await openReview();
  assert.match(review.textContent ?? "", /⚠ Invalidating · makes tiles wrong/);
});

test("R4 on 2.8: a change whose every consequence is “can't be told” is not headed “makes tiles wrong”", async () => {
  // Round 2, item 2: the pre-2.9 scatter is orphaned AND unknown, and every other layout is
  // unknown — nothing is known to go wrong.
  persist(edited(seeded(M28), SECOND_PAIR));
  mount(rig({ manifest: () => M28 }));
  await layoutsView();
  const review = await openReview();
  assert.match(review.textContent ?? "", /Role change · can't be checked against every layout/);
  assert.doesNotMatch(review.textContent ?? "", /makes tiles wrong/);
});

test("R3a: a pre-2.9 layout that is both orphaned and unknown gets ONE line, and no claim of a lost role", async () => {
  persist(edited(seeded(M28), SECOND_PAIR));
  mount(rig({ manifest: () => M28 }));
  await layoutsView();
  const review = await openReview();
  const lines = consequences(review, "scatter");
  assert.equal(lines.length, 1, lines.join(" | "));
  assert.match(lines[0], /whether its family was renamed or it lost its role can't be told/);
  assert.doesNotMatch(lines[0], /that is gone|can't be checked/);
  fireEvent.click(within(review).getByRole("button", { name: "Back" }));
  assert.doesNotMatch(card("Scatter").textContent ?? "", /which role it lost/);
  assert.match(card("Scatter").textContent ?? "", /whether its family was renamed or it lost its role can't be told/);
});

test("R3b: on 2.9 a projection change reads ONE line — stale as predicted, unconfirmable by the bake — in the review and on the card", async () => {
  persist(edited(seeded(M29), MERCATOR));
  mount(rig({ manifest: () => M29 }));
  await layoutsView();
  const boxes = card("Location").querySelectorAll(".layouts-card-box");
  assert.equal(boxes.length, 1, [...boxes].map((b) => b.textContent).join(" | "));
  assert.match(boxes[0].textContent ?? "", /stales it, if its tiles matched the roles as committed/);
  const review = await openReview();
  const lines = consequences(review, "geographic");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /can't be confirmed/);
  const row = within(review).getByRole("checkbox", { name: "Re-bake Location to check it" }).closest("li");
  assert.match(row?.textContent ?? "", /this change stales it, but its bake does not record/);
  assert.doesNotMatch(row?.textContent ?? "", /can't be known/);
});

test("R5: this designer's own one-layout run named `categorical` is named from its prediction, not read as a family request", async () => {
  // group and bucket stop being categorical and caption becomes the ONE categorical: its
  // layout id is the family's own name, `categorical`, which the committed roles (two
  // categoricals) do not produce.
  persist(
    addBake(
      edited(seeded(), (d) => {
        d.choice.group = "freeform";
        d.choice.bucket = "freeform";
        d.choice.caption = "categorical";
      }),
      { kind: "new", type: "categorical", source_columns: ["caption"] },
    ),
  );
  const r = rig({
    // As `_pending_layouts` serves the queued run: label = id, type "".
    layouts: () => [
      ...infos(M210),
      ...(r.addLayouts.length > 0
        ? [{ layout_id: "categorical", label: "categorical", type: "", state: "queued" as const, rebake: null, committed_at: null, source_columns: null, options: null }]
        : []),
    ],
  });
  r.rec.client.getDataset = async () => summary({ active_job_id: r.addLayouts.length > 0 ? "job-bake" : null });
  mount(r);
  await layoutsView();
  const review = await openReview();
  fireEvent.click(within(review).getByRole("button", { name: "Start bake — 1 layout" }));
  assert.deepEqual(r.addLayouts[0]?.layout_specs, ["categorical"], "a single-entry family's id is its name");
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Committed" })).getByRole("button", { name: "Close" }));
  const inFlight = await screen.findByRole("region", { name: "In flight" });
  assert.equal(within(inFlight).queryAllByRole("article", { name: "caption" }).length, 1);
  assert.doesNotMatch(inFlight.textContent ?? "", /Every categorical layout/);
});

// --- 4. one commit, one job ----------------------------------------------------------------

test("with the re-bake ticked the commit is ONE addLayouts carrying specs, replace and roles — and no roles call", async () => {
  persist(edited(seeded(), MERCATOR));
  const r = rig();
  mount(r);
  await layoutsView();
  const review = await openReview();
  fireEvent.click(within(review).getByRole("button", { name: "Start bake — 1 layout" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.equal(r.addLayouts.length, 1);
  assert.equal(r.setColumnRoles.length, 0, "never both calls");
  assert.deepEqual(r.addLayouts[0].layout_specs, ["geographic"]);
  assert.deepEqual(r.addLayouts[0].replace, ["geographic"]);
  assert.equal(r.addLayouts[0].column_roles?.geographic?.[0]?.projection, "mercator");
  assert.equal(r.rec.patches.length, 0, "a commit with no rename writes no presentation");
});

test("with it unticked the commit is ONE setColumnRoles and no addLayouts", async () => {
  persist(edited(seeded(), MERCATOR));
  const r = rig();
  mount(r);
  await layoutsView();
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.equal(r.setColumnRoles.length, 1);
  assert.equal(r.addLayouts.length, 0, "never both calls");
  assert.equal(r.setColumnRoles[0].geographic?.[0]?.projection, "mercator");
});

test("while the commit is on the wire the sheet cannot be closed — its answer, a 409 included, has nowhere else to show", async () => {
  persist(edited(seeded(), MERCATOR));
  const r = rig();
  let answer!: (v: { job_id: string }) => void;
  r.rec.client.setColumnRoles = () => new Promise((resolve) => (answer = resolve));
  mount(r);
  await layoutsView();
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  await within(review).findByRole("button", { name: "Starting…" });
  const closers = [within(review).getByRole("button", { name: "Close the review" }), within(review).getByRole("button", { name: "Back" })] as HTMLButtonElement[];
  assert.deepEqual(closers.map((b) => b.disabled), [true, true]);
  await act(async () => answer({ job_id: "job-roles" }));
  await screen.findByRole("dialog", { name: "Committed" });
});

// --- 5. the two-role refusal ---------------------------------------------------------------

test("a collection whose committed roles give a column two roles REFUSES, naming it, and sends nothing", async () => {
  // The CLI can commit categorical AND tag on one column; the draft holds one role.
  const twoRoles = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  twoRoles.column_roles = { ...twoRoles.column_roles!, tag: [...(twoRoles.column_roles?.tag ?? []), { column: "group", label: "Group", delimiter: "|" }] };
  persist(edited(seeded(twoRoles), MERCATOR));
  const r = rig({ manifest: () => twoRoles });
  mount(r);
  await layoutsView();
  const review = await openReview();
  const alert = within(review).getByRole("alert");
  // The Data row's words for the roles (`heldRoles.roleWord`), not the manifest's keys.
  assert.match(alert.textContent ?? "", /“group” carries Categorical and Tags, and the designer can hold only Tags/);
  assert.match(alert.textContent ?? "", /drop its Categorical role/);
  assert.match(alert.textContent ?? "", /CLI/);
  const primary = within(review).getByRole("button", { name: "Can't commit" }) as HTMLButtonElement;
  assert.equal(primary.disabled, true);
  fireEvent.click(primary);
  assert.equal(networkWrites(r), 0);
});

test("option A (operator 2026-09-25): on a two-role collection a plain re-bake goes out as ONE addLayouts with no roles", async () => {
  const twoRoles = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  twoRoles.column_roles = { ...twoRoles.column_roles!, tag: [...(twoRoles.column_roles?.tag ?? []), { column: "group", label: "Group", delimiter: "|" }] };
  persist(addBake(seeded(twoRoles), { kind: "rebake", layout_id: "datetime" }));
  const r = rig({ manifest: () => twoRoles });
  mount(r);
  await layoutsView();
  const review = await openReview();
  assert.equal(within(review).queryAllByRole("alert").length, 0, "nothing refuses a bake that sends no roles");
  fireEvent.click(within(review).getByRole("button", { name: "Start bake — 1 layout" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.deepEqual(r.addLayouts, [{ layout_specs: ["datetime"], replace: ["datetime"] }]);
  assert.equal(r.setColumnRoles.length, 0);
});

// --- 6. after the commit: cleared, reloaded, and the worker's report wins -----------------

test("after a commit the model is cleared and reloaded; a report that disagrees is SURFACED", async () => {
  persist(edited(seeded(), MERCATOR));
  const r = rig({
    job: (id) => ({
      job_id: id,
      state: "finished",
      dataset_id: DS_ID,
      log_tail: [],
      result: {
        dataset_id: DS_ID,
        dataset_version: "1",
        manifest_version: "2.10",
        changed_columns: ["lat", "lon"],
        // The prediction said Location; the worker also names Group.
        stale_layouts: ["geographic", "categorical_group"],
        unknown_layouts: [],
        orphaned_layouts: [],
        renamed_layouts: {},
        unserved_tag_roles: [],
        stale_tag_sidecar: null,
      },
    }),
  });
  mount(r);
  await layoutsView();
  const readsBefore = r.rec.manifestReads;
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  const sent = await screen.findByRole("dialog", { name: "Committed" });
  const follow = (): string => document.querySelector(".layouts-follow")?.textContent ?? "";
  await waitFor(() => assert.match(follow(), /The worker's report disagrees with the prediction/));
  assert.match(follow(), /The worker reports “Group” stale; the prediction did not/);
  assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null, "what was committed left the model");
  assert.ok(r.rec.manifestReads > readsBefore, "reload() re-read the collection");
  await waitFor(() => assert.match(sent.textContent ?? "", /It has landed\./));
  // ONE banner, the shell's, and one Dismiss clears it (review of #385, round 2, item 3).
  // Only once the landing's reload has reached every surface could a second one appear.
  await waitFor(() => assert.ok(r.rec.manifestReads >= readsBefore + 2, "acceptance and landing reloads"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const withFinding = (): number =>
    [...document.querySelectorAll(".layouts-banner")].filter((b) => /“Group” stale; the prediction did not/.test(b.textContent ?? "")).length;
  assert.equal(withFinding(), 1);
  fireEvent.click(within(sent).getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  assert.equal(withFinding(), 0);
});

// --- round 2 (review of #385): storage is a mirror, not the authority -----------------------

/** Make localStorage refuse every write to the job record — a full quota — until undone. */
function refuseJobWrites(): () => void {
  const proto = Object.getPrototypeOf(localStorage) as Storage;
  const set = proto.setItem;
  const remove = proto.removeItem;
  const refuse = (key: string): void => {
    if (key.startsWith("plotlas.designer.job.")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  proto.setItem = function (this: Storage, key: string, value: string): void {
    refuse(key);
    set.call(this, key, value);
  };
  proto.removeItem = function (this: Storage, key: string): void {
    refuse(key);
    remove.call(this, key);
  };
  return () => {
    proto.setItem = set;
    proto.removeItem = remove;
  };
}

test("round 2: storage that refuses the DONE write does not make the follower land the job again, and again", async () => {
  // The `running` record was written; then the quota filled. Before: the landing's write
  // failed, the refresh read `running` back, and the job landed again on every reload —
  // 145 reloads in 3 s on Overview.
  localStorage.setItem(
    "plotlas.designer.job." + DS_ID,
    JSON.stringify({ v: 1, jobId: "job-roles", kind: "roles", phase: "running", prediction: null, moves: [], restore: null, deleting: null }),
  );
  const undo = refuseJobWrites();
  try {
    const r = rig({ job: (id) => ({ job_id: id, state: "finished", dataset_id: DS_ID, log_tail: [], result: null }) });
    // A runaway loop must FAIL this test, not hang the file: past a bound far above any
    // correct count, the fake stops answering, which stops the loop where the counts
    // below can see it.
    const answer = r.rec.client.getJob;
    r.rec.client.getJob = (id: string) => (r.getJob.length >= 20 ? new Promise<JobStatus>(() => {}) : answer(id));
    mount(r, "overview");
    await screen.findByRole("tab", { name: /^Layouts/ });
    // What the landing learned is kept in memory, and shown — not reverted to "running".
    await waitFor(() => assert.match(document.querySelector(".layouts-follow")?.textContent ?? "", /without a report to check the prediction against/));
    await elapse(1500);
    assert.ok(r.getJob.length <= 2, `the job was read ${r.getJob.length} times`);
    assert.ok(r.rec.manifestReads <= 2, `the collection was loaded ${r.rec.manifestReads} times`);
    // ...and after the reloads, still: stale storage did not turn it back into "running".
    assert.match(document.querySelector(".layouts-follow")?.textContent ?? "", /without a report to check the prediction against/);
  } finally {
    undo();
  }
});

test("round 3 (user #1): with NO job-record storage at all, the commit is still reconciled — the follower owns the record", async () => {
  // Every job-record write refused from the start: the record never reaches storage, so
  // only the in-memory hand-over from the sheet can get it to the follower.
  persist(edited(seeded(), MERCATOR));
  const undo = refuseJobWrites();
  try {
    const r = rig({
      job: (id) => ({
        job_id: id,
        state: "finished",
        dataset_id: DS_ID,
        log_tail: [],
        result: {
          dataset_id: DS_ID, dataset_version: "1", manifest_version: "2.10", changed_columns: ["lat", "lon"],
          stale_layouts: ["geographic", "categorical_group"], unknown_layouts: [], orphaned_layouts: [], renamed_layouts: {},
          unserved_tag_roles: [], stale_tag_sidecar: null,
        },
      }),
    });
    mount(r);
    await layoutsView();
    const review = await openReview();
    fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
    fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
    await waitFor(() => assert.match(document.querySelector(".layouts-follow")?.textContent ?? "", /The worker reports “Group” stale; the prediction did not/));
    assert.equal(localStorage.getItem("plotlas.designer.job." + DS_ID), null, "nothing ever reached storage");
  } finally {
    undo();
  }
});

test("round 3 (user #4): Dismiss takes the report away and leaves a waiting rename — giving that up is its own action", async () => {
  localStorage.setItem(
    "plotlas.designer.job." + DS_ID,
    JSON.stringify({
      v: 1, jobId: "job-bake", kind: "bake", phase: "done", outcome: "finished", findings: ["The worker reports “Group” stale; the prediction did not."],
      error: null, prediction: null, moves: [{ from: "scatter", to: "scatter_sx" }], restore: null, deleting: null,
    }),
  );
  mount(rig(), "overview");
  const follow = (): string => document.querySelector(".layouts-follow")?.textContent ?? "";
  await waitFor(() => assert.match(follow(), /Waiting for scatter_sx to land/));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss the report" }));
  assert.doesNotMatch(follow(), /prediction did not/, "the report is gone");
  assert.match(follow(), /Waiting for scatter_sx to land/, "the rename still waits");
  assert.deepEqual(JSON.parse(localStorage.getItem("plotlas.designer.job." + DS_ID) ?? "{}").moves, [{ from: "scatter", to: "scatter_sx" }]);
  fireEvent.click(screen.getByRole("button", { name: /Don't move them/ }));
  assert.equal(follow(), "");
});

test("a report dismissed while a rename waits leaves NO record behind once the rename lands", async () => {
  // Dismiss leaves a done record with no outcome, holding only the move. When the new id
  // goes live and the move is made, that record has nothing left to say or do.
  const key = "plotlas.designer.job." + DS_ID;
  localStorage.setItem(
    key,
    JSON.stringify({
      v: 1, jobId: "job-bake", kind: "bake", phase: "done", outcome: "finished", findings: ["The worker reports “Group” stale; the prediction did not."],
      error: null, prediction: null, moves: [{ from: "scatter", to: "scatter_sx" }], restore: null, deleting: null,
    }),
  );
  let live = false;
  const r = rig({
    layouts: () => {
      const list = infos(M210);
      const scatter = list.find((l) => l.layout_id === "scatter");
      assert.ok(scatter !== undefined);
      return live ? [...list, { ...scatter, layout_id: "scatter_sx" }] : list;
    },
    // Another job keeps the shell's refresh running, so it re-reads the layout list.
    dataset: () => summary({ active_job_id: live ? null : "job-other" }),
  });
  mount(r, "overview", { refreshMs: 100 });
  const follow = (): string => document.querySelector(".layouts-follow")?.textContent ?? "";
  await waitFor(() => assert.match(follow(), /Waiting for scatter_sx to land/));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss the report" }));
  assert.ok(localStorage.getItem(key) !== null, "the waiting rename is still kept");
  live = true;
  await waitFor(() => assert.doesNotMatch(follow(), /Waiting for scatter_sx/));
  assert.equal(localStorage.getItem(key), null, "the record, with nothing left, is gone");
});

for (const [what, corrupt] of [
  ["prediction: {}", { phase: "running", kind: "bake", prediction: {} }],
  ["findings: a string", { phase: "done", kind: "roles", prediction: null, outcome: "finished", findings: "the worker disagreed", error: null }],
] as const) {
  test(`round 3 (user #3): a stored record the banner cannot walk (${what}) is dropped, not rendered — every tab keeps working`, async () => {
    localStorage.setItem(
      "plotlas.designer.job." + DS_ID,
      JSON.stringify({ v: 1, jobId: "job-x", moves: [], restore: null, deleting: null, ...corrupt }),
    );
    mount(rig(), "overview");
    await screen.findByRole("heading", { name: DS_ID });
    assert.equal(localStorage.getItem("plotlas.designer.job." + DS_ID), null, "the record was dropped");
  });
}

test("round 3 (user #6): a landing while active_job_id still names the job reads it ONCE and reloads ONCE", async () => {
  // The summary the designer holds still names the finished job until the landing's reload
  // arrives; the reload's own read says it is done, as the API derives it.
  localStorage.setItem(
    "plotlas.designer.job." + DS_ID,
    JSON.stringify({ v: 1, jobId: "job-roles", kind: "roles", phase: "running", prediction: null, moves: [], restore: null, deleting: null }),
  );
  let finished = false;
  const r = rig({
    job: (id) => {
      finished = true;
      return { job_id: id, state: "finished", dataset_id: DS_ID, log_tail: [], result: null };
    },
  });
  // The landing's reload takes as long as a real request, so the designer re-renders
  // while the summary it holds still names the job (the window user #6 describes).
  r.rec.client.getDataset = async () => {
    if (!finished) return summary({ active_job_id: "job-roles" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return summary({ active_job_id: null });
  };
  const answer = r.rec.client.getJob;
  r.rec.client.getJob = (id: string) => (r.getJob.length >= 20 ? new Promise<JobStatus>(() => {}) : answer(id));
  mount(r, "overview");
  await waitFor(() => assert.ok(finished, "the job was read"));
  await elapse(2500);
  // Mount's load, then ONE landing reload.
  assert.deepEqual({ jobReads: r.getJob.length, loads: r.rec.manifestReads }, { jobReads: 1, loads: 2 });
});

test("round 2: with job-record storage refused, the sheet reports its queued job as waiting — never “It has landed.”", async () => {
  persist(edited(seeded(), MERCATOR));
  const undo = refuseJobWrites();
  try {
    mount(rig());
    await layoutsView();
    const review = await openReview();
    fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
    fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
    const sent = await screen.findByRole("dialog", { name: "Committed" });
    await waitFor(() => assert.match(within(sent).getByRole("status").textContent ?? "", /Waiting for the worker/));
    assert.doesNotMatch(sent.textContent ?? "", /It has landed/);
  } finally {
    undo();
  }
});

test("the commit reloads when it is ACCEPTED, not only when the job lands — the run's rows appear at once", async () => {
  // The test above cannot tell the two reloads apart: its job lands at once, and the
  // landing reload satisfies it (review of #385, R7 — M17). Here the job stays queued, so
  // only the acceptance reload can re-read the collection.
  persist(edited(seeded(), MERCATOR));
  const r = rig({ job: (id) => ({ job_id: id, state: "queued", dataset_id: DS_ID, log_tail: [], progress: null, result: null }) });
  mount(r);
  await layoutsView();
  const readsBefore = r.rec.manifestReads;
  const datasetBefore = r.datasetReads;
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  await screen.findByRole("dialog", { name: "Committed" });
  await waitFor(() => assert.ok(r.rec.manifestReads > readsBefore, "re-read at acceptance"));
  assert.ok(r.datasetReads > datasetBefore);
  assert.ok(r.getJob.every((id) => id === "job-roles") && r.getJob.length > 0, "the job was read");
  assert.equal(document.querySelectorAll(".layouts-follow [role=alert]").length, 0, "and it has not landed");
});

// --- R1 (review of #385): a landed job is followed whichever tab is open ---------------

test("a roles-only commit made from the DATA tab is re-read when it lands, with Layouts never mounted", async () => {
  // set-roles bumps no dataset_version, so the shell's own poll never reloads after one;
  // before the follower moved to the shell, only a mounted Layouts view or sheet did.
  let landed = false;
  let answer = false;
  const r = rig({
    manifest: () => (landed ? afterMercatorCommit() : M210),
    job: (id) => {
      if (!answer) return { job_id: id, state: "queued", dataset_id: DS_ID, log_tail: [], progress: null, result: null };
      landed = true;
      return { job_id: id, state: "finished", dataset_id: DS_ID, log_tail: [], result: null };
    },
  });
  // As the API derives it: idle before the commit, the job's id while it is queued, idle after.
  r.rec.client.getDataset = async () => summary({ active_job_id: r.setColumnRoles.length > 0 && !landed ? "job-roles" : null });
  persist(edited(seeded(), MERCATOR));
  mount(r, "data");
  await screen.findByRole("tab", { name: /^Layouts/ });
  assert.equal(document.querySelectorAll('section[aria-label="Live layouts"]').length, 0, "Layouts is not mounted");
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  const sent = await screen.findByRole("dialog", { name: "Committed" });
  fireEvent.click(within(sent).getByRole("button", { name: "Close" }));
  // Committed, not landed: nothing pending, nothing stale yet.
  await waitFor(() => assert.doesNotMatch(screen.getByRole("tab", { name: /^Layouts/ }).textContent ?? "", /stale/));
  const readsBefore = r.rec.manifestReads;

  answer = true; // the worker finishes the job
  await waitFor(() => assert.match(screen.getByRole("tab", { name: /^Layouts/ }).textContent ?? "", /1 stale/), { timeout: 8000 });
  assert.ok(r.rec.manifestReads > readsBefore, "the manifest was re-read after the job landed");
  assert.equal(document.querySelectorAll('section[aria-label="Live layouts"]').length, 0, "...with Layouts still unmounted");
});

// --- 7. a renamed layout keeps its name and its default ------------------------------------

test("adopting a rename moves the owner's label and a matching default to the new id once it lands", async () => {
  // Owner named `scatter` "Embedding" and made it the default. A second pair renames it
  // to scatter_sx; this commit bakes the second pair AND scatter_sx, adopting the rename.
  let landed = false;
  const newRoles = (() => {
    const s = edited(seeded(), (d) => {
      d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
    });
    return s;
  })();
  let model = addBake(newRoles, { kind: "new", type: "scatter", source_columns: ["lon", "lat"] });
  model = addBake(model, { kind: "new", type: "scatter", source_columns: ["sx", "sy"] });
  persist(model);
  const scatter = M210.layouts.find((l) => l.layout_id === "scatter");
  assert.ok(scatter !== undefined);
  const after = (): FixtureManifest => {
    const m = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
    m.dataset_version = 2;
    m.column_roles = { ...m.column_roles!, scatter: [...(m.column_roles?.scatter ?? []), { x_column: "lon", y_column: "lat", label: "lon / lat" }] };
    m.layouts.push({ ...scatter, layout_id: "scatter_sx" }, { ...scatter, layout_id: "scatter_lon", label: "lon / lat", source_columns: ["lon", "lat"] });
    return m;
  };
  const before: Presentation = { layouts: { scatter: { label: "Embedding" } }, dataset: { default_layout: "scatter" } };
  const r = rig({
    presentation: before,
    manifest: () => (landed ? after() : M210),
    dataset: () => summary({ dataset_version: landed ? 2 : 1 }),
    job: (id) => {
      landed = true;
      return { job_id: id, state: "finished", dataset_id: DS_ID, log_tail: [], result: { dataset_version: "2", committed: ["scatter_lon", "scatter_sx"], replaced: [], failed: [] } };
    },
  });
  // The server's record, as the PATCH leaves it (the API applies it: key presence, null clears).
  r.rec.client.getPresentation = async () =>
    r.rec.patches.length > 0 ? { layouts: { scatter_sx: { label: "Embedding" } }, dataset: { default_layout: "scatter_sx" } } : before;
  mount(r);
  await layoutsView();
  const review = await openReview();
  fireEvent.click(within(review).getByRole("button", { name: "Start bake — 2 layouts" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.deepEqual(r.addLayouts[0].layout_specs, ["scatter_lon", "scatter_sx"]);
  await waitFor(() => assert.equal(r.rec.patches.length, 1));
  assert.deepEqual(r.rec.patches[0], {
    layouts: { scatter_sx: { label: "Embedding" }, scatter: null },
    default_layout: "scatter_sx",
  });
  // The new id carries the name and the default; the old layout says it is redundant.
  fireEvent.click(within(screen.getByRole("dialog", { name: "Committed" })).getByRole("button", { name: "Close" }));
  await waitFor(() => assert.match(card("Embedding").textContent ?? "", /Default/));
  assert.match(card("Scatter").textContent ?? "", /Superseded: its re-bake landed as scatter_sx/);
});

// --- 8. delete: a click, a job, honest about waiting and refusal ---------------------------

test("delete is ONE click → deleteLayout → the card reads deleting; a queued job reads waiting", async () => {
  let deleted = false;
  const r = rig({
    dataset: () => summary({ active_job_id: deleted ? "job-delete" : null }),
    job: (id) => ({ job_id: id, state: "queued", dataset_id: DS_ID, log_tail: [], progress: null, result: null }),
  });
  const del = r.rec.client.deleteLayout;
  r.rec.client.deleteLayout = async (ds: string, id: string) => {
    deleted = true;
    return del(ds, id);
  };
  mount(r);
  await layoutsView();
  fireEvent.click(within(card("By date")).getByRole("button", { name: "Delete…" }));
  const dialog = screen.getByRole("dialog", { name: "Delete “By date”?" });
  assert.equal(within(dialog).queryAllByRole("textbox").length, 0, "a layout asks for a click, not a typed name");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete layout" }));
  await waitFor(() => assert.equal(card("By date").getAttribute("data-state"), "waiting"));
  assert.deepEqual(r.deleteLayout, ["datetime"]);
  assert.match(card("By date").textContent ?? "", /delete waiting/);
  assert.match(card("By date").textContent ?? "", /keeps serving/);
  // While it waits, this collection takes no other change.
  const other = within(card("Grid")).getByRole("button", { name: "Delete…" }) as HTMLButtonElement;
  assert.equal(other.disabled, true);
  assert.match(card("Grid").textContent ?? "", /Refused while a job is running/);
});

test("a started delete job reads deleting", async () => {
  const r = rig({ job: (id) => ({ job_id: id, state: "started", dataset_id: DS_ID, log_tail: [], progress: null, result: null }) });
  mount(r);
  await layoutsView();
  fireEvent.click(within(card("Scatter")).getByRole("button", { name: "Delete…" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete layout" }));
  await waitFor(() => assert.equal(card("Scatter").getAttribute("data-state"), "deleting"));
});

test("delete is disabled, with its reason on its face, while any job runs on the collection", async () => {
  mount(rig({ dataset: () => summary({ active_job_id: "job-9" }), job: (id) => ({ job_id: id, state: "started", dataset_id: DS_ID, log_tail: [], progress: null, result: null }) }));
  await layoutsView();
  const buttons = screen.getAllByRole("button", { name: "Delete…" }) as HTMLButtonElement[];
  assert.equal(buttons.length, 6);
  assert.equal(buttons.filter((b) => b.disabled).length, 6);
});

test("the LAST layout cannot be deleted, and the card says so rather than letting a 409 say it", async () => {
  const r = rig({ manifest: () => IMAGES_ONLY, columns: { source: "images_only", columns: [] } });
  r.rec.client.getDataset = async () => summary({ layout_ids: ["grid"], image_count: IMAGES_ONLY.dataset_metadata.image_count });
  mount(r);
  await layoutsView();
  const del = within(card("Grid")).getByRole("button", { name: "Delete…" }) as HTMLButtonElement;
  assert.equal(del.disabled, true);
  assert.match(card("Grid").textContent ?? "", /The only layout/);
});

// --- free edits PATCH and never reach the bar (D-xx) ---------------------------------------

test("renaming a layout and making it the default PATCH presentation and never enter the bar", async () => {
  const r = rig();
  mount(r);
  await layoutsView();
  fireEvent.click(within(card("By date")).getByRole("button", { name: "Rename By date" }));
  const input = screen.getByLabelText("Name for datetime");
  fireEvent.change(input, { target: { value: "Timeline" } });
  fireEvent.blur(input);
  await waitFor(() => assert.equal(r.rec.patches.length, 1));
  assert.deepEqual(r.rec.patches[0], { layouts: { datetime: { label: "Timeline" } } });
  await screen.findByRole("article", { name: "Timeline" });
  fireEvent.click(within(card("Timeline")).getByRole("button", { name: "Make default" }));
  await waitFor(() => assert.equal(r.rec.patches.length, 2));
  assert.deepEqual(r.rec.patches[1], { default_layout: "datetime" });
  await waitFor(() => assert.match(card("Timeline").textContent ?? "", /Default/));
  assert.match(bar(), /Nothing pending/);
});

test("user #7: Enter, then the blur a browser fires as the input goes, sends the rename ONCE", async () => {
  const r = rig();
  let answer!: () => void;
  const onTheWire = new Promise<void>((resolve) => (answer = resolve)); // held until released
  let writes = 0; // counted as SENT, not as answered
  const patch = r.rec.client.setDatasetPresentation;
  r.rec.client.setDatasetPresentation = async (ds: string, body: Record<string, unknown>) => {
    writes += 1;
    await onTheWire;
    return patch(ds, body);
  };
  mount(r);
  await layoutsView();
  fireEvent.click(within(card("By date")).getByRole("button", { name: "Rename By date" }));
  const input = screen.getByLabelText("Name for datetime");
  fireEvent.change(input, { target: { value: "Timeline" } });
  // Both events before React re-renders the input away, as a browser delivers them.
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  assert.equal(writes, 1, "one write for one rename");
  await act(async () => answer());
  await waitFor(() => assert.equal(r.rec.patches.length, 1));
  assert.equal(writes, 1);
});

test("N4: the same name typed again after another tab cleared it is sent — the Enter guard covers only the write in flight", async () => {
  // A roles job from an earlier visit is still running; its landing reloads the designer,
  // which is how another tab's clear of the name reaches this one.
  localStorage.setItem(
    JOB_KEY,
    JSON.stringify({ v: 1, jobId: "job-roles", kind: "roles", phase: "running", prediction: null, moves: [], restore: null, deleting: null }),
  );
  let landed = false;
  const r = rig({
    job: (id) =>
      landed
        ? { job_id: id, state: "finished", dataset_id: DS_ID, log_tail: [], result: null }
        : { job_id: id, state: "started", dataset_id: DS_ID, log_tail: [], progress: null, result: null },
  });
  // What the server holds for this collection's presentation.
  let served: Presentation = {};
  r.rec.client.getPresentation = async () => served;
  const rename = (from: string): void => {
    fireEvent.click(within(card(from)).getByRole("button", { name: `Rename ${from}` }));
    const input = screen.getByLabelText("Name for datetime");
    fireEvent.change(input, { target: { value: "Timeline" } });
    fireEvent.keyDown(input, { key: "Enter" });
  };
  mount(r);
  await layoutsView();
  rename("By date");
  await waitFor(() => assert.equal(r.rec.patches.length, 1));
  served = { layouts: { datetime: { label: "Timeline" } } };
  await screen.findByRole("article", { name: "Timeline" });
  served = {}; // another tab clears the name
  landed = true;
  await screen.findByRole("article", { name: "By date" }, { timeout: 5000 });
  rename("By date");
  await waitFor(() => assert.equal(r.rec.patches.length, 2, "the rename is sent again"));
  assert.deepEqual(r.rec.patches[1], { layouts: { datetime: { label: "Timeline" } } });
});

// --- verification of #385, round 3 ----------------------------------------------------------

test("N1: a commit answered after the designer has gone keeps its record — the next visit reports the failure and offers the changes back", async () => {
  // Edit, Review, Commit — then browser Back while the POST is on the wire, so its answer
  // arrives with no follower mounted to hand the record to.
  persist(edited(seeded(), MERCATOR));
  const later = failingLater();
  const r = rig({ job: later.job });
  let answer!: () => void;
  const onTheWire = new Promise<void>((resolve) => (answer = resolve));
  const post = r.rec.client.setColumnRoles;
  r.rec.client.setColumnRoles = async (ds: string, roles: ColumnRoles) => {
    await onTheWire;
    return post(ds, roles);
  };
  mount(r);
  await layoutsView();
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  cleanup(); // Back: the whole designer is gone
  answer();
  await waitFor(() => assert.equal(r.setColumnRoles.length, 1, "the commit was still sent"));
  await waitFor(() => assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null, "its model left the pending store"));
  later.fail(); // the worker refuses the job

  mount(r);
  await layoutsView();
  const follow = (): string => document.querySelector(".layouts-follow")?.textContent ?? "";
  await waitFor(() => assert.match(follow(), /The job failed — ColumnRoleError: the worker refused it/));
  fireEvent.click(screen.getByRole("button", { name: "Put the changes back" }));
  await waitFor(() => assert.equal(stored()?.draft?.geoPairs[0]?.projection, "mercator", "the edit is back in the model"));
});

test("N2: a job followed from the summary alone is landed when the SHELL sees it end first — reloaded, once", async () => {
  // Production's order: the shell reads the summary every 5 s while the follower's poll
  // backs off 2 → 3 → 4.5 → 6.75 → 10 s, so the summary can report the end before the
  // poll's next read. Here the shell ticks every 100 ms and the follower keeps its real 2 s
  // first interval; the job ends just after the follower's first read. No job record: the
  // job came from another tab, the CLI, or a visit whose storage is gone. It is roles-only,
  // so no `dataset_version` moves and the shell's tick alone reloads nothing.
  let ended = false;
  const r = rig({
    manifest: () => (ended ? afterRolesCommit() : M210),
    dataset: () => summary({ active_job_id: ended ? null : "job-cli" }),
    job: (id) => {
      ended = true; // the worker finishes just after this read
      return { job_id: id, state: "started", dataset_id: DS_ID, log_tail: [], progress: null, result: null };
    },
  });
  mount(r, "overview", { refreshMs: 100 });
  await screen.findByRole("tab", { name: /^Layouts/ });
  await waitFor(() => assert.ok(ended, "the follower read the job"));
  const loads = r.rec.manifestReads;
  await elapse(1500); // inside the follower's 2 s: only the shell's ticks can see the end
  assert.match(layoutsTab(), /1 stale/);
  assert.deepEqual({ jobReads: r.getJob.length, reloads: r.rec.manifestReads - loads }, { jobReads: 1, reloads: 1 });
});

test("N3: on an untouched two-role collection the cards give no advice the lossy seed made up", async () => {
  // datetime AND freeform on `captured`, and By date durably stale (a roles-only commit
  // changed its format). The seed keeps freeform, so a probe through it read By date as
  // orphaned: "nothing can rebuild it — delete it, or restore the role".
  const stale = afterRolesCommit();
  stale.column_roles = { ...stale.column_roles!, freeform: [...(stale.column_roles?.freeform ?? []), { column: "captured", label: "Captured" }] };
  mount(rig({ manifest: () => stale }));
  await layoutsView();
  assert.equal(card("By date").getAttribute("data-state"), "stale");
  assert.doesNotMatch(card("By date").textContent ?? "", /nothing can rebuild it/);
  assert.equal(within(card("By date")).queryAllByRole("button", { name: "Restore role" }).length, 0);
  assert.equal(within(card("By date")).queryAllByRole("button", { name: "Re-bake" }).length, 1);
  cleanup();
  clearStorage();

  // categorical AND tag on `group`. The seed keeps tag, one categorical entry is left, and
  // a probe named Bucket's next bake bare `categorical` and orphaned Group.
  const tagged = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  tagged.column_roles = { ...tagged.column_roles!, tag: [...(tagged.column_roles?.tag ?? []), { column: "group", label: "Group", delimiter: "|" }] };
  mount(rig({ manifest: () => tagged }));
  await layoutsView();
  assert.doesNotMatch(card("Bucket").textContent ?? "", /its next bake files it as/);
  assert.equal(card("Group").getAttribute("data-state"), "baked");
  assert.doesNotMatch(card("Group").textContent ?? "", /no longer carry the role/);
});

test("D-xxxi end to end: on a two-role collection, the card's Re-bake goes out as ONE addLayouts with no roles", async () => {
  // The N3 collection: datetime AND freeform on `captured`, By date durably stale.
  const stale = afterRolesCommit();
  stale.column_roles = { ...stale.column_roles!, freeform: [...(stale.column_roles?.freeform ?? []), { column: "captured", label: "Captured" }] };
  const r = rig({ manifest: () => stale });
  mount(r);
  await layoutsView();
  fireEvent.click(within(card("By date")).getByRole("button", { name: "Re-bake" }));
  await waitFor(() => assert.match(bar(), /1 bake to run/));
  assert.doesNotMatch(bar(), /can't bake as queued/);
  assert.equal(screen.queryAllByText(/can't run as queued/).length, 0);
  const review = await openReview();
  assert.equal(within(review).queryAllByRole("alert").length, 0, "nothing refuses it");
  fireEvent.click(within(review).getByRole("button", { name: "Start bake — 1 layout" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.deepEqual(r.addLayouts, [{ layout_specs: ["datetime"], replace: ["datetime"] }], "no column_roles");
  assert.equal(r.setColumnRoles.length, 0);
});

/** Both groupings declared, only Group's baked — an add-layouts run took that one spec. */
function bucketUnbaked(): FixtureManifest {
  const m = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  m.layouts = m.layouts.filter((l) => l.layout_id !== "categorical_bucket");
  return m;
}

function addRow(): HTMLElement {
  return screen.getByRole("group", { name: "Add a layout" });
}

test("N7b: the Add offers follow the pending model — an offer queued leaves the Add row", async () => {
  mount(rig({ manifest: bucketUnbaked }));
  await layoutsView();
  fireEvent.click(within(addRow()).getByRole("button", { name: "Categorical · bucket" }));
  await screen.findByRole("article", { name: /^Queued/ });
  assert.equal(within(addRow()).queryAllByRole("button", { name: "Categorical · bucket" }).length, 0);
});

test("N7b: the Add offers follow the layout list — a list the shell's tick brings in re-prices them", async () => {
  // A CONTRACT pin: offers() reads the list, so its memo must key on it. The shell's tick
  // replaces the list and keeps the model. In production the live set moves only with a
  // version bump, whose full reload replaces the model as well — so this state is driven
  // through the fake, not reached from the API.
  const before = bucketUnbaked();
  let landed = false;
  mount(
    rig({ manifest: () => before, layouts: () => infos(landed ? M210 : before), dataset: () => summary({ active_job_id: "job-other" }) }),
    "layouts",
    { refreshMs: 100 },
  );
  await layoutsView();
  assert.equal(within(addRow()).queryAllByRole("button", { name: "Categorical · bucket" }).length, 1);
  landed = true;
  await screen.findByRole("article", { name: "Bucket" });
  assert.equal(within(addRow()).queryAllByRole("button", { name: "Categorical · bucket" }).length, 0);
});

// --- the Layouts tab badge counts the union (T2-the-layouts-tab-badge-does-not-count-a-durably)

test("the Layouts tab badge counts a durably stale layout, as Overview does", async () => {
  mount(rig({ manifest: afterRolesCommit }), "overview");
  await screen.findByRole("tab", { name: /^Layouts/ });
  await waitFor(() => assert.match(screen.getByRole("tab", { name: /^Layouts/ }).textContent ?? "", /1 stale/));
});

// --- D-xxxiii: a saved draft's datetime format is put back on restore -------------------------

test("a draft saved with a moved datetime format is put back before any tab renders, and the commit sends the committed one", async () => {
  // Only a build with the Data view's format select could save one. Put back in pending.ts's
  // restore path, so it holds whichever tab opens first — not only Data.
  const moved = (d: RolesDraft): void => {
    d.datetimeFormat = "unix_seconds";
  };
  for (const tab of ["overview", "data", "layouts"] as const) {
    persist(edited(seeded(), moved));
    mount(rig(), tab);
    await screen.findByRole("tab", { name: /^Layouts/ });
    // At the first paint, and again once every effect has run: a correction some view made
    // would miss the first, and a change some view wrote would show only in the second.
    for (const when of ["at the first paint", "after its effects"]) {
      if (when === "after its effects") await elapse(100);
      assert.match(bar(), /Nothing pending/, `${tab} opened first, ${when}`);
      assert.doesNotMatch(screen.getByRole("tab", { name: /^Data/ }).textContent ?? "", /changed/, `${tab} opened first, ${when}`);
      assert.doesNotMatch(layoutsTab(), /stale/, `${tab} opened first, ${when}`);
    }
    cleanup();
    clearStorage();
  }

  // Beside a change that does reach the bar, the commit carries the COMMITTED format.
  persist(
    edited(seeded(), (d) => {
      moved(d);
      MERCATOR(d);
    }),
  );
  const r = rig();
  mount(r, "overview");
  await screen.findByRole("tab", { name: /^Layouts/ });
  // Mercator alone: one pair, one role change. An uncorrected format would be a second
  // (`captured`'s own role), and would name `captured`.
  assert.match(bar(), /1 invalidating role change(?!s)/);
  assert.doesNotMatch(bar(), /captured/);
  await commitRolesOnly();
  assert.equal(r.setColumnRoles.length, 1);
  assert.equal(r.setColumnRoles[0].datetime?.format, "iso8601");
});

test("a draft saved with a moved tag delimiter is put back before any tab renders, and the commit sends the committed one", async () => {
  // [[T2-a-saved-draft-s-moved-delimiter-is-corrected]]: only the Data view corrected it, and
  // only once mounted, so a designer opened on Overview or Layouts kept `;` over the committed
  // `|` — "1 invalidating role change tags" in the bar, and in a commit. Only a development
  // build of #384 could save one (the delimiter was never editable in a release).
  const moved = (d: RolesDraft): void => {
    d.tagDelimiters.tags = ";";
  };
  for (const tab of ["overview", "layouts"] as const) {
    persist(edited(seeded(), moved));
    mount(rig(), tab);
    await screen.findByRole("tab", { name: /^Layouts/ });
    assert.match(bar(), /Nothing pending/, `${tab} opened first`);
    assert.doesNotMatch(screen.getByRole("tab", { name: /^Data/ }).textContent ?? "", /changed/, `${tab} opened first`);
    cleanup();
    clearStorage();
  }
  persist(
    edited(seeded(), (d) => {
      moved(d);
      MERCATOR(d);
    }),
  );
  const r = rig();
  mount(r, "overview");
  await screen.findByRole("tab", { name: /^Layouts/ });
  // Mercator alone: one pair, one role change. An uncorrected delimiter would be a second.
  assert.match(bar(), /1 invalidating role change(?!s)/);
  await commitRolesOnly();
  assert.deepEqual(r.setColumnRoles[0].tag?.map((t) => t.delimiter), ["|"]);
});

test("an old draft making two columns the datetime commits the committed format once one is moved off", async () => {
  // Review of #394, finding 9. A build before #384's second review let a second column take
  // the datetime, and `validateDraft` only reports that, so such a draft restores. Here
  // `modified` (a freeform text column) was made the datetime beside `captured`, whose
  // committed format is unix_seconds (FORMAT_MOVED's roles-only commit), and the saved draft
  // holds iso8601. The user moves `modified` off; whatever the draft held, the commit carries
  // `captured`'s committed format. Bucket → Freeform gives the commit something to send.
  const m = JSON.parse(JSON.stringify(M210)) as FixtureManifest;
  m.column_roles = {
    ...m.column_roles!,
    datetime: { ...m.column_roles!.datetime!, format: "unix_seconds" },
    freeform: [...(m.column_roles?.freeform ?? []), { column: "modified", label: "Modified" }],
  };
  const columns: ColumnListResponse = { source: "parquet", columns: [...COLUMNS.columns, { name: "modified", dtype: "VARCHAR", sample: "2021-02-01" }] };
  persist(
    edited(seeded(m), (d) => {
      d.choice.modified = "datetime";
      d.datetimeFormat = "iso8601";
      d.choice.bucket = "freeform";
    }),
  );
  const r = rig({ manifest: () => m, columns });
  mount(r, "data");
  await screen.findByRole("region", { name: "Data" });
  fireEvent.change(screen.getByRole("combobox", { name: "Role for column modified" }), { target: { value: "freeform" } });
  await commitRolesOnly();
  assert.equal(r.setColumnRoles.length, 1);
  assert.equal(r.setColumnRoles[0].datetime?.column, "captured");
  assert.equal(r.setColumnRoles[0].datetime?.format, "unix_seconds");
});

// --- 9. 390 px: no horizontal overflow ------------------------------------------------------
//
// jsdom has no layout engine (mobile_containment.dom.test.ts says why), so what is pinned
// is the DECLARATION that produces the fit; the pixels are the real-browser check at
// 390 × 844. The rule: nothing in the Layouts block declares a width that can exceed the
// viewport, every grid's column floor is capped at 100%, and every row wraps.

const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const layoutRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => /\.layouts-/.test(m[1]))
  .map((m) => ({ selector: m[1].trim(), body: m[2] }));

test("390 px: no declared width in the Layouts view can exceed the viewport, and its grids reflow", () => {
  assert.ok(layoutRules.length > 30, `found ${layoutRules.length} layouts- rules`);
  for (const { selector, body } of layoutRules) {
    for (const [, prop, value] of body.matchAll(/(?:^|;)\s*((?:min-)?width)\s*:\s*([^;]+)/g)) {
      const ok = value.trim() === "0" || value.trim() === "100%" || /^min\(/.test(value.trim());
      assert.ok(ok, `${selector} { ${prop}: ${value.trim()} } can exceed a 390 px viewport`);
    }
    for (const [, floor] of body.matchAll(/minmax\((min\([^)]*\)|[^,]+),/g)) {
      assert.match(floor.trim(), /^min\(.*100%\)$/, `${selector}: a grid floor of ${floor.trim()} is not capped at 100%`);
    }
    // A FIXED track (review of #385, R7): whatever is left of a column template once its
    // capped `min(…, 100%)` floors are removed must hold no length at all — `30rem 30rem`
    // has no minmax for the check above to see, and is 960 px wide.
    for (const [, template] of body.matchAll(/grid-template-columns\s*:\s*([^;]+)/g)) {
      const uncapped = template.replace(/min\([^)]*100%\)/g, "");
      assert.doesNotMatch(uncapped, /\d(?:\.\d+)?(?:px|rem|em|ch|vw)\b/, `${selector} { grid-template-columns: ${template.trim()} } has a fixed track`);
    }
  }
  // The shared `.knob-grid` (13rem floor, uncapped) is used INSIDE queued cards; the view
  // caps it there with its own rule rather than editing the shared one.
  const knobOverride = layoutRules.find((r) => r.selector === ".knob-grid.layouts-knobs");
  assert.ok(knobOverride !== undefined, "no .knob-grid.layouts-knobs override caps the shared knob grid inside a card");
  assert.match(knobOverride.body, /minmax\(min\([^)]*100%\)/);
  const decl = (selector: string): string => layoutRules.filter((r) => r.selector === selector).map((r) => r.body).join(" ");
  for (const row of [".layouts-head", ".layouts-add", ".layouts-card-head", ".layouts-card-actions", ".layouts-review-actions"]) {
    assert.match(decl(row), /flex-wrap:\s*wrap/, `${row} must wrap`);
  }
  for (const box of [".layouts-card", ".layouts-grid", ".layouts-pair", ".layouts-card-head"]) {
    assert.match(decl(box), /min-width:\s*0/, `${box} must be allowed to shrink`);
  }
});
