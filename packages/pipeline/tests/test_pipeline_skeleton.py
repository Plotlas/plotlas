"""Tier-1 skeleton tests: the package imports cleanly, the layout ABC enforces
its abstract methods, and each concrete layout reports its documented roles.

No behavior is exercised — stubbed bodies raise NotImplementedError by design.
"""
import importlib

import pytest

from pipeline.layout_plugins.base import LayoutPlugin, Role
from pipeline.layout_plugins.categorical import CategoricalLayout
from pipeline.layout_plugins.datetime_layout import DateTimeLayout
from pipeline.layout_plugins.grid import GridLayout


def test_worker_import_resolves() -> None:
    # decision D-15: the API enqueues "pipeline.worker.run_ingest_job" (the
    # primitive-kwargs entry) by dotted path; it delegates to run_ingest. Both must
    # resolve in the worker process even though the API never imports pipeline.
    module = importlib.import_module("pipeline.worker")
    assert hasattr(module, "run_ingest_job")
    assert hasattr(module, "run_ingest")
    assert hasattr(module, "IngestJobPayload")


def test_layout_plugin_abc_is_not_instantiable() -> None:
    with pytest.raises(TypeError):
        LayoutPlugin()  # type: ignore[abstract]


def test_grid_layout_roles() -> None:
    layout = GridLayout()
    assert layout.name == "grid"
    assert layout.required_columns() == []  # images-only floor (D-25)


def test_datetime_layout_roles() -> None:
    layout = DateTimeLayout()
    assert layout.name == "datetime"
    assert layout.required_columns() == [Role.DATETIME]


def test_categorical_layout_roles() -> None:
    layout = CategoricalLayout()
    assert layout.name == "categorical"
    assert layout.required_columns() == [Role.CATEGORICAL]
