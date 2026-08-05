"""Tier-1 tests for the API read/serve surface (seam 10b, brief §3).

Builds a per-test DATA_ROOT whose `datasets/` subtree (decision D-30) exposes the
committed golden fixtures (both the metadata-present and the images-only one) and
a throwaway APP_STATE_DB, exercises the real auth path for a bearer token, and
seeds dataset ownership through app-state (the user is created first —
record_dataset_owner's FK requires it). The golden fixtures are architecture-owned
and never moved; each is COPIED under `datasets/` per test — a symlink would be
followed back out of the jail by `resolve_under`'s `.resolve()` and correctly
rejected. The contract/golden/smoke nets live elsewhere.
"""

from __future__ import annotations

import ast
import asyncio
import json
import shutil
import time
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as papq
import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from api import appstate, db
from api.routers import metadata

# Repo-root tests/fixtures/ (this file is packages/api/tests/test_read_serve.py).
# v2 fixtures (decision D-33): the PMTiles spatial-tile-pyramid manifests
# (manifest_version "2.1", per-layout `pyramid`, optional `detail`). The v1.x
# `golden_dataset*` fixtures stay committed for the still-v1 frontend tests until
# the frontend seam migrates.
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
WITH_META = "golden_dataset_v2"
IMAGES_ONLY = "golden_dataset_images_only_v2"

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


def _make_data_root(tmp_path: Path, *fixtures: str) -> Path:
    """Build a DATA_ROOT whose `datasets/` subtree (decision D-30) exposes the named
    architecture-owned golden fixtures: each dataset is COPIED to
    `{DATA_ROOT}/datasets/{name}` so the read path (which now anchors at
    `db.datasets_root()`) discovers it exactly as a worker-written tree. A copy, not
    a symlink — `db.resolve_under` calls `.resolve()`, which would follow a symlink
    back out of the jail and (correctly) reject it. The fixtures are tiny (~80 KiB)
    and never mutated; the committed originals under tests/fixtures/ stay untouched."""
    data_root = tmp_path / "data"
    (data_root / "datasets").mkdir(parents=True)
    for name in fixtures:
        shutil.copytree(FIXTURES / name, data_root / "datasets" / name)
    return data_root


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    """Record dataset ownership in the app-state DB the running app reads. Uses a
    separate engine over the same SQLite file (all within one asyncio.run loop) so
    it never shares a connection across event loops with the app's engine."""

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    """Fresh per-test app-state DB + a DATA_ROOT whose datasets/ subtree (D-30)
    surfaces the read-only golden fixtures. Returns the app-state DB path so tests
    can seed ownership into it."""
    db_path = tmp_path / "appstate.db"
    data_root = _make_data_root(tmp_path, WITH_META, IMAGES_ONLY)
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


@pytest.fixture
def auth(client, app_db) -> dict[str, str]:
    """Sign up + log in 'alice', AND seed her as owner of BOTH golden fixtures so the
    D-34 read model (owner-or-public) authorizes her reads. Tests that need a NON-owner
    or anonymous caller use the raw `client` (no token)."""
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    _seed_owner(app_db, WITH_META, "alice")
    _seed_owner(app_db, IMAGES_ONLY, "alice")
    return {"Authorization": f"Bearer {token}"}


# --- datasets --------------------------------------------------------------


def test_list_and_get_dataset(client, auth, app_db) -> None:
    # alice exists (signup ran in the auth fixture); seed her as owner.
    _seed_owner(app_db, WITH_META, "alice")

    listed = client.get("/api/datasets", headers=auth)
    assert listed.status_code == 200
    ids = {d["dataset_id"] for d in listed.json()["datasets"]}
    assert {WITH_META, IMAGES_ONLY} <= ids

    one = client.get(f"/api/datasets/{WITH_META}", headers=auth)
    assert one.status_code == 200
    body = one.json()
    assert body["dataset_id"] == WITH_META
    assert body["dataset_version"] == 1
    assert body["image_count"] == 10
    assert body["layout_ids"] == ["grid"]
    assert body["owner"] == "alice"  # resolved from app-state, not the manifest


def test_get_dataset_images_only(client, auth) -> None:
    # An images-only dataset (no column_roles/source in the manifest) the caller OWNS
    # reads fine — the summary must not crash on the absent metadata. alice owns it via
    # the `auth` fixture (D-34: a caller reads what they own).
    body = client.get(f"/api/datasets/{IMAGES_ONLY}", headers=auth).json()
    assert body["dataset_id"] == IMAGES_ONLY
    assert body["image_count"] == 10
    assert body["layout_ids"] == ["grid"]
    assert body["owner"] == "alice"  # resolved from app-state (owner seeded by `auth`)


def test_get_dataset_missing_is_404(client, auth) -> None:
    assert client.get("/api/datasets/does-not-exist", headers=auth).status_code == 404


# --- layouts / manifest ----------------------------------------------------


def test_get_layout_manifest_verbatim_both_fixtures(client, auth) -> None:
    for ds in (WITH_META, IMAGES_ONLY):
        resp = client.get(f"/api/datasets/{ds}/layouts/grid", headers=auth)
        assert resp.status_code == 200
        on_disk = json.loads(
            (FIXTURES / ds / "layout_manifest.json").read_text(encoding="utf-8")
        )
        assert resp.json() == on_disk
    # The images-only manifest legitimately has no column_roles (D-25).
    images_only = client.get(
        f"/api/datasets/{IMAGES_ONLY}/layouts/grid", headers=auth
    ).json()
    assert "column_roles" not in images_only


def test_list_layouts(client, auth) -> None:
    resp = client.get(f"/api/datasets/{WITH_META}/layouts", headers=auth)
    assert resp.status_code == 200
    layouts = resp.json()["layouts"]
    assert [layout["layout_id"] for layout in layouts] == ["grid"]
    assert layouts[0]["type"] == "grid"


def test_get_layout_manifest_unknown_layout_is_404(client, auth) -> None:
    assert (
        client.get(f"/api/datasets/{WITH_META}/layouts/nope", headers=auth).status_code
        == 404
    )


# --- metadata --------------------------------------------------------------


