"""GET /api/authz/datasets — the Caddy `forward_auth` gate for the static edge (D-A).

Caddy sub-requests this endpoint before its `file_server` serves any `/datasets/*`
asset (the deduped `datasets_edge` snippet's `forward_auth`, decision D-A). It is
the ONLY per-request work behind the static edge, so it is deliberately tiny and
**touches no database**: it reads the forwarded original URI + the `viz_ds` cookie,
statelessly verifies the cookie's dataset-scoped JWT, and answers 2xx (serve the
bytes) / 401 (no/expired credential) / 403 (dataset mismatch or a malformed URI).
The bytes themselves never leave Caddy's `file_server` — only this µs-cheap verify
runs per fetch (the D-A performance premise: no ownership/DB work on the fan-out).

The cookie is issued at dataset-open by the manifest route (`routers/layouts.py`),
which IS ownership-aware; this endpoint only proves the presented credential is a
valid, unexpired token minted for THIS dataset. The token claims are
`{ds, sub, exp}` — `ds` is a short-lived *capability scope* (which dataset this
1-hour edge credential unlocks), not an ownership/role grant: ownership is still
resolved from app-state at issuance time, per D-A's fixed spec. Signed with the
same `JWT_SECRET` and HS256 as the identity token (appstate), so the production
fail-closed secret guard covers this path too.

Public-fast-path (D-34, live): a `visibility=public` dataset is served to anyone —
including anonymously (no cookie) — which is what makes the login-less showcase work.
After extracting + jailing the `ds_id`, this endpoint resolves visibility through a
small in-memory TTL cache (`_visibility_cache`) so the per-tile fan-out does not hit
the app-state DB on every fetch after warmup (the D-A performance premise). The cache
is bounded in SIZE (`_VISIBILITY_CACHE_MAX`, with the 255-byte id cap in
`_extract_ds_id`) because this endpoint is pre-auth — an unbounded dict keyed by
attacker-chosen ids would be a memory-exhaustion DoS. The public check runs AFTER
`_extract_ds_id`, so a traversal path (rejected there) is never authorized as public.
Private datasets are unchanged: the cookie is still required — with one addition: a
request that is ABOUT TO BE DENIED rechecks visibility on a tighter bound
(`_DENY_RECHECK_SECONDS`), so a just-published dataset starts serving within seconds
rather than a full serve-path TTL. Does not import another router.
"""

from __future__ import annotations

import time
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit

import jwt  # PyJWT — same signer as the identity token (appstate)
from fastapi import APIRouter, Cookie, Header, HTTPException, Request, status
from sqlalchemy.ext.asyncio import async_sessionmaker

from api import appstate

router = APIRouter()

# The HttpOnly, path-scoped cookie the manifest route issues (kept in sync with
# routers/layouts.py `DATASET_COOKIE_NAME`). Caddy forwards it to this endpoint on
# every `/datasets/*` sub-request (same-origin: the browser sends it with the
# static fetch, and forward_auth copies the request's Cookie header).
DATASET_COOKIE_NAME = "viz_ds"

# The URL prefix Caddy's `datasets_edge` serves. `forward_auth` forwards the
# ORIGINAL request URI (the snippet sets `X-Forwarded-Uri {http.request.orig_uri}`,
# so `handle_path`'s prefix strip does not hide the id), which is
# `/datasets/{ds_id}/<asset path>` — the ds_id is the segment AFTER this prefix.
_DATASETS_URL_PREFIX = "datasets"

