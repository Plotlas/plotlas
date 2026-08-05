// T2-09 residual (D-i addendum): the api-client's single-flight static-edge
// credential refresh + its use by the cookie-gated tag-sidecar fetch.
//
// refreshDatasetCredential(dsId) re-opens the dataset's last manifest (which the
// D-A server re-issues the `viz_ds` cookie on) so a 401'd static-edge read can
// retry once. It COALESCES concurrent callers onto ONE manifest GET per dataset
// (a whole viewport of tiles expiring together) and rate-limits refreshes with a
// per-dataset cooldown (a post-refresh 401 must not re-refresh and loop). fetchTags
// (the un-signalled path) is a static-edge fetch, so it drives the same refresh:
// a 401 refreshes + retries once; a persistent 401 fails through.
//
// GL-free, dependency-free beyond apache-arrow (to frame a valid Arrow IPC body).
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Field, List, Utf8, Int64, vectorFromArray, tableToIPC } from "apache-arrow";

import { ApiError, createApiClient } from "../src/api-client/client.ts";

const DS = "ds";
const LAYOUT = "grid";
const BASE = "http://edge";
const MANIFEST_PATH = `/api/datasets/${DS}/layouts/${LAYOUT}`;
const TAGS_URL = `${BASE}/datasets/${DS}/tags/tags_v1.arrow`;

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
    dataset_metadata: { image_count: 2, ingest_timestamp: "2026-01-01T00:00:00Z" },
  };
}

/** A tiny id + list<string> "tags" table serialized to Arrow IPC (fetchTags decodes it). */
function tagsIpc(): Uint8Array {
  const idVec = vectorFromArray([0n, 1n], new Int64());
  const listType = new List(new Field("item", new Utf8(), true));
  const tagVec = vectorFromArray([["a"], ["b"]], listType);
  return tableToIPC(new Table({ id: idVec, tags: tagVec }), "stream");
}
const TAGS_IPC = tagsIpc();

