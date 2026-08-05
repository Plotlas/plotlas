"""Native tests for the DETAIL-TIER opt-out + version-stamping (T2-46).

The detail tier (T2-26, mode=image_ref) transcodes every surviving original into a
per-image WebP the lightbox/click-through serves. Two changes land here:

  1. OPT-OUT — ``IngestJobPayload.detail_tier == "skip"`` bakes NO detail tier: no
     ``detail/`` dir, no per-layout ``detail`` manifest block, and null cell detail
     refs. The manifest + pyramid still bake and the dataset still renders (the fast
     path for CI/fixture bakes and corpora where originals are not wanted).
  2. VERSION-STAMP + SWEEP — the detail tier bakes under ``detail/v{version}/``
     (mirroring the pyramid/tag version-stamp), and a re-ingest SWEEPS the superseded
     ``detail/v{N}/`` AFTER the manifest flip so re-ingest no longer orphans stale
     originals. The flip-then-sweep ordering keeps an in-flight old-manifest reader
     resolving its version through the window.

NATIVE: needs libvips (pyvips) + pmtiles, so marked ``native`` (selected by
``make test-pipeline -m native``) and skipped in the lean test image via importorskip.
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import jsonschema
import pyarrow.feather as feather
import pytest
from referencing import Registry, Resource

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline.tiler import iter_tiles, unpack_fine_body  # noqa: E402
from pipeline.worker import IngestJobPayload, run_ingest  # noqa: E402

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


def _fine_detail_refs(dataset_dir: Path, manifest: dict, layout_id: str) -> dict[int, str | None]:
    """Every cell's ``detail_ref`` (id -> ref-or-None) read out of a layout's fine
    tiles — so a test can assert the refs are all-null under detail_tier=skip."""
    layout = next(lv for lv in manifest["layouts"] if lv["layout_id"] == layout_id)
    pyr = layout["pyramid"]
    z_cap = pyr["z_cap"]
    fine_levels = [lv for lv in pyr["levels"] if lv["z"] >= z_cap]
    refs: dict[int, str | None] = {}
    for _z, _x, _y, body in iter_tiles(dataset_dir / pyr["path"], fine_levels):
        _img, arrow_bytes = unpack_fine_body(body)
        table = feather.read_table(io.BytesIO(arrow_bytes))
        for rid, ref in zip(table.column("id").to_pylist(), table.column("detail_ref").to_pylist()):
            refs[int(rid)] = ref
    return refs


def test_detail_tier_skip_bakes_no_detail(tmp_path: Path) -> None:
    """detail_tier="skip": NO detail/ dir, NO per-layout `detail` manifest block, and
    every fine-tile cell record carries a NULL detail_ref — but the manifest + pyramid
    still bake and the cells still load (image_count intact, dense ids)."""
    n = 8
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"

    version = run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=None,
            column_roles=None,
            layout_types=["grid"],
            output_root=output_root,
            detail_tier="skip",
        )
    )
    assert version == "1"

    dataset_dir = output_root / "ds"
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)  # still a valid v2 manifest
    assert manifest["dataset_metadata"]["image_count"] == n

    # No detail tier baked at all.
    assert not (dataset_dir / "detail").exists()
    for layout in manifest["layouts"]:
        assert "detail" not in layout, "detail_tier=skip must emit no `detail` manifest block"

    # The pyramid still baked and cells still load (dense ids), just with null refs.
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    assert set(refs) == set(range(n)), "every cell still has a fine-tile record"
    assert all(ref is None for ref in refs.values()), "detail_ref is null under skip"


def test_detail_tier_bake_is_version_stamped(tmp_path: Path) -> None:
    """detail_tier="bake" (the default) writes the tier under the VERSION-STAMPED
    detail/v{version}/ and declares that prefix in the manifest; refs stay `{id}.webp`
    (relative to the prefix, so the API's server-side compose is unchanged)."""
    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"

    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=None,
            column_roles=None,
            layout_types=["grid"],
            output_root=output_root,
        )
    )
    dataset_dir = output_root / "ds"
    manifest = _read_manifest(dataset_dir)

    # On-disk: the originals live under detail/v1/, NOT a flat detail/.
    assert (dataset_dir / "detail" / "v1").is_dir()
    assert not list((dataset_dir / "detail").glob("*.webp")), "no flat (un-versioned) originals"
    files = sorted(p.name for p in (dataset_dir / "detail" / "v1").glob("*.webp"))
    assert files == sorted(f"{i}.webp" for i in range(n))

    # Manifest: path_prefix carries the version; refs are the bare {id}.webp.
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v1/"
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    for rid, ref in refs.items():
        assert ref == f"{rid}.webp"


def test_reingest_sweeps_stale_detail_after_flip(tmp_path: Path) -> None:
    """A re-ingest bakes detail/v2/ and SWEEPS the superseded detail/v1/ (T2-46) — so
    re-ingest no longer orphans stale originals — while the version-stamped PMTiles and
    the metadata are replaced at the fresh version. Only v2 survives under detail/."""
    n = 5
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"

    def _ingest() -> str:
        return run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=None,
                column_roles=None,
                layout_types=["grid"],
                output_root=output_root,
            )
        )

    assert _ingest() == "1"
    dataset_dir = output_root / "ds"
    assert (dataset_dir / "detail" / "v1").is_dir()

    # Re-ingest: full replace at v2.
    assert _ingest() == "2"
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["dataset_version"] == 2

    # The stale v1 detail dir was SWEPT; only v2 remains.
    version_dirs = sorted(p.name for p in (dataset_dir / "detail").iterdir() if p.is_dir())
    assert version_dirs == ["v2"], f"stale detail versions not swept: {version_dirs}"
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v2/"
    files = sorted(p.name for p in (dataset_dir / "detail" / "v2").glob("*.webp"))
    assert files == sorted(f"{i}.webp" for i in range(n))


def test_reingest_skip_sweeps_all_detail(tmp_path: Path) -> None:
    """Re-ingesting with detail_tier="skip" over a dataset that HAD a detail tier
    sweeps the now-orphaned detail/v1/ entirely (the new manifest references no detail
    tier), leaving no stray detail/ dir behind."""
    n = 5
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"

    def _ingest(detail_tier: str) -> str:
        return run_ingest(
            IngestJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                csv_path=None,
                column_roles=None,
                layout_types=["grid"],
                output_root=output_root,
                detail_tier=detail_tier,  # type: ignore[arg-type]
            )
        )

    assert _ingest("bake") == "1"
    dataset_dir = output_root / "ds"
    assert (dataset_dir / "detail" / "v1").is_dir()

    # Re-ingest with skip: the old v1 tier is orphaned (new manifest has no detail) and
    # is swept, including the now-empty detail/ dir.
    assert _ingest("skip") == "2"
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert not (dataset_dir / "detail").exists(), "empty detail/ must be swept under a skip re-ingest"
    for layout in manifest["layouts"]:
        assert "detail" not in layout
