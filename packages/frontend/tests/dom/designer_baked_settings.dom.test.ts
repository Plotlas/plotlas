// DOM tier — a BAKED layout's settings can be changed (seam L8; brief
// docs/prompts/brief_designer_baked_settings_seam.md §3, the tier-1 tests).
//
// Driven through the real shell (DesignerScreen) over designerDom.ts's fake client, so the
// pending model, the derivation, the bar and the review are the production ones. Kept apart
// from designer_layouts.dom.test.ts (seam L5's), which this seam does not rebuild.
//
// FIXTURES, and the production state each reproduces:
//   - tests/designer_fixture/layout_manifest_2.10.json — the golden full fixture refreshed by
//     the real producer: every layout records `source_fingerprint`. Location (lon, lat) is
//     the one geographic layout, Scatter (sx, sy) the one scatter layout.
//   - tests/designer_fixture/layout_manifest_2.9.json — the same, recording no fingerprint.
//   - tests/fixtures/golden_dataset_full_v2/layout_manifest.json (2.8) — no provenance at all.
//   - ONE PAIR DECLARED TWICE, which `pixscope set-roles` accepts and `validateDraft` refuses
//     to draft (CONTRACT §4): assembled entry by entry from the real manifests, as
//     knob_guard_cases.json assembles its cases. Both layouts are the fixture's geographic
//     entry filed under the ids the naming convention gives two entries (`geographic_lon`,
//     `geographic_lon-1`), each labelled with its role entry's label as the producer labels
//     it.
//   - TWO DIFFERENT SCATTER PAIRS (test 1c): the 2.9 fixture's scatter entry filed twice, as
//     the two ids two entries bake under, the second over lon/lat — the `source_columns` the
//     producer records for that pair.
//   - AFTER A ROLES-ONLY COMMIT of Location to Mercator (test 5b): the 2.10 tree with the one
//     key `column_roles.geographic[0].projection` rewritten and the layouts untouched, which
//     is what `set-roles` writes (measured for #394's MERCATOR case, 2026-09-26).
//
// WHAT A COMMIT HERE WOULD REALLY DO. On the golden data only a geographic `mercator` passes
// the worker's value checks (sx spans ±900, so a scatter log scale or pass-through is
// refused — test_knob_guard_fingerprint.py), so every test that commits uses mercator. Tests
// 1c, 8 and 8a use scatter knobs and commit nothing: they exercise the client alone.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AddLayoutsRequest, DatasetSummary, LayoutInfo } from "../../src/api-client/types.ts";
import type { ColumnRoles } from "../../src/generated/column_roles.ts";
import type { Presentation } from "../../src/generated/presentation.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import type { RolesDraft } from "../../src/ui/admin/roles.ts";
import { DesignerScreen } from "../../src/ui/designer/DesignerScreen.ts";
import { addBake, pendingStorageKey, seedPending, serializePending, withDraft } from "../../src/ui/designer/pending.ts";
import type { BakeEntry, PendingState } from "../../src/ui/designer/pending.ts";
import { DS_ID, OWNER, designerClient, summary } from "./designerDom.ts";

type FixtureManifest = LayoutManifest & {
  layouts: (LayoutManifest["layouts"][number] & { source_columns?: string[]; source_fingerprint?: Record<string, unknown[][]> })[];
};

function readManifest(url: URL): FixtureManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FixtureManifest;
}

const M210 = readManifest(new URL("../designer_fixture/layout_manifest_2.10.json", import.meta.url));
const M29 = readManifest(new URL("../designer_fixture/layout_manifest_2.9.json", import.meta.url));
const M28 = readManifest(new URL("../../../../tests/fixtures/golden_dataset_full_v2/layout_manifest.json", import.meta.url));

/** `LayoutInfo` as api/routers/layouts.py builds it with no job in flight. */
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

function copy(manifest: FixtureManifest): FixtureManifest {
  return JSON.parse(JSON.stringify(manifest)) as FixtureManifest;
}

/** `column_roles.geographic` declaring lon/lat twice, with the layouts two entries bake as:
 *  the fixture's geographic entry under each id, labelled as its entry and echoing its
 *  options (a geographic layout always echoes both knobs). `records` is what each bake
 *  recorded: null for none, as before 2.10. */
