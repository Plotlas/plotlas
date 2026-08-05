"""Seam O1 — the pipeline CLI's `--owner` surface and its post-run output.

The defect: `pixscope ingest --owner dale` completed, printed one line, and the
dataset never appeared in the library — because ownership lives ONLY in the API
app-state store and the pipeline never writes it. These tests pin the two halves of
the fix that belong to `cli.py`: `--owner` no longer reads as if it grants ownership,
and a successful bake ends by naming the exact next command.

`run_ingest` / `run_add_layouts` are stubbed — this file tests the CLI's ARGUMENT
SURFACE and OUTPUT, not the bake (the real bake is covered by the native end-to-end
tests, and stubbing keeps these runnable in the lean test image, which has no pyvips).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pipeline import cli


@pytest.fixture
def stub_ingest(monkeypatch: pytest.MonkeyPatch) -> list:
    """Replace the bake with a recorder, so a CLI run is instant and the payload the
    CLI built is inspectable. Returns the list of payloads it received."""
    seen: list = []

    def _fake_run_ingest(payload) -> str:  # noqa: ANN001
        seen.append(payload)
        return "1"

    monkeypatch.setattr(cli, "run_ingest", _fake_run_ingest)
    return seen


@pytest.fixture
def stub_add_layouts(monkeypatch: pytest.MonkeyPatch) -> list:
    seen: list = []

    def _fake_run_add_layouts(payload) -> dict:  # noqa: ANN001
        seen.append(payload)
        return {"dataset_version": 2, "committed": ["categorical"]}

    monkeypatch.setattr(cli, "run_add_layouts", _fake_run_add_layouts)
    return seen


def _ingest_argv(dataset_id: str, images: Path, root: Path, *extra: str) -> list[str]:
    return [
        "ingest",
        "--images", str(images),
        "--dataset-id", dataset_id,
        "--output-root", str(root),
        "--sync",
        *extra,
    ]


# --- the post-run output: never silence ------------------------------------


def test_successful_bake_names_the_assign_owner_command(
    tmp_path: Path, images_dir: Path, stub_ingest: list, capsys: pytest.CaptureFixture[str]
) -> None:
    """DoD §1: a successful bake ends with the exact next command, with the supplied
    owner substituted so it is copy-pasteable."""
    assert cli.main(_ingest_argv("ds_o1", images_dir, tmp_path, "--owner", "dale")) == 0

    out = capsys.readouterr().out
    assert "ingested dataset 'ds_o1' -> version 1" in out
    assert "python -m api.admin assign-owner ds_o1 dale" in out
    # And it says why the step exists at all, not just what to type.
    assert "ownership is NOT set by this command" in out
    assert "app-state" in out


def test_next_steps_name_create_user_and_the_unassigned_check(
    tmp_path: Path, images_dir: Path, stub_ingest: list, capsys: pytest.CaptureFixture[str]
) -> None:
    """The other two failure modes an operator can be in are named up front: the
    account may not exist yet (create-user), and they may not know whether this
    dataset is already owned (list-unassigned is the authoritative check — the CLI
    cannot read app-state, so it must not claim either way)."""
    assert cli.main(_ingest_argv("ds_o1", images_dir, tmp_path, "--owner", "dale")) == 0

    out = capsys.readouterr().out
    assert "python -m api.admin create-user dale <email>" in out
    assert "python -m api.admin list-unassigned" in out
    assert "python -m api.admin set-visibility ds_o1 public" in out


def test_no_owner_supplied_prints_a_placeholder_not_a_fabricated_name(
    tmp_path: Path, images_dir: Path, stub_ingest: list,
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """"No user supplied? Please supply user." — with no `--owner`, the printed
    command carries a `<username>` PLACEHOLDER. The `$USER` fallback is a label for
    the log, never a name to paste into assign-owner: pasting a fabricated name is
    the failure this seam removes."""
    monkeypatch.setenv("USER", "root")
    assert cli.main(_ingest_argv("ds_anon", images_dir, tmp_path)) == 0

    out = capsys.readouterr().out
    assert "python -m api.admin assign-owner ds_anon <username>" in out
    assert "assign-owner ds_anon root" not in out


def test_next_steps_commands_are_column_aligned(
    tmp_path: Path, images_dir: Path, stub_ingest: list, capsys: pytest.CaptureFixture[str]
) -> None:
    """The four commands are a block an operator reads at a glance, so their trailing
    `#` explanations line up — and the column is DERIVED from the longest command, not
    a guessed pad (dataset ids and usernames are caller data, so any fixed width is
    wrong for someone)."""
    assert cli.main(_ingest_argv("a_very_long_dataset_id", images_dir, tmp_path)) == 0

    command_lines = [
        line for line in capsys.readouterr().out.splitlines()
        if "api.admin" in line and "#" in line
    ]
    assert len(command_lines) == 4  # list-unassigned, create-user, assign-owner, set-visibility
    assert len({line.index("#") for line in command_lines}) == 1  # one shared column


def test_add_layouts_also_ends_with_the_ownership_next_steps(
    tmp_path: Path, images_dir: Path, stub_add_layouts: list,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """add-layouts bakes onto an existing tree; an unowned tree is just as invisible
    after it as before, and it is the other command carrying the same `--owner`."""
    code = cli.main([
        "add-layouts",
        "--images", str(images_dir),
        "--dataset-id", "ds_more",
        "--output-root", str(tmp_path),
        "--layout", "categorical",
        "--sync",
        "--owner", "dale",
    ])
    assert code == 0
    out = capsys.readouterr().out
    assert "added layouts to dataset 'ds_more'" in out
    assert "python -m api.admin assign-owner ds_more dale" in out


# --- the `--owner` flag itself ---------------------------------------------


def test_owner_help_does_not_claim_to_record_ownership(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The flag documented itself as "recorded dataset owner", which is what made the
    defect undiagnosable. Its help must now say it is a label, name where the real
    write happens, and admit it is unvalidated."""
    with pytest.raises(SystemExit):
        cli.main(["ingest", "--help"])
    help_text = capsys.readouterr().out
    # argparse re-wraps help through textwrap with break_on_hyphens=True, which
    # splits "assign-owner" across lines. Match with whitespace removed so the
    # assertion is about the WORDS, not argparse's line breaks.
    squashed = "".join(help_text.split())

    assert "recorded dataset owner" not in help_text
    assert "doesNOTgrantownership" in squashed
    assert "api.adminassign-owner" in squashed
    assert "isNOTvalidated" in squashed


