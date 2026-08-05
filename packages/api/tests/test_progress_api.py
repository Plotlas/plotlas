"""Tier-1 tests for the O1 API surface: GET /api/jobs progress passthrough and the
T2-104 ``DatasetSummary.active_job_id`` (the ready-while-baking signal).

Mocked RQ throughout (no live Redis, no worker) — a fake ``Job.fetch``/``fetch_many``
supplies the job state + ``job.meta``, exactly like test_write_ingest. App-state
owner/job seeds use a second engine over the same SQLite file (one asyncio.run each).
"""
from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api import appstate

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}

# A minimal but schema-valid v2 manifest (major 2) so db.load_manifest yields a
# "ready" summary — the dataset a re-bake job runs against.
_MANIFEST = (
    '{"manifest_version": "2.2", "dataset_version": 1, '
    '"dataset_metadata": {"image_count": 3, "ingest_timestamp": "2026-01-01T00:00:00"}, '
    '"layouts": [{"layout_id": "grid"}]}'
)

# A well-formed progress dict as the worker would write it to job.meta["progress"].
_PROGRESS = {
    "progress_version": 1,
    "spec_layouts": ["grid", "datetime"],
    "image_count": 100,
    "current": "layout:datetime",
    "stages": [
        {"key": "prepare", "label": "Scan + dimensions + metadata", "unit": "images",
         "done": 100, "total": 100, "state": "done", "t_start": 1.0, "t_end": 2.0},
        {"key": "layout:datetime", "label": "Bake layout: Date", "unit": "tiles",
         "done": 5, "total": 20, "state": "running", "t_start": 3.0, "t_end": None},
    ],
}


class _FakeQueue:
    def __init__(self) -> None:
        self.connection = object()  # passed to Job.fetch(_many); mocked away in tests

    def enqueue(self, func_string, kwargs=None, *, job_timeout=None):  # noqa: ANN001, ANN201
        return SimpleNamespace(id="job-test-123")


