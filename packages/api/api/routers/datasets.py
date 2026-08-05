"""GET/POST/DELETE /api/datasets, GET /api/datasets/{ds_id}.

Writes (POST/DELETE) require an authenticated identity (get_current_user) and are
owner-only. Reads (GET) are visibility-scoped (D-34): they take an OPTIONAL identity
(get_optional_user) and gate on appstate.may_read — a caller sees a dataset iff it is
public or they own it, so the list returns public∪owned (public-only when anonymous)
and a single GET 404s a private dataset the caller cannot read (the same 404 as a
missing one — non-disclosure). The summary's `owner` is resolved from API app-state,
never from the manifest — and is DISCLOSED only to the owner themself (_mask_owner):
every other viewer sees "", so publishing a dataset never publishes its owner's
account username.

D-28: each summary carries a DERIVED `status` — "ready" when a readable manifest
is on disk; otherwise the app-state record's last job decides
"processing" (queued|started) vs "error" (failed, finished-without-manifest, job
missing, RQ unreachable). App-state-known datasets therefore appear in the list
BEFORE their first manifest commits. The status is computed at read time from
manifest presence + RQ state and is never stored anywhere. `list_datasets` skips
(and logs) a dataset whose manifest is unreadable or an unsupported major
version, so one bad dataset does not 500 the whole listing (a direct GET of that
dataset still surfaces the error). Does not import another router. Does not
write Parquet or manifests — the worker does; this router only enqueues (D-15)
and, for DELETE, removes a dataset's directory + app-state record.
"""

from __future__ import annotations

import logging
import re
import shutil
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from redis.exceptions import RedisError
from rq.exceptions import NoSuchJobError  # type: ignore[import-untyped]
from rq.job import Job  # type: ignore[import-untyped]
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db, queue
from api.models import (
    CreateDatasetRequest,
    CreateDatasetResponse,
    DatasetListResponse,
    DatasetPresentationUpdate,
    DatasetSummary,
    DatasetSummaryPresentation,
)
from api.queue import LockUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter()

# Bundle-layout constants, mirrored from uploads.py. Routers may not import one
# another (module-map rule), so create_dataset re-derives the upload bundle paths.
_UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_IMAGES_SUBDIR = "images"
_FINALIZED_MARKER = ".finalized"
_CSV_EXTS = (".csv", ".tsv")

# RQ states that mean "an ingest is in flight" (D-28): the dataset lists as
# `processing`, and DELETE refuses with 409. Anything else — failed, finished
# (without a manifest), a missing/expired job, or an unreachable broker — is not
# in flight: the dataset lists as `error` and is deletable (so a wedged dataset
# can always be cleaned up).
_ACTIVE_JOB_STATES = {"queued", "started"}


def _resolve_finalized_bundle(owner: str, upload_id: str) -> Path:
    """Resolve a FINALIZED upload bundle dir in `owner`'s jail under db.users_root()
    (404 if missing or not finalized). Mirrors the uploads.py layout (DATA_ROOT/
    users/{owner}/uploads/, decision D-30) without importing that router."""
    if not _UPLOAD_ID_RE.match(upload_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid upload_id"
        )
    upload_dir = db.resolve_under(db.users_root(), owner, "uploads", upload_id)
    if (
        not (upload_dir / _IMAGES_SUBDIR).is_dir()
        or not (upload_dir / _FINALIZED_MARKER).exists()
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Finalized upload not found"
        )
    return upload_dir


def _bundle_csv(upload_dir: Path) -> Path | None:
    """The bundle's optional metadata source, or None for an images-only bundle."""
    for ext in _CSV_EXTS:
        candidate = upload_dir / f"metadata{ext}"
        if candidate.is_file():
            return candidate
    return None


def _dataset_tombstone(data_root: Path, ds_id: str) -> Path:
    """A unique rename target for a dataset being deleted (PR #38 review #2). Placed
    DIRECTLY under DATA_ROOT — disjoint from datasets_root()/users_root() — so the
    list scan (which reads only datasets_root) never surfaces a half-deleted tree.
    `ds_id` is already jailed by db.dataset_dir at the call site; the random suffix
    makes the name unique so a delete→recreate→delete cannot collide on a tombstone
    whose deferred rmtree is still in flight. The rename stays on one filesystem
    (both paths under DATA_ROOT), so it is atomic and O(1)."""
    return data_root / f".deleting-{ds_id}-{uuid.uuid4().hex[:8]}"


