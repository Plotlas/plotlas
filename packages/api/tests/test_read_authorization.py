"""The D-34 read-authorization security matrix (Seam PR-A, R-U1).

This is the tenant read boundary. It exercises the single may_read rule
(appstate.may_read) end-to-end across EVERY read route + get_job:

  * a new dataset is PRIVATE by default;
  * the OWNER reads their own private dataset (200) on every route;
  * a DIFFERENT authed user is DENIED a private dataset (404) on every route, and
    the listing omits it;
  * an ANONYMOUS caller is denied a private dataset (404) on every route (the list
    returns public-only, never 404);
  * a PUBLIC dataset is readable anonymously (200) on every route incl. the manifest
    WITHOUT a token/cookie — the login-less showcase;
  * the listing is public-only for anonymous and owned ∪ public for an owner;
  * get_job is scoped the same way (owner/public only) — the MED-2 job-log leak;
  * a PRESENTED-but-invalid bearer is 401 on every read route (anonymous means NO
    credential — a stale token must hear "re-authenticate", not silently browse as
    anonymous), regardless of the dataset's visibility (no oracle);
  * the summary's `owner` (an account username) is disclosed only to the owner —
    every other viewer (incl. anonymous readers of a public dataset) sees "";
  * `api.admin set-visibility` round-trips to the read model.

A denied read returns the SAME 404 as a missing dataset (non-disclosure). App-state
seeds use a second engine over the same SQLite file (one asyncio.run loop each),
mirroring test_read_serve / test_write_ingest.
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api import admin, appstate
from api.routers import authz

# Repo-root tests/fixtures/ (this file is packages/api/tests/test_read_authorization.py).
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
WITH_META = "golden_dataset_v2"
IMAGES_ONLY = "golden_dataset_images_only_v2"

_ALICE = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_BOB = {"username": "bob", "email": "bob@example.com", "password": "s3cretpw"}

# A tiny valid WebP (header + 1x1 frame) standing in for the pipeline-written
# cover.webp, so the cover route returns 200 for an authorized caller (the minimal
# golden fixture ships without one). Its bytes are inconsequential — the route serves
# the file verbatim.
_TINY_WEBP = bytes.fromhex(
    "524946461a000000574542505650384c0d0000002f00000010071011118888" "0800"
)


def _read_routes(ds: str) -> list[str]:
    """Every per-dataset READ route, each of which returns 200 for an authorized
    caller against the golden fixture (a cover is written into the fixture below;
    the golden manifest's dataset_version is 1 and its detail path_prefix names the
    same tier the un-versioned URL serves, so the version-stamped detail URL is
    exercisable here too — no gated route sits outside the matrix)."""
    return [
        f"/api/datasets/{ds}",
        f"/api/datasets/{ds}/layouts",
        f"/api/datasets/{ds}/layouts/grid",
        f"/api/datasets/{ds}/metadata?ids=0",
        f"/api/datasets/{ds}/pyramid/grid.pmtiles",
        f"/api/datasets/{ds}/detail/0.webp",
        f"/api/datasets/{ds}/detail/v1/0.webp",
        f"/api/datasets/{ds}/cover",
    ]


# --- app-state seed helpers (second engine over the same SQLite file) -------


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    """Record `dataset_id -> owner` (the user must already exist). Leaves visibility at
    the model default so `_read_visibility` can prove it is "private"."""

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _set_visibility(db_path: Path, dataset_id: str, visibility: str) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                assert await appstate.set_dataset_visibility(
                    session, dataset_id, visibility
                )
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _read_visibility(db_path: Path, dataset_id: str) -> str:
    async def _run() -> str:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return await appstate.get_dataset_visibility(session, dataset_id)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


class _FakeQueue:
    """Stand-in for app.state.queue exposing only `.connection` — get_job passes it to
    the (mocked) Job.fetch, so no live Redis is contacted."""

    def __init__(self) -> None:
        self.connection = object()


# --- fixtures --------------------------------------------------------------


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "appstate.db"


@pytest.fixture
def data_root(tmp_path: Path) -> Path:
    """A DATA_ROOT whose datasets/ subtree (D-30) exposes both golden fixtures; a cover
    is written into WITH_META so its cover route serves 200 for an authorized caller."""
    dr = tmp_path / "data"
    (dr / "datasets").mkdir(parents=True)
    shutil.copytree(FIXTURES / WITH_META, dr / "datasets" / WITH_META)
    shutil.copytree(FIXTURES / IMAGES_ONLY, dr / "datasets" / IMAGES_ONLY)
    (dr / "datasets" / WITH_META / "cover.webp").write_bytes(_TINY_WEBP)
    return dr


@pytest.fixture
def client(db_path: Path, data_root: Path, monkeypatch) -> Iterator[TestClient]:
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture(autouse=True)
def _clear_visibility_cache() -> Iterator[None]:
    """The authz public-fast-path cache is module-level — clear it around every test so
    one test's visibility verdict can never bleed into another."""
    authz._visibility_cache.clear()
    yield
    authz._visibility_cache.clear()


