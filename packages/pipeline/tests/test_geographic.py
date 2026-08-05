"""Geographic layout family (D-35 Seam G2 / T2-35): projection math, ingest fail-fast
validation, the projected + shared-fit placement (north-up for BOTH projections, the
unplaced strip), family expansion, and the manifest `options.projection` echo.

Lean-safe (no pyvips/pmtiles) — collected in the lean test image like test_scatter.
"""
from __future__ import annotations

import csv
import math
from pathlib import Path
from types import SimpleNamespace

import jsonschema
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import worker
from pipeline.ingest import ColumnRoleError, ingest_metadata
from pipeline.layout_plugins._placement import PLACED_Y_MAX
from pipeline.layout_plugins.base import ColumnRoles, GeographicRoleEntry, build_spatial_cells
from pipeline.layout_plugins.base import LayoutResult
from pipeline.layout_plugins.geographic import (
    GeographicLayout,
    _project_equirectangular,
    _project_mercator,
)
from pipeline.manifest import _layout_entry, _validate_manifest


def _fake_atlas(n: int) -> SimpleNamespace:
    """A v2 ThumbnailCache stand-in: layouts read only ``.ids`` (dense [0, n))."""
    return SimpleNamespace(ids=list(range(n)), thumb_px=64, cache_dir=None, skipped=[])


def _geo_roles(*entries: tuple[str, str, str], projection: str | None = None) -> ColumnRoles:
    """A validated ColumnRoles with the given geographic (lon, lat, label) entries; an
    optional single ``projection`` applied to all of them."""
    def _entry(lon: str, lat: str, label: str) -> dict:
        d: dict = {"lon_column": lon, "lat_column": lat, "label": label}
        if projection is not None:
            d["projection"] = projection
        return d

    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "geographic": [_entry(lon, lat, label) for lon, lat, label in entries],
        }
    )


def _geo_meta(
    lons: list[float | None], lats: list[float | None], lon_col: str = "lon", lat_col: str = "lat"
) -> pa.Table:
    n = len(lons)
    return pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            lon_col: pa.array(lons, pa.float64()),
            lat_col: pa.array(lats, pa.float64()),
        }
    )


# --- 1. projection math (against known values) --------------------------------


def test_equirectangular_is_identity() -> None:
    # Plate carrée: x = lon, y = lat, 1° = 1°. Valid to the poles.
    for lon, lat in [(0.0, 0.0), (-74.0, 40.7), (139.7, 35.7), (10.0, 90.0), (-20.0, -90.0)]:
        assert _project_equirectangular(lon, lat) == (lon, lat)


def test_mercator_known_value_45deg() -> None:
    # Web Mercator northing y(45°) = ln(tan(π/4 + π/8)) = ln(tan(67.5°)) ≈ 0.8813736.
    x, y = _project_mercator(0.0, 45.0)
    assert x == 0.0, "lon 0 -> meridian x = 0"
    assert abs(y - 0.8813735870195429) < 1e-12


def test_mercator_equator_and_meridian_at_origin() -> None:
    # The equator/meridian project to the plane origin (mid-plane before the fit); the
    # northing is 0 up to float rounding (ln(tan(π/4)) computes as ~-1e-16).
    x, y = _project_mercator(0.0, 0.0)
    assert x == 0.0 and abs(y) < 1e-12


def test_mercator_lon_is_radians() -> None:
    # x = lon in RADIANS (keeps x on the same scale as the dimensionless northing, so the
    # equator is conformal), so lon 180 -> x = π.
    x, _y = _project_mercator(180.0, 0.0)
    assert abs(x - math.pi) < 1e-12


def test_mercator_northing_is_odd_and_monotone() -> None:
    # Monotone increasing in lat (north-up) and antisymmetric about the equator.
    ys = [_project_mercator(0.0, lat)[1] for lat in (-60.0, -30.0, 0.0, 30.0, 60.0)]
    assert ys == sorted(ys), "mercator northing must increase with latitude (north-up)"
    assert abs(_project_mercator(0.0, 30.0)[1] + _project_mercator(0.0, -30.0)[1]) < 1e-12


