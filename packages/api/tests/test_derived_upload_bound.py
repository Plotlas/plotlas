"""Tier-1 tests for Seam L1: the derived upload bound.

What this file pins is that the whole-bundle byte ceiling is **the disk**, not a
constant — the same corpus is accepted or refused according to how much free space
the upload jail's filesystem has, and nothing in the module names a number for it any
more. Plus the two things that must survive that change: the D-27 ZIP-bomb guard, and
an explicit `MAX_UPLOAD_BUNDLE_BYTES` still winning when an operator sets one.

**The disk is simulated, and faithfully.** `uploads._disk_free` is the module's single
reading of free space, so a test replaces it with a fake device of a chosen capacity
whose free figure DROPS AS THE SESSION WRITES — `_fake_device` below. A constant fake
would be worse than useless here: the disk bound is deliberately incremental (it never
subtracts a committed tally, because committed bytes have already left the free
figure), so a fake that does not fall would admit every request forever and the test
would pass against a bound that does nothing.

Scale is chosen so the property is observable at all, and the floor sets the floor of
that choice: `_disk_floor` starts at one streaming chunk (1 MiB), so a simulated device
smaller than that admits nothing and would make every spec here vacuously "refused".
The devices below are therefore 4 MiB and 16 MiB against parts of 512 KiB, where a
bound that ignored the disk would accept the same number of parts in both.

**And a simulated failure is not a simulated DEVICE.** Everything above replaces a
reading or an `os.replace`; a device that is genuinely out of room refuses the syscall
BEFORE that — `tempfile.mkstemp`, the first allocating call in each sidecar writer. So
this file has a third tier that needs a real mount and skips without one:
`test_the_bound_holds_on_a_REAL_small_filesystem` for the bound itself, and the
`starved` fixture (`_StarvedSession`) for a session on a device with NO INODES LEFT,
driven through the real routes. See the comment above `_SMALL_FS_SKIP` for why inodes
rather than bytes, and for what runs and what silently does not.

**What this seam does NOT pin, and where that is being decided.** A sidecar write that
fails after its part is already committed leaves the cache silently behind, and nothing
here recovers from it. Three designs for that shipped during review and all three were
refuted; the fourth is being chosen by measurement in
`docs/spikes/spike_upload_session_recovery.md`. The specs that end in
`..._pending_the_spike` are pins of the ACCEPTED status quo — a 500 and a stale cache —
not of desired behaviour, and each names the spike.

Fixtures are local, matching test_chunked_parts.py's shape (pytest has no cross-module
fixture reuse without a conftest).
"""

from __future__ import annotations

import asyncio
import errno
import io
import json
import logging
import os
import shutil
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api.routers import uploads

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}

# The corpus this seam exists for: rijks_pd, 49,048 images / 34,937,083,467 bytes =
# 712,304 bytes/image, measured 2026-08-29 by two independent methods agreeing to the
# byte (`docs/design/LIMITS_REGISTER.md` C-1). At the removed 2 GiB constant exactly
# 3,014 of those fit, against a PRD target of 1,000,000.
_RIJKS_MEAN_BYTES = 712_304
_OLD_BUNDLE_CAP = 2 * 1024 * 1024 * 1024
_OLD_CEILING_IMAGES = 3_014


# --- fakes -------------------------------------------------------------------


class _FakeQueue:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.connection = object()

    def enqueue(  # noqa: ANN201
        self,
        func_string: str,
        kwargs: dict | None = None,
        *,
        job_timeout: int | float | None = None,
    ):
        self.calls.append((func_string, kwargs or {}))
        return SimpleNamespace(id=f"job-{len(self.calls)}")


class _FakeLock:
    def acquire(self, *args, **kwargs) -> bool:  # noqa: ANN002, ANN003
        return True

    def release(self, *args, **kwargs) -> None:  # noqa: ANN002, ANN003
        return None


class _FakeRedis:
    def lock(self, name: str, *, timeout=None, blocking_timeout=None):  # noqa: ANN001, ANN201
        return _FakeLock()


# --- fixtures ----------------------------------------------------------------


@pytest.fixture
def app_db(tmp_path, monkeypatch) -> Path:
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    data_root.mkdir()
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    # The env hygiene these lines used to hold — clearing the upload knobs and the
    # `_warn_malformed_env` memo — lives in `conftest.upload_env_hygiene`, autouse for
    # the whole package. It was here in one of two byte-identical fixture blocks and
    # missing from the other (round-2 review, finding 14).
    return db_path


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


# --- helpers -----------------------------------------------------------------


def _session_dir(upload_id: str) -> Path:
    return Path(os.environ["DATA_ROOT"]) / "users" / "alice" / "uploads" / upload_id


def _open_session(client, auth) -> str:
    return client.post("/api/uploads", headers=auth).json()["upload_id"]


def _occupied(session: Path) -> int:
    """Every byte the session currently has on disk — bundle files, staging, sidecars
    alike. The quantity a real device's free figure would have fallen by."""
    return sum(p.stat().st_size for p in session.rglob("*") if p.is_file())


class _Device:
    """A simulated filesystem of a fixed capacity, whose free figure falls as the
    session writes and rises when it cleans up. Records the LOW-WATER MARK, which is
    the safety property the zip-bomb spec actually asserts on.

    `shrink_after` models the OTHER writer — another user's upload, the worker's bake,
    anything on the box — taking space away MID-REQUEST, after this request's budget
    snapshot was taken. That is the only way to exercise the per-chunk re-read, and it
    is a real event, not a contrivance.

    **One fidelity gap, deliberate and worth knowing.** This device models
    `consumed == bytes written`, while a real filesystem allocates in BLOCKS: a
    1-byte file costs 4 KiB of `disk_usage().free`, and directory entries and inodes
    cost more. So a real device runs out EARLIER than this one for the same byte total,
    and these specs therefore drive the SNAPSHOT path (the budget is exhausted first)
    where production more often drives the LIVE re-read (free space falls faster than
    the byte count predicts). It makes the specs conservative, not wrong — they refuse
    later than production would — but a spec here passing is not evidence about block
    accounting. The real-tmpfs bomb probe in the review is the check for that."""

    def __init__(
        self, session: Path, capacity: int, shrink_after: int | None = None
    ) -> None:
        self.session = session
        self.capacity = capacity
        self.shrink_after = shrink_after
        self.low_water = capacity
        self.reads = 0

    def free(self, path: Path) -> int:
        self.reads += 1
        if self.shrink_after is not None and self.reads > self.shrink_after:
            self.capacity = _occupied(self.session)  # someone else took the rest
        free = self.capacity - _occupied(self.session)
        self.low_water = min(self.low_water, free)
        return free


def _fake_device(
    monkeypatch, session: Path, capacity: int, shrink_after: int | None = None
) -> _Device:
    device = _Device(session, capacity, shrink_after)
    monkeypatch.setattr(uploads, "_disk_free", device.free)
    return device


def _post(client, auth, upload_id: str, name: str, payload: bytes):
    return client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": (name, payload)},
    )


def _fill(client, auth, upload_id: str, part: bytes, limit: int = 200) -> int:
    """Post `part` under fresh names until the server refuses; return the bytes it
    accepted. `limit` only stops a runaway if the bound is broken entirely."""
    accepted = 0
    for i in range(limit):
        r = _post(client, auth, upload_id, f"img{i:04d}.png", part)
        if r.status_code != 200:
            assert r.status_code == 413, r.text
            return accepted
        accepted += len(part)
    raise AssertionError(
        f"the bound never bound: {limit} parts of {len(part)} bytes all accepted"
    )


def _stored_zip_with_unextractable_payload(payload: int) -> bytes:
    """A STORED (uncompressed) archive holding one tiny `.png` and one large file with
    an extension outside `_IMAGE_EXTS` — the shape a RAW-heavy export has, where the
    archive's own size says almost nothing about what will be extracted from it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("pic.png", b"p" * 1024)
        zf.writestr("notes.bin", b"n" * payload)
    return buf.getvalue()


def _zip_bomb(uncompressed: int) -> bytes:
    """The audit's probe: a tiny DEFLATE archive that expands ~1000:1. `ZipInfo` is
    never consulted by the server, so the only thing that stops it is the streaming
    bound this seam replaced."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("bomb.png", b"\0" * uncompressed)
    return buf.getvalue()


def _warnings(caplog) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING and "upload cap reached" in r.getMessage()
    ]


def _malformed(caplog) -> list[str]:
    """The other kind of warning this module emits: an env knob set to something it
    cannot use. Distinct from `_warnings` (a cap that BOUND) on purpose — a malformed
    knob is a config error, not a refusal."""
    return [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING and "is not a positive integer" in r.getMessage()
    ]


# --- the seam: the ceiling is the disk ---------------------------------------


def test_the_bundle_ceiling_follows_the_disk(client, auth, monkeypatch) -> None:
    """THE spec. The same server, the same parts, two different devices — and the
    accepted volume moves with the device, which no constant ceiling can do.

    A bound that ignored free space would accept the same total on both (or refuse on
    both), so this fails for any implementation that reads a number instead of a disk.

    **What it CANNOT do, stated so nobody reads more into it than it proves.** It does
    not isolate either mechanism. The bound has two — a per-request snapshot budget and
    a per-chunk free-space re-read — and either one alone still bounds a single-writer
    session, so this spec survives a mutation that replaces the snapshot with a
    constant 2 GiB ceiling (verified: it passes). Only the compound restoration of the
    pre-L1 world (constant ceiling AND no re-read) kills it. The re-read is isolated by
    `test_a_disk_that_fills_UNDER_an_in_flight_request_is_noticed`, which is the spec to
    change if that mechanism is ever touched."""
    part = b"s" * (512 * 1024)
    small_id = _open_session(client, auth)
    small = _fake_device(monkeypatch, _session_dir(small_id), 4 * 1024 * 1024)
    accepted_small = _fill(client, auth, small_id, part)

    big_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(big_id), 16 * 1024 * 1024)
    accepted_big = _fill(client, auth, big_id, part)

    assert small.reads > 0, "the injected device was never read — this spec proves nothing"
    assert accepted_small <= 4 * 1024 * 1024
    assert accepted_big > accepted_small * 3, (
        f"4x the disk accepted {accepted_big} vs {accepted_small} bytes — the ceiling "
        "is not following the device"
    )
    # And it stopped short of filling the device, which is the point of the floor.
    assert small.low_water > 0


def test_the_ceiling_is_no_longer_the_removed_two_gib_constant(
    client, auth, monkeypatch
) -> None:
    """DoD item 1, at a scale a test can run. The wall that stopped a rijks-shaped
    corpus at 3,014 images was 2 GiB of *constant*; it is now 2 GiB of *disk*, so on a
    machine with more disk the corpus goes further — measured through the real budget
    path rather than by re-deriving the arithmetic here.

    Both figures come from `_bundle_budget`, the function every enforcement site calls.
    """
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)

    _fake_device(monkeypatch, session, _OLD_BUNDLE_CAP)
    at_two_gib = uploads._bundle_budget(session).remaining
    assert at_two_gib is not None
    # A 2 GiB DEVICE reproduces the old wall, less the floor it holds back (one
    # streaming chunk, ~1.5 images at this corpus's mean).
    assert _OLD_CEILING_IMAGES - 3 <= at_two_gib // _RIJKS_MEAN_BYTES <= _OLD_CEILING_IMAGES, (
        "a 2 GiB device should land on the old wall — if it does not, the corpus "
        "arithmetic in this file no longer describes the code"
    )

    _fake_device(monkeypatch, session, 64 * _OLD_BUNDLE_CAP)  # a 128 GiB device
    at_128_gib = uploads._bundle_budget(session).remaining
    assert at_128_gib is not None
    assert at_128_gib // _RIJKS_MEAN_BYTES > 190_000, (
        "the same code on a bigger device must accept more of the same corpus"
    )


def test_a_capacity_refusal_says_capacity_and_names_who_can_act(
    client, auth, monkeypatch, caplog
) -> None:
    """What the 413 says now. There is no constant to name, so it must not pretend
    there is: it is a CAPACITY statement (the product is not refusing this corpus,
    this machine cannot hold it today) and it names someone who can act."""
    upload_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(upload_id), 3 * 1024 * 1024)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        _fill(client, auth, upload_id, b"x" * (512 * 1024))
        refused = _post(client, auth, upload_id, "one-too-many.png", b"x" * (512 * 1024))

    assert refused.status_code == 413
    assert refused.json()["detail"] == (
        "This dataset is too large to accommodate at this time — contact an "
        "administrator."
    )
    assert "limit" not in refused.json()["detail"].lower()

    logged = _warnings(caplog)
    assert logged, "a capacity refusal that tells the operator nothing is the defect"
    assert any("disk capacity" in m for m in logged)
    assert any("bytes free" in m for m in logged)


