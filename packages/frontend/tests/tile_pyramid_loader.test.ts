// v2 (D-33) — BEHAVIORAL coverage of the tile-pyramid loader FACTORY orchestration
// (not just the pure policy in tile_pyramid_policy.test.ts). The factory's
// fetch/decode/GPU path was previously only smoke-constructed; round-2 review
// flagged it as untested. We exercise it GL-free via the DI seam
// (createTilePyramid's `deps`): a fake PyramidArchive serves canned tile bodies
// and a stub decode returns a bare THREE.Texture, so the orchestration (parent-
// before-child load order, atlas-before-buffers, supersede/abort, eviction,
// teardown, context-loss recovery, the layout-switch condemned backdrop + no-
// fan-out contract, archive caching) runs without a WebGL context or
// createImageBitmap.
import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import type { Table } from "apache-arrow";

import { createTilePyramid, tilePageId } from "../src/renderer/tilePyramid.ts";
import type { LayoutManifest, PyramidDescriptor } from "../src/renderer/layout.ts";
import type { CameraState, Viewport, World } from "../src/renderer/world.ts";
import { createStubWorld, createStubCells, createFakeArchive } from "./fake_client.ts";
import type { StubCells, FakeArchive } from "./fake_client.ts";

// --- fine-tile body framing (matches the producer: [u32 BE len][webp][arrow FILE]) ---

function recordTable(cells: { id: number; x: number; y: number }[]): Table {
  return tableFromArrays({
    id: BigInt64Array.from(cells.map((c) => BigInt(c.id))),
    x: Float32Array.from(cells.map((c) => c.x)),
    y: Float32Array.from(cells.map((c) => c.y)),
    w: Float32Array.from(cells.map(() => 0.1)),
    h: Float32Array.from(cells.map(() => 0.1)),
    u: Float32Array.from(cells.map(() => 0)),
    v: Float32Array.from(cells.map(() => 0)),
    uw: Float32Array.from(cells.map(() => 0.125)),
    uh: Float32Array.from(cells.map(() => 0.125)),
  });
}

/** Frame a FINE tile body the way the producer does: a 4-byte BIG-ENDIAN webp
 *  length prefix, the webp bytes, then the Arrow IPC-FILE (Feather) records. */
function fineBody(image: Uint8Array, cells: { id: number; x: number; y: number }[]): Uint8Array {
  const arrow = tableToIPC(recordTable(cells), "file"); // FILE framing (ARROW1)
  const out = new Uint8Array(4 + image.byteLength + arrow.byteLength);
  new DataView(out.buffer).setUint32(0, image.byteLength, false);
  out.set(image, 4);
  out.set(arrow, 4 + image.byteLength);
  return out;
}

const FAKE_WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]); // 'RIFF…'

// A 2-level pyramid: z=0 coarse overview, z=1 fine (z_cap=1). 2x2 fine tiles.
function pyramidDesc(): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [
      { z: 0, tile_count: 1 },
      { z: 1, tile_count: 4 },
    ],
    z_cap: 1,
  };
}

function manifestWith(
  layoutIds: string[],
  pyramid: PyramidDescriptor = pyramidDesc(),
  imageCount = 16,
): LayoutManifest {
  return {
    manifest_version: "2.1",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: layoutIds.map((id) => ({
      layout_id: id,
      label: id,
      type: "grid",
      bbox: [0, 0, 1, 1],
      pyramid,
    })),
    dataset_metadata: { image_count: imageCount, ingest_timestamp: "2026-01-01T00:00:00Z" },
  } as LayoutManifest;
}

/** A single-FINE-level pyramid (z=2 ⇒ 4x4 = 16 tiles, z_cap=0, no coarse band):
 *  isolates the fine working-set bound for the pan/eviction tests. */
function fineGridPyramid(): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [{ z: 2, tile_count: 16 }],
    z_cap: 0,
  };
}

function fineGridBodies(): Map<string, Uint8Array | null> {
  const bodies = new Map<string, Uint8Array | null>();
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) bodies.set(`2/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: y * 4 + x, x: 0.5, y: 0.5 }]));
  }
  return bodies;
}

/** A small viewport whose zoom selects the fine grid's z=2 level. */
const SMALL_VP: Viewport = { width: 10, height: 10, devicePixelRatio: 1 };
const FINE_GRID_ZOOM = 1 / 1024;

// A minimal ApiClient: only pyramidUrl + authHeaders are reached by the loader.
function fakeClientFor(): {
  client: Parameters<typeof createTilePyramid>[2];
} {
  const client = {
    pyramidUrl: (_ds: string, layoutId: string) => `pyramid://${layoutId}`,
    authHeaders: () => ({}),
  } as unknown as Parameters<typeof createTilePyramid>[2];
  return { client };
}

/** Decode stub: returns a fresh GL-free THREE.Texture, tagged with its byte head
 *  so a test can correlate a decoded texture back to its source body. */
let decodeCount = 0;
function stubDecode(bytes: Uint8Array): Promise<THREE.Texture> {
  decodeCount++;
  const tex = new THREE.Texture();
  (tex as unknown as { __head: number }).__head = bytes[0] ?? -1;
  return Promise.resolve(tex);
}

/** Build a loader over the fake archive + stub world/cells, returning the handles
 *  so a test can drive the camera + inspect the recording stubs. */
function harness(opts: {
  bodies: Map<string, Uint8Array | null>;
  layoutIds?: string[];
  onUnrecoverable?: () => void;
  archiveFactory?: (url: string) => FakeArchive;
  pyramid?: PyramidDescriptor;
  imageCount?: number;
  cacheBudget?: number;
  decode?: (bytes: Uint8Array) => Promise<THREE.Texture>;
}): {
  world: ReturnType<typeof createStubWorld>;
  cells: StubCells;
  /** Live getter for the archive the loader most recently OPENED. Archives are
   *  cached per layout URL, so re-activating an already-seen layout does NOT
   *  update this — it reflects the last cache MISS. */
  currentArchive: () => FakeArchive;
  pyramid: ReturnType<typeof createTilePyramid>;
  manifest: LayoutManifest;
} {
  const stubWorld = createStubWorld();
  const cells = createStubCells();
  const { client } = fakeClientFor();
  const manifest = manifestWith(opts.layoutIds ?? ["grid"], opts.pyramid, opts.imageCount);
  let archive: FakeArchive = createFakeArchive(opts.bodies);
  const openArchive = (url: string): FakeArchive => {
    archive = opts.archiveFactory !== undefined ? opts.archiveFactory(url) : createFakeArchive(opts.bodies);
    return archive;
  };
  // FakeArchive is structurally a PyramidArchive (it has getTile); cast the
  // opener to the deps shape. decodeImage is the GL-free stub.
  const pyramid = createTilePyramid(
    stubWorld.world as unknown as World,
    cells,
    client,
    manifest,
    opts.onUnrecoverable,
    {
      openArchive: openArchive as unknown as (url: string, h: () => Record<string, string>) => never,
      decodeImage: opts.decode ?? stubDecode,
      cacheBudget: opts.cacheBudget,
    },
  );
  return { world: stubWorld, cells, currentArchive: () => archive, pyramid, manifest };
}

const VIEWPORT: Viewport = { width: 100, height: 100, devicePixelRatio: 1 };
/** A zoom that selects the FINE level (z=1) over the whole [0,1]^2. */
function fineCamera(): CameraState {
  return { center: [0.5, 0.5], zoom: 1 / 4096 };
}

/** Spin the microtask queue so the loader's async tile loads settle. */
async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------

test("activateLayout loads the coarse floor BEFORE the fine child", async () => {
  // z=0 coarse body present, z=1 fine bodies present. The refresh path loads the
  // coarse fallback band FIRST (so a floor is drawn under the streaming fine cells).
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP); // coarse overview
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));

  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  // activateLayout's frame path enumerates fine tiles + their parents; drive a
  // camera refresh too so the parent-first ordering in `refresh` is exercised.
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();

  const requested = h.currentArchive().requested;
  const firstCoarse = requested.indexOf("0/0/0");
  const firstFine = requested.findIndex((k) => k.startsWith("1/"));
  assert.ok(firstCoarse >= 0, "the coarse parent was requested");
  assert.ok(firstFine >= 0, "a fine child was requested");
  assert.ok(firstCoarse < firstFine, `parent (${firstCoarse}) must be requested before the fine child (${firstFine})`);
});

test("a coarse overview tile renders DoubleSide (a FrontSide quad is back-face culled → blank)", async () => {
  // REGRESSION (live-found 2026-06-28): a zoomed-out / fit view shows ONLY coarse
  // overview tiles (z < z_cap). The world camera uses a y-FLIPPED orthographic
  // projection (world.ts applyCamera sets top < bottom so world-y grows downward on
  // screen), which reverses triangle winding — so a default FrontSide overview quad
  // is back-face culled and the entire view renders blank. The fine-cell path was
  // unaffected because the cells material is already DoubleSide; this asserts the
  // overview material matches. Without the fix the overview is THREE.FrontSide and
  // this fails (so a multi-level pyramid is blank when zoomed out).
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP); // the single coarse overview tile (z_cap=1 ⇒ z=0 is coarse)
  const h = harness({ bodies });
  // A full-extent frame selects the coarsest level (z=0) — the fit/zoomed-out view.
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();

  const meshes = [...h.world.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert.equal(meshes.length, 1, "the coarse overview drew exactly one quad into the scene");
  const mat = meshes[0].material as THREE.MeshBasicMaterial;
  assert.equal(
    mat.side,
    THREE.DoubleSide,
    "overview material must be DoubleSide — FrontSide is back-face culled by the y-flipped camera and renders blank",
  );
  assert.ok(mat.map !== null && mat.map !== undefined, "the overview quad is textured (the decoded mosaic)");
});

