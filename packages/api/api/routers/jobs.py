"""POST /api/datasets/{ds_id}/ingest, POST /api/datasets/{ds_id}/layouts,
DELETE /api/datasets/{ds_id}/layouts/{layout_id},
POST /api/datasets/{ds_id}/column-roles, GET /api/jobs/{job_id}.

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
409-while-running / per-dataset-lock structure and resolves its `images_dir` from a
finalized upload bundle (the original source images the pipeline's id-integrity
guard checks against the committed dataset) — never a client-supplied server path.
Unlike re-ingest, an UNNAMED default prefers THIS collection's own recorded
`source_upload_id` (seam L1) over the owner's newest upload — falling back to
"latest" here silently sources a bake from the wrong collection's images the moment
an owner has a second upload, which is exactly the defect
[[T2-a-designer-bake-sources-images-from-the-owner-s]] was filed to fix
(`_resolve_add_layouts_bundle`).

Seam L1 adds the two lifecycle writes the layout designer needs, both enqueuing verbs
seam L2 landed in the pipeline: `delete_layout` (`run_delete_layout_job`) and
`set_column_roles` (`run_set_roles_job`). Neither writes anything — the manifest has one
writer and it is the worker (D-15/D-xv) — so both are enqueues that return a job id, and
both carry the SAME ownership / 409-while-running / per-dataset-lock structure the two
routes above have (`_resolve_owned_dataset` and `_guard_no_job_in_flight` are shared
for exactly that reason — and `start_ingest` only gained the second in review round 3 of
PR #358; until then re-ingest had the lock but no 409). `add_layouts` gains the
`replace` passthrough that makes seam L2's `--replace` reachable from the web at all.

**Both new routes answer 202 Accepted, and they answer it for the same reason.** A 200
says "here is the result of what you asked for"; these have done none of the work when
they reply — they hand back a job id. Two routes with identical semantics and different
status codes is a trap for the client that has to drive both, so the code is a property
of the SEMANTICS (enqueue) and not of the verb. The legacy enqueue routes above
(`start_ingest`, `add_layouts`) still answer 200 for historical reasons — an old client
checking `== 200` would break — and are deliberately unchanged here; that inconsistency
is filed as [[T2-the-two-legacy-enqueue-routes-answer-200-while]].
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
    DeleteLayoutResponse,
    IngestRequest,
    IngestResponse,
    JobProgress,
    JobStatus,
    SetColumnRolesRequest,
    SetColumnRolesResponse,
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


def _read_job_result(job: Any, job_id: str, state: str) -> dict | None:
    """The worker verb's own return value (seam L1), read off the job
    ``_build_job_status`` already fetched — or None.

    Called only from the owner's gated hop (``_read_owner_fields``), made only AFTER
    the route has resolved the caller as the dataset's owner, and that is the point of
    it. `result` is narrower than `may_read`, so reading it inside `_build_job_status`
    fetched an owner-only payload (`swept` file lists, `stale_tag_sidecar`) into the
    response object for every anonymous poller of a public dataset's job, and only then
    set it back to `None`. A post-hoc `= None` makes the scoping a step that can be
    forgotten; a gated hop makes it structural — the value cannot cross the
    authorization boundary before the decision, because the decision is what triggers
    the read. It used to re-fetch the job for this; the second review of PR #405
    (finding 1) measured that at 2 `Job.fetch` calls per owner poll of a finished job,
    and it is 1 now.

    Read ONLY for a `finished` job, and that is a cost decision with a measurement
    behind it: `Job.return_value(refresh=False)` still calls `latest_result()` on first
    access, which is a REAL Redis round-trip against the `rq:results:` stream (rq 2.10
    source) — so calling it unconditionally would add one round-trip to every poll of an
    endpoint the frontend polls throughout every bake. A running job has no return value
    to read anyway, so gating on the terminal state costs nothing and confines the extra
    trips to the last poll or two, for the owner alone. Everybody else now pays NOTHING
    for a field they were never going to be shown.

    Only a MAPPING is surfaced. `run_ingest_job` returns a bare version string and the
    L2 verbs return dicts; a non-dict is not a shape any consumer can key into, so it is
    dropped rather than wrapped. Best-effort in every direction — a result that has
    expired, a broker hiccup, an unpickleable payload — because this is a REPORT on a
    write that already succeeded, and it must never fail the (continuously polled) job
    route. The warning is one terse line because it repeats on every poll; the
    traceback goes to DEBUG, for an operator who turns that on to find the cause.
    SYNCHRONOUS (rq is sync): runs inside the owner's threadpool hop."""
    if state != "finished":
        return None
    try:
        value = job.return_value(refresh=False)
    except Exception:  # noqa: BLE001 — advisory; never fail the poll on it
        # `job_id` is passed in rather than read off the job, so a job object that is
        # already misbehaving cannot turn a log line into a second exception.
        logger.warning("Unreadable return value for job %r", job_id)
        logger.debug("Why job %r's return value was unreadable", job_id, exc_info=True)
        return None
    return value if isinstance(value, dict) else None


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
    `body.upload_id`, else the caller's latest finalized one — refusing instead of
    guessing when that is ambiguous, see below), enqueues an images-only ingest by
    dotted string, and returns the job id. Ownership is resolved per-request from
    app-state (D-23/D-24): writes are owner-only even though Phase-1 reads are
    owner-open. An in-flight job answers 409, decided inside the per-dataset
    mutation lock (`_guard_no_job_in_flight`), as on every other write route here.

    An EXPLICITLY NAMED bundle becomes the dataset's recorded source (seam L1,
    `source_upload_id`): this route rebuilds the whole dataset from it, so it is
    where the collection's cells now come from.

    An UNNAMED re-ingest NEVER GUESSES, and never writes anything (review of PR
    #390, round 3, findings 1+2 — an independent second review, read from the diff
    alone with no test run, caught that ROUND 2's own fix was itself wrong):

    * **nothing recorded** (a pre-seam-L1 row, or a CLI-seeded dataset) → the
      owner's latest finalized bundle, unchanged from `main` — there is no fact
      about this collection to compare against, so `_latest_finalized_bundle`'s
      answer is used exactly as it always was (PR #358's own concern: a read-time
      guess here self-corrects, so it must never be persisted);
    * **recorded, and equal to** the owner's latest finalized bundle → proceed;
      nothing has changed, so the record needs no write and stays exactly as
      accurate as it already was;
    * **recorded, and DIFFERENT from** the owner's latest finalized bundle → 409,
      naming both, rather than silently doing either of the two wrong things a
      first and second draft of this fix each did in turn: rebuild from the
      unnamed bundle while the record still names the other one (the ORIGINAL
      defect, [[T2-a-designer-bake-sources-images-from-the-owner-s]] — round 2
      believed this only happened to a collection that had never baked, but round
      3's finding 2 found the SAME sequence reachable through a never-baked
      collection's retry, and finding 1 through an already-baked one whose owner
      simply re-ingested with nothing new to say), or CLEAR the record to make the
      guess "honest" (round 2's own fix, and itself a regression — finding 1: it
      erased a still-accurate record for no reason, reopening the exact same
      defect the moment the owner uploaded anything else). The caller must say
      which bundle they mean; this is the unnamed-re-ingest footgun
      ([[T2-103]]) surfacing as a refusal instead of a guess, and the frontend
      never calls this route unnamed in the first place (the designer's only path
      is `add_layouts`, which has its own, narrower default — see
      `_resolve_add_layouts_bundle`)."""
    # Jail ds_id before it becomes the worker's output dir ({output_root}/{ds_id},
    # output_root = DATA_ROOT/datasets/, D-30); the worker trusts server-set kwargs,
    # so the API is the jail. Defense in depth — an owned dataset can no longer carry
    # a "."/".." id (create_dataset jails it), but validate here too rather than rely
    # on that invariant. Keep ds_dir to disambiguate "unowned but on disk" below.
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)

    # Ownership resolution (D-23/D-24): unowned-on-disk → 403 with the server
    # assign-owner hint (T2-65); absent → 404; foreign owner → 403. Shared with
    # add_layouts (and delete-layout, set-roles) so the write paths never diverge.
    # Returns the FULL record — `record.source_upload_id` feeds the ambiguity check
    # below without a second app-state round-trip (review of PR #390, round 3,
    # finding 6).
    record = await _resolve_owned_dataset(session, ds_id, ds_dir, user.username)
    owner = record.owner

    if body.upload_id is not None:
        bundle = _resolve_finalized_bundle(owner, body.upload_id)
    else:
        bundle = _latest_finalized_bundle(owner)
        if record.source_upload_id is not None and record.source_upload_id != bundle.name:
            # AMBIGUOUS (review of PR #390, round 3, findings 1+2): this collection's
            # own recorded source and the owner's latest finalized upload disagree.
            # Refuse rather than pick a side — see the docstring above for why both
            # sides were tried and both were wrong. A raw STRING comparison, never a
            # filesystem resolution: even a malformed recorded id (should be
            # unreachable — every writer validates first, via
            # `_resolve_finalized_bundle`'s own check, before ever recording one)
            # safely reads as "different" here, which is the refuse-not-guess answer
            # either way — there is no failure mode where comparing an invalid string
            # produces a wrong ANSWER, only a possibly-confusing one, and the message
            # below names the exact value stored so the caller can tell.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    # "records ... as its source", not "was created from" (review
                    # round 4, finding 5): the recorded id is not always the CREATE
                    # bundle — a later EXPLICITLY NAMED re-ingest overwrites it, and
                    # this message must stay true then too.
                    f"this collection records upload "
                    f"{record.source_upload_id!r} as its source; the latest "
                    f"finalized upload is {bundle.name!r}. Name the upload_id you "
                    "want to re-ingest from."
                ),
            )

    # PR24-8 (DP-4): the enqueue → record_dataset_job sequence is the re-ingest
    # critical section. Hold the per-`dataset_id` API-mutation lock across it so a
    # concurrent DELETE of the SAME id cannot interleave (rmtree + drop the row while
    # we enqueue a re-ingest against it). The 409/503 contract is unchanged — the
    # lock only orders these sections; an acquire failure answers 503 just like a
    # broker outage below.
    try:
        async with queue.dataset_lock(request.app.state.redis, ds_id):
            # 409-while-running, INSIDE the lock — the same guard, in the same place,
            # as the other write routes here (see `_guard_no_job_in_flight`). Re-ingest
            # had none: the lock orders the critical sections but does not refuse, so a
            # re-ingest queued on top of a running delete-layout, set-roles or bake, and
            # its `record_dataset_job` overwrote the running job's id (review of PR #358,
            # round 3). A re-ingest rewrites the whole tree, so it is the LAST write that
            # should be allowed to stack.
            await _guard_no_job_in_flight(
                session, request.app.state.queue.connection, ds_id
            )
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
            # Seam L1: re-ingest REPLACES the dataset's source, so it replaces the
            # recorded bundle too — every cell in the dataset afterwards comes from THIS
            # bundle, so the previously recorded one no longer describes the collection
            # and `GET .../columns` must not keep answering from it. (Contrast
            # add-layouts, which resolves a bundle to re-read the ORIGINAL images for the
            # id-integrity guard and changes no source at all; it records nothing.)
            #
            # NAMED (`body.upload_id` a str) ONLY: records that id — a source the
            # caller CHOSE, so it is a fact about this collection, not a guess. An
            # UNNAMED re-ingest writes NOTHING here (review of PR #390, round 3): the
            # ambiguity check above already refused if the record disagreed with
            # `bundle`, so by the time execution reaches here either nothing was ever
            # recorded (still nothing to record — PR #358 finding 2 stands) or the
            # record already equals `bundle.name` (nothing changed, nothing to write).
            # NEVER clears, either — round 2's clear branch was itself a regression
            # (finding 1) and is gone; see this function's own docstring.
            if body.upload_id is not None:
                await appstate.record_dataset_source_upload(session, ds_id, body.upload_id)
                # Re-ingest is images-only by D-25 (`csv_path=None` above), so the
                # recorded bundle's CSV is metadata still AVAILABLE to map, not
                # metadata committed: once the bake commits, `GET .../columns`
                # answers the committed state (`images_only`), and that CSV is what
                # `?upload_id=` describes.
    except LockUnavailableError as exc:
        logger.warning("Could not acquire dataset lock for re-ingest of %r: %s", ds_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return IngestResponse(job_id=job_id)


async def _resolve_owned_dataset(
    session: AsyncSession, ds_id: str, ds_dir: Path, username: str
) -> appstate.DatasetRecord:
    """Resolve the app-state record of `ds_id` for an owner-only WRITE, raising the
    exact ownership contract `start_ingest` uses (D-23/D-24): unowned but on disk
    (CLI-seeded) → 403 with the server assign-owner hint (T2-65); genuinely absent →
    404; recorded but owned by someone else → 403 "Not the dataset owner". Returns the
    FULL record on success (not just the owner) — review of PR #390, round 3, finding
    6: `add_layouts`'s bundle resolution used to re-read the SAME row a second time
    (`appstate.get_dataset_record`) immediately after this function's own read, two
    round-trips of one fact that could in principle disagree between them. Callers
    that need `source_upload_id` now reuse the record already in hand instead. Shared
    by re-ingest, add-layouts, delete-layout and set-roles so none of the four
    diverge."""
    record = await appstate.get_dataset_record(session, ds_id)
    if record is None:
        # No app-state row at all. A CLI-seeded dataset (pixscope ingest) writes only
        # the tree — the pipeline cannot touch app-state (D-15/D-22) — so it exists on
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
    if record.owner != username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not the dataset owner"
        )
    return record


async def _guard_no_job_in_flight(
    session: AsyncSession, connection: Any, ds_id: str
) -> None:
    """409 if this dataset's last recorded job is queued|started; return otherwise.

    **CALL IT INSIDE `queue.dataset_lock`.** It reads `last_job_id` and the caller then
    writes it back through `record_dataset_job`, so read and write are one critical
    section: outside the lock, two concurrent writes both pass the guard, both enqueue,
    and the second `record_dataset_job` overwrites the first job id. The first job still
    RUNS — two manifest rewrites then race, held apart only by the worker's `_commit_lock`
    and its compare-and-set, so one fails with a refusal nobody is polling for, because
    `GET /api/jobs/{id}` is reachable only by a client that kept the id. `delete_dataset`
    (datasets.py), the fifth route with this check, has always taken it inside its lock;
    the four here now match it. `start_ingest` was the one write route here WITHOUT it —
    re-ingest could stack on any running job — until review round 3 of PR #358.

    Mirrors DELETE's in-flight guard (datasets.py). Every write in this router is
    itself a job, so none of them may stack a second one on — or run over a still-
    committing — bake. A missing job / broker outage reads as "not in flight" and does
    NOT block: the worker's own per-dataset commit lock (D-19) is the correctness
    backstop, and this 409 is the friendly guard, so a dataset must stay manageable when
    the broker is unavailable.

    Extracted when seam L1 added the third and fourth callers; `start_ingest` became the
    fifth. `_resolve_owned_dataset`
    right above it exists for the same reason and states it: the write paths must not
    diverge, and three hand-copies of a check that decides whether a bake can be
    clobbered is exactly how they would.

    The detail names no VERB. It was written when the guard had one caller and an ingest
    was the only thing it could be refusing; carried into the extraction it told a user
    deleting two layouts in a row to look for an ingest that does not exist. "Another
    job" is true for all five routes that answer it."""
    record = await appstate.get_dataset_record(session, ds_id)
    state = await _resolve_active_job_state(
        connection, record.last_job_id if record is not None else None
    )
    if state in _ACTIVE_JOB_STATES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Another job for this collection is still running",
        )


