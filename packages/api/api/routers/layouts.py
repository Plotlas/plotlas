"""GET /api/datasets/{ds_id}/layouts, GET /api/datasets/{ds_id}/layouts/{layout_id}.

The manifest endpoint returns the layout manifest JSON VERBATIM (the pipeline
validated it against layout_manifest.schema.json at write time; it is not
re-modelled in Pydantic nor re-validated here — the JSON Schema is the single
source of truth, and jsonschema is intentionally not an API dependency).

`list_layouts` also serves the PER-LAYOUT STATE (seam L1): the manifest lists what is
committed, the active job's `JobProgress` lists what is in flight, and the list route
merges them so a consumer learns "the datetime layout is now viewable" without a second
round trip. It reads RQ; it never enqueues and never writes a manifest.

Reads are
visibility-scoped (D-34): an OPTIONAL identity (get_optional_user) + appstate.may_read
so a public dataset's manifest/layouts serve anonymously while a private one 404s a
non-owner (the same 404 as a missing dataset). Does not import another router; does
not modify the manifest.

Edge-auth issuance (decision D-A): a successful manifest GET is the dataset-open
point, so for the dataset's OWNER (D-34, see the comment at the issuance site — a
non-owner of a PUBLIC dataset needs no cookie) it SETS the `viz_ds` cookie — an HttpOnly,
path-scoped, dataset-scoped 1-hour JWT the Caddy `forward_auth` gate
(`routers/authz.py`) verifies statelessly on every `/datasets/*` static fetch. This
route is already ownership-aware (may_read), so issuing here means the static edge
stops being anonymous for private datasets. D-34: a PUBLIC dataset also serves
anonymously (user is None) — no cookie is minted, and the caller's `/datasets/*`
fetches ride the gate's public-fast-path instead. Re-issuing on every manifest GET
refreshes `exp`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Literal, NamedTuple

import jwt  # PyJWT — same signer/alg as the identity token (appstate)
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError
from redis.exceptions import RedisError
from rq.exceptions import NoSuchJobError  # type: ignore[import-untyped]
from rq.job import Job  # type: ignore[import-untyped]
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db
from api.models import JobProgress, LayoutInfo, LayoutListResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# RQ states that mean "a job is in flight" for this dataset (D-28). Routers may not
# import one another (module-map rule), so this mirrors datasets._ACTIVE_JOB_STATES and
# jobs._ACTIVE_JOB_STATES rather than sharing them. Anything else — failed, finished, a
# missing/expired job, or an unreachable broker — is not in flight, and the layout list
# then reports every committed layout `live`, which is the correct fallback: the
# manifest is the authority on what exists and the job channel is only an overlay.
_ACTIVE_JOB_STATES = {"queued", "started"}

# The per-layout progress stage key the pipeline's reporter writes
# (`worker.py`: f"layout:{layout_id}"). The in-flight half of the merge below reads
# layout ids back OUT of it, so the prefix is a cross-process convention: it is stated in
# `JobProgressStage.key`'s own docstring and in docs/interface-catalogue.md.
_LAYOUT_STAGE_PREFIX = "layout:"

# The HttpOnly cookie name the Caddy forward_auth gate reads (kept in sync with
# routers/authz.py `DATASET_COOKIE_NAME`). Path-scoped per dataset so per-dataset
# cookies coexist (cookies distinguish by (name, path)).
DATASET_COOKIE_NAME = "viz_ds"

# The dataset-scoped edge credential lives 1 hour (D-A). Short by design: the token
# is a capability for the static edge, re-issued by every manifest GET BY THE DATASET'S
# OWNER (D-34 — see the issuance site; a signed-in non-owner of a PUBLIC dataset is
# never handed one). A mid-session lapse is handled below the loader — a 401 on a
# static-edge read fires client.ts's single-flight `refreshDatasetCredential`
# (per-dataset coalesce, 30 s cooldown) and the read retries ONCE (T2-09's D-i
# residual).
#
# A refresh can fail WITHOUT the session being dead: the cooldown refuses it, or the
# re-opened manifest 404s because ownership moved. What the user then sees depends on
# which read hit the 401 — a tile range read falls through the loader's normal path
# (pmtilesClient.ts), while the arrow/tags fetch treats an uncured 401 as an expired
# session and prompts re-login (client.ts `signalAuthExpiredIf401`, T2-123). The
# ownership-moved case therefore reads as a logout for one of the two paths
# (T2-a-revoked-dataset-can-log-the-user-out-of-the).
#
# Nothing clears this cookie on sign-out: there is no delete_cookie in this package,
# so it stays valid until it expires
# (T2-the-viz-ds-cookie-outlives-sign-out-and-session).
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
    fetches, and per-dataset cookies coexist. max_age is THIS token's own one-hour
    `exp` (`_DATASET_TOKEN_TTL_SECONDS`) — one hour, NOT the session token's 24."""
    response.set_cookie(
        key=DATASET_COOKIE_NAME,
        value=_mint_dataset_token(ds_id, username),
        max_age=_DATASET_TOKEN_TTL_SECONDS,
        path=f"/datasets/{ds_id}/",
        httponly=True,
        samesite="lax",
        secure=_is_https_request(request),
    )