# D-34 public-fast-path cache. This gate runs per `/datasets/*` fetch (the D-A
# performance premise: no per-request DB work on the byte-range fan-out), so the
# public-visibility check is cached `ds_id -> (is_public, stored_at_monotonic)` for a
# short TTL. A module-level PERFORMANCE cache over the authoritative app-state — the
# same pattern as db.py's manifest/schema caches, NOT authorization state itself (the
# app-state DB stays the source of truth). Bounded staleness: an entry can be wrong
# for at most `_VISIBILITY_TTL_SECONDS` on the SERVE path (a just-unpublished dataset
# keeps serving public until the entry ages out — and a private dataset ALWAYS still
# requires a valid cookie, so a stale "public" cannot leak a genuinely-private tree
# that was never published), and for at most `_DENY_RECHECK_SECONDS` on the DENY path
# (before 401/403ing, a verdict older than that is re-read once, so a just-PUBLISHED
# dataset starts serving within seconds — not a full TTL of client retry loops).
#
# Bounded SIZE, not just staleness: this endpoint is pre-auth (Caddy forward_auths
# every /datasets/* fetch here, existent or not), so without a cap an anonymous
# attacker looping unique ds_ids would grow the dict without limit (memory-exhaustion
# DoS). At the cap, expired entries are dropped; if every survivor is still fresh the
# whole cache is cleared — it is only a perf cache, so the worst case is a brief
# re-warm of point reads, never a wrong verdict. The 255-byte id cap in
# _extract_ds_id bounds each key's size the same way.
_VISIBILITY_TTL_SECONDS = 30.0
_DENY_RECHECK_SECONDS = 2.0
_VISIBILITY_CACHE_MAX = 4096
_visibility_cache: dict[str, tuple[bool, float]] = {}


async def _dataset_is_public(
    sessionmaker: async_sessionmaker,
    ds_id: str,
    max_age: float = _VISIBILITY_TTL_SECONDS,
) -> bool:
    """Whether `ds_id` is public, via the short-TTL cache (D-34 public-fast-path). A
    cached verdict no older than `max_age` is served as-is; otherwise ONE app-state
    read resolves visibility and refreshes the entry — after warmup the per-fetch
    fan-out never touches the DB. `max_age` defaults to the serve-path TTL; the deny
    path passes the tighter `_DENY_RECHECK_SECONDS` so publishes propagate fast while
    repeated denials still cost at most one DB read per ds_id per recheck window.
    Default-DENY: an unknown/unowned dataset resolves to "private"
    (appstate.get_dataset_visibility), so a miss can only ever cache is_public=False
    for a non-existent/unpublished dataset — never a spurious public. `time.monotonic`
    keys entry age so a wall-clock change cannot extend or shorten an entry's life."""
    now = time.monotonic()
    cached = _visibility_cache.get(ds_id)
    if cached is not None and now - cached[1] <= max_age:
        return cached[0]
    async with sessionmaker() as session:
        visibility = await appstate.get_dataset_visibility(session, ds_id)
    is_public = visibility == "public"
    if len(_visibility_cache) >= _VISIBILITY_CACHE_MAX and ds_id not in _visibility_cache:
        # Size bound (pre-auth DoS guard): drop aged-out entries first; if the cache
        # is still full of fresh entries, clear it outright — a perf cache may always
        # be rebuilt, and correctness never depends on an entry being present.
        for key, (_, stored_at) in list(_visibility_cache.items()):
            if now - stored_at > _VISIBILITY_TTL_SECONDS:
                del _visibility_cache[key]
        if len(_visibility_cache) >= _VISIBILITY_CACHE_MAX:
            _visibility_cache.clear()
    _visibility_cache[ds_id] = (is_public, now)
    return is_public


