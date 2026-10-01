"""Tier-1 tests for seam L1: the per-layout state merge, the two lifecycle write
routes, and the columns read.

Mocked RQ throughout (no live Redis, no worker) — a fake ``Job.fetch`` supplies the job
state, ``job.meta`` and the verb's return value, exactly like ``test_progress_api``.
App-state owner/job seeds use a second engine over the same SQLite file (one
``asyncio.run`` each), which is this directory's established pattern.

Most assertions below are about a MERGE of a manifest with a job, and a purpose-built
manifest string states the shape it is testing where a reader can see it.

THE SHAPES MUST BE ONES PRODUCTION PRODUCES (review of PR #358, round 3: "each one has a
test that passes on a state production never reaches"). Two rules follow from it:

* a test about what a COMMITTED TREE contains — the columns route above all — copies a
  real committed fixture from ``tests/fixtures/`` (``_copy_fixture``; the originals are
  READ-ONLY and are never written), instead of hand-building a tree the pipeline would
  never write. An images-only ingest writes a ``metadata.parquet`` too, and a test that
  omitted it is how the images-only answer went wrong;
* a test about an in-flight job takes the job's kwargs from the REAL enqueue path — a
  route call captured by ``_FakeQueue`` — and a ``queued`` job carries NO progress,
  because ``job.meta["progress"]`` is written only inside the worker. ``_FakeJob``
  refuses the impossible combination outright.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from collections.abc import Iterator
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api import appstate

# The committed fixture trees (read-only; copied, never written). Same anchor as
# test_read_serve / test_presentation.
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}
_SIGNUP_BOB = {"username": "bob", "email": "bob@example.com", "password": "s3cretpw"}
_LOGIN_BOB = {"username": "bob", "password": "s3cretpw"}


def _manifest(*layouts: dict) -> str:
    """A schema-shaped v2 manifest carrying exactly ``layouts``."""
    return json.dumps(
        {
            "manifest_version": "2.9",
            "dataset_id": "ds1",
            "dataset_version": 3,
            "dataset_metadata": {
                "image_count": 3,
                "ingest_timestamp": "2026-01-01T00:00:00Z",
            },
            "layouts": list(layouts),
        }
    )


def _entry(layout_id: str, label: str, type_: str, **extra: object) -> dict:
    """One layoutEntry with the pyramid block `committed_at` is derived from."""
    entry: dict = {
        "layout_id": layout_id,
        "label": label,
        "type": type_,
        "bbox": [0.0, 0.0, 1.0, 1.0],
        "pyramid": {
            "container": "pmtiles",
            "path": f"tiles/{layout_id}/{layout_id}_v3.pmtiles",
            "tile_px": 512,
            "thumb_px": 64,
            "cap": 64,
            "levels": [0],
            "z_cap": 1,
        },
    }
    entry.update(extra)
    return entry


class _FakeQueue:
    """Captures the (dotted path, kwargs) of the last enqueue and hands back a job id."""

    def __init__(self) -> None:
        self.connection = object()  # passed to Job.fetch; monkeypatched away in tests
        self.calls: list[tuple[str, dict]] = []

    def enqueue(self, func_string, kwargs=None, *, job_timeout=None):  # noqa: ANN001, ANN201
        self.calls.append((func_string, dict(kwargs or {})))
        return SimpleNamespace(id="job-l1-1")


class _FakeRedis:
    """The per-dataset mutation lock, WITH A LOG. `events` records every acquire and
    release, and `_patch_job`'s `on_fetch` hook appends to the same list, so a test can
    assert the ORDER of the two — specifically that the in-flight guard's job read
    happens inside the lock and not before it (review of PR #358, finding 13)."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def lock(self, name, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        def _acquire(*a, **k):  # noqa: ANN002, ANN003, ANN202
            self.events.append("lock-acquire")
            return True

        def _release(*a, **k):  # noqa: ANN002, ANN003, ANN202
            self.events.append("lock-release")

        return SimpleNamespace(acquire=_acquire, release=_release)


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    (data_root / "datasets").mkdir(parents=True)
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        test_client.app.state.redis = _FakeRedis()
        test_client.app.state.queue = _FakeQueue()
        yield test_client


@pytest.fixture
def auth(client) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_bob(client) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=_SIGNUP_BOB).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN_BOB).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _seed(
    db_path: Path,
    dataset_id: str,
    owner: str,
    job_id: str | None = None,
    visibility: str | None = None,
    source_upload_id: str | None = None,
) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
                if job_id is not None:
                    await appstate.record_dataset_job(session, dataset_id, job_id)
                if visibility is not None:
                    await appstate.set_dataset_visibility(session, dataset_id, visibility)
                if source_upload_id is not None:
                    # Seam L1: the bundle THIS dataset was built from. Omitted, the row
                    # records none — which is what every pre-column row looks like.
                    await appstate.record_dataset_source_upload(
                        session, dataset_id, source_upload_id
                    )
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _finalized_bundle(owner: str, upload_id: str, csv: str | None = None) -> Path:
    """A finalized upload bundle in `owner`'s jail (DATA_ROOT/users/{owner}/uploads/,
    D-30), with an optional `metadata.csv`. Omit the CSV for an images-only bundle."""
    bundle = Path(os.environ["DATA_ROOT"]) / "users" / owner / "uploads" / upload_id
    (bundle / "images").mkdir(parents=True)
    (bundle / ".finalized").write_text("", encoding="utf-8")
    if csv is not None:
        (bundle / "metadata.csv").write_text(csv, encoding="utf-8")
    return bundle


def _write_manifest(dataset_id: str, body: str) -> Path:
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / dataset_id
    ds_dir.mkdir(parents=True, exist_ok=True)
    (ds_dir / "layout_manifest.json").write_text(body, encoding="utf-8")
    return ds_dir


def _copy_fixture(name: str, dataset_id: str) -> Path:
    """A REAL committed tree from ``tests/fixtures/{name}``, copied whole into this
    test's DATA_ROOT as ``dataset_id`` — manifest, ``metadata.parquet``, pyramids and
    all, exactly as the pipeline wrote them. The original is never touched."""
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / dataset_id
    shutil.copytree(FIXTURES / name, ds_dir)
    return ds_dir


def _write_pyramids(ds_dir: Path, *layout_ids: str) -> None:
    """Create the PMTiles containers `committed_at` stats. Content is irrelevant — only
    the mtime is read — so a single byte keeps the fixture honest and tiny."""
    for layout_id in layout_ids:
        path = ds_dir / "tiles" / layout_id / f"{layout_id}_v3.pmtiles"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\0")


class _FakeJob:
    """A stand-in for an rq `Job` that can tell the two things the old lambda could not.

    The double it replaced was `get_status=lambda *a, **k: state`: it swallowed any
    kwargs, so it could not distinguish `refresh=True` (rq's DEFAULT, a second Redis
    round-trip) from `refresh=False`, and it could not raise, so no test could exercise a
    broker outage or a corrupt payload — the exact degradation paths the layouts route
    documents as its whole failure posture (review of PR #358, "what no test covers").

    So this one MIRRORS rq's real signatures (`get_status(refresh=True)`,
    `get_meta(refresh=True)` — verified against rq 2.10), RECORDS the `refresh` it was
    called with, and can be told to raise from either the fetch or the status read.

    And it REFUSES a `queued` job with progress, because production never has one:
    `job.meta["progress"]` is written only by the pipeline's `Reporter.start_job`, which
    runs inside the worker, and neither `enqueue_ingest` nor `enqueue_add_layouts` passes
    `meta=`. A test that built that combination is how `_active_job` shipped answering
    nothing for the whole queue wait (review of PR #358, round 3, finding 2)."""

    def __init__(
        self,
        *,
        state: str,
        progress: dict | None,
        return_value: object,
        dataset_id: str,
        kwargs: dict | None,
        status_error: Exception | None,
    ) -> None:
        if state == "queued" and progress is not None:
            raise ValueError(
                "a queued job has no job.meta['progress'] in production -- only the "
                "worker writes it; give a queued fake its enqueue kwargs instead"
            )
        self.id = "job-l1-1"
        # `exc_info` is a COUNTED property (below), as rq's is a Redis read. Set it with a
        # plain assignment; set `exc_info_error` to make reading it raise.
        self.exc_info_reads = 0
        self.exc_info_error: Exception | None = None
        self.exc_info = None
        self.kwargs = {"dataset_id": dataset_id, "output_root": "/nonexistent"}
        if kwargs is not None:
            self.kwargs.update(kwargs)
        self._state = state
        self._progress = progress
        self._return_value = return_value
        self._status_error = status_error
        # Every `refresh=` these were called with, in order — the whole point of the
        # class. A caller that omits it lands here as rq's own default, True.
        self.status_refresh: list[bool] = []
        self.meta_refresh: list[bool] = []
        self.result_reads = 0

    def get_status(self, refresh: bool = True) -> str:
        self.status_refresh.append(refresh)
        if self._status_error is not None:
            raise self._status_error
        return self._state

    def get_meta(self, refresh: bool = True) -> dict:
        self.meta_refresh.append(refresh)
        return {"progress": self._progress} if self._progress else {}

    def return_value(self, refresh: bool = True) -> object:
        self.result_reads += 1
        return self._return_value

    @property
    def exc_info(self) -> str | None:
        """COUNTED, like `return_value`, because in rq 2.10 it is not a plain attribute:
        the property calls `latest_result()`, an XREVRANGE on `rq:results:{id}`. A plain
        attribute here let a read of it before the owner decision pass every pin (review
        of PR #405, finding 1)."""
        self.exc_info_reads += 1
        if self.exc_info_error is not None:
            raise self.exc_info_error
        return self._exc_info

    @exc_info.setter
    def exc_info(self, value: str | None) -> None:
        self._exc_info = value


def _write_metadata_parquet(ds_dir: Path) -> Path:
    """The committed `metadata.parquet` every roles edit is validated against (D-11).

    A REAL parquet of the images-only shape (id + filename), because that is what an
    images-only ingest actually writes — measured 2026-09-09 by seam L2 and recorded in
    `worker.run_set_roles`; `tests/fixtures/golden_dataset_images_only_v2` carries one.
    A dataset with a manifest and NO parquet is a different, rarer state, and it is the
    one `set_column_roles` now refuses."""
    import duckdb

    path = ds_dir / "metadata.parquet"
    duckdb.connect().execute(
        f"COPY (SELECT 0 AS id, 'a.jpg' AS filename) TO '{path.as_posix()}' "
        "(FORMAT PARQUET)"
    )
    return path


def _patch_job(
    monkeypatch,
    *,
    state: str = "started",
    progress: dict | None = None,
    return_value: object = None,
    dataset_id: str = "ds1",
    kwargs: dict | None = None,
    fetch_error: Exception | None = None,
    status_error: Exception | None = None,
    on_fetch=None,
) -> _FakeJob:
    """Patch BOTH routers' `Job.fetch` (layouts reads the progress, jobs builds the
    status) with one fake job, and hand it back so a test can assert what was asked of
    it. Routers may not import one another, so each holds its own `Job` symbol and both
    have to be patched.

    `fetch_error` / `status_error` raise from the fetch and from the status read
    respectively — the two failure paths a layout list must degrade through rather than
    500. `on_fetch` is a zero-arg hook called on every fetch, for ordering assertions."""
    from api.routers import jobs as jobs_router
    from api.routers import layouts as layouts_router

    fake = _FakeJob(
        state=state,
        progress=progress,
        return_value=return_value,
        dataset_id=dataset_id,
        kwargs=kwargs,
        status_error=status_error,
    )

    def _fetch(job_id, connection=None):  # noqa: ANN001, ANN202
        if on_fetch is not None:
            on_fetch()
        if fetch_error is not None:
            raise fetch_error
        return fake

    for module in (jobs_router, layouts_router):
        monkeypatch.setattr(module.Job, "fetch", _fetch)
    return fake


