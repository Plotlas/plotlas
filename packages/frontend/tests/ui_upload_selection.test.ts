// Tier-1 (Seam O4): the pure upload-selection normalization + pre-flight caps. Folder
// flatten (webkitRelativePath), same-basename dedupe, non-image ignore, .zip classify, the
// caps refusal (per-file / entry-count / bundle-byte), and the name+size fingerprint.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UPLOAD_CAPS,
  basenameOf,
  buildImageSelection,
  fingerprintFiles,
  preflightCaps,
} from "../src/ui/admin/uploadSelection.ts";

/** A caps part (no `file` needed — types are stripped at the node test tier). */
function part(name: string, size: number, isZip = false): { name: string; size: number; isZip: boolean } {
  return { name, size, isZip };
}

test("basenameOf flattens a folder path (webkitRelativePath) to its last segment", () => {
  assert.equal(basenameOf({ name: "a.png", size: 1, webkitRelativePath: "shoot/sub/a.png" }), "a.png");
  assert.equal(basenameOf({ name: "b.png", size: 1 }), "b.png");
  assert.equal(basenameOf({ name: "c.png", size: 1, webkitRelativePath: "win\\dir\\c.png" }), "c.png");
});

test("buildImageSelection classifies images + zips, ignores non-images, dedupes by basename", () => {
  const sel = buildImageSelection([
    { name: "a.png", size: 10 },
    // Same basename via a folder path → dropped (server would 400 a duplicate basename).
    { name: "a.png", size: 99, webkitRelativePath: "shoot/a.png" },
    { name: "b.JPG", size: 20 }, // case-insensitive extension
    { name: "arch.zip", size: 30 }, // server-extracted
    { name: "notes.txt", size: 5 }, // ignored
  ]);
  assert.deepEqual(sel.parts.map((p) => p.name), ["a.png", "b.JPG", "arch.zip"]);
  assert.deepEqual(sel.parts.map((p) => p.isZip), [false, false, true]);
  assert.equal(sel.imageCount, 2);
  assert.equal(sel.zipCount, 1);
  assert.deepEqual(sel.droppedDuplicates, ["a.png"]);
  assert.deepEqual(sel.ignored, ["notes.txt"]);
});

test("preflightCaps refuses a per-file breach with a clear message", () => {
  const check = preflightCaps([part("huge.png", DEFAULT_UPLOAD_CAPS.maxPartBytes + 1)]);
  assert.equal(check.ok, false);
  assert.match(check.message ?? "", /per-file limit/);
});

test("preflightCaps refuses an entry-count breach", () => {
  const many = Array.from({ length: DEFAULT_UPLOAD_CAPS.maxEntries + 1 }, (_, i) => part(`${i}.png`, 1));
  const check = preflightCaps(many);
  assert.equal(check.ok, false);
  assert.match(check.message ?? "", /file limit/);
});

test("preflightCaps refuses a bundle-byte breach (each file within the per-file cap)", () => {
  // Files exactly AT the per-file cap (not over), enough of them to exceed the bundle cap.
  const each = DEFAULT_UPLOAD_CAPS.maxPartBytes;
  const count = Math.ceil(DEFAULT_UPLOAD_CAPS.maxBundleBytes / each) + 1;
  const check = preflightCaps(Array.from({ length: count }, (_, i) => part(`${i}.png`, each)));
  assert.equal(check.ok, false);
  assert.match(check.message ?? "", /bundle limit/);
});

test("preflightCaps EXCLUDES zip parts from the entry/bundle sums (server-enforced), still checks their part size", () => {
  // A single big .zip within the part cap passes (its extracted entries/bytes are server-checked).
  const ok = preflightCaps([part("arch.zip", DEFAULT_UPLOAD_CAPS.maxPartBytes, true)]);
  assert.equal(ok.ok, true);
  // …but a .zip OVER the per-part (compressed) cap is refused.
  const tooBig = preflightCaps([part("arch.zip", DEFAULT_UPLOAD_CAPS.maxPartBytes + 1, true)]);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.message ?? "", /per-file limit/);
});

test("preflightCaps passes a normal selection", () => {
  const check = preflightCaps([part("a.png", 100), part("arch.zip", 200, true)]);
  assert.equal(check.ok, true);
  assert.equal(check.message, null);
});

test("fingerprintFiles is stable, order-independent, and changes when a size changes", () => {
  const a = { name: "a.png", size: 10 };
  const b = { name: "b.png", size: 20 };
  const fp = fingerprintFiles([a, b]);
  assert.equal(fp, fingerprintFiles([b, a]), "order-independent");
  assert.equal(fp, fingerprintFiles([a, b]), "stable");
  assert.notEqual(fp, fingerprintFiles([a, { name: "b.png", size: 21 }]), "size change flips it");
  assert.notEqual(fp, fingerprintFiles([a]), "a different set flips it");
  // A folder path and a flat name with the same basename+size fingerprint identically.
  assert.equal(
    fingerprintFiles([{ name: "x.png", size: 5, webkitRelativePath: "d/x.png" }]),
    fingerprintFiles([{ name: "x.png", size: 5 }]),
  );
});
