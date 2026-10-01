"""Pydantic request/response models — the JSON HTTP contract (interface-catalogue).

Arrow tiles and WebP atlas pages are binary responses and are not modelled here.
The layout manifest is returned verbatim (validated against
layout_manifest.schema.json) and is intentionally NOT re-modelled in Pydantic, to
avoid a second source of truth.

Auth and upload models live with their routers (auth.py, uploads.py), per the
catalogue's placement.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


# ---- responses ----


class DatasetSummary(BaseModel):
    dataset_id: str
    dataset_version: int
    image_count: int
    ingest_timestamp: datetime
    layout_ids: list[str]
    owner: str  # recorded owner (D-18); resolved from app-state, not the manifest
    # D-28: DERIVED at read time (manifest presence + RQ job state) — never
    # stored in the manifest, the dataset tree, or app-state. "ready" ⇒ a
    # readable manifest is on disk; "processing"/"error" ⇒ app-state knows the
    # dataset but no manifest has committed yet (the other fields are then
    # zeroed: dataset_version=0, image_count=0, layout_ids=[],
    # ingest_timestamp=the app-state created_at).
    status: Literal["processing", "ready", "error"]
    # T2-104 (Seam O1): the id of an ACTIVE (queued|started) RQ job recorded for this
    # dataset, else None. ADDITIVE + optional — the status literal is UNCHANGED (a
    # dataset with a readable manifest stays "ready" even while a job re-bakes it), so
    # this is the ONLY signal that a "ready" dataset is being updated (the ready-while-
    # baking blindspot). Consumers poll GET /api/jobs/{active_job_id} for its progress.
    active_job_id: str | None = None
    # Presentation (SCOPE_shareable-collections Part B). They lived in APP-STATE and now
    # travel WITH the dataset, in `presentation.json` beside the manifest (D-i/D-xv).
    #
    # The reason first given for app-state was "putting them in the manifest would make
    # renaming a collection require a re-bake." That is FALSE — editing a manifest does not
    # imply re-baking (`refresh-manifest` rewrites one in place, no tiles, no version bump)
    # — and it propagated to four files before anyone checked it. The correction is kept
    # here rather than deleted, because the false premise is why these fields were in the
    # wrong place for a year.
    #
    # What changed since that correction: they did NOT move into the manifest. They moved
    # into a file BESIDE it, because a single file with a cheap-edit path would have had TWO
    # writers (D-xv). The API is `presentation.json`'s only writer and still writes no
    # manifest, so D-15 stands. The app-state columns remain as the pre-migration FALLBACK
    # (see api/presentation.py `effective`), never as a second source.
    # ADDITIVE + optional, so an older consumer is unaffected.
    #
    # display_name: what to CALL the collection; None => the consumer shows
    # `dataset_id`. It is NOT an alternate address — `dataset_id` remains the only
    # thing that resolves, so a rename cannot break a shared deep link.
    display_name: str | None = None
    # attribution: who it came from ("Rijksmuseum, Amsterdam"). Credit for the
    # holding institution, shown on the library card and in the viewer footer.
    attribution: str | None = None
    # attribution_url (Part D §2b): an OPTIONAL link target for that credit. Separate
    # from the text so a collection can carry a readable name AND a link — sniffing
    # whether the credit happens to parse as a URL would tie rendering to a value the
    # operator did not choose for that purpose. Consumers render the anchor only when
    # this is an absolute http(s) URL; anything else leaves the credit as plain text.
    attribution_url: str | None = None


class DatasetPresentationUpdate(BaseModel):
    """Owner-only PATCH body for a collection's presentation record (D-xv/D-xvii/D-xviii).

    Every field is optional so the PATCH is partial: an ABSENT field is left untouched,
    while a field present as null (or blank) CLEARS it. That asymmetry is the point — a
    bad name has to be recoverable, so "unset it" must be expressible and distinguishable
    from "don't touch it".

    `columns` and `layouts` are typed as raw dicts ON PURPOSE. Their entries follow the
    same key-presence rule one level down (`{"columns": {"src": {"label": null}}}` clears
    that column's label and leaves its `render`), and a nested Pydantic model cannot
    express that without every reader consulting `model_fields_set` on the nested object
    too. `api/presentation.py` owns the whole validation table — including rejecting an
    unknown key with a 422 rather than silently dropping it — so there is ONE place the
    rules live rather than a Pydantic half and a hand-written half."""

    display_name: str | None = None
    attribution: str | None = None
    attribution_url: str | None = None
    # D-iv: the layout the viewer opens on, and the column that titles a cell. Both name
    # identifiers the MANIFEST owns; a value that no longer resolves falls back on read and
    # is never an error (D-xvi), so neither is checked against the manifest here.
    default_layout: str | None = None
    title_column: str | None = None
    # D-xvii/D-xviii: per-column display (label / render / hidden) and per-layout label
    # overrides. `{"src": null}` removes an entry entirely.
    columns: dict[str, dict | None] | None = None
    layouts: dict[str, dict | None] | None = None


class DatasetSummaryPresentation(BaseModel):
    """What a presentation PATCH echoes back: the id it applied to and the three
    dataset-level scalars as STORED (trimmed, blank collapsed to null), so a client never
    has to guess how its input was normalized. Deliberately UNCHANGED in shape by the move
    to `presentation.json` — the storage moved, the wire contract did not."""

    dataset_id: str
    display_name: str | None = None
    attribution: str | None = None
    attribution_url: str | None = None


class PresentationDataset(BaseModel):
    """The dataset-level half of a presentation record. Every key optional; an absent key
    means "not set" and the consumer falls back to today's behaviour (D-xvi)."""

    display_name: str | None = None
    attribution: str | None = None
    attribution_url: str | None = None
    default_layout: str | None = None
    title_column: str | None = None


class PresentationColumn(BaseModel):
    """Presentation for ONE metadata column, keyed by the RAW column name the manifest
    owns. `render` is an enum (today: "url") rather than a boolean so `email`/`image` slot
    in later without a second mechanism. `hidden` is a DISPLAY choice only — the column
    stays in metadata.parquet and in `/api/metadata`, so it is never a privacy control."""

    label: str | None = None
    render: str | None = None
    hidden: bool | None = None


class PresentationLayout(BaseModel):
    """Presentation for ONE layout, keyed by `layout_id`: today just a label override that
    wins over the `layouts[].label` the bake generated (D-xviii)."""

    label: str | None = None


class PresentationResponse(BaseModel):
    """`GET /api/datasets/{ds_id}/presentation` — the EFFECTIVE presentation record: the
    dataset's `presentation.json` merged with the two fallbacks that exist while the
    migration is incomplete (the app-state row for the three scalars, and a pre-2.9
    manifest's `column_roles.url` as `render: "url"`). Served as its own resource rather
    than folded into the manifest response, because the two records have two writers and
    one wire shape would put them back together.

    Keys the record does not carry are omitted (the route sets
    `response_model_exclude_none`), so "absent" on the wire means exactly "absent in the
    file" — which is what lets a consumer treat absent as today's behaviour."""

    presentation_version: str
    dataset: PresentationDataset
    layouts: dict[str, PresentationLayout]
    columns: dict[str, PresentationColumn]


class DatasetListResponse(BaseModel):
    datasets: list[DatasetSummary]


class LayoutInfo(BaseModel):
    """One layout as the layout switcher and the designer's layout cards read it.

    The first three fields are the original wire contract and are UNCHANGED — a client
    that ignores everything below behaves exactly as it did before seam L1. Everything
    added here is the MERGE of two records that already existed separately and were
    never joined ([[T2-nothing-exposes-a-per-layout-completion-state]]): the committed
    half is the manifest, the in-flight half is the active job's `JobProgress`, and this
    is the join, served where layouts are ALREADY fetched so the viewer needs no second
    round trip.
    """

    layout_id: str
    label: str
    type: str  # grid|datetime|categorical|scatter|umap|network|custom
    # --- seam L1 additions (all optional; absent-safe for an old client) ---
    # Whether this layout can be OPENED right now.
    #   live   — committed in the manifest: its tiles are on disk and serve.
    #   baking — not committed, and its `layout:{id}` stage is running.
    #   queued — not committed, and the active job's plan names it (no stage yet, or a
    #            stage still `queued`).
    # With no active job every layout is `live`, which is exactly today's response plus
    # the new fields.
    state: Literal["live", "baking", "queued"] = "live"
    # THE BOTH-COMMITTED-AND-IN-FLIGHT CASE (a re-bake), resolved deliberately rather
    # than collapsed: `state` stays "live" and the pending re-bake is reported HERE.
    # A re-bake does not take the layout away — `add-layouts --replace` commits
    # per-layout at the end, so the committed tiles keep serving until the flip — so
    # calling it "baking" would grey out a card the user can still open, which is the
    # one thing the design says must not happen ("live, with a re-bake pending",
    # LAYOUT_DESIGNER D-xxi). Values mirror `state`'s in-flight vocabulary:
    # "queued" (planned, not started) or "baking" (its stage is running). None means no
    # re-bake is pending — INCLUDING after the re-bake's stage reaches a terminal state,
    # because "done" and "failed" are both "nothing is pending" (the outcome itself is
    # the job route's to report). Always None when `state` is not "live".
    rebake: Literal["queued", "baking"] | None = None
    # When this layout's bytes landed: the mtime of its own PMTiles container
    # (`pyramid.path`), which is the only PER-LAYOUT timestamp that exists —
    # `dataset_metadata.ingest_timestamp` is the DATASET's and is carried forward
    # verbatim by add-layouts, so it would date a layout added months later to the
    # original ingest. A carried-forward entry keeps its original mtime (its container
    # is untouched); a re-baked one gets a fresh version-stamped file and so a fresh
    # time. Null while `queued`/`baking` (nothing has landed), and null if the container
    # cannot be stat'ed — an unreadable file must not 500 the layout list.
    committed_at: datetime | None = None
    # PROVENANCE passed through from `layoutEntry.source_columns` (manifest schema v2.9)
    # — the metadata columns this layout was derived from, so the designer can compute
    # `any(changed_column in source_columns)` locally on every keystroke instead of
    # round-tripping. `[]` and None are DIFFERENT and must stay different: `[]` is a
    # v2.9 producer saying "recorded, and there are none" (every grid layout), while
    # None means the entry PREDATES 2.9 and nothing was recorded — absence is never a
    # positive claim of "depends on nothing". Collapsing them would silently clear the
    # stale flag on exactly the oldest layouts in a tree.
    source_columns: list[str] | None = None
    # HOW those columns were read, passed through from `layoutEntry.source_fingerprint`
    # (manifest schema v2.10): `column -> the list of fingerprint tuples this layout's OWN
    # role entry contributed`. `source_columns` lets the designer ask "did a column this
    # layout reads change?"; this lets it ask the DURABLE question — "do the roles still
    # declare what this bake actually read?" — which survives the commit that caused the
    # drift, where the `set-roles` job's `result` does not (RQ drops it after 500 s).
    # The API does NOT compute staleness from it: that needs the pipeline's rule and the
    # API never imports `pipeline` (D-15). It passes the record through and the client
    # compares. NO NEW VISIBILITY RULE is needed — the whole manifest this comes from is
    # already served read-only to anyone who may read the dataset.
    # `{}` and None are DIFFERENT, exactly as for `source_columns`: `{}` is a v2.10
    # producer saying "this layout reads no column, so there is no way of reading to
    # record" (every grid layout), while None means the entry PREDATES 2.10. An absent
    # record is never "fresh" — that would clear the flag on the oldest bakes.
    # Typed as a bare `dict` (like `options`) rather than a nested model: this is an
    # opaque passthrough of producer bytes, and an unexpected shape must not 500 the
    # layout list.
    source_fingerprint: dict | None = None
    # The manifest's shaping-options echo (`layoutEntry.options`, v2.3/v2.4) verbatim,
    # so a card can explain an existing bake — which scatter scale, which projection —
    # without a second fetch of the whole manifest. None when the entry carries none.
    options: dict | None = None


class LayoutListResponse(BaseModel):
    layouts: list[LayoutInfo]


class MetadataRow(BaseModel):
    id: int
    # Scalar values only. Tags (list<string>) are intentionally excluded (D-21):
    # the panel reads tag chips from the resident D-14 sidecar, not this endpoint.
    fields: dict[str, str | int | float | bool | None]


class MetadataResponse(BaseModel):
    rows: list[MetadataRow]


class SearchHit(BaseModel):
    """One cell that matched a search query (T2-57). `field` is the physical
    metadata column that matched; `role` is that column's search role
    ("title"|"categorical"|"filename"|"id"|"freeform"|"datetime"|"scatter") — the
    frontend routes a `categorical` hit to a snap-to-band jump and every other role
    to a center-on-cell jump. `label` is the column's human label (from the
    manifest's column_roles); `snippet` is the matched value, truncated for
    display + match provenance ("in Description")."""

    id: int
    field: str
    role: str
    label: str
    snippet: str


class SearchResponse(BaseModel):
    """Capped, importance-ordered search hits for one dataset (T2-57). `capped` is
    true when MORE cells matched than were returned (the frontend's honest "N of
    many" signal) — the route returns at most SEARCH_MAX_RESULTS ids so a broad
    query never means an unbounded payload (mirrors METADATA_MAX_IDS)."""

    query: str
    hits: list[SearchHit]
    capped: bool


class JobProgressStage(BaseModel):
    """One stage of an ingest/add-layouts job's progress (Seam O1). Mirrors the
    pipeline reporter's per-stage shape (docs/interface-catalogue.md). ``done``/
    ``total`` are real counts — ``total`` is null when a stage has no known total
    (NO-FAKE-PROGRESS). ``t_start``/``t_end`` (epoch seconds) give a measured
    per-stage rate for free."""

    key: str  # "prepare" | "thumbs" | "tags" | "detail" | "layout:{layout_id}"
    label: str
    unit: str | None = None  # "images" | "tiles" | null (one-shot)
    done: int
    total: int | None = None
    state: str  # queued | running | done | failed
    t_start: float | None = None
    t_end: float | None = None


class JobProgress(BaseModel):
    """Machine-readable per-stage job progress, read from RQ ``job.meta["progress"]``
    (Seam O1). ``schemas/v2/`` is untouched — this is API app-state surface, not a
    dataset contract. Absent for pre-O1 jobs (then JobStatus.progress is null)."""

    progress_version: int
    spec_layouts: list[str]  # the requested layout specs (the job's plan)
    image_count: int | None = None
    # The currently-RUNNING stage key; null when nothing is running (between stages,
    # and in a terminal snapshot — check the stages' states for the outcome).
    current: str | None = None
    stages: list[JobProgressStage]


class JobStatus(BaseModel):
    job_id: str
    state: str  # queued|started|finished|failed (RQ state)
    dataset_id: str
    # OWNER-ONLY, like `result` below: the last N lines of ingest.log (fallback signal)
    # for the dataset's owner; `[]` — never a missing key — for anyone else the read
    # gate admits (an anonymous or signed-in visitor to a PUBLIC dataset). The log
    # records the owner's username and paths, so it is read only after the route has
    # resolved the caller as the owner (`routers/jobs.get_job`).
    log_tail: list[str]
    # OWNER-ONLY: a failed job's exception message (the traceback's last line) for the
    # dataset's owner; `null` for anyone else, for a job that has not failed, and when the
    # message cannot be read (best-effort; the route logs a warning). The message is
    # whatever the pipeline's raise put in it — an upload bundle's path under
    # `users/{owner}/uploads/`, original filenames — so it is gated with the log.
    error: str | None = None
    # Seam O1 (T2-56): live per-stage progress merged from RQ job.meta, or null for a
    # pre-O1 job (or before the worker writes its first stage). Additive — the poller's
    # existing fields are unchanged; old jobs deserialize exactly as before.
    progress: JobProgress | None = None
    # Seam L1: the worker verb's OWN return value, verbatim, once the job has finished —
    # `run_set_roles`'s `{changed_columns, stale_layouts, unknown_layouts, ...}`,
    # `run_delete_layout`'s `{deleted, layouts, swept, ...}`, `run_add_layouts`'s
    # `{committed, replaced, ...}`. Null while the job is unfinished, for a verb whose
    # return is not a mapping (`run_ingest_job` returns a version string), and for a
    # caller who is not the owner.
    #
    # THIS IS THE CHANNEL THE STALE SET ARRIVES ON. `POST .../column-roles` cannot
    # carry it: the stale set is computed by the worker AT THE COMMIT, from
    # `layoutEntry.source_columns`, and the enqueue returns long before that. So the
    # roles route answers with a job id and the authoritative set is read from here —
    # unmodified, never recomputed API-side (recomputing it would be a second oracle
    # for a question the manifest already answers).
    #
    # OWNER-ONLY, like `log_tail` and `error`. `job_id`, `state`, `dataset_id` and
    # `progress` are visible to an anonymous reader of a PUBLIC dataset (D-34 may_read),
    # and deliberately so: they are structural. A verb's raw return is a different kind
    # of thing — its shape is the pipeline's to change per verb, and it already carries
    # server-side artefacts (`swept` file lists, `stale_tag_sidecar`). Auditing every
    # present and future verb's return for anonymous disclosure is not a thing anyone can
    # do once, so this is scoped to the person who performed the write.
    result: dict | None = None


# ---- requests ----


class CreateDatasetRequest(BaseModel):
    # D-xxviii (seam L6): OPTIONAL. Absent (or null) ⇒ the API mints one — exactly 12
    # lowercase hex characters (`routers/datasets._mint_dataset_id`). That FORM is a
    # contract: the frontend recognises a minted id by it and so never shows one as a
    # name. Present ⇒ the same pattern and max_length as before, and the same route:
    # authored ids keep working forever, in a mixed namespace with no migration.
    dataset_id: str | None = Field(
        default=None, pattern=r"^[A-Za-z0-9._-]+$", max_length=128
    )
    # Inputs come from a finalized authenticated upload bundle (D-18), not a
    # client-supplied server path; resolved strictly inside the jailed DATA_ROOT.
    upload_id: str
    column_roles: dict | None = None  # optional (D-25); None ⇒ images-only dataset
    # The PRESENTATION half of the intake payload (D-xvii). Intake used to send one thing:
    # the wizard's "render as link" toggle rode inside `column_roles` as the `url` role.
    # Schema v2.9 removed that role — it was presentation collected on the bake's input
    # path — so intake now sends two things and the API splits them: roles go to the bake,
    # this goes to `presentation.json`. Same shape as the PATCH body, so the wizard and a
    # later edit are the same payload; None ⇒ nothing to record.
    presentation: DatasetPresentationUpdate | None = None
    layout_types: list[str] = Field(default_factory=lambda: ["grid"])
    # No `owner` field: ownership is derived from the authenticated identity
    # (get_current_user), never client-supplied.


class CreateDatasetResponse(BaseModel):
    dataset_id: str
    job_id: str


class IngestRequest(BaseModel):
    # Re-ingest source = a finalized upload. Unnamed defaults to the caller's latest
    # finalized bundle UNLESS the collection's own recorded source_upload_id names a
    # DIFFERENT one, in which case the route refuses (409) rather than guess which
    # the caller meant (review of PR #390, round 3) — see routers/jobs.py::start_ingest.
    upload_id: str | None = None
    layout_types: list[str] | None = None
    # Detail-tier opt-out (T2-46): additive + optional. "bake" (default — behaviour
    # unchanged when the field is omitted) bakes the per-image detail tier; "skip"
    # bakes none (fast CI/fixture re-ingest; no originals). Passed through the enqueue
    # to the worker verbatim; the pipeline owns the semantics.
    detail_tier: Literal["bake", "skip"] = "bake"


class IngestResponse(BaseModel):
    job_id: str


class AddLayoutsRequest(BaseModel):
    # Each spec is a bare layout_type ("categorical") — expanding to all its role
    # entries — OR an already-expanded layout id ("categorical_kingdom"); the
    # pipeline resolves them against the committed dataset's roles and errors clearly
    # if a spec is not producible (T2-58/T2-42). At least one is required.
    layout_specs: list[str] = Field(min_length=1)
    # Optional roles EXTENSION/override (D-25/T2-42). None ⇒ the pipeline reuses the
    # committed manifest's column_roles; when given it REPLACES them (re-validated
    # against the existing metadata.parquet, not a CSV re-join). Passed through
    # verbatim; the pipeline owns the semantics.
    column_roles: dict | None = None
    # add-layouts needs the ORIGINAL source images for the hard id-integrity guard
    # (run_add_layouts). The images come from a finalized authenticated upload bundle
    # (D-18/D-30), resolved inside the caller's jail — NOT a client-supplied server
    # path (AGENT_GUIDE). Default, when unnamed: THIS collection's own recorded
    # `source_upload_id` (seam L1) if it has one and that bundle still exists, else
    # (unrecorded only) the caller's latest finalized bundle — see
    # `routers/jobs._resolve_add_layouts_bundle` for the full order. Unlike re-ingest,
    # the default does NOT simply mean "latest": the designer never sends this field,
    # so falling back to "latest" unconditionally sourced a bake from the wrong
    # collection's images the moment an owner had a second upload
    # ([[T2-a-designer-bake-sources-images-from-the-owner-s]]). A dataset with no
    # finalized bundle at all (CLI-seeded) is rejected up front.
    upload_id: str | None = None
    # Seam L1: per-id opt-in to RE-BAKING a committed layout instead of refusing the
    # collision — the Re-bake control a stale layout card offers (D-xxi). ABSENT or
    # EMPTY is today's behaviour exactly: `_guard_no_collision` still refuses every
    # existing `layout_id` that is not named here, because a silent overwrite is the
    # footgun this path was hardened against. Forwarded VERBATIM and unvalidated on this
    # side: the worker checks each id against the EXPANDED layout ids, which the API
    # cannot compute without importing the pipeline (see api/queue.enqueue_add_layouts).
    replace: list[str] = Field(default_factory=list)


class AddLayoutsResponse(BaseModel):
    job_id: str


class DeleteLayoutResponse(BaseModel):
    """`DELETE /api/datasets/{ds_id}/layouts/{layout_id}` — the ENQUEUED deletion job.

    A job id and nothing else, because nothing has been deleted yet: the manifest is
    worker-written and only worker-written (D-15/D-xv), so removing a layout entry is a
    job, not an HTTP mutation (LAYOUT_DESIGNER D-xxii). The route answers 202, and the
    id is what the card polls to learn when the layout actually goes away."""

    job_id: str


class SetColumnRolesRequest(BaseModel):
    """`POST /api/datasets/{ds_id}/column-roles` — re-declare a committed dataset's
    `column_roles` with no bake.

    `column_roles` is the FULL replacement map, never a patch, and it is typed as a raw
    dict on purpose: `column_roles.schema.json` is the source of truth for its shape and
    the pipeline is the validator of record (D-11), re-checking it against the committed
    metadata.parquet. A Pydantic mirror here would be a second, weaker copy of a schema
    the API cannot fully evaluate anyway — the same reasoning `AddLayoutsRequest.column_roles`
    and `CreateDatasetRequest.column_roles` already apply."""

    column_roles: dict


class SetColumnRolesResponse(BaseModel):
    """`POST /api/datasets/{ds_id}/column-roles` — the ENQUEUED roles job.

    A job id alone, and the stale set is deliberately NOT here. It is computed by the
    worker at the commit (from `layoutEntry.source_columns`), which is strictly after
    this response is written, so a `stale_layouts` field on it could only ever be null —
    a permanently-null field is worse than an absent one. The caller polls
    `GET /api/jobs/{job_id}` and reads `JobStatus.result.stale_layouts`, which is L2's
    own authoritative answer, unmodified.

    The route answers **202 Accepted**, the same as `DeleteLayoutResponse`'s: both routes
    hand back a job id having done none of the work, so the status code follows the
    semantics rather than the verb."""

    job_id: str


class ColumnInfo(BaseModel):
    """One metadata column as the designer's Data view reads it ([[T2-92]] Seam 2).

    `dtype` is the DuckDB type of the column IN THE SOURCE THAT WAS READ — a real
    Parquet type for a committed dataset, and `VARCHAR` for every column of a not-yet-
    ingested CSV, because that is literally how the pipeline reads one
    (`read_csv_auto(..., all_varchar=true)`). No type is INFERRED for a CSV: a CSV
    declares none, and guessing one here would be a second, weaker copy of a decision
    the ingest makes for itself.

    `sample` is ONE row's value for this column, rendered as a string (null when the
    source has no rows, or the value is null). WHICH row differs by source, and each is
    the first row that source HAS:

    * `source: "parquet"` — the row with the lowest `id`, i.e. the dataset's first cell.
      `id` there is the pipeline's own dense integer key, so ordering by it is
      meaningful and stable;
    * `source: "upload"` — the CSV's first DATA row, in file order, with no ORDER BY.
      The bundle is read `all_varchar=true` (exactly as ingest reads it), so a *user*
      column called `id` is a VARCHAR that sorts `"10"` before `"9"`; ordering by it
      would return a row that is not the first one and label it the first (review of
      PR #358, finding 3).

    The first row, not the first NON-EMPTY one: "scan forward until something is
    non-empty" needs a scan bound nobody has measured, and a blank first cell is itself
    information the user can act on.

    `sample` is LENGTH-CAPPED (`datasets._SAMPLE_MAX`, 160 characters, registered in
    docs/design/LIMITS_REGISTER.md). A CSV is read `all_varchar=true`, so a cell is
    whatever the user uploaded and a long description field would otherwise be
    serialized in full into a response that renders a short preview chip. A truncated
    value ENDS WITH `…`, the same self-describing truncation `SearchHit.snippet` uses,
    so a UI can say the value was cut instead of showing a silently shorter one."""

    name: str
    dtype: str
    sample: str | None = None


class ColumnListResponse(BaseModel):
    """`GET /api/datasets/{ds_id}/columns` — what columns this collection has, and where
    the answer came from.

    `source` is load-bearing, not decoration:

    * `"parquet"` — the COMMITTED columns, what ingest actually stored, which is only
      the roled ones (`ingest._enrichment_select` drops the rest, the root finding of
      [[T2-92]]) — and of those only the ones the manifest's `column_roles` DECLARES.
      The pipeline's own columns (`id`, `width`, `height`) are in the file and never in
      this list: they are not the user's to map (review of PR #358, round 3,
      finding 1);
    * `"upload"` — the raw headers of a finalized upload bundle's CSV: the full set
      still available to map, and the only answer that exists before the first bake.
      Either the bundle the caller named with `?upload_id=`, or the one THIS dataset
      records having been built from — never "whichever the owner finalized last". A
      NAMED bundle that carries no CSV is `"upload"` with an EMPTY `columns`: the answer
      is about that bundle, and says nothing about the collection;
    * `"images_only"` — THE COLLECTION has no metadata source at all, and `columns` is
      empty: a baked collection whose manifest carries no `column_roles` (the schema's
      own definition — it still HAS a `metadata.parquet`, holding the pipeline's
      columns), or an unbaked one whose own bundle has no CSV. A KNOWN answer, not a
      failure: an images-only collection is first-class (D-25), so the Data view
      renders "no metadata yet" rather than an error. Reserved
      for that one meaning: it used to also cover "the bundle you named has no CSV",
      which told a consumer following the "read `source`" instruction below that a
      collection with ten committed enrichment columns had no metadata, because the user
      previewed an images-only bundle (review of PR #358, finding 4).

    Conflating the first two would tell a user they can map a column that was dropped,
    or that a column is missing when it was merely never roled. Answering `"upload"`
    where `"images_only"` is true would show them another collection's columns
    entirely, which is what the owner-scoped fallback did (review of PR #358,
    findings 1+2).

    Read `source`, not `len(columns)`: "no columns" and "no metadata source" are
    different states and only `source` distinguishes them."""

    source: Literal["parquet", "upload", "images_only"]
    columns: list[ColumnInfo]
