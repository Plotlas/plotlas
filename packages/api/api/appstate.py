"""The mutable API app-state store (decisions D-22/D-23/D-24).

SQLite via SQLAlchemy (Postgres-swappable), holding `users` and the
`dataset -> owner` mapping. Sole writer of app-state. Wholly separate from db.py
(read-only DuckDB over Parquet) and from schemas/v1/.

Authorization, ownership, and the future visibility/sharing model live ONLY
here — never in the manifest, the dataset tree, or the JWT. The JWT carries
identity only; every ownership check resolves per-request from app-state, not
from token claims.

    # ORM-backed records (mutable app-state; NOT schemas/v1/):
    #   users(id, username, email, password_hash, created_at)
    #   datasets(dataset_id, owner, created_at, last_job_id)
    #     owner -> users.username; last_job_id: str | None (D-28)
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt  # PyJWT — identity-only JWT (decision D-24)
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import ForeignKey, event, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


# ---------------------------------------------------------------------------
# ORM models (mutable app-state; NOT part of the frozen schemas/v1/ contract).
# ---------------------------------------------------------------------------


class Base(DeclarativeBase):
    """Declarative base for the app-state tables (SQLAlchemy 2.0 style)."""


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(unique=True, index=True)
    email: Mapped[str] = mapped_column(unique=True, index=True)
    password_hash: Mapped[str] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Dataset(Base):
    __tablename__ = "datasets"

    dataset_id: Mapped[str] = mapped_column(primary_key=True)
    # owner -> users.username (decision D-18). The mapping lives ONLY here, never
    # in the manifest or dataset tree.
    owner: Mapped[str] = mapped_column(ForeignKey("users.username"))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # The RQ job id recorded at enqueue (decision D-28); None until the first
    # enqueue (or for rows that predate the column). Powers the derived
    # processing|ready|error status and the delete-while-running 409 — the status
    # itself is derived at read time and NEVER stored here or in the manifest.
    last_job_id: Mapped[str | None] = mapped_column(default=None)
    # D-34 read authorization: "private" (default — owner-only) or "public"
    # (readable by anyone, including anonymously — the login-less showcase). The
    # ONLY visibility state that decides reads; resolved per-request from app-state,
    # never from the manifest, the dataset tree, or the JWT. A NOT-NULL constant
    # default so create_all and the in-place migration (setup_appstate) both land
    # pre-D-34 rows as "private" — the safe default.
    visibility: Mapped[str] = mapped_column(
        default="private", server_default="private"
    )
    # Presentation (SCOPE_shareable-collections Part B). BOTH are nullable and
    # purely cosmetic: nothing resolves, authorizes, or addresses anything by them.
    #
    # display_name — what the collection is CALLED. `None` means "no name set", and
    # every surface falls back to `dataset_id`. It is deliberately NOT unique and
    # NOT a slug: `dataset_id` stays the primary key, the on-disk directory name,
    # the tile path and the deep-link target, so a rename can never strand a link
    # someone already shared.
    #
    # attribution — who the collection came FROM (e.g. "Rijksmuseum, Amsterdam"),
    # shown in the viewer footer. Credit for the holding institution; free text
    # because there is no registry to validate against.
    #
    # These three columns are now the pre-migration FALLBACK, not the home. The home is
    # `presentation.json` in the dataset's own directory (D-i/D-xv, api/presentation.py):
    # what a collection is CALLED and who it came FROM are facts about the data, so they
    # travel WITH it — a dataset moved to another server, restored from a cold kit, or
    # served from an assets origin used to arrive anonymous, because app-state lives at
    # ${DATA_ROOT}/app-state/appstate.db, outside the dataset directory entirely.
    #
    # NOTHING WRITES THEM ANY MORE. They are read by `presentation.effective` when — and
    # only when — the dataset's file carries no `dataset` block, which is every deployment
    # that predates the migration (`python -m api.admin migrate-presentation`). The
    # migration COPIES them out and deliberately never clears them: they are the only copy
    # a rollback to the previous release would find. Do not "tidy" them into a second
    # source by re-adding a writer — the whole point of the split is one writer per fact.
    #
    # The reason originally given for putting them here was: "putting them in the manifest
    # would make renaming a collection require a re-bake." That is FALSE, and it propagated
    # to three other files before anyone checked it. `pixscope refresh-manifest` rewrites a
    # committed manifest in place with no tiles touched and no `dataset_version` bump.
    # Manifest-resident does NOT imply re-baked: only the DERIVED manifest fields
    # (annotations, bbox, pyramid) are expensive to change, and these are not derived from
    # anything. The correction is kept rather than deleted because it is why they were in
    # the wrong place — but note what the fix actually was: they moved BESIDE the manifest,
    # not into it, since one file with a cheap-edit path would have had two writers (D-xv).
    #
    # The right test is whether the fact survives a copy. `owner` and `visibility` are
    # genuinely per-instance — the same directory on two servers should have different
    # owners — so they stay here, permanently.
    display_name: Mapped[str | None] = mapped_column(default=None)
    attribution: Mapped[str | None] = mapped_column(default=None)
    # An OPTIONAL link target for the attribution (Part D §2b). Separate from the
    # credit TEXT on purpose: "Rijksmuseum, Amsterdam" is a name, not a URL, so
    # sniffing whether the text happens to parse as one would tie the rendering to a
    # value the operator did not choose for that purpose — and would force a bare URL
    # as the credit line to get a link at all. Two fields give a readable name AND a
    # target. Consumers render the credit as an anchor only when this is set AND is an
    # absolute http(s) URL (frontend `sourceUrl`); anything else stays plain text, so a
    # bad target loses the link, never the credit.
    attribution_url: Mapped[str | None] = mapped_column(default=None)
    # The finalized upload bundle (DATA_ROOT/users/{owner}/uploads/{id}, D-30) this
    # dataset's cells were last BUILT FROM — set by create_dataset and by re-ingest
    # WHEN IT NAMES ONE. It is what ties a dataset to a bundle at all: without it the
    # only question app-state could answer was "which bundle did this OWNER finalize
    # last", which is not the same question and gave `GET /api/datasets/{ds_id}/columns`
    # another collection's columns (review of PR #358, findings 1+2).
    #
    # NULLABLE, for two reasons: a row that predates this column, and a CLI-seeded or
    # operator-transferred dataset that never had a bundle. NEVER cleared once set
    # (review of PR #390, round 3, findings 1+2 — an EARLIER draft of this PR cleared
    # it on any unnamed re-ingest of an already-baked dataset, which was itself a
    # regression: it erased a still-accurate record the moment an owner re-ingested
    # with nothing new to say, reopening this column's original problem the next time
    # they uploaded anything else). An unnamed re-ingest now either proceeds because
    # the record already agrees with the bundle it resolves to, or refuses (409) when
    # it does not — never guesses, never overwrites, never clears. None means "this
    # dataset records no source bundle", never "no metadata" — the reader falls
    # through to its next answer rather than inventing one.
    #
    # Per-instance by the copy test, so it belongs here and not in the manifest: an
    # upload jail is one server's staging area, so the same dataset directory restored
    # onto another machine has no such bundle and must read None, not a dangling id.
    #
    # NOT an authorization input. The bundle is resolved under the dataset's OWNER's
    # jail at read time (db.resolve_under), so a recorded id can only ever name a
    # directory that owner could already reach.
    source_upload_id: Mapped[str | None] = mapped_column(default=None)
    # The finalized upload a MINTED create built this dataset from — the idempotency key
    # of a create that authors no id ([[T2-a-minted-create-is-not-idempotent-so-a-retried]]).
    # Written ONCE, with the row, by that create and by nothing else: re-ingest and an
    # authored create leave it None, and nothing overwrites it. That is the whole point of
    # a column separate from `source_upload_id`, which re-ingest and authored creates also
    # write, so keying on it made a minted create from an upload that had only been
    # RE-INGESTED into another collection answer 409 and adopt that collection (review of
    # PR #373, operator finding 1).
    #
    # NULLABLE and NOT BACKFILLED: a row minted before this column existed reads None and
    # is not covered by the key, so a repeat of such a create builds a second collection,
    # as it did before. The window is the hours between PR #367 (minting) and this column;
    # backfilling from `source_upload_id` would re-import exactly the ambiguity above.
    # Per-instance like `source_upload_id`, for the same reason; not an authorization input.
    minted_from_upload_id: Mapped[str | None] = mapped_column(default=None)


# ---------------------------------------------------------------------------
# Identity.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CurrentUser:
    """Identity resolved from a verified JWT. Identity only — carries no
    authorization claims (decision D-24)."""

    username: str


# ---------------------------------------------------------------------------
# Password hashing (argon2) — hash on signup, verify on login.
# ---------------------------------------------------------------------------

# Stateless hasher config (no per-request mutable state); argon2 recommends a
# single shared instance. Not the kind of module-level *state* rule #8 forbids.
_password_hasher = PasswordHasher()

# Precomputed hash of a throwaway value. login() verifies against this when the
# username is unknown, so the request takes ~the same time whether or not the
# user exists — denying a timing oracle for username enumeration.
_DUMMY_HASH = _password_hasher.hash("constant-time-login-dummy-password")


def hash_password(password: str) -> str:
    """Argon2-hash a plaintext password for storage."""
    return _password_hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Verify a plaintext password against its stored argon2 hash. Returns False
    on mismatch (the clean wrong-password path); any other failure surfaces.

    `password_hash` is None when the username was not found: we still run a verify
    (against a dummy hash) so login is ~constant-time regardless of whether the
    user exists, and always return False in that case."""
    try:
        _password_hasher.verify(password_hash or _DUMMY_HASH, password)
    except VerifyMismatchError:
        return False
    return password_hash is not None


