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

import copy
import io
import json
import shutil
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


# --- the roles override: the datetime format is fixed at ingest (D-xxxii) ---------------
# `run_add_layouts` validates an override with the same `_validate_roles_against_parquet`
# as `set-roles`, handing it the committed manifest. `_ingest_grid_only` is a real ingest,
# so `date` is stored as the timestamp ingest writes for `iso8601`. The set-roles side is
# pinned, lean, in test_layout_lifecycle.py.


def _override_with_format(fmt: str) -> dict:
    return {**_ROLES, "datetime": {**_ROLES["datetime"], "format": fmt}}


def _commit_before_the_check(output_root: Path, fmt: str, monkeypatch) -> dict:
    """Commit `fmt` through the real `set-roles` as it shipped before D-xxxii's check,
    which accepted every format on a timestamp: how a collection came to hold a committed
    non-ISO format over one. Returns the committed roles."""
    from pipeline import worker
    from pipeline.worker import SetRolesJobPayload, run_set_roles

    with monkeypatch.context() as patched:
        patched.setattr(
            worker, "_TIMESTAMP_DATETIME_FORMATS", frozenset({"iso8601", "unix_seconds", "unix_millis"})
        )
        run_set_roles(
            SetRolesJobPayload(
                dataset_id="ds",
                owner="tester",
                column_roles=_override_with_format(fmt),
                output_root=output_root,
            )
        )
    committed_roles = _read_manifest(output_root / "ds")["column_roles"]
    assert committed_roles["datetime"]["format"] == fmt
    return committed_roles


@pytest.mark.parametrize("fmt", ["unix_millis", "unix_seconds"])
def test_add_layouts_override_refuses_a_non_iso_format_on_a_stored_timestamp(
    tmp_path: Path, fmt: str
) -> None:
    """After ingest a stored timestamp takes `iso8601` only (operator, 2026-09-26). Since
    #391 no format moves a timestamp's dates, so this is policy (D-xxxiii); before it, an
    override setting `unix_millis` baked every date at a thousandth of its value. Refused,
    naming the column, before anything is baked: the manifest is byte-identical and no
    datetime tiles or position table exist."""
    from pipeline.ingest import ColumnRoleError

    images, dataset_dir = _ingest_grid_only(tmp_path)
    assert str(pq.read_schema(dataset_dir / "metadata.parquet").field("date").type) == "timestamp[us]"
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ColumnRoleError, match=r"^date: datetime format is fixed at ingest"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds",
                owner="tester",
                images_dir=images,
                layout_specs=["datetime"],
                output_root=tmp_path / "out",
                column_roles=_override_with_format(fmt),
            )
        )
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before
    assert not (dataset_dir / "tiles" / "datetime").exists()
    assert not list(dataset_dir.glob("positions/datetime_*"))


def test_add_layouts_override_accepts_the_committed_format_and_a_put_back_to_iso8601(
    tmp_path: Path, monkeypatch
) -> None:
    """The committed format is always accepted, and `iso8601` always is. The collection
    holds a committed `unix_millis` over its timestamp, reached through the real
    `set-roles` as it shipped before D-xxxii's check (it accepted every format there).
    Re-sending those committed roles unchanged rides a bake that does not read the date.
    Putting the format back to `iso8601` then bakes the datetime layout at its true dates."""
    images, dataset_dir = _ingest_grid_only(tmp_path)
    output_root = tmp_path / "out"
    committed_roles = _commit_before_the_check(output_root, "unix_millis", monkeypatch)

    resent = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["categorical"],
            output_root=output_root,
            column_roles=committed_roles,
        )
    )
    assert resent["committed"] == ["categorical_category", "categorical_place"]

    put_back = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=output_root,
            column_roles=_override_with_format("iso8601"),
        )
    )
    assert put_back["committed"] == ["datetime"]
    manifest = _read_manifest(dataset_dir)
    assert manifest["column_roles"]["datetime"]["format"] == "iso8601"
    # `_write_metadata_csv` dates run 2026-01-01..12: the axis is on them, not in 1970.
    domain = _entry(manifest, "datetime")["annotations"]["axes"][0]["domain"]
    assert domain[0].startswith("2026-01-01"), domain