function manifestResponse(): Response {
  return new Response(JSON.stringify(manifestJson()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A promise + resolver, so a test can hold a manifest response open and prove
 *  concurrent refresh callers are in flight on the SAME promise. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// refreshDatasetCredential — single-flight + cooldown coordinator
// ---------------------------------------------------------------------------

test("refreshDatasetCredential re-opens the manifest once and reports refreshed", async (t) => {
  let manifestGets = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith(MANIFEST_PATH)) {
      manifestGets += 1;
      return manifestResponse();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime the last-layout record (manifestGets = 1)
  const refreshed = await client.refreshDatasetCredential(DS);
  assert.equal(refreshed, true, "the refresh reported success (the manifest re-opened)");
  assert.equal(manifestGets, 2, "the refresh performed exactly ONE manifest re-open");
});

test("concurrent refreshDatasetCredential calls COALESCE onto one manifest re-open", async (t) => {
  let manifestGets = 0;
  let refreshGate: { promise: Promise<void>; resolve: (v: void) => void } | null = null;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith(MANIFEST_PATH)) {
      manifestGets += 1;
      // The priming GET (1st) resolves immediately; the REFRESH GET (2nd) is held
      // open on the gate so the 10 concurrent callers are provably in flight on the
      // ONE shared refresh promise before it settles.
      if (refreshGate !== null) await refreshGate.promise;
      return manifestResponse();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)

  // Arm the gate so the refresh's manifest GET blocks; fire ten concurrent refresh
  // requests (a viewport of tiles 401ing together). They must share ONE in-flight
  // refresh (one additional manifest GET, held open by the gate), not ten.
  refreshGate = deferred<void>();
  const pending = Array.from({ length: 10 }, () => client.refreshDatasetCredential(DS));
  await Promise.resolve(); // let the first caller reach its (gated) manifest GET
  assert.equal(manifestGets, 2, "the ten concurrent refreshes issued ONE manifest GET (coalesced), now blocked");

  refreshGate.resolve(); // release the single refresh's manifest response
  const results = await Promise.all(pending);
  assert.ok(results.every((r) => r === true), "all coalesced callers saw the refresh succeed");
  assert.equal(manifestGets, 2, "still exactly one refresh manifest GET after all resolve (priming + 1)");
});

test("a second refresh within the cooldown is declined (no re-refresh loop)", async (t) => {
  let manifestGets = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith(MANIFEST_PATH)) {
      manifestGets += 1;
      return manifestResponse();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)

  const first = await client.refreshDatasetCredential(DS);
  assert.equal(first, true, "the first refresh ran");
  assert.equal(manifestGets, 2, "one re-open on the first refresh");

  // A second refresh IMMEDIATELY after (still within CREDENTIAL_REFRESH_COOLDOWN_MS)
  // is declined: no manifest re-open, resolves false so the caller stops.
  const second = await client.refreshDatasetCredential(DS);
  assert.equal(second, false, "the second refresh within the cooldown is declined");
  assert.equal(manifestGets, 2, "no re-open on the cooled-down second refresh");
});

test("refreshDatasetCredential resolves false when no manifest was ever opened", async (t) => {
  let manifestGets = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { manifestGets += 1; return manifestResponse(); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  // No getManifest call → nothing to re-open → false, and NO network hit.
  const refreshed = await client.refreshDatasetCredential("never-opened");
  assert.equal(refreshed, false, "nothing primed to re-open → declined");
  assert.equal(manifestGets, 0, "a declined refresh performs no manifest GET");
});

test("refreshDatasetCredential resolves false (never throws) when the re-open fails", async (t) => {
  let manifestGets = 0;
  let failManifest = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith(MANIFEST_PATH)) {
      manifestGets += 1;
      if (failManifest) return new Response(JSON.stringify({ detail: "gone" }), { status: 401 });
      return manifestResponse();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)
  failManifest = true; // the identity itself is now unauthenticated: the re-open 401s

  // The refresh must NOT throw (a failed re-open is a "no fresh cookie" signal, not
  // an exception the caller has to catch) — it resolves false.
  const refreshed = await client.refreshDatasetCredential(DS);
  assert.equal(refreshed, false, "a failed re-open resolves false, does not throw");
  assert.equal(manifestGets, 2, "the failed re-open was attempted once");
});

// ---------------------------------------------------------------------------
// fetchTags (the cookie-gated static-edge sidecar) drives the same refresh
// ---------------------------------------------------------------------------

test("a 401 tag-sidecar fetch refreshes the credential and retries once, then binds", async (t) => {
  let manifestGets = 0;
  let tagsReads = 0;
  let cookieFresh = false; // the stale-tab cookie has expired
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(MANIFEST_PATH)) {
      manifestGets += 1;
      cookieFresh = true; // the manifest re-open re-issued the cookie
      return manifestResponse();
    }
    if (url === TAGS_URL) {
      tagsReads += 1;
      if (!cookieFresh) return new Response(JSON.stringify({ detail: "No dataset credential" }), { status: 401 });
      return new Response(TAGS_IPC, { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)
  cookieFresh = false; // >1h later: the sidecar's cookie expired on this tab

  const table = await client.fetchTags(TAGS_URL);
  assert.equal(table.numRows, 2, "the sidecar decoded after the refresh + retry");
  assert.equal(manifestGets, 2, "the 401 tag fetch triggered exactly one manifest re-open");
  assert.equal(tagsReads, 2, "the tag fetch was retried once (401 then 200)");
});

test("a persistently-401 tag fetch surfaces the ApiError (one refresh, no loop)", async (t) => {
  let manifestGets = 0;
  let tagsReads = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(MANIFEST_PATH)) {
      manifestGets += 1;
      return manifestResponse(); // re-open succeeds but the sidecar keeps 401ing
    }
    if (url === TAGS_URL) {
      tagsReads += 1;
      return new Response(JSON.stringify({ detail: "still forbidden" }), { status: 401 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)

  // 401 → refresh (manifestGets 2) → retry → still 401 → ApiError surfaces. No
  // second refresh (cooldown), so a failing sidecar cannot loop.
  await assert.rejects(client.fetchTags(TAGS_URL), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
    return true;
  });
  assert.equal(manifestGets, 2, "exactly one refresh on the tag 401");
  assert.equal(tagsReads, 2, "one initial read + one retry, then the error surfaced (no loop)");
});

test("a signalled tag fetch never refreshes (the superseded-generation path)", async (t) => {
  let manifestGets = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(MANIFEST_PATH)) { manifestGets += 1; return manifestResponse(); }
    if (url === TAGS_URL) return new Response(JSON.stringify({ detail: "401" }), { status: 401 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = createApiClient(BASE, () => "tok");
  await client.getManifest(DS, LAYOUT); // prime (manifestGets = 1)

  // The signalled (cancellation) path is being superseded — a 401 there must NOT
  // trigger a refresh; the error surfaces directly.
  const ctrl = new AbortController();
  await assert.rejects(client.fetchTags(TAGS_URL, ctrl.signal), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    return true;
  });
  assert.equal(manifestGets, 1, "the signalled path never refreshes (still just the priming GET)");
});
