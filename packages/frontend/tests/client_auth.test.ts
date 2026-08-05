// Tier-1 (brief §3.3): auth flow over a mocked fetch. signup/login send NO
// bearer (even when a stale token exists); subsequent calls attach the token
// the getToken closure yields; non-2xx surfaces as the typed ApiError carrying
// status + the server's detail. The JWT is identity-only (D-24) — the client
// treats it as an opaque string (nothing here decodes it).
import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, createApiClient, isApiError } from "../src/api-client/client.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | FormData | null;
}

function recordingFetch(
  route: (seen: Seen) => Response | Promise<Response>,
): { handler: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const handler = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body:
        init?.body instanceof FormData
          ? init.body
          : init?.body !== undefined && init?.body !== null
            ? String(init.body)
            : null,
    };
    seen.push(entry);
    return route(entry);
  }) as typeof fetch;
  return { handler, seen };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("login/signup send no bearer; later calls attach the token from getToken", async (t) => {
  let token: string | null = "stale-token-that-must-not-leak";
  const { handler, seen } = recordingFetch((req) => {
    if (req.url.endsWith("/api/auth/signup")) return json({ username: "ada", email: "a@b.c" });
    if (req.url.endsWith("/api/auth/login"))
      return json({ access_token: "tok-123", token_type: "bearer" });
    if (req.url.endsWith("/api/auth/me")) {
      if (req.headers.Authorization !== "Bearer tok-123")
        return json({ detail: "Not authenticated" }, 401);
      return json({ username: "ada", email: "a@b.c" });
    }
    if (req.url.endsWith("/api/datasets")) return json({ datasets: [] });
    return json({ detail: "no route" }, 404);
  });
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => token);

  await client.signup({ username: "ada", email: "a@b.c", password: "pw123456" });
  assert.equal(seen[0].headers.Authorization, undefined, "signup must not carry a bearer");
  assert.equal(seen[0].method, "POST");
  assert.deepEqual(JSON.parse(seen[0].body as string), {
    username: "ada",
    email: "a@b.c",
    password: "pw123456",
  });

  const tokenResponse = await client.login({ username: "ada", password: "pw123456" });
  assert.equal(seen[1].headers.Authorization, undefined, "login must not carry a bearer");
  token = tokenResponse.access_token; // the caller-owned closure picks it up

  await client.me();
  assert.equal(seen[2].headers.Authorization, "Bearer tok-123");

  await client.listDatasets();
  assert.equal(seen[3].headers.Authorization, "Bearer tok-123");
});

test("a 401 surfaces as the typed ApiError with the server detail", async (t) => {
  const { handler } = recordingFetch(() => json({ detail: "Not authenticated" }, 401));
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => null);
  await assert.rejects(client.me(), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.ok(isApiError(err));
    assert.equal(err.status, 401);
    assert.equal(err.detail, "Not authenticated");
    return true;
  });
});

test("deleteDataset resolves on 204 and surfaces the 409-while-running detail", async (t) => {
  let respondWith: Response = new Response(null, { status: 204 });
  const { handler, seen } = recordingFetch(() => respondWith);
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  await client.deleteDataset("ds1");
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "http://edge/api/datasets/ds1");
  assert.equal(seen[0].headers.Authorization, "Bearer tok");

  respondWith = json({ detail: "An ingest job for this dataset is still running" }, 409);
  await assert.rejects(client.deleteDataset("ds1"), (err: unknown) => {
    assert.ok(isApiError(err));
    assert.equal(err.status, 409);
    assert.match(err.detail, /still running/);
    return true;
  });
});

test("non-JSON error bodies fall back to the HTTP status text", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("<html>boom</html>", { status: 502, statusText: "Bad Gateway" })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  await assert.rejects(client.listDatasets(), (err: unknown) => {
    assert.ok(isApiError(err));
    assert.equal(err.status, 502);
    assert.equal(err.detail, "Bad Gateway");
    return true;
  });
});

test("uploadPart posts multipart form data with the part's filename", async (t) => {
  const { handler, seen } = recordingFetch(() =>
    json({ upload_id: "u1", state: "open", received_parts: 1, bytes_received: 3, ignored: [] }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  const file = new File([new Uint8Array([1, 2, 3])], "photos.zip", { type: "application/zip" });
  const status = await client.uploadPart("u1", file);

  assert.equal(seen[0].url, "http://edge/api/uploads/u1/parts");
  assert.equal(seen[0].method, "POST");
  assert.ok(seen[0].body instanceof FormData, "body is FormData (runtime sets the boundary)");
  const sent = (seen[0].body as FormData).get("part");
  assert.ok(sent instanceof File);
  assert.equal(sent.name, "photos.zip");
  assert.equal(status.received_parts, 1);
});