def test_an_explicit_cap_still_wins_and_still_names_its_number(
    client, auth, monkeypatch, caplog
) -> None:
    """`MAX_UPLOAD_BUNDLE_BYTES` is not gone — it is no longer a DEFAULT. Set, it is
    an operator's explicit policy ceiling, it binds ahead of the disk, and its 413
    names the number the operator can raise (which a capacity refusal cannot)."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "8")
    upload_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(upload_id), 8 * 1024 * 1024)

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert _post(client, auth, upload_id, "a.png", b"12345").status_code == 200
        over = _post(client, auth, upload_id, "b.png", b"12345")

    assert over.status_code == 413
    assert over.json()["detail"] == "Upload bundle exceeds the 8-byte bundle limit"
    logged = _warnings(caplog)
    assert any("cap=MAX_UPLOAD_BUNDLE_BYTES" in m and "limit=8" in m for m in logged), logged


def test_no_bundle_default_is_compiled_in_any_more(app_db, monkeypatch) -> None:
    """The constant this seam removed. `_explicit_max_bundle_bytes` returns None when
    the operator has not set one — there is no 2 GiB (or any) fallback to inherit.

    **Takes `app_db` and `monkeypatch` for isolation, and that is not decoration.** It
    used to take no fixtures at all, so it opted out of the env guard `app_db` exists
    for: it mutated the real `os.environ` and its `finally` DELETED whatever ambient
    `MAX_UPLOAD_BUNDLE_BYTES` the operator had set. Reproduced with
    `docker run -e MAX_UPLOAD_BUNDLE_BYTES=2147483648 ... pytest` -> `1 failed, 142
    passed`, and the failure read as if the CODE still had a 2 GiB default."""
    assert not hasattr(uploads, "_DEFAULT_MAX_BUNDLE_BYTES")
    assert uploads._explicit_max_bundle_bytes() is None
    for bad in ("", "0", "-1", "not-a-number"):
        monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", bad)
        assert uploads._explicit_max_bundle_bytes() is None, bad
    monkeypatch.delenv("MAX_UPLOAD_BUNDLE_BYTES")


# --- the safety property that must not regress -------------------------------


def test_the_zip_bomb_is_still_refused_without_filling_the_disk(
    client, auth, monkeypatch, caplog
) -> None:
    """**If this regresses, nothing else in the seam matters.**

    `MAX_UPLOAD_BUNDLE_BYTES` was the only bound on uncompressed expansion — there is
    no per-entry size limit anywhere and the entry cap counts files, not bytes — so
    removing it without a working replacement lets one archive inside the 100 MiB
    per-part ceiling expand until the disk fills. The audit measured the ratio at
    ~1000:1 (64 MiB out of a 65,346-byte archive).

    The assertion is about BYTES ON THE DEVICE, not about a status code: the archive
    is offered to a device far smaller than its expansion, and free space must never
    have reached zero. A 413 alone would also be produced by a bound that filled the
    disk first and noticed afterwards."""
    uncompressed = 64 * 1024 * 1024
    bomb = _zip_bomb(uncompressed)
    # Reproduces the audit's probe to the byte on this image: 65,346 archive bytes for
    # 64 MiB, 1027:1 (measured 2026-08-31, Python 3.14 / zlib). The RATIO is what is
    # asserted -- a zlib version bump may move the archive size a little and must not
    # fail this spec, but it can never make the payload stop being a bomb.
    assert uncompressed / len(bomb) > 500, (
        f"the probe must be a BOMB: {len(bomb)} bytes expanding to {uncompressed}"
    )

    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    device = _fake_device(monkeypatch, session, 8 * 1024 * 1024)  # 1/8th the expansion

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        r = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("bomb.zip", bomb)},
        )

    assert r.status_code == 413, r.text
    assert device.low_water > 0, (
        f"the bomb drove the device to {device.low_water} bytes free — the guard "
        "noticed too late"
    )
    assert list((session / "images").iterdir()) == [], "nothing may be merged"
    assert not (session / ".extract-tmp").exists(), "staging must be removed"
    assert _warnings(caplog), "the operator must hear a bomb"


def test_the_zip_bomb_is_still_refused_by_an_explicit_cap(client, auth, monkeypatch) -> None:
    """The other half: D-27's mechanism is untouched, so an operator's explicit cap
    still stops the same archive on a machine with plenty of disk — the streaming
    count, never `ZipInfo.file_size`, is what decides."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "1024")
    upload_id = _open_session(client, auth)
    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("bomb.zip", _zip_bomb(4 * 1024 * 1024))},
    )
    assert r.status_code == 413
    assert r.json()["detail"] == (
        "Upload bundle exceeds the 1024-byte bundle limit"
    )
    assert list((_session_dir(upload_id) / "images").iterdir()) == []


# --- the entry cap, which the byte change would otherwise have stranded -------


def test_the_entry_cap_is_the_prd_target_not_the_dead_250k(client, auth) -> None:
    """The correction this seam had to make rather than inherit — with the arithmetic
    the right way round, because an earlier version of this spec had it INVERTED.

    The relation: at a free-disk budget B and a mean of M bytes/image, the byte bound
    admits B/M images, so the ENTRY cap C binds first only once `B >= C*M`. Every cap
    therefore has a break-even device size below which it cannot bind at all.

    The line that used to sit here was `assert hundred_gib // 250_000 <
    _RIJKS_MEAN_BYTES` under a docstring claiming it proved the 250,000 cap BINDS at
    100 GiB. It is true precisely when the cap CANNOT bind (B/C < M means the disk runs
    out first), and it holds for any cap above ~150,742, so it could not tell 250,000
    from 1,000,000 either. Both halves are asserted here instead, the DISCRIMINATING
    one first so a mutation of the constant fails on the arithmetic rather than on a
    restatement of it."""
    # (1) The reason the cap had to move, stated as arithmetic: on a device that can
    #     hold the PRD's own target corpus, the CAP — not the disk — must not be what
    #     refuses it. Fails for 250,000, which is what the line it replaces could not do
    #     (that one held for any cap above ~150,742).
    device_for_the_target = 1_000_000 * _RIJKS_MEAN_BYTES  # 712.3 GB
    assert uploads._DEFAULT_MAX_ENTRIES >= device_for_the_target // _RIJKS_MEAN_BYTES, (
        f"a device sized for the PRD's target holds "
        f"{device_for_the_target // _RIJKS_MEAN_BYTES} rijks-shaped images, and an "
        f"entry cap of {uploads._DEFAULT_MAX_ENTRIES} would refuse it before the disk "
        "did — the same defect the audit found, one cap over"
    )
    assert uploads._DEFAULT_MAX_ENTRIES == 1_000_000, (
        "the ceiling must not sit below the target the PRD claims"
    )

    # (2) And the 100 GiB row the old comment cited says the OPPOSITE of what it
    #     claimed: there the DISK still binds first for a rijks-shaped corpus, so
    #     250,000 was not reachable at that size at all.
    hundred_gib = 100 * 1024**3
    images_the_disk_allows = hundred_gib // _RIJKS_MEAN_BYTES  # 150,742
    assert images_the_disk_allows < 250_000, (
        f"a 100 GiB device admits {images_the_disk_allows} rijks-shaped images before "
        "the BYTE bound refuses, so an entry cap of 250,000 cannot bind there; break-"
        f"even for that cap is {250_000 * _RIJKS_MEAN_BYTES} bytes of free disk"
    )


def test_the_entry_cap_binds_and_says_so(client, auth, monkeypatch, caplog) -> None:
    """It is defended-and-tunable rather than derived, so per the Limits convention it
    must be audible: a deployment that outgrows it has to be able to learn that from
    the log, which is precisely what 250,000 never did."""
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    upload_id = _open_session(client, auth)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert _post(client, auth, upload_id, "a.png", b"a").status_code == 200
        assert _post(client, auth, upload_id, "b.png", b"b").status_code == 200
        over = _post(client, auth, upload_id, "c.png", b"c")

    assert over.status_code == 413
    assert over.json()["detail"] == "Upload bundle exceeds the 2-file entry limit"
    assert any(
        "cap=MAX_UPLOAD_ENTRIES" in m and "limit=2" in m and "observed=3" in m
        for m in _warnings(caplog)
    ), _warnings(caplog)


# --- the caps route: static on purpose (open question 5) ---------------------


def test_the_advertised_bundle_cap_is_static_while_the_disk_moves(
    client, auth, monkeypatch
) -> None:
    """`client.ts` caches `getUploadCaps` for the lifetime of its ApiClient, on
    purpose. So the advertised bundle figure must NOT be the live budget: it is the
    static TOTAL CAPACITY of the device, and it does not move when free space does.

    (An earlier draft of this docstring said "total capacity over the measured
    peak-staging multiplier", contradicting its own assertion three lines down. That
    was the abandoned `total // 2` design, which
    `test_the_advertised_cap_is_an_upper_bound_on_what_is_enforced` exists to keep
    abandoned: halving produces FALSE REFUSALS, because the client's pre-flight sum
    excludes archives and plain parts have no transient copy.)"""
    monkeypatch.setattr(uploads, "_disk_total", lambda path: 1_000_000)
    first = client.get("/api/uploads/caps", headers=auth).json()["max_bundle_bytes"]
    assert first == 1_000_000

    monkeypatch.setattr(uploads, "_disk_free", lambda path: 1)  # the disk fills right up
    second = client.get("/api/uploads/caps", headers=auth).json()["max_bundle_bytes"]
    assert second == first, "a cached read must not be given a moving number"


def test_the_advertised_cap_is_an_upper_bound_on_what_is_enforced(
    client, auth, monkeypatch
) -> None:
    """The asymmetry that makes the stale cache safe: a pre-flight NO against the
    advertised figure is trustworthy (nothing over it can ever fit, however empty the
    device), while a YES is provisional. That holds only while advertised >= enforced.

    Checked on a device with MORE FREE THAN HALF ITS CAPACITY, because that is the
    case that caught an earlier draft advertising `total // 2`: free space can exceed
    half the device, so half would have been BELOW the enforced budget and the
    pre-flight would have refused selections the server accepts."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    monkeypatch.setattr(uploads, "_disk_total", lambda path: 100 * 1024 * 1024)
    _fake_device(monkeypatch, session, 90 * 1024 * 1024)  # 90% free
    advertised = client.get("/api/uploads/caps", headers=auth).json()["max_bundle_bytes"]
    enforced = uploads._bundle_budget(session).remaining
    assert enforced is not None
    assert enforced > 50 * 1024 * 1024, "the case this guards is free > total/2"
    assert advertised >= enforced


def test_an_explicit_cap_is_advertised_verbatim(client, auth, monkeypatch) -> None:
    """A deployment that wants its clients to pre-flight against a policy number sets
    one, and then the advertised value is exactly it — Seam A2's contract, intact."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "271828182845")
    body = client.get("/api/uploads/caps", headers=auth).json()
    assert body["max_bundle_bytes"] == 271_828_182_845


# --- the reserve, and what it is honest about --------------------------------


def test_the_floor_reserves_TWICE_the_sidecars_it_must_rewrite(client, auth) -> None:
    """The margin is derived, not picked: one streaming chunk per live writer (the most
    that can be written between two free-space reads) plus TWICE the session's sidecar
    bytes, because `.tally.json` and `.files.json` are written temp-then-replace and a
    rewrite needs their size again beside the original.

    **The doubling is asserted exactly, and it was not before.** The only assertion here
    used to be `_disk_floor(session) > empty_floor`, which any positive multiplier
    satisfies — mutating `2 * _sidecar_bytes(...)` to `1 *` left the suite green
    (61 passed), so the quantity the seam names in its own docstring was pinned only
    from below. The sidecar sizes are `stat`-ed HERE rather than read back from
    `_sidecar_bytes`, so the assertion does not compare the code to itself."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    empty_floor = uploads._disk_floor(session)
    assert empty_floor == uploads._PART_CHUNK_BYTES

    for i in range(20):
        assert _post(client, auth, upload_id, f"f{i}.png", b"x" * 64).status_code == 200

    sidecars = sum(
        (session / name).stat().st_size for name in (".tally.json", ".files.json")
    )
    assert sidecars > 0, "this spec proves nothing if the session wrote no sidecars"
    assert uploads._disk_floor(session) == uploads._PART_CHUNK_BYTES + 2 * sidecars, (
        "the floor must reserve the sidecars TWICE -- they are rewritten "
        "temp-then-replace, so the copy sits beside the original"
    )


def test_the_floor_projects_the_manifest_rows_this_request_will_add(
    client, auth
) -> None:
    """The sidecar term is a projection, not a snapshot, and the difference is what
    ENOSPC'd the manifest write AFTER a part was committed.

    `_sidecar_bytes` measures `.files.json` as it stands BEFORE the request; the rewrite
    the floor must cover is of the manifest AFTER it, and one archive adds thousands of
    rows at once. Measured on the pre-fix code: a fresh session taking a 15,000-entry
    archive reserved a sidecar term of 0 against a post-extraction manifest of 1,650,000
    bytes.

    **The reservation is now BYTES, not a row count times an average, and the assertion
    is against the real serialiser rather than against the arithmetic restated.** The
    version this replaces asserted `projected == base + 2 * rows *
    _MANIFEST_BYTES_PER_ENTRY`, which compares the code to itself: mutating that
    constant from 137 to 1 left the whole suite green while production reserved 2 bytes
    per row instead of 274."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    base = uploads._disk_floor(session)
    for names in (["a" * 38 + ".png"], [f"{i:034d}.png" for i in range(15_000)]):
        manifest = {n: {"size": 65_536, "sha256": "ab" * 32} for n in names}
        reserved = sum(uploads._manifest_row_bytes(n, 65_536) for n in names)
        assert uploads._disk_floor(session, reserved) == base + 2 * reserved, (
            f"{len(names)} new manifest rows must reserve their own rewrite twice over"
        )
        # ...and the reservation is the real cost, measured by serialising the manifest
        # the way `_write_manifest` does. Nothing here reads the module's arithmetic.
        assert reserved == len(json.dumps(manifest)), (
            f"{len(names)} rows reserved {reserved} bytes against a manifest that "
            f"serialises to {len(json.dumps(manifest))}"
        )


def test_the_floor_grows_with_the_number_of_LIVE_THREAD_writers(client, auth) -> None:
    """The concurrency term, which is counted rather than chosen.

    One chunk was "the most that can be written between two checks" for ONE writer and
    false for N THREADS: `_extract_and_merge_zip` runs on the threadpool, so N archive
    uploads are N real OS threads writing between any one of them's two readings, and
    the floor was overshot by (N-1) chunks — measured to a low-water of 0 bytes free and
    1-3 unhandled ENOSPC 500s per 4-way run. Registering a thread writer must widen the
    floor for every writer, including ones already running, which is why
    `_BundleBudget.check` re-derives it live.

    **The event loop's share is ONE chunk, not one per request**, which is the round-2
    correction: `1 + live` rather than `max(1, live)`. The `1` is the whole of the event
    loop, because no coroutine can write between another's `check()` and its
    `fh.write()`; `live` is the threads, which can. `test_PARKED_sibling_parts...` is
    the other half — that a request in flight adds nothing at all."""
    session = _session_dir(_open_session(client, auth))
    solo = uploads._disk_floor(session)
    assert solo == uploads._PART_CHUNK_BYTES, "the event loop's own chunk, and only it"

    with uploads._writers, uploads._writers, uploads._writers:
        assert uploads._writers.live == 3
        assert uploads._disk_floor(session) == solo + 3 * uploads._PART_CHUNK_BYTES
    assert uploads._writers.live == 0
    assert uploads._disk_floor(session) == solo, "the term must be released"


def test_a_live_writer_widens_an_ALREADY_ADMITTED_budget(client, auth, monkeypatch) -> None:
    """The half an admission-time count cannot do. A budget taken while one writer was
    running must still refuse when three more start underneath it — otherwise the writer
    that was admitted first keeps a one-chunk floor while four writers share the device,
    which is exactly the overshoot.

    Driven at the seam (`_BundleBudget.check`) rather than through four real requests,
    because the assertion is about the FLOOR the check applies, and a race is not a
    deterministic spec."""
    session = _session_dir(_open_session(client, auth))
    free = 3 * uploads._PART_CHUNK_BYTES
    monkeypatch.setattr(uploads, "_disk_free", lambda path: free)

    budget = uploads._bundle_budget(session)
    budget.check(0)  # solo: floor is one chunk, 3 chunks free -> admitted
    budget.check(1)  # ...and it stays admitted while nothing else is writing

    with uploads._writers, uploads._writers, uploads._writers:
        with pytest.raises(Exception) as refused:
            budget.check(2)
    assert getattr(refused.value, "status_code", None) == 413, refused.value
    assert "contact an administrator" in getattr(refused.value, "detail", "")