def _extract_ds_id(forwarded_uri: str) -> str:
    """Pull `{ds_id}` out of the forwarded original URI `/datasets/{ds_id}/...`.

    Reuses the read routes' path-jail discipline (db.dataset_dir rejects
    `..`/absolute): a URI that does not start with `/datasets/` or whose first
    segment carries a traversal/separator is a malformed probe, not a miss, and
    raises 403. The query string is dropped; only the path decides the id.

    Normalization must match Caddy's `file_server`, which percent-DECODES then
    path-RESOLVES (`.`, `//`, and `..`) before serving. Two mismatches would
    otherwise let the gate read the id off a path file_server resolves elsewhere:
    `urlsplit` leaves the path percent-encoded, and `PurePosixPath.parts` collapses
    `.`/`//` but NOT `..`. So `/datasets/A/../B/...` (or its `%2e%2e` spelling)
    extracts "A" here while file_server serves B — an A-scoped credential would
    unlock B's bytes (R-S10; the hole that silently defeats the D-34 public/private
    visibility model). We DECODE to file_server's view, then REJECT any `..`
    outright — a crafted traversal is never a legitimate asset fetch, so 403 is
    correct and we need not re-implement Caddy's exact path cleaning.

    Rejecting (rather than re-resolving) deliberately NARROWS the gate: a `..` that
    stays INSIDE the dataset — `/datasets/A/tiles/../meta.json`, which file_server
    would happily serve as A's own meta.json — now 403s where it used to pass. No
    real fetch regresses, because clients resolve `..` out of the path before it ever
    hits the wire (RFC 3986 §5.2.4, which every browser implements). The constraint
    this DOES impose is on us: server-side code that hand-builds a dataset asset URL
    must emit it already-normalized rather than lean on the edge to clean it up.

    Decoding EXACTLY ONCE is load-bearing, not incidental: it is the number of
    decodes file_server does. `%252e%252e` must therefore stay the literal segment
    "%2e%2e" (a directory name) and NOT be read as `..` — decoding until stable would
    403 fetches Caddy serves, re-opening the same gate↔file_server split from the
    other side. Both properties are pinned in tests/test_edge_auth.py."""
    # Decode to file_server's view: urlsplit keeps the path percent-encoded, so a
    # `%2e%2e` segment would otherwise slip past the literal `..` check below.
    path = unquote(urlsplit(forwarded_uri).path)
    # PurePosixPath collapses redundant slashes and `.` and gives clean segments;
    # the leading "/" yields a first part of "/", so the real segments start at [1].
    parts = PurePosixPath(path).parts
    # A `..` ANYWHERE is a traversal probe: PurePosixPath does not collapse it, but
    # file_server would, so /datasets/A/../B/... reads as id "A" here yet serves B.
    # Reject the whole request — never best-effort re-resolve to a "real" id.
    if ".." in parts:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Malformed dataset URI"
        )
    if len(parts) < 3 or parts[0] != "/" or parts[1] != _DATASETS_URL_PREFIX:
        # Not a /datasets/{id}/... shape at all — the gate was wired at a path it
        # should never see. Treat as forbidden (a hard misconfig, not a 401 the
        # client could satisfy with a cookie).
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Malformed dataset URI"
        )
    ds_id = parts[2]
    # A ds_id that is empty, "."/".." or carries a path separator is a traversal
    # probe (the read routes jail exactly these via db.dataset_dir). Reject with
    # 403 — indistinguishable from any other forbidden request, and never used to
    # touch the filesystem here (this endpoint reads nothing off disk).
    if ds_id in ("", ".", "..") or "/" in ds_id or "\\" in ds_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Malformed dataset id"
        )
    # Length cap: a dataset id IS a directory name under DATA_ROOT/datasets/, and no
    # mainstream filesystem allows a name over 255 bytes — so an over-long id can
    # never name a real dataset and rejecting it is lossless. It also bounds the
    # per-entry key size of the visibility cache (with _VISIBILITY_CACHE_MAX, the
    # pre-auth memory-DoS guard: without this, a single crafted URI could plant a
    # multi-KB key per request).
    if len(ds_id) > 255:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Malformed dataset id"
        )
    return ds_id


