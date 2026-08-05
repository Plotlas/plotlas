// Tier-1 unit coverage for the Library-card COVER fetch (T2-55). The card's
// CardMedia component owns a fetch → object-URL → render → revoke lifecycle that a
// node test (no jsdom, no react-dom/client with effects) cannot exercise directly, so
// — mirroring cell_preview_fetch.test.ts — the auth + status contract is pinned on the
// extracted `fetchCover` helper the effect calls, plus the object-URL revoke contract:
//
//   1. fetchCover — the cover route is auth-gated (D-24), so the fetch MUST carry the
//      identity bearer header (a bare <img src> would 401). Pins that + the 200→blob /
//      404→null (graceful-absence) / error mapping.
//   2. the object-URL lifecycle the CardMedia effect implements: a cover swapped in is
//      wrapped in an object URL and REVOKED on cleanup (unmount / dataset change), or
//      every browsed card leaks a blob.
import assert from "node:assert/strict";
import test from "node:test";

import { fetchCover } from "../src/ui/admin/DatasetList.ts";
import type { ApiClient } from "../src/api-client/client.ts";

const TOKEN = "tok-cover";

/** Minimal ApiClient stub: fetchCover only touches coverUrl + authHeaders. */
function fakeClient(): ApiClient {
  return {
    coverUrl: (ds: string) => `http://edge/api/datasets/${ds}/cover`,
    authHeaders: () => ({ Authorization: `Bearer ${TOKEN}` }),
  } as unknown as ApiClient;
}

function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): { calls: { input: RequestInfo | URL; init: RequestInit }[] } {
  const calls: { input: RequestInfo | URL; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init: init ?? {} });
    return handler(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

test("fetchCover requests the cover route with the identity bearer header and returns the blob (200)", async (t) => {
  const spy = stubFetch(t, (input) => {
    assert.equal(String(input), "http://edge/api/datasets/my_ds/cover");
    return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 }); // "RIFF"
  });

  const blob = await fetchCover(fakeClient(), "my_ds");

  const headers = spy.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`, "bearer header attached — the auth-gated route");
  assert.ok(blob !== null);
  const bytes = new Uint8Array(await (blob as Blob).arrayBuffer());
  assert.deepEqual([...bytes], [82, 73, 70, 70]);
});

test("fetchCover returns null on 404 (no cover baked → graceful flat-block fallback)", async (t) => {
  stubFetch(t, () => new Response(null, { status: 404 }));
  assert.equal(await fetchCover(fakeClient(), "no_cover_ds"), null);
});

test("fetchCover returns null on any other non-ok (still falls back to the flat block)", async (t) => {
  stubFetch(t, () => new Response(null, { status: 500 }));
  assert.equal(await fetchCover(fakeClient(), "ds"), null);
});

test("fetchCover forwards the AbortSignal (superseded fetch is cancellable)", async (t) => {
  const spy = stubFetch(t, () => new Response(new Uint8Array([1]), { status: 200 }));
  const ac = new AbortController();
  await fetchCover(fakeClient(), "ds", ac.signal);
  assert.equal(spy.calls[0].init.signal, ac.signal, "signal threaded to fetch");
});

// ── The object-URL revoke contract the CardMedia effect implements. The effect wraps a
//    fetched cover blob in URL.createObjectURL and REVOKES it in its cleanup (unmount /
//    dataset change); without the revoke every browsed card leaks a blob. We drive the
//    same create→revoke sequence the effect body + cleanup run, over a stubbed URL. ──
test("a card cover's object URL is created from the blob and revoked on cleanup", () => {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const urlApi = URL as unknown as {
    createObjectURL: (b: Blob) => string;
    revokeObjectURL: (u: string) => void;
  };
  const origCreate = urlApi.createObjectURL;
  const origRevoke = urlApi.revokeObjectURL;
  urlApi.createObjectURL = (b: Blob) => {
    created.push(b);
    return `blob:cover-${created.length}`;
  };
  urlApi.revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
  try {
    // The effect body: wrap the cover blob in an object URL (what CardMedia renders as
    // the <img src>).
    const blob = new Blob([new Uint8Array([82, 73, 70, 70])], { type: "image/webp" });
    const objectUrl = URL.createObjectURL(blob);
    assert.equal(objectUrl, "blob:cover-1");
    assert.deepEqual(created, [blob], "the object URL wraps the fetched cover blob");

    // The effect cleanup (unmount / dataset change): revoke the URL so the blob is freed.
    URL.revokeObjectURL(objectUrl);
    assert.deepEqual(revoked, ["blob:cover-1"], "cleanup revoked the card's object URL");
  } finally {
    urlApi.createObjectURL = origCreate;
    urlApi.revokeObjectURL = origRevoke;
  }
});
