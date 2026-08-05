"""Tier-1 skeleton test: the app constructs and answers the health check.

Verifies `import api.main` resolves, the FastAPI app constructs, the lifespan
runs (opens/closes the per-worker DuckDB connection), and GET /api/health
returns {"status": "ok"}.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from api.main import app


def test_import_main_resolves() -> None:
    import api.main  # noqa: F401


def test_health_returns_ok() -> None:
    # `with` drives the lifespan startup/shutdown (db.open_connection).
    with TestClient(app) as client:
        resp = client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}
