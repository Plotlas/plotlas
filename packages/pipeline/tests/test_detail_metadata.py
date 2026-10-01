"""Native pins for the detail tier dropping the ORIGINAL's embedded metadata.

The detail tier is the only baked artifact re-encoded FROM the original file rather
than from a raw pixel buffer, so it is the only one that can carry the original's EXIF,
XMP or IPTC. libvips copies them by default, which meant a served detail WebP
republished camera make and model, capture timestamps and **GPS coordinates** to every
viewer — measured at 15 of 600 sampled files in one baked corpus, while
``docs/public/DATA_FLOW.md`` promised the opposite
(``T2-the-detail-tier-republishes-every-source-image``).

**What these tests assert on, and why it is not the obvious thing.** The output still
contains a small EXIF chunk that libvips SYNTHESISES from the image's own resolution and
colourspace, so "the output has no EXIF chunk" is false of a CORRECT fix and would go
red on a libvips that stopped writing it — a version pin wearing a privacy test's
clothes. These tests assert on the *payload*: the source's own values, and the fields
libvips exposes for them.

**Why a `png-comment` case and a made-up field.** The drop is an ALLOWLIST, so what
matters is not that the known carriers are listed but that an unlisted one cannot
survive. One test attaches a field no version of this code has heard of and requires it
gone; the PNG case proves a second loader's naming (``png-comment-*``) is covered by
the same rule, since every other fixture here is a JPEG.

NATIVE: needs libvips (pyvips), so marked ``native`` and skipped in the lean test image
via importorskip.
"""
from __future__ import annotations

import struct
from pathlib import Path

import pytest

pytestmark = pytest.mark.native
pyvips = pytest.importorskip("pyvips")  # skip whole module when native deps are absent

from pipeline.worker import (  # noqa: E402
    IngestJobPayload,
    _bake_detail_tier,
    _close_logger,
    _drop_source_metadata,
    _setup_logger,
    _transcode_detail,
    run_ingest,
)

CAMERA = "SECRETCAM"
XMP_PAYLOAD = b"<x:xmpmeta>PRIVATE-XMP</x:xmpmeta>"
PNG_XMP_PAYLOAD = b"<x:xmpmeta>PNG-XMP-PRIVATE</x:xmpmeta>"


def _jpeg_with_metadata(path: Path) -> None:
    """Write a JPEG carrying an ICC profile plus what a camera would add: make, GPS and
    an XMP block. `set_type` is how pyvips writes an exif tag — the string form
    ("value (TYPE, n components, n bytes)") is libvips' own."""
    img = pyvips.Image.black(80, 60).copy(interpretation="srgb").colourspace("srgb")
    img = img.icc_transform("srgb").copy()
    img.set_type(pyvips.GValue.gstr_type, "exif-ifd0-Make", f"{CAMERA} (ASCII, 10 components, 10 bytes)")
    img.set_type(pyvips.GValue.gstr_type, "exif-ifd3-GPSLatitudeRef", "N (ASCII, 2 components, 2 bytes)")
    img.set_type(pyvips.GValue.gstr_type, "exif-ifd3-GPSLatitude", "51 30 0 (RATIONAL, 3 components, 24 bytes)")
    img.set_type(pyvips.GValue.blob_type, "xmp-data", XMP_PAYLOAD)
    img.jpegsave(str(path))


def _png_with_xmp(path: Path) -> None:
    """A PNG carrying XMP — a different loader, the same requirement.

    **It carries XMP and not a text chunk, and that distinction is the test.** A
    `png-comment-*` chunk was the first fixture here and it could not fail: measured on
    libvips 8.14.1, `webpsave` never writes text chunks, so the payload was absent from
    the output whether or not anything was dropped. `xmp-data` set on a PNG does
    round-trip through `pngsave`, and does reach the WebP when the drop is removed."""
    img = pyvips.Image.black(80, 60).copy(interpretation="srgb").copy()
    img.set_type(pyvips.GValue.blob_type, "xmp-data", PNG_XMP_PAYLOAD)
    img.pngsave(str(path))


def _riff_chunks(path: Path) -> list[tuple[str, int]]:
    raw = path.read_bytes()
    out: list[tuple[str, int]] = []
    i = 12  # past "RIFF", size, "WEBP"
    while i + 8 <= len(raw):
        name = raw[i : i + 4].decode("latin1")
        size = struct.unpack("<I", raw[i + 4 : i + 8])[0]
        out.append((name, size))
        i += 8 + size + (size & 1)
    return out


def test_the_source_fixture_really_carries_the_metadata(tmp_path: Path) -> None:
    """The pins below are worthless if the fixtures are clean to begin with — a
    metadata-free original would pass a no-op transcode. Assert the inputs first."""
    src = tmp_path / "original.jpg"
    _jpeg_with_metadata(src)
    loaded = pyvips.Image.new_from_file(str(src))
    fields = loaded.get_fields()
    assert "exif-ifd0-Make" in fields and CAMERA in loaded.get("exif-ifd0-Make")
    assert "exif-ifd3-GPSLatitude" in fields, "fixture lost its GPS tag"
    assert "xmp-data" in fields, "fixture lost its XMP block"
    assert CAMERA.encode() in src.read_bytes()

    png = tmp_path / "original.png"
    _png_with_xmp(png)
    assert "xmp-data" in pyvips.Image.new_from_file(str(png)).get_fields(), (
        "the PNG fixture lost its XMP block, so the second-loader test cannot fail"
    )


