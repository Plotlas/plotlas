// DOM tier (Seam A1 — intake honesty): the create-dataset wizard tells the truth about
// what it is doing. Four defects, four pins, plus one stylesheet-text pin for the fifth.
//
// These are BEHAVIOUR pins on purpose. Phase 3 of the intake redesign is going to take
// the wizard's step sequence apart, so nothing here asserts the order or the number of
// steps, or the 640px container width — only that the click is acknowledged, that the
// finalize window is narrated and keeps a control, that a second submit opens no second
// session, and that one file can be dropped without discarding the rest.
//
// What this tier can and cannot see: jsdom does NO layout, and no stylesheet is applied,
// so nothing here asserts a rendered pixel. The centring pin is therefore an assertion
// about the RULE in app.css, and says so.
//
// Setup is copied from upload_wizard.dom.test.ts / wizard_progress.dom.test.ts — same
// fake-ApiClient shape, same "target the Images input by its accept filter" idiom.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type {
  CreateDatasetResponse,
  JobStatus,
  UploadHandle,
  UploadStatus,
} from "../../src/api-client/types.ts";
import { CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";
import { UPLOAD_SESSION_STORAGE_KEY } from "../../src/ui/admin/uploadSession.ts";
// The caps the wizard pre-flights against. Imported rather than written as literals so
// the pin moves with them instead of silently drifting past. (Seam A2 owns this module;
// if it reshapes the caps, this fails loudly — as it did when seam L1 dropped the
// fallback's bundle-byte ceiling and the refusal below had to be served instead.)
import { DEFAULT_UPLOAD_CAPS, fingerprintFiles } from "../../src/ui/admin/uploadSelection.ts";
import { servingCaps, settleServedCaps } from "./wizardDom.ts";

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

function mount(client: ApiClient): HTMLElement {
  const { container } = render(
    h(CreateDatasetWizard, { client, onDone: () => {}, onAuthExpired: () => {} }),
  );
  return container;
}

/** The Images drop-zone input, by its accept filter rather than by position — robust if
 *  the optional-CSV input is reordered (which Phase 3 may well do). */
function imagesInput(container: HTMLElement): Element {
  const el = container.querySelector('input[type="file"][accept="image/*,.zip"]');
  if (el === null) throw new Error("expected the images file input");
  return el;
}

function sized(name: string, bytes: number, type: string): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, "size", { value: bytes });
  return file;
}
const png = (name: string, bytes: number): File => sized(name, bytes, "image/png");
const zip = (name: string, bytes: number): File => sized(name, bytes, "application/zip");

interface Recorder {
  client: ApiClient;
  createUploads: () => number;
  finalizeCalls: () => number;
  createCalls: () => number;
  /** How many times the transport was handed this basename, across every run. */
  attempts: (name: string) => number;
  sent: string[];
}

/** A fake client for the whole create path. `finalize` decides where the run parks:
 *  "hang" leaves `finalizeUpload` pending, which is exactly the finalize window this seam
 *  is about; "ok" carries on to createDataset + a single terminal job poll. `failPart`
 *  makes one basename fail terminally, which is what puts the run in failure review. */
