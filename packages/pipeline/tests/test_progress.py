"""Unit tests for the O1 ``ProgressReporter`` (lean — no pyvips/pmtiles/rq needed).

Exercises the reporter in isolation with a fake RQ job (structural ``_MetaJob``) and
a tmp ``progress.json`` file sink: stage registration order, monotonic advance, the
1 Hz throttle, both sink contents, and the binding directive that a sink failure is
swallowed after one warning (progress is advisory — it must never fail the bake).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from pipeline import progress
from pipeline.progress import PROGRESS_VERSION, ProgressReporter


class _FakeJob:
    """Structural stand-in for an RQ Job (the ``_MetaJob`` protocol): a mutable
    ``meta`` dict + ``save_meta()``. ``fail`` makes every ``save_meta`` raise, so the
    best-effort swallow is testable."""

    def __init__(self, fail: bool = False) -> None:
        self.meta: dict = {}
        self.saves = 0
        self._fail = fail

    def save_meta(self) -> None:
        self.saves += 1
        if self._fail:
            raise RuntimeError("redis down")


class _Clock:
    """A controllable monotonic clock; monkeypatched over the reporter's ``time``
    module reference so the throttle is deterministic (no sleeps)."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def time(self) -> float:
        return self.now

    def monotonic(self) -> float:  # the throttle clock (deltas); same fake source
        return self.now


def _progress(job: _FakeJob) -> dict:
    return job.meta["progress"]


def test_snapshot_shape_and_job_fields() -> None:
    job = _FakeJob()
    reporter = ProgressReporter(None, job=job)
    reporter.start_job(["grid", "categorical_kingdom"], 1010469)

    snap = _progress(job)
    assert snap["progress_version"] == PROGRESS_VERSION == 1
    assert snap["spec_layouts"] == ["grid", "categorical_kingdom"]
    assert snap["image_count"] == 1010469
    assert snap["current"] is None
    assert snap["stages"] == []


def test_stage_registration_order_and_states() -> None:
    job = _FakeJob()
    reporter = ProgressReporter(None, job=job)
    reporter.start_stage("prepare", "Scan + dimensions + metadata", "images", 10)
    reporter.end_stage("prepare", "done")
    reporter.register_stage("layout:grid", "Bake layout: Grid", "tiles", None)
    reporter.register_stage("layout:datetime", "Bake layout: Date", "tiles", None)
    reporter.start_stage("layout:grid")  # RUNNING; label/unit kept from register

    stages = _progress(job)["stages"]
    assert [s["key"] for s in stages] == ["prepare", "layout:grid", "layout:datetime"]
    by_key = {s["key"]: s for s in stages}
    assert by_key["prepare"]["state"] == "done"
    assert by_key["layout:grid"]["state"] == "running"
    assert by_key["layout:grid"]["label"] == "Bake layout: Grid"  # kept from register
    assert by_key["layout:grid"]["unit"] == "tiles"
    assert by_key["layout:datetime"]["state"] == "queued"  # never started
    assert _progress(job)["current"] == "layout:grid"

    # `current` means currently RUNNING: ending the stage clears it (a terminal
    # snapshot reports current=null, not the last stage that happened to run).
    reporter.end_stage("layout:grid", "done")
    assert _progress(job)["current"] is None


def test_advance_is_monotonic_and_fills_total(monkeypatch) -> None:
    clock = _Clock()
    monkeypatch.setattr(progress, "time", clock)
    job = _FakeJob()
    reporter = ProgressReporter(None, job=job)
    reporter.start_stage("thumbs", "Thumbnails", "images", None)  # total unknown yet

    clock.now += 2
    reporter.advance("thumbs", 5, total=10)  # first tick supplies the real total
    assert _progress(job)["stages"][0]["done"] == 5
    assert _progress(job)["stages"][0]["total"] == 10

    clock.now += 2
    reporter.advance("thumbs", 3)  # a smaller value never moves done backwards
    assert _progress(job)["stages"][0]["done"] == 5


def test_no_fake_total_stays_null() -> None:
    """NO-FAKE-PROGRESS: a stage with no known total publishes null, never a guess."""
    job = _FakeJob()
    reporter = ProgressReporter(None, job=job)
    reporter.start_stage("tags", "Tag sidecar", None, None)
    stage = _progress(job)["stages"][0]
    assert stage["total"] is None
    assert stage["unit"] is None


