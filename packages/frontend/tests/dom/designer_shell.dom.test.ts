// DOM tier — the layout designer's SHELL (seam L3 §2b.2/§2b.3/§2b.8, §1.6/§1.7).
//
// DesignerScreen over a fake client serving the golden full fixture as the API serves it
// (tests/dom/designerDom.ts says where each shape comes from). What is pinned:
//   - the owner gate: anyone but the owner is routed away BEFORE the manifest is read;
//   - the chrome: breadcrumb, owner-only pill, tab counts and badges, the meta line;
//   - the commit bar: identical on every tab, at most two counts in RoleConsequences'
//     words, nothing for a free edit, and Review & commit disabled while nothing is priced
//     (seam L5 supplies the sheet it opens — D-xxi);
//   - a pending draft survives a reload (it is read back from storage on mount).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesignerScreen } from "../../src/ui/designer/DesignerScreen.ts";
import { pendingStorageKey, seedPending, serializePending, withDraft } from "../../src/ui/designer/pending.ts";
import type { DesignerTab } from "../../src/ui/urlState.ts";
import type { RolesDraft } from "../../src/ui/admin/roles.ts";
import { DS_ID, MANIFEST_29, OWNER, designerClient, summary } from "./designerDom.ts";
import type { DesignerRecorder } from "./designerDom.ts";

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

interface Mounted {
  unavailable: string[];
  tabs: DesignerTab[];
}

function mount(rec: DesignerRecorder, tab: DesignerTab = "overview", username: string | null = OWNER): Mounted {
  const m: Mounted = { unavailable: [], tabs: [] };
  render(
    h(DesignerScreen, {
      client: rec.client,
      datasetId: DS_ID,
      tab,
      username,
      onNavigate: (t) => m.tabs.push(t),
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: (id) => m.unavailable.push(id),
      onDeleted: () => {},
      onAuthExpired: () => {},
    }),
  );
  return m;
}

/** The priced edit these tests persist: Location's projection moved to Mercator, which
 *  stales Location. A datetime format change until D-xxxiii, whose restore now puts a saved
 *  format back to the committed one. tests/dom/designer_layouts.dom.test.ts (MERCATOR) says
 *  where it comes from. */
const MERCATOR = (d: RolesDraft): void => {
  d.geoPairs[0].projection = "mercator";
};

/** Persist a pending draft for the fixture, as a previous visit's edits would have. */
function persistDraft(change: (d: RolesDraft) => void): void {
  const seed = seedPending(MANIFEST_29.column_roles);
  const draft = JSON.parse(JSON.stringify(seed.draft)) as RolesDraft;
  change(draft);
  localStorage.setItem(pendingStorageKey(DS_ID), serializePending(withDraft(seed, draft), MANIFEST_29.dataset_version));
}

// --- the owner gate (§1.6) -------------------------------------------------------------

test("a signed-in NON-owner is routed away, before the manifest is ever read", async () => {
  const rec = designerClient();
  const m = mount(rec, "overview", "someone_else");
  await waitFor(() => assert.deepEqual(m.unavailable, [DS_ID]));
  assert.equal(rec.manifestReads, 0);
  assert.equal(screen.queryAllByRole("contentinfo", { name: "Pending changes" }).length, 0);
});

test("an anonymous visitor is routed away too", async () => {
  const m = mount(designerClient(), "overview", null);
  await waitFor(() => assert.deepEqual(m.unavailable, [DS_ID]));
});

test("an unowned (CLI-seeded) collection opens for nobody", async () => {
  // The API reports owner "" for a dataset with no app-state row.
  const m = mount(designerClient({ dataset: summary({ owner: "" }) }), "overview", "");
  await waitFor(() => assert.deepEqual(m.unavailable, [DS_ID]));
});

// --- the chrome (§2b.2) ------------------------------------------------------------------

