// DOM tier — naming a collection (SCOPE_shareable-collections Part B).
//
// The operator's primary affordance is renaming IN PLACE from the library card's ⋯
// menu, so these tests drive that path rather than the client method underneath it.
// AdminScreen is the stateful container (never imported by the node runner); DatasetList
// is its presentational leaf and is exercised directly, exactly as admin_screen.dom and
// anonymous_entry.dom do.
//
// The property worth protecting: the card shows the display NAME but the collection is
// still addressed by its ID everywhere. A rename must never look like it moved the
// collection.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { DatasetSummary } from "../../src/api-client/types.ts";
import { collectionName } from "../../src/api-client/types.ts";
import { DatasetList } from "../../src/ui/admin/DatasetList.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const BASE: DatasetSummary = {
  dataset_id: "rijks_pilot",
  dataset_version: 1,
  image_count: 49048,
  ingest_timestamp: "2026-07-07T00:00:00Z",
  layout_ids: ["grid"],
  owner: "dalew",
  status: "ready",
};

function stubClient(): ApiClient {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  return {
    coverUrl: (dsId: string) => `/api/datasets/${dsId}/cover`,
    authHeaders: () => ({}),
  } as unknown as ApiClient;
}

function renderList(
  ds: DatasetSummary,
  onRename: (dsId: string, edits: { display_name: string | null }) => Promise<void> = async () => {},
): void {
  render(
    h(DatasetList, {
      datasets: [ds],
      client: stubClient(),
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onRename: onRename as never,
      onNewDataset: () => {},
    }),
  );
}

// --- the fallback rule -----------------------------------------------------

test("an unnamed collection shows its id", () => {
  renderList(BASE);
  assert.ok(screen.getByText("rijks_pilot"));
});

test("a named collection shows the name instead of the id", () => {
  renderList({ ...BASE, display_name: "Rijksmuseum — Public Domain" });
  assert.ok(screen.getByText("Rijksmuseum — Public Domain"));
});

test("collectionName is the ONE fallback rule and does not invent a name", () => {
  // Pinned here as well as at the call site: a future "prettify the id" (title-case,
  // de-underscore) would read as a real name the operator never chose.
  assert.equal(collectionName({ dataset_id: "rijks_pilot" }), "rijks_pilot");
  assert.equal(collectionName({ dataset_id: "a", display_name: null }), "a");
  assert.equal(collectionName({ dataset_id: "a", display_name: "" }), "a");
  assert.equal(collectionName({ dataset_id: "a", display_name: "Real" }), "Real");
});

// --- the ⋯ rename affordance ----------------------------------------------

function openRenameEditor(): void {
  fireEvent.click(screen.getByLabelText("Actions for rijks_pilot"));
  fireEvent.click(screen.getByText("Edit details…"));
}

test("the ⋯ menu offers Rename, which opens an inline editor", () => {
  renderList(BASE);
  openRenameEditor();
  assert.ok(screen.getByLabelText("Name for rijks_pilot"));
});

test("the editor is seeded with the CURRENT name, not blank", () => {
  renderList({ ...BASE, display_name: "Current name" });
  openRenameEditor();
  const input = screen.getByLabelText("Name for rijks_pilot") as HTMLInputElement;
  assert.equal(input.value, "Current name");
});

test("submitting a name reports it against the collection's ID", () => {
  // The id is what the API, the CLI and the deep link all use — the rename must be
  // keyed on it, never on whatever the card happens to be displaying.
  let seen: { dsId: string; name: string | null } | null = null;
  renderList(BASE, async (dsId, edits) => {
    seen = { dsId, name: edits.display_name };
  });
  openRenameEditor();
  const input = screen.getByLabelText("Name for rijks_pilot");
  fireEvent.change(input, { target: { value: "Rijksmuseum — Public Domain" } });
  fireEvent.click(screen.getByText("Save"));
  assert.deepEqual(seen, {
    dsId: "rijks_pilot",
    name: "Rijksmuseum — Public Domain",
  });
});

test("submitting EMPTY clears the name — the recovery path for a bad one", () => {
  let seen: { dsId: string; name: string | null } | null = null;
  renderList({ ...BASE, display_name: "Typo McTypoface" }, async (dsId, edits) => {
    seen = { dsId, name: edits.display_name };
  });
  openRenameEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByText("Save"));
  assert.deepEqual(seen, { dsId: "rijks_pilot", name: null });
});

test("Cancel closes the editor without reporting a rename", () => {
  let called = false;
  renderList(BASE, async () => {
    called = true;
  });
  openRenameEditor();
  fireEvent.click(screen.getByText("Cancel"));
  assert.equal(called, false);
  assert.equal(screen.queryByLabelText("Name for rijks_pilot"), null);
});

test("Escape closes the editor — it is never a trap", () => {
  renderList(BASE);
  openRenameEditor();
  fireEvent.keyDown(screen.getByLabelText("Name for rijks_pilot"), {
    key: "Escape",
  });
  assert.equal(screen.queryByLabelText("Name for rijks_pilot"), null);
});

// --- the id stays discoverable ---------------------------------------------

test("a renamed card still exposes its id, which is what links and the CLI need", () => {
  // If the name fully REPLACED the id in the UI, an operator could not work out what
  // to put in ?d=… or in `api.admin set-visibility`. The card's aria-label keeps it.
  renderList({ ...BASE, display_name: "Rijksmuseum — Public Domain" });
  assert.ok(screen.getByLabelText("rijks_pilot"));
});

test("a read-only visitor gets no rename affordance", () => {
  render(
    h(DatasetList, {
      datasets: [{ ...BASE, owner: "" }],
      client: stubClient(),
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onRename: async () => {},
      onNewDataset: () => {},
      readOnly: true,
      onLogin: () => {},
    }),
  );
  assert.equal(screen.queryByLabelText("Actions for rijks_pilot"), null);
});
