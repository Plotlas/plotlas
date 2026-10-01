"""`drop_retired_roles` — the conditional strip that unblocks a pre-2.9 tree.

THE DEFECT THESE EXIST FOR. Seam P2-1 removed `column_roles.url` from
`column_roles.schema.json`, which is `additionalProperties: false`. Four of the six real
dataset trees carry that key — `rijks_pilot` (the live public demo),
`smithsonian_art_200k`, `smithsonian_10k` and `google_landmarks_10k`, measured
2026-09-07 — so `add-layouts` and `refresh-manifest` are blocked on all four until it
leaves the manifest.

Seam P2-2's `migrate-presentation` COPIES the value into `presentation.json` and cannot
remove it from the manifest: the API never writes `layout_manifest.json` (D-xv). Only the
pipeline can, and the obvious form — strip on read, warn — silently DESTROYS the setting
when it runs before the migration. Hence the condition: drop only once the presentation
record has taken OWNERSHIP of every column the role names -- which is precisely when the
read path has stopped consulting that role -- else refuse and name the command.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from pipeline.manifest import RetiredRoleNotMigrated, drop_retired_roles


def _manifest(url: list[str] | None) -> dict:
    roles: dict = {"filename": "file", "categorical": [{"column": "artist"}]}
    if url is not None:
        roles["url"] = url
    return {"dataset_id": "d", "column_roles": roles, "layouts": []}


def _write_presentation(d: Path, columns: dict) -> None:
    (d / "presentation.json").write_text(
        json.dumps({"columns": columns}), encoding="utf-8"
    )


def test_a_manifest_with_no_retired_role_is_returned_unchanged(tmp_path: Path) -> None:
    """The 2.9-onwards path pays one `dict.get` and gets the same object back.

    Identity, not equality: a copy here would be a silent allocation on every
    add-layouts and refresh-manifest for the rest of the project's life, and the
    function's docstring promises it does not make one."""
    m = _manifest(None)
    assert drop_retired_roles(m, tmp_path) is m


def test_a_covered_url_role_is_dropped(tmp_path: Path) -> None:
    """The migrated case: presentation.json holds every column the manifest names, so the
    key is removed and the manifest validates again. This is what unblocks the four real
    trees."""
    _write_presentation(tmp_path, {"source_url": {"render": "url"}})
    out = drop_retired_roles(_manifest(["source_url"]), tmp_path)
    assert "url" not in out["column_roles"], out["column_roles"]
    # Everything else survives byte-for-byte — this drops one key, it does not rebuild
    # the roles.
    assert out["column_roles"] == {
        "filename": "file",
        "categorical": [{"column": "artist"}],
    }


def test_an_UNMIGRATED_url_role_REFUSES_rather_than_losing_the_setting(
    tmp_path: Path,
) -> None:
    """**The whole reason this is conditional.** With no presentation record, an
    unconditional strip would drop `source_url` and the user's link setting would be gone
    with no way back — and `migrate-presentation` reads the manifest, so once the key is
    gone the value cannot be recovered from anywhere.

    The refusal must name the remedy: the person who hits this is an operator running a
    bake, and 'invalid manifest' tells them nothing about which command fixes it."""
    with pytest.raises(RetiredRoleNotMigrated) as exc:
        drop_retired_roles(_manifest(["source_url"]), tmp_path)
    message = str(exc.value)
    assert "source_url" in message, message
    assert "migrate-presentation" in message, (
        "the refusal must name the command that fixes it, not just the problem: " + message
    )


def test_a_PARTIALLY_migrated_url_role_refuses(tmp_path: Path) -> None:
    """Coverage is all-or-nothing per role. A record holding one of two named columns is
    the half-migrated state — an interrupted migration, or a hand-edit — and dropping the
    key there loses the column that is missing. `all()` is the assertion; this pins that
    it is not `any()`."""
    _write_presentation(tmp_path, {"a_url": {"render": "url"}})
    with pytest.raises(RetiredRoleNotMigrated):
        drop_retired_roles(_manifest(["a_url", "b_url"]), tmp_path)


