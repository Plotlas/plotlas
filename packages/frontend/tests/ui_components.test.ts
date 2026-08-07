// Tier-1 component smokes (brief §3.5): react-dom/server renderToString — no
// jsdom, no testing-library, no new deps. Components are createElement-based
// .ts modules precisely so the node test runner can import them (it cannot
// parse JSX/.tsx).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { tableFromIPC } from "apache-arrow";

import { LayoutSwitcher } from "../src/ui/LayoutSwitcher.ts";
import {
  TagControls,
  TagTableContext,
  deriveTagChips,
  toggleTagValue,
} from "../src/ui/TagControls.ts";
import {
  MetadataPanel,
  MetadataPanelDataContext,
  MetadataPanelView,
  tagValuesForId,
} from "../src/ui/MetadataPanel.ts";
import { SelectionSummary, summarizeRows } from "../src/ui/SelectionSummary.ts";
import { DatasetList } from "../src/ui/admin/DatasetList.ts";
import { AuthPanel } from "../src/ui/admin/AuthPanel.ts";
import { RoleAssignmentForm } from "../src/ui/admin/RoleAssignmentForm.ts";
import { JobProgressView, bakeTimeEstimate, waitCopy } from "../src/ui/admin/JobProgress.ts";
import { emptyDraft } from "../src/ui/admin/roles.ts";
import { parseCsvHeader } from "../src/ui/admin/csvHeader.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { DatasetSummary, MetadataRow } from "../src/api-client/types.ts";
import type { ColumnRoles } from "../src/generated/column_roles.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));
const SIDECAR = join(FIXTURES_DIR, "golden_dataset", "tags", "tags_v1.arrow");

const fixtureTags = () => tableFromIPC(readFileSync(SIDECAR));

const GOLDEN_ROLES: ColumnRoles = {
  filename: { column: "filename", label: "Filename" },
  tag: [{ column: "tags", label: "Tags", delimiter: "," }],
};

// ---------------------------------------------------------------------------
// LayoutSwitcher
// ---------------------------------------------------------------------------

test("LayoutSwitcher renders every layout label (scatter included) and marks the active one", () => {
  const html = renderToString(
    h(LayoutSwitcher, {
      layouts: [
        { layout_id: "grid", label: "Grid", type: "grid" },
        { layout_id: "scatter_umap_x", label: "UMAP", type: "scatter" },
      ],
      activeLayoutId: "grid",
      onSwitch: () => {},
    }),
  );
  assert.match(html, /Grid/);
  assert.match(html, /UMAP/);
  assert.match(html, /layout-tab-active[^>]*aria-pressed="true"|aria-pressed="true"[^>]*layout-tab-active/);
  assert.match(html, /aria-pressed="false"/);
});

test("LayoutSwitcher (D-35 G3) marks the coordinate families apart and surfaces baked options", () => {
  const html = renderToString(
    h(LayoutSwitcher, {
      layouts: [
        { layout_id: "grid", label: "Grid", type: "grid" },
        { layout_id: "scatter", label: "Dimensions (cm)", type: "scatter" },
        { layout_id: "geographic", label: "By location", type: "geographic" },
      ],
      activeLayoutId: "geographic",
      onSwitch: () => {},
      bakedSummary: {
        scatter: "log × log, fit",
        geographic: "equirectangular",
      },
    }),
  );
  // Every tab carries a data-family hook; the two coordinate families get a visible badge.
  assert.match(html, /data-family="geographic"/);
  assert.match(html, /data-family="scatter"/);
  assert.match(html, /layout-tab-family[^>]*>map</);
  assert.match(html, /layout-tab-family[^>]*>x\/y</);
  // The tooltip still explains each layout's baked options for a mouse...
  assert.match(html, /title="By location \(geographic\) — equirectangular"/);
  assert.match(html, /title="Dimensions \(cm\) \(scatter\) — log × log, fit"/);

  // ...but Seam M3 §3.3.1 ([[T2-131]] a) means it is no longer the ONLY place they live.
  // This assertion used to read `layout-baked-note[^>]*>By location — equirectangular`,
  // i.e. a caption for the ACTIVE layout only; a keyboard or touch user still had no way
  // to see what the OTHER layouts were before switching to them. The summary is content
  // in EVERY tab now, active or not.
  assert.match(html, /layout-tab-note[^>]*>equirectangular</);
  assert.match(html, /layout-tab-note[^>]*>log × log, fit</);

  // ...and the active-layout caption is GONE, which is [[T2-131]](b): it appeared and
  // disappeared across switches, changing .topbar-layouts height and resizing the canvas.
  assert.doesNotMatch(html, /layout-baked-note/);
});