function recordingClient(
  opts: { createUpload?: "hang" | "ok"; finalize?: "hang" | "ok"; failPart?: string } = {},
): Recorder {
  let createUploads = 0;
  let finalizeCalls = 0;
  let createCalls = 0;
  const attempts = new Map<string, number>();
  const sent: string[] = [];
  const client = {
    async createUpload(): Promise<UploadHandle> {
      createUploads += 1;
      if (opts.createUpload === "hang") return new Promise<UploadHandle>(() => {});
      return { upload_id: "u1" };
    },
    async listUploads(): Promise<[]> {
      return [];
    },
    async uploadPartWithProgress(
      uploadId: string,
      part: File,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<UploadStatus> {
      attempts.set(part.name, (attempts.get(part.name) ?? 0) + 1);
      if (part.name === opts.failPart) {
        // A 4xx is terminal to the transport — no retry, collected as a failure.
        throw Object.assign(new Error("rejected"), { status: 400, detail: "rejected" });
      }
      sent.push(part.name);
      onProgress?.(part.size, part.size);
      return {
        upload_id: uploadId,
        state: "open",
        received_parts: sent.length,
        bytes_received: 0,
        ignored: [],
      };
    },
    async finalizeUpload(uploadId: string): Promise<UploadHandle> {
      finalizeCalls += 1;
      if (opts.finalize === "hang") return new Promise<UploadHandle>(() => {});
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string): Promise<UploadStatus> {
      return {
        upload_id: uploadId,
        state: "finalized",
        received_parts: sent.length,
        bytes_received: 0,
        ignored: [],
      };
    },
    async createDataset(): Promise<CreateDatasetResponse> {
      createCalls += 1;
      return { dataset_id: "ds", job_id: "j1" };
    },
    async getJob(jobId: string): Promise<JobStatus> {
      return { job_id: jobId, state: "finished", dataset_id: "ds", log_tail: [], error: null };
    },
  } as unknown as ApiClient;
  return {
    client,
    createUploads: () => createUploads,
    finalizeCalls: () => finalizeCalls,
    createCalls: () => createCalls,
    attempts: (name) => attempts.get(name) ?? 0,
    sent,
  };
}

interface SessionRecorder {
  client: ApiClient;
  /** Resolve the nth still-pending `createUpload` with a given session id. */
  openSession: (n: number, uploadId: string) => void;
  sessionsRequested: () => number;
  sent: string[]; // "<upload_id>/<basename>"
  finalized: string[]; // upload_ids sealed
  created: string[]; // upload_ids handed to createDataset
}

/** A client whose `createUpload` is DEFERRED, and which records everything per session.
 *  That is what makes cancel-then-resubmit observable: the abandoned run's round trip can
 *  be resolved after the replacement run exists, which is the ordering that used to let a
 *  superseded run wake up inside the live run's lock. */
function deferredSessionClient(): SessionRecorder {
  const resolvers: ((handle: UploadHandle) => void)[] = [];
  const sent: string[] = [];
  const finalized: string[] = [];
  const created: string[] = [];
  const client = {
    createUpload(): Promise<UploadHandle> {
      return new Promise<UploadHandle>((resolve) => resolvers.push(resolve));
    },
    async listUploads(): Promise<[]> {
      return [];
    },
    async uploadPartWithProgress(
      uploadId: string,
      part: File,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<UploadStatus> {
      sent.push(`${uploadId}/${part.name}`);
      onProgress?.(part.size, part.size);
      return { upload_id: uploadId, state: "open", received_parts: 1, bytes_received: 0, ignored: [] };
    },
    async finalizeUpload(uploadId: string): Promise<UploadHandle> {
      finalized.push(uploadId);
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string): Promise<UploadStatus> {
      return { upload_id: uploadId, state: "finalized", received_parts: 1, bytes_received: 0, ignored: [] };
    },
    async createDataset(body: { upload_id: string }): Promise<CreateDatasetResponse> {
      created.push(body.upload_id);
      return { dataset_id: "ds", job_id: `j${created.length}` };
    },
    async getJob(jobId: string): Promise<JobStatus> {
      return { job_id: jobId, state: "finished", dataset_id: "ds", log_tail: [], error: null };
    },
  } as unknown as ApiClient;
  return {
    client,
    openSession: (n, uploadId) => resolvers[n]({ upload_id: uploadId }),
    sessionsRequested: () => resolvers.length,
    sent,
    finalized,
    created,
  };
}

/** Drain React's work + the promise chain without racing a `waitFor` against a bug that
 *  produces MORE work rather than less. A fixed number of flushes cannot pass vacuously
 *  here because the assertions require the live run to have completed. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await act(async () => {});
}

/** Fill the source step: a valid id plus some images. */
function fillSource(container: HTMLElement, files: File[]): void {
  fireEvent.change(imagesInput(container), { target: { files } });
}

// ---------------------------------------------------------------------------
// Defect 1 — the finalize window was invisible.
// ---------------------------------------------------------------------------
// `batch` is non-null from the transport's first emit onward and is never cleared, so
// rendering the note and the bar as alternatives on `batch !== null` made every note set
// after the first byte unreachable — and the Cancel affordance was gated on the note
// being null, so setting it removed the last control on screen. The three assertions are
// the three halves of that: the note IS rendered, the bar is STILL rendered, and
// something occupies the control slot.
test("the finalize window shows the note, keeps the bar, and states why there is no Cancel", async () => {
  const rec = recordingClient({ finalize: "hang" });
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16)]);
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));

  // Capture the live region NOW, while it only holds "Preparing upload…". The a11y
  // property being pinned is that the finalize narration arrives as a text change inside
  // a region that was already mounted — a `role="status"` inserted with its text already
  // present is commonly not announced, which is what the old separate sealed-note was.
  const region = container.querySelector('[role="status"].wizard-run-note');
  assert.equal(region !== null, true, "the narration live region is mounted for the phase");

  // Parked inside finalizeUpload: the bundle is being sealed and nothing is moving.
  await screen.findByText("Finalizing upload — the server is tallying every file it received.");

  assert.equal(
    container.querySelector('[role="status"].wizard-run-note') === region,
    true,
    "the narration must stay the SAME live-region node across the stage change",
  );
  assert.equal(
    (region?.textContent ?? "").includes("no longer be cancelled"),
    true,
    "and the no-Cancel reason must be narrated inside it, not inserted as a fresh region",
  );

  assert.equal(
    screen.queryAllByRole("progressbar", { name: "Upload progress" }).length,
    1,
    "the completed bar must stay on screen ALONGSIDE the note, not be replaced by it",
  );
  assert.equal(
    screen.queryAllByText(/no longer be cancelled/).length,
    1,
    "the control slot must say why there is no Cancel rather than going empty",
  );
  // The honest answer to "can this be cancelled?" here is no: the abort controller does
  // not reach finalizeUpload/createDataset (they take no signal) and finishUpload has no
  // aborted guard (T2-116 R1), so a Cancel would abort nothing and then be overruled by
  // the continuation it failed to stop.
  assert.equal(
    screen.queryAllByRole("button", { name: "Cancel" }).length,
    0,
    "a Cancel that cancels nothing must not be offered",
  );
});

