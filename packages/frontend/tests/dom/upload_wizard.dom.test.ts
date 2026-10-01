// DOM tier (Seam O4): the wizard's selection + pre-flight + resume-offer wiring. Selecting
// files shows the deduped count; a selection over the cap this deployment ADVERTISES is
// refused before upload, while the same selection with no readable caps route is not
// (Seam A3: an over-per-REQUEST-cap file is chunked, not refused; Seam L1: the fallback
// carries no bundle-byte ceiling because the server's is free disk); and the Resume
// affordance appears ONLY when the re-selection's name+size fingerprint matches a persisted
// interrupted session (else a fresh upload is offered). Runs under jsdom via test:dom.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import { CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";
import { fingerprintFiles } from "../../src/ui/admin/uploadSelection.ts";
import { UPLOAD_SESSION_STORAGE_KEY } from "../../src/ui/admin/uploadSession.ts";
import { ActivityProvider } from "../../src/ui/activity/activityContext.ts";
import { ACTIVITY_STORAGE_KEY } from "../../src/ui/activity/activityStore.ts";
import { imagesInput, servingCaps, settleServedCaps, useWizardDomIsolation } from "./wizardDom.ts";

// The wizard only touches listUploads on an actual resume click; a stub is enough here.
// It carries NO getUploadCaps on purpose — that is what an unreachable caps route looks
// like, and the pre-flight then runs against the compiled-in fallback.
function stubClient(): ApiClient {
  return { async listUploads() { return []; } } as unknown as ApiClient;
}

// A deployment that advertises a 2 GiB MAX_UPLOAD_BUNDLE_BYTES. Seam L1 removed the
// fallback's byte ceiling (the server's bound is free disk, which no client can mirror),
// so a spec that needs a bundle-byte REFUSAL has to be handed one — there is no
// compiled-in ceiling left to breach.
const CAPPED_AT_2_GIB = {
  max_part_bytes: 104_857_600,
  max_bundle_bytes: 2 * 1024 * 1024 * 1024,
  max_entries: 1_000_000,
};

useWizardDomIsolation(beforeEach, afterEach);

test("selecting image files shows the deduped selection count", () => {
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const b = new File([new Uint8Array([2, 2])], "b.png", { type: "image/png" });
  fireEvent.change(imagesInput(container), { target: { files: [a, b] } });
  assert.ok(screen.getByText("2 file(s) selected"));
});

test("a selection over the ADVERTISED bundle cap is refused by the pre-flight (never reaches upload)", async () => {
  const client = servingCaps(stubClient(), CAPPED_AT_2_GIB);
  const { container } = render(h(CreateDatasetWizard, { client, onDone() {}, onAuthExpired() {} }));
  await settleServedCaps();
  const big = new File([new Uint8Array([1])], "huge.png", { type: "image/png" });
  // Over this deployment's 2 GiB whole-bundle cap. Seam A3 removed the per-FILE refusal
  // (the transport chunks such a file now), so the bundle ceiling is what the pre-flight
  // still stops.
  Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 * 1024 });
  fireEvent.change(imagesInput(container), { target: { files: [big] } });
  // The caps error renders inline as soon as a breaching selection exists.
  assert.ok(screen.getAllByText(/bundle limit/).length >= 1);
  // Clicking upload keeps us on the form (the stub client has no createUpload — a real
  // upload attempt would throw; the pre-flight stops it first).
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
  assert.ok(screen.getByRole("button", { name: "Upload & create" }), "still on the form");
  assert.ok(screen.getAllByText(/bundle limit/).length >= 1);
});

test("with NO readable caps route, a 3 GiB selection is not refused on bytes", () => {
  // The inverse of the spec above, and the seam L1 review's finding 6. This same
  // selection used to be refused here against a 2 GiB fallback that mirrored a server
  // constant seam L1 deleted — so the wizard was blocking, before the first byte, an
  // upload the server would have accepted onto a device with room for it. The fallback
  // must degrade: no ceiling is known, so nothing is refused, and the server answers.
  // No await needed — the pre-flight is a pure derivation, and the fallback IS the first
  // frame (a caps read that never resolves cannot make this assertion pass by accident).
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));
  const big = new File([new Uint8Array([1])], "huge.png", { type: "image/png" });
  Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 * 1024 });
  fireEvent.change(imagesInput(container), { target: { files: [big] } });
  assert.equal(screen.queryAllByText(/bundle limit/).length, 0, "no invented ceiling refused it");
  assert.equal(screen.getAllByText("1 file(s) selected").length, 1);
  assert.equal(screen.getAllByRole("button", { name: "Upload & create" }).length, 1, "submit is reachable");
});

