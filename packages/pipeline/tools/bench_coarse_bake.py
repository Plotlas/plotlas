"""Manual benchmark for the coarse-tier bake (T2-106 investigation).

NOT a pytest test — a standalone reproduction/measurement harness for the
dense-categorical coarse-compositor regression. Drives the REAL CategoricalLayout
on synthetic metadata (a "kingdom" extreme-skew distribution vs a "supercategory"
moderate-spread control), then bakes each through ``tiler.bake_pyramid`` with
STUBBED thumbnails (no image decode), timing the bake and reporting the
coverage-gated dilation-floor firing counts.

Run in the worker image (host Python is gated):

    docker run --rm -v ${PWD}:/repo -w /repo image-viz-worker \
        python -u packages/pipeline/tools/bench_coarse_bake.py N [profile] [covKing covSuper]

    profile        cProfile the kingdom bake, print top-N frames by tottime.
    covKing covSup override MIN_COARSE_COVERAGE per shape (e.g. "-1 -1" = never
                   dilate, the A/B baseline; default = the shipped value for both).
"""
from __future__ import annotations

import cProfile
import io
import pstats
import sys
import time
from pathlib import Path

import pyarrow as pa

from pipeline import tiler
from pipeline.atlas import ThumbnailCache, _Thumb
from pipeline.layout_plugins.base import ColumnRoles, RoleEntry
from pipeline.layout_plugins.categorical import CategoricalLayout

TILE_PX, THUMB_PX = 512, 64

# Extreme skew, 7 categories (real iNat kingdom shape: one dominant ~78%).
KINGDOM = {"Animalia": 0.78, "Plantae": 0.14, "Fungi": 0.05, "Chromista": 0.02,
           "Protozoa": 0.007, "Bacteria": 0.002, "Viruses": 0.001}
# Moderate spread, 14 categories (real iNat supercategory shape).
SUPERCATEGORY = {"Insecta": 0.28, "Aves": 0.17, "Plantae": 0.14, "Reptilia": 0.08,
                 "Mammalia": 0.07, "Amphibia": 0.05, "Mollusca": 0.05, "Fungi": 0.045,
                 "Arachnida": 0.035, "Actinopterygii": 0.03, "Animalia": 0.02,
                 "Chromista": 0.015, "Protozoa": 0.01, "Other": 0.005}


def _meta(n: int, dist: dict[str, float]) -> pa.Table:
    keys = list(dist)
    cats: list[str] = []
    for k, w in dist.items():
        cats.extend([k] * round(n * w))
    cats = (cats + [keys[0]] * n)[:n]
    return pa.table({"id": pa.array(list(range(n)), pa.int64()),
                     "cat": pa.array(cats, pa.string())})


def _roles() -> ColumnRoles:
    return ColumnRoles(filename=RoleEntry("filename", "File"), datetime=None,
                       categorical=[RoleEntry("cat", "Category")], tag=[],
                       freeform=[], embedding=None, scatter=[])


def _cells(n: int, dist: dict) -> tuple[pa.Table, tuple[float, float, float, float]]:
    atlas = ThumbnailCache(cache_dir=Path("/tmp/c"), thumb_px=THUMB_PX, ids=list(range(n)), skipped=[])
    r = CategoricalLayout().compute(_meta(n, dist), _roles(), atlas, {"entry_index": 0})
    return r.cells, r.bbox


def _bake(name: str, cells: pa.Table, bbox, out_dir: Path) -> tuple[float, object, int]:
    blank = _Thumb(px=THUMB_PX, bands=3, data=bytes(THUMB_PX * THUMB_PX * 3))
    tiler.read_thumbnail = lambda cd, cid: blank  # type: ignore[assignment]
    cache = ThumbnailCache(cache_dir=out_dir, thumb_px=THUMB_PX, ids=list(range(cells.num_rows)), skipped=[])
    out = out_dir / f"{name}.pmtiles"
    out.parent.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    pyr = tiler.bake_pyramid(layout_id=name, cells_table=cells, bbox=bbox, cache=cache,
                             output_path=out, dataset_version=1, tile_px=TILE_PX, thumb_px=THUMB_PX)
    return time.perf_counter() - t0, pyr, out.stat().st_size


def main() -> None:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    prof = "profile" in sys.argv[2:]
    tail = [a for a in sys.argv[2:] if a != "profile"]
    covs = {"kingdom": None, "supercategory": None}
    if len(tail) >= 2:
        covs["kingdom"], covs["supercategory"] = float(tail[0]), float(tail[1])
    # getattr so this same harness runs against a PRE-Seam-A baseline tiler (78b0bfe~1),
    # which has no MIN_COARSE_COVERAGE — enables the whole-file A/B.
    shipped = getattr(tiler, "MIN_COARSE_COVERAGE", None)
    print(f"N={n} shipped MIN_COARSE_COVERAGE={shipped}", flush=True)
    for name, dist in (("kingdom", KINGDOM), ("supercategory", SUPERCATEGORY)):
        cells, bbox = _cells(n, dist)
        if shipped is not None:
            tiler.MIN_COARSE_COVERAGE = shipped if covs[name] is None else covs[name]
        od = Path("/tmp/bench") / f"{name}_{n}"
        if prof and name == "kingdom":
            pr = cProfile.Profile(); pr.enable()
            dt, pyr, size = _bake(name, cells, bbox, od)
            pr.disable()
            s = io.StringIO(); pstats.Stats(pr, stream=s).sort_stats("tottime").print_stats(25)
            print(s.getvalue(), flush=True)
        else:
            dt, pyr, size = _bake(name, cells, bbox, od)
        cd = getattr(pyr, "coarse_dilated", -1)
        cur_cov = getattr(tiler, "MIN_COARSE_COVERAGE", None)
        print(f"[{name}] N={n} cov={cur_cov} time={dt:.1f}s z_cap={pyr.z_cap} "
              f"bytes={size / 1e6:.1f}MB dilated={cd} rate={size / 1e6 / max(dt, 1e-9):.2f}MB/s", flush=True)


if __name__ == "__main__":
    main()
