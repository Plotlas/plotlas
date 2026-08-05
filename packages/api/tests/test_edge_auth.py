"""Tier-1 tests for the static-edge auth seam (T2-09, decision D-A).

Two surfaces:
  * ISSUANCE — the manifest GET (routers/layouts.py) sets the HttpOnly, path-scoped,
    dataset-scoped `viz_ds` cookie carrying a 1-hour `{ds, sub, exp}` JWT.
  * THE GATE — GET /api/authz/datasets (routers/authz.py), the Caddy forward_auth
    endpoint: a stateless, DB-free verify that answers 200 / 401 / 403 from the
    forwarded original URI + the cookie alone.

The gate takes no `get_session`/`get_current_user` dependency, so its handler is
driven directly (asyncio.run) with just headers + cookie — which also PROVES the
no-DB property structurally (there is no session to touch). Issuance is exercised
through the real auth + read path via TestClient, reusing the golden-fixture
DATA_ROOT setup from test_read_serve.
"""

from __future__ import annotations

import asyncio
import shutil
import tempfile
import time
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import jwt
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from api import appstate
from api.routers import authz, layouts

# Repo-root tests/fixtures/ (this file is packages/api/tests/test_edge_auth.py).
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
DATASET = "golden_dataset_v2"  # the fixture's manifest dataset_id
LAYOUT = "grid"

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


# --- fixtures (mirror test_read_serve's DATA_ROOT-with-golden-fixture setup) ---


@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    """A TestClient over a DATA_ROOT whose datasets/ subtree (D-30) surfaces the
    golden fixture, plus a fresh per-test app-state DB."""
    data_root = tmp_path / "data"
    (data_root / "datasets").mkdir(parents=True)
    shutil.copytree(FIXTURES / DATASET, data_root / "datasets" / DATASET)
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


def _seed_owner_visibility(
    db_path: Path, dataset_id: str, owner: str, visibility: str
) -> None:
    """Record `dataset_id -> owner` (owner must already exist — the signup) and set its
    D-34 visibility, via a second engine over the same SQLite file (one asyncio.run
    loop). Lets the issuance tests own DATASET (private) and the public-gate tests flip
    it public."""

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
                await appstate.set_dataset_visibility(session, dataset_id, visibility)
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture(autouse=True)
def _clear_visibility_cache() -> Iterator[None]:
    """The authz public-fast-path cache is module-level (a perf cache over app-state),
    so clear it around every test to stop one test's `ds_id -> is_public` verdict from
    bleeding into another."""
    authz._visibility_cache.clear()
    yield
    authz._visibility_cache.clear()


@pytest.fixture
def auth(client, tmp_path) -> dict[str, str]:
    """Sign up + log in 'alice', and seed her as owner of DATASET (private) so the D-34
    read model authorizes her manifest opens (dataset-open mints the edge cookie). The
    app-state DB is the client fixture's `tmp_path/appstate.db`."""
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    _seed_owner_visibility(tmp_path / "appstate.db", DATASET, "alice", "private")
    return {"Authorization": f"Bearer {token}"}


def _dataset_token(ds_id: str, *, sub: str = "alice", expires_in: int = 3600) -> str:
    """Mint a dataset-scoped edge token the way _mint_dataset_token does (same dev
    secret + alg, since APP_ENV is unset in tests), with caller-chosen ds/exp so
    the gate matrix can forge expired / wrong-dataset credentials."""
    exp = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    return jwt.encode(
        {"ds": ds_id, "sub": sub, "exp": exp},
        appstate._jwt_secret(),
        algorithm=appstate._JWT_ALGORITHM,
    )


# --- issuance (manifest GET sets the cookie) -------------------------------


def test_manifest_get_sets_dataset_cookie_with_attrs(client, auth) -> None:
    """A successful manifest GET (dataset-open) sets viz_ds: HttpOnly, path-scoped
    to /datasets/{ds}/, SameSite=Lax. Plain-http request ⇒ no Secure (D-A)."""
    resp = client.get(f"/api/datasets/{DATASET}/layouts/{LAYOUT}", headers=auth)
    assert resp.status_code == 200

    # The raw Set-Cookie header carries the attributes (httpx's jar drops them).
    set_cookie = resp.headers["set-cookie"]
    assert set_cookie.startswith(f"{layouts.DATASET_COOKIE_NAME}=")
    lowered = set_cookie.lower()
    assert f"path=/datasets/{DATASET}/" in lowered
    assert "httponly" in lowered
    assert "samesite=lax" in lowered
    assert "max-age=3600" in lowered
    assert "secure" not in lowered  # plain http in the test → no Secure


