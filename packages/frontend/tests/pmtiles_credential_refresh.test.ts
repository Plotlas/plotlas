// T2-09 residual (D-i addendum): the renderer's PMTiles range reads hit the STATIC
// Caddy edge, gated by the 1-hour `viz_ds` cookie (decision D-A). On a stale tab
// (>1h on one dataset with no manifest re-open) that cookie expires and the range
// reads 401. The FetchRangeSource (pmtilesClient) intercepts a 401, performs a
// single-flight credential refresh (ONE manifest re-open re-issues the cookie via
// the api-client) and retries the read ONCE — so a returning user's tiles rebind
// with minimal requests instead of surfacing 401s.
//
// This exercises the range-read seam directly via createRangeSource().getBytes()
// (the retry lives there) wired to the REAL createApiClient over a mocked
// globalThis.fetch: a manifest GET is the cookie re-issue (the mock flips a
// `cookieFresh` flag + counts the GET), a range read 401s while the cookie is stale
// and 206s once fresh. Testing getBytes directly avoids standing up a valid PMTiles
// container just to reach the fetch seam through PMTiles.getZxy.
import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/api-client/client.ts";
import { FetchRangeSource, createRangeSource } from "../src/renderer/pmtilesClient.ts";
import { EtagMismatch } from "pmtiles";

const DS = "ds";
const LAYOUT = "grid";
const BASE = "http://edge";

/** A minimal valid v2 layout manifest (validateLayoutManifest must accept it — it
 *  is what a manifest re-open returns). */
function manifestJson(): unknown {
  return {
    manifest_version: "2.1",
    dataset_id: DS,
    dataset_version: 1,
    layouts: [
      {
        layout_id: LAYOUT,
        label: "Grid",
        type: "grid",
        bbox: [0, 0, 1, 1],
        pyramid: {
          container: "pmtiles",
          path: "tiles/grid/grid_v1.pmtiles",
          tile_px: 512,
          thumb_px: 64,
          cap: 64,
          levels: [{ z: 0, tile_count: 1 }],
          z_cap: 0,
        },
      },
    ],
    dataset_metadata: { image_count: 10, ingest_timestamp: "2026-01-01T00:00:00Z" },
  };
}

const PYRAMID_URL = `${BASE}/datasets/${DS}/tiles/grid/grid_v1.pmtiles`;
const MANIFEST_PATH = `/api/datasets/${DS}/layouts/${LAYOUT}`;
const RANGE_BYTES = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]); // an arbitrary 8-byte range slice

interface EdgeState {
  manifestGets: number; // proxy for "the server re-issued the viz_ds cookie"
  rangeReads: number;
  cookieFresh: boolean; // false = the stale-tab cookie has expired → 401
}

/** A mocked fetch modelling the gated static edge: a manifest GET always 200s and
 *  re-issues the cookie (sets cookieFresh + counts); a range read 206s only while
 *  the cookie is fresh, else 401s (and stays 401 — the client must refresh). The
 *  206 body is EXACTLY the requested [offset, offset+len) slice (offset 0 here). */
function installEdge(): { state: EdgeState; restore: () => void } {
  const state: EdgeState = { manifestGets: 0, rangeReads: 0, cookieFresh: false };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(MANIFEST_PATH)) {
      state.manifestGets += 1;
      state.cookieFresh = true; // the manifest open re-issued a fresh cookie
      return new Response(JSON.stringify(manifestJson()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === PYRAMID_URL) {
      state.rangeReads += 1;
      if (!state.cookieFresh) {
        return new Response(JSON.stringify({ detail: "No dataset credential" }), { status: 401 });
      }
      return new Response(RANGE_BYTES.slice(0, RANGE_BYTES.byteLength), {
        status: 206,
        headers: { "Content-Range": `bytes 0-${RANGE_BYTES.byteLength - 1}/${RANGE_BYTES.byteLength}` },
      });
    }
    return new Response(JSON.stringify({ detail: "no route" }), { status: 404 });
  }) as typeof fetch;
  return { state, restore: () => { globalThis.fetch = original; } };
}

/** Read the whole 8-byte range (offset 0) — the seam under test. */
function readRange(source: ReturnType<typeof createRangeSource>, signal?: AbortSignal): Promise<{ data: ArrayBuffer }> {
  return source.getBytes(0, RANGE_BYTES.byteLength, signal);
}

