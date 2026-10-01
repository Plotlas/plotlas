"""The presentation contract has ONE authoritative home per rule, and this is the gate.

`schemas/v2/presentation.schema.json` is the contract, but the lean api image ships only
`packages/api` — no `schemas/` directory — and `jsonschema` is deliberately not an API
dependency (`db.py` says the same about the manifest). So the write path enforces the
schema's rules in Python (`api/presentation.py`), which is a second copy of numbers that
already exist in the schema, and the schema's own field descriptions say they TRANSCRIBE
the Python ones.

Two hand-maintained copies is the drift risk this project has been bitten by, so the
deferral is made MECHANICAL here rather than left to discipline: change one without the
other and this goes red, naming both values.

The direction of authority, for the next reader:
  * the three length caps are authoritative in `appstate.PRESENTATION_LIMITS` — that is
    what runs at every write, and the schema cites it by name;
  * the layout-id shape and the `render` enum are authoritative in the SCHEMA (they are
    transcribed from `layout_manifest.schema.json`, which the API does not own), and
    `presentation.py` transcribes them for the write path.

Tests, not production code, read the schema — a test runs from the repo, where
`schemas/v2/` is present.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from api import appstate, presentation

SCHEMA_PATH = (
    Path(__file__).resolve().parents[3] / "schemas" / "v2" / "presentation.schema.json"
)


@pytest.fixture(scope="module")
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def test_the_three_length_caps_match_app_state(schema: dict) -> None:
    """`maxLength` per scalar == `appstate.PRESENTATION_LIMITS`. The schema's descriptions
    name the constants; this checks the numbers actually agree."""
    properties = schema["$defs"]["datasetPresentation"]["properties"]
    from_schema = {
        field: properties[field]["maxLength"] for field in appstate.PRESENTATION_LIMITS
    }
    assert from_schema == appstate.PRESENTATION_LIMITS


def test_every_writable_dataset_key_exists_in_the_schema(schema: dict) -> None:
    """A key the API writes but the schema does not define would produce a file that fails
    validation for everyone else — the exact class of drift two files invite."""
    declared = set(schema["$defs"]["datasetPresentation"]["properties"])
    assert set(presentation._DATASET_KEYS) <= declared


def test_the_layout_id_shape_matches_the_schema(schema: dict) -> None:
    key = schema["$defs"]["layoutIdKey"]
    assert presentation._LAYOUT_ID_RE.pattern == key["pattern"]
    assert presentation._LAYOUT_ID_MAX == key["maxLength"]


def test_the_render_enum_matches_the_schema(schema: dict) -> None:
    """`render` is an enum so `email`/`image` slot in later without a second mechanism. A
    value the API accepts that the schema does not list would be unrepresentable to every
    other reader of the file."""
    declared = schema["$defs"]["columnPresentation"]["properties"]["render"]["enum"]
    assert list(presentation._RENDER_KINDS) == declared


def test_the_writer_emits_the_schema_version(schema: dict) -> None:
    """A writer always emits `presentation_version`, so an absent one means "authored by
    something that was not this contract's writer"."""
    import re

    pattern = schema["properties"]["presentation_version"]["pattern"]
    assert re.match(pattern, presentation.PRESENTATION_VERSION)
    written = presentation.apply_updates({}, {"display_name": "x"})
    assert written["presentation_version"] == presentation.PRESENTATION_VERSION


def test_every_key_the_writer_can_emit_is_declared(schema: dict) -> None:
    """The whole record shape, not just the dataset block: the schema is
    `additionalProperties: false` at every level, so an undeclared key anywhere makes the
    file invalid for its other readers."""
    record = presentation.apply_updates(
        {},
        {
            "display_name": "A",
            "attribution": "B",
            "attribution_url": "https://c.example",
            "default_layout": "grid",
            "title_column": "title",
            "columns": {"src": {"label": "Src", "render": "url", "hidden": True}},
            "layouts": {"grid": {"label": "Grid"}},
        },
    )
    assert set(record) <= set(schema["properties"])
    assert set(record["dataset"]) <= set(
        schema["$defs"]["datasetPresentation"]["properties"]
    )
    assert set(record["columns"]["src"]) <= set(
        schema["$defs"]["columnPresentation"]["properties"]
    )
    assert set(record["layouts"]["grid"]) <= set(
        schema["$defs"]["layoutPresentation"]["properties"]
    )
