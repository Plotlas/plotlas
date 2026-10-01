"""Tests for GET /api/datasets/{ds_id}/search (T2-57, the search-approach spike).

Covers the seam's four risk surfaces:
  * the D-34 authz matrix (owner 200, non-owner/anonymous private 404, public 200)
    and the non-disclosure 404 — reusing the read-route model verbatim;
  * the T2-115 second-order SQLi: a malicious Parquet column name is escaped in BOTH
    of search's dynamic-identifier sinks (the SELECT list AND the WHERE ILIKE), with a
    positive control proving the payload is a real exploit under naive quoting;
  * the tier model + the D-2 title-vs-description heuristic (name + length);
  * the result cap, LIKE-metacharacter escaping, and request validation.

Function-level tests drive the search helpers directly on synthetic parquets (like
the metadata router's temporal/SQLi regressions); route-level tests build a small
searchable dataset under DATA_ROOT/datasets + app-state ownership and exercise the
real request path (auth + request cursor + response model).
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as papq
import pytest
from fastapi.testclient import TestClient

from api import appstate
from api.routers import search

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}
_BOB = {"username": "bob", "email": "bob@example.com", "password": "s3cretpw"}

SEARCHABLE_DS = "rijks_mini"

# A small searchable corpus in the rijks shape: a categorical artist, freeform title +
# description, and a filename join key. "Rembrandt van Rijn" repeats (a category with
# members); "50% linen" carries a literal LIKE metacharacter.
_ROWS = {
    "id": [0, 1, 2, 3],
    "filename": ["SK-A-1935.jpg", "SK-C-5.jpg", "RP-P-1.jpg", "misc.jpg"],
    "title": ["Misty Sea", "The Night Watch", "Self-portrait", "Study in 50% linen"],
    "artist": ["Jan Toorop", "Rembrandt van Rijn", "Rembrandt van Rijn", "Unknown"],
    "description": [
        "A hazy seascape at dawn.",
        "A militia company assembles in Amsterdam.",
        "A study of the artist himself.",
        "An open field under heavy clouds.",
    ],
}

_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "categorical": [{"column": "artist", "label": "Artist"}],
    "freeform": [
        {"column": "title", "label": "Title"},
        {"column": "description", "label": "Description"},
    ],
}


def _write_searchable_parquet(parquet_path: Path) -> None:
    papq.write_table(pa.table(_ROWS), str(parquet_path))


def _build_searchable_dataset(datasets_dir: Path, ds_id: str = SEARCHABLE_DS) -> Path:
    """A minimal dataset the search route can serve: metadata.parquet + a manifest
    carrying only `manifest_version` (major 2, so db.load_manifest accepts it) and
    `column_roles` (search reads nothing else from it — no pyramid/render need)."""
    ds_dir = datasets_dir / ds_id
    ds_dir.mkdir(parents=True, exist_ok=True)
    _write_searchable_parquet(ds_dir / "metadata.parquet")
    (ds_dir / "layout_manifest.json").write_text(
        json.dumps({"manifest_version": "2.1", "column_roles": _ROLES}), encoding="utf-8"
    )
    return ds_dir


# --- app-state seed helpers (second engine over the same SQLite file) -------


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _set_visibility(db_path: Path, dataset_id: str, visibility: str) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                assert await appstate.set_dataset_visibility(session, dataset_id, visibility)
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    _build_searchable_dataset(data_root / "datasets")
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def owner_auth(client, app_db) -> dict[str, str]:
    """alice owns SEARCHABLE_DS (private by default). Returns her bearer header."""
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    _seed_owner(app_db, SEARCHABLE_DS, "alice")
    return {"Authorization": f"Bearer {token}"}


def _hits(resp) -> list[dict]:
    assert resp.status_code == 200, resp.text
    return resp.json()["hits"]


# ---------------------------------------------------------------------------
# Pure helpers: the tier model + the D-2 title-vs-description heuristic
# ---------------------------------------------------------------------------


def test_freeform_title_heuristic_name_then_length() -> None:
    # (a) name/label wins: a "title"-ish name is title-like; a "description"-ish name
    # is not — regardless of measured length.
    assert search._freeform_is_title_like("title", "Title", avg_len=999.0) is True
    assert search._freeform_is_title_like("caption", "Caption", avg_len=None) is True
    assert search._freeform_is_title_like("description", "Description", avg_len=1.0) is False
    assert search._freeform_is_title_like("notes", "Curatorial notes", avg_len=1.0) is False
    # (b) length breaks an AMBIGUOUS name: a short average ⇒ title-like, long ⇒ not.
    assert search._freeform_is_title_like("headline_txt", "Field", avg_len=20.0) is True
    assert search._freeform_is_title_like("blurb", "Field", avg_len=300.0) is False
    # ambiguous + unmeasured ⇒ NOT tier-0 (still reachable via fields=all).
    assert search._freeform_is_title_like("blurb", "Field", avg_len=None) is False


def test_ambiguous_freeform_columns_skips_well_named() -> None:
    # rijks title/description both resolve by NAME → nothing to length-probe.
    assert search._ambiguous_freeform_columns(_ROLES) == []
    # An oddly-named freeform column is the only one that needs a probe.
    roles = {"filename": {"column": "filename", "label": "Filename"},
             "freeform": [{"column": "blurb", "label": "Field"}]}
    assert search._ambiguous_freeform_columns(roles) == ["blurb"]


def test_classify_default_tier_columns() -> None:
    scalar_cols = ["id", "filename", "title", "artist", "description"]
    cols = search._classify_columns(_ROLES, scalar_cols, all_fields=False, avg_lengths={}, url_cols=set())
    by_col = {c.column: c for c in cols}
    # Default (tier-0) = id + filename + title-like freeform + categoricals; NOT
    # description (a description-like freeform → catch-all only).
    assert set(by_col) == {"id", "filename", "title", "artist"}
    assert by_col["title"].role == "title"
    assert by_col["artist"].role == "categorical"
    assert "description" not in by_col
    # Categorical LEADS (lowest priority number) so a category hit can head the list.
    assert cols[0].role == "categorical"


def test_classify_all_tier_includes_every_scalar_column() -> None:
    scalar_cols = ["id", "filename", "title", "artist", "description"]
    cols = search._classify_columns(_ROLES, scalar_cols, all_fields=True, avg_lengths={}, url_cols=set())
    by_col = {c.column: c for c in cols}
    assert set(by_col) == {"id", "filename", "title", "artist", "description"}
    assert by_col["description"].role == "freeform"  # the catch-all field
    assert by_col["title"].role == "title"


def test_classify_images_only_dataset_has_id_and_filename() -> None:
    # roles=None (images-only / no manifest): search still works over id + filename.
    cols = search._classify_columns(None, ["id", "filename"], all_fields=False, avg_lengths={}, url_cols=set())
    assert {c.column for c in cols} == {"id", "filename"}


def test_classify_excludes_url_columns_from_both_tiers() -> None:
    # A url column holds LINK TARGETS, not search text — and being short they classify
    # title-like (tier-0), their `https` prefix matching nearly every row — so a column
    # named as one is dropped from EVERY tier, even though it ALSO carries a display role
    # (freeform OR categorical) that stores its value.
    #
    # `url_cols` is now passed IN: schema v2.9 moved the fact out of `column_roles` into
    # the presentation record (D-xvii), so the classifier is given the SET and
    # `_url_columns` owns where it comes from. Where it comes from is pinned separately in
    # test_presentation_serving.py (from `presentation.json`, and from a pre-2.9 manifest's
    # `column_roles.url`) — which is the half that would otherwise have gone silently
    # empty, because this dict is hand-built and never schema-validated.
    roles = {
        "filename": {"column": "filename", "label": "Filename"},
        "categorical": [
            {"column": "artist", "label": "Artist"},
            {"column": "collection_url", "label": "Collection"},  # categorical AND url
        ],
        "freeform": [
            {"column": "title", "label": "Title"},
            {"column": "source_url", "label": "Source"},  # freeform AND url
        ],
    }
    url_cols = {"source_url", "collection_url"}
    scalar_cols = ["id", "filename", "title", "artist", "source_url", "collection_url"]
    # source_url has SHORT values → the D-2 length rule would otherwise make it a tier-0
    # title (the exact leak this excludes); collection_url is categorical (always tier-0).
    avg_lengths = {"source_url": 20.0}

    # Default (tier-0): both url columns are gone despite one being (length-)title-like and
    # the other categorical; the rest of the default set is unchanged.
    default = search._classify_columns(
        roles, scalar_cols, all_fields=False, avg_lengths=avg_lengths, url_cols=url_cols
    )
    default_cols = {c.column for c in default}
    assert "source_url" not in default_cols
    assert "collection_url" not in default_cols
    assert default_cols == {"id", "filename", "title", "artist"}

    # all_fields (tier-2 catch-all): still excluded even though it scans EVERY other scalar.
    all_tier = search._classify_columns(
        roles, scalar_cols, all_fields=True, avg_lengths=avg_lengths, url_cols=url_cols
    )
    all_cols = {c.column for c in all_tier}
    assert "source_url" not in all_cols
    assert "collection_url" not in all_cols
    assert all_cols == {"id", "filename", "title", "artist"}


# ---------------------------------------------------------------------------
# The query engine (driven directly on a synthetic parquet)
# ---------------------------------------------------------------------------


def _run(tmp_path: Path, query: str, *, all_fields: bool, limit: int = 50):
    """Build the searchable dataset and run _run_search directly against it (no auth /
    no HTTP), returning (hits, capped)."""
    ds_dir = _build_searchable_dataset(tmp_path / "datasets")
    con = duckdb.connect()
    return search._run_search(
        con.cursor(), ds_dir / "metadata.parquet", ds_dir, query, all_fields, limit
    )


def test_search_categorical_value_snaps_and_groups(tmp_path) -> None:
    hits, capped = _run(tmp_path, "rembrandt", all_fields=False)
    assert capped is False
    # Both Rembrandt works match on the ARTIST categorical (the snap target).
    assert {h.id for h in hits} == {1, 2}
    for h in hits:
        assert h.role == "categorical"
        assert h.field == "artist"
        assert h.snippet == "Rembrandt van Rijn"


def test_search_title_matches_default_tier(tmp_path) -> None:
    hits, _ = _run(tmp_path, "night", all_fields=False)
    assert [h.id for h in hits] == [1]
    assert hits[0].role == "title" and hits[0].field == "title"
    assert hits[0].snippet == "The Night Watch"


def test_description_only_reachable_via_all_tier(tmp_path) -> None:
    # "militia" appears ONLY in a description → tier-0 (default) finds nothing...
    assert _run(tmp_path, "militia", all_fields=False)[0] == []
    # ...but the tier-2 catch-all (fields=all) reaches it (nothing is blocked).
    hits, _ = _run(tmp_path, "militia", all_fields=True)
    assert [h.id for h in hits] == [1]
    assert hits[0].field == "description" and hits[0].role == "freeform"


def test_filename_and_id_are_searchable(tmp_path) -> None:
    assert [h.id for h in _run(tmp_path, "SK-A-1935", all_fields=False)[0]] == [0]
    # The dense id is searchable (the "#4021" jump case) — id 3 matches "3".
    id_hits = _run(tmp_path, "3", all_fields=False)[0]
    assert any(h.id == 3 and h.role == "id" for h in id_hits)


def test_prefix_matches_rank_before_substring(tmp_path) -> None:
    # "self" is a prefix of "Self-portrait" (id 2) and a substring of nothing else
    # here; add a clearer case: "the" is a prefix of "The Night Watch".
    hits, _ = _run(tmp_path, "the", all_fields=False)
    assert hits[0].id == 1  # "The Night Watch" (prefix) leads


def test_like_metacharacter_is_literal(tmp_path) -> None:
    # "50%" must match the literal text, not wildcard-match everything.
    hits, _ = _run(tmp_path, "50%", all_fields=False)
    assert [h.id for h in hits] == [3]
    assert "50%" in hits[0].snippet


def test_result_cap_and_capped_flag(tmp_path) -> None:
    # A parquet where EVERY title contains "art" → more matches than the tiny cap.
    ds_dir = tmp_path / "datasets" / "big"
    ds_dir.mkdir(parents=True)
    n = 30
    papq.write_table(
        pa.table({"id": list(range(n)), "filename": [f"f{i}.jpg" for i in range(n)],
                  "title": [f"artwork {i}" for i in range(n)]}),
        str(ds_dir / "metadata.parquet"),
    )
    (ds_dir / "layout_manifest.json").write_text(
        json.dumps({"manifest_version": "2.1", "column_roles":
                    {"filename": {"column": "filename", "label": "File"},
                     "freeform": [{"column": "title", "label": "Title"}]}}),
        encoding="utf-8",
    )
    con = duckdb.connect()
    hits, capped = search._run_search(con.cursor(), ds_dir / "metadata.parquet", ds_dir, "art", False, 10)
    assert len(hits) == 10  # never exceeds the requested limit
    assert capped is True  # more matched than were returned → the "N of many" signal


def test_prefix_match_survives_the_cap_at_a_high_id(tmp_path) -> None:
    """The cap is applied by the DATABASE, so the prefix bias must live in the ORDER BY.
    A corpus of substring-only matches at LOW ids plus one PREFIX match at the HIGHEST
    id: ordering by id alone would cut the prefix match away with the LIMIT and the user
    would never see the best hit for the query."""
    ds_dir = tmp_path / "datasets" / "prefix"
    ds_dir.mkdir(parents=True)
    ids = list(range(30)) + [999]
    titles = [f"an essay on art number {i}" for i in range(30)] + ["art of the deal"]
    papq.write_table(
        pa.table({"id": ids, "filename": [f"f{i}.jpg" for i in ids], "title": titles}),
        str(ds_dir / "metadata.parquet"),
    )
    (ds_dir / "layout_manifest.json").write_text(
        json.dumps({"manifest_version": "2.1", "column_roles":
                    {"filename": {"column": "filename", "label": "File"},
                     "freeform": [{"column": "title", "label": "Title"}]}}),
        encoding="utf-8",
    )
    con = duckdb.connect()
    hits, capped = search._run_search(con.cursor(), ds_dir / "metadata.parquet", ds_dir, "art", False, 5)
    assert capped is True  # 31 matched, 5 returned
    assert hits[0].id == 999  # the prefix match LEADS despite having the highest id
    assert hits[0].snippet == "art of the deal"


def test_no_matches_is_empty_not_error(tmp_path) -> None:
    hits, capped = _run(tmp_path, "zzz-no-such-term", all_fields=True)
    assert hits == [] and capped is False


# ---------------------------------------------------------------------------
# SECURITY: second-order SQLi via a malicious parquet column name (T2-115)
# ---------------------------------------------------------------------------
# Search puts dynamic column names in TWO sinks — the SELECT list AND the WHERE
# ILIKE — so both must escape the identifier. A malicious title-like column name is
# selected into the search; these prove the payload stays an opaque, inert name.


def _malicious_parquet(parquet_path: Path, secret_path: Path) -> str:
    """A parquet whose THIRD column is NAMED with a SQLi payload that — unescaped —
    concatenates a secret file's contents (a read_text exfil subquery) into the query.
    The payload references the REAL id/filename columns so the naive positive control
    binds and leaks. Returns the payload column name."""
    payload = f"id\"||(SELECT content FROM read_text('{secret_path.as_posix()}'))||\"filename"
    papq.write_table(
        pa.table({"id": [0, 1], "filename": ["a.jpg", "b.jpg"], payload: ["benign0", "benign1"]}),
        str(parquet_path),
    )
    return payload


def test_search_malicious_column_name_is_inert(tmp_path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("LEAKED_SECRET_MARKER", encoding="utf-8")
    parquet_path = tmp_path / "metadata.parquet"
    payload = _malicious_parquet(parquet_path, secret)

    con = duckdb.connect()
    # Positive control: naive `f'"{col}"'` quoting REALLY executes the subquery.
    naive_select = ", ".join(f'"{c}"' for c in ["id", payload])
    leaked = con.execute(
        f"SELECT {naive_select} FROM read_parquet('{parquet_path.as_posix()}')"
    ).fetchall()
    assert any("LEAKED_SECRET_MARKER" in str(cell) for row in leaked for cell in row)

    # The fix: search escapes the identifier in BOTH its SELECT and WHERE sinks, so the
    # name is an opaque column and the subquery never runs. Drive _execute_search with
    # the payload column classified as a title-like freeform (as fields=all would).
    columns = [
        search.SearchColumn(column="id", role="id", label="Id", priority=6),
        search.SearchColumn(column=payload, role="title", label="Title", priority=1),
    ]
    hits, _ = search._execute_search(con.cursor(), parquet_path, columns, "benign", 50)

    assert {h.id for h in hits} == {0, 1}
    joined = " ".join(h.snippet for h in hits)
    assert "LEAKED_SECRET_MARKER" not in joined  # the subquery never executed
    assert "benign" in joined  # the opaque column's real value came back


# ---------------------------------------------------------------------------
# The route: authz matrix + validation (real request path)
# ---------------------------------------------------------------------------


def test_route_owner_search_finds_hits(owner_auth, client) -> None:
    resp = client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=rembrandt", headers=owner_auth)
    hits = _hits(resp)
    assert {h["id"] for h in hits} == {1, 2}
    assert resp.json()["query"] == "rembrandt"
    assert resp.json()["capped"] is False


def test_route_fields_all_reaches_description(owner_auth, client) -> None:
    default = client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=militia", headers=owner_auth)
    assert _hits(default) == []  # description not in the default tier
    allf = client.get(
        f"/api/datasets/{SEARCHABLE_DS}/search?q=militia&fields=all", headers=owner_auth
    )
    assert [h["id"] for h in _hits(allf)] == [1]


def test_route_limit_is_clamped(owner_auth, client) -> None:
    # An over-cap limit is clamped to SEARCH_MAX_RESULTS (never an unbounded payload).
    resp = client.get(
        f"/api/datasets/{SEARCHABLE_DS}/search?q=a&fields=all&limit=100000", headers=owner_auth
    )
    assert len(_hits(resp)) <= search.SEARCH_MAX_RESULTS


def test_route_empty_query_is_400(owner_auth, client) -> None:
    assert client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=", headers=owner_auth).status_code == 400
    assert client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=%20%20", headers=owner_auth).status_code == 400


def test_route_bad_fields_is_400(owner_auth, client) -> None:
    resp = client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=x&fields=bogus", headers=owner_auth)
    assert resp.status_code == 400


def test_route_query_too_long_is_400(owner_auth, client) -> None:
    long_q = "x" * (search.SEARCH_MAX_QUERY_LEN + 1)
    resp = client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q={long_q}", headers=owner_auth)
    assert resp.status_code == 400


def test_route_unknown_dataset_is_404(owner_auth, client) -> None:
    assert client.get("/api/datasets/does-not-exist/search?q=x", headers=owner_auth).status_code == 404


# --- D-34 authz matrix (mirrors the read-route matrix) ---------------------


def test_route_anonymous_private_is_404(owner_auth, client) -> None:
    """An anonymous caller is denied a PRIVATE dataset's search with the same 404 as a
    missing dataset (non-disclosure) — may_read runs before any query."""
    assert client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=rembrandt").status_code == 404


def test_route_non_owner_private_is_404(owner_auth, client, app_db) -> None:
    assert client.post("/api/auth/signup", json=_BOB).status_code == 200
    bob = client.post("/api/auth/login", json={"username": "bob", "password": "s3cretpw"}).json()
    headers = {"Authorization": f"Bearer {bob['access_token']}"}
    assert client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=rembrandt", headers=headers).status_code == 404


def test_route_public_dataset_search_is_anonymous(owner_auth, client, app_db) -> None:
    """A PUBLIC dataset's search serves anonymously (the login-less showcase)."""
    _set_visibility(app_db, SEARCHABLE_DS, "public")
    resp = client.get(f"/api/datasets/{SEARCHABLE_DS}/search?q=rembrandt")  # no auth
    assert {h["id"] for h in _hits(resp)} == {1, 2}


def test_route_invalid_bearer_is_401(owner_auth, client) -> None:
    """A PRESENTED-but-invalid bearer 401s (get_optional_user), never silent anonymity."""
    resp = client.get(
        f"/api/datasets/{SEARCHABLE_DS}/search?q=x",
        headers={"Authorization": "Bearer not-a-valid-token"},
    )
    assert resp.status_code == 401
