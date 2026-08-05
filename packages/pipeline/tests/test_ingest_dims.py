"""Native ingest tests for the Seam D2 native-dimension probe.

Real images are required to exercise the libvips header probe (native pixel dims,
EXIF-orientation swap, unreadable-header → null), so this module is `native` and
runs only in the worker image (`make test-pipeline -m native`); the lean test image
skips it via importorskip. The non-native schema + reserved-namespacing assertions
live alongside the other ingest tests in test_ingest.py.
"""
from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when libvips is absent

from pipeline.ingest import ingest_metadata  # noqa: E402


def _solid(path: Path, width: int, height: int, orientation: int | None = None) -> None:
    """Write a solid ``width``×``height`` image at ``path`` (format inferred from the
    extension), optionally stamping an EXIF ``orientation`` (1-8). The field is
    created with ``set_type`` — libvips raises on ``set()`` for an absent field."""
    img = (pyvips.Image.black(width, height, bands=3) + [180, 60, 20]).cast(
        "uchar"
    ).copy(interpretation="srgb")
    if orientation is not None:
        img = img.copy()  # private copy before mutating metadata
        img.set_type(pyvips.GValue.gint_type, "orientation", orientation)
    img.write_to_file(str(path))


def _dims_by_name(metadata_path: Path) -> dict[str, tuple[int | None, int | None]]:
    table = pq.read_table(metadata_path)
    return {
        fn: (w, h)
        for fn, w, h in zip(
            table.column("filename").to_pylist(),
            table.column("width").to_pylist(),
            table.column("height").to_pylist(),
        )
    }


def test_probe_records_native_dimensions(tmp_path: Path) -> None:
    """A fresh ingest records each image's native pixel width/height as nullable
    int32 (Seam D2), keyed by the sorted-filename id."""
    images = tmp_path / "images"
    images.mkdir()
    _solid(images / "a.png", 200, 100)  # id 0
    _solid(images / "b.png", 64, 96)    # id 1

    result = ingest_metadata(images, "ds", tmp_path / "out")
    table = pq.read_table(result.metadata_path)

    assert set(table.schema.names) == {"id", "filename", "width", "height"}
    assert table.schema.field("width").type.equals(pa.int32())
    assert table.schema.field("height").type.equals(pa.int32())
    assert table.column("filename").to_pylist() == ["a.png", "b.png"]
    assert table.column("width").to_pylist() == [200, 64]
    assert table.column("height").to_pylist() == [100, 96]


def test_probe_swaps_dims_for_exif_orientation(tmp_path: Path) -> None:
    """EXIF orientation 6 (90° CW) transposes the image: libvips reports the RAW
    200×100 + an orientation tag, and thumbnail() auto-rotates to a 100×200 display —
    so the recorded dims must be the swapped 100×200 (matching what the thumbnail and
    detail-tier files, which are post-orientation, show). A control image with no tag
    keeps its stored axes."""
    images = tmp_path / "images"
    images.mkdir()
    # JPEG carries the EXIF orientation reliably; the raw stored dims are 200×100.
    _solid(images / "rot.jpg", 200, 100, orientation=6)
    _solid(images / "flat.jpg", 200, 100)  # no orientation tag → no swap

    result = ingest_metadata(images, "ds", tmp_path / "out")
    dims = _dims_by_name(result.metadata_path)
    assert dims["rot.jpg"] == (100, 200)   # swapped for orientation 6
    assert dims["flat.jpg"] == (200, 100)  # stored axes preserved


def test_unreadable_header_records_null_dims_without_raising(tmp_path: Path) -> None:
    """An image whose header cannot be read records (null, null) and NEVER blocks
    ingest: the row is still written (the image is decode-skipped later, unchanged)
    and good siblings keep their real dims."""
    images = tmp_path / "images"
    images.mkdir()
    _solid(images / "good.png", 48, 72)
    (images / "zzz_bad.png").write_bytes(b"not a real image")  # unreadable header

    result = ingest_metadata(images, "ds", tmp_path / "out")  # must not raise
    dims = _dims_by_name(result.metadata_path)
    assert dims["good.png"] == (48, 72)
    assert dims["zzz_bad.png"] == (None, None)  # unreadable → null, still ingested