def test_issued_dataset_cookie_claims_are_ds_sub_exp(client, auth) -> None:
    """The cookie's JWT verifies against the shared secret and carries EXACTLY
    {ds, sub, exp}: ds = this dataset, sub = the authenticated user (D-A)."""
    resp = client.get(f"/api/datasets/{DATASET}/layouts/{LAYOUT}", headers=auth)
    token = resp.cookies[layouts.DATASET_COOKIE_NAME]
    claims = jwt.decode(
        token, appstate._jwt_secret(), algorithms=[appstate._JWT_ALGORITHM]
    )
    assert set(claims) == {"ds", "sub", "exp"}
    assert claims["ds"] == DATASET
    assert claims["sub"] == "alice"


def test_manifest_get_sets_secure_cookie_behind_https_edge(client, auth) -> None:
    """Behind Caddy the API sees plain http, but the real client scheme rides in
    X-Forwarded-Proto; an https edge ⇒ the cookie is marked Secure (D-A)."""
    resp = client.get(
        f"/api/datasets/{DATASET}/layouts/{LAYOUT}",
        headers={**auth, "X-Forwarded-Proto": "https"},
    )
    assert resp.status_code == 200
    assert "secure" in resp.headers["set-cookie"].lower()


def test_manifest_get_reissues_cookie_every_time_with_fresh_exp(client, auth) -> None:
    """The server half of the T2-09 residual refresh (D-i addendum): EVERY authed
    manifest GET re-issues the `viz_ds` cookie unconditionally with a FRESH `exp`
    — the frontend's single-flight credential refresh (one manifest re-open on a
    stale-tab 401) relies on this. Two successive opens each set the cookie, and
    the second's `exp` is no earlier than the first's (a fresh 1-hour window)."""
    first = client.get(f"/api/datasets/{DATASET}/layouts/{LAYOUT}", headers=auth)
    assert first.status_code == 200
    assert "set-cookie" in first.headers, "the first open issues a cookie"
    exp_first = jwt.decode(
        first.cookies[layouts.DATASET_COOKIE_NAME],
        appstate._jwt_secret(),
        algorithms=[appstate._JWT_ALGORITHM],
    )["exp"]

    # A second open (the refresh re-fetch) MUST set the cookie again — not rely on
    # the browser's still-valid jar entry — with a refreshed expiry.
    second = client.get(f"/api/datasets/{DATASET}/layouts/{LAYOUT}", headers=auth)
    assert second.status_code == 200
    assert "set-cookie" in second.headers, "every manifest GET re-issues the cookie (unconditional)"
    exp_second = jwt.decode(
        second.cookies[layouts.DATASET_COOKIE_NAME],
        appstate._jwt_secret(),
        algorithms=[appstate._JWT_ALGORITHM],
    )["exp"]
    assert exp_second >= exp_first, "the re-issued cookie carries a fresh (>=) exp"


def test_manifest_get_anonymous_private_is_404_no_cookie(client) -> None:
    """D-34: an anonymous open of a PRIVATE dataset's manifest 404s (get_optional_user
    never 401s; may_read denies → the same 404 as a missing dataset) and mints NO
    cookie. Here DATASET has no owner seeded (the raw `client`, no `auth`), so it is
    private + ownerless → readable by nobody."""
    resp = client.get(f"/api/datasets/{DATASET}/layouts/{LAYOUT}")
    assert resp.status_code == 404
    assert layouts.DATASET_COOKIE_NAME not in resp.cookies
    assert "set-cookie" not in resp.headers


def test_manifest_get_missing_dataset_sets_no_cookie(client, auth) -> None:
    """A 404 (unknown dataset) mints nothing — the cookie is set only after the
    real-dataset checks pass."""
    resp = client.get("/api/datasets/does-not-exist/layouts/grid", headers=auth)
    assert resp.status_code == 404
    assert "set-cookie" not in resp.headers


# --- the gate: GET /api/authz/datasets (driven directly = no-DB by construction) ---


def _authorized_uri(ds_id: str = DATASET) -> str:
    """The ORIGINAL request URI Caddy forwards (pre-strip): /datasets/{ds}/..."""
    return f"/datasets/{ds_id}/tiles/{LAYOUT}/{LAYOUT}_v1.pmtiles"