def _progress(spec_layouts: list[str], stages: list[tuple[str, str]]) -> dict:
    """A worker-shaped `job.meta["progress"]`: a plan plus `(layout_id, state)` stages."""
    return {
        "progress_version": 1,
        "spec_layouts": spec_layouts,
        "image_count": 3,
        "current": None,
        "stages": [
            {
                "key": f"layout:{layout_id}",
                "label": f"Bake layout: {layout_id}",
                "unit": "tiles",
                "done": 1,
                "total": 4,
                "state": state,
            }
            for layout_id, state in stages
        ],
    }


# --- (1) the no-active-job case: everything live, nothing else moved ----------------


def test_no_active_job_reports_every_layout_live_with_a_committed_at(
    client, auth, app_db
) -> None:
    """§3.1 — with no job in flight every committed layout is `live` with a real
    `committed_at`, and the three pre-existing fields are byte-identical to today's."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid", source_columns=[]),
            _entry("datetime", "By date", "datetime", source_columns=["date_made"]),
        ),
    )
    _write_pyramids(ds_dir, "grid", "datetime")
    _seed(app_db, "ds1", "alice")

    body = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert [(lay["layout_id"], lay["label"], lay["type"]) for lay in body["layouts"]] == [
        ("grid", "Grid", "grid"),
        ("datetime", "By date", "datetime"),
    ]
    assert [lay["state"] for lay in body["layouts"]] == ["live", "live"]
    assert [lay["rebake"] for lay in body["layouts"]] == [None, None]
    for layout in body["layouts"]:
        # A real timestamp, parseable and not in the future — the container's mtime.
        stamped = datetime.fromisoformat(layout["committed_at"])
        assert stamped <= datetime.now(timezone.utc)


def test_a_layout_whose_container_is_missing_reports_a_null_committed_at(
    client, auth, app_db
) -> None:
    """A manifest entry whose PMTiles container cannot be stat'ed must degrade to a null
    timestamp, never 500 the whole list: the manifest is the authority on what exists,
    and the file is only where the timestamp comes from."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))  # no _write_pyramids
    _seed(app_db, "ds1", "alice")

    body = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert body["layouts"][0]["committed_at"] is None
    assert body["layouts"][0]["state"] == "live"


# --- (2) the in-flight merge -------------------------------------------------------


def test_an_uncommitted_layout_with_a_running_stage_is_baking(
    client, auth, app_db, monkeypatch
) -> None:
    """§3.2 — a `spec_layouts` entry that is NOT in the manifest and whose
    `layout:{id}` stage is running comes back `baking`, while the committed layouts
    stay `live`."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        progress=_progress(["grid", "datetime"], [("datetime", "running")]),
    )

    body = client.get(
        "/api/datasets/ds1/layouts?include_pending=true", headers=auth
    ).json()
    by_id = {lay["layout_id"]: lay for lay in body["layouts"]}
    assert by_id["grid"]["state"] == "live"
    assert by_id["datetime"]["state"] == "baking"
    assert by_id["datetime"]["committed_at"] is None
    # Neither the label nor the family is knowable before the bake: the plugin decides
    # both. The id is echoed; the type is empty.
    assert (by_id["datetime"]["label"], by_id["datetime"]["type"]) == ("datetime", "")


def test_a_planned_but_unstarted_layout_is_queued(
    client, auth, app_db, monkeypatch
) -> None:
    """A spec the job plans but has not begun a stage for is `queued` — this is the
    window between the worker picking the job up and the first tile, which is most of a
    long bake. (The window BEFORE the pickup — RQ state `queued`, no progress at all — is
    `test_a_queued_first_ingest_lists_its_plan_before_the_worker_starts`.)

    The shape is production's: a re-ingest of a collection with a committed grid, its
    kwargs captured from the real route, and the snapshot `run_ingest` publishes at entry
    — `reporter.start_job(payload.layout_types, None)`, the plan and no layout stage yet.
    It used to be a `queued` job WITH progress, which production never produces."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice")
    _finalized_bundle("alice", "u1")
    response = client.post(
        "/api/datasets/ds1/ingest",
        headers=auth,
        json={"upload_id": "u1", "layout_types": ["grid", "datetime"]},
    )
    assert response.status_code == 200, response.text
    _patch_job(
        monkeypatch,
        progress=_progress(["grid", "datetime"], []),
        kwargs=client.app.state.queue.calls[-1][1],
    )

    body = client.get(
        "/api/datasets/ds1/layouts?include_pending=true", headers=auth
    ).json()
    by_id = {lay["layout_id"]: lay for lay in body["layouts"]}
    assert by_id["datetime"]["state"] == "queued"


def test_a_queued_first_ingest_lists_its_plan_before_the_worker_starts(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, round 3, FINDING 2, reproduced: `POST /api/datasets` while the
    worker is busy. The job sits in RQ state `queued` with NO `job.meta["progress"]` —
    only the worker writes it — so `include_pending` answered `{"layouts": []}` for the
    whole queue wait, the window its docstring calls the one it exists for.

    Nothing here is hand-built: the collection is created through the real route, and
    the queued job carries exactly the kwargs that route enqueued. Its plan comes from
    `layout_types` — the same list the worker will publish as `spec_layouts`."""
    _finalized_bundle("alice", "u1", "file,date_made\na.jpg,1642-01-01\n")
    created = client.post(
        "/api/datasets",
        headers=auth,
        json={
            "dataset_id": "ds1",
            "upload_id": "u1",
            "layout_types": ["grid", "datetime"],
            "column_roles": {
                "filename": {"column": "file", "label": "File"},
                "datetime": {
                    "column": "date_made",
                    "label": "Made",
                    "format": "iso8601",
                },
            },
        },
    )
    assert created.status_code == 200, created.text
    _patch_job(monkeypatch, state="queued", kwargs=client.app.state.queue.calls[-1][1])

    response = client.get("/api/datasets/ds1/layouts?include_pending=true", headers=auth)
    assert response.status_code == 200
    assert [(lay["layout_id"], lay["state"]) for lay in response.json()["layouts"]] == [
        ("grid", "queued"),
        ("datetime", "queued"),
    ]


def test_a_queued_replace_reports_its_rebake_before_the_worker_starts(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, round 3, FINDING 2, the second symptom: `rebake: "queued"`
    never appeared for a `--replace` that was still QUEUED, because a queued job has no
    progress and `_active_job` returned None before it ever read `replace`.

    The re-bake is enqueued through the real route — a family spec, the case `replace`
    exists to report — and the queued job carries exactly those kwargs and no progress."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid"),
            _entry("categorical_kingdom", "Kingdom", "categorical"),
            _entry("categorical_phylum", "Phylum", "categorical"),
        ),
    )
    _write_pyramids(ds_dir, "grid", "categorical_kingdom", "categorical_phylum")
    _seed(app_db, "ds1", "alice")
    _finalized_bundle("alice", "u1")
    enqueued = client.post(
        "/api/datasets/ds1/layouts",
        headers=auth,
        json={
            "layout_specs": ["categorical"],
            "replace": ["categorical_kingdom", "categorical_phylum"],
        },
    )
    assert enqueued.status_code == 200, enqueued.text
    _patch_job(monkeypatch, state="queued", kwargs=client.app.state.queue.calls[-1][1])

    by_id = {
        lay["layout_id"]: lay
        for lay in client.get("/api/datasets/ds1/layouts", headers=auth).json()["layouts"]
    }
    assert by_id["categorical_kingdom"]["rebake"] == "queued"
    assert by_id["categorical_phylum"]["rebake"] == "queued"
    assert by_id["grid"]["rebake"] is None


def test_pending_layouts_are_opt_in_and_absent_by_default(
    client, auth, app_db, monkeypatch
) -> None:
    """The default response must never grow a row for a layout with no tiles: it feeds
    the viewer's layout switcher (and `bootLayoutId`, which falls back to `layouts[0]`),
    so an unopenable entry there is a control that cannot work. The state fields on the
    COMMITTED rows are unconditional — only the extra rows are opt-in."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        progress=_progress(["grid", "datetime"], [("datetime", "running")]),
    )

    default = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert [lay["layout_id"] for lay in default["layouts"]] == ["grid"]
    opted_in = client.get(
        "/api/datasets/ds1/layouts?include_pending=true", headers=auth
    ).json()
    assert [lay["layout_id"] for lay in opted_in["layouts"]] == ["grid", "datetime"]


def test_a_committed_layout_being_rebaked_stays_live_with_a_rebake_flag(
    client, auth, app_db, monkeypatch
) -> None:
    """THE BOTH-COMMITTED-AND-IN-FLIGHT CASE. `add-layouts --replace` commits per-layout
    at the END, so the committed tiles keep serving throughout a re-bake — the layout is
    still openable and `state` must say so. The pending re-bake rides on its own field."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid"),
            _entry("datetime", "By date", "datetime"),
        ),
    )
    _write_pyramids(ds_dir, "grid", "datetime")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        progress=_progress(["datetime"], [("datetime", "running")]),
    )

    body = client.get(
        "/api/datasets/ds1/layouts?include_pending=true", headers=auth
    ).json()
    by_id = {lay["layout_id"]: lay for lay in body["layouts"]}
    # ONE row for `datetime`, not two: the committed entry, carrying the pending re-bake.
    assert [lay["layout_id"] for lay in body["layouts"]] == ["grid", "datetime"]
    assert (by_id["datetime"]["state"], by_id["datetime"]["rebake"]) == ("live", "baking")
    assert by_id["datetime"]["committed_at"] is not None  # still openable
    assert (by_id["grid"]["state"], by_id["grid"]["rebake"]) == ("live", None)


def test_a_finished_rebake_stage_leaves_no_pending_flag(
    client, auth, app_db, monkeypatch
) -> None:
    """`done` and `failed` both mean NOTHING IS PENDING, so neither leaves a `rebake`.
    Which of the two happened is the job route's report to make; a layout card asks
    "can I open it, and is more coming", and the answer to both is the same."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("datetime", "By date", "datetime")))
    _write_pyramids(ds_dir, "datetime")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(monkeypatch, progress=_progress(["datetime"], [("datetime", "done")]))

    body = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert body["layouts"][0]["rebake"] is None