function pairDeclaredTwice(
  from: FixtureManifest,
  entries: NonNullable<ColumnRoles["geographic"]>,
  records: (Record<string, unknown[][]> | null)[] = [null, null],
): FixtureManifest {
  const m = copy(from);
  m.column_roles = { ...m.column_roles!, geographic: entries };
  const geographic = m.layouts.find((l) => l.layout_id === "geographic");
  assert.ok(geographic !== undefined);
  const ids = ["geographic_lon", "geographic_lon-1"];
  const twins = entries.map((e, i) => {
    const twin = JSON.parse(JSON.stringify(geographic)) as typeof geographic;
    twin.layout_id = ids[i];
    twin.label = e.label;
    (twin as { options?: Record<string, unknown> }).options = { projection: e.projection ?? "equirectangular", overlap: e.overlap ?? "overdraw" };
    delete twin.source_fingerprint;
    const record = records[i];
    if (record !== null) twin.source_fingerprint = record;
    return twin;
  });
  m.layouts = m.layouts.flatMap((l) => (l.layout_id === "geographic" ? twins : [l]));
  return m;
}

// ---------------------------------------------------------------------------
// The fake: designerDom.ts's client, plus the routes a commit goes through
// ---------------------------------------------------------------------------

interface Rig {
  rec: ReturnType<typeof designerClient>;
  addLayouts: AddLayoutsRequest[];
  setColumnRoles: ColumnRoles[];
  deleteLayout: string[];
}

function rig(
  manifest: FixtureManifest = M210,
  opts: { layouts?: (list: LayoutInfo[]) => LayoutInfo[]; dataset?: Partial<DatasetSummary>; presentation?: Presentation } = {},
): Rig {
  const rec = designerClient({ presentation: opts.presentation });
  const r: Rig = { rec, addLayouts: [], setColumnRoles: [], deleteLayout: [] };
  rec.client.getManifest = async () => {
    rec.manifestReads += 1;
    return manifest;
  };
  rec.client.listLayouts = async () => (opts.layouts ?? ((list) => list))(infos(manifest));
  rec.client.getDataset = async () => summary(opts.dataset);
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
  rec.client.getJob = async (id: string) => ({ job_id: id, state: "queued", dataset_id: DS_ID, log_tail: [], progress: null, result: null });
  return r;
}

/** Every write the designer can make to the server: a job, or a presentation PATCH. */
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

function mount(r: Rig): void {
  render(
    h(DesignerScreen, {
      client: r.rec.client,
      datasetId: DS_ID,
      tab: "layouts",
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted: () => {},
      onAuthExpired: () => {},
    }),
  );
}

async function layoutsView(): Promise<void> {
  await screen.findByRole("region", { name: "Live layouts" });
}

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

function bar(): string {
  return screen.getByRole("contentinfo", { name: "Pending changes" }).textContent ?? "";
}

async function openReview(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: /Review & commit/ }));
  return screen.findByRole("dialog", { name: "Review & commit" });
}

function stored(): { draft: RolesDraft | null; bakes: BakeEntry[] } | null {
  const raw = localStorage.getItem(pendingStorageKey(DS_ID));
  return raw === null ? null : (JSON.parse(raw) as { draft: RolesDraft | null; bakes: BakeEntry[] });
}

function persist(state: PendingState): void {
  localStorage.setItem(pendingStorageKey(DS_ID), serializePending(state, 1));
}

function select(within_: HTMLElement, label: string): HTMLSelectElement {
  return within(within_).getByLabelText(label) as HTMLSelectElement;
}

function pick(el: HTMLSelectElement, value: string): void {
  fireEvent.change(el, { target: { value } });
}

/** The selects a card offers, by accessible name, and whether each can be used. */
function selects(el: HTMLElement): { name: string; enabled: boolean }[] {
  return [...el.querySelectorAll("select")].map((s) => ({ name: s.getAttribute("aria-label") ?? "", enabled: !s.disabled }));
}

// --- 1. an edit on a baked map: the draft's own entry, stale, priced, and nothing sent ------

test("1. a baked map's projection edit writes its own pair entry, stales Location, and sends nothing", async () => {
  const r = rig();
  mount(r);
  await layoutsView();
  assert.equal(card("Location").getAttribute("data-state"), "baked");
  const projection = select(card("Location"), "Location projection");
  assert.equal(projection.disabled, false, "a baked map's settings are editable");
  assert.equal(projection.value, "equirectangular", "the draft's value, which is the committed one before any edit");

  pick(projection, "mercator");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "stale"));
  const model = stored();
  assert.ok(model !== null && model.draft !== null);
  // The whole entry: its columns and label kept, one knob moved — no axis repointed.
  assert.deepEqual(model.draft.geoPairs, [{ lon: "lon", lat: "lat", label: "Location", projection: "mercator" }]);
  assert.deepEqual(model.draft.scatterPairs, [{ x: "sx", y: "sy", label: "Scatter" }], "the other family's pair is untouched");
  assert.deepEqual(model.bakes, [], "an edit queues nothing: the review pre-ticks the re-bake");
  assert.match(card("Location").textContent ?? "", /lon, lat — your pending change stales it: its tiles no longer match what you declared/);
  // ONE edit, counted once (operator, 2026-09-28; CONTRACT §4, "What the bar's count
  // counts"): both of a pair's columns read its settings, and the bar still lists both, but
  // the pair entry is one role change. Counted by column, as it was until then, this read 2.
  assert.match(bar(), /1 invalidating role change(?!s)/);
  assert.match(bar(), /lat, lon · stales Location/);
  assert.equal(networkWrites(r), 0, "editing a setting writes the draft and nothing else (D-xxi)");
});