// The same window reached the other way. `uploadResult` still holds the failures while
// "Continue anyway" finalizes, so the failure-review row — including a Retry that would
// re-enter the transport alongside the in-flight finalize — used to stay live throughout.
// A control that would restart the run is a worse answer than none, so the honest line
// takes the slot here too.
test("Continue anyway retires the failure-review actions once the bundle is being sealed", async () => {
  const rec = recordingClient({ finalize: "hang", failPart: "b.png" });
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16), png("b.png", 32)]);
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));

  await screen.findByRole("button", { name: "Continue anyway" });
  fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));

  await screen.findByText("Finalizing upload — the server is tallying every file it received.");
  assert.equal(
    screen.queryAllByRole("button", { name: /^Retry / }).length,
    0,
    "a Retry during finalize would run the transport alongside an in-flight finalizeUpload",
  );
  assert.equal(
    screen.queryAllByRole("button", { name: "Continue anyway" }).length,
    0,
    "and a second Continue anyway would finalize + createDataset twice",
  );
  assert.equal(
    screen.queryAllByText(/no longer be cancelled/).length,
    1,
    "the slot is not left empty — it says why there is nothing to press",
  );
});

// The resume path's fresh-session fallback: the notice and the stage must agree. Leaving
// the stage on `checking` put "…starting a fresh upload" and "Checking your previous
// upload…" on screen together for the whole createUpload round trip — two statements about
// the same run, one of them false, in a seam about narrating the run honestly.
test("the expired-session fallback narrates the fresh upload, not the check it abandoned", async () => {
  const rec = recordingClient({ createUpload: "hang" });
  const a = png("a.png", 16);
  // A persisted session whose fingerprint matches selecting exactly [a], so Resume is the
  // offered action; listUploads then returns [] — the session is gone, so it falls back.
  localStorage.setItem(
    UPLOAD_SESSION_STORAGE_KEY,
    JSON.stringify({ uploadId: "gone", datasetId: "old_ds", fingerprint: fingerprintFiles([a]) }),
  );
  const container = mount(rec.client);
  fillSource(container, [a]);
  fireEvent.click(screen.getByRole("button", { name: "Resume upload" }));

  await screen.findByText(/starting a fresh upload/);
  assert.equal(
    screen.queryAllByText("Preparing upload…").length,
    1,
    "the stage must move with the notice",
  );
  assert.equal(
    screen.queryAllByText("Checking your previous upload…").length,
    0,
    "the abandoned check must not still be claimed on screen",
  );
});

