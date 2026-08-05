// §4.5 seam acceptance — the FULL admin flow, end-to-end at the component
// level with the API mocked at the fetch layer and the REAL ApiClient:
//
//   signup → login (no bearer on either; token feeds the getToken closure) →
//   upload session → parts incl. a ZIP (D-27; ignored entries surfaced) +
//   the CSV → header parsed CLIENT-SIDE from the local File (§0.5 — note the
//   mock answers NO preview endpoint) → roles from dropdown choices →
//   createDataset (exact column_roles + gated layout_types on the wire) →
//   job polling queued→started→finished (jobPoll, injected sleep) → the list
//   shows `processing` then `ready` (DatasetList chips, D-28).
//
// The same pure handlers/components the wizard binds are driven directly —
// node cannot click, but every data edge the UI exercises is exercised here.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { createApiClient } from "../src/api-client/client.ts";
import type { DatasetSummary, JobStatus } from "../src/api-client/types.ts";
import { parseCsvHeader } from "../src/ui/admin/csvHeader.ts";
import { availableLayoutTypes, buildColumnRoles, emptyDraft } from "../src/ui/admin/roles.ts";
import { pollJob } from "../src/ui/admin/jobPoll.ts";
import { DatasetList } from "../src/ui/admin/DatasetList.ts";

