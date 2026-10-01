"""Tier-1 tests for the R2 API addendum (D-27 ZIP upload, D-28 delete + status).

Exercises the real app (auth → uploads → datasets) with a MOCKED RQ queue and a
mocked `rq.job.Job.fetch` — no live Redis, no pipeline execution (brief §1.7).
Test ZIPs are built in-memory with stdlib zipfile (no binary fixtures, brief §3).
App-state reads/seeds use a second engine over the same SQLite file (one
asyncio.run loop each), mirroring test_write_ingest.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import sqlite3
import time
import zipfile
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api import appstate
from api.routers import uploads

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


# --- fakes -------------------------------------------------------------------


class _FakeQueue:
    """Stand-in for rq.Queue: records enqueue dispatches and mints sequential job
    ids, so re-enqueues are distinguishable when asserting last_job_id updates."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.connection = object()  # passed to Job.fetch; mocked away in tests

    def enqueue(  # noqa: ANN201
        self, func_string: str, kwargs: dict | None = None, *, job_timeout: int | float | None = None
    ):
        # job_timeout (T2-97) is a top-level rq.Queue.enqueue arg, not a job kwarg —
        # accepted here so the real enqueue_ingest/enqueue_add_layouts call binds;
        # the enqueue drift guard (tests/smoke) is what asserts its value.
        self.calls.append((func_string, kwargs or {}))
        return SimpleNamespace(id=f"job-{len(self.calls)}")


class _FailingQueue:
    """Stand-in for rq.Queue with the broker down: every enqueue raises."""

    def __init__(self) -> None:
        self.connection = object()

    def enqueue(  # noqa: ANN201
        self, func_string: str, kwargs: dict | None = None, *, job_timeout: int | float | None = None
    ):
        raise RuntimeError("broker down")


class _FakeLock:
    """A no-op redis-py lock: acquire/release always succeed, never touching Redis.
    Stands in for the PR24-8 per-dataset mutation lock in unit tests (no live
    broker), recording its key so a test can assert the dataset was locked."""

    def __init__(self, name: str, acquired: list[str]) -> None:
        self._name = name
        self._acquired = acquired

    def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
        self._acquired.append(self._name)
        return True

    def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        return None


class _FakeRedis:
    """Stand-in for app.state.redis exposing only `.lock()` (the slice the PR24-8
    dataset lock uses). Records every key locked so create/delete/re-ingest tests can
    assert the per-`dataset_id` lock fired without a live broker (brief: fake lock)."""

    def __init__(self) -> None:
        self.locked_keys: list[str] = []

    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _FakeLock(name, self.locked_keys)


class _UnavailableRedis:
    """Stand-in for app.state.redis whose lock is HELD BY A PEER past the blocking
    timeout: `.acquire()` returns False (redis-py returns False ONLY in this case),
    which dataset_lock turns into LockUnavailableError → a 503 at the route."""

    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _UnavailableRedis._Lock()

    class _Lock:
        def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
            return False

        def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None


class _DownRedis:
    """Stand-in for app.state.redis with the BROKER UNREACHABLE: real redis-py
    `.acquire()` RAISES ConnectionError (it never returns False for an outage —
    PR #38 review finding 1). DELETE must degrade to lockless and proceed (D-28:
    a dataset stays deletable when Redis is down); create/re-ingest map it to a
    clean 503 (they cannot enqueue without the broker anyway)."""

    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _DownRedis._Lock()

    class _Lock:
        def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
            from redis.exceptions import ConnectionError as _RCE

            raise _RCE("broker down")

        def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
            return None


def _mock_job_states(monkeypatch, states: dict[str, str]) -> dict[str, int]:
    """Mock rq.job.Job.fetch_many with a job-id -> state map (mutable: tests flip
    states mid-test). Unknown ids come back as None — fetch_many's missing-job
    semantics, the 'job missing' case (PR24-1: the router now batches, never per-id
    Job.fetch). Returns a {'calls': N} counter so a test can assert the listing
    resolves all pending datasets in ONE round-trip."""
    from api.routers import datasets as datasets_router

    counter = {"calls": 0}

    def fake_fetch_many(job_ids, connection=None, serializer=None):  # noqa: ANN001, ANN202
        counter["calls"] += 1
        return [
            SimpleNamespace(get_status=lambda refresh=True, _s=states[jid]: _s)
            if jid in states
            else None
            for jid in job_ids
        ]

    monkeypatch.setattr(datasets_router.Job, "fetch_many", fake_fetch_many)
    return counter


def _create_job_finished(monkeypatch) -> None:
    """The create's ingest has FINISHED before the re-ingest under test is sent.

    `start_ingest` refuses with 409 while the dataset's last recorded job is
    queued|started (`jobs._guard_no_job_in_flight`, added in review round 3 of PR #358),
    and every re-ingest test here creates the dataset first — which records that job. A
    re-ingest a user can actually send is one after that bake ended, so this is the
    realistic precondition, not a bypass: the guard still runs, and reads `finished`.
    Mirrors test_write_ingest's `_job_finished` (the fake queue's `connection` has no
    `hgetall`, so the fetch is patched rather than reached)."""
    from api.routers import jobs as jobs_router

    monkeypatch.setattr(
        jobs_router.Job,
        "fetch",
        lambda job_id, connection=None: SimpleNamespace(get_status=lambda: "finished"),
    )


# --- fixtures ----------------------------------------------------------------


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    """Fresh per-test app-state DB + a writable DATA_ROOT under tmp (uploads and
    dataset dirs land here — never the repo). Returns the app-state DB path."""
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    data_root.mkdir()
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        # PR24-8: every write path now takes the per-dataset mutation lock via
        # app.state.redis. Swap the lifespan's real (broker-bound) Redis for a fake
        # whose lock is an always-acquirable no-op, so the loop needs no live Redis
        # (brief: fake lock in unit tests). Tests asserting lock behaviour read
        # client.app.state.redis.locked_keys; the lock-unavailable test installs
        # _UnavailableRedis instead.
        test_client.app.state.redis = _FakeRedis()
        yield test_client


@pytest.fixture
def auth(client) -> dict[str, str]:
    """Sign up + log in 'alice' via the real auth path; return a bearer header."""
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def fake_queue(client) -> _FakeQueue:
    """Replace the lifespan-created Queue with a recording fake (after startup)."""
    queue = _FakeQueue()
    client.app.state.queue = queue
    return queue


# --- helpers -----------------------------------------------------------------


def _make_zip(entries: dict[str, bytes]) -> bytes:
    """An in-memory ZIP with the given {archive path: content} entries."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _post_zip(client, auth, upload_id: str, payload: bytes, name: str = "bundle.zip"):
    return client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": (name, payload)},
    )


def _session_dir(upload_id: str) -> Path:
    # D-30: upload jails live under DATA_ROOT/users/{owner}/uploads/.
    return Path(os.environ["DATA_ROOT"]) / "users" / "alice" / "uploads" / upload_id


def _finalized_images_bundle(client, auth) -> str:
    """create → upload two plain images → finalize; return the upload_id."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    for name in ("img_000.webp", "img_001.webp"):
        r = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": (name, b"\x00fake-image-bytes")},
        )
        assert r.status_code == 200, r.text
    assert (
        client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code
        == 200
    )
    return upload_id


def _read_record(db_path: Path, dataset_id: str) -> appstate.DatasetRecord | None:
    async def _run() -> appstate.DatasetRecord | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return await appstate.get_dataset_record(session, dataset_id)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _seed_user(db_path: Path, username: str) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                session.add(
                    appstate.User(
                        username=username,
                        email=f"{username}@example.com",
                        password_hash=appstate.hash_password("s3cretpw"),
                    )
                )
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _seed_record(
    db_path: Path, dataset_id: str, owner: str, job_id: str | None = None
) -> None:
    """Record dataset ownership (and optionally a job id) through the real
    app-state primitives. The owner user must already exist (FK)."""

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


def _write_manifest_dir(data_root: Path, ds_id: str) -> Path:
    """A minimal but LOADABLE dataset dir (manifest_version major 2 + the fields
    the ready-summary reads), under DATA_ROOT/datasets/{ds_id}/ (decision D-30).
    Major 2 is the v2 contract the API now serves; "1.x" would be refused."""
    ds_dir = data_root / "datasets" / ds_id
    ds_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "manifest_version": "2.1",
        "dataset_version": 3,
        "dataset_metadata": {
            "image_count": 7,
            "ingest_timestamp": "2026-01-01T00:00:00",
        },
        "layouts": [{"layout_id": "grid"}],
    }
    (ds_dir / "layout_manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    return ds_dir


# --- D-27: ZIP roundtrip -----------------------------------------------------


def test_zip_part_extracts_flat_with_root_metadata(client, auth, fake_queue, app_db) -> None:
    """Nested dirs flatten into images/; the root CSV becomes the bundle's
    metadata; nested CSVs + non-images are ignored and reported; finalize +
    create_dataset then enqueues with csv_path set and records the job (D-28)."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    csv_bytes = b"filename,color\nx.png,red\n"
    payload = _make_zip(
        {
            "a/b/x.png": b"px-1",
            "y.png": b"py-22",
            "metadata.csv": csv_bytes,
            "deep/other.csv": b"not,metadata\n",
            "readme.txt": b"hello",
        }
    )
    r = _post_zip(client, auth, upload_id, payload, name="bundle.ZIP")  # case-insensitive
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "open"
    assert body["received_parts"] == 3  # 2 images + 1 metadata
    assert body["bytes_received"] == len(b"px-1") + len(b"py-22") + len(csv_bytes)
    assert set(body["ignored"]) == {"deep/other.csv", "readme.txt"}

    session_dir = _session_dir(upload_id)
    assert {p.name for p in (session_dir / "images").iterdir()} == {"x.png", "y.png"}
    assert (session_dir / "metadata.csv").read_bytes() == csv_bytes
    assert not (session_dir / ".extract-tmp").exists()  # staging never survives

    assert (
        client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code
        == 200
    )
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={
            "dataset_id": "ds_zip",
            "upload_id": upload_id,
            "column_roles": {"filename": {"column": "filename", "label": "File"}},
        },
    )
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["csv_path"] is not None
    assert kwargs["csv_path"].replace("\\", "/").endswith(
        f"users/alice/uploads/{upload_id}/metadata.csv"
    )
    record = _read_record(app_db, "ds_zip")
    assert record is not None
    assert record.last_job_id == r.json()["job_id"]  # recorded at enqueue (D-28)


def test_zip_ignored_report_is_capped(client, auth) -> None:
    """More than 100 skipped entries collapse into 100 names + one '+N more'."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    payload = _make_zip(
        {f"junk_{i:03d}.txt": b"x" for i in range(105)} | {"ok.png": b"img"}
    )
    r = _post_zip(client, auth, upload_id, payload)
    assert r.status_code == 200, r.text
    ignored = r.json()["ignored"]
    assert len(ignored) == 101
    assert ignored[-1] == "+5 more"


# --- D-27: ZIP rejections ----------------------------------------------------