test("a .zip over the per-REQUEST cap is NOT refused — the transport chunks it", async () => {
  // The seam's user-visible claim, and the operator's original complaint ("It requires
  // zip files smaller than 100mb").
  const client = servingCaps(stubClient(), CAPPED_AT_2_GIB);
  const { container } = render(h(CreateDatasetWizard, { client, onDone() {}, onAuthExpired() {} }));
  await settleServedCaps();
  const archive = new File([new Uint8Array([1])], "corpus.zip", { type: "application/zip" });
  // 3 GiB: 30x the 100 MiB per-request cap AND over the advertised 2 GiB bundle cap, so
  // BOTH assertions below are load-bearing. At 900 MiB the bundle-sum one was vacuous —
  // it passed whether or not archives were excluded from that sum. The caps are SERVED
  // for the same reason: against the fallback, which states no byte ceiling since seam
  // L1, the bundle-sum assertion would be vacuous again at any size.
  Object.defineProperty(archive, "size", { value: 3 * 1024 * 1024 * 1024 });
  fireEvent.change(imagesInput(container), { target: { files: [archive] } });
  assert.equal(screen.queryAllByText(/per-file limit/).length, 0, "no per-file refusal exists any more");
  assert.equal(screen.queryAllByText(/bundle limit/).length, 0, "a .zip is excluded from the bundle sum");
  assert.equal(screen.getAllByText("1 file(s) selected").length, 1);
  assert.equal(screen.getAllByRole("button", { name: "Upload & create" }).length, 1, "submit is reachable");
});

test("Resume is offered only when the re-selection fingerprint matches the persisted session", () => {
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  // Seed a persisted interrupted session whose fingerprint matches selecting exactly [a],
  // in the shape the wizard now writes (seam L3: keyed on the upload, no dataset id).
  localStorage.setItem(
    UPLOAD_SESSION_STORAGE_KEY,
    JSON.stringify({ uploadId: "u9", fingerprint: fingerprintFiles([a]), fileCount: 1, totalBytes: 1 }),
  );
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));

  // The banner shows, worded around WHAT was uploaded; before re-selecting, the primary
  // action is still a fresh upload.
  assert.ok(screen.getByText(/An interrupted upload \(1 file, 1 B\) was found/));
  assert.ok(screen.getByRole("button", { name: "Upload & create" }));

  // Re-select the SAME file → fingerprint matches → the primary becomes "Resume upload".
  fireEvent.change(imagesInput(container), { target: { files: [a] } });
  assert.ok(screen.getByRole("button", { name: "Resume upload" }));

  // Add a different file → the selection no longer matches → back to a fresh upload.
  const b = new File([new Uint8Array([9, 9, 9])], "b.png", { type: "image/png" });
  fireEvent.change(imagesInput(container), { target: { files: [b] } });
  assert.ok(screen.getByRole("button", { name: "Upload & create" }));
  assert.ok(screen.getByText(/selected files differ/));
});

// --- D-xxviii (seam L3 §2b.10): the intake does not ask for an id -----------------------

test("the source step has no collection-id field", () => {
  render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));
  assert.equal(screen.queryAllByPlaceholderText("my_dataset").length, 0);
  assert.equal(screen.queryAllByText(/Dataset id/i).length, 0);
  assert.equal(screen.queryAllByText(/Collection id/i).length, 0);
});

test("a record from before seam L3 (it carried the typed id) still offers resume, without the id", () => {
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  // Exactly what a browser persisted before this change: an id typed before the upload.
  localStorage.setItem(
    UPLOAD_SESSION_STORAGE_KEY,
    JSON.stringify({ uploadId: "u9", datasetId: "old_ds", fingerprint: fingerprintFiles([a]) }),
  );
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));
  assert.ok(screen.getByText(/An interrupted upload was found/));
  assert.equal(screen.queryAllByText(/old_ds/).length, 0, "the banner no longer names an id");
  fireEvent.change(imagesInput(container), { target: { files: [a] } });
  assert.ok(screen.getByRole("button", { name: "Resume upload" }));
});

