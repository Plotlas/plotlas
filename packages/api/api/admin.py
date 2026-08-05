"""Server-side operator admin CLI for the API app-state store.

Run INSIDE the api container (it targets the running api's app-state DB and
imports its ORM), e.g.::

    docker compose exec api python -m api.admin create-user <username> <email>
    docker compose exec api python -m api.admin assign-owner <dataset_id> <username>
    docker compose exec api python -m api.admin set-visibility <dataset_id> public
    docker compose exec api python -m api.admin list-unassigned
    docker compose exec api python -m api.admin list-datasets

**Authorization model — reachability IS the authorization.** These commands
perform NO authentication and issue NO token. Whoever can run them already has
server/container access: they can delete the dataset directory or run the
pipeline directly, so being able to invoke these is, by construction, the
authority to manage users and ownership. They are deliberately NOT web
capabilities — the open "any authenticated user claims an unowned dataset" model
was rejected by the operator, because ownership assignment (including *giving* a
dataset to another named user WITHOUT that user's password) belongs to the server
operator, not to arbitrary logged-in users. `create-user` is the same posture: an
operator provisioning an account (with a printed random password to rotate) is a
server action, not an open web capability.

Ownership and users live ONLY in the API app-state store (appstate.py, SQLite),
never in the manifest, the dataset tree, or the JWT (decisions D-18/D-22/D-24).
These commands are a second writer of the SAME app-state DB the running api
serves, from a standalone process — they initialize the engine/session exactly as
the api lifespan does (appstate.setup_appstate), so they hit the same DB file and
the same tables. They touch app-state only; they never read or write the
read-only dataset Parquet/tile path (that is db.py's domain).

`create-user` provisions an account WITHOUT the web signup flow (the #110
follow-up): it generates a random password, prints it ONCE to stdout with a
rotate-on-first-login note (never storing plaintext — only the argon2 hash), and
applies the SAME username/email validation the signup route uses (`SignupRequest`,
reused — not re-implemented). Together with `assign-owner` this completes the
operator flow — `create-user` then `assign-owner` — so a user can own a CLI-baked
dataset without ever signing up through the web first (T2-65 / T2-12).

`assign-owner` upserts the `dataset -> owner` row (last-writer-wins), so it both
assigns an unowned dataset AND reassigns an owned one — an operator reassigning a
dataset is the point, not an accident.

`set-visibility` flips a dataset's D-34 read visibility between `public` (readable by
anyone, including anonymously — the login-less showcase) and `private` (owner-only).
It requires an existing app-state row (the row carries the owner FK), so the showcase
flow is `create-user` -> `assign-owner` -> `set-visibility <id> public`; publishing a
CLI-transferred/unowned tree therefore goes through assign-owner first. This is the
operator lever that lights up the public exhibition.

`list-unassigned` and `list-datasets` are the READ side of that flow (seam O1). A
dataset baked by the pipeline CLI writes only the on-disk tree; ownership is a
SEPARATE app-state write, so a bake with no `assign-owner` is on disk but absent from
`GET /api/datasets` (routers/datasets.py filters every summary with no app-state
record — "do NOT surface unowned trees as world-readable"). That silence was the O1
defect: diagnosing it needed a hand-written SQLite query against the live DB.
`list-unassigned` answers "which baked datasets is nobody going to see?" (splitting
the ones assign-owner can fix from the ones an unservable manifest keeps invisible),
and `list-datasets` shows owner + visibility + on-disk for every dataset app-state or
the tree knows about. Both are read-only (no app-state write); a successful query
exits 0 — "no rows" is an answer, not a failure, so an operator piping them need not
distinguish empty from error (an infrastructure failure to open app-state still exits
non-zero with a message, as everywhere else here).
"""

from __future__ import annotations

import argparse
import asyncio
import difflib
import secrets
import sys

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api import appstate, db
from api.routers.auth import SignupRequest