def test_zip_duplicate_basename_in_archive_is_400(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = _post_zip(client, auth, upload_id, _make_zip({"a/x.png": b"1", "b/x.png": b"2"}))
    assert r.status_code == 400
    session_dir = _session_dir(upload_id)
    assert list((session_dir / "images").iterdir()) == []  # nothing merged
    assert not (session_dir / ".extract-tmp").exists()


def test_zip_duplicate_vs_uploaded_part_is_400_session_unchanged(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    ok = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("x.png", b"original")},
    )
    assert ok.status_code == 200
    # One colliding + one fresh entry: NOTHING merges (staged-then-merged).
    r = _post_zip(client, auth, upload_id, _make_zip({"c/x.png": b"new", "fresh.png": b"f"}))
    assert r.status_code == 400
    session_dir = _session_dir(upload_id)
    assert {p.name for p in (session_dir / "images").iterdir()} == {"x.png"}
    assert (session_dir / "images" / "x.png").read_bytes() == b"original"
    assert not (session_dir / ".extract-tmp").exists()


def test_zip_two_root_csvs_is_400(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = _post_zip(client, auth, upload_id, _make_zip({"a.csv": b"1", "b.csv": b"2"}))
    assert r.status_code == 400
    assert not (_session_dir(upload_id) / "metadata.csv").exists()


def test_zip_root_csv_conflicts_with_uploaded_metadata_is_400(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    ok = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("meta.csv", b"a,b\n1,2\n")},
    )
    assert ok.status_code == 200
    r = _post_zip(client, auth, upload_id, _make_zip({"other.csv": b"x", "img.png": b"y"}))
    assert r.status_code == 400
    session_dir = _session_dir(upload_id)
    assert (session_dir / "metadata.csv").read_bytes() == b"a,b\n1,2\n"  # intact
    assert list((session_dir / "images").iterdir()) == []  # img.png not merged


def test_zip_corrupt_bytes_is_400(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = _post_zip(client, auth, upload_id, b"this is not a zip archive")
    assert r.status_code == 400
    assert not (_session_dir(upload_id) / ".extract-tmp").exists()


def test_zip_bundle_bytes_breach_is_413(client, auth, monkeypatch) -> None:
    """The cap fires on STREAMED uncompressed bytes (10 > 8), not zip headers."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "8")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = _post_zip(client, auth, upload_id, _make_zip({"a.png": b"0123456789"}))
    assert r.status_code == 413
    session_dir = _session_dir(upload_id)
    assert list((session_dir / "images").iterdir()) == []
    assert not (session_dir / ".extract-tmp").exists()


def test_zip_entry_count_breach_is_413(client, auth, monkeypatch) -> None:
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    payload = _make_zip({"a.png": b"1", "b.png": b"2", "c.png": b"3"})
    r = _post_zip(client, auth, upload_id, payload)
    assert r.status_code == 413
    assert list((_session_dir(upload_id) / "images").iterdir()) == []


def test_plain_parts_share_the_bundle_caps(client, auth, monkeypatch) -> None:
    """D-27 caps cover the WHOLE bundle: plain parts count too."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "8")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    ok = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("a.png", b"12345")},
    )
    assert ok.status_code == 200
    over = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("b.png", b"12345")},  # 5 + 5 > 8
    )
    assert over.status_code == 413
    images = _session_dir(upload_id) / "images"
    assert {p.name for p in images.iterdir()} == {"a.png"}  # partial removed

    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", str(2**31))
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "1")  # bundle already has 1 file
    capped = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("c.png", b"x")},
    )
    assert capped.status_code == 413


# --- D-28: delete ------------------------------------------------------------


def test_delete_owned_dataset_204_removes_disk_and_record(client, auth, app_db) -> None:
    data_root = Path(os.environ["DATA_ROOT"])
    ds_dir = _write_manifest_dir(data_root, "ds_del")
    _seed_record(app_db, "ds_del", "alice")  # last_job_id None → no RQ consult
    r = client.delete("/api/datasets/ds_del", headers=auth)
    assert r.status_code == 204
    assert not ds_dir.exists()
    assert _read_record(app_db, "ds_del") is None
    assert client.get("/api/datasets/ds_del", headers=auth).status_code == 404


def test_delete_readonly_fixture_returns_409_and_keeps_record(
    client, auth, app_db, monkeypatch
) -> None:
    """T2-91: when the dataset dir cannot be detached (a read-only / bind-mounted
    fixture whose mount point rename() faults EBUSY/EXDEV/EPERM), DELETE returns a
    clean 409 with a human-readable message — never a raw 500 (the T2-65 "never a
    bare error" principle). Both the tree and the app-state owner record are left
    intact: delete_dataset_record runs only AFTER a successful detach, so a failed
    detach leaves the dataset present AND owned (consistent state)."""
    data_root = Path(os.environ["DATA_ROOT"])
    ds_dir = _write_manifest_dir(data_root, "ds_ro")
    _seed_record(app_db, "ds_ro", "alice")  # last_job_id None → no RQ consult

    def _rename_denied(self, target):  # noqa: ANN001, ANN202
        # What a ':ro' bind-mount point yields when the API tries to rename it.
        raise OSError("Device or resource busy")

    monkeypatch.setattr(Path, "rename", _rename_denied)

    r = client.delete("/api/datasets/ds_ro", headers=auth)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "cannot be deleted" in detail and "read-only" in detail
    # State unchanged: the tree is intact and still owned (record NOT deleted).
    assert ds_dir.exists()
    assert _read_record(app_db, "ds_ro") is not None
    # The failed rename moved nothing, so no tombstone is left under DATA_ROOT.
    assert not any(p.name.startswith(".deleting-") for p in data_root.iterdir())


def test_delete_non_owner_is_403(client, auth, app_db) -> None:
    _seed_user(app_db, "bob")
    _seed_record(app_db, "ds_bob", "bob")
    assert client.delete("/api/datasets/ds_bob", headers=auth).status_code == 403
    assert _read_record(app_db, "ds_bob") is not None  # untouched


def test_delete_cli_seeded_dataset_is_403(client, auth) -> None:
    """A manifest on disk with NO app-state record is not web-deletable
    (reconciliation #14)."""
    ds_dir = _write_manifest_dir(Path(os.environ["DATA_ROOT"]), "ds_cli")
    r = client.delete("/api/datasets/ds_cli", headers=auth)
    assert r.status_code == 403
    assert "no web owner" in r.json()["detail"]
    assert ds_dir.exists()


def test_delete_refused_while_job_active_then_succeeds(client, auth, app_db, monkeypatch) -> None:
    states = {"j1": "started"}
    _mock_job_states(monkeypatch, states)
    _seed_record(app_db, "ds_run", "alice", job_id="j1")
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / "ds_run"  # D-30
    ds_dir.mkdir(parents=True)
    (ds_dir / "ingest.log").write_text("working...\n", encoding="utf-8")

    assert client.delete("/api/datasets/ds_run", headers=auth).status_code == 409
    states["j1"] = "queued"
    assert client.delete("/api/datasets/ds_run", headers=auth).status_code == 409
    assert ds_dir.exists()
    assert _read_record(app_db, "ds_run") is not None

    states["j1"] = "failed"  # no longer in flight → deletable
    assert client.delete("/api/datasets/ds_run", headers=auth).status_code == 204
    assert not ds_dir.exists()
    assert _read_record(app_db, "ds_run") is None


def test_delete_unknown_dataset_is_404(client, auth) -> None:
    assert client.delete("/api/datasets/does-not-exist", headers=auth).status_code == 404


def test_delete_traversal_id_rejected_nothing_touched(client, auth) -> None:
    """A traversal ds_id never reaches the filesystem: `..` is collapsed by URL
    normalisation (no route), `%2E%2E` reaches the handler and is jailed by
    db.dataset_dir. Either way 4xx and the tree is untouched."""
    data_root = Path(os.environ["DATA_ROOT"])
    sentinel = _write_manifest_dir(data_root, "ds_keep")
    for probe in ("..", "%2E%2E"):
        r = client.delete(f"/api/datasets/{probe}", headers=auth)
        assert 400 <= r.status_code < 500, probe
    assert sentinel.exists()
    assert data_root.exists()


def test_dataset_id_equal_to_username_coexists_reverse(client, auth, app_db) -> None:
    """D-30 seam acceptance (reverse): a dataset `corpus1` already exists (owned by
    alice, manifest on disk), then a NEW user signs up AS `corpus1` and opens an
    upload session. With disjoint roots the session lands under
    users/corpus1/uploads/ and nothing nests under datasets/corpus1/; alice can
    still delete her dataset (no 409 from the retired DELETE-side guard) without
    touching corpus1's uploads. No name-based guard fires."""
    data_root = Path(os.environ["DATA_ROOT"])
    ds_dir = _write_manifest_dir(data_root, "corpus1")  # datasets/corpus1/ (alice's)
    _seed_record(app_db, "corpus1", "alice")            # last_job_id None → no RQ consult

    # A different person signs up with the username 'corpus1' and uploads.
    assert client.post(
        "/api/auth/signup",
        json={"username": "corpus1", "email": "corpus1@example.com", "password": "s3cretpw"},
    ).status_code == 200
    token = client.post(
        "/api/auth/login", json={"username": "corpus1", "password": "s3cretpw"}
    ).json()["access_token"]
    corpus1_auth = {"Authorization": f"Bearer {token}"}
    upload_id = client.post("/api/uploads", headers=corpus1_auth).json()["upload_id"]

    # The jail is under users/corpus1/uploads/ — NOT nested in the dataset dir.
    jail = data_root / "users" / "corpus1" / "uploads" / upload_id
    assert (jail / "images").is_dir()
    assert not (ds_dir / "uploads").exists()         # nothing nested under datasets/corpus1/
    assert (ds_dir / "layout_manifest.json").is_file()  # dataset untouched by the signup

    # alice (the dataset owner) deletes her dataset: 204, no collision 409; the new
    # user's uploads are untouched.
    assert client.delete("/api/datasets/corpus1", headers=auth).status_code == 204
    assert not ds_dir.exists()
    assert (jail / "images").is_dir()                # corpus1's uploads survive
    assert _read_record(app_db, "corpus1") is None


# --- D-28: list/status merge -------------------------------------------------


