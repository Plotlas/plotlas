import { tableFromIPC } from "apache-arrow";
import type { Table } from "apache-arrow";
import type { LayoutManifest } from "../renderer/layout";
import type {
  AddLayoutsRequest,
  AddLayoutsResponse,
  CheckFile,
  CheckResponse,
  CreateDatasetRequest,
  CreateDatasetResponse,
  DatasetPresentation,
  DatasetSummary,
  JobStatus,
  LayoutInfo,
  LoginRequest,
  MetadataRow,
  SearchResponse,
  SignupRequest,
  TokenResponse,
  UploadFilesPage,
  UploadHandle,
  UploadSessionSummary,
  UploadStatus,
  UserInfo,
} from "./types";

export interface ApiClient {
  listDatasets(): Promise<DatasetSummary[]>;
  getDataset(dsId: string): Promise<DatasetSummary>;
  listLayouts(dsId: string): Promise<LayoutInfo[]>;
  getManifest(dsId: string, layoutId: string): Promise<LayoutManifest>;
  /** v2 (decision D-33): URL of a layout's whole spatial-tile-pyramid PMTiles
   *  container, HTTP-Range-read tile-by-tile ({z}/{x}/{y}) by the renderer's
   *  PMTiles client. Prefers the STATIC Caddy path once the manifest is cached
   *  (`{base}/datasets/{ds}/{pyramid.path}` — immutable, version-embedded), which
   *  matches production and skips the per-range FastAPI hop; falls back to the
   *  `GET /api/datasets/{ds}/pyramid/{layout_id}.pmtiles` route before the manifest
   *  is known. Replaces the v1 tileUrl/tileIndexUrl/atlasUrl helpers (the shared
   *  id-ordered atlas + per-LOD quadtree index are gone). */
  pyramidUrl(dsId: string, layoutId: string): string;
  /** v2 (decision D-33): URL of one cell's full-resolution DETAIL-tier original,
   *  addressed by DENSE cell id — the click-through preview source (replaces the v1
   *  atlas-crop preview). The extension comes from the layout's `detail.format`.
   *
   *  T2-80: composes the VERSIONED, immutable route
   *  `GET /api/datasets/{ds}/detail/v{N}/{cell_id}.{ext}` when the dataset's cached
   *  manifest declares a version-stamped detail block (its `detail.path_prefix` is
   *  `detail/v{N}/`, as the producer bakes it — `worker.py` writes
   *  `detail/v{dataset_version}/`), so the browser caches the original forever
   *  (PR #102 landed the immutable route; this realizes the win end-to-end). Falls
   *  back to the legacy un-versioned `GET /api/datasets/{ds}/detail/{cell_id}.{ext}`
   *  (short revalidated cache) when the prefix is the old un-stamped `detail/` shape
   *  or no manifest is cached — old manifests keep working. Like pyramidUrl/tagsUrl,
   *  it reads the manifest getManifest cached (the click-through path always has one
   *  open); before that it composes the legacy route. */
  detailUrl(dsId: string, cellId: number, ext: string): string;
  /** T2-26 (detail overlay): the STATIC Caddy-edge URL of a cell's detail-tier
   *  original — `{base}/datasets/{ds}/detail/v{N}/{id}.{ext}` — preferred once the
   *  manifest is cached. This is the DB-free `viz_ds`-cookie path (like pyramidUrl),
   *  so the renderer's overlay can BURST hundreds of per-cell fetches without paying
   *  the per-request SQLite user lookup the authed API detail route (`detailUrl`)
   *  costs. Mirrors pyramidUrl's structure: the static asset when the manifest is
   *  known — versioned (`detail/v{N}/`) or legacy un-stamped (`detail/`) prefix, both
   *  served statically behind the D-A cookie — and the authed API route as the
   *  pre-manifest fallback (never reached in the burst path). The extension comes
   *  from the cached manifest's `detail.format` (default webp). Unlike detailUrl,
   *  this NEVER targets the /api route once a manifest is cached (the whole point is
   *  the edge). */
  staticDetailUrl(dsId: string, cellId: number): string;
  /** T2-55: URL of a dataset's Library-card COVER — `GET /api/datasets/{ds}/cover`,
   *  the UNVERSIONED grid-pyramid z0 overview WebP the pipeline wrote. Auth-gated (like
   *  detail), so the card fetches it WITH the bearer header and wraps the blob in an
   *  object URL (a bare `<img src>` would 401). 404 when the dataset has no cover (baked
   *  before this feature) — the card then falls back to its flat surface block. A pure
   *  route builder; no manifest needed. */
  coverUrl(dsId: string): string;
  /** The identity-only bearer header set the client attaches to every request,
   *  exposed so the renderer's PMTiles range Source attaches the same token to its
   *  byte-range reads (the static Caddy path ignores it; the dev FastAPI fallback
   *  requires it). Read fresh per call so a token refresh is picked up. */
  authHeaders(): Record<string, string>;
  /** T2-09 residual (D-i addendum): re-issue the static-edge `viz_ds` cookie for
   *  `dsId` by re-opening its manifest. The edge gate (Caddy forward_auth, D-A)
   *  hands the browser a 1-hour dataset-scoped HttpOnly cookie on every authed
   *  manifest GET; on a stale tab (>1h on one dataset with no re-open) that cookie
   *  expires and the renderer's static-edge fetches (PMTiles range reads, the tag
   *  sidecar) start 401ing. This performs the operator's "one request": a SINGLE
   *  authed `getManifest` for the current dataset — which re-issues the cookie —
   *  so the caller can retry its failed fetch ONCE. Resolves `true` when the
   *  credential was refreshed (retry may proceed), `false` when it was NOT (the
   *  per-dataset cooldown is still in effect, or no manifest has been opened for
   *  `dsId` yet, or the re-open itself failed) — in which case the caller must
   *  fall through to its normal failure path and NOT loop. CONCURRENT callers (a
   *  whole viewport of tiles expiring together) share ONE in-flight refresh keyed
   *  by dataset; the layout re-opened is the last one `getManifest` fetched for
   *  `dsId` (the cookie is dataset-scoped `{ds,sub,exp}`, so any layout refreshes
   *  it). Never throws — a failed re-open resolves `false`. */
  refreshDatasetCredential(dsId: string): Promise<boolean>;
  /** Version-stamped URL for the tag sidecar (decision D-14); throws if the
   *  manifest declares no `tags` entry. */
  tagsUrl(dsId: string, version: number): string;
  /** T2-66 / T2-48 (v2.2): the static-edge URL of a LAYOUT's position table
   *  (`layoutEntry.positions_ref`, e.g. `positions/grid_v3.arrow`) — the per-cell
   *  id->(x,y,w,h) rects the renderer scans to pick a cell at ANY zoom. Composed
   *  from the manifest cached by getManifest (immutable, version-embedded static
   *  asset served by Caddy under `/datasets/{ds}/positions/...`, gated by the same
   *  D-A cookie). Returns null when the layout declares no `positions_ref` (a dataset
   *  baked before this MINOR) — the caller then skips loading and keeps fine-tier-only
   *  picking. Throws only if the manifest for `dsId` has not been fetched yet (the
   *  renderer's LayoutController.activate always fetches it first). */
  positionsUrl(dsId: string, layoutId: string): string | null;
  // Optional `signal`: a per-generation AbortSignal so a superseded position-table
  // fetch is CANCELLED on a layout/dataset change instead of running to completion.
  //
  // MEMOIZED per `url`, BOUNDED TO ONE ENTRY (the #99 lesson): the client is
  // app-lifetime, and a position table is only ever wanted for the current layout, so
  // a request for a different url releases the prior entry rather than retaining every
  // browsed layout's decoded Table (up to ~16 MB each at 1M). Concurrent callers of
  // the SAME url share one in-flight promise (one network fetch); a rejected fetch is
  // evicted so a retry re-issues (failures are not cached); a `signal` bypasses the
  // cache entirely (a caller's abort must not cancel another's shared read). The
  // static-edge fetch is cookie-gated, so a stale-tab 401 triggers the SAME
  // single-flight credential-refresh-then-retry-once path fetchTags uses. */
  fetchPositions(url: string, signal?: AbortSignal): Promise<Table>; // decoded (x,y,w,h) table
  // Optional `signal`: a per-generation AbortSignal so a superseded tag fetch is
  // CANCELLED on a layout/dataset change instead of running to completion.
  //
  // MEMOIZED per `url`, bounded to the CURRENT sidecar (T2-43): the two consumers
  // race at dataset-open — the UI shell (TagControls) and the renderer's
  // LayoutController both fetch the same version-stamped `tags/tags_v{version}
  // .arrow`. A single in-flight promise is shared by concurrent callers and its
  // resolved Table is reused, so the sidecar downloads ONCE. The key is the
  // composed URL, which embeds the dataset id and the tags version — a dataset
  // switch or version bump keys a fresh URL and thus re-fetches (natural
  // invalidation). The cache holds AT MOST ONE url (the most-recent): the two
  // consumers only ever want the current dataset's sidecar and the client is
  // app-lifetime, so retaining prior datasets' decoded Tables would pin tens of MB
  // per browsed dataset for nothing — a new url releases the old entry. Only the
  // un-signalled call path is cached; an aborted fetch is evicted so a later call
  // retries (failures are not cached), and passing a `signal` bypasses the cache
  // entirely (one caller's abort must not cancel the other's shared read — the
  // signalled path is the superseded-generation cancellation case, never shared).
  fetchTags(url: string, signal?: AbortSignal): Promise<Table>; // decoded id -> tags table
  getMetadata(dsId: string, ids: number[]): Promise<MetadataRow[]>; // <= 250 ids
  /** T2-57: GET /api/datasets/{ds}/search — importance-ranked cell search. `fields`
   *  "default" (tier-0: id/filename/title/categoricals — cheap, run on debounced
   *  keystroke) or "all" (the tier-2 catch-all over every scalar column incl. the
   *  description — run on Enter). Returns capped, importance-ordered hits + a `capped`
   *  flag (the "N of many" signal). Visibility-scoped server-side (D-34): a private
   *  dataset the caller cannot read 404s. `q` is URL-encoded; the caller debounces. */
  search(dsId: string, q: string, fields?: "default" | "all", limit?: number): Promise<SearchResponse>;
  createDataset(req: CreateDatasetRequest): Promise<CreateDatasetResponse>;
  /** POST /api/datasets/{ds_id}/layouts (T2-58) — bake ADDITIONAL layouts onto a
   *  committed dataset the caller owns (no full re-ingest). 403 not-owner /
   *  unowned-with-hint, 404 unknown, 409 while a job runs OR no finalized upload
   *  bundle (add-layouts needs the original images), 422 empty specs — all surface as
   *  ApiError with the server's detail. Returns the started job id. */
  addLayouts(dsId: string, req: AddLayoutsRequest): Promise<AddLayoutsResponse>;
  getJob(jobId: string): Promise<JobStatus>;
  /** Auth (added at seam-12 pre-flight, 2026-06-12 — the catalogued client had
   *  no way to obtain the token it attaches). signup/login take no bearer;
   *  login's TokenResponse feeds the getToken closure the caller owns. */
  signup(req: SignupRequest): Promise<UserInfo>;
  login(req: LoginRequest): Promise<TokenResponse>;
  me(): Promise<UserInfo>;
  // ---- seam-12 additions (brief §2 route coverage: "datasets incl. DELETE",
  // "uploads incl. ZIP parts"). The catalogued ApiClient predates the delete and
  // upload routes; the admin surface drives them, and the client is the ONLY
  // network path (§1.3), so they live here. Flagged for the catalogue. ----
  /** DELETE /api/datasets/{ds_id} → 204. 403 not-owner, 404 unknown, and the
   *  409-while-running all surface as ApiError with the server's detail. */
  deleteDataset(dsId: string): Promise<void>;
  /** PATCH /api/datasets/{ds_id}/presentation — set the collection's display name
   *  and/or attribution (Part B). Owner-only: 403 not-owner, 404 unknown to
   *  app-state, 422 too long. PARTIAL BY KEY PRESENCE — an omitted key is left
   *  untouched, a key present as null or "" CLEARS it (so a bad name is always
   *  recoverable). Presentation only: `dataset_id` never changes, so a rename cannot
   *  break a shared deep link. Returns the values AS STORED (trimmed). */
  setDatasetPresentation(
    dsId: string,
    patch: { display_name?: string | null; attribution?: string | null; attribution_url?: string | null },
  ): Promise<DatasetPresentation>;
  /** POST /api/uploads — open an upload session in the caller's jail. */
  createUpload(): Promise<UploadHandle>;
  /** POST /api/uploads/{id}/parts (multipart field "part"). A `.zip` part is
   *  extracted server-side (D-27); cap breaches surface as 413 ApiError. The simple
   *  fetch primitive (no upload-progress events) — the wizard uses
   *  uploadPartWithProgress; kept for callers that don't need byte progress. */
  uploadPart(uploadId: string, part: File): Promise<UploadStatus>;
  /** Seam O4: the SAME POST /api/uploads/{id}/parts as uploadPart, over XMLHttpRequest so
   *  the upload can emit byte-level progress (fetch exposes no upload-progress events).
   *  `onProgress` fires with (loadedBytes, totalBytes) as the part streams; `signal`
   *  aborts the in-flight part (cancel / unmount). A 200 with `already_present` (an
   *  idempotent re-send the server already holds) resolves normally; every non-2xx throws
   *  the same typed ApiError as the fetch paths (so 409 mismatch / 413 cap surface their
   *  detail). Bearer auth is attached exactly as the fetch client does (authHeaders). */
  uploadPartWithProgress(
    uploadId: string,
    part: File,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadStatus>;
  /** POST /api/uploads/{id}/finalize — seal the bundle for ingest. */
  finalizeUpload(uploadId: string): Promise<UploadHandle>;
  /** GET /api/uploads/{id} — parts/bytes/state of an open or finalized bundle. */
  getUploadStatus(uploadId: string): Promise<UploadStatus>;
  /** Seam O2/O4: GET /api/uploads — the caller's own upload sessions (owner-jailed;
   *  tally-backed). Used to CONFIRM a persisted session still exists (and is still open)
   *  before offering resume. */
  listUploads(): Promise<UploadSessionSummary[]>;
  /** Seam O2/O4: GET /api/uploads/{id}/files — the server's per-file manifest for a
   *  session (name/size/sha256/is_metadata), paginated (`limit` clamped to 10 000). */
  listUploadFiles(uploadId: string, limit?: number, offset?: number): Promise<UploadFilesPage>;
  /** Seam O2/O4: POST /api/uploads/{id}/check — the Immich-style pre-check. Given the
   *  re-selected files' {name, size} (no hash by default), returns which basenames are
   *  already present / needed / mismatched, so a resume sends only what the server lacks.
   *  Batch capped at 10 000 files/request server-side (413 beyond) — the caller chunks. */
  checkUploadFiles(uploadId: string, files: CheckFile[]): Promise<CheckResponse>;
}

/** Hard cap on ids per getMetadata call (decision D-13, mirrored from the API's
 *  METADATA_MAX_IDS). The client REJECTS larger batches (documented choice —
 *  reject, not chunk: a silent fan-out would hide the cap from the selection UI,
 *  which must tell the user "first 250 of N" instead). */
export const METADATA_MAX_IDS = 250;

/** T2-09 residual (D-i addendum): minimum wall-clock gap between static-edge
 *  credential refreshes for one dataset. The refresh is the loop-breaker: after a
 *  successful refresh, if a retried fetch STILL 401s (revoked access, wrong
 *  dataset, server trouble), refreshing again would tight-loop against a request
 *  that cannot succeed. This cooldown caps refreshes to one per this window per
 *  dataset, so a post-refresh 401 falls through to the normal failure path instead
 *  of re-refreshing. 30s comfortably exceeds a manifest round-trip while still
 *  re-arming quickly for a genuinely later expiry (the cookie lives 1 hour). */
export const CREDENTIAL_REFRESH_COOLDOWN_MS = 30_000;

/** Typed transport error: every non-2xx response is thrown as ApiError carrying
 *  the HTTP status and the server's `detail` message, so the UI renders real
 *  messages (409-while-running on delete, 413 upload caps, 401 → re-login). */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`API error ${status}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/** Structural ApiError check that works across module instances (components
 *  must not value-import this module just to instanceof-check an error). */
export function isApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { detail?: unknown }).detail === "string"
  );
}

/** Seam O4: an AbortError for a cancelled XHR upload (matches DOMException's `name` so
 *  the transport's retry classifier treats it as "do not retry", not a transport blip). */
function abortError(): Error {
  const err = new Error("upload aborted");
  err.name = "AbortError";
  return err;
}

/** Seam O4: turn a non-2xx XHR into the SAME typed ApiError the fetch paths throw —
 *  the server's `detail` parsed from the JSON body, falling back to the status text
 *  (mirrors `toApiError` for the XHR upload path). Status 0 ⇒ no response (network). */
function xhrError(xhr: XMLHttpRequest): ApiError {
  let detail = xhr.statusText || `HTTP ${xhr.status}`;
  try {
    const body: unknown = JSON.parse(xhr.responseText);
    if (isRecord(body) && typeof body.detail === "string") detail = body.detail;
    else if (typeof body === "string") detail = body;
  } catch {
    // Non-JSON error body: keep the status text.
  }
  return new ApiError(xhr.status, detail);
}

// ---------------------------------------------------------------------------
// Issue #4 — hand-written runtime validation of the fetched layout manifest
// against the schemas/v1.1/layout_manifest.schema.json contract. Deliberately
// NOT a JSON-schema library (no new dependency); the checks below mirror the
// schema's required fields, types, enums, and arities. Unknown extra keys are
// tolerated (the schema says additionalProperties:false, but rejecting extras
// buys the client nothing and would break on benign server-side additions);
// every other constraint is enforced and errors NAME the offending field.
// ---------------------------------------------------------------------------

// v2.4 (D-35 Seam G2): "geographic" joins the type enum (real-world lon/lat projected to
// a map — flows through the same generic render path as every other type).
const LAYOUT_TYPES = ["grid", "datetime", "categorical", "scatter", "geographic", "umap", "network", "custom"];
const TILE_PX_SIZES = [256, 512, 1024, 2048];
const PYRAMID_CONTAINERS = ["pmtiles"];
const DETAIL_MODES = ["image_ref", "pmtiles"];
const DETAIL_FORMATS = ["webp", "jpeg", "png"];
const DATETIME_FORMATS = ["iso8601", "unix_seconds", "unix_millis"];
// v2.3 (D-35 Seam G1): the scatter-knob echo values on layoutEntry.options.
const SCALE_VALUES = ["linear", "log"];
const NORMALIZE_VALUES = ["fit", "none"];
const OVERLAP_VALUES = ["overdraw", "jitter", "aggregate"];
// v2.4 (D-35 Seam G2): the geographic projection echo value on layoutEntry.options.
const PROJECTION_VALUES = ["equirectangular", "mercator"];
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function fail(field: string, reason: string): never {
  throw new Error(`layout manifest validation failed: ${field}: ${reason}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkString(v: unknown, field: string, opts?: { pattern?: RegExp; maxLength?: number }): string {
  if (typeof v !== "string" || v.length === 0) fail(field, "must be a non-empty string");
  if (opts?.maxLength !== undefined && v.length > opts.maxLength) {
    fail(field, `must be at most ${opts.maxLength} characters`);
  }
  if (opts?.pattern !== undefined && !opts.pattern.test(v)) {
    fail(field, `must match ${String(opts.pattern)}`);
  }
  return v;
}

function checkInt(v: unknown, field: string, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    fail(field, `must be an integer >= ${min}`);
  }
  return v;
}

