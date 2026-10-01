// DOM tier (T2-resuming-a-sealed-upload-starts-a-fresh-one-so): resuming an upload the
// server has ALREADY SEALED creates from that same upload instead of re-uploading it.
//
// An earlier run finalized its bundle and then lost — or never got — its create's answer.
// The resume anchor survived, the user re-selected the same files and pressed Resume, and
// `listUploads` reports the session `finalized`. Re-uploading would mint a NEW upload id,
// which the API's per-upload 409 cannot recognise, so the retry built a second collection.
// Now the wizard sends no parts and no /check, and creates from the persisted upload: a
// 200 is an ordinary create, and the `upload_already_created` 409 is adopted. An upload
// that is GONE (expired / swept) still falls back to a fresh upload, exactly as before.
//
// `createDataset` is the REAL client's over a stubbed `fetch`, so a 409 is built by the
// same `toApiError` a live one goes through. Assertions are counts and booleans only, and
// every wait is a boolean poll: a `findBy*` that times out formats the rendered tree.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createApiClient } from "../../src/api-client/client.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import { ADOPTED_WITHOUT_JOB_NOTICE, CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";
import { fingerprintFiles } from "../../src/ui/admin/uploadSelection.ts";
import { UPLOAD_SESSION_STORAGE_KEY } from "../../src/ui/admin/uploadSession.ts";
import { imagesInput, useWizardDomIsolation } from "./wizardDom.ts";

useWizardDomIsolation(beforeEach, afterEach);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const PERSISTED = "u9";
const FRESH = "u-new";
const FRESH_NOTICE = /starting a fresh upload/;
const SEALED_NOTICE = /Your upload already finished — creating the collection from it\./;

interface Recorder {
  createUploads: number;
  parts: number;
  checks: number;
  finalizes: number;
  createdFrom: string[];
  polled: string[];
}

function newRecorder(): Recorder {
  return { createUploads: 0, parts: 0, checks: 0, finalizes: 0, createdFrom: [], polled: [] };
}

const IMAGE = new File([new Uint8Array([1])], "a.png", { type: "image/png" });

/** Persist an interrupted session whose fingerprint matches re-selecting exactly [IMAGE],
 *  so "Resume upload" is the offered action — the shape the wizard itself writes. */
function persistSession(): void {
  localStorage.setItem(
    UPLOAD_SESSION_STORAGE_KEY,
    JSON.stringify({ uploadId: PERSISTED, fingerprint: fingerprintFiles([IMAGE]), fileCount: 1, totalBytes: 1 }),
  );
}

/** A wizard client. `sessionState` is what `listUploads` reports for the persisted upload
 *  ("gone" = not listed at all). `createDataset` is the REAL client's, over a `fetch` that
 *  answers `createStatus` / `createBody` — or never answers, for "hang", which holds the
 *  run on the create so a spec can read what the screen says meanwhile. It records which
 *  upload each create names. */
function wizardClient(
  sessionState: "finalized" | "gone",
  createStatus: number | "hang",
  createBody: unknown,
  rec: Recorder,
  opts: { later?: { status: number; body: unknown }[]; holdStatus?: boolean } = {},
): ApiClient {
  // `later`: answers for the 2nd, 3rd, … create, in order; the first is createStatus/Body.
  const later = [...(opts.later ?? [])];
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { upload_id?: string };
    rec.createdFrom.push(sent.upload_id ?? "");
    if (createStatus === "hang") return new Promise<Response>(() => {});
    const answer =
      rec.createdFrom.length > 1 && later.length > 0
        ? (later.shift() as { status: number; body: unknown })
        : { status: createStatus, body: createBody };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const real = createApiClient("http://api.test", () => "token");
  return {
    async listUploads() {
      return sessionState === "gone"
        ? []
        : [{ upload_id: PERSISTED, state: sessionState, received_parts: 1, bytes_received: 1, created: 0, last_activity: 0 }];
    },
    async createUpload() {
      rec.createUploads += 1;
      return { upload_id: FRESH };
    },
    async uploadPartWithProgress(uploadId: string, part: File, onProgress?: (l: number, t: number) => void) {
      rec.parts += 1;
      onProgress?.(part.size, part.size);
      return { upload_id: uploadId, state: "open", received_parts: 1, bytes_received: part.size, ignored: [] };
    },
    async checkUploadFiles() {
      rec.checks += 1;
      return { present: [], needed: ["a.png"], mismatched: [] };
    },
    async finalizeUpload(uploadId: string) {
      rec.finalizes += 1;
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string) {
      if (opts.holdStatus === true) return new Promise(() => {});
      return { upload_id: uploadId, state: "finalized", received_parts: 1, bytes_received: 1, ignored: [] };
    },
    async createDataset(req: Parameters<ApiClient["createDataset"]>[0]) {
      return real.createDataset(req);
    },
    async getJob(jobId: string) {
      rec.polled.push(jobId);
      return { job_id: jobId, state: "finished", dataset_id: "3f9c2a71e0b4", log_tail: [], error: null };
    },
  } as unknown as ApiClient;
}

