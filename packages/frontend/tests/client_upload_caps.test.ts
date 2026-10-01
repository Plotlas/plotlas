// Tier-1 (Seam A2 + PR #316 review, finding 10): GET /api/uploads/caps is read ONCE per
// client. The caps are a process-lifetime constant server-side, while the wizard remounts
// on every Library→New-dataset round trip (AdminScreen renders it only while
// tab === "create") and twice per open under StrictMode — so an un-memoised read issues an
// authenticated request per mount for a value that cannot change. A rejection must be
// EVICTED, or one transient failure pins the whole session to the compiled-in defaults.
// GL-free, dependency-free: mocked globalThis.fetch only.
import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient } from "../src/api-client/client.ts";

const CAPS = { max_part_bytes: 7, max_bundle_bytes: 8, max_entries: 9 };

/** Install a fetch mock for the duration of one test, counting caps requests. */
function withCapsFetch(
  t: { after: (fn: () => void) => void },
  respond: (call: number) => Response | Promise<Response>,
): () => number {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/api/uploads/caps")) calls += 1;
    return respond(calls);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return () => calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("getUploadCaps issues ONE request per client, however many callers ask", async (t) => {
  const calls = withCapsFetch(t, () => jsonResponse(CAPS));
  const client = createApiClient("http://edge", () => "tok");

  // Concurrent callers (two wizard mounts racing, or StrictMode's double mount)
  // COALESCE onto one in-flight request rather than issuing two.
  const [a, b] = await Promise.all([client.getUploadCaps(), client.getUploadCaps()]);
  assert.equal(calls(), 1, "concurrent reads coalesce");
  // A later, sequential caller (a remount minutes afterwards) reuses the resolved one.
  const c = await client.getUploadCaps();
  assert.equal(calls(), 1, "a resolved read is reused");
  assert.deepEqual(a, CAPS);
  assert.deepEqual(b, CAPS);
  assert.deepEqual(c, CAPS);
});

test("a FAILED caps read is evicted, so the next mount retries", async (t) => {
  // The memo must not be a one-shot latch: a proxy hiccup or a 500 on the first mount
  // would otherwise leave every later mount pre-flighting against the compiled-in
  // defaults for the rest of the session, with no way to recover but a page reload.
  const calls = withCapsFetch(t, (call) =>
    call === 1 ? jsonResponse({ detail: "nope" }, 503) : jsonResponse(CAPS),
  );
  const client = createApiClient("http://edge", () => "tok");

  await assert.rejects(() => client.getUploadCaps());
  assert.equal(calls(), 1);
  // Caught rather than awaited bare, so a LATCHED memo reports as this assertion
  // ("the session is pinned to the dead read") instead of re-throwing the old 503
  // from somewhere in the stack.
  const retry = await client.getUploadCaps().catch((err: unknown) => err);
  assert.deepEqual(retry, CAPS, `the retry must re-request, not replay: ${String(retry)}`);
  assert.equal(calls(), 2, "the rejected read was evicted, not cached");
});
