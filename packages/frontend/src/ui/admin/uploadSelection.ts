// Upload selection normalization + pre-flight caps (Seam O4). Pure, framework-free,
// node-test importable (no DOM, no React) — the wizard's browser adapters (folder
// picker, drag-drop) hand raw files in and this classifies/dedupes/validates them.
//
// The D-25 model is "one image = one part, addressed by BASENAME"; the server rejects
// duplicate basenames and extracts .zip parts server-side (D-27). So this module:
//   - flattens folder selections (webkitRelativePath) to basenames,
//   - dedupes same-basename images/zips client-side (the server would 400 them),
//   - splits out a single metadata CSV/TSV (kept in the wizard's own field),
//   - refuses a selection that breaches the WHOLE-BUNDLE caps BEFORE the first byte (a
//     file over the per-request cap is chunked by the transport, not refused — A3), and
//   - fingerprints a selection (name+size) so a persisted session can tell whether the
//     re-selected files are the same bundle (resume) or a different one (fresh).
//
// Fingerprint + caps are name+size only — NO content hashing (operator decision
// 2026-07-12: name+size is the default; client hashing is a later opt-in tier).
//
// No import of the api-client's wire type: `capsFromServer` takes `unknown` (a raw,
// unvalidated JSON body), so this module stays free of api-client coupling as well as
// framework-free.

/** The minimal shape this module reads from a file. Browser `File` satisfies it
 *  structurally (`webkitRelativePath` is always present, "" when not a folder pick),
 *  and tests can pass plain objects — so the normalization is unit-tested without a DOM. */
export interface SelectionFile {
  name: string;
  size: number;
  webkitRelativePath?: string;
}

/** The pipeline's image whitelist, mirrored client-side (the frontend never imports
 *  pipeline/api). Kept in sync with the API's ZIP-extract whitelist
 *  (routers/uploads.py: `.png .jpg .jpeg .webp .gif .bmp .tif .tiff`). Lower-case,
 *  leading dot. Drag-drop bypasses the `<input accept>` filter, so this is the real gate. */
export const IMAGE_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
];

/** The upload resource caps this deployment enforces. */
export interface UploadCaps {
  // MAX_UPLOAD_PART_BYTES — per REQUEST, not per file: since Seam A3 the client sends a
  // larger file as chunks of this size rather than refusing it, so this is the transport's
  // chunk size (`client.uploadPartWithProgress`) and NOT a pre-flight refusal.
  maxPartBytes: number;
  // MAX_UPLOAD_BUNDLE_BYTES — the whole-bundle uncompressed ceiling this deployment
  // ADVERTISES, or `null` when it has not advertised one. `null` means "no client-side
  // byte check", never "zero" and never "not filled in yet": since Seam L1 the server's
  // bundle bound is live free disk on the upload jail's filesystem, and free disk is not
  // a number a client can hold — it moves between the caps read and the last byte.
  maxBundleBytes: number | null;
  maxEntries: number; // MAX_UPLOAD_ENTRIES — whole-bundle file-count ceiling
}

