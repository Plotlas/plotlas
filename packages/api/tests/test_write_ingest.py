"""Tier-1 tests for the API write/ingest surface (seam 10c, brief §3).

Exercises the real app (auth → uploads → create-dataset → jobs) with a MOCKED RQ
queue and a mocked `Job.fetch`, so the loop needs no live Redis and never runs the
pipeline worker (directive #7). Asserts the dispatch contract — the dotted path
`pipeline.worker.run_ingest_job` plus the exact primitive kwargs (including the
images-only `csv_path=None, column_roles=None` case) — the upload jail, owner
recording, and the RQ-state + ingest.log merge. App-state owner reads/seeds use a
second engine over the same SQLite file (one asyncio.run loop each), mirroring
test_read_serve.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import threading
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from api import appstate, db

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


# --- fakes -----------------------------------------------------------------


class _FakeQueue:
    """Stand-in for rq.Queue: records enqueue dispatches and returns a job-id-bearing
    handle, so create/start tests assert the contract without a broker."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.connection = object()  # passed to Job.fetch; mocked away in get_job tests

    def enqueue(  # noqa: ANN201
        self, func_string: str, kwargs: dict | None = None, *, job_timeout: int | float | None = None
    ):
        # job_timeout (T2-97) is a top-level rq.Queue.enqueue arg, not a job kwarg —
        # accepted here so the real enqueue_ingest/enqueue_add_layouts call binds;
        # the enqueue drift guard (tests/smoke) is what asserts its value.
        self.calls.append((func_string, kwargs or {}))
        return SimpleNamespace(id="job-test-123")


class _FakeLock:
    """A no-op redis-py lock: acquire/release always succeed, never touching Redis.
    Stands in for the PR24-8 per-dataset mutation lock in unit tests (no live
    broker), recording its key so a test can assert the dataset is locked."""

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
    dataset lock uses). Records the keys locked so create/delete/re-ingest tests can
    assert the per-`dataset_id` lock fired without a live broker (brief: fake lock)."""

    def __init__(self) -> None:
        self.locked_keys: list[str] = []

    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _FakeLock(name, self.locked_keys)


# --- fixtures --------------------------------------------------------------


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    """Fresh per-test app-state DB + a writable DATA_ROOT under tmp (D-30: uploads
    land under users/, dataset trees under datasets/ — never the repo). Returns the
    app-state DB path for owner seeds/reads."""
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
        # client.app.state.redis.locked_keys.
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
    """Replace the lifespan-created Queue with a recording fake (after startup, so
    the write routes read it off request.app.state.queue)."""
    queue = _FakeQueue()
    client.app.state.queue = queue
    return queue


# --- helpers ---------------------------------------------------------------


def _finalized_bundle(client, auth, *, with_csv: bool = False) -> str:
    """create → upload two images (+ optional CSV) → finalize; return the upload_id."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    for name in ("img_000.webp", "img_001.webp"):
        r = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": (name, b"\x00fake-image-bytes")},
        )
        assert r.status_code == 200, r.text
    if with_csv:
        r = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("meta.csv", b"filename,color\nimg_000.webp,red\n")},
        )
        assert r.status_code == 200, r.text
    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 200
    return upload_id


def _stub_committed_manifest(dataset_id: str) -> None:
    """Stand in for a bake the fake queue never actually runs, so a test can claim
    "this collection has already baked" without a real pipeline run — exactly as
    `test_add_layouts_unowned_ondisk_is_403_with_hint` does for the CLI-seeded case.
    Content is irrelevant; only existence is checked (`db.is_dataset`). Used to give
    the already-baked and never-baked variants of the same ambiguous-re-ingest
    scenario (review of PR #390, round 3) visibly different setups, even though the
    fix itself no longer branches on baked state — see `start_ingest`."""
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / dataset_id
    ds_dir.mkdir(parents=True, exist_ok=True)
    (ds_dir / "layout_manifest.json").write_text('{"dataset_version": 1}', encoding="utf-8")


def _read_owner(db_path: Path, dataset_id: str) -> str | None:
    async def _run() -> str | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return await appstate.get_dataset_owner(session, dataset_id)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    """Record `dataset_id -> owner` for an ALREADY-EXISTING user (the auth-fixture
    signup). The D-34 read model gates get_job on the job's dataset, so the get_job
    tests below seed alice as owner of the job's dataset to authorize her read."""

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _read_last_job_id(db_path: Path, dataset_id: str) -> str | None:
    async def _run() -> str | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                record = await appstate.get_dataset_record(session, dataset_id)
                return record.last_job_id if record is not None else None
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _read_source_upload_id(db_path: Path, dataset_id: str) -> str | None:
    """The bundle app-state records this dataset as having been built from (seam L1).
    None when it records none — which is every row that predates the column."""

    async def _run() -> str | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                record = await appstate.get_dataset_record(session, dataset_id)
                return record.source_upload_id if record is not None else None
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _seed_user_and_owner(db_path: Path, username: str, dataset_id: str) -> None:
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
                await appstate.record_dataset_owner(session, dataset_id, username)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _seed_user_with_malformed_source_upload_id(
    db_path: Path, username: str, dataset_id: str, malformed_id: str
) -> None:
    """Like `_seed_user_and_owner`, but also writes an INVALID `source_upload_id`
    (fails the upload-id charset) directly to app-state — unreachable through the
    API itself, since every writer validates an id via
    `routers/jobs.py::_resolve_finalized_bundle` before ever recording one. A
    defensive test still needs some way to construct such a row at all (review of
    PR #390, round 3, finding 5)."""

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
                await appstate.record_dataset_owner(session, dataset_id, username)
                await appstate.record_dataset_source_upload(
                    session, dataset_id, malformed_id
                )
        finally:
            await engine.dispose()

    asyncio.run(_run())


# --- uploads ---------------------------------------------------------------


def test_upload_roundtrip(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]

    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("img_000.webp", b"\x00aaa")},
    )
    assert r.status_code == 200
    assert r.json()["state"] == "open"

    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("img_001.webp", b"\x00bbbb")},
    )
    assert r.json() == {
        "upload_id": upload_id,
        "state": "open",
        "received_parts": 2,
        "bytes_received": 9,  # len(b"\x00aaa") + len(b"\x00bbbb") = 4 + 5
        "ignored": [],  # D-27: plain parts never skip anything (ZIP-only report)
        "already_present": False,  # Seam O2: not a re-send (a fresh store)
    }

    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 200

    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["state"] == "finalized"
    assert status["received_parts"] == 2

    # Parts landed inside the owner's jail under users/ (D-30), basenames preserved
    # (D-25 id order).
    images = (
        Path(os.environ["DATA_ROOT"]) / "users" / "alice" / "uploads" / upload_id / "images"
    )
    assert {p.name for p in images.iterdir()} == {"img_000.webp", "img_001.webp"}


def test_upload_part_after_finalize_is_409(client, auth) -> None:
    upload_id = _finalized_bundle(client, auth)
    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("late.webp", b"x")},
    )
    assert r.status_code == 409


def test_finalize_empty_bundle_is_400(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 400


def test_second_metadata_part_is_409(client, auth) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    ok = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("a.csv", b"x,y\n1,2\n")},
    )
    assert ok.status_code == 200
    dup = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("b.tsv", b"x\ty\n1\t2\n")},
    )
    assert dup.status_code == 409


def test_upload_id_jail_rejects_traversal() -> None:
    """A `..`/absolute/separator upload_id is refused before any filesystem touch
    (so nothing is ever written outside DATA_ROOT/users/{owner}/uploads/, D-30)."""
    from api.routers import uploads

    for bad in ("..", "../../etc", "/abs", "a/b", "a\\b", ""):
        with pytest.raises(HTTPException) as exc:
            uploads._upload_dir("alice", bad)
        assert 400 <= exc.value.status_code < 500


def test_part_filename_is_sanitized(client, auth) -> None:
    """A crafted multipart filename is reduced to its basename and jailed in
    images/ — it cannot escape to DATA_ROOT/users/{owner}/ (D-30)."""
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("../../evil.webp", b"x")},
    )
    assert r.status_code == 200

    owner_root = Path(os.environ["DATA_ROOT"]) / "users" / "alice"
    images = owner_root / "uploads" / upload_id / "images"
    assert [p.name for p in images.iterdir()] == ["evil.webp"]
    assert not (owner_root / "evil.webp").exists()
    assert not (Path(os.environ["DATA_ROOT"]) / "evil.webp").exists()


