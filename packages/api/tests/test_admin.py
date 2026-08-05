"""Tier-1 tests for the server-side operator admin CLI (`api.admin`).

Drives the real command entry (`admin.main(["assign-owner", ds, user])`) against a
throwaway app-state DB + an on-disk dataset tree under a tmp DATA_ROOT — the SAME
DB the command initializes via appstate.setup_appstate (no FastAPI app, no auth:
reachability is the authorization). App-state seeds/reads use a second engine over
the same SQLite file (one asyncio.run loop each), mirroring test_write_ingest.

Also covers the re-ingest 403-with-hint parity in routers/jobs.py: an unowned
dataset that exists on disk now answers 403 pointing at this command, while a
genuinely-absent dataset stays 404.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api import admin, appstate

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


# --- fixtures --------------------------------------------------------------


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    """Fresh per-test app-state DB + a writable DATA_ROOT under tmp (D-30: dataset
    trees under datasets/). Returns the app-state DB path for seeds/reads. The admin
    command reads APP_STATE_DB / DATA_ROOT from the env, so setting them here points
    it at this throwaway state."""
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    (data_root / "datasets").mkdir(parents=True)
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


# --- app-state seed / read helpers -----------------------------------------


def _read_owner(db_path: Path, dataset_id: str) -> str | None:
    async def _run() -> str | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return await appstate.get_dataset_owner(session, dataset_id)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _read_visibility(db_path: Path, dataset_id: str) -> str:
    async def _run() -> str:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                return await appstate.get_dataset_visibility(session, dataset_id)
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _seed_user(db_path: Path, username: str) -> None:
    """Create a user (no ownership row)."""
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                session.add(
                    appstate.User(
                        username=username,
                        email=f"{username}@example.com",
                        password_hash=appstate.hash_password("s3cretpw"),
                    )
                )
                await session.commit()
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    """Record `dataset_id -> owner` (the user must already exist)."""
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


def _make_dataset_on_disk(dataset_id: str) -> None:
    """Create a minimal on-disk dataset (is_dataset only checks for the manifest)
    under DATA_ROOT/datasets/{id}/ (D-30)."""
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / dataset_id
    ds_dir.mkdir(parents=True)
    (ds_dir / "layout_manifest.json").write_text(
        '{"manifest_version": "2.1"}', encoding="utf-8"
    )


def _make_unservable_dataset_on_disk(dataset_id: str) -> None:
    """An on-disk dataset whose manifest EXISTS but cannot be served — an unsupported
    manifest_version major (the version-skew bake: a tree written by a newer pipeline
    than this API). `is_dataset` is True (the file is there) but `load_manifest` raises,
    so GET /api/datasets drops it even once owned. The O1-review case that must not be
    reported as `assign-owner`-fixable."""
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / dataset_id
    ds_dir.mkdir(parents=True)
    (ds_dir / "layout_manifest.json").write_text(
        '{"manifest_version": "999.0"}', encoding="utf-8"
    )


# --- assign-owner: happy paths ---------------------------------------------


def test_assign_owner_records_owner_for_unowned_ondisk(app_db, capsys) -> None:
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_new")

    code = admin.main(["assign-owner", "ds_new", "alice"])
    assert code == 0
    assert _read_owner(app_db, "ds_new") == "alice"
    out = capsys.readouterr().out
    assert "ds_new" in out and "alice" in out and "was: <none>" in out


def test_assign_owner_reassigns_existing_owner(app_db, capsys) -> None:
    """Reassign overrides an existing owner (last-writer-wins) — an operator GIVING
    a dataset to another user is the point of the command, not an accident."""
    _seed_user(app_db, "alice")
    _seed_user(app_db, "bob")
    _make_dataset_on_disk("ds_hand")
    _seed_owner(app_db, "ds_hand", "alice")

    code = admin.main(["assign-owner", "ds_hand", "bob"])
    assert code == 0
    assert _read_owner(app_db, "ds_hand") == "bob"
    out = capsys.readouterr().out
    assert "was: alice" in out  # previous owner reported


def test_assign_owner_makes_dataset_authorizable(app_db) -> None:
    """Integration-ish: after assign, the app-state owner matches the target — the
    same read the re-ingest/delete ownership gates use — so those web writes would
    now authorize for that user."""
    _seed_user(app_db, "carol")
    _make_dataset_on_disk("ds_auth")
    assert _read_owner(app_db, "ds_auth") is None  # unowned before

    assert admin.main(["assign-owner", "ds_auth", "carol"]) == 0
    assert _read_owner(app_db, "ds_auth") == "carol"


# --- assign-owner: failure paths (non-zero + no write) ---------------------


def test_assign_owner_absent_dataset_is_nonzero_no_write(app_db, capsys) -> None:
    _seed_user(app_db, "alice")  # user exists; the dataset does not

    code = admin.main(["assign-owner", "ds_missing", "alice"])
    assert code != 0
    assert _read_owner(app_db, "ds_missing") is None  # nothing recorded
    err = capsys.readouterr().err
    assert "no such dataset on disk" in err
    # O1: this failure names its next step too — the usual cause is a bake sent to a
    # different --output-root or a typo'd id, and list-datasets shows what is there.
    assert "python -m api.admin list-datasets" in err


def test_assign_owner_absent_user_is_nonzero_no_write(app_db, capsys) -> None:
    _make_dataset_on_disk("ds_orphan")  # on disk, but the target user does not exist

    code = admin.main(["assign-owner", "ds_orphan", "ghost"])
    assert code != 0
    assert _read_owner(app_db, "ds_orphan") is None  # FK-precheck refused; no row
    assert "no such user" in capsys.readouterr().err


def test_assign_owner_traversal_id_is_nonzero_no_write(app_db) -> None:
    """A `..`/absolute dataset id is jailed by db.dataset_dir (HTTPException there)
    and surfaces as 'no such dataset on disk' with no write — the CLI never leaks the
    API's HTTPException."""
    _seed_user(app_db, "alice")
    for bad in ("..", "/etc"):
        assert admin.main(["assign-owner", bad, "alice"]) != 0