def _resolve_add_layouts_bundle(
    record: appstate.DatasetRecord, upload_id: str | None
) -> Path:
    """Resolve add-layouts' ORIGINAL-images bundle (never a client-supplied path;
    [[T2-a-designer-bake-sources-images-from-the-owner-s]]). Takes the CALLER's
    already-resolved `appstate.DatasetRecord` — `add_layouts` gets it from the SAME
    `_resolve_owned_dataset` call that already checked ownership, rather than this
    function re-reading app-state a second time (review of PR #390, round 3, finding
    6: the two reads were of the same row and could in principle disagree). SYNC, not
    async, now that it does no I/O of its own beyond the filesystem checks
    `_resolve_finalized_bundle`/`db.resolve_recorded_bundle` already do.

    An EXPLICIT `upload_id` resolves exactly as it always has — the caller named the
    bundle, so nothing about this collection's history matters.

    Unnamed, the order is:

    1. **This collection's own recorded `source_upload_id`** (seam L1), if it has one
       and that finalized bundle still exists in the owner's jail — resolved via
       `db.resolve_recorded_bundle` (shared with `routers/datasets.py::_recorded_bundle`;
       review of PR #390, round 3, findings 5+7: the two independently re-derived the
       same regex-and-jail-path check and had drifted apart in what they did with a
       malformed id). This is the fix: the designer's only way to start a bake
       (`addLayouts`) never sends `upload_id` (the client cannot know one), so before
       this the route fell back to step 3 below UNCONDITIONALLY — the owner's NEWEST
       upload, whatever collection it belonged to. Once an owner had a second upload,
       every add-layouts run on an older collection resolved the wrong images and
       failed the pipeline's id-integrity guard.
    2. **Recorded, but `db.resolve_recorded_bundle` returns None** — removed by hand
       (nothing sweeps a finalized bundle automatically today), unreachable because
       `api.admin assign-owner` moved this dataset to a DIFFERENT owner since the id
       was recorded (the bundle still exists, just under the PREVIOUS owner's jail),
       OR the recorded value fails the id charset (review of PR #390, round 3, finding
       5 — should be unreachable in practice, since every writer validates first, but
       treated the SAME as the other two rather than as "not recorded": add-layouts
       must never silently fall back to a guess once something WAS recorded, and a
       malformed value is still something recorded, just a broken one). Either way
       this function cannot tell which of the three, so the 409 below states only
       what is known and does not guess. NEVER falls through to step 3: doing so is
       exactly the defect this function exists to fix, just reached through a
       narrower door.
    3. **Nothing recorded** (`record.source_upload_id is None`) — a row that predates
       seam L1, or a CLI-seeded dataset later assigned an owner. `source_upload_id` is
       set only by `create_dataset` and an EXPLICITLY NAMED re-ingest, and — as of PR
       #390, round 3 — is NEVER cleared or overwritten by anything else: an unnamed
       re-ingest either proceeds because the record already agrees with what it
       resolves to, or refuses (409) when it does not (`start_ingest`); it never
       touches the column (review of PR #390, round 3, findings 1+2 — a round-2 draft
       of this fix cleared it instead, which was itself a regression). So `None` here
       means "never recorded", full stop — not "not recorded RIGHT NOW". Nothing ties
       such a collection to any one upload, so there is no "own" bundle to prefer:
       keep today's behaviour exactly, the owner's latest finalized bundle.

    A 404 from either resolution (no bundle exists at all) is left for the caller to
    translate — same 409-with-guidance either way, so the two "nothing to bake from"
    outcomes read identically to the owner."""
    if upload_id is not None:
        return _resolve_finalized_bundle(record.owner, upload_id)
    if record.source_upload_id is None:
        return _latest_finalized_bundle(record.owner)
    resolved = db.resolve_recorded_bundle(record.owner, record.source_upload_id)
    if resolved is None:
        # State only what is KNOWN (review of PR #390, findings F3+F4 — unchanged by
        # round 3): NOT that the bundle was "cleaned up" — it might instead simply be
        # unreachable under a DIFFERENT owner's jail after `api.admin assign-owner`
        # moved this dataset's ownership (the recorded id is resolved under the
        # CURRENT owner, never the one who made it), and a wrong guess about the
        # cause is worse than none. NOT "name that upload explicitly" either — the
        # designer is the only caller of this route in practice and has no field for
        # `upload_id` to name anything with (that is this whole item's premise).
        #
        # The remedy named below is an explicit `upload_id` on THIS SAME route
        # (add-layouts), never a re-ingest (review round 4, finding 1 — a HIGH-severity
        # correction: an earlier draft of this message pointed at re-ingest instead,
        # and following it is destructive). Verified against `run_add_layouts`
        # (`pipeline/worker.py`): add-layouts' committed `metadata.parquet`, detail
        # tier and existing pyramids are READ-ONLY — an explicit `upload_id` here only
        # re-derives the id-integrity check's images and adds/re-bakes the requested
        # layouts, losing nothing. `start_ingest` (re-ingest) is the opposite: images
        # -only (`csv_path=None`) and `layout_types` defaults to `["grid"]`, so
        # re-ingesting to "fix" this REPLACES the whole collection with an images-only,
        # grid-only rebuild — every other layout and all metadata gone. The CLI escape
        # hatch is the one place re-ingest is not implied: `pixscope add-layouts` is
        # this same lossless verb, not `pixscope ingest`.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"this collection's recorded upload ({record.source_upload_id!r}) is "
                "not in this owner's uploads. Add layouts again naming an upload_id "
                "you have, to point this bake at it — do not re-ingest to fix this: "
                "re-ingest rebuilds the whole collection images-only and grid-only, "
                "discarding its metadata and every other layout. Or run `pixscope "
                "add-layouts` (not `pixscope ingest`) on the server."
            ),
        )
    return resolved