def test_list_merges_ready_processing_error_in_one_appstate_read(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    data_root = Path(os.environ["DATA_ROOT"])
    _write_manifest_dir(data_root, "ds_ready")
    _seed_record(app_db, "ds_ready", "alice")  # manifest-backed → ready
    _seed_record(app_db, "ds_proc", "alice", job_id="j-proc")  # no manifest
    _seed_record(app_db, "ds_err", "alice", job_id="j-err")  # no manifest
    _mock_job_states(monkeypatch, {"j-proc": "started", "j-err": "failed"})

    calls = {"list": 0, "owner": 0}
    real_list = appstate.list_dataset_records
    real_owner = appstate.get_dataset_owner

    async def spy_list(session):  # noqa: ANN001, ANN202
        calls["list"] += 1
        return await real_list(session)

    async def spy_owner(session, dataset_id):  # noqa: ANN001, ANN202
        calls["owner"] += 1
        return await real_owner(session, dataset_id)

    monkeypatch.setattr(appstate, "list_dataset_records", spy_list)
    monkeypatch.setattr(appstate, "get_dataset_owner", spy_owner)

    r = client.get("/api/datasets", headers=auth)
    assert r.status_code == 200, r.text
    by_id = {d["dataset_id"]: d for d in r.json()["datasets"]}

    ready = by_id["ds_ready"]
    assert ready["status"] == "ready"
    assert ready["dataset_version"] == 3
    assert ready["image_count"] == 7
    assert ready["layout_ids"] == ["grid"]
    assert ready["owner"] == "alice"

    proc = by_id["ds_proc"]  # visible BEFORE any manifest commits
    assert proc["status"] == "processing"
    assert proc["dataset_version"] == 0
    assert proc["image_count"] == 0
    assert proc["layout_ids"] == []
    assert proc["owner"] == "alice"
    record = _read_record(app_db, "ds_proc")
    assert record is not None
    assert datetime.fromisoformat(proc["ingest_timestamp"]) == record.created_at

    assert by_id["ds_err"]["status"] == "error"

    # ONE batched app-state read for the whole listing; zero per-dataset lookups.
    assert calls == {"list": 1, "owner": 0}


def test_list_job_missing_and_rq_unreachable_show_error(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    from api.routers import datasets as datasets_router

    _seed_record(app_db, "ds_gone", "alice", job_id="j-gone")
    _mock_job_states(monkeypatch, {})  # any fetch_many → None ("job missing")
    by_id = {
        d["dataset_id"]: d
        for d in client.get("/api/datasets", headers=auth).json()["datasets"]
    }
    assert by_id["ds_gone"]["status"] == "error"

    def broker_down(job_ids, connection=None, serializer=None):  # noqa: ANN001, ANN202
        raise datasets_router.RedisError("connection refused")

    monkeypatch.setattr(datasets_router.Job, "fetch_many", broker_down)
    by_id = {
        d["dataset_id"]: d
        for d in client.get("/api/datasets", headers=auth).json()["datasets"]
    }
    assert by_id["ds_gone"]["status"] == "error"  # RQ unreachable ⇒ error, not 500


def test_get_dataset_derives_processing_then_error(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    _seed_record(app_db, "ds_one", "alice", job_id="j1")
    states = {"j1": "queued"}
    _mock_job_states(monkeypatch, states)

    body = client.get("/api/datasets/ds_one", headers=auth).json()
    assert body["status"] == "processing"
    assert body["owner"] == "alice"
    assert body["layout_ids"] == []

    states["j1"] = "failed"
    assert client.get("/api/datasets/ds_one", headers=auth).json()["status"] == "error"


# --- PR19-3: enqueue-failure rollback ----------------------------------------


def test_create_rolls_back_owner_row_on_enqueue_failure_then_retries(
    client, auth, app_db
) -> None:
    upload_id = _finalized_images_bundle(client, auth)
    client.app.state.queue = _FailingQueue()
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_rb", "upload_id": upload_id},
    )
    assert r.status_code == 503
    assert _read_record(app_db, "ds_rb") is None  # the row this request made: gone

    working = _FakeQueue()  # the queue "recovers"
    client.app.state.queue = working
    retry = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_rb", "upload_id": upload_id},
    )
    assert retry.status_code == 200, retry.text
    record = _read_record(app_db, "ds_rb")
    assert record is not None
    assert record.owner == "alice"
    assert record.last_job_id == retry.json()["job_id"]
    assert len(working.calls) == 1


def test_create_rollback_spares_preexisting_owner_row(client, auth, fake_queue, app_db) -> None:
    """A same-owner row from a PRIOR create survives an enqueue failure — only a
    row created by the failing request is rolled back (PR19-3)."""
    first = _finalized_images_bundle(client, auth)
    ok = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_pre", "upload_id": first},
    )
    assert ok.status_code == 200, ok.text
    job_before = ok.json()["job_id"]

    client.app.state.queue = _FailingQueue()
    second = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_pre", "upload_id": second},
    )
    assert r.status_code == 503
    record = _read_record(app_db, "ds_pre")
    assert record is not None and record.owner == "alice"  # row survives
    assert record.last_job_id == job_before  # and keeps its prior job


def _all_records(db_path: Path) -> list[tuple[str, str]]:
    """Every app-state dataset row as `(dataset_id, owner)`. A minted create that fails
    never tells the client its id, so "no row under that id" is asserted as "no row at
    all" — in a fresh per-test DB the create is the only thing that could have made one."""

    async def _run() -> list[tuple[str, str]]:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return [
                    (r.dataset_id, r.owner)
                    for r in await appstate.list_dataset_records(session)
                ]
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def test_a_minted_create_whose_enqueue_fails_leaves_no_row(client, auth, app_db) -> None:
    """Seam L6 (D-xxviii) meets PR19-3. A create with NO `dataset_id` mints one, records
    alice's row under it, then the broker is down. The rollback must delete the row under
    the MINTED id: the 503 never tells the client that id, so a surviving row would squat
    an id nobody holds, listed forever as a collection in `error`. Nothing is on disk
    either — the create wrote no presentation."""
    upload_id = _finalized_images_bundle(client, auth)
    client.app.state.queue = _FailingQueue()

    r = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert r.status_code == 503
    assert _all_records(app_db) == []
    assert not (Path(os.environ["DATA_ROOT"]) / "datasets").exists()


def test_a_minted_create_with_a_bad_presentation_leaves_no_row(
    client, auth, fake_queue, app_db
) -> None:
    """The other create-side rollback, the D-xvii presentation refusal: a display name
    over `DISPLAY_NAME_MAX` (120) passes the request model and is refused by
    `presentation.update` AFTER the owner row is recorded. On a minted create that row
    is under the minted id and must go, and nothing is enqueued. The string `detail`
    proves the 422 is that refusal and not the request model's (whose `detail` is a
    list), i.e. that the create really reached the rollback."""
    upload_id = _finalized_images_bundle(client, auth)

    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"upload_id": upload_id, "presentation": {"display_name": "x" * 121}},
    )

    assert r.status_code == 422, r.text
    assert isinstance(r.json()["detail"], str), r.json()
    assert _all_records(app_db) == []
    assert fake_queue.calls == []


# --- D-28: both ingest paths record the job ----------------------------------


def test_start_ingest_records_the_new_job_id(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    first = _finalized_images_bundle(client, auth)
    r1 = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_ri", "upload_id": first},
    )
    assert r1.status_code == 200, r1.text
    job1 = r1.json()["job_id"]
    record = _read_record(app_db, "ds_ri")
    assert record is not None and record.last_job_id == job1
    _create_job_finished(monkeypatch)

    second = _finalized_images_bundle(client, auth)
    r2 = client.post(
        "/api/datasets/ds_ri/ingest",
        headers=auth,
        json={"upload_id": second},
    )
    assert r2.status_code == 200, r2.text
    job2 = r2.json()["job_id"]
    assert job2 != job1
    record = _read_record(app_db, "ds_ri")
    assert record is not None and record.last_job_id == job2


# --- migration ----------------------------------------------------------------


def test_setup_appstate_migrates_legacy_datasets_table(tmp_path) -> None:
    """A dev DB whose datasets table predates last_job_id starts cleanly: the
    PRAGMA-guarded ALTER adds the column in place, old rows read back None, and
    a second startup does not re-ALTER (DoD #4)."""
    db_path = tmp_path / "legacy.db"
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE users (
            id INTEGER NOT NULL PRIMARY KEY,
            username VARCHAR NOT NULL UNIQUE,
            email VARCHAR NOT NULL UNIQUE,
            password_hash VARCHAR NOT NULL,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL
        );
        CREATE TABLE datasets (
            dataset_id VARCHAR NOT NULL PRIMARY KEY,
            owner VARCHAR NOT NULL REFERENCES users (username),
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL
        );
        INSERT INTO users (username, email, password_hash)
            VALUES ('carol', 'carol@example.com', 'x');
        INSERT INTO datasets (dataset_id, owner) VALUES ('ds_old', 'carol');
        """
    )
    con.commit()
    con.close()

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                records = await appstate.list_dataset_records(session)
                assert [r.dataset_id for r in records] == ["ds_old"]
                assert records[0].last_job_id is None  # pre-migration row
                await appstate.record_dataset_job(session, "ds_old", "j-new")
                rec = await appstate.get_dataset_record(session, "ds_old")
                assert rec is not None and rec.last_job_id == "j-new"
        finally:
            await engine.dispose()

    asyncio.run(_run())

    async def _run_again() -> None:  # idempotent second startup
        engine, _ = await appstate.setup_appstate(db_path)
        await engine.dispose()

    asyncio.run(_run_again())


def test_setup_appstate_migrates_datasets_table_for_presentation(tmp_path) -> None:
    """A dev DB whose datasets table predates display_name/attribution (a DB from the
    visibility era) starts cleanly: the PRAGMA-guarded ALTER adds both columns in place,
    old rows read back None (every surface reads that as "fall back to the id" / "no
    credit"), a value already in those columns is READ BACK through the record, and a
    second startup does not re-ALTER.

    The writability half used to be asserted through `appstate.set_dataset_presentation`.
    That writer is gone: presentation now lives in the dataset's own `presentation.json`
    (D-i/D-xv) and these columns are the pre-migration FALLBACK, which arrives from an
    older deployment rather than from a live writer. So the value is seeded the way it
    really gets there — a direct row UPDATE, as the previous release's writer left it —
    and what is pinned is that `get_dataset_record` surfaces it, because that is the
    input `presentation.effective` falls back to."""
    db_path = tmp_path / "legacy_presentation.db"
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE users (
            id INTEGER NOT NULL PRIMARY KEY,
            username VARCHAR NOT NULL UNIQUE,
            email VARCHAR NOT NULL UNIQUE,
            password_hash VARCHAR NOT NULL,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL
        );
        CREATE TABLE datasets (
            dataset_id VARCHAR NOT NULL PRIMARY KEY,
            owner VARCHAR NOT NULL REFERENCES users (username),
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
            last_job_id VARCHAR,
            visibility VARCHAR NOT NULL DEFAULT 'private'
        );
        INSERT INTO users (username, email, password_hash)
            VALUES ('carol', 'carol@example.com', 'x');
        INSERT INTO datasets (dataset_id, owner) VALUES ('ds_old', 'carol');
        """
    )
    con.commit()
    con.close()

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                records = await appstate.list_dataset_records(session)
                assert [r.dataset_id for r in records] == ["ds_old"]
                assert records[0].display_name is None  # pre-migration row
                assert records[0].attribution is None
                assert records[0].attribution_url is None  # Part D §2b column
                # ...and a value left in the freshly-ALTERed columns by an older release
                # is READ BACK — this is exactly the fallback path
                # `presentation.effective` uses for a dataset nobody has migrated yet.
                await session.execute(
                    text(
                        "UPDATE datasets SET display_name = 'Named' "
                        "WHERE dataset_id = 'ds_old'"
                    )
                )
                await session.commit()
                rec = await appstate.get_dataset_record(session, "ds_old")
                assert rec is not None and rec.display_name == "Named"
        finally:
            await engine.dispose()

    asyncio.run(_run())

    async def _run_again() -> None:  # idempotent second startup
        engine, _ = await appstate.setup_appstate(db_path)
        await engine.dispose()

    asyncio.run(_run_again())


