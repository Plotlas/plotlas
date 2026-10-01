"""Seam L2 — the layout lifecycle: `delete-layout` and `set-roles`.

Two manifest operations a committed dataset did not have, neither of which bakes
anything: remove a layout ([[T2-a-layout-cannot-be-deleted-only-the-whole]]) and
re-declare `column_roles` ([[T2-a-role-cannot-be-changed-without-also-queueing]]).
`add-layouts --replace` is the third verb and is pinned natively in
test_add_layouts.py, because it is the one that actually bakes.

LEAN (no pyvips/pmtiles): both verbs are a read → rewrite → sweep over a committed
tree, so they run in the lean test image against a COPY of a committed fixture.

FIXTURE NOTE, measured 2026-09-09. The brief for this seam names
`golden_dataset_v2` for the "removes exactly one entry, leaves every sibling
byte-identical" spec. That tree has exactly ONE layout (`grid`) — so it has no
siblings and `delete-layout` must refuse on it, which is spec 2's case, not spec
1's. `golden_dataset_full_v2` carries six layouts (grid, datetime, scatter,
categorical_group, categorical_bucket, geographic) at `manifest_version` 2.8, so
spec 1 runs there and `golden_dataset_v2` serves spec 2 exactly as written.

The 2.8 stamp is load-bearing for the stale-set specs rather than incidental: NO
entry in that fixture carries `source_columns` (the v2.9 key), so it is the real
"absent means UNKNOWN, not empty" case rather than a synthesised one.
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import json
import re
import shlex
import shutil
from pathlib import Path
from types import SimpleNamespace

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import cli, worker
from pipeline.ingest import ColumnRoleError, write_positions_table, write_tags_sidecar
from pipeline.manifest import (
    append_manifest_layouts,
    MANIFEST_VERSION,
    _GEO_KNOB_DEFAULTS,      # the EMITTER's knob lists -- the knob pins are driven from
    _SCATTER_KNOB_DEFAULTS,  # these, never from a copy of the names
    write_manifest,
)
from pipeline.worker import (
    DeleteLayoutJobPayload,
    LayoutLifecycleError,
    SetRolesJobPayload,
    run_delete_layout,
    run_set_roles,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "tests" / "fixtures"

# Deliberately NON-canonical bytes (odd key order, a trailing space, no trailing
# newline). The claim is that these verbs leave `presentation.json` ALONE — a
# re-serialised-but-equal file would pass a value comparison while failing that.
# `default_layout` and the `layouts` override both name `datetime`, the layout the
# delete spec removes, so the file is left holding TWO dangling references. D-xvi:
# a dangling reference falls back on read and is never repaired by the worker.
_PRESENTATION = (
    '{"presentation_version": "1.0", "layouts": {"datetime": {"label": "Timeline"}},\n'
    '  "dataset": {"default_layout": "datetime", "display_name": "Golden"}} '
)


def _copy_fixture(name: str, tmp_path: Path) -> tuple[Path, Path]:
    """A writable copy of a committed fixture tree, as ``(output_root, dataset_dir)``.
    The fixtures are shared with the API and frontend suites and are READ-ONLY to this
    package (prime directive 5) — every test here mutates the copy."""
    output_root = tmp_path / "datasets"
    dataset_dir = output_root / name
    shutil.copytree(FIXTURES / name, dataset_dir)
    return output_root, dataset_dir


def _manifest(dataset_dir: Path) -> dict:
    return json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))


def _entries_by_id(manifest: dict) -> dict[str, str]:
    """Each layout entry serialised EXACTLY as it sits in the file — key order included.
    Comparing these strings is what "byte-preserved" means here: a carried-forward entry
    that was re-derived rather than carried would differ in key order or in a rounded
    value even when it compares equal as a dict."""
    return {
        entry["layout_id"]: json.dumps(entry, indent=2) for entry in manifest["layouts"]
    }


def _tree(dataset_dir: Path) -> dict[str, int]:
    """Every file under the dataset, dataset-relative -> size. The "nothing changed"
    assertion for a refusal."""
    return {
        path.relative_to(dataset_dir).as_posix(): path.stat().st_size
        for path in sorted(dataset_dir.rglob("*"))
        if path.is_file()
    }


# --- delete-layout -------------------------------------------------------------------


def test_delete_layout_removes_one_entry_and_carries_the_rest_byte_preserved(
    tmp_path: Path,
) -> None:
    """Spec 1. One entry leaves; every sibling is byte-identical; the layout's
    `tiles/{id}/` and its position table are gone; `presentation.json` is untouched even
    though the delete just orphaned BOTH of its references to that layout."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    presentation = dataset_dir / "presentation.json"
    presentation.write_text(_PRESENTATION, encoding="utf-8")
    before = _manifest(dataset_dir)
    before_entries = _entries_by_id(before)
    assert "datetime" in before_entries, "fixture premise: the target layout is committed"
    assert (dataset_dir / "tiles" / "datetime" / "datetime_v1.pmtiles").is_file()
    assert (dataset_dir / "positions" / "datetime_v1.arrow").is_file()

    result = run_delete_layout(
        DeleteLayoutJobPayload(
            dataset_id="golden_dataset_full_v2",
            owner="tester",
            layout_id="datetime",
            output_root=output_root,
        )
    )

    after = _manifest(dataset_dir)
    after_entries = _entries_by_id(after)
    assert set(before_entries) - set(after_entries) == {"datetime"}
    assert set(after_entries) - set(before_entries) == set()
    for layout_id, serialized in after_entries.items():
        assert serialized == before_entries[layout_id], (
            f"{layout_id} was re-serialised rather than carried through byte-preserved"
        )
    # Order is preserved too — the survivors keep the sequence the bake wrote, which is
    # what a `default_layout` fallback to "the first layout" resolves against.
    assert [e["layout_id"] for e in after["layouts"]] == [
        e["layout_id"] for e in before["layouts"] if e["layout_id"] != "datetime"
    ]

    # The bytes the layout owned are gone, and ONLY those.
    assert not (dataset_dir / "tiles" / "datetime").exists()
    assert not (dataset_dir / "positions" / "datetime_v1.arrow").exists()
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").is_file()
    assert (dataset_dir / "positions" / "grid_v1.arrow").is_file()
    assert (dataset_dir / "metadata.parquet").is_file()
    assert (dataset_dir / "tags" / "tags_v1.arrow").is_file()
    assert sorted(result["swept"]) == [
        "positions/datetime_v1.arrow",
        "tiles/datetime/datetime_v1.pmtiles",
    ]
    assert result["deleted"] == "datetime"
    assert result["layouts"] == [e["layout_id"] for e in after["layouts"]]

    # D-xvi: the presentation record keeps BOTH now-dangling references, byte-identical.
    assert presentation.read_text(encoding="utf-8") == _PRESENTATION


def test_delete_layout_refuses_the_last_layout_and_changes_nothing(tmp_path: Path) -> None:
    """Spec 2. D-viii's guarantee is that the DEFAULT LAYOUT RESOLVES, and it cannot
    resolve against an empty list; `layouts` is also `minItems: 1` in the v2 schema.
    Refused BEFORE the write, so the operator gets a sentence rather than a jsonschema
    traceback — and the tree is exactly as it was."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_v2", tmp_path)
    assert len(_manifest(dataset_dir)["layouts"]) == 1, "fixture premise: one layout"
    before_tree = _tree(dataset_dir)
    before_manifest = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(LayoutLifecycleError, match="would leave the dataset with none"):
        run_delete_layout(
            DeleteLayoutJobPayload(
                dataset_id="golden_dataset_v2",
                owner="tester",
                layout_id="grid",
                output_root=output_root,
            )
        )

    assert (dataset_dir / "layout_manifest.json").read_bytes() == before_manifest
    # "the tree is unchanged afterwards", literally: not one file added, removed or
    # resized — INCLUDING `ingest.log`, which this refusal never opens. That follows
    # `run_refresh_manifest`'s rule ("checked BEFORE touching the log — a no-op run
    # leaves ingest.log untouched"): a guard that costs nothing and writes nothing
    # should not be the thing that conjures a log file onto a dataset that had none.
    assert _tree(dataset_dir) == before_tree
    assert not (dataset_dir / "ingest.log").exists()


def test_delete_layout_refuses_an_id_that_is_not_committed(tmp_path: Path) -> None:
    """`--layout` naming something that was never baked is a typo, not a no-op. It names
    what IS committed so the operator can fix it in one read."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(LayoutLifecycleError, match="is not a committed layout"):
        run_delete_layout(
            DeleteLayoutJobPayload(
                dataset_id="golden_dataset_full_v2",
                owner="tester",
                layout_id="categorical_nope",
                output_root=output_root,
            )
        )

    assert (dataset_dir / "layout_manifest.json").read_bytes() == before


def test_delete_layout_bumps_dataset_version_but_not_manifest_version(
    tmp_path: Path,
) -> None:
    """The `dataset_version` decision, pinned rather than only argued in the docstring.

    BUMPS, because the line between the append path (always bumps) and
    `refresh-manifest` (deliberately does not) is *did the set of live assets change* —
    and this verb deletes files the previous manifest named, so a client holding it now
    404s. `dataset_version` is that client's cache generation: measured 2026-09-09,
    `frontend/src/renderer/detailOverlay.ts:303` keys the detail cache as
    `{dataset_id}/v{dataset_version}/{cellId}` and `:710` drops the cache when it moves.

    `manifest_version` does NOT re-stamp: this verb adds no current-MINOR field, so the
    committed 2.8 stamp stays truthful. Re-stamping to 2.9 would claim `source_columns`
    on entries that do not carry it."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    before = _manifest(dataset_dir)
    assert before["dataset_version"] == 1
    assert before["manifest_version"] == "2.8"

    result = run_delete_layout(
        DeleteLayoutJobPayload(
            dataset_id="golden_dataset_full_v2",
            owner="tester",
            layout_id="geographic",
            output_root=output_root,
        )
    )

    after = _manifest(dataset_dir)
    assert after["dataset_version"] == 2
    assert result["dataset_version"] == "2"
    assert after["manifest_version"] == "2.8"


def test_delete_layout_leaves_the_column_role_it_was_baked_from_declared(
    tmp_path: Path,
) -> None:
    """A role is a declaration about the METADATA; the layout is one thing built from it.
    Deleting the layout must not silently un-declare the column — otherwise
    `add-layouts categorical_group` could not re-bake it, and the user's role mapping
    would be edited by a verb they asked to delete tiles with."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    before_roles = _manifest(dataset_dir)["column_roles"]

    run_delete_layout(
        DeleteLayoutJobPayload(
            dataset_id="golden_dataset_full_v2",
            owner="tester",
            layout_id="categorical_group",
            output_root=output_root,
        )
    )

    assert _manifest(dataset_dir)["column_roles"] == before_roles