# Length (bytes of entropy) of the generated one-time password. secrets.token_urlsafe
# yields ~1.3 chars/byte of URL-safe text, comfortably over the signup rule's 8-char
# floor — this is a throwaway credential the operator hands over to rotate, not a
# memorized secret.
_GENERATED_PASSWORD_BYTES = 18


async def _all_usernames(session: AsyncSession) -> list[str]:
    """Every provisioned username, sorted. Used only to make a failed lookup
    actionable (an empty table means "no users exist at all", and a near-miss is
    almost always a typo — the O1 defect was `dale` vs `dalew`)."""
    result = await session.execute(select(appstate.User.username))
    return sorted(result.scalars().all())


def _no_such_user_message(username: str, usernames: list[str]) -> str:
    """The specific, next-step-naming message for an owner that does not exist.

    Three distinct cases, because they need three different actions:
    * NO users at all — the app-state store has never been provisioned, so the only
      possible next step is create-user.
    * A near-miss — `difflib.get_close_matches` at its stdlib defaults (n=3,
      cutoff=0.6; deliberately not our own tuned constants). This is the O1 case:
      `dale` was accepted silently by the pipeline CLI when the account was `dalew`.
    * No near-miss — say how many accounts exist, and name create-user.
    """
    if not usernames:
        return (
            f"no such user: {username} — in fact NO users exist yet in app-state. "
            f"Create one first:\n"
            f"    python -m api.admin create-user {username} <email>"
        )
    suggestions = difflib.get_close_matches(username, usernames)
    if suggestions:
        return (
            f"no such user: {username} — did you mean: {', '.join(suggestions)}?\n"
            f"    python -m api.admin create-user {username} <email>   "
            f"(if {username} really is a new account)"
        )
    return (
        f"no such user: {username} ({len(usernames)} account(s) exist). Create it "
        f"first:\n"
        f"    python -m api.admin create-user {username} <email>"
    )


async def _assign_owner(session: AsyncSession, dataset_id: str, username: str) -> str:
    """Assign (or reassign) `dataset_id` to `username` in app-state.

    Preconditions are checked by the caller (the dataset exists on disk, the user
    exists). Reads the PREVIOUS owner, then upserts via
    appstate.record_dataset_owner (which commits) — UNLESS the owner is already
    `username`, in which case the write is skipped so a re-run is a true no-op (the
    caller reports "nothing changed"; without the skip that message contradicted a
    redundant UPDATE+commit that had just fired). Returns the previous owner string,
    or "" when the dataset was unowned — the caller renders it.
    """
    previous = await appstate.get_dataset_owner(session, dataset_id)
    if (previous or "") != username:
        await appstate.record_dataset_owner(session, dataset_id, username)
    return previous or ""


async def _run_assign_owner(dataset_id: str, username: str) -> int:
    """Async body of `assign-owner`: initialize the app-state engine/session the
    same way the api lifespan does (so it targets the running api's DB + tables),
    validate the dataset exists on disk and the user exists in app-state, then
    upsert the owner. Returns the process exit code."""
    # Jail the id under DATA_ROOT/datasets/ and require the dataset be present on
    # disk (D-30). db.dataset_dir raises an HTTPException on a traversal/absolute
    # id (it is an API helper); in this CLI that is just "no such dataset".
    try:
        ds_dir = db.dataset_dir(db.resolve_data_root(), dataset_id)
        on_disk = db.is_dataset(ds_dir)
    except HTTPException:
        on_disk = False
    if not on_disk:
        # Name the next step here too: the usual cause is a bake that went to a
        # different --output-root, or a typo'd id, and list-datasets shows both what
        # is on disk and what app-state alone knows about.
        print(
            f"no such dataset on disk: {dataset_id} — see what is there:\n"
            f"    python -m api.admin list-datasets",
            file=sys.stderr,
        )
        return 1

    engine, sessionmaker = await appstate.setup_appstate()
    try:
        async with sessionmaker() as session:
            # Require the target user to EXIST (owner is a FK to users.username;
            # the FK would reject an unknown owner anyway, but pre-check so the
            # operator gets a clean message instead of an IntegrityError). The
            # "must already exist" rule is unchanged — only the message improved:
            # it now distinguishes an empty user table from a typo (O1).
            result = await session.execute(
                select(appstate.User).where(appstate.User.username == username)
            )
            if result.scalar_one_or_none() is None:
                usernames = await _all_usernames(session)
                print(_no_such_user_message(username, usernames), file=sys.stderr)
                return 1

            previous = await _assign_owner(session, dataset_id, username)
    finally:
        await engine.dispose()

    # Name WHO held it before, distinctly per case — "already owned by X" is a
    # different fact from "reassigned away from X", and both differ from a first
    # assignment (the O1 case, which is the one that needs the follow-on step).
    if not previous:
        print(f"assigned dataset {dataset_id!r} -> owner {username!r} (was: <none>)")
        print(
            f"{username!r} will now see {dataset_id!r} in the library. To publish it "
            f"to logged-out visitors as well:\n"
            f"    python -m api.admin set-visibility {dataset_id} public"
        )
    elif previous == username:
        print(
            f"dataset {dataset_id!r} was ALREADY owned by {username!r} — "
            f"nothing changed"
        )
    else:
        print(
            f"reassigned dataset {dataset_id!r} -> owner {username!r} "
            f"(was: {previous})"
        )
    return 0