function checkEnum<T>(v: unknown, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) {
    fail(field, `must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}; got ${JSON.stringify(v)}`);
  }
  return v as T;
}

/** An array of exactly `len` finite numbers each in [0, 1] — a normalized world box
 *  (bbox/extent, len 4) or interval (axis range, len 2). */
function checkUnitNumbers(v: unknown, field: string, len: number): void {
  if (!Array.isArray(v) || v.length !== len) {
    fail(field, `must be an array of exactly ${len} numbers in [0, 1]`);
  }
  (v as unknown[]).forEach((n, j) => {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
      fail(`${field}[${j}]`, "must be a number in [0, 1]");
    }
  });
}

/** v2.3/v2.4 (D-35 Seam G1/G2): the optional per-layout `options` echo of the baked
 *  layout-shaping knobs. Tolerant by design — absent is fine (a default bake), and any
 *  UNKNOWN key is ignored (forward-compat for future families); only the known scatter
 *  knobs and the geographic `projection` are range-checked when present. The renderer
 *  never branches on this — it is UI-explain / underlay-dispatch data — so a bad value is
 *  a validation error, not a silent misrender. */
function checkLayoutOptions(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  if (v.x_scale !== undefined) checkEnum(v.x_scale, `${field}.x_scale`, SCALE_VALUES);
  if (v.y_scale !== undefined) checkEnum(v.y_scale, `${field}.y_scale`, SCALE_VALUES);
  if (v.normalize !== undefined) checkEnum(v.normalize, `${field}.normalize`, NORMALIZE_VALUES);
  if (v.projection !== undefined) checkEnum(v.projection, `${field}.projection`, PROJECTION_VALUES);
  if (v.overlap !== undefined) checkEnum(v.overlap, `${field}.overlap`, OVERLAP_VALUES);
}

