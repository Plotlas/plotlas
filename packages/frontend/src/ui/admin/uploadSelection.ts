// Upload selection normalization + pre-flight caps (Seam O4). Pure, framework-free,
// node-test importable (no DOM, no React) — the wizard's browser adapters (folder
// picker, drag-drop) hand raw files in and this classifies/dedupes/validates them.
//
// The D-25 model is "one image = one part, addressed by BASENAME"; the server rejects
// duplicate basenames and extracts .zip parts server-side (D-27). So this module:
//   - flattens folder selections (webkitRelativePath) to basenames,
//   - dedupes same-basename images/zips client-side (the server would 400 them),
//   - splits out a single metadata CSV/TSV (kept in the wizard's own field),
//   - refuses a selection that breaches the upload caps BEFORE the first byte, and
//   - fingerprints a selection (name+size) so a persisted session can tell whether the
//     re-selected files are the same bundle (resume) or a different one (fresh).
//
// Fingerprint + caps are name+size only — NO content hashing (operator decision
// 2026-07-12: name+size is the default; client hashing is a later opt-in tier).

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

/** The upload resource caps.
 *
 *  ⚠️ These MIRROR the interface-catalogue defaults; they are NOT read from the server.
 *  No endpoint exposes the (env-tunable) server caps today — an exposed-caps route is a
 *  one-line O2 follow-up (tracked). Until then a deployment that RAISES its caps will see
 *  the client refuse early against these defaults; one that LOWERS them still gets a
 *  server-side 413 (the pre-flight is an early-and-friendly check, never the authority). */
export interface UploadCaps {
  maxPartBytes: number; // MAX_UPLOAD_PART_BYTES — per part (a .zip caps its COMPRESSED bytes)
  maxBundleBytes: number; // MAX_UPLOAD_BUNDLE_BYTES — whole-bundle uncompressed ceiling
  maxEntries: number; // MAX_UPLOAD_ENTRIES — whole-bundle file-count ceiling
}

export const DEFAULT_UPLOAD_CAPS: UploadCaps = {
  maxPartBytes: 104_857_600, // 100 MiB
  maxBundleBytes: 2_147_483_648, // 2 GiB
  maxEntries: 250_000,
};

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

/** Refuse an over-cap selection BEFORE the first byte, with a clear "split it or shrink
 *  it" message (spike §6.5) — instead of the user discovering it via a mid-upload 413.
 *
 *  Caveat honored: a .zip part's EXTRACTED entry count and uncompressed bytes are unknown
 *  client-side (`ZipInfo` can lie — D-27), so .zip parts are checked only against the
 *  per-part COMPRESSED ceiling here; their contribution to the entry-count and bundle-byte
 *  caps is enforced server-side as the bytes arrive. Plain image parts are fully checked. */
export function preflightCaps<T extends SelectionFile>(
  parts: readonly SelectionPart<T>[],
  caps: UploadCaps = DEFAULT_UPLOAD_CAPS,
): CapsCheck {
  const oversize = parts.filter((p) => p.size > caps.maxPartBytes);
  if (oversize.length > 0) {
    const limit = formatBytes(caps.maxPartBytes);
    const message =
      oversize.length === 1
        ? `"${oversize[0].name}" is ${formatBytes(oversize[0].size)}, over the ${limit} per-file limit. Remove or shrink it.`
        : `${oversize.length} files are over the ${limit} per-file limit. Remove or shrink them.`;
    return { ok: false, message };
  }

  // Entry-count + bundle-byte caps: plain parts only (a .zip's entries are server-counted).
  const plain = parts.filter((p) => !p.isZip);
  if (plain.length > caps.maxEntries) {
    return {
      ok: false,
      message: `${plain.length.toLocaleString()} files exceeds the ${caps.maxEntries.toLocaleString()}-file limit. Split the upload into smaller batches, or use the CLI for very large corpora.`,
    };
  }
  const bundleBytes = plain.reduce((sum, p) => sum + p.size, 0);
  if (bundleBytes > caps.maxBundleBytes) {
    return {
      ok: false,
      message: `The selection totals ${formatBytes(bundleBytes)}, over the ${formatBytes(caps.maxBundleBytes)} bundle limit. Split it into smaller uploads, or use the CLI for very large corpora.`,
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