async def _run_create_user(username: str, email: str) -> int:
    """Async body of `create-user`: validate username/email with the SAME rules the
    web signup route enforces (reusing `SignupRequest`, not re-implementing them),
    generate a random password, create the user with only its argon2 HASH stored, and
    print the one-time password once. Fails non-zero (no write) on invalid input or a
    duplicate username/email. Returns the process exit code.

    The generated password is the ONLY moment the plaintext exists — it is printed for
    the operator to hand over and rotate, and never persisted. Mirrors the signup
    route: hash_password + the unique username/email DB constraints (a conflict on
    either raises IntegrityError → a clean non-zero exit)."""
    # Reuse the signup contract for validation: username charset/length + a real
    # email. The password we generate always satisfies the min-length rule, so build
    # SignupRequest with the generated password to run the exact same checks the web
    # path runs (no duplicated regex/rules here). A bad username/email raises
    # ValidationError → non-zero, nothing written.
    password = secrets.token_urlsafe(_GENERATED_PASSWORD_BYTES)
    try:
        SignupRequest(username=username, email=email, password=password)
    except ValidationError as exc:
        # Surface the first concrete problem (bad username charset/length, or a
        # malformed email) rather than the whole pydantic dump.
        first = exc.errors()[0]
        field = ".".join(str(loc) for loc in first.get("loc", ())) or "input"
        print(f"invalid {field}: {first.get('msg', 'invalid value')}", file=sys.stderr)
        return 1

    engine, sessionmaker = await appstate.setup_appstate()
    try:
        async with sessionmaker() as session:
            session.add(
                appstate.User(
                    username=username,
                    email=email,
                    password_hash=appstate.hash_password(password),
                )
            )
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                print(
                    f"user already exists (username or email in use): "
                    f"{username} / {email}",
                    file=sys.stderr,
                )
                return 1
    finally:
        await engine.dispose()

    # Print the one-time password ONCE. Only stdout — never logged or stored.
    print(f"created user {username!r} ({email})")
    print(f"one-time password: {password}")
    print("Rotate this on first login — it is shown here once and never stored.")
    # An account on its own still shows an EMPTY library: creating a user and
    # assigning a dataset are two writes, and only the second one makes a baked tree
    # visible. Name the second step here rather than leaving the operator to find it.
    print(
        f"Next, give {username!r} a dataset (see `list-unassigned` for candidates):\n"
        f"    python -m api.admin assign-owner <dataset_id> {username}"
    )
    return 0


