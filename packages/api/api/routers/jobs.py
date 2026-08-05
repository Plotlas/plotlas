"""POST /api/datasets/{ds_id}/ingest, POST /api/datasets/{ds_id}/layouts,
GET /api/jobs/{job_id}.

Enqueue dispatches via queue.py (dotted-path string); the ingest never runs
inline. get_job merges RQ job state with the tail of ingest.log so the UI has a
fallback if the RQ status mechanism is unavailable. Does not import another
router.

Re-ingest (`start_ingest`) is images-only by contract: `IngestRequest` carries no
column-roles channel, and the pipeline rejects a metadata source without roles
(ingest.ingest_metadata), so a CSV in the bundle is intentionally not forwarded
here — `csv_path`/`column_roles` are both None (decision D-25). A metadata
(re)ingest goes through create_dataset, which does carry `column_roles`. This is a
known Phase-1 limitation.

Add-layouts (`add_layouts`, T2-58/T2-42) bakes ADDITIONAL layouts onto an
already-committed dataset without a full re-ingest, enqueuing
`pipeline.worker.run_add_layouts_job`. It mirrors `start_ingest`'s ownership /
409-while-running / per-dataset-lock structure and, like re-ingest, resolves its
`images_dir` from the caller's finalized upload bundle (the original source images
the pipeline's id-integrity guard checks against the committed dataset) — never a
client-supplied server path.
"""

from __future__ import annotations

import logging
import re
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from redis.exceptions import RedisError
from rq.exceptions import NoSuchJobError  # type: ignore[import-untyped]
from rq.job import Job  # type: ignore[import-untyped]
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db, queue
from api.models import (
    AddLayoutsRequest,
    AddLayoutsResponse,
    IngestRequest,
    IngestResponse,
    JobProgress,
    JobStatus,
)
from api.queue import LockUnavailableError

logger = logging.getLogger(__name__)

router = APIRouter()

# How many trailing lines of ingest.log to surface as the status fallback signal.
_LOG_TAIL_LINES = 50

# RQ states that mean "a job is in flight" for this dataset (D-28): add-layouts
# refuses with 409 while one is queued|started, matching DELETE's in-flight guard in
# datasets.py. Anything else — failed, finished, a missing/expired job, or an
# unreachable broker (mapped to None below) — is not in flight. Routers may not
# import one another (module-map rule), so this mirrors datasets._ACTIVE_JOB_STATES
# rather than sharing it.
_ACTIVE_JOB_STATES = {"queued", "started"}

# Bundle-layout constants, mirrored from uploads.py. The routers may not import one
# another (module-map rule), so the few path conventions are re-derived here.
_IMAGES_SUBDIR = "images"
_FINALIZED_MARKER = ".finalized"

# upload_id charset — IDENTICAL to uploads.py `_UPLOAD_ID_RE` (routers may not import
# one another, so the same anchored pattern is re-derived rather than shared). The
# `^...+$` anchoring means a traversal/separator — OR the empty string — can never be
# a valid id; db.resolve_under backstops on the filesystem. (Previously a local
# predicate here diverged by ACCEPTING the empty string.)
_UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


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


def _latest_finalized_bundle(owner: str) -> Path:
    """The owner's most recently finalized upload bundle (by marker mtime). 404 if
    the owner has no finalized upload — the default re-ingest source per the
    catalogue (`IngestRequest.upload_id` defaults to last). Anchored under
    db.users_root() (DATA_ROOT/users/{owner}/uploads/, decision D-30)."""
    uploads_root = db.resolve_under(db.users_root(), owner, "uploads")
    finalized = (
        [
            d
            for d in uploads_root.iterdir()
            if d.is_dir()
            and (d / _IMAGES_SUBDIR).is_dir()
            and (d / _FINALIZED_MARKER).exists()
        ]
        if uploads_root.is_dir()
        else []
    )
    if not finalized:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No finalized upload found"
        )
    return max(finalized, key=lambda d: (d / _FINALIZED_MARKER).stat().st_mtime)