test("a coarse overview tile composites its ALPHA pad over the ground (Seam A / b1)", async () => {
  // Seam A (T2-61/T2-40/T2-68, decision D-iv): the v2 coarse mosaic is baked with a
  // TRANSPARENT pad (alpha 0) and opaque cells, so a sparse overview (datetime: ~90%
  // empty) must composite OVER the canvas ground (`--ground`) rather than paint an
  // opaque black pad. The overview material must therefore be transparent with a
  // STRAIGHT-alpha over-blend (NormalBlending + premultipliedAlpha:false) — matching
  // the texture, which decodeImageTextureReal decodes premultiplyAlpha:"none". A
  // premultiplied/straight MISMATCH fringes sparse cell edges dark. Regresses if the
  // material is opaque (transparent:false), which would paint the pad black and hide
  // the ground under a sparse overview.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP); // the single coarse overview tile (z_cap=1 ⇒ z=0 is coarse)
  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();

  const meshes = [...h.world.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert.equal(meshes.length, 1, "the coarse overview drew exactly one quad");
  const mat = meshes[0].material as THREE.MeshBasicMaterial;
  assert.equal(mat.transparent, true, "overview material must be transparent to composite the alpha pad over the ground");
  assert.equal(mat.blending, THREE.NormalBlending, "overview must use NormalBlending (standard over-blend)");
  assert.equal(mat.premultipliedAlpha, false, "overview must use STRAIGHT alpha (premultipliedAlpha:false) — the texture is decoded straight");
  assert.equal(mat.depthTest, false, "overview keeps depthTest:false (drawn behind the cells)");
  assert.equal(mat.depthWrite, false, "overview keeps depthWrite:false (matches the fine cells; a coplanar transparent backdrop writes no depth)");
  // The DoubleSide requirement (the prior regression) still holds alongside the alpha change.
  assert.equal(mat.side, THREE.DoubleSide, "overview stays DoubleSide (y-flipped camera back-face culls FrontSide)");
});

test("the FINE tier is unaffected by the alpha-pad change (fine cells still bind, no overview mesh)", async () => {
  // Seam A leaves the FINE tier UNTOUCHED: the mini-atlas is opaque (its pad slots are
  // never sampled), only the coarse mosaic path gained the alpha pad. A fine-level view
  // must still bind its cells via cells.setAtlasTexture (no overview mesh for a fine
  // tile), exactly as before — the alpha work only changes drawOverview + the shared
  // decode's premultiply flag (a no-op for the fully-opaque mini-atlas).
  const h = harness({ bodies: fineGridBodies(), pyramid: fineGridPyramid(), imageCount: 16 });
  h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();
  // Fine tiles bind cells (setAtlasTexture), not overview meshes.
  const atlasCalls = h.cells.calls.filter((c) => c.kind === "atlas" && !c.isPlaceholder);
  assert.ok(atlasCalls.length > 0, "fine tiles bound their mini-atlas textures via setAtlasTexture");
  const meshes = [...h.world.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert.equal(meshes.length, 0, "a fine-only view draws NO standalone overview mesh (fine cells live in cells.ts buckets)");
});

test("initial activate selects the FIT-VIEW level from the live camera, not the coarsest (over-coarse-open fix)", async () => {
  // REGRESSION (operator-found 2026-07-01): the world immediate-emits the fit camera
  // BEFORE the first activate, so lastState/lastViewport are populated. A fit view
  // whose zoom selects the FINE level must stream FINE on open — the pre-fix
  // synthesized frameZoom = frameEdge/tile_px pinned any full-extent frame to
  // idealTilesPerAxis == 1 => z0, so the dataset opened at the coarsest mosaic and
  // only sharpened after the first user pan.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });
  // Simulate the world's construction-time immediate emit of the fit camera (the
  // stub world does not auto-emit); zoom 1/4096 selects the fine level z=1.
  h.world.emit(fineCamera(), VIEWPORT);
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();
  const requested = h.currentArchive().requested;
  assert.ok(
    requested.some((k) => k.startsWith("1/")),
    "activate streamed the FINE level from the live fit camera (not z0-only)",
  );
});

test("initial activate is bounded to the live view even if the camera deepened first (no full-extent fan-out)", async () => {
  // REGRESSION guard for the rejected fix variant: activate() is ALWAYS passed the
  // FULL-EXTENT layout frame (layout.ts bboxOfEntry). If it enumerated that full
  // extent at a deepened live zoom (a wheel event during the awaited manifest
  // fetch), it would fan out the ENTIRE fine level — the crash class the pyramid
  // exists to kill. Deriving the view from the SAME camera state as the zoom
  // (refresh) bounds it to what's on screen. z=2 4x4 = 16-tile fine grid: a small
  // deep view must request only a handful of tiles, never all 16.
  const h = harness({ bodies: fineGridBodies(), pyramid: fineGridPyramid(), imageCount: 16 });
  // A DEEP camera viewing a tiny top-left region (as if a wheel deepened it before
  // activate ran), while activate is still handed the FULL-EXTENT frame.
  h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();
  const fineRequested = h.currentArchive().requested.filter((k) => k.startsWith("2/"));
  assert.ok(fineRequested.length > 0, "the deep view streamed its fine tiles");
  assert.ok(
    fineRequested.length <= 9,
    `enumeration bounded to the live view (${fineRequested.length}), not the whole 16-tile level`,
  );
  assert.ok(h.pyramid.residentTileCount() <= 9, "resident set bounded to the view, not the full extent");
});

test("a fine tile binds its atlas texture BEFORE its buffers, with the same (z,tileSeq)", async () => {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("1/0/0", fineBody(FAKE_WEBP, [{ id: 0, x: 0.1, y: 0.1 }]));
  const h = harness({ bodies });
  // Activate with a small frame so only tile 1/0/0 is in view (no parent at z=0?
  // z_cap=1 so z=0 IS coarse; but we keep the frame to the top-left fine tile).
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 0.1, yMax: 0.1 });
  await settle();

  const atlasCalls = h.cells.calls.filter((c) => c.kind === "atlas" && !c.isPlaceholder);
  const bufferCalls = h.cells.calls.filter((c) => c.kind === "buffers");
  assert.ok(atlasCalls.length >= 1, "at least one real atlas bind happened");
  assert.ok(bufferCalls.length >= 1, "at least one setBuffers happened");
  // The first real atlas bind precedes the first setBuffers, and they share (lod,page).
  const firstAtlasIdx = h.cells.calls.findIndex((c) => c.kind === "atlas" && !c.isPlaceholder);
  const firstBufIdx = h.cells.calls.findIndex((c) => c.kind === "buffers");
  assert.ok(firstAtlasIdx < firstBufIdx, "setAtlasTexture must precede setBuffers for a fine tile");
  const a = h.cells.calls[firstAtlasIdx] as { lod: number; page: number };
  const b = h.cells.calls[firstBufIdx] as { lod: number; page: number };
  assert.equal(a.lod, b.lod, "atlas + buffers share the same z (lod)");
  assert.equal(a.page, b.page, "atlas + buffers share the same tileSeq (page)");
});

test("a generation bump mid-decode drops the late tile and disposes its decoded texture", async () => {
  // Gate the DECODE (not getTile): the body resolves, decode starts, the test
  // bumps the generation (a layout switch), then releases the decode. The
  // post-decode supersede check must dispose the now-stale texture and NOT bind it.
  const fine = fineBody(FAKE_WEBP, [{ id: 0, x: 0.1, y: 0.1 }]);
  const archive = createFakeArchive(new Map([["1/0/0", fine]]));
  const stubWorld = createStubWorld();
  const cells = createStubCells();
  const { client } = fakeClientFor();
  const manifest = manifestWith(["grid"]);
  let disposed = 0;
  let releaseDecode: (() => void) | null = null;
  const decodeGate = new Promise<void>((r) => { releaseDecode = r; });
  const decodeTracking = async (bytes: Uint8Array): Promise<THREE.Texture> => {
    void bytes;
    await decodeGate; // block the decode so we can supersede mid-decode
    const tex = new THREE.Texture();
    const origDispose = tex.dispose.bind(tex);
    tex.dispose = () => { disposed++; origDispose(); };
    return tex;
  };
  const pyramid = createTilePyramid(stubWorld.world as unknown as World, cells, client, manifest, undefined, {
    openArchive: (() => archive) as never,
    decodeImage: decodeTracking,
  });

  await pyramid.activateLayout(manifest, "grid", { xMin: 0, yMin: 0, xMax: 0.1, yMax: 0.1 });
  await settle(4); // body resolved, the load is now blocked in decodeGate
  pyramid.beginLayoutSwitch(); // bump generation while the decode is in flight
  releaseDecode!(); // decode resolves — but the load is now stale
  await settle();

  // The late tile must NOT bind: no real (non-placeholder) atlas + no buffers.
  const realAtlas = cells.calls.filter((c) => c.kind === "atlas" && !c.isPlaceholder);
  const buffers = cells.calls.filter((c) => c.kind === "buffers");
  assert.equal(realAtlas.length, 0, "a stale (superseded) tile must not bind a real atlas texture");
  assert.equal(buffers.length, 0, "a stale tile must not apply buffers");
  assert.equal(disposed, 1, "the decoded-but-stale texture must be disposed");
  assert.equal(pyramid.residentTileCount(), 0, "no resident tile from a superseded load");
});

test("the working set (coarse floor + visible fine) stays resident", async () => {
  // All 4 fine tiles + the coarse floor present. The visible fine tiles and the
  // coarse band covering the view are the wanted set, so they stay drawn (the
  // pan/eviction-bound behaviour is covered by the dedicated tests below).
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  assert.ok(h.pyramid.residentTileCount() > 0, "the visible working set is resident");
  // The kept band (visible fine tiles + their coarse parent) is never evicted by
  // the LRU even under a tiny budget — this is the chooseEvictions contract the
  // policy test covers; here we assert the live loader keeps a non-empty band.
});

test("coarseOverview + loadingTileCount expose the minimap/status snapshot (T2-54)", async () => {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP); // the coarse floor
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });

  // Before any layout is active, the overview snapshot is null.
  assert.equal(h.pyramid.coarseOverview(), null, "no layout active → null overview");

  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();

  const ov = h.pyramid.coarseOverview();
  assert.ok(ov !== null, "an active layout yields an overview snapshot");
  // The layout bbox is the coordinate frame the minimap maps into.
  assert.deepEqual(ov.layoutBBox, { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  // tiles is an array (each entry a {bbox,image}); the GL-free decode stub produces a
  // bare Texture with no drawable .image, so isDrawableImage filters them out in node
  // — the DRAWING itself is covered by Minimap.paintOverview's unit test. We assert
  // the snapshot SHAPE + bbox here, which is the loader's contract.
  assert.ok(Array.isArray(ov.tiles), "tiles is an array");

  // Loading count drains to 0 once the view settled (all wanted tiles bound).
  assert.equal(typeof h.pyramid.loadingTileCount(), "number");
  assert.equal(h.pyramid.loadingTileCount(), 0, "no in-flight fetches on a settled view");
});

test("teardown (world.dispose) aborts in-flight loads and frees resident tiles; no further Cells mutation", async () => {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  assert.ok(h.pyramid.residentTileCount() > 0, "tiles resident before dispose");

  h.world.dispose(); // fires onDispose: disposed=true, abort, freeResident
  assert.equal(h.pyramid.residentTileCount(), 0, "all resident tiles freed on dispose");

  // After dispose, a stray camera change must not load or mutate Cells.
  const callsBefore = h.cells.calls.length;
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  assert.equal(h.cells.calls.length, callsBefore, "no Cells mutation after dispose (disposed guard active)");
});

test("WebGL context loss halts + clears, restore resumes + re-binds (in-place recovery)", async () => {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  assert.ok(h.pyramid.residentTileCount() > 0, "tiles resident before loss");

  // --- loss: preventDefault + halt + drop residency ---
  const prevented = h.world.fireContextLost();
  assert.ok(prevented, "loss handler must preventDefault so the browser can restore");
  assert.equal(h.world.halts, 1, "render loop halted on loss");
  assert.equal(h.pyramid.residentTileCount(), 0, "resident tiles dropped on loss");

  // --- restore: handleContextRestored + resume + refresh re-binds ---
  h.world.fireContextRestored();
  await settle();
  assert.equal(h.cells.contextRestores, 1, "cells.handleContextRestored called on restore");
  assert.equal(h.world.resumes, 1, "render loop resumed on restore");
  assert.ok(h.pyramid.residentTileCount() > 0, "the SAME view re-bound its tiles after restore");
});

test("context-loss recovery RE-FETCHES (does not re-upload) — the invariant that makes ImageBitmap close-after-upload safe (T2-45a)", async () => {
  // The close strategy for the decoded ImageBitmap is close-after-upload
  // (decodeImageTextureReal's tex.onUpdate → bitmap.close()). That is only safe if
  // recovery never needs the retained bitmap for a SECOND GPU upload. This asserts
  // the load-bearing property directly: on loss every texture is disposed, and on
  // restore the loader RE-REQUESTS the visible tiles from the archive (a fresh
  // fetch + fresh decode), rather than re-uploading the dropped textures. So closing
  // the bitmap after its first upload can never strand recovery.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  const requestedBeforeLoss = h.currentArchive().requested.length;
  assert.ok(requestedBeforeLoss > 0, "the initial view fetched tiles");

  h.world.fireContextLost();
  assert.equal(h.pyramid.residentTileCount(), 0, "textures dropped on loss");
  h.world.fireContextRestored();
  await settle();

  // The restore path re-issued archive requests (a re-FETCH), not a re-upload from
  // the retained textures — the property that lets us close the bitmap post-upload.
  const requestedAfterRestore = h.currentArchive().requested.length;
  assert.ok(
    requestedAfterRestore > requestedBeforeLoss,
    `restore re-fetched from the archive (${requestedBeforeLoss} → ${requestedAfterRestore}), proving recovery refetches`,
  );
  assert.ok(h.pyramid.residentTileCount() > 0, "the view re-bound after the refetch");
});

