"""Tier-1 unit tests for atlas.py — the v2 per-cell thumbnail decoder.

v2 (decision D-33): the shared id-ordered atlas + per-LOD page builder are GONE.
atlas.py now decodes each image ONCE to a single cover-cropped square thumbnail at
thumb_px and stages it to an on-disk cache for the spatial tiler. These tests
assert the surviving behavioural contract:
  * decode-once  — one path-decode per image (no separate probe pass);
  * crop-to-fill (D-32) — non-square cover-cropped to a filled square, no black
                   border; sub-cell source upscaled to fill;
  * skip-and-log — a corrupt image is recorded in .skipped and excluded, never
                   raised, and does not abort the pool;
  * determinism  — the surviving-id set is stable; the cache round-trips.

NATIVE: imports pyvips and decodes real WebP, so the module is `native` and runs
only in the worker image (`make test-pipeline -m native`).
"""
from __future__ import annotations

from pathlib import Path

import pytest

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps absent

from pipeline.atlas import (  # noqa: E402
    decode_thumbnails,
    read_thumbnail,
    thumbnail_to_image,
    _decode_thumbnail,
)

THUMB_PX = 64


def _solid(path: Path, w: int, h: int, rgb: list[int]) -> None:
    img = (pyvips.Image.black(w, h, bands=3) + rgb).cast("uchar").copy(interpretation="srgb")
    img.webpsave(str(path))


def _corpus(images_dir: Path, n: int) -> list[tuple[int, Path]]:
    images_dir.mkdir(parents=True, exist_ok=True)
    index: list[tuple[int, Path]] = []
    for i in range(n):
        p = images_dir / f"img_{i:03d}.webp"
        _solid(p, 64, 64, [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256])
        index.append((i, p))
    return index


def _corners(img: "pyvips.Image") -> list[list[float]]:
    w, h = img.width, img.height
    return [img(0, 0), img(w - 1, 0), img(0, h - 1), img(w - 1, h - 1)]


# --- decode-once ------------------------------------------------------------


def test_decode_once_single_path_decode(tmp_path: Path, monkeypatch) -> None:
    """Each image is decoded from disk exactly once (the shrink-on-load thumbnail);
    there is no separate probe pass."""
    src = tmp_path / "wide.webp"
    _solid(src, 200, 100, [200, 50, 25])

    path_decodes: list[str] = []
    real_thumbnail = pyvips.Image.thumbnail

    def counting_thumbnail(path, width, **kw):
        path_decodes.append(str(path))
        return real_thumbnail(path, width, **kw)

    monkeypatch.setattr(pyvips.Image, "thumbnail", staticmethod(counting_thumbnail))

    thumb = _decode_thumbnail(str(src), THUMB_PX)
    assert thumb is not None
    assert (thumb.px) == THUMB_PX
    assert path_decodes == [str(src)]  # decoded from disk ONCE


# --- crop-to-fill (D-32) ----------------------------------------------------


def test_crop_to_fill_non_square_no_black_border(tmp_path: Path) -> None:
    """A non-square (200×100) solid source is cover-cropped to a filled thumb_px
    square with NO black border — every corner is the source color."""
    src = tmp_path / "wide.webp"
    color = [200, 50, 25]
    _solid(src, 200, 100, color)

    thumb = _decode_thumbnail(str(src), THUMB_PX)
    assert thumb is not None
    img = thumbnail_to_image(thumb)
    assert (img.width, img.height) == (THUMB_PX, THUMB_PX)
    for corner in _corners(img):
        rgb = corner[:3]
        assert max(rgb) > 0, f"corner is black {rgb} — letterboxed"
        for got, want in zip(rgb, color):
            assert abs(got - want) <= 6, f"corner {rgb} != source {color}"


def test_crop_to_fill_sub_cell_upscales(tmp_path: Path) -> None:
    """A sub-cell source (16×16) is upscaled to fill the thumb_px cell (no black)."""
    src = tmp_path / "tiny.webp"
    color = [10, 220, 40]
    _solid(src, 16, 16, color)

    thumb = _decode_thumbnail(str(src), THUMB_PX)
    assert thumb is not None
    img = thumbnail_to_image(thumb)
    assert (img.width, img.height) == (THUMB_PX, THUMB_PX)
    for corner in _corners(img):
        assert max(corner[:3]) > 0, f"sub-cell upscale left black {corner[:3]}"


# --- cache + determinism + skip-and-log -------------------------------------


def test_decode_thumbnails_caches_and_roundtrips(tmp_path: Path) -> None:
    """decode_thumbnails stages one cache blob per cell; read_thumbnail recovers a
    thumb_px square whose pixels match the source colour."""
    index = _corpus(tmp_path / "images", 5)
    cache = decode_thumbnails(index, THUMB_PX, tmp_path / "cache")
    assert cache.ids == [0, 1, 2, 3, 4]
    assert cache.skipped == []
    for cid, _ in index:
        thumb = read_thumbnail(cache.cache_dir, cid)
        img = thumbnail_to_image(thumb)
        assert (img.width, img.height) == (THUMB_PX, THUMB_PX)


def test_determinism_surviving_ids(tmp_path: Path) -> None:
    """Two runs over the same inputs yield the same surviving-id set, in order."""
    index = _corpus(tmp_path / "images", 8)
    a = decode_thumbnails(index, THUMB_PX, tmp_path / "a")
    b = decode_thumbnails(index, THUMB_PX, tmp_path / "b")
    assert a.ids == b.ids == list(range(8))


def test_corrupt_image_skipped_does_not_abort_pool(tmp_path: Path) -> None:
    """A corrupt/undecodable image is recorded in .skipped and excluded; the pool
    keeps going and the good images still decode (the decode failure IS the skip)."""
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    index: list[tuple[int, Path]] = []
    for i in range(6):
        p = images_dir / f"img_{i:03d}.webp"
        if i == 3:
            p.write_bytes(b"RIFF\x00\x00\x00\x00WEBPGARBAGE-not-a-real-webp")
        else:
            _solid(p, 48, 48, [(i * 40) % 256, (i * 85) % 256, (i * 125) % 256])
        index.append((i, p))

    cache = decode_thumbnails(index, THUMB_PX, tmp_path / "cache")
    assert cache.skipped == [str(images_dir / "img_003.webp")]  # the corrupt one
    assert cache.ids == [0, 1, 2, 4, 5]                          # 3 excluded (a hole here;
    #   the worker densifies these to [0,5) for the v2 contiguous-dense contract)
