"""The ``pixscope ingest`` command-line entry point.

Thin wrapper that authenticates and uploads images + CSV through the same API as
the web trigger (decision D-18) — one code path; it does not pass local server
paths to the server, nor reimplement ingest logic.

Scope here (pipeline seam): the ``--sync`` inline path + IngestJobPayload
construction. ``--sync`` remains the local tool that runs the pipeline inline;
the enqueue path is owned by the API — the API queue seam exists
(``api/queue.py`` dispatches ``run_ingest`` by dotted-path string, decision D-15),
and the authenticate-and-upload-through-the-API trigger (decision D-18) is that
path, not a CLI responsibility.

Images-first (decision D-25): ``--metadata`` and the role flags are OPTIONAL —
with images only, the pipeline builds the grid layout from the images alone.

OWNERSHIP IS NOT A PIPELINE CAPABILITY (seam O1). ``--owner`` is a LABEL, not a
grant: the only thing the pipeline does with it is write it into
``{dataset}/ingest.log`` (``worker.run_ingest``/``run_add_layouts`` log
``owner=<value>`` and nothing else reads it — measured 2026-07-29: those two
``logger.info`` calls are the ONLY ``payload.owner`` references in ``pipeline/``).
Real ownership lives ONLY in the API app-state store (``appstate.py``, SQLite;
decisions D-18/D-22/D-24), which the pipeline may not touch — no pipeline->api
import, no pipeline->API HTTP call (module-map rule #7; the `api` package is not
even installed in the worker image). Consequence the operator hit: a CLI bake with
no follow-up ``api.admin assign-owner`` is on disk but absent from
``GET /api/datasets``, which drops every dataset with no app-state record. So a
successful bake now ENDS by naming the exact commands that finish the job
(``_print_ownership_next_steps``) instead of leaving the operator with silence.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
from pathlib import Path

from pipeline.worker import (
    AddLayoutsJobPayload,
    DeleteLayoutJobPayload,
    IngestJobPayload,
    LayoutLifecycleError,
    RefreshManifestError,
    SetRolesJobPayload,
    run_add_layouts,
    run_delete_layout,
    run_ingest,
    run_refresh_manifest,
    run_set_roles,
)


# --- ownership legibility (seam O1) ----------------------------------------
#
# The pipeline CANNOT record ownership and CANNOT validate an owner name: ownership
# is API app-state and the boundary is one-way (module-map rule #7). The two things
# it can honestly do are (a) never claim otherwise, and (b) end every bake by naming
# the exact command that does the thing. Both live here.

_OWNER_HELP = (
    "a LABEL written to the dataset's ingest.log only — it does NOT grant ownership "
    "and is NOT validated (the pipeline cannot reach the API's app-state store). "
    "Real ownership is recorded by `python -m api.admin assign-owner` in the api "
    "container; see the next-steps printed after a successful bake"
)


def _resolve_owner(supplied: str | None) -> str:
    """The owner LABEL that goes into the job payload (and thence ingest.log).

    A non-empty `--owner` wins, else `$USER`, else "cli" — the same fallback as before
    seam O1 for the two cases that matter (supplied a name / supplied nothing). An
    EMPTY `--owner ""` is treated as "not supplied" so this and
    `_print_ownership_next_steps` agree on it (the printer uses the same truthiness to
    pick its `<username>` placeholder); an empty label is meaningless in ingest.log
    anyway. The flag's argparse default is None purely so the post-run output can tell
    "the operator named someone" from "nobody was named"."""
    return supplied if supplied else os.environ.get("USER", "cli")


def _print_ownership_next_steps(dataset_id: str, supplied_owner: str | None) -> None:
    """End a successful bake with the exact commands that put the dataset in a
    library — never silence (seam O1).

    Deliberately UNCONDITIONAL and conditionally WORDED. The pipeline cannot read
    app-state, so it cannot know whether this dataset is already owned; claiming
    "this dataset is invisible" would be an unmeasured assertion on a re-bake of an
    owned dataset. So the text states the rule ("a dataset with no app-state owner is
    not listed"), points at `list-unassigned` as the authoritative check, and lets the
    operator confirm in one command.

    `supplied_owner` is echoed into the assign-owner line when the operator named
    someone, so the command is copy-pasteable; when they did not, a `<username>`
    placeholder is printed rather than the invented `$USER`/"cli" label, because
    pasting a fabricated name is exactly the failure this seam exists to remove.
    Either way assign-owner re-checks the name against app-state and refuses an
    unknown one, so a typo fails loudly there instead of silently here."""
    owner = supplied_owner if supplied_owner else "<username>"
    prefix = "docker compose exec api python -m api.admin"
    steps = [
        (f"{prefix} list-unassigned", f"is {dataset_id} already owned?"),
        (f"{prefix} create-user {owner} <email>", "only if that account is new"),
        (f"{prefix} assign-owner {dataset_id} {owner}", "the step that makes it visible"),
        (f"{prefix} set-visibility {dataset_id} public", "optional: no-login showcase"),
    ]
    # Align the comment column to the LONGEST command rather than to a guessed pad —
    # the ids and usernames are caller data, so any fixed width is wrong for someone.
    width = max(len(command) for command, _ in steps)
    print(
        f"\nNEXT STEP — ownership is NOT set by this command.\n"
        f"  A dataset is listed by the API only once its owner is recorded in the "
        f"API app-state store;\n"
        f"  --owner reaches this dataset's ingest.log and nothing else. Run these in "
        f"the api container:"
    )
    for command, note in steps:
        print(f"    {command.ljust(width)}   # {note}")
    print(
        "  assign-owner refuses a username that does not exist, so a typo fails "
        "there rather than silently here."
    )


def main(argv: list[str] | None = None) -> int:
    """
    `pixscope ingest --images DIR --dataset-id ID
    [--metadata FILE.csv] [--layout grid,datetime,categorical] [role flags]`, or
    `pixscope add-layouts --images DIR --dataset-id ID --layout SPEC [--layout SPEC ...]`.
    `--metadata` (and the role flags) are OPTIONAL (decision D-25): with images
    only, the pipeline builds the grid layout from the images alone. Builds the
    typed payload and dispatches it through the same job code path as the web
    trigger (enqueue, or --sync to run inline). Returns an exit code. Does not
    reimplement ingest logic.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "ingest":
        return _run_ingest_cmd(parser, args)
    if args.command == "add-layouts":
        return _run_add_layouts_cmd(parser, args)
    if args.command == "refresh-manifest":
        return _run_refresh_manifest_cmd(parser, args)
    if args.command == "delete-layout":
        return _run_delete_layout_cmd(parser, args)
    if args.command == "set-roles":
        return _run_set_roles_cmd(parser, args)
    parser.print_help()
    return 2


def _run_ingest_cmd(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    column_roles = _column_roles(args)
    if column_roles is not None and not args.metadata:
        parser.error("--column-roles / role flags require --metadata (the source to join by filename)")

    payload = IngestJobPayload(
        dataset_id=args.dataset_id,
        owner=_resolve_owner(args.owner),
        images_dir=Path(args.images),
        csv_path=Path(args.metadata) if args.metadata else None,
        column_roles=column_roles,
        layout_types=[t.strip() for t in args.layout.split(",") if t.strip()],
        output_root=Path(args.output_root),
        detail_tier=args.detail_tier,
    )

    if not args.sync:
        print(
            "non-sync ingest enqueues through the API (auth + upload, decision D-18), "
            "which is deferred to the API seam. Re-run with --sync for a local inline ingest."
        )
        return 2

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    # R2: keep root INFO for the pipeline's own lines, but quiet pyvips' per-operation
    # logging — under basicConfig(INFO) it otherwise floods the log with several lines
    # per image op (multi-GB over a 1M corpus) and is a suspected drag on the tiler.
    logging.getLogger("pyvips").setLevel(logging.WARNING)
    version = run_ingest(payload)
    print(f"ingested dataset {args.dataset_id!r} -> version {version} under {args.output_root}")
    _print_ownership_next_steps(args.dataset_id, args.owner)
    return 0


def _run_add_layouts_cmd(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    """`pixscope add-layouts` — bake NEW layouts onto a committed dataset (T2-42),
    reusing its metadata.parquet + detail tier (both read-only). Each `--layout SPEC`
    is a layout_type ("categorical") or an expanded id ("categorical_kingdom"). An
    optional `--column-roles PATH` extends/overrides the committed roles."""
    column_roles = (
        json.loads(Path(args.column_roles_path).read_text(encoding="utf-8"))
        if args.column_roles_path
        else None
    )
    payload = AddLayoutsJobPayload(
        dataset_id=args.dataset_id,
        owner=_resolve_owner(args.owner),
        images_dir=Path(args.images),
        layout_specs=[spec for spec in args.layout if spec.strip()],
        output_root=Path(args.output_root),
        column_roles=column_roles,
        replace=tuple(spec for spec in args.replace if spec.strip()),
    )

    if not args.sync:
        print(
            "non-sync add-layouts enqueues through the API (auth + upload, decision D-18), "
            "which is deferred to the API seam. Re-run with --sync for a local inline bake."
        )
        return 2

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    # R2: quiet pyvips' per-operation logging on the CLI path (see _run_ingest_cmd).
    logging.getLogger("pyvips").setLevel(logging.WARNING)
    result = run_add_layouts(payload)
    print(
        f"added layouts to dataset {args.dataset_id!r} -> version "
        f"{result['dataset_version']} under {args.output_root}; committed={result['committed']}"
    )
    # A replace destroys the previous bake of that layout, so it is named on the console
    # rather than only in ingest.log — "committed=[scatter]" alone cannot tell an operator
    # whether they added a layout or overwrote hours of work.
    if result.get("replaced"):
        print(f"  RE-BAKED over the committed layout(s): {result['replaced']}")
    # add-layouts bakes onto an EXISTING tree, so it is the likelier no-op of the two
    # — but an unowned dataset is just as invisible after adding layouts to it as
    # before, and the operator has no other prompt. Same conditional wording.
    _print_ownership_next_steps(args.dataset_id, args.owner)
    return 0


def _run_refresh_manifest_cmd(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    """`pixscope refresh-manifest` — enrich an EXISTING bake's layout_manifest.json with
    the v2.5 annotations (categorical band labels + datetime axis domain) and per-layout
    bbox_exact, DERIVED from the committed metadata.parquet + baked position tables. No
    tiles/thumbs/detail are touched and NO bake runs, so a pre-2.5 dataset gains
    labels/axes/exact-binning in minutes. Offline (no API/Redis). The dataset_version does
    NOT bump — same bake, richer description — and a layout_manifest.json.bak is written
    first (once: an existing .bak — the pristine pre-enrichment copy — is never clobbered
    by a --force re-run; delete it to re-arm). Refuses an already-2.5-enriched manifest
    unless --force."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        result = run_refresh_manifest(
            dataset_id=args.dataset_id,
            output_root=Path(args.output_root),
            force=args.force,
            assume_roles_unchanged=args.assume_roles_unchanged,
        )
    except RefreshManifestError as exc:
        # An EXPECTED refusal (already enriched / unsafe to derive) — print the reason
        # cleanly and exit non-zero, no traceback.
        print(str(exc))
        return 2
    # A --force re-run does NOT rewrite the .bak (it preserves the pristine pre-enrichment
    # manifest) — say so rather than imply this run created it.
    backup_note = (
        result["backup"]
        if result.get("backup_written", True)
        else f"{result['backup']} (pre-existing pristine copy, preserved)"
    )
    print(
        f"refreshed manifest for dataset {args.dataset_id!r} -> manifest_version "
        f"{result['manifest_version']} (enriched {len(result['layouts'])} layout(s), "
        f"annotations on {result['annotations']}; dataset_version UNCHANGED) under "
        f"{args.output_root}. Backup: {backup_note}"
    )
    # v2.6 (T2-140 / D-36 seam U1): refresh derives `missing_count` and writes it over
    # whatever the manifest committed, so the run has to SAY what it wrote — the count is a
    # statement about the user's data ("N images this layout could not place"), and it must
    # not change silently.
    missing = result.get("missing_counts") or {}
    if missing:
        detail = ", ".join(f"{lid}: {n}" for lid, n in sorted(missing.items()))
        print(f"Unplaced cells recorded as missing_count — {detail}.")
    # The per-cell gate skip must reach the CONSOLE, not just ingest.log (the job logger
    # doesn't propagate) — a reduced verification margin should never look like a full pass.
    skipped = result.get("positions_gate_skipped") or []
    if skipped:
        print(
            f"WARNING: per-cell reproduction gate SKIPPED for layout(s) {skipped} — no "
            f"baked position table (a pre-2.2 bake); their bbox_exact/annotations/"
            f"missing_count rest on the 6-dp bbox gate alone."
        )
    # v2.10: which layouts can now say whether their bake is out of date — and, for the
    # rest, the exact flag and the assertion it makes. Never imply the flag: state what
    # the operator would be claiming and let them decide (LAYOUT_DESIGNER D-xxix).
    written = result.get("fingerprints_written") or []
    contradicted = result.get("assumption_contradicted") or []
    # The "still unchecked" list is the layouts this run could not record AND that carry no
    # record of their own — a layout that already has one is not unchecked, and telling the
    # operator to assert over it is how a durably stale layout gets laundered to fresh
    # (2026-09-23 review, finding 3). `assumption_contradicted` is the subset whose
    # existing record actively disagrees, and it needs the opposite advice.
    unwritten = [
        lid
        for lid in result["layouts"]
        if lid not in written and lid not in result.get("has_record", [])
    ]
    print(
        f"Recorded how {len(written)} layout(s) read their columns "
        f"(source_fingerprint, manifest 2.10): {written or 'none'}."
    )
    if unwritten:
        print(
            f"Layout(s) {unwritten} were NOT checked, so no fingerprint was recorded and "
            f"they stay 'unchecked' rather than 'fresh'. Re-run with "
            f"`--assume-roles-unchanged` only if no role has changed since this "
            f"collection was baked."
        )
    if contradicted:
        print(
            f"WARNING: layout(s) {contradicted} already record how they read their columns, "
            f"and that record DISAGREES with the committed roles — evidence that a role HAS "
            f"changed since the bake. --assume-roles-unchanged did NOT overwrite them. They "
            f"are durably stale: re-bake them with `pixscope add-layouts --replace <id>`."
        )
    return 0


def _run_delete_layout_cmd(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    """`pixscope delete-layout` — remove ONE committed layout and the bytes it owned
    (seam L2 / [[T2-a-layout-cannot-be-deleted-only-the-whole]]). No bake, no decode: the
    manifest is rewritten without that entry and its `tiles/{layout_id}/` +
    `positions/{layout_id}_v{N}.arrow` are swept AFTER the flip. `presentation.json` is
    left alone, including a `default_layout` this delete just orphaned (D-xvi: it falls
    back on read). Refuses to remove the LAST layout. Offline against the tree, like
    `refresh-manifest` — no --sync, no API, no Redis."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    payload = DeleteLayoutJobPayload(
        dataset_id=args.dataset_id,
        owner=_resolve_owner(args.owner),
        layout_id=args.layout,
        output_root=Path(args.output_root),
    )
    try:
        result = run_delete_layout(payload)
    except LayoutLifecycleError as exc:
        # An EXPECTED refusal (not committed / would leave zero layouts / a concurrent
        # writer landed) — print the reason cleanly and exit non-zero, no traceback.
        print(str(exc))
        return 2
    print(
        f"deleted layout {result['deleted']!r} from dataset {args.dataset_id!r} -> "
        f"dataset_version {result['dataset_version']}; remaining layouts="
        f"{result['layouts']} under {args.output_root}"
    )
    # The sweep is the irreversible half (D-xxii: free by the file test, and permanent),
    # so it is REPORTED rather than left to the log — an operator who expected bytes to go
    # and sees "swept 0 file(s)" has learned something, and so has one who did not.
    print(f"  swept {len(result['swept'])} file(s): {result['swept'] or 'none'}")
    return 0


def _run_set_roles_cmd(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    """`pixscope set-roles` — re-declare a committed dataset's `column_roles` with NO
    bake (seam L2 / [[T2-a-role-cannot-be-changed-without-also-queueing]]). The roles JSON
    REPLACES the committed map wholesale and is re-validated against the existing
    metadata.parquet exactly as `add-layouts --column-roles` validates it. Prints the
    stale set — which committed layouts the change invalidates — because that is the
    output the change is FOR, plus the three other buckets the edit can produce and
    nothing else reports: layouts whose provenance is unknown, layouts the roles can no
    longer produce (split into RENAMED and ORPHANED — opposite causes, opposite advice),
    and a tag sidecar that no longer matches the declared tag roles. Offline against the
    tree, like `refresh-manifest`."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    payload = SetRolesJobPayload(
        dataset_id=args.dataset_id,
        owner=_resolve_owner(args.owner),
        column_roles=json.loads(Path(args.column_roles_path).read_text(encoding="utf-8")),
        output_root=Path(args.output_root),
    )
    try:
        result = run_set_roles(payload)
    except LayoutLifecycleError as exc:
        print(str(exc))
        return 2
    print(
        f"set roles on dataset {args.dataset_id!r} -> manifest_version "
        f"{result['manifest_version']} (dataset_version {result['dataset_version']} "
        f"UNCHANGED — no bake) under {args.output_root}"
    )
    print(f"  columns whose role changed: {result['changed_columns'] or 'none'}")
    print(f"  layouts now STALE: {result['stale_layouts'] or 'none'}")
    # EVERY COMMAND BELOW IS COMPLETE AND RUNNABLE (2026-09-10 round-2 review finding B).
    # The first cut interpolated real ids into PARTIAL commands, so they read as
    # copy-pasteable while none of them ran. Measured 2026-09-10 by handing each to
    # `_build_parser().parse_args`, all four exit 2: `add-layouts --column-roles {path}`
    # and `add-layouts --layout {new_id}` (`--images`, `--dataset-id`, `--layout`),
    # `delete-layout --layout {old_id}` and `refresh-manifest --force` (`--dataset-id`) —
    # and an `add-layouts` without `--sync` parses but returns 2 without baking.
    # The rule is `_print_ownership_next_steps`': print the WHOLE command, and use a
    # `<placeholder>` only for what this process genuinely cannot know — which here is the
    # original images directory, since `set-roles` never receives one. Placeholders are
    # single tokens so a pasted line still splits the way a shell would.
    target = f"--dataset-id {args.dataset_id} --output-root {args.output_root}"
    bake = f"pixscope add-layouts --images <original-images-dir> {target}"
    delete = f"pixscope delete-layout {target}"
    # The two honest silences, printed rather than omitted. An empty stale set on a tree
    # full of pre-2.9 entries would otherwise read as "nothing was affected" when the
    # truth is "nothing recorded what it was built from".
    if result["unknown_layouts"]:
        # `--force` is REQUIRED, not optional decoration (2026-09-09 review finding 2).
        # `refresh-manifest` refuses without it whenever the manifest is >= 2.5 AND any
        # layout carries `bbox_exact`/`annotations` — and `bbox_exact` has been emitted on
        # EVERY layout since 2.5, so every 2.5-2.8 tree is "already enriched". 2.5-2.8 is
        # exactly the population that has unknown layouts (no `source_columns`, which
        # arrived at 2.9), so the plain command refuses on every tree this line is printed
        # for. Measured 2026-09-09 on `tests/fixtures/golden_dataset_full_v2` (stamped
        # 2.8, 6 `bbox_exact` keys, 3 `annotations` keys): exit 2, "already at
        # manifest_version '2.8' carrying the 2.5 enrichment — nothing to do."
        print(
            f"  layouts whose provenance is UNKNOWN (baked before manifest 2.9, so they "
            f"record no source_columns — staleness cannot be decided for them): "
            f"{result['unknown_layouts']}. `pixscope refresh-manifest {target} --force` "
            f"backfills it with no re-bake (`--force` because every tree at 2.5-2.8 "
            f"already carries the 2.5 enrichment, which refresh refuses to re-derive "
            f"without it)."
        )
        if result["orphaned_layouts"]:
            # The second half of the same trap: with an orphan present, refresh fails on
            # the unmappable-layout check instead, and --force does not help.
            print(
                f"  ...but not until {result['orphaned_layouts']} are resolved: refresh "
                f"refuses a manifest holding a layout it cannot reproduce from the roles, "
                f"with or without --force."
            )
    if result["renamed_layouts"]:
        # NOT the orphan message. These layouts kept their role AND their column pairing;
        # only the family's naming convention moved under them, and telling the operator
        # to delete a live layout because "the column lost its role" is both wrong and
        # destructive (finding 1). A layout whose columns changed is NOT in here — the
        # re-bake below would then place different data under the same name (finding A).
        for old_id, new_id in sorted(result["renamed_layouts"].items()):
            print(
                f"  NOTE: layout {old_id!r} would now be baked as {new_id!r} from the "
                f"SAME column(s) — the family's layout_id convention changed when the "
                f"number of declared entries crossed one. Its committed tiles are "
                f"untouched and still served. To adopt the new id, re-bake it with "
                f"`{bake} --layout {new_id} --sync` and then remove the old entry with "
                f"`{delete} --layout {old_id}`."
            )
    if result["orphaned_layouts"]:
        print(
            f"  WARNING: layout(s) {result['orphaned_layouts']} can no longer be produced "
            f"from these roles — no declared role reproduces those layout_ids from the "
            f"column(s) they were baked from. They keep serving their committed tiles, "
            f"but nothing can re-bake them: remove them with "
            f"`{delete} --layout <layout-id>`, or restore the role — for a scatter or "
            f"geographic layout, the exact column PAIR — they were baked from."
        )
    # The tag sidecar is the FOURTH bucket (finding 3): it is a BAKED asset, so a
    # roles-only edit can leave the declaration and the sidecar disagreeing in either
    # direction, and nothing else in this output would say so.
    if result["unserved_tag_roles"]:
        # The re-stage is a BAKE, so it needs a layout to bake: naming an already-committed
        # one with `--replace` is the form that always exists (a brand-new layout id would
        # do too, but there may not be one). The sidecar is staged ONCE PER RUN and
        # re-pointed on every flip, so which layout is named does not matter.
        print(
            f"  WARNING: tag role(s) {result['unserved_tag_roles']} are declared but the "
            f"committed tag sidecar does not carry them — each filter will come back "
            f"EMPTY in the viewer. Only a bake writes the sidecar: re-stage it with "
            f"`{bake} --layout <layout-id> --replace <layout-id> --column-roles "
            f"{args.column_roles_path} --sync`, naming any one committed layout (it is "
            f"re-baked; the sidecar is re-staged once for the run)."
        )
    if result["stale_tag_sidecar"]:
        # CLEARED, not merely reported (2026-09-10 round-2 review finding B2). This used to
        # say the block was "repointed only by a bake", and no bake repoints it:
        # `_stage_tags_sidecar` returns None when the roles carry no tag role, so
        # `append_manifest_layouts` carries the committed `tags` dict straight through
        # every `add-layouts` run. `set-roles` now removes the block itself — see
        # `run_set_roles`. The sidecar FILE is deliberately left where it is.
        print(
            f"  NOTE: these roles declare no tag column, so the manifest's `tags` block — "
            f"which pointed at {result['stale_tag_sidecar']!r} — has been REMOVED, and the "
            f"viewer stops offering filters for the role that is gone. The sidecar file "
            f"itself is left on disk, now referenced by nothing: no bake reads it and no "
            f"verb sweeps it, so delete it by hand if you want the bytes back."
        )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pixscope")
    sub = parser.add_subparsers(dest="command")
    ingest = sub.add_parser("ingest", help="ingest images (+ optional metadata) into a dataset tree")

    ingest.add_argument("--images", required=True, help="directory of source images")
    ingest.add_argument("--metadata", help="optional metadata CSV file (joined by filename)")
    ingest.add_argument("--dataset-id", required=True, dest="dataset_id")
    ingest.add_argument("--layout", default="grid", help="comma list: grid,datetime,categorical")
    # Detail-tier opt-out (T2-46) + retention (T2-175): "bake" (default) transcodes
    # every original into the version-stamped detail/ tier (the click-through/lightbox
    # source); "skip" bakes none — the fast path for CI/fixture bakes and corpora where
    # originals aren't wanted (no detail/ dir, no manifest detail block, null cell
    # detail refs); "retain" transcodes NOTHING and reuses the committed tier, for a
    # re-ingest over an UNCHANGED image set (new geometry / new metadata). Retention
    # FAILS CLOSED — no committed tier, or an image set that no longer matches the
    # committed metadata.parquet, REFUSES the run instead of quietly transcoding.
    ingest.add_argument(
        "--detail-tier",
        dest="detail_tier",
        default="bake",
        choices=["bake", "skip", "retain"],
        help=(
            "whether to bake the per-image detail tier (default: bake; skip = no "
            "originals; retain = reuse the committed tier untouched — refuses if the "
            "dataset has no committed tier or the image set changed)"
        ),
    )
    ingest.add_argument("--sync", action="store_true", help="run the ingest inline (no API/Redis)")
    # Default mirrors the API's output_root (decision D-30): dataset trees live
    # under a 'datasets/' subtree — ${DATA_ROOT}/datasets when DATA_ROOT is set,
    # else ./datasets — disjoint from the user upload jails the API keeps under
    # ${DATA_ROOT}/users/. The worker then writes {output_root}/{dataset_id}/.
    _data_root = os.environ.get("DATA_ROOT")
    _default_output_root = str(Path(_data_root) / "datasets") if _data_root else "datasets"
    ingest.add_argument(
        "--output-root",
        dest="output_root",
        default=_default_output_root,
        help=(
            "root under which /{dataset_id}/ is written; the dataset tree lives at "
            "{output_root}/{dataset_id}/ (decision D-30: datasets sit under a "
            "'datasets/' subtree). Default: ${DATA_ROOT}/datasets if DATA_ROOT is "
            "set, else ./datasets"
        ),
    )
    ingest.add_argument("--owner", default=None, help=_OWNER_HELP)

    # Column roles (only with --metadata): a JSON file (authoritative if given) or
    # convenience flags. The filename role is the join key to the image set.
    ingest.add_argument("--column-roles", dest="column_roles_path", help="path to a column_roles JSON file")
    ingest.add_argument("--filename", default="filename", help="metadata column naming the image file (join key)")
    ingest.add_argument("--filename-label", dest="filename_label", help="filename column label")
    ingest.add_argument("--datetime", help="datetime column name")
    ingest.add_argument(
        "--datetime-format",
        dest="datetime_format",
        default="iso8601",
        choices=["iso8601", "unix_seconds", "unix_millis"],
    )
    ingest.add_argument("--categorical", action="append", default=[], help="categorical column (repeatable)")
    ingest.add_argument("--tag", action="append", default=[], help="tag column as NAME or NAME:DELIM (repeatable)")
    ingest.add_argument("--freeform", action="append", default=[], help="freeform column (repeatable)")

    # add-layouts (T2-42): bake NEW layouts onto an already-committed dataset,
    # reusing its metadata.parquet + detail tier (read-only). Reuses ingest's
    # --images / --dataset-id / --output-root / --owner / --sync plumbing; --layout
    # here is REPEATABLE (each value a layout_type or an expanded layout id), unlike
    # ingest's comma list, because an expanded id may itself contain a comma-free slug.
    add_layouts = sub.add_parser(
        "add-layouts",
        help="bake additional layouts onto an existing committed dataset (no full re-ingest)",
    )
    add_layouts.add_argument("--images", required=True, help="the ORIGINAL source images (must match the committed dataset)")
    add_layouts.add_argument("--dataset-id", required=True, dest="dataset_id")
    add_layouts.add_argument(
        "--layout",
        action="append",
        default=[],
        required=True,
        help='layout to add (repeatable): a layout_type ("categorical") or an expanded id ("categorical_kingdom")',
    )
    add_layouts.add_argument("--sync", action="store_true", help="run the bake inline (no API/Redis)")
    add_layouts.add_argument(
        "--output-root",
        dest="output_root",
        default=_default_output_root,
        help="root under which /{dataset_id}/ lives (default matches ingest's, decision D-30)",
    )
    add_layouts.add_argument("--owner", default=None, help=_OWNER_HELP)
    add_layouts.add_argument(
        "--column-roles",
        dest="column_roles_path",
        help="optional column_roles JSON that REPLACES the committed roles (re-validated against the existing metadata.parquet)",
    )
    # --replace (seam L2 / [[T2-add-layouts-cannot-replace-a-committed-layout]]): opt in,
    # PER LAYOUT, to re-baking a layout that is already committed. Without it the
    # collision guard is exactly what it always was and refuses every existing id --
    # the silent overwrite is the footgun this area was hardened against, so this is a
    # per-id opt-out and deliberately not a --force mode. Each id must also be passed
    # with --layout (it has to be in the bake plan) and must already be committed.
    add_layouts.add_argument(
        "--replace",
        action="append",
        default=[],
        metavar="LAYOUT_ID",
        help=(
            "RE-BAKE this already-committed layout instead of refusing the collision "
            "(repeatable). The layout_id and its position in the switcher are preserved, "
            "and the superseded tiles + position table are swept after the flip. Must "
            "also be passed with --layout"
        ),
    )

    # refresh-manifest (T2-69/T2-72 Seam 2 backfill): enrich an EXISTING bake's manifest
    # with the v2.5 annotations (categorical band labels + datetime axis domain) +
    # bbox_exact, DERIVED from the committed metadata.parquet + baked position tables. No
    # bake, no tiles/thumbs/detail touched; the dataset_version does NOT bump (same bake,
    # richer description). Offline against the tree — no --images, no --sync, no API/Redis.
    refresh = sub.add_parser(
        "refresh-manifest",
        help="enrich an existing bake's manifest with v2.5 labels/axes/bbox_exact (no re-bake)",
    )
    refresh.add_argument("--dataset-id", required=True, dest="dataset_id")
    refresh.add_argument(
        "--output-root",
        dest="output_root",
        default=_default_output_root,
        help="root under which /{dataset_id}/ lives (default matches ingest's, decision D-30)",
    )
    refresh.add_argument(
        "--force",
        action="store_true",
        help="re-derive + overwrite even if the manifest is already 2.5-enriched (e.g. after a layout-plugin change)",
    )
    # v2.10 (LAYOUT_DESIGNER D-xxix). Refresh records `source_fingerprint` — HOW each
    # layout read its columns — only where its per-cell gate PROVED the committed roles
    # reproduce the baked positions. This flag is the operator supplying the one thing the
    # software cannot check, and the help text states the assertion rather than describing
    # the flag, because that assertion is what is being taken on trust.
    refresh.add_argument(
        "--assume-roles-unchanged",
        dest="assume_roles_unchanged",
        action="store_true",
        help=(
            "assert that NO ROLE HAS CHANGED since this collection was baked, so the v2.10 "
            "source_fingerprint is recorded for the layouts the per-cell reproduction gate "
            "could not check (those with no baked position table). Without it those layouts "
            "keep whatever they had and stay 'unchecked' -- which is the honest default"
        ),
    )

    # delete-layout (seam L2 / [[T2-a-layout-cannot-be-deleted-only-the-whole]]): remove
    # ONE committed layout — the manifest entry, its tiles/ container and its position
    # table. No bake and no decode, so it runs offline against the tree exactly like
    # refresh-manifest (no --images, no --sync, no API/Redis). Refuses to remove the last
    # layout, and never touches presentation.json (D-xvi: a default_layout naming the
    # deleted layout is left to fall back on read).
    delete_layout = sub.add_parser(
        "delete-layout",
        help="remove one committed layout and the bytes it owned (no re-bake)",
    )
    delete_layout.add_argument("--dataset-id", required=True, dest="dataset_id")
    delete_layout.add_argument(
        "--layout",
        required=True,
        help="the committed layout_id to remove (e.g. 'categorical_kingdom')",
    )
    delete_layout.add_argument(
        "--output-root",
        dest="output_root",
        default=_default_output_root,
        help="root under which /{dataset_id}/ lives (default matches ingest's, decision D-30)",
    )
    delete_layout.add_argument("--owner", default=None, help=_OWNER_HELP)

    # set-roles (seam L2 / [[T2-a-role-cannot-be-changed-without-also-queueing]]):
    # re-declare column_roles with NO bake. Until now `column_roles` could only ride as a
    # passenger on `ingest` or on an `add-layouts` bake, so D-ix's declared-but-
    # invalidating tier had no write path and a layout could never be left honestly
    # stale. Offline against the tree, like refresh-manifest and delete-layout.
    set_roles = sub.add_parser(
        "set-roles",
        help="re-declare a committed dataset's column_roles with no bake, and report what it stales",
    )
    set_roles.add_argument("--dataset-id", required=True, dest="dataset_id")
    set_roles.add_argument(
        "--column-roles",
        dest="column_roles_path",
        required=True,
        help=(
            "path to a column_roles JSON file that REPLACES the committed roles "
            "wholesale (not a patch), re-validated against the existing metadata.parquet"
        ),
    )
    set_roles.add_argument(
        "--output-root",
        dest="output_root",
        default=_default_output_root,
        help="root under which /{dataset_id}/ lives (default matches ingest's, decision D-30)",
    )
    set_roles.add_argument("--owner", default=None, help=_OWNER_HELP)
    return parser


def _column_roles(args: argparse.Namespace) -> dict | None:
    """Build the column_roles dict, or None for an images-only ingest (no
    --metadata, no --column-roles). A --column-roles JSON file overrides the
    convenience flags entirely."""
    if args.column_roles_path:
        return json.loads(Path(args.column_roles_path).read_text(encoding="utf-8"))
    if not args.metadata:
        return None  # images-only floor (decision D-25)

    roles: dict = {"filename": {"column": args.filename, "label": args.filename_label or args.filename}}
    if args.datetime:
        roles["datetime"] = {"column": args.datetime, "label": args.datetime, "format": args.datetime_format}
    if args.categorical:
        roles["categorical"] = [{"column": c, "label": c} for c in args.categorical]
    if args.tag:
        tags = []
        for spec in args.tag:
            column, sep, delimiter = spec.partition(":")
            tags.append({"column": column, "label": column, "delimiter": delimiter if sep else ","})
        roles["tag"] = tags
    if args.freeform:
        roles["freeform"] = [{"column": c, "label": c} for c in args.freeform]
    return roles
