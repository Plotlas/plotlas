"""`presentation.json` — the SECOND record in a dataset directory (D-xv, D-xvi, D-xvii,
D-xviii; INTAKE_REDESIGN §6c), and the pipeline's one obligation towards it: never write it,
never destroy it.

The two files have ONE WRITER EACH. The worker writes `layout_manifest.json` — the
reproducible bake record. The API writes `presentation.json` — the choices a human made about
how the dataset is shown. A bake therefore cannot clobber a display name BY CONSTRUCTION
rather than by locking, which matters because `append_manifest_layouts` builds its output from
the manifest it read when the bake STARTED, so an edit landing mid-bake would be silently lost.

What is pinned here:
  * the schema is fail-SOFT by construction — a `default_layout`, `title_column` or `columns`
    key naming something that does not exist VALIDATES (D-xvi). That is a property of the
    schema, not only a consumer convention, so it is asserted against the schema;
  * every key, and the whole file, is optional;
  * the `url` role is GONE from `column_roles` (D-xvii) and the bake no longer validates it;
  * every publish path leaves an existing `presentation.json` BYTE-IDENTICAL, and creates
    none where there was none.

LEAN (no pyvips/pmtiles). The publish paths are exercised at the function that actually moves
bytes — `worker._commit` for the ingest publish, `worker._commit_one_layout` for the
add-layouts publish, `run_refresh_manifest` end-to-end. The full `run_ingest` /
`run_add_layouts` round trips are pinned natively in test_presentation_preserved_native.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import jsonschema
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import worker
from pipeline.ingest import ColumnRoleError, _validate_columns_present, write_positions_table
from pipeline.layout_plugins.base import ColumnRoles, LayoutResult, build_spatial_cells
from pipeline.manifest import _roles_to_dict, _validate_manifest, write_manifest
from pipeline.worker import run_refresh_manifest

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "schemas" / "v2"

# The bytes an existing presentation.json holds. Deliberately NOT canonical JSON (trailing
# spaces, an odd key order, no trailing newline): the claim is that the bake leaves the file
# ALONE, and a re-serialized-but-equal file would pass a value comparison while failing that.
_EXISTING = (
    '{"presentation_version": "1.0", "dataset": {"display_name": "Rijksmuseum",  \n'
    '  "attribution": "Rijksmuseum, Amsterdam"}}'
)


def _schema() -> dict:
    return json.loads((SCHEMA_DIR / "presentation.schema.json").read_text(encoding="utf-8"))


def _validator() -> jsonschema.Draft202012Validator:
    return jsonschema.Draft202012Validator(_schema())


# --- the schema: optional everywhere, fail-soft by construction -----------------------


def test_the_empty_document_validates() -> None:
    """Every committed dataset predates this file, so absent-file == absent-everything ==
    today's behaviour; `{}` is the same statement written down."""
    _validator().validate({})


def test_a_fully_populated_document_validates() -> None:
    _validator().validate(
        {
            "presentation_version": "1.0",
            "dataset": {
                "display_name": "Rijksmuseum",
                "attribution": "Rijksmuseum, Amsterdam",
                "attribution_url": "https://www.rijksmuseum.nl/",
                "default_layout": "categorical_artist",
                "title_column": "object_title",
            },
            "layouts": {"categorical_artist": {"label": "By artist"}},
            "columns": {
                "object_title": {"label": "Title"},
                "object_url": {"label": "Source", "render": "url"},
                "internal_ref": {"hidden": True},
            },
        }
    )


def test_dangling_references_validate_because_the_file_fails_soft() -> None:
    """D-xvi, and the reason there is deliberately NO cross-file integrity check: a column
    dropped by a metadata update, a layout dropped by a re-bake, and a `default_layout`
    naming neither must all VALIDATE and fall back on read. A schema that could reject them
    would have to read `layout_manifest.json` and `metadata.parquet`, which re-couples exactly
    the two files this design separates. Operator, on the dangling default_layout: 'if it
    disappears it should fallback to the default (e.g. first layout).'"""
    _validator().validate(
        {
            "dataset": {"default_layout": "a-layout-that-was-dropped",
                        "title_column": "a-column-that-was-dropped"},
            "layouts": {"also-gone": {"label": "Ghost"}},
            "columns": {"vanished": {"label": "Gone", "render": "url", "hidden": True}},
        }
    )