test("LayoutSwitcher (M3 §3.3.1) renders no summary line for a layout that has none", () => {
  // The counterpart to the pin above, and what makes the tab row's height stable: a tab
  // with nothing to explain gets ONE line, not an empty second one. The row's height is a
  // max over all tabs and so does not depend on which tab is active — the property that
  // closes T2-131(b). (grid/datetime have no shaping options; describeBakedOptions
  // returns null for them — see ui_layout_options.test.ts.)
  const html = renderToString(
    h(LayoutSwitcher, {
      layouts: [
        { layout_id: "grid", label: "Grid", type: "grid" },
        { layout_id: "geographic", label: "By location", type: "geographic" },
      ],
      activeLayoutId: "grid",
      onSwitch: () => {},
      bakedSummary: { grid: null, geographic: "equirectangular" },
    }),
  );
  assert.equal((html.match(/layout-tab-note/g) ?? []).length, 1, "one summary line for two tabs");
  assert.match(html, /layout-tab-note[^>]*>equirectangular</);
});

// ---------------------------------------------------------------------------
// TagControls (chips from the D-14 sidecar; disabled states)
// ---------------------------------------------------------------------------

test("TagControls renders disabled for roles: null (images-only, D-25)", () => {
  const html = renderToString(
    h(TagControls, { roles: null, selection: { selected: [], mode: "or" }, onChange: () => {} }),
  );
  assert.match(html, /tag-controls-disabled/);
  assert.match(html, /no tag metadata/);
});

test("TagControls renders disabled when the sidecar table is unavailable (gap #8)", () => {
  const html = renderToString(
    h(TagControls, { roles: GOLDEN_ROLES, selection: { selected: [], mode: "or" }, onChange: () => {} }),
  );
  assert.match(html, /tag-controls-disabled/);
  assert.match(html, /values are unavailable/);
});

test("TagControls renders most-frequent-first chips from the fixture sidecar", () => {
  const html = renderToString(
    h(
      TagTableContext.Provider,
      { value: fixtureTags() },
      h(TagControls, {
        roles: GOLDEN_ROLES,
        selection: { selected: [{ column: "tags", value: "a" }], mode: "or" },
        onChange: () => {},
      }),
    ),
  );
  // Fixture: "b" on all 10 cells, "a" on evens (5), "c" on odds (5).
  assert.match(html, /b \(10\)/);
  assert.match(html, /a \(5\)/);
  assert.match(html, /c \(5\)/);
  assert.ok(html.indexOf("b (10)") < html.indexOf("a (5)"), "most-frequent first");
  assert.match(html, /chip chip-selected[^>]*>a \(5\)/);
  assert.match(html, /Filter tag values/);
  assert.match(html, /Clear \(1\)/);
});

test("deriveTagChips + toggleTagValue (pure helpers)", () => {
  const chips = deriveTagChips(fixtureTags(), ["tags"]).get("tags");
  assert.deepEqual(chips, [
    { value: "b", count: 10 },
    { value: "a", count: 5 },
    { value: "c", count: 5 },
  ]);
  const sel0 = { selected: [], mode: "and" as const };
  const sel1 = toggleTagValue(sel0, "tags", "a");
  assert.deepEqual(sel1, { selected: [{ column: "tags", value: "a" }], mode: "and" });
  const sel2 = toggleTagValue(sel1, "tags", "a");
  assert.deepEqual(sel2.selected, []);
});

// ---------------------------------------------------------------------------
// MetadataPanel (fields via getMetadata; chips via the sidecar; CSS-crop preview)
// ---------------------------------------------------------------------------

test("MetadataPanelView renders fields + tag chips from a mocked row + tags table", () => {
  const row: MetadataRow = { id: 0, fields: { filename: "img_000.png", note: null } };
  const html = renderToString(
    h(MetadataPanelView, {
      selectedCellId: 0,
      row,
      loading: false,
      error: null,
      tagValues: tagValuesForId(fixtureTags(), 0),
      // v2 (D-33): the preview is the cell's detail-tier original URL.
      preview: {
        cellId: 0,
        imageUrl: "http://edge/api/datasets/golden_dataset_v2/detail/0.webp",
      },
    }),
  );
  assert.match(html, /Cell 0/);
  assert.match(html, /img_000\.png/);
  assert.match(html, /note/); // null field renders as an em dash
  assert.match(html, /—/);
  assert.match(html, /chip chip-static[^>]*>a</); // sidecar chip, not getMetadata
  assert.match(html, /chip chip-static[^>]*>b</);
  assert.match(html, /img[^>]*src="http:\/\/edge\/api\/datasets\/golden_dataset_v2\/detail\/0\.webp"/);
});