// --- 1b. the entry edited is the one the bake recorded --------------------------------------

// What the producer records for each of two geographic entries over lon/lat — MEASURED
// 2026-09-28 by running `manifest.role_entry_fingerprints` + `fingerprint_to_json` in the lean
// test image on `ColumnRoles.from_config` of exactly these two entries (Flat, Web map).
const FLAT_RECORD = {
  lat: [["geographic", "lat", "lon", "equirectangular", "overdraw"]],
  lon: [["geographic", "lon", "lat", "equirectangular", "overdraw"]],
};
const WEB_MAP_RECORD = {
  lat: [["geographic", "lat", "lon", "mercator", "overdraw"]],
  lon: [["geographic", "lon", "lat", "mercator", "overdraw"]],
};
const TWO_MAPS: NonNullable<ColumnRoles["geographic"]> = [
  { lon_column: "lon", lat_column: "lat", label: "Flat" },
  { lon_column: "lon", lat_column: "lat", label: "Web map", projection: "mercator" },
];

test("1b. one pair declared twice is read-only even when 2.10 records tell the entries apart — the designer can't commit it", async () => {
  // `validateDraft` refuses ANY draft declaring one pair twice, so an edit here could never be
  // reviewed or committed (review of #397, finding 1, probe P1); with the SAME record on both
  // layouts it would also have edited one entry from both cards (probe P3).
  for (const records of [
    [FLAT_RECORD, WEB_MAP_RECORD],
    [FLAT_RECORD, FLAT_RECORD],
  ]) {
    mount(rig(pairDeclaredTwice(M210, TWO_MAPS, records)));
    await layoutsView();
    for (const name of ["Flat", "Web map"]) {
      const settings = within(card(name)).getByRole("group", { name: `${name} settings` });
      assert.deepEqual(selects(settings).map((s) => s.enabled), [false, false], `${name}: not editable`);
      assert.match(settings.textContent ?? "", /its pair is declared more than once, and the designer can't commit roles that declare one pair twice\. Change them with the CLI/);
      pick(select(card(name), `${name} projection`), name === "Flat" ? "mercator" : "equirectangular");
    }
    assert.equal(stored(), null, "nothing reached the draft");
    cleanup();
    clearStorage();
  }
});

test("1c. two different pairs of one family (client only): each card edits its OWN entry, never the family's first", async () => {
  const two = copy(M29);
  two.column_roles = {
    ...two.column_roles!,
    scatter: [...(two.column_roles?.scatter ?? []), { x_column: "lon", y_column: "lat", label: "Where" }],
  };
  const scatter = two.layouts.find((l) => l.layout_id === "scatter");
  assert.ok(scatter !== undefined);
  two.layouts = two.layouts.flatMap((l) =>
    l.layout_id === "scatter"
      ? [
          { ...scatter, layout_id: "scatter_sx" },
          { ...scatter, layout_id: "scatter_lon", label: "Where", source_columns: ["lon", "lat"] },
        ]
      : [l],
  );
  mount(rig(two));
  await layoutsView();
  pick(select(card("Where"), "Where axis scale"), "log");
  await waitFor(() => assert.ok(stored() !== null));
  assert.deepEqual(stored()?.draft?.scatterPairs, [
    { x: "sx", y: "sy", label: "Scatter" },
    { x: "lon", y: "lat", label: "Where", x_scale: "log", y_scale: "log" },
  ]);
});

// --- 2. put back ----------------------------------------------------------------------------

test("2. put back to equirectangular: nothing pending, the card reads baked", async () => {
  mount(rig());
  await layoutsView();
  pick(select(card("Location"), "Location projection"), "mercator");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "stale"));
  pick(select(card("Location"), "Location projection"), "equirectangular");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "baked"));
  assert.match(bar(), /Nothing pending/);
  assert.equal(stored(), null, "no edit is left behind to persist");
});

test("2. put back onto an entry that DECLARES the default: it takes the committed form, so nothing is left behind", async () => {
  // `pixscope set-roles` keeps a knob given explicitly, default or not; the fingerprint fills
  // defaults, so the layout's record still matches it.
  const explicit = copy(M210);
  explicit.column_roles!.geographic![0].projection = "equirectangular";
  mount(rig(explicit));
  await layoutsView();
  pick(select(card("Location"), "Location projection"), "mercator");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "stale"));
  pick(select(card("Location"), "Location projection"), "equirectangular");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "baked"));
  assert.equal(stored(), null, "the draft is the seed again, byte for byte");
});

