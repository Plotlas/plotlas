// Shared setup for the layout designer's DOM tests (seam L3): a fake ApiClient serving the
// golden full fixture exactly as the API serves it, and a recorder for what the designer
// writes. Not a test file (no `.dom.test.ts` suffix), like wizardDom.ts beside it.
//
// EVERY RESPONSE IS PRODUCTION-SHAPED, and here is where each shape comes from:
//   - the manifest: tests/designer_fixture/layout_manifest_2.9.json, the golden full
//     fixture refreshed to 2.9 by the real producer (its README has the command);
//   - `listLayouts`: built from that manifest as api/routers/layouts.py `list_layouts`
//     builds it with no job in flight — state "live", rebake null, `source_columns` via
//     `.get` (absent → null), options passed through; `committed_at` is the container
//     mtime the API would stat, fixed here;
//   - `listColumns`: the `parquet` answer for this fixture, MEASURED 2026-09-21 by running
//     DuckDB `DESCRIBE` + the `ORDER BY id LIMIT 1` sample over its metadata.parquet in the
//     worker image, filtered to the ten columns `column_roles` declares, in parquet order
//     (api/routers/datasets.py `_declared_columns`);
//   - `getDataset`: the summary a ready, owned dataset gets (owner resolved from app-state);
//   - `getPresentation`: `{}` — the fixture has no presentation.json, and `{}` is what the
//     real client returns for one that has none.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApiClient } from "../../src/api-client/client.ts";
import type {
  ColumnListResponse,
  DatasetPresentation,
  DatasetSummary,
  LayoutInfo,
} from "../../src/api-client/types.ts";
import type { Presentation } from "../../src/generated/presentation.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";

export const MANIFEST_29 = JSON.parse(
  readFileSync(fileURLToPath(new URL("../designer_fixture/layout_manifest_2.9.json", import.meta.url)), "utf8"),
) as LayoutManifest;

export const DS_ID = "golden_dataset_full_v2";
export const OWNER = "dalew";

export function summary(overrides: Partial<DatasetSummary> = {}): DatasetSummary {
  return {
    dataset_id: DS_ID,
    dataset_version: MANIFEST_29.dataset_version,
    image_count: MANIFEST_29.dataset_metadata.image_count,
    ingest_timestamp: MANIFEST_29.dataset_metadata.ingest_timestamp,
    layout_ids: MANIFEST_29.layouts.map((l) => l.layout_id),
    owner: OWNER,
    status: "ready",
    active_job_id: null,
    display_name: null,
    attribution: null,
    attribution_url: null,
    ...overrides,
  };
}

export function layoutInfos(manifest: LayoutManifest = MANIFEST_29): LayoutInfo[] {
  return manifest.layouts.map((l) => ({
    layout_id: l.layout_id,
    label: l.label,
    type: l.type,
    state: "live",
    rebake: null,
    committed_at: "2026-09-21T09:00:00Z",
    source_columns: (l as { source_columns?: string[] }).source_columns ?? null,
    options: (l as { options?: Record<string, unknown> }).options ?? null,
  }));
}

export const COLUMNS: ColumnListResponse = {
  source: "parquet",
  columns: [
    { name: "filename", dtype: "VARCHAR", sample: "00000.png" },
    { name: "captured", dtype: "TIMESTAMP", sample: "2021-01-01 00:00:00" },
    { name: "group", dtype: "VARCHAR", sample: "group-0" },
    { name: "bucket", dtype: "VARCHAR", sample: "bucket-00" },
    { name: "sx", dtype: "DOUBLE", sample: null },
    { name: "sy", dtype: "DOUBLE", sample: null },
    { name: "lon", dtype: "DOUBLE", sample: null },
    { name: "lat", dtype: "DOUBLE", sample: null },
    { name: "tags", dtype: "VARCHAR[]", sample: null },
    { name: "caption", dtype: "VARCHAR", sample: "cell-00000" },
  ],
};

export interface DesignerRecorder {
  client: ApiClient;
  /** Every presentation PATCH body, in order. */
  patches: Record<string, unknown>[];
  deletes: string[];
  manifestReads: number;
}

/** A fake client over the fixture. `patch` decides each PATCH's outcome (default: echo
 *  the stored scalars, trimmed, blank → null, as `DatasetSummaryPresentation` does). */
export function designerClient(
  opts: {
    dataset?: DatasetSummary;
    presentation?: Presentation;
    patch?: (body: Record<string, unknown>) => Promise<DatasetPresentation> | DatasetPresentation;
    deleteDataset?: () => Promise<void>;
  } = {},
): DesignerRecorder {
  const rec: DesignerRecorder = { client: {} as ApiClient, patches: [], deletes: [], manifestReads: 0 };
  let stored = { ...(opts.dataset ?? summary()) };
  const client = {
    async getDataset(): Promise<DatasetSummary> {
      return stored;
    },
    async listLayouts(): Promise<LayoutInfo[]> {
      return layoutInfos();
    },
    async getPresentation(): Promise<Presentation> {
      return opts.presentation ?? {};
    },
    async listColumns(): Promise<ColumnListResponse> {
      return COLUMNS;
    },
    async getManifest(): Promise<LayoutManifest> {
      rec.manifestReads += 1;
      return MANIFEST_29;
    },
    async setDatasetPresentation(_dsId: string, body: Record<string, unknown>): Promise<DatasetPresentation> {
      rec.patches.push(body);
      if (opts.patch !== undefined) return opts.patch(body);
      const norm = (v: unknown): string | null =>
        typeof v === "string" && v.trim() !== "" ? v.trim() : null;
      for (const key of ["display_name", "attribution", "attribution_url"] as const) {
        if (key in body) stored = { ...stored, [key]: norm(body[key]) };
      }
      return {
        dataset_id: DS_ID,
        display_name: stored.display_name,
        attribution: stored.attribution,
        attribution_url: stored.attribution_url,
      };
    },
    async deleteDataset(dsId: string): Promise<void> {
      rec.deletes.push(dsId);
      if (opts.deleteDataset !== undefined) await opts.deleteDataset();
    },
    coverUrl: (dsId: string) => `/api/datasets/${dsId}/cover`,
    authHeaders: () => ({}),
  };
  rec.client = client as unknown as ApiClient;
  return rec;
}
