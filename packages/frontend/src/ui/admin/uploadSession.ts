// Persisted upload session (Seam O4). The wizard's upload_id lived only in useState, so
// a refresh mid-upload orphaned the server-side bundle (spike §4/§6.1). This persists the
// identity needed to RESUME: the open session id, a name+size fingerprint of the
// selection, and a short description of what was being uploaded — so on the next mount
// the wizard can offer "resume where you left off" and confirm the re-selected files are
// the same bundle. Cleared on finalize/discard. Mirrors the activityStore localStorage
// pattern (pure serialize/parse that never throws; guarded I/O; browser-global key like
// the token/activity keys).
//
// Seam L3 (D-xxviii): resume is keyed on the UPLOAD. It used to carry the dataset id the
// user typed before the first byte moved, and the banner named that id; the intake no
// longer asks for one (the API mints it at create, after the upload), so there is no id
// at this point to persist or to show. The banner describes the upload instead. A record
// written before this change still parses — its `datasetId` is simply ignored.
//
// Node-test importable (pure serialize/parse; load/save take an injectable storage).

/** What we persist to resume an interrupted upload. Only IDENTITY + a change-detector —
 *  never file contents (the browser cannot restore File objects across a refresh; the
 *  user re-selects, and the fingerprint tells us if it is the same bundle). */
export interface PersistedUploadSession {
  uploadId: string;
  /** name+size fingerprint of the selection (uploadSelection.fingerprintFiles) — NOT a
   *  content hash. Matches ⇒ resume; differs ⇒ offer a fresh session. */
  fingerprint: string;
  /** What was being uploaded, for the resume banner: the selection's part count and
   *  bytes when the session opened. 0 when unknown (a record from before seam L3). */
  fileCount: number;
  totalBytes: number;
}

/** The resume banner's description of an interrupted upload — "12 files, 3.4 MiB" — or
 *  null when the record predates it and nothing is known. */
export function describeUploadSession(
  session: PersistedUploadSession,
  formatBytes: (bytes: number) => string,
): string | null {
  if (session.fileCount <= 0) return null;
  const files = `${session.fileCount} file${session.fileCount === 1 ? "" : "s"}`;
  return session.totalBytes > 0 ? `${files}, ${formatBytes(session.totalBytes)}` : files;
}

/** Browser-GLOBAL key (like `plotlas.token` / `plotlas.activity` in App.tsx). The
 *  session is single-flight per browser — one create wizard at a time — so one slot is
 *  enough; a fresh login/logout clears it alongside the token (see App.tsx). */
export const UPLOAD_SESSION_STORAGE_KEY = "plotlas.upload-session";

/** Serialize a session for localStorage. */
export function serializeUploadSession(session: PersistedUploadSession): string {
  return JSON.stringify({
    uploadId: session.uploadId,
    fingerprint: session.fingerprint,
    fileCount: session.fileCount,
    totalBytes: session.totalBytes,
  });
}

/** A non-negative whole count from storage, else 0. */
function countFrom(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Parse a persisted session; null on any malformed/absent input (never throws — a corrupt
 *  entry must not brick the wizard). A blank uploadId is treated as absent. */
export function parseUploadSession(raw: string | null): PersistedUploadSession | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const uploadId = (parsed as { uploadId?: unknown }).uploadId;
    const fingerprint = (parsed as { fingerprint?: unknown }).fingerprint;
    if (typeof uploadId !== "string" || uploadId === "") return null;
    return {
      uploadId,
      fingerprint: typeof fingerprint === "string" ? fingerprint : "",
      fileCount: countFrom((parsed as { fileCount?: unknown }).fileCount),
      totalBytes: countFrom((parsed as { totalBytes?: unknown }).totalBytes),
    };
  } catch {
    return null;
  }
}

/** A minimal Storage surface (browser `localStorage` satisfies it; tests pass a fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access can throw (sandboxed iframe etc.)
  }
}

/** Load the persisted session (null when absent/malformed/unavailable). */
export function loadUploadSession(store: KeyValueStore | null = defaultStore()): PersistedUploadSession | null {
  if (store === null) return null;
  try {
    return parseUploadSession(store.getItem(UPLOAD_SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Persist the session (best-effort; storage-unavailable is a no-op, uploads still work). */
export function saveUploadSession(
  session: PersistedUploadSession,
  store: KeyValueStore | null = defaultStore(),
): void {
  if (store === null) return;
  try {
    store.setItem(UPLOAD_SESSION_STORAGE_KEY, serializeUploadSession(session));
  } catch {
    // Storage full / unavailable — resume-after-refresh is lost, the upload is not.
  }
}

/** Clear the persisted session (on finalize or discard). */
export function clearUploadSession(store: KeyValueStore | null = defaultStore()): void {
  if (store === null) return;
  try {
    store.removeItem(UPLOAD_SESSION_STORAGE_KEY);
  } catch {
    // Ignore — nothing actionable.
  }
}