// --- 3. and 4. the review ---------------------------------------------------------------------

test("3. the review pre-ticks Location's re-bake, and the commit is ONE addLayouts: its own id, replaced, the mercator roles", async () => {
  const r = rig();
  mount(r);
  await layoutsView();
  pick(select(card("Location"), "Location projection"), "mercator");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "stale"));
  const review = await openReview();
  // The sheet the bar opens counts what the bar counts: one change, over one row per column
  // (review of #400, finding 2: its heading read "2 changes" under a bar reading 1).
  const tier = within(review).getByRole("region", { name: "Role changes" });
  assert.match(tier.querySelector(".layouts-tier-head")?.textContent ?? "", /makes tiles wrong1 change(?!s)/);
  assert.deepEqual([...tier.querySelectorAll(".layouts-tier-row .layouts-mono")].map((e) => e.textContent), ["lat", "lon"]);
  const tick = within(review).getByRole("checkbox", { name: "Re-bake Location" }) as HTMLInputElement;
  assert.equal(tick.checked, true, "pre-ticked (D-xxix)");
  fireEvent.click(within(review).getByRole("button", { name: "Start bake — 1 layout" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.equal(r.addLayouts.length, 1);
  assert.equal(r.setColumnRoles.length, 0, "never both calls");
  const [req] = r.addLayouts;
  assert.deepEqual(req.layout_specs, ["geographic"], "a knob never renames: its own id");
  assert.deepEqual(req.replace, ["geographic"]);
  assert.deepEqual(req.column_roles?.geographic, [{ lon_column: "lon", lat_column: "lat", label: "Location", projection: "mercator" }]);
});

test("4. unticked, the commit is ONE roles-only setColumnRoles, and the review says what staying stale means", async () => {
  const r = rig();
  mount(r);
  await layoutsView();
  pick(select(card("Location"), "Location projection"), "mercator");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "stale"));
  const review = await openReview();
  fireEvent.click(within(review).getByRole("checkbox", { name: "Re-bake Location" }));
  assert.match(review.textContent ?? "", /Location stays stale\. It keeps serving the tiles it has — placed by the old reading of lon, lat — and its card says so until you re-bake it\./);
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.equal(r.setColumnRoles.length, 1);
  assert.equal(r.addLayouts.length, 0, "never both calls");
  assert.equal(r.setColumnRoles[0].geographic?.[0]?.projection, "mercator");
});

// --- 5. a pre-2.10 layout: D-xxx ---------------------------------------------------------------

test("5. pre-2.10: the edit riding another queued bake is refused with knobConflicts' text; alone it goes out roles-only", async () => {
  const r = rig(M29);
  mount(r);
  await layoutsView();
  pick(select(card("Location"), "Location projection"), "mercator");
  await waitFor(() => assert.equal(card("Location").getAttribute("data-state"), "stale"));
  // Another bake in the same run: By date's "Re-bake to check".
  fireEvent.click(within(card("By date")).getByRole("button", { name: "Re-bake to check" }));
  await waitFor(() => assert.match(bar(), /1 bake to run/));
  let review = await openReview();
  const refused = within(review).getByRole("alert").textContent ?? "";
  assert.match(
    refused,
    /This run changes the map settings of “Location” \(lon \/ lat\) without re-baking it\. It was baked before layouts recorded how they read their columns, so nothing could show it as out of date afterwards, and the worker refuses that before baking anything\./,
  );
  const primary = within(review).getByRole("button", { name: "Can't commit" }) as HTMLButtonElement;
  assert.equal(primary.disabled, true);
  fireEvent.click(primary);
  assert.equal(networkWrites(r), 0, "refused up front: nothing is sent");

  // Alone: the other bake leaves the queue, and the same edit commits on its own.
  fireEvent.click(within(review).getByRole("button", { name: "Back" }));
  fireEvent.click(within(card("By date")).getByRole("button", { name: "Remove from queue" }));
  await waitFor(() => assert.doesNotMatch(bar(), /bake to run/));
  review = await openReview();
  assert.equal(within(review).queryAllByRole("alert").length, 0);
  fireEvent.click(within(review).getByRole("button", { name: "Commit role change — no bake" }));
  await screen.findByRole("dialog", { name: "Committed" });
  assert.deepEqual({ roles: r.setColumnRoles.length, bakes: r.addLayouts.length }, { roles: 1, bakes: 0 });
  assert.equal(r.setColumnRoles[0].geographic?.[0]?.projection, "mercator");
});

