"""Contract tests — the CI merge gate (skeleton sub-brief 04 §D), re-targeted to
schemas/v2 (decision D-33, the renderer rework's MAJOR contract).

Architect-owned regression net. These validate the committed structural fixtures
(tests/fixtures/golden_dataset/ and tests/fixtures/golden_dataset_images_only/)
against the locked schemas/v2/ contract. They live at the repo level, NOT inside
any package, and seam agents never author them: this is the same net the pipeline
seam must pass with its own generated output.

Two fixtures exercise both sides of the images-first input contract (decision
D-25): `golden_dataset` carries an optional metadata source (filename + tag roles);
`golden_dataset_images_only` is the floor — images only, no column_roles, no tag
sidecar, no `source` provenance.

v2 covered (per fixture):
  1. layout_manifest.json validates against schemas/v2/layout_manifest.schema.json
     (manifest_version major == 2; per-layout `pyramid`; no `atlas`/`tile_root`).
  2. The embedded column_roles, WHEN PRESENT, validates against
     column_roles.schema.json (absent ⇒ images-only, which is valid).
  3. metadata.parquet always carries `id` (int64) + `filename` (string), plus the
     column_roles-declared columns when a metadata source is present.
  4. The pyramid invariants the schema cannot express numerically:
       * thumb_px <= tile_px;
       * cap == floor(tile_px / thumb_px)^2;
       * levels are contiguous from levels[0].z, strictly increasing;
       * z_cap equals one of the levels' z (the coarse/fine boundary).
  5. The PMTiles container per layout exists; every FINE tile (z >= z_cap) carries a
     cell_record list (validated against cell_record.schema.json) whose UV sub-rect
     is valid, and every COARSE tile (z < z_cap) is a pixel-only image (no records).
     The RECONCILED dense-id invariant (v2.1): distinct fine-tile ids are unique and a
     subset of [0, image_count), AND |distinct fine-tile ids| +
     sum(subsampled.dropped over fine tiles) == image_count. This catches "an id is
     missing from the tiles WITHOUT being recorded as subsampled-dropped" (the real
     bug) while allowing recorded coincident-point subsampling.
  6. The manifest is the REAL emitter's output: build_fixture writes it via
     pipeline.manifest.write_manifest, so this lean gate exercises the production
     manifest assembler (detail / column_roles / tags derivation), not a hand-rolled
     dict. At least one committed fixture has z_cap > 0 (real COARSE mosaic tiles) and
     a `detail` block, so the coarse branch + the detail schema are non-hollow here.

The v1 LOD-ceiling / atlas.lod_levels / tile_root / per-LOD-tree assertions are
GONE — v2 has no shared atlas, no fixed 3-level ceiling, and no per-LOD quadtree.
"""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq
import pytest
from jsonschema import Draft202012Validator
from pmtiles.reader import MmapSource, Reader
from referencing import Registry, Resource

_FORMAT_CHECKER = Draft202012Validator.FORMAT_CHECKER  # validates format: date-time etc.

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIR = REPO_ROOT / "schemas" / "v2"
FIXTURES_DIR = REPO_ROOT / "tests" / "fixtures"

# The v2 fixtures (decision D-33). The v1.1 `golden_dataset`/`golden_dataset_images_only`
# are kept (frozen) for the still-v1 api/frontend consumers during the migration
# wave (coexistence — see tests/fixtures/build_fixture.py); the v2 gate validates the
# `_v2` siblings. Both pairs are removed when the consumer seams migrate to v2.
# `golden_dataset_dense_v2` is the DEGENERATE fixture: > cap coincident cells force
# z_cap > 0 (real COARSE mosaic tiles) AND in-tile subsampling (recorded
# subsampled.dropped), so the gate's coarse branch + the reconciled dense-id
# invariant are non-hollow (they were dead on the N << cap fixtures).
# `golden_dataset_full_v2` is the COMPREHENSIVE all-layouts fixture (N=256 via the
# REAL `pixscope ingest` calibration recipe + synthetic metadata): grid + datetime +
# scatter + categorical×2 (different cardinality) + a tags sidecar, EVERY layout at
# z_cap >= 1 (a real coarse mosaic tier), with scatter null-coord (unplaced) rows and
# empty/multi-value tag cells. `golden_dataset_v2` stays the minimal grid-only unit
# fixture the api/frontend consumers pin; this one exercises the FULL contract surface
# the minimal fixture cannot (all layout types, the coarse tier, non-grid cell records,
# the tags sidecar). See tests/fixtures/golden_dataset_full_v2/ (recipe in its README).
FIXTURE_NAMES = [
    "golden_dataset_v2",
    "golden_dataset_images_only_v2",
    "golden_dataset_dense_v2",
    "golden_dataset_full_v2",
]
FIXTURES = [FIXTURES_DIR / name for name in FIXTURE_NAMES]
_with_fixture = pytest.mark.parametrize("fixture", FIXTURES, ids=FIXTURE_NAMES)

# Fine-tile body framing (pipeline.tiler._pack_fine_body — kept in sync; inlined
# here so the gate needs no pyvips-importing pipeline module): a big-endian uint32
# image-length prefix, then the WebP mini-atlas bytes, then the Arrow IPC records.
# Documented in schemas/v2/tile.schema.json (TILE BODY BYTE FRAMING).
_FINE_PREFIX = struct.Struct(">I")

# Schema-metadata key carrying a fine tile's coincident-point drop count (v2.1
# reconciliation; pipeline.tiler.SUBSAMPLED_DROPPED_KEY — inlined so the gate needs
# no pyvips-importing module). Decimal-string value; absent ⇒ nothing dropped.
_SUBSAMPLED_DROPPED_KEY = b"subsampled.dropped"


def _unpack_fine_body(body: bytes) -> tuple[bytes, bytes]:
    (image_len,) = _FINE_PREFIX.unpack_from(body, 0)
    start = _FINE_PREFIX.size
    return body[start:start + image_len], body[start + image_len:]