def test_delete_layout_refuses_when_the_manifest_moved_under_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """COMPARE-AND-SET. The plan — including "would this leave zero layouts?" — is
    computed against the bytes read before the commit lock. If another writer lands in
    between, those bytes are no longer current and the run must refuse rather than
    clobber. Simulated by writing the manifest from inside the lock, which is the only
    window where it can happen."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    manifest_path = dataset_dir / "layout_manifest.json"

    import contextlib

    from pipeline import worker

    @contextlib.contextmanager
    def _racing_lock(dataset_id: str):  # type: ignore[no-untyped-def]
        manifest_path.write_text(
            manifest_path.read_text(encoding="utf-8") + "\n", encoding="utf-8"
        )
        yield

    monkeypatch.setattr(worker, "_commit_lock", _racing_lock)
    before_race = manifest_path.read_bytes()

    with pytest.raises(LayoutLifecycleError, match="changed while this job was validating"):
        run_delete_layout(
            DeleteLayoutJobPayload(
                dataset_id="golden_dataset_full_v2",
                owner="tester",
                layout_id="datetime",
                output_root=output_root,
            )
        )

    # The other writer's bytes survive untouched (they are the pre-race bytes plus the
    # newline that writer appended), and the sweep never ran.
    assert manifest_path.read_bytes() == before_race + b"\n"
    assert (dataset_dir / "tiles" / "datetime" / "datetime_v1.pmtiles").is_file()


# --- set-roles -----------------------------------------------------------------------
#
# These need a manifest that actually carries `source_columns`, and no committed fixture
# does (every v2 fixture predates 2.9 — checked 2026-09-09). So the tree is built with the
# REAL emitter, `manifest.write_manifest`, over layouts computed by the REAL plugins: the
# provenance under test is then whatever the producer genuinely records, not a literal
# typed into a test. The pyramid descriptors are stubs because no tile is baked here — and
# `set-roles` must not read one, which is half of what these specs assert.

_N_ROWS = 8

# category / bucket are categorical, place is freeform, captured is the datetime column.
# TWO categorical entries, so the family is in its `multi` naming state
# (`_family_layout_names`: a SINGLE entry keeps the bare `categorical` layout_id, several
# get `categorical_<slug>`). The staleness specs want ids that stay put while ONE column
# moves, which two entries give them.
#
# That naming boundary is itself a behaviour, not just a fixture inconvenience: crossing
# it in either direction renames a live layout, and
# `test_set_roles_reports_a_*_family_rename_*` below pin both directions. This comment
# used to say the two entries were here so "demoting a column would [not] rename the
# SURVIVING layout as a side effect" — which described the case the 2026-09-09 review
# found unhandled (finding 1), so the specs steered around exactly the thing that was
# broken. They no longer do.
_BASE_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "captured", "label": "Captured", "format": "iso8601"},
    "categorical": [
        {"column": "category", "label": "Category"},
        {"column": "bucket", "label": "Bucket"},
    ],
    "freeform": [{"column": "place", "label": "Place"}],
}
_LAYOUT_IDS = ["grid", "datetime", "categorical_category", "categorical_bucket"]

# The SAME roles with one categorical entry, so the family sits on the other side of the
# `multi` boundary and its sole layout keeps the bare `categorical` id.
_ONE_CATEGORICAL_ROLES = {
    **_BASE_ROLES,
    "categorical": [{"column": "category", "label": "Category"}],
    "freeform": [{"column": "place", "label": "Place"}, {"column": "bucket", "label": "Bucket"}],
}
_ONE_CATEGORICAL_LAYOUT_IDS = ["grid", "datetime", "categorical"]

# Roles that declare a TAG column, whose filter is served from the baked
# `tags/tags_v{N}.arrow` sidecar rather than from the manifest.
_TAG_ROLES = {
    **_BASE_ROLES,
    "tag": [{"column": "keywords", "label": "Keywords", "delimiter": ","}],
}

# The PAIR families (2026-09-10 round-2 review finding A). One scatter entry, so its sole
# layout keeps the bare `scatter` id -- the state from which a second entry renames it, and
# from which a RE-PAIRING makes the same id unproducible while keeping its primary column.
# `sq`/`sz` are the spare axes the re-pairing points at.
_SCATTER_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "scatter": [{"x_column": "sx", "y_column": "sy", "label": "X vs Y"}],
}
_SCATTER_LAYOUT_IDS = ["grid", "scatter"]

# The geographic twin of the above. Separate columns because a geographic role is
# validated as DEGREES (lon within +/-180, lat within the mercator |lat| ceiling), so the
# scatter axes -- which a `normalize: "none"` scatter requires to be within [0,1] -- would
# be a misleading stand-in even though the numbers happen to be legal for both.
_GEO_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "geographic": [{"lon_column": "glon", "lat_column": "glat", "label": "Where"}],
}
_GEO_LAYOUT_IDS = ["grid", "geographic"]

# `_BASE_ROLES` plus one scatter pair, for the specs that need a REPARAMETERISED column:
# the same column in the same role, one knob moved. The datetime format used to be that
# knob. Since D-xxxii (#391, operator 2026-09-26) a stored timestamp's format is fixed at
# ingest, so these specs move the scatter pair's `normalize` instead. `sx`/`sy` lie in
# [0, 1], which `normalize: "none"` requires.
_BASE_SCATTER_ROLES = {**_BASE_ROLES, "scatter": _SCATTER_ROLES["scatter"]}
_BASE_SCATTER_LAYOUT_IDS = [*_LAYOUT_IDS, "scatter"]


def _renormalized(roles: dict) -> dict:
    """``roles`` with its one scatter pair's ``normalize`` moved from the default ``fit``
    to ``none``: a knob edit that stales exactly the ``scatter`` layout."""
    return {**roles, "scatter": [{**roles["scatter"][0], "normalize": "none"}]}


def _fake_pyramid(layout_id: str, version: int = 1) -> SimpleNamespace:
    return SimpleNamespace(
        path=f"tiles/{layout_id}/{layout_id}_v{version}.pmtiles",
        tile_px=512, thumb_px=64, cap=64,
        levels=[SimpleNamespace(z=0, tile_count=1)], z_cap=0,
        detail_path_prefix=None, detail_format=None, dropped_total=0,
    )


def _committed_dataset(
    tmp_path: Path,
    ds_id: str = "roles_ds",
    roles_config: dict | None = None,
    layout_ids: list[str] | None = None,
    with_tags: bool = False,
) -> tuple[Path, Path]:
    """A committed dataset tree at `manifest_version` 2.9 with real `source_columns`, real
    position tables and STUB tile containers. Defaults to `_BASE_ROLES`' four layouts;
    `roles_config`/`layout_ids` bake it on the other side of the family-naming boundary,
    and `with_tags` also projects the real `tags/tags_v1.arrow` sidecar and declares it in
    the manifest, which is what a tag role is actually SERVED from."""
    roles_config = roles_config if roles_config is not None else _BASE_ROLES
    layout_ids = layout_ids if layout_ids is not None else _LAYOUT_IDS
    output_root = tmp_path / "datasets"
    dataset_dir = output_root / ds_id
    dataset_dir.mkdir(parents=True)

    meta = pa.table(
        {
            "id": pa.array(range(_N_ROWS), pa.int64()),
            "filename": pa.array([f"img_{i:03d}.webp" for i in range(_N_ROWS)], pa.string()),
            "category": pa.array(["red" if i % 2 else "blue" for i in range(_N_ROWS)], pa.string()),
            "bucket": pa.array([f"b{i % 3}" for i in range(_N_ROWS)], pa.string()),
            "place": pa.array([f"place-{i}" for i in range(_N_ROWS)], pa.string()),
            "captured": pa.array(
                [_dt.datetime(2026, 1, 1 + i, 12, 0, 0) for i in range(_N_ROWS)],
                pa.timestamp("us"),
            ),
            # The two tag-shaped columns ingest would have split into list<string>. Both
            # are always in the parquet (an undeclared column is invisible to the role
            # fingerprints); only `keywords` is ever declared at bake time, so `topics` is
            # a column a LATER tag role can name that the committed sidecar cannot serve.
            "keywords": pa.array([[f"k{i % 2}", "all"] for i in range(_N_ROWS)], pa.list_(pa.string())),
            "topics": pa.array([[f"t{i % 3}"] for i in range(_N_ROWS)], pa.list_(pa.string())),
            # The PAIR-family axes. Four scatter columns within [0,1] (what a default
            # `normalize: "none"` scatter role requires of its columns) and four
            # geographic ones in degrees, so a committed pair can be RE-PAIRED against a
            # spare axis of the same kind. Undeclared columns are invisible to the role
            # fingerprints, so these change nothing for the specs above.
            "sx": pa.array([i / _N_ROWS for i in range(_N_ROWS)], pa.float64()),
            "sy": pa.array([1 - i / _N_ROWS for i in range(_N_ROWS)], pa.float64()),
            "sq": pa.array([(i % 4) / _N_ROWS for i in range(_N_ROWS)], pa.float64()),
            "sz": pa.array([(i % 3) / _N_ROWS for i in range(_N_ROWS)], pa.float64()),
            "glon": pa.array([-10.0 + i for i in range(_N_ROWS)], pa.float64()),
            "glat": pa.array([40.0 + i for i in range(_N_ROWS)], pa.float64()),
            "glon2": pa.array([10.0 - i for i in range(_N_ROWS)], pa.float64()),
            "glat2": pa.array([50.0 - i for i in range(_N_ROWS)], pa.float64()),
        }
    )
    metadata_path = dataset_dir / "metadata.parquet"
    pq.write_table(meta, metadata_path)

    roles = worker.ColumnRoles.from_config(roles_config)
    atlas = worker._PositionsAtlas(ids=list(range(_N_ROWS)))
    results = worker._compute_requested_layouts(layout_ids, roles, meta, atlas)
    positions = {
        layout_id: write_positions_table(
            results[layout_id].cells,
            _N_ROWS,
            dataset_dir / "positions" / f"{layout_id}_v1.arrow",
        )
        for layout_id in layout_ids
    }
    for layout_id in layout_ids:
        container = dataset_dir / "tiles" / layout_id / f"{layout_id}_v1.pmtiles"
        container.parent.mkdir(parents=True)
        container.write_bytes(b"pmtiles-stub")
    tags_path = (
        write_tags_sidecar(metadata_path, roles, dataset_dir / "tags" / "tags_v1.arrow")
        if with_tags
        else None
    )
    write_manifest(
        dataset_id=ds_id,
        dataset_version=1,
        layouts=[results[layout_id] for layout_id in layout_ids],
        pyramids={layout_id: _fake_pyramid(layout_id) for layout_id in layout_ids},
        roles=roles,
        image_count=_N_ROWS,
        source=None,
        output_path=dataset_dir / "layout_manifest.json",
        ingest_timestamp="2026-09-09T00:00:00Z",
        positions=positions,
        tags_path=tags_path,
    )
    return output_root, dataset_dir


def _set_roles(output_root: Path, config: dict, ds_id: str = "roles_ds") -> dict:
    return run_set_roles(
        SetRolesJobPayload(
            dataset_id=ds_id, owner="tester", column_roles=config, output_root=output_root
        )
    )


def test_the_committed_fixture_records_the_provenance_these_specs_read(
    tmp_path: Path,
) -> None:
    """The premise, stated rather than assumed: the tree really is 2.9 and every entry
    carries `source_columns` — grid's being the EMPTY list, which is the value that makes
    the staleness predicate false for grid by construction rather than by exception."""
    _output_root, dataset_dir = _committed_dataset(tmp_path)
    manifest = _manifest(dataset_dir)
    assert manifest["manifest_version"] == MANIFEST_VERSION
    assert {e["layout_id"]: e["source_columns"] for e in manifest["layouts"]} == {
        "grid": [],
        "datetime": ["captured"],
        "categorical_category": ["category"],
        "categorical_bucket": ["bucket"],
    }


def test_set_roles_stales_only_the_layouts_built_from_the_changed_columns(
    tmp_path: Path,
) -> None:
    """Spec 3. `category` loses the categorical role and `place` gains it. The stale set
    is exactly the layout built from `category` — not grid (which records `[]`), not
    `datetime`, and not the sibling `categorical_bucket` whose column did not move — and
    nothing under `tiles/` is read or written."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    presentation = dataset_dir / "presentation.json"
    presentation.write_text(_PRESENTATION, encoding="utf-8")
    tiles_before = {
        path: path.read_bytes()
        for path in sorted((dataset_dir / "tiles").rglob("*"))
        if path.is_file()
    }
    positions_before = _tree(dataset_dir / "positions")
    version_before = _manifest(dataset_dir)["dataset_version"]

    result = _set_roles(
        output_root,
        {
            **_BASE_ROLES,
            "categorical": [
                {"column": "bucket", "label": "Bucket"},
                {"column": "place", "label": "Place"},
            ],
            "freeform": [{"column": "category", "label": "Category"}],
        },
    )

    assert result["changed_columns"] == ["category", "place"]
    assert result["stale_layouts"] == ["categorical_category"]
    assert "grid" not in result["stale_layouts"]
    assert "datetime" not in result["stale_layouts"]
    assert "categorical_bucket" not in result["stale_layouts"]
    # Every entry is 2.9, so nothing is unjudgeable.
    assert result["unknown_layouts"] == []

    # No bake: not one byte under tiles/ or positions/ moved, and the version did not.
    assert {
        path: path.read_bytes()
        for path in sorted((dataset_dir / "tiles").rglob("*"))
        if path.is_file()
    } == tiles_before
    assert _tree(dataset_dir / "positions") == positions_before
    assert _manifest(dataset_dir)["dataset_version"] == version_before
    assert result["dataset_version"] == str(version_before)
    assert presentation.read_text(encoding="utf-8") == _PRESENTATION

    # The roles really were written — the assertions above are not vacuously true.
    written = _manifest(dataset_dir)["column_roles"]
    assert [e["column"] for e in written["categorical"]] == ["bucket", "place"]
    assert [e["column"] for e in written["freeform"]] == ["category"]