def _signup_login(client: TestClient, creds: dict[str, str]) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=creds).status_code == 200
    token = client.post(
        "/api/auth/login",
        json={"username": creds["username"], "password": creds["password"]},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def alice(client: TestClient) -> dict[str, str]:
    return _signup_login(client, _ALICE)


@pytest.fixture
def bob(client: TestClient) -> dict[str, str]:
    return _signup_login(client, _BOB)


@pytest.fixture
def owned(client: TestClient, db_path: Path, alice: dict[str, str]) -> dict[str, str]:
    """alice owns WITH_META (PRIVATE by default). Returns alice's bearer header."""
    _seed_owner(db_path, WITH_META, "alice")
    return alice


def _list_ids(client: TestClient, headers: dict[str, str] | None) -> set[str]:
    resp = client.get("/api/datasets", headers=headers or {})
    assert resp.status_code == 200
    return {d["dataset_id"] for d in resp.json()["datasets"]}


# --- private by default ----------------------------------------------------


def test_new_dataset_is_private_by_default(client, db_path, alice) -> None:
    """A dataset row created by recording ownership (no explicit visibility) is
    PRIVATE — the model default that makes owner-only the safe baseline (D-34)."""
    _seed_owner(db_path, WITH_META, "alice")
    assert _read_visibility(db_path, WITH_META) == "private"


# --- owner reads own (200 every route) -------------------------------------


@pytest.mark.parametrize("path", _read_routes(WITH_META))
def test_owner_reads_own_private_dataset_200(owned, client, path) -> None:
    """The owner reads every route of their own private dataset (D-34)."""
    assert client.get(path, headers=owned).status_code == 200


# --- non-owner denied a private dataset (404 every route) ------------------


@pytest.mark.parametrize("path", _read_routes(WITH_META))
def test_non_owner_denied_private_dataset_404(owned, client, bob, path) -> None:
    """A DIFFERENT authenticated user is denied a private dataset with 404 (the same
    404 as a missing dataset — non-disclosure) on EVERY read route. `owned` seeds
    WITH_META owner=alice; bob is a second, unrelated authed user (fixes app-scan
    HIGH-1: owner-open reads let any authed user read any dataset)."""
    assert client.get(path, headers=bob).status_code == 404


def test_non_owner_listing_omits_private_dataset(owned, client, bob) -> None:
    assert WITH_META not in _list_ids(client, bob)


# --- anonymous denied a private dataset (404 every route) ------------------


@pytest.mark.parametrize("path", _read_routes(WITH_META))
def test_anonymous_denied_private_dataset_404(owned, client, path) -> None:
    """An anonymous caller (no token) is denied a private dataset with 404 on every
    per-dataset read route — get_optional_user never 401s; may_read denies."""
    assert client.get(path).status_code == 404


# --- anonymous READS a public dataset (200 every route) --------------------


@pytest.mark.parametrize("path", _read_routes(WITH_META))
def test_anonymous_reads_public_dataset_200(owned, client, db_path, path) -> None:
    """A PUBLIC dataset is readable ANONYMOUSLY (no login) on every route — the
    login-less showcase. Includes the manifest (see the no-cookie proof below)."""
    _set_visibility(db_path, WITH_META, "public")
    assert client.get(path).status_code == 200


@pytest.mark.parametrize("path", _read_routes(WITH_META))
def test_non_owner_reads_public_dataset_200(owned, client, db_path, bob, path) -> None:
    """A public dataset is also readable by a DIFFERENT authenticated user."""
    _set_visibility(db_path, WITH_META, "public")
    assert client.get(path, headers=bob).status_code == 200


# --- the manifest cookie: minted for an owner, absent for anonymous-public --


def test_public_manifest_serves_anonymously_without_cookie(owned, client, db_path) -> None:
    """A PUBLIC dataset's manifest serves anonymously (no token) AND mints NO edge
    cookie — the anonymous caller's /datasets/* fetches ride the gate's public-fast-path
    instead (D-34)."""
    _set_visibility(db_path, WITH_META, "public")
    resp = client.get(f"/api/datasets/{WITH_META}/layouts/grid")  # no auth
    assert resp.status_code == 200
    assert "set-cookie" not in resp.headers


def test_owner_manifest_still_mints_edge_cookie(owned, client) -> None:
    """An AUTHENTICATED owner opening the manifest of their PRIVATE dataset mints the
    viz_ds edge cookie (D-A) — unchanged by D-34."""
    resp = client.get(f"/api/datasets/{WITH_META}/layouts/grid", headers=owned)
    assert resp.status_code == 200
    assert "set-cookie" in resp.headers


def test_owner_of_public_dataset_still_mints_cookie(owned, client, db_path) -> None:
    """The OWNER of a PUBLIC dataset still mints the edge cookie — owner-minting is
    independent of visibility, so the owner reads via the cookie path."""
    _set_visibility(db_path, WITH_META, "public")
    resp = client.get(f"/api/datasets/{WITH_META}/layouts/grid", headers=owned)
    assert resp.status_code == 200
    assert "set-cookie" in resp.headers


def test_non_owner_public_manifest_mints_no_cookie(owned, client, db_path, bob) -> None:
    """R1 (delayed-revocation fix): a NON-OWNER (authenticated) opening a PUBLIC
    dataset's manifest reads it (200) but gets NO viz_ds edge cookie — only the OWNER
    mints one. A non-owner needs no cookie (the public bytes ride the gate's
    public-fast-path, which re-checks visibility every ≤TTL); minting a 1h cookie would
    otherwise let them keep reading the static bytes for up to an hour AFTER the operator
    un-publishes (the private-dataset gate authorizes any valid ds-matching cookie without
    re-checking ownership). No cookie ⇒ nothing to harvest ⇒ the revocation window is
    capped at the ≤TTL edge-cache staleness, not 1h."""
    _set_visibility(db_path, WITH_META, "public")
    resp = client.get(f"/api/datasets/{WITH_META}/layouts/grid", headers=bob)
    assert resp.status_code == 200
    assert "set-cookie" not in resp.headers


# --- GET /api/datasets scoping: public-only vs owned ∪ public --------------


def test_list_anonymous_is_public_only(owned, client, db_path) -> None:
    assert WITH_META not in _list_ids(client, None)  # private → omitted
    _set_visibility(db_path, WITH_META, "public")
    assert WITH_META in _list_ids(client, None)  # public → surfaced


def test_list_owner_sees_owned_union_public(client, db_path, alice, bob) -> None:
    """authenticated ⇒ owned ∪ public. alice owns WITH_META (private); bob owns
    IMAGES_ONLY made public. Each sees their own + the public; neither sees the
    other's private; anonymous sees only the public one."""
    _seed_owner(db_path, WITH_META, "alice")
    _seed_owner(db_path, IMAGES_ONLY, "bob")
    _set_visibility(db_path, IMAGES_ONLY, "public")

    alice_ids = _list_ids(client, alice)
    assert WITH_META in alice_ids  # owned
    assert IMAGES_ONLY in alice_ids  # public

    bob_ids = _list_ids(client, bob)
    assert IMAGES_ONLY in bob_ids  # owned + public
    assert WITH_META not in bob_ids  # alice's private is not disclosed

    assert _list_ids(client, None) == {IMAGES_ONLY}  # anonymous → public only


# --- get_job scoping (app-scan MED-2: the job-log leak) --------------------


def _mock_job_for(monkeypatch, dataset_id: str) -> None:
    """Mock jobs.Job.fetch to return a finished job whose dataset is `dataset_id`."""
    from api.routers import jobs

    fake_job = SimpleNamespace(
        get_status=lambda: "finished",
        kwargs={"dataset_id": dataset_id, "output_root": "/nonexistent"},
        exc_info=None,
        get_meta=lambda refresh=False: {},
        # Seam L1: a FINISHED job's return value is read for JobStatus.result. A real
        # rq.Job always has this; the double has to as well or it is not a double of
        # the interface the route uses.
        return_value=lambda refresh=False: None,
    )
    monkeypatch.setattr(jobs.Job, "fetch", lambda job_id, connection=None: fake_job)


def test_get_job_owner_allowed_200(owned, client, monkeypatch) -> None:
    client.app.state.queue = _FakeQueue()
    _mock_job_for(monkeypatch, WITH_META)
    assert client.get("/api/jobs/j", headers=owned).status_code == 200


def test_get_job_cross_owner_private_is_404(owned, client, bob, monkeypatch) -> None:
    """A job whose dataset is PRIVATE and owned by someone else is 404 to another authed
    user — the same 404 as a missing job (the MED-2 job-log leak, closed)."""
    client.app.state.queue = _FakeQueue()
    _mock_job_for(monkeypatch, WITH_META)
    assert client.get("/api/jobs/j", headers=bob).status_code == 404


def test_get_job_anonymous_private_is_404(owned, client, monkeypatch) -> None:
    client.app.state.queue = _FakeQueue()
    _mock_job_for(monkeypatch, WITH_META)
    assert client.get("/api/jobs/j").status_code == 404


def test_get_job_public_dataset_allowed(owned, client, db_path, bob, monkeypatch) -> None:
    """A job whose dataset is PUBLIC is readable by anyone — a non-owner and even
    anonymously (the showcase's public jobs)."""
    _set_visibility(db_path, WITH_META, "public")
    client.app.state.queue = _FakeQueue()
    _mock_job_for(monkeypatch, WITH_META)
    assert client.get("/api/jobs/j", headers=bob).status_code == 200
    assert client.get("/api/jobs/j").status_code == 200


# --- admin set-visibility round-trips to the read model --------------------


def test_admin_set_visibility_roundtrips_to_reads(owned, client) -> None:
    """The operator lever: `api.admin set-visibility` flips a curated dataset public
    (readable anonymously) and back to private (denied) — driven against the SAME
    app-state DB + DATA_ROOT the app reads (env-shared)."""
    # Private (owned by alice) → anonymous denied.
    assert client.get(f"/api/datasets/{WITH_META}").status_code == 404
    # Publish it via the CLI.
    assert admin.main(["set-visibility", WITH_META, "public"]) == 0
    assert client.get(f"/api/datasets/{WITH_META}").status_code == 200  # now anonymous-readable
    # ...and back to private denies again.
    assert admin.main(["set-visibility", WITH_META, "private"]) == 0
    assert client.get(f"/api/datasets/{WITH_META}").status_code == 404


# --- presented-but-invalid credentials: 401, never silent anonymity ---------


@pytest.mark.parametrize("path", [*_read_routes(WITH_META), "/api/datasets"])
def test_invalid_bearer_is_401_on_every_read_route(owned, client, path) -> None:
    """A PRESENTED credential that fails to resolve (garbage/expired token, unknown
    user) is a 401 on every read route — the same single 401 shape get_current_user
    raises (shared _resolve_user). Anonymous means NO credential: a client whose
    session expired must hear "re-authenticate", not watch its private datasets
    silently vanish behind public-only 404s (the expired-session trap)."""
    resp = client.get(path, headers={"Authorization": "Bearer not-a-valid-token"})
    assert resp.status_code == 401
    assert resp.headers.get("www-authenticate") == "Bearer"


@pytest.mark.parametrize("path", [f"/api/datasets/{WITH_META}", "/api/datasets"])
def test_invalid_bearer_is_401_even_for_public_dataset(
    owned, client, db_path, path
) -> None:
    """The 401 depends ONLY on the credential, never on any dataset — a PUBLIC
    dataset (readable with no credential at all) still 401s a broken credential, so
    the status can never serve as a visibility oracle, and the client-side fix for a
    stale token is the same everywhere: drop it, then read (anonymously or freshly
    logged in)."""
    _set_visibility(db_path, WITH_META, "public")
    resp = client.get(path, headers={"Authorization": "Bearer not-a-valid-token"})
    assert resp.status_code == 401


def test_invalid_bearer_is_401_on_get_job(owned, client, monkeypatch) -> None:
    """get_job takes the same optional-identity dependency, so a broken credential
    401s before any job/dataset resolution runs (nothing about the job leaks)."""
    client.app.state.queue = _FakeQueue()
    _mock_job_for(monkeypatch, WITH_META)
    resp = client.get(
        "/api/jobs/j", headers={"Authorization": "Bearer not-a-valid-token"}
    )
    assert resp.status_code == 401


# --- owner masking: the username is disclosed only to the owner -------------


def test_owner_sees_own_username_in_summary(owned, client) -> None:
    """The owner still sees their own name (the frontend's "yours" affordance)."""
    body = client.get(f"/api/datasets/{WITH_META}", headers=owned).json()
    assert body["owner"] == "alice"


def test_public_summary_masks_owner_from_non_owners(
    owned, client, db_path, bob
) -> None:
    """Publishing a dataset must not publish its owner's ACCOUNT USERNAME (a
    login-credential half and an enumeration aid): anonymous and non-owner viewers
    get the same "" an ownerless dataset shows; only the owner sees their name."""
    _set_visibility(db_path, WITH_META, "public")
    assert client.get(f"/api/datasets/{WITH_META}").json()["owner"] == ""
    assert client.get(f"/api/datasets/{WITH_META}", headers=bob).json()["owner"] == ""
    assert (
        client.get(f"/api/datasets/{WITH_META}", headers=owned).json()["owner"]
        == "alice"
    )


def test_list_masks_owner_for_non_owner_viewers(owned, client, db_path, bob) -> None:
    """The listing applies the same rule per summary: each viewer sees their own
    username on datasets they own and "" on everyone else's."""
    _set_visibility(db_path, WITH_META, "public")

    def owner_shown(headers: dict[str, str] | None) -> str:
        datasets = client.get("/api/datasets", headers=headers or {}).json()["datasets"]
        return {d["dataset_id"]: d["owner"] for d in datasets}[WITH_META]

    assert owner_shown(None) == ""  # anonymous viewer of the public dataset
    assert owner_shown(bob) == ""  # authed non-owner
    assert owner_shown(owned) == "alice"  # the owner themself