def test_a_failed_uncommitted_layout_is_not_listed_as_queued(
    client, auth, app_db, monkeypatch
) -> None:
    """A layout whose stage FAILED does not exist and this job will not produce it.
    Reporting it `queued` would make a user wait for something that is never coming."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        progress=_progress(["grid", "datetime"], [("datetime", "failed")]),
    )

    body = client.get(
        "/api/datasets/ds1/layouts?include_pending=true", headers=auth
    ).json()
    assert [lay["layout_id"] for lay in body["layouts"]] == ["grid"]


def test_a_finished_job_contributes_no_in_flight_state(
    client, auth, app_db, monkeypatch
) -> None:
    """The overlay is only ever read from a job that is ACTUALLY IN FLIGHT.

    The scenario is the one that goes wrong if it is not: a job whose RQ state is
    `finished` but whose last written progress snapshot is not terminal — a plan naming
    a layout that never committed, and a stage on a committed one still marked
    `running`. `job.meta` is a snapshot the worker writes as it goes, so a job that died
    between a stage start and its end leaves exactly this. Reading it regardless of the
    job's state would leave that dataset permanently reporting a queued layout that is
    never coming and a re-bake that is not running."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("datetime", "By date", "datetime")))
    _write_pyramids(ds_dir, "datetime")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        state="finished",
        progress=_progress(
            ["datetime", "categorical_maker"], [("datetime", "running")]
        ),
    )

    body = client.get(
        "/api/datasets/ds1/layouts?include_pending=true", headers=auth
    ).json()
    assert [lay["layout_id"] for lay in body["layouts"]] == ["datetime"]
    assert body["layouts"][0]["rebake"] is None


# --- (3) absent source_columns is UNKNOWN, never [] --------------------------------


def test_absent_source_columns_is_unknown_and_empty_is_not(
    client, auth, app_db
) -> None:
    """§3.3 — the distinction the frontend's stale preview depends on. `[]` is a v2.9
    producer saying "recorded, and there are none" (grid, always). An ABSENT key means
    the entry predates 2.9 and nothing was recorded, so absence is never a positive
    claim of "depends on nothing" — flattening it to `[]` would silently clear the stale
    flag on exactly the oldest layouts in a tree."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid", source_columns=[]),
            _entry("legacy", "Legacy", "categorical"),  # pre-2.9: no key at all
            _entry("datetime", "By date", "datetime", source_columns=["date_made"]),
        ),
    )
    _write_pyramids(ds_dir, "grid", "legacy", "datetime")
    _seed(app_db, "ds1", "alice")

    by_id = {
        lay["layout_id"]: lay
        for lay in client.get("/api/datasets/ds1/layouts", headers=auth).json()["layouts"]
    }
    assert by_id["grid"]["source_columns"] == []
    assert by_id["legacy"]["source_columns"] is None
    assert by_id["datetime"]["source_columns"] == ["date_made"]
    # The two must be DISTINGUISHABLE on the wire, not merely unequal in Python.
    assert by_id["grid"]["source_columns"] is not None


def test_source_fingerprint_passes_through_and_absent_is_not_empty(
    client, auth, app_db
) -> None:
    """Seam L7 / manifest v2.10. The API computes NO staleness — that needs the pipeline's
    rule and the API never imports `pipeline` (D-15) — it passes `source_fingerprint`
    through verbatim and the client compares. The `{}`-vs-absent distinction is the
    `source_columns` one, one minor later and with the same consequence: `{}` is a v2.10
    producer saying "this layout reads no column, so there is no way of reading to record"
    (grid, always), while an ABSENT key means the entry predates 2.10 and is UNCHECKED.
    Flattening absent to `{}` would report the oldest bakes in a tree as fresh."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid", source_columns=[], source_fingerprint={}),
            _entry("legacy", "Legacy", "categorical", source_columns=["kind"]),  # pre-2.10
            _entry(
                "datetime",
                "By date",
                "datetime",
                source_columns=["date_made"],
                source_fingerprint={"date_made": [["datetime", "iso8601"]]},
            ),
        ),
    )
    _write_pyramids(ds_dir, "grid", "legacy", "datetime")
    _seed(app_db, "ds1", "alice")

    by_id = {
        lay["layout_id"]: lay
        for lay in client.get("/api/datasets/ds1/layouts", headers=auth).json()["layouts"]
    }
    assert by_id["datetime"]["source_fingerprint"] == {
        "date_made": [["datetime", "iso8601"]]
    }, "the recorded tuples arrive verbatim — nothing is re-encoded or hashed"
    assert by_id["grid"]["source_fingerprint"] == {}
    assert by_id["legacy"]["source_fingerprint"] is None
    # DISTINGUISHABLE on the wire, not merely unequal in Python — `{}` is falsy, so a
    # consumer that tested truthiness would read the pre-2.10 entry and grid the same.
    assert by_id["grid"]["source_fingerprint"] is not None


def test_a_malformed_source_fingerprint_does_not_500_the_layout_list(
    client, auth, app_db
) -> None:
    """This route's rule for `options` and `source_fingerprint` alike: they are opaque
    producer bytes, and an unexpected shape must NOT take the whole layout list down. A
    top-level value that is not an object reached pydantic's `dict | None` and raised
    (2026-09-23 review, finding 6). It now reads as ABSENT — unchecked, which is the one
    answer that is never wrong, and never "fresh"."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid", source_columns=[], source_fingerprint={}),
            _entry(
                "hand_edited",
                "Hand edited",
                "datetime",
                source_columns=["captured"],
                source_fingerprint="datetime",  # a string, not an object
            ),
        ),
    )
    _write_pyramids(ds_dir, "grid", "hand_edited")
    _seed(app_db, "ds1", "alice")

    response = client.get("/api/datasets/ds1/layouts", headers=auth)

    assert response.status_code == 200, response.text
    by_id = {lay["layout_id"]: lay for lay in response.json()["layouts"]}
    assert by_id["hand_edited"]["source_fingerprint"] is None
    assert by_id["grid"]["source_fingerprint"] == {}, "the sane sibling is unaffected"


def test_options_are_echoed_from_the_manifest(client, auth, app_db) -> None:
    """A card explains an existing bake from the list response, with no second fetch."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry(
                "scatter",
                "Scatter",
                "scatter",
                options={"scale": "linear", "normalize": "independent"},
            )
        ),
    )
    _write_pyramids(ds_dir, "scatter")
    _seed(app_db, "ds1", "alice")

    body = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert body["layouts"][0]["options"] == {
        "scale": "linear",
        "normalize": "independent",
    }


# --- (4) visibility: the anonymous reader of a public dataset ----------------------


# Every field a LayoutInfo row carries. The disclosure test below asserts each row has
# EXACTLY these, so a field added later fails it until someone says where an anonymous
# reader could already have learned it.
_LAYOUT_INFO_FIELDS = {
    "layout_id",
    "label",
    "type",
    "state",
    "rebake",
    "committed_at",
    "source_columns",
    # v2.10 (seam L7). Where an anonymous reader could already have learned it: it is a
    # field of `layoutEntry`, and the whole manifest is served read-only to anyone who may
    # read the dataset (GET /api/datasets/{ds}/layouts/{layout_id}). It is a fact about the
    # BAKE — which columns were read and with which knobs — not about a user, an owner or
    # an in-flight job, so it needs no new visibility rule.
    "source_fingerprint",
    "options",
}

_PUBLIC_DS = "golden_dataset_full_v2"
_FAMILY_REPLACE = ["categorical_group", "categorical_bucket"]


@pytest.mark.parametrize(
    ("job_state", "progress", "expected_new", "expected_early"),
    [
        # Queued: no progress exists (only the worker writes it), so the job route shows
        # no plan at all. The pending `categorical` row is the plan read EARLY off the
        # kwargs; both re-bakes come from `replace` alone.
        ("queued", None, set(_FAMILY_REPLACE), {"categorical"}),
        # Started, plan published, no per-layout stage yet — the long thumbnail window.
        # The plan is public now; `replace` is still the only source of both re-bakes.
        ("started", _progress(["categorical"], []), set(_FAMILY_REPLACE), set()),
        # Stages published: the job route now names both ids itself, so `rebake` adds
        # nothing the reader could not already see.
        (
            "started",
            _progress(
                ["categorical"],
                [("categorical_group", "running"), ("categorical_bucket", "queued")],
            ),
            set(),
            set(),
        ),
    ],
    ids=["queued", "plan-published", "stages-published"],
)
def test_an_anonymous_reader_of_a_public_dataset_is_told_one_new_fact(
    client, auth, app_db, monkeypatch, job_state, progress, expected_new, expected_early
) -> None:
    """§1.4 / §6 — what the seam-L1 fields tell an ANONYMOUS reader of a public dataset,
    accounted for FIELD BY FIELD ON EVERY ROW (review of PR #358, round 3, finding 3).

    The test this replaces looked only at rows whose `state` was not "live" — and
    `rebake` and `committed_at` exist only on live rows, so it never examined either,
    while it, the route docstring and the PR body all said the route "adds nothing".
    Measured instead, per field, against what the same reader gets from routes that
    already existed:

    * `label`/`type`/`source_columns`/`options` (committed) — the manifest entry that
      `GET .../layouts/{layout_id}` serves this reader verbatim;
    * `committed_at` — the `Last-Modified` that `GET .../pyramid/{layout_id}.pmtiles`
      serves this reader, from the same `stat`. SETTLED HERE, because two reviews
      disagreed: it IS served elsewhere. `Last-Modified` is an HTTP-date (whole seconds),
      so what `committed_at` adds is the sub-second remainder;
    * `state` and pending ids — the job's `spec_layouts` and `layout:{id}` stages from
      `GET /api/jobs/{id}`; or, while the job is still queued, its enqueue kwargs, which
      the worker publishes verbatim as `spec_layouts` the moment it starts (`expected_early`
      — an earlier sight of a public fact, not a different fact);
    * **`rebake` — the ONE new fact.** Where the job route names neither the id nor a
      stage for it, the only source is the job's `replace` kwarg, which `JobStatus` and
      `JobProgress` do not carry. Kept public on purpose
      ([[T2-the-viewer-cannot-say-that-a-new-layout-is-baking]] wants exactly this), and
      pinned here as new rather than described as nothing.

    The dataset is the real `golden_dataset_full_v2` tree and the job is a family
    re-bake enqueued through the real route, so every row is one production serves."""
    _copy_fixture(_PUBLIC_DS, _PUBLIC_DS)
    _seed(app_db, _PUBLIC_DS, "alice", visibility="public")
    _finalized_bundle("alice", "u1")
    enqueued = client.post(
        f"/api/datasets/{_PUBLIC_DS}/layouts",
        headers=auth,
        json={"layout_specs": ["categorical"], "replace": _FAMILY_REPLACE},
    )
    assert enqueued.status_code == 200, enqueued.text
    kwargs = client.app.state.queue.calls[-1][1]
    _patch_job(
        monkeypatch,
        state=job_state,
        progress=progress,
        dataset_id=_PUBLIC_DS,
        kwargs=kwargs,
    )

    # Everything below is ANONYMOUS — no headers.
    rows = client.get(f"/api/datasets/{_PUBLIC_DS}/layouts?include_pending=true").json()[
        "layouts"
    ]
    job = client.get("/api/jobs/job-l1-1").json()
    manifest = client.get(f"/api/datasets/{_PUBLIC_DS}/layouts/grid").json()
    entries = {entry["layout_id"]: entry for entry in manifest["layouts"]}
    public_plan = set(job["progress"]["spec_layouts"]) if job["progress"] else set()
    public_stages = (
        {
            stage["key"].removeprefix("layout:"): stage["state"]
            for stage in job["progress"]["stages"]
        }
        if job["progress"]
        else {}
    )
    # The job route does not carry `replace`, in any field — which is what makes a
    # `rebake` sourced from it new. Asserted, not assumed: until the worker publishes a
    # stage for them, the replaced ids appear nowhere in the job's anonymous answer.
    assert "replace" not in json.dumps(job)
    if not public_stages:
        assert not any(layout_id in json.dumps(job) for layout_id in _FAMILY_REPLACE)

    new_facts: set[str] = set()
    early: set[str] = set()
    for row in rows:
        layout_id = row["layout_id"]
        assert set(row) == _LAYOUT_INFO_FIELDS, f"unaccounted field on {layout_id}"
        entry = entries.get(layout_id)
        if entry is not None:
            # A COMMITTED row: every field is the manifest's, or the container's stat.
            assert row["state"] == "live"
            assert (row["label"], row["type"]) == (entry["label"], entry["type"])
            assert row["source_columns"] == entry.get("source_columns")
            assert row["options"] == entry.get("options")
            served = client.get(f"/api/datasets/{_PUBLIC_DS}/pyramid/{layout_id}.pmtiles")
            assert served.status_code == 200
            last_modified = parsedate_to_datetime(served.headers["last-modified"])
            committed_at = datetime.fromisoformat(row["committed_at"])
            assert committed_at.replace(microsecond=0) == last_modified, layout_id
            if row["rebake"] is None:
                continue
            if layout_id in public_stages:
                expected = "baking" if public_stages[layout_id] == "running" else "queued"
                assert row["rebake"] == expected
            elif layout_id in public_plan:
                assert row["rebake"] == "queued"
            else:
                new_facts.add(layout_id)
        else:
            # A PENDING row: nothing but its id and state, both from the job.
            assert (row["label"], row["type"]) == (layout_id, "")
            assert (row["rebake"], row["committed_at"]) == (None, None)
            assert (row["source_columns"], row["options"]) == (None, None)
            if layout_id in public_stages or layout_id in public_plan:
                continue
            assert job["progress"] is None and layout_id in kwargs["layout_specs"]
            early.add(layout_id)

    assert new_facts == expected_new
    assert new_facts <= set(kwargs["replace"])
    assert early == expected_early

    # And what seam L1 does NOT widen at all: the verb's raw return is owner-only.
    assert job["result"] is None