def _status_of(job: Any) -> str | None:
    """One restored job's RQ status as a string, or None if it cannot be read. A
    corrupt / partially-deserialized job payload must map to "not in flight", never
    propagate — the same isolation the whole listing relies on. `get_status` was
    already loaded by fetch_many (refresh=False avoids a second per-job round-trip)."""
    try:
        raw_status = job.get_status(refresh=False)
    except Exception:  # noqa: BLE001 — a corrupt job must never 500 the listing
        return None
    return (
        str(getattr(raw_status, "value", raw_status))  # RQ enum or str → str
        if raw_status is not None
        else None
    )


def _job_states(connection: Any, job_ids: list[str]) -> dict[str, str | None]:
    """The RQ state of every id in `job_ids`, resolved in ONE round-trip via
    `Job.fetch_many` (a single Redis pipeline) — never N sequential `Job.fetch`
    calls (PR24-1). SYNCHRONOUS (rq is sync): always invoke through
    `run_in_threadpool` so the blocking Redis I/O never runs on the event loop.

    A missing/expired job maps to None (fetch_many yields None, not an exception);
    an unreachable broker maps EVERY id to None (logged once, never silent).
    Callers read None as "not in flight" — `error` for the D-28 status derivation,
    and for DELETE the 409 guard stands down (a dataset must stay deletable when
    Redis is down, matching its `error` listing).

    ISOLATION: this feeds the login-critical `GET /api/datasets` listing, so ONE bad
    job id must never 500 it. `fetch_many` DESERIALIZES (restores) each job, and a
    corrupt payload raises `rq`'s `DeserializationError` — NOT a `RedisError`, so it
    escaped the guard below and crashed the whole listing (the incident's sibling on
    this endpoint). A non-Redis batch failure now falls back to per-id `Job.fetch`, so
    the GOOD ids still resolve; a corrupt id is logged and maps to None, while a merely
    missing/expired id (`NoSuchJobError`) maps to None SILENTLY, exactly as `fetch_many`
    yields it. A per-job status read that fails is isolated by `_status_of`."""
    if not job_ids:
        return {}
    try:
        jobs = Job.fetch_many(job_ids, connection=connection)
    except RedisError as exc:
        logger.warning(
            "RQ unreachable while checking %d job(s): %s", len(job_ids), exc
        )
        return {job_id: None for job_id in job_ids}
    except Exception as exc:  # noqa: BLE001 — a corrupt payload must not 500 the listing
        # A NON-Redis failure in the batch restore (most likely a DeserializationError
        # on a corrupt job). Resolve per-id so one bad job maps to None and the rest
        # still resolve — never propagating to a 500 of the whole listing.
        logger.warning(
            "RQ batch fetch failed (%s); resolving %d job(s) individually: %s",
            type(exc).__name__,
            len(job_ids),
            exc,
        )
        out: dict[str, str | None] = {}
        for job_id in job_ids:
            try:
                job = Job.fetch(job_id, connection=connection)
            except RedisError:
                out[job_id] = None  # broker flaked mid-loop → "not in flight"
            except NoSuchJobError:
                # Missing/expired id: silently None — exactly what the happy-path
                # `fetch_many` yields for it. Only a corrupt/unreadable id is worth a
                # warning; a routine miss is not noise.
                out[job_id] = None
            except Exception:  # noqa: BLE001 — the corrupt id itself
                logger.warning("Skipping unreadable job %r while listing", job_id)
                out[job_id] = None
            else:
                out[job_id] = _status_of(job)
        return out
    return {
        job_id: (None if job is None else _status_of(job))
        for job_id, job in zip(job_ids, jobs)
    }


async def _resolve_job_states(
    connection: Any, job_ids: list[str]
) -> dict[str, str | None]:
    """Resolve many job states OFF the event loop (the blocking batch fetch in a
    threadpool)."""
    return await run_in_threadpool(_job_states, connection, job_ids)


async def _resolve_job_state(connection: Any, job_id: str | None) -> str | None:
    """One id's RQ state, off the event loop (a batch of one)."""
    if job_id is None:
        return None
    states = await _resolve_job_states(connection, [job_id])
    return states.get(job_id)


