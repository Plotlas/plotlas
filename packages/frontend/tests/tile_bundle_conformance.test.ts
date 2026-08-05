// v2 (D-33) — PRODUCER-BYTES conformance. The tile_bundle.test.ts unit tests frame
// a synthetic fine body with Arrow IPC-STREAM, but the producer (pipeline/tiler.py
// `_pack_fine_body` → feather.write_feather) emits Arrow IPC-FILE (ARROW1 / Feather)
// records, not a stream — so a stream-framed unit test is symmetric/hollow. This
// test runs a REAL producer-emitted fine-tile body — the z=0 tile of the committed
// tests/fixtures/golden_dataset_v2/tiles/grid/grid_v1.pmtiles, pulled through the
// REAL pmtilesClient.openPyramidArchive.getTile range path — through
// unpackFineTileBundle + cellBuffersFromRecords, and asserts the WebP slice starts
// with RIFF/WEBP, the records decode, and the field values map into CellBuffers.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openPyramidArchive } from "../src/renderer/pmtilesClient.ts";
import { unpackFineTileBundle, cellBuffersFromRecords } from "../src/renderer/tileBundle.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));
const PMTILES = join(FIXTURES_DIR, "golden_dataset_v2", "tiles", "grid", "grid_v1.pmtiles");

/** Serve the committed .pmtiles file over a mocked globalThis.fetch that honours
 *  the `Range: bytes=a-b` header (206 Partial Content) — exactly what the API/Caddy
 *  static path answers — so openPyramidArchive's FetchRangeSource drives the REAL
 *  pmtiles range reads against the real bytes. */
function withFileFetch<T>(fn: () => Promise<T>): Promise<T> {
  const file = readFileSync(PMTILES); // Buffer (a Uint8Array)
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range ?? "";
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    if (m === null) {
      // Whole-file fetch (the pmtiles client never needs this here, but be safe).
      return new Response(file, { status: 200 });
    }
    const start = Number(m[1]);
    const end = Number(m[2]); // inclusive
    const slice = file.subarray(start, end + 1);
    // A real ArrayBuffer-backed body so res.arrayBuffer() returns the exact slice.
    const body = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${file.byteLength}` } });
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("a REAL producer fine-tile body (committed pmtiles) decodes through the v2 unpack path", async () => {
  await withFileFetch(async () => {
    const archive = openPyramidArchive("https://edge/pyramid/grid.pmtiles", () => ({}));
    const body = await archive.getTile(0, 0, 0); // the golden grid pyramid's single fine tile
    assert.notEqual(body, null, "the committed pmtiles has a tile at 0/0/0");

    // --- framing: [u32 BE image_len][WebP][Arrow IPC-FILE] ---
    const bundle = unpackFineTileBundle(body!);
    // The image slice is a real WebP — a RIFF container with a WEBP fourCC.
    assert.deepEqual(
      [...bundle.image.subarray(0, 4)],
      [0x52, 0x49, 0x46, 0x46],
      "the producer image slice starts with the RIFF magic",
    );
    assert.deepEqual(
      [...bundle.image.subarray(8, 12)],
      [0x57, 0x45, 0x42, 0x50],
      "the RIFF container declares the WEBP fourCC",
    );

    // --- records: the FILE-framed (ARROW1) Arrow table decodes ---
    assert.ok(bundle.records.numRows > 0, "the producer records table is non-empty");
    for (const col of ["id", "x", "y", "w", "h", "u", "v", "uw", "uh"]) {
      assert.notEqual(bundle.records.getChild(col), null, `records carry the required v2 column '${col}'`);
    }

    // --- mapping: cellBuffersFromRecords lands the v2 (u,v,uw,uh) sub-rects in SoA ---
    const buffers = cellBuffersFromRecords(bundle.records, /* z */ 0, /* tileSeq */ 7);
    assert.equal(buffers.count, bundle.records.numRows, "every record becomes a cell");
    // Field values come straight from the producer table (float32-fround compared).
    const idCol = bundle.records.getChild("id")!;
    const xCol = bundle.records.getChild("x")!;
    const uwCol = bundle.records.getChild("uw")!;
    assert.equal(Number(buffers.ids[0]), Number(idCol.get(0)), "id column maps 1:1");
    assert.equal(buffers.positions[0], Math.fround(Number(xCol.get(0))), "x maps into positions");
    assert.equal(buffers.atlasUv[2], Math.fround(Number(uwCol.get(0))), "uw maps into the atlasUv sub-rect");
    // The whole tile shares one synthetic bucket (lod=z, page=tileSeq).
    assert.ok([...buffers.lod].every((l) => l === 0), "all cells carry the tile's z as lod");
    assert.ok([...buffers.atlasPage].every((p) => p === 7), "all cells carry the tile's tileSeq as page");
  });
});
