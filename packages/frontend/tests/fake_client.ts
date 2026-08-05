// Test-local fake ApiClient + GL-free stubs for the renderer/UI unit tests.
// v2 (decision D-33): implements the v2 ApiClient surface over the committed
// tests/fixtures/golden_dataset_v2/ tree — getManifest reads the v2 JSON,
// pyramidUrl/detailUrl/tagsUrl return URLs/paths, fetchTags reads the Arrow
// sidecar. There is no more tileUrl/tileIndexUrl/atlasUrl/fetchTile (the shared
// id-ordered atlas + per-LOD quadtree index are gone). Write/admin methods throw
// — they are not used in tests.
//
// NOT part of the renderer's public surface; never imported by src/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableFromIPC } from "apache-arrow";
import type { Table } from "apache-arrow";
import type { ApiClient } from "../src/api-client/client.ts";
import type { CellBuffers, Cells, CellsHandle } from "../src/renderer/cells.ts";
import type { LayoutManifest, TagsDecl } from "../src/renderer/layout.ts";
import type { BBox, TilePyramid } from "../src/renderer/tilePyramid.ts";
import type { CameraState, Viewport, World } from "../src/renderer/world.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));

export const GOLDEN_DATASET_DIR = join(FIXTURES_DIR, "golden_dataset_v2");
export const GOLDEN_DATASET_IMAGES_ONLY_DIR = join(FIXTURES_DIR, "golden_dataset_images_only_v2");

export interface FakeClientOptions {
  /** Rewrite the manifest before the client serves it (version-guard tests,
   *  synthetic layout entries, ...). Applied once at construction. */
  doctorManifest?: (manifest: LayoutManifest) => LayoutManifest;
}

export function createFakeClient(
  fixtureDir: string = GOLDEN_DATASET_DIR,
  opts: FakeClientOptions = {},
): ApiClient {
  const raw = JSON.parse(
    readFileSync(join(fixtureDir, "layout_manifest.json"), "utf8"),
  ) as LayoutManifest;
  const manifest = opts.doctorManifest !== undefined ? opts.doctorManifest(raw) : raw;

  const notUsed = (name: string) => () => {
    throw new Error(`fake client: ${name} is not used in tests`);
  };

  return {
    listDatasets: notUsed("listDatasets"),
    getDataset: notUsed("getDataset"),
    listLayouts: notUsed("listLayouts"),
    async getManifest(): Promise<LayoutManifest> {
      return manifest;
    },
    pyramidUrl(_dsId: string, layoutId: string): string {
      const entry = manifest.layouts.find((l) => l.layout_id === layoutId);
      if (entry === undefined) throw new Error(`fake client: unknown layout '${layoutId}'`);
      return join(fixtureDir, entry.pyramid.path);
    },
    detailUrl(_dsId: string, cellId: number, ext: string): string {
      const detail = manifest.layouts.find((l) => l.detail != null)?.detail;
      const prefix = detail?.path_prefix ?? "detail/";
      return join(fixtureDir, prefix, `${cellId}.${ext}`);
    },
    staticDetailUrl(_dsId: string, cellId: number): string {
      // T2-26: the overlay's static-edge detail URL. Over this disk-backed fake it is
      // the same fixture path as detailUrl (no Caddy edge in the unit tier); the
      // overlay's OWN unit test injects a controllable client + fake fetch instead.
      const detail = manifest.layouts.find((l) => l.detail != null)?.detail;
      const prefix = detail?.path_prefix ?? "detail/";
      const ext = detail?.format ?? "webp";
      return join(fixtureDir, prefix, `${cellId}.${ext}`);
    },
    authHeaders(): Record<string, string> {
      return {};
    },
    async refreshDatasetCredential(): Promise<boolean> {
      // Tests over this fake read from disk (no cookie/edge), so a credential
      // refresh is a no-op that reports "not refreshed" — nothing 401s here.
      return false;
    },
    tagsUrl(): string {
      const tags: TagsDecl | null | undefined = manifest.tags;
      if (tags === undefined || tags === null) {
        throw new Error("fake client: manifest declares no tags sidecar");
      }
      return join(fixtureDir, tags.path);
    },
    async fetchTags(url: string): Promise<Table> {
      return tableFromIPC(readFileSync(url));
    },
    positionsUrl(_dsId: string, layoutId: string): string | null {
      // v2.2 (T2-66/T2-48): the layout's position-table path, read from the (possibly
      // doctored) manifest. null when the layout declares no positions_ref — which is
      // the case for the committed pre-2.2 fixtures, so most renderer tests exercise
      // the graceful-absence path unless they doctor a ref in.
      const entry = manifest.layouts.find((l) => l.layout_id === layoutId);
      const ref = entry?.positions_ref;
      if (ref === undefined || ref === null || ref === "") return null;
      return join(fixtureDir, ref);
    },
    async fetchPositions(url: string): Promise<Table> {
      return tableFromIPC(readFileSync(url));
    },
    getMetadata: notUsed("getMetadata"),
    createDataset: notUsed("createDataset"),
    getJob: notUsed("getJob"),
  };
}