# --- set-visibility (D-34 operator lever: publish a curated showcase dataset) ---


def test_set_visibility_public_then_private_roundtrips(app_db, capsys) -> None:
    """set-visibility flips an OWNED dataset public then back to private (D-34). Public
    is what lights up the login-less showcase — its /datasets/* bytes then serve with no
    login."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_pub")
    _seed_owner(app_db, "ds_pub", "alice")
    assert _read_visibility(app_db, "ds_pub") == "private"  # the model default

    assert admin.main(["set-visibility", "ds_pub", "public"]) == 0
    assert _read_visibility(app_db, "ds_pub") == "public"
    assert "public" in capsys.readouterr().out

    assert admin.main(["set-visibility", "ds_pub", "private"]) == 0
    assert _read_visibility(app_db, "ds_pub") == "private"


def test_set_visibility_unowned_ondisk_is_nonzero_with_hint(app_db, capsys) -> None:
    """A dataset ON DISK with NO app-state row (a CLI-transferred/unowned tree) cannot
    be published directly — the row carries the required owner FK. set-visibility exits
    non-zero pointing at assign-owner, and writes nothing (the safe default: an unowned
    tree is NOT world-readable until the operator assigns an owner)."""
    _make_dataset_on_disk("ds_unowned")  # on disk, but no app-state row
    code = admin.main(["set-visibility", "ds_unowned", "public"])
    assert code != 0
    assert "assign-owner ds_unowned" in capsys.readouterr().err


def test_set_visibility_absent_dataset_is_nonzero(app_db, capsys) -> None:
    _seed_user(app_db, "alice")
    code = admin.main(["set-visibility", "ds_missing", "public"])
    assert code != 0
    assert "no such dataset on disk" in capsys.readouterr().err


def test_set_visibility_invalid_value_exits_nonzero(app_db) -> None:
    """An unrecognized visibility (argparse `choices`) exits non-zero (SystemExit 2),
    so no out-of-model value can ever be written."""
    _make_dataset_on_disk("ds_x")
    with pytest.raises(SystemExit) as exc:
        admin.main(["set-visibility", "ds_x", "sortof-public"])
    assert exc.value.code != 0


def test_set_dataset_visibility_rejects_out_of_model_value(app_db) -> None:
    """The appstate WRITER itself rejects an out-of-model value (ValueError) — the
    CLI's argparse `choices` guards only the CLI path, so any future programmatic
    caller hits the same wall and the stored value can never leave
    {"private","public"} (is_readable would fail closed on junk, but the invariant
    belongs at the write). The refused write must not touch the row."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_val")
    _seed_owner(app_db, "ds_val", "alice")

    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(app_db)
        try:
            async with sessionmaker() as session:
                with pytest.raises(ValueError, match="visibility"):
                    await appstate.set_dataset_visibility(session, "ds_val", "sortof-public")
        finally:
            await engine.dispose()

    asyncio.run(_run())
    assert _read_visibility(app_db, "ds_val") == "private"  # untouched


