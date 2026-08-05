# `golden_dataset_full_v2` — the comprehensive all-layouts contract fixture

A **small, committed, ALL-layouts** v2 dataset tree (schemas/v2, decision D-33) that
exercises the **full contract surface** the minimal `golden_dataset_v2` cannot:
grid + datetime + scatter + geographic + categorical×2 + a tags sidecar + a per-layout
**position table** (v2.2, `positions_ref`), **every layout baked to `z_cap >= 1`** (a real
coarse mosaic tier), with the scatter/geographic unplaced strips and empty/multi-value tag
edge cases. Validated by `tests/contract/test_fixture_conforms_schemas.py`.

## Why it exists (and why the other fixtures are not enough)

- `golden_dataset_v2` is the **minimal grid-only unit fixture** the api/frontend tests
  pin (exact `image_count=10`, `layout_ids=["grid"]`, tag bytes, detail path). It is
  all-fine (`z_cap=0`), single-layout, AND baked pre-2.2 (no `positions_ref`), so it
  validates almost none of the contract: no coarse tier, no datetime/scatter/categorical
  records, no multi-entry family, no robust-fit / unplaced-strip path, no position table.
  It is deliberately **left untouched** (retained as the minimal fixture AND as the
  renderer's graceful-absence proof — a dataset with no position table must still pick at
  the fine tier; a future follow-up can retire/rename it once its consumers migrate).
- `calib_small_v2` gives the render gate a multi-level pyramid, but it is **images-only**
  (no metadata, one layout) and also pre-2.2 (no `positions_ref` — the render-gate's
  graceful-absence proof in CI).

This fixture fills the gap: one deterministic dataset that drives **every layout type**
and **every role**, so the contract gate genuinely exercises the coarse branch, the
non-grid cell records, the tags sidecar, the per-layout position table, and the dense-id
reconciliation across a real multi-layout bake.

## What it is

Produced by the calibration recipe (`packages/pipeline/tools/calibration/`,
`generate_calib.py --emit-metadata`) through the **REAL `pixscope ingest` pipeline**,
so the tree matches exactly what the pipeline emits. **N = 256** position-color
calibration images (the grid layout stays pixel-verifiable against the color oracle)
+ a synthetic `metadata.csv` covering every role. Deterministic — every metadata field
is a pure function of the cell index (no RNG, no clock).

### Layouts (from `layout_manifest.json`)

| layout_id            | type        | z_cap | levels (z: tiles)         | positions_ref                        |
|----------------------|-------------|-------|---------------------------|--------------------------------------|
| `grid`               | grid        | 1     | 0:1, 1:4                  | `positions/grid_v1.arrow`            |
| `datetime`           | datetime    | 2     | 0:1, 1:4, 2:16            | `positions/datetime_v1.arrow`        |
| `scatter`            | scatter     | 3     | 0:1, 1:4, 2:8, 3:11       | `positions/scatter_v1.arrow`         |
| `categorical_group`  | categorical | 2     | 0:1, 1:4, 2:16            | `positions/categorical_group_v1.arrow`  |
| `categorical_bucket` | categorical | 2     | 0:1, 1:4, 2:16            | `positions/categorical_bucket_v1.arrow` |
| `geographic`         | geographic  | 2     | 0:1, 1:4, 2:11           | `positions/geographic_v1.arrow`      |

Every layout has `z_cap >= 1` → a real **coarse mosaic tier** (`z < z_cap`) plus the
fine mini-atlas tier. The `datetime` layout is a **WRAPPED, width-bound** case (D-36 seam
H2): its 256 daily dates bin to 9 months, 31 deep, in a box shortened to `STRIP_Y_MIN` by the
U1 undated-strip reservation; the `k` solve then wraps each bin into a **`k = 2`**-image-wide
block, 16 rows deep, which trades the stack depth for width until the band binds — so
`p_c = 0.0427374533` comes from the WIDTH term. Its nine bins are contiguous months, so its
blocks sit one `(k + gutter)`-cell pitch apart (in general the gap is one such pitch **per
shortest interval** — `x` is linear in seconds, so buckets `m` intervals apart sit `m` of them
apart), and it occupies `x ∈ [0.04321, 0.95679]`, essentially the whole box, with `range`
ending at `0.874525093`: the last bin's block of 2 cells sits to the RIGHT of that last tick,
and it is the **block edge**, not the line, that reaches `1-margin`.

