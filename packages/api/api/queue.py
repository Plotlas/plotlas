"""Thin RQ job *enqueuer* (decision D-15).

Enqueues the pipeline ingest job by its DOTTED-PATH STRING; RQ resolves that
string to a callable inside the worker process at execution time. This module
NEVER imports the `pipeline` package, so the API image carries no pipeline
dependencies (cross-package rule #7). It holds no DuckDB connection and serves
no HTTP. (Formerly api/worker.py; renamed because it dispatches jobs.)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Protocol

import rq  # type: ignore[import-untyped]
from fastapi.concurrency import run_in_threadpool
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


class LockUnavailableError(RuntimeError):
    """The per-dataset mutation lock could not be acquired (broker unreachable, or a
    peer held it past the blocking timeout). Callers translate this to a 503 — it is
    DISTINCT from any HTTPException (404/403/409) raised INSIDE the locked section,
    which must propagate unchanged."""


class _LockClient(Protocol):
    """The slice of redis.Redis the dataset lock needs. A test passes a fake with
    the same shape (no live Redis in unit tests, per the brief)."""

    def lock(self, name: str, *, timeout: float | None = ..., blocking_timeout: float | None = ...) -> Any: ...


@asynccontextmanager
async def dataset_lock(
    redis_client: _LockClient, dataset_id: str, *, best_effort_when_down: bool = False
) -> AsyncIterator[None]:
    """Hold the per-`dataset_id` API-mutation lock for the duration of the block
    (PR24-8 / DP-4). Acquired around DELETE's check+rmtree and the create/re-ingest
    record+enqueue critical sections so those operations on the SAME dataset
    serialize. `redis_client` is `app.state.redis` (the lifespan's per-worker Redis
    client); unit tests inject a fake exposing `.lock()` so no broker is needed.

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
        f"{_LOCK_KEY_PREFIX}{dataset_id}",
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
            f"redis unavailable for dataset lock {dataset_id}"
        ) from exc
    if not acquired:
        raise LockUnavailableError(f"could not acquire dataset lock for {dataset_id}")
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
        },
        job_timeout=JOB_TIMEOUT_SECONDS,
    )
    return job.id
