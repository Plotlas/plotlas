"""Job progress reporter (Seam O1, T2-56/T2-104) — one reporter, two sinks.

Every long ingest/add-layouts stage has a known-upfront total and a parent-side
serial hook (spike_ingest_observability §1). This module turns those hooks into a
live, machine-readable, per-stage progress channel WITHOUT coupling the pipeline to
RQ or the API: the worker constructs ONE ``ProgressReporter`` per job, registers its
stages, and advances them; the reporter fans the current snapshot out to whichever
sinks are present —

  * RQ ``job.meta["progress"]`` (the web path) — RQ's official progress mechanism
    (``job.save_meta()``); the API's ``GET /api/jobs/{id}`` reads it back and passes
    it through as ``JobStatus.progress``. Captured via ``rq.get_current_job()``.
  * ``{staging}/progress.json`` (the CLI ``--sync`` path, which has no RQ job) —
    the same numbers, so a long CLI bake is inspectable on the volume; the worker
    additionally persists the terminal snapshot next to ``ingest.log`` in the
    dataset dir so it survives the staging sweep.

Both when both are present. The progress DICT SHAPE is the cross-package contract
(documented in ``docs/interface-catalogue.md``); ``schemas/v2/`` is untouched (job
progress is API app-state surface, not a dataset contract).

DIRECTIVE (binding): progress is ADVISORY and must never affect bake correctness or
completion (brief §1.3). Every sink write is best-effort — a Redis hiccup mid
``save_meta`` must not fail a 20-hour bake, so a failure is logged ONCE per job at
WARNING and then swallowed. And the NO-FAKE-PROGRESS rule holds: a stage with no
known total publishes ``total: null``, never an invented number.

rq is imported LAZILY (``_current_rq_job``) so this module — pulled in by
``pipeline.worker`` at import — stays importable everywhere ``worker`` is (and the
CLI path degrades to the file sink when rq/get_current_job is unavailable).
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

# The progress contract version (top-level ``progress_version``). Bump on a
# breaking shape change; the API's JobProgress model mirrors this shape.
PROGRESS_VERSION = 1

# ``advance`` persists at most once per second PER STAGE (brief §2a throttling);
# intermediate calls only update in-memory counts. Stage transitions
# (start/register/end/start_job) always persist so a boundary is never missed.
_THROTTLE_SECONDS = 1.0

StageState = Literal["queued", "running", "done", "failed"]


class _MetaJob(Protocol):
    """The slice of an RQ ``Job`` the reporter needs (structural, so a test fake
    conforms without importing rq): a mutable ``meta`` dict + ``save_meta()``."""

    meta: dict
    def save_meta(self) -> None: ...


# Sentinel: the reporter auto-detects the current RQ job unless a job (or None) is
# injected (tests pass a fake job or None to exercise each sink in isolation).
_AUTODETECT: Any = object()


def _current_rq_job() -> _MetaJob | None:
    """The RQ job currently executing (web path), or None (CLI ``--sync``). Defensive
    like ``worker._current_job_id``: any failure importing/using rq yields None, so
    the reporter simply falls back to its file sink."""
    try:
        from rq import get_current_job

        return get_current_job()
    except Exception:
        return None


@dataclass
class _Stage:
    key: str
    label: str
    unit: str | None
    done: int
    total: int | None
    state: StageState
    t_start: float | None
    t_end: float | None


class ProgressReporter:
    """Live per-stage progress for one ingest/add-layouts job. Constructed once in
    ``run_ingest`` / ``run_add_layouts``; the worker drives the stages, and every
    call fans the snapshot out to the RQ ``job.meta`` and/or ``progress.json`` sinks
    (throttled on ``advance``, immediate on transitions). All sink writes are
    best-effort — see the module docstring's binding directive."""

    def __init__(
        self,
        json_path: Path | None,
        logger: logging.Logger | None = None,
        *,
        job: Any = _AUTODETECT,
    ) -> None:
        self._json_path = json_path
        self._logger = logger
        self._job: _MetaJob | None = _current_rq_job() if job is _AUTODETECT else job
        self._stages: list[_Stage] = []
        self._index: dict[str, _Stage] = {}
        self._spec_layouts: list[str] = []
        self._image_count: int | None = None
        self._current: str | None = None
        self._last_flush: dict[str, float] = {}
        self._warned = False

    # -- job-level -----------------------------------------------------------

    def start_job(self, spec_layouts: list[str], image_count: int | None) -> None:
        """Record the requested layout specs + corpus size (the job's plan) and
        persist an initial snapshot. Idempotent — call it AGAIN as values become
        known (the worker publishes the plan with ``image_count=None`` at entry,
        then republishes with the measured count after the scan)."""
        self._spec_layouts = list(spec_layouts)
        self._image_count = image_count
        self._persist_now()

    # -- stage lifecycle -----------------------------------------------------

    def register_stage(
        self, key: str, label: str, unit: str | None, total: int | None = None
    ) -> None:
        """Register a stage as ``queued`` (not yet running) so a consumer can show
        the planned work before it starts — e.g. the layouts queued behind the one
        baking. A no-op if already registered."""
        if key in self._index:
            return
        stage = _Stage(key, label, unit, 0, total, "queued", None, None)
        self._stages.append(stage)
        self._index[key] = stage
        self._persist_now()

    def start_stage(
        self,
        key: str,
        label: str | None = None,
        unit: str | None = None,
        total: int | None = None,
    ) -> None:
        """Mark a stage ``running`` (stamping ``t_start``), registering it first if
        new. ``label``/``unit``/``total`` update the stage only when given, so
        ``start_stage(key)`` on a pre-registered stage keeps its registered label."""
        stage = self._index.get(key)
        if stage is None:
            stage = _Stage(key, label or key, unit, 0, total, "running", None, None)
            self._stages.append(stage)
            self._index[key] = stage
        else:
            if label is not None:
                stage.label = label
            if unit is not None:
                stage.unit = unit
            if total is not None:
                stage.total = total
            stage.state = "running"
        if stage.t_start is None:
            stage.t_start = time.time()
        self._current = key
        # monotonic: the throttle is a DELTA — an NTP wall-clock step must not stall
        # (or burst) the flush cadence. t_start/t_end stay wall-clock (epoch seconds).
        self._last_flush[key] = time.monotonic()
        self._persist_now()

    def advance(self, key: str, done: int, total: int | None = None) -> None:
        """Set a stage's ABSOLUTE, monotonic ``done`` (and fill ``total`` when it
        first becomes known — e.g. the tiler supplies the tile total on its first
        tile). Persists at most once per second per stage; intermediate calls only
        update memory. A stray advance on an unregistered stage is a no-op (progress
        is advisory)."""
        stage = self._index.get(key)
        if stage is None:
            return
        if total is not None:
            stage.total = total
        if done > stage.done:
            stage.done = done
        now = time.monotonic()
        if now - self._last_flush.get(key, 0.0) >= _THROTTLE_SECONDS:
            self._last_flush[key] = now
            self._persist_now()

    def end_stage(self, key: str, state: Literal["done", "failed"]) -> None:
        """Terminate a stage (``done``/``failed``), stamping ``t_end`` — giving
        consumers a measured per-stage rate (``t_end - t_start``) for free. Always
        persists (a boundary is never throttled away). Clears ``current`` when it
        pointed here, so ``current`` really means "currently RUNNING" (the documented
        contract) — null between stages and in a terminal snapshot."""
        stage = self._index.get(key)
        if stage is None:
            return
        stage.state = state
        stage.t_end = time.time()
        if self._current == key:
            self._current = None
        self._persist_now()

    def mark_failed_running(self) -> None:
        """Best-effort: on a job-level failure, flip any still-``running`` stage to
        ``failed`` so the terminal snapshot is honest (a crash mid-stage otherwise
        leaves it stuck ``running``). Queued stages that were never reached stay
        ``queued``. Clears ``current`` (nothing is running any more)."""
        changed = False
        for stage in self._stages:
            if stage.state == "running":
                stage.state = "failed"
                stage.t_end = time.time()
                changed = True
        if changed:
            self._current = None
            self._persist_now()

    # -- durable snapshot ----------------------------------------------------

    def persist(self, path: Path) -> None:
        """Write the current snapshot to ``path`` (best-effort). The worker calls
        this at the terminal point with ``{dataset_dir}/progress.json`` so a
        completed bake's progress record survives the staging sweep, next to
        ``ingest.log``."""
        try:
            self._write_json(path, self._snapshot())
        except Exception:
            self._warn_once(f"could not persist progress snapshot to {path}")

    # -- internals -----------------------------------------------------------

    def _snapshot(self) -> dict:
        return {
            "progress_version": PROGRESS_VERSION,
            "spec_layouts": list(self._spec_layouts),
            "image_count": self._image_count,
            "current": self._current,
            "stages": [
                {
                    "key": s.key,
                    "label": s.label,
                    "unit": s.unit,
                    "done": s.done,
                    "total": s.total,
                    "state": s.state,
                    "t_start": s.t_start,
                    "t_end": s.t_end,
                }
                for s in self._stages
            ],
        }

    def _persist_now(self) -> None:
        """Fan the snapshot out to every present sink. Each write is independently
        best-effort — one failing sink never blocks the other, and never the bake."""
        snapshot = self._snapshot()
        if self._job is not None:
            try:
                self._job.meta["progress"] = snapshot
                self._job.save_meta()
            except Exception:
                self._warn_once("could not write RQ job.meta progress")
        if self._json_path is not None:
            try:
                self._write_json(self._json_path, snapshot)
            except Exception:
                self._warn_once("could not write progress.json")

    def _write_json(self, path: Path, data: dict) -> None:
        """Atomic small-JSON write (temp + os.replace) so a concurrent reader never
        observes a half-written file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        os.replace(tmp, path)

    def _warn_once(self, message: str) -> None:
        """Log a sink failure ONCE per job at WARNING, then stay silent (directive
        3): a bake must not emit a warning per throttle tick for a persistent Redis
        or disk problem."""
        if self._warned:
            return
        self._warned = True
        if self._logger is not None:
            self._logger.warning(
                "progress reporter: %s (further progress-sink errors suppressed)",
                message,
                exc_info=True,
            )
