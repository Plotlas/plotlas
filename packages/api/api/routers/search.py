"""GET /api/datasets/{ds_id}/search?q=...&fields=...&limit=... — importance-ranked
cell search (T2-57, the search-approach spike Option A / decision D-1).

Inverts the GET /metadata query shape: instead of "the scalar columns for a set of
ids", find "the ids WHERE a declared column ILIKE a bound pattern", returning a
capped, importance-ordered list of hits. It reuses metadata.py's security-hardened
primitives VERBATIM — `_sql_ident` (doubled-quote identifier escaping) for every
dynamic column name, the query string bound as a parameter, and the D-34
get_optional_user + appstate.may_read visibility gate (a private dataset a caller
cannot read 404s before any query runs, the same 404 as a missing dataset). No
schema change: the search route reads the manifest's existing `column_roles` to
decide which columns each tier scans.

The tier model (spike §2, decision D-4):
  * `fields=default` (tier-0, run on debounced keystroke) — the always-indexed set:
    the dense id, the filename, the title-like freeform columns, and every
    categorical label column. Short, cheap, "answers most queries instantly".
  * `fields=all` (tier-2 catch-all, run on Enter) — EVERY scalar column, so the
    obscure freeform fields (description) are reachable and no query is blocked.

Which freeform column is "the title" is the one honest gap (title and description
are both the `freeform` role, schema-indistinguishable). Resolved by the ratified
D-2 heuristic: a freeform column whose name/label reads title-like (or, when
ambiguous, whose values are SHORT on average — db.text_column_avg_lengths) is
tier-0; a description-like or long one is the tier-2 catch-all.

SECURITY (T2-115 discipline — mandatory): Parquet column names originate in
unvalidated user CSV headers, so every name that reaches SQL is escaped through
`_sql_ident` (embedded quotes doubled) and every user value is a bound parameter;
LIKE metacharacters in the query are escaped so they stay literal. The guard test
`test_no_naive_double_quoted_identifier_fstring_in_api_source` fails if this ever
regresses to naive `f'"{col}"'` quoting. Does not import another router; does not
accept raw SQL.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db
from api.models import SearchHit, SearchResponse

router = APIRouter()

SEARCH_MAX_RESULTS = 50  # hard cap on returned hits (spike §3.5; mirrors METADATA_MAX_IDS)
SEARCH_MAX_QUERY_LEN = 200  # bound the query string (and thus the bound LIKE pattern)
_SNIPPET_MAX = 160  # truncate a matched value for the results-list context line

# D-2 (a): a freeform column whose name/label reads like one of these is TITLE-like
# (tier-0). Substring, case-insensitive, over "{column} {label}".
_TITLE_NAME_TOKENS = ("title", "name", "label", "caption", "headline")
# D-2 (a): ...and one of these reads like a long-form catch-all field (tier-2 only).
_DESC_NAME_TOKENS = ("description", "abstract", "summary", "notes", "note", "comment", "biography", "provenance")
# D-2 (b): the length fallback for an AMBIGUOUS freeform name — values shorter than
# this on average are title-like, longer are description-like.
_TITLE_MAX_AVG_LEN = 60.0

# Field-selection + display priority (lower wins). A categorical hit LEADS the list
# and offers the snap-to-band jump (the "Rembrandt" headline case); a title hit is
# next; the freeform catch-all and id sit last. When a cell matches several columns,
# the highest-priority one is reported (so a categorical match groups under its band).
_ROLE_PRIORITY = {
    "categorical": 0,
    "title": 1,
    "filename": 2,
    "freeform": 3,
    "datetime": 4,
    "scatter": 5,
    "id": 6,
}


def _sql_ident(name: str) -> str:
    """Quote a SQL identifier (a column name) for DuckDB, doubling any embedded
    double-quote so the name cannot terminate the quotes and inject SQL. A VERBATIM
    copy of `metadata.py`'s `_sql_ident` — the cross-module rule (AGENT_GUIDE) forbids
    a router importing another, so it is duplicated here by design; the guard test
    `test_no_naive_double_quoted_identifier_fstring_in_api_source` fails if any copy
    regresses to naive `f'"{col}"'` quoting (second-order SQLi, T2-115)."""
    return '"' + name.replace('"', '""') + '"'


def _escape_like(term: str) -> str:
    """Escape the LIKE metacharacters (`%`, `_`) and the escape char itself (`\\`) in
    a user term so they match LITERALLY inside the bound `%term%` pattern (paired with
    ``ESCAPE '\\'`` in the SQL). Without this, a query of `50%` would wildcard-match
    everything rather than the literal text `50%`."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@dataclass(frozen=True)
