"""Native tests for DETAIL-TIER RETENTION — ``--detail-tier retain`` (T2-175).

A re-ingest is a full replace at a fresh ``dataset_version``, which re-transcodes the
whole detail tier even when not one source image changed (measured from rijks_pilot's
own ingest.log, 49,048 images, 2026-07-21: 1 h 55 of a 3 h 40 bake). ``retain`` keeps
the committed tier instead: the new manifest's ``detail`` block points back at the
RETAINED ``detail/v{M}/`` while the dataset commits at ``dataset_version = M+1``.

The pins here deliberately assert THE FILESYSTEM AFTER THE WHOLE COMMIT, not the
manifest. "The manifest says detail/v1/" passes even when the post-flip sweep has just
deleted detail/v1/ — the manifest is correct and the dataset is destroyed. The hazard
is real and one argument wide: ``_sweep_stale_detail`` runs inside the commit lock
AFTER the manifest flip and removes every ``detail/v{N}/`` that is not ``keep_version``,
so a retained bake that passes its own fresh ``dataset_version`` there deletes the tier
it just decided to keep, seconds after going live, and still reports success.

Covered:
  1. survival — after a retained re-ingest every file the fine-tile refs name is still
     readable ON DISK, the manifest points at the retained version, and the
     versioned-detail 404 warning (the operator's only signal) is in ingest.log;
  2. no transcode — ``_bake_detail_tier`` is never called and every original keeps its
     inode + mtime across the retained run;
  3. refusal — a changed image set (a same-COUNT swap, both missing + extra), a dataset
     with no committed detail tier, and a dataset that does not exist at all each REFUSE,
     committing nothing (the committed manifest is byte-identical afterwards);
  4. lifecycle — a later plain ``bake`` sweeps the retained tier normally, so retention
     does not strand version dirs forever;
  5. changed metadata — a re-ingest with a CHANGED CSV over the SAME images keeps the
     tier and lands the new enrichment (retention's primary purpose);
  6. cross-version — retain over an add-layouts manifest (prefix already older than
     dataset_version) keeps detail/v1/ through the post-flip sweep;
  7. partial tier — a committed tier missing one original WARNS and keeps that cell's
     detail_ref null, rather than refusing.

NATIVE: needs libvips (pyvips) + pmtiles, so marked ``native`` (selected by
``make test-pipeline -m native``) and skipped in the lean test image via importorskip.
"""
from __future__ import annotations

import io
import json
from pathlib import Path

import jsonschema
import pyarrow.feather as feather
import pyarrow.parquet as pq
import pytest
from referencing import Registry, Resource

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent
pytest.importorskip("pmtiles")

from pipeline import worker  # noqa: E402
from pipeline.tiler import iter_tiles, unpack_fine_body  # noqa: E402
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


# Metadata for the changed-CSV + add-layouts retain tests: a datetime + categorical +
# tag role over a filename join. Ingested with grid only, so datetime stays ADDABLE and
# there is a detail tier + tag sidecar to reuse. filename is the join key.
_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [{"column": "category", "label": "Category"}],
    "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
}


def _write_metadata_csv(path: Path, names: list[str], *, category: str = "red") -> Path:
    """A tiny metadata CSV joined by filename — every row shares one ``category`` so a
    re-ingest with a different value is an unmistakable enrichment change."""
    import csv

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category", "tags"])
        for i, name in enumerate(names):
            writer.writerow([name, f"2026-01-{i + 1:02d}", category, "a|b"])
    return path


def _ingest(
    images: Path,
    output_root: Path,
    detail_tier: str = "bake",
    *,
    csv_path: Path | None = None,
    column_roles: dict | None = None,
    layout_types: tuple[str, ...] = ("grid",),
) -> str:
    return run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=csv_path,
            column_roles=column_roles,
            layout_types=list(layout_types),
            output_root=output_root,
            detail_tier=detail_tier,  # type: ignore[arg-type]
        )
    )