test("a 401 range read refreshes the credential ONCE and the retried read returns bytes (T2-09 residual)", async (t) => {
  const edge = installEdge();
  t.after(edge.restore);

  const client = createApiClient(BASE, () => "tok");
  // Prime the client: open the manifest once so refreshDatasetCredential knows the
  // dataset's layout to re-open. Then expire the cookie to model the stale tab.
  await client.getManifest(DS, LAYOUT);
  assert.equal(edge.state.manifestGets, 1, "priming opened the manifest once");
  edge.state.cookieFresh = false; // >1h later: the cookie expired on this tab

  const source = createRangeSource(PYRAMID_URL, () => client.authHeaders(), () =>
    client.refreshDatasetCredential(DS),
  );
  // The first fetch 401s (stale cookie); the Source refreshes (ONE manifest
  // re-open) and retries → 206 with the range bytes.
  const res = await readRange(source);

  assert.deepEqual(Array.from(new Uint8Array(res.data)), Array.from(RANGE_BYTES), "the retried read returned the range slice");
  assert.equal(edge.state.manifestGets, 2, "exactly ONE manifest re-fetch on the 401 (priming + refresh)");
  assert.equal(edge.state.rangeReads, 2, "the range read was retried exactly once (401 then 206)");
});

test("N concurrent 401 range reads COALESCE to a single credential refresh (T2-09 residual)", async (t) => {
  // The common case: a whole viewport of tiles expiring together. Every read 401s
  // at once; they must share ONE manifest re-open, not stampede N of them.
  const edge = installEdge();
  t.after(edge.restore);

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)
  edge.state.cookieFresh = false;

  // 8 sources (as many tiles), all reading concurrently: all 401, all await the
  // SAME refresh promise (coalesced by dataset in the client), all retry → 206.
  const sources = Array.from({ length: 8 }, () =>
    createRangeSource(PYRAMID_URL, () => client.authHeaders(), () => client.refreshDatasetCredential(DS)),
  );
  const results = await Promise.all(sources.map((s) => readRange(s)));

  assert.ok(
    results.every((r) => Array.from(new Uint8Array(r.data)).length === RANGE_BYTES.byteLength),
    "every read returned its range after the shared refresh",
  );
  assert.equal(
    edge.state.manifestGets,
    2,
    "the 8 concurrent 401s coalesced to ONE manifest re-open (priming=1 + one refresh)",
  );
});

