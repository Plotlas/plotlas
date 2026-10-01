"""Per-layout PROVENANCE — schema v2.9 `layouts[].source_columns`
([[T2-a-layout-does-not-record-which-column-it-was]], INTAKE_REDESIGN §6c).

D-ix exists to serve one concept: *a layout whose underlying data has changed is flagged,
with a control to start a re-bake*, where a metadata change *stales only the layouts derived
from the columns that moved*. Before 2.9 that was answerable only by inferring from
`column_roles` + `type` + whatever convention a `layout_id` happened to follow — guessing, and
D-ix says plainly that if the flag cannot be computed without guessing, the boundary is wrong.

The shape is a per-layout LIST OF COLUMN NAMES, and the load-bearing property is that
**grid names nothing**: grid places cells by id (== sorted filename) and reads no metadata at
all, so `[]` is its real answer rather than a special case, and the staleness predicate
`any(moved in entry["source_columns"])` is false for grid by construction.

LEAN (no pyvips/pmtiles): the plugins are pure functions of a pyarrow table + roles.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import jsonschema
import pyarrow as pa
import pytest

from pipeline import worker
from pipeline.layout_plugins.base import ColumnRoles, LayoutResult, build_spatial_cells
from pipeline.manifest import _layout_entry, _validate_manifest

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "schemas" / "v2"


# --- fixtures: one metadata table every family can be computed against ---------------

_N = 6

# The roles the table below supports, one entry per family. The column NAMES are what the
# provenance assertions below expect to see recorded, so they are deliberately distinct from
# each other and from every layout_id — a producer that recorded the layout_id, the role name
# or the label instead of the column would fail rather than coincidentally pass.
_ROLES_CONFIG: dict = {
    "filename": {"column": "filename", "label": "File"},
    "datetime": {"column": "when_shot", "label": "When", "format": "unix_seconds"},
    "categorical": [
        {"column": "kingdom", "label": "Kingdom"},
        {"column": "biome", "label": "Biome"},
    ],
    "scatter": [{"x_column": "umap_x", "y_column": "umap_y", "label": "UMAP"}],
    "geographic": [{"lon_column": "longitude", "lat_column": "latitude", "label": "Where"}],
}

# What EVERY plugin registered in `worker._PLUGINS` must record, given `_ROLES_CONFIG`.
# Keyed by plugin name, so a family added to `_PLUGINS` with no entry here fails the sweep
# below instead of silently inheriting `LayoutResult.source_columns`' `()` default — which is
# the same "0 is a claim, not a default-shaped silence" hazard `missing_count` carries.
_EXPECTED: dict[str, tuple[str, ...]] = {
    "grid": (),                                   # reads no metadata at all
    "datetime": ("when_shot",),
    "categorical": ("kingdom",),                  # entry_index 0 of two
    "scatter": ("umap_x", "umap_y"),              # the PAIR
    "geographic": ("longitude", "latitude"),      # lon then lat
}


def _meta() -> pa.Table:
    return pa.table(
        {
            "id": pa.array(range(_N), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(_N)], pa.string()),
            "when_shot": pa.array([1_600_000_000 + i * 86_400 for i in range(_N)], pa.int64()),
            "kingdom": pa.array(["fungi", "fungi", "plant", "plant", "animal", "animal"]),
            "biome": pa.array(["wet", "dry", "wet", "dry", "wet", "dry"]),
            "umap_x": pa.array([float(i) for i in range(_N)], pa.float64()),
            "umap_y": pa.array([float(_N - i) for i in range(_N)], pa.float64()),
            "longitude": pa.array([float(i * 10) for i in range(_N)], pa.float64()),
            "latitude": pa.array([float(i * 5) for i in range(_N)], pa.float64()),
        }
    )


def _atlas() -> SimpleNamespace:
    """A ThumbnailCache stand-in — the plugins reach it only through `packed_ids`."""
    return SimpleNamespace(ids=list(range(_N)))


def _fake_pyramid() -> SimpleNamespace:
    """A PyramidResult stand-in; `_layout_entry` reads only these attributes."""
    return SimpleNamespace(
        path="tiles/x/x_v1.pmtiles", tile_px=512, thumb_px=64, cap=64,
        levels=[SimpleNamespace(z=0, tile_count=1)], z_cap=0,
        detail_path_prefix=None, detail_format=None, dropped_total=0,
    )


def _manifest_schema() -> dict:
    return json.loads((SCHEMA_DIR / "layout_manifest.schema.json").read_text(encoding="utf-8"))


# --- every family records what it consumed ------------------------------------------


@pytest.mark.parametrize("plugin_name", sorted(worker._PLUGINS))
def test_every_registered_plugin_records_the_columns_it_consumed(plugin_name: str) -> None:
    """Swept over `worker._PLUGINS` rather than a hand-listed set, so a NEW layout family is
    caught the moment it is registered: it has no `_EXPECTED` row and fails here, instead of
    quietly inheriting the `()` default and claiming it depends on nothing."""
    assert plugin_name in _EXPECTED, (
        f"{plugin_name!r} is registered in worker._PLUGINS but declares no expected "
        f"source_columns here. `()` is a CLAIM ('this layout reads no metadata'), not a "
        f"default — state what the family consumes."
    )
    roles = ColumnRoles.from_config(_ROLES_CONFIG)
    result = worker._PLUGINS[plugin_name]().compute(_meta(), roles, _atlas(), {})
    assert result.source_columns == _EXPECTED[plugin_name]


def test_grid_depends_on_nothing_and_no_metadata_change_stales_it() -> None:
    """The property the whole shape exists for. Grid is the images-only floor — it needs no
    metadata, which is why D-viii can make it optional — so "depends on nothing" has to be
    representable, or the staleness flag fires on grid forever."""
    grid = worker._PLUGINS["grid"]()
    roles = ColumnRoles.from_config(_ROLES_CONFIG)
    with_roles = grid.compute(_meta(), roles, _atlas(), {})
    # ...and identically with NO roles at all (the images-only dataset, D-25).
    without_roles = grid.compute(_meta(), None, _atlas(), {})
    assert with_roles.source_columns == () == without_roles.source_columns

    entry = _layout_entry(with_roles, _fake_pyramid())
    stales = lambda e, moved: any(c in e["source_columns"] for c in moved)  # noqa: E731
    assert stales(entry, ["when_shot", "kingdom", "umap_x", "longitude", "filename"]) is False


def test_two_categorical_layouts_on_different_columns_are_told_apart() -> None:
    """The case that made the flag uncomputable: two categorical layouts differ only by their
    column, and `type` + `layout_id` could not say which one a change to `kingdom` stales."""
    plugin = worker._PLUGINS["categorical"]()
    roles = ColumnRoles.from_config(_ROLES_CONFIG)
    first = plugin.compute(_meta(), roles, _atlas(), {"entry_index": 0})
    second = plugin.compute(_meta(), roles, _atlas(), {"entry_index": 1})
    assert first.source_columns == ("kingdom",)
    assert second.source_columns == ("biome",)


def test_a_degenerate_pair_collapses_to_one_name() -> None:
    """x_column == y_column is representable in column_roles, and the field is the SET of
    columns depended on — the pair structure lives in column_roles and `options` — so the
    duplicate collapses rather than being emitted twice (the schema's `uniqueItems` would
    reject it anyway)."""
    config = dict(_ROLES_CONFIG)
    config["scatter"] = [{"x_column": "umap_x", "y_column": "umap_x", "label": "Diagonal"}]
    result = worker._PLUGINS["scatter"]().compute(
        _meta(), ColumnRoles.from_config(config), _atlas(), {}
    )
    assert result.source_columns == ("umap_x",)


# --- the manifest carries it ---------------------------------------------------------


def test_layout_entry_emits_source_columns_unconditionally_including_empty() -> None:
    """The always-emit rule (`missing_count`, `pyramid.dropped_total`): `[]` must be WRITTEN,
    because `[]` means "recorded, and there are none" while an ABSENT key means "this entry
    predates 2.9". Omitting at empty collapses exactly the two cases the presence gate has to
    tell apart — and grid, the layout that legitimately depends on nothing, is the case."""
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    empty = _layout_entry(
        LayoutResult("grid", "grid", "Grid", cells, (0.0, 0.0, 1.0, 1.0), None),
        _fake_pyramid(),
    )
    assert empty["source_columns"] == []
    filled = _layout_entry(
        LayoutResult(
            "scatter", "scatter", "S", cells, (0.0, 0.0, 1.0, 1.0), None,
            source_columns=("umap_x", "umap_y"),
        ),
        _fake_pyramid(),
    )
    assert filled["source_columns"] == ["umap_x", "umap_y"]  # a JSON array, not a tuple


def _manifest_with(layout_extra: dict) -> dict:
    return {
        "manifest_version": "2.9",
        "dataset_id": "ds",
        "dataset_version": 1,
        "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-09-07T00:00:00Z"},
        "layouts": [
            {
                "layout_id": "grid",
                "label": "Grid",
                "type": "grid",
                "bbox": [0.0, 0.0, 1.0, 1.0],
                "pyramid": {
                    "container": "pmtiles",
                    "path": "tiles/grid/grid_v1.pmtiles",
                    "tile_px": 512,
                    "thumb_px": 64,
                    "cap": 64,
                    "levels": [{"z": 0, "tile_count": 1}],
                    "z_cap": 0,
                },
                **layout_extra,
            }
        ],
    }


# --- v2.10: every family also records HOW it read them -------------------------------
#
# [[T2-a-layout-cannot-say-it-is-stale-once-the-job]] / LAYOUT_DESIGNER D-xxix. 2.9 made
# "which layouts does this metadata change stale?" a lookup; 2.10 makes the answer survive
# the commit that caused it, because a roles-only edit rewrites `column_roles` and bakes
# nothing, and after 500 s the finished job's `result` is gone.


@pytest.mark.parametrize("plugin_name", sorted(worker._PLUGINS))
def test_every_family_records_the_subset_its_own_role_entry_contributes(
    plugin_name: str,
) -> None:
    """THE PIPELINE IS THE ORACLE, as it is for the client's tests. The expectation is not
    a hand-written tuple — it is `worker._role_fingerprints` of the roles this bake used,
    RESTRICTED to the layout's own source columns, and the claim is that what the layout
    recorded is a SUBSET of it and covers exactly those columns.

    A subset and not an equality, and that is the whole design (D-xxix): `_role_fingerprints`
    unions every role on a column, while the record holds only what THIS entry contributed.
    The `_ROLES_CONFIG` above gives every column one role, so equality would also pass here
    — which is why the false-stale cases are pinned separately, on a roles map that gives a
    column two."""
    roles = ColumnRoles.from_config(_ROLES_CONFIG)
    result = worker._PLUGINS[plugin_name]().compute(_meta(), roles, _atlas(), {})
    union = worker._role_fingerprints(roles)

    assert sorted(result.source_fingerprint) == sorted(result.source_columns), (
        f"{plugin_name}: the recorded keys must BE the provenance — both are set by the "
        f"plugin from one role entry, and a reader joins them with no translation"
    )
    for column, fingerprints in result.source_fingerprint.items():
        assert set(fingerprints) <= union[column], (
            f"{plugin_name}: recorded a way of reading {column!r} that the roles this bake "
            f"used do not declare at all"
        )
    assert (plugin_name == "grid") == (result.source_fingerprint == {}), (
        "grid records `{}` — a positive 'reads no column' — and no other family does"
    )


def test_a_second_role_on_the_same_column_is_NOT_in_the_layouts_record() -> None:
    """The property the per-entry scope exists for, and the one the parametrised test above
    cannot see. `kingdom` carries BOTH a categorical role and a tag role — a shape
    `_role_fingerprints`' own docstring contemplates — so its UNION holds two tuples while
    the treemap's record must hold exactly the one it was built from.

    Recording the union instead would make this categorical layout read stale forever the
    moment anyone tagged that column, and D-xxix pre-queues a re-bake for every layout a
    change stales: a multi-hour bake that changes no pixel."""
    config = dict(_ROLES_CONFIG)
    config["tag"] = [{"column": "kingdom", "label": "Kingdom tags", "delimiter": ","}]
    roles = ColumnRoles.from_config(config)
    union = worker._role_fingerprints(roles)
    assert union["kingdom"] == {("categorical",), ("tag", ",")}, "premise: two roles, one column"

    result = worker._PLUGINS["categorical"]().compute(_meta(), roles, _atlas(), {"entry_index": 0})
    assert result.source_fingerprint == {"kingdom": (("categorical",),)}
    assert set(result.source_fingerprint["kingdom"]) < union["kingdom"], "a STRICT subset"


def test_a_second_pair_sharing_an_axis_is_NOT_in_the_first_pairs_record() -> None:
    """The same property for the pair families, where it is easiest to hit by accident: two
    scatter entries over `umap_x` — `(umap_x, umap_y)` and `(umap_x, latitude)`. The
    column's union gains the second entry's tuple; the first layout's record must not."""
    config = dict(_ROLES_CONFIG)
    config["scatter"] = [
        {"x_column": "umap_x", "y_column": "umap_y", "label": "UMAP"},
        {"x_column": "umap_x", "y_column": "latitude", "label": "Second"},
    ]
    roles = ColumnRoles.from_config(config)
    union = worker._role_fingerprints(roles)
    assert len(union["umap_x"]) == 2, "premise: the shared axis is read two ways now"

    first = worker._PLUGINS["scatter"]().compute(_meta(), roles, _atlas(), {"entry_index": 0})
    assert first.source_fingerprint == {
        "umap_x": (("scatter", "x", "umap_y", "linear", "linear", "fit", "overdraw"),),
        "umap_y": (("scatter", "y", "umap_x", "linear", "linear", "fit", "overdraw"),),
    }


