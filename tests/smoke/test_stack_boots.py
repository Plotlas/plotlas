"""Wiring smoke test (skeleton sub-brief 04 §E).

Proves the stack is wired together in-process and fast: both packages import in
one interpreter (`pipeline.worker` for the D-15 dotted path the API enqueues, and
`api.main`), the FastAPI app constructs, its lifespan runs, and GET /api/health
answers. Full docker-compose boot is verified manually via `make dev` per the
runbook; this stays in-process so it can gate every change cheaply.

This test needs BOTH packages on the path at once — neither split service image
provides that (api: no pipeline deps; worker: no api deps) — so it runs in the
combined test environment (docker/Dockerfile.test), wired by `make test`.
"""

from __future__ import annotations

import importlib


def test_pipeline_worker_import_resolves() -> None:
    # decision D-15: the API enqueues "pipeline.worker.run_ingest_job" (the
    # primitive-kwargs entry) by dotted path, so it must resolve even though the API
    # never imports the pipeline package; run_ingest is its inner delegate.
    worker = importlib.import_module("pipeline.worker")
    assert hasattr(worker, "run_ingest_job")
    assert hasattr(worker, "run_ingest")
    assert hasattr(worker, "IngestJobPayload")


def test_api_main_import_resolves() -> None:
    main = importlib.import_module("api.main")
    assert hasattr(main, "app")


def test_app_constructs_and_health_ok() -> None:
    from fastapi.testclient import TestClient

    from api.main import app

    # `with` drives the lifespan startup/shutdown (db.open_connection).
    with TestClient(app) as client:
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


def test_boot_writes_no_appstate_into_repo(tmp_path, monkeypatch) -> None:
    """PR17-1: booting the app must not litter the working tree with an `app-state/`
    DB. The conftest pins APP_STATE_DB out of the repo by default; this asserts the
    guarantee directly by pointing both knobs at a tmp dir and confirming the CWD's
    `app-state/` is never created by the lifespan."""
    import os
    from pathlib import Path

    from fastapi.testclient import TestClient

    from api.main import create_app

    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(tmp_path / "data"))
    cwd_appstate = Path(os.getcwd()) / "app-state"
    existed_before = cwd_appstate.exists()

    with TestClient(create_app()) as client:
        assert client.get("/api/health").status_code == 200

    assert (tmp_path / "appstate.db").exists()  # the DB landed where we pointed it
    if not existed_before:
        assert not cwd_appstate.exists()  # ...and NOT in the repo working tree