# --- set-display-name / set-attribution (Part B: name & credit a collection) ---


def _read_presentation(
    db_path: Path, dataset_id: str
) -> tuple[str | None, str | None]:
    """The (display_name, attribution) stored for `dataset_id`, over a second engine on
    the same SQLite file — (None, None) when app-state has no row for it."""
    async def _run() -> tuple[str | None, str | None]:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                record = await appstate.get_dataset_record(session, dataset_id)
                return (
                    (None, None)
                    if record is None
                    else (record.display_name, record.attribution)
                )
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def test_set_display_name_then_clear_roundtrips(app_db, capsys) -> None:
    """set-display-name names an OWNED dataset, and an EMPTY string CLEARS it (back to
    the raw id) — the recovery path for a bad name, expressible from the CLI, not only
    from the UI."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_name")
    _seed_owner(app_db, "ds_name", "alice")

    assert admin.main(["set-display-name", "ds_name", "Rijksmuseum — Public Domain"]) == 0
    assert _read_presentation(app_db, "ds_name")[0] == "Rijksmuseum — Public Domain"
    assert "Rijksmuseum" in capsys.readouterr().out

    assert admin.main(["set-display-name", "ds_name", ""]) == 0
    assert _read_presentation(app_db, "ds_name")[0] is None
    assert "cleared" in capsys.readouterr().out


def test_set_attribution_roundtrips(app_db, capsys) -> None:
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_attr")
    _seed_owner(app_db, "ds_attr", "alice")

    assert admin.main(["set-attribution", "ds_attr", "Rijksmuseum, Amsterdam"]) == 0
    assert _read_presentation(app_db, "ds_attr")[1] == "Rijksmuseum, Amsterdam"
    assert "Rijksmuseum, Amsterdam" in capsys.readouterr().out


def test_set_display_name_unowned_ondisk_is_nonzero_with_hint(app_db, capsys) -> None:
    """Like set-visibility: a dataset ON DISK with NO app-state row cannot be named —
    the row carries the required owner FK — so it exits non-zero pointing at
    assign-owner and writes nothing."""
    _make_dataset_on_disk("ds_unowned_name")

    code = admin.main(["set-display-name", "ds_unowned_name", "A name"])
    assert code != 0
    assert "assign-owner ds_unowned_name" in capsys.readouterr().err
    assert _read_presentation(app_db, "ds_unowned_name") == (None, None)


def test_set_attribution_absent_dataset_is_nonzero(app_db, capsys) -> None:
    _seed_user(app_db, "alice")
    code = admin.main(["set-attribution", "ds_missing", "x"])
    assert code != 0
    assert "no such dataset on disk" in capsys.readouterr().err


def test_set_display_name_over_long_is_nonzero_no_write(app_db, capsys) -> None:
    """A too-long name is rejected (PresentationValueError → exit 1) with NO write — the
    length check runs before the row is ever touched."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_long")
    _seed_owner(app_db, "ds_long", "alice")

    code = admin.main(["set-display-name", "ds_long", "x" * 121])
    assert code != 0
    assert _read_presentation(app_db, "ds_long")[0] is None  # untouched


# --- set-attribution-url (Part D §2b: a link target for the credit) ------------