// ---------------------------------------------------------------------------
// Defect 2a — the click was unacknowledged for a whole round trip.
// ---------------------------------------------------------------------------
test("the submit click transitions out of the form without waiting on the network", () => {
  const rec = recordingClient({ createUpload: "hang" });
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16)]);

  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));

  // createUpload has NOT answered and never will. The transition is driven by the click.
  assert.equal(
    screen.queryAllByRole("button", { name: "Upload & create" }).length,
    0,
    "the submit must be unreachable the moment it is clicked, not when the server answers",
  );
  assert.equal(
    screen.queryAllByText("Preparing upload…").length,
    1,
    "the click must be acknowledged on screen while the session is being opened",
  );
});

// ---------------------------------------------------------------------------
// Defect 2b — the submit path was re-entrant, so a double-click opened two sessions.
// ---------------------------------------------------------------------------
// Two dispatches, two ways. The fireEvent pair is the user-level behaviour (React flushes
// between them, so it also depends on the form being gone). The pair inside ONE act() is
// the isolated guard: React batches within the act scope, so the button is still mounted
// and connected for the second dispatch and only the run lock can stop the second entry.
test("a double submit opens exactly one upload session", async () => {
  const rec = recordingClient({ createUpload: "hang" });
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16)]);

  const button = screen.getByRole("button", { name: "Upload & create" });
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  fireEvent.click(button);

  assert.equal(
    rec.createUploads(),
    1,
    "a second entry mints a second upload_id and overwrites the resume anchor, orphaning the first session",
  );
});

// ---------------------------------------------------------------------------
// The run must be identified, not merely counted — and the slot must be released.
// ---------------------------------------------------------------------------
// Cancel-during-"Preparing…" is an affordance THIS seam introduced, and it creates an
// ordering the base could not reach: two runs whose continuations are both still
// scheduled. A boolean lock answers "is some run in flight?", so the abandoned run's
// round trip woke up inside the REPLACEMENT run's lock and ran to completion — two
// sessions uploaded, two sealed, createDataset twice with the same dataset_id.
//
// This pins both halves of the fix at once, which is deliberate: the second click is only
// possible because `returnToForm` releases the slot, and deleting that one line leaves
// every other test in this repo green while permanently killing the submit button.
test("cancel-then-resubmit runs exactly one upload, and the abandoned session never lands", async () => {
  const rec = deferredSessionClient();
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16)]);

  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
  assert.equal(rec.sessionsRequested(), 1, "run 1 asked for a session");

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
  assert.equal(
    rec.sessionsRequested(),
    2,
    "the form must be usable again after Cancel — the run slot is released by returnToForm",
  );

  // The abandoned round trip resolves FIRST. That is the whole point: it is the ordering
  // in which a truthiness check cannot tell "my run" from "a run".
  await act(async () => rec.openSession(0, "u1"));
  await act(async () => rec.openSession(1, "u2"));
  await drain();

  assert.deepEqual(rec.sent, ["u2/a.png"], "only the live run may upload");
  assert.deepEqual(rec.finalized, ["u2"], "only the live run may seal its bundle");
  assert.deepEqual(
    rec.created,
    ["u2"],
    "createDataset fires once, for the live session — twice is a 409 on a real server",
  );
});

