"""Calibration source-image generator (run in the worker; uses pyvips).

Produces a folder of synthetic source images that, once ingested through the REAL
pipeline (`pixscope ingest --layout grid`), make the baked pyramid verifiable
pixel-exactly against a position-color ORACLE (see verify_bake.py). The dataset is
deliberately colorful and self-describing so a human can also eyeball it.

Each image n is named NNNNN.png so the grid layout's id == sorted-filename order
(D-25), and is a SOLID color encoding its grid position:

    S        = ceil(sqrt(N))            # GridLayout uses cols = ceil(sqrt(n))
    col, row = n % S, n // S            # row-major; world x grows with col, y with row
    R = round(col / (S-1) * 255)        # encodes COLUMN  -> col = round(R/255*(S-1))
    G = round(row / (S-1) * 255)        # encodes ROW     -> row = round(G/255*(S-1))
    B = 64 if (col+row) even else 192   # checker: neighbours differ; coarse averaging
                                        # pulls B -> ~128, a blockiness/level signal

NOTE on robustness: the pipeline encodes mini-atlases as LOSSY WebP, which shifts a
solid color by a few units. With a large grid (S=100) the R/G step is only ~2.5 per
column, so an EXACT (R,G)->col decode is noisy near boundaries. verify_bake.py
therefore judges correctness by the COLOR DELTA (sampled vs expected RGB): WebP
noise is <=~3, a packing swap is huge. Position (the cell record's x,y) is exact and
is the primary identity oracle.

SYNTHETIC METADATA (--emit-metadata): optionally also writes a metadata.csv + a
column_roles.json alongside the images (in the images dir's PARENT), covering EVERY
role, so the dataset can be ingested with `--metadata metadata.csv --column-roles
column_roles.json` and bakes ALL layout types (grid/datetime/scatter/geographic/
categorical/tags). Every field is derived DETERMINISTICALLY from the cell index n (no RNG, no
clock), so a regen is byte-stable in content. The grid color-position oracle is
untouched — metadata rides alongside the same images. See `metadata_rows()` for the
exact per-role construction and its built-in edge cases (null/unplaced scatter rows;
empty + multi-value tag cells). Drives the committed `golden_dataset_full_v2`
all-layouts contract fixture (recipe in tests/fixtures/golden_dataset_full_v2/).

usage:
    python generate_calib.py N OUTDIR [PX=64]                    # images only (calib_small_v2)
    python generate_calib.py N OUTDIR [PX=64] --emit-metadata    # + all-role metadata CSV/roles
"""
import csv
import datetime as _dt
import json
import math
import os
import sys

import pyvips

# --- synthetic-metadata generation (deterministic; derived from the cell index) ---

# Datetime role: one calendar day per cell from this epoch, so N cells span N days —
# a genuine multi-month/multi-year range the datetime layout spreads along its time
# axis (a real, non-degenerate datetime pyramid). iso8601 dates, ingest parses them.
_DATE_ORDINAL_0 = _dt.date(2021, 1, 1).toordinal()  # fixed epoch, no clock

# Scatter role: MOST cells land in a few tight clusters (the dense bulk), a small
# fraction in a WIDE SPARSE TAIL (huge coordinates), and a few carry NO coordinate
# (empty CSV cell -> the scatter layout's unplaced strip). The tail exercises the
# median-centred, unclipped aspect fit (scatter.py `_aspect_fit`, Seam S1): the median keeps
# the dense bulk centred while the sparse tail spreads to the box edge, uncropped.
_SCATTER_CLUSTERS = [(0.0, 0.0), (10.0, 4.0), (3.0, 9.0), (-6.0, 7.0)]  # cluster centres
_SCATTER_TAIL_EVERY = 37   # every 37th cell is a far sparse-tail outlier
_SCATTER_TAIL_SPAN = 900.0  # tail cells sit ~hundreds of units out (the wide tail)
_SCATTER_NULL_EVERY = 29    # every 29th cell has NO coordinate -> unplaced strip

# Geographic role (D-35 Seam G2): cells cluster around a handful of real-world "cities"
# (tight jitter), globally spread so the projected + median-centred fit is a non-degenerate
# MAP that subdivides to a real coarse tier (like every other layout, z_cap >= 1). A few
# cells carry NO coordinate (the unplaced strip), and a few sit at a HIGH latitude
# (~78°) — VALID under the fixture's baked equirectangular projection (which is valid to
# the poles); it is OUT of Web-Mercator range, whose |lat| <= 85.051129 fail-fast is
# unit-tested separately, NOT baked here (the fixture bakes the default equirectangular).
_GEO_CITIES = [
    (-74.006, 40.713),   # New York
    (139.692, 35.690),   # Tokyo
    (2.352, 48.857),     # Paris
    (151.209, -33.868),  # Sydney
    (-58.381, -34.603),  # Buenos Aires
    (18.424, -33.925),   # Cape Town
]
_GEO_NULL_EVERY = 29     # every 29th cell has NO coordinate -> the unplaced strip
_GEO_POLAR_EVERY = 83    # a few high-latitude (~78°) cells — equirectangular to the pole


