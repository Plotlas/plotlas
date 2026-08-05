"""LEAN unit tests for the stale-asset sweeps' pure pieces (no native deps — these run
in the lean test image, complementing test_stale_asset_sweep.py's and
test_detail_retention.py's native through-the-real-pipeline flows).

Covered here, cheaply, over synthetic trees/manifests:
  * _manifest_referenced_asset_names collects pyramid paths (keyed by layout dir),
    the tags filename, and every layout's positions_ref (schema v2.2) — and tolerates
    malformed/absent entries without crashing;
  * _sweep_stale_versioned_assets removes ONLY unreferenced `_v{N}`-stamped files
    across tiles/ + tags/ + positions/, leaves non-matching bystanders alone, removes
    a DROPPED layout's emptied tiles dir and an emptied tags//positions/ dir, keeps
    live dirs, and counts reclaimed bytes;
  * missing roots are no-ops;
  * _detail_prefix_version — the T2-46 detail sweep's equivalent "what does the
    just-flipped manifest actually point at" rule, and the one number that decides
    whether a retained detail tier (T2-175) survives its own commit.
"""
from __future__ import annotations

from pathlib import Path

from pipeline.worker import (
    _detail_prefix_version,
    _manifest_referenced_asset_names,
    _sweep_stale_versioned_assets,
)


def _touch(path: Path, size: int = 0) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    return path


def test_referenced_asset_names_collects_pyramids_tags_positions() -> None:
    manifest = {
        "layouts": [
            {
                "layout_id": "grid",
                "pyramid": {"path": "tiles/grid/grid_v3.pmtiles"},
                "positions_ref": "positions/grid_v3.arrow",
            },
            {
                "layout_id": "categorical",
                "pyramid": {"path": "tiles/categorical/categorical_v2.pmtiles"},
                "positions_ref": "positions/categorical_v2.arrow",
            },
        ],
        "tags": {"path": "tags/tags_v3.arrow"},
    }
    pmtiles, tags, positions = _manifest_referenced_asset_names(manifest)
    assert pmtiles == {
        "grid": {"grid_v3.pmtiles"},
        "categorical": {"categorical_v2.pmtiles"},
    }
    assert tags == "tags_v3.arrow"
    assert positions == {"grid_v3.arrow", "categorical_v2.arrow"}


def test_referenced_asset_names_tolerates_malformed_and_absent_entries() -> None:
    manifest = {
        "layouts": [
            {"layout_id": "a", "pyramid": None},  # pyramid not a dict
            {"layout_id": "b", "pyramid": {"path": 7}},  # path not a str
            {"layout_id": "c", "pyramid": {"path": "bare_v1.pmtiles"}},  # no parent dir
            {
                "layout_id": "d",
                "pyramid": {"path": "tiles/d/d_v1.pmtiles"},
                "positions_ref": None,  # explicit null ref (pre-2.2 shape)
            },
            {
                "layout_id": "e",
                "pyramid": {"path": "tiles/e/e_v1.pmtiles"},
                "positions_ref": "",  # empty ref contributes nothing
            },
        ]
    }
    pmtiles, tags, positions = _manifest_referenced_asset_names(manifest)
    assert pmtiles == {"d": {"d_v1.pmtiles"}, "e": {"e_v1.pmtiles"}}
    assert tags is None
    assert positions == set()


def test_detail_prefix_version_reads_the_kept_version_off_the_prefix() -> None:
    """``_sweep_stale_detail``'s ``keep_version`` comes from the JUST-FLIPPED manifest's
    ``detail.path_prefix``, never from the run's fresh dataset_version — under
    ``--detail-tier retain`` (T2-175) those are DIFFERENT numbers, and keeping the fresh
    one deletes the retained tier. None means keep no version dir at all: no tier
    (detail_tier=skip), or a pre-T2-46 flat ``detail/`` prefix that names no version
    (the schema requires only ``mode``, so that shape is still legal)."""
    assert _detail_prefix_version("detail/v1/") == 1
    assert _detail_prefix_version("detail/v2/") == 2
    assert _detail_prefix_version("detail/v17") == 17  # trailing slash is optional
    assert _detail_prefix_version(None) is None          # detail_tier=skip
    assert _detail_prefix_version("detail/") is None     # legacy flat tier
    assert _detail_prefix_version("detail/vNext/") is None


