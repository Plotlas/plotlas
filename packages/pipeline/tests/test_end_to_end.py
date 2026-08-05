"""Headline native tests: run_ingest produces a schemas/v2-conformant
/datasets/{ds_id}/ tree for BOTH an images-only input and an images+metadata input
(the latter with a scatter pair + two categorical columns — R1 seam acceptance).

v2 (decision D-33): each layout owns one PMTiles spatial-tile-pyramid container
(tiles/{layout_id}/{layout_id}_v{version}.pmtiles) — there is no shared atlas tree
and no per-LOD cells/.../lod{n}/ tree. The manifest declares manifest_version
"2.7" and a per-layout `pyramid` descriptor (+ optional `detail` / `positions_ref`
/ `options` / `annotations` / `bbox_exact`).

NATIVE: needs libvips (pyvips) + pmtiles, so it is marked `native` (selected by
`make test-pipeline -m native`) and skipped in the lean test image via importorskip.
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import jsonschema
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq
import pytest
from referencing import Registry, Resource

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline.tiler import (  # noqa: E402
    iter_tiles,
    read_subsampled_dropped,
    unpack_fine_body,
)
from pipeline.worker import IngestJobPayload, run_ingest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "schemas" / "v2"  # the in-force MAJOR contract (D-33); pipeline writes 2.2


def _image_names(n: int) -> list[str]:
    return [f"img_{i:03d}.webp" for i in range(n)]


def _build_images(images_dir: Path, names: list[str]) -> None:
    images_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        rgb = [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256]
        image = (pyvips.Image.black(64, 64, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
        image.webpsave(str(images_dir / name))


def _validate_manifest(manifest: dict) -> None:
    schema = json.loads((SCHEMA_DIR / "layout_manifest.schema.json").read_text(encoding="utf-8"))

    def retrieve(uri: str) -> Resource:
        name = uri.rsplit("/", 1)[-1]
        return Resource.from_contents(json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8")))

    jsonschema.Draft202012Validator(
        schema,
        registry=Registry(retrieve=retrieve),
        format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
    ).validate(manifest)


def _assert_pyramids(dataset_dir: Path, manifest: dict, expected_ids: set[str], image_count: int) -> None:
    assert {layout["layout_id"] for layout in manifest["layouts"]} == expected_ids
    for layout in manifest["layouts"]:
        pyramid = layout["pyramid"]
        assert pyramid["container"] == "pmtiles"
        # cap == floor(tile_px/thumb_px)^2 ; thumb_px <= tile_px (v2 invariants).
        per_axis = pyramid["tile_px"] // pyramid["thumb_px"]
        assert pyramid["cap"] == per_axis * per_axis
        assert pyramid["thumb_px"] <= pyramid["tile_px"]
        pm = dataset_dir / pyramid["path"]
        assert pm.exists(), f"{layout['layout_id']}: PMTiles container missing at {pm}"
        # RECONCILED dense-id invariant (v2.1): the distinct fine-tile ids are a SUBSET
        # of [0, image_count), and |distinct ids| + sum(subsampled.dropped) ==
        # image_count. With no subsampling (these spread fixtures) dropped == 0 and the
        # union is the full range; the subsample test below exercises dropped > 0.
        z_cap = pyramid["z_cap"]
        fine_levels = [lv for lv in pyramid["levels"] if lv["z"] >= z_cap]
        ids: set[int] = set()
        dropped = 0
        detail_refs: dict[int, str] = {}
        fine_rects: dict[int, tuple[float, float, float, float]] = {}
        for z, x, y, body in iter_tiles(pm, fine_levels):
            _, arrow_bytes = unpack_fine_body(body)
            table = feather.read_table(io.BytesIO(arrow_bytes))
            ids.update(int(v) for v in table.column("id").to_pylist())
            for row in table.to_pylist():
                fine_rects[int(row["id"])] = (row["x"], row["y"], row["w"], row["h"])
                if row["detail_ref"] is not None:
                    detail_refs[int(row["id"])] = row["detail_ref"]
            dropped += read_subsampled_dropped(table)
        assert ids <= set(range(image_count)), (
            f"{layout['layout_id']}: fine-tile ids stray outside [0,{image_count})"
        )
        assert len(ids) + dropped == image_count, (
            f"{layout['layout_id']}: |fine-tile ids|={len(ids)} + dropped={dropped} "
            f"!= image_count={image_count}"
        )
        # POSITION TABLE (T2-66/T2-48, v2.2): every layout carries a positions_ref, an
        # uncompressed Arrow table of (x,y,w,h) float32 with ROW INDEX == dense cell id
        # (no id column). It spans the FULL dense range [0, image_count) — including any
        # coincident-subsampled id absent from the fine tiles (its metadata row + dense
        # id survive; only its fine-tile record is dropped). Where a cell DOES carry a
        # fine record, the table's rect must equal the fine record's x/y/w/h exactly
        # (same source — the layout result — never re-derived).
        _assert_positions_table(dataset_dir, layout, image_count, fine_rects)
        # CONTRACT PIN — api/routers/tiles.py::get_detail resolves a detail original
        # by RECONSTRUCTING `{detail.path_prefix}/{cell_id}.{format}` instead of
        # reading the cell's detail_ref (the API read path cannot see tile records).
        # That only holds while the producer's detail_ref IS exactly `{id}.{format}`.
        # Pin it here so a future detail-naming change (e.g. content-hash subdirs to
        # avoid a 1M-file flat dir) fails THIS test rather than silently 404-ing the
        # live API. schemas/v2 cell_record.detail_ref is relative to path_prefix.
        detail = layout.get("detail")
        if isinstance(detail, dict) and detail.get("mode") == "image_ref":
            fmt = detail["format"]
            assert detail_refs, (
                f"{layout['layout_id']}: detail block present but no fine-tile record "
                "carried a detail_ref — the contract pin below would be vacuous"
            )
            for rid, ref in detail_refs.items():
                assert ref == f"{rid}.{fmt}", (
                    f"{layout['layout_id']}: detail_ref {ref!r} for id {rid} "
                    f"!= the API's reconstructed {rid}.{fmt}"
                )


def _assert_positions_table(
    dataset_dir: Path,
    layout: dict,
    image_count: int,
    fine_rects: dict[int, tuple[float, float, float, float]],
) -> None:
    """T2-66/T2-48 (v2.2): the layout carries a positions_ref pointing at an
    uncompressed Arrow table with exactly (x,y,w,h) float32 columns and NO id column
    (row index == dense cell id). Its row count == image_count, and every row that
    corresponds to a fine-tile record matches that record's rect exactly."""
    ref = layout.get("positions_ref")
    assert ref is not None, f"{layout['layout_id']}: missing positions_ref (v2.2)"
    # Version-stamped path convention: positions/{layout_id}_v{version}.arrow.
    assert ref == f"positions/{layout['layout_id']}_v1.arrow", (
        f"{layout['layout_id']}: unexpected positions_ref {ref!r}"
    )
    path = dataset_dir / ref
    assert path.is_file(), f"{layout['layout_id']}: position table missing at {path}"

    table = feather.read_table(path)
    # Exactly the four spatial float32 columns; the row index IS the id (no id column).
    assert table.schema.names == ["x", "y", "w", "h"], (
        f"{layout['layout_id']}: position table columns {table.schema.names} != [x,y,w,h]"
    )
    for col in ("x", "y", "w", "h"):
        assert table.schema.field(col).type == pa.float32(), (
            f"{layout['layout_id']}: position column {col} is {table.schema.field(col).type}, not float32"
        )
    assert table.num_rows == image_count, (
        f"{layout['layout_id']}: position table has {table.num_rows} rows != image_count {image_count}"
    )
    xs = table.column("x").to_pylist()
    ys = table.column("y").to_pylist()
    ws = table.column("w").to_pylist()
    hs = table.column("h").to_pylist()
    # Row i is cell id i: where the fine tier carried a record for id i, the position
    # table's rect must equal it exactly (same float32 source — the layout result).
    for cid, (fx, fy, fw, fh) in fine_rects.items():
        assert (xs[cid], ys[cid], ws[cid], hs[cid]) == (fx, fy, fw, fh), (
            f"{layout['layout_id']}: position row {cid} {(xs[cid], ys[cid], ws[cid], hs[cid])} "
            f"!= fine record {(fx, fy, fw, fh)}"
        )