def test_upload_part_too_large_is_413(client, auth, monkeypatch) -> None:
    """A part exceeding MAX_UPLOAD_PART_BYTES is rejected (413) and the partial file
    is removed — an authenticated client cannot stream an unbounded body to disk."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]

    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("big.webp", b"0123456789")},  # 10 bytes > 8
    )
    assert r.status_code == 413
    images = (
        Path(os.environ["DATA_ROOT"]) / "users" / "alice" / "uploads" / upload_id / "images"
    )
    assert list(images.iterdir()) == []  # nothing left behind


# --- create_dataset --------------------------------------------------------


def test_create_dataset_images_only_records_owner_and_enqueues(client, auth, fake_queue, app_db) -> None:
    upload_id = _finalized_bundle(client, auth)

    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_new", "upload_id": upload_id},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"dataset_id": "ds_new", "job_id": "job-test-123"}

    # Owner recorded in app-state (not the manifest/tree).
    assert _read_owner(app_db, "ds_new") == "alice"

    # Exactly one enqueue: the dotted path + the primitive kwargs, images-only.
    assert len(fake_queue.calls) == 1
    func_string, kwargs = fake_queue.calls[0]
    assert func_string == "pipeline.worker.run_ingest_job"
    assert kwargs["dataset_id"] == "ds_new"
    assert kwargs["owner"] == "alice"
    assert kwargs["csv_path"] is None
    assert kwargs["column_roles"] is None
    assert kwargs["layout_types"] == ["grid"]
    # D-30: output_root is DATA_ROOT/datasets/ (the worker writes datasets/{ds_id}/),
    # disjoint from the upload jail under users/.
    assert kwargs["output_root"] == str(Path(os.environ["DATA_ROOT"]).resolve() / "datasets")
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{upload_id}/images"
    )


def test_create_records_the_bundle_the_dataset_was_built_from(
    client, auth, fake_queue, app_db
) -> None:
    """Seam L1: create ties the dataset to ITS bundle in app-state. Without this row
    nothing dataset-scoped exists to answer `GET .../columns` from, and the route fell
    back to whichever bundle the OWNER finalized last (review of PR #358, finding 1).
    A SECOND, later bundle is finalized afterwards to prove the recorded value is the
    one the dataset was created from and not simply the newest."""
    upload_id = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_src", "upload_id": upload_id}
    )
    assert r.status_code == 200, r.text

    newer = _finalized_bundle(client, auth)
    assert newer != upload_id
    assert _read_source_upload_id(app_db, "ds_src") == upload_id


def test_create_dataset_with_metadata_enqueues_csv_and_roles(client, auth, fake_queue) -> None:
    upload_id = _finalized_bundle(client, auth, with_csv=True)
    roles = {"filename": {"column": "filename", "label": "File"}}

    r = client.post(
        "/api/datasets",
        headers=auth,
        json={
            "dataset_id": "ds_meta",
            "upload_id": upload_id,
            "column_roles": roles,
            "layout_types": ["grid", "datetime"],
        },
    )
    assert r.status_code == 200, r.text

    _, kwargs = fake_queue.calls[0]
    assert kwargs["column_roles"] == roles  # passed through verbatim (pipeline validates)
    assert kwargs["csv_path"] is not None
    assert kwargs["csv_path"].replace("\\", "/").endswith(
        f"users/alice/uploads/{upload_id}/metadata.csv"
    )
    assert kwargs["layout_types"] == ["grid", "datetime"]


@pytest.mark.parametrize("with_csv", [True, False])
def test_create_dataset_metadata_mismatch_is_400(client, auth, fake_queue, with_csv) -> None:
    """A CSV without column_roles (or roles without a CSV) is rejected up front —
    not enqueued as a job doomed to fail at ingest."""
    upload_id = _finalized_bundle(client, auth, with_csv=with_csv)
    body = {"dataset_id": "ds_bad", "upload_id": upload_id}
    if not with_csv:
        body["column_roles"] = {"filename": {"column": "filename", "label": "f"}}

    r = client.post("/api/datasets", headers=auth, json=body)
    assert r.status_code == 400
    assert fake_queue.calls == []


def test_create_dataset_unfinalized_upload_is_404(client, auth, fake_queue) -> None:
    upload_id = client.post("/api/uploads", headers=auth).json()["upload_id"]
    client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("img.webp", b"x")},
    )  # uploaded but NOT finalized
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_x", "upload_id": upload_id},
    )
    assert r.status_code == 404
    assert fake_queue.calls == []


def test_create_dataset_foreign_owner_is_409(client, auth, fake_queue, app_db) -> None:
    _seed_user_and_owner(app_db, "bob", "ds_taken")
    upload_id = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_taken", "upload_id": upload_id},
    )
    assert r.status_code == 409
    assert fake_queue.calls == []


@pytest.mark.parametrize("bad_id", ["..", "."])
def test_create_dataset_traversal_id_rejected(client, auth, fake_queue, app_db, bad_id) -> None:
    """`.`/`..` pass the dataset_id charset regex but would escape DATA_ROOT once the
    worker writes {output_root}/{dataset_id}; create_dataset jails it (4xx, before any
    record/enqueue) — the API is the trust boundary for the server-set enqueue kwargs."""
    upload_id = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": bad_id, "upload_id": upload_id},
    )
    assert 400 <= r.status_code < 500
    assert _read_owner(app_db, bad_id) is None  # jailed before any owner record
    assert fake_queue.calls == []


def test_create_dataset_unowned_ondisk_is_409(client, auth, fake_queue) -> None:
    """A dataset that already exists on disk but has NO recorded owner cannot be
    adopted/overwritten by the first authenticated caller — writes are owner-only, so
    an unowned on-disk dataset is not first-come claimable."""
    data_root = Path(os.environ["DATA_ROOT"])
    seeded = data_root / "datasets" / "ds_seeded"  # D-30: dataset trees under datasets/
    seeded.mkdir(parents=True)
    # is_dataset only checks for the manifest file; a minimal one is enough here.
    (seeded / "layout_manifest.json").write_text('{"dataset_version": 1}', encoding="utf-8")

    upload_id = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_seeded", "upload_id": upload_id},
    )
    assert r.status_code == 409
    assert fake_queue.calls == []


def test_create_dataset_same_owner_ondisk_is_409(client, auth, fake_queue, app_db) -> None:
    """fix/reingest-safety: a create over an id that already exists ON DISK is refused
    with a 409 even for the SAME owner — web re-ingest is not supported (it used to
    fall through and SILENTLY overwrite via an auto version-bump). To replace a dataset
    the owner must delete it first or re-bake it with the CLI; nothing is enqueued."""
    # alice creates ds_own (records her as owner + enqueues); the worker then "commits"
    # a manifest on disk, so the dataset now exists on disk.
    upload_id = _finalized_bundle(client, auth)
    assert client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_own", "upload_id": upload_id}
    ).status_code == 200
    assert _read_owner(app_db, "ds_own") == "alice"
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / "ds_own"
    ds_dir.mkdir(parents=True, exist_ok=True)
    (ds_dir / "layout_manifest.json").write_text('{"dataset_version": 1}', encoding="utf-8")
    fake_queue.calls.clear()

    # A second create over the now-existing dataset — previously a silent re-ingest,
    # now a clean 409 with nothing enqueued.
    again = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_own", "upload_id": upload_id}
    )
    assert again.status_code == 409
    assert "already exists" in again.json()["detail"]
    assert fake_queue.calls == []


def _create_reads_job_state(monkeypatch, state: str) -> None:
    """Every job the datasets router looks up reads back as `state`. That router resolves
    job states with ONE `Job.fetch_many` (no live broker; the fake queue's connection has
    none), exactly as the DELETE tests patch it."""
    from api.routers import datasets as datasets_router

    monkeypatch.setattr(
        datasets_router.Job,
        "fetch_many",
        lambda job_ids, connection=None, serializer=None: [
            SimpleNamespace(get_status=lambda refresh=True: state) for _ in job_ids
        ],
    )


@pytest.mark.parametrize("state", ["queued", "started"])
def test_repeating_an_authored_create_while_its_bake_is_in_flight_is_409(
    client, auth, fake_queue, app_db, monkeypatch, state
) -> None:
    """[[T2-create-has-no-in-flight-job-guard-so-one-owner]]: the SAME owner repeats an
    authored create, from a newer bundle, while the first bake is still queued or
    running. No manifest exists yet, so the on-disk 409 cannot see it, and the owner is
    the same, so the owner-conflict 409 cannot either. It must meet the in-flight 409 the
    other write routes answer, with nothing enqueued and the recorded source bundle
    still the first one."""
    upload_id = _finalized_bundle(client, auth)
    first = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_twice", "upload_id": upload_id}
    )
    assert first.status_code == 200, first.text
    newer = _finalized_bundle(client, auth)
    _create_reads_job_state(monkeypatch, state)

    again = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_twice", "upload_id": newer}
    )

    assert again.status_code == 409, again.text
    assert again.json()["detail"] == "Another job for this collection is still running"
    assert len(fake_queue.calls) == 1
    assert _read_source_upload_id(app_db, "ds_twice") == upload_id


def test_repeating_an_authored_create_after_its_bake_failed_proceeds(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The guard is for a job IN FLIGHT only. Once the first bake has failed (no manifest,
    so the dataset lists as `error`), the same repeat is today's behaviour exactly: a
    retry over the id, re-enqueued, the newer bundle recorded."""
    upload_id = _finalized_bundle(client, auth)
    assert client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_twice", "upload_id": upload_id}
    ).status_code == 200
    newer = _finalized_bundle(client, auth)
    _create_reads_job_state(monkeypatch, "failed")

    again = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_twice", "upload_id": newer}
    )

    assert again.status_code == 200, again.text
    assert [kwargs["dataset_id"] for _, kwargs in fake_queue.calls] == ["ds_twice", "ds_twice"]
    assert _read_source_upload_id(app_db, "ds_twice") == newer


# --- D-30: disjoint-roots coexistence (forward) + jail integrity -----------


def _tree_snapshot(root: Path) -> dict[str, bytes]:
    """Map every file under `root` to its bytes (relative-path keyed) — the
    fixture for a 'byte-untouched' assertion across an operation."""
    return {
        str(p.relative_to(root)): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_dataset_id_equal_to_username_coexists_forward(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """D-30 seam acceptance (forward): user `alice` has an upload session, and a
    dataset whose id is ALSO `alice` is created, ingested, listed, and deleted with
    ZERO interference — the create-side username-collision 409 (PR24-2) is retired
    by disjoint roots. The dataset lands under datasets/alice; alice's uploads under
    users/alice/uploads/ are byte-untouched throughout; DELETE removes only the
    dataset dir. No name-based guard fires anywhere."""
    # The recorded job reads back as "finished" (the ingest completed), so DELETE's
    # in-flight check stands down without a live broker — mirrors test_addendum.
    from api.routers import datasets as datasets_router

    monkeypatch.setattr(
        datasets_router.Job,
        "fetch_many",
        lambda job_ids, connection=None, serializer=None: [
            SimpleNamespace(get_status=lambda refresh=True: "finished") for _ in job_ids
        ],
    )
    data_root = Path(os.environ["DATA_ROOT"])
    upload_id = _finalized_bundle(client, auth)  # alice's jail: users/alice/uploads/
    users_alice = data_root / "users" / "alice"
    before = _tree_snapshot(users_alice)
    assert before, "the upload bundle should have populated users/alice/uploads/"

    # create dataset 'alice' — previously a self-collision 409, now first-class.
    r = client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "alice", "upload_id": upload_id},
    )
    assert r.status_code == 200, r.text
    assert r.json()["dataset_id"] == "alice"
    assert _read_owner(app_db, "alice") == "alice"

    # The worker target is datasets/alice (output_root = DATA_ROOT/datasets/), NOT
    # the user's namespace; the upload jail is byte-identical after the create.
    _, kwargs = fake_queue.calls[0]
    assert kwargs["dataset_id"] == "alice"
    assert kwargs["output_root"] == str(data_root.resolve() / "datasets")
    assert _tree_snapshot(users_alice) == before

    # The worker "commits" a manifest under datasets/alice; READ then resolves it
    # (a `ready` summary, no RQ consult) and DELETE removes ONLY datasets/alice,
    # leaving the user's upload jail intact.
    ds_dir = data_root / "datasets" / "alice"
    ds_dir.mkdir(parents=True)
    # manifest_version "2.1" — the v2 contract the API serves (major 2); a "1.x"
    # manifest would now be refused by db.load_manifest's major guard.
    (ds_dir / "layout_manifest.json").write_text(
        '{"manifest_version": "2.1", "dataset_version": 1, '
        '"dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-01-01T00:00:00"}, '
        '"layouts": [{"layout_id": "grid"}]}',
        encoding="utf-8",
    )
    got = client.get("/api/datasets/alice", headers=auth)
    assert got.status_code == 200, got.text
    assert got.json()["status"] == "ready"

    assert client.delete("/api/datasets/alice", headers=auth).status_code == 204
    assert not ds_dir.exists()                      # dataset dir gone
    assert _tree_snapshot(users_alice) == before    # uploads untouched by the delete
    assert _read_owner(app_db, "alice") is None