// ---------------------------------------------------------------------------
// Defect 4 — a selection could only be cleared entirely, and was never shown.
// ---------------------------------------------------------------------------
// THE invariant of the bounded selection panel: when a cap error tells the user to make
// the selection smaller, the parts they would remove to do it are listed with a Remove
// row. A panel that cannot list them sends the user back to Clear selection — the exact
// defect this seam exists to close. It held only by argument before, and the argument was
// wrong: rows were archives-then-images, so archives could fill the budget and crowd out
// the biggest files entirely.
//
// Seam A3 changed WHICH error this is. The per-FILE refusal ("Remove or shrink it",
// naming one file) is gone — the transport chunks such a file now — so the remaining
// refusal is the whole-BUNDLE byte cap, which names no file at all. That makes the
// panel's size ordering the ONLY thing pointing at what to remove, and therefore load-
// bearing rather than a nicety: the parts worth removing are the largest ones.
//
// Seam L1 then changed where that refusal can COME from. The fallback caps no longer
// state a bundle-byte ceiling (the server bounds a bundle by free disk, which no client
// can mirror), so this spec has to be run against a deployment that advertises one —
// otherwise there is no refusal on screen and the invariant is asserted about nothing.
test("when the bundle cap refuses a selection, the biggest parts each have a Remove row", async () => {
  const budget = 2 * 1024 * 1024 * 1024; // this deployment's advertised MAX_UPLOAD_BUNDLE_BYTES
  const capped = (): ApiClient =>
    servingCaps(recordingClient().client, {
      max_part_bytes: DEFAULT_UPLOAD_CAPS.maxPartBytes,
      max_bundle_bytes: budget,
      max_entries: DEFAULT_UPLOAD_CAPS.maxEntries,
    });

  // Case 1 — enough archives to fill the row budget on their own, plus one image that
  // single-handedly breaches the bundle cap (archives are excluded from that sum, D-27,
  // so they cannot cause the refusal — only crowd out the row that explains it).
  const container = mount(capped());
  await settleServedCaps();
  const archives = Array.from({ length: 12 }, (_, i) => zip(`arc${i}.zip`, 1024));
  fillSource(container, [...archives, png("huge.png", budget * 2)]);

  assert.ok(
    screen.queryAllByText(/over the .* bundle limit/).length >= 1,
    "the pre-flight refuses this selection, so it is telling the user to remove something",
  );
  assert.equal(
    screen.queryAllByRole("button", { name: "Remove huge.png" }).length,
    1,
    "…and the part that would fix it must be removable without discarding everything else",
  );

  // Case 2 — several oversized parts of both kinds, buried among many ordinary ones.
  // Derived from the cap rather than from the implementation: anything big enough to
  // matter to the bundle total must be listed.
  cleanup();
  const second = mount(capped());
  await settleServedCaps();
  const offenders = [png("big1.png", budget * 2), zip("big2.zip", budget * 3), png("big3.png", budget * 4)];
  fillSource(second, [
    ...Array.from({ length: 30 }, (_, i) => png(`small${i}.png`, 1024 * (i + 1))),
    ...Array.from({ length: 11 }, (_, i) => zip(`spare${i}.zip`, 2048)),
    ...offenders,
  ]);
  for (const file of offenders) {
    assert.equal(
      screen.queryAllByRole("button", { name: `Remove ${file.name}` }).length,
      1,
      `${file.name} is one of the largest parts and must have a Remove row`,
    );
  }
});
// The CSV removal is load-bearing here rather than decorative: while a CSV is attached,
// `formProblem` runs `validateDraft` and the submit is refused until roles are mapped. So
// the upload at the end only happens if "Remove <csv>" actually took the file back out.
test("one image and the metadata file can be dropped without discarding the rest", async () => {
  const rec = recordingClient();
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16), png("b.png", 32), png("c.png", 48)]);

  assert.equal(
    screen.queryAllByText(/^Images and archives: 3 file\(s\) · /).length,
    1,
    "three parts selected",
  );

  const csv = new File(["filename,when\na.png,2020-01-01\n"], "meta.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Select a metadata CSV or TSV"), { target: { files: [csv] } });
  await screen.findByText("meta.csv selected");

  fireEvent.click(screen.getByRole("button", { name: "Remove meta.csv" }));
  assert.equal(screen.queryAllByText("meta.csv selected").length, 0, "the CSV is gone");

  fireEvent.click(screen.getByRole("button", { name: "Remove b.png" }));
  assert.equal(
    screen.queryAllByText(/^Images and archives: 2 file\(s\) · /).length,
    1,
    "removing one part must leave the other two, not clear the selection",
  );
  assert.equal(screen.queryAllByRole("button", { name: "Remove b.png" }).length, 0, "its row is gone");
  assert.equal(screen.queryAllByRole("button", { name: "Remove a.png" }).length, 1, "a.png survives");

  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));
  await waitFor(() => assert.equal(rec.sent.length, 2, "exactly the two survivors are sent"));
  assert.deepEqual([...rec.sent].sort(), ["a.png", "c.png"], "the removed file is never uploaded");
});