def _fine_detail_refs(dataset_dir: Path, manifest: dict, layout_id: str) -> dict[int, str]:
    """Every non-null ``detail_ref`` (id -> ref) read out of a layout's fine tiles —
    i.e. what the renderer/API will actually try to resolve."""
    layout = next(lv for lv in manifest["layouts"] if lv["layout_id"] == layout_id)
    pyr = layout["pyramid"]
    fine_levels = [lv for lv in pyr["levels"] if lv["z"] >= pyr["z_cap"]]
    refs: dict[int, str] = {}
    for _z, _x, _y, body in iter_tiles(dataset_dir / pyr["path"], fine_levels):
        _img, arrow_bytes = unpack_fine_body(body)
        table = feather.read_table(io.BytesIO(arrow_bytes))
        for rid, ref in zip(table.column("id").to_pylist(), table.column("detail_ref").to_pylist()):
            if ref is not None:
                refs[int(rid)] = ref
    return refs


def _detail_stat(dataset_dir: Path, version: int) -> dict[str, tuple[int, int, int]]:
    """{filename: (inode, mtime_ns, size)} for every original under detail/v{version}/ —
    the fingerprint a re-transcode necessarily changes (a fresh file gets a new inode)."""
    return {
        p.name: (p.stat().st_ino, p.stat().st_mtime_ns, p.stat().st_size)
        for p in sorted((dataset_dir / "detail" / f"v{version}").glob("*.webp"))
    }


def test_retain_reuses_the_committed_tier_and_it_survives_the_commit(tmp_path: Path) -> None:
    """THE SURVIVAL PIN. After a retained re-ingest the dataset commits at v2 pointing at
    the RETAINED detail/v1/ — and every original the new pyramid's refs name is still
    READABLE ON DISK once the whole commit (merge-move, manifest flip, THEN the stale
    sweeps inside the lock) has finished.

    Asserting the manifest alone would be vacuous: it would pass unchanged if
    ``_sweep_stale_detail`` had just deleted detail/v1/, because the manifest is correct
    and only the dataset is broken. So this reads the bytes."""
    n = 6
    images = tmp_path / "images"
    _build_images(images, _image_names(n))
    output_root = tmp_path / "out"

    assert _ingest(images, output_root) == "1"
    dataset_dir = output_root / "ds"
    assert (dataset_dir / "detail" / "v1").is_dir()

    assert _ingest(images, output_root, detail_tier="retain") == "2"

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)  # still a valid v2 manifest
    assert manifest["dataset_version"] == 2
    assert manifest["dataset_metadata"]["image_count"] == n
    # The manifest points BACK at the retained version (cross-version, as add-layouts
    # already publishes) — not at a detail/v2/ this run never baked.
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v1/"
        assert layout["detail"]["mode"] == "image_ref"
    assert not (dataset_dir / "detail" / "v2").exists(), "retain must transcode no new tier"

    # THE ASSERTION THAT MATTERS: the retained tier is still on disk, and every ref the
    # freshly-baked v2 pyramid emitted resolves to readable bytes.
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    assert set(refs) == set(range(n)), "every surviving cell carried a detail_ref"
    prefix = manifest["layouts"][0]["detail"]["path_prefix"]
    for cell_id, ref in refs.items():
        assert ref == f"{cell_id}.webp"
        original = dataset_dir / prefix / ref
        assert original.is_file(), f"retained original {original} was deleted by the commit"
        assert original.read_bytes(), f"retained original {original} is empty"
    # Only the retained version dir exists under detail/.
    assert sorted(p.name for p in (dataset_dir / "detail").iterdir() if p.is_dir()) == ["v1"]

    # The prefix/dataset_version MISMATCH NOTICE is in the permanent ingest.log (the
    # run logger does not propagate, so caplog cannot see it; read the file).
    #
    # This pin used to require the word "404s", because the warning used to say the
    # click-through lightbox 404s until the API compared the manifest prefix instead
    # of dataset_version. PR #211 (T2-178) made the API do exactly that, so the
    # lightbox works and the old text became false -- but the pin kept it true by
    # assertion for a month. What is DURABLE is that the operator is told about the
    # mismatch at all; whether it is a fault is a fact about the API, not about this
    # log line.
    log_text = (dataset_dir / "ingest.log").read_text(encoding="utf-8")
    assert "manifest detail prefix" in log_text and "dataset_version" in log_text, (
        "the prefix/dataset_version mismatch notice did not reach ingest.log"
    )
    # And it must NOT claim a 404 again: that is the regression this file would
    # otherwise re-admit, since the claim reads plausibly and nothing else checks it.
    assert "404" not in log_text, (
        "the retain notice claims a 404; the versioned detail route resolves through "
        "the manifest prefix since PR #211, so that claim is false"
    )


