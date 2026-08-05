"""Verify a calibration bake against the position-color oracle (run in the worker).

Decodes the baked PMTiles directly (no renderer) and checks, for a dataset produced
by generate_calib.py + `pixscope ingest --layout grid`:

  FINE tiles (z == z_cap): for every cell record, sample the mini-atlas at the
    record's UV centre and compare the sampled RGB to the color the cell's id MUST
    have. Verdict is DELTA-based (robust to lossy-WebP): a swap is a huge delta, WebP
    noise is <=~3. Also assert the record's world (x,y) equals the id's grid slot.

  COARSE tiles (z < z_cap): sample a grid and report TRANSPARENT-pad fraction +
    per-row "full opaque-black row" count -- the re-expressed BANDING signature under
    the v2 ALPHA pad (Seam A / b1). The pad is now fully TRANSPARENT (alpha 0), so an
    empty region reads as transparent, NOT black; the old "full black row" signature
    (coarse composites inheriting a shrunk mini-atlas's opaque black padding) would now
    be a full OPAQUE-black row -- which the transparent pad + spatial render can no
    longer produce. A high transparent fraction is legitimate SPARSITY (a datetime
    overview), not a bug; an opaque-black interior row IS the padding-band regression.

usage: python verify_bake.py DATASET_ID N
"""
import glob
import json
import math
import struct
import sys

import pyarrow as pa
import pyarrow.feather as feather
import pyvips
from pmtiles.reader import MmapSource, Reader

if len(sys.argv) < 3:
    print("usage: python verify_bake.py DATASET_ID N", file=sys.stderr)
    sys.exit(1)

ds = sys.argv[1]
N = int(sys.argv[2])
S = math.ceil(math.sqrt(N))
SWAP_DELTA = 6  # color delta above this is a real packing swap, not WebP noise


def expected(idn):
    col, row = idn % S, idn // S
    R = round(col / (S - 1) * 255) if S > 1 else 128
    G = round(row / (S - 1) * 255) if S > 1 else 128
    return eRGpos(col, row, R, G)


def eRGpos(col, row, R, G):
    return col, row, R, G, (col + 0.5) / S, (row + 0.5) / S


with open(f"/data/datasets/{ds}/layout_manifest.json") as f:
    mani = json.load(f)
pyr = mani["layouts"][0]["pyramid"]
z_cap = pyr["z_cap"]
pmtiles_files = glob.glob(f"/data/datasets/{ds}/tiles/grid/*.pmtiles")
if not pmtiles_files:
    print(f"error: no pmtiles file found for dataset '{ds}' at /data/datasets/{ds}/tiles/grid/", file=sys.stderr)
    sys.exit(1)
r = Reader(MmapSource(open(pmtiles_files[0], "rb")))


def webp(b):
    return pyvips.Image.new_from_buffer(b, "")


def pt(img, fx, fy):
    v = img.getpoint(min(img.width - 1, max(0, fx * img.width)), min(img.height - 1, max(0, fy * img.height)))
    return v[0], v[1], v[2]


def pta(img, fx, fy):
    """Sample RGBA (alpha 255 for a legacy 3-band image). The coarse tier is RGBA
    under the v2 alpha pad (Seam A); alpha distinguishes transparent PAD from opaque
    CONTENT."""
    v = img.getpoint(min(img.width - 1, max(0, fx * img.width)), min(img.height - 1, max(0, fy * img.height)))
    a = v[3] if len(v) > 3 else 255
    return v[0], v[1], v[2], a


# ---- FINE tiles: color-delta + position oracle ----
cells = swap = pos_bad = 0
max_d = 0
bad = []
n = 2 ** z_cap
for x in range(n):
    for y in range(n):
        b = r.get(z_cap, x, y)
        if b is None:
            continue
        ln = struct.unpack(">I", b[:4])[0]
        atlas = webp(b[4:4 + ln])
        tbl = feather.read_table(pa.BufferReader(b[4 + ln:]))
        c = {k: tbl.column(k).to_pylist() for k in tbl.column_names}
        for i, idn in enumerate(c["id"]):
            cells += 1
            R, G, _ = pt(atlas, c["u"][i] + c["uw"][i] / 2, c["v"][i] + c["uh"][i] / 2)
            ecol, erow, eR, eG, ex, ey = expected(idn)
            d = max(abs(R - eR), abs(G - eG))
            max_d = max(max_d, d)
            sw = d > SWAP_DELTA
            pb = abs(c["x"][i] - ex) > 0.02 or abs(c["y"][i] - ey) > 0.02
            if sw:
                swap += 1
            if pb:
                pos_bad += 1
            if (sw or pb) and len(bad) < 12:
                bad.append(dict(tile=(z_cap, x, y), id=idn, sampRG=[R, G], expRG=[eR, eG],
                                recXY=[round(c["x"][i], 4), round(c["y"][i], 4)], expXY=[round(ex, 4), round(ey, 4)]))
verdict = "PASS" if swap == 0 and pos_bad == 0 else "FAIL"
print(f"FINE z{z_cap}: {verdict}  cells={cells}  color_swaps(delta>{SWAP_DELTA})={swap}  pos_errors={pos_bad}  max_color_delta={max_d} (lossy-webp noise ~<=3)")
for s in bad:
    print("  BAD", s)

# ---- COARSE tiles: banding signature (re-expressed against the ALPHA pad) ----
# A pad pixel is now TRANSPARENT (alpha ~0), not opaque black. The regression to catch
# is a full-width interior row of OPAQUE BLACK (alpha high, RGB ~0) — the shrunk
# mini-atlas padding band. A transparent row is legitimate sparsity, reported
# separately (avg_transparent_frac) and never flagged as banding.
GS = 32
ALPHA_OPAQUE = 128  # alpha at/above this is opaque CONTENT; below is (near-)transparent pad
for z in range(0, z_cap):
    nn = 2 ** z
    tiles = sum_transp = banded = 0
    example = None
    for x in range(nn):
        for y in range(nn):
            b = r.get(z, x, y)
            if b is None or b[:4] != b"RIFF":
                continue
            img = webp(b)
            transp = 0
            row_opaque_black = []
            for gy in range(GS):
                ob = 0  # opaque-black samples in this row
                for gx in range(GS):
                    R, G, B, A = pta(img, (gx + 0.5) / GS, (gy + 0.5) / GS)
                    if A < ALPHA_OPAQUE:
                        transp += 1
                    elif R < 8 and G < 8 and B < 8:
                        ob += 1
                row_opaque_black.append(ob)
            # A banded row is a full-width OPAQUE-black interior row (the padding band).
            fbr = sum(1 for v in row_opaque_black if v == GS)
            tiles += 1
            sum_transp += transp / (GS * GS)
            if fbr > 0:
                banded += 1
                example = example or dict(tile=(z, x, y), full_opaque_black_rows=f"{fbr}/{GS}", row_opaque_black=row_opaque_black)
    print(f"COARSE z{z}: tiles={tiles} avg_transparent_frac={sum_transp/max(1,tiles):.3f} banded_tiles={banded}"
          + (f"  (BANDING: producer packs partial mini-atlas OPAQUE padding into the coarse overview)" if banded else ""))
    if example:
        print(f"   e.g. {example['tile']}: full_opaque_black_rows={example['full_opaque_black_rows']} row_opaque_black={example['row_opaque_black']}")
