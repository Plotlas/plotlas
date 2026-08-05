"""Native tests for the STALE VERSION-STAMPED ASSET SWEEP on re-ingest (T2-79).

``worker._commit``/``_move_merge`` deliberately merge-move a re-ingest's fresh
version-stamped assets ALONGSIDE the older-version siblings (the version lives in every
asset path, so new and old never collide and the manifest flip is atomic across
versions). Nothing pruned the superseded ones, so every prior version's
``tiles/{layout}/{layout}_v{N}.pmtiles`` + ``tags/tags_v{N}.arrow`` — and, since
schema v2.2 (#118), ``positions/{layout}_v{N}.arrow`` position tables, the third asset
class sharing the same lifecycle — stayed on disk forever: the disk-growth cousin of
the detail-tier orphaning #102 fixed.

``run_ingest`` now sweeps them AFTER the base-manifest flip, inside the commit lock,
mirroring ``_sweep_stale_detail``. The kept versions are derived from the JUST-FLIPPED
manifest's ACTUAL asset paths (NOT a blanket ``N != current_version``), so a
mixed-version tree left by a prior ``add-layouts`` (a layout added later carries a
higher version than the base ingest) prunes correctly to whatever the live manifest
references. ``run_add_layouts`` NEVER sweeps.

The four load-bearing behaviours (each asserted across ALL THREE asset classes —
pyramids, the tag sidecar, and the per-layout position tables):
  1. re-ingest sweeps the OLD version's pyramid + tag sidecar + position tables,
     keeps the new ones;
  2. mixed-version (ingest v1 -> add-layouts v2 -> re-ingest v3): everything the v3
     manifest references survives, ALL v1/v2 leftovers are gone;
  3. add-layouts ALONE sweeps nothing (v1 base + v2 added assets coexist, both
     manifest-referenced);
  4. a detail_tier="skip" dataset (no detail dir) still sweeps tiles/tags/positions.

(The pure sweep pieces also have lean unit tests over synthetic trees —
``test_stale_sweep_units.py`` — including malformed-manifest tolerance and the
dropped-layout emptied-dir cleanup; these native flows prove the same rules through
the REAL producer.)

NATIVE: needs libvips (pyvips) + pmtiles, so marked ``native`` (selected by
``make test-pipeline -m native``) and skipped in the lean test image via importorskip.
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import jsonschema
import pytest
from referencing import Registry, Resource

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline.worker import (  # noqa: E402
    AddLayoutsJobPayload,
    IngestJobPayload,
    run_add_layouts,
    run_ingest,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "schemas" / "v2"  # the in-force MAJOR contract (D-33)


def _image_names(n: int) -> list[str]:
    return [f"img_{i:03d}.webp" for i in range(n)]


def _build_images(images_dir: Path, names: list[str]) -> None:
    images_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        rgb = [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256]
        image = (pyvips.Image.black(48, 48, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
        image.webpsave(str(images_dir / name))


def _validate_manifest(manifest: dict) -> None:
    schema = json.loads((SCHEMA_DIR / "layout_manifest.schema.json").read_text(encoding="utf-8"))

    def retrieve(uri: str) -> Resource:
        name = uri.rsplit("/", 1)[-1]
        return Resource.from_contents(json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8")))

    jsonschema.Draft202012Validator(
        schema,
        registry=Registry(retrieve=retrieve),
        format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER,
    ).validate(manifest)


def _read_manifest(dataset_dir: Path) -> dict:
    return json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))


def _pmtiles_on_disk(dataset_dir: Path) -> set[str]:
    """Every ``tiles/{layout}/*.pmtiles`` still on disk, as ``{layout}/{name}`` — the
    liveness assertion compares this against what the manifest references."""
    tiles = dataset_dir / "tiles"
    return {
        f"{p.parent.name}/{p.name}"
        for p in tiles.glob("*/*.pmtiles")
    }


def _tags_on_disk(dataset_dir: Path) -> set[str]:
    tags = dataset_dir / "tags"
    if not tags.is_dir():
        return set()
    return {p.name for p in tags.glob("*.arrow")}


def _positions_on_disk(dataset_dir: Path) -> set[str]:
    positions = dataset_dir / "positions"
    if not positions.is_dir():
        return set()
    return {p.name for p in positions.glob("*.arrow")}


def _manifest_referenced_positions(manifest: dict) -> set[str]:
    return {
        Path(lv["positions_ref"]).name
        for lv in manifest["layouts"]
        if lv.get("positions_ref")
    }