def _read_attribution_url(db_path: Path, dataset_id: str) -> str | None:
    """The attribution_url stored for `dataset_id`, over a second engine on the same
    SQLite file — None when app-state has no row for it."""
    async def _run() -> str | None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                record = await appstate.get_dataset_record(session, dataset_id)
                return None if record is None else record.attribution_url
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def test_set_attribution_url_then_clear_roundtrips(app_db, capsys) -> None:
    """set-attribution-url stores a link target for an OWNED dataset, and an EMPTY string
    CLEARS it — the same set/clear shape as the sibling presentation commands."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_url")
    _seed_owner(app_db, "ds_url", "alice")

    assert admin.main(["set-attribution-url", "ds_url", "https://www.rijksmuseum.nl"]) == 0
    assert _read_attribution_url(app_db, "ds_url") == "https://www.rijksmuseum.nl"
    assert "rijksmuseum.nl" in capsys.readouterr().out

    assert admin.main(["set-attribution-url", "ds_url", ""]) == 0
    assert _read_attribution_url(app_db, "ds_url") is None
    assert "cleared" in capsys.readouterr().out


def test_set_attribution_url_does_not_validate_shape(app_db) -> None:
    """The CLI stores the value verbatim: the RENDERER refuses a non-http(s) target, and a
    stored-but-inert value is recoverable where a rejected write loses the operator's typing."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_url_raw")
    _seed_owner(app_db, "ds_url_raw", "alice")

    assert admin.main(["set-attribution-url", "ds_url_raw", "not-a-url"]) == 0
    assert _read_attribution_url(app_db, "ds_url_raw") == "not-a-url"


def test_set_attribution_url_over_long_is_nonzero_no_write(app_db) -> None:
    """A too-long URL (>500) is rejected (exit 1) with NO write — the length check runs
    before the row is ever touched, so a bad sibling value can't leave a partial write."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_url_long")
    _seed_owner(app_db, "ds_url_long", "alice")

    code = admin.main(["set-attribution-url", "ds_url_long", "h" * 501])
    assert code != 0
    assert _read_attribution_url(app_db, "ds_url_long") is None  # untouched


def test_set_attribution_url_unowned_ondisk_is_nonzero_with_hint(app_db, capsys) -> None:
    """On disk but no app-state row → cannot credit-link it (the row carries the owner FK);
    exits non-zero pointing at assign-owner, writes nothing."""
    _make_dataset_on_disk("ds_url_unowned")

    code = admin.main(["set-attribution-url", "ds_url_unowned", "https://example.org"])
    assert code != 0
    assert "assign-owner ds_url_unowned" in capsys.readouterr().err
    assert _read_attribution_url(app_db, "ds_url_unowned") is None


# --- create-user (the #110 follow-up: provision a user without web signup) ---


def _user_row(db_path: Path, username: str):  # noqa: ANN202
    """The full User row (or None) for `username`, over a second engine on the same
    SQLite file — so a test can assert the stored password_hash exists and is a hash,
    not plaintext."""
    async def _run():  # noqa: ANN202
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                from sqlalchemy import select

                result = await session.execute(
                    select(appstate.User).where(appstate.User.username == username)
                )
                user = result.scalar_one_or_none()
                # Detach a plain snapshot before the session closes.
                return (
                    None
                    if user is None
                    else SimpleNamespace(
                        username=user.username,
                        email=user.email,
                        password_hash=user.password_hash,
                    )
                )
        finally:
            await engine.dispose()

    return asyncio.run(_run())


def _printed_password(out: str) -> str:
    """Extract the one-time password from create-user's stdout (the 'one-time
    password: <pw>' line)."""
    for line in out.splitlines():
        if line.startswith("one-time password:"):
            return line.split(":", 1)[1].strip()
    raise AssertionError(f"no one-time password line in output:\n{out}")


def test_create_user_creates_prints_password_stores_hash(app_db, capsys) -> None:
    """create-user creates the account, prints a one-time password ONCE, and stores an
    argon2 HASH (never the plaintext)."""
    code = admin.main(["create-user", "newbie", "newbie@example.com"])
    assert code == 0

    out = capsys.readouterr().out
    assert "newbie" in out
    password = _printed_password(out)
    assert len(password) >= 8  # satisfies the signup min-length rule

    row = _user_row(app_db, "newbie")
    assert row is not None
    assert row.email == "newbie@example.com"
    # The stored value is a hash, not the plaintext (argon2 hashes start with $argon2).
    assert row.password_hash != password
    assert row.password_hash.startswith("$argon2")


def test_create_user_password_actually_logs_in(app_db, client) -> None:
    """Integration: the printed password authenticates through the REAL login route —
    the created user can log in without ever signing up via the web (the #110 flow).
    Uses the TestClient over the SAME app-state DB the command wrote."""
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        assert admin.main(["create-user", "cliuser", "cli@example.com"]) == 0
    password = _printed_password(buf.getvalue())

    resp = client.post("/api/auth/login", json={"username": "cliuser", "password": password})
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    # And the identity resolves (get_current_user) through /api/auth/me.
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json() == {"username": "cliuser", "email": "cli@example.com"}