def test_the_operator_reserve_binds_and_is_off_by_default(client, auth, monkeypatch) -> None:
    """`UPLOAD_DISK_RESERVE_BYTES` is the honestly-underived term — how much free disk
    the REST of the service needs is a measurement nobody has taken, so the default
    bounds only what is derivable. It is a real knob, and it moves the bound.

    "Off by default" is now ASSERTED rather than only claimed in the name: the spec used
    to check a delta between two settings and never the default itself, so a compiled-in
    non-zero reserve would have passed it."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    assert uploads._disk_reserve_bytes() == 0, "the default must reserve nothing"
    assert uploads._disk_floor(session) == uploads._PART_CHUNK_BYTES

    _fake_device(monkeypatch, session, 10 * 1024 * 1024)
    unreserved = uploads._bundle_budget(session).remaining
    assert unreserved is not None

    monkeypatch.setenv("UPLOAD_DISK_RESERVE_BYTES", str(4 * 1024 * 1024))
    reserved = uploads._bundle_budget(session).remaining
    assert reserved == unreserved - 4 * 1024 * 1024


def test_an_explicit_zero_reserve_is_a_setting_not_a_typo(
    client, auth, monkeypatch, caplog
) -> None:
    """`UPLOAD_DISK_RESERVE_BYTES=0` means "reserve nothing", which is the documented
    default — so it is the one knob read with `minimum=0` and must NOT warn. Everything
    else it can be set to still does."""
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        monkeypatch.setenv("UPLOAD_DISK_RESERVE_BYTES", "0")
        assert uploads._disk_reserve_bytes() == 0
    assert not _malformed(caplog), _malformed(caplog)

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        monkeypatch.setenv("UPLOAD_DISK_RESERVE_BYTES", "-1")
        assert uploads._disk_reserve_bytes() == 0
    assert _malformed(caplog), "a negative reserve is a typo and must be audible"


# --- the rider: every cap is audible ([[T2-no-upload-cap-breach-is-ever-logged]])


def test_every_cap_in_this_module_logs_when_it_binds(
    client, auth, monkeypatch, caplog
) -> None:
    """Five caps, thirteen 413 sites, and before this seam not one of them said which
    cap fired or by how much — uvicorn's access log records only that A 413 happened.
    Drives one refusal per cap and asserts each names itself, its value and the
    observed figure. `_MAX_CHECK_FILES` is exercised through its own route below."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "1")
    monkeypatch.setenv("MAX_UPLOAD_CHECK_BODY_BYTES", "16")
    upload_id = _open_session(client, auth)

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert _post(client, auth, upload_id, "over.png", b"x" * 64).status_code == 413
        assert _post(client, auth, upload_id, "a.png", b"a").status_code == 200
        assert _post(client, auth, upload_id, "b.png", b"b").status_code == 413
        assert (
            client.post(
                f"/api/uploads/{upload_id}/check",
                headers=auth,
                json={"files": [{"name": "x" * 64, "size": 1}]},
            ).status_code
            == 413
        )

    logged = "\n".join(_warnings(caplog))
    for cap in (
        "cap=MAX_UPLOAD_PART_BYTES",
        "cap=MAX_UPLOAD_ENTRIES",
        "cap=MAX_UPLOAD_CHECK_BODY_BYTES",
    ):
        assert cap in logged, f"{cap} refused someone silently\n{logged}"
    assert logged.count("observed=") == 3
    assert "limit=8" in logged and "limit=1" in logged and "limit=16" in logged


def test_the_check_batch_cap_logs_too(client, auth, monkeypatch, caplog) -> None:
    """`_MAX_CHECK_FILES` is the one upload cap that is NOT env-tunable, which makes
    hearing it matter more, not less."""
    monkeypatch.setattr(uploads, "_MAX_CHECK_FILES", 2)
    upload_id = _open_session(client, auth)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        r = client.post(
            f"/api/uploads/{upload_id}/check",
            headers=auth,
            json={"files": [{"name": f"{i}.png", "size": 1} for i in range(3)]},
        )
    assert r.status_code == 413
    assert any(
        "cap=_MAX_CHECK_FILES" in m and "observed=3 files" in m
        for m in _warnings(caplog)
    ), _warnings(caplog)


# --- what a capacity bound does NOT promise ----------------------------------


def test_a_disk_that_fills_UNDER_an_in_flight_request_is_noticed(
    client, auth, monkeypatch
) -> None:
    """The budget snapshot alone would not catch this, which is why free space is
    re-read once per streaming chunk.

    A request is admitted against the space that existed when it started, and then
    another writer takes the rest of the device while its bytes are still arriving.
    The snapshot cannot see that — it was taken before — so a bound made only of it
    would happily write into a device with nothing left. The device is shrunk after
    the request's own budget read, i.e. inside the streaming loop, which is where a
    concurrent writer actually lands."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    device = _fake_device(monkeypatch, session, 64 * 1024 * 1024, shrink_after=1)

    r = _post(client, auth, upload_id, "big.png", b"a" * (4 * 1024 * 1024))
    assert r.status_code == 413, r.text
    assert "contact an administrator" in r.json()["detail"]
    assert device.reads > 1, "the streaming loop never re-read the device"
    assert list((session / "images").iterdir()) == [], "the partial part is removed"


def test_a_part_admitted_at_declaration_can_still_be_refused_mid_transfer(
    client, auth, monkeypatch
) -> None:
    """Free space is a moving target, and the seam does not pretend otherwise. A
    chunked part is admitted against its declared `part_size` at chunk 0 and then
    re-checked as every chunk lands, so a device that fills underneath it — another
    user, another process, the worker's own bake — is a refusal partway through, not a
    filled disk. Driven by shrinking the device between chunks."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    device = _fake_device(monkeypatch, session, 8 * 1024 * 1024)

    first = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("big.png", b"a" * 4096)},
        data={"chunk_offset": "0", "part_size": "8192"},
    )
    assert first.status_code == 200, first.text

    device.capacity = _occupied(session) + uploads._disk_floor(session)  # the disk fills
    second = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("big.png", b"a" * 4096)},
        data={"chunk_offset": "4096", "part_size": "8192"},
    )
    assert second.status_code == 413
    assert "contact an administrator" in second.json()["detail"]
    assert list((session / "images").iterdir()) == [], "no half part reaches the bundle"


def test_a_declared_part_too_big_for_the_device_is_refused_before_any_bytes(
    client, auth, monkeypatch
) -> None:
    """The one honest EARLY answer available: `part_size` is the only figure a client
    declares up front, so a part that cannot possibly fit is refused at chunk 0 for
    the cost of one request. Nothing else can be answered early — a plain part
    declares no size the server may trust, and a ZIP's uncompressed size is unknowable
    from its headers (D-27)."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    _fake_device(monkeypatch, session, 2 * 1024 * 1024)

    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("huge.png", b"a" * 16)},
        data={"chunk_offset": "0", "part_size": str(10 * 1024 * 1024)},
    )
    assert r.status_code == 413
    assert "contact an administrator" in r.json()["detail"]
    assert not (session / ".parts-tmp" / "huge.png").exists()


def test_a_chunked_archive_is_admitted_when_the_ARCHIVE_ITSELF_fits(
    client, auth, monkeypatch
) -> None:
    """**Replaces a gate that refused real corpora.** A `2 x part_size` admission check
    stood at chunk 0 on the reasoning that a chunked `.zip` is staged and then extracted
    beside itself. It over-charged, because `_plan_zip` extracts only `_IMAGE_EXTS`
    entries plus one root-level CSV and the archive is `os.replace`d rather than copied:
    for a RAW-heavy archive (`.dng .cr2 .nef .arw .heic .avif` are all outside
    `_IMAGE_EXTS`) the real peak is ~1x. Measured on this exact 4 MiB-payload archive
    through the chunked route: true peak 4,195,558 bytes against 8,391,068 demanded, and
    every headroom below 2.01x refused while the whole-part route accepted the identical
    bytes — with no workaround, because above MAX_UPLOAD_PART_BYTES chunking is the only
    route, and wearing the CAPACITY message so neither user nor operator could tell it
    from a full disk.

    What is pinned instead is the derived rule: the part alone must fit. The device here
    holds the archive 1.5x and the upload succeeds; the non-extractable entry is reported
    `ignored`, which is the proof that the 2x was charged for bytes that never landed.

    The refusal half is `test_a_declared_part_too_big_for_the_device_is_refused_before_
    any_bytes` — a part bigger than the headroom is still refused at chunk 0, archive or
    not."""
    payload = _stored_zip_with_unextractable_payload(4 * 1024 * 1024)
    declared = len(payload)
    capacity = uploads._PART_CHUNK_BYTES + declared + declared // 2  # fits 1x, not 2x

    zip_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(zip_id), capacity)
    archive = client.post(
        f"/api/uploads/{zip_id}/parts",
        headers=auth,
        files={"part": ("corpus.zip", payload)},
        data={"chunk_offset": "0", "part_size": str(declared)},
    )
    assert archive.status_code == 200, archive.text
    body = archive.json()
    assert body["ignored"] == ["notes.bin"], body
    assert (_session_dir(zip_id) / "images" / "pic.png").is_file()

# --- review findings D2 / D4 / D6: what the shipped defaults actually do ------


def test_the_capacity_warning_names_the_operators_ACTUAL_configuration(
    client, auth, monkeypatch, caplog
) -> None:
    """The log line must not misattribute the refusal. An earlier draft hardcoded
    `cap="disk capacity (no MAX_UPLOAD_BUNDLE_BYTES set)"` and printed it even when the
    operator HAD set one — the disk term binds first on a small device either way — so
    the one artefact whose job is to tell the operator which cap fired named the wrong
    cause, in the code closing [[T2-no-upload-cap-breach-is-ever-logged]]. It would
    have sent them to edit a variable that was already set and was not the binding
    term.

    Driven in BOTH configurations, because a line that is right in one and wrong in the
    other is the whole defect."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", str(100 * 1024 * 1024))
    set_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(set_id), 3 * 1024 * 1024)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        _fill(client, auth, set_id, b"x" * (512 * 1024))
    when_set = _warnings(caplog)
    assert any("MAX_UPLOAD_BUNDLE_BYTES=104857600 set but NOT the binding term" in m
               for m in when_set), when_set
    assert not any("MAX_UPLOAD_BUNDLE_BYTES unset" in m for m in when_set), when_set

    caplog.clear()
    monkeypatch.delenv("MAX_UPLOAD_BUNDLE_BYTES")
    unset_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(unset_id), 3 * 1024 * 1024)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        _fill(client, auth, unset_id, b"x" * (512 * 1024))
    when_unset = _warnings(caplog)
    assert any("MAX_UPLOAD_BUNDLE_BYTES unset" in m for m in when_unset), when_unset
    assert not any("set but NOT the binding term" in m for m in when_unset), when_unset


def test_a_chunked_resend_loses_its_allowance_when_no_cap_is_set(
    client, auth, monkeypatch, caplog
) -> None:
    """**Pins a property Seam A3 shipped that seam L1 silently disables by default.**

    A3 gave a chunked re-send an allowance up to its stored twin's size, so a blind
    retry of a part the bundle already holds is not refused just because the budget is
    spent. That allowance applies to the CAP term only — and after L1 the default is NO
    cap, so it is discarded, and on a full device the chunked re-send is refused while
    the WHOLE-PART re-send of the same bytes succeeds. Both of A3's own pins for this
    set an explicit cap, so the shipped default had no coverage at all.

    This pins the behaviour as it SHIPS, not as it ought to be: the refusal is correct
    (the allowance cannot lend space the device does not have — the chunked path must
    stage a second copy to hash it), but it is a real regression against A3's intent,
    so a future fix must fail this loudly rather than change it quietly.
    [[T2-a-chunked-re-send-is-refused-where-a-whole-part]].

    The asymmetry is the assertion: the same bytes, the same device, two routes.

    **Which line carries which claim, because they are not equally strong.** The
    `status_code == 413` is NOT isolated by the obvious mutation: extending the
    allowance to the disk term (`room = max(headroom, allowance)`) still yields 413,
    because the staged copy then meets the per-chunk live free-space check instead. That
    is not a weak pin so much as the finding itself — the property cannot be restored by
    widening a budget, only by not staging the copy at all, which is what the backlog
    item proposes. The DISCRIMINATING line is the operator-note assertion below: it
    fails under both that mutation and under dropping the note, and it is what stops the
    refusal reverting to claiming the dataset is too large."""
    body = b"r" * (512 * 1024)
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    assert _post(client, auth, upload_id, "twin.png", body).status_code == 200

    # Fill the device to the floor, so nothing has free budget left.
    device = _fake_device(monkeypatch, session, _occupied(session)
                          + uploads._disk_floor(session))

    whole = _post(client, auth, upload_id, "twin.png", body)
    assert whole.status_code == 200, whole.text
    assert whole.json()["already_present"] is True, "the whole-part route is unaffected"

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        chunked = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("twin.png", body[:1024])},
            data={"chunk_offset": "0", "part_size": str(len(body))},
        )
    assert chunked.status_code == 413, (
        "if this now passes, the allowance was restored -- update the comment at the "
        "`_bundle_budget(...allowance=...)` call and close the backlog item"
    )
    assert device.reads > 0
    # And the operator's line must not claim the DATASET is too large for a part the
    # server already holds in full.
    assert any("a chunked RE-SEND of 'twin.png'" in m and "already_present" in m
               for m in _warnings(caplog)), _warnings(caplog)