def test_a_self_pair_records_TWO_tuples_under_its_ONE_column() -> None:
    """`x_column == y_column` de-duplicates to one `source_columns` entry (the test above),
    but BOTH axes are still declared on it — so the single key carries both tuples, and a
    reader that assumed one tuple per column would silently drop half the record."""
    config = dict(_ROLES_CONFIG)
    config["scatter"] = [{"x_column": "umap_x", "y_column": "umap_x", "label": "Diagonal"}]
    roles = ColumnRoles.from_config(config)
    result = worker._PLUGINS["scatter"]().compute(_meta(), roles, _atlas(), {})

    assert result.source_columns == ("umap_x",)
    assert set(result.source_fingerprint) == {"umap_x"}
    assert set(result.source_fingerprint["umap_x"]) == {
        ("scatter", "x", "umap_x", "linear", "linear", "fit", "overdraw"),
        ("scatter", "y", "umap_x", "linear", "linear", "fit", "overdraw"),
    }
    # ...and it survives the emitter as a JSON array of two arrays.
    entry = _layout_entry(result, _fake_pyramid())
    assert len(entry["source_fingerprint"]["umap_x"]) == 2


def test_layout_entry_emits_source_fingerprint_unconditionally_including_empty() -> None:
    """The always-emit rule again, one minor on: `{}` must be WRITTEN, because `{}` means
    "this layout reads no column, so there is no way of reading to record" while an ABSENT
    key means "this entry predates 2.10". Omitting at empty would make grid — the one
    layout that is genuinely, permanently fresh — indistinguishable from the oldest bake in
    the tree, which is the one entry nothing may call fresh."""
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    empty = _layout_entry(
        LayoutResult("grid", "grid", "Grid", cells, (0.0, 0.0, 1.0, 1.0), None),
        _fake_pyramid(),
    )
    assert empty["source_fingerprint"] == {}
    filled = _layout_entry(
        LayoutResult(
            "datetime", "datetime", "By date", cells, (0.0, 0.0, 1.0, 1.0), None,
            source_columns=("when_shot",),
            source_fingerprint={"when_shot": (("datetime", "unix_seconds"),)},
        ),
        _fake_pyramid(),
    )
    # JSON arrays, not tuples — and a LIST of them, because one column can carry two.
    assert filled["source_fingerprint"] == {"when_shot": [["datetime", "unix_seconds"]]}