class SearchColumn:
    """One searchable metadata column: its physical name, its search `role`
    (title/categorical/filename/id/freeform/datetime/scatter — the frontend routes
    categorical→snap and every other role→center-on-cell), its human `label`, and
    the field-selection/display `priority`."""

    column: str
    role: str
    label: str
    priority: int


def _entry_label(entry: dict[str, Any], fallback: str) -> str:
    """The role entry's human `label`, or `fallback` when absent/blank/non-string."""
    raw = entry.get("label")
    return raw if isinstance(raw, str) and raw else fallback


def _role_map(roles: dict[str, Any] | None) -> dict[str, tuple[str, str]]:
    """Build a physical-column -> (role, label) map from the manifest's `column_roles`.
    Tag columns are excluded (they are list<string>, not scalar — the D-14 sidecar
    owns tag search). Freeform columns are tagged the generic `freeform` role here;
    the title-vs-description split (D-2) is applied later in `_classify_columns`."""
    out: dict[str, tuple[str, str]] = {}
    if not isinstance(roles, dict):
        return out

    def _put(entry: Any, role: str) -> None:
        if isinstance(entry, dict) and isinstance(entry.get("column"), str):
            col: str = entry["column"]
            out[col] = (role, _entry_label(entry, col))

    _put(roles.get("filename"), "filename")
    _put(roles.get("datetime"), "datetime")
    for entry in roles.get("categorical") or []:
        _put(entry, "categorical")
    for entry in roles.get("freeform") or []:
        _put(entry, "freeform")
    for entry in roles.get("scatter") or []:
        if isinstance(entry, dict):
            label = _entry_label(entry, "Scatter")
            for key in ("x_column", "y_column"):
                col = entry.get(key)
                if isinstance(col, str):
                    out[col] = ("scatter", label)
    return out


def _freeform_is_title_like(column: str, label: str, avg_len: float | None) -> bool:
    """D-2 title-vs-description heuristic for one freeform column. (a) name/label:
    a title-like name is title-like, a description-like name is not. (b) length: for
    an ambiguous name, a short average value is title-like. Unmeasured + ambiguous ⇒
    NOT title-like (still reachable via the `fields=all` catch-all, just not tier-0)."""
    hay = f"{column} {label}".lower()
    if any(tok in hay for tok in _TITLE_NAME_TOKENS):
        return True
    if any(tok in hay for tok in _DESC_NAME_TOKENS):
        return False
    if avg_len is not None:
        return avg_len <= _TITLE_MAX_AVG_LEN
    return False


def _ambiguous_freeform_columns(roles: dict[str, Any] | None) -> list[str]:
    """Freeform columns whose NAME resolves to neither title- nor description-like —
    the only columns that need a length probe (D-2 (b)). Well-named columns (rijks
    `title`/`description`) resolve by name and never trigger a scan."""
    out: list[str] = []
    for entry in (roles or {}).get("freeform") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("column"), str):
            continue
        col: str = entry["column"]
        hay = f"{col} {_entry_label(entry, col)}".lower()
        if any(tok in hay for tok in _TITLE_NAME_TOKENS):
            continue
        if any(tok in hay for tok in _DESC_NAME_TOKENS):
            continue
        out.append(col)
    return out