def test_the_detail_transcode_drops_exif_xmp_and_gps(tmp_path: Path) -> None:
    """The defect itself: the served detail WebP must not republish the original's
    embedded metadata."""
    src = tmp_path / "original.jpg"
    _jpeg_with_metadata(src)
    out = tmp_path / "0.webp"

    dense_id, ok, dropped = _transcode_detail(0, str(src), str(out), 2048)
    assert (dense_id, ok) == (0, True)
    assert dropped > 0, "nothing was dropped from an original that carries EXIF and XMP"

    raw = out.read_bytes()
    assert CAMERA.encode() not in raw, "the camera model rode into the served detail image"
    assert b"PRIVATE-XMP" not in raw, "the XMP block rode into the served detail image"

    baked = pyvips.Image.new_from_file(str(out))
    carried = [f for f in baked.get_fields() if "GPS" in f or f == "exif-ifd0-Make"]
    assert carried == [], f"source EXIF tags survived the transcode: {carried}"
    assert "xmp-data" not in baked.get_fields()


def test_a_pngs_xmp_is_dropped_too(tmp_path: Path) -> None:
    """A second loader, and a carrier that genuinely reaches the output without the
    drop — so this assertion can fail."""
    src = tmp_path / "original.png"
    _png_with_xmp(src)
    out = tmp_path / "1.webp"

    _dense_id, ok, carried = _transcode_detail(1, str(src), str(out), 2048)
    assert ok and carried == 1, f"expected the PNG's one XMP block to be counted, got {carried}"

    assert PNG_XMP_PAYLOAD not in out.read_bytes(), "the PNG's XMP rode into the served detail image"
    assert "xmp-data" not in pyvips.Image.new_from_file(str(out)).get_fields()


def test_a_metadata_field_this_code_has_never_heard_of_is_dropped(tmp_path: Path) -> None:
    """**The reason the drop is an allowlist.** A denylist of known prefixes is silent
    about a carrier it does not list — a new loader, a renamed field, a libvips upgrade.
    This attaches a field no version of this code knows and requires it gone, so the
    rule is pinned rather than the list."""
    src = tmp_path / "plain.jpg"
    pyvips.Image.black(80, 60).copy(interpretation="srgb").jpegsave(str(src))

    # No format stores a field libvips has no writer for, so it cannot be round-tripped
    # through a file: set it on a live image and drive the allowlist's own helper, which
    # is the unit the rule is written in.
    live = pyvips.Image.new_from_file(str(src)).copy(interpretation="srgb")
    live.set_type(pyvips.GValue.blob_type, "some-future-metadata", b"FUTURE-LEAK")
    dropped = _drop_source_metadata(live)

    assert "some-future-metadata" in dropped, f"an unlisted carrier survived: {dropped}"
    assert "some-future-metadata" not in live.get_fields()
    assert "width" in live.get_fields() and "interpretation" in live.get_fields(), (
        "the allowlist removed a structural field the image needs"
    )


def test_the_colour_profile_is_kept_deliberately(tmp_path: Path) -> None:
    """`icc-profile-data` is excluded from the drop ON PURPOSE: the transcode does not
    ICC-transform, so a wide-gamut original needs its profile to render correctly. The
    residual — ICC text tags can name a device or a person — and the alternative
    (convert once to sRGB, keep nothing) are recorded in
    `T2-the-detail-and-tile-paths-disagree-about-colour`. If a future change strips the
    profile, this fails and the trade-off gets re-decided rather than silently lost."""
    src = tmp_path / "original.jpg"
    _jpeg_with_metadata(src)
    out = tmp_path / "0.webp"

    _transcode_detail(0, str(src), str(out), 2048)

    baked = pyvips.Image.new_from_file(str(out))
    assert "icc-profile-data" in baked.get_fields(), "the colour profile was stripped too"
    assert any(name == "ICCP" for name, _ in _riff_chunks(out))