def _dropped_count(table: pa.Table) -> int:
    """The coincident-point drop count a fine tile recorded, from its Arrow record
    table's schema-level metadata; 0 when nothing was dropped (v2.1)."""
    meta = table.schema.metadata or {}
    raw = meta.get(_SUBSAMPLED_DROPPED_KEY)
    return int(raw) if raw is not None else 0


def _load_schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def _registry() -> Registry:
    """Resolve any `$ref` (e.g. the manifest's column_roles.schema.json) by
    loading the referenced schema from schemas/v2/ by basename."""

    def retrieve(uri: str) -> Resource:
        return Resource.from_contents(_load_schema(uri.rsplit("/", 1)[-1]))

    return Registry(retrieve=retrieve)


def _read_manifest(fixture: Path) -> dict:
    path = fixture / "layout_manifest.json"
    assert path.exists(), f"fixture manifest missing: {path} — run `make build-fixture`"
    return json.loads(path.read_text(encoding="utf-8"))


def _iter_pyramid_tiles(pmtiles_path: Path, levels: list[dict]):
    """Yield (z, x, y, body) for every occupied tile of a baked pyramid. The PMTiles
    reader resolves a tile only by explicit {z}/{x}/{y}, so scan the bounded 2^z
    grid per declared level (z_max is bounded by construction)."""
    with pmtiles_path.open("rb") as fh:
        reader = Reader(MmapSource(fh))
        for level in levels:
            z = level["z"]
            n_axis = 1 << z
            for x in range(n_axis):
                for y in range(n_axis):
                    body = reader.get(z, x, y)
                    if body is not None:
                        yield z, x, y, body


# --- 1 & 2: JSON Schema validation ------------------------------------------


@_with_fixture
def test_manifest_validates_against_schema(fixture: Path) -> None:
    manifest = _read_manifest(fixture)
    schema = _load_schema("layout_manifest.schema.json")
    Draft202012Validator(schema, registry=_registry(), format_checker=_FORMAT_CHECKER).validate(manifest)
    assert manifest["manifest_version"].startswith("2."), "v2 manifest must be major 2"
    assert "atlas" not in manifest, "v2 has no shared atlas block"


@_with_fixture
def test_embedded_column_roles_validate(fixture: Path) -> None:
    """column_roles is OPTIONAL (decision D-25). When present it must validate;
    when absent the dataset is images-only — also valid, nothing to check."""
    manifest = _read_manifest(fixture)
    if "column_roles" not in manifest:
        return  # images-only floor
    schema = _load_schema("column_roles.schema.json")
    Draft202012Validator(schema, registry=_registry(), format_checker=_FORMAT_CHECKER).validate(manifest["column_roles"])


# --- 3: metadata.parquet ----------------------------------------------------


@_with_fixture
def test_metadata_parquet_carries_id_filename_and_roles(fixture: Path) -> None:
    """metadata.parquet is the per-cell metadata keyed by id (the ingest.py output)
    — NOT the cell_record schema. It ALWAYS carries `id` (int64) + `filename`
    (string) — the images-first floor (decision D-25). When a metadata source is
    present, the filename-role column and each tag-role column (list<string>) are
    present too."""
    path = fixture / "metadata.parquet"
    assert path.exists(), f"fixture metadata.parquet missing: {path}"
    schema = pq.read_table(path).schema

    assert "id" in schema.names and schema.field("id").type.equals(pa.int64())
    assert "filename" in schema.names and schema.field("filename").type.equals(pa.string())

    roles = _read_manifest(fixture).get("column_roles")
    if roles is None:
        return  # images-only: no role columns to check

    fn_col = roles["filename"]["column"]
    assert fn_col in schema.names, f"metadata.parquet missing filename-role column {fn_col!r}"
    assert schema.field(fn_col).type.equals(pa.string())

    for tag_role in roles.get("tag", []):
        col = tag_role["column"]
        assert col in schema.names, f"metadata.parquet missing tag column {col!r}"
        assert schema.field(col).type.equals(pa.list_(pa.string()))


# --- 4: pyramid descriptor invariants (the schema cannot express these) -----


@_with_fixture
def test_pyramid_descriptor_invariants(fixture: Path) -> None:
    manifest = _read_manifest(fixture)
    for layout in manifest["layouts"]:
        assert "tile_root" not in layout, "v2 layout entry must not carry tile_root"
        pyr = layout["pyramid"]
        tile_px, thumb_px, cap = pyr["tile_px"], pyr["thumb_px"], pyr["cap"]
        # thumb_px <= tile_px (a thumbnail must fit in its tile).
        assert thumb_px <= tile_px, f"{layout['layout_id']}: thumb_px {thumb_px} > tile_px {tile_px}"
        # cap == floor(tile_px / thumb_px)^2.
        per_axis = tile_px // thumb_px
        assert cap == per_axis * per_axis, (
            f"{layout['layout_id']}: cap {cap} != floor({tile_px}/{thumb_px})^2 = {per_axis * per_axis}"
        )
        # levels: contiguous from levels[0].z, strictly increasing.
        zs = [lv["z"] for lv in pyr["levels"]]
        assert zs == list(range(zs[0], zs[0] + len(zs))), f"{layout['layout_id']}: levels z not contiguous: {zs}"
        # z_cap is one of the levels' z (the coarse/fine boundary).
        assert pyr["z_cap"] in zs, f"{layout['layout_id']}: z_cap {pyr['z_cap']} not a level z {zs}"
        assert pyr["container"] == "pmtiles"


# --- 5: tile bodies (both kinds) + contiguous-dense fine-tile ids -----------