def test_create_user_duplicate_username_is_nonzero_no_second_row(app_db, capsys) -> None:
    """A username already in use fails non-zero; the existing row is untouched (the
    unique constraint → IntegrityError → clean error, not a crash)."""
    _seed_user(app_db, "dup")  # email dup@example.com
    before = _user_row(app_db, "dup")

    code = admin.main(["create-user", "dup", "different@example.com"])
    assert code != 0
    assert "already exists" in capsys.readouterr().err
    after = _user_row(app_db, "dup")
    assert after is not None and after.email == before.email  # untouched


def test_create_user_duplicate_email_is_nonzero(app_db, capsys) -> None:
    """A DIFFERENT username but an email already in use also fails non-zero (email is
    unique too) — no partial write."""
    _seed_user(app_db, "alice")  # email alice@example.com
    code = admin.main(["create-user", "alice2", "alice@example.com"])
    assert code != 0
    assert "already exists" in capsys.readouterr().err
    assert _user_row(app_db, "alice2") is None  # nothing created


@pytest.mark.parametrize(
    "username,email",
    [
        ("bad name", "ok@example.com"),   # space — fails the signup charset rule
        ("has/slash", "ok@example.com"),  # slash — fails the charset rule
        ("okname", "not-an-email"),       # malformed email — fails EmailStr
        ("okname", "missing@tld"),        # no TLD dot — EmailStr rejects
    ],
)
def test_create_user_invalid_input_is_nonzero_no_write(app_db, capsys, username, email) -> None:
    """Invalid username OR email fails validation (the SAME rules the signup route
    enforces, reused via SignupRequest) — non-zero exit, nothing written."""
    code = admin.main(["create-user", username, email])
    assert code != 0
    assert "invalid" in capsys.readouterr().err.lower()
    assert _user_row(app_db, username) is None


# --- seam O1: every failure mode names its next step ------------------------


def test_assign_owner_with_no_users_at_all_names_create_user(app_db, capsys) -> None:
    """"no user created yet? message to create user" — an EMPTY users table is a
    different situation from a typo: assign-owner cannot succeed for ANY name yet, so
    the only next step is create-user. Says so explicitly rather than the generic
    "no such user"."""
    _make_dataset_on_disk("ds_first")  # dataset baked; app-state never provisioned

    code = admin.main(["assign-owner", "ds_first", "dale"])
    assert code != 0
    err = capsys.readouterr().err
    assert "NO users exist yet" in err
    assert "create-user dale <email>" in err
    assert _read_owner(app_db, "ds_first") is None  # no write


def test_assign_owner_typo_suggests_the_near_miss_username(app_db, capsys) -> None:
    """THE O1 defect, at the point it should have surfaced: the account was `dalew`
    and `dale` was typed. The message names the near miss instead of leaving the
    operator to guess or query SQLite by hand."""
    _seed_user(app_db, "dalew")
    _make_dataset_on_disk("ds_typo")

    code = admin.main(["assign-owner", "ds_typo", "dale"])
    assert code != 0
    err = capsys.readouterr().err
    assert "no such user: dale" in err
    assert "did you mean: dalew" in err
    assert _read_owner(app_db, "ds_typo") is None  # still no write


def test_assign_owner_unknown_user_with_no_near_miss_names_create_user(app_db, capsys) -> None:
    """A genuinely new name (no near miss) still gets an actionable message: how many
    accounts exist, and the create-user command to add this one."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_new_user")

    code = admin.main(["assign-owner", "ds_new_user", "zebediah"])
    assert code != 0
    err = capsys.readouterr().err
    assert "no such user: zebediah" in err
    assert "1 account(s) exist" in err
    assert "create-user zebediah <email>" in err
    # The interface catalogue states all four assign-owner refusals are "exit 1,
    # nothing written" — pin the no-write half here as the sibling cases do.
    assert _read_owner(app_db, "ds_new_user") is None


def test_assign_owner_already_owned_by_same_user_says_so(app_db, capsys) -> None:
    """"dataset already owned → say by whom." Re-running assign-owner with the SAME
    owner reports a no-op rather than a fresh assignment, so an operator retrying does
    not read it as having just fixed something."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_same")
    _seed_owner(app_db, "ds_same", "alice")

    assert admin.main(["assign-owner", "ds_same", "alice"]) == 0
    out = capsys.readouterr().out
    assert "ALREADY owned by 'alice'" in out
    assert _read_owner(app_db, "ds_same") == "alice"