def test_sweep_synthetic_tree_prunes_only_unreferenced_versioned_files(tmp_path: Path) -> None:
    ds = tmp_path / "ds"
    live_grid = _touch(ds / "tiles" / "grid" / "grid_v2.pmtiles", 10)
    stale_grid = _touch(ds / "tiles" / "grid" / "grid_v1.pmtiles", 7)
    # Non `_v{N}`-matching bystander: the sweep must never touch it.
    bystander = _touch(ds / "tiles" / "grid" / "README.txt", 3)
    # A layout DROPPED by this re-ingest (absent from the manifest): its stale file
    # goes AND its emptied dir goes with it.
    stale_dropped = _touch(ds / "tiles" / "old" / "old_v1.pmtiles", 5)
    live_tags = _touch(ds / "tags" / "tags_v2.arrow", 4)
    stale_tags = _touch(ds / "tags" / "tags_v1.arrow", 6)
    live_pos = _touch(ds / "positions" / "grid_v2.arrow", 8)
    stale_pos = _touch(ds / "positions" / "grid_v1.arrow", 9)
    stale_dropped_pos = _touch(ds / "positions" / "old_v1.arrow", 2)

    manifest = {
        "layouts": [
            {
                "layout_id": "grid",
                "pyramid": {"path": "tiles/grid/grid_v2.pmtiles"},
                "positions_ref": "positions/grid_v2.arrow",
            }
        ],
        "tags": {"path": "tags/tags_v2.arrow"},
    }
    swept, swept_bytes = _sweep_stale_versioned_assets(ds, manifest)

    assert live_grid.is_file() and live_tags.is_file() and live_pos.is_file()
    assert bystander.is_file(), "non-versioned names must never be swept"
    for gone in (stale_grid, stale_dropped, stale_tags, stale_pos, stale_dropped_pos):
        assert not gone.exists(), f"stale {gone.name} survived the sweep"
    assert not (ds / "tiles" / "old").exists(), "dropped layout's emptied dir must go"
    assert (ds / "tiles" / "grid").is_dir(), "live layout's dir must stay"
    assert (ds / "tags").is_dir() and (ds / "positions").is_dir()
    assert set(swept) == {stale_grid, stale_dropped, stale_tags, stale_pos, stale_dropped_pos}
    assert swept_bytes == 7 + 5 + 6 + 9 + 2


def test_sweep_no_positions_refs_sweeps_all_positions_and_removes_dir(tmp_path: Path) -> None:
    # A manifest with NO positions_ref anywhere (pre-2.2 shape): every versioned
    # position table is unreferenced -> swept, and the emptied dir is removed.
    ds = tmp_path / "ds"
    _touch(ds / "tiles" / "grid" / "grid_v2.pmtiles")
    _touch(ds / "positions" / "grid_v1.arrow")
    _touch(ds / "positions" / "grid_v2.arrow")
    manifest = {
        "layouts": [{"layout_id": "grid", "pyramid": {"path": "tiles/grid/grid_v2.pmtiles"}}]
    }
    swept, _ = _sweep_stale_versioned_assets(ds, manifest)
    assert {p.name for p in swept} == {"grid_v1.arrow", "grid_v2.arrow"}
    assert not (ds / "positions").exists()


def test_sweep_images_only_reingest_empties_and_removes_tags_dir(tmp_path: Path) -> None:
    ds = tmp_path / "ds"
    _touch(ds / "tiles" / "grid" / "grid_v2.pmtiles")
    _touch(ds / "tags" / "tags_v1.arrow")
    manifest = {
        "layouts": [{"layout_id": "grid", "pyramid": {"path": "tiles/grid/grid_v2.pmtiles"}}]
    }
    swept, _ = _sweep_stale_versioned_assets(ds, manifest)
    assert {p.name for p in swept} == {"tags_v1.arrow"}
    assert not (ds / "tags").exists()


def test_sweep_missing_roots_are_noops(tmp_path: Path) -> None:
    ds = tmp_path / "ds"
    ds.mkdir()
    swept, swept_bytes = _sweep_stale_versioned_assets(ds, {"layouts": []})
    assert swept == []
    assert swept_bytes == 0
