# Calibration dataset — a visual + machine-checkable test instrument

The v2 renderer/pipeline kept shipping bugs that unit tests and code review could
not see, because nothing verified **what actually appears on screen and where**.
This is that missing oracle: a synthetic dataset whose every cell is a known color
determined by its grid position, so the baked pyramid (and, later, the rendered
canvas) can be checked **pixel-exactly** — by a human *and* by a script.

## The idea

Each source image `n` is a solid color encoding its grid position:

```
S        = ceil(sqrt(N))            # GridLayout uses cols = ceil(sqrt(n))
col, row = n % S, n // S            # row-major
R = round(col / (S-1) * 255)        # column  (recover: col = round(R/255*(S-1)))
G = round(row / (S-1) * 255)        # row
B = 64 / 192 checker by (col+row)   # neighbours differ; coarse averaging -> B~128
```

`(R,G)` is a position oracle at every level; the cell record's `(x,y)` is the exact
identity oracle. A human sees a smooth 2D gradient — a misplaced tile is an obvious
color discontinuity; coarse banding is obvious black.

## Run it (in the worker container)

```sh
# generate N source images, then ingest through the REAL pipeline
python tools/calibration/generate_calib.py 10000 /tmp/calib/images
pixscope ingest --images /tmp/calib/images --dataset-id calib_v2 --layout grid --sync --owner you

# verify the BAKE against the oracle (decodes PMTiles directly, no renderer)
python tools/calibration/verify_bake.py calib_v2 10000
```

`N=256` gives a 2-level pyramid with fully-filled fine tiles (clean baseline);
`N=10000` mirrors a real iNat-scale bake (`z_cap=z_max=4`, partially-filled fine
tiles) and was the case that exposed the (since-fixed) coarse banding.

## Synthetic metadata — all-layouts recipe (`--emit-metadata`)

`generate_calib.py --emit-metadata` ALSO writes `metadata.csv` + `column_roles.json`
next to the images (in the images dir's parent), covering **every role**, so the same
calibration images can be ingested with metadata and bake **all layout types**
(grid/datetime/scatter/categorical/tags). Every field is derived deterministically
from the cell index `n` (no RNG, no clock) — the color-position grid oracle is
untouched. Roles emitted:

| column     | role        | shape                                                            |
|------------|-------------|------------------------------------------------------------------|
| `filename` | filename    | the image basename (join key, D-25 id order)                     |
| `captured` | datetime    | iso8601 date, **one day per cell** (a real multi-month range)    |
| `sx`,`sy`  | scatter     | clustered bulk + a **wide sparse tail** (robust fit) + some **null coords** -> the unplaced strip |
| `group`    | categorical | **low cardinality** (3 values)                                   |
| `bucket`   | categorical | **higher cardinality** (12 values)                               |
| `tags`     | tag         | `|`-delimited, with **empty** (no-tag) + **multi-value** cells   |
| `caption`  | freeform    | display-only (`cell-NNNNN`)                                      |

This recipe drives the committed **`golden_dataset_full_v2`** contract fixture — a
small, deterministic, ALL-layouts dataset that exercises the full `schemas/v2/`
surface (every layout at `z_cap >= 1`, a real coarse mosaic tier, non-grid cell
records, the tags sidecar, and the scatter unplaced strip). It complements the
minimal grid-only `golden_dataset_v2` (which the api/frontend unit tests pin) and the
render-gate's `calib_small_v2` (multi-level, images-only). Bake it (worker image;
detail tier skipped to keep the tree small — 5 PMTiles containers + parquet + tags):

```sh
docker build -f docker/Dockerfile.worker -t image-viz-worker .
docker run --rm image-viz-worker sh -c '
  python tools/calibration/generate_calib.py 256 /tmp/calib/images --emit-metadata
  pixscope ingest --images /tmp/calib/images \
                  --metadata /tmp/calib/metadata.csv \
                  --column-roles /tmp/calib/column_roles.json \
                  --layout grid,datetime,scatter,categorical --detail-tier skip \
                  --dataset-id golden_dataset_full_v2 --sync --owner ci
  tar -C /data/datasets/golden_dataset_full_v2 --exclude ingest.log -cf - .
' | tar -C tests/fixtures/golden_dataset_full_v2 -xf -
```

`N=256` gives every layout `z_cap >= 1` (grid `z_cap=1`; datetime/scatter/categorical
`z_cap=2`) — a real coarse mosaic tier on all of them — while the committed tree stays
~0.5 MB. Not byte-stable across regens (the full `pixscope ingest` path stamps
`ingest_timestamp = now()`; the contract gate asserts decoded CONTENT, not bytes) —
same as `calib_small_v2`. See `tests/fixtures/golden_dataset_full_v2/README.md`.

## What it found (2026-06-28 — HISTORICAL; the coarse banding is fixed)

- **FINE tier is correct.** For N=10000: `pos_errors=0`, `color_swaps=0`, max color
  delta = 3/255 (pure lossy-WebP noise). Every cell's thumbnail is in the right
  atlas slot, at the right UV, at the right world position.
- **COARSE tier was banded — FIXED in PR #72** (commit `9755cde`, which also pins
  the fix with a test). z1–z3 coarse tiles were ~32–39% black in a regular
  row-band pattern. Root cause: the coarse compositor built coarse tiles by
  shrinking the **partially-filled mini-atlases**, whose unused slots are black —
  so the padding became bands in the overview. The fix: coarse parents now shrink
  a **spatial render** of each fine tile (cells drawn at their world positions,
  `tiler._build_spatial_render`), never the padded packing sheet — the mini-atlas
  stays the fine tile's served body, so the fine tier was untouched. It only
  appeared with partial tiles, so a full-tile dataset (N=256) was always clean.

## Not yet automated

A headless **render**-and-sample gate (Playwright loads the dataset, screenshots
each zoom level, samples the same oracle) — turns "looks wrong" into a CI failure on
the *renderer* side. The producer-side `verify_bake.py` is the first half.
