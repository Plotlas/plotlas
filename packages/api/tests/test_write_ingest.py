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
import os
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


# --- start_ingest (re-ingest) ----------------------------------------------


def test_start_ingest_reingest_is_images_only(client, auth, fake_queue, app_db) -> None:
    # alice creates ds_re (records owner), then re-ingests a new bundle.
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_re", "upload_id": first})
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


def test_start_ingest_passes_detail_tier_skip(client, auth, fake_queue, app_db) -> None:
    """The optional detail_tier request field is threaded through the enqueue to the
    worker verbatim (T2-46) — "skip" reaches run_ingest_job's kwargs."""
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_skip", "upload_id": first})
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


def test_start_ingest_defaults_to_latest_bundle(client, auth, fake_queue, app_db) -> None:
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_l", "upload_id": first})
    fake_queue.calls.clear()
    latest = _finalized_bundle(client, auth)  # most recently finalized

    r = client.post("/api/datasets/ds_l/ingest", headers=auth, json={})
    assert r.status_code == 200, r.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["images_dir"].replace("\\", "/").endswith(
        f"users/alice/uploads/{latest}/images"
    )


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
    """create ds_al (records alice as owner) + leave a fresh finalized bundle as the
    add-layouts image source; return the latest upload_id. Mirrors the re-ingest
    setup (add-layouts resolves images from a finalized bundle just as re-ingest
    does)."""
    first = _finalized_bundle(client, auth)
    client.post("/api/datasets", headers=auth, json={"dataset_id": "ds_al", "upload_id": first})
    return _finalized_bundle(client, auth)  # the latest — add-layouts default source


def _job_finished(monkeypatch) -> None:
    """Make the add-layouts 409-while-running guard see the dataset's last recorded
    job (the create's) as NOT in flight, so the happy path proceeds. Mirrors the
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
    exact primitive kwargs (specs + images from the finalized bundle + owner) and
    records the NEW job id on the dataset row (D-28)."""
    latest = _owned_dataset_with_bundle(client, auth)
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
        f"users/alice/uploads/{latest}/images"
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
