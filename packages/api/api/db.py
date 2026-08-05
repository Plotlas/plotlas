"""Read-only access to the dataset tree (cross-cutting rule #5).

Two concerns, both read-only and both rooted at ``DATA_ROOT``:

* **DuckDB lifecycle** — ``open_connection`` is the sole caller of
  ``duckdb.connect()`` in the entire codebase. One connection per Uvicorn worker
  (opened from the lifespan in ``main.py``), one ``.cursor()`` per request
  (``get_cursor``). Read intent is honoured by issuing only ``SELECT
  read_parquet(...)`` — never DML/DDL.
* **Dataset-tree filesystem helpers** — ``resolve_data_root`` / ``datasets_root`` /
  ``dataset_dir`` / ``resolve_under`` / ``load_manifest`` locate and read the
  on-disk ``DATA_ROOT/datasets/{ds_id}/`` tree (the manifest JSON, tile files) with
  strict path jailing. They live here, the read-data module, because the read
  routers may not import one another (module-map rule) and must not own a shared
  utility module outside the ownership table — co-locating them in ``db.py`` keeps
  the read path in one owned place.

``DATA_ROOT`` is split into two disjoint roots (decision D-30) so a ``username``
and a ``ds_id`` can never collide on one directory level: dataset output trees
live under ``datasets_root()`` (``DATA_ROOT/datasets/``) and the upload jails under
``users_root()`` (``DATA_ROOT/users/``), with the app-state store a third disjoint
sibling (``DATA_ROOT/app-state/``, owned by ``appstate.py``). The collision class
is gone by layout, so no name-based guard is needed anywhere.

Never touches app-state (users / dataset ownership) — that is ``appstate.py``'s
sole domain.
"""

from __future__ import annotations

import json
import os
from collections import OrderedDict
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from stat import S_ISREG
from typing import Any

import duckdb  # type: ignore[import-untyped]
from fastapi import HTTPException, Request, status

# The manifest major version this API can serve. The pipeline validates the
# manifest against layout_manifest.schema.json at WRITE time, so we do not
# re-validate here (jsonschema is intentionally not a dependency); a cheap major
# guard is enough to refuse an incompatible manifest. Bumped 1 -> 2 for the v2
# spatial-tile-pyramid contract (schemas/v2/, decision D-33): the API now serves
# "2.x" manifests (pipeline writes "2.1") and refuses the retired v1.x ("1.x") and
# any future "3.x". A code int, NOT a jsonschema validation — jsonschema stays out
# of the API deps (the manifest is still returned verbatim, never re-validated).
SUPPORTED_MANIFEST_MAJOR = 2

_MANIFEST_FILENAME = "layout_manifest.json"


def open_connection(data_root: Path) -> duckdb.DuckDBPyConnection:
    """Open the single per-worker DuckDB connection. Called once from the FastAPI
    lifespan in main.py. Sole caller of duckdb.connect() in the entire codebase.

    An in-memory connection: each dataset's Parquet is queried by absolute path
    via ``read_parquet('{data_root}/{ds}/metadata.parquet')`` (see
    ``routers/metadata.py``), so there is no DuckDB *database file* to open
    ``read_only=True`` against. The read-only contract is upheld by only ever
    issuing ``SELECT read_parquet(...)``. ``data_root`` is accepted for interface
    stability (the lifespan passes it) and documents that every read resolves
    under it; path resolution itself happens per request in ``resolve_data_root``.
    """
    # SECURITY (second-order SQLi hardening; scan 2026-07-13 / T2-115): we deliberately
    # do NOT pass config={"enable_external_access": False}. That flag WOULD block the
    # attacker primitives an injected identifier could reach (read_text / read_blob /
    # arbitrary-path reads → server-file read, cross-tenant leak, JWT_SECRET), but it
    # ALSO disables ``read_parquet`` by absolute path — the API's ONLY way to read every
    # ``metadata.parquet`` (``routers/metadata.py``, ``scalar_columns`` below) — so it
    # breaks core functionality. Verified empirically in the test image on duckdb 1.5.4:
    # ``enable_external_access=False`` blocks BOTH read_parquet AND read_text, and no
    # granular alternative exists through ``connect(config=)`` (``disabled_functions`` is
    # unrecognized; ``allowed_directories`` / ``disabled_filesystems`` reject connect-time
    # config, and a runtime ``SET allowed_directories`` is a no-op — read_text of
    # ``/proc/self/environ`` still succeeds). The control that closes the hole is
    # therefore identifier-escaping at every dynamic-name SQL sink (see
    # ``metadata._sql_ident``); rejecting non-safe column names at INGEST (pipeline
    # ``column_roles`` validation) is the tracked defense-in-depth follow-up (T2-115).
    return duckdb.connect()