def test_a_cap_bound_resend_refusal_still_names_the_CAP(
    client, auth, monkeypatch, caplog
) -> None:
    """The control for the spec above, and it pins a defect that actually shipped for
    one commit. The re-send note must fire only when the DISK is the binding term. A
    first draft keyed it on `resend_allowance > 0` alone, so with an explicit cap set
    and 900 GB free it emitted a capacity refusal whose log line read
    `MAX_UPLOAD_BUNDLE_BYTES=16 set but NOT the binding term` — when it was exactly the
    binding term. That is finding D2's misattribution reproduced one branch over, in
    the fix for D4.

    Seam A3's `test_the_resend_byte_allowance_is_bounded_by_the_stored_twin` caught it
    on the RESPONSE; this pins the LOG, which is the half that item cares about."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "16")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    upload_id = _open_session(client, auth)
    for offset in (0, 8):
        assert client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("a.png", b"0123456789abcdef"[offset:offset + 8])},
            data={"chunk_offset": str(offset), "part_size": "16"},
        ).status_code == 200

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        over = client.post(  # 17 > the 16-byte twin AND > the free cap budget
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("a.png", b"x" * 8)},
            data={"chunk_offset": "0", "part_size": "17"},
        )
    assert over.status_code == 413
    assert "bundle limit" in over.json()["detail"]
    logged = _warnings(caplog)
    assert any("cap=MAX_UPLOAD_BUNDLE_BYTES" in m and "limit=16" in m for m in logged), logged
    assert not any("NOT the binding term" in m for m in logged), logged


def test_a_malformed_bundle_cap_is_not_a_silent_loosening(
    client, auth, monkeypatch, caplog
) -> None:
    """`MAX_UPLOAD_BUNDLE_BYTES=10GB` meant 2 GiB before this seam and means
    disk-only now — a config typo that LOOSENS a limit. `_env_int` quietly substitutes
    a default for the other caps; here there is no default to substitute, so the
    ceiling simply disappears. It must not do that silently."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "10GB")
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert uploads._explicit_max_bundle_bytes() is None
    assert any("'10GB' is not a positive integer" in r.getMessage()
               and "ONLY by free disk" in r.getMessage()
               for r in caplog.records), [r.getMessage() for r in caplog.records]


@pytest.mark.parametrize("blank", ["", " "])
def test_a_BLANK_bundle_cap_removes_the_ceiling_audibly(
    client, auth, monkeypatch, caplog, blank
) -> None:
    """The spelling of blank that actually ships, and the one that was silent.

    `if not raw: return None` returned BEFORE the warning, so `MAX_UPLOAD_BUNDLE_BYTES=''`
    dropped the policy ceiling without a word while `' '` was audible — two spellings of
    the same mistake behaving differently. The empty one is the one a real deployment
    produces: `MAX_UPLOAD_BUNDLE_BYTES=` in a `.env`, or the ordinary
    `- MAX_UPLOAD_BUNDLE_BYTES=${MAX_UPLOAD_BUNDLE_BYTES}` Compose form with the host
    variable unset, which Compose substitutes as an empty string. The key being present
    reads as "configured"; the ceiling is gone.

    Both spellings, because a fix that is right for one and wrong for the other is the
    whole defect."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", blank)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert uploads._explicit_max_bundle_bytes() is None
    assert any("ONLY by free disk" in m for m in _malformed(caplog)), _malformed(caplog)


def test_UNSET_is_silent_because_it_is_the_documented_default(
    client, auth, monkeypatch, caplog
) -> None:
    """The control for the spec above, and the line the fix must not cross. An UNSET
    knob is the documented behaviour and warning about it would make the genuine
    warnings worthless. Only a knob that is SET to something unusable is a config
    error."""
    for name in (
        "MAX_UPLOAD_BUNDLE_BYTES",
        "MAX_UPLOAD_PART_BYTES",
        "MAX_UPLOAD_ENTRIES",
        "UPLOAD_DISK_RESERVE_BYTES",
        "MAX_UPLOAD_CHECK_BODY_BYTES",
    ):
        monkeypatch.delenv(name, raising=False)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert uploads._explicit_max_bundle_bytes() is None
        assert uploads._max_part_bytes() == uploads._DEFAULT_MAX_PART_BYTES
        assert uploads._max_entries() == uploads._DEFAULT_MAX_ENTRIES
        assert uploads._disk_reserve_bytes() == 0
        assert uploads._max_check_body_bytes() == uploads._DEFAULT_MAX_CHECK_BODY_BYTES
    assert not _malformed(caplog), _malformed(caplog)


def test_every_env_knob_here_is_audible_when_it_is_malformed(
    client, auth, monkeypatch, caplog
) -> None:
    """The fix at the right depth: the warning lives in the shared parser, so all five
    knobs got it at once.

    Before, only `MAX_UPLOAD_BUNDLE_BYTES` warned — it had a hand-rolled copy of
    `_env_int` with a `_logger.warning` bolted on, and the four knobs that used the
    original were mute. Including `UPLOAD_DISK_RESERVE_BYTES`, the knob this seam ADDED
    to protect the rest of the service: `'2GB'`, `'1 GiB'` and `'-1'` all silently
    reserved nothing, and `MAX_UPLOAD_ENTRIES='1OOO'` (letter O) silently restored
    1,000,000. Every one of those loosens a limit while reading as configured."""
    cases = [
        ("MAX_UPLOAD_PART_BYTES", "100MB", uploads._max_part_bytes,
         uploads._DEFAULT_MAX_PART_BYTES),
        ("MAX_UPLOAD_ENTRIES", "1OOO", uploads._max_entries,
         uploads._DEFAULT_MAX_ENTRIES),
        ("UPLOAD_DISK_RESERVE_BYTES", "2GB", uploads._disk_reserve_bytes, 0),
        ("MAX_UPLOAD_CHECK_BODY_BYTES", "40 MiB", uploads._max_check_body_bytes,
         uploads._DEFAULT_MAX_CHECK_BODY_BYTES),
    ]
    for name, raw, read, fallback in cases:
        caplog.clear()
        uploads._warn_malformed_env.cache_clear()
        monkeypatch.setenv(name, raw)
        with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
            assert read() == fallback, name
        assert any(f"{name}={raw!r}" in m for m in _malformed(caplog)), (
            f"{name}={raw!r} fell back to {fallback} without saying so: "
            f"{_malformed(caplog)}"
        )
        monkeypatch.delenv(name)


def test_a_malformed_knob_warns_ONCE_not_once_per_request(
    client, auth, monkeypatch, caplog
) -> None:
    """**The genuine warnings this seam shipped must not be drowned by the config one.**

    `_explicit_max_bundle_bytes` is called from `_bundle_budget` on every charged request
    plus again from each refusal builder, and it logged unconditionally: with
    `MAX_UPLOAD_BUNDLE_BYTES=10GB` — the exact typo the code's own comment cites — 9
    requests produced 13 warnings, 1 per accepted part and 2 per refused one. At 206
    chars/line one rijks_pd loose upload (49,048 parts) is 49,048 lines / 10.1 MB, and
    the `"upload cap reached"` lines that close
    [[T2-no-upload-cap-breach-is-ever-logged]] become one in ~50,000.

    Once per distinct value, and the CAP warnings still fire every time — that asymmetry
    is the assertion, not the absolute count."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "10GB")
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    upload_id = _open_session(client, auth)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        for i in range(6):
            _post(client, auth, upload_id, f"p{i}.png", b"x" * 32)

    assert len(_malformed(caplog)) == 1, (
        f"one typo, {len(_malformed(caplog))} warnings across 6 requests"
    )
    assert len(_warnings(caplog)) >= 3, (
        "the entry cap bound on four of those requests and every breach must be heard: "
        f"{_warnings(caplog)}"
    )


# --- finding 1: a body with no bytes is still a request against the bound ------


def test_a_ZERO_BYTE_part_still_meets_the_derived_bound(
    client, auth, monkeypatch, caplog
) -> None:
    """`budget.check()` lived only inside `while chunk := await part.read(...)`, so an
    empty body consulted neither the disk floor nor the byte cap. On a device pinned at
    0 free, a 1-byte part was refused 413 and a 0-byte part returned 200 — and fifty
    more were accepted after it, each one still driving `_apply_tally_delta` +
    `_apply_manifest_entries` (two temp-then-replace writes) onto the full device.
    `uploadSelection.ts` pushes parts with no `size > 0` guard, so the shipped client
    reaches this path.

    The 1-byte control is what makes this about the EMPTY body and not about the
    device."""
    upload_id = _open_session(client, auth)
    monkeypatch.setattr(uploads, "_disk_free", lambda path: 0)

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        one_byte = _post(client, auth, upload_id, "one.png", b"x")
        empty = _post(client, auth, upload_id, "empty.png", b"")

    assert one_byte.status_code == 413, one_byte.text
    assert empty.status_code == 413, (
        f"a zero-byte part was accepted on a full device: {empty.text}"
    )
    assert "contact an administrator" in empty.json()["detail"]
    assert list((_session_dir(upload_id) / "images").iterdir()) == []
    assert len(_warnings(caplog)) == 2, _warnings(caplog)


def test_a_zero_byte_part_is_accepted_when_there_IS_room(client, auth) -> None:
    """The other half, so the fix above is a BOUND and not a ban: an empty file is a
    legitimate (if useless) part, and on a device with room it still stores, counts and
    hashes exactly as before."""
    upload_id = _open_session(client, auth)
    r = _post(client, auth, upload_id, "empty.png", b"")
    assert r.status_code == 200, r.text
    assert r.json()["received_parts"] == 1
    assert (_session_dir(upload_id) / "images" / "empty.png").stat().st_size == 0


def test_a_zero_byte_CHUNK_still_meets_the_derived_bound(
    client, auth, monkeypatch
) -> None:
    """The same hole on the Seam A3 loop, which has the same shape.

    **Driven at chunk_offset > 0, and the first draft of this spec was not.** At offset 0
    the declared-size refusal fires first — `part_size` alone exceeds a spent budget — so
    a 413 there says nothing about the loop. Verified: deleting `_append_part_chunk`'s
    pre-loop check left the offset-0 version passing. Past offset 0 there is no declared
    figure left to refuse on, and the loop is the only thing between an empty body and a
    200."""
    upload_id = _open_session(client, auth)
    staging = _session_dir(upload_id) / ".parts-tmp" / "big.png"
    first = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("big.png", b"a" * 4096)},
        data={"chunk_offset": "0", "part_size": "8192"},
    )
    assert first.status_code == 200, first.text
    assert staging.stat().st_size == 4096

    monkeypatch.setattr(uploads, "_disk_free", lambda path: 0)
    empty = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("big.png", b"")},
        data={"chunk_offset": "4096", "part_size": "8192"},
    )
    assert empty.status_code == 413, (
        f"a zero-byte chunk was accepted on a full device: {empty.text}"
    )
    assert "contact an administrator" in empty.json()["detail"]


def test_a_zero_byte_ZIP_ENTRY_still_meets_the_derived_bound(
    client, auth, monkeypatch
) -> None:
    """And the third loop, which is the one that creates files fastest: an archive of
    empty entries would otherwise place one file per entry without ever asking the bound
    anything, bounded only by the entry cap — and the byte bound cannot see the inodes
    those files consume (`_DEFAULT_MAX_ENTRIES`,
    [[T2-the-byte-bound-is-blind-to-inode-exhaustion]]).

    The device is read once to admit the archive itself and is empty by the time the
    extraction budget is taken, so the only thing that can refuse the entry is the check
    the loop makes before reading its first (non-existent) chunk."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("empty.png", b"")
    archive = buf.getvalue()

    reads = [0]

    def fills_after_staging(path) -> int:  # noqa: ANN001
        reads[0] += 1
        return 64 * 1024 * 1024 if reads[0] == 1 else 0

    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    monkeypatch.setattr(uploads, "_disk_free", fills_after_staging)
    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("empties.zip", archive)},
    )
    assert r.status_code == 413, (
        f"a zero-byte archive entry was extracted onto a full device: {r.text}"
    )
    assert list((session / "images").iterdir()) == [], "nothing may be merged"
    assert not (session / ".extract-tmp").exists(), "staging must be removed"


# --- finding 4: part_size is pinned across a part's chunks --------------------


def test_a_chunk_may_not_declare_a_DIFFERENT_part_size(client, auth) -> None:
    """**The admission gates at chunk 0 were advisory and refused only honest clients.**

    `part_size` is a Form field re-read from every chunk request and was never stored, so
    a client could declare a small part at offset 0, pass every up-front check, and then
    declare the real size from chunk 1 on — no gate re-runs. Reproduced against the
    shipped code: `part_size=8192` at offset 0 -> 200, then `chunk_offset=4096,
    part_size=2097152` -> 200, with 2,031,616 bytes staged against a headroom the gate
    was meant to cap at half.

    Both directions are refused, because a SHRINKING declaration is the other half: it
    completes a truncated part as though it were whole, which is precisely the silent
    stitching `_ingest_part_chunk`'s docstring promises against."""
    body = b"c" * 8192
    for label, second in (("grown", 1 << 20), ("shrunk", 4096 + 1)):
        upload_id = _open_session(client, auth)
        first = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("part.png", body[:4096])},
            data={"chunk_offset": "0", "part_size": "8192"},
        )
        assert first.status_code == 200, first.text

        changed = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("part.png", body[4096:])},
            data={"chunk_offset": "4096", "part_size": str(second)},
        )
        assert changed.status_code == 409, (
            f"a {label} part_size was accepted mid-part: {changed.text}"
        )
        assert "may not change between chunks" in changed.json()["detail"]
        # ...and the honest continuation of the SAME declaration still works.
        honest = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("part.png", body[4096:])},
            data={"chunk_offset": "4096", "part_size": "8192"},
        )
        assert honest.status_code == 200, honest.text
        assert (_session_dir(upload_id) / "images" / "part.png").read_bytes() == body


def test_a_completed_part_forgets_its_declaration(client, auth) -> None:
    """The declaration is staging, not state: it is dropped with the staged file, so the
    same basename can be sent again later under a different size without inheriting a
    409 from a part that finished hours ago."""
    upload_id = _open_session(client, auth)
    for offset in (0, 4096):
        assert client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("a.png", b"a" * 4096)},
            data={"chunk_offset": str(offset), "part_size": "8192"},
        ).status_code == 200
    assert not (_session_dir(upload_id) / ".parts-meta" / "a.png").exists()

    # A different name, a different size — no residue from the completed part.
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("b.png", b"b" * 16)},
        data={"chunk_offset": "0", "part_size": "16"},
    ).status_code == 200


# --- findings 2 + 3: the residual cases are refusals, never 500s --------------