def test_assign_owner_first_assignment_names_the_publish_step(app_db, capsys) -> None:
    """A first assignment ends by naming set-visibility — the remaining step if the
    dataset is meant for logged-out visitors. A reassignment does not (nothing about
    visibility changed)."""
    _seed_user(app_db, "alice")
    _seed_user(app_db, "bob")
    _make_dataset_on_disk("ds_pubhint")

    assert admin.main(["assign-owner", "ds_pubhint", "alice"]) == 0
    assert "set-visibility ds_pubhint public" in capsys.readouterr().out

    assert admin.main(["assign-owner", "ds_pubhint", "bob"]) == 0
    out = capsys.readouterr().out
    assert "reassigned dataset 'ds_pubhint'" in out
    assert "set-visibility" not in out


def test_create_user_ends_by_naming_assign_owner(app_db, capsys) -> None:
    """An account alone still shows an EMPTY library — creating a user and assigning a
    dataset are two writes. create-user names the second one."""
    assert admin.main(["create-user", "newbie", "newbie@example.com"]) == 0
    out = capsys.readouterr().out
    assert "assign-owner <dataset_id> newbie" in out
    assert "list-unassigned" in out


# --- seam O1: list-unassigned / list-datasets -------------------------------


def test_list_unassigned_reports_the_invisible_datasets(app_db, capsys) -> None:
    """DoD §3: the datasets on disk with NO app-state row — exactly the ones
    GET /api/datasets drops — reported against a real app-state DB."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_owned")
    _seed_owner(app_db, "ds_owned", "alice")
    _make_dataset_on_disk("ds_orphan_a")
    _make_dataset_on_disk("ds_orphan_b")

    assert admin.main(["list-unassigned"]) == 0
    out = capsys.readouterr().out
    assert "2 unassigned dataset(s)" in out
    assert "ds_orphan_a" in out
    assert "ds_orphan_b" in out
    assert "ds_owned" not in out  # the owned one is not a problem
    assert "assign-owner ds_orphan_a <username>" in out


def test_list_unassigned_with_no_users_names_create_user(app_db, capsys) -> None:
    """With an empty users table there is nobody to assign to, so the next step is
    create-user, not assign-owner."""
    _make_dataset_on_disk("ds_orphan")

    assert admin.main(["list-unassigned"]) == 0
    out = capsys.readouterr().out
    assert "No users exist yet" in out
    assert "create-user <username> <email>" in out


def test_list_unassigned_clean_tree_says_so(app_db, capsys) -> None:
    """The all-clear is explicit — an operator running this to CHECK must be able to
    tell "nothing unassigned" from "command did nothing"."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_owned")
    _seed_owner(app_db, "ds_owned", "alice")

    assert admin.main(["list-unassigned"]) == 0
    assert "no unassigned datasets (1 on disk" in capsys.readouterr().out


def test_list_unassigned_skips_staging_dirs(app_db, capsys) -> None:
    """A leaked `.staging-{job_id}` dir (D-19) is not a dataset — the SAME dot-prefix
    rule the listing route applies — so it can never be reported as an unassigned
    dataset the operator should go assign."""
    staging = Path(os.environ["DATA_ROOT"]) / "datasets" / ".staging-abc123"
    staging.mkdir(parents=True)
    (staging / "layout_manifest.json").write_text("{}", encoding="utf-8")

    assert admin.main(["list-unassigned"]) == 0
    out = capsys.readouterr().out
    assert ".staging-abc123" not in out
    assert "no unassigned datasets (0 on disk" in out


