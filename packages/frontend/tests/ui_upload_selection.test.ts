// Tier-1 (Seam O4): the pure upload-selection normalization + pre-flight caps. Folder
// flatten (webkitRelativePath), same-basename dedupe, non-image ignore, .zip classify, the
// caps refusal (entry-count / bundle-byte), and the name+size fingerprint.
//
// Seam A3 removed the per-FILE refusal: `maxPartBytes` bounds one REQUEST, and the
// transport now chunks a larger file rather than refusing it, so the pre-flight's only
// remaining levers are the two whole-bundle ceilings. Every served-caps spec below is
// therefore expressed against those — the A2 property (this deployment's numbers reach
// the browser, in BOTH directions) is unchanged; only the cap that demonstrates it moved.
//
// Seam L1 then removed the FALLBACK's byte ceiling: the server bounds a bundle by free
// disk, so there is no compiled-in number left for the client to mirror and
// `DEFAULT_UPLOAD_CAPS.maxBundleBytes` is null. Every byte-cap spec below therefore
// supplies the ceiling it tests, because a deployment that states one is now the only
// way that branch runs. What was previously pinned here — 2 GiB, and a refusal under
// the fallback — was pinning a client-side invention that refused uploads the server
// accepts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_UPLOAD_CAPS,
  basenameOf,
  buildImageSelection,
  capsFromServer,
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

test("preflightCaps ACCEPTS a file over the per-request cap — the transport chunks it", () => {
  // Seam A3's user-visible half. This spec used to assert the opposite; the refusal it
  // pinned told the user to "Remove or shrink it" for a file the product now accepts,
  // and leaving it in place would have kept chunking unreachable (the wizard's submit
  // gate is `preflightCaps().ok`).
  const check = preflightCaps([part("huge.png", DEFAULT_UPLOAD_CAPS.maxPartBytes + 1)]);
  assert.equal(check.ok, true);
  assert.equal(check.message, null);
  // …and an over-cap ARCHIVE too — the shape the seam's grounding item complained about
  // ("It requires zip files smaller than 100mb").
  const zipped = preflightCaps([part("huge.zip", DEFAULT_UPLOAD_CAPS.maxPartBytes * 30, true)]);
  assert.equal(zipped.ok, true);
});

test("preflightCaps refuses an entry-count breach against the FALLBACK entry cap", () => {
  // The one whole-bundle ceiling the fallback still carries, because the server still
  // compiles one in (`_DEFAULT_MAX_ENTRIES`). One shared object, a million pointers: the
  // count branch reads `.isZip` and the array LENGTH, never a name, so a million distinct
  // objects would cost ~200 MB of heap to prove nothing extra.
  const one = part("a.png", 1);
  const many = Array.from({ length: DEFAULT_UPLOAD_CAPS.maxEntries + 1 }, () => one);
  const check = preflightCaps(many);
  assert.equal(check.ok, false);
  assert.match(check.message ?? "", /file limit/);
  // One under the cap passes, so the pin is on the boundary and not on "a big array".
  assert.equal(preflightCaps(many.slice(1)).ok, true);
});

test("preflightCaps refuses a bundle-byte breach against the SERVED ceiling", () => {
  // Files exactly AT the per-request cap (not over), enough of them to exceed the bundle
  // ceiling this deployment advertises. The ceiling is supplied because the fallback has
  // none: seam L1 left the byte bound as free disk, which no client can mirror.
  const each = DEFAULT_UPLOAD_CAPS.maxPartBytes;
  const advertised = 2_147_483_648; // this deployment's MAX_UPLOAD_BUNDLE_BYTES
  const served = capsFromServer({
    max_part_bytes: each,
    max_bundle_bytes: advertised,
    max_entries: DEFAULT_UPLOAD_CAPS.maxEntries,
  });
  const count = Math.ceil(advertised / each) + 1;
  const parts = Array.from({ length: count }, (_, i) => part(`${i}.png`, each));
  const check = preflightCaps(parts, served);
  assert.equal(check.ok, false);
  assert.match(check.message ?? "", /bundle limit/);
  // The SAME selection passes when no ceiling was advertised — the fallback does not
  // stand in for one. Without this half the spec cannot tell "over the served ceiling"
  // from "over any ceiling at all".
  assert.equal(preflightCaps(parts).ok, true);
});

test("preflightCaps EXCLUDES zip parts from the entry/bundle sums (server-enforced)", () => {
  // A .zip's extracted entry count and uncompressed bytes are unknowable client-side
  // (ZipInfo can lie — D-27), so an archive that alone exceeds the advertised BUNDLE byte
  // ceiling still passes the pre-flight and meets the server's streamed enforcement.
  const served = capsFromServer({ max_part_bytes: 1024, max_bundle_bytes: 4096, max_entries: 100 });
  const archiveOnly = preflightCaps([part("arch.zip", 4096 * 2, true)], served);
  assert.equal(archiveOnly.ok, true);
  // The same bytes as PLAIN parts are refused, which is what "excluded from the sums"
  // means — without the exclusion this pair would agree.
  const plain = preflightCaps([part("a.png", 4096 * 2)], served);
  assert.equal(plain.ok, false);
  assert.match(plain.message ?? "", /bundle limit/);
});

