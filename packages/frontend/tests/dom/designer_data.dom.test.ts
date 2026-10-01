// DOM tier — the designer's DATA view (seam L4; brief_designer_data_seam.md §3, tier-1
// tests 1–8), over the golden full fixture.
//
// WHERE EVERY SHAPE COMES FROM — production-shaped or nothing:
//   - the manifests are tests/designer_fixture/layout_manifest_2.10.json (records a
//     fingerprint), tests/fixtures/golden_dataset_full_v2/layout_manifest.json (2.8 —
//     records no columns at all) and tests/fixtures/golden_dataset_images_only_v2/
//     layout_manifest.json (no `column_roles`), all written by the real producer and only
//     READ here;
//   - `listLayouts` is built from the manifest as api/routers/layouts.py builds it with no
//     job in flight, INCLUDING `source_fingerprint` passed through (designerDom's
//     `layoutInfos` predates 2.10 and drops it);
//   - `listColumns` is designerDom's measured `parquet` answer for this fixture, and
//     `{source: "images_only", columns: []}` for the images-only tree — the answer the
//     route documents for a manifest with no `column_roles`;
//   - three states are not in any committed tree, so each is DERIVED from the 2.10
//     manifest by changing only `column_roles`, the way the named production path leaves
//     it, and says so where it is built: a 34-column CSV (ingest roles every column
//     freeform, T2-94), a roles-only commit that moved a role after the bake (D-xxix —
//     `run_set_roles` rewrites `column_roles` and nothing else), and a CLI-authored
//     column carrying two roles (brief §3).
//
// Every assertion is a count, a boolean or a string — never a live node (a failing
// assertion that formats one has hung a container here before).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesignerScreen } from "../../src/ui/designer/DesignerScreen.ts";
import { DataView } from "../../src/ui/designer/data.ts";
import type { DesignerViewProps } from "../../src/ui/designer/contract.ts";
import { addBake, derivePending, pendingStorageKey, seedPending, serializePending, withDraft } from "../../src/ui/designer/pending.ts";
import type { BakeEntry, PendingState } from "../../src/ui/designer/pending.ts";
import type { RolesDraft } from "../../src/ui/admin/roles.ts";
import type { ColumnListResponse, LayoutInfo } from "../../src/api-client/types.ts";
import type { ColumnRoles } from "../../src/generated/column_roles.ts";
import type { Presentation } from "../../src/generated/presentation.ts";
import type { DesignerTab } from "../../src/ui/urlState.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import { COLUMNS, DS_ID, OWNER, designerClient, summary } from "./designerDom.ts";
import type { DesignerRecorder } from "./designerDom.ts";

type FixtureManifest = LayoutManifest & {
  column_roles?: ColumnRoles;
  layouts: (LayoutManifest["layouts"][number] & {
    source_columns?: string[];
    source_fingerprint?: Record<string, unknown[][]>;
  })[];
};

function readManifest(url: URL): FixtureManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FixtureManifest;
}

const MANIFEST_210 = readManifest(new URL("../designer_fixture/layout_manifest_2.10.json", import.meta.url));
const MANIFEST_28 = readManifest(
  new URL("../../../../tests/fixtures/golden_dataset_full_v2/layout_manifest.json", import.meta.url),
);
const IMAGES_ONLY = readManifest(
  new URL("../../../../tests/fixtures/golden_dataset_images_only_v2/layout_manifest.json", import.meta.url),
);
const ROLES_210 = MANIFEST_210.column_roles as ColumnRoles;

/** `GET .../layouts` over a manifest, as the API serves it with nothing in flight. */
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

/** The 2.10 manifest with `column_roles` replaced — nothing else moves. */
function withRoles(roles: ColumnRoles): FixtureManifest {
  return { ...MANIFEST_210, column_roles: roles };
}