def test_a_column_DESCRIBED_without_a_render_still_counts_as_covered(
    tmp_path: Path,
) -> None:
    """Coverage is OWNERSHIP of the column, not `render == "url"` — and a first draft of
    this suite asserted the opposite, which broke the API's
    `test_migrate_does_not_overwrite_an_existing_column_entry`.

    The read path applies the legacy role only to a column the record does not describe
    (`api/presentation.effective`: `if name not in columns`). So an entry carrying only a
    label already makes the manifest's role dead letter — nothing is lost by dropping it.
    The stricter test would have refused a dataset whose migration had correctly reported
    success, and would also have denied that describing a column WITHOUT a render is how
    "this is not a link" is expressed: the schema has no null and blank means removed, so
    an entry with no `render` is the only way to clear one."""
    _write_presentation(tmp_path, {"source_url": {"label": "Source"}})
    out = drop_retired_roles(_manifest(["source_url"]), tmp_path)
    assert "url" not in out["column_roles"], out["column_roles"]


@pytest.mark.parametrize(
    "body", ["{not json", '"a string"', "[]"], ids=["malformed", "scalar", "array"]
)
def test_an_unreadable_presentation_record_FAILS_CLOSED(
    tmp_path: Path, body: str
) -> None:
    """Doubt means 'no'. This feeds a delete decision, so a record that cannot be parsed
    — or parses to something that is not an object — must be treated as covering nothing
    rather than as probably fine."""
    (tmp_path / "presentation.json").write_text(body, encoding="utf-8")
    with pytest.raises(RetiredRoleNotMigrated):
        drop_retired_roles(_manifest(["source_url"]), tmp_path)


def test_an_images_only_manifest_is_returned_unchanged(tmp_path: Path) -> None:
    """No `column_roles` at all (an images-only dataset, D-25) — nothing to strip, and
    nothing to read from disk."""
    m = {"dataset_id": "d", "layouts": []}
    assert drop_retired_roles(m, tmp_path) is m


@pytest.mark.parametrize(
    "url_value", [[], [123, None]], ids=["empty-list", "all-non-string"]
)
def test_a_role_that_NAMES_NOTHING_is_dropped_rather_than_wedging_the_tree(
    tmp_path: Path, url_value: list
) -> None:
    """**A closed loop, not a slow path** (review of PR #346, finding 3).

    `all(... for c in [])` is vacuously True, so before the short-circuit `has` turned on
    `isinstance(columns, dict)` alone — and a dataset with no `presentation.json` was
    refused. The refusal names `migrate-presentation`, which computes
    `legacy_url_columns(roles) == []`, finds no updates, reports "current" and writes
    nothing. So the operator retries forever, doing the right thing each time and getting
    the same error.

    `{"url": []}` means the role is present and names nothing. There is no setting to
    lose, so there is nothing to migrate and nothing to check. Deliberately pinned with NO
    presentation.json present: that is the state that wedged."""
    m = _manifest(None)
    m["column_roles"]["url"] = url_value
    out = drop_retired_roles(m, tmp_path)
    assert "url" not in out["column_roles"], out["column_roles"]


def test_the_refusal_names_force_because_a_plain_refresh_retry_stops_short(
    tmp_path: Path,
) -> None:
    """The remedy has two steps on the `refresh-manifest` path and the message used to
    name one (review of PR #346, finding 10).

    `drop_retired_roles` runs BEFORE `worker`'s already-enriched gate, so an operator who
    migrates and retries clears this error and lands on
    `RefreshManifestError: … nothing to do. Re-run with --force …`. That second error is
    self-describing — the finding's "the tree stays blocked" overstates it — but the
    operator has now hit two walls to perform one repair, and the first one knew about the
    second."""
    with pytest.raises(RetiredRoleNotMigrated) as exc:
        drop_retired_roles(_manifest(["source_url"]), tmp_path)
    assert "--force" in str(exc.value), (
        "the refusal must name the second step of its own remedy: " + str(exc.value)
    )
