// Unit coverage for the #32 detail-preview fix that the GL-bound viewer shell
// (ViewerScreen.resolvePreview) can't be exercised for in a node test:
//
//   1. fetchCellPreview — the detail route is auth-gated (D-24), so the fetch
//      MUST carry the identity bearer header (a bare <img src> would 401). This
//      pins that contract + the 401/404/no-detail branch mapping.
//   2. createPreviewCache — each preview owns an object URL (a document-lifetime
//      resource); the bounded LRU must REVOKE the URL on evict / same-cell
//      replace / clear, or every clicked cell leaks a blob.
import assert from "node:assert/strict";
import test from "node:test";

import { createPreviewCache, detailForManifest, fetchCellPreview, resolveCellPreview } from "../src/ui/cellPreview.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";

const TOKEN = "tok-preview";

/** Minimal ApiClient stub: fetchCellPreview only touches detailUrl + authHeaders. */
function fakeClient(): ApiClient {
  return {
    detailUrl: (ds: string, id: number, ext: string) =>
      `http://edge/api/datasets/${ds}/detail/${id}.${ext}`,
    authHeaders: () => ({ Authorization: `Bearer ${TOKEN}` }),
  } as unknown as ApiClient;
}

/** Minimal manifest with an `image_ref` detail tier (only the fields
 *  detailForManifest + client.detailUrl read). */
function manifestWithDetail(): LayoutManifest {
  return {
    dataset_id: "ds",
    layouts: [{ layout_id: "grid", detail: { mode: "image_ref", format: "webp" } }],
  } as unknown as LayoutManifest;
}

function stubFetch(
  t: { after: (fn: () => void) => void },
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return handler(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return { calls };
}

test("fetchCellPreview attaches the identity bearer header and returns the blob (200)", async (t) => {
  const spy = stubFetch(t, (input) => {
    assert.equal(String(input), "http://edge/api/datasets/ds/detail/7.webp");
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  });

  const result = await fetchCellPreview(fakeClient(), manifestWithDetail(), 7);

  const headers = spy.calls[0].headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`, "bearer header attached — the #32 fix");
  assert.equal(result.kind, "image");
  if (result.kind === "image") {
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    assert.deepEqual([...bytes], [1, 2, 3]);
  }
});

test("fetchCellPreview maps 401 → unauthorized (caller routes to onAuthExpired)", async (t) => {
  stubFetch(t, () => new Response(null, { status: 401 }));
  const result = await fetchCellPreview(fakeClient(), manifestWithDetail(), 1);
  assert.equal(result.kind, "unauthorized");
});

test("fetchCellPreview maps a non-ok (404) → absent (no preview, retryable)", async (t) => {
  stubFetch(t, () => new Response(null, { status: 404 }));
  const result = await fetchCellPreview(fakeClient(), manifestWithDetail(), 1);
  assert.equal(result.kind, "absent");
});

test("fetchCellPreview returns none — no network round-trip — when no detail tier is baked", async (t) => {
  let called = false;
  stubFetch(t, () => {
    called = true;
    return new Response(null, { status: 200 });
  });
  const noDetail = {
    dataset_id: "ds",
    layouts: [{ layout_id: "grid", detail: null }],
  } as unknown as LayoutManifest;

  const result = await fetchCellPreview(fakeClient(), noDetail, 1);

  assert.equal(result.kind, "none");
  assert.equal(called, false, "no fetch when the dataset baked no detail tier");
});

// ── T2-46 null-ref consumer safety: with detail_tier="skip" the manifest carries
//    NO `detail` block, so the whole click-through path degrades to "no preview"
//    (proving the existing code is already null-safe — no guard added). ──

/** A skip-baked (detail_tier="skip") manifest: no layout declares a `detail` block. */
function manifestNoDetail(): LayoutManifest {
  return {
    dataset_id: "ds",
    layouts: [{ layout_id: "grid" }], // no `detail` key at all
  } as unknown as LayoutManifest;
}

test("detailForManifest returns null when NO layout declares a detail block (skip bake)", () => {
  assert.equal(detailForManifest(manifestNoDetail()), null);
  // Also null when a layout carries an explicit `detail: null`.
  const explicitNull = {
    dataset_id: "ds",
    layouts: [{ layout_id: "grid", detail: null }],
  } as unknown as LayoutManifest;
  assert.equal(detailForManifest(explicitNull), null);
});

test("resolveCellPreview returns null (no preview URL) under a skip-baked manifest", () => {
  // No detail tier ⇒ resolveCellPreview never composes a detail URL, so the
  // MetadataPanel/ViewerScreen `preview` stays null and the "View ⤢" affordance
  // (gated on a resolved preview) never renders.
  assert.equal(resolveCellPreview(fakeClient(), manifestNoDetail(), "", 3), null);
});

test("createPreviewCache: LRU eviction + revokes evicted / replaced / cleared object URLs", () => {
  const revoked: string[] = [];
  const original = (URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL;
  (URL as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
  try {
    const cache = createPreviewCache(2); // tiny cap to force eviction

    cache.put({ cellId: 1, imageUrl: "blob:1" });
    cache.put({ cellId: 2, imageUrl: "blob:2" });
    assert.equal(cache.size, 2);

    // A 3rd distinct cell evicts the OLDEST (cell 1) and revokes its URL.
    cache.put({ cellId: 3, imageUrl: "blob:3" });
    assert.equal(cache.size, 2);
    assert.deepEqual(revoked, ["blob:1"]);
    assert.equal(cache.get(1), undefined, "cell 1 was evicted");

    // get(2) refreshes cell 2's recency, so the NEXT insert evicts cell 3, not 2.
    assert.ok(cache.get(2) !== undefined, "cell 2 still resident");
    cache.put({ cellId: 4, imageUrl: "blob:4" });
    assert.deepEqual(revoked, ["blob:1", "blob:3"], "recently-read cell 2 survived; cell 3 evicted");

    // Replacing the SAME cell (a same-cell race) revokes the prior URL.
    cache.put({ cellId: 2, imageUrl: "blob:2b" });
    assert.deepEqual(revoked, ["blob:1", "blob:3", "blob:2"]);

    // clear() revokes everything still resident (cells 4 and 2b).
    cache.clear();
    assert.equal(cache.size, 0);
    assert.deepEqual(revoked.slice(3).sort(), ["blob:2b", "blob:4"]);
  } finally {
    (URL as { revokeObjectURL?: (u: string) => void }).revokeObjectURL = original;
  }
});