def test_list_datasets_shows_owner_visibility_and_ondisk(app_db, capsys) -> None:
    """The diagnostic view: the three states that matter — owned + on disk, on disk
    with no owner (invisible), and an app-state row with no tree (an ingest that never
    landed)."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_owned")
    _seed_owner(app_db, "ds_owned", "alice")
    _make_dataset_on_disk("ds_orphan")
    _seed_owner(app_db, "ds_pending", "alice")  # record, no tree on disk

    assert admin.main(["list-datasets"]) == 0
    out = capsys.readouterr().out
    lines = {line.split()[0]: line for line in out.splitlines() if line and " " in line}

    assert "alice" in lines["ds_owned"] and "private" in lines["ds_owned"]
    assert lines["ds_owned"].endswith("yes")
    assert "<unassigned>" in lines["ds_orphan"]
    assert lines["ds_orphan"].endswith("yes")
    assert lines["ds_pending"].endswith("no")  # recorded, never baked
    assert "1 dataset(s) have NO owner" in out


def test_list_datasets_columns_are_sized_from_the_data(app_db, capsys) -> None:
    """Column widths are DERIVED from the rows, not hand-picked: a username longer
    than any guessed pad must still line up, since a table that stops aligning on real
    data is worse than no table."""
    long_name = "a-very-long-operator-username"
    _seed_user(app_db, long_name)
    _make_dataset_on_disk("ds_a")
    _seed_owner(app_db, "ds_a", long_name)
    _make_dataset_on_disk("ds_b")

    assert admin.main(["list-datasets"]) == 0
    table = [
        line for line in capsys.readouterr().out.splitlines()
        if line.startswith(("DATASET_ID", "ds_"))
    ]
    assert len(table) == 3  # header + two datasets
    # The LAST column is the one a too-narrow OWNER pad shoves out of line (ljust with
    # a width below the cell simply does not pad), so pin ITS start index: identical on
    # every row only if OWNER was widened to fit `long_name`. Rows are rstripped, so
    # the last cell's start is len(line) - len(last token).
    starts = {len(line) - len(line.split()[-1]) for line in table}
    assert len(starts) == 1, table


def test_list_datasets_empty_is_explicit(app_db, capsys) -> None:
    assert admin.main(["list-datasets"]) == 0
    assert "no datasets" in capsys.readouterr().out


def test_list_commands_write_nothing(app_db, capsys) -> None:
    """Both listings are read-only: running them must not create, adopt, or alter an
    app-state row (an operator diagnosing a problem must not change it)."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_orphan")

    assert admin.main(["list-unassigned"]) == 0
    assert admin.main(["list-datasets"]) == 0
    assert _read_owner(app_db, "ds_orphan") is None


def test_list_unassigned_flags_unservable_manifest_separately(app_db, capsys) -> None:
    """O1-review fix: a tree whose manifest cannot be served (unsupported/future major)
    is dropped by GET /api/datasets even once owned, so `assign-owner` is NOT its fix.
    list-unassigned must offer assign-owner only for the SERVABLE unowned tree and
    report the unservable one in a distinct 'cannot be served' section — never as a
    dataset to go assign, which was the exact false lead this seam exists to remove."""
    _seed_user(app_db, "alice")
    _make_dataset_on_disk("ds_ok")               # servable, unowned -> assign-owner fixes
    _make_unservable_dataset_on_disk("ds_bad")   # on disk, unowned, but unservable

    assert admin.main(["list-unassigned"]) == 0
    out = capsys.readouterr().out
    assert "assign-owner ds_ok <username>" in out       # the servable one is offered
    assert "ds_bad" in out                              # the broken one is still named
    assert "cannot be served" in out                    # ...in its own section
    assert "assign-owner ds_bad" not in out             # ...never prescribed assign-owner


def test_list_datasets_marks_unservable_ondisk(app_db, capsys) -> None:
    """O1-review fix: list-datasets ON_DISK is three-valued. A present-but-unservable
    manifest shows `unservable`, not `yes`, so the diagnostic view never implies the
    tree would list once owned."""
    _make_unservable_dataset_on_disk("ds_bad")

    assert admin.main(["list-datasets"]) == 0
    out = capsys.readouterr().out
    row = {line.split()[0]: line for line in out.splitlines() if line and " " in line}
    assert row["ds_bad"].endswith("unservable")
    assert "ON_DISK=unservable" in out


# --- CLI shape -------------------------------------------------------------


def test_no_subcommand_prints_help_and_exits_2(app_db, capsys) -> None:
    code = admin.main([])
    assert code == 2
    out = capsys.readouterr().out
    assert "assign-owner" in out  # help lists the verbs
    assert "create-user" in out
    assert "set-visibility" in out
    assert "set-display-name" in out
    assert "set-attribution" in out
    assert "list-unassigned" in out
    assert "list-datasets" in out


