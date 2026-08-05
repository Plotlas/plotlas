// Tier-1 (brief §3.4): the getMetadata <= 250 cap (D-13). The client's
// documented choice is REJECT (not chunk): an over-cap batch throws before any
// network I/O, so the selection UI must trim and tell the user ("first 250 of
// N"). At or under the cap, exactly one GET goes out with comma-joined ids.
import assert from "node:assert/strict";
import test from "node:test";

import { METADATA_MAX_IDS, createApiClient } from "../src/api-client/client.ts";

test("251 ids are rejected client-side without any fetch", async (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  const ids = Array.from({ length: METADATA_MAX_IDS + 1 }, (_, i) => i);
  await assert.rejects(client.getMetadata("ds", ids), (err: unknown) => {
    assert.ok(err instanceof RangeError);
    assert.match(String(err), /250/);
    return true;
  });
  assert.equal(calls, 0, "the cap is enforced before any network call");
});

test("exactly 250 ids pass through as one GET with comma-joined ids", async (t) => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ rows: [{ id: 0, fields: { filename: "img_000.png" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  const ids = Array.from({ length: METADATA_MAX_IDS }, (_, i) => i);
  const rows = await client.getMetadata("ds", ids);

  assert.equal(urls.length, 1, "exactly one request");
  assert.ok(urls[0].startsWith("http://edge/api/datasets/ds/metadata?ids=0,1,2,"));
  assert.ok(urls[0].endsWith(`,${METADATA_MAX_IDS - 1}`));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.filename, "img_000.png");
});
