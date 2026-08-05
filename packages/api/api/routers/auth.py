"""POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me.

Login issues an identity-only JWT (decision D-24) — no authorization claims in
the token. Does not import another router; does not touch the dataset tree or
schemas/v1/. The auth request/response models live here, per the catalogue.

Depends on appstate.py for the users table, password hashing, JWT issue, and the
identity dependency (module-map → routers/auth.py).

Two deployment guards ship alongside the routes (seam SEC-1). Both are scoped to
exactly this router's three endpoints — no other router is affected:

  * ALLOW_SIGNUP — account creation is an explicit opt-in that defaults OFF in
    production (_signup_enabled), the same fail-closed shape as
    appstate._jwt_secret and main._resolve_cors_origins.
  * a fixed-window, IN-PROCESS rate limit on all three routes (AuthRateLimiter),
    keyed per CLIENT so one visitor cannot spend everyone else's budget.

They live here rather than in a new module because their whole scope is this
file's three routes: module-map.md describes the api package module by module and
is outside this seam's write set, so a new module would arrive undescribed (and
AGENT_GUIDE lists "utility/helper files that no module owns" as a failure mode).
If a later seam needs to limit other routers, lift AuthRateLimiter +
client_address into `api/ratelimit.py` and give it a module-map entry then.
"""

from __future__ import annotations

import logging
import math
import os
import time
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from api import appstate
from api.appstate import (
    CurrentUser,
    User,
    create_access_token,
    get_current_user,
    get_session,
    hash_password,
    verify_password,
)

_logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# ALLOW_SIGNUP — account creation is opt-in in production (seam SEC-1 item A).
# ---------------------------------------------------------------------------

# Explicit vocabularies: anything outside them is a configuration ERROR, not a
# silent fallback. A self-hoster who writes ALLOW_SIGNUP=treu must hear about it
# at boot (verify_signup_config) rather than discover months later that nobody
# could register.
_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSY = frozenset({"0", "false", "no", "off"})


def _signup_enabled() -> bool:
    """Is POST /api/auth/signup open on this deployment?

    Unset/blank ALLOW_SIGNUP means "enabled OUTSIDE production, disabled IN it"
    (appstate._is_production). That mirrors the house rule the JWT_SECRET and
    ALLOWED_ORIGINS guards already follow — dev/test ergonomics are untouched
    (every existing test creates users with no env set), while an APP_ENV=production
    host does not serve open registration by accident.

    It is a DEFAULT, not a removal: a self-hoster running docker-compose.public.yml
    who wants public registration sets ALLOW_SIGNUP=true and gets it. An
    unrecognised value raises, so a typo cannot quietly pick either answer."""
    raw = os.environ.get("ALLOW_SIGNUP")
    if raw is None or not raw.strip():
        return not appstate._is_production()
    value = raw.strip().lower()
    if value in _TRUTHY:
        return True
    if value in _FALSY:
        return False
    raise RuntimeError(
        f"ALLOW_SIGNUP must be one of {sorted(_TRUTHY | _FALSY)}; got {raw!r}."
    )


def verify_signup_config() -> None:
    """Validate ALLOW_SIGNUP at startup so a misconfigured deployment crash-loops
    loudly instead of 500-ing on the first signup. Called from main.py's lifespan
    next to appstate.verify_jwt_config(), which it deliberately mirrors. (The rate
    limiter's own config is validated earlier still — build_rate_limiter runs
    during create_app.)"""
    _signup_enabled()


async def _require_signup_enabled() -> None:
    """Route-dependency form of the ALLOW_SIGNUP gate, so the signup route advertises
    it in `dependencies=[...]` at the decorator — the same altitude as
    _enforce_rate_limit — instead of burying the check in the handler body. On the
    signup route it is ordered AFTER _enforce_rate_limit, so an exhausted client is
    still turned away with 429 before this gate runs.

    Refused with 403 — "understood, but refusing to authorize": the route exists and
    the request is well-formed, the server just will not create accounts. 404 would
    read as a routing bug to a frontend that ships a signup form; 503 would promise it
    is temporary; 405 is about the method. It is also the code
    docs/launch/RELEASE_READINESS.md R-S7 already named for this flag. The body says
    only that signup is off — no hint about APP_ENV, the flag, or who may register."""
    if not _signup_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account creation is disabled on this server.",
        )


# ---------------------------------------------------------------------------
# Rate limiting the auth surface (seam SEC-1 item B).
# ---------------------------------------------------------------------------

