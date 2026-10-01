// Hand-authored TypeScript for API response/request bodies that are NOT part of
// the JSON Schemas in schemas/v1/ (those are generated into src/generated/).
// These mirror the FastAPI Pydantic models in packages/api. Kept distinct from
// the schema-generated types — no duplication.
import type { ColumnRoles } from "../generated/column_roles";
import type { Presentation } from "../generated/presentation";

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

/** The form of an id Plotlas MINTED rather than a person typed (D-xxviii): exactly 12
 *  lowercase hex characters. This is a CONTRACT with the API (seam L6 writes it into
 *  the interface catalogue's `POST /api/datasets` entry), not a heuristic — changing the
 *  form on one side without the other puts hex strings back in the library. */
export const MINTED_DATASET_ID = /^[0-9a-f]{12}$/;

/** What a collection with no display name is called when its id was minted. */
export const UNTITLED_COLLECTION = "Untitled collection";

/** What to CALL a collection: its display name, else its id. The ONE fallback rule —
 *  imported everywhere rather than re-inlined, so no surface can drift into showing a
 *  different thing (and deliberately NOT title-casing the id: an invented name reads
 *  as real and is worse than an honest one).
 *
 *  D-xxviii: a MINTED id never stands in for a name — nobody chose it as a word, so an
 *  unnamed minted collection is "Untitled collection". An AUTHORED id still does, as it
 *  always has: someone chose it, and changing that would rename every existing unnamed
 *  collection to "Untitled". The id itself stays reachable as a technical detail. */
export function collectionName(ds: {
  dataset_id: string;
  display_name?: string | null;
}): string {
  const name = ds.display_name ?? null;
  if (name !== null && name !== "") return name;
  return MINTED_DATASET_ID.test(ds.dataset_id) ? UNTITLED_COLLECTION : ds.dataset_id;
}

/** One layout as `GET /api/datasets/{ds_id}/layouts` serves it — transcribed from
 *  `api/models.py` `LayoutInfo`. The first three fields are the original contract; the
 *  rest arrived with seam L1 and are absent-safe (an old server omits them). */