def test_retain_transcodes_nothing(tmp_path: Path) -> None:
    """THE NO-TRANSCODE PIN, two independent ways: ``_bake_detail_tier`` is asserted
    UNCALLED (monkeypatched to raise), and every original keeps its inode + mtime_ns +
    size across the retained run — which a re-transcode could not do, since it writes a
    fresh file per image. (A timing comparison would not be a pin.)"""
    n = 5
    images = tmp_path / "images"
    _build_images(images, _image_names(n))
    output_root = tmp_path / "out"

    assert _ingest(images, output_root) == "1"
    dataset_dir = output_root / "ds"
    before = _detail_stat(dataset_dir, 1)
    assert len(before) == n

    def _must_not_bake(*args: object, **kwargs: object) -> dict[int, str]:
        raise AssertionError("_bake_detail_tier was called under --detail-tier retain")

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(worker, "_bake_detail_tier", _must_not_bake)
        assert _ingest(images, output_root, detail_tier="retain") == "2"

    assert _detail_stat(dataset_dir, 1) == before, (
        "the retained originals were rewritten (inode/mtime/size changed)"
    )


def test_retain_refuses_a_changed_image_set_and_commits_nothing(tmp_path: Path) -> None:
    """THE REFUSAL PIN. The source dir has one image SWAPPED for a differently-named one
    — SAME count, but one committed image is MISSING and one EXTRA is present — and the
    retained run ABORTS. This is the "shifted corpus re-points cells at other images'
    files" hazard the guard exists for, not a mere count change: both the missing AND the
    extra branch fire. Nothing is committed: the manifest is BYTE-IDENTICAL and
    dataset_version is still 1 afterwards."""
    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"

    assert _ingest(images, output_root) == "1"
    dataset_dir = output_root / "ds"
    manifest_before = (dataset_dir / "layout_manifest.json").read_bytes()
    detail_before = _detail_stat(dataset_dir, 1)

    # A COPY of the source dir with one image SWAPPED for a differently-named one: the
    # count stays n, but one committed image is missing and one extra image is present —
    # a genuine corpus shift, not just a truncation.
    swapped = tmp_path / "images_swapped"
    swapped.mkdir()
    for name in names[:-1]:
        (swapped / name).write_bytes((images / name).read_bytes())
    _build_images(swapped, ["img_extra.webp"])  # the extra, differently-named image

    with pytest.raises(ValueError, match="does not match the committed dataset") as excinfo:
        _ingest(swapped, output_root, detail_tier="retain")
    # Pin that BOTH branches fired (a shift seen as a shift), not just a count mismatch.
    message = str(excinfo.value)
    assert "missing/undecodable" in message
    assert "extra image(s) present" in message

    assert (dataset_dir / "layout_manifest.json").read_bytes() == manifest_before
    assert _read_manifest(dataset_dir)["dataset_version"] == 1
    assert _detail_stat(dataset_dir, 1) == detail_before
    assert not (dataset_dir / "detail" / "v2").exists()


def test_retain_refuses_without_a_committed_detail_tier(tmp_path: Path) -> None:
    """Fail CLOSED, never a silent full transcode: a dataset committed with
    ``detail_tier=skip`` has no tier to retain, so a retained re-ingest REFUSES and
    commits nothing (byte-identical manifest, dataset_version still 1)."""
    images = tmp_path / "images"
    _build_images(images, _image_names(4))
    output_root = tmp_path / "out"

    assert _ingest(images, output_root, detail_tier="skip") == "1"
    dataset_dir = output_root / "ds"
    assert not (dataset_dir / "detail").exists()
    manifest_before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ValueError, match="declares no image_ref detail tier"):
        _ingest(images, output_root, detail_tier="retain")

    assert (dataset_dir / "layout_manifest.json").read_bytes() == manifest_before
    assert _read_manifest(dataset_dir)["dataset_version"] == 1