test("admin flow: signup → ZIP+CSV upload → roles → create → poll → processing then ready", async (t) => {
  // ---- in-memory API ------------------------------------------------------
  const TOKEN = "tok-flow";
  const seenUrls: string[] = [];
  const unauthedUrls: string[] = [];
  const partsReceived: string[] = [];
  let finalized = false;
  let createBody: Record<string, unknown> | null = null;
  const jobStates = ["queued", "started", "finished"];
  let jobPollCount = 0;
  let datasetCreated = false;

  const jobState = (): string => jobStates[Math.min(jobPollCount, jobStates.length - 1)];

  function listBody(): { datasets: DatasetSummary[] } {
    if (!datasetCreated) return { datasets: [] };
    const ready = jobState() === "finished";
    return {
      datasets: [
        {
          dataset_id: "my_shoot",
          dataset_version: ready ? 1 : 0,
          image_count: ready ? 10 : 0,
          ingest_timestamp: "2026-06-12T00:00:00Z",
          layout_ids: ready ? ["grid", "categorical"] : [],
          owner: "ada",
          status: ready ? "ready" : "processing",
        },
      ],
    };
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    seenUrls.push(`${method} ${url}`);

    if (url.endsWith("/api/auth/signup") && method === "POST") {
      if (headers.Authorization !== undefined) unauthedUrls.push(url); // must NOT happen
      return json({ username: "ada", email: "ada@example.org" });
    }
    if (url.endsWith("/api/auth/login") && method === "POST") {
      if (headers.Authorization !== undefined) unauthedUrls.push(url);
      return json({ access_token: TOKEN, token_type: "bearer" });
    }
    // Everything else requires the bearer (identity-only JWT, D-24).
    if (headers.Authorization !== `Bearer ${TOKEN}`) {
      return json({ detail: "Not authenticated" }, 401);
    }

    if (url.endsWith("/api/uploads") && method === "POST") {
      return json({ upload_id: "u1" });
    }
    if (url.endsWith("/api/uploads/u1/parts") && method === "POST") {
      const part = (init?.body as FormData).get("part");
      assert.ok(part instanceof File, "multipart 'part' field is a File");
      partsReceived.push(part.name);
      const isZip = part.name.toLowerCase().endsWith(".zip");
      return json({
        upload_id: "u1",
        state: "open",
        received_parts: partsReceived.length,
        bytes_received: 1234,
        // D-27: ZIP extraction reports skipped entries per-response.
        ignored: isZip ? ["notes.txt"] : [],
      });
    }
    if (url.endsWith("/api/uploads/u1/finalize") && method === "POST") {
      finalized = true;
      return json({ upload_id: "u1" });
    }
    if (url.endsWith("/api/datasets") && method === "POST") {
      assert.ok(finalized, "createDataset only after finalize");
      createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      datasetCreated = true;
      return json({ dataset_id: "my_shoot", job_id: "j1" });
    }
    if (url.endsWith("/api/jobs/j1") && method === "GET") {
      const state = jobState();
      jobPollCount += 1;
      const status: JobStatus = {
        job_id: "j1",
        state,
        dataset_id: "my_shoot",
        log_tail: [`ingest: ${state}`],
        error: null,
      };
      return json(status);
    }
    if (url.endsWith("/api/datasets") && method === "GET") {
      return json(listBody());
    }
    return json({ detail: `no route for ${method} ${url}` }, 404);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  // ---- the flow, exactly as the UI drives it ------------------------------
  let token: string | null = null;
  const client = createApiClient("http://edge", () => token);

  // 1. signup → login; the token feeds the shell-owned closure (App.tsx).
  await client.signup({ username: "ada", email: "ada@example.org", password: "pw123456" });
  token = (await client.login({ username: "ada", password: "pw123456" })).access_token;
  assert.equal(unauthedUrls.length, 0, "signup/login carried no bearer");

  // 2. upload session → ZIP part + CSV part → finalize (CreateDatasetWizard.create).
  const session = await client.createUpload();
  const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "shoot.zip", {
    type: "application/zip",
  });
  const csvText = "filename,category,tags\nimg_000.png,cats,a|b\n";
  const csv = new File([csvText], "metadata.csv", { type: "text/csv" });

  const zipStatus = await client.uploadPart(session.upload_id, zip);
  assert.deepEqual(zipStatus.ignored, ["notes.txt"], "D-27 skip report surfaced");
  await client.uploadPart(session.upload_id, csv);
  await client.finalizeUpload(session.upload_id);
  assert.deepEqual(partsReceived, ["shoot.zip", "metadata.csv"]);

  // 3. header parsed CLIENT-SIDE from the local File (no preview endpoint).
  const header = parseCsvHeader(await csv.text());
  assert.deepEqual(header, ["filename", "category", "tags"]);
  const draft = emptyDraft(header);
  draft.choice.category = "categorical";
  draft.choice.tags = "tag";
  const layoutTypes = availableLayoutTypes(draft);
  assert.deepEqual(layoutTypes, ["grid", "categorical"]);

  // 4. createDataset with the compiled roles + gated layout types.
  const created = await client.createDataset({
    dataset_id: "my_shoot",
    upload_id: session.upload_id,
    column_roles: buildColumnRoles(draft),
    layout_types: layoutTypes,
  });
  assert.equal(created.job_id, "j1");
  assert.deepEqual(createBody, {
    dataset_id: "my_shoot",
    upload_id: "u1",
    column_roles: {
      filename: { column: "filename", label: "Filename" },
      categorical: [{ column: "category", label: "category" }],
      tag: [{ column: "tags", label: "tags", delimiter: "," }],
    },
    layout_types: ["grid", "categorical"],
  });

  // 5. while the job runs, the list shows `processing` (D-28 chips).
  const processingList = await client.listDatasets();
  assert.equal(processingList[0].status, "processing");
  const processingHtml = renderToString(
    h(DatasetList, {
      datasets: processingList,
      client, // T2-55: DatasetList requires the client for the cover fetch (effect-only)
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onNewDataset: () => {},
    }),
  );
  assert.match(processingHtml, /status-chip status-processing/);
  assert.match(
    processingHtml,
    /<button[^>]*disabled[^>]*>Open when ready<\/button>/,
    "Open gated until ready (board 1f)",
  );

  // 6. poll to the terminal state (2s→10s schedule is unit-tested; injected
  //    sleep here) and observe queued→started→finished.
  const updates: string[] = [];
  const last = await pollJob(client, "j1", (s) => updates.push(s.state), {
    sleep: async () => {},
  });
  assert.deepEqual(updates, ["queued", "started", "finished"]);
  assert.equal(last.log_tail[0], "ingest: finished");

  // 7. the list now shows `ready`, and Open is available.
  const readyList = await client.listDatasets();
  assert.equal(readyList[0].status, "ready");
  const readyHtml = renderToString(
    h(DatasetList, {
      datasets: readyList,
      client, // T2-55: cover fetch is effect-only; server render never fires it
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onNewDataset: () => {},
    }),
  );
  assert.match(readyHtml, /status-chip status-ready/);
  // The ready card's Open is an enabled accent button (no `disabled`).
  assert.match(readyHtml, /class="btn pri"[^>]*>Open<\/button>/);
  assert.ok(
    !/<button[^>]*disabled[^>]*>Open(?: when ready)?<\/button>/.test(readyHtml),
    "Open enabled once ready",
  );

  // 8. §0.5 invariant: the ONLY routes touched are the catalogued ones — no
  //    header-preview/tag-values endpoint exists or was needed.
  for (const entry of seenUrls) {
    assert.match(
      entry,
      /\/api\/(auth\/(signup|login)|uploads(\/u1(\/parts|\/finalize)?)?|datasets|jobs\/j1)$/,
      `unexpected route: ${entry}`,
    );
  }
});