test("a context loss that never restores drives onUnrecoverable (watchdog)", async () => {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("1/0/0", fineBody(FAKE_WEBP, [{ id: 0, x: 0.1, y: 0.1 }]));
  let unrecoverable = 0;
  const h = harness({ bodies, onUnrecoverable: () => { unrecoverable++; } });
  await h.pyramid.activateLayout(h.manifest, "grid", { xMin: 0, yMin: 0, xMax: 0.1, yMax: 0.1 });
  await settle();

  // Use fake timers so we don't wait CONTEXT_RESTORE_TIMEOUT_MS in real time.
  const realSetTimeout = globalThis.setTimeout;
  const pending: { fn: () => void }[] = [];
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    pending.push({ fn });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    h.world.fireContextLost(); // arms the watchdog via our fake setTimeout
    assert.equal(unrecoverable, 0, "watchdog not yet fired");
    for (const p of pending) p.fn(); // fire the watchdog timer
    assert.equal(unrecoverable, 1, "watchdog drove onUnrecoverable after no restore");
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
});

test("a layout switch (A→B) frees layout A's FINE tiles but keeps its coarse overview as a backdrop", async () => {
  // Two layouts share the fake bodies (same addresses). Activate A, then switch to
  // B: A's fine cells must be dropped when B is activated, but A's coarse overview
  // mesh stays DRAWN (the condemned backdrop) so the switch never blanks — it is
  // released by the new coarse floor binding (next test) or the watchdog.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies, layoutIds: ["a", "b"] });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  const residentA = h.pyramid.residentTileCount();
  assert.ok(residentA > 0, "layout A has resident tiles");
  assert.equal(h.pyramid.activeLayoutId(), "a");
  const meshesBefore = [...h.world.sceneObjects].filter((o) => o instanceof THREE.Mesh);
  assert.equal(meshesBefore.length, 1, "A's coarse overview is drawn");
  const oldOverview = meshesBefore[0];

  // Switch to B (no frame ⇒ B streams nothing yet): A's fine tiles are freed
  // (their cells dropped), A's coarse overview is condemned-but-still-drawn.
  await h.pyramid.activateLayout(h.manifest, "b", null);
  await settle();
  assert.equal(h.pyramid.activeLayoutId(), "b");
  assert.equal(h.pyramid.residentTileCount(), 0, "no ACTIVE tiles from layout A after the switch");
  assert.ok(h.cells.drops.length > 0, "A's fine cells were dropped at switch entry");
  assert.ok(h.world.sceneObjects.has(oldOverview), "A's coarse overview survives as the switch backdrop");

  h.world.dispose(); // releases the condemned backdrop + its watchdog timer
  assert.ok(!h.world.sceneObjects.has(oldOverview), "dispose releases the backdrop");
});

test("a layout switch issues NO full-extent fine fan-out — only the live view's tiles", async () => {
  // THE regression this rework kills: switchTo used to stage the WHOLE fine tier
  // of the target layout (>= 15,625 tiles at 1M) before anything rendered. Now a
  // switch streams exactly the viewport's tiles. 16-tile fine grid (z=2, z_cap=0),
  // camera parked on the top-left corner: the switch to B must request only that
  // corner's tiles from B's archive, never the whole level.
  const h = harness({ bodies: fineGridBodies(), pyramid: fineGridPyramid(), imageCount: 16, layoutIds: ["a", "b"] });
  await h.pyramid.activateLayout(h.manifest, "a", null);
  h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  assert.ok(h.pyramid.residentTileCount() > 0, "A's corner view is resident");

  // The switch: generation bump + activate B (the controller's exact sequence).
  h.pyramid.beginLayoutSwitch();
  await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();

  const bRequested = h.currentArchive().requested; // the most recently opened archive is B's
  assert.ok(bRequested.length > 0, "the switch streamed B's tiles for the live view");
  assert.ok(bRequested.every((k) => k.startsWith("2/")), "only the selected level was requested");
  assert.ok(
    bRequested.length <= 9,
    `switch bounded to the viewport (${bRequested.length} tiles), not the 16-tile full extent`,
  );
});

test("the condemned backdrop is released when the NEW coarse floor SETTLES (and B's tiles then draw)", async () => {
  // T2-119 SETTLED SEMANTICS (was: released when the floor "binds" — i.e. every wanted
  // floor key present in `active`). The floor is now released when every wanted floor
  // key has SETTLED (decoded+staged, null-bodied, or terminally failed), and the new
  // coarse mosaic is STAGED behind the backdrop (not bound OVER it) until the flip. For
  // this DENSE single-tile floor the observable end state is identical — but the
  // strengthened assertions below pin that B's coarse is held STAGED (never drawn over
  // the backdrop) during the gated window, then flushed as the backdrop leaves.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));

  // B's archive is GATED: its tiles stay in flight until the test releases them,
  // so the backdrop window is observable. A's archive serves normally.
  let releaseB: (() => void) | null = null;
  const bGate = new Promise<void>((r) => {
    releaseB = r;
  });
  const bArchive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      bArchive.requested.push(key);
      await bGate;
      return bodies.get(key) ?? null;
    },
  };
  const h = harness({
    bodies,
    layoutIds: ["a", "b"],
    archiveFactory: (url) => (url === "pyramid://b" ? bArchive : createFakeArchive(bodies)),
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  const oldOverview = [...h.world.sceneObjects].find((o) => o instanceof THREE.Mesh);
  assert.ok(oldOverview !== undefined, "A's coarse overview is drawn before the switch");

  h.pyramid.beginLayoutSwitch();
  await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();
  // B's loads are gated in flight: the old overview is the ONLY thing drawn — B's coarse
  // is neither settled nor drawn (STRENGTHENED: exactly one mesh, the old backdrop).
  assert.ok(h.world.sceneObjects.has(oldOverview), "backdrop still drawn while B streams");
  assert.equal(sceneMeshes(h.world).length, 1, "ONLY the old backdrop is drawn — B's coarse is not bound over it");

  releaseB!();
  await settle();
  // B's coarse floor SETTLED (its single tile decoded + staged) → the backdrop is
  // disposed and B's staged overview flushed in the same pass.
  assert.ok(!h.world.sceneObjects.has(oldOverview), "backdrop released once B's coarse floor settled");
  const meshes = sceneMeshes(h.world);
  assert.equal(meshes.length, 1, "exactly B's coarse overview is drawn now");
  assert.ok(h.pyramid.residentTileCount() > 0, "B's working set is resident");
});

test("the condemned backdrop is released by the watchdog when the new floor never SETTLES", async () => {
  // T2-119 SETTLED SEMANTICS (was: "never binds"). B's archive HANGS every tile, so no
  // floor key ever reaches a terminal outcome — the release condition is never met and
  // the TTL backstop must fire. Because nothing decoded, `staged` is empty, so the
  // watchdog flush is a no-op here (the flush-staged path is covered by the staging
  // tests); this pins that the backstop still releases a stuck backdrop.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  // B's archive never settles: no coarse floor tile ever resolves for the new layout.
  const bArchive: FakeArchive = {
    bodies,
    requested: [],
    getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      bArchive.requested.push(`${z}/${x}/${y}`);
      return new Promise<Uint8Array | null>(() => {});
    },
  };
  const h = harness({
    bodies,
    layoutIds: ["a", "b"],
    archiveFactory: (url) => (url === "pyramid://b" ? bArchive : createFakeArchive(bodies)),
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  const oldOverview = [...h.world.sceneObjects].find((o) => o instanceof THREE.Mesh);
  assert.ok(oldOverview !== undefined, "A's coarse overview is drawn before the switch");

  // Fake timers so the ~2s watchdog fires without waiting in real time.
  const realSetTimeout = globalThis.setTimeout;
  const pending: (() => void)[] = [];
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    pending.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    await settle();
    assert.ok(h.world.sceneObjects.has(oldOverview), "backdrop drawn while B's tiles hang (floor never settles)");
    for (const fn of pending.splice(0)) fn(); // fire the condemned watchdog
    assert.ok(!h.world.sceneObjects.has(oldOverview), "watchdog released the stale backdrop");
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
  }
});

// --- T2-119 atomic-swap staging (new fine binds held behind the backdrop) ---

/** A FakeArchive whose COARSE floor HANGS until released but whose FINE tiles
 *  resolve immediately — so on a layout switch the new fine tiles decode + STAGE
 *  while the old coarse backdrop stays drawn (the switch window is observable).
 *  Mirrors the gated-archive pattern the backdrop tests use, but gates only the
 *  coarse tier. `gateWhen` selects which z levels are gated (default z=0, the coarse
 *  floor of the 2-level pyramid; the banded pyramid gates z<2 to hold its whole
 *  multi-tile coarse band). A gated tile still returns its (possibly null) body once
 *  released, so an un-baked floor tile resolves to a null body on release. */
function coarseGatedArchive(
  bodies: Map<string, Uint8Array | null>,
  gateWhen: (z: number) => boolean = (z) => z === 0,
): {
  archive: FakeArchive;
  releaseCoarse: () => void;
} {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const archive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      if (gateWhen(z)) await gate; // gate the coarse FLOOR so the backdrop cannot release
      else await Promise.resolve(); // fine tiles resolve immediately → they stage
      return bodies.get(key) ?? null;
    },
  };
  return { archive, releaseCoarse: (): void => release?.() };
}

/** A 3-level pyramid: z=0 (1) + z=1 (4) COARSE, z=2 (16) FINE, z_cap=2. A FINE (z=2)
 *  view's coarse fallback band is the MULTI-TILE z=1 level — the surface the sparse-
 *  floor / atomic-coarse-swap tests exercise (a single-tile floor cannot show the
 *  unsatisfiable-release trap). A coarse-only (z=1) view enumerates that band directly. */
function bandedPyramid(): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [
      { z: 0, tile_count: 1 },
      { z: 1, tile_count: 4 },
      { z: 2, tile_count: 16 },
    ],
    z_cap: 2,
  };
}

/** Bodies for bandedPyramid: z0 (1) + z1 band (4) coarse, z2 (16) fine. Any z1 key in
 *  `missingCoarse` is OMITTED — a null body ⇒ the sparse-floor gap (a floor position the
 *  producer never baked, e.g. rijks scatter 43/64 @z3). */