# --- 2. from_config parsing / schema ------------------------------------------


def test_from_config_parses_geographic_entry_with_defaults() -> None:
    roles = _geo_roles(("lon", "lat", "Location"))
    assert roles.geographic == [
        GeographicRoleEntry(
            lon_column="lon", lat_column="lat", label="Location",
            projection="equirectangular", overlap="overdraw",
        )
    ]


def test_from_config_parses_declared_mercator() -> None:
    roles = _geo_roles(("lon", "lat", "Map"), projection="mercator")
    assert roles.geographic[0].projection == "mercator"


def test_from_config_defaults_geographic_to_empty() -> None:
    roles = ColumnRoles.from_config({"filename": {"column": "filename", "label": "F"}})
    assert roles.geographic == []


def test_geographic_missing_lat_fails_schema_validation() -> None:
    # The pair is atomic (D-35): a lon without a lat is unrepresentable.
    with pytest.raises(jsonschema.ValidationError):
        ColumnRoles.from_config(
            {
                "filename": {"column": "filename", "label": "F"},
                "geographic": [{"lon_column": "lon", "label": "Location"}],
            }
        )


def test_from_config_rejects_unknown_projection() -> None:
    with pytest.raises(jsonschema.ValidationError):
        ColumnRoles.from_config(
            {
                "filename": {"column": "filename", "label": "F"},
                "geographic": [
                    {"lon_column": "lon", "lat_column": "lat", "label": "L", "projection": "albers"}
                ],
            }
        )


# --- 3. placement: normalized [0,1]^2, north-up (both projections), strip ------


def test_compute_places_in_unit_box_typed() -> None:
    meta = _geo_meta([-74.0, 139.7, 2.35, 151.2], [40.7, 35.7, 48.85, -33.9])
    result = GeographicLayout().compute(meta, _geo_roles(("lon", "lat", "L")), _fake_atlas(4), {})

    assert result.layout_type == "geographic"
    assert result.edges is None
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    assert all(0.0 - 1e-6 <= v <= 1.0 + 1e-6 for v in xs + ys), "all coords in [0,1]^2"


@pytest.mark.parametrize("projection", ["equirectangular", "mercator"])
def test_north_up_both_projections(projection: str) -> None:
    # Two cells at the same longitude, differing only in latitude: the HIGHER latitude
    # (north) must get the SMALLER placed y — the world camera's screen-y grows downward
    # (renderer/world.ts), so a smaller world y renders HIGHER on screen. Holds for both
    # projections because each northing is monotone increasing in latitude.
    meta = _geo_meta([10.0, 10.0], [12.0, 55.0])  # id 1 is farther north
    result = GeographicLayout().compute(
        meta, _geo_roles(("lon", "lat", "L"), projection=projection), _fake_atlas(2), {}
    )
    ys = dict(zip(result.cells.column("id").to_pylist(), result.cells.column("y").to_pylist()))
    assert ys[1] < ys[0], f"{projection}: the more-northern cell must render higher (smaller y)"
    assert all(0.0 - 1e-6 <= y <= PLACED_Y_MAX + 1e-6 for y in ys.values()), "in the placed band"


def test_null_coordinates_land_in_strip() -> None:
    # A cell with a null lon or lat is unplaced -> the bottom strip (y >= 0.96), never dropped.
    meta = _geo_meta([-74.0, None, 2.35], [40.7, 20.0, None])
    result = GeographicLayout().compute(meta, _geo_roles(("lon", "lat", "L")), _fake_atlas(3), {})
    ys = result.cells.column("y").to_pylist()
    assert ys[1] >= 0.96 - 1e-6 and ys[2] >= 0.96 - 1e-6, "null-coord cells go to the strip"
    assert ys[0] <= PLACED_Y_MAX + 1e-6, "the placed cell stays in the placed band"
    # v2.6 (T2-140 / D-36 seam U1): report how many cells are in that strip, so the viewer
    # can explain the band. A fully-placed map reports 0 — manifest.py writes it, so the
    # zero is a counted claim rather than the silence that means "pre-2.6 entry".
    assert result.missing_count == 2
    placed_only = GeographicLayout().compute(
        _geo_meta([-74.0, 2.35], [40.7, 48.9]), _geo_roles(("lon", "lat", "L")), _fake_atlas(2), {}
    )
    assert placed_only.missing_count == 0


