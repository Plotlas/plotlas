"""`run_ingest_job` — the primitive-kwargs RQ/enqueue entry point.

The lean API image cannot import or construct `IngestJobPayload` (decision D-15),
so the API enqueues `pipeline.worker.run_ingest_job` with JSON-primitive kwargs and
this wrapper rebuilds the typed payload before delegating to `run_ingest`. These
tests are non-native (no pyvips/pmtiles): they monkeypatch `run_ingest` to
capture the constructed payload, so they run in the lean test image via `make
test-py`.
"""

from __future__ import annotations

from pathlib import Path

from pipeline import worker


def test_run_ingest_job_builds_payload_and_delegates(monkeypatch) -> None:
    captured: dict[str, worker.IngestJobPayload] = {}

    def fake_run_ingest(payload: worker.IngestJobPayload) -> str:
        captured["payload"] = payload
        return "7"

    monkeypatch.setattr(worker, "run_ingest", fake_run_ingest)

    out = worker.run_ingest_job(
        dataset_id="ds",
        owner="alice",
        images_dir="/data/alice/ds/images",
        output_root="/data",
        layout_types=["grid", "datetime"],
    )

    assert out == "7"
    p = captured["payload"]
    assert isinstance(p, worker.IngestJobPayload)
    assert p.dataset_id == "ds"
    assert p.owner == "alice"
    assert p.images_dir == Path("/data/alice/ds/images")
    assert p.output_root == Path("/data")
    assert p.layout_types == ["grid", "datetime"]
    # images-only defaults: optional metadata omitted -> None (decision D-25)
    assert p.csv_path is None
    assert p.column_roles is None


def test_run_ingest_job_converts_metadata_primitives(monkeypatch) -> None:
    captured: dict[str, worker.IngestJobPayload] = {}

    def fake_run_ingest(payload: worker.IngestJobPayload) -> str:
        captured["p"] = payload
        return "1"

    monkeypatch.setattr(worker, "run_ingest", fake_run_ingest)

    worker.run_ingest_job(
        dataset_id="ds",
        owner="bob",
        images_dir="imgs",
        output_root="out",
        layout_types=["grid"],
        csv_path="meta.csv",
        column_roles={"filename": {"column": "file", "label": "File"}},
    )

    p = captured["p"]
    assert p.csv_path == Path("meta.csv")  # str -> Path
    assert p.column_roles == {"filename": {"column": "file", "label": "File"}}


def test_run_ingest_job_detail_tier_defaults_to_bake(monkeypatch) -> None:
    """detail_tier defaults to "bake" when the enqueuer omits it (T2-46) — the
    behaviour-unchanged contract for callers that never learned about the field."""
    captured: dict[str, worker.IngestJobPayload] = {}

    def fake_run_ingest(payload: worker.IngestJobPayload) -> str:
        captured["p"] = payload
        return "1"

    monkeypatch.setattr(worker, "run_ingest", fake_run_ingest)

    worker.run_ingest_job(
        dataset_id="ds", owner="a", images_dir="i", output_root="o", layout_types=["grid"]
    )
    assert captured["p"].detail_tier == "bake"


def test_run_ingest_job_passes_detail_tier_skip(monkeypatch) -> None:
    """detail_tier="skip" crosses the primitive boundary into the typed payload."""
    captured: dict[str, worker.IngestJobPayload] = {}

    def fake_run_ingest(payload: worker.IngestJobPayload) -> str:
        captured["p"] = payload
        return "1"

    monkeypatch.setattr(worker, "run_ingest", fake_run_ingest)

    worker.run_ingest_job(
        dataset_id="ds",
        owner="a",
        images_dir="i",
        output_root="o",
        layout_types=["grid"],
        detail_tier="skip",
    )
    assert captured["p"].detail_tier == "skip"


def test_run_ingest_job_passes_detail_tier_retain(monkeypatch) -> None:
    """detail_tier="retain" crosses the primitive boundary INTACT (T2-175). Coercing it
    to "bake" would hand a caller who asked for retention the whole multi-hour transcode
    without saying so — the exact failure retention exists to remove. An unknown value
    still coerces to "bake" (never "skip": an unknown mode must not drop the originals)."""
    captured: dict[str, worker.IngestJobPayload] = {}

    def fake_run_ingest(payload: worker.IngestJobPayload) -> str:
        captured["p"] = payload
        return "2"

    monkeypatch.setattr(worker, "run_ingest", fake_run_ingest)

    worker.run_ingest_job(
        dataset_id="ds",
        owner="a",
        images_dir="i",
        output_root="o",
        layout_types=["grid"],
        detail_tier="retain",
    )
    assert captured["p"].detail_tier == "retain"

    worker.run_ingest_job(
        dataset_id="ds",
        owner="a",
        images_dir="i",
        output_root="o",
        layout_types=["grid"],
        detail_tier="reatin",  # a typo is not a silent skip
    )
    assert captured["p"].detail_tier == "bake"
