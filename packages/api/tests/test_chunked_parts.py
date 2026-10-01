"""Tier-1 tests for Seam A3: chunked parts and multi-archive bundles.

Chunking is a byte-range APPEND against the existing session — the same
`POST /api/uploads/{id}/parts` with `chunk_offset` + `part_size` — so what these
specs pin is the interaction between that append and everything Seam O2/D-27
already guarantee: the assembled bytes are identical to the source (by HASH, not
by size), the whole-bundle caps still bind while a part is in flight, an abandoned
half-part cannot be smuggled past them or sealed into a bundle, and a mid-part
chunk that does not continue the staged prefix restarts rather than corrupting it.

**What this file does NOT claim.** Nothing here moves the corpus ceiling. The
whole-bundle byte bound is cumulative across the whole session, so a bigger corpus is
still refused at the same total; `test_chunking_does_not_move_the_bundle_ceiling` pins
exactly that, deliberately, so no later reader infers otherwise
(`docs/design/LIMITS_REGISTER.md` §2). Seam L1 replaced WHAT that ceiling is —
`MAX_UPLOAD_BUNDLE_BYTES`'s 2 GiB default became free disk — without changing that
chunking does not move it; the spec now pins the property against both bounds.

Fixtures are local rather than shared: the app-state/DATA_ROOT/redis fakes are the
same shape test_addendum.py uses, and pytest has no cross-module fixture reuse
without a conftest — duplicating four small fixtures beats widening the shared one.
"""

from __future__ import annotations

import hashlib
import io
import os
import asyncio
import time
import zipfile
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from api.routers import uploads

_SIGNUP = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_LOGIN = {"username": "alice", "password": "s3cretpw"}


# --- fakes -------------------------------------------------------------------


class _FakeQueue:
    """Stand-in for rq.Queue: records enqueue dispatches and mints job ids."""

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
    """A no-op redis-py lock (the PR24-8 per-dataset mutation lock, no live broker)."""

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
    """Fresh per-test app-state DB + a writable DATA_ROOT under tmp."""
    db_path = tmp_path / "appstate.db"
    data_root = tmp_path / "data"
    data_root.mkdir()
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    return db_path


@pytest.fixture
def client(app_db) -> Iterator[TestClient]:
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        test_client.app.state.redis = _FakeRedis()
        yield test_client


@pytest.fixture
def auth(client) -> dict[str, str]:
    """Sign up + log in 'alice' via the real auth path; return a bearer header."""
    assert client.post("/api/auth/signup", json=_SIGNUP).status_code == 200
    token = client.post("/api/auth/login", json=_LOGIN).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def fake_queue(client) -> _FakeQueue:
    queue = _FakeQueue()
    client.app.state.queue = queue
    return queue


# --- helpers -----------------------------------------------------------------


def _session_dir(upload_id: str) -> Path:
    # D-30: upload jails live under DATA_ROOT/users/{owner}/uploads/.
    return Path(os.environ["DATA_ROOT"]) / "users" / "alice" / "uploads" / upload_id


def _open_session(client, auth) -> str:
    return client.post("/api/uploads", headers=auth).json()["upload_id"]


def _make_zip(entries: dict[str, bytes]) -> bytes:
    """An in-memory ZIP with the given {archive path: content} entries. STORED, not
    deflated, so a payload built to exceed a byte cap actually does."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()


def _post_whole(client, auth, upload_id: str, name: str, payload: bytes):
    return client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": (name, payload)},
    )


def _post_chunk(
    client, auth, upload_id: str, name: str, body: bytes, offset: int, total: int
):
    """One byte-range append. `body` may be empty only in the malformed-input specs —
    the route reads the part field either way."""
    return client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": (name, body)},
        data={"chunk_offset": str(offset), "part_size": str(total)},
    )


def _send_chunked(client, auth, upload_id: str, name: str, payload: bytes, chunk: int):
    """Send `payload` as `name` in `chunk`-byte appends; return the LAST response
    (stopping early on the first non-200, which is what the caller asserts on)."""
    last = None
    for offset in range(0, len(payload), chunk):
        last = _post_chunk(
            client,
            auth,
            upload_id,
            name,
            payload[offset : offset + chunk],
            offset,
            len(payload),
        )
        if last.status_code != 200:
            return last
    assert last is not None, "an empty payload cannot be chunked"
    return last


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# A deterministic, incompressible-enough body: 500 bytes, well over the 64-byte
# per-part cap the chunking specs set. Derived from a counter so the assertion
# failure message is readable and the bytes are not all identical (a truncation or
# a re-ordered chunk changes the hash).
_BIG = bytes((i * 37 + 11) % 256 for i in range(500))


# --- the wall this seam removes ----------------------------------------------


def test_a_part_over_the_per_part_cap_is_refused_whole_but_accepted_in_chunks(
    client, auth, monkeypatch
) -> None:
    """The seam in one spec: the same bytes, refused as one part, accepted as
    chunks — and the per-part cap is untouched (it still refuses the whole part)."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)

    refused = _post_whole(client, auth, upload_id, "big.png", _BIG)
    assert refused.status_code == 413
    assert "per-part limit" in refused.json()["detail"]
    assert list((_session_dir(upload_id) / "images").iterdir()) == []

    accepted = _send_chunked(client, auth, upload_id, "big.png", _BIG, 64)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["received_parts"] == 1
    assert accepted.json()["bytes_received"] == len(_BIG)