@router.post("/api/datasets/{ds_id}/layouts")
async def add_layouts(
    ds_id: str,
    body: AddLayoutsRequest,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> AddLayoutsResponse:
    """Bake ADDITIONAL layouts onto a dataset the caller owns, without a full
    re-ingest (T2-58/T2-42). Resolves the ORIGINAL source images — the pipeline's
    id-integrity guard checks them against the committed dataset — enqueues
    `pipeline.worker.run_add_layouts_job` by dotted string with primitive kwargs, and
    returns the job id. Mirrors `start_ingest`: ownership resolves per-request from
    app-state (owner-only writes, D-23/D-24), an in-flight job answers 409, and the
    enqueue → record_dataset_job sequence runs inside the per-dataset mutation lock.

    `replace` (seam L1) opts IN, per layout_id, to RE-BAKING a committed layout instead
    of colliding with it — the Re-bake control a stale layout card offers (D-xxi).
    Absent or empty is today's behaviour EXACTLY, collision guard included.

    The bundle resolves via `_resolve_add_layouts_bundle` (never a client-supplied
    server path — AGENT_GUIDE): an explicit `body.upload_id` names it outright;
    unnamed, THIS collection's own recorded `source_upload_id` (seam L1) is preferred
    over the owner's newest upload — see that function for the full order and why
    ([[T2-a-designer-bake-sources-images-from-the-owner-s]]). A dataset with NO
    finalized bundle at all (e.g. CLI-seeded) cannot add layouts through the web —
    its owner must re-upload the original images or run `pixscope add-layouts` on
    the server — so a missing bundle surfaces as 409 (via the 404 translated below),
    not a 500. `column_roles` (optional) is forwarded verbatim; the pipeline
    validates it.
    """
    # Jail ds_id before it becomes the worker's output dir ({output_root}/{ds_id},
    # output_root = DATA_ROOT/datasets/, D-30); the worker trusts server-set kwargs, so
    # the API is the jail. Keep ds_dir to disambiguate "unowned but on disk" (403 hint)
    # from genuinely-absent (404) in the shared ownership resolver.
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    record = await _resolve_owned_dataset(session, ds_id, ds_dir, user.username)
    owner = record.owner

    # add-layouts needs the ORIGINAL images (the id-integrity guard); resolve them via
    # _resolve_add_layouts_bundle, which prefers THIS collection's own recorded bundle
    # over a guess about the owner's newest upload. A dataset that was seeded on the
    # server (CLI ingest) has no upload bundle in the owner's jail at all: the
    # resolver 404s, which for THIS operation means "the original images aren't
    # available to re-derive layouts from" — translate that to a 409 with actionable
    # guidance rather than a bare upload 404 or an opaque 500. (A RECORDED-but-not-
    # resolvable bundle already answers its own, more specific 409 inside the resolver
    # and is never seen here — its status code is 409, not 404, so the `== 404` check
    # below passes it straight through.)
    try:
        bundle = _resolve_add_layouts_bundle(record, body.upload_id)
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

    # The guard → enqueue → record_dataset_job sequence is the add-layouts critical
    # section. Hold the per-`dataset_id` API-mutation lock across it so a concurrent
    # DELETE of the SAME id cannot interleave (rmtree + drop the row while we enqueue),
    # and so the in-flight check below cannot be read by two writers at once. The
    # 409/503 contract is unchanged — the lock only orders these sections.
    try:
        async with queue.dataset_lock(request.app.state.redis, ds_id):
            # 409-while-running: mirror DELETE's in-flight guard (datasets.py). A layout
            # bake is itself a job; refuse to stack a second one (or run over a
            # still-committing re-ingest) while the last recorded job is queued|started.
            # A missing job / broker outage reads as "not in flight" and does not block
            # (the job's own commit lock is the correctness backstop; this 409 is the
            # friendly guard). INSIDE the lock, because it reads the same `last_job_id`
            # the enqueue below writes — see `_guard_no_job_in_flight`.
            await _guard_no_job_in_flight(
                session, request.app.state.queue.connection, ds_id
            )
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
                    # Seam L1: the per-id opt-in to re-baking a committed layout. `[]`
                    # (the default) is today's behaviour — the worker's collision guard
                    # still refuses every unnamed existing id. Forwarded verbatim; the
                    # worker validates each id against the EXPANDED layout ids, which
                    # is why there is no pre-check here (see queue.enqueue_add_layouts).
                    replace=list(body.replace),
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


@router.delete(
    "/api/datasets/{ds_id}/layouts/{layout_id}",
    status_code=status.HTTP_202_ACCEPTED,
)
async def delete_layout(
    ds_id: str,
    layout_id: str,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> DeleteLayoutResponse:
    """Remove ONE layout from a dataset the caller owns, by enqueuing seam L2's
    `pipeline.worker.run_delete_layout_job` (LAYOUT_DESIGNER D-xxii). Mirrors
    `add_layouts` exactly: ownership resolves per-request from app-state (owner-only
    writes, D-23/D-24), an in-flight job answers 409, and the enqueue →
    record_dataset_job sequence runs inside the per-dataset mutation lock.

    **202, not 200 or 204, and that is the point of the route.** `layout_manifest.json`
    is worker-written and only worker-written (D-15/D-xv), so removing an entry is a
    JOB — fast (no bake, no decode, one JSON rewrite and a directory sweep) but not
    synchronous. A DELETE answering 200/204 says "it is gone"; it is not, it is
    ENQUEUED, and the card has a transient *deleting* state precisely because of that.
    `set_column_roles` answers 202 for the identical reason — the status code is a
    property of the SEMANTICS (this enqueues) and not of the verb, so the two routes
    added together agree. The LEGACY enqueue routes (`start_ingest`, `add_layouts`)
    answer 200 for historical reasons and are deliberately NOT changed here — an old
    client checking `== 200` would break; filed as
    [[T2-the-two-legacy-enqueue-routes-answer-200-while]].

    Two refusals are answered here rather than in the worker, because the API already
    holds the manifest they are decided from and a job that is GUARANTEED to fail is a
    worse answer than a refusal:

    * an id that names no committed layout → 404, the SAME 404
      `get_layout_manifest` already gives that id on the read side;
    * the LAST remaining layout → 409. `layouts` is `minItems: 1` in the frozen schema
      and a `default_layout` must resolve (D-viii), so this can never succeed; deleting
      the whole collection is the verb for it.

    The worker re-checks both under its commit lock and stays the authority — these are
    a fast fail on facts already in hand, not a second decision procedure."""
    # Jail ds_id before it becomes the worker's output dir ({output_root}/{ds_id},
    # D-30); the worker trusts server-set kwargs, so the API is the jail. `layout_id`
    # never touches a path API-side — it is checked against the manifest below and then
    # crosses as a primitive kwarg, and the worker resolves the sweep under its own root.
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    owner = (await _resolve_owned_dataset(session, ds_id, ds_dir, user.username)).owner

    manifest = db.load_manifest(ds_dir)  # 404 if the dataset has never committed a bake
    committed = [layout["layout_id"] for layout in manifest["layouts"]]
    if layout_id not in committed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found"
        )
    if len(committed) <= 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{layout_id!r} is the only layout of this collection and a collection "
                "must keep at least one. Bake another layout first, or delete the "
                "whole collection."
            ),
        )
    try:
        async with queue.dataset_lock(request.app.state.redis, ds_id):
            # INSIDE the lock: the guard reads `last_job_id` and the enqueue below
            # writes it, so the two are one critical section (see
            # `_guard_no_job_in_flight`). Two concurrent deletes of different layouts
            # both passed it outside, and the second job id clobbered the first.
            await _guard_no_job_in_flight(
                session, request.app.state.queue.connection, ds_id
            )
            try:
                # BLOCKING Redis round-trip (rq is sync); off the event loop, exactly as
                # the surrounding dataset_lock already is for its own acquire/release.
                job_id = await run_in_threadpool(
                    queue.enqueue_delete_layout,
                    request.app.state.queue,
                    dataset_id=ds_id,
                    owner=owner,
                    output_root=str(db.datasets_root()),  # DATA_ROOT/datasets/ (D-30)
                    layout_id=layout_id,
                )
            except Exception as exc:
                # Mirror add-layouts: a broker outage answers a clean 503, not an opaque
                # 500. Nothing to roll back — this path creates no row and writes no
                # tree. Logged with the traceback.
                logger.exception("delete-layout enqueue failed for dataset %r", ds_id)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="ingest queue unavailable",
                ) from exc
            # D-28: track the NEW job on the dataset row after a successful enqueue —
            # it drives the derived status and the delete-while-running 409. The row is
            # guaranteed (an owner implies a row; _resolve_owned_dataset 404'd otherwise).
            await appstate.record_dataset_job(session, ds_id, job_id)
    except LockUnavailableError as exc:
        logger.warning(
            "Could not acquire dataset lock for delete-layout of %r: %s", ds_id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return DeleteLayoutResponse(job_id=job_id)


@router.post(
    "/api/datasets/{ds_id}/column-roles",
    status_code=status.HTTP_202_ACCEPTED,
)
async def set_column_roles(
    ds_id: str,
    body: SetColumnRolesRequest,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> SetColumnRolesResponse:
    """RE-DECLARE a committed dataset's `column_roles` with NO bake, by enqueuing seam
    L2's `pipeline.worker.run_set_roles_job` — D-ix's declared-but-INVALIDATING tier,
    which until now had no write path at all
    ([[T2-a-role-cannot-be-changed-without-also-queueing]]: roles could only ride as a
    passenger on something expensive). Same shape as every other write here: owner-only
    (D-23/D-24), 409 while a job is in flight, enqueue → record_dataset_job inside the
    per-dataset mutation lock.

    **WHY THIS IS A POST AND NOT A `PATCH .../presentation`-SHAPED WRITE, which is the
    single most important thing about the route.** Roles are a MANIFEST fact — they
    describe what the bake consumed — and `layout_manifest.json` has exactly one writer,
    the worker (D-15/D-xv). So this cannot be a PATCH that saves, and it must not LOOK
    like one: `PATCH .../presentation` next door applies on change, costs nothing, and
    is the tier-1 vocabulary the designer teaches (D-xx, "if it is in the bar, it has a
    price"). A second PATCH beside it that silently enqueued a worker round trip and
    invalidated the user's layouts would be a trap built out of the resemblance. A POST
    returning a JOB ID says what actually happens.

    **202 Accepted, for the SAME reason `delete_layout` answers 202 — the code follows
    the semantics, not the verb.** Nothing has been re-declared when this replies: the
    roles live in `layout_manifest.json`, which is worker-written and only worker-written
    (D-15/D-xv), so all this route has done is enqueue. 200 would claim the edit had
    landed and the stale set were knowable, and neither is true yet. Two brand-new routes
    that enqueue identically must not differ in status code — that difference is exactly
    what a client driving both trips over. The LEGACY enqueue routes above (`start_ingest`,
    `add_layouts`) still answer 200 and are deliberately not changed:
    [[T2-the-two-legacy-enqueue-routes-answer-200-while]].

    The response is a job id ALONE. The stale set — which committed layouts this change
    invalidates — is computed by the worker AT THE COMMIT from `layoutEntry.source_columns`,
    which is strictly after this response is written, so the caller reads it from
    `GET /api/jobs/{job_id}` → `JobStatus.result.stale_layouts` (with `changed_columns`,
    `unknown_layouts`, `orphaned_layouts` and `renamed_layouts` beside it). It is L2's
    answer, handed over unmodified: recomputing it here would be a second oracle for a
    question the manifest already answers, and one that would have to re-derive the
    pre-2.9 `unknown` bucket to avoid silently clearing the flag on the oldest layouts.

    `column_roles` is the FULL replacement map and is forwarded VERBATIM — the worker
    re-validates it against the committed metadata.parquet with add-layouts' own checks
    (D-11 is the validator of record).

    TWO refusals are answered here rather than enqueued, both of them preconditions
    `run_set_roles` itself checks, because a job that is guaranteed to fail is a worse
    answer than a refusal (the rule `delete_layout` states) and because enqueuing one
    clobbers `last_job_id` on the way: a dataset with no committed bake yet (no manifest
    to re-declare roles in — roles for a first bake travel on the create payload), and a
    dataset with no committed `metadata.parquet` (nothing to validate roles against).
    Both 409 rather than 404: the dataset exists, and the caller can retry."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    owner = (await _resolve_owned_dataset(session, ds_id, ds_dir, user.username)).owner

    # set-roles REWRITES a committed manifest; a dataset whose first bake has not landed
    # has none. That is a real and reachable state (an app-state row exists from the
    # moment create_dataset enqueues), so it gets its own answer rather than the
    # worker's failure minutes later — and 409 rather than 404, because the dataset
    # exists and the caller can retry once the bake commits.
    if not db.is_dataset(ds_dir):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "this collection has no committed bake yet, so there is no manifest to "
                "re-declare roles in. Roles for a first bake are part of the create "
                "payload; retry once the ingest has committed."
            ),
        )
    # The SECOND precondition `run_set_roles` checks, answered here for the same reason
    # as the first: a manifest is not enough. Roles are validated against the committed
    # `metadata.parquet` (D-11 is the validator of record), so a tree without one makes
    # the job GUARANTEED to fail — and `delete_layout` above states the rule that breaks:
    # "a job that is GUARANTEED to fail is a worse answer than a refusal". Enqueuing it
    # also clobbers `last_job_id`, so the dataset reads `processing` and DELETE 409s
    # until the worker gets round to failing, and the caller learns why only by polling
    # `GET /api/jobs/{id}`.
    #
    # This is NOT the images-only case, and the message must not say it is: measured
    # 2026-09-09 by seam L2 and recorded in `worker.run_set_roles`, an images-only ingest
    # (D-25) DOES write a `metadata.parquet` — it holds id + filename and the manifest
    # simply omits `column_roles` (`tests/fixtures/golden_dataset_images_only_v2` is
    # exactly that shape). Such a tree passes this guard, reaches
    # `_validate_roles_against_parquet` and is refused PER ROLE with the columns it does
    # have named, which is the better message. What lands here is a tree missing the file
    # outright.
    if not (ds_dir / "metadata.parquet").is_file():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "this collection has no committed metadata.parquet, and column roles are "
                "validated against it — there is nothing to declare roles over. Re-ingest "
                "the collection from an upload bundle that carries a metadata source."
            ),
        )

    try:
        async with queue.dataset_lock(request.app.state.redis, ds_id):
            # INSIDE the lock: the guard reads `last_job_id` and the enqueue below writes
            # it, so the two are one critical section (see `_guard_no_job_in_flight`).
            await _guard_no_job_in_flight(
                session, request.app.state.queue.connection, ds_id
            )
            try:
                # BLOCKING Redis round-trip (rq is sync); off the event loop.
                job_id = await run_in_threadpool(
                    queue.enqueue_set_roles,
                    request.app.state.queue,
                    dataset_id=ds_id,
                    owner=owner,
                    output_root=str(db.datasets_root()),  # DATA_ROOT/datasets/ (D-30)
                    column_roles=body.column_roles,
                )
            except Exception as exc:
                # Mirror add-layouts: a broker outage answers a clean 503, not an opaque
                # 500. Nothing to roll back. Logged with the traceback.
                logger.exception("set-roles enqueue failed for dataset %r", ds_id)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="ingest queue unavailable",
                ) from exc
            await appstate.record_dataset_job(session, ds_id, job_id)
    except LockUnavailableError as exc:
        logger.warning(
            "Could not acquire dataset lock for set-roles of %r: %s", ds_id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return SetColumnRolesResponse(job_id=job_id)


def _read_owner_fields(
    job: Any, job_id: str, state: str
) -> tuple[list[str], str | None, dict | None]:
    """The job's three OWNER-ONLY fields, in ONE gated hop, off the job
    ``_build_job_status`` already fetched: the tail of its dataset's ingest.log, a
    failed job's exception message, and a finished job's return value
    (``_read_job_result``). The route makes this hop only after it has resolved the
    caller as the dataset's owner — decide, THEN read — so none of the three exists in
    the process for any other caller, and there is no post-hoc blanking step to forget.

    One hop, and no second ``Job.fetch``. They used to be two hops, and
    ``_read_job_result`` re-fetched the job. The second review of PR #405 (finding 1)
    measured it on an owner's poll of a finished job: 2 ``Job.fetch`` calls and 3
    threadpool dispatches before, 1 and 2 now
    (``test_the_owner_s_poll_fetches_the_job_once``). The log location and the dataset
    id come off the job's own enqueue kwargs, as ``_build_job_status`` reads them.

    The log and the error are owner-only for the reason ``result`` is: their content is
    not a shape anyone can audit once. The log records the owner's username (the
    worker's ``... start dataset=%s owner=%s`` line) and paths. The error is the last
    line of the traceback — the exception's own message — and the pipeline's messages
    carry whatever the raise put in them: ``ingest._scan_images`` names its
    ``images_dir``, which on the web path is the upload bundle under
    ``users/{owner}/uploads/{id}/``, and the offending filenames.

    ``job.exc_info`` is read HERE and not in ``_build_job_status`` because it is not a
    plain attribute. In rq 2.10 a failure's traceback is written to the job's
    ``rq:results:`` stream (``Job._handle_failure`` → ``Result.create_failure``), not
    to the job hash ``Job.fetch`` loads, and ``exc_info`` is a property that calls
    ``latest_result()``, an ``XREVRANGE`` on that stream (read from the installed rq
    source, 2026-09-29). Read there, every poll of a failed job would fetch the
    traceback from Redis for every caller before the decision. Still read only for a
    ``failed`` job, as before: the owner polls this route throughout every bake, and a
    job that has not failed has no traceback to read.

    Best-effort in all three, each with its own guard, because this is ADVISORY detail
    on a continuously polled route. The log read answers ``[]`` on an ``OSError``. The
    ``exc_info`` read (``failed`` only) — a broker hiccup, or a result payload that will
    not decode — answers ``None``. ``result`` (``finished`` only) is ``None`` on any
    exception, and a mapping or nothing. A 500 here would land on the owner's LAST poll
    and stop the frontend's poll, so the one person who can act on the outcome would see
    a transport error instead of it. Each failed read logs one terse warning, because it
    repeats on every poll, and its traceback at DEBUG. ``job_id`` is passed in rather
    than read off the job, so a job object that is already misbehaving cannot turn a log
    line into a second exception. SYNCHRONOUS (file I/O, plus a Redis read for a failed
    or finished job): invoke via ``run_in_threadpool``. The log read opens a fresh
    per-call file handle."""
    kwargs = job.kwargs or {}
    output_root = kwargs.get("output_root")
    dataset_id = kwargs.get("dataset_id", "")
    log_tail = (
        _read_log_tail(output_root, dataset_id) if output_root and dataset_id else []
    )
    error = None
    if state == "failed":
        try:
            error = _short_error(job.exc_info)
        except Exception as exc:  # noqa: BLE001 — advisory; never fail the poll on it
            logger.warning(
                "Unreadable failure message for job %r (%s); answering error=null",
                job_id,
                type(exc).__name__,
            )
            logger.debug(
                "Why job %r's failure message was unreadable", job_id, exc_info=True
            )
    return log_tail, error, _read_job_result(job, job_id, state)


def _build_job_status(connection: Any, job_id: str) -> tuple[JobStatus, Any]:
    """Fetch the RQ job and merge its state and the live per-stage progress from
    ``job.meta`` (Seam O1) into a JobStatus — the part of the answer every caller the
    route admits may see. SYNCHRONOUS (two Redis round-trips — Job.fetch +
    get_status), so the route runs it via ``run_in_threadpool``: the frontend POLLS
    this endpoint throughout every ingest, and running the blocking I/O inline on the
    event loop made the API stutter continuously during a bake (every concurrent
    request, including the pyramid range-reads, froze behind each poll).
    Thread-safety: the per-worker redis-py client (lifespan ``Redis.from_url``) is a
    thread-safe connection pool — datasets.py already runs Job.fetch_many on this same
    connection in the threadpool. Raises NoSuchJobError for a missing/expired job (the
    route maps it to 404).

    The OWNER-ONLY fields are not read here: ``log_tail`` is ``[]`` and ``error`` and
    ``result`` are ``None``, because this runs before the dataset — and therefore the
    owner — is known. What the route needs to read them once it has decided comes back
    BESIDE the model, never inside it: the fetched job itself, which carries the log
    location in its kwargs and whose ``exc_info`` and return value are Redis reads of
    their own (see ``_read_owner_fields``)."""
    job = Job.fetch(job_id, connection=connection)
    raw_status = job.get_status()
    state = str(getattr(raw_status, "value", raw_status))  # RQ enum or str → str
    kwargs = job.kwargs or {}
    dataset_id = kwargs.get("dataset_id", "")
    job_status = JobStatus(
        job_id=job_id,
        state=state,
        dataset_id=dataset_id,
        # Owner-only, filled by the route's gated hop (`_read_owner_fields`).
        log_tail=[],
        error=None,
        # Seam O1: merge the live per-stage progress the worker wrote to job.meta.
        progress=_read_progress(job),
        # Seam L1: the verb's own return value is NOT read here. It is owner-only and
        # this function runs before the dataset — and therefore the owner — is known, so
        # the route reads it in its gated hop (`_read_owner_fields`) once it has decided.
        result=None,
    )
    return job_status, job


@router.get("/api/jobs/{job_id}")
async def get_job(
    job_id: str,
    request: Request,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> JobStatus:
    """Merges RQ job state and the live per-stage progress the worker wrote to
    ``job.meta`` (Seam O1 — ``JobStatus.progress``, null for a pre-O1 job) for every
    caller who may read the job's dataset; and, for that dataset's OWNER only, the tail
    of ingest.log (a fallback if the RQ status/progress mechanism is unavailable), a
    failed job's exception message, and the verb's return. The dataset id + log
    location come from the job's own enqueue kwargs.

    The blocking RQ + log I/O runs OFF the event loop (``_build_job_status``, then, for
    the owner only, ``_read_owner_fields``, each via ``run_in_threadpool``) — the
    endpoint is polled continuously during a bake, so its body must never block the loop
    (as an inline ``async def`` it stuttered every concurrent request, including the
    pyramid range-reads). The identity + app-state session deps resolve on the loop, and
    the may_read authorization runs on it too.

    D-34: a job is readable at all only by the OWNER of the job's dataset, or if that
    dataset is PUBLIC — the SAME may_read gate as the dataset read routes, resolving the
    dataset from the job's own enqueue kwargs (this closes the app-scan MED-2 job-log
    leak for private datasets). A denied read — or a job whose dataset is
    unknown/unreadable — returns the SAME 404 as a missing job, so a job's existence is
    not disclosed to a caller who cannot read its dataset (non-disclosure).

    may_read is not enough for three fields, and each is served to the dataset's OWNER
    only and never READ for anyone else: ownership is resolved first, and the reads
    happen in one gated hop (``_read_owner_fields``) made only if it holds, so no
    owner-only value crosses the authorization boundary and then gets stripped back off.

    * ``log_tail`` and ``error`` — the build log records
      the owner's username and paths, and a failed job's exception message carries
      whatever the pipeline's raise put in it, which on the web path includes the upload
      bundle's path under ``users/{owner}/uploads/`` and original filenames. Anyone
      else the gate admits — an anonymous visitor to a PUBLIC dataset, or a signed-in
      non-owner — gets ``[]`` and ``null``: the shape does not change, and ``progress``
      still shows a failed bake as a stage with ``state: "failed"``.
    * ``result`` (Seam L1, ``_read_job_result``) — the worker verb's raw return, and the
      channel the roles edit's authoritative stale set arrives on. Its shape is the
      pipeline's to change per verb and it already carries server-side artefacts
      (``swept`` file lists, ``stale_tag_sidecar``).

    Auditing every present and future log line, exception message or verb return for
    anonymous disclosure is not something anyone can do once, so all three are scoped
    to the person who performed the write. What stays readable to every admitted caller
    — ``job_id``, ``state``, ``dataset_id`` and ``progress`` (stage keys, labels,
    counts, states, timestamps) — is structural. A dataset with no recorded owner gives
    nobody the owner-only fields; may_read already 404s it to everyone. The owner
    lookup is an identity-map hit on the row ``may_read`` just loaded into this session
    — no extra query."""
    try:
        job_status, job = await run_in_threadpool(
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
    # The owner-only fields, resolved in that order: decide, THEN read. `may_read` has
    # already passed here, which is not enough — these are narrower — so ownership is
    # resolved first and the reads happen only if it holds. A non-owner never causes a
    # read, so no owner-only value ever enters this response object at all.
    if user is not None:
        owner = await appstate.get_dataset_owner(session, job_status.dataset_id)
        if owner is not None and owner == user.username:
            (
                job_status.log_tail,
                job_status.error,
                job_status.result,
            ) = await run_in_threadpool(_read_owner_fields, job, job_id, job_status.state)
    return job_status