class _FakeRedis:
    def lock(self, name, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return SimpleNamespace(acquire=lambda *a, **k: True, release=lambda *a, **k: None)


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    (data_root / "datasets").mkdir(parents=True)
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        test_client.app.state.redis = _FakeRedis()
        test_client.app.state.queue = _FakeQueue()
        yield test_client


@pytest.fixture
def auth(client) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _seed_owner_and_job(db_path: Path, dataset_id: str, owner: str, job_id: str | None) -> None:
    """Record ``owner`` as the dataset's owner and, when given, its last_job_id — via a
    second engine over the same SQLite file (mirrors test_write_ingest). ``owner`` is
    the already-created authenticated user (the ``auth`` fixture's signup), so this does
    NOT re-insert the User (that would violate the unique-username constraint)."""
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
                if job_id is not None:
                    await appstate.record_dataset_job(session, dataset_id, job_id)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _write_manifest(dataset_id: str) -> None:
    import os

    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / dataset_id
    ds_dir.mkdir(parents=True, exist_ok=True)
    (ds_dir / "layout_manifest.json").write_text(_MANIFEST, encoding="utf-8")


def _patch_fetch_many(monkeypatch, status_by_id: dict[str, str]) -> None:
    """Patch datasets.Job.fetch_many to answer each id's RQ status (covers both
    list_datasets and get_dataset — the latter fetches a batch of one)."""
    from api.routers import datasets as datasets_router

    def fake(job_ids, connection=None, serializer=None):  # noqa: ANN001, ANN202
        return [
            SimpleNamespace(get_status=lambda refresh=True, _s=status_by_id.get(jid): _s)
            for jid in job_ids
        ]

    monkeypatch.setattr(datasets_router.Job, "fetch_many", fake)


# --- GET /api/jobs progress passthrough ------------------------------------


def test_get_job_surfaces_progress_from_meta(client, auth, app_db, monkeypatch) -> None:
    """Seam O1: get_job merges job.meta["progress"] into JobStatus.progress."""
    from api.routers import jobs as jobs_router

    _seed_owner_and_job(app_db, "ds1", "alice", None)  # D-34: alice owns the job's dataset
    fake_job = SimpleNamespace(
        get_status=lambda: "started",
        kwargs={"dataset_id": "ds1", "output_root": "/nonexistent"},
        exc_info=None,
        get_meta=lambda refresh=False: {"progress": _PROGRESS},
    )
    monkeypatch.setattr(jobs_router.Job, "fetch", lambda job_id, connection=None: fake_job)

    body = client.get("/api/jobs/whatever", headers=auth).json()
    assert body["state"] == "started"
    prog = body["progress"]
    assert prog["progress_version"] == 1
    assert prog["spec_layouts"] == ["grid", "datetime"]
    assert prog["image_count"] == 100
    assert prog["current"] == "layout:datetime"
    assert [s["key"] for s in prog["stages"]] == ["prepare", "layout:datetime"]
    assert prog["stages"][1]["state"] == "running"
    assert prog["stages"][1]["total"] == 20


def test_get_job_progress_null_when_meta_absent(client, auth, app_db, monkeypatch) -> None:
    """Backward-compatible: a pre-O1 job (empty meta) deserializes with progress=null,
    and the existing fields are untouched."""
    from api.routers import jobs as jobs_router

    _seed_owner_and_job(app_db, "ds1", "alice", None)  # D-34: alice owns the job's dataset
    fake_job = SimpleNamespace(
        get_status=lambda: "finished",
        kwargs={"dataset_id": "ds1", "output_root": "/nonexistent"},
        exc_info=None,
        get_meta=lambda refresh=False: {},  # old job: no "progress" key
    )
    monkeypatch.setattr(jobs_router.Job, "fetch", lambda job_id, connection=None: fake_job)

    body = client.get("/api/jobs/whatever", headers=auth).json()
    assert body["state"] == "finished"
    assert body["dataset_id"] == "ds1"
    assert body["progress"] is None


def test_get_job_progress_null_when_meta_malformed(client, auth, app_db, monkeypatch) -> None:
    """A malformed meta.progress never fails the (continuously polled) route — it
    degrades to progress=null (advisory)."""
    from api.routers import jobs as jobs_router

    _seed_owner_and_job(app_db, "ds1", "alice", None)  # D-34: alice owns the job's dataset
    fake_job = SimpleNamespace(
        get_status=lambda: "started",
        kwargs={"dataset_id": "ds1", "output_root": "/nonexistent"},
        exc_info=None,
        get_meta=lambda refresh=False: {"progress": {"unexpected": "garbage"}},
    )
    monkeypatch.setattr(jobs_router.Job, "fetch", lambda job_id, connection=None: fake_job)

    body = client.get("/api/jobs/whatever", headers=auth).json()
    assert body["state"] == "started"
    assert body["progress"] is None


# --- T2-104: DatasetSummary.active_job_id (ready-while-baking) --------------


def test_list_datasets_ready_with_active_job_sets_active_job_id(
    client, auth, app_db, monkeypatch
) -> None:
    """A READY (manifest on disk) dataset whose recorded job is queued|started surfaces
    active_job_id — while its status stays "ready" (the T2-104 additive signal)."""
    _write_manifest("ds_baking")
    _seed_owner_and_job(app_db, "ds_baking", "alice", "job-active")
    _patch_fetch_many(monkeypatch, {"job-active": "started"})

    datasets = client.get("/api/datasets", headers=auth).json()["datasets"]
    card = next(d for d in datasets if d["dataset_id"] == "ds_baking")
    assert card["status"] == "ready"            # unchanged enum — a manifest is on disk
    assert card["active_job_id"] == "job-active"  # the ready-while-baking signal


def test_list_datasets_ready_finished_job_has_no_active_id(
    client, auth, app_db, monkeypatch
) -> None:
    """A ready dataset whose last job has finished shows no active_job_id (null)."""
    _write_manifest("ds_done")
    _seed_owner_and_job(app_db, "ds_done", "alice", "job-old")
    _patch_fetch_many(monkeypatch, {"job-old": "finished"})

    datasets = client.get("/api/datasets", headers=auth).json()["datasets"]
    card = next(d for d in datasets if d["dataset_id"] == "ds_done")
    assert card["status"] == "ready"
    assert card["active_job_id"] is None


def test_get_dataset_ready_with_active_job_sets_active_job_id(
    client, auth, app_db, monkeypatch
) -> None:
    """Single-dataset form of the T2-104 signal (get_dataset does one extra off-loop
    round-trip only when a job is recorded)."""
    _write_manifest("ds_one")
    _seed_owner_and_job(app_db, "ds_one", "alice", "job-live")
    _patch_fetch_many(monkeypatch, {"job-live": "queued"})

    body = client.get("/api/datasets/ds_one", headers=auth).json()
    assert body["status"] == "ready"
    assert body["active_job_id"] == "job-live"


def test_get_dataset_ready_no_recorded_job_has_null_active_id(
    client, auth, app_db, monkeypatch
) -> None:
    """A plain committed dataset with no recorded job reports active_job_id null (and
    does no RQ round-trip for it)."""
    _write_manifest("ds_plain")
    _seed_owner_and_job(app_db, "ds_plain", "alice", None)  # owner, but no last_job_id

    body = client.get("/api/datasets/ds_plain", headers=auth).json()
    assert body["status"] == "ready"
    assert body["active_job_id"] is None
