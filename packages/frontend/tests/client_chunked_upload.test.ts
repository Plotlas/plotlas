// Tier-1 (Seam A3): the client sends a part larger than THIS deployment's per-request
// cap as a sequence of byte-range appends against the same route, and sends everything
// else exactly as before. Driven over a FAKE XMLHttpRequest (fetch exposes no upload
// progress) plus a stubbed fetch for the one caps read.
//
// Every await here is bounded by construction: the fake XHR only settles when a spec
// drives it, and each spec asserts the request COUNT it expects before awaiting the
// promise that count settles. A chunk loop that stopped issuing requests therefore
// fails on a count, rather than hanging on a promise nothing will resolve.
import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient, isApiError } from "../src/api-client/client.ts";

class FakeUpload {
  handlers = new Map<string, (ev: unknown) => void>();
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.handlers.set(type, cb);
  }
  emit(type: string, ev: unknown): void {
    this.handlers.get(type)?.(ev);
  }
}

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = new FakeUpload();
  handlers = new Map<string, (ev: unknown) => void>();
  headers: Record<string, string> = {};
  method = "";
  url = "";
  sent: FormData | null = null;
  status = 0;
  responseText = "";
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.handlers.set(type, cb);
  }
  send(body: unknown): void {
    this.sent = body as FormData;
  }
  abort(): void {
    this.handlers.get("abort")?.({});
  }
  emitProgress(loaded: number, total: number): void {
    this.upload.emit("progress", { lengthComputable: true, loaded, total });
  }
  emitLoad(status: number, responseText: string): void {
    this.status = status;
    this.responseText = responseText;
    this.handlers.get("load")?.({});
  }
}

/** The chunk coordinates + payload size of one recorded request. `chunk_offset` and
 *  `part_size` are absent (null) on a whole-part send — which is the discriminator
 *  these specs assert on, so it is read from the real FormData, never assumed. */
function coords(xhr: FakeXHR): { offset: string | null; total: string | null; bytes: number } {
  const form = xhr.sent;
  assert.ok(form !== null, "the request was never sent");
  const offset = form.get("chunk_offset");
  const total = form.get("part_size");
  const blob = form.get("part");
  assert.ok(blob instanceof Blob, "the part field is not a Blob");
  return {
    offset: typeof offset === "string" ? offset : null,
    total: typeof total === "string" ? total : null,
    bytes: blob.size,
  };
}

const STATUS = JSON.stringify({
  upload_id: "u1",
  state: "open",
  received_parts: 1,
  bytes_received: 9,
  ignored: [],
});

/** A client whose caps read is already SETTLED with the given per-part cap (or a
 *  malformed/failing body), so `uploadPartWithProgress` can decide synchronously
 *  enough for a spec to drive it. Returns the client with the caps read awaited. */
async function clientWithCaps(
  t: { after(fn: () => void): void },
  body: unknown,
  ok = true,
): Promise<ReturnType<typeof createApiClient>> {
  const originalXHR = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  const originalFetch = globalThis.fetch;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR as unknown;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  t.after(() => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXHR;
    globalThis.fetch = originalFetch;
    FakeXHR.instances = [];
  });
  const client = createApiClient("http://edge", () => "tok");
  await client.getUploadCaps().catch(() => undefined);
  return client;
}

/** A client that has NEVER read the caps — no fetch is stubbed, and none may be issued. */
function clientWithoutCaps(t: { after(fn: () => void): void }): ReturnType<typeof createApiClient> {
  const originalXHR = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  const originalFetch = globalThis.fetch;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR as unknown;
  globalThis.fetch = (() => {
    throw new Error("uploadPartWithProgress must not issue a caps read of its own");
  }) as unknown as typeof fetch;
  t.after(() => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = originalXHR;
    globalThis.fetch = originalFetch;
    FakeXHR.instances = [];
  });
  return createApiClient("http://edge", () => "tok");
}

