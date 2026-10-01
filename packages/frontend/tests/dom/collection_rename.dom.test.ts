// DOM tier — naming a collection (SCOPE_shareable-collections Part B; D-xxviii).
//
// Renaming moved from the library card's ⋯ menu into the layout designer's Overview
// with seam L3 (D-xxiv); its pins moved with it (tests/dom/designer_overview.dom.test.ts).
// What stays here is how the CARD names a collection: the one fallback rule,
// `collectionName`, and the id staying discoverable. DatasetList is AdminScreen's
// presentational leaf and is exercised directly, exactly as anonymous_entry.dom does.
//
// The property worth protecting: the card shows the display NAME but the collection is
// still addressed by its ID everywhere. A rename must never look like it moved the
// collection — and since D-xxviii, a MINTED id is never shown as a name at all.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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

function renderList(ds: DatasetSummary): void {
  render(
    h(DatasetList, {
      datasets: [ds],
      client: stubClient(),
      onOpen: () => {},
      onEdit: () => {},
      username: "dalew",
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

test("D-xxviii: a MINTED id never stands in for a name — it is “Untitled collection”", () => {
  // The form seam L6 mints and documents: exactly 12 lowercase hex characters.
  assert.equal(collectionName({ dataset_id: "3f9c2a71e0b4" }), "Untitled collection");
  assert.equal(collectionName({ dataset_id: "3f9c2a71e0b4", display_name: null }), "Untitled collection");
  assert.equal(collectionName({ dataset_id: "3f9c2a71e0b4", display_name: "" }), "Untitled collection");
  // The display name still wins over a minted id.
  assert.equal(collectionName({ dataset_id: "3f9c2a71e0b4", display_name: "Herbarium" }), "Herbarium");
});

test("D-xxviii: an AUTHORED id still stands in, including ones that merely look hex-ish", () => {
  // Someone chose these as words; renaming every existing unnamed collection to
  // "Untitled" is exactly what D-xxviii refuses. Only the exact minted form is untitled.
  assert.equal(collectionName({ dataset_id: "smithsonian_art_200k" }), "smithsonian_art_200k");
  assert.equal(collectionName({ dataset_id: "3F9C2A71E0B4" }), "3F9C2A71E0B4", "uppercase is not the minted form");
  assert.equal(collectionName({ dataset_id: "3f9c2a71e0b" }), "3f9c2a71e0b", "11 characters is not the minted form");
  assert.equal(collectionName({ dataset_id: "3f9c2a71e0b4a" }), "3f9c2a71e0b4a", "13 characters is not the minted form");
  assert.equal(collectionName({ dataset_id: "deadbeefcafe_v2" }), "deadbeefcafe_v2");
});

test("a card for an unnamed MINTED collection says “Untitled collection”, never the hex", () => {
  // Shaped as L6's create answers a web-intake collection nobody has named yet.
  renderList({ ...BASE, dataset_id: "3f9c2a71e0b4" });
  assert.ok(screen.getByText("Untitled collection"));
  assert.equal(screen.queryAllByText("3f9c2a71e0b4").length, 0, "the id is not shown as a name");
  // ...and not to a screen reader either: the card's accessible name is the name.
  assert.ok(screen.getByRole("article", { name: "Untitled collection" }));
});

// --- the id stays discoverable ---------------------------------------------

test("a renamed card still exposes its id, which is what links and the CLI need", () => {
  // If the name fully REPLACED the id in the UI, an operator could not work out what
  // to put in ?d=… or in `api.admin set-visibility`. It stays as the name's tooltip — a
  // technical detail (D-xxviii) — and as Overview's ID line with its copy button.
  renderList({ ...BASE, display_name: "Rijksmuseum — Public Domain" });
  assert.ok(screen.getByTitle("rijks_pilot"));
});

test("a read-only visitor gets no Edit affordance", () => {
  render(
    h(DatasetList, {
      datasets: [{ ...BASE, owner: "" }],
      client: stubClient(),
      onOpen: () => {},
      onEdit: () => {},
      username: "dalew",
      onNewDataset: () => {},
      readOnly: true,
      onLogin: () => {},
    }),
  );
  assert.equal(screen.queryAllByRole("button", { name: "Edit" }).length, 0);
});