def test_set_roles_reports_a_layout_the_new_roles_can_no_longer_produce(
    tmp_path: Path,
) -> None:
    """The same edit orphans `categorical_category`: its column is no longer categorical,
    so nothing can re-bake that layout. REPORTED, not refused — the state is already
    reachable through `add-layouts --column-roles`, and blocking a legitimate role edit
    behind a layout the user may be about to delete inverts the order the designer works
    in. The layout keeps serving its committed tiles meanwhile."""
    output_root, dataset_dir = _committed_dataset(tmp_path)

    result = _set_roles(
        output_root,
        {
            **_BASE_ROLES,
            "categorical": [
                {"column": "bucket", "label": "Bucket"},
                {"column": "place", "label": "Place"},
            ],
            "freeform": [{"column": "category", "label": "Category"}],
        },
    )

    assert result["orphaned_layouts"] == ["categorical_category"]
    assert [e["layout_id"] for e in _manifest(dataset_dir)["layouts"]] == _LAYOUT_IDS
    assert (dataset_dir / "tiles" / "categorical_category").is_dir()
    assert "can no longer be produced" in (dataset_dir / "ingest.log").read_text(
        encoding="utf-8"
    )


def test_set_roles_a_reparameterised_column_stales_without_orphaning(
    tmp_path: Path,
) -> None:
    """LAYOUT_DESIGNER §5's named case: *"changing a baked scatter layout's axis scale flags
    exactly that layout stale ... and leaves its tiles byte-identical until a re-bake
    commits"*. (It named a datetime format change until D-xxxii fixed the format at
    ingest.) The columns keep their role, so the layout is still producible — it is the
    KNOB that moved, and a layout baked before it moved no longer matches its own
    declaration. `manifest_version` IS re-stamped here (unlike `delete-layout`) because
    `column_roles` was re-serialised by the current emitter."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_BASE_SCATTER_ROLES, layout_ids=_BASE_SCATTER_LAYOUT_IDS
    )

    result = _set_roles(output_root, _renormalized(_BASE_SCATTER_ROLES))

    assert result["changed_columns"] == ["sx", "sy"]
    assert result["stale_layouts"] == ["scatter"]
    assert result["orphaned_layouts"] == []
    manifest = _manifest(dataset_dir)
    assert manifest["column_roles"]["scatter"][0]["normalize"] == "none"
    assert manifest["manifest_version"] == MANIFEST_VERSION
    assert manifest["dataset_version"] == 1


def test_set_roles_a_label_only_edit_changes_nothing_and_stales_nothing(
    tmp_path: Path,
) -> None:
    """D-xx: a label is a free tier-1 edit. If labels were in the fingerprint, renaming a
    column's display name would flag every layout built on it for a re-bake — which is
    precisely the cost confusion the commit bar exists to remove."""
    output_root, dataset_dir = _committed_dataset(tmp_path)

    result = _set_roles(
        output_root,
        {
            "filename": {"column": "filename", "label": "The file"},
            "datetime": {"column": "captured", "label": "When", "format": "iso8601"},
            "categorical": [
                {"column": "category", "label": "Kind"},
                {"column": "bucket", "label": "Bin"},
            ],
            "freeform": [{"column": "place", "label": "Where"}],
        },
    )

    assert result["changed_columns"] == []
    assert result["stale_layouts"] == []
    # ...and the new labels DID land, so the empty stale set is a judgement, not a no-op.
    assert _manifest(dataset_dir)["column_roles"]["datetime"]["label"] == "When"


def test_set_roles_treats_an_absent_source_columns_as_unknown_never_as_empty(
    tmp_path: Path,
) -> None:
    """`source_columns` is optional in the schema for ONE reason —
    `append_manifest_layouts` carries pre-2.9 entries forward byte-preserved — so an
    absent key means "recorded nothing", never "depends on nothing". Reading it as `[]`
    would silently clear the stale flag on exactly the oldest layouts in a tree.

    `golden_dataset_full_v2` is the real case rather than a synthesised one: measured
    2026-09-09 it stamps `manifest_version` 2.8 and NOT ONE of its six entries carries
    `source_columns`. A change that unquestionably invalidates its geographic layout — the
    projection it was baked with — must therefore come back as UNKNOWN for all six and
    STALE for none. (This spec moved `captured`'s format until D-xxxii fixed it at ingest.
    Golden's `lat` spans ±78°, inside the mercator ceiling, so the projection edit is valid.)

    AND THE STAMP MUST NOT MOVE (2026-09-09 review finding 4). This verb writes
    `column_roles` through the current emitter, which is current-minor content — but the
    stamp describes the FILE, and the six layout entries are carried forward exactly as
    they were. Re-stamping 2.8 -> 2.9 would claim `source_columns` on entries that do not
    carry it, and the CLI would then print "baked before manifest 2.9, so they record no
    source_columns" about a manifest it had just stamped 2.9. Not writing `url` is valid
    under 2.8 and 2.9 alike, so the committed stamp stays truthful — the same rule
    `delete-layout` already states."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    committed = _manifest(dataset_dir)
    assert all("source_columns" not in e for e in committed["layouts"]), (
        "fixture premise: this tree predates 2.9 and records no provenance"
    )
    assert committed["manifest_version"] == "2.8", "fixture premise: a pre-2.9 stamp"
    roles = dict(committed["column_roles"])
    assert "projection" not in roles["geographic"][0], "fixture premise: the default knob"
    roles["geographic"] = [{**roles["geographic"][0], "projection": "mercator"}]

    result = _set_roles(output_root, roles, ds_id="golden_dataset_full_v2")

    assert result["changed_columns"] == ["lat", "lon"]
    assert result["stale_layouts"] == []
    assert result["unknown_layouts"] == [e["layout_id"] for e in committed["layouts"]]
    assert _manifest(dataset_dir)["manifest_version"] == "2.8"
    assert result["manifest_version"] == "2.8"
    # ...and the roles really were rewritten, so the unmoved stamp is a judgement about
    # the layout entries rather than a no-op run.
    assert _manifest(dataset_dir)["column_roles"]["geographic"][0]["projection"] == "mercator"


def test_set_roles_rejects_a_role_naming_a_column_the_parquet_does_not_have(
    tmp_path: Path,
) -> None:
    """D-11: the pipeline is the validator of record, not the client. This is
    `add-layouts --column-roles`' own value-level check, reused rather than re-written —
    so a roles-only edit cannot introduce a role a bake would have refused."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ColumnRoleError):
        _set_roles(
            output_root,
            {**_BASE_ROLES, "freeform": [{"column": "not_a_column", "label": "Nope"}]},
        )

    assert (dataset_dir / "layout_manifest.json").read_bytes() == before


def test_set_roles_on_an_images_only_dataset_refuses_by_naming_the_missing_column(
    tmp_path: Path,
) -> None:
    """MEASURED 2026-09-09, correcting the obvious assumption: an images-only ingest
    (D-25) still writes a `metadata.parquet` — `golden_dataset_images_only_v2` has one,
    holding id + filename, and its manifest simply omits `column_roles`. So the
    "no parquet" precondition is NOT the images-only case, and `set-roles` must not
    pretend it is. Such a tree goes through the ordinary validator instead and is refused
    per role, naming the columns it does have, which is the message that helps."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_images_only_v2", tmp_path)
    assert (dataset_dir / "metadata.parquet").is_file()
    assert "column_roles" not in _manifest(dataset_dir)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ColumnRoleError, match="captured"):
        _set_roles(output_root, _BASE_ROLES, ds_id="golden_dataset_images_only_v2")

    assert (dataset_dir / "layout_manifest.json").read_bytes() == before


# --- set-roles: the datetime format is fixed at ingest (D-xxxii) ---------------------
#
# Ingest stores a datetime column as a timestamp only when it parsed it as `iso8601`, and
# no bake re-parses it. Since #391 the datetime plugin applies a format to integer values
# only, so no format moves a stored timestamp. After ingest a stored timestamp still takes
# `iso8601` or its committed format, nothing else: policy (operator, 2026-09-26; D-xxxiii,
# after upload a date has no format). This is an interim guard: the design is for ingest
# to store every date the same way and for the format to leave post-ingest editing.
# These run on a copy of `golden_dataset_full_v2`: committed format `iso8601`, `captured`
# stored as `timestamp[us]` (measured 2026-09-25, and asserted below rather than assumed).

_GOLDEN = "golden_dataset_full_v2"


def _every_datetime_format() -> list[str]:
    """The schema's datetime `format` enum, read through the loader the plugins validate
    roles with, so one place knows where the schema lives. A call, not a module constant:
    a schema that cannot be read then fails the tests that use it, not the whole module."""
    from pipeline.layout_plugins.base import _column_roles_schema

    return _column_roles_schema()["$defs"]["datetimeRoleEntry"]["properties"]["format"]["enum"]


def _golden_roles(dataset_dir: Path, fmt: str | None = None) -> dict:
    """The committed roles map re-sent verbatim, or with only the datetime format moved."""
    roles = json.loads(json.dumps(_manifest(dataset_dir)["column_roles"]))
    if fmt is not None:
        roles["datetime"]["format"] = fmt
    return roles


