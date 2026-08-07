// §4.5 seam acceptance — the FULL viewer flow, end-to-end at the component
// level with the API mocked at the fetch layer (serving the committed v2 golden
// fixture) and the REAL ApiClient:
//
//   manifest fetched + VALIDATED (issue #4) → layouts listed (LayoutSwitcher)
//   → tag sidecar fetched via tagsUrl/fetchTags (D-14/D-21/D-29) → chips
//   derived client-side → a tag selection produces a controller.applyTags
//   call with the exact TagSelection → multi-select summary renders from one
//   <=250-id getMetadata call → the cell preview resolves the detail-tier
//   original URL (v2 / D-33; no atlas crop).
//
// GL-free: the "controller" is a spy with the catalogued applyTags signature;
// the handlers driven here are the same ones ViewerScreen binds.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { createApiClient } from "../src/api-client/client.ts";
import type { MetadataRow } from "../src/api-client/types.ts";
import type { TagSelection } from "../src/renderer/layout.ts";
import { LayoutSwitcher } from "../src/ui/LayoutSwitcher.ts";
import { TagControls, TagTableContext, toggleTagValue } from "../src/ui/TagControls.ts";
import { MetadataPanelView, tagValuesForId } from "../src/ui/MetadataPanel.ts";
import { SelectionSummary } from "../src/ui/SelectionSummary.ts";
import { detailForManifest, resolveCellPreview } from "../src/ui/cellPreview.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));
const GOLDEN = join(FIXTURES_DIR, "golden_dataset_v2");
const DS = "golden_dataset_v2";
const TOKEN = "tok-viewer";

function manifestJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(GOLDEN, "layout_manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** fetch mock: /api JSON routes + /datasets/* static assets straight from the
 *  fixture tree (exactly what Caddy serves in production). */
function installFixtureApi(t: { after: (fn: () => void) => void }): { seen: string[] } {
  const seen: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    if (headers.Authorization !== `Bearer ${TOKEN}`) {
      return json({ detail: "Not authenticated" }, 401);
    }

    const manifest = manifestJson();
    if (url === `http://edge/api/datasets/${DS}/layouts`) {
      const layouts = (manifest.layouts as { layout_id: string; label: string; type: string }[]).map(
        (l) => ({ layout_id: l.layout_id, label: l.label, type: l.type }),
      );
      return json({ layouts });
    }
    if (url === `http://edge/api/datasets/${DS}/layouts/grid`) {
      return json(manifest);
    }
    const metadataPrefix = `http://edge/api/datasets/${DS}/metadata?ids=`;
    if (url.startsWith(metadataPrefix)) {
      const ids = url
        .slice(metadataPrefix.length)
        .split(",")
        .map((s) => Number(s));
      const rows: MetadataRow[] = ids.map((id) => ({
        id,
        fields: {
          filename: `img_${String(id).padStart(3, "0")}.png`,
          category: id % 2 === 0 ? "cats" : "dogs",
        },
      }));
      return json({ rows });
    }
    const assetPrefix = `http://edge/datasets/${DS}/`;
    if (url.startsWith(assetPrefix)) {
      const rel = url.slice(assetPrefix.length);
      try {
        return new Response(readFileSync(join(GOLDEN, ...rel.split("/"))));
      } catch {
        return json({ detail: `no fixture file ${rel}` }, 404);
      }
    }
    return json({ detail: `no route ${url}` }, 404);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { seen };
}

test("viewer flow: validated manifest → layouts → tag chips → applyTags → summary → detail preview", async (t) => {
  installFixtureApi(t);
  const client = createApiClient("http://edge", () => TOKEN);

  // 1. layouts listed (LayoutSwitcher renders from the API's LayoutInfo list).
  const layouts = await client.listLayouts(DS);
  assert.equal(layouts.length, 1);
  const switcherHtml = renderToString(
    h(LayoutSwitcher, { layouts, activeLayoutId: "grid", onSwitch: () => {} }),
  );
  assert.match(switcherHtml, />Grid</);

  // 2. the manifest passes issue-#4 validation on fetch (the renderer only
  //    ever sees a validated v2 document).
  const manifest = await client.getManifest(DS, "grid");
  assert.equal(manifest.dataset_id, DS);

  // 3. tag sidecar via the version-stamped URL (D-14); chips derive
  //    client-side — getMetadata is never consulted for tags (D-21).
  assert.ok(manifest.tags, "fixture declares a tags sidecar");
  const tagsTable = await client.fetchTags(
    client.tagsUrl(manifest.dataset_id, manifest.dataset_version),
  );
  assert.equal(tagsTable.numRows, 10);

  // 4. a chip toggle produces controller.applyTags with the exact selection —
  //    the same wiring ViewerScreen.handleTagChange binds.
  const applyCalls: TagSelection[] = [];
  const controller = {
    applyTags: (selection: TagSelection): void => {
      applyCalls.push(selection);
    },
  };
  let tagSelection: TagSelection = { selected: [], mode: "or" };
  const handleTagChange = (selection: TagSelection): void => {
    tagSelection = selection; // setTagSelection
    controller.applyTags(selection); // stackRef.current?.controller.applyTags
  };
  handleTagChange(toggleTagValue(tagSelection, "tags", "a"));
  assert.deepEqual(applyCalls, [{ selected: [{ column: "tags", value: "a" }], mode: "or" }]);

  const controlsHtml = renderToString(
    h(
      TagTableContext.Provider,
      { value: tagsTable },
      h(TagControls, {
        roles: manifest.column_roles ?? null,
        selection: tagSelection,
        onChange: handleTagChange,
      }),
    ),
  );
  assert.match(controlsHtml, /chip chip-selected[^>]*>a \(5\)/);
  assert.match(controlsHtml, /b \(10\)/);

  // 5. multi-select summary from ONE <=250-id getMetadata call (D-13).
  const selectedIds = [0, 1, 2, 3, 4];
  const rows = await client.getMetadata(DS, selectedIds.slice(0, 250));
  const summaryHtml = renderToString(
    h(SelectionSummary, {
      count: selectedIds.length,
      rows,
      roles: {
        ...(manifest.column_roles ?? { filename: { column: "filename", label: "Filename" } }),
        categorical: [{ column: "category", label: "Category" }],
      },
    }),
  );
  assert.match(summaryHtml, /5 cells selected/);
  assert.match(summaryHtml, /cats: 3/);
  assert.match(summaryHtml, /dogs: 2/);

  // 6. the cell preview resolves the DETAIL-tier original URL (v2 / D-33) from
  //    the manifest's detail block — synchronous, no tile scan.
  assert.ok(detailForManifest(manifest) !== null, "fixture declares an image_ref detail tier");
  const preview = resolveCellPreview(client, manifest, "grid", 3);
  assert.ok(preview !== null, "preview resolved");
  assert.equal(preview.cellId, 3);
  assert.equal(preview.imageUrl, `http://edge/api/datasets/${DS}/detail/3.webp`);

  const panelHtml = renderToString(
    h(MetadataPanelView, {
      selectedCellId: 3,
      row: rows[3],
      loading: false,
      error: null,
      tagValues: tagValuesForId(tagsTable, 3),
      preview,
    }),
  );
  assert.match(panelHtml, /Cell 3/);
  assert.match(panelHtml, /img_003\.png/);
  assert.match(panelHtml, /detail\/3\.webp/);
});

test("a dataset with no detail tier resolves no preview", async (t) => {
  installFixtureApi(t);
  const client = createApiClient("http://edge", () => TOKEN);
  const manifest = await client.getManifest(DS, "grid");
  // Strip the detail block: detailForManifest -> null, resolveCellPreview -> null.
  const noDetail = { ...manifest, layouts: manifest.layouts.map((l) => ({ ...l, detail: null })) };
  assert.equal(detailForManifest(noDetail), null);
  assert.equal(resolveCellPreview(client, noDetail, "grid", 3), null);
});