def test_a_LONG_basename_chunks_exactly_as_it_uploads_whole(
    client, auth, monkeypatch
) -> None:
    """**The 413's own remedy was a 500.** A whole part over `MAX_UPLOAD_PART_BYTES` is
    refused with *"the client should send this part in chunks"*, and the chunked route
    then 500'd for any basename of 244 bytes or more: `_write_declared_size` built its
    temp file with `prefix=meta.name`, and `mkstemp` emits `prefix + 8 random + suffix`,
    so the temp path passed NAME_MAX at `len(name) + 12`. Measured boundary through the
    shipped function: 243 -> written, 244 -> `OSError` errno 36 ENAMETOOLONG, and the
    request 500'd. That class
    of file had no working upload route at all, and the shipped client chunks exactly it
    (review of PR #304, finding 7). `_safe_part_name` caps no length and
    `_manifest_row_bytes`' own docstring treats 255-char ASCII, 85-CJK and 63-emoji
    basenames as real inputs.

    The name here is 255 bytes — NAME_MAX, the longest basename the filesystem itself
    will hold — so it pins the property that the record's write costs NOTHING in name
    length, rather than a number between the old boundary and the new one. Asserting the
    whole-part control in the same spec is what makes it a REGRESSION test: the same
    basename has always worked in one request, so a chunked path that cannot take it is
    the chunked path's defect."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    name = "a" * (255 - len(".png")) + ".png"
    assert len(name.encode()) == 255
    upload_id = _open_session(client, auth)

    refused = _post_whole(client, auth, upload_id, name, _BIG)
    assert refused.status_code == 413
    assert "per-part limit" in refused.json()["detail"]

    accepted = _send_chunked(client, auth, upload_id, name, _BIG, 64)
    assert accepted.status_code == 200, accepted.text
    assert (_session_dir(upload_id) / "images" / name).read_bytes() == _BIG

    # The control: the same 255-byte basename, whole, inside the cap. It answered 200
    # before this fix too — which is what makes the chunked 500 a regression and not a
    # filesystem limit.
    control = _post_whole(client, auth, upload_id, name.replace("a", "b", 1), b"c" * 10)
    assert control.status_code == 200, control.text


def test_chunked_part_assembles_bytes_identical_to_the_source(
    client, auth, monkeypatch
) -> None:
    """Identity proven by HASH, not by size — a re-ordered or duplicated chunk of the
    same length would pass a size check and fail this one. Both the bytes on disk and
    the server's own manifest hash are compared to the source digest."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    assert _send_chunked(client, auth, upload_id, "big.png", _BIG, 64).status_code == 200

    stored = (_session_dir(upload_id) / "images" / "big.png").read_bytes()
    assert _sha(stored) == _sha(_BIG)
    assert len(stored) == len(_BIG)

    page = client.get(f"/api/uploads/{upload_id}/files", headers=auth).json()
    assert page["files"] == [
        {
            "name": "big.png",
            "size": len(_BIG),
            "sha256": _sha(_BIG),
            "is_metadata": False,
        }
    ]


def test_a_chunked_zip_over_the_part_cap_extracts_finalizes_and_ingests(
    client, auth, fake_queue, monkeypatch
) -> None:
    """DoD 1: an archive larger than the per-part cap uploads AND ingests. The
    archive is assembled from chunks, extracted by the same D-27 path (entries flat
    in images/, root CSV as metadata), finalized, and accepted as an ingest source."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    payload = _make_zip(
        {
            "shoebox/2019/img_a.png": b"a" * 200,
            "shoebox/2020/img_b.png": b"b" * 200,
            "metadata.csv": b"filename,year\nimg_a.png,2019\nimg_b.png,2020\n",
        }
    )
    assert len(payload) > 64, "the archive must exceed the per-part cap to be the case"
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "box.zip", payload).status_code == 413

    done = _send_chunked(client, auth, upload_id, "box.zip", payload, 64)
    assert done.status_code == 200, done.text
    session = _session_dir(upload_id)
    assert {p.name for p in (session / "images").iterdir()} == {"img_a.png", "img_b.png"}
    assert (session / "images" / "img_a.png").read_bytes() == b"a" * 200
    assert (session / "metadata.csv").exists()
    # The staged archive is gone (an empty staging DIR is fine — it holds no bytes and
    # finalize removes it); nothing assembled is left charged to the bundle budget.
    assert list((session / ".parts-tmp").iterdir()) == []
    assert not (session / ".extract-tmp").exists()

    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 200
    created = client.post(
        "/api/datasets",
        headers=auth,
        json={
            "dataset_id": "ds_chunked",
            "upload_id": upload_id,
            "column_roles": {"filename": {"column": "filename", "label": "File"}},
        },
    )
    assert created.status_code == 200, created.text
    _, kwargs = fake_queue.calls[0]
    assert kwargs["csv_path"] is not None


# --- open question 4: cap accounting for a part in flight ---------------------


def test_an_abandoned_half_part_still_counts_against_the_bundle_cap(
    client, auth, monkeypatch
) -> None:
    """The hole the brief names: bytes parked in staging must not be free. Half a
    part is sent and abandoned; the very next write is refused because the budget
    already accounts for it."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "100")
    upload_id = _open_session(client, auth)

    parked = _post_chunk(client, auth, upload_id, "half.png", b"x" * 60, 0, 90)
    assert parked.status_code == 200
    assert parked.json()["bytes_received"] == 0, "a half-part is not received"
    assert (_session_dir(upload_id) / ".parts-tmp" / "half.png").stat().st_size == 60

    # 60 staged + 41 = 101 > the 100-byte bundle cap.
    refused = _post_whole(client, auth, upload_id, "other.png", b"y" * 41)
    assert refused.status_code == 413
    assert "bundle limit" in refused.json()["detail"]
    # …and 40 more fits exactly, so the refusal was the cap and not a blanket block.
    assert _post_whole(client, auth, upload_id, "other.png", b"y" * 40).status_code == 200


def test_a_half_part_is_neither_counted_nor_sealed_into_the_bundle(
    client, auth
) -> None:
    """A part is 'received' only when whole. The half-part is invisible to the tally
    and to /files, and finalize drops its staging rather than sealing a truncated
    image into an ingest source."""
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "real.png", b"whole").status_code == 200
    assert _post_chunk(client, auth, upload_id, "half.png", b"1234", 0, 99).status_code == 200

    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["received_parts"] == 1
    assert status["bytes_received"] == len(b"whole")
    page = client.get(f"/api/uploads/{upload_id}/files", headers=auth).json()
    assert [f["name"] for f in page["files"]] == ["real.png"]

    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 200
    session = _session_dir(upload_id)
    assert not (session / ".parts-tmp").exists()
    assert {p.name for p in (session / "images").iterdir()} == {"real.png"}
    sealed = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert (sealed["received_parts"], sealed["bytes_received"]) == (1, len(b"whole"))