export interface LayoutInfo {
  layout_id: string;
  label: string;
  type: string; // grid|datetime|categorical|scatter|umap|network|custom (v1.1, D-26)
  // Whether this layout can be OPENED right now. live = committed in the manifest;
  // baking = not committed and its stage is running; queued = not committed and the
  // active job plans it. With no active job every layout is live.
  state?: "live" | "baking" | "queued";
  // A pending RE-BAKE of a committed (live) layout — "queued" or "baking", else null.
  // `state` stays "live" through a re-bake: the committed tiles keep serving until the
  // flip. Always null when `state` is not "live".
  rebake?: "queued" | "baking" | null;
  // When this layout's bytes landed (ISO 8601, the mtime of its own PMTiles container).
  // Null while queued/baking, or when the container cannot be stat'ed.
  committed_at?: string | null;
  // PROVENANCE, passed through from the manifest entry (schema v2.9): the metadata
  // columns this layout was derived from. `[]` and null/absent are DIFFERENT and must
  // stay different: `[]` is a v2.9 producer saying "recorded, and there are none"
  // (every grid layout); null/absent means the entry PREDATES 2.9 and recorded nothing.
  // Never collapse null to [] — that silently clears the stale flag on exactly the
  // oldest layouts (api/models.py LayoutInfo.source_columns).
  source_columns?: string[] | null;
  // HOW those columns were read, passed through from `layoutEntry.source_fingerprint`
  // (schema v2.10): `column -> the fingerprint tuples this layout's OWN role entry
  // contributed`. `source_columns` answers "did a column this layout reads change?";
  // this answers the DURABLE question "do the roles still declare what this bake actually
  // read?", which survives the commit that caused the drift — the `set-roles` job's
  // `result` does not (RQ drops it after 500 s). `pending.ts` compares it by SET
  // MEMBERSHIP, re-encoding each recorded tuple with `JSON.stringify`; never by position
  // (Python escapes non-ASCII in `json.dumps` and JS does not, so the two sides sort
  // differently) and never by a hash (a mismatch would be undebuggable).
  // `{}` and null/absent are DIFFERENT, exactly as for `source_columns`: `{}` is a v2.10
  // producer saying "reads no column, so there is no way of reading to record" (every
  // grid layout), while null/absent means the entry PREDATES 2.10 and is UNCHECKED.
  // Never read absent as "fresh" (api/models.py LayoutInfo.source_fingerprint).
  source_fingerprint?: Record<string, unknown[][]> | null;
  // The manifest's shaping-options echo (`layoutEntry.options`) verbatim; null when the
  // entry carries none.
  options?: Record<string, unknown> | null;
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

// ---- the worker verbs' own returns (seam L1: `JobStatus.result`) ----
// Transcribed from the `return {...}` of each verb in `pipeline/worker.py`. The API passes
// the mapping through VERBATIM (`jobs._read_job_result`) and never re-models it, so these
// are the pipeline's shapes, not the API's. Note `dataset_version` is a STRING in all
// three — each verb returns `str(version)`.

/** `run_set_roles` — `POST .../column-roles`. The authoritative stale set, computed by
 *  the worker AT THE COMMIT; the designer's prediction (`ui/designer/pending.ts`) is
 *  reconciled against it. */
export interface SetRolesJobResult {
  dataset_id: string;
  dataset_version: string;
  manifest_version: string;
  changed_columns: string[];
  stale_layouts: string[];
  unknown_layouts: string[];
  orphaned_layouts: string[];
  renamed_layouts: Record<string, string>; // {old layout_id: new layout_id}
  unserved_tag_roles: string[];
  stale_tag_sidecar: string | null; // a dataset-relative path, or null
}

/** `run_delete_layout` — `DELETE .../layouts/{layout_id}`. */
export interface DeleteLayoutJobResult {
  dataset_id: string;
  deleted: string;
  dataset_version: string;
  layouts: string[]; // the surviving layout ids
  swept: string[]; // dataset-relative paths removed
}

/** `run_add_layouts` — `POST .../layouts`. */
export interface AddLayoutsJobResult {
  dataset_version: string;
  committed: string[];
  replaced: string[]; // which of `committed` overwrote a committed layout (a re-bake)
  failed: string[];
}

/** One verb's return. The caller knows which verb it enqueued; the three shapes are also
 *  told apart by a key only one of them has (`changed_columns` / `deleted` /
 *  `committed`), so `"changed_columns" in result` narrows. */
export type JobResult = SetRolesJobResult | DeleteLayoutJobResult | AddLayoutsJobResult;

export interface JobStatus {
  job_id: string;
  state: string; // queued|started|finished|failed (RQ state)
  dataset_id: string;
  // The last N lines of ingest.log (fallback signal). OWNER-ONLY: `[]` for anyone else
  // (the key is never missing), and `[]` before the log is written.
  log_tail: string[];
  // A failed job's exception message. OWNER-ONLY: null for anyone else, null for a job
  // that has not failed, and null when the API could not read the message.
  error?: string | null;
  // Seam O1: live per-stage progress merged from RQ job.meta, or null for a pre-O1
  // job (or before the worker writes its first stage). Additive — old jobs unchanged.
  progress?: JobProgress | null;
  // Seam L1: the worker verb's OWN return value, verbatim, once the job has FINISHED.
  // OWNER-ONLY: null for anyone else, null while unfinished, and null for a verb whose
  // return is not a mapping (`run_ingest_job` returns a version string).
  result?: JobResult | null;
}

// ---- columns (seam L1: `GET /api/datasets/{ds_id}/columns`; api/models.py) ----

/** One metadata column. `dtype` is the DuckDB type IN THE SOURCE THAT WAS READ — a real
 *  Parquet type for a committed dataset, and `VARCHAR` for every column of an unbaked
 *  CSV (no type is inferred for a CSV). `sample` is one row's value as a string, capped
 *  at 160 characters; a truncated value ends with `…`. */
export interface ColumnInfo {
  name: string;
  dtype: string;
  sample?: string | null;
}

/** What columns a collection has, and WHERE the answer came from. Read `source`, never
 *  `columns.length`: "no columns" and "no metadata source" are different states.
 *    parquet     — the COMMITTED columns: only the ones `column_roles` declares.
 *    upload      — the raw headers of a finalized upload bundle's CSV.
 *    images_only — the collection has no metadata source at all; `columns` is empty. */
export interface ColumnListResponse {
  source: "parquet" | "upload" | "images_only";
  columns: ColumnInfo[];
}

/** `POST /api/datasets/{ds_id}/column-roles` — 202 + the enqueued roles job. The stale
 *  set is NOT here: it is computed at the commit and arrives on `JobStatus.result`. */
export interface SetColumnRolesResponse {
  job_id: string;
}

/** `DELETE /api/datasets/{ds_id}/layouts/{layout_id}` — 202 + the enqueued deletion job.
 *  Nothing is gone yet: the manifest is worker-written, so a delete is a job. */
export interface DeleteLayoutResponse {
  job_id: string;
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

// Seam A2: the wire shape of GET /api/uploads/caps — the upload ceilings THIS
// deployment enforces, read per request from its env. Exactly the three caps the
// pre-flight acts on; see the route's docstring for why the check-body cap is not
// here (it HAS a client consumer — that is a tracked gap, not an absence).
//
// Named ...Response, unlike its server model, so it cannot be confused with
// ui/admin/uploadSelection's camelCase `UploadCaps` — an auto-import picking the
// wrong one of two identically-named exported types is a silent-wrong-shape bug.
// `capsFromServer` maps this onto that type and VALIDATES it (it accepts `unknown`,
// because nothing has checked this body at runtime): a read that fails, or that
// returns a body which is not three usable numbers, leaves DEFAULT_UPLOAD_CAPS in
// place.
export interface UploadCapsResponse {
  max_part_bytes: number; // per part (a .zip caps its COMPRESSED bytes)
  max_bundle_bytes: number; // whole-bundle uncompressed ceiling
  max_entries: number; // whole-bundle file-count ceiling
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
  // D-xxviii: OPTIONAL. Absent ⇒ the API mints a 12-lowercase-hex id (seam L6) and
  // returns it on `CreateDatasetResponse.dataset_id`, which is the id to use from then
  // on. The web intake sends none; present, it is validated exactly as before (the CLI
  // path and the committed fixtures keep authored ids).
  dataset_id?: string;
  // Inputs come from a finalized authenticated upload bundle (decision D-18),
  // not client-supplied server paths.
  upload_id: string;
  column_roles?: ColumnRoles; // optional (decision D-25); absent ⇒ images-only dataset
  // D-xvii — the PRESENTATION half of the intake payload. Intake used to send one thing:
  // the wizard's "render as link" toggle rode inside `column_roles` as the `url` role.
  // Schema v2.9 removed that role (it was presentation collected on the bake's input
  // path), so intake sends two things and the API splits them — roles to the bake, this to
  // `presentation.json`. Absent ⇒ nothing to record, which is every images-only dataset
  // and every CSV whose columns are all plain text.
  presentation?: Presentation;
  layout_types?: string[];
  // No `owner` field: ownership is derived from the authenticated identity
  // server-side, never client-supplied.
}

export interface CreateDatasetResponse {
  dataset_id: string;
  job_id: string;
}

// The STRUCTURED `detail` of the 409 a create with no `dataset_id` gets when its upload
// already backs one of the caller's collections (docs/interface-catalogue.md,
// `create_dataset`; backlog T2-a-minted-create-is-not-idempotent-so-a-retried). Names
// that collection and its last job, so a client whose first create's response was lost
// ADOPTS them instead of treating the create as failed. `job_id` is null unless that job
// is still queued or started (a finished, failed or expired job is not followed). Read it
// off a thrown ApiError with `uploadAlreadyCreated` (client.ts).
export interface UploadAlreadyCreatedDetail {
  code: "upload_already_created";
  message: string;
  dataset_id: string;
  job_id: string | null;
}

// ---- add-layouts (T2-58; mirrors routers/jobs.py add_layouts / api/models.py) ----

export interface AddLayoutsRequest {
  // Each spec is a bare layout_type ("categorical") or an expanded layout id
  // ("categorical_kingdom"); the pipeline resolves them against the committed
  // dataset's roles. At least one required.
  layout_specs: string[];
  column_roles?: ColumnRoles | null; // optional roles override; absent ⇒ reuse the committed roles
  // add-layouts needs the ORIGINAL source images (id-integrity guard); they come
  // from a finalized upload bundle (D-18/D-30). Unnamed, defaults to THIS
  // collection's own recorded source upload if it has one and it still resolves,
  // else the caller's latest finalized bundle
  // ([[T2-a-designer-bake-sources-images-from-the-owner-s]]).
  upload_id?: string | null;
  // Seam L1: per-id opt-in to RE-BAKING a committed layout instead of refusing the
  // collision. Absent or empty is the old behaviour exactly — every existing layout_id
  // not named here is still refused. Forwarded to the worker verbatim.
  replace?: string[];
}

export interface AddLayoutsResponse {
  job_id: string;
}