def _verify_cookie(viz_ds: str | None, ds_id: str) -> HTTPException | None:
    """Verify the `viz_ds` cookie's dataset-scoped JWT against `ds_id`. Returns None
    on a valid, unexpired token whose `ds` claim matches; otherwise the HTTPException
    the caller should raise (401 missing/expired/invalid — the client re-opens the
    manifest to refresh; 403 minted-for-a-different-dataset). Returned rather than
    raised so the route can interpose the D-34 deny-path visibility recheck between
    the verdict and the raise. A µs-cheap signature+claims check that touches
    nothing."""
    if viz_ds is None:
        # No credential presented — the browser has not opened this dataset's
        # manifest yet (or the path-scoped cookie is for a different dataset).
        return HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="No dataset credential",
        )
    try:
        claims = jwt.decode(
            viz_ds,
            appstate._jwt_secret(),
            algorithms=[appstate._JWT_ALGORITHM],
        )
    except jwt.InvalidTokenError:
        # Bad signature, expired (ExpiredSignatureError is a subclass), or
        # otherwise malformed.
        return HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired dataset credential",
        )
    # The token is a per-dataset capability: a valid cookie for dataset A must not
    # unlock dataset B (cookies are path-scoped so this rarely fires, but the check
    # is the real authorization boundary — never trust the path scope alone).
    if claims.get("ds") != ds_id:
        return HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Credential is for a different dataset",
        )
    return None


@router.get("/api/authz/datasets")
async def authorize_dataset_asset(
    request: Request,
    x_forwarded_uri: str | None = Header(default=None),
    viz_ds: str | None = Cookie(default=None),
) -> dict[str, str]:
    """Per-request gate for a `/datasets/{ds_id}/*` static fetch (D-A / D-34).

    Order: extract + jail the `ds_id` (403 on a traversal/malformed/over-long URI) →
    the D-34 PUBLIC-fast-path (200 with NO cookie for a public dataset, via the
    short-TTL visibility cache) → otherwise verify the `viz_ds` cookie's
    dataset-scoped JWT against the id → on a FAILED verify, one tighter-bounded
    visibility recheck (`_DENY_RECHECK_SECONDS`) before denying, so a just-published
    dataset starts serving within seconds instead of a full TTL of client 401-retry
    loops (the recheck runs only on requests that were about to be denied — never on
    the hot serve path — and costs at most one DB read per ds_id per recheck window).
    200 (empty-ish body — Caddy discards it and serves the bytes) for a public
    dataset OR a valid, unexpired token whose `ds` claim matches; 401 when a private
    dataset's cookie is missing or expired/invalid; 403 when the URI is malformed or
    the token was minted for a DIFFERENT dataset. The public check is cache-served so
    the byte-range fan-out stays off the DB after warmup (the D-A performance
    premise); a private dataset's cookie verify is a µs-cheap signature+claims check
    that touches nothing."""
    if x_forwarded_uri is None:
        # forward_auth always sets it (the snippet forwards orig_uri); its absence
        # means a direct hit on this internal endpoint, not a real edge fetch.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Missing forwarded URI"
        )
    ds_id = _extract_ds_id(x_forwarded_uri)  # 403 on traversal/malformed

    # D-34 public-fast-path: a PUBLIC dataset is served to anyone, including
    # anonymously — no cookie required (the login-less showcase). Resolved through the
    # short-TTL visibility cache so the per-tile fan-out does not hit the DB after
    # warmup. Checked AFTER _extract_ds_id: the id is already jailed (no traversal
    # segment reaches this lookup), so a crafted `..` path can never be authorized as
    # public.
    sessionmaker = request.app.state.appstate_sessionmaker
    if await _dataset_is_public(sessionmaker, ds_id):
        return {"status": "ok"}

    denial = _verify_cookie(viz_ds, ds_id)
    if denial is None:
        # 2xx: Caddy proceeds to file_server. Body is inconsequential (discarded).
        return {"status": "ok"}
    # Deny-path visibility recheck (D-34): the fast-path verdict above may be a
    # cached "private" up to a full TTL old. Before turning that into a 401/403, if
    # the entry is older than the (much tighter) deny window, re-read once — a
    # just-published dataset then serves within _DENY_RECHECK_SECONDS. An attacker
    # hammering a denied id forces at most one DB point-read per recheck window (the
    # refreshed entry answers the rest), so the D-A fan-out premise holds.
    if await _dataset_is_public(sessionmaker, ds_id, max_age=_DENY_RECHECK_SECONDS):
        return {"status": "ok"}
    raise denial