// --- review of #397: the durably-stale fallback, an orphan, a re-bake in flight ---------------

test("5b. durably stale (its record matches no committed entry): its one declaration is editable, and putting the bake's value back is priced as un-staling", async () => {
  // After a roles-only commit moved Location to Mercator, its bake (equirectangular) no
  // longer matches the committed entry — the review's probe P2.
  const afterMercator = copy(M210);
  afterMercator.column_roles!.geographic![0].projection = "mercator";
  mount(rig(afterMercator));
  await layoutsView();
  assert.equal(card("Location").getAttribute("data-state"), "stale");
  assert.match(card("Location").textContent ?? "", /lat, lon changed since this layout was baked/);
  const projection = select(card("Location"), "Location projection");
  assert.deepEqual({ value: projection.value, enabled: !projection.disabled }, { value: "mercator", enabled: true }, "the committed value, editable");
  // The note holds in this direction too: the baked value is not a change that stales it.
  const note = "A setting other than the one it was baked with stales this layout until it is re-baked.";
  assert.ok((card("Location").textContent ?? "").includes(note));

  pick(projection, "equirectangular");
  await waitFor(() => assert.ok(stored() !== null));
  assert.deepEqual(stored()?.draft?.geoPairs, [{ lon: "lon", lat: "lat", label: "Location" }], "the bake's own reading, as the default");
  assert.match(bar(), /1 invalidating role change(?!s)/); // one pair entry, counted once; see test 1
  assert.match(bar(), /lat, lon · nothing stale/, "putting the bake's reading back stales nothing");
  assert.ok((card("Location").textContent ?? "").includes(note));
});

test("2b. an orphaned layout offers no settings — nothing can re-bake it, so a setting would price nothing (pre-2.9, probe P4)", async () => {
  // A second scatter pair renames the family; Scatter baked before 2.9 has no provenance to
  // say it is the one renamed, so it is orphaned and unknown (as R3a in the L5 suite).
  const s = seedPending(M28.column_roles);
  persist(withDraft(s, { ...s.draft!, scatterPairs: [...s.draft!.scatterPairs, { x: "lon", y: "lat", label: "" }] }));
  mount(rig(M28));
  await layoutsView();
  assert.equal(card("Scatter").getAttribute("data-state"), "orphaned");
  assert.equal(within(card("Scatter")).queryAllByRole("group", { name: "Scatter settings" }).length, 0);
  assert.doesNotMatch(card("Scatter").textContent ?? "", /Re-baking it records that/);
  assert.equal(within(card("Location")).queryAllByRole("group", { name: "Location settings" }).length, 1, "a layout that is not orphaned keeps them");
});

test("3b. while its own re-bake is in the running job, a baked card's settings are read-only, with why", async () => {
  for (const rebake of ["queued", "baking"] as const) {
    mount(
      rig(M210, {
        layouts: (list) => list.map((l) => (l.layout_id === "geographic" ? { ...l, rebake } : l)),
        dataset: { active_job_id: "job-9" },
      }),
    );
    await layoutsView();
    const settings = within(card("Location")).getByRole("group", { name: "Location settings" });
    assert.deepEqual(selects(settings).map((s) => s.enabled), [false, false], `rebake ${rebake}: not editable`);
    assert.match(settings.textContent ?? "", /read-only while its re-bake is in the running job/);
    pick(select(card("Location"), "Location projection"), "mercator");
    assert.equal(stored(), null, "nothing reached the draft");
    assert.deepEqual(selects(card("Scatter")).map((s) => s.enabled), [true, true, true], "a card whose own bake is not running stays editable");
    cleanup();
    clearStorage();
  }
});

// --- review of #397, round 3 -------------------------------------------------------------------

/** After an adopted rename landed: a second scatter pair renamed `scatter` to `scatter_sx`,
 *  and `scatter_sx` was baked. Both layouts were baked from the one sx/sy entry, so the new
 *  one records the fixture's own sx/sy fingerprint, exactly as `scatter` does; the old one
 *  stays until it is deleted (CONTRACT §8, "A renamed layout keeps its name"). The new pair
 *  (lon, lat) is declared and not baked. The owner's label moved to the new id. */
function afterAdoptedRename(): FixtureManifest {
  const m = copy(M210);
  m.column_roles = { ...m.column_roles!, scatter: [...(m.column_roles?.scatter ?? []), { x_column: "lon", y_column: "lat", label: "lon / lat" }] };
  const scatter = m.layouts.find((l) => l.layout_id === "scatter");
  assert.ok(scatter !== undefined);
  m.layouts.push({ ...copy({ layouts: [scatter] } as FixtureManifest).layouts[0], layout_id: "scatter_sx" });
  return m;
}
const ADOPTED: Presentation = { layouts: { scatter_sx: { label: "Scatter, re-baked" } } };

