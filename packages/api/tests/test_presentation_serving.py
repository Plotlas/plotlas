"""Presentation TRAVELS with the dataset — the serving, write and migration halves.

`test_presentation.py` covers the PATCH's behaviour (partial by key presence, blank
clears, authz), and it passes UNCHANGED across this seam: the storage moved, the wire
contract did not. This module covers what the move added.

  * the MERGE (D-xv/D-xvi): the dataset's own `presentation.json` over the app-state
    fallback, in both directions, and what happens when a reference dangles;
  * the two ROUND TRIPS the seam is judged on — a dataset directory carried to a fresh
    checkout with an empty app-state keeps its name and credit, and a re-bake (the
    manifest flip, which is all a bake changes in the served tree) leaves presentation
    byte-identical and still served;
  * the WRITE: atomic, confined to one file, and safe while a bake is in flight;
  * the intake payload SPLIT (D-xvii): roles to the bake, presentation to the file, with
    a `column_roles.url` that arrives anyway redirected rather than lost or forwarded;
  * the MIGRATION off app-state: idempotent, never deleting, one failure not aborting the
    rest;
  * `search`'s url-column exclusion, repointed at the presentation record — the half that
    would otherwise have gone silently empty on every migrated tree.

App-state seeds/reads use a second engine over the same SQLite file (one asyncio.run loop
each), mirroring test_read_serve/test_search.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pyarrow as pa
import pyarrow.parquet as papq
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api import admin, appstate, presentation
from api.routers import datasets as datasets_router

DS = "rijks_mini"
_ALICE = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_BOB = {"username": "bob", "email": "bob@example.com", "password": "s3cretpw"}

_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "categorical": [{"column": "artist", "label": "Artist"}],
    "freeform": [
        {"column": "title", "label": "Title"},
        {"column": "source_url", "label": "Source"},
    ],
}
_ROWS = {
    "id": [0, 1],
    "filename": ["a.jpg", "b.jpg"],
    "title": ["Misty Sea", "The Night Watch"],
    "artist": ["Jan Toorop", "Rembrandt van Rijn"],
    "source_url": ["https://example.org/a", "https://example.org/b"],
}


# --- fakes (the per-dataset mutation lock; no broker in unit tests) ---------


class _FakeLock:
    def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
        return True

    def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        return None


class _FakeRedis:
    def lock(self, name: str, **kwargs):  # noqa: ANN003, ANN201
        return _FakeLock()


class _FakeQueue:
    """Records enqueue dispatches so the intake split can be asserted on the kwargs the
    worker would actually receive."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.connection = object()

    def enqueue(self, func_string: str, kwargs: dict | None = None, **_):  # noqa: ANN003, ANN201
        self.calls.append((func_string, kwargs or {}))
        return SimpleNamespace(id="job-test-123")


# --- fixtures --------------------------------------------------------------


def _write_dataset(datasets_dir: Path, ds_id: str = DS, roles: dict | None = None) -> Path:
    """A minimal servable dataset: metadata.parquet + a major-2 manifest carrying
    `column_roles` and one layout. Nothing here reads tiles."""
    ds_dir = datasets_dir / ds_id
    ds_dir.mkdir(parents=True, exist_ok=True)
    papq.write_table(pa.table(_ROWS), str(ds_dir / "metadata.parquet"))
    (ds_dir / "layout_manifest.json").write_text(
        json.dumps(
            {
                "manifest_version": "2.9",
                "dataset_id": ds_id,
                "dataset_version": 1,
                "dataset_metadata": {
                    "image_count": 2,
                    "ingest_timestamp": "2026-09-07T00:00:00Z",
                },
                "column_roles": _ROLES if roles is None else roles,
                "layouts": [{"layout_id": "grid", "label": "Grid", "type": "grid"}],
            }
        ),
        encoding="utf-8",
    )
    return ds_dir


@pytest.fixture
def data_root(tmp_path, monkeypatch) -> Path:
    root = tmp_path / "data"
    (root / "datasets").mkdir(parents=True)
    monkeypatch.setenv("DATA_ROOT", str(root))
    return root


