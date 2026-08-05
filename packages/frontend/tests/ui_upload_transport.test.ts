// Tier-1 (Seam O4): the resilient transport — bounded-parallel scheduling, jittered-backoff
// retry, already_present-as-success, per-file failure isolation, byte-progress aggregation,
// and the resume planner (/check diff, chunked, name+size only). No real timers (injected
// sleep) except one 1 ms yield in the concurrency test.
import assert from "node:assert/strict";
import test from "node:test";

import {
  UPLOAD_RETRY_BACKOFF_MS,
  isRetriableUploadError,
  jitteredBackoff,
  planResume,
  runUploadBatch,
} from "../src/ui/admin/uploadTransport.ts";

/** A selection part for the transport (the `file` is opaque to it). */
function part(name: string, size: number): { file: { name: string; size: number }; name: string; size: number; isZip: boolean } {
  return { file: { name, size }, name, size, isZip: false };
}
function okStatus(size: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { upload_id: "u", state: "open", received_parts: 1, bytes_received: size, ignored: [], ...extra };
}
/** A structural ApiError (isApiError checks status:number + detail:string). */
function apiError(status: number, detail = "err"): Error {
  return Object.assign(new Error(`API ${status}`), { status, detail });
}

test("aggregates byte progress across parts into the live snapshot", async () => {
  const snaps: { loadedBytes: number; totalBytes: number; settledOk: number }[] = [];
  const parts = [part("a.png", 100), part("b.png", 100)];
  const result = await runUploadBatch(
    parts,
    async (p, onProgress) => {
      onProgress(50, p.size);
      onProgress(100, p.size);
      return okStatus(p.size);
    },
    { concurrency: 1, onProgress: (s) => snaps.push(s) },
  );
  assert.equal(result.allOk, true);
  const last = snaps.at(-1);
  assert.equal(last?.totalBytes, 200);
  assert.equal(last?.loadedBytes, 200);
  assert.equal(last?.settledOk, 2);
  assert.ok(snaps.some((s) => s.loadedBytes > 0 && s.loadedBytes < 200), "saw a mid-run partial");
});

test("coalesces intra-part byte ticks within the throttle window; transitions always emit", async () => {
  // Injected clock so the throttle is deterministic (like the injected sleep/rng elsewhere).
  let clock = 1000;
  const now = (): number => clock;
  const loaded: number[] = [];
  await runUploadBatch(
    [part("a.png", 100)],
    async (p, onProgress) => {
      onProgress(25, p.size); // same window as the in-flight emit → coalesced away
      onProgress(50, p.size); // still within the window → coalesced away
      clock += 10; // advance past the throttle window
      onProgress(75, p.size); // window elapsed → this tick emits
      return okStatus(p.size);
    },
    { concurrency: 1, onProgress: (s) => loaded.push(s.loadedBytes), now, progressThrottleMs: 5 },
  );
  assert.equal(loaded.filter((b) => b === 25 || b === 50).length, 0, "within-window ticks are dropped");
  assert.ok(loaded.includes(75), "a tick after the window elapsed emits");
  assert.equal(loaded.at(-1), 100, "the settle transition always emits the full part");
});

test("retries a transient (network) failure with jittered backoff, then succeeds", async () => {
  const waits: number[] = [];
  let attempts = 0;
  const result = await runUploadBatch(
    [part("a.png", 10)],
    async () => {
      attempts += 1;
      if (attempts < 3) throw apiError(0, "network"); // status 0 = network → retriable
      return okStatus(10);
    },
    { concurrency: 1, sleep: async (ms) => void waits.push(ms), rng: () => 0.5 },
  );
  assert.equal(result.allOk, true);
  assert.equal(attempts, 3);
  // rng 0.5 → 0.75·base; the first two backoffs use base[0], base[1].
  assert.deepEqual(waits, [
    Math.round(UPLOAD_RETRY_BACKOFF_MS[0] * 0.75),
    Math.round(UPLOAD_RETRY_BACKOFF_MS[1] * 0.75),
  ]);
});

test("jitteredBackoff stays within [0.5·base, base] across the rng range", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    for (let a = 0; a < 5; a += 1) {
      const base = UPLOAD_RETRY_BACKOFF_MS[Math.min(a, UPLOAD_RETRY_BACKOFF_MS.length - 1)];
      const d = jitteredBackoff(a, UPLOAD_RETRY_BACKOFF_MS, () => r);
      assert.ok(d >= Math.round(0.5 * base) && d <= base, `a=${a} r=${r}: ${d} in [${0.5 * base}, ${base}]`);
    }
  }
});