@pytest.mark.parametrize("override", ["none", "the committed roles"])
def test_add_layouts_bakes_a_committed_unix_millis_timestamp_at_its_true_dates(
    tmp_path: Path, monkeypatch, override: str
) -> None:
    """Review finding 1 on #391, reversed by its plugin fix. A collection holds a
    committed `unix_millis` over its stored timestamp (written by `set-roles` before
    D-xxxii's check). A datetime bake then reads the committed format: with no override,
    or with the committed roles re-sent, as the designer does when D-xxix pre-queues a
    re-bake. The committed-format exemption lets both through, and before the plugin fix
    both baked the axis on 1970-01-21. Now the bake lands on the true dates, and the
    committed format is kept."""
    images, dataset_dir = _ingest_grid_only(tmp_path)
    output_root = tmp_path / "out"
    committed_roles = _commit_before_the_check(output_root, "unix_millis", monkeypatch)

    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=output_root,
            column_roles=None if override == "none" else committed_roles,
        )
    )

    assert result["committed"] == ["datetime"]
    manifest = _read_manifest(dataset_dir)
    assert manifest["column_roles"]["datetime"]["format"] == "unix_millis"
    # `_write_metadata_csv` dates run 2026-01-01..12.
    domain = _entry(manifest, "datetime")["annotations"]["axes"][0]["domain"]
    assert domain[0].startswith("2026-01-01") and domain[1].startswith("2026-01-12"), domain


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


def _durably_stale(manifest: dict) -> list[str]:
    """L7's per-entry rule, read off the committed manifest ALONE — the answer the
    designer's ``derived.baked`` gives on a freshly loaded screen: a layout whose recorded
    ``source_fingerprint`` is not what any committed role entry over its ``source_columns``
    declares. Built from the worker's own readers, so it cannot drift from them. (No
    duplicate counting: no manifest here declares a pair twice.)"""
    from pipeline.worker import (
        ColumnRoles,
        _comparable_fingerprint,
        _entry_fingerprints_by_source_columns,
        _recorded_fingerprint,
    )

    declared = _entry_fingerprints_by_source_columns(ColumnRoles.from_config(manifest["column_roles"]))
    stale: list[str] = []
    for entry in manifest["layouts"]:
        recorded = _recorded_fingerprint(entry)
        if recorded is None or not entry.get("source_columns"):
            continue
        candidates = declared.get((entry["type"], tuple(entry["source_columns"])), [])
        if recorded not in [_comparable_fingerprint(c) for c in candidates]:
            stale.append(entry["layout_id"])
    return stale


def test_add_layouts_override_may_change_a_FINGERPRINTED_scatter_knob_beside_another_bake(
    tmp_path: Path,
) -> None:
    """LAYOUT_DESIGNER D-xxx. Until then `_guard_no_stale_scatter_config` refused this run —
    a roles override that changes a committed scatter pair's knobs, riding a bake that does
    not re-bake the scatter — because the manifest would contradict the baked positions and
    nothing would ever say so. The same edit alone (`set-roles`) was accepted and left the
    layout stale, so one edit was legal or not by what else rode the commit
    ([[T2-an-unticked-knob-change-cannot-ride-a-bake-run]]).

    A layout baked since manifest 2.10 DOES say so: its `source_fingerprint` records the
    knobs it was baked with. So the run is accepted, the scatter is carried untouched, and
    afterwards it reads STALE from the manifest alone. (Every fresh ingest is 2.10, so this
    is the real producer's output; the pre-2.10 refusal is pinned in
    test_knob_guard_fingerprint.py.)"""
    import csv as _csv

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
    scatter_before = json.loads(json.dumps(_entry(before, "scatter")))  # deep snapshot
    assert isinstance(scatter_before.get("source_fingerprint"), dict), (
        "premise: a 2.10 bake records how it read its columns"
    )
    assert _durably_stale(before) == [], "premise: nothing is stale before the run"

    # Strictly-positive columns => 'log' passes the VALUE gate, so only the staleness
    # guard could refuse it — and for a fingerprinted layout it no longer does.
    override = {
        "filename": {"column": "filename", "label": "Filename"},
        "scatter": [
            {"x_column": "x", "y_column": "y", "label": "XY",
             "x_scale": "log", "y_scale": "log"}
        ],
        "categorical": [{"column": "kind", "label": "Kind"}],
    }
    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds", owner="tester", images_dir=images,
            layout_specs=["categorical"], output_root=output_root,
            column_roles=override,
        )
    )

    assert result["committed"] == ["categorical"]
    assert result["replaced"] == []
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["column_roles"]["scatter"][0]["x_scale"] == "log", "the override landed"
    # NOT re-baked: the entry is carried whole — its record still says linear...
    assert _entry(manifest, "scatter") == scatter_before
    # ...so the committed manifest now says, by itself and for good, that it is stale.
    assert _durably_stale(manifest) == ["scatter"]