function bandedBodies(missingCoarse: string[] = []): Map<string, Uint8Array | null> {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) {
    for (let y = 0; y < 2; y++) {
      const k = `1/${x}/${y}`;
      if (!missingCoarse.includes(k)) bodies.set(k, FAKE_WEBP);
    }
  }
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) bodies.set(`2/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: y * 4 + x, x: 0.5, y: 0.5 }]));
  }
  return bodies;
}

/** `o instanceof THREE.Mesh` narrowed — the overview quads drawn into the (stub) scene. */
function sceneMeshes(world: ReturnType<typeof createStubWorld>): THREE.Mesh[] {
  return [...world.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
}

/** A z=2 FINE view over the banded pyramid, straddling no coarse boundary (center 0.3):
 *  selects z=2, whose z=1 fallback band is 4 tiles (0,0),(1,0),(0,1),(1,1) via the
 *  1-tile prefetch margin — the multi-tile sparse floor. */
const BANDED_FINE_CAM: CameraState = { center: [0.3, 0.3], zoom: 1 / 2048 };
/** A z=1 COARSE-only view over the banded pyramid (center 0.5 straddles → 4 z=1 tiles). */
const BANDED_COARSE_CAM: CameraState = { center: [0.5, 0.5], zoom: 1 / 1024 };

/** A decode stub that records EVERY texture it produced and tracks each one's
 *  disposal (via THREE's `dispose` event) so a test can prove a staged (decoded-
 *  but-unbound) texture was DROPPED (disposed) — not flushed (bound) — on a
 *  supersede. */
function trackingDecodeFactory(): {
  produced: THREE.Texture[];
  disposed: Set<THREE.Texture>;
  /** How many times each texture was disposed — pins "disposed EXACTLY once" (a
   *  transferred backdrop must not be double-disposed). */
  disposeCount: Map<THREE.Texture, number>;
  decode: (bytes: Uint8Array) => Promise<THREE.Texture>;
} {
  const produced: THREE.Texture[] = [];
  const disposed = new Set<THREE.Texture>();
  const disposeCount = new Map<THREE.Texture, number>();
  const decode = (bytes: Uint8Array): Promise<THREE.Texture> => {
    const tex = new THREE.Texture();
    (tex as unknown as { __head: number }).__head = bytes[0] ?? -1;
    // THREE.Texture.dispose() dispatches a "dispose" event; disposeTileTexture calls
    // it, so this fires exactly when (and each time) the loader disposes the texture.
    tex.addEventListener("dispose", () => {
      disposed.add(tex);
      disposeCount.set(tex, (disposeCount.get(tex) ?? 0) + 1);
    });
    produced.push(tex);
    return Promise.resolve(tex);
  };
  return { produced, disposed, disposeCount, decode };
}

/** Two-level bodies shared by the staging tests: 1 coarse (z0) + 4 fine (z1). */
function coarseAndFineBodies(): Map<string, Uint8Array | null> {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  return bodies;
}

test("new-layout FINE binds are staged behind the backdrop and flush atomically on release (both trigger paths)", async () => {
  // T2-119: the OLD layout's coarse mosaic is kept as a condemned backdrop through a
  // switch, but the NEW layout's FINE cells USED to bind the instant each tile
  // resolved — drawing the sharp new layout OVER the blurry old backdrop for up to
  // the TTL (= both layouts visible). The fix STAGES the new fine binds while the
  // backdrop is up and flushes them in the SAME tick it releases. Proven on BOTH
  // release triggers: the new coarse floor binding, and the TTL watchdog.
  const bodies = coarseAndFineBodies();

  // ---- trigger 1: the NEW coarse floor binds ----
  {
    const b = coarseGatedArchive(bodies);
    const h = harness({
      bodies,
      layoutIds: ["a", "b"],
      archiveFactory: (url) => (url === "pyramid://b" ? b.archive : createFakeArchive(bodies)),
    });
    await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    h.world.emit(fineCamera(), VIEWPORT);
    await settle();
    const oldOverview = [...h.world.sceneObjects].find((o) => o instanceof THREE.Mesh);
    assert.ok(oldOverview !== undefined, "A's coarse overview is drawn before the switch");

    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    const callsAtSwitch = h.cells.calls.length;
    const buffersAtSwitch = h.cells.buffersReceived.length;
    await settle();

    // B's fine tiles LOADED (requested) but are STAGED — no new cells binds yet, and
    // the old backdrop is the only thing drawn (never-blank held; no double-layout).
    assert.ok(b.archive.requested.some((k) => k.startsWith("1/")), "B's fine tiles were fetched");
    assert.equal(h.cells.calls.length, callsAtSwitch, "B's fine binds are STAGED, not applied to cells, while the backdrop is up");
    assert.equal(h.cells.buffersReceived.length, buffersAtSwitch, "no B cell buffers applied while staged");
    assert.equal(h.pyramid.residentTileCount(), 0, "nothing DRAWN from B yet (coarse gated, fine staged)");
    assert.ok(h.world.sceneObjects.has(oldOverview), "the old backdrop is still the only thing drawn");

    // Release the coarse floor: it binds → the backdrop releases → the staged fine
    // binds flush ATOMICALLY in the same tick.
    b.releaseCoarse();
    await settle();
    assert.ok(!h.world.sceneObjects.has(oldOverview), "backdrop released once B's coarse floor bound");
    assert.ok(h.cells.calls.length > callsAtSwitch, "staged fine binds flushed to cells on release");
    assert.ok(h.cells.buffersReceived.length > buffersAtSwitch, "B's cell buffers applied on the atomic flush");
    assert.ok(h.pyramid.residentTileCount() > 0, "B's working set (coarse floor + flushed fine) is resident");
  }

  // ---- trigger 2: the TTL watchdog (the coarse floor NEVER binds) ----
  {
    const b = coarseGatedArchive(bodies); // coarse never released → only the watchdog can release
    const h = harness({
      bodies,
      layoutIds: ["a", "b"],
      archiveFactory: (url) => (url === "pyramid://b" ? b.archive : createFakeArchive(bodies)),
    });
    await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    h.world.emit(fineCamera(), VIEWPORT);
    await settle();
    const oldOverview = [...h.world.sceneObjects].find((o) => o instanceof THREE.Mesh);
    assert.ok(oldOverview !== undefined, "A's coarse overview is drawn before the switch");

    // Fake timers so the ~2s watchdog fires without waiting (the sync fine decoder is
    // microtask-only, so only the condemned watchdog uses setTimeout here).
    const realSetTimeout = globalThis.setTimeout;
    const pending: (() => void)[] = [];
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
      pending.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    try {
      h.pyramid.beginLayoutSwitch();
      await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
      const callsAtSwitch = h.cells.calls.length;
      await settle();
      // Fine staged, coarse hangs → backdrop still up, no binds applied.
      assert.equal(h.cells.calls.length, callsAtSwitch, "B's fine binds staged while the coarse floor hangs");
      assert.ok(h.world.sceneObjects.has(oldOverview), "backdrop drawn while B's coarse floor hangs");

      for (const fn of pending.splice(0)) fn(); // fire the condemned-backdrop watchdog
      // The watchdog released the backdrop AND flushed the staged fine binds — the
      // staged binds are NEVER stranded even when the coarse floor never binds.
      assert.ok(!h.world.sceneObjects.has(oldOverview), "watchdog released the stale backdrop");
      assert.ok(h.cells.calls.length > callsAtSwitch, "staged fine binds flushed on the watchdog path (never stranded)");
      assert.ok(h.pyramid.residentTileCount() > 0, "the flushed fine tiles are resident after the watchdog");
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
    }
  }
});

test("a supersede drops the staged fine binds (they are disposed, never flushed to cells)", async () => {
  // T2-119 supersede-safety: if a SECOND switch arrives while layout B's fine binds
  // are staged behind the backdrop, those stale staged binds must be DROPPED (their
  // decoded textures disposed) — never flushed onto the third layout's view. This is
  // generation-guarded exactly like an in-flight fetch: bumpGeneration → abortInflight
  // → dropStaged.
  const bodies = coarseAndFineBodies();
  const trk = trackingDecodeFactory();
  const b = coarseGatedArchive(bodies); // B's coarse hangs → B's fine STAGE (backdrop stays up)
  const h = harness({
    bodies,
    layoutIds: ["a", "b", "c"],
    // b is coarse-gated (its fine stage); a + c serve normally.
    archiveFactory: (url) => (url === "pyramid://b" ? b.archive : createFakeArchive(bodies)),
    decode: trk.decode,
  });

  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();

  // Switch A→B: A's coarse is condemned (backdrop), B's fine decode + STAGE.
  const producedBeforeB = trk.produced.length;
  const callsBeforeB = h.cells.calls.length;
  h.pyramid.beginLayoutSwitch();
  await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();

  const stagedTextures = trk.produced.slice(producedBeforeB); // B's fine textures (coarse gated ⇒ no coarse decode)
  assert.ok(stagedTextures.length > 0, "B's fine tiles decoded (their textures were produced)");
  assert.ok(stagedTextures.every((t) => !trk.disposed.has(t)), "staged textures are held, not yet disposed");
  assert.equal(h.cells.calls.length, callsBeforeB, "B's fine binds are staged, not applied to cells");

  // Switch B→C (the supersede) while B's binds are staged: the stale staged binds
  // must be dropped (disposed), not flushed.
  h.pyramid.beginLayoutSwitch();
  await h.pyramid.activateLayout(h.manifest, "c", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();

  // Every staged B texture was DISPOSED — proof it was dropped by dropStaged, not
  // bound by flushStaged (which would keep the texture alive in `active`).
  assert.ok(stagedTextures.every((t) => trk.disposed.has(t)), "the superseded staged fine binds were dropped (textures disposed)");
  assert.equal(h.pyramid.activeLayoutId(), "c", "the loader is now on the superseding layout C");
});

// --- T2-119 RESIDUAL: atomic coarse-floor swap (stage coarse + settle-based release) ---

test("a SPARSE multi-tile coarse floor holds the backdrop until the LAST key settles, then flips atomically (T2-119)", async () => {
  // THE residual this fix closes. A sparse layout (scatter/datetime) has floor tiles the
  // producer never baked; their fetches return a NULL body and are dropped WITHOUT
  // entering `active`, so the pre-fix "every wanted floor key in `active`" release was
  // UNSATISFIABLE — the backdrop hung the full TTL and the OLD layout showed through the
  // transparent mosaic gaps (the reported double). Here B's z=1 coarse band is 4 wanted
  // tiles with ONE un-baked (1/1/1 ⇒ null body). With settle-based release the null tile
  // counts toward the floor, so the backdrop releases the moment the LAST key settles —
  // and the release is proven to come from SETTLE, not the TTL (fake timers, never fired).
  const bodies = bandedBodies(["1/1/1"]); // z=1 band: (0,0),(1,0),(0,1) baked; (1,1) un-baked
  const b = coarseGatedArchive(bodies, (z) => z < 2); // gate the coarse band; fine (z2) stages
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b"],
    archiveFactory: (url) => (url === "pyramid://b" ? b.archive : createFakeArchive(bodies)),
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_FINE_CAM, SMALL_VP);
  await settle();
  const oldMeshes = sceneMeshes(h.world); // A's z=1 coarse band — the backdrop-to-be
  assert.ok(oldMeshes.length >= 1, "A's coarse band is drawn before the switch");

  const timers = fakeTimers(); // capture the ~2s TTL but NEVER fire it (prove settle-driven)
  try {
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    const callsAtSwitch = h.cells.calls.length;
    await settle();

    // Window: B's fine tiles decoded + STAGED; B's coarse band is gated in flight. The
    // backdrop is the ONLY thing drawn (no new coarse over it, no fine cells applied).
    assert.ok(b.archive.requested.some((k) => k.startsWith("1/")), "B's coarse band was fetched");
    assert.ok(b.archive.requested.some((k) => k.startsWith("2/")), "B's fine tiles were fetched");
    assert.equal(h.cells.calls.length, callsAtSwitch, "B's fine binds are STAGED, not applied to cells");
    assert.equal(h.pyramid.residentTileCount(), 0, "nothing DRAWN from B yet (coarse staged/gated, fine staged)");
    const windowMeshes = sceneMeshes(h.world);
    assert.equal(windowMeshes.length, oldMeshes.length, "ONLY the old backdrop is drawn during the switch");
    assert.ok(windowMeshes.every((m) => oldMeshes.includes(m)), "no NEW coarse mosaic is drawn over the backdrop");

    // Release the coarse band: 3 tiles decode+stage+settle, the un-baked 1/1/1 resolves to
    // a null body and SETTLES too → the LAST settle triggers the atomic flip.
    b.releaseCoarse();
    await settle();
    assert.ok(oldMeshes.every((m) => !h.world.sceneObjects.has(m)), "the whole old backdrop is gone after the flip");
    const newMeshes = sceneMeshes(h.world);
    assert.equal(newMeshes.length, 3, "B's 3 baked coarse tiles are drawn (the un-baked 1/1/1 has no mesh)");
    assert.ok(newMeshes.every((m) => !oldMeshes.includes(m)), "the drawn coarse meshes are all B's, added in the flip");
    assert.ok(h.cells.calls.length > callsAtSwitch, "B's staged fine binds flushed to cells in the same pass");
    assert.ok(h.pyramid.residentTileCount() > 0, "B's working set (coarse floor + flushed fine) is resident");
    assert.equal(timers.pending.length, 0, "the TTL was cleared by the settle-driven release (never fired)");
  } finally {
    timers.restore();
  }
});

test("an all-DENSE coarse floor releases the backdrop on settle without the TTL (grid behaviour unchanged)", async () => {
  // The dense counterpart to the sparse test: every floor tile is baked, so every wanted
  // floor key settles by DECODING (staging) — no null-body key involved. The backdrop must
  // still release promptly on the last settle (not hang for the TTL), and the new coarse +
  // fine flush in. Pins that the settle-based release did not regress the common (grid)
  // case where the floor is fully baked.
  const bodies = bandedBodies(); // dense: all 4 z=1 band tiles baked
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b"],
    archiveFactory: () => createFakeArchive(bodies), // both layouts serve normally (no gate)
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_FINE_CAM, SMALL_VP);
  await settle();
  const oldMeshes = sceneMeshes(h.world);
  assert.ok(oldMeshes.length >= 1, "A's coarse band is drawn before the switch");

  const timers = fakeTimers(); // never fired — release must be settle-driven
  try {
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    const callsAtSwitch = h.cells.calls.length;
    await settle();
    // Ungated: B's floor decodes + settles within the same microtask drain → the flip has
    // already happened here, WITHOUT the TTL firing.
    assert.ok(oldMeshes.every((m) => !h.world.sceneObjects.has(m)), "the old backdrop released on settle (no TTL)");
    assert.equal(sceneMeshes(h.world).length, 4, "all 4 dense coarse tiles are drawn");
    assert.ok(h.cells.calls.length > callsAtSwitch, "B's fine binds were applied on release");
    assert.ok(h.pyramid.residentTileCount() > 0, "B's working set is resident");
    assert.equal(timers.pending.length, 0, "no backdrop watchdog left pending (released by settle, not the TTL)");
  } finally {
    timers.restore();
  }
});

test("a TERMINAL coarse-floor fetch failure counts as settled and releases the backdrop (T2-119)", async () => {
  // A floor tile whose fetch keeps FAILING (not a null body, not a hang) must not pin the
  // backdrop forever: after its bounded retries are exhausted it is SETTLED, so the floor
  // can release. Proven WITHOUT the TTL — only the retry backoff timers are fired (never
  // the 2s watchdog), so the release is driven by the terminal-failure settle. The failed
  // floor tile has no mesh, yet the staged fine binds still flush.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP); // the single coarse-floor tile of the 2-level pyramid
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: x * 2 + y, x: 0.5, y: 0.5 }]));
  // B's archive: the coarse floor (z=0) ALWAYS fails (a non-abort error → bounded retry),
  // the fine tiles (z=1) serve → they STAGE behind the backdrop.
  const bArchive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      bArchive.requested.push(key);
      await Promise.resolve();
      if (signal?.aborted === true) {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      if (z === 0) throw new Error(`coarse floor permanently fails for ${key}`);
      return bodies.get(key) ?? null;
    },
  };
  const h = harness({
    bodies,
    layoutIds: ["a", "b"],
    archiveFactory: (url) => (url === "pyramid://b" ? bArchive : createFakeArchive(bodies)),
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(fineCamera(), VIEWPORT);
  await settle();
  const oldOverview = [...h.world.sceneObjects].find((o) => o instanceof THREE.Mesh);
  assert.ok(oldOverview !== undefined, "A's coarse overview is drawn before the switch");

  const timers = fakeTimers();
  try {
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    // The condemned watchdog (TTL) is armed synchronously; capture it so we can fire the
    // RETRY timers WITHOUT ever firing the TTL.
    assert.equal(timers.pending.length, 1, "only the TTL watchdog is armed at switch entry");
    const ttlId = timers.pending[0].id;
    const callsAtSwitch = h.cells.calls.length;
    await settle();
    assert.ok(h.world.sceneObjects.has(oldOverview), "backdrop still drawn while the floor fetch is retrying");

    // Fire ONLY the retry backoff timers (never the TTL) until the coarse tile exhausts its
    // retry cap → terminal settle → release.
    let guard = 0;
    while (h.world.sceneObjects.has(oldOverview) && guard++ < 8) {
      const retries = timers.pending.filter((p) => p.id !== ttlId);
      if (retries.length === 0) break;
      for (const r of retries) {
        const idx = timers.pending.indexOf(r);
        if (idx >= 0) timers.pending.splice(idx, 1);
        r.fn();
      }
      await settle();
    }

    assert.ok(!h.world.sceneObjects.has(oldOverview), "the terminal floor failure settled → backdrop released (not via the TTL)");
    assert.equal(sceneMeshes(h.world).length, 0, "the failed coarse floor has NO mesh (it never decoded)");
    assert.ok(h.cells.calls.length > callsAtSwitch, "B's staged fine binds still flushed on the terminal-settle release");
    assert.ok(h.pyramid.residentTileCount() > 0, "B's fine working set is resident");
    // Fetched exactly 1 + RETRY_ATTEMPT_BACKOFF_MS.length (=3) times, then settled.
    assert.equal(bArchive.requested.filter((k) => k === "0/0/0").length, 4, "coarse floor: initial + 3 capped retries, then settled");
  } finally {
    timers.restore();
  }
});

test("a supersede drops the staged COARSE binds (their textures are disposed, never flushed)", async () => {
  // T2-119 supersede-safety, coarse tier: staged coarse tiles are dropped on a second
  // switch exactly like staged fine (generation-guarded: bumpGeneration → abortInflight →
  // dropStaged). A coarse-only (z=1) view isolates the coarse tier — one floor tile decodes
  // + STAGES while the rest hang, so the backdrop stays up and the staged coarse is held;
  // the supersede must dispose it, not flush it onto layout C.
  const bodies = bandedBodies(); // z=1 band all baked; a coarse-only view never reaches z=2
  const trk = trackingDecodeFactory();
  // B's archive: 1/0/0 resolves (→ decode + stage), the other z=1 floor tiles HANG (so the
  // floor never fully settles → the backdrop stays up → 1/0/0 stays STAGED).
  const bArchive: FakeArchive = {
    bodies,
    requested: [],
    getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      bArchive.requested.push(key);
      if (key === "1/0/0") return Promise.resolve(bodies.get(key) ?? null);
      return new Promise<Uint8Array | null>(() => {}); // the rest hang in flight
    },
  };
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b", "c"],
    archiveFactory: (url) => (url === "pyramid://b" ? bArchive : createFakeArchive(bodies)),
    decode: trk.decode,
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_COARSE_CAM, VIEWPORT); // z=1 coarse-only view
  await settle();
  const oldMeshes = sceneMeshes(h.world); // A's z=1 coarse band
  assert.ok(oldMeshes.length >= 1, "A's coarse band is drawn before the switch");

  // Switch A→B: A's coarse band is condemned (backdrop); B's 1/0/0 decodes + STAGES, the
  // other floor tiles hang → the floor is not fully settled → backdrop stays up.
  const producedBeforeB = trk.produced.length;
  const callsBeforeB = h.cells.calls.length;
  h.pyramid.beginLayoutSwitch();
  await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();

  const stagedCoarse = trk.produced.slice(producedBeforeB); // exactly B's 1/0/0 coarse texture
  assert.equal(stagedCoarse.length, 1, "exactly one B coarse tile decoded + staged (the rest hang)");
  assert.ok(stagedCoarse.every((t) => !trk.disposed.has(t)), "the staged coarse texture is held, not yet disposed");
  assert.equal(h.cells.calls.length, callsBeforeB, "a coarse stage touches no cells (it flushes to an overview mesh)");
  const windowMeshes = sceneMeshes(h.world);
  assert.equal(windowMeshes.length, oldMeshes.length, "the staged B coarse is NOT drawn — only the old backdrop");
  assert.ok(windowMeshes.every((m) => oldMeshes.includes(m)), "no new coarse mesh added while staged");

  // Switch B→C (the supersede) while B's coarse is staged: the stale staged coarse must be
  // DROPPED (its texture disposed), not flushed onto C's view.
  h.pyramid.beginLayoutSwitch();
  await h.pyramid.activateLayout(h.manifest, "c", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  await settle();
  assert.ok(stagedCoarse.every((t) => trk.disposed.has(t)), "the superseded staged coarse bind was dropped (texture disposed)");
  assert.equal(h.pyramid.activeLayoutId(), "c", "the loader is now on the superseding layout C");
});

test("the TTL backstop flushes staged COARSE and FINE binds when a floor tile hangs (T2-119)", async () => {
  // If a floor tile's fetch HANGS (never settles — not a null body, not a terminal
  // failure), the settle condition is never met, so the TTL backstop must still fire AND
  // flush everything staged behind it — including staged COARSE overview meshes, not just
  // fine cells. Here 3 of B's 4 floor tiles decode + stage; the 4th hangs. Firing the
  // watchdog releases the backdrop and flushes the 3 staged coarse meshes + the staged fine
  // cells in one pass (the staged binds are never stranded).
  const bodies = bandedBodies(); // dense band, but one tile will HANG in the archive
  const bArchive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      bArchive.requested.push(key);
      if (key === "1/1/1") return new Promise<Uint8Array | null>(() => {}); // one floor tile HANGS
      await Promise.resolve();
      return bodies.get(key) ?? null;
    },
  };
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b"],
    archiveFactory: (url) => (url === "pyramid://b" ? bArchive : createFakeArchive(bodies)),
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_FINE_CAM, SMALL_VP);
  await settle();
  const oldMeshes = sceneMeshes(h.world);
  assert.ok(oldMeshes.length >= 1, "A's coarse band is drawn before the switch");

  const timers = fakeTimers();
  try {
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    const callsAtSwitch = h.cells.calls.length;
    await settle();
    // 3 floor tiles + fine decoded and STAGED; 1/1/1 hangs → floor not settled → backdrop up.
    assert.ok(oldMeshes.every((m) => h.world.sceneObjects.has(m)), "backdrop still drawn while a floor tile hangs");
    assert.equal(sceneMeshes(h.world).length, oldMeshes.length, "no B coarse mesh drawn yet (all staged)");
    assert.equal(h.cells.calls.length, callsAtSwitch, "B's fine binds are staged (floor incomplete)");

    // Fire the TTL watchdog: it releases the backdrop AND flushes the staged coarse + fine.
    for (const p of timers.pending.splice(0)) p.fn();
    assert.ok(oldMeshes.every((m) => !h.world.sceneObjects.has(m)), "the watchdog released the stale backdrop");
    assert.equal(sceneMeshes(h.world).length, 3, "the 3 staged coarse meshes flushed on the watchdog (staged coarse never stranded)");
    assert.ok(h.cells.calls.length > callsAtSwitch, "the staged fine binds flushed on the watchdog too");
    assert.ok(h.pyramid.residentTileCount() > 0, "B's flushed working set is resident after the watchdog");
  } finally {
    timers.restore();
  }
});

// --- T2-119 backdrop TRANSFER: rapid double-switch must not drop the backdrop ---

/** A banded-pyramid archive whose COARSE floor (z<2) HANGS forever but whose FINE tiles
 *  resolve — so a switch INTO this layout never settles its floor (the backdrop stays
 *  up). The "middle" layer of a rapid A→B→C chain, where the second switch arrives BEFORE
 *  the first floor settled. */
function coarseHangArchive(bodies: Map<string, Uint8Array | null>): FakeArchive {
  const archive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      if (z < 2) return new Promise<Uint8Array | null>(() => {}); // coarse hangs → floor never settles
      await Promise.resolve();
      return bodies.get(key) ?? null;
    },
  };
  return archive;
}

test("rapid double-switch A→B→C TRANSFERS the backdrop (never blank), then flips atomically to C (T2-119 regression)", async () => {
  // THE regression the atomic-swap otherwise introduced (found by adversarial verify): on a
  // rapid A→B→C the atomic-swap STAGES B's coarse behind A's backdrop, so B's coarse never
  // enters `active`; the B→C switch (arriving BEFORE B's floor settled) then found nothing to
  // condemn and DISPOSED A's backdrop → a reachable BLANK during C's cold coarse fetch. The
  // fix TRANSFERS A's still-drawn backdrop to cover the B→C window. Proven: the backdrop meshes
  // are drawn at EVERY step (never 0), C's coarse stages (not drawn), and once C's floor settles
  // the flip is atomic + settle-DRIVEN (fake timers never fired) and the transferred backdrop is
  // disposed EXACTLY once.
  const bodies = bandedBodies();
  const bArchive = coarseHangArchive(bodies); // B's floor never settles → A's backdrop held
  const c = coarseGatedArchive(bodies, (z) => z < 2); // C's coarse gated, released on demand
  const trk = trackingDecodeFactory();
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b", "c"],
    archiveFactory: (url) =>
      url === "pyramid://b" ? bArchive : url === "pyramid://c" ? c.archive : createFakeArchive(bodies),
    decode: trk.decode,
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_FINE_CAM, SMALL_VP);
  await settle();
  const backdrop = sceneMeshes(h.world); // A's z=1 coarse band — the backdrop
  assert.ok(backdrop.length >= 1, "A's coarse band is drawn before the switch");
  const backdropTex = backdrop.map((m) => (m.material as THREE.MeshBasicMaterial).map);

  const timers = fakeTimers(); // capture the ~2s watchdog(s) — NEVER fire them (prove settle-driven)
  try {
    // A→B: B's coarse hangs → B's floor never settles → A's backdrop stays up.
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    await settle();
    assert.ok(backdrop.every((m) => h.world.sceneObjects.has(m)), "A's backdrop held during A→B (B's floor gated)");
    assert.equal(sceneMeshes(h.world).length, backdrop.length, "only the backdrop is drawn during A→B");

    // B→C BEFORE B settled: the fix must TRANSFER the backdrop (never 0 drawn meshes).
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "c", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    const callsAtC = h.cells.calls.length;
    await settle();
    assert.ok(backdrop.every((m) => h.world.sceneObjects.has(m)), "the backdrop TRANSFERRED to cover B→C — NEVER a blank");
    assert.equal(sceneMeshes(h.world).length, backdrop.length, "still only the transferred backdrop is drawn (C staged/gated)");
    assert.ok(backdropTex.every((t) => t !== null && !trk.disposed.has(t)), "the transferred backdrop textures are NOT disposed at transfer");
    assert.equal(h.pyramid.residentTileCount(), 0, "nothing bound from C yet (its coarse gated, fine staged)");

    // Release C's coarse → C's floor settles → atomic flip to C (settle-driven, TTL unfired).
    c.releaseCoarse();
    await settle();
    assert.ok(backdrop.every((m) => !h.world.sceneObjects.has(m)), "the transferred backdrop is gone after C's flip");
    assert.ok(backdropTex.every((t) => t !== null && trk.disposeCount.get(t) === 1), "each transferred backdrop texture disposed EXACTLY once (no double-dispose)");
    assert.ok(sceneMeshes(h.world).length >= 1, "C's coarse floor is drawn after the flip");
    assert.ok(h.cells.calls.length > callsAtC, "C's staged fine flushed on the flip");
    assert.ok(h.pyramid.residentTileCount() > 0, "C's working set is resident");
    assert.equal(h.pyramid.activeLayoutId(), "c", "the loader is now on C");
  } finally {
    timers.restore();
  }
});

test("a backdrop TRANSFER re-arms the watchdog — the fresh timer governs the new window, the old one is cleared (T2-119)", async () => {
  // Pin the TTL re-arm on transfer: after B→C the A→B watchdog must be CLEARED and a FRESH 2s
  // watchdog armed for the C window (else a switch landing late in the previous window would
  // fire the backstop almost immediately). Firing the fresh timer flushes C's staged binds and
  // releases the transferred backdrop — proving it is C's watchdog, not the residual A→B one.
  const bodies = bandedBodies();
  const bArchive = coarseHangArchive(bodies);
  const cArchive = coarseHangArchive(bodies); // C's coarse also hangs → only the watchdog can release
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b", "c"],
    archiveFactory: (url) =>
      url === "pyramid://b" ? bArchive : url === "pyramid://c" ? cArchive : createFakeArchive(bodies),
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_FINE_CAM, SMALL_VP);
  await settle();
  const backdrop = sceneMeshes(h.world);
  assert.ok(backdrop.length >= 1, "A's coarse band is drawn");

  const timers = fakeTimers();
  try {
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "b", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    await settle();
    assert.equal(timers.pending.length, 1, "the A→B switch armed one condemned watchdog");
    const abWatchdogId = timers.pending[0].id;

    // B→C before B settled: TRANSFER — the A→B watchdog is CLEARED, a FRESH one armed.
    h.pyramid.beginLayoutSwitch();
    await h.pyramid.activateLayout(h.manifest, "c", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
    const callsAtC = h.cells.calls.length;
    await settle();
    assert.ok(backdrop.every((m) => h.world.sceneObjects.has(m)), "the backdrop transferred (still drawn)");
    assert.equal(timers.pending.length, 1, "still exactly one watchdog pending after the transfer");
    assert.notEqual(timers.pending[0].id, abWatchdogId, "the A→B watchdog was CLEARED; a FRESH watchdog governs the C window");

    // Fire the FRESH watchdog: it flushes C's staged fine + releases the transferred backdrop.
    for (const p of timers.pending.splice(0)) p.fn();
    assert.ok(backdrop.every((m) => !h.world.sceneObjects.has(m)), "the fresh watchdog released the transferred backdrop");
    assert.ok(h.cells.calls.length > callsAtC, "the fresh watchdog flushed C's staged fine binds (C's window, not A→B's)");
    assert.ok(h.pyramid.residentTileCount() > 0, "C's flushed fine is resident");
  } finally {
    timers.restore();
  }
});

test("a triple transfer chain A→B→C→D keeps ONE backdrop up across every window, disposed once at the final flip (T2-119)", async () => {
  // The transfer composes: each rapid switch arriving before the previous floor settles keeps
  // the SAME original backdrop up (A's), never re-pushing or double-disposing it. After
  // A→B→C→D (B and C hang their coarse; the switches chain), A's backdrop is still drawn; when
  // D's floor finally settles, the flip is atomic and A's backdrop is disposed EXACTLY once.
  const bodies = bandedBodies();
  const bArchive = coarseHangArchive(bodies);
  const cArchive = coarseHangArchive(bodies);
  const d = coarseGatedArchive(bodies, (z) => z < 2);
  const trk = trackingDecodeFactory();
  const archives: Record<string, FakeArchive> = {
    "pyramid://b": bArchive,
    "pyramid://c": cArchive,
    "pyramid://d": d.archive,
  };
  const h = harness({
    bodies,
    pyramid: bandedPyramid(),
    layoutIds: ["a", "b", "c", "d"],
    archiveFactory: (url) => archives[url] ?? createFakeArchive(bodies),
    decode: trk.decode,
  });
  await h.pyramid.activateLayout(h.manifest, "a", { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
  h.world.emit(BANDED_FINE_CAM, SMALL_VP);
  await settle();
  const backdrop = sceneMeshes(h.world);
  assert.ok(backdrop.length >= 1, "A's coarse band is drawn");
  const backdropTex = backdrop.map((m) => (m.material as THREE.MeshBasicMaterial).map);

  const timers = fakeTimers();
  try {
    for (const target of ["b", "c", "d"]) {
      h.pyramid.beginLayoutSwitch();
      await h.pyramid.activateLayout(h.manifest, target, { xMin: 0, yMin: 0, xMax: 1, yMax: 1 });
      await settle();
      assert.ok(backdrop.every((m) => h.world.sceneObjects.has(m)), `A's backdrop still drawn through the switch to ${target} (never blank)`);
      assert.equal(sceneMeshes(h.world).length, backdrop.length, `only the ONE original backdrop is drawn at ${target}`);
      assert.ok(backdropTex.every((t) => t !== null && !trk.disposed.has(t)), `backdrop textures not disposed mid-chain (${target})`);
    }
    // D's floor settles → atomic flip to D; A's backdrop disposed EXACTLY once across the chain.
    d.releaseCoarse();
    await settle();
    assert.ok(backdrop.every((m) => !h.world.sceneObjects.has(m)), "the original backdrop is gone after D's flip");
    assert.ok(backdropTex.every((t) => t !== null && trk.disposeCount.get(t) === 1), "the original backdrop's textures disposed EXACTLY once across the whole chain");
    assert.ok(h.pyramid.residentTileCount() > 0, "D's working set is resident");
    assert.equal(h.pyramid.activeLayoutId(), "d", "the loader is now on D");
  } finally {
    timers.restore();
  }
});

