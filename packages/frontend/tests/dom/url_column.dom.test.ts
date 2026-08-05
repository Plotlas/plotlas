// DOM tier — the `url` column role renders a column's value as a link (schema v2.8).
//
// #251's equivalent block passed its unit tests while being DEAD IN THE APP, because no
// real caller ever supplied the role. Two layers are covered here:
//   1. `MetadataPanelView` directly — the shared render body of both surfaces — for the
//      render RULES (anchor vs inert, target/rel, one row per column, etc.).
//   2. the REAL stateful `Lightbox` — mounted with a manifest carrying `column_roles.url`
//      and a mock client — to pin the manifest → inspector WIRING, i.e. the
//      `manifest.column_roles?.url` extraction that #251 shipped dead. (ViewerScreen's
//      identical one-liner drives a WebGL renderer and is not mountable in jsdom; it is
//      tracked with the other jsdom-untestable App wiring — see PROJECT_STATUS / T2-197.)
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { MetadataRow } from "../../src/api-client/types.ts";
import { MetadataPanelView } from "../../src/ui/MetadataPanel.ts";
import { Lightbox } from "../../src/ui/Lightbox.ts";

afterEach(cleanup);

const ROW: MetadataRow = {
  id: 7,
  fields: {
    filename: "SK-C-5.jpg",
    title: "The Night Watch",
    source_url: "https://www.rijksmuseum.nl/en/collection/SK-C-5",
  },
};

function renderPanel(urlColumns?: string[]): void {
  render(
    h(MetadataPanelView, {
      selectedCellId: 7,
      row: ROW,
      loading: false,
      error: null,
      tagValues: [],
      preview: null,
      urlColumns,
    }),
  );
}

// --- the render rule -------------------------------------------------------

test("a column named in `url` renders its value as an anchor", () => {
  renderPanel(["source_url"]);
  const link = screen.getByRole("link", {
    name: "https://www.rijksmuseum.nl/en/collection/SK-C-5",
  });
  assert.equal(link.getAttribute("href"), "https://www.rijksmuseum.nl/en/collection/SK-C-5");
});

test("the same column renders as PLAIN TEXT when the role is absent", () => {
  // Proves the role is what changes the render — not the value happening to look like
  // a URL. Without this, a passing link test could be a false positive.
  renderPanel(undefined);
  assert.equal(screen.queryByRole("link"), null);
  assert.ok(screen.getByText("https://www.rijksmuseum.nl/en/collection/SK-C-5"));
});

test("links carry target=_blank and rel=noopener noreferrer", () => {
  // Normative in the schema: the target comes from dataset content and must never get a
  // handle on this window.
  renderPanel(["source_url"]);
  const link = screen.getByRole("link");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
});

test("a non-http(s) value in a url column renders INERT, not as a link", () => {
  render(
    h(MetadataPanelView, {
      selectedCellId: 7,
      row: { id: 7, fields: { source_url: "javascript:alert(1)" } },
      loading: false,
      error: null,
      tagValues: [],
      preview: null,
      urlColumns: ["source_url"],
    }),
  );
  assert.equal(screen.queryByRole("link"), null);
  assert.ok(screen.getByText("javascript:alert(1)"));
});

test("the value appears exactly ONCE — one row per column, no duplicate link row", () => {
  // #251 rendered a separate "Source URL" row in addition to the field row, showing the
  // value twice. Rendering in place makes that unrepresentable; this pins it.
  renderPanel(["source_url"]);
  assert.equal(
    screen.getAllByText("https://www.rijksmuseum.nl/en/collection/SK-C-5").length,
    1,
  );
});

test("other columns are unaffected", () => {
  renderPanel(["source_url"]);
  assert.ok(screen.getByText("The Night Watch"));
  assert.ok(screen.getByText("SK-C-5.jpg"));
  assert.equal(screen.getAllByRole("link").length, 1);
});

test("naming a column that the row does not carry is harmless", () => {
  renderPanel(["not_a_column"]);
  assert.equal(screen.queryByRole("link"), null);
  assert.ok(screen.getByText("The Night Watch"));
});

test("several url columns each render as their own link", () => {
  render(
    h(MetadataPanelView, {
      selectedCellId: 7,
      row: {
        id: 7,
        fields: { source: "https://a.example/1", license: "https://b.example/2" },
      },
      loading: false,
      error: null,
      tagValues: [],
      preview: null,
      urlColumns: ["source", "license"],
    }),
  );
  assert.equal(screen.getAllByRole("link").length, 2);
});

// --- the REAL wiring: manifest.column_roles.url → Lightbox inspector --------
//
// This is the coverage #251 lacked: it mounts the STATEFUL Lightbox (not a hand-built
// prop) so the `manifest.column_roles?.url` extraction is exercised. `layouts: []` means
// no detail tier, so the image pipeline is skipped and the mock client only needs
// getMetadata. If someone drops or typos that extraction, this test — not just a unit
// test — goes red.
test("the real Lightbox threads manifest.column_roles.url through to a rendered link", async () => {
  const client = {
    getMetadata: async () => [
      {
        id: 7,
        fields: {
          source_url: "https://www.rijksmuseum.nl/en/collection/SK-C-5",
          title: "The Night Watch",
        },
      },
    ],
  };
  const manifest = {
    layouts: [], // no detail tier ⇒ detailForManifest() is null ⇒ no image fetch
    column_roles: {
      filename: { column: "filename", label: "File" },
      freeform: [{ column: "source_url", label: "Source url" }],
      url: ["source_url"],
    },
  };
  const previewCache = { get: () => undefined, put: () => {}, clear: () => {} };
  render(
    h(Lightbox, {
      dataset: "ds",
      client,
      cellIds: [7],
      index: 0,
      onNavigate: () => {},
      onClose: () => {},
      onAuthExpired: () => {},
      manifest,
      previewCache,
      tagsTable: null,
    }),
  );
  // findByRole awaits the async getMetadata resolve + re-render. The link appears ONLY if
  // Lightbox read column_roles.url and threaded it through LightboxBody → MetadataPanelView.
  const link = await screen.findByRole("link", {
    name: "https://www.rijksmuseum.nl/en/collection/SK-C-5",
  });
  assert.equal(link.getAttribute("href"), "https://www.rijksmuseum.nl/en/collection/SK-C-5");
});