// ---------------------------------------------------------------------------
// GL-free stubs (unit tests never construct a WebGL context)
// ---------------------------------------------------------------------------

export interface StubWorld {
  world: World;
  /** Push a camera change to subscribers (world's immediate-emit contract is
   *  NOT simulated; tests drive explicitly). */
  emit(state: CameraState, viewport: Viewport): void;
  /** Fire dispose(): runs onDispose teardown hooks (the loader's abort/free). */
  dispose(): void;
  /** Dispatch a `webglcontextlost`/`webglcontextrestored` event at the canvas so
   *  the loader's recovery handlers run. Returns whether default was prevented
   *  (loss handler must call preventDefault for the browser to restore). */
  fireContextLost(): boolean;
  fireContextRestored(): void;
  /** Recorded halt/resume render-loop calls (context-loss recovery assertions). */
  readonly halts: number;
  readonly resumes: number;
  /** Meshes currently added to the (stub) scene — overview tiles. */
  readonly sceneObjects: Set<unknown>;
}

/** A minimal EventTarget-like canvas the loader binds context-loss listeners to.
 *  Node has a global EventTarget, but we want a synchronous, inspectable dispatch
 *  that honours preventDefault, so we model just the surface the loader uses. */
class FakeCanvas {
  private listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, cb: EventListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: EventListener): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string): boolean {
    let prevented = false;
    const ev = { type, preventDefault: () => { prevented = true; } } as unknown as Event;
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
    return prevented;
  }
}

export function createStubWorld(): StubWorld {
  const subscribers = new Set<(state: CameraState, viewport: Viewport) => void>();
  const disposeHooks = new Set<() => void>();
  const sceneObjects = new Set<unknown>();
  const canvas = new FakeCanvas();
  let halts = 0;
  let resumes = 0;
  let disposed = false;

  const world = {
    scene: {
      add(obj: unknown) { sceneObjects.add(obj); },
      remove(obj: unknown) { sceneObjects.delete(obj); },
    },
    camera: {},
    renderer: { domElement: canvas },
    maxTextureSize: 4096,
    resize() {},
    onCameraChange(cb: (state: CameraState, viewport: Viewport) => void): () => void {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    start() {},
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cb of disposeHooks) cb();
    },
    // WorldHandle surface the loader's lifecycle/recovery wiring consumes.
    onDispose(cb: () => void) {
      if (disposed) { cb(); return; }
      disposeHooks.add(cb);
    },
    haltRenderLoop() { halts++; },
    resumeRenderLoop() { resumes++; },
  } as unknown as World;

  return {
    world,
    emit(state, viewport) {
      for (const cb of subscribers) cb(state, viewport);
    },
    dispose() {
      (world as unknown as { dispose(): void }).dispose();
    },
    fireContextLost() {
      return canvas.dispatch("webglcontextlost");
    },
    fireContextRestored() {
      canvas.dispatch("webglcontextrestored");
    },
    get halts() { return halts; },
    get resumes() { return resumes; },
    sceneObjects,
  };
}

/** One recorded Cells mutation, in call order, so a loader test can assert that
 *  setAtlasTexture(z,tileSeq) precedes setBuffers(z,tileSeq) for the same tile. */
export type CellsCall =
  | { kind: "atlas"; lod: number; page: number; isPlaceholder: boolean }
  | { kind: "buffers"; lod: number; page: number; count: number };

export interface StubCells extends CellsHandle {
  buffersReceived: CellBuffers[];
  visibilityReceived: Uint8Array[];
  /** Ordered log of setAtlasTexture / setBuffers (loader-orchestration tests). */
  calls: CellsCall[];
  /** Tiles dropped via dropTile(lod,page) — the v2 eviction removal path. */
  drops: { lod: number; page: number }[];
  /** Count of handleContextRestored() calls (context-loss recovery test). */
  contextRestores: number;
  medianWidth: number;
}

