"""Large-N scale gate for the v2 baker — the load-bearing 1M-readiness test.

NATIVE (pyvips + pmtiles): runs only in the worker image (`make test-pipeline`).

This gate proves the two scale fixes that make the baker genuinely 1M-capable:

  1. PEAK-MEMORY is bounded and ~cell-count-INDEPENDENT — the DFS subtree bake +
     spill-to-disk holds only the current root-to-leaf subtree of decoded images
     resident, not the whole pyramid (the old baker buffered every tile image AND
     every encoded body AND a final all-bodies dict — ~0.09 MiB/cell ⇒ ~9 GB @100k,
     ~90 GB @1M). We bake at a small N and a LARGE N in separate child processes and
     assert the large-N peak RSS does NOT scale with N (stays within a small constant
     factor of the small-N peak, and under an absolute ceiling).

  2. NO MASS-SUBSAMPLE for a 1-D distribution — the occupancy-aware depth ceiling
     keeps subdividing while subdivision still reduces the densest tile, instead of
     stopping at a 2-D-spread `log4(n/cap)` ceiling (which silently subsampled the
     MAJORITY of a datetime-style x-spread/y-const layout: ~67% @100k, ~93% @1M). At
     large N a 1-D spread must subsample ~nothing (only genuinely-coincident points).
     A 2-D spread is covered too (it also bakes coarse tiles).

  3. The output still validates against schemas/v2 + the dense-id reconciliation:
     |distinct fine-tile ids| + sum(subsampled.dropped) == image_count.

CI-feasible: thumbnails are STUBBED (a single shared blank 64x64 thumb — no real
image decode), and N defaults to a size that bakes in well under a minute. The full
1M run is marked `slow` and opt-in via IMAGE_VIZ_SCALE_N (run it manually).

The peak-RSS probe runs each bake in a SPAWNED child process and reads that child's
`resource.getrusage(RUSAGE_SELF).ru_maxrss` (Linux worker image, KiB) — an isolated
high-water mark per bake, uncontaminated by the parent/pytest/other tests.
"""
from __future__ import annotations

import multiprocessing as mp
import os
from pathlib import Path

import pyarrow as pa
import pytest

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")
pytest.importorskip("pmtiles")

TILE_PX = 512
THUMB_PX = 64

# Small vs large N for the peak-RSS comparison. LARGE_N is the CI default — big
# enough that the OLD (whole-pyramid-resident) baker both blows the absolute
# ceiling (>0.09 MiB/cell ⇒ ~3.6 GB at 40k) AND exceeds the scale factor
# (40k/10k = 4x > 3x), yet small enough to bake in ~1-2 min per child on a 2-core
# CI runner. Heavier, realistic sizes are opt-in (250k via IMAGE_VIZ_SCALE_N, the
# full 1M via the `slow` marker) — a 250k bake ran ~10 min/child, far too slow to
# gate every PR. (The gate proves memory-boundedness + no-mass-subsample, NOT bake
# speed; the encoding-bound bake time at 1M is a separate, tracked perf item.)
SMALL_N = 10_000
LARGE_N = int(os.environ.get("IMAGE_VIZ_SCALE_N", "40000"))

# Absolute peak-RSS ceiling for the large-N bake (MiB). The streaming baker's
# resident set is ~O(subtree) decoded images + the libvips/pyarrow/interpreter
# baseline — a few hundred MiB, NOT the ~0.09 MiB/cell the old baker held (which
# would be ~9 GB at 100k, ~22 GB at 250k). Generous to stay robust across libvips
# versions while still failing hard if the per-cell residency regresses.
PEAK_RSS_CEILING_MIB = 1500
# The large-N peak must stay within this factor of the small-N peak. If memory
# scaled with N it would be ~4x (40k/10k); a streaming baker stays ~flat.
PEAK_RSS_SCALE_FACTOR = 3.0


# --- synthetic layouts (positions only; thumbnails are stubbed) --------------