def test_retain_refuses_when_the_dataset_does_not_exist(tmp_path: Path) -> None:
    """A FIRST bake cannot retain anything. The refusal lands before any work and
    creates no dataset dir at all."""
    images = tmp_path / "images"
    _build_images(images, _image_names(3))
    output_root = tmp_path / "out"

    with pytest.raises(ValueError, match="has no committed manifest"):
        _ingest(images, output_root, detail_tier="retain")

    assert not (output_root / "ds").exists()


def test_bake_after_retain_sweeps_the_retained_tier(tmp_path: Path) -> None:
    """The lifecycle closes: a plain ``bake`` after a retained run transcodes detail/v3/
    and sweeps the (now unreferenced) retained detail/v1/, so retention does not strand
    version dirs forever. This also pins that ``bake`` still sweeps — the sweep's
    keep-version is derived from the flipped manifest's prefix, and for a bake that is
    the fresh dataset_version exactly as before."""
    n = 4
    images = tmp_path / "images"
    _build_images(images, _image_names(n))
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    assert _ingest(images, output_root) == "1"
    assert _ingest(images, output_root, detail_tier="retain") == "2"
    assert sorted(p.name for p in (dataset_dir / "detail").iterdir() if p.is_dir()) == ["v1"]

    assert _ingest(images, output_root) == "3"
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v3/"
    assert sorted(p.name for p in (dataset_dir / "detail").iterdir() if p.is_dir()) == ["v3"]
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    assert set(refs) == set(range(n))
    for cell_id, ref in refs.items():
        assert (dataset_dir / "detail" / "v3" / ref).is_file()


def test_retain_over_changed_metadata_reuses_the_tier(tmp_path: Path) -> None:
    """Retention's PRIMARY purpose: a re-ingest that changes only the METADATA over an
    unchanged image set keeps the committed detail tier. The filenames are identical, so
    the id guard passes; the new CSV's enrichment lands in the freshly re-baked
    metadata.parquet while detail/v1/ is reused untouched (nothing re-transcoded)."""
    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    csv_v1 = _write_metadata_csv(tmp_path / "meta_v1.csv", names, category="red")
    assert _ingest(images, output_root, csv_path=csv_v1, column_roles=_ROLES) == "1"
    detail_before = _detail_stat(dataset_dir, 1)

    # Re-ingest with a CHANGED CSV (every category red -> blue) over the SAME images.
    csv_v2 = _write_metadata_csv(tmp_path / "meta_v2.csv", names, category="blue")
    assert (
        _ingest(images, output_root, detail_tier="retain", csv_path=csv_v2, column_roles=_ROLES)
        == "2"
    )

    # The tier was reused byte-for-byte (same inodes) — nothing re-transcoded.
    assert _detail_stat(dataset_dir, 1) == detail_before
    assert not (dataset_dir / "detail" / "v2").exists()

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["dataset_version"] == 2
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v1/"

    # The NEW enrichment is live in the freshly re-baked metadata.parquet.
    meta = pq.read_table(dataset_dir / "metadata.parquet")
    assert set(meta.column("category").to_pylist()) == {"blue"}

    # Every retained original still resolves on disk.
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    assert set(refs) == set(range(n))
    for _cell_id, ref in refs.items():
        assert (dataset_dir / "detail" / "v1" / ref).is_file()


