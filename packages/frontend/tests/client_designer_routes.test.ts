// Seam L3 §2b.9 — the Wave A client wrappers the designer (and seams L4/L5) drive: the
// REAL ApiClient with fetch mocked, pinning the exact request each wrapper sends and the
// response shape it hands back. The routes themselves were built by seams L1/L2
// (api/routers/jobs.py, layouts.py, datasets.py); these tests pin that the client speaks
// them, not what the server does with them.
import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/api-client/client.ts";
import type { ColumnRoles } from "../src/generated/column_roles.ts";

const TOKEN = "tok-l3";

interface Seen {
  url: string;
  method: string;
  auth: string | undefined;
  body: unknown;
}

/** Install a fetch mock answering `status` + `json` for every call; returns what it saw. */
async function withFetch<T>(
  status: number,
  json: unknown,
  run: (client: ReturnType<typeof createApiClient>) => Promise<T>,
): Promise<{ seen: Seen[]; result: T }> {
  const seen: Seen[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.Authorization,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const result = await run(createApiClient("http://edge", () => TOKEN));
    return { seen, result };
  } finally {
    globalThis.fetch = original;
  }
}

test("listLayouts sends NO query parameter unless include_pending is asked for", async () => {
  // The viewer's switcher calls this with no options; its request must be byte-identical
  // to the pre-L1 one, because a pending entry there is a control with no tiles.
  const { seen } = await withFetch(200, { layouts: [] }, (c) => c.listLayouts("ds"));
  assert.equal(seen[0].url, "http://edge/api/datasets/ds/layouts");
  const off = await withFetch(200, { layouts: [] }, (c) => c.listLayouts("ds", { includePending: false }));
  assert.equal(off.seen[0].url, "http://edge/api/datasets/ds/layouts");
});

test("listLayouts({includePending}) opts in and passes source_columns through, null ≠ []", async () => {
  // Shaped exactly as api/routers/layouts.py serializes a committed pre-2.9 entry (no
  // provenance → null), a v2.9 grid entry ([]), and a pending row (label = id, type "").
  const served = {
    layouts: [
      { layout_id: "grid", label: "Grid", type: "grid", state: "live", rebake: null, committed_at: "2026-09-01T10:00:00Z", source_columns: [], options: null },
      { layout_id: "datetime", label: "By date", type: "datetime", state: "live", rebake: "queued", committed_at: "2026-09-01T10:00:00Z", source_columns: null, options: null },
      { layout_id: "categorical", label: "categorical", type: "", state: "queued", rebake: null, committed_at: null, source_columns: null, options: null },
    ],
  };
  const { seen, result } = await withFetch(200, served, (c) => c.listLayouts("my ds", { includePending: true }));
  assert.equal(seen[0].url, "http://edge/api/datasets/my%20ds/layouts?include_pending=true");
  assert.deepEqual(result[0].source_columns, []);
  assert.equal(result[1].source_columns, null, "a pre-2.9 entry's null must not be flattened to []");
  assert.equal(result[1].rebake, "queued");
  assert.equal(result[2].state, "queued");
});

test("deleteLayout DELETEs the one layout and returns the enqueued job id", async () => {
  const { seen, result } = await withFetch(202, { job_id: "j-del" }, (c) => c.deleteLayout("ds", "categorical_group"));
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "http://edge/api/datasets/ds/layouts/categorical_group");
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(result, { job_id: "j-del" });
});

test("setColumnRoles POSTs the FULL map under column_roles and returns the job id", async () => {
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "Filename" },
    datetime: { column: "captured", label: "Captured", format: "unix_seconds" },
  };
  const { seen, result } = await withFetch(202, { job_id: "j-roles" }, (c) => c.setColumnRoles("ds", roles));
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "http://edge/api/datasets/ds/column-roles");
  assert.deepEqual(seen[0].body, { column_roles: roles });
  assert.deepEqual(result, { job_id: "j-roles" });
});

test("listColumns reads the collection's columns, and names an upload only when asked", async () => {
  const served = { source: "parquet", columns: [{ name: "sx", dtype: "DOUBLE", sample: "0.5" }] };
  const plain = await withFetch(200, served, (c) => c.listColumns("ds"));
  assert.equal(plain.seen[0].url, "http://edge/api/datasets/ds/columns");
  assert.equal(plain.result.source, "parquet");
  assert.deepEqual(plain.result.columns[0], { name: "sx", dtype: "DOUBLE", sample: "0.5" });
  const named = await withFetch(200, { source: "upload", columns: [] }, (c) => c.listColumns("ds", { uploadId: "u 1" }));
  assert.equal(named.seen[0].url, "http://edge/api/datasets/ds/columns?upload_id=u+1");
});

test("addLayouts forwards `replace` verbatim, and omits it when not given", async () => {
  const withReplace = await withFetch(200, { job_id: "j1" }, (c) =>
    c.addLayouts("ds", { layout_specs: ["datetime"], replace: ["datetime"] }),
  );
  assert.deepEqual(withReplace.seen[0].body, { layout_specs: ["datetime"], replace: ["datetime"] });
  const without = await withFetch(200, { job_id: "j2" }, (c) => c.addLayouts("ds", { layout_specs: ["datetime"] }));
  assert.equal("replace" in (without.seen[0].body as object), false);
});

test("getJob hands back the owner-only verb result verbatim", async () => {
  // Shaped as run_set_roles returns it (pipeline/worker.py) — dataset_version a STRING.
  const result = {
    dataset_id: "ds",
    dataset_version: "3",
    manifest_version: "2.9",
    changed_columns: ["captured"],
    stale_layouts: ["datetime"],
    unknown_layouts: [],
    orphaned_layouts: [],
    renamed_layouts: {},
    unserved_tag_roles: [],
    stale_tag_sidecar: null,
  };
  const { result: job } = await withFetch(
    200,
    { job_id: "j", state: "finished", dataset_id: "ds", log_tail: [], error: null, progress: null, result },
    (c) => c.getJob("j"),
  );
  assert.ok(job.result != null && "changed_columns" in job.result);
  assert.deepEqual(job.result, result);
});