def test_an_ENOSPC_during_extraction_is_a_413_not_a_500(
    client, auth, monkeypatch, caplog
) -> None:
    """`_extract_and_merge_zip` caught `BadZipFile`/`zlib.error`/`NotImplementedError`
    and nothing else, and `main.py` registers no handler — so an `OSError` from
    `dst.write` inside `_extract_entry` escaped as an unhandled 500. It is reachable:
    with N concurrent extractions the one-chunk floor was overshot by (N-1) chunks, and
    a 4-way run on a real tmpfs produced 1-3 of these per run with low-water free at 0.

    The floor now scales with the live writer count so the overshoot itself is gone, but
    a projection can still be wrong (unusually long basenames, a writer in another
    uvicorn process), and this is what makes those a refusal instead of a crash — the
    claim `_disk_floor`'s own docstring makes.

    Driven by making the write raise, because filling a real device from a unit test is
    not deterministic; the real-device half is `test_the_real_disk_read_is_exercised...`
    and the tmpfs probe named in the report."""
    real_extract = uploads._extract_entry

    def enospc(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(uploads, "_extract_entry", enospc)
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        r = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("corpus.zip", _zip_bomb(1024))},
        )

    assert r.status_code == 413, r.text
    assert "contact an administrator" in r.json()["detail"]
    assert any("could not be written" in m for m in _warnings(caplog)), _warnings(caplog)
    assert list((session / "images").iterdir()) == [], "nothing may be merged"
    assert not (session / ".extract-tmp").exists(), "staging must be removed"

    # ...and the control: with the real extractor the same archive lands.
    monkeypatch.setattr(uploads, "_extract_entry", real_extract)
    ok = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("corpus.zip", _zip_bomb(1024))},
    )
    assert ok.status_code == 200, ok.text


def test_a_failed_sidecar_write_leaves_BOTH_CACHES_BEHIND_pending_the_spike(
    client, auth, monkeypatch
) -> None:
    """**A PIN OF A KNOWN DEFECT, not of desired behaviour.** It exists so the next
    person to change this path has to change this spec deliberately, and so the cost of
    the deferral is written down in executable form rather than in a commit message.

    `.tally.json` is written FIRST, so an `OSError` there aborts the request before
    `_apply_manifest_entries` is reached. Both sidecars keep their previous, complete-
    LOOKING contents while the part is already in `images/`, and NOTHING DETECTS THAT:
    `_read_tally`/`_read_manifest` rebuild only "on doubt", and a complete file raises
    none. Measured here, and the numbers are the point — bundle 2 files, tally 1 file /
    64 bytes, manifest 1 entry, `POST /check` reporting a file the server already holds
    as `needed`, so a resuming client re-sends bytes onto the device that just ran out.
    The tally being low also under-counts every later admission check; finalize's
    reconciliation recount is what repairs that before ingest sees it.

    Three designs shipped for this during review (unlink-and-rebuild, a `.stale` marker,
    `best_effort` persists) and all three were refuted, because each recovery was itself
    a write to the device that had just refused a write. The fourth is chosen by
    measurement: `docs/spikes/spike_upload_session_recovery.md`. Until it runs, this is
    the accepted behaviour, and it is what `main` does today.

    The failure is also a 500, not a capacity 413: a sidecar is not one of the three
    streaming loops the conversion covers (`_streaming_capacity_refusal`)."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    assert _post(client, auth, upload_id, "first.png", b"1" * 64).status_code == 200

    real_replace = os.replace

    def enospc(src, dst, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if str(dst).endswith(".tally.json"):
            raise OSError(28, "No space left on device")
        return real_replace(src, dst, **kwargs)

    monkeypatch.setattr(uploads.os, "replace", enospc)
    with pytest.raises(OSError) as failed:
        _post(client, auth, upload_id, "second.png", b"2" * 64)
    assert failed.value.errno == errno.ENOSPC, failed.value

    # The bytes ARE committed; both caches are behind and neither knows it.
    monkeypatch.setattr(uploads.os, "replace", real_replace)
    assert (session / "images" / "second.png").is_file()
    assert json.loads((session / ".tally.json").read_text()) == {
        "count": 1, "bytes": 64,
    }, "the tally recovered on its own -- if so, the spike has landed; update this pin"
    status_body = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    listed = client.get(f"/api/uploads/{upload_id}/files", headers=auth).json()
    assert (status_body["received_parts"], listed["total"]) == (1, 1), (
        f"a cache repaired itself: {status_body} vs {listed}"
    )
    checked = client.post(
        f"/api/uploads/{upload_id}/check",
        headers=auth,
        json={"files": [{"name": "second.png", "size": 64}]},
    )
    assert checked.json()["needed"] == ["second.png"], (
        "the accepted cost of the deferral: a resume re-sends bytes already on disk"
    )


# --- finding 10: what the refusal line says -----------------------------------


def test_the_capacity_line_reports_the_reading_that_ACTUALLY_refused(
    client, auth, monkeypatch, caplog
) -> None:
    """`_capacity_refusal` re-read `_disk_free` instead of using the reading that had
    just refused, one line earlier. Free rises between the two whenever anything on the
    shared mount finishes — a concurrent `rmtree` of `.extract-tmp/`, a bake completing —
    and the line then prints a free figure ABOVE the floor, i.e. it states that the
    refusal condition was not met.

    Driven by a device that jumps to 900 GB free immediately after the reading that
    refuses. The logged figure must be the small one."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    readings = [0]

    def rising(path) -> int:  # noqa: ANN001
        readings[0] += 1
        return 1 if readings[0] <= 1 else 900_000_000_000

    monkeypatch.setattr(uploads, "_disk_free", rising)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        r = _post(client, auth, upload_id, "a.png", b"x" * 64)

    assert r.status_code == 413, r.text
    logged = _warnings(caplog)
    assert any("1 bytes free" in m for m in logged), logged
    assert not any("900000000000 bytes free" in m for m in logged), (
        f"the line printed a free figure that would NOT have refused: {logged}"
    )
    assert list((session / "images").iterdir()) == []


def test_a_pre_write_refusal_does_not_claim_bytes_it_never_wrote(
    client, auth, monkeypatch, caplog
) -> None:
    """`observed=` read `"{free} bytes free after {N} bytes of this request"` at three
    sites that refuse BEFORE writing anything, passing the client's DECLARED `part_size`
    as N. An operator read `972335833088 bytes free after 400000000 bytes of this
    request` for a request that wrote nothing at all."""
    upload_id = _open_session(client, auth)
    _fake_device(monkeypatch, _session_dir(upload_id), 2 * 1024 * 1024)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        r = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("huge.png", b"a" * 16)},
            data={"chunk_offset": "0", "part_size": str(10 * 1024 * 1024)},
        )
    assert r.status_code == 413
    logged = _warnings(caplog)
    assert any("refusing a declared 10485760-byte part" in m for m in logged), logged
    assert not any("bytes of this request" in m for m in logged), (
        f"the request wrote nothing, so it must not report bytes written: {logged}"
    )


def test_a_cumulative_cap_reports_a_CUMULATIVE_observed_figure(
    client, auth, monkeypatch, caplog
) -> None:
    """`MAX_UPLOAD_BUNDLE_BYTES` is cumulative across the bundle, but `observed=` was
    this request's slice: a bundle holding 900 against a cap of 1000, sent 200 more,
    logged `limit=1000 observed=200` — a stated breach BELOW its own limit, which reads
    as a bug in the limit rather than a full bundle. All four `_entry_cap_refusal` sites
    already emitted cumulative figures, so the correct shape was in the same file."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "1000")
    upload_id = _open_session(client, auth)
    assert _post(client, auth, upload_id, "a.png", b"a" * 900).status_code == 200
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        over = _post(client, auth, upload_id, "b.png", b"b" * 200)

    assert over.status_code == 413
    assert over.json()["detail"] == "Upload bundle exceeds the 1000-byte bundle limit"
    logged = _warnings(caplog)
    assert any("limit=1000" in m and "observed=1100 bundle bytes" in m for m in logged), (
        f"the figure logged against a cumulative cap must be the cumulative one: {logged}"
    )
    assert any("(200 in this request)" in m for m in logged), (
        f"the per-request slice is still useful -- it just is not the breach: {logged}"
    )


def test_an_allowance_bound_refusal_names_the_budget_that_BOUND(
    client, auth, monkeypatch, caplog
) -> None:
    """When the Seam A3 re-send allowance produces `remaining`, the figure that bound is
    the allowance — not `cap - spoken_for`. `_bundle_cap_refusal` discarded it and
    re-read the env, so the line named 5000 for a request that could in fact have added
    800, and 800 appeared nowhere and was not derivable (5000 - 4990 = 10).

    The user-facing detail still names the CAP, deliberately: that is the number an
    operator raises. The budget goes to the log, beside it."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "5000")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "5000")
    upload_id = _open_session(client, auth)
    assert _post(client, auth, upload_id, "twin.png", b"t" * 800).status_code == 200
    assert _post(client, auth, upload_id, "bulk.png", b"b" * 4190).status_code == 200

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        over = client.post(  # 801 > the 800-byte twin allowance
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("twin.png", b"t" * 64)},
            data={"chunk_offset": "0", "part_size": "801"},
        )
    assert over.status_code == 413, over.text
    assert over.json()["detail"] == "Upload bundle exceeds the 5000-byte bundle limit"
    logged = _warnings(caplog)
    assert any("limit=5000 (this request could add 800)" in m for m in logged), logged


# --- finding 14: the real disk read, and the syscalls it costs ----------------


def test_the_real_disk_read_is_exercised_by_the_real_route(client, auth) -> None:
    """**Every other spec here replaces `_disk_free` wholesale, so `shutil.disk_usage`
    and the `_measurable` ancestor walk never execute at all** — `grep -rn _measurable
    packages/ tests/` returned three hits, all in `uploads.py`, none in a test. A
    simulated device cannot catch a `_measurable` that walks past the mount, a
    `disk_usage` called on a path that does not exist, or a reading taken of the wrong
    thing.

    This one runs the shipped functions against the real filesystem the session is on
    (`tmp_path`, via DATA_ROOT), asserting only what is true of any device: the reading
    is taken, it is internally consistent, and `_measurable` resolves a path that does
    not exist yet to an ancestor that does. The BOUND at a real small size is
    `test_the_bound_holds_on_a_REAL_small_filesystem`, which needs a mount pytest cannot
    create."""
    session = _session_dir(_open_session(client, auth))
    probe = uploads._measurable(session)
    assert probe == session, "an existing session dir must not be walked up from"
    assert uploads._measurable(session / "no" / "such" / "child") == session

    free = uploads._disk_free(probe)
    total = uploads._disk_total(probe)
    assert 0 <= free <= total and total > 0, (free, total)

    # And the shipped route reaches that same real reading: no fake, a real 200.
    upload_id = _open_session(client, auth)
    assert _post(client, auth, upload_id, "real.png", b"r" * 4096).status_code == 200


@pytest.mark.skipif(
    not os.environ.get("UPLOAD_TEST_SMALL_FS"),
    reason="needs a real small filesystem: docker run "
           "--tmpfs /small:size=8m,nr_inodes=256 ... -e UPLOAD_TEST_SMALL_FS=/small",
)
def test_the_bound_holds_on_a_REAL_small_filesystem() -> None:
    """The committed regression guard for the real disk read, on a device small enough
    for the bound to bind — block accounting, directory entries and all, which the
    simulated `_Device` explicitly does not model.

    Runs only when `UPLOAD_TEST_SMALL_FS` names a real small mount, because pytest
    cannot create one without privileges (`mount` is not available to the test image).
    The exact invocation is in the skip reason. The PR's own real-tmpfs evidence was a
    one-off probe; this makes it repeatable.

    **It isolates the FLOOR, and a first draft did not.** Admitted against a device with
    plenty free, the snapshot budget alone stops a single writer at about the right
    place, so `_disk_floor` could be replaced with `return 0` and the spec still passed.
    Here a BALLAST file takes the device down to just under one chunk free after the
    first chunk lands — the real event the per-chunk re-read exists for, another writer
    on the same mount — so the snapshot cannot be what refuses. Without the floor the
    next write ENOSPCs instead, which is a crash rather than a refusal, and that is the
    difference this asserts."""
    small = Path(os.environ["UPLOAD_TEST_SMALL_FS"])
    session = small / "session"
    (session / "images").mkdir(parents=True, exist_ok=True)
    probe = uploads._measurable(session)
    total = uploads._disk_total(probe)
    assert total < 64 * 1024 * 1024, f"{small} is not a SMALL filesystem ({total} bytes)"

    budget = uploads._bundle_budget(session)
    assert budget.remaining is not None
    assert budget.remaining < uploads._disk_free(probe), "the floor must be held back"

    target = session / "images" / "fill.bin"
    ballast = small / "ballast.bin"
    chunk = b"z" * uploads._PART_CHUNK_BYTES
    written = 0
    try:
        with pytest.raises(Exception) as refused:
            with target.open("wb") as fh:
                for i in range(1024):
                    written += len(chunk)
                    budget.check(written)
                    fh.write(chunk)
                    fh.flush()
                    if i == 0:  # another writer takes the device, mid-transfer
                        spare = uploads._disk_free(probe)
                        ballast.write_bytes(
                            b"b" * max(0, spare - uploads._PART_CHUNK_BYTES + 65536)
                        )
        assert getattr(refused.value, "status_code", None) == 413, (
            f"the real device answered {type(refused.value).__name__} rather than a "
            f"refusal: {refused.value}"
        )
        free_at_stop = uploads._disk_free(probe)
        assert free_at_stop >= uploads._PART_CHUNK_BYTES // 2, (
            f"the bound stopped with only {free_at_stop} bytes free on a real device"
        )
    finally:
        target.unlink(missing_ok=True)
        ballast.unlink(missing_ok=True)


# --- the same real device with NO INODES LEFT, driven through the real routes ------
#
# **Why this tier exists, and why the specs above cannot stand in for it.** Every other
# capacity spec in this file injects its failure at `os.replace`, the LAST syscall of a
# sidecar write. A device that is genuinely out of room fails at the FIRST allocating one
# — `tempfile.mkstemp` — because it cannot create a temp file before it can rename one.
# So the suite was measuring one path and reporting the other as covered, and each review
# round pinned the line it had just fixed while the defect moved one level down (review
# of PR #304, finding 19). This tier is also the precondition for the recovery spike
# (`docs/spikes/spike_upload_session_recovery.md`): no candidate design can be evaluated
# until an instrument exists that fails where a real device fails.
#
# INODES rather than bytes, because that is the state in which the whole byte-derived
# bound is inert: `f_favail == 0` while `shutil.disk_usage().free` still reports
# megabytes, so nothing this seam added binds and the first allocating syscall is what
# refuses. Measured on `--tmpfs /small:size=8m,nr_inodes=256`: 240 empty files take
# `f_favail` to 0 with 8,372,224 bytes still free, and `mkstemp` then raises ENOSPC.
#
# It needs a mount pytest cannot create, so without one it SKIPS — the same degradation
# `test_the_bound_holds_on_a_REAL_small_filesystem` takes, and the same caveat: under
# `CLAUDE.md`'s own docker command (no `--tmpfs`, no env var) this whole tier is silent.
_SMALL_FS_SKIP = (
    "needs a real small filesystem with an inode budget: docker run "
    "--tmpfs /small:size=8m,nr_inodes=256 ... -e UPLOAD_TEST_SMALL_FS=/small"
)