function errorsShown(): number {
  return document.querySelectorAll("p.error-text").length;
}

function onProgressView(): boolean {
  return screen.queryAllByRole("button", { name: "Back to Library" }).length > 0;
}

/** Wait until `settled()` holds or 5 s pass, and answer whether it held. */
async function settles(settled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (!settled() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return settled();
}

/** Mount, re-select the persisted files, and press Resume TWICE in one act(): React has
 *  not re-rendered between the dispatches, so only the run token can tell them apart. */
async function resumeTwice(client: ApiClient): Promise<void> {
  const { container } = render(h(CreateDatasetWizard, { client, onDone() {}, onAuthExpired() {} }));
  fireEvent.change(imagesInput(container), { target: { files: [IMAGE] } });
  const resume = screen.getByRole("button", { name: "Resume upload" });
  await act(async () => {
    resume.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    resume.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

test("resuming a SEALED upload sends nothing and creates once from the persisted upload", async () => {
  persistSession();
  const rec = newRecorder();
  await resumeTwice(wizardClient("finalized", 200, { dataset_id: "3f9c2a71e0b4", job_id: "job-new" }, rec));

  assert.equal(await settles(() => onProgressView() || errorsShown() > 0), true, "the run came to rest");
  assert.equal(onProgressView(), true, "a 200 proceeds as a normal create");
  assert.equal(rec.createUploads, 0, "no new upload session");
  assert.equal(rec.parts, 0, "no part is re-sent");
  assert.equal(rec.checks, 0, "no /check diff");
  assert.equal(rec.createdFrom.length, 1, "exactly one create, for two clicks");
  assert.equal(rec.createdFrom[0] === PERSISTED, true, "the create names the persisted upload");
  assert.equal(rec.polled.length >= 1 && rec.polled.every((id) => id === "job-new"), true, "the new job is polled");
  assert.equal(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) === null, true, "the anchor is consumed");
});

test("resuming a SEALED upload whose create already happened adopts that collection", async () => {
  persistSession();
  const rec = newRecorder();
  const conflict = {
    detail: {
      code: "upload_already_created",
      message:
        "This upload already backs one of your collections. Delete that collection to build a new one from it, or create with an explicit dataset_id.",
      dataset_id: "3f9c2a71e0b4",
      job_id: "job-first",
    },
  };
  await resumeTwice(wizardClient("finalized", 409, conflict, rec));

  assert.equal(await settles(() => onProgressView() || errorsShown() > 0), true, "the run came to rest");
  assert.equal(onProgressView(), true, "the collection is adopted, not reported as a failure");
  assert.equal(errorsShown(), 0, "no error is shown");
  assert.equal(rec.createUploads + rec.parts + rec.checks, 0, "nothing is re-uploaded");
  assert.equal(rec.createdFrom.length, 1, "exactly one create");
  assert.equal(rec.polled.length >= 1 && rec.polled.every((id) => id === "job-first"), true, "the adopted job is polled");
  assert.equal(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) === null, true, "the anchor is consumed");
});

test("resuming a SEALED upload whose collection's job is no longer live says so, polls nothing", async () => {
  // The commonest real case of this path: the user comes back later, so the first bake
  // has finished (or failed, or aged out of RQ) and the API's 409 carries `job_id: null`
  // (review of PR #373, operator finding 2). Nothing is re-uploaded, nothing is polled,
  // and the wizard says why nothing new was created.
  persistSession();
  const rec = newRecorder();
  const conflict = {
    detail: { code: "upload_already_created", message: "m", dataset_id: "3f9c2a71e0b4", job_id: null },
  };
  await resumeTwice(wizardClient("finalized", 409, conflict, rec));

  const noticeShown = () => screen.queryAllByText(ADOPTED_WITHOUT_JOB_NOTICE).length > 0;
  assert.equal(await settles(() => noticeShown() || errorsShown() > 0), true, "the run came to rest");
  assert.equal(noticeShown(), true, "it says nothing new was created, and where it is");
  assert.equal(errorsShown(), 0, "no error is shown");
  assert.equal(rec.createUploads + rec.parts + rec.checks, 0, "nothing is re-uploaded");
  assert.equal(rec.createdFrom.length, 1, "exactly one create");
  assert.equal(rec.polled.length, 0, "nothing is polled");
  assert.equal(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) === null, true, "the anchor is consumed");
});

test("a FAILED create on the sealed path leaves an honest form, keeps the anchor, and a later Resume creates from the same upload", async () => {
  // Review of PR #375, findings 1 and 2. The create answers 503 "dataset busy; try again".
  // The form must not still claim the collection is being created, and its banner must not
  // promise to "send only what's missing" (nothing is). And the anchor must SURVIVE: if it
  // were cleared, a reload would lose it, the next attempt would re-upload under a NEW
  // upload id, and the duplicate-collection bug this path fixes would be back.
  persistSession();
  const rec = newRecorder();
  const client = wizardClient("finalized", 503, { detail: "dataset busy; try again" }, rec, {
    later: [{ status: 200, body: { dataset_id: "3f9c2a71e0b4", job_id: "job-new" } }],
  });
  await resumeTwice(client);

  assert.equal(await settles(() => errorsShown() > 0 || onProgressView()), true, "the run came to rest");
  assert.equal(errorsShown(), 1, "the create's error is shown");
  assert.equal(screen.queryAllByText(SEALED_NOTICE).length, 0, "the run's notice is gone with the run");
  assert.equal(screen.queryAllByText(/send only what's missing/).length, 0, "the banner promises no upload");
  assert.equal(screen.queryAllByText(/it is complete\. Click "Resume upload" to create the collection from it\./).length, 1, "the banner says what Resume will do");
  const stored = JSON.parse(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) ?? "null") as { uploadId?: string } | null;
  assert.equal(stored?.uploadId === PERSISTED, true, "the anchor survives the failed create");

  // A reload: a new wizard over the same storage, the same files, Resume.
  cleanup();
  await resumeTwice(client);

  assert.equal(await settles(() => onProgressView() || errorsShown() > 0), true, "the second run came to rest");
  assert.equal(onProgressView(), true, "the second create proceeds");
  assert.equal(rec.createUploads + rec.parts + rec.checks, 0, "nothing was ever re-uploaded");
  assert.equal(rec.createdFrom.length === 2 && rec.createdFrom.every((u) => u === PERSISTED), true, "both creates name the persisted upload");
});

test("while the sealed path reads the upload status there is no Cancel and no stale check line", async () => {
  // Review of PR #375, finding 3. Nothing in `createFromSealedUpload` can stop the create
  // once it starts, so Cancel must not be offered at any point of it — including the
  // `getUploadStatus` read, held open here. What hides it is the `enqueueing` stage; on
  // `checking`, the screen offered Cancel and the create was sent anyway.
  persistSession();
  const rec = newRecorder();
  await resumeTwice(
    wizardClient("finalized", 200, { dataset_id: "3f9c2a71e0b4", job_id: "job-new" }, rec, { holdStatus: true }),
  );

  assert.equal(await settles(() => screen.queryAllByText(SEALED_NOTICE).length > 0), true, "the sealed path started");
  assert.equal(rec.createdFrom.length, 0, "held before the create");
  assert.equal(screen.queryAllByRole("button", { name: "Cancel" }).length, 0, "no Cancel is offered");
  assert.equal(screen.queryAllByText("Checking your previous upload…").length, 0, "no stale check line");
});

test("resuming an upload that is GONE still starts a fresh upload, exactly as before", async () => {
  persistSession();
  const rec = newRecorder();
  await resumeTwice(wizardClient("gone", 200, { dataset_id: "3f9c2a71e0b4", job_id: "job-new" }, rec));

  assert.equal(await settles(() => onProgressView() || errorsShown() > 0), true, "the run came to rest");
  // Its narration ("…starting a fresh upload", with the stage moved to "Preparing
  // upload…") is pinned, unedited, by upload_wizard_honesty.dom.test.ts.
  assert.equal(onProgressView(), true, "the fresh run proceeds to its job");
  assert.equal(rec.createUploads, 1, "one fresh upload session");
  assert.equal(rec.parts, 1, "the file is sent");
  assert.equal(rec.finalizes, 1, "the fresh bundle is sealed");
  assert.equal(rec.createdFrom.length, 1, "exactly one create");
  assert.equal(rec.createdFrom[0] === FRESH, true, "the create names the NEW upload");
});

test("the sealed path narrates creating from the finished upload, never a fresh upload", async () => {
  persistSession();
  const rec = newRecorder();
  // The create never answers, so the run is held exactly where the narration matters.
  await resumeTwice(wizardClient("finalized", "hang", null, rec));

  const sealedShown = () => screen.queryAllByText(SEALED_NOTICE).length > 0;
  const freshShown = () => screen.queryAllByText(FRESH_NOTICE).length > 0;
  assert.equal(await settles(() => sealedShown() || freshShown()), true, "the run narrated something");
  assert.equal(rec.createdFrom.length, 1, "held on the create");
  assert.equal(sealedShown(), true, "it says the upload already finished");
  assert.equal(freshShown(), false, "it never says it is starting a fresh upload");
  assert.equal(screen.queryAllByText("Starting ingest…").length, 1, "the stage agrees with the notice");
  assert.equal(
    screen.queryAllByText("Checking your previous upload…").length,
    0,
    "the finished check is not still claimed",
  );
});