def test_images_only_ingest(tmp_path: Path, fixture_n: int) -> None:
    names = _image_names(fixture_n)
    _build_images(tmp_path / "images", names)
    output_root = tmp_path / "out"

    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=tmp_path / "images",
            csv_path=None,
            column_roles=None,
            layout_types=["grid"],
            output_root=output_root,
        )
    )
    assert version == "1"

    dataset_dir = output_root / "ds"
    assert not list(output_root.glob(".staging-*"))  # committed by one atomic rename

    manifest = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    _validate_manifest(manifest)
    assert manifest["manifest_version"] == "2.8"
    assert "column_roles" not in manifest                      # images-only floor (D-25)
    assert "source" not in manifest["dataset_metadata"]
    assert "tags" not in manifest
    assert "atlas" not in manifest                             # v2: no shared atlas block
    _assert_pyramids(dataset_dir, manifest, {"grid"}, fixture_n)

    table = pq.read_table(dataset_dir / "metadata.parquet")
    # Base columns: id, filename + the D2 native pixel-dimension columns.
    assert set(table.schema.names) == {"id", "filename", "width", "height"}
    assert table.column("filename").to_pylist() == sorted(names)
    # Native dims (Seam D2): _build_images writes 64×64 WebPs → recorded int32 dims.
    assert table.schema.field("width").type.equals(pa.int32())
    assert table.column("width").to_pylist() == [64] * fixture_n
    assert table.column("height").to_pylist() == [64] * fixture_n
    assert manifest["dataset_metadata"]["image_count"] == fixture_n
    assert not (dataset_dir / "atlas").exists()                # v1 atlas tree is gone
    assert not (dataset_dir / "tags").exists()
    # Detail tier (T2-26): originals transcoded under the VERSION-STAMPED
    # detail/v{version}/ (T2-46) and referenced.
    assert (dataset_dir / "detail" / "v1").is_dir()
    # LIBRARY-CARD COVER (T2-55): the UNVERSIONED cover.webp is written from the grid
    # pyramid's z=0 whole-world overview tile (grid is always baked, D-25). It IS that
    # tile's WebP bytes, and no stray temp is left by the atomic write.
    cover = dataset_dir / "cover.webp"
    assert cover.is_file() and cover.read_bytes()[:4] == b"RIFF"
    grid_pyr = next(lv for lv in manifest["layouts"] if lv["layout_id"] == "grid")["pyramid"]
    from pipeline.tiler import read_overview_webp
    assert cover.read_bytes() == read_overview_webp(dataset_dir / grid_pyr["path"], grid_pyr["z_cap"])
    assert not (dataset_dir / "cover.webp.tmp").exists()