def test_setup_appstate_migrates_datasets_table_for_source_upload(tmp_path) -> None:
    """A dev DB whose datasets table predates `source_upload_id` (a DB from the
    presentation era) starts cleanly: the PRAGMA-guarded ALTER adds the column in
    place, and every row that predates it reads back None.

    None is "this dataset records no source bundle" — the answer the columns route
    falls through on. What this pins is that a migrated row gives that answer rather
    than either failure beside it: a CRASH (the column is missing, so the normal read
    path cannot build a DatasetRecord at all) or a WRONG bundle (a neighbour's id
    leaking onto a row that never had one — the defect findings 1+2 of the PR #358
    review found, when app-state could only answer "which bundle did this OWNER
    finalize last"). Two legacy rows exist so the second is asserted untouched while
    the first is written.

    The write half goes through `appstate.record_dataset_source_upload`, the real
    writer the create/re-ingest routes call: an ALTERed column that reads is only
    half-migrated if a later bake cannot record onto it."""
    db_path = tmp_path / "legacy_source_upload.db"
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE users (
            id INTEGER NOT NULL PRIMARY KEY,
            username VARCHAR NOT NULL UNIQUE,
            email VARCHAR NOT NULL UNIQUE,
            password_hash VARCHAR NOT NULL,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL
        );
        CREATE TABLE datasets (
            dataset_id VARCHAR NOT NULL PRIMARY KEY,
            owner VARCHAR NOT NULL REFERENCES users (username),
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
            last_job_id VARCHAR,
            visibility VARCHAR NOT NULL DEFAULT 'private',
            display_name VARCHAR,
            attribution VARCHAR,
            attribution_url VARCHAR
        );
        INSERT INTO users (username, email, password_hash)
            VALUES ('carol', 'carol@example.com', 'x');
        INSERT INTO datasets (dataset_id, owner) VALUES ('ds_old', 'carol');
        INSERT INTO datasets (dataset_id, owner) VALUES ('ds_other', 'carol');
        """
    )
    con.commit()
    con.close()

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                info = await session.execute(text("PRAGMA table_info(datasets)"))
                assert "source_upload_id" in {row[1] for row in info}  # ALTERed in

                # ...and the normal read path builds records over the migrated rows
                # instead of erroring on a column the mapper expects and SQLite lacks.
                records = await appstate.list_dataset_records(session)
                assert [r.dataset_id for r in records] == ["ds_old", "ds_other"]
                assert all(r.source_upload_id is None for r in records)  # pre-column
                assert records[0].owner == "carol"  # the row itself survived the ALTER

                # A later bundle-backed bake records onto the migrated row...
                await appstate.record_dataset_source_upload(session, "ds_old", "up_new")
                rec = await appstate.get_dataset_record(session, "ds_old")
                assert rec is not None and rec.source_upload_id == "up_new"
                # ...and onto that row only: no neighbour inherits the bundle.
                other = await appstate.get_dataset_record(session, "ds_other")
                assert other is not None and other.source_upload_id is None
        finally:
            await engine.dispose()

    asyncio.run(_run())

    async def _run_again() -> None:  # idempotent second startup
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                rec = await appstate.get_dataset_record(session, "ds_old")
                assert rec is not None and rec.source_upload_id == "up_new"  # survives
        finally:
            await engine.dispose()

    asyncio.run(_run_again())


def test_setup_appstate_migrates_datasets_table_for_minted_from_upload(tmp_path) -> None:
    """A DB whose datasets table predates `minted_from_upload_id` (PR #373) — it already
    has `source_upload_id` — starts cleanly: the guarded ALTER adds the column in place,
    exactly as seam L1 added `source_upload_id`, and it is NOT backfilled.

    That is the documented gap: a row minted before the column existed records its bundle
    in `source_upload_id` only, so the minted-create lookup does not find it, and a repeat
    of that create builds a second collection, as it always had. Backfilling from
    `source_upload_id` would re-import the ambiguity the column exists to remove (it is
    also written by re-ingest and authored creates). A NEW minted row, written through the
    real writer, is found."""
    db_path = tmp_path / "legacy_minted_from.db"
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE users (
            id INTEGER NOT NULL PRIMARY KEY,
            username VARCHAR NOT NULL UNIQUE,
            email VARCHAR NOT NULL UNIQUE,
            password_hash VARCHAR NOT NULL,
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL
        );
        CREATE TABLE datasets (
            dataset_id VARCHAR NOT NULL PRIMARY KEY,
            owner VARCHAR NOT NULL REFERENCES users (username),
            created_at DATETIME DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
            last_job_id VARCHAR,
            visibility VARCHAR NOT NULL DEFAULT 'private',
            display_name VARCHAR,
            attribution VARCHAR,
            attribution_url VARCHAR,
            source_upload_id VARCHAR
        );
        INSERT INTO users (username, email, password_hash)
            VALUES ('carol', 'carol@example.com', 'x');
        INSERT INTO datasets (dataset_id, owner, source_upload_id)
            VALUES ('a1b2c3d4e5f6', 'carol', 'up_old');
        """
    )
    con.commit()
    con.close()

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                info = await session.execute(text("PRAGMA table_info(datasets)"))
                assert "minted_from_upload_id" in {row[1] for row in info}  # ALTERed in

                # Not backfilled: the pre-column row is outside the key.
                assert (
                    await appstate.get_dataset_record_minted_from_upload(
                        session, "carol", "up_old"
                    )
                    is None
                )
                old = await appstate.get_dataset_record(session, "a1b2c3d4e5f6")
                assert old is not None and old.source_upload_id == "up_old"  # untouched

                # A new minted row lands on the migrated table and is found.
                await appstate.record_dataset_owner(
                    session, "0f1e2d3c4b5a", "carol", minted_from_upload_id="up_new"
                )
                found = await appstate.get_dataset_record_minted_from_upload(
                    session, "carol", "up_new"
                )
                assert found is not None and found.dataset_id == "0f1e2d3c4b5a"
        finally:
            await engine.dispose()

    asyncio.run(_run())

    async def _run_again() -> None:  # idempotent second startup
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                found = await appstate.get_dataset_record_minted_from_upload(
                    session, "carol", "up_new"
                )
                assert found is not None and found.dataset_id == "0f1e2d3c4b5a"
        finally:
            await engine.dispose()

    asyncio.run(_run_again())


# --- auth gate ----------------------------------------------------------------


def test_delete_requires_auth(client) -> None:
    assert client.delete("/api/datasets/ds1").status_code == 401


# --- seam acceptance (brief §4.5): end-to-end over mocks ----------------------


def test_seam_acceptance_zip_create_status_delete(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    # 1. Sign in (auth fixture) + upload ONE ZIP: nested folders + root CSV.
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    payload = _make_zip(
        {
            "shoebox/2019/img_a.png": b"a-bytes",
            "shoebox/2020/img_b.png": b"b-bytes",
            "metadata.csv": b"filename,year\nimg_a.png,2019\nimg_b.png,2020\n",
        }
    )
    assert _post_zip(client, auth, upload_id, payload, "shoebox.zip").status_code == 200
    assert (
        client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code
        == 200
    )

    # 2. Create the dataset: job recorded, csv_path enqueued.
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={
            "dataset_id": "ds_box",
            "upload_id": upload_id,
            "column_roles": {"filename": {"column": "filename", "label": "File"}},
        },
    )
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    record = _read_record(app_db, "ds_box")
    assert record is not None and record.last_job_id == job_id
    _, kwargs = fake_queue.calls[0]
    assert kwargs["csv_path"] is not None

    # 3. Listed as processing while the job is started (no manifest yet).
    states = {job_id: "started"}
    _mock_job_states(monkeypatch, states)
    listed = {
        d["dataset_id"]: d
        for d in client.get("/api/datasets", headers=auth).json()["datasets"]
    }
    assert listed["ds_box"]["status"] == "processing"

    # 4. Delete refused while the job is in flight.
    assert client.delete("/api/datasets/ds_box", headers=auth).status_code == 409

    # 5. Flip the mock to failed ⇒ error (with the worker's partial output on disk).
    states[job_id] = "failed"
    listed = {
        d["dataset_id"]: d
        for d in client.get("/api/datasets", headers=auth).json()["datasets"]
    }
    assert listed["ds_box"]["status"] == "error"
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / "ds_box"  # D-30
    ds_dir.mkdir(parents=True)
    (ds_dir / "ingest.log").write_text("RuntimeError: boom\n", encoding="utf-8")

    # 6. Delete now succeeds: disk + record gone.
    assert client.delete("/api/datasets/ds_box", headers=auth).status_code == 204
    assert not ds_dir.exists()
    assert _read_record(app_db, "ds_box") is None


# --- PR24-8 (DP-4): per-dataset delete↔ingest mutation lock ------------------
#
# The lock serializes DELETE's check+detach against the create/re-ingest
# record+enqueue critical sections on the SAME dataset_id. Unit tests use a FAKE
# lock (no live Redis): _FakeRedis records the keys locked, _UnavailableRedis
# fails every acquire. The lock key is `dataset-mutate:{dataset_id}` (queue.py).
#
# SCOPE of these tests: they pin the CONTROL FLOW around the lock — which key is
# taken, 503 on a peer-held lock, lockless degrade on a broker outage, and that an
# in-section HTTPException is not rewritten to 503. They do NOT exercise real
# CONTENTION or the BLOCKING semantics: the fakes' acquire()/release() return
# instantly and never touch a broker, so neither redis-py's sleep-retry nor the
# event-loop offload (PR #38 review #1: dataset_lock runs acquire/release via
# run_in_threadpool) is observable here. Two concurrent holders on one key, and the
# off-loop behaviour, belong to the live-stack acceptance harness
# (tests/e2e/run_acceptance.py); a true in-process concurrency test needs a real
# broker — tracked as PR38-3 in PROJECT_STATUS.


def _lock_key(dataset_id: str) -> str:
    from api import queue

    return f"{queue._LOCK_KEY_PREFIX}{dataset_id}"


def test_create_takes_per_dataset_lock(client, auth, fake_queue, app_db) -> None:
    """create_dataset acquires the per-`dataset_id` mutation lock around its
    record+enqueue critical section (PR24-8). 409 contract unchanged: the happy
    path still 200s."""
    upload_id = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_lock", "upload_id": upload_id},
    )
    assert r.status_code == 200, r.text
    assert client.app.state.redis.locked_keys == [_lock_key("ds_lock")]


def test_delete_takes_per_dataset_lock(client, auth, app_db) -> None:
    """delete_dataset acquires the per-`dataset_id` mutation lock around its
    check+rmtree critical section (PR24-8). 204 contract unchanged."""
    data_root = Path(os.environ["DATA_ROOT"])
    _write_manifest_dir(data_root, "ds_dl")
    _seed_record(app_db, "ds_dl", "alice")  # last_job_id None → no RQ consult
    assert client.delete("/api/datasets/ds_dl", headers=auth).status_code == 204
    assert client.app.state.redis.locked_keys == [_lock_key("ds_dl")]


