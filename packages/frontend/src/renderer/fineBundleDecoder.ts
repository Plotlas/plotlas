// Off-main-thread fine-tile decode (decision D-33 perf follow-up).
//
// A FINE tile body is `[uint32 BE image_len][WebP mini-atlas][Arrow IPC records]`
// (see tileBundle.ts). Splitting it and — the expensive part — parsing the Arrow
// record table + mapping it to struct-of-arrays CellBuffers is pure CPU that used
// to run SYNCHRONOUSLY on the main thread inside the loader's per-tile path. During
// a pan a burst of tiles stream in, so that parse janks the frame. This module
// moves it into a Worker: the loader posts the raw tile bytes, the worker runs the
// SAME pure functions (unpackFineTileBundle + cellBuffersFromRecords) and posts the
// image + typed-array buffers back zero-copy (transferables).
//
// The WebP -> GPU-texture decode stays with the loader (createImageBitmap is
// already async / off the main thread); only the synchronous Arrow work moves here.
//
// Node unit tests have no `Worker`, so the loader falls back to `decodeFineBundleSync`
// (the identical in-process path) — the worker is a thin transport over functions
// that are already unit-tested in tile_bundle_conformance.test.ts.
import { unpackFineTileBundle, cellBuffersFromRecords } from "./tileBundle.ts";
import type { CellBuffers } from "./cells.ts";

/** The decoded outputs of one fine tile: the WebP mini-atlas bytes (the loader
 *  turns these into a GPU texture) and the struct-of-arrays cell buffers. */
export interface DecodedFineBundle {
  image: Uint8Array;
  cells: CellBuffers;
}

/** A fine-tile decoder. `decode` unpacks one fine tile body into image + cells
 *  (off-thread in the browser); `terminate` releases any underlying worker. */
export interface FineBundleDecoder {
  decode(body: Uint8Array, level: number, tileSeq: number): Promise<DecodedFineBundle>;
  terminate(): void;
}

/** Wire messages between the loader and the decode worker. Minimal + every payload
 *  transferable. Imported `type`-only by the worker (erased — so the worker bundle
 *  never pulls in `createWorkerFineBundleDecoder` / a nested Worker URL). */
export interface DecodeRequest {
  id: number;
  body: ArrayBuffer;
  level: number;
  tileSeq: number;
}
export type DecodeResponse =
  | { id: number; ok: true; image: Uint8Array; cells: CellBuffers }
  | { id: number; ok: false; error: string };

/** In-process synchronous decode: the fallback when there is no Worker (node unit
 *  tests) and the exact work the worker performs. */
export async function decodeFineBundleSync(
  body: Uint8Array,
  level: number,
  tileSeq: number,
): Promise<DecodedFineBundle> {
  const bundle = unpackFineTileBundle(body);
  return { image: bundle.image, cells: cellBuffersFromRecords(bundle.records, level, tileSeq) };
}

/** A synchronous-in-process decoder (no worker) — the default in environments
 *  without `Worker`, and a handy explicit choice. `terminate` is a no-op. */
export function createSyncFineBundleDecoder(): FineBundleDecoder {
  return { decode: decodeFineBundleSync, terminate: () => {} };
}

/** Create a Worker-backed decoder. Browser-only (`new Worker`); callers guard on
 *  `typeof Worker`. Requests are correlated by an incrementing id; a worker-level
 *  error or `terminate` rejects everything still in flight. */
export function createWorkerFineBundleDecoder(): FineBundleDecoder {
  const worker = new Worker(new URL("./tileBundleWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (v: DecodedFineBundle) => void; reject: (e: unknown) => void }>();
  let nextId = 0;

  worker.onmessage = (e: MessageEvent<DecodeResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (p === undefined) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve({ image: msg.image, cells: msg.cells });
    else p.reject(new Error(msg.error));
  };
  worker.onerror = (e: ErrorEvent) => {
    const err = new Error(`tile-bundle worker error: ${e.message}`);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  // A response that fails structured deserialization fires messageerror, not
  // onmessage — without this the request's promise never settles, its awaiting
  // loadTile never reaches `finally`, and the tile's `inflight` entry wedges (the
  // tile can never be re-requested on a still camera). Reject like onerror; the
  // per-request id is not recoverable from the event, so all in-flight reject.
  worker.onmessageerror = () => {
    const err = new Error("tile-bundle worker response failed to deserialize");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  return {
    decode(body: Uint8Array, level: number, tileSeq: number): Promise<DecodedFineBundle> {
      return new Promise<DecodedFineBundle>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        // Transfer the tile bytes IN zero-copy. pmtilesClient hands us a Uint8Array
        // over its own full buffer (offset 0, whole buffer), so transfer that buffer
        // directly; only copy the slice out if it is ever a partial view.
        const whole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
        const buf = (whole ? body.buffer : body.slice().buffer) as ArrayBuffer;
        const req: DecodeRequest = { id, body: buf, level, tileSeq };
        worker.postMessage(req, [buf]);
      });
    },
    terminate(): void {
      worker.terminate();
      const err = new Error("tile-bundle worker terminated");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    },
  };
}
