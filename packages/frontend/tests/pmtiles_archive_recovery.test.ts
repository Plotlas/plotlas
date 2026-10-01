// A pyramid archive must SURVIVE an outage — R1-05 follow-up, found in a real browser.
//
// The operator stopped the API, switched layouts, waited for the recovery panel, restarted
// the API and pressed "Retry this view": nothing happened, and NOTHING appeared in the
// Network panel. The retry machinery was all working; the archive handle underneath it was
// dead, and stayed dead until a full page reload.
//
// Measured in node_modules/pmtiles/dist/index.js (v3.2.1, 2026-08-21):
//
//   SharedPromiseCache.getHeader(source) {
//     const cacheKey = source.getKey();                    // === our archive URL
//     const cacheValue = this.cache.get(cacheKey);
//     if (cacheValue) { ...; return yield cacheValue.data; }   // re-awaits a REJECTION
//     const p = new Promise((resolve, reject) => {
//       getHeaderAndRoot(source, this.decompress).then(...).catch((e) => { reject(e); });
//     });
//     this.cache.set(cacheKey, { lastUsed: ..., data: p });     // stored EVEN IF IT REJECTS
//     return p;
//   }
//
// There is no delete-on-rejection, and `prune()` only evicts once the cache reaches
// maxCacheEntries (we pass 1024, so a single dataset never gets there). Every
// `getZxyAttempt` begins `await this.cache.getHeader(this.source)`, so once one header read
// has failed, every later read re-throws that same rejection WITHOUT ISSUING A REQUEST.
// `getDirectory` caches rejections the same way.
//
// The api-client already made the opposite (correct) choice for its own memoised promises
// — "a rejection is evicted so a retry re-fetches; failures are not cached" (client.ts,
// positionFetches) — but this cache belongs to the library, so the only lever we own is to
// stop using a reader that has failed. These pins drive the REAL pmtiles reader against the
// REAL committed fixture bytes over a mocked Range-serving `fetch`, so they fail if the
// library ever changes its mind too.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openPyramidArchive } from "../src/renderer/pmtilesClient.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));
const PMTILES = join(FIXTURES_DIR, "golden_dataset_v2", "tiles", "grid", "grid_v1.pmtiles");
const URL_UNDER_TEST = "https://edge/pyramid/grid.pmtiles";

/** A Range-honouring `fetch` over the committed .pmtiles, with a `down` switch that makes
 *  every request 502 — the shape of `docker compose stop api` behind Caddy. Records every
 *  request's Range header, so a pin can assert whether the network was touched AT ALL. */
function installFetch(): { ranges: string[]; setDown: (d: boolean) => void; restore: () => void } {
  const file = readFileSync(PMTILES);
  const original = globalThis.fetch;
  const ranges: string[] = [];
  let down = false;
  globalThis.fetch = (async (_input: unknown, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const range = init?.headers?.Range ?? "";
    ranges.push(range);
    if (init?.signal?.aborted === true) {
      const err = new Error("aborted");
      (err as { name: string }).name = "AbortError";
      throw err;
    }
    if (down) return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (m === null) return new Response(file, { status: 200 });
    const start = Number(m[1]);
    const end = Number(m[2]); // inclusive
    const slice = file.subarray(start, end + 1);
    const body = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.byteLength}` } });
  }) as typeof fetch;
  return { ranges, setDown: (d: boolean) => { down = d; }, restore: () => { globalThis.fetch = original; } };
}

test("an archive whose first read failed recovers when the backend comes back", async () => {
  const net = installFetch();
  try {
    net.setDown(true);
    const archive = openPyramidArchive(URL_UNDER_TEST, () => ({}));

    // The outage: the very first read is the header read, and it 502s.
    await assert.rejects(() => archive.getTile(0, 0, 0), /502/, "the read did not fail while the API was down");
    const duringOutage = net.ranges.length;
    assert.ok(duringOutage > 0, "no request was even attempted — the fixture harness is wrong");

    // The backend comes back. This is `docker compose start api` followed by
    // "Retry this view", which re-streams the live view through THIS handle.
    net.setDown(false);
    const body = await archive.getTile(0, 0, 0);
    assert.equal(body !== null, true, "the archive stayed dead after the backend recovered");
    assert.ok(body!.byteLength > 0, "the recovered read returned an empty body");
    assert.ok(
      net.ranges.length > duringOutage,
      "the recovered read never touched the network — a rejected header promise is still cached",
    );
  } finally {
    net.restore();
  }
});

test("every read of a dead archive keeps hitting the network (the retry ladder is not a no-op)", async () => {
  // The T2-44 backoff ladder spends 1s + 2s + 4s re-reading a failed tile. Against a
  // poisoned reader those three retries are pure timer waiting with no request issued, so
  // a backend that recovers DURING the ladder is never noticed. Each attempt must be a
  // real attempt.
  const net = installFetch();
  try {
    net.setDown(true);
    const archive = openPyramidArchive(URL_UNDER_TEST, () => ({}));
    await assert.rejects(() => archive.getTile(0, 0, 0));
    const afterFirst = net.ranges.length;
    await assert.rejects(() => archive.getTile(0, 0, 0));
    assert.ok(net.ranges.length > afterFirst, "the second attempt issued no request at all");
  } finally {
    net.restore();
  }
});

test("an ABORTED read keeps the archive's warm directory cache", async () => {
  // The recovery must not fire on a supersede. Aborts are the common case — every pan
  // cancels a viewport of reads — and discarding the reader there would throw away the
  // whole directory cache (PMTILES_DIR_CACHE_ENTRIES = 1024) on every gesture, re-reading
  // the 16 KiB header + root directory each time. Measured in the library: the header
  // (`getHeaderAndRoot`: `source.getBytes(0, 16384)`) and the directories
  // (`getDirectory`: `source.getBytes(offset, length, void 0, header.etag)`) are fetched
  // with NO signal — only the tile body gets one — so an abort can never poison a cache
  // entry, and skipping the discard for it is safe as well as necessary.
  const net = installFetch();
  try {
    const archive = openPyramidArchive(URL_UNDER_TEST, () => ({}));
    await archive.getTile(0, 0, 0); // warms the header + root directory
    const headerReads = () => net.ranges.filter((r) => r === "bytes=0-16383").length;
    assert.equal(headerReads(), 1, "the header is read once on a cold archive");

    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => archive.getTile(0, 0, 0, ac.signal), (err: Error) => err.name === "AbortError");

    await archive.getTile(0, 0, 0);
    assert.equal(headerReads(), 1, "an abort threw away the warm archive — every pan now re-reads the header");
  } finally {
    net.restore();
  }
});
