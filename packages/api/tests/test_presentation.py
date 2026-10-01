"""Collection presentation — display name + attribution (SCOPE_shareable-collections
Part B).

They have MOVED. This docstring used to justify keeping them in app-state with "putting
them in the manifest would make renaming a collection require a re-bake" — which is
false: `refresh-manifest` rewrites a committed manifest in place, no tiles touched, no
`dataset_version` bump. The correction is kept because it is why they sat in the wrong
place, but note what the fix turned out to be: they did not go INTO the manifest. They
went into `presentation.json` BESIDE it (D-i/D-xv), because one file with a cheap-edit
path would have had two writers. The API owns that file and still writes no manifest.

What these tests assert is the API's BEHAVIOUR — every presentation value is written
through `PATCH .../presentation` and read back through `GET`, never poked into storage
directly. That is why this file needed no change when the storage moved: it passed
unaltered across the move, which is the strongest available evidence that the wire
contract did not shift. The fixture seeds app-state only with `owner`, which stays there
permanently (D-ii). The new behaviour the move ADDED — the merge, the fallback, the round
trips, the migration — is pinned in `test_presentation_serving.py`.

The load-bearing property these tests exist for is that a rename is PRESENTATION ONLY.
`dataset_id` stays the app-state primary key, the on-disk directory name, the tile path
and the deep-link target — so renaming can never strand a link someone already shared.
That is asserted directly (test_rename_does_not_touch_the_id_or_its_directory) rather
than left as a comment, because it is the one thing a future refactor could plausibly
"improve" by introducing a slug.
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api import appstate

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
DATASET = "golden_dataset_v2"

_ALICE = {"username": "alice", "email": "alice@example.com", "password": "s3cretpw"}
_BOB = {"username": "bob", "email": "bob@example.com", "password": "s3cretpw"}


def _seed_owner(db_path: Path, dataset_id: str, owner: str) -> None:
    async def _run() -> None:
        engine, sessionmaker = await appstate.setup_appstate(db_path)
        try:
            async with sessionmaker() as session:
                await appstate.record_dataset_owner(session, dataset_id, owner)
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture
def db_path(tmp_path: Path) -> Path:
    return tmp_path / "appstate.db"


@pytest.fixture
def data_root(tmp_path: Path) -> Path:
    dr = tmp_path / "data"
    (dr / "datasets").mkdir(parents=True)
    shutil.copytree(FIXTURES / DATASET, dr / "datasets" / DATASET)
    return dr


@pytest.fixture
def client(db_path: Path, data_root: Path, monkeypatch) -> Iterator[TestClient]:
    monkeypatch.setenv("APP_STATE_DB", str(db_path))
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    from api.main import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


def _signup_login(client: TestClient, creds: dict[str, str]) -> dict[str, str]:
    assert client.post("/api/auth/signup", json=creds).status_code == 200
    token = client.post(
        "/api/auth/login",
        json={"username": creds["username"], "password": creds["password"]},
    ).json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def alice(client: TestClient, db_path: Path) -> dict[str, str]:
    headers = _signup_login(client, _ALICE)
    _seed_owner(db_path, DATASET, "alice")
    return headers


def _patch(
    client: TestClient, headers: dict[str, str], body: dict
) -> tuple[int, dict]:
    resp = client.patch(
        f"/api/datasets/{DATASET}/presentation", json=body, headers=headers
    )
    return resp.status_code, (resp.json() if resp.content else {})


def _summary(client: TestClient, headers: dict[str, str]) -> dict:
    resp = client.get(f"/api/datasets/{DATASET}", headers=headers)
    assert resp.status_code == 200
    return resp.json()


# --- the invariant the whole seam rests on ---------------------------------


def test_rename_does_not_touch_the_id_or_its_directory(
    client: TestClient, alice: dict[str, str], data_root: Path
) -> None:
    """A rename changes the LABEL only. If this ever fails, every deep link that was
    ever shared is broken and the on-disk tree has moved — which is precisely the
    failure mode the scope forbids."""
    status, _ = _patch(client, alice, {"display_name": "Rijksmuseum — Public Domain"})
    assert status == 200

    summary = _summary(client, alice)
    assert summary["dataset_id"] == DATASET  # the addressable id is unchanged
    assert summary["display_name"] == "Rijksmuseum — Public Domain"
    # The directory did not move, so tiles/positions/manifest all still resolve.
    assert (data_root / "datasets" / DATASET).is_dir()
    # And the collection is still reachable under its ORIGINAL id — i.e. the
    # `?d=golden_dataset_v2` link someone shared before the rename still works.
    assert client.get(f"/api/datasets/{DATASET}", headers=alice).status_code == 200


# --- partial by key presence -----------------------------------------------


def test_absent_field_is_left_alone_and_null_clears_it(
    client: TestClient, alice: dict[str, str]
) -> None:
    """The PATCH distinguishes "don't touch" from "clear". Without that asymmetry a bad
    name could never be undone — which is why the router keys off `model_fields_set`
    (the keys the client actually sent) rather than the parsed values, since pydantic
    collapses an absent field and an explicit null to the same None."""
    assert _patch(client, alice, {"display_name": "A name"})[0] == 200
    assert _patch(client, alice, {"attribution": "Some museum"})[0] == 200

    # Patching ONLY attribution must leave the name intact.
    status, body = _patch(client, alice, {"attribution": "Another museum"})
    assert status == 200
    assert body["display_name"] == "A name"
    assert body["attribution"] == "Another museum"

    # An explicit null CLEARS just that field.
    status, body = _patch(client, alice, {"display_name": None})
    assert status == 200
    assert body["display_name"] is None
    assert body["attribution"] == "Another museum"


def test_blank_clears_so_the_ui_empty_input_does_the_obvious_thing(
    client: TestClient, alice: dict[str, str]
) -> None:
    assert _patch(client, alice, {"display_name": "A name"})[0] == 200
    status, body = _patch(client, alice, {"display_name": "   "})
    assert status == 200
    assert body["display_name"] is None


def test_values_are_stored_trimmed(client: TestClient, alice: dict[str, str]) -> None:
    """Echoed back AS STORED, so a client never has to guess at normalization."""
    status, body = _patch(client, alice, {"display_name": "  Padded  "})
    assert status == 200
    assert body["display_name"] == "Padded"


def test_an_empty_patch_is_rejected(client: TestClient, alice: dict[str, str]) -> None:
    assert _patch(client, alice, {})[0] == 422


def test_over_long_values_are_rejected(
    client: TestClient, alice: dict[str, str]
) -> None:
    assert _patch(client, alice, {"display_name": "x" * 121})[0] == 422
    assert _patch(client, alice, {"attribution": "y" * 201})[0] == 422
    # ...and the rejection left nothing behind.
    assert _summary(client, alice)["display_name"] is None


# --- authorization ---------------------------------------------------------


def test_not_the_owner_cannot_rename(
    client: TestClient, alice: dict[str, str]
) -> None:
    bob = _signup_login(client, _BOB)
    assert _patch(client, bob, {"display_name": "mine now"})[0] == 403
    assert _summary(client, alice)["display_name"] is None


def test_anonymous_cannot_rename(client: TestClient, alice: dict[str, str]) -> None:
    assert _patch(client, {}, {"display_name": "anon"})[0] == 401


def test_unknown_dataset_is_404(client: TestClient, alice: dict[str, str]) -> None:
    resp = client.patch(
        "/api/datasets/no_such_dataset/presentation",
        json={"display_name": "x"},
        headers=alice,
    )
    assert resp.status_code == 404


# --- defaults --------------------------------------------------------------


def test_unset_presentation_reads_as_null_not_the_id(
    client: TestClient, alice: dict[str, str]
) -> None:
    """The API reports the raw state; the FALLBACK to the id is the consumer's job
    (frontend `collectionName`). If the API substituted the id here, a client could
    not tell "named after its id" from "not named", and clearing would look like a
    no-op."""
    summary = _summary(client, alice)
    assert summary["display_name"] is None
    assert summary["attribution"] is None


def test_attribution_is_served_on_the_ready_summary(
    client: TestClient, alice: dict[str, str]
) -> None:
    """A SET attribution must flow through GET /api/datasets/{id} — the _ready_summary
    path the viewer footer reads — not only the PATCH echo. Pins the wiring in its
    NON-null case (test_unset_presentation covers the None case)."""
    assert _patch(client, alice, {"attribution": "Rijksmuseum, Amsterdam"})[0] == 200
    summary = _summary(client, alice)
    assert summary["dataset_id"] == DATASET  # still addressed by its id
    assert summary["attribution"] == "Rijksmuseum, Amsterdam"


# --- Part D §2b: attribution_url ------------------------------------------


def test_attribution_url_round_trips_and_clears(
    client: TestClient, alice: dict[str, str]
) -> None:
    """A third presentation field, following the same partial-by-key-presence rule."""
    status, body = _patch(
        client,
        alice,
        {"attribution": "Rijksmuseum, Amsterdam", "attribution_url": "https://www.rijksmuseum.nl"},
    )
    assert status == 200
    assert body["attribution_url"] == "https://www.rijksmuseum.nl"
    # It reaches the GET, so the viewer/card can render the anchor.
    assert _summary(client, alice)["attribution_url"] == "https://www.rijksmuseum.nl"

    # Clearing the link leaves the CREDIT intact — the credit is the information, the
    # link is the extra.
    status, body = _patch(client, alice, {"attribution_url": None})
    assert status == 200
    assert body["attribution_url"] is None
    assert body["attribution"] == "Rijksmuseum, Amsterdam"


def test_the_api_does_not_validate_the_url_shape(
    client: TestClient, alice: dict[str, str]
) -> None:
    """Deliberate: the RENDERER refuses anything that is not absolute http(s) (see
    frontend sourceLink), and it must, because values also arrive via the CLI. Rejecting
    here as well would add a second, divergent rule for no gain — and a stored-but-inert
    value is recoverable, whereas a rejected write loses the operator's typing."""
    status, body = _patch(client, alice, {"attribution_url": "not-a-url"})
    assert status == 200
    assert body["attribution_url"] == "not-a-url"


def test_over_long_attribution_url_is_rejected(
    client: TestClient, alice: dict[str, str]
) -> None:
    assert _patch(client, alice, {"attribution_url": "h" * 501})[0] == 422


def test_a_rejected_multi_field_patch_writes_NOTHING(
    client: TestClient, alice: dict[str, str]
) -> None:
    """All-or-nothing: every field is normalized and length-checked BEFORE the row is
    touched, so one bad value cannot leave a sibling field half-written."""
    assert _patch(client, alice, {"display_name": "Good name"})[0] == 200
    status, _ = _patch(
        client, alice, {"attribution": "Fine", "attribution_url": "u" * 501}
    )
    assert status == 422
    summary = _summary(client, alice)
    assert summary["display_name"] == "Good name"  # untouched
    assert summary["attribution"] is None  # the valid sibling was NOT written
