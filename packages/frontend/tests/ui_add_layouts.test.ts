// T2-58 / T2-92 — the "Add layout" data edges, in the existing admin-UI test style
// (the REAL ApiClient with fetch mocked; node cannot click, so the client contract and
// the error→message path are driven directly — which is what the designer's Review &
// commit sends (ui/designer/layouts.ts, seam L5; its DOM flow is covered by tests/dom/*).
//
// Covers: the client POSTs the chosen layout specs (T2-92 submits expanded layout_ids)
// to the add-layouts route with the bearer AND forwards the column_roles override (the
// Seam-1 re-map path — the backend already accepts it), and the server's 403/409/422
// detail surfaces as ApiError.detail (the string AdminScreen renders verbatim — never a
// raw status).
import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient, isApiError } from "../src/api-client/client.ts";
import type { ColumnRoles } from "../src/generated/column_roles.ts";

const TOKEN = "tok-al";

/** A fetch mock that records the add-layouts POST and answers a scripted response. */
function mockFetch(answer: (body: unknown) => Response): {
  fetch: typeof fetch;
  seen: { url: string; method: string; auth: string | undefined; body: unknown }[];
} {
  const seen: { url: string; method: string; auth: string | undefined; body: unknown }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, method, auth: headers.Authorization, body });
    return answer(body);
  }) as typeof fetch;
  return { fetch: fn, seen };
}

test("addLayouts POSTs the chosen specs (with the bearer) to the layouts route", async () => {
  const { fetch, seen } = mockFetch(() =>
    new Response(JSON.stringify({ job_id: "j-al-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const client = createApiClient("http://edge", () => TOKEN);
    const res = await client.addLayouts("my_ds", { layout_specs: ["datetime", "categorical"] });
    assert.equal(res.job_id, "j-al-1");
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(seen.length, 1);
  const call = seen[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "http://edge/api/datasets/my_ds/layouts");
  assert.equal(call.auth, `Bearer ${TOKEN}`); // identity-only JWT (D-24) attached
  assert.deepEqual(call.body, { layout_specs: ["datetime", "categorical"] });
});

test("addLayouts encodes the dataset id in the path", async () => {
  const { fetch, seen } = mockFetch(() =>
    new Response(JSON.stringify({ job_id: "j" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const client = createApiClient("http://edge", () => TOKEN);
    await client.addLayouts("weird id/../x", { layout_specs: ["scatter"] });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen[0].url, `http://edge/api/datasets/${encodeURIComponent("weird id/../x")}/layouts`);
});

// The server's human-readable detail must reach the caller as ApiError.detail — that
// is the exact string AdminScreen surfaces in its banner (never a raw status code).
for (const { status, detail } of [
  { status: 403, detail: "Not the dataset owner" },
  {
    status: 409,
    detail: "An ingest job for this dataset is still running",
  },
  {
    status: 409,
    detail:
      "add-layouts needs the original source images, resolved from a finalized upload bundle.",
  },
  { status: 422, detail: "layout_specs: List should have at least 1 item" },
]) {
  test(`addLayouts surfaces the ${status} server detail as ApiError.detail`, async () => {
    const { fetch } = mockFetch(() =>
      new Response(JSON.stringify({ detail }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      const client = createApiClient("http://edge", () => TOKEN);
      await assert.rejects(
        client.addLayouts("my_ds", { layout_specs: ["datetime"] }),
        (err: unknown) => {
          assert.ok(isApiError(err), "throws an ApiError");
          assert.equal(err.status, status);
          assert.equal(err.detail, detail); // the message the UI banner renders
          return true;
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  });
}

test("addLayouts forwards the column_roles override alongside the specs (T2-92 Seam 1)", async () => {
  // The wizard re-maps already-stored columns and submits the compiled roles as an
  // override; the client must forward it verbatim (the backend re-validates it against
  // the committed parquet — no schema/route change).
  const roles: ColumnRoles = {
    filename: { column: "file", label: "Filename" },
    categorical: [{ column: "habitat", label: "habitat" }],
  };
  const { fetch, seen } = mockFetch(() =>
    new Response(JSON.stringify({ job_id: "j-al-roles" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const client = createApiClient("http://edge", () => TOKEN);
    await client.addLayouts("my_ds", { layout_specs: ["categorical_habitat"], column_roles: roles });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen[0].body, { layout_specs: ["categorical_habitat"], column_roles: roles });
});