@_with_fixture
def test_tiles_carry_v2_records_and_dense_ids(fixture: Path) -> None:
    manifest = _read_manifest(fixture)
    image_count = manifest["dataset_metadata"]["image_count"]
    cell_schema = _load_schema("cell_record.schema.json")
    validator = Draft202012Validator(cell_schema, registry=_registry())

    checked_layouts = 0
    for layout in manifest["layouts"]:
        pyr = layout["pyramid"]
        pmtiles_path = fixture / pyr["path"]
        assert pmtiles_path.exists(), f"{layout['layout_id']}: PMTiles container missing at {pmtiles_path}"
        z_cap = pyr["z_cap"]
        cap = pyr["cap"]

        seen_ids: set[int] = set()
        dropped_total = 0
        found_fine = found_coarse = 0
        for z, x, y, body in _iter_pyramid_tiles(pmtiles_path, pyr["levels"]):
            if z >= z_cap:  # FINE tile: bundled mini-atlas image + Arrow records
                found_fine += 1
                image_bytes, arrow_bytes = _unpack_fine_body(body)
                assert image_bytes[:4] == b"RIFF", f"{layout['layout_id']} {z}/{x}/{y}: fine mini-atlas not WebP"
                table = feather.read_table(io.BytesIO(arrow_bytes))
                dropped_total += _dropped_count(table)
                rows = table.to_pylist()
                assert len(rows) <= cap, f"{layout['layout_id']} {z}/{x}/{y}: {len(rows)} > cap {cap}"
                tile_ids = [row["id"] for row in rows]
                assert len(tile_ids) == len(set(tile_ids)), (
                    f"{layout['layout_id']} {z}/{x}/{y}: duplicate id within one tile"
                )
                for row in rows:
                    validator.validate(row)  # id,x,y,w,h,u,v,uw,uh + reserved nulls
                seen_ids.update(tile_ids)
            else:  # COARSE tile: pixel-only mosaic composite, no record bundle
                found_coarse += 1
                assert body[:4] == b"RIFF", f"{layout['layout_id']} {z}/{x}/{y}: coarse tile not WebP"

        assert found_fine > 0, f"{layout['layout_id']}: no fine tiles found"
        # RECONCILED dense-id invariant (v2.1): the distinct fine-tile ids are a SUBSET
        # of [0, image_count), and |distinct ids| + sum(subsampled.dropped) ==
        # image_count. With no subsampling, dropped_total == 0 and the union equals the
        # full range; with subsampling, the dropped ids are absent from every fine tile
        # but recorded, so the totals still reconcile. A missing id that was NOT recorded
        # as dropped fails here (the real bug).
        assert seen_ids <= set(range(image_count)), (
            f"{layout['layout_id']}: fine-tile ids stray outside [0,{image_count}); "
            f"extra={sorted(seen_ids - set(range(image_count)))[:5]}"
        )
        assert len(seen_ids) + dropped_total == image_count, (
            f"{layout['layout_id']}: |fine-tile ids|={len(seen_ids)} + dropped={dropped_total} "
            f"!= image_count={image_count} (an id is missing without being recorded as subsampled)"
        )
        checked_layouts += 1
    assert checked_layouts > 0, "no layouts were found to validate"


# --- 5b: position table (positions_ref) when present, else graceful absence --------


@_with_fixture
def test_positions_ref_valid_or_absent(fixture: Path) -> None:
    """T2-66/T2-48 (v2.2): a layout's OPTIONAL positions_ref, when present, points at an
    uncompressed Arrow table of EXACTLY (x,y,w,h) float32 columns (NO id column — the
    row index IS the dense cell id) whose row count == image_count. When ABSENT the
    dataset simply keeps fine-tier-only picking (graceful absence — the minimal
    golden_dataset_v2 and calib_small_v2 are baked pre-2.2, so their layouts carry no
    positions_ref, which is valid). At least one layout of at least one fixture must
    carry a positions_ref (proven by golden_dataset_full_v2 below) so this is non-hollow."""
    manifest = _read_manifest(fixture)
    image_count = manifest["dataset_metadata"]["image_count"]
    for layout in manifest["layouts"]:
        ref = layout.get("positions_ref")
        if ref is None:
            continue  # absent/null — fine-tier-only picking (graceful absence)
        path = fixture / ref
        assert path.exists(), f"{layout['layout_id']}: positions_ref {ref!r} points at a missing file"
        table = feather.read_table(path)
        assert table.schema.names == ["x", "y", "w", "h"], (
            f"{layout['layout_id']}: position table columns {table.schema.names} != [x,y,w,h] (no id column)"
        )
        for col in ("x", "y", "w", "h"):
            assert table.schema.field(col).type.equals(pa.float32()), (
                f"{layout['layout_id']}: position column {col!r} is not float32"
            )
        assert table.num_rows == image_count, (
            f"{layout['layout_id']}: position table has {table.num_rows} rows != image_count {image_count}"
        )


def test_minimal_golden_has_no_positions_ref() -> None:
    """GRACEFUL-ABSENCE proof: the minimal golden_dataset_v2 is deliberately baked
    without position tables (it is the pre-2.2 absence fixture the renderer's
    fine-tier-only fallback pins against). No layout may declare a positions_ref."""
    manifest = _read_manifest(FIXTURES_DIR / "golden_dataset_v2")
    for layout in manifest["layouts"]:
        assert layout.get("positions_ref") is None, (
            f"{layout['layout_id']}: minimal golden must have NO positions_ref (graceful-absence fixture)"
        )


def test_full_fixture_every_layout_has_a_position_table() -> None:
    """The comprehensive fixture is baked through the REAL pixscope pipeline (v2.2), so
    EVERY layout carries a positions_ref whose table row count == image_count. This is
    the non-hollow proof for the parametrized positions_ref test above (a fixture with
    NO positions_ref would let it pass vacuously)."""
    fixture = FIXTURES_DIR / FULL_FIXTURE
    manifest = _read_manifest(fixture)
    image_count = manifest["dataset_metadata"]["image_count"]
    for layout in manifest["layouts"]:
        ref = layout.get("positions_ref")
        assert ref is not None, f"{layout['layout_id']}: full fixture layout missing positions_ref (v2.2)"
        assert ref == f"positions/{layout['layout_id']}_v1.arrow", (
            f"{layout['layout_id']}: unexpected positions_ref {ref!r}"
        )
        table = feather.read_table(fixture / ref)
        assert table.schema.names == ["x", "y", "w", "h"]
        assert table.num_rows == image_count