def test_get_metadata_scalar_fields_no_tags(client, auth) -> None:
    resp = client.get(f"/api/datasets/{WITH_META}/metadata?ids=0,1,2", headers=auth)
    assert resp.status_code == 200
    rows = resp.json()["rows"]
    assert {row["id"] for row in rows} == {0, 1, 2}
    for row in rows:
        assert "filename" in row["fields"]  # always present (D-25)
        assert "tags" not in row["fields"]  # tag list<string> excluded (D-21)


def test_get_metadata_images_only_has_filename(client, auth) -> None:
    resp = client.get(f"/api/datasets/{IMAGES_ONLY}/metadata?ids=0,1", headers=auth)
    assert resp.status_code == 200
    for row in resp.json()["rows"]:
        assert "filename" in row["fields"]


def test_get_metadata_rejects_too_many_and_malformed(client, auth) -> None:
    too_many = ",".join(str(i) for i in range(251))
    assert (
        client.get(
            f"/api/datasets/{WITH_META}/metadata?ids={too_many}", headers=auth
        ).status_code
        == 400
    )
    assert (
        client.get(
            f"/api/datasets/{WITH_META}/metadata?ids=abc", headers=auth
        ).status_code
        == 400
    )


# --- pyramid (PMTiles range-serving) ---------------------------------------


def test_get_pyramid_returns_whole_container_bytes(client, auth) -> None:
    """The PMTiles route serves the whole layout container; Starlette advertises
    byte-range support so the frontend's PMTiles client can range-request tiles."""
    resp = client.get(f"/api/datasets/{WITH_META}/pyramid/grid.pmtiles", headers=auth)
    assert resp.status_code == 200
    on_disk = (FIXTURES / WITH_META / "tiles" / "grid" / "grid_v1.pmtiles").read_bytes()
    assert resp.content == on_disk  # served verbatim, no transformation
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert resp.headers["accept-ranges"] == "bytes"


def test_get_pyramid_range_request_returns_206_correct_bytes(client, auth) -> None:
    """A Range request returns 206 Partial Content with exactly the requested bytes
    (the PMTiles client seeks into the container this way)."""
    on_disk = (FIXTURES / WITH_META / "tiles" / "grid" / "grid_v1.pmtiles").read_bytes()
    resp = client.get(
        f"/api/datasets/{WITH_META}/pyramid/grid.pmtiles",
        headers={**auth, "Range": "bytes=0-15"},
    )
    assert resp.status_code == 206
    assert resp.content == on_disk[:16]  # bytes 0..15 inclusive
    assert resp.headers["content-range"] == f"bytes 0-15/{len(on_disk)}"


def test_get_pyramid_images_only_fixture_serves(client, auth) -> None:
    """The images-only fixture (no detail/tags) still serves its pyramid."""
    resp = client.get(f"/api/datasets/{IMAGES_ONLY}/pyramid/grid.pmtiles", headers=auth)
    assert resp.status_code == 200
    assert len(resp.content) > 0


def test_get_pyramid_unknown_layout_is_404(client, auth) -> None:
    assert (
        client.get(
            f"/api/datasets/{WITH_META}/pyramid/nope.pmtiles", headers=auth
        ).status_code
        == 404
    )


def test_get_pyramid_unknown_dataset_is_404(client, auth) -> None:
    assert (
        client.get(
            "/api/datasets/does-not-exist/pyramid/grid.pmtiles", headers=auth
        ).status_code
        == 404
    )


# --- library-card cover (T2-55) --------------------------------------------

# A tiny valid WebP (the header + a 1x1 lossy frame) — enough to stand in for the
# pipeline-written cover.webp without importing pyvips into the lean API image. Its
# exact bytes don't matter to the API (it serves the file verbatim); only that the
# route returns them with the right media type + weak cache.
_TINY_WEBP = bytes.fromhex(
    "524946461a000000574542505650384c0d0000002f00000010071011118888"
    "0800"
)


def _write_cover(tmp_path: Path, ds_id: str, data: bytes = _TINY_WEBP) -> Path:
    """Drop a cover.webp into the copied dataset under this test's DATA_ROOT (the
    `app_db` fixture copies the golden fixtures to `{tmp_path}/data/datasets/{ds}`).
    The minimal golden fixtures are baked without a cover, so writing one here is how
    the cover-present path is exercised; its ABSENCE stays the 404 fixture."""
    cover = tmp_path / "data" / "datasets" / ds_id / _read_serve_cover_name()
    cover.write_bytes(data)
    return cover


def _read_serve_cover_name() -> str:
    from api.routers.tiles import _COVER_NAME

    return _COVER_NAME


def test_get_cover_returns_webp_bytes_with_weak_cache(client, auth, tmp_path) -> None:
    """The cover route serves the unversioned cover.webp verbatim, image/webp, on the
    weak revalidated cache (its URL is unversioned, so a re-ingest reuses it with new
    bytes) with an ETag — NOT `immutable`."""
    cover = _write_cover(tmp_path, WITH_META)
    resp = client.get(f"/api/datasets/{WITH_META}/cover", headers=auth)
    assert resp.status_code == 200
    assert resp.content == cover.read_bytes()  # served verbatim, no transformation
    assert resp.headers["content-type"] == "image/webp"
    assert resp.headers["cache-control"] == "public, max-age=300, must-revalidate"
    assert "immutable" not in resp.headers["cache-control"]
    assert resp.headers.get("etag")


def test_get_cover_absent_is_404(client, auth) -> None:
    """The minimal golden fixture is baked WITHOUT a cover (the graceful-absence proof):
    the route 404s and the card falls back to its flat surface block."""
    assert client.get(f"/api/datasets/{WITH_META}/cover", headers=auth).status_code == 404


def test_get_cover_unknown_dataset_is_404(client, auth) -> None:
    assert client.get("/api/datasets/does-not-exist/cover", headers=auth).status_code == 404


def test_get_cover_anonymous_private_is_404(client, tmp_path) -> None:
    """D-34: an anonymous request to a PRIVATE dataset's cover 404s. get_optional_user
    never 401s; may_read denies (WITH_META has no owner seeded here → private +
    ownerless) → the SAME 404 as a missing dataset (non-disclosure), even though the
    cover file exists — the gate runs before the file check."""
    _write_cover(tmp_path, WITH_META)
    assert client.get(f"/api/datasets/{WITH_META}/cover").status_code == 404


