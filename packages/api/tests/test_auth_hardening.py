"""Tier-1 pins for the two SEC-1 auth gates: ALLOW_SIGNUP and the in-process rate
limit on /api/auth/*.

THE OBVIOUS RATE-LIMIT TEST IS VACUOUS, and vacuous in the exact direction of the
bug it is supposed to catch. "after N requests the route returns 429" passes just
as happily when EVERY client shares ONE bucket — which is the failure mode:
`request.client.host` behind the Caddy edge is the proxy's container address, so a
limiter keyed on it hands the whole demo a single budget and one attacker locks
everyone out. A single-client test cannot tell that apart from a working limiter.

So the keying is pinned from BOTH sides, and the two pins fail in OPPOSITE
directions — a naive fix for one reintroduces the other:

  * test_two_clients_have_independent_budgets   goes red if the key becomes
                                                request.client.host (one shared bucket)
  * test_forwarded_prefix_cannot_mint_a_budget  goes red if the key becomes the
                                                LEFTMOST X-Forwarded-For entry
                                                (client-supplied ⇒ forgeable)

Each client fixture here builds its OWN app (create_app) after setting env, since
the limiter is constructed during create_app and the shared conftest `client`
fixture is built before a test body can monkeypatch anything.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from api.routers import auth

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
# A username that does not exist: login answers 401 after exactly one (dummy)
# argon2 verify, which is all these pins need.
_BAD_LOGIN = {"username": "nobody", "password": "wrongpassword"}

_LOGIN = "/api/auth/login"
_ME = "/api/auth/me"
_SIGNUP_URL = "/api/auth/signup"

# Two addresses of the shape Caddy writes into X-Forwarded-For (TEST-NET-3,
# RFC 5737 — never routable, so nothing here can be mistaken for a real host).
_CLIENT_A = "203.0.113.7"
_CLIENT_B = "203.0.113.8"


@contextmanager
def _app_client(tmp_path, monkeypatch, **env: str) -> Iterator[TestClient]:
    """A TestClient over a freshly built app, with `env` applied first.

    Production cases must also set JWT_SECRET + ALLOWED_ORIGINS: APP_ENV=production
    arms the pre-existing fail-closed guards (appstate._jwt_secret,
    main._resolve_cors_origins), which would otherwise refuse to boot long before
    the signup flag is reached. That is the deployment's real shape, not a
    workaround."""
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


_PROD_ENV = {
    "APP_ENV": "production",
    "JWT_SECRET": "x" * 48,
    "ALLOWED_ORIGINS": "https://app.example.com",
}


# ---------------------------------------------------------------------------
# Item A — ALLOW_SIGNUP.
# ---------------------------------------------------------------------------


def test_production_signup_is_refused_by_default(tmp_path, monkeypatch) -> None:
    """THE SIGNUP-DEFAULT PIN. APP_ENV=production with ALLOW_SIGNUP unset refuses
    account creation, and says so without leaking why."""
    monkeypatch.delenv("ALLOW_SIGNUP", raising=False)
    with _app_client(tmp_path, monkeypatch, **_PROD_ENV) as client:
        response = client.post(_SIGNUP_URL, json=_SIGNUP)
    assert response.status_code == 403
    detail = response.json()["detail"]
    assert detail == "Account creation is disabled on this server."
    # Non-leaky: nothing about the env, the flag, or the deployment.
    assert "ALLOW_SIGNUP" not in detail and "production" not in detail


def test_production_signup_can_be_switched_back_on(tmp_path, monkeypatch) -> None:
    """A safe default, NOT a removal: a self-hoster who wants public registration
    sets ALLOW_SIGNUP and gets a working route in production."""
    with _app_client(
        tmp_path, monkeypatch, ALLOW_SIGNUP="true", **_PROD_ENV
    ) as client:
        response = client.post(_SIGNUP_URL, json=_SIGNUP)
    assert response.status_code == 200
    assert response.json() == {"username": "alice", "email": "alice@example.com"}


def test_development_signup_is_open_by_default(tmp_path, monkeypatch) -> None:
    """Development is UNCHANGED — no env set, signup works. This is what keeps
    every pre-existing test that creates a user passing untouched."""
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("ALLOW_SIGNUP", raising=False)
    with _app_client(tmp_path, monkeypatch) as client:
        assert client.post(_SIGNUP_URL, json=_SIGNUP).status_code == 200


def test_development_signup_can_be_switched_off(tmp_path, monkeypatch) -> None:
    """The flag is honoured in both directions — an operator can close signup on a
    host that is not marked production."""
    monkeypatch.delenv("APP_ENV", raising=False)
    with _app_client(tmp_path, monkeypatch, ALLOW_SIGNUP="0") as client:
        assert client.post(_SIGNUP_URL, json=_SIGNUP).status_code == 403


@pytest.mark.parametrize("value", ["treu", "maybe", "2", ""])
def test_signup_flag_vocabulary(monkeypatch, value: str) -> None:
    """A typo'd flag is a configuration ERROR, refused at boot by
    verify_signup_config, not silently resolved to either answer. The blank case is
    the one exception: it means "unset", so it falls through to the env default."""
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.setenv("ALLOW_SIGNUP", value)
    if value == "":
        assert auth.verify_signup_config() is None
        return
    with pytest.raises(RuntimeError, match="ALLOW_SIGNUP"):
        auth.verify_signup_config()


def test_signup_flag_default_tracks_app_env(monkeypatch) -> None:
    """The default is derived from APP_ENV, not hard-coded per environment."""
    monkeypatch.delenv("ALLOW_SIGNUP", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    assert auth._signup_enabled() is True
    monkeypatch.setenv("APP_ENV", "production")
    assert auth._signup_enabled() is False
    monkeypatch.setenv("APP_ENV", "prod")
    assert auth._signup_enabled() is False


# ---------------------------------------------------------------------------
# Item B — the rate limit. Keying first, because that is the whole risk.
# ---------------------------------------------------------------------------


def test_two_clients_have_independent_budgets(tmp_path, monkeypatch) -> None:
    """THE INDEPENDENCE PIN — the one the obvious "N requests then 429" test cannot
    make.

    Client A exhausts its budget; client B, arriving at the same API from a
    different forwarded address, is still served. Keyed on request.client.host
    (Caddy's container IP, i.e. the §4 bug) both clients land in ONE bucket and B's
    first request is turned away — a self-inflicted denial of service that looks
    exactly like the limiter working."""
    with _app_client(tmp_path, monkeypatch, AUTH_RATE_LIMIT="3") as client:
        for attempt in range(3):
            response = client.post(
                _LOGIN, json=_BAD_LOGIN, headers={"X-Forwarded-For": _CLIENT_A}
            )
            assert response.status_code == 401, f"A attempt {attempt + 1}"
        # A is spent.
        assert (
            client.post(
                _LOGIN, json=_BAD_LOGIN, headers={"X-Forwarded-For": _CLIENT_A}
            ).status_code
            == 429
        )
        # B is untouched: a different visitor still gets in.
        assert (
            client.post(
                _LOGIN, json=_BAD_LOGIN, headers={"X-Forwarded-For": _CLIENT_B}
            ).status_code
            == 401
        )


def test_forwarded_prefix_cannot_mint_a_budget(tmp_path, monkeypatch) -> None:
    """THE ANTI-SPOOF PIN, and the opposite failure to the one above.

    The key is the RIGHTMOST X-Forwarded-For entry — the one the nearest proxy
    wrote. Entries a client prepends are ignored, so it cannot hand itself a fresh
    budget by varying the header. Keyed on the LEFTMOST entry the last request here
    looks like a brand-new visitor and sails through, and the limit is evadable at
    will."""
    with _app_client(tmp_path, monkeypatch, AUTH_RATE_LIMIT="3") as client:
        for attempt in range(3):
            response = client.post(
                _LOGIN, json=_BAD_LOGIN, headers={"X-Forwarded-For": _CLIENT_A}
            )
            assert response.status_code == 401, f"attempt {attempt + 1}"
        # Same real peer, but with a client-chosen entry prepended — the shape a
        # spoofing client produces when the proxy appends rather than replaces.
        spoofed = client.post(
            _LOGIN,
            json=_BAD_LOGIN,
            headers={"X-Forwarded-For": f"198.51.100.9, {_CLIENT_A}"},
        )
        assert spoofed.status_code == 429
        # Also across separate header instances, which HTTP allows and Starlette
        # keeps as distinct values.
        multi = client.post(
            _LOGIN,
            json=_BAD_LOGIN,
            headers=[("X-Forwarded-For", "198.51.100.9"), ("X-Forwarded-For", _CLIENT_A)],
        )
        assert multi.status_code == 429


def test_limited_response_is_429_with_retry_after(tmp_path, monkeypatch) -> None:
    """DoD 4: a limited response is a 429 carrying a usable Retry-After, in whole
    seconds, never below 1 (a client told to wait 0s just hammers)."""
    with _app_client(
        tmp_path, monkeypatch, AUTH_RATE_LIMIT="2", AUTH_RATE_LIMIT_WINDOW_SECONDS="60"
    ) as client:
        headers = {"X-Forwarded-For": _CLIENT_A}
        for _ in range(2):
            assert client.post(_LOGIN, json=_BAD_LOGIN, headers=headers).status_code == 401
        response = client.post(_LOGIN, json=_BAD_LOGIN, headers=headers)
    assert response.status_code == 429
    retry_after = int(response.headers["Retry-After"])
    assert 1 <= retry_after <= 60


def test_budgets_are_per_route(tmp_path, monkeypatch) -> None:
    """Each route counts separately, so /api/auth/me (which a frontend may poll)
    can never spend the login budget — login is the door that matters."""
    with _app_client(tmp_path, monkeypatch, AUTH_RATE_LIMIT="2") as client:
        headers = {"X-Forwarded-For": _CLIENT_A}
        for _ in range(2):
            assert client.post(_LOGIN, json=_BAD_LOGIN, headers=headers).status_code == 401
        assert client.post(_LOGIN, json=_BAD_LOGIN, headers=headers).status_code == 429
        # Same client, different route: its own budget.
        assert client.get(_ME, headers=headers).status_code == 401


def test_all_three_auth_routes_are_limited(tmp_path, monkeypatch) -> None:
    """DoD 2: signup, login AND me are covered — not just the interesting one."""
    with _app_client(tmp_path, monkeypatch, AUTH_RATE_LIMIT="1") as client:
        headers = {"X-Forwarded-For": _CLIENT_A}
        assert client.post(_SIGNUP_URL, json=_SIGNUP, headers=headers).status_code == 200
        assert client.post(_SIGNUP_URL, json=_SIGNUP, headers=headers).status_code == 429

        assert client.post(_LOGIN, json=_BAD_LOGIN, headers=headers).status_code == 401
        assert client.post(_LOGIN, json=_BAD_LOGIN, headers=headers).status_code == 429

        assert client.get(_ME, headers=headers).status_code == 401
        assert client.get(_ME, headers=headers).status_code == 429


def test_unproxied_clients_fall_back_to_the_direct_peer(tmp_path, monkeypatch) -> None:
    """With no X-Forwarded-For (dev, tests, any unproxied deployment) the direct
    peer is the key, so the limiter still works rather than lumping everyone under
    a constant."""
    with _app_client(tmp_path, monkeypatch, AUTH_RATE_LIMIT="1") as client:
        assert client.post(_LOGIN, json=_BAD_LOGIN).status_code == 401
        assert client.post(_LOGIN, json=_BAD_LOGIN).status_code == 429


def test_rate_limit_is_in_process_not_redis(tmp_path, monkeypatch) -> None:
    """§3: the limiter MUST NOT need the broker. The public compose declares no
    redis service, so point REDIS_URL at a closed port — a Redis-backed limiter
    would raise/hang on the first login here, while this one is unaffected."""
    with _app_client(
        tmp_path,
        monkeypatch,
        AUTH_RATE_LIMIT="1",
        REDIS_URL="redis://127.0.0.1:1/0",
    ) as client:
        assert client.post(_LOGIN, json=_BAD_LOGIN).status_code == 401
        assert client.post(_LOGIN, json=_BAD_LOGIN).status_code == 429


# ---------------------------------------------------------------------------
# The counter itself — driven with an injected clock, so no test sleeps.
# ---------------------------------------------------------------------------


def test_window_resets_after_it_expires() -> None:
    limiter = auth.AuthRateLimiter(limit=2, window_seconds=60.0)
    assert limiter.check("k", 1000.0) is None
    assert limiter.check("k", 1000.5) is None
    remaining = limiter.check("k", 1001.0)
    assert remaining is not None and remaining == pytest.approx(59.0)
    # Still inside the window at the last instant before it rolls over...
    assert limiter.check("k", 1059.9) is not None
    # ...and open again once it has.
    assert limiter.check("k", 1060.0) is None


def test_expired_windows_are_swept_so_the_map_stays_bounded() -> None:
    """Memory is bounded by traffic, not by a chosen cap: a sweep runs at most once
    per window, so entries linger for at most one sweep interval."""
    limiter = auth.AuthRateLimiter(limit=5, window_seconds=60.0)
    for index in range(100):
        assert limiter.check(f"client-{index}", 1000.0) is None
    assert len(limiter._windows) == 100
    # One window later a single request triggers the sweep; the 100 stale entries go.
    assert limiter.check("late", 1061.0) is None
    assert set(limiter._windows) == {"late"}


@pytest.mark.parametrize(
    "name", ["AUTH_RATE_LIMIT", "AUTH_RATE_LIMIT_WINDOW_SECONDS"]
)
@pytest.mark.parametrize("value", ["nope", "0", "-1"])
def test_rate_limit_config_is_validated(monkeypatch, name: str, value: str) -> None:
    """A malformed or non-positive limit is a hard config error at construction —
    the appstate._ttl_seconds shape — not a silent fallback that leaves the door
    unthrottled."""
    monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError, match=name):
        auth.build_rate_limiter()


def test_rate_limit_defaults(monkeypatch) -> None:
    """Unset env yields the documented defaults (10 per 60s)."""
    monkeypatch.delenv("AUTH_RATE_LIMIT", raising=False)
    monkeypatch.delenv("AUTH_RATE_LIMIT_WINDOW_SECONDS", raising=False)
    limiter = auth.build_rate_limiter()
    assert (limiter.limit, limiter.window_seconds) == (10, 60.0)