def test_a_chunk_that_breaches_the_bundle_cap_is_413_and_leaves_no_staged_bytes(
    client, auth, monkeypatch
) -> None:
    """The budget is recomputed PER CHUNK, so a part that was affordable when it
    started can still be refused mid-stream once other parts have landed — and the
    refusal is enforced as the bytes arrive, then truncated back to the chunk's own
    offset so the refused bytes stop counting immediately.

    `_PART_CHUNK_BYTES` is shrunk to 4 so the breach lands PART WAY THROUGH the chunk,
    with bytes already written. At the shipped 1 MiB streaming size a 30-byte chunk is
    one read and the 413 fires before any write, which leaves the staged file at its
    old size for free — so the truncate assertion below would have held whether or not
    the truncate existed. It has to be able to fail to be worth writing."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "80")
    monkeypatch.setattr(uploads, "_PART_CHUNK_BYTES", 4)
    upload_id = _open_session(client, auth)

    # 40 staged of a declared 70 — affordable on its own (70 <= 80).
    assert _post_chunk(client, auth, upload_id, "big.png", b"a" * 40, 0, 70).status_code == 200
    # A whole part lands in between: 35 committed + 40 staged = 75 of the 80.
    assert _post_whole(client, auth, upload_id, "other.png", b"o" * 35).status_code == 200

    breach = _post_chunk(client, auth, upload_id, "big.png", b"b" * 30, 40, 70)
    assert breach.status_code == 413
    assert "bundle limit" in breach.json()["detail"]
    staged = _session_dir(upload_id) / ".parts-tmp" / "big.png"
    assert staged.stat().st_size == 40, "truncated back to the offset the chunk began at"
    # …and the 5 bytes that DID fit are still accepted, so the refusal was the cap.
    assert _post_chunk(client, auth, upload_id, "big.png", b"b" * 5, 40, 70).status_code == 200


def test_a_part_declaring_more_than_the_bundle_budget_is_refused_up_front(
    client, auth, monkeypatch
) -> None:
    """A declared size may REFUSE but never ADMIT (the D-27 asymmetry). Declaring a
    part bigger than the remaining budget costs one request, not a whole transfer."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "100")
    upload_id = _open_session(client, auth)
    refused = _post_chunk(client, auth, upload_id, "big.png", b"a", 0, 101)
    assert refused.status_code == 413
    assert "bundle limit" in refused.json()["detail"]
    assert not (_session_dir(upload_id) / ".parts-tmp" / "big.png").exists()


