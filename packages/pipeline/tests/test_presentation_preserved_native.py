"""END-TO-END proof that a bake leaves `presentation.json` alone (D-xv / INTAKE_REDESIGN §6c).

The lean module `test_presentation_record.py` pins the publish FUNCTIONS — `_commit`,
`_commit_one_layout`, `run_refresh_manifest`. This one runs the two real bake entry points
over real images, because the plan's own "done when" is stated end-to-end: *a re-bake of a
dataset leaves its name and credit untouched*. Between the publish function and the entry
point sit the staging sweep, the stale-asset sweeps (detail/tiles/tags/positions) and the
per-layout commit loop, none of which the function-level pins exercise.

It also pins the other half of rule 3 — the pipeline never WRITES the file — by baking a
dataset that has none and asserting none appears.

NATIVE: needs libvips (pyvips) + pmtiles, so marked `native` and skipped in the lean image.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline.worker import (  # noqa: E402
    AddLayoutsJobPayload,
    IngestJobPayload,
    run_add_layouts,
    run_ingest,
)

# Deliberately NOT canonical JSON — trailing spaces, no trailing newline, an order no
# serializer would choose. The claim is that the bake leaves the BYTES alone, and a
# re-serialized-but-equal file would satisfy a value comparison while breaking that claim.
_EXISTING = (
    '{"presentation_version": "1.0", "dataset": {"display_name": "Rijksmuseum",  \n'
    '  "attribution": "Rijksmuseum, Amsterdam"}}'
)

_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [{"column": "category", "label": "Category"}],
}


def _build_images(images_dir: Path, names: list[str]) -> None:
    images_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        rgb = [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256]
        image = (pyvips.Image.black(64, 64, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
        image.webpsave(str(images_dir / name))


def _write_metadata_csv(path: Path, names: list[str]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category"])
        for i, name in enumerate(names):
            writer.writerow([name, f"2026-01-{i + 1:02d}", "red" if i % 2 else "blue"])
    return path


def _ingest(tmp_path: Path, layouts: list[str]) -> tuple[Path, Path]:
    """A first bake with metadata (so datetime/categorical stay addable). Returns
    (images_dir, dataset_dir)."""
    names = [f"img_{i:03d}.webp" for i in range(8)]
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=csv_path,
            column_roles=_ROLES,
            layout_types=layouts,
            output_root=output_root,
        )
    )
    return images, output_root / "ds"


def _manifest(dataset_dir: Path) -> dict:
    return json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))


def test_a_re_ingest_leaves_the_display_name_and_credit_untouched(tmp_path: Path) -> None:
    """The named 'done when'. `run_ingest` over an EXISTING dataset_id version-bumps and
    republishes the whole tree; the presentation record must come through byte-identical."""
    images, dataset_dir = _ingest(tmp_path, ["grid"])
    presentation = dataset_dir / "presentation.json"
    presentation.write_text(_EXISTING, encoding="utf-8")
    assert _manifest(dataset_dir)["dataset_version"] == 1

    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=tmp_path / "meta.csv",
            column_roles=_ROLES,
            layout_types=["grid", "datetime"],
            output_root=tmp_path / "out",
        )
    )

    assert presentation.read_text(encoding="utf-8") == _EXISTING
    # The re-bake really happened, so the assertion above is not vacuously true: a new
    # version, a new layout, and fresh version-stamped assets.
    after = _manifest(dataset_dir)
    assert after["dataset_version"] == 2
    assert [lv["layout_id"] for lv in after["layouts"]] == ["grid", "datetime"]


def test_add_layouts_leaves_the_display_name_and_credit_untouched(tmp_path: Path) -> None:
    """`add-layouts` bakes onto a committed tree and flips the manifest per layout."""
    images, dataset_dir = _ingest(tmp_path, ["grid"])
    presentation = dataset_dir / "presentation.json"
    presentation.write_text(_EXISTING, encoding="utf-8")

    run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["categorical"],
            output_root=tmp_path / "out",
        )
    )

    assert presentation.read_text(encoding="utf-8") == _EXISTING
    after = _manifest(dataset_dir)
    assert [lv["layout_id"] for lv in after["layouts"]] == ["grid", "categorical"]


def test_no_bake_path_ever_creates_a_presentation_file(tmp_path: Path) -> None:
    """Rule 3's other half: the API is the file's SOLE writer, so a bake that seeded a
    default would recreate the two-writer problem the split exists to remove. Checked after a
    fresh ingest, a re-ingest, and an add-layouts."""
    images, dataset_dir = _ingest(tmp_path, ["grid"])
    assert not (dataset_dir / "presentation.json").exists()

    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=tmp_path / "meta.csv",
            column_roles=_ROLES,
            layout_types=["grid"],
            output_root=tmp_path / "out",
        )
    )
    assert not (dataset_dir / "presentation.json").exists()

    run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=tmp_path / "out",
        )
    )
    assert not (dataset_dir / "presentation.json").exists()


def test_a_real_bake_records_provenance_per_family(tmp_path: Path) -> None:
    """v2.9 `source_columns` through the REAL bake, not just the plugin: grid records the
    empty list, and the two metadata-driven layouts record the columns their role entries
    name. The empty list is the load-bearing case — it must be WRITTEN, because an absent key
    means "pre-2.9 entry" and grid genuinely depends on nothing."""
    _images, dataset_dir = _ingest(tmp_path, ["grid", "datetime", "categorical"])

    manifest = _manifest(dataset_dir)
    assert manifest["manifest_version"] == "2.10"
    by_id = {lv["layout_id"]: lv for lv in manifest["layouts"]}
    assert by_id["grid"]["source_columns"] == []
    assert by_id["datetime"]["source_columns"] == ["date"]
    assert by_id["categorical"]["source_columns"] == ["category"]
