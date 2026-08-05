"""Native tests for `run_ingest`'s PER-LAYOUT COMMIT (T2-42 residual).

`run_ingest` used to bake every layout into one staging dir and commit the dataset
atomically only after ALL layouts + the manifest — so one slow/failing layout held
its committed siblings hostage (the 2026-07-02 1M scatter stall held grid + datetime
hostage in staging for 9 h+). It now commits the layout-independent BASE first
(metadata.parquet + detail tier + tag sidecar + grid), then each remaining layout
independently (tiles move in + atomic manifest append). A failing layout no longer
blocks a good sibling.

Covers the load-bearing behaviours the change adds:
  1. per-layout failure containment — when a requested layout's bake raises, the base
     (grid) + any layout that DID bake are committed with a VALID manifest listing
     only the landed layouts, the tree conforms, and run_ingest re-raises a summary
     naming the failure. A later good layout still lands despite an earlier failure.
  2. success-path equivalence — all requested layouts land, the manifest is
     schema-valid, and its content matches a single-commit bake (same layout set,
     same per-layout entries), with grid first and no stray staging dir left behind.

NATIVE: needs libvips (pyvips) + pmtiles, so marked `native` (selected by
`make test-pipeline -m native`) and skipped in the lean test image via importorskip.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import jsonschema
import pyarrow.parquet as pq
import pytest
from referencing import Registry, Resource

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline.worker import IngestJobPayload, run_ingest  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "schemas" / "v2"  # the in-force MAJOR contract (D-33)


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


def _read_manifest(dataset_dir: Path) -> dict:
    return json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))


def _entry(manifest: dict, layout_id: str) -> dict:
    return next(lv for lv in manifest["layouts"] if lv["layout_id"] == layout_id)


# 12 rows: a datetime + two categorical columns + a tag role. filename is the join
# key. Ingested with grid + datetime + categorical, so the base (grid) commits, then
# datetime + the two categorical entries commit per layout.
_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [
        {"column": "category", "label": "Category"},
        {"column": "place", "label": "Place"},
    ],
    "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
}
_CATEGORY = ["red"] * 5 + ["blue"] * 4 + ["green"] * 3   # skewed, 12 rows
_PLACE = ["indoor" if i % 2 == 0 else "outdoor" for i in range(12)]


def _write_metadata_csv(path: Path, names: list[str]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category", "place", "tags"])
        for i, name in enumerate(names):
            date = f"2026-01-{i + 1:02d}"
            tags = "a|b" if i % 2 == 0 else "b|c"
            writer.writerow([name, date, _CATEGORY[i], _PLACE[i], tags])
    return path


def _setup(tmp_path: Path, n: int = 12) -> tuple[Path, Path, Path]:
    """Build images + a metadata CSV. Returns (images_dir, csv_path, output_root)."""
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    return images, csv_path, tmp_path / "out"


def test_success_path_commits_all_layouts_grid_first(tmp_path: Path) -> None:
    """The success path is behaviourally equivalent to the old single-commit bake:
    every requested layout lands, the manifest is schema-valid, its content matches
    what a whole-dataset commit would carry (same layout set + per-layout entries),
    grid is first, and no staging dir is left behind."""
    images, csv_path, output_root = _setup(tmp_path)
    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=csv_path,
            column_roles=_ROLES,
            layout_types=["grid", "datetime", "categorical"],
            output_root=output_root,
        )
    )
    assert version == "1"

    dataset_dir = output_root / "ds"
    # Committed cleanly: base merge-moved + per-layout flips, staging removed.
    assert not list(output_root.glob(".staging-*"))

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["manifest_version"] == "2.8"
    assert manifest["dataset_version"] == 1

    layout_ids = [lv["layout_id"] for lv in manifest["layouts"]]
    # All requested layouts landed (categorical expands to its two columns).
    assert set(layout_ids) == {
        "grid",
        "datetime",
        "categorical_category",
        "categorical_place",
    }
    # grid is FIRST — it anchors the base commit (the guaranteed floor, D-25).
    assert layout_ids[0] == "grid"

    # Every layout's PMTiles container is on disk, version-stamped v1.
    for layout in manifest["layouts"]:
        assert layout["pyramid"]["path"] == f"tiles/{layout['layout_id']}/{layout['layout_id']}_v1.pmtiles"
        assert (dataset_dir / layout["pyramid"]["path"]).exists()
        assert layout["pyramid"]["container"] == "pmtiles"
        # detail block declared per layout (the detail tier was baked with the base);
        # path_prefix is VERSION-STAMPED (T2-46).
        assert layout["detail"]["mode"] == "image_ref"
        assert layout["detail"]["path_prefix"] == "detail/v1/"

    # Base artifacts committed once, layout-independent (detail version-stamped).
    assert (dataset_dir / "metadata.parquet").is_file()
    assert (dataset_dir / "detail" / "v1").is_dir()
    assert (dataset_dir / manifest["tags"]["path"]).is_file()
    assert manifest["column_roles"]["filename"]["column"] == "filename"
    assert manifest["dataset_metadata"]["image_count"] == 12
    assert manifest["dataset_metadata"]["source"] == csv_path.name

    # metadata.parquet carries the dense-id contract + the joined roles.
    meta = pq.read_table(dataset_dir / "metadata.parquet")
    assert meta.column("id").to_pylist() == list(range(12))


def test_layout_failure_leaves_base_and_earlier_layouts_committed(
    tmp_path: Path, monkeypatch
) -> None:
    """Per-layout containment (T2-42): when a requested layout's bake raises, the base
    (grid) + the layouts that DID bake are committed with a VALID manifest listing only
    the landed layouts; the tree conforms; run_ingest re-raises a summary naming the
    failure; and a LATER good layout still lands despite the earlier failure (order
    never blocks a sibling)."""
    images, csv_path, output_root = _setup(tmp_path)

    # run_ingest does `from pipeline.tiler import bake_pyramid` at call time (reads
    # tiler.bake_pyramid live), so patching the tiler attribute takes effect.
    from pipeline import tiler

    calls: list[str] = []
    real = tiler.bake_pyramid

    def flaky_bake(*args, **kwargs):
        layout_id = kwargs["layout_id"]
        calls.append(layout_id)
        if layout_id == "datetime":  # a MIDDLE layout fails; grid before + categorical after
            raise RuntimeError("boom baking datetime")
        return real(*args, **kwargs)

    monkeypatch.setattr(tiler, "bake_pyramid", flaky_bake)

    with pytest.raises(RuntimeError, match="layout\\(s\\) failed"):
        run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid", "datetime", "categorical"],
                output_root=output_root,
            )
        )

    # grid baked (base) first, datetime raised, and the run CONTINUED to the two
    # categorical layouts (a failure does not abort the remaining bakes).
    assert calls[0] == "grid"
    assert "datetime" in calls
    assert "categorical_category" in calls and "categorical_place" in calls

    dataset_dir = output_root / "ds"
    # The dataset is LIVE and valid with everything EXCEPT the failed datetime.
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["dataset_version"] == 1
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {
        "grid",
        "categorical_category",
        "categorical_place",
    }
    # The failed layout's tiles were never committed (bake raised before any move).
    assert not (dataset_dir / "tiles" / "datetime").exists()
    # The landed layouts' containers are on disk.
    for layout_id in ("grid", "categorical_category", "categorical_place"):
        assert (dataset_dir / "tiles" / layout_id / f"{layout_id}_v1.pmtiles").exists()

    # POSITION TABLE (T2-66/T2-48, v2.2): each landed layout's position file MOVED WITH
    # its per-layout flip — present on disk AND referenced by its committed entry. The
    # FAILED datetime never got a position table committed (its bake raised before the
    # table was written), so no stray positions/datetime_v1.arrow leaked.
    assert not (dataset_dir / "positions" / "datetime_v1.arrow").exists()
    for layout_id in ("grid", "categorical_category", "categorical_place"):
        assert (dataset_dir / "positions" / f"{layout_id}_v1.arrow").is_file(), (
            f"{layout_id}: position table did not move with its per-layout commit"
        )
        assert _entry(manifest, layout_id)["positions_ref"] == f"positions/{layout_id}_v1.arrow"
    # datetime carries no entry at all (it failed), so no dangling positions_ref.
    assert "datetime" not in {lv["layout_id"] for lv in manifest["layouts"]}

    # Base committed regardless of the layout failure — the dataset renders.
    assert (dataset_dir / "metadata.parquet").is_file()
    assert (dataset_dir / "detail" / "v1").is_dir()  # version-stamped (T2-46)
    assert (dataset_dir / manifest["tags"]["path"]).is_file()
    # staging is REMOVED on failure (fix/reingest-safety): nothing swept these dirs, so
    # the failure handler now rmtrees it rather than leaking a `.staging-<job_id>` dir.
    assert not list(output_root.glob(".staging-*"))


def test_base_layout_failure_commits_nothing(tmp_path: Path, monkeypatch) -> None:
    """If the BASE layout (grid) itself fails to bake, nothing is committed — there is
    no valid ≥1-layout manifest to publish, so the dataset dir is never created (the
    all-or-nothing guarantee still holds for the base)."""
    images, csv_path, output_root = _setup(tmp_path)
    from pipeline import tiler

    real = tiler.bake_pyramid

    def grid_fails(*args, **kwargs):
        if kwargs["layout_id"] == "grid":
            raise RuntimeError("boom baking grid (the base floor)")
        return real(*args, **kwargs)

    monkeypatch.setattr(tiler, "bake_pyramid", grid_fails)

    with pytest.raises(RuntimeError, match="baking grid"):
        run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid", "datetime"],
                output_root=output_root,
            )
        )

    # Nothing committed: the dataset dir was never created (base never flipped).
    assert not (output_root / "ds").exists()
    # staging is REMOVED on failure (fix/reingest-safety): the failure handler rmtrees it
    # instead of leaking a `.staging-<job_id>` dir that nothing ever swept.
    assert not list(output_root.glob(".staging-*"))