def test_reingest_takes_per_dataset_lock(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """start_ingest (re-ingest) acquires the per-`dataset_id` mutation lock around
    its enqueue+record critical section (PR24-8)."""
    first = _finalized_images_bundle(client, auth)
    assert client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_rl", "upload_id": first}
    ).status_code == 200
    _create_job_finished(monkeypatch)
    second = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_rl/ingest", headers=auth, json={"upload_id": second}
    )
    assert r.status_code == 200, r.text
    # create + re-ingest each locked the same dataset key, in order.
    assert client.app.state.redis.locked_keys == [_lock_key("ds_rl"), _lock_key("ds_rl")]


def test_create_lock_unavailable_is_503_and_no_enqueue(
    client, auth, fake_queue, app_db
) -> None:
    """When the mutation lock cannot be acquired, create answers 503 and nothing is
    enqueued or recorded — it never proceeds unserialized (PR24-8)."""
    client.app.state.redis = _UnavailableRedis()
    upload_id = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_busy", "upload_id": upload_id},
    )
    assert r.status_code == 503
    assert fake_queue.calls == []                         # never enqueued
    assert _read_record(app_db, "ds_busy") is None         # never recorded an owner


def test_delete_lock_unavailable_is_503_and_keeps_dataset(
    client, auth, app_db
) -> None:
    """When a PEER holds the mutation lock past the blocking timeout, delete answers
    503 and the dataset (disk + record) is untouched — no unserialized rmtree
    (PR24-8)."""
    data_root = Path(os.environ["DATA_ROOT"])
    ds_dir = _write_manifest_dir(data_root, "ds_busy_del")
    _seed_record(app_db, "ds_busy_del", "alice")
    client.app.state.redis = _UnavailableRedis()
    assert client.delete("/api/datasets/ds_busy_del", headers=auth).status_code == 503
    assert ds_dir.exists()                                 # not removed
    assert _read_record(app_db, "ds_busy_del") is not None  # record kept


def test_delete_proceeds_lockless_when_redis_down(client, auth, app_db) -> None:
    """When the BROKER is unreachable (acquire raises ConnectionError), DELETE
    degrades to lockless and SUCCEEDS — D-28: a dataset must stay deletable when
    Redis is down (PR #38 review finding 1; with the broker gone no concurrent
    enqueue can race the rmtree)."""
    data_root = Path(os.environ["DATA_ROOT"])
    ds_dir = _write_manifest_dir(data_root, "ds_down_del")
    _seed_record(app_db, "ds_down_del", "alice")
    client.app.state.redis = _DownRedis()
    assert client.delete("/api/datasets/ds_down_del", headers=auth).status_code == 204
    assert not ds_dir.exists()                          # removed
    assert _read_record(app_db, "ds_down_del") is None  # record gone


def test_reingest_lock_unavailable_is_503(client, auth, fake_queue, app_db) -> None:
    """When the mutation lock cannot be acquired, re-ingest answers 503 (PR24-8)."""
    first = _finalized_images_bundle(client, auth)
    assert client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_ri_busy", "upload_id": first}
    ).status_code == 200
    record_before = _read_record(app_db, "ds_ri_busy")
    assert record_before is not None
    job_before = record_before.last_job_id

    client.app.state.redis = _UnavailableRedis()
    second = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_ri_busy/ingest", headers=auth, json={"upload_id": second}
    )
    assert r.status_code == 503
    record = _read_record(app_db, "ds_ri_busy")
    assert record is not None and record.last_job_id == job_before  # job unchanged


def test_reingest_redis_down_is_clean_503(client, auth, fake_queue, app_db) -> None:
    """A BROKER OUTAGE during re-ingest maps to a clean 503, not an unhandled 500:
    real redis-py acquire() RAISES ConnectionError on an outage and dataset_lock
    converts it (PR #38 review finding 1a; re-ingest cannot enqueue without the
    broker regardless, so 503 is honest)."""
    first = _finalized_images_bundle(client, auth)
    assert client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_ri_down", "upload_id": first}
    ).status_code == 200
    client.app.state.redis = _DownRedis()
    second = _finalized_images_bundle(client, auth)
    r = client.post("/api/datasets/ds_ri_down/ingest", headers=auth, json={"upload_id": second})
    assert r.status_code == 503


def test_lock_does_not_mask_http_errors_inside_section(
    client, auth, fake_queue, app_db
) -> None:
    """An HTTPException raised INSIDE the locked section (here: the 409 foreign-owner
    conflict) propagates with its own status — the lock wrapper must not rewrite it
    to a 503 (PR24-8: lock-acquire failures alone map to 503)."""
    _seed_user(app_db, "bob")
    _seed_record(app_db, "ds_owned", "bob")
    upload_id = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_owned", "upload_id": upload_id},
    )
    assert r.status_code == 409  # not 503 — the in-section HTTPException is preserved
    assert fake_queue.calls == []


# --- PR24 code-review follow-ups ---------------------------------------------


def test_list_batches_rq_status_in_one_fetch(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """PR24-1: the listing resolves ALL pending datasets' RQ state in ONE
    Job.fetch_many round-trip, not N sequential (event-loop-blocking) fetches."""
    _seed_record(app_db, "ds_a", "alice", job_id="j-a")
    _seed_record(app_db, "ds_b", "alice", job_id="j-b")
    _seed_record(app_db, "ds_c", "alice", job_id="j-c")
    counter = _mock_job_states(
        monkeypatch, {"j-a": "started", "j-b": "queued", "j-c": "failed"}
    )

    by_id = {
        d["dataset_id"]: d
        for d in client.get("/api/datasets", headers=auth).json()["datasets"]
    }
    assert by_id["ds_a"]["status"] == "processing"
    assert by_id["ds_b"]["status"] == "processing"
    assert by_id["ds_c"]["status"] == "error"
    assert counter["calls"] == 1  # ONE batched fetch_many for all three


# NOTE: the interim create-side username-collision 409 (PR24-2) and its DELETE-side
# twin are RETIRED by D-30 (disjoint datasets/ and users/ roots). Their replacement
# is the both-direction structural coexistence proof:
#   - forward (dataset id == username, create/ingest/read/delete): see
#     test_write_ingest.test_dataset_id_equal_to_username_coexists_forward
#   - reverse (signup named like an existing dataset, nests nothing): see
#     test_dataset_id_equal_to_username_coexists_reverse above.


def _set_encryption_flag(zip_bytes: bytes) -> bytes:
    """Set general-purpose-bit-flag bit 0 (the ZIP encryption flag) in every local
    and central-directory header. stdlib zipfile cannot WRITE an encrypted entry
    (and recomputes flag_bits on write, dropping a ZipInfo flag), so we mark the
    flag in the finished bytes — infolist reads it back from the central directory.
    The tiny, known payload makes a false signature match in the data implausible."""
    data = bytearray(zip_bytes)
    for sig, flag_off in ((b"PK\x01\x02", 8), (b"PK\x03\x04", 6)):  # central, local
        start = 0
        while (i := data.find(sig, start)) != -1:
            data[i + flag_off] |= 0x01
            start = i + 4
    return bytes(data)


def test_zip_encrypted_is_400(client, auth) -> None:
    """PR24-7: an entry with the ZIP encryption flag set is rejected at 400 before
    any extraction (the planner only reads the flag — no decryption attempted)."""
    payload = _set_encryption_flag(_make_zip({"secret.png": b"ciphertext"}))
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]

    r = _post_zip(client, auth, upload_id, payload)
    assert r.status_code == 400
    assert "ncrypted" in r.json()["detail"]
    session_dir = _session_dir(upload_id)
    assert list((session_dir / "images").iterdir()) == []
    assert not (session_dir / ".extract-tmp").exists()


def test_zip_unsupported_compression_is_400(client, auth, monkeypatch) -> None:
    """PR24-3: a compression method the stdlib can't decode makes zf.open raise
    NotImplementedError — the ZIP branch maps that to 400, never a 500."""
    payload = _make_zip({"a.png": b"img-bytes"})  # build BEFORE patching open

    def fake_open(self, name, *args, **kwargs):  # noqa: ANN001, ANN202
        raise NotImplementedError("compression type 99 (AES)")

    monkeypatch.setattr(zipfile.ZipFile, "open", fake_open)
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]

    r = _post_zip(client, auth, upload_id, payload)
    assert r.status_code == 400
    assert not (_session_dir(upload_id) / ".extract-tmp").exists()


def test_zip_dotdot_entry_ignored_no_traversal(client, auth) -> None:
    """PR24-7: an entry whose flattened basename is '..' has no placeable name — it
    is ignored (never written), while a real image alongside it still extracts."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = _post_zip(
        client, auth, upload_id, _make_zip({"nested/..": b"x", "real.png": b"y"})
    )
    assert r.status_code == 200, r.text
    assert "nested/.." in r.json()["ignored"]
    session_dir = _session_dir(upload_id)
    assert {p.name for p in (session_dir / "images").iterdir()} == {"real.png"}


def test_reingest_enqueue_failure_is_503(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """PR24-5: a broker outage on re-ingest answers a clean 503 (mirroring create),
    not an opaque 500; last_job_id is left untouched."""
    first = _finalized_images_bundle(client, auth)
    ok = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_re", "upload_id": first},
    )
    assert ok.status_code == 200, ok.text
    job_before = ok.json()["job_id"]
    _create_job_finished(monkeypatch)

    client.app.state.queue = _FailingQueue()  # broker goes down
    second = _finalized_images_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_re/ingest",
        headers=auth,
        json={"upload_id": second},
    )
    assert r.status_code == 503
    record = _read_record(app_db, "ds_re")
    assert record is not None and record.last_job_id == job_before  # unchanged


# --- event-loop discipline (fix/api-event-loop) ------------------------------


def test_get_job_blocking_body_runs_off_the_event_loop(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """get_job's blocking body (two Redis round-trips + the ingest.log tail read) must
    run OFF the event loop — the frontend polls it throughout every ingest, so inline
    blocking I/O stalled every concurrent request. The route is now `async def` (D-34
    added an on-loop may_read authorization step), but the blocking work is encapsulated
    in `_build_job_status` and dispatched to the threadpool via run_in_threadpool. Spies
    on jobs.run_in_threadpool and asserts the sync builder reaches it — pinning the fix
    so a future edit cannot move the blocking calls back inline on the loop."""
    from api.routers import jobs

    _seed_record(app_db, "ds_tp", "alice")  # alice owns it → may_read authorizes (200)
    fake_job = SimpleNamespace(
        get_status=lambda: "finished",
        kwargs={"dataset_id": "ds_tp", "output_root": "/nonexistent"},
        exc_info=None,
        get_meta=lambda refresh=False: {},
    )
    monkeypatch.setattr(jobs.Job, "fetch", lambda job_id, connection=None: fake_job)

    real = jobs.run_in_threadpool
    dispatched: list[object] = []

    async def spying(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        dispatched.append(func)
        return await real(func, *args, **kwargs)

    monkeypatch.setattr(jobs, "run_in_threadpool", spying)
    resp = client.get("/api/jobs/whatever", headers=auth)
    assert resp.status_code == 200, resp.text
    assert jobs._build_job_status in dispatched
    # The owner's gated hop (PR #405) reads ingest.log and, for a failed or finished job,
    # Redis — blocking I/O too. alice owns ds_tp, so the hop runs; it must be dispatched.
    assert jobs._read_owner_fields in dispatched


def test_zip_extraction_dispatched_off_the_event_loop(client, auth, monkeypatch) -> None:
    """The D-27 extract+merge (up to ~2 GiB of decompression) must reach the
    threadpool, never run inline on the event loop — one user's upload froze the
    whole API otherwise. Spies on uploads.run_in_threadpool (delegating to the real
    one) and asserts the sync extraction helper was dispatched through it while the
    upload still succeeds end-to-end."""
    from api.routers import uploads

    real = uploads.run_in_threadpool
    dispatched: list[object] = []

    async def spying(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        dispatched.append(func)
        return await real(func, *args, **kwargs)

    monkeypatch.setattr(uploads, "run_in_threadpool", spying)
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = _post_zip(client, auth, upload_id, _make_zip({"a.png": b"img-bytes"}))
    assert r.status_code == 200, r.text
    assert uploads._extract_and_merge_zip in dispatched
    session_dir = _session_dir(upload_id)
    assert {p.name for p in (session_dir / "images").iterdir()} == {"a.png"}
    assert not (session_dir / ".extract-tmp").exists()


# --- T2-53: incremental per-upload count/bytes tally -------------------------


def _read_tally_file(upload_id: str) -> dict:
    """The persisted .tally.json for alice's upload session (T2-53)."""
    from api.routers import uploads

    return json.loads(
        (_session_dir(upload_id) / uploads._TALLY_FILE).read_text(encoding="utf-8")
    )


