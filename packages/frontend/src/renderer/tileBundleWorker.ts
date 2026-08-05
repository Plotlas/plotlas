// Dedicated Worker for off-main-thread fine-tile decode (see fineBundleDecoder.ts).
//
// It runs the SAME pure framing functions the loader used to call inline
// (unpackFineTileBundle + cellBuffersFromRecords), so correctness is covered by
// tile_bundle_conformance.test.ts — this file is only the transport: receive raw
// tile bytes, decode, post the image + typed-array buffers back zero-copy.
import { unpackFineTileBundle, cellBuffersFromRecords } from "./tileBundle.ts";
import type { DecodeRequest, DecodeResponse } from "./fineBundleDecoder.ts";

// The frontend tsconfig loads the DOM lib (not the webworker lib), so `self` /
// `postMessage` carry Window types. Narrow `self` to just the worker surface used
// here — cleaner than pulling in the webworker lib and colliding with DOM globals.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null;
  postMessage: (message: DecodeResponse, transfer: ArrayBufferLike[]) => void;
};

ctx.onmessage = (e: MessageEvent<DecodeRequest>): void => {
  const { id, body, level, tileSeq } = e.data;
  try {
    const bundle = unpackFineTileBundle(new Uint8Array(body));
    // Copy the image slice into its OWN buffer so it can be transferred back
    // independently of the incoming body (which also holds the records bytes).
    const image = bundle.image.slice();
    const cells = cellBuffersFromRecords(bundle.records, level, tileSeq);
    ctx.postMessage(
      { id, ok: true, image, cells },
      [
        image.buffer,
        cells.ids.buffer,
        cells.positions.buffer,
        cells.sizes.buffer,
        cells.atlasPage.buffer,
        cells.atlasUv.buffer,
        cells.lod.buffer,
      ],
    );
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
