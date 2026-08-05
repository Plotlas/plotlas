// v2 (D-33): the FINE tile body framing `[uint32 BE image_len][webp][arrow]`.
// Pure byte-framing tests — GL-free, no PMTiles, no fetch. Builds a synthetic
// fine body and asserts unpackFineTileBundle splits it correctly and
// cellBuffersFromRecords maps the v2 (u,v,uw,uh) record columns into CellBuffers.
import assert from "node:assert/strict";
import test from "node:test";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { Table } from "apache-arrow";

import {
  readFineImageLength,
  unpackFineTileBundle,
  cellBuffersFromRecords,
} from "../src/renderer/tileBundle.ts";

/** Build a v2 fine-tile cell-record table (the columns cell_record.schema.json
 *  pins for a fine tile). */
function makeRecordTable(
  cells: { id: number; x: number; y: number; w?: number; h?: number; u?: number; v?: number; uw?: number; uh?: number }[],
): Table {
  return tableFromArrays({
    id: BigInt64Array.from(cells.map((c) => BigInt(c.id))),
    x: Float32Array.from(cells.map((c) => c.x)),
    y: Float32Array.from(cells.map((c) => c.y)),
    w: Float32Array.from(cells.map((c) => c.w ?? 0.1)),
    h: Float32Array.from(cells.map((c) => c.h ?? 0.1)),
    u: Float32Array.from(cells.map((c) => c.u ?? 0)),
    v: Float32Array.from(cells.map((c) => c.v ?? 0)),
    uw: Float32Array.from(cells.map((c) => c.uw ?? 0.125)),
    uh: Float32Array.from(cells.map((c) => c.uh ?? 0.125)),
  });
}

/** Frame a fine tile body: [uint32 BE image_len][image][arrow records]. */
function frameFineBody(image: Uint8Array, records: Table): Uint8Array {
  const recordBytes = tableToIPC(records, "stream");
  const out = new Uint8Array(4 + image.byteLength + recordBytes.byteLength);
  new DataView(out.buffer).setUint32(0, image.byteLength, false); // big-endian
  out.set(image, 4);
  out.set(recordBytes, 4 + image.byteLength);
  return out;
}

test("readFineImageLength reads the big-endian uint32 prefix", () => {
  const body = new Uint8Array([0x00, 0x00, 0x01, 0x2c, 0xff, 0xff]); // 0x12c = 300
  assert.equal(readFineImageLength(body), 300);
});

test("readFineImageLength throws on a body too short for the prefix", () => {
  assert.throws(() => readFineImageLength(new Uint8Array([1, 2, 3])), /too short/);
});

test("unpackFineTileBundle splits the body into the webp slice and the arrow table", () => {
  const image = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5]); // fake 'RIFF…' webp
  const records = makeRecordTable([
    { id: 0, x: 0.1, y: 0.2 },
    { id: 1, x: 0.3, y: 0.4 },
  ]);
  const body = frameFineBody(image, records);

  const bundle = unpackFineTileBundle(body);
  assert.deepEqual([...bundle.image], [...image], "webp slice is byte-identical");
  assert.equal(bundle.records.numRows, 2, "arrow table round-trips");
  assert.equal(Number(bundle.records.getChild("id")!.get(0)), 0);
  assert.equal(Number(bundle.records.getChild("id")!.get(1)), 1);
});

test("unpackFineTileBundle round-trips a zero-length image (degenerate)", () => {
  const records = makeRecordTable([{ id: 7, x: 0.5, y: 0.5 }]);
  const body = frameFineBody(new Uint8Array(0), records);
  const bundle = unpackFineTileBundle(body);
  assert.equal(bundle.image.byteLength, 0);
  assert.equal(bundle.records.numRows, 1);
  assert.equal(Number(bundle.records.getChild("id")!.get(0)), 7);
});

test("unpackFineTileBundle throws when the declared image length overruns the body", () => {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, 1000, false); // claims a 1000-byte image in an 8-byte body
  assert.throws(() => unpackFineTileBundle(body), /overruns/);
});

test("cellBuffersFromRecords maps v2 (u,v,uw,uh) columns into CellBuffers SoA", () => {
  const records = makeRecordTable([
    { id: 3, x: 0.1, y: 0.2, w: 0.05, h: 0.06, u: 0.0, v: 0.0, uw: 0.25, uh: 0.25 },
    { id: 4, x: 0.7, y: 0.8, w: 0.05, h: 0.06, u: 0.25, v: 0.5, uw: 0.25, uh: 0.25 },
  ]);
  const buf = cellBuffersFromRecords(records, /* level */ 2, /* tileSeq */ 9);

  assert.equal(buf.count, 2);
  assert.equal(Number(buf.ids[0]), 3);
  assert.equal(Number(buf.ids[1]), 4);
  // positions x,y interleaved
  assert.deepEqual([...buf.positions], [0.1, 0.2, 0.7, 0.8].map((n) => Math.fround(n)));
  // sizes w,h interleaved
  assert.deepEqual([...buf.sizes], [0.05, 0.06, 0.05, 0.06].map((n) => Math.fround(n)));
  // atlasUv u,v,uw,uh interleaved (NOT the v1 atlas_* family)
  assert.deepEqual(
    [...buf.atlasUv],
    [0.0, 0.0, 0.25, 0.25, 0.25, 0.5, 0.25, 0.25].map((n) => Math.fround(n)),
  );
  // every cell of a tile lands in the SAME synthetic bucket (lod=level, page=tileSeq)
  assert.deepEqual([...buf.lod], [2, 2]);
  assert.deepEqual([...buf.atlasPage], [9, 9]);
});

test("cellBuffersFromRecords throws on a missing required column", () => {
  const incomplete = tableFromArrays({
    id: BigInt64Array.from([0n]),
    x: Float32Array.from([0.1]),
    // y missing
  });
  assert.throws(() => cellBuffersFromRecords(incomplete, 0, 0), /missing required column 'y'/);
});
