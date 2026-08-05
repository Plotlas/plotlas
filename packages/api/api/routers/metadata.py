"""GET /api/datasets/{ds_id}/metadata?ids=... — metadata rows for selected cells.

Enforces a hard id cap (METADATA_MAX_IDS, bounded by URL length); larger or
malformed requests are rejected with 400 (decision D-13, revised). Queries
metadata.parquet via the request cursor (db.get_cursor).

Scalar-only (decision D-21): a row's `fields` carries `filename` (always present,
D-25) plus scalar enrichment columns; tag `list<string>` columns are excluded —
tags reach the UI via the D-14 sidecar, not here, so the union stays scalar with
one source of truth. Temporal columns (e.g. an iso8601 datetime role, which the
pipeline stores as a TIMESTAMP — see ingest.py `_enrichment_select`) are rendered
as ISO-8601 strings so they fit the scalar `MetadataRow.fields` union
(str|int|float|bool|None), matching how `DatasetSummary.ingest_timestamp`
serializes. Client `ids` are validated as ints and bound as parameters — never
interpolated into SQL.

Reads are visibility-scoped (D-34): an OPTIONAL identity (get_optional_user) +
appstate.may_read, so a public dataset's metadata serves anonymously while a private
one 404s a non-owner (the same 404 as a missing dataset). Does not import another
router; does not accept raw SQL.
"""

from __future__ import annotations

from datetime import date, datetime, time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db
from api.models import MetadataResponse, MetadataRow

router = APIRouter()

METADATA_MAX_IDS = 250  # hard cap, bounded by URL length (decision D-13, revised)


def _parse_ids(ids: str) -> list[int]:
    """Parse the comma-separated `ids` into ints. 400 on an empty list, more than
    METADATA_MAX_IDS, or any non-integer token. Empty tokens (e.g. a trailing
    comma) are tolerated and dropped."""
    tokens = [tok.strip() for tok in ids.split(",")]
    tokens = [tok for tok in tokens if tok]
    if not tokens:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No ids provided"
        )
    if len(tokens) > METADATA_MAX_IDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Too many ids (max {METADATA_MAX_IDS})",
        )
    out: list[int] = []
    for tok in tokens:
        try:
            out.append(int(tok))
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid id: {tok!r}",
            ) from None
    return out


def _coerce_field(value: Any) -> str | int | float | bool | None:
    """Coerce a DuckDB scalar into the `MetadataRow.fields` union
    (str|int|float|bool|None). DuckDB returns `datetime`/`date`/`time` objects for
    TIMESTAMP/DATE/TIME columns — and the pipeline writes an iso8601 datetime role
    as TIMESTAMP — none of which are in the union; without this they fail the
    response-model validation and 500 the request. Render them ISO-8601 (matching
    `DatasetSummary.ingest_timestamp`); values already in the union pass through."""
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    return value


def _sql_ident(name: str) -> str:
    """Quote a SQL identifier (a column name) for DuckDB, doubling any embedded
    double-quote so the name cannot terminate the quotes and inject SQL. Mirrors the
    pipeline's `ingest.py` `_sql_ident`; the cross-package rule (AGENT_GUIDE) forbids
    importing it, so this one-liner is duplicated here by design. The two are a paired
    invariant — if either quoter changes, change the other identically; the guard test
    `test_no_naive_double_quoted_identifier_fstring_in_api_source` fails if this side
    ever regresses to naive `f'"{col}"'` quoting.

    This is the control that closes the second-order SQLi in `_query_metadata`:
    `db.scalar_columns` returns the Parquet's own column names, which originate from
    user-supplied CSV headers (the pipeline stores each enrichment column under its raw
    header name) with NO charset validation, so a header like `x"||(SELECT ...)||"x`
    would break out of a naive `f'"{col}"'` quote and run an attacker subquery. A
    doubled-quote identifier cannot break out regardless of the Parquet's contents."""
    return '"' + name.replace('"', '""') + '"'


def _query_metadata(cursor: Any, parquet_path: Path, id_list: list[int]) -> list[MetadataRow]:
    """Select the scalar columns for `id_list` from metadata.parquet. The parquet
    path is server-derived (jailed) and quote-escaped; the ids are BOUND parameters.
    The scalar column NAMES come from the file's own schema but ultimately derive from
    user-supplied CSV headers (no charset validation at ingest), so each is
    identifier-escaped via `_sql_ident` (embedded quotes doubled) before it reaches the
    SELECT list — a name cannot break out of its quotes and inject SQL regardless of
    Parquet contents (second-order SQLi fix, security scan 2026-07-13). The `"id"`
    literals below are constant identifiers.

    The scalar column list comes from `db.scalar_columns`, cached on (path, mtime,
    size) — so the `DESCRIBE` runs once per file version rather than on every request
    (T2-04). This whole function runs via `run_in_threadpool` (get_metadata), so both
    the cached DESCRIBE-on-miss and the row query stay off the event loop."""
    path_literal = parquet_path.as_posix().replace("'", "''")
    src = f"read_parquet('{path_literal}')"

    scalar_cols = db.scalar_columns(cursor, parquet_path)
    if "id" not in scalar_cols:
        # metadata.parquet always carries id + filename (ingest contract); a file
        # without an id column is malformed, not a client error.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="metadata.parquet has no id column",
        )

    select_list = ", ".join(_sql_ident(col) for col in scalar_cols)
    placeholders = ", ".join("?" for _ in id_list)
    sql = (
        f"SELECT {select_list} FROM {src} "
        f'WHERE "id" IN ({placeholders}) ORDER BY "id"'
    )
    result = cursor.execute(sql, id_list).fetchall()

    id_pos = scalar_cols.index("id")
    field_positions = [(col, i) for i, col in enumerate(scalar_cols) if col != "id"]
    rows: list[MetadataRow] = []
    for record in result:
        fields = {col: _coerce_field(record[i]) for col, i in field_positions}
        rows.append(MetadataRow(id=int(record[id_pos]), fields=fields))
    return rows


@router.get("/api/datasets/{ds_id}/metadata")
async def get_metadata(
    ds_id: str,
    ids: str,
    user: appstate.CurrentUser | None = Depends(appstate.get_optional_user),
    session: AsyncSession = Depends(appstate.get_session),
    cursor: Any = Depends(db.get_cursor),
) -> MetadataResponse:
    """`ids` is a comma-separated list of cell ids (at most METADATA_MAX_IDS;
    larger or malformed requests are rejected with 400). Visibility-scoped (D-34,
    may_read) — a private dataset the caller cannot read 404s before any query runs."""
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
    id_list = _parse_ids(ids)
    rows = await run_in_threadpool(_query_metadata, cursor, parquet_path, id_list)
    return MetadataResponse(rows=rows)
