"""LAYOUT_DESIGNER D-xxx — the add-layouts stale-knob guards hold only for a layout that
records no ``source_fingerprint``.

``_guard_no_stale_scatter_config`` / ``_guard_no_stale_geographic_config`` refused any
add-layouts run whose roles override changed a committed pair's knobs without re-baking
it, while ``set-roles`` accepted the same edit alone and left the layout stale — the state
D-xxix designs for ([[T2-an-unticked-knob-change-cannot-ride-a-bake-run]]). Since manifest
2.10 (seam L7) a layout that records a fingerprint reports that staleness itself, so the
guards now stand down for it. The ACCEPTED half — a fingerprinted layout's knob change
riding another bake, and being reported stale afterwards — is pinned natively in
test_add_layouts.py, because it bakes. This file pins the REFUSED half and the parity with
the designer's transcription, neither of which bakes anything.

LEAN: the guards run before the first image is read, so nothing here needs pyvips.

FIXTURES — real producer output only, read-only:
  * ``tests/fixtures/golden_dataset_full_v2`` — the committed tree (``metadata.parquet``);
  * ``packages/frontend/tests/designer_fixture/layout_manifest_2.9.json`` — that tree's
    manifest refreshed by the seam-L3 producer: provenance, NO fingerprint — every
    collection baked between L3 and L7;
  * ``.../layout_manifest_2.10.json`` — the same tree refreshed by the L7 producer: every
    layout records ``source_fingerprint``;
  * ``.../knob_guard_cases.json`` — the case vector this file SHARES with
    ``ui_designer_layouts_commit.test.ts``.

WHY A PIPELINE TEST READS THE FRONTEND'S FIXTURE DIRECTORY, unlike the other two-suite
vector (``tests/fixtures/datetime_tick_vector.json`` + ``tests/contract/``): every case is
built from the two designer manifests, which nine frontend test files also read, so the
vector stays beside them. The reasons, measured, are in that directory's README.

WHY THE SCATTER REFUSAL IS PINNED ON THE GUARD, NOT THROUGH ``run_add_layouts``. Measured
2026-09-25 on ``golden_dataset_full_v2/metadata.parquet`` (256 rows, 9 null per axis):
``sx`` spans [-900.0, 636.3961] and ``sy`` [-900.0, 900.0], so every non-default scatter
knob fails ``_validate_roles_against_parquet`` before the guard runs — ``log`` on
``-900.0 (<= 0)``, ``normalize: none`` on ``-900.0`` outside [0,1], ``jitter`` /
``aggregate`` as not implemented. That tree is the only committed pre-2.10 one with a
scatter layout, so no add-layouts run on committed data can reach the scatter guard. The
geographic twin can: ``lat`` spans [-78.0, 78.0], inside Web Mercator's 85.05°, and
``projection: mercator`` passes the same gate — so the end-to-end refusal runs there, and
the scatter guard is called directly on the same real manifest.
"""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path

import pytest

from pipeline import worker
from pipeline.ingest import ColumnRoleError
from pipeline.worker import AddLayoutsJobPayload, ColumnRoles, run_add_layouts

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDEN = REPO_ROOT / "tests" / "fixtures" / "golden_dataset_full_v2"
DESIGNER = REPO_ROOT / "packages" / "frontend" / "tests" / "designer_fixture"
MANIFEST_FILES = {"2.9": "layout_manifest_2.9.json", "2.10": "layout_manifest_2.10.json"}


def _designer_manifest(version: str) -> dict:
    return json.loads((DESIGNER / MANIFEST_FILES[version]).read_text(encoding="utf-8"))


def _with_knobs(roles: dict, family: str, **knobs: str) -> dict:
    out = copy.deepcopy(roles)
    out[family][0].update(knobs)
    return out


# --- the refusal stays, for a layout that records no fingerprint -------------------------


