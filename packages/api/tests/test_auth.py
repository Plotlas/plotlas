"""Tier-1 tests for the API auth / app-state foundation (seam 10a, brief §3).

Covers the signup -> login -> me round-trip, conflict/credential failures, the
identity-only JWT claim shape, and the dataset-owner primitives. Async app-state
functions are driven via asyncio.run (no pytest-asyncio dependency).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from sqlalchemy.exc import IntegrityError

from api import appstate, main

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


def test_signup_login_me_roundtrip(client) -> None:
    r = client.post("/api/auth/signup", json=_SIGNUP)
    assert r.status_code == 200
    assert r.json() == {"username": "alice", "email": "alice@example.com"}

    r = client.post("/api/auth/login", json=_LOGIN)
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    token = body["access_token"]

    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"username": "alice", "email": "alice@example.com"}


def test_duplicate_username_or_email_conflicts(client) -> None:
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    # Same username, different email -> 409.
    assert (
        client.post(
            "/api/auth/signup", json={**_SIGNUP, "email": "other@example.com"}
        ).status_code
        == 409
    )
    # Same email, different username -> 409.
    assert (
        client.post(
            "/api/auth/signup", json={**_SIGNUP, "username": "bob"}
        ).status_code
        == 409
    )


def test_login_bad_password_is_401(client) -> None:
    client.post("/api/auth/signup", json=_SIGNUP)
    r = client.post("/api/auth/login", json={"username": "alice", "password": "nope1234"})
    assert r.status_code == 401


def test_me_without_or_with_invalid_token_is_401(client) -> None:
    assert client.get("/api/auth/me").status_code == 401
    assert (
        client.get(
            "/api/auth/me", headers={"Authorization": "Bearer not.a.valid.jwt"}
        ).status_code
        == 401
    )


def test_issued_jwt_is_identity_only(client) -> None:
    """Directive #3: the token carries ONLY sub + exp — no authz claims."""
    client.post("/api/auth/signup", json=_SIGNUP)
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]

    claims = jwt.decode(token, options={"verify_signature": False})
    assert set(claims) == {"sub", "exp"}
    assert claims["sub"] == "alice"


def test_record_and_get_dataset_owner(tmp_path) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(tmp_path / "appstate.db")
        try:
            async with sessionmaker() as session:
                session.add_all(
                    [
                        appstate.User(
                            username="alice",
                            email="alice@example.com",
                            password_hash=appstate.hash_password("s3cretpw"),
                        ),
                        appstate.User(
                            username="bob",
                            email="bob@example.com",
                            password_hash=appstate.hash_password("s3cretpw"),
                        ),
                    ]
                )
                await session.commit()

                await appstate.record_dataset_owner(session, "ds_1", "alice")
                assert await appstate.get_dataset_owner(session, "ds_1") == "alice"
                # Unknown dataset -> None.
                assert await appstate.get_dataset_owner(session, "missing") is None
                # Upsert overwrites the owner.
                await appstate.record_dataset_owner(session, "ds_1", "bob")
                assert await appstate.get_dataset_owner(session, "ds_1") == "bob"
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _make_token(sub: str, *, expires_in: int) -> str:
    """Sign a token the way the app would (same dev secret, since APP_ENV is unset
    in tests), but with a caller-chosen subject and expiry."""
    exp = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    return jwt.encode(
        {"sub": sub, "exp": exp},
        appstate._jwt_secret(),
        algorithm=appstate._JWT_ALGORITHM,
    )


def test_expired_token_is_401(client) -> None:
    """A correctly-signed but expired token is rejected (review follow-up)."""
    client.post("/api/auth/signup", json=_SIGNUP)
    token = _make_token("alice", expires_in=-10)
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_valid_token_for_unknown_user_is_401(client) -> None:
    """A valid token whose subject is not in the users table (e.g. a since-deleted
    user) is rejected by get_current_user's existence check (review follow-up)."""
    token = _make_token("ghost", expires_in=3600)
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_dataset_owner_fk_requires_existing_user(tmp_path) -> None:
    """PRAGMA foreign_keys=ON is enforced: an owner with no matching user row
    raises rather than silently persisting an orphan (review follow-up)."""

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(tmp_path / "appstate.db")
        try:
            async with sessionmaker() as session:
                with pytest.raises(IntegrityError):
                    await appstate.record_dataset_owner(session, "ds_x", "nonexistent")
        finally:
            await engine.dispose()

    asyncio.run(_run())


def test_jwt_config_fails_closed_in_production(monkeypatch) -> None:
    """verify_jwt_config refuses an insecure signing secret in production so a
    misconfigured deploy crash-loops at startup instead of signing forgeable
    identity tokens with the source-visible dev fallback (review follow-up)."""
    monkeypatch.setenv("APP_ENV", "production")

    # No secret set -> refuse.
    monkeypatch.delenv("JWT_SECRET", raising=False)
    with pytest.raises(RuntimeError):
        appstate.verify_jwt_config()

    # The source-visible dev fallback -> refuse.
    monkeypatch.setenv("JWT_SECRET", appstate._DEV_SECRET)
    with pytest.raises(RuntimeError):
        appstate.verify_jwt_config()

    # Too short -> refuse.
    monkeypatch.setenv("JWT_SECRET", "short")
    with pytest.raises(RuntimeError):
        appstate.verify_jwt_config()

    # A strong secret -> accepted.
    monkeypatch.setenv("JWT_SECRET", "x" * appstate._MIN_PROD_SECRET_LEN)
    appstate.verify_jwt_config()


def test_bad_ttl_is_rejected(monkeypatch) -> None:
    """A non-integer JWT_TTL_SECONDS is a clear config error, not a raw ValueError
    surfacing as a 500 at login (review follow-up)."""
    monkeypatch.setenv("JWT_TTL_SECONDS", "not-an-int")
    with pytest.raises(RuntimeError):
        appstate.verify_jwt_config()


def test_cors_origins_fail_closed_in_production(monkeypatch) -> None:
    """_resolve_cors_origins refuses a wildcard/unset ALLOWED_ORIGINS in
    production so a misconfigured deploy crash-loops at boot instead of silently
    serving CORS to every origin (T2-75), mirroring the JWT fail-closed guard.
    Outside production the wildcard default is preserved for dev/test ergonomics."""
    # Default (dev/test, no env) -> wildcard preserved, no error.
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    assert main._resolve_cors_origins() == ["*"]

    monkeypatch.setenv("APP_ENV", "production")

    # Unset in production -> refuse (default resolves to the wildcard).
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    with pytest.raises(RuntimeError):
        main._resolve_cors_origins()

    # Explicit wildcard in production -> refuse.
    monkeypatch.setenv("ALLOWED_ORIGINS", "*")
    with pytest.raises(RuntimeError):
        main._resolve_cors_origins()

    # A wildcard mixed with explicit origins in production -> still refuse.
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://app.example.com,*")
    with pytest.raises(RuntimeError):
        main._resolve_cors_origins()

    # Explicit origin(s) in production -> accepted, parsed to a list.
    monkeypatch.setenv(
        "ALLOWED_ORIGINS", "https://app.example.com, https://admin.example.com"
    )
    assert main._resolve_cors_origins() == [
        "https://app.example.com",
        "https://admin.example.com",
    ]