# --- 6: the dense fixture makes the coarse branch + subsample path non-hollow --


def test_dense_fixture_exercises_coarse_and_subsample() -> None:
    """The degenerate fixture (> cap coincident cells) must actually have z_cap > 0
    (so COARSE mosaic tiles exist and are validated above) AND record a subsample
    drop (so the reconciled invariant's `dropped` term is non-zero). Without this
    the coarse branch and the subsample reconciliation are dead — the bug that
    Option A fixes would pass a hollow gate. This is the producer-side proof that
    the gate is genuinely exercising both paths."""
    fixture = FIXTURES_DIR / "golden_dataset_dense_v2"
    manifest = _read_manifest(fixture)
    image_count = manifest["dataset_metadata"]["image_count"]

    total_dropped = 0
    total_coarse = 0
    total_fine_ids: set[int] = set()
    for layout in manifest["layouts"]:
        pyr = layout["pyramid"]
        z_cap = pyr["z_cap"]
        assert z_cap > 0, f"dense fixture {layout['layout_id']}: z_cap must be > 0 (coarse tiles)"
        pmtiles_path = fixture / pyr["path"]
        for z, x, y, body in _iter_pyramid_tiles(pmtiles_path, pyr["levels"]):
            if z >= z_cap:
                _, arrow_bytes = _unpack_fine_body(body)
                table = feather.read_table(io.BytesIO(arrow_bytes))
                total_dropped += _dropped_count(table)
                total_fine_ids.update(int(v) for v in table.column("id").to_pylist())
            else:
                total_coarse += 1

    assert total_coarse > 0, "dense fixture has no coarse tiles — z_cap=0?"
    assert total_dropped > 0, "dense fixture recorded no subsample drop — not degenerate enough?"
    # The reconciliation must hold WITH a real drop: the fine-tile id union is a
    # strict subset, but |union| + dropped == image_count exactly.
    assert len(total_fine_ids) < image_count, "expected a strict subset under subsampling"
    assert len(total_fine_ids) + total_dropped == image_count, (
        f"reconciliation broken: |ids|={len(total_fine_ids)} + dropped={total_dropped} != {image_count}"
    )


# --- 7: the full fixture exercises the WHOLE contract surface (all layouts) ------
# `golden_dataset_full_v2` is the comprehensive fixture: grid + datetime + scatter +
# categorical×2 (of different cardinality) + a tags sidecar, EVERY layout baked to
# z_cap >= 1 (a real coarse mosaic tier). The parametrized invariants (§1-5) already
# validate its manifest, column_roles, metadata.parquet, pyramid descriptors, tile
# bodies, and dense-id reconciliation (it is in FIXTURE_NAMES). These add the
# richer, full-fixture-specific assertions the minimal grid-only golden cannot make.

FULL_FIXTURE = "golden_dataset_full_v2"


def test_full_fixture_covers_all_layout_types_with_coarse_tier() -> None:
    """The comprehensive fixture must carry EVERY layout family — grid, datetime,
    scatter, and (multi-entry) categorical — and each layout must bake to z_cap >= 1
    so a real COARSE mosaic tier exists and is exercised (the minimal `golden_dataset_v2`
    is all-fine z_cap=0, so the coarse branch runs in no unit gate there). Two
    categorical layouts of DIFFERENT cardinality (the group/bucket columns) prove the
    multi-entry categorical family expanded into distinct layouts."""
    manifest = _read_manifest(FIXTURES_DIR / FULL_FIXTURE)
    layouts = manifest["layouts"]
    types = {layout["type"] for layout in layouts}
    assert {"grid", "datetime", "scatter", "categorical", "geographic"} <= types, (
        f"full fixture missing a layout family; have {sorted(types)}"
    )
    # Multi-entry categorical expanded to >= 2 distinct layout_ids (different columns).
    categorical_ids = [layout["layout_id"] for layout in layouts if layout["type"] == "categorical"]
    assert len(categorical_ids) >= 2, f"expected >= 2 categorical layouts, got {categorical_ids}"
    assert len(set(categorical_ids)) == len(categorical_ids), "categorical layout_ids not unique"

    # EVERY layout has a coarse tier (z_cap >= 1) AND real coarse tiles on disk.
    fixture = FIXTURES_DIR / FULL_FIXTURE
    for layout in layouts:
        pyr = layout["pyramid"]
        z_cap = pyr["z_cap"]
        assert z_cap >= 1, f"full fixture {layout['layout_id']}: z_cap {z_cap} < 1 (no coarse tier)"
        coarse = sum(
            1
            for z, _x, _y, _body in _iter_pyramid_tiles(fixture / pyr["path"], pyr["levels"])
            if z < z_cap
        )
        assert coarse > 0, f"full fixture {layout['layout_id']}: z_cap>=1 but no coarse tiles on disk"


def test_full_fixture_geographic_layout_records_projection() -> None:
    """The comprehensive fixture (baked through the REAL pipeline) carries a GEOGRAPHIC
    layout (D-35 Seam G2) whose manifest `options` ALWAYS echoes the applied `projection`
    — the self-describing record the map explainer + the T2-86 continent underlay read
    (projection IS the geographic family's fit_transform.kind). The calib fixture bakes the
    DEFAULT equirectangular projection (valid to the poles — its lon/lat data includes a few
    high-latitude cells). Non-hollow proof that the geographic family bakes end to end and
    records its projection; the parametrized §1-5 already validate its manifest / records /
    dense-id reconciliation (it is a layout of this fixture)."""
    manifest = _read_manifest(FIXTURES_DIR / FULL_FIXTURE)
    geo = [layout for layout in manifest["layouts"] if layout["type"] == "geographic"]
    assert len(geo) == 1, f"expected one geographic layout, got {[g['layout_id'] for g in geo]}"
    layout = geo[0]
    assert layout["layout_id"] == "geographic"
    options = layout.get("options")
    assert options is not None, "geographic layout must ALWAYS echo options (projection is load-bearing)"
    assert options.get("projection") in {"equirectangular", "mercator"}
    assert options["projection"] == "equirectangular", "the calib fixture bakes the default projection"
    # The geographic role (lon/lat pair) is declared in the embedded column_roles.
    roles = manifest["column_roles"]
    assert roles.get("geographic"), "full fixture must declare a geographic role"
    assert roles["geographic"][0]["lon_column"] == "lon"
    assert roles["geographic"][0]["lat_column"] == "lat"
    # The lon/lat columns are stored as floats in metadata.parquet.
    schema = pq.read_table(FIXTURES_DIR / FULL_FIXTURE / "metadata.parquet").schema
    for col in ("lon", "lat"):
        assert col in schema.names and pa.types.is_floating(schema.field(col).type), (
            f"metadata.parquet {col!r} must be a float"
        )


