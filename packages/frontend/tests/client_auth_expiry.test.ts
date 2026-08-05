// T2-123 (Fix A): the ApiClient's session-expiry choke point. When a request that
// CARRIED a bearer comes back 401, the identity token is no longer accepted (expired /
// revoked) — the client fires the app's `onAuthExpired` hook exactly ONCE per token so
// the app can clear the session and route to re-auth instead of browsing half-alive on
// a dead token (the static-edge 401 spiral). Discrimination: a burst → one fire; the
// login route's own 401 (bad password) does NOT fire; anonymous 401s do NOT fire; a
// re-login (new token) re-arms. Exercised over a mocked fetch — no network, no deps
// beyond apache-arrow (to frame a valid Arrow body for the static-edge spiral case).
import assert from "node:assert/strict";
import test from "node:test";
import { Table, Field, List, Utf8, Int64, vectorFromArray, tableToIPC } from "apache-arrow";

import { createApiClient } from "../src/api-client/client.ts";

const BASE = "http://edge";

interface Seen {
  url: string;
  headers: Record<string, string>;
}

function recordingFetch(
  route: (seen: Seen) => Response | Promise<Response>,
): { handler: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry: Seen = {
      url: String(input),
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    };
    seen.push(entry);
    return route(entry);
  }) as typeof fetch;
  return { handler, seen };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function install(t: { after: (fn: () => void) => void }, handler: typeof fetch): void {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test("a 401 on a request carrying a bearer fires onAuthExpired ONCE across a parallel burst", async (t) => {
  const { handler } = recordingFetch(() => json({ detail: "Not authenticated" }, 401));
  install(t, handler);

  let fires = 0;
  const client = createApiClient(BASE, () => "expired-tok", () => {
    fires += 1;
  });

  // A viewport of parallel authed reads all 401 together (the burst). Each rejects with
  // the typed ApiError, but the session-expiry signal must fire exactly once.
  const calls = Array.from({ length: 8 }, () => client.listDatasets().catch(() => undefined));
  await Promise.all(calls);
  assert.equal(fires, 1, "the burst of 401s collapsed to a single logout signal");
});

test("the login route's own 401 (bad password) does NOT fire onAuthExpired", async (t) => {
  // A STALE token is present in storage, but login sends no bearer (auth:false) — a
  // wrong password must read as a form error, never a session expiry.
  const { handler, seen } = recordingFetch(() => json({ detail: "Invalid credentials" }, 401));
  install(t, handler);

  let fires = 0;
  const client = createApiClient(BASE, () => "stale-token", () => {
    fires += 1;
  });

  await assert.rejects(client.login({ username: "ada", password: "wrong" }));
  assert.equal(seen[0].headers.Authorization, undefined, "login carries no bearer");
  assert.equal(fires, 0, "a bad-password 401 is not a session expiry");
});

test("an anonymous 401 (no token) does NOT fire onAuthExpired", async (t) => {
  const { handler } = recordingFetch(() => json({ detail: "Not authenticated" }, 401));
  install(t, handler);

  let fires = 0;
  const client = createApiClient(BASE, () => null, () => {
    fires += 1;
  });

  await assert.rejects(client.me());
  assert.equal(fires, 0, "there is no session to expire when no token was presented");
});

test("a re-login (a NEW token) re-arms the single-fire signal", async (t) => {
  const { handler } = recordingFetch(() => json({ detail: "Not authenticated" }, 401));
  install(t, handler);

  let token = "tok-A";
  let fires = 0;
  const client = createApiClient(BASE, () => token, () => {
    fires += 1;
  });

  await assert.rejects(client.me()); // tok-A expires → fire #1
  await assert.rejects(client.me()); // same tok-A → debounced (still 1)
  assert.equal(fires, 1, "the same expired token fires only once");

  token = "tok-B"; // the user logged back in; a fresh token is now presented
  await assert.rejects(client.me()); // tok-B also 401s → fire #2 (re-armed)
  assert.equal(fires, 2, "a new token re-arms the signal");
});

// ---------------------------------------------------------------------------
// The static-edge spiral (T2-123): the credential refresh's OWN getManifest presents
// the stale bearer and 401s, so the cookie can never be re-minted — every tile/sidecar
// fetch then 401s forever. Fix A converts that dead-end into a single logout signal.
// ---------------------------------------------------------------------------

const DS = "ds";
const LAYOUT = "grid";
const MANIFEST_PATH = `/api/datasets/${DS}/layouts/${LAYOUT}`;
const TAGS_URL = `${BASE}/datasets/${DS}/tags/tags_v1.arrow`;

function manifestBody(): unknown {
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
    tags: { path: "tags/tags_v1.arrow", format: "arrow" },
    dataset_metadata: { image_count: 2, ingest_timestamp: "2026-01-01T00:00:00Z" },
  };
}

