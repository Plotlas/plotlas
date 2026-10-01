// DOM tier — Part D: the presentation UI Part B stored but never surfaced.
//
// Three things Part B left half-done, each user-visible:
//   §2/§2b  attribution can be EDITED and SHOWN (card + optional link), not CLI-only
//   §2c     the display name replaces the raw id where a user reads it
//   §3      a FAILED edit keeps the typed values on screen instead of discarding them
//
// Seam L3 (D-xxiv) moved the EDITING half — the card's inline details editor and its
// ⋯-menu delete confirm — into the layout designer's Overview. Those pins moved with it
// and are in tests/dom/designer_overview.dom.test.ts; what stays here is the card's
// credit, which the card still SHOWS.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { DatasetSummary } from "../../src/api-client/types.ts";
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
      onNewDataset: () => {},
    }),
  );
}

// --- §2: attribution is shown on the card ----------------------------------

test("the card shows the attribution when set", () => {
  renderList({ ...BASE, attribution: "Rijksmuseum, Amsterdam" });
  assert.ok(screen.getByText("Rijksmuseum, Amsterdam"));
});

test("no attribution means no credit line at all", () => {
  // An empty credit line is chrome pretending to be information.
  renderList(BASE);
  assert.equal(screen.queryByText(/Rijksmuseum/), null);
  assert.equal(document.querySelector(".card-credit"), null);
});

test("a blank-string attribution is treated as unset", () => {
  renderList({ ...BASE, attribution: "   " });
  assert.equal(document.querySelector(".card-credit"), null);
});

// --- §2b: attribution may carry a link -------------------------------------

test("the credit becomes a link when attribution_url is an http(s) URL", () => {
  renderList({
    ...BASE,
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "https://www.rijksmuseum.nl",
  });
  const link = screen.getByRole("link", { name: "Rijksmuseum, Amsterdam" });
  assert.equal(link.getAttribute("href"), "https://www.rijksmuseum.nl/");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("target"), "_blank");
});

test("a non-http(s) attribution_url loses the LINK, never the credit", () => {
  // The value comes from app-state a user controls, so the same allow-list as the
  // url column role applies — and the credit must survive a bad target.
  renderList({
    ...BASE,
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "javascript:alert(1)",
  });
  assert.equal(screen.queryByRole("link"), null);
  assert.ok(screen.getByText("Rijksmuseum, Amsterdam"));
});

test("an attribution_url with no attribution renders nothing", () => {
  // A link with no text to hang it on is not a credit.
  renderList({ ...BASE, attribution_url: "https://www.rijksmuseum.nl" });
  assert.equal(document.querySelector(".card-credit"), null);
});

// --- Part D polish: the credit is LABELLED, and lives in the one footer ---------

test("the card credit is prefixed with Source:", () => {
  // A collection's name and its source are routinely near-identical ("Rijksmuseum
  // Collection" / "Rijksmuseum, Amsterdam"), so an unlabelled second line reads as a
  // duplicate title. The prefix is what makes it parse as provenance.
  renderList({ ...BASE, attribution: "Rijksmuseum, Amsterdam" });
  const credit = document.querySelector(".card-credit");
  assert.ok(credit);
  assert.match(credit.textContent ?? "", /^Source:\s*Rijksmuseum, Amsterdam$/);
});

test("the Source: label is NOT part of the link", () => {
  // "Source" is our word, not the institution's — underlining it would imply the link
  // points at something called "Source".
  renderList({
    ...BASE,
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "https://www.rijksmuseum.nl",
  });
  const link = screen.getByRole("link", { name: "Rijksmuseum, Amsterdam" });
  assert.doesNotMatch(link.textContent ?? "", /Source/);
  assert.ok(document.querySelector(".credit-label"));
});

test("the full credit stays available as a tooltip when the line is clipped", () => {
  // .card-credit is one clipped line so a long institution name cannot make the card
  // taller than its siblings; the value must remain readable somehow.
  renderList({ ...BASE, attribution: "Rijksmuseum, Amsterdam" });
  assert.equal(
    document.querySelector(".card-credit")?.getAttribute("title"),
    "Source: Rijksmuseum, Amsterdam",
  );
});
