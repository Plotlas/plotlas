"""Build the committed v2 structural fixtures under tests/fixtures/ — schemas/v2,
decision D-33 (the renderer-rework MAJOR contract).

Two ~10-cell, schemas/v2-valid `/datasets/{ds_id}/` trees the architect-owned
contract gate (and the producer seam) validate, independently of a full ingest:

  * golden_dataset_v2/             — images + a metadata source (filename + tag roles)
  * golden_dataset_images_only_v2/ — the IMAGES-FIRST FLOOR: images only, no
    column_roles, no tag sidecar, no `source` provenance (decision D-25)

Both are the same image set; they differ only on the OPTIONAL metadata surface, so
the contract gate exercises both the metadata-present and images-only paths.

COEXISTENCE NOTE (migration wave): the v1.1 fixtures `golden_dataset/` and
`golden_dataset_images_only/` are KEPT alongside these (frozen, committed) so the
still-v1 CONSUMER tests (api `test_read_serve`, frontend `client_*` / `ui_*`) keep
passing until the API + frontend seams migrate. This is the transitional
coexistence the rework constraints permit; the v1.1 fixtures + their `_v2` siblings
are deleted when the consumer seams land. The v1.1 builder is retired with the
quadfeather tiler, so the v1.1 fixtures are regenerable only from git history.

NB: the v1 golden fixtures are INTENTIONALLY FROZEN — this builder no longer
regenerates them (it writes only the `*_v2` trees), and they are SLATED FOR
DELETION once the api/frontend seams migrate to v2. Do not "fix" them to v2.

v2 (decision D-33): each layout owns ONE PMTiles spatial-tile-pyramid container
(tiles/{layout_id}/{layout_id}_v{version}.pmtiles) holding the deepest FINE
mini-atlas tile (cell records + packed thumbnails) and any COARSE mosaic parents.
There is no shared atlas/ tree and no per-LOD cells/.../lod{n}/ tree.

CONTRACT FOR THIS BUILDER:
  * Uses the real producer (pipeline.tiler.bake_pyramid + pipeline.atlas + the REAL
    emitter pipeline.manifest.write_manifest) so the fixture matches exactly what the
    pipeline emits — plus pyvips. Needs the worker image (libvips + pmtiles).
  * Deterministic: coordinates are computed and the ingest timestamp is INJECTED
    into manifest.write_manifest (its new ingest_timestamp param) so the committed
    trees regenerate byte-stable even though the emitter normally stamps `now()`.
    Going through the real emitter means the LEAN contract gate exercises the
    production manifest assembler (detail / column_roles / tags derivation), not a
    hand-rolled dict — closing the "gate validates a hand-assembled manifest" hole.

    The `.pmtiles` containers are byte-stable across regens too: the tiler writes
    them under pipeline.tiler._deterministic_gzip, which pins the gzip MTIME the
    PMTiles writer would otherwise stamp from `now()` into the root directory +
    metadata headers (that MTIME was the SOLE source of container drift — tile
    bodies/WebP/Arrow were already deterministic). Byte-stability holds for a GIVEN
    libvips/libwebp/pmtiles/pyarrow toolchain — i.e. the worker image. CONTENT
    (decoded tiles, ids, manifest, parquet, tags) is reproducible regardless; raw
    container bytes can still shift if those encoder/format library versions change,
    which is why the contract gate asserts decoded CONTENT, not bytes.

    NB: the `.pmtiles` currently COMMITTED were baked BEFORE the _deterministic_gzip
    fix, so they carry stale random gzip MTIMEs and will NOT byte-match a fresh
    regen (the diff is purely those header timestamps; content is identical). Re-bake
    + commit them once (`make build-fixture`) to make regen-vs-committed byte-stable
    and unlock a regenerate-then-diff guard; until then "byte-stable" means
    regen-vs-regen.

THREE fixtures (all images-first, D-25):
  * golden_dataset_v2             — 10 cells, metadata (filename + tag roles), single
                                    FINE level (z_cap=0) + a detail block.
  * golden_dataset_images_only_v2 — 10 cells, images only, single FINE level.
  * golden_dataset_dense_v2       — DEGENERATE: TWO far-apart coincident clusters, so
                                    the tiler subdivides to z_cap > 0 to SEPARATE them
                                    (real COARSE mosaic tiles) AND in-tile subsamples
                                    the over-cap cluster (records subsampled.dropped).
                                    Makes the lean gate's coarse branch + the
                                    reconciled dense-id invariant non-hollow under the
                                    occupancy-aware depth ceiling, and carries a detail
                                    block.

Regenerate (canonical):

    make build-fixture
    # equivalently:
    docker build -f docker/Dockerfile.worker -t image-viz-worker .
    docker run --rm -v "$PWD":/repo -w /repo image-viz-worker \
        python tests/fixtures/build_fixture.py
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.parquet as pq
import pyvips

from pipeline.atlas import decode_thumbnails
from pipeline.layout_plugins.base import ColumnRoles, LayoutResult
from pipeline.manifest import write_manifest
from pipeline.tiler import bake_pyramid

# --- fixture parameters (all deterministic) ---------------------------------
DATASET_ID = "golden_dataset_v2"
DATASET_ID_IMAGES_ONLY = "golden_dataset_images_only_v2"
DATASET_ID_DENSE = "golden_dataset_dense_v2"
DATASET_VERSION = 1
LAYOUT_ID = "grid"
N = 10                       # cells
GX, GY = 5, 2               # 5x2 arrangement in normalized space
W = H = 0.15                # cell footprint in normalized world units
THUMB_PX = 64               # v2 mid-tier thumbnail edge (env default)
TILE_PX = 512
# Dense fixture: TWO coincident clusters far apart in [0,1]^2, so the tiler must
# subdivide to z_cap > 0 (real coarse mosaics) to SEPARATE them, and the larger
# cluster (> cap) is genuinely coincident → its deepest fine tile in-tile subsamples
# (records subsampled.dropped). This shape exercises BOTH the coarse-mosaic branch
# and the subsample reconciliation under the OCCUPANCY-AWARE depth ceiling (which
# stops as soon as a cluster stops separating — see tiler._choose_z_max — instead of
# the old count-derived margin that gave a single fully-coincident blob z_cap > 0 as
# an ARTIFACT). 70-cell cluster ⇒ 70 - 64 = 6 dropped at its deepest fine tile.
N_DENSE = 80
N_DENSE_BIG = 70   # the over-cap coincident cluster (drops N_DENSE_BIG - cap = 6)
INGEST_TIMESTAMP = "2026-05-29T00:00:00Z"  # fixed, not "now", for reproducibility

FIXTURE_DIR = Path(__file__).resolve().parent


def _positions() -> tuple[list[float], list[float]]:
    """Deterministic cell centres (world x/y)."""
    xs, ys = [], []
    for i in range(N):
        col, row = i % GX, i // GX
        xs.append((col + 0.5) / GX)   # 0.1, 0.3, 0.5, 0.7, 0.9
        ys.append((row + 0.5) / GY)   # 0.25, 0.75
    return xs, ys


def _bbox() -> list[float]:
    xs, ys = _positions()
    clamp = lambda v: round(max(0.0, min(1.0, v)), 6)
    return [clamp(min(xs) - W / 2), clamp(min(ys) - H / 2), clamp(max(xs) + W / 2), clamp(max(ys) + H / 2)]


def _spatial_cells() -> pa.Table:
    xs, ys = _positions()
    return pa.table(
        {
            "id": pa.array(list(range(N)), pa.int64()),
            "x": pa.array(xs, pa.float32()),
            "y": pa.array(ys, pa.float32()),
            "w": pa.array([W] * N, pa.float32()),
            "h": pa.array([H] * N, pa.float32()),
        }
    )


def _grid_layout_result(cells: pa.Table, bbox: list[float]) -> LayoutResult:
    """A LayoutResult the REAL emitter (manifest.write_manifest) turns into the
    layout entry. layout_type/label/bbox feed _layout_entry; `cells` rides along."""
    return LayoutResult(
        layout_id=LAYOUT_ID,
        layout_type="grid",
        label="Grid",
        cells=cells,
        bbox=tuple(bbox),  # type: ignore[arg-type]
        edges=None,
    )


def _bake_detail(image_index: list[tuple[int, Path]], detail_dir: Path) -> dict[int, str]:
    """Transcode each cell's original to a WebP under detail/ keyed by id, returning
    {id: relative_ref}. Mirrors worker._bake_detail_tier so the fixture's detail tier
    is real (the manifest's `detail` block is then honest, and the lean gate validates
    a real detail block — closing the 'detail ungated' hole)."""
    detail_dir.mkdir(parents=True, exist_ok=True)
    refs: dict[int, str] = {}
    for cid, path in image_index:
        out_name = f"{cid}.webp"
        img = pyvips.Image.thumbnail(str(path), 2048, size="down")
        img.colourspace("srgb").copy(interpretation="srgb").webpsave(str(detail_dir / out_name))
        refs[cid] = out_name
    return refs


def _column_roles_for(with_metadata: bool) -> ColumnRoles | None:
    """The ColumnRoles the real emitter serializes — None for images-only (D-25)."""
    if not with_metadata:
        return None
    return ColumnRoles.from_config(
        {
            "filename": {"column": "filename", "label": "Filename"},
            "tag": [{"column": "tags", "label": "Tags", "delimiter": ","}],
        }
    )


def _tags_n(n: int) -> list[list[str]]:
    return [["a", "b"] if i % 2 == 0 else ["b", "c"] for i in range(n)]


def write_tags_sidecar(golden: Path, n: int) -> Path:
    out = golden / "tags"
    out.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {"id": pa.array(list(range(n)), pa.int64()), "tags": pa.array(_tags_n(n), pa.list_(pa.string()))}
    )
    # D-29: browser-read Arrow MUST be uncompressed.
    path = out / f"tags_v{DATASET_VERSION}.arrow"
    feather.write_feather(table, path, compression="uncompressed")
    return path


def _build_images_n(images_dir: Path, n: int) -> list[tuple[int, Path]]:
    """Deterministic solid-colour WebP images (real, so the tiler can decode them)."""
    images_dir.mkdir(parents=True, exist_ok=True)
    index: list[tuple[int, Path]] = []
    for i in range(n):
        name = f"img_{i:03d}.webp"
        rgb = [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256]
        img = (pyvips.Image.black(64, 64, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
        img.webpsave(str(images_dir / name))
        index.append((i, images_dir / name))
    return index


def _dense_cells() -> tuple[pa.Table, list[float]]:
    """TWO coincident clusters far apart: N_DENSE_BIG cells coincident at (0.2, 0.2)
    and the remaining (N_DENSE - N_DENSE_BIG) coincident at (0.8, 0.8). The two
    clusters separate at z=1 (different quadrants), so the tiler keeps a COARSE z=0
    mosaic and a FINE z=1 level (z_cap=1 > 0). The big cluster is genuinely coincident
    and over cap, so its deepest fine tile in-tile subsamples to cap (drops
    N_DENSE_BIG - cap = 6) and records subsampled.dropped; the small cluster fits.
    Reconciliation: (cap + small) placed + 6 dropped == N_DENSE."""
    n_small = N_DENSE - N_DENSE_BIG
    xs = [0.2] * N_DENSE_BIG + [0.8] * n_small
    ys = [0.2] * N_DENSE_BIG + [0.8] * n_small
    cells = pa.table(
        {
            "id": pa.array(list(range(N_DENSE)), pa.int64()),
            "x": pa.array(xs, pa.float32()),
            "y": pa.array(ys, pa.float32()),
            "w": pa.array([0.01] * N_DENSE, pa.float32()),
            "h": pa.array([0.01] * N_DENSE, pa.float32()),
        }
    )
    return cells, [0.0, 0.0, 1.0, 1.0]


def build(
    dataset_id: str,
    golden: Path,
    work: Path,
    *,
    with_metadata: bool,
    with_detail: bool,
    cells: pa.Table,
    bbox: list[float],
    n: int,
) -> None:
    if golden.exists():
        shutil.rmtree(golden)
    golden.mkdir(parents=True)
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    # metadata.parquet: id + filename, plus tags when a metadata source is present.
    columns: dict = {
        "id": pa.array(list(range(n)), pa.int64()),
        "filename": pa.array([f"img_{i:03d}.webp" for i in range(n)], pa.string()),
    }
    if with_metadata:
        columns["tags"] = pa.array(_tags_n(n), pa.list_(pa.string()))
    pq.write_table(pa.table(columns), golden / "metadata.parquet")

    # decode thumbnails + (optionally) a real detail tier.
    index = _build_images_n(work / "images", n)
    cache = decode_thumbnails(index, THUMB_PX, work / "cache")
    detail_refs = detail_prefix = detail_format = None
    if with_detail:
        detail_refs = _bake_detail(index, golden / "detail")
        detail_prefix, detail_format = "detail/", "webp"

    # bake the grid pyramid (the real tiler), then emit via the REAL manifest writer.
    out = golden / "tiles" / LAYOUT_ID / f"{LAYOUT_ID}_v{DATASET_VERSION}.pmtiles"
    pyramid = bake_pyramid(
        layout_id=LAYOUT_ID,
        cells_table=cells,
        bbox=tuple(bbox),  # type: ignore[arg-type]
        cache=cache,
        output_path=out,
        dataset_version=DATASET_VERSION,
        tile_px=TILE_PX,
        thumb_px=THUMB_PX,
        detail_path_prefix=detail_prefix,
        detail_format=detail_format,
        detail_ref_by_id=detail_refs,
    )

    tags_path = write_tags_sidecar(golden, n) if with_metadata else None
    write_manifest(
        dataset_id,
        DATASET_VERSION,
        [_grid_layout_result(cells, bbox)],
        {LAYOUT_ID: pyramid},
        _column_roles_for(with_metadata),
        n,
        Path("fixture.csv") if with_metadata else None,
        golden / "layout_manifest.json",
        tags_path,
        ingest_timestamp=INGEST_TIMESTAMP,
    )
    shutil.rmtree(work, ignore_errors=True)
    print(f"wrote fixture -> {golden} (z_cap={pyramid.z_cap}, dropped={pyramid.dropped_total})")


def main() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        build(
            DATASET_ID,
            FIXTURE_DIR / DATASET_ID,
            Path(tmp) / "a",
            with_metadata=True,
            with_detail=True,
            cells=_spatial_cells(),
            bbox=_bbox(),
            n=N,
        )
        build(
            DATASET_ID_IMAGES_ONLY,
            FIXTURE_DIR / DATASET_ID_IMAGES_ONLY,
            Path(tmp) / "b",
            with_metadata=False,
            with_detail=False,
            cells=_spatial_cells(),
            bbox=_bbox(),
            n=N,
        )
        dense_cells, dense_bbox = _dense_cells()
        build(
            DATASET_ID_DENSE,
            FIXTURE_DIR / DATASET_ID_DENSE,
            Path(tmp) / "c",
            with_metadata=False,
            with_detail=True,
            cells=dense_cells,
            bbox=dense_bbox,
            n=N_DENSE,
        )


if __name__ == "__main__":
    main()
