// DOM tier (Seam O4): the wizard's selection + pre-flight + resume-offer wiring. Selecting
// files shows the deduped count; an over-cap file is refused before upload; and the Resume
// affordance appears ONLY when the re-selection's name+size fingerprint matches a persisted
// interrupted session (else a fresh upload is offered). Runs under jsdom via test:dom.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import { CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";
import { fingerprintFiles } from "../../src/ui/admin/uploadSelection.ts";
import { UPLOAD_SESSION_STORAGE_KEY } from "../../src/ui/admin/uploadSession.ts";

// The wizard only touches listUploads on an actual resume click; a stub is enough here.
function stubClient(): ApiClient {
  return { async listUploads() { return []; } } as unknown as ApiClient;
}

function clearStorage(): void {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
}
beforeEach(clearStorage);
afterEach(() => {
  cleanup();
  clearStorage();
});

function imagesInput(container: HTMLElement): Element {
  const el = container.querySelector('input[type="file"][accept="image/*,.zip"]');
  if (el === null) throw new Error("expected the images file input");
  return el;
}

test("selecting image files shows the deduped selection count", () => {
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const b = new File([new Uint8Array([2, 2])], "b.png", { type: "image/png" });
  fireEvent.change(imagesInput(container), { target: { files: [a, b] } });
  assert.ok(screen.getByText("2 file(s) selected"));
});

test("an over-cap file is refused by the client pre-flight (never reaches upload)", () => {
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));
  fireEvent.change(screen.getByPlaceholderText("my_dataset"), { target: { value: "ds" } });
  const big = new File([new Uint8Array([1])], "huge.png", { type: "image/png" });
  Object.defineProperty(big, "size", { value: 200 * 1024 * 1024 }); // 200 MiB > 100 MiB part cap
  fireEvent.change(imagesInput(container), { target: { files: [big] } });
  // The caps error renders inline as soon as a breaching selection exists.
  assert.ok(screen.getAllByText(/per-file limit/).length >= 1);
  // Clicking upload keeps us on the form (the stub client has no createUpload — a real
  // upload attempt would throw; the pre-flight stops it first).
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
  assert.ok(screen.getByRole("button", { name: "Upload & create" }), "still on the form");
  assert.ok(screen.getAllByText(/per-file limit/).length >= 1);
});

test("Resume is offered only when the re-selection fingerprint matches the persisted session", () => {
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  // Seed a persisted interrupted session whose fingerprint matches selecting exactly [a].
  localStorage.setItem(
    UPLOAD_SESSION_STORAGE_KEY,
    JSON.stringify({ uploadId: "u9", datasetId: "old_ds", fingerprint: fingerprintFiles([a]) }),
  );
  const { container } = render(h(CreateDatasetWizard, { client: stubClient(), onDone() {}, onAuthExpired() {} }));

  // The banner shows; before re-selecting, the primary action is still a fresh upload.
  assert.ok(screen.getByText(/Interrupted upload to "old_ds"/));
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