def test_the_job_result_is_owner_only(client, auth, auth_bob, app_db, monkeypatch) -> None:
    """`JobStatus.result` is narrower than `may_read`: a public dataset's job is readable
    by anyone, but the verb's raw return goes to the owner alone. A verb's return shape
    is the pipeline's to change and already carries server-side artefacts (`swept` file
    lists, `stale_tag_sidecar`), so it cannot be audited once for anonymous disclosure."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _seed(app_db, "ds1", "alice", job_id="job-l1-1", visibility="public")
    _patch_job(
        monkeypatch,
        state="finished",
        return_value={"stale_layouts": ["datetime"], "changed_columns": ["date_made"]},
    )

    owner = client.get("/api/jobs/job-l1-1", headers=auth).json()
    assert owner["result"] == {
        "stale_layouts": ["datetime"],
        "changed_columns": ["date_made"],
    }
    assert client.get("/api/jobs/job-l1-1", headers=auth_bob).json()["result"] is None
    assert client.get("/api/jobs/job-l1-1").json()["result"] is None


def test_a_private_dataset_still_404s_a_non_owner(
    client, auth, auth_bob, app_db
) -> None:
    """The read gate is untouched by the merge: a private dataset the caller cannot read
    answers the SAME 404 as a missing one."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _seed(app_db, "ds1", "alice")
    assert client.get("/api/datasets/ds1/layouts", headers=auth_bob).status_code == 404


# --- (5) DELETE /api/datasets/{ds_id}/layouts/{layout_id} --------------------------


def test_delete_layout_enqueues_the_worker_verb_and_answers_202(
    client, auth, app_db
) -> None:
    """202, not 200/204: the manifest is worker-written, so the layout is ENQUEUED for
    removal, not removed. The response must not imply otherwise (D-xxii)."""
    _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid"),
            _entry("datetime", "By date", "datetime"),
        ),
    )
    _seed(app_db, "ds1", "alice")

    response = client.delete("/api/datasets/ds1/layouts/datetime", headers=auth)
    assert response.status_code == 202
    assert response.json() == {"job_id": "job-l1-1"}
    path, kwargs = client.app.state.queue.calls[-1]
    assert path == "pipeline.worker.run_delete_layout_job"
    assert kwargs["dataset_id"] == "ds1"
    assert kwargs["layout_id"] == "datetime"
    assert kwargs["owner"] == "alice"


def test_delete_layout_refuses_a_non_owner(client, auth, auth_bob, app_db) -> None:
    """§3.4 — writes are owner-only (D-23/D-24), resolved per request from app-state."""
    _write_manifest(
        "ds1",
        _manifest(_entry("grid", "Grid", "grid"), _entry("datetime", "D", "datetime")),
    )
    _seed(app_db, "ds1", "alice")

    response = client.delete("/api/datasets/ds1/layouts/datetime", headers=auth_bob)
    assert response.status_code == 403
    assert client.app.state.queue.calls == []  # nothing was enqueued


def test_delete_layout_409s_while_a_job_is_in_flight(
    client, auth, app_db, monkeypatch
) -> None:
    """§3.4 — a delete may not stack on, or run over, a still-committing bake."""
    _write_manifest(
        "ds1",
        _manifest(_entry("grid", "Grid", "grid"), _entry("datetime", "D", "datetime")),
    )
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(monkeypatch, state="started")

    response = client.delete("/api/datasets/ds1/layouts/datetime", headers=auth)
    assert response.status_code == 409
    # The detail names no VERB. It said "An ingest job …" when the guard had one caller;
    # deleting layout A then layout B told the user to look for an ingest that does not
    # exist (review of PR #358, finding 11). `delete_dataset` answers the same words.
    assert response.json()["detail"] == "Another job for this collection is still running"
    assert client.app.state.queue.calls == []


def test_delete_layout_404s_an_id_that_names_no_committed_layout(
    client, auth, app_db
) -> None:
    """The SAME 404 the read side already gives that id — and no job that is guaranteed
    to fail is enqueued."""
    _write_manifest(
        "ds1",
        _manifest(_entry("grid", "Grid", "grid"), _entry("datetime", "D", "datetime")),
    )
    _seed(app_db, "ds1", "alice")

    assert client.delete("/api/datasets/ds1/layouts/nope", headers=auth).status_code == 404
    assert client.app.state.queue.calls == []


def test_delete_layout_refuses_the_last_layout(client, auth, app_db) -> None:
    """`layouts` is minItems: 1 and a `default_layout` must resolve (D-viii), so this can
    never succeed. Refuse it here rather than enqueue a job that cannot work."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _seed(app_db, "ds1", "alice")

    response = client.delete("/api/datasets/ds1/layouts/grid", headers=auth)
    assert response.status_code == 409
    assert "only layout" in response.json()["detail"]
    assert client.app.state.queue.calls == []


# --- (6) POST /api/datasets/{ds_id}/column-roles -----------------------------------

_ROLES = {"filename": {"column": "file", "label": "File"}}


def test_set_column_roles_enqueues_set_roles_with_the_full_map(
    client, auth, app_db
) -> None:
    """The roles-only write: an ENQUEUE, because roles are a manifest fact and the
    manifest has one writer. The map crosses verbatim as a JSON primitive.

    **202, not 200** — the same code `DELETE .../layouts/{id}` answers, because the two
    routes do the same thing: hand back a job id having done none of the work. The status
    code follows the semantics (an enqueue), not the verb; see
    [[T2-the-two-legacy-enqueue-routes-answer-200-while]] for the legacy pair that still
    answers 200."""
    _write_metadata_parquet(_write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid"))))
    _seed(app_db, "ds1", "alice")

    response = client.post(
        "/api/datasets/ds1/column-roles", headers=auth, json={"column_roles": _ROLES}
    )
    assert response.status_code == 202, response.text
    assert response.json() == {"job_id": "job-l1-1"}
    path, kwargs = client.app.state.queue.calls[-1]
    assert path == "pipeline.worker.run_set_roles_job"
    assert kwargs == {
        "dataset_id": "ds1",
        "owner": "alice",
        "output_root": kwargs["output_root"],
        "column_roles": _ROLES,
    }


def test_set_column_roles_refuses_a_non_owner(client, auth, auth_bob, app_db) -> None:
    # A parquet, so the 403 below is about OWNERSHIP and not about a missing file.
    _write_metadata_parquet(_write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid"))))
    _seed(app_db, "ds1", "alice")

    response = client.post(
        "/api/datasets/ds1/column-roles", headers=auth_bob, json={"column_roles": _ROLES}
    )
    assert response.status_code == 403
    assert client.app.state.queue.calls == []


def test_set_column_roles_409s_while_a_job_is_in_flight(
    client, auth, app_db, monkeypatch
) -> None:
    # Manifest AND parquet, so the only thing left to refuse is the in-flight job — the
    # detail is asserted so this cannot pass on one of the other two 409s.
    _write_metadata_parquet(_write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid"))))
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(monkeypatch, state="started")

    response = client.post(
        "/api/datasets/ds1/column-roles", headers=auth, json={"column_roles": _ROLES}
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "Another job for this collection is still running"
    assert client.app.state.queue.calls == []


def test_set_column_roles_409s_a_dataset_with_no_committed_bake(
    client, auth, app_db
) -> None:
    """An app-state row exists from the moment create_dataset enqueues, so "recorded but
    never baked" is reachable — and there is no manifest to re-declare roles in."""
    _seed(app_db, "ds1", "alice")  # row, but no manifest on disk

    response = client.post(
        "/api/datasets/ds1/column-roles", headers=auth, json={"column_roles": _ROLES}
    )
    assert response.status_code == 409
    assert "no committed bake" in response.json()["detail"]
    assert client.app.state.queue.calls == []


# --- (7) add-layouts --replace, reachable from the web at last ---------------------