def test_retain_over_an_add_layouts_manifest_keeps_the_cross_version_tier(
    tmp_path: Path,
) -> None:
    """Retain over the CROSS-VERSION state add-layouts already produces (the showcase
    shape T2-178 targets): bake v1 (detail/v1/) -> add-layouts v2 (dataset_version 2 but
    prefix still detail/v1/) -> retain v3. Retain reads a manifest whose prefix already
    differs from its version, must KEEP detail/v1/ through the post-flip sweep, and
    commit v3 with every retained original still on disk."""
    n = 12
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    # v1: grid only, but WITH metadata so datetime is ADDABLE.
    assert _ingest(images, output_root, csv_path=csv_path, column_roles=_ROLES) == "1"
    # v2: add-layouts appends datetime, carrying detail/v1/ forward at dataset_version 2.
    add = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=output_root,
        )
    )
    assert add["dataset_version"] == "2"
    mid = _read_manifest(dataset_dir)
    assert mid["dataset_version"] == 2
    assert all(lv["detail"]["path_prefix"] == "detail/v1/" for lv in mid["layouts"])
    detail_before = _detail_stat(dataset_dir, 1)

    # v3: RETAIN over that already-cross-version manifest.
    assert (
        _ingest(
            images,
            output_root,
            detail_tier="retain",
            csv_path=csv_path,
            column_roles=_ROLES,
            layout_types=("grid", "datetime"),
        )
        == "3"
    )

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["dataset_version"] == 3
    # The retained tier is STILL detail/v1/ and STILL on disk after the post-flip sweep.
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v1/"
    assert _detail_stat(dataset_dir, 1) == detail_before
    assert sorted(p.name for p in (dataset_dir / "detail").iterdir() if p.is_dir()) == ["v1"]
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    assert set(refs) == set(range(n))
    for _cell_id, ref in refs.items():
        assert (dataset_dir / "detail" / "v1" / ref).is_file()


def test_retain_partial_tier_warns_and_keeps_null_refs(tmp_path: Path) -> None:
    """A committed tier missing ONE original (as a bake leaves when an image fails to
    transcode) is retained faithfully: the surviving cell keeps a NULL detail_ref and the
    run WARNS rather than refusing. Reproduced by deleting one committed original before
    retaining — the id guard still passes because the image SET is unchanged."""
    n = 6
    images = tmp_path / "images"
    _build_images(images, _image_names(n))
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    assert _ingest(images, output_root) == "1"
    # Delete cell 2's committed detail original — the tier now covers only 5 of 6 cells,
    # exactly what a decode-failed bake leaves. One file still remains, so the empty-tier
    # pre-check passes and the run proceeds to the partial-tier branch.
    (dataset_dir / "detail" / "v1" / "2.webp").unlink()

    assert _ingest(images, output_root, detail_tier="retain") == "2"

    # The partial-tier WARNING fired (never silent).
    log_text = (dataset_dir / "ingest.log").read_text(encoding="utf-8")
    assert "have NO committed original" in log_text, "the partial-tier warning did not fire"

    # Cell 2 carries NO detail_ref; every other cell does and still resolves on disk.
    manifest = _read_manifest(dataset_dir)
    assert manifest["dataset_version"] == 2
    refs = _fine_detail_refs(dataset_dir, manifest, "grid")
    assert set(refs) == set(range(n)) - {2}
    for _cell_id, ref in refs.items():
        assert (dataset_dir / "detail" / "v1" / ref).is_file()


def _id_to_filename(dataset_dir: Path) -> dict[int, str]:
    """The committed ``(id, filename)`` mapping — the dense id space every layout's
    coordinates AND every ``detail_ref`` are keyed to."""
    table = pq.read_table(dataset_dir / "metadata.parquet", columns=["id", "filename"])
    return {
        int(i): str(f)
        for i, f in zip(table.column("id").to_pylist(), table.column("filename").to_pylist())
    }


