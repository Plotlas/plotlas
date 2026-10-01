// DOM tier (T2-a-minted-create-is-not-idempotent-so-a-retried, PR #373): the create
// wizard ADOPTS the collection named by the minted create's structured 409 instead of
// reporting a failure. The API refuses a create with no `dataset_id` whose upload already
// backs one of the caller's collections, and names that collection and its last job
// (docs/interface-catalogue.md, `create_dataset`). A client whose first create's answer
// was lost — or a second tab sending the same upload — must carry on as if the create had
// returned that id and job: clear the upload session, poll THAT job, show no error. Every
// other rejection, including a different 409, still shows the error as before.
//
// The 409 reaches the wizard through the REAL client: `createDataset` is the production
// `createApiClient(...).createDataset` over a stubbed `fetch` that answers the JSON body
// the API serves, so the error is built by the same `toApiError` a live 409 goes through.
// Assertions are counts and booleans only, never a rendered node.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createApiClient } from "../../src/api-client/client.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import { ADOPTED_WITHOUT_JOB_NOTICE, CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";
import { UPLOAD_SESSION_STORAGE_KEY } from "../../src/ui/admin/uploadSession.ts";
import { imagesInput, useWizardDomIsolation } from "./wizardDom.ts";

useWizardDomIsolation(beforeEach, afterEach);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// The first collection, as the API's 409 names it: a minted id and its bake's job.
const FIRST_ID = "3f9c2a71e0b4";
const FIRST_JOB = "job-first";

interface Recorder {
  creates: number;
  polled: string[];
  sessionSavedAtFinalize: boolean;
  done: number;
}

/** A wizard client whose upload half is a stub and whose `createDataset` is the REAL
 *  client's, over a `fetch` that answers every call with `status` and `body`. */
function clientAnswering(status: number, body: unknown, rec: Recorder): ApiClient {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const real = createApiClient("http://api.test", () => "token");
  return {
    async listUploads() {
      return [];
    },
    async createUpload() {
      return { upload_id: "u1" };
    },
    async uploadPartWithProgress(uploadId: string, part: File, onProgress?: (l: number, t: number) => void) {
      onProgress?.(part.size, part.size);
      return { upload_id: uploadId, state: "open", received_parts: 1, bytes_received: part.size, ignored: [] };
    },
    async finalizeUpload(uploadId: string) {
      // The fresh upload persisted its resume anchor before any part moved; whether the
      // create path clears it is only meaningful if it was there to clear.
      rec.sessionSavedAtFinalize = localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) !== null;
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string) {
      return { upload_id: uploadId, state: "finalized", received_parts: 1, bytes_received: 1, ignored: [] };
    },
    async createDataset(req: Parameters<ApiClient["createDataset"]>[0]) {
      rec.creates += 1;
      return real.createDataset(req);
    },
    async getJob(jobId: string) {
      rec.polled.push(jobId);
      return { job_id: jobId, state: "finished", dataset_id: FIRST_ID, log_tail: [], error: null };
    },
  } as unknown as ApiClient;
}

function newRecorder(): Recorder {
  return { creates: 0, polled: [], sessionSavedAtFinalize: false, done: 0 };
}

function submitOneImage(client: ApiClient, rec: Recorder): void {
  const { container } = render(
    h(CreateDatasetWizard, { client, onDone: () => { rec.done += 1; }, onAuthExpired() {} }),
  );
  fireEvent.change(imagesInput(container), {
    target: { files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
}

function errorsShown(): number {
  return document.querySelectorAll("p.error-text").length;
}

function onProgressView(): boolean {
  return screen.queryAllByRole("button", { name: "Back to Library" }).length > 0;
}

/** Wait until `settled()` holds or 5 s pass, and answer whether it held. A boolean poll
 *  rather than a `findBy*` query: a query that times out formats the whole rendered tree
 *  into its error, and these specs assert on counts and booleans only. */
async function settles(settled: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (!settled() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  return settled();
}

test("a create answered with upload_already_created ADOPTS the named collection: no error, its job polled, the session cleared", async () => {
  const rec = newRecorder();
  const client = clientAnswering(
    409,
    {
      detail: {
        code: "upload_already_created",
        message:
          "This upload already backs one of your collections. Delete that collection to build a new one from it, or create with an explicit dataset_id.",
        dataset_id: FIRST_ID,
        job_id: FIRST_JOB,
      },
    },
    rec,
  );
  submitOneImage(client, rec);

  assert.equal(await settles(() => onProgressView() || errorsShown() > 0), true, "the run came to rest");

  assert.equal(onProgressView(), true, "the wizard carried on to the job's progress view");
  assert.equal(rec.creates, 1, "one create was sent");
  assert.equal(errorsShown(), 0, "no error is shown for an adopted collection");
  assert.equal(rec.polled.length >= 1, true, "a job was polled");
  assert.equal(rec.polled.every((id) => id === FIRST_JOB), true, "the job polled is the one the 409 named");
  assert.equal(rec.sessionSavedAtFinalize, true, "precondition: a resume anchor existed to clear");
  assert.equal(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) === null, true, "the upload session is cleared");
});

test("an adopted collection with NO job says nothing new was created, polls nothing, and offers the Library", async () => {
  // The API names the job only while it is queued or started; a finished, failed or
  // expired one comes back null (review of PR #373, operator finding 2). Polling it would
  // 404 or re-report an old failure, and landing on the Library silently told the user
  // nothing about where their upload went.
  const rec = newRecorder();
  const client = clientAnswering(
    409,
    { detail: { code: "upload_already_created", message: "m", dataset_id: FIRST_ID, job_id: null } },
    rec,
  );
  submitOneImage(client, rec);

  const noticeShown = () => screen.queryAllByText(ADOPTED_WITHOUT_JOB_NOTICE).length > 0;
  assert.equal(await settles(() => noticeShown() || rec.done > 0 || errorsShown() > 0), true, "the run came to rest");
  assert.equal(noticeShown(), true, "the user is told nothing new was created, and where it is");
  assert.equal(rec.polled.length, 0, "nothing was polled");
  assert.equal(errorsShown(), 0, "no error is shown");
  assert.equal(rec.done, 0, "the wizard waits for the user rather than leaving silently");
  assert.equal(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) === null, true, "the upload session is cleared");

  // `onDone` is how the wizard hands back to the Library.
  fireEvent.click(screen.getByRole("button", { name: "Back to Library" }));
  assert.equal(rec.done, 1, "Back to Library leaves the wizard");
});

for (const [name, body] of [
  ["a string-detail 409", { detail: "A dataset with this id already exists." }],
  [
    "a structured 409 with a different code",
    { detail: { code: "something_else", message: "Something else went wrong.", dataset_id: FIRST_ID, job_id: FIRST_JOB } },
  ],
] as const) {
  test(`${name} still shows the error, polls nothing and keeps the session`, async () => {
    const rec = newRecorder();
    const client = clientAnswering(409, body, rec);
    submitOneImage(client, rec);

    assert.equal(await settles(() => onProgressView() || errorsShown() > 0), true, "the run came to rest");

    assert.equal(rec.creates, 1, "one create was sent");
    assert.equal(errorsShown(), 1, "the error is shown");
    assert.equal(rec.polled.length, 0, "no job was polled");
    assert.equal(onProgressView(), false, "not on the progress view");
    assert.equal(localStorage.getItem(UPLOAD_SESSION_STORAGE_KEY) !== null, true, "the session survives for a retry");
  });
}