def test_under_declaring_the_part_size_does_not_admit_extra_bytes(
    client, auth, monkeypatch
) -> None:
    """The other half of the asymmetry: a client that lies LOW about part_size still
    meets the streaming check, and the over-long part is refused rather than stored."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    lying = _post_chunk(client, auth, upload_id, "big.png", b"a" * 40, 0, 10)
    assert lying.status_code == 400
    assert "more than the declared" in lying.json()["detail"]
    assert not (_session_dir(upload_id) / ".parts-tmp" / "big.png").exists()
    assert list((_session_dir(upload_id) / "images").iterdir()) == []


def test_an_assembled_archive_is_not_billed_twice_against_the_bundle_cap(
    client, auth, monkeypatch
) -> None:
    """A chunk-assembled archive is MOVED out of `.parts-tmp/` before extraction, and
    that move is load-bearing rather than tidying.

    While the archive is staged its compressed bytes are charged to the bundle budget
    (that is what stops an abandoned half-part parking disk). If it were still there
    during extraction, the entries coming out of it would be charged against a budget
    its own compressed copy had already spent — billing one archive twice and
    **falsely refusing a legitimate upload**. This spec is sized so the two figures
    straddle the cap: the entries alone fit, the entries plus the archive do not."""
    cap = 2000
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", str(cap))
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "256")
    payload = _make_zip({"a.png": b"a" * 1200})
    entries_bytes = 1200
    # The preconditions, asserted so the spec cannot quietly go vacuous if _make_zip's
    # framing changes: the archive fits, its entries fit, and the two together do not.
    assert len(payload) <= cap, len(payload)
    assert entries_bytes <= cap
    assert len(payload) + entries_bytes > cap, (len(payload), entries_bytes)

    upload_id = _open_session(client, auth)
    done = _send_chunked(client, auth, upload_id, "arc.zip", payload, 256)
    assert done.status_code == 200, done.text
    session = _session_dir(upload_id)
    assert (session / "images" / "a.png").read_bytes() == b"a" * 1200
    assert done.json()["bytes_received"] == entries_bytes
    assert list((session / ".parts-tmp").iterdir()) == []


def test_the_entry_cap_binds_on_the_chunked_path_exactly_as_on_the_whole_path(
    client, auth, monkeypatch
) -> None:
    """MAX_UPLOAD_ENTRIES counts FILES PLACED IN THE BUNDLE, however they arrived.

    The first draft of this seam checked the byte cap on the chunked path and forgot
    the entry cap entirely, so a loop of 1-byte "chunked" parts added files without
    bound — nothing requires a chunked part to be large. The whole-part refusal is the
    control in the same session: if the two disagree, the chunked path is the bug."""
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "w1.png", b"a").status_code == 200
    assert _post_whole(client, auth, upload_id, "w2.png", b"b").status_code == 200

    control = _post_whole(client, auth, upload_id, "w3.png", b"c")
    assert control.status_code == 413
    assert "entry limit" in control.json()["detail"]

    for i in range(5):
        chunked = _post_chunk(client, auth, upload_id, f"c{i}.png", b"x", 0, 1)
        assert chunked.status_code == control.status_code, (
            f"chunked part {i} was accepted where the identical whole part was refused"
        )
        assert "entry limit" in chunked.json()["detail"]
    # A chunked CSV is a bundle file too, and took the same bypass.
    assert _post_chunk(client, auth, upload_id, "m.csv", b"a,b\n", 0, 4).status_code == 413

    # A doomed MULTI-chunk part costs one request, not a whole transfer: the FIRST
    # chunk is refused, so nothing is ever staged. This is what distinguishes the early
    # refusal from the binding one at completion — without it the prefix would stage
    # happily and only the last chunk would be refused.
    session = _session_dir(upload_id)
    assert _post_chunk(client, auth, upload_id, "multi.png", b"z" * 4, 0, 12).status_code == 413
    assert not (session / ".parts-tmp" / "multi.png").exists(), (
        "the first chunk of an over-cap part must be refused before it is staged"
    )

    assert len(list((session / "images").iterdir())) == 2
    assert not (session / "metadata.csv").exists()
    assert client.get(f"/api/uploads/{upload_id}", headers=auth).json()["received_parts"] == 2


def test_the_entry_cap_is_re_checked_when_the_part_COMPLETES(
    client, auth, monkeypatch
) -> None:
    """The early refusal at offset 0 cannot be the only check. A part that starts
    legally can be overtaken while it is still in flight — a client may open several
    chunked parts at once — so the binding check is at completion, where the count is
    current. Here the part begins with room for it and the room is gone by the time it
    finishes; the bundle must still not exceed the cap."""
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "w1.png", b"a").status_code == 200

    # Starts with count 1 of 2 — legal, and the early check passes.
    assert _post_chunk(client, auth, upload_id, "slow.png", b"x" * 8, 0, 16).status_code == 200
    # Overtaken: another part commits, filling the cap.
    assert _post_whole(client, auth, upload_id, "w2.png", b"b").status_code == 200
    # The final chunk arrives. Refused at completion, not waved through.
    finish = _post_chunk(client, auth, upload_id, "slow.png", b"y" * 8, 8, 16)
    assert finish.status_code == 413
    assert "entry limit" in finish.json()["detail"]

    session = _session_dir(upload_id)
    assert {p.name for p in (session / "images").iterdir()} == {"w1.png", "w2.png"}
    assert not (session / ".parts-tmp" / "slow.png").exists(), "staging released on refusal"


def test_an_idempotent_chunked_resend_is_not_refused_by_a_FULL_entry_cap(
    client, auth, monkeypatch
) -> None:
    """The edge a carelessly-placed entry check breaks: a byte-identical re-send adds
    NO file, so it must still be a 200 no-op when the bundle is exactly at the cap.
    Checking before the duplicate branch would turn every safe blind retry of a
    completed part into a 413 at precisely the moment retries matter most."""
    monkeypatch.setenv("MAX_UPLOAD_ENTRIES", "2")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    upload_id = _open_session(client, auth)
    payload = b"0123456789abcdef"
    assert _send_chunked(client, auth, upload_id, "a.png", payload, 8).status_code == 200
    assert _post_whole(client, auth, upload_id, "b.png", b"b").status_code == 200  # now full

    again = _send_chunked(client, auth, upload_id, "a.png", payload, 8)
    assert again.status_code == 200, again.text
    assert again.json()["already_present"] is True
    assert again.json()["received_parts"] == 2


def test_chunking_does_not_move_the_bundle_ceiling(client, auth, monkeypatch) -> None:
    """Chunking buys nothing against the WHOLE-BUNDLE ceiling, whatever that ceiling
    happens to be: it is cumulative across the session, so the same total is refused
    whether it arrives as one part or as many chunks.

    **Its meaning changed with seam L1, and this is that change written down.** When
    A3 wrote this spec, the ceiling was `MAX_UPLOAD_BUNDLE_BYTES`'s 2 GiB default and
    the spec's job was to deny a claim — that chunking had raised the corpus ceiling,
    which it had not
    ([[T2-the-upload-bundle-cap-contradicts-the-1m-target]], `LIMITS_REGISTER.md` §2).
    Seam L1 removed that default: with no explicit cap the ceiling is now free disk.
    So the spec keeps its subject and loses its second job — what it pins today is the
    CUMULATIVE property, which is what actually makes chunking neutral, and it pins it
    on both of the bounds that can now be in force. The corpus-ceiling claim it existed
    to deny is no longer a claim anyone can make, because there is no constant left to
    make it about.

    The disk half is the seam's own file (`test_derived_upload_bound.py`); what is
    added here is only that CHUNKS and WHOLE PARTS meet the same disk wall, which is
    this spec's question, not that one's."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "10")
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "50")
    upload_id = _open_session(client, auth)
    # 50 bytes fit, in chunks the per-part cap could never have carried whole.
    assert _send_chunked(client, auth, upload_id, "a.png", b"a" * 50, 10).status_code == 200
    # The 51st byte does not, however it is sliced.
    assert _post_whole(client, auth, upload_id, "b.png", b"b").status_code == 413
    assert _post_chunk(client, auth, upload_id, "c.png", b"c", 0, 1).status_code == 413

    # And with no explicit cap, the same is true of the bound that replaced it: the
    # device is filled by chunks exactly as it would be by whole parts, and the next
    # part is refused either way.
    monkeypatch.delenv("MAX_UPLOAD_BUNDLE_BYTES")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", str(512 * 1024))
    disk_id = _open_session(client, auth)
    session = _session_dir(disk_id)
    capacity = uploads._PART_CHUNK_BYTES + 2 * 1024 * 1024
    monkeypatch.setattr(
        uploads,
        "_disk_free",
        lambda path: capacity
        - sum(p.stat().st_size for p in session.rglob("*") if p.is_file()),
    )
    body = b"z" * (512 * 1024)
    accepted = 0
    for i in range(16):
        r = _send_chunked(client, auth, disk_id, f"d{i}.png", body, 256 * 1024)
        if r.status_code != 200:
            # A 413 is the wall this spec is about. Anything else — a 500 from an
            # unhandled ENOSPC, a 409 — would also have ended the loop and satisfied
            # `1 <= accepted <= 4`, so the loop used to pass on a crash.
            assert r.status_code == 413, r.text
            break
        accepted += 1
    assert 1 <= accepted <= 4, f"the device admitted {accepted} parts of 512 KiB"
    # The wall is the DEVICE, so it is the same wall for both shapes of request.
    assert _post_whole(client, auth, disk_id, "whole.png", body).status_code == 413
    assert _send_chunked(client, auth, disk_id, "chunked.png", body, 256 * 1024).status_code == 413


# --- open question 3: what resume means for a half-uploaded part -------------


def test_a_half_uploaded_part_is_invisible_to_the_resume_check(client, auth) -> None:
    """`/check` is name+size and a half-part has neither a final size nor a hash, so
    it is reported `needed` — the client re-sends it from the start. That IS the
    answer: a partial part restarts, and nothing in the resume protocol pretends
    otherwise."""
    upload_id = _open_session(client, auth)
    assert _post_chunk(client, auth, upload_id, "big.png", b"a" * 40, 0, 100).status_code == 200
    res = client.post(
        f"/api/uploads/{upload_id}/check",
        headers=auth,
        json={"files": [{"name": "big.png", "size": 100}]},
    ).json()
    assert res == {"present": [], "needed": ["big.png"], "mismatched": []}


