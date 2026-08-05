"""Per-cell square thumbnail decoding for the v2 spatial tile pyramid.

v2 REWORK (decision D-33): the v1 shared id-ordered atlas (32/128/512px thumbnails
packed into 4096² WebP pages, addressed by ``atlas_page`` + ``atlas_uv`` + ``lod``)
is GONE. Pixels are no longer stored against the image id; they are stored against
*space*, per layout, by the fixed-area tiler (``tiler.py``). The 512px LOD2 tier —
88% of the v1 on-disk footprint and 100% of the 100k crash — is dropped entirely
(renderer-rework-plan §4).

This module's job in v2 is therefore narrowed to ONE thing: decode each source
image **exactly once** to a single cover-cropped square thumbnail at ``thumb_px``
(the mid-tier resolution, default 64), and stage those thumbnails to an on-disk
cache the tiler can random-access by id. The tiler then packs the relevant
thumbnails into each layout's per-tile mini-atlas (a fine tile) and shrinks them
into mosaic composites (coarse tiles). One decode feeds every layout and every
band — there is no per-LOD page builder and no shared atlas any more.

The decode itself keeps the Spike-01 / D-32 / PR12-1 properties verbatim:
  * **crop-to-fill** — ``thumbnail(path, thumb_px, height=thumb_px, crop="centre")``
    shrinks-on-load, scales to *cover* the cell, and centre-crops the overflow, so
    a thumbnail fills its square with no black border; a sub-cell source is
    upscaled to fill;
  * **decode-once** — one path-decode per image (no separate probe pass);
  * **skip-and-log** — an undecodable image is recorded in ``skipped`` and excluded;
    it never raises (the one expected broad-skip case);
  * **parallel + deterministic** — decode runs across a stdlib
    ``ProcessPoolExecutor`` (``spawn``, ``VIPS_CONCURRENCY=1`` per worker to avoid
    libvips oversubscription / the glib fork-deadlock); results are consumed in id
    order, so the surviving-id set is deterministic.

Thumbnails are written to ``cache_dir/{id}.thumb`` as a tiny self-describing raw
blob (a 12-byte header ``px,bands,reserved`` + the row-major ``uchar`` buffer),
re-read by ``read_thumbnail`` / ``thumbnail_to_image``. Raw (not WebP) so the tiler
re-encodes once per tile with no double lossy pass and no per-thumb decode cost.
"""
from __future__ import annotations

import logging
import os
import struct
from collections import deque
from collections.abc import Callable, Iterable, Iterator
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from multiprocessing import get_context
from pathlib import Path
from typing import TypeVar

import pyvips

# Bound the decode parallelism so a 100k run does not spawn an unbounded pool;
# os.cpu_count() with a sane cap. Decode is CPU/IO-bound per image and isolated
# per worker (libvips), so saturating the cores is the goal.
_MAX_DECODE_WORKERS_CAP = 16

# How many images may be in flight (submitted-but-not-yet-consumed) at once. The
# decoded thumbnails for these images are the only ones held in memory at a time
# (each is then streamed to the on-disk cache and freed), so this bounds memory.
# A multiple of the worker count keeps every worker fed without buffering the
# whole corpus. Consumed strictly in id order (see _iter_decoded).
_INFLIGHT_PER_WORKER = 4

# On-disk thumbnail blob: a 12-byte little-endian header (px, bands, reserved)
# followed by the row-major uchar pixel buffer. Self-describing so the tiler can
# reconstitute a pyvips image without a manifest.
_THUMB_MAGIC = struct.Struct("<III")  # px, bands, reserved(=0)

logger = logging.getLogger(__name__)

_R = TypeVar("_R")