# ---------------------------------------------------------------------------
# JWT (PyJWT, HS256) — identity-only token: claims are {sub, exp} ONLY.
# ---------------------------------------------------------------------------

_JWT_ALGORITHM = "HS256"
_DEFAULT_TTL_SECONDS = 24 * 60 * 60  # 24h; override via JWT_TTL_SECONDS

# Source-visible dev fallback (>=32 bytes to satisfy HS256, but NOT a real
# secret). Anyone who knows the signing secret can forge identity tokens, so this
# default is refused in production (see _jwt_secret / verify_jwt_config).
_DEV_SECRET = "dev-only-insecure-change-me-in-production"
_MIN_PROD_SECRET_LEN = 32


def _is_production() -> bool:
    """True when APP_ENV marks a production deployment (default: development)."""
    return os.environ.get("APP_ENV", "development").strip().lower() in {
        "production",
        "prod",
    }


def _jwt_secret() -> str:
    """Resolve the JWT signing secret. Fails CLOSED in production: with
    APP_ENV=production the dev fallback is refused, so a misconfigured deploy
    cannot sign forgeable tokens with the source-visible default (the dev secret
    is in this file). Outside production the dev fallback keeps local/test
    ergonomics — no secret needs to be set to run the suite."""
    secret = os.environ.get("JWT_SECRET")
    if _is_production():
        if not secret or secret == _DEV_SECRET:
            raise RuntimeError(
                "JWT_SECRET must be set to a strong random value in production "
                "(APP_ENV=production); refusing to sign tokens with the public "
                "dev-only fallback secret."
            )
        if len(secret) < _MIN_PROD_SECRET_LEN:
            raise RuntimeError(
                f"JWT_SECRET must be at least {_MIN_PROD_SECRET_LEN} characters "
                "in production."
            )
        return secret
    return secret or _DEV_SECRET


