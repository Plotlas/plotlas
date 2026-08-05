"""The `url` column role — schema v2.8 (SCOPE_Part-C_url-role_v3).

An array of column NAMES whose values render as links. `url` is an ORTHOGONAL display
modifier, not a storing role: the enrichment SELECT does not project it, so a url column
must ALSO be a categorical or freeform column (a shown scalar) or its value never reaches
metadata.parquet. The producer (D-11 validator) enforces that here, not only the frontend
wizard. There is no value-level validation — values are per-row data, and the renderer
refuses anything that is not an absolute http(s) URL per cell (pinned in
packages/frontend/tests/source_link.test.ts).
"""

from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from pipeline import worker
from pipeline.ingest import ColumnRoleError, _apply_renames, _validate_columns_present
from pipeline.layout_plugins.base import ColumnRoles

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "schemas" / "v2"


def _schema() -> dict:
    return json.loads((SCHEMA_DIR / "column_roles.schema.json").read_text(encoding="utf-8"))


def _roles(url: list[str] | None = None, *, freeform: list[str] | None = None) -> dict:
    """A minimal roles config. `freeform` names the columns to ALSO store as shown scalars —
    a url column must be one of those (see the invariant tests below)."""
    config: dict = {"filename": {"column": "filename", "label": "File"}}
    if freeform is not None:
        config["freeform"] = [{"column": c, "label": c} for c in freeform]
    if url is not None:
        config["url"] = url
    return config


# --- schema shape ----------------------------------------------------------


def test_url_is_optional_and_defaults_empty() -> None:
    jsonschema.Draft202012Validator(_schema()).validate(_roles())
    assert ColumnRoles.from_config(_roles()).url == []


def test_url_accepts_a_list_of_column_names() -> None:
    jsonschema.Draft202012Validator(_schema()).validate(_roles(["source_url", "license"]))


def test_url_rejects_role_entry_objects_and_blank_names() -> None:
    """Bare names, not {column,label} — the panel heads each field with the column's own
    name and the link text is the value, so there is no third string to carry."""
    validator = jsonschema.Draft202012Validator(_schema())
    with pytest.raises(jsonschema.ValidationError):
        validator.validate(_roles([{"column": "c", "label": "L"}]))  # type: ignore[list-item]
    with pytest.raises(jsonschema.ValidationError):
        validator.validate(_roles([""]))


# --- parsing ---------------------------------------------------------------


def test_from_config_parses_the_names() -> None:
    # from_config only parses shape; the "must also be stored" invariant is a validator check.
    assert ColumnRoles.from_config(_roles(["source_url"])).url == ["source_url"]


# --- validation: existence + the "must also be stored/shown" invariant ------


def test_a_url_column_missing_from_the_header_is_refused() -> None:
    roles = ColumnRoles.from_config(_roles(["nope"]))
    with pytest.raises(ColumnRoleError):
        _validate_columns_present(roles, ["filename", "title"])


def test_a_present_url_column_that_is_also_freeform_passes() -> None:
    # This also pins the "values are NOT validated at bake time" contract: _validate_columns_present
    # sees only the header (column NAMES), so it structurally cannot reject a typo'd URL value — a
    # bake must not fail because one row of 49,048 has a bad URL (the renderer refuses non-http(s)
    # per cell, pinned in packages/frontend/tests/source_link.test.ts).
    roles = ColumnRoles.from_config(_roles(["source_url"], freeform=["source_url"]))
    _validate_columns_present(roles, ["filename", "source_url"])  # must not raise


def test_a_url_column_that_is_not_also_stored_is_refused() -> None:
    """Schema v2.8: `url` is a display MODIFIER, not a storing role — the enrichment SELECT
    does not project it, so a url column must ALSO be categorical/freeform or the manifest's
    link would name a column absent from metadata.parquet. The pipeline enforces this (D-11),
    not just the frontend wizard: a url-ONLY column that exists in the header would otherwise
    bake a silently-dead link."""
    roles = ColumnRoles.from_config(_roles(["source_url"]))  # present in header, but not stored
    with pytest.raises(ColumnRoleError):
        _validate_columns_present(roles, ["filename", "source_url"])


# --- add-layouts path: worker._validate_roles_against_parquet enforces the SAME rule ------
# The wizard's re-POST and the CLI add-layouts route validate a roles override against the
# FROZEN parquet schema (not the CSV header) — a separate code path from ingest's
# _validate_columns_present — so the "url must also be stored/shown" rule must hold here too.


def _committed_parquet(tmp_path: Path, columns: list[str]) -> Path:
    """A committed-style metadata.parquet carrying `id` + the named string columns."""
    data: dict = {"id": pa.array([0, 1], pa.int64())}
    for c in columns:
        data[c] = pa.array(["a", "b"], pa.string())
    path = tmp_path / "metadata.parquet"
    pq.write_table(pa.table(data), path)
    return path


def test_worker_gate_accepts_a_freeform_url_column(tmp_path: Path) -> None:
    path = _committed_parquet(tmp_path, ["filename", "source_url"])
    roles = ColumnRoles.from_config(_roles(["source_url"], freeform=["source_url"]))
    worker._validate_roles_against_parquet(roles, path)  # must not raise


def test_worker_gate_rejects_a_url_column_not_also_stored(tmp_path: Path) -> None:
    # source_url physically exists in the parquet but carries no storing role, so the
    # add-layouts gate must refuse it exactly as ingest does — a link the panel can't draw.
    path = _committed_parquet(tmp_path, ["filename", "source_url"])
    roles = ColumnRoles.from_config(_roles(["source_url"]))  # url-only, no freeform/categorical
    with pytest.raises(ColumnRoleError, match="must also be a categorical or freeform"):
        worker._validate_roles_against_parquet(roles, path)


# --- rename repointing (reserved-name collision) ---------------------------


def test_url_names_are_repointed_on_a_reserved_name_collision() -> None:
    """url holds bare column NAMES, so a name stored under a derived physical name (a
    reserved-column collision handled by _join_metadata) must be repointed like every other
    role — else the manifest's url would name the pre-rename column while its freeform twin is
    repointed, so they would disagree and the link would never render."""
    roles = ColumnRoles.from_config(_roles(["width"], freeform=["width"]))  # 'width' is reserved
    repointed = _apply_renames(roles, {"width": "meta_width"})
    assert repointed.url == ["meta_width"]
    assert any(e.column == "meta_width" for e in repointed.freeform)


# --- manifest round trip ---------------------------------------------------


def test_role_round_trips_through_the_manifest_serializer() -> None:
    from pipeline.manifest import _roles_to_dict

    out = _roles_to_dict(
        ColumnRoles.from_config(
            _roles(["source_url", "license"], freeform=["source_url", "license"])
        )
    )
    assert out["url"] == ["source_url", "license"]
    jsonschema.Draft202012Validator(_schema()).validate(out)


def test_an_empty_url_role_is_OMITTED_so_pre_28_datasets_round_trip_unchanged() -> None:
    from pipeline.manifest import _roles_to_dict

    assert "url" not in _roles_to_dict(ColumnRoles.from_config(_roles()))
    assert "url" not in _roles_to_dict(ColumnRoles.from_config(_roles([])))