def _true_totals(upload_id: str) -> tuple[int, int]:
    """Ground-truth (file count, byte total) of the bundle from a full scan — the
    invariant the tally must equal."""
    from api.routers import uploads

    return uploads._recount_tally(_session_dir(upload_id))


def test_tally_matches_reality_after_multipart_upload(client, auth) -> None:
    """After N plain parts (images + a CSV), the persisted tally EXACTLY equals a
    full recount, and drives the reported received_parts / bytes_received (T2-53)."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    parts = [
        ("img_000.webp", b"\x00aaaa"),
        ("img_001.webp", b"\x00bb"),
        ("img_002.webp", b"cccccc"),
        ("meta.csv", b"filename,color\nimg_000.webp,red\n"),
    ]
    total = 0
    for i, (name, data) in enumerate(parts, start=1):
        r = client.post(
            f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)}
        )
        assert r.status_code == 200, r.text
        total += len(data)
        body = r.json()
        assert body["received_parts"] == i  # tally-driven count
        assert body["bytes_received"] == total  # tally-driven bytes

    # The persisted tally equals reality (a full recount) after the session.
    assert _read_tally_file(upload_id) == {"count": len(parts), "bytes": total}
    assert _true_totals(upload_id) == (len(parts), total)

    # GET status reads the same tally (no rescan) and agrees.
    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["received_parts"] == len(parts)
    assert status["bytes_received"] == total


def test_tally_tracks_zip_extraction(client, auth) -> None:
    """A ZIP part folds its EXTRACTED (uncompressed) delta into the tally, which then
    matches a full recount of the merged bundle (T2-53)."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    csv_bytes = b"filename,color\nx.png,red\n"
    payload = _make_zip(
        {"a/b/x.png": b"px-1", "y.png": b"py-22", "metadata.csv": csv_bytes}
    )
    r = _post_zip(client, auth, upload_id, payload)
    assert r.status_code == 200, r.text
    expected_bytes = len(b"px-1") + len(b"py-22") + len(csv_bytes)
    assert r.json()["received_parts"] == 3
    assert r.json()["bytes_received"] == expected_bytes
    assert _read_tally_file(upload_id) == {"count": 3, "bytes": expected_bytes}
    assert _true_totals(upload_id) == (3, expected_bytes)

    # A subsequent plain part accrues on top of the ZIP tally.
    r2 = client.post(
        f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("z.png", b"zzz")}
    )
    assert r2.json()["received_parts"] == 4
    assert r2.json()["bytes_received"] == expected_bytes + 3
    assert _true_totals(upload_id) == (4, expected_bytes + 3)


def test_tally_byte_cap_enforced_exactly_at_boundary(client, auth, monkeypatch) -> None:
    """The byte cap fires EXACTLY at the boundary off the tally: a part that lands
    the bundle on the cap is accepted; the next byte over is 413, and the tally never
    counts the rejected part (T2-53)."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "10")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    # Exactly at the cap: 10 bytes.
    at_cap = client.post(
        f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("a.png", b"0123456789")}
    )
    assert at_cap.status_code == 200
    assert _read_tally_file(upload_id) == {"count": 1, "bytes": 10}
    # One byte over the cap → 413; the tally is unchanged (rejected part not counted).
    over = client.post(
        f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("b.png", b"x")}
    )
    assert over.status_code == 413
    assert _read_tally_file(upload_id) == {"count": 1, "bytes": 10}
    assert _true_totals(upload_id) == (1, 10)


def test_tally_entry_cap_enforced_exactly_at_boundary(client, auth, monkeypatch) -> None:
    """The entry cap fires EXACTLY at the boundary off the tally (T2-53)."""
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    for name in ("a.png", "b.png"):  # fills to the cap
        assert (
            client.post(
                f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, b"x")}
            ).status_code
            == 200
        )
    assert _read_tally_file(upload_id)["count"] == 2
    third = client.post(
        f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("c.png", b"x")}
    )
    assert third.status_code == 413
    assert _read_tally_file(upload_id)["count"] == 2  # rejected part not counted


def test_missing_tally_recounts_not_undercounts(client, auth) -> None:
    """A DELETED .tally.json is rebuilt from a full recount (never under-counts): the
    next status/part reflects what is actually on disk (T2-53 constraint (b))."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    for name, data in (("a.png", b"aaaa"), ("b.png", b"bb")):
        client.post(
            f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)}
        )
    # Simulate a lost/absent tally (e.g. an older session predating the tally).
    (_session_dir(upload_id) / uploads._TALLY_FILE).unlink()

    # GET status must recount to the TRUTH, not report an under-count of 0.
    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["received_parts"] == 2
    assert status["bytes_received"] == 6
    # ...and the tally file is repaired to reality.
    assert _read_tally_file(upload_id) == {"count": 2, "bytes": 6}


def test_corrupt_tally_recounts_not_undercounts(client, auth) -> None:
    """A CORRUPT .tally.json (garbage / wrong shape / negative) is treated as doubt →
    full recount, never trusted to under-count (T2-53 constraint (b))."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    for name, data in (("a.png", b"aaaa"), ("b.png", b"bb")):
        client.post(
            f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)}
        )
    tally_path = _session_dir(upload_id) / uploads._TALLY_FILE
    # Under-counting garbage that, if trusted, would let the bundle exceed caps.
    tally_path.write_text('{"count": -5, "bytes": "not-an-int"}', encoding="utf-8")

    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["received_parts"] == 2
    assert status["bytes_received"] == 6
    assert _read_tally_file(upload_id) == {"count": 2, "bytes": 6}


def test_finalize_reconciles_a_drifted_tally(client, auth) -> None:
    """Finalize RECOUNTS and rewrites the tally to reality, so a mid-session drift
    (here a hand-tampered low tally, standing in for a crash between commit and the
    tally update) is corrected before the bundle is handed to ingest (T2-53
    constraint (c))."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    for name, data in (("a.png", b"aaaa"), ("b.png", b"bb")):
        client.post(
            f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)}
        )
    # Drift the persisted tally LOW (as a post-commit crash would leave it).
    (_session_dir(upload_id) / uploads._TALLY_FILE).write_text(
        '{"count": 1, "bytes": 2}', encoding="utf-8"
    )
    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 200
    # The tally now matches the true bundle (2 files, 6 bytes).
    assert _read_tally_file(upload_id) == {"count": 2, "bytes": 6}
    assert _true_totals(upload_id) == (2, 6)


def test_apply_tally_delta_no_lost_updates_under_concurrency(client, auth) -> None:
    """The per-upload file lock serialises the tally read-modify-write: many threads
    applying a +1/+bytes delta at once all land (no lost updates), so the tally never
    under-counts under concurrent parts to the same bundle (T2-53 constraint (a)).
    Drives `_apply_tally_delta` directly under real threads — the serialisation
    primitive the concurrent HTTP part paths rely on."""
    import threading

    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    upload_dir = _session_dir(upload_id)
    uploads._write_tally(upload_dir, 0, 0)  # start from a known base

    n = 50
    barrier = threading.Barrier(n)

    def worker() -> None:
        barrier.wait()  # maximise overlap on the read-modify-write
        uploads._apply_tally_delta(upload_dir, 1, 3)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Every delta is reflected — no read-modify-write was lost.
    assert _read_tally_file(upload_id) == {"count": n, "bytes": 3 * n}


def test_tally_files_not_ingested_as_bundle_content(client, auth, fake_queue) -> None:
    """The .tally.json / .tally.lock sidecars live at the session root, NOT in
    images/, so they never become bundle content nor perturb the recount (T2-53)."""
    from api.routers import uploads

    upload_id = _finalized_images_bundle(client, auth)
    session_dir = _session_dir(upload_id)
    # The tally sidecar exists at the session root (written on finalize)...
    assert (session_dir / uploads._TALLY_FILE).is_file()
    # ...but images/ holds ONLY the uploaded images — no tally files leaked in.
    assert {p.name for p in (session_dir / "images").iterdir()} == {
        "img_000.webp",
        "img_001.webp",
    }
    # The recount (what ingest-facing accounting uses) counts exactly the 2 images.
    assert _true_totals(upload_id) == (2, len(b"\x00fake-image-bytes") * 2)


