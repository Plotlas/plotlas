"""Native tests for `run_add_layouts` — bake ADDITIONAL layouts onto an already
committed dataset without a full re-ingest (T2-42; the user-added-layouts
prerequisite).

Covers the four load-bearing behaviours:
  1. append / carry-forward — a new layout's v2 pyramid lands, the committed grid
     entry is carried through BYTE-IDENTICAL (its v1 pyramid ref intact), the
     dataset_version bumps, metadata.parquet is untouched, and the new layout's fine
     records reference the EXISTING committed detail originals.
  2. collision guard — re-adding an existing layout errors and changes nothing.
  3. id-integrity guard — an images_dir missing a committed image aborts, committing
     nothing (manifest unchanged).
  4. per-layout commit — when a second requested layout fails mid-run, the first is
     already committed with a valid manifest and the error names the failed one; a
     re-run with the remaining spec resumes.
  5. tags-move guard — a flip that fails AFTER moving the fresh tag sidecar must not
     cascade-fail the remaining layouts' commits (the later flips skip the
     already-performed move instead of retrying it against a gone source).

NATIVE: needs libvips (pyvips) + pmtiles, so marked `native` (selected by
`make test-pipeline -m native`) and skipped in the lean test image via importorskip.
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
        image = (pyvips.Image.black(64, 64, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
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


def _entry(manifest: dict, layout_id: str) -> dict:
    return next(lv for lv in manifest["layouts"] if lv["layout_id"] == layout_id)


# The committed dataset for the append tests: metadata with a datetime + categorical
# + tag role, ingested with grid ONLY, so datetime/categorical are still ADDABLE and
# there is a detail tier + a tag sidecar to reuse. filename is the join key.
_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [
        {"column": "category", "label": "Category"},
        {"column": "place", "label": "Place"},
    ],
    "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
}
_CATEGORY = ["red"] * 5 + ["blue"] * 4 + ["green"] * 3   # skewed, 12 rows
_PLACE = ["indoor" if i % 2 == 0 else "outdoor" for i in range(12)]


def _write_metadata_csv(path: Path, names: list[str]) -> Path:
    import csv

    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category", "place", "tags"])
        for i, name in enumerate(names):
            date = f"2026-01-{i + 1:02d}"
            tags = "a|b" if i % 2 == 0 else "b|c"
            writer.writerow([name, date, _CATEGORY[i], _PLACE[i], tags])
    return path


def _ingest_grid_only(tmp_path: Path, n: int = 12) -> tuple[Path, Path]:
    """Ingest a tiny dataset (grid only, but WITH metadata so datetime/categorical are
    addable later). Returns (images_dir, dataset_dir)."""
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    version = run_ingest(
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
    assert version == "1"
    return images, output_root / "ds"


def test_add_layouts_appends_and_carries_forward(tmp_path: Path) -> None:
    images, dataset_dir = _ingest_grid_only(tmp_path)
    before = _read_manifest(dataset_dir)
    grid_entry_before = json.loads(json.dumps(_entry(before, "grid")))  # deep snapshot
    meta_before = (dataset_dir / "metadata.parquet").read_bytes()
    meta_mtime_before = (dataset_dir / "metadata.parquet").stat().st_mtime_ns

    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=tmp_path / "out",
        )
    )
    assert result["dataset_version"] == "2"
    assert result["committed"] == ["datetime"]
    assert result["failed"] == []

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    # BOTH layouts present; dataset_version bumped.
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {"grid", "datetime"}
    assert manifest["dataset_version"] == 2

    # The committed grid entry is carried through BYTE-IDENTICAL — its v1 pyramid ref
    # (…_v1.pmtiles) is untouched, so the old container keeps resolving.
    assert _entry(manifest, "grid") == grid_entry_before
    assert grid_entry_before["pyramid"]["path"].endswith("_v1.pmtiles")

    # The new layout is version-stamped v2 and its container exists.
    dt = _entry(manifest, "datetime")
    assert dt["pyramid"]["path"] == "tiles/datetime/datetime_v2.pmtiles"
    assert (dataset_dir / dt["pyramid"]["path"]).exists()

    # POSITION TABLE (T2-66/T2-48, v2.2): the ADDED layout gets a fresh version-stamped
    # position table; the CARRIED-FORWARD grid keeps its EXISTING v1 positions_ref (the
    # byte-identical grid-entry assertion above already covers grid — this pins the
    # two explicitly). Added layouts get a table; carried-forward layouts do not re-bake.
    assert dt["positions_ref"] == "positions/datetime_v2.arrow"
    assert (dataset_dir / dt["positions_ref"]).is_file()
    assert grid_entry_before["positions_ref"] == "positions/grid_v1.arrow"
    assert _entry(manifest, "grid")["positions_ref"] == "positions/grid_v1.arrow"
    assert (dataset_dir / "positions" / "grid_v1.arrow").is_file()  # committed, untouched
    # The added table is (x,y,w,h) float32, row-index==id, over the full dense range.
    import pyarrow as pa

    pos = feather.read_table(dataset_dir / dt["positions_ref"])
    assert pos.schema.names == ["x", "y", "w", "h"]
    assert all(pos.schema.field(c).type == pa.float32() for c in ("x", "y", "w", "h"))
    assert pos.num_rows == manifest["dataset_metadata"]["image_count"]

    # metadata.parquet is byte-for-byte untouched (read-only in add-layouts).
    assert (dataset_dir / "metadata.parquet").read_bytes() == meta_before
    assert (dataset_dir / "metadata.parquet").stat().st_mtime_ns == meta_mtime_before

    # The v1 grid pyramid is still on disk (not swept).
    assert (dataset_dir / "tiles" / "grid" / "grid_v1.pmtiles").exists()

    # The new layout's fine records reference the EXISTING committed detail originals
    # (add-layouts never re-transcodes the detail tier).
    assert dt["detail"]["mode"] == "image_ref"
    fmt = dt["detail"]["format"]
    z_cap = dt["pyramid"]["z_cap"]
    fine_levels = [lv for lv in dt["pyramid"]["levels"] if lv["z"] >= z_cap]
    detail_refs: dict[int, str] = {}
    for _z, _x, _y, body in iter_tiles(dataset_dir / dt["pyramid"]["path"], fine_levels):
        _, arrow_bytes = unpack_fine_body(body)
        table = feather.read_table(io.BytesIO(arrow_bytes))
        for rid, ref in zip(table.column("id").to_pylist(), table.column("detail_ref").to_pylist()):
            if ref is not None:
                detail_refs[int(rid)] = ref
    assert detail_refs, "datetime layout carried no detail_ref — the reuse assertion would be vacuous"
    # add-layouts reuses the committed (VERSION-STAMPED, T2-46) detail originals: the
    # new layout's detail.path_prefix points at the ORIGINAL ingest's version dir
    # (detail/v1/), and its files still exist (add-layouts never re-transcodes/sweeps).
    assert dt["detail"]["path_prefix"] == "detail/v1/"
    for rid, ref in detail_refs.items():
        assert ref == f"{rid}.{fmt}"
        assert (dataset_dir / dt["detail"]["path_prefix"] / ref).is_file(), (
            f"detail ref {ref} points at a missing committed original"
        )


def test_add_layouts_leaves_cover_untouched(tmp_path: Path) -> None:
    """add-layouts NEVER re-bakes grid (D-25), so it never re-writes the Library-card
    cover (T2-55): the committed grid pyramid's z=0 tile — and thus cover.webp — is
    byte-identical before and after. This pins the brief's 'leave existing cover
    untouched' contract (the cover write lives only on the base-commit path of
    run_ingest, not run_add_layouts)."""
    images, dataset_dir = _ingest_grid_only(tmp_path)
    cover = dataset_dir / "cover.webp"
    assert cover.is_file(), "the grid ingest did not write a cover"
    cover_before = cover.read_bytes()
    cover_mtime_before = cover.stat().st_mtime_ns

    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=tmp_path / "out",
        )
    )
    assert result["committed"] == ["datetime"]
    # The cover is byte-for-byte untouched (grid did not re-bake, so it was not rewritten).
    assert cover.read_bytes() == cover_before
    assert cover.stat().st_mtime_ns == cover_mtime_before


def test_add_layouts_expands_categorical_family(tmp_path: Path) -> None:
    """A bare `categorical` spec expands to ALL its role entries (two columns ->
    categorical_category + categorical_place), each committed with a v2 pyramid."""
    images, dataset_dir = _ingest_grid_only(tmp_path)
    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["categorical"],
            output_root=tmp_path / "out",
        )
    )
    assert result["committed"] == ["categorical_category", "categorical_place"]
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {
        "grid",
        "categorical_category",
        "categorical_place",
    }
    for layout_id in ("categorical_category", "categorical_place"):
        assert (dataset_dir / "tiles" / layout_id / f"{layout_id}_v2.pmtiles").exists()

    # An expanded id selects exactly that one (add the OTHER family member later).
    result2 = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=tmp_path / "out",
        )
    )
    assert result2["dataset_version"] == "3"  # version keeps climbing per add run
    assert result2["committed"] == ["datetime"]


def test_add_layouts_collision_guard(tmp_path: Path) -> None:
    images, dataset_dir = _ingest_grid_only(tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ValueError, match="already exist"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                layout_specs=["grid"],  # already committed
                output_root=tmp_path / "out",
            )
        )
    # Nothing changed: same manifest bytes, no v2 pyramid dirs.
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before
    assert not list(dataset_dir.glob("tiles/*/*_v2.pmtiles"))


def test_add_layouts_id_integrity_guard(tmp_path: Path) -> None:
    """An images_dir missing one committed image aborts (id sets diverge) — nothing
    is committed and the manifest is unchanged. Guards a live dataset from silent
    coordinate corruption against a mismatched corpus."""
    images, dataset_dir = _ingest_grid_only(tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    # Remove one image from a COPY of the source dir (the committed dataset still
    # expects all 12 cells).
    partial = tmp_path / "images_partial"
    partial.mkdir()
    names = sorted(p.name for p in images.iterdir())
    for name in names[:-1]:  # drop the last image
        (partial / name).write_bytes((images / name).read_bytes())

    with pytest.raises(ValueError, match="does not match the committed dataset"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=partial,
                layout_specs=["datetime"],
                output_root=tmp_path / "out",
            )
        )
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before
    assert not (dataset_dir / "tiles" / "datetime").exists()


def test_add_layouts_per_layout_commit_on_second_failure(tmp_path: Path, monkeypatch) -> None:
    """Per-layout commit (T2-42) + R4 failure isolation: when the SECOND (here last)
    requested layout's bake fails, the FIRST is already committed with a valid
    manifest, the run raises a SUMMARY error naming the failed layout (not the raw
    bake error — R4 catches per layout, continues, then summarises), and a re-run with
    only the remaining spec resumes."""
    images, dataset_dir = _ingest_grid_only(tmp_path)

    # run_add_layouts does `from pipeline.tiler import bake_pyramid` at call time, which
    # reads tiler.bake_pyramid live — so patching the tiler attribute takes effect.
    from pipeline import tiler

    calls: list[str] = []
    real = tiler.bake_pyramid

    def flaky_bake(*args, **kwargs):
        layout_id = kwargs["layout_id"]
        calls.append(layout_id)
        if layout_id == "categorical_place":  # second of the two-entry family
            raise RuntimeError("boom on the second layout")
        return real(*args, **kwargs)

    monkeypatch.setattr(tiler, "bake_pyramid", flaky_bake)

    # R4: the raw "boom" is caught per layout; the run re-raises a SUMMARY naming the
    # failed layout after attempting every requested one.
    with pytest.raises(RuntimeError, match=r"layout\(s\) failed: \['categorical_place'\]"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                layout_specs=["categorical"],  # -> categorical_category then categorical_place
                output_root=tmp_path / "out",
            )
        )
    assert calls == ["categorical_category", "categorical_place"]

    # The first layout committed with a VALID manifest; the second did not land.
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {"grid", "categorical_category"}
    assert manifest["dataset_version"] == 2
    assert (dataset_dir / "tiles" / "categorical_category" / "categorical_category_v2.pmtiles").exists()
    assert not (dataset_dir / "tiles" / "categorical_place").exists()

    # Re-run with the REMAINING spec (the expanded id, since the family now collides
    # on categorical_category) resumes cleanly.
    monkeypatch.setattr(tiler, "bake_pyramid", real)
    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["categorical_place"],
            output_root=tmp_path / "out",
        )
    )
    assert result["committed"] == ["categorical_place"]
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {
        "grid",
        "categorical_category",
        "categorical_place",
    }
    assert manifest["dataset_version"] == 3


def test_add_layouts_commit_failure_after_tags_move_does_not_cascade(
    tmp_path: Path, monkeypatch
) -> None:
    """Tags-move guard: with a FRESH tag sidecar staged (roles override), a manifest
    flip that fails AFTER `_commit_one_layout` already moved the sidecar leaves
    `move_tags=True` armed for the next layout while the staged source is gone — the
    guard must SKIP the re-move (the sidecar already sits at the committed path), so
    the remaining layouts still commit. Without it, every later flip died at the tags
    `_move_merge` (FileNotFoundError) and the whole rest of the run cascade-failed."""
    images, dataset_dir = _ingest_grid_only(tmp_path)

    # `_commit_one_layout` calls the worker module's `append_manifest_layouts` global,
    # so patching it on the worker module takes effect. Fail ONLY the first flip
    # (datetime's) — by then its tiles AND the fresh sidecar have already moved.
    from pipeline import worker

    real_append = worker.append_manifest_layouts
    flips: list[int] = []

    def flaky_append(*args, **kwargs):
        flips.append(1)
        if len(flips) == 1:
            raise RuntimeError("boom on the first manifest flip")
        return real_append(*args, **kwargs)

    monkeypatch.setattr(worker, "append_manifest_layouts", flaky_append)

    # column_roles override ⇒ roles_overridden ⇒ a fresh tags_v2.arrow is staged and
    # move_tags=True on the first flip. want_ids = [datetime, categorical_category,
    # categorical_place].
    with pytest.raises(RuntimeError, match=r"layout\(s\) failed: \['datetime'\]"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                layout_specs=["datetime", "categorical"],
                output_root=tmp_path / "out",
                column_roles=_ROLES,
            )
        )
    assert len(flips) == 3  # every layout REACHED its flip — no cascade abort

    # Both categoricals committed with a VALID manifest despite datetime's flip dying
    # after the tags move; the manifest's tags ref points at the fresh sidecar, which
    # landed at the committed path during the FAILED flip and was not re-moved.
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert {lv["layout_id"] for lv in manifest["layouts"]} == {
        "grid",
        "categorical_category",
        "categorical_place",
    }
    assert manifest["dataset_version"] == 2
    assert manifest["tags"]["path"].endswith("tags_v2.arrow")
    assert (dataset_dir / manifest["tags"]["path"]).is_file()


def test_add_layouts_roles_override_enforces_scatter_knob_preconditions(tmp_path: Path) -> None:
    """The 2026-07-20 G1-review gate: an add-layouts roles OVERRIDE declaring a scatter
    knob must satisfy the SAME preconditions ingest enforces — before the gate, a
    declared 'log' over a non-positive column reached ``math.log`` as an opaque
    ``ValueError: math domain error`` (aborting the whole job outside the per-layout
    isolation), and an unimplemented ``overlap`` baked silently while echoing a false
    ``options`` record into the manifest. The guard rejects with a column-naming
    ``ColumnRoleError`` BEFORE any bake work, committing nothing."""
    import csv as _csv

    from pipeline.ingest import ColumnRoleError

    names = _image_names(8)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = tmp_path / "meta.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = _csv.writer(handle)
        writer.writerow(["filename", "x", "y"])
        for i, name in enumerate(names):
            writer.writerow([name, str(float(i)), str(float(i + 1))])  # x starts at 0.0
    roles = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [{"x_column": "x", "y_column": "y", "label": "XY"}],
    }
    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds", owner="tester", images_dir=images, csv_path=csv_path,
            column_roles=roles, layout_types=["grid"], output_root=output_root,
        )
    )
    dataset_dir = output_root / "ds"
    before = _read_manifest(dataset_dir)

    # A knob-carrying override on a column containing 0.0 -> the parquet gate rejects,
    # naming the column + exact value; the manifest is untouched (nothing committed).
    override = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "x", "y_column": "y", "label": "XY",
             "x_scale": "log", "y_scale": "log"}
        ],
    }
    with pytest.raises(ColumnRoleError) as exc:
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["scatter"], output_root=output_root,
                column_roles=override,
            )
        )
    msg = str(exc.value)
    assert "x:" in msg and "contains 0.0" in msg, msg
    assert _read_manifest(dataset_dir) == before  # nothing committed

    # An unimplemented overlap is likewise rejected up front (never a silent bake).
    override_overlap = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "x", "y_column": "y", "label": "XY", "overlap": "jitter"}
        ],
    }
    with pytest.raises(ColumnRoleError, match="not implemented yet"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["scatter"], output_root=output_root,
                column_roles=override_overlap,
            )
        )
    assert _read_manifest(dataset_dir) == before


def test_add_layouts_override_cannot_change_committed_scatter_knobs(tmp_path: Path) -> None:
    """Round-2 G1-review guard (_guard_no_stale_scatter_config): a roles override
    that changes the KNOBS of an already-committed scatter pair is rejected even when
    the knob values are perfectly VALID for the data — the committed layout is never
    re-baked by add-layouts, so the manifest's column_roles would contradict the
    baked positions and their `options` echo."""
    import csv as _csv

    from pipeline.ingest import ColumnRoleError

    names = _image_names(8)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = tmp_path / "meta.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = _csv.writer(handle)
        writer.writerow(["filename", "x", "y", "kind"])
        for i, name in enumerate(names):
            writer.writerow([name, str(float(i + 1)), str(float(i + 2)), "ab"[i % 2]])
    roles = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [{"x_column": "x", "y_column": "y", "label": "XY"}],
        # `kind` must be a role at INGEST so the column lands in metadata.parquet —
        # the add-layouts override below repoints it to categorical (an override can
        # only reference columns the frozen parquet already carries).
        "freeform": [{"column": "kind", "label": "Kind"}],
    }
    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds", owner="tester", images_dir=images, csv_path=csv_path,
            column_roles=roles, layout_types=["grid", "scatter"], output_root=output_root,
        )
    )
    dataset_dir = output_root / "ds"
    before = _read_manifest(dataset_dir)
    assert "scatter" in {lv["layout_id"] for lv in before["layouts"]}

    # Strictly-positive columns => 'log' would pass the VALUE gate; the STALENESS
    # guard must reject it anyway (the committed scatter bake was linear).
    override = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "x", "y_column": "y", "label": "XY",
             "x_scale": "log", "y_scale": "log"}
        ],
        "categorical": [{"column": "kind", "label": "Kind"}],
    }
    with pytest.raises(ColumnRoleError, match="committed layout 'scatter'"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["categorical"], output_root=output_root,
                column_roles=override,
            )
        )
    assert _read_manifest(dataset_dir) == before  # nothing committed