def test_add_layouts_still_refuses_a_projection_change_on_an_UNFINGERPRINTED_geographic_layout(
    tmp_path: Path,
) -> None:
    """D-xxx's other half, end to end. On a pre-2.10 tree nothing records how the map was
    baked, so once the override lands nothing could say its tiles are equirectangular while
    its roles say mercator. The run is refused — with today's message, before any tile, and
    beside another bake (a re-bake of ``datetime``), which is the case the narrowing is
    about."""
    output_root = tmp_path / "datasets"
    dataset_dir = output_root / GOLDEN.name
    shutil.copytree(GOLDEN, dataset_dir)
    shutil.copyfile(DESIGNER / MANIFEST_FILES["2.9"], dataset_dir / "layout_manifest.json")
    committed = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    assert not any("source_fingerprint" in e for e in committed["layouts"]), (
        "fixture premise: a pre-2.10 tree, no layout records a fingerprint"
    )
    before = (dataset_dir / "layout_manifest.json").read_bytes()
    override = _with_knobs(committed["column_roles"], "geographic", projection="mercator")

    with pytest.raises(ColumnRoleError) as exc:
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id=GOLDEN.name,
                owner="tester",
                images_dir=tmp_path / "images",  # never read: the guard fires first
                layout_specs=["datetime"],
                output_root=output_root,
                column_roles=override,
                replace=("datetime",),
            )
        )

    assert str(exc.value) == (
        "lon: the roles override changes the projection/overlap of committed geographic "
        "layout 'geographic' (pair lon/lat), but this run does not re-bake it — the manifest "
        "would then contradict the baked positions and their options echo. Pass --replace "
        "geographic (with --layout geographic) to re-bake it under the new projection, or "
        "re-ingest the dataset"
    )
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before
    assert not list(output_root.glob(".staging-*")), "refused before any staging"


def test_the_scatter_guard_still_refuses_an_UNFINGERPRINTED_layout_and_not_a_FINGERPRINTED_one() -> None:
    """The scatter half, on the guard itself (the module docstring says why). The SAME tree,
    the SAME roles (measured identical in both manifests), the SAME override and the same
    riding re-bake: the one difference between the two calls is whether the committed
    ``scatter`` records a fingerprint, so that difference alone decides the refusal."""
    m29, m210 = _designer_manifest("2.9"), _designer_manifest("2.10")
    assert m29["column_roles"] == m210["column_roles"], "fixture premise: same roles"
    assert "source_fingerprint" not in next(e for e in m29["layouts"] if e["layout_id"] == "scatter")
    assert "source_fingerprint" in next(e for e in m210["layouts"] if e["layout_id"] == "scatter")
    override = ColumnRoles.from_config(
        _with_knobs(m29["column_roles"], "scatter", normalize="none")
    )
    not_replaced = {e["layout_id"] for e in m29["layouts"]} - {"datetime"}

    with pytest.raises(ColumnRoleError) as exc:
        worker._guard_no_stale_scatter_config(m29, override, not_replaced)
    assert str(exc.value) == (
        "sx: the roles override changes the scatter knobs of committed layout 'scatter' "
        "(pair sx/sy), but this run does not re-bake it — the manifest would then "
        "contradict the baked positions and their options echo. Pass --replace scatter "
        "(with --layout scatter) to re-bake it under the new knobs, or re-ingest the dataset"
    )

    worker._guard_no_stale_scatter_config(m210, override, not_replaced)  # stands down


# --- a pair declared more than once: the refusal cannot say whose knobs changed ----------

# Per family: the pair declared twice, the FIRST layout baked before 2.10 at the committed
# knobs, the SECOND re-baked since with different ones, and an override that changes ONLY
# the second. The knobs still compare against the pair's last entry
# ([[T2-the-stale-knob-guards-compare-a-pair-declared]]), so the run is still refused, and
# the layout it names is the first — whose knobs did not change (review of #392, finding 1).
_DECLARED_TWICE = {
    "scatter": (
        worker._guard_no_stale_scatter_config,
        [
            {"x_column": "sx", "y_column": "sy", "label": "Fitted"},
            {"x_column": "sx", "y_column": "sy", "label": "Raw", "normalize": "none"},
        ],
        {"x_scale": "log"},
        ["scatter_sx", "scatter_sx-1"],
    ),
    "geographic": (
        worker._guard_no_stale_geographic_config,
        [
            {"lon_column": "lon", "lat_column": "lat", "label": "Flat"},
            {"lon_column": "lon", "lat_column": "lat", "label": "Web map", "projection": "mercator"},
        ],
        {"projection": "equirectangular"},
        ["geographic_lon", "geographic_lon-1"],
    ),
}


