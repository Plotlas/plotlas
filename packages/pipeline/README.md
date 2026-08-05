# pipeline

Ingestion pipeline for `image-viz`: turns an images directory + an optional
metadata CSV into the on-disk `/datasets/{ds_id}/` tree (`metadata.parquet`, a
per-layout **spatial tile pyramid** packed into one **PMTiles** container per
layout, the detail-tier originals, the optional tag sidecar, and the layout
manifest JSON). Invoked by `cli.py` directly or by `worker.py` from an RQ job.

v2 (decision **D-33**, the renderer rework): pixels are stored **by space, per
layout** — a fixed-area tiler assigns cells to web-map `{z}/{x}/{y}` tiles, bakes
FINE mini-atlas tiles (thumbnails + per-cell records) at the deepest level and
COARSE mosaic composites above. There is **no shared id-ordered atlas**, no fixed
3-LOD ceiling, and **no quadfeather** tiler any more. The producer conforms to
`schemas/v2/` (manifest_version `2.5` — the current minor; see
`schemas/v2/CHANGELOG.md`).

## Package layout

```
packages/pipeline/
  pyproject.toml            # allowed deps; [test] extra = pytest; pixscope entry; mypy config
  pipeline/
    __init__.py
    ingest.py               # CSV -> metadata.parquet, role validation, tag sidecar
    atlas.py                # decode-once per-cell square thumbnails -> on-disk cache (pyvips)
    tiler.py                # v2 spatial tile-pyramid baker: fixed-area tiler + mini-atlas
                            #   FINE tiles + mosaic COARSE tiles + PMTiles writer (D-33)
    manifest.py             # sole writer of the v2 layout manifest JSON
    worker.py               # run_ingest job body; run_ingest_job is the enqueue entry (D-15)
    cli.py                  # pixscope ingest entry point
    layout_plugins/
      __init__.py
      base.py               # Role, ColumnRoles, LayoutResult, LayoutPlugin ABC
      grid.py               # GridLayout
      datetime_layout.py    # DateTimeLayout
      categorical.py        # CategoricalLayout
      scatter.py            # ScatterLayout (pre-computed coordinates, D-26)
  tests/
    test_atlas.py           # native: thumbnail decode/cache
    test_tiler_v2.py        # native: pyramid baker (fine/coarse, PMTiles, dense ids, subsample)
    test_end_to_end.py      # native: run_ingest -> schemas/v2 tree (images-only + metadata)
    test_layouts.py / test_scatter.py / test_ingest.py / ...   # lean unit tests
  README.md
```

`pipeline` is a **top-level importable package** because the API enqueues the
ingest job by dotted-path string `"pipeline.worker.run_ingest_job"` (decision D-15);
the API never imports this package.

## Setup

```bash
pip install -e .[test]
```

The allowed dependencies are `pyarrow, duckdb, pyvips, rectpack, numpy` plus
`pmtiles` (the v2 PMTiles writer; the retired `quadfeather` CLI is gone) and
`jsonschema` (schemas/v2 validation). `pyvips` requires the system `libvips`
library at runtime; `tiler.py` imports both `pyvips` and `pmtiles`, so its tests
are marked `native` and run only in the worker image (`make test-pipeline`). The
lean test image runs the non-native unit tests + the contract gate.

## Import-resolution check

```bash
python -c "import pipeline.worker"        # decision D-15 dotted path resolves
```

The layout subclasses instantiate and report their required roles (the filename
join key is implied for any metadata-driven layout, decision D-25 — `grid` needs
no roles, so it is the guaranteed floor):

| Layout              | `name`        | `required_columns()`   |
|---------------------|---------------|------------------------|
| `GridLayout`        | `grid`        | `[]`                   |
| `DateTimeLayout`    | `datetime`    | `[DATETIME]`           |
| `CategoricalLayout` | `categorical` | `[CATEGORICAL]`        |
| `ScatterLayout`     | `scatter`     | `[SCATTER]`            |

## Type checking

```bash
mypy packages/pipeline
```

## Testing

```bash
# single test
cd packages/pipeline && python -m pytest tests/test_pipeline_skeleton.py -q
# full suite
cd packages/pipeline && python -m pytest -q
```