/** v2.5 (T2-69/T2-72 Seam 2): the optional per-layout `annotations` — a categorical
 *  layout's band `labels` and/or a datetime layout's `axes` domain. Tolerant like
 *  checkLayoutOptions: absent is valid (a layout with none, or a pre-2.5 bake), unknown
 *  keys are ignored (forward-compat), and each present field is range-checked. The
 *  overlay degrades gracefully on absence, so a malformed annotation is a NAMED
 *  validation error at the client boundary, not a silent misrender. */
function checkAnnotations(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  if (v.labels !== undefined) {
    if (!Array.isArray(v.labels)) fail(`${field}.labels`, "must be an array");
    v.labels.forEach((label, i) => {
      const lf = `${field}.labels[${i}]`;
      if (!isRecord(label)) fail(lf, "must be an object");
      // `text` MAY be "" (the missing bucket), so allow empty — not checkString.
      if (typeof label.text !== "string") fail(`${lf}.text`, "must be a string");
      checkUnitNumbers(label.extent, `${lf}.extent`, 4);
      checkInt(label.count, `${lf}.count`, 0);
      if (label.missing !== undefined && typeof label.missing !== "boolean") {
        fail(`${lf}.missing`, "must be a boolean");
      }
      if (label.priority !== undefined && typeof label.priority !== "number") {
        fail(`${lf}.priority`, "must be a number");
      }
    });
  }
  if (v.axes !== undefined) {
    if (!Array.isArray(v.axes)) fail(`${field}.axes`, "must be an array");
    v.axes.forEach((axis, i) => {
      const af = `${field}.axes[${i}]`;
      if (!isRecord(axis)) fail(af, "must be an object");
      // TOLERANT READER (PR-180 review; the schema's own version promise — "a v2-major
      // reader accepts any 2.MINOR"): `orientation`/`scale` are validated as non-empty
      // STRINGS, not closed enums. The closed enums remain the PRODUCER's write gate in
      // the schema; here an unknown value (a future minor's `scale: "linear"` for the
      // D-35 scatter/geo axes) must degrade to "that axis not drawn" — the consumer
      // filters for the pairs it understands (producerTimeAxis) — never to failing the
      // whole dataset open. Structural malformation (wrong type/arity) still fails loudly.
      checkString(axis.orientation, `${af}.orientation`);
      checkString(axis.scale, `${af}.scale`);
      if (!Array.isArray(axis.domain) || axis.domain.length !== 2) {
        fail(`${af}.domain`, "must be an array of exactly 2 datetime strings");
      }
      (axis.domain as unknown[]).forEach((d, j) => checkString(d, `${af}.domain[${j}]`));
      checkUnitNumbers(axis.range, `${af}.range`, 2);
      // v2.7 (T2-142 / D-36 seam H3): the bucketing rung the producer binned at. OPTIONAL
      // here for one reason only — a PRE-2.7 bake has none, and the overlay then keeps its
      // own years-only ladder. A fresh producer always writes it.
      //
      // Same tolerant-reader split as `scale` above: the STRUCTURE is strict (an object
      // carrying a non-empty string `kind` and an integer `step >= 1`), the VALUE SET is
      // open. A rung kind added by a later minor is PRESERVED, never a whole-dataset-open
      // failure — but unlike an unknown `scale` (which the consumer filters out, leaving the
      // axis undrawn), an unknown kind degrades EXACTLY as an ABSENT interval does: the axis
      // is still fully drawable from `domain`/`range`, so the consumer falls back to its
      // years-only ladder and still draws it. The closed `second|minute|hour|day|month|year`
      // enum stays the PRODUCER's write gate in the schema.
      if (axis.interval !== undefined) {
        if (!isRecord(axis.interval)) fail(`${af}.interval`, "must be an object");
        checkString(axis.interval.kind, `${af}.interval.kind`);
        checkInt(axis.interval.step, `${af}.interval.step`, 1);
      }
      if (typeof axis.label !== "string") fail(`${af}.label`, "must be a string");
    });
  }
}

/** {path, format:"arrow"} declarations: the manifest's `tags` and per-layout
 *  `edges` (both nullable/optional). */
function checkArrowDecl(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  checkString(v.path, `${field}.path`);
  checkEnum(v.format, `${field}.format`, ["arrow"]);
}

function checkRoleEntry(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  checkString(v.column, `${field}.column`);
  if (typeof v.label !== "string") fail(`${field}.label`, "must be a string");
}