def test_retain_over_a_changed_ROLE_SET_keeps_the_id_mapping(tmp_path: Path) -> None:
    """The nasa re-bake's actual shape, and the half
    ``test_retain_over_changed_metadata_reuses_the_tier`` does not reach: that one varies
    a VALUE (category red -> blue) under an unchanged role set. This varies the ROLE SET
    itself — drop one of two categoricals, add a tag role — over byte-identical images.

    THE RISK IS NOT AN ERROR, IT IS A SILENT SWAP. A ``detail_ref`` is keyed by dense id.
    If a metadata change ever shifted the id assignment, retention would happily reuse
    the committed tier and map cell 3's ref onto what is now a different picture — no
    exception, no warning, just the wrong image behind every click. Ids come from a flat
    scan sorted by basename and metadata joins BY filename onto that fixed space (D-25),
    so it should be impossible; this pins it rather than trusting it. The load-bearing
    assertions are the ``(id -> filename)`` map and the ``id -> detail_ref`` map, both
    UNCHANGED across the retained run — not merely that the run succeeded."""
    n = 6
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    output_root = tmp_path / "out"
    dataset_dir = output_root / "ds"

    def write_csv(path: Path, header: str, row: "callable") -> Path:
        path.write_text(
            "\n".join([header, *(row(i, name) for i, name in enumerate(names))]) + "\n",
            encoding="utf-8",
        )
        return path

    # v1: TWO categorical roles (nasa's center + decade) -> the multi-entry naming
    # convention applies, so the layouts are `categorical_center` + `categorical_decade`.
    csv_v1 = write_csv(
        tmp_path / "roles_v1.csv",
        "filename,center,decade",
        lambda i, name: f"{name},{'KSC' if i % 2 else 'JSC'},{'1990s' if i % 2 else '2000s'}",
    )
    assert _ingest(
        images,
        output_root,
        csv_path=csv_v1,
        column_roles={
            "filename": {"column": "filename", "label": "File"},
            "categorical": [
                {"column": "center", "label": "Center"},
                {"column": "decade", "label": "Decade"},
            ],
        },
        layout_types=("grid", "categorical"),
    ) == "1"

    before_manifest = _read_manifest(dataset_dir)
    before_ids = _id_to_filename(dataset_dir)
    before_stat = _detail_stat(dataset_dir, 1)
    before_refs = _fine_detail_refs(dataset_dir, before_manifest, "grid")
    assert {"categorical_center", "categorical_decade"} <= {
        lv["layout_id"] for lv in before_manifest["layouts"]
    }
    assert not before_manifest.get("tags"), "v1 declares no tag role — the sidecar is NEW below"

    # v2: `decade` DROPPED, `center` kept, a tag role ADDED. Images untouched.
    csv_v2 = write_csv(
        tmp_path / "roles_v2.csv",
        "filename,center,keywords",
        lambda i, name: f"{name},{'KSC' if i % 2 else 'JSC'},{'mars|rover' if i % 2 else 'iss'}",
    )
    assert _ingest(
        images,
        output_root,
        detail_tier="retain",
        csv_path=csv_v2,
        column_roles={
            "filename": {"column": "filename", "label": "File"},
            "categorical": [{"column": "center", "label": "Center"}],
            "tag": [{"column": "keywords", "label": "Keywords", "delimiter": "|"}],
        },
        layout_types=("grid", "categorical"),
    ) == "2"

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    layout_ids = {lv["layout_id"] for lv in manifest["layouts"]}

    # 1. The new role set took effect: dropped role gone, tag sidecar newly present.
    assert "categorical_decade" not in layout_ids, "the dropped role's layout must not survive"
    assert manifest.get("tags"), "the added tag role must produce a tags sidecar"
    assert (dataset_dir / manifest["tags"]["path"]).is_file()

    # 2. AND THE SURVIVOR IS RENAMED — `worker._expand_layouts` only applies the
    #    `{name}_{slug}` convention when there is MORE THAN ONE entry, so dropping to a
    #    single categorical reverts it to the bare plugin name. Nothing to do with
    #    retention; it is what dropping a role does. But client state keyed on the old
    #    layout_id (a saved view, a deep link) does not survive it — pinned so the nasa
    #    re-bake makes that a decision rather than a surprise.
    assert "categorical_center" not in layout_ids, "one entry => the suffix is dropped"
    assert "categorical" in layout_ids, f"the surviving role must still bake: {layout_ids}"

    # 3. The tier was retained, not rebuilt.
    for layout in manifest["layouts"]:
        assert layout["detail"]["path_prefix"] == "detail/v1/"
    assert _detail_stat(dataset_dir, 1) == before_stat, "a retained run must not re-transcode"

    # 4. THE LOAD-BEARING ONE: the id space and every detail_ref survived the role change.
    assert _id_to_filename(dataset_dir) == before_ids, (
        "a metadata-only change must not move the dense id space the detail tier is keyed to"
    )
    assert _fine_detail_refs(dataset_dir, manifest, "grid") == before_refs, (
        "the id -> detail_ref mapping must survive a role-set change"
    )