def _manifest_referenced_pmtiles(manifest: dict) -> set[str]:
    return {
        f"{Path(lv['pyramid']['path']).parent.name}/{Path(lv['pyramid']['path']).name}"
        for lv in manifest["layouts"]
    }


# The committed dataset for the mixed-version test: metadata with a datetime +
# categorical + tag role, so extra layouts are addable and there is a tag sidecar to
# version. filename is the join key. (Mirrors test_add_layouts.py's fixture shape.)
_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [{"column": "category", "label": "Category"}],
    "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
}
_CATEGORY = ["red"] * 5 + ["blue"] * 4 + ["green"] * 3   # skewed, 12 rows


def _write_metadata_csv(path: Path, names: list[str]) -> Path:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category", "tags"])
        for i, name in enumerate(names):
            date = f"2026-01-{i + 1:02d}"
            tags = "a|b" if i % 2 == 0 else "b|c"
            writer.writerow([name, date, _CATEGORY[i], tags])
    return path


def test_reingest_sweeps_stale_pmtiles_and_tags(tmp_path: Path) -> None:
    """A re-ingest bakes v2 assets and SWEEPS the superseded v1 pyramid + tag sidecar
    + position tables (T2-79) — the version-stamped files nothing pruned before —
    keeping only the new version's. The single-version case: every asset moves to v2,
    so v1 is fully stale."""
    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"

    def _ingest() -> str:
        return run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid", "categorical"],
                output_root=output_root,
            )
        )

    assert _ingest() == "1"
    dataset_dir = output_root / "ds"
    # After v1: grid + categorical pyramids at v1, tags sidecar at v1, and (v2.2) a
    # position table per layout at v1.
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").is_file()
    assert (dataset_dir / "tiles" / "categorical" / "categorical_v1.pmtiles").is_file()
    assert (dataset_dir / "tags" / "tags_v1.arrow").is_file()
    assert (dataset_dir / "positions" / "grid_v1.arrow").is_file()
    assert (dataset_dir / "positions" / "categorical_v1.arrow").is_file()

    # Re-ingest: full replace at v2.
    assert _ingest() == "2"
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["dataset_version"] == 2

    # Every v1 pyramid + the v1 tag sidecar + the v1 position tables were SWEPT;
    # only v2 remains.
    assert not (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").exists()
    assert not (dataset_dir / "tiles" / "categorical" / "categorical_v1.pmtiles").exists()
    assert not (dataset_dir / "tags" / "tags_v1.arrow").exists()
    assert not (dataset_dir / "positions" / "grid_v1.arrow").exists()
    assert not (dataset_dir / "positions" / "categorical_v1.arrow").exists()
    assert (dataset_dir / "tiles" / "grid" / "grid_v2.pmtiles").is_file()
    assert (dataset_dir / "tiles" / "categorical" / "categorical_v2.pmtiles").is_file()
    assert (dataset_dir / "tags" / "tags_v2.arrow").is_file()
    assert (dataset_dir / "positions" / "grid_v2.arrow").is_file()
    assert (dataset_dir / "positions" / "categorical_v2.arrow").is_file()

    # On-disk == manifest-referenced (the liveness invariant): nothing stale lingers,
    # nothing live was removed.
    assert _pmtiles_on_disk(dataset_dir) == _manifest_referenced_pmtiles(manifest)
    assert _tags_on_disk(dataset_dir) == {Path(manifest["tags"]["path"]).name}
    assert _positions_on_disk(dataset_dir) == _manifest_referenced_positions(manifest)


def test_reingest_replaces_cover_but_sweep_never_touches_it(tmp_path: Path) -> None:
    """The UNVERSIONED Library-card cover.webp (T2-55) is REPLACED by a re-ingest (a
    full replace stamps a fresh grid pyramid, whose z=0 tile is re-copied out) yet is
    NEVER caught by either stale-asset sweep. The cover is deliberately not `_v{N}`-
    stamped and lives at the DATASET ROOT (not under tiles/tags/positions), so the
    anchored version regexes never match it and the sweeps never even scan its dir —
    this is the sweep-adjacency guard for the cover's coexistence with #102/#116/#118."""
    from pipeline.tiler import read_overview_webp

    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    def _ingest() -> str:
        return run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid", "categorical"],
                output_root=output_root,
            )
        )

    def _grid_z0_webp() -> bytes:
        manifest = _read_manifest(dataset_dir)
        grid = next(lv for lv in manifest["layouts"] if lv["layout_id"] == "grid")
        pyr = grid["pyramid"]
        webp = read_overview_webp(dataset_dir / pyr["path"], pyr["z_cap"])
        assert webp is not None
        return webp

    assert _ingest() == "1"
    cover = dataset_dir / "cover.webp"
    # The cover exists after the base commit and IS the grid pyramid's z=0 overview.
    assert cover.is_file(), "ingest did not write the library-card cover"
    assert cover.read_bytes()[:4] == b"RIFF", "cover is not a WebP"
    assert cover.read_bytes() == _grid_z0_webp(), "cover != the grid z=0 overview bytes"
    # No stray temp left behind by the atomic write.
    assert not (dataset_dir / "cover.webp.tmp").exists()

    # Re-ingest (full replace at v2): the cover is REPLACED with the new grid z=0 tile,
    # and every stale versioned asset was swept — but the cover itself survived (it is
    # not versioned, so no sweep regex matches it).
    assert _ingest() == "2"
    manifest = _read_manifest(dataset_dir)
    assert manifest["dataset_version"] == 2
    assert not (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").exists()  # sweep ran
    assert cover.is_file(), "the re-ingest sweep wrongly removed the unversioned cover"
    assert cover.read_bytes() == _grid_z0_webp(), "cover not refreshed to the v2 grid z=0 overview"


def test_reingest_after_add_layouts_prunes_mixed_versions(tmp_path: Path) -> None:
    """The MIXED-VERSION case — the correctness heart of T2-79. Ingest v1 (grid), then
    add-layouts appends a categorical at v2 (a legitimate mixed tree: grid_v1 +
    categorical_v2 + tags carried), then a full RE-INGEST bakes everything at v3.

    After the re-ingest, EVERYTHING the v3 manifest references survives and ALL v1/v2
    leftovers (grid_v1, categorical_v2, the v1/v2 tag sidecars) are gone — proving the
    kept set is derived from the live manifest's paths, not ``N != current_version``
    (which would be wrong the instant add-layouts made the tree multi-version)."""
    n = 12
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    # v1: ingest grid ONLY (categorical still addable), WITH metadata so there is a tag
    # sidecar at v1.
    assert (
        run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid"],
                output_root=output_root,
            )
        )
        == "1"
    )
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").is_file()
    assert (dataset_dir / "tags" / "tags_v1.arrow").is_file()
    assert (dataset_dir / "positions" / "grid_v1.arrow").is_file()

    # v2: add-layouts appends categorical at v2. The tree is now MIXED-VERSION —
    # grid_v1 + categorical_v2 both live — and add-layouts must have swept NOTHING.
    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["categorical"],
            output_root=output_root,
        )
    )
    assert result["dataset_version"] == "2"
    assert result["committed"] == ["categorical"]
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").is_file()  # NOT swept
    assert (dataset_dir / "tiles" / "categorical" / "categorical_v2.pmtiles").is_file()
    assert (dataset_dir / "positions" / "grid_v1.arrow").is_file()  # NOT swept
    assert (dataset_dir / "positions" / "categorical_v2.arrow").is_file()
    manifest_v2 = _read_manifest(dataset_dir)
    # The mixed tree is live-consistent: on-disk pmtiles/positions == manifest-referenced.
    assert _pmtiles_on_disk(dataset_dir) == _manifest_referenced_pmtiles(manifest_v2)
    assert _positions_on_disk(dataset_dir) == _manifest_referenced_positions(manifest_v2)

    # v3: full RE-INGEST (grid + categorical). Everything re-bakes at v3; the v1 grid,
    # the v2 categorical, and the v1/v2 tag sidecars are all superseded and swept.
    assert (
        run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid", "categorical"],
                output_root=output_root,
            )
        )
        == "3"
    )
    manifest_v3 = _read_manifest(dataset_dir)
    _validate_manifest(manifest_v3)
    assert manifest_v3["dataset_version"] == 3

    # No v1 or v2 version-stamped leftover survives anywhere under tiles/, tags/,
    # or positions/.
    stale = [
        p
        for p in dataset_dir.glob("tiles/*/*.pmtiles")
        if p.name.endswith(("_v1.pmtiles", "_v2.pmtiles"))
    ] + [
        p
        for p in (dataset_dir / "tags").glob("*.arrow")
        if p.name in ("tags_v1.arrow", "tags_v2.arrow")
    ] + [
        p
        for p in (dataset_dir / "positions").glob("*.arrow")
        if p.name.endswith(("_v1.arrow", "_v2.arrow"))
    ]
    assert not stale, f"mixed-version leftovers not swept: {[p.name for p in stale]}"

    # Everything the v3 manifest references is present on disk (nothing live removed),
    # and nothing else lingers (the liveness invariant, end to end).
    assert _pmtiles_on_disk(dataset_dir) == _manifest_referenced_pmtiles(manifest_v3)
    for lv in manifest_v3["layouts"]:
        assert lv["pyramid"]["path"].endswith("_v3.pmtiles")
        assert (dataset_dir / lv["pyramid"]["path"]).is_file()
        assert lv["positions_ref"].endswith("_v3.arrow")
        assert (dataset_dir / lv["positions_ref"]).is_file()
    assert _tags_on_disk(dataset_dir) == {Path(manifest_v3["tags"]["path"]).name}
    assert Path(manifest_v3["tags"]["path"]).name == "tags_v3.arrow"
    assert _positions_on_disk(dataset_dir) == _manifest_referenced_positions(manifest_v3)