async def _run_list_unassigned() -> int:
    """Async body of `list-unassigned`: datasets ON DISK with NO app-state row.

    An unowned tree is invisible to every caller — `GET /api/datasets` drops any
    dataset with no record — owner and anonymous alike. But recording an owner only
    MAKES it visible if the API can serve its manifest, so the on-disk-unowned trees
    are split: SERVABLE ones (assign-owner is the fix) and UNSERVABLE ones — an
    unsupported/future manifest major, or a corrupt/unreadable manifest — which the
    listing drops even once owned, so assign-owner is NOT their fix. Reporting the
    second group as fixable was the trap this seam exists to remove. Read-only; a
    successful query exits 0 ("none found" is an answer, not a failure). Also reports
    an EMPTY users table, because then `assign-owner` cannot succeed for anyone yet and
    create-user is the real next step."""
    root = db.datasets_root()
    on_disk = db.ondisk_dataset_ids(root)

    engine, sessionmaker = await appstate.setup_appstate()
    try:
        async with sessionmaker() as session:
            records = await appstate.list_dataset_records(session)
            usernames = await _all_usernames(session)
    finally:
        await engine.dispose()

    known = {record.dataset_id for record in records}
    unassigned = [ds_id for ds_id in on_disk if ds_id not in known]
    # Which unowned trees would actually list once owned? A single load-check per
    # dataset (db.dataset_is_servable), so we never prescribe assign-owner for a tree
    # that stays invisible even with an owner (the version-skew / corrupt-manifest bake).
    fixable: list[str] = []
    unservable: list[str] = []
    for ds_id in unassigned:
        (fixable if db.dataset_is_servable(root / ds_id) else unservable).append(ds_id)

    if not unassigned:
        print(f"no unassigned datasets ({len(on_disk)} on disk, all have an owner)")
        return 0

    if fixable:
        print(f"{len(fixable)} unassigned dataset(s) — on disk, but NOT in any library:")
        for ds_id in fixable:
            print(f"  {ds_id}")
        if not usernames:
            print(
                "\nNo users exist yet, so there is nobody to assign these to. Create an "
                "account first:\n"
                "    python -m api.admin create-user <username> <email>"
            )
        else:
            print(
                f"\nAssign each to one of the {len(usernames)} existing account(s):\n"
                f"    python -m api.admin assign-owner {fixable[0]} <username>"
            )

    if unservable:
        print(
            f"\n{len(unservable)} dataset(s) are on disk but their manifest cannot be "
            f"served (unsupported version, corrupt, or unreadable) — assign-owner will "
            f"NOT make these visible; re-bake or upgrade the API. See list-datasets:"
        )
        for ds_id in unservable:
            print(f"  {ds_id}")
    return 0


async def _run_list_datasets() -> int:
    """Async body of `list-datasets`: owner + visibility + on-disk for EVERY dataset
    app-state or the tree knows about.

    The diagnostic view. Ownership (app-state) and the bake (the on-disk tree) are
    written by two different processes, so the interesting states are the ones where
    they disagree: on disk with no owner (invisible — `list-unassigned`), and a
    record with no tree (a create whose ingest never landed, which the API reports as
    processing/error). ON_DISK is three-valued — `yes` (the manifest serves),
    `unservable` (on disk but load_manifest fails, so invisible even once owned), `no`
    (an app-state row with no tree). All shown here, in one place, instead of the
    hand-written SQLite query that diagnosing O1 actually took. Read-only; a successful
    query exits 0."""
    root = db.datasets_root()
    on_disk = set(db.ondisk_dataset_ids(root))

    engine, sessionmaker = await appstate.setup_appstate()
    try:
        async with sessionmaker() as session:
            records = await appstate.list_dataset_records(session)
    finally:
        await engine.dispose()

    by_id = {record.dataset_id: record for record in records}
    ds_ids = sorted(on_disk | set(by_id))
    if not ds_ids:
        print(f"no datasets (nothing under {root}, no app-state rows)")
        return 0

    def _ondisk_state(ds_id: str) -> str:
        if ds_id not in on_disk:
            return "no"
        return "yes" if db.dataset_is_servable(root / ds_id) else "unservable"

    # Build the rows first, then size every column from the data — ids, usernames and
    # visibility literals are all caller data, so any hand-picked pad is wrong for
    # someone (a long username would silently break the alignment it was meant to
    # give). `<unassigned>` is the ownerless marker, matching the "" the API summary
    # uses for the same state but naming it, since naming it IS the point here.
    rows = [
        (
            ds_id,
            by_id[ds_id].owner if ds_id in by_id else "<unassigned>",
            by_id[ds_id].visibility if ds_id in by_id else "-",
            _ondisk_state(ds_id),
        )
        for ds_id in ds_ids
    ]
    header = ("DATASET_ID", "OWNER", "VISIBILITY", "ON_DISK")
    widths = [max(len(cell) for cell in column) for column in zip(header, *rows)]
    for row in (header, *rows):
        print("  ".join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())
    unassigned = sum(1 for _, owner, _, _ in rows if owner == "<unassigned>")
    if unassigned:
        print(
            f"\n{unassigned} dataset(s) have NO owner and are therefore invisible in "
            f"the library:\n"
            f"    python -m api.admin assign-owner <dataset_id> <username>"
        )
    unservable = sum(1 for _, _, _, ondisk in rows if ondisk == "unservable")
    if unservable:
        print(
            f"\n{unservable} dataset(s) are ON_DISK=unservable — the manifest cannot be "
            f"served (unsupported version, corrupt, or unreadable), so they stay "
            f"invisible even with an owner; re-bake or upgrade the API."
        )
    return 0