// A selection where NOTHING survives classification is still a selection the user made,
// and the screen has to say so. Gating the whole panel on `selectedCount > 0` made the
// Source step render nothing at all for a folder of camera/video files: every file
// ignored, no parts, therefore no "Ignored N non-image file(s)" and no way to clear them.
test("a selection of only non-image files still says so, and can still be cleared", () => {
  const container = mount(recordingClient().client);
  fillSource(container, [
    sized("clip.mp4", 4096, "video/mp4"),
    sized("shot.heic", 2048, "image/heic"),
    sized("raw.cr2", 8192, "image/x-canon-cr2"),
  ]);

  assert.equal(
    screen.queryAllByText(/Ignored 3 non-image file\(s\)/).length,
    1,
    "the Source step must say why the files it was given produced nothing",
  );
  assert.equal(
    screen.queryAllByRole("button", { name: "Clear selection" }).length,
    1,
    "…and must still offer a way out of the selection it is refusing",
  );
  // The rows and the byte summary stay behind `selectedCount > 0` — there is nothing to
  // list and nothing to total.
  assert.equal(
    screen.queryAllByText(/^Images and archives:/).length,
    0,
    "no parts, so no byte summary",
  );
});

// ---------------------------------------------------------------------------
// The failure-review actions must claim the run slot, not rely on the re-render.
// ---------------------------------------------------------------------------
// Same idiom as the submit-button pin: two dispatches inside one act() batch, so React has
// not re-rendered between them and the buttons are still mounted for the second. Reading
// `runTokenRef.current` without claiming it left re-entrancy prevented only by that
// re-render — which this ordering outruns. `retryFailed`'s `uploadResult` guard is weaker
// still: `setUploadResult(null)` cannot land synchronously.
test("a double click on Continue anyway finalizes and creates exactly once", async () => {
  const rec = recordingClient({ failPart: "b.png" });
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16), png("b.png", 32)]);
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));

  const button = await screen.findByRole("button", { name: "Continue anyway" });
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await drain();

  assert.equal(rec.finalizeCalls(), 1, "two clicks must seal the bundle once");
  assert.equal(
    rec.createCalls(),
    1,
    "and must not call createDataset twice with the same dataset_id — a 409 on a real server",
  );
});

