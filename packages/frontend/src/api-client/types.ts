// Hand-authored TypeScript for API response/request bodies that are NOT part of
// the JSON Schemas in schemas/v1/ (those are generated into src/generated/).
// These mirror the FastAPI Pydantic models in packages/api. Kept distinct from
// the schema-generated types — no duplication.
import type { ColumnRoles } from "../generated/column_roles";

// ---- responses ----

export interface DatasetSummary {
  dataset_id: string;
  dataset_version: number;
  image_count: number;
  ingest_timestamp: string; // ISO 8601 datetime
  layout_ids: string[];
  owner: string; // recorded owner (decision D-18); resolved from API app-state, not the manifest
  // D-28: DERIVED at read time by the API (manifest presence + RQ job state) —
  // never stored. "ready" ⇒ readable manifest on disk; "processing" ⇒ last job
  // queued|started; "error" ⇒ anything else. For non-ready entries the
  // manifest-derived fields are zeroed (dataset_version=0, image_count=0,
  // layout_ids=[]) and ingest_timestamp is the app-state created_at.
  // (Added at seam 12 — the field was already in the API's DatasetSummary.)
  status: "processing" | "ready" | "error";
  // T2-104 / Seam O1: the id of an ACTIVE (queued|started) recorded job for this
  // dataset, else null/absent. ADDITIVE + optional — the status literal is UNCHANGED
  // (a "ready" dataset stays "ready" while a job re-bakes it), so this is the ONLY
  // signal that a ready dataset is being updated (the ready-while-baking blindspot:
  // add-layouts and the post-base stretch of a re-ingest). The Library card renders
  // an "updating" badge from it; the activity panel adopts the id to poll its progress.
  active_job_id?: string | null;
  // Presentation (SCOPE_shareable-collections Part B), from API app-state — NOT the
  // manifest, so an operator can rename a collection without a re-bake. Both
  // additive + optional.
  //
  // display_name: what to CALL it. null/absent ⇒ show `dataset_id`. It is NOT an
  // alternate address: `dataset_id` remains the only thing that resolves, so a
  // rename can never break a deep link (`?d=<dataset_id>`) someone already shared.
  display_name?: string | null;
  // attribution: who it came from, e.g. "Rijksmuseum, Amsterdam" — credit for the
  // holding institution, shown in the viewer footer.
  attribution?: string | null;
  // Part D §2b: an OPTIONAL link target for the credit above. Separate from the
  // credit text so a collection can carry a readable name AND a link; rendered as an
  // anchor only when it is an absolute http(s) URL (see ui/sourceLink).
  attribution_url?: string | null;
}

/** What a presentation PATCH echoes back — the values AS STORED (trimmed, blank
 *  collapsed to null), so a caller never guesses how its input was normalized. */
export interface DatasetPresentation {
  dataset_id: string;
  display_name?: string | null;
  attribution?: string | null;
  attribution_url?: string | null;
}

/** What to CALL a collection: its display name, else its id. The ONE fallback rule —
 *  imported everywhere rather than re-inlined, so no surface can drift into showing a
 *  different thing (and deliberately NOT title-casing the id: an invented name reads
 *  as real and is worse than an honest one). */
export function collectionName(ds: {
  dataset_id: string;
  display_name?: string | null;
}): string {
  const name = ds.display_name ?? null;
  return name !== null && name !== "" ? name : ds.dataset_id;
}

export interface LayoutInfo {
  layout_id: string;
  label: string;
  type: string; // grid|datetime|categorical|scatter|umap|network|custom (v1.1, D-26)
}

export interface MetadataRow {
  id: number;
  // Scalar values only. Tags (list<string>) are intentionally excluded
  // (decision D-21): the panel reads tag chips from the resident D-14 sidecar
  // table, not this endpoint, so the union stays scalar and tags have one
  // source of truth.
  fields: Record<string, string | number | boolean | null>;
}

// T2-57: search hits. `role` tells the viewer how a hit resolves — a "categorical"
// hit snaps the camera to the category's band (D-3 positions-bbox fallback), every
// other role centers on the cell (centerOnCell + pulseHighlight). `snippet` is the
// matched value (truncated) for the results-list context line + match provenance.
export interface SearchHit {
  id: number;
  field: string; // the physical metadata column that matched (e.g. "artist", "title")
  role: string; // "title" | "categorical" | "filename" | "id" | "freeform" | "datetime" | "scatter"
  label: string; // the field's human label (from column_roles), e.g. "Artist"
  snippet: string;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[]; // capped, importance-ordered (prefix→substring, then role, then id)
  capped: boolean; // true when MORE cells matched than were returned — the "N of many" signal
}

// Seam O1 (T2-56): live per-stage job progress, read from RQ job.meta["progress"].
// The pipeline reporter (pipeline/progress.py) writes this shape; the API mirrors it
// (api/models.py). `schemas/v2/` is UNTOUCHED — job progress is API app-state surface,
// not a dataset contract. See docs/interface-catalogue.md "The job-progress contract".
export interface JobProgressStage {
  key: string; // "prepare" | "thumbs" | "tags" | "detail" | "layout:{layout_id}"
  label: string;
  unit?: string | null; // "images" | "tiles" | null (a one-shot stage)
  done: number;
  // NO-FAKE-PROGRESS: null when a stage has no known total ⇒ the UI renders an
  // INDETERMINATE bar (never a fabricated fraction). A real integer ⇒ determinate.
  total?: number | null;
  state: "queued" | "running" | "done" | "failed";
  t_start?: number | null; // epoch seconds (measured per-stage rate for free)
  t_end?: number | null;
}