/** The FALLBACK caps, mirroring the server's own compiled-in defaults.
 *
 *  Seam A2: the live caps now come from `GET /api/uploads/caps` (`capsFromServer`
 *  below), so a deployment that RAISES a cap is honoured by the pre-flight. These
 *  values are what stands in when that read has not landed yet, failed, or came back
 *  200 with a body that is not three usable numbers — a caps fetch that does not
 *  produce real caps must degrade, never block an upload. Either way the server
 *  remains the authority: the pre-flight is an early-and-friendly check, and a
 *  selection that slips past it still meets a server-side 413.
 *
 *  **`maxBundleBytes` is `null`, and that is the honest value rather than a gap.** It
 *  held 2 GiB, which mirrored the `_DEFAULT_MAX_BUNDLE_BYTES` the server compiled in.
 *  Seam L1 deleted that constant: the bundle is now bounded by free disk, with
 *  MAX_UPLOAD_BUNDLE_BYTES surviving as an optional operator policy ceiling that is
 *  unset by default. So there is no server-side number left to mirror, and a client
 *  cannot compute the one that replaced it. Any figure written here would be invented —
 *  and an invented one does not merely mislead, it REFUSES: `preSubmitProblem` gates
 *  submit on this check, so the 2 GiB left behind blocked every selection between 2 GiB
 *  and free disk that the server would have accepted (PR review of seam L1, finding 6).
 *  That is the exact inverse of "degrade, never block", so the fallback states what it
 *  actually knows: nothing.
 *
 *  The other two are untouched because they are still real compiled-in server defaults
 *  (`api/routers/uploads.py`: `_DEFAULT_MAX_PART_BYTES`, `_DEFAULT_MAX_ENTRIES`) —
 *  mirroring a constant the server does have is not inventing one. `maxEntries` moved
 *  250,000 → 1,000,000 with the server's, for the same reason the byte one had to go:
 *  left behind, it would refuse every selection of 250,001–1,000,000 files that the
 *  server accepts.
 *
 *  FROZEN because one object serves as the fallback for the whole session — it is
 *  `preflightCaps`'s default argument, the wizard's initial `useState` value, and
 *  `capsFromServer`'s fallback source. A single consumer treating it as owned would
 *  otherwise rewrite the fallback module-wide; now the attempt throws (modules are
 *  strict mode) instead of corrupting every later caps read. */
export const DEFAULT_UPLOAD_CAPS: UploadCaps = Object.freeze({
  maxPartBytes: 104_857_600, // 100 MiB — _DEFAULT_MAX_PART_BYTES
  maxBundleBytes: null, // no compiled-in server ceiling to mirror; the bound is free disk
  maxEntries: 1_000_000, // _DEFAULT_MAX_ENTRIES (the PRD's own 1M target)
});

/** Read one cap off a raw wire body. Usable only if it is a finite POSITIVE number:
 *  anything else — a missing or renamed field, a null, a string, a 0/negative, an
 *  Infinity — would make every `size > cap` comparison in preflightCaps NaN-false and
 *  so silently disable the ENTIRE pre-flight, accepting a selection the server will
 *  413 mid-transfer. */
function readCap(source: unknown, key: string): number | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Map the server's caps response onto the pre-flight's caps — the one place the
 *  snake_case wire names meet the client's. Kept here (not in the wizard) so the
 *  module stays the single owner of the caps shape and stays unit-testable.
 *
 *  The parameter is `unknown` ON PURPOSE. It is a raw JSON body that no runtime
 *  validation has touched (`ApiClient.getUploadCaps` casts, as every client method
 *  does), so annotating it `UploadCapsResponse` would tell the next reader the input
 *  is already trusted and invite them to delete the guards below — which are the whole
 *  malformed-200 defence. Typed `unknown`, the guards are load-bearing per the type
 *  system and callers need no casts to test the hostile cases.
 *
 *  ALL-OR-NOTHING, and deliberately so: a 200 whose body is not three usable numbers
 *  (an intermediary cache, an older API build, a later field rename) degrades to
 *  DEFAULT_UPLOAD_CAPS — the SAME fallback a failed read takes. Trusting a partial
 *  body would be strictly WORSE than a rejection: an `undefined` cap disables the
 *  ENTRY check (every `length > undefined` is NaN-false) rather than tightening it, and
 *  it needs no server bug to happen. Note which way that fallback leans: it drops the
 *  bundle-byte check (`DEFAULT_UPLOAD_CAPS.maxBundleBytes` is null) rather than imposing
 *  a guessed ceiling, so an unreadable caps route costs the user the EARLY "no" it would
 *  have given them, and never gives them a wrongful one.
 *
 *  Returns a fresh object even on the fallback path, so no caller can mutate the
 *  shared constant out from under every other consumer. */
