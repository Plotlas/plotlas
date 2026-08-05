// DOM tier (T2-93 Seam 1) — container test: MetadataPanel's effect-driven
// getMetadata fetch. The panel starts in "Loading metadata…" for a selected
// cell, then the mount effect resolves and it renders the field list. This is
// the effect→state→re-render path the pure MetadataPanelView smoke cannot cover
// (it is handed props directly and never fetches).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { MetadataRow } from "../../src/api-client/types.ts";
import { MetadataPanel } from "../../src/ui/MetadataPanel.ts";

afterEach(() => cleanup());

test("MetadataPanel fetches the selected cell's metadata and renders its fields", async () => {
  const client = {
    async getMetadata(dsId: string, ids: number[]): Promise<MetadataRow[]> {
      assert.equal(dsId, "ds");
      assert.deepEqual(ids, [7]);
      return [{ id: 7, fields: { species: "cat", year: 2021 } }];
    },
  } as unknown as ApiClient;

  render(h(MetadataPanel, { dataset: "ds", selectedCellId: 7, client }));

  // Loading placeholder before the effect resolves (mount-time selection).
  assert.ok(screen.getByText("Loading metadata…"), "shows the loading placeholder first");

  // After the fetch: the field list is rendered (dt name / dd value pairs).
  await screen.findByText("cat");
  assert.ok(screen.getByText("species"), "field name renders");
  assert.ok(screen.getByText("Cell 7"), "panel title shows the selected cell id");
});
