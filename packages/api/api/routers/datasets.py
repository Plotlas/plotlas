"""GET/POST/DELETE /api/datasets, GET /api/datasets/{ds_id},
GET/PATCH /api/datasets/{ds_id}/presentation, GET /api/datasets/{ds_id}/columns.

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
import secrets
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

from api import appstate, db, presentation, queue
from api.models import (
    ColumnInfo,
    ColumnListResponse,
    CreateDatasetRequest,
    CreateDatasetResponse,
    DatasetListResponse,
    DatasetPresentationUpdate,
    DatasetSummary,
    DatasetSummaryPresentation,
    PresentationResponse,
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

# Longest `ColumnInfo.sample` this route will serialize, in characters; longer values are
# truncated and the truncation is announced with a trailing `…` (see `_render_sample`).
# Registered in docs/design/LIMITS_REGISTER.md, §4 "API — datasets", with its verdict.
#
# NOT an independently derived number, and saying so is the register's rule: it is
# `search._SNIPPET_MAX` (160, register row 12, verdict "defended"), which bounds exactly
# the same kind of thing — one user-supplied metadata value, rendered as a short context
# line for a human who is deciding what to do with the column it came from. A second,
# different number for the same job would be a divergence with no reason behind it, and
# `SearchHit.snippet` has shipped at 160 without a complaint. Re-derived here rather than
# imported: routers may not import one another (module-map rule), the same reason
# `_ACTIVE_JOB_STATES` above is a copy. Neither side is env-tunable, so the two cannot
# drift apart by configuration — the property that makes `METADATA_MAX_IDS`' mirror safe.
#
# It needs no operator WARNING by the register's own test ("is the person who is refused
# the same person who can lift the refusal"): nothing is refused, the response says in
# its own bytes that the value was cut, and the full value is one click away in the
# collection's own data. It is a payload-notice truncation, not a capacity ceiling.
_SAMPLE_MAX = 160

# D-xxviii (seam L6): a MINTED dataset id is `secrets.token_hex(_MINTED_ID_BYTES)` —
# 48 random bits written as exactly 12 lowercase hex characters. THE FORM IS A CONTRACT
# (docs/interface-catalogue.md, `POST /api/datasets`): the frontend recognises a minted id
# by it and so never shows one as a collection's name. Changing it without a coordinated
# frontend change puts hex strings back in the library.
_MINTED_ID_BYTES = 6

# How many ids `_mint_dataset_id` draws before it gives up with a 500. Registered in
# docs/design/LIMITS_REGISTER.md, §4 "API — datasets", with its verdict: DEFENDED and
# LOUD, and deliberately NOT env-tunable.
#
# It can bind only when the random source is broken. Each draw is taken with probability
# n / 2**48 for n ids in use — both stores, any owner — independently of every other
# draw, so a WORKING source exhausts all eight with probability (n / 2**48) ** 8: about
# 2.5e-68 at n = 1,000,000 collections, and 2.5e-44 at a thousand times that. No
# measurement moves that, because nothing a deployment holds comes near 2**48.
#
# Why no env var, which AGENT_GUIDE → Limits otherwise asks of a picked number: the knob
# exists so an operator can lift a ceiling that refuses real work, and this one cannot
# refuse real work. When it binds, no value of it yields a free id — a broken source
# stays broken, so raising it only delays the same 500 — and below 2 it would turn a
# harmless collision into a refusal. Every value from 2 up is safe (2 fails a working
# source 1.3e-17 of the time at n = 1e6), so 8 is not tuned. What the rule is after is
# that a binding limit be VISIBLE to the person who can act on it, and it is:
# `_mint_dataset_id` logs an ERROR naming the limit, its value and the ids it drew.
_MINT_MAX_ATTEMPTS = 8


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


def _presentation_http_error(exc: Exception) -> HTTPException:
    """The status a rejected presentation write deserves. A value the contract refuses is
    the CALLER's problem (422, resubmit with a shorter name); a tree that cannot be written
    is the SERVER's (409, and the caller cannot fix it by resubmitting — the showcase
    profile mounts its content `:ro` on purpose). 409 rather than a 500 mirrors DELETE's
    read-only-fixture answer (T2-91): never surface a bare error."""
    return HTTPException(
        status_code=(
            status.HTTP_409_CONFLICT
            if getattr(exc, "io_error", False)
            else status.HTTP_422_UNPROCESSABLE_ENTITY
        ),
        detail=str(exc),
    )


def _split_intake_payload(
    column_roles: dict | None, sent_presentation: dict[str, Any]
) -> tuple[dict | None, dict[str, Any]]:
    """Split one intake payload into (roles for the bake, presentation for the file) —
    D-xvii. PURE, so the rule is testable without a request.

    The wizard used to send ONE thing: its "render as link" toggle rode inside
    `column_roles` as the `url` role. Schema v2.9 removed that role, so a payload that
    still carries it is REDIRECTED here rather than forwarded (it would fail the bake's
    role validation) or dropped (it would lose the user's choice). An explicit
    `presentation.columns` entry WINS over the redirected role for the same column — the
    caller that sent both said the newer thing deliberately."""
    if not isinstance(column_roles, dict) or "url" not in column_roles:
        return column_roles, dict(sent_presentation)
    roles = {k: v for k, v in column_roles.items() if k != "url"}
    redirected = {
        name: {"render": "url"}
        for name in presentation.legacy_url_columns(column_roles)
    }
    if redirected:
        logger.info(
            "Intake sent column_roles.url %s; recording it as presentation "
            "(schema v2.9 moved the role — D-xvii)",
            sorted(redirected),
        )
    out = dict(sent_presentation)
    out["columns"] = {**redirected, **(out.get("columns") or {})}
    return roles, out


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


def _summary_presentation(
    stored: dict[str, Any],
    record: appstate.DatasetRecord | None,
) -> dict[str, str | None]:
    """The three dataset-level scalars a summary carries, resolved through the merge
    (`presentation.effective_dataset`): the dataset's OWN `presentation.json` first, else
    the app-state row, else "not set". The app-state half is the pre-migration FALLBACK,
    not a second source — see api/presentation.py.

    The DATASET BLOCK only. It used to build the whole effective record — `_clean_columns`
    over every entry, `_clean_layouts`, and `legacy_url_columns` against the manifest —
    once per ready dataset AND once per pending dataset, then keep three fields of it.
    That work is proportional to what a client last PATCHed into `columns`, so the
    listing's per-dataset cost was attacker-influenced (review of PR #346, findings 15 and
    8). Measured 2026-09-09, median of 200 calls on a 10,000-entry record: 30.1 ms before,
    1.6 us now. The `manifest` argument went with it — it existed only to feed
    `legacy_url_columns`, and no summary field was ever derived from `column_roles`."""
    resolved = presentation.effective_dataset(stored, fallback=record)
    return {field: resolved.get(field) for field in appstate.PRESENTATION_LIMITS}


def _ready_summary(
    ds_dir_name: str,
    manifest: dict,
    owner: str,
    active_job_id: str | None = None,
    record: appstate.DatasetRecord | None = None,
    stored_presentation: dict[str, Any] | None = None,
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
        # Presentation, from the dataset's own `presentation.json` merged over the
        # app-state fallback (D-i/D-xv). A CLI-transferred tree app-state has never heard
        # of (`record` is None) now still arrives WITH its name and credit if the directory
        # carries them — which is the whole point of the move. Nothing set anywhere leaves
        # all three None and the consumer falls back to the id, the honest answer.
        **_summary_presentation(stored_presentation or {}, record),
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
            summaries.append(
                _ready_summary(
                    name,
                    manifest,
                    owner,
                    record=record,
                    # One more small file read per dataset, in the SAME off-loop pass as
                    # the manifest open — deliberately not cached the way `load_manifest`
                    # is, because no hot path re-reads it (the manifest cache exists for
                    # `get_pyramid`, which re-loads on every byte-range read), and a cache
                    # would add an invalidation duty to the write path for no measured win.
                    stored_presentation=presentation.load(ds_root / name),
                )
            )
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


def _load_presentations(ds_root: Path, ids: list[str]) -> dict[str, dict[str, Any]]:
    """Stored presentation records for `ids`, as one synchronous batch the caller runs off
    the event loop. Used for the PENDING half of the listing (app-state rows with no
    manifest yet): a dataset named while it is still baking must show that name, and the
    name now lives in a file the scan above never reached because there is no manifest."""
    out: dict[str, dict[str, Any]] = {}
    for ds_id in ids:
        try:
            out[ds_id] = presentation.load(db.resolve_under(ds_root, ds_id))
        except HTTPException:
            continue  # an id that cannot be jailed has no directory to read
    return out


def _pending_summary(
    record: appstate.DatasetRecord,
    job_state: str | None,
    stored_presentation: dict[str, Any] | None = None,
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
        # Presentation, through the SAME merge _ready_summary uses. A collection named
        # while it is still processing or errored (the PATCH gates only on the app-state
        # record + owner, NOT on an on-disk manifest) must show its name here too, not fall
        # back to the raw id until it reaches "ready" — and after this seam the name it
        # shows is the one already written into the dataset directory, if there is one.
        **_summary_presentation(stored_presentation or {}, record),
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
    # Their presentation files (if any) in ONE off-loop batch — the ready half was read in
    # the scan above, and no filesystem read belongs on the event loop. Skipped entirely
    # when nothing is pending, which is the steady state.
    pending_presentation = (
        await run_in_threadpool(
            _load_presentations, db.datasets_root(), [r.dataset_id for r in pending]
        )
        if pending
        else {}
    )
    for record in pending:
        state = states.get(record.last_job_id) if record.last_job_id else None
        summary = _pending_summary(
            record, state, pending_presentation.get(record.dataset_id)
        )
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
        summary = _pending_summary(record, state, presentation.load(ds_dir))
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
            # Read inline, exactly as `db.load_manifest` above is: one more small read on
            # a single-dataset route, not the N-dataset listing scan.
            stored_presentation=presentation.load(ds_dir),
        ),
        user,
    )


async def _mint_dataset_id(session: AsyncSession, data_root: Path) -> str:
    """A fresh dataset id for a create that did not author one (D-xxviii). The ONE place
    an id is minted: the draft-collection seam
    ([[T2-a-collection-cannot-exist-before-its-upload]]) calls this too, so it takes the
    session and the data root rather than a request.

    **The form:** 12 lowercase hex characters, 48 bits from `secrets`. The length is a
    READABILITY choice, not a capacity limit. With 1,000,000 collections, the chance that
    one fresh mint hits an existing id is 1e6 / 2**48 ≈ 3.6e-9, and the check below makes
    even that harmless.

    **Free means free in BOTH stores.** No app-state row has the id, whoever owns it —
    a create whose bake is still queued has a row and nothing on disk yet — AND nothing
    exists on disk at its jailed path: any directory, not just a complete dataset.
    `db.is_dataset` keys on the manifest, and a directory without one is still
    somebody's (a CLI commit in flight, `worker._commit`, mkdirs the dataset directory
    and replaces the manifest LAST; a create's `presentation.json` lands before its
    bake). The namespace is mixed — authored ids keep working forever, and an authored
    id may itself be 12-character hex — which is why the check cannot be skipped. A
    taken id is re-minted, up to `_MINT_MAX_ATTEMPTS` draws; past that the random
    source is broken, and this answers 500 saying so.

    **Checked before the lock, re-checked under it.** `queue.dataset_lock` is keyed by
    the id, so the id must exist before it is taken; the create route's own guards then
    re-check under the lock. The gap is accepted, not engineered around: it needs a
    second request to draw the SAME 48-bit value after the first drew it and before the
    first recorded its owner row — 2**-48 per such overlapping pair. If it ever happens
    between two owners, the second meets the owner-conflict 409. Between two creates by
    ONE owner, the second meets the in-flight 409 while the first's bake is queued or
    running ([[T2-create-has-no-in-flight-job-guard-so-one-owner]]), and the on-disk
    409 once it has committed."""
    drawn: list[str] = []
    for _ in range(_MINT_MAX_ATTEMPTS):
        candidate = secrets.token_hex(_MINTED_ID_BYTES)
        drawn.append(candidate)
        if await appstate.get_dataset_owner(session, candidate) is not None:
            continue
        # The same jail every authored id goes through (`db.dataset_dir`), and
        # `exists()` rather than `db.is_dataset`: ANY entry at the path makes it taken.
        if db.dataset_dir(data_root, candidate).exists():
            continue
        return candidate
    # The limit bound, so say so where the operator — the only person who can act on
    # it — will see it: which limit, its value, and what it drew. A source that returns
    # one value every time shows here as a single repeated id.
    logger.error(
        "dataset id mint gave up: all %d draws were taken (limit _MINT_MAX_ATTEMPTS=%d; "
        "%d distinct: %s). A working random source essentially never does this — check "
        "that `secrets` / os.urandom is not stubbed or starved on this host.",
        len(drawn),
        _MINT_MAX_ATTEMPTS,
        len(set(drawn)),
        ", ".join(drawn),
    )
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=(
            f"Could not mint a free dataset id in {_MINT_MAX_ATTEMPTS} attempts: the "
            "server's random source appears to be broken. This is a server fault, not "
            "a problem with the request."
        ),
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
    After a successful enqueue the job id (D-28) AND the bundle id this dataset was
    built from (seam L1, `source_upload_id`) are recorded on the dataset row; if the
    enqueue RAISES, an owner row created by THIS request is rolled back and the client
    gets 503 (PR19-3).

    `dataset_id` is optional (D-xxviii, seam L6): absent, one is minted
    (`_mint_dataset_id`) and the rest of this route is the authored-id route
    (`_create_as`), run on the minted value.

    A MINTED create is idempotent per upload
    ([[T2-a-minted-create-is-not-idempotent-so-a-retried]]): when an earlier MINTED
    create of the owner's already built a collection from `upload_id`
    (`minted_from_upload_id`, which nothing else writes), it answers 409 with
    `{"code": "upload_already_created", "message", "dataset_id", "job_id"}` naming that
    collection, so a client whose first response was lost can adopt it. `job_id` is the
    collection's job only while it is queued or started, else null. The key is (owner,
    upload_id), and the lookup through the final record runs under
    `queue.upload_create_lock`. An AUTHORED create is never refused this way and never
    sets the key, and neither does re-ingest, so a collection only re-ingested or
    authored from an upload never blocks a minted create from it."""
    owner = user.username

    # Resolved before any lock or mint: it validates `upload_id` against the uploads
    # router's charset — which is what makes it safe inside the upload lock's key — and
    # a bundle that is not finalized is a 404 whichever kind of create this is.
    bundle = _resolve_finalized_bundle(owner, body.upload_id)

    # D-xxviii (seam L6): resolve THE id this create is about, exactly once. Present ⇒
    # the authored id, untouched, and today's route exactly. Absent ⇒ minted, and
    # `_create_as` reads `dataset_id` and never `body.dataset_id`, which is None here.
    if body.dataset_id is not None:
        return await _create_as(
            body.dataset_id, body, bundle, owner, request, session, minted=False
        )

    # The minted create's idempotency key is (owner, upload_id). `minted_from_upload_id`
    # does not exist until the new row commits (with it, before the enqueue — see
    # `key_written_early` in `_create_as`), so a retry racing this create would miss the
    # lookup unless the WHOLE sequence — lookup → mint → row with its key → enqueue →
    # record the job — holds one lock keyed by the upload. The two creates hold two
    # different minted ids, so the dataset lock inside `_create_as` cannot serialize
    # them. This lock is taken first and the dataset lock second, never the reverse.
    # A retry that arrives while the first holds it waits, then meets the 409 below.
    try:
        async with queue.upload_create_lock(
            request.app.state.redis, owner, body.upload_id
        ):
            prior = await appstate.get_dataset_record_minted_from_upload(
                session, owner, body.upload_id
            )
            if prior is not None:
                # The 409 names the collection's job ONLY while it is still queued or
                # started — the same in-flight check as the D5 guard and DELETE. A job
                # that finished or failed, or that RQ no longer holds (results expire
                # after RQ's result TTL), is null: adopting it would poll a job that
                # answers 404 or re-reports an old failure, so the client would show an
                # error for a collection that exists (review of PR #373, operator
                # finding 2). An unreachable broker reads as not in flight: null too.
                prior_state = await _resolve_job_state(
                    request.app.state.queue.connection, prior.last_job_id
                )
                live_job_id = (
                    prior.last_job_id if prior_state in _ACTIVE_JOB_STATES else None
                )
                logger.info(
                    "Refused a minted create by %r: upload %r already backs dataset %r "
                    "(last job %r, state %r); answered 409 for the client to adopt it",
                    owner,
                    body.upload_id,
                    prior.dataset_id,
                    prior.last_job_id,
                    prior_state,
                )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "upload_already_created",
                        "message": (
                            "This upload already backs one of your collections. "
                            "Delete that collection to build a new one from it, or "
                            "create with an explicit dataset_id."
                        ),
                        "dataset_id": prior.dataset_id,
                        "job_id": live_job_id,
                    },
                )
            dataset_id = await _mint_dataset_id(session, db.resolve_data_root())
            # Logged AS MINTED, so an operator reading this log can tell which namespace
            # a collection came from. The form alone cannot: an authored id may be hex
            # too. Logged at the mint, so it precedes every later line naming this id —
            # including a refusal in `_create_as`, which leaves the id minted but unused.
            logger.info(
                "Minted dataset id %r for a create request by %r (it authored none — "
                "D-xxviii)",
                dataset_id,
                owner,
            )
            return await _create_as(
                dataset_id, body, bundle, owner, request, session, minted=True
            )
    except LockUnavailableError as exc:
        # Only the UPLOAD lock's failure lands here: `_create_as` answers its own
        # dataset lock's failure as an HTTPException, which passes through unchanged.
        logger.warning(
            "Could not acquire upload lock for a minted create by %r from %r: %s",
            owner,
            body.upload_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc


async def _create_as(
    dataset_id: str,
    body: CreateDatasetRequest,
    bundle: Path,
    owner: str,
    request: Request,
    session: AsyncSession,
    *,
    minted: bool,
) -> CreateDatasetResponse:
    """The create itself, on THE id — authored, or minted by `create_dataset` — from the
    already-resolved finalized `bundle`: jail, dataset lock, 409s, owner row,
    presentation, enqueue, job and source-upload records, rollback and response.
    `minted` moves ONE thing: when the row is new, a minted create writes its key
    (`minted_from_upload_id`) and `source_upload_id` with the row, before the enqueue
    (see `key_written_early`)."""
    # Jail dataset_id BEFORE any side effect: it becomes the worker's output dir
    # ({output_root}/{dataset_id} where output_root = DATA_ROOT/datasets/, D-30),
    # and the worker trusts these server-set kwargs — so the API is the sole jail.
    # The CreateDatasetRequest charset permits "." and ".." (it allows '.'), which
    # would escape the datasets root once the worker runs; db.dataset_dir rejects
    # "."/".."/absolute exactly as the read path (get_dataset) does, and also gives
    # us the on-disk dir (under datasets/) for the adoption check below. A MINTED id
    # passes through this same line: there is no second path around the jail.
    ds_dir = db.dataset_dir(db.resolve_data_root(), dataset_id)

    csv_path = _bundle_csv(bundle)

    # D-xvii — the intake payload split. Roles go to the bake; presentation goes to
    # `presentation.json`. `column_roles` is forwarded MINUS any `url` key: schema v2.9
    # removed that role, so forwarding it would enqueue a job guaranteed to fail role
    # validation, and dropping it silently would lose the user's choice. Splitting it
    # instead is lossless and is exactly what the operator's framing asks for — the bake
    # never needed it (it only ever VALIDATED it; nothing was computed from it and no cell
    # moved), and deciding a column is a link "only needs the CSV to exist".
    column_roles, split_presentation = _split_intake_payload(
        body.column_roles,
        body.presentation.model_dump(exclude_unset=True)
        if body.presentation is not None
        else {},
    )

    # A metadata ingest needs BOTH a source and a role map; the pipeline rejects
    # either alone (ingest.ingest_metadata). Reject the mismatch here with a clear
    # 400 instead of enqueuing a job that is guaranteed to fail. Neither present ⇒
    # a first-class images-only dataset (D-25).
    if (csv_path is not None) != (column_roles is not None):
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
        async with queue.dataset_lock(request.app.state.redis, dataset_id):
            # Do not let one user silently take over a dataset_id app-state already
            # records for someone else (record_dataset_owner is a last-writer-wins
            # upsert).
            existing = await appstate.get_dataset_record(session, dataset_id)
            existing_owner = existing.owner if existing is not None else None
            if existing_owner is not None and existing_owner != owner:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Dataset id already exists",
                )

            # The SAME owner repeating a create while this id's last job is still
            # queued or started would stack a second bake onto the row and overwrite
            # its `last_job_id` and `source_upload_id` while the first job still runs
            # ([[T2-create-has-no-in-flight-job-guard-so-one-owner]]). Neither guard
            # around this one sees it: the one above is for a DIFFERENT owner, and the
            # on-disk one below needs a manifest, which the first bake has not
            # committed yet. The same check and wording as DELETE here and the other
            # four write routes (`jobs._guard_no_job_in_flight`, which this router may
            # not import), read inside the lock for the same reason theirs is. An
            # unreachable broker reads as "not in flight", as it does on every route.
            if existing is not None:
                state = await _resolve_job_state(
                    request.app.state.queue.connection, existing.last_job_id
                )
                if state in _ACTIVE_JOB_STATES:
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail="Another job for this collection is still running",
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
            # A MINTED create writes its idempotency key — `minted_from_upload_id`, which
            # `create_dataset` looks up and which nothing else ever writes (review of PR
            # #373, operator finding 1) — in the SAME commit as the new row, BEFORE the
            # enqueue, and `source_upload_id` with it. Written after the enqueue, any
            # failure between the enqueue and that write (SQLite "database is locked"
            # past its busy timeout; a crash) left a queued bake whose row had no key, so
            # the client's retry missed the lookup and minted a second collection
            # (review of PR #373, finding 1). Written here, a retry finds the row from
            # this commit on — including one that takes the upload lock after it EXPIRED
            # while this request was still inside the enqueue — and gets the 409 (its
            # `job_id` null until the job is recorded and queued). Only when this request
            # created the row, which is what makes it safe: every failure path below
            # deletes a row created here, both columns included. An AUTHORED create
            # writes no key and keeps the late `source_upload_id` write below: it may be
            # re-creating over an existing row of its own, which the rollback does NOT
            # delete, so an early write would leave that row naming a bundle no job read.
            key_written_early = minted and row_created_here
            await appstate.record_dataset_owner(
                session,
                dataset_id,
                owner,
                source_upload_id=body.upload_id if key_written_early else None,
                minted_from_upload_id=body.upload_id if key_written_early else None,
            )

            # Write presentation BEFORE the enqueue, inside this same lock. The dataset
            # directory does not exist yet, so this creates it holding one file — which is
            # safe at any point relative to the bake: `worker._commit` MERGE-MOVES onto the
            # dataset directory (`mkdir(exist_ok=True)`, then `_move_merge` per STAGED
            # item, then an `os.replace` of the manifest), so it touches nothing it did not
            # stage and it never stages this file. A directory holding only this file is
            # not a dataset (`db.is_dataset` keys on the manifest), so it is invisible to
            # the listing until the bake commits.
            #
            # This comment used to argue the ordering from `_commit`'s whole-directory
            # `os.rename` fast path — "taken only when the target does NOT exist, and a
            # rename onto a NON-EMPTY directory fails". That branch could never run (its
            # sole call site always passed `keep_staging=True`) and is deleted by the
            # pipeline half of this review, so the ordering is not a RACE argument at all
            # (review of PR #346, finding 5). What it still buys is the rejection: a
            # presentation value the contract refuses must 422 BEFORE a bake is enqueued,
            # or the user waits out a full ingest to be told their label was too long —
            # see the handler below.
            #
            # bool(), not the dict itself: `split_presentation` is a mapping, so the
            # bare `and` yielded `{}` when nothing was sent. It worked only because `{}`
            # is falsy at the guard below, while the name, the comment and mypy all
            # promised a boolean (review of PR #346, finding 14).
            dir_created_here = bool(split_presentation) and not ds_dir.exists()
            if split_presentation:
                try:
                    await run_in_threadpool(
                        presentation.update, ds_dir, split_presentation
                    )
                except appstate.PresentationValueError as exc:
                    # A bad presentation value must not enqueue a bake: the user would
                    # wait out a full ingest to be told their label was too long.
                    if row_created_here:
                        await appstate.delete_dataset_record(session, dataset_id)
                    raise _presentation_http_error(exc) from exc

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
                    dataset_id=dataset_id,
                    owner=owner,
                    images_dir=str(bundle / _IMAGES_SUBDIR),
                    output_root=str(db.datasets_root()),
                    layout_types=body.layout_types,
                    csv_path=str(csv_path) if csv_path is not None else None,
                    column_roles=column_roles,  # the bake's half of the D-xvii split
                )
            except Exception as exc:
                # Broad catch BY DESIGN (PR19-3): any enqueue failure (broker down,
                # timeout, ...) must roll back an owner row this request just created
                # — otherwise the id is squatted with no job — and answer 503. Logged
                # with the traceback, never swallowed silently; a retry after the
                # queue recovers passes the checks above and re-enqueues.
                logger.exception(
                    "Enqueue failed for dataset %r; rolling back owner row created here=%s",
                    dataset_id,
                    row_created_here,
                )
                if row_created_here:
                    await appstate.delete_dataset_record(session, dataset_id)
                if dir_created_here:
                    # The create never reached the queue, so this id names nothing at
                    # all now — a presentation file for a dataset that does not exist
                    # would be litter. Only when THIS request created the directory: a
                    # retry over an id whose earlier bake failed keeps its choices,
                    # because that dataset does still exist (an app-state row in
                    # `error`), and losing the user's typing on a retry is the failure
                    # this whole partial-write design exists to avoid.
                    await run_in_threadpool(presentation.discard, ds_dir)
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail="ingest queue unavailable",
                ) from exc

            # Record the job id AFTER the successful enqueue (D-28): powers the
            # derived processing/error status and the delete-while-running 409.
            await appstate.record_dataset_job(session, dataset_id, job_id)
            # Seam L1: and record WHICH bundle those cells come from, in the same
            # critical section. This is the only tie between a dataset and its bundle;
            # `GET .../columns` reads it to describe a collection that has not baked
            # yet, and without it that route had nothing dataset-scoped to ask (review
            # of PR #358, finding 1). Recorded after the enqueue for the same reason
            # the job id is: before it, a rolled-back create would leave the fact
            # asserted about a dataset that does not exist. A minted create that made
            # its row wrote it with the row instead (`key_written_early`, above).
            if not key_written_early:
                await appstate.record_dataset_source_upload(
                    session, dataset_id, body.upload_id
                )
    except LockUnavailableError as exc:
        logger.warning(
            "Could not acquire dataset lock for create of %r: %s", dataset_id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    return CreateDatasetResponse(dataset_id=dataset_id, job_id=job_id)


def _recorded_bundle(record: appstate.DatasetRecord) -> Path | None:
    """The finalized upload bundle THIS DATASET was built from
    (`DatasetRecord.source_upload_id`), or None when it records none or the bundle is
    no longer on disk. Anchored in the dataset OWNER's jail (DATA_ROOT/users/{owner}/
    uploads/, D-30).

    This replaced a `_latest_finalized_bundle(owner)` helper, and the difference is the
    whole point: that one asked which bundle the OWNER finalized most recently, which is
    a different question from which bundle THIS collection came from, and answered a
    collection created from `u1` with `u2`'s columns as soon as the owner finalized a
    second upload — in exactly the pre-first-bake window `list_columns` exists to serve
    (review of PR #358, finding 1). There is no timestamp heuristic that fixes that;
    only a recorded id does.

    A thin wrapper over `db.resolve_recorded_bundle` (review of PR #390, round 3,
    findings 5+7: this function and `routers/jobs.py`'s equivalent independently
    re-derived the same regex-and-jail-path check and had drifted apart in what they
    did with a malformed id; one shared implementation is what keeps that from
    happening again). Returns None rather than raising on every miss because the
    recorded id is the SERVER's own record, not caller input: an owner who has since
    deleted the bundle has not made a bad request, and `list_columns` has a further
    answer to fall to."""
    return db.resolve_recorded_bundle(record.owner, record.source_upload_id)


def _declared_columns(roles: Any) -> set[str]:
    """Every column a committed manifest's `column_roles` names — the USER'S columns,
    which is what a `parquet` answer lists.

    A committed `metadata.parquet` also holds columns nobody declared, and they are the
    PIPELINE'S: `id` (the dense cell key — "users never supply cell ids",
    column_roles.schema.json), and `width`/`height` (the native dimensions ingest probes,
    Seam D2). Measured 2026-09-21 on the committed fixtures: `golden_dataset_full_v2`
    stores 13 columns and declares 10 — the three it does not declare are exactly `id`,
    `width`, `height` — and `golden_dataset_images_only_v2` stores `(id, filename)` and
    declares nothing. Offering those as columns to map invites a role on the pipeline's
    own key (review of PR #358, round 3, finding 1).

    NAMES MATCH THE PARQUET AS DECLARED, so no pipeline rule is re-derived here. In a
    COMMITTED manifest a role names the column as STORED: `ingest_metadata` repoints a
    source header that shadows a reserved name to its `meta_<name>` column
    (`_apply_renames`) and rebinds the filename role to the canonical `filename` before
    the manifest is written, and `run_set_roles` refuses any role whose column is not in
    the parquet (`_validate_roles_against_parquet`). Pinned pipeline-side by
    `test_ingest.py` ("the roles now point at the physical columns the API will
    query"). The schema's own description still says a role "always names the SOURCE
    column"; that disagreement is filed, not relied on
    ([[T2-column-roles-says-a-role-names-the-source]]).

    Collected by the schema's naming convention rather than a list of role names: every
    column reference in column_roles.schema.json is a property called `column` or
    `*_column` (`x_column`, `y_column`, `lon_column`, `lat_column`), and no other
    property ends that way — checked against the in-force schema 2026-09-21. So a role
    added later that follows the convention is covered without an edit here."""
    found: set[str] = set()
    if isinstance(roles, dict):
        for key, value in roles.items():
            if (key == "column" or key.endswith("_column")) and isinstance(value, str):
                found.add(value)
            else:
                found |= _declared_columns(value)
    elif isinstance(roles, list):
        for item in roles:
            found |= _declared_columns(item)
    return found


def _describe_columns(
    cursor: Any, source_sql: str, *, order_by_id: bool
) -> list[ColumnInfo]:
    """Column names, DuckDB types and a first-row sample for one table-function source.

    `source_sql` is a COMPLETE, server-composed table function
    (`read_parquet('…')` / `read_csv_auto('…', all_varchar=true)`) whose only
    interpolation is a path that was resolved inside a jail and single-quote-escaped by
    the caller. NO COLUMN NAME IS EVER INTERPOLATED: `DESCRIBE SELECT *` and
    `SELECT * … LIMIT 1` are both `*`, so this function has no dynamic-identifier sink
    at all and needs no `_sql_ident` (the second-order SQLi surface T2-115 hardened is
    user-supplied CSV headers reaching a SELECT list, and none reaches one here). The
    two statements agree on column ORDER — `DESCRIBE SELECT *` describes the same
    projection `SELECT *` produces — so the sample row is matched positionally.

    `order_by_id` says whether ordering by an `id` column is MEANINGFUL for this source,
    and only the PARQUET path passes True. There `id` is the pipeline's own dense
    integer key, so `ORDER BY "id"` picks the dataset's first cell rather than whichever
    row a scan happened to yield.

    THE `ORDER BY` IS NOT A FULL SCAN, measured rather than reasoned about (review of
    PR #358, finding 7, which predicted it "streams every row and every column through a
    Top-N operator"). Measured 2026-09-11, duckdb 1.5.4, on a synthetic 1M-row × 40-column
    parquet (113 MB, 9 row groups), median of 9 runs on a fresh connection each:

        ORDER BY "id" LIMIT 1               61.4 ms   (this form)
        WHERE "id" = (SELECT min("id") …)   63.7 ms
        bare LIMIT 1                        50.3 ms

    `EXPLAIN ANALYZE` says why the spread is that small: DuckDB decorrelates this into a
    TOP_N over the `id` column ALONE, then a SEMI hash join back to the file on
    `(file_index, file_row_number)` to materialize the one wide row — so the 40-column
    scan yields **1 row**, and the id-only scan yields **122,880**, one row group of
    nine, not 1,000,000. The alternatives are not cheaper: the `min()` subquery measured
    SLOWER than this form, and the bare `LIMIT 1`'s 11 ms only buys a row that is
    whichever one the scan reached first — which is a different answer whenever the file
    is not in id order, and `test_columns_reads_the_committed_parquet` pins that it must
    not be. Kept as it is, on the numbers.

    On the CSV path `order_by_id` is off: the bundle is read with
    `all_varchar=true` (byte-for-byte what ingest does), so a *user* column that happens
    to be called `id` is a VARCHAR and sorts lexicographically — `"10"` before `"9"` —
    which silently returns a row that is not the first one and calls it the first
    (review of PR #358, finding 3). Off, the sample is the CSV's first data row, which
    is what a header-and-first-row preview means. `"id"` is a constant identifier in a
    literal string either way, never an interpolation.

    Runs the queries via the supplied request cursor; the caller MUST invoke it off the
    event loop (DuckDB is sync C), exactly as the metadata/search queries are."""
    described = cursor.execute(f"DESCRIBE SELECT * FROM {source_sql}").fetchall()
    names = [str(row[0]) for row in described]
    dtypes = [str(row[1]) for row in described]
    order_by = ' ORDER BY "id"' if order_by_id and "id" in names else ""
    sample_row = cursor.execute(
        f"SELECT * FROM {source_sql}{order_by} LIMIT 1"
    ).fetchone()
    return [
        ColumnInfo(
            name=name,
            dtype=dtypes[i],
            sample=_render_sample(sample_row[i]) if sample_row is not None else None,
        )
        for i, name in enumerate(names)
    ]


def _render_sample(value: Any) -> str | None:
    """One cell as a display string, TRUNCATED to `_SAMPLE_MAX`, or None for SQL NULL.

    `str()` rather than a type table on purpose: this value is shown to a human choosing
    a role, never parsed, so a list column's `['a', 'b']` and a timestamp's
    `2026-01-01 00:00:00` are both exactly as informative as a bespoke rendering would be
    — and a type table here would be a second, drifting copy of `metadata._coerce_field`,
    which exists to satisfy a typed union this field does not have.

    The cap is not optional. The CSV path reads `all_varchar=true`, so every cell is
    whatever the user uploaded: a 10 MB description in the first data row was serialized
    in full, once per such column, into a response that renders a short preview chip
    (review of PR #358, finding 9). The truncation ANNOUNCES ITSELF with `…` — the
    `SEARCH_MAX_RESULTS`/`_SNIPPET_MAX` posture, where the payload is self-describing so
    the UI can say the value was cut rather than show a silently different one."""
    if value is None:
        return None
    rendered = str(value)
    if len(rendered) <= _SAMPLE_MAX:
        return rendered
    return rendered[: _SAMPLE_MAX - 1] + "…"


@router.get("/api/datasets/{ds_id}/columns")
async def list_columns(
    ds_id: str,
    upload_id: str | None = None,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
    cursor: Any = Depends(db.get_cursor),
) -> ColumnListResponse:
    """What metadata columns this collection has — names, types and a sample value
    ([[T2-92]] Seam 2). OWNER-ONLY: this is the designer's Data view, it can read a
    not-yet-ingested upload bundle, and unlike `/metadata` it answers for a collection
    that is not published and may never be.

    **It is what lets the Data view survive a page reload during a first ingest.** Today
    the CSV header is parsed client-side and held in memory, so a reload during a
    26-minute upload loses the whole role mapping and there is nothing to re-read it
    from — an undesigned collection has no manifest yet.

    SOURCE RESOLUTION, in order, and which one answered is REPORTED rather than left to
    be inferred:

    1. an explicit `upload_id` — the caller has named one of their own finalized
       bundles and wants THAT one described (the "what would I get if I re-ingested
       from this?" question). It wins even over a committed parquet, because nothing
       else could have been meant. A bad or unfinalized id is a caller error: 400/404;
    2. a BAKED collection answers from its MANIFEST, which is the committed record of
       whether it has metadata at all. No `column_roles` → `images_only` (the schema's
       own definition), even though an images-only ingest writes a `metadata.parquet`
       too. `column_roles` present → the committed `metadata.parquet`, narrowed to the
       columns the roles DECLARE (`_declared_columns`): the user's columns, never the
       pipeline's `id`/`width`/`height` (review of PR #358, round 3, finding 1). Those
       are only the roled ones (`ingest._enrichment_select` drops the rest — the root
       finding of [[T2-92]]). This beats the recorded bundle because it is what the
       dataset actually contains; a bundle sitting in the jail describes a merge that
       has not happened;
    3. a collection that has NEVER BAKED answers from ITS OWN recorded bundle
       (`DatasetRecord.source_upload_id`) — the RAW headers of the bundle it is being
       built from, the full set still available to map, and the only answer that exists
       before the first bake.

    Every step is DATASET-SCOPED. There is deliberately no "the owner's latest finalized
    bundle" fallback: that is a different question, and it answered a collection created
    from `u1` with `u2`'s columns the moment its owner finalized a second upload — in
    exactly the pre-first-bake window this route exists to serve (review of PR #358,
    finding 1). A timestamp heuristic cannot fix it; only the recorded id can.

    THREE TERMINAL ANSWERS when no source above produced columns, and the first two are
    different facts that must not share a value:

    * **200 with `source: "upload"` and no columns** when an explicit `?upload_id=` names
      a finalized bundle that carries no CSV. It answers the question that was ASKED —
      "what would I get from this bundle?" — and nothing else. `images_only` here would
      be a claim about the COLLECTION, and a false one whenever its `metadata.parquet` is
      committed and full (review of PR #358, finding 4);
    * **200 with `source: "images_only"` and no columns** when the collection itself is
      genuinely images-only — its manifest carries no `column_roles`, or it has never
      baked and its own RECORDED bundle carries no CSV. This is a KNOWN answer, not a
      missing one: the Data view has to render "no metadata yet" (and offer to add
      some), and a 404 would say the collection does not exist. A baked images-only
      collection used to answer 200 here with a STRAY bundle's columns (finding 2), and
      then with the pipeline's `id` + `filename` (round 3, finding 1);
    * **404** for a dataset with no manifest, no recorded bundle and no `upload_id`
      given — genuinely nothing to describe — and for a broken tree whose manifest
      declares metadata but whose `metadata.parquet` is gone.

    The CSV is read with DuckDB's `read_csv_auto(..., all_varchar=true)` — byte-for-byte
    the table expression `ingest._read_source` builds — so the columns reported here are the
    columns the bake will see, delimiter sniffing included. Nothing imports `pipeline`
    (D-15): the two share a DuckDB call, not code. Every column is therefore `VARCHAR`,
    which is honest — a CSV declares no types, and inferring one here would be a second,
    weaker copy of a decision the ingest makes for itself."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    # Owner-only, with the same statuses the presentation PATCH answers: unknown to
    # app-state → 404 (with no record there is nothing to name — a CLI-seeded tree
    # included); recorded but not yours → 403.
    record = await appstate.get_dataset_record(session, ds_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    if record.owner != user.username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not the dataset owner"
        )

    # Resolve the source in the documented order. Each branch is dataset-scoped or
    # caller-named; none of them asks about the owner at large.
    parquet_path = ds_dir / "metadata.parquet"
    csv_path: Path | None = None
    # The user's columns a committed parquet may answer with — None until step (2)
    # finds the collection declares some. See `_declared_columns`.
    declared: set[str] | None = None
    # A baked collection's MANIFEST decides whether it has metadata, never the parquet's
    # existence: an images-only ingest writes a parquet too (see step (2) below). Read
    # only when step (1) does not answer — a named bundle needs nothing from the tree.
    baked = upload_id is None and db.is_dataset(ds_dir)
    roles = db.load_manifest(ds_dir).get("column_roles") if baked else None
    if upload_id is not None:
        # (1) A named bundle. `_resolve_finalized_bundle` raises 400/404 for a bad or
        # unfinalized id — the caller asked for something specific and can fix it.
        csv_path = _bundle_csv(_resolve_finalized_bundle(record.owner, upload_id))
    elif baked and roles is None:
        # (2a) Baked, and images-only. `column_roles` ABSENT is the contract's own
        # definition of that ("Absent => images-only dataset",
        # column_roles.schema.json) — and it is the only test that works, because an
        # images-only ingest DOES write `metadata.parquet`: `(id, filename, width,
        # height)`, or `(id, filename)` in a pre-D2 tree like the committed
        # `golden_dataset_images_only_v2` (measured 2026-09-21). Deciding this from the
        # file's existence answered `parquet` with the pipeline's dense key and its join
        # key as columns to map (review of PR #358, round 3, finding 1). The committed
        # state beats the recorded bundle here exactly as a committed parquet does: an
        # images-only RE-INGEST (D-25) can leave a bundle with a CSV recorded, and its
        # columns are reachable by naming it (`?upload_id=`), not by default.
        return ColumnListResponse(source="images_only", columns=[])
    elif roles is not None and parquet_path.is_file():
        declared = _declared_columns(roles)  # (2b) the committed, declared columns
    elif roles is not None:
        # (2c) The manifest DECLARES metadata and the parquet is gone. The pipeline does
        # not produce this tree (ingest writes the two together), so it is broken rather
        # than a state to describe: not `images_only` — the manifest says there IS
        # metadata — and not the recorded bundle, which would dress it as a collection
        # that has never baked.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Dataset metadata not found",
        )
    else:
        # (3) THIS dataset's own bundle, and nothing wider. A recorded id whose bundle
        # has since been deleted resolves to None, exactly like recording none at all.
        recorded = _recorded_bundle(record)
        if recorded is not None:
            csv_path = _bundle_csv(recorded)
        else:
            # Never baked, no recorded bundle, no id given: nothing to describe. (Every
            # BAKED collection was answered by (2) above, from its manifest.)
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Dataset metadata not found",
            )

    source: Literal["parquet", "upload", "images_only"]
    if declared is not None:
        source = "parquet"
        literal = parquet_path.as_posix().replace("'", "''")
        source_sql = f"read_parquet('{literal}')"
    elif csv_path is not None:
        source = "upload"
        literal = csv_path.as_posix().replace("'", "''")
        source_sql = f"read_csv_auto('{literal}', all_varchar=true)"
    elif upload_id is not None:
        # (1) again: the caller NAMED a bundle and it carries no CSV. The answer is about
        # THAT BUNDLE — "the one you asked about has no columns" — so it stays `upload`
        # with an empty list, and makes no claim about the collection.
        #
        # `images_only` would be a claim, and frequently a false one: it is defined as
        # "the collection has no metadata source at all", and the route is reachable with
        # `?upload_id=` on a collection whose `metadata.parquet` is committed and full.
        # A Data view following `ColumnListResponse`'s own instruction — "read `source`,
        # not `len(columns)`" — then renders "no metadata yet" for a collection with ten
        # enrichment columns, because the user previewed an images-only bundle (review of
        # PR #358, finding 4). The enum was conflating two different facts and only one of
        # them is what the value means.
        return ColumnListResponse(source="upload", columns=[])
    else:
        # (3) again: never baked, and the collection's OWN recorded bundle carries no
        # CSV. Images-only, before the bake: an empty list with a source that NAMES the
        # case, so the Data view renders "no metadata yet" instead of an error — and
        # never someone else's columns. (The baked images-only case returned at (2a).)
        return ColumnListResponse(source="images_only", columns=[])
    try:
        columns = await run_in_threadpool(
            _describe_columns,
            cursor,
            source_sql,
            # Only the parquet's `id` is the pipeline's own dense key; a CSV column of
            # that name is a VARCHAR that sorts "10" before "9" (finding 3).
            order_by_id=source == "parquet",
        )
    except Exception as exc:  # noqa: BLE001 — a user-supplied file that will not parse
        # The DuckDB message names the server-side path, so it is LOGGED (never silent)
        # and the caller gets the fact without the path. 422, not 500: for the `upload`
        # source this is the caller's own file and resubmitting a fixed one is the
        # remedy; for `parquet` it means the committed file is unreadable, which the log
        # line is what surfaces.
        logger.warning(
            "Could not describe %s columns for dataset %r: %s", source, ds_id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"could not read this collection's {source} metadata source",
        ) from exc
    if declared is not None:
        # The USER'S columns only, in the parquet's own order. Filtered AFTER the
        # describe, so the sample row is still the one `ORDER BY "id"` picked — `id` is
        # read to order by, never offered to map.
        columns = [column for column in columns if column.name in declared]
    return ColumnListResponse(source=source, columns=columns)


@router.get(
    "/api/datasets/{ds_id}/presentation", response_model_exclude_none=True
)
async def get_dataset_presentation(
    ds_id: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> PresentationResponse:
    """The dataset's EFFECTIVE presentation record (D-xv/D-xvi/D-xvii/D-xviii): its own
    `presentation.json`, merged with the two fallbacks that exist while the migration is
    incomplete — the app-state row for the three scalars, and a pre-2.9 manifest's
    `column_roles.url` rendered as `columns.<name>.render`.

    Its own resource, not a block bolted onto the manifest response: the two records have
    two writers and one wire shape would put them back together. Visibility-scoped exactly
    like every other read (D-34, may_read) — a private dataset the caller cannot read 404s,
    the same 404 as a missing one.

    A dataset with NO record answers `{"presentation_version": "1.0", "dataset": {},
    "layouts": {}, "columns": {}}` — absent means absent, never an error, so a consumer's
    "no record ⇒ today's behaviour" branch is the same branch as "empty record"."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    try:
        manifest: dict | None = db.load_manifest(ds_dir)
    except HTTPException:
        # No manifest (or an unservable one): presentation does not depend on a bake
        # having run (D-xvii), so serve the record without the legacy roles fallback
        # rather than 404ing a dataset whose display choices already exist.
        manifest = None
    record = await appstate.get_dataset_record(session, ds_id)
    return PresentationResponse(
        **presentation.effective(
            presentation.load(ds_dir),
            roles=(manifest or {}).get("column_roles"),
            fallback=record,
        )
    )


def _unresolved_presentation_keys(
    cursor: Any, ds_dir: Path, updates: dict[str, Any]
) -> dict[str, list[str]]:
    """The `columns` / `layouts` keys in `updates` that name nothing this dataset has,
    for the log line below. Runs OFF the event loop (it may DESCRIBE the parquet).

    WHY THIS ONLY REPORTS. `PATCH {"columns": {"sorce_url": {"render": "url"}}}` (a typo)
    is stored, the column is absent from `row.fields`, the panel never draws it, and
    before this nothing anywhere said so — the bake-time guard that a url column must
    exist and be a stored scalar was deleted in PR #346 and the write side did not take it
    over (review of PR #346, finding 9). The obvious repair is to REFUSE the write, and it
    is the wrong one, for a reason that is already pinned:

        test_presentation_serving.py::test_every_dangling_reference_falls_back_and_
        returns_200 PATCHes `{"columns": {"vanished": ...}, "layouts": {"also_gone": ...}}`
        and asserts 200, because "each is the NORMAL consequence of two files changing
        independently (D-xvi)".

    That is not a stale test. A column really can disappear between the designer loading
    and the owner submitting — a metadata update drops it — and refusing the whole PATCH
    then loses every other edit in it. So the line sits here: **the write never refuses an
    unresolvable reference, and it never stays silent about one either.** D-xvi's fail-soft
    rule is about RESOLUTION (read-side, and permanent — nothing re-validates a stored
    file); this is about OBSERVABILITY of a write, which is a different question, and
    answering it with a refusal would collapse the two.

    The remaining gap is deliberate and worth naming: a log line reaches the operator, not
    the owner who made the typo. Telling the CALLER needs a field on the PATCH response —
    a wire change, so it is filed rather than smuggled in
    ([[T2-a-presentation-patch-does-not-tell-the-caller]]).

    "Names nothing" is judged only against what the dataset can actually say. A column is
    checked against `db.scalar_columns` — the same scalar-only set `/api/metadata` returns
    as `fields` and the panel draws from, so this reproduces BOTH halves of the deleted
    bake guard (exists in the header, and is a stored scalar). A layout is checked against
    the committed manifest's `layout_id`s. When there is no parquet or no manifest yet
    (presentation is writable before a bake — D-xvii) there is nothing to contradict, so
    nothing is reported: this must never guess."""
    out: dict[str, list[str]] = {}
    sent_columns = updates.get("columns")
    if isinstance(sent_columns, dict) and sent_columns:
        try:
            known = set(db.scalar_columns(cursor, ds_dir / "metadata.parquet"))
        except Exception:  # noqa: BLE001 — no parquet, or a read that failed: cannot say
            known = set()
        else:
            unresolved = sorted(k for k in sent_columns if k not in known)
            if unresolved:
                out["columns"] = unresolved
    sent_layouts = updates.get("layouts")
    if isinstance(sent_layouts, dict) and sent_layouts:
        try:
            manifest = db.load_manifest(ds_dir)
        except Exception:  # noqa: BLE001 — no manifest yet, or unservable: cannot say
            pass
        else:
            known_layouts = {
                layout.get("layout_id")
                for layout in manifest.get("layouts", [])
                if isinstance(layout, dict)
            }
            unresolved = sorted(k for k in sent_layouts if k not in known_layouts)
            if unresolved:
                out["layouts"] = unresolved
    return out


@router.patch("/api/datasets/{ds_id}/presentation")
async def update_dataset_presentation(
    ds_id: str,
    body: DatasetPresentationUpdate,
    request: Request,
    user: appstate.CurrentUser = Depends(appstate.get_current_user),
    session: AsyncSession = Depends(appstate.get_session),
    cursor: Any = Depends(db.get_cursor),
) -> DatasetSummaryPresentation:
    """Set a collection's presentation. Owner-only. Writes `presentation.json` in the
    dataset's own directory (D-xv) — the API is that file's only writer, and it still
    writes no manifest, so a bake in flight can neither clobber this nor be clobbered by
    it. Same authz, same owner, same statuses as before the storage moved: no new
    permission surface and no new caller.

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
    here (not 403): with no record there is nothing to name. A tree that cannot be
    WRITTEN — the showcase profile mounts its content `:ro` on purpose — is a 409 naming
    that cause, the same shape DELETE answers for a read-only fixture (T2-91), never a
    bare 500.
    """
    # `model_fields_set` IS the set of keys the client sent — exactly the signal
    # presentation.apply_updates consumes, so it passes straight through with no per-field
    # parameters or booleans (PR250-6). Every writable key, not just the three scalars:
    # `columns` is what the intake split writes (D-xvii) and what a later edit changes,
    # since deciding a column is a link "only needs the CSV to exist".
    updates = {
        field: getattr(body, field)
        for field in DatasetPresentationUpdate.model_fields
        if field in body.model_fields_set
    }
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "provide at least one of: "
                f"{sorted(DatasetPresentationUpdate.model_fields)}"
            ),
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
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    # Hold the per-`dataset_id` API-mutation lock across the read-modify-write. A file is
    # not a row: two concurrent PATCHes would otherwise both read the old record and the
    # second would drop the first's field (a SQL UPDATE could not lose one that way). The
    # SAME lock create and DELETE take, so a rename cannot land in a directory being torn
    # down either. `best_effort_when_down=True` keeps a Redis outage from taking naming
    # away — degrading to lockless is what DELETE already does, and the losing-update case
    # needs two simultaneous editors of one dataset.
    try:
        async with queue.dataset_lock(
            request.app.state.redis, ds_id, best_effort_when_down=True
        ):
            stored = await run_in_threadpool(
                presentation.update, ds_dir, updates, fallback=record
            )
    except appstate.PresentationValueError as exc:
        # Covers presentation.PresentationError too (it subclasses this), so the length
        # rules and the write refusals map through one place.
        raise _presentation_http_error(exc) from exc
    except LockUnavailableError as exc:
        logger.warning(
            "Could not acquire dataset lock for presentation write of %r: %s", ds_id, exc
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dataset busy; try again",
        ) from exc
    # The write SUCCEEDED and stays succeeded — this is a report, not a gate (see
    # `_unresolved_presentation_keys` for why refusing would be wrong). Deliberately after
    # the write and outside the lock: a failure to describe the parquet must never cost the
    # caller their edit.
    if "columns" in updates or "layouts" in updates:
        unresolved = await run_in_threadpool(
            _unresolved_presentation_keys, cursor, ds_dir, updates
        )
        if unresolved:
            logger.warning(
                "Presentation write on %r by %r stored keys that name nothing this "
                "dataset has: %s. They are kept (D-xvi — a reference may resolve again "
                "after a re-bake) but nothing will draw them; check the spelling against "
                "GET /api/metadata fields and the manifest's layout_ids.",
                ds_id,
                user.username,
                ", ".join(f"{where}={names}" for where, names in sorted(unresolved.items())),
            )
    # Echo the stored values generically over PRESENTATION_LIMITS (PR250-6), so a new
    # presentation field is carried here by growing that one table — no hand-listed line
    # per field. The echo shape is deliberately unchanged by the storage move. It reports
    # the EFFECTIVE scalars, not the raw file: a PATCH that touched only `columns` creates
    # no `dataset` block, and echoing the raw file would then report a collection with an
    # app-state name as unnamed — a lie about the state the caller just left it in.
    resolved = presentation.effective_dataset(stored, fallback=record)
    return DatasetSummaryPresentation(
        dataset_id=ds_id,
        **{field: resolved.get(field) for field in appstate.PRESENTATION_LIMITS},
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
                    # Not "an ingest job": this guard refuses over ANY recorded job, and
                    # since seam L1 that includes an add-layouts bake, a layout deletion
                    # and a roles re-declaration. Kept identical to the wording
                    # `jobs._guard_no_job_in_flight` answers on the other four routes.
                    detail="Another job for this collection is still running",
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