test("preflightCaps passes a normal selection", () => {
  const check = preflightCaps([part("a.png", 100), part("arch.zip", 200, true)]);
  assert.equal(check.ok, true);
  assert.equal(check.message, null);
});

// --- Seam A2: the caps come from the server, not a compiled-in mirror ---------

test("DEFAULT_UPLOAD_CAPS mirrors the server's compiled-in defaults, and invents nothing", () => {
  // Every other caps spec asserts RELATIVE to these, so without a literal pin the whole
  // frontend gate stays green if someone edits them. Seam A2 makes them the documented
  // fallback (interface-catalogue "Upload resource caps (env)"), so they are a contract,
  // not an implementation detail.
  //
  // Two of the three are transcribed from constants that still exist in
  // `api/routers/uploads.py`. The third is `null` BY CONTRACT: seam L1 deleted
  // `_DEFAULT_MAX_BUNDLE_BYTES` and made the bundle bound live free disk, so there is no
  // server number to mirror and the fallback must not manufacture one. A literal here is
  // therefore the pin on the whole finding — a future edit that "restores" 2 GiB fails
  // this spec instead of silently refusing uploads the server would take.
  assert.deepEqual(DEFAULT_UPLOAD_CAPS, {
    maxPartBytes: 104_857_600, // 100 MiB — _DEFAULT_MAX_PART_BYTES
    maxBundleBytes: null, // no compiled-in server ceiling exists
    maxEntries: 1_000_000, // _DEFAULT_MAX_ENTRIES
  });
});

test("the fallback caps refuse NO bundle, however large — the server owns that bound", () => {
  // The finding this file was re-cut for. Between seam L1 and its review the fallback
  // still said 2 GiB while the server's bound was free disk, and the wizard gates submit
  // on `preflightCaps().ok` — so an unreadable caps route refused every selection between
  // 2 GiB and the size of the disk, which the server would have accepted. The fallback's
  // job is to degrade, and the only honest degrade for a bound it cannot compute is not
  // to check it.
  const huge = 64 * 1024 * 1024 * 1024 * 1024; // 64 TiB, larger than any device we ship on
  assert.equal(preflightCaps([part("corpus.png", huge)]).ok, true);
  assert.equal(preflightCaps([part("a.png", huge), part("b.png", huge)]).message, null);
  // …and the same is true of the fallback a malformed 200 takes, which is the SAME object.
  assert.equal(preflightCaps([part("corpus.png", huge)], capsFromServer({})).ok, true);
  // The count ceiling is NOT dropped with it: the fallback still mirrors a real one.
  assert.equal(DEFAULT_UPLOAD_CAPS.maxEntries, 1_000_000);
});

test("the fallback constant cannot be mutated, and capsFromServer never hands it out", () => {
  // ONE object is the fallback for the whole session — preflightCaps' default argument,
  // the wizard's initial useState value, and capsFromServer's fallback source. A caller
  // treating a returned caps object as owned would otherwise rewrite the fallback
  // module-wide (PR #316 review, finding 7).
  assert.throws(() => {
    (DEFAULT_UPLOAD_CAPS as { maxPartBytes: number }).maxPartBytes = 1;
  }, TypeError);
  const fallback = capsFromServer({}); // a malformed body → the fallback path
  assert.notEqual(fallback, DEFAULT_UPLOAD_CAPS, "a fresh object, not the shared one");
  assert.deepEqual(fallback, DEFAULT_UPLOAD_CAPS, "…with the same values");
  fallback.maxPartBytes = 1; // owned by the caller, so this is legal…
  assert.equal(DEFAULT_UPLOAD_CAPS.maxPartBytes, 104_857_600, "…and does not leak");
});

test("capsFromServer maps the wire caps onto the pre-flight caps", () => {
  assert.deepEqual(
    capsFromServer({ max_part_bytes: 7, max_bundle_bytes: 8, max_entries: 9 }),
    { maxPartBytes: 7, maxBundleBytes: 8, maxEntries: 9 },
  );
});