# Defaults: 10 requests per client, per route, per 60s.
#
# A rate limit is a policy, not something derivable from the code, so these are
# chosen — but bounded on both sides by measurement, and the limiter LOGS A
# WARNING every time the ceiling actually binds, so a wrong choice surfaces in the
# logs instead of silently locking users out:
#   * floor — the heaviest legitimate burst in the suite is 3 requests to one auth
#     route inside one app (test_auth.test_duplicate_username_or_email_conflicts,
#     3 × POST signup; measured 2026-07-31 over packages/api/tests, 53 auth call
#     sites). A human retrying a mistyped password stays far under 10.
#   * ceiling — argon2 verification is ~tens of ms, so an unthrottled attacker
#     manages order-10 login attempts a second, i.e. order-10^6 a day. 10/min caps
#     that at 14,400/day sustained. Fixed-window counting admits up to 2×limit across
#     a single window boundary (10 at t=59.9s + 10 at t=60.1s), so the true worst case
#     is ~28,800/day — still well over an order of magnitude off an online-guessing
#     budget. A sliding window would remove the doubling if a tighter bound is wanted.
# Override per deployment with AUTH_RATE_LIMIT / AUTH_RATE_LIMIT_WINDOW_SECONDS.
_DEFAULT_RATE_LIMIT = 10
_DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60


def _positive_int_env(name: str, default: int) -> int:
    """Read a positive-integer env var, or `default` when unset/blank. A
    non-integer or non-positive value is a hard configuration error — the same
    shape as appstate._ttl_seconds, not a silent fallback."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        raise RuntimeError(f"{name} must be a positive integer; got {raw!r}.") from None
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer; got {raw!r}.")
    return value


@dataclass
class _Window:
    """One key's fixed window: when it opened, and how many requests it has taken."""

    opened_at: float
    count: int


class AuthRateLimiter:
    """A fixed-window request counter held IN THIS PROCESS — no Redis, no shared
    store, no new dependency.

    In-process is a REQUIREMENT here, not a shortcut. docker-compose.public.yml
    declares no `redis` service (measured: 0 occurrences), and the API's Redis
    client is deliberately lazy — main._DEFAULT_REDIS_URL records that
    `Redis.from_url` and `rq.Queue` never contact the broker until a write route
    enqueues. A Redis-backed limiter would therefore pass the whole suite in
    development and then fail on the public host at the FIRST login.

    DOCUMENTED LIMITATION — the budget is PER API PROCESS. docker-compose.public.yml
    runs a single `api` container with the image's default uvicorn CMD (one worker),
    so today one process sees every request and the budget is global. Run N replicas
    or N uvicorn workers and each gets its own counter, so the effective limit
    becomes N × the configured value. That is a deliberate trade: a per-replica
    approximation that always works beats an exact shared counter that cannot run at
    all. Scaling the API out means moving this state to a shared store (and adding
    the broker the public compose currently omits).

    Storage is bounded by real traffic rather than by an arbitrary cap: expired
    windows are swept at most once per window, so the dict holds at most the
    distinct keys seen in about two windows (see _sweep)."""

    def __init__(self, limit: int, window_seconds: float) -> None:
        self._limit = limit
        self._window = window_seconds
        self._windows: dict[str, _Window] = {}
        self._last_sweep = 0.0

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def window_seconds(self) -> float:
        return self._window

    # CONCURRENCY: this counter is NOT internally synchronized, and is safe only
    # because check()/_sweep() are fully synchronous — no `await` — and run on a
    # single event-loop worker, so two requests cannot interleave mid-update. Do NOT
    # introduce an `await` into check()/_sweep() (or into _enforce_rate_limit before
    # the check() call) without adding a lock: a yield point here reopens a
    # read-modify-write race that silently admits requests past the limit.
    def check(self, key: str, now: float) -> float | None:
        """Count one request against `key`. Returns None when it is allowed, or the
        seconds remaining until `key`'s window resets when it is not. `now` is a
        caller-supplied monotonic reading so the window logic is testable without
        sleeping."""
        self._sweep(now)
        window = self._windows.get(key)
        if window is None or now - window.opened_at >= self._window:
            window = _Window(opened_at=now, count=0)
            self._windows[key] = window
        window.count += 1
        if window.count > self._limit:
            return window.opened_at + self._window - now
        return None

    def _sweep(self, now: float) -> None:
        """Drop windows that have expired. Runs at most once per window, which is
        what bounds memory WITHOUT picking a cap: entries can only accumulate for
        one sweep interval, and the sweep interval IS the window, so the dict holds
        at most the distinct client/route keys seen in ~2 windows."""
        if now - self._last_sweep < self._window:
            return
        self._last_sweep = now
        self._windows = {
            key: window
            for key, window in self._windows.items()
            if now - window.opened_at < self._window
        }