def test_dataset_id_equal_to_other_users_name_is_first_class(
    client, auth, fake_queue, app_db
) -> None:
    """D-30: a dataset id equal to ANOTHER existing user's name (not the caller's)
    is now ordinary — the worker targets datasets/{name}, never that user's jail.
    This is the foreign-username half of the retired PR24-2 guard's coverage."""
    _seed_user_and_owner(app_db, "bob", "_bob_placeholder")  # 'bob' exists as a user
    upload_id = _finalized_bundle(client, auth)              # caller is alice
    r = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "bob", "upload_id": upload_id}
    )
    assert r.status_code == 200, r.text  # was 409 under the retired guard
    assert _read_owner(app_db, "bob") == "alice"
    _, kwargs = fake_queue.calls[0]
    assert kwargs["output_root"] == str(Path(os.environ["DATA_ROOT"]).resolve() / "datasets")


def test_jail_integrity_at_new_roots_traversal_rejected(client, auth, fake_queue, app_db) -> None:
    """D-30 re-anchored traversal guard: `..`/absolute in BOTH a ds_id (datasets
    root) and an upload_id (users root) still 4xx with nothing written outside the
    intended jail. The anchors moved; the rejection is exactly as strict."""
    data_root = Path(os.environ["DATA_ROOT"])
    # ds_id traversal — create_dataset jails before any side effect.
    upload_id = _finalized_bundle(client, auth)
    for bad in ("..", "."):
        r = client.post(
            "/api/datasets", headers=auth, json={"dataset_id": bad, "upload_id": upload_id}
        )
        assert 400 <= r.status_code < 500, bad
    assert fake_queue.calls == []

    # upload_id traversal — _upload_dir jails before any filesystem touch; nothing
    # is created at the DATA_ROOT top level or escapes the users root.
    from api.routers import uploads

    for bad in ("..", "../../etc", "/abs", "a/b", ""):
        with pytest.raises(HTTPException) as exc:
            uploads._upload_dir("alice", bad)
        assert 400 <= exc.value.status_code < 500, bad
    # The only top-level entries DATA_ROOT ever grows are the disjoint roots.
    assert {p.name for p in data_root.iterdir()} <= {"users", "datasets", "app-state"}


# --- D-xxviii (seam L6): the id is minted when the request authors none -------
#
# Every create test above sends an explicit `dataset_id` and passes UNCHANGED — that is
# the pin for "authored ids keep working". These cover the other half: a create with no
# id. Two of them need a collision with the next mint, so they pre-seed an AUTHORED id
# of the minted form: a real state, because an authored id may be any string the
# pattern admits, 12-character hex included.

# The minted form, as the interface catalogue states it: exactly 12 lowercase hex.
_MINTED_FORM = re.compile(r"[0-9a-f]{12}")
# An authored id that happens to have the minted form, and the next draw after it.
_TAKEN_HEX = "a1b2c3d4e5f6"
_FRESH_HEX = "0f1e2d3c4b5a"


def _script_the_random_source(monkeypatch, *draws: str) -> list[int]:
    """Replace the create router's random source — and only that module's reference to
    it — with one that returns `draws` in order, repeating the LAST one forever. Returns
    the `nbytes` of every draw, so a test can count them. One value therefore stands in
    for a broken source that returns the same id every time."""
    from api.routers import datasets as datasets_router

    pending = list(draws)
    calls: list[int] = []

    def token_hex(nbytes: int) -> str:
        calls.append(nbytes)
        return pending.pop(0) if len(pending) > 1 else pending[0]

    monkeypatch.setattr(datasets_router, "secrets", SimpleNamespace(token_hex=token_hex))
    return calls


def _seed_bobs_hex_collection(app_db: Path) -> Path:
    """Bob's collection under an AUTHORED id that has the minted form: an app-state row
    and a committed tree (manifest + presentation), as a finished bake leaves it."""
    _seed_user_and_owner(app_db, "bob", _TAKEN_HEX)
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / _TAKEN_HEX
    ds_dir.mkdir(parents=True)
    (ds_dir / "layout_manifest.json").write_text('{"dataset_version": 1}', encoding="utf-8")
    (ds_dir / "presentation.json").write_text(
        '{"dataset": {"display_name": "Bob\'s maps"}}', encoding="utf-8"
    )
    return ds_dir


@pytest.mark.parametrize("id_field", [{}, {"dataset_id": None}], ids=["absent", "null"])
def test_create_without_a_dataset_id_mints_one(
    client, auth, fake_queue, app_db, caplog, id_field
) -> None:
    """A create that authors no id gets one minted from the REAL random source, and
    every record the create makes is under that ONE id: the owner row, the job, the
    source bundle, the enqueue, the lock and the response. A leftover `body.dataset_id`
    after the mint would put None in one of them. The mint is logged AS a mint."""
    upload_id = _finalized_bundle(client, auth)
    with caplog.at_level(logging.INFO, logger="api.routers.datasets"):
        r = client.post(
            "/api/datasets", headers=auth, json={"upload_id": upload_id, **id_field}
        )

    assert r.status_code == 200, r.text
    minted = r.json()["dataset_id"]
    assert _MINTED_FORM.fullmatch(minted), minted
    assert r.json()["job_id"] == "job-test-123"
    assert _read_owner(app_db, minted) == "alice"
    assert _read_last_job_id(app_db, minted) == "job-test-123"
    assert _read_source_upload_id(app_db, minted) == upload_id
    [(_, kwargs)] = fake_queue.calls
    assert kwargs["dataset_id"] == minted
    # The upload lock FIRST, then the dataset lock — never the other way round.
    assert client.app.state.redis.locked_keys == [
        f"upload-create:alice/{upload_id}",
        f"dataset-mutate:{minted}",
    ]
    assert any(
        rec.levelno == logging.INFO and f"Minted dataset id {minted!r}" in rec.getMessage()
        for rec in caplog.records
    ), [rec.getMessage() for rec in caplog.records]


def test_two_creates_without_an_id_get_two_distinct_ids(
    client, auth, fake_queue, app_db
) -> None:
    """Two creates by the SAME owner, neither authoring an id, are two collections.
    Same owner on purpose: a mint that repeated itself would land the second create on
    the first collection's row. Two DIFFERENT uploads, because a repeat from ONE upload
    is refused before it mints at all
    (test_a_repeated_minted_create_from_one_upload_is_409_naming_the_first)."""
    upload_id = _finalized_bundle(client, auth)
    other = _finalized_bundle(client, auth)
    first = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})
    second = client.post("/api/datasets", headers=auth, json={"upload_id": other})

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    ids = [first.json()["dataset_id"], second.json()["dataset_id"]]
    assert ids[0] != ids[1]
    assert [kwargs["dataset_id"] for _, kwargs in fake_queue.calls] == ids
    assert [_read_owner(app_db, i) for i in ids] == ["alice", "alice"]


def test_a_mint_that_hits_an_existing_collection_re_mints(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The first draw is BOB's collection — an authored id of the minted form, with a
    row and a committed tree. The route re-mints and succeeds, and bob's collection is
    untouched: same owner, same bytes."""
    bobs_dir = _seed_bobs_hex_collection(app_db)
    before = _tree_snapshot(bobs_dir)
    upload_id = _finalized_bundle(client, auth)
    draws = _script_the_random_source(monkeypatch, _TAKEN_HEX, _FRESH_HEX)

    r = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert r.status_code == 200, r.text
    assert r.json()["dataset_id"] == _FRESH_HEX
    assert draws == [6, 6]  # one collision, one re-mint — 6 bytes = 12 hex characters
    assert _read_owner(app_db, _FRESH_HEX) == "alice"
    assert _read_owner(app_db, _TAKEN_HEX) == "bob"
    assert _tree_snapshot(bobs_dir) == before
    assert [kwargs["dataset_id"] for _, kwargs in fake_queue.calls] == [_FRESH_HEX]


def test_a_mint_that_hits_a_queued_create_re_mints(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The first draw is alice's OWN collection, created a moment ago under an authored
    hex id whose bake is still queued: an app-state row and NOTHING on disk yet (the
    worker creates the directory at commit). Only the app-state half of the check can
    see it, and nothing downstream would: the owner-conflict 409 is for a DIFFERENT
    owner and the on-disk 409 needs a manifest. So a mint that skipped app-state would
    hand alice back her own queued collection and enqueue a second bake onto it."""
    upload_id = _finalized_bundle(client, auth)
    queued = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": _TAKEN_HEX, "upload_id": upload_id}
    )
    assert queued.status_code == 200, queued.text
    assert not (Path(os.environ["DATA_ROOT"]) / "datasets" / _TAKEN_HEX).exists()
    newer = _finalized_bundle(client, auth)
    _script_the_random_source(monkeypatch, _TAKEN_HEX, _FRESH_HEX)

    r = client.post("/api/datasets", headers=auth, json={"upload_id": newer})

    assert r.status_code == 200, r.text
    assert r.json()["dataset_id"] == _FRESH_HEX
    assert _read_source_upload_id(app_db, _TAKEN_HEX) == upload_id  # the queued one's own
    assert _read_source_upload_id(app_db, _FRESH_HEX) == newer
    assert [kwargs["dataset_id"] for _, kwargs in fake_queue.calls] == [_TAKEN_HEX, _FRESH_HEX]