def test_add_layouts_alone_sweeps_nothing(tmp_path: Path) -> None:
    """add-layouts NEVER sweeps: after appending a categorical at v2 onto a grid-v1
    dataset, BOTH the v1 base assets and the v2 added assets are on disk, and BOTH are
    referenced by the merged manifest — the mixed-version tree is fully preserved."""
    n = 12
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    assert (
        run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid"],
                output_root=output_root,
            )
        )
        == "1"
    )
    pmtiles_after_v1 = _pmtiles_on_disk(dataset_dir)
    tags_after_v1 = _tags_on_disk(dataset_dir)
    assert pmtiles_after_v1 == {"grid/grid_v1.pmtiles"}
    assert tags_after_v1 == {"tags_v1.arrow"}

    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["categorical"],
            output_root=output_root,
        )
    )
    assert result["dataset_version"] == "2"
    assert result["committed"] == ["categorical"]

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    # The v1 grid pyramid AND its v1 tag sidecar AND its v1 position table are
    # UNTOUCHED (add-layouts never sweeps), and the v2 categorical is added
    # alongside — both versions manifest-referenced.
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").is_file()
    assert (dataset_dir / "tiles" / "categorical" / "categorical_v2.pmtiles").is_file()
    assert _pmtiles_on_disk(dataset_dir) == {
        "grid/grid_v1.pmtiles",
        "categorical/categorical_v2.pmtiles",
    }
    assert _pmtiles_on_disk(dataset_dir) == _manifest_referenced_pmtiles(manifest)
    # The committed tag sidecar was carried through, not re-versioned or swept.
    assert _tags_on_disk(dataset_dir) == {"tags_v1.arrow"}
    assert Path(manifest["tags"]["path"]).name == "tags_v1.arrow"
    # Mixed-version position tables both live and both referenced (v2.2).
    assert _positions_on_disk(dataset_dir) == {"grid_v1.arrow", "categorical_v2.arrow"}
    assert _positions_on_disk(dataset_dir) == _manifest_referenced_positions(manifest)


