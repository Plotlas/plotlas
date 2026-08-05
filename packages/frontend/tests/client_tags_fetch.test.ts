// T2-43: the tag sidecar is fetched ONCE per (dataset, version). The two
// consumers race at dataset-open — the UI shell (TagControls) and the renderer's
// LayoutController both call client.fetchTags(client.tagsUrl(ds, ver)) with an
// identical version-stamped URL. The client memoizes per URL: concurrent callers
// share ONE in-flight promise (one network fetch), the resolved Table is reused,
// a different dataset/version URL re-fetches, and a rejected fetch is evicted so a
// retry issues a fresh call (failures are not cached). Signalled fetches (the
// superseded-generation cancellation path) bypass the cache — a caller's abort
// must never cancel another consumer's shared read.
//
// GL-free, dependency-free beyond apache-arrow (to frame a valid Arrow IPC body):
// a mocked globalThis.fetch counts calls and gates the first response so the
// second call provably lands while the first is still in flight.
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Field, List, Utf8, Int64, vectorFromArray, tableToIPC } from "apache-arrow";

import { createApiClient } from "../src/api-client/client.ts";

/** A tiny id + list<string> "tags" table serialized to Arrow IPC — the sidecar
 *  wire shape fetchTags decodes (tableFromIPC). */
function tagsIpc(): Uint8Array {
  const idVec = vectorFromArray([0n, 1n], new Int64());
  const listType = new List(new Field("item", new Utf8(), true));
  const tagVec = vectorFromArray([["a"], ["b"]], listType);
  return tableToIPC(new Table({ id: idVec, tags: tagVec }), "stream");
}

/** A promise plus its resolver, so the test can release a gated fetch response. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const IPC = tagsIpc();
const TAGS_V1 = "http://edge/datasets/ds/tags/tags_v1.arrow";

test("two concurrent consumers trigger exactly one tag-sidecar fetch", async (t) => {
  let calls = 0;
  const gate = deferred<void>();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(String(input), TAGS_V1);
    calls += 1;
    await gate.promise; // hold the response open so both callers are in flight
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");

  // Both consumers call before either has resolved — the renderer/UI race.
  const uiFetch = client.fetchTags(TAGS_V1);
  const rendererFetch = client.fetchTags(TAGS_V1);
  assert.equal(calls, 1, "the second concurrent call must reuse the in-flight fetch");

  gate.resolve(); // release the single response
  const [uiTable, rendererTable] = await Promise.all([uiFetch, rendererFetch]);

  assert.equal(calls, 1, "still exactly one network fetch after both resolve");
  assert.equal(uiTable.numRows, 2);
  assert.equal(rendererTable.numRows, 2);

  // A later call for the SAME url reuses the resolved value — no third fetch.
  await client.fetchTags(TAGS_V1);
  assert.equal(calls, 1, "a repeat un-signalled fetch of the same url is cached");
});

test("a different dataset/version URL re-fetches (natural cache invalidation)", async (t) => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  await client.fetchTags(TAGS_V1);
  await client.fetchTags(TAGS_V1); // cached — no second fetch
  assert.equal(urls.length, 1, "same url is served from cache");

  // A version bump (tags_v2) and a different dataset both key a fresh URL.
  await client.fetchTags("http://edge/datasets/ds/tags/tags_v2.arrow");
  await client.fetchTags("http://edge/datasets/ds2/tags/tags_v1.arrow");
  assert.equal(urls.length, 3, "a new version or dataset re-fetches");
});

test("the cache is bounded to one url — switching away and back re-fetches", async (t) => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const A = "http://edge/datasets/dsA/tags/tags_v1.arrow";
  const B = "http://edge/datasets/dsB/tags/tags_v1.arrow";
  const client = createApiClient("http://edge", () => "tok");

  await client.fetchTags(A); // A fetched + cached
  await client.fetchTags(B); // switching to B releases A's entry (cache holds one)
  await client.fetchTags(A); // A is NOT cached anymore → re-fetched

  // Three network calls for A,B,A — the old A entry was released, not retained.
  assert.deepEqual(urls, [A, B, A]);
});

test("a failed tag fetch is not cached — a retry issues a fresh request", async (t) => {
  let calls = 0;
  let fail = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    if (fail) return new Response(JSON.stringify({ detail: "sidecar 500" }), { status: 500 });
    return new Response(IPC, { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  await assert.rejects(client.fetchTags(TAGS_V1), /sidecar 500/);
  assert.equal(calls, 1);

  // The rejection was evicted, so the retry actually hits the network again.
  fail = false;
  const table = await client.fetchTags(TAGS_V1);
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
  // An un-signalled fetch populates the cache.
  await client.fetchTags(TAGS_V1);
  assert.equal(calls, 1);
  // A signalled fetch for the same url must NOT be served from (or poison) the
  // shared cache — it goes to the network on its own so one caller's abort can
  // never cancel another consumer's read.
  const ctrl = new AbortController();
  await client.fetchTags(TAGS_V1, ctrl.signal);
  assert.equal(calls, 2, "the signalled path bypasses the cache");
  // The prior un-signalled cache entry is intact (still no new fetch).
  await client.fetchTags(TAGS_V1);
  assert.equal(calls, 2, "the un-signalled cache entry survives a signalled fetch");
});