def test_full_fixture_carries_v25_annotations() -> None:
    """v2.5 (T2-69/T2-72 Seam 2): the comprehensive fixture (baked through the REAL
    pipeline) carries per-layout `annotations` — CATEGORICAL band labels + a DATETIME axis
    domain — and grid/scatter/geographic carry NONE (correctly scoped this seam). Non-hollow
    proof that the producer emits annotations end to end and the 2.5 schema accepts them (§1
    already validates the whole manifest against the schema; this pins the SHAPE the renderer
    consumes)."""
    manifest = _read_manifest(FIXTURES_DIR / FULL_FIXTURE)
    assert manifest["manifest_version"] == "2.8", "the full fixture must be re-baked to 2.8"
    image_count = manifest["dataset_metadata"]["image_count"]
    by_type: dict[str, list[dict]] = {}
    for layout in manifest["layouts"]:
        by_type.setdefault(layout["type"], []).append(layout)

    # CATEGORICAL: one label per band, counts summing to image_count, each extent a
    # normalized [x0,y0,x1,y1] bbox in [0,1]. The calib category columns carry no nulls, so
    # NO band is flagged missing here (the missing-bucket path is a producer unit test).
    cat_layouts = by_type.get("categorical", [])
    assert len(cat_layouts) >= 2, "full fixture has the two categorical layouts"
    for layout in cat_layouts:
        labels = layout["annotations"]["labels"]
        assert labels, f"{layout['layout_id']}: categorical layout carries no band labels"
        assert sum(lab["count"] for lab in labels) == image_count, (
            f"{layout['layout_id']}: band-label counts must sum to image_count"
        )
        for lab in labels:
            assert isinstance(lab["text"], str)
            ext = lab["extent"]
            assert len(ext) == 4 and all(0.0 <= v <= 1.0 for v in ext)
            assert ext[0] <= ext[2] and ext[1] <= ext[3], "extent is [x0,y0,x1,y1]"
            assert "missing" not in lab, "the calib categorical columns have no null values"

    # DATETIME: exactly one time x-axis, ISO-8601 domain (ordered), [0,1] world range.
    dt = by_type["datetime"][0]
    axes = dt["annotations"]["axes"]
    assert len(axes) == 1, "the datetime layout carries one axis"
    axis = axes[0]
    assert axis["orientation"] == "x" and axis["scale"] == "time"
    assert len(axis["domain"]) == 2 and axis["domain"][0] < axis["domain"][1], "ordered ISO domain"
    # v2.7 (T2-142 / D-36 seam H3): the axis reports the RUNG it binned at, so the renderer's
    # ticks are the producer's own bin boundaries rather than a second, years-only ladder.
    # This fixture's 256 daily dates over 255 days resolve to MONTHS (its nine bins are the
    # nine contiguous months the README describes), so the literal doubles as a cross-check
    # that the advertised rung is the one the geometry was actually built on — a `day` or
    # `year` rung here would contradict the bin count this file already pins. `step` is
    # asserted explicitly because 1 is EMITTED, never implied by omission.
    assert axis["interval"] == {"kind": "month", "step": 1}, (
        f"the committed axis must report its bucketing rung; got {axis.get('interval')!r}"
    )
    # `range` is the PLACEMENT LINE (T2-138: with `domain` = [first bucket start, last bucket
    # start] it describes EXACTLY the line the calendar bucketing placed cells on, so every
    # bin lands on its own tick). Since H1 (D-36) it is not the full band [margin, 1-margin]:
    # it is [margin, margin + k_time*denom]. Since H2 a bin is `k` images WIDE and its tick is
    # the LEFT EDGE of that block, so the LAST bin's cells sit `k*p_c` to the RIGHT of
    # `range[1]` and the line never reaches 1-margin in any regime.
    #
    # REGIME, measured (not assumed — AGENT_GUIDE "Measured claims only"): this fixture was
    # the columns-bind case pre-H1 and the PACKED case between H1 and H2; since H2 it is
    # WIDTH-BOUND again, because wrapping its 31-deep bins into k = 2 blocks trades the depth
    # for width until the band binds. 256 cells over 255 days -> 9 month bins, 31 deep,
    # k = 2, 16 rows, p_c = 0.0427374533, range [0.04, 0.874525093].
    lo, hi = axis["range"]
    assert 0.0 <= lo < hi <= 1.0, "ordered [0,1] range"
    bbox = dt["bbox_exact"]
    # CONTAINMENT, changed by H2 and asserted in its new form: `range[0]` is the first block's
    # LEFT EDGE — a bar boundary — so it sits `0.5*p_c - side/2` to the LEFT of the first drawn
    # image, i.e. OUTSIDE `bbox_exact`; `range[1]` is the last bin's tick, so it sits
    # `(k - 0.5)*p_c + side/2` INSIDE `bbox_exact[2]`. Pre-H2 both endpoints were column
    # centres and the line lay inside the bbox at both ends.
    #
    # NOTE the gap is in terms of the DRAWN side, not of `fill*p_c`: those coincide only where
    # nothing caps the side, which is true of THIS fixture (0.5*0.0427374533 - 0.036326837/2 =
    # 0.003205309) and false wherever the `2*margin` or tightest-bin-spacing caps bind.
    assert lo < bbox[0] and hi < bbox[2], "range[0] left of the first image, range[1] inside"
    assert bbox[0] - lo == pytest.approx(0.003205309, abs=1e-9), (
        f"the first bin's tick must sit `0.5*p_c - side/2` left of the first drawn image, "
        f"got {bbox[0] - lo!r}"
    )
    # REGIME-SENSITIVE: the assertions above pass a `range` collapsed to a point, so on their
    # own they do not exercise the geometry this fixture exists to cover.
    #
    # `hi < 1 - lo` USED TO BE THAT GATE and is now a TAUTOLOGY (PR-198 review): H2's width
    # bound budgets the trailing block, so `range[1] <= 1 - margin - min(N_last, k)*p_c` holds
    # for EVERY dataset in EVERY regime — the schema says so in as many words. An assertion
    # that cannot fail cannot detect a regime flip, and this fixture flipped (columns-bind
    # before H1, packed between H1 and H2, WIDTH-BOUND now) with nothing noticing.
    #
    # What discriminates instead is that the BLOCK EDGE reaches the band while the LINE does
    # not: width-bound means `bbox_exact[2]` lands at `1 - margin` less one fill inset. A
    # stack-bound bake stops far short of it (the pre-H2 committed fixture stopped at 0.3004),
    # so this fails from the direction the old assertion could not see.
    assert bbox[2] == pytest.approx(1.0 - 0.04 - (0.5 * 0.0427374533 - 0.036326837 / 2),
                                    abs=1e-6), (
        "this fixture must be the WIDTH-BOUND regime — the last block's edge reaches the band "
        f"even though the line stops short of it; got bbox_exact[2]={bbox[2]!r}"
    )
    # The SPAN, which is what a half-cell edge/centre error actually moves, and what a `k`
    # solve landing on a different bin width would move most. (The full-precision endpoints
    # live in `packages/pipeline/tests/test_datetime_layout.py`; this tier only gets to see
    # the committed artifact, so a literal is the gate.) Pre-H2 this was 0.247238302.
    assert hi - lo == pytest.approx(0.834525093, abs=1e-9), (
        "the committed placement-line SPAN — a `range` reported over the cell edges rather "
        "than the block left edges is symmetric and would pass the containment checks above"
    )

    # grid / scatter / geographic emit NO annotations this seam (correctly scoped).
    for layout_type in ("grid", "scatter", "geographic"):
        for layout in by_type.get(layout_type, []):
            assert "annotations" not in layout, (
                f"{layout['layout_id']} ({layout_type}) must not carry annotations this seam"
            )


