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
    # Presentation (SCOPE_shareable-collections Part B), both from APP-STATE, never
    # the manifest — they are operator-editable and must not require a re-bake.
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
    """Owner-only PATCH body for a collection's presentation (Part B).

    Both fields are optional so the PATCH is partial: an ABSENT field is left
    untouched, while a field present as null (or blank) CLEARS it. That asymmetry is
    the point — a bad name has to be recoverable, so "unset it" must be expressible
    and distinguishable from "don't touch it"."""

    display_name: str | None = None
    attribution: str | None = None
    attribution_url: str | None = None


class DatasetSummaryPresentation(BaseModel):
    """What a presentation PATCH echoes back: the id it applied to and the values as
    STORED (trimmed, blank collapsed to null), so a client never has to guess how
    its input was normalized."""

    dataset_id: str
    display_name: str | None = None
    attribution: str | None = None
    attribution_url: str | None = None


class DatasetListResponse(BaseModel):
    datasets: list[DatasetSummary]


class LayoutInfo(BaseModel):
    layout_id: str
    label: str
    type: str  # grid|datetime|categorical|scatter|umap|network|custom


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
    log_tail: list[str]  # last N lines of ingest.log (fallback signal)
    error: str | None = None
    # Seam O1 (T2-56): live per-stage progress merged from RQ job.meta, or null for a
    # pre-O1 job (or before the worker writes its first stage). Additive — the poller's
    # existing fields are unchanged; old jobs deserialize exactly as before.
    progress: JobProgress | None = None


# ---- requests ----


class CreateDatasetRequest(BaseModel):
    dataset_id: str = Field(pattern=r"^[A-Za-z0-9._-]+$", max_length=128)
    # Inputs come from a finalized authenticated upload bundle (D-18), not a
    # client-supplied server path; resolved strictly inside the jailed DATA_ROOT.
    upload_id: str
    column_roles: dict | None = None  # optional (D-25); None ⇒ images-only dataset
    layout_types: list[str] = Field(default_factory=lambda: ["grid"])
    # No `owner` field: ownership is derived from the authenticated identity
    # (get_current_user), never client-supplied.


class CreateDatasetResponse(BaseModel):
    dataset_id: str
    job_id: str


class IngestRequest(BaseModel):
    upload_id: str | None = None  # re-ingest source = a finalized upload; default last
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
    # path (AGENT_GUIDE). Default = the caller's latest finalized bundle, exactly like
    # re-ingest; a dataset with no finalized bundle (CLI-seeded) is rejected up front.
    upload_id: str | None = None


class AddLayoutsResponse(BaseModel):
    job_id: str