# --- Seam O2: upload resume surface ------------------------------------------
# Streamed content hashing (.files.json manifest), GET /api/uploads list,
# GET /api/uploads/{id}/files, POST /api/uploads/{id}/check, idempotent re-send,
# and the stale-session sweep. Follows the T2-53 tally tests' style (in-memory
# ZIPs, real TestClient, per-test DATA_ROOT under tmp).


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _auth_for(client, username: str) -> dict[str, str]:
    """Sign up + log in `username` via the real auth path; return a bearer header
    (the second-user primitive for the owner-jailing test)."""
    signup = {
        "username": username,
        "email": f"{username}@example.com",
        "password": "s3cretpw",
    }
    assert client.post("/api/auth/signup", json=signup).status_code == 200
    token = client.post(
        "/api/auth/login", json={"username": username, "password": "s3cretpw"}
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _open_with_part(client, auth, name: str, data: bytes) -> str:
    """Open a session and upload one plain part; return the upload_id."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = client.post(
        f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)}
    )
    assert r.status_code == 200, r.text
    return upload_id


def _backdate_session(session_dir: Path, seconds_ago: float) -> None:
    """Age EVERY mtime in the session tree, so max(mtimes) lands in the past (any one
    left fresh would keep the session).

    Walks the tree rather than naming the five paths the sweep used to read. Those five
    were a copy of `_session_mtimes`' own tuple, so this helper had to be edited in step
    with it or these specs would silently stop reaping — and when `_session_mtimes` grew
    to see the staged prefixes of in-flight parts (review of PR #304, finding 2), that is
    exactly what happened: three sweep specs went red because the `.tally.lock` /
    `.files.lock` files this never touched were still fresh. Aging everything cannot
    drift: it is strictly a superset of whatever the sweep reads, and it is the state a
    genuinely idle session is in. Children first so a directory's own mtime is not
    refreshed by a later `utime` on something inside it."""
    past = time.time() - seconds_ago
    for p in sorted(session_dir.rglob("*"), key=lambda q: len(q.parts), reverse=True):
        os.utime(p, (past, past))
    os.utime(session_dir, (past, past))


def _files_by_name(client, auth, upload_id: str, **params) -> dict:
    query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"/api/uploads/{upload_id}/files" + (f"?{query}" if query else "")
    return client.get(url, headers=auth).json()


# --- O2: streamed content hashing (the .files.json manifest) -----------------


def test_manifest_hashes_plain_parts_and_csv(client, auth) -> None:
    """Every plain part is SHA-256'd in `_store_part`'s streaming loop (free) and
    surfaced by /files with its size; the CSV is stored canonically as metadata.csv
    and flagged is_metadata."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    img = b"\x00image-bytes-abcdef"
    csv = b"filename,color\na.png,red\n"
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img_000.png", img)})
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("meta.csv", csv)})

    page = _files_by_name(client, auth, upload_id)
    by_name = {f["name"]: f for f in page["files"]}
    assert page["total"] == 2
    assert by_name["img_000.png"]["size"] == len(img)
    assert by_name["img_000.png"]["sha256"] == _sha(img)
    assert by_name["img_000.png"]["is_metadata"] is False
    # The CSV lands under the canonical name and is flagged.
    assert by_name["metadata.csv"]["size"] == len(csv)
    assert by_name["metadata.csv"]["sha256"] == _sha(csv)
    assert by_name["metadata.csv"]["is_metadata"] is True


def test_manifest_hashes_zip_entries(client, auth) -> None:
    """A ZIP part hashes each EXTRACTED entry (image + root CSV) in `_extract_entry`
    — the manifest matches a hash of the uncompressed bytes, not the archive."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    x, y, csv = b"px-1", b"py-22", b"filename\nx.png\n"
    payload = _make_zip({"a/b/x.png": x, "y.png": y, "metadata.csv": csv})
    assert _post_zip(client, auth, upload_id, payload).status_code == 200

    by_name = {f["name"]: f for f in _files_by_name(client, auth, upload_id)["files"]}
    assert by_name["x.png"]["sha256"] == _sha(x)
    assert by_name["y.png"]["sha256"] == _sha(y)
    assert by_name["metadata.csv"]["sha256"] == _sha(csv)
    assert by_name["metadata.csv"]["is_metadata"] is True


def test_files_manifest_rebuilds_after_deletion(client, auth) -> None:
    """A DELETED `.files.json` is rebuilt by re-hashing the bundle on the next /files
    read (crash-safety fallback), and repaired on disk."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    a, b = b"aaaa", b"bbbbbb"
    for name, data in (("a.png", a), ("b.png", b)):
        client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)})
    (_session_dir(upload_id) / uploads._FILES_FILE).unlink()

    by_name = {f["name"]: f for f in _files_by_name(client, auth, upload_id)["files"]}
    assert by_name["a.png"]["sha256"] == _sha(a)
    assert by_name["b.png"]["sha256"] == _sha(b)
    assert (_session_dir(upload_id) / uploads._FILES_FILE).is_file()  # repaired


def test_files_manifest_rebuilds_after_corruption(client, auth) -> None:
    """A CORRUPT `.files.json` (garbage / wrong shape) is treated as doubt → full
    re-hash rebuild, never served torn."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    a = b"aaaa"
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("a.png", a)})
    (_session_dir(upload_id) / uploads._FILES_FILE).write_text("not json {", encoding="utf-8")

    by_name = {f["name"]: f for f in _files_by_name(client, auth, upload_id)["files"]}
    assert by_name["a.png"] == {
        "name": "a.png",
        "size": 4,
        "sha256": _sha(a),
        "is_metadata": False,
    }


# --- O2: GET /api/uploads (list) — owner-jailed, tally-backed -----------------


def test_list_uploads_reports_state_and_counts(client, auth) -> None:
    open_id = _open_with_part(client, auth, "a.png", b"aaaa")
    fin_id = _finalized_images_bundle(client, auth)  # 2 images, finalized

    sessions = {s["upload_id"]: s for s in client.get("/api/uploads", headers=auth).json()}
    assert sessions[open_id]["state"] == "open"
    assert sessions[open_id]["received_parts"] == 1
    assert sessions[open_id]["bytes_received"] == 4
    assert sessions[fin_id]["state"] == "finalized"
    assert sessions[fin_id]["received_parts"] == 2
    # mtime-derived timestamps are present and ordered.
    assert sessions[open_id]["last_activity"] >= sessions[open_id]["created"] > 0


def test_list_uploads_is_owner_jailed(client) -> None:
    """User B never sees user A's sessions (the list is jailed to the caller's own
    users/{owner}/uploads/ dir)."""
    alice = _auth_for(client, "alice")
    bob = _auth_for(client, "bob")
    a_id = _open_with_part(client, alice, "a.png", b"a")
    b_id = _open_with_part(client, bob, "b.png", b"b")

    a_ids = {s["upload_id"] for s in client.get("/api/uploads", headers=alice).json()}
    assert a_id in a_ids and b_id not in a_ids
    b_ids = {s["upload_id"] for s in client.get("/api/uploads", headers=bob).json()}
    assert b_id in b_ids and a_id not in b_ids


def test_files_and_check_are_owner_jailed(client) -> None:
    """User B cannot read user A's per-file manifest or pre-check it — the routes
    resolve under the CALLER's own jail, so A's upload_id is a 404 for B (never a
    cross-user read)."""
    alice = _auth_for(client, "alice")
    bob = _auth_for(client, "bob")
    a_id = _open_with_part(client, alice, "secret.png", b"top-secret")

    assert client.get(f"/api/uploads/{a_id}/files", headers=bob).status_code == 404
    check = client.post(
        f"/api/uploads/{a_id}/check",
        headers=bob,
        json={"files": [{"name": "secret.png", "size": 10}]},
    )
    assert check.status_code == 404
    # The owner still reads it fine.
    assert client.get(f"/api/uploads/{a_id}/files", headers=alice).status_code == 200


# --- O2: GET /api/uploads/{id}/files — pagination ----------------------------


def test_files_pagination_bounds(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    names = [f"img_{i:02d}.png" for i in range(5)]
    for n in names:
        client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (n, b"xx")})

    full = _files_by_name(client, auth, upload_id)
    assert full["total"] == 5 and len(full["files"]) == 5
    assert [f["name"] for f in full["files"]] == sorted(names)  # name-sorted

    page = _files_by_name(client, auth, upload_id, limit=2, offset=1)
    assert page["limit"] == 2 and page["offset"] == 1 and page["total"] == 5
    assert [f["name"] for f in page["files"]] == sorted(names)[1:3]

    tail = _files_by_name(client, auth, upload_id, offset=99)  # past the end
    assert tail["files"] == [] and tail["total"] == 5

    # Nonsensical params are rejected by validation (422), never silently coerced.
    assert client.get(f"/api/uploads/{upload_id}/files?limit=0", headers=auth).status_code == 422
    assert client.get(f"/api/uploads/{upload_id}/files?offset=-1", headers=auth).status_code == 422


def test_files_limit_clamped_to_cap(client, auth) -> None:
    """An over-cap `limit` is CLAMPED (never a 250k-row response), and the response
    echoes the effective limit."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("a.png", b"x")})
    page = _files_by_name(client, auth, upload_id, limit=999999)
    assert page["limit"] == uploads._MAX_FILES_LIMIT


# --- O2: POST /api/uploads/{id}/check — tri-state pre-check ------------------


def test_check_tristate(client, auth) -> None:
    """present = name+size (and hash when both carry one); mismatched = size OR hash
    differs; needed = absent."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    stored = {"x1.png": b"aaaa", "x2.png": b"bbbb", "x3.png": b"cccc", "x4.png": b"dddd"}
    for name, data in stored.items():
        client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": (name, data)})

    req = {
        "files": [
            {"name": "x1.png", "size": 4},                              # present (size only)
            {"name": "x2.png", "size": 4, "sha256": _sha(b"bbbb")},     # present (hash match)
            {"name": "x3.png", "size": 99},                            # mismatched (size)
            {"name": "x4.png", "size": 4, "sha256": _sha(b"WRONG")},    # mismatched (hash)
            {"name": "nope.png", "size": 4},                           # needed (absent)
        ]
    }
    body = client.post(f"/api/uploads/{upload_id}/check", headers=auth, json=req).json()
    assert set(body["present"]) == {"x1.png", "x2.png"}
    assert set(body["mismatched"]) == {"x3.png", "x4.png"}
    assert set(body["needed"]) == {"nope.png"}


def test_check_request_cap_is_413(client, auth, monkeypatch) -> None:
    """Too many files in one /check request → 413 (the client batches)."""
    from api.routers import uploads

    monkeypatch.setattr(uploads, "_MAX_CHECK_FILES", 3)
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    req = {"files": [{"name": f"f{i}.png", "size": 1} for i in range(4)]}
    r = client.post(f"/api/uploads/{upload_id}/check", headers=auth, json=req)
    assert r.status_code == 413


# --- O2: idempotent re-send --------------------------------------------------


def test_resend_exact_match_is_200_already_present(client, auth) -> None:
    """A byte-identical duplicate part is a no-op: 200 with already_present, the
    tally NOT double-counted (safe blind retry)."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    data = b"\x00some-image-bytes"
    r1 = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", data)})
    assert r1.status_code == 200 and r1.json()["already_present"] is False

    r2 = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", data)})
    assert r2.status_code == 200
    body = r2.json()
    assert body["already_present"] is True
    assert body["received_parts"] == 1  # not doubled
    assert body["bytes_received"] == len(data)
    assert _read_tally_file(upload_id) == {"count": 1, "bytes": len(data)}