def _date_iso(n: int) -> str:
    """The datetime-role value for cell n: an iso8601 date, one day per cell from the
    fixed epoch. Deterministic (ordinal arithmetic; no clock)."""
    return _dt.date.fromordinal(_DATE_ORDINAL_0 + n).isoformat()


def _scatter_xy(n: int) -> tuple[str, str]:
    """The scatter-role (x, y) for cell n as CSV strings. Empty strings for the
    ``_SCATTER_NULL_EVERY`` cells (an unplaced cell — null coords). Sparse-tail cells
    (``_SCATTER_TAIL_EVERY``) sit far out to exercise the robust fit; the rest jitter
    deterministically within one of a few clusters (the dense bulk). All finite."""
    if n % _SCATTER_NULL_EVERY == 0:
        return "", ""  # unplaced: no coordinate (the scatter layout's strip)
    if n % _SCATTER_TAIL_EVERY == 0:
        # Wide sparse tail: push far out along a direction derived from n. A pure
        # function of n (deterministic); large magnitude so it dominates the raw span.
        angle = (n % 8) / 8.0 * 2.0 * math.pi
        return (
            f"{_SCATTER_TAIL_SPAN * math.cos(angle):.4f}",
            f"{_SCATTER_TAIL_SPAN * math.sin(angle):.4f}",
        )
    cx, cy = _SCATTER_CLUSTERS[n % len(_SCATTER_CLUSTERS)]
    # Deterministic sub-cluster jitter: two decorrelated integer hashes in [-0.5, 0.5).
    jx = ((n * 2654435761) % 1000) / 1000.0 - 0.5
    jy = ((n * 40503) % 1000) / 1000.0 - 0.5
    return f"{cx + jx:.4f}", f"{cy + jy:.4f}"