function tagsIpc(): Uint8Array {
  const idVec = vectorFromArray([0n, 1n], new Int64());
  const listType = new List(new Field("item", new Utf8(), true));
  const tagVec = vectorFromArray([["a"], ["b"]], listType);
  return tableToIPC(new Table({ id: idVec, tags: tagVec }), "stream");
}

test("the static-edge 401 spiral fires onAuthExpired once (the refresh's getManifest 401)", async (t) => {
  let phase: "healthy" | "expired" = "healthy";
  const { handler } = recordingFetch((req) => {
    if (req.url.endsWith(MANIFEST_PATH)) {
      // Healthy prime returns the manifest; once expired, the re-open the credential
      // refresh performs presents the same stale bearer and 401s — the spiral.
      return phase === "healthy"
        ? new Response(JSON.stringify(manifestBody()), { status: 200, headers: { "Content-Type": "application/json" } })
        : json({ detail: "token expired" }, 401);
    }
    if (req.url === TAGS_URL) {
      return phase === "healthy" ? new Response(tagsIpc(), { status: 200 }) : json({ detail: "no cookie" }, 401);
    }
    return json({ detail: "404" }, 404);
  });
  install(t, handler);

  let fires = 0;
  const client = createApiClient(BASE, () => "tok", () => {
    fires += 1;
  });

  await client.getManifest(DS, LAYOUT); // prime the refresh's last-layout record (healthy)
  phase = "expired"; // >1h later: the cookie AND the bearer are dead

  // The sidecar 401s → refresh → the refresh's getManifest 401s (fires the signal via
  // requestJson) → refresh resolves false → the sidecar fetch surfaces its 401. The
  // whole dead-end collapses to ONE session-expiry signal.
  await assert.rejects(client.fetchTags(TAGS_URL));
  assert.equal(fires, 1, "the un-recoverable static-edge spiral fired a single logout signal");
});

test("a static-edge 401 that SURVIVES a SUCCESSFUL refresh does NOT fire onAuthExpired (valid identity)", async (t) => {
  // The counterpart to the spiral: the manifest re-open (the credential refresh) returns
  // 200 — the bearer is VALID, so the refresh confirms a live identity — yet the tag
  // sidecar keeps 401ing (a cookie/edge delivery problem, e.g. the fresh cookie's scope
  // doesn't cure it). That is NOT a session expiry: ejecting the user would be a false
  // logout. fetchArrow must fire ONLY when the refresh could not confirm the identity.
  const { handler } = recordingFetch((req) => {
    if (req.url.endsWith(MANIFEST_PATH)) {
      return new Response(JSON.stringify(manifestBody()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (req.url === TAGS_URL) return json({ detail: "no cookie" }, 401);
    return json({ detail: "404" }, 404);
  });
  install(t, handler);

  let fires = 0;
  const client = createApiClient(BASE, () => "valid-tok", () => {
    fires += 1;
  });
  await client.getManifest(DS, LAYOUT); // prime lastLayoutForDataset so the refresh can re-open

  await assert.rejects(client.fetchTags(TAGS_URL));
  assert.equal(fires, 0, "a 401 the refresh confirmed is NOT an expiry (valid bearer) must not log out");
});