# The largest declared free-inode count this harness will try to exhaust. It creates one
# empty file per free inode, so it is affordable only on a mount that DECLARES a small
# `nr_inodes`: the CI mount declares 256 and exhausting it costs 240 creations, measured
# at well under a second. A tmpfs mounted without the option defaults to roughly
# `totalram/2` inodes — millions — where the same loop would run until the box is out of
# memory. The ceiling is 16x the CI mount's budget so a slightly larger one still runs,
# and anything above it is not a slow test but a MISSING MOUNT OPTION, which is what the
# failure says.
_STARVABLE_INODES = 4096


class _StarvedSession:
    """A real upload session on a real filesystem, driven through the real routes, whose
    device can be taken to zero free inodes on demand.

    `APP_STATE_DB` deliberately stays on the pytest tmp device, NOT the small mount: the
    instrument exists to starve the DATA_ROOT device, and starving the app-state device
    too would fail the request at login and measure the wrong thing."""

    def __init__(self, client, auth, upload_id: str, root: Path, ballast: Path) -> None:
        self.client = client
        self.auth = auth
        self.upload_id = upload_id
        self.root = root
        self.ballast = ballast
        self.session = root / "users" / "alice" / "uploads" / upload_id

    def doubt(self) -> None:
        """Put both sidecars in the module's DOCUMENTED doubt state — absent, the first
        cause `_read_tally` and `_read_manifest` name — so the next read has to REBUILD
        and therefore has to WRITE. That is what makes the read paths reach the device at
        all; with valid sidecars they never allocate anything.

        Done before the device is starved, deliberately: unlinking frees two inodes, and
        `starve()` runs afterwards and takes every remaining one. The bundle in `images/`
        is untouched, so the rebuild has the full truth available to it."""
        (self.session / uploads._TALLY_FILE).unlink(missing_ok=True)
        (self.session / uploads._FILES_FILE).unlink(missing_ok=True)

    def starve(self) -> int:
        """Take the device to zero free inodes with empty files, and return how many it
        took. Fails loudly (never skips, never hangs) on a mount with no inode budget."""
        free_inodes = os.statvfs(self.root).f_favail
        assert free_inodes <= _STARVABLE_INODES, (
            f"{self.root} declares {free_inodes} free inodes: the mount is missing "
            f"nr_inodes. {_SMALL_FS_SKIP}"
        )
        made = 0
        try:
            while made <= free_inodes + 1:
                (self.ballast / f"b{made:06d}").touch()
                made += 1
        except OSError:
            pass
        assert os.statvfs(self.root).f_favail == 0, (
            f"{made} files did not exhaust the inode budget of {self.root}"
        )
        return made

    def relent(self) -> None:
        shutil.rmtree(self.ballast, ignore_errors=True)
        self.ballast.mkdir(exist_ok=True)


@pytest.fixture
def starved(tmp_path, monkeypatch) -> Iterator[_StarvedSession]:
    """A two-part upload session on the small mount, ready to be starved of inodes.

    The session is built through the real routes (signup, login, `POST /api/uploads`,
    two `POST .../parts`), so what the specs below drive is the shipped request path and
    not a helper called directly — which is the second half of finding 19:
    `test_the_bound_holds_on_a_REAL_small_filesystem` exercises `_bundle_budget` and
    `budget.check`, and never reaches `_write_tally`, `_write_manifest` or any route."""
    if not os.environ.get("UPLOAD_TEST_SMALL_FS"):
        pytest.skip(_SMALL_FS_SKIP)
    small = Path(os.environ["UPLOAD_TEST_SMALL_FS"])
    root = small / f"data-{tmp_path.name}"
    ballast = small / f"ballast-{tmp_path.name}"
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(ballast, ignore_errors=True)
    root.mkdir(parents=True)
    ballast.mkdir()
    monkeypatch.setenv("APP_STATE_DB", str(tmp_path / "appstate.db"))
    monkeypatch.setenv("DATA_ROOT", str(root))
    from api.main import create_app

    try:
        with TestClient(create_app()) as client:
            client.app.state.redis = _FakeRedis()
            assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
            token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
            auth = {"Authorization": f"Bearer {token}"}
            upload_id = _open_session(client, auth)
            for name in ("first.png", "second.png"):
                assert _post(client, auth, upload_id, name, b"1" * 64).status_code == 200
            yield _StarvedSession(client, auth, upload_id, root, ballast)
    finally:
        shutil.rmtree(ballast, ignore_errors=True)
        shutil.rmtree(root, ignore_errors=True)


def test_the_harness_reaches_the_real_routes_with_a_REAL_out_of_room(
    starved, caplog
) -> None:
    """The instrument's own control, and it must PASS — every other spec in this tier
    asserts a defect, so without this one a broken harness would look like a clean bill
    of health.

    It pins the three properties the tier depends on: the device really does refuse
    allocations, the byte-derived bound is INERT while it does (megabytes free, so
    nothing this seam computes can be what refuses), and the refusal that comes back is
    the filesystem's, reported by `_streaming_capacity_refusal` with the errno it actually
    holds."""
    made = starved.starve()
    free_bytes = uploads._disk_free(starved.session)
    assert free_bytes > 4 * 1024 * 1024, (
        f"only {free_bytes} bytes free: this is a BYTE-full device, and the point of "
        "this tier is a device that refuses with room to spare"
    )
    assert made > 0

    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        refused = _post(starved.client, starved.auth, starved.upload_id, "third.png", b"3" * 64)
    assert refused.status_code == 413, refused.text
    assert refused.json()["detail"] == uploads._CAPACITY_DETAIL
    assert any("ENOSPC, reported by the filesystem" in m for m in _warnings(caplog)), (
        caplog.text
    )
    assert not (starved.session / "images" / "third.png").exists()


def test_a_READ_on_a_device_that_cannot_ALLOCATE_is_never_a_capacity_413(
    starved,
) -> None:
    """**The narrowing, pinned on a real starved device: a read is not a capacity
    event.** The ENOSPC -> 413 conversion is scoped to the three streaming write loops
    (`_streaming_capacity_refusal`); it used to be an app-wide
    `add_exception_handler(OSError, ...)`, and under that registration these same three
    routes answered 413/413/413 with 8,372,224 bytes free — a refusal, for a read, naming
    a remedy about bytes on a device that had run out of inodes (review of PR #304,
    findings 1 and 9).

    Two halves, and they are different properties. With the sidecars VALID the routes
    never allocate at all, so they answer 200 with the truth. With the sidecars in doubt
    the repair write cannot be persisted and the request fails — a 500 with its
    traceback, which is the status quo ante this seam returns to rather than shipping a
    fourth unmeasured recovery design (`docs/spikes/spike_upload_session_recovery.md`).
    What must be true either way, and is what this pins, is that neither answer is the
    capacity 413: restoring the app-wide handler turns the second half into one."""
    starved.starve()

    got = starved.client.get(f"/api/uploads/{starved.upload_id}", headers=starved.auth)
    assert got.status_code == 200, f"a READ was refused: {got.text}"
    assert got.json()["received_parts"] == 2

    listed = starved.client.get(
        f"/api/uploads/{starved.upload_id}/files", headers=starved.auth
    )
    assert listed.status_code == 200, f"a READ was refused: {listed.text}"
    assert {f["name"] for f in listed.json()["files"]} == {"first.png", "second.png"}

    checked = starved.client.post(
        f"/api/uploads/{starved.upload_id}/check",
        headers=starved.auth,
        json={"files": [{"name": "first.png", "size": 64}]},
    )
    assert checked.status_code == 200, f"a READ was refused: {checked.text}"
    assert checked.json()["present"] == ["first.png"]

    # ...and the half that DOES reach the device: a sidecar in doubt makes the read
    # rebuild, and the rebuild cannot be cached. It raises. It must not be a 413.
    starved.relent()
    starved.doubt()
    starved.starve()
    for call in (
        lambda: starved.client.get(
            f"/api/uploads/{starved.upload_id}", headers=starved.auth
        ),
        lambda: starved.client.get(
            f"/api/uploads/{starved.upload_id}/files", headers=starved.auth
        ),
    ):
        with pytest.raises(OSError) as raised:
            call()
        assert raised.value.errno == errno.ENOSPC, raised.value


def test_a_session_VANISHES_from_its_owners_listing_pending_the_spike(starved) -> None:
    """**A PIN OF A KNOWN DEFECT.** `GET /api/uploads` answers 200 with a list that does
    not contain a session which is on disk, so a client's resume surface says the upload
    never existed. Measured `200 []` for a session holding two committed parts.

    The mechanism is `_list_sessions`' `except OSError`, which predates this seam
    (present at merge-base `92b6ac6`) and is right for what it was written for — one
    session racing a concurrent delete must not 500 the whole list. What reaches it here
    is `_load_or_recount_tally`'s repair write failing on a device with no inodes left,
    and no recovery for that is being written on reasoning alone:
    `docs/spikes/spike_upload_session_recovery.md`, whose "operator flow" section is
    where this belongs. If this spec starts failing, the spike has landed — update it,
    do not delete it."""
    starved.doubt()
    starved.starve()

    listing = starved.client.get("/api/uploads", headers=starved.auth)
    assert listing.status_code == 200, listing.text
    assert starved.session.is_dir(), "the session must still be on disk for this to mean anything"
    assert [s["upload_id"] for s in listing.json()] == [], (
        f"the listing recovered: {listing.json()}"
    )


def test_the_first_check_of_a_request_costs_no_second_reading(
    client, auth, monkeypatch
) -> None:
    """**A PERF pin, and it is a bound on syscalls rather than on time.**

    `_bundle_budget` reads free space, and `check` then re-read it for the very first
    chunk although nothing of the request had been written in between — 100% overhead for
    a single-chunk part, which is what a loose-image upload is: 49,048 redundant
    `statvfs` pairs for one rijks_pd session, on the event loop of a single-worker
    uvicorn that also serves pyramid range reads. The budget now spends its own reading
    for the first check.

    The floor's invariant is unchanged and that is why this is safe: between the
    admitting reading (nothing of this part on disk) and the next check's reading
    exactly one chunk is written, which is what the floor reserves. So the multi-chunk
    case must still re-read once per chunk, and that is asserted too.

    **The multi-chunk figure is 4 and it used to be 3, because the gate was wrong.** It
    was `on_disk > self._read_at` with both counters starting at 0, so the disk term did
    not move until the THIRD check and the docstring's "every check from the second
    chunk on is live" was false (round-2 review, finding 6). The gate is now
    `written >= self._read_at + _PART_CHUNK_BYTES`: one extra `statvfs` per REQUEST
    (104 syscalls against 103 for a 100 MiB part, against 204 before seam L1's fix), and
    the property the docstring claims actually holds."""
    reads: list[Path] = []
    real_free = uploads._disk_free

    def counting(path):  # noqa: ANN001, ANN202
        reads.append(path)
        return real_free(path)

    monkeypatch.setattr(uploads, "_disk_free", counting)

    upload_id = _open_session(client, auth)
    reads.clear()
    assert _post(client, auth, upload_id, "small.png", b"s" * 4096).status_code == 200
    assert len(reads) == 1, (
        f"a single-chunk part took {len(reads)} free-space readings; the budget's own "
        "reading already answered the first check"
    )

    reads.clear()
    body = b"m" * (3 * uploads._PART_CHUNK_BYTES)
    assert _post(client, auth, upload_id, "multi.png", body).status_code == 200
    assert len(reads) == 4, (
        f"a 3-chunk part took {len(reads)} readings; the loop must re-read once per "
        "chunk after the pre-loop check, or the floor stops bounding anything"
    )


def test_the_measurable_probe_is_resolved_ONCE_per_budget(
    client, auth, monkeypatch
) -> None:
    """The other half of the same PERF finding. `_measurable`'s `Path.exists()` used to
    sit inside `_disk_free`, so it ran once per streaming chunk on the event loop — 61-65%
    of the added per-chunk cost, and 6,516 us of the 10,062 us a reading costs on the dev
    stack's Windows bind mount, for a probe that returns True on the first try every
    time. It is resolved once, into the budget."""
    probes: list[Path] = []
    real_measurable = uploads._measurable

    def counting(path):  # noqa: ANN001, ANN202
        probes.append(path)
        return real_measurable(path)

    monkeypatch.setattr(uploads, "_measurable", counting)
    upload_id = _open_session(client, auth)
    probes.clear()
    body = b"m" * (3 * uploads._PART_CHUNK_BYTES)
    assert _post(client, auth, upload_id, "multi.png", body).status_code == 200
    assert len(probes) == 1, (
        f"a 3-chunk part resolved the disk-usage probe {len(probes)} times; one budget "
        "is one probe"
    )


# --- round 2: the error-recovery paths the round-1 fixes added ----------------


class _ParkingPart:
    """An `UploadFile` stand-in whose `read()` YIELDS TO THE EVENT LOOP before every
    chunk — a network stall, which is what an upload actually spends its life in. The
    duck type `_store_part` needs is one method."""

    def __init__(self, payload: bytes) -> None:
        self._chunks = [payload, b""]

    async def read(self, size: int = -1) -> bytes:
        await asyncio.sleep(0)
        return self._chunks.pop(0)


def test_PARKED_sibling_parts_do_not_refuse_each_other(client, auth, monkeypatch) -> None:
    """**The cross-tenant refusal, executed.** `_LiveWriters` was entered by
    `_store_part` and `_append_part_chunk`, whose `with` wrapped
    `while chunk := await part.read(...)` — so the count was held across every network
    stall and measured PARKED COROUTINES, which cannot write a byte.

    The consequence, from the round-2 review: 4.5 MiB free, six 1 KiB parts each of
    which alone is admissible, and all six refuse — 6 KiB of demand against 4.5 MiB,
    because the sixth arrival retroactively widens the floor for the five already
    running. Nothing bounds the arrival count (no `--limit-concurrency` anywhere), so
    one account trickling bytes down N sockets drove the process-global floor past free
    space and every OTHER user was told THEIR dataset was too large.

    Six concurrent `_store_part` coroutines, parking between chunks exactly as a real
    one does. The floor they share is one chunk, so all six complete. Restoring
    `with _writers` around either streaming loop fails this."""
    session = _session_dir(_open_session(client, auth))
    monkeypatch.setattr(uploads, "_disk_free", lambda path: 4_718_592)  # 4.5 MiB

    async def drive() -> list[object]:
        budgets = [uploads._bundle_budget(session) for _ in range(6)]
        return await asyncio.gather(
            *(
                uploads._store_part(
                    _ParkingPart(b"k" * 1024),
                    session / "images" / f"sibling{i}.png",
                    budget,
                    session,
                )
                for i, budget in enumerate(budgets)
            ),
            return_exceptions=True,
        )

    results = asyncio.run(drive())
    refused = [r for r in results if isinstance(r, BaseException)]
    assert not refused, (
        f"{len(refused)} of 6 concurrent 1 KiB parts were refused against 4.5 MiB "
        f"free: {refused}"
    )
    assert uploads._writers.live == 0, "no path may leak a writer"


