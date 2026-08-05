"""Shared fixtures for API tests.

App-state is created fresh per test against a throwaway SQLite DB (brief §3) so
tests never write a shared/committed DB.

The module-level default below also keeps app-state out of the repo for the
architecture-owned boot tests (test_api_skeleton, tests/smoke), which drive the
lifespan without pinning APP_STATE_DB. This conftest is imported at collection
time — before any test runs — so the env default lands first; without it the
lifespan would write `${DATA_ROOT:-.}/app-state/appstate.db` into the mounted
repo when DATA_ROOT is unset (as in the lean test image).
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# Out-of-repo default (respects an explicitly-set APP_STATE_DB, e.g. in CI).
os.environ.setdefault(
    "APP_STATE_DB",
    os.path.join(tempfile.gettempdir(), "image-viz-test-appstate.db"),
)


@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    """A TestClient backed by a fresh, per-test app-state DB."""
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client