def vips_pool_map(
    fn: Callable[..., _R], arg_tuples: Iterable[tuple]
) -> Iterator[_R]:
    """Map ``fn`` over ``arg_tuples`` in a bounded ``spawn`` ``ProcessPoolExecutor``,
    yielding each ``fn(*args)`` result in INPUT order (FIFO). The single home for the
    libvips fork/concurrency dance every per-image pass needs (decode here,
    detail-tier transcode in ``worker._bake_detail_tier``).

    ``fn`` must be a top-level (picklable) callable that does its own libvips work in
    the worker and returns a small, picklable result — the heavy image never crosses
    the process boundary. Results are yielded lazily so the caller can stream them to
    disk without buffering the whole corpus; the in-flight window
    (``_MAX_DECODE_WORKERS_CAP`` × ``_INFLIGHT_PER_WORKER``) bounds how many are held
    at once.

    Why a process pool, ``spawn``, and ``VIPS_CONCURRENCY=1``: libvips initializes a
    glib thread pool on first use, so forking an already-threaded parent deadlocks
    the child at its first libvips call — hence ``spawn``, not the Linux-default
    ``fork``. Each worker's libvips is pinned to ONE thread because the pool already
    supplies the parallelism; multi-threaded libvips per worker would oversubscribe
    the cores. The env var is set only for the spawn window — children read it at
    their fresh-interpreter start, before importing pyvips — and restored on exit. A
    trivial corpus (≤1 task) or a single core runs inline: no pool, no spawn
    overhead, no env toggle.

    IMPORTANT: the ``VIPS_CONCURRENCY`` restore runs when this generator is exhausted
    (or closed), so callers must drive it to completion. Both current callers consume
    every result.
    """
    items = list(arg_tuples)
    if not items:
        return
    max_workers = max(1, min(_MAX_DECODE_WORKERS_CAP, os.cpu_count() or 1))
    if len(items) == 1 or max_workers == 1:
        for args in items:
            yield fn(*args)
        return

    window = max_workers * _INFLIGHT_PER_WORKER
    prev_conc = os.environ.get("VIPS_CONCURRENCY")
    os.environ["VIPS_CONCURRENCY"] = "1"
    try:
        with ProcessPoolExecutor(
            max_workers=max_workers, mp_context=get_context("spawn")
        ) as pool:
            pending: deque[Future[_R]] = deque()
            next_to_submit = 0
            n = len(items)
            while next_to_submit < n or pending:
                while next_to_submit < n and len(pending) < window:
                    pending.append(pool.submit(fn, *items[next_to_submit]))
                    next_to_submit += 1
                yield pending.popleft().result()  # oldest first → input order
    finally:
        if prev_conc is None:
            os.environ.pop("VIPS_CONCURRENCY", None)
        else:
            os.environ["VIPS_CONCURRENCY"] = prev_conc


@dataclass(frozen=True)
class ThumbnailCache:
    """Result of decoding a corpus to per-cell square thumbnails.

    ``cache_dir`` holds one ``{id}.thumb`` blob per renderable cell (the original
    sorted-filename id of every image that decoded). ``ids`` is that surviving id
    set, ascending; ``skipped`` is the undecodable image paths (excluded, logged).
    The thumbnails are square ``thumb_px`` (cover-cropped, D-32).

    NOTE on ids: these are still the *original* sorted-filename ids (so they key
    the just-written metadata.parquet). The worker re-maps them to a contiguous
    dense [0, image_count) range for the v2 cell_record contract; see
    worker._densify_ids.
    """

    cache_dir: Path
    thumb_px: int
    ids: list[int]          # surviving (decodable) cell ids, ascending
    skipped: list[str]      # image paths that failed to decode


@dataclass(frozen=True)
class _Thumb:
    """A decoded thumbnail as a flat raw buffer, picklable across the process
    boundary (a ``pyvips.Image`` is not). ``data`` is the row-major RGB ``uchar``
    buffer ``write_to_memory`` produced; ``px`` is the (square) edge."""

    px: int
    bands: int
    data: bytes


# A worker's result for one image: its square thumbnail, or None if it failed to
# decode (the skip).
_DecodeResult = "_Thumb | None"


def _thumb_path(cache_dir: Path, cell_id: int) -> Path:
    return cache_dir / f"{cell_id}.thumb"


def _decode_thumbnail(path_str: str, thumb_px: int) -> "_Thumb | None":
    """Decode ONE image to a single cover-cropped square thumbnail at ``thumb_px``.

    Runs in a pool worker process. Cover-crops+resizes on load (shrink-on-load +
    centre-crop, D-32), forces the decode inside the guard (``copy_memory`` —
    libvips is lazy and a corrupt body otherwise faults later, Spike 01). Returns a
    ``_Thumb``, or ``None`` if the image is undecodable — the decode failure IS the
    skip signal. Never raises for image corruption (the one expected skip case).
    """
    try:
        img = pyvips.Image.thumbnail(path_str, thumb_px, height=thumb_px, crop="centre")
        if img.hasalpha():
            img = img.flatten(background=[0, 0, 0])
        img = img.colourspace("srgb").copy(interpretation="srgb")
        # Force the decode now, inside this guard (Spike 01): pull pixels so a
        # corrupt body raises here, not lazily later.
        img = img.copy_memory()
    except pyvips.Error:
        return None  # the skip — recorded by the caller, never raised
    # write_to_memory() returns a cffi buffer, not picklable across the spawn
    # boundary; materialize to plain bytes.
    return _Thumb(px=img.width, bands=img.bands, data=bytes(img.write_to_memory()))


