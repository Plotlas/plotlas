"""Shared, lean-safe test fixtures for the pipeline package (images-first, D-25).

No pyvips/pmtiles import here — this module is collected in the lean test
image too (`make test-py`). ``images_dir`` creates EMPTY image-named files: ingest
scans filenames only (it never decodes), so the non-native ingest/scan tests need
no real images. The native end-to-end test builds real images itself.

The 12-row metadata fixture covers the R1 brief (§3): a scatter pair ``x``/``y``
with two null rows (unplaced cells, D-26), TWO categorical columns (multi-entry
expansion, recon. #9) with the ``category`` groups skewed 8/3/1 (proportional
regions, recon. #8), plus the original datetime + tag roles.
"""
from __future__ import annotations

import copy
import csv
from pathlib import Path

import pytest

_N = 12

# id-indexed enrichment values (id = sorted-filename position, D-25).
# category: skewed 8/3/1 — eight "red", three "blue", one "green".
_CATEGORY = ["red"] * 8 + ["blue"] * 3 + ["green"]
# place: a second categorical column (drives a second categorical layout).
_PLACE = ["indoor" if i % 2 == 0 else "outdoor" for i in range(_N)]
# Scatter pair: deterministic floats; ids 3 and 7 have EMPTY x/y (null ⇒ the
# unplaced strip). Values exercise negatives and non-unit ranges.
_SCATTER_X = ["-2.0", "1.5", "0.25", "", "3.5", "-1.25", "0.0", "", "2.75", "1.0", "-0.5", "3.0"]
_SCATTER_Y = ["10.0", "-4.0", "2.5", "", "8.0", "0.5", "-3.0", "", "5.25", "1.75", "9.0", "-2.5"]

# Filenames sort meaningfully → id is assigned by sorted filename (decision D-25).
# A metadata source joins by this filename; the tag delimiter "|" avoids the CSV
# comma. The filename role is the join key; one datetime, TWO categorical, one
# scatter pair, one tag role.
_COLUMN_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "datetime": {"column": "date", "label": "Date", "format": "iso8601"},
    "categorical": [
        {"column": "category", "label": "Category"},
        {"column": "place", "label": "Place"},
    ],
    "scatter": [{"x_column": "x", "y_column": "y", "label": "UMAP"}],
    "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
}


def image_names(n: int) -> list[str]:
    return [f"img_{i:03d}.webp" for i in range(n)]


@pytest.fixture
def fixture_n() -> int:
    return _N


@pytest.fixture
def names(fixture_n: int) -> list[str]:
    return image_names(fixture_n)


@pytest.fixture
def images_dir(tmp_path: Path, names: list[str]) -> Path:
    """A flat dir of EMPTY image-named files — enough for ingest's filename scan
    (non-native). The native test builds real images instead."""
    directory = tmp_path / "images"
    directory.mkdir()
    for name in names:
        (directory / name).touch()
    return directory


@pytest.fixture
def column_roles() -> dict:
    return copy.deepcopy(_COLUMN_ROLES)


@pytest.fixture
def metadata_csv(tmp_path: Path, names: list[str]) -> Path:
    """A metadata source whose `filename` column matches the image basenames,
    plus date / category / place / scatter-x/y / tags enrichment."""
    path = tmp_path / "meta.csv"
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "date", "category", "place", "x", "y", "tags"])
        for i, name in enumerate(names):
            date = f"2026-01-{i + 1:02d}"
            tags = "a|b" if i % 2 == 0 else "b|c"
            writer.writerow(
                [name, date, _CATEGORY[i], _PLACE[i], _SCATTER_X[i], _SCATTER_Y[i], tags]
            )
    return path
