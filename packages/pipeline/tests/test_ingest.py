"""Tier-1 ingest tests (non-native: DuckDB/pyarrow only, no libvips/pmtiles).

Images-first (decision D-25): ingest scans filenames only, so EMPTY image-named
files suffice here; the native end-to-end test uses real images.
"""
from __future__ import annotations

import csv
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq
import pytest

from pipeline.ingest import (
    ColumnRoleError,
    ingest_metadata,
    write_positions_table,
    write_tags_sidecar,
)


def test_images_only_writes_id_filename_and_dims(tmp_path: Path, images_dir: Path, names: list[str]) -> None:
    result = ingest_metadata(images_dir, "ds", tmp_path / "out")

    assert result.column_roles is None  # images-only floor
    table = pq.read_table(result.metadata_path)
    # Base columns: id, filename + the D2 native pixel-dimension columns.
    assert set(table.schema.names) == {"id", "filename", "width", "height"}
    assert table.schema.field("id").type.equals(pa.int64())
    assert table.schema.field("filename").type.equals(pa.string())
    # width/height are nullable int32 (Seam D2). The conftest images_dir holds EMPTY
    # files (ingest scans filenames only), so every header is unreadable and the dims
    # are null here — this pins the schema + the unreadable→null contract; the native
    # test (test_ingest_dims.py) proves real, orientation-corrected values.
    assert table.schema.field("width").type.equals(pa.int32())
    assert table.schema.field("height").type.equals(pa.int32())
    assert table.column("width").to_pylist() == [None] * len(names)
    assert table.column("height").to_pylist() == [None] * len(names)
    # id is assigned by sorted filename.
    assert table.column("id").to_pylist() == list(range(len(names)))
    assert table.column("filename").to_pylist() == sorted(names)


def test_empty_image_set_raises(tmp_path: Path) -> None:
    empty = tmp_path / "images"
    empty.mkdir()
    with pytest.raises(ValueError):
        ingest_metadata(empty, "ds", tmp_path / "out")