def _ready_summary(
    ds_dir_name: str,
    manifest: dict,
    owner: str,
    active_job_id: str | None = None,
    record: appstate.DatasetRecord | None = None,
) -> DatasetSummary:
    """A `ready` DatasetSummary from a readable manifest + the app-state owner.
    `ds_dir_name` is the directory name == the URL id == the app-state key
    (D-18). image_count is taken from the manifest as-is (D-25; the
    scanned-vs-renderable nuance is a pipeline concern). `owner` is "" when
    app-state has no record (e.g. CLI-seeded).

    T2-104: `active_job_id` is the id of an ACTIVE (queued|started) recorded job, or
    None. The status literal stays "ready" (a readable manifest is on disk) — this is
    the additive-only signal that the ready dataset is being re-baked (the
    ready-while-baking blindspot: add-layouts, and the post-base stretch of a
    re-ingest, ran fully "ready" before)."""
    meta = manifest.get("dataset_metadata", {})
    return DatasetSummary(
        dataset_id=ds_dir_name,
        dataset_version=manifest["dataset_version"],
        image_count=meta["image_count"],
        ingest_timestamp=meta["ingest_timestamp"],
        layout_ids=[layout["layout_id"] for layout in manifest["layouts"]],
        owner=owner,
        status="ready",
        active_job_id=active_job_id,
        # Part B presentation, from app-state only. `record` is None for a
        # CLI-seeded tree app-state has never heard of; both then stay None and the
        # consumer falls back to the id, which is the correct honest answer.
        display_name=record.display_name if record is not None else None,
        attribution=record.attribution if record is not None else None,
        attribution_url=record.attribution_url if record is not None else None,
    )


def _scan_ready_datasets(
    ds_root: Path, by_id: dict[str, appstate.DatasetRecord]
) -> tuple[list[DatasetSummary], set[str]]:
    """The cold disk scan of the dataset tree (T2-03): `db.ondisk_dataset_ids(ds_root)`
    + per-dataset `db.load_manifest` + owner resolution from the ALREADY-READ
    app-state map (`by_id`), returning the `ready` summaries (in sorted-dir order)
    and the set of on-disk dataset names. PURELY SYNCHRONOUS file I/O — the caller
    runs it via `run_in_threadpool` so N manifest opens (a cold first parse each;
    the `db.load_manifest` lru_cache only makes the WARM re-parse cheap) and the
    `iterdir` scan itself never block the event loop over a large/shared DATA_ROOT.
    Takes `by_id` rather than a session so no DB access crosses the thread boundary
    (the single `list_dataset_records` read stays on the loop) — the pass still
    resolves the owner inline, so there are no per-dataset owner lookups (PR18-1).
    Ordering, fields, and the skip-and-log contract are identical to the inline scan
    it replaces."""
    summaries: list[DatasetSummary] = []
    on_disk: set[str] = set()
    # Membership — the dot-prefix `.staging` skip (D-19) + is_dataset — is factored into
    # db.ondisk_dataset_ids, the SAME scan the operator CLI (api.admin) uses, so the two
    # can never silently diverge on what counts as a dataset on disk. It handles a
    # missing ds_root by returning [], so the loop simply does not execute.
    for name in db.ondisk_dataset_ids(ds_root):
        # Manifest-backed either way: a SKIPPED (unreadable/unsupported) manifest keeps
        # its dataset out of the listing entirely, as before D-28 — it is not resurrected
        # as processing/error below, because "no manifest" is false for it.
        on_disk.add(name)
        try:
            manifest = db.load_manifest(ds_root / name)
            record = by_id.get(name)
            owner = record.owner if record is not None else ""
            summaries.append(_ready_summary(name, manifest, owner, record=record))
        except Exception as exc:
            # ISOLATION CONTRACT: one bad dataset must NEVER 500 the whole listing
            # (which the anonymous browse path AND login depend on). This catch is
            # deliberately BROAD, not an enumerated tuple: the earlier
            # (HTTPException, KeyError, ValidationError) list missed real failures the
            # try-body can raise — a PermissionError on an unreadable manifest
            # (root-owned file, stat-ok but open-denied — the incident that motivated
            # this), a json.JSONDecodeError on a corrupt manifest (a ValueError, not in
            # the old tuple), an OSError mid-read. A best-effort enumeration scan
            # isolates ALL per-item failures by construction; a direct GET of the
            # offending dataset still surfaces the true error + status, and it is logged
            # loudly here (with the traceback for the unexpected classes) so the operator
            # sees it. The by_id lookup does no I/O (already materialised), so this
            # cannot swallow a DB error.
            logger.warning(
                "Skipping dataset %r in listing (%s: %s)",
                name,
                type(exc).__name__,
                getattr(exc, "detail", exc),
                exc_info=not isinstance(exc, (HTTPException, KeyError, ValidationError)),
            )
    return summaries, on_disk