@pytest.mark.parametrize(
    "document",
    [
        {"dataset": {"display_name": "x" * 121}},        # DISPLAY_NAME_MAX = 120
        {"dataset": {"attribution": "x" * 201}},         # ATTRIBUTION_MAX = 200
        {"dataset": {"attribution_url": "x" * 501}},     # ATTRIBUTION_URL_MAX = 500
        {"dataset": {"display_name": ""}},               # blank means CLEARED, never stored
        {"dataset": {"unknown_scalar": "x"}},            # a typo must fail on WRITE
        {"columns": {"c": {"render": "email"}}},         # not shipped yet — enum, not free text
        {"columns": {"c": {"hidden": "yes"}}},           # a boolean, not a truthy string
        {"columns": {"": {"label": "x"}}},               # a column name is never empty
        {"layouts": {"not a layout id": {"label": "x"}}},  # layout_id pattern
        {"presentation_version": "2.0"},                 # a major this contract is not
    ],
)
def test_validate_on_write_rejects(document: dict) -> None:
    """Fail-soft is about DANGLING REFERENCES, not about sloppy values. The other half of
    D-xvii's rule — 'correctness becomes validate-on-write plus fall-back-on-read' — is that
    a malformed value is caught at the point it is written, where someone can fix it."""
    with pytest.raises(jsonschema.ValidationError):
        _validator().validate(document)


def test_the_length_caps_transcribe_app_state_rather_than_picking_new_ones() -> None:
    """The three caps are TRANSCRIPTIONS of `api/appstate.py`'s DISPLAY_NAME_MAX /
    ATTRIBUTION_MAX / ATTRIBUTION_URL_MAX, not new picks — so this reads them back off the
    schema and states the numbers, and a future divergence is a visible edit here.
    De-duplicating the two homes belongs to P2-2, which migrates the fields off app-state;
    this seam flags it rather than solving it."""
    scalars = _schema()["$defs"]["datasetPresentation"]["properties"]
    assert scalars["display_name"]["maxLength"] == 120
    assert scalars["attribution"]["maxLength"] == 200
    assert scalars["attribution_url"]["maxLength"] == 500


# --- D-xvii: `url` has left column_roles ---------------------------------------------


def test_column_roles_rejects_the_removed_url_role() -> None:
    """Schema v2.9 removed it. `additionalProperties: false` makes the removal enforceable
    rather than advisory: a role map still carrying `url` fails, so a producer cannot keep
    emitting a field the contract no longer has."""
    roles_schema = json.loads(
        (SCHEMA_DIR / "column_roles.schema.json").read_text(encoding="utf-8")
    )
    config = {"filename": {"column": "filename", "label": "File"}, "url": ["source_url"]}
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.Draft202012Validator(roles_schema).validate(config)


def test_a_manifest_carrying_column_roles_url_no_longer_validates() -> None:
    """The already-committed case, stated rather than assumed. No committed fixture carries
    the key (checked 2026-09-07), and nothing in the repo can produce one after this change,
    so this is about a LIVE tree baked between 2.8 and 2.9. Such a manifest is now rejected by
    `manifest._validate_manifest` — LOUDLY, not silently ignored, which is the point: the
    user's setting is visible in the file and a migration can find it. Writing that migration
    (manifest -> presentation.json) is P2-2's, together with the API-side read; this seam
    guarantees only that the case cannot pass unnoticed."""
    manifest = {
        "manifest_version": "2.9",
        "dataset_id": "ds",
        "dataset_version": 1,
        "dataset_metadata": {"image_count": 1, "ingest_timestamp": "2026-09-07T00:00:00Z"},
        "column_roles": {
            "filename": {"column": "filename", "label": "File"},
            "url": ["source_url"],
        },
        "layouts": [_grid_entry()],
    }
    with pytest.raises(jsonschema.ValidationError):
        _validate_manifest(manifest)


def test_the_producer_no_longer_knows_the_url_role() -> None:
    roles = ColumnRoles.from_config({"filename": {"column": "filename", "label": "File"}})
    assert not hasattr(roles, "url")
    assert "url" not in _roles_to_dict(roles)


