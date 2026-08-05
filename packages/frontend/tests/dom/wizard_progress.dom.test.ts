// DOM tier (T2-93 Seam 1) — the bug-#3 REGRESSION GUARD for the ingest-wizard
// progress freeze fixed in PR #133. Runs under jsdom via
//   node --import global-jsdom/register --test --experimental-strip-types
// (see the `test:dom` script). The wizard is a `createElement` .ts component, so
// react-dom + @testing-library/react drive it with no bundler/JSX transform.
//
// ── Why this is a real guard (and NOT the worthless "terminal on the first
//    poll" shape the memo sketched) ─────────────────────────────────────────
// The #133 bug: CreateDatasetWizard's unmount guard used a `useRef(false)` whose
// cleanup set `cancelledRef.current = true`. React 18 StrictMode runs a mount
// effect setup→cleanup→setup in dev, so the cleanup left the ref stuck `true`
// for the whole session — `pollJob`'s `isCancelled()` was true from the first
// tick. The fix (jobPoll.createUnmountGuard) RE-ARMS on every effect setup.
//
// Two conditions are load-bearing for the reproduction, verified against source:
//  1. StrictMode — a plain render never runs the double-invoke, so the stuck-ref
//     never happens and the test would pass even against the buggy code.
//  2. The job must be NON-TERMINAL on the first poll, then terminal. `pollJob`
//     (jobPoll.ts) checks `TERMINAL_JOB_STATES.has(state) || isCancelled()` —
//     the terminal check is FIRST and short-circuits. A `getJob` that returns
//     "finished" immediately would therefore return "done" even with the ref
//     stuck cancelled, so a strictly terminal-first job is a worthless guard
//     (it passes pre- AND post-fix). This mock returns "started" (Processing…)
//     first, then "finished" — the exact "just-enqueued job that finishes a beat
//     later" case the guard docstring describes (a fast bake done in seconds).
//
// Behaviour: pre-#133 the stuck ref makes pollJob give up after the first
// "started" poll → the screen freezes on "Processing…" and this test FAILS.
// Post-#133 the re-armed guard lets polling continue to "finished" → the "done"
// DOM appears and this test PASSES. (Confirmed by temporarily reverting the
// wizard to the ref-based guard during development — it fails there.)
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type {
  CreateDatasetResponse,
  JobStatus,
  UploadHandle,
  UploadStatus,
} from "../../src/api-client/types.ts";
import { CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";

// A fresh jsdom localStorage per file, but be explicit: the wizard reads a persisted
// upload session at mount (Seam O4) — clear it so this test never sees a resume offer.
afterEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    // no storage — nothing to clear
  }
});

/** A mock ApiClient exposing only the methods the create→poll path calls. The
 *  first getJob answers non-terminal ("started"), every later one "finished". Seam O4:
 *  the wizard uploads via uploadPartWithProgress (XHR) and reads the finalized tally via
 *  getUploadStatus; listUploads is only touched on resume (returns [] here for safety). */
function pollingClient(): { client: ApiClient; jobPolls: () => number } {
  let jobPolls = 0;
  const client = {
    async createUpload(): Promise<UploadHandle> {
      return { upload_id: "u1" };
    },
    async listUploads(): Promise<[]> {
      return [];
    },
    async uploadPartWithProgress(
      uploadId: string,
      _part: File,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<UploadStatus> {
      onProgress?.(16, 16); // a single progress tick to the full size
      return { upload_id: uploadId, state: "open", received_parts: 1, bytes_received: 16, ignored: [] };
    },
    async finalizeUpload(uploadId: string): Promise<UploadHandle> {
      return { upload_id: uploadId };
    },
    async getUploadStatus(uploadId: string): Promise<UploadStatus> {
      // received_parts feeds the wizard's image-count readout (PR #133).
      return { upload_id: uploadId, state: "finalized", received_parts: 1, bytes_received: 16, ignored: [] };
    },
    async createDataset(): Promise<CreateDatasetResponse> {
      return { dataset_id: "ds", job_id: "j1" };
    },
    async getJob(jobId: string): Promise<JobStatus> {
      jobPolls += 1;
      const state = jobPolls === 1 ? "started" : "finished";
      return { job_id: jobId, state, dataset_id: "ds", log_tail: [`ingest: ${state}`], error: null };
    },
  } as unknown as ApiClient;
  return { client, jobPolls: () => jobPolls };
}

test("wizard reaches the done screen under StrictMode when the job finishes on a later poll", { timeout: 20_000 }, async () => {
  const { client, jobPolls } = pollingClient();
  const { container } = render(
    // ★ StrictMode is essential: it forces the mount effect double-invoke that
    // poisoned the old ref-based cancel guard (see the header).
    h(
      StrictMode,
      null,
      h(CreateDatasetWizard, { client, onDone: () => {}, onAuthExpired: () => {} }),
    ),
  );

  // Fill the source step: a valid dataset id + one image file (images-only is a
  // complete dataset — grid layout, no CSV/roles step).
  fireEvent.change(screen.getByPlaceholderText("my_dataset"), {
    target: { value: "my_dataset" },
  });
  // Target the Images input by its accept filter (image/*,.zip) rather than the
  // first file input by position — robust if the optional-CSV input is reordered.
  const imageInput = container.querySelector('input[type="file"][accept="image/*,.zip"]');
  if (imageInput === null) throw new Error("expected the Images file input to render");
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" });
  fireEvent.change(imageInput, { target: { files: [png] } });

  // Kick off create → upload → finalize → createDataset → poll.
  fireEvent.click(screen.getByRole("button", { name: "Upload & create" }));

  // The done DOM: the "finished" state label + the return affordance. The poll
  // reaches "finished" on the second getJob, one default (2 s) interval after
  // the first — hence the generous findBy timeout (real timers, no fake clock).
  await screen.findByText(/Finished — the dataset is ready\./, undefined, { timeout: 15_000 });
  await screen.findByRole("button", { name: "Back to Library" });

  // Regression pin at the poll-count level: pre-#133 the StrictMode-stuck ref made
  // pollJob give up after the FIRST (non-terminal) getJob — exactly one poll. Reaching
  // "finished" required a second poll, so assert polling continued past the first tick
  // (the precise failure mode, independent of how the done DOM is reached).
  assert.ok(
    jobPolls() >= 2,
    `expected polling to continue past the first non-terminal poll (pre-#133 the stuck ref gave up after 1); saw ${jobPolls()}`,
  );
});
