"""``pixscope refresh-manifest`` — the round-trip proof + the per-derivation gates.

LEAN (no pyvips): the round-trip runs against the committed 2.5 golden fixture, and the
unit datasets are assembled with pyarrow only (refresh reads metadata.parquet + the baked
positions tables + the manifest — never the tiles/thumbs/detail — so no image decode is
needed). Collected by ``make test-py``.
"""
from __future__ import annotations

import copy
import datetime as _dt
import json
import shutil
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq
import pytest

from pipeline.ingest import write_positions_table
from pipeline.layout_plugins.base import ColumnRoles
from pipeline.manifest import MANIFEST_VERSION, _validate_manifest
from pipeline.worker import (
    RefreshManifestError,
    _POSITIONS_TOL,
    _PositionsAtlas,
    _compute_requested_layouts,
    _positions_tol,
    run_refresh_manifest,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
GOLDEN_FULL = REPO_ROOT / "tests" / "fixtures" / "golden_dataset_full_v2"


# --- helpers: assemble a schemas/v2-valid PRE-2.5 dataset tree with pyarrow --------


def _pyramid_block(layout_id: str) -> dict:
    """A minimal schemas/v2-valid pyramid descriptor WITHOUT ``dropped_total`` (a pre-2.5
    shape). refresh never opens the container, so the path need not exist on disk."""
    return {
        "container": "pmtiles",
        "path": f"tiles/{layout_id}/{layout_id}_v1.pmtiles",
        "tile_px": 512,
        "thumb_px": 64,
        "cap": 64,
        "levels": [{"z": 0, "tile_count": 1}],
        "z_cap": 0,
    }


def _build_pre25_dataset(
    dataset_dir: Path,
    meta: pa.Table,
    roles_config: dict,
    specs: list[tuple[str, str]],  # (layout_id, layout_type) per layout
) -> dict:
    """Write a PRE-2.5 dataset tree (metadata.parquet + positions/*.arrow + a
    layout_manifest.json WITHOUT bbox_exact/annotations) by computing each layout through
    the REAL plugins — exactly the bake refresh must reproduce. Returns the manifest dict."""
    (dataset_dir / "positions").mkdir(parents=True, exist_ok=True)
    pq.write_table(meta, dataset_dir / "metadata.parquet")
    roles = ColumnRoles.from_config(roles_config)
    image_count = meta.num_rows
    atlas = _PositionsAtlas(ids=list(range(image_count)))
    results = _compute_requested_layouts([lid for lid, _ in specs], roles, meta, atlas)

    layouts = []
    for layout_id, layout_type in specs:
        result = results[layout_id]
        write_positions_table(
            result.cells, image_count, dataset_dir / "positions" / f"{layout_id}_v1.arrow"
        )
        layouts.append(
            {
                "layout_id": layout_id,
                "label": result.label,
                "type": layout_type,
                "bbox": [round(float(v), 6) for v in result.bbox],
                "pyramid": _pyramid_block(layout_id),
                "positions_ref": f"positions/{layout_id}_v1.arrow",
            }
        )

    manifest = {
        "manifest_version": "2.4",  # a PRE-2.5 stamp — no bbox_exact/annotations yet
        "dataset_id": dataset_dir.name,
        "dataset_version": 1,
        "layouts": layouts,
        "dataset_metadata": {
            "image_count": image_count,
            "ingest_timestamp": "2026-01-01T00:00:00Z",
        },
        "column_roles": roles_config,
    }
    _validate_manifest(manifest)  # the synthetic MUST be schema-valid before refresh
    (dataset_dir / "layout_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def _layout(manifest: dict, layout_id: str) -> dict:
    return next(la for la in manifest["layouts"] if la["layout_id"] == layout_id)


def _cat_roles() -> dict:
    return {
        "filename": {"column": "filename", "label": "File"},
        "categorical": [{"column": "cat", "label": "Cat"}],
    }


def _cat_meta(cat: list) -> pa.Table:
    n = len(cat)
    return pa.table(
        {
            "id": pa.array(range(n), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(n)], pa.string()),
            "cat": pa.array(cat, pa.string()),
        }
    )


# --- THE round-trip proof ----------------------------------------------------------


# The committed golden fixture is a 2.8 bake, so it predates the v2.9 per-layout
# `source_columns` provenance list ([[T2-a-layout-does-not-record-which-column-it-was]]) and a
# refresh of it legitimately ADDS a field it never carried — exactly what 2.5's `bbox_exact`
# and 2.6's `missing_count` did to the fixtures of their day. The round-trip expectation is
# therefore the committed manifest UPGRADED to the current minor, not the committed bytes.
#
# The values are written out LITERALLY, read off the fixture's own `column_roles` by hand
# (`datetime.column == "captured"`, `categorical == [group, bucket]`, `scatter == (sx, sy)`,
# `geographic == (lon, lat)`, and grid has no column at all). Deriving them from those roles
# in the test would re-implement the producer and compare it to itself; a literal table is
# the independent side of the comparison.
_FIXTURE_SOURCE_COLUMNS: dict[str, list[str]] = {
    "grid": [],                        # reads no metadata — the images-only floor (D-viii)
    "datetime": ["captured"],
    "scatter": ["sx", "sy"],           # the x/y PAIR, x first
    "categorical_group": ["group"],    # two categorical layouts on DIFFERENT columns: the
    "categorical_bucket": ["bucket"],  # case a layout_id convention could not disambiguate
    "geographic": ["lon", "lat"],      # lon then lat
}

# The v2.10 half, read off the SAME `column_roles` by hand and for the same reason. Each
# value is what THAT LAYOUT'S OWN role entry contributes — never the column's whole role
# set: the fixture's `tags` column also carries a tag role, and no layout here reads it.
# The knobs are the defaults `ColumnRoles.from_config` fills in for entries that declare
# none (scatter: x_scale, y_scale, normalize, overlap; geographic: projection, overlap), in
# the order `_SCATTER_KNOB_DEFAULTS` / `_GEO_KNOB_DEFAULTS` list them — which is why an
# entry with no knobs in the file still fingerprints with four of them.
_FIXTURE_SOURCE_FINGERPRINT: dict[str, dict[str, list[list]]] = {
    "grid": {},                        # no column read ⇒ no way-of-reading recorded
    "datetime": {"captured": [["datetime", "iso8601"]]},
    "scatter": {
        "sx": [["scatter", "x", "sy", "linear", "linear", "fit", "overdraw"]],
        "sy": [["scatter", "y", "sx", "linear", "linear", "fit", "overdraw"]],
    },
    "categorical_group": {"group": [["categorical"]]},
    "categorical_bucket": {"bucket": [["categorical"]]},
    "geographic": {
        "lat": [["geographic", "lat", "lon", "equirectangular", "overdraw"]],
        "lon": [["geographic", "lon", "lat", "equirectangular", "overdraw"]],
    },
}


def _upgraded_to_current_minor(manifest: dict) -> dict:
    """The committed manifest as a CURRENT-minor bake would write it: the stamp re-stamped
    and `source_columns` + `source_fingerprint` inserted in the emitter's canonical slots —
    immediately after `missing_count`, before `detail`."""
    out = copy.deepcopy(manifest)
    out["manifest_version"] = MANIFEST_VERSION
    upgraded = []
    for layout in out["layouts"]:
        assert "missing_count" in layout, (  # the anchor the insert hangs off
            f"{layout['layout_id']}: the fixture entry has no missing_count, so this helper "
            f"cannot place source_columns in canonical order"
        )
        entry: dict = {}
        for key, value in layout.items():
            entry[key] = value
            if key == "missing_count":
                entry["source_columns"] = _FIXTURE_SOURCE_COLUMNS[layout["layout_id"]]
                entry["source_fingerprint"] = _FIXTURE_SOURCE_FINGERPRINT[
                    layout["layout_id"]
                ]
        upgraded.append(entry)
    out["layouts"] = upgraded
    return out


def test_roundtrip_reproduces_committed_25_manifest(tmp_path: Path) -> None:
    """Strip ``annotations`` + ``bbox_exact`` + ``missing_count`` from the committed golden
    fixture, downgrade the stamp, run refresh — the manifest must come back BYTE-FOR-BYTE
    (modulo the v2.9 `source_columns` the 2.8 fixture never carried; see
    ``_upgraded_to_current_minor``). This is the proof that the derivation reproduces the
    bake."""
    ds_id = "golden_dataset_full_v2"
    dst = tmp_path / ds_id
    shutil.copytree(GOLDEN_FULL, dst)
    original_text = (GOLDEN_FULL / "layout_manifest.json").read_text(encoding="utf-8")
    original = json.loads(original_text)
    # The byte-exact assertion below rests on a re-dump reproducing the committed bytes, so
    # state that rather than assume it — otherwise an upgraded expectation could silently
    # weaken "field order + full-precision float repr" into a values-only comparison.
    assert json.dumps(original, indent=2) + "\n" == original_text
    expected = _upgraded_to_current_minor(original)

    stripped = copy.deepcopy(original)
    stripped["manifest_version"] = "2.4"
    for layout in stripped["layouts"]:
        layout.pop("annotations", None)
        layout.pop("bbox_exact", None)
        # v2.6 (T2-140 / D-36 seam U1): stripped too, so this proves refresh DERIVES the
        # count (from the recomputed LayoutResult) rather than carrying the committed one
        # through — and re-inserts it in the emitter's canonical field order.
        layout.pop("missing_count", None)
    (dst / "layout_manifest.json").write_text(
        json.dumps(stripped, indent=2) + "\n", encoding="utf-8"
    )

    result = run_refresh_manifest(ds_id, tmp_path)

    refreshed_text = (dst / "layout_manifest.json").read_text(encoding="utf-8")
    assert json.loads(refreshed_text) == expected  # value-exact (annotations + bbox_exact)
    # BYTE-exact: field order + full-precision float repr
    assert refreshed_text == json.dumps(expected, indent=2) + "\n"
    assert result["manifest_version"] == MANIFEST_VERSION
    assert result["annotations"] == 3  # datetime axis + the two categorical label sets


def test_force_rerun_over_an_enriched_manifest_is_a_fixed_point(tmp_path: Path) -> None:
    """The OTHER half of the round-trip: ``--force`` over an ALREADY-enriched manifest must
    leave it byte-identical — the derived fields (``bbox_exact``, ``annotations``,
    ``missing_count``) are re-derived and land back in their canonical slots.

    The copy starts byte-identical to the fixture, so equality ALONE would also pass if
    refresh wrote nothing at all. The run is therefore observed as well: it must report the
    current minor and must actually have rewritten the file (proved by the ``.bak`` it takes
    before the rewrite), so a refresh that silently no-ops fails here.

    Since v2.9 the FIRST run over the 2.8 fixture is not a no-op — it adds the
    `source_columns` the fixture predates — so the fixed point is asserted where it actually
    lives: run one produces the upgraded manifest, run two reproduces it byte-for-byte."""
    ds_id = "golden_dataset_full_v2"
    dst = tmp_path / ds_id
    shutil.copytree(GOLDEN_FULL, dst)
    original = json.loads((GOLDEN_FULL / "layout_manifest.json").read_text(encoding="utf-8"))
    expected_text = json.dumps(_upgraded_to_current_minor(original), indent=2) + "\n"

    result = run_refresh_manifest(ds_id, tmp_path, force=True)

    assert (dst / "layout_manifest.json").read_text(encoding="utf-8") == expected_text
    assert result["manifest_version"] == MANIFEST_VERSION
    assert result["backup_written"] is True, "the rewrite path did not run"
    assert (dst / "layout_manifest.json.bak").is_file()
    # The actual fixed point: a second --force over the now-current manifest changes nothing.
    run_refresh_manifest(ds_id, tmp_path, force=True)
    assert (dst / "layout_manifest.json").read_text(encoding="utf-8") == expected_text
    # The counts the run derived are REPORTED, not just written (v2.6) — only the layouts
    # with something unplaced are named, and the fixture's are scatter/geographic at 9 each.
    assert result["missing_counts"] == {"scatter": 9, "geographic": 9}


def test_refresh_replaces_a_stale_missing_count_rather_than_carrying_it(tmp_path: Path) -> None:
    """``missing_count`` is DERIVED, so a committed value must be overwritten by the
    recompute — never carried through. This is what makes its membership in
    ``_LAYOUT_ENTRY_KNOWN`` load-bearing: a field outside that frozenset is appended verbatim
    at the END of the entry by ``_enrich_layout_entry``'s catch-all loop, so a stale count
    would survive a plugin change AND land outside the canonical field order. The two
    round-trips above cannot see it (they compare a derived value against an identical
    committed one), so the fixture here commits a WRONG count on purpose.

    Both directions: `scatter` really has 2 unplaced cells but claims 99, and `grid` places
    everything but claims 5 — the second is the one the carry-through loop would resurrect if
    the rebuilt entry had no key of its own to overwrite it."""
    ds = tmp_path / "stale_count"
    meta = pa.table(
        {
            "id": pa.array(range(6), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(6)], pa.string()),
            "sx": pa.array([0.0, 1.0, None, 3.0, 4.0, None], pa.float64()),
            "sy": pa.array([0.0, 1.0, 2.0, 3.0, 4.0, 5.0], pa.float64()),
        }
    )
    roles = {
        "filename": {"column": "filename", "label": "File"},
        "scatter": [{"x_column": "sx", "y_column": "sy", "label": "Scatter"}],
    }
    committed = _build_pre25_dataset(ds, meta, roles, [("grid", "grid"), ("scatter", "scatter")])
    for layout, bogus in (("grid", 5), ("scatter", 99)):
        _layout(committed, layout)["missing_count"] = bogus
    (ds / "layout_manifest.json").write_text(json.dumps(committed, indent=2) + "\n", "utf-8")

    result = run_refresh_manifest("stale_count", tmp_path)

    refreshed = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    assert _layout(refreshed, "scatter")["missing_count"] == 2, "the stale 99 was carried through"
    assert _layout(refreshed, "grid")["missing_count"] == 0, (
        "grid places every cell, so the stale 5 must be REPLACED by a written 0 — dropping "
        "the key instead would read as 'this entry predates 2.6'"
    )
    # ...and in the canonical slot, not appended after `detail`/`edges` by the catch-all loop.
    assert list(_layout(refreshed, "scatter")) == [
        "layout_id", "label", "type", "bbox", "bbox_exact", "pyramid",
        "positions_ref", "missing_count", "source_columns", "source_fingerprint",
    ]
    # The correction is REPORTED: grid's bogus 5 is gone from the run's own account of what
    # it found, and scatter's real 2 is named. A silent rewrite of "how many of your images
    # this layout could not place" is what this surface exists to prevent.
    assert result["missing_counts"] == {"scatter": 2}


