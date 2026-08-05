# api

FastAPI service for `image-viz`. Serves the pipeline's `/datasets/{ds_id}/` tree
over HTTP (read-only visualization data via DuckDB-over-Parquet) and owns a
separate **mutable app-state store** (`appstate.py`, SQLite via SQLAlchemy) for
user accounts and dataset ownership. Write endpoints dispatch ingest jobs to the
pipeline worker via RQ (by dotted-path string — the API never imports `pipeline`).

> **Status: skeleton.** Every catalogue contract is transcribed and every
> behavioral body is stubbed (`raise NotImplementedError`, or `HTTPException(501)`
> for route handlers). The app construction, lifespan, router registration, and
> `GET /api/health` are real and run. No real query/auth/upload/enqueue logic yet.

## Layout

`api` is a top-level importable package; `uvicorn api.main:app` must work.

```
packages/api/
  pyproject.toml            # deps = allowed api list; [test] extra = pytest, httpx
  api/
    __init__.py
    main.py                 # app + lifespan (db.open_connection) + routers + GET /api/health (REAL)
    db.py                   # sole duckdb.connect() caller; read-only Parquet lifecycle
    appstate.py             # mutable app-state (users, dataset->owner); identity-only JWT
    queue.py                # RQ enqueuer; references pipeline job by dotted string only
    models.py               # shared Pydantic request/response models
    routers/
      __init__.py
      datasets.py auth.py uploads.py layouts.py tiles.py metadata.py jobs.py
  tests/
    test_api_skeleton.py    # Tier-1: import resolves; app constructs; GET /api/health == ok
  README.md
```

## Setup

```bash
cd packages/api
python -m venv .venv && source .venv/Scripts/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -e .[test]
```

## Running

```bash
uvicorn api.main:app --reload      # then GET http://localhost:8000/api/health -> {"status":"ok"}
```

## Testing

```bash
cd packages/api
python -m pytest -q                 # full suite (Tier-1 skeleton test)
python -m pytest -q tests/test_api_skeleton.py::test_health_returns_ok   # single test
```

Type checking:

```bash
mypy packages/api                   # from repo root
# or, with this package's [tool.mypy] config auto-discovered:
cd packages/api && mypy api tests
```

## Dependencies beyond the brief's base list (flagged)

Both are minimal and were resolved during scaffolding, not chosen silently:

- **`email-validator`** (runtime) — required by `pydantic.EmailStr`, which the
  catalogue's `auth.SignupRequest.email` uses. Without it, defining the model
  raises `ImportError` and the app cannot import. Approved 2026-05-29.
- **`httpx`** (test-only) — required by `fastapi.testclient.TestClient`, which the
  brief itself prescribes for the Tier-1 health test.

## Boundaries honored (cross-cutting rules)

- `db.py` is the only caller of `duckdb.connect()`; `appstate.py` touches no
  Parquet and is the sole writer of app-state.
- No router imports another router.
- `queue.py` contains no `import pipeline`; the job is referenced only as the
  dotted string `"pipeline.worker.run_ingest_job"`.
- The JWT carries identity only — no authorization claims; ownership/visibility
  is resolved per-request from app-state.
- The layout-manifest endpoint returns manifest JSON verbatim (not re-modelled
  in Pydantic).