function checkColumnRoles(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  if (!("filename" in v)) fail(`${field}.filename`, "is required when column_roles is present");
  checkRoleEntry(v.filename, `${field}.filename`);
  if (v.datetime !== undefined && v.datetime !== null) {
    checkRoleEntry(v.datetime, `${field}.datetime`);
    checkEnum((v.datetime as Record<string, unknown>).format, `${field}.datetime.format`, DATETIME_FORMATS);
  }
  for (const family of ["categorical", "freeform"] as const) {
    const entries = v[family];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail(`${field}.${family}`, "must be an array");
    entries.forEach((entry, i) => checkRoleEntry(entry, `${field}.${family}[${i}]`));
  }
  // Schema v2.8: bare column NAMES, not role entries — the value is the URL and the
  // panel heads each field with the column name, so there is no label to carry.
  if (v.url !== undefined) {
    if (!Array.isArray(v.url)) fail(`${field}.url`, "must be an array");
    v.url.forEach((name, i) => checkString(name, `${field}.url[${i}]`));
  }
  if (v.tag !== undefined) {
    if (!Array.isArray(v.tag)) fail(`${field}.tag`, "must be an array");
    v.tag.forEach((entry, i) => {
      checkRoleEntry(entry, `${field}.tag[${i}]`);
      if (typeof (entry as Record<string, unknown>).delimiter !== "string") {
        fail(`${field}.tag[${i}].delimiter`, "must be a string");
      }
    });
  }
  if (v.scatter !== undefined) {
    if (!Array.isArray(v.scatter)) fail(`${field}.scatter`, "must be an array");
    v.scatter.forEach((entry, i) => {
      if (!isRecord(entry)) fail(`${field}.scatter[${i}]`, "must be an object");
      checkString(entry.x_column, `${field}.scatter[${i}].x_column`);
      checkString(entry.y_column, `${field}.scatter[${i}].y_column`);
      if (typeof entry.label !== "string") fail(`${field}.scatter[${i}].label`, "must be a string");
    });
  }
  // geographic (D-35 Seam G2, schema v2.4) — validated for the SAME reason as scatter: the
  // wizard now decomposes this family into editable lon/lat pairs (roles.ts
  // rolesDraftFromColumnRoles maps over it), so a malformed field would surface as a
  // `.map is not a function` TypeError inside the wizard's async load rather than a named
  // validation failure at the client boundary.
  if (v.geographic !== undefined) {
    if (!Array.isArray(v.geographic)) fail(`${field}.geographic`, "must be an array");
    v.geographic.forEach((entry, i) => {
      if (!isRecord(entry)) fail(`${field}.geographic[${i}]`, "must be an object");
      checkString(entry.lon_column, `${field}.geographic[${i}].lon_column`);
      checkString(entry.lat_column, `${field}.geographic[${i}].lat_column`);
      if (typeof entry.label !== "string") fail(`${field}.geographic[${i}].label`, "must be a string");
    });
  }
  if (v.embedding !== undefined && v.embedding !== null) {
    checkRoleEntry(v.embedding, `${field}.embedding`);
    checkInt((v.embedding as Record<string, unknown>).dim, `${field}.embedding.dim`, 1);
  }
}

/** Validate a per-layout v2 spatial-tile-pyramid descriptor (decision D-33).
 *  Beyond field types, this enforces the structural invariants the renderer's
 *  loader (tilePyramid.ts) ASSUMES, rejecting a malformed pyramid early rather
 *  than letting the loader produce garbage level-selection / addressing:
 *    - the `levels` z values are contiguous and strictly increasing (the loader's
 *      slippy-map level selection walks a dense ladder and the parent rule steps
 *      z-1, both of which break on a gap or a duplicate);
 *    - `z_cap` is within [min(levels.z) .. max(levels.z)] (it is the single
 *      coarse/fine boundary the loader reads — outside the ladder it is incoherent);
 *    - `cap` == floor(tile_px / thumb_px)^2 (the max cells per fine mini-atlas tile;
 *      the producer derives it this way and the renderer assumes that relationship). */
function checkPyramid(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  const container = checkEnum(v.container, `${field}.container`, PYRAMID_CONTAINERS);
  void container;
  checkString(v.path, `${field}.path`);
  const tilePx = checkEnum(v.tile_px, `${field}.tile_px`, TILE_PX_SIZES) as number;
  const thumbPx = checkInt(v.thumb_px, `${field}.thumb_px`, 8);
  if (thumbPx > 512) fail(`${field}.thumb_px`, "must be at most 512");
  const cap = checkInt(v.cap, `${field}.cap`, 1);
  // v2.5 (PR-180 review): optional total-subsample count; 0 lets the overlay skip its
  // pile re-derivation. Absent is valid (a pre-2.5 bake).
  if (v.dropped_total !== undefined) checkInt(v.dropped_total, `${field}.dropped_total`, 0);
  if (!Array.isArray(v.levels) || v.levels.length === 0) {
    fail(`${field}.levels`, "must be a non-empty array of pyramid levels");
  }
  const zs: number[] = [];
  v.levels.forEach((level, i) => {
    const lf = `${field}.levels[${i}]`;
    if (!isRecord(level)) fail(lf, "must be an object");
    zs.push(checkInt(level.z, `${lf}.z`, 0));
    checkInt(level.tile_count, `${lf}.tile_count`, 0);
  });
  // Contiguous + strictly increasing z ladder (sort defensively; the producer
  // writes them coarsest-first, but a manifest is untrusted network data).
  const sorted = [...zs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      fail(`${field}.levels`, `z values must be unique; ${sorted[i]} is duplicated`);
    }
    if (sorted[i] !== sorted[i - 1] + 1) {
      fail(
        `${field}.levels`,
        `z values must be contiguous (no gaps); jumped from ${sorted[i - 1]} to ${sorted[i]}`,
      );
    }
  }
  const zMin = sorted[0];
  const zMax = sorted[sorted.length - 1];
  // The renderer addresses a tile's cells.ts bucket by tilePageId = y*2^z + x,
  // which must fit the Int32 atlas-page field: 2^(2z)-1 <= 2^31-1 ⇒ z <= 15 (kept
  // in sync with tilePyramid.ts MAX_PYRAMID_Z). A deeper level would silently
  // overflow into bucket-key collisions, so reject it here — z this deep is far
  // beyond the producer's tile budget (~4^8 fine tiles already cover 1M images).
  const MAX_PYRAMID_Z = 15;
  if (zMax > MAX_PYRAMID_Z) {
    fail(
      `${field}.levels`,
      `deepest level z=${zMax} exceeds the renderer's maximum ${MAX_PYRAMID_Z} (tilePageId would overflow the Int32 atlas page)`,
    );
  }
  const zCap = checkInt(v.z_cap, `${field}.z_cap`, 0);
  if (zCap < zMin || zCap > zMax) {
    fail(`${field}.z_cap`, `must be within the baked level range [${zMin}..${zMax}]; got ${zCap}`);
  }
  // cap == floor(tile_px / thumb_px)^2 (the mini-atlas packing capacity).
  const expectedCap = Math.floor(tilePx / thumbPx) ** 2;
  if (cap !== expectedCap) {
    fail(
      `${field}.cap`,
      `must equal floor(tile_px/thumb_px)^2 = floor(${tilePx}/${thumbPx})^2 = ${expectedCap}; got ${cap}`,
    );
  }
}

/** Validate an optional per-layout detail-tier descriptor (decision D-33).
 *  NB the renderer itself resolves a click-through preview by DENSE cell id at the
 *  fixed API route GET /api/datasets/{ds}/detail/{cell_id}.{ext} (cellPreview.ts /
 *  client.detailUrl) — it does NOT read `path_prefix`. `path_prefix` is consumed
 *  SERVER-SIDE by that route (api/routers/tiles.py composes `{path_prefix}/{cell_id}
 *  .{ext}` under the dataset dir), so we still require + validate it for image_ref:
 *  a manifest the API cannot serve detail from is malformed. `format` IS used by
 *  the renderer (it picks the URL extension). See schemas/v2 cell_record.detail_ref
 *  (reserved/unused by the current consumer). */
function checkDetail(v: unknown, field: string): void {
  if (!isRecord(v)) fail(field, "must be an object");
  const mode = checkEnum(v.mode, `${field}.mode`, DETAIL_MODES);
  if (mode === "image_ref") {
    checkString(v.path_prefix, `${field}.path_prefix`);
    if (v.format !== undefined) checkEnum(v.format, `${field}.format`, DETAIL_FORMATS);
  } else {
    checkString(v.path, `${field}.path`);
  }
}

/**
 * Validate a fetched manifest document against the v2 contract (issue #4,
 * decision D-33). Accepts `manifest_version` "2.x" (any minor of major 2);
 * rejects any other version — including any major != 2 — with an error naming
 * `manifest_version` (v2 is a clean break; v1.x manifests are not accepted). All
 * other errors likewise name the offending field (e.g. `layouts[0].pyramid.path`).
 * Returns the document typed as the renderer's hand-written LayoutManifest mirror
 * (D-16), which getManifest hands to the renderer.
 */