def test_refresh_replaces_stale_source_columns_rather_than_carrying_them(tmp_path: Path) -> None:
    """The v2.9 twin of the test above, and it exists because a mutation proved the field-order
    pin could not see this. `source_columns` is DERIVED (from the manifest's own
    `column_roles`, through the real plugins), so a committed value must be OVERWRITTEN.

    Dropping `source_columns` from `_LAYOUT_ENTRY_KNOWN` does NOT disturb the field order —
    `_enrich_layout_entry` has already written the key, and re-assigning an existing dict key
    leaves its insertion position alone — so the catch-all loop silently substitutes the
    COMMITTED value for the recomputed one and every order assertion still passes. Provenance
    that survives a role change is worse than absent provenance: the staleness flag would then
    point at the wrong columns with full confidence.

    Both directions, as above: `scatter` really depends on (sx, sy) but claims a column that
    never existed, and `grid` depends on NOTHING but claims one — grid is the case the
    carry-through would resurrect, because `[]` is the value a reader must be able to trust."""
    ds = tmp_path / "stale_provenance"
    meta = pa.table(
        {
            "id": pa.array(range(4), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(4)], pa.string()),
            "sx": pa.array([0.0, 1.0, 2.0, 3.0], pa.float64()),
            "sy": pa.array([3.0, 2.0, 1.0, 0.0], pa.float64()),
        }
    )
    roles = {
        "filename": {"column": "filename", "label": "File"},
        "scatter": [{"x_column": "sx", "y_column": "sy", "label": "Scatter"}],
    }
    committed = _build_pre25_dataset(ds, meta, roles, [("grid", "grid"), ("scatter", "scatter")])
    _layout(committed, "scatter")["source_columns"] = ["a_column_that_never_existed"]
    _layout(committed, "grid")["source_columns"] = ["filename"]
    (ds / "layout_manifest.json").write_text(json.dumps(committed, indent=2) + "\n", "utf-8")

    run_refresh_manifest("stale_provenance", tmp_path)

    refreshed = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    assert _layout(refreshed, "scatter")["source_columns"] == ["sx", "sy"]
    assert _layout(refreshed, "grid")["source_columns"] == [], (
        "grid depends on nothing, so the stale ['filename'] must be REPLACED by a written "
        "[] — carrying it through would stale grid on every metadata change forever"
    )


