"""GET /api/datasets/{ds_id}/layouts, GET /api/datasets/{ds_id}/layouts/{layout_id}.

The manifest endpoint returns the layout manifest JSON VERBATIM (the pipeline
validated it against layout_manifest.schema.json at write time; it is not
re-modelled in Pydantic nor re-validated here — the JSON Schema is the single
source of truth, and jsonschema is intentionally not an API dependency). Reads are
visibility-scoped (D-34): an OPTIONAL identity (get_optional_user) + appstate.may_read
so a public dataset's manifest/layouts serve anonymously while a private one 404s a
non-owner (the same 404 as a missing dataset). Does not import another router; does
not modify the manifest.

Edge-auth issuance (decision D-A): a successful manifest GET is the dataset-open
point, so for an AUTHENTICATED caller it SETS the `viz_ds` cookie — an HttpOnly,
path-scoped, dataset-scoped 1-hour JWT the Caddy `forward_auth` gate
(`routers/authz.py`) verifies statelessly on every `/datasets/*` static fetch. This
route is already ownership-aware (may_read), so issuing here means the static edge
stops being anonymous for private datasets. D-34: a PUBLIC dataset also serves
anonymously (user is None) — no cookie is minted, and the caller's `/datasets/*`
fetches ride the gate's public-fast-path instead. Re-issuing on every manifest GET
refreshes `exp`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt  # PyJWT — same signer/alg as the identity token (appstate)
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db
from api.models import LayoutInfo, LayoutListResponse

router = APIRouter()

# The HttpOnly cookie name the Caddy forward_auth gate reads (kept in sync with
# routers/authz.py `DATASET_COOKIE_NAME`). Path-scoped per dataset so per-dataset
# cookies coexist (cookies distinguish by (name, path)).
DATASET_COOKIE_NAME = "viz_ds"

# The dataset-scoped edge credential lives 1 hour (D-A). Short by design: the token
# is a capability for the static edge, refreshed on the next manifest open; a
# mid-session lapse surfaces as 401s on tile fetches (see the T2-09 ledger note).
_DATASET_TOKEN_TTL_SECONDS = 60 * 60


def _mint_dataset_token(ds_id: str, username: str) -> str:
    """Sign the dataset-scoped edge JWT: claims `{ds, sub, exp}` (decision D-A),
    HS256 with the shared `JWT_SECRET` (appstate is the single secret source, so
    the production fail-closed guard covers this token too). `ds` is a short-lived
    capability scope, NOT an authorization claim — ownership was already resolved
    for this GET; the token only lets the edge recognise a dataset the caller has
    opened. authz.py verifies signature + exp + `ds == {ds_id}`."""
    now = datetime.now(timezone.utc)
    payload = {
        "ds": ds_id,
        "sub": username,
        "exp": now + timedelta(seconds=_DATASET_TOKEN_TTL_SECONDS),
    }
    return jwt.encode(
        payload, appstate._jwt_secret(), algorithm=appstate._JWT_ALGORITHM
    )


def _is_https_request(request: Request) -> bool:
    """True when the ORIGINAL client request reached the edge over https, so the
    cookie gets `Secure`. Behind Caddy the API sees plain http on the internal hop,
    but Caddy forwards the real scheme in `X-Forwarded-Proto`; fall back to the
    direct request scheme (e.g. a TestClient or a direct https deploy)."""
    forwarded = request.headers.get("x-forwarded-proto")
    if forwarded:
        # May be a comma list through multiple proxies; the first is the client's.
        return forwarded.split(",")[0].strip().lower() == "https"
    return request.url.scheme == "https"


def _set_dataset_cookie(
    response: Response, request: Request, ds_id: str, username: str
) -> None:
    """Set the `viz_ds` edge cookie for `{ds_id}` (decision D-A):
    `Path=/datasets/{ds_id}/; HttpOnly; SameSite=Lax` (+ `Secure` on https). The
    path scope means the browser sends it only on THIS dataset's static asset
    fetches, and per-dataset cookies coexist. max_age mirrors the JWT `exp`."""
    response.set_cookie(
        key=DATASET_COOKIE_NAME,
        value=_mint_dataset_token(ds_id, username),
        max_age=_DATASET_TOKEN_TTL_SECONDS,
        path=f"/datasets/{ds_id}/",
        httponly=True,
        samesite="lax",
        secure=_is_https_request(request),
    )


@router.get("/api/datasets/{ds_id}/layouts")
async def list_layouts(
    ds_id: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> LayoutListResponse:
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    manifest = db.load_manifest(ds_dir)  # 404 if absent
    layouts = [
        LayoutInfo(
            layout_id=layout["layout_id"],
            label=layout["label"],
            type=layout["type"],
        )
        for layout in manifest["layouts"]
    ]
    return LayoutListResponse(layouts=layouts)


@router.get("/api/datasets/{ds_id}/layouts/{layout_id}")
async def get_layout_manifest(
    ds_id: str,
    layout_id: str,
    request: Request,
    response: Response,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> dict[str, Any]:  # the layout manifest JSON, verbatim
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        # Denied (private + not owner) OR unknown — the SAME 404, and NO cookie is
        # minted (only a readable dataset opens). Non-disclosure (D-34).
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    manifest = db.load_manifest(ds_dir)  # 404 if absent; major-version guarded
    # The manifest is dataset-level (carries every layout); the route is
    # layout-scoped, so a layout_id naming no layout in the manifest is a 404.
    if not any(layout["layout_id"] == layout_id for layout in manifest["layouts"]):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Layout not found"
        )
    # Dataset-open (decision D-A): issue the HttpOnly, path-scoped, dataset-scoped
    # edge cookie the Caddy forward_auth gate verifies on `/datasets/*` fetches — ONLY
    # for the dataset's OWNER (D-34). Set AFTER the 404 checks, so only a real,
    # readable dataset mints a credential. Uses the manifest's canonical dataset_id
    # (== ds_dir.name), not the raw path param, so the cookie path matches the served
    # asset path exactly.
    #
    # Owner-ONLY (not merely authenticated-and-may_read) closes a delayed-revocation
    # hole: the private-dataset gate authorizes ANY valid ds-matching cookie without
    # re-checking ownership, so if a NON-owner of a PUBLIC dataset were handed a 1h
    # cookie, they would keep reading its static bytes for up to an hour AFTER the
    # operator un-published it. A non-owner (and an anonymous visitor) of a PUBLIC
    # dataset needs NO cookie — its `/datasets/*` fetches ride the gate's public-fast-
    # path (which re-checks visibility every ≤TTL), which is exactly what makes the
    # showcase login-less; so minting only for the owner is lossless. get_dataset_owner
    # re-uses the row may_read already loaded into this session (identity-map hit, no
    # extra query).
    if user is not None:
        owner = await appstate.get_dataset_owner(session, ds_id)
        if owner is not None and owner == user.username:
            _set_dataset_cookie(response, request, ds_dir.name, user.username)
    return manifest