def test_restarting_a_part_at_offset_zero_discards_the_stale_prefix(
    client, auth, monkeypatch
) -> None:
    """A restart is a first-class outcome, not a corruption: offset 0 truncates
    whatever was staged, so the assembled bytes are the SECOND attempt's, proven by
    hash — and the abandoned prefix's budget is released, not double-charged."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "150")
    upload_id = _open_session(client, auth)

    # A first attempt that gets half way, then a full restart of the same name.
    assert _post_chunk(client, auth, upload_id, "big.png", b"X" * 50, 0, 100).status_code == 200
    assert _send_chunked(client, auth, upload_id, "big.png", _BIG[:100], 50).status_code == 200

    stored = (_session_dir(upload_id) / "images" / "big.png").read_bytes()
    assert _sha(stored) == _sha(_BIG[:100])
    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["bytes_received"] == 100, "the abandoned prefix is not charged twice"


def test_a_prefix_unlinked_MID_REQUEST_never_becomes_NUL_padding(
    client, auth, monkeypatch
) -> None:
    """The race that used to zero-fill a part, driven through the real window.

    `_append_part_chunk` once chose its open mode from `target.exists()`. A concurrent
    `chunk_offset=0` restart of the same name — or a completion's cleanup — unlinking
    the staged file between the size read and that probe made the open create a fresh
    empty file, and `truncate(offset)` then wrote `offset` NUL bytes under the chunk.
    Nothing downstream could catch it: the ordering check had already passed on the
    earlier size read, and the sha256 is taken from the assembled file, so the manifest
    would have recorded a confident hash of the corruption.

    The unlink is injected by wrapping `_committed_and_staged`, which really does run
    between the size read and the append. That is the CONCURRENT ACTOR'S EFFECT applied
    at a real point in the window — not a patch of the probe under test, which would
    only prove the probe was called. The property asserted is about BYTES, so it holds
    whatever mechanism replaces the probe."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    staged = _session_dir(upload_id) / ".parts-tmp" / "big.png"

    assert _post_chunk(client, auth, upload_id, "big.png", _BIG[:64], 0, 128).status_code == 200
    assert staged.stat().st_size == 64

    original = uploads._committed_and_staged
    fired = []

    def unlink_then_measure(upload_dir):
        if not fired:
            fired.append(True)
            staged.unlink(missing_ok=True)  # what a concurrent restart does
        return original(upload_dir)

    monkeypatch.setattr(uploads, "_committed_and_staged", unlink_then_measure)
    racy = _post_chunk(client, auth, upload_id, "big.png", _BIG[64:128], 64, 128)
    assert fired, "the injection point never ran — this spec proves nothing"
    monkeypatch.setattr(uploads, "_committed_and_staged", original)

    # Either outcome is acceptable; a silently NUL-padded 200 is not.
    if racy.status_code == 200:
        stored = (_session_dir(upload_id) / "images" / "big.png").read_bytes()
        assert _sha(stored) == _sha(_BIG[:128]), "the assembled part is not the source"
        assert b"\x00" * 64 not in stored
    else:
        assert racy.status_code == 409, racy.text
        assert not (_session_dir(upload_id) / "images" / "big.png").exists()
        # …and the documented way out actually works: restart the part at offset 0.
        assert _send_chunked(client, auth, upload_id, "big.png", _BIG[:128], 64).status_code == 200
        stored = (_session_dir(upload_id) / "images" / "big.png").read_bytes()
        assert _sha(stored) == _sha(_BIG[:128])


def test_a_short_staged_prefix_is_never_extended_with_nul_bytes(
    client, auth, monkeypatch
) -> None:
    """The other half of the same class, and the reason `O_CREAT` alone is not the fix:
    a file that EXISTS but is SHORTER than the offset would still be zero-filled by
    `truncate(offset)`. Here a concurrent restart re-creates the prefix at 4 bytes
    while a chunk for offset 64 is in flight. The length is re-checked on the very fd
    the write goes through, so the request is refused rather than padded."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    staged = _session_dir(upload_id) / ".parts-tmp" / "big.png"
    assert _post_chunk(client, auth, upload_id, "big.png", _BIG[:64], 0, 128).status_code == 200

    original = uploads._committed_and_staged
    fired = []

    def shorten_then_measure(upload_dir):
        if not fired:
            fired.append(True)
            staged.write_bytes(b"zzzz")  # a restart that got 4 bytes in
        return original(upload_dir)

    monkeypatch.setattr(uploads, "_committed_and_staged", shorten_then_measure)
    racy = _post_chunk(client, auth, upload_id, "big.png", _BIG[64:128], 64, 128)
    assert fired, "the injection point never ran — this spec proves nothing"
    monkeypatch.setattr(uploads, "_committed_and_staged", original)

    assert racy.status_code == 409, racy.text
    assert staged.read_bytes() == b"zzzz", "the short prefix is left exactly as found"
    assert not (_session_dir(upload_id) / "images" / "big.png").exists()


def test_restarting_an_abandoned_part_RELEASES_its_charged_prefix(
    client, auth, monkeypatch
) -> None:
    """An abandoned prefix stays charged against the bundle cap — deliberately, since
    that is what stops a client parking free disk — so there has to be a way to give it
    back, and this is it: a chunk at offset 0 for that name discards the stale prefix
    BEFORE the budget is read, so the release happens even when the fresh attempt is
    then itself refused.

    That ordering is the whole property, and it is what keeps a user from wedging their
    own session: Seam O4's per-part retry and the resume path both restart a part at
    offset 0, so the release is automatic in the shipped client. It is not, however,
    DISCOVERABLE — there is no discard route and nothing reports staged bytes, which is
    [[T2-an-abandoned-chunked-prefix-is-charged-with-no]]."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "100")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)

    # Abandon 60 bytes of a part: the budget is now 40, and the next part feels it.
    assert _post_chunk(client, auth, upload_id, "big.png", b"x" * 60, 0, 90).status_code == 200
    assert (session / ".parts-tmp" / "big.png").stat().st_size == 60
    assert _post_whole(client, auth, upload_id, "other.png", b"y" * 41).status_code == 413

    # Restart it with a declaration too large to accept. The attempt is refused…
    refused = _post_chunk(client, auth, upload_id, "big.png", b"z" * 10, 0, 101)
    assert refused.status_code == 413
    # …and the prefix is gone anyway, so the budget is whole again.
    assert not (session / ".parts-tmp" / "big.png").exists()
    # 64 bytes: over the 40 that was refused while the prefix was charged, and inside
    # the per-part cap, so the only thing this can be measuring is the released budget.
    assert _post_whole(client, auth, upload_id, "other.png", b"y" * 64).status_code == 200