def _pending_summary(
    record: appstate.DatasetRecord, job_state: str | None
) -> DatasetSummary:
    """A summary for an app-state-known dataset with NO manifest on disk (D-28):
    `processing` while its last job is queued|started, else `error`. The
    manifest-derived fields don't exist yet, so they are zeroed by contract:
    dataset_version=0, image_count=0, layout_ids=[], and ingest_timestamp is the
    app-state created_at."""
    derived: Literal["processing", "error"] = (
        "processing" if job_state in _ACTIVE_JOB_STATES else "error"
    )
    return DatasetSummary(
        dataset_id=record.dataset_id,
        dataset_version=0,
        image_count=0,
        ingest_timestamp=record.created_at,
        layout_ids=[],
        owner=record.owner,
        status=derived,
        # Part B presentation, from the SAME record _ready_summary reads it from. A
        # collection named/credited while it is still processing or errored (the PATCH
        # gates only on the app-state record + owner, NOT on an on-disk manifest) must
        # show its name here too, not fall back to the raw id until it reaches "ready".
        display_name=record.display_name,
        attribution=record.attribution,
        attribution_url=record.attribution_url,
    )


def _mask_owner(
    summary: DatasetSummary, user: appstate.CurrentUser | None
) -> DatasetSummary:
    """D-34 privacy: `owner` is an ACCOUNT USERNAME (a login-credential half and an
    enumeration aid), so it is disclosed only to the owner themself — every other
    viewer (anonymous readers of a public dataset, other authed users) sees the ""
    the summary already uses for ownerless datasets. Authorization never reads the
    summary (may_read/is_readable resolve from app-state records), so masking here
    cannot widen or narrow access; the frontend's card subtitle already renders ""
    as "no owner shown". Mutates in place (DatasetSummary is not frozen — the same
    pattern as the active_job_id stamping) and returns the summary for expression
    use."""
    if user is None or summary.owner != user.username:
        summary.owner = ""
    return summary