test("the owner gets the chrome: breadcrumb, owner-only pill, tab counts, meta line", async () => {
  mount(designerClient({ dataset: summary({ display_name: "Golden full" }) }));
  await screen.findByRole("heading", { name: "Golden full" });
  const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
  assert.match(crumbs.textContent ?? "", /Library›Golden full/);
  assert.ok(screen.getByText("owner only"));
  assert.ok(screen.getByRole("button", { name: "Open atlas" }));
  // Data {n} counts GET .../columns; Layouts {n} counts the layout list.
  assert.match(screen.getByRole("tab", { name: /^Data/ }).textContent ?? "", /^Data10$/);
  assert.match(screen.getByRole("tab", { name: /^Layouts/ }).textContent ?? "", /^Layouts6$/);
  assert.equal(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected"), "true");
  assert.ok(screen.getByText("256 images · v1 · metadata.csv"));
});

test("an unnamed MINTED collection is “Untitled collection” in the header, never its hex", async () => {
  const minted = "3f9c2a71e0b4";
  render(
    h(DesignerScreen, {
      client: designerClient({ dataset: summary({ dataset_id: minted }) }).client,
      datasetId: minted,
      tab: "overview",
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted: () => {},
      onAuthExpired: () => {},
    }),
  );
  await screen.findByRole("heading", { name: "Untitled collection" });
  const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
  assert.doesNotMatch(crumbs.textContent ?? "", /3f9c2a71e0b4/);
  // The id is still there — as a technical detail, not a name.
  assert.ok(screen.getByText(minted));
});

test("the tabs navigate", async () => {
  const m = mount(designerClient());
  await screen.findByRole("tab", { name: /^Layouts/ });
  fireEvent.click(screen.getByRole("tab", { name: /^Layouts/ }));
  fireEvent.click(screen.getByRole("tab", { name: /^Data/ }));
  assert.deepEqual(m.tabs, ["layouts", "data"]);
});

// --- the bar (§2b.3, §1.7) --------------------------------------------------------------

test("with nothing pending the bar says so, prices nothing, and cannot commit", async () => {
  mount(designerClient());
  const bar = await screen.findByRole("contentinfo", { name: "Pending changes" });
  assert.match(bar.textContent ?? "", /Nothing pending/);
  assert.doesNotMatch(bar.textContent ?? "", /\d+ invalidating|\d+ bakes?\b/, "no count is shown");
  assert.equal((screen.getByRole("button", { name: /Review & commit/ }) as HTMLButtonElement).disabled, true);
  assert.equal((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled, true);
});

test("a malformed stored draft does not take the designer down; it is dropped", async () => {
  // The review's reproduction: a real record with `scatterPairs: [null]`, which used to
  // throw inside render on every load.
  persistDraft((d) => {
    (d as unknown as { scatterPairs: unknown[] }).scatterPairs = [null];
  });
  mount(designerClient());
  const bar = await screen.findByRole("contentinfo", { name: "Pending changes" });
  assert.match(bar.textContent ?? "", /Nothing pending/);
  assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null);
});

test("a reloaded pending role change is back, badged on both tabs, and priced in the bar's words", async () => {
  persistDraft(MERCATOR);
  mount(designerClient());
  const bar = await screen.findByRole("contentinfo", { name: "Pending changes" });
  // One edit to the map's projection: one role change on the bar, which still names both
  // columns; the Data tab counts the columns (operator, 2026-09-28; CONTRACT §4).
  assert.match(bar.textContent ?? "", /1 invalidating role change(?!s)/);
  assert.match(bar.textContent ?? "", /lat, lon · stales Location/);
  // Overview's Data door counts what the bar counts, above it on the same screen (review of
  // #400, finding 1: it read "2 roles changed" over a bar reading 1).
  const door = screen.getByRole("region", { name: "Data" });
  assert.match(door.textContent ?? "", /⚠ 1 role changed and not committed — lat, lon/);
  assert.match(screen.getByRole("tab", { name: /^Data/ }).textContent ?? "", /2 changed/);
  assert.match(screen.getByRole("tab", { name: /^Layouts/ }).textContent ?? "", /1 stale/);
  // Seam L5 supplies the review sheet, so a priced change can now be reviewed (D-xxi: the
  // review, not the bar, is what starts a job — tests/dom/designer_layouts.dom.test.ts).
  assert.equal((screen.getByRole("button", { name: /Review & commit/ }) as HTMLButtonElement).disabled, false);
});

test("the bar is identical on all three tabs", async () => {
  persistDraft(MERCATOR);
  const texts: string[] = [];
  for (const tab of ["overview", "data", "layouts"] as const) {
    mount(designerClient(), tab);
    const bar = await screen.findByRole("contentinfo", { name: "Pending changes" });
    texts.push(bar.textContent ?? "");
    cleanup();
  }
  assert.equal(new Set(texts).size, 1, texts.join(" | "));
  assert.match(texts[0], /1 invalidating role change(?!s)/, "and it is a priced bar, not three empty ones");
});

test("a pending LABEL edit is kept but shows no count — free edits never enter the bar", async () => {
  persistDraft((d) => {
    d.labels.group = "Department";
  });
  mount(designerClient());
  const bar = await screen.findByRole("contentinfo", { name: "Pending changes" });
  assert.match(bar.textContent ?? "", /Nothing pending/);
});

test("Discard returns to the committed roles and forgets the persisted draft", async () => {
  persistDraft(MERCATOR);
  mount(designerClient());
  await screen.findByText(/1 invalidating/);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await screen.findByText(/Nothing pending/);
  assert.equal(localStorage.getItem(pendingStorageKey(DS_ID)), null);
});

test("a persisted draft is dropped when dataset_version moved under it", async () => {
  persistDraft(MERCATOR);
  // A bake committed since: the manifest is now version 2.
  const rec = designerClient({ dataset: summary({ dataset_version: 2 }) });
  rec.client.getManifest = async () => ({ ...MANIFEST_29, dataset_version: 2 });
  mount(rec);
  const bar = await screen.findByRole("contentinfo", { name: "Pending changes" });
  assert.match(bar.textContent ?? "", /Nothing pending/);
});

// --- the temporary tabs (§2b.8) ---------------------------------------------------------

test("Data says it arrives with L4; Layouts shows every LayoutInfo as a card, with the predicted outcome on it", async () => {
  mount(designerClient(), "data");
  // Seam L4 replaced the placeholder; its own pins are tests/dom/designer_data.dom.test.ts.
  assert.ok(await screen.findByRole("region", { name: "Data" }));
  cleanup();
  persistDraft(MERCATOR);
  // Seam L5's view; its states are pinned in tests/dom/designer_layouts.dom.test.ts.
  mount(designerClient(), "layouts");
  const live = await screen.findByRole("region", { name: "Live layouts" });
  assert.equal(live.querySelectorAll("article").length, 6);
  assert.equal(screen.getByRole("article", { name: "Location" }).getAttribute("data-state"), "stale", "the predicted outcome shows on its card");
});