test("a double click on Resume upload creates exactly ONE collection from the persisted upload", async () => {
  // Without a typed id the API mints a fresh id per call. Since PR #373 it refuses a second
  // minted create of the same upload with a 409 the wizard adopts
  // (create_adopts_collection.dom.test.ts), but that is the backstop for a create whose
  // answer was lost, not a licence to send two: the client must still issue exactly one.
  // The submit, Continue-anyway and Retry paths are pinned in
  // upload_wizard_honesty.dom.test.ts; this is the resume path.
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  localStorage.setItem(
    UPLOAD_SESSION_STORAGE_KEY,
    JSON.stringify({ uploadId: "u9", fingerprint: fingerprintFiles([a]), fileCount: 1, totalBytes: 1 }),
  );
  const created: Record<string, unknown>[] = [];
  const finalized: string[] = [];
  // Shaped as the server answers a resume whose every file already landed: the session is
  // still OPEN (never sealed) and /check reports the one part present.
  const client = {
    async listUploads() {
      return [{ upload_id: "u9", state: "open", received_parts: 1, bytes_received: 1, created: 0, last_activity: 0 }];
    },
    async checkUploadFiles() {
      return { present: ["a.png"], needed: [], mismatched: [] };
    },
    async finalizeUpload(uploadId: string) {
      finalized.push(uploadId);
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string) {
      return { upload_id: uploadId, state: "finalized", received_parts: 1, bytes_received: 1, ignored: [] };
    },
    async createDataset(body: Record<string, unknown>) {
      created.push(body);
      return { dataset_id: "3f9c2a71e0b4", job_id: `j${created.length}` };
    },
    async getJob(jobId: string) {
      return { job_id: jobId, state: "finished", dataset_id: "3f9c2a71e0b4", log_tail: [], error: null };
    },
  } as unknown as ApiClient;
  const { container } = render(h(CreateDatasetWizard, { client, onDone() {}, onAuthExpired() {} }));
  fireEvent.change(imagesInput(container), { target: { files: [a] } });
  const resume = screen.getByRole("button", { name: "Resume upload" });
  // Two dispatches in one act(): React has not re-rendered between them, so the button is
  // still mounted for the second — only the run slot can tell the clicks apart.
  await act(async () => {
    resume.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    resume.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await screen.findByRole("button", { name: "Back to Library" }, { timeout: 5000 });
  assert.deepEqual(finalized, ["u9"], "the persisted bundle is sealed once");
  assert.deepEqual(
    created.map((c) => c.upload_id),
    ["u9"],
    "createDataset fires once for one upload — the client sends one create per run",
  );
});

test("the intake creates with NO dataset_id and carries on with the id the API returned", async () => {
  // Shaped as seam L6's create answers a request without an id: a minted 12-hex id.
  const MINTED = "3f9c2a71e0b4";
  const created: Record<string, unknown>[] = [];
  const client = {
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
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string) {
      return { upload_id: uploadId, state: "finalized", received_parts: 1, bytes_received: 1, ignored: [] };
    },
    async createDataset(body: Record<string, unknown>) {
      created.push(body);
      return { dataset_id: MINTED, job_id: "j1" };
    },
    async getJob(jobId: string) {
      return { job_id: jobId, state: "finished", dataset_id: MINTED, log_tail: [], error: null };
    },
  } as unknown as ApiClient;
  const { container } = render(
    h(ActivityProvider, { client }, h(CreateDatasetWizard, { client, onDone() {}, onAuthExpired() {} })),
  );
  fireEvent.change(imagesInput(container), { target: { files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] } });
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
  await screen.findByRole("button", { name: "Back to Library" }, { timeout: 5000 });

  assert.equal(created.length, 1);
  assert.equal("dataset_id" in created[0], false, "the request carries no dataset_id");
  assert.equal(created[0].upload_id, "u1");
  // Everything after the create uses the RETURNED id: the job is tracked against it. The
  // provider persists its tracked set in an effect, so wait for the write rather than
  // racing it; a register that never happened (or under another id) still times out.
  await waitFor(() => {
    const tracked = JSON.parse(localStorage.getItem(ACTIVITY_STORAGE_KEY) ?? "[]") as { jobId: string; dsId: string }[];
    assert.deepEqual(tracked, [{ jobId: "j1", dsId: MINTED }]);
  });
});