def _commit_before_the_check(
    output_root: Path, dataset_dir: Path, fmt: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Commit `fmt` through the real `set-roles` as it shipped before D-xxxii's check,
    which accepted every format on a timestamp. That is how a collection came to hold a
    committed `unix_seconds` or `unix_millis` over a timestamp. Nothing reaches that state
    now, so it is reproduced with the worker's own writer, never by editing the manifest."""
    with monkeypatch.context() as patched:
        patched.setattr(worker, "_TIMESTAMP_DATETIME_FORMATS", frozenset(_every_datetime_format()))
        _set_roles(output_root, _golden_roles(dataset_dir, fmt), ds_id=_GOLDEN)
    assert _manifest(dataset_dir)["column_roles"]["datetime"]["format"] == fmt


def test_no_format_moves_a_stored_timestamp_though_only_iso8601_is_accepted() -> None:
    """Every datetime format lays golden's stored `captured` out exactly as `iso8601` does,
    under the REAL plugin: a timestamp is already an instant, and since #391 the plugin
    applies a format to integer values only. Before that, `unix_millis` divided every date
    by 1000 and this recorded `unix_millis -> ['cells', 'bbox', 'annotations']`. So a
    collection holding a committed non-ISO format re-bakes at its true dates, and
    `worker._TIMESTAMP_DATETIME_FORMATS` being exactly `{iso8601}` is policy (operator,
    2026-09-26; D-xxxiii), not protection of positions. If the plugin ever changes what a
    format does to a timestamp, this fails, and the rule's recorded reasons must be
    re-checked.

    "What a format does" means everything the bake hands the manifest and the viewer: the
    whole cell table (x, y, w, h and the reserved columns), the bbox, the axis
    `annotations` (its date `domain` is where a wrong format shows), `options` and
    `missing_count`. Only `source_fingerprint` is left out, because it records the
    declared format and so differs between formats by design. The failure message names
    which of those each format moved.

    The last assert restates the constant, and is a deliberate change detector. The
    behavioural pins already fail if the set widens:
    `test_set_roles_refuses_unix_seconds_on_a_stored_timestamp_though_it_moves_no_date`,
    and the add-layouts override refusals. This one fails beside the measurement that is
    the rule's reason, and prints it, so a policy change fails this measurement test by
    design and whoever makes it reads what each format does."""
    from pipeline.layout_plugins.datetime_layout import DateTimeLayout

    meta = pq.read_table(FIXTURES / _GOLDEN / "metadata.parquet")
    assert pa.types.is_timestamp(meta.schema.field("captured").type), "fixture premise"
    atlas = worker._PositionsAtlas(ids=[int(v) for v in meta.column("id").to_pylist()])

    def baked(fmt: str) -> dict[str, object]:
        roles = worker.ColumnRoles.from_config(_golden_roles(FIXTURES / _GOLDEN, fmt))
        result = DateTimeLayout().compute(meta, roles, atlas, {})
        return {
            "cells": result.cells.to_pydict(),
            "bbox": result.bbox,
            "annotations": result.annotations,
            "options": result.options,
            "missing_count": result.missing_count,
        }

    as_ingested = baked("iso8601")
    assert as_ingested["annotations"]["axes"][0]["domain"][0].startswith("2021-"), "premise"
    moved = {
        fmt: [part for part, value in baked(fmt).items() if value != as_ingested[part]]
        for fmt in _every_datetime_format()
    }
    assert moved == {"iso8601": [], "unix_seconds": [], "unix_millis": []}, moved
    assert worker._TIMESTAMP_DATETIME_FORMATS == {"iso8601"}, moved


def test_set_roles_accepts_the_committed_datetime_format_re_sent_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Whatever datetime format is committed, re-sending the committed roles is accepted.
    The designer's commits send the full roles map, committed format included, so a
    refusal here would refuse every roles commit on that collection. Three committed
    states: golden's own `iso8601`, and `unix_seconds` and `unix_millis`, which only
    `set-roles` before this check could write."""
    output_root, dataset_dir = _copy_fixture(_GOLDEN, tmp_path)
    assert _manifest(dataset_dir)["column_roles"]["datetime"]["format"] == "iso8601"
    assert _set_roles(output_root, _golden_roles(dataset_dir), ds_id=_GOLDEN)["changed_columns"] == []

    for committed in ("unix_seconds", "unix_millis"):
        _commit_before_the_check(output_root, dataset_dir, committed, monkeypatch)
        assert _set_roles(output_root, _golden_roles(dataset_dir), ds_id=_GOLDEN)["changed_columns"] == []
        assert _manifest(dataset_dir)["column_roles"]["datetime"]["format"] == committed


def test_set_roles_refuses_unix_seconds_on_a_stored_timestamp_though_it_moves_no_date(
    tmp_path: Path,
) -> None:
    """Operator, 2026-09-26: after ingest a stored timestamp takes `iso8601` only. The
    real plugin lays golden's `captured` out identically under `unix_seconds` (pinned by
    `test_no_format_moves_a_stored_timestamp_though_only_iso8601_is_accepted`), but a
    `unix_*` format tells every consumer the values are numbers while the API serves ISO
    strings, and after upload a date has no format (D-xxxiii). Refused, naming the column,
    with nothing written."""
    output_root, dataset_dir = _copy_fixture(_GOLDEN, tmp_path)
    assert _manifest(dataset_dir)["column_roles"]["datetime"]["format"] == "iso8601"
    before_tree = _tree(dataset_dir)
    before_manifest = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ColumnRoleError, match=r"^captured: datetime format is fixed at ingest") as info:
        _set_roles(output_root, _golden_roles(dataset_dir, "unix_seconds"), ds_id=_GOLDEN)

    assert info.value.column == "captured"
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before_manifest
    assert _tree(dataset_dir) == before_tree


def test_set_roles_refuses_unix_millis_on_a_stored_timestamp_unless_committed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`unix_millis` on golden's stored timestamp is refused, naming the column and saying
    the format is fixed at ingest, and nothing is written: no manifest, no log line, no
    file. Until #391 fixed the plugin it would also have divided every date by 1000 at the
    next bake; now the refusal is policy (D-xxxiii). Refused from a committed
    `unix_seconds` too, so the committed exemption covers the committed value only."""
    output_root, dataset_dir = _copy_fixture(_GOLDEN, tmp_path)
    for committed in ("iso8601", "unix_seconds"):
        if committed != "iso8601":
            _commit_before_the_check(output_root, dataset_dir, committed, monkeypatch)
        before_manifest = (dataset_dir / "layout_manifest.json").read_bytes()
        before_tree = _tree(dataset_dir)

        with pytest.raises(ColumnRoleError, match=r"^captured: datetime format is fixed at ingest") as info:
            _set_roles(output_root, _golden_roles(dataset_dir, "unix_millis"), ds_id=_GOLDEN)

        assert info.value.column == "captured"
        assert (dataset_dir / "layout_manifest.json").read_bytes() == before_manifest
        assert _tree(dataset_dir) == before_tree


def test_set_roles_accepts_a_datetime_format_put_back_to_iso8601(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`iso8601` is the format a stored timestamp was parsed with, so moving back to it is
    always accepted, from either non-ISO committed state. That is the put-back the
    designer's Data view offers for a format committed before D-xxxii's check."""
    for committed in ("unix_seconds", "unix_millis"):
        output_root, dataset_dir = _copy_fixture(_GOLDEN, tmp_path / committed)
        _commit_before_the_check(output_root, dataset_dir, committed, monkeypatch)

        result = _set_roles(output_root, _golden_roles(dataset_dir, "iso8601"), ds_id=_GOLDEN)

        assert result["changed_columns"] == ["captured"]
        assert _manifest(dataset_dir)["column_roles"]["datetime"]["format"] == "iso8601"


def test_set_roles_refuses_when_the_manifest_moved_under_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """COMPARE-AND-SET, the same as `delete-layout`: the stale set describes a diff
    against bytes that must still be the committed ones at the moment of the write."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    manifest_path = dataset_dir / "layout_manifest.json"

    import contextlib

    @contextlib.contextmanager
    def _racing_lock(dataset_id: str):  # type: ignore[no-untyped-def]
        manifest_path.write_text(
            manifest_path.read_text(encoding="utf-8") + "\n", encoding="utf-8"
        )
        yield

    monkeypatch.setattr(worker, "_commit_lock", _racing_lock)
    before_race = manifest_path.read_bytes()

    with pytest.raises(LayoutLifecycleError, match="changed while this job was validating"):
        _set_roles(
            output_root,
            {**_BASE_ROLES, "datetime": {**_BASE_ROLES["datetime"], "label": "When"}},
        )

    assert manifest_path.read_bytes() == before_race + b"\n"


# --- set-roles: the 1<->2 family-naming boundary (2026-09-09 review finding 1) --------
#
# `_family_layout_names` names a multi-entry family's SOLE layout with the bare plugin
# name and switches to `{name}_{slug}` the moment a second entry appears (`multi =
# len(entries) > 1`) -- and back again when one is removed. Crossing that boundary in
# either direction therefore renames a live, untouched layout, which makes its committed
# id absent from `_enumerate_layout_ids`. Reporting that as "the column it was baked from
# lost its role -- remove it with `pixscope delete-layout`" misattributes the cause AND
# recommends destroying hours of work. Both directions are pinned here.


def test_set_roles_reports_a_one_to_two_family_rename_not_an_orphan(tmp_path: Path) -> None:
    """1 -> 2. A dataset with ONE categorical role (`category`) has a layout whose id is
    the bare `categorical`. Adding a SECOND categorical column renames it to
    `categorical_category` -- `category` did not lose anything, and the advice must say
    "re-bake under the new id, then delete the old one", never "delete this layout"."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path,
        roles_config=_ONE_CATEGORICAL_ROLES,
        layout_ids=_ONE_CATEGORICAL_LAYOUT_IDS,
    )
    assert [e["layout_id"] for e in _manifest(dataset_dir)["layouts"]] == [
        "grid", "datetime", "categorical",
    ], "fixture premise: a single categorical entry keeps the BARE layout_id"

    result = _set_roles(
        output_root,
        {
            **_ONE_CATEGORICAL_ROLES,
            "categorical": [
                {"column": "category", "label": "Category"},
                {"column": "bucket", "label": "Bucket"},
            ],
            "freeform": [{"column": "place", "label": "Place"}],
        },
    )

    assert result["renamed_layouts"] == {"categorical": "categorical_category"}
    assert result["orphaned_layouts"] == []
    # Only `bucket` moved, and `categorical`'s provenance is `["category"]`, so the layout
    # is not stale either -- which is exactly why calling it an orphan was so misleading.
    assert result["changed_columns"] == ["bucket"]
    assert result["stale_layouts"] == []
    # Reported, never enacted: the committed entry and its bytes are untouched.
    assert [e["layout_id"] for e in _manifest(dataset_dir)["layouts"]] == [
        "grid", "datetime", "categorical",
    ]
    assert (dataset_dir / "tiles" / "categorical" / "categorical_v1.pmtiles").is_file()
    log = (dataset_dir / "ingest.log").read_text(encoding="utf-8")
    # One line PER PAIR now (round-2 finding B1): the re-bake command names the real new
    # id instead of a `<new id>` placeholder, which it can only do one rename at a time.
    assert "layout categorical keeps its column(s) but would now be baked as categorical_category" in log
    assert "lost their role" not in log


def test_set_roles_reports_a_two_to_one_family_rename_beside_a_real_orphan(
    tmp_path: Path,
) -> None:
    """2 -> 1, which produces ONE of each in a single run. Demoting `bucket` from
    categorical leaves `category` as the family's only entry, so its layout renames
    `categorical_category` -> `categorical` (a rename: the role is untouched), while
    `categorical_bucket` genuinely loses the role it was baked from (an orphan). The two
    must not be reported the same way, because deleting the first destroys a live layout
    for no reason."""
    output_root, dataset_dir = _committed_dataset(tmp_path)

    result = _set_roles(
        output_root,
        {
            **_BASE_ROLES,
            "categorical": [{"column": "category", "label": "Category"}],
            "freeform": [
                {"column": "place", "label": "Place"},
                {"column": "bucket", "label": "Bucket"},
            ],
        },
    )

    assert result["renamed_layouts"] == {"categorical_category": "categorical"}
    assert result["orphaned_layouts"] == ["categorical_bucket"]
    assert result["changed_columns"] == ["bucket"]
    assert result["stale_layouts"] == ["categorical_bucket"]
    log = (dataset_dir / "ingest.log").read_text(encoding="utf-8")
    assert "layout categorical_category keeps its column(s) but would now be baked as categorical" in log
    assert "no declared role reproduces those layout_ids" in log


# The two rename specs above are CATEGORICAL, and categorical is the one family the
# round-2 review's finding A cannot touch: a categorical entry has exactly one column, so
# its primary column IS its whole `source_columns` tuple and looking up either gives the
# same answer. That is why they kept passing while a re-paired scatter was reported as a
# rename -- and why they still pass now that the lookup is keyed on the whole tuple. The
# pair families are pinned below.


# --- set-roles: a re-paired pair family is NOT a rename (round-2 review finding A) -----
#
# `_family_ids_by_source_columns` used to be keyed on the entry's PRIMARY column
# (`source_columns[0]`), with a separate check that every committed column was still
# declared SOMEWHERE under the same role kind. A pair family that keeps its primary column
# and re-pairs it passes both tests, so `scatter` over ('sx','sy') came back as a rename to
# `scatter_sx` -- a layout that bakes `sx` against `sz`. The printed remedy ("re-bake it
# under the new id, then delete the old one") would then swap different data under the
# operator's name for their layout. Both pair families are pinned, in both directions.


def test_set_roles_will_not_call_a_re_paired_scatter_a_rename(tmp_path: Path) -> None:
    """The review's probe, run end to end: committed `scatter` with
    `source_columns == ['sx','sy']`, new roles declaring `(sx, sz)` and `(sq, sy)`. The
    committed id really is unproducible -- the new ids are `scatter_sx` and `scatter_sq` --
    but NEITHER of them bakes this layout's pair, so it is an ORPHAN whose inputs changed
    (which the STALE flag says in the same run), never a rename."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_SCATTER_ROLES, layout_ids=_SCATTER_LAYOUT_IDS
    )
    assert {e["layout_id"]: e["source_columns"] for e in _manifest(dataset_dir)["layouts"]} == {
        "grid": [],
        "scatter": ["sx", "sy"],
    }, "fixture premise: one scatter entry keeps the BARE id and provenances the PAIR"

    result = _set_roles(
        output_root,
        {
            **_SCATTER_ROLES,
            "scatter": [
                {"x_column": "sx", "y_column": "sz", "label": "X vs Z"},
                {"x_column": "sq", "y_column": "sy", "label": "Q vs Y"},
            ],
        },
    )

    assert result["renamed_layouts"] == {}
    assert result["orphaned_layouts"] == ["scatter"]
    # The honest description of what happened, and it is already in the output: every axis
    # of the old and the new pairs is reported changed, so the layout is stale.
    assert result["changed_columns"] == ["sq", "sx", "sy", "sz"]
    assert result["stale_layouts"] == ["scatter"]
    log = (dataset_dir / "ingest.log").read_text(encoding="utf-8")
    assert "would now be baked as" not in log
    assert "no declared role reproduces those layout_ids" in log