def test_missing_metadata_row_is_unplaced_not_dropped() -> None:
    # A packed cell with no metadata row (D-25 left join) is unplaced, never dropped.
    meta = _geo_meta([-74.0, 139.7], [40.7, 35.7])  # ids 0..1; atlas has 0..2
    result = GeographicLayout().compute(meta, _geo_roles(("lon", "lat", "L")), _fake_atlas(3), {})
    assert result.cells.column("id").to_pylist() == [0, 1, 2]
    assert result.cells.column("y").to_pylist()[2] >= 0.96 - 1e-6


def test_equirectangular_preserves_lon_lat_aspect() -> None:
    # A 20°-wide x 10°-tall lon/lat rectangle keeps its true 2:1 proportions (one shared
    # scale for both axes) — equirectangular is 1° lon = 1° lat, so the map is not stretched.
    meta = _geo_meta([-10.0, 10.0, -10.0, 10.0], [-5.0, -5.0, 5.0, 5.0])
    result = GeographicLayout().compute(meta, _geo_roles(("lon", "lat", "L")), _fake_atlas(4), {})
    xs = result.cells.column("x").to_pylist()
    ys = result.cells.column("y").to_pylist()
    x_extent, y_extent = max(xs) - min(xs), max(ys) - min(ys)
    assert abs(x_extent / y_extent - 2.0) < 1e-6, "20:10 lon/lat aspect must be preserved 2:1"


def test_compute_is_deterministic() -> None:
    meta = _geo_meta([-74.0, 139.7, None, 2.35], [40.7, 35.7, 10.0, None])
    roles = _geo_roles(("lon", "lat", "L"))
    a = GeographicLayout().compute(meta, roles, _fake_atlas(4), {})
    b = GeographicLayout().compute(meta, roles, _fake_atlas(4), {})
    assert a.cells.equals(b.cells)
    assert a.bbox == b.bbox


# --- 4. the manifest `options` echo (always emitted for geographic) -----------


def test_options_echo_records_projection() -> None:
    for projection in ("equirectangular", "mercator"):
        meta = _geo_meta([-74.0, 139.7], [40.7, 35.7])
        result = GeographicLayout().compute(
            meta, _geo_roles(("lon", "lat", "L"), projection=projection), _fake_atlas(2), {}
        )
        assert result.options == {"projection": projection, "overlap": "overdraw"}


def _fake_pyramid() -> SimpleNamespace:
    return SimpleNamespace(
        path="tiles/geographic/geographic_v1.pmtiles",
        tile_px=512, thumb_px=64, cap=64,
        levels=[SimpleNamespace(z=0, tile_count=1)], z_cap=0,
        detail_path_prefix=None, detail_format=None, dropped_total=0,
    )


def _geo_result(options: dict) -> LayoutResult:
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    return LayoutResult(
        layout_id="geographic", layout_type="geographic", label="Location",
        cells=cells, bbox=(0.0, 0.0, 1.0, 1.0), edges=None, options=options,
    )


def test_layout_entry_emits_geographic_options_and_type() -> None:
    entry = _layout_entry(_geo_result({"projection": "mercator", "overlap": "overdraw"}), _fake_pyramid())
    assert entry["type"] == "geographic"
    assert entry["options"] == {"projection": "mercator", "overlap": "overdraw"}


def test_manifest_with_geographic_layout_conforms_to_schema() -> None:
    # SCHEMA CONFORMANCE: a full manifest with a `"geographic"` layout carrying an
    # `options.projection` echo validates against the REAL schemas/v2 (v2.4) contract via
    # the pipeline's own write-time validator.
    entry = _layout_entry(_geo_result({"projection": "equirectangular", "overlap": "overdraw"}), _fake_pyramid())
    manifest = {
        "manifest_version": "2.4",
        "dataset_id": "ds",
        "dataset_version": 1,
        "layouts": [entry],
        "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-01-01T00:00:00Z"},
    }
    _validate_manifest(manifest)  # raises on any nonconformance