def _read_log_tail(output_root: str, dataset_id: str) -> list[str]:
    """Last N lines of {output_root}/{ds_id}/ingest.log, or [] if not yet written.
    A bounded deque keeps only the last N lines in memory rather than reading the
    whole file. `output_root`/`dataset_id` come from the job's own enqueue kwargs
    (server-set from resolved paths), not directly from the client."""
    log_path = Path(output_root) / dataset_id / "ingest.log"
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as fh:
            tail = deque(fh, maxlen=_LOG_TAIL_LINES)
    except OSError:
        return []
    return [line.rstrip("\n") for line in tail]


def _short_error(exc_info: str | None) -> str | None:
    """The last non-empty line of RQ's stored traceback — the exception message."""
    if not exc_info:
        return None
    lines = [line for line in exc_info.strip().splitlines() if line.strip()]
    return lines[-1] if lines else None


def _read_progress(job: Any) -> JobProgress | None:
    """The live per-stage progress from RQ ``job.meta["progress"]`` (Seam O1), or None
    for a pre-O1 job (no ``progress`` key) or an unparseable/legacy meta. Best-effort —
    progress is ADVISORY, so a malformed meta must never fail the (continuously polled)
    job route. ``refresh=False``: ``Job.fetch`` already loaded ``meta`` (``job.restore``),
    so this adds NO Redis round-trip, mirroring datasets.py's ``get_status(refresh=False)``."""
    try:
        meta = job.get_meta(refresh=False) or {}
    except Exception:
        return None
    raw = meta.get("progress")
    if not isinstance(raw, dict):
        return None
    try:
        return JobProgress.model_validate(raw)
    except ValidationError:
        return None


def _job_state(connection: Any, job_id: str) -> str | None:
    """The RQ state of `job_id` in ONE round-trip, or None for a missing/expired job
    OR an unreachable broker (logged once, never silent). SYNCHRONOUS (rq is sync) —
    always invoke via `run_in_threadpool` so the blocking Redis I/O never runs on the
    event loop. Mirrors datasets._job_states for the single-id 409-while-running guard
    (routers may not import one another). None reads as "not in flight" — the
    add-layouts 409 guard stands down when the job is gone or Redis is down, matching
    DELETE's posture (a dataset must stay manageable when the broker is unavailable)."""
    try:
        job = Job.fetch(job_id, connection=connection)
    except NoSuchJobError:
        return None
    except RedisError as exc:
        logger.warning("RQ unreachable while checking job %r: %s", job_id, exc)
        return None
    raw_status = job.get_status()
    return str(getattr(raw_status, "value", raw_status)) if raw_status is not None else None


async def _resolve_active_job_state(connection: Any, job_id: str | None) -> str | None:
    """One id's RQ state, off the event loop (None when there is no recorded job)."""
    if job_id is None:
        return None
    return await run_in_threadpool(_job_state, connection, job_id)