def test_cover_path_jail_rejects_traversal() -> None:
    """The cover route composes its (constant) filename through the shared path-jail, so
    the serving path can never escape the dataset dir."""
    with pytest.raises(HTTPException) as exc:
        db.resolve_under(FIXTURES / WITH_META, "..", "..", "..", "etc", "cover.webp")
    assert 400 <= exc.value.status_code < 500


# --- detail tier (click-through originals) ---------------------------------


def test_get_detail_returns_image_bytes(client, auth) -> None:
    """The detail route serves an original by DENSE cell id from detail.path_prefix."""
    resp = client.get(f"/api/datasets/{WITH_META}/detail/0.webp", headers=auth)
    assert resp.status_code == 200
    on_disk = (FIXTURES / WITH_META / "detail" / "0.webp").read_bytes()
    assert resp.content == on_disk
    assert resp.headers["content-type"] == "image/webp"
    # The detail URL is NOT version-embedded, so it must NOT claim `immutable`
    # (a re-ingest reuses the URL with new bytes); a short revalidated cache instead,
    # with an ETag from FileResponse so a stale client revalidates with a 304.
    assert resp.headers["cache-control"] == "public, max-age=300, must-revalidate"
    assert "immutable" not in resp.headers["cache-control"]
    assert resp.headers.get("etag")


def test_get_detail_missing_cell_is_404(client, auth) -> None:
    """A cell id with no baked original (e.g. beyond image_count) is a 404."""
    assert (
        client.get(
            f"/api/datasets/{WITH_META}/detail/9999.webp", headers=auth
        ).status_code
        == 404
    )


def test_get_detail_absent_tier_is_404(client, auth) -> None:
    """The images-only fixture declares no `detail` block: the detail route 404s
    (the detail tier is optional, decision D-33)."""
    assert (
        client.get(
            f"/api/datasets/{IMAGES_ONLY}/detail/0.webp", headers=auth
        ).status_code
        == 404
    )


def test_path_jail_rejects_traversal() -> None:
    """The shared path-jail refuses a segment that escapes the dataset dir — the
    PMTiles + detail routes both compose manifest-authored prefixes through it."""
    with pytest.raises(HTTPException) as exc:
        db.resolve_under(FIXTURES / WITH_META, "tiles", "..", "..", "..", "etc")
    assert 400 <= exc.value.status_code < 500
    with pytest.raises(HTTPException) as exc2:
        db.resolve_under(FIXTURES / WITH_META, "detail", "..", "..", "..", "etc")
    assert 400 <= exc2.value.status_code < 500


# --- detail tier: version-stamped immutable route (T2-46) -------------------

_VSTAMP_DS = "ds_vstamp"