# --- 5. family expansion (single vs multiple geographic entries) --------------


def test_single_geographic_entry_keeps_bare_layout_id() -> None:
    meta = _geo_meta([0.0, 1.0], [0.0, 1.0])
    results = worker._expand_layouts(
        GeographicLayout(), meta, _geo_roles(("lon", "lat", "Location")), _fake_atlas(2)
    )
    assert [r.layout_id for r in results] == ["geographic"]
    assert results[0].label == "Location"
    assert results[0].layout_type == "geographic"


def test_two_geographic_entries_expand_to_slugged_layouts() -> None:
    # The distinguishing column is the entry's LON column; a multi-entry family slugs it.
    meta = pa.table(
        {
            "id": pa.array([0, 1], pa.int64()),
            "home_lon": pa.array([0.0, 1.0], pa.float64()),
            "home_lat": pa.array([0.0, 1.0], pa.float64()),
            "work Lon": pa.array([0.0, 1.0], pa.float64()),
            "work_lat": pa.array([0.0, 1.0], pa.float64()),
        }
    )
    roles = _geo_roles(("home_lon", "home_lat", "Home"), ("work Lon", "work_lat", "Work"))
    results = worker._expand_layouts(GeographicLayout(), meta, roles, _fake_atlas(2))
    assert [r.layout_id for r in results] == ["geographic_home_lon", "geographic_work-lon"]
    assert [r.label for r in results] == ["Home", "Work"]


def test_geographic_slug_collision_appends_entry_index() -> None:
    # Two entries sharing the same distinguishing lon_column -> identical slugs -> the
    # second layout_id gets the "-{i}" suffix (distinct PMTiles containers).
    meta = pa.table(
        {
            "id": pa.array([0, 1], pa.int64()),
            "p.lon": pa.array([0.0, 1.0], pa.float64()),
            "lat_a": pa.array([0.0, 1.0], pa.float64()),
            "lat_b": pa.array([0.0, 1.0], pa.float64()),
        }
    )
    roles = _geo_roles(("p.lon", "lat_a", "First"), ("p.lon", "lat_b", "Second"))
    results = worker._expand_layouts(GeographicLayout(), meta, roles, _fake_atlas(2))
    assert [r.layout_id for r in results] == ["geographic_p.lon", "geographic_p.lon-1"]


# --- 6. ingest-time value handling (D-11 fail-fast) ---------------------------


