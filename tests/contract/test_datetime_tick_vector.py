"""THE SHARED TICK VECTOR, producer half — D-36 seam H4.

`tests/fixtures/datetime_tick_vector.json` is ONE committed file read by TWO suites: this
one and `packages/frontend/tests/datetime_tick_vector.test.ts`. The renderer half runs the
real `overlayLayer` path over each case and asserts it produces the committed ticks. This
half never runs renderer code: it asserts the SAME committed ticks against the producer's
own `pipeline.layout_plugins.datetime_layout._floor_interval` and `_INTERVAL_LADDER`.

That split is the point, and it is what "lock-step" has to mean to be worth anything:

  * change the renderer's flooring, thinning or label format and the NODE suite goes red
    while this one stays green — because the file no longer describes what the renderer does;
  * change the producer's `_floor_interval`, or add/remove a ladder rung, and THIS suite goes
    red while the node suite stays green — because the file no longer describes what the
    producer bins at.

Neither side can edit the fixture to suit itself without breaking the other, which is
exactly what a doc paragraph could not do. D-36 §"The alignment invariant" item 3 ("across
the language boundary") is this file plus its node twin.

Architect-tier by placement (tests/contract/ is the cross-package regression net) because
the artifact it guards is a cross-PACKAGE contract, not a module's own loop.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import pytest

from pipeline.layout_plugins.datetime_layout import _INTERVAL_LADDER, _floor_interval

UTC = _dt.timezone.utc
_REPO = Path(__file__).resolve().parents[2]
_VECTOR_PATH = _REPO / "tests" / "fixtures" / "datetime_tick_vector.json"
_GOLDEN_MANIFEST = _REPO / "tests" / "fixtures" / "golden_dataset_full_v2" / "layout_manifest.json"

# The renderer stores `x` at 12 dp and reaches it through the same slope/intercept round trip
# reconstructed below; measured residual 3.3e-11 on the tightest case (a five-minute span).
# 1e-9 clears that by ~30x while staying far under one bin width (1.5e-2 on that same case),
# so a real placement change cannot hide under it.
_X_TOL = 1e-9

_VECTOR = json.loads(_VECTOR_PATH.read_text("utf-8"))
_CASES = _VECTOR["cases"]


def _consumer_x_of(axis: dict):
    """The CONSUMER's t -> world-x map, transcribed from `overlayLayer.ts`
    (`axisDomainToTimeDomain` + `domainToX`) — the same reconstruction the T2-138 alignment
    pin uses in `packages/pipeline/tests/test_datetime_layout.py`, never the producer's own
    formula. Reconstructing it here is what ties a tick's POSITION to the placement line."""
    t_start = _dt.datetime.fromisoformat(axis["domain"][0]).timestamp() * 1000.0
    t_end = _dt.datetime.fromisoformat(axis["domain"][1]).timestamp() * 1000.0
    x_lo, x_hi = float(axis["range"][0]), float(axis["range"][1])
    slope = (t_end - t_start) / (x_hi - x_lo)
    intercept = t_start - slope * x_lo
    return lambda t_ms: (t_ms - intercept) / slope


def _rung_index(dt: _dt.datetime, kind: str, step: int) -> int:
    """Which bin of the `(kind, step)` grid `dt` falls in — a COUNT, so "every n-th bin
    boundary" is checkable as an arithmetic progression of indices. Derived from the
    producer's flooring anchors (year 0 / month 0 / the epoch's midnight), not from the
    renderer, which is the whole point of this file living on this side."""
    if kind == "year":
        return dt.year // step
    if kind == "month":
        return (dt.year * 12 + dt.month - 1) // step
    epoch_s = int((dt - _dt.datetime(1970, 1, 1, tzinfo=UTC)).total_seconds())
    unit = {"day": 86400, "hour": 3600, "minute": 60, "second": 1}[kind]
    return epoch_s // (unit * step)