def test_a_mint_that_hits_a_bare_directory_re_mints(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The first draw names a directory on disk with NO app-state row and NO manifest.
    Production reaches this: a CLI bake (`pixscope ingest`) records no app-state row, and
    its commit (`worker._commit`) mkdirs the dataset directory, merge-moves the staged
    items into it and replaces the manifest LAST — so for the length of that commit the
    directory holds data and no manifest. Only the on-disk half of the check can see it:
    `db.is_dataset` keys on the manifest, so the route's own guard would let a create in."""
    bare = Path(os.environ["DATA_ROOT"]) / "datasets" / _TAKEN_HEX
    bare.mkdir(parents=True)
    (bare / "metadata.parquet").write_bytes(b"PAR1-mid-commit")
    before = _tree_snapshot(bare)
    upload_id = _finalized_bundle(client, auth)
    _script_the_random_source(monkeypatch, _TAKEN_HEX, _FRESH_HEX)

    r = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert r.status_code == 200, r.text
    assert r.json()["dataset_id"] == _FRESH_HEX
    assert _read_owner(app_db, _TAKEN_HEX) is None
    assert _tree_snapshot(bare) == before
    assert [kwargs["dataset_id"] for _, kwargs in fake_queue.calls] == [_FRESH_HEX]


def test_a_broken_random_source_fails_loudly_with_a_500(
    client, auth, fake_queue, app_db, monkeypatch, caplog
) -> None:
    """A source that returns one taken id every time is broken, and re-minting cannot
    fix it. The mint gives up after `_MINT_MAX_ATTEMPTS` draws with a 500 that names
    the cause, and an ERROR that names the limit for the operator — the one person who
    can act on it. Nothing is recorded or enqueued, no DATASET lock is taken (only the
    upload lock the mint runs under), and bob is untouched."""
    from api.routers import datasets as datasets_router

    bobs_dir = _seed_bobs_hex_collection(app_db)
    before = _tree_snapshot(bobs_dir)
    upload_id = _finalized_bundle(client, auth)
    draws = _script_the_random_source(monkeypatch, _TAKEN_HEX)

    with caplog.at_level(logging.ERROR, logger="api.routers.datasets"):
        r = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert r.status_code == 500, r.text
    assert "random source" in r.json()["detail"]
    assert len(draws) == datasets_router._MINT_MAX_ATTEMPTS
    errors = [rec.getMessage() for rec in caplog.records if rec.levelno == logging.ERROR]
    assert any("_MINT_MAX_ATTEMPTS" in m and _TAKEN_HEX in m for m in errors), errors
    assert fake_queue.calls == []
    assert client.app.state.redis.locked_keys == [f"upload-create:alice/{upload_id}"]
    assert _read_owner(app_db, _TAKEN_HEX) == "bob"
    assert _tree_snapshot(bobs_dir) == before


# --- a minted create is idempotent per upload --------------------------------
#
# [[T2-a-minted-create-is-not-idempotent-so-a-retried]]. A create that authors no id is
# refused with a structured 409 when its upload already backs one of the owner's
# collections, so a client whose first response was lost can adopt that collection
# instead of baking a second one. Settled by the operator: only MINTED creates (D1), the
# key is (owner, upload_id) against live rows (D2), a 409 naming the collection and its
# job (D3), and one upload-keyed lock around the whole minted sequence (D4). Every first
# collection here is produced THROUGH THE ROUTE, never by hand-building a row.


class _NumberingQueue(_FakeQueue):
    """A `_FakeQueue` that hands every enqueue its OWN job id (`job-1`, `job-2`, …), so
    a test can tell which create's job a response names."""

    def enqueue(self, func_string, kwargs=None, *, job_timeout=None):  # noqa: ANN001, ANN201
        super().enqueue(func_string, kwargs, job_timeout=job_timeout)
        return SimpleNamespace(id=f"job-{len(self.calls)}")


@pytest.fixture
def numbering_queue(client) -> _NumberingQueue:
    queue = _NumberingQueue()
    client.app.state.queue = queue
    return queue


def _alices_datasets(db_path: Path) -> list[str]:
    """Every dataset id app-state records for alice, in id order."""

    async def _run() -> list[str]:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                records = await appstate.list_dataset_records(session)
                return [r.dataset_id for r in records if r.owner == "alice"]
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _create_reads_job_as_expired(monkeypatch) -> None:
    """Every job the datasets router looks up is one RQ no longer holds: `fetch_many`
    yields None for it, exactly as it does once a job's result TTL has lapsed."""
    from api.routers import datasets as datasets_router

    monkeypatch.setattr(
        datasets_router.Job,
        "fetch_many",
        lambda job_ids, connection=None, serializer=None: [None for _ in job_ids],
    )


@pytest.mark.parametrize(
    ("state", "adoptable_job"),
    [
        ("queued", "job-1"),
        ("started", "job-1"),
        ("finished", None),
        ("failed", None),
        ("expired", None),
    ],
)
def test_a_repeated_minted_create_from_one_upload_is_409_naming_the_first(
    client, auth, numbering_queue, app_db, monkeypatch, state, adoptable_job
) -> None:
    """The lost-response retry: the first minted create succeeded, the client never saw
    its answer and sends the same create again. The repeat is refused BEFORE it mints,
    and its 409 names the first collection so the client can adopt it. One enqueue, one
    app-state row.

    It names the collection's JOB only while that job is queued or started (review of
    PR #373, operator finding 2). A job that finished or failed, or that RQ no longer
    holds (its result TTL lapsed), is null: adopting it would poll a job that answers 404
    or re-reports an old failure, and the client would show an error for a collection
    that exists."""
    upload_id = _finalized_bundle(client, auth)
    first = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})
    assert first.status_code == 200, first.text
    assert first.json()["job_id"] == "job-1"
    if state == "expired":
        _create_reads_job_as_expired(monkeypatch)
    else:
        _create_reads_job_state(monkeypatch, state)

    again = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert again.status_code == 409, again.text
    detail = again.json()["detail"]
    assert detail["code"] == "upload_already_created"
    assert detail["dataset_id"] == first.json()["dataset_id"]
    assert detail["job_id"] == adoptable_job
    assert len(numbering_queue.calls) == 1
    assert _alices_datasets(app_db) == [first.json()["dataset_id"]]


def test_an_authored_create_from_an_upload_that_backs_a_collection_still_succeeds(
    client, auth, numbering_queue, app_db
) -> None:
    """D1: the rule is for MINTED creates only. Building a second collection from one
    bundle on purpose stays possible through an authored id, exactly as before — and the
    authored create takes only its dataset lock, never the upload lock."""
    upload_id = _finalized_bundle(client, auth)
    first = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})
    assert first.status_code == 200, first.text

    authored = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_second", "upload_id": upload_id}
    )

    assert authored.status_code == 200, authored.text
    assert authored.json() == {"dataset_id": "ds_second", "job_id": "job-2"}
    assert len(numbering_queue.calls) == 2
    assert sorted(_alices_datasets(app_db)) == sorted([first.json()["dataset_id"], "ds_second"])
    assert client.app.state.redis.locked_keys[2:] == ["dataset-mutate:ds_second"]


def test_after_the_collection_is_deleted_a_minted_create_from_its_upload_succeeds(
    client, auth, numbering_queue, app_db, monkeypatch
) -> None:
    """D2: the key is matched against LIVE app-state rows. Deleting the collection
    removes its row, so its upload no longer backs anything and a minted create from it
    is an ordinary new collection with a new id."""
    upload_id = _finalized_bundle(client, auth)
    first = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})
    assert first.status_code == 200, first.text
    _create_reads_job_state(monkeypatch, "finished")  # DELETE's in-flight guard stands down
    assert client.delete(f"/api/datasets/{first.json()['dataset_id']}", headers=auth).status_code == 204

    again = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert again.status_code == 200, again.text
    assert again.json()["dataset_id"] != first.json()["dataset_id"]
    assert again.json()["job_id"] == "job-2"
    assert _alices_datasets(app_db) == [again.json()["dataset_id"]]


