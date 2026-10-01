// Tier-1 (Phase C, brief §3.2): a renderToString smoke for the recut DatasetList
// card gallery (board 1f) covering the ready / processing / error / empty states.
// Complements the shared admin smoke in ui_components.test.ts; this file pins the
// card-specific structure the recut introduces (media area, Open + Edit — the ⋯ menu
// retired with seam L3, D-xxiv — the indeterminate processing bar, the error card's
// View-log reveal, and the empty-state CTA). The card COVER (T2-55) is fetched
// client-side in an effect (not run by server render), so a ready card's initial
// markup is still the flat --surface block here; the cover fetch/objectURL lifecycle
// is unit-tested in ui_dataset_cover.test.ts (jsdom).
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import {
  DatasetList,
  statusChip,
  updatingBadge,
  shouldFlipMenu,
} from "../src/ui/admin/DatasetList.ts";

/** The dropdown height the flip tests reason about (the retired card menu's estimate,
 *  180px; the helper itself is height-agnostic and now serves the activity pill). */
const CARD_MENU_EST_HEIGHT = 180;
import type { ApiClient } from "../src/api-client/client.ts";
import type { DatasetSummary } from "../src/api-client/types.ts";

function summary(id: string, status: DatasetSummary["status"]): DatasetSummary {
  return {
    dataset_id: id,
    dataset_version: status === "ready" ? 3 : 0,
    image_count: status === "ready" ? 42 : 0,
    ingest_timestamp: "2026-06-12T00:00:00Z",
    layout_ids: status === "ready" ? ["grid", "datetime"] : [],
    owner: "ada",
    status,
  };
}

// A minimal client stub — DatasetList only reads coverUrl + authHeaders for the cover
// fetch, which the server render never fires (the effect does not run), so these are
// unused here but satisfy the required prop.
const CLIENT = {
  coverUrl: (ds: string) => `http://edge/api/datasets/${ds}/cover`,
  authHeaders: () => ({}),
} as unknown as ApiClient;

const NOOP = {
  client: CLIENT,
  onOpen: () => {},
  onEdit: () => {},
  onNewDataset: () => {},
};

test("statusChip stays the outline pill export (status-chip status-<status>)", () => {
  assert.match(renderToString(statusChip("ready")), /status-chip status-ready/);
  assert.match(renderToString(statusChip("processing")), /status-chip status-processing/);
  assert.match(renderToString(statusChip("error")), /status-chip status-error/);
});

test("ready card, OWNER: accent Open + Edit, no ⋯ menu; media area renders", () => {
  const html = renderToString(h(DatasetList, { datasets: [summary("a", "ready")], username: "ada", ...NOOP }));
  assert.match(html, /dataset-card/);
  // The cover is fetched in an effect (not run by server render), so the ready card's
  // initial markup is the flat --surface block; the cover swaps in client-side (T2-55).
  assert.match(html, /card-media/);
  assert.match(html, /status-chip status-ready/);
  assert.match(html, /42 images · v3 · ada/); // mono meta line
  assert.match(html, /class="layout-chip">grid/); // layout chips
  assert.match(html, /class="btn pri"[^>]*>Open<\/button>/); // accent Open, enabled
  assert.match(html, /<button[^>]*>Edit<\/button>/); // D-xxiv: Edit for the owner
  assert.ok(!/card-menu-btn/.test(html), "the ⋯ menu retired (D-xxiv)");
  assert.ok(!/Delete/.test(html), "delete lives in the designer's Overview now");
});

test("ready card, NOT the owner: Open alone", () => {
  for (const username of ["someone_else", null]) {
    const html = renderToString(h(DatasetList, { datasets: [summary("a", "ready")], username, ...NOOP }));
    assert.match(html, /class="btn pri"[^>]*>Open<\/button>/);
    assert.ok(!/>Edit<\/button>/.test(html), `no Edit for username=${String(username)}`);
  }
});

test("a read-only (anonymous) card never offers Edit, even for a matching owner string", () => {
  const html = renderToString(
    h(DatasetList, { datasets: [summary("a", "ready")], username: "ada", readOnly: true, ...NOOP }),
  );
  assert.ok(!/>Edit<\/button>/.test(html));
});

test("a processing or errored card offers no Edit — the designer needs a baked layout", () => {
  const html = renderToString(
    h(DatasetList, { datasets: [summary("p", "processing"), summary("e", "error")], username: "ada", ...NOOP }),
  );
  assert.ok(!/>Edit<\/button>/.test(html));
});