def get_cursor(request: Request) -> Iterator[duckdb.DuckDBPyConnection]:
    """FastAPI dependency. Yields a request-scoped ``.cursor()`` off the per-worker
    connection on ``app.state.db`` so concurrent requests never share a cursor
    (DuckDB threading contract; decision brief Risk 3). Never opens a new
    connection (rule #5) and holds no module-level state (rule #8)."""
    cursor = request.app.state.db.cursor()
    try:
        yield cursor
    finally:
        cursor.close()


def resolve_data_root() -> Path:
    """Resolve ``DATA_ROOT`` (default ``.``), the same env the lifespan reads when
    opening the connection. Read per request rather than cached in a module global
    (rule #8); env is process-stable config. ``DATA_ROOT`` is the COMMON parent of
    the two disjoint roots below (and of the app-state store) — never a level at
    which datasets or jails live directly (decision D-30)."""
    return Path(os.environ.get("DATA_ROOT", ".")).resolve()


def datasets_root(data_root: Path | None = None) -> Path:
    """The dataset output-tree root ``DATA_ROOT/datasets/`` (decision D-30). Every
    dataset read (``dataset_dir``, the ``list_datasets`` scan, manifest/tile/
    metadata/tags resolution) and the worker's ``output_root`` anchor here, so a
    ``ds_id`` can never share a directory level with a ``username`` (which lives
    under ``users_root``). Not created here — the worker creates each dataset dir
    itself; a ``DATA_ROOT`` still in the pre-D-30 layout simply scans empty (no
    migration shim by design)."""
    return (resolve_data_root() if data_root is None else data_root) / "datasets"


def users_root(data_root: Path | None = None) -> Path:
    """The per-user upload-jail root ``DATA_ROOT/users/`` (decision D-30). Upload
    sessions live at ``users_root()/{username}/uploads/{upload_id}/`` — disjoint
    from ``datasets_root()`` — so the worker can never write INTO (nor a DELETE
    ``rmtree``) a user's namespace. The per-segment jail is still enforced by
    ``resolve_under`` at this root (anchors recomputed, never weakened)."""
    return (resolve_data_root() if data_root is None else data_root) / "users"


def resolve_under(root: Path, *segments: str) -> Path:
    """Join ``segments`` under ``root`` and resolve, refusing any result that
    escapes ``root`` (``..`` / absolute segment). Raises 404 on an escape so a
    traversal probe is indistinguishable from a miss. The sole path-jail for every
    client-supplied path segment that reaches the filesystem (tile route trap)."""
    base = root.resolve()
    candidate = base.joinpath(*segments).resolve()
    if candidate != base and not candidate.is_relative_to(base):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
        )
    return candidate


def dataset_dir(data_root: Path, ds_id: str) -> Path:
    """Resolve ``DATA_ROOT/datasets/{ds_id}`` with path jailing (rejects
    ``..``/absolute and ``ds_id`` resolving back to the datasets root itself).
    Anchored under ``datasets_root(data_root)`` (decision D-30), so the jail is
    recomputed at the new root and stays exactly as strict — a traversal probe
    cannot reach ``DATA_ROOT`` or a user's jail. Does NOT assert the dataset
    exists — callers that need the manifest get a 404 from ``load_manifest``."""
    root = datasets_root(data_root)
    candidate = resolve_under(root, ds_id)
    if candidate == root.resolve():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    return candidate


def is_dataset(ds_dir: Path) -> bool:
    """A directory with a ``layout_manifest.json`` is a dataset (brief / module-map)."""
    return (ds_dir / _MANIFEST_FILENAME).is_file()