export function validateLayoutManifest(data: unknown): LayoutManifest {
  if (!isRecord(data)) fail("manifest", "must be a JSON object");

  const version = data.manifest_version;
  if (typeof version !== "string") fail("manifest_version", "must be a string");
  if (!/^2\.(0|[1-9][0-9]*)$/.test(version)) {
    const major = version.split(".")[0];
    if (major !== "2") {
      fail(
        "manifest_version",
        `unsupported major version ${JSON.stringify(version)}: this client implements major version 2 ("2.x")`,
      );
    }
    fail("manifest_version", `must be "2.<minor>"; got ${JSON.stringify(version)}`);
  }

  checkString(data.dataset_id, "dataset_id", { pattern: ID_PATTERN, maxLength: 128 });
  checkInt(data.dataset_version, "dataset_version", 1);

  if (!Array.isArray(data.layouts)) fail("layouts", "must be an array");
  if (data.layouts.length === 0) fail("layouts", "must contain at least one layout");
  data.layouts.forEach((entry, i) => {
    const field = `layouts[${i}]`;
    if (!isRecord(entry)) fail(field, "must be an object");
    checkString(entry.layout_id, `${field}.layout_id`, { pattern: ID_PATTERN, maxLength: 128 });
    checkString(entry.label, `${field}.label`);
    checkEnum(entry.type, `${field}.type`, LAYOUT_TYPES);
    const bbox = entry.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      fail(`${field}.bbox`, "must be an array of exactly 4 numbers [x_min, y_min, x_max, y_max]");
    }
    bbox.forEach((n, j) => {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
        fail(`${field}.bbox[${j}]`, "must be a number in [0, 1]");
      }
    });
    // v2.5 (T2-72 Seam 2): optional full-precision bbox for exact chip binning (same [0,1]^4
    // shape as bbox). Absent on a pre-2.5 bake.
    if (entry.bbox_exact !== undefined) checkUnitNumbers(entry.bbox_exact, `${field}.bbox_exact`, 4);
    checkPyramid(entry.pyramid, `${field}.pyramid`);
    // v2.2 (T2-66/T2-48): optional per-layout position-table path. Null/absent is
    // valid (a pre-2.2 dataset — fine-tier-only picking); when present it must be a
    // non-empty string (the schema's minLength 1).
    if (entry.positions_ref !== undefined && entry.positions_ref !== null) {
      checkString(entry.positions_ref, `${field}.positions_ref`);
    }
    if (entry.detail !== undefined && entry.detail !== null) checkDetail(entry.detail, `${field}.detail`);
    if (entry.edges !== undefined && entry.edges !== null) {
      checkArrowDecl(entry.edges, `${field}.edges`);
    }
    // v2.3 (D-35 Seam G1): optional `options` echo. Absent is valid (a default bake).
    if (entry.options !== undefined) checkLayoutOptions(entry.options, `${field}.options`);
    // v2.5 (T2-69/T2-72 Seam 2): optional `annotations`. Absent is valid (a layout with
    // none, or a pre-2.5 bake).
    if (entry.annotations !== undefined) checkAnnotations(entry.annotations, `${field}.annotations`);
    // v2.6 (T2-140 / D-36 seam U1): count of cells this layout could not place. Every fresh
    // 2.6 entry carries it INCLUDING 0 (same always-emit rule as `pyramid.dropped_total`);
    // absent is still valid because add-layouts carries pre-2.6 entries forward, and absent
    // means "not counted", NOT "zero". Non-negative integer when present.
    if (entry.missing_count !== undefined) checkInt(entry.missing_count, `${field}.missing_count`, 0);
  });

  if (data.column_roles !== undefined) checkColumnRoles(data.column_roles, "column_roles");
  if (data.tags !== undefined && data.tags !== null) checkArrowDecl(data.tags, "tags");

  const meta = data.dataset_metadata;
  if (!isRecord(meta)) fail("dataset_metadata", "must be an object");
  checkInt(meta.image_count, "dataset_metadata.image_count", 0);
  checkString(meta.ingest_timestamp, "dataset_metadata.ingest_timestamp");
  if (meta.source !== undefined) checkString(meta.source, "dataset_metadata.source");

  return data as unknown as LayoutManifest;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Join a manifest-authored relative path (e.g. "cells/grid/v1/") under a
 *  prefix, normalizing slashes so composed URLs never carry "//". */
function joinPath(prefix: string, rel: string): string {
  const left = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const right = rel.startsWith("/") ? rel.slice(1) : rel;
  return `${left}/${right}`;
}

/** The version segment of a version-stamped detail block's `path_prefix` (T2-80).
 *  The producer bakes detail originals under `detail/v{dataset_version}/`
 *  (`worker.py`), so a `path_prefix` of exactly `detail/v{N}/` means the tier is
 *  version-stamped and the API's immutable versioned route
 *  (`/detail/v{N}/{id}.{ext}`) serves it. That route validates the URL's `v{N}`
 *  against the version stamped in the prefix itself — the same N this parses — NOT
 *  against `dataset_version`: the two diverge once a bake keeps a tier it did not
 *  create (`add-layouts` bumps `dataset_version` but carries `detail/v{N}/` forward),
 *  and gating on `dataset_version` used to 404 the click-through then (T2-178). So
 *  parsing the prefix is both the version-stamp DETECTOR and yields the
 *  number the API validates. Returns the version, or null for the legacy un-stamped
 *  `detail/` shape (or any other prefix) → the caller falls back to the un-versioned
 *  route, so old manifests keep working. */
function detailVersionFromPrefix(pathPrefix: string | undefined): number | null {
  if (pathPrefix === undefined) return null;
  const match = /^detail\/v(\d+)\/$/.exec(pathPrefix);
  if (match === null) return null;
  return Number.parseInt(match[1], 10);
}