def _run_gate(uri: str | None, cookie: str | None) -> int:
    """Invoke the gate handler directly with a forwarded URI + cookie and a fake
    request whose sessionmaker is over a FRESH, EMPTY app-state DB — so every ds
    resolves visibility='private' (no row) and the D-34 public-fast-path falls through
    to the cookie path, exactly the private-dataset behaviour these matrix cases
    assert. The visibility cache is cleared first so no prior verdict bleeds in. Returns
    the HTTP status. (The public branch is exercised end-to-end below, via TestClient,
    with a real public row.)"""

    async def _run() -> None:
        # TemporaryDirectory (not a bare mkdtemp) so the throwaway DB dir is removed
        # when the gate call finishes — the matrix invokes this helper many times per
        # run and must not leak a temp dir per case.
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "gate-appstate.db"
            engine, sessionmaker = await appstate.setup_appstate(db_path)
            authz._visibility_cache.clear()
            request = SimpleNamespace(
                app=SimpleNamespace(
                    state=SimpleNamespace(appstate_sessionmaker=sessionmaker)
                )
            )
            try:
                await authz.authorize_dataset_asset(
                    request, x_forwarded_uri=uri, viz_ds=cookie
                )
            finally:
                await engine.dispose()

    try:
        asyncio.run(_run())
    except HTTPException as exc:
        return exc.status_code
    return 200


def test_gate_valid_cookie_matching_dataset_is_200() -> None:
    assert _run_gate(_authorized_uri(), _dataset_token(DATASET)) == 200


def test_gate_missing_cookie_is_401() -> None:
    assert _run_gate(_authorized_uri(), None) == 401


def test_gate_expired_cookie_is_401() -> None:
    assert _run_gate(_authorized_uri(), _dataset_token(DATASET, expires_in=-10)) == 401


def test_gate_garbage_cookie_is_401() -> None:
    assert _run_gate(_authorized_uri(), "not.a.valid.jwt") == 401


def test_gate_cookie_for_other_dataset_is_403() -> None:
    """A valid, unexpired token minted for a DIFFERENT dataset must not unlock this
    one — the ds-claim check is the real authorization boundary (path scope alone
    is not trusted)."""
    assert _run_gate(_authorized_uri(DATASET), _dataset_token("some_other_ds")) == 403


def test_gate_missing_forwarded_uri_is_403() -> None:
    """A direct hit with no X-Forwarded-Uri (not a real edge sub-request) → 403."""
    assert _run_gate(None, _dataset_token(DATASET)) == 403


@pytest.mark.parametrize(
    "uri",
    [
        "/not-datasets/foo/bar",  # wrong prefix
        "/datasets/",  # no id segment
        "/datasets",  # no trailing / or id
        "/datasets/../etc/passwd",  # traversal in the id slot
        "/datasets/../etc",  # traversal in the id slot, no trailing seg
        "/datasets/..",  # bare traversal
        # R-S10: `..` MUST be caught wherever it sits, not only the id slot — the
        # gate now decodes+rejects to match file_server's decode-then-resolve.
        "/datasets/%2e%2e/etc/passwd",  # encoded (%2e%2e) id-slot traversal
        # Mid-path, and NOT an escape past root despite the shape: file_server
        # re-jails the cleaned path under its own root, so this resolves to
        # {DATA_ROOT}/datasets/etc/passwd — a SIBLING DATASET named "etc", never the
        # system file. It is a cross-dataset reach, which is precisely what the gate
        # must refuse: the root-jail does not, and cannot, police dataset crossings.
        f"/datasets/{DATASET}/tiles/../../etc/passwd",  # mid-path cross-dataset reach
    ],
)
def test_gate_malformed_or_traversal_uri_is_403(uri) -> None:
    """A URI that is not /datasets/{clean-id}/... — wrong prefix, empty id, or a
    traversal probe (literal, encoded, or mid-path) — is 403 (never a 401 a cookie
    could satisfy). The endpoint reads nothing off disk, so the jail is purely a
    normalize-and-shape check here."""
    assert _run_gate(uri, _dataset_token(DATASET)) == 403