def build_rate_limiter() -> AuthRateLimiter:
    """Construct the limiter from AUTH_RATE_LIMIT / AUTH_RATE_LIMIT_WINDOW_SECONDS.
    Called once from main.create_app and parked on app.state (module-map rule #8 —
    no module-level mutable global), which also gives every test its own counter."""
    return AuthRateLimiter(
        limit=_positive_int_env("AUTH_RATE_LIMIT", _DEFAULT_RATE_LIMIT),
        window_seconds=float(
            _positive_int_env(
                "AUTH_RATE_LIMIT_WINDOW_SECONDS", _DEFAULT_RATE_LIMIT_WINDOW_SECONDS
            )
        ),
    )


def client_address(request: Request) -> str:
    """THE identity a rate-limit budget belongs to. Getting this wrong is the whole
    risk in the limiter, in either direction:

      * `request.client.host` alone is CADDY'S container address, because the edge
        proxies with a bare `reverse_proxy api:8000`
        (docker/Caddyfile.edge-snippets:54). Keyed on that, every visitor shares one
        budget and one attacker locks out the whole demo — a denial of service
        against ourselves that looks exactly like the limiter working. Measured
        2026-07-31 against caddy:2.8-alpine (v2.8.4) with the repo's own snippet:
        the upstream saw remote_addr 172.29.0.3, the Caddy container.
      * the LEFTMOST X-Forwarded-For entry is client-supplied in the general case,
        so keying on it lets anyone mint a fresh budget per request.

    So: the RIGHTMOST entry, which is the one written by the nearest proxy, with a
    fallback to the direct peer when the header is absent (dev, tests, any
    unproxied deployment).

    Measured behaviour of the actual edge, 2026-07-31, caddy:2.8-alpine (v2.8.4)
    running docker/Caddyfile.edge-snippets' `api_edge` snippet verbatim:

        client sends              upstream X-Forwarded-For
        (nothing)                 172.29.0.1
        1.2.3.4                   172.29.0.1
        1.2.3.4, 5.6.7.8          172.29.0.1
        1.2.3.4 (two headers)     172.29.0.1

    Caddy REPLACES the header with the real peer — it does not append to a
    client-supplied value — because `trusted_proxies` is not configured. (Adding
    `trusted_proxies static 0.0.0.0/0` to the same probe flipped it to the appending
    form, `1.2.3.4, 172.29.0.1`, which confirms the mechanism.) So on the public
    host the header carries exactly ONE entry, the true client, and it is
    unforgeable. Rightmost is correct today for that reason.

    Why rightmost and not leftmost, precisely: adding a trusted hop degrades the two
    rules in OPPOSITE directions. With ONE trusted appending proxy the rightmost
    entry is still the real client. With TWO OR MORE appending hops (e.g. a CDN in
    front of Caddy, each trusting its upstream) rightmost resolves to the nearest
    proxy's address, so every visitor behind it collapses onto one budget — a
    fail-SAFE degradation (self-inflicted over-restriction, visible in the WARNING
    logs), NOT a bypass. Leftmost fails the other way: it becomes client-forgeable
    the moment any proxy appends, letting anyone mint fresh budgets. So rightmost is
    the right default, but it only stays *correct* (per-client) for a single trusted
    hop; a multi-hop deployment needs a trusted-proxy allow-list ([[T2-187]]), not a
    leftmost/rightmost pick.

    RESIDUAL — two known gaps, both tracked in [[T2-187]]:
      * Direct API-port exposure. A deployment that exposes the API PORT DIRECTLY to
        untrusted clients lets them set the header themselves. docker-compose.public.yml
        (the showcase) publishes ports on the `caddy` service ONLY — `api` declares no
        `ports:`, so the edge is the sole path in (measured 2026-07-31) and that profile
        is safe. But docker-compose.yml (dev) and the docker-compose.prod.yml overlay DO
        publish `api:8000` on all interfaces, so on those the header is attacker-settable
        and the limiter is bypassable until a trusted-proxy allow-list is added.
      * Shared public IPs. Even correct per-client-IP keying collapses every user behind
        one carrier-grade-NAT or corporate-egress IP onto one budget, so a busy shared IP
        can 429 unrelated legitimate users. Inherent to per-IP limiting, not fixable by
        key selection; it is fail-safe and visible in the WARNING logs, and the default
        limit (10/60s) is chosen generously with this in mind."""
    entries = [
        entry.strip()
        for header in request.headers.getlist("x-forwarded-for")
        for entry in header.split(",")
        if entry.strip()
    ]
    if entries:
        return entries[-1]
    client = request.client
    return client.host if client is not None else "unknown"