def test_add_layouts_override_may_change_a_FINGERPRINTED_geographic_projection_beside_another_bake(
    tmp_path: Path,
) -> None:
    """The geographic twin of the test above (D-xxx narrows `_guard_no_stale_geographic_config`
    the same way): a projection change on a map baked since 2.10 rides another bake, the map
    is carried untouched, and the manifest then reports it stale."""
    import csv as _csv

    names = _image_names(8)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = tmp_path / "meta.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = _csv.writer(handle)
        writer.writerow(["filename", "lon", "lat", "kind"])
        for i, name in enumerate(names):
            # Degrees, |lat| far inside Web Mercator's 85.05, so 'mercator' passes the
            # VALUE gate and only the staleness guard could refuse it.
            writer.writerow([name, str(-20.0 + i), str(10.0 + i), "ab"[i % 2]])
    roles = {
        "filename": {"column": "filename", "label": "Filename"},
        "geographic": [{"lon_column": "lon", "lat_column": "lat", "label": "Where"}],
        "freeform": [{"column": "kind", "label": "Kind"}],
    }
    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds", owner="tester", images_dir=images, csv_path=csv_path,
            column_roles=roles, layout_types=["grid", "geographic"], output_root=output_root,
        )
    )
    dataset_dir = output_root / "ds"
    before = _read_manifest(dataset_dir)
    geographic_before = json.loads(json.dumps(_entry(before, "geographic")))
    assert isinstance(geographic_before.get("source_fingerprint"), dict), (
        "premise: a 2.10 bake records how it read its columns"
    )
    assert _durably_stale(before) == [], "premise: nothing is stale before the run"

    override = {
        "filename": {"column": "filename", "label": "Filename"},
        "geographic": [
            {"lon_column": "lon", "lat_column": "lat", "label": "Where", "projection": "mercator"}
        ],
        "categorical": [{"column": "kind", "label": "Kind"}],
    }
    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds", owner="tester", images_dir=images,
            layout_specs=["categorical"], output_root=output_root,
            column_roles=override,
        )
    )

    assert result["committed"] == ["categorical"]
    assert result["replaced"] == []
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    assert manifest["column_roles"]["geographic"][0]["projection"] == "mercator"
    assert _entry(manifest, "geographic") == geographic_before
    assert _durably_stale(manifest) == ["geographic"]


# --- --replace: re-bake a committed layout in place (seam L2) ------------------------
#
# [[T2-add-layouts-cannot-replace-a-committed-layout]]. Until now the only path to a
# corrected layout was a full re-ingest of every image, because `_guard_no_collision`
# refused any committed layout_id. --replace narrows that guard PER ID; it does not
# soften it, and the default with no --replace is pinned unchanged below.


def _ingest_several_layouts(tmp_path: Path, n: int = 12) -> tuple[Path, Path]:
    """Ingest with grid + datetime + BOTH categorical layouts, so a replace target
    (`datetime`) sits in the MIDDLE of the committed layouts list. Returns
    (images_dir, dataset_dir)."""
    names = _image_names(n)
    images = tmp_path / "images"
    _build_images(images, names)
    csv_path = _write_metadata_csv(tmp_path / "meta.csv", names)
    output_root = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=csv_path,
            column_roles=_ROLES,
            layout_types=["grid", "datetime", "categorical"],
            output_root=output_root,
        )
    )
    return images, output_root / "ds"


