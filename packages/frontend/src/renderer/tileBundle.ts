// v2 tile-body framing (schemas/v2/tile.schema.json — decision D-33).
//
// One {z}/{x}/{y} range request against a layout's PMTiles container returns one
// tile body. There are two kinds, selected by the tile's z relative to the
// manifest's `pyramid.z_cap`:
//
//   * COARSE (z < z_cap): the body is RAW WebP mosaic bytes — no length prefix,
//     no trailing data. The whole body is the composite overview image.
//   * FINE  (z >= z_cap): the body is a length-prefixed bundle:
//        [uint32 BIG-ENDIAN image_len][WebP mini-atlas (image_len bytes)][Arrow IPC records]
//     The 4-byte big-endian prefix gives the WebP length; the Arrow IPC record
//     table (uncompressed, D-29) is everything after the image. Records are
//     cell_record v2 rows (id, x, y, w, h, u, v, uw, uh, ...).
//
// This module owns ONLY the PURE byte framing (GL-free, unit-tested): splitting a
// fine body into its WebP slice + Arrow table, and mapping the cell-record table
// to struct-of-arrays CellBuffers. Decoding the WebP into a GPU texture is the
// loader's browser-only job (tilePyramid.ts) and is not unit-tested.
import { tableFromIPC } from "apache-arrow";
import type { Table } from "apache-arrow";
import type { CellBuffers } from "./cells.ts";

/** A fine tile's body split into its two payloads. `image` is the WebP mini-atlas
 *  bytes (decoded to a texture by the loader); `records` is the decoded Arrow
 *  cell-record table for this tile. */
export interface FineTileBundle {
  image: Uint8Array;
  records: Table;
}

/** Minimum fine-tile body: a 4-byte length prefix. A body shorter than this is
 *  malformed (a real fine tile additionally carries the image + records). */
const LEN_PREFIX_BYTES = 4;

/**
 * Read the big-endian uint32 WebP length prefix of a FINE tile body. Pure +
 * exported for unit tests. Throws on a body too short to hold the prefix.
 */
export function readFineImageLength(body: Uint8Array): number {
  if (body.byteLength < LEN_PREFIX_BYTES) {
    throw new Error(`fine tile body too short (${body.byteLength} bytes) to hold the 4-byte length prefix`);
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return view.getUint32(0, false); // big-endian (false === BE)
}

/**
 * Unpack a FINE tile body — `[uint32 BE image_len][WebP][Arrow IPC]` — into its
 * WebP mini-atlas bytes and decoded Arrow record table. Pure (no GPU, no
 * createImageBitmap), so it is unit-tested directly. Throws on a malformed frame
 * (truncated prefix or a declared image length that overruns the body).
 */
export function unpackFineTileBundle(body: Uint8Array): FineTileBundle {
  const imageLen = readFineImageLength(body);
  const imageStart = LEN_PREFIX_BYTES;
  const imageEnd = imageStart + imageLen;
  if (imageEnd > body.byteLength) {
    throw new Error(
      `fine tile image length ${imageLen} overruns the ${body.byteLength}-byte body (image would end at ${imageEnd})`,
    );
  }
  // subarray shares the underlying buffer — no copy. apache-arrow's tableFromIPC
  // accepts a Uint8Array view over the records slice.
  const image = body.subarray(imageStart, imageEnd);
  const recordBytes = body.subarray(imageEnd);
  const records = tableFromIPC(recordBytes);
  return { image, records };
}

function toBigInt64(arr: ArrayLike<number | bigint>): BigInt64Array {
  if (arr instanceof BigInt64Array) return arr;
  const out = new BigInt64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = BigInt(arr[i] as number);
  return out;
}

function toFloat32(arr: ArrayLike<number>): Float32Array {
  return arr instanceof Float32Array ? arr : Float32Array.from(arr as ArrayLike<number>);
}

/**
 * Map a decoded FINE-tile cell-record table to struct-of-arrays `CellBuffers`
 * (the buffers cells.ts consumes). v2 RE-SCOPE of the v1 cellBuffersFromTable:
 * the UV sub-rect columns are `u, v, uw, uh` (into THIS tile's mini-atlas), not
 * the v1 `atlas_u/v/w/h` (into a shared global atlas page). There is no
 * `atlas_page`/`lod` column — the tile IS the texture, so the loader assigns the
 * synthetic `(lod=z, page=tileSeq)` texture-bucket key itself (see tilePyramid.ts)
 * and passes it in via `level` + `tileSeq`. Column-wise typed-array copies, no
 * per-row object materialization. Pure + exported for unit tests.
 */
export function cellBuffersFromRecords(records: Table, level: number, tileSeq: number): CellBuffers {
  const col = (name: string) => {
    const c = records.getChild(name);
    if (c === null) throw new Error(`fine tile records missing required column '${name}'`);
    return c;
  };
  const n = records.numRows;
  const xs = toFloat32(col("x").toArray() as ArrayLike<number>);
  const ys = toFloat32(col("y").toArray() as ArrayLike<number>);
  const ws = toFloat32(col("w").toArray() as ArrayLike<number>);
  const hs = toFloat32(col("h").toArray() as ArrayLike<number>);
  const us = toFloat32(col("u").toArray() as ArrayLike<number>);
  const vs = toFloat32(col("v").toArray() as ArrayLike<number>);
  const uws = toFloat32(col("uw").toArray() as ArrayLike<number>);
  const uhs = toFloat32(col("uh").toArray() as ArrayLike<number>);

  const positions = new Float32Array(n * 2);
  const sizes = new Float32Array(n * 2);
  const atlasUv = new Float32Array(n * 4);
  const lodArr = new Int8Array(n);
  const pageArr = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    positions[2 * i] = xs[i];
    positions[2 * i + 1] = ys[i];
    sizes[2 * i] = ws[i];
    sizes[2 * i + 1] = hs[i];
    atlasUv[4 * i] = us[i];
    atlasUv[4 * i + 1] = vs[i];
    atlasUv[4 * i + 2] = uws[i];
    atlasUv[4 * i + 3] = uhs[i];
    // The whole tile maps to ONE texture bucket; cells.ts keys buckets on
    // `${lod}:${page}`, so we reuse that mechanism unchanged — lod=level (z),
    // page=tileSeq — to land every cell of this tile in the same bucket.
    lodArr[i] = level;
    pageArr[i] = tileSeq;
  }
  return {
    ids: toBigInt64(col("id").toArray() as ArrayLike<number | bigint>),
    positions,
    sizes,
    atlasPage: pageArr,
    atlasUv,
    lod: lodArr,
    count: n,
  };
}