test("1d. a SUPERSEDED card offers no settings: its entry is its successor's, which an edit there would stale", async () => {
  mount(rig(afterAdoptedRename(), { presentation: ADOPTED }));
  await layoutsView();
  assert.match(card("Scatter").textContent ?? "", /Superseded: its re-bake landed as scatter_sx/);
  assert.equal(within(card("Scatter")).queryAllByRole("group", { name: "Scatter settings" }).length, 0, "the superseded card has none");
  const successor = within(card("Scatter, re-baked")).getByRole("group", { name: "Scatter, re-baked settings" });
  assert.deepEqual(selects(successor).map((s) => s.enabled), [true, true, true], "its successor keeps them");
});

test("3c. a queued entry over a committed pair points at the baked card for its settings — Data has none", async () => {
  // Adopting a rename, as L5's flow does it: a second pair renames `scatter`, and a new entry
  // is queued over the committed sx/sy pair to bake its new id. That queued card shows the
  // pair locked: its settings are the committed entry's.
  const s = seedPending(M210.column_roles);
  const drafted = withDraft(s, { ...s.draft!, scatterPairs: [...s.draft!.scatterPairs, { x: "lon", y: "lat", label: "" }] });
  persist(addBake(drafted, { kind: "new", type: "scatter", source_columns: ["sx", "sy"] }));
  mount(rig());
  await layoutsView();
  const queued = screen.getByRole("article", { name: "Queued: Scatter" });
  assert.match(queued.textContent ?? "", /this pair is already declared, so its columns and settings are the committed ones\. Its settings are changed on its baked card, under Live\./);
  assert.doesNotMatch(queued.textContent ?? "", /in Data/);
});

test("4b. while its re-bake runs, the card shows the COMMITTED settings, and says a pending edit waits in the draft", async () => {
  // An uncommitted Projection → Mercator is in the draft; a re-bake of Location starts from
  // elsewhere (the CLI, another tab). It bakes the committed equirectangular, not the draft.
  const running = { layouts: (list: LayoutInfo[]) => list.map((l) => (l.layout_id === "geographic" ? { ...l, rebake: "queued" as const } : l)), dataset: { active_job_id: "job-9" } };
  const s = seedPending(M210.column_roles);
  persist(withDraft(s, { ...s.draft!, geoPairs: [{ ...s.draft!.geoPairs[0], projection: "mercator" }] }));
  mount(rig(M210, running));
  await layoutsView();
  const projection = select(card("Location"), "Location projection");
  assert.deepEqual({ value: projection.value, enabled: !projection.disabled }, { value: "equirectangular", enabled: false }, "the committed value, not the draft's");
  const pendingNote = /Your pending change to these settings stays in your draft, for your next commit/;
  assert.match(card("Location").textContent ?? "", pendingNote);
  cleanup();
  clearStorage();

  // With nothing pending for this pair, nothing is said about a pending change.
  mount(rig(M210, running));
  await layoutsView();
  assert.equal(select(card("Location"), "Location projection").value, "equirectangular");
  assert.doesNotMatch(card("Location").textContent ?? "", pendingNote);
});

// Finding 2: a card that is not orphaned or superseded never loses its settings in silence.
// No control in the designer adds or removes a COMMITTED pair in the draft (queuePair never
// declares one twice, and a queued card's Remove never drops one the seed holds), so these
// drafts come from another writer, as the L5 suite's persisted drafts do.

const TWO_FLAT: NonNullable<ColumnRoles["geographic"]> = [
  { lon_column: "lon", lat_column: "lat", label: "Flat" },
  { lon_column: "lon", lat_column: "lat", label: "Also flat" },
];

test("2c. a duplicate REMOVED in the draft: the one pair left is editable from either card, since the draft is valid again", async () => {
  const twice = pairDeclaredTwice(M29, TWO_FLAT);
  const s = seedPending(twice.column_roles);
  persist(withDraft(s, { ...s.draft!, geoPairs: [s.draft!.geoPairs[0]] }));
  mount(rig(twice));
  await layoutsView();
  for (const name of ["Flat", "Also flat"]) {
    const settings = within(card(name)).getByRole("group", { name: `${name} settings` });
    assert.deepEqual(selects(settings).map((s) => s.enabled), [true, true], `${name}: editable`);
  }
  pick(select(card("Also flat"), "Also flat projection"), "mercator");
  await waitFor(() => assert.equal(stored()?.draft?.geoPairs[0]?.projection, "mercator"));
  assert.deepEqual(stored()?.draft?.geoPairs, [{ lon: "lon", lat: "lat", label: "Flat", projection: "mercator" }], "the one pair left");
});