def test_advance_throttles_to_one_hz(monkeypatch) -> None:
    clock = _Clock()
    monkeypatch.setattr(progress, "time", clock)
    job = _FakeJob()
    reporter = ProgressReporter(None, job=job)
    reporter.start_stage("prepare", "Prepare", "images", 1000)  # 1 forced save
    base = job.saves

    # Many advances within the SAME second → no persist (throttled).
    for done in range(1, 100):
        reporter.advance("prepare", done)
    assert job.saves == base  # zero extra saves inside the 1s window
    # The sink still shows the last PERSISTED value (start_stage's 0), NOT the
    # throttled in-memory 99 — the writes were held, exactly as intended.
    assert _progress(job)["stages"][0]["done"] == 0

    clock.now += 1.5  # cross the throttle window
    reporter.advance("prepare", 500)
    assert job.saves == base + 1  # exactly one more persist
    assert _progress(job)["stages"][0]["done"] == 500  # carries the current count

    # end_stage always persists (a boundary is never throttled away).
    reporter.end_stage("prepare", "done")
    assert job.saves == base + 2


def test_progress_json_sink_content(tmp_path: Path) -> None:
    path = tmp_path / "staging" / "progress.json"  # parent dir does not exist yet
    reporter = ProgressReporter(path, job=None)  # file sink only (no RQ job)
    reporter.start_job(["grid"], 12)
    reporter.start_stage("layout:grid", "Bake layout: Grid", "tiles", None)
    reporter.advance("layout:grid", 7, total=20)
    reporter.end_stage("layout:grid", "done")

    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["spec_layouts"] == ["grid"]
    assert data["image_count"] == 12
    stage = data["stages"][0]
    assert stage["key"] == "layout:grid"
    assert (stage["done"], stage["total"], stage["state"]) == (7, 20, "done")
    assert stage["t_start"] is not None and stage["t_end"] is not None


def test_persist_writes_terminal_snapshot(tmp_path: Path) -> None:
    reporter = ProgressReporter(None, job=None)
    reporter.start_stage("thumbs", "Thumbnails", "images", 3)
    reporter.advance("thumbs", 3)
    reporter.end_stage("thumbs", "done")
    out = tmp_path / "dataset" / "progress.json"
    reporter.persist(out)
    assert json.loads(out.read_text(encoding="utf-8"))["stages"][0]["state"] == "done"


def test_mark_failed_running_flips_only_running() -> None:
    job = _FakeJob()
    reporter = ProgressReporter(None, job=job)
    reporter.start_stage("thumbs", "Thumbnails", "images", 3)
    reporter.end_stage("thumbs", "done")
    reporter.register_stage("layout:grid", "Bake layout: Grid", "tiles", None)
    reporter.start_stage("layout:grid")  # running when the job dies

    reporter.mark_failed_running()
    by_key = {s["key"]: s for s in _progress(job)["stages"]}
    assert by_key["thumbs"]["state"] == "done"       # already terminal, untouched
    assert by_key["layout:grid"]["state"] == "failed"  # running → failed
    assert by_key["layout:grid"]["t_end"] is not None
    assert _progress(job)["current"] is None  # nothing is running any more


def test_meta_write_failure_is_swallowed_and_warned_once(caplog) -> None:
    """Directive §1.3: a Redis hiccup mid-save_meta must NOT propagate (it would fail
    the bake); it is logged ONCE per job then silenced."""
    job = _FakeJob(fail=True)
    logger = logging.getLogger("test.progress.fail")
    reporter = ProgressReporter(None, logger, job=job)

    with caplog.at_level(logging.WARNING, logger="test.progress.fail"):
        reporter.start_stage("prepare", "Prepare", "images", 5)  # save_meta raises
        reporter.end_stage("prepare", "done")  # raises again — must stay swallowed
        reporter.start_stage("thumbs", "Thumbnails", "images", 5)

    # No exception escaped, and exactly ONE warning was emitted (then suppressed).
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1


def test_progress_json_write_failure_is_swallowed(tmp_path: Path) -> None:
    """A file-sink failure (json_path points at a *directory*) is swallowed too — the
    bake proceeds. No RQ job, so the file sink is the only one."""
    bad = tmp_path / "iam_a_dir"
    bad.mkdir()  # os.replace onto a dir fails → the sink write raises internally
    reporter = ProgressReporter(bad, job=None)
    reporter.start_stage("prepare", "Prepare", "images", 1)  # must not raise
    reporter.end_stage("prepare", "done")


def test_no_sinks_is_inert() -> None:
    """CLI path with neither an RQ job nor a file path (defensive): every call is a
    silent no-op — a reporter is never a reason to fail."""
    reporter = ProgressReporter(None, job=None)
    reporter.start_job(["grid"], 1)
    reporter.start_stage("prepare", "Prepare", "images", 1)
    reporter.advance("prepare", 1)
    reporter.advance("nonexistent-stage", 1)  # stray advance is a no-op
    reporter.end_stage("prepare", "done")