def test_full_fixture_carries_full_precision_bbox_exact() -> None:
    """v2.5 (T2-72 Seam 2): every layoutEntry of a FRESH 2.5 bake carries `bbox_exact` — the
    unrounded float64 bbox the tiler binned — so the aggregate count chips bin EXACTLY (PR
    #179 root cause: the 6-dp `bbox` drifts on boundary tiles). NOTE the scope (PR-180 review
    correction): this guarantee is about FRESH bakes, which this fixture is — a manifest
    stamped 2.5 by `append_manifest_layouts` (add-layouts) legitimately carries pre-2.5
    entries WITHOUT `bbox_exact`, byte-preserved; readers gate on field presence, never on
    manifest_version. Rounding `bbox_exact` back to 6 dp must reproduce `bbox`, and at least
    one layout's `bbox_exact` must genuinely DIFFER from its rounded `bbox` (proving higher
    precision was preserved, not a copy)."""
    manifest = _read_manifest(FIXTURES_DIR / FULL_FIXTURE)
    any_differ = False
    for layout in manifest["layouts"]:
        exact = layout.get("bbox_exact")
        assert exact is not None, f"{layout['layout_id']}: a 2.5 layout must carry bbox_exact"
        assert len(exact) == 4 and all(0.0 <= v <= 1.0 for v in exact)
        rounded = layout["bbox"]
        assert [round(v, 6) for v in exact] == rounded, (
            f"{layout['layout_id']}: round(bbox_exact, 6) must equal the rounded bbox"
        )
        if exact != rounded:
            any_differ = True
    assert any_differ, "no layout's bbox_exact differs from its rounded bbox — precision not preserved"


def test_full_fixture_carries_pyramid_dropped_total() -> None:
    """v2.5 (PR-180 review): every FRESH 2.5 layoutEntry carries `pyramid.dropped_total` —
    the bake's total subsampled-out cell count (the tiler always computed it; 0 lets the
    viewer skip its O(n) pile re-derivation). The calib SCATTER layout genuinely piles
    (the cell-size ceiling caps z_max=3 and one tile in-tile subsamples 177 — the known
    fixture pile the #180 verification re-derived); every other layout bakes clean. The
    emitted totals must agree with the per-tile `subsampled.dropped` sums the fine tiles
    carry — asserted here by re-summing the actual tiles, not trusting the manifest."""
    fixture = FIXTURES_DIR / FULL_FIXTURE
    manifest = _read_manifest(fixture)
    for layout in manifest["layouts"]:
        pyr = layout["pyramid"]
        dropped = pyr.get("dropped_total")
        assert dropped is not None, f"{layout['layout_id']}: a fresh 2.5 pyramid carries dropped_total"
        tile_sum = 0
        for z, _x, _y, body in _iter_pyramid_tiles(fixture / pyr["path"], pyr["levels"]):
            if z < pyr["z_cap"]:
                continue
            _image, arrow_bytes = _unpack_fine_body(body)
            tile_sum += _dropped_count(feather.read_table(io.BytesIO(arrow_bytes)))
        assert dropped == tile_sum, (
            f"{layout['layout_id']}: manifest dropped_total={dropped} != per-tile sum {tile_sum}"
        )
        if layout["type"] == "scatter":
            assert dropped == 177, "the known calib scatter pile (fixture ground truth)"
        else:
            assert dropped == 0, f"{layout['layout_id']}: only scatter piles in the calib fixture"