def _backdate_tree(root: Path, seconds_ago: float) -> None:
    """Age every mtime in a session tree, children first, so the only fresh mtime
    afterwards is one a later request writes."""
    past = time.time() - seconds_ago
    for p in sorted(root.rglob("*"), key=lambda q: len(q.parts), reverse=True):
        os.utime(p, (past, past))
    os.utime(root, (past, past))


def test_a_CHUNK_that_lands_keeps_the_session_off_the_stale_reaper(
    client, auth
) -> None:
    """**The reaper deleted uploads that were actively progressing.** `_session_mtimes`
    read five paths — the session dir, images/ and the three sidecars — and a chunked
    part touches none of them: its bytes go to `.parts-tmp/{name}`, a sibling, and the
    in-flight branch only READS the tally. So `upload_dir`'s mtime moved once, when
    `.parts-tmp/` was created, and never again.

    Measured on the shipped code before the fix, chunks 0 and 1 of a 3-chunk part
    1.124 s apart: `max(_session_mtimes(...))` advanced 0.000 s, `GET /api/uploads`
    reported `last_activity` 1.128 s stale while a chunk had landed 0.005 s ago, and
    `_sweep_stale_sessions` — which runs on every `POST /api/uploads` and every
    `GET /api/uploads`, i.e. on the wizard's own polling — `rmtree`d the session
    mid-transfer, after which chunk 2 answered 404. There is no `DELETE` route and no
    resume-from-offset, so the assembled prefix is simply gone (review of PR #304,
    finding 2).

    Deterministic instead of timed: age the WHOLE session tree past the TTL, then send
    one chunk. The staged prefix is then the only fresh mtime in the session — the
    append writes no sidecar and creates no directory entry, so nothing else can be what
    keeps it — and both surfaces have to see it."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    ttl = 7 * 24 * 3600
    assert _post_chunk(client, auth, upload_id, "big.png", _BIG[:100], 0, len(_BIG)).status_code == 200

    _backdate_tree(session, seconds_ago=8 * 24 * 3600)
    assert max(uploads._session_mtimes(session)) < time.time() - ttl, (
        "the session must start OUT of the freshness window, or this proves nothing"
    )
    assert uploads._sweep_stale_sessions(session.parent, ttl) == [session], (
        "an aged session with nothing in flight must still be reapable"
    )
    # …reaped, so rebuild it and send a chunk into the aged session instead.
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    assert _post_chunk(client, auth, upload_id, "big.png", _BIG[:100], 0, len(_BIG)).status_code == 200
    _backdate_tree(session, seconds_ago=8 * 24 * 3600)

    assert _post_chunk(client, auth, upload_id, "big.png", _BIG[100:200], 100, len(_BIG)).status_code == 200
    assert uploads._sweep_stale_sessions(session.parent, ttl) == [], (
        "a session receiving chunks right now was reaped as idle"
    )
    assert session.is_dir()

    listed = [s for s in client.get("/api/uploads", headers=auth).json() if s["upload_id"] == upload_id]
    assert len(listed) == 1, listed
    assert time.time() - listed[0]["last_activity"] < 60, (
        f"last_activity is {time.time() - listed[0]['last_activity']:.1f}s stale for a "
        "session whose chunk just landed"
    )

    # The transfer completes, which is the outcome the reaper used to take away.
    last = _post_chunk(client, auth, upload_id, "big.png", _BIG[200:], 200, len(_BIG))
    assert last.status_code == 200, last.text
    assert (session / "images" / "big.png").read_bytes() == _BIG




class _MtimeWatchingPart:
    """A minimal `UploadFile` stand-in that records the session directory's mtime at
    every `read()` — i.e. BETWEEN the streaming loop's iterations, which is the only
    place the defect is observable."""

    def __init__(self, chunks, session: Path) -> None:
        self._chunks = list(chunks)
        self._session = session
        self.seen: list[float] = []

    async def read(self, _size: int = -1) -> bytes:
        self.seen.append(self._session.stat().st_mtime)
        return self._chunks.pop(0) if self._chunks else b""


def test_a_WHOLE_part_still_streaming_keeps_the_session_off_the_stale_reaper(
    client, auth
) -> None:
    """**The same reaper hole as the spec above, on the path that spec does not cover.**

    `_session_mtimes` walks the files inside `.parts-tmp/` and `.extract-tmp/`, and its
    docstring used to justify leaving `images/` un-walked by claiming a part "arrives
    there by `os.replace`, which moves the directory's own mtime". True of a CHUNKED
    part; false of a WHOLE one, which `_store_part` streams straight into
    `images/{name}` (`_plain_part_target`, `target.open("wb")`). So `images/`'s mtime
    moved once, when the part file was created, and nothing advanced while the file
    GREW — the exact half of the rule this design turns on (review of #333, low
    finding 1). On two documented knobs (`MAX_UPLOAD_SESSION_AGE_SECONDS` short,
    `MAX_UPLOAD_PART_BYTES` large) the sweep `rmtree`d the session mid-transfer, the
    write continued into an unlinked inode, and `_record_committed_part` then 500ed
    opening `.tally.lock` under a directory that no longer existed.

    **It has to be observed BETWEEN chunks, and a first draft of this spec got that
    wrong.** Asserting on the session mtime after the route returns passes either way:
    `_record_committed_part` writes both sidecars with `tempfile.mkstemp(dir=upload_dir)`
    plus `os.replace`, which creates and removes DIRECT children and so moves
    `upload_dir`'s mtime regardless. That draft survived deleting the touch. So this
    drives `_store_part` directly and samples the mtime inside `read()`, which the
    loop calls once per iteration — sample 0 is before any chunk is written, sample 1
    is after the first."""
    upload_id = _open_session(client, auth)
    session = _session_dir(upload_id)
    (session / "images").mkdir(exist_ok=True)
    target = uploads._plain_part_path(session, "slow.png", ".png")

    _backdate_tree(session, seconds_ago=8 * 24 * 3600)
    aged = session.stat().st_mtime
    assert aged < time.time() - 7 * 24 * 3600, (
        "the session must start OUT of the freshness window, or this proves nothing"
    )

    part = _MtimeWatchingPart([b"a" * 64, b"b" * 64, b"c" * 64], session)
    budget = uploads._bundle_budget(session)
    written, _sha = asyncio.run(uploads._store_part(part, target, budget, session))
    assert written == 192, written
    assert len(part.seen) >= 3, part.seen

    assert part.seen[0] == aged, (
        "the first read happens before any chunk is written, so the session should "
        "still look aged there; if it does not, this spec is measuring setup noise"
    )
    assert part.seen[1] > aged, (
        "the session directory's own mtime did not advance BETWEEN chunks while a whole "
        "part streamed into images/ — the freshness signal froze at the instant the file "
        "was created, which is what let the reaper delete a session actively receiving. "
        f"samples: {part.seen}"
    )
def test_a_chunk_that_does_not_continue_the_staged_prefix_is_409(client, auth) -> None:
    """Ordering is verified, never assumed: a gap (or a replay) is refused with the
    offset the server actually holds, and the staged bytes are left untouched."""
    upload_id = _open_session(client, auth)
    assert _post_chunk(client, auth, upload_id, "big.png", b"a" * 10, 0, 30).status_code == 200
    gap = _post_chunk(client, auth, upload_id, "big.png", b"c" * 10, 20, 30)
    assert gap.status_code == 409
    assert "does not continue" in gap.json()["detail"]
    assert "holds 10 bytes" in gap.json()["detail"]
    assert (_session_dir(upload_id) / ".parts-tmp" / "big.png").stat().st_size == 10


def test_chunk_coordinates_are_all_or_nothing(client, auth) -> None:
    """Half-sent coordinates would otherwise store a chunk as a COMPLETE file under
    the part's name — a silently truncated image."""
    upload_id = _open_session(client, auth)
    only_offset = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("a.png", b"12345")},
        data={"chunk_offset": "0"},
    )
    assert only_offset.status_code == 400
    only_total = client.post(
        f"/api/uploads/{upload_id}/parts",
        headers=auth,
        files={"part": ("a.png", b"12345")},
        data={"part_size": "5"},
    )
    assert only_total.status_code == 400
    assert list((_session_dir(upload_id) / "images").iterdir()) == []