def test_owner_label_still_reaches_the_payload_unchanged(
    tmp_path: Path, images_dir: Path, stub_ingest: list, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Behaviour pin: the payload's `owner` (the ingest.log label) is unchanged by
    this seam — supplied wins, else $USER, else "cli". Only the argparse default moved
    to None so the output can distinguish "named" from "not named"."""
    monkeypatch.setenv("USER", "envuser")
    assert cli.main(_ingest_argv("ds_a", images_dir, tmp_path, "--owner", "dale")) == 0
    assert stub_ingest[-1].owner == "dale"

    assert cli.main(_ingest_argv("ds_b", images_dir, tmp_path)) == 0
    assert stub_ingest[-1].owner == "envuser"

    monkeypatch.delenv("USER")
    assert cli.main(_ingest_argv("ds_c", images_dir, tmp_path)) == 0
    assert stub_ingest[-1].owner == "cli"


def test_empty_owner_is_treated_as_not_supplied(
    tmp_path: Path, images_dir: Path, stub_ingest: list,
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    """O1-review fix: `--owner ""` is meaningless as a label, so it is treated as "not
    supplied" everywhere — `_resolve_owner` falls back to $USER/"cli" (not an empty
    `owner=` in the payload/ingest.log) AND the printed next-step shows the `<username>`
    placeholder. This closes the is-None-vs-truthiness split where the two halves
    disagreed on an empty owner."""
    monkeypatch.setenv("USER", "root")
    assert cli.main(_ingest_argv("ds_empty", images_dir, tmp_path, "--owner", "")) == 0
    # the payload label falls back — it is NOT the empty string
    assert stub_ingest[-1].owner == "root"
    # and the printed command uses the placeholder, consistent with "not supplied"
    assert "python -m api.admin assign-owner ds_empty <username>" in capsys.readouterr().out