test("MetadataPanel initial render: empty prompt for null id, loading for a selected id", () => {
  const client = {} as ApiClient; // effects never run under renderToString
  const empty = renderToString(
    h(MetadataPanel, { dataset: "ds", selectedCellId: null, client }),
  );
  assert.match(empty, /Click a cell/);
  const loading = renderToString(
    h(
      MetadataPanelDataContext.Provider,
      { value: { tagsTable: fixtureTags(), preview: null } },
      h(MetadataPanel, { dataset: "ds", selectedCellId: 4, client }),
    ),
  );
  assert.match(loading, /Loading metadata/);
});

test("tagValuesForId reads the selected cell's chips from the sidecar", () => {
  assert.deepEqual(tagValuesForId(fixtureTags(), 0), [{ column: "tags", values: ["a", "b"] }]);
  assert.deepEqual(tagValuesForId(fixtureTags(), 1), [{ column: "tags", values: ["b", "c"] }]);
  assert.deepEqual(tagValuesForId(fixtureTags(), 999), []);
});

// ---------------------------------------------------------------------------
// SelectionSummary (count + per-categorical-value counts + date range + cap)
// ---------------------------------------------------------------------------

const SUMMARY_ROLES: ColumnRoles = {
  filename: { column: "filename", label: "Filename" },
  categorical: [{ column: "category", label: "Category" }],
  datetime: { column: "shot_date", label: "Shot date", format: "iso8601" },
};

const SUMMARY_ROWS: MetadataRow[] = [
  { id: 0, fields: { category: "cats", shot_date: "2026-01-02" } },
  { id: 1, fields: { category: "dogs", shot_date: "2026-01-01" } },
  { id: 2, fields: { category: "cats", shot_date: "2026-01-03" } },
];

test("summarizeRows aggregates categorical counts and the datetime range", () => {
  const digest = summarizeRows(SUMMARY_ROWS, SUMMARY_ROLES);
  assert.deepEqual(digest.categorical, [
    {
      column: "category",
      label: "Category",
      counts: [
        { value: "cats", count: 2 },
        { value: "dogs", count: 1 },
      ],
    },
  ]);
  assert.deepEqual(digest.dateRange, {
    column: "shot_date",
    label: "Shot date",
    min: "2026-01-01",
    max: "2026-01-03",
  });
});

test("SelectionSummary renders the count, value counts, range, and the 250-cap note", () => {
  const html = renderToString(
    h(SelectionSummary, { count: 5, rows: SUMMARY_ROWS, roles: SUMMARY_ROLES }),
  );
  assert.match(html, /5 cells selected/);
  assert.match(html, /first 3 of 5/); // the shell passes the first <=250 rows
  assert.match(html, /capped at 250/);
  assert.match(html, /cats: 2/);
  assert.match(html, /dogs: 1/);
  assert.match(html, /2026-01-01 – 2026-01-03/);
  // "Clear selection" moved to the inspector header (T2-204) so a SINGLE selection
  // can be cleared too — it is no longer this component's to render.
  assert.doesNotMatch(html, /Clear selection/);
});

// ---------------------------------------------------------------------------
// Admin: DatasetList chips, AuthPanel, RoleAssignmentForm, JobProgressView
// ---------------------------------------------------------------------------

function summary(id: string, status: DatasetSummary["status"]): DatasetSummary {
  return {
    dataset_id: id,
    dataset_version: status === "ready" ? 1 : 0,
    image_count: status === "ready" ? 10 : 0,
    ingest_timestamp: "2026-05-29T00:00:00Z",
    layout_ids: status === "ready" ? ["grid"] : [],
    owner: "ada",
    status,
  };
}

test("DatasetList renders processing/ready/error chips from mocked summaries", () => {
  const html = renderToString(
    h(DatasetList, {
      datasets: [summary("a", "processing"), summary("b", "ready"), summary("c", "error")],
      client: {} as ApiClient, // T2-55 cover fetch runs in an effect; server render never fires it
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onNewDataset: () => {},
    }),
  );
  assert.match(html, /status-chip status-processing/);
  assert.match(html, /status-chip status-ready/);
  assert.match(html, /status-chip status-error/);
  // Delete lives in the ready card's ⋯ menu (closed by default, so its trigger is
  // present); the web Re-ingest action was removed (fix/reingest-safety — CLI-only).
  assert.ok(!/Re-ingest/.test(html));
  assert.match(html, /card-menu-btn/);
  // The ready card exposes an enabled accent Open; the processing card shows a
  // disabled "Open when ready" and the error card offers no Open at all.
  assert.match(html, /class="btn pri"[^>]*>Open<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Open when ready<\/button>/);
});