async def _run_set_visibility(dataset_id: str, visibility: str) -> int:
    """Async body of `set-visibility`: initialize the app-state engine/session the
    same way the api lifespan does (so it targets the running api's DB + tables),
    require the dataset present on disk (like assign-owner) AND known to app-state,
    then set its D-34 visibility. Returns the process exit code.

    The dataset must already have an app-state row: the row carries the owner FK, so
    an unowned/CLI-transferred tree must be `assign-owner`'d before it can be
    published — set_dataset_visibility returns False for a missing row and this prints
    the actionable next step (no write). This is the operator's showcase lever: flip a
    curated dataset public and its `/datasets/*` bytes serve with no login."""
    # Jail the id under DATA_ROOT/datasets/ and require the dataset on disk (D-30),
    # exactly as assign-owner does. db.dataset_dir raises an HTTPException on a
    # traversal/absolute id (it is an API helper); here that is just "no such dataset".
    try:
        ds_dir = db.dataset_dir(db.resolve_data_root(), dataset_id)
        on_disk = db.is_dataset(ds_dir)
    except HTTPException:
        on_disk = False
    if not on_disk:
        print(f"no such dataset on disk: {dataset_id}", file=sys.stderr)
        return 1

    engine, sessionmaker = await appstate.setup_appstate()
    try:
        async with sessionmaker() as session:
            updated = await appstate.set_dataset_visibility(
                session, dataset_id, visibility
            )
    finally:
        await engine.dispose()

    if not updated:
        print(
            f"dataset {dataset_id!r} has no app-state record; assign an owner first: "
            f"python -m api.admin assign-owner {dataset_id} <username>",
            file=sys.stderr,
        )
        return 1
    print(f"set dataset {dataset_id!r} visibility -> {visibility}")
    return 0