def test_add_layouts_forwards_replace_and_defaults_it_to_empty(
    client, auth, app_db, monkeypatch
) -> None:
    """The narrow claim's payoff. `replace` reaches `run_add_layouts_job` as a JSON
    primitive; omitted, it is `[]` — today's behaviour exactly, with the worker's
    collision guard still refusing every unnamed existing id."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _seed(app_db, "ds1", "alice")
    # The first POST records a job on the row, so the SECOND one's in-flight guard
    # fetches it; a finished job is "not in flight" and does not block.
    _patch_job(monkeypatch, state="finished")
    # add-layouts resolves the ORIGINAL images from a finalized upload bundle.
    bundle = Path(os.environ["DATA_ROOT"]) / "users" / "alice" / "uploads" / "u1"
    (bundle / "images").mkdir(parents=True)
    (bundle / ".finalized").write_text("", encoding="utf-8")

    assert (
        client.post(
            "/api/datasets/ds1/layouts",
            headers=auth,
            json={"layout_specs": ["datetime"], "replace": ["datetime"]},
        ).status_code
        == 200
    )
    path, kwargs = client.app.state.queue.calls[-1]
    assert path == "pipeline.worker.run_add_layouts_job"
    assert kwargs["replace"] == ["datetime"]

    assert (
        client.post(
            "/api/datasets/ds1/layouts", headers=auth, json={"layout_specs": ["datetime"]}
        ).status_code
        == 200
    )
    assert client.app.state.queue.calls[-1][1]["replace"] == []


# --- (7b) the two NEW dotted paths, pinned on the API side ------------------------


def test_the_new_dotted_paths_name_the_primitive_kwargs_wrappers() -> None:
    """`tests/smoke/test_enqueue_contract.py` gates the OTHER two enqueue boundaries in
    three halves — the dotted-path string, the worker's param names, and the API's real
    kwargs binding to them — and it says in its own text that the first and third halves
    for `delete-layout`/`set-roles` "land with seam L1's `enqueue_delete_layout` /
    `enqueue_set_roles`". They are not landed here: this seam's brief gives it a NARROW,
    explicitly enumerated claim on `tests/smoke` (`ADD_LAYOUTS_ENQUEUE_KWARGS` and
    nothing else) and states that the seam writes no smoke tests. Filed rather than
    smuggled in: [[T2-the-two-l2-enqueue-boundaries-have-no-dotted]].

    What CAN be pinned from inside `packages/api/` is the half that is entirely the
    API's: the STRING. A typo in either constant would resolve to nothing in the worker
    and fail only at job execution in production, and it costs one assertion to make
    that impossible. It does not import `pipeline` and so cannot check that the string
    RESOLVES — that is exactly the half the smoke guard exists for."""
    from api import queue

    assert queue.RUN_DELETE_LAYOUT_PATH == "pipeline.worker.run_delete_layout_job"
    assert queue.RUN_SET_ROLES_PATH == "pipeline.worker.run_set_roles_job"


# --- (8) GET /api/datasets/{ds_id}/columns ----------------------------------------


def test_columns_reads_the_committed_parquet(client, auth, app_db) -> None:
    """After a bake, the COMMITTED columns — what ingest actually stored — with their
    real Parquet types and the first cell's values, and ONLY the user's columns.

    The tree is the real `golden_dataset_full_v2`. Its parquet stores 13 columns and its
    manifest's `column_roles` declares 10 of them; the three it does not declare — `id`,
    `width`, `height` — are the pipeline's (the dense key and the probed dimensions) and
    must not be offered to map (review of PR #358, round 3, finding 1). This test used
    to write its own `(id, filename, title)` parquet under a manifest with no roles —
    which is an images-only tree by the schema's definition — and expected `id` back.

    ONE deliberate departure from the fixture, derived from it: the parquet is rewritten
    in DESCENDING id order (same schema, same rows, `COPY … ORDER BY id DESC`). The
    pipeline writes id order today, so without it the `ORDER BY "id"` this pins would be
    unobservable; and a parquet promises no row order, so "the dataset's first cell" must
    not depend on one — the T2-92 metadata MERGE is the next writer of this file."""
    import duckdb

    ds_dir = _copy_fixture("golden_dataset_full_v2", "ds1")
    source = (FIXTURES / "golden_dataset_full_v2" / "metadata.parquet").as_posix()
    target = (ds_dir / "metadata.parquet").as_posix()
    duckdb.connect().execute(
        f"COPY (SELECT * FROM read_parquet('{source}') ORDER BY id DESC) "
        f"TO '{target}' (FORMAT PARQUET)"
    )
    _seed(app_db, "ds1", "alice")

    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    assert body["source"] == "parquet"
    # The declared columns, in the file's own order — and not `id`/`width`/`height`.
    assert [col["name"] for col in body["columns"]] == [
        "filename",
        "captured",
        "group",
        "bucket",
        "sx",
        "sy",
        "lon",
        "lat",
        "tags",
        "caption",
    ]
    dtypes = {col["name"]: col["dtype"] for col in body["columns"]}
    # Real Parquet types, not the CSV path's all-VARCHAR.
    assert (dtypes["captured"], dtypes["sx"], dtypes["tags"]) == (
        "TIMESTAMP",
        "DOUBLE",
        "VARCHAR[]",
    )
    # Ordered by id, so the sample is the dataset's FIRST cell (id 0) — not id 255,
    # which leads the file. Measured on the fixture 2026-09-21: id 0 has no scatter,
    # geo or tag value, so those samples are null.
    assert [col["sample"] for col in body["columns"]] == [
        "00000.png",
        "2021-01-01 00:00:00",
        "group-0",
        "bucket-00",
        None,
        None,
        None,
        None,
        None,
        "cell-00000",
    ]


def test_columns_falls_back_to_the_upload_bundle_csv_before_any_bake(
    client, auth, app_db
) -> None:
    """The case the route exists for: an undesigned collection mid-first-ingest has no
    manifest and no parquet, and the Data view must still survive a page reload. The
    bundle is found through the dataset's OWN recorded `source_upload_id`."""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")  # a row, no bake
    _finalized_bundle("alice", "u1", "file,date_made,maker\na.jpg,1642,Rembrandt\n")

    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    assert body["source"] == "upload"
    assert [col["name"] for col in body["columns"]] == ["file", "date_made", "maker"]
    # A CSV declares no types and none is INFERRED — this is how ingest reads one.
    assert {col["dtype"] for col in body["columns"]} == {"VARCHAR"}
    assert [col["sample"] for col in body["columns"]] == ["a.jpg", "1642", "Rembrandt"]


def test_columns_never_answers_from_another_collections_bundle(
    client, auth, app_db
) -> None:
    """Review of PR #358, FINDING 1, reproduced. `ds1` was created from `u1`; its owner
    then finalized `u2` for a DIFFERENT collection. `u2` is deliberately the newest
    bundle — its marker mtime is stamped 100s ahead so no timestamp heuristic can tie —
    and `ds1` must still describe `u1`, because it is the only bundle that is anything
    to do with `ds1`. This is the pre-first-bake window the route exists to serve, so
    "it self-corrects after the bake" is no defence."""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "file,date_made,maker\na.jpg,1642,Rembrandt\n")
    newer = _finalized_bundle("alice", "u2", "sku,price\nA-1,9.99\n")
    marker = newer / ".finalized"
    os.utime(marker, (marker.stat().st_mtime + 100, marker.stat().st_mtime + 100))

    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    assert body["source"] == "upload"
    assert [col["name"] for col in body["columns"]] == ["file", "date_made", "maker"]


def test_columns_answers_images_only_for_a_baked_collection_with_no_metadata(
    client, auth, app_db
) -> None:
    """A BAKED images-only collection must answer `images_only` — on the tree an
    images-only ingest ACTUALLY writes.

    Review of PR #358, round 3, FINDING 1. This test used to build a manifest with NO
    `metadata.parquet`, a tree the pipeline never produces: an images-only ingest writes
    one holding the pipeline's own columns. On the real shape — the committed
    `golden_dataset_images_only_v2`, whose parquet is `(id, filename)` and whose manifest
    omits `column_roles` — the route answered `parquet` and offered the dense key and
    the join key as columns to map. `column_roles` ABSENT is the schema's definition of
    images-only, so that is what decides it now.

    The stray finalized bundle is the earlier finding this test was written for (round
    1, finding 2): a bundle that is not ds1's must never answer for it."""
    ds_dir = _copy_fixture("golden_dataset_images_only_v2", "ds1")
    assert (ds_dir / "metadata.parquet").is_file()  # the shape this test is about
    _seed(app_db, "ds1", "alice")  # images-only: no bundle recorded
    _finalized_bundle("alice", "u9", "sku,price\nA-1,9.99\n")  # a stray, not ds1's

    response = client.get("/api/datasets/ds1/columns", headers=auth)
    assert response.status_code == 200
    assert response.json() == {"source": "images_only", "columns": []}


def test_a_baked_images_only_collection_answers_over_its_recorded_bundles_csv(
    client, auth, app_db
) -> None:
    """The committed state beats the recorded bundle, for images-only exactly as for a
    committed parquet. The tree is production's: `start_ingest` is images-only by D-25
    (`csv_path=None`) and records a NAMED bundle as the source even when that bundle
    carries a CSV, so after the bake commits the collection is images-only while its
    recorded bundle still has columns. Those are metadata AVAILABLE to map, reachable by
    naming the bundle — not the collection's answer."""
    _copy_fixture("golden_dataset_images_only_v2", "ds1")
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "file,date_made\na.jpg,1642\n")

    assert client.get("/api/datasets/ds1/columns", headers=auth).json() == {
        "source": "images_only",
        "columns": [],
    }
    named = client.get("/api/datasets/ds1/columns?upload_id=u1", headers=auth).json()
    assert (named["source"], [col["name"] for col in named["columns"]]) == (
        "upload",
        ["file", "date_made"],
    )


def test_columns_answers_images_only_when_the_recorded_bundle_has_no_csv(
    client, auth, app_db
) -> None:
    """The same known answer before any bake: `ds1`'s OWN bundle is images-only, so
    there is nothing to map yet — and a CSV in a sibling bundle is still not an
    answer."""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1")  # images-only bundle: no metadata.csv
    _finalized_bundle("alice", "u2", "sku,price\nA-1,9.99\n")

    response = client.get("/api/datasets/ds1/columns", headers=auth)
    assert response.status_code == 200
    assert response.json() == {"source": "images_only", "columns": []}


def test_columns_reads_an_explicitly_named_bundle_over_the_committed_parquet(
    client, auth, app_db
) -> None:
    """`?upload_id=` names one specific bundle of the caller's own — the "what would I
    get if I re-ingested from this?" question — so it wins even over a committed
    parquet, which is the only thing it could have meant. Nothing else about the
    dataset changes the answer.

    The committed tree is the real `golden_dataset_full_v2` — a collection with declared
    metadata — so "over the committed parquet" is what is actually being tested; the
    hand-built `(id, filename)` parquet it used to write under a role-less manifest is an
    images-only tree by the schema's definition."""
    _copy_fixture("golden_dataset_full_v2", "ds1")
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "file,date_made\na.jpg,1642\n")
    _finalized_bundle("alice", "u2", "sku,price\nA-1,9.99\n")

    body = client.get("/api/datasets/ds1/columns?upload_id=u2", headers=auth).json()
    assert body["source"] == "upload"
    assert [col["name"] for col in body["columns"]] == ["sku", "price"]
    # And an id that names no finalized bundle is the CALLER's error, not a fallback.
    assert client.get(
        "/api/datasets/ds1/columns?upload_id=u404", headers=auth
    ).status_code == 404


def test_columns_csv_sample_is_the_first_data_row_not_lexical_id_order(
    client, auth, app_db
) -> None:
    """Review of PR #358, FINDING 3. The bundle is read `all_varchar=true`, exactly as
    ingest reads it, so a USER column called `id` is a VARCHAR: `ORDER BY "id"` sorts
    "10" before "9" and returns a row that is not the first one. The CSV path takes the
    first data row with no ORDER BY. (The parquet path keeps its ORDER BY — there `id`
    is the pipeline's own dense integer key; `test_columns_reads_the_committed_parquet`
    pins that half.)"""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "id,title\n9,Ninth\n10,Tenth\n")

    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    assert body["source"] == "upload"
    assert [col["sample"] for col in body["columns"]] == ["9", "Ninth"]