def test_a_clean_original_counts_zero_in_every_format(tmp_path: Path) -> None:
    """The drop must not become a failure path for the ordinary case, and the per-bake
    count must read **0** for a corpus nobody's camera annotated — **in every format,
    not just JPEG.**

    This is the second version of this test. The first one used a single JPEG and
    passed while the count was measurably wrong everywhere else: GIF reported 5 on a
    clean file, HEIC and AVIF 3, palette and interlaced PNG 1, because those loaders
    attach encoding bookkeeping that the (correct, strict) allowlist drops. A clean
    corpus of iPhone photographs would have logged *"N of N carried photographer
    metadata"*.

    Formats the image's libvips cannot write are skipped rather than failing the run,
    so the test asserts how many it actually exercised — a build that silently lost
    every saver would otherwise pass this vacuously."""
    plain = pyvips.Image.black(64, 48).copy(interpretation="srgb")
    attempts: list[tuple[str, Path, dict[str, object]]] = [
        ("jpeg", tmp_path / "p.jpg", {}),
        ("png", tmp_path / "p.png", {}),
        ("palette png", tmp_path / "pal.png", {"palette": True, "bitdepth": 8}),
        ("interlaced png", tmp_path / "int.png", {"interlace": True}),
        ("webp", tmp_path / "p.webp", {}),
        ("tiff", tmp_path / "p.tif", {}),
        ("gif", tmp_path / "p.gif", {}),
        ("heic", tmp_path / "p.heic", {}),
        ("avif", tmp_path / "p.avif", {}),
    ]

    exercised: list[str] = []
    for i, (label, src, opts) in enumerate(attempts):
        try:
            plain.write_to_file(str(src), **opts)
        except pyvips.Error:
            continue  # this build cannot write that format; counted below
        out = tmp_path / f"out_{i}.webp"
        dense_id, ok, carried = _transcode_detail(i, str(src), str(out), 2048)
        assert (dense_id, ok) == (i, True), f"{label}: transcode failed"
        assert carried == 0, (
            f"{label}: a clean original reported {carried} photographer field(s) — the "
            "per-bake count then reads 'every file carries metadata' and means nothing"
        )
        assert pyvips.Image.new_from_file(str(out)).width == 64
        exercised.append(label)

    assert len(exercised) >= 6, f"only {len(exercised)} format(s) exercised: {exercised}"
    assert "heic" in exercised or "avif" in exercised, (
        "neither HEIC nor AVIF was exercised, and those are the measured over-reporters"
    )


def test_the_count_lands_in_the_datasets_own_log(tmp_path: Path) -> None:
    """**Assert on the FILE, not on captured output.** The count shipped in #381 was
    emitted on `pipeline.worker` while a dataset's `ingest.log` is served by a per-job
    CHILD logger with `propagate = False`: records travel up, never down, so the file
    never saw it, and on the web path (an `rq` worker, no root handler) it was dropped
    entirely. A test reading `caplog` would have passed throughout. This one reads the
    log the operator reads."""
    images = tmp_path / "images"
    images.mkdir()
    for i in range(3):
        _jpeg_with_metadata(images / f"{i:03d}.jpg")
    plain = pyvips.Image.black(80, 60).copy(interpretation="srgb")
    plain.jpegsave(str(images / "999.jpg"))  # one original no camera touched

    out = tmp_path / "out"
    run_ingest(
        IngestJobPayload(
            dataset_id="ds",
            owner="tester",
            images_dir=images,
            csv_path=None,
            column_roles=None,
            layout_types=["grid"],
            output_root=out,
            detail_tier="bake",
        )
    )

    log = (out / "ds" / "ingest.log").read_text(encoding="utf-8")
    assert "carried photographer metadata" in log, (
        "the metadata count is missing from the dataset's own ingest.log — the operator "
        f"reads this file, and it says:\n{log}"
    )
    assert "3 of 4 original(s) carried photographer metadata" in log, (
        f"expected 3 of the 4 originals to be counted; log says:\n{log}"
    )


def test_a_skipped_original_is_named_in_the_datasets_own_log(tmp_path: Path) -> None:
    """The same defect, on the line that matters more than the count: an original that
    cannot be decoded is dropped from the detail tier, and this warning is the only
    record that it happened. Before the fix it reached the shared container stderr and
    never this dataset's file.

    **Driven at `_bake_detail_tier` rather than through `run_ingest`, for a measured
    reason.** A corrupt file never gets that far: the thumbnail stage rejects it first
    (`atlas.py`, *"skipping undecodable image"*) and it is not a survivor, so an
    end-to-end fixture cannot produce this warning at all. The logger here is built
    exactly as `_setup_logger` builds a job's — a per-job child, `propagate = False`,
    one FileHandler — so what the assertion reads is the file an operator reads."""
    detail_dir = tmp_path / "detail" / "v1"
    good = tmp_path / "good.jpg"
    _jpeg_with_metadata(good)
    bad = tmp_path / "truncated.jpg"
    bad.write_bytes(good.read_bytes()[:120])

    # `_setup_logger` itself, not a copy of its four lines: a hand-rolled equivalent
    # keeps pinning a logger shape production has moved on from, and still passes. The
    # backlog item this PR files proposes changing exactly that shape.
    log_path = tmp_path / "ingest.log"
    logger, handler = _setup_logger(log_path)
    try:
        refs = _bake_detail_tier({0: good, 1: bad}, detail_dir, logger)
    finally:
        _close_logger(logger, handler)

    assert set(refs) == {0}, f"expected only the good original to produce a ref: {refs}"

    log = log_path.read_text(encoding="utf-8")
    assert "detail-tier transcode failed for" in log, (
        "an original was dropped from the detail tier and the dataset's log does not "
        f"say so:\n{log}"
    )
    assert "truncated.jpg" in log, f"the skip warning does not name the file:\n{log}"
    assert "1 of 1 original(s) carried photographer metadata" in log, (
        "the count's denominator should be the originals that produced a detail image, "
        f"so a skip moves it:\n{log}"
    )