test("processing card: dimmed media + indeterminate bar + disabled 'Open when ready' (no fake %)", () => {
  const html = renderToString(h(DatasetList, { datasets: [summary("b", "processing")], ...NOOP }));
  assert.match(html, /status-chip status-processing/);
  assert.match(html, /card-media-dim/); // media dimmed while processing
  assert.match(html, /progress-indeterminate/); // shimmer, never a fabricated width
  assert.ok(!/progress-fill/.test(html), "no determinate fill without a real %");
  assert.match(html, /processing · created 2026-06-12T00:00:00Z/);
  assert.match(html, /<button[^>]*disabled[^>]*>Open when ready<\/button>/);
});

test("error card: --err border + View-log reveal (no web Re-ingest — CLI-only)", () => {
  const html = renderToString(h(DatasetList, { datasets: [summary("c", "error")], ...NOOP }));
  assert.match(html, /dataset-card card-error/);
  assert.match(html, /status-chip status-error/);
  assert.match(html, /View log/); // disclosure (log surface hidden until toggled)
  // fix/reingest-safety: the web Re-ingest action was removed (re-baking is CLI-only).
  assert.ok(!/Re-ingest/.test(html), "web re-ingest button removed");
  assert.ok(!/log-tail/.test(html), "the log surface is revealed only on toggle");
});

test("empty state: dashed panel, CLI hint, accent + New dataset CTA", () => {
  const html = renderToString(h(DatasetList, { datasets: [], ...NOOP }));
  assert.match(html, /library-empty/);
  assert.match(html, /Nothing plotted yet/);
  assert.match(html, /class="cli-hint">pixscope ingest/);
  assert.match(html, /class="btn pri"[^>]*>\+ New dataset<\/button>/);
});

// --- ⋯ menu flip direction (T2-89: the bottom-row menu opens upward) ----------

test("shouldFlipMenu: a top-row card with room below opens DOWNWARD (the default)", () => {
  // Container [0..900]; the ⋯ button near the top (bottom at 120) has 780px below —
  // far more than the menu height, so it never flips (the common case is unchanged).
  const flip = shouldFlipMenu({ top: 100, bottom: 120 }, CARD_MENU_EST_HEIGHT, { top: 0, bottom: 900 });
  assert.equal(flip, false);
});

test("shouldFlipMenu: a BOTTOM-row card whose menu would be clipped opens UPWARD", () => {
  // Container [0..900]; a bottom-row ⋯ button (bottom at 880) has only 20px below —
  // less than the menu, and far more above — so it flips up (Delete stays reachable).
  const flip = shouldFlipMenu({ top: 860, bottom: 880 }, CARD_MENU_EST_HEIGHT, { top: 0, bottom: 900 });
  assert.equal(flip, true);
});

test("shouldFlipMenu: opens toward the ROOMIER side when the menu fits neither gap", () => {
  // A short container [400..520] (80px) that fits the menu neither way. The button
  // sits low (more room above than below) → flip up; sits high → stay down.
  assert.equal(shouldFlipMenu({ top: 495, bottom: 510 }, CARD_MENU_EST_HEIGHT, { top: 400, bottom: 520 }), true);
  assert.equal(shouldFlipMenu({ top: 410, bottom: 425 }, CARD_MENU_EST_HEIGHT, { top: 400, bottom: 520 }), false);
});

test("shouldFlipMenu: exactly enough room below does NOT flip (boundary)", () => {
  // spaceBelow === menuHeight → fits below → stay down.
  const flip = shouldFlipMenu({ top: 0, bottom: 0 }, 100, { top: 0, bottom: 100 });
  assert.equal(flip, false);
});

// --- Seam O3 (T2-104): the ready-while-baking "updating" badge -----------------

test("updatingBadge renders an accent status-chip button", () => {
  const html = renderToString(updatingBadge(() => {}));
  assert.match(html, /status-chip status-updating updating-badge/);
  assert.match(html, />updating</);
});

test("a READY card with an active_job_id shows the 'updating' badge (status literal unchanged)", () => {
  const ready = { ...summary("live", "ready"), active_job_id: "job-42" };
  const html = renderToString(h(DatasetList, { datasets: [ready], ...NOOP }));
  // The status literal is still "ready" (additive) AND the updating badge is present.
  assert.match(html, /status-chip status-ready/);
  assert.match(html, /status-updating updating-badge/);
});

test("a READY card WITHOUT an active job shows no updating badge", () => {
  const html = renderToString(h(DatasetList, { datasets: [summary("calm", "ready")], ...NOOP }));
  assert.match(html, /status-chip status-ready/);
  assert.ok(!/updating-badge/.test(html), "no badge when nothing is re-baking");
});