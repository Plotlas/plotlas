"""Enqueue drift guard — the API↔worker calling convention (architecture-owned).

Decision: **primitives over the RQ boundary.** The lean API image carries no
pipeline dependency (decision D-15), so it cannot import or construct
`pipeline.worker.IngestJobPayload`. It therefore enqueues the dotted path
`pipeline.worker.run_ingest_job` with JSON-primitive kwargs, and the worker
rebuilds the typed payload.

This guard pins `run_ingest_job`'s parameter names — the cross-process contract —
so a pipeline-side rename fails CI rather than breaking ingest in production. It
imports only `pipeline` (no native deps) and runs in the lean test image via
`make test-py`.

Three halves (now closed) of the cross-process contract are gated here: the
dotted-path STRING (`test_api_dotted_path_targets_worker_entrypoint` —
`api.queue.RUN_INGEST_PATH` must resolve to `run_ingest_job`), the worker entry
point's PARAM NAMES (`test_enqueue_entrypoint_signature_matches_contract`), and —
PR15-1 — the API's ACTUAL enqueue kwargs (`test_api_enqueue_kwargs_bind_to_worker`):
`api.queue.enqueue_ingest` is driven with a fake `rq.Queue` that captures what it
sends, and those captured kwargs are asserted to
`inspect.signature(run_ingest_job).bind(**captured)` cleanly. This closes the loop
from the API SIDE: the name-set test pins the worker's params, but only binding the
API's real call catches a divergence where the API stops sending a kwarg the worker
requires (or sends an extra one) — a mismatch that would only surface at job
execution in production otherwise.

The SAME three halves are gated for the add-layouts job (T2-58/T2-42:
`api.queue.RUN_ADD_LAYOUTS_PATH` → `pipeline.worker.run_add_layouts_job`, primitive
kwargs), so the second enqueue boundary cannot silently drift either. Keep
`ADD_LAYOUTS_ENQUEUE_KWARGS` in lockstep with `api.queue.enqueue_add_layouts`.

Seam L2 added two more entry points — `run_delete_layout_job` and `run_set_roles_job` —
and seam L1 (#358) landed their API counterparts, `api.queue.enqueue_delete_layout` and
`enqueue_set_roles`. **All four boundaries are now gated in all three halves**
([[T2-the-two-l2-enqueue-boundaries-have-no-dotted]], which was the gap between L2 landing
the wrappers and L1 landing the enqueues). These two carry a FOURTH assertion the older
pair does not need — that each wrapper hands each primitive to the RIGHT payload field —
because a name-set cannot see a body, and `layout_id=dataset_id` inside `run_delete_layout_job`
would satisfy every other half here.

T2-97: `_CapturingQueue.enqueue` also captures `job_timeout` — a top-level
`Queue.enqueue()` arg (RQ's own per-job ceiling), NOT a job kwarg, so it is kept
OUT of `ENQUEUE_KWARGS`/`ADD_LAYOUTS_ENQUEUE_KWARGS` and asserted separately in the
two kwargs-bind tests against `api.queue.JOB_TIMEOUT_SECONDS`. This guards against
RQ's 180s built-in default silently re-applying (it killed any web bake running
longer than ~3 minutes) without conflating it with the primitive-kwargs contract.
"""

from __future__ import annotations

import importlib
import inspect
from pathlib import Path
from types import SimpleNamespace

import pytest

from pipeline import worker

# The cross-process enqueue contract: the primitive kwargs the API sends and the
# worker entry point accepts. Keep this in lockstep with the API's enqueue_ingest.
# `detail_tier` (T2-46) is the detail-tier opt-out — a bare-string primitive that both
# enqueue_ingest and run_ingest_job default to "bake", so the contract adds it here.
ENQUEUE_KWARGS = {
    "dataset_id",
    "owner",
    "images_dir",
    "output_root",
    "layout_types",
    "csv_path",
    "column_roles",
    "detail_tier",
}

# The add-layouts (T2-58/T2-42) cross-process enqueue contract: the primitive kwargs
# `api.queue.enqueue_add_layouts` sends and `pipeline.worker.run_add_layouts_job`
# accepts. Distinct from ingest — no csv_path (metadata is read-only from the
# committed parquet), no layout_types (specs are `layout_specs`), no detail_tier (the
# committed detail tier is reused). Keep in lockstep with enqueue_add_layouts.
ADD_LAYOUTS_ENQUEUE_KWARGS = {
    "dataset_id",
    "owner",
    "images_dir",
    "output_root",
    "layout_specs",
    "column_roles",
    # Seam L1 ([[T2-the-add-layouts-enqueue-contract-cannot-carry]]): the per-id opt-in
    # to re-baking a committed layout. Seam L2 landed the whole `--replace` path in the
    # pipeline but could not add the kwarg, because THIS set is asserted exactly and it
    # lives outside `packages/pipeline/` — so the three files moved together, which is
    # what the failure message below has always told the next agent to do.
    "replace",
}

# Seam L2's two NEW enqueue boundaries. Both wrappers' docstrings call their parameter
# names "the cross-process contract ... treat a rename here as a breaking change", and
# until this guard existed nothing held them to it: `git grep` on the seam branch returned
# the definitions plus doc mentions and no test at all, so a typo INSIDE either wrapper
# (`layout_id=dataset_id`) shipped green and would have surfaced only when seam L1 wired
# the dotted path. Seam L2 could gate only the param names, because the `api/queue.py`
# counterparts did not exist yet; #358 added `enqueue_delete_layout` / `enqueue_set_roles`
# and with them the dotted-path and kwargs-bind halves below, closing
# [[T2-the-two-l2-enqueue-boundaries-have-no-dotted]]. Keep these two sets in lockstep
# with those two functions, exactly as ADD_LAYOUTS_ENQUEUE_KWARGS is kept in lockstep
# with enqueue_add_layouts.
DELETE_LAYOUT_ENQUEUE_KWARGS = {
    "dataset_id",
    "owner",
    "output_root",
    "layout_id",
}

SET_ROLES_ENQUEUE_KWARGS = {
    "dataset_id",
    "owner",
    "output_root",
    "column_roles",
}


def test_run_ingest_job_is_the_enqueue_entrypoint() -> None:
    # The API enqueues this dotted path (api/queue.py RUN_INGEST_PATH); it must
    # exist and be resolvable in the worker process.
    assert hasattr(worker, "run_ingest_job"), (
        "API enqueues 'pipeline.worker.run_ingest_job' with primitive kwargs"
    )


def test_enqueue_entrypoint_signature_matches_contract() -> None:
    params = set(inspect.signature(worker.run_ingest_job).parameters)
    assert params == ENQUEUE_KWARGS, (
        f"run_ingest_job params {sorted(params)} drifted from the enqueue contract "
        f"{sorted(ENQUEUE_KWARGS)} — update api/queue.py enqueue_ingest and this "
        "guard together"
    )


def test_api_dotted_path_targets_worker_entrypoint() -> None:
    # The OTHER half of the contract: the dotted-path STRING the API enqueues
    # (api/queue.py RUN_INGEST_PATH) must name — and resolve to — the primitive-kwargs
    # worker entry point. Pinning run_ingest_job's params alone would NOT catch
    # api/queue.py still pointing at run_ingest (the typed-payload fn): enqueuing
    # primitive kwargs to it TypeErrors at job execution. The combined test image
    # puts both packages on the path (like test_stack_boots); api never imports pipeline.
    from api import queue

    assert queue.RUN_INGEST_PATH == "pipeline.worker.run_ingest_job", (
        f"api/queue.py RUN_INGEST_PATH is {queue.RUN_INGEST_PATH!r}; the API enqueues "
        "primitive kwargs, which only bind to pipeline.worker.run_ingest_job — "
        "run_ingest takes one typed payload and would TypeError at execution"
    )
    module_path, _, attr = queue.RUN_INGEST_PATH.rpartition(".")
    resolved = getattr(importlib.import_module(module_path), attr)
    assert resolved is worker.run_ingest_job, (
        "RUN_INGEST_PATH must resolve to pipeline.worker.run_ingest_job"
    )


class _CapturingQueue:
    """A fake rq.Queue that records the (func_string, kwargs, job_timeout) of one
    enqueue and returns a job-id-bearing handle — enough for enqueue_ingest, with no
    broker. `job_timeout` (T2-97) is captured separately from `kwargs` because it is
    a top-level `Queue.enqueue()` arg — RQ's own per-job ceiling — not a job kwarg;
    real rq.Queue.enqueue accepts it the same way, so this stays a faithful fake."""

    def __init__(self) -> None:
        self.func_string: str | None = None
        self.kwargs: dict | None = None
        self.job_timeout: int | float | None = None

    def enqueue(  # noqa: ANN201
        self, func_string: str, kwargs: dict | None = None, *, job_timeout: int | float | None = None
    ):
        self.func_string = func_string
        self.kwargs = kwargs or {}
        self.job_timeout = job_timeout
        return SimpleNamespace(id="job-smoke-1")


def test_api_enqueue_kwargs_bind_to_worker() -> None:
    """PR15-1 — close the loop from the API SIDE. Drive the API's real
    `enqueue_ingest` with a fake Queue, capture the kwargs it actually sends, and
    assert they bind to `inspect.signature(run_ingest_job)`. The name-set test pins
    the worker's params; this catches the OTHER failure mode — the API dropping a
    required kwarg (or sending an unexpected one) — which would otherwise only blow
    up at job execution in production. The combined test image puts both packages on
    the path (api never imports pipeline). Also asserts (T2-97) that `job_timeout` —
    a top-level `enqueue()` arg, NOT a job kwarg — is set to `queue.JOB_TIMEOUT_SECONDS`
    on every call, so RQ's 180s built-in default can never again apply silently."""
    from api import queue

    fake = _CapturingQueue()
    # Exercise BOTH the images-only path (csv_path/column_roles default to None) and,
    # below, the metadata path — both must bind.
    queue.enqueue_ingest(
        fake,
        dataset_id="ds",
        owner="alice",
        images_dir="/data/datasets/../users/alice/uploads/u1/images",
        output_root="/data/datasets",
        layout_types=["grid"],
    )
    assert fake.func_string == queue.RUN_INGEST_PATH
    assert fake.kwargs is not None
    # The crux: the API's ACTUAL kwargs bind to the worker entry point's signature.
    inspect.signature(worker.run_ingest_job).bind(**fake.kwargs)
    # And the captured key set is exactly the agreed contract (no extra, none missing).
    assert set(fake.kwargs) == ENQUEUE_KWARGS
    # T2-97: job_timeout must be the bounded 24h constant, not RQ's 180s default.
    assert fake.job_timeout == queue.JOB_TIMEOUT_SECONDS

    # Metadata path: csv_path + column_roles populated. Must bind too.
    fake_meta = _CapturingQueue()
    queue.enqueue_ingest(
        fake_meta,
        dataset_id="ds2",
        owner="bob",
        images_dir="/imgs",
        output_root="/out",
        layout_types=["grid", "datetime"],
        csv_path="/meta.csv",
        column_roles={"filename": {"column": "file", "label": "File"}},
    )
    assert fake_meta.kwargs is not None
    inspect.signature(worker.run_ingest_job).bind(**fake_meta.kwargs)
    assert fake_meta.job_timeout == queue.JOB_TIMEOUT_SECONDS


# --- add-layouts (T2-58/T2-42): the second enqueue boundary --------------------


def test_run_add_layouts_job_is_the_enqueue_entrypoint() -> None:
    # The API enqueues this dotted path (api/queue.py RUN_ADD_LAYOUTS_PATH); it must
    # exist and be resolvable in the worker process.
    assert hasattr(worker, "run_add_layouts_job"), (
        "API enqueues 'pipeline.worker.run_add_layouts_job' with primitive kwargs"
    )


def test_add_layouts_entrypoint_signature_matches_contract() -> None:
    params = set(inspect.signature(worker.run_add_layouts_job).parameters)
    assert params == ADD_LAYOUTS_ENQUEUE_KWARGS, (
        f"run_add_layouts_job params {sorted(params)} drifted from the enqueue "
        f"contract {sorted(ADD_LAYOUTS_ENQUEUE_KWARGS)} — update api/queue.py "
        "enqueue_add_layouts and this guard together"
    )


def test_api_add_layouts_dotted_path_targets_worker_entrypoint() -> None:
    # The dotted-path STRING the API enqueues (api/queue.py RUN_ADD_LAYOUTS_PATH) must
    # name — and resolve to — the primitive-kwargs worker entry point. Pinning
    # run_add_layouts_job's params alone would NOT catch api/queue.py still pointing at
    # run_add_layouts (the typed-payload fn): enqueuing primitive kwargs to it
    # TypeErrors at job execution.
    from api import queue

    assert queue.RUN_ADD_LAYOUTS_PATH == "pipeline.worker.run_add_layouts_job", (
        f"api/queue.py RUN_ADD_LAYOUTS_PATH is {queue.RUN_ADD_LAYOUTS_PATH!r}; the "
        "API enqueues primitive kwargs, which only bind to "
        "pipeline.worker.run_add_layouts_job — run_add_layouts takes one typed "
        "payload and would TypeError at execution"
    )
    module_path, _, attr = queue.RUN_ADD_LAYOUTS_PATH.rpartition(".")
    resolved = getattr(importlib.import_module(module_path), attr)
    assert resolved is worker.run_add_layouts_job, (
        "RUN_ADD_LAYOUTS_PATH must resolve to pipeline.worker.run_add_layouts_job"
    )


def test_api_add_layouts_kwargs_bind_to_worker() -> None:
    """Close the loop from the API SIDE for add-layouts: drive the real
    `enqueue_add_layouts` with a fake Queue, capture the kwargs it sends, and assert
    they bind to `inspect.signature(run_add_layouts_job)` — catching the API dropping
    a required kwarg (or sending an extra one), which would otherwise only blow up at
    job execution in production. Also asserts (T2-97) that `job_timeout` — a
    top-level `enqueue()` arg, NOT a job kwarg — is set to `queue.JOB_TIMEOUT_SECONDS`
    on every call, so RQ's 180s built-in default can never again apply silently."""
    from api import queue

    # Default (roles reused): column_roles omitted → defaults to None. Must bind.
    fake = _CapturingQueue()
    queue.enqueue_add_layouts(
        fake,
        dataset_id="ds",
        owner="alice",
        images_dir="/data/datasets/../users/alice/uploads/u1/images",
        output_root="/data/datasets",
        layout_specs=["datetime", "categorical_kingdom"],
    )
    assert fake.func_string == queue.RUN_ADD_LAYOUTS_PATH
    assert fake.kwargs is not None
    inspect.signature(worker.run_add_layouts_job).bind(**fake.kwargs)
    assert set(fake.kwargs) == ADD_LAYOUTS_ENQUEUE_KWARGS
    # T2-97: job_timeout must be the bounded 24h constant, not RQ's 180s default.
    assert fake.job_timeout == queue.JOB_TIMEOUT_SECONDS

    # Roles-override path: column_roles populated. Must bind too.
    fake_roles = _CapturingQueue()
    queue.enqueue_add_layouts(
        fake_roles,
        dataset_id="ds2",
        owner="bob",
        images_dir="/imgs",
        output_root="/out",
        layout_specs=["scatter"],
        column_roles={"filename": {"column": "file", "label": "File"}},
    )
    assert fake_roles.kwargs is not None
    inspect.signature(worker.run_add_layouts_job).bind(**fake_roles.kwargs)
    assert fake_roles.job_timeout == queue.JOB_TIMEOUT_SECONDS


# --- seam L2 (delete-layout / set-roles): the third and fourth enqueue boundaries -----


def test_run_delete_layout_job_is_the_enqueue_entrypoint() -> None:
    # Seam L1's delete route will enqueue this dotted path with primitive kwargs.
    assert hasattr(worker, "run_delete_layout_job"), (
        "the API enqueues 'pipeline.worker.run_delete_layout_job' with primitive kwargs"
    )


def test_delete_layout_entrypoint_signature_matches_contract() -> None:
    params = set(inspect.signature(worker.run_delete_layout_job).parameters)
    assert params == DELETE_LAYOUT_ENQUEUE_KWARGS, (
        f"run_delete_layout_job params {sorted(params)} drifted from the enqueue "
        f"contract {sorted(DELETE_LAYOUT_ENQUEUE_KWARGS)} — update seam L1's "
        "enqueue_delete_layout and this guard together"
    )


def test_api_delete_layout_dotted_path_targets_worker_entrypoint() -> None:
    # The dotted-path STRING the API enqueues (api/queue.py RUN_DELETE_LAYOUT_PATH) must
    # name — and resolve to — the primitive-kwargs worker entry point. Pinning
    # run_delete_layout_job's params alone would NOT catch api/queue.py still pointing at
    # run_delete_layout (the typed-payload fn): enqueuing primitive kwargs to it
    # TypeErrors at job execution. `packages/api/tests` pins this constant as a STRING
    # from inside the API package, which is all it can do — it must not import pipeline.
    # RESOLVING it needs both packages on the path, which is what this image is for.
    from api import queue

    assert queue.RUN_DELETE_LAYOUT_PATH == "pipeline.worker.run_delete_layout_job", (
        f"api/queue.py RUN_DELETE_LAYOUT_PATH is {queue.RUN_DELETE_LAYOUT_PATH!r}; the "
        "API enqueues primitive kwargs, which only bind to "
        "pipeline.worker.run_delete_layout_job — run_delete_layout takes one typed "
        "payload and would TypeError at execution"
    )
    module_path, _, attr = queue.RUN_DELETE_LAYOUT_PATH.rpartition(".")
    resolved = getattr(importlib.import_module(module_path), attr)
    # Kept for symmetry with the add-layouts test above, not for coverage: the string
    # equality is what fails, and `import_module("pipeline.worker")` returns the SAME
    # object `from pipeline import worker` bound, so this cannot fail alone. That the
    # attribute EXISTS is pinned by the hasattr test earlier in this file.
    assert resolved is worker.run_delete_layout_job, (
        "RUN_DELETE_LAYOUT_PATH must resolve to pipeline.worker.run_delete_layout_job"
    )


def test_api_delete_layout_kwargs_bind_to_worker() -> None:
    """Close the loop from the API SIDE for delete-layout: drive the real
    `enqueue_delete_layout` with a fake Queue, capture the kwargs it sends, and assert
    they bind to `inspect.signature(run_delete_layout_job)` — catching the API dropping a
    required kwarg (or sending an extra one), which would otherwise only blow up at job
    execution in production. Also asserts (T2-97) that `job_timeout` — a top-level
    `enqueue()` arg, NOT a job kwarg — is set to `queue.JOB_TIMEOUT_SECONDS`, so RQ's
    180s built-in default can never apply silently to a verb that sweeps a layout's
    tiles."""
    from api import queue

    fake = _CapturingQueue()
    queue.enqueue_delete_layout(
        fake,
        dataset_id="ds",
        owner="alice",
        output_root="/data/datasets",
        layout_id="datetime",
    )
    assert fake.func_string == queue.RUN_DELETE_LAYOUT_PATH
    assert fake.kwargs is not None
    inspect.signature(worker.run_delete_layout_job).bind(**fake.kwargs)
    assert set(fake.kwargs) == DELETE_LAYOUT_ENQUEUE_KWARGS
    # T2-97: job_timeout must be the bounded 24h constant, not RQ's 180s default.
    assert fake.job_timeout == queue.JOB_TIMEOUT_SECONDS


def test_run_set_roles_job_is_the_enqueue_entrypoint() -> None:
    assert hasattr(worker, "run_set_roles_job"), (
        "the API enqueues 'pipeline.worker.run_set_roles_job' with primitive kwargs"
    )


def test_set_roles_entrypoint_signature_matches_contract() -> None:
    params = set(inspect.signature(worker.run_set_roles_job).parameters)
    assert params == SET_ROLES_ENQUEUE_KWARGS, (
        f"run_set_roles_job params {sorted(params)} drifted from the enqueue contract "
        f"{sorted(SET_ROLES_ENQUEUE_KWARGS)} — update seam L1's enqueue_set_roles and "
        "this guard together"
    )


def test_api_set_roles_dotted_path_targets_worker_entrypoint() -> None:
    # As above, for the roles boundary: the STRING must resolve to the primitive-kwargs
    # wrapper. run_set_roles (the typed-payload fn) would TypeError on primitive kwargs.
    from api import queue

    assert queue.RUN_SET_ROLES_PATH == "pipeline.worker.run_set_roles_job", (
        f"api/queue.py RUN_SET_ROLES_PATH is {queue.RUN_SET_ROLES_PATH!r}; the API "
        "enqueues primitive kwargs, which only bind to "
        "pipeline.worker.run_set_roles_job — run_set_roles takes one typed payload and "
        "would TypeError at execution"
    )
    module_path, _, attr = queue.RUN_SET_ROLES_PATH.rpartition(".")
    resolved = getattr(importlib.import_module(module_path), attr)
    # Kept for symmetry with the add-layouts test above, not for coverage: the string
    # equality is what fails, and `import_module("pipeline.worker")` returns the SAME
    # object `from pipeline import worker` bound, so this cannot fail alone. That the
    # attribute EXISTS is pinned by the hasattr test earlier in this file.
    assert resolved is worker.run_set_roles_job, (
        "RUN_SET_ROLES_PATH must resolve to pipeline.worker.run_set_roles_job"
    )


def test_api_set_roles_kwargs_bind_to_worker() -> None:
    """Close the loop from the API SIDE for set-roles: drive the real `enqueue_set_roles`
    with a fake Queue, capture the kwargs it sends, and assert they bind to
    `inspect.signature(run_set_roles_job)`. `column_roles` is the FULL replacement map
    and crosses as a plain dict — a JSON primitive, like every other kwarg here — so the
    lean API image never constructs `pipeline.worker.SetRolesJobPayload`. Also asserts
    (T2-97) the top-level `job_timeout`."""
    from api import queue

    fake = _CapturingQueue()
    queue.enqueue_set_roles(
        fake,
        dataset_id="ds",
        owner="alice",
        output_root="/data/datasets",
        column_roles={"filename": {"column": "file", "label": "File"}},
    )
    assert fake.func_string == queue.RUN_SET_ROLES_PATH
    assert fake.kwargs is not None
    inspect.signature(worker.run_set_roles_job).bind(**fake.kwargs)
    assert set(fake.kwargs) == SET_ROLES_ENQUEUE_KWARGS
    # T2-97: job_timeout must be the bounded 24h constant, not RQ's 180s default.
    assert fake.job_timeout == queue.JOB_TIMEOUT_SECONDS


def test_l2_wrappers_hand_each_primitive_to_the_right_payload_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The half a name-set CANNOT catch: what the wrapper DOES with each primitive.

    A name-set pins renames. It does not notice `layout_id=dataset_id` inside the body,
    and neither of these wrappers had a caller or a test, so such a typo would have
    shipped green and surfaced only at job execution once seam L1 wired the dotted path.
    Each wrapper is driven with four distinguishable values and the payload it builds is
    inspected; `run_delete_layout` / `run_set_roles` are stubbed out, so nothing touches
    a dataset tree and this stays a lean, import-only smoke test."""
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        worker, "run_delete_layout", lambda payload: captured.update(payload=payload) or {}
    )
    worker.run_delete_layout_job(
        dataset_id="the-dataset",
        owner="the-owner",
        output_root="/the/output/root",
        layout_id="the-layout",
    )
    payload = captured["payload"]
    assert (payload.dataset_id, payload.owner, payload.layout_id) == (
        "the-dataset", "the-owner", "the-layout",
    )
    assert str(payload.output_root) == str(Path("/the/output/root"))

    monkeypatch.setattr(
        worker, "run_set_roles", lambda payload: captured.update(payload=payload) or {}
    )
    roles = {"filename": {"column": "file", "label": "File"}}
    worker.run_set_roles_job(
        dataset_id="the-dataset",
        owner="the-owner",
        output_root="/the/output/root",
        column_roles=roles,
    )
    payload = captured["payload"]
    assert (payload.dataset_id, payload.owner, payload.column_roles) == (
        "the-dataset", "the-owner", roles,
    )
    assert str(payload.output_root) == str(Path("/the/output/root"))