test("a persistent 401 does NOT re-refresh after a fresh refresh (cooldown → normal failure) (T2-09 residual)", async (t) => {
  // The refresh re-issues the cookie, but a retried read STILL 401s (revoked access
  // / server trouble): the Source must NOT refresh again (cooldown), so the read
  // throws the normal pmtiles range error — exactly ONE refresh, no tight loop.
  const state = { manifestGets: 0, rangeReads: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(MANIFEST_PATH)) {
      state.manifestGets += 1;
      return new Response(JSON.stringify(manifestJson()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === PYRAMID_URL) {
      state.rangeReads += 1;
      return new Response(JSON.stringify({ detail: "still 401" }), { status: 401 }); // never recovers
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)

  const source = createRangeSource(PYRAMID_URL, () => client.authHeaders(), () =>
    client.refreshDatasetCredential(DS),
  );
  // 401 → refresh (manifestGets 2) → retry → still 401 → throw. No second refresh.
  await assert.rejects(readRange(source), /pyramid range fetch failed: 401/);
  assert.equal(state.manifestGets, 2, "exactly one refresh on the first 401 (priming + one refresh)");
  assert.equal(state.rangeReads, 2, "the read was retried once, then failed through (no loop)");

  // A SECOND read within the cooldown must NOT refresh again — the cooldown blocks
  // it, so it 401s once and throws with no manifest re-open.
  const source2 = createRangeSource(PYRAMID_URL, () => client.authHeaders(), () =>
    client.refreshDatasetCredential(DS),
  );
  await assert.rejects(readRange(source2), /pyramid range fetch failed: 401/);
  assert.equal(state.manifestGets, 2, "the cooldown blocked a second refresh (still 2 manifest GETs)");
  assert.equal(state.rangeReads, 3, "the second read 401'd once and failed through (no refresh, no retry)");
});

test("a refused refresh (no primed dataset) lets the 401 fail straight through (T2-09 residual)", async (t) => {
  // If refreshDatasetCredential resolves false (no manifest ever opened for the
  // dataset → nothing to re-open), the Source must NOT retry — the 401 surfaces.
  const edge = installEdge();
  t.after(edge.restore);

  const client = createApiClient(BASE, () => "tok");
  // NO priming: lastLayoutForDataset has no entry → refreshDatasetCredential → false.
  const source = createRangeSource(PYRAMID_URL, () => client.authHeaders(), () =>
    client.refreshDatasetCredential(DS),
  );
  await assert.rejects(readRange(source), /pyramid range fetch failed: 401/);
  assert.equal(edge.state.manifestGets, 0, "no manifest re-open when there is nothing primed to re-open");
  assert.equal(edge.state.rangeReads, 1, "the 401 failed straight through — no retry");
});

test("with NO refresh capability, a 401 fails straight through (unchanged prior behavior)", async (t) => {
  // Omitting the refresh capability (the pre-T2-09-residual wiring) leaves the 401
  // failing loudly, exactly as before — the capability is purely additive.
  const edge = installEdge();
  t.after(edge.restore);

  const source = createRangeSource(PYRAMID_URL, () => ({}) /* no refreshCredential */);
  await assert.rejects(readRange(source), /pyramid range fetch failed: 401/);
  assert.equal(edge.state.rangeReads, 1, "one read, no retry (no capability injected)");
  assert.equal(edge.state.manifestGets, 0, "no refresh without the capability");
});

test("an abort landing DURING the refresh skips the retry (supersede, not a failure)", async (t) => {
  // A pan/zoom/layout-switch can abort the read while its credential refresh is in
  // flight. The retry fetch must be skipped and an AbortError thrown (so the loader
  // treats it as a supersede, never a T2-44 backoff failure).
  const edge = installEdge();
  t.after(edge.restore);

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)
  edge.state.cookieFresh = false;

  const ctrl = new AbortController();
  // Refresh capability that aborts the read mid-refresh, then reports success.
  const source = createRangeSource(PYRAMID_URL, () => client.authHeaders(), async () => {
    ctrl.abort(); // the camera moved while we were refreshing
    await client.refreshDatasetCredential(DS);
    return true;
  });
  await assert.rejects(readRange(source, ctrl.signal), (err: unknown) => {
    assert.equal((err as { name?: string }).name, "AbortError", "an abort during refresh throws AbortError, not a range failure");
    return true;
  });
  // The retry fetch was skipped (only the initial 401 read happened).
  assert.equal(edge.state.rangeReads, 1, "the retry fetch was skipped after the mid-refresh abort");
});

// --- T2-199: no `If-Match`, and archive-change detection via the RESPONSE etag ---
//
// The header used to be sent on every range read. It bypassed the browser cache
// entirely (Fetch sets cache mode to `no-store` for any conditional request header)
// and 412'd every tile after a collection was copied between hosts, because Caddy's
// etag is mtime-derived and a copy changes it while the bytes stay identical.

test("getBytes sends NO If-Match (it would defeat the browser cache)", async () => {
  const seen: Record<string, string>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: { etag: '"server-etag"' },
    });
  }) as typeof fetch;
  try {
    const src = new FetchRangeSource("/p.pmtiles", () => ({}));
    // An etag IS passed in — the pmtiles client always supplies the one it holds.
    await src.getBytes(0, 3, undefined, '"server-etag"');
    assert.equal(seen.length, 1);
    assert.equal("If-Match" in seen[0], false);
    // ...and no other conditional header sneaked in either; each one triggers the
    // same no-store cache bypass.
    for (const h of ["If-Range", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"]) {
      assert.equal(h in seen[0], false, `${h} must not be sent`);
    }
    assert.ok("Range" in seen[0]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a CHANGED response etag throws EtagMismatch so pmtiles re-reads its directories", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1]), { status: 206, headers: { etag: '"new"' } })) as typeof fetch;
  try {
    const src = new FetchRangeSource("/p.pmtiles", () => ({}));
    await assert.rejects(() => src.getBytes(0, 1, undefined, '"old"'), EtagMismatch);
  } finally {
    globalThis.fetch = original;
  }
});

test("a MATCHING etag returns the bytes normally", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([7]), { status: 206, headers: { etag: '"same"' } })) as typeof fetch;
  try {
    const src = new FetchRangeSource("/p.pmtiles", () => ({}));
    const r = await src.getBytes(0, 1, undefined, '"same"');
    assert.equal(new Uint8Array(r.data)[0], 7);
    assert.equal(r.etag, '"same"');
  } finally {
    globalThis.fetch = original;
  }
});

test("a server that omits ETag is NOT a mismatch", async () => {
  // Inventing a mismatch when one side has no etag would break every read against a
  // backend that does not emit one.
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([9]), { status: 206 })) as typeof fetch;
  try {
    const src = new FetchRangeSource("/p.pmtiles", () => ({}));
    const r = await src.getBytes(0, 1, undefined, '"held"');
    assert.equal(new Uint8Array(r.data)[0], 9);
    assert.equal(r.etag, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("a first read with NO expected etag just records the server's", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([4]), { status: 206, headers: { etag: '"first"' } })) as typeof fetch;
  try {
    const src = new FetchRangeSource("/p.pmtiles", () => ({}));
    const r = await src.getBytes(0, 1, undefined, undefined);
    assert.equal(r.etag, '"first"');
  } finally {
    globalThis.fetch = original;
  }
});