# --- per-derivation gates ----------------------------------------------------------


def test_categorical_missing_bucket_is_structural(tmp_path: Path) -> None:
    """A NULL category value maps to the structurally-missing band — labelled ``text=''``
    with ``missing: true`` (pipeline-known missingness, never a value-sniff on a real
    string); real-valued bands carry no ``missing`` key."""
    ds = tmp_path / "cat_missing"
    cat = ["a", "a", "a", "a", "b", "b", "b", None, None, None, "a", "b"]
    _build_pre25_dataset(ds, _cat_meta(cat), _cat_roles(), [("categorical", "categorical")])

    run_refresh_manifest("cat_missing", tmp_path)

    labels = _layout(
        json.loads((ds / "layout_manifest.json").read_text()), "categorical"
    )["annotations"]["labels"]
    missing = [lab for lab in labels if lab.get("missing")]
    assert len(missing) == 1
    assert missing[0]["text"] == ""
    assert missing[0]["count"] == 3  # exactly the three None cells
    assert all("missing" not in lab for lab in labels if lab["text"] != "")


def test_refresh_derives_the_v27_interval_rung(tmp_path: Path) -> None:
    """v2.7 (T2-142 / D-36 seam H3): the ROUND TRIP for the new field. A PRE-2.7 tree carries
    an axis with no `interval` at all; refresh re-runs the plugin and the rebuilt axis must
    come back carrying it — with the rung the bake really used, not a default.

    This is the upgrade path H4 depends on: a dataset baked before 2.7 gains the rung without
    a re-bake (no geometry moves in this seam), so the renderer's tick lock-step reaches
    existing trees. `run_refresh_manifest` reads `annotations` wholesale off the recomputed
    `LayoutResult`, so nothing in `worker.py` had to change for it to propagate — verified
    here rather than assumed.

    Two rungs again, and LITERAL: 60 photos twice a day over 29.5 days pick `('day', 1)` and
    60 over 590 days pick `('month', 1)`, so a refresh that emitted a constant rung (or
    dropped `step`) fails on one of them. Measured 2026-07-29 — the budget for n=60 is 39
    columns, so a 59-day span already falls through the day rung to months; the day case needs
    the tighter spacing."""
    for label, spacing_days, expected in (
        ("day rung", 0.5, {"kind": "day", "step": 1}),
        ("month rung", 10, {"kind": "month", "step": 1}),
    ):
        ds = tmp_path / f"dt_interval_{expected['kind']}"
        n = 60
        start = _dt.datetime(2021, 1, 1, tzinfo=_dt.timezone.utc)
        meta = pa.table(
            {
                "id": pa.array(range(n), pa.int64()),
                "filename": pa.array([f"{i:03d}.png" for i in range(n)], pa.string()),
                "t": pa.array(
                    [
                        int((start + _dt.timedelta(days=i * spacing_days)).timestamp())
                        for i in range(n)
                    ],
                    pa.int64(),
                ),
            }
        )
        roles = {
            "filename": {"column": "filename", "label": "File"},
            "datetime": {"column": "t", "label": "When", "format": "unix_seconds"},
        }
        committed = _build_pre25_dataset(ds, meta, roles, [("datetime", "datetime")])
        # The synthetic really is PRE-2.7: no annotations block at all, so the assertion below
        # cannot be satisfied by a value carried through from the committed manifest.
        assert "annotations" not in _layout(committed, "datetime"), label

        run_refresh_manifest(ds.name, tmp_path)

        refreshed = json.loads((ds / "layout_manifest.json").read_text())
        assert refreshed["manifest_version"] == MANIFEST_VERSION
        axis = _layout(refreshed, "datetime")["annotations"]["axes"][0]
        assert axis["interval"] == expected, f"{label}: got {axis.get('interval')!r}"