def _label_instant(label: str, kind: str) -> _dt.datetime:
    """Parse a tick label back to the instant it claims to mark. The renderer's formats are
    the ISO calendar prefix at the rung's resolution precisely so this is possible: a label
    that stops being reversible, or starts naming a different instant, fails here without
    this file having to re-implement the formatter."""
    if kind == "year":
        return _dt.datetime(int(label), 1, 1, tzinfo=UTC)
    if kind == "month":
        return _dt.datetime.strptime(label, "%Y-%m").replace(tzinfo=UTC)
    if kind == "day":
        return _dt.datetime.strptime(label, "%Y-%m-%d").replace(tzinfo=UTC)
    if kind in ("hour", "minute"):
        return _dt.datetime.strptime(label, "%Y-%m-%d %H:%M").replace(tzinfo=UTC)
    return _dt.datetime.strptime(label, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)


def _ids(cases: list[dict]) -> list[str]:
    return [c["name"] for c in cases]


@pytest.mark.parametrize("case", _CASES, ids=_ids(_CASES))
def test_every_vector_tick_is_one_of_the_producers_own_bin_boundaries(case: dict) -> None:
    """THE lock-step assertion. For an `interval`-carrying case, every tick instant in the
    shared vector is an instant `_floor_interval` returns for that rung — i.e. a real bin
    boundary of the bake, not a second ladder's idea of a nice date. A renderer that floored
    months to the 15th, or anchored years at 1 CE, or stepped by a fixed 30.44 days, produces
    instants that are not fixed points of the producer's flooring and fails here."""
    interval = case["axis"].get("interval")
    if interval is None:
        pytest.skip("pre-2.7 case: no rung was advertised, so there are no bin edges to be on")
    kind, step = interval["kind"], int(interval["step"])
    assert case["ticks"], f"{case['name']}: a rung case with no ticks proves nothing"
    for tick in case["ticks"]:
        t = _dt.datetime.fromisoformat(tick["t"])
        floored = _floor_interval(t, kind, step)
        assert floored == t, (
            f"{case['name']}: the tick labelled {tick['label']!r} is at {t.isoformat()}, but the "
            f"producer floors that instant to {floored.isoformat()} on its own ({kind}, {step}) "
            f"rung — so it is NOT a bin boundary and the renderer is ticking a second ladder."
        )


@pytest.mark.parametrize("case", _CASES, ids=_ids(_CASES))
def test_the_vector_thins_by_a_uniform_stride_over_those_boundaries(case: dict) -> None:
    """...and the ticks that were DROPPED were dropped by taking every n-th bin boundary —
    a uniform stride in bin INDEX — rather than by switching rung. Being individually on a
    bin edge is not enough: a renderer that picked whichever boundaries happened to be near a
    nice-looking date would satisfy the test above and produce a ragged, unstable axis.
    Anchoring on the global index (stride | index) is also what stops the tick set
    reshuffling as the camera pans."""
    interval = case["axis"].get("interval")
    if interval is None:
        pytest.skip("pre-2.7 case: the years-only ladder owns its own spacing")
    kind, step = interval["kind"], int(interval["step"])
    idx = [_rung_index(_dt.datetime.fromisoformat(t["t"]), kind, step) for t in case["ticks"]]
    assert idx == sorted(set(idx)), f"{case['name']}: ticks must be strictly increasing bins"
    if len(idx) < 2:
        return
    strides = {b - a for a, b in zip(idx, idx[1:])}
    assert len(strides) == 1, (
        f"{case['name']}: bin-index gaps between ticks are {sorted(strides)} — thinning must "
        f"take every n-th boundary, not an assorted subset of them"
    )
    stride = strides.pop()
    assert idx[0] % stride == 0, (
        f"{case['name']}: the first tick is bin {idx[0]}, which is not a multiple of the "
        f"stride {stride} — the kept set is anchored on the camera rather than on the bin "
        f"grid, so it reshuffles under a pan"
    )


@pytest.mark.parametrize("case", _CASES, ids=_ids(_CASES))
def test_every_vector_tick_sits_where_the_emitted_axis_puts_its_instant(case: dict) -> None:
    """The T2-138 alignment identity, carried across the language boundary: a tick's world-x
    is where the EMITTED axis annotation maps its instant, reconstructed the consumer's way
    (`axisDomainToTimeDomain` + `domainToX`). This is the tie between "the tick is on a bin
    edge" (above) and "the bin's block left edge is at that x" (the producer-side pin in
    packages/pipeline/tests/test_datetime_layout.py) — together they say the tick is drawn on
    the bar. Also bounds the ticks to the case's visible window, so a stride that ran off the
    end of the view cannot pass unnoticed."""
    x_of = _consumer_x_of(case["axis"])
    lo, hi = float(case["view"][0]), float(case["view"][1])
    for tick in case["ticks"]:
        t_ms = _dt.datetime.fromisoformat(tick["t"]).timestamp() * 1000.0
        x = x_of(t_ms)
        assert abs(x - float(tick["x"])) < _X_TOL, (
            f"{case['name']}: the emitted axis maps {tick['label']!r} to world-x {x!r}, but the "
            f"vector records {tick['x']!r} (off by {x - float(tick['x'])!r})"
        )
        assert lo - _X_TOL <= x <= hi + _X_TOL, (
            f"{case['name']}: {tick['label']!r} is drawn at {x!r}, outside the visible window "
            f"[{lo}, {hi}] the case describes"
        )


