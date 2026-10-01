"""Thin RQ job *enqueuer* (decision D-15).

Enqueues the pipeline ingest job by its DOTTED-PATH STRING; RQ resolves that
string to a callable inside the worker process at execution time. This module
NEVER imports the `pipeline` package, so the API image carries no pipeline
dependencies (cross-package rule #7). It holds no DuckDB connection and serves
no HTTP. (Formerly api/worker.py; renamed because it dispatches jobs.)
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

import rq  # type: ignore[import-untyped]
from fastapi.concurrency import run_in_threadpool
from redis import Redis
from redis.exceptions import RedisError

# The pipeline job is referenced by string only — never imported. The entry point
# is the PRIMITIVE-kwargs wrapper (run_ingest_job): the lean API image cannot import
# or construct pipeline.worker.IngestJobPayload, so primitives cross the RQ boundary
# and the worker rebuilds the typed payload (decision D-15, cross-package rule #7).
RUN_INGEST_PATH = "pipeline.worker.run_ingest_job"

# The add-layouts job (T2-58/T2-42), enqueued by the same primitive-kwargs pattern:
# the lean API image cannot construct pipeline.worker.AddLayoutsJobPayload, so the
# dotted path resolves inside the worker to run_add_layouts_job, which rebuilds the
# typed payload. Bake ADDITIONAL layouts onto a committed dataset without a full
# re-ingest (metadata/detail/existing pyramids are read-only; an id-integrity guard
# protects the live dataset).
RUN_ADD_LAYOUTS_PATH = "pipeline.worker.run_add_layouts_job"

# Seam L2's two lifecycle verbs, enqueued by the SAME primitive-kwargs pattern. Both
# are FAST jobs — no decode, no bake, no tile written — but they rewrite
# layout_manifest.json, which only the worker may do (D-15/D-xv), so they are jobs and
# not HTTP mutations. delete-layout removes ONE committed layout and sweeps the bytes it
# owned; set-roles re-declares column_roles with no bake and reports what that stales.
RUN_DELETE_LAYOUT_PATH = "pipeline.worker.run_delete_layout_job"
RUN_SET_ROLES_PATH = "pipeline.worker.run_set_roles_job"

# T2-97: RQ's `job_timeout` defaults to 180s when an enqueue call omits it, and
# `main.py`'s `Queue(connection=...)` sets no `default_timeout` either — so every
# job inherited the 180s ceiling and was killed mid-bake. Invisible until now
# because CLI bakes (`pixscope ingest --sync`) call the worker directly and never
# touch RQ. Bounded rather than unlimited (RQ's `-1`) on purpose: a bound still
# reaps a genuinely hung job instead of pinning a worker forever; 24h is an
# operator-chosen ceiling generous enough for a real 1M bake (hours) and is easy
# to raise later if a legitimate job ever needs longer.
JOB_TIMEOUT_SECONDS = 24 * 60 * 60  # 24h

# Per-dataset API-mutation lock (PR24-8, decision DP-4). DELETE's check+rmtree and
# the create/re-ingest paths' record+enqueue critical sections both mutate one
# dataset's app-state row and on-disk tree; without serialization a DELETE can
# rmtree + drop the owner row WHILE a concurrent create is recording that owner and
# enqueueing — leaving an ownerless tree or a squatted id with no job. This reuses
# the D-19 per-dataset Redis lock pattern (the worker's commit lock) on the API
# side. The key namespace is DISTINCT from the worker's `ingest-commit:` lock: this
# guards the brief API critical section, not the worker's commit, so the two never
# contend on one key. The 409 contract is UNCHANGED — the lock only orders these
# sections; it never changes which status a caller observes.
_LOCK_KEY_PREFIX = "dataset-mutate:"
_LOCK_TIMEOUT_SECONDS = 30        # auto-expiry ceiling: the held section is fs-bound + a few queries
_LOCK_BLOCKING_TIMEOUT_SECONDS = 30  # how long a waiter blocks before giving up

# The per-(owner, upload) MINTED-create lock ([[T2-a-minted-create-is-not-idempotent-so-a-retried]]).
# A create that authors no id is refused when an earlier minted create of the owner's
# already built a collection from the upload (its `minted_from_upload_id`, committed
# with the new row). Two minted
# creates of one upload hold two DIFFERENT minted ids, so the dataset lock never
# serializes them; this key does, around the whole lookup → mint → row-with-key →
# enqueue → record-job sequence. A DISTINCT namespace from `dataset-mutate:`, so the two
# can never contend on one key. ORDER: this lock is always taken BEFORE the dataset lock
# and nothing takes them the other way round, so the pair cannot deadlock.
#
# It shares the two timeouts above rather than adding its own. The section it holds is
# the dataset lock's section plus one app-state lookup and the mint's per-draw
# checks, and the dataset lock it takes inside is on a freshly minted id no other request
# knows yet, so that inner acquire does not wait.
_UPLOAD_LOCK_KEY_PREFIX = "upload-create:"


# Default RQ broker URL when REDIS_URL is unset (e.g. the in-process test/boot path).
# `Redis.from_url` and `rq.Queue` are both lazy — neither contacts the broker at
# construction — so the lifespan runs (and the boot/health tests pass) with no live Redis;
# a connection is made only when something actually enqueues, fetches or locks.
_DEFAULT_REDIS_URL = "redis://localhost:6379/0"


def redis_client() -> Redis:
    """A broker client resolved from `REDIS_URL`. The ONE place that answer is computed.

    The lifespan (`main.py`) uses it for `app.state.redis`, and `api.admin` uses it to take
    the SAME `dataset-mutate:{id}` lock the routes take — the CLI has no `app.state`, and
    before this it wrote `presentation.json` with no lock at all while the API it was
    invoked through (`docker compose exec api …`) was live and serving PATCHes (review of
    PR #346, finding 4). Two homes for the URL would have let the CLI lock a different
    broker than the API, which is indistinguishable from not locking."""
    return Redis.from_url(os.environ.get("REDIS_URL", _DEFAULT_REDIS_URL))


class LockUnavailableError(RuntimeError):
    """An API mutation lock (`dataset_lock` or `upload_create_lock`) could not be
    acquired (broker unreachable, or a peer held it past the blocking timeout). Callers
    translate this to a 503 — it is
    DISTINCT from any HTTPException (404/403/409) raised INSIDE the locked section,
    which must propagate unchanged."""


class _LockClient(Protocol):
    """The slice of redis.Redis the dataset lock needs. A test passes a fake with
    the same shape (no live Redis in unit tests, per the brief)."""

    def lock(self, name: str, *, timeout: float | None = ..., blocking_timeout: float | None = ...) -> Any: ...


def dataset_lock(
    redis_client: _LockClient, dataset_id: str, *, best_effort_when_down: bool = False
) -> AbstractAsyncContextManager[None]:
    """Hold the per-`dataset_id` API-mutation lock for the duration of the block
    (PR24-8 / DP-4). Acquired around DELETE's check+rmtree and the create/re-ingest
    record+enqueue critical sections so those operations on the SAME dataset
    serialize. The mechanism, and every property it has, is `_api_lock`'s."""
    return _api_lock(
        redis_client,
        f"{_LOCK_KEY_PREFIX}{dataset_id}",
        best_effort_when_down=best_effort_when_down,
    )


def upload_create_lock(
    redis_client: _LockClient, owner: str, upload_id: str
) -> AbstractAsyncContextManager[None]:
    """Hold the per-(`owner`, `upload_id`) minted-create lock for the duration of the
    block (see `_UPLOAD_LOCK_KEY_PREFIX`). The SAME mechanism as `dataset_lock`
    (`_api_lock`), under its own key namespace, with no `best_effort_when_down`: a create
    cannot enqueue without the broker, so an outage is the same clean 503. Take it
    BEFORE any dataset lock, never after. The key is unambiguous: an `upload_id` is
    `[A-Za-z0-9_-]+` (the uploads router's jail), so it holds no `/`, and the owner is
    everything before the LAST one."""
    return _api_lock(redis_client, f"{_UPLOAD_LOCK_KEY_PREFIX}{owner}/{upload_id}")


@asynccontextmanager
async def _api_lock(
    redis_client: _LockClient, key: str, *, best_effort_when_down: bool = False
) -> AsyncIterator[None]:
    """Hold the API-side Redis lock `key` for the duration of the block — the ONE
    mechanism behind `dataset_lock` and `upload_create_lock`, which differ only in the
    key. `redis_client` is `app.state.redis` (the lifespan's per-worker Redis client);
    unit tests inject a fake exposing `.lock()` so no broker is needed.

    This is an ASYNC context manager (`async with`) on purpose: redis-py's
    `lock.acquire()`/`release()` are BLOCKING calls — a `SET` round-trip plus, under
    contention, a `time.sleep` retry loop up to `_LOCK_BLOCKING_TIMEOUT_SECONDS`. The
    routes are `async def`, so running them inline would block the asyncio event loop
    (the same hazard `_resolve_job_states` avoids for `Job.fetch_many`); on the loop a
    contended acquire would freeze the whole worker for the blocking window and, with
    the holder suspended at an `await`, deadlock holder against waiter until the lock
    lapses. So both acquire and release run via `run_in_threadpool`.

    Implemented with redis-py's lock (the same primitive the worker's D-19 commit
    lock uses; the worker may block freely — it is a synchronous RQ process with no
    event loop). The lock auto-expires after `_LOCK_TIMEOUT_SECONDS` so a crashed
    holder cannot wedge the dataset forever; a waiter blocks up to
    `_LOCK_BLOCKING_TIMEOUT_SECONDS`. Failure to acquire raises `LockUnavailableError`
    (surfaced as a 503 by the caller) rather than proceeding unserialized."""
    lock = redis_client.lock(
        key,
        timeout=_LOCK_TIMEOUT_SECONDS,
        blocking_timeout=_LOCK_BLOCKING_TIMEOUT_SECONDS,
    )
    # PR #38 review finding 1: redis-py's acquire() returns False ONLY when a
    # peer holds the lock; a broker outage RAISES RedisError. The two must
    # diverge — D-28 binds "a dataset must stay deletable when Redis is down",
    # so DELETE passes best_effort_when_down=True and degrades to LOCKLESS on
    # an outage (with the broker gone there is no concurrent enqueue to race —
    # enqueue needs Redis too). Create/re-ingest keep a clean 503: they cannot
    # enqueue without the broker regardless. acquire()/release() are offloaded to
    # the threadpool (see the docstring) so neither blocks the event loop.
    try:
        acquired = await run_in_threadpool(lock.acquire)
    except RedisError as exc:
        if best_effort_when_down:
            yield
            return
        raise LockUnavailableError(
            f"redis unavailable for lock {key}"
        ) from exc
    if not acquired:
        raise LockUnavailableError(f"could not acquire lock {key}")
    try:
        yield
    finally:
        try:
            await run_in_threadpool(lock.release)
        except Exception:
            # The lock may already have expired (held past timeout) or been
            # released; the critical section has completed regardless. Never mask
            # the body's own exception with a release error.
            pass


def enqueue_ingest(
    queue: rq.Queue,
    *,
    dataset_id: str,
    owner: str,
    images_dir: str,
    output_root: str,
    layout_types: list[str],
    csv_path: str | None = None,
    column_roles: dict | None = None,
    detail_tier: str = "bake",
) -> str:
    """Enqueue the ingest job by dotted-path string with JSON-PRIMITIVE kwargs
    only: `queue.enqueue(RUN_INGEST_PATH, kwargs={...})`. No object crosses the RQ
    boundary and `pipeline` is never imported (decision D-15): the lean API image
    cannot construct `pipeline.worker.IngestJobPayload`, so primitives cross and the
    worker (`run_ingest_job`) rebuilds the typed payload. These kwarg names mirror
    `pipeline.worker.run_ingest_job` and are pinned by the `tests/smoke` enqueue
    drift guard. Returns the job id. Holds no DuckDB connection; serves no HTTP.

    `detail_tier` (T2-46) defaults to "bake" (unchanged when a caller omits it — e.g.
    create_dataset does); "skip" bakes no detail tier. It is a bare string primitive
    crossing to the worker's `run_ingest_job(detail_tier=...)`.

    `job_timeout=JOB_TIMEOUT_SECONDS` (T2-97) is a top-level `enqueue()` arg — RQ's
    own per-job ceiling, not a job kwarg — so it never crosses to `run_ingest_job`
    and cannot appear in the enqueue drift guard's kwarg set.
    """
    # Only JSON primitives cross the boundary — strings, a list[str], and the
    # optional dict/None. Both csv_path AND column_roles are None for an
    # images-only ingest (decision D-25). The dotted path resolves to the
    # primitive-kwargs wrapper inside the worker process; the API never imports it.
    job = queue.enqueue(
        RUN_INGEST_PATH,
        kwargs={
            "dataset_id": dataset_id,
            "owner": owner,
            "images_dir": images_dir,
            "output_root": output_root,
            "layout_types": layout_types,
            "csv_path": csv_path,
            "column_roles": column_roles,
            "detail_tier": detail_tier,
        },
        job_timeout=JOB_TIMEOUT_SECONDS,
    )
    return job.id


def enqueue_add_layouts(
    queue: rq.Queue,
    *,
    dataset_id: str,
    owner: str,
    images_dir: str,
    output_root: str,
    layout_specs: list[str],
    column_roles: dict | None = None,
    replace: list[str] | None = None,
) -> str:
    """Enqueue the add-layouts job (T2-58/T2-42) by dotted-path string with
    JSON-PRIMITIVE kwargs only: `queue.enqueue(RUN_ADD_LAYOUTS_PATH, kwargs={...})`.
    No object crosses the RQ boundary and `pipeline` is never imported (decision
    D-15): the lean API image cannot construct `pipeline.worker.AddLayoutsJobPayload`,
    so primitives cross and the worker (`run_add_layouts_job`) rebuilds the typed
    payload. These kwarg names mirror `pipeline.worker.run_add_layouts_job` and are
    pinned by the `tests/smoke` enqueue drift guard. Returns the job id. Holds no
    DuckDB connection; serves no HTTP.

    `column_roles` defaults to None (⇒ the worker reuses the committed manifest's
    roles); `images_dir` is the ORIGINAL source images (from a finalized upload
    bundle, resolved API-side inside the owner's jail) the id-integrity guard checks
    against the committed dataset.

    `replace` (seam L1) is the per-id opt-in to RE-BAKING a committed layout — the
    enqueue half of `pixscope add-layouts --replace`, which seam L2 landed everywhere
    EXCEPT here (the wrapper's parameter set is asserted exactly by the `tests/smoke`
    drift guard, so the three files had to move together —
    [[T2-the-add-layouts-enqueue-contract-cannot-carry]]). None and `[]` are the same
    thing and mean today's behaviour exactly: the worker's collision guard still
    refuses an existing `layout_id` that is not named here. Forwarded VERBATIM and
    validated nowhere on this side — the worker checks each id against the EXPANDED
    layout ids (`_guard_replace_targets`), which the API cannot compute without
    importing the pipeline, so an API-side pre-check would reject the legitimate
    `layout_specs=["categorical"], replace=["categorical_kingdom"]`.

    `job_timeout=JOB_TIMEOUT_SECONDS` (T2-97) is a top-level `enqueue()` arg — RQ's
    own per-job ceiling, not a job kwarg — so it never crosses to `run_add_layouts_job`
    and cannot appear in the enqueue drift guard's kwarg set.
    """
    job = queue.enqueue(
        RUN_ADD_LAYOUTS_PATH,
        kwargs={
            "dataset_id": dataset_id,
            "owner": owner,
            "images_dir": images_dir,
            "output_root": output_root,
            "layout_specs": layout_specs,
            "column_roles": column_roles,
            "replace": replace,
        },
        job_timeout=JOB_TIMEOUT_SECONDS,
    )
    return job.id


def enqueue_delete_layout(
    queue: rq.Queue,
    *,
    dataset_id: str,
    owner: str,
    output_root: str,
    layout_id: str,
) -> str:
    """Enqueue seam L2's delete-layout job by dotted-path string with JSON-PRIMITIVE
    kwargs only: `queue.enqueue(RUN_DELETE_LAYOUT_PATH, kwargs={...})`. No object
    crosses the RQ boundary and `pipeline` is never imported (decision D-15): the lean
    API image cannot construct `pipeline.worker.DeleteLayoutJobPayload`, so primitives
    cross and the worker (`run_delete_layout_job`) rebuilds the typed payload. These
    kwarg names mirror `pipeline.worker.run_delete_layout_job` and are pinned by the
    `tests/smoke` enqueue drift guard. Returns the job id. Holds no DuckDB connection;
    serves no HTTP.

    `owner` is a LABEL for the dataset's ingest.log only — ownership itself is API
    app-state and was already resolved for this request (D-22/D-23); the worker never
    authorizes. `layout_id` is the committed layout to remove; the worker REFUSES an id
    that is not committed and refuses to remove the LAST one (D-viii).

    `job_timeout=JOB_TIMEOUT_SECONDS` (T2-97) is a top-level `enqueue()` arg — RQ's own
    per-job ceiling, not a job kwarg — so it never crosses to `run_delete_layout_job`
    and cannot appear in the enqueue drift guard's kwarg set. The same 24h bound every
    other job carries: a second, tighter constant for a verb that writes one JSON file
    and unlinks a directory would be a picked number with nothing behind it.
    """
    job = queue.enqueue(
        RUN_DELETE_LAYOUT_PATH,
        kwargs={
            "dataset_id": dataset_id,
            "owner": owner,
            "output_root": output_root,
            "layout_id": layout_id,
        },
        job_timeout=JOB_TIMEOUT_SECONDS,
    )
    return job.id


def enqueue_set_roles(
    queue: rq.Queue,
    *,
    dataset_id: str,
    owner: str,
    output_root: str,
    column_roles: dict,
) -> str:
    """Enqueue seam L2's set-roles job by dotted-path string with JSON-PRIMITIVE kwargs
    only: `queue.enqueue(RUN_SET_ROLES_PATH, kwargs={...})`. No object crosses the RQ
    boundary and `pipeline` is never imported (decision D-15): the lean API image cannot
    construct `pipeline.worker.SetRolesJobPayload`, so primitives cross and the worker
    (`run_set_roles_job`) rebuilds the typed payload. These kwarg names mirror
    `pipeline.worker.run_set_roles_job` and are pinned by the `tests/smoke` enqueue drift
    guard. Returns the job id. Holds no DuckDB connection; serves no HTTP.

    `column_roles` is the FULL replacement map, never a patch — a partial map would make
    "the user cleared this role" indistinguishable from "the user did not mention it".
    Forwarded VERBATIM: the worker re-validates it against the committed
    metadata.parquet with add-layouts' own checks (D-11 is the validator of record), and
    a second validator on this side would be a second source of truth for a rule the API
    cannot evaluate at all without the parquet's dtypes.

    `job_timeout=JOB_TIMEOUT_SECONDS` (T2-97) is a top-level `enqueue()` arg — RQ's own
    per-job ceiling, not a job kwarg — so it never crosses to `run_set_roles_job` and
    cannot appear in the enqueue drift guard's kwarg set.
    """
    job = queue.enqueue(
        RUN_SET_ROLES_PATH,
        kwargs={
            "dataset_id": dataset_id,
            "owner": owner,
            "output_root": output_root,
            "column_roles": column_roles,
        },
        job_timeout=JOB_TIMEOUT_SECONDS,
    )
    return job.id