test("2d. a duplicate ADDED in the draft: the card's settings are read-only, with why — not gone", async () => {
  const s = seedPending(M210.column_roles);
  persist(withDraft(s, { ...s.draft!, geoPairs: [...s.draft!.geoPairs, { lon: "lon", lat: "lat", label: "Location again" }] }));
  mount(rig());
  await layoutsView();
  const settings = within(card("Location")).getByRole("group", { name: "Location settings" });
  assert.deepEqual(selects(settings).map((s) => s.enabled), [false, false]);
  assert.match(settings.textContent ?? "", /your pending roles declare its pair more than once, which can't be committed/);
});

test("2f. the pair it was baked from no longer committed (a CLI repoint that keeps its id): read-only, with why — not gone", async () => {
  // `set-roles` repointed the one scatter entry's y to lat: the id `scatter` is still produced,
  // so the card is not orphaned, but no entry declares sx/sy any more.
  const repointed = copy(M210);
  repointed.column_roles!.scatter![0].y_column = "lat";
  mount(rig(repointed));
  await layoutsView();
  const settings = within(card("Scatter")).getByRole("group", { name: "Scatter settings" });
  assert.deepEqual(selects(settings).map((s) => s.enabled), [false, false, false]);
  assert.match(settings.textContent ?? "", /the committed roles no longer declare the pair it was baked from/);
});

// --- 6. the entry can't be identified: read-only, with the reason ----------------------------

test("6. a pair declared twice and no fingerprint: read-only, with the reason — never a guess", async () => {
  const twice = pairDeclaredTwice(M29, [
    { lon_column: "lon", lat_column: "lat", label: "Flat" },
    { lon_column: "lon", lat_column: "lat", label: "Also flat" },
  ]);
  mount(rig(twice));
  await layoutsView();
  for (const name of ["Flat", "Also flat"]) {
    const settings = within(card(name)).getByRole("group", { name: `${name} settings` });
    assert.deepEqual(
      selects(settings),
      [{ name: `${name} projection`, enabled: false }, { name: `${name} overlap`, enabled: false }],
      `${name}: shown, and not editable`,
    );
    assert.match(settings.textContent ?? "", /its pair is declared more than once, and the designer can't commit roles that declare one pair twice/);
    pick(select(card(name), `${name} projection`), "mercator");
  }
  assert.equal(stored(), null, "nothing reached the draft");
});

test("6. a pre-2.9 bake records no provenance at all: its settings are read-only too, and say why", async () => {
  mount(rig(M28));
  await layoutsView();
  const settings = within(card("Location")).getByRole("group", { name: "Location settings" });
  assert.deepEqual(selects(settings).map((s) => s.enabled), [false, false]);
  assert.match(settings.textContent ?? "", /baked before layouts recorded their columns, so which declaration it was baked from can't be told/);
});

// --- 7. source columns stay read-only -----------------------------------------------------------

test("7. a baked card's source columns are not editable: only its settings are offered, and grid, datetime and categorical offer none", async () => {
  mount(rig());
  await layoutsView();
  assert.deepEqual(selects(card("Location")).map((s) => s.name), ["Location projection", "Location overlap"]);
  assert.deepEqual(selects(card("Scatter")).map((s) => s.name), ["Scatter axis scale", "Scatter placement", "Scatter overlap"]);
  for (const name of ["Grid", "By date", "Group", "Bucket"]) {
    assert.equal(selects(card(name)).length, 0, `${name} has no settings`);
  }
  assert.equal(within(card("Location")).queryAllByRole("textbox").length, 0, "no pair name field either");
});

// --- 8. scatter: the cross-knob locks, as on a queued card --------------------------------------

/** A queued lon/lat scatter beside the baked one — a pair picked on a new card. */
function queuedScatter(): PendingState {
  const s = seedPending(M210.column_roles);
  return addBake(withDraft(s, { ...s.draft!, scatterPairs: [...s.draft!.scatterPairs, { x: "lon", y: "lat", label: "" }] }), {
    kind: "new",
    type: "scatter",
    source_columns: ["lon", "lat"],
  });
}

test("8a. a knob changed on a QUEUED pair keeps it queued (client only; found building test 8)", async () => {
  // A knob changes no column, so the entry's key is unchanged; the swap found the entry
  // itself "already queued" and removed it, and the card vanished with the edit.
  persist(queuedScatter());
  mount(rig());
  await layoutsView();
  pick(select(screen.getByRole("article", { name: "Queued: lon / lat" }), "lon / lat axis scale"), "log");
  await waitFor(() => assert.equal(stored()?.draft?.scatterPairs[1]?.x_scale, "log"));
  assert.deepEqual(stored()?.bakes, [{ kind: "new", type: "scatter", source_columns: ["lon", "lat"] }], "still queued");
  assert.equal(screen.queryAllByRole("article", { name: "Queued: lon / lat" }).length, 1);
});


/** Each knob select's options as `value:disabled`, and the lines saying why — the whole lock
 *  surface a card shows, without its name. */
function lockSurface(el: HTMLElement, name: string): { scale: string[]; placement: string[]; notes: string[] } {
  const opts = (label: string): string[] =>
    [...select(el, `${name} ${label}`).options].map((o) => `${o.value}:${o.disabled ? "off" : "on"}`);
  return {
    scale: opts("axis scale"),
    placement: opts("placement"),
    notes: [...el.querySelectorAll(".knob-coming li")].map((li) => li.textContent ?? ""),
  };
}

test("8. scatter (client only — golden sx/sy refuse log and pass-through at the worker): a baked card locks exactly as a queued card does", async () => {
  persist(queuedScatter()); // so both cards are on screen
  mount(rig());
  await layoutsView();
  const baked = (): HTMLElement => card("Scatter");
  const queued = (): HTMLElement => screen.getByRole("article", { name: "Queued: lon / lat" });

  // Log locks placement "none", with why.
  pick(select(baked(), "Scatter axis scale"), "log");
  pick(select(queued(), "lon / lat axis scale"), "log");
  await waitFor(() => assert.equal(select(baked(), "Scatter axis scale").value, "log"));
  const logLocked = lockSurface(baked(), "Scatter");
  assert.deepEqual(logLocked.placement, ["fit:on", "none:off"], "log locks pass-through");
  assert.ok(logLocked.notes.some((n) => /^None — already 0\.\.1: not available together/.test(n)), logLocked.notes.join(" | "));
  assert.deepEqual(logLocked, lockSurface(queued(), "lon / lat"));

  // ...and the reverse: pass-through locks log.
  pick(select(baked(), "Scatter axis scale"), "linear");
  pick(select(queued(), "lon / lat axis scale"), "linear");
  pick(select(baked(), "Scatter placement"), "none");
  pick(select(queued(), "lon / lat placement"), "none");
  await waitFor(() => assert.equal(select(baked(), "Scatter placement").value, "none"));
  const noneLocked = lockSurface(baked(), "Scatter");
  assert.deepEqual(noneLocked.scale, ["linear:on", "log:off"], "pass-through locks log");
  assert.ok(noneLocked.notes.some((n) => /^Log: not available together/.test(n)), noneLocked.notes.join(" | "));
  assert.deepEqual(noneLocked, lockSurface(queued(), "lon / lat"));
});

// --- 9. 390 px ------------------------------------------------------------------------------------
//
// jsdom has no layout engine, so what is pinned is the DECLARATION that produces the fit — the
// same check L5's 390 px test runs over every `layouts-` rule — for the rules the baked
// settings actually use. The pixels are the real-browser check at 390 × 844.

const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

test("9. 390 px: the baked settings sit in the capped knob grid, and no rule they use has a fixed track or width", async () => {
  mount(rig());
  await layoutsView();
  for (const name of ["Location", "Scatter"]) {
    const settings = within(card(name)).getByRole("group", { name: `${name} settings` });
    const grids = [...settings.querySelectorAll(".knob-grid")];
    assert.ok(grids.length > 0);
    assert.ok(grids.every((g) => g.classList.contains("layouts-knobs")), `${name}: every knob grid is the card's capped one`);
    const used = new Set([settings, ...settings.querySelectorAll("*")].flatMap((e) => [...e.classList]).filter((c) => c.startsWith("layouts-")));
    const applied = rules.filter((r) => [...used].some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(r.selector)));
    assert.ok(applied.length >= used.size, `${name}: every layouts- class it uses has a rule (${[...used].join(", ")})`);
    for (const { selector, body } of applied) {
      for (const [, prop, value] of body.matchAll(/(?:^|;)\s*((?:min-)?width)\s*:\s*([^;]+)/g)) {
        const ok = value.trim() === "0" || value.trim() === "100%" || /^min\(/.test(value.trim());
        assert.ok(ok, `${selector} { ${prop}: ${value.trim()} } can exceed a 390 px viewport`);
      }
      for (const [, template] of body.matchAll(/grid-template-columns\s*:\s*([^;]+)/g)) {
        const uncapped = template.replace(/min\([^)]*100%\)/g, "");
        assert.doesNotMatch(uncapped, /\d(?:\.\d+)?(?:px|rem|em|ch|vw)\b/, `${selector} { grid-template-columns: ${template.trim()} } has a fixed track`);
      }
    }
  }
});
