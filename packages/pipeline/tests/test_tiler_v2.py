"""v2 spatial-tile-pyramid baker tests (decision D-33).

NATIVE: tiler.py imports pyvips + pmtiles and the tests decode/encode real WebP,
so the whole module is `native` and runs only in the worker image
(`make test-pipeline -m native`); the lean test image skips it via importorskip.

Covers the producer-seam invariants:
  * cap == floor(tile_px/thumb_px)^2; thumb_px <= tile_px;
  * a baked pyramid validates against schemas/v2 (manifest + tile bodies);
  * fine tiles carry a cell_record list (id,x,y,w,h,u,v,uw,uh) whose UV sub-rects
    are valid; coarse tiles are pixel-only mosaics; the z_cap coarse/fine partition;
  * the union of fine-tile ids == {0..image_count-1} (contiguous-dense);
  * a degenerate (coincident) point set subdivides to max depth + in-tile subsample.
"""
from __future__ import annotations

import json
import logging
import math
from pathlib import Path

import pyarrow as pa
import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")
pytest.importorskip("pmtiles")

from pipeline.atlas import decode_thumbnails  # noqa: E402
from pipeline.tiler import (  # noqa: E402
    CELL_RECORD_SCHEMA,
    bake_pyramid,
    cap_for,
    iter_tiles,
    read_subsampled_dropped,
    unpack_fine_body,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "schemas" / "v2"

TILE_PX = 512
THUMB_PX = 64


def _load_schema(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def _registry() -> Registry:
    def retrieve(uri: str) -> Resource:
        return Resource.from_contents(_load_schema(uri.rsplit("/", 1)[-1]))

    return Registry(retrieve=retrieve)


def _solid(path: Path, w: int, h: int, rgb: list[int]) -> None:
    img = (pyvips.Image.black(w, h, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
    img.webpsave(str(path))


def _corpus(images_dir: Path, n: int) -> list[tuple[int, Path]]:
    images_dir.mkdir(parents=True, exist_ok=True)
    index: list[tuple[int, Path]] = []
    for i in range(n):
        p = images_dir / f"img_{i:03d}.webp"
        _solid(p, 48, 48, [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256])
        index.append((i, p))
    return index


def _grid_cells(n: int) -> pa.Table:
    """A simple n-cell grid spanning [0,1]^2 (id,x,y,w,h)."""
    import math

    cols = max(1, math.ceil(math.sqrt(n)))
    xs, ys = [], []
    for i in range(n):
        col, row = i % cols, i // cols
        xs.append((col + 0.5) / cols)
        ys.append((row + 0.5) / cols)
    return pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "x": pa.array(xs, pa.float32()),
            "y": pa.array(ys, pa.float32()),
            "w": pa.array([0.05] * n, pa.float32()),
            "h": pa.array([0.05] * n, pa.float32()),
        }
    )


def _bake(tmp_path: Path, n: int, cells: pa.Table, bbox: tuple[float, float, float, float]):
    cache = decode_thumbnails(_corpus(tmp_path / "images", n), THUMB_PX, tmp_path / "cache")
    out = tmp_path / "ds" / "tiles" / "grid" / "grid_v1.pmtiles"
    return bake_pyramid(
        layout_id="grid",
        cells_table=cells,
        bbox=bbox,
        cache=cache,
        output_path=out,
        dataset_version=1,
        tile_px=TILE_PX,
        thumb_px=THUMB_PX,
    ), out


def test_cap_relation() -> None:
    assert cap_for(512, 64) == 64
    assert cap_for(512, 128) == 16
    assert cap_for(256, 64) == 16


def test_small_grid_single_fine_level(tmp_path: Path) -> None:
    """A 10-cell grid fits in one tile (10 <= cap 64), so the pyramid is a single
    FINE level z=0 with z_cap=0 — the smallest valid pyramid."""
    n = 10
    pyramid, out = _bake(tmp_path, n, _grid_cells(n), (0.0, 0.0, 1.0, 1.0))
    assert out.exists()
    assert pyramid.cap == 64
    assert pyramid.thumb_px <= pyramid.tile_px
    assert pyramid.z_cap == 0
    assert [lv.z for lv in pyramid.levels] == [0]
    assert pyramid.levels[0].tile_count == 1


def test_multi_level_pyramid_has_coarse_and_fine(tmp_path: Path) -> None:
    """A denser corpus forces subdivision: z_max > 0, so there is at least one
    COARSE level (z < z_cap) and exactly one FINE level (z == z_cap)."""
    n = 300  # > cap, so the root tile overflows and the tiler subdivides
    pyramid, out = _bake(tmp_path, n, _grid_cells(n), (0.0, 0.0, 1.0, 1.0))
    zs = [lv.z for lv in pyramid.levels]
    assert zs == list(range(0, max(zs) + 1)), "levels contiguous from 0"
    assert pyramid.z_cap == max(zs), "deepest level is the single fine level"
    assert pyramid.z_cap > 0, "300 cells must subdivide past the root"
    # coarse levels exist below z_cap
    assert any(z < pyramid.z_cap for z in zs)


def _coarse_banding(body: bytes, gs: int = 32) -> tuple[int, float]:
    """Sample a coarse tile's webp on a gs x gs grid and return
    ``(full_OPAQUE_black_rows_in_central_band, opaque_black_fraction)`` — the
    verify_bake.py banding signature RE-EXPRESSED against the v2 ALPHA pad (Seam A / b1).

    The pad is now TRANSPARENT (alpha 0), so an empty region is transparent, not black
    — the OLD ``all(RGB < 8)`` test would mistake the transparent pad for a black band.
    The regression to catch is a full-width interior row of OPAQUE black (alpha high,
    RGB ~0): that is the shrunk-partial-mini-atlas OPAQUE padding, which the transparent
    pad + spatial render can no longer produce. Transparent samples are IGNORED (they
    are legitimate sparsity, not banding). We scan only the central band (the dense
    interior) so a legitimate thin transparent edge margin is not mistaken for a band."""
    img = pyvips.Image.new_from_buffer(body, "")
    alpha_opaque = 128  # alpha >= this is opaque CONTENT; below is (near-)transparent pad
    full_black_central = 0
    opaque_black_total = 0
    for gy in range(gs):
        row_opaque_black = 0
        for gx in range(gs):
            px = img.getpoint(
                min(img.width - 1, (gx + 0.5) / gs * img.width),
                min(img.height - 1, (gy + 0.5) / gs * img.height),
            )
            a = px[3] if len(px) > 3 else 255
            if a >= alpha_opaque and all(v < 8 for v in px[:3]):
                row_opaque_black += 1
        opaque_black_total += row_opaque_black
        if gs // 4 <= gy < 3 * gs // 4 and row_opaque_black == gs:
            full_black_central += 1
    return full_black_central, opaque_black_total / (gs * gs)


def test_coarse_overview_is_not_banded(tmp_path: Path) -> None:
    """Regression (live-found 2026-06-28): coarse overview tiles (z < z_cap) must be a
    faithful low-res render of the layout, NOT a shrunk packing-sheet. The pre-fix
    compositor shrank the PARTIALLY-FILLED mini-atlases, whose unused slots are black,
    so coarse tiles showed regular full-width black BANDS (verify_bake.py measured
    32-39% black with full-black rows). _build_spatial_render draws cells at world
    positions (with neighbour bleed) instead, leaving only the thin uniform inter-cell
    gap. n=400 forces z_max=2, so the fine tiles hold ~25 cells each (< cap 64 →
    partial → the banding precondition). Fails on the pre-fix shrink-the-mini-atlas
    path; structural tests stay green either way, so this is the producer-side mirror
    of the frontend DoubleSide regression test.

    RE-EXPRESSED for the v2 ALPHA pad (Seam A / b1): the coarse tile is now RGBA with a
    TRANSPARENT pad, so the banding signature is a full-width interior row of OPAQUE
    black (a shrunk mini-atlas's opaque padding) — a transparent row is legitimate
    sparsity and is IGNORED (see _coarse_banding). The old near-BLACK-row assertion
    would pass VACUOUSLY on the transparent pad (RGB is 0 there too); keying on
    alpha>=opaque makes it catch a genuine opaque padding band instead."""
    n = 400
    pyramid, out = _bake(tmp_path, n, _grid_cells(n), (0.0, 0.0, 1.0, 1.0))
    assert pyramid.z_cap >= 1, "need at least one coarse level to test for banding"
    coarse_seen = 0
    for z, x, y, body in iter_tiles(out, pyramid.levels):
        if z >= pyramid.z_cap:
            continue  # fine tile (webp+arrow bundle), not a coarse overview
        coarse_seen += 1
        img = pyvips.Image.new_from_buffer(body, "")
        assert img.hasalpha(), f"coarse tile z{z}/{x}/{y} must be RGBA (the alpha pad, b1)"
        full_black_central, opaque_black_frac = _coarse_banding(body)
        assert full_black_central == 0, (
            f"coarse tile z{z}/{x}/{y}: {full_black_central} full OPAQUE-black rows in its "
            f"central band — the shrunk-partial-mini-atlas banding signature is back"
        )
        assert opaque_black_frac < 0.30, (
            f"coarse tile z{z}/{x}/{y} is {opaque_black_frac:.0%} OPAQUE-black (the banded "
            f"build was 32-39%); the overview is not filling edge-to-edge with content"
        )
    assert coarse_seen > 0, "the corpus must produce coarse tiles for this test to be meaningful"


def _datetime_cells(n: int, ncol: int = 5) -> tuple[pa.Table, tuple[float, float, float, float]]:
    """A DATETIME-SHAPED sparse layout (the spike's recipe): ``ncol`` thin histogram
    columns squeezed into the left ~30% of x, each a TALL vertical stack over the full
    y range — so ~90% of [0,1]^2 is empty (the datetime histogram-stacking shape that
    reads near-black in the overview). Forces z_cap >= 2 for n >> cap. Returns
    (cells, bbox); the bbox is the placed-cell footprint, as the baker derives it."""
    per = max(1, n // ncol)
    xs, ys = [], []
    for i in range(n):
        col = min(ncol - 1, i // per)
        row = i % per
        xs.append((col + 0.5) / ncol * 0.3 + 0.02)   # thin columns in the left band
        ys.append((row + 0.5) / per)                  # full-height stack (tall)
    w = h = 0.01
    x0 = max(0.0, min(xs) - w / 2)
    y0 = max(0.0, min(ys) - h / 2)
    x1 = min(1.0, max(xs) + w / 2)
    y1 = min(1.0, max(ys) + h / 2)
    table = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "x": pa.array(xs, pa.float32()),
            "y": pa.array(ys, pa.float32()),
            "w": pa.array([w] * n, pa.float32()),
            "h": pa.array([h] * n, pa.float32()),
        }
    )
    return table, (x0, y0, x1, y1)


def _tile_alpha_stats(body: bytes) -> tuple[float, float]:
    """(non_transparent_fraction, max_alpha) of a coarse tile's RGBA webp, over a
    32x32 sample grid. non_transparent_fraction is the legible-content coverage; a
    max_alpha > 0 means at least one opaque (colored, present) pixel — the cell did
    not vanish into the transparent pad."""
    img = pyvips.Image.new_from_buffer(body, "")
    gs = 32
    nt = 0
    max_a = 0.0
    for gy in range(gs):
        for gx in range(gs):
            px = img.getpoint(
                min(img.width - 1, (gx + 0.5) / gs * img.width),
                min(img.height - 1, (gy + 0.5) / gs * img.height),
            )
            a = px[3] if len(px) > 3 else 255
            if a >= 128:
                nt += 1
            if a > max_a:
                max_a = a
    return nt / (gs * gs), max_a


def test_sparse_layout_overview_is_legible(tmp_path: Path) -> None:
    """Seam A regression (the gate today's tests do NOT provide): a DATETIME-SHAPED
    sparse bake (tall histogram columns, ~90% empty — the measured 9.63% overview
    coverage) must stay LEGIBLE at every overview level. With the coverage-gated
    dilation floor (b2) every OCCUPIED coarse tile keeps a floor of NON-TRANSPARENT
    (colored, opaque) pixels, and cell presence never drops to zero at the world
    overview (z=0) — where, WITHOUT the floor, the mean-filter mip averages a lone cell
    into the transparent pad and it vanishes (proven in
    test_coarse_cell_presence_survives_mip). The dilation branch must actually FIRE for
    this shape (coarse_dilated > 0), else the test would pass vacuously."""
    n = 500
    cells, bbox = _datetime_cells(n)
    pyramid, out = _bake(tmp_path, n, cells, bbox)
    assert pyramid.z_cap >= 2, f"datetime-shaped bake must be multi-level (z_cap>=2), got {pyramid.z_cap}"
    # The dilation floor fires on this sparse layout (it is the mechanism under test).
    assert pyramid.coarse_dilated > 0, "the coverage-gated dilation floor did not fire on a sparse layout"

    coarse_seen = 0
    for z, x, y, body in iter_tiles(out, pyramid.levels):
        if z >= pyramid.z_cap:
            continue
        coarse_seen += 1
        nt_frac, max_a = _tile_alpha_stats(body)
        # Every OCCUPIED coarse tile has SOME colored, opaque presence (it is not a
        # fully-transparent hole where cells were averaged away).
        assert max_a > 0, f"occupied coarse tile z{z}/{x}/{y} is fully transparent — its cells vanished"
        assert nt_frac > 0.0, f"coarse tile z{z}/{x}/{y} has zero non-transparent pixels"
    assert coarse_seen > 0, "the sparse corpus must produce coarse tiles"

    # Cell presence at the WORLD overview (z=0) never drops to zero.
    z0 = [b for zz, _x, _y, b in iter_tiles(out, pyramid.levels) if zz == 0]
    assert len(z0) == 1, "expect exactly one world-overview (z=0) tile"
    _nt0, max_a0 = _tile_alpha_stats(z0[0])
    assert max_a0 > 0, "the world overview (z=0) is fully transparent — sparse cells vanished at the top"


def test_dense_layout_dilation_never_fires(tmp_path: Path) -> None:
    """Seam A (b2 is SURGICAL): a DENSE layout (grid — coverage 70-100%, well above
    MIN_COARSE_COVERAGE) must NEVER enter the dilation branch, so its coarse bytes are
    unaffected by the floor (only b1's RGBA pad changes them). Asserted via STRUCTURE
    (the coarse_dilated counter == 0), not pixels — the definitive proof the floor is
    gated, so a future gate-widening that silently dilated dense grids fails here."""
    n = 400  # forces z_cap=2 (real coarse tiles), dense grid coverage ~99%
    pyramid, out = _bake(tmp_path, n, _grid_cells(n), (0.0, 0.0, 1.0, 1.0))
    assert pyramid.z_cap >= 1, "need coarse tiles for the dilation gate to be evaluated"
    assert pyramid.coarse_dilated == 0, (
        f"the dilation floor fired on a DENSE grid ({pyramid.coarse_dilated} tiles) — b2 must "
        f"be gated below MIN_COARSE_COVERAGE and never touch a dense layout"
    )
    # And every coarse tile is genuinely dense (coverage well above the gate) — so the
    # counter==0 is because the layout is dense, not because the gate never ran.
    from pipeline.tiler import MIN_COARSE_COVERAGE
    for z, x, y, body in iter_tiles(out, pyramid.levels):
        if z >= pyramid.z_cap:
            continue
        nt_frac, _max_a = _tile_alpha_stats(body)
        assert nt_frac >= MIN_COARSE_COVERAGE, (
            f"dense coarse tile z{z}/{x}/{y} coverage {nt_frac:.2f} < gate {MIN_COARSE_COVERAGE} — "
            f"the fixture is not actually dense, so the never-fires assertion is hollow"
        )


def test_coarse_cell_presence_survives_mip(tmp_path: Path) -> None:
    """Seam A (b2, the core guarantee): ONE isolated cell in a huge SPARSE extent stays
    visible (>= 1 non-transparent px) at the world overview z=0. This is the exact case
    the mean-filter mip destroys WITHOUT the dilation floor — a lone cell shrunk 512→1
    averages to alpha 0 (proven in the PR's A/B). With the floor its opaque, colored
    presence is dilated 1px before each shrink and compounds up, so it survives.

    Construction: a dense cluster of > cap cells in one far corner (forces the tiler to
    subdivide, so z_cap >= 1 and a z=0 COARSE overview exists) plus a SINGLE isolated
    cell in the opposite corner. At z=0 the whole extent shrinks into one tile; the lone
    isolated cell (in its own z=0 sub-quadrant) is what must not vanish."""
    cluster_n = 100  # > cap 64 → the root overflows → the tiler subdivides (z_cap >= 1)
    ids = list(range(cluster_n + 1))
    xs = [0.05 + 0.02 * ((i % 10) / 10) for i in range(cluster_n)] + [0.95]  # dense corner + lone cell
    ys = [0.05 + 0.02 * ((i // 10) / 10) for i in range(cluster_n)] + [0.95]
    cells = pa.table(
        {
            "id": pa.array(ids, pa.int64()),
            "x": pa.array(xs, pa.float32()),
            "y": pa.array(ys, pa.float32()),
            "w": pa.array([0.002] * len(ids), pa.float32()),
            "h": pa.array([0.002] * len(ids), pa.float32()),
        }
    )
    pyramid, out = _bake(tmp_path, len(ids), cells, (0.0, 0.0, 1.0, 1.0))
    assert pyramid.z_cap >= 1, f"need a coarse z=0 overview (z_cap>=1), got {pyramid.z_cap}"
    assert pyramid.coarse_dilated > 0, "the sparse isolated-cell bake must trip the dilation floor"

    # The z=0 world overview must carry an OPAQUE (present, colored) pixel — the isolated
    # cell's dilated presence survived the mip chain. WITHOUT the floor a lone cell shrunk
    # to the world overview averages to alpha 0 (the PR's A/B proves this). Use the exact
    # per-tile max alpha (not a sparse sample grid — a 1px dilated blob can fall between
    # grid points).
    z0 = [b for zz, _x, _y, b in iter_tiles(out, pyramid.levels) if zz == 0]
    assert len(z0) == 1
    img = pyvips.Image.new_from_buffer(z0[0], "")
    assert img.hasalpha(), "the coarse overview must be RGBA"
    max_a = img.extract_band(img.bands - 1).max()
    assert max_a > 0, (
        "an isolated cell in a huge sparse extent vanished at the world overview (z=0) — "
        "the mean-filter mip averaged it into the transparent pad; the dilation floor must "
        "keep >= 1px of opaque presence"
    )
    # And specifically the ISOLATED cell's corner is non-empty (not just the dense
    # cluster's) — crop the bottom-right eighth (world ~0.875..1.0, where the lone cell
    # at 0.95 sits) and assert it carries opaque presence too.
    e = img.width // 8
    corner = img.crop(img.width - e, img.height - e, e, e)
    assert corner.extract_band(corner.bands - 1).max() > 0, (
        "the ISOLATED cell's corner of the world overview is fully transparent — only the "
        "dense cluster survived the mip, the lone cell was averaged away"
    )


def _rgba_px(r: int, g: int, b: int, a: int) -> "pyvips.Image":
    """A 1x1 RGBA sRGB pixel (exact uchar values, no lossy op)."""
    return pyvips.Image.new_from_memory(bytes([r, g, b, a]), 1, 1, 4, "uchar").copy(
        interpretation="srgb"
    )


def test_dilate_opaque_preserves_interior_grows_into_pad() -> None:
    """Seam A / b2 FIDELITY (PR #111 review #2): the coverage-gated dilation floor must
    grow a cell into the TRANSPARENT pad WITHOUT recoloring an already-opaque interior.
    A dense child can be dilated when it sits among sparse siblings (the gate averages
    per parent), and a bare per-band window max would raise a DARK opaque cell toward a
    BRIGHT opaque neighbour — distorting the dense interior. The masked dilate keeps
    every alpha>0 pixel byte-exact and only fills alpha==0 pad.

    Layout (7x7 transparent canvas): a DARK opaque cell at (3,3) touching a BRIGHT
    opaque cell at (4,3). The unmasked max would push (3,3) up to the bright value; the
    fix must leave it exactly dark, while a transparent pad pixel bordering a cell still
    grows to opaque+colored (the floor), and a pad pixel far from any cell stays
    transparent (growth is 1px, not global)."""
    from pipeline.tiler import _dilate_opaque

    canvas = pyvips.Image.black(7, 7, bands=4).copy(interpretation="srgb")
    img = canvas.insert(_rgba_px(10, 10, 10, 255), 3, 3).insert(_rgba_px(250, 250, 250, 255), 4, 3)
    # Preconditions: the dark/bright opaque pair and a transparent rim + far pad.
    assert list(img.getpoint(3, 3)) == [10, 10, 10, 255]
    assert img.getpoint(2, 3)[3] == 0, "the pad pixel left of the dark cell is transparent"
    assert img.getpoint(0, 0)[3] == 0, "the far corner is transparent"

    out = _dilate_opaque(img, 1)
    assert (out.width, out.height, out.bands) == (7, 7, 4)
    # FIDELITY: the dark opaque interior pixel is NOT brightened by its bright neighbour
    # (this assertion FAILS on the old unmasked per-band max, which returns 250s here).
    assert list(out.getpoint(3, 3)) == [10, 10, 10, 255], (
        "an opaque interior pixel was recolored by the dilation — the mask must keep "
        "alpha>0 pixels byte-exact"
    )
    # FLOOR still fires: the transparent pad pixel bordering the dark cell grew to
    # opaque and took the cell color (its 3x3 window sees (3,3) but not the bright (4,3)).
    grown = out.getpoint(2, 3)
    assert grown[3] == 255, "the pad rim did not grow to opaque — the dilation floor stopped working"
    assert list(grown) == [10, 10, 10, 255], "the grown rim took the cell color, not black or the neighbour"
    # BOUNDED: a pad pixel far from any cell stays transparent (1px growth, not a flood).
    assert out.getpoint(0, 0)[3] == 0, "dilation over-grew — a far pad pixel became opaque"


def _solid_thumb(rgb: list[int]) -> "pyvips.Image":
    """A THUMB_PX square solid-color RGB thumbnail (as _decode_tile_thumbs yields)."""
    return (pyvips.Image.black(THUMB_PX, THUMB_PX, bands=3) + rgb).cast("uchar").copy(
        interpretation="srgb"
    )


def test_spatial_render_composite_matches_insert(tmp_path: Path) -> None:
    """T2-106: _build_spatial_render paints its cells with ONE `composite` instead of the
    old O(cells)-deep ``canvas = canvas.insert(...)`` chain (which libvips rendered
    SUPERLINEARLY — ~O(K^2.5), ~13 s for one 800-cell tile — making dense-categorical
    coarse tiers effectively un-bakeable at 1M). The two are BYTE-IDENTICAL because every
    cell is fully opaque (alpha 255), so an over-blend equals the old overwrite-insert.
    This pins that equivalence at the pixel level over a hand-built fine tile with cell
    OVERLAPS and EDGE/negative placements (the clip cases the two paths must agree on)."""
    from pipeline.tiler import _Cell, _build_spatial_render

    bbox = (0.0, 0.0, 1.0, 1.0)
    z, tx, ty = 3, 3, 3
    n = 1 << z
    tw = th = 1.0 / n
    tx0, ty0 = tx * tw, ty * th
    # (cx, cy, cw, ch): an overlapping pair, a wide cell, a tall cell straddling the top
    # edge into the neighbour row, and one near the right edge — overlaps + clips.
    layout = [
        (0.44, 0.44, 0.06, 0.06), (0.46, 0.45, 0.06, 0.06),
        (0.50, 0.50, 0.05, 0.05), (0.45, 0.47, 0.12, 0.03),
        (0.44, 0.40, 0.02, 0.18), (0.47, 0.505, 0.10, 0.02),
    ]
    fine_members: dict[tuple[int, int], list[_Cell]] = {}
    tile_thumbs: dict[int, "pyvips.Image"] = {}
    for i, (cx, cy, cw, ch) in enumerate(layout):
        c = _Cell(id=i, x=cx, y=cy, w=cw, h=ch)
        fine_members.setdefault((int(cx / tw), int(cy / th)), []).append(c)
        tile_thumbs[i] = _solid_thumb([(i * 60) % 256, (i * 97 + 30) % 256, (i * 33 + 80) % 256])

    out = _build_spatial_render(fine_members, tx, ty, z, bbox, tmp_path, TILE_PX, tile_thumbs)

    # Reference = the pre-fix chained-insert render (identical geometry + bandjoin).
    ref = pyvips.Image.black(TILE_PX, TILE_PX, bands=4).copy(interpretation="srgb")
    for nty in (ty - 1, ty, ty + 1):
        for ntx in (tx - 1, tx, tx + 1):
            for c in fine_members.get((ntx, nty), ()):
                pw = max(1, round((c.w / tw) * TILE_PX))
                ph = max(1, round((c.h / th) * TILE_PX))
                left = round(((c.x - tx0) / tw) * TILE_PX - pw / 2)
                top = round(((c.y - ty0) / th) * TILE_PX - ph / 2)
                if left + pw <= 0 or left >= TILE_PX or top + ph <= 0 or top >= TILE_PX:
                    continue
                thumb = tile_thumbs[c.id]
                if thumb.width != pw or thumb.height != ph:
                    thumb = thumb.thumbnail_image(pw, height=ph, size="force")
                opaque = thumb.copy(interpretation="srgb").bandjoin(255).copy(interpretation="srgb")
                ref = ref.insert(opaque, left, top)
    ref = ref.copy(interpretation="srgb").copy_memory()

    assert out.write_to_memory() == ref.write_to_memory(), (
        "the batched composite render diverged from the chained-insert render — for "
        "fully-opaque cells the over-blend must be byte-identical to the overwrite-insert"
    )
    # Non-trivial render: both opaque content and transparent pad are present.
    alpha = out.extract_band(out.bands - 1)
    assert alpha.max() == 255, "no opaque cell content in the render"
    assert alpha.min() == 0, "no transparent pad in the render"


def test_spatial_render_scales_sublinearly_in_cell_count() -> None:
    """T2-106 perf guard: _build_spatial_render must render a fine tile in ~O(cells), NOT
    the old O(cells^~2.5) chained-insert cost. Uses a RELATIVE ratio (both timings on the
    SAME machine, so it is machine-speed-independent and non-flaky on shared CI runners):
    10x the cells must take well under 60x the time. The pre-fix insert chain took
    ~O(K^2.5), so the same 10x cell bump cost ~200x+ (and one 800-cell tile took ~13 s) —
    this ratio fails hard on that regression while leaving wide margin for the linear
    composite path (~20-25x for 10x cells; the ~1.4-power is libvips composite overhead,
    stable across machines).

    PR #150 review: this is a DELIBERATE wall-clock guard. If it ever flakes on a heavily
    contended runner despite the min-of-3 + the ~2.4x margin, RAISE the ratio bound rather
    than deleting the guard — a silent re-regression is O(K^2.5)."""
    import time

    from pipeline.tiler import _Cell, _build_spatial_render

    bbox = (0.0, 0.0, 1.0, 1.0)
    z, tx, ty = 4, 8, 8
    tw = th = 1.0 / (1 << z)
    thumb = _solid_thumb([180, 90, 40])

    def render_k(k: int) -> float:
        side = max(1, math.isqrt(k))
        members = [
            _Cell(id=i, x=(tx + (i % side + 0.5) / side) * tw,
                  y=(ty + (i // side + 0.5) / side) * th, w=tw / side, h=th / side)
            for i in range(k)
        ]
        fine_members = {(tx, ty): members}
        tile_thumbs = {i: thumb for i in range(k)}
        args = (fine_members, tx, ty, z, bbox, Path("/nonexistent"), TILE_PX, tile_thumbs)
        _build_spatial_render(*args)  # warm
        best = math.inf
        for _ in range(3):
            t0 = time.perf_counter()
            _build_spatial_render(*args)
            best = min(best, time.perf_counter() - t0)
        return best

    # NB "80->800 = 10x" is nominal: the bottom cell row lands just past the tile's lower
    # edge and is culled by _build_spatial_render's overlap guard, so the effective DRAWN
    # counts are ~64 and ~784 (~12x, not a literal 10x) — the 60x bound absorbs it (PR #150).
    t_small = render_k(80)
    t_large = render_k(800)
    ratio = t_large / max(t_small, 1e-6)
    assert ratio < 60.0, (
        f"_build_spatial_render scaled {ratio:.0f}x for 10x cells (80->800) — the "
        f"O(cells^2.5) chained-insert regression (T2-106) is back; the linear composite "
        f"path is ~20-25x. small={t_small * 1000:.0f}ms large={t_large * 1000:.0f}ms"
    )


def test_baked_pyramid_validates_v2_and_ids_dense(tmp_path: Path) -> None:
    """The fine tiles' cell records validate against cell_record.schema.json and
    their id union == {0..n-1} (contiguous-dense). Coarse tiles are pixel-only."""
    import io

    import pyarrow.feather as feather

    n = 300
    pyramid, out = _bake(tmp_path, n, _grid_cells(n), (0.0, 0.0, 1.0, 1.0))
    cell_schema = _load_schema("cell_record.schema.json")
    validator = Draft202012Validator(cell_schema, registry=_registry())

    seen_ids: set[int] = set()
    found_by_z: dict[int, int] = {}
    z_cap = pyramid.z_cap
    checked_fine_px = checked_coarse_px = False
    for z, x, y, body in iter_tiles(out, pyramid.levels):
        found_by_z[z] = found_by_z.get(z, 0) + 1
        if z >= z_cap:  # FINE tile: bundle of webp + arrow records
            image_bytes, arrow_bytes = unpack_fine_body(body)
            assert image_bytes[:4] == b"RIFF", "fine mini-atlas is not WebP"
            # PMT-5 round-trip hardening: the WebP actually decodes to a tile_px square
            # (RIFF magic alone does not prove a valid, correctly-sized image).
            if not checked_fine_px:
                decoded = pyvips.Image.new_from_buffer(image_bytes, "")
                assert decoded.width == TILE_PX and decoded.height == TILE_PX
                checked_fine_px = True
            table = feather.read_table(io.BytesIO(arrow_bytes))
            assert table.schema.names == CELL_RECORD_SCHEMA.names
            rows = table.to_pylist()
            assert len(rows) <= pyramid.cap
            for row in rows:
                validator.validate(row)
                seen_ids.add(row["id"])
        else:  # COARSE tile: pixel-only WebP, no record bundle
            assert body[:4] == b"RIFF", "coarse tile is not WebP"
            if not checked_coarse_px:
                decoded = pyvips.Image.new_from_buffer(body, "")
                assert decoded.width == TILE_PX and decoded.height == TILE_PX
                checked_coarse_px = True
    for lv in pyramid.levels:
        assert found_by_z.get(lv.z, 0) == lv.tile_count
    assert seen_ids == set(range(n)), "fine-tile id union must be contiguous-dense [0,n)"
    assert checked_fine_px and checked_coarse_px, "expected both a fine and a coarse tile to round-trip"


def test_degenerate_coincident_points_subsample(tmp_path: Path) -> None:
    """All cells at one coordinate never separate by subdivision; under the
    occupancy-aware depth ceiling the tiler stops IMMEDIATELY (z_cap=0 — a deeper
    level would not reduce the densest tile) and in-tile subsamples to cap, so the
    single fine tile holds exactly cap cells (the surplus dropped) and the pyramid
    still bakes. This is the rare, genuine-coincidence subsample case."""
    from pmtiles.reader import MmapSource, Reader

    n = 100  # > cap 64, all coincident
    cells = pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "x": pa.array([0.5] * n, pa.float32()),
            "y": pa.array([0.5] * n, pa.float32()),
            "w": pa.array([0.01] * n, pa.float32()),
            "h": pa.array([0.01] * n, pa.float32()),
        }
    )
    pyramid, out = _bake(tmp_path, n, cells, (0.49, 0.49, 0.51, 0.51))
    # The single occupied fine tile holds exactly cap cells (the surplus dropped).
    import io

    import pyarrow.feather as feather

    fine_levels = [lv for lv in pyramid.levels if lv.z >= pyramid.z_cap]
    total = 0
    dropped = 0
    for z, x, y, body in iter_tiles(out, fine_levels):
        _, arrow_bytes = unpack_fine_body(body)
        table = feather.read_table(io.BytesIO(arrow_bytes))
        total += table.num_rows
        dropped += read_subsampled_dropped(table)  # v2.1: drop count rides schema metadata
    assert total == pyramid.cap, f"coincident tile must subsample to cap={pyramid.cap}, got {total}"
    # v2.1 reconciliation: the drop count is RECORDED (subsampled.dropped), not silent.
    assert dropped == n - pyramid.cap, f"expected {n - pyramid.cap} recorded as dropped, got {dropped}"
    assert pyramid.dropped_total == dropped, "PyramidResult.dropped_total must match the recorded drops"
    # Reconciliation: placed (cap) + dropped == image_count (n); no holes in numbering.
    assert total + dropped == n
    # A FULLY-coincident set never separates, so the occupancy-aware ceiling stops at
    # z=0 — the shallowest possible pyramid (no point deepening identical mosaics).
    assert pyramid.z_cap == 0, f"fully-coincident set must stop at z_cap=0, got {pyramid.z_cap}"


@pytest.mark.parametrize("spread_scale", [0.5, 1.0 / 32], ids=["half-bbox", "compact-1/32"])
def test_isolated_coincident_cluster_does_not_cap_spread_depth(spread_scale: float) -> None:
    """REGRESSION: an isolated (near-)coincident cluster must NOT cap the pyramid depth for
    the SEPARABLE spread around it — at ANY spread compactness.

    Two failure modes the depth ceiling has historically had, both gated here:
      * ``half-bbox`` — an isolated exactly-coincident cluster of size C (a scatter sentinel
        / duplicate coordinate away from the main cloud; scatter._aspect_fit maps identical
        inputs to one point) pinned the global MAX-OCCUPANCY at C, so the old termination
        stopped the instant the spread fell below C and subsampled the still-unresolved
        spread (~90% dropped).
      * ``compact-1/32`` — the spread compressed into a corner because a far outlier inflated
        the bbox. Its residual/occupancy stays FLAT for log2(1/width) > any fixed patience
        window before it begins to separate, so a fixed-lookahead ceiling stops early and
        drops ~99% of a perfectly distinct spread.

    EXTENT-aware termination handles both: it keeps subdividing while an over-cap tile's
    cells span more than a footprint (they WILL separate), and stops only when the surplus
    is an overlapping pile — so the spread fully resolves and ONLY the coincident cluster's
    surplus drops, at every compactness. Pure _choose_z_max / _group_fine_tiles logic (no
    bake), so it is fast."""
    from pipeline.tiler import _Cell, _choose_z_max, _group_fine_tiles, cap_for

    cap = cap_for(TILE_PX, THUMB_PX)  # 64
    bbox = (0.0, 0.0, 1.0, 1.0)
    cluster_n = 1000

    # 10k distinct 2-D spread confined to [0, spread_scale]^2 + an isolated exactly-
    # coincident cluster far away at (0.95, 0.95). As spread_scale shrinks the bulk gets
    # compact (the outlier-inflated-bbox shape) but its cells stay distinct.
    g = 100
    cells: list[_Cell] = []
    cid = 0
    for i in range(g * g):
        x = ((i % g) + 0.5) / g * spread_scale
        y = ((i // g) + 0.5) / g * spread_scale
        cells.append(_Cell(id=cid, x=x, y=y, w=0.001, h=0.001))
        cid += 1
    for _ in range(cluster_n):
        cells.append(_Cell(id=cid, x=0.95, y=0.95, w=0.001, h=0.001))
        cid += 1

    z, _reason = _choose_z_max(cells, bbox, cap)
    _, dropped = _group_fine_tiles(cells, bbox, z, cap)
    total_dropped = sum(dropped.values())

    # The genuine coincident cluster IS subsampled (its surplus must drop — the path is
    # exercised, not vacuously passing).
    assert total_dropped >= cluster_n - cap, (
        f"expected the coincident cluster to subsample its surplus (>= {cluster_n - cap}); "
        f"got {total_dropped} at z_max={z}"
    )
    # ...but ONLY the cluster: the 10k distinct spread must resolve, not be mass-subsampled.
    # The old ceilings dropped ~9912 (half) / ~10872 (compact); the fix drops ~cluster_n-cap
    # (936). Slack g for any boundary rounding.
    assert total_dropped <= (cluster_n - cap) + g, (
        f"isolated cluster capped the spread's depth (scale={spread_scale}, z_max={z}): dropped "
        f"{total_dropped} of {len(cells)} — the separable spread was silently mass-subsampled"
    )


def test_cell_size_z_ceiling_formula() -> None:
    """The cell-size ceiling (T2-118b) is floor(log2(span/max_side)), per axis, the deeper
    (smaller) bound winning; a degenerate axis (zero span or zero-size cells) does not
    constrain, and an all-covering cell / empty set is uncapped (_MAX_DEPTH)."""
    from pipeline.tiler import _MAX_DEPTH, _Cell, _cell_size_z_ceiling

    # span 1, side 0.004072 (the rijks scatter footprint) -> floor(log2(245.6)) = 7.
    rijks = [_Cell(id=0, x=0.5, y=0.5, w=0.004072, h=0.004072)]
    assert _cell_size_z_ceiling(rijks, (0.0, 0.0, 1.0, 1.0)) == 7
    # side exactly one tile at z=3 (0.125) -> floor(log2(8)) = 3.
    eighth = [_Cell(id=0, x=0.5, y=0.5, w=0.125, h=0.125)]
    assert _cell_size_z_ceiling(eighth, (0.0, 0.0, 1.0, 1.0)) == 3
    # The SMALLER per-axis bound wins: a wide-but-short bbox is constrained by its short axis.
    tall_cell = [_Cell(id=0, x=0.5, y=0.5, w=0.01, h=0.2)]
    assert _cell_size_z_ceiling(tall_cell, (0.0, 0.0, 1.0, 1.0)) == 2  # floor(log2(1/0.2))
    # A cell as big as the whole bbox -> ceiling 0 (never subdivide past the root).
    whole = [_Cell(id=0, x=0.5, y=0.5, w=1.0, h=1.0)]
    assert _cell_size_z_ceiling(whole, (0.0, 0.0, 1.0, 1.0)) == 0
    # Degenerate: zero-size cells / zero-span bbox do not constrain -> _MAX_DEPTH.
    zero_cell = [_Cell(id=0, x=0.5, y=0.5, w=0.0, h=0.0)]
    assert _cell_size_z_ceiling(zero_cell, (0.0, 0.0, 1.0, 1.0)) == _MAX_DEPTH


def test_scatter_outlier_compressed_pile_caps_at_cell_size_ceiling() -> None:
    """T2-118b: a synthetic PILE that would previously drive z DEEP now caps at the
    cell-size ceiling so a cell never exceeds ~1 tile (no coarse-render center-crop).

    A scatter cloud compressed into a corner by a few far outliers packs FAR closer than
    the count-derived footprint (side = 0.9/sqrt(n) ≈ 0.0089, pitch ≈ 2e-4): the cells stay
    DISTINCT (the eps floor still judges them separable, not a coincident pile — the old
    #67 concern is unchanged), so subdivision alone would deepen until the bulk resolves —
    ~z=10, where each cell footprint spans ~9 tiles. That is exactly the rijks pathology:
    the coarse spatial render's 3x3 neighbour window cannot draw a cell that wide, so it
    bakes magnified center-crops. The cell-size ceiling instead stops at the deepest z where
    the cell still fits ~1 tile, and the still-piled surplus is in-tile subsampled — MORE
    subsampling than the old resolve-deeply path (the honest trade, T2-118), but no
    center-crops. Reconciliation (placed + dropped == n) holds regardless; the dropped ids
    keep their metadata + detail tier. (Was test_scatter_outlier_compressed_bulk_resolves,
    which asserted the pre-fix deep-resolve — a bake that would center-crop.)"""
    from pipeline.tiler import (
        _Cell,
        _cell_size_z_ceiling,
        _choose_z_max,
        _group_fine_tiles,
        cap_for,
    )

    cap = cap_for(TILE_PX, THUMB_PX)
    bbox = (0.0, 0.0, 1.0, 1.0)
    g = 100
    n = g * g
    side = 0.9 / math.ceil(math.sqrt(n + 4))  # the REAL scatter footprint, ~0.0089

    cells: list[_Cell] = []
    cid = 0
    # 10k DISTINCT bulk compressed into [0.49, 0.51]^2 (1/50 of the bbox) — internal pitch
    # 2e-4, far below `side`. Distinct (separable at the eps floor), but a visual pile.
    for i in range(n):
        x = 0.49 + 0.02 * ((i % g) + 0.5) / g
        y = 0.49 + 0.02 * ((i // g) + 0.5) / g
        cells.append(_Cell(id=cid, x=x, y=y, w=side, h=side))
        cid += 1
    # 4 far outliers that inflate the bbox and compress the bulk.
    for ox, oy in [(0.01, 0.01), (0.99, 0.99), (0.01, 0.99), (0.99, 0.01)]:
        cells.append(_Cell(id=cid, x=ox, y=oy, w=side, h=side))
        cid += 1

    z, _reason = _choose_z_max(cells, bbox, cap)
    ceiling = _cell_size_z_ceiling(cells, bbox)

    # The ceiling is the binding bound (not budget/coincidence): z stops AT it, well short
    # of the ~z=10 the compressed bulk would otherwise resolve to.
    assert z == ceiling, f"expected the cell-size ceiling ({ceiling}) to bind, got z_max={z}"
    assert z < 10, f"the pile should cap shallow (< the ~z=10 deep-resolve), got {z}"
    # THE guarantee: at the chosen z a cell fits within ~1 tile on both axes — so the coarse
    # 3x3 render never has to draw an oversized (center-cropped) cell.
    tile_w = (bbox[2] - bbox[0]) / (1 << z)
    tile_h = (bbox[3] - bbox[1]) / (1 << z)
    assert side <= tile_w + 1e-12 and side <= tile_h + 1e-12, (
        f"cell side {side} exceeds a tile ({tile_w}) at z={z} — the ceiling failed its job"
    )

    buckets, dropped = _group_fine_tiles(cells, bbox, z, cap)
    placed = sum(len(m) for m in buckets.values())
    total_dropped = sum(dropped.values())
    # The pile IS subsampled (the honest trade — the surplus that cannot fit ~1-tile cells)…
    assert total_dropped > 0, "the capped pile must in-tile subsample its surplus"
    # …but nothing is silently lost: full reconciliation (placed + dropped == n).
    assert placed + total_dropped == len(cells), (
        f"reconciliation broken: placed {placed} + dropped {total_dropped} != {len(cells)}"
    )


def test_near_coincident_distinct_cluster_is_depth_bounded() -> None:
    """A near-coincident-but-DISTINCT cluster of > cap cells (e.g. near-duplicate
    embeddings, sub-resolution apart) must NOT force a deep GLOBAL fine level — that would
    explode the surrounding spread to ~n tiles. The tile budget caps z_max: the cluster is
    in-tile subsampled (its cells are visually coincident) while the spread resolves and the
    fine-tile count stays ~O(n/cap)."""
    from pipeline.tiler import (
        _MAX_DEPTH,
        _TILE_BUDGET_FACTOR,
        _Cell,
        _choose_z_max,
        _group_fine_tiles,
        cap_for,
    )

    cap = cap_for(TILE_PX, THUMB_PX)
    bbox = (0.0, 0.0, 1.0, 1.0)
    g = 100
    n_spread = g * g
    side = 0.9 / math.ceil(math.sqrt(n_spread))

    cells: list[_Cell] = []
    cid = 0
    for i in range(n_spread):  # an honest uniform 2-D spread over the unit box
        cells.append(_Cell(id=cid, x=((i % g) + 0.5) / g, y=((i // g) + 0.5) / g, w=side, h=side))
        cid += 1
    cluster_n = 1000
    for j in range(cluster_n):  # 1000 DISTINCT cells packed within a 1e-5 box
        cells.append(
            _Cell(
                id=cid,
                x=0.5 + 1e-5 * ((j % 32) + 0.5) / 32,
                y=0.5 + 1e-5 * ((j // 32) + 0.5) / 32,
                w=side,
                h=side,
            )
        )
        cid += 1

    z, _reason = _choose_z_max(cells, bbox, cap)
    buckets, dropped = _group_fine_tiles(cells, bbox, z, cap)
    total_dropped = sum(dropped.values())
    budget = _TILE_BUDGET_FACTOR * max(1, math.ceil(len(cells) / cap))

    # z_max stays well below the hard ceiling and the fine-tile count within budget.
    assert z < _MAX_DEPTH, f"near-coincident cluster drove z_max to the hard ceiling ({z})"
    assert len(buckets) <= budget, f"fine-tile count {len(buckets)} exceeds budget {budget}"
    # The cluster's surplus IS subsampled (unresolvable within budget)...
    assert total_dropped >= cluster_n - cap, (
        f"the near-coincident cluster should be subsampled (>= {cluster_n - cap}), got {total_dropped}"
    )
    # ...but the surrounding distinct spread is NOT mass-subsampled along with it.
    assert total_dropped <= cluster_n + g, (
        f"the surrounding spread was mass-subsampled too (z={z}, dropped={total_dropped})"
    )


@pytest.mark.parametrize(
    "label,sigma,blobs",
    [("single-gaussian", 0.05, 1), ("multi-blob-umap", 0.03, 20)],
)
def test_clustered_scatter_resolves_within_budget(label: str, sigma: float, blobs: int) -> None:
    """REGRESSION (the tile budget must clear an HONEST clustered layout's tile demand): a
    gaussian / multi-blob embedding scatter — the flagship UMAP/t-SNE shape — is genuinely
    distinct cells and must resolve with ~no drops. Resolving a CLUSTERED spread needs
    ~0.1-0.33 n occupied tiles (more than the uniform ideal n/cap, because one global fine
    level over-resolves the periphery to isolate the dense core); a budget tied too tightly
    to the ideal (an earlier 4x) mass-subsampled 20-40% of these DISTINCT cells. Pure
    _choose_z_max / _group_fine_tiles logic, deterministic via a fixed seed."""
    import random

    from pipeline.tiler import _Cell, _choose_z_max, _group_fine_tiles, cap_for

    cap = cap_for(TILE_PX, THUMB_PX)
    bbox = (0.0, 0.0, 1.0, 1.0)
    n = 10_000
    rng = random.Random(1234)

    def _clamp(v: float) -> float:
        return min(0.999999, max(1e-6, v))

    # Centers kept in [0.2, 0.8] so a small-sigma gaussian does not pile cells against the
    # [0,1] clamp boundary (a clamp pile is genuinely coincident and would be subsampled —
    # an artifact that would muddy what this test isolates: the BUDGET cutting a spread).
    centers = [(0.2 + 0.6 * rng.random(), 0.2 + 0.6 * rng.random()) for _ in range(blobs)]
    cells: list[_Cell] = []
    for i in range(n):
        cx, cy = centers[i % blobs]
        x = _clamp(cx + sigma * rng.gauss(0.0, 1.0))
        y = _clamp(cy + sigma * rng.gauss(0.0, 1.0))
        cells.append(_Cell(id=i, x=x, y=y, w=0.001, h=0.001))

    z, _reason = _choose_z_max(cells, bbox, cap)
    _, dropped = _group_fine_tiles(cells, bbox, z, cap)
    total_dropped = sum(dropped.values())
    # All cells are distinct (continuous gaussian draws); an honest clustered scatter must
    # resolve, not be decimated. < 5% tolerates only genuine same-tile coincidence at the
    # budget edge — NOT the 20-40% an under-sized budget produced (the regression).
    assert total_dropped <= 0.05 * n, (
        f"{label}: clustered scatter mass-subsampled (z_max={z}): dropped {total_dropped} of "
        f"{n} distinct cells — the tile budget is too tight for an honest clustered layout"
    )


def _geo_heavy_tail(n: int, seed: int) -> tuple[list[float], list[float]]:
    """RAW iNat-like lon/lat degrees: 85% of cells in a few tight metro hotspots plus a
    15% globe-spanning sparse tail. The tail is what inflates the raw min/max span and,
    under a min/max aspect fit, compresses the dense hotspots below the tile budget — the
    #67 mechanism. Returned in real degrees (NOT pre-normalized to [0,1]), so the scatter
    plugin's own fit is exercised end to end."""
    import random

    rng = random.Random(seed)
    # Five real metros (lon, lat). Tight 0.05° spread ≈ a few km — a genuine hotspot.
    metros = [(-74.0, 40.7), (2.35, 48.85), (139.7, 35.7), (-0.13, 51.5), (151.2, -33.9)]
    lon: list[float] = []
    lat: list[float] = []
    for i in range(n):
        if rng.random() < 0.85:
            mlon, mlat = metros[i % len(metros)]
            lon.append(mlon + 0.05 * rng.gauss(0.0, 1.0))
            lat.append(mlat + 0.05 * rng.gauss(0.0, 1.0))
        else:
            lon.append(rng.uniform(-180.0, 180.0))
            lat.append(rng.uniform(-85.0, 85.0))
    return lon, lat


def _place_and_tile(
    px: list[float], py: list[float], cap: int
) -> tuple[int, int, int, int]:
    """Bucket already-placed positions through the REAL tiler and return
    (z_max, occupied_tiles, placed, dropped). The bbox is the placed-cell footprint bbox,
    exactly as the baker derives it from the layout (spatial_bbox)."""
    from pipeline.tiler import _Cell, _choose_z_max, _group_fine_tiles

    n = len(px)
    side = 0.9 / max(1, math.ceil(math.sqrt(n)))  # the real scatter footprint
    x0 = max(0.0, min(px) - side / 2)
    y0 = max(0.0, min(py) - side / 2)
    x1 = min(1.0, max(px) + side / 2)
    y1 = min(1.0, max(py) + side / 2)
    bbox = (x0, y0, x1, y1)
    cells = [_Cell(id=i, x=px[i], y=py[i], w=side, h=side) for i in range(n)]
    z, _reason = _choose_z_max(cells, bbox, cap)
    buckets, dropped = _group_fine_tiles(cells, bbox, z, cap)
    return z, len(buckets), sum(len(m) for m in buckets.values()), sum(dropped.values())


def test_geographic_scatter_is_bounded_and_reconcilable() -> None:
    """A WIDE GEOGRAPHIC / heavy-tailed scatter (dense metro hotspots + a sparse global
    tail — the iNat lat/lon shape) is the one realistic scatter the uniform global z_max
    does NOT fully resolve: the sparse tail makes the span cover the globe, the aspect fit
    compresses the hotspots, and resolving them would exceed the tile budget — so a fraction
    of DISTINCT cells is in-tile subsampled (issue #67). This runs the RAW degrees through
    the REAL scatter fit (Scatter Seam S1: median-centred, NO clip — scatter._aspect_fit)
    and pins the SAFETY invariants that must hold REGARDLESS of the fit: bounded z_max well
    below the hard ceiling, fine-tile count within budget, and FULL reconciliation
    |placed| + dropped == n — nothing is ever silently lost.

    Seam S1 deliberately DROPPED the robust-span edge clip (near-worthless at the production
    cap=64, and it margin-jammed the tail — see docs/spikes/spike_scatter_deep_dive.md), so
    this no longer bounds the drop RATE: reconciliation is the guarantee, and the subsampling
    itself is the deferred #67 limitation (non-uniform per-tile z_cap), NOT a clip. A live
    look on real iNat lat/lon ratifies the visible framing change (D-iii)."""
    # The median-centred aspect fit was EXTRACTED to _placement at D-35 Seam G2 (scatter +
    # geographic share it); scatter.py's fit is byte-identical (it re-exports nothing).
    from pipeline.layout_plugins._placement import aspect_fit as _aspect_fit
    from pipeline.tiler import _MAX_DEPTH, _TILE_BUDGET_FACTOR, cap_for

    cap = cap_for(TILE_PX, THUMB_PX)
    n = 10_000
    lon, lat = _geo_heavy_tail(n, seed=7)

    # The REAL median-centred, unclipped fit the plugin now applies (Scatter Seam S1).
    px, py = _aspect_fit(lon, lat, 1.0, 0.95)
    z, occupied, placed, total_dropped = _place_and_tile(px, py, cap)
    budget = _TILE_BUDGET_FACTOR * max(1, math.ceil(n / cap))

    # Safety invariants — a hard floor the wide-geo limitation never crosses.
    assert z < _MAX_DEPTH, f"geo scatter drove z_max to the hard ceiling ({z}) — not bounded"
    assert occupied <= budget, f"fine-tile count {occupied} exceeds budget {budget}"
    # Full reconciliation: every cell is placed or recorded as subsampled — never silently
    # lost. This is the enduring guarantee; the drop RATE is the deferred #67 residual (the
    # S1 framing fix does not clip, so it does not bound the rate — #67's per-tile z_cap does).
    assert placed + total_dropped == n, (
        f"reconciliation broken: placed {placed} + dropped {total_dropped} != {n}"
    )


def test_bake_is_byte_reproducible(tmp_path: Path) -> None:
    """The bake is byte-reproducible: two independent bakes of identical input produce
    byte-identical PMTiles containers. The committed golden fixtures depend on this — a
    fresh regen must byte-match what is checked in (the open verification item from the
    streaming rewrite). Locks the determinism the streaming DFS + _deterministic_gzip +
    uncompressed-Arrow/WebP encoders provide; a non-deterministic regression (dict
    ordering, an un-pinned gzip mtime, a stray timestamp) fails HERE instead of silently
    churning the fixtures. n=80 > cap forces a multi-level pyramid, so the coarse-mosaic
    bodies are covered too, not just the fine tiles."""
    n = 80
    cells = _grid_cells(n)
    bbox = (0.0, 0.0, 1.0, 1.0)
    pyramid_a, out_a = _bake(tmp_path / "a", n, cells, bbox)
    _pyramid_b, out_b = _bake(tmp_path / "b", n, cells, bbox)

    assert pyramid_a.z_cap > 0, "n=80 > cap must build a multi-level pyramid (coarse tiles)"
    assert out_a.read_bytes() == out_b.read_bytes(), (
        "two bakes of identical input differ byte-for-byte — the bake is not reproducible "
        "(committed golden fixtures cannot be trusted to regenerate byte-stably)"
    )


# --- T2-143: the bake never discards silently -------------------------------


def _coincident_cells(n: int) -> pa.Table:
    """``n`` cells at ONE world coordinate — the pyramid stops at z=0 (a deeper level
    cannot separate them) and the single fine tile subsamples to cap, so the drop count
    is exactly ``n - cap`` and is set by nothing but ``n``."""
    return pa.table(
        {
            "id": pa.array(list(range(n)), pa.int64()),
            "x": pa.array([0.5] * n, pa.float32()),
            "y": pa.array([0.5] * n, pa.float32()),
            "w": pa.array([0.01] * n, pa.float32()),
            "h": pa.array([0.01] * n, pa.float32()),
        }
    )


def _ingest_corpus(tmp_path: Path, n: int) -> tuple[Path, Path]:
    """``n`` real images + a metadata CSV whose scatter pair is CONSTANT — every cell lands
    on one coordinate, so the scatter layout is a fully-coincident pile that in-tile
    subsamples to cap. Returns (images_dir, csv_path)."""
    import csv

    images = tmp_path / "images"
    images.mkdir(parents=True, exist_ok=True)
    names = [f"img_{i:04d}.webp" for i in range(n)]
    for i, name in enumerate(names):
        _solid(images / name, 32, 32, [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256])
    csv_path = tmp_path / "meta.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["filename", "sx", "sy"])
        for name in names:
            writer.writerow([name, "1.0", "2.0"])
    return images, csv_path


_SCATTER_ROLES = {
    "filename": {"column": "filename", "label": "Filename"},
    "scatter": [{"x_column": "sx", "y_column": "sy", "label": "Pile"}],
}


def test_the_drop_and_the_failure_both_reach_the_operator(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """T2-143: the two things an operator can read must BOTH carry what happened — the
    dataset's own permanent ``ingest.log``, and the console/caller.

    ``bake_pyramid`` warns on the ``pipeline.tiler`` logger, but a job's logger is
    ``pipeline.worker.<staging-dir>`` with ``propagate = False`` and a lone FileHandler — so
    the tiler's record goes to ROOT (stderr on the CLI, the shared worker-container log on
    the API/RQ path, interleaved with every other job) and NEVER into the dataset's file.
    The permanent record of the bake said only "baked pyramid scatter … (z_cap=0)". The
    mirror case was the caller's: a layout whose bake raised was reported to whoever called
    ``run_ingest`` as a bare "1 layout(s) failed: ['scatter']", with the reason written only
    to the log the caller cannot see.

    Driven through the REAL ``run_ingest`` because the defect lives in the seam between the
    tiler's logger and the worker's; a ``caplog`` assertion on ``pipeline.tiler`` is
    structurally incapable of seeing it (an earlier version of this test asserted exactly
    that and passed throughout). The corpus is a constant scatter pair — every cell on one
    coordinate — so the scatter layout subsamples to cap while grid bakes cleanly."""
    from pipeline.worker import IngestJobPayload, run_ingest

    n = 100  # coincident, cap=64 -> 36 subsampled = 36.00%
    images, csv_path = _ingest_corpus(tmp_path, n)
    output_root = tmp_path / "out"

    def _payload(dataset_id: str) -> IngestJobPayload:
        return IngestJobPayload(
            dataset_id=dataset_id,
            owner="tester",
            images_dir=images,
            csv_path=csv_path,
            column_roles=_SCATTER_ROLES,
            layout_types=["grid", "scatter"],
            output_root=output_root,
            detail_tier="skip",
        )

    # --- the subsample is in the DATASET's own log, with the stop reason ---------------
    # This pins the SURFACE (does it reach the dataset's file at all), not the level — how
    # loud it is depends on the stop reason and is pinned by
    # test_the_subsample_log_level_follows_the_stop_reason. A constant scatter pair is a
    # coincident pile, so this one is INFO.
    run_ingest(_payload("reported"))
    log = (output_root / "reported" / "ingest.log").read_text(encoding="utf-8")
    drop_lines = [line for line in log.splitlines() if "36 of 100" in line]
    assert drop_lines, f"the subsample never reached the dataset's own log:\n{log}"
    assert "scatter" in drop_lines[0], f"...the layout: {drop_lines[0]!r}"
    assert "36.00%" in drop_lines[0], f"...the fraction: {drop_lines[0]!r}"
    # The ACTUAL reason, not a bare "coincidence" — the message's own explanation of what
    # the reasons mean contains all of their names, so a substring match on one of them
    # passes even when no reason was threaded through at all (caught by mutation).
    assert "chosen by 'coincidence'" in drop_lines[0], (
        f"...or the stop reason, which is the only thing that says whether these cells are "
        f"occluded or truncated (T2-145): {drop_lines[0]!r}"
    )

    # --- a FAILED layout's reason reaches the CALLER, not just the log -----------------
    # Any bake failure, not specifically a subsample: the plumbing under test is that the
    # summary carries the reason at all. `run_ingest` imports bake_pyramid lazily FROM
    # pipeline.tiler, so patch it there; grid must still bake for real, or the per-layout
    # containment path this exercises is never reached.
    from pipeline import tiler

    real_bake = tiler.bake_pyramid

    def _boom(*args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        if kwargs.get("layout_id") == "scatter":
            raise RuntimeError("the scatter pyramid could not be baked: synthetic failure")
        return real_bake(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(tiler, "bake_pyramid", _boom)
    with pytest.raises(RuntimeError) as excinfo:
        run_ingest(_payload("failed"))
    raised = str(excinfo.value)
    assert "scatter" in raised, raised
    assert "synthetic failure" in raised, (
        f"the summary names the layout but not why it failed: {raised!r}"
    )
    # ...and the failure did not take its siblings down with it.
    manifest = json.loads(
        (output_root / "failed" / "layout_manifest.json").read_text(encoding="utf-8")
    )
    assert [lv["layout_id"] for lv in manifest["layouts"]] == ["grid"]


def _separable_cluster_cells(n_spread: int, cluster_n: int) -> tuple[pa.Table, int]:
    """A uniform 2-D spread plus a DISTINCT but sub-resolution cluster — the shape whose
    tile demand exceeds the budget, so ``_choose_z_max`` stops on ``tile budget`` while the
    cells are still separating. Returns (cells, n)."""
    g = max(1, math.ceil(math.sqrt(n_spread)))
    side = 0.9 / g
    xs = [((i % g) + 0.5) / g for i in range(n_spread)]
    ys = [((i // g) + 0.5) / g for i in range(n_spread)]
    for j in range(cluster_n):
        xs.append(0.5 + 1e-5 * ((j % 32) + 0.5) / 32)
        ys.append(0.5 + 1e-5 * ((j // 32) + 0.5) / 32)
    n = len(xs)
    return (
        pa.table(
            {
                "id": pa.array(list(range(n)), pa.int64()),
                "x": pa.array(xs, pa.float32()),
                "y": pa.array(ys, pa.float32()),
                "w": pa.array([side] * n, pa.float32()),
                "h": pa.array([side] * n, pa.float32()),
            }
        ),
        n,
    )


def test_the_subsample_log_level_follows_the_stop_reason(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """T2-143: how loud a subsample is depends on WHICH KIND it is, and both directions are
    pinned here.

    An earlier draft refused above a 50 % drop, with an environment-variable opt-out; both
    are gone. Operator decision, once ``z_max_reason`` made the distinction available: "a
    genuine pile does not matter. We don't need to be warned about it or hear about it."

      * ``coincidence`` / ``cell-size ceiling`` -> INFO. The cells are behind other cells at
        every resolution the pyramid can reach, they keep their ``positions_ref`` row (the
        viewer's pile chip reports the true count), and no subdivision would have shown
        them. Here: 200 cells on ONE coordinate, 68 % subsampled — a MAJORITY drop that
        still must not warn, which is the direction a "did it warn?" test cannot see.
      * ``tile budget`` -> WARNING. That stop is only ever REACHED while
        ``overflow_separable`` is still True, so every cell it drops demonstrably would
        have separated one level deeper. This is the lossy case.

    Pins the TILER's own record, which is a different surface from the worker's:
    ``bake_pyramid`` is called directly by ``tests/fixtures/build_fixture.py`` and by any
    future non-worker caller, which get no ingest.log at all. (The DATASET's log is pinned
    separately, through a real ``run_ingest``, by
    ``test_the_drop_and_the_failure_both_reach_the_operator``.)"""
    # --- OCCLUSION: a 68% drop that must NOT warn -----------------------------------
    n = 200  # 200 coincident cells at cap=64 -> 136 subsampled = 68.00%
    with caplog.at_level(logging.INFO, logger="pipeline.tiler"):
        pyramid, out = _bake(tmp_path / "occluded", n, _coincident_cells(n), (0.49, 0.49, 0.51, 0.51))

    assert out.exists(), "a majority subsample must still produce a pyramid"
    assert pyramid.dropped_total == n - pyramid.cap == 136
    assert pyramid.z_max_reason == "coincidence"
    reported = [r for r in caplog.records if "136 of 200" in r.getMessage()]
    assert reported, "the subsample was not reported at all"
    message = reported[0].getMessage()
    assert "grid" in message, f"the report must name the layout: {message!r}"
    assert "68.00%" in message, f"...the fraction: {message!r}"
    assert "chosen by coincidence" in message, f"...and the stop reason: {message!r}"
    assert reported[0].levelno == logging.INFO, (
        f"an occluded pile warned — the cells are behind other cells at every zoom and "
        f"there is nothing to act on (level was {reported[0].levelname})"
    )

    # --- TRUNCATION: separable cells the budget cut off MUST warn ---------------------
    caplog.clear()
    cells, n_budget = _separable_cluster_cells(400, 200)  # -> 'tile budget', 140 dropped
    with caplog.at_level(logging.INFO, logger="pipeline.tiler"):
        lossy, _out = _bake(tmp_path / "truncated", n_budget, cells, (0.0, 0.0, 1.0, 1.0))

    assert lossy.z_max_reason == "tile budget", (
        f"the fixture must exercise the budget stop, got {lossy.z_max_reason!r}"
    )
    assert lossy.dropped_total > 0, "the budget stop must actually drop cells here"
    lossy_records = [
        r for r in caplog.records if f"{lossy.dropped_total} of {n_budget}" in r.getMessage()
    ]
    assert lossy_records, "the budget-stop subsample was not reported at all"
    assert lossy_records[0].levelno == logging.WARNING, (
        f"cells that WOULD have separated were reported at "
        f"{lossy_records[0].levelname} — this is the lossy case"
    )
    assert "chosen by tile budget" in lossy_records[0].getMessage()


def test_the_cell_size_ceiling_yields_for_a_laid_out_narrow_layout() -> None:
    """T2-143 THE regression: when a layout draws its cells LAID OUT (not overlapping) but
    NARROW on one axis, the cell-size ceiling must YIELD — subdivide PAST it to the tile
    budget and keep every cell — instead of capping there and in-tile-subsampling most of the
    dataset. The mirror of ``test_scatter_outlier_compressed_pile_caps_at_cell_size_ceiling``
    (a genuine PILE, where the ceiling correctly binds): here the over-cap tiles are packable,
    so the ceiling stands aside.

    SYNTHETIC cells, and this CHANGED (T2-172). The pin used to run a real packed
    ``DateTimeLayout`` — 12k images, 60 % on one day over 3 years — whose D-36 H1 geometry
    baked a ~0.005-wide histogram that hit the ceiling. D-36 H2 then made a deep bin ``k``
    images WIDE instead of a one-image hairline, so that SAME corpus now bakes ~0.88 wide,
    ``z_max=5`` BELOW its ceiling of 9, and drops nothing at cap=256 — it no longer REACHES
    the ceiling, so it could no longer pin the yield (it failed its own ``packed`` and
    ``z_cap > ceiling`` preconditions). No current plugin produces the laid-out-narrow shape:
    scatter/geographic size cells by COUNT, so they PILE in a narrow region rather than laying
    out (the compressed-pile test above), and datetime wraps wide. So the yield is pinned here
    on a controlled lattice — exactly as the T2-147 COST pin below is, and for the same reason.

    A ``cx`` x ``cy`` lattice of squares on a ``pitch`` grid (side = 0.85·pitch, so cells
    never touch), ``cx`` << ``cy`` so the layout is a narrow vertical ribbon. The per-axis
    ``min`` in ``_cell_size_z_ceiling`` reads the SQUEEZED x-axis and caps shallow, while the
    tall y-axis needs several more levels to get every tile under cap — so honouring the
    ceiling would strand most of the dataset, and the yield is what keeps it."""
    from pipeline.tiler import (
        _MAX_DEPTH,
        _Cell,
        _cell_size_z_ceiling,
        _choose_z_max,
        _group_fine_tiles,
        _level_summary,
        cap_for,
    )

    cap = cap_for(TILE_PX, THUMB_PX)
    cx, cy, pitch = 6, 4_000, 2.4e-4
    side = 0.85 * pitch
    cells = [
        _Cell(id=j * cx + i, x=(i + 0.5) * pitch, y=(j + 0.5) * pitch, w=side, h=side)
        for j in range(cy)
        for i in range(cx)
    ]
    n = len(cells)  # 24_000
    bbox = (0.0, 0.0, cx * pitch, cy * pitch)  # x-span 1.44e-3 (narrow), y-span 0.96 (tall)
    assert bbox[2] - bbox[0] < 0.01, "precondition: the layout is NARROW in x (a shallow ceiling)"

    ceiling = _cell_size_z_ceiling(cells, bbox)
    z_max, reason = _choose_z_max(cells, bbox, cap)

    # The over-cap tiles AT the ceiling are LAID OUT (packable), not a coincident pile — the
    # precondition for the yield, and what tells it apart from the compressed-pile case above.
    eps_x = (bbox[2] - bbox[0]) / (1 << _MAX_DEPTH)
    eps_y = (bbox[3] - bbox[1]) / (1 << _MAX_DEPTH)
    max_occ, _sep, _tiles, packable = _level_summary(
        cells, bbox, ceiling, cap, eps_x, eps_y, side, side
    )
    assert max_occ > cap and packable, (
        f"the fixture must put over-cap, PACKABLE tiles at the ceiling "
        f"(occ={max_occ}, cap={cap}, packable={packable})"
    )

    # NON-VACUITY: honouring the ceiling would in-tile-subsample most of the layout — the T2-143
    # loss (the ledger measured 79.84 % on the 20k datetime shape this stands in for). Computed
    # from the same ``_group_fine_tiles`` the bake sums into ``pyramid.dropped_total``.
    _m_ceiling, dropped_at_ceiling = _group_fine_tiles(cells, bbox, ceiling, cap)
    lost_at_ceiling = sum(dropped_at_ceiling.values())
    assert lost_at_ceiling > 0.5 * n, (
        f"stopping at the ceiling should strand most of the {n} cells (got {lost_at_ceiling}) — "
        f"else the fixture does not exercise the loss the yield prevents"
    )

    # THE FIX: the yield subdivides PAST the ceiling (a laid-out layout, not a pile) and keeps
    # every cell. Fails on the pre-T2-143 code, which capped ``z_max`` AT the ceiling.
    assert z_max > ceiling, (
        f"the cell-size ceiling ({ceiling}) must YIELD for a laid-out layout, got z_max={z_max} "
        f"(reason {reason!r})"
    )
    _m, dropped = _group_fine_tiles(cells, bbox, z_max, cap)
    assert sum(dropped.values()) == 0, f"the yield must keep every cell; dropped {sum(dropped.values())} of {n}"


# The MEASURED geometry of a 20k packed datetime corpus AS SIZED UNDER D-36 H1 — 20,000 images
# with 60 % on one day over a 3-year span, through the real DateTimeLayout at capture time. (H2
# later wrapped deep bins WIDE, so the live plugin no longer bakes this narrow shape; see
# T2-172 — these are frozen as a known INPUT for the ratio arithmetic, not a claim about what
# the plugin outputs today.) Captured
# rather than derived, because the plugin's `side` is `min(pitch, row_h, 2*margin) * fill`
# capped by the tightest real inter-column gap, and no short formula reproduces it:
#
#     columns=36  deepest_stack=12227  side=6.67375498e-05  row_pitch=7.84993172e-05
#     x range=[0.0399999991, 0.0427472666]   y range=[3.9257382e-05, 0.959960759]
#     -> bbox span_x=0.00281400454   z_max=8 (resolution)   ratio 6.0714 x 0.0178
#
# Re-measure with a 20k packed corpus if the datetime layout's sizing ever changes; these
# are a snapshot of a real shape, not a specification of one.
_SHARP_SIDE = 6.67375498e-05
_SHARP_ROW_PITCH = 7.84993172e-05
_SHARP_X_LO = 0.0399999991
_SHARP_X_HI = 0.0427472666
_SHARP_TOP = 0.959960759
_SHARP_COLUMNS = 36
_SHARP_PEAK_DEPTH = 12_227
_SHARP_N = 20_000


def test_the_cell_to_tile_overshoot_is_measured_at_its_sharp_case() -> None:
    """T2-147: pin the MAGNITUDE of what yielding the cell-size ceiling costs the coarse
    overview, at the shape where it bites hardest — without a bake.

    Yielding the ceiling (T2-143) is what stops a narrow layout losing most of itself, and
    the price is that past the ceiling a cell spans more than one tile on the squeezed axis.
    The coarse spatial render only draws cells from the 3x3 neighbour window, so a cell
    wider than ~3 tiles is under-drawn to roughly ``3 / ratio`` of its width. That cost is
    unbounded and ungated (T2-147), so the number itself is the thing to watch.

    WHY THIS EXISTS ALONGSIDE ``test_the_cell_size_ceiling_yields_for_a_laid_out_narrow_layout``:
    that one pins that the yield KEEPS the cells; this one pins the COST of yielding — the
    cell-to-tile ratio (6.07 here, the overview showing ~49 % of each column). Both are now
    SYNTHETIC: D-36 H2 stopped the datetime plugin from ever reaching the cell-size ceiling (it
    wraps deep bins WIDE, so the shape is no longer producible — T2-172), so neither can run a
    real ``DateTimeLayout`` through ``bake_pyramid`` any more. Here the sharp case is pinned
    from synthetic cells carrying the measured 20k geometry: no plugin, no bake, no thumbnails —
    ``_choose_z_max`` and ``_cell_tile_spans`` called directly, in well under a second.

    WHAT THIS DOES NOT COVER, deliberately: it does not exercise ``DateTimeLayout`` (nothing
    does now — T2-172), and its columns are evenly spaced where the real layout's sat on
    calendar boundaries — that simplification preserves the cell size, the x extent and the
    depth the tiler picks, which are the three inputs the ratio has, and nothing else. It is a
    pin on the ARITHMETIC and the DEPTH CHOICE at a known shape, not on the layout that once
    produced the shape."""
    from pipeline.tiler import _Cell, _cell_tile_spans, _choose_z_max

    step = (_SHARP_X_HI - _SHARP_X_LO) / (_SHARP_COLUMNS - 1)
    peak_col = _SHARP_COLUMNS // 2
    xs: list[float] = []
    ys: list[float] = []
    for k in range(_SHARP_PEAK_DEPTH):  # the deep stack that drives the y-resolution
        xs.append(_SHARP_X_LO + peak_col * step)
        ys.append(_SHARP_TOP - k * _SHARP_ROW_PITCH)
    others = [c for c in range(_SHARP_COLUMNS) if c != peak_col]
    rest = _SHARP_N - _SHARP_PEAK_DEPTH
    per, extra = divmod(rest, len(others))
    for j, c in enumerate(others):
        for k in range(per + (1 if j < extra else 0)):
            xs.append(_SHARP_X_LO + c * step)
            ys.append(_SHARP_TOP - k * _SHARP_ROW_PITCH)

    n = len(xs)
    assert n == _SHARP_N
    cells = [_Cell(id=i, x=xs[i], y=ys[i], w=_SHARP_SIDE, h=_SHARP_SIDE) for i in range(n)]
    bbox = (
        max(0.0, min(xs) - _SHARP_SIDE / 2),
        max(0.0, min(ys) - _SHARP_SIDE / 2),
        min(1.0, max(xs) + _SHARP_SIDE / 2),
        min(1.0, max(ys) + _SHARP_SIDE / 2),
    )

    z_max, reason = _choose_z_max(cells, bbox, cap_for(TILE_PX, THUMB_PX))
    # The depth is what the ratio is a function of, so pin it too: a change that quietly
    # bounded the overshoot would do it by stopping shallower, and the ratio alone would
    # then look "better" while cells were being dropped again.
    assert (z_max, reason) == (8, "resolution"), (
        f"the synthetic no longer reproduces the measured 20k depth: {(z_max, reason)}"
    )

    ratio_x, ratio_y = _cell_tile_spans(cells, bbox, z_max)
    assert ratio_y < 1.0, f"the y axis should have room to spare, got {ratio_y}"
    # THE pin: a magnitude, not `> 1`. Deterministic arithmetic over fixed constants, so a
    # tight bound is safe — and anything that bounds, worsens or stops measuring the
    # overshoot moves it. (z=7 would read 3.04, z=9 would read 12.14.)
    assert ratio_x == pytest.approx(6.0714, abs=0.005), (
        f"the cell-to-tile overshoot at the sharp shape moved: {ratio_x:.4f} (was 6.0714). "
        f"If this is a deliberate improvement, T2-147 wants the new number."
    )
    # The overview percentage an operator reads (~49 % here, see the docstring) is a pure
    # consequence of the ratio above — 3.0 / 6.0714 through the coarse 3x3 window — so it is
    # deliberately NOT re-asserted: a pin on a function of ratio_x could only ever fail once
    # the ratio_x pin already had. The code that actually formats that number for a bake,
    # worker._baked_pyramid_line, is unpinned by design here (T2-147, item iii).