@router.get("/api/datasets")
async def list_datasets(
    request: Request,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> DatasetListResponse:
    """Merge TWO sources (D-28), batched: (a) manifest-backed datasets on disk ⇒
    `ready`; (b) app-state records with no manifest yet ⇒ `processing`/`error`
    from the recorded job's RQ state — so a dataset is visible from the moment
    its create was accepted. Exactly ONE app-state read for the whole listing
    (list_dataset_records; no per-dataset owner lookups — PR18-1 hygiene).

    D-34 read scoping: the response carries only the datasets the caller MAY read —
    anonymous ⇒ PUBLIC datasets only; authenticated ⇒ the ones they OWN ∪ public.
    Filtered from the already-loaded records (no extra app-state reads), so a private
    dataset never leaks to a non-owner and the whole showcase can be browsed with no
    login."""
    records = await appstate.list_dataset_records(session)
    by_id = {record.dataset_id: record for record in records}
    # Scan the dataset tree under DATA_ROOT/datasets/ (decision D-30) OFF the event
    # loop (T2-03): the `iterdir` + one `load_manifest` per dataset dir is synchronous
    # file I/O that scaled with N datasets ON the loop (the PR #80 lru_cache only made
    # the WARM re-parse cheap; the COLD first parse of each manifest and the iterdir
    # scan itself still blocked). A DATA_ROOT still in the pre-D-30 layout simply lists
    # empty here (no migration shim). `by_id` is passed so the single app-state read
    # above still resolves every owner in the same pass (no per-dataset lookups, no DB
    # access on the worker thread).
    summaries, on_disk = await run_in_threadpool(
        _scan_ready_datasets, db.datasets_root(), by_id
    )
    # Resolve EVERY recorded job's RQ state in ONE batched, off-thread round-trip
    # (PR24-1): the old per-record fetch was synchronous Redis I/O on the event loop —
    # an N+1 the app-state batching had otherwise eliminated. T2-104 EXTENDS this batch
    # from pending-only to ALSO cover on-disk datasets that carry a last_job_id, so a
    # ready-while-baking dataset surfaces its active_job_id — the SAME fetch_many round
    # trip, just more ids (no extra Redis call).
    job_ids = [r.last_job_id for r in records if r.last_job_id is not None]
    states = await _resolve_job_states(request.app.state.queue.connection, job_ids)

    def _active_job(record: appstate.DatasetRecord | None) -> str | None:
        if record is None or record.last_job_id is None:
            return None
        active = states.get(record.last_job_id) in _ACTIVE_JOB_STATES
        return record.last_job_id if active else None

    # Ready (manifest-backed) datasets: attach active_job_id when their recorded job is
    # in flight — status stays "ready" (T2-104 additive signal). Additive on the
    # already-built summaries (mutation is cheap; DatasetSummary is not frozen).
    for summary in summaries:
        summary.active_job_id = _active_job(by_id.get(summary.dataset_id))
    # Pending (no manifest yet) datasets: processing/error from the same states, plus
    # active_job_id so a consumer can poll the in-flight job.
    pending = [r for r in records if r.dataset_id not in on_disk]  # ordered by id
    for record in pending:
        state = states.get(record.last_job_id) if record.last_job_id else None
        summary = _pending_summary(record, state)
        summary.active_job_id = _active_job(record)
        summaries.append(summary)
    # D-34 read scoping: keep only summaries the caller MAY read (public ∪ owned) —
    # applied over the ALREADY-LOADED records (by_id), so there are no extra app-state
    # reads and the PR18-1 single-read hygiene (and its zero-per-dataset-owner-lookup
    # guard) holds. A summary whose dataset has no app-state row (an on-disk
    # CLI-transferred/unowned tree) has no record here, so it is neither public nor
    # owned ⇒ omitted — the safe default until the operator publishes it or assigns an
    # owner (do NOT surface unowned trees as world-readable).
    readable = [
        _mask_owner(summary, user)
        for summary in summaries
        if (rec := by_id.get(summary.dataset_id)) is not None
        and appstate.is_readable(rec.visibility, rec.owner, user)
    ]
    return DatasetListResponse(datasets=readable)


@router.get("/api/datasets/{ds_id}")
async def get_dataset(
    ds_id: str,
    request: Request,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> DatasetSummary:
    """Single-id form of the D-28 derivation: a readable manifest ⇒ `ready`;
    else an app-state record ⇒ `processing`/`error`; else 404. A manifest that
    exists but cannot be served (e.g. unsupported future major) still surfaces
    its real error here, exactly as before.

    D-34: gated by may_read (public ∪ owner) — a private dataset the caller does not
    own returns the SAME 404 as a missing one, so its existence is not disclosed."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    try:
        manifest = db.load_manifest(ds_dir)
    except HTTPException as exc:
        if exc.status_code != status.HTTP_404_NOT_FOUND:
            raise
        record = await appstate.get_dataset_record(session, ds_id)
        if record is None:
            raise  # truly unknown: no manifest, no app-state record
        state = await _resolve_job_state(
            request.app.state.queue.connection, record.last_job_id
        )
        summary = _pending_summary(record, state)
        if state in _ACTIVE_JOB_STATES:
            summary.active_job_id = record.last_job_id
        return _mask_owner(summary, user)
    record = await appstate.get_dataset_record(session, ds_id)
    # T2-104: surface an ACTIVE recorded job on a "ready" dataset (the ready-while-
    # baking signal — status stays "ready"). One bounded off-loop round-trip whenever a
    # job is recorded — a web-ingested dataset carries a finished last_job_id, so it
    # incurs exactly one; only a CLI-seeded / job-less dataset does none.
    active_job_id: str | None = None
    if record is not None and record.last_job_id is not None:
        state = await _resolve_job_state(
            request.app.state.queue.connection, record.last_job_id
        )
        if state in _ACTIVE_JOB_STATES:
            active_job_id = record.last_job_id
    return _mask_owner(
        _ready_summary(
            ds_dir.name,
            manifest,
            record.owner if record else "",
            active_job_id,
            record=record,
        ),
        user,
    )


@router.post("/api/datasets")
async def create_dataset(
    body: CreateDatasetRequest,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> CreateDatasetResponse:
    """Records `owner` from the authenticated identity (get_current_user) into
    app-state (appstate.record_dataset_owner) and reads inputs from the finalized
    upload bundle (body.upload_id), resolved inside the jailed DATA_ROOT. Never
    reads a client-supplied server path (decision D-18). Enqueues the ingest job by
    dotted string with primitive kwargs (D-15); images-only is first-class (D-25).
    After a successful enqueue the job id is recorded on the dataset row (D-28);
    if the enqueue RAISES, an owner row created by THIS request is rolled back and
    the client gets 503 (PR19-3)."""
    owner = user.username

    # Jail dataset_id BEFORE any side effect: it becomes the worker's output dir
    # ({output_root}/{dataset_id} where output_root = DATA_ROOT/datasets/, D-30),
    # and the worker trusts these server-set kwargs — so the API is the sole jail.
    # The CreateDatasetRequest charset permits "." and ".." (it allows '.'), which
    # would escape the datasets root once the worker runs; db.dataset_dir rejects
    # "."/".."/absolute exactly as the read path (get_dataset) does, and also gives
    # us the on-disk dir (under datasets/) for the adoption check below.
    ds_dir = db.dataset_dir(db.resolve_data_root(), body.dataset_id)

    bundle = _resolve_finalized_bundle(owner, body.upload_id)
    csv_path = _bundle_csv(bundle)

    # A metadata ingest needs BOTH a source and a role map; the pipeline rejects
    # either alone (ingest.ingest_metadata). Reject the mismatch here with a clear
    # 400 instead of enqueuing a job that is guaranteed to fail. Neither present ⇒
    # a first-class images-only dataset (D-25).
    if (csv_path is not None) != (body.column_roles is not None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Metadata ingest needs both a CSV in the bundle and column_roles; "
                "supply both, or neither for an images-only dataset"
            ),
        )

    # PR24-8 (DP-4): the owner-conflict check → record_dataset_owner → enqueue →
    # record_dataset_job sequence is the create-side critical section. Hold the
    # per-`dataset_id` API-mutation lock across it so a concurrent DELETE of the
    # SAME id cannot interleave (rmtree + drop the row between our record and our
    # enqueue). The 409 contract is unchanged — the lock only orders these sections.
    # An acquire failure answers 503, same shape as an enqueue failure below; an
    # HTTPException raised INSIDE (409 owner-conflict/adopt) propagates unchanged.
    try:
        async with queue.dataset_lock(request.app.state.redis, body.dataset_id):
            # Do not let one user silently take over a dataset_id app-state already
            # records for someone else (record_dataset_owner is a last-writer-wins
            # upsert).
            existing_owner = await appstate.get_dataset_owner(session, body.dataset_id)
            if existing_owner is not None and existing_owner != owner:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Dataset id already exists",
                )

            # Refuse a create/re-ingest over an id that already EXISTS ON DISK, whoever
            # owns it (fix/reingest-safety). Web re-ingest is not supported: the same-owner
            # path used to fall through here and SILENTLY overwrite (an auto version-bump) —
            # the accidental-overwrite footgun — and a read-only bind-mounted fixture
            # (golden_dataset_*, docker-compose ':ro') cannot be os.replace'd into place at
            # all, so its ingest only leaks `.staging-<job_id>` dirs. Refusing here closes
            # both, regardless of owner: the owner-conflict 409 above still fires first for a
            # DIFFERENT owner (its distinct "already exists" message), and this covers the
            # same-owner and the unowned-on-disk (CLI/operator-seeded) cases — supplanting
            # the old adopt-only guard. To replace a dataset, delete it first, or re-bake it
            # with the CLI (`pixscope ingest`).
            if db.is_dataset(ds_dir):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "A dataset with this id already exists. Delete it first to "
                        "replace it, or re-bake it with the CLI (`pixscope ingest`) — "
                        "web re-ingest is not supported."
                    ),
                )

            # D-30 retires the interim username-collision guard (PR24-2) here: a
            # dataset is now written under DATA_ROOT/datasets/{ds_id}/ while upload
            # jails live under DATA_ROOT/users/{username}/uploads/ — disjoint roots,
            # so a ds_id equal to a username can no longer make the worker write into
            # a user's namespace. The class is gone by layout; no name-based
            # reservation is needed (the DELETE-side guard is likewise retired).
            # Coexistence is pinned by the structural tests in test_write_ingest
            # (forward) / test_addendum (reverse).

            # Record owner BEFORE enqueue (deliberate ordering): dataset_id is the
            # Dataset primary key, so a concurrent create of the same NEW id
            # conflicts here and only ONE ingest is enqueued. If the enqueue then
            # fails, the rollback below removes the row again — but ONLY when this
            # request created it (a pre-existing same-owner row from a prior create
            # survives, PR19-3). Ownership lives ONLY in app-state — never in the
            # manifest or dataset tree.
            row_created_here = existing_owner is None
            await appstate.record_dataset_owner(session, body.dataset_id, owner)

            # output_root is DATA_ROOT/datasets/ (decision D-30): the worker writes
            # {output_root}/{ds_id}/, exactly where the read path serves it from (the
            # shared dataset volume) — disjoint from the upload jails under
            # DATA_ROOT/users/.
            try:
                # enqueue_ingest is a BLOCKING Redis round-trip (rq is sync); run it
                # off the event loop, exactly as the surrounding dataset_lock already
                # does for its own acquire/release (same hazard, same client).
                job_id = await run_in_threadpool(
                    queue.enqueue_ingest,
                    request.app.state.queue,
                    dataset_id=body.dataset_id,
                    owner=owner,
                    images_dir=str(bundle / _IMAGES_SUBDIR),
                    output_root=str(db.datasets_root()),
                    layout_types=body.layout_types,
                    csv_path=str(csv_path) if csv_path is not None else None,
                    column_roles=body.column_roles,
                )
            except Exception as exc:
                # Broad catch BY DESIGN (PR19-3): any enqueue failure (broker down,
                # timeout, ...) must roll back an owner row this request just created
                # — otherwise the id is squatted with no job — and answer 503. Logged
                # with the traceback, never swallowed silently; a retry after the
                # queue recovers passes the checks above and re-enqueues.
                logger.exception(
                    "Enqueue failed for dataset %r; rolling back owner row created here=%s",
                    body.dataset_id,
                    row_created_here,
                )
                if row_created_here:
                    await appstate.delete_dataset_record(session, body.dataset_id)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="ingest queue unavailable",
                ) from exc

            # Record the job id AFTER the successful enqueue (D-28): powers the
            # derived processing/error status and the delete-while-running 409.
            await appstate.record_dataset_job(session, body.dataset_id, job_id)
    except LockUnavailableError as exc:
        logger.warning(
            "Could not acquire dataset lock for create of %r: %s", body.dataset_id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return CreateDatasetResponse(dataset_id=body.dataset_id, job_id=job_id)


@router.patch("/api/datasets/{ds_id}/presentation")
async def update_dataset_presentation(
    ds_id: str,
    body: DatasetPresentationUpdate,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> DatasetSummaryPresentation:
    """Set a collection's display name and/or attribution (Part B). Owner-only.

    PARTIAL BY KEY PRESENCE, not by value: `model_fields_set` is pydantic's record of
    which keys the CLIENT actually sent, which is the only way to tell "field absent
    — leave it alone" from "field present and null — clear it" (the parsed value is
    None either way). Without that distinction a rename could never be UNDONE, and a
    bad name would be permanent. Blank strings clear too, so the UI's empty input does
    the obvious thing.

    (Reading the raw body via a second `Body(...)` parameter would ALSO work, but
    FastAPI then treats the endpoint as taking an EMBEDDED body — `{"body": …,
    "raw": …}` — and every ordinary request 422s. `model_fields_set` needs no second
    parameter and cannot drift from what was parsed.)

    Presentation ONLY. `dataset_id` is untouched — it stays the app-state primary
    key, the on-disk directory name, the tile path and the deep-link target, so a
    rename can never strand a link someone has already shared.

    Statuses mirror the delete path so authorization reads consistently across
    writes: unknown to app-state → 404; recorded but not yours → 403. A CLI-seeded
    tree app-state has never heard of has no owner to check against, so it is 404
    here (not 403): with no record there is nothing to name.
    """
    # `model_fields_set` IS the set of keys the client sent — exactly the signal
    # set_dataset_presentation consumes, so it passes straight through with no per-field
    # parameters or booleans (PR250-6).
    updates = {
        field: getattr(body, field)
        for field in appstate.PRESENTATION_LIMITS
        if field in body.model_fields_set
    }
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"provide at least one of: {sorted(appstate.PRESENTATION_LIMITS)}",
        )
    record = await appstate.get_dataset_record(session, ds_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    if record.owner != user.username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not the dataset owner"
        )
    try:
        applied = await appstate.set_dataset_presentation(session, ds_id, updates)
    except appstate.PresentationValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc
    if not applied:
        # The app-state row was removed between the owner check above and the write —
        # a concurrent DELETE, since no per-dataset lock is held on this path. Answer
        # the same 404 as an unknown dataset rather than echoing a rename that did not
        # persist (set_dataset_presentation returns False for a vanished row).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    updated = await appstate.get_dataset_record(session, ds_id)
    # Echo the stored values generically over PRESENTATION_LIMITS (PR250-6), so a new
    # presentation field is carried here by growing that one table — no hand-listed line
    # per field, matching the input side of this same handler.
    return DatasetSummaryPresentation(
        dataset_id=ds_id,
        **{
            field: getattr(updated, field) if updated is not None else None
            for field in appstate.PRESENTATION_LIMITS
        },
    )


@router.delete("/api/datasets/{ds_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    ds_id: str,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> Response:
    """Delete an owned dataset: its directory under DATA_ROOT/datasets/ (D-30) and
    its app-state record (D-28). EVERY check passes before anything is removed:

      1. `ds_id` is jailed through db.dataset_dir (we are about to rmtree from a
         client-supplied id — reject `..`/absolute/root before any fs touch);
      2. unknown everywhere (no manifest, no app-state record) → 404;
      3. recorded but not yours → 403; on disk with NO record (CLI-seeded,
         reconciliation #14) → 403 — unowned datasets are not web-deletable;
      4. last recorded job still queued|started in RQ → 409;
      5. only then, holding the per-dataset lock: detach the dataset dir (if present)
         with an atomic rename + delete the record; the detached tree is rmtree'd
         off the event loop AFTER the lock releases (PR #38 review #2).

    If the detach itself fails — e.g. the dir is a read-only / bind-mounted fixture
    (docker-compose ':ro') whose mount point cannot be renamed — the record is left
    intact and a clean 409 is returned rather than a raw 500 (T2-91; the T2-65
    "never a bare error" principle). The record delete runs ONLY after a successful
    detach, so a failed detach leaves the dataset fully present and still owned — a
    consistent state an operator resolves on the server.

    No username-collision guard (the interim PR24-2/DELETE-side 409s are retired by
    D-30): the dir removed is DATA_ROOT/datasets/{ds_id}/, structurally disjoint
    from the upload jails under DATA_ROOT/users/, so deleting a dataset whose id
    equals a username can never touch that user's uploads.
    """
    data_root = db.resolve_data_root()
    ds_dir = db.dataset_dir(data_root, ds_id)  # ★ jail before ANY filesystem touch

    # PR24-8 (DP-4): hold the per-`dataset_id` API-mutation lock around the
    # check→detach→record-delete critical section, so a concurrent create/re-ingest
    # of the SAME id cannot interleave (record an owner + enqueue while we are
    # tearing the dataset down). The 409 contract is unchanged — the lock only
    # orders these sections; it does not change which status any caller sees. The
    # ds_id jail above already ran, so the lock key is on a validated id. A
    # PEER-HELD lock answers 503 rather than deleting unserialized; a Redis OUTAGE
    # degrades to a lockless delete instead (best_effort_when_down, PR #38 review
    # finding 1) — D-28 binds "a dataset must stay deletable when Redis is down",
    # and with the broker gone no concurrent enqueue can race.
    tombstone: Path | None = None
    try:
        async with queue.dataset_lock(
            request.app.state.redis, ds_id, best_effort_when_down=True
        ):
            record = await appstate.get_dataset_record(session, ds_id)
            if record is None:
                if not db.is_dataset(ds_dir):
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Dataset not found",
                    )
                # On disk but never registered through the web API (CLI-seeded).
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="dataset has no web owner; manage it on the server",
                )
            if record.owner != user.username:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Not the dataset owner",
                )

            state = await _resolve_job_state(
                request.app.state.queue.connection, record.last_job_id
            )
            if state in _ACTIVE_JOB_STATES:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="An ingest job for this dataset is still running",
                )

            if ds_dir.is_dir():
                # PR #38 review finding 2: DETACH the tree with an atomic O(1) rename
                # INSIDE the lock, then rmtree it AFTER releasing (below). The lock
                # auto-expires after _LOCK_TIMEOUT_SECONDS; a recursive rmtree of a
                # 100k–1M-cell tree can exceed that, and were the lock to lapse
                # mid-rmtree a concurrent create could interleave — the very race
                # this lock closes. A rename keeps the locked section O(1) regardless
                # of dataset size. The tombstone sits directly under DATA_ROOT — a
                # sibling of datasets_root()/users_root() — so list_datasets (which
                # scans only datasets_root) never surfaces a half-deleted tree. D-30
                # still holds: ds_dir is jailed under DATA_ROOT/datasets/, disjoint
                # from the upload jails, so no rename can alias a user's namespace.
                tombstone = _dataset_tombstone(data_root, ds_id)
                try:
                    await run_in_threadpool(ds_dir.rename, tombstone)
                except OSError as exc:
                    # T2-91: the dataset dir could not be detached. The common cause
                    # is a read-only / bind-mounted fixture (docker-compose ':ro',
                    # e.g. golden_dataset_v2): its mount point cannot be renamed, so
                    # rename() faults EBUSY/EXDEV/EPERM. Translate the raw OSError into
                    # a clean 409 (T2-65: never surface a bare error/500) instead of
                    # letting it propagate unhandled. delete_dataset_record has NOT run
                    # yet (it is reached only after a successful detach), so the
                    # dataset stays fully present AND owned — a consistent state an
                    # operator can remove on the server. No tombstone was created (the
                    # rename moved nothing), so nothing is left for the sweep.
                    logger.warning(
                        "Cannot delete dataset %r: detaching %s failed: %s",
                        ds_id,
                        ds_dir,
                        exc,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=(
                            "This dataset cannot be deleted (it may be a read-only "
                            "fixture mounted into the container); remove it on the "
                            "server"
                        ),
                    ) from exc
            await appstate.delete_dataset_record(session, ds_id)
    except LockUnavailableError as exc:
        logger.warning("Could not acquire dataset lock for delete of %r: %s", ds_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc

    # Outside the lock: the actual recursive delete, run OFF the event loop (it is the
    # one unbounded fs op here). The tree is already detached (unreachable by id) and
    # the app-state record is gone, so a failure here only leaves a tombstone for a
    # sweep to reap — the dataset is already gone and 204 is honest. (Startup
    # tombstone sweep tracked in PROJECT_STATUS as PR38-2.)
    if tombstone is not None:
        try:
            await run_in_threadpool(shutil.rmtree, tombstone)
        except OSError:
            logger.warning(
                "Deferred rmtree of tombstone %s failed; leaving for sweep", tombstone
            )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
