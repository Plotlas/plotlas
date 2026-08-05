// T2-66 / T2-48 (v2.2): the position table is fetched via client.fetchPositions,
// which mirrors fetchTags — concurrent callers of the same version-stamped URL share
// ONE in-flight fetch (one network round-trip), the resolved Table is reused, a
// different (layout/version) URL re-fetches AND releases the prior entry (the #99
// one-entry-bound lesson — never retain a table per layout/dataset ever opened), a
// rejected fetch is evicted so a retry re-issues, and a signalled fetch bypasses the
// cache (abort isolation). Same coordination as the tag sidecar because both are
// cookie-gated static-edge Arrow assets.
//
// GL-free, dependency-free beyond apache-arrow (to frame a valid Arrow IPC body).
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Float32, vectorFromArray, tableToIPC } from "apache-arrow";

import { createApiClient } from "../src/api-client/client.ts";

/** A tiny (x,y,w,h) float32 position table serialized to Arrow IPC — the on-disk
 *  wire shape fetchPositions decodes (row index == dense cell id, no id column). */
function positionsIpc(): Uint8Array {
  const f32 = (a: number[]) => vectorFromArray(a, new Float32());
  return tableToIPC(
    new Table({
      x: f32([0.1, 0.2]),
      y: f32([0.3, 0.4]),
      w: f32([0.1, 0.1]),
      h: f32([0.1, 0.1]),
    }),
    "stream",
  );
}

/** A promise plus its resolver, so the test can release a gated fetch response. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const IPC = positionsIpc();
const GRID_V1 = "http://edge/datasets/ds/positions/grid_v1.arrow";

test("two concurrent consumers trigger exactly one position-table fetch", async (t) => {
  let calls = 0;
  const gate = deferred<void>();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), GRID_V1);
    calls += 1;
    await gate.promise; // hold the response open so both callers are in flight
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  const a = client.fetchPositions(GRID_V1);
  const b = client.fetchPositions(GRID_V1);
  assert.equal(calls, 1, "the second concurrent call must reuse the in-flight fetch");

  gate.resolve();
  const [ta, tb] = await Promise.all([a, b]);
  assert.equal(calls, 1, "still exactly one network fetch after both resolve");
  assert.equal(ta.numRows, 2);
  assert.equal(tb.numRows, 2);

  await client.fetchPositions(GRID_V1); // cached — no third fetch
  assert.equal(calls, 1, "a repeat un-signalled fetch of the same url is cached");
});

test("the cache is bounded to one url — switching layout and back re-fetches (#99)", async (t) => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const A = "http://edge/datasets/ds/positions/grid_v1.arrow";
  const B = "http://edge/datasets/ds/positions/datetime_v1.arrow";
  const client = createApiClient("http://edge", () => "tok");

  await client.fetchPositions(A); // A fetched + cached
  await client.fetchPositions(B); // switching to B releases A's entry (holds one)
  await client.fetchPositions(A); // A is NOT cached anymore → re-fetched

  assert.deepEqual(urls, [A, B, A], "the old entry was released, not retained per layout");
});

test("a failed position fetch is not cached — a retry issues a fresh request", async (t) => {
  let calls = 0;
  let fail = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (fail) return new Response(JSON.stringify({ detail: "positions 500" }), { status: 500 });
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  await assert.rejects(client.fetchPositions(GRID_V1), /positions 500/);
  assert.equal(calls, 1);

  fail = false;
  const table = await client.fetchPositions(GRID_V1);
  assert.equal(calls, 2, "a failed fetch is not cached; the retry re-fetches");
  assert.equal(table.numRows, 2);
});

test("a signalled fetch bypasses the shared cache (abort isolation)", async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (init?.signal?.aborted === true) {
      const err = new Error("aborted");
      (err as { name: string }).name = "AbortError";
      throw err;
    }
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  await client.fetchPositions(GRID_V1); // un-signalled populates the cache
  assert.equal(calls, 1);
  const ctrl = new AbortController();
  await client.fetchPositions(GRID_V1, ctrl.signal); // signalled bypasses the cache
  assert.equal(calls, 2, "the signalled path bypasses the cache");
  await client.fetchPositions(GRID_V1);
  assert.equal(calls, 2, "the un-signalled cache entry survives a signalled fetch");
});