class ActiveJob(NamedTuple):
    """The three things the layout merge reads off an in-flight job: its live
    `JobProgress` (the per-layout stages — None until the worker has published one), its
    PLAN (the layouts it will bake), and the `replace` list its own enqueue kwargs carry
    (which COMMITTED layouts this job will re-bake)."""

    progress: JobProgress | None
    planned: list[str]
    replace: list[str]


def _replace_ids(kwargs: Any) -> list[str]:
    """The `replace` list the active job was ENQUEUED with — the committed layout ids
    this job was explicitly asked to re-bake.

    This is the job's own REQUEST read back, not a re-derivation: `add_layouts` forwards
    `body.replace` verbatim as a JSON primitive (`queue.enqueue_add_layouts`), so these
    ids are already the expanded, committed ones the API was handed. `spec_layouts`
    cannot answer the same question, because it is `payload.layout_specs` verbatim and a
    bare FAMILY spec ("categorical") is not a layout_id at all
    ([[T2-a-family-spec-is-reported-under-the-family-name]]) — which is why a
    family-spec re-bake reported no pending re-bake on any of the ids it was about to
    replace. Reading the kwarg crosses no pipeline convention: it is what the caller
    said, not `worker._family_layout_names`' expansion rule transcribed API-side.

    Best-effort by construction: an ingest / delete-layout / set-roles job carries no
    `replace` kwarg at all, and a value that is not a list of strings is dropped rather
    than trusted — this is an overlay on an authoritative manifest, not a contract."""
    if not isinstance(kwargs, dict):
        return []
    raw = kwargs.get("replace")
    if not isinstance(raw, list):
        return []
    return [layout_id for layout_id in raw if isinstance(layout_id, str)]


def _planned_ids(kwargs: Any) -> list[str]:
    """The PLAN the active job was ENQUEUED with — `layout_specs` (add-layouts) or
    `layout_types` (ingest), read back off the job's own kwargs — for the window before
    the worker has published a `JobProgress`.

    That window is the whole queue wait. `job.meta["progress"]` has exactly one writer,
    `Reporter.start_job`, and it runs INSIDE the worker; `enqueue_ingest` and
    `enqueue_add_layouts` pass no `meta=`. So every job in RQ state `queued` has no
    progress at all, and reading the plan from progress alone made `include_pending`
    answer `[]` for a queued first ingest and `rebake` never say "queued" for a queued
    `--replace` (review of PR #358, round 3, finding 2).

    It is the SAME list the worker publishes, not an approximation of it: `run_ingest`
    calls `reporter.start_job(payload.layout_types, …)`, `run_add_layouts` calls
    `reporter.start_job(payload.layout_specs, …)`, and `run_ingest_job` /
    `run_add_layouts_job` build both payload fields from these kwargs with `list(...)`.
    A queued job's plan and the same job's `spec_layouts` one poll after it starts are
    therefore identical — the family-spec caveat included
    ([[T2-a-family-spec-is-reported-under-the-family-name]]).

    A delete-layout or set-roles job carries neither key and bakes nothing: `[]`. A value
    that is not a list of strings is dropped, as in `_replace_ids` — an overlay on an
    authoritative manifest, not a contract."""
    if not isinstance(kwargs, dict):
        return []
    for key in ("layout_specs", "layout_types"):
        raw = kwargs.get(key)
        if isinstance(raw, list):
            return [spec for spec in raw if isinstance(spec, str)]
    return []