def test_only_THREAD_writers_are_counted_towards_the_floor(
    client, auth, monkeypatch
) -> None:
    """The scope of `_LiveWriters`, pinned on the live path from both sides: a
    streaming part on the event loop registers NOTHING, and a ZIP extraction — which
    runs under `run_in_threadpool` and therefore CAN interleave a write between another
    writer's reading and its write — registers itself.

    Deleting the `with _writers` from `_extract_and_merge_zip` fails the second half,
    which is the round-1 fix this must not undo."""
    upload_id = _open_session(client, auth)
    during_part: list[int] = []
    real_free = uploads._disk_free

    def counting_free(path):  # noqa: ANN001, ANN202
        during_part.append(uploads._writers.live)
        return real_free(path)

    monkeypatch.setattr(uploads, "_disk_free", counting_free)
    body = b"m" * (3 * uploads._PART_CHUNK_BYTES)
    assert _post(client, auth, upload_id, "streamed.png", body).status_code == 200
    assert during_part and set(during_part) == {0}, (
        f"a streaming part on the event loop registered a writer: {during_part}"
    )

    during_extraction: list[int] = []
    real_extract = uploads._extract_entry

    def recording(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        during_extraction.append(uploads._writers.live)
        return real_extract(*args, **kwargs)

    monkeypatch.setattr(uploads, "_extract_entry", recording)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("inner.png", b"i" * 32)
    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("archive.zip", buf.getvalue())},
    )
    assert r.status_code == 200, r.text
    assert during_extraction == [1], (
        f"the threadpool extraction did not register a writer: {during_extraction}"
    )


def test_an_ENOSPC_on_the_file_CREATE_is_a_413_not_a_500(
    client, auth, monkeypatch
) -> None:
    """**Where a full device actually fails is the `open`, and the check that was meant
    to refuse it sat one line below.** On a real 8 MiB tmpfs with `_disk_free` stubbed
    high, seven 1 MiB parts returned 200 and the eighth raised
    `OSError: [Errno 28] No space left on device` out of `target.open("wb")` — an
    unhandled 500 on the exact residual case two docstrings added in round 1 claimed was
    "a capacity 413, never an ENOSPC 500" (round-2 review, finding 5).

    Both halves are asserted, and they are DIFFERENT properties. An `OSError` that
    escapes anyway is the app-level handler's 413 — driven by making the create raise,
    since a unit test cannot fill a device deterministically. And on a device the module
    can already SEE is full, the create must not happen at all, which is the ordering
    fix: `budget.check` above `target.open("wb")` / `os.open`, not below it. Moving
    either check back under its create fails the second half here.

    The real-device half is `test_the_bound_holds_on_a_REAL_small_filesystem`."""
    upload_id = _open_session(client, auth)
    real_open = Path.open
    real_os_open = os.open
    real_free = uploads._disk_free

    def enospc(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        if "images" in str(self) and args and "w" in str(args[0]):
            raise OSError(28, "No space left on device")
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", enospc)
    r = _post(client, auth, upload_id, "plain.png", b"p" * 64)
    assert r.status_code == 413, r.text
    assert "contact an administrator" in r.json()["detail"]

    # The ORDERING half: with the device visibly at 0, nothing may be created.
    created: list[str] = []

    def recording(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        if args and "w" in str(args[0]):
            created.append(str(self))
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", recording)
    monkeypatch.setattr(uploads, "_disk_free", lambda path: 0)
    assert _post(client, auth, upload_id, "ordered.png", b"p" * 64).status_code == 413
    assert not any("images" in p for p in created), (
        f"the part file was created before the check that refused it: {created}"
    )

    # ...and the ZIP loop's entry target, which is the third create with the same hole.
    # The device is read once to admit the archive itself and is empty by the time the
    # extraction budget is taken, so the entry check is the only thing left to refuse.
    created.clear()
    reads = [0]

    def fills_after_staging(path) -> int:  # noqa: ANN001
        reads[0] += 1
        return 64 * 1024 * 1024 if reads[0] == 1 else 0

    monkeypatch.setattr(uploads, "_disk_free", fills_after_staging)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("entry.png", b"e" * 32)
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("corpus.zip", buf.getvalue())},
    ).status_code == 413
    assert not any(p.endswith("entry.png") for p in created), (
        f"a ZIP entry target was created before the check that refused it: {created}"
    )
    monkeypatch.setattr(Path, "open", real_open)

    # ...and the chunked loop's `os.open`, which is a different syscall on a different
    # line and had the same hole. Driven past offset 0, where the declared-size refusal
    # would otherwise fire first and say nothing about the loop.
    monkeypatch.setattr(uploads, "_disk_free", real_free)
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("chunked.png", b"c" * 64)},
        data={"chunk_offset": "0", "part_size": "128"},
    ).status_code == 200
    opened: list[str] = []

    def recording_os_open(path, flags, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        opened.append(str(path))
        return real_os_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(uploads.os, "open", recording_os_open)
    monkeypatch.setattr(uploads, "_disk_free", lambda path: 0)
    chunked = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("chunked.png", b"c" * 64)},
        data={"chunk_offset": "64", "part_size": "128"},
    )
    assert chunked.status_code == 413, chunked.text
    assert not any(".parts-tmp" in p for p in opened), (
        f"the staging file was opened before the check that refused it: {opened}"
    )


def test_an_ENOSPC_in_the_ZIP_MERGE_is_a_413_not_a_500(
    client, auth, monkeypatch
) -> None:
    """The merge loop sat OUTSIDE the `except OSError` the round-1 fix added — the
    `try` ended two lines above it — so an `ENOSPC` from `os.replace` into `images/` was
    an unhandled 500 on a device the floor had just been overshot on. Adding a directory
    entry genuinely can `ENOSPC` on ext4 (htree block allocation), and `iterdir()` can
    raise too (round-2 review, finding 4).

    **What a partial merge leaves behind is NOT repaired, and that is the deferred
    half**: some entries are already renamed into `images/` while neither the tally nor
    the manifest is updated, so both caches are behind the bundle and nothing says so
    (`docs/spikes/spike_upload_session_recovery.md`). The finalize reconciliation recount
    repairs the tally before ingest; the manifest has no such reconciliation."""
    upload_id = _open_session(client, auth)
    assert _post(client, auth, upload_id, "seed.png", b"s" * 16).status_code == 200

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("a.png", b"a" * 32)
        zf.writestr("b.png", b"b" * 32)
    real_replace = os.replace

    def enospc(src, dst, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if "/images/" in str(dst):
            raise OSError(28, "No space left on device")
        return real_replace(src, dst, **kwargs)

    monkeypatch.setattr(uploads.os, "replace", enospc)
    r = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("archive.zip", buf.getvalue())},
    )
    assert r.status_code == 413, r.text
    assert "contact an administrator" in r.json()["detail"]


def test_a_write_failure_that_is_NOT_capacity_stays_a_500(
    client, auth, monkeypatch
) -> None:
    """**The other direction, and the reason the decision moved to one place.** The
    round-1 `except OSError` spanned `zipfile.ZipFile(archive_path)` and every
    `target.open("wb")` while its comment said "the device filled under the write", so
    an operator who mounts `/data` read-only, or whose DATA_ROOT uid changed, was told
    the dataset was too large and sent to free space on an empty filesystem — and a
    missing staged archive, which means the staging invariant broke, became a 413 nobody
    investigates (round-2 review, finding 9).

    EACCES and ENOENT are not capacity. They keep their 500 and their traceback."""
    upload_id = _open_session(client, auth)
    real_extract = uploads._extract_entry

    def eacces(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(uploads, "_extract_entry", eacces)
    with pytest.raises(PermissionError):
        client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("corpus.zip", _zip_bomb(1024))},
        )

    def enoent(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise FileNotFoundError(2, "No such file or directory")

    monkeypatch.setattr(uploads, "_extract_entry", enoent)
    with pytest.raises(FileNotFoundError):
        client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("corpus.zip", _zip_bomb(1024))},
        )

    # ...and the control: the same route, the same archive, a real extractor -> 200.
    monkeypatch.setattr(uploads, "_extract_entry", real_extract)
    ok = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("corpus.zip", _zip_bomb(1024))},
    )
    assert ok.status_code == 200, ok.text


def test_an_ENOSPC_APPENDING_a_CHUNK_is_a_413_not_a_500(
    client, auth, monkeypatch
) -> None:
    """The third streaming loop. `_append_part_chunk`'s `os.open` is the create on the
    chunked path — a different syscall on a different line from `_store_part`'s
    `target.open("wb")` — and its docstring's promise is that `O_CREAT` on a device with
    no room for a directory entry is "a refusal rather than an `ENOSPC` 500".

    It needs its own spec because that promise used to be kept by an app-wide
    `add_exception_handler(OSError, ...)` which this seam removed: the conversion is now
    written at each streaming loop (`_streaming_capacity_refusal`), so each loop is a
    site that can be forgotten. The whole-part and ZIP loops are pinned by
    `test_an_ENOSPC_on_the_file_CREATE_is_a_413_not_a_500` and
    `test_an_ENOSPC_during_extraction_is_a_413_not_a_500`; this is the one they do not
    reach."""
    upload_id = _open_session(client, auth)
    real_os_open = os.open

    def enospc(path, flags, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        if ".parts-tmp" in str(path):
            raise OSError(28, "No space left on device")
        return real_os_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(uploads.os, "open", enospc)
    refused = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("chunked.png", b"c" * 64)},
        data={"chunk_offset": "0", "part_size": "128"},
    )
    assert refused.status_code == 413, refused.text
    assert "contact an administrator" in refused.json()["detail"]

    # ...and the control: the same chunk, a real `os.open` -> 200.
    monkeypatch.setattr(uploads.os, "open", real_os_open)
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("chunked.png", b"c" * 64)},
        data={"chunk_offset": "0", "part_size": "128"},
    ).status_code == 200


def test_ANOTHER_ROUTERS_OSError_never_becomes_this_routers_capacity_413(
    client, monkeypatch, caplog
) -> None:
    """**The narrowing, from the outside.** The ENOSPC -> 413 conversion was registered
    app-wide (`app.add_exception_handler(OSError, ...)`), so every router in the process
    inherited this one's vocabulary. Measured on that registration (review of PR #304,
    finding 9): `GET /api/datasets` — a READ, in another router, for a request with no
    body — answered

        413 {"detail": "This dataset is too large to accommodate at this time ..."}
        WARNING upload cap reached: cap=disk capacity (ENOSPC ...)
          observed=GET /api/datasets could not be written ...
          -- ... or lower UPLOAD_DISK_RESERVE_BYTES

    naming an env var with no effect on that route, for a request that wrote nothing.
    A concrete non-hypothetical inheritor: Starlette spools any multipart part over 1 MiB
    to `tempfile.gettempdir()`, which in the shipped container is the overlay and not
    `/data`, so a full `/tmp` pointed the operator at the wrong device.

    The conversion now lives at the three streaming write loops
    (`_streaming_capacity_refusal`) and nothing else can inherit it. Restoring the
    app-wide registration turns the `raises` below into a 413 and this spec red."""
    from api.routers import datasets as datasets_router

    def enospc(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(datasets_router, "_scan_ready_datasets", enospc)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        with pytest.raises(OSError) as raised:
            client.get("/api/datasets")
    assert raised.value.errno == errno.ENOSPC, raised.value
    assert _warnings(caplog) == [], (
        f"a read in another router was logged as an upload cap breach: {_warnings(caplog)}"
    )


def test_a_failed_write_refusal_INVENTS_no_free_space_reading(
    client, auth, monkeypatch, caplog
) -> None:
    """`_sidecar_write_failure` passed `free=0` — a number nobody read — and measured
    the floor AFTER its own recovery had already shrunk it: 1,048,632 reported against
    11,937,288 real on a 49,048-entry manifest, understated by 91%, and "0 bytes free"
    printed against a device with 972 GB (round-2 review, finding 10).
    `_capacity_refusal`'s own docstring calls that the banned pattern.

    Nothing decided this refusal — the filesystem reported it — so the line names the
    errno it actually holds and claims no reading at all.

    Driven on the STREAMING create, which is where the conversion now lives: this used to
    inject at the `.files.json` `os.replace` and reach `_write_failure_refusal` through
    the app-wide `OSError` handler, and a sidecar write is no longer converted at all
    (`_streaming_capacity_refusal`)."""
    upload_id = _open_session(client, auth)
    assert _post(client, auth, upload_id, "first.png", b"1" * 64).status_code == 200
    real_open = Path.open

    def enospc(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
        if "images" in str(self) and args and "w" in str(args[0]):
            raise OSError(28, "No space left on device")
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", enospc)
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        assert _post(client, auth, upload_id, "second.png", b"2" * 64).status_code == 413
    lines = _warnings(caplog)
    assert len(lines) == 1, lines
    assert "ENOSPC" in lines[0], lines[0]
    assert "bytes free" not in lines[0], (
        f"the line states a free-space reading nothing took: {lines[0]}"
    )


def test_an_ENOSPC_writing_the_part_size_record_RAISES_pending_the_spike(
    client, auth, monkeypatch
) -> None:
    """**A PIN OF THE ACCEPTED STATUS QUO, and it is a deliberate reversal.** This spec
    asserted a 413 one commit ago, through the app-wide `OSError` handler. That handler
    is gone — it gave `GET /api/datasets` this router's "too large to accommodate"
    vocabulary and broke the errno on four `FileResponse` routes (review of PR #304,
    finding 9) — and the replacement is scoped to the three STREAMING write loops
    (`_streaming_capacity_refusal`). `.parts-meta/` is a sidecar, not one of them, so an
    ENOSPC here raises: a 500 with its traceback.

    Kept rather than deleted because the path is still reachable and still costs a user
    their request; what changes is only which failure they see. If the recovery spike
    (`docs/spikes/spike_upload_session_recovery.md`) decides sidecar writes deserve a
    capacity vocabulary of their own, this is the spec that says so."""
    upload_id = _open_session(client, auth)
    real_replace = os.replace

    def enospc(src, dst, **kwargs):  # noqa: ANN001, ANN003, ANN202
        if ".parts-meta" in str(dst):
            raise OSError(28, "No space left on device")
        return real_replace(src, dst, **kwargs)

    monkeypatch.setattr(uploads.os, "replace", enospc)
    with pytest.raises(OSError) as raised:
        client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("chunked.png", b"c" * 64)},
            data={"chunk_offset": "0", "part_size": "128"},
        )
    assert raised.value.errno == errno.ENOSPC, raised.value


