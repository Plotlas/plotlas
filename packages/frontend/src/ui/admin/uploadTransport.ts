// Resilient upload transport (Seam O4). Pure orchestration, framework-free and
// node-test importable: given a "upload one part" function (the wizard binds
// client.uploadPartWithProgress), it runs a BOUNDED-PARALLEL batch with per-part
// jittered-backoff retry, aggregates byte progress into a live snapshot, treats a
// 200 `already_present` re-send as success, and ISOLATES terminal per-file failures
// (collect + keep going, report at the end) instead of killing the whole session.
//
// Also the resume PLANNER: given a persisted session id and the re-selected parts, it
// asks the server (/check) which basenames are already present vs needed vs mismatched,
// so only what the server lacks is sent — name+size only, NO client hashing (operator
// decision 2026-07-12). The check is chunked under the server's per-request cap.
//
// Node-test importable (type-only src imports for the shapes; one value import of the
// structural ApiError guard).
import { isApiError } from "../../api-client/client.ts";
import type { CheckFile, CheckResponse, UploadStatus } from "../../api-client/types";
import type { SelectionFile, SelectionPart } from "./uploadSelection.ts";

/** Parts in flight at once (Immich uses concurrency 2; ~4 balances a 6-connection
 *  HTTP/1.1 edge without starving other reads — spike §6.4). */
export const UPLOAD_CONCURRENCY = 4;

/** The repo's standard backoff base [1s, 2s, 4s] (spike §6.11), applied with jitter.
 *  Length also bounds the retry count: 1 initial attempt + up to 3 retries per part. */
export const UPLOAD_RETRY_BACKOFF_MS: readonly number[] = [1000, 2000, 4000];

/** Per-request cap on the /check batch (interface-catalogue: 10 000 files, then 413).
 *  A 250k-file bundle is checked in chunks of this size. */
export const UPLOAD_CHECK_BATCH = 10_000;

/** Coalesce byte-progress ticks to at most one snapshot per this window. A single large
 *  part fires hundreds of `progress` events, and ~4 run at once, so an un-throttled emit
 *  would re-render the wizard on every tick; 100 ms keeps the bar smooth (~10 fps) at a
 *  fraction of the renders. State transitions (a part settling / retrying / failing) are
 *  never throttled — only the intra-part byte ticks. */
export const UPLOAD_PROGRESS_THROTTLE_MS = 100;

/** A part's terminal outcome. `already-present` is the idempotent-resend success. */
export type PartStatus = "uploaded" | "already-present" | "failed";

export interface PartError {
  status: number | null; // HTTP status (null = network/transport failure)
  detail: string;
  /** Set for a 409 basename/size mismatch: point the user at resume/rename rather than
   *  aborting the whole run (spike §6.3). */
  guidance: string | null;
}

export interface PartOutcome {
  name: string;
  status: PartStatus;
  error: PartError | null;
}

/** A live snapshot of a running batch — the wizard renders bytes/percent + the few
 *  parts in flight + any retrying part from this. */
export interface BatchSnapshot {
  totalFiles: number;
  totalBytes: number;
  settledOk: number; // uploaded + already-present
  failed: number;
  loadedBytes: number; // settled-ok bytes + current in-flight partials
  inFlight: { name: string; loadedBytes: number; totalBytes: number }[];
  retrying: { name: string; attempt: number; waitMs: number }[];
}

export interface BatchResult {
  outcomes: PartOutcome[];
  failures: PartOutcome[]; // the subset with status === "failed" (the end-of-run report)
  ignored: string[]; // D-27 skip report aggregated across parts (ZIP nested CSVs / non-images)
  allOk: boolean;
}

export type UploadPartFn<T extends SelectionFile> = (
  part: SelectionPart<T>,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
) => Promise<UploadStatus>;

export interface RunBatchOptions {
  concurrency?: number;
  backoffMs?: readonly number[];
  onProgress?: (snapshot: BatchSnapshot) => void;
  /** Abort the whole run (unmount / cancel button): workers stop pulling and in-flight
   *  parts are aborted through the signal forwarded to `uploadOne`. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>; // injected for tests (no real timers)
  rng?: () => number; // jitter source; default Math.random
  /** Coalesce byte-progress emits to at most one per this many ms (default
   *  UPLOAD_PROGRESS_THROTTLE_MS). Transitions always emit; only intra-part ticks throttle. */
  progressThrottleMs?: number;
  now?: () => number; // clock for the progress throttle (injected for tests); default Date.now
}