/** A fake client over `manifest` (designerDom's recorder, re-pointed). */
function dataClient(
  manifest: FixtureManifest,
  columns: ColumnListResponse = COLUMNS,
  opts: Pick<Parameters<typeof designerClient>[0] & object, "presentation" | "patch"> = {},
): DesignerRecorder {
  const rec = designerClient({
    ...opts,
    dataset: summary({
      image_count: manifest.dataset_metadata.image_count,
      layout_ids: manifest.layouts.map((l) => l.layout_id),
    }),
  });
  rec.client.getManifest = async () => manifest;
  rec.client.listLayouts = async () => infos(manifest);
  rec.client.listColumns = async () => columns;
  return rec;
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

function mount(rec: DesignerRecorder): void {
  render(
    h(DesignerScreen, {
      client: rec.client,
      datasetId: DS_ID,
      tab: "data",
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

async function dataView(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Data" });
}

function chipTexts(): string[] {
  return within(screen.getByRole("group", { name: "Show" }))
    .getAllByRole("button")
    .map((b) => b.textContent ?? "");
}

function expanded(group: string): string | null {
  const section = screen.getByRole("region", { name: group });
  return section.querySelector(".data-group-toggle")?.getAttribute("aria-expanded") ?? null;
}

function row(column: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-column="${column}"]`);
  assert.ok(el !== null, `no row for ${column}`);
  return el;
}

function pairRow(columns: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-pair="${columns}"]`);
  assert.ok(el !== null, `no pair row for ${columns}`);
  return el;
}

/** The consequence lines of one kind on a row, as text. */
function lines(el: HTMLElement, kind: string): string[] {
  return [...el.querySelectorAll(`[data-kind="${kind}"]`)].map((e) => e.textContent ?? "");
}

function barText(): string {
  return screen.getByRole("contentinfo", { name: "Pending changes" }).textContent ?? "";
}

function selectRole(column: string, choice: string): void {
  fireEvent.change(screen.getByRole("combobox", { name: `Role for column ${column}` }), { target: { value: choice } });
}

// --- 1. grouping and folding --------------------------------------------------------------

/** The RoleDensity board's 34 columns. DERIVED: ingest roles every CSV column `freeform`
 *  by default (T2-94), so a 34-column CSV commits a `column_roles` naming all 34 and the
 *  columns route lists all 34 (`_declared_columns`). The golden 10 plus 24 more freeform
 *  columns — the only change to the 2.10 manifest — with the matching columns answer. */
const EXTRA = Array.from({ length: 24 }, (_, i) => `extra_${String(i + 1).padStart(2, "0")}`);
const WIDE = withRoles({
  ...ROLES_210,
  freeform: [...(ROLES_210.freeform ?? []), ...EXTRA.map((c) => ({ column: c, label: c }))],
});
const WIDE_COLUMNS: ColumnListResponse = {
  source: "parquet",
  columns: [...COLUMNS.columns, ...EXTRA.map((c, i) => ({ name: c, dtype: "VARCHAR", sample: `value-${i}` }))],
};

test("34 columns land in three groups by outcome: Assigned open, Display only and Ignored folded", async () => {
  mount(dataClient(WIDE, WIDE_COLUMNS));
  await dataView();
  // By COLUMN: filename, captured, group, bucket, tags + the two pairs' four axes = 9
  // assigned (the Data door's own count); caption + 24 extras are Display only.
  assert.deepEqual(chipTexts(), ["All 34", "Assigned 9", "Display only 25", "Ignored 0", "Changed 0"]);
  assert.equal(expanded("Assigned"), "true");
  assert.equal(expanded("Display only"), "false");
  assert.equal(expanded("Ignored"), "false");
  // Only the open group draws rows: five column rows and the two pointer rows.
  assert.equal(document.querySelectorAll("[data-column]").length, 5);
  assert.equal(document.querySelectorAll("[data-pair]").length, 2);
  assert.equal(
    within(screen.getByRole("region", { name: "Assigned" })).queryAllByRole("combobox", { name: /^Role for column / }).length,
    5,
  );

  // Bulk role on a folded group: open it, pick four, set them to Ignore — one action.
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  assert.equal(document.querySelectorAll("[data-column]").length, 5 + 25);
  for (const c of EXTRA.slice(0, 4)) fireEvent.click(screen.getByRole("checkbox", { name: `Select column ${c}` }));
  fireEvent.change(screen.getByRole("combobox", { name: "Role for the selected Display only columns" }), {
    target: { value: "ignore" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  assert.deepEqual(chipTexts(), ["All 34", "Assigned 9", "Display only 21", "Ignored 4", "Changed 4"]);
  assert.match(barText(), /4 invalidating role changes/);
});

test("the Changed chip counts derived.changedColumns — a new pair moves no Role select, and still counts", async () => {
  // A scatter over `lon, lat`, picked on the Layouts tab (L5's Add → Scatter). `lon` and `lat`
  // are the map's axes and have no Role select of their own, but they gain a way of being
  // read, so `changedColumns` names both — and so must the chip: a count of rows whose SELECT
  // moved would say 0 here. (This was a datetime format repair until D-xxxiii removed the
  // format control.)
  const rec = dataClient(MANIFEST_210);
  const view = render(shellOn(rec, "data"));
  await dataView();
  assert.equal(chipTexts().at(-1), "Changed 0");
  view.rerender(shellOn(rec, "layouts"));
  fireEvent.click(within(await screen.findByRole("group", { name: "Add a layout" })).getByRole("button", { name: "Scatter" }));
  const picker = await screen.findByRole("article", { name: "New scatter layout" });
  fireEvent.change(within(picker).getByLabelText("New scatter layout X column"), { target: { value: "lon" } });
  fireEvent.change(within(picker).getByLabelText("New scatter layout Y column"), { target: { value: "lat" } });
  view.rerender(shellOn(rec, "data"));
  await dataView();
  assert.equal(chipTexts().at(-1), "Changed 2");
  // ...while the bar counts the one thing the owner edited, the pair (operator, 2026-09-28):
  // the chip counts rows, the bar role changes.
  assert.match(barText(), /1 invalidating role change(?!s)/);
  fireEvent.click(screen.getByRole("button", { name: "Changed 2" }));
  // The chip NARROWS the table: every row it shows reads a changed column, and every row that
  // reads none is gone. All ten column rows and the `sx, sy` pair read neither `lon` nor `lat`.
  // (The map's own `lon, lat` row reads them too, so it is shown as well — measured; this pin
  // does not care either way.)
  const pairs = [...document.querySelectorAll("[data-pair]")].map((e) => `${e.getAttribute("data-family")}:${e.getAttribute("data-pair")}`);
  assert.equal(document.querySelectorAll("[data-column]").length, 0, "no column row changed");
  assert.equal(pairs.includes("scatter:lon,lat"), true, `the new scatter's row is shown: ${pairs.join(" | ")}`);
  assert.equal(pairs.includes("scatter:sx,sy"), false, `the pair it did not touch is hidden: ${pairs.join(" | ")}`);
});

test("while a filter narrows the table, a group's fold button still folds it", async () => {
  // Second review of #384, #7: `isOpen = narrowed || open[group]`, but the caret flipped only
  // `open[group]` — under a filter the button did nothing and aria-expanded stayed true.
  mount(dataClient(MANIFEST_210));
  await dataView();
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter columns" }), { target: { value: "grou" } });
  assert.equal(expanded("Assigned"), "true", "a narrowed view opens what it narrowed to");
  fireEvent.click(within(screen.getByRole("region", { name: "Assigned" })).getByRole("button", { expanded: true }));
  assert.equal(expanded("Assigned"), "false");
  assert.equal(document.querySelectorAll('[data-column="group"]').length, 0);
});

// --- 2. a role change writes through withDraft, and nothing else ---------------------------

/** DataView rendered directly, with every callback recorded — the shell's props, frozen. */
interface Spied {
  rec: DesignerRecorder;
  pendingWrites: PendingState[];
  presentationWrites: number;
}

function renderDirect(): { spied: Spied; before: PendingState } {
  const rec = dataClient(MANIFEST_210);
  const layouts = infos(MANIFEST_210);
  const pending = seedPending(ROLES_210, {});
  const spied: Spied = { rec, pendingWrites: [], presentationWrites: 0 };
  const props: DesignerViewProps = {
    client: rec.client,
    dataset: summary(),
    manifest: MANIFEST_210,
    layouts,
    presentation: {},
    columns: COLUMNS,
    columnsError: null,
    pending,
    derived: derivePending(pending, layouts),
    onPendingChange: (next) => spied.pendingWrites.push(next),
    onPresentationChange: () => {
      spied.presentationWrites += 1;
    },
    onDatasetChange: () => {},
    reload: () => {},
    onNavigate: () => {},
    onAuthExpired: () => {},
  };
  render(h(DataView, props));
  return { spied, before: pending };
}

test("a role change writes through withDraft and nothing else — no PATCH, no bake, no presentation write", async () => {
  const { spied, before } = renderDirect();
  selectRole("bucket", "freeform");
  await act(async () => {});
  assert.equal(spied.pendingWrites.length, 1, "one write to the pending model");
  const next = spied.pendingWrites[0];
  // withDraft replaces the draft and NOTHING else: the committed map, the seed and the
  // bake queue are the very same objects.
  assert.equal(next.committed === before.committed, true);
  assert.equal(next.seed === before.seed, true);
  assert.equal(next.bakes === before.bakes, true);
  assert.equal(next.draft?.choice.bucket, "freeform");
  assert.deepEqual({ ...next.draft, choice: { ...next.draft?.choice, bucket: "categorical" } }, before.draft);
  assert.equal(spied.rec.patches.length, 0, "a role is never a presentation PATCH");
  assert.equal(spied.presentationWrites, 0);
});

// --- 3. a label edit PATCHes only its own key and never reaches the bar --------------------

test("a label edit PATCHes only columns.<name>.label, and never enters the pending model or the bar", async () => {
  const rec = dataClient(MANIFEST_210);
  mount(rec);
  await dataView();
  const input = screen.getByRole("textbox", { name: "Display name for column group" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "  Department " } });
  await act(async () => {
    fireEvent.blur(input);
  });
  await screen.findByText("Saved");
  assert.deepEqual(rec.patches, [{ columns: { group: { label: "Department" } } }]);
  assert.match(barText(), /Nothing pending/, "derived.invalidating is unchanged");
  assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null, "nothing entered the pending model");

  // Hidden is the same kind of edit: its own key, at once.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Hide column group in the inspector" }));
  });
  await waitFor(() => assert.equal(rec.patches.length, 2));
  assert.deepEqual(rec.patches[1], { columns: { group: { hidden: true } } });
  assert.equal(
    screen.getByRole("button", { name: "Hide column group in the inspector" }).getAttribute("aria-pressed"),
    "true",
    "the shell holds the echoed record",
  );
  assert.match(barText(), /Nothing pending/);
  assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null);
});

test("two presentation saves landing in the same tick both survive", async () => {
  // Hide two columns; both PATCHes resolve together. Each save must merge into the record
  // as the LAST save left it, not as the last render saw it, or the second overwrites the
  // first (review of #384, F5: `groupPressed=false bucketPressed=true`).
  const resolvers: (() => void)[] = [];
  const rec = dataClient(MANIFEST_210, COLUMNS, {
    patch: () => new Promise((resolve) => resolvers.push(() => resolve({ dataset_id: DS_ID }))),
  });
  mount(rec);
  await dataView();
  fireEvent.click(screen.getByRole("button", { name: "Hide column group in the inspector" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide column bucket in the inspector" }));
  await waitFor(() => assert.equal(resolvers.length, 2));
  await act(async () => {
    for (const resolve of resolvers) resolve();
  });
  const pressed = (c: string): string | null =>
    screen.getByRole("button", { name: `Hide column ${c} in the inspector` }).getAttribute("aria-pressed");
  assert.deepEqual([pressed("group"), pressed("bucket")], ["true", "true"]);
});

test("a label or hidden edit on a LEGACY link column keeps the link", async () => {
  // DERIVED legacy shape: a manifest <= 2.8 whose `column_roles` still carries the pre-2.9
  // `url` role, and no presentation.json. The API serves the link from that role ONLY
  // while the record has no entry for the column (`presentation.effective_columns`), so
  // GET .../presentation answers `{columns: {group: {render: "url"}}}` — and the first
  // PATCH that creates an entry switches it off for good unless it carries `render` too
  // (review of #384, F1). rijks_pilot is this shape (2.7, `url: ["source_url"]`).
  const legacy = { ...MANIFEST_28, column_roles: { ...MANIFEST_28.column_roles, url: ["group"] } } as FixtureManifest;
  const rec = dataClient(legacy, COLUMNS, { presentation: { columns: { group: { render: "url" } } } });
  mount(rec);
  await dataView();
  const input = screen.getByRole("textbox", { name: "Display name for column group" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Department" } });
  await act(async () => {
    fireEvent.blur(input);
  });
  await waitFor(() => assert.equal(rec.patches.length, 1));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Hide column group in the inspector" }));
  });
  await waitFor(() => assert.equal(rec.patches.length, 2));
  assert.deepEqual(rec.patches, [
    { columns: { group: { label: "Department", render: "url" } } },
    { columns: { group: { hidden: true, render: "url" } } },
  ]);
  assert.equal((screen.getByRole("checkbox", { name: "Render column group as a link" }) as HTMLInputElement).checked, true);
});

/** A client whose PATCHes are held until released, in the order they were sent. `release`
 *  keeps going until nothing is held — a field sends its waiting value when the PATCH before
 *  it settles, so releasing one can send another. */
function heldClient(manifest: FixtureManifest, presentation: Presentation): { rec: DesignerRecorder; release: () => Promise<void> } {
  const resolvers: (() => void)[] = [];
  const rec = dataClient(manifest, COLUMNS, {
    presentation,
    patch: () => new Promise((resolve) => resolvers.push(() => resolve({ dataset_id: DS_ID }))),
  });
  return {
    rec,
    release: async () => {
      while (resolvers.length > 0) {
        await act(async () => {
          for (const resolve of resolvers.splice(0)) resolve();
        });
      }
    },
  };
}

/** A client whose PATCHes wait until each is settled on command, oldest first — `ok()` or
 *  `fail(status)` (a 503 is what `dataset_lock` timing out surfaces as). */
function scriptedClient(manifest: FixtureManifest, presentation: Presentation): {
  rec: DesignerRecorder;
  ok: () => Promise<void>;
  fail: (status: number) => Promise<void>;
} {
  const waiting: { resolve: (v: { dataset_id: string }) => void; reject: (e: unknown) => void }[] = [];
  const rec = dataClient(manifest, COLUMNS, {
    presentation,
    patch: () => new Promise((resolve, reject) => waiting.push({ resolve, reject })),
  });
  const settle = async (how: (w: (typeof waiting)[number]) => void): Promise<void> => {
    await waitFor(() => assert.ok(waiting.length > 0, "a PATCH is waiting"));
    await act(async () => {
      how(waiting.shift()!);
    });
  };
  return {
    rec,
    ok: () => settle((w) => w.resolve({ dataset_id: DS_ID })),
    fail: (status) => settle((w) => w.reject(Object.assign(new Error("lock unavailable"), { status, detail: "dataset is busy" }))),
  };
}

test("an older label save that succeeded is not forgotten when a newer one fails", async () => {
  // Round-4 review of #384, #2. "A" then leave, "B" then leave; A succeeds, B fails (503).
  // The success of the overtaken save was thrown away, so the store believed the stored label
  // was still the one it started with — and clearing the field then sent NOTHING, leaving an
  // empty field over a server holding "A".
  const { rec, ok, fail } = scriptedClient(MANIFEST_210, {});
  mount(rec);
  await dataView();
  const input = screen.getByRole("textbox", { name: "Display name for column group" }) as HTMLInputElement;
  const leaveWith = async (value: string): Promise<void> => {
    fireEvent.change(input, { target: { value } });
    await act(async () => {
      fireEvent.blur(input);
    });
  };
  await leaveWith("A");
  await leaveWith("B");
  await ok();
  await fail(503);
  await screen.findByText("dataset is busy");
  await leaveWith("");
  await waitFor(() => assert.equal(rec.patches.length, 3));
  assert.deepEqual(rec.patches, [
    { columns: { group: { label: "A" } } },
    { columns: { group: { label: "B" } } },
    { columns: { group: { label: null } } },
  ]);
});

test("a Hide that succeeded then an un-Hide that failed shows the column hidden, as the server has it", async () => {
  // Round-4 review of #384, #2: two clicks; the first lands, the second 503s. The button showed
  // "shown" while the server held `hidden: true`.
  const { rec, ok, fail } = scriptedClient(MANIFEST_210, {});
  mount(rec);
  await dataView();
  const hide = (): HTMLElement => screen.getByRole("button", { name: "Hide column group in the inspector" });
  fireEvent.click(hide());
  fireEvent.click(hide());
  await ok();
  await fail(503);
  await screen.findByText("dataset is busy");
  assert.equal(hide().getAttribute("aria-pressed"), "true");
  assert.deepEqual(rec.patches, [{ columns: { group: { hidden: true } } }, { columns: { group: { hidden: null } } }]);
});

/** A fake server that APPLIES each PATCH (as `apply_updates` does, key by key) when it is
 *  released, and — once `holdReads` is set — answers a presentation READ with what it held
 *  AT THE MOMENT OF THE READ, only when released: a reload that reads before a save applies
 *  and answers after it lands, which is the ordering the final review of #384 found. */
function applyingServer(): {
  rec: DesignerRecorder;
  held: (() => void)[];
  holdReads: () => void;
  releaseReads: () => Promise<void>;
} {
  const server: Presentation = {};
  const held: (() => void)[] = [];
  const reads: (() => void)[] = [];
  let hold = false;
  const rec = dataClient(MANIFEST_210);
  rec.client.getPresentation = () => {
    const snapshot = JSON.parse(JSON.stringify(server)) as Presentation;
    return hold ? new Promise((resolve) => reads.push(() => resolve(snapshot))) : Promise.resolve(snapshot);
  };
  rec.client.setDatasetPresentation = (_ds, body) => {
    rec.patches.push(body as Record<string, unknown>);
    return new Promise((resolve) =>
      held.push(() => {
        const columns = (server.columns ??= {}) as Record<string, Record<string, unknown>>;
        for (const [column, entry] of Object.entries(body.columns ?? {})) {
          const next = { ...(columns[column] ?? {}) };
          for (const [k, v] of Object.entries(entry ?? {})) {
            if (v === null) delete next[k];
            else next[k] = v;
          }
          columns[column] = next;
        }
        resolve({ dataset_id: DS_ID });
      }),
    );
  };
  return {
    rec,
    held,
    holdReads: () => {
      hold = true;
    },
    releaseReads: async () => {
      await act(async () => {
        for (const read of reads.splice(0)) read();
      });
    },
  };
}

function shellOn(rec: DesignerRecorder, tab: DesignerTab): ReactElement {
  return h(DesignerScreen, {
    client: rec.client,
    datasetId: DS_ID,
    tab,
    username: OWNER,
    onNavigate: () => {},
    onBack: () => {},
    onOpenAtlas: () => {},
    onUnavailable: () => {},
    onDeleted: () => {},
    onAuthExpired: () => {},
  });
}

/** Type a label on `group`, switch to Overview (the switch flushes that save), come back,
 *  Hide `bucket`; then let the two saves land in `order`, and any presentation read the
 *  landings caused answer last. Both edits must survive on screen, as on the server. */
async function closedTabSaves(order: "label first" | "hide first"): Promise<void> {
  const { rec, held, holdReads, releaseReads } = applyingServer();
  const view = render(shellOn(rec, "data"));
  await dataView();
  holdReads();
  fireEvent.change(screen.getByRole("textbox", { name: "Display name for column group" }), { target: { value: "Grp" } });
  view.rerender(shellOn(rec, "overview"));
  await waitFor(() => assert.equal(held.length, 1, "leaving the tab flushed the label save"));
  view.rerender(shellOn(rec, "data"));
  await dataView();
  fireEvent.click(screen.getByRole("button", { name: "Hide column bucket in the inspector" }));
  await waitFor(() => assert.equal(held.length, 2));
  const [labelSave, hideSave] = held;
  for (const land of order === "label first" ? [labelSave, hideSave] : [hideSave, labelSave]) {
    await act(async () => land());
  }
  await releaseReads();
  assert.equal(screen.getByRole("button", { name: "Hide column bucket in the inspector" }).getAttribute("aria-pressed"), "true");
  assert.equal((screen.getByRole("textbox", { name: "Display name for column group" }) as HTMLInputElement).value, "Grp");
}

test("a label save landing after the Data tab closed, then a Hide, both survive", async () => {
  // Final review of #384, Regression A — the round-4 fix re-read the record after a late
  // save, and that read, not ordered against saves, answered after the Hide landed and
  // flipped `bucket` back to "shown". Each landing now merges its own key onto the shell's
  // CURRENT record, so no read happens and no order can lose an edit.
  await closedTabSaves("label first");
});

test("a Hide, then a label save landing after the Data tab closed, both survive", async () => {
  // Round-4 review of #384, #3: the late label save handed the shell the closed view's
  // stale record, which knew nothing of the Hide, and `bucket` flipped back to "shown".
  await closedTabSaves("hide first");
});

test("a save landing after the Data tab closed does not clear pending role changes when storage is blocked", async () => {
  // Final review of #384, Regression B: the round-4 fix's reload rebuilt the pending model
  // from localStorage, so with storage blocked (which the app supports) a late label save
  // turned "1 invalidating role change" into "Nothing pending".
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage blocked");
    },
  });
  try {
    const { rec, held, holdReads, releaseReads } = applyingServer();
    const view = render(shellOn(rec, "data"));
    await dataView();
    holdReads();
    selectRole("bucket", "freeform");
    assert.match(barText(), /1 invalidating role change(?!s)/);
    fireEvent.change(screen.getByRole("textbox", { name: "Display name for column group" }), { target: { value: "Grp" } });
    view.rerender(shellOn(rec, "overview"));
    await waitFor(() => assert.equal(held.length, 1));
    await act(async () => held[0]());
    await releaseReads();
    assert.match(barText(), /1 invalidating role change(?!s)/);
  } finally {
    if (saved !== undefined) Object.defineProperty(globalThis, "localStorage", saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("a label typed away and back while its save is in flight ends as typed", async () => {
  // Second review of #384, #1: `Foo` stored; type `Foox` and leave (PATCH in flight); type
  // `Foo` and leave. The second save compared against what had LANDED (`Foo`), called it
  // unchanged and sent nothing — so `Foox` landed and stayed while the field showed `Foo`.
  const { rec, release } = heldClient(MANIFEST_210, { columns: { group: { label: "Foo" } } });
  mount(rec);
  await dataView();
  const input = screen.getByRole("textbox", { name: "Display name for column group" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Foox" } });
  fireEvent.blur(input);
  await waitFor(() => assert.equal(rec.patches.length, 1));
  fireEvent.change(input, { target: { value: "Foo" } });
  fireEvent.blur(input);
  await release();
  assert.deepEqual(rec.patches, [{ columns: { group: { label: "Foox" } } }, { columns: { group: { label: "Foo" } } }]);
});

test("two quick Hide clicks hide and then show, and the toggles show what was asked at once", async () => {
  // Second review of #384, #2: the next state came from what had LANDED, so a second click
  // before the first returned sent `hidden: true` again. And the link box, drawn from the
  // landed record, snapped back to ticked until its untick returned — inviting a 2nd click.
  const { rec, release } = heldClient(MANIFEST_210, { columns: { group: { render: "url" } } });
  mount(rec);
  await dataView();
  const hide = (): HTMLElement => screen.getByRole("button", { name: "Hide column group in the inspector" });
  const link = (): HTMLInputElement => screen.getByRole("checkbox", { name: "Render column group as a link" }) as HTMLInputElement;
  fireEvent.click(hide());
  fireEvent.click(hide());
  fireEvent.click(link());
  // One PATCH in flight per field (round-4 #2): the second Hide waits for the first.
  await waitFor(() => assert.equal(rec.patches.length, 2));
  assert.deepEqual([hide().getAttribute("aria-pressed"), link().checked], ["false", false], "what was asked, before anything lands");
  await release();
  // The waiting un-Hide goes out after the untick was asked for, so it carries no link.
  assert.deepEqual(rec.patches, [
    { columns: { group: { hidden: true, render: "url" } } },
    { columns: { group: { render: null } } },
    { columns: { group: { hidden: null } } },
  ]);
  assert.deepEqual([hide().getAttribute("aria-pressed"), link().checked], ["false", false]);
});

test("a presentation record reloaded from elsewhere reaches the label fields", async () => {
  // Second review of #384, #5: the typed text was seeded once, at mount. After the shell
  // re-reads the record (a reload, a version bump), leaving a field re-sent the OLD text over
  // the reloaded label — and a column new to the list had "" and cleared its label.
  const layouts = infos(MANIFEST_210);
  const pending = seedPending(ROLES_210, {});
  const rec = dataClient(MANIFEST_210);
  const props = (presentation: Presentation): DesignerViewProps => ({
    client: rec.client,
    dataset: summary(),
    manifest: MANIFEST_210,
    layouts,
    presentation,
    columns: COLUMNS,
    columnsError: null,
    pending,
    derived: derivePending(pending, layouts),
    onPendingChange: () => {},
    onPresentationChange: () => {},
    onDatasetChange: () => {},
    reload: () => {},
    onNavigate: () => {},
    onAuthExpired: () => {},
  });
  const view = render(h(DataView, props({ columns: { group: { label: "Old" } } })));
  view.rerender(h(DataView, props({ columns: { group: { label: "Reloaded" }, bucket: { label: "Bucket label" } } })));
  const field = (c: string): HTMLInputElement => screen.getByRole("textbox", { name: `Display name for column ${c}` }) as HTMLInputElement;
  assert.deepEqual([field("group").value, field("bucket").value], ["Reloaded", "Bucket label"]);
  await act(async () => {
    fireEvent.blur(field("group"));
    fireEvent.blur(field("bucket"));
  });
  assert.equal(rec.patches.length, 0, "leaving an untouched field sends nothing");
});

test("a free edit's save redraws its own field, not the table", async () => {
  // Second review of #384, #8. Save status held as table state, and rows drawn afresh on
  // every render, made each save redraw every row twice — measured at 500 columns (jsdom):
  // a Hide click 722-743 ms to send and 362-380 ms to land, against 5-6 and 26-29 ms once
  // status lives in each field and unchanged rows are reused. Timings differ by machine, so
  // this pin is a RATIO within one run: sending and landing a save must each cost under a
  // tenth of drawing the open group once. The 200-column table is DERIVED as in test 1.
  const extra = Array.from({ length: 190 }, (_, i) => `wide_${String(i).padStart(3, "0")}`);
  const wide = withRoles({ ...ROLES_210, freeform: [...(ROLES_210.freeform ?? []), ...extra.map((c) => ({ column: c, label: c }))] });
  const columns: ColumnListResponse = {
    source: "parquet",
    columns: [...COLUMNS.columns, ...extra.map((c, i) => ({ name: c, dtype: "VARCHAR", sample: `v${i}` }))],
  };
  const resolvers: (() => void)[] = [];
  const rec = dataClient(wide, columns, {
    patch: () => new Promise((resolve) => resolvers.push(() => resolve({ dataset_id: DS_ID }))),
  });
  mount(rec);
  await dataView();
  let t = performance.now();
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  const drawGroup = performance.now() - t;
  const send: number[] = [];
  const land: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const hide = screen.getByRole("button", { name: `Hide column ${extra[i]} in the inspector` });
    t = performance.now();
    await act(async () => {
      fireEvent.click(hide);
    });
    send.push(performance.now() - t);
    t = performance.now();
    await act(async () => {
      resolvers.shift()?.();
    });
    land.push(performance.now() - t);
  }
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[2];
  const ratios = { send: +(median(send) / drawGroup).toFixed(3), land: +(median(land) / drawGroup).toFixed(3) };
  assert.equal(ratios.send < 0.1 && ratios.land < 0.1, true, `save cost / group draw: ${JSON.stringify(ratios)} (group ${drawGroup.toFixed(0)} ms)`);
});

test("unticking a link and hiding before the untick lands does not turn the link back on", async () => {
  // Round-2 review of #384, N1 — a regression of the F1 fix. The carry read the record as of
  // the last save that LANDED, so a Hide dispatched while an untick was in flight re-sent
  // `render: "url"` and `apply_updates` stored the link again under an unticked box. Measured
  // bodies before the fix: `[{render: null}, {hidden: true, render: "url"}]`.
  const resolvers: (() => void)[] = [];
  const rec = dataClient(MANIFEST_210, COLUMNS, {
    presentation: { columns: { group: { render: "url" } } },
    patch: () => new Promise((resolve) => resolvers.push(() => resolve({ dataset_id: DS_ID }))),
  });
  mount(rec);
  await dataView();
  fireEvent.click(screen.getByRole("checkbox", { name: "Render column group as a link" }));
  await waitFor(() => assert.equal(resolvers.length, 1));
  fireEvent.click(screen.getByRole("button", { name: "Hide column group in the inspector" }));
  await waitFor(() => assert.equal(resolvers.length, 2));
  await act(async () => {
    for (const resolve of resolvers) resolve();
  });
  assert.deepEqual(rec.patches, [{ columns: { group: { render: null } } }, { columns: { group: { hidden: true } } }]);
  assert.equal((screen.getByRole("checkbox", { name: "Render column group as a link" }) as HTMLInputElement).checked, false);
});

// --- 4. the row's consequence: this edit vs the durable record -----------------------------

/** A roles-only commit moved `captured` to unix_seconds after its iso8601 bake. DERIVED:
 *  `set-roles` checks only that the column is a timestamp, so it accepts any format there
 *  (measured 2026-09-25 on a copy of this tree: `unix_millis` exit 0). By date's record
 *  still says iso8601, so it is DURABLY stale on a screen with nothing pending. */
const FORMAT_MOVED = withRoles({ ...ROLES_210, datetime: { ...ROLES_210.datetime!, format: "unix_seconds" } });

/** A roles-only commit took the datetime role off `captured` (Freeform, committed with no
 *  bake), which this view and the review's "Commit role change — no bake" can do. MEASURED
 *  2026-09-26 with `pixscope set-roles` (main's worker) on a copy of this tree: exit 0, only
 *  `column_roles` moved (`datetime` gone, `captured` appended to `freeform`), and By date
 *  reported stale and no longer producible. Its tiles keep serving; its record says iso8601. */
const UNDATED = withRoles({
  ...ROLES_210,
  datetime: undefined,
  freeform: [...(ROLES_210.freeform ?? []), { column: "captured", label: "Captured" }],
});

/** A roles-only commit set `captured` to unix_millis over its stored timestamps. MEASURED
 *  2026-09-26 with main's `pixscope set-roles` on a copy of this tree: exit 0, one manifest
 *  key moved (`column_roles.datetime.format`), By date reported stale. Only the CLI could do
 *  it: the Data view never offered it on a timestamp, and #391's worker refuses it. */
const MILLIS = withRoles({ ...ROLES_210, datetime: { ...ROLES_210.datetime!, format: "unix_millis" } });

/** Persist a pending draft (and queue) for `roles`, as L5's cards would have left it, for
 *  the shell to restore through its real `loadPending` path. */
function persistDraft(roles: ColumnRoles, change: (d: RolesDraft) => void, bakes: BakeEntry[] = []): void {
  const seeded = seedPending(roles);
  const draft = JSON.parse(JSON.stringify(seeded.draft)) as RolesDraft;
  change(draft);
  const state = bakes.reduce((s, b) => addBake(s, b), withDraft(seeded, draft));
  localStorage.setItem(pendingStorageKey(DS_ID), serializePending(state, 1));
}

test("a queued layout shows on the row of its own family's pair, not another pair over the same columns", async () => {
  // Review of #384, F7. L5 queues a NEW scatter over `lon, lat` (the pair is added to the
  // draft, then the bake queued — CONTRACT §3). The geographic pair over the same two
  // columns is a different layout; the queued scatter is not "on" it.
  persistDraft(
    ROLES_210,
    (d) => {
      d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
    },
    [{ kind: "new", type: "scatter", source_columns: ["lon", "lat"] }],
  );
  mount(dataClient(MANIFEST_210));
  await dataView();
  const queued = (family: string): number =>
    document.querySelector(`[data-pair="lon,lat"][data-family="${family}"]`)?.querySelectorAll(".data-queued").length ?? -1;
  assert.deepEqual([queued("scatter"), queued("geographic")], [1, 0]);
});

test("an edit that stales a layout names it on the row; a layout already stale is shown as durable, not blamed", async () => {
  // The pending edit is L5's: the Location card's projection moved to Mercator (set-roles
  // accepts it on this data — |lat| <= 78, measured 2026-09-25). By date is durably stale
  // from an earlier commit (FORMAT_MOVED). Each row must say which is which.
  persistDraft(FORMAT_MOVED.column_roles as ColumnRoles, (d) => {
    d.geoPairs[0].projection = "mercator";
  });
  mount(dataClient(FORMAT_MOVED));
  await dataView();
  assert.deepEqual(lines(pairRow("lon,lat"), "edit-stale"), [
    "⚠ Stales Location, which was baked from these columns. It keeps serving until re-baked.",
  ]);
  assert.equal(lines(pairRow("lon,lat"), "baked-stale").length, 0);
  // By date is durably stale — and NOT this edit's doing.
  assert.equal(lines(row("captured"), "edit-stale").length, 0);
  assert.equal(lines(row("captured"), "baked-stale").length, 1);
  assert.match(lines(row("captured"), "baked-stale")[0], /By date is already stale/);
  assert.match(barText(), /stales Location/);
  assert.doesNotMatch(barText(), /By date/);
});

test("a layout stale from an earlier commit is not attributed to an edit of the very column it reads", async () => {
  // UNDATED, then `captured` made the datetime again. The column changed; By date is still
  // stale as committed; the edit is not what staled it — under the draft its record matches
  // again. (This was a datetime format repair until D-xxxiii removed the format control.)
  mount(dataClient(UNDATED));
  await dataView();
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  assert.equal(lines(row("captured"), "baked-stale").length, 1, "durable, before anything is edited");
  selectRole("captured", "datetime");
  assert.equal(row("captured").querySelectorAll(".data-changed").length, 1, "the column did change");
  assert.equal(lines(row("captured"), "edit-stale").length, 0, "the edit is not blamed");
  assert.equal(lines(row("captured"), "baked-stale").length, 1, "the durable verdict is shown as itself");
  assert.match(barText(), /nothing stale/);
});

test("a pre-2.9 collection claims no layout is missing, and says once per edited row what it cannot check", async () => {
  // The golden tree exactly as committed (manifest 2.8 — what the dev stack serves): no
  // layout records its columns, so which one a column feeds cannot be told. "No layout
  // yet" and "Build one" would both be false claims about layouts that exist.
  mount(dataClient(MANIFEST_28));
  await dataView();
  assert.equal(screen.queryAllByText(/no layout (yet|uses it yet)/).length, 0);
  assert.equal(screen.queryAllByRole("button", { name: "Build one" }).length, 0);
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  selectRole("caption", "ignore");
  assert.deepEqual(lines(row("caption"), "edit-unknown"), [
    "⚠ 5 layouts are unchecked — By date, Scatter, Group, Bucket, Location were baked before layouts recorded their columns, so this change can't be checked against them.",
  ]);
  assert.match(barText(), /5 layouts unchecked/);
});

test("a column losing its role says its layout can't be re-baked — not also that a re-bake fixes it", async () => {
  // Review of #384, F6: `bucket` → Freeform on the 2.10 tree makes `categorical_bucket` both
  // stale and orphaned in the model. "Stales Bucket … keeps serving until re-baked" beside
  // "Bucket can't be re-baked" contradicts itself; the orphan sentence alone is the truth.
  mount(dataClient(MANIFEST_210));
  await dataView();
  selectRole("bucket", "freeform");
  assert.deepEqual(lines(row("bucket"), "edit-orphaned"), [
    "⚠ Bucket can't be re-baked — with this role gone, nothing can rebuild it. It keeps serving what it has.",
  ]);
  assert.equal(lines(row("bucket"), "edit-stale").length, 0);
  // The other categorical is untouched and only renamed.
  assert.equal(lines(row("group"), "edit-renamed").length, 1);
});

test("a layout both renamed and staled reads as one stale line that names the new id", async () => {
  // Second review of #384, #4: `stale` and `renamedTo` are not exclusive (LayoutOutcome), and
  // the row printed "Stales Scatter … keeps serving until re-baked" beside "Scatter is not
  // affected — nothing stale". The pending edit is L5's (restored through loadPending): the
  // Scatter card's scale moved to log (stale), and a second scatter pair over `lon, lat`
  // made the family two, so `scatter` next bakes as `scatter_sx` (renamed).
  persistDraft(ROLES_210, (d) => {
    d.scatterPairs[0] = { ...d.scatterPairs[0], x_scale: "log", y_scale: "log" };
    d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
  });
  mount(dataClient(MANIFEST_210));
  await dataView();
  const scatter = document.querySelector<HTMLElement>('[data-pair="sx,sy"][data-family="scatter"]');
  assert.ok(scatter !== null);
  assert.equal(lines(scatter, "edit-renamed").length, 0, "never 'not affected — nothing stale' beside a stale");
  assert.deepEqual(lines(scatter, "edit-stale"), [
    "⚠ Stales Scatter, which was baked from these columns. It keeps serving until re-baked — and that bake files it as scatter_sx.",
  ]);
});

test("on a pre-2.9 collection the edited row names the layouts the edit orphans", async () => {
  // Review of #384, F4. Setting `group` to Freeform leaves one categorical, so neither
  // `categorical_group` nor `categorical_bucket` is produced any more; with no recorded
  // columns neither can be shown to be a rename, so both are orphaned (and unchecked). The
  // bar says "2 layouts can't be re-baked"; the row must say which two.
  mount(dataClient(MANIFEST_28));
  await dataView();
  selectRole("group", "freeform");
  assert.match(barText(), /2 layouts can't be re-baked/);
  assert.deepEqual(lines(row("group"), "edit-unknown"), [
    "⚠ 5 layouts are unchecked — By date, Scatter, Group, Bucket, Location were baked before layouts recorded their columns, so this change can't be checked against them. Of those, Group and Bucket can't be re-baked: these roles no longer produce them.",
  ]);
});

// --- F2: the selects offer only what the worker accepts ----------------------------------------

function optionState(select: string, value: string): { disabled: boolean; text: string } {
  const el = screen.getByRole("combobox", { name: select }).querySelector<HTMLOptionElement>(`option[value="${value}"]`);
  assert.ok(el !== null, `${select} has no ${value} option`);
  return { disabled: el.disabled, text: el.textContent ?? "" };
}

test("Tags and Datetime are offered only on a column stored as a list or a timestamp", async () => {
  // `set-roles` validates against the stored parquet types — a tag must be a list, a
  // datetime a timestamp (measured 2026-09-25: `caption` as a tag and `group` as the
  // datetime are both refused). The golden columns answer (measured): captured TIMESTAMP,
  // tags VARCHAR[], group/bucket/caption VARCHAR.
  mount(dataClient(MANIFEST_210));
  await dataView();
  assert.deepEqual(
    [optionState("Role for column group", "tag").disabled, optionState("Role for column group", "datetime").disabled],
    [true, true],
  );
  assert.match(optionState("Role for column group", "tag").text, /unavailable: needs a list column/);
  assert.match(optionState("Role for column group", "datetime").text, /unavailable: needs a timestamp column/);
  // What each column already IS stays selectable, and nothing else is touched.
  assert.equal(optionState("Role for column tags", "tag").disabled, false);
  assert.equal(optionState("Role for column captured", "datetime").disabled, false);
  assert.equal(optionState("Role for column group", "freeform").disabled, false);
});

// --- D-xxxiii: a date is a date — no format after ingest ---------------------------------------

test("a date row has no format control, whatever format the roles committed", async () => {
  // The format was a parsing hint for the upload; after ingest a date is a role and nothing
  // more. The Options cell is the one a role with no options has, the join key's.
  for (const manifest of [MANIFEST_210, MILLIS]) {
    mount(dataClient(manifest));
    await dataView();
    assert.equal(screen.queryAllByRole("combobox", { name: /format/i }).length, 0, "no format select");
    const options = (c: string): string => row(c).querySelector(".data-cell-options")?.textContent ?? "";
    assert.deepEqual([options("captured"), options("filename")], ["Options—", "Options—"]);
    cleanup();
  }
});

test("an untouched screen shows no phantom change, whatever format the roles committed", async () => {
  // Nothing stored: the chip reads 0 and the bar has nothing pending, even over a committed
  // format this view would once have offered to put back. Read only once the view's effects
  // have run: a phantom written by an effect (the delimiter's correction was one) lands after
  // the first paint, and an assertion made at the first paint passed with one in place.
  const settle = (): Promise<void> => act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  for (const manifest of [MANIFEST_210, FORMAT_MOVED, MILLIS]) {
    mount(dataClient(manifest));
    await dataView();
    await settle();
    assert.equal(chipTexts().at(-1), "Changed 0");
    assert.match(barText(), /Nothing pending/);
    cleanup();
  }
  // A stored model holding only a re-bake, queued from By date's card on the collection whose
  // `captured` is datetime AND freeform (D-xxxi's; CLI-authored, FORMAT_MOVED). The seed keeps
  // freeform, so its draft has no datetime column; the restored draft must keep the committed
  // format, or it reads as an edit, and that edit drops the datetime role.
  const twoRoles = withRoles({
    ...(FORMAT_MOVED.column_roles as ColumnRoles),
    freeform: [...(ROLES_210.freeform ?? []), { column: "captured", label: "Captured" }],
  });
  persistDraft(twoRoles.column_roles as ColumnRoles, () => {}, [{ kind: "rebake", layout_id: "datetime" }]);
  mount(dataClient(twoRoles));
  await dataView();
  await settle();
  assert.equal(chipTexts().at(-1), "Changed 0");
  assert.match(barText(), /1 bake to run/);
  assert.doesNotMatch(barText(), /invalidating/);
});

test("moving the datetime onto a column and off again leaves no change behind", async () => {
  // Review of #394, finding 1, the reviewer's sequence. The two-role collection (`captured`
  // datetime AND freeform, committed unix_seconds — CLI-authored, as above) seeds `captured`
  // as Freeform, so the seed has no datetime column. The column list failed (the request can
  // fail; the view then knows no stored type and locks nothing), so `group` can take the
  // datetime. Making it the datetime gave the draft iso8601, and moving it back kept that:
  // the draft then differed from the seed in its format alone, the bar showed "1 invalidating
  // role change captured", and committing it would drop `captured`'s datetime role.
  const twoRoles = withRoles({
    ...(FORMAT_MOVED.column_roles as ColumnRoles),
    freeform: [...(ROLES_210.freeform ?? []), { column: "captured", label: "Captured" }],
  });
  const rec = dataClient(twoRoles);
  rec.client.listColumns = async () => {
    throw Object.assign(new Error("column list unavailable"), { status: 503, detail: "column list unavailable" });
  };
  mount(rec);
  await dataView();
  selectRole("group", "datetime");
  assert.match(barText(), /invalidating/, "the move itself is a change");
  const stored = (): { draft?: RolesDraft } | null => JSON.parse(localStorage.getItem(pendingStorageKey(DS_ID)) ?? "null") as { draft?: RolesDraft } | null;
  assert.equal(stored()?.draft?.datetimeFormat, "iso8601", "a column the committed roles do not make the datetime is drafted as iso8601");
  selectRole("group", "categorical");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(chipTexts().at(-1), "Changed 0");
  assert.match(barText(), /Nothing pending/);
});

// --- 5. the tag row's two warnings -------------------------------------------------------------

test("re-declaring a tag column un-tagged by an earlier commit says its filter needs a bake", async () => {
  // The ONLY shape a "newly declared" tag reaches (F2, measured 2026-09-25 on a copy of this
  // tree): a column is a list only if it was a tag at ingest, so a new tag role can land only
  // on a column an earlier roles-only commit un-tagged. Un-tagging the LAST tag role also
  // removes the manifest's `tags` block, and re-tagging it then makes `set-roles` warn that
  // the filter "will come back EMPTY" — the worker agrees with this prediction here.
  // DERIVED: that commit's result — `tags` freeform, no tag role, no `tags` block.
  const untagged = {
    ...withRoles({ ...ROLES_210, tag: undefined, freeform: [...(ROLES_210.freeform ?? []), { column: "tags", label: "Tags" }] }),
    tags: undefined,
  } as FixtureManifest;
  mount(dataClient(untagged));
  await dataView();
  assert.equal(document.querySelectorAll('[data-kind^="tag-"]').length, 0, "nothing edited, nothing predicted");
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  selectRole("tags", "tag");
  assert.deepEqual(lines(row("tags"), "tag-unserved"), [
    "⚠ Filtering by this column needs a bake. Nothing is queued, so its filter would be empty until one runs.",
  ]);
  assert.equal(document.querySelectorAll('[data-kind="tag-last"]').length, 0);
});

test("un-tagging one of TWO tag columns does not say tag filtering goes away", async () => {
  // Review of #384, F9: removing the `removesLastTagRole` condition passed every test.
  // DERIVED: a collection ingested from a CSV with two delimited columns — the golden roles
  // plus a second tag role on `keywords`, which ingest stores as a list like `tags`
  // (measured: `tags` is `list<element: string>` in this tree's parquet).
  const twoTags = withRoles({
    ...ROLES_210,
    tag: [...(ROLES_210.tag ?? []), { column: "keywords", label: "Keywords", delimiter: "|" }],
  });
  const columns: ColumnListResponse = {
    source: "parquet",
    columns: [...COLUMNS.columns, { name: "keywords", dtype: "VARCHAR[]", sample: null }],
  };
  mount(dataClient(twoTags, columns));
  await dataView();
  selectRole("tags", "freeform");
  assert.equal(document.querySelectorAll('[data-kind="tag-last"]').length, 0, "keywords still filters");
  selectRole("keywords", "freeform");
  assert.equal(document.querySelectorAll('[data-kind="tag-last"]').length, 2, "now the last one goes, on both rows");
});

test("under a filter, a row moved into a group folded there follows it into view", async () => {
  // Round-4 review of #384, #5 — a regression of the #7 fix. Filter "ca", fold Display only,
  // set `captured` to Freeform: the row went into the folded group and vanished (0 rows,
  // aria-expanded=false). Following the row reopened only the un-narrowed fold state.
  mount(dataClient(MANIFEST_210));
  await dataView();
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter columns" }), { target: { value: "ca" } });
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: true }));
  assert.equal(expanded("Display only"), "false");
  selectRole("captured", "freeform");
  assert.equal(expanded("Display only"), "true");
  assert.equal(document.querySelectorAll('[data-column="captured"]').length, 1);
});

test("the tag delimiter is shown read-only, with why, at its committed value", async () => {
  // Second review of #384, #3. Ingest applies the delimiter once (`string_split`); the parquet
  // stores the lists, every sidecar a bake writes is projected from them, and `set-roles`
  // needs a tag column to be a list already — so no delimiter edit here can take effect, and
  // committing one writes a declaration the stored lists were not split on. The datetime
  // format is ingest-only for the same reason, and has no control at all (D-xxxiii).
  mount(dataClient(MANIFEST_210));
  await dataView();
  const delimiter = screen.getByRole("textbox", { name: "Tag delimiter for column tags" }) as HTMLInputElement;
  assert.deepEqual([delimiter.readOnly, delimiter.value], [true, "|"]);
  assert.match(delimiter.title, /applied when the column was ingested/);
  fireEvent.change(delimiter, { target: { value: ";" } });
  assert.equal(chipTexts().at(-1), "Changed 0", "nothing reached the draft");
});

test("a saved draft with a moved delimiter shows the committed one, and the draft follows it", async () => {
  // Round-4 review of #384, #4. A draft saved by an older build of this view could hold
  // `tags: ";"` over a committed `|`. The read-only field showed `;` as "set at ingest", the
  // row read "changed", nothing but Discard could put it back, and a commit would send `;`.
  persistDraft(ROLES_210, (d) => {
    d.tagDelimiters.tags = ";";
  });
  mount(dataClient(MANIFEST_210));
  await dataView();
  await waitFor(() => assert.equal(chipTexts().at(-1), "Changed 0", "the draft followed the committed delimiter"));
  assert.equal((screen.getByRole("textbox", { name: "Tag delimiter for column tags" }) as HTMLInputElement).value, "|");
  assert.equal(row("tags").querySelectorAll(".data-changed").length, 0);
  assert.match(barText(), /Nothing pending/);
});

test("a re-tagged column claims no delimiter value — the one ingest used can't be known", async () => {
  // Round-4 review of #384, #4: a delimiter lives only in its `column_roles.tag[]` entry,
  // which `set-roles` replaces wholesale, so un-tagging ANY tag column drops it and for a
  // re-tagged column the split ingest used is unknown. Say it was set at ingest; never show
  // a value.
  const untagged = {
    ...withRoles({ ...ROLES_210, tag: undefined, freeform: [...(ROLES_210.freeform ?? []), { column: "tags", label: "Tags" }] }),
    tags: undefined,
  } as FixtureManifest;
  mount(dataClient(untagged));
  await dataView();
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  selectRole("tags", "tag");
  assert.equal(screen.queryAllByRole("textbox", { name: "Tag delimiter for column tags" }).length, 0);
  assert.match(row("tags").querySelector(".data-cell-options")?.textContent ?? "", /set at ingest/);
});

/** A second column stored as a timestamp — see the test below for why it is reachable. */
function withModified(): { manifest: FixtureManifest; columns: ColumnListResponse } {
  return {
    manifest: withRoles({ ...ROLES_210, freeform: [...(ROLES_210.freeform ?? []), { column: "modified", label: "Modified" }] }),
    columns: { source: "parquet", columns: [...COLUMNS.columns, { name: "modified", dtype: "TIMESTAMP", sample: "2021-02-01 00:00:00" }] },
  };
}

function bulkPick(column: string): void {
  fireEvent.click(screen.getByRole("checkbox", { name: `Select column ${column}` }));
}

function bulkRole(value: string): void {
  fireEvent.change(screen.getByRole("combobox", { name: "Role for the selected Display only columns" }), { target: { value } });
}

test("bulk Apply will not apply a role that became unavailable after it was picked — tag", async () => {
  // Round-4 review of #384, #1: the picked role stayed selected when a later tick made it
  // unavailable, and Apply applied it anyway. Pick Tags for `tags` (a list), then tick
  // `caption` (a string): Tags is now disabled — and Apply made `caption` a tag, a commit the
  // worker refuses. DERIVED as in the re-tag test: `tags` un-tagged by an earlier commit.
  const untagged = {
    ...withRoles({ ...ROLES_210, tag: undefined, freeform: [...(ROLES_210.freeform ?? []), { column: "tags", label: "Tags" }] }),
    tags: undefined,
  } as FixtureManifest;
  mount(dataClient(untagged));
  await dataView();
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  bulkPick("tags");
  bulkRole("tag");
  bulkPick("caption");
  assert.equal((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  assert.deepEqual(
    [row("tags"), row("caption")].map((r) => (r.querySelector('select[aria-label^="Role for column"]') as HTMLSelectElement).value),
    ["freeform", "freeform"],
  );
  assert.equal(chipTexts().at(-1), "Changed 0");
});

test("bulk Apply's own handler refuses a locked role, not only its disabled attribute", async () => {
  // Final review of #384: deleting the handler's guard passed every test, because React never
  // dispatches onClick to a button whose props say `disabled` (nor does the DOM fire `click`
  // on a disabled control) — so no user action reaches the handler while the lock holds. The
  // guard is the second line if that ever changes. This calls the handler THROUGH REACT'S
  // PROPS on the element (an implementation detail of React DOM, `__reactProps$<id>`), the
  // only way to reach it; if React renames that key, this test fails loudly, not silently.
  const untagged = {
    ...withRoles({ ...ROLES_210, tag: undefined, freeform: [...(ROLES_210.freeform ?? []), { column: "tags", label: "Tags" }] }),
    tags: undefined,
  } as FixtureManifest;
  mount(dataClient(untagged));
  await dataView();
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  bulkPick("tags");
  bulkRole("tag");
  bulkPick("caption");
  const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
  assert.equal(apply.disabled, true);
  const propsKey = Object.keys(apply).find((k) => k.startsWith("__reactProps$"));
  assert.ok(propsKey !== undefined, "React DOM keeps an element's props under __reactProps$");
  const onClick = (apply as unknown as Record<string, { onClick: () => void }>)[propsKey].onClick;
  await act(async () => onClick());
  assert.equal(chipTexts().at(-1), "Changed 0", "the handler applied nothing");
});

test("bulk Apply will not make two columns the datetime at once", async () => {
  // Round-4 review of #384, #1: move `captured` off Datetime, pick `modified`, choose
  // Datetime, then tick `captured` too — Apply made BOTH the datetime. Also pins the bulk
  // two-datetime rule itself (`bulkChoiceLock`), which no test failed without.
  const { manifest, columns } = withModified();
  mount(dataClient(manifest, columns));
  await dataView();
  selectRole("captured", "freeform");
  bulkPick("modified");
  bulkRole("datetime");
  bulkPick("captured");
  assert.match(optionState("Role for the selected Display only columns", "datetime").text, /unavailable: a collection has one datetime column/);
  assert.equal((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  assert.deepEqual(
    [row("modified"), row("captured")].map((r) => (r.querySelector('select[aria-label^="Role for column"]') as HTMLSelectElement).value),
    ["freeform", "freeform"],
  );
});

test("only one column can be the datetime, so a second is offered disabled with why", async () => {
  // Second review of #384, #6: `validateDraft` refuses "At most one column can be the
  // datetime.", yet a second timestamp column offered Datetime. DERIVED: a column stored as
  // a timestamp that is not the datetime — reachable only as one an earlier roles-only
  // commit moved off the datetime role (a timestamp comes only from an iso8601 datetime at
  // ingest) — beside the golden `captured`.
  const second = withRoles({ ...ROLES_210, freeform: [...(ROLES_210.freeform ?? []), { column: "modified", label: "Modified" }] });
  const columns: ColumnListResponse = {
    source: "parquet",
    columns: [...COLUMNS.columns, { name: "modified", dtype: "TIMESTAMP", sample: "2021-02-01 00:00:00" }],
  };
  mount(dataClient(second, columns));
  await dataView();
  fireEvent.click(within(screen.getByRole("region", { name: "Display only" })).getByRole("button", { expanded: false }));
  assert.equal(optionState("Role for column modified", "datetime").disabled, true);
  assert.match(optionState("Role for column modified", "datetime").text, /unavailable: captured is the datetime/);
  // Moving `captured` off the role frees it.
  selectRole("captured", "freeform");
  assert.equal(optionState("Role for column modified", "datetime").disabled, false);
});

test("removing the collection's only tag column says tag filtering goes away", async () => {
  mount(dataClient(MANIFEST_210));
  await dataView();
  selectRole("tags", "freeform");
  // The row followed its column into Display only, which opened.
  assert.equal(expanded("Display only"), "true");
  assert.deepEqual(lines(row("tags"), "tag-last"), [
    "⚠ This is the collection's only tag column. Committing removes tag filtering from the atlas.",
  ]);
  assert.equal(document.querySelectorAll('[data-kind="tag-unserved"]').length, 0);
});

// --- 6. the two-role column, named before anything is edited -----------------------------------

test("a column carrying two committed roles is flagged on its row before anything is edited", async () => {
  // DERIVED: a CLI-authored map (the schema allows it; the web never writes it) giving
  // `group` categorical AND tag, and `captured` datetime AND freeform. The draft holds one
  // role per column — tags for `group`, freeform for `captured` — and a role commit would
  // drop the other ([[T2-the-roles-draft-cannot-hold-a-column-s-second]]).
  const twoRoles = withRoles({
    ...ROLES_210,
    tag: [...(ROLES_210.tag ?? []), { column: "group", label: "Group tags", delimiter: "|" }],
    freeform: [...(ROLES_210.freeform ?? []), { column: "captured", label: "Captured" }],
  });
  mount(dataClient(twoRoles));
  await dataView();
  assert.equal(document.querySelectorAll('[data-kind="held-roles"]').length, 2);
  assert.match(lines(row("group"), "held-roles")[0], /declares 2 roles for group — Categorical and Tags\..*drop Categorical\./);
  assert.match(lines(row("captured"), "held-roles")[0], /declares 2 roles for captured — Datetime and Freeform.*drop Datetime\./);
  // `captured` sits in Display only — folded by default — so that group opened to show it.
  assert.equal(expanded("Display only"), "true");
  assert.match(screen.getByText(/two roles the designer can hold only one of/).textContent ?? "", /captured, group|group, captured/);
  assert.match(barText(), /Nothing pending/, "flagging is not an edit");
});

test("a column shared by two coordinate pairs is NOT flagged — the draft holds both pairs exactly", async () => {
  // Two fingerprints on `sx` (and on `lon`), but every one lives in `scatterPairs` /
  // `geoPairs`: nothing is lost on commit. DERIVED the way a second pair is committed —
  // L7's own false-stale fixture (ui_designer_pending.test.ts).
  const shared = withRoles({
    ...ROLES_210,
    scatter: [...(ROLES_210.scatter ?? []), { x_column: "sx", y_column: "lon", label: "Second" }],
  });
  mount(dataClient(shared));
  await dataView();
  assert.equal(document.querySelectorAll('[data-kind="held-roles"]').length, 0);
  // An axis-only column has no row of its own, so an over-flag would surface ONLY in the
  // view-level notice — which is why that is asserted too.
  assert.equal(screen.queryAllByText(/two roles the designer can hold/).length, 0);
  assert.equal(document.querySelectorAll("[data-pair]").length, 3);
});

test("a display column that is also a pair axis IS flagged — the compile drops its display role", async () => {
  // DERIVED (CLI-authored): `caption` stays freeform AND becomes a scatter axis. The draft
  // holds both, but `buildColumnRoles` strips freeform from every axis, so a role commit
  // would silently drop it — the same loss by another route.
  const onAxis = withRoles({
    ...ROLES_210,
    scatter: [...(ROLES_210.scatter ?? []), { x_column: "sx", y_column: "caption", label: "Second" }],
  });
  mount(dataClient(onAxis));
  await dataView();
  assert.equal(document.querySelectorAll('[data-kind="held-roles"]').length, 1);
  assert.match(lines(row("caption"), "held-roles")[0], /keeps a coordinate pair; committing a role change would drop Freeform/);
});

test("the untouched golden collection flags no column", async () => {
  mount(dataClient(MANIFEST_210));
  await dataView();
  assert.equal(document.querySelectorAll('[data-kind="held-roles"]').length, 0);
  assert.equal(screen.queryAllByText(/two roles the designer can hold/).length, 0);
});

// --- 7. images only ------------------------------------------------------------------------------

test("columns.source images_only renders the no-metadata screen, not an empty table", async () => {
  const rec = designerClient({
    dataset: summary({
      dataset_id: DS_ID,
      image_count: IMAGES_ONLY.dataset_metadata.image_count,
      layout_ids: ["grid"],
    }),
  });
  rec.client.getManifest = async () => IMAGES_ONLY;
  rec.client.listLayouts = async () => infos(IMAGES_ONLY);
  rec.client.listColumns = async () => ({ source: "images_only", columns: [] });
  mount(rec);
  const view = await dataView();
  assert.ok(await within(view).findByRole("heading", { name: "No metadata yet" }));
  assert.equal(view.querySelectorAll("[data-column], [data-pair]").length, 0);
  assert.equal(within(view).queryAllByRole("combobox").length, 0, "no role to choose");
  assert.equal((within(view).getByRole("button", { name: "Add metadata…" }) as HTMLButtonElement).disabled, true);
  assert.equal((within(view).getByRole("button", { name: "Add images…" }) as HTMLButtonElement).disabled, true);
  assert.match(view.textContent ?? "", /Adding metadata to this collection is coming\./);
});

// --- 8. 390 px ----------------------------------------------------------------------------------

// jsdom does NO layout: `scrollWidth` and `clientWidth` are 0 on every element, so
// `scrollWidth <= clientWidth` holds for ANY stylesheet and cannot fail — it would not be a
// pin. The pixel measurement is taken in a real browser (the PR's 390 × 844 check); what
// this tier CAN pin is the declaration that produces it, as mobile_containment does for
// the viewer.
const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The inner rules of every `@media (max-width: 700px)` block, by selector. */
function narrowRules(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/@media\s*\(max-width:\s*700px\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
    for (const r of m[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = r[1].trim();
      out.set(sel, `${out.get(sel) ?? ""} ${r[2]}`);
    }
  }
  return out;
}

test("at 390 px the table is a single-track stack of cards, and no track can force a width", () => {
  const narrow = narrowRules();
  assert.match(narrow.get(".data-row") ?? "", /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/, "one track");
  assert.match(narrow.get(".data-head") ?? "", /display:\s*none/, "no column header row on a card stack");
  assert.match(narrow.get(".data-cell-label") ?? "", /display:\s*inline/, "each cell says what it is");
  // At every width, each of the five tracks has a ZERO minimum: content wraps inside its
  // cell rather than widening the row.
  const wide = /\.data-head,\s*\.data-row\s*\{([^{}]*)\}/.exec(css)?.[1] ?? "";
  const tracks = /grid-template-columns:\s*([^;]+);/.exec(wide)?.[1] ?? "";
  const each = tracks.match(/minmax\([^)]*\)/g) ?? [];
  assert.equal(each.length, 5);
  assert.equal(each.every((t) => /^minmax\(0,/.test(t)), true, `a track with a floor: ${tracks}`);
  // A zero-floor track only helps if the text inside it can BREAK: a sample runs to 160
  // characters, and an unbroken URL at 390 px would otherwise overflow its card (review of
  // #384, F8 — deleting these three declarations passed every test).
  const wraps = [".data-cell", ".data-column-name", ".data-sample"].filter((sel) => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim() === sel).map((m) => m[2]);
    return blocks.some((b) => /overflow-wrap:\s*anywhere/.test(b));
  });
  assert.deepEqual(wraps, [".data-cell", ".data-column-name", ".data-sample"]);
});