def _url_columns(roles: dict[str, Any] | None) -> set[str]:
    """The `column_roles.url` names (schema v2.8): columns whose values are link targets,
    excluded from search. Robust to a hand-patched/malformed manifest — only string entries
    count, mirroring `_role_map`'s per-entry isinstance guard — so a bad shape can neither
    crash the search (an unhashable dict entry -> `set([{...}])` TypeError) nor silently
    mis-classify (a bare string treated as a set of characters). db.load_manifest returns the
    manifest verbatim, so this is the only gate before the API reads it."""
    if not isinstance(roles, dict):
        return set()
    return {c for c in (roles.get("url") or []) if isinstance(c, str)}


def _resolve_role(column: str, role_map: dict[str, tuple[str, str]]) -> tuple[str, str]:
    """(role, label) for a scalar column: the constant `id`, then the manifest role,
    then the D-25 `filename` convention (metadata.parquet always carries it, even for
    an images-only dataset with no role map), else the freeform catch-all."""
    if column == "id":
        return ("id", "Id")
    if column in role_map:
        return role_map[column]
    if column == "filename":
        return ("filename", "Filename")
    return ("freeform", column)


def _classify_columns(
    roles: dict[str, Any] | None,
    scalar_cols: list[str],
    all_fields: bool,
    avg_lengths: dict[str, float],
) -> list[SearchColumn]:
    """The searchable columns for the requested tier, in priority order (PURE — the
    unit-testable core of the tier model + the D-2 heuristic). `default` is id +
    filename + title-like freeform + categoricals; `all` is EVERY scalar column
    (annotated by its role, freeform split into title/description). Only columns that
    physically exist in `scalar_cols` are included, so a stale/absent role never names
    a column the query cannot select."""
    role_map = _role_map(roles)
    # A `url` column (schema v2.8 column_roles.url) holds LINK TARGETS, not human search
    # text: its values are short, so they classify title-like (tier-0), and their `https`
    # prefix matches nearly every row. Drop it from scalar_cols up front so it leaves BOTH
    # tier loops AND `present`, whatever OTHER role it carries (a url column is also freeform
    # or categorical). Filtering here — not popping from role_map — is what stops an unmapped
    # one falling through _resolve_role's freeform catch-all and being searched anyway.
    url_cols = _url_columns(roles)
    scalar_cols = [c for c in scalar_cols if c not in url_cols]
    present = set(scalar_cols)
    out: list[SearchColumn] = []
    seen: set[str] = set()

    def _add(column: str, role: str, label: str) -> None:
        if column in seen or column not in present:
            return
        seen.add(column)
        out.append(SearchColumn(column=column, role=role, label=label, priority=_ROLE_PRIORITY.get(role, 9)))

    def _resolved_role(column: str, label: str, role: str) -> str:
        # A freeform column splits into a tier-0 `title` or the tier-2 `freeform`
        # catch-all by the D-2 heuristic; every other role passes through.
        if role != "freeform":
            return role
        return "title" if _freeform_is_title_like(column, label, avg_lengths.get(column)) else "freeform"

    if all_fields:
        # Catch-all: every scalar column, so nothing is blocked.
        for column in scalar_cols:
            role, label = _resolve_role(column, role_map)
            _add(column, _resolved_role(column, label, role), label)
        out.sort(key=lambda sc: (sc.priority, sc.column))
        return out

    # Default (tier-0): id, filename, title-like freeform, categoricals.
    for column in scalar_cols:
        role, label = _resolve_role(column, role_map)
        if role in ("id", "filename", "categorical"):
            _add(column, role, label)
        elif role == "freeform" and _resolved_role(column, label, role) == "title":
            _add(column, "title", label)
    out.sort(key=lambda sc: (sc.priority, sc.column))
    return out