/** A transport error is RETRIABLE when there was no answer (network/transport) or the
 *  server said 5xx; a 4xx (409 mismatch, 413 cap, 400 bad part, 401/403) is terminal —
 *  retrying cannot help. An abort is never retried. */
export function isRetriableUploadError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  if (isApiError(err)) return err.status === 0 || err.status >= 500;
  return true; // a non-ApiError reject is a transport blip (fetch/XHR error) → retry
}

/** Jittered exponential backoff over the [1s,2s,4s] base — EQUAL jitter (a `[0.5b, b]`
 *  window keeps a floor so retries don't stampede at 0 while still de-synchronizing a
 *  thundering herd, AWS's caution — spike §6.11). `attempt` is the 0-based retry index. */
export function jitteredBackoff(attempt: number, base: readonly number[], rng: () => number): number {
  const b = base[Math.min(attempt, base.length - 1)];
  return Math.round(b * (0.5 + 0.5 * rng()));
}

function classifyError(err: unknown): PartError {
  if (isApiError(err)) {
    const guidance =
      err.status === 409
        ? "A different file with this name is already in the session — rename it, or discard the session and start fresh."
        : null;
    return { status: err.status === 0 ? null : err.status, detail: err.detail, guidance };
  }
  const detail = err instanceof Error ? err.message : String(err);
  return { status: null, detail, guidance: null };
}

/**
 * Upload every part with bounded parallelism + per-part retry, aggregating progress.
 * Resolves once every part is settled (uploaded / already-present / failed) or the run is
 * aborted. A failed part NEVER aborts the run — its outcome is collected and reported.
 */
export async function runUploadBatch<T extends SelectionFile>(
  parts: readonly SelectionPart<T>[],
  uploadOne: UploadPartFn<T>,
  opts: RunBatchOptions = {},
): Promise<BatchResult> {
  const concurrency = Math.max(1, opts.concurrency ?? UPLOAD_CONCURRENCY);
  const backoff = opts.backoffMs ?? UPLOAD_RETRY_BACKOFF_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = opts.rng ?? Math.random;
  const throttleMs = opts.progressThrottleMs ?? UPLOAD_PROGRESS_THROTTLE_MS;
  const now = opts.now ?? ((): number => Date.now());
  const signal = opts.signal;
  // A fresh read each call — `signal.aborted` is a live getter, but TS narrows a bare
  // `signal?.aborted === true` to false across the intervening `await`; a function call
  // defeats that stale narrowing (and reads the current abort state honestly).
  const aborted = (): boolean => signal?.aborted === true;

  const totalBytes = parts.reduce((sum, p) => sum + p.size, 0);
  const outcomes: (PartOutcome | undefined)[] = new Array(parts.length).fill(undefined);
  const loaded: number[] = new Array(parts.length).fill(0); // in-flight partial per part
  const inFlight = new Set<number>();
  const retrying = new Map<number, { attempt: number; waitMs: number }>();
  const ignored: string[] = []; // D-27 skip report aggregated across parts
  let settledBytes = 0;
  let settledOk = 0;
  let failed = 0;
  let lastEmit = 0; // timestamp of the last emit — the progress-tick throttle floor

  function emit(): void {
    if (opts.onProgress === undefined) return;
    lastEmit = now();
    let live = settledBytes;
    for (const i of inFlight) live += loaded[i];
    opts.onProgress({
      totalFiles: parts.length,
      totalBytes,
      settledOk,
      failed,
      loadedBytes: live,
      inFlight: [...inFlight].map((i) => ({
        name: parts[i].name,
        loadedBytes: loaded[i],
        totalBytes: parts[i].size,
      })),
      retrying: [...retrying].map(([i, r]) => ({ name: parts[i].name, attempt: r.attempt, waitMs: r.waitMs })),
    });
  }

  /** A byte-progress tick: emit only if the throttle window has elapsed since the last
   *  emit (a large part fires hundreds of these). Transitions call emit() directly, so the
   *  settled/failed state is never dropped — this only thins the intra-part byte updates. */
  function emitProgress(): void {
    if (opts.onProgress === undefined) return;
    if (now() - lastEmit >= throttleMs) emit();
  }

  async function processOne(i: number): Promise<void> {
    const part = parts[i];
    let attempt = 0;
    for (;;) {
      if (aborted()) return;
      loaded[i] = 0;
      retrying.delete(i);
      inFlight.add(i);
      emit();
      try {
        const status = await uploadOne(part, (l) => {
          loaded[i] = l;
          emitProgress();
        }, signal);
        inFlight.delete(i);
        loaded[i] = part.size; // count the whole part even if progress didn't reach total
        settledBytes += part.size;
        settledOk += 1;
        for (const name of status.ignored ?? []) ignored.push(name); // D-27 skip report
        outcomes[i] = { name: part.name, status: status.already_present === true ? "already-present" : "uploaded", error: null };
        emit();
        return;
      } catch (err) {
        inFlight.delete(i);
        loaded[i] = 0;
        if (aborted()) return; // cancelled — don't record a failure
        if (attempt < backoff.length && isRetriableUploadError(err)) {
          const waitMs = jitteredBackoff(attempt, backoff, rng);
          retrying.set(i, { attempt: attempt + 1, waitMs });
          emit();
          await sleep(waitMs);
          attempt += 1;
          continue;
        }
        // Terminal: collect the failure and keep the session alive for the rest.
        failed += 1;
        outcomes[i] = { name: part.name, status: "failed", error: classifyError(err) };
        retrying.delete(i);
        emit();
        return;
      }
    }
  }

  // A shared cursor feeds `concurrency` workers — never more than N parts in flight.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (aborted()) return;
      const i = cursor;
      cursor += 1;
      if (i >= parts.length) return;
      await processOne(i);
    }
  }
  emit();
  await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, () => worker()));

  const settled = outcomes.filter((o): o is PartOutcome => o !== undefined);
  const failures = settled.filter((o) => o.status === "failed");
  return {
    outcomes: settled,
    failures,
    ignored,
    allOk: failures.length === 0 && settled.length === parts.length,
  };
}