def test_gate_traversal_crossing_datasets_is_rejected() -> None:
    """R-S10 / Seam H2 regression — the core bug: a VALID cookie for dataset A must
    NOT authorize a URI that traverses to dataset B. Caddy's `file_server` resolves
    `/datasets/A/../B/...` to B's bytes, but the gate used to read the id off the
    raw (un-normalized) path — it saw "A", the A cookie matched, and B was served.
    The gate now normalizes to file_server's view and rejects the `..` outright, so
    the A credential can never unlock B. This is the prerequisite for the D-34
    private/public visibility model (under which A could be public and B private).

    The clean-A-path control 200 proves it is the TRAVERSAL, not the credential,
    being rejected — the very same A cookie authorizes A's own asset."""
    a_cookie = _dataset_token("dataset_a")
    # Control: the credential is valid and DOES authorize A's own clean path.
    assert _run_gate("/datasets/dataset_a/tiles/grid/grid_v1.pmtiles", a_cookie) == 200
    # The bug: `..` resolves to dataset_b — must be rejected (pre-fix this was 200).
    assert (
        _run_gate("/datasets/dataset_a/../dataset_b/tiles/grid/grid_v1.pmtiles", a_cookie)
        == 403
    )
    # ...and the percent-encoded spelling is caught too (urlsplit leaves the path
    # encoded, so the gate decodes to file_server's view before the `..` check).
    assert (
        _run_gate(
            "/datasets/dataset_a/%2e%2e/dataset_b/tiles/grid/grid_v1.pmtiles", a_cookie
        )
        == 403
    )


def test_gate_encoded_separator_resolves_to_the_real_ds_id() -> None:
    """`%2f` is a SEPARATOR to file_server (Go decodes the path before serving), so
    the gate must read the id the same way: `/datasets/{ds}%2ftiles/...` targets
    {ds}'s OWN asset, and {ds}'s cookie is the right credential for it.

    Pinned because the R-S10 decode is a 403→200 WIDENING inside an auth function:
    before it, the gate read the id as the whole literal "{ds}%2ftiles%2f..." segment
    and 403'd every such fetch. The second assertion is the one that earns its keep —
    the widening must not have cost us the boundary: it is still the ds-claim, not
    the path spelling, that authorizes."""
    encoded = f"/datasets/{DATASET}%2ftiles%2f{LAYOUT}%2f{LAYOUT}_v1.pmtiles"
    assert _run_gate(encoded, _dataset_token(DATASET)) == 200
    assert _run_gate(encoded, _dataset_token("some_other_ds")) == 403


def test_gate_double_encoded_dotdot_is_not_a_traversal() -> None:
    """The gate must decode EXACTLY ONCE — the number of decodes file_server does.

    `%252e%252e` decodes once to the literal text "%2e%2e", which file_server treats
    as an ordinary directory NAME (it does not decode again), so the path stays inside
    {ds} and {ds}'s cookie is the correct credential. A decode-until-stable loop here
    would read it as ".." and 403 a fetch Caddy serves happily — fail-closed, but a
    silent divergence from the very gate↔file_server contract R-S10 exists to keep.
    This pins which side of the line the double-encoded spelling sits on, so that loop
    is not introduced later by a well-meaning "harden the decode" change."""
    double = f"/datasets/{DATASET}/%252e%252e/tiles/{LAYOUT}/{LAYOUT}_v1.pmtiles"
    assert _run_gate(double, _dataset_token(DATASET)) == 200
    assert _run_gate(double, _dataset_token("some_other_ds")) == 403


def test_gate_signature_from_wrong_secret_is_401() -> None:
    """A token signed with a different secret fails the signature check → 401
    (the gate trusts only tokens the API itself minted)."""
    forged = jwt.encode(
        {
            "ds": DATASET,
            "sub": "alice",
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        },
        "a-totally-different-secret-value-not-ours",
        algorithm=appstate._JWT_ALGORITHM,
    )
    assert _run_gate(_authorized_uri(), forged) == 401


# --- end-to-end: the issued cookie satisfies the gate ----------------------


def test_issued_cookie_satisfies_the_gate(client, auth) -> None:
    """The cookie minted by a real manifest open verifies at the gate for that
    dataset — the two surfaces agree on secret, alg, claim shape, and id."""
    resp = client.get(f"/api/datasets/{DATASET}/layouts/{LAYOUT}", headers=auth)
    token = resp.cookies[layouts.DATASET_COOKIE_NAME]
    assert _run_gate(_authorized_uri(DATASET), token) == 200
    # ...and does NOT satisfy the gate for a different dataset id.
    assert _run_gate(_authorized_uri("another_ds"), token) == 403


# --- D-34 public-fast-path (the login-less showcase) -----------------------