def test_duplicate_basenames_raise(tmp_path: Path, images_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A flat scan can't produce duplicate basenames from the filesystem, so drive
    # the guard directly: make the scan see two same-named entries.
    class _Entry:
        def __init__(self, name: str) -> None:
            self.name = name
            self.suffix = Path(name).suffix

        def is_file(self) -> bool:
            return True

    monkeypatch.setattr(Path, "iterdir", lambda self: [_Entry("dup.webp"), _Entry("dup.webp")])
    with pytest.raises(ValueError):
        ingest_metadata(images_dir, "ds", tmp_path / "out")


def test_metadata_left_joined_by_filename(
    tmp_path: Path, images_dir: Path, metadata_csv: Path, column_roles: dict
) -> None:
    result = ingest_metadata(images_dir, "ds", tmp_path / "out", metadata_csv, column_roles)

    assert result.column_roles is not None
    assert result.column_roles.filename.column == "filename"
    schema = pq.read_table(result.metadata_path).schema
    assert schema.field("id").type.equals(pa.int64())
    assert schema.field("filename").type.equals(pa.string())
    assert schema.field("tags").type.equals(pa.list_(pa.string()))  # split to list<string> (D-14)


def test_tags_sidecar_is_uncompressed_arrow(
    tmp_path: Path, images_dir: Path, metadata_csv: Path, column_roles: dict
) -> None:
    # D-29: browser-read Arrow must be uncompressed (apache-arrow JS cannot decode
    # compressed record batches). pyarrow itself reads LZ4 transparently, so a
    # tolerant read-back cannot catch a regression to write_feather's compressed
    # default; instead assert the file is byte-identical to an uncompressed
    # re-write of its own contents — an LZ4 file re-encodes to different bytes.
    # (renderer_tags.test.ts strict-decodes the *fixture* sidecar; this is the
    # equivalent gate on the real producer.)
    result = ingest_metadata(images_dir, "ds", tmp_path / "out", metadata_csv, column_roles)
    assert result.column_roles is not None
    sidecar = write_tags_sidecar(
        result.metadata_path, result.column_roles, tmp_path / "out" / "tags" / "tags_v1.arrow"
    )
    assert sidecar is not None  # the conftest roles carry a tag column

    buf = pa.BufferOutputStream()
    feather.write_feather(feather.read_table(sidecar), buf, compression="uncompressed")
    assert sidecar.read_bytes() == buf.getvalue().to_pybytes()


def _layout_cells(order: list[int]) -> pa.Table:
    """A minimal LayoutResult.cells table (id + x,y,w,h + the reserved nulls) whose id
    column is `order` — used to prove write_positions_table reorders rows by id so the
    row index == dense cell id regardless of the layout's emission order."""
    n = len(order)
    # A distinct rect per id so a mis-ordering is detectable: x = id/10, etc.
    return pa.table(
        {
            "id": pa.array(order, pa.int64()),
            "x": pa.array([oid / 10 for oid in order], pa.float32()),
            "y": pa.array([oid / 100 for oid in order], pa.float32()),
            "w": pa.array([0.05] * n, pa.float32()),
            "h": pa.array([0.06] * n, pa.float32()),
            "color": pa.array([None] * n, pa.int32()),
            "cluster_id": pa.array([None] * n, pa.int32()),
            "edge_count": pa.array([None] * n, pa.int32()),
            "embedding_dim": pa.array([None] * n, pa.int32()),
        }
    )


def test_positions_table_is_dense_uncompressed_arrow(tmp_path: Path) -> None:
    """T2-66/T2-48 (v2.2): the position table has EXACTLY (x,y,w,h) float32 columns
    (no id column), the ROW INDEX is the dense cell id (rows reordered by id even from a
    shuffled layout emission order), and it is UNCOMPRESSED Arrow (D-29)."""
    out = tmp_path / "positions" / "grid_v1.arrow"
    # Shuffle the emission order to prove the reorder-by-id: row i must still be id i.
    cells = _layout_cells([2, 0, 3, 1])
    path = write_positions_table(cells, 4, out)
    assert path == out

    table = feather.read_table(path)
    assert table.schema.names == ["x", "y", "w", "h"]  # NO id column
    assert all(table.schema.field(c).type == pa.float32() for c in ("x", "y", "w", "h"))
    assert table.num_rows == 4
    # Row i carries cell id i's rect: x[i] == i/10, y[i] == i/100 (float32-rounded).
    xs = table.column("x").to_pylist()
    ys = table.column("y").to_pylist()
    import struct

    def f32(v: float) -> float:
        return struct.unpack("f", struct.pack("f", v))[0]

    assert xs == [f32(i / 10) for i in range(4)]
    assert ys == [f32(i / 100) for i in range(4)]

    # D-29: uncompressed — byte-identical to an uncompressed re-write of its contents
    # (an LZ4 default would re-encode to different bytes).
    buf = pa.BufferOutputStream()
    feather.write_feather(table, buf, compression="uncompressed")
    assert path.read_bytes() == buf.getvalue().to_pybytes()


def test_positions_table_rejects_non_dense_ids(tmp_path: Path) -> None:
    """The row-index==id encoding requires the id set to be exactly [0, image_count).
    A hole (or a wrong count) is a hard error, not a silently-misaligned table."""
    out = tmp_path / "positions" / "grid_v1.arrow"
    # ids {0,1,3} with image_count 4 — id 2 is missing (a hole).
    holed = _layout_cells([0, 1, 3])
    with pytest.raises(ValueError, match="dense range"):
        write_positions_table(holed, 4, out)
    assert not out.exists()  # nothing written on the guard


def test_bad_config_raises(tmp_path: Path, images_dir: Path, metadata_csv: Path) -> None:
    bad = {"filename": {"column": "filename"}}  # roleEntry requires both column and label
    with pytest.raises(ColumnRoleError):
        ingest_metadata(images_dir, "ds", tmp_path / "out", metadata_csv, bad)


def test_unparseable_datetime_raises(
    tmp_path: Path, images_dir: Path, metadata_csv: Path, column_roles: dict
) -> None:
    # Point the datetime role at the (non-datetime) category column: its values
    # ("red"/"blue"/...) do not parse under iso8601 -> fail fast at ingest (gap #9).
    column_roles["datetime"] = {"column": "category", "label": "Cat", "format": "iso8601"}
    with pytest.raises(ColumnRoleError):
        ingest_metadata(images_dir, "ds", tmp_path / "out", metadata_csv, column_roles)


def test_enrichment_columns_shadowing_reserved_are_namespaced(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # A metadata source whose join key is some other column ("path") but which also
    # carries columns literally named "id" and "filename" must NOT clobber the
    # pipeline's canonical keys. They are preserved beside them under derived names
    # and their roles are repointed there (code-review follow-up, PR #12).
    meta = tmp_path / "meta.csv"
    with meta.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["path", "id", "filename"])
        for i, name in enumerate(sorted(names)):
            writer.writerow([name, f"ext-{i}", f"caption-{i}"])
    roles = {
        "filename": {"column": "path", "label": "Path"},  # join key is "path", not "filename"
        "freeform": [
            {"column": "id", "label": "External ID"},
            {"column": "filename", "label": "Caption"},
        ],
    }

    result = ingest_metadata(images_dir, "ds", tmp_path / "out", meta, roles)
    table = pq.read_table(result.metadata_path)

    # Canonical keys survive intact: int64 id 0..n-1 and the real image basenames.
    assert table.schema.field("id").type.equals(pa.int64())
    assert table.column("id").to_pylist() == list(range(len(names)))
    assert table.column("filename").to_pylist() == sorted(names)

    # The user's like-named columns are preserved under derived names...
    assert table.column("meta_id").to_pylist() == [f"ext-{i}" for i in range(len(names))]
    assert table.column("meta_filename").to_pylist() == [f"caption-{i}" for i in range(len(names))]

    # ...and the roles now point at the physical columns the API will query.
    assert result.column_roles is not None
    assert result.column_roles.filename.column == "filename"  # canonical, after rebind
    assert {e.column for e in result.column_roles.freeform} == {"meta_id", "meta_filename"}


def test_enrichment_width_height_shadowing_reserved_are_namespaced(
    tmp_path: Path, images_dir: Path, names: list[str]
) -> None:
    # A metadata source carrying columns literally named "width"/"height" must NOT
    # clobber the pipeline's native-dimension columns (Seam D2). They are preserved
    # beside them under derived names (meta_width/meta_height) and their roles
    # repointed there — the SAME reserved-collision rule as id/filename (PR #12).
    meta = tmp_path / "meta.csv"
    with meta.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "width", "height"])
        for i, name in enumerate(sorted(names)):
            writer.writerow([name, f"w-{i}", f"h-{i}"])
    roles = {
        "filename": {"column": "filename", "label": "Filename"},
        "freeform": [
            {"column": "width", "label": "Width text"},
            {"column": "height", "label": "Height text"},
        ],
    }

    result = ingest_metadata(images_dir, "ds", tmp_path / "out", meta, roles)
    table = pq.read_table(result.metadata_path)

    # The pipeline's native-dimension columns survive as nullable int32 (null on the
    # empty fixture files) — never overwritten by the user's like-named columns.
    assert table.schema.field("width").type.equals(pa.int32())
    assert table.schema.field("height").type.equals(pa.int32())
    assert table.column("width").to_pylist() == [None] * len(names)

    # The user's like-named columns are preserved under derived names...
    assert table.column("meta_width").to_pylist() == [f"w-{i}" for i in range(len(names))]
    assert table.column("meta_height").to_pylist() == [f"h-{i}" for i in range(len(names))]

    # ...and the roles now point at the physical columns the API will query.
    assert result.column_roles is not None
    assert {e.column for e in result.column_roles.freeform} == {"meta_width", "meta_height"}