// --- Resume planning --------------------------------------------------------

/** The one client method the planner needs (structural — a fake client satisfies it). */
export interface UploadCheckClient {
  checkUploadFiles(uploadId: string, files: CheckFile[]): Promise<CheckResponse>;
}

export interface ResumePlan<T extends SelectionFile> {
  present: string[]; // basenames the server already holds (name+size match) — skipped
  needed: SelectionPart<T>[]; // not present — send
  mismatched: SelectionPart<T>[]; // same name, different size — send only after user confirms
}

/**
 * Diff a re-selected bundle against what the server already holds (Immich-style
 * pre-check), so a resumed upload sends only what is missing. name+size only — NO
 * client hashing. The /check call is chunked under the server's per-request cap; the
 * tri-state (present / needed / mismatched) is merged and mapped back to the parts.
 */
export async function planResume<T extends SelectionFile>(
  client: UploadCheckClient,
  uploadId: string,
  parts: readonly SelectionPart<T>[],
  batchSize: number = UPLOAD_CHECK_BATCH,
): Promise<ResumePlan<T>> {
  const present: string[] = [];
  const neededNames = new Set<string>();
  const mismatchedNames = new Set<string>();

  for (let i = 0; i < parts.length; i += Math.max(1, batchSize)) {
    const chunk = parts.slice(i, i + Math.max(1, batchSize));
    const files: CheckFile[] = chunk.map((p) => ({ name: p.name, size: p.size }));
    const res = await client.checkUploadFiles(uploadId, files);
    for (const n of res.present) present.push(n);
    for (const n of res.needed) neededNames.add(n);
    for (const n of res.mismatched) mismatchedNames.add(n);
  }

  const needed: SelectionPart<T>[] = [];
  const mismatched: SelectionPart<T>[] = [];
  for (const part of parts) {
    if (mismatchedNames.has(part.name)) mismatched.push(part);
    else if (neededNames.has(part.name)) needed.push(part);
  }
  return { present, needed, mismatched };
}