def thumbnail_to_image(thumb: _Thumb) -> "pyvips.Image":
    """Reconstitute a raw thumbnail buffer into a square sRGB pyvips image."""
    return pyvips.Image.new_from_memory(
        thumb.data, thumb.px, thumb.px, thumb.bands, "uchar"
    ).copy(interpretation="srgb")


def read_thumbnail(cache_dir: Path, cell_id: int) -> _Thumb:
    """Read one cached thumbnail blob back into a ``_Thumb`` (tiler side)."""
    raw = _thumb_path(cache_dir, cell_id).read_bytes()
    px, bands, _ = _THUMB_MAGIC.unpack_from(raw, 0)
    return _Thumb(px=px, bands=bands, data=raw[_THUMB_MAGIC.size:])


def _write_thumbnail(cache_dir: Path, cell_id: int, thumb: _Thumb) -> None:
    header = _THUMB_MAGIC.pack(thumb.px, thumb.bands, 0)
    _thumb_path(cache_dir, cell_id).write_bytes(header + thumb.data)


def decode_thumbnails(
    image_index: list[tuple[int, Path]],
    thumb_px: int,
    cache_dir: Path,
    on_progress: Callable[[int, int], None] | None = None,
) -> ThumbnailCache:
    """Decode every image once to a square ``thumb_px`` thumbnail (cover-cropped,
    D-32) and stage them to ``cache_dir/{id}.thumb`` for the tiler.

    Replaces v1 ``pack_atlas``: there is no shared atlas and no per-LOD page
    builder in v2 — pixels are tiled spatially per layout by ``tiler.py``. Each
    image is decoded exactly once (PR12-1) in a ``ProcessPoolExecutor`` worker;
    decoded thumbnails are streamed back in id order and written to the on-disk
    cache (never all held in memory). Unreadable images are skipped and recorded
    in ``ThumbnailCache.skipped``; they never raise. Deterministic: results are
    consumed in id order, so the surviving-id set is stable across runs.

    ``on_progress(done, total)`` (optional, Seam O1) is invoked in the parent-side
    consumer loop as each image's decode result is streamed back — ``done`` counts
    every image PROCESSED (decoded or skipped), ``total`` is the image count. The
    worker's ``thumbs`` stage reporter supplies it (throttled); None is a no-op.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    ids: list[int] = []
    skipped: list[str] = []
    total = len(image_index)
    for processed, (cell_id, path, result) in enumerate(
        _iter_decoded(image_index, thumb_px), start=1
    ):
        if result is None:
            logger.warning("skipping undecodable image: %s", path)
            skipped.append(str(path))
        else:
            _write_thumbnail(cache_dir, cell_id, result)
            ids.append(cell_id)
        if on_progress is not None:
            on_progress(processed, total)  # absolute count; the reporter throttles
    return ThumbnailCache(cache_dir=cache_dir, thumb_px=thumb_px, ids=ids, skipped=skipped)


def _iter_decoded(
    image_index: list[tuple[int, Path]],
    thumb_px: int,
) -> Iterator[tuple[int, Path, "_Thumb | None"]]:
    """Yield ``(cell_id, path, decode_result)`` in **id order** while decoding each
    image once (``_decode_thumbnail``) under ``vips_pool_map``'s bounded sliding
    window. ``vips_pool_map`` yields results in input (id) order, so the
    surviving-id set is deterministic; pairing each result back with its
    ``(cell_id, path)`` by position recovers the per-image context for logging.
    """
    results = vips_pool_map(
        _decode_thumbnail, [(str(path), thumb_px) for _, path in image_index]
    )
    for i, result in enumerate(results):
        cell_id, path = image_index[i]
        yield cell_id, path, result
