"""FastAPI app construction, lifespan, router registration, CORS, health check.

This is REAL wiring (it must run): the app constructs, opens one DuckDB
connection per worker via db.open_connection in the lifespan, registers every
router, and answers GET /api/health. It contains no route handlers (those live
in routers) and no business logic.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from rq import Queue

from api import appstate, db, queue
from api.routers import (
    auth,
    authz,
    datasets,
    jobs,
    layouts,
    metadata,
    search,
    tiles,
    uploads,
)

def _resolve_cors_origins() -> list[str]:
    """Resolve the CORS allow-list from the comma-separated ALLOWED_ORIGINS env
    var (default '*', so dev/test behaviour is unchanged). Fails CLOSED in
    production the same way the JWT_SECRET guard does (appstate._jwt_secret):
    with APP_ENV=production a missing/blank ALLOWED_ORIGINS or one containing the
    '*' wildcard is refused, so a misconfigured deploy crash-loops loudly instead
    of silently serving every origin (T2-75). allow_credentials stays False."""
    raw = os.environ.get("ALLOWED_ORIGINS", "*")
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    if appstate._is_production() and (not origins or "*" in origins):
        raise RuntimeError(
            "ALLOWED_ORIGINS must be set to explicit frontend origin(s) in "
            "production (APP_ENV=production); refusing to serve CORS with the "
            "wildcard '*'. Set e.g. ALLOWED_ORIGINS=https://app.example.com "
            "(comma-separated for several)."
        )
    return origins


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Fail fast on bad auth config (e.g. a missing/dev JWT_SECRET when
    # APP_ENV=production) BEFORE opening any resource, so a misconfigured deploy
    # crash-loops loudly instead of 500-ing on the first login (module-map rule
    # #9: the identity-only JWT must be signed with a real secret in production).
    appstate.verify_jwt_config()
    # Same shape for the signup switch (seam SEC-1): an unrecognised ALLOW_SIGNUP
    # is refused here rather than resolved per-request into a 500. The rate
    # limiter's own config was already validated in create_app below.
    auth.verify_signup_config()
    data_root = Path(os.environ.get("DATA_ROOT", "."))
    app.state.db = db.open_connection(data_root)
    # App-state (users + dataset ownership): create the async SQLAlchemy engine +
    # sessionmaker once per process and thread the sessionmaker through app.state
    # to request-scoped deps (no module-level mutable global — module-map rule #8).
    # Separate from the read-only DuckDB path above; appstate.py is the sole writer
    # of app-state. Path/parent-dir come from appstate (env: APP_STATE_DB).
    engine, sessionmaker = await appstate.setup_appstate()
    app.state.appstate_engine = engine
    app.state.appstate_sessionmaker = sessionmaker
    # RQ dispatch (seam 10c): one Redis client + Queue per worker, reached by the
    # write routers via request.app.state.queue (no module-level global — rule #8).
    # Additive: leaves the DuckDB (10b) and app-state (10a) wiring above untouched.
    # The URL resolution lives in queue.py, the module that owns the lock, so the
    # operator CLI reaches the SAME broker this process locks against.
    app.state.redis = queue.redis_client()
    app.state.queue = Queue(connection=app.state.redis)
    try:
        yield
    finally:
        await engine.dispose()
        app.state.db.close()
        # Best-effort pool cleanup; guard for redis-py versions without close().
        close_redis = getattr(app.state.redis, "close", None)
        if callable(close_redis):
            close_redis()


def create_app() -> FastAPI:
    app = FastAPI(title="image-viz api", lifespan=lifespan)
    # CORS allow-list from ALLOWED_ORIGINS (default '*'); production refuses the
    # wildcard and fails closed (_resolve_cors_origins). Wildcard stays safe in
    # dev only because allow_credentials=False (T2-75).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_resolve_cors_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # In-process rate limiter for the three /api/auth/* routes (seam SEC-1). Built
    # here, not in the lifespan: it holds no resource to release, its env config
    # must be refused as early as the CORS allow-list above, and one instance per
    # app means every test gets its own counter. Parked on app.state and reached
    # via request.app.state — no module-level mutable global (module-map rule #8),
    # exactly like app.state.db / app.state.queue. Deliberately NOT Redis-backed:
    # the public compose declares no broker (see AuthRateLimiter).
    app.state.auth_rate_limiter = auth.build_rate_limiter()
    # NO app-wide OSError handler is registered here, and that is deliberate. One was —
    # ENOSPC/EDQUOT to a capacity 413 — and it gave every router in the process the
    # upload router's vocabulary: measured, `GET /api/datasets` answered 413 "This
    # dataset is too large to accommodate" for an internal OSError(ENOSPC), naming a
    # remedy (UPLOAD_DISK_RESERVE_BYTES) with no effect on that route. Registering ANY
    # handler for OSError also moves every OSError subclass past Starlette's
    # `handler is None` early-out into `RuntimeError("Caught handled exception, but
    # response already started")` for the four FileResponse routes in tiles.py (round-3
    # review of PR #304, finding 9). The conversion now lives where the knowledge is,
    # scoped to the three streaming write loops: uploads._streaming_capacity_refusal.

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    for module in (datasets, auth, authz, uploads, layouts, tiles, metadata, search, jobs):
        app.include_router(module.router)

    return app


app = create_app()