def _ttl_seconds() -> int:
    """Token TTL in seconds from JWT_TTL_SECONDS (default 24h). A non-integer or
    non-positive value is a hard configuration error, not a silent fallback or a
    raw ValueError surfacing as a 500 at token-issue time."""
    raw = os.environ.get("JWT_TTL_SECONDS")
    if not raw:
        return _DEFAULT_TTL_SECONDS
    try:
        ttl = int(raw)
    except ValueError:
        raise RuntimeError(
            f"JWT_TTL_SECONDS must be an integer number of seconds; got {raw!r}."
        ) from None
    if ttl <= 0:
        raise RuntimeError("JWT_TTL_SECONDS must be a positive integer (seconds).")
    return ttl


def verify_jwt_config() -> None:
    """Validate JWT configuration at startup so a misconfigured deployment fails
    fast (crash-loops loudly) instead of 500-ing on the first login. Called from
    main.py's lifespan. In production this refuses a missing/dev/weak JWT_SECRET;
    everywhere it rejects a malformed JWT_TTL_SECONDS."""
    _jwt_secret()
    _ttl_seconds()


def create_access_token(username: str) -> str:
    """Issue an identity-only bearer JWT. Claims are exactly {sub, exp} — no
    roles, ownership, or any authorization claim (decision D-24)."""
    now = datetime.now(timezone.utc)
    payload = {"sub": username, "exp": now + timedelta(seconds=_ttl_seconds())}
    return jwt.encode(payload, _jwt_secret(), algorithm=_JWT_ALGORITHM)


def _decode_token(token: str) -> dict[str, Any]:
    """Verify signature + expiry and return the claims. Raises
    jwt.InvalidTokenError (incl. ExpiredSignatureError) on any problem."""
    return jwt.decode(token, _jwt_secret(), algorithms=[_JWT_ALGORITHM])


# ---------------------------------------------------------------------------
# App-state engine / session lifecycle.
# ---------------------------------------------------------------------------


