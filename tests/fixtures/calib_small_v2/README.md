# `calib_small_v2` — the render-gate's multi-level calibration fixture

A **small, committed, multi-level** v2 dataset tree (schemas/v2, decision D-33) that
exists to give the headless render gate (`packages/frontend/e2e/render-gate.spec.ts`,
ledger **T2-39**) a dataset whose **coarse tier actually executes**.

## Why it exists (and why `golden_dataset_v2` is not enough)

`golden_dataset_v2` bakes to `z_cap = 0` — a single all-fine level, no coarse mosaic
band. The v2 renderer's coarse tier (the mosaic overview drawn while fine tiles
stream, and the parent-fallback that keeps the view never-grey) therefore **never
runs** when the gate points at it. Three visual regressions in this repo's history
shipped past green unit tests precisely because nothing rendered the coarse band and
sampled it. This fixture is the fix: it bakes to `z_cap = 1`, so the gate exercises
a real coarse level (`z = 0`, mosaic WebP overview) **and** a fine level (`z = 1`,
mini-atlas WebP + per-cell Arrow records).

## What it is

Produced by the calibration recipe (`packages/pipeline/tools/calibration/`): each of
the **N = 256** source images is a solid colour encoding its grid position, so the
baked pyramid is verifiable pixel-exactly against a position→colour oracle (a human
sees a smooth 2-D gradient; a misplaced tile is an obvious colour discontinuity;
coarse padding bands read as black). N = 256 was chosen deliberately:

- **N = 256 ⇒ a perfect 16×16 grid** (GridLayout uses `cols = ceil(sqrt(N))`), which
  maps to **exactly-full** `z = 1` fine tiles (four tiles, each an 8×8 = 64-cell
  quadrant = the fine-tile cap). The `z = 0` coarse mosaic is therefore **fully
  filled — zero black padding** (`verify_bake.py`: `avg_black_frac = 0.000`), the
  cleanest possible "renders real content" / "never-grey" signal for the gate.
  Smaller N (e.g. 100) gives partially-filled fine tiles and a coarse mosaic with
  black padding regions — a noisier gate signal.
- Any `N > 64` (one z=0 tile overflows the 64-cell cap) already yields `z_cap = 1`;
  256 is the smallest N that ALSO fills the fine tiles exactly, and it stays tiny
  (see size below).

Pyramid (from `layout_manifest.json`): `z_cap = 1`, `levels = [{z:0, tiles:1},
{z:1, tiles:4}]`, `cap = 64`, `thumb_px = 64`, `tile_px = 512`. A real `image_ref`
detail tier is baked under the VERSION-STAMPED `detail/v{version}/{id}.webp` (T2-46;
256 files) — the authed detail-fetch assertion (render-gate.spec §3a, the browser-tier
net for the PR #74 fix) queries the un-versioned `/detail/{id}.webp` route, which the
API resolves to the manifest's current `detail.path_prefix` (`detail/v1/`).

The `z = 0` coarse mosaic is an RGBA tile with an ALPHA pad (Seam A / b1,
T2-61/T2-40/T2-68): pad pixels are transparent, cell pixels opaque. Because N = 256
fills the fine tiles exactly, the coarse mosaic is fully OPAQUE content with zero
transparent pad (`verify_bake.py`: `avg_transparent_frac = 0.000`) — the cleanest
"renders real content" signal, now composited over the canvas ground rather than an
opaque black pad. A sparse dataset's coarse tiles would carry a large transparent
fraction (legitimate emptiness), which the re-expressed `verify_bake.py` reports and
does NOT flag as banding.

**No tag role**: the calibration generator is images-only (no `--metadata`), so
`metadata.parquet` carries only `id` + `filename`. The render-gate's tag assertion
(T2-73's render-gate half) is therefore **skipped** here — it is not wired, by design
(the recipe emits no tag column, and the brief forbids extending the generator).

## Committed size

**~404 KB total** (tiles ~64 KB, detail ~336 KB across 256 solid-colour WebPs,
metadata ~4 KB) — comfortably under the ~5 MB fixture budget.

## Regenerate

Run inside the **worker** image (needs libvips + pmtiles). The bake goes through the
REAL `pixscope ingest` pipeline, so the tree matches exactly what the pipeline emits.
Bake to the container's internal `/data` (a cross-mount `os.rename` at commit fails on
a bind-mounted host FS — Windows especially), then copy the tree out, **excluding the
runtime `ingest.log`** (a per-job log, not part of the served dataset contract):

```sh
docker build -f docker/Dockerfile.worker -t image-viz-worker .
docker run --rm image-viz-worker sh -c '
  python tools/calibration/generate_calib.py 256 /tmp/calib/images
  pixscope ingest --images /tmp/calib/images --dataset-id calib_small_v2 \
                  --layout grid --sync --owner ci
  # (optional) prove the bake against the position-colour oracle:
  python tools/calibration/verify_bake.py calib_small_v2 256
  tar -C /data/datasets/calib_small_v2 --exclude ingest.log -cf - .
' | tar -C tests/fixtures/calib_small_v2 -xf -
```

**Not byte-stable across regens.** Unlike the `golden_dataset_*_v2` fixtures (baked
via `build_fixture.py`, which pins the manifest `ingest_timestamp` and the PMTiles
gzip MTIME for a regenerate-then-diff guard), this fixture goes through the full
`pixscope ingest` path, which stamps `ingest_timestamp = now()` into the manifest and
does not pin the container gzip MTIME. That is fine here: the render gate asserts
rendered CONTENT (coarse band present, level sharpening, bounded residency,
never-grey, an authed detail 200), never committed bytes, and there is no
regen-diff guard on this tree. Decoded content (ids, positions, colours, manifest
shape) is reproducible regardless.