def test_add_layouts_replace_rebakes_in_place_and_sweeps_the_superseded_version(
    tmp_path: Path,
) -> None:
    """The whole verb in one spec. `datetime` is re-baked over itself: the layout_id and
    its POSITION in the switcher survive, the entry now points at the fresh `_v2` assets,
    the superseded `_v1` container and position table are swept, and every sibling layout
    is carried through byte-identical with its own `_v1` assets intact."""
    images, dataset_dir = _ingest_several_layouts(tmp_path)
    before = _read_manifest(dataset_dir)
    before_ids = [lv["layout_id"] for lv in before["layouts"]]
    assert before_ids.index("datetime") != len(before_ids) - 1, (
        "premise: the replace target must NOT already be last, or 'in place' and "
        "'appended' would be the same list and this spec would prove nothing"
    )
    siblings_before = {
        lid: json.loads(json.dumps(_entry(before, lid)))
        for lid in before_ids
        if lid != "datetime"
    }
    meta_before = (dataset_dir / "metadata.parquet").read_bytes()
    assert (dataset_dir / "tiles" / "datetime" / "datetime_v1.pmtiles").is_file()
    assert (dataset_dir / "positions" / "datetime_v1.arrow").is_file()

    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            layout_specs=["datetime"],
            output_root=tmp_path / "out",
            replace=("datetime",),
        )
    )

    assert result["committed"] == ["datetime"]
    assert result["replaced"] == ["datetime"]
    assert result["dataset_version"] == "2"

    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    # IN PLACE: same ids, same ORDER, no duplicate entry. Order is the switcher order and
    # the fallback a dangling presentation `default_layout` resolves to (D-xvi), so a
    # re-bake must not reshuffle it.
    assert [lv["layout_id"] for lv in manifest["layouts"]] == before_ids

    dt = _entry(manifest, "datetime")
    assert dt["pyramid"]["path"] == "tiles/datetime/datetime_v2.pmtiles"
    assert (dataset_dir / dt["pyramid"]["path"]).is_file()
    assert dt["positions_ref"] == "positions/datetime_v2.arrow"
    assert (dataset_dir / dt["positions_ref"]).is_file()

    # SWEPT — after the flip, and only this layout's superseded version.
    assert not (dataset_dir / "tiles" / "datetime" / "datetime_v1.pmtiles").exists()
    assert not (dataset_dir / "positions" / "datetime_v1.arrow").exists()
    assert (dataset_dir / "tiles" / "datetime").is_dir(), (
        "the dir still holds the fresh container, so unlike delete-layout it must stay"
    )

    # Every sibling is byte-identical and still owns its v1 assets: a replace of ONE
    # layout must not reach outside itself, which is why the sweep is scoped rather than
    # the re-ingest's global prune.
    for lid, entry in siblings_before.items():
        assert _entry(manifest, lid) == entry
        assert (dataset_dir / entry["pyramid"]["path"]).is_file()
        assert (dataset_dir / entry["positions_ref"]).is_file()
    assert (dataset_dir / "metadata.parquet").read_bytes() == meta_before
    assert (dataset_dir / "detail" / "v1").is_dir(), "the detail tier is reused, never swept"


def test_add_layouts_without_replace_still_refuses_every_collision(tmp_path: Path) -> None:
    """The DEFAULT is unchanged, pinned explicitly rather than inferred from the older
    collision test: --replace is a per-id opt-out and never a mode, so a run that does
    not name a layout must still be refused for it. The refusal now also names the
    opt-out, because a guard that cannot say what to do instead is why people hand-edit
    committed trees."""
    images, dataset_dir = _ingest_several_layouts(tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ValueError, match=r"--replace datetime"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["datetime"], output_root=tmp_path / "out",
            )
        )
    # ...and naming a DIFFERENT layout does not licence this one.
    with pytest.raises(ValueError, match="already exist"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["datetime", "categorical_category"],
                output_root=tmp_path / "out",
                replace=("categorical_category",),
            )
        )
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before
    assert not list(dataset_dir.glob("tiles/*/*_v2.pmtiles"))


def test_add_layouts_replace_refuses_a_target_it_cannot_honour(tmp_path: Path) -> None:
    """Both mistakes are refused rather than silently degraded. `--replace scater` (a
    typo) must not become a plain append, and `--replace X` without `--layout X` must not
    become a no-op — the first overwrites nothing while claiming to, the second bakes
    nothing while claiming to."""
    images, dataset_dir = _ingest_several_layouts(tmp_path)
    before = (dataset_dir / "layout_manifest.json").read_bytes()

    with pytest.raises(ValueError, match="not committed in this dataset"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["datetime"], output_root=tmp_path / "out",
                replace=("datetim",),
            )
        )
    with pytest.raises(ValueError, match="not requested with --layout"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id="ds", owner="tester", images_dir=images,
                layout_specs=["categorical_category"], output_root=tmp_path / "out",
                replace=("datetime",),
            )
        )
    assert (dataset_dir / "layout_manifest.json").read_bytes() == before


