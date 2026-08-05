"""R3 staging-sweep hygiene + the Seam O1 V1 fix (lean — file ops + RQ mocking, no
pyvips). ``sweep_staging`` must reap a `.staging-{job}` dir ONLY when it is BOTH
not-active AND stale past the TTL, so a live bake — whose progress.json rewrites
self-refresh its dir mtime at ~1 Hz — is never clobbered.

The headline case is the CONFIRMED V1 data-loss bug: with REDIS_URL set (the compose
default) a second concurrent CLI ``--sync`` bake's sweep used to reap a FIRST live CLI
bake's staging dir, because a CLI uuid is never in RQ (``Job.fetch`` → NoSuchJobError
→ treated-as-orphan → rmtree). The TTL freshness floor closes it.
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import pytest
import redis
from rq.exceptions import NoSuchJobError
from rq.job import Job

from pipeline import worker

_TTL = worker._STAGING_TTL_SECONDS
_LOG = logging.getLogger("test.sweep")


def _staging(root: Path, job_id: str, *, stale: bool) -> Path:
    d = root / f".staging-{job_id}"
    d.mkdir()
    if stale:
        old = time.time() - (_TTL + 100)
        os.utime(d, (old, old))  # push the mtime past the TTL floor
    return d


# --- sweep_staging: the two-signal keep rule (V1 fix) ----------------------


def test_sweep_keeps_fresh_dir_not_in_active_set(tmp_path: Path) -> None:
    """V1(a): a FRESH-mtime dir whose job is NOT in the active set SURVIVES — the TTL
    floor now applies to the active-set branch too. (A live CLI bake's uuid is never in
    RQ, but its progress.json writes keep the dir fresh.)"""
    d = _staging(tmp_path, "cli-uuid", stale=False)
    swept = worker.sweep_staging(tmp_path, active_job_ids={"some-other-job"})
    assert swept == []
    assert d.is_dir()


def test_sweep_reaps_stale_dir_not_in_active(tmp_path: Path) -> None:
    """V1(b): a STALE-mtime dir not in the active set is reaped (both signals agree it
    is dead)."""
    d = _staging(tmp_path, "dead-job", stale=True)
    swept = worker.sweep_staging(tmp_path, active_job_ids={"some-other-job"})
    assert [p.name for p in swept] == [".staging-dead-job"]
    assert not d.exists()


def test_sweep_keeps_active_dir_even_when_stale(tmp_path: Path) -> None:
    """A dir whose job IS in the active set is kept even with a stale mtime — a real
    RQ-confirmed >24h bake."""
    d = _staging(tmp_path, "longbake", stale=True)
    swept = worker.sweep_staging(tmp_path, active_job_ids={"longbake"})
    assert swept == []
    assert d.is_dir()


def test_sweep_no_active_set_uses_ttl_floor(tmp_path: Path) -> None:
    """With no active set (broker-less / CLI path) the pure TTL floor stands: fresh
    kept, stale reaped."""
    fresh = _staging(tmp_path, "fresh", stale=False)
    stale = _staging(tmp_path, "stale", stale=True)
    swept = worker.sweep_staging(tmp_path)  # active_job_ids=None
    assert fresh.is_dir()
    assert not stale.exists()
    assert [p.name for p in swept] == [".staging-stale"]


# --- _sweep_orphan_staging: RQ classification (V1 fix) ---------------------


def test_orphan_sweep_cli_concurrent_bake_survives(tmp_path: Path, monkeypatch) -> None:
    """THE V1 REGRESSION: with REDIS_URL set, a SECOND CLI --sync bake's sweep must NOT
    reap a FIRST live CLI bake's FRESH staging dir. The first bake's uuid is never in
    RQ (Job.fetch → NoSuchJobError), so it is absent from the active set — but the TTL
    freshness floor keeps it (its progress.json rewrites refresh the mtime)."""
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    live_peer = _staging(tmp_path, "bake1-uuid", stale=False)  # fresh: a live CLI bake

    def _missing(job_id, connection=None):  # noqa: ANN001, ANN202
        raise NoSuchJobError("no such job")  # a CLI uuid is never registered in RQ

    monkeypatch.setattr(Job, "fetch", _missing)

    worker._sweep_orphan_staging(tmp_path, "bake2-uuid", _LOG)  # bake 2 sweeps
    assert live_peer.is_dir()  # the first live bake's dir SURVIVES (was reaped pre-fix)


def test_orphan_sweep_keeps_stale_dir_on_transport_error(tmp_path: Path, monkeypatch) -> None:
    """V1(c): a Job.fetch TRANSPORT error (RedisError-family) is UNKNOWN, not orphaned —
    the dir is kept THIS pass (added to the active set) even when its mtime is stale, so
    a broker blip never reaps a peer that might be live."""
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    peer = _staging(tmp_path, "peer", stale=True)  # stale, so ONLY the keep-on-error path saves it

    def _blip(job_id, connection=None):  # noqa: ANN001, ANN202
        raise redis.exceptions.RedisError("broker blip")

    monkeypatch.setattr(Job, "fetch", _blip)

    worker._sweep_orphan_staging(tmp_path, "current", _LOG)
    assert peer.is_dir()  # transport error → kept, never conflated with orphaned


def test_orphan_sweep_reaps_stale_dead_job(tmp_path: Path, monkeypatch) -> None:
    """A genuinely gone job (NoSuchJobError) with a STALE dir IS reaped — the hygiene
    the seam adds still works; only fresh / active / unknown dirs are spared."""
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    dead = _staging(tmp_path, "deadjob", stale=True)

    def _missing(job_id, connection=None):  # noqa: ANN001, ANN202
        raise NoSuchJobError("no such job")

    monkeypatch.setattr(Job, "fetch", _missing)

    worker._sweep_orphan_staging(tmp_path, "current", _LOG)
    assert not dead.exists()


def test_orphan_sweep_keeps_rq_active_peer(tmp_path: Path, monkeypatch) -> None:
    """An RQ peer reported as `started` is added to the active set and kept (even when
    stale — the active-set keep-signal)."""
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    peer = _staging(tmp_path, "rqpeer", stale=True)

    class _Started:
        def get_status(self, refresh=True):  # noqa: ANN001, ANN201
            return "started"

    monkeypatch.setattr(Job, "fetch", lambda job_id, connection=None: _Started())

    worker._sweep_orphan_staging(tmp_path, "current", _LOG)
    assert peer.is_dir()


@pytest.mark.parametrize("has_broker", [True, False])
def test_orphan_sweep_never_raises(tmp_path: Path, monkeypatch, has_broker: bool) -> None:
    """Cleanup is best-effort (directive §1.3): even a totally broken RQ path must not
    raise out of the sweep."""
    if has_broker:
        monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")

        def _boom(job_id, connection=None):  # noqa: ANN001, ANN202
            raise RuntimeError("unexpected")

        monkeypatch.setattr(Job, "fetch", _boom)
    else:
        monkeypatch.delenv("REDIS_URL", raising=False)
    _staging(tmp_path, "x", stale=False)
    worker._sweep_orphan_staging(tmp_path, "current", _LOG)  # must not raise