@router.post("/api/datasets/{ds_id}/ingest")
async def start_ingest(
    ds_id: str,
    body: IngestRequest,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> IngestResponse:
    """Re-ingest a dataset the caller owns. Resolves the bundle (by
    `body.upload_id`, else the caller's latest finalized one), enqueues an
    images-only ingest by dotted string, and returns the job id. Ownership is
    resolved per-request from app-state (D-23/D-24): writes are owner-only even
    though Phase-1 reads are owner-open."""
    # Jail ds_id before it becomes the worker's output dir ({output_root}/{ds_id},
    # output_root = DATA_ROOT/datasets/, D-30); the worker trusts server-set kwargs,
    # so the API is the jail. Defense in depth — an owned dataset can no longer carry
    # a "."/".." id (create_dataset jails it), but validate here too rather than rely
    # on that invariant. Keep ds_dir to disambiguate "unowned but on disk" below.
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)

    # Ownership resolution (D-23/D-24): unowned-on-disk → 403 with the server
    # assign-owner hint (T2-65); absent → 404; foreign owner → 403. Shared with
    # add_layouts so the two write paths never diverge.
    owner = await _resolve_owned_dataset(session, ds_id, ds_dir, user.username)

    if body.upload_id is not None:
        bundle = _resolve_finalized_bundle(owner, body.upload_id)
    else:
        bundle = _latest_finalized_bundle(owner)

    # PR24-8 (DP-4): the enqueue → record_dataset_job sequence is the re-ingest
    # critical section. Hold the per-`dataset_id` API-mutation lock across it so a
    # concurrent DELETE of the SAME id cannot interleave (rmtree + drop the row while
    # we enqueue a re-ingest against it). The 409/503 contract is unchanged — the
    # lock only orders these sections; an acquire failure answers 503 just like a
    # broker outage below.
    try:
        async with queue.dataset_lock(request.app.state.redis, ds_id):
            try:
                # enqueue_ingest is a BLOCKING Redis round-trip (rq is sync); run it
                # off the event loop, exactly as the surrounding dataset_lock already
                # does for its own acquire/release (same hazard, same client).
                job_id = await run_in_threadpool(
                    queue.enqueue_ingest,
                    request.app.state.queue,
                    dataset_id=ds_id,
                    owner=owner,
                    images_dir=str(bundle / _IMAGES_SUBDIR),
                    output_root=str(db.datasets_root()),  # DATA_ROOT/datasets/ (D-30)
                    layout_types=(
                        body.layout_types if body.layout_types is not None else ["grid"]
                    ),
                    csv_path=None,  # re-ingest is images-only (no roles channel) — D-25
                    column_roles=None,
                    detail_tier=body.detail_tier,  # T2-46 opt-out (default "bake")
                )
            except Exception as exc:
                # Mirror create_dataset's enqueue handling (PR24-5): a broker outage
                # on re-ingest answers a clean 503, not an opaque 500. Re-ingest
                # creates no owner row (it requires an already-owned dataset), so
                # there is nothing to roll back — just translate the failure. Logged
                # with the traceback.
                logger.exception("Re-ingest enqueue failed for dataset %r", ds_id)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="ingest queue unavailable",
                ) from exc
            # D-28: track the NEW job on the dataset row after a successful enqueue —
            # it drives the derived processing/error status and the
            # delete-while-running 409. The row exists (the ownership check above
            # 404'd otherwise).
            await appstate.record_dataset_job(session, ds_id, job_id)
    except LockUnavailableError as exc:
        logger.warning("Could not acquire dataset lock for re-ingest of %r: %s", ds_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return IngestResponse(job_id=job_id)


async def _resolve_owned_dataset(
    session: AsyncSession, ds_id: str, ds_dir: Path, username: str
) -> str:
    """Resolve the app-state owner of `ds_id` for an owner-only WRITE, raising the
    exact ownership contract `start_ingest` uses (D-23/D-24): unowned but on disk
    (CLI-seeded) → 403 with the server assign-owner hint (T2-65); genuinely absent →
    404; recorded but owned by someone else → 403 "Not the dataset owner". Returns the
    owner on success. Shared by re-ingest and add-layouts so the two never diverge."""
    owner = await appstate.get_dataset_owner(session, ds_id)
    if owner is None:
        # No app-state owner. A CLI-seeded dataset (pixscope ingest) writes only the
        # tree — the pipeline cannot touch app-state (D-15/D-22) — so it exists on
        # disk with no owner row. On disk + unowned → 403 (an operator assigns
        # ownership on the server); truly absent → 404. The web-claim model was
        # rejected (T2-65); ownership assignment is a server-side command.
        if db.is_dataset(ds_dir):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "dataset has no owner; an operator can assign one on the "
                    "server: docker compose exec api python -m api.admin "
                    f"assign-owner {ds_id} <username>"
                ),
            )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    if owner != username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not the dataset owner"
        )
    return owner