test("DatasetList empty state points at the wizard", () => {
  const html = renderToString(
    h(DatasetList, {
      datasets: [],
      client: {} as ApiClient, // T2-55: unused by the empty state, but a required prop
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onNewDataset: () => {},
    }),
  );
  assert.match(html, /Nothing plotted yet/);
  assert.match(html, /\+ New dataset/);
});

test("AuthPanel renders the login form (username/password/submit)", () => {
  const html = renderToString(h(AuthPanel, { client: {} as ApiClient, onAuthenticated: () => {} }));
  assert.match(html, /Log in/);
  assert.match(html, /Username/);
  assert.match(html, /type="password"/);
  assert.match(html, /Sign up/); // the mode switch link
});

test("RoleAssignmentForm renders dropdowns from a parsed CSV header", () => {
  const header = parseCsvHeader('filename,"location, city",category,tags\n');
  const html = renderToString(h(RoleAssignmentForm, { draft: emptyDraft(header), onChange: () => {} }));
  assert.match(html, /Role for column filename/);
  assert.match(html, /Role for column location, city/);
  assert.match(html, /Role for column category/);
  assert.match(html, /Role for column tags/);
  // Role options cover the families; scatter is a separate atomic-pair section.
  for (const option of ["Filename (join key)", "Datetime", "Categorical", "Tags", "Freeform (display only)"]) {
    assert.ok(html.includes(option), option);
  }
  assert.match(html, /Add scatter pair \(X\/Y\)/);
});

test("RoleAssignmentForm offers 'render as link' only for shown scalar columns (v2.8)", () => {
  const draft = emptyDraft(["filename", "homepage", "shot_date"]);
  draft.choice.homepage = "freeform";
  draft.choice.shot_date = "datetime";
  const html = renderToString(h(RoleAssignmentForm, { draft, onChange: () => {} }));
  // A freeform column offers the orthogonal link toggle...
  assert.match(html, /Render column homepage as a link/);
  // ...but a datetime column does not (a datetime is not a URL-bearing shown scalar).
  assert.ok(!/Render column shot_date as a link/.test(html));
  // The old mutually-exclusive "Link" ROLE option is gone — url is a modifier, not a role.
  assert.ok(!/Link \(display as a URL\)/.test(html));
});

test("RoleAssignmentForm shows datetime format + tag delimiter controls for assigned roles", () => {
  const draft = emptyDraft(["filename", "date", "tags"]);
  draft.choice.date = "datetime";
  draft.choice.tags = "tag";
  const html = renderToString(h(RoleAssignmentForm, { draft, onChange: () => {} }));
  assert.match(html, /Datetime format/);
  assert.match(html, /ISO 8601 strings/);
  assert.match(html, /Tag delimiter for column tags/);
});