def test_images_with_metadata_ingest(
    tmp_path: Path, fixture_n: int, metadata_csv: Path, column_roles: dict
) -> None:
    names = _image_names(fixture_n)
    _build_images(tmp_path / "images", names)
    output_root = tmp_path / "out"

    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=tmp_path / "images",
            csv_path=metadata_csv,
            column_roles=column_roles,
            layout_types=["grid", "datetime", "categorical", "scatter"],
            output_root=output_root,
        )
    )
    assert version == "1"

    dataset_dir = output_root / "ds"
    manifest = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    _validate_manifest(manifest)
    assert manifest["manifest_version"] == "2.8"

    # Metadata present: column_roles (with the filename role), the tag sidecar, and
    # the datetime/categorical/scatter layouts are all emitted. The two categorical
    # columns (category, place) each become their own layout (reconciliation #9); the
    # single scatter pair keeps the bare "scatter" layout id (D-26).
    assert manifest["column_roles"]["filename"]["column"] == "filename"
    _assert_pyramids(
        dataset_dir,
        manifest,
        {"grid", "datetime", "categorical_category", "categorical_place", "scatter"},
        fixture_n,
    )
    assert (dataset_dir / manifest["tags"]["path"]).exists()  # tag sidecar (input has a tag role)
    assert manifest["dataset_metadata"]["source"] == metadata_csv.name

    schema = pq.read_table(dataset_dir / "metadata.parquet").schema
    assert schema.field("filename").type.equals(pa.string())
    assert schema.field("tags").type.equals(pa.list_(pa.string()))
    # detail.mode=image_ref is declared per layout when the detail tier is baked;
    # path_prefix is VERSION-STAMPED (T2-46).
    for layout in manifest["layouts"]:
        assert layout["detail"]["mode"] == "image_ref"
        assert layout["detail"]["path_prefix"] == "detail/v1/"