def test_a_part_in_flight_across_the_FIRST_DEPLOY_is_ADOPTED_not_a_409(
    client, auth
) -> None:
    """**A healthy in-flight part must not be refused for a record the SERVER never
    wrote**, and this fires deterministically on the first deploy of the seam that
    introduced `.parts-meta/`: every chunked part in flight across that restart has a
    valid staged prefix and no declaration. The client's next chunk got
    *"Part 'p.png' was declared as no declared size at offset 0, not 409600; a part's
    part_size may not change between chunks"* — blaming the caller and naming the wrong
    remedy (round-2 review, finding 8).

    **The setup is the whole DIRECTORY, and it was a single file.** A build that predates
    `.parts-meta/` leaves no store at all, so unlinking one record simulated a different
    event — a record that went missing from a session that has a store — which the
    server now refuses, because adopting the figure the next chunk happened to send
    committed a truncated part as complete (round-3 review, finding 6;
    `test_a_declaration_that_went_MISSING_is_a_409_not_an_adoption`). Both events used to
    take the same branch, which is why one spec appeared to cover both. Removing the
    directory is what this docstring always described.

    A part with no store is adopted; a record that EXISTS and DIFFERS is still the 409
    that closed the advisory-gate hole, and that half is asserted here too so the
    adoption cannot be read as a loosening."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    payload = b"z" * 384
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", payload[:128])},
        data={"chunk_offset": "0", "part_size": str(len(payload))},
    ).status_code == 200

    # The pre-`.parts-meta/` world: a prefix on disk and no declaration store anywhere.
    (session / ".parts-meta" / "p.png").unlink()
    (session / ".parts-meta").rmdir()
    adopted = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", payload[128:256])},
        data={"chunk_offset": "128", "part_size": str(len(payload))},
    )
    assert adopted.status_code == 200, adopted.text
    assert (session / ".parts-tmp" / "p.png").stat().st_size == 256
    assert (session / ".parts-meta" / "p.png").read_text() == str(len(payload)), (
        "the adopted declaration must be recorded, or every later chunk re-adopts"
    )

    # A record that exists and disagrees is still refused, and the message names two
    # real figures rather than rendering None as "no declared size".
    conflict = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", payload[256:])},
        data={"chunk_offset": "256", "part_size": "99999"},
    )
    assert conflict.status_code == 409, conflict.text
    assert "no declared size" not in conflict.json()["detail"], conflict.json()
    assert f"declared as {len(payload)} bytes" in conflict.json()["detail"]

    # ...and the part still completes, byte-identical, over the adopted declaration.
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", payload[256:])},
        data={"chunk_offset": "256", "part_size": str(len(payload))},
    ).status_code == 200
    assert (session / "images" / "p.png").read_bytes() == payload


def test_a_declaration_that_went_MISSING_is_a_409_not_an_adoption(
    client, auth, caplog
) -> None:
    """**The corruption half, and the reason adoption needed a mechanism rather than a
    comment.** A record that vanishes from a session that HAS a declaration store is not
    the first-deploy shape above; it is server loss, a crash, or one of the two races the
    adopt branch's comment claimed a client could not reach. Adopting the figure the next
    chunk sends made the offset-0 gates advisory in BOTH directions, and the shrinking
    one commits corruption: executed against the adopt branch, a 128-byte prefix admitted
    at `part_size=384` with its record removed accepted a chunk declaring `129` with a
    200 and committed a **129-byte truncated image** to `images/`, hashed, and wrote it
    into the manifest as complete — unrecoverable, because a re-send of the real 384
    bytes under that basename is then a duplicate 409 (round-3 review, finding 6).

    Both directions are asserted from one prefix, because they are one branch: the
    truncating declaration and the 40 MiB inflating one get the same 409. The warning is
    asserted too — the client can restart the part unaided, but "this server lost a file
    it wrote" is only actionable by the operator, and nothing else in the response says
    it happened."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    payload = b"q" * 384
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", payload[:128])},
        data={"chunk_offset": "0", "part_size": "384"},
    ).status_code == 200
    assert (session / ".parts-meta" / "p.png").is_file()

    (session / ".parts-meta" / "p.png").unlink()  # the store stays; the record goes
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        shrunk = client.post(
            f"/api/uploads/{upload_id}/parts",
            headers=auth,
            files={"part": ("p.png", b"z")},
            data={"chunk_offset": "128", "part_size": "129"},
        )
    assert shrunk.status_code == 409, shrunk.text
    assert "restart it at offset 0" in shrunk.json()["detail"]
    assert not (session / "images" / "p.png").exists(), (
        "a truncated part was committed to the bundle over an adopted declaration"
    )
    listed = client.get(f"/api/uploads/{upload_id}/files", headers=auth).json()
    assert listed["total"] == 0, listed
    lost = [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING and "lost the part_size record" in r.getMessage()
    ]
    assert len(lost) == 1, caplog.text
    assert "128 bytes staged, 129 declared" in lost[0], lost[0]

    # The inflating direction, the same branch: a later chunk cannot buy a budget the
    # offset-0 gates never saw either.
    inflated = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", b"z" * 64)},
        data={"chunk_offset": "128", "part_size": str(40 * 1024 * 1024)},
    )
    assert inflated.status_code == 409, inflated.text
    assert not (session / ".parts-meta" / "p.png").exists(), (
        "a refused chunk must not leave the declaration it was refused for"
    )

    # And the prefix is intact, so the restart the 409 asks for is the only cost: the
    # SAME size the part was admitted against still continues it.
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("p.png", payload[:128])},
        data={"chunk_offset": "0", "part_size": "384"},
    ).status_code == 200


def test_the_budget_refusal_reports_the_reading_its_REMAINING_came_from(
    client, auth, monkeypatch, caplog
) -> None:
    """`refusal`'s own docstring says it reports the reading that ADMITTED the request,
    "because that is the one the `remaining` it just breached was derived from" — but
    `check` re-read free space into the same attribute while `floor` stayed at
    construction time. Admitted at 4,000,000 free, a concurrent rmtree of
    `.extract-tmp/` frees the device, and the operator's line read
    `observed=9000000000 bytes free` against a budget computed from 4,000,000
    (round-2 review, finding 11).

    Two things: the line reports the admitting pair, and `headroom + floor == free`
    stays an identity — which is what `_capacity_refusal`'s docstring promises a caller
    can recover."""
    session = _session_dir(_open_session(client, auth))
    readings = iter([4_000_000] + [9_000_000_000] * 8)
    monkeypatch.setattr(uploads, "_disk_free", lambda path: next(readings))

    budget = uploads._bundle_budget(session)
    assert budget.free == 4_000_000
    assert budget.headroom + budget.floor == budget.free
    remaining = budget.remaining
    assert remaining is not None

    budget.check(uploads._PART_CHUNK_BYTES)  # forces the live re-read -> 9 GB free
    assert budget.headroom + budget.floor == budget.free, (
        "the identity broke the moment `check` re-read into the admitting reading"
    )
    with caplog.at_level(logging.WARNING, logger="api.routers.uploads"):
        with pytest.raises(Exception) as refused:
            budget.check(remaining + 1)
    assert getattr(refused.value, "status_code", None) == 413, refused.value
    line = _warnings(caplog)[-1]
    assert "4000000 bytes free" in line, line
    assert "9000000000" not in line, line


def test_every_budget_site_reserves_the_manifest_ROW_it_will_add(
    client, auth, monkeypatch
) -> None:
    """`_disk_floor`'s docstring said `new_entries` is "1 for a plain part, the planned
    entry count for an archive" — and `inspect.getsource(uploads).count("new_entries=")`
    was **1**. Only the extraction passed it; the plain and chunked routes took the 0
    default and reserved nothing for the row they were about to add (round-2 review,
    finding 12).

    Every call site is checked here, and the expected figure comes from
    `_manifest_row_bytes`, which is itself pinned against `json.dumps` rather than
    against this module's arithmetic."""
    reserved: list[int] = []
    real_budget = uploads._bundle_budget

    def recording(upload_dir, **kwargs):  # noqa: ANN001, ANN003, ANN202
        reserved.append(kwargs.get("new_entry_bytes", 0))
        return real_budget(upload_dir, **kwargs)

    monkeypatch.setattr(uploads, "_bundle_budget", recording)
    upload_id = _open_session(client, auth)

    assert _post(client, auth, upload_id, "plain.png", b"p" * 64).status_code == 200
    assert reserved == [uploads._manifest_row_bytes("plain.png")], reserved

    reserved.clear()
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("chunk.png", b"c" * 64)},
        data={"chunk_offset": "0", "part_size": "64"},
    ).status_code == 200
    assert reserved == [uploads._manifest_row_bytes("chunk.png", 64)], reserved

    reserved.clear()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("one.png", b"1" * 32)
        zf.writestr("two.png", b"2" * 32)
        zf.writestr("metadata.csv", b"a,b\n")
    assert client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("archive.zip", buf.getvalue())},
    ).status_code == 200
    rows = sum(
        uploads._manifest_row_bytes(n) for n in ("one.png", "two.png", "metadata.csv")
    )
    # Two budgets: the archive's own staging (uncharged, and it adds no manifest row of
    # its own) and the extraction's, which reserves every row the plan found.
    assert reserved == [0, rows], reserved


def test_the_manifest_row_cost_is_COMPUTED_not_averaged(client, auth) -> None:
    """`_MANIFEST_BYTES_PER_ENTRY = 137` was an average sold as a bound.
    `_safe_part_name` caps no length (`grep` for `255`/`NAME_MAX` returns nothing) and
    `json.dump` defaults to `ensure_ascii=True`, so a long or non-ASCII basename costs
    several times it — and nothing pinned the value at all: mutating it to 1 left the
    suite green (round-2 review, finding 12).

    Re-measured here, at a 5-digit size, rather than inherited: 137 for the 38-char
    ASCII calibration, 354 for 255 ASCII (ext4 `NAME_MAX`), 609 for 85 CJK, **855 for
    63 emoji — 6.24x the constant**. The review's table reads 8 bytes higher on every
    row because its size term was wider; the shape of the finding is the same.

    The row cost is now arithmetic on the row, and this compares it to the SERIALISER
    rather than to that arithmetic: `sum(rows) == len(json.dumps(manifest))` exactly,
    for every name shape a client can send."""
    names = [
        "a" * 38 + ".png",              # the 137-byte calibration shape
        "\U0001f600" * 63 + ".png",     # emoji: 4 UTF-8 bytes each, 6 escaped
        "中文" * 42 + ".png",   # CJK
        'quote".png',
        "back\\slash.png",
        "new\nline.png",
    ]
    for size in (0, 65_536, 34_937_083_467):
        manifest = {n: {"size": size, "sha256": "ab" * 32} for n in names}
        assert sum(uploads._manifest_row_bytes(n, size) for n in names) == len(
            json.dumps(manifest)
        ), f"the row cost disagrees with the serialiser at size={size}"

    # The calibration the module's own comments quote, and the three shapes the
    # constant under-reserved (measured at a 5-digit size, in this image).
    assert uploads._manifest_row_bytes("a" * 38, 65_536) == 137
    assert uploads._manifest_row_bytes("a" * 255, 65_536) == 354
    assert uploads._manifest_row_bytes("中" * 85, 65_536) == 609
    assert uploads._manifest_row_bytes("\U0001f600" * 63, 65_536) == 855

    # An unknown size is a BOUND, never an under-estimate, whatever the size turns out
    # to be — that is what a plain part and a ZIP entry both need.
    for size in (0, 1, 2**64 - 1):
        assert uploads._manifest_row_bytes("x.png") >= uploads._manifest_row_bytes(
            "x.png", size
        )


def test_the_caps_route_does_not_read_the_disk_on_the_EVENT_LOOP(
    client, auth, monkeypatch
) -> None:
    """`get_upload_caps` is `async def` and called `_advertised_max_bundle_bytes()`
    inline — and the round-1 fix made it worse by adding `_measurable()`'s ancestor walk
    to it, on the one route where the hoist everywhere else was justified by cost.
    Measured 37.9-74.5 us on overlayfs but 1,816 us of hard event-loop stall on the dev
    bind mount, per caps request, on the single-worker uvicorn that also serves PMTiles
    range reads (round-2 review, finding 13).

    Asserted structurally rather than by a timing threshold: inside a threadpool worker
    there is no running event loop, so `get_running_loop()` raising IS the property."""
    on_loop: list[bool] = []
    real = uploads._advertised_max_bundle_bytes

    def recording() -> int:
        try:
            asyncio.get_running_loop()
            on_loop.append(True)
        except RuntimeError:
            on_loop.append(False)
        return real()

    monkeypatch.setattr(uploads, "_advertised_max_bundle_bytes", recording)
    r = client.get("/api/uploads/caps", headers=auth)
    assert r.status_code == 200, r.text
    assert on_loop == [False], "the caps route read the filesystem on the event loop"


def test_the_suite_cannot_INHERIT_this_modules_env_knobs(client, auth) -> None:
    """Seam L1 deleted the compiled-in 2 GiB bundle default, so an exported
    `MAX_UPLOAD_BUNDLE_BYTES` or `UPLOAD_DISK_RESERVE_BYTES` now changes the answer
    where before it did not — and the round-1 hygiene landed in ONE of two byte-identical
    fixture blocks. Measured: `test_chunked_parts.py` went to 31 failed / 6 passed under
    `-e UPLOAD_DISK_RESERVE_BYTES=1099511627776` while `test_derived_upload_bound.py`
    was unaffected (round-2 review, finding 14).

    The hygiene now lives in ONE autouse fixture in `conftest.py`, which every file in
    this package inherits — including the six other copies of the same fixture block.
    This asserts the effect rather than the mechanism: whatever the ambient environment
    says, a test starts from the module's own defaults."""
    assert uploads._explicit_max_bundle_bytes() is None
    assert uploads._disk_reserve_bytes() == 0
    assert uploads._max_entries() == uploads._DEFAULT_MAX_ENTRIES
    assert uploads._max_part_bytes() == uploads._DEFAULT_MAX_PART_BYTES