def test_set_roles_will_not_call_a_re_paired_geographic_pair_a_rename(
    tmp_path: Path,
) -> None:
    """The geographic twin, whose primary axis is `lon_column`. Committed `geographic` over
    ('glon','glat'); the new roles keep `glon` as a primary and `glat` as a secondary, but
    in two DIFFERENT pairs."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_GEO_ROLES, layout_ids=_GEO_LAYOUT_IDS
    )
    assert {e["layout_id"]: e["source_columns"] for e in _manifest(dataset_dir)["layouts"]} == {
        "grid": [],
        "geographic": ["glon", "glat"],
    }

    result = _set_roles(
        output_root,
        {
            **_GEO_ROLES,
            "geographic": [
                {"lon_column": "glon", "lat_column": "glat2", "label": "One"},
                {"lon_column": "glon2", "lat_column": "glat", "label": "Two"},
            ],
        },
    )

    assert result["renamed_layouts"] == {}
    assert result["orphaned_layouts"] == ["geographic"]
    assert result["stale_layouts"] == ["geographic"]


def test_set_roles_still_reports_a_pair_family_rename_when_the_pair_survives(
    tmp_path: Path,
) -> None:
    """The other direction, so the fix above is a narrowing and not a deletion. Adding a
    SECOND scatter entry while leaving the committed `(sx, sy)` pair exactly as it is
    crosses the same 1 -> 2 naming boundary the categorical specs pin: the layout is
    renamed `scatter` -> `scatter_sx`, it is NOT stale (neither of its columns moved), and
    re-baking under the new id genuinely reproduces it."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_SCATTER_ROLES, layout_ids=_SCATTER_LAYOUT_IDS
    )

    result = _set_roles(
        output_root,
        {
            **_SCATTER_ROLES,
            "scatter": [
                {"x_column": "sx", "y_column": "sy", "label": "X vs Y"},
                {"x_column": "sq", "y_column": "sz", "label": "Q vs Z"},
            ],
        },
    )

    assert result["renamed_layouts"] == {"scatter": "scatter_sx"}
    assert result["orphaned_layouts"] == []
    assert result["changed_columns"] == ["sq", "sz"]
    assert result["stale_layouts"] == []
    assert "would now be baked as" in (dataset_dir / "ingest.log").read_text(encoding="utf-8")


# --- set-roles: the tag sidecar, the fourth bucket (review finding 3) ------------------
#
# HOW REACHABLE EACH HALF IS, because the three specs below look symmetric and are not
# (2026-09-10 round-2 review). `unserved_tag_roles` -- a DECLARED tag role the committed
# sidecar cannot serve -- is nearly unreachable in practice:
# `_validate_roles_against_parquet` already refuses a tag role over a non-`list` column,
# and ingest only writes `list<string>` for columns that WERE tag roles at bake time, so
# getting there takes declare -> remove -> bake -> re-declare. This fixture reaches it by
# building the parquet directly with a second list column (`topics`) that was never a
# declared role. The bucket is still right to exist -- a hand-edited or foreign-produced
# tree can hold that state, and it fails silently in the viewer -- but do not read these
# three tests as covering the common case. The OTHER direction (`stale_tag_sidecar`:
# dropping the last tag role) is one ordinary edit away, which is why it is the one that
# now gets fixed rather than only reported.


def test_set_roles_names_a_tag_role_the_committed_sidecar_cannot_serve(
    tmp_path: Path,
) -> None:
    """A tag role is DECLARED in `column_roles` but SERVED from `tags/tags_v{N}.arrow`,
    which only a bake writes. Declaring one over a column the committed sidecar does not
    carry produces a filter with nothing behind it -- the frontend decodes the sidecar,
    finds no such column, and shows an empty filter with no error anywhere. It is not a
    layout, so stale/unknown/orphaned are all silent about it; this is the fourth
    bucket."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_TAG_ROLES, with_tags=True
    )
    sidecar = dataset_dir / "tags" / "tags_v1.arrow"
    assert _manifest(dataset_dir)["tags"]["path"] == "tags/tags_v1.arrow"
    assert set(pa.ipc.open_file(str(sidecar)).schema.names) == {"id", "keywords"}, (
        "fixture premise: the committed sidecar carries only the tag column baked with it"
    )
    before = sidecar.read_bytes()

    result = _set_roles(
        output_root,
        {
            **_TAG_ROLES,
            "tag": [
                {"column": "keywords", "label": "Keywords", "delimiter": ","},
                {"column": "topics", "label": "Topics", "delimiter": ","},
            ],
        },
    )

    assert result["unserved_tag_roles"] == ["topics"]
    assert result["stale_tag_sidecar"] is None
    # The layout buckets say nothing about it, which is the point of naming it separately.
    assert result["orphaned_layouts"] == []
    assert result["stale_layouts"] == []
    # REPORTED, never re-staged: this verb bakes nothing and the sidecar is a baked asset.
    assert sidecar.read_bytes() == before
    assert "will come back EMPTY" in (dataset_dir / "ingest.log").read_text(encoding="utf-8")


def test_set_roles_clears_the_tags_block_and_names_the_sidecar_it_leaves(
    tmp_path: Path,
) -> None:
    """The reverse case, and the 2026-09-10 round-2 review's finding B2. Removing the last
    tag role leaves `manifest.tags` pointing at a live sidecar, contradicting the schema's
    own words for that block -- *"Null or absent when the dataset has no tag-role
    columns"* -- and the UI keeps offering filters for a role that no longer exists.

    This used to be REPORTED with "the `tags` block is repointed only by a bake", and no
    bake repoints it: `_stage_tags_sidecar` returns None the moment the effective roles
    carry no tag role, so `append_manifest_layouts` carries the committed `tags` dict
    through every `add-layouts` run. The state had no remedy short of a re-ingest. So
    `set-roles` now clears the block itself, in the manifest it is already rewriting.

    The sidecar FILE is deliberately left where it is -- this verb bakes nothing and
    sweeps nothing -- and the returned path names the file that is now referenced by
    nothing."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_TAG_ROLES, with_tags=True
    )
    sidecar = dataset_dir / "tags" / "tags_v1.arrow"
    assert _manifest(dataset_dir)["tags"]["path"] == "tags/tags_v1.arrow", (
        "fixture premise: the committed manifest declares the baked sidecar"
    )
    before = sidecar.read_bytes()

    result = _set_roles(output_root, _BASE_ROLES)  # no `tag` key at all

    assert result["stale_tag_sidecar"] == "tags/tags_v1.arrow"
    assert result["unserved_tag_roles"] == []
    # The block is GONE, not repointed and not nulled by hand: absent is what
    # `write_manifest` emits for a dataset with no tag roles.
    assert "tags" not in _manifest(dataset_dir)
    assert sidecar.read_bytes() == before
    assert "was REMOVED" in (dataset_dir / "ingest.log").read_text(encoding="utf-8")


def test_set_roles_is_silent_about_the_tags_block_it_already_cleared(
    tmp_path: Path,
) -> None:
    """The state is REPAIRED, not merely announced: a second identical run has nothing to
    say about tags. This is what separates the fix from the message it replaced -- under
    the old behaviour every subsequent `set-roles` (and every `add-layouts`) re-reported
    the same leftover block forever, because nothing could clear it."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_TAG_ROLES, with_tags=True
    )

    first = _set_roles(output_root, _BASE_ROLES)
    second = _set_roles(output_root, _BASE_ROLES)

    assert first["stale_tag_sidecar"] == "tags/tags_v1.arrow"
    assert second["stale_tag_sidecar"] is None
    assert "tags" not in _manifest(dataset_dir)
    # And the file is still there to be re-declared by a later bake, not swept.
    assert (dataset_dir / "tags" / "tags_v1.arrow").is_file()


def test_set_roles_is_silent_about_a_sidecar_that_serves_every_declared_tag_role(
    tmp_path: Path,
) -> None:
    """The negative case, so the two above are judgements rather than an alarm that is
    always on: an unrelated edit on a tree whose sidecar carries every declared tag column
    reports nothing about tags."""
    roles = {**_TAG_ROLES, "scatter": _BASE_SCATTER_ROLES["scatter"]}
    output_root, _dataset_dir = _committed_dataset(
        tmp_path, roles_config=roles, layout_ids=_BASE_SCATTER_LAYOUT_IDS, with_tags=True
    )

    result = _set_roles(output_root, _renormalized(roles))

    assert result["unserved_tag_roles"] == []
    assert result["stale_tag_sidecar"] is None
    assert result["stale_layouts"] == ["scatter"]


# --- set-roles: validation + degradation ---------------------------------------------


def test_set_roles_rejects_a_filename_role_naming_a_column_the_parquet_does_not_have(
    tmp_path: Path,
) -> None:
    """The JOIN KEY was the one role never checked against the parquet (2026-09-09 review
    finding 7). `ingest_metadata` rebinds the filename role to the canonical `filename`
    column it actually wrote, so every committed manifest names a column the parquet has
    -- and `set-roles`, whose entire subject is the role map, is the first verb that can
    commit anything else. Unchecked, a typo (or the pre-rename CSV header) committed a
    join-key role naming a column that does not exist, and then showed up in
    `changed_columns` as a column name nothing in the dataset has."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ColumnRoleError, match="file_name"):
        _set_roles(
            output_root,
            {**_BASE_ROLES, "filename": {"column": "file_name", "label": "Filename"}},
        )

    assert (dataset_dir / "layout_manifest.json").read_bytes() == before