export function createStubCells(medianWidth = 0): StubCells {
  const stub: StubCells = {
    buffersReceived: [],
    visibilityReceived: [],
    calls: [],
    drops: [],
    contextRestores: 0,
    medianWidth,
    setBuffers(buffers: CellBuffers): void {
      stub.buffersReceived.push(buffers);
      // Record the synthetic (lod, page) every cell of this tile shares (the
      // loader maps a whole fine tile to one bucket; -1 lod ⇒ no cells).
      const lod = buffers.count > 0 ? buffers.lod[0] : -1;
      const page = buffers.count > 0 ? buffers.atlasPage[0] : -1;
      stub.calls.push({ kind: "buffers", lod, page, count: buffers.count });
    },
    setAtlasTexture(lod: number, page: number, _texture: unknown, isPlaceholder = false): void {
      stub.calls.push({ kind: "atlas", lod, page, isPlaceholder });
    },
    dropTile(lod: number, page: number): void {
      stub.drops.push({ lod, page });
    },
    setVisibility(visible: Uint8Array): void {
      stub.visibilityReceived.push(visible);
    },
    pick(): { cellId: number | null } {
      return { cellId: null };
    },
    dispose(): void {},
    residentCount(): number {
      let n = 0;
      for (const b of stub.buffersReceived) n += b.count;
      return n;
    },
    residentOnPage(): number {
      return 0;
    },
    medianCellWidth(): number {
      return stub.medianWidth;
    },
    handleContextRestored(): void {
      stub.contextRestores++;
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Fake PMTiles archive (loader-orchestration tests)
// ---------------------------------------------------------------------------

/** A fake PyramidArchive over a canned `${z}/${x}/${y}` -> body map. A missing
 *  address resolves to null (the loader then draws the parent — the fallback). */
export interface FakeArchive {
  /** Map tile addresses ("z/x/y") to raw bodies; null/absent ⇒ a tile miss. */
  bodies: Map<string, Uint8Array | null>;
  /** Tile addresses requested, in order (de-dupe / order assertions). */
  requested: string[];
  getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null>;
}

export function createFakeArchive(bodies: Map<string, Uint8Array | null>): FakeArchive {
  const archive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      // Resolve on a microtask so the loader's generation/abort gate is exercised
      // (a synchronous resolve would never let a mid-load supersede land).
      await Promise.resolve();
      if (signal?.aborted === true) {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      return bodies.get(key) ?? null;
    },
  };
  return archive;
}

export interface StubPyramid extends TilePyramid {
  activations: { layoutId: string; frame: BBox | null }[];
  /** Count of beginLayoutSwitch() calls — lets a test assert switchTo bumps the
   *  generation at entry. */
  switchStarts: number;
  /** Optional gate awaited INSIDE activateLayout before it records/settles — a
   *  re-entrancy test holds the first switch open while a second one lands. */
  activateGate: (() => Promise<void>) | null;
  /** When set, the NEXT activateLayout call rejects with this error (once) —
   *  the failed-switch tests drive the controller's error path with it. */
  failNextActivate: Error | null;
}

export function createStubPyramid(manifest: LayoutManifest): StubPyramid {
  const stub: StubPyramid = {
    activations: [],
    switchStarts: 0,
    activateGate: null,
    failNextActivate: null,
    manifest,
    activeLayoutId(): string | null {
      return stub.activations.length > 0 ? stub.activations[stub.activations.length - 1].layoutId : null;
    },
    onCameraChange(): void {},
    beginLayoutSwitch(): void {
      stub.switchStarts++;
    },
    async activateLayout(next: LayoutManifest, layoutId: string, frame: BBox | null): Promise<void> {
      if (stub.failNextActivate !== null) {
        const err = stub.failNextActivate;
        stub.failNextActivate = null;
        throw err;
      }
      (stub as { manifest: LayoutManifest }).manifest = next;
      stub.activations.push({ layoutId, frame });
      if (stub.activateGate !== null) await stub.activateGate();
    },
    residentTileCount(): number {
      return 0;
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Synthetic CellBuffers (transition-staging tests)
// ---------------------------------------------------------------------------

/** Build synthetic CellBuffers (transition-staging tests). */
export function makeBuffers(cells: { id: number; x: number; y: number }[]): CellBuffers {
  return {
    ids: BigInt64Array.from(cells.map((c) => BigInt(c.id))),
    positions: Float32Array.from(cells.flatMap((c) => [c.x, c.y])),
    sizes: Float32Array.from(cells.flatMap(() => [0.1, 0.1])),
    atlasPage: Int32Array.from(cells.map(() => 0)),
    atlasUv: Float32Array.from(cells.flatMap(() => [0, 0, 1, 1])),
    lod: Int8Array.from(cells.map(() => 0)),
    count: cells.length,
  };
}
