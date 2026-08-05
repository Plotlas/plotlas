// Tier-1 (Seam O4): the client's XHR upload-progress method + the O2 resume-surface reads.
// uploadPartWithProgress is driven over a FAKE XMLHttpRequest (fetch exposes no upload
// progress) — asserting the multipart POST, the bearer header (same authHeaders pattern as
// the fetch client), forwarded progress events, a 200 already_present resolve, a 409 →
// typed ApiError, a network error → ApiError(0), and signal abort. list/files/check ride
// the normal fetch path.
import assert from "node:assert/strict";
import test from "node:test";

import { createApiClient, isApiError } from "../src/api-client/client.ts";

// --- a controllable fake XMLHttpRequest ------------------------------------
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
  sent: unknown = null;
  aborted = false;
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
    this.sent = body;
  }
  abort(): void {
    this.aborted = true;
    this.handlers.get("abort")?.({});
  }
  // test drivers
  emitProgress(loaded: number, total: number): void {
    this.upload.emit("progress", { lengthComputable: true, loaded, total });
  }
  emitLoad(status: number, responseText: string): void {
    this.status = status;
    this.responseText = responseText;
    this.handlers.get("load")?.({});
  }
  emitError(): void {
    this.handlers.get("error")?.({});
  }
}

function installFakeXHR(t: { after(fn: () => void): void }): void {
  const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR as unknown;
  t.after(() => {
    (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
    FakeXHR.instances = [];
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("uploadPartWithProgress posts multipart with the bearer, forwards progress, resolves already_present", async (t) => {
  installFakeXHR(t);
  const client = createApiClient("http://edge", () => "tok");
  const file = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
  const progress: [number, number][] = [];
  const p = client.uploadPartWithProgress("u1", file, (l, total) => progress.push([l, total]));

  const xhr = FakeXHR.instances.at(-1) as FakeXHR;
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.url, "http://edge/api/uploads/u1/parts");
  assert.equal(xhr.headers.Authorization, "Bearer tok");
  assert.ok(xhr.sent instanceof FormData, "body is FormData (runtime sets the multipart boundary)");
  const sentPart = (xhr.sent as FormData).get("part");
  assert.ok(sentPart instanceof File);
  assert.equal((sentPart as File).name, "a.png");

  xhr.emitProgress(2, 3);
  xhr.emitProgress(3, 3);
  xhr.emitLoad(
    200,
    JSON.stringify({ upload_id: "u1", state: "open", received_parts: 1, bytes_received: 3, ignored: [], already_present: true }),
  );
  const status = await p;
  assert.equal(status.already_present, true);
  assert.deepEqual(progress, [[2, 3], [3, 3]]);
});

test("uploadPartWithProgress rejects a 409 mismatch as a typed ApiError carrying the detail", async (t) => {
  installFakeXHR(t);
  const client = createApiClient("http://edge", () => "tok");
  const p = client.uploadPartWithProgress("u1", new File([new Uint8Array([1])], "a.png"));
  (FakeXHR.instances.at(-1) as FakeXHR).emitLoad(409, JSON.stringify({ detail: "a different file with this name exists" }));
  await assert.rejects(p, (err: unknown) => {
    assert.ok(isApiError(err));
    assert.equal(err.status, 409);
    assert.match(err.detail, /different file/);
    return true;
  });
});

test("uploadPartWithProgress rejects a network error as a retriable ApiError(0)", async (t) => {
  installFakeXHR(t);
  const client = createApiClient("http://edge", () => "tok");
  const p = client.uploadPartWithProgress("u1", new File([new Uint8Array([1])], "a.png"));
  (FakeXHR.instances.at(-1) as FakeXHR).emitError();
  await assert.rejects(p, (err: unknown) => {
    assert.ok(isApiError(err));
    assert.equal(err.status, 0);
    return true;
  });
});

test("uploadPartWithProgress aborts the in-flight part via signal (AbortError)", async (t) => {
  installFakeXHR(t);
  const client = createApiClient("http://edge", () => "tok");
  const ac = new AbortController();
  const p = client.uploadPartWithProgress("u1", new File([new Uint8Array([1])], "a.png"), undefined, ac.signal);
  ac.abort();
  const xhr = FakeXHR.instances.at(-1) as FakeXHR;
  assert.equal(xhr.aborted, true);
  await assert.rejects(p, (err: unknown) => {
    assert.equal((err as Error).name, "AbortError");
    return true;
  });
});

test("listUploads / listUploadFiles / checkUploadFiles hit the right routes with the bearer", async (t) => {
  const seen: { url: string; method: string; body: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, method: init?.method ?? "GET", body: init?.body != null ? String(init.body) : null });
    if (url.endsWith("/api/uploads")) {
      return json([{ upload_id: "u1", state: "open", received_parts: 2, bytes_received: 20, created: 1, last_activity: 2 }]);
    }
    if (url.includes("/files")) return json({ upload_id: "u1", total: 0, limit: 1000, offset: 0, files: [] });
    if (url.endsWith("/check")) return json({ present: [], needed: ["a.png"], mismatched: [] });
    return json({ detail: "no route" }, 404);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  const client = createApiClient("http://edge", () => "tok");
  const list = await client.listUploads();
  assert.equal(list[0].upload_id, "u1");
  assert.equal(list[0].state, "open");

  const page = await client.listUploadFiles("u1", 50, 10);
  assert.equal(page.upload_id, "u1");
  const filesReq = seen.find((s) => s.url.includes("/files"));
  assert.match(filesReq?.url ?? "", /\/api\/uploads\/u1\/files\?limit=50&offset=10$/);

  const check = await client.checkUploadFiles("u1", [{ name: "a.png", size: 1 }]);
  assert.deepEqual(check.needed, ["a.png"]);
  const checkReq = seen.find((s) => s.url.endsWith("/check"));
  assert.equal(checkReq?.method, "POST");
  assert.deepEqual(JSON.parse(checkReq?.body ?? "null"), { files: [{ name: "a.png", size: 1 }] });
});