def _read_roles(ds_dir: Path) -> dict[str, Any] | None:
    """The dataset's manifest `column_roles`, or None when absent (an images-only
    dataset, or an unreadable/future-major manifest — search then degrades to the
    scalar columns metadata.parquet always carries: id + filename)."""
    try:
        manifest = db.load_manifest(ds_dir)
    except HTTPException:
        return None
    roles = manifest.get("column_roles")
    return roles if isinstance(roles, dict) else None


def _run_search(
    cursor: Any, parquet_path: Path, ds_dir: Path, query: str, all_fields: bool, limit: int
) -> tuple[list[SearchHit], bool]:
    """Resolve the tier's columns then execute the search (off the event loop). The
    scalar column list is cached (db.scalar_columns); the length probe runs only for
    ambiguously-named freeform columns and is likewise cached (T2-57)."""
    scalar_cols = db.scalar_columns(cursor, parquet_path)
    if "id" not in scalar_cols:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="metadata.parquet has no id column",
        )
    roles = _read_roles(ds_dir)
    # A url column is dropped from search by _classify_columns, so probing its average value
    # length here (D-2) would be wasted I/O — exclude it before the length aggregate too.
    url_cols = _url_columns(roles)
    ambiguous = [c for c in _ambiguous_freeform_columns(roles) if c in scalar_cols and c not in url_cols]
    avg_lengths = db.text_column_avg_lengths(cursor, parquet_path, ambiguous) if ambiguous else {}
    columns = _classify_columns(roles, scalar_cols, all_fields, avg_lengths)
    return _execute_search(cursor, parquet_path, columns, query, limit)


def _execute_search(
    cursor: Any, parquet_path: Path, columns: list[SearchColumn], query: str, limit: int
) -> tuple[list[SearchHit], bool]:
    """Run `SELECT id, <cols> FROM read_parquet WHERE (col ILIKE ? OR ...) LIMIT ?`
    with every column identifier escaped through `_sql_ident` and the pattern bound as
    a parameter. Fetches one over the cap to detect "more matches exist" (capped),
    then picks each cell's best matched field (priority order) for the snippet + role,
    and orders prefix-before-substring, then by role, then id (spike §5: no relevance
    scoring — position + role bias only).

    The cap is applied by the DATABASE, so the prefix bias has to live in the ORDER BY
    as well as in the Python pass below: ranking only the fetched page would let a
    LIMIT-by-id cut away every prefix match that happens to sit at a high id, and a
    broad query would then never surface its best hits (the page would just be "the
    lowest 50 ids that matched"). The SQL therefore sorts rows that PREFIX-match any
    searched column ahead of substring-only ones before the cut; the Python pass
    re-ranks that page by the matched column's role. Still position + role bias only —
    no term weighting, no scoring."""
    if not columns:
        return [], False
    path_literal = parquet_path.as_posix().replace("'", "''")
    src = f"read_parquet('{path_literal}')"
    pattern = f"%{_escape_like(query)}%"
    prefix_pattern = f"{_escape_like(query)}%"  # anchored: "rem" -> "rem%"

    select_exprs = ['"id"']
    match_exprs: list[str] = []
    prefix_exprs: list[str] = []
    value_cols: list[SearchColumn] = []  # non-id columns whose VARCHAR value we SELECT
    for sc in columns:
        cast = f"CAST({_sql_ident(sc.column)} AS VARCHAR)"
        match_exprs.append(f"{cast} ILIKE ? ESCAPE '\\'")
        prefix_exprs.append(f"{cast} ILIKE ? ESCAPE '\\'")
        if sc.column != "id":
            select_exprs.append(cast)
            value_cols.append(sc)

    # Parameter order is the SQL's TEXTUAL placeholder order: the WHERE substring
    # patterns, then the ORDER BY prefix patterns, then the LIMIT.
    sql = (
        f"SELECT {', '.join(select_exprs)} FROM {src} "
        f"WHERE ({' OR '.join(match_exprs)}) "
        f"ORDER BY (CASE WHEN ({' OR '.join(prefix_exprs)}) THEN 0 ELSE 1 END), \"id\" "
        f"LIMIT ?"
    )
    params: list[Any] = (
        [pattern] * len(match_exprs) + [prefix_pattern] * len(prefix_exprs) + [limit + 1]
    )
    records = cursor.execute(sql, params).fetchall()

    capped = len(records) > limit
    records = records[:limit]
    q_lower = query.lower()

    scored: list[tuple[bool, int, int, SearchHit]] = []  # (not is_prefix, priority, id, hit)
    for record in records:
        cell_id = int(record[0])
        col_value: dict[str, str | None] = {"id": str(cell_id)}
        for i, sc in enumerate(value_cols):
            raw = record[1 + i]
            col_value[sc.column] = None if raw is None else str(raw)

        matched = _pick_matched(columns, col_value, q_lower)
        if matched is None:
            continue  # WHERE matched but no readable value (defensive) — skip
        sc, value = matched
        snippet = value if len(value) <= _SNIPPET_MAX else value[: _SNIPPET_MAX - 1] + "…"
        is_prefix = value.lower().startswith(q_lower)
        hit = SearchHit(id=cell_id, field=sc.column, role=sc.role, label=sc.label, snippet=snippet)
        scored.append((not is_prefix, sc.priority, cell_id, hit))

    scored.sort(key=lambda s: (s[0], s[1], s[2]))
    return [s[3] for s in scored], capped