function file(name: string, size: number): File {
  const f = new File([new Uint8Array(1)], name, { type: "image/png" });
  Object.defineProperty(f, "size", { value: size });
  // jsdom-free node: File.slice returns a Blob whose size we control the same way, so
  // the specs can assert the per-chunk byte counts the transport computed.
  const realSlice = f.slice.bind(f);
  Object.defineProperty(f, "slice", {
    value: (start: number, end: number) => {
      const blob = realSlice(0, 1);
      Object.defineProperty(blob, "size", { value: end - start });
      return blob;
    },
  });
  return f;
}

/** Drive `count` chunk requests to a 200, asserting the request count FIRST so a
 *  transport that stopped issuing requests fails here instead of hanging. */
async function settleChunks(count: number, at: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    assert.equal(
      FakeXHR.instances.length,
      at + i + 1,
      `expected chunk ${i + 1} to have been issued; the transport stopped early`,
    );
    (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
    await Promise.resolve();
    await Promise.resolve();
  }
}

test("a part over the served per-request cap is sent as ordered byte-range appends", async (t) => {
  const client = await clientWithCaps(t, {
    max_part_bytes: 100,
    max_bundle_bytes: 1_000_000,
    max_entries: 1000,
  });
  const before = FakeXHR.instances.length;
  const p = client.uploadPartWithProgress("u1", file("big.zip", 250));
  await Promise.resolve();
  await Promise.resolve();

  await settleChunks(3, before);
  await p;

  const sent = FakeXHR.instances.slice(before).map(coords);
  assert.equal(sent.length, 3, "250 bytes at a 100-byte cap is three requests");
  assert.deepEqual(
    sent.map((s) => [s.offset, s.total, s.bytes]),
    [
      ["0", "250", 100],
      ["100", "250", 100],
      ["200", "250", 50],
    ],
    "contiguous, in order, and the last chunk is the remainder",
  );
  for (const xhr of FakeXHR.instances.slice(before)) {
    assert.equal(xhr.url, "http://edge/api/uploads/u1/parts", "the SAME route, not a second API");
    assert.equal(xhr.headers.Authorization, "Bearer tok");
    assert.equal(String(xhr.sent?.get("part") instanceof Blob), "true");
  }
});

test("chunk progress is re-based onto the whole part and never exceeds it", async (t) => {
  const client = await clientWithCaps(t, {
    max_part_bytes: 100,
    max_bundle_bytes: 1_000_000,
    max_entries: 1000,
  });
  const before = FakeXHR.instances.length;
  const seen: [number, number][] = [];
  const p = client.uploadPartWithProgress("u1", file("big.zip", 250), (l, total) => seen.push([l, total]));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(FakeXHR.instances.length, before + 1, "the first chunk must be in flight");
  (FakeXHR.instances.at(-1) as FakeXHR).emitProgress(60, 100);
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(FakeXHR.instances.length, before + 2, "the second chunk must follow");
  (FakeXHR.instances.at(-1) as FakeXHR).emitProgress(100, 100);
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
  await Promise.resolve();
  await Promise.resolve();

  // The LAST chunk is where the clamp earns its keep, and it is the realistic case: the
  // final 50 bytes start at offset 200, so ANY multipart framing overhead in the
  // request's `e.loaded` pushes the re-based figure past the part's own size. 120 = the
  // 50 payload bytes plus a boundary + headers. Un-clamped this reports 320 of 250 — a
  // progress bar over 100%, which is what the Math.min exists to prevent.
  assert.equal(FakeXHR.instances.length, before + 3, "the third chunk must follow");
  (FakeXHR.instances.at(-1) as FakeXHR).emitProgress(120, 120);
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
  await p;

  assert.deepEqual(seen, [
    [60, 250],
    [200, 250],
    [250, 250],
  ]);
  assert.equal(
    seen.every(([l, total]) => l <= total),
    true,
    "progress never exceeds the part size",
  );
});