test("the PyramidArchive is cached per layout URL — toggling back re-uses it (no header re-fetch)", async () => {
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  let opens = 0;
  const h = harness({
    bodies,
    layoutIds: ["a", "b"],
    archiveFactory: () => {
      opens++;
      return createFakeArchive(bodies);
    },
  });
  await h.pyramid.activateLayout(h.manifest, "a", null);
  await h.pyramid.activateLayout(h.manifest, "b", null);
  assert.equal(opens, 2, "one archive open per distinct layout");
  await h.pyramid.activateLayout(h.manifest, "a", null);
  assert.equal(opens, 2, "toggling back to A re-used the cached archive (no re-open)");
});

// ---------------------------------------------------------------------------
// v2 residency: the critical fix — the drawn set is bounded by the VIEWPORT, not
// by how far the user has panned (the v1 pager leaked a bucket per visited tile
// forever). Evicted tiles drop their cells + reclaim their draw call, and their
// decoded texture is cached (bounded LRU) for an instant pan-back.
// ---------------------------------------------------------------------------

test("panning bounds the drawn set and disposes evicted-cache textures (no unbounded accumulation)", async () => {
  // Track texture lifetimes so we can assert evicted tiles are actually freed.
  let made = 0;
  let disposed = 0;
  const decode = (_b: Uint8Array): Promise<THREE.Texture> => {
    made++;
    const tex = new THREE.Texture();
    const orig = tex.dispose.bind(tex);
    tex.dispose = () => { disposed++; orig(); };
    return Promise.resolve(tex);
  };
  const h = harness({
    bodies: fineGridBodies(),
    pyramid: fineGridPyramid(),
    imageCount: 16,
    cacheBudget: 2, // tiny cache so panning the 16-tile grid forces evictions
    decode,
  });
  await h.pyramid.activateLayout(h.manifest, "grid", null);

  let maxResident = 0;
  for (let gx = 0; gx < 4; gx++) {
    for (let gy = 0; gy < 4; gy++) {
      h.world.emit({ center: [(gx + 0.5) / 4, (gy + 0.5) / 4], zoom: FINE_GRID_ZOOM }, SMALL_VP);
      await settle();
      maxResident = Math.max(maxResident, h.pyramid.residentTileCount());
    }
  }
  // The drawn set is bounded by the viewport + 1-tile margin (≤ 3x3), NOT by the
  // 16 tiles visited — the core leak fix.
  assert.ok(maxResident <= 9, `drawn set bounded by viewport, got ${maxResident}`);
  // Live textures = made - disposed stay bounded by (drawn + cacheBudget) + a
  // little in-flight slack: evicted tiles are actually freed, not accumulated.
  const live = made - disposed;
  assert.ok(disposed > 0, "evicted-cache textures were disposed (eviction frees, not leaks)");
  assert.ok(live <= maxResident + 2 + 2, `live textures bounded (made ${made}, disposed ${disposed}, live ${live})`);
});