export function capsFromServer(caps: unknown): UploadCaps {
  const maxPartBytes = readCap(caps, "max_part_bytes");
  const maxBundleBytes = readCap(caps, "max_bundle_bytes");
  const maxEntries = readCap(caps, "max_entries");
  if (maxPartBytes === null || maxBundleBytes === null || maxEntries === null) {
    return { ...DEFAULT_UPLOAD_CAPS };
  }
  return { maxPartBytes, maxBundleBytes, maxEntries };
}

/** One classified part to upload, carrying the byte-accounting the transport + caps need. */
export interface SelectionPart<T extends SelectionFile> {
  file: T;
  name: string; // flattened basename (upload placement name)
  size: number;
  isZip: boolean; // a .zip is extracted server-side (D-27); its entries/bytes are server-checked
}

/** The result of classifying the IMAGES drop-zone selection (images + .zip archives).
 *  The metadata CSV/TSV is handled by the wizard's separate field, not here. */
export interface ImageSelection<T extends SelectionFile> {
  parts: SelectionPart<T>[]; // deduped, in first-seen order
  imageCount: number; // plain image parts (excludes .zip)
  zipCount: number;
  droppedDuplicates: string[]; // same-basename files dropped (kept the first), by basename
  ignored: string[]; // non-image / non-zip files dropped from the images zone, by basename
}

/** The flattened basename of a file — the last path segment of `webkitRelativePath`
 *  (folder pick) or of `name`, with either separator style. */
