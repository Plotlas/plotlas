"""Smoke-suite hygiene (PR17-1).

`test_stack_boots.py` drives the FastAPI lifespan (`TestClient(app)`), which calls
`appstate.setup_appstate()`. With neither `APP_STATE_DB` nor `DATA_ROOT` set — the
lean test image's default — that resolves the app-state DB to
`${DATA_ROOT:-.}/app-state/appstate.db`, i.e. it would create an `app-state/`
directory **inside the mounted repo** (CWD) as a side effect of running the smoke
boot test.

`packages/api/tests/conftest.py` already pins an out-of-repo `APP_STATE_DB`
default, but that conftest only governs `packages/api/tests`. When `tests/smoke`
runs on its own (or before the api conftest in a different invocation order), the
guard is absent. Pinning the env here — at smoke-suite collection time, before any
test constructs the app — makes the smoke suite self-sufficient: it never writes
app-state into the repo regardless of run order or `DATA_ROOT`.

This is the brief's option (b) for PR17-1 ("pin `APP_STATE_DB` in `tests/smoke`"),
chosen over editing the lifespan because `api/main.py` is outside Work Package A's
write scope. `setdefault` respects an explicitly-set `APP_STATE_DB` (e.g. in CI).
"""

from __future__ import annotations

import os
import tempfile

# Out-of-repo default for BOTH knobs that steer the app-state path, set at import
# (collection) time so the lifespan never falls back to a CWD-relative DB. DATA_ROOT
# is pinned too so resolve_appstate_db_path's fallback (when APP_STATE_DB is somehow
# cleared mid-run) still lands outside the repo.
_tmp = tempfile.gettempdir()
os.environ.setdefault("APP_STATE_DB", os.path.join(_tmp, "image-viz-smoke-appstate.db"))
os.environ.setdefault("DATA_ROOT", os.path.join(_tmp, "image-viz-smoke-data"))