@pytest.mark.parametrize("family", sorted(_DECLARED_TWICE))
def test_a_refusal_on_a_pair_declared_twice_never_sends_the_operator_to_replace_an_unchanged_layout(
    family: str,
) -> None:
    """Following ``Pass --replace <first>`` would re-bake a layout whose knobs never changed,
    which on a large collection takes hours for nothing. So the refusal names the layout it
    cannot rule out, says it cannot tell whose knobs changed, and gives the way out that
    re-bakes only what changed (the roles alone through ``set-roles``, then a re-bake)."""
    guard, entries, patch, (first, second) = _DECLARED_TWICE[family]
    m29, m210 = _designer_manifest("2.9"), _designer_manifest("2.10")
    roles = {**copy.deepcopy(m210["column_roles"]), family: copy.deepcopy(entries)}
    entry = next(e for e in m29["layouts"] if e["layout_id"] == family)
    recorded = next(e for e in m210["layouts"] if e["layout_id"] == family)
    committed = {
        "column_roles": roles,
        "layouts": [
            {**copy.deepcopy(entry), "layout_id": first},  # records nothing
            {**copy.deepcopy(recorded), "layout_id": second},  # records a fingerprint
        ],
    }
    override_roles = copy.deepcopy(roles)
    override_roles[family][1].update(patch)  # ONLY the second, fingerprinted, layout changes

    with pytest.raises(ColumnRoleError) as exc:
        guard(committed, ColumnRoles.from_config(override_roles), {first, second})

    reason = exc.value.reason
    assert f"layout '{first}'" in reason, reason
    assert "cannot tell" in reason, reason
    assert f"--replace {first}" not in reason, reason
    assert "set-roles" in reason, reason


def test_a_pair_the_OVERRIDE_declares_a_second_time_is_not_exact_either() -> None:
    """The other side of the count. Committed once — the 2.9 ``scatter`` on ``(sx, sy)`` —
    and the override adds a second declaration of the same pair with other knobs, leaving the
    first as it was. That second declaration is compared with the committed one, so the run is
    refused, naming ``scatter``, which did not change. ``--replace scatter`` could not even be
    followed: with two declarations ``--layout scatter`` resolves to ``scatter_sx`` and
    ``scatter_sx-1``, so ``_guard_replace_targets`` refuses ``--replace scatter`` as not
    requested (measured 2026-09-28 against this override)."""
    m29 = _designer_manifest("2.9")
    override = copy.deepcopy(m29["column_roles"])
    override["scatter"].append({"x_column": "sx", "y_column": "sy", "label": "Raw", "normalize": "none"})

    with pytest.raises(ColumnRoleError) as exc:
        worker._guard_no_stale_scatter_config(
            m29, ColumnRoles.from_config(override), {e["layout_id"] for e in m29["layouts"]}
        )

    assert "layout 'scatter'" in exc.value.reason and "cannot tell" in exc.value.reason, exc.value.reason
    assert "--replace scatter" not in exc.value.reason, exc.value.reason


# --- parity with the designer's transcription -------------------------------------------

_CASES = json.loads((DESIGNER / "knob_guard_cases.json").read_text(encoding="utf-8"))["cases"]


def _committed_manifest(case: dict) -> dict:
    """The case's committed manifest, assembled from the two real ones exactly as the
    vector's ``about`` describes — and exactly as the node suite assembles it."""
    sources = {version: _designer_manifest(version) for version in MANIFEST_FILES}
    roles = copy.deepcopy(sources["2.10"]["column_roles"])
    roles.update(copy.deepcopy(case.get("declare", {})))
    layouts = []
    for spec in case["layouts"]:
        entry_id = spec.get("entry", spec["layout_id"])
        entry = next(e for e in sources[spec["from"]]["layouts"] if e["layout_id"] == entry_id)
        layouts.append({**copy.deepcopy(entry), "layout_id": spec["layout_id"]})
    return {"column_roles": roles, "layouts": layouts}


def _override(case: dict, committed: dict) -> ColumnRoles:
    roles = copy.deepcopy(committed["column_roles"])
    for family, patches in case["edit"].items():
        for index, patch in enumerate(patches):
            roles[family][index].update(patch)
    return ColumnRoles.from_config(roles)


def _refused(guard, committed: dict, override: ColumnRoles, existing: set[str]) -> str | None:
    """The layout a guard names when it refuses, or None when it lets the run through."""
    try:
        guard(committed, override, existing)
    except ColumnRoleError as exc:
        return exc.reason.split("layout '", 1)[1].split("'", 1)[0]
    return None


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_the_guards_refuse_exactly_what_the_shared_vector_says(case: dict) -> None:
    """``layoutsCommit.knobConflicts`` must refuse exactly what these guards refuse — never
    less (the client would send a job certain to fail), and since D-xxx never more (it would
    block a commit the worker accepts). The node suite holds knobConflicts to this same
    vector, so a change to either rule turns one of the two suites red."""
    committed = _committed_manifest(case)
    override = _override(case, committed)
    existing = {e["layout_id"] for e in committed["layouts"]} - set(case["replace"])

    assert {
        "scatter": _refused(worker._guard_no_stale_scatter_config, committed, override, existing),
        "geographic": _refused(worker._guard_no_stale_geographic_config, committed, override, existing),
    } == case["refuses"]