async def _run_set_presentation(dataset_id: str, field: str, value: str) -> int:
    """Async body of `set-display-name` / `set-attribution` / `set-attribution-url`
    (Part B/D) — one function for every presentation field, since the dict payload is the
    "which field" signal (PR250-6). Same shape as set-visibility: require the dataset on
    disk AND known to app-state, then write.

    An EMPTY value clears the field — `set-display-name <id> ""` reverts the library
    to showing the raw id. That is the recovery path for a bad name, so it must be
    expressible from the CLI, not only from the UI.

    Presentation only: `dataset_id` is never touched, so renaming cannot strand a
    deep link or move anything on disk."""
    try:
        ds_dir = db.dataset_dir(db.resolve_data_root(), dataset_id)
        on_disk = db.is_dataset(ds_dir)
    except HTTPException:
        on_disk = False
    if not on_disk:
        print(f"no such dataset on disk: {dataset_id}", file=sys.stderr)
        return 1

    engine, sessionmaker = await appstate.setup_appstate()
    try:
        async with sessionmaker() as session:
            # One {field: value} — the dict IS the "which fields" signal (PR250-6), so
            # the CLI no longer has to synthesize set_<field> booleans.
            updated = await appstate.set_dataset_presentation(
                session, dataset_id, {field: value}
            )
    except appstate.PresentationValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        await engine.dispose()

    if not updated:
        print(
            f"dataset {dataset_id!r} has no app-state record; assign an owner first: "
            f"python -m api.admin assign-owner {dataset_id} <username>",
            file=sys.stderr,
        )
        return 1
    shown = value.strip()
    if shown == "":
        print(f"cleared dataset {dataset_id!r} {field}")
    else:
        print(f"set dataset {dataset_id!r} {field} -> {shown!r}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m api.admin",
        description=(
            "Server-side operator commands for the API app-state store. "
            "Reachability is the authorization (no auth, no token); run inside "
            "the api container."
        ),
    )
    # A subcommand-per-verb layout so future operator verbs (e.g. list-owners)
    # slot in beside these without reshaping the CLI.
    sub = parser.add_subparsers(dest="command")
    create = sub.add_parser(
        "create-user",
        help="provision a user account (prints a one-time random password)",
        description=(
            "Create USERNAME with EMAIL in app-state WITHOUT the web signup flow. "
            "Generates a random password, prints it ONCE (rotate on first login — "
            "never stored, only its hash), and applies the same username/email "
            "validation as the signup route. Fails (no write) if the username or "
            "email is already in use. Pair with assign-owner to hand a CLI-baked "
            "dataset to a user who never signed up."
        ),
    )
    create.add_argument("username", help="the new user's name (charset [A-Za-z0-9._-], <=64)")
    create.add_argument("email", help="the new user's email (must be a valid address)")
    assign = sub.add_parser(
        "assign-owner",
        help="assign (or reassign) a dataset's owner to an existing user",
        description=(
            "Assign DATASET_ID to USERNAME in app-state. Upserts (last-writer-"
            "wins), so it assigns an unowned dataset or reassigns an owned one. "
            "The dataset must exist on disk under DATA_ROOT/datasets/ and the "
            "user must already exist; no password is required for the target user."
        ),
    )
    assign.add_argument("dataset_id", help="the dataset id (DATA_ROOT/datasets/<id>/)")
    assign.add_argument("username", help="the target owner (must already exist)")
    setvis = sub.add_parser(
        "set-visibility",
        help="set a dataset's visibility (public|private) for the D-34 read model",
        description=(
            "Set DATASET_ID visibility to public or private (D-34). public => readable "
            "by anyone, including anonymously (the login-less showcase — its /datasets/* "
            "bytes serve with no login); private => owner-only. The dataset must exist on "
            "disk under DATA_ROOT/datasets/ AND already have an app-state owner "
            "(assign-owner first — the app-state row carries the required owner). This is "
            "the operator lever that publishes curated showcase datasets."
        ),
    )
    setvis.add_argument("dataset_id", help="the dataset id (DATA_ROOT/datasets/<id>/)")
    setvis.add_argument(
        "visibility",
        choices=["public", "private"],
        help="public (readable by anyone, incl. anonymously) | private (owner-only)",
    )
    setname = sub.add_parser(
        "set-display-name",
        help="set (or clear) what a collection is CALLED in the library and viewer",
        description=(
            "Set DATASET_ID's display name (SCOPE_shareable-collections Part B). "
            "Presentation ONLY: the dataset id stays the app-state key, the on-disk "
            "directory name, the tile path and the deep-link target, so renaming can "
            "never break a link someone has already shared. Pass an EMPTY string to "
            'clear it and go back to showing the raw id: set-display-name my_ds "". '
            "The dataset must exist on disk AND have an app-state owner "
            "(assign-owner first)."
        ),
    )
    setname.add_argument("dataset_id", help="the dataset id (DATA_ROOT/datasets/<id>/)")
    setname.add_argument(
        "name",
        help='what to call it (e.g. "Rijksmuseum — Public Domain"); "" clears it',
    )
    setattr_ = sub.add_parser(
        "set-attribution",
        help="set (or clear) the source credit shown with a collection",
        description=(
            "Set DATASET_ID's attribution — who the collection came FROM, e.g. "
            '"Rijksmuseum, Amsterdam". Shown on the library card and in the viewer footer. Free text: there '
            "is no registry to validate against. Pass an EMPTY string to clear it. "
            "The dataset must exist on disk AND have an app-state owner "
            "(assign-owner first)."
        ),
    )
    setattr_.add_argument(
        "dataset_id", help="the dataset id (DATA_ROOT/datasets/<id>/)"
    )
    setattr_.add_argument(
        "attribution", help='the source credit; "" clears it'
    )
    seturl = sub.add_parser(
        "set-attribution-url",
        help="set (or clear) an optional link target for the attribution",
        description=(
            "Set DATASET_ID's attribution URL — where the credit LINKS to, e.g. "
            '"https://www.rijksmuseum.nl". Separate from the credit TEXT so a '
            "collection can carry a readable name AND a link. Rendered as an anchor "
            "only when it is an absolute http(s) URL; anything else leaves the credit "
            "as plain text, so a bad target loses the link, never the credit. Pass an "
            "EMPTY string to clear it."
        ),
    )
    seturl.add_argument("dataset_id", help="the dataset id (DATA_ROOT/datasets/<id>/)")
    seturl.add_argument("url", help='the link target; "" clears it')
    sub.add_parser(
        "list-unassigned",
        help="list datasets on disk with NO owner (invisible in the library)",
        description=(
            "List every dataset present under DATA_ROOT/datasets/ that has NO "
            "app-state record. These are baked trees nobody can see: GET "
            "/api/datasets drops any dataset with no record, so an unassigned "
            "dataset is invisible to every caller. Servable ones list once you run "
            "assign-owner; datasets whose manifest cannot be served (unsupported "
            "version, corrupt, or unreadable) are reported separately because "
            "assign-owner will NOT make those visible. Read-only; a successful query "
            "exits 0."
        ),
    )
    sub.add_parser(
        "list-datasets",
        help="list every dataset with its owner, visibility, and on-disk state",
        description=(
            "List every dataset app-state or the on-disk tree knows about, with its "
            "owner, D-34 visibility, and on-disk state (yes | unservable | no). The "
            "diagnostic view: an on-disk dataset with no owner is invisible in the "
            "library; ON_DISK=unservable means the tree is present but its manifest "
            "cannot be served (invisible even with an owner); an app-state row with no "
            "tree is a create whose ingest never landed. Read-only; a successful query "
            "exits 0."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    """Entry point for `python -m api.admin`. Parses the subcommand and drives its
    async body with asyncio.run (app-state is async over aiosqlite). With no
    subcommand, prints help and returns 2. Returns the process exit code."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "create-user":
        return asyncio.run(_run_create_user(args.username, args.email))
    if args.command == "assign-owner":
        return asyncio.run(_run_assign_owner(args.dataset_id, args.username))
    if args.command == "set-visibility":
        return asyncio.run(_run_set_visibility(args.dataset_id, args.visibility))
    if args.command == "set-display-name":
        return asyncio.run(
            _run_set_presentation(args.dataset_id, "display_name", args.name)
        )
    if args.command == "set-attribution":
        return asyncio.run(
            _run_set_presentation(args.dataset_id, "attribution", args.attribution)
        )
    if args.command == "set-attribution-url":
        return asyncio.run(
            _run_set_presentation(args.dataset_id, "attribution_url", args.url)
        )
    if args.command == "list-unassigned":
        return asyncio.run(_run_list_unassigned())
    if args.command == "list-datasets":
        return asyncio.run(_run_list_datasets())
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