def test_the_bake_no_longer_refuses_a_link_column_that_is_not_stored(tmp_path: Path) -> None:
    """The v2.8 bake refused a `url` column that was not ALSO categorical/freeform, because
    the link would name a column absent from metadata.parquet. With the role gone, nothing
    replaces that check at bake time and NOTHING SHOULD (D-xvi): `presentation.json` is keyed
    by identifiers the manifest owns, and a key that does not resolve falls back on read. A
    bake-time check would have to read the other file. Pinned in both producer entry points —
    ingest's header validator and add-layouts' parquet validator — because both used to
    enforce it."""
    roles = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "File"},
            "freeform": [{"column": "caption", "label": "Caption"}],
        }
    )
    # `source_url` is in the header/parquet but carries no role at all; that used to be the
    # setup for the refusal, and is now simply an ordinary unmapped column.
    _validate_columns_present(roles, ["filename", "caption", "source_url"])
    data = {"id": pa.array([0, 1], pa.int64())}
    for column in ("filename", "caption", "source_url"):
        data[column] = pa.array(["a", "b"], pa.string())
    path = tmp_path / "metadata.parquet"
    pq.write_table(pa.table(data), path)
    worker._validate_roles_against_parquet(roles, path)  # must not raise

    # ...and the guard that DID remain is still armed: a role naming a phantom column fails.
    dangling = ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "File"},
            "freeform": [{"column": "nope", "label": "Nope"}],
        }
    )
    with pytest.raises(ColumnRoleError):
        _validate_columns_present(dangling, ["filename", "caption"])


# --- the publish paths leave the file alone ------------------------------------------


def _grid_entry(layout_id: str = "grid", version: int = 1) -> dict:
    return {
        "layout_id": layout_id,
        "label": "Grid",
        "type": "grid",
        "bbox": [0.0, 0.0, 1.0, 1.0],
        "pyramid": {
            "container": "pmtiles",
            "path": f"tiles/{layout_id}/{layout_id}_v{version}.pmtiles",
            "tile_px": 512,
            "thumb_px": 64,
            "cap": 64,
            "levels": [{"z": 0, "tile_count": 1}],
            "z_cap": 0,
        },
    }


def _fake_pyramid(layout_id: str = "grid", version: int = 1) -> SimpleNamespace:
    return SimpleNamespace(
        path=f"tiles/{layout_id}/{layout_id}_v{version}.pmtiles",
        tile_px=512, thumb_px=64, cap=64,
        levels=[SimpleNamespace(z=0, tile_count=1)], z_cap=0,
        detail_path_prefix=None, detail_format=None, dropped_total=0,
    )


def _write_presentation(dataset_dir: Path) -> Path:
    dataset_dir.mkdir(parents=True, exist_ok=True)
    path = dataset_dir / "presentation.json"
    path.write_text(_EXISTING, encoding="utf-8")
    return path