@pytest.mark.parametrize(
    ("offset", "total"), [(-1, 10), (10, 10), (11, 10), (0, 0), (0, -5)]
)
def test_impossible_chunk_coordinates_are_400(client, auth, offset, total) -> None:
    upload_id = _open_session(client, auth)
    r = _post_chunk(client, auth, upload_id, "a.png", b"x", offset, total)
    assert r.status_code == 400, (offset, total, r.text)


# --- chunked parts meet the Seam O2 duplicate rules ---------------------------


def test_a_chunked_resend_of_identical_bytes_is_an_idempotent_no_op(
    client, auth, monkeypatch
) -> None:
    """The Seam O2 blind-retry rule survives chunking: the assembled bytes are
    compared to the stored file, and a byte-identical re-send is a 200 no-op rather
    than a 409 or a second tally entry."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    assert _send_chunked(client, auth, upload_id, "big.png", _BIG, 64).status_code == 200

    again = _send_chunked(client, auth, upload_id, "big.png", _BIG, 64)
    assert again.status_code == 200
    assert again.json()["already_present"] is True
    assert again.json()["received_parts"] == 1
    assert not (_session_dir(upload_id) / ".parts-tmp" / "big.png").exists()


def test_an_idempotent_chunked_resend_is_not_refused_by_a_FULL_BYTE_cap(
    client, auth, monkeypatch
) -> None:
    """The byte cap's half of the re-send exemption, and the reason the entry-cap pin
    next door could not see it: that one runs a 500-byte body against the 2 GiB
    default, so the bundle is never remotely full and the byte branch never fires.
    **A pin's scale is part of its correctness** — this is the second time in this seam
    a pin was too small to observe its own property.

    Here the bundle is exactly full, so a blind retry has zero free budget. The
    whole-part route returns 200 `already_present` in that situation; the chunked route
    must too, or Seam O4's per-part retry turns a survivable blip into a hard failure
    at precisely the moment retries matter."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "16")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    upload_id = _open_session(client, auth)
    payload = b"0123456789abcdef"  # 16 bytes: the entire bundle budget
    assert _send_chunked(client, auth, upload_id, "a.png", payload, 8).status_code == 200
    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["bytes_received"] == 16, "the bundle is exactly full"

    again = _send_chunked(client, auth, upload_id, "a.png", payload, 8)
    assert again.status_code == 200, again.text
    assert again.json()["already_present"] is True
    assert again.json()["bytes_received"] == 16, "a re-send adds no bundle bytes"
    assert not (_session_dir(upload_id) / ".parts-tmp" / "a.png").exists()


def test_the_resend_byte_allowance_is_bounded_by_the_stored_twin(
    client, auth, monkeypatch
) -> None:
    """The exemption is an allowance, not a waiver. A chunked part's bytes really are
    written to `.parts-tmp/` while in flight (the whole-part route drains a duplicate to
    nowhere and writes nothing), so an unconditional exemption would let a client park a
    bundle's worth of extra disk under any name that already exists. The allowance is
    exactly what the bundle already holds under that name — declaring more is not a
    re-send and meets the ordinary budget."""
    monkeypatch.setenv("MAX_UPLOAD_BUNDLE_BYTES", "16")
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "8")
    upload_id = _open_session(client, auth)
    assert _send_chunked(client, auth, upload_id, "a.png", b"0123456789abcdef", 8).status_code == 200

    # 17 > the 16-byte twin and > the 0 bytes of free budget: refused up front.
    over = _post_chunk(client, auth, upload_id, "a.png", b"x" * 8, 0, 17)
    assert over.status_code == 413
    assert "bundle limit" in over.json()["detail"]
    assert not (_session_dir(upload_id) / ".parts-tmp" / "a.png").exists()
    # …and the stored file is untouched by the attempt.
    assert (_session_dir(upload_id) / "images" / "a.png").read_bytes() == b"0123456789abcdef"


def test_a_chunked_part_with_a_taken_name_and_different_bytes_is_409(
    client, auth, monkeypatch
) -> None:
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "64")
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "big.png", b"original").status_code == 200

    clash = _send_chunked(client, auth, upload_id, "big.png", _BIG, 64)
    assert clash.status_code == 409
    assert (_session_dir(upload_id) / "images" / "big.png").read_bytes() == b"original"
    assert not (_session_dir(upload_id) / ".parts-tmp" / "big.png").exists()