def _lon_lat(n: int) -> tuple[str, str]:
    """The geographic-role (lon, lat) for cell n as CSV strings (D-35 Seam G2). Empty
    strings for the ``_GEO_NULL_EVERY`` cells (an unplaced cell -> the strip). Every
    ``_GEO_POLAR_EVERY`` cell sits at a HIGH latitude (~78°, valid under the baked
    equirectangular projection); the rest cluster tightly around one of a few real-world
    cities (the dense bulk -> a real map that subdivides to a coarse tier). All within
    lon [-180,180] / lat [-90,90]. Deterministic (integer hashes; no RNG/clock)."""
    if n % _GEO_NULL_EVERY == 0:
        return "", ""  # unplaced: no coordinate (the geographic layout's strip)
    if n % _GEO_POLAR_EVERY == 0:
        # High latitude — valid under equirectangular (baked), out of Web-Mercator range.
        lat = 78.0 if (n // _GEO_POLAR_EVERY) % 2 == 0 else -78.0
        lon = float((n * 47) % 360) - 180.0
        return f"{lon:.4f}", f"{lat:.4f}"
    clon, clat = _GEO_CITIES[n % len(_GEO_CITIES)]
    # Deterministic sub-city jitter in ~[-0.4, 0.4)° (two decorrelated integer hashes),
    # tight so each city stays one cluster (<= cap) — the map subdivides without a
    # pathological coincident pile.
    jx = ((n * 2246822519) % 800) / 1000.0 - 0.4
    jy = ((n * 3266489917) % 800) / 1000.0 - 0.4
    return f"{clon + jx:.4f}", f"{clat + jy:.4f}"


def _tags(n: int) -> str:
    """The tag-role value for cell n: a ``|``-delimited multi-value string. Built to
    include BOTH edge cases the tag pipeline must handle: an EMPTY cell (no tags) and
    genuine MULTI-VALUE cells. Vocabulary of a few colors/sizes keyed off n."""
    if n % 7 == 0:
        return ""  # empty tag cell (no highlight for this cell)
    colors = ["red", "green", "blue"]
    sizes = ["small", "large"]
    parts = [colors[n % 3]]
    if n % 2 == 0:
        parts.append(sizes[(n // 2) % 2])  # even cells are multi-value
    return "|".join(parts)


def metadata_rows(n_images: int) -> list[dict]:
    """The synthetic metadata table (one dict per cell), covering every role. Pure
    function of the image count — deterministic, no RNG/clock. Columns:

      * ``filename``          — join key (the image basename, matches D-25 id order)
      * ``captured``          — datetime role (iso8601 date, one day per cell)
      * ``sx``/``sy``         — scatter role (clustered + wide tail + some null coords)
      * ``lon``/``lat``       — geographic role (city clusters + polar + some null coords)
      * ``group``             — categorical role, LOW cardinality (3 distinct values)
      * ``bucket``            — categorical role, HIGHER cardinality (12 distinct values)
      * ``tags``              — tag role, ``|``-delimited (empty + multi-value cells)
      * ``caption``           — freeform role (display-only)
    """
    rows: list[dict] = []
    for n in range(n_images):
        sx, sy = _scatter_xy(n)
        lon, lat = _lon_lat(n)
        rows.append(
            {
                "filename": f"{n:05d}.png",
                "captured": _date_iso(n),
                "sx": sx,
                "sy": sy,
                "lon": lon,
                "lat": lat,
                "group": f"group-{n % 3}",       # low cardinality (3)
                "bucket": f"bucket-{n % 12:02d}",  # higher cardinality (12)
                "tags": _tags(n),
                "caption": f"cell-{n:05d}",
            }
        )
    return rows


def column_roles() -> dict:
    """The column_roles config mapping the synthetic columns to their roles — valid
    against schemas/v2/column_roles.schema.json. Two categorical columns of DIFFERENT
    cardinality (group=3, bucket=12) so the multi-entry categorical family expands to
    two distinct layouts; a single scatter pair; a single GEOGRAPHIC pair (lon/lat, the
    default equirectangular projection — D-35 Seam G2); a ``|``-delimited tag column; a
    freeform display column."""
    return {
        "filename": {"column": "filename", "label": "Filename"},
        "datetime": {"column": "captured", "label": "Captured", "format": "iso8601"},
        "scatter": [{"x_column": "sx", "y_column": "sy", "label": "Scatter"}],
        "geographic": [{"lon_column": "lon", "lat_column": "lat", "label": "Location"}],
        "categorical": [
            {"column": "group", "label": "Group"},
            {"column": "bucket", "label": "Bucket"},
        ],
        "tag": [{"column": "tags", "label": "Tags", "delimiter": "|"}],
        "freeform": [{"column": "caption", "label": "Caption"}],
    }


def write_metadata(outdir: str, n_images: int) -> tuple[str, str]:
    """Write ``metadata.csv`` + ``column_roles.json`` next to the images dir (in its
    PARENT, so `--images OUTDIR --metadata metadata.csv` from OUTDIR/.. is clean).
    Returns the two written paths."""
    parent = os.path.dirname(os.path.abspath(outdir.rstrip(os.sep))) or "."
    rows = metadata_rows(n_images)
    csv_path = os.path.join(parent, "metadata.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    roles_path = os.path.join(parent, "column_roles.json")
    with open(roles_path, "w", encoding="utf-8") as fh:
        json.dump(column_roles(), fh, indent=2)
    return csv_path, roles_path


def generate_images(n_images: int, outdir: str, px: int) -> int:
    """Write the N position-color source images; returns the grid side S = ceil(sqrt N).
    Unchanged color-position oracle (verify_bake.py checks against it)."""
    os.makedirs(outdir, exist_ok=True)
    s = math.ceil(math.sqrt(n_images))
    for n in range(n_images):
        col, row = n % s, n // s
        r = round(col / (s - 1) * 255) if s > 1 else 128
        g = round(row / (s - 1) * 255) if s > 1 else 128
        b = 64 if (col + row) % 2 == 0 else 192
        img = (pyvips.Image.black(px, px, bands=3) + [r, g, b]).cast("uchar").copy(interpretation="srgb")
        img.write_to_file(os.path.join(outdir, f"{n:05d}.png"))
    return s


def main(argv: list[str]) -> None:
    emit_metadata = "--emit-metadata" in argv
    positional = [a for a in argv if not a.startswith("--")]
    n_images = int(positional[0])
    outdir = positional[1]
    px = int(positional[2]) if len(positional) > 2 else 64

    s = generate_images(n_images, outdir, px)
    msg = f"generated {n_images} images, grid {s}x{s}, px={px}, at {outdir}"
    if emit_metadata:
        csv_path, roles_path = write_metadata(outdir, n_images)
        msg += f"; wrote {csv_path} + {roles_path} (all roles)"
    print(msg)


if __name__ == "__main__":
    main(sys.argv[1:])