def test_add_layouts_replace_is_the_way_to_change_an_UNFINGERPRINTED_layout_knob(
    tmp_path: Path,
) -> None:
    """The motivating case, and the exemption that makes it work.

    The stale-knob guards refuse a roles override that changes a committed pair's knobs
    when the run does not re-bake the pair's layout and that layout records no
    ``source_fingerprint``: the manifest would then contradict its baked positions and
    their ``options`` echo with nothing to say so. ``--replace`` re-bakes it, so for that
    id there is nothing left to contradict and the guard must stand down (the
    ``existing_ids - replacing`` at the ``run_add_layouts`` call site). Without the
    exemption the refusal's own advice ('pass --replace') would be a lie, and a pre-2.10
    layout's knobs could only change by a re-ingest.

    WHY A 2.9 TREE, AND THE MAP. Since D-xxx the guards stand down for a layout that
    records a fingerprint, and a fresh ingest records one for every layout, so on a fresh
    ingest this run passes with or without the exemption: an earlier version of this test
    built on one and stayed green with the exemption removed (review of #392, finding 2).
    So the tree is the committed golden fixture carrying the real producer's 2.9 manifest
    (``packages/frontend/tests/designer_fixture/layout_manifest_2.9.json``: provenance, no
    fingerprint). The knob is the geographic projection because it is the one this tree's
    data lets through the VALUE gate: ``lat`` spans [-78.0, 78.0], inside Web Mercator's
    85.05°, while every non-default scatter knob fails that gate before any guard runs
    (measured in test_knob_guard_fingerprint.py)."""
    from pipeline.ingest import ColumnRoleError

    golden = REPO_ROOT / "tests" / "fixtures" / "golden_dataset_full_v2"
    output_root = tmp_path / "datasets"
    dataset_dir = output_root / golden.name
    shutil.copytree(golden, dataset_dir)
    shutil.copyfile(
        REPO_ROOT / "packages" / "frontend" / "tests" / "designer_fixture" / "layout_manifest_2.9.json",
        dataset_dir / "layout_manifest.json",
    )
    before = _read_manifest(dataset_dir)
    assert "source_fingerprint" not in _entry(before, "geographic"), "premise: a pre-2.10 map"
    assert _entry(before, "geographic")["options"]["projection"] == "equirectangular"

    # The originals, under the committed parquet's own filenames: add-layouts re-decodes
    # them, and its id-integrity guard matches them to the committed cells by name.
    filenames = pq.read_table(dataset_dir / "metadata.parquet", columns=["filename"])
    images = tmp_path / "images"
    images.mkdir()
    for i, name in enumerate(filenames.column("filename").to_pylist()):
        rgb = [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256]
        image = (pyvips.Image.black(16, 16, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
        image.pngsave(str(images / name))

    override = copy.deepcopy(before["column_roles"])
    override["geographic"][0]["projection"] = "mercator"

    # Premise: WITHOUT re-baking the map, this override is refused on this tree.
    with pytest.raises(ColumnRoleError, match="committed geographic layout 'geographic'"):
        run_add_layouts(
            AddLayoutsJobPayload(
                dataset_id=golden.name, owner="tester", images_dir=images,
                layout_specs=["datetime"], output_root=output_root,
                column_roles=override, replace=("datetime",),
            )
        )
    assert _read_manifest(dataset_dir) == before

    result = run_add_layouts(
        AddLayoutsJobPayload(
            dataset_id=golden.name, owner="tester", images_dir=images,
            layout_specs=["geographic"], output_root=output_root,
            column_roles=override, replace=("geographic",),
        )
    )

    assert result["replaced"] == ["geographic"]
    manifest = _read_manifest(dataset_dir)
    _validate_manifest(manifest)
    # The declared roles and the baked `options` echo now AGREE on the new projection —
    # which is what the stale guard was protecting, and is exactly what a replace restores.
    assert manifest["column_roles"]["geographic"][0]["projection"] == "mercator"
    geographic = _entry(manifest, "geographic")
    assert geographic["options"]["projection"] == "mercator"
    assert geographic["pyramid"]["path"] == "tiles/geographic/geographic_v2.pmtiles"
    assert not (dataset_dir / "tiles" / "geographic" / "geographic_v1.pmtiles").exists()
    # ...and the re-bake records how it read its columns, so from here on the map reports
    # its own staleness and the guard stands down for it.
    assert isinstance(geographic.get("source_fingerprint"), dict)