def test_a_minted_create_whose_upload_lock_is_unavailable_is_503(
    client, auth, fake_queue, app_db
) -> None:
    """The upload lock fails the way the dataset lock does: a clean 503 "dataset busy;
    try again", nothing minted into app-state and nothing enqueued."""
    upload_id = _finalized_bundle(client, auth)

    class _RefusingRedis:
        def lock(self, name, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
            return SimpleNamespace(acquire=lambda *a, **k: False, release=lambda *a, **k: None)

    client.app.state.redis = _RefusingRedis()
    r = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert r.status_code == 503, r.text
    assert r.json()["detail"] == "dataset busy; try again"
    assert fake_queue.calls == []
    assert _alices_datasets(app_db) == []


class _ExclusiveLock:
    """A redis-py-shaped lock that REALLY excludes: one `threading.Lock` per key, shared
    by every lock object for that key. An acquire that finds the key held sets
    `contended` before it blocks, so a test knows a second request is waiting on it."""

    def __init__(self, owner: _ExclusiveRedis, name: str) -> None:
        self._owner = owner
        self._lock = owner.locks.setdefault(name, threading.Lock())

    def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
        if self._lock.acquire(blocking=False):
            return True
        self._owner.contended.set()
        return self._lock.acquire(timeout=_RACE_WAIT_SECONDS)

    def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        self._lock.release()


class _ExclusiveRedis:
    def __init__(self) -> None:
        self.locks: dict[str, threading.Lock] = {}
        self.contended = threading.Event()

    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _ExclusiveLock(self, name)


# Every wait in the race test is bounded, so a regression FAILS it instead of hanging it.
_RACE_WAIT_SECONDS = 10


def test_a_minted_create_racing_the_first_from_one_upload_is_409(
    client, auth, app_db, monkeypatch
) -> None:
    """D4, the race the lock exists for. The first minted create is held just BEFORE it
    commits its row — after its lookup missed and it minted, before the key the lookup
    reads (`minted_from_upload_id`, committed with the row) exists — until the second
    create is observed WAITING on a lock. Only then does the first finish. The second
    must then meet the 409 naming the first, never mint a second row.

    Why this shape: two requests on one TestClient do run concurrently (each is a task
    on the client's portal loop; the lock acquire runs in the threadpool and the gate
    waits in one too, so neither stalls the loop), but WHEN they interleave is up to the
    scheduler. The gated row write pins the one interleaving that matters — the second
    arriving between the first's lookup and its key's commit — and the real exclusion of
    `_ExclusiveRedis` decides the outcome. Without the upload lock the second never
    contends: the first's gate times out while the second mints and enqueues, so the
    test fails on its counts rather than hanging. (Before the key moved ahead of the
    enqueue, the gate sat in the enqueue; there, the key is already committed, so it
    would no longer test the lock.)"""
    import asyncio as _asyncio

    redis = _ExclusiveRedis()
    client.app.state.redis = redis
    at_row_write = threading.Event()
    calls: list[str] = []
    real_record_owner = appstate.record_dataset_owner

    async def _gated_record_owner(session, dataset_id, owner, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if not at_row_write.is_set():
            at_row_write.set()
            await _asyncio.to_thread(redis.contended.wait, _RACE_WAIT_SECONDS)
        return await real_record_owner(session, dataset_id, owner, **kwargs)

    monkeypatch.setattr(appstate, "record_dataset_owner", _gated_record_owner)

    class _CountingQueue(_FakeQueue):
        def enqueue(self, func_string, kwargs=None, *, job_timeout=None):  # noqa: ANN001, ANN201
            calls.append((kwargs or {})["dataset_id"])
            return SimpleNamespace(id=f"job-{len(calls)}")

    client.app.state.queue = _CountingQueue()
    _create_reads_job_state(monkeypatch, "queued")  # the first bake has not started yet
    upload_id = _finalized_bundle(client, auth)
    responses: dict[str, object] = {}

    def _create(name: str) -> None:
        responses[name] = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    first = threading.Thread(target=_create, args=("first",))
    first.start()
    assert at_row_write.wait(timeout=_RACE_WAIT_SECONDS)
    second = threading.Thread(target=_create, args=("second",))
    second.start()
    first.join(timeout=3 * _RACE_WAIT_SECONDS)
    second.join(timeout=3 * _RACE_WAIT_SECONDS)

    assert not first.is_alive() and not second.is_alive()
    assert redis.contended.is_set()
    assert responses["first"].status_code == 200
    assert responses["second"].status_code == 409
    minted = responses["first"].json()["dataset_id"]
    assert responses["second"].json()["detail"]["dataset_id"] == minted
    assert responses["second"].json()["detail"]["job_id"] == "job-1"
    assert calls == [minted]
    assert _alices_datasets(app_db) == [minted]


class _SimulatedLocked(Exception):
    """Stands in for SQLite's `database is locked`, raised once its busy timeout lapses."""


def test_a_minted_create_that_fails_after_its_enqueue_is_refused_on_retry_not_duplicated(
    client, auth, numbering_queue, app_db, monkeypatch
) -> None:
    """Review of PR #373, FINDING 1. The key a retry looks up must be committed BEFORE the
    enqueue. Here the first app-state write AFTER the enqueue fails once — whichever write
    that is — as a `database is locked` past SQLite's busy timeout would: the bake is
    queued, the request 500s, and the client retries. The retry must find the queued
    collection and get the 409 (its `job_id` null, since the job was never recorded), and
    never mint a second row or a second bake. With the key written after the enqueue,
    the failed write left the row keyless, and the retry got a 200 and a second
    collection: the reviewer's probe answered `enqueues= ['669dab1ae882',
    '5d90b58c9f14']`."""
    upload_id = _finalized_bundle(client, auth)
    failed: list[str] = []

    def _fails_once_after_the_enqueue(real):  # noqa: ANN001, ANN202
        async def write(session, dataset_id, value):  # noqa: ANN001, ANN202
            if numbering_queue.calls and not failed:
                failed.append(real.__name__)
                raise _SimulatedLocked("database is locked")
            return await real(session, dataset_id, value)

        return write

    for name in ("record_dataset_job", "record_dataset_source_upload"):
        monkeypatch.setattr(appstate, name, _fails_once_after_the_enqueue(getattr(appstate, name)))

    with pytest.raises(_SimulatedLocked):
        client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})
    assert len(failed) == 1, "the injected failure fired, after the enqueue"
    [(_, queued)] = numbering_queue.calls
    assert _alices_datasets(app_db) == [queued["dataset_id"]]

    again = client.post("/api/datasets", headers=auth, json={"upload_id": upload_id})

    assert again.status_code == 409, again.text
    assert again.json()["detail"]["dataset_id"] == queued["dataset_id"]
    assert again.json()["detail"]["job_id"] is None
    assert len(numbering_queue.calls) == 1
    assert _alices_datasets(app_db) == [queued["dataset_id"]]


def _lookup_minted_from(db_path: Path, owner: str, upload_id: str) -> str | None:
    """The dataset id `appstate.get_dataset_record_minted_from_upload` answers, or None."""

    async def _run() -> str | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                record = await appstate.get_dataset_record_minted_from_upload(
                    session, owner, upload_id
                )
                return record.dataset_id if record is not None else None
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def test_the_idempotency_key_is_scoped_to_the_owner(
    client, auth, numbering_queue, app_db
) -> None:
    """Review of PR #373, FINDING 2 (owner). The key is (owner, upload_id): another owner's
    collection built from an upload with the same id is never the caller's, and a 409
    naming it would disclose its id. Pinned at the lookup, over rows both owners made
    THROUGH THE ROUTE, because the route cannot reach the cross-owner case: upload ids are
    server-minted uuid4 hex (`uploads.create_upload`), so two owners never share one."""
    bob_signup = {"username": "bob", "email": "bob@example.com", "password": "s3cretpw"}
    assert client.post("/api/auth/signup", json=bob_signup).status_code == 200
    token = client.post(
        "/api/auth/login", json={"username": "bob", "password": "s3cretpw"}
    ).json()["access_token"]
    bob = {"Authorization": f"Bearer {token}"}
    bobs_upload = _finalized_bundle(client, bob)
    bobs = client.post("/api/datasets", headers=bob, json={"upload_id": bobs_upload})
    assert bobs.status_code == 200, bobs.text
    alices_upload = _finalized_bundle(client, auth)
    alices = client.post("/api/datasets", headers=auth, json={"upload_id": alices_upload})
    assert alices.status_code == 200, alices.text

    assert _lookup_minted_from(app_db, "alice", bobs_upload) is None
    assert _lookup_minted_from(app_db, "bob", alices_upload) is None
    assert _lookup_minted_from(app_db, "bob", bobs_upload) == bobs.json()["dataset_id"]
    assert _lookup_minted_from(app_db, "alice", alices_upload) == alices.json()["dataset_id"]


def _backdate(db_path: Path, dataset_id: str, *, seconds: int) -> None:
    """Move one row's `created_at` back by `seconds`. `created_at` is SQLite's
    CURRENT_TIMESTAMP (`server_default=func.now()`), which has WHOLE-SECOND resolution
    (measured: `select current_timestamp` → '2026-09-22 11:42:36'), so two creates in one
    test land on the same tick and cannot be told apart by it."""
    from sqlalchemy import text

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await session.execute(
                    text(
                        "UPDATE datasets SET created_at = datetime(created_at, :shift) "
                        "WHERE dataset_id = :dataset_id"
                    ),
                    {"shift": f"-{seconds} seconds", "dataset_id": dataset_id},
                )
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(_run())


# Two minted-form ids: the OLDER row gets the one that sorts LATER, so the id tie-break
# and the age order disagree and only `created_at` can make the oldest one win.
_LATE_SORTING_HEX = "f0f0f0f0f0f0"
_EARLY_SORTING_HEX = "0a0a0a0a0a0a"


def test_the_lookup_returns_the_oldest_row_minted_from_the_upload(
    client, auth, app_db
) -> None:
    """Review of PR #373, FINDING 2 (oldest). Two rows can carry one (owner, upload) key
    only if the upload lock lapsed (30 s) before the first create committed its row — the
    second then misses the lookup and mints too. The route cannot be driven into that
    here without a real lock expiry, so the two rows are written by the REAL writer
    (`record_dataset_owner(..., minted_from_upload_id=)`, which the minted create calls)
    and the lookup must answer the OLDER one. It is an hour older and its id sorts
    later, so neither "newest first" nor "lowest id first" gives the same answer."""

    async def _two_rows_minted_from(upload_id: str) -> None:
        engine, sessionmaker = await appstate.setup_appstate(app_db)
        try:
            async with sessionmaker() as session:
                for dataset_id in (_LATE_SORTING_HEX, _EARLY_SORTING_HEX):
                    await appstate.record_dataset_owner(
                        session, dataset_id, "alice", minted_from_upload_id=upload_id
                    )
        finally:
            await engine.dispose()

    asyncio.run(_two_rows_minted_from("up_shared"))
    _backdate(app_db, _LATE_SORTING_HEX, seconds=3600)

    assert _lookup_minted_from(app_db, "alice", "up_shared") == _LATE_SORTING_HEX