def test_set_roles_still_writes_when_the_committed_roles_no_longer_parse(
    tmp_path: Path,
) -> None:
    """The committed map is parsed for ONE purpose -- the advisory diff -- so it must not
    be able to refuse the run (2026-09-09 review finding 6). `column_roles.schema.json` is
    `additionalProperties: false`, so a committed map the current schema no longer accepts
    would otherwise make the one verb that can REPAIR that map raise a
    `jsonschema.ValidationError` about the old roles, before writing anything, as a
    traceback (the CLI catches only `LayoutLifecycleError`). Latent today because `url` --
    the only retirement so far -- is special-cased by `drop_retired_roles`; it arms itself
    at the next one, and immediately for any hand-edited or foreign-produced manifest.

    Degrading to "no before state" is the safe direction: every column of the new map
    reads as changed and every judgeable layout comes back stale, so the operator is told
    to re-bake MORE than strictly necessary rather than told nothing."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    manifest_path = dataset_dir / "layout_manifest.json"
    committed = json.loads(manifest_path.read_text(encoding="utf-8"))
    committed["column_roles"]["nickname"] = {"column": "place", "label": "Nickname"}
    manifest_path.write_text(json.dumps(committed, indent=2), encoding="utf-8")

    result = _set_roles(output_root, _BASE_ROLES)  # byte-identical roles to the bake's

    # Nothing actually moved, but with no parseable before-state every declared column
    # reads as changed -- and every layout that recorded a source column, as stale.
    assert result["changed_columns"] == ["bucket", "captured", "category", "filename", "place"]
    assert result["stale_layouts"] == ["datetime", "categorical_category", "categorical_bucket"]
    assert result["orphaned_layouts"] == []
    # The repair landed: the unparseable key is gone from the committed file.
    assert "nickname" not in _manifest(dataset_dir)["column_roles"]
    assert "do not parse under the current schema" in (
        dataset_dir / "ingest.log"
    ).read_text(encoding="utf-8")


# --- v2.10: the fingerprint is carried, never synthesised (seam L7 / D-xxix) -----------


def test_set_roles_carries_every_fingerprint_forward_untouched(tmp_path: Path) -> None:
    """Only a BAKE may say how a layout read its columns. After a roles-only commit the
    committed roles are exactly NOT what the bake read — that is the whole point of D-xxix
    — so re-deriving `source_fingerprint` from the new map here would erase the very
    evidence the stale flag rests on, and every layout would come back fresh forever.

    Byte-for-byte, not merely equal: `_entries_by_id` serialises each entry as it sits in
    the file, key order included, so an entry re-derived rather than carried fails."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_BASE_SCATTER_ROLES, layout_ids=_BASE_SCATTER_LAYOUT_IDS
    )
    before = _entries_by_id(_manifest(dataset_dir))
    assert json.loads(before["scatter"])["source_fingerprint"] == {
        "sx": [["scatter", "x", "sy", "linear", "linear", "fit", "overdraw"]],
        "sy": [["scatter", "y", "sx", "linear", "linear", "fit", "overdraw"]],
    }, "fixture premise: the bake recorded how it read the pair, `normalize: fit` included"

    result = _set_roles(output_root, _renormalized(_BASE_SCATTER_ROLES))

    assert result["stale_layouts"] == ["scatter"]
    assert _entries_by_id(_manifest(dataset_dir)) == before, (
        "not one layout entry may move — the roles changed, the bake did not"
    )