test("a double click on Retry runs the transport once", async () => {
  const rec = recordingClient({ failPart: "b.png" });
  const container = mount(rec.client);
  fillSource(container, [png("a.png", 16), png("b.png", 32)]);
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));

  const button = await screen.findByRole("button", { name: "Retry 1 failed" });
  const before = rec.sent.length;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await drain();

  // b.png fails again, so nothing is added to `sent`; what must not happen is TWO
  // transports on one upload_id, where the second overwrites uploadAbortRef and orphans
  // the first controller. The retry attempt count is the observable.
  assert.equal(
    rec.attempts("b.png") - 1,
    1,
    "the retry must run one transport, not two concurrently on the same upload_id",
  );
  assert.equal(rec.sent.length, before, "nothing new succeeded — only the failing part was retried");
});

// ---------------------------------------------------------------------------
// Defect 3 — the wizard was a 640px column pinned to the left edge.
// ---------------------------------------------------------------------------
// jsdom applies no stylesheet and does no layout, so this CANNOT assert that the column
// renders centred; it asserts that the rule which centres it is declared. That is the
// whole of the defect (the property was simply absent, and `margin: 0 auto` appeared
// nowhere in the file either), and deleting it again fails here.
//
// It deliberately does NOT pin the 640px value: whether that cap is right at all is the
// intake design pass's question, and pinning it is exactly the "hardening something a
// follow-on seam must unpick" this seam was told to avoid.
const css = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every declaration block for `selector`, paired with its nesting depth. Depth 0 is
 *  top-level; anything deeper is inside an at-rule such as `@media`.
 *
 *  A flat `/([^{}]+)\{([^{}]*)\}/g` cannot see that distinction — it matches a rule inside
 *  an `@media` block as though it were top-level and silently drops the wrapper. `app.css`
 *  already has five `@media` blocks, so that parser had two failure modes on the very next
 *  `.wizard` change: adding a responsive override makes the count 2 and fails an assertion
 *  about the PARSER rather than the defect, and declaring `margin-inline: auto` ONLY inside
 *  a `@media (min-width: …)` would satisfy the old pin while leaving the column pinned left
 *  at every narrow width. Tracking depth costs a few lines and removes both. */
function blocksFor(selector: string): { body: string; depth: number }[] {
  const out: { body: string; depth: number }[] = [];
  let depth = 0;
  let head = "";
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      const name = head.trim();
      head = "";
      if (name === selector) {
        // A declaration block never nests, so scan to the matching close brace directly.
        const end = css.indexOf("}", i);
        out.push({ body: css.slice(i + 1, end < 0 ? css.length : end), depth });
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      head = "";
    } else {
      head += ch;
    }
  }
  return out;
}

test(".wizard declares an auto inline margin at top level, so the column is not pinned left", () => {
  const blocks = blocksFor(".wizard");
  assert.equal(blocks.length > 0, true, "app.css declares no .wizard rule at all");

  const centring = /margin-inline:\s*auto|margin:\s*0\s+auto/;
  const unconditional = blocks.filter((b) => b.depth === 0 && centring.test(b.body));
  assert.equal(
    unconditional.length,
    1,
    ".wizard is a flex item of .admin-screen; without an auto inline margin declared OUTSIDE any at-rule, the max-width caps the stretch and the column settles at flex-start — at least at the widths the at-rule does not cover",
  );
});

// F4's counterpart, at the only tier that can see it. `display: none` removes an element
// from the accessibility tree, so a rule that hides the narration region while it is empty
// un-mounts the live region for the whole transfer and the finalize note then arrives in a
// region that was just re-inserted — the exact pattern the region exists to avoid. jsdom
// applies no stylesheet, so the DOM pins cannot see this; the stylesheet can.
test("the narration live region is never hidden by a stylesheet rule", () => {
  for (const { body } of blocksFor(".wizard-run-note")) {
    assert.equal(
      /display:\s*none/.test(body),
      false,
      "`.wizard-run-note { display: none }` takes the live region out of the accessibility tree, so the stage change it exists to announce is not announced",
    );
  }
  assert.equal(
    blocksFor(".wizard-run-note:empty").length,
    0,
    "`:empty` is the sneaky form of the same bug — the region is empty for the whole transfer, so hiding it then means it REAPPEARS at `sealing` with its text already present",
  );
});