def _active_job(connection: Any, job_id: str) -> ActiveJob | None:
    """The live `JobProgress`, plan and `replace` list of `job_id`, but ONLY while that
    job is in flight (queued|started); None otherwise.

    ONE Redis round-trip, and that is now true rather than merely claimed: `Job.fetch`
    restores the whole job — the status hash, `meta` and `kwargs` — so `get_status`,
    `get_meta` and `.kwargs` all read what the fetch already loaded. `refresh=True` is
    rq's DEFAULT and re-reads the status hash from Redis, which added a second
    round-trip to every viewer boot and every designer poll; `datasets._status_of`
    states the same fix ("`get_status` was already loaded by fetch_many (refresh=False
    avoids a second per-job round-trip)").

    SYNCHRONOUS (rq is sync), so it is always invoked via `run_in_threadpool`: this route
    is fetched on every viewer open and every designer poll, and blocking Redis I/O on
    the event loop is the defect `_build_job_status` was moved off the loop for.

    BEST-EFFORT IN EVERY FAILURE DIRECTION, because the in-flight half is an OVERLAY on
    a manifest that is already authoritative. A missing/expired job, an unreachable
    broker (logged, never silent), a CORRUPT job payload, a finished job, or a meta /
    kwargs read that raises all answer None — and the layout list then reports the
    committed layouts exactly as it did before seam L1. Degrading to today's answer is
    the correct failure mode; 500-ing a read because the job channel is down is not.

    An in-flight job with NO USABLE `progress` is NOT None, and must not be: that is every
    job in RQ state `queued` (see `_planned_ids` — the snapshot is written only inside the
    worker). Its `progress` is None, so it contributes no stages, and its plan comes from
    its own enqueue kwargs. A snapshot that will not parse is treated the same way — the
    kwargs are still the job's request, so they still say what it will bake.

    The fetch and the status read are guarded TOGETHER, under a broad `except Exception`
    fallback, in the shape `datasets._status_of` / `_job_states` already use. Two escapes
    made that necessary and both are on the viewer's boot path: a broker drop BETWEEN the
    fetch and the status read propagated, and `Job.fetch` DESERIALIZES, so a corrupt
    payload raises rq's `DeserializationError` — which is not a `RedisError` and so
    escaped the guard. `_job_states` carries a comment about exactly that failure on the
    dataset listing, the sibling incident on the sibling endpoint."""
    try:
        job = Job.fetch(job_id, connection=connection)
        # refresh=False: the fetch above already loaded the status hash.
        raw_status = job.get_status(refresh=False)
    except NoSuchJobError:
        return None
    except RedisError as exc:
        logger.warning("RQ unreachable while reading layout state for %r: %s", job_id, exc)
        return None
    except Exception:  # noqa: BLE001 — a corrupt payload must never 500 a layout list
        logger.warning("Unreadable job %r while reading layout state", job_id)
        return None
    state = str(getattr(raw_status, "value", raw_status)) if raw_status is not None else None
    if state not in _ACTIVE_JOB_STATES:
        return None
    try:
        meta = job.get_meta(refresh=False) or {}
        kwargs = job.kwargs
    except Exception:  # noqa: BLE001 — advisory channel; never fail a read on it
        logger.warning("Unreadable job meta while reading layout state for %r", job_id)
        return None
    raw = meta.get("progress")
    progress: JobProgress | None = None
    if isinstance(raw, dict):
        try:
            progress = JobProgress.model_validate(raw)
        except ValidationError:
            progress = None
    planned = list(progress.spec_layouts) if progress is not None else _planned_ids(kwargs)
    return ActiveJob(progress=progress, planned=planned, replace=_replace_ids(kwargs))


def _committed_at(ds_dir: Path, entry: dict) -> datetime | None:
    """When this layout's bytes landed — the mtime of its own PMTiles container, as an
    aware UTC datetime, or None when it cannot be stat'ed.

    The manifest carries no per-layout timestamp, and the one it does carry
    (`dataset_metadata.ingest_timestamp`) is the DATASET's: `append_manifest_layouts`
    copies it forward verbatim, so a layout added months after the first ingest would
    report the first ingest's time. The container is the layout's own artefact and is
    written exactly when the layout commits — a carried-forward entry keeps its file and
    therefore its mtime, and a `--replace` re-bake writes a fresh version-stamped file
    and therefore a fresh one. `pyramid.path` is REQUIRED by the manifest schema, so
    there is always a file to ask.

    None rather than an exception on any read problem: a layout list must not 500
    because one container was swept, is on a filesystem that lost its mtime, or is
    unreadable by this uid.

    JAILED under the dataset dir through `db.resolve_under`, exactly as
    `tiles.get_pyramid` reads the SAME manifest field. `ds_dir / rel` was not a jail:
    `Path.__truediv__` DROPS the base for an absolute right-hand side
    (`Path("/data/datasets/ds1") / "/etc/shadow"` is `/etc/shadow`), and `..` walks out
    of it. The pipeline never writes either, but a manifest is not only ever the
    pipeline's — a restored or copied collection, or one an operator edited by hand,
    carries whatever it carries (review of PR #358, round 3, finding 4). An escape is
    `resolve_under`'s 404 `HTTPException`, not an `OSError`, so both are caught: a
    layout whose container path leaves the dataset has no knowable commit time, and
    says so with None rather than 404-ing the whole list."""
    pyramid = entry.get("pyramid")
    rel = pyramid.get("path") if isinstance(pyramid, dict) else None
    if not isinstance(rel, str) or not rel:
        return None
    try:
        container = db.resolve_under(ds_dir, *PurePosixPath(rel).parts)
        mtime = container.stat().st_mtime
    except (HTTPException, OSError):
        return None
    return datetime.fromtimestamp(mtime, tz=timezone.utc)