def _pick_matched(
    columns: list[SearchColumn], col_value: dict[str, str | None], q_lower: str
) -> tuple[SearchColumn, str] | None:
    """The highest-priority column whose value CONTAINS the query (case-insensitive) —
    the field reported for provenance ("in Description"). Falls back to the first
    non-empty value when ASCII case-folding (DuckDB ILIKE) and Python `.lower()`
    disagree on a non-ASCII term, so a WHERE match never emits an empty field."""
    for sc in columns:  # priority order
        value = col_value.get(sc.column)
        if value is not None and q_lower in value.lower():
            return sc, value
    for sc in columns:
        value = col_value.get(sc.column)
        if value:
            return sc, value
    return None


@router.get("/api/datasets/{ds_id}/search")
async def search_dataset(
    ds_id: str,
    q: str,
    fields: str = "default",
    limit: int = SEARCH_MAX_RESULTS,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
    cursor: Any = Depends(db.get_cursor),
) -> SearchResponse:
    """`q` is the search term (required, non-empty, at most SEARCH_MAX_QUERY_LEN
    chars). `fields` selects the tier — `default` (tier-0: id/filename/title/
    categoricals) or `all` (the tier-2 catch-all over every scalar column). `limit`
    is clamped to [1, SEARCH_MAX_RESULTS]. Visibility-scoped (D-34, may_read): a
    private dataset the caller cannot read 404s before any query runs."""
    ds_dir = db.dataset_dir(db.resolve_data_root(), ds_id)
    if not await appstate.may_read(session, ds_id, user):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset not found"
        )
    parquet_path = ds_dir / "metadata.parquet"
    if not parquet_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Dataset metadata not found"
        )
    query = q.strip()
    if not query:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Empty search query"
        )
    if len(query) > SEARCH_MAX_QUERY_LEN:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Search query too long (max {SEARCH_MAX_QUERY_LEN} characters)",
        )
    if fields not in ("default", "all"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="fields must be 'default' or 'all'",
        )
    limit = max(1, min(limit, SEARCH_MAX_RESULTS))
    hits, capped = await run_in_threadpool(
        _run_search, cursor, parquet_path, ds_dir, query, fields == "all", limit
    )
    return SearchResponse(query=query, hits=hits, capped=capped)