def test_full_fixture_nongrid_records_conform_and_reconcile() -> None:
    """cell_record conformance + the reconciled dense-id invariant, asserted
    specifically ACROSS the NON-GRID layouts (datetime/scatter/categorical). §5 checks
    every layout of every fixture, but the minimal golden has only grid — this pins
    that the non-grid layout coordinates (a time axis, an aspect-fit scatter with an
    unplaced strip, a treemap) each produce schema-valid records over the full dense id
    range. Scatter is the key case: its null-coordinate cells are placed in the
    unplaced strip (never dropped), so its fine-tile id union must still cover
    [0, image_count) exactly (dropped == 0 at this N)."""
    fixture = FIXTURES_DIR / FULL_FIXTURE
    manifest = _read_manifest(fixture)
    image_count = manifest["dataset_metadata"]["image_count"]
    validator = Draft202012Validator(_load_schema("cell_record.schema.json"), registry=_registry())

    nongrid = [layout for layout in manifest["layouts"] if layout["type"] != "grid"]
    assert nongrid, "full fixture has no non-grid layouts to check"
    for layout in nongrid:
        pyr = layout["pyramid"]
        z_cap = pyr["z_cap"]
        seen: set[int] = set()
        dropped = 0
        for z, x, y, body in _iter_pyramid_tiles(fixture / pyr["path"], pyr["levels"]):
            if z < z_cap:
                continue  # coarse (pixels only) — validated in §5
            _image, arrow_bytes = _unpack_fine_body(body)
            table = feather.read_table(io.BytesIO(arrow_bytes))
            dropped += _dropped_count(table)
            for row in table.to_pylist():
                validator.validate(row)  # id,x,y,w,h,u,v,uw,uh + reserved nulls in [0,1]
            seen.update(int(v) for v in table.column("id").to_pylist())
        assert seen <= set(range(image_count)), (
            f"{layout['layout_id']}: fine-tile ids stray outside [0,{image_count})"
        )
        assert len(seen) + dropped == image_count, (
            f"{layout['layout_id']}: |ids|={len(seen)} + dropped={dropped} != {image_count}"
        )


def test_full_fixture_scatter_places_unplaced_cells() -> None:
    """The scatter layout carries NULL-coordinate cells (the CSV `sx`/`sy` empties),
    which the scatter plugin places in the UNPLACED STRIP rather than dropping — so no
    unplaced id ever goes missing, and every id reconciles. Assert metadata.parquet
    actually carries the null-coord rows (the edge case is present in the fixture), that
    NONE of the unplaced cells were dropped, and that the fine-tile id union + the
    recorded coincident-point drops reconcile to the full dense range (v2.1).

    NB post-Seam-S1 (the median-centred, unclipped aspect fit — T2-35): the calib
    scatter's WIDE SPARSE TAIL compresses the dense bulk enough that the deepest fine
    tile in-tile SUBSAMPLES at the production cap=64 (the deep-dive's documented cap-64
    behaviour — spike_scatter_deep_dive.md), so the fine-tile id union is a strict
    SUBSET, reconciled by the recorded `dropped`. The drops fall in the dense pile, NOT
    the strip band (`y in [0.96, 1.0]`), so the unplaced-cell survival check still holds
    — that is the invariant this test pins."""
    fixture = FIXTURES_DIR / FULL_FIXTURE
    manifest = _read_manifest(fixture)
    image_count = manifest["dataset_metadata"]["image_count"]
    roles = manifest["column_roles"]
    assert roles.get("scatter"), "full fixture must declare a scatter role"
    x_col = roles["scatter"][0]["x_column"]
    y_col = roles["scatter"][0]["y_column"]

    meta = pq.read_table(fixture / "metadata.parquet")
    xs = meta.column(x_col).to_pylist()
    ys = meta.column(y_col).to_pylist()
    null_coord = [i for i in range(meta.num_rows) if xs[i] is None or ys[i] is None]
    assert null_coord, "scatter role has no null-coordinate rows — the unplaced-strip edge case is absent"

    scatter = next(layout for layout in manifest["layouts"] if layout["type"] == "scatter")
    pyr = scatter["pyramid"]
    seen: set[int] = set()
    dropped = 0
    for z, x, y, body in _iter_pyramid_tiles(fixture / pyr["path"], pyr["levels"]):
        if z < pyr["z_cap"]:
            continue
        _image, arrow_bytes = _unpack_fine_body(body)
        table = feather.read_table(io.BytesIO(arrow_bytes))
        dropped += _dropped_count(table)
        seen.update(int(v) for v in table.column("id").to_pylist())
    # Every null-coord (unplaced) id is still positioned in a fine tile (not dropped) —
    # the strip lives in the bottom band, a separate region from the dense pile that
    # subsamples, so an unplaced cell is never among the coincident-point drops.
    missing = [cid for cid in null_coord if cid not in seen]
    assert not missing, f"scatter dropped unplaced cell(s) {missing[:5]} instead of placing them in the strip"
    # Reconciliation (v2.1): |fine-tile ids| + recorded drops == the full dense range.
    assert len(seen) + dropped == image_count, (
        f"scatter |fine-tile ids|={len(seen)} + dropped={dropped} != image_count={image_count}"
    )
    # v2.6 (T2-140 / D-36 seam U1): the committed `missing_count` must EQUAL the unplaceable
    # set this test just derived from metadata.parquet. Without this the fixture's value is
    # only a literal transcribed from the same bake that produced it — the schema checks the
    # type, the refresh round-trips compare a derived value against an identical committed
    # one, and the frontend asserts the same transcribed number. The fixture is the
    # cross-package oracle, so a wrong count here would propagate to every consumer.
    assert scatter["missing_count"] == len(null_coord), (
        f"scatter missing_count={scatter['missing_count']} but {len(null_coord)} rows have a "
        f"null coordinate"
    )
    # The geographic family strands the same way, off its own role columns — the only other
    # committed non-zero count in this fixture, and until now it had no unplaced-cell test of
    # any kind.
    geo_role = roles["geographic"][0]
    lons = meta.column(geo_role["lon_column"]).to_pylist()
    lats = meta.column(geo_role["lat_column"]).to_pylist()
    null_geo = [i for i in range(meta.num_rows) if lons[i] is None or lats[i] is None]
    assert null_geo, "geographic role has no null-coordinate rows — the strip case is absent"
    geographic = next(la for la in manifest["layouts"] if la["type"] == "geographic")
    assert geographic["missing_count"] == len(null_geo), (
        f"geographic missing_count={geographic['missing_count']} but {len(null_geo)} rows "
        f"have a null coordinate"
    )
    # Every OTHER layout carries the key too — v2.6 emits it unconditionally, so a fully
    # placed layout says 0 rather than falling silent (absent is reserved for a pre-2.6
    # entry). This is what makes the presence gate decide something.
    for layout in manifest["layouts"]:
        assert "missing_count" in layout, (
            f"layout {layout['layout_id']!r} omits missing_count — every fresh 2.6 entry "
            f"must carry it, 0 included"
        )
        assert isinstance(layout["missing_count"], int) and layout["missing_count"] >= 0