The regime has moved twice, so read the label rather than assuming: **columns-bind** before
H1, **packed/stack-bound** between H1 and H2 (`x ∈ [0.0268, 0.3004]`, `range` ending
`0.2872`, span `0.247238302`), **width-bound** now. The gate asserts the geometry itself —
`range[0]` must sit `0.5·p_c − side/2` to the **left** of the first drawn image (H2 put the
tick on the block's left EDGE, so the line is no longer contained in the bbox at that end),
`range[1]` must sit inside `bbox_exact[2]`, the line must stop short of the band, and the
SPAN must be the committed `0.834525093` — not merely that `range` is an ordered pair. On
this fixture that lower gap is `0.5×0.0427374533 − 0.036326837/2 = 0.003205309`. It is
`(0.5 − fill/2)·p_c` **only because nothing caps the side here**; where the `2·margin` or
the tightest-real-bin-spacing cap binds the two differ (measured 5.6× on a
two-cells-one-second-apart bake).

The span literal is the load-bearing one: the containment checks are one-sided and a `range`
reported over the cell EDGES instead of the block LEFT EDGES is symmetric, so it would pass
them while mis-placing every tick by half a cell.

Since **v2.7** (D-36 seam H3) that axis also carries `interval: {"kind": "month", "step": 1}`
— the ladder rung the bake bucketed at, which is the same nine-contiguous-month bucketing the
paragraph above describes, so the gate's literal and the bin count corroborate each other. The
H3 re-bake moved **only `layout_manifest.json`** (the version stamp, the new `interval` block,
and the `ingest_timestamp` drift the section below documents): no geometry changed, and every
`positions/*.arrow`, `tiles/**`, `metadata.parquet`, `tags/*` and `cover.webp` byte is
identical to the H2 bake — verified by `sha256sum` over the whole tree, 2026-07-29. **Trade-off to know about:** this fixture
was the columns-bind case before H1 and is the only end-to-end datetime tree in the repo, so
that branch — which every live 2.5 dataset on disk is still in — has no cover above
`packages/pipeline/tests/test_datetime_layout.py` (see
`test_width_bound_case_fills_the_band_to_the_block_edge`, which is that seam's successor).
Its `z_cap`/tile counts are unchanged across the H2 re-bake (`z_cap=2`, levels 0:1, 1:4, 2:16)
— note that is because n=256 resolves at `z=2`, NOT because the layout's cell-size depth
ceiling is unchanged. `tile_px=512`, `thumb_px=64`, `cap=64`.
`manifest_version` is
`2.7` — **it was stale at `2.5` here through the 2.6 re-bake; read the committed file, not
this line, if they ever disagree again**. (The v2.7 MINOR added the datetime axis's
`interval` bucketing rung — D-36 seam H3, T2-142; the v2.6 MINOR added the per-layout
`missing_count` — D-36 seam U1, T2-140; the v2.5 MINOR added `bbox_exact` + the per-layout `annotations`; the v2.4 MINOR added the `"geographic"` layout type + the `options.projection` echo
— D-35 Seam G2; the v2.3 MINOR added the optional per-layout `options` scatter-knob echo —
the calib scatter uses default knobs so it carries no `options`; the v2.2 MINOR added
`positions_ref`). The `geographic` layout echoes `options: {projection: "equirectangular",
overlap: "overdraw"}` (the applied projection — the map explainer + T2-86 underlay read it).
**Every** layout carries `missing_count` (the v2.6 MINOR, T2-140 / D-36 seam U1) — it is
emitted unconditionally, `0` included, so the fixture pins the always-emit rule as well as
the values. `scatter` and `geographic` carry `9`: every 29th of the 256 cells has no
coordinate, so nine land in each family's unplaced strip. `grid` and the two `categorical`
layouts place everything and `datetime` dates everything, so those four carry `0` — a
positive "counted, found none", never an absent key (an absent key means a pre-2.6 entry).
The `scatter` layout bakes to `z_cap=3`: its **wide sparse tail** (see
below) compresses the dense bulk under the median-centred, unclipped aspect fit (Seam
S1, T2-35), so the deepest fine tile in-tile **subsamples** at the production `cap=64`
(the deep-dive's documented cap-64 behaviour) — every dropped id keeps its dense
numbering + position table row and reconciles (`|fine ids| + dropped == 256`).

### Position tables (`positions/*.arrow`, T2-66 / T2-48, v2.2)

Each layout carries an uncompressed Arrow (D-29) position table of its per-cell
`(x, y, w, h)` world rects — four `float32` columns, **no id column** (the row index
IS the dense cell id, 0..255). The renderer scans it to hit-test a cell at ANY zoom
(the coarse tier draws mosaic quads with no per-cell geometry to pick). Row count ==
`image_count` (256). ~5 KB each here; ~16 MB/layout at 1M.

### Roles / synthetic metadata (`metadata.parquet`, `image_count = 256`)

Every row also carries the native pixel **`width`/`height`** (nullable int32, Seam D2 —
here a constant 64×64, the calib image size); they are not a role, just the header probe
the pipeline records alongside `id`/`filename`.

- **filename** — join key (`NNNNN.png`, D-25 id order).
- **datetime** (`captured`, iso8601) — one calendar day per cell (a real multi-month
  span → a non-degenerate datetime pyramid).
- **scatter** (`sx`/`sy`) — a clustered dense bulk + a **wide sparse tail** (exercises
  the median-centred, unclipped aspect fit — Seam S1 — and its cap-64 deep-tile
  subsampling) + **9 null-coordinate rows** → the scatter layout's **unplaced strip**
  (placed there, never dropped; every id reconciles).
- **geographic** (`lon`/`lat`, D-35 Seam G2) — real-world coordinates clustered around a
  handful of cities (a non-degenerate map that subdivides to a coarse tier) + a few
  high-latitude (~78°) cells (valid under the baked **equirectangular** projection, which
  is valid to the poles) + null-coordinate rows → the geographic layout's **unplaced strip**.
  Baked with the default projection; the mercator `|lat| <= 85.051129` fail-fast is
  unit-tested (`test_geographic.py`), NOT baked here.
- **categorical** — two columns of **different cardinality**: `group` (3 values) and
  `bucket` (12 values) → two distinct categorical layouts.
- **tag** (`tags`, `|`-delimited) — includes **no-tag cells** (empty CSV value → a
  null/empty tag list; `n % 7 == 0`) and **multi-value cells** (even ids). Projected to
  the `tags/tags_v1.arrow` sidecar (D-14, uncompressed per D-29).
- **freeform** (`caption`) — display-only.

**No detail tier** (`--detail-tier skip`): keeps the committed tree small (the detail
originals would dominate). The `detail` manifest block and cell `detail_ref`s are
therefore absent/null — valid per schemas/v2 (the detail tier is optional).

### Library-card cover (`cover.webp`, T2-55)

The pipeline writes an **unversioned `cover.webp`** at the dataset root — the **grid**
pyramid's z=0 whole-world overview WebP (grid is always baked, D-25) — for the Library
card. It is NOT a schemas/v2 asset (a cosmetic thumbnail, no manifest field); the
contract gate asserts it equals the grid z=0 tile's bytes here, and that the minimal
`golden_dataset_v2` (baked before this feature) has none (the API's 404 + the card's
flat-block fallback are pinned against that absence). ~8 KB.

## Committed size

**~0.6 MB total**: six PMTiles containers (grid + datetime + scatter + the two
categorical + geographic, ~40–120 KB each), `metadata.parquet` ~18 KB,
`tags/tags_v1.arrow` ~8 KB, six `positions/*.arrow` ~5 KB each, `cover.webp` ~8 KB —
well under the ~5 MB fixture budget.

## Regenerate

Run inside the **worker** image (needs libvips + pmtiles). The bake goes through the
REAL `pixscope ingest` pipeline. `DATA_ROOT` must be set so the manifest records
root-relative asset refs (the pipeline writes `{output_root}/{ds_id}/…`; with DATA_ROOT
unset the CLI defaults to a RELATIVE `./datasets`). Bake to the container's internal
`/data`, then copy the tree out **excluding the runtime `ingest.log`** (a per-job log,
not part of the served dataset contract):

```sh
docker build -f docker/Dockerfile.worker -t image-viz-worker .
docker run --rm -e DATA_ROOT=/data image-viz-worker sh -c '
  set -e
  python tools/calibration/generate_calib.py 256 /tmp/calib/images --emit-metadata >&2 &&
  pixscope ingest --images /tmp/calib/images \
                  --metadata /tmp/calib/metadata.csv \
                  --column-roles /tmp/calib/column_roles.json \
                  --layout grid,datetime,scatter,categorical,geographic --detail-tier skip \
                  --dataset-id golden_dataset_full_v2 --sync --owner ci >&2 &&
  tar -C /data/datasets/golden_dataset_full_v2 --exclude ingest.log --exclude progress.json -cf - .
' 2>/dev/null | tar -C tests/fixtures/golden_dataset_full_v2 -xf -
```

> **The `>&2` redirects are load-bearing too** (found running this recipe on 2026-07-28,
> D-36 seam H2). `generate_calib.py` and `pixscope ingest` both print a summary line to
> **stdout**, and stdout is the pipe carrying the tar. Without them the archive starts with
> ~450 bytes of prose, GNU tar cannot resync to a 512-byte header boundary, and the extract
> dies with `This does not look like a tar archive` / `A lone zero block at 452` — having
> written nothing, so the committed fixture survives, but the regen silently does not happen.
> Sending those two commands' stdout to stderr keeps every informative line visible while
> leaving stdout for the archive; the outer `2>/dev/null` is only to keep the terminal quiet
> and can be dropped if you want the bake log.

> **The `set -e` / `&&` chaining is load-bearing — do not "simplify" it back to newlines.**
> The commands used to be newline-separated, so a failed `pixscope ingest` still reached the
> `tar`, which streamed a PARTIAL tree. `tar -x` overwrites what is in the archive and leaves
> everything else, so a failed regen would replace `layout_manifest.json` with one missing the
> failed layout while orphan `tiles/<layout>/` and `positions/<layout>_v1.arrow` stayed on
> disk — a corrupted committed fixture, caught by CI only *after* the operator clobbered it.
> Found by the B1 (T2-143) review, 2026-07-27, which reproduced it end to end. With the chain,
> a failed ingest leaves the committed fixture untouched.

**Byte-stable across regens EXCEPT the manifest timestamp.** The `pixscope ingest` path
stamps `ingest_timestamp = now()` into `layout_manifest.json`, but the tiler writes every
PMTiles container under `_deterministic_gzip` (which pins the gzip MTIME the PMTiles writer
would otherwise stamp from `now()`), so a full re-bake leaves the grid / datetime / scatter /
categorical / geographic PMTiles, the `positions/*.arrow` tables, `metadata.parquet`, and
`cover.webp` **byte-identical** — only that one `ingest_timestamp` field drifts (verified: a
re-ingest through the real pipeline changes exactly `layout_manifest.json`, and reverting its
timestamp yields a zero diff). This is what makes the T2-126 refresh + the D-35 G2 geographic
add attribute cleanly at the byte level. The container bytes are still tied to a GIVEN
libvips/libwebp/pmtiles/pyarrow toolchain (the worker image); the contract gate asserts decoded
**CONTENT** (layout set, z_cap, cell records, dense-id reconciliation, tags, position tables),
not committed bytes, so it stays robust if those encoder/format library versions ever change.