def test_unknown_dataset_exit_precedes_engine_init(tmp_path, monkeypatch) -> None:
    """The on-disk check runs BEFORE app-state is initialized: pointing DATA_ROOT at
    an empty tree (no datasets dir) still exits cleanly non-zero, not a crash."""
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(tmp_path / "empty"))
    assert admin.main(["assign-owner", "nope", "someone"]) != 0


# --- re-ingest 403-with-hint parity (routers/jobs.py) ----------------------


class _FakeQueue:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.connection = object()

    def enqueue(  # noqa: ANN201
        self, func_string: str, kwargs: dict | None = None, *, job_timeout: int | float | None = None
    ):
        # job_timeout (T2-97) is a top-level rq.Queue.enqueue arg, not a job kwarg —
        # accepted here so the real enqueue_ingest/enqueue_add_layouts call binds;
        # the enqueue drift guard (tests/smoke) is what asserts its value.
        self.calls.append((func_string, kwargs or {}))
        return SimpleNamespace(id="job-test-123")


class _FakeLock:
    def __init__(self, name: str) -> None:
        self._name = name

    def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
        return True

    def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        return None


class _FakeRedis:
    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _FakeLock(name)


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        test_client.app.state.redis = _FakeRedis()
        yield test_client


@pytest.fixture
def auth(client) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def fake_queue(client) -> _FakeQueue:
    queue = _FakeQueue()
    client.app.state.queue = queue
    return queue


def test_reingest_unowned_ondisk_is_403_with_server_hint(client, auth, fake_queue) -> None:
    """A dataset on disk with NO app-state owner (CLI-seeded) is not web-adoptable:
    re-ingest now answers 403 pointing at the server assign-owner command (T2-65),
    NOT a bare 404 — and never enqueues."""
    _make_dataset_on_disk("ds_cli")

    r = client.post(
        "/api/datasets/ds_cli/ingest", headers=auth, json={"upload_id": "whatever"}
    )
    assert r.status_code == 403
    detail = r.json()["detail"]
    assert "python -m api.admin assign-owner ds_cli" in detail
    assert fake_queue.calls == []  # never enqueued


# A minimal but listable v2 manifest — enough for `_ready_summary` to build a
# "ready" row, so GET /api/datasets actually reaches the ownership filter (the
# 1-key manifest `_make_dataset_on_disk` writes is skipped by the scan instead).
_LISTABLE_MANIFEST = (
    '{"manifest_version": "2.2", "dataset_version": 1, '
    '"dataset_metadata": {"image_count": 3, "ingest_timestamp": "2026-01-01T00:00:00"}, '
    '"layouts": [{"layout_id": "grid"}]}'
)


def test_unassigned_dataset_is_invisible_until_assign_owner(
    app_db, client, auth, fake_queue, capsys
) -> None:
    """THE O1 defect, end to end and both ways round: a baked-but-unassigned dataset
    is absent from GET /api/datasets (the silent vanish), `list-unassigned` names it,
    and after assign-owner the SAME request returns it. This is what makes
    "list-unassigned reports correctly" a statement about the library the operator
    actually looks at, not just about a SQLite row."""
    ds_dir = Path(os.environ["DATA_ROOT"]) / "datasets" / "ds_baked"
    ds_dir.mkdir(parents=True)
    (ds_dir / "layout_manifest.json").write_text(_LISTABLE_MANIFEST, encoding="utf-8")

    listed = client.get("/api/datasets", headers=auth).json()["datasets"]
    assert [d["dataset_id"] for d in listed] == []  # baked, and invisible

    assert admin.main(["list-unassigned"]) == 0
    assert "ds_baked" in capsys.readouterr().out

    assert admin.main(["assign-owner", "ds_baked", "alice"]) == 0

    listed = client.get("/api/datasets", headers=auth).json()["datasets"]
    assert [d["dataset_id"] for d in listed] == ["ds_baked"]
    assert admin.main(["list-unassigned"]) == 0
    assert "no unassigned datasets" in capsys.readouterr().out


def test_reingest_truly_absent_dataset_stays_404(client, auth, fake_queue) -> None:
    """A dataset that is neither owned NOR on disk stays 404 (unchanged) — the 403
    hint is only for the on-disk-but-unowned case."""
    r = client.post(
        "/api/datasets/ds_ghost/ingest", headers=auth, json={"upload_id": "whatever"}
    )
    assert r.status_code == 404
    assert fake_queue.calls == []