def test_datetime_overflow_declines_axis(tmp_path: Path) -> None:
    """A ``unix_seconds`` role fed MILLISECOND values overflows the ISO calendar (year
    ~52,000); the datetime layout DECLINES its axis (the R1 guard) and emits the explicit
    ``{'axes': []}`` marker — reproduced verbatim by refresh, so the client's pre-2.5 shim
    never resurrects the refused axis."""
    ds = tmp_path / "dt_overflow"
    n = 9
    base = 1_600_000_000_000  # ~2020 in millis, ~year 52,600 if read as seconds
    meta = pa.table(
        {
            "id": pa.array(range(n), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(n)], pa.string()),
            "t": pa.array([base + i * 1_000_000 for i in range(n)], pa.int64()),
        }
    )
    roles = {
        "filename": {"column": "filename", "label": "File"},
        "datetime": {"column": "t", "label": "When", "format": "unix_seconds"},
    }
    _build_pre25_dataset(ds, meta, roles, [("datetime", "datetime")])

    run_refresh_manifest("dt_overflow", tmp_path)

    assert _layout(
        json.loads((ds / "layout_manifest.json").read_text()), "datetime"
    )["annotations"] == {"axes": []}


def _narrow_scatter_meta(n: int, cols: int, step: float) -> pa.Table:
    """A corpus whose SCATTER layout draws itself into a sliver of the box: ``cols`` distinct
    x values ``step`` apart against a y range of ``n``, so the median-centred aspect fit —
    which scales BOTH axes by the same factor, sized off the taller one — compresses the x
    extent to ~1e-04 while the uniform cell keeps its own 0.9/ceil(sqrt(n)) size. The bbox is
    then the CELL wide, and the distinct columns are still resolvable inside it.

    THIS USED TO BE A DATETIME FIXTURE (`_packed_datetime_meta`: 2,400 images on one day plus
    40 spread over 250 days, drawing 3.3e-03 wide). D-36 seam H2 took that shape away at any
    fixture-sized corpus: a bin is now `k` images wide and the `k` solve trades stack depth for
    width until the WIDTH term binds, so a peaked datetime histogram fills the band instead of
    drawing a sliver. Measured on this branch, the old fixture draws **0.797** wide, and
    scaling it does not help — 24,040 / 120,040 / 400,040-cell versions draw 0.918 / 0.919 /
    0.920, because a bigger corpus buys a finer rung and the width term binds again.

    IS A NARROW DATETIME LAYOUT STILL REACHABLE? An earlier version of this note said no, and
    a later one said yes via the `k` search saturating at `_MAX_BIN_WIDTH_CELLS = 64`, quoting
    figures for "100,000 images one second apart". BOTH ARE NOW WRONG and the second was wrong
    when written (PR-198 review): 100,000 images one second apart resolve to the ('minute', 5)
    rung, 334 bins, and draw **0.919669** — 22x the 0.0412 it claimed — while its charitable
    reading (all inside ONE second) gives 0.039217 and 0.009807, both 5.1 % off the quoted
    numbers, as if measured against `box_h = 1.0` rather than the U1 `STRIP_Y_MIN`.

    The saturation route is gone regardless: PR-198 removed the ceiling and solves `k` from the
    populations, so the width term binds and a peaked datetime histogram fills the band. No
    fixture-sized datetime corpus is narrow, and the ones that are not fixture-sized are not
    affordable here.

    That does NOT weaken this test, and the reason is the rule itself: `_positions_tol` takes
    only `(span, magnitude)` — it never sees the layout — so a narrow SCATTER exercises the
    identical branch at the identical pair (6.43e-03 extent, 8.328e-07 drift) in 0.14 s
    against 6.8 s. What IS lost is that no datetime layout exercises the span-scaled arm any
    more; [[T2-153]] tracks restoring that cover cheaply."""
    xs = [(i % cols) * step for i in range(n)]
    return pa.table(
        {
            "id": pa.array(range(n), pa.int64()),
            "filename": pa.array([f"{i:06d}.png" for i in range(n)], pa.string()),
            "sx": pa.array(xs, pa.float64()),
            "sy": pa.array([float(i) for i in range(n)], pa.float64()),
        }
    )


def test_positions_gate_catches_a_sub_1e6_drift_on_a_narrow_layout(tmp_path: Path) -> None:
    """T2-143 (Defect B): Gate B must be calibrated to the LAYOUT, not to the box.

    ``_POSITIONS_TOL`` was an absolute 1e-6, justified as "far BELOW any real layout-geometry
    change (O(0.01-0.5))" — true only while every layout spanned the box. A layout that draws
    itself a few 1e-03 wide is one where 1e-6 is no longer small relative to anything the
    layout does: measured on 1,000,000 dated cells (600k on one day + 400k over 1000 days) a
    packed pre-H2 datetime histogram drew 3.3311e-03 on a 1.6656e-06 column pitch, so a
    faithful pre-T2-138-style HALF-COLUMN interior drift of 8.328e-07 slipped through — while
    Gate A is blind by construction (the endpoints are pinned, so the bbox never moves).
    ``refresh-manifest`` then accepted a tree that disagreed with the plugin and wrote derived
    ``bbox_exact``/``annotations`` off it.

    What Gate B actually sees is the (extent, drift) PAIR, and the fixture reproduces it at
    20,000 cells: 6.43e-03 wide, the same 8.328e-07 drift, which is 1.30x the rule's own
    tolerance there and still inside the old absolute ceiling. The test pins BOTH halves.

    The fixture is a SCATTER layout since D-36 seam H2 — see ``_narrow_scatter_meta`` for the
    measurement that forced the swap. Nothing about the rule under test is datetime-specific;
    the docstring's 1M datetime figures are kept because they are what the defect was found
    on."""
    ds = tmp_path / "narrow_scatter"
    meta = _narrow_scatter_meta(n=20_000, cols=20, step=0.1)
    roles = {
        "filename": {"column": "filename", "label": "File"},
        "scatter": [{"x_column": "sx", "y_column": "sy", "label": "S"}],
    }
    manifest = _build_pre25_dataset(ds, meta, roles, [("scatter", "scatter")])

    bbox = _layout(manifest, "scatter")["bbox"]
    span_x = bbox[2] - bbox[0]
    assert span_x < 0.01, f"the fixture must draw NARROW to exercise T2-143, got {span_x}"

    drift = 8.328e-07
    assert drift <= _POSITIONS_TOL, (
        "the drift must sit INSIDE the old absolute ceiling, or this test would have passed "
        "before the fix too"
    )
    assert drift > _positions_tol(span_x, max(abs(bbox[0]), abs(bbox[2]))), (
        "…and OUTSIDE the layout's own scale, or there is nothing to catch"
    )

    # Move the INTERIOR columns only (never the extreme x), so the 6-dp bbox is untouched
    # and Gate A cannot see it — the same construction the real regression has.
    path = ds / "positions" / "scatter_v1.arrow"
    ptab = feather.read_table(path)
    xs = ptab.column("x").to_pylist()
    lo, hi = min(xs), max(xs)
    moved = [x + drift if lo < x < hi else x for x in xs]
    assert moved != xs, "the fixture has no interior column to drift"
    feather.write_feather(
        pa.table({"x": pa.array(moved, pa.float32()), "y": ptab.column("y"),
                  "w": ptab.column("w"), "h": ptab.column("h")}),
        str(path),
        compression="uncompressed",
    )

    with pytest.raises(RefreshManifestError, match="diverge from the baked position table"):
        run_refresh_manifest("narrow_scatter", tmp_path)

    reloaded = json.loads((ds / "layout_manifest.json").read_text())
    assert "bbox_exact" not in reloaded["layouts"][0]  # manifest untouched
    assert not (ds / "layout_manifest.json.bak").exists()