def resolve_appstate_db_path() -> Path:
    """Resolve the app-state SQLite path from env: APP_STATE_DB, else
    ${DATA_ROOT}/app-state/appstate.db (DATA_ROOT defaults to '.'). Pure — the
    parent dir is created once in setup_appstate (which also covers an explicitly
    passed db_path)."""
    configured = os.environ.get("APP_STATE_DB")
    if configured:
        return Path(configured)
    data_root = Path(os.environ.get("DATA_ROOT", "."))
    return data_root / "app-state" / "appstate.db"


def create_appstate_engine(db_path: Path) -> AsyncEngine:
    """Create the async SQLAlchemy engine over aiosqlite for `db_path`.
    `as_posix()` keeps the sqlite URL valid on Windows hosts too.

    SQLite ignores foreign keys unless `PRAGMA foreign_keys=ON` is issued per
    connection; without this the `datasets.owner -> users.username` FK would be
    inert and orphan owners could be persisted. The connect listener enforces it
    on every pooled connection."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{db_path.as_posix()}")

    @event.listens_for(engine.sync_engine, "connect")
    def _enable_sqlite_foreign_keys(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


async def setup_appstate(
    db_path: Path | None = None,
) -> tuple[AsyncEngine, async_sessionmaker[AsyncSession]]:
    """Create the async engine + sessionmaker and create_all the app-state
    tables. Called once from main.py's lifespan; the sessionmaker is stored on
    app.state and threaded into request-scoped deps (no module-level mutable
    global — module-map rule #8). Returns (engine, sessionmaker) so the caller
    owns disposal on shutdown.

    In-place migration (D-28 / D-34): a dev DB whose `datasets` table predates the
    `last_job_id` (D-28) or `visibility` (D-34) column is ALTERed in place
    (create_all never touches an existing table); a fresh DB gets both columns from
    create_all. Each ALTER is guarded by PRAGMA table_info so it runs at most once,
    and carries a constant default so existing rows read back a safe value
    (last_job_id=None; visibility="private" — owner-only until published). The
    presentation columns, `source_upload_id` (seam L1) and `minted_from_upload_id`
    (PR #373) go the same way, nullable with no default — a pre-existing row backfills
    as NULL, which every reader already treats as "not recorded"."""
    resolved = db_path if db_path is not None else resolve_appstate_db_path()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    engine = create_appstate_engine(resolved)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # ALTER TABLE ... ADD COLUMN is additive — safe on a live dev DB. The
        # table_info snapshot below predates every ALTER, so each add is decided
        # against the table's original columns.
        info = await conn.exec_driver_sql("PRAGMA table_info(datasets)")
        columns = {row[1] for row in info.fetchall()}
        if "last_job_id" not in columns:
            try:
                await conn.exec_driver_sql(
                    "ALTER TABLE datasets ADD COLUMN last_job_id VARCHAR"
                )
            except OperationalError as exc:
                # The only expected failure is a concurrent startup (another worker)
                # winning the race and adding the column first ("duplicate column
                # name") — benign (PR24-6). Anything else is a real error: re-raise.
                if "duplicate column" not in str(exc).lower():
                    raise
        if "visibility" not in columns:
            # D-34: existing rows default to "private" (owner-only) — the safe
            # default. A constant DEFAULT lets SQLite backfill the NOT-NULL column
            # on existing rows. Same duplicate-column race handling as above.
            try:
                await conn.exec_driver_sql(
                    "ALTER TABLE datasets ADD COLUMN visibility VARCHAR "
                    "NOT NULL DEFAULT 'private'"
                )
            except OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
        # The nullable-VARCHAR adds: the Part B presentation columns, plus
        # `source_upload_id` (seam L1). Nullable with NO default: an existing row
        # backfills as NULL, which every surface already reads as "fall back to
        # dataset_id" (display_name) / "show nothing" (attribution) / "this dataset
        # records no source bundle" (source_upload_id — which is EVERY row that
        # predates the column, and the reason it can never be NOT NULL) / "not the
        # product of a minted create this key covers" (minted_from_upload_id — so a row
        # minted before the column is simply outside the idempotency key). Same
        # duplicate-column race handling as above.
        for column in (
            "display_name",
            "attribution",
            "attribution_url",
            "source_upload_id",
            "minted_from_upload_id",
        ):
            if column in columns:
                continue
            try:
                await conn.exec_driver_sql(
                    f"ALTER TABLE datasets ADD COLUMN {column} VARCHAR"
                )
            except OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    return engine, sessionmaker


# ---------------------------------------------------------------------------
# FastAPI dependencies.
# ---------------------------------------------------------------------------

# auto_error=False so a missing/blank Authorization header yields None here and
# we return 401 ourselves (HTTPBearer's default would be a 403).
_bearer_scheme = HTTPBearer(auto_error=False)


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    """FastAPI dependency. Yields a request-scoped SQLAlchemy session against the
    SQLite app-state DB. The only path that writes users / dataset-ownership.

    Reaches the sessionmaker stored on app.state at startup (directive #4 /
    module-map rule #8) rather than a module-level global."""
    sessionmaker: async_sessionmaker[AsyncSession] = (
        request.app.state.appstate_sessionmaker
    )
    async with sessionmaker() as session:
        yield session


def _unauthorized() -> HTTPException:
    """The ONE 401 shape every identity failure raises — a single exception for
    missing, malformed, expired, and unknown-user credentials alike, so the response
    never distinguishes WHY a credential failed (no oracle)."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _resolve_user(
    credentials: HTTPAuthorizationCredentials, session: AsyncSession
) -> CurrentUser | None:
    """Resolve PRESENTED bearer credentials to a verified identity, or None when the
    token is invalid/expired/malformed or names an unknown user. The single
    resolution path shared by get_current_user and get_optional_user — one place for
    the decode → `sub` → users-table confirmation chain, so the two dependencies can
    never drift apart on what counts as a valid identity. Raises nothing; the
    dependencies decide what a None means for their route class."""
    try:
        payload = _decode_token(credentials.credentials)
    except jwt.InvalidTokenError:
        return None
    username = payload.get("sub")
    if not isinstance(username, str):
        return None
    result = await session.execute(select(User).where(User.username == username))
    user = result.scalar_one_or_none()
    if user is None:
        return None
    return CurrentUser(username=user.username)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: AsyncSession = Depends(get_session),
) -> CurrentUser:
    """FastAPI dependency. Verifies the bearer JWT and returns the identity.
    Performs NO authorization — callers resolve ownership/visibility from
    app-state per request (decisions D-23/D-24). Identity is taken from the
    token's `sub` and confirmed against the users table (_resolve_user); missing/
    invalid/expired tokens and unknown users all raise the same 401."""
    if credentials is None:
        raise _unauthorized()
    user = await _resolve_user(credentials, session)
    if user is None:
        raise _unauthorized()
    return user


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    session: AsyncSession = Depends(get_session),
) -> CurrentUser | None:
    """FastAPI dependency — OPTIONAL identity for the READ routes (D-34). Returns
    None when NO credential is presented (the anonymous caller — what lets a PUBLIC
    dataset serve login-less), or the verified identity for a valid bearer. A
    PRESENTED credential that fails to resolve (invalid/expired/malformed token,
    unknown user) raises the same 401 as get_current_user — NOT silent anonymity:
    a client whose session expired must hear "re-authenticate", or its private
    datasets would just quietly vanish into public-only 404s with no signal (the
    expired-session trap). Non-disclosure is unaffected — the 401 depends ONLY on
    the credential, never on any dataset, so it reveals nothing about what exists;
    a truly anonymous read of a private dataset still 404s via may_read. Shares
    _resolve_user (and the HTTPBearer(auto_error=False) scheme) with
    get_current_user so the two can never drift. Performs NO authorization —
    callers pass the result to may_read (D-23/D-24)."""
    if credentials is None:
        return None
    user = await _resolve_user(credentials, session)
    if user is None:
        raise _unauthorized()
    return user


# ---------------------------------------------------------------------------
# Ownership + job-tracking primitives (seam 10c create-dataset; R2 D-28).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DatasetRecord:
    """One app-state datasets row (D-28/D-34). Plain data handed to routers so they
    never touch ORM instances; `last_job_id` is None until the first enqueue;
    `visibility` is "private" (owner-only) or "public" (readable by anyone);
    `source_upload_id` is None until a bundle-backed bake records one, and never
    changes again on its own — an unnamed re-ingest proceeds only when it already
    agrees, or refuses (409) rather than touch it (review of PR #390, round 3)."""

    dataset_id: str
    owner: str
    created_at: datetime
    last_job_id: str | None
    visibility: str
    # Part B presentation. Both None until an operator sets them; nothing resolves
    # or authorizes by either. `display_name` None => callers show `dataset_id`.
    display_name: str | None = None
    attribution: str | None = None
    # Part D §2b: an optional link target for the credit above.
    attribution_url: str | None = None
    # Seam L1: the finalized upload bundle this dataset was last built from, or None
    # when it records none — a pre-column row, or a CLI-seeded tree that never had
    # one. Never cleared once set (review of PR #390, round 3): an unnamed re-ingest
    # only ever proceeds (already agrees) or refuses (409, disagrees), so nothing here
    # is ever a guess. None is "not recorded", never "no metadata".
    source_upload_id: str | None = None


def _to_record(dataset: Dataset) -> DatasetRecord:
    return DatasetRecord(
        dataset_id=dataset.dataset_id,
        owner=dataset.owner,
        created_at=dataset.created_at,
        last_job_id=dataset.last_job_id,
        visibility=dataset.visibility,
        display_name=dataset.display_name,
        attribution=dataset.attribution,
        attribution_url=dataset.attribution_url,
        source_upload_id=dataset.source_upload_id,
    )


# Presentation text is operator-supplied free text. It is bounded so a pathological
# value cannot bloat every list response, and trimmed so trailing whitespace does
# not masquerade as a set value. Not a security control — authorization never reads
# these — just hygiene at the one place they enter the system.
#
# THE AUTHORITATIVE HOME OF THE THREE CAPS, and the reason they stayed here after the
# values moved into `presentation.json`: this is what actually runs at every write (via
# `api/presentation.py`, which defers to `PRESENTATION_LIMITS` rather than re-declaring
# them), and `schemas/v2/presentation.schema.json` says in its own field descriptions that
# its `maxLength`s TRANSCRIBE these constants. The lean api image ships no `schemas/`
# directory, so the code cannot read the schema at runtime and the copy is unavoidable —
# `tests/test_presentation_schema_parity.py` pins the two equal so a change to one without
# the other goes red instead of drifting.
DISPLAY_NAME_MAX = 120
ATTRIBUTION_MAX = 200
# A URL, so bounded well above the credit text but still bounded — this rides in every
# dataset-list response.
ATTRIBUTION_URL_MAX = 500


class PresentationValueError(ValueError):
    """A rejected presentation write — a value too long, or an unknown field. Routers
    map this to 422 (a plain ValueError would surface as a 500)."""


def normalize_presentation_text(
    value: str | None, *, field: str, limit: int
) -> str | None:
    """Trim, and treat blank as CLEARED (None) so a bad name is always recoverable
    by submitting an empty field. Raises PresentationValueError past `limit`."""
    if value is None:
        return None
    trimmed = value.strip()
    if trimmed == "":
        return None
    if len(trimmed) > limit:
        raise PresentationValueError(
            f"{field} must be {limit} characters or fewer (got {len(trimmed)})"
        )
    return trimmed


async def record_dataset_owner(
    session: AsyncSession,
    dataset_id: str,
    owner: str,
    *,
    source_upload_id: str | None = None,
    minted_from_upload_id: str | None = None,
) -> None:
    """Record dataset ownership in app-state (decision D-18). Sole writer of the
    owner mapping; never written into the manifest or dataset tree. Upserts the
    `dataset -> owner` row and commits.

    `source_upload_id`, when given, is written in the SAME commit — so the row and it
    exist together or not at all. None leaves the column as it is.

    `minted_from_upload_id` is a MINTED create's idempotency key, and the only writer
    of that column: it is set in the same commit as a NEW row, before the enqueue
    (review of PR #373, finding 1), and never on a row that already exists — so nothing
    can overwrite or re-point it later. Passing it for an existing row raises."""
    existing = await session.get(Dataset, dataset_id)
    if existing is None:
        existing = Dataset(
            dataset_id=dataset_id, owner=owner, minted_from_upload_id=minted_from_upload_id
        )
        session.add(existing)
    else:
        if minted_from_upload_id is not None:
            raise ValueError(
                f"dataset {dataset_id!r} already has an app-state row; "
                "minted_from_upload_id is written only with a new row"
            )
        existing.owner = owner
    if source_upload_id is not None:
        existing.source_upload_id = source_upload_id
    await session.commit()


async def get_dataset_owner(session: AsyncSession, dataset_id: str) -> str | None:
    """Resolve a dataset's owner from app-state (not from the manifest)."""
    dataset = await session.get(Dataset, dataset_id)
    return dataset.owner if dataset is not None else None


# The complete D-34 visibility model. is_readable treats anything that is not
# exactly "public" as private (fail-closed), and set_dataset_visibility refuses to
# write anything outside this tuple — junk can neither enter nor widen access.
_VISIBILITIES = ("private", "public")


async def get_dataset_visibility(session: AsyncSession, dataset_id: str) -> str:
    """Resolve a dataset's visibility from app-state (D-34). Default-DENY: an unknown
    dataset (no app-state row) resolves to "private" — never "public" — so a
    missing/CLI-transferred/unowned tree is owner-only until the operator publishes
    it. Used by the static-edge gate's public-fast-path cache (routers/authz.py) and,
    conceptually, by may_read below (which fetches the whole row in one go)."""
    dataset = await session.get(Dataset, dataset_id)
    return dataset.visibility if dataset is not None else "private"


async def set_dataset_visibility(
    session: AsyncSession, dataset_id: str, visibility: str
) -> bool:
    """Set a dataset's visibility (D-34) — the operator-driven `api.admin
    set-visibility` writer (appstate stays app-state's sole writer, D-22). Returns
    True when the dataset had an app-state row that was updated; False when there is
    NO row: an unowned/CLI-transferred tree carries the required owner FK only once an
    owner is assigned, so the operator must `assign-owner` before publishing it.
    Commits on success. Rejects any value outside the D-34 model (ValueError) so no
    out-of-model string can ever be written — the CLI's argparse `choices` already
    guards its path; this guards every future programmatic caller the same way
    (is_readable would fail closed on junk, but the invariant belongs at the write)."""
    if visibility not in _VISIBILITIES:
        raise ValueError(
            f"visibility must be one of {_VISIBILITIES}, got {visibility!r}"
        )
    dataset = await session.get(Dataset, dataset_id)
    if dataset is None:
        return False
    dataset.visibility = visibility
    await session.commit()
    return True


# The presentation fields and their length caps. One table, so adding a field is one
# row here rather than a parameter, a boolean and two branches (PR250-6).
#
# There is no `set_dataset_presentation` beside it any more. The three columns above are
# the pre-migration FALLBACK and nothing writes them: both callers — the PATCH route and
# `api.admin`'s three set-* verbs — now write `presentation.json` through
# `api/presentation.py`, whose `apply_updates` carries this function's semantics over
# intact (key presence is the signal, values are the payload, all-or-nothing, an unknown
# key raises rather than 500ing). Leaving a live second writer of the same fact is exactly
# the two-source trap D-xv exists to close, so it was removed rather than left dead.
PRESENTATION_LIMITS: dict[str, int] = {
    "display_name": DISPLAY_NAME_MAX,
    "attribution": ATTRIBUTION_MAX,
    "attribution_url": ATTRIBUTION_URL_MAX,
}


def is_readable(visibility: str, owner: str | None, user: CurrentUser | None) -> bool:
    """THE D-34 read-authorization rule, over already-resolved (visibility, owner):
    a dataset is readable IFF it is PUBLIC, or the caller is its owner. Pure and
    synchronous so a batch caller (list_datasets) can apply it to records it already
    holds without an extra query; the single-dataset gate is may_read below. The
    caller supplies default-DENY inputs for an unknown dataset (visibility="private",
    owner=None), so an anonymous or non-owner caller is denied unless the dataset is
    explicitly public."""
    if visibility == "public":
        return True
    return user is not None and owner is not None and owner == user.username


async def may_read(
    session: AsyncSession, dataset_id: str, user: CurrentUser | None
) -> bool:
    """The ONE read-authorization gate (D-34), resolved from app-state in a single
    row fetch and reused by every read route AND get_job — so the tenant read
    boundary is defined in exactly one place. Readable IFF the dataset is PUBLIC or
    the caller is its owner (is_readable). Default-DENY: an unknown dataset (no
    app-state row — never ingested, or a CLI-transferred/unowned tree) is treated as
    private + ownerless, so it is readable by NOBODY until the operator sets it public
    or assigns an owner. A denied read must surface as the SAME 404 as a missing
    dataset (the caller-side non-disclosure contract)."""
    dataset = await session.get(Dataset, dataset_id)
    if dataset is None:
        return is_readable("private", None, user)  # explicit default-deny
    return is_readable(dataset.visibility, dataset.owner, user)


async def record_dataset_job(
    session: AsyncSession, dataset_id: str, job_id: str
) -> None:
    """Record the dataset's most recent ingest job id at enqueue time (D-28; the
    API stays app-state's sole writer, D-22). Upserts `last_job_id` on the
    EXISTING dataset row — the row is guaranteed by record_dataset_owner on the
    create path and by the ownership check on the re-ingest path, so a missing
    row is an invariant violation and raises rather than silently inserting an
    ownerless dataset."""
    dataset = await session.get(Dataset, dataset_id)
    if dataset is None:
        raise LookupError(
            f"dataset {dataset_id!r} has no app-state row; record_dataset_owner "
            "must run before record_dataset_job"
        )
    dataset.last_job_id = job_id
    await session.commit()


async def record_dataset_source_upload(
    session: AsyncSession, dataset_id: str, upload_id: str
) -> None:
    """Record WHICH finalized upload bundle this dataset was built from (seam L1; the
    API stays app-state's sole writer, D-22). Called by the two routes that resolve a
    bundle and then bake it — create_dataset and an EXPLICITLY NAMED re-ingest —
    immediately after the enqueue that will read it, in the same critical section as
    `record_dataset_job`. The one exception is a MINTED create that made its row: it
    writes the same column through `record_dataset_owner(..., source_upload_id=)`
    BEFORE the enqueue, because there it is the idempotency key (review of PR #373,
    finding 1).

    Always a CALLER-CHOSEN id, never a guess: `create_dataset`'s `body.upload_id` is
    required, and re-ingest calls this only when `body.upload_id` was given. An
    UNNAMED re-ingest never calls this at all (review of PR #390, round 3, findings 1
    and 2 — a round-2 draft of this fix CLEARED the column on any unnamed re-ingest of
    an already-baked dataset, which was itself a regression: it erased a still-
    accurate record the instant an owner re-ingested with nothing new to say, and the
    very next unrelated upload reopened the column's original problem). The route
    instead proceeds only when the record already agrees with the bundle it resolves
    to (nothing to write), or refuses (409) when it does not (see `start_ingest`) —
    so this function is never asked to persist a bundle picked at READ time
    (`_latest_finalized_bundle(owner)`, PR #358 finding 2's original concern) and never
    asked to clear anything either.

    Deliberately a SEPARATE writer from `record_dataset_job`: "which job is running"
    and "which bundle the cells came from" are two facts with two lifetimes, and a job
    id is replaced by every verb (delete-layout, set-roles, add-layouts) while the
    source bundle changes only when the dataset is rebuilt from a NAMED bundle.

    Same invariant as `record_dataset_job`: the row is guaranteed by
    `record_dataset_owner` on the create path and by the ownership check on the
    re-ingest path, so a missing row raises rather than inserting an ownerless
    dataset."""
    dataset = await session.get(Dataset, dataset_id)
    if dataset is None:
        raise LookupError(
            f"dataset {dataset_id!r} has no app-state row; record_dataset_owner "
            "must run before record_dataset_source_upload"
        )
    dataset.source_upload_id = upload_id
    await session.commit()


async def get_dataset_record(
    session: AsyncSession, dataset_id: str
) -> DatasetRecord | None:
    """The full app-state record for one dataset (owner + last_job_id), or None
    when app-state does not know the dataset (e.g. CLI-seeded on disk)."""
    dataset = await session.get(Dataset, dataset_id)
    return _to_record(dataset) if dataset is not None else None


async def get_dataset_record_minted_from_upload(
    session: AsyncSession, owner: str, upload_id: str
) -> DatasetRecord | None:
    """The `owner`'s collection that a MINTED create built from finalized upload
    `upload_id`, or None. The idempotency key of a minted create
    ([[T2-a-minted-create-is-not-idempotent-so-a-retried]]): (owner, upload_id), matched
    against `minted_from_upload_id` — which only a minted create writes — and NOT against
    `source_upload_id`, which re-ingest and authored creates also write (review of PR
    #373, operator finding 1). Live rows only, so a deleted collection no longer claims
    its upload. A row minted before `minted_from_upload_id` existed is not found (the
    column is not backfilled).

    One match is the norm: the key's own 409 stops a second minted create while the first
    row lives. Two can exist only if the upload lock lapsed before the first create
    committed its row; then the OLDEST is returned (then the lowest id, so the answer is
    deterministic even within one whole-second `created_at` tick). A read; commits
    nothing."""
    result = await session.execute(
        select(Dataset)
        .where(Dataset.owner == owner, Dataset.minted_from_upload_id == upload_id)
        .order_by(Dataset.created_at, Dataset.dataset_id)
        .limit(1)
    )
    dataset = result.scalars().first()
    return _to_record(dataset) if dataset is not None else None


async def list_dataset_records(session: AsyncSession) -> list[DatasetRecord]:
    """Every app-state dataset record in ONE query — the list endpoint merges
    these with the on-disk manifests and must not do N+1 app-state reads
    (PR18-1 hygiene). Ordered by dataset_id for a deterministic listing."""
    result = await session.execute(select(Dataset).order_by(Dataset.dataset_id))
    return [_to_record(dataset) for dataset in result.scalars()]


async def delete_dataset_record(session: AsyncSession, dataset_id: str) -> None:
    """Remove the dataset's app-state row (D-28 delete). Users are untouched.
    Idempotent: deleting an absent row is a no-op (the delete route 404s before
    calling this; idempotence just keeps replays harmless)."""
    dataset = await session.get(Dataset, dataset_id)
    if dataset is None:
        return
    await session.delete(dataset)
    await session.commit()
