// Tier-1 (Seam O4): the persisted upload session (localStorage). serialize/parse never
// throw and reject malformed/absent input; load/save/clear round-trip through an injected
// store (so the persistence is unit-tested without a DOM).
import assert from "node:assert/strict";
import test from "node:test";

import {
  UPLOAD_SESSION_STORAGE_KEY,
  clearUploadSession,
  loadUploadSession,
  parseUploadSession,
  saveUploadSession,
  serializeUploadSession,
} from "../src/ui/admin/uploadSession.ts";

function fakeStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

test("serialize/parse round-trips a session", () => {
  const s = { uploadId: "u1", datasetId: "ds", fingerprint: "abc123" };
  assert.deepEqual(parseUploadSession(serializeUploadSession(s)), s);
});

test("parseUploadSession returns null on malformed / absent / blank input (never throws)", () => {
  assert.equal(parseUploadSession(null), null);
  assert.equal(parseUploadSession(""), null);
  assert.equal(parseUploadSession("{not valid json"), null);
  assert.equal(parseUploadSession(JSON.stringify({ datasetId: "ds" })), null, "no uploadId");
  assert.equal(parseUploadSession(JSON.stringify({ uploadId: "" })), null, "blank uploadId");
  // Missing datasetId/fingerprint are tolerated (defaulted to "") — only uploadId is required.
  assert.deepEqual(parseUploadSession(JSON.stringify({ uploadId: "u9" })), {
    uploadId: "u9",
    datasetId: "",
    fingerprint: "",
  });
});

test("load / save / clear round-trip through an injected store", () => {
  const store = fakeStore();
  assert.equal(loadUploadSession(store), null);
  saveUploadSession({ uploadId: "u1", datasetId: "ds", fingerprint: "fp" }, store);
  assert.ok(store.map.get(UPLOAD_SESSION_STORAGE_KEY) !== undefined);
  assert.deepEqual(loadUploadSession(store), { uploadId: "u1", datasetId: "ds", fingerprint: "fp" });
  clearUploadSession(store);
  assert.equal(loadUploadSession(store), null);
});

test("load/save/clear are no-ops (never throw) when there is no store", () => {
  assert.equal(loadUploadSession(null), null);
  assert.doesNotThrow(() => saveUploadSession({ uploadId: "u1", datasetId: "d", fingerprint: "f" }, null));
  assert.doesNotThrow(() => clearUploadSession(null));
});