# Bound on the parsed-manifest cache (see ``load_manifest``). Manifests are small
# (per-layout descriptors, not per-cell data — a few KB even at 1M), so this is
# generous; it caps memory for a long-lived process that serves many datasets.
_MANIFEST_CACHE_MAX = 256


@lru_cache(maxsize=_MANIFEST_CACHE_MAX)
def _load_manifest_cached(
    path_str: str, _mtime_ns: int, _size: int
) -> dict[str, Any]:
    """Parse + major-guard one manifest file. Cached on (path, mtime_ns, size) so a
    re-ingest (which rewrites the file at the same path with a new mtime/size) is a
    cache miss and reloads. ``lru_cache`` does NOT cache exceptions, so an
    unsupported-major manifest re-raises on every call (a cold error path).

    Returns a SHARED dict — all callers treat the manifest read-only (verified: no
    router mutates it), so returning the cached object rather than a copy is safe
    and keeps the hot range-read path (get_pyramid) from re-parsing per request."""
    with open(path_str, encoding="utf-8") as fh:
        manifest: dict[str, Any] = json.load(fh)
    version = str(manifest.get("manifest_version", ""))
    major = version.split(".", 1)[0]
    if major != str(SUPPORTED_MANIFEST_MAJOR):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Unsupported manifest_version {version!r}",
        )
    return manifest


def load_manifest(ds_dir: Path) -> dict[str, Any]:
    """Read a dataset's ``layout_manifest.json`` from disk and return it parsed.

    404 if the manifest is absent (the dataset does not exist). Applies the cheap
    ``manifest_version`` major guard (``SUPPORTED_MANIFEST_MAJOR``); a manifest
    from a future major is refused with 500 rather than served to a renderer that
    cannot read it. The JSON is otherwise returned VERBATIM — it is never
    re-validated against the JSON Schema here (the pipeline validates at write
    time; jsonschema is deliberately not an API dependency).

    PERF: the parsed manifest is cached (keyed on the file's path + mtime + size),
    because a single viewport's tile fetch drives many byte-range reads and
    ``get_pyramid`` re-loads the manifest on EVERY one; without the cache each range
    read re-opened and re-parsed this file. A ``stat`` (cheap) keys the cache, so a
    re-ingest that rewrites the manifest is picked up immediately (new mtime/size)."""
    manifest_path = ds_dir / _MANIFEST_FILENAME
    try:
        st = manifest_path.stat()
    except OSError:
        # OSError, not just FileNotFoundError/NotADirectoryError: the pre-cache
        # code used Path.is_file(), which suppresses EVERY OSError (PermissionError
        # included) into False -> 404. Keep that contract — an unreadable manifest
        # is "no dataset here", never a 500 with a traceback.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    if not S_ISREG(st.st_mode):  # a directory / symlink-to-dir is "no dataset here"
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    try:
        return _load_manifest_cached(str(manifest_path), st.st_mtime_ns, st.st_size)
    except OSError:
        # The manifest was stat-able but could NOT be read — e.g. a PermissionError on
        # open() (a root-owned, mode-600 manifest against the app uid), or an I/O error.
        # The stat() guard above only covers the stat; the open() happens one call deeper
        # in _load_manifest_cached. Same contract as that guard: an unreadable manifest is
        # "no dataset here" (a clean 404), never a 500 traceback — matching the pre-cache
        # Path.is_file() behaviour that suppressed every OSError into False. (A CORRUPT
        # manifest — json.JSONDecodeError — is deliberately NOT mapped here: the dataset
        # exists but is broken, which is a real 500 worth surfacing on a direct GET; the
        # listing scan isolates it separately.)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )


