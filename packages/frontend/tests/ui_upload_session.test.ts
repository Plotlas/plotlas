// Tier-1 (Seam O4): the persisted upload session (localStorage). serialize/parse never
// throw and reject malformed/absent input; load/save/clear round-trip through an injected
// store (so the persistence is unit-tested without a DOM).
//
// Seam L3 (D-xxviii): the session is keyed on the UPLOAD. It no longer carries a dataset
// id — the intake stopped asking for one, the API mints it at create — and it records
// what was being uploaded so the resume banner can describe it instead.
import assert from "node:assert/strict";
import test from "node:test";

import {
  UPLOAD_SESSION_STORAGE_KEY,
  clearUploadSession,
  describeUploadSession,
  loadUploadSession,
  parseUploadSession,
  saveUploadSession,
  serializeUploadSession,
} from "../src/ui/admin/uploadSession.ts";
import { formatBytes } from "../src/ui/admin/uploadSelection.ts";

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
  const s = { uploadId: "u1", fingerprint: "abc123", fileCount: 3, totalBytes: 4096 };
  assert.deepEqual(parseUploadSession(serializeUploadSession(s)), s);
});

test("a serialized session carries no dataset id", () => {
  const raw = JSON.parse(serializeUploadSession({ uploadId: "u1", fingerprint: "f", fileCount: 1, totalBytes: 1 })) as object;
  assert.equal("datasetId" in raw, false);
});

test("parseUploadSession returns null on malformed / absent / blank input (never throws)", () => {
  assert.equal(parseUploadSession(null), null);
  assert.equal(parseUploadSession(""), null);
  assert.equal(parseUploadSession("{not valid json"), null);
  assert.equal(parseUploadSession(JSON.stringify({ fingerprint: "f" })), null, "no uploadId");
  assert.equal(parseUploadSession(JSON.stringify({ uploadId: "" })), null, "blank uploadId");
  // Missing fingerprint/counts are tolerated — only uploadId is required.
  assert.deepEqual(parseUploadSession(JSON.stringify({ uploadId: "u9" })), {
    uploadId: "u9",
    fingerprint: "",
    fileCount: 0,
    totalBytes: 0,
  });
});

test("a record written before seam L3 still parses, and its typed id is dropped", () => {
  const before = JSON.stringify({ uploadId: "u9", datasetId: "old_ds", fingerprint: "fp" });
  assert.deepEqual(parseUploadSession(before), { uploadId: "u9", fingerprint: "fp", fileCount: 0, totalBytes: 0 });
});

test("the banner describes what was uploaded, and nothing when that is unknown", () => {
  assert.equal(describeUploadSession({ uploadId: "u", fingerprint: "f", fileCount: 1, totalBytes: 512 }, formatBytes), "1 file, 512 B");
  assert.equal(describeUploadSession({ uploadId: "u", fingerprint: "f", fileCount: 12, totalBytes: 0 }, formatBytes), "12 files");
  assert.equal(describeUploadSession({ uploadId: "u", fingerprint: "f", fileCount: 0, totalBytes: 0 }, formatBytes), null);
});

test("load / save / clear round-trip through an injected store", () => {
  const store = fakeStore();
  assert.equal(loadUploadSession(store), null);
  const s = { uploadId: "u1", fingerprint: "fp", fileCount: 2, totalBytes: 10 };
  saveUploadSession(s, store);
  assert.ok(store.map.get(UPLOAD_SESSION_STORAGE_KEY) !== undefined);
  assert.deepEqual(loadUploadSession(store), s);
  clearUploadSession(store);
  assert.equal(loadUploadSession(store), null);
});

test("load/save/clear are no-ops (never throw) when there is no store", () => {
  assert.equal(loadUploadSession(null), null);
  assert.doesNotThrow(() => saveUploadSession({ uploadId: "u1", fingerprint: "f", fileCount: 0, totalBytes: 0 }, null));
  assert.doesNotThrow(() => clearUploadSession(null));
});