def test_reingest_skip_detail_sweeps_tiles_and_tags(tmp_path: Path) -> None:
    """A detail_tier="skip" dataset (no detail/ dir at all) still sweeps stale
    version-stamped tiles + tag sidecars on re-ingest — the tiles/tags sweep is
    independent of the detail tier (it must not assume a detail/ dir exists)."""
    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    def _ingest() -> str:
        return run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=csv_path,
                column_roles=_ROLES,
                layout_types=["grid", "categorical"],
                output_root=output_root,
                detail_tier="skip",
            )
        )

    assert _ingest() == "1"
    # No detail tier at all — the tiles/tags sweep must cope with detail/ absent.
    assert not (dataset_dir / "detail").exists()
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").is_file()
    assert (dataset_dir / "tags" / "tags_v1.arrow").is_file()

    assert _ingest() == "2"
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert not (dataset_dir / "detail").exists()

    # Stale v1 tiles + tag sidecar + position tables swept; only v2 remains; still
    # no detail dir.
    assert not (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").exists()
    assert not (dataset_dir / "tiles" / "categorical" / "categorical_v1.pmtiles").exists()
    assert not (dataset_dir / "tags" / "tags_v1.arrow").exists()
    assert not (dataset_dir / "positions" / "grid_v1.arrow").exists()
    assert _pmtiles_on_disk(dataset_dir) == _manifest_referenced_pmtiles(manifest)
    assert all(name.endswith("_v2.pmtiles") for name in _pmtiles_on_disk(dataset_dir))
    assert _tags_on_disk(dataset_dir) == {"tags_v2.arrow"}
    assert _positions_on_disk(dataset_dir) == _manifest_referenced_positions(manifest)
    assert all(name.endswith("_v2.arrow") for name in _positions_on_disk(dataset_dir))