test("a tile returning to view is restored from cache without re-fetching", async () => {
  const h = harness({
    bodies: fineGridBodies(),
    pyramid: fineGridPyramid(),
    imageCount: 16,
    cacheBudget: 64, // generous: the 16-tile grid never overflows the cache
  });
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  // View tile (0,0), pan far to (3,3), then back to (0,0).
  h.world.emit({ center: [0.125, 0.125], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  h.world.emit({ center: [0.875, 0.875], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  h.world.emit({ center: [0.125, 0.125], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  // 2/0/0 was fetched once on the first view; the return is a CACHE promote, so
  // it is NOT fetched again (instant low-cost recovery).
  const fetches00 = h.currentArchive().requested.filter((k) => k === "2/0/0").length;
  assert.equal(fetches00, 1, "the returning tile was promoted from cache, not re-fetched");
  assert.ok(h.pyramid.residentTileCount() > 0, "the returned view is drawn again");
});

test("an on-screen tile is never dropped; it is dropped only after it leaves the view", async () => {
  const h = harness({
    bodies: fineGridBodies(),
    pyramid: fineGridPyramid(),
    imageCount: 16,
    cacheBudget: 64,
  });
  await h.pyramid.activateLayout(h.manifest, "grid", null);
  const page00 = tilePageId(2, 0, 0);
  // Sit on tile (0,0) across several refreshes — a visible tile must never drop.
  for (let i = 0; i < 3; i++) {
    h.world.emit({ center: [0.125, 0.125], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
  }
  assert.ok(
    !h.cells.drops.some((d) => d.lod === 2 && d.page === page00),
    "the visible tile is never dropped (no grey under the cursor)",
  );
  assert.ok(
    h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2 && c.page === page00),
    "the visible tile was actually drawn",
  );
  // Pan far away — now (0,0) is off-screen and MUST be evicted (cells removed).
  h.world.emit({ center: [0.875, 0.875], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  assert.ok(
    h.cells.drops.some((d) => d.lod === 2 && d.page === page00),
    "the off-screen tile is dropped (its cells + bucket are reclaimed)",
  );
});

test("the coarse floor loads before any fine tile, and the focal fine tile before the periphery", async () => {
  // 2-level pyramid (z=0 coarse, z=1 fine, z_cap=1). Focal at the bottom-right:
  // the coarse parent 0/0/0 is requested before any fine tile (so a floor is ready
  // under the streaming cells), and among fine tiles 1/1/1 (under the focal) is
  // requested before 1/0/0 (the far corner). This locks the focal-ordering fix:
  // the v1 code globally distance-sorted parents + children together, so a fine
  // child could load before its coarse fallback.
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: y * 2 + x, x: 0.5, y: 0.5 }]));
  const h = harness({ bodies });
  await h.pyramid.activateLayout(h.manifest, "grid", null); // open the archive, no frame load
  // A fine-level view with the focal pinned at the bottom-right corner.
  h.world.emit({ center: [0.5, 0.5], zoom: 1 / 4096, focal: [0.99, 0.99] }, VIEWPORT);
  await settle();

  const req = h.currentArchive().requested;
  const firstFine = req.findIndex((k) => k.startsWith("1/"));
  const coarse = req.indexOf("0/0/0");
  assert.ok(coarse >= 0, "the coarse floor was requested");
  assert.ok(firstFine >= 0, "a fine tile was requested");
  assert.ok(coarse < firstFine, `coarse floor (${coarse}) before any fine tile (${firstFine})`);
  const i11 = req.indexOf("1/1/1");
  const i00 = req.indexOf("1/0/0");
  assert.ok(i11 >= 0 && i00 >= 0 && i11 < i00, `focal tile 1/1/1 (${i11}) before far corner 1/0/0 (${i00})`);
});

test("a camera pan ABORTS in-flight loads for tiles it no longer wants (#3 streamline)", async () => {
  // A controllable archive: getTile records each tile's abort signal and NEVER
  // resolves, so its load stays in-flight across a supersede and we can inspect
  // whether the loader cancelled it (vs. letting it run to completion to discard).
  const signals = new Map<string, AbortSignal>();
  const archive: FakeArchive = {
    bodies: new Map(),
    requested: [],
    getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      if (signal !== undefined) signals.set(key, signal);
      return new Promise<Uint8Array | null>(() => {}); // never settles: stays in-flight
    },
  };
  const h = harness({
    bodies: new Map(),
    pyramid: fineGridPyramid(), // z=2, 4x4 fine grid, z_cap=0 (no coarse band)
    archiveFactory: () => archive,
  });
  await h.pyramid.activateLayout(h.manifest, "grid", null); // open archive, no initial stream

  // View the top-left corner: issues in-flight loads for the {0,1}x{0,1} tiles.
  h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  const firstView = [...signals.keys()];
  assert.ok(firstView.length > 0, "the first view issued in-flight loads");
  assert.ok(firstView.every((k) => !signals.get(k)!.aborted), "they start un-aborted");

  // Pan to the opposite corner — none of the first view's tiles are wanted now.
  h.world.emit({ center: [0.94, 0.94], zoom: FINE_GRID_ZOOM }, SMALL_VP);
  await settle();
  assert.ok(
    firstView.every((k) => signals.get(k)!.aborted),
    "every superseded in-flight load was aborted on the pan (not left running)",
  );
  // The newly-wanted corner tiles were issued and are NOT aborted.
  const secondOnly = [...signals.keys()].filter((k) => !firstView.includes(k));
  assert.ok(secondOnly.length > 0, "the new view issued its own loads");
  assert.ok(secondOnly.every((k) => !signals.get(k)!.aborted), "wanted loads are not aborted");
});

// ---------------------------------------------------------------------------
// RETAIN-UNTIL-COVERED (the zoom black-flash fix): an active tile whose key leaves
// `wanted` is held DRAWN while a wanted tile intersecting its footprint is still in
// flight — so the region never blanks to the page background during the load, and
// the tile demotes the instant its replacement(s) bind. Verified for zoom-in,
// fast multi-level zoom, coarse→coarse, and zoom-out.
// ---------------------------------------------------------------------------

/** A multi-FINE-level pyramid: z=1 (2x2), z=2 (4x4), z=3 (8x8), all fine
 *  (z_cap=0, no coarse band) — isolates the fine→fine retention behaviour. Zoom
 *  1/1024→z1, 1/2048→z2, 1/4096→z3 (the exact-level math the policy test pins). */
function fineLevelsPyramid(): PyramidDescriptor {
  return {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [
      { z: 1, tile_count: 4 },
      { z: 2, tile_count: 16 },
      { z: 3, tile_count: 64 },
    ],
    z_cap: 0,
  };
}

/** Fine bodies for every tile at z=1,2,3 over [0,1]^2. */
function fineLevelsBodies(): Map<string, Uint8Array | null> {
  const bodies = new Map<string, Uint8Array | null>();
  for (const z of [1, 2, 3]) {
    const n = 2 ** z;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) bodies.set(`${z}/${x}/${y}`, fineBody(FAKE_WEBP, [{ id: y * n + x, x: 0.5, y: 0.5 }]));
    }
  }
  return bodies;
}

/** A fake archive that resolves tiles whose z does NOT satisfy `hold`, and holds
 *  (keeps in flight) tiles whose z DOES satisfy `hold` until `release()` is called.
 *  Lets a test observe the load window during which a deeper level is still in
 *  flight — exactly when the shallower coverage must be retained. */
function gatedByLevelArchive(
  bodies: Map<string, Uint8Array | null>,
  hold: (z: number) => boolean,
): FakeArchive & { release: () => void; held: number } {
  const gate = { resolvers: [] as (() => void)[] };
  const archive = {
    bodies,
    requested: [] as string[],
    held: 0,
    async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      if (hold(z)) {
        archive.held++;
        await new Promise<void>((r) => gate.resolvers.push(r));
      } else {
        await Promise.resolve();
      }
      if (signal?.aborted === true) {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      return bodies.get(key) ?? null;
    },
    release(): void {
      for (const r of gate.resolvers.splice(0)) r();
    },
  };
  return archive;
}

test("zoom z→z+1 keeps the old level drawn until the slow children bind, then demotes it", async () => {
  // z=1 resolves immediately; z=2 (the children) is GATED in flight. View a z1 tile,
  // then zoom to z2: the z1 coverage must stay DRAWN (not dropped) while the z2
  // children load, and only demote once they bind — no black flash.
  const bodies = fineLevelsBodies();
  const archive = gatedByLevelArchive(bodies, (z) => z === 2);
  const h = harness({ bodies, pyramid: fineLevelsPyramid(), archiveFactory: () => archive, cacheBudget: 64 });
  await h.pyramid.activateLayout(h.manifest, "grid", null);

  // View the top-left at z1 (zoom 1/1024). z1 tiles bind (not gated).
  h.world.emit({ center: [0.12, 0.12], zoom: 1 / 1024 }, SMALL_VP);
  await settle();
  const page1 = tilePageId(1, 0, 0);
  assert.ok(
    h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 1 && c.page === page1),
    "the z1 tile bound (drawn) before the zoom",
  );
  const dropsBeforeZoom = h.cells.drops.length;

  // Zoom in to z2 (zoom 1/2048) over the same corner: z2 children are gated in
  // flight. The z1 tile is no longer wanted, but MUST be retained (still drawn).
  h.world.emit({ center: [0.12, 0.12], zoom: 1 / 2048 }, SMALL_VP);
  await settle();
  assert.ok(archive.held > 0, "the z2 children are in flight (gated)");
  assert.ok(
    !h.cells.drops.some((d) => d.lod === 1 && d.page === page1),
    "the z1 tile is RETAINED (not dropped) while its z2 children load — no black flash",
  );
  assert.ok(h.pyramid.residentTileCount() > 0, "coverage stays drawn across the zoom");

  // Release the z2 children: they bind, and the now-covered z1 tile demotes.
  archive.release();
  await settle();
  assert.ok(
    h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2),
    "the z2 children bound after release",
  );
  assert.ok(
    h.cells.drops.some((d) => d.lod === 1 && d.page === page1),
    "the retained z1 tile demoted once its z2 children bound (bounded retention)",
  );
  assert.ok(h.cells.drops.length > dropsBeforeZoom, "retention did not leak the old level");
});