export function basenameOf(file: SelectionFile): string {
  const raw =
    file.webkitRelativePath !== undefined && file.webkitRelativePath !== ""
      ? file.webkitRelativePath
      : file.name;
  const normalized = raw.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function hasExtension(lowerName: string, extensions: readonly string[]): boolean {
  return extensions.some((ext) => lowerName.endsWith(ext));
}

/** Classify + dedupe an images-zone selection. Non-image/non-zip files are ignored
 *  (reported), same-basename duplicates are dropped keeping the first (the server would
 *  400 a duplicate basename), and .zip archives are flagged (server-extracted). */
export function buildImageSelection<T extends SelectionFile>(files: readonly T[]): ImageSelection<T> {
  const parts: SelectionPart<T>[] = [];
  const seen = new Set<string>();
  const droppedDuplicates: string[] = [];
  const ignored: string[] = [];
  let imageCount = 0;
  let zipCount = 0;

  for (const file of files) {
    const name = basenameOf(file);
    const lower = name.toLowerCase();
    const isZip = lower.endsWith(".zip");
    const isImage = hasExtension(lower, IMAGE_EXTENSIONS);
    if (!isZip && !isImage) {
      ignored.push(name);
      continue;
    }
    if (seen.has(lower)) {
      droppedDuplicates.push(name);
      continue;
    }
    seen.add(lower);
    parts.push({ file, name, size: file.size, isZip });
    if (isZip) zipCount += 1;
    else imageCount += 1;
  }

  return { parts, imageCount, zipCount, droppedDuplicates, ignored };
}

export interface CapsCheck {
  ok: boolean;
  message: string | null; // a user-facing "why + what to do" line when !ok
}

/** Human-readable bytes (binary units), for cap messages + the progress readout. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Refuse a selection the SERVER will refuse, before the first byte — instead of the
 *  user discovering it via a mid-upload 413.
 *
 *  **There is deliberately no per-file check here any more.** `maxPartBytes` bounds one
 *  REQUEST, not one file: Seam A3's transport sends a part larger than the cap as a
 *  sequence of byte-range appends, so an over-cap file is no longer a refusal at all
 *  and the old *"Remove or shrink it"* was about to become a lie in the opposite
 *  direction — telling a user to delete a file the product can now happily accept.
 *  A part that still meets a server-side 413 (a deployment whose caps this client could
 *  not read, so it did not chunk) surfaces as one isolated per-file failure in the
 *  transport's end-of-run report, which is the documented degrade: the pre-flight is an
 *  early-and-friendly check and the server is always the authority.
 *
 *  What remains are the WHOLE-BUNDLE ceilings, which chunking does not move — they are
 *  cumulative across the entire session, so splitting a corpus into more files, more
 *  archives or more chunks buys nothing against them
 *  (`docs/design/LIMITS_REGISTER.md` §2). The messages say so, and name who can lift
 *  them, because the person refused here is not the person who can.
 *
 *  **The byte ceiling runs only when the deployment stated one** (`maxBundleBytes !==
 *  null`). Seam L1 made the server's bundle bound live free disk, so with no served caps
 *  there is no ceiling to compare against and this check is SKIPPED rather than run
 *  against a stand-in: the whole value of a pre-flight refusal is that it predicts a
 *  server refusal, and a number the server does not hold predicts nothing. It refuses
 *  real selections instead — see DEFAULT_UPLOAD_CAPS. The entry count is different: the
 *  server still compiles in MAX_UPLOAD_ENTRIES, so the fallback can mirror it and the
 *  count check always runs.
 *
 *  Caveat honored: a .zip part's EXTRACTED entry count and uncompressed bytes are unknown
 *  client-side (`ZipInfo` can lie — D-27), so .zip parts are excluded from both sums and
 *  their contribution is enforced server-side as the bytes arrive. Plain image parts are
 *  fully checked. */
export function preflightCaps<T extends SelectionFile>(
  parts: readonly SelectionPart<T>[],
  caps: UploadCaps = DEFAULT_UPLOAD_CAPS,
): CapsCheck {
  // Entry-count + bundle-byte caps: plain parts only (a .zip's entries are server-counted).
  const plain = parts.filter((p) => !p.isZip);
  if (plain.length > caps.maxEntries) {
    return {
      ok: false,
      message: `${plain.length.toLocaleString()} files exceeds the ${caps.maxEntries.toLocaleString()}-file limit for one upload. This is a whole-bundle ceiling — splitting the files across more archives or more uploads to the same dataset does not raise it. Use the CLI for a larger corpus, or ask your operator to raise MAX_UPLOAD_ENTRIES.`,
    };
  }
  const bundleBytes = plain.reduce((sum, p) => sum + p.size, 0);
  if (caps.maxBundleBytes !== null && bundleBytes > caps.maxBundleBytes) {
    // The remedy names both possibilities because the client cannot tell them apart, and
    // "raise MAX_UPLOAD_BUNDLE_BYTES" alone is now advice that can be useless: the served
    // number is that variable when an operator set one, and otherwise the TOTAL capacity
    // of the device the upload jail sits on (`_advertised_max_bundle_bytes`), which no
    // env var raises.
    return {
      ok: false,
      message: `The selection totals ${formatBytes(bundleBytes)}, over the ${formatBytes(caps.maxBundleBytes)} bundle limit this deployment advertises. This is a whole-bundle ceiling — splitting it into more files, more archives or more parts does not raise it. Use the CLI for a larger corpus, or ask your operator: the ceiling is either an explicit MAX_UPLOAD_BUNDLE_BYTES or the size of the disk the uploads land on.`,
    };
  }
  return { ok: true, message: null };
}

/** A stable name+size fingerprint of a selection (FNV-1a over the sorted, newline-joined
 *  "basename size" lines). Used ONLY to decide whether a re-selection matches a persisted,
 *  interrupted session — a change-detector, deliberately order-independent, NOT a content
 *  hash and NOT a security primitive. */
export function fingerprintFiles(files: readonly SelectionFile[]): string {
  const lines = files.map((f) => `${basenameOf(f)} ${f.size}`).sort();
  return fnv1aHex(lines.join("\n"));
}

/** 32-bit FNV-1a as 8 hex chars — a tiny, dependency-free stable string hash. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiply in 32-bit space (Math.imul keeps it exact).
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