def _staged_tree(staging: Path, manifest: dict) -> None:
    """A staging dir shaped like the one `run_ingest` publishes: the version-stamped assets
    plus the manifest, plus the two internals `_commit` deliberately does not publish."""
    (staging / "tiles" / "grid").mkdir(parents=True, exist_ok=True)
    (staging / "tiles" / "grid" / "grid_v2.pmtiles").write_bytes(b"pmtiles")
    (staging / "metadata.parquet").write_bytes(b"parquet")
    (staging / "_thumb_cache").mkdir(exist_ok=True)
    (staging / "progress.json").write_text("{}", encoding="utf-8")
    (staging / "layout_manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )


def test_commit_over_an_existing_dataset_leaves_presentation_untouched(tmp_path: Path) -> None:
    """The re-ingest publish — the pin the plan's own 'done when' names: *a re-bake of a
    dataset leaves its name and credit untouched*. `_commit` merge-MOVES the staged items onto
    the existing dataset dir and atomically flips the manifest; it never removes or recreates
    the directory, so a root-level file it did not stage is not reachable by it at all."""
    dataset_dir, staging = tmp_path / "ds", tmp_path / ".staging-job"
    presentation = _write_presentation(dataset_dir)
    (dataset_dir / "layout_manifest.json").write_text(
        json.dumps({"dataset_version": 1}, indent=2), encoding="utf-8"
    )
    _staged_tree(staging, {"dataset_version": 2})

    worker._commit(staging, dataset_dir)

    assert presentation.read_text(encoding="utf-8") == _EXISTING
    # ...and the commit really ran, so the assertion above is not vacuously true.
    assert json.loads((dataset_dir / "layout_manifest.json").read_text())["dataset_version"] == 2
    assert (dataset_dir / "tiles" / "grid" / "grid_v2.pmtiles").is_file()


def test_the_base_commit_of_a_fresh_ingest_creates_no_presentation_file(tmp_path: Path) -> None:
    """The other half of rule 3: the pipeline must not WRITE the file either. A brand-new
    dataset publishes with no `presentation.json` at all — an absent file is today's
    behaviour, and a bake that helpfully seeded a default would be a second writer."""
    dataset_dir, staging = tmp_path / "fresh", tmp_path / ".staging-fresh"
    _staged_tree(staging, {"dataset_version": 1})

    worker._commit(staging, dataset_dir, keep_staging=True)

    assert (dataset_dir / "layout_manifest.json").is_file()
    assert not (dataset_dir / "presentation.json").exists()


def test_add_layouts_publish_leaves_presentation_untouched(tmp_path: Path) -> None:
    """The `add-layouts` publish: `_commit_one_layout` moves this layout's tiles/positions in
    and flips the manifest through `append_manifest_layouts`. It touches `tiles/`, `tags/`,
    `positions/` and `layout_manifest.json` by name and nothing else."""
    dataset_dir, staging = tmp_path / "ds", tmp_path / ".staging-add"
    presentation = _write_presentation(dataset_dir)
    committed = {
        "manifest_version": "2.9",
        "dataset_id": "ds",
        "dataset_version": 1,
        "dataset_metadata": {"image_count": 2, "ingest_timestamp": "2026-09-07T00:00:00Z"},
        "layouts": [_grid_entry()],
    }
    (dataset_dir / "layout_manifest.json").write_text(
        json.dumps(committed, indent=2) + "\n", encoding="utf-8"
    )
    (staging / "tiles" / "datetime").mkdir(parents=True)
    (staging / "tiles" / "datetime" / "datetime_v2.pmtiles").write_bytes(b"pmtiles")
    cells = build_spatial_cells([0, 1], [0.4, 0.6], [0.4, 0.6], [0.1, 0.1], [0.1, 0.1])
    added = LayoutResult(
        "datetime", "datetime", "By date", cells, (0.0, 0.0, 1.0, 1.0), None,
        source_columns=("captured",),
    )

    worker._commit_one_layout(
        staging=staging,
        dataset_dir=dataset_dir,
        layout_id="datetime",
        committed_manifest=committed,
        results_by_id={"datetime": added},
        pyramids_by_id={"datetime": _fake_pyramid("datetime", 2)},
        committed_so_far=["datetime"],
        version=2,
        roles_override=None,
        tags_path=None,
        move_tags=False,
    )

    assert presentation.read_text(encoding="utf-8") == _EXISTING
    flipped = json.loads((dataset_dir / "layout_manifest.json").read_text(encoding="utf-8"))
    assert [lv["layout_id"] for lv in flipped["layouts"]] == ["grid", "datetime"]
    assert flipped["dataset_version"] == 2


def test_refresh_manifest_leaves_presentation_untouched(tmp_path: Path) -> None:
    """`refresh-manifest` rewrites the committed manifest in place (plus a `.bak`) and touches
    no tiles. It must touch no presentation record either — this is the cheapest path to run
    against a live tree, so it is the likeliest to be run beside a hand-edited display name."""
    ds_id = "refresh_ds"
    dataset_dir = tmp_path / ds_id
    presentation = _write_presentation(dataset_dir)

    meta = pa.table(
        {
            "id": pa.array(range(4), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(4)], pa.string()),
        }
    )
    pq.write_table(meta, dataset_dir / "metadata.parquet")
    atlas = worker._PositionsAtlas(ids=list(range(4)))
    grid = worker._compute_requested_layouts(["grid"], None, meta, atlas)["grid"]
    positions = write_positions_table(
        grid.cells, 4, dataset_dir / "positions" / "grid_v1.arrow"
    )
    write_manifest(
        dataset_id=ds_id,
        dataset_version=1,
        layouts=[grid],
        pyramids={"grid": _fake_pyramid()},
        roles=None,
        image_count=4,
        source=None,
        output_path=dataset_dir / "layout_manifest.json",
        ingest_timestamp="2026-09-07T00:00:00Z",
        positions={"grid": positions},
    )

    run_refresh_manifest(ds_id, tmp_path, force=True)

    assert presentation.read_text(encoding="utf-8") == _EXISTING
    # The refresh really ran: it takes its pristine backup before the rewrite.
    assert (dataset_dir / "layout_manifest.json.bak").is_file()