def _write_version_stamped_dataset(data_root: Path) -> Path:
    """Build a small dataset under DATA_ROOT/datasets whose detail tier is
    VERSION-STAMPED (detail/v1/0.webp) with the manifest's `detail.path_prefix`
    pointing at it (T2-46) — a real `run_ingest` shape without needing the pyvips
    pipeline in the lean API image. Built from the golden fixture so the pyramid +
    tags are real; only the detail tier is relocated under a version dir."""
    src = FIXTURES / WITH_META
    ds_dir = data_root / "datasets" / _VSTAMP_DS
    shutil.copytree(src, ds_dir)
    # Relocate the detail originals under the version dir and repoint the manifest.
    version_dir = ds_dir / "detail" / "v1"
    version_dir.mkdir(parents=True)
    for webp in list((ds_dir / "detail").glob("*.webp")):
        webp.rename(version_dir / webp.name)
    manifest = json.loads((ds_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    manifest["dataset_id"] = _VSTAMP_DS
    for layout in manifest["layouts"]:
        if isinstance(layout.get("detail"), dict):
            layout["detail"]["path_prefix"] = "detail/v1/"
    (ds_dir / "layout_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return version_dir


def test_get_detail_versioned_serves_immutable(client, auth, app_db, tmp_path) -> None:
    """The version-stamped URL /detail/v{version}/{id}.{ext} serves the original with
    a full `immutable` cache (T2-46) — honest because the version is IN the URL."""
    version_dir = _write_version_stamped_dataset(tmp_path / "data")
    _seed_owner(app_db, _VSTAMP_DS, "alice")  # D-34: alice owns it → may read
    resp = client.get(f"/api/datasets/{_VSTAMP_DS}/detail/v1/0.webp", headers=auth)
    assert resp.status_code == 200
    assert resp.content == (version_dir / "0.webp").read_bytes()
    assert resp.headers["content-type"] == "image/webp"
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_get_detail_unversioned_still_resolves_versioned_prefix(client, auth, app_db, tmp_path) -> None:
    """The un-versioned /detail/{id}.{ext} route keeps working after version-stamping —
    it resolves the manifest's CURRENT `path_prefix` (detail/v1/) — but stays on the
    WEAK cache (its URL is unversioned, so a re-ingest reuses it with new bytes)."""
    version_dir = _write_version_stamped_dataset(tmp_path / "data")
    _seed_owner(app_db, _VSTAMP_DS, "alice")  # D-34: alice owns it → may read
    resp = client.get(f"/api/datasets/{_VSTAMP_DS}/detail/0.webp", headers=auth)
    assert resp.status_code == 200
    assert resp.content == (version_dir / "0.webp").read_bytes()
    assert resp.headers["cache-control"] == "public, max-age=300, must-revalidate"
    assert "immutable" not in resp.headers["cache-control"]


def test_get_detail_versioned_wrong_version_is_404(client, auth, app_db, tmp_path) -> None:
    """A version segment that does not name the tier the manifest's `detail.path_prefix`
    points at is a 404 (a swept/stale version is never served by the dev route). alice
    owns the dataset (D-34), so this proves the version-mismatch 404 — not an authz
    404. Here the prefix is detail/v1/, so v2 is not live."""
    _write_version_stamped_dataset(tmp_path / "data")
    _seed_owner(app_db, _VSTAMP_DS, "alice")
    assert (
        client.get(
            f"/api/datasets/{_VSTAMP_DS}/detail/v2/0.webp", headers=auth
        ).status_code
        == 404
    )


def test_get_detail_versioned_serves_a_carried_forward_prefix(
    client, auth, app_db, tmp_path
) -> None:
    """T2-178: the route gates on `detail.path_prefix`'s version, NOT `dataset_version`.

    The two diverge whenever a bake KEEPS a tier it did not create: `add-layouts`
    carries the committed prefix forward while bumping `dataset_version` (pinned
    pipeline-side in `test_add_layouts_appends_and_carries_forward`), and `ingest
    --detail-tier retain` (T2-175 / #210) does the same by design. This reproduces that
    shape — prefix `detail/v1/`, `dataset_version` 2 — and it is exactly what the
    frontend requests, because `client.detailUrl` composes the URL FROM the prefix.

    Before the fix this 404'd: the click-through lightbox was dead on every dataset
    that had ever had a layout added, while the bytes sat there resolvable through the
    very prefix the route ignored."""
    version_dir = _write_version_stamped_dataset(tmp_path / "data")
    ds_dir = tmp_path / "data" / "datasets" / _VSTAMP_DS
    manifest_path = ds_dir / "layout_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["dataset_version"] = 2  # bumped; the tier below stays at v1
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    _seed_owner(app_db, _VSTAMP_DS, "alice")

    resp = client.get(f"/api/datasets/{_VSTAMP_DS}/detail/v1/0.webp", headers=auth)
    assert resp.status_code == 200, "the LIVE tier (v1) must serve even at dataset_version 2"
    assert resp.content == (version_dir / "0.webp").read_bytes()
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"

    # ...and the dataset_version is still not a servable tier: v2 does not exist.
    assert (
        client.get(
            f"/api/datasets/{_VSTAMP_DS}/detail/v2/0.webp", headers=auth
        ).status_code
        == 404
    ), "gating moved to the prefix; it did not become permissive"


def test_get_detail_versioned_flat_prefix_falls_back_to_dataset_version(
    client, auth
) -> None:
    """A pre-T2-46 flat `detail/` prefix carries no version stamp, so the versioned
    route falls back to `dataset_version` (T2-178 kept this backward-compat path). The
    golden fixture has `path_prefix: "detail/"` at `dataset_version` 1, so `/detail/v1/`
    serves (200) and any other version 404s. This exercises the `live_version is None`
    fallback branch that `_write_version_stamped_dataset` (always `detail/v1/`) never
    reaches. The v2 request is DISCRIMINATING: without the gate it would resolve
    `detail/0.webp` through the prefix and 200, so the 404 proves the gate did the work."""
    ok = client.get(f"/api/datasets/{WITH_META}/detail/v1/0.webp", headers=auth)
    assert ok.status_code == 200
    assert ok.content == (FIXTURES / WITH_META / "detail" / "0.webp").read_bytes()
    assert ok.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert (
        client.get(
            f"/api/datasets/{WITH_META}/detail/v2/0.webp", headers=auth
        ).status_code
        == 404
    ), "flat prefix falls back to dataset_version (1); v2 does not match, so 404"


def test_get_detail_versioned_absent_tier_is_404(client, auth) -> None:
    """The images-only fixture declares no detail block: the versioned route 404s too
    (the detail tier is optional, decision D-33)."""
    assert (
        client.get(
            f"/api/datasets/{IMAGES_ONLY}/detail/v1/0.webp", headers=auth
        ).status_code
        == 404
    )


# --- auth gate -------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        f"/api/datasets/{WITH_META}",
        f"/api/datasets/{WITH_META}/layouts",
        f"/api/datasets/{WITH_META}/layouts/grid",
        f"/api/datasets/{WITH_META}/metadata?ids=0",
        f"/api/datasets/{WITH_META}/pyramid/grid.pmtiles",
        f"/api/datasets/{WITH_META}/detail/0.webp",
        f"/api/datasets/{WITH_META}/cover",
    ],
)
def test_per_dataset_read_routes_deny_anonymous_private_404(client, path) -> None:
    # D-34: an anonymous caller is DENIED a PRIVATE dataset (WITH_META has no owner
    # seeded here → private + ownerless) with a 404 — get_optional_user never 401s;
    # may_read denies → the SAME 404 as a missing dataset (non-disclosure). The gate
    # runs before file existence, so even the cover route (no cover file on the minimal
    # fixture) 404s the same way.
    assert client.get(path).status_code == 404


def test_list_datasets_anonymous_returns_public_only_empty(client) -> None:
    """D-34: GET /api/datasets is the one read route that answers an anonymous caller
    200 (never 404) — with PUBLIC datasets only. With no public dataset seeded the
    golden fixtures (private/unowned) are all omitted, so the list is empty; the
    login-less showcase surfaces the curated public datasets here."""
    resp = client.get("/api/datasets")
    assert resp.status_code == 200
    assert resp.json()["datasets"] == []


# --- regression: temporal metadata column (would 500 before the fix) -------


def test_query_metadata_temporal_column_is_iso_string(tmp_path) -> None:
    """A TIMESTAMP column (how the pipeline stores an iso8601 datetime role —
    ingest.py `_enrichment_select`) is returned as an ISO-8601 string, fitting the
    scalar `MetadataRow.fields` union. Before the fix DuckDB's `datetime` object
    failed response-model validation and 500'd the request. The golden fixtures
    carry only id/filename/tags, so this guards the temporal path directly."""
    parquet_path = tmp_path / "metadata.parquet"
    con = duckdb.connect()
    con.execute(
        "COPY (SELECT * FROM (VALUES "
        "(0, TIMESTAMP '2026-01-02 03:04:05', 'img_000.webp'), "
        "(1, TIMESTAMP '2026-02-03 04:05:06', 'img_001.webp')"
        ") AS t(id, captured_at, filename)) "
        f"TO '{parquet_path.as_posix()}' (FORMAT PARQUET)"
    )

    rows = metadata._query_metadata(con.cursor(), parquet_path, [0, 1])

    assert {row.id for row in rows} == {0, 1}
    captured = rows[0].fields["captured_at"]  # rows are ORDER BY id, so id == 0
    assert isinstance(captured, str)
    assert datetime.fromisoformat(captured) == datetime(2026, 1, 2, 3, 4, 5)
    assert isinstance(rows[0].fields["filename"], str)


# --- SECURITY: second-order SQLi via a malicious parquet column name (T2-115) --
# A dataset's scalar column names come from the file's own schema, but those names
# ORIGINATE in user-supplied CSV headers (ingest stores each enrichment column under
# its raw header, no charset validation) — so a header can smuggle a SQL-injection
# payload into GET /metadata's SELECT list. These prove the identifier is escaped
# (embedded quotes doubled) so the payload stays an opaque column name, never
# executed. Found + PoC-confirmed at the pre-release security scan (2026-07-13).


def _malicious_metadata_parquet(parquet_path: Path, secret_path: Path) -> str:
    """Write a metadata.parquet whose id/filename are normal but whose THIRD column is
    NAMED with a SQLi payload that — unescaped — concatenates the contents of
    `secret_path` (a `read_text` file-exfil subquery) into every row. Returns the
    payload column name. Built via pyarrow so the exact name lands in the schema with
    no SQL quoting of our own (independent of the code under test)."""
    payload = (
        f"id\"||(SELECT content FROM read_text('{secret_path.as_posix()}'))||\"filename"
    )
    table = pa.table(
        {
            "id": [0, 1],
            "filename": ["img_000.webp", "img_001.webp"],
            payload: ["benign0", "benign1"],
        }
    )
    papq.write_table(table, str(parquet_path))
    return payload


def test_sql_ident_doubles_embedded_quotes_and_round_trips() -> None:
    """The identifier quoter wraps a name in double-quotes and DOUBLES any embedded
    double-quote, so an attacker-chosen column name cannot terminate the identifier and
    inject SQL. A normal name round-trips unchanged inside the quotes."""
    assert metadata._sql_ident("captured_at") == '"captured_at"'
    assert metadata._sql_ident('a"b') == '"a""b"'
    payload = 'x"||(SELECT 1)||"x'
    assert metadata._sql_ident(payload) == '"x""||(SELECT 1)||""x"'
    # every double-quote inside the outer pair is doubled → no lone quote can close it
    inner = metadata._sql_ident(payload)[1:-1]
    assert '"' not in inner.replace('""', "")


def test_query_metadata_malicious_column_name_is_inert(tmp_path) -> None:
    """The PoC-as-test: drive the REAL `_query_metadata` against a parquet whose column
    NAME is a file-read SQLi payload. A positive control first proves the payload is a
    genuine exploit under the OLD naive `f'"{col}"'` quoting (it leaks the file), then
    the fixed path returns the name as an opaque field and the file content NEVER
    appears — the embedded subquery did not execute."""
    secret = tmp_path / "secret.txt"
    secret.write_text("LEAKED_SECRET_MARKER", encoding="utf-8")
    parquet_path = tmp_path / "metadata.parquet"
    payload = _malicious_metadata_parquet(parquet_path, secret)

    con = duckdb.connect()
    # Positive control: the OLD naive identifier quoting REALLY executes the subquery.
    naive_select = ", ".join(f'"{c}"' for c in ["id", payload])
    naive = con.execute(
        f"SELECT {naive_select} FROM read_parquet('{parquet_path.as_posix()}')"
    ).fetchall()
    assert any("LEAKED_SECRET_MARKER" in str(cell) for row in naive for cell in row)

    # The fix: `_query_metadata` escapes the identifier, so the name is opaque + inert.
    rows = metadata._query_metadata(con.cursor(), parquet_path, [0, 1])

    assert {row.id for row in rows} == {0, 1}
    leaked = " ".join(str(v) for row in rows for v in row.fields.values())
    assert "LEAKED_SECRET_MARKER" not in leaked  # the subquery never ran
    assert rows[0].fields[payload] == "benign0"  # opaque column value returned


def test_metadata_route_treats_malicious_column_name_as_opaque(
    tmp_path, monkeypatch
) -> None:
    """End-to-end through the real GET /metadata route (auth + request cursor + response
    model): the malicious column name is returned as an opaque field key and the
    would-be-leaked file marker is absent from the response body. The app's DuckDB
    connection is NOT locked down (enable_external_access stays on so read_parquet
    works — see db.open_connection), so absence of the marker proves the escaping, not a
    sandboxed connection."""
    data_root = tmp_path / "data"
    ds_dir = data_root / "datasets" / "evil_ds"  # D-30: trees live under datasets/
    ds_dir.mkdir(parents=True)
    secret = tmp_path / "secret.txt"
    secret.write_text("LEAKED_SECRET_MARKER", encoding="utf-8")
    payload = _malicious_metadata_parquet(ds_dir / "metadata.parquet", secret)
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from api.main import create_app

    with TestClient(create_app()) as test_client:
        assert test_client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
        # D-34: alice must own evil_ds to read its metadata (she is the attacker in
        # this PoC — an authenticated user reading their OWN malicious dataset).
        _seed_owner(tmp_path / "appstate.db", "evil_ds", _SIGNUP["username"])
        token = test_client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
        resp = test_client.get(
            "/api/datasets/evil_ds/metadata?ids=0,1",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert resp.status_code == 200
    assert "LEAKED_SECRET_MARKER" not in resp.text  # the subquery never executed
    rows = resp.json()["rows"]
    assert {r["id"] for r in rows} == {0, 1}
    assert rows[0]["fields"][payload] == "benign0"  # opaque field key + stored value


def test_no_naive_double_quoted_identifier_fstring_in_api_source() -> None:
    """Guard (T2-115): keep the second-order SQLi from creeping back. The app's DuckDB
    connection is deliberately un-sandboxed (see `db.open_connection`), so escaping
    every dynamic SQL identifier through `_sql_ident` — which DOUBLES embedded quotes —
    is load-bearing: a single naive `f'"{col}"'` sink re-opens arbitrary server-file
    read / cross-tenant leak. This fails if any source file under `packages/api/api`
    builds a SQL identifier by wrapping an f-string interpolation directly in double
    quotes.

    It walks the AST, not raw text, so the antipattern quoted inside a docstring or
    comment — e.g. `_sql_ident`'s own explanation of the bug — does NOT trip it: only a
    real f-string node whose `{...}` is flanked by a `"`-ending literal on the left and
    a `"`-starting literal on the right (f-string *delimiters* are not part of those
    literals, so `f"{x}"` is unwrapped and safe). Route such names through `_sql_ident`."""

    def _wrapped_ident_linenos(source: str) -> list[int]:
        """Line numbers of f-strings that wrap an interpolation directly in double
        quotes (`..."{expr}"...`) — the naive-identifier antipattern."""
        hits: list[int] = []
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, ast.JoinedStr):
                continue
            values = node.values
            for i, part in enumerate(values):
                if not isinstance(part, ast.FormattedValue):
                    continue
                before = values[i - 1] if i > 0 else None
                after = values[i + 1] if i + 1 < len(values) else None
                if (
                    isinstance(before, ast.Constant)
                    and isinstance(before.value, str)
                    and before.value.endswith('"')
                    and isinstance(after, ast.Constant)
                    and isinstance(after.value, str)
                    and after.value.startswith('"')
                ):
                    hits.append(node.lineno)
        return hits

    # Self-check the detector so it cannot silently rot into a no-op: it MUST fire on
    # the historical bug's exact shape and stay quiet on benign f-strings.
    assert _wrapped_ident_linenos('''j = ", ".join(f'"{c}"' for c in cols)''')  # caught
    assert not _wrapped_ident_linenos('q = f"SELECT {cols} FROM {t}"')  # safe interpolation
    assert not _wrapped_ident_linenos('h = f"{user} <{email}>"')  # delimiter-hugged, unwrapped

    api_root = Path(metadata.__file__).resolve().parents[1]  # packages/api/api
    assert api_root.name == "api" and (api_root / "routers").is_dir()  # scan-root sanity

    offenders: list[str] = []
    for py in sorted(api_root.rglob("*.py")):
        for lineno in _wrapped_ident_linenos(py.read_text(encoding="utf-8")):
            offenders.append(f"{py.relative_to(api_root.parent)}:{lineno}")

    assert not offenders, (
        "Naive double-quoted-identifier f-string(s) under packages/api/api — a SQL "
        "identifier built without doubling embedded quotes (the T2-115 second-order "
        "SQLi antipattern). Route the name through `_sql_ident`:\n  " + "\n  ".join(offenders)
    )


# --- regression: one bad dataset must not 500 the whole listing ------------


def test_list_datasets_skips_unreadable_dataset(tmp_path, monkeypatch) -> None:
    """A dataset whose manifest is an unsupported major version is skipped, not
    fatal: the listing still returns 200 with the good datasets."""
    data_root = tmp_path / "data"
    datasets = data_root / "datasets"  # D-30: dataset trees live under datasets/
    datasets.mkdir(parents=True)
    # A good dataset (images-only needs no owner seeding)...
    shutil.copytree(FIXTURES / IMAGES_ONLY, datasets / IMAGES_ONLY)
    # ...and a dataset dir whose manifest is a future, unsupported major version.
    # ("2.x" is now SUPPORTED — the v2 contract; use a genuinely-future major.)
    bad = datasets / "bad_future_version"
    bad.mkdir()
    (bad / "layout_manifest.json").write_text(
        json.dumps({"manifest_version": "3.0"}), encoding="utf-8"
    )
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from api.main import create_app

    with TestClient(create_app()) as test_client:
        assert test_client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
        _seed_owner(tmp_path / "appstate.db", IMAGES_ONLY, "alice")  # D-34: alice reads her own
        token = test_client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
        resp = test_client.get(
            "/api/datasets", headers={"Authorization": f"Bearer {token}"}
        )

    assert resp.status_code == 200
    ids = {d["dataset_id"] for d in resp.json()["datasets"]}
    assert IMAGES_ONLY in ids  # the good, owned dataset still lists
    # The unreadable-manifest dataset is skipped by the scan AND unowned (D-34) — either
    # way it never surfaces; the listing does not 500.
    assert "bad_future_version" not in ids


def test_list_datasets_skips_corrupt_manifest(tmp_path, monkeypatch) -> None:
    """A dataset whose manifest is CORRUPT JSON must not 500 the listing. `json.load`
    raises `json.JSONDecodeError` — a `ValueError`, which the PRE-FIX narrow
    `except (HTTPException, KeyError, ValidationError)` did NOT catch, so it 500'd the
    whole listing (a second live instance of the class the PermissionError incident
    exposed). The scan now isolates ANY per-dataset failure, so the good dataset still
    lists and the response is 200."""
    data_root = tmp_path / "data"
    datasets = data_root / "datasets"
    datasets.mkdir(parents=True)
    shutil.copytree(FIXTURES / IMAGES_ONLY, datasets / IMAGES_ONLY)
    corrupt = datasets / "corrupt_manifest"
    corrupt.mkdir()
    (corrupt / "layout_manifest.json").write_text("{ not valid json", encoding="utf-8")
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from api.main import create_app

    with TestClient(create_app()) as test_client:
        assert test_client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
        _seed_owner(tmp_path / "appstate.db", IMAGES_ONLY, "alice")
        token = test_client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
        resp = test_client.get(
            "/api/datasets", headers={"Authorization": f"Bearer {token}"}
        )

    assert resp.status_code == 200, "a corrupt manifest must not 500 the whole listing"
    ids = {d["dataset_id"] for d in resp.json()["datasets"]}
    assert IMAGES_ONLY in ids
    assert "corrupt_manifest" not in ids


def test_list_datasets_isolates_arbitrary_manifest_error(
    tmp_path, monkeypatch, caplog
) -> None:
    """The incident itself: an UNREADABLE (PermissionError) manifest escaped the narrow
    catch and 500'd the whole listing — login included. The scan now isolates ANY
    per-dataset exception: a raw PermissionError raised from load_manifest is caught,
    logged by dataset name, and the listing still returns 200. Raising a RAW
    PermissionError (which load_manifest would itself now map to 404 — see
    test_load_manifest_unreadable_maps_to_404) additionally proves the listing is
    resilient even to a failure load_manifest does not map: belt and suspenders."""
    data_root = tmp_path / "data"
    datasets = data_root / "datasets"
    datasets.mkdir(parents=True)
    shutil.copytree(FIXTURES / IMAGES_ONLY, datasets / IMAGES_ONLY)
    boom = datasets / "boom"
    boom.mkdir()
    (boom / "layout_manifest.json").write_text(
        json.dumps({"manifest_version": "2.5"}), encoding="utf-8"
    )
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    real_load = db.load_manifest

    def flaky_load(ds_dir: Path):  # noqa: ANN202
        if ds_dir.name == "boom":
            raise PermissionError(13, "Permission denied", str(ds_dir / "layout_manifest.json"))
        return real_load(ds_dir)

    monkeypatch.setattr(db, "load_manifest", flaky_load)

    from api.main import create_app

    with TestClient(create_app()) as test_client, caplog.at_level("WARNING"):
        assert test_client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
        _seed_owner(tmp_path / "appstate.db", IMAGES_ONLY, "alice")
        token = test_client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
        resp = test_client.get(
            "/api/datasets", headers={"Authorization": f"Bearer {token}"}
        )

    assert resp.status_code == 200, "the incident: an unreadable manifest must not 500 login"
    ids = {d["dataset_id"] for d in resp.json()["datasets"]}
    assert IMAGES_ONLY in ids
    assert "boom" not in ids
    assert any(
        "boom" in r.getMessage() for r in caplog.records if r.levelname == "WARNING"
    ), "the skipped dataset must be logged by name"


def test_load_manifest_unreadable_maps_to_404(tmp_path, monkeypatch) -> None:
    """load_manifest maps an UNREADABLE (but stat-able) manifest to a clean 404, not a
    500 traceback — the open() failure mode its stat() guard already anticipates but did
    not cover (the stat() guard is on the stat; the open() happens one call deeper in
    _load_manifest_cached). A root-owned mode-600 manifest against the app uid is exactly
    this. Monkeypatched (not chmod) because a root test process bypasses file perms."""
    ds_dir = tmp_path / "ds"
    ds_dir.mkdir()
    (ds_dir / "layout_manifest.json").write_text(
        json.dumps({"manifest_version": "2.5"}), encoding="utf-8"
    )

    def denied(*_a, **_k):  # noqa: ANN002, ANN003, ANN202
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(db, "_load_manifest_cached", denied)
    with pytest.raises(HTTPException) as excinfo:
        db.load_manifest(ds_dir)
    assert excinfo.value.status_code == 404


def test_job_states_isolates_a_corrupt_job(monkeypatch, caplog) -> None:
    """The listing's OTHER per-item loop: `_job_states` resolves every recorded job's RQ
    state to stamp active_job_id. `Job.fetch_many` DESERIALIZES each job, and a corrupt
    payload raises rq's `DeserializationError` — NOT a `RedisError`, so it escaped the
    guard and 500'd the whole `GET /api/datasets` listing (login included). It now falls
    back to per-id fetch: the GOOD id resolves, the corrupt id maps to None, nothing
    propagates."""
    from api.routers import datasets as dr

    class _Corrupt(Exception):
        """Stand-in for rq.exceptions.DeserializationError (a plain Exception)."""

    class _Job:
        def __init__(self, status: str) -> None:
            self._status = status

        def get_status(self, refresh: bool = False) -> str:  # noqa: FBT001, FBT002
            return self._status

    def fetch_many(ids, connection=None):  # noqa: ANN001, ANN202, ARG001
        raise _Corrupt("corrupt payload in the batch restore")

    def fetch(job_id, connection=None):  # noqa: ANN001, ANN202, ARG001
        if job_id == "bad":
            raise _Corrupt("corrupt payload")
        return _Job("started")

    monkeypatch.setattr(dr.Job, "fetch_many", staticmethod(fetch_many))
    monkeypatch.setattr(dr.Job, "fetch", staticmethod(fetch))

    with caplog.at_level("WARNING"):
        states = dr._job_states(connection=object(), job_ids=["good", "bad"])
    assert states == {"good": "started", "bad": None}, "one corrupt job must not sink the batch"
    assert any("bad" in r.getMessage() for r in caplog.records), "the corrupt job is logged"


def test_job_states_isolates_a_per_job_status_error(monkeypatch) -> None:
    """Even when the batch fetch SUCCEEDS, a single job whose status read raises must map
    to None (via `_status_of`), never propagate — the happy-path per-job isolation."""
    from api.routers import datasets as dr

    class _Job:
        def __init__(self, status, boom=False):  # noqa: ANN001, FBT002
            self._status = status
            self._boom = boom

        def get_status(self, refresh: bool = False):  # noqa: ANN202, FBT001, FBT002
            if self._boom:
                raise RuntimeError("status read blew up")
            return self._status

    def fetch_many(ids, connection=None):  # noqa: ANN001, ANN202, ARG001
        return [_Job("started"), _Job("", boom=True), None]

    monkeypatch.setattr(dr.Job, "fetch_many", staticmethod(fetch_many))
    states = dr._job_states(connection=object(), job_ids=["a", "b", "c"])
    assert states == {"a": "started", "b": None, "c": None}


def test_job_states_missing_id_in_fallback_is_silent(monkeypatch, caplog) -> None:
    """In the per-id fallback (batch restore failed), a MISSING/expired id — `Job.fetch`
    raises rq's `NoSuchJobError` — must map to None WITHOUT a warning, exactly as the
    happy-path `fetch_many` yields a missing id silently. Only a corrupt/unreadable id is
    logged; a routine miss is not noise. Guards the `except NoSuchJobError` clause."""
    from api.routers import datasets as dr
    from rq.exceptions import NoSuchJobError

    class _Job:
        def get_status(self, refresh: bool = False):  # noqa: ANN202, FBT001, FBT002
            return "started"

    def fetch_many(ids, connection=None):  # noqa: ANN001, ANN202, ARG001
        raise RuntimeError("force the per-id fallback")

    def fetch(job_id, connection=None):  # noqa: ANN001, ANN202, ARG001
        if job_id == "gone":
            raise NoSuchJobError("no such job")
        return _Job()

    monkeypatch.setattr(dr.Job, "fetch_many", staticmethod(fetch_many))
    monkeypatch.setattr(dr.Job, "fetch", staticmethod(fetch))

    with caplog.at_level("WARNING"):
        states = dr._job_states(connection=object(), job_ids=["good", "gone"])
    assert states == {"good": "started", "gone": None}
    assert not any(
        "gone" in r.getMessage() for r in caplog.records
    ), "a merely missing job must not be logged as unreadable"


# --- T2-03: list_datasets cold scan runs OFF the event loop -----------------


def test_list_datasets_scan_runs_in_threadpool(client, auth, monkeypatch) -> None:
    """The cold disk scan (iterdir + per-dataset load_manifest) is dispatched to a
    threadpool, not run on the event loop (T2-03). Assert the scan callable
    (`_scan_ready_datasets`) reaches `run_in_threadpool`, and that the response is
    unchanged."""
    from api.routers import datasets as datasets_router

    seen: list[str] = []
    real = datasets_router.run_in_threadpool

    async def spy(func, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        seen.append(getattr(func, "__name__", repr(func)))
        return await real(func, *args, **kwargs)

    monkeypatch.setattr(datasets_router, "run_in_threadpool", spy)

    resp = client.get("/api/datasets", headers=auth)
    assert resp.status_code == 200
    ids = {d["dataset_id"] for d in resp.json()["datasets"]}
    assert {WITH_META, IMAGES_ONLY} <= ids
    # The scan was offloaded (not run inline on the loop).
    assert "_scan_ready_datasets" in seen


def test_list_datasets_order_and_fields_several_datasets(
    tmp_path, monkeypatch
) -> None:
    """Listing correctness is unchanged with several datasets: `ready` summaries are
    emitted in SORTED dataset-dir order and carry the full manifest-derived fields
    (T2-03 preserves ordering + shape). Uses three copies of the images-only golden
    (no owner seeding needed) plus a distinct name to pin the sort."""
    data_root = tmp_path / "data"
    datasets = data_root / "datasets"
    datasets.mkdir(parents=True)
    # Copy under names whose sorted order is deterministic and not copy-order.
    names = ["ds_charlie", "ds_alpha", "ds_bravo"]
    for name in names:
        shutil.copytree(FIXTURES / IMAGES_ONLY, datasets / name)
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(data_root))

    from api.main import create_app

    with TestClient(create_app()) as test_client:
        assert test_client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
        # D-34: seed alice as owner of all three so they list for her (owned ∪ public).
        for name in names:
            _seed_owner(tmp_path / "appstate.db", name, "alice")
        token = test_client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
        resp = test_client.get(
            "/api/datasets", headers={"Authorization": f"Bearer {token}"}
        )

    assert resp.status_code == 200
    listed = resp.json()["datasets"]
    got_order = [d["dataset_id"] for d in listed]
    assert got_order == sorted(names)  # sorted-dir order, D-28 contract
    for summary in listed:
        assert summary["status"] == "ready"
        assert summary["image_count"] == 10
        assert summary["layout_ids"] == ["grid"]
        assert summary["dataset_version"] == 1
        assert summary["owner"] == "alice"  # seeded owner (D-34: caller sees owned)


# --- T2-04: metadata schema cache (no per-request DESCRIBE) -----------------


def test_metadata_second_request_does_not_redescribe(client, auth) -> None:
    """The scalar-column DESCRIBE is cached (T2-04): two metadata requests for the
    same dataset run DESCRIBE at most once. A `dependency_overrides` cursor wraps
    `execute` to count DESCRIBE statements (overriding the Depends is the reliable
    injection point — monkeypatching db.get_cursor after app build would not rebind
    the already-registered dependency); the second request must hit the cache."""
    from api import db as db_module

    # A fresh process-wide cache so a prior test's entries don't mask the miss.
    db_module._scalar_columns_cache.clear()

    describes = {"count": 0}

    class _CountingCursor:
        """Proxy over a DuckDB cursor (its `execute` is a read-only C attribute, so
        it cannot be patched in place) that tallies DESCRIBE statements and delegates
        everything else."""

        def __init__(self, inner) -> None:  # noqa: ANN001
            self._inner = inner

        def execute(self, sql, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
            if sql.lstrip().upper().startswith("DESCRIBE"):
                describes["count"] += 1
            return self._inner.execute(sql, *args, **kwargs)

        def __getattr__(self, name):  # noqa: ANN001, ANN204
            return getattr(self._inner, name)

    def counting_cursor(request: Request):  # noqa: ANN202
        cur = request.app.state.db.cursor()
        try:
            yield _CountingCursor(cur)
        finally:
            cur.close()

    client.app.dependency_overrides[db_module.get_cursor] = counting_cursor
    try:
        first = client.get(f"/api/datasets/{WITH_META}/metadata?ids=0,1", headers=auth)
        assert first.status_code == 200
        second = client.get(
            f"/api/datasets/{WITH_META}/metadata?ids=2,3", headers=auth
        )
        assert second.status_code == 200
    finally:
        client.app.dependency_overrides.pop(db_module.get_cursor, None)
    # DESCRIBE ran for the cold first request only; the second reused the cache.
    assert describes["count"] == 1


def test_scalar_columns_cache_reparses_on_mtime_change(tmp_path) -> None:
    """The schema cache is keyed on (path, mtime_ns, size) exactly like
    load_manifest's cache (T2-04): rewriting the Parquet (new mtime/size) is a miss
    and re-describes, so a re-ingest is picked up. Drive db.scalar_columns directly
    with a real DuckDB cursor and a counting execute."""
    from api import db as db_module

    db_module._scalar_columns_cache.clear()
    parquet_path = tmp_path / "metadata.parquet"
    con = duckdb.connect()

    def _write(extra_col: bool) -> None:
        cols = "(0, 'a.webp')" if not extra_col else "(0, 'a.webp', 7)"
        names = "t(id, filename)" if not extra_col else "t(id, filename, extra)"
        con.execute(
            f"COPY (SELECT * FROM (VALUES {cols}) AS {names}) "
            f"TO '{parquet_path.as_posix()}' (FORMAT PARQUET)"
        )

    describes = {"count": 0}
    real_execute = con.execute

    class _CountingCursor:
        def execute(self, sql, *a, **k):  # noqa: ANN001, ANN002, ANN003, ANN202
            if sql.lstrip().upper().startswith("DESCRIBE"):
                describes["count"] += 1
            return real_execute(sql, *a, **k)

    cur = _CountingCursor()

    _write(extra_col=False)
    cols1 = db_module.scalar_columns(cur, parquet_path)
    assert cols1 == ["id", "filename"]
    # A second call for the SAME file version reuses the cache (no new DESCRIBE).
    db_module.scalar_columns(cur, parquet_path)
    assert describes["count"] == 1

    # Rewrite the file with a new schema; loop until the mtime actually advances so
    # the (path, mtime_ns, size) key changes (a coarse clock could otherwise collide).
    st_before = parquet_path.stat().st_mtime_ns
    while parquet_path.stat().st_mtime_ns == st_before:
        time.sleep(0.005)
        _write(extra_col=True)

    cols2 = db_module.scalar_columns(cur, parquet_path)  # miss → re-describe
    assert cols2 == ["id", "filename", "extra"]
    assert describes["count"] == 2