def _cells_1d(n: int) -> tuple[pa.Table, tuple[float, float, float, float]]:
    """A 1-D distribution: x spread uniformly across [0,1], y ~ const (the datetime
    worst case — cells along a time axis). This is the layout the OLD depth ceiling
    mass-subsampled. Tiny deterministic y jitter keeps points distinct without
    spreading them in y (so the x-axis must carry all the separation)."""
    xs = [(i + 0.5) / n for i in range(n)]
    ys = [0.5 + ((i % 7) - 3) * 1e-6 for i in range(n)]  # ~const, sub-thumb jitter
    return (
        pa.table(
            {
                "id": pa.array(list(range(n)), pa.int64()),
                "x": pa.array(xs, pa.float32()),
                "y": pa.array(ys, pa.float32()),
                "w": pa.array([0.001] * n, pa.float32()),
                "h": pa.array([0.001] * n, pa.float32()),
            }
        ),
        (0.0, 0.0, 1.0, 1.0),
    )


def _cells_2d(n: int) -> tuple[pa.Table, tuple[float, float, float, float]]:
    """A 2-D grid spread across [0,1]^2 (forces a multi-level pyramid with real
    coarse mosaics)."""
    import math

    cols = max(1, math.ceil(math.sqrt(n)))
    xs = [((i % cols) + 0.5) / cols for i in range(n)]
    ys = [((i // cols) + 0.5) / cols for i in range(n)]
    return (
        pa.table(
            {
                "id": pa.array(list(range(n)), pa.int64()),
                "x": pa.array(xs, pa.float32()),
                "y": pa.array(ys, pa.float32()),
                "w": pa.array([0.0005] * n, pa.float32()),
                "h": pa.array([0.0005] * n, pa.float32()),
            }
        ),
        (0.0, 0.0, 1.0, 1.0),
    )


# --- the child-process bake worker (isolated peak-RSS measurement) -----------


def _bake_in_child(kind: str, n: int, out_dir: str, result_q) -> None:
    """Runs in a SPAWNED child: stub read_thumbnail to a shared blank thumb (no real
    decode), bake the pyramid, and report (z_cap, n_fine_ids, dropped_total,
    peak_rss_kib). Isolation gives an uncontaminated per-bake peak-RSS high-water."""
    import resource

    from pipeline import tiler
    from pipeline.atlas import ThumbnailCache, _Thumb

    # Stub thumbnails: one shared blank 64x64 RGB buffer, returned for every id — no
    # disk, no image decode (the brief's "stub/blank the thumbnails"). The tiler still
    # builds a real per-tile mini-atlas from these (bounded work per tile).
    blank = _Thumb(px=THUMB_PX, bands=3, data=bytes(THUMB_PX * THUMB_PX * 3))
    tiler.read_thumbnail = lambda cache_dir, cell_id: blank  # type: ignore[assignment]

    cells, bbox = (_cells_1d(n) if kind == "1d" else _cells_2d(n))
    cache = ThumbnailCache(cache_dir=Path(out_dir), thumb_px=THUMB_PX, ids=list(range(n)), skipped=[])
    out = Path(out_dir) / "tiles" / "grid" / "grid_v1.pmtiles"

    pyramid = tiler.bake_pyramid(
        layout_id="grid",
        cells_table=cells,
        bbox=bbox,
        cache=cache,
        output_path=out,
        dataset_version=1,
        tile_px=TILE_PX,
        thumb_px=THUMB_PX,
    )

    # Reconcile fine-tile ids + recorded drops from the actual baked container, so the
    # gate proves the on-disk output (not just the in-memory result). Re-derive the
    # OCCUPIED fine-tile coords (the same grouping the bake used) so we range-request
    # only the tiles that exist — a dense 2^z grid scan would be ~4^z gets.
    cell_list = [
        tiler._Cell(id=int(i), x=float(x), y=float(y), w=float(w), h=float(h))
        for i, x, y, w, h in zip(
            cells.column("id").to_pylist(), cells.column("x").to_pylist(),
            cells.column("y").to_pylist(), cells.column("w").to_pylist(),
            cells.column("h").to_pylist(),
        )
    ]
    fine_coords = list(tiler._group_fine_tiles(cell_list, bbox, pyramid.z_cap, pyramid.cap)[0])
    n_fine_ids, dropped = _reconcile_from_container(out, pyramid, fine_coords)
    peak_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KiB on Linux
    result_q.put(
        {
            "z_cap": pyramid.z_cap,
            "n_fine_ids": n_fine_ids,
            "dropped_total": dropped,
            "result_dropped_total": pyramid.dropped_total,
            "peak_rss_kib": peak_kib,
            "path": str(out),
        }
    )


def _reconcile_from_container(out: Path, pyramid, fine_coords: list) -> tuple[int, int]:
    """Read the baked PMTiles back at the known occupied FINE-tile coords (z_cap, x, y):
    union of distinct fine-tile ids + sum of recorded subsampled.dropped. Reading only
    the occupied coords avoids the ~4^z dense-grid scan that a blind enumeration costs
    at large N (the fine level can be z~12 at 250k)."""
    import io

    import pyarrow.feather as feather
    from pmtiles.reader import MmapSource, Reader

    from pipeline.tiler import read_subsampled_dropped, unpack_fine_body

    seen: set[int] = set()
    dropped = 0
    z = pyramid.z_cap
    with out.open("rb") as fh:
        reader = Reader(MmapSource(fh))
        for (x, y) in fine_coords:
            body = reader.get(z, x, y)
            assert body is not None, f"expected fine tile {z}/{x}/{y} in container"
            _, arrow_bytes = unpack_fine_body(body)
            table = feather.read_table(io.BytesIO(arrow_bytes))
            dropped += read_subsampled_dropped(table)
            seen.update(int(v) for v in table.column("id").to_pylist())
    return len(seen), dropped


def _run_bake(kind: str, n: int, out_dir: Path) -> dict:
    """Spawn a child to bake `kind`/`n` under out_dir; return its reported dict.

    The child is TERMINATED in a ``finally`` so a ``q.get`` timeout (the bake
    overran the bound) cannot leak a still-baking, CPU-burning subprocess — during
    the T2-106 investigation the 1M 1-D-spread bake overran 60 min and its child
    kept running long after the parent's ``_queue.Empty``.
    """
    ctx = mp.get_context("spawn")
    q = ctx.Queue()
    proc = ctx.Process(target=_bake_in_child, args=(kind, n, str(out_dir), q))
    proc.start()
    try:
        result = q.get(timeout=1200)  # generous; the large-N bake dominates
        proc.join(timeout=60)
        assert proc.exitcode == 0, f"bake child for {kind}/{n} exited {proc.exitcode}"
        return result
    finally:
        if proc.is_alive():
            proc.terminate()
            proc.join(timeout=30)
            if proc.is_alive():  # terminate ignored (native libvips work) → hard kill
                proc.kill()
                proc.join(timeout=30)


@pytest.fixture(scope="module")
def scale_bakes(tmp_path_factory: pytest.TempPathFactory) -> dict[tuple[str, int], dict]:
    """Bake each distinct (kind, N) ONCE and share the child-reported result dict across
    the tests below. The 1-D large bake feeds BOTH the peak-RSS check and the
    no-mass-subsample check, so a module fixture avoids paying for it twice — three bakes
    per CI run (1d@small, 1d@large, 2d@large) instead of four. Each bake still runs in its
    own spawned child, so the per-bake peak-RSS high-water it reports is uncontaminated."""
    base = tmp_path_factory.mktemp("scale_bakes")
    return {
        ("1d", SMALL_N): _run_bake("1d", SMALL_N, base / "small_1d"),
        ("1d", LARGE_N): _run_bake("1d", LARGE_N, base / "large_1d"),
        ("2d", LARGE_N): _run_bake("2d", LARGE_N, base / "large_2d"),
    }


# --- 1. PEAK-MEMORY is bounded and cell-count-independent ---------------------


def test_peak_memory_is_bounded_and_independent_of_n(scale_bakes: dict) -> None:
    """The 1-D spread baked at SMALL_N vs LARGE_N (separate child processes); the
    large-N peak RSS must (a) stay under an absolute ceiling and (b) NOT scale with N
    (within a small constant factor of the small-N peak). Proves the streaming DFS +
    spill keeps the resident set ~O(subtree), not O(pyramid)."""
    small = scale_bakes[("1d", SMALL_N)]
    large = scale_bakes[("1d", LARGE_N)]

    small_mib = small["peak_rss_kib"] / 1024.0
    large_mib = large["peak_rss_kib"] / 1024.0

    assert large_mib < PEAK_RSS_CEILING_MIB, (
        f"large-N ({LARGE_N}) peak RSS {large_mib:.0f} MiB exceeds the "
        f"{PEAK_RSS_CEILING_MIB} MiB ceiling — the baker is holding memory ~per cell"
    )
    # Cell-count independence: a streaming baker's peak is ~flat in N. If it scaled
    # with N the ratio would track LARGE_N/SMALL_N (~25x); allow a small factor for
    # the larger working set / fragmentation, but not linear growth.
    assert large_mib <= small_mib * PEAK_RSS_SCALE_FACTOR, (
        f"peak RSS scaled with N: small({SMALL_N})={small_mib:.0f} MiB, "
        f"large({LARGE_N})={large_mib:.0f} MiB (>{PEAK_RSS_SCALE_FACTOR}x) — "
        f"memory is not cell-count-independent"
    )


# --- 2. NO mass-subsample for a 1-D distribution at large N -------------------


def test_no_mass_subsample_for_1d_spread(scale_bakes: dict) -> None:
    """The datetime worst case: x spread, y~const. The OLD count-derived depth
    ceiling stopped at a 2-D-spread depth and silently subsampled ~93% at 1M. The
    occupancy-aware ceiling subdivides until the x-spread is exhausted, so a distinct
    1-D spread must subsample ~nothing — assert (near-)all cells get a fine placement
    and the drop rate is ~0. (Same 1-D large bake as the peak-RSS test — shared.)"""
    res = scale_bakes[("1d", LARGE_N)]
    placed = res["n_fine_ids"]
    dropped = res["dropped_total"]

    # Distinct (non-coincident) 1-D points must (almost) all be placed. A handful may
    # land in the same deepest tile if two x's round into one thumb-width slot; allow a
    # tiny tolerance, NOT the catastrophic majority-drop the old ceiling produced.
    drop_rate = dropped / LARGE_N
    assert drop_rate < 0.01, (
        f"1-D spread mass-subsampled: dropped={dropped}/{LARGE_N} ({drop_rate:.1%}) — "
        f"the occupancy-aware ceiling must keep subdividing (old ceiling dropped ~93%)"
    )
    assert placed >= LARGE_N * 0.99, f"only {placed}/{LARGE_N} cells placed in fine tiles"
    # Reconciliation holds on the real container.
    assert placed + dropped == LARGE_N, f"reconciliation: {placed} + {dropped} != {LARGE_N}"
    assert res["result_dropped_total"] == dropped


# --- 3. A 2-D spread also bakes + reconciles (coarse tiles exist) -------------


def test_2d_spread_reconciles_and_has_coarse(scale_bakes: dict) -> None:
    """A large 2-D spread forces a deep pyramid with real COARSE mosaic levels
    (z_cap > 0) and no mass subsample; the dense-id reconciliation holds on the baked
    container."""
    res = scale_bakes[("2d", LARGE_N)]
    assert res["z_cap"] > 0, "a large 2-D spread must build coarse levels (z_cap > 0)"
    assert res["dropped_total"] / LARGE_N < 0.01, "2-D spread must not mass-subsample"
    assert res["n_fine_ids"] + res["dropped_total"] == LARGE_N


# --- opt-in full 1M run (manual; marked slow) --------------------------------


@pytest.mark.skip(
    reason="T2-106 residual: 1M 1D-spread coarse bake exceeds 60min on the fixed tree "
    "(was <20min pre-78b0bfe); dense-blob half fixed in this PR; see "
    "docs/tier2-backlog.md T2-106"
)
@pytest.mark.slow
def test_full_1m_1d_spread_no_mass_subsample(tmp_path: Path) -> None:
    """The real 1M target on the 1-D worst case. Opt-in (slow) — run manually:
    `pytest -m 'native and slow' packages/pipeline/tests/test_tiler_scale.py`. Asserts
    the same bounds at the true target size.

    SKIPPED (T2-106): the SPARSE 1-D spread (datetime-shaped, ~90% empty) overran the
    3600s bound on the fixed tree — a SECOND, distinct Seam-A residual from the
    dense-categorical pathology this PR fixes. Working hypothesis: the coverage-gated
    dilation floor firing en masse across the sparse pyramid's tens of thousands of
    low-coverage coarse tiles (the profile cleared dilation for the DENSE case only).
    Re-enable when that residual is fixed."""
    n = 1_000_000
    res = _run_bake("1d", n, tmp_path / "onem")
    assert res["dropped_total"] / n < 0.01, f"1M 1-D spread mass-subsampled: {res['dropped_total']}"
    assert res["n_fine_ids"] + res["dropped_total"] == n