def _layout_stage_states(progress: JobProgress | None) -> dict[str, str]:
    """`{layout_id: stage state}` for the job's per-layout stages, read back out of the
    `layout:{layout_id}` stage keys the pipeline's reporter writes. These are the only
    place a REAL expanded layout id appears before the manifest carries it — see
    `_pending_layouts` for why `spec_layouts` is not one."""
    if progress is None:
        return {}
    return {
        stage.key[len(_LAYOUT_STAGE_PREFIX):]: stage.state
        for stage in progress.stages
        if stage.key.startswith(_LAYOUT_STAGE_PREFIX)
    }


def _rebake_state(
    layout_id: str, planned: list[str], replace: list[str], stages: dict[str, str]
) -> Literal["queued", "baking"] | None:
    """The pending re-bake on an ALREADY-COMMITTED layout: "baking" while its stage runs,
    "queued" while the job plans it but has not started it, else None.

    TWO sources say "this committed layout is going to be re-baked", and the second is
    the one that makes a family re-bake reportable at all:

    * its id appears in `planned` (`JobProgress.spec_layouts`, or while the job is still
      queued the identical list off its enqueue kwargs — `_planned_ids`) — true whenever
      the caller named the layout itself;
    * its id appears in `replace` — the job's OWN enqueue kwargs. A re-bake of a
      multi-entry family is enqueued as `{"layout_specs": ["categorical"], "replace":
      ["categorical_kingdom", "categorical_phylum"]}`: `spec_layouts` is then
      `["categorical"]` and matches NEITHER committed id, so on `planned` alone every
      affected card reported no pending re-bake until the worker published real
      `layout:{id}` stages — which `worker.run_add_layouts` does only after
      `_scan_image_index`, `decode_thumbnails` and the id-integrity guard, i.e. after the
      longest part of the run. That is precisely the "live, with a re-bake pending" state
      (D-xxi) this field was added to carry, null for most of the window it matters in.
      Reading `replace` is reading the REQUEST, not re-deriving
      `worker._family_layout_names`' expansion convention on the API side of the
      boundary that exists to prevent that copy.

    A TERMINAL stage state (done|failed) is None on purpose, from either source. Both
    mean nothing is pending: `done` means the re-bake already flipped (the entry read
    here IS the new one — `db.load_manifest` keys its cache on mtime, so the rewrite is
    picked up immediately), and `failed` means the committed layout was left untouched by
    the per-layout commit isolation. Which of the two happened is the JOB route's report
    to make, not this one's — a layout card asks "can I open it and is more coming", and
    the answer to both is unchanged by a failure."""
    stage = stages.get(layout_id)
    if stage == "running":
        return "baking"
    if stage == "queued" or (
        stage is None and (layout_id in planned or layout_id in replace)
    ):
        return "queued"
    return None