test("fast multi-level zoom (z1→z2→z3) never leaves the viewport without coverage", async () => {
  // Consecutive streamView passes deepen the level while EVERY level's loads are
  // gated in flight (nothing binds until the end). The never-empty invariant: given
  // initial coverage existed, some renderable tile stays drawn at every step — the
  // old coverage is retained because the deeper wanted tiles are still in flight.
  const bodies = fineLevelsBodies();
  const archive = gatedByLevelArchive(bodies, () => true); // hold ALL levels in flight
  const h = harness({ bodies, pyramid: fineLevelsPyramid(), archiveFactory: () => archive, cacheBudget: 64 });
  await h.pyramid.activateLayout(h.manifest, "grid", null);

  // Seed z1 coverage: view z1, release so it binds, then re-gate deeper levels.
  h.world.emit({ center: [0.12, 0.12], zoom: 1 / 1024 }, SMALL_VP);
  await settle();
  archive.release(); // z1 binds
  await settle();
  assert.ok(h.pyramid.residentTileCount() > 0, "initial z1 coverage is drawn");

  // Now zoom z1→z2→z3 in consecutive passes; z2/z3 loads stay gated (never bind).
  // At each step the previous coverage must NOT drop out from under the viewport.
  for (const zoom of [1 / 2048, 1 / 4096]) {
    h.world.emit({ center: [0.12, 0.12], zoom }, SMALL_VP);
    await settle();
    assert.ok(
      h.pyramid.residentTileCount() > 0,
      `viewport never empty mid-zoom at zoom ${zoom} (old coverage retained while deeper tiles load)`,
    );
  }
});

test("coarse→coarse zoom retains the shallower overview until the deeper overview binds", async () => {
  // A 2-coarse-level + fine pyramid (z_cap=2): z=0,1 are COARSE overview tiles.
  // Zooming z0→z1 is a coarse→coarse transition with NO coarse fallback band below
  // it — the exact case the old single `z_cap-1` floor never covered. The z0
  // overview must stay drawn (as a scene mesh) while the z1 overview loads.
  const pyramid: PyramidDescriptor = {
    container: "pmtiles",
    path: "tiles/grid/grid_v1.pmtiles",
    tile_px: 512,
    thumb_px: 64,
    cap: 64,
    levels: [
      { z: 0, tile_count: 1 },
      { z: 1, tile_count: 4 },
      { z: 2, tile_count: 16 },
    ],
    z_cap: 2,
  };
  const bodies = new Map<string, Uint8Array | null>();
  bodies.set("0/0/0", FAKE_WEBP);
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) bodies.set(`1/${x}/${y}`, FAKE_WEBP);
  const archive = gatedByLevelArchive(bodies, (z) => z === 1); // hold the z1 overview in flight
  const h = harness({ bodies, pyramid, archiveFactory: () => archive, cacheBudget: 64 });
  await h.pyramid.activateLayout(h.manifest, "grid", null);

  // Zoomed all the way out selects z0 (a single coarse overview quad). It binds.
  h.world.emit({ center: [0.5, 0.5], zoom: 1 }, VIEWPORT);
  await settle();
  const meshesAtZ0 = [...h.world.sceneObjects].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  assert.equal(meshesAtZ0.length, 1, "the z0 coarse overview is drawn");
  const z0Mesh = meshesAtZ0[0];

  // Zoom in one coarse step to z1 (zoom 1/1024 → 2 tiles per axis → z1). z1
  // overviews are gated in flight; the z0 overview must be RETAINED (still drawn).
  h.world.emit({ center: [0.5, 0.5], zoom: 1 / 1024 }, VIEWPORT);
  await settle();
  assert.ok(archive.held > 0, "the z1 overview is in flight (gated)");
  assert.ok(
    h.world.sceneObjects.has(z0Mesh),
    "the z0 overview is RETAINED (still drawn) during the coarse→coarse zoom — no black flash",
  );

  // Release z1: it binds, and the now-covered z0 overview is demoted (mesh removed).
  archive.release();
  await settle();
  assert.ok(!h.world.sceneObjects.has(z0Mesh), "the z0 overview demoted once the z1 overview bound");
  const meshesAtZ1 = [...h.world.sceneObjects].filter((o) => o instanceof THREE.Mesh);
  assert.ok(meshesAtZ1.length > 0, "the z1 overview(s) are drawn now");
});