@pytest.mark.parametrize("first_create", ["authored", "minted"])
def test_a_minted_create_from_an_upload_only_REINGESTED_into_a_collection_makes_a_new_one(
    client, auth, numbering_queue, app_db, monkeypatch, first_create
) -> None:
    """Review of PR #373, OPERATOR FINDING 1 — the operator's scenario. Collection A is
    created from upload X, then RE-INGESTED from upload Y, which records Y as A's
    `source_upload_id`. A minted create from Y is a NEW collection: A was never minted
    from Y, so the idempotency key must not match it. Keyed on `source_upload_id`, the
    create answered 409 naming A, and the wizard silently adopted A's re-ingest job.
    A is untouched: its job and its recorded bundle are the re-ingest's."""
    x = _finalized_bundle(client, auth)
    body = {"dataset_id": "ds_a", "upload_id": x} if first_create == "authored" else {"upload_id": x}
    created = client.post("/api/datasets", headers=auth, json=body)
    assert created.status_code == 200, created.text
    a = created.json()["dataset_id"]
    _job_finished(monkeypatch)  # the re-ingest's in-flight guard stands down
    y = _finalized_bundle(client, auth)
    reingested = client.post(f"/api/datasets/{a}/ingest", headers=auth, json={"upload_id": y})
    assert reingested.status_code == 200, reingested.text
    assert _read_source_upload_id(app_db, a) == y

    fresh = client.post("/api/datasets", headers=auth, json={"upload_id": y})

    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["dataset_id"] != a
    assert len(numbering_queue.calls) == 3
    assert sorted(_alices_datasets(app_db)) == sorted([a, fresh.json()["dataset_id"]])
    assert _read_last_job_id(app_db, a) == "job-2"  # still the re-ingest's
    assert _read_source_upload_id(app_db, a) == y


def test_an_authored_create_then_a_minted_create_from_one_upload_makes_two(
    client, auth, numbering_queue, app_db
) -> None:
    """D1 against the key: an AUTHORED create never sets `minted_from_upload_id`, so a
    later minted create from the same upload is a new collection, not a 409 naming the
    authored one. (The reverse order is
    test_an_authored_create_from_an_upload_that_backs_a_collection_still_succeeds.)"""
    y = _finalized_bundle(client, auth)
    authored = client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_y", "upload_id": y}
    )
    assert authored.status_code == 200, authored.text

    minted = client.post("/api/datasets", headers=auth, json={"upload_id": y})

    assert minted.status_code == 200, minted.text
    assert minted.json()["dataset_id"] != "ds_y"
    assert len(numbering_queue.calls) == 2
    assert sorted(_alices_datasets(app_db)) == sorted(["ds_y", minted.json()["dataset_id"]])


# --- start_ingest (re-ingest) ----------------------------------------------


def test_start_ingest_reingest_is_images_only(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    # alice creates ds_re (records owner), then re-ingests a new bundle once that
    # create's bake has finished (a re-ingest over a running one is a 409).
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_re", "upload_id": first})
    _job_finished(monkeypatch)
    fake_queue.calls.clear()

    second = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_re/ingest",
        headers=auth,
        json={"upload_id": second, "layout_types": ["grid"]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"job_id": "job-test-123"}

    func_string, kwargs = fake_queue.calls[0]
    assert func_string == "pipeline.worker.run_ingest_job"
    assert kwargs["dataset_id"] == "ds_re"
    assert kwargs["owner"] == "alice"
    assert kwargs["csv_path"] is None and kwargs["column_roles"] is None
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{second}/images"
    )
    # T2-46: the opt-out defaults to "bake" when the request omits it (behaviour
    # unchanged for callers that never learned about the field).
    assert kwargs["detail_tier"] == "bake"


def test_reingest_replaces_the_recorded_source_bundle(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """Seam L1: re-ingest rebuilds the whole dataset from the bundle it resolves, so it
    REPLACES the recorded source. Pinned in both halves — the recorded id is the first
    bundle after create, and the second bundle after the re-ingest — so a route that
    simply never wrote it would fail the second assertion."""
    first = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_rs", "upload_id": first}
    )
    assert _read_source_upload_id(app_db, "ds_rs") == first
    _job_finished(monkeypatch)  # the create's bake ended; re-ingest over it is allowed

    second = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_rs/ingest", headers=auth, json={"upload_id": second}
    )
    assert r.status_code == 200, r.text
    assert _read_source_upload_id(app_db, "ds_rs") == second


def test_unnamed_reingest_when_recorded_equals_latest_proceeds_unchanged(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """Review of PR #390, round 3, finding 1 (isolated to `start_ingest` alone; the
    full reproduction ending in an `add_layouts` call is the next test below). alice
    creates `ds_same` from `u1` and never uploads anything else: `u1` is STILL her
    latest finalized bundle when she re-ingests unnamed, so the record and the
    resolved bundle AGREE — proceed, and leave the record exactly as it was. Round
    2's own fix got this wrong: it CLEARED the record here regardless of agreement,
    which erased a still-accurate fact for no reason and reopened this item's
    original defect the moment the owner uploaded anything else."""
    first = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_same", "upload_id": first}
    )
    assert _read_source_upload_id(app_db, "ds_same") == first
    _job_finished(monkeypatch)  # the create's bake ended; re-ingest over it is allowed
    fake_queue.calls.clear()

    r = client.post("/api/datasets/ds_same/ingest", headers=auth, json={})
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{first}/images"
    )
    assert _read_source_upload_id(app_db, "ds_same") == first  # unchanged, not cleared


def test_add_layouts_after_an_unambiguous_unnamed_reingest_still_resolves_its_own_bundle(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """Review of PR #390, round 3, finding 1's full reproduction: alice creates
    `ds_A` from `u1` (recorded). She re-ingests `ds_A` unnamed — `u1` is STILL her
    latest, so the record and the resolved bundle agree, the rebuild proceeds, and
    the record stays `u1` (see the test above). She THEN finalizes `u2` and creates
    an UNRELATED `ds_B` from it. A designer bake on `ds_A` (unnamed `add_layouts`)
    must still resolve `u1` — `ds_A`'s own recorded bundle — never `u2`, which is now
    the owner's latest but describes a DIFFERENT collection. Round 2's fix would have
    cleared `ds_A`'s record during the re-ingest step above, so this add-layouts call
    would have fallen back to `_latest_finalized_bundle` and resolved `u2` instead —
    the exact defect this item exists to fix, reached through a re-ingest that
    changed NOTHING."""
    u1 = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_A", "upload_id": u1}
    )
    _job_finished(monkeypatch)  # ds_A's create bake ended

    r = client.post("/api/datasets/ds_A/ingest", headers=auth, json={})
    assert r.status_code == 200, r.text  # unambiguous: u1 is still latest
    assert _read_source_upload_id(app_db, "ds_A") == u1
    _job_finished(monkeypatch)  # ds_A's re-ingest bake ended

    u2 = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_B", "upload_id": u2}
    )
    fake_queue.calls.clear()

    r = client.post(
        "/api/datasets/ds_A/layouts", headers=auth, json={"layout_specs": ["datetime"]}
    )
    assert r.status_code == 200, r.text
    assert len(fake_queue.calls) == 1
    _, kwargs = fake_queue.calls[0]
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{u1}/images"
    )


def test_add_layouts_leaves_the_recorded_source_bundle_alone(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The contrast that makes the re-ingest rule a rule: add-layouts resolves a bundle
    too, but only to re-read the ORIGINAL images for the pipeline's id-integrity guard.
    It changes no source, so it records nothing — even when it runs against a bundle
    that is not the dataset's own."""
    first = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_al2", "upload_id": first}
    )
    _job_finished(monkeypatch)

    other = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_al2/layouts",
        headers=auth,
        json={"layout_specs": ["grid"], "upload_id": other},
    )
    assert r.status_code == 200, r.text
    assert _read_source_upload_id(app_db, "ds_al2") == first