async def _enforce_rate_limit(request: Request) -> None:
    """Route-level dependency guarding the three auth routes. FastAPI solves
    decorator `dependencies` before the endpoint's own parameters, so this runs
    ahead of body validation and ahead of get_current_user — an exhausted client is
    turned away before any argon2 work or DB read.

    The budget is per (route, client): a frontend polling /api/auth/me can never
    spend the login budget, which is the one that actually matters."""
    limiter: AuthRateLimiter = request.app.state.auth_rate_limiter
    client = client_address(request)
    remaining = limiter.check(f"{request.url.path}|{client}", time.monotonic())
    if remaining is None:
        return
    retry_after = max(1, math.ceil(remaining))
    # WARN whenever the ceiling actually binds. The limit is a chosen number, so it
    # must be visible when it starts costing someone access — a silent limiter is
    # indistinguishable from a limit set far too low.
    _logger.warning(
        "auth rate limit reached: route=%s client=%s limit=%d per %.0fs, "
        "retry_after=%ds",
        request.url.path,
        client,
        limiter.limit,
        limiter.window_seconds,
        retry_after,
    )
    raise HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many authentication requests; please try again shortly.",
        headers={"Retry-After": str(retry_after)},
    )


class SignupRequest(BaseModel):
    username: str = Field(pattern=r"^[A-Za-z0-9._-]+$", max_length=64)
    email: EmailStr
    password: str = Field(min_length=8)


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str  # JWT bearer, identity-only (D-24); no authz claims
    token_type: str = "bearer"


class UserInfo(BaseModel):
    username: str
    email: str


@router.post(
    "/api/auth/signup",
    dependencies=[Depends(_enforce_rate_limit), Depends(_require_signup_enabled)],
)
async def signup(
    body: SignupRequest, session: AsyncSession = Depends(get_session)
) -> UserInfo:
    """Create the user (argon2-hashed password); unique username AND email are
    enforced by the DB constraints, so a conflict on either returns 409.

    Account creation is gated by the _require_signup_enabled dependency above (403
    when signup is disabled) — declared at the decorator, the same altitude as the
    rate limiter, rather than re-checked in this body. The rate-limit dependency is
    ordered first, so an exhausted client gets 429 before the gate runs."""
    # argon2 hashing is deliberately expensive (CPU-bound, ~tens of ms); running it
    # inline in this async route would block the event loop for every concurrent
    # request. Offload it to the threadpool (T2-52).
    password_hash = await run_in_threadpool(hash_password, body.password)
    session.add(
        User(
            username=body.username,
            email=body.email,
            password_hash=password_hash,
        )
    )
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username or email already registered",
        ) from None
    return UserInfo(username=body.username, email=body.email)


@router.post("/api/auth/login", dependencies=[Depends(_enforce_rate_limit)])
async def login(
    body: LoginRequest, session: AsyncSession = Depends(get_session)
) -> TokenResponse:
    """Verify credentials and issue the identity-only JWT. Bad username or
    password both return 401 (no enumeration of which was wrong)."""
    result = await session.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()
    # Always run EXACTLY ONE verify (verify_password hashes a dummy when user is
    # None) so the response time does not reveal whether the username exists.
    # argon2 verification is CPU-bound (~tens of ms); offload it to the threadpool
    # so it does not block the event loop (T2-52). The dummy-verify stays on this
    # same wrapped path — do not branch around the threadpool, the single
    # constant-time call is the point.
    password_ok = await run_in_threadpool(
        verify_password,
        user.password_hash if user is not None else None,
        body.password,
    )
    if user is None or not password_ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    return TokenResponse(access_token=create_access_token(user.username))


@router.get("/api/auth/me", dependencies=[Depends(_enforce_rate_limit)])
async def me(
    current_user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> UserInfo:
    """Echoes the authenticated identity (get_current_user). Identity only."""
    result = await session.execute(
        select(User).where(User.username == current_user.username)
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user"
        )
    return UserInfo(username=user.username, email=user.email)