test("zoom-out retains the deeper tiles until the shallower tile binds, then releases them (no leak)", async () => {
  // The symmetric direction: view z2 (bound), then zoom OUT to z1 with the z1 tile
  // gated in flight. The z2 tiles must stay drawn while z1 loads, and demote once
  // it binds — retention must not leak the deeper level after the zoom-out settles.
  const bodies = fineLevelsBodies();
  const archive = gatedByLevelArchive(bodies, (z) => z === 1); // hold the shallower z1 in flight
  const h = harness({ bodies, pyramid: fineLevelsPyramid(), archiveFactory: () => archive, cacheBudget: 64 });
  await h.pyramid.activateLayout(h.manifest, "grid", null);

  // View z2 over the top-left (zoom 1/2048): z2 tiles bind (not gated).
  h.world.emit({ center: [0.12, 0.12], zoom: 1 / 2048 }, SMALL_VP);
  await settle();
  const boundZ2 = h.cells.calls.filter((c) => c.kind === "buffers" && c.lod === 2).map((c) => c.page);
  assert.ok(boundZ2.length > 0, "z2 tiles bound before the zoom-out");

  // Zoom OUT to z1 (zoom 1/1024): the z1 tile is gated. The z2 tiles are no longer
  // wanted but MUST be retained (not dropped) while the shallower z1 loads.
  h.world.emit({ center: [0.12, 0.12], zoom: 1 / 1024 }, SMALL_VP);
  await settle();
  assert.ok(archive.held > 0, "the z1 tile is in flight (gated)");
  assert.ok(
    !h.cells.drops.some((d) => d.lod === 2 && boundZ2.includes(d.page)),
    "the z2 tiles are RETAINED (not dropped) while the shallower z1 loads — no black flash on zoom-out",
  );

  // Release z1: it binds, and the now-covered z2 tiles demote (retention released).
  archive.release();
  await settle();
  assert.ok(
    h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 1),
    "the z1 tile bound after release",
  );
  assert.ok(
    boundZ2.every((page) => h.cells.drops.some((d) => d.lod === 2 && d.page === page)),
    "every retained z2 tile demoted once the z1 tile bound — retention did not leak",
  );
});

// ---------------------------------------------------------------------------
// BOUNDED RETRY (T2-44): a tile whose load fails for a NON-abort reason (flaky
// network / transient 5xx) is re-armed with an exponential backoff on a STILL
// camera — so a transient hole self-heals instead of persisting until the next
// gesture — while an ABORT (supersede) is never retried and a persistently-failing
// tile stops at its retry CAP (no offline tight-loop). Fake timers fire the backoff
// without waiting the real 1s/2s/4s.
// ---------------------------------------------------------------------------

/** Install a synchronous fake `setTimeout` that records pending callbacks so a
 *  test can fire the backoff timers by hand (the loader's watchdog tests use the
 *  same trick). Returns the pending list + a restore fn. clearTimeout is stubbed to
 *  drop a cancelled entry so a cleared retry is not fired. */
function fakeTimers(): { pending: { id: number; fn: () => void }[]; fireAll: () => void; restore: () => void } {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending: { id: number; fn: () => void }[] = [];
  let nextId = 1;
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void) => {
    const id = nextId++;
    pending.push({ id, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: unknown) => {
    const idx = pending.findIndex((p) => p.id === id);
    if (idx >= 0) pending.splice(idx, 1);
  }) as typeof clearTimeout;
  return {
    pending,
    fireAll(): void {
      for (const p of pending.splice(0)) p.fn();
    },
    restore(): void {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
      (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = realClearTimeout;
    },
  };
}

/** A fake archive over the fine grid whose tile `failKey` REJECTS its first
 *  `failTimes` requests (a non-abort Error) then serves the body; every other tile
 *  serves normally. Honours the abort signal like the real archives. */
function flakyFineArchive(failKey: string, failTimes: number): FakeArchive {
  const bodies = fineGridBodies();
  let failsLeft = failTimes;
  const archive: FakeArchive = {
    bodies,
    requested: [],
    async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      await Promise.resolve();
      if (signal?.aborted === true) {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      if (key === failKey && failsLeft > 0) {
        failsLeft--;
        throw new Error(`transient failure for ${key}`); // a NON-abort failure
      }
      return bodies.get(key) ?? null;
    },
  };
  return archive;
}

test("a tile that fails twice then succeeds ends BOUND after the backoff retries (T2-44)", async () => {
  // Tile 2/0/0 fails its first two fetches, then serves. On a STILL camera the
  // loader must re-arm a backed-off retry each time and end with the tile drawn —
  // the never-grey intent for the flaky-network case, without a gesture.
  const archive = flakyFineArchive("2/0/0", 2);
  const page00 = tilePageId(2, 0, 0);
  const timers = fakeTimers();
  try {
    const h = harness({ bodies: fineGridBodies(), pyramid: fineGridPyramid(), imageCount: 16, archiveFactory: () => archive });
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    // View the top-left corner: 2/0/0 is wanted; its first fetch fails.
    h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
    assert.ok(
      !h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2 && c.page === page00),
      "the tile is NOT bound after its first (failed) fetch",
    );
    assert.ok(timers.pending.length > 0, "a retry backoff timer was armed on the failure");

    // Fire the 1st retry (still fails), then the 2nd (succeeds). settle() drains the
    // getTile microtask each time; the camera never moves.
    timers.fireAll();
    await settle();
    assert.ok(
      !h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2 && c.page === page00),
      "still unbound after the 1st retry (2nd fetch also failed)",
    );
    timers.fireAll();
    await settle();
    assert.ok(
      h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2 && c.page === page00),
      "the tile BOUND on the retry that succeeded (bound through the normal path)",
    );
    assert.ok(h.pyramid.residentTileCount() > 0, "the recovered tile is resident/drawn");
    // Exactly 3 fetches of 2/0/0: initial + two retries (the 3rd served).
    assert.equal(
      archive.requested.filter((k) => k === "2/0/0").length,
      3,
      "one initial fetch + two retries",
    );
  } finally {
    timers.restore();
  }
});

test("an ABORTED (superseded) load is NOT retried (T2-44)", async () => {
  // A pan away aborts the corner tiles' in-flight loads. An abort is a supersede,
  // not a failure — no retry timer may be armed for an aborted tile, and it must
  // never be re-fetched after the pan.
  const signals = new Map<string, AbortSignal>();
  const archive: FakeArchive = {
    bodies: new Map(),
    requested: [],
    getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      const key = `${z}/${x}/${y}`;
      archive.requested.push(key);
      if (signal !== undefined) signals.set(key, signal);
      return new Promise<Uint8Array | null>(() => {}); // never settles: stays in-flight until aborted
    },
  };
  const timers = fakeTimers();
  try {
    const h = harness({ bodies: new Map(), pyramid: fineGridPyramid(), archiveFactory: () => archive });
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    // View the top-left corner: issues in-flight loads that never resolve.
    h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
    const firstView = [...signals.keys()];
    assert.ok(firstView.length > 0, "the first view issued in-flight loads");
    const requestedBeforePan = archive.requested.length;

    // Pan to the opposite corner: the first view's loads are aborted (superseded).
    h.world.emit({ center: [0.94, 0.94], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
    assert.ok(firstView.every((k) => signals.get(k)!.aborted), "the first view's loads were aborted");
    // No retry timer may be pending for the aborted (now-unwanted) corner tiles.
    // Fire any timers that DID arm (the new corner's are un-aborted, still in
    // flight, so they don't fail/retry either) and confirm the aborted tiles are
    // never re-requested.
    timers.fireAll();
    await settle();
    const refetchedFirstView = archive.requested
      .slice(requestedBeforePan)
      .filter((k) => firstView.includes(k) && !archive.requested.slice(0, requestedBeforePan).includes(k));
    // The aborted tiles from the first view must not be re-requested by a retry.
    for (const k of firstView) {
      const count = archive.requested.filter((r) => r === k).length;
      assert.equal(count, 1, `aborted tile ${k} was requested once and never retried`);
    }
    void refetchedFirstView;
  } finally {
    timers.restore();
  }
});

test("a persistently-failing tile stops retrying at the cap (no offline tight-loop) (T2-44)", async () => {
  // Tile 2/0/0 ALWAYS fails. On a still camera the retries must stop at the cap
  // (RETRY_ATTEMPT_BACKOFF_MS.length = 3 retries), i.e. 4 total fetches — never an
  // unbounded loop while offline. The coarse parent-fallback (not exercised here,
  // z_cap=0) is the terminal floor in production.
  const archive = flakyFineArchive("2/0/0", Number.POSITIVE_INFINITY);
  const timers = fakeTimers();
  try {
    const h = harness({ bodies: fineGridBodies(), pyramid: fineGridPyramid(), imageCount: 16, archiveFactory: () => archive });
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();

    // Drain every armed retry until no more timers arm (bounded by the cap). Guard
    // the loop count so a regression that tight-loops fails the test instead of
    // hanging it.
    let iterations = 0;
    while (timers.pending.length > 0) {
      timers.fireAll();
      await settle();
      if (++iterations > 20) break; // safety: the cap must stop us well before this
    }
    assert.ok(iterations <= 4, `retries stopped at the cap after ${iterations} rounds (no tight-loop)`);
    // 4 total fetches of 2/0/0: the initial + exactly 3 retries, then it gives up.
    assert.equal(
      archive.requested.filter((k) => k === "2/0/0").length,
      4,
      "initial fetch + 3 capped retries, then no more (offline does not tight-loop)",
    );
    assert.equal(timers.pending.length, 0, "no retry timer left armed after the cap");
  } finally {
    timers.restore();
  }
});

test("a camera move RESETS the retry budget so a re-engaged view retries afresh (T2-44)", async () => {
  // A tile that failed its whole budget on one view gets a clean slate when the
  // user moves the camera (fresh intent) — the cap only has to hold on a STILL
  // camera. Tile 2/0/0 fails 4× (exhausts the initial view's budget) then serves;
  // after the cap we move the camera back onto it and it retries + binds.
  const archive = flakyFineArchive("2/0/0", 4);
  const page00 = tilePageId(2, 0, 0);
  const timers = fakeTimers();
  try {
    const h = harness({ bodies: fineGridBodies(), pyramid: fineGridPyramid(), imageCount: 16, archiveFactory: () => archive });
    await h.pyramid.activateLayout(h.manifest, "grid", null);
    // First view of the corner: initial + 3 capped retries all fail (4 failures).
    h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
    let guard = 0;
    while (timers.pending.length > 0 && guard++ < 10) {
      timers.fireAll();
      await settle();
    }
    assert.ok(
      !h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2 && c.page === page00),
      "the tile is still unbound after exhausting the first view's retry budget",
    );
    const fetchesAfterFirstView = archive.requested.filter((k) => k === "2/0/0").length;
    assert.equal(fetchesAfterFirstView, 4, "the first view spent its whole budget (4 fetches)");

    // Re-engage: nudge the camera off the corner and back. streamView resets the
    // budget, so 2/0/0 is fetched again — and now (5th fetch) it serves.
    h.world.emit({ center: [0.9, 0.9], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
    h.world.emit({ center: [0.06, 0.06], zoom: FINE_GRID_ZOOM }, SMALL_VP);
    await settle();
    assert.ok(
      h.cells.calls.some((c) => c.kind === "buffers" && c.lod === 2 && c.page === page00),
      "the re-engaged view retried the tile afresh and bound it",
    );
  } finally {
    timers.restore();
  }
});