@router.post("/api/datasets/{ds_id}/layouts")
async def add_layouts(
    ds_id: str,
    body: AddLayoutsRequest,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> AddLayoutsResponse:
    """Bake ADDITIONAL layouts onto a dataset the caller owns, without a full
    re-ingest (T2-58/T2-42). Resolves the ORIGINAL source images from the caller's
    finalized upload bundle (`body.upload_id`, else the latest) — the pipeline's
    id-integrity guard checks them against the committed dataset — enqueues
    `pipeline.worker.run_add_layouts_job` by dotted string with primitive kwargs, and
    returns the job id. Mirrors `start_ingest`: ownership resolves per-request from
    app-state (owner-only writes, D-23/D-24), an in-flight job answers 409, and the
    enqueue → record_dataset_job sequence runs inside the per-dataset mutation lock.

    The bundle is the SAME finalized-upload source re-ingest uses (never a
    client-supplied server path — AGENT_GUIDE). A dataset with NO finalized bundle
    (e.g. CLI-seeded) cannot add layouts through the web — its owner must re-upload the
    original images or run `pixscope add-layouts` on the server — so a missing bundle
    surfaces as 409 (via the shared bundle resolver's 404 translated below), not a
    500. `column_roles` (optional) is forwarded verbatim; the pipeline validates it.
    """
    # Jail ds_id before it becomes the worker's output dir ({output_root}/{ds_id},
    # output_root = DATA_ROOT/datasets/, D-30); the worker trusts server-set kwargs, so
    # the API is the jail. Keep ds_dir to disambiguate "unowned but on disk" (403 hint)
    # from genuinely-absent (404) in the shared ownership resolver.
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    owner = await _resolve_owned_dataset(session, ds_id, ds_dir, user.username)

    # add-layouts needs the ORIGINAL images (the id-integrity guard). Resolve them from
    # the owner's finalized upload bundle exactly as re-ingest does. A dataset that was
    # seeded on the server (CLI ingest) has no upload bundle in the owner's jail: the
    # resolver 404s, which for THIS operation means "the original images aren't
    # available to re-derive layouts from" — translate that to a 409 with actionable
    # guidance rather than a bare upload 404 or an opaque 500.
    try:
        if body.upload_id is not None:
            bundle = _resolve_finalized_bundle(owner, body.upload_id)
        else:
            bundle = _latest_finalized_bundle(owner)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_404_NOT_FOUND:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "add-layouts needs the original source images, resolved from a "
                    "finalized upload bundle. None was found for this owner — re-upload "
                    "the dataset's original images (then retry), or run `pixscope "
                    "add-layouts` on the server for a CLI-seeded dataset."
                ),
            ) from exc
        raise

    # 409-while-running: mirror DELETE's in-flight guard (datasets.py). A layout bake is
    # itself a job; refuse to stack a second one (or run over a still-committing
    # re-ingest) while the last recorded job is queued|started. A missing job / broker
    # outage reads as "not in flight" and does not block (the job's own commit lock is
    # the correctness backstop; this 409 is the friendly guard).
    record = await appstate.get_dataset_record(session, ds_id)
    state = await _resolve_active_job_state(
        request.app.state.queue.connection,
        record.last_job_id if record is not None else None,
    )
    if state in _ACTIVE_JOB_STATES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An ingest job for this dataset is still running",
        )

    # The enqueue → record_dataset_job sequence is the add-layouts critical section.
    # Hold the per-`dataset_id` API-mutation lock across it so a concurrent DELETE of
    # the SAME id cannot interleave (rmtree + drop the row while we enqueue). The
    # 409/503 contract is unchanged — the lock only orders these sections.
    try:
        async with queue.dataset_lock(request.app.state.redis, ds_id):
            try:
                # enqueue_add_layouts is a BLOCKING Redis round-trip (rq is sync); run
                # it off the event loop, as the surrounding dataset_lock does for its
                # own acquire/release (same hazard, same client).
                job_id = await run_in_threadpool(
                    queue.enqueue_add_layouts,
                    request.app.state.queue,
                    dataset_id=ds_id,
                    owner=owner,
                    images_dir=str(bundle / _IMAGES_SUBDIR),
                    output_root=str(db.datasets_root()),  # DATA_ROOT/datasets/ (D-30)
                    layout_specs=body.layout_specs,
                    column_roles=body.column_roles,
                )
            except Exception as exc:
                # Mirror re-ingest's enqueue handling: a broker outage answers a clean
                # 503, not an opaque 500. add-layouts creates no owner row (it requires
                # an already-owned dataset), so there is nothing to roll back — just
                # translate the failure. Logged with the traceback.
                logger.exception("add-layouts enqueue failed for dataset %r", ds_id)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="ingest queue unavailable",
                ) from exc
            # D-28: track the NEW job on the dataset row after a successful enqueue.
            # The row is guaranteed — the ownership check above 404'd an absent
            # app-state record via _resolve_owned_dataset (an owner implies a row).
            await appstate.record_dataset_job(session, ds_id, job_id)
    except LockUnavailableError as exc:
        logger.warning("Could not acquire dataset lock for add-layouts of %r: %s", ds_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return AddLayoutsResponse(job_id=job_id)


def _build_job_status(connection: Any, job_id: str) -> JobStatus:
    """Fetch the RQ job and merge its state, the live per-stage progress from
    ``job.meta`` (Seam O1), and the tail of ingest.log into a JobStatus. SYNCHRONOUS
    (two Redis round-trips — Job.fetch + get_status — plus the ingest.log tail read),
    so the route runs it via ``run_in_threadpool``: the frontend POLLS this endpoint
    throughout every ingest, and running the blocking I/O inline on the event loop
    made the API stutter continuously during a bake (every concurrent request,
    including the pyramid range-reads, froze behind each poll). Thread-safety: the
    per-worker redis-py client (lifespan ``Redis.from_url``) is a thread-safe
    connection pool — datasets.py already runs Job.fetch_many on this same connection
    in the threadpool — and the log read opens a fresh per-call file handle. Raises
    NoSuchJobError for a missing/expired job (the route maps it to 404)."""
    job = Job.fetch(job_id, connection=connection)
    raw_status = job.get_status()
    state = str(getattr(raw_status, "value", raw_status))  # RQ enum or str → str
    kwargs = job.kwargs or {}
    dataset_id = kwargs.get("dataset_id", "")
    output_root = kwargs.get("output_root")
    log_tail = (
        _read_log_tail(output_root, dataset_id)
        if output_root and dataset_id
        else []
    )
    return JobStatus(
        job_id=job_id,
        state=state,
        dataset_id=dataset_id,
        log_tail=log_tail,
        error=_short_error(job.exc_info) if state == "failed" else None,
        # Seam O1: merge the live per-stage progress the worker wrote to job.meta.
        progress=_read_progress(job),
    )


@router.get("/api/jobs/{job_id}")
async def get_job(
    job_id: str,
    request: Request,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> JobStatus:
    """Merges RQ job state, the live per-stage progress the worker wrote to
    ``job.meta`` (Seam O1 — ``JobStatus.progress``, null for a pre-O1 job), and the
    tail of ingest.log (a fallback if the RQ status/progress mechanism is
    unavailable). The dataset id + log location come from the job's own enqueue kwargs.

    The blocking RQ + log I/O runs OFF the event loop (``_build_job_status`` via
    ``run_in_threadpool``) — the endpoint is polled continuously during a bake, so its
    body must never block the loop (as an inline ``async def`` it stuttered every
    concurrent request, including the pyramid range-reads). The identity + app-state
    session deps resolve on the loop, and the may_read authorization runs on it too.

    D-34: a job's ``log_tail``/``error``/``dataset_id`` is readable only by the OWNER
    of the job's dataset, or if that dataset is PUBLIC — the SAME may_read gate as the
    dataset read routes, resolving the dataset from the job's own enqueue kwargs (this
    closes the app-scan MED-2 job-log leak). A denied read — or a job whose dataset is
    unknown/unreadable — returns the SAME 404 as a missing job, so a job's existence is
    not disclosed to a caller who cannot read its dataset (non-disclosure)."""
    try:
        job_status = await run_in_threadpool(
            _build_job_status, request.app.state.queue.connection, job_id
        )
    except NoSuchJobError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Job not found"
        ) from None
    if not await appstate.may_read(session, job_status.dataset_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Job not found"
        )
    return job_status