test("capsFromServer degrades to the defaults unless ALL THREE caps are usable numbers", () => {
  // A resolved-but-wrong body is the dangerous case: a blind copy puts `undefined` into
  // a cap, every `length > undefined` is NaN → false, and the count check is silently
  // disabled. Each of these must fall back rather than half-adopt.
  const unusable: unknown[] = [
    {}, // a 200 from a cache/proxy with an empty body
    { max_bundle_bytes: 8, max_entries: 9 }, // one field missing (or renamed)
    { max_part_bytes: 7, max_bundle_bytes: 8 }, // the last field missing
    { max_part_bytes: null, max_bundle_bytes: 8, max_entries: 9 },
    { max_part_bytes: "7", max_bundle_bytes: 8, max_entries: 9 }, // stringified number
    { max_part_bytes: 0, max_bundle_bytes: 8, max_entries: 9 }, // a zero cap blocks all
    { max_part_bytes: -1, max_bundle_bytes: 8, max_entries: 9 },
    { max_part_bytes: Number.NaN, max_bundle_bytes: 8, max_entries: 9 },
    { max_part_bytes: Number.POSITIVE_INFINITY, max_bundle_bytes: 8, max_entries: 9 },
    null, // a literal `200 null` body
    undefined,
  ];
  for (const body of unusable) {
    assert.deepEqual(
      capsFromServer(body),
      DEFAULT_UPLOAD_CAPS,
      `expected the fallback for ${JSON.stringify(body) ?? String(body)}`,
    );
  }
  // …and the observable consequence, not just the returned object: a body carrying ONE
  // usable ceiling must not have that ceiling applied. A half-adopting `capsFromServer`
  // would refuse this 4 KiB selection against the 8-byte `max_bundle_bytes` below; the
  // all-or-nothing one accepts it, because a body missing a field is a body to distrust.
  const partial = capsFromServer({ max_part_bytes: 7, max_bundle_bytes: 8 });
  assert.equal(partial.maxBundleBytes, null, "the 8-byte ceiling was not half-adopted");
  assert.equal(preflightCaps([part("a.png", 4096)], partial).ok, true);
});

test("preflightCaps ACCEPTS under a raised server cap what a smaller one refuses", () => {
  // Seam A2's property: the DEPLOYMENT's number is the one enforced, and raising it
  // reaches the browser. Both halves are now served, because since seam L1 the fallback
  // states no byte ceiling for a raised one to be compared against — a spec written as
  // "refused by the fallback, accepted once raised" would be asserting the invention
  // this file exists to keep out.
  const selection = [part("a.png", 8192)];
  const tight = capsFromServer({ max_part_bytes: 1024, max_bundle_bytes: 4096, max_entries: 100 });
  assert.equal(preflightCaps(selection, tight).ok, false);
  const raised = preflightCaps(
    selection,
    capsFromServer({ max_part_bytes: 1024, max_bundle_bytes: 4096 * 8, max_entries: 100 }),
  );
  assert.equal(raised.ok, true);
  assert.equal(raised.message, null);
});

test("preflightCaps REFUSES under a lowered server cap what the fallback allows", () => {
  // The other direction, so the pin cannot pass by ignoring the argument: a selection the
  // fallback accepts is refused once the server says its ceilings are smaller.
  const modest = [part("a.png", 4096), part("b.png", 4096)];
  assert.equal(preflightCaps(modest).ok, true);
  const served = capsFromServer({ max_part_bytes: 1024, max_bundle_bytes: 1024, max_entries: 9 });
  const lowered = preflightCaps(modest, served);
  assert.equal(lowered.ok, false);
  assert.match(lowered.message ?? "", /bundle limit/);
});

// The two specs below isolate ONE branch each, so a regression that reads
// DEFAULT_UPLOAD_CAPS.maxEntries/.maxBundleBytes inside preflightCaps instead of the
// argument cannot hide behind the other branch firing first (PR #316 review, finding 3).

test("preflightCaps refuses on a lowered server ENTRY-COUNT cap (no part breaches it)", () => {
  const many = [part("a.png", 10), part("b.png", 10), part("c.png", 10)];
  assert.equal(preflightCaps(many).ok, true, "well inside the compiled-in defaults");
  const served = capsFromServer({
    max_part_bytes: 1_000_000, // not a pre-flight lever since A3; the transport's chunk size
    max_bundle_bytes: 1_000_000, // 33_000x the total — the bundle branch cannot fire
    max_entries: 2, // 3 parts > 2
  });
  const refused = preflightCaps(many, served);
  assert.equal(refused.ok, false);
  assert.match(refused.message ?? "", /2-file limit/);
});

test("preflightCaps refuses on a lowered server BUNDLE-BYTE cap (no part breaches it)", () => {
  const parts = [part("a.png", 100), part("b.png", 100), part("c.png", 100)]; // 300 total
  assert.equal(preflightCaps(parts).ok, true, "the fallback states no byte ceiling at all");
  const served = capsFromServer({
    max_part_bytes: 1000, // not a pre-flight lever since A3; the transport's chunk size
    max_entries: 100, // 33x the count — the entry branch cannot fire
    max_bundle_bytes: 200, // 300 > 200
  });
  const refused = preflightCaps(parts, served);
  assert.equal(refused.ok, false);
  assert.match(refused.message ?? "", /bundle limit/);
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