export interface JobProgress {
  progress_version: number; // currently 1
  spec_layouts: string[]; // the requested layout specs (the job's plan)
  image_count?: number | null;
  // The currently-RUNNING stage key; null when nothing is running (between stages /
  // terminal snapshot — read the stages' states for the outcome).
  current?: string | null;
  stages: JobProgressStage[];
}

export interface JobStatus {
  job_id: string;
  state: string; // queued|started|finished|failed (RQ state)
  dataset_id: string;
  log_tail: string[]; // last N lines of ingest.log (fallback signal)
  error?: string | null;
  // Seam O1: live per-stage progress merged from RQ job.meta, or null for a pre-O1
  // job (or before the worker writes its first stage). Additive — old jobs unchanged.
  progress?: JobProgress | null;
}

// ---- auth (added at seam-12 pre-flight, 2026-06-12 — mirrors routers/auth.py;
// the JWT is identity-only (decision D-24): never decode/trust claims client-side) ----

export interface SignupRequest {
  username: string;
  email: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface TokenResponse {
  access_token: string; // JWT bearer, identity-only (decision D-24)
  token_type: string; // "bearer"
}

export interface UserInfo {
  username: string;
  email: string;
}

// ---- uploads (added at seam 12 — mirrors routers/uploads.py; the brief's §2
// route coverage includes uploads, and the admin wizard drives them through
// the client, the only network path) ----

export interface UploadHandle {
  upload_id: string; // referenced by CreateDatasetRequest once finalized
}

export interface UploadStatus {
  upload_id: string;
  state: "open" | "finalized";
  received_parts: number;
  // Bytes WRITTEN INTO THE BUNDLE — uncompressed for ZIP parts (D-27); the
  // transient archive is never counted.
  bytes_received: number;
  // D-27: ZIP entries skipped by THIS request (nested CSVs, non-image files),
  // capped at 100 names then one "+N more" sentinel. Per-response, not
  // persisted: plain parts / GET status return [].
  ignored: string[];
  // Seam O2: true ONLY for an idempotent re-send (a byte-identical duplicate part
  // the server already holds → 200 instead of 409). Additive/optional; the transport
  // (Seam O4) counts it as success. Absent on older responses ⇒ treat as false.
  already_present?: boolean;
}

// ---- uploads: resume surface (Seam O2; mirrors routers/uploads.py, PR #151) ----
// The client (Seam O4) consumes these to rediscover an interrupted session, diff what
// the server already holds, and send only what is missing (name+size — NO client hash).

export interface UploadSessionSummary {
  upload_id: string;
  state: "open" | "finalized";
  received_parts: number;
  bytes_received: number;
  created: number; // epoch seconds (mtime-derived; approximate)
  last_activity: number; // epoch seconds (freshest mtime; advances every part)
}

export interface UploadFileInfo {
  name: string; // basename (image) or canonical metadata.csv|.tsv
  size: number;
  sha256: string; // server-computed (streamed during store/extract)
  is_metadata: boolean;
}

export interface UploadFilesPage {
  upload_id: string;
  total: number; // full manifest size (files span pages)
  limit: number; // effective (clamped) page size
  offset: number;
  files: UploadFileInfo[];
}

export interface CheckFile {
  name: string;
  size: number;
  sha256?: string | null; // optional client integrity tier (unused by default — name+size)
}

export interface CheckResponse {
  present: string[]; // name+size match (and hash match when both carry one)
  needed: string[]; // not present — send these
  mismatched: string[]; // name exists but size (or provided hash) differs — send after confirm
}

// ---- requests ----

export interface CreateDatasetRequest {
  dataset_id: string;
  // Inputs come from a finalized authenticated upload bundle (decision D-18),
  // not client-supplied server paths.
  upload_id: string;
  column_roles?: ColumnRoles; // optional (decision D-25); absent ⇒ images-only dataset
  layout_types?: string[];
  // No `owner` field: ownership is derived from the authenticated identity
  // server-side, never client-supplied.
}

export interface CreateDatasetResponse {
  dataset_id: string;
  job_id: string;
}

// ---- add-layouts (T2-58; mirrors routers/jobs.py add_layouts / api/models.py) ----

export interface AddLayoutsRequest {
  // Each spec is a bare layout_type ("categorical") or an expanded layout id
  // ("categorical_kingdom"); the pipeline resolves them against the committed
  // dataset's roles. At least one required.
  layout_specs: string[];
  column_roles?: ColumnRoles | null; // optional roles override; absent ⇒ reuse the committed roles
  // add-layouts needs the ORIGINAL source images (id-integrity guard); they come
  // from a finalized upload bundle (D-18/D-30), defaulting to the caller's latest.
  upload_id?: string | null;
}

export interface AddLayoutsResponse {
  job_id: string;
}