@pytest.fixture
def db_path(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "appstate.db"
    monkeypatch.setenv("APP_STATE_DB", str(path))
    return path


@pytest.fixture
def ds_dir(data_root: Path) -> Path:
    return _write_dataset(data_root / "datasets")


@pytest.fixture
def client(db_path: Path, data_root: Path) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        test_client.app.state.redis = _FakeRedis()
        yield test_client


def _signup_login(client: TestClient, creds: dict[str, str]) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=creds).status_code == 200
    token = client.post(
        "/api/auth/login",
        json={"username": creds["username"], "password": creds["password"]},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _seed_appstate_presentation(db_path: Path, dataset_id: str, **values: str) -> None:
    """Put values in the app-state COLUMNS the way a pre-migration deployment left them.

    A direct UPDATE on purpose: `appstate.set_dataset_presentation` is gone (the file is
    the home now), and these rows exist in the wild only because an older release wrote
    them. Seeding them any other way would test a writer this codebase no longer has."""

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                assignments = ", ".join(f"{k} = :{k}" for k in values)
                await session.execute(
                    text(f"UPDATE datasets SET {assignments} WHERE dataset_id = :ds"),
                    {**values, "ds": dataset_id},
                )
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _appstate_row(db_path: Path, dataset_id: str) -> appstate.DatasetRecord | None:
    async def _run() -> appstate.DatasetRecord | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return await appstate.get_dataset_record(session, dataset_id)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


@pytest.fixture
def alice(client: TestClient, db_path: Path, ds_dir: Path) -> dict[str, str]:
    headers = _signup_login(client, _ALICE)
    _seed_owner(db_path, DS, "alice")
    return headers


def _summary(client: TestClient, headers: dict[str, str], ds_id: str = DS) -> dict:
    resp = client.get(f"/api/datasets/{ds_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _patch(client: TestClient, headers: dict[str, str], body: dict, ds_id: str = DS):
    return client.patch(
        f"/api/datasets/{ds_id}/presentation", json=body, headers=headers
    )


# --- 1. the merge, in both directions --------------------------------------


def test_the_file_serves_the_name_with_no_app_state_value(
    client: TestClient, alice: dict[str, str], db_path: Path
) -> None:
    """Tier-1 (1): a dataset whose `presentation.json` carries a display name serves it
    with NO app-state row value. The app-state columns stay null throughout — proving the
    value came out of the dataset directory, not out of the database."""
    assert _patch(client, alice, {"display_name": "Rijksmuseum Collection"}).status_code == 200

    assert _summary(client, alice)["display_name"] == "Rijksmuseum Collection"
    row = _appstate_row(db_path, DS)
    assert row is not None and row.display_name is None  # nothing was written there


def test_an_app_state_only_dataset_still_serves_its_name(
    client: TestClient, alice: dict[str, str], db_path: Path, ds_dir: Path
) -> None:
    """Tier-1 (2): the FALLBACK. A deployment that predates this seam has its values only
    in app-state and no `presentation.json` at all; it must serve exactly as before."""
    _seed_appstate_presentation(
        db_path, DS, display_name="Old Name", attribution="Old Credit"
    )
    assert not (ds_dir / "presentation.json").exists()

    summary = _summary(client, alice)
    assert summary["display_name"] == "Old Name"
    assert summary["attribution"] == "Old Credit"


def test_the_file_wins_over_app_state(
    client: TestClient, alice: dict[str, str], db_path: Path
) -> None:
    _seed_appstate_presentation(db_path, DS, display_name="Old Name")
    assert _patch(client, alice, {"display_name": "New Name"}).status_code == 200

    assert _summary(client, alice)["display_name"] == "New Name"
    row = _appstate_row(db_path, DS)
    assert row is not None and row.display_name == "Old Name"  # never deleted


def test_clearing_a_name_does_not_resurrect_the_app_state_value(
    client: TestClient, alice: dict[str, str], db_path: Path
) -> None:
    """The reason the file's `dataset` BLOCK — not each key — switches the fallback off.

    The file cannot represent "cleared": the schema has no null and `minLength: 1`, so
    clearing REMOVES the key. Under a per-key fallback the app-state value would come back
    from the dead and the name would be un-clearable, which is the failure the PATCH's
    whole partial-by-key-presence design exists to prevent."""
    _seed_appstate_presentation(db_path, DS, display_name="Old Name")
    assert _patch(client, alice, {"display_name": "New Name"}).status_code == 200
    assert _patch(client, alice, {"display_name": None}).status_code == 200

    assert _summary(client, alice)["display_name"] is None


def test_taking_ownership_of_the_block_carries_the_fallback_across(
    client: TestClient, alice: dict[str, str], db_path: Path
) -> None:
    """Writing ONE scalar creates the block, which switches the app-state fallback off for
    ALL THREE — so the write seeds the block from the fallback first. Without the seed,
    crediting an un-migrated collection would silently drop its name."""
    _seed_appstate_presentation(
        db_path, DS, display_name="Old Name", attribution_url="https://old.example"
    )
    assert _patch(client, alice, {"attribution": "A Credit"}).status_code == 200

    summary = _summary(client, alice)
    assert summary["display_name"] == "Old Name"  # carried, not lost
    assert summary["attribution_url"] == "https://old.example"
    assert summary["attribution"] == "A Credit"


def test_a_columns_only_write_does_not_take_the_scalars_over(
    client: TestClient, alice: dict[str, str], db_path: Path
) -> None:
    """...and the converse: a write that touches only `columns` does not cost an
    un-migrated collection its name. This is what makes the intake split safe to run
    before any name has been set.

    TWO independent mechanisms protect it — the write creates no `dataset` block when no
    scalar was sent, AND a block it does create is seeded from the fallback — so neither
    perturbation alone can fail this assertion (verified: "always create the block" passes;
    "never seed" passes). Only removing BOTH does, which is the honest description of what
    is being pinned: the OUTCOME, defended twice. It is left this way deliberately, because
    the outcome is what a consumer depends on and either mechanism alone is sufficient."""
    _seed_appstate_presentation(db_path, DS, display_name="Old Name")
    assert _patch(client, alice, {"columns": {"source_url": {"render": "url"}}}).status_code == 200

    assert _summary(client, alice)["display_name"] == "Old Name"


# --- 2. dangling references fall back; no 500 path exists ------------------


def test_every_dangling_reference_falls_back_and_returns_200(
    client: TestClient, alice: dict[str, str], ds_dir: Path
) -> None:
    """Tier-1 (3). A `default_layout` naming no layout, a `title_column` naming no column,
    a `columns`/`layouts` entry for something that no longer exists — each is the NORMAL
    consequence of two files changing independently (D-xvi), so each must resolve to a
    200 and be served back verbatim for the consumer to ignore."""
    resp = _patch(
        client,
        alice,
        {
            "default_layout": "no_such_layout",
            "title_column": "no_such_column",
            "columns": {"vanished": {"label": "Gone", "render": "url"}},
            "layouts": {"also_gone": {"label": "Phantom"}},
        },
    )
    assert resp.status_code == 200

    assert _summary(client, alice)["dataset_id"] == DS  # the dataset still serves
    body = client.get(f"/api/datasets/{DS}/presentation", headers=alice).json()
    assert body["dataset"]["default_layout"] == "no_such_layout"
    assert body["layouts"]["also_gone"]["label"] == "Phantom"
    assert body["columns"]["vanished"]["render"] == "url"


@pytest.mark.parametrize(
    "content",
    [
        "{not json at all",
        '["a list", "not an object"]',
        "",
    ],
)
def test_an_unusable_presentation_file_degrades_to_todays_behaviour(
    client: TestClient, alice: dict[str, str], ds_dir: Path, content: str
) -> None:
    """A corrupt file must never 500 a read: it degrades to "no record", which is exactly
    today's behaviour for the overwhelming majority of datasets."""
    (ds_dir / "presentation.json").write_text(content, encoding="utf-8")

    assert _summary(client, alice)["display_name"] is None
    assert client.get(f"/api/datasets/{DS}/presentation", headers=alice).status_code == 200


def test_an_unusable_presentation_file_refuses_a_write_rather_than_overwriting(
    client: TestClient, alice: dict[str, str], ds_dir: Path
) -> None:
    """...but a WRITE refuses. The operator's bytes are still on disk and a hand-edit that
    went wrong is recoverable only while they are, so the write reports the problem instead
    of silently replacing the file."""
    (ds_dir / "presentation.json").write_text("{oops", encoding="utf-8")

    resp = _patch(client, alice, {"display_name": "A name"})
    assert resp.status_code == 409
    assert "unusable" in resp.json()["detail"]
    assert (ds_dir / "presentation.json").read_text(encoding="utf-8") == "{oops"


# --- 3. the round trips ----------------------------------------------------


def test_a_dataset_directory_carried_to_a_fresh_checkout_keeps_its_name(
    client: TestClient, alice: dict[str, str], data_root: Path, tmp_path, monkeypatch
) -> None:
    """ROUND TRIP 1 (Definition of Done 3a), RUN rather than asserted.

    Name + credit a collection, copy its DIRECTORY to a second DATA_ROOT with a brand new,
    empty app-state, and serve it there. Both survive — which is the whole of D-i: today
    (before this seam) that dataset arrived anonymous, because app-state lives at
    ${DATA_ROOT}/app-state/appstate.db, outside the directory being copied.

    The new instance still needs an OWNER row (D-ii: ownership is per-instance and stays in
    app-state — `assign-owner` is the operator's step after a transfer), and that row's
    presentation columns are asserted NULL, so the name can only have come from the tree."""
    assert _patch(
        client,
        alice,
        {"display_name": "Rijksmuseum Collection", "attribution": "Rijksmuseum, Amsterdam"},
    ).status_code == 200

    # --- the copy: the dataset DIRECTORY only, to an untouched machine ---
    fresh_root = tmp_path / "fresh-checkout"
    (fresh_root / "datasets").mkdir(parents=True)
    shutil.copytree(
        data_root / "datasets" / DS, fresh_root / "datasets" / DS
    )
    fresh_db = tmp_path / "fresh-appstate.db"
    monkeypatch.setenv("DATA_ROOT", str(fresh_root))
    monkeypatch.setenv("APP_STATE_DB", str(fresh_db))

    from api.main import create_app

    with TestClient(create_app()) as fresh:
        fresh.app.state.redis = _FakeRedis()
        bob = _signup_login(fresh, _BOB)
        _seed_owner(fresh_db, DS, "bob")  # what `api.admin assign-owner` does

        summary = _summary(fresh, bob)
        assert summary["display_name"] == "Rijksmuseum Collection"
        assert summary["attribution"] == "Rijksmuseum, Amsterdam"

    row = _appstate_row(fresh_db, DS)
    assert row is not None and row.owner == "bob"
    assert row.display_name is None and row.attribution is None  # not from app-state


def test_a_rebake_leaves_presentation_untouched_and_still_served(
    client: TestClient, alice: dict[str, str], ds_dir: Path
) -> None:
    """ROUND TRIP 2 (Definition of Done 3b), the SERVING end. P2-1 pins the producer end
    (a real bake leaves the file byte-identical); this pins that the served answer does not
    move either.

    A re-bake's only effect on the served tree is the atomic manifest flip — a new
    `dataset_version`, and possibly different layouts — so that is what is simulated here.
    Presentation is byte-identical afterwards, still served, and its now-dangling
    `default_layout` falls back instead of erroring."""
    assert _patch(
        client,
        alice,
        {"display_name": "Rijksmuseum Collection", "default_layout": "grid"},
    ).status_code == 200
    before = (ds_dir / "presentation.json").read_bytes()

    manifest = json.loads((ds_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    manifest["dataset_version"] = 2
    manifest["layouts"] = [
        {"layout_id": "datetime_year", "label": "Year", "type": "datetime"}
    ]
    (ds_dir / "layout_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    assert (ds_dir / "presentation.json").read_bytes() == before
    summary = _summary(client, alice)
    assert summary["dataset_version"] == 2  # the re-bake really landed
    assert summary["display_name"] == "Rijksmuseum Collection"
    body = client.get(f"/api/datasets/{DS}/presentation", headers=alice).json()
    assert body["dataset"]["default_layout"] == "grid"  # kept, dangling, not an error


# --- 4. the write: atomic, confined, bake-safe -----------------------------


def test_a_failed_write_leaves_the_previous_file_intact_and_no_temp_behind(
    client: TestClient, alice: dict[str, str], ds_dir: Path, monkeypatch
) -> None:
    """Atomicity. A file is not a row: a half-written presentation.json is worse than a
    stale one, because the reader falls back to app-state and the dataset silently loses
    its name. The write goes to a temp file and is renamed into place, so a failure
    mid-serialization leaves the old bytes AND leaves no debris."""
    assert _patch(client, alice, {"display_name": "Good name"}).status_code == 200
    before = (ds_dir / "presentation.json").read_bytes()

    def _boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise OSError("disk full")

    monkeypatch.setattr(presentation.json, "dump", _boom)
    resp = _patch(client, alice, {"display_name": "Never lands"})

    assert resp.status_code == 409
    assert (ds_dir / "presentation.json").read_bytes() == before
    assert [p.name for p in ds_dir.glob("*.json.tmp*")] == []


def test_a_presentation_write_touches_only_presentation_json(
    client: TestClient, alice: dict[str, str], ds_dir: Path
) -> None:
    """The claim the whole two-file design rests on, PROVEN rather than asserted: the API
    writes exactly one path and can therefore not clobber a bake.

    Set up a dataset mid-bake — its committed tree plus the `.staging-<job>` directory the
    worker writes into — snapshot every byte, PATCH, and compare. Only presentation.json
    differs. (The other direction, that the BAKE leaves this file alone, is P2-1's
    `test_presentation_record` / `test_presentation_preserved_native`.)"""
    staging = ds_dir.parent / f".staging-job-123"
    staging.mkdir()
    (staging / "layout_manifest.json").write_text('{"in": "flight"}', encoding="utf-8")
    (ds_dir / "cover.webp").write_bytes(b"not really a webp")

    def _snapshot() -> dict[str, bytes]:
        root = ds_dir.parent
        return {
            str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*"))
            if p.is_file()
        }

    before = _snapshot()
    assert _patch(client, alice, {"display_name": "Mid-bake rename"}).status_code == 200
    after = _snapshot()

    changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
    assert changed == {str(Path(DS) / "presentation.json")}


def test_presentation_can_be_written_before_the_dataset_has_baked(
    client: TestClient, db_path: Path, data_root: Path
) -> None:
    """"The only thing the 'decide a URL' needs is the CSV to exist." A dataset whose bake
    has not committed anything — an app-state row and no directory at all — still takes a
    presentation write, which creates the directory holding just that file, and the name
    shows on the still-`processing`/`error` summary."""
    headers = _signup_login(client, _ALICE)
    _seed_owner(db_path, "not_baked_yet", "alice")

    resp = _patch(client, headers, {"display_name": "Baking now"}, ds_id="not_baked_yet")
    assert resp.status_code == 200

    ds_dir = data_root / "datasets" / "not_baked_yet"
    assert (ds_dir / "presentation.json").is_file()
    assert not (ds_dir / "layout_manifest.json").exists()  # still not a dataset

    listed = client.get("/api/datasets", headers=headers).json()["datasets"]
    entry = next(d for d in listed if d["dataset_id"] == "not_baked_yet")
    assert entry["status"] in ("processing", "error")
    assert entry["display_name"] == "Baking now"


def test_a_read_only_tree_is_a_409_naming_the_cause_not_a_500(
    client: TestClient, alice: dict[str, str], ds_dir: Path, monkeypatch
) -> None:
    """The showcase profile mounts its content `:ro` on purpose. A write that cannot land
    is the SERVER's condition, not the caller's — so it is a 409 that says so (the shape
    DELETE already answers for a read-only fixture, T2-91), never a bare 500."""

    def _no_write(*args, **kwargs):  # noqa: ANN002, ANN003
        raise PermissionError("Read-only file system")

    monkeypatch.setattr(presentation.tempfile, "mkstemp", _no_write)
    resp = _patch(client, alice, {"display_name": "nope"})

    assert resp.status_code == 409
    assert "read-only" in resp.json()["detail"]


# --- 5. the intake payload split (D-xvii) ----------------------------------


def test_split_intake_payload_moves_a_url_role_into_presentation() -> None:
    """PURE. Roles go to the bake, presentation to the file. A payload that still carries
    `column_roles.url` — schema v2.9 removed it — is REDIRECTED: forwarding it would
    enqueue a job guaranteed to fail role validation, and dropping it would lose the
    user's choice."""
    roles, pres = datasets_router._split_intake_payload(
        {"filename": {"column": "filename", "label": "F"}, "url": ["source_url"]},
        {},
    )
    assert roles == {"filename": {"column": "filename", "label": "F"}}
    assert pres == {"columns": {"source_url": {"render": "url"}}}


def test_split_intake_payload_lets_an_explicit_entry_win() -> None:
    """A caller that sends BOTH said the newer thing deliberately, so the explicit
    presentation entry wins over the redirected legacy role for that column."""
    roles, pres = datasets_router._split_intake_payload(
        {"url": ["source_url"]},
        {"columns": {"source_url": {"label": "Source", "render": "url"}}},
    )
    assert "url" not in (roles or {})
    assert pres["columns"]["source_url"] == {"label": "Source", "render": "url"}


def test_split_intake_payload_is_a_no_op_without_a_url_role() -> None:
    roles, pres = datasets_router._split_intake_payload({"filename": {}}, {"title_column": "t"})
    assert roles == {"filename": {}}
    assert pres == {"title_column": "t"}


def _finalized_bundle(client: TestClient, headers: dict[str, str]) -> str:
    """An images-only finalized upload bundle, through the real upload routes (the same
    three calls test_write_ingest makes)."""
    upload_id = client.post("/api/uploads", headers=headers).json()["upload_id"]
    for name in ("img_000.webp", "img_001.webp"):
        resp = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=headers,
            files={"part": (name, b"\x00fake-image-bytes")},
        )
        assert resp.status_code == 200, resp.text
    assert (
        client.post(f"/api/uploads/{upload_id}/finalize", headers=headers).status_code
        == 200
    )
    return upload_id


def test_create_writes_presentation_before_the_bake_and_keeps_it_out_of_the_roles(
    client: TestClient, db_path: Path, data_root: Path
) -> None:
    """The intake split, end to end. The presentation half lands in the dataset directory
    BEFORE the enqueue — so the worker's commit sees an existing directory and takes its
    merge-move branch, which leaves the file alone — and the roles the worker receives
    carry no `url` key."""
    headers = _signup_login(client, _ALICE)
    queue = _FakeQueue()
    client.app.state.queue = queue
    upload_id = _finalized_bundle(client, headers)

    resp = client.post(
        "/api/datasets",
        json={
            "dataset_id": "fresh_ds",
            "upload_id": upload_id,
            "presentation": {
                "display_name": "Fresh",
                "columns": {"source_url": {"render": "url"}},
            },
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    stored = json.loads(
        (data_root / "datasets" / "fresh_ds" / "presentation.json").read_text(
            encoding="utf-8"
        )
    )
    assert stored["dataset"]["display_name"] == "Fresh"
    assert stored["columns"] == {"source_url": {"render": "url"}}
    assert queue.calls[0][1]["column_roles"] is None  # images-only: no roles at all


def test_a_create_whose_enqueue_fails_leaves_no_presentation_behind(
    client: TestClient, db_path: Path, data_root: Path
) -> None:
    """A failed enqueue rolls the owner row back, so the id names NOTHING — and a
    presentation file for a dataset that does not exist would be litter. Only the
    directory this request created is removed; a retry over an id whose earlier bake
    failed keeps its choices, because that dataset does still exist."""
    headers = _signup_login(client, _ALICE)

    class _BrokenQueue(_FakeQueue):
        def enqueue(self, *args, **kwargs):  # noqa: ANN002, ANN003
            raise RuntimeError("broker down")

    client.app.state.queue = _BrokenQueue()
    upload_id = _finalized_bundle(client, headers)

    resp = client.post(
        "/api/datasets",
        json={
            "dataset_id": "doomed",
            "upload_id": upload_id,
            "presentation": {"display_name": "Never existed"},
        },
        headers=headers,
    )
    assert resp.status_code == 503
    assert not (data_root / "datasets" / "doomed").exists()
    assert _appstate_row(db_path, "doomed") is None


# --- 6. the migration off app-state ----------------------------------------


def test_migrate_copies_app_state_values_into_the_tree_without_deleting_them(
    client: TestClient, alice: dict[str, str], db_path: Path, ds_dir: Path, capsys
) -> None:
    """Tier-1 (4), first half. The values land in the dataset directory; the app-state row
    is left exactly as it was, because it is the fallback AND the only copy a rollback to
    the previous release would find."""
    _seed_appstate_presentation(
        db_path,
        DS,
        display_name="Rijksmuseum Collection",
        attribution="Rijksmuseum, Amsterdam",
        attribution_url="https://www.rijksmuseum.nl",
    )

    assert admin.main(["migrate-presentation"]) == 0
    block = json.loads((ds_dir / "presentation.json").read_text(encoding="utf-8"))["dataset"]
    assert block == {
        "display_name": "Rijksmuseum Collection",
        "attribution": "Rijksmuseum, Amsterdam",
        "attribution_url": "https://www.rijksmuseum.nl",
    }
    row = _appstate_row(db_path, DS)
    assert row is not None and row.display_name == "Rijksmuseum Collection"  # NOT cleared


def test_migrate_is_idempotent_and_never_reverts_a_later_edit(
    client: TestClient, alice: dict[str, str], db_path: Path, ds_dir: Path
) -> None:
    """Tier-1 (4), second half. Re-running writes nothing — and, critically, does not undo
    an edit made after the first run: the file wins, so a second migration cannot drag the
    stale app-state value back over a corrected name."""
    _seed_appstate_presentation(db_path, DS, display_name="Old Name")
    assert admin.main(["migrate-presentation"]) == 0
    assert _patch(client, alice, {"display_name": "Corrected"}).status_code == 200
    before = (ds_dir / "presentation.json").read_bytes()

    assert admin.main(["migrate-presentation"]) == 0

    assert (ds_dir / "presentation.json").read_bytes() == before
    assert _summary(client, alice)["display_name"] == "Corrected"


def test_migrate_reports_one_failure_and_still_does_the_rest(
    client: TestClient, alice: dict[str, str], db_path: Path, data_root: Path, capsys
) -> None:
    """Tier-1 (4), third half. One dataset that cannot be written is REPORTED and skipped
    with its app-state row intact; the others still migrate. A migration that aborted on
    the first bad dataset would leave the operator with a half-done job and no list."""
    _seed_appstate_presentation(db_path, DS, display_name="Fine")
    # An app-state row whose tree never landed — a create whose ingest failed.
    _seed_owner(db_path, "no_tree", "alice")
    _seed_appstate_presentation(db_path, "no_tree", display_name="Homeless")

    code = admin.main(["migrate-presentation"])

    assert code == 1  # something was skipped, so a scripted run notices
    err = capsys.readouterr().err
    assert "no_tree: SKIPPED" in err and "no dataset directory" in err
    good = json.loads(
        (data_root / "datasets" / DS / "presentation.json").read_text(encoding="utf-8")
    )
    assert good["dataset"]["display_name"] == "Fine"
    row = _appstate_row(db_path, "no_tree")
    assert row is not None and row.display_name == "Homeless"  # row left intact


def test_migrate_moves_a_committed_column_roles_url_into_the_record(
    client: TestClient, db_path: Path, data_root: Path
) -> None:
    """The pre-2.9 `column_roles.url` half (D-xvii), on a manifest shaped like the real
    ones: measured 2026-09-07, four of six live trees carry the key (`rijks_pilot` 2.7 with
    `["source_url"]`; three 2.8 trees with up to five columns).

    It is COPIED, not moved: this process never writes `layout_manifest.json` (D-xv), so the
    stale key stays in the manifest and only the pipeline can remove it."""
    roles = {**_ROLES, "url": ["source_url"]}
    _signup_login(client, _ALICE)  # the owner row's FK needs the account to exist
    ds_dir = _write_dataset(data_root / "datasets", "legacy_ds", roles=roles)
    _seed_owner(db_path, "legacy_ds", "alice")
    before_manifest = (ds_dir / "layout_manifest.json").read_bytes()

    assert admin.main(["migrate-presentation", "legacy_ds"]) == 0

    stored = json.loads((ds_dir / "presentation.json").read_text(encoding="utf-8"))
    assert stored["columns"] == {"source_url": {"render": "url"}}
    assert (ds_dir / "layout_manifest.json").read_bytes() == before_manifest


def test_migrate_does_not_overwrite_an_existing_column_entry(
    client: TestClient, db_path: Path, data_root: Path
) -> None:
    """Additive only: a column the file already describes is left exactly as the operator
    left it, even if the stale manifest role says something else."""
    roles = {**_ROLES, "url": ["source_url"]}
    _signup_login(client, _ALICE)  # the owner row's FK needs the account to exist
    ds_dir = _write_dataset(data_root / "datasets", "legacy_ds", roles=roles)
    _seed_owner(db_path, "legacy_ds", "alice")
    presentation.update(ds_dir, {"columns": {"source_url": {"label": "Source page"}}})

    assert admin.main(["migrate-presentation", "legacy_ds"]) == 0

    stored = json.loads((ds_dir / "presentation.json").read_text(encoding="utf-8"))
    assert stored["columns"] == {"source_url": {"label": "Source page"}}


# --- 7. search's url-column exclusion, repointed --------------------------


def _search(client: TestClient, headers: dict[str, str], q: str) -> set[str]:
    """The set of COLUMNS a query matched (both rows carry an example.org url, so the hit
    count is not the interesting number — which column was searched is)."""
    resp = client.get(
        f"/api/datasets/{DS}/search", params={"q": q, "fields": "all"}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    return {hit["field"] for hit in resp.json()["hits"]}


def test_search_excludes_a_url_column_declared_in_the_presentation_record(
    client: TestClient, alice: dict[str, str]
) -> None:
    """The repoint. `search._url_columns` used to read `roles.get("url")`, which is an
    EMPTY SET on every migrated (2.9) tree — url columns would have re-entered search and
    nothing would have gone red, because test_search builds its roles dict by hand."""
    assert _search(client, alice, "example.org") == {"source_url"}  # searched today

    assert _patch(client, alice, {"columns": {"source_url": {"render": "url"}}}).status_code == 200

    assert _search(client, alice, "example.org") == set()  # and excluded once declared


def test_search_still_excludes_a_pre_2_9_manifest_url_role(
    client: TestClient, db_path: Path, data_root: Path
) -> None:
    """...and the four live trees keep working BEFORE anyone runs the migration: a
    committed `column_roles.url` is still honoured, through the same read-side fallback."""
    headers = _signup_login(client, _ALICE)
    _write_dataset(data_root / "datasets", DS, roles={**_ROLES, "url": ["source_url"]})
    _seed_owner(db_path, DS, "alice")

    assert _search(client, headers, "example.org") == set()


# --- 8. owner and visibility do not move ----------------------------------


def test_owner_and_visibility_are_untouched_by_a_presentation_write(
    client: TestClient, alice: dict[str, str], db_path: Path, ds_dir: Path
) -> None:
    """D-ii, verified rather than intended: the same directory on two servers legitimately
    has different owners, so these two stay in app-state permanently — and nothing about
    them appears in the file the API now writes."""
    before = _appstate_row(db_path, DS)
    assert before is not None

    assert _patch(client, alice, {"display_name": "A name"}).status_code == 200

    after = _appstate_row(db_path, DS)
    assert after is not None
    assert (after.owner, after.visibility) == (before.owner, before.visibility)
    stored = json.loads((ds_dir / "presentation.json").read_text(encoding="utf-8"))
    assert "owner" not in json.dumps(stored) and "visibility" not in json.dumps(stored)


def test_clearing_the_only_setting_on_a_column_actually_CLEARS_it(
    tmp_path: Path,
) -> None:
    """**Unticking "render as link" reported success and did nothing** (review of PR #346,
    finding 1).

    `apply_updates` popped a `columns` entry the moment it became empty, and `effective`
    re-applies the manifest's legacy `url` role to exactly the columns the record does NOT
    describe. So on a tree like `rijks_pilot` — `column_roles.url: ["source_url"]`, no
    `presentation.json` — `{"columns": {"source_url": {"render": null}}}` popped the key,
    emptied the entry, dropped it, wrote nothing, and the next read resurrected the link.
    200 OK, wizard reports success, column is still a link. Permanently: the migration
    copies the role and never removes it.

    Removal was always expressible separately (`{"source_url": null}`), so popping on
    empty overloaded two different intents onto one patch. The emptied entry is now a
    tombstone — and it is also what makes the pipeline's `drop_retired_roles` ownership
    test (`name in columns`) agree with this writer about what "described" means."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    roles = {"filename": "f", "url": ["source_url"]}

    presentation.update(ds_dir, {"columns": {"source_url": {"render": "url"}}})
    presentation.update(ds_dir, {"columns": {"source_url": {"render": None}}})

    stored = json.loads(
        (ds_dir / presentation.PRESENTATION_FILENAME).read_text(encoding="utf-8")
    )
    assert "source_url" in stored["columns"], (
        "the emptied entry must survive as a tombstone, else the legacy role resurrects "
        f"the link: {stored['columns']}"
    )

    served = presentation.effective(presentation.load(ds_dir), roles=roles)
    assert served["columns"].get("source_url", {}).get("render") is None, (
        "the link was resurrected from the manifest's legacy role after the owner "
        f"explicitly cleared it: {served['columns']}"
    )


def test_removing_a_column_entry_outright_is_still_expressible(tmp_path: Path) -> None:
    """The tombstone must not cost the OTHER intent. `{"name": null}` still removes the
    entry entirely — which, for a column the manifest's legacy role names, correctly
    hands it back to that fallback."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    presentation.update(ds_dir, {"columns": {"c": {"label": "C"}}})
    presentation.update(ds_dir, {"columns": {"c": None}})
    stored = json.loads(
        (ds_dir / presentation.PRESENTATION_FILENAME).read_text(encoding="utf-8")
    )
    assert "c" not in stored.get("columns", {}), stored


# --- 9. the read cost: cached parse, and only the half each caller wants ----
#
# Review of PR #346, findings 7 and 15. Both are PERF findings, so both are pinned by
# BEHAVIOUR that a slow implementation cannot fake: "the file is opened once" and "the
# listing never resolves the maps". The measured numbers live in the module docstrings.


def test_a_second_read_of_an_unchanged_file_does_not_re_parse_it(
    tmp_path: Path, monkeypatch
) -> None:
    """`presentation.load` is on two paths that repeat — search resolves the url columns
    on EVERY request (one per tier-0 debounced keystroke, per user) and the listing reads
    one per dataset. `db.load_manifest` is cached for exactly this reason and says so in
    its docstring; this one had no cache at all."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    presentation.update(ds_dir, {"display_name": "Cached"})
    presentation.load(ds_dir)  # warm

    reads: list[Path] = []
    real_read = presentation._read

    def _counting_read(path: Path):  # noqa: ANN202
        reads.append(path)
        return real_read(path)

    monkeypatch.setattr(presentation, "_read", _counting_read)

    assert presentation.load(ds_dir)["dataset"]["display_name"] == "Cached"
    assert presentation.load(ds_dir)["dataset"]["display_name"] == "Cached"
    assert reads == [], f"the file was re-opened and re-parsed {len(reads)} time(s)"


def test_a_write_is_visible_to_the_very_next_read(tmp_path: Path) -> None:
    """The half that makes the cache safe. Two edits of the SAME field are the same size
    and land inside one mtime tick on a coarse filesystem, so mtime+size alone can
    collide — the key carries the inode too, and every write is an `os.replace` of a fresh
    temp file, so the inode always changes. A stale hit here would be a PATCH that reports
    success and serves the old value."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    for name in ("AAAA", "BBBB", "CCCC"):  # identical lengths: same file size every time
        presentation.update(ds_dir, {"display_name": name})
        assert presentation.load(ds_dir)["dataset"]["display_name"] == name


def test_the_listing_never_resolves_the_columns_or_layouts_maps(
    client: TestClient, alice: dict[str, str], ds_dir: Path, monkeypatch
) -> None:
    """Finding 15. `_summary_presentation` used to build the WHOLE effective record —
    `_clean_columns` over every entry, `_clean_layouts`, `legacy_url_columns` against the
    manifest — once per ready dataset AND once per pending one, then keep three fields of
    it. Booby-trap both map resolvers: if the listing still touches either, the scan's
    isolation catch drops the dataset and the assertion below fails."""
    assert _patch(client, alice, {"columns": {"artist": {"label": "By"}}}).status_code == 200

    def _explode(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError("the listing resolved a presentation map it does not use")

    monkeypatch.setattr(presentation, "_clean_columns", _explode)
    monkeypatch.setattr(presentation, "_clean_layouts", _explode)

    resp = client.get("/api/datasets", headers=alice)
    assert resp.status_code == 200
    listed = resp.json()["datasets"]
    assert [d["dataset_id"] for d in listed] == [DS], resp.text
    assert listed[0]["display_name"] is None  # the block still resolved, just not the maps


def test_search_never_resolves_the_layouts_map(
    client: TestClient, alice: dict[str, str], ds_dir: Path, monkeypatch
) -> None:
    """The mirror of the above on the hotter path: search wants the `columns` map and
    nothing else, and was building `_clean_layouts` and the dataset block per request."""

    def _explode(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise AssertionError("search resolved the layouts map")

    monkeypatch.setattr(presentation, "_clean_layouts", _explode)

    resp = client.get(
        f"/api/datasets/{DS}/search",
        params={"q": "Rembrandt", "fields": "all"},
        headers=alice,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["hits"], resp.text


def test_the_split_resolvers_agree_with_the_whole_record(tmp_path: Path) -> None:
    """`effective` is now COMPOSED of the two halves, and this is what keeps it that way:
    an edit to one arm that does not reach the other goes red here rather than making the
    listing and the presentation route disagree about the same file."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    presentation.update(
        ds_dir,
        {
            "display_name": "Whole",
            "default_layout": "grid",
            "columns": {"title": {"label": "Title"}},
            "layouts": {"grid": {"label": "Tiles"}},
        },
    )
    roles = {**_ROLES, "url": ["source_url"]}
    stored = presentation.load(ds_dir)
    whole = presentation.effective(stored, roles=roles)

    assert presentation.effective_dataset(stored) == whole["dataset"]
    assert presentation.effective_columns(stored, roles=roles) == whole["columns"]
    assert presentation.url_columns(whole["columns"]) == {"source_url"}


# --- 10. presentation_version is never stamped DOWN ------------------------
#
# Review of PR #346, finding 12. `apply_updates` deep-copies the stored record, so every
# unknown top-level key a newer writer left survives the rewrite; stamping "1.0" over it
# denies content the same call just preserved, and relabels keys the schema permits only
# under the version that introduced them (`additionalProperties: false`).


def test_a_newer_minor_is_preserved_along_with_the_keys_it_licenses() -> None:
    record = {
        "presentation_version": "1.3",
        "dataset": {"display_name": "Old"},
        "some_1_3_key": {"whatever": True},
    }
    out = presentation.apply_updates(record, {"display_name": "New"})
    assert out["presentation_version"] == "1.3", (
        "an older API rewrote a 1.3 file as 1.0 while carrying its 1.3 keys through: "
        f"{out}"
    )
    assert out["some_1_3_key"] == {"whatever": True}
    assert out["dataset"]["display_name"] == "New"


def test_a_minor_at_or_below_ours_is_stamped_with_ours() -> None:
    """The stamp still MOVES — it only refuses to move down. An absent, older or
    malformed version becomes this writer's, so a file this module has edited always says
    who wrote it."""
    for stored in ("1.0", "1", "", "nonsense", None):
        record: dict = {"dataset": {"display_name": "x"}}
        if stored is not None:
            record["presentation_version"] = stored
        out = presentation.apply_updates(record, {"display_name": "y"})
        assert out["presentation_version"] == presentation.PRESENTATION_VERSION, stored


def test_a_future_major_is_refused_rather_than_relabelled() -> None:
    """1.x is additive by construction (the schema's pattern admits only `1.<minor>`), so
    preserving a newer minor is safe. A different MAJOR is not: this writer cannot know
    what a 2.x file means by the keys it shares, so it leaves the operator's bytes alone —
    the same posture `update` already takes for a file it cannot parse."""
    with pytest.raises(presentation.PresentationError) as excinfo:
        presentation.apply_updates(
            {"presentation_version": "2.0", "dataset": {}}, {"display_name": "x"}
        )
    assert "2.0" in str(excinfo.value)
    assert getattr(excinfo.value, "io_error", False) is True  # a 409, not a 422


def test_a_future_major_on_disk_leaves_the_file_byte_identical(tmp_path: Path) -> None:
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    path = ds_dir / presentation.PRESENTATION_FILENAME
    path.write_text(
        json.dumps({"presentation_version": "2.0", "dataset": {"display_name": "Keep"}}),
        encoding="utf-8",
    )
    before = path.read_bytes()
    with pytest.raises(presentation.PresentationError):
        presentation.update(ds_dir, {"display_name": "Clobber"})
    assert path.read_bytes() == before


# --- 11. a write that names nothing is stored, and REPORTED ----------------
#
# Review of PR #346, finding 9. The write does not refuse — that would flip
# `test_every_dangling_reference_falls_back_and_returns_200` above, which is right,
# because a column can vanish between the designer loading and the owner submitting and a
# refusal would then lose every other edit in the same PATCH. It does not stay silent
# either, which is what was actually missing.


def test_a_columns_key_that_names_no_column_is_stored_but_reported(
    client: TestClient, alice: dict[str, str], ds_dir: Path, caplog
) -> None:
    """The typo the deleted bake-time guard used to catch by name."""
    with caplog.at_level("WARNING", logger="api.routers.datasets"):
        resp = _patch(client, alice, {"columns": {"sorce_url": {"render": "url"}}})

    assert resp.status_code == 200, resp.text
    stored = json.loads((ds_dir / "presentation.json").read_text(encoding="utf-8"))
    assert stored["columns"]["sorce_url"] == {"render": "url"}  # kept, per D-xvi
    reported = [r.getMessage() for r in caplog.records if "sorce_url" in r.getMessage()]
    assert reported, f"the mismatch was not reported anywhere: {caplog.text!r}"
    assert "columns=['sorce_url']" in reported[0], reported[0]


def test_a_layouts_key_that_names_no_layout_is_stored_but_reported(
    client: TestClient, alice: dict[str, str], caplog
) -> None:
    with caplog.at_level("WARNING", logger="api.routers.datasets"):
        resp = _patch(client, alice, {"layouts": {"griid": {"label": "Tiles"}}})

    assert resp.status_code == 200, resp.text
    reported = [r.getMessage() for r in caplog.records if "griid" in r.getMessage()]
    assert reported, f"the mismatch was not reported anywhere: {caplog.text!r}"
    assert "layouts=['griid']" in reported[0], reported[0]


def test_a_write_that_resolves_says_nothing(
    client: TestClient, alice: dict[str, str], caplog
) -> None:
    """The other half of a warning that means something: a correct write must be quiet, or
    the log stops being a signal. `artist` is in the fixture's parquet and `grid` is the
    manifest's only layout."""
    with caplog.at_level("WARNING", logger="api.routers.datasets"):
        resp = _patch(
            client,
            alice,
            {
                "columns": {"artist": {"label": "By"}},
                "layouts": {"grid": {"label": "Tiles"}},
            },
        )
    assert resp.status_code == 200, resp.text
    assert [
        r.getMessage() for r in caplog.records if "name nothing" in r.getMessage()
    ] == []