def test_columns_is_owner_only(client, auth, auth_bob, app_db) -> None:
    """Owner-only: it reads a not-yet-published collection and a private upload bundle."""
    _seed(app_db, "ds1", "alice", visibility="public")  # public, and still not bob's
    assert client.get("/api/datasets/ds1/columns", headers=auth_bob).status_code == 403
    assert client.get("/api/datasets/ds1/columns").status_code == 401


def test_columns_404s_when_there_is_nothing_to_describe(client, auth, app_db) -> None:
    """No manifest, no recorded bundle, no `upload_id` given: this collection has never
    been baked and records no source, so there is genuinely nothing to describe.

    The owner DOES have a finalized bundle with a CSV — that is the point. This test
    used to pass on a tree with no bundle at all, which is why it stayed green while the
    owner-scoped fallback answered from a stray one (review of PR #358, finding 2)."""
    _seed(app_db, "ds1", "alice")
    _finalized_bundle("alice", "u9", "sku,price\nA-1,9.99\n")
    assert client.get("/api/datasets/ds1/columns", headers=auth).status_code == 404


# --- (9) round 2 of the review: the degradation paths, and the gaps it named ---------


def test_a_corrupt_job_payload_does_not_500_the_layout_list(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 1. `Job.fetch` DESERIALIZES the job, and a corrupt
    payload raises rq's `DeserializationError` — which is NOT a `RedisError`, so it
    escaped a guard that named only `NoSuchJobError`/`RedisError` and propagated out of
    the viewer's boot path. One bad job id must not make a dataset refuse to open.

    `datasets._job_states` carries a comment about exactly this failure on the dataset
    listing — the sibling incident on the sibling endpoint — and was hardened for it."""
    from rq.exceptions import DeserializationError

    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(monkeypatch, fetch_error=DeserializationError("corrupt payload"))

    response = client.get("/api/datasets/ds1/layouts", headers=auth)
    assert response.status_code == 200
    # Degraded to exactly today's answer: the manifest is authoritative, the job channel
    # is only an overlay, so every committed layout is live with no re-bake.
    assert [
        (lay["layout_id"], lay["state"], lay["rebake"])
        for lay in response.json()["layouts"]
    ] == [("grid", "live", None)]


def test_a_broker_drop_between_the_fetch_and_the_status_does_not_500(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 1, second escape. The status read used to sit OUTSIDE
    the try, so a broker that went away between `Job.fetch` and `get_status` propagated.
    Both are guarded together now, so this degrades like every other job-channel
    failure."""
    from redis.exceptions import ConnectionError as RedisConnectionError

    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(monkeypatch, status_error=RedisConnectionError("broker gone"))

    response = client.get("/api/datasets/ds1/layouts", headers=auth)
    assert response.status_code == 200
    assert [lay["state"] for lay in response.json()["layouts"]] == ["live"]


def test_the_layout_list_does_not_re_read_the_status_hash(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 6. `Job.fetch` already restores the status hash, so
    rq's DEFAULT `refresh=True` costs a SECOND Redis round-trip on every viewer open and
    every designer poll. `datasets._status_of` states the same fix. The docstring claimed
    "ONE Redis round-trip" while the code took two."""
    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    fake = _patch_job(monkeypatch, progress=_progress(["grid"], []))

    assert client.get("/api/datasets/ds1/layouts", headers=auth).status_code == 200
    # Exactly one status read, and it did not ask Redis to refresh. The meta read has
    # always been refresh=False; it is asserted beside it so the pair cannot drift.
    assert fake.status_refresh == [False]
    assert fake.meta_refresh == [False]


def test_a_family_spec_rebake_is_reported_on_every_id_it_replaces(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 3. `add-layouts` re-baking a multi-entry family is
    enqueued as `{"layout_specs": ["categorical"], "replace": ["categorical_kingdom",
    "categorical_phylum"]}`. `spec_layouts` is then `["categorical"]` and matches NEITHER
    committed id, so on the plan alone both cards reported NO pending re-bake until the
    worker published real `layout:{id}` stages — which it does only after the scan, the
    thumbnail decode and the id-integrity guard, i.e. after the longest part of the run.

    The fix reads the job's OWN `replace` kwarg. That is the request, read back — not
    `worker._family_layout_names`' expansion convention transcribed API-side."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(
            _entry("grid", "Grid", "grid"),
            _entry("categorical_kingdom", "Kingdom", "categorical"),
            _entry("categorical_phylum", "Phylum", "categorical"),
        ),
    )
    _write_pyramids(ds_dir, "grid", "categorical_kingdom", "categorical_phylum")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        progress=_progress(["categorical"], []),  # no per-layout stage published yet
        kwargs={"replace": ["categorical_kingdom", "categorical_phylum"]},
    )

    by_id = {
        lay["layout_id"]: lay
        for lay in client.get("/api/datasets/ds1/layouts", headers=auth).json()["layouts"]
    }
    assert by_id["categorical_kingdom"]["rebake"] == "queued"
    assert by_id["categorical_phylum"]["rebake"] == "queued"
    # Both stay OPENABLE throughout — a re-bake commits per-layout at the end.
    assert by_id["categorical_kingdom"]["state"] == "live"
    # A layout the job does not name is untouched.
    assert by_id["grid"]["rebake"] is None


def test_a_replaced_layout_whose_stage_is_running_is_baking_not_queued(
    client, auth, app_db, monkeypatch
) -> None:
    """The real stage still WINS once it appears: `replace` fills the window before the
    worker publishes one, it does not override it."""
    ds_dir = _write_manifest(
        "ds1", _manifest(_entry("categorical_kingdom", "Kingdom", "categorical"))
    )
    _write_pyramids(ds_dir, "categorical_kingdom")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        progress=_progress(["categorical"], [("categorical_kingdom", "running")]),
        kwargs={"replace": ["categorical_kingdom"]},
    )

    body = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert body["layouts"][0]["rebake"] == "baking"


def test_a_finished_replace_job_leaves_no_rebake(
    client, auth, app_db, monkeypatch
) -> None:
    """`replace` is read only from a job that is IN FLIGHT, exactly as the plan is. A
    finished job's kwargs must not leave every id it once named permanently pending."""
    ds_dir = _write_manifest(
        "ds1", _manifest(_entry("categorical_kingdom", "Kingdom", "categorical"))
    )
    _write_pyramids(ds_dir, "categorical_kingdom")
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(
        monkeypatch,
        state="finished",
        progress=_progress(["categorical"], []),
        kwargs={"replace": ["categorical_kingdom"]},
    )

    body = client.get("/api/datasets/ds1/layouts", headers=auth).json()
    assert body["layouts"][0]["rebake"] is None


def test_include_pending_answers_during_a_first_ingest_with_no_manifest(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 5. A collection has an app-state row from the moment
    `create_dataset` enqueues and a manifest only when the first bake COMMITS, so the
    designer's queue view — the flag's whole reason to exist — 404'd for the entire first
    ingest: the longest, most opaque wait a user has. It worked only for add-layouts onto
    an already-committed dataset."""
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")  # a row, no manifest on disk
    _patch_job(
        monkeypatch,
        progress=_progress(["grid", "datetime"], [("grid", "running")]),
    )

    response = client.get("/api/datasets/ds1/layouts?include_pending=true", headers=auth)
    assert response.status_code == 200
    body = response.json()
    assert [(lay["layout_id"], lay["state"]) for lay in body["layouts"]] == [
        ("grid", "baking"),
        ("datetime", "queued"),
    ]
    # The committed half is EMPTY, not invented: nothing has landed, so nothing is live.
    assert all(lay["committed_at"] is None for lay in body["layouts"])


def test_a_missing_manifest_still_404s_without_the_flag_or_without_a_record(
    client, auth, app_db, monkeypatch
) -> None:
    """The narrow widening is narrow. Absent a manifest, only `include_pending` AND an
    app-state row answers; the default viewer call and an unrecorded dataset both keep
    today's 404."""
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    _patch_job(monkeypatch, progress=_progress(["grid"], []))

    assert client.get("/api/datasets/ds1/layouts", headers=auth).status_code == 404
    assert (
        client.get(
            "/api/datasets/nosuch/layouts?include_pending=true", headers=auth
        ).status_code
        == 404
    )


def test_pending_layouts_is_computed_from_the_plan_and_the_stages_alone() -> None:
    """Review of PR #358, FINDING 12. `_layout_stage_states` is the single place that
    encodes the cross-process `layout:{id}` key convention, and it had two live call
    sites per request because `_pending_layouts` rebuilt what `list_layouts` had already
    built. It now takes the computed pair — which is also why it is callable here with no
    `JobProgress` at all."""
    from api.routers.layouts import _pending_layouts

    rows = _pending_layouts(
        {"grid"},
        ["grid", "datetime"],
        {"datetime": "running", "scatter": "queued", "umap": "failed"},
    )
    # Plan order first, then stage ids the plan did not name; committed ids and terminal
    # stages dropped.
    assert [(row.layout_id, row.state) for row in rows] == [
        ("datetime", "baking"),
        ("scatter", "queued"),
    ]


def test_a_named_bundle_with_no_csv_answers_upload_not_images_only(
    client, auth, app_db
) -> None:
    """Review of PR #358, FINDING 4. `?upload_id=` asks about ONE bundle. When that
    bundle has no CSV the honest answer is "that bundle has no columns" — `upload` with
    an empty list — and NOT `images_only`, which `ColumnListResponse` defines as "the
    collection has no metadata source at all".

    The collection here has a full committed `metadata.parquet`, so `images_only` would
    be a false claim about it, and a Data view following the model's own instruction
    ("read `source`, not `len(columns)`") would render "no metadata yet" over columns it
    has already committed.

    "A full committed `metadata.parquet`" is now literally true: the tree is the real
    `golden_dataset_full_v2`. It used to be an `(id, filename)` parquet under a manifest
    with no `column_roles` — which is an images-only collection by the schema's own
    definition, so the collection's own answer below would rightly be `images_only`."""
    _copy_fixture("golden_dataset_full_v2", "ds1")
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "file,date_made\na.jpg,1642\n")
    _finalized_bundle("alice", "u2")  # images-only: no metadata.csv

    response = client.get("/api/datasets/ds1/columns?upload_id=u2", headers=auth)
    assert response.status_code == 200
    assert response.json() == {"source": "upload", "columns": []}
    # And the collection's own answer is unchanged by having been asked about a bundle.
    assert (
        client.get("/api/datasets/ds1/columns", headers=auth).json()["source"] == "parquet"
    )


def test_a_source_that_will_not_parse_is_422_and_names_the_source(
    client, auth, app_db
) -> None:
    """The unpinned 422 branch. A bundle CSV the caller uploaded that DuckDB cannot read
    is the caller's own file, and resubmitting a fixed one is the remedy — so 422, not
    500. The DuckDB message names a server-side path and must not reach the response."""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    bundle = _finalized_bundle("alice", "u1", "ok\n1\n")
    # A LATIN-1 export — an ordinary way for a museum CSV to arrive, and one DuckDB
    # refuses outright: "Invalid unicode (byte sequence mismatch) detected". Verified
    # 2026-09-11 against duckdb 1.5.4; ragged rows, a stray NUL and an unterminated quote
    # are all accepted by the sniffer, so none of those would exercise this branch.
    (bundle / "metadata.csv").write_bytes(
        b"file,maker\n" + "a.jpg,Rembrandt café\n".encode("latin-1")
    )

    response = client.get("/api/datasets/ds1/columns", headers=auth)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail == "could not read this collection's upload metadata source"
    assert "/" not in detail  # no server path leaks


def test_a_long_sample_is_truncated_with_an_elision_marker(client, auth, app_db) -> None:
    """Review of PR #358, FINDING 9. A CSV is read `all_varchar=true`, so a cell is
    whatever the user uploaded: a 10 MB description in the first data row was serialized
    in full into a response that renders a short preview chip. Capped at
    `datasets._SAMPLE_MAX`, and the truncation announces itself with `…` so a UI can say
    the value was cut rather than show a silently shorter one."""
    from api.routers.datasets import _SAMPLE_MAX

    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    long_value = "x" * 50_000
    _finalized_bundle("alice", "u1", f"file,description\na.jpg,{long_value}\n")

    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    sample = body["columns"][1]["sample"]
    assert len(sample) == _SAMPLE_MAX
    assert sample.endswith("…")
    # A value that FITS is untouched — the cap truncates, it never pads or marks.
    assert body["columns"][0]["sample"] == "a.jpg"


def test_set_column_roles_409s_a_collection_with_no_committed_parquet(
    client, auth, app_db
) -> None:
    """Review of PR #358, FINDING 8. The guard was `db.is_dataset` — A MANIFEST EXISTS —
    so a tree with a manifest and no `metadata.parquet` enqueued a job that
    `run_set_roles` refuses in its own preconditions: roles are validated against the
    committed parquet (D-11) and there is nothing to validate against. Enqueuing it also
    clobbers `last_job_id`, so the dataset reads `processing` and DELETE 409s until the
    worker gets round to failing.

    The message names the REAL reason. It is not the images-only case and must not say
    it is: measured 2026-09-09 and recorded in `worker.run_set_roles`, an images-only
    ingest DOES write a `metadata.parquet` (id + filename;
    `tests/fixtures/golden_dataset_images_only_v2` is that shape), so such a tree passes
    this guard and is refused per-role with the columns it does have named."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))  # no parquet
    _seed(app_db, "ds1", "alice")

    response = client.post(
        "/api/datasets/ds1/column-roles", headers=auth, json={"column_roles": _ROLES}
    )
    assert response.status_code == 409
    assert "metadata.parquet" in response.json()["detail"]
    assert client.app.state.queue.calls == []


def test_the_in_flight_guard_is_read_inside_the_dataset_lock(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 13. The guard READS `last_job_id` and the enqueue
    WRITES it, so outside the lock two concurrent writes both pass it, both enqueue, and
    the second `record_dataset_job` overwrites the first job id — while the first job
    still runs, leaving two manifest rewrites racing and one failing with a refusal
    nobody is polling for.

    Pinned by ORDER, which is the only thing a single-threaded test can observe: the
    lock must already be held when the guard's `Job.fetch` happens."""
    _write_manifest(
        "ds1",
        _manifest(_entry("grid", "Grid", "grid"), _entry("datetime", "D", "datetime")),
    )
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    events = client.app.state.redis.events
    _patch_job(
        monkeypatch,
        state="finished",  # not in flight, so the write proceeds
        on_fetch=lambda: events.append("guard-fetch"),
    )

    assert (
        client.delete("/api/datasets/ds1/layouts/datetime", headers=auth).status_code == 202
    )
    assert events[:2] == ["lock-acquire", "guard-fetch"]


def test_an_unnamed_re_ingest_ambiguous_with_the_latest_bundle_is_409(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #390, round 3, findings 1+2 (this test previously pinned PR
    #358's finding 2 under the name `test_an_unnamed_re_ingest_does_not_record_a_
    guessed_bundle`, and asserted 200: `start_ingest` with no `upload_id` falling
    back to `_latest_finalized_bundle(owner)` was a fine INPUT, just not a fine
    RECORD, so the route used to proceed and simply leave the stale record alone).

    Round 3 found that "leave it alone" is not enough on its own: if THIS retry's
    job had gone on to COMMIT rather than stay hypothetical, ds1 would hold u2's
    cells while still recording u1, and a later add-layouts run would resolve the
    wrong bundle — the never-baked-retry path, reachable specifically because this
    route let the retry proceed at all. The fix is to REFUSE an unnamed re-ingest
    whenever the recorded source and the owner's latest upload disagree, rather than
    let it proceed on an ambiguous guess (round 2's own attempt CLEARED the record
    instead, in a different branch, and that was itself a regression — see
    test_write_ingest.py's finding-1 pins).

    The reproduction is unchanged: ds1 was created from u1 and its first bake
    failed, so there is no parquet; the owner then finalized u2 for an unrelated
    collection. The retry is now AMBIGUOUS (u1 recorded, u2 latest) and refused
    before it can enqueue anything at all — `GET .../columns` therefore still
    answers from u1, because the bake never touched u2."""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "file,date_made,maker\na.jpg,1642,Rembrandt\n")
    newer = _finalized_bundle("alice", "u2", "sku,price\nA-1,9.99\n")
    marker = newer / ".finalized"
    os.utime(marker, (marker.stat().st_mtime + 100, marker.stat().st_mtime + 100))
    _patch_job(monkeypatch, state="finished")

    r = client.post("/api/datasets/ds1/ingest", headers=auth, json={})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "u1" in detail
    assert "u2" in detail
    assert client.app.state.queue.calls == []  # never enqueued
    # Still describes u1: the bake never ran, so the pre-first-bake answer stands.
    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    assert [col["name"] for col in body["columns"]] == ["file", "date_made", "maker"]


def test_a_named_re_ingest_does_record_the_bundle_it_names(
    client, auth, app_db, monkeypatch
) -> None:
    """The other half, and why this is not simply "stop recording": an EXPLICIT
    `upload_id` is a source the caller chose, re-ingest rebuilds the whole collection
    from it, and the previously recorded bundle no longer describes anything."""
    _seed(app_db, "ds1", "alice", source_upload_id="u1")
    _finalized_bundle("alice", "u1", "file,date_made,maker\na.jpg,1642,Rembrandt\n")
    _finalized_bundle("alice", "u2", "sku,price\nA-1,9.99\n")
    _patch_job(monkeypatch, state="finished")

    assert (
        client.post(
            "/api/datasets/ds1/ingest", headers=auth, json={"upload_id": "u2"}
        ).status_code
        == 200
    )
    body = client.get("/api/datasets/ds1/columns", headers=auth).json()
    assert [col["name"] for col in body["columns"]] == ["sku", "price"]


def test_the_job_result_is_never_read_for_a_non_owner(
    client, auth, auth_bob, app_db, monkeypatch
) -> None:
    """Review of PR #358, FINDING 10. `result` is owner-only, but it was read from Redis
    INSIDE `_build_job_status` — before `may_read`, before the owner check — so an
    anonymous poller of a public dataset's finished job paid the `rq:results:` round-trip
    and the owner-only payload (`swept` file lists, `stale_tag_sidecar`) was materialized
    into the response object, only to be set back to `None` afterwards.

    Making it a post-hoc `= None` is what is being replaced: the read is now a second,
    GATED hop, so the value cannot cross the authorization boundary before the decision.
    Pinned on the read COUNT, not on the response — the response was already right."""
    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _seed(app_db, "ds1", "alice", job_id="job-l1-1", visibility="public")
    fake = _patch_job(
        monkeypatch, state="finished", return_value={"stale_layouts": ["datetime"]}
    )

    assert client.get("/api/jobs/job-l1-1").json()["result"] is None
    assert client.get("/api/jobs/job-l1-1", headers=auth_bob).json()["result"] is None
    assert fake.result_reads == 0  # neither non-owner caused the read at all

    assert client.get("/api/jobs/job-l1-1", headers=auth).json()["result"] == {
        "stale_layouts": ["datetime"]
    }
    assert fake.result_reads == 1  # and the owner still gets it, in one read


def test_the_job_log_and_error_are_never_read_for_a_non_owner(
    client, auth, auth_bob, app_db, monkeypatch
) -> None:
    """[[T2-the-job-status-route-returns-a-public-dataset-s]]. `log_tail` and `error` were
    read inside `_build_job_status` — before `may_read`, before the owner check — and
    returned to every caller who may read the dataset. For a PUBLIC dataset that is
    anyone holding the job id, and the listing hands the id to every reader while a bake
    runs. The log records the owner's username and paths; a failed job's error is the
    exception's own message, which on the web path names the upload bundle under
    `users/{owner}/uploads/` and the original filenames (`ingest._scan_images`).

    The fix is `result`'s: decide, THEN read. So this is pinned on READ COUNTS as well as
    on the response — a version that reads the log or the traceback for everyone and
    blanks it for non-owners answers identically and must still fail here. Two counts:
    calls to `_read_log_tail`, and reads of `job.exc_info`, which in rq 2.10 is itself a
    Redis read (`_FakeJob` counts it; review of PR #405, finding 1). Each caller's answer
    is one comparison of `(log reads, exc_info reads, log_tail, error)`, so a failure
    shows which of the four moved.

    `exc_info` is also read only for a FAILED job (finding 2): the owner polls this route
    throughout every bake, and each read is an XREVRANGE for a value that is `None`
    until the job fails. So the owner's poll of a running job reads the log and never
    the traceback.

    Production-shaped: the log is a real file at `{output_root}/{ds}/ingest.log` with
    `output_root` = `DATA_ROOT/datasets` (D-30) — the fake job's default `/nonexistent`
    reads as `[]` and would make the owner's assertion vacuous — in the worker's own
    `%(asctime)s %(levelname)s %(message)s` format and wording; the job has FAILED
    with an RQ-style traceback and carries a `failed` stage (`progress.StageState`), so
    `progress` is non-null and comparing it across callers is not vacuous."""
    from api.routers import jobs as jobs_router

    output_root = Path(os.environ["DATA_ROOT"]) / "datasets"
    bundle_images = Path(os.environ["DATA_ROOT"]) / "users/alice/uploads/u1/images"

    def _log_lines(ds: str) -> list[str]:
        return [
            f"2026-09-29 10:00:00,000 INFO ingest start dataset={ds} owner=alice "
            "job=job-l1-1 specs=['grid']",
            f"2026-09-29 10:00:01,000 INFO ingested 3 image(s) from {bundle_images}",
            "2026-09-29 10:00:02,000 INFO committed dataset_version=1 (layouts=['grid'])",
        ]

    message = f"ValueError: duplicate image basenames in {bundle_images}: ['a.jpg']"
    traceback = (
        "Traceback (most recent call last):\n"
        '  File "/app/pipeline/ingest.py", line 211, in _scan_images\n'
        f"{message}\n"
    )
    for ds in ("ds1", "ds2"):
        _write_manifest(ds, _manifest(_entry("grid", "Grid", "grid")))
        (output_root / ds / "ingest.log").write_text(
            "\n".join(_log_lines(ds)) + "\n", encoding="utf-8"
        )

    log_reads: list[tuple[str, str]] = []
    real_read_log_tail = jobs_router._read_log_tail

    def _counting_read_log_tail(root: str, dataset_id: str) -> list[str]:
        log_reads.append((root, dataset_id))
        return real_read_log_tail(root, dataset_id)

    monkeypatch.setattr(jobs_router, "_read_log_tail", _counting_read_log_tail)

    def _failed_job_on(dataset_id: str) -> _FakeJob:
        fake = _patch_job(
            monkeypatch,
            state="failed",
            progress=_progress(["grid"], [("grid", "failed")]),
            dataset_id=dataset_id,
            kwargs={"output_root": str(output_root)},
        )
        fake.exc_info = traceback
        return fake

    # A PUBLIC dataset, in the order anonymous, a signed-in non-owner, then the owner.
    _seed(app_db, "ds1", "alice", job_id="job-l1-1", visibility="public")
    failed = _failed_job_on("ds1")

    anonymous = client.get("/api/jobs/job-l1-1")
    assert anonymous.status_code == 200
    anon = anonymous.json()
    assert (len(log_reads), failed.exc_info_reads, anon["log_tail"], anon["error"]) == (
        0,
        0,
        [],
        None,
    )

    bob = client.get("/api/jobs/job-l1-1", headers=auth_bob).json()
    assert (len(log_reads), failed.exc_info_reads, bob["log_tail"], bob["error"]) == (
        0,
        0,
        [],
        None,
    )

    owner = client.get("/api/jobs/job-l1-1", headers=auth).json()
    assert (len(log_reads), failed.exc_info_reads, owner["log_tail"], owner["error"]) == (
        1,
        1,
        _log_lines("ds1"),
        message,
    )
    assert log_reads == [(str(output_root), "ds1")]

    # What stays public is the same for everyone the gate admits — and it still shows
    # the failure, as a stage.
    public_fields = ("job_id", "state", "dataset_id", "progress")
    assert {k: anon[k] for k in public_fields} == {k: owner[k] for k in public_fields}
    assert {k: bob[k] for k in public_fields} == {k: owner[k] for k in public_fields}
    assert anon["state"] == "failed"
    assert anon["progress"]["stages"][0]["state"] == "failed"

    # The owner's poll of a job that has NOT failed: the log is read, the traceback is not.
    # A running job carries no traceback in production, so the fake's stays None.
    running = _patch_job(
        monkeypatch,
        state="started",
        progress=_progress(["grid"], [("grid", "running")]),
        dataset_id="ds1",
        kwargs={"output_root": str(output_root)},
    )
    polled = client.get("/api/jobs/job-l1-1", headers=auth).json()
    assert (len(log_reads), running.exc_info_reads, polled["log_tail"], polled["error"]) == (
        2,
        0,
        _log_lines("ds1"),
        None,
    )

    # A PRIVATE dataset: the read gate answers the same 404 as a missing job, and neither
    # the log nor the traceback is read on the way to that answer.
    _seed(app_db, "ds2", "alice", job_id="job-l1-2")
    private = _failed_job_on("ds2")
    assert client.get("/api/jobs/job-l1-2", headers=auth_bob).status_code == 404
    assert client.get("/api/jobs/job-l1-2").status_code == 404
    assert (log_reads, private.exc_info_reads) == ([(str(output_root), "ds1")] * 2, 0)


def test_an_unreadable_failure_message_still_answers_the_owner(
    client, auth, app_db, monkeypatch, caplog
) -> None:
    """Review of PR #405, finding 3. The owner's `exc_info` read is a Redis read (rq 2.10:
    `latest_result()`, then a b64 + zlib decode of the payload), and it used to sit
    outside any `try`. A broker drop or an undecodable result then answered 500 — on
    the owner's LAST poll of a failed job, since the read happens only then — and the
    frontend's `pollJob` stops on a transport error. The one person who can act on the
    failure saw that instead of `state: "failed"`.

    It is now best-effort, like `_read_job_result`: `error` is null, a warning names the
    job, and everything else — `state`, `progress` and the owner's log — still arrives."""
    from redis.exceptions import ConnectionError as RedisConnectionError

    output_root = Path(os.environ["DATA_ROOT"]) / "datasets"
    ds_dir = _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    (ds_dir / "ingest.log").write_text(
        "2026-09-29 10:00:00,000 INFO ingest start dataset=ds1 owner=alice\n",
        encoding="utf-8",
    )
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    fake = _patch_job(
        monkeypatch,
        state="failed",
        progress=_progress(["grid"], [("grid", "failed")]),
        kwargs={"output_root": str(output_root)},
    )
    fake.exc_info = "Traceback (most recent call last):\nValueError: boom\n"
    fake.exc_info_error = RedisConnectionError("broker gone")

    # The same app, answering as it would to a real client: an unhandled error is the 500
    # the frontend sees, not an exception re-raised into the test. Deliberately NOT a
    # `with` block: entering one reruns the lifespan, which was observed (2026-09-29) to
    # replace the fixture's `_FakeQueue`/`_FakeRedis` with a real `Queue` and `Redis`.
    as_served = TestClient(client.app, raise_server_exceptions=False)
    with caplog.at_level(logging.DEBUG, logger="api.routers.jobs"):
        response = as_served.get("/api/jobs/job-l1-1", headers=auth)
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["state"], body["error"], fake.exc_info_reads) == ("failed", None, 1)
    assert body["log_tail"] == [
        "2026-09-29 10:00:00,000 INFO ingest start dataset=ds1 owner=alice"
    ]
    assert body["progress"]["stages"][0]["state"] == "failed"
    assert any(
        record.levelno == logging.WARNING
        and "job-l1-1" in record.getMessage()
        and "ConnectionError" in record.getMessage()
        for record in caplog.records
    ), [record.getMessage() for record in caplog.records]
    # The warning is terse because it repeats on every poll, so the cause goes to DEBUG
    # with its traceback (second review of PR #405, finding 6).
    assert any(
        record.levelno == logging.DEBUG
        and "job-l1-1" in record.getMessage()
        and record.exc_info is not None
        for record in caplog.records
    ), [(record.levelname, record.getMessage(), record.exc_info) for record in caplog.records]


def test_the_owner_s_poll_fetches_the_job_once(client, auth, app_db, monkeypatch) -> None:
    """Second review of PR #405, finding 1. `_build_job_status` already fetches the job,
    but `_read_job_result` fetched it AGAIN, and the owner-only reads ran as two
    threadpool hops, one after the other. The owner polls this route throughout every
    bake, so each poll paid for both.

    Measured with this test's own counters on a FINISHED job, the one state where
    `result` is read: before the fix, 2 `Job.fetch` calls and 3 dispatches
    (`_build_job_status`, `_read_owner_diagnostics`, `_read_job_result`); after it, 1
    and 2. Pinned on both, so a second fetch or a second owner hop fails here."""
    from api.routers import jobs as jobs_router

    _write_manifest("ds1", _manifest(_entry("grid", "Grid", "grid")))
    _seed(app_db, "ds1", "alice", job_id="job-l1-1")
    fetches: list[str] = []
    fake = _patch_job(
        monkeypatch,
        state="finished",
        progress=_progress(["grid"], [("grid", "done")]),
        return_value={"stale_layouts": ["datetime"]},
        on_fetch=lambda: fetches.append("fetch"),
    )

    real = jobs_router.run_in_threadpool
    dispatched: list[str] = []

    async def spying(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        dispatched.append(func.__name__)
        return await real(func, *args, **kwargs)

    monkeypatch.setattr(jobs_router, "run_in_threadpool", spying)
    body = client.get("/api/jobs/job-l1-1", headers=auth).json()
    assert body["result"] == {"stale_layouts": ["datetime"]}
    assert (len(fetches), dispatched, fake.result_reads) == (
        1,
        ["_build_job_status", "_read_owner_fields"],
        1,
    )


# --- (10) round 3 of the review -------------------------------------------------------


def test_committed_at_never_stats_a_container_path_outside_the_dataset(
    client, auth, app_db
) -> None:
    """Review of PR #358, round 3, FINDING 4. `_committed_at` built the path as
    `ds_dir / rel`, and `Path.__truediv__` DROPS the base for an absolute right-hand side
    while `..` walks out of it — so a manifest could point the layout list at any file on
    the host and learn its mtime. `tiles.get_pyramid` reads the same field through
    `db.resolve_under`; this now does too.

    The hostile shape is the point: the pipeline never writes either path, but a
    restored, copied or hand-edited manifest carries whatever it carries. Both targets
    are REAL files, so the unjailed code answered a timestamp for each; and the `grid`
    row is the control that the jail did not simply null every row."""
    # A sibling of ds1 under the datasets root — outside the dataset, inside DATA_ROOT.
    outside = Path(os.environ["DATA_ROOT"]) / "datasets" / "outside.pmtiles"
    outside.write_bytes(b"\0")
    grid = _entry("grid", "Grid", "grid")
    absolute = _entry("absolute", "Absolute", "grid")
    absolute["pyramid"] = dict(absolute["pyramid"], path=outside.as_posix())
    dotdot = _entry("dotdot", "Dotdot", "grid")
    dotdot["pyramid"] = dict(dotdot["pyramid"], path="../outside.pmtiles")
    ds_dir = _write_manifest("ds1", _manifest(grid, absolute, dotdot))
    _write_pyramids(ds_dir, "grid")
    _seed(app_db, "ds1", "alice")

    response = client.get("/api/datasets/ds1/layouts", headers=auth)
    assert response.status_code == 200
    stamped = {lay["layout_id"]: lay["committed_at"] for lay in response.json()["layouts"]}
    assert stamped["grid"] is not None
    assert stamped["absolute"] is None
    assert stamped["dotdot"] is None


def test_re_ingest_409s_while_another_job_is_in_flight(
    client, auth, app_db, monkeypatch
) -> None:
    """Review of PR #358, round 3, the note on re-ingest. `start_ingest` held the
    per-dataset lock but never checked for a running job, so a re-ingest queued on top of
    a running delete-layout (or set-roles, or bake) and its `record_dataset_job`
    overwrote the running job's id — the one write route here that could stack.

    The running job is production's: a delete-layout enqueued through the real route,
    `started`, carrying exactly those kwargs (a delete publishes no layout progress). The
    guard must refuse with the shared wording and enqueue nothing — and decide INSIDE
    the lock, which is pinned by order as it is for delete."""
    ds_dir = _write_manifest(
        "ds1",
        _manifest(_entry("grid", "Grid", "grid"), _entry("datetime", "D", "datetime")),
    )
    _write_pyramids(ds_dir, "grid", "datetime")
    _seed(app_db, "ds1", "alice")
    _finalized_bundle("alice", "u1")
    assert client.delete("/api/datasets/ds1/layouts/datetime", headers=auth).status_code == 202
    events = client.app.state.redis.events
    _patch_job(
        monkeypatch,
        state="started",
        kwargs=client.app.state.queue.calls[-1][1],
        on_fetch=lambda: events.append("guard-fetch"),
    )
    events.clear()
    enqueued_before = len(client.app.state.queue.calls)

    response = client.post("/api/datasets/ds1/ingest", headers=auth, json={"upload_id": "u1"})
    assert response.status_code == 409
    assert response.json()["detail"] == "Another job for this collection is still running"
    assert len(client.app.state.queue.calls) == enqueued_before  # nothing enqueued
    assert events[:2] == ["lock-acquire", "guard-fetch"]
