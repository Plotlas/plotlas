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


# Every env knob `routers/uploads.py` reads. Cleared before every test in this package
# (see `upload_env_hygiene`); a test that wants one SETS it in its own body, which runs
# after the fixture.
_UPLOAD_ENV_KNOBS = (
    "MAX_UPLOAD_BUNDLE_BYTES",
    "UPLOAD_DISK_RESERVE_BYTES",
    "MAX_UPLOAD_ENTRIES",
    "MAX_UPLOAD_PART_BYTES",
    "MAX_UPLOAD_CHECK_BODY_BYTES",
    "MAX_UPLOAD_SESSION_AGE_SECONDS",
)


@pytest.fixture(autouse=True)
def upload_env_hygiene(monkeypatch) -> None:
    """Start every test from the upload module's OWN defaults, whatever the ambient
    environment says.

    Seam L1 deleted the compiled-in 2 GiB `MAX_UPLOAD_BUNDLE_BYTES` default, so an
    exported value now changes the answer where before it did not — and the fix for that
    landed in ONE of two byte-identical `app_db` fixtures. Measured on the pair:
    `test_chunked_parts.py` went to 31 failed / 6 passed under
    `-e UPLOAD_DISK_RESERVE_BYTES=1099511627776`, and 9 failed under
    `-e MAX_UPLOAD_BUNDLE_BYTES=64`, while `test_derived_upload_bound.py` was unaffected
    (round-2 review of PR #304, finding 14).

    **Here rather than copied into the second fixture, because there are EIGHT copies of
    that fixture block in this directory and the next one to be written would be the
    ninth.** Autouse so no test has to remember to ask, and a conftest fixture reaches
    every module including the ones that shadow `client`.

    `_warn_malformed_env` is memoised per (name, value, consequence) for the life of the
    process, so a warning emitted by an earlier test would otherwise be suppressed for a
    later one asserting on it — a silent failure, unlike the loud env-var one."""
    from api.routers import uploads

    for name in _UPLOAD_ENV_KNOBS:
        monkeypatch.delenv(name, raising=False)
    uploads._warn_malformed_env.cache_clear()


@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    """A TestClient backed by a fresh, per-test app-state DB."""
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client