def test_gate_public_dataset_is_2xx_without_cookie(client, auth, tmp_path) -> None:
    """D-34 public-fast-path: a PUBLIC dataset's /datasets/* fetch is authorized at the
    gate with NO cookie — the login-less showcase serves its bytes with no credential.
    Driven end-to-end through the real endpoint (TestClient), so it uses the app's real
    app-state sessionmaker + the visibility cache. `auth` seeds alice as DATASET's
    owner; we flip it public."""
    _seed_owner_visibility(tmp_path / "appstate.db", DATASET, "alice", "public")
    resp = client.get(
        "/api/authz/datasets",
        headers={"X-Forwarded-Uri": _authorized_uri(DATASET)},
    )
    assert resp.status_code == 200


def test_gate_private_dataset_without_cookie_is_401(client, auth, tmp_path) -> None:
    """Contrast: a PRIVATE dataset (auth seeds DATASET owner=alice, private) still
    requires the cookie at the gate — no cookie ⇒ 401, unchanged by D-34."""
    resp = client.get(
        "/api/authz/datasets",
        headers={"X-Forwarded-Uri": _authorized_uri(DATASET)},
    )
    assert resp.status_code == 401


def test_gate_public_dataset_served_despite_wrong_cookie(client, auth, tmp_path) -> None:
    """A public dataset is served even when a cookie minted for ANOTHER dataset is
    presented — the public-fast-path short-circuits before the ds-claim check, so the
    showcase never 403s a public tile on a stale cross-dataset cookie."""
    _seed_owner_visibility(tmp_path / "appstate.db", DATASET, "alice", "public")
    resp = client.get(
        "/api/authz/datasets",
        headers={
            "X-Forwarded-Uri": _authorized_uri(DATASET),
            "Cookie": f"{layouts.DATASET_COOKIE_NAME}={_dataset_token('some_other_ds')}",
        },
    )
    assert resp.status_code == 200


def test_visibility_cache_serves_stale_then_refreshes_after_ttl(tmp_path) -> None:
    """The D-34 public-fast-path cache returns a cached verdict within its TTL, then
    refreshes to the live app-state value once the entry expires — so the per-tile
    fan-out stays off the DB after warmup (the D-A perf premise) and a visibility flip
    still propagates within the TTL. Deterministic (no sleep): the entry's expiry is
    forced into the past to trigger the refresh."""

    async def _run() -> None:
        db_path = tmp_path / "cache-appstate.db"
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        authz._visibility_cache.clear()
        try:
            async with sessionmaker() as s:
                s.add(
                    appstate.User(
                        username="op",
                        email="op@example.com",
                        password_hash=appstate.hash_password("s3cretpw"),
                    )
                )
                await s.commit()
                await appstate.record_dataset_owner(s, "ds_cache", "op")
                await appstate.set_dataset_visibility(s, "ds_cache", "public")
            # cold miss → reads app-state → public
            assert await authz._dataset_is_public(sessionmaker, "ds_cache") is True
            # flip to private in the DB
            async with sessionmaker() as s:
                await appstate.set_dataset_visibility(s, "ds_cache", "private")
            # within TTL: STILL cached public (proves the DB was not re-read)
            assert await authz._dataset_is_public(sessionmaker, "ds_cache") is True
            # force the entry to age out → the next call refreshes to the live value
            # (entries are (is_public, stored_at_monotonic); -inf is older than any TTL)
            is_pub, _stored_at = authz._visibility_cache["ds_cache"]
            authz._visibility_cache["ds_cache"] = (is_pub, float("-inf"))
            assert await authz._dataset_is_public(sessionmaker, "ds_cache") is False
        finally:
            await engine.dispose()

    asyncio.run(_run())


def test_gate_overlong_dataset_id_is_403_and_never_cached() -> None:
    """An id over 255 bytes cannot name a real dataset (no mainstream filesystem
    allows a longer directory name), so the gate 403s it in _extract_ds_id — BEFORE
    the visibility lookup, which both rejects the probe and keeps multi-KB
    attacker-chosen keys out of the visibility cache (the memory-DoS guard's length
    half). The boundary id (exactly 255) still passes extraction and falls through
    to the normal private-dataset cookie path (401, and it may be cached — it is a
    legitimate id shape)."""
    authz._visibility_cache.clear()
    assert _run_gate(_authorized_uri("x" * 256), None) == 403
    assert "x" * 256 not in authz._visibility_cache  # rejected before the cache
    assert _run_gate(_authorized_uri("x" * 255), None) == 401  # legit shape → cookie path