test("RoleAssignmentForm (D-35 G3): scatter knobs + a SEPARATE Geographic section + microcopy", () => {
  const draft = emptyDraft(["filename", "sx", "sy", "lon", "lat"]);
  draft.scatterPairs = [{ x: "sx", y: "sy", label: "S" }];
  draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Where" }];
  const html = renderToString(h(RoleAssignmentForm, { draft, onChange: () => {} }));

  // Scatter (x/y) pairs gain per-pair knob controls (scale/placement/overlap). Scale is ONE
  // knob driving both axes — the pipeline rejects a mixed pair, so a per-axis dropdown could
  // only offer a state ingest fail-fasts on (T2-128 would split it back).
  assert.match(html, /Scatter pair 1 axis scale/);
  assert.ok(!/Scatter pair 1 (X|Y) scale/.test(html), "per-axis scale knobs would offer a rejected state");
  assert.match(html, /Scatter pair 1 placement/);
  assert.match(html, /Scatter pair 1 overlap/);
  // A SEPARATE Geographic (lat/long) section — lon/lat + projection + overlap, distinct
  // from scatter, no scale knobs.
  assert.match(html, /Geographic layouts \(lat\/long/);
  assert.match(html, /Add geographic pair \(lat\/long\)/);
  assert.match(html, /Geographic pair 1 longitude column/);
  assert.match(html, /Geographic pair 1 latitude column/);
  assert.match(html, /Geographic pair 1 projection/);
  assert.ok(!/Geographic pair 1 (X|Y) scale/.test(html), "geographic has NO scale knobs (degrees are degrees)");

  // Per-option microcopy (the "options + information" half). The microcopy is the WHOLE
  // explanation today — the long-form "Layout options explained" page every option control
  // should deep-link to is D-35 Seam G5's deliverable and does not exist yet, so the knobs
  // ship no outbound link rather than a link to a placeholder.
  assert.match(html, /even axis spacing/); // selected linear-scale microcopy
  assert.match(html, /shapes distort at high latitude/); // selected equirectangular microcopy
  assert.ok(!/<a\b/.test(html), "a knob grew an outbound link before the explainer page exists");

  // The reserved overlap modes are visible-but-DISABLED ("coming soon"), with their microcopy
  // — the UI is ready and honest, never silently offering something ingest rejects.
  assert.match(html, /Jitter \(coming soon\)/);
  assert.match(html, /displaces images slightly from their true position/); // jitter microcopy
});

test("RoleAssignmentForm lists geographic in the 'This dataset will offer' unlocks", () => {
  const draft = emptyDraft(["filename", "lon", "lat"]);
  draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Where" }];
  const html = renderToString(
    h(RoleAssignmentForm, { draft, onChange: () => {}, unlocks: ["grid", "geographic"] }),
  );
  assert.match(html, /unlock-chip[^>]*>Geographic</);
});

test("JobProgressView shows the state, an indeterminate bar, and the log behind a disclosure", () => {
  const running = renderToString(
    h(JobProgressView, {
      jobId: "j1",
      status: { job_id: "j1", state: "started", dataset_id: "ds", log_tail: ["step 1", "step 2"] },
      pollError: null,
    }),
  );
  assert.match(running, /Processing…/);
  // Board 1g step 3: no fake %, an indeterminate accent bar, honest-wait copy,
  // and the log tail behind a ▸ show log disclosure (closed on first render).
  assert.match(running, /progress-indeterminate/);
  assert.ok(!/progress-pct/.test(running), "no fabricated % without a real signal");
  assert.match(running, /keeps running; the Library shows live status/);
  assert.match(running, /▸ show log/);
  assert.ok(!/step 1\nstep 2/.test(running), "log tail hidden until the disclosure opens");

  const failed = renderToString(
    h(JobProgressView, {
      jobId: "j1",
      status: { job_id: "j1", state: "failed", dataset_id: "ds", log_tail: [], error: "boom at ingest" },
      pollError: null,
    }),
  );
  assert.match(failed, /Failed\./);
  assert.match(failed, /boom at ingest/);
  // Terminal state: the indeterminate bar and wait copy are gone.
  assert.ok(!/progress-indeterminate/.test(failed), "no running bar once terminal");
});

test("bakeTimeEstimate buckets by magnitude (honest range, never an ETA)", () => {
  assert.equal(bakeTimeEstimate(94), "a few minutes");
  assert.equal(bakeTimeEstimate(1_000), "a few minutes");
  assert.equal(bakeTimeEstimate(10_000), "several minutes to an hour");
  assert.equal(bakeTimeEstimate(100_000), "roughly one to a few hours");
  assert.equal(bakeTimeEstimate(1_000_000), "several hours or more");
});

test("waitCopy shows the count first then a count-tied warning, or the generic line when unknown", () => {
  const known = waitCopy(94);
  assert.match(known, /^94 images detected/); // count FIRST
  assert.match(known, /baking typically takes a few minutes/);
  assert.match(known, /keeps running; the Library shows live status/);
  assert.match(waitCopy(1), /^1 image detected/); // singular
  // null ⇒ the generic honest-wait line (no fabricated count/ETA).
  assert.match(waitCopy(null), /Ingest can take minutes to hours at this scale/);
});

test("JobProgressView surfaces the image count first, then the time warning", () => {
  const html = renderToString(
    h(JobProgressView, {
      jobId: "j1",
      status: { job_id: "j1", state: "started", dataset_id: "ds", log_tail: [] },
      pollError: null,
      imageCount: 94,
    }),
  );
  assert.match(html, /94 images detected/);
  assert.match(html, /baking typically takes a few minutes/);
  assert.ok(
    html.indexOf("94 images detected") < html.indexOf("baking typically takes"),
    "count rendered before the warning",
  );
  assert.ok(!/progress-pct/.test(html), "still no fabricated %");
});