def test_start_ingest_passes_detail_tier_skip(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The optional detail_tier request field is threaded through the enqueue to the
    worker verbatim (T2-46) — "skip" reaches run_ingest_job's kwargs."""
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_skip", "upload_id": first})
    _job_finished(monkeypatch)  # the create's bake ended; re-ingest over it is allowed
    fake_queue.calls.clear()

    second = _finalized_bundle(client, auth)
    r = client.post(
        "/api/datasets/ds_skip/ingest",
        headers=auth,
        json={"upload_id": second, "detail_tier": "skip"},
    )
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["detail_tier"] == "skip"


def test_start_ingest_unnamed_ambiguous_already_baked_is_409(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """Review of PR #390, round 3, findings 1+2: an ALREADY-BAKED collection whose
    recorded source DIFFERS from the owner's latest finalized upload is AMBIGUOUS —
    409, naming both, never a silent rebuild from `latest` (`main`'s own defect) and
    never a clear (round 2's regression). This is the scenario
    `test_start_ingest_defaults_to_latest_bundle` used to assert succeeded with 200;
    it is deliberately repurposed here because that outcome is exactly the ambiguity
    this fix now refuses — see `test_start_ingest_nothing_recorded_resolves_latest_
    unchanged` below for the "defaults to latest" case that is STILL true, the one
    where nothing is recorded at all."""
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_l", "upload_id": first})
    _job_finished(monkeypatch)  # the create's bake ended; re-ingest over it is allowed
    _stub_committed_manifest("ds_l")  # the create's bake, standing in for the real one
    fake_queue.calls.clear()
    latest = _finalized_bundle(client, auth)  # most recently finalized; differs from `first`

    r = client.post("/api/datasets/ds_l/ingest", headers=auth, json={})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert first in detail
    assert latest in detail
    assert fake_queue.calls == []
    assert _read_source_upload_id(app_db, "ds_l") == first  # refused, so unchanged


def test_start_ingest_nothing_recorded_resolves_latest_unchanged(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """A row that predates seam L1 (or a CLI-seeded dataset later assigned an owner)
    records no `source_upload_id`: nothing ties it to any one upload, so an unnamed
    re-ingest keeps today's behaviour exactly — the owner's latest finalized bundle —
    unaffected by the ambiguity check, which never fires when there is nothing to
    compare against."""
    _seed_user_and_owner(app_db, "erin", "ds_predates_l1_reingest")
    token = client.post(
        "/api/auth/login", json={"username": "erin", "password": "s3cretpw"}
    ).json()["access_token"]
    erin_auth = {"Authorization": f"Bearer {token}"}
    assert _read_source_upload_id(app_db, "ds_predates_l1_reingest") is None

    _finalized_bundle(client, erin_auth)  # an older bundle, never named or recorded
    latest = _finalized_bundle(client, erin_auth)

    r = client.post(
        "/api/datasets/ds_predates_l1_reingest/ingest", headers=erin_auth, json={}
    )
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/erin/uploads/{latest}/images"
    )
    assert _read_source_upload_id(app_db, "ds_predates_l1_reingest") is None  # still none


def test_start_ingest_requires_ownership(client, auth, fake_queue, app_db) -> None:
    _seed_user_and_owner(app_db, "bob", "ds_bob")
    upload_id = _finalized_bundle(client, auth)

    forbidden = client.post(
        "/api/datasets/ds_bob/ingest", headers=auth, json={"upload_id": upload_id}
    )
    assert forbidden.status_code == 403  # exists, owned by bob

    missing = client.post(
        "/api/datasets/ds_missing/ingest", headers=auth, json={"upload_id": upload_id}
    )
    assert missing.status_code == 404  # no owner record

    assert fake_queue.calls == []


def test_start_ingest_empty_upload_id_is_400(client, auth, fake_queue, app_db) -> None:
    """An explicit empty upload_id is rejected up front (400). Regression for the
    jobs.py validator that previously diverged from uploads.py by ACCEPTING ""."""
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_e", "upload_id": first})
    fake_queue.calls.clear()

    r = client.post("/api/datasets/ds_e/ingest", headers=auth, json={"upload_id": ""})
    assert r.status_code == 400
    assert fake_queue.calls == []


# --- add_layouts (POST /api/datasets/{ds_id}/layouts, T2-58) ----------------


def _owned_dataset_with_bundle(client, auth) -> str:
    """create ds_al from `first` (records alice as owner AND `source_upload_id`)
    + leave a SECOND, newer finalized bundle in alice's jail that ds_al never
    recorded. Returns `first` — ds_al's own recorded bundle, and add-layouts'
    EXPECTED default source (seam L1;
    [[T2-a-designer-bake-sources-images-from-the-owner-s]]). The newer, untracked
    bundle exists precisely so a test using this fixture would catch a regression
    to the old "owner's latest upload" default."""
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_al", "upload_id": first})
    _finalized_bundle(client, auth)  # newer, NOT recorded by ds_al — a decoy
    return first


def _job_finished(monkeypatch) -> None:
    """Make the add-layouts / re-ingest 409-while-running guard see the dataset's last
    recorded job (the create's) as NOT in flight, so the happy path proceeds. Mirrors the
    DELETE tests' Job.fetch_many patch (no live broker; the fake queue's connection
    has no hgetall)."""
    from api.routers import jobs as jobs_router

    monkeypatch.setattr(
        jobs_router.Job,
        "fetch",
        lambda job_id, connection=None: SimpleNamespace(get_status=lambda: "finished"),
    )


def test_add_layouts_enqueues_with_specs_and_records_job(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """Happy path: owner adds layouts → enqueues the add-layouts dotted path with the
    exact primitive kwargs (specs + images from ds_al's OWN recorded bundle — never a
    newer bundle the owner also happens to have, seam L1 — + owner) and records the
    NEW job id on the dataset row (D-28)."""
    own_bundle = _owned_dataset_with_bundle(client, auth)
    _job_finished(monkeypatch)  # last job not in flight → 409 guard stands down
    fake_queue.calls.clear()

    r = client.post(
        "/api/datasets/ds_al/layouts",
        headers=auth,
        json={"layout_specs": ["datetime", "categorical"]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"job_id": "job-test-123"}

    assert len(fake_queue.calls) == 1
    func_string, kwargs = fake_queue.calls[0]
    assert func_string == "pipeline.worker.run_add_layouts_job"
    assert kwargs["dataset_id"] == "ds_al"
    assert kwargs["owner"] == "alice"
    assert kwargs["layout_specs"] == ["datetime", "categorical"]
    assert kwargs["column_roles"] is None
    assert kwargs["output_root"] == str(Path(os.environ["DATA_ROOT"]).resolve() / "datasets")
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{own_bundle}/images"
    )
    # D-28: the started job is recorded on the dataset row (drives status + the
    # delete/add-layouts-while-running 409).
    assert _read_last_job_id(app_db, "ds_al") == "job-test-123"


def test_add_layouts_forwards_column_roles_and_upload_id(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The optional roles override AND an explicit upload_id are forwarded verbatim
    (the pipeline validates roles; the bundle is resolved from the given upload)."""
    _owned_dataset_with_bundle(client, auth)
    _job_finished(monkeypatch)
    pinned = _finalized_bundle(client, auth)  # an explicit, specific bundle
    fake_queue.calls.clear()
    roles = {"filename": {"column": "filename", "label": "File"}}

    r = client.post(
        "/api/datasets/ds_al/layouts",
        headers=auth,
        json={"layout_specs": ["categorical"], "column_roles": roles, "upload_id": pinned},
    )
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["column_roles"] == roles
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{pinned}/images"
    )


def test_add_layouts_empty_specs_is_422(client, auth, fake_queue, app_db) -> None:
    """An empty layout_specs list fails request validation (min_length=1) — 422,
    never enqueued."""
    _owned_dataset_with_bundle(client, auth)
    fake_queue.calls.clear()

    r = client.post("/api/datasets/ds_al/layouts", headers=auth, json={"layout_specs": []})
    assert r.status_code == 422
    assert fake_queue.calls == []


def test_add_layouts_requires_ownership(client, auth, fake_queue, app_db) -> None:
    """Foreign owner → 403 'Not the dataset owner'; unknown (no owner, not on disk) →
    404. Never enqueues either way."""
    _seed_user_and_owner(app_db, "bob", "ds_bob")
    _finalized_bundle(client, auth)  # alice has a bundle, but does not own ds_bob

    forbidden = client.post(
        "/api/datasets/ds_bob/layouts", headers=auth, json={"layout_specs": ["grid"]}
    )
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"] == "Not the dataset owner"

    missing = client.post(
        "/api/datasets/ds_ghost/layouts", headers=auth, json={"layout_specs": ["grid"]}
    )
    assert missing.status_code == 404

    assert fake_queue.calls == []


def test_add_layouts_unowned_ondisk_is_403_with_hint(client, auth, fake_queue) -> None:
    """A CLI-seeded dataset (on disk, no app-state owner) is not web-adoptable: 403
    pointing at the server assign-owner command (T2-65), never enqueued."""
    data_root = Path(os.environ["DATA_ROOT"])
    seeded = data_root / "datasets" / "ds_cli"
    seeded.mkdir(parents=True)
    (seeded / "layout_manifest.json").write_text('{"dataset_version": 1}', encoding="utf-8")

    r = client.post(
        "/api/datasets/ds_cli/layouts", headers=auth, json={"layout_specs": ["datetime"]}
    )
    assert r.status_code == 403
    assert "python -m api.admin assign-owner ds_cli" in r.json()["detail"]
    assert fake_queue.calls == []


def test_add_layouts_no_finalized_bundle_is_409(client, auth, fake_queue, app_db) -> None:
    """Owner has NO finalized upload bundle (e.g. the dataset was CLI-seeded then
    assigned): add-layouts needs the original images, so it answers 409 with actionable
    guidance — NOT a bare upload 404 or a 500 — and never enqueues."""
    # 'carol' owns ds_noimg but has no upload jail/bundle at all. Seed her (with the
    # standard test password) and authenticate AS carol — alice's fixture bundle must
    # not satisfy carol's lookup, so the missing-bundle path is exercised for the OWNER.
    _seed_user_and_owner(app_db, "carol", "ds_noimg")
    token = client.post(
        "/api/auth/login", json={"username": "carol", "password": "s3cretpw"}
    ).json()["access_token"]
    carol_auth = {"Authorization": f"Bearer {token}"}

    r = client.post(
        "/api/datasets/ds_noimg/layouts", headers=carol_auth, json={"layout_specs": ["grid"]}
    )
    assert r.status_code == 409
    assert "original source images" in r.json()["detail"]
    assert fake_queue.calls == []


def test_add_layouts_older_collection_resolves_its_own_recorded_bundle(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """The exact regression [[T2-a-designer-bake-sources-images-from-the-owner-s]]
    files: once an owner has a SECOND upload backing a SECOND collection, add-layouts
    on the OLDER collection must resolve ITS OWN recorded bundle — never the owner's
    newest, whatever collection that belongs to. The designer's `addLayouts` never
    sends `upload_id` (the client cannot know one), so this is the path every
    designer bake takes."""
    older_bundle = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_older", "upload_id": older_bundle},
    )
    _job_finished(monkeypatch)

    # alice's SECOND collection, from her SECOND (newer) upload — the exact shape
    # the backlog item describes ("once an owner has a second upload").
    newer_bundle = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets",
        headers=auth,
        json={"dataset_id": "ds_newer", "upload_id": newer_bundle},
    )
    _job_finished(monkeypatch)
    fake_queue.calls.clear()

    r = client.post(
        "/api/datasets/ds_older/layouts", headers=auth, json={"layout_specs": ["datetime"]}
    )
    assert r.status_code == 200, r.text
    assert len(fake_queue.calls) == 1
    _, kwargs = fake_queue.calls[0]
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{older_bundle}/images"
    )


def test_add_layouts_recorded_bundle_unresolvable_is_409_and_never_falls_back_to_newest(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """Recorded, but not resolvable in this owner's jail (swept, or removed by hand):
    a DEDICATED 409 naming the missing upload — never a silent fall-back to the
    owner's newer bundle, which is the defect
    [[T2-a-designer-bake-sources-images-from-the-owner-s]] exists to fix, just reached
    through a narrower door. The job must never be enqueued.

    The message states only what is known and names the LOSSLESS way back (review
    of PR #390, findings F3+F4, corrected again in round 4 finding 1): NOT "may
    have been cleaned up" (a guess this test does not simulate the cause of — the
    bundle really is just gone here, but the route cannot and must not claim to
    know that), and NOT "name that upload explicitly" (the designer has no
    `upload_id` field to do that with) — but ALSO not "re-ingest naming an
    upload_id" (round 4's own correction: re-ingest is images-only and
    `layout_types` defaults to `["grid"]`, so that advice would have discarded
    this collection's metadata and every non-grid layout). The actual remedy is an
    explicit `upload_id` on a RETRY of add-layouts itself — lossless, since
    `run_add_layouts` never touches committed metadata or other layouts — and the
    message says so, and says not to re-ingest."""
    first = _finalized_bundle(client, auth)
    client.post(
        "/api/datasets", headers=auth, json={"dataset_id": "ds_swept", "upload_id": first}
    )
    _job_finished(monkeypatch)

    # A newer bundle exists too — if the route silently fell back to "latest" here,
    # this test would still see a 200 (never a 404/409), and the images_dir assertion
    # below is what would then catch the wrong bundle.
    _finalized_bundle(client, auth)

    # Simulate `first` having been cleaned up after ds_swept's bake already committed
    # (today nothing automated sweeps a FINALIZED bundle — uploads.py's
    # `_sweep_stale_sessions` explicitly never reaps one — but an operator can still
    # remove one by hand, and this is where any future sweep would show up too; a
    # reassigned owner is the other real cause, covered by the message wording alone).
    data_root = Path(os.environ["DATA_ROOT"])
    shutil.rmtree(data_root / "users" / "alice" / "uploads" / first)

    fake_queue.calls.clear()
    r = client.post(
        "/api/datasets/ds_swept/layouts", headers=auth, json={"layout_specs": ["datetime"]}
    )
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert first in detail
    assert "is not in this owner's uploads" in detail
    # Names the LOSSLESS remedy (an explicit upload_id retry on add-layouts
    # itself) and explicitly warns against the destructive one (round 4 finding
    # 1) — not just "does it mention re-ingest at all", which would pass even
    # with the rejected advice still in place.
    assert "add layouts again naming an upload_id" in detail.lower()
    assert "do not re-ingest" in detail.lower()
    assert "images-only and grid-only" in detail
    assert "pixscope add-layouts" in detail
    # Neither of the two round-2/round-3 rejected phrasings survives either.
    assert "cleaned up" not in detail
    assert "name that upload explicitly" not in detail.lower()
    assert fake_queue.calls == []


def test_add_layouts_malformed_recorded_id_is_the_dedicated_409_not_400(
    client, fake_queue, app_db
) -> None:
    """Review of PR #390, round 3, finding 5: a recorded `source_upload_id` that
    fails the upload-id charset should be unreachable in practice — every writer
    validates first — but add-layouts must not surface a bare 400 "Invalid
    upload_id" on a request that named no `upload_id` at all if a row is ever
    corrupted this way. Treated the SAME as a genuinely-unresolvable bundle
    (`db.resolve_recorded_bundle` returns None either way): the dedicated 409, not a
    400, and never a silent fall-back to the owner's latest."""
    _seed_user_with_malformed_source_upload_id(
        app_db, "frank", "ds_malformed", "../etc/passwd"
    )
    token = client.post(
        "/api/auth/login", json={"username": "frank", "password": "s3cretpw"}
    ).json()["access_token"]
    frank_auth = {"Authorization": f"Bearer {token}"}

    r = client.post(
        "/api/datasets/ds_malformed/layouts",
        headers=frank_auth,
        json={"layout_specs": ["grid"]},
    )
    assert r.status_code == 409, r.text
    assert "is not in this owner's uploads" in r.json()["detail"]
    assert fake_queue.calls == []


def test_add_layouts_unrecorded_bundle_resolves_latest_unchanged(
    client, auth, fake_queue, app_db, monkeypatch
) -> None:
    """A row that predates seam L1 (or a CLI-seeded dataset later assigned an owner)
    records no `source_upload_id`: nothing ties it to any one upload, so add-layouts
    keeps today's behaviour exactly — the owner's latest finalized bundle."""
    _seed_user_and_owner(app_db, "dave", "ds_predates_l1")
    token = client.post(
        "/api/auth/login", json={"username": "dave", "password": "s3cretpw"}
    ).json()["access_token"]
    dave_auth = {"Authorization": f"Bearer {token}"}
    assert _read_source_upload_id(app_db, "ds_predates_l1") is None

    _finalized_bundle(client, dave_auth)  # an older bundle, never named or recorded
    latest = _finalized_bundle(client, dave_auth)
    _job_finished(monkeypatch)
    fake_queue.calls.clear()

    r = client.post(
        "/api/datasets/ds_predates_l1/layouts",
        headers=dave_auth,
        json={"layout_specs": ["grid"]},
    )
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/dave/uploads/{latest}/images"
    )


def test_add_layouts_while_running_is_409(client, auth, fake_queue, app_db, monkeypatch) -> None:
    """A layout bake refuses (409) while the dataset's last recorded job is still
    queued|started in RQ — mirrors DELETE's in-flight guard. Never enqueues a second
    job on top."""
    _owned_dataset_with_bundle(client, auth)
    # The recorded last_job_id reads back as an ACTIVE ("started") RQ job.
    from api.routers import jobs as jobs_router

    monkeypatch.setattr(
        jobs_router.Job,
        "fetch",
        lambda job_id, connection=None: SimpleNamespace(get_status=lambda: "started"),
    )
    fake_queue.calls.clear()

    r = client.post(
        "/api/datasets/ds_al/layouts", headers=auth, json={"layout_specs": ["datetime"]}
    )
    assert r.status_code == 409
    assert "still running" in r.json()["detail"]
    assert fake_queue.calls == []


def test_add_layouts_requires_auth(client, fake_queue) -> None:
    """No bearer → 401, never enqueued (mirrors the other write routes)."""
    r = client.post("/api/datasets/ds_al/layouts", json={"layout_specs": ["grid"]})
    assert r.status_code == 401
    assert fake_queue.calls == []


# --- get_job ---------------------------------------------------------------


def test_get_job_merges_rq_state_and_log_tail(client, auth, fake_queue, app_db, monkeypatch) -> None:
    # D-30: the worker's output_root is DATA_ROOT/datasets/, and ingest.log lives at
    # {output_root}/{ds_id}/ingest.log — get_job reads output_root from the job kwargs.
    datasets_root = Path(os.environ["DATA_ROOT"]) / "datasets"
    (datasets_root / "ds1").mkdir(parents=True)
    (datasets_root / "ds1" / "ingest.log").write_text(
        "line1\nline2\nline3\n", encoding="utf-8"
    )
    _seed_owner(app_db, "ds1", "alice")  # D-34: alice owns the job's dataset → may read it

    fake_job = SimpleNamespace(
        get_status=lambda: "finished",
        kwargs={"dataset_id": "ds1", "output_root": str(datasets_root)},
        exc_info=None,
        get_meta=lambda refresh=False: {},
        # Seam L1: a FINISHED job's return value is read for JobStatus.result. A real
        # rq.Job always has this; the double has to as well.
        return_value=lambda refresh=False: None,
    )
    from api.routers import jobs

    monkeypatch.setattr(jobs.Job, "fetch", lambda job_id, connection=None: fake_job)

    body = client.get("/api/jobs/whatever", headers=auth).json()
    assert body["state"] == "finished"
    assert body["dataset_id"] == "ds1"
    assert body["log_tail"] == ["line1", "line2", "line3"]
    assert body["error"] is None


def test_get_job_failed_surfaces_error(client, auth, fake_queue, app_db, monkeypatch) -> None:
    _seed_owner(app_db, "ds1", "alice")  # D-34: alice owns the job's dataset → may read it
    fake_job = SimpleNamespace(
        get_status=lambda: "failed",
        kwargs={
            "dataset_id": "ds1",
            "output_root": str(Path(os.environ["DATA_ROOT"]) / "datasets"),  # D-30
        },
        exc_info="Traceback (most recent call last):\n  ...\nRuntimeError: boom\n",
        get_meta=lambda refresh=False: {},
    )
    from api.routers import jobs

    monkeypatch.setattr(jobs.Job, "fetch", lambda job_id, connection=None: fake_job)

    body = client.get("/api/jobs/whatever", headers=auth).json()
    assert body["state"] == "failed"
    assert body["error"] == "RuntimeError: boom"
    assert body["log_tail"] == []  # no ingest.log on disk → empty fallback


def test_get_job_unknown_is_404(client, auth, fake_queue, monkeypatch) -> None:
    from api.routers import jobs

    def _raise(job_id, connection=None):
        raise jobs.NoSuchJobError(job_id)

    monkeypatch.setattr(jobs.Job, "fetch", _raise)
    assert client.get("/api/jobs/nope", headers=auth).status_code == 404


# --- auth gate -------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("post", "/api/uploads", {}),
        ("post", "/api/uploads/abc/parts", {"files": {"part": ("x.webp", b"x")}}),
        ("post", "/api/uploads/abc/finalize", {}),
        ("get", "/api/uploads/abc", {}),
        ("get", "/api/uploads/caps", {}),  # dependencies=[Depends(...)] idiom, not a `user` param
        ("post", "/api/datasets", {"json": {"dataset_id": "d", "upload_id": "u"}}),
        ("post", "/api/datasets/ds1/ingest", {"json": {}}),
    ],
)
def test_write_routes_require_auth(client, method, path, kwargs) -> None:
    # WRITE routes (and the owner-jailed upload session read) still require an
    # authenticated identity → 401 without a bearer. GET /api/jobs/{id} is NO longer
    # here: D-34 made it a visibility-scoped READ route (optional identity), so an
    # anonymous caller gets a 404 for a job whose dataset it cannot read — not a 401.
    # That is covered in the read-authorization matrix (test_read_authorization.py).
    resp = getattr(client, method)(path, **kwargs)
    assert resp.status_code == 401


# --- listing resilience: one bad session must not 500 GET /api/uploads -------


def test_list_sessions_skips_a_session_that_races_deletion(tmp_path, monkeypatch) -> None:
    """`_list_sessions` builds the caller's upload list by scanning session dirs and
    recounting each. A per-session `stat()` (in `_recount_tally`) can raise `OSError` when
    a bundle file vanishes mid-scan — a delete racing the list. That one session must be
    skipped (its documented "vanished mid-scan is skipped"), never 500 the whole list."""
    from api.routers import uploads

    root = tmp_path / "uploads"
    for name in ("good", "boom"):
        (root / name / uploads._IMAGES_SUBDIR).mkdir(parents=True)

    def flaky_tally(session: Path) -> tuple[int, int]:
        if session.name == "boom":
            raise OSError(2, "No such file or directory")
        return (3, 300)

    monkeypatch.setattr(uploads, "_load_or_recount_tally", flaky_tally)

    summaries = uploads._list_sessions(root)
    ids = {s.upload_id for s in summaries}
    assert "good" in ids, "the healthy session still lists"
    assert "boom" not in ids, "the racing session is skipped, not fatal"