test("a terminal (4xx) failure is NOT retried", async () => {
  let attempts = 0;
  const result = await runUploadBatch(
    [part("a.png", 10)],
    async () => {
      attempts += 1;
      throw apiError(413, "too big");
    },
    { concurrency: 1, sleep: async () => {} },
  );
  assert.equal(attempts, 1, "413 is terminal — one attempt");
  assert.equal(result.failures.length, 1);
});

test("a 200 already_present part counts as success (idempotent re-send)", async () => {
  const result = await runUploadBatch(
    [part("a.png", 10)],
    async () => okStatus(10, { already_present: true }),
    { concurrency: 1 },
  );
  assert.equal(result.allOk, true);
  assert.equal(result.outcomes[0].status, "already-present");
});

test("never exceeds the configured concurrency", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const parts = Array.from({ length: 10 }, (_, i) => part(`${i}.png`, 5));
  await runUploadBatch(
    parts,
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1)); // hold the slot briefly so workers overlap
      inFlight -= 1;
      return okStatus(5);
    },
    { concurrency: 3 },
  );
  assert.equal(maxInFlight, 3, "three workers, never a fourth in flight");
});

test("isolates a terminal per-file failure — the rest upload, the failure is reported with guidance", async () => {
  const parts = [part("ok1.png", 5), part("bad.png", 5), part("ok2.png", 5)];
  const result = await runUploadBatch(
    parts,
    async (p) => {
      if (p.name === "bad.png") throw apiError(409, "different file with this name");
      return okStatus(5);
    },
    { concurrency: 1 },
  );
  assert.equal(result.allOk, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].name, "bad.png");
  assert.equal(result.failures[0].error?.status, 409);
  assert.match(result.failures[0].error?.guidance ?? "", /rename/);
  assert.equal(result.outcomes.filter((o) => o.status === "uploaded").length, 2, "the other two still uploaded");
});

test("aggregates the D-27 ignored (skip) report across parts", async () => {
  const result = await runUploadBatch(
    [part("arch.zip", 5)],
    async () => okStatus(5, { ignored: ["notes.txt", "nested.csv"] }),
    { concurrency: 1 },
  );
  assert.deepEqual(result.ignored, ["notes.txt", "nested.csv"]);
});

test("isRetriableUploadError: network + 5xx retriable; 4xx + abort terminal", () => {
  assert.equal(isRetriableUploadError(apiError(0)), true);
  assert.equal(isRetriableUploadError(apiError(503)), true);
  assert.equal(isRetriableUploadError(apiError(409)), false);
  assert.equal(isRetriableUploadError(apiError(413)), false);
  assert.equal(isRetriableUploadError(new Error("socket hang up")), true); // non-ApiError blip
  assert.equal(isRetriableUploadError(Object.assign(new Error("x"), { name: "AbortError" })), false);
});

test("planResume sends only needed; maps needed/mismatched back to parts (name+size, no hash)", async () => {
  const parts = [part("have.png", 10), part("need.png", 20), part("changed.png", 30)];
  let sent: { name: string; size: number; sha256?: string | null }[] | null = null;
  const client = {
    async checkUploadFiles(_id: string, files: { name: string; size: number; sha256?: string | null }[]) {
      sent = files;
      return { present: ["have.png"], needed: ["need.png"], mismatched: ["changed.png"] };
    },
  };
  const plan = await planResume(client, "u1", parts);
  assert.deepEqual(plan.present, ["have.png"]);
  assert.deepEqual(plan.needed.map((p) => p.name), ["need.png"]);
  assert.deepEqual(plan.mismatched.map((p) => p.name), ["changed.png"]);
  assert.ok(sent !== null && sent.every((f) => f.sha256 === undefined), "no client hash sent (name+size only)");
  assert.deepEqual(sent?.map((f) => [f.name, f.size]), [["have.png", 10], ["need.png", 20], ["changed.png", 30]]);
});

test("planResume chunks the /check under the batch cap", async () => {
  const parts = Array.from({ length: 25 }, (_, i) => part(`${i}.png`, 1));
  const batches: number[] = [];
  const client = {
    async checkUploadFiles(_id: string, files: { name: string; size: number }[]) {
      batches.push(files.length);
      return { present: [], needed: files.map((f) => f.name), mismatched: [] };
    },
  };
  const plan = await planResume(client, "u1", parts, 10);
  assert.deepEqual(batches, [10, 10, 5]);
  assert.equal(plan.needed.length, 25);
});
