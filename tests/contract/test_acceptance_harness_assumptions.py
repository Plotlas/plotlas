"""Contract gate: the acceptance harness's manifest assumptions still hold.

WHY THIS EXISTS. ``tests/e2e/run_acceptance.py`` is a MANUAL tool — no workflow runs
it (e2e-nightly.yml only drives the Playwright specs, against an externally
configured E2E_BASE_URL). So when the contract it reads moves, nothing says so, and
the harness simply rots until someone next runs it by hand. That is not
hypothetical: it sat broken from **2026-06-26** — when D-33 replaced
``layoutEntry.tile_root`` with ``layoutEntry.pyramid`` and dropped
``manifest.atlas`` — until **2026-07-17**, three weeks in which it could not
complete a single run. A second, later breakage (the T2-09 forward_auth gate, which
401s every un-credentialed /datasets/* fetch) piled up behind the first without ever
being reached.

WHAT THIS DOES. Pins the manifest shape the harness reads, against the COMMITTED
golden fixture, with **no stack required** — so it runs in the ordinary CI tier
(`pytest ... tests/contract`) rather than needing api+worker+redis+caddy. The next
schema change that would break the harness turns a silent rot into a red check here,
naming the harness explicitly.

WHAT THIS DOES NOT DO. It does not prove the harness RUNS — only that the shape it
reads is still real. A KeyError is caught here; a broken upload flow is not. Wiring
the harness itself to a composed fixture stack is the separate T2-39 Phase-1
deliverable (docs/plan/renderer-stage0-plan.md §0.7); until that lands, this is the
cheap standing guard, and it is deliberately scoped to the assumptions the harness
would crash on rather than duplicating test_fixture_conforms_schemas.py's full
schema validation.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "golden_dataset_v2"
SCHEMAS = REPO_ROOT / "schemas" / "v2"

sys.path.insert(0, str(REPO_ROOT / "tests" / "e2e"))


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads((FIXTURE / "layout_manifest.json").read_text())


def test_harness_required_cell_columns_match_the_schema() -> None:
    """The harness asserts a decoded fine tile carries REQUIRED_CELL_COLUMNS. That
    set must stay equal to the schema's `required` — if a column is added to or
    removed from the contract, the harness's assertion is the thing that silently
    stops meaning what it says."""
    from run_acceptance import REQUIRED_CELL_COLUMNS

    schema = json.loads((SCHEMAS / "cell_record.schema.json").read_text())
    assert REQUIRED_CELL_COLUMNS == set(schema["required"]), (
        "tests/e2e/run_acceptance.py REQUIRED_CELL_COLUMNS has drifted from "
        f"schemas/v2/cell_record.schema.json `required`: harness has "
        f"{sorted(REQUIRED_CELL_COLUMNS)}, schema requires {sorted(schema['required'])}"
    )


def test_manifest_carries_the_pyramid_descriptor_the_harness_reads(manifest) -> None:
    """The harness resolves tiles via layoutEntry.pyramid (D-33): it needs
    `container`, `path` and `z_cap`. Reading `tile_root` here is what broke it in
    June — this is the assertion that would have said so on the day."""
    layouts = manifest["layouts"]
    assert layouts, "fixture manifest declares no layouts"
    for layout in layouts:
        lid = layout["layout_id"]
        assert "tile_root" not in layout, (
            f"{lid}: layout entry carries the v1 `tile_root` again — "
            "tests/e2e/run_acceptance.py reads `pyramid` (D-33) and would miss it"
        )
        pyramid = layout.get("pyramid")
        assert pyramid is not None, f"{lid}: no `pyramid` — the harness cannot find tiles"
        assert pyramid.get("container") == "pmtiles", (
            f"{lid}: pyramid.container={pyramid.get('container')!r}; the harness drives "
            "the pmtiles Reader and would need rewriting for another container"
        )
        for key in ("path", "z_cap"):
            assert key in pyramid, (
                f"{lid}: pyramid has no {key!r} — the harness needs it to "
                f"{'locate the container' if key == 'path' else 'pick the fine/coarse framing'}"
            )


def test_manifest_has_no_standalone_atlas_tree(manifest) -> None:
    """D-33 folded the atlas into each fine tile body as a per-tile WebP mini-atlas.
    The harness therefore asserts the WebP band inside the tile instead of fetching
    an atlas/ page. If a top-level `atlas` ever comes back, that decision — and the
    harness step built on it — needs revisiting rather than silently diverging."""
    assert "atlas" not in manifest, (
        "the manifest declares a top-level `atlas` again; tests/e2e/run_acceptance.py "
        "asserts the mini-atlas inside the fine tile body and fetches no atlas page"
    )


def test_manifest_tags_declaration_shape(manifest) -> None:
    """The harness fetches + Arrow-decodes the tag sidecar from `tags.path`."""
    tags = manifest.get("tags")
    assert tags is not None, "fixture manifest declares no tags sidecar (D-14)"
    assert tags.get("format") == "arrow", f"unexpected tags format: {tags.get('format')!r}"
    assert "path" in tags, "tags declaration has no `path` for the harness to fetch"
