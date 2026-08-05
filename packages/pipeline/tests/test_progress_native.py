"""Native O1 integration: run_ingest / run_add_layouts drive the progress channel.

Covers the two load-bearing behaviours through the REAL pipeline:
  * run_ingest emits live RQ ``job.meta`` (web path, via a fake current job) AND a
    durable ``progress.json`` (persisted at the dataset root) with EVERY stage ``done``
    and REAL totals — prepare/thumbs/detail == image_count, each layout's tile total ==
    the baked pyramid's tile count (sum of its manifest levels).
  * R4: an add-layouts run where a MIDDLE layout fails commits the layouts before AND
    after it, marks the failed stage ``failed``, and raises a summary naming it.

NATIVE: needs libvips (pyvips) + pmtiles, marked ``native`` (``make test-pipeline -m
native``) and skipped in the lean test image via importorskip.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline import progress  # noqa: E402
from pipeline.worker import (  # noqa: E402
    AddLayoutsJobPayload,
    IngestJobPayload,
    run_add_layouts,
    run_ingest,
)


class _FakeJob:
    """Structural RQ Job stand-in (the reporter's ``_MetaJob``): mutable ``meta`` +
    ``save_meta``. Injected via ``progress._current_rq_job`` so run_ingest's reporter
    takes the WEB path (job.meta) as well as the file sink."""

    def __init__(self) -> None:
        self.meta: dict = {}

    def save_meta(self) -> None:  # persists in-process; the test reads self.meta
        pass


def _image_names(n: int) -> list[str]:
    return [f"img_{i:03d}.webp" for i in range(n)]


def _build_images(images_dir: Path, names: list[str]) -> None:
    images_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        rgb = [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256]
        image = (pyvips.Image.black(64, 64, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
        image.webpsave(str(images_dir / name))


def _write_metadata_csv(path: Path, names: list[str]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category", "place"])
        for i, name in enumerate(names):
            writer.writerow([
                name, f"2026-01-{i + 1:02d}",
                "red" if i % 2 else "blue",
                "indoor" if i % 3 else "outdoor",
            ])
    return path


# TWO categorical columns so the family expands to categorical_category +
# categorical_place — the R4 test needs THREE addable layouts (datetime + the two
# categoricals) to fail the MIDDLE one.
_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [
        {"column": "category", "label": "Category"},
        {"column": "place", "label": "Place"},
    ],
}


def _layout_tile_total(manifest: dict, layout_id: str) -> int:
    """The exact tile count of a baked layout's pyramid (sum of its levels) — what
    the layout stage's total/done must equal."""
    layout = next(lv for lv in manifest["layouts"] if lv["layout_id"] == layout_id)
    return sum(level["tile_count"] for level in layout["pyramid"]["levels"])


def test_run_ingest_progress_meta_and_json(tmp_path: Path, monkeypatch) -> None:
    n = 12
    names = _image_names(n)
    _build_images(tmp_path / "images", names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"

    # WEB path: the reporter picks up a fake current job → job.meta is written too.
    job = _FakeJob()
    monkeypatch.setattr(progress, "_current_rq_job", lambda: job)

    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=tmp_path / "images",
            csv_path=csv_path,
            column_roles=_ROLES,
            layout_types=["grid", "datetime", "categorical"],
            output_root=output_root,
        )
    )
    assert version == "1"
    dataset_dir = output_root / "ds"
    manifest = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))

    # BOTH sinks carry the same terminal snapshot: the durable dataset-root file (CLI
    # path, survives the staging sweep) and RQ job.meta (web path).
    durable = json.loads((dataset_dir / "progress.json").read_text(encoding="utf-8"))
    assert job.meta["progress"] == durable

    prog = durable
    assert prog["progress_version"] == 1
    assert prog["spec_layouts"] == ["grid", "datetime", "categorical"]
    assert prog["image_count"] == n
    by_key = {s["key"]: s for s in prog["stages"]}

    # Fixed stages present, all done, real image-count totals (no image skipped here).
    for key in ("prepare", "thumbs", "detail"):
        assert by_key[key]["state"] == "done", key
        assert by_key[key]["done"] == by_key[key]["total"] == n, key
    assert by_key["tags"]["state"] == "done"  # one-shot (a tag-less dataset still shows it)

    # One layout stage per baked layout, each done with done==total==real tile count.
    expected_layouts = {"grid", "datetime", "categorical_category", "categorical_place"}
    assert {lv["layout_id"] for lv in manifest["layouts"]} == expected_layouts
    for layout_id in expected_layouts:
        stage = by_key[f"layout:{layout_id}"]
        assert stage["state"] == "done", layout_id
        assert stage["unit"] == "tiles"
        tile_total = _layout_tile_total(manifest, layout_id)
        assert stage["done"] == stage["total"] == tile_total > 0, layout_id
        # t_start/t_end give a measured rate for free.
        assert stage["t_end"] >= stage["t_start"]