def test_the_schema_accepts_an_empty_object_and_rejects_a_malformed_record() -> None:
    validator = jsonschema.Draft202012Validator(_manifest_schema())
    _validate_manifest(_manifest_with({"source_fingerprint": {}}))
    _validate_manifest(_manifest_with({"source_fingerprint": {"a": [["categorical"]]}}))
    _validate_manifest(  # a self-pair: one key, two tuples
        _manifest_with({"source_fingerprint": {"a": [["scatter", "x", "a"], ["scatter", "y", "a"]]}})
    )
    with pytest.raises(jsonschema.ValidationError):  # a bare tuple, not a list of them
        validator.validate(_manifest_with({"source_fingerprint": {"a": ["categorical"]}}))
    with pytest.raises(jsonschema.ValidationError):  # an empty tuple says nothing
        validator.validate(_manifest_with({"source_fingerprint": {"a": [[]]}}))
    with pytest.raises(jsonschema.ValidationError):  # a column with no tuple at all
        validator.validate(_manifest_with({"source_fingerprint": {"a": []}}))
    with pytest.raises(jsonschema.ValidationError):  # the same tuple twice
        validator.validate(
            _manifest_with({"source_fingerprint": {"a": [["categorical"], ["categorical"]]}})
        )


def test_a_pre_210_entry_without_source_fingerprint_still_validates() -> None:
    """The only reason the field is optional: `append_manifest_layouts` carries pre-2.10
    entries forward byte-preserved under a re-stamped version. Which is also why a reader
    gates on PRESENCE — and why absence is UNCHECKED and never `fresh`."""
    _validate_manifest(_manifest_with({"source_columns": ["a"]}))


def test_a_pre_29_entry_without_source_columns_still_validates() -> None:
    """`append_manifest_layouts` carries prior entries forward byte-preserved under a
    re-stamped version, so an entry with no `source_columns` must stay valid — that is the
    only reason the field is optional in the schema, and it is why a reader gates on
    PRESENCE and never on `manifest_version`."""
    _validate_manifest(_manifest_with({}))


def test_the_schema_accepts_an_empty_list_and_rejects_duplicates() -> None:
    validator = jsonschema.Draft202012Validator(_manifest_schema())
    _validate_manifest(_manifest_with({"source_columns": []}))
    _validate_manifest(_manifest_with({"source_columns": ["a", "b"]}))
    with pytest.raises(jsonschema.ValidationError):
        validator.validate(_manifest_with({"source_columns": ["a", "a"]}))
    with pytest.raises(jsonschema.ValidationError):
        validator.validate(_manifest_with({"source_columns": [""]}))
    with pytest.raises(jsonschema.ValidationError):
        validator.validate(_manifest_with({"source_columns": "a"}))