// The client attaches the identity-only JWT bearer token (decision D-24) to
// every request; auth/ownership is resolved server-side from app-state. Pass the
// token via getToken so it can refresh without recreating the client. The token
// is NEVER decoded or trusted client-side — it is an opaque string here.
//
// T2-123 (Fix A): `onAuthExpired` is the app's session-expiry hook — the client
// fires it when a request that CARRIED a bearer comes back 401 (the identity token
// is no longer accepted: expired or revoked). The client NEVER imports UI; the app
// subscribes through this callback and reacts (clear the session, route to re-auth).
// See signalAuthExpiredIf401 for the single-fire / discrimination rules.
export function createApiClient(
  baseUrl: string,
  getToken?: () => string | null,
  onAuthExpired?: () => void,
): ApiClient {
  // Normalize: no trailing slash, so every composed URL is `{base}/...`.
  const base = baseUrl.replace(/\/+$/, "");

  // The latest validated manifest per dataset, captured by getManifest. The
  // tagsUrl helper composes from the manifest's version-stamped `tags.path`, so it
  // requires the manifest to have been fetched through this client first (the
  // renderer's LayoutController.activate guarantees that ordering). The v2
  // pyramidUrl/detailUrl helpers are pure route builders and need no manifest.
  const manifests = new Map<string, LayoutManifest>();

  // T2-43: the in-flight/resolved tag-sidecar fetch, keyed by the composed
  // (version-stamped) URL so the two racing consumers (UI TagControls + renderer
  // LayoutController) share ONE download. BOUNDED TO ONE ENTRY (the current
  // sidecar): the client is app-lifetime and the consumers only ever want the
  // current dataset's sidecar, so a request for a different url releases the old
  // entry rather than retaining every browsed dataset's decoded Table (tens of MB
  // each at 1M-scale). A rejected promise is evicted (below) so a later call
  // retries. Only the un-signalled path populates this — see fetchTags.
  const tagFetches = new Map<string, Promise<Table>>();

  // T2-66/T2-48 (v2.2): the in-flight/resolved POSITION-TABLE fetch, keyed by the
  // composed (version-stamped, per-layout) URL. Same shape as tagFetches — de-dupe
  // concurrent + repeat un-signalled fetches of the same url, BOUNDED TO ONE ENTRY
  // (the #99 lesson: never retain a table per layout/dataset ever opened — up to
  // ~16 MB each at 1M). A new url releases the prior entry; a rejection is evicted so
  // a retry re-fetches; a signalled fetch bypasses the cache.
  const positionFetches = new Map<string, Promise<Table>>();

  // T2-09 residual (D-i addendum) — static-edge credential refresh coordination.
  // The last layout getManifest opened per dataset: refreshDatasetCredential
  // re-opens THAT manifest to re-issue the dataset's `viz_ds` cookie (the cookie
  // is dataset-scoped `{ds,sub,exp}`, so any layout refreshes it; the last-opened
  // one is guaranteed to exist and be readable).
  const lastLayoutForDataset = new Map<string, string>();
  // The in-flight refresh promise per dataset: concurrent 401s (a viewport of
  // tiles expiring together — the common case) COALESCE onto one refresh and all
  // retry after it settles. Cleared when the refresh settles.
  const inFlightRefresh = new Map<string, Promise<boolean>>();
  // When the last refresh for a dataset was ISSUED (ms epoch). The cooldown guard
  // (CREDENTIAL_REFRESH_COOLDOWN_MS) reads this so a post-refresh 401 does not
  // trigger a second refresh and tight-loop against an unsatisfiable request.
  const lastRefreshAt = new Map<string, number>();

  function authHeaders(): Record<string, string> {
    const token = getToken?.() ?? null;
    return token !== null && token !== "" ? { Authorization: `Bearer ${token}` } : {};
  }

  // T2-123 (Fix A): session-expiry signal. When a request that CARRIED a bearer comes
  // back 401, the identity token is no longer accepted (expired / revoked) — fire the
  // app's onAuthExpired hook so it surfaces re-authentication instead of browsing
  // half-alive on a dead token (the static-edge 401 spiral the operator hit: the
  // credential refresh's OWN getManifest presents the stale bearer and 401s, so the
  // cookie can never be re-minted; that 401 flows through requestJson here).
  //
  // SINGLE-FIRE per token VALUE: a burst of parallel 401s (a viewport of tile / sidecar
  // fetches expiring together, plus the refresh's getManifest) collapses to ONE logout,
  // and a later re-login (a NEW token) re-arms. Discrimination: (i) the login / signup
  // routes send no bearer (auth:false ⇒ bearerSent false), so a bad password never trips
  // this; (ii) anonymous browsing sends no bearer either (getToken null); (iii) a
  // get_optional_user route that 401s a PRESENTED-invalid bearer WILL fire this — which
  // is correct/desired (the session is dead).
  let expiredSignalledForToken: string | null = null;
  function signalAuthExpiredIf401(status: number, bearerSent: boolean): void {
    if (status !== 401 || !bearerSent) return;
    const tok = getToken?.() ?? null;
    if (tok === null || tok === "") return; // anonymous — no session to expire
    if (tok === expiredSignalledForToken) return; // already fired for this token (debounce the burst)
    expiredSignalledForToken = tok;
    try {
      onAuthExpired?.();
    } catch {
      // A subscriber throwing must never break the request's own error handling.
    }
  }

  /** T2-09 residual: single-flight + cooldown static-edge credential refresh.
   *  Re-opens the dataset's last manifest (which re-issues the `viz_ds` cookie) so
   *  a 401'd static-edge fetch can retry ONCE. Coalesces concurrent callers onto
   *  one promise per dataset and rate-limits to one refresh per cooldown window;
   *  never throws (a failed re-open resolves false). See the interface doc. */
  function refreshDatasetCredential(dsId: string): Promise<boolean> {
    // Coalesce: a refresh is already running for this dataset — join it. A whole
    // viewport of tiles 401ing together thus triggers exactly ONE manifest GET.
    const running = inFlightRefresh.get(dsId);
    if (running !== undefined) return running;
    // Cooldown: a refresh JUST ran (and a retry still 401'd, or many tiles are
    // failing in a burst) — do not refresh again this window. The caller falls
    // through to its normal failure path (never-grey coarse fallback / T2-44
    // backoff for tiles), so a revoked/unsatisfiable fetch cannot loop.
    const last = lastRefreshAt.get(dsId);
    if (last !== undefined && Date.now() - last < CREDENTIAL_REFRESH_COOLDOWN_MS) {
      return Promise.resolve(false);
    }
    const layoutId = lastLayoutForDataset.get(dsId);
    if (layoutId === undefined) {
      // No manifest has been opened for this dataset — there is nothing to re-open
      // (and thus no cookie to re-issue). Should not happen once a dataset is being
      // viewed (activate() opened a manifest), but never assume: fail closed to the
      // normal path rather than fabricate a layout id.
      return Promise.resolve(false);
    }
    lastRefreshAt.set(dsId, Date.now());
    const promise = (async (): Promise<boolean> => {
      try {
        // ONE authed manifest GET — the server re-issues the cookie on it (D-A
        // issuance re-issues on every manifest GET). getManifest attaches the
        // bearer + rides same-origin, so the Set-Cookie lands in the browser jar.
        await getManifestImpl(dsId, layoutId);
        return true;
      } catch {
        // The re-open failed (network, revoked identity, server trouble): no fresh
        // cookie. Resolve false so the caller stops rather than retries blindly.
        return false;
      } finally {
        inFlightRefresh.delete(dsId);
      }
    })();
    inFlightRefresh.set(dsId, promise);
    return promise;
  }

  /** Fetch + validate a layout manifest (the un-memoized implementation, so the
   *  credential-refresh path can call it without re-entering the ApiClient facade).
   *  Records the layout as this dataset's most-recently-opened, for refresh. */
  async function getManifestImpl(dsId: string, layoutId: string): Promise<LayoutManifest> {
    const raw = await requestJson(
      `/api/datasets/${encodeURIComponent(dsId)}/layouts/${encodeURIComponent(layoutId)}`,
    );
    const manifest = validateLayoutManifest(raw); // issue #4: validate before the renderer sees it
    manifests.set(dsId, manifest);
    lastLayoutForDataset.set(dsId, layoutId);
    return manifest;
  }

  async function toApiError(res: Response): Promise<ApiError> {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.detail === "string") detail = body.detail;
      else if (typeof body === "string") detail = body;
    } catch {
      // Non-JSON error body: keep the status text.
    }
    return new ApiError(res.status, detail);
  }

  /** JSON round-trip with bearer auth. `body` present ⇒ POST (or `method`). */
  async function requestJson(
    path: string,
    opts: { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<unknown> {
    const auth = opts.auth ?? true;
    const headers: Record<string, string> = auth ? authHeaders() : {};
    const init: RequestInit = { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    const res = await globalThis.fetch(`${base}${path}`, init);
    if (!res.ok) {
      signalAuthExpiredIf401(res.status, "Authorization" in headers); // T2-123 (Fix A)
      throw await toApiError(res);
    }
    if (res.status === 204) return undefined;
    return (await res.json()) as unknown;
  }

  /** Fetch + decode an Arrow IPC body (the tag sidecar). UNCOMPRESSED Arrow
   *  (D-29 — apache-arrow JS cannot decode compressed record batches). Bearer
   *  attached: harmless on the static Caddy path, required by the dev FastAPI
   *  fallback.
   *
   *  T2-09 residual (D-i addendum): the tag sidecar is a STATIC-EDGE fetch gated by
   *  the `viz_ds` cookie (D-A), so on a stale tab it can 401 mid-session. When
   *  `dsId` is supplied (the un-signalled path knows its dataset), a 401 triggers a
   *  single-flight credential refresh (one manifest re-open re-issues the cookie)
   *  then ONE retry — coalesced/cooled-down with the renderer's tile refresh in
   *  refreshDatasetCredential. A post-refresh 401 (refresh declined by cooldown, or
   *  a still-failing fetch) surfaces as the normal ApiError. The signalled
   *  (superseded-generation) path passes no dsId and never refreshes — that fetch
   *  is being cancelled anyway. */
  async function fetchArrow(url: string, signal?: AbortSignal, dsId?: string): Promise<Table> {
    const bearerSent = "Authorization" in authHeaders();
    let res = await globalThis.fetch(url, { headers: authHeaders(), signal });
    // T2-123 (Fix A): did a credential refresh CONFIRM the identity is still live? The
    // refresh returns true only when its authed getManifest returned 200 — i.e. the
    // bearer is valid and a fresh cookie was minted. A lingering 401 after THAT is a
    // cookie/edge problem, not an expired session, so it must NOT trip the expiry signal.
    let refreshConfirmedIdentity = false;
    if (res.status === 401 && dsId !== undefined) {
      refreshConfirmedIdentity = await refreshDatasetCredential(dsId);
      if (refreshConfirmedIdentity) {
        // The cookie was re-issued — retry the same static-edge read ONCE. A second
        // 401 falls through to the normal error path below (no re-refresh: the
        // cooldown blocks it), so an unsatisfiable read cannot loop.
        res = await globalThis.fetch(url, { headers: authHeaders(), signal });
      }
    }
    if (!res.ok) {
      // T2-123 (Fix A): a static-edge 401 the credential refresh could NOT cure means the
      // session is dead — surface re-auth (single-fire across the whole 401 burst). But
      // ONLY when the refresh did not confirm a live identity: if its getManifest
      // returned 200 (refreshConfirmedIdentity), the bearer is valid and this 401 is an
      // edge/cookie issue — ejecting the user would be a false logout. The spiral case
      // (the refresh's OWN getManifest 401s) leaves this false, and that 401 already
      // fired the signal via requestJson, so the debounce collapses it to one logout.
      if (!refreshConfirmedIdentity) signalAuthExpiredIf401(res.status, bearerSent);
      throw await toApiError(res);
    }
    const buf = await res.arrayBuffer();
    return tableFromIPC(new Uint8Array(buf));
  }

  /** Best-effort dataset id from a composed static-asset URL
   *  (`{base}/datasets/{ds}/...`), so the un-signalled tag fetch can name the
   *  dataset to refresh on a 401. Returns undefined if the URL is not that shape
   *  (then a 401 just surfaces — no refresh, unchanged behavior). */
  function datasetIdFromAssetUrl(url: string): string | undefined {
    const marker = "/datasets/";
    const at = url.indexOf(marker);
    if (at < 0) return undefined;
    const rest = url.slice(at + marker.length);
    const slash = rest.indexOf("/");
    const seg = slash < 0 ? rest : rest.slice(0, slash);
    if (seg === "") return undefined;
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  }

  /** Static versioned dataset assets are served by Caddy under
   *  `{base}/datasets/{ds_id}/...` (immutable; the asset path embeds the
   *  dataset version). The FastAPI app serves only `/api/...`. */
  function assetUrl(dsId: string, relPath: string): string {
    return joinPath(`${base}/datasets/${encodeURIComponent(dsId)}`, relPath);
  }

  /** v2 read routes served by the API (FastAPI in dev; Caddy proxies in prod):
   *  `{base}/api/datasets/{ds_id}/...`. */
  function apiAssetUrl(dsId: string, relPath: string): string {
    return joinPath(`${base}/api/datasets/${encodeURIComponent(dsId)}`, relPath);
  }

  return {
    async listDatasets(): Promise<DatasetSummary[]> {
      const body = (await requestJson("/api/datasets")) as { datasets: DatasetSummary[] };
      return body.datasets;
    },

    async getDataset(dsId: string): Promise<DatasetSummary> {
      return (await requestJson(`/api/datasets/${encodeURIComponent(dsId)}`)) as DatasetSummary;
    },

    async listLayouts(dsId: string): Promise<LayoutInfo[]> {
      const body = (await requestJson(`/api/datasets/${encodeURIComponent(dsId)}/layouts`)) as {
        layouts: LayoutInfo[];
      };
      return body.layouts;
    },

    async getManifest(dsId: string, layoutId: string): Promise<LayoutManifest> {
      return getManifestImpl(dsId, layoutId);
    },

    refreshDatasetCredential(dsId: string): Promise<boolean> {
      return refreshDatasetCredential(dsId);
    },

    pyramidUrl(dsId: string, layoutId: string): string {
      // v2 (D-33): the layout's whole PMTiles pyramid container, HTTP-Range-read
      // tile-by-tile by the renderer's PMTiles client. Prefer the STATIC Caddy path
      // (immutable, version-embedded in pyramid.path): it matches production —
      // tiles.py notes "Caddy serves the pyramid's static versioned path" and the
      // /api route is only "the dev fallback" — and avoids re-hitting FastAPI on
      // EVERY byte-range read (get_pyramid re-loads + re-validates the manifest per
      // request). This mirrors tagsUrl: it reads the manifest cached by getManifest,
      // which the renderer's LayoutController.activate always fetches before opening
      // the archive, so the renderer takes the static path in practice.
      const manifest = manifests.get(dsId);
      const path = manifest?.layouts.find((l) => l.layout_id === layoutId)?.pyramid?.path;
      if (path !== undefined && path !== "") {
        return assetUrl(dsId, path);
      }
      // Pre-manifest / unknown-layout fallback: the FastAPI route composes the same
      // container server-side from the manifest. It is also the path the bearer
      // token gates — the static Caddy path ignores it (identity JWT, D-24).
      return apiAssetUrl(dsId, `pyramid/${encodeURIComponent(layoutId)}.pmtiles`);
    },

    detailUrl(dsId: string, cellId: number, ext: string): string {
      // v2 (D-33): one cell's full-resolution original, by DENSE cell id. The
      // extension comes from the layout's detail.format (webp/jpeg/png).
      const clean = ext.startsWith(".") ? ext.slice(1) : ext;
      // T2-80: prefer the VERSIONED immutable route when the cached manifest's
      // detail block is version-stamped (`detail.path_prefix` == `detail/v{N}/`, as
      // the producer bakes it). Select the SAME block the API's detail route uses
      // (routers/tiles.py `_detail_block`): the first layout with an `image_ref`
      // detail block carrying a `path_prefix`. Parse its version and compose
      // `/detail/v{N}/{id}.{ext}` — the API validates that N against the version
      // stamped in the prefix, NOT dataset_version (the two diverge after add-layouts,
      // T2-178). Any other shape (the legacy
      // un-stamped `detail/`, or no cached manifest) falls through to the legacy
      // un-versioned route below, so old manifests keep working.
      const manifest = manifests.get(dsId);
      if (manifest !== undefined) {
        const detail = manifest.layouts.find(
          (l) => l.detail?.mode === "image_ref" && l.detail.path_prefix !== undefined,
        )?.detail;
        const version = detailVersionFromPrefix(detail?.path_prefix);
        if (version !== null) {
          return apiAssetUrl(dsId, `detail/v${version}/${cellId}.${clean}`);
        }
      }
      return apiAssetUrl(dsId, `detail/${cellId}.${clean}`);
    },

    staticDetailUrl(dsId: string, cellId: number): string {
      // T2-26: the burst path for the renderer detail overlay. Prefer the STATIC
      // Caddy edge (DB-free `viz_ds` cookie, immutable cache) once the manifest is
      // cached — NOT the authed /api detail route (detailUrl), whose per-request
      // SQLite lookup is fine for one click but wrong for a viewport of fetches.
      // Selects the SAME detail block the API's route uses (first image_ref block
      // carrying a path_prefix) and reuses the version-prefix parse.
      const manifest = manifests.get(dsId);
      if (manifest !== undefined) {
        const detail = manifest.layouts.find(
          (l) => l.detail?.mode === "image_ref" && l.detail.path_prefix !== undefined,
        )?.detail;
        if (detail?.path_prefix !== undefined) {
          const ext = detail.format ?? "webp";
          const version = detailVersionFromPrefix(detail.path_prefix);
          // Versioned prefix (detail/v{N}/) → the immutable versioned static path;
          // legacy un-stamped prefix (detail/) → compose from the raw prefix so an
          // older bake still resolves statically. Both sit under /datasets/{ds}/...
          // behind the D-A cookie.
          const rel =
            version !== null
              ? `detail/v${version}/${cellId}.${ext}`
              : joinPath(detail.path_prefix, `${cellId}.${ext}`);
          return assetUrl(dsId, rel);
        }
      }
      // Pre-manifest fallback: the authed API detail route (bearer-gated). Reached
      // only before the manifest is cached, i.e. never during the overlay's burst.
      return apiAssetUrl(dsId, `detail/${cellId}.webp`);
    },

    coverUrl(dsId: string): string {
      // T2-55: the dataset's Library-card cover, served by the API (auth-gated) from
      // the unversioned cover.webp. A pure route builder (no manifest) — the card
      // fetches it with the bearer header and wraps the blob in an object URL.
      return apiAssetUrl(dsId, "cover");
    },

    authHeaders(): Record<string, string> {
      return authHeaders();
    },

    tagsUrl(dsId: string, version: number): string {
      const manifest = manifests.get(dsId);
      if (manifest !== undefined) {
        if (manifest.tags === undefined || manifest.tags === null) {
          // Catalogue: "null if the manifest declares no tags entry" — the
          // signature is string, so surface the misuse loudly instead of
          // composing a URL that can only 404.
          throw new Error(`tagsUrl: the manifest for '${dsId}' declares no tags sidecar (D-14)`);
        }
        return assetUrl(dsId, manifest.tags.path);
      }
      return assetUrl(dsId, `tags/tags_v${version}.arrow`);
    },

    fetchTags(url: string, signal?: AbortSignal): Promise<Table> {
      // Signalled fetches bypass the shared cache: a caller's abort must never
      // cancel another consumer's read, and the signalled path is the superseded-
      // generation cancellation case (not shared by design). No credential refresh
      // on this path — the fetch is being cancelled, not kept alive.
      if (signal !== undefined) return fetchArrow(url, signal);
      // T2-43: de-dupe concurrent + repeat un-signalled fetches of the same
      // version-stamped sidecar. Share the in-flight promise; evict on rejection
      // so a transient failure can retry (failures are not cached).
      const inFlight = tagFetches.get(url);
      if (inFlight !== undefined) return inFlight;
      // Bound to one entry: a request for a NEW url releases the prior dataset's
      // resolved Table (no cross-dataset sharing need; the client is app-lifetime).
      tagFetches.clear();
      // T2-09 residual: this static-edge fetch is cookie-gated, so a stale tab can
      // 401 it — pass the dataset id so fetchArrow can refresh-then-retry once
      // (coalesced with the tile refresh).
      const promise = fetchArrow(url, undefined, datasetIdFromAssetUrl(url)).catch((err: unknown) => {
        tagFetches.delete(url);
        throw err;
      });
      tagFetches.set(url, promise);
      return promise;
    },

    positionsUrl(dsId: string, layoutId: string): string | null {
      // v2.2 (T2-66/T2-48): compose from the manifest cached by getManifest (the
      // renderer's activate() fetches it before opening any layout asset), reading the
      // layout's version-stamped `positions_ref`. null when the layout declares no
      // table (a pre-2.2 dataset) — the caller then keeps fine-tier-only picking.
      const manifest = manifests.get(dsId);
      if (manifest === undefined) {
        throw new Error(`positionsUrl: the manifest for '${dsId}' has not been fetched yet`);
      }
      const ref = manifest.layouts.find((l) => l.layout_id === layoutId)?.positions_ref;
      if (ref === undefined || ref === null || ref === "") return null;
      return assetUrl(dsId, ref);
    },

    fetchPositions(url: string, signal?: AbortSignal): Promise<Table> {
      // Signalled path bypasses the shared cache (abort isolation), mirroring
      // fetchTags: a superseded-generation cancellation must not touch a shared read.
      if (signal !== undefined) return fetchArrow(url, signal);
      const inFlight = positionFetches.get(url);
      if (inFlight !== undefined) return inFlight;
      // Bound to one entry (#99): a NEW url releases the prior layout's resolved Table
      // (up to ~16 MB at 1M) — never retain a table per layout/dataset ever opened.
      positionFetches.clear();
      // Cookie-gated static-edge fetch: a stale-tab 401 refreshes-then-retries once
      // (coalesced with the tile + tag refresh), via the dataset id parsed from the URL.
      const promise = fetchArrow(url, undefined, datasetIdFromAssetUrl(url)).catch((err: unknown) => {
        positionFetches.delete(url);
        throw err;
      });
      positionFetches.set(url, promise);
      return promise;
    },

    async getMetadata(dsId: string, ids: number[]): Promise<MetadataRow[]> {
      // D-13: the client REJECTS over-cap batches (no silent chunking — see
      // METADATA_MAX_IDS). Callers trim and tell the user ("first 250 of N").
      if (ids.length > METADATA_MAX_IDS) {
        throw new RangeError(
          `getMetadata accepts at most ${METADATA_MAX_IDS} ids per call (D-13); got ${ids.length}. Trim the selection (e.g. ids.slice(0, ${METADATA_MAX_IDS})) and surface the cap to the user.`,
        );
      }
      const body = (await requestJson(
        `/api/datasets/${encodeURIComponent(dsId)}/metadata?ids=${ids.join(",")}`,
      )) as { rows: MetadataRow[] };
      return body.rows;
    },

    async search(
      dsId: string,
      q: string,
      fields: "default" | "all" = "default",
      limit?: number,
    ): Promise<SearchResponse> {
      // T2-57: the query is bound as a parameter server-side and its LIKE
      // metacharacters escaped there; here we only URL-encode it. `fields=all` is the
      // tier-2 catch-all the viewer runs on Enter; `default` is the keystroke tier.
      const params = new URLSearchParams({ q, fields });
      if (limit !== undefined) params.set("limit", String(limit));
      return (await requestJson(
        `/api/datasets/${encodeURIComponent(dsId)}/search?${params.toString()}`,
      )) as SearchResponse;
    },

    async createDataset(req: CreateDatasetRequest): Promise<CreateDatasetResponse> {
      return (await requestJson("/api/datasets", { body: req })) as CreateDatasetResponse;
    },

    async addLayouts(dsId: string, req: AddLayoutsRequest): Promise<AddLayoutsResponse> {
      return (await requestJson(`/api/datasets/${encodeURIComponent(dsId)}/layouts`, {
        body: req,
      })) as AddLayoutsResponse;
    },

    async getJob(jobId: string): Promise<JobStatus> {
      return (await requestJson(`/api/jobs/${encodeURIComponent(jobId)}`)) as JobStatus;
    },

    async signup(req: SignupRequest): Promise<UserInfo> {
      return (await requestJson("/api/auth/signup", { body: req, auth: false })) as UserInfo;
    },

    async login(req: LoginRequest): Promise<TokenResponse> {
      return (await requestJson("/api/auth/login", { body: req, auth: false })) as TokenResponse;
    },

    async me(): Promise<UserInfo> {
      return (await requestJson("/api/auth/me")) as UserInfo;
    },

    async deleteDataset(dsId: string): Promise<void> {
      await requestJson(`/api/datasets/${encodeURIComponent(dsId)}`, { method: "DELETE" });
    },

    async setDatasetPresentation(
      dsId: string,
      patch: { display_name?: string | null; attribution?: string | null; attribution_url?: string | null },
    ): Promise<DatasetPresentation> {
      // PARTIAL BY KEY PRESENCE (routers/datasets.py): an omitted key is left alone,
      // a key present as null or "" CLEARS that field. `patch` is handed to
      // requestJson as-given — JSON.stringify drops `undefined` values, which is
      // exactly the "leave this field alone" semantic, and keeps explicit nulls,
      // which is "clear it". Do NOT normalize undefined→null here or a rename would
      // become impossible to undo one field at a time.
      return (await requestJson(
        `/api/datasets/${encodeURIComponent(dsId)}/presentation`,
        { method: "PATCH", body: patch },
      )) as DatasetPresentation;
    },

    async createUpload(): Promise<UploadHandle> {
      return (await requestJson("/api/uploads", { method: "POST" })) as UploadHandle;
    },

    async uploadPart(uploadId: string, part: File): Promise<UploadStatus> {
      // multipart/form-data with field name "part" (routers/uploads.py). The
      // browser/runtime sets the boundary Content-Type itself — never set it
      // manually here.
      const form = new FormData();
      form.append("part", part, part.name);
      const res = await globalThis.fetch(`${base}/api/uploads/${encodeURIComponent(uploadId)}/parts`, {
        method: "POST",
        headers: authHeaders(),
        body: form,
      });
      if (!res.ok) {
        signalAuthExpiredIf401(res.status, "Authorization" in authHeaders()); // T2-123 (Fix A)
        throw await toApiError(res);
      }
      return (await res.json()) as UploadStatus;
    },

    uploadPartWithProgress(
      uploadId: string,
      part: File,
      onProgress?: (loadedBytes: number, totalBytes: number) => void,
      signal?: AbortSignal,
    ): Promise<UploadStatus> {
      // Seam O4: the SAME multipart POST as uploadPart, but over XMLHttpRequest so the
      // upload can emit byte-level progress (fetch has no upload-progress events). Only
      // the bearer is set — the runtime supplies the multipart boundary Content-Type, as
      // in uploadPart. Auth is attached via the shared authHeaders(), so this does not
      // fight the fetch client's auth pattern. A 200 `already_present` resolves normally;
      // every non-2xx rejects the same typed ApiError the fetch paths throw.
      const url = `${base}/api/uploads/${encodeURIComponent(uploadId)}/parts`;
      const form = new FormData();
      form.append("part", part, part.name);
      return new Promise<UploadStatus>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(abortError());
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        for (const [key, value] of Object.entries(authHeaders())) xhr.setRequestHeader(key, value);
        const onAbort = (): void => xhr.abort();
        if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
        const detach = (): void => {
          if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        };
        if (onProgress !== undefined) {
          xhr.upload.addEventListener("progress", (e: ProgressEvent) => {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
          });
        }
        xhr.addEventListener("load", () => {
          detach();
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText) as UploadStatus);
            } catch {
              reject(new ApiError(xhr.status, "malformed upload response body"));
            }
          } else {
            signalAuthExpiredIf401(xhr.status, "Authorization" in authHeaders()); // T2-123 (Fix A)
            reject(xhrError(xhr));
          }
        });
        xhr.addEventListener("error", () => {
          detach();
          reject(new ApiError(0, "network error during upload"));
        });
        xhr.addEventListener("timeout", () => {
          detach();
          reject(new ApiError(0, "upload timed out"));
        });
        xhr.addEventListener("abort", () => {
          detach();
          reject(abortError());
        });
        xhr.send(form);
      });
    },

    async finalizeUpload(uploadId: string): Promise<UploadHandle> {
      return (await requestJson(`/api/uploads/${encodeURIComponent(uploadId)}/finalize`, {
        method: "POST",
      })) as UploadHandle;
    },

    async getUploadStatus(uploadId: string): Promise<UploadStatus> {
      return (await requestJson(`/api/uploads/${encodeURIComponent(uploadId)}`)) as UploadStatus;
    },

    async listUploads(): Promise<UploadSessionSummary[]> {
      // GET /api/uploads returns a bare JSON array (owner-jailed; tally-backed). Used to
      // confirm a persisted session still exists + is still "open" before offering resume.
      return (await requestJson("/api/uploads")) as UploadSessionSummary[];
    },

    async listUploadFiles(uploadId: string, limit = 1000, offset = 0): Promise<UploadFilesPage> {
      const query = `?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`;
      return (await requestJson(
        `/api/uploads/${encodeURIComponent(uploadId)}/files${query}`,
      )) as UploadFilesPage;
    },

    async checkUploadFiles(uploadId: string, files: CheckFile[]): Promise<CheckResponse> {
      // POST /api/uploads/{id}/check with {files:[{name,size}]} (no sha256 by default —
      // name+size is the resume-diff key, operator decision 2026-07-12). Server caps the
      // batch at 10 000 files (413 beyond) — the caller (planResume) chunks accordingly.
      return (await requestJson(`/api/uploads/${encodeURIComponent(uploadId)}/check`, {
        body: { files },
      })) as CheckResponse;
    },
  };
}