def test_run_ingest_survives_reporter_sink_failures(tmp_path: Path, monkeypatch) -> None:
    """Directive §1.3 / DoD invariant: a reporter whose sink RAISES on every write (a
    Redis hiccup for the whole bake) must NOT fail the bake — progress is advisory. The
    bake completes with every layout committed despite each meta write raising."""

    class _RaisingJob:
        def __init__(self) -> None:
            self.meta: dict = {}

        def save_meta(self) -> None:
            raise RuntimeError("redis down")  # every progress write fails

    monkeypatch.setattr(progress, "_current_rq_job", lambda: _RaisingJob())

    names = _image_names(8)
    _build_images(tmp_path / "images", names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"

    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=tmp_path / "images",
            csv_path=csv_path,
            column_roles=_ROLES,
            layout_types=["grid", "datetime", "categorical"],
            output_root=output_root,
        )
    )
    # The bake COMPLETED despite every meta write raising.
    assert version == "1"
    manifest = json.loads((output_root / "ds" / "layout_manifest.json").read_text(encoding="utf-8"))
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {
        "grid", "datetime", "categorical_category", "categorical_place",
    }


def test_run_ingest_detail_skip_marks_stage_done(tmp_path: Path) -> None:
    """detail_tier=skip still emits a ``detail`` stage (done, total 0) so the stage
    list is stable — and no RQ job means only the file sink is exercised."""
    names = _image_names(6)
    _build_images(tmp_path / "images", names)
    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=tmp_path / "images",
            csv_path=None,
            column_roles=None,
            layout_types=["grid"],
            output_root=output_root,
            detail_tier="skip",
        )
    )
    prog = json.loads((output_root / "ds" / "progress.json").read_text(encoding="utf-8"))
    detail = next(s for s in prog["stages"] if s["key"] == "detail")
    assert detail["state"] == "done" and detail["total"] == 0


def _ingest_grid_only(tmp_path: Path, n: int = 12) -> tuple[Path, Path]:
    names = _image_names(n)
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
            layout_types=["grid"],  # datetime/categorical still ADDABLE later
            output_root=output_root,
        )
    )
    return images, output_root / "ds"


def test_add_layouts_middle_failure_commits_others_and_reports(tmp_path: Path, monkeypatch) -> None:
    """R4: with three requested layouts, a MIDDLE one failing commits the ones BEFORE
    and AFTER it (the run continues past the failure — the run_ingest semantics), the
    summary error names it, and its progress stage ends ``failed`` while the siblings
    end ``done``. (Under the pre-R4 abort-on-first-failure loop the third would never
    have committed.)"""
    images, dataset_dir = _ingest_grid_only(tmp_path)
    output_root = dataset_dir.parent

    # run_add_layouts imports bake_pyramid from the tiler at call time, so patching the
    # tiler attribute takes effect. Fail the MIDDLE requested layout.
    from pipeline import tiler

    real = tiler.bake_pyramid
    calls: list[str] = []

    def flaky_bake(*args, **kwargs):
        layout_id = kwargs["layout_id"]
        calls.append(layout_id)
        if layout_id == "categorical_category":  # the middle of the three
            raise RuntimeError("boom on the middle layout")
        return real(*args, **kwargs)

    monkeypatch.setattr(tiler, "bake_pyramid", flaky_bake)

    with pytest.raises(RuntimeError, match=r"categorical_category"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                # -> want_ids = [datetime, categorical_category, categorical_place]
                layout_specs=["datetime", "categorical"],
                output_root=output_root,
            )
        )
    # All three were attempted — the failure did NOT abort the loop.
    assert calls == ["datetime", "categorical_category", "categorical_place"]

    # The dataset is live with grid + the two that baked; the middle one did NOT land.
    manifest = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {
        "grid", "datetime", "categorical_place",
    }
    assert not (dataset_dir / "tiles" / "categorical_category").exists()

    # The progress record (persisted at the dataset root on the failure path) marks the
    # failed stage failed and the siblings done.
    prog = json.loads((dataset_dir / "progress.json").read_text(encoding="utf-8"))
    by_key = {s["key"]: s for s in prog["stages"]}
    assert by_key["layout:categorical_category"]["state"] == "failed"
    assert by_key["layout:datetime"]["state"] == "done"
    assert by_key["layout:categorical_place"]["state"] == "done"