def ondisk_dataset_ids(root: Path | None = None) -> list[str]:
    """Every dataset id present on disk under ``root`` (default ``datasets_root()``),
    sorted. The SINGLE membership rule shared by the ``GET /api/datasets`` listing scan
    (``routers/datasets._scan_ready_datasets``) and the operator admin CLI
    (``api.admin``): a dot-prefixed entry is NEVER a dataset — it is a
    ``.staging-{job_id}`` dir the ingest worker can leak when an ``os.replace`` into
    place fails (e.g. an EXDEV re-ingest over a read-only bind-mounted fixture; D-19), so
    skipping it here is what keeps a leaked staging dir from surfacing as a phantom
    dataset — and a directory is a dataset iff it holds a ``layout_manifest.json``
    (``is_dataset``). Existence ONLY — this does not open the manifest, so a tree whose
    manifest is present-but-unservable is still a member (see ``dataset_is_servable``).
    Returns ``[]`` when ``root`` does not exist yet (a pre-D-30 DATA_ROOT scans empty)."""
    base = datasets_root() if root is None else root
    if not base.is_dir():
        return []
    return sorted(
        entry.name
        for entry in base.iterdir()
        if not entry.name.startswith(".") and entry.is_dir() and is_dataset(entry)
    )


def dataset_is_servable(ds_dir: Path) -> bool:
    """True iff ``load_manifest(ds_dir)`` succeeds — i.e. the API read path can parse the
    manifest and accept its ``manifest_version`` major. A dataset dir can pass
    ``is_dataset`` (the manifest FILE exists) yet be unservable: an unsupported/future
    major (a tree baked by a newer pipeline than this API — 500), a corrupt manifest
    (a ``json.JSONDecodeError``), or an unreadable one (a 404-mapped ``OSError``).
    ``GET /api/datasets`` drops all of these from the listing, so recording an owner does
    NOT make such a dataset visible. ``is_dataset`` answers "is this a dataset dir";
    this answers "can the API actually serve it". Broad ``except`` by design, mirroring
    the listing scan's per-dataset isolation."""
    try:
        load_manifest(ds_dir)
    except Exception:
        return False
    return True


# Parsed-schema cache for metadata.parquet (T2-04), keyed EXACTLY like the manifest
# cache above — (path, mtime_ns, size) — so a re-ingest that rewrites the Parquet at
# the same path (new mtime/size) is a miss and re-describes, while steady-state reads
# reuse the column list. An explicit bounded dict (not @lru_cache) because computing a
# value on miss needs the request-scoped DuckDB cursor, which cannot be a cache key
# (the connection lives on app.state.db, never a module global — rule #8); the keying
# and re-ingest semantics are identical to _load_manifest_cached. Small (a column-name
# list per dataset), so the bound is generous. Read-path only; no DML/DDL.
_SCHEMA_CACHE_MAX = 256
_scalar_columns_cache: "OrderedDict[tuple[str, int, int], list[str]]" = OrderedDict()


def scalar_columns(cursor: Any, parquet_path: Path) -> list[str]:
    """The SCALAR column names of ``parquet_path`` (list/STRUCT/MAP/UNION excluded),
    cached on (path, mtime_ns, size) so the per-request ``DESCRIBE`` runs once per
    file version instead of on every ``GET /metadata`` (T2-04). On a cache miss the
    ``DESCRIBE SELECT * FROM read_parquet(...)`` runs via the supplied request cursor
    — the caller MUST invoke this off the event loop (DuckDB is sync C), exactly as
    the metadata query already is. The Parquet path is server-derived (jailed) and
    quote-escaped; no client input reaches the SQL.

    404 if the file has vanished (matches ``load_manifest``: an absent source is "no
    dataset here", never a 500). The returned list is the file's own column order with
    only scalar columns retained — the tag ``list<string>`` columns are dropped so the
    metadata union stays scalar (D-21)."""
    try:
        st = parquet_path.stat()
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset metadata not found"
        )
    key = (str(parquet_path), st.st_mtime_ns, st.st_size)
    cached = _scalar_columns_cache.get(key)
    if cached is not None:
        _scalar_columns_cache.move_to_end(key)  # LRU touch
        return cached
    path_literal = parquet_path.as_posix().replace("'", "''")
    described = cursor.execute(
        f"DESCRIBE SELECT * FROM read_parquet('{path_literal}')"
    ).fetchall()
    columns = [name for name, ctype, *_ in described if _is_scalar_type(ctype)]
    _scalar_columns_cache[key] = columns
    _scalar_columns_cache.move_to_end(key)
    while len(_scalar_columns_cache) > _SCHEMA_CACHE_MAX:
        _scalar_columns_cache.popitem(last=False)  # evict least-recently-used
    return columns