def test_undecodable_image_densifies_ids(
    tmp_path: Path, fixture_n: int, metadata_csv: Path, column_roles: dict
) -> None:
    """The dense-id REMAP branch (worker._densify_ids, `if not already_dense`): an
    undecodable image consumes NO id, the survivors are renumbered to a contiguous
    [0, N-1), and metadata.parquet + the tag sidecar are re-keyed so the filename
    join is preserved. This is the most intricate v2 code and the whole id contract
    rests on it; the all-decodable tests never exercise the remap branch.

    A zero-byte file with an image extension fails to decode (pyvips raises ->
    skip-and-log), so id `bad_pos` is dropped and every higher id shifts down by 1.
    """
    names = _image_names(fixture_n)
    images = tmp_path / "images"
    _build_images(images, names)
    bad_pos = fixture_n // 2  # corrupt a middle image so a real shift happens
    bad_name = names[bad_pos]
    (images / bad_name).write_bytes(b"")  # zero-byte => undecodable
    survivors = [n for n in names if n != bad_name]  # sorted-filename order, minus the bad one

    output_root = tmp_path / "out"
    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=metadata_csv,
            column_roles=column_roles,
            layout_types=["grid"],
            output_root=output_root,
        )
    )
    assert version == "1"
    dataset_dir = output_root / "ds"
    manifest = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    _validate_manifest(manifest)

    # The failed image consumed no id: image_count == survivors, ids dense [0, N-1).
    expected_count = fixture_n - 1
    assert manifest["dataset_metadata"]["image_count"] == expected_count
    _assert_pyramids(dataset_dir, manifest, {"grid"}, expected_count)

    # metadata.parquet is re-keyed to the survivors only, dense-id ordered.
    meta = pq.read_table(dataset_dir / "metadata.parquet")
    assert meta.column("id").to_pylist() == list(range(expected_count))
    assert meta.column("filename").to_pylist() == survivors  # bad filename dropped, order preserved

    # The tag sidecar is re-keyed to the same dense ids (the filename join holds).
    tags_table = feather.read_table(dataset_dir / manifest["tags"]["path"])
    assert tags_table.column("id").to_pylist() == list(range(expected_count))

    # Detail tier (VERSION-STAMPED, T2-46): one transcoded original per surviving
    # dense id (the bad one absent), under the manifest's version-stamped path_prefix.
    detail_prefix = manifest["layouts"][0]["detail"]["path_prefix"]
    assert detail_prefix == "detail/v1/"
    detail_files = sorted(p.name for p in (dataset_dir / detail_prefix).glob("*.webp"))
    assert detail_files == sorted(f"{i}.webp" for i in range(expected_count))


def test_coincident_scatter_subsamples_through_run_ingest(tmp_path: Path) -> None:
    """Item 1d / the v2.1 reconciliation, exercised THROUGH run_ingest: a scatter
    layout whose > cap cells all share one coordinate cannot separate by
    subdivision, so the deepest fine tile in-tile subsamples to cap and records the
    drop. The dense id NUMBERING stays [0, image_count) with no holes; the fine-tile
    id union is a STRICT subset; |union| + dropped == image_count. The subsampled
    (dropped) cells keep their metadata row AND remain reachable via the detail tier.

    This makes the subsample path non-hollow on the real ingest pipeline (the
    committed fixtures are N << cap, so subsampling never fires there)."""
    import csv

    n = 80  # > cap (= 64) coincident scatter points
    names = _image_names(n)
    _build_images(tmp_path / "images", names)

    # Metadata: every cell at the SAME scatter coordinate (degenerate scatter).
    csv_path = tmp_path / "meta.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "x", "y"])
        for name in names:
            writer.writerow([name, "1.0", "1.0"])  # identical => coincident
    roles = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [{"x_column": "x", "y_column": "y", "label": "Coincident"}],
    }

    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=tmp_path / "images",
            csv_path=csv_path,
            column_roles=roles,
            layout_types=["scatter"],
            output_root=output_root,
        )
    )
    dataset_dir = output_root / "ds"
    manifest = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    _validate_manifest(manifest)
    assert manifest["dataset_metadata"]["image_count"] == n  # all decoded => dense [0,n)

    scatter = next(lv for lv in manifest["layouts"] if lv["layout_id"] == "scatter")
    pyr = scatter["pyramid"]
    pm = dataset_dir / pyr["path"]
    z_cap = pyr["z_cap"]
    assert z_cap == 0, "fully-coincident scatter never separates by subdivision → occupancy-aware ceiling stops at z_cap=0"

    fine_ids: set[int] = set()
    dropped = 0
    for z, x, y, body in iter_tiles(pm, [lv for lv in pyr["levels"] if lv["z"] >= z_cap]):
        _, arrow_bytes = unpack_fine_body(body)
        table = feather.read_table(io.BytesIO(arrow_bytes))
        fine_ids.update(int(v) for v in table.column("id").to_pylist())
        dropped += read_subsampled_dropped(table)

    assert dropped == n - pyr["cap"], f"expected {n - pyr['cap']} dropped, got {dropped}"
    assert len(fine_ids) == pyr["cap"], "the single coincident fine tile holds exactly cap cells"
    assert fine_ids < set(range(n)), "fine-tile id union must be a STRICT subset under subsampling"
    assert len(fine_ids) + dropped == n, "reconciled: |fine ids| + dropped == image_count"

    # The dropped ids keep their metadata row AND a detail-tier original (reachable),
    # under the manifest's VERSION-STAMPED detail path_prefix (T2-46).
    dropped_ids = set(range(n)) - fine_ids
    meta_ids = set(int(v) for v in pq.read_table(dataset_dir / "metadata.parquet").column("id").to_pylist())
    assert dropped_ids <= meta_ids, "dropped ids must remain in metadata.parquet"
    detail_prefix = scatter["detail"]["path_prefix"]
    detail_ids = {int(p.stem) for p in (dataset_dir / detail_prefix).glob("*.webp")}
    assert dropped_ids <= detail_ids, "dropped ids must remain reachable via the detail tier"