def _pending_layouts(
    committed_ids: set[str], planned: list[str], stages: dict[str, str]
) -> list[LayoutInfo]:
    """The in-flight layouts that are NOT yet in the manifest, in the order the job
    plans them, followed by any stage id the plan did not name.

    WHAT A "PLANNED" ENTRY ACTUALLY IS, measured against the producer rather than
    assumed: `JobProgress.spec_layouts` is `payload.layout_specs` / `layout_types`
    verbatim (`worker.run_add_layouts` and `run_ingest` both pass it straight to
    `reporter.start_job`), and a spec may be a bare FAMILY name that expands to several
    layout ids — `"categorical"` becomes `categorical_kingdom`, `categorical_phylum`, …
    whenever the roles carry more than one entry for it. So a spec is what the CALLER
    ASKED FOR, not necessarily a layout_id. Reported under exactly that name, because
    the alternative is to transcribe `worker._family_layout_names`' expansion convention
    into the API — a second copy of a pipeline rule, which is the thing this boundary
    exists to prevent. It self-corrects the moment the worker publishes real
    `layout:{id}` stages, and it is filed
    ([[T2-a-family-spec-is-reported-under-the-family-name]]).

    Neither `label` nor `type` is knowable for a layout that has not been baked — the
    plugin decides both at bake time — so `label` echoes the id and `type` is the empty
    string. A card renders the id until the manifest supplies the real pair.

    A TERMINAL stage (done|failed) is DROPPED rather than reported: the manifest is the
    authority on what exists, so `done` means the layout is already in the committed
    half above (or will be on the next poll), and `failed` means it does not exist and
    this job will not produce it. Inventing a `queued` row for either would be a lie in
    the one direction that costs a user a wait for something that is never coming.

    Takes the ALREADY-COMPUTED `planned` + `stages` rather than a `JobProgress`, so
    `_layout_stage_states` — the single place that encodes the cross-process `layout:`
    key convention — has one call site per request instead of two, and so this helper is
    testable without constructing a `JobProgress`."""
    ordered: list[str] = list(planned)
    ordered += [lid for lid in stages if lid not in ordered]
    out: list[LayoutInfo] = []
    seen: set[str] = set()
    for layout_id in ordered:
        if layout_id in committed_ids or layout_id in seen:
            continue
        seen.add(layout_id)
        stage = stages.get(layout_id)
        if stage in ("done", "failed"):
            continue
        out.append(
            LayoutInfo(
                layout_id=layout_id,
                label=layout_id,
                type="",
                state="baking" if stage == "running" else "queued",
            )
        )
    return out