def _is_scalar_type(duckdb_type: str) -> bool:
    """True for a scalar DuckDB column type. Excludes list (``...[]``, the tag
    columns) and other nested kinds (STRUCT/MAP/UNION) so the metadata ``fields``
    union stays scalar (D-21). Mirrored from the metadata router's former local
    helper — co-located here because the schema cache above consumes it."""
    t = (duckdb_type or "").upper()
    return "[]" not in t and not t.startswith(("STRUCT", "MAP", "UNION", "LIST"))


# Cache for the search route's length probe (T2-57), keyed EXACTLY like the schema
# cache above — (path, mtime_ns, size) plus the probed column set — so a re-ingest
# that rewrites the Parquet is a miss and re-measures, while steady-state searches
# reuse the averages. Small (a float per probed column per dataset) and read-path
# only, exactly like _scalar_columns_cache.
_avg_length_cache: "OrderedDict[tuple[str, int, int, tuple[str, ...]], dict[str, float]]" = (
    OrderedDict()
)


def _sql_ident(name: str) -> str:
    """Quote a SQL identifier (a column name) for DuckDB, doubling any embedded
    double-quote so the name cannot terminate the quotes and inject SQL. A paired
    invariant with ``routers/metadata._sql_ident`` / ``routers/search._sql_ident``
    (the cross-module rule forbids a router importing another, and db.py must not
    depend on a router, so this one-liner is duplicated here for db.py's own dynamic-
    identifier sink below). The guard test
    ``test_no_naive_double_quoted_identifier_fstring_in_api_source`` fails if any of
    them regress to naive ``f'"{col}"'`` quoting (second-order SQLi, T2-115)."""
    return '"' + name.replace('"', '""') + '"'


def text_column_avg_lengths(
    cursor: Any, parquet_path: Path, columns: list[str]
) -> dict[str, float]:
    """Average character length of each named column's values (nulls skipped),
    cached on (path, mtime_ns, size, columns) so the aggregate scan runs once per
    file version rather than on every search (T2-57). Powers the LENGTH half of the
    search title-vs-description heuristic (decision D-2): a freeform column whose
    values are short on average is title-like, a long one is description-like. Only
    the columns the classifier could not resolve by NAME are probed, so the common
    case (well-named columns) never triggers a scan.

    Every column name is identifier-escaped via ``_sql_ident`` before it reaches the
    SELECT list — the names originate in user CSV headers (second-order SQLi surface,
    T2-115). The Parquet path is server-derived (jailed) and quote-escaped. Runs the
    aggregate via the supplied request cursor; the caller MUST invoke it off the event
    loop (DuckDB is sync C), exactly as the metadata/search queries are. Returns {}
    when ``columns`` is empty (no scan)."""
    if not columns:
        return {}
    try:
        st = parquet_path.stat()
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset metadata not found"
        )
    key = (str(parquet_path), st.st_mtime_ns, st.st_size, tuple(columns))
    cached = _avg_length_cache.get(key)
    if cached is not None:
        _avg_length_cache.move_to_end(key)  # LRU touch
        return cached
    path_literal = parquet_path.as_posix().replace("'", "''")
    # AVG(LENGTH(CAST(col AS VARCHAR))) per column in one scan; NULLs are ignored by
    # AVG, so an all-null column yields NULL -> treated as 0.0 (unmeasured).
    select_list = ", ".join(
        f"AVG(LENGTH(CAST({_sql_ident(col)} AS VARCHAR)))" for col in columns
    )
    row = cursor.execute(
        f"SELECT {select_list} FROM read_parquet('{path_literal}')"
    ).fetchone()
    result = {col: float(row[i]) if row[i] is not None else 0.0 for i, col in enumerate(columns)}
    _avg_length_cache[key] = result
    _avg_length_cache.move_to_end(key)
    while len(_avg_length_cache) > _SCHEMA_CACHE_MAX:
        _avg_length_cache.popitem(last=False)  # evict least-recently-used
    return result