def test_a_chunked_csv_becomes_the_metadata_source(client, auth, monkeypatch) -> None:
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "16")
    upload_id = _open_session(client, auth)
    csv = b"filename,year\nimg_a.png,2019\nimg_b.png,2020\n"
    assert _send_chunked(client, auth, upload_id, "meta.csv", csv, 16).status_code == 200
    assert (_session_dir(upload_id) / "metadata.csv").read_bytes() == csv


def test_a_second_metadata_source_is_refused_on_the_FIRST_chunk(
    client, auth, monkeypatch
) -> None:
    """Fail fast: the classification rules the whole-part path checks before reading a
    body are checked at offset 0, so a doomed part costs one chunk, not a transfer."""
    monkeypatch.setenv("MAX_UPLOAD_PART_BYTES", "16")
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "meta.csv", b"a,b\n1,2\n").status_code == 200
    refused = _post_chunk(client, auth, upload_id, "other.tsv", b"x" * 16, 0, 64)
    assert refused.status_code == 409
    assert not (_session_dir(upload_id) / ".parts-tmp").exists() or not (
        _session_dir(upload_id) / ".parts-tmp" / "other.tsv"
    ).exists()


def test_a_chunked_part_cannot_be_added_after_finalize(client, auth) -> None:
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "a.png", b"img").status_code == 200
    assert client.post(f"/api/uploads/{upload_id}/finalize", headers=auth).status_code == 200
    assert _post_chunk(client, auth, upload_id, "b.png", b"x", 0, 10).status_code == 409


def test_a_chunked_part_name_cannot_escape_the_staging_dir(client, auth) -> None:
    """`_safe_part_name` runs before the chunk branch, so a crafted name is a jailed
    basename in `.parts-tmp/` exactly as it is in `images/`."""
    upload_id = _open_session(client, auth)
    r = _post_chunk(client, auth, upload_id, "../../evil.png", b"x" * 4, 0, 4)
    assert r.status_code == 200
    session = _session_dir(upload_id)
    assert {p.name for p in (session / "images").iterdir()} == {"evil.png"}
    assert not (session.parent / "evil.png").exists()


# --- multi-archive: several archives are one logical bundle -------------------


def test_two_archives_merge_into_one_bundle(client, auth) -> None:
    """Already true by construction (each .zip is a part and entries land flat in
    images/ by basename) — pinned here because nothing tested it and the wizard now
    tells users to do it."""
    upload_id = _open_session(client, auth)
    assert (
        _post_whole(
            client, auth, upload_id, "y2019.zip", _make_zip({"2019/a.png": b"a", "2019/b.png": b"b"})
        ).status_code
        == 200
    )
    second = _post_whole(
        client, auth, upload_id, "y2020.zip", _make_zip({"2020/c.png": b"c", "2020/d.png": b"d"})
    )
    assert second.status_code == 200
    assert second.json()["received_parts"] == 4
    session = _session_dir(upload_id)
    assert {p.name for p in (session / "images").iterdir()} == {"a.png", "b.png", "c.png", "d.png"}


def test_two_archives_may_carry_one_metadata_csv_between_them(client, auth) -> None:
    """One root-level CSV per BUNDLE, not per archive: the archive that carries it may
    be either one, and a second one is still refused."""
    upload_id = _open_session(client, auth)
    assert _post_whole(client, auth, upload_id, "a.zip", _make_zip({"a.png": b"a"})).status_code == 200
    assert (
        _post_whole(
            client, auth, upload_id, "b.zip", _make_zip({"b.png": b"b", "meta.csv": b"filename\nb.png\n"})
        ).status_code
        == 200
    )
    assert (_session_dir(upload_id) / "metadata.csv").read_bytes() == b"filename\nb.png\n"
    clash = _post_whole(
        client, auth, upload_id, "c.zip", _make_zip({"c.png": b"c", "other.csv": b"filename\nc.png\n"})
    )
    assert clash.status_code == 400
    assert (_session_dir(upload_id) / "metadata.csv").read_bytes() == b"filename\nb.png\n"


def test_overlapping_basenames_across_two_archives_refuse_the_SECOND_whole(
    client, auth
) -> None:
    """The edge the single-archive path never faced, and the outcome is defined: the
    second archive is refused ENTIRELY (400 naming the colliding basename), the first
    archive's bundle is untouched, and nothing from the second is merged — not even
    its non-colliding entries. Flattening by basename is what makes several archives
    one bundle, and it is also what makes two `2019/cover.jpg`s a genuine collision
    the server cannot silently resolve."""
    upload_id = _open_session(client, auth)
    first = _make_zip({"2019/cover.jpg": b"first-cover", "2019/only-in-first.png": b"1"})
    assert _post_whole(client, auth, upload_id, "y2019.zip", first).status_code == 200

    second = _make_zip({"2020/cover.jpg": b"second-cover", "2020/only-in-second.png": b"2"})
    clash = _post_whole(client, auth, upload_id, "y2020.zip", second)
    assert clash.status_code == 400
    assert "cover.jpg" in clash.json()["detail"]

    session = _session_dir(upload_id)
    assert {p.name for p in (session / "images").iterdir()} == {"cover.jpg", "only-in-first.png"}
    assert (session / "images" / "cover.jpg").read_bytes() == b"first-cover"
    assert not (session / "images" / "only-in-second.png").exists()
    assert not (session / ".extract-tmp").exists()
    status = client.get(f"/api/uploads/{upload_id}", headers=auth).json()
    assert status["received_parts"] == 2, "the refused archive added nothing to the tally"


def test_a_renamed_second_archive_then_merges(client, auth) -> None:
    """…and the documented remedy works: the user renames the collision away and the
    same archive lands, so the refusal is recoverable without discarding the session."""
    upload_id = _open_session(client, auth)
    assert (
        _post_whole(client, auth, upload_id, "y2019.zip", _make_zip({"2019/cover.jpg": b"first"})).status_code
        == 200
    )
    fixed = _make_zip({"2020/cover-2020.jpg": b"second"})
    assert _post_whole(client, auth, upload_id, "y2020.zip", fixed).status_code == 200
    session = _session_dir(upload_id)
    assert {p.name for p in (session / "images").iterdir()} == {"cover.jpg", "cover-2020.jpg"}