@pytest.mark.parametrize("case", _CASES, ids=_ids(_CASES))
def test_every_vector_label_names_the_instant_it_marks(case: dict) -> None:
    """The label is not decoration: parsed back at the rung's own resolution it must be
    exactly the tick's instant. A renderer that labelled a March bin `2021-02`, or rounded a
    09:35 tick to `09:00`, still draws in the right place and would pass every assertion
    above — this is the one that reads what the user actually sees."""
    interval = case["axis"].get("interval")
    kind = "year" if interval is None else interval["kind"]
    for tick in case["ticks"]:
        t = _dt.datetime.fromisoformat(tick["t"])
        assert _label_instant(tick["label"], kind) == t, (
            f"{case['name']}: the tick at {t.isoformat()} is labelled {tick['label']!r}, which "
            f"reads as {_label_instant(tick['label'], kind).isoformat()}"
        )


def test_the_vector_covers_every_rung_kind_the_ladder_can_select() -> None:
    """A COVERAGE gate, and the reason a new producer rung cannot quietly ship an unlabelled
    axis. `_INTERVAL_LADDER` is the producer's whole vocabulary — 25 rungs over six kinds,
    measured on this branch 2026-07-29 — and each kind needs its own renderer label format.
    Adding a rung under a NEW kind fails here first, which forces a vector case, which forces
    the format (and the node half asserts the same six from its side)."""
    ladder_kinds = {kind for kind, _step, _avg in _INTERVAL_LADDER}
    covered = {c["axis"]["interval"]["kind"] for c in _CASES if c["axis"].get("interval")}
    assert covered == ladder_kinds, (
        f"the shared tick vector covers {sorted(covered)} but the producer can bin at "
        f"{sorted(ladder_kinds)}; an uncovered kind has no pinned label format"
    )
    # ...and every (kind, step) claimed is a rung the selector could really return, so a case
    # cannot describe a bucketing the producer never emits.
    rungs = {(kind, step) for kind, step, _avg in _INTERVAL_LADDER}
    for case in _CASES:
        iv = case["axis"].get("interval")
        if iv is not None:
            assert (iv["kind"], iv["step"]) in rungs, (
                f"{case['name']}: ({iv['kind']}, {iv['step']}) is not a rung on _INTERVAL_LADDER"
            )
    assert any(c["axis"].get("interval") is None for c in _CASES), (
        "the vector must keep a PRE-2.7 case: `interval` is optional and every dataset on "
        "disk today lacks it"
    )


def test_the_real_bake_case_is_still_the_real_bake() -> None:
    """One case is anchored to a REAL producer output rather than hand-written numbers: the
    committed `golden_dataset_full_v2` datetime axis, which build_fixture wrote through the
    production manifest emitter. Asserting it verbatim is what stops the vector drifting into
    a self-consistent fiction — if a geometry seam moves `range`, this fails and the case has
    to be regenerated against the new bake rather than the bake being assumed unchanged."""
    manifest = json.loads(_GOLDEN_MANIFEST.read_text("utf-8"))
    baked = [
        axis
        for layout in manifest["layouts"]
        if layout["type"] == "datetime"
        for axis in layout.get("annotations", {}).get("axes", [])
    ]
    assert len(baked) == 1, f"expected one baked datetime axis in the golden fixture, got {baked}"
    matches = [c for c in _CASES if c["axis"] == baked[0]]
    assert matches, (
        "no vector case carries the golden fixture's datetime axis verbatim. Expected "
        f"{json.dumps(baked[0], sort_keys=True)}"
    )