def test_visibility_cache_size_is_bounded(tmp_path, monkeypatch) -> None:
    """The visibility cache must never grow past _VISIBILITY_CACHE_MAX (the gate is
    pre-auth, so unbounded growth keyed by attacker-chosen ids is a memory-exhaustion
    DoS). At the cap: aged-out entries are dropped first; if every survivor is still
    fresh the whole cache is cleared (a perf cache is always safe to rebuild).
    Deterministic — entries are planted with forged stored_at values, no sleep."""

    async def _run() -> None:
        db_path = tmp_path / "bound-appstate.db"
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        monkeypatch.setattr(authz, "_VISIBILITY_CACHE_MAX", 3)
        try:
            # Case 1: the cache is full of STALE entries → the insert path drops them
            # and the new entry lands; the cap holds.
            authz._visibility_cache.clear()
            for key in ("a", "b", "c"):
                authz._visibility_cache[key] = (False, float("-inf"))
            assert await authz._dataset_is_public(sessionmaker, "d") is False
            assert set(authz._visibility_cache) == {"d"}  # stale trio evicted

            # Case 2: the cache is full of FRESH entries → nothing is aged out, so
            # the whole cache is cleared before the new entry lands; the cap holds.
            now = time.monotonic()
            authz._visibility_cache.clear()
            for key in ("d", "e", "f"):
                authz._visibility_cache[key] = (False, now)
            assert await authz._dataset_is_public(sessionmaker, "g") is False
            assert set(authz._visibility_cache) == {"g"}  # fresh trio cleared
            assert len(authz._visibility_cache) <= 3

            # A re-lookup of an ALREADY-CACHED id never triggers eviction (the guard
            # is insert-only): refresh "g" and the size is unchanged.
            authz._visibility_cache["g"] = (False, float("-inf"))
            assert await authz._dataset_is_public(sessionmaker, "g") is False
            assert set(authz._visibility_cache) == {"g"}
        finally:
            await engine.dispose()

    asyncio.run(_run())


def test_gate_deny_path_recheck_serves_just_published(tmp_path) -> None:
    """D-34 publish propagation: a dataset flipped PUBLIC must start serving at the
    gate within _DENY_RECHECK_SECONDS — not a full serve-path TTL of 401-retry loops.
    The deny path (cookie verify failed) rechecks visibility on the tighter bound
    before denying; a verdict FRESHER than that bound is still served from cache
    (proving repeated denials cost at most one DB read per recheck window).
    Deterministic: the cached entry's stored_at is forged to age it, no sleep."""

    async def _run() -> None:
        db_path = tmp_path / "recheck-appstate.db"
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        authz._visibility_cache.clear()
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(appstate_sessionmaker=sessionmaker))
        )

        async def _gate_status() -> int:
            try:
                await authz.authorize_dataset_asset(
                    request, x_forwarded_uri=_authorized_uri("ds_pub"), viz_ds=None
                )
            except HTTPException as exc:
                return exc.status_code
            return 200

        try:
            async with sessionmaker() as s:
                s.add(
                    appstate.User(
                        username="op",
                        email="op@example.com",
                        password_hash=appstate.hash_password("s3cretpw"),
                    )
                )
                await s.commit()
                await appstate.record_dataset_owner(s, "ds_pub", "op")
            # Private + no cookie → 401, and the private verdict is now cached.
            assert await _gate_status() == 401
            # Publish it. The cached verdict is FRESH (younger than the deny window),
            # so an immediate retry is still denied FROM CACHE — the recheck is
            # bounded, not a per-request DB read.
            async with sessionmaker() as s:
                await appstate.set_dataset_visibility(s, "ds_pub", "public")
            assert await _gate_status() == 401
            # Age the entry past the deny window but WITHIN the serve TTL: the serve
            # fast-path would still say private, so a 200 here can only come from the
            # deny-path recheck re-reading app-state.
            is_pub, stored_at = authz._visibility_cache["ds_pub"]
            assert is_pub is False
            aged = time.monotonic() - (authz._DENY_RECHECK_SECONDS + 1.0)
            assert aged > time.monotonic() - authz._VISIBILITY_TTL_SECONDS
            authz._visibility_cache["ds_pub"] = (is_pub, aged)
            assert await _gate_status() == 200
        finally:
            await engine.dispose()

    asyncio.run(_run())