def _write_csv(path: Path, header: list[str], rows: list[list[str]]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return path


def _geo_roles_config(projection: str | None = None) -> dict:
    entry: dict = {"lon_column": "lon", "lat_column": "lat", "label": "Location"}
    if projection is not None:
        entry["projection"] = projection
    return {"filename": {"column": "filename", "label": "Filename"}, "geographic": [entry]}


def test_lon_out_of_range_raises_naming_column(tmp_path: Path, images_dir: Path, names: list[str]) -> None:
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    rows[2][1] = "200.0"  # lon > 180 -> fail fast (D-11)
    csv_path = _write_csv(tmp_path / "badlon.csv", ["filename", "lon", "lat"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _geo_roles_config())
    assert exc.value.column == "lon" and "longitude" in exc.value.reason


def test_lat_out_of_range_raises_naming_column(tmp_path: Path, images_dir: Path, names: list[str]) -> None:
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    rows[5][2] = "-95.0"  # lat < -90 -> fail fast
    csv_path = _write_csv(tmp_path / "badlat.csv", ["filename", "lon", "lat"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _geo_roles_config())
    assert exc.value.column == "lat" and "latitude" in exc.value.reason


def test_mercator_high_latitude_raises_naming_column_and_value(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # Under mercator, |lat| beyond the Web-Mercator clip latitude (85.051129) fail-fasts —
    # NO silent clamp (§6.2) — naming the column and the offending value.
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    rows[4][2] = "88.0"  # valid latitude, but out of Web-Mercator range
    csv_path = _write_csv(tmp_path / "merchi.csv", ["filename", "lon", "lat"], rows)
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _geo_roles_config("mercator"))
    assert exc.value.column == "lat"
    assert "mercator" in exc.value.reason and "88" in exc.value.reason


def test_equirectangular_allows_high_latitude(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # The SAME 88° latitude is VALID under equirectangular (valid to the poles) — no raise.
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    rows[4][2] = "88.0"
    csv_path = _write_csv(tmp_path / "eqhi.csv", ["filename", "lon", "lat"], rows)
    result = ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _geo_roles_config())
    assert result.column_roles is not None
    assert result.column_roles.geographic[0].projection == "equirectangular"


def test_unimplemented_overlap_raises_at_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    csv_path = _write_csv(tmp_path / "ov.csv", ["filename", "lon", "lat"], rows)
    config = _geo_roles_config()
    config["geographic"][0]["overlap"] = "jitter"
    with pytest.raises(ColumnRoleError) as exc:
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, config)
    assert "not implemented" in exc.value.reason


def test_nonfinite_geographic_value_raises_at_ingest(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    rows[0][1] = "inf"  # parses as a float but is not finite
    csv_path = _write_csv(tmp_path / "inf.csv", ["filename", "lon", "lat"], rows)
    with pytest.raises(ColumnRoleError):
        ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _geo_roles_config())


def test_geographic_columns_stored_as_nullable_float64(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    rows = [[name, "10.0", "40.0"] for name in sorted(names)]
    rows[3] = [sorted(names)[3], "", ""]  # empty -> null (an unplaced cell)
    csv_path = _write_csv(tmp_path / "ok.csv", ["filename", "lon", "lat"], rows)
    result = ingest_metadata(images_dir, "ds", tmp_path / "out", csv_path, _geo_roles_config())

    table = pq.read_table(result.metadata_path)
    assert table.schema.field("lon").type.equals(pa.float64())
    assert table.schema.field("lat").type.equals(pa.float64())
    lons = table.column("lon").to_pylist()
    assert lons[3] is None and lons[0] == 10.0
    assert result.column_roles is not None
    assert result.column_roles.geographic == [
        GeographicRoleEntry(lon_column="lon", lat_column="lat", label="Location")
    ]


# --- 7. add-layouts carry-through (the G1 hardening carried through to geographic) ---
# The G1 review hardened the guards to run on BOTH producer entry points (ingest AND the
# add-layouts roles-override path) + a stale-config guard. D-35 G2 carries the SAME through
# for the geographic family: config + value checks in _validate_roles_against_parquet, and
# a projection-change guard matched by lon/lat pair (not layout id).


def _geo_cfg(overlap: str | None = None, projection: str | None = None) -> dict:
    entry: dict = {"lon_column": "lon", "lat_column": "lat", "label": "Location"}
    if overlap is not None:
        entry["overlap"] = overlap
    if projection is not None:
        entry["projection"] = projection
    return {"filename": {"column": "filename", "label": "Filename"}, "geographic": [entry]}


def _geo_parquet(tmp_path: Path, lons: list, lats: list) -> Path:
    table = pa.table(
        {
            "id": pa.array(list(range(len(lons))), pa.int64()),
            "lon": pa.array(lons, pa.float64()),
            "lat": pa.array(lats, pa.float64()),
        }
    )
    path = tmp_path / "meta.parquet"
    pq.write_table(table, path)
    return path


def test_validate_geographic_config_rejects_unimplemented_overlap() -> None:
    # The pure-config gate runs on BOTH entry points (ingest hoisted + add-layouts). The
    # geographic family has no scale knobs, so the only config check is unimplemented overlap.
    from pipeline.ingest import validate_geographic_config

    roles = ColumnRoles.from_config(_geo_cfg(overlap="jitter"))
    with pytest.raises(ColumnRoleError) as exc:
        validate_geographic_config(roles)
    assert exc.value.column == "lon" and "not implemented" in exc.value.reason


def test_validate_geographic_options_parquet_rejects_out_of_range(tmp_path: Path) -> None:
    # The add-layouts twin of the ingest VALUE check (mirrors validate_scatter_options_parquet):
    # lon/lat range enforced against the committed parquet, exactly as ingest enforces it
    # against the CSV — a row missing a coordinate (both None) is unplaced and exempt.
    from pipeline.ingest import validate_geographic_options_parquet

    path = _geo_parquet(tmp_path, [10.0, 200.0, None], [40.0, 40.0, None])  # 200 > 180
    with pytest.raises(ColumnRoleError) as exc:
        validate_geographic_options_parquet(_geo_roles(("lon", "lat", "Location")), path)
    assert exc.value.column == "lon" and "longitude" in exc.value.reason


def test_validate_geographic_options_parquet_rejects_mercator_high_lat(tmp_path: Path) -> None:
    from pipeline.ingest import validate_geographic_options_parquet

    path = _geo_parquet(tmp_path, [10.0, 10.0], [40.0, 88.0])  # 88 out of Web-Mercator range
    with pytest.raises(ColumnRoleError) as exc:
        validate_geographic_options_parquet(_geo_roles(("lon", "lat", "L"), projection="mercator"), path)
    assert exc.value.column == "lat" and "mercator" in exc.value.reason


def test_validate_geographic_options_parquet_passes_valid(tmp_path: Path) -> None:
    from pipeline.ingest import validate_geographic_options_parquet

    path = _geo_parquet(tmp_path, [10.0, -74.0, None], [40.0, -33.0, None])
    validate_geographic_options_parquet(_geo_roles(("lon", "lat", "L")), path)  # no raise


def test_guard_no_stale_geographic_config_rejects_projection_change() -> None:
    # add-layouts honesty guard (mirrors _guard_no_stale_scatter_config): changing a COMMITTED
    # geographic pair's projection is rejected (the never-re-baked layout's positions + options
    # echo would contradict it), naming the layout.
    committed = {"column_roles": _geo_cfg()}  # default equirectangular; layout id "geographic"
    override = ColumnRoles.from_config(_geo_cfg(projection="mercator"))
    with pytest.raises(ColumnRoleError) as exc:
        worker._guard_no_stale_geographic_config(committed, override, {"geographic"})
    assert exc.value.column == "lon" and "geographic" in exc.value.reason


def test_guard_no_stale_geographic_config_pair_matched_across_naming_transition() -> None:
    # Matching is BY LON/LAT PAIR, not layout id: the committed single pair's id is
    # "geographic", but adding a SECOND pair in the override renames the first to
    # "geographic_lon" under multi-naming — an id-keyed compare would MISS it. The pair key
    # still catches the projection change on the first (committed) pair.
    committed = {"column_roles": _geo_cfg()}  # single pair -> id "geographic"
    override = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "geographic": [
                {"lon_column": "lon", "lat_column": "lat", "label": "A", "projection": "mercator"},
                {"lon_column": "lon2", "lat_column": "lat2", "label": "B"},  # new second pair
            ],
        }
    )
    with pytest.raises(ColumnRoleError):
        worker._guard_no_stale_geographic_config(committed, override, {"geographic"})


def test_guard_no_stale_geographic_config_allows_unchanged_and_new_pairs() -> None:
    # No-op when a committed pair's knobs are UNCHANGED (a re-declaration) or the override
    # names a NEW pair (nothing committed matches) — only a CHANGE to a committed pair fails.
    committed = {"column_roles": _geo_cfg()}
    worker._guard_no_stale_geographic_config(committed, ColumnRoles.from_config(_geo_cfg()), {"geographic"})
    new_pair = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "geographic": [
                {"lon_column": "lon3", "lat_column": "lat3", "label": "C", "projection": "mercator"}
            ],
        }
    )
    worker._guard_no_stale_geographic_config(committed, new_pair, {"geographic"})