def test_refresh_manifest_creates_no_presentation_file(tmp_path: Path) -> None:
    """Rule 3 again, on the path an operator runs against a live tree: refresh must not
    conjure the file either."""
    ds_id = "refresh_bare"
    dataset_dir = tmp_path / ds_id
    dataset_dir.mkdir(parents=True)
    meta = pa.table(
        {
            "id": pa.array(range(4), pa.int64()),
            "filename": pa.array([f"{i:03d}.png" for i in range(4)], pa.string()),
        }
    )
    pq.write_table(meta, dataset_dir / "metadata.parquet")
    atlas = worker._PositionsAtlas(ids=list(range(4)))
    grid = worker._compute_requested_layouts(["grid"], None, meta, atlas)["grid"]
    positions = write_positions_table(
        grid.cells, 4, dataset_dir / "positions" / "grid_v1.arrow"
    )
    write_manifest(
        dataset_id=ds_id,
        dataset_version=1,
        layouts=[grid],
        pyramids={"grid": _fake_pyramid()},
        roles=None,
        image_count=4,
        source=None,
        output_path=dataset_dir / "layout_manifest.json",
        ingest_timestamp="2026-09-07T00:00:00Z",
        positions={"grid": positions},
    )

    run_refresh_manifest(ds_id, tmp_path, force=True)

    assert not (dataset_dir / "presentation.json").exists()


def test_a_fresh_dataset_commits_without_the_deleted_rename_fast_path(
    tmp_path: Path,
) -> None:
    """The case the deleted `os.rename` fast path used to serve: a commit onto a dataset
    directory that does not exist yet, with `keep_staging` at its default.

    That branch was unreachable — the sole production caller passes `keep_staging=True`,
    and the only test using the default commits onto a dir that already exists — so
    nothing covered this shape at all, and deleting it could have changed behaviour with
    a green suite (review of PR #346, finding 5). The merge-move must produce the same
    published tree the rename did, and it must still sweep staging.

    It is also the shape that made restoring the fast path unsafe: the API can now create
    a dataset directory to hold `presentation.json` before any bake, under a DIFFERENT
    Redis lock than this commit holds."""
    dataset_dir, staging = tmp_path / "fresh", tmp_path / ".staging-fresh-default"
    _staged_tree(staging, {"dataset_version": 1})
    assert not dataset_dir.exists(), "the point of this spec is the absent directory"

    worker._commit(staging, dataset_dir)

    assert json.loads(
        (dataset_dir / "layout_manifest.json").read_text(encoding="utf-8")
    )["dataset_version"] == 1
    assert (dataset_dir / "tiles" / "grid" / "grid_v2.pmtiles").is_file(), (
        "the staged tree must be published, not merely the manifest"
    )
    assert not staging.exists(), (
        "keep_staging defaults False, so this commit owns sweeping staging"
    )
    # THE DISCRIMINATOR, and a first draft of this spec did not have it — every other
    # assertion here passes under the restored fast path too, because `os.rename` also
    # makes `staging` cease to exist. What only the merge-move does is SKIP the two
    # internals: a whole-directory rename publishes `_thumb_cache` and `progress.json`
    # into the dataset tree, where the fine-tier thumb cache is the larger of the two and
    # nothing ever reads either one from there.
    assert not (dataset_dir / "_thumb_cache").exists(), (
        "the internal thumb cache must not be published — a whole-directory rename would "
        "leak it into the dataset tree"
    )
    assert not (dataset_dir / "progress.json").exists(), (
        "the live progress sink stays in staging; the worker persists its terminal "
        "snapshot separately"
    )