def test_a_refusal_records_its_reason_in_ingest_log(tmp_path: Path) -> None:
    """T2-143: a refused ``refresh-manifest`` run wrote a "refresh-manifest start …" line
    into the dataset's PERMANENT ingest.log and then raised with no ``except`` between the
    ``try`` and the ``finally`` — so the log kept the start line and no reason, while the
    weaker Gate-B SKIP path did log its warning there. Every live dataset carrying a
    datetime layout hits this refusal after D-36 H1, once per attempt."""
    ds = tmp_path / "refusal_logged"
    manifest = _build_pre25_dataset(
        ds, _cat_meta(["a", "a", "b", "b", "c", "c"]), _cat_roles(), [("categorical", "categorical")]
    )
    manifest["layouts"][0]["bbox"][0] = 0.5  # no recompute can round to this (Gate A)
    (ds / "layout_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(RefreshManifestError):
        run_refresh_manifest("refusal_logged", tmp_path)

    log = (ds / "ingest.log").read_text(encoding="utf-8")
    assert "refresh-manifest start" in log, "the start line is the one that was already there"
    assert "REFUSED" in log and "bbox mismatch" in log, (
        f"the refusal left no reason in the dataset's own log:\n{log}"
    )


def test_a_failed_run_does_not_claim_it_wrote_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T2-143: the failure line must report what is ACTUALLY on disk.

    The ``.bak`` is copied immediately BEFORE ``revalidate_and_write``, so a failure inside
    that call leaves a backup behind — and the backup is deliberately write-once, so a later
    ``--force`` run finds it present and creates no new one. A blanket "nothing was written"
    would therefore tell the operator their pristine copy does not exist at exactly the
    moment it does, and the file they later trust as pristine was created by a failed run."""
    import pipeline.worker as worker_module

    ds = tmp_path / "write_failed"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])

    def _boom(manifest: dict, path: Path) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(worker_module, "revalidate_and_write", _boom)
    with pytest.raises(OSError):
        run_refresh_manifest("write_failed", tmp_path)

    assert (ds / "layout_manifest.json.bak").exists(), (
        "the backup is copied before the rewrite — this test is vacuous if it is not there"
    )
    log = (ds / "ingest.log").read_text(encoding="utf-8")
    assert "nothing was written" not in log, (
        f"the log claims nothing was written, but the .bak exists:\n{log}"
    )
    assert "layout_manifest.json.bak" in log, f"the log does not say what WAS written:\n{log}"


def test_bbox_gate_stops_on_inconsistent_manifest(tmp_path: Path) -> None:
    """Gate A: a committed ``bbox`` that disagrees (6 dp) with the recompute — a baked tree
    that predates a layout-geometry change — aborts refresh; nothing is written (no
    ``bbox_exact``, no ``.bak``)."""
    ds = tmp_path / "bbox_bad"
    manifest = _build_pre25_dataset(
        ds, _cat_meta(["a", "a", "b", "b", "c", "c"]), _cat_roles(), [("categorical", "categorical")]
    )
    manifest["layouts"][0]["bbox"][0] = 0.5  # no recompute can round to this
    (ds / "layout_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    with pytest.raises(RefreshManifestError, match="bbox mismatch"):
        run_refresh_manifest("bbox_bad", tmp_path)

    reloaded = json.loads((ds / "layout_manifest.json").read_text())
    assert "bbox_exact" not in reloaded["layouts"][0]
    assert not (ds / "layout_manifest.json.bak").exists()


def test_positions_gate_stops_on_tampered_table(tmp_path: Path) -> None:
    """Gate B: a baked position table the recompute cannot reproduce (a geometry change
    that preserved the bbox but moved cells — Gate A blind) aborts refresh."""
    ds = tmp_path / "pos_bad"
    _build_pre25_dataset(
        ds, _cat_meta(["a", "a", "b", "b", "c", "c"]), _cat_roles(), [("categorical", "categorical")]
    )
    ptab = feather.read_table(ds / "positions" / "categorical_v1.arrow")
    xs = ptab.column("x").to_pylist()
    xs[0] += 0.2  # far beyond _POSITIONS_TOL
    feather.write_feather(
        pa.table(
            {"x": pa.array(xs, pa.float32()), "y": ptab.column("y"),
             "w": ptab.column("w"), "h": ptab.column("h")}
        ),
        str(ds / "positions" / "categorical_v1.arrow"),
        compression="uncompressed",
    )

    with pytest.raises(RefreshManifestError, match="diverge from the baked position table"):
        run_refresh_manifest("pos_bad", tmp_path)

    reloaded = json.loads((ds / "layout_manifest.json").read_text())
    assert "bbox_exact" not in reloaded["layouts"][0]  # manifest untouched
    assert not (ds / "layout_manifest.json.bak").exists()  # and no backup litter


def test_backup_written_before_rewrite(tmp_path: Path) -> None:
    """A ``layout_manifest.json.bak`` holding the PRE-refresh manifest verbatim is written
    before the enriched manifest replaces it."""
    ds = tmp_path / "bak_ds"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    before = (ds / "layout_manifest.json").read_text(encoding="utf-8")

    run_refresh_manifest("bak_ds", tmp_path)

    bak = ds / "layout_manifest.json.bak"
    assert bak.exists()
    assert bak.read_text(encoding="utf-8") == before
    after = json.loads((ds / "layout_manifest.json").read_text())
    assert after["manifest_version"] == MANIFEST_VERSION
    assert "bbox_exact" in after["layouts"][0]  # the enrichment actually landed


def test_refuses_already_enriched_without_force(tmp_path: Path) -> None:
    """A manifest already at >=2.5 with the enrichment is refused (clean error) — unless
    ``--force`` re-derives and overwrites."""
    ds = tmp_path / "refuse_ds"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    run_refresh_manifest("refuse_ds", tmp_path)  # -> now 2.5-enriched

    with pytest.raises(RefreshManifestError, match="already at manifest_version"):
        run_refresh_manifest("refuse_ds", tmp_path)

    result = run_refresh_manifest("refuse_ds", tmp_path, force=True)  # --force proceeds
    assert result["manifest_version"] == MANIFEST_VERSION


def test_dataset_version_does_not_bump(tmp_path: Path) -> None:
    """The refresh is the SAME bake with a richer description — the dataset_version and the
    version-stamped asset refs are unchanged."""
    ds = tmp_path / "ver_ds"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])

    run_refresh_manifest("ver_ds", tmp_path)

    after = json.loads((ds / "layout_manifest.json").read_text())
    assert after["dataset_version"] == 1
    assert after["layouts"][0]["positions_ref"] == "positions/categorical_v1.arrow"
    assert after["layouts"][0]["pyramid"]["path"] == "tiles/categorical/categorical_v1.pmtiles"


def test_gates_refuse_a_plugin_geometry_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE load-bearing safety property (the #183 adversarial verification's attack,
    pinned): bake under the real plugin, then CHANGE the plugin's geometry (a genuine
    constant tweak, not a table tamper) — refresh must REFUSE rather than emit annotations
    derived from geometry the baked tree doesn't have. Which gate fires depends on whether
    the change moves the 6-dp bbox (Gate A) or only the interior cells (Gate B); either
    refusal is the same safety outcome. The manifest must stay byte-identical, no ``.bak``."""
    from pipeline.layout_plugins import categorical

    ds = tmp_path / "plugin_drift"
    _build_pre25_dataset(
        ds, _cat_meta(["a", "a", "a", "b", "b", "c"]), _cat_roles(), [("categorical", "categorical")]
    )
    before = (ds / "layout_manifest.json").read_text(encoding="utf-8")

    monkeypatch.setattr(categorical, "_REGION_FILL", 0.85)  # "the layout code changed since the bake"
    with pytest.raises(RefreshManifestError):
        run_refresh_manifest("plugin_drift", tmp_path)

    assert (ds / "layout_manifest.json").read_text(encoding="utf-8") == before
    assert not (ds / "layout_manifest.json.bak").exists()


def test_force_rerun_preserves_pristine_backup(tmp_path: Path) -> None:
    """The ``.bak`` is written ONCE: after a ``--force`` re-run it still holds the pristine
    PRE-enrichment manifest, not the previously-enriched 2.5 one (#183 verification rider)."""
    ds = tmp_path / "bak_pristine"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    pristine = (ds / "layout_manifest.json").read_text(encoding="utf-8")

    first = run_refresh_manifest("bak_pristine", tmp_path)
    bak = ds / "layout_manifest.json.bak"
    assert bak.read_text(encoding="utf-8") == pristine
    assert first["backup_written"] is True  # this run created the .bak

    second = run_refresh_manifest("bak_pristine", tmp_path, force=True)
    assert bak.read_text(encoding="utf-8") == pristine  # NOT clobbered by the enriched copy
    assert json.loads(bak.read_text(encoding="utf-8"))["manifest_version"] == "2.4"
    assert second["backup_written"] is False  # pristine .bak preserved, not rewritten


def _strip_positions_ref(ds: Path) -> None:
    """Rewrite the dataset's manifest WITHOUT ``positions_ref`` (+ delete the tables) — the
    pre-2.2 shape whose refresh must skip Gate B and SAY SO."""
    manifest = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    for layout in manifest["layouts"]:
        layout.pop("positions_ref", None)
    _validate_manifest(manifest)  # the pre-2.2 shape must itself be schema-valid
    (ds / "layout_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    shutil.rmtree(ds / "positions")


def test_positions_gate_skip_is_surfaced(tmp_path: Path) -> None:
    """A no-positions layout (pre-2.2 bake) skips Gate B — and the skip is REPORTED in the
    return dict, never silent (#183 verification rider: the job logger's warning lands only
    in ingest.log)."""
    ds = tmp_path / "no_pos"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    _strip_positions_ref(ds)

    result = run_refresh_manifest("no_pos", tmp_path)

    assert result["positions_gate_skipped"] == ["categorical"]
    enriched = json.loads((ds / "layout_manifest.json").read_text())
    assert "bbox_exact" in enriched["layouts"][0]  # Gate A alone still enriches


def test_cli_prints_positions_gate_skip_warning(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI surfaces the Gate-B skip on the CONSOLE (stdout), so a reduced verification
    margin never looks like a full pass; a both-gates run prints no such warning."""
    from pipeline.cli import main

    ds = tmp_path / "cli_no_pos"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    _strip_positions_ref(ds)
    root = str(tmp_path)

    assert main(["refresh-manifest", "--dataset-id", "cli_no_pos", "--output-root", root]) == 0
    out = capsys.readouterr().out
    assert "per-cell reproduction gate SKIPPED" in out
    assert "['categorical']" in out

    ds2 = tmp_path / "cli_with_pos"
    _build_pre25_dataset(ds2, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    assert main(["refresh-manifest", "--dataset-id", "cli_with_pos", "--output-root", root]) == 0
    assert "SKIPPED" not in capsys.readouterr().out


# --- v2.10: the fingerprint backfill (seam L7 / LAYOUT_DESIGNER D-xxix) ---------------
#
# Refresh is the ONLY non-bake writer of `source_fingerprint`, and only because Gate B
# RAISES unless the layout recomputed from the committed roles reproduces the baked
# positions — which turns "these are the roles it was baked from" from an assertion into a
# check. Everything below is about the boundary of that licence.


def test_refresh_writes_a_fingerprint_for_a_layout_gate_b_checked(tmp_path: Path) -> None:
    """The migration path D-xxix names: one refresh run and a pre-2.10 collection can say
    whether its layouts are stale. Gate B ran (the tree has position tables), so the claim
    is checked and the key is written — in the emitter's canonical slot, and with the
    tuples the layout's own role entry contributes."""
    ds = tmp_path / "backfill"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])

    result = run_refresh_manifest("backfill", tmp_path)

    assert result["positions_gate_skipped"] == [], "premise: Gate B ran on every layout"
    assert result["fingerprints_written"] == ["categorical"]
    entry = _layout(json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8")), "categorical")
    assert entry["source_fingerprint"] == {"cat": [["categorical"]]}
    assert list(entry).index("source_fingerprint") == list(entry).index("source_columns") + 1


def test_refresh_keeps_an_EXISTING_fingerprint_byte_for_byte(tmp_path: Path) -> None:
    """The `_LAYOUT_ENTRY_KNOWN` trap, and the reason that frozenset needed BOTH halves of
    the change. `_enrich_layout_entry` rebuilds every entry from scratch and appends
    anything outside that set through a catch-all, so naming `source_fingerprint` there
    WITHOUT re-emitting it drops every recorded fingerprint on the floor — turning every
    checkable layout unchecked, silently, on the very run meant to make them checkable.

    The committed record here is deliberately NOT what this run would derive (it claims a
    `tag` reading), so a re-derivation and a carry-through are distinguishable. That is the
    production shape whenever the roles have moved since the bake: the bake record must
    win, because it is the only evidence of what was actually read."""
    ds = tmp_path / "keep_fp"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    manifest_path = ds / "layout_manifest.json"
    committed = json.loads(manifest_path.read_text(encoding="utf-8"))
    baked_record = {"cat": [["tag", ";"]]}
    _layout(committed, "categorical")["source_fingerprint"] = baked_record
    manifest_path.write_text(json.dumps(committed, indent=2) + "\n", encoding="utf-8")

    # Without the flag AND with Gate B skipped: nothing is checked, so nothing is written.
    _strip_positions_ref(ds)
    result = run_refresh_manifest("keep_fp", tmp_path, force=True)

    assert result["positions_gate_skipped"] == ["categorical"]
    assert result["fingerprints_written"] == []
    refreshed = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert _layout(refreshed, "categorical")["source_fingerprint"] == baked_record, (
        "the committed record survived, and was not re-derived from the current roles"
    )
    # ...and in the canonical slot, not appended after the catch-all loop's fields.
    entry = _layout(refreshed, "categorical")
    assert list(entry).index("source_fingerprint") == list(entry).index("source_columns") + 1


def test_refresh_leaves_a_gate_b_skipped_layout_unwritten_unless_asserted(
    tmp_path: Path,
) -> None:
    """Gate B could not run (a pre-2.2 bake, no position table), so nothing has been
    checked and refresh must not invent a record from the CURRENT roles — that would be a
    claim about a bake it cannot see. `--assume-roles-unchanged` is the operator supplying
    exactly that claim, and it is never implied."""
    ds = tmp_path / "no_pos_fp"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    _strip_positions_ref(ds)

    unchecked = run_refresh_manifest("no_pos_fp", tmp_path)

    assert unchecked["fingerprints_written"] == []
    refreshed = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    assert "source_fingerprint" not in _layout(refreshed, "categorical"), (
        "ABSENT, not `{}` — `{}` would claim the layout reads no column"
    )
    # ...and the stamp did NOT move to 2.10 over a file with no such key anywhere.
    assert refreshed["manifest_version"] == "2.4"
    assert unchecked["manifest_version"] == "2.4"

    asserted = run_refresh_manifest(
        "no_pos_fp", tmp_path, force=True, assume_roles_unchanged=True
    )

    assert asserted["fingerprints_written"] == ["categorical"]
    assert asserted["manifest_version"] == MANIFEST_VERSION
    refreshed = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    assert _layout(refreshed, "categorical")["source_fingerprint"] == {"cat": [["categorical"]]}
    assert refreshed["manifest_version"] == MANIFEST_VERSION


def test_refresh_stamps_210_only_when_every_entry_carries_the_key(tmp_path: Path) -> None:
    """The stamp describes the FILE — the rule `set-roles` and `delete-layout` already
    follow, and which refresh used to be exempt from because every field it wrote landed on
    every entry. `source_fingerprint` is the first one it may have to leave off, and
    stamping 2.10 over a file where an entry has no such key is exactly the "the stamp
    claims content that is not there" bug the 2.9 rule exists to prevent.

    Two layouts, one with a position table and one without, in one tree: the mixed case a
    single-layout fixture cannot show."""
    ds = tmp_path / "mixed"
    meta = pa.table(
        {
            "id": pa.array(range(3), pa.int64()),
            "filename": pa.array(["a.png", "b.png", "c.png"], pa.string()),
            "cat": pa.array(["a", "a", "b"], pa.string()),
        }
    )
    _build_pre25_dataset(ds, meta, _cat_roles(), [("grid", "grid"), ("categorical", "categorical")])
    manifest_path = ds / "layout_manifest.json"
    committed = json.loads(manifest_path.read_text(encoding="utf-8"))
    _layout(committed, "categorical").pop("positions_ref")  # only THIS one skips Gate B
    manifest_path.write_text(json.dumps(committed, indent=2) + "\n", encoding="utf-8")

    result = run_refresh_manifest("mixed", tmp_path)

    assert result["positions_gate_skipped"] == ["categorical"]
    assert result["fingerprints_written"] == ["grid"], "the checked one, and only it"
    refreshed = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert _layout(refreshed, "grid")["source_fingerprint"] == {}
    assert "source_fingerprint" not in _layout(refreshed, "categorical")
    assert refreshed["manifest_version"] == "2.4", (
        "one entry lacks the key, so the whole file has not earned the 2.10 stamp"
    )
    # Every OTHER derived field still landed on both entries — the withheld stamp is a
    # judgement about the fingerprint, not a refusal to enrich.
    assert all("bbox_exact" in la for la in refreshed["layouts"])
    assert all("source_columns" in la for la in refreshed["layouts"])


def test_the_flag_never_overwrites_an_existing_record_and_says_why(tmp_path: Path) -> None:
    """`--assume-roles-unchanged` asserts *no role has changed since this collection was
    baked*. A layout that already records HOW it read its columns, with a record that
    DISAGREES with the committed roles, is direct evidence that the assertion is false —
    so overwriting it would launder a durably stale layout to fresh, which is the single
    outcome this seam exists to prevent (2026-09-23 review, finding 3).

    The shape is the one `test_refresh_keeps_an_EXISTING_fingerprint_byte_for_byte` builds:
    a Gate-B-skipped layout whose record says `tag` where the roles say `categorical`."""
    ds = tmp_path / "no_overwrite"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    manifest_path = ds / "layout_manifest.json"
    committed = json.loads(manifest_path.read_text(encoding="utf-8"))
    baked_record = {"cat": [["tag", ";"]]}
    _layout(committed, "categorical")["source_fingerprint"] = baked_record
    manifest_path.write_text(json.dumps(committed, indent=2) + "\n", encoding="utf-8")
    _strip_positions_ref(ds)

    result = run_refresh_manifest(
        "no_overwrite", tmp_path, force=True, assume_roles_unchanged=True
    )

    refreshed = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert _layout(refreshed, "categorical")["source_fingerprint"] == baked_record, (
        "the bake record survived the operator's assertion — it is the evidence against it"
    )
    assert result["fingerprints_written"] == []
    assert result["assumption_contradicted"] == ["categorical"]
    assert "DISAGREES with the committed roles" in (ds / "ingest.log").read_text(encoding="utf-8")
    # ...and the layout is NOT in the "still unchecked" population the CLI advises on.
    assert result["has_record"] == ["categorical"]


def test_the_flag_still_fills_an_ABSENT_record(tmp_path: Path) -> None:
    """The other half: the flag exists to fill gaps, and a layout with nothing to say is
    exactly the gap. Same tree, no pre-existing record."""
    ds = tmp_path / "fills_gap"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    _strip_positions_ref(ds)

    result = run_refresh_manifest("fills_gap", tmp_path, assume_roles_unchanged=True)

    assert result["fingerprints_written"] == ["categorical"]
    assert result["assumption_contradicted"] == []
    refreshed = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    assert _layout(refreshed, "categorical")["source_fingerprint"] == {"cat": [["categorical"]]}


def test_refresh_offers_the_fingerprint_backfill_on_a_25_to_29_tree(tmp_path: Path) -> None:
    """THE MIGRATION MUST BE ONE RUN (2026-09-23 review, finding 4). The schema, the
    CHANGELOG and D-xxix all describe backfilling `source_fingerprint` as "one
    refresh-manifest run". The guard used to key on `manifest_version >= 2.5` plus
    bbox_exact/annotations, so EVERY existing 2.5-2.9 collection — which is every
    collection — answered "nothing to do" while carrying no fingerprint at all, and the
    documented migration was impossible without `--force`.

    Keyed on FIELD PRESENCE, the same tree now has outstanding work and is refreshed."""
    ds = tmp_path / "enriched_29"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    run_refresh_manifest("enriched_29", tmp_path)  # bring it up to date...
    manifest_path = ds / "layout_manifest.json"
    committed = json.loads(manifest_path.read_text(encoding="utf-8"))
    # ...then wind it back to exactly a 2.9 collection: every derived field but the 2.10 one.
    committed["manifest_version"] = "2.9"
    del _layout(committed, "categorical")["source_fingerprint"]
    manifest_path.write_text(json.dumps(committed, indent=2) + "\n", encoding="utf-8")

    result = run_refresh_manifest("enriched_29", tmp_path)  # NO --force

    assert result["fingerprints_written"] == ["categorical"]
    assert result["manifest_version"] == MANIFEST_VERSION
    refreshed = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert _layout(refreshed, "categorical")["source_fingerprint"] == {"cat": [["categorical"]]}

    # ...and with nothing outstanding, the guard fires again and names what it checked.
    with pytest.raises(RefreshManifestError, match="every layout entry carries every"):
        run_refresh_manifest("enriched_29", tmp_path)


def test_a_fully_enriched_tree_at_an_OLD_stamp_is_still_refused(tmp_path: Path) -> None:
    """The conditional stamp disabled the idempotency guard (2026-09-23 review, finding 7).
    A pre-2.5 tree with a Gate-B-skipped layout gets every derived field written, but the
    stamp cannot move to 2.10 while that layout records no fingerprint — so a guard keyed
    on the STAMP never fires again and every flagless run re-derives and rewrites the file.

    Keyed on field presence, and counting only the work THIS RUN COULD DO, the second run
    is refused — stamp notwithstanding, and although a `source_fingerprint` is still
    missing. It is missing because Gate B cannot run on this layout and the operator did
    not assert; re-deriving the whole manifest for a key that will not be written either
    way is a treadmill, not progress."""
    ds = tmp_path / "old_stamp_unchecked"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    _strip_positions_ref(ds)

    first = run_refresh_manifest("old_stamp_unchecked", tmp_path)

    assert first["manifest_version"] == "2.4", "premise: enriched, but the stamp is withheld"
    enriched = json.loads((ds / "layout_manifest.json").read_text(encoding="utf-8"))
    assert "bbox_exact" in _layout(enriched, "categorical"), "premise: it really was enriched"
    assert "source_fingerprint" not in _layout(enriched, "categorical")

    # ...and the refusal NAMES the gap and the flag that fills it (2026-09-24 round-2
    # review, N3). "Nothing to do" alone reads as "you are done" while the collection is
    # still unchecked and the operator holds the one thing that would change that.
    with pytest.raises(RefreshManifestError) as refusal:
        run_refresh_manifest("old_stamp_unchecked", tmp_path)
    assert "['categorical']" in str(refusal.value)
    assert "--assume-roles-unchanged" in str(refusal.value)
    assert "no role has changed since this collection was baked" in str(refusal.value)

    # ...and the flag DOES make it work again, because now the gap is fillable.
    asserted = run_refresh_manifest(
        "old_stamp_unchecked", tmp_path, assume_roles_unchanged=True
    )
    assert asserted["fingerprints_written"] == ["categorical"]
    assert asserted["manifest_version"] == MANIFEST_VERSION


def test_cli_names_the_flag_and_states_what_it_asserts(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The operator has to be able to act on the unchecked case, and the flag's help text
    states the ASSERTION rather than describing the flag — because that assertion is what
    is being taken on trust. The run also says which layouts it recorded for."""
    from pipeline.cli import main

    ds = tmp_path / "cli_fp"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    _strip_positions_ref(ds)
    root = str(tmp_path)

    assert main(["refresh-manifest", "--dataset-id", "cli_fp", "--output-root", root]) == 0
    out = capsys.readouterr().out
    assert "Recorded how 0 layout(s) read their columns" in out
    assert "--assume-roles-unchanged" in out
    assert "no role has changed since this collection was baked" in out
    # ...and NOT `--force` (2026-09-24 round-2 review, N3): the flag alone now makes the gap
    # outstanding, so the hint must not tell the operator to overwrite everything as well.
    assert "--force" not in out

    assert main([
        "refresh-manifest", "--dataset-id", "cli_fp", "--output-root", root,
        "--force", "--assume-roles-unchanged",
    ]) == 0
    out = capsys.readouterr().out
    assert "Recorded how 1 layout(s) read their columns" in out
    assert "--assume-roles-unchanged" not in out, "nothing left to assert"


def test_missing_dataset_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        run_refresh_manifest("does_not_exist", tmp_path)


def test_cli_refresh_manifest_roundtrip_and_refusal(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The CLI wiring: exit 0 on success, exit 2 on the already-enriched refusal, exit 0
    again under --force — and the --force re-run reports the .bak as a preserved pristine
    copy (it is written once), never as if this run created it."""
    from pipeline.cli import main

    ds = tmp_path / "cli_ds"
    _build_pre25_dataset(ds, _cat_meta(["a", "a", "b"]), _cat_roles(), [("categorical", "categorical")])
    root = str(tmp_path)

    assert main(["refresh-manifest", "--dataset-id", "cli_ds", "--output-root", root]) == 0
    manifest = json.loads((ds / "layout_manifest.json").read_text())
    assert manifest["manifest_version"] == MANIFEST_VERSION
    assert "bbox_exact" in manifest["layouts"][0]
    assert "preserved" not in capsys.readouterr().out  # first run wrote the .bak itself

    assert main(["refresh-manifest", "--dataset-id", "cli_ds", "--output-root", root]) == 2
    capsys.readouterr()  # clear the refusal output
    assert main(["refresh-manifest", "--dataset-id", "cli_ds", "--output-root", root, "--force"]) == 0
    assert "pre-existing pristine copy, preserved" in capsys.readouterr().out