// The three "sent whole" specs assert the request's SHAPE before they await the promise
// it settles. That ordering is load-bearing: a regression that chunks when it should not
// would issue N requests, and awaiting a promise whose remaining chunks nothing drives
// hangs forever — `test:dom`/`test` pass no --test-timeout, and a hanging gate reads
// exactly like a passing one. Asserting first turns that into a named failure.

test("a part WITHIN the served cap is one request carrying no chunk coordinates", async (t) => {
  const client = await clientWithCaps(t, {
    max_part_bytes: 100,
    max_bundle_bytes: 1_000_000,
    max_entries: 1000,
  });
  const before = FakeXHR.instances.length;
  const p = client.uploadPartWithProgress("u1", file("small.png", 100));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(FakeXHR.instances.length, before + 1);
  const only = coords(FakeXHR.instances.at(-1) as FakeXHR);
  assert.deepEqual([only.offset, only.total], [null, null], "exactly at the cap is a whole part");
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
  await p;
});

test("with no readable caps the whole part is sent unchunked, and no caps read is issued", async (t) => {
  // The documented degrade: a client that cannot hear the deployment's cap does not
  // guess at one. The stubbed fetch THROWS, so an added caps read fails this loudly.
  const client = clientWithoutCaps(t);
  const before = FakeXHR.instances.length;
  const p = client.uploadPartWithProgress("u1", file("big.zip", 5_000_000_000));
  assert.equal(FakeXHR.instances.length, before + 1, "one request, issued synchronously");
  const only = coords(FakeXHR.instances.at(-1) as FakeXHR);
  assert.deepEqual([only.offset, only.total], [null, null], "no cap means no chunking");
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
  await p;
});

test("a caps body that is not a usable number disables chunking rather than guessing", async (t) => {
  const client = await clientWithCaps(t, { max_part_bytes: null, max_bundle_bytes: 1, max_entries: 1 });
  const before = FakeXHR.instances.length;
  const p = client.uploadPartWithProgress("u1", file("big.zip", 5_000_000_000));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(FakeXHR.instances.length, before + 1, "one request — an unusable cap is no cap");
  const only = coords(FakeXHR.instances.at(-1) as FakeXHR);
  assert.deepEqual([only.offset, only.total], [null, null]);
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(200, STATUS);
  await p;
});

test("a failed chunk rejects the whole part with the server's typed error", async (t) => {
  // Seam O4's per-part retry is what re-drives it, from offset 0 — so the second chunk
  // must NOT be issued after a rejection, or a retry would collide with a live part.
  const client = await clientWithCaps(t, {
    max_part_bytes: 100,
    max_bundle_bytes: 1_000_000,
    max_entries: 1000,
  });
  const before = FakeXHR.instances.length;
  const p = client.uploadPartWithProgress("u1", file("big.zip", 250));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(FakeXHR.instances.length, before + 1);
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(413, JSON.stringify({ detail: "Upload bundle exceeds the 2147483648-byte bundle limit" }));
  await assert.rejects(p, (err: unknown) => {
    assert.ok(isApiError(err));
    assert.equal(err.status, 413);
    assert.match(err.detail, /bundle limit/);
    return true;
  });
  assert.equal(FakeXHR.instances.length, before + 1, "the loop stopped at the failed chunk");
});

test("an abort before the first chunk sends nothing", async (t) => {
  const client = await clientWithCaps(t, {
    max_part_bytes: 100,
    max_bundle_bytes: 1_000_000,
    max_entries: 1000,
  });
  const before = FakeXHR.instances.length;
  const ac = new AbortController();
  ac.abort();
  const p = client.uploadPartWithProgress("u1", file("big.zip", 250), undefined, ac.signal);
  await assert.rejects(p, (err: unknown) => {
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
  assert.equal(FakeXHR.instances.length, before, "no chunk was issued");
});