def test_set_roles_stamps_210_only_when_every_entry_carries_a_fingerprint(
    tmp_path: Path,
) -> None:
    """The stamp describes the FILE (2026-09-09 review finding 4), now with the 2.10 key
    at issue as well as the 2.9 one. A tree where one entry predates 2.10 must keep its
    committed stamp, or the file claims content one of its entries does not have.

    THE FIXTURE IS A SHAPE PRODUCTION REACHES, and that took a second fix to become true
    (2026-09-23 review, finding 8). A mixed manifest stamped `"2.9"` is what
    `add-layouts` leaves behind when it appends a 2.10 layout to a 2.9 tree — but only
    since `append_manifest_layouts` stopped stamping unconditionally. While it did,
    add-layouts wrote `"2.10"` over entries that lacked the key, so this fixture modelled a
    state nothing produced and the state that DID occur was untested.
    `test_add_layouts_keeps_the_committed_stamp_while_an_entry_lacks_the_key` pins the
    producer half."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    manifest_path = dataset_dir / "layout_manifest.json"
    committed = _manifest(dataset_dir)
    assert committed["manifest_version"] == MANIFEST_VERSION, "premise: a full 2.10 tree"
    committed["manifest_version"] = "2.9"
    del committed["layouts"][1]["source_fingerprint"]
    manifest_path.write_text(json.dumps(committed, indent=2), encoding="utf-8")

    result = _set_roles(output_root, _BASE_ROLES)

    assert result["manifest_version"] == "2.9"
    assert _manifest(dataset_dir)["manifest_version"] == "2.9"
    # ...and with that one entry's key restored, the same verb DOES move the stamp — so the
    # assertion above is about the missing key and not about set-roles never re-stamping.
    committed["layouts"][1]["source_fingerprint"] = {"captured": [["datetime", "iso8601"]]}
    manifest_path.write_text(json.dumps(committed, indent=2), encoding="utf-8")
    assert _set_roles(output_root, _BASE_ROLES)["manifest_version"] == MANIFEST_VERSION


def test_add_layouts_keeps_the_committed_stamp_while_an_entry_lacks_the_key(
    tmp_path: Path,
) -> None:
    """The producer half of the rule above (2026-09-23 review, finding 8).
    `append_manifest_layouts` — the add-layouts and `--replace` path — used to stamp the
    current minor UNCONDITIONALLY while carrying pre-2.10 entries forward byte-preserved,
    so appending one layout to a 2.9 collection wrote `"2.10"` over five entries that
    record no fingerprint. That is the same claim-about-content-that-is-not-there the
    other two verbs already refuse to make, on the path that reaches it most often.

    Driven through the sole writer directly, because no lean test bakes: the merged entry
    list is what decides the stamp."""
    _output_root, dataset_dir = _committed_dataset(tmp_path)
    committed = _manifest(dataset_dir)
    # A 2.9 collection: entries carry provenance, none carries a fingerprint.
    committed["manifest_version"] = "2.9"
    for entry in committed["layouts"]:
        del entry["source_fingerprint"]

    # The roles-override an `add-layouts --column-roles` run would compute against: `place`
    # gains a categorical role, so the new `categorical_place` layout is producible.
    roles = worker.ColumnRoles.from_config(
        {
            **_BASE_ROLES,
            "categorical": [
                {"column": "category", "label": "Category"},
                {"column": "bucket", "label": "Bucket"},
                {"column": "place", "label": "Place"},
            ],
            "freeform": [],
        }
    )
    meta = pq.read_table(dataset_dir / "metadata.parquet")
    atlas = worker._PositionsAtlas(ids=list(range(_N_ROWS)))
    fresh = worker._compute_requested_layouts(["categorical_place"], roles, meta, atlas)
    out = tmp_path / "merged.json"

    append_manifest_layouts(
        committed_manifest=committed,
        new_layouts=[fresh["categorical_place"]],
        new_pyramids={"categorical_place": _fake_pyramid("categorical_place")},
        dataset_version=2,
        output_path=out,
    )

    merged = json.loads(out.read_text(encoding="utf-8"))
    assert merged["manifest_version"] == "2.9", (
        "four carried-forward entries record no fingerprint, so the file has not earned 2.10"
    )
    # The appended entry DOES carry one — the stamp is withheld for the others, and the
    # merge is not a no-op.
    appended = next(e for e in merged["layouts"] if e["layout_id"] == "categorical_place")
    assert appended["source_fingerprint"] == {"place": [["categorical"]]}

    # ...and once every carried-forward entry has one, the same call DOES stamp 2.10.
    for entry in committed["layouts"]:
        entry["source_fingerprint"] = {}
    append_manifest_layouts(
        committed_manifest=committed,
        new_layouts=[fresh["categorical_place"]],
        new_pyramids={"categorical_place": _fake_pyramid("categorical_place")},
        dataset_version=2,
        output_path=out,
    )
    assert json.loads(out.read_text(encoding="utf-8"))["manifest_version"] == MANIFEST_VERSION


def test_set_roles_per_entry_rule_a_second_pair_does_not_stale_its_neighbour(
    tmp_path: Path,
) -> None:
    """THE THREE AGREE ON ONE EDIT (brief §3 test 8) — this is the pipeline's side; the
    client's `derived.outcomes` and `derived.baked` halves are in
    `packages/frontend/tests/ui_designer_pending.test.ts`.

    Adding a SECOND scatter pair over a spare axis pair changes `sq`/`sz`... no: it changes
    the columns the NEW pair names, and under the pre-2.10 whole-column rule that was
    enough to stale any layout built on either of them. Here the new pair shares `sx` with
    the committed one, so `sx`'s whole role set gains a tuple while the committed layout's
    own tuples are untouched — and it is NOT stale. The old rule said it was, and D-xxix
    would have pre-ticked a multi-hour re-bake that changes no pixel."""
    output_root, _dataset_dir = _committed_dataset(
        tmp_path, roles_config=_SCATTER_ROLES, layout_ids=_SCATTER_LAYOUT_IDS
    )

    result = _set_roles(
        output_root,
        {
            **_SCATTER_ROLES,
            "scatter": [
                {"x_column": "sx", "y_column": "sy", "label": "X vs Y"},
                {"x_column": "sx", "y_column": "sz", "label": "X vs Z"},
            ],
        },
    )

    assert result["changed_columns"] == ["sx", "sz"], "the COLUMN question is unchanged"
    assert result["stale_layouts"] == [], "but no layout's own inputs moved"
    assert result["renamed_layouts"] == {"scatter": "scatter_sx"}, (
        "the family crossed the multi boundary, which is a rename and not staleness"
    )


def test_set_roles_a_SECOND_role_on_a_read_column_does_not_stale_the_layout(
    tmp_path: Path,
) -> None:
    """The other false-stale case, on the verb that reports it: a column keeps the role a
    layout was built from and gains a SECOND one, so the COLUMN changed and the layout's
    own inputs did not. `_role_fingerprints`' docstring names the case as "categorical AND
    tag"; the pipeline cannot be handed that pair here, because a tag role must name a
    `list` column and a categorical layout's column in this fixture is a string (measured
    2026-09-23 — `ColumnRoleError: category: tag column is string in metadata.parquet, not
    a list`). `datetime` + `freeform` on `captured` is the same shape with types the
    committed parquet actually has; the tag-on-categorical wording is pinned client-side,
    where no parquet is consulted."""
    output_root, _dataset_dir = _committed_dataset(tmp_path)

    result = _set_roles(
        output_root,
        {
            **_BASE_ROLES,
            "freeform": [
                {"column": "place", "label": "Place"},
                {"column": "captured", "label": "Captured, as text"},
            ],
        },
    )

    assert result["changed_columns"] == ["captured"], "the column really did gain a role"
    assert result["stale_layouts"] == [], "but the datetime layout's own tuple is untouched"
    assert result["orphaned_layouts"] == []


def test_set_roles_tells_two_layouts_over_the_SAME_pair_apart(tmp_path: Path) -> None:
    """THE KEY IS NOT UNIQUE (2026-09-23 review of PR #379). A role map may declare two
    entries of one family over the same columns in the same ORDER — the naming convention
    contemplates it and hands the second a `-1` suffix — so `scatter_sx` and `scatter_sx-1`
    both provenance as `["sx","sy"]`. Looked up one-deep, the second silently overwrote the
    first and BOTH layouts were judged against ONE entry's tuples: committing `x_scale:
    log` on the first pair returned `stale == []`, reporting a layout baked LINEAR and now
    declaring LOG as fresh. That is the exact false-fresh this seam exists to prevent.

    The tie is broken by the layout's own bake record, so the answer is EXACT rather than
    merely safe: only the pair that actually moved is stale.

    KNOB SUBSTITUTION, measured. The report used `x_scale: log`; this fixture cannot bake
    it — `sx` is `i / _N_ROWS`, so its first value is 0.0 and the plugin refuses
    (`ValueError: expected a positive input, got 0.0`), and a log on `sy` alone is rejected
    because both axes must share one scale. `normalize` is the same kind of knob for this
    rule — in the fingerprint, out of the label — and `none` is legal here because both
    columns already lie within [0,1]."""
    roles_config = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "sx", "y_column": "sy", "label": "Fitted"},
            {"x_column": "sx", "y_column": "sy", "label": "Raw", "normalize": "none"},
        ],
    }
    layout_ids = ["grid", "scatter_sx", "scatter_sx-1"]
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=roles_config, layout_ids=layout_ids
    )
    # The premise, stated: two DIFFERENT layouts with byte-identical provenance, told apart
    # only by what each recorded about how it read those columns.
    by_id = {e["layout_id"]: e for e in _manifest(dataset_dir)["layouts"]}
    assert by_id["scatter_sx"]["source_columns"] == ["sx", "sy"]
    assert by_id["scatter_sx-1"]["source_columns"] == ["sx", "sy"]
    assert by_id["scatter_sx"]["source_fingerprint"] != by_id["scatter_sx-1"]["source_fingerprint"]

    moved_first = _set_roles(
        output_root,
        {
            **roles_config,
            "scatter": [
                {"x_column": "sx", "y_column": "sy", "label": "Fitted", "normalize": "none"},
                {"x_column": "sx", "y_column": "sy", "label": "Raw", "normalize": "none"},
            ],
        },
    )

    assert moved_first["changed_columns"] == ["sx", "sy"]
    assert moved_first["stale_layouts"] == ["scatter_sx"], (
        "the pair baked FITTED now declares none; the one already none did not move"
    )
    assert moved_first["unknown_layouts"] == []

    # ...and the other direction, so the pin cannot pass by naming a fixed layout: moving
    # the SECOND pair back to the default stales only `scatter_sx-1`.
    output_root2, _dir2 = _committed_dataset(
        tmp_path / "second", roles_config=roles_config, layout_ids=layout_ids
    )
    moved_second = _set_roles(
        output_root2,
        {
            **roles_config,
            "scatter": [
                {"x_column": "sx", "y_column": "sy", "label": "Fitted"},
                {"x_column": "sx", "y_column": "sy", "label": "Raw"},
            ],
        },
    )
    assert moved_second["stale_layouts"] == ["scatter_sx-1"]


def test_set_roles_a_round_trip_back_to_the_baked_declaration_is_FRESH(
    tmp_path: Path,
) -> None:
    """THE BAKE RECORD IS WHAT A LAYOUT WAS BAKED WITH — not the entry in whatever the
    roles happened to say last (2026-09-23 review, finding 1).

    Bake `normalize: fit`, commit `none` (stale, correctly), then commit back to `fit`.
    Judged against the BEFORE roles, `own` is now the `none` tuple, which the new map does
    not declare, so the commit reports STALE — while the durable record, which reads the
    layout's own `source_fingerprint`, reports FRESH. Two of the three answers would then
    contradict the third within one session, and D-xxix would pre-queue a multi-hour
    re-bake of a layout whose tiles already match its declaration. (This spec moved the
    datetime format until D-xxxii fixed it at ingest.)

    The tiles never moved. `fit` is what they were baked from and what the roles now say,
    so the only correct answer is `[]`."""
    output_root, dataset_dir = _committed_dataset(
        tmp_path, roles_config=_BASE_SCATTER_ROLES, layout_ids=_BASE_SCATTER_LAYOUT_IDS
    )
    baked = next(e for e in _manifest(dataset_dir)["layouts"] if e["layout_id"] == "scatter")

    away = _set_roles(output_root, _renormalized(_BASE_SCATTER_ROLES))
    assert away["stale_layouts"] == ["scatter"], "premise: the trip out really stales it"

    back = _set_roles(output_root, _BASE_SCATTER_ROLES)  # byte-identical to the bake's roles

    assert back["changed_columns"] == ["sx", "sy"], "the COLUMNS moved again, twice over"
    assert back["stale_layouts"] == [], (
        "the roles now declare exactly what the tiles were baked from"
    )
    # ...and the record itself was never rewritten by either roles-only commit.
    entry = next(e for e in _manifest(dataset_dir)["layouts"] if e["layout_id"] == "scatter")
    assert entry["source_fingerprint"] == baked["source_fingerprint"]


def test_set_roles_reports_what_THIS_edit_stales_not_what_was_already_stale(
    tmp_path: Path,
) -> None:
    """2026-09-24 round-2 review, N1. Reading the bake record makes the ALREADY-STALE
    population visible for the first time — and putting it in this report would be wrong,
    because D-xxix pre-queues a re-bake for everything this verb names. An operator who
    deliberately left a layout stale would have it re-queued on every later unrelated
    commit, for ever, including right after they removed it from the queue.

    Here the scatter pair's `normalize` was committed away from the bake's and left
    un-baked (the datetime format did this until D-xxxii fixed it at ingest); a LATER
    commit touches only `category`. Only `categorical_category` is newly staled."""
    output_root, _dataset_dir = _committed_dataset(
        tmp_path, roles_config=_BASE_SCATTER_ROLES, layout_ids=_BASE_SCATTER_LAYOUT_IDS
    )
    baked = next(e for e in _manifest(_dataset_dir)["layouts"] if e["layout_id"] == "scatter")
    first = _set_roles(output_root, _renormalized(_BASE_SCATTER_ROLES))
    assert first["stale_layouts"] == ["scatter"], "premise: it really was staled, once"

    second = _set_roles(
        output_root,
        {
            **_renormalized(_BASE_SCATTER_ROLES),
            "categorical": [{"column": "bucket", "label": "Bucket"}],
            "freeform": [{"column": "place", "label": "Place"}, {"column": "category", "label": "Category"}],
        },
    )

    assert second["changed_columns"] == ["category"]
    assert second["stale_layouts"] == ["categorical_category"], (
        "the scatter layout is still stale, but THIS edit did not do it"
    )
    # ...and the evidence is untouched, so the client's durable verdict still reports it.
    entry = next(
        e for e in _manifest(_dataset_dir)["layouts"] if e["layout_id"] == "scatter"
    )
    assert entry["source_fingerprint"] == baked["source_fingerprint"]


def test_set_roles_changing_ONE_of_two_identical_pairs_stales_them(tmp_path: Path) -> None:
    """A DUPLICATE ENTRY KEEPS THE UNION POPULATED (2026-09-23 review, finding 2). Two
    scatter entries over `(sx, sy)`, both `fit`, baked as `scatter_sx` and `scatter_sx-1`;
    change only the FIRST to `none`. Tested against the per-column UNION of the new roles,
    the second entry still contributes the `fit` tuples, so the changed layout read FRESH
    over tiles that no longer match it — the false-fresh this whole rule exists to prevent,
    surviving inside one family.

    Matched and COUNTED against the new roles' ENTRIES, two layouts recorded `fit` and only
    one entry still declares it, so one of them is stale. Which one is unknowable — they
    recorded the same thing — so BOTH are reported. Over-reporting is the safe direction;
    picking one arbitrarily would let the genuinely stale layout read fresh."""
    roles_config = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "sx", "y_column": "sy", "label": "One"},
            {"x_column": "sx", "y_column": "sy", "label": "Two"},
        ],
    }
    output_root, _dataset_dir = _committed_dataset(
        tmp_path, roles_config=roles_config, layout_ids=["grid", "scatter_sx", "scatter_sx-1"]
    )

    result = _set_roles(
        output_root,
        {
            **roles_config,
            "scatter": [
                {"x_column": "sx", "y_column": "sy", "label": "One", "normalize": "none"},
                {"x_column": "sx", "y_column": "sy", "label": "Two"},
            ],
        },
    )

    assert result["stale_layouts"] == ["scatter_sx", "scatter_sx-1"]


def test_set_roles_two_INDISTINGUISHABLE_entries_over_one_pair_are_stale_together(
    tmp_path: Path,
) -> None:
    """The tie-break's fail-safe half. Two entries over the same pair with the SAME knobs
    record the same fingerprint, so the bake record cannot say which layout came from
    which — and it does not need to: they are interchangeable, and a change to either
    declaration is a change to both. Rule 2 (`exactly one candidate`) does not fire, rule 3
    matches the first, and the answer is the same for both layouts."""
    roles_config = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "sx", "y_column": "sy", "label": "One"},
            {"x_column": "sx", "y_column": "sy", "label": "Two"},
        ],
    }
    output_root, _dataset_dir = _committed_dataset(
        tmp_path, roles_config=roles_config, layout_ids=["grid", "scatter_sx", "scatter_sx-1"]
    )

    result = _set_roles(
        output_root,
        {
            **roles_config,
            "scatter": [
                {"x_column": "sx", "y_column": "sy", "label": "One", "normalize": "none"},
                {"x_column": "sx", "y_column": "sy", "label": "Two", "normalize": "none"},
            ],
        },
    )

    assert result["stale_layouts"] == ["scatter_sx", "scatter_sx-1"]


def test_set_roles_a_layout_whose_entry_cannot_be_located_is_stale(tmp_path: Path) -> None:
    """The fail-safe, isolated from the unparseable-roles case below, and scoped to the
    population it still applies to. The committed roles PARSE; the layout records no
    fingerprint (a PRE-2.10 entry), so the only handle on what it was baked with is its
    provenance — and that names a column the map no longer reads as a datetime, so no
    entry can be found and nothing can be compared. A naive per-entry test finds no
    missing tuple and reports it FRESH, which is the one answer silence must never produce.

    A 2.10 entry cannot reach this branch: its own record IS what it was baked with, and
    a record that matches nothing in EITHER map is a layout that was already stale before
    this edit, which `..._reports_what_THIS_edit_stales_not_what_was_already_stale` covers
    and `derived.baked` carries."""
    output_root, dataset_dir = _committed_dataset(tmp_path)
    manifest_path = dataset_dir / "layout_manifest.json"
    committed = json.loads(manifest_path.read_text(encoding="utf-8"))
    # A hand-edited manifest: the datetime entry claims to have been built from `place`,
    # and (as a pre-2.10 bake) records nothing about how it read it.
    entry = next(e for e in committed["layouts"] if e["layout_id"] == "datetime")
    entry["source_columns"] = ["place"]
    del entry["source_fingerprint"]
    manifest_path.write_text(json.dumps(committed, indent=2), encoding="utf-8")

    result = _set_roles(output_root, _BASE_ROLES)  # byte-identical roles to the bake's

    assert result["changed_columns"] == [], "nothing moved in the roles at all"
    assert result["stale_layouts"] == ["datetime"], (
        "no locatable entry ⇒ STALE; absence is never a positive claim of freshness"
    )
    assert result["unknown_layouts"] == [], "it DID record provenance — it just cannot be matched"


# --- the shaping knobs are DERIVED from the emitter's own list (review finding 12) -----


def test_every_serialized_scatter_knob_moves_the_role_fingerprint() -> None:
    """`_SCATTER_KNOBS` names the fields whose change stales a layout. It used to be a
    third hand-written copy of the knob names, so a fifth knob added to the emitter and
    not here would silently disarm both `_guard_no_stale_scatter_config` and
    `_role_fingerprints`, with no test able to notice -- both would simply stop looking at
    the new knob.

    The pin is driven from `manifest._SCATTER_KNOB_DEFAULTS`, the dict the EMITTER
    iterates to decide what to serialize: every knob in it must move the fingerprint of
    both columns of the pair it belongs to. The moved value is a sentinel applied with
    `dataclasses.replace`, so this asserts the fingerprint's reach and not the schema's
    enum."""
    base = worker.ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "scatter": [{"x_column": "u", "y_column": "v", "label": "S"}],
        }
    )
    assert _SCATTER_KNOB_DEFAULTS, "premise: the emitter has knobs at all"
    for knob in _SCATTER_KNOB_DEFAULTS:
        moved = dataclasses.replace(
            base, scatter=[dataclasses.replace(base.scatter[0], **{knob: "MOVED"})]
        )
        assert worker._changed_role_columns(base, moved) == ["u", "v"], (
            f"scatter knob {knob!r} is serialized by the emitter but is not in "
            f"worker._SCATTER_KNOBS, so changing it stales nothing"
        )


def test_every_serialized_geographic_knob_moves_the_role_fingerprint() -> None:
    """The geographic twin of the scatter knob pin, driven from
    `manifest._GEO_KNOB_DEFAULTS` for the same reason."""
    base = worker.ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "F"},
            "geographic": [{"lon_column": "lon", "lat_column": "lat", "label": "G"}],
        }
    )
    assert _GEO_KNOB_DEFAULTS, "premise: the emitter has knobs at all"
    for knob in _GEO_KNOB_DEFAULTS:
        moved = dataclasses.replace(
            base, geographic=[dataclasses.replace(base.geographic[0], **{knob: "MOVED"})]
        )
        assert worker._changed_role_columns(base, moved) == ["lat", "lon"], (
            f"geographic knob {knob!r} is serialized by the emitter but is not in "
            f"worker._GEO_KNOBS, so changing it stales nothing"
        )


# --- the scoped sweep stays inside the layout it was asked about (review finding 8) ----


def test_the_positions_sweep_cannot_reach_a_sibling_whose_id_begins_layout_v(
    tmp_path: Path,
) -> None:
    """`positions/` is flat and shared by every layout, so a delete/replace picks its own
    tables out by name. A PREFIX test with a `_v` anchor keeps `categorical_group` from
    matching `categorical_group_extra` -- but it does NOT stop `scatter` from matching a
    sibling whose own id begins `scatter_v`. `scatter_v2_run` is a legal `_slug` output,
    and `positions/scatter_v2_run_v1.arrow` both matches the version pattern and starts
    with `scatter_v`, so deleting `scatter` swept a superseded generation belonging to a
    layout it was never asked about (2026-09-09 review finding 8).

    Only already-superseded files were ever at risk -- a sibling's LIVE table is in
    `referenced_positions` -- but "a scoped verb touches only the layout it was asked
    about" is the entire claim an operator is being asked to trust with an irreversible
    sweep."""
    dataset_dir = tmp_path / "ds"
    (dataset_dir / "positions").mkdir(parents=True)
    (dataset_dir / "tiles" / "scatter").mkdir(parents=True)
    (dataset_dir / "tiles" / "scatter_v2_run").mkdir(parents=True)
    (dataset_dir / "tiles" / "scatter" / "scatter_v1.pmtiles").write_bytes(b"gone")
    (dataset_dir / "tiles" / "scatter_v2_run" / "scatter_v2_run_v2.pmtiles").write_bytes(b"live")
    (dataset_dir / "positions" / "scatter_v1.arrow").write_bytes(b"gone")
    (dataset_dir / "positions" / "scatter_v2_run_v1.arrow").write_bytes(b"superseded-sibling")
    (dataset_dir / "positions" / "scatter_v2_run_v2.arrow").write_bytes(b"live-sibling")

    # The manifest AFTER the flip that removed `scatter`: only the sibling survives, and
    # it references its v2 assets, so its v1 table is a superseded generation of a layout
    # this sweep was not asked about.
    flipped = {
        "layouts": [
            {
                "layout_id": "scatter_v2_run",
                "pyramid": {"path": "tiles/scatter_v2_run/scatter_v2_run_v2.pmtiles"},
                "positions_ref": "positions/scatter_v2_run_v2.arrow",
            }
        ]
    }

    swept, _swept_bytes = worker._sweep_layout_assets(dataset_dir, flipped, ["scatter"])

    assert sorted(p.name for p in swept) == ["scatter_v1.arrow", "scatter_v1.pmtiles"]
    assert (dataset_dir / "positions" / "scatter_v2_run_v1.arrow").is_file(), (
        "the sweep reached a SIBLING layout's superseded position table"
    )
    assert (dataset_dir / "positions" / "scatter_v2_run_v2.arrow").is_file()
    assert not (dataset_dir / "tiles" / "scatter").exists()


# --- what `pixscope set-roles` actually PRINTS ----------------------------------------
#
# The console is where an operator meets these findings. Both of the messages pinned here
# were wrong in a way no return-value assertion could see: one named a command that
# refuses, the other named a destructive remedy for a healthy layout.


def _set_roles_cli(output_root: Path, tmp_path: Path, ds_id: str, config: dict) -> int:
    roles_path = tmp_path / f"{ds_id}_roles.json"
    roles_path.write_text(json.dumps(config), encoding="utf-8")
    return cli.main(
        [
            "set-roles",
            "--dataset-id", ds_id,
            "--column-roles", str(roles_path),
            "--output-root", str(output_root),
        ]
    )


def test_set_roles_cli_asks_for_refresh_manifest_FORCE_and_names_a_left_behind_sidecar(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Two console findings on one run over the real 2.8 fixture.

    FINDING 2. The unknown-provenance line used to say "`pixscope refresh-manifest`
    backfills it with no re-bake", and that command REFUSES on every tree this line can be
    printed for. `run_refresh_manifest` treats a manifest as already-enriched when its
    minor is >= 2.5 AND any layout carries `bbox_exact`/`annotations` — and `bbox_exact`
    is emitted on EVERY layout from 2.5 onward, while 2.5-2.8 is exactly the population
    with no `source_columns` (which arrived at 2.9). Measured 2026-09-09 on this fixture:
    stamped 2.8 with 6 `bbox_exact` keys and 3 `annotations` keys, so the advised command
    exits 2 with "already at manifest_version '2.8' carrying the 2.5 enrichment".

    FINDING 3, the reverse tag case. This fixture declares one tag role (`tags`) and
    carries `tags/tags_v1.arrow`; the roles below drop that role, which leaves the
    manifest's `tags` block pointing at a sidecar nothing declares."""
    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    committed = _manifest(dataset_dir)
    assert committed["manifest_version"] == "2.8"
    assert sum("bbox_exact" in e for e in committed["layouts"]) == 6, (
        "fixture premise: every layout carries the 2.5 enrichment refresh refuses to redo"
    )
    assert committed["tags"]["path"] == "tags/tags_v1.arrow"
    roles = {k: v for k, v in committed["column_roles"].items() if k != "tag"}

    code = _set_roles_cli(output_root, tmp_path, "golden_dataset_full_v2", roles)

    out = capsys.readouterr().out
    assert code == 0
    assert f"pixscope refresh-manifest --dataset-id golden_dataset_full_v2 " \
           f"--output-root {output_root} --force" in out
    # FINDING B2 (round 2): the block is not just named, it is gone -- and the message
    # says which file that leaves unreferenced.
    assert "tags/tags_v1.arrow" in out and "has been REMOVED" in out
    assert "tags" not in _manifest(dataset_dir)


def test_set_roles_cli_offers_a_rename_a_re_bake_and_never_a_delete(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """FINDING 1 at the console. The 2 -> 1 edit renames one layout and orphans another,
    and the two must not read the same: `categorical_category` is live and untouched, so
    telling the operator its column "lost its role" and to `delete-layout` it is a
    misattributed cause attached to a destructive instruction."""
    output_root, _dataset_dir = _committed_dataset(tmp_path)

    code = _set_roles_cli(
        output_root,
        tmp_path,
        "roles_ds",
        {
            **_BASE_ROLES,
            "categorical": [{"column": "category", "label": "Category"}],
            "freeform": [
                {"column": "place", "label": "Place"},
                {"column": "bucket", "label": "Bucket"},
            ],
        },
    )

    out = capsys.readouterr().out
    assert code == 0
    rename_lines = [line for line in out.splitlines() if "NOTE:" in line]
    orphan_lines = [line for line in out.splitlines() if "WARNING:" in line]
    assert len(rename_lines) == 1 and len(orphan_lines) == 1
    assert "'categorical_category' would now be baked as 'categorical'" in rename_lines[0]
    assert f"pixscope add-layouts --images <original-images-dir> --dataset-id roles_ds " \
           f"--output-root {output_root} --layout categorical --sync" in rename_lines[0]
    assert "categorical_bucket" in orphan_lines[0]
    # The renamed layout is named ONLY by the rename line. If it appeared in the orphan
    # warning too, the operator would be told to delete a layout nothing is wrong with.
    assert "categorical_category" not in orphan_lines[0]


# --- every remediation command set-roles prints is RUNNABLE (round-2 finding B1) -------
#
# The messages interpolate real ids, so they read as copy-pasteable. Measured 2026-09-10
# by handing the round-1 head's forms to the CURRENT parser (this change did not touch
# it), all four exit 2: `add-layouts --column-roles {path}` and `add-layouts --layout
# {new_id}` want --images/--dataset-id/--layout, `delete-layout --layout {old_id}` and
# `refresh-manifest --force` want --dataset-id -- and an add-layouts that parses without
# --sync still returns 2 without baking. The ingest.log carried the same fragments. The
# instrument below is the review's own: hand every command the output offers to
# `cli._build_parser()` and see whether it parses.
#
# DERIVED, not transcribed: the pin does not know what the commands SHOULD say. It reads
# whatever is between backticks and asks the real parser, so a message added later is
# covered with no edit here, and a flag that becomes required breaks it without one.

_PIXSCOPE_COMMAND = re.compile(r"`(pixscope [^`]+)`")


def _printed_commands(text: str) -> list[str]:
    """Every backticked `pixscope ...` command in a console dump or an ingest.log."""
    return _PIXSCOPE_COMMAND.findall(text)


def _assert_runnable(commands: list[str]) -> set[str]:
    """Every command parses under the real CLI parser; returns the verbs seen.

    `<placeholder>` tokens are stripped of their angle brackets and passed through as
    ordinary values -- they stand for a directory or an id this process cannot know, which
    is the ONLY thing a printed command is allowed to leave to the operator (the precedent
    is `cli._print_ownership_next_steps`' `<username>`). They are single tokens on purpose:
    a placeholder with a space in it would not survive a paste into a shell."""
    parser = cli._build_parser()
    verbs: set[str] = set()
    for command in commands:
        argv = shlex.split(command.replace("<", "").replace(">", ""))
        assert argv[0] == "pixscope"
        try:
            args = parser.parse_args(argv[1:])
        except SystemExit as exc:  # argparse's own error text is in captured stderr
            pytest.fail(f"printed command exits {exc.code} instead of running: {command}")
        verbs.add(args.command)
        if args.command == "add-layouts":
            # Parsing is not enough for this one: without --sync the CLI prints
            # "re-run with --sync for a local inline bake" and returns 2, so a printed
            # add-layouts command that omits it is a no-op with a full parse.
            assert args.sync, f"printed add-layouts command would no-op without --sync: {command}"
    return verbs


def test_every_pixscope_command_set_roles_prints_or_logs_actually_parses(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Three runs, chosen to light up every branch that prints a command: the real 2.8
    fixture (unknown provenance -> `refresh-manifest`), the 2 -> 1 categorical edit (a
    rename -> `add-layouts` + `delete-layout`, and an orphan -> `delete-layout`), and a
    declared tag role the sidecar cannot serve (-> `add-layouts --column-roles`). Both
    surfaces are collected: the console AND the dataset's own ingest.log, because the log
    is where an operator reads the same advice back later."""
    commands: list[str] = []

    output_root, dataset_dir = _copy_fixture("golden_dataset_full_v2", tmp_path)
    roles = {k: v for k, v in _manifest(dataset_dir)["column_roles"].items() if k != "tag"}
    assert _set_roles_cli(output_root, tmp_path, "golden_dataset_full_v2", roles) == 0
    commands += _printed_commands(capsys.readouterr().out)
    commands += _printed_commands((dataset_dir / "ingest.log").read_text(encoding="utf-8"))

    rename_root, rename_dir = _committed_dataset(tmp_path, ds_id="rename_ds")
    assert _set_roles_cli(
        rename_root,
        tmp_path,
        "rename_ds",
        {
            **_BASE_ROLES,
            "categorical": [{"column": "category", "label": "Category"}],
            "freeform": [
                {"column": "place", "label": "Place"},
                {"column": "bucket", "label": "Bucket"},
            ],
        },
    ) == 0
    commands += _printed_commands(capsys.readouterr().out)
    commands += _printed_commands((rename_dir / "ingest.log").read_text(encoding="utf-8"))

    tag_root, tag_dir = _committed_dataset(
        tmp_path, ds_id="tag_ds", roles_config=_TAG_ROLES, with_tags=True
    )
    assert _set_roles_cli(
        tag_root,
        tmp_path,
        "tag_ds",
        {
            **_TAG_ROLES,
            "tag": [
                {"column": "keywords", "label": "Keywords", "delimiter": ","},
                {"column": "topics", "label": "Topics", "delimiter": ","},
            ],
        },
    ) == 0
    commands += _printed_commands(capsys.readouterr().out)
    commands += _printed_commands((tag_dir / "ingest.log").read_text(encoding="utf-8"))

    # The pin cannot pass by extracting nothing: every verb the advice can name is here.
    assert _assert_runnable(commands) == {"add-layouts", "delete-layout", "refresh-manifest"}