@router.get("/api/datasets/{ds_id}/layouts")
async def list_layouts(
    ds_id: str,
    request: Request,
    include_pending: bool = False,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
) -> LayoutListResponse:
    """Every layout of this dataset, merged from the two records that hold the answer
    (seam L1, [[T2-nothing-exposes-a-per-layout-completion-state]]): the MANIFEST lists
    the committed layouts, the active job's `JobProgress` lists the ones in flight, and
    this is the join. Served here rather than behind a new endpoint because layouts are
    already fetched here — the viewer indicator D-xiii asks for must not cost a second
    round trip.

    `include_pending` (default FALSE) decides whether layouts that are in flight but NOT
    yet committed are APPENDED to the list. It defaults off because this response feeds
    the viewer's layout switcher (`ViewerScreen` → `LayoutSwitcher`, and `bootLayoutId`
    which falls back to `layouts[0]`), and a switcher entry for a layout with no tiles
    is a control that cannot work. The committed rows carry their new state fields
    either way, so a consumer that only wants "is my layout being re-baked" needs no
    flag; the designer, which renders a QUEUE, opts in. Every other seam-L1 field is
    unconditional, so this is the one knob and it exists to avoid breaking a shipped
    screen, not to hide anything.

    **`include_pending` ALSO answers for a dataset with no manifest yet**, which is the
    one window it exists for. A collection has an app-state row from the moment
    `create_dataset` enqueues and a manifest only when the first bake COMMITS, so the
    committed half is legitimately empty for the whole first ingest — the longest and
    most opaque wait a user has, and exactly what the designer's queue view renders.
    Answering 404 there (as the unconditional `load_manifest` did) made the flag
    unreachable for every collection that had never baked; it worked only for
    add-layouts onto an already-committed dataset. The committed half is then `[]` and
    the answer comes from the job channel alone. Every OTHER absent-manifest case still
    404s: without the flag, without an app-state row, or for a caller `may_read` refuses.

    VISIBILITY (D-34, §1.4 of the seam brief): reads stay gated on `may_read`, so a
    public dataset's layouts serve anonymously and a private one 404s a non-owner. The
    seam-L1 fields are NOT owner-scoped. What each one tells an anonymous reader of a
    public dataset, field by field — pinned by
    `test_an_anonymous_reader_of_a_public_dataset_is_told_one_new_fact`:

    * `layout_id`/`label`/`type`/`source_columns`/`options` on a committed row — the
      manifest entry, which `GET .../layouts/{layout_id}` serves that reader verbatim.
    * `committed_at` — the container's mtime, which `GET .../pyramid/{layout_id}.pmtiles`
      already serves that reader as `Last-Modified` (Starlette's `FileResponse` stamps it
      from the same `stat`, under the same `may_read`). `Last-Modified` is an HTTP-date,
      so it carries whole seconds; the sub-second remainder is the only part this adds.
    * `state` and the ids of pending rows, once the worker has published progress — the
      job's `spec_layouts` and `layout:{id}` stages, which `GET /api/jobs/{id}` serves
      that reader (`DatasetSummary.active_job_id` names the job, unmasked).
    * the same, while the job is still QUEUED — read off the job's enqueue kwargs
      (`_planned_ids`), which the job route does not expose. It is an EARLIER sight of
      the same list, not a different one: the worker publishes it verbatim as
      `spec_layouts` the moment it starts.
    * **`rebake` — THE ONE NEW FACT.** Beyond what the plan and stages already say, it
      is resolved from the job's `replace` kwarg (`_replace_ids`), and neither `JobStatus`
      nor `JobProgress` carries `replace`. So an anonymous reader learns "this job will
      replace these committed layouts", which no other route tells them. It is public ON
      PURPOSE: the ids are committed layout ids that reader can already see, and showing
      a viewer that the layout it is looking at is being re-baked is exactly what
      [[T2-the-viewer-cannot-say-that-a-new-layout-is-baking]] asks for.

    `JobStatus.result` — the verb's raw return — is NOT exposed this way at all; it is
    owner-only (`jobs._read_job_result`)."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    record = await appstate.get_dataset_record(session, ds_id)
    # The COMMITTED half. Normally the manifest, and its absence is a 404 — except in the
    # designer's own window: `include_pending` on a dataset app-state knows but that has
    # never committed a bake answers from the job channel with an empty committed half
    # (see the docstring). `load_manifest` still runs, and still 404s, everywhere else —
    # and it keeps its major-version guard for every tree that HAS a manifest.
    committed: list[dict[str, Any]]
    if include_pending and record is not None and not db.is_dataset(ds_dir):
        committed = []
    else:
        committed = db.load_manifest(ds_dir)["layouts"]  # 404 if absent
    # The in-flight half, at the cost of ONE Redis round-trip and only when app-state
    # actually records a job for this dataset (a CLI-seeded or never-enqueued dataset
    # does none). The same bounded trade `datasets.get_dataset` already makes for
    # `active_job_id`. Off the event loop, always.
    job_id = record.last_job_id if record is not None else None
    active = (
        await run_in_threadpool(
            _active_job, request.app.state.queue.connection, job_id
        )
        if job_id is not None
        else None
    )
    planned = list(active.planned) if active is not None else []
    replace = list(active.replace) if active is not None else []
    stages = _layout_stage_states(active.progress if active is not None else None)
    layouts = [
        LayoutInfo(
            layout_id=layout["layout_id"],
            label=layout["label"],
            type=layout["type"],
            # A committed layout is LIVE — its tiles are on disk and serve — even while
            # a re-bake of it is in flight. See LayoutInfo.rebake for why that case
            # resolves this way rather than by flipping `state`.
            state="live",
            rebake=_rebake_state(layout["layout_id"], planned, replace, stages),
            committed_at=_committed_at(ds_dir, layout),
            # `.get`, so an entry that PREDATES manifest v2.9 stays None (unknown) and
            # is never flattened to [] ("recorded, and there are none"). The frontend's
            # stale preview reads the difference.
            source_columns=layout.get("source_columns"),
            # `.get` again, for the same reason one minor later: an entry that PREDATES
            # manifest v2.10 stays None (unchecked) and is never flattened to `{}`
            # ("reads no column, so nothing can stale it"). Absent is never "fresh".
            #
            # `isinstance` because `LayoutInfo.source_fingerprint` is typed `dict | None`
            # and a hand-edited manifest can carry anything: a top-level string reached
            # pydantic and 500'd the layout list, against this route's own rule that an
            # unexpected shape must not (2026-09-23 review, finding 6). A malformed value
            # reads as ABSENT — unchecked, which is never "fresh".
            source_fingerprint=(
                layout["source_fingerprint"]
                if isinstance(layout.get("source_fingerprint"), dict)
                else None
            ),
            options=layout.get("options"),
        )
        for layout in committed
    ]
    if include_pending:
        layouts += _pending_layouts(
            {lay["layout_id"] for lay in committed}, planned, stages
        )
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