def test_resend_size_mismatch_is_409_original_intact(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", b"aaaa")})
    r = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", b"aaaaaa")})
    assert r.status_code == 409
    assert "check" in r.json()["detail"]  # points at the pre-check
    # The stored file is untouched and the tally unchanged.
    assert (_session_dir(upload_id) / "images" / "img.png").read_bytes() == b"aaaa"
    assert _read_tally_file(upload_id) == {"count": 1, "bytes": 4}


def test_resend_hash_mismatch_same_size_is_409(client, auth) -> None:
    """Same size, different bytes (a genuine collision) stays 409 — the stored hash
    catches it; the existing file wins."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", b"aaaa")})
    r = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", b"bbbb")})
    assert r.status_code == 409
    assert (_session_dir(upload_id) / "images" / "img.png").read_bytes() == b"aaaa"


def test_resend_csv_exact_match_is_200_and_diff_ext_still_409(client, auth) -> None:
    """A re-sent identical CSV is idempotent (200); a DIFFERENT metadata source
    (other extension) still conflicts (409 — one CSV/TSV per bundle)."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    csv = b"filename,color\na.png,red\n"
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("meta.csv", csv)})

    same = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("meta.csv", csv)})
    assert same.status_code == 200 and same.json()["already_present"] is True
    assert _read_tally_file(upload_id) == {"count": 1, "bytes": len(csv)}

    other = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("other.tsv", b"a\tb\n1\t2\n")})
    assert other.status_code == 409


def test_resend_after_manifest_loss_rehashes_stored(client, auth) -> None:
    """If the manifest lost a file's entry (a crash), an exact re-send is still 200
    — `_resend_or_conflict` re-hashes the stored file directly, never a false 409."""
    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    data = b"\x00xyz-bytes"
    client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", data)})
    uploads._write_manifest(_session_dir(upload_id), {})  # drop the entry (crash sim)

    r = client.post(f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("img.png", data)})
    assert r.status_code == 200 and r.json()["already_present"] is True


# --- O2: manifest concurrency (flock — no lost updates) ----------------------


def test_apply_manifest_entries_no_lost_updates_under_concurrency(client, auth) -> None:
    """The per-upload file lock serialises the manifest read-modify-write: 50 threads
    each merging a DISTINCT entry all land (no lost updates), mirroring the T2-53
    tally concurrency test."""
    import threading

    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    upload_dir = _session_dir(upload_id)
    uploads._write_manifest(upload_dir, {})  # known base

    n = 50
    barrier = threading.Barrier(n)

    def worker(i: int) -> None:
        barrier.wait()  # maximise overlap on the read-modify-write
        uploads._apply_manifest_entries(upload_dir, [(f"f{i:03d}.png", i, f"sha{i}")])

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    manifest = uploads._read_manifest(upload_dir)
    assert manifest is not None
    assert len(manifest) == n  # every distinct key survived
    for i in range(n):
        assert manifest[f"f{i:03d}.png"] == {"size": i, "sha256": f"sha{i}"}


# --- O2: stale-session sweep -------------------------------------------------


def test_sweep_reaps_stale_unfinalized_keeps_fresh(client, auth) -> None:
    from api.routers import uploads

    fresh = _open_with_part(client, auth, "f.png", b"fresh")
    stale = _open_with_part(client, auth, "s.png", b"stale")
    _backdate_session(_session_dir(stale), seconds_ago=8 * 24 * 3600)

    uploads_root = _session_dir(fresh).parent
    swept = uploads._sweep_stale_sessions(uploads_root, ttl_seconds=7 * 24 * 3600)
    assert {p.name for p in swept} == {stale}
    assert not _session_dir(stale).exists()  # stale un-finalized reaped
    assert _session_dir(fresh).exists()  # fresh kept


def test_sweep_never_reaps_finalized(client, auth) -> None:
    from api.routers import uploads

    fin = _finalized_images_bundle(client, auth)
    _backdate_session(_session_dir(fin), seconds_ago=30 * 24 * 3600)  # very old

    uploads_root = _session_dir(fin).parent
    swept = uploads._sweep_stale_sessions(uploads_root, ttl_seconds=7 * 24 * 3600)
    assert swept == []  # finalized bundles are ingest sources — never swept
    assert _session_dir(fin).exists()


def test_sweep_keeps_on_doubt(client, auth, monkeypatch) -> None:
    """When a session's mtimes cannot be read (total doubt), the sweep KEEPS it —
    never reaps on uncertainty."""
    from api.routers import uploads

    stale = _open_with_part(client, auth, "s.png", b"stale")
    _backdate_session(_session_dir(stale), seconds_ago=30 * 24 * 3600)
    monkeypatch.setattr(uploads, "_session_mtimes", lambda _dir: [])  # unreadable

    uploads_root = _session_dir(stale).parent
    swept = uploads._sweep_stale_sessions(uploads_root, ttl_seconds=7 * 24 * 3600)
    assert swept == []
    assert _session_dir(stale).exists()


def test_create_upload_sweeps_stale_session(client, auth) -> None:
    """Opening a new session reaps the caller's stale un-finalized ones first."""
    stale = _open_with_part(client, auth, "s.png", b"stale")
    _backdate_session(_session_dir(stale), seconds_ago=8 * 24 * 3600)

    new_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    assert not _session_dir(stale).exists()  # reaped by the create-time sweep
    assert _session_dir(new_id).exists()  # the fresh one is never a candidate


def test_list_uploads_sweeps_stale_but_keeps_finalized(client, auth) -> None:
    """The list route sweeps too: a stale un-finalized session is gone, a stale
    FINALIZED one survives (ingest source)."""
    stale_open = _open_with_part(client, auth, "o.png", b"o")
    fin = _finalized_images_bundle(client, auth)
    for sid in (stale_open, fin):
        _backdate_session(_session_dir(sid), seconds_ago=8 * 24 * 3600)

    ids = {s["upload_id"] for s in client.get("/api/uploads", headers=auth).json()}
    assert stale_open not in ids and not _session_dir(stale_open).exists()
    assert fin in ids and _session_dir(fin).exists()


# --- O2 (PR #151 review fix #1): reader rebuild-on-doubt repairs UNDER the flock ---


def test_reader_rebuild_repairs_manifest_under_flock(client, auth, monkeypatch) -> None:
    """The lock-free read paths (files/check/re-send) take `.files.lock` on the
    REBUILD-on-doubt branch, so their write-back of the repaired manifest cannot
    clobber a concurrent locked append. (Unlike the T2-53 tally, which finalize
    reconciles, the manifest has no later reconciliation to repair a lost entry — so
    the write-back must be serialised, not lock-free.) Deterministic regression guard:
    force the doubt path and assert the exclusive flock is held while the manifest is
    rebuilt + persisted."""
    import fcntl

    from api.routers import uploads

    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    data = b"\x00img-bytes-xyz"
    client.post(
        f"/api/uploads/{upload_id}/parts", headers=auth, files={"part": ("a.png", data)}
    )
    session = _session_dir(upload_id)
    (session / uploads._FILES_FILE).unlink()  # force rebuild-on-doubt

    ops: list[int] = []
    real_flock = fcntl.flock

    def spy(fd, op):
        ops.append(op)
        return real_flock(fd, op)

    monkeypatch.setattr(uploads.fcntl, "flock", spy)
    manifest = uploads._load_or_rebuild_manifest(session)

    assert manifest["a.png"] == {"size": len(data), "sha256": _sha(data)}  # rebuilt
    assert fcntl.LOCK_EX in ops, "rebuild-on-doubt must take the exclusive .files.lock"
    assert (session / uploads._FILES_FILE).is_file()  # repaired on disk


# --- O2 (PR #151 review fix #2): POST /check body byte cap (memory guard) ----------


def test_check_body_over_byte_cap_is_413_before_parse(client, auth, monkeypatch) -> None:
    """An oversized /check body is a 413 from the byte cap BEFORE it is buffered or
    parsed — the memory guard ahead of the _MAX_CHECK_FILES count cap. A legal file
    COUNT with an over-cap body still trips the byte cap (so it is not the count cap
    firing)."""
    monkeypatch.setenv("MAX_UPLOAD_CHECK_BODY_BYTES", "64")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    req = {"files": [{"name": f"image_{i:04d}.png", "size": 1234} for i in range(20)]}
    r = client.post(f"/api/uploads/{upload_id}/check", headers=auth, json=req)
    assert r.status_code == 413
    assert "body" in r.json()["detail"]  # the byte-cap message, not the count cap


def test_check_malformed_body_is_422(client, auth) -> None:
    """A malformed /check body (valid JSON, wrong shape) is a 422 — the raw-body read
    still validates as a CheckRequest, never a 500."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = client.post(
        f"/api/uploads/{upload_id}/check",
        headers={**auth, "Content-Type": "application/json"},
        content=b'{"files": "not-a-list"}',
    )
    assert r.status_code == 422


# --- Seam A2: GET /api/uploads/caps — the caps the client can read ------------


def test_upload_caps_are_the_documented_defaults(client, auth, monkeypatch) -> None:
    """With no env override the route advertises the interface-catalogue defaults.
    Pins the VALUES: Seam A2 exposes the caps, it does not move them.

    UPDATED BY SEAM L1, and the change is the point rather than an accident. Two of
    these are still constants; `max_bundle_bytes` is not one any more — its 2 GiB
    default was the value that refused a real corpus at 3,014 images against a PRD
    target of 1,000,000, and it is now DERIVED from the device the upload jail is on
    (`docs/design/LIMITS_REGISTER.md` C-1). So it is pinned to the derivation rather
    than to a number this test would otherwise have to invent. The entry cap's 250,000
    moved to the PRD's own 1,000,000 for the same reason — see
    `test_derived_upload_bound.py`."""
    for name in ("MAX_UPLOAD_PART_BYTES", "MAX_UPLOAD_BUNDLE_BYTES", "MAX_UPLOAD_ENTRIES"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(uploads, "_disk_total", lambda path: 777_000_000_000)
    r = client.get("/api/uploads/caps", headers=auth)
    assert r.status_code == 200
    assert r.json() == {
        "max_part_bytes": 104_857_600,  # 100 MiB
        "max_bundle_bytes": 777_000_000_000,  # the device, not a constant
        "max_entries": 1_000_000,  # the PRD's target
    }


def test_upload_caps_follow_the_env_overrides(client, auth, monkeypatch) -> None:
    """THE bug this seam fixes: the advertised caps are the ENV-derived values, not
    the compiled-in `_DEFAULT_*` constants — so RAISING MAX_UPLOAD_PART_BYTES on a
    deployment is finally visible to a client. Every value here is non-default, and
    the part cap is raised (the case that was silently ineffective)."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "314159265")
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "271828182845")
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "1618")
    body = client.get("/api/uploads/caps", headers=auth).json()
    assert body == {
        "max_part_bytes": 314_159_265,
        "max_bundle_bytes": 271_828_182_845,
        "max_entries": 1618,
    }


def test_advertised_part_cap_is_the_enforced_part_cap(client, auth, monkeypatch) -> None:
    """The advertised number and the enforced number cannot diverge — proved against
    the STORE path rather than by re-reading the same helper: a part of exactly the
    advertised size is stored (200) and one byte more is refused (413)."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    limit = client.get("/api/uploads/caps", headers=auth).json()["max_part_bytes"]
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    at_cap = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("a.png", b"x" * limit)},
    )
    assert at_cap.status_code == 200
    over = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("b.png", b"x" * (limit + 1))},
    )
    assert over.status_code == 413


def test_upload_caps_requires_auth(client) -> None:
    """Authenticated like every other route in this router — the caps describe the
    deployment and this seam does not widen who may read them."""
    assert client.get("/api/uploads/caps").status_code == 401