def test_full_fixture_tags_sidecar_conforms_with_edge_cases() -> None:
    """The tags sidecar (D-14) conforms — an uncompressed Arrow IPC table of `id`
    (int64) + each tag column (list<string>) keyed by the dense id — and carries the
    tag edge cases the highlight path must handle: at least one cell with NO tags (a
    null/empty tag list — an empty CSV value) and at least one MULTI-VALUE cell. The
    minimal golden has only single-/dual-tag cells; this pins the empty + multi paths."""
    fixture = FIXTURES_DIR / FULL_FIXTURE
    manifest = _read_manifest(fixture)
    tags_decl = manifest.get("tags")
    assert tags_decl and tags_decl["format"] == "arrow", "full fixture must declare an arrow tags sidecar"
    roles = manifest["column_roles"]
    tag_cols = [entry["column"] for entry in roles.get("tag", [])]
    assert tag_cols, "full fixture must declare a tag role"

    sidecar = feather.read_table(fixture / tags_decl["path"])
    assert "id" in sidecar.column_names and sidecar.schema.field("id").type.equals(pa.int64())
    for col in tag_cols:
        assert col in sidecar.column_names, f"tags sidecar missing tag column {col!r}"
        assert sidecar.schema.field(col).type.equals(pa.list_(pa.string())), (
            f"tags sidecar column {col!r} is not list<string>"
        )
    # id space is the dense range [0, image_count) — the renderer scatters by id.
    ids = [int(v) for v in sidecar.column("id").to_pylist()]
    assert ids == list(range(manifest["dataset_metadata"]["image_count"])), "tags sidecar ids not dense [0,N)"

    # Edge cases in the primary tag column: >= 1 empty (null/[] — no tags) + >= 1 multi.
    values = sidecar.column(tag_cols[0]).to_pylist()
    empty = sum(1 for v in values if v is None or len(v) == 0)
    multi = sum(1 for v in values if v is not None and len(v) >= 2)
    assert empty >= 1, "tag column has no empty/no-tag cell — the empty edge case is absent"
    assert multi >= 1, "tag column has no multi-value cell — the multi-value edge case is absent"


# --- 8: the library-card cover (T2-55) --------------------------------------
# The pipeline writes an UNVERSIONED cover.webp (the grid pyramid's z=0 whole-world
# overview) at the dataset root, for the Library card. It is not in schemas/v2 (a
# cosmetic thumbnail, no manifest field), so these are structural fixture assertions:
# the full fixture — baked through the REAL pipeline — carries one that equals the grid
# z=0 tile's WebP bytes, and the minimal golden (baked before this feature via
# build_fixture.py) deliberately has none (the graceful-absence proof the API 404s on).


def _grid_z0_overview_webp(fixture: Path) -> bytes:
    """The grid pyramid's z=0 overview WebP bytes — the cover's source. For a coarse
    pyramid (z_cap > 0) the z=0 body IS the raw mosaic WebP; for an all-fine pyramid
    (z_cap == 0) the z=0 body is a fine bundle whose first member is the mini-atlas WebP
    (unwrapped here). Mirrors pipeline.tiler.read_overview_webp, inlined lean (no
    pyvips-importing module), like the fine-body framing already inlined above."""
    manifest = _read_manifest(fixture)
    grid = next(layout for layout in manifest["layouts"] if layout["layout_id"] == "grid")
    pyr = grid["pyramid"]
    with (fixture / pyr["path"]).open("rb") as fh:
        body = Reader(MmapSource(fh)).get(0, 0, 0)
    assert body is not None, "grid pyramid has no z=0 tile"
    if pyr["z_cap"] <= 0:
        image_bytes, _records = _unpack_fine_body(body)
        return image_bytes
    return body


def test_full_fixture_has_cover_equal_to_grid_z0_overview() -> None:
    """The comprehensive fixture (baked through the REAL pipeline) carries an unversioned
    cover.webp at the dataset root that IS the grid pyramid's z=0 whole-world overview
    (T2-55). This is the non-hollow proof that the cover write is wired into the real
    ingest path — and that the API serves the grid overview, not some other tile."""
    fixture = FIXTURES_DIR / FULL_FIXTURE
    cover = fixture / "cover.webp"
    assert cover.is_file(), f"full fixture missing cover.webp — regen it (see {fixture}/README.md)"
    assert cover.read_bytes()[:4] == b"RIFF", "cover.webp is not a WebP"
    assert cover.read_bytes() == _grid_z0_overview_webp(fixture), (
        "cover.webp != the grid pyramid's z=0 overview bytes"
    )


def test_minimal_golden_has_no_cover() -> None:
    """GRACEFUL-ABSENCE proof: the minimal golden_dataset_v2 is baked (via
    build_fixture.py) WITHOUT a cover — it is the pre-T2-55 absence fixture the API's
    404 + the card's flat-block fallback pin against. No cover.webp may be present."""
    assert not (FIXTURES_DIR / "golden_dataset_v2" / "cover.webp").exists(), (
        "minimal golden must have NO cover.webp (graceful-absence fixture)"
    )
