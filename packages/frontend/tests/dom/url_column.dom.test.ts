// DOM tier — a column declared `render: "url"` renders its value as a link (D-xvii).
//
// The capability is unchanged; WHERE it is declared is not. It used to be
// `column_roles.url` in the bake record; the bake only ever validated that role, so it was
// presentation on the bake's input path, and it is now `presentation.columns.<name>.render`
// in the second file (D-xv). These tests were repointed at that source, assertion for
// assertion — the render RULES below are the ones the schema still states normatively.
//
// #251's equivalent block passed its unit tests while being DEAD IN THE APP, because no
// real caller ever supplied the role. Two layers are covered here:
//   1. `MetadataPanelView` directly — the shared render body of both surfaces — for the
//      render RULES (anchor vs inert, target/rel, one row per column, etc.).
//   2. the REAL stateful `Lightbox` — mounted with a presentation record and a mock client
//      — to pin the record → inspector WIRING that #251 shipped dead. (ViewerScreen's
//      identical thread drives a WebGL renderer and is not mountable in jsdom; it is
//      tracked with the other jsdom-untestable App wiring — see PROJECT_STATUS / T2-197.)
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { MetadataRow } from "../../src/api-client/types.ts";
import type { ColumnPresentationMap } from "../../src/ui/presentation.ts";
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

/** The record shape for a set of link columns, so each test names the columns it means
 *  rather than repeating the map literal. */
function linkColumns(...names: string[]): ColumnPresentationMap {
  const columns: Record<string, { render: "url" }> = {};
  for (const name of names) columns[name] = { render: "url" };
  return columns;
}

function renderPanel(columns?: ColumnPresentationMap): void {
  render(
    h(MetadataPanelView, {
      selectedCellId: 7,
      row: ROW,
      loading: false,
      error: null,
      tagValues: [],
      preview: null,
      columns,
    }),
  );
}

// --- the render rule -------------------------------------------------------

test("a column declared `render: url` renders its value as an anchor", () => {
  renderPanel(linkColumns("source_url"));
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
  renderPanel(linkColumns("source_url"));
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
      columns: linkColumns("source_url"),
    }),
  );
  assert.equal(screen.queryByRole("link"), null);
  assert.ok(screen.getByText("javascript:alert(1)"));
});

test("the value appears exactly ONCE — one row per column, no duplicate link row", () => {
  // #251 rendered a separate "Source URL" row in addition to the field row, showing the
  // value twice. Rendering in place makes that unrepresentable; this pins it.
  renderPanel(linkColumns("source_url"));
  assert.equal(
    screen.getAllByText("https://www.rijksmuseum.nl/en/collection/SK-C-5").length,
    1,
  );
});

test("other columns are unaffected", () => {
  renderPanel(linkColumns("source_url"));
  assert.ok(screen.getByText("The Night Watch"));
  assert.ok(screen.getByText("SK-C-5.jpg"));
  assert.equal(screen.getAllByRole("link").length, 1);
});

test("naming a column that the row does not carry is harmless", () => {
  renderPanel(linkColumns("not_a_column"));
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
      columns: linkColumns("source", "license"),
    }),
  );
  assert.equal(screen.getAllByRole("link").length, 2);
});

// --- the REAL wiring: the presentation record → Lightbox inspector ----------
//
// This is the coverage #251 lacked: it mounts the STATEFUL Lightbox (not a hand-built
// prop) so the record → LightboxBody → MetadataPanelView thread is exercised end to end.
// `layouts: []` means no detail tier, so the image pipeline is skipped and the mock client
// only needs getMetadata. If someone drops or typos that thread, this test — not just a
// unit test — goes red.
//
// The manifest still carries `column_roles` (the lightbox needs it for the detail tier),
// and it deliberately carries NO link declaration: after D-xvii the record is the only
// source, so a link appearing here proves the new path rather than a surviving old one.
test("the real Lightbox threads the presentation record through to a rendered link", async () => {
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
      columns: linkColumns("source_url"),
    }),
  );
  // findByRole awaits the async getMetadata resolve + re-render.
  const link = await screen.findByRole("link", {
    name: "https://www.rijksmuseum.nl/en/collection/SK-C-5",
  });
  assert.equal(link.getAttribute("href"), "https://www.rijksmuseum.nl/en/collection/SK-C-5");
});

test("the real Lightbox titles its inspector from the declared title column", async () => {
  // The trio's title, through the SAME real container — the lightbox and the rail
  // inspector share MetadataPanelView, so this is the one mountable proof that a
  // ViewerScreen-threaded title reaches a rendered heading.
  const client = {
    getMetadata: async () => [
      { id: 7, fields: { object_title: "The Night Watch", filename: "SK-C-5.jpg" } },
    ],
  };
  const manifest = {
    layouts: [],
    column_roles: { filename: { column: "filename", label: "File" } },
  };
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
      previewCache: { get: () => undefined, put: () => {}, clear: () => {} },
      tagsTable: null,
      titleColumn: "object_title",
    }),
  );
  assert.ok(await screen.findByRole("heading", { name: "The Night Watch" }));
});
