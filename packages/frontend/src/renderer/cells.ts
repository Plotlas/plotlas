import * as THREE from "three";
import type { Table } from "apache-arrow";
import type { CameraState, Viewport, World } from "./world";
import { rendererDebug, publishRendererDebug, vizDebugAvailable } from "./debug.ts";

// One decoded tile's worth of cell records as flat typed arrays (struct-of-arrays),
// matching cell_record.schema.json field order. Pushed straight into GPU buffers.
export interface CellBuffers {
  ids: BigInt64Array; // id
  positions: Float32Array; // x,y interleaved (2 per cell)
  sizes: Float32Array; // w,h interleaved (2 per cell)
  atlasPage: Int32Array;
  atlasUv: Float32Array; // u,v,w,h interleaved (4 per cell)
  lod: Int8Array;
  count: number;
}

export interface PickResult {
  cellId: number | null; // null if background was clicked
}

export interface Cells {
  /** Apply one tile's cell records: each cell renders AT its buffer position
   *  immediately (positions/sizes snap on arrival — there is no client-side
   *  position tween; a layout switch streams the new layout's tiles and the
   *  cells appear in place, camera preserved). */
  setBuffers(buffers: CellBuffers): void;
  /** Bind a decoded page texture (or, with `isPlaceholder`, the shared 1×1 grey
   *  placeholder on eviction/failure). `isPlaceholder` lets the never-grey guard
   *  tell a real bound page from a placeholder-bound (evicted/failed) one. */
  setAtlasTexture(lod: number, page: number, texture: THREE.Texture, isPlaceholder?: boolean): void;
  /** Per-cell visibility, 1 byte per cell; owned here, written via layout.ts. */
  setVisibility(visible: Uint8Array): void;
  pick(screenX: number, screenY: number): PickResult;
  dispose(): void;
}

/**
 * Renderer-internal extension of the catalogue `Cells` interface (consumed by
 * tilePyramid.ts / layout.ts / the perf harness only; the catalogue surface
 * above is implemented verbatim).
 *
 * Boundary convention for `setVisibility`: the input array is indexed by
 * **cell id** (ids are dense, pipeline-assigned 0..N-1 — see
 * cell_record.schema.json), NOT by instance slot. Cells owns the id ->
 * instance mapping (its CPU mirror) and gathers id-indexed input into the
 * per-instance GPU attributes — O(resident) per call, O(1) per frame. This is
 * what lets layout.ts evaluate tags without knowing GPU instance order.
 * Out-of-range entries mean "keep visible".
 */
export interface CellsHandle extends Cells {
  residentCount(): number;
  /** Number of cells currently bound to the `(lod, page)` bucket (0 when that
   *  bucket has been emptied/reclaimed). Renderer-internal introspection for
   *  the O1-8 retain-until-bound release: an OLD-LOD page is freed only
   *  once its bucket is empty (every cell migrated to the new LOD), so a still-
   *  textured cell is never repainted to the placeholder. (The catalogue `Cells`
   *  surface is unchanged.) */
  residentOnPage(lod: number, page: number): number;
  /** §0.6 WebGL context-loss recovery. The context was lost and is being
   *  restored IN PLACE; every GPU texture upload is gone and the tile-pyramid
   *  loader has already dropped + disposed the tile textures it owned. Reset our
   *  texture BINDINGS so no bucket references a disposed texture — every bucket
   *  falls back to the flat placeholder (uHasTex=0, the exact pre-bind state
   *  createBucket starts in) until the loader re-fetches the current viewport's
   *  tiles. The buckets, geometry and per-cell positions are KEPT — THREE
   *  re-uploads the surviving attribute arrays on restore — so the VIEW is
   *  preserved; only the texture layer repopulates. Does NOT dispose any texture
   *  (the loader owns them) and does NOT touch geometry / materials / the shared
   *  base attributes, so the PR26-7 reclamation WeakMap is untouched and the
   *  never-grey real-vs-placeholder state (`texturedPages`) restarts clean for the
   *  coarse-first re-population. */
  handleContextRestored(): void;
  /** Dev diagnostic: of the cells currently on the grey placeholder, how many
   *  have their RENDERED QUAD (layout position ± half-size) overlapping `bbox`
   *  (the camera's visible world rect) — the FIELD-OF-VIEW grey count, what the
   *  user actually sees as grey, distinct from `placeholderCells` (the all-buckets
   *  total, which also counts off-screen retained tiles). Overlap (not centre-in-
   *  rect) so a big cell whose body fills the view but whose centre falls off the
   *  rect at deep zoom is still counted. Optional: an older Cells / a test double
   *  may omit it. */
  countPlaceholderInView?(bbox: { xMin: number; xMax: number; yMin: number; yMax: number }): number;
  /** §0.3a never-grey, the REACTIVE half. Re-home cells that are CURRENTLY on the
   *  grey placeholder onto this coarser, resident tier's buckets, so a cell whose
   *  fine atlas page was evicted (VRAM ceiling / fan-out thrash) degrades to a
   *  low-res image instead of flat grey. A cell already on a textured (sharp)
   *  bucket is LEFT untouched — a sharp cell is never downgraded; only grey cells
   *  move, and only onto a textured target. lod.ts drives this with the always-
   *  resident coarse (LOD0) tile buffers when an eviction strands cells. The
   *  proactive guard in setBuffers refuses to migrate ONTO an unbound finer
   *  bucket; this is its mirror — rescuing a cell that was already stranded.
   *  Optional: an older Cells / a test double may omit it. */
  applyCoarseFallback?(buffers: CellBuffers): void;
  /** v2 (D-33): drop a whole tile's cells when the tile-pyramid loader evicts it
   *  from the working set. Removes every cell currently resident on the
   *  `(lod, page)` bucket (so off-screen tiles do not accumulate buckets/draw
   *  calls — the v1 pager kept them resident forever, growing unboundedly with
   *  exploration), reclaims the bucket's GPU geometry/material, and forgets its
   *  texture binding. The THREE.Texture itself is owned + disposed by the loader.
   *  The loader only ever drops tiles OUTSIDE the kept (visible + fallback) band,
   *  so an on-screen cell is never removed; its coarse-overview floor covers the
   *  gap until the fine tile re-streams. Optional: a test double may omit it. */
  dropTile?(lod: number, page: number): void;
  /** T2-66/T2-48 (v2.2): register a COARSE-TIER pick fallback. When `pick()` finds
   *  no resident fine-tier cell under the point (the common case zoomed out, where
   *  only mosaic overview quads are drawn — nothing per-cell to hit), it calls this
   *  fn with the WORLD coordinates; the fn returns the cell id from the layout's
   *  position table (or null). It took the camera `zoom` too until T2-204, purely so
   *  it could apply a screen-size pick floor — that floor is gone (see
   *  `hitTestPositionTable`), and with it the argument. The tile-pyramid loader owns the
   *  position table (it fetches/caches it per layout and releases it on a
   *  dataset/layout switch) and registers the scan here; passing `null` clears it
   *  (no table ⇒ fine-tier-only picking, exactly the pre-2.2 behaviour — graceful
   *  absence). Keeping the table OUT of cells.ts (which is GL/geometry only, with no
   *  client/network) and wiring it through this hook preserves the module boundary.
   *  Optional: a test double may omit it. */
  setCoarsePickFallback?(fn: ((worldX: number, worldY: number) => number | null) | null): void;
}

// Cells render AT iTranslation directly: positions snap on arrival (setBuffers).
// The D-10 translation→target lerp (iTarget + uT mix) was deleted with the
// layout-switch tween — a switch is an instant, camera-preserving swap.
const VERTEX_SHADER = /* glsl */ `
  precision highp float;
  attribute vec2 iTranslation;
  attribute vec2 iSize;
  attribute vec4 iUvRect;
  attribute float iVisibility;
  varying vec2 vUv;
  varying float vVis;
  void main() {
    vec2 p = iTranslation + position.xy * iSize;
    vUv = iUvRect.xy + uv * iUvRect.zw;
    vVis = iVisibility;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
  }
`;

// Non-matching cells are DE-EMPHASIZED, not removed (D-08): visibility 0 dims
// and desaturates; positions never change. Atlas pages that have not arrived
// (or failed / were evicted) render as a flat placeholder so a gap is
// attributable to loading, not layout (gap analysis #8).
const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform sampler2D uAtlas;
  uniform float uHasTex;
  varying vec2 vUv;
  varying float vVis;
  void main() {
    vec4 c = vec4(0.55, 0.55, 0.55, 1.0);
    if (uHasTex > 0.5) {
      c = texture2D(uAtlas, vUv);
    }
    float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    vec3 dimmed = mix(vec3(g) * 0.45, c.rgb, 0.2);
    vec3 rgb = mix(dimmed, c.rgb, vVis);
    float a = c.a * mix(0.4, 1.0, vVis);
    // The atlas is sampled in LINEAR space (Three uploads the sRGB-tagged texture
    // with an sRGB internal format, so texture2D decodes it). The coarse overview's
    // MeshBasicMaterial auto-encodes linear->sRGB on output; this custom shader must
    // do the same or the fine cells render too dark/muted vs the coarse tier. Exact
    // sRGB OETF (piecewise), matching Three's linearToOutputTexel.
    vec3 srgb = mix(rgb * 12.92, 1.055 * pow(max(rgb, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, rgb));
    gl_FragColor = vec4(srgb, a);
  }
`;

const INITIAL_BUCKET_CAPACITY = 256;

interface Bucket {
  key: string;
  lod: number;
  page: number;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  capacity: number;
  count: number;
  // GPU attribute arrays double as the CPU mirror (picking scratch).
  translation: THREE.InstancedBufferAttribute; // Float32 x,y
  size: THREE.InstancedBufferAttribute; // Float32 w,h
  uvRect: THREE.InstancedBufferAttribute; // Float32 u,v,w,h
  visibility: THREE.InstancedBufferAttribute; // Uint8 normalized
  ids: Float64Array; // slot -> cell id
}

interface Residency {
  bucket: Bucket;
  slot: number;
}

/** Pure pick core: world-space point-in-cell hit test over mirror arrays.
 *  Nearest cell center wins among hits; ties break to the higher id
 *  ("topmost" = drawn later for equal centers). Exported for unit tests. */
export function hitTestCells(
  worldX: number,
  worldY: number,
  ids: Float64Array,
  positions: ArrayLike<number>,
  sizes: ArrayLike<number>,
  count: number,
  best: { id: number; d2: number },
): void {
  for (let i = 0; i < count; i++) {
    const x = positions[2 * i];
    const y = positions[2 * i + 1];
    const hw = sizes[2 * i] / 2;
    const hh = sizes[2 * i + 1] / 2;
    if (worldX < x - hw || worldX > x + hw || worldY < y - hh || worldY > y + hh) continue;
    const dx = worldX - x;
    const dy = worldY - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best.d2 || (d2 === best.d2 && ids[i] > best.id)) {
      best.d2 = d2;
      best.id = ids[i];
    }
  }
}

/**
 * A whole layout's per-cell world rects, resident for pick-at-any-zoom (T2-66 /
 * T2-48, the v2.2 `positions_ref` table). The four typed arrays are indexed by
 * DENSE cell id (row i == cell id i — the table has no id column, that is the
 * on-disk encoding). This is the COARSE-tier pick fallback: when a click lands on
 * an overview/mosaic view where the fine tier has no per-cell geometry resident,
 * the pyramid loader scans this table (via `hitTestPositionTable`) so a cell is
 * still resolvable. Sized on the manifest's dense id space.
 */
export interface PositionTable {
  x: Float32Array; // cell centre x, indexed by id
  y: Float32Array; // cell centre y, indexed by id
  w: Float32Array; // cell width, indexed by id
  h: Float32Array; // cell height, indexed by id
  count: number; // == image_count (the dense id count)
}

/** Parse the position-table Arrow body (`x, y, w, h` float32 columns, row index ==
 *  dense cell id — no id column) into a `PositionTable` of flat typed arrays via the
 *  vector's native `toArray()` (a typed-array view for a single-chunk float32 column,
 *  a concatenated copy when chunked) — NOT a per-element `.get(i)` loop, which costs
 *  4M boxed accessor calls at 1M cells. Each column is then copied into a fresh
 *  Float32Array so nothing retains the decoded Table's IPC buffer. A malformed table
 *  (a missing column) throws — it is untrusted network data, but a wrong shape is a
 *  hard error, not a silent miss. Pure + exported for unit tests. */
export function parsePositionsTable(table: Table): PositionTable {
  const cols = ["x", "y", "w", "h"] as const;
  const out: Record<string, Float32Array> = {};
  for (const name of cols) {
    const vec = table.getChild(name);
    if (vec === null) throw new Error(`position table is missing the '${name}' column`);
    out[name] = new Float32Array(vec.toArray() as ArrayLike<number>);
  }
  return { x: out.x, y: out.y, w: out.w, h: out.h, count: table.numRows };
}

/** Hit-test a world point against a whole layout's `PositionTable` (the O(N)
 *  coarse-tier pick, T2-66). Returns the cell id whose rect the point lands in, or
 *  null on a miss. Overlap resolution is IDENTICAL to the fine-tier `hitTestCells`
 *  (nearest cell centre wins; ties break to the higher id — "topmost"), because it
 *  delegates to `hitTestCells` over id-indexed arrays (row i == id, so the ids ARE
 *  the row indices). A LINEAR scan over the typed arrays — fine at 10k, measurable
 *  at 1M — deliberately behind this one function so a spatial index can replace it
 *  later with no caller change (the follow-up). Pure + exported for unit tests.
 *
 *  NO screen-size floor (T2-204): a cell resolves at ANY zoom, exactly like the
 *  fine-tier `hitTestCells`, which never had one either. This used to be floored at
 *  ~3 CSS px so a sub-pixel cell was a MISS; that made the click dead across most of
 *  the zoom-out range (rijks "By date" is 0.6 px/cell at fit — never clickable) and
 *  its stated purpose, keeping click-on-background-clears-selection reachable, is now
 *  served by an explicit affordance (Escape / the inspector's "Clear selection"). */
export function hitTestPositionTable(
  worldX: number,
  worldY: number,
  table: PositionTable,
): number | null {
  const best = { id: -1, d2: Number.POSITIVE_INFINITY };
  hitTestPositionCore(worldX, worldY, table, best);
  return best.id >= 0 ? best.id : null;
}

/** The scan itself, sharing `best` accumulator semantics with `hitTestCells` so the
 *  fine and coarse tiers resolve overlaps the same way. `id` is the array index
 *  (dense). Kept separate from the public wrapper so it can accumulate into an
 *  externally-owned `best` if the two tiers are ever merged. */
function hitTestPositionCore(
  worldX: number,
  worldY: number,
  table: PositionTable,
  best: { id: number; d2: number },
): void {
  const { x, y, w, h, count } = table;
  for (let i = 0; i < count; i++) {
    const hw = w[i] / 2;
    const hh = h[i] / 2;
    const cx = x[i];
    const cy = y[i];
    if (worldX < cx - hw || worldX > cx + hw || worldY < cy - hh || worldY > cy + hh) continue;
    const dx = worldX - cx;
    const dy = worldY - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < best.d2 || (d2 === best.d2 && i > best.id)) {
      best.d2 = d2;
      best.id = i;
    }
  }
}

/** Count the cells in a `PositionTable` whose rect OVERLAPS the world `view` rect
 *  (T2-54, the status bar's "in view" figure + the D-B auto-fit trigger). Overlap
 *  (AABB intersection, touching edges excluded) matches the loader's tile-coverage
 *  test and the placeholder-in-view AABB — a cell larger than the view still counts.
 *  A LINEAR scan over the id-indexed typed arrays (the same O(N) as the coarse pick,
 *  behind one function so a spatial index can replace it later). Pure + exported for
 *  unit tests. */
export function countPositionsInView(
  table: PositionTable,
  view: { xMin: number; yMin: number; xMax: number; yMax: number },
): number {
  const { x, y, w, h, count } = table;
  let n = 0;
  for (let i = 0; i < count; i++) {
    const hw = w[i] / 2;
    const hh = h[i] / 2;
    if (x[i] + hw > view.xMin && x[i] - hw < view.xMax && y[i] + hh > view.yMin && y[i] - hh < view.yMax) {
      n++;
    }
  }
  return n;
}

/** One visible cell's world rect, id == dense row index (the detail overlay's
 *  candidate shape — T2-26). */
export interface CellCandidate {
  id: number;
  x: number; // centre x
  y: number; // centre y
  w: number; // width
  h: number; // height
}

/** ONE pass over a `PositionTable` for the detail overlay, which needs, on every engaged
 *  frame, whether the view is over its in-view cap and, if it is not, the view's cells. It
 *  returns:
 *    - `inView`: the raw in-view overlap count (`countPositionsInView`'s number), EXACT UP TO
 *      `maxN + 1`. Over the cap the scan STOPS at the first cell past it and returns
 *      `maxN + 1`, because "over the cap or not" is all its caller reads. A zoomed-out view is
 *      always over the cap, so it stops after a few hundred in-view rows, not the whole table.
 *    - `candidates`: within the cap, the in-view cells in dense-id order as `{id, x, y, w, h}`
 *      records (id == the dense row index), the caller focal-orders them. With
 *      `dedupeCellWorld` (T2-72 pile coexistence: a world-unit grid size) coincident cells
 *      collapse DURING the scan to their first-seen (== lowest-id) member, the same
 *      representative the pyramid keeps. Over the cap, NONE: the caller hard-skips there,
 *      and an empty list cannot be mistaken for the view's cells.
 *  Same AABB overlap test as `countPositionsInView`, which stays for its other caller (the
 *  status bar's in-view figure needs the exact count). Before this function the overlay
 *  scanned the whole table twice per engaged refresh (PR #409 review: a median 22-23 ms on
 *  1,010,469 rows). Pure + exported for unit tests. */
export function scanPositionsInView(
  table: PositionTable,
  view: { xMin: number; yMin: number; xMax: number; yMax: number },
  maxN: number,
  dedupeCellWorld?: number,
): { inView: number; candidates: CellCandidate[] } {
  const { x, y, w, h, count } = table;
  const dedupe = dedupeCellWorld !== undefined && dedupeCellWorld > 0 ? new Set<string>() : null;
  const cell = dedupeCellWorld ?? 0;
  const candidates: CellCandidate[] = [];
  let inView = 0;
  for (let i = 0; i < count; i++) {
    const hw = w[i] / 2;
    const hh = h[i] / 2;
    if (x[i] + hw > view.xMin && x[i] - hw < view.xMax && y[i] + hh > view.yMin && y[i] - hh < view.yMax) {
      if (++inView > maxN) break; // over the cap: the caller needs only that (see above)
      if (dedupe !== null) {
        const key = `${Math.round(x[i] / cell)},${Math.round(y[i] / cell)}`;
        if (dedupe.has(key)) continue; // coincident with a kept lower-id representative
        dedupe.add(key);
      }
      candidates.push({ id: i, x: x[i], y: y[i], w: w[i], h: h[i] });
    }
  }
  return { inView, candidates: inView > maxN ? [] : candidates };
}

/** Screen (CSS px) -> world coords for the given camera state/viewport.
 *  zoom is world units per screen pixel (I-09). Exported for unit tests. */
export function screenToWorld(
  state: CameraState,
  viewport: Viewport,
  screenX: number,
  screenY: number,
): [number, number] {
  return [
    state.center[0] + (screenX - viewport.width / 2) * state.zoom,
    state.center[1] + (screenY - viewport.height / 2) * state.zoom,
  ];
}

export function createCells(world: World): CellsHandle {
  const buckets = new Map<string, Bucket>();
  const residency = new Map<number, Residency>();
  const textures = new Map<string, THREE.Texture>();
  // §0.3a: the subset of `textures` keys holding a REAL (non-placeholder) page —
  // the never-grey migration guard reads this so a placeholder-bound (evicted or
  // failed) page is never mistaken for a bound one. Maintained by setAtlasTexture.
  const texturedPages = new Set<string>();

  // Latest id-indexed visibility (re-applied to cells that arrive later).
  let visById: Uint8Array | null = null;

  // T2-66/T2-48: the coarse-tier pick fallback the tile-pyramid loader registers
  // (a scan over the layout's position table). null ⇒ no table for this layout
  // (pre-2.2 dataset or not yet loaded) ⇒ fine-tier-only picking.
  let coarsePickFallback: ((worldX: number, worldY: number) => number | null) | null = null;

  // Latest camera state for picking (world emits immediately on subscribe).
  let camState: CameraState | null = null;
  let camViewport: Viewport | null = null;
  const unsubscribe = world.onCameraChange((s, v) => {
    camState = s;
    camViewport = v;
    // §0.6 view-preservation probe: mirror the camera so an external diagnostic
    // can assert a forced context loss recovered to the SAME view (DEV-only;
    // O(1), stripped from a prod build like the rest of the debug surface).
    // Mutate the tuple in place — no per-event allocation, no literal-widening.
    if (vizDebugAvailable) {
      rendererDebug.cameraCenter[0] = s.center[0];
      rendererDebug.cameraCenter[1] = s.center[1];
      rendererDebug.cameraZoom = s.zoom;
      publishRendererDebug();
    }
  });

  // Base quad shared by every bucket: unit square centered on the origin.
  // uv (0,0) sits on the (-0.5,-0.5) vertex, which the y-down camera places at
  // the cell's screen top-left — matching atlas v measured from the image top
  // (textures are uploaded with flipY=false in lod.ts).
  const basePositions = new THREE.BufferAttribute(
    new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    3,
  );
  const baseUvs = new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2);
  const baseIndex = new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);

  function createBucket(key: string, lod: number, page: number): Bucket {
    const capacity = INITIAL_BUCKET_CAPACITY;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(baseIndex);
    geometry.setAttribute("position", basePositions);
    geometry.setAttribute("uv", baseUvs);

    const translation = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const size = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const uvRect = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const visibility = new THREE.InstancedBufferAttribute(new Uint8Array(capacity), 1, true);
    translation.setUsage(THREE.DynamicDrawUsage);
    visibility.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iTranslation", translation);
    geometry.setAttribute("iSize", size);
    geometry.setAttribute("iUvRect", uvRect);
    geometry.setAttribute("iVisibility", visibility);
    geometry.instanceCount = 0;

    const texture = textures.get(key) ?? null;
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uAtlas: { value: texture },
        uHasTex: { value: texture !== null ? 1 : 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false; // instances span the world; geometry bounds lie
    mesh.matrixAutoUpdate = false;
    world.scene.add(mesh);

    const bucket: Bucket = {
      key,
      lod,
      page,
      geometry,
      material,
      mesh,
      capacity,
      count: 0,
      translation,
      size,
      uvRect,
      visibility,
      ids: new Float64Array(capacity),
    };
    buckets.set(key, bucket);
    return bucket;
  }

  function growBucket(bucket: Bucket): void {
    const capacity = bucket.capacity * 2;
    const grow = (
      attr: THREE.InstancedBufferAttribute,
      itemSize: number,
      Ctor: Float32ArrayConstructor | Uint8ArrayConstructor,
      normalized: boolean,
    ): THREE.InstancedBufferAttribute => {
      const next = new Ctor(capacity * itemSize);
      next.set(attr.array as never);
      const a = new THREE.InstancedBufferAttribute(next, itemSize, normalized);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    bucket.translation = grow(bucket.translation, 2, Float32Array, false);
    bucket.size = grow(bucket.size, 2, Float32Array, false);
    bucket.uvRect = grow(bucket.uvRect, 4, Float32Array, false);
    bucket.visibility = grow(bucket.visibility, 1, Uint8Array, true);
    bucket.geometry.setAttribute("iTranslation", bucket.translation);
    bucket.geometry.setAttribute("iSize", bucket.size);
    bucket.geometry.setAttribute("iUvRect", bucket.uvRect);
    bucket.geometry.setAttribute("iVisibility", bucket.visibility);
    const ids = new Float64Array(capacity);
    ids.set(bucket.ids);
    bucket.ids = ids;
    bucket.capacity = capacity;
  }

  function writeSlot(
    bucket: Bucket,
    slot: number,
    id: number,
    x: number,
    y: number,
    w: number,
    h: number,
    u: number,
    v: number,
    uw: number,
    vh: number,
  ): void {
    const t = bucket.translation.array as Float32Array;
    const sz = bucket.size.array as Float32Array;
    const uv = bucket.uvRect.array as Float32Array;
    t[2 * slot] = x;
    t[2 * slot + 1] = y;
    sz[2 * slot] = w;
    sz[2 * slot + 1] = h;
    uv[4 * slot] = u;
    uv[4 * slot + 1] = v;
    uv[4 * slot + 2] = uw;
    uv[4 * slot + 3] = vh;
    (bucket.visibility.array as Uint8Array)[slot] =
      visById !== null && id < visById.length && visById[id] === 0 ? 0 : 255;
    bucket.ids[slot] = id;
  }

  function markBucketDirty(bucket: Bucket): void {
    bucket.translation.needsUpdate = true;
    bucket.size.needsUpdate = true;
    bucket.uvRect.needsUpdate = true;
    bucket.visibility.needsUpdate = true;
    bucket.geometry.instanceCount = bucket.count;
    bucket.mesh.visible = bucket.count > 0;
  }

  function removeSlot(res: Residency): void {
    const bucket = res.bucket;
    const last = bucket.count - 1;
    if (res.slot !== last) {
      // swap-with-last to keep instances dense
      const copy = (attr: THREE.InstancedBufferAttribute, itemSize: number): void => {
        const arr = attr.array as Float32Array | Uint8Array;
        for (let k = 0; k < itemSize; k++) {
          arr[res.slot * itemSize + k] = arr[last * itemSize + k];
        }
      };
      copy(bucket.translation, 2);
      copy(bucket.size, 2);
      copy(bucket.uvRect, 4);
      copy(bucket.visibility, 1);
      const movedId = bucket.ids[last];
      bucket.ids[res.slot] = movedId;
      const movedRes = residency.get(movedId);
      if (movedRes !== undefined) movedRes.slot = res.slot;
    }
    bucket.count = last;
  }

  // PR26-7 / O1-4 bucket reclamation. A layout switch (or a LOD change) migrates
  // cells by id between buckets; the bucket they LEFT can end up empty and would
  // otherwise stay in the scene forever, holding GPU geometry/material and a
  // draw slot. Reclaim it — BUT every bucket's geometry SHARES the same base
  // `position`/`uv`/`index` BufferAttributes (one set for the whole renderer).
  // three's geometry.dispose() fires onGeometryDispose, which iterates EVERY
  // attribute on the geometry and gl.deleteBuffer()s it (WebGLAttributes.remove,
  // keyed by attribute identity in a WeakMap) — so a naive dispose() would free
  // the shared base buffers out from under every surviving bucket (the exact
  // hazard that deferred PR26-7). We therefore DETACH the shared base attributes
  // first (deleteAttribute / setIndex(null)); dispose() then frees only this
  // bucket's per-instance attributes. The base attributes are disposed once, at
  // teardown, in dispose(). A leak test guards this (renderer_lifecycle.test.ts).
  function reclaimBucket(bucket: Bucket): void {
    world.scene.remove(bucket.mesh);
    bucket.geometry.deleteAttribute("position");
    bucket.geometry.deleteAttribute("uv");
    bucket.geometry.setIndex(null);
    bucket.geometry.dispose(); // frees ONLY the per-instance attributes now
    bucket.material.dispose();
    buckets.delete(bucket.key);
    // The texture is owned + disposed by the tile-pyramid loader (v2). Leave the
    // `textures` entry intact: a bucket emptied by id-migration may be re-created
    // at the SAME stable (lod,page) key (tilePageId), and createBucket re-binds
    // the already-loaded page from `textures`. The loader's explicit v2 eviction
    // path is dropTile(), which removes the cells AND clears the `textures`/
    // `texturedPages` entry when a tile is dropped for good.
  }

  // The camera's visible world rect, derived from cells.ts's OWN live camera
  // subscription (camState/camViewport) — reusing screenToWorld so it can never
  // drift from picking. null until the first camera event. This is what lets the
  // FOV grey count below be computed HERE, on every bucket/texture mutation,
  // instead of by lod.ts only at refresh entry (the stale-cadence under-count).
  function viewBBox(): { xMin: number; xMax: number; yMin: number; yMax: number } | null {
    if (camState === null || camViewport === null) return null;
    const [xMin, yMin] = screenToWorld(camState, camViewport, 0, 0);
    const [xMax, yMax] = screenToWorld(camState, camViewport, camViewport.width, camViewport.height);
    return { xMin, xMax, yMin, yMax };
  }

  // Of the cells on the grey placeholder, how many have their RENDERED QUAD
  // (position ± half world-size) overlapping `bbox`. Overlap, not
  // centre-in-rect: at deep zoom a single cell can be LARGER than the view, so
  // its body fills the screen while its centre falls off the rect — a centre test
  // misses exactly the big grey cells the user is staring at. Iterates only
  // UN-textured (grey) buckets, so O(grey cells); the sole source of the AABB
  // logic (countPlaceholderInView delegates here).
  function placeholderInView(bbox: { xMin: number; xMax: number; yMin: number; yMax: number }): number {
    let n = 0;
    for (const bucket of buckets.values()) {
      if (bucketTextured(bucket)) continue;
      const tr = bucket.translation.array as Float32Array;
      const sz = bucket.size.array as Float32Array;
      for (let slot = 0; slot < bucket.count; slot++) {
        const x = tr[2 * slot];
        const y = tr[2 * slot + 1];
        const hw = sz[2 * slot] / 2;
        const hh = sz[2 * slot + 1] / 2;
        if (x + hw >= bbox.xMin && x - hw <= bbox.xMax && y + hh >= bbox.yMin && y - hh <= bbox.yMax) n += 1;
      }
    }
    return n;
  }

  // Dev-only: publish the bucket/placeholder view to the shared debug state.
  // `placeholderCells` (cells in a bucket showing the flat grey placeholder, i.e.
  // NOT bound to a real page texture) is the number that spikes on a
  // zoom-in-to-grey. Called after any mutation that can change a bucket's count or
  // texture binding.
  //
  // This MUST key on the real-vs-placeholder signal (`texturedPages`, via
  // bucketTextured) — the SAME signal the never-grey migration guard uses below —
  // NOT on `uHasTex`, which is 1 even when the placeholder is bound (see §0.3a).
  // The old `uHasTex > 0.5` test counted every placeholder-bound cell as
  // "textured", so this reported `placeholder 0` while the screen was full of grey
  // — blinding both the debug overlay AND the e2e grey gate (renderer-transition /
  // contextloss assert on this field). Keying on bucketTextured makes it see real
  // grey, so a regression that strands cells on the placeholder is finally caught.
  //
  // `placeholderCellsInView` is published HERE (cells.ts), not by lod.ts: it is
  // recomputed on every eviction/migration against cells.ts's own live camera
  // rect, so it tracks the grey AS IT IS CREATED by the async eviction wave —
  // fixing the under-count where lod.ts published it once at refresh entry, before
  // the wave stranded the cells.
  function publishCellDebug(): void {
    if (!vizDebugAvailable) return; // DEV-only; stripped from a prod build
    let total = 0;
    let placeholder = 0;
    const byLod: Record<number, { pages: number; cells: number; textured: number }> = {};
    for (const bucket of buckets.values()) {
      const slice = (byLod[bucket.lod] ??= { pages: 0, cells: 0, textured: 0 });
      slice.pages += 1;
      slice.cells += bucket.count;
      total += bucket.count;
      if (bucketTextured(bucket)) slice.textured += bucket.count;
      else placeholder += bucket.count;
    }
    const bbox = viewBBox();
    rendererDebug.totalCells = total;
    rendererDebug.placeholderCells = placeholder;
    rendererDebug.placeholderCellsInView = bbox !== null ? placeholderInView(bbox) : 0;
    rendererDebug.byLod = byLod;
    publishRendererDebug();
  }

  // §0.3a never-grey backstop. A bucket renders the flat grey placeholder until a
  // REAL page texture is bound. `texturedPages` holds exactly the keys with a real
  // (non-placeholder) page: setAtlasTexture adds a key on a real bind and removes it
  // when the shared 1×1 placeholder is (re)bound on eviction/failure — so a
  // loaded-then-evicted page reads as UN-textured here, never falsely "bound".
  // These drive the migration guard in setBuffers: a cell showing a real coarse
  // texture is never displaced onto a finer bucket whose page is unbound (or only
  // placeholder-bound) — it holds on its best-available coarser unit (Leaflet
  // `_retainParent`) until the finer page binds. Keying on real-vs-placeholder (not
  // `uHasTex`, which is 1 even for the placeholder) makes the guard correct for ANY
  // caller — incl. the coming tile tier, even one that migrates without lod.ts's
  // allPagesBound pre-check. (lod.ts loads the finer page BEFORE it migrates a
  // tile's cells and holds the whole tile coarse on a persistent failure, so under
  // the current renderer this is a backstop, not a path it routinely hits.)
  function bucketTextured(bucket: Bucket): boolean {
    return texturedPages.has(bucket.key);
  }
  // A cell written to `key` lands on a real texture iff `key` holds one: the bucket
  // already binds it, OR a freshly-created bucket will (createBucket reads `textures`,
  // which carries the real texture exactly when `texturedPages` has the key).
  function targetWouldBeTextured(key: string): boolean {
    return texturedPages.has(key);
  }

  // Shared core of `setBuffers` (apply) and `applyCoarseFallback` (rescue). It
  // places each id-indexed cell onto its `(lod, page)` bucket, swap-removing it
  // from any prior bucket, subject to a never-grey migration guard that differs
  // by mode:
  //   - apply (fallback=false): the PROACTIVE guard — do NOT displace a textured
  //     cell onto an UNBOUND finer bucket (that repaints it grey); hold it on its
  //     coarser textured unit until the finer page binds. A textured→textured or
  //     grey→anything move proceeds (a real LOD change / sharpening).
  //   - rescue (fallback=true): the REACTIVE mirror — move ONLY a cell currently
  //     on the grey placeholder, and ONLY onto a textured target. A sharp cell
  //     (already textured) is left exactly where it is, so re-applying the coarse
  //     tier to rescue evicted cells never downgrades the cells still showing the
  //     fine texture.
  function applyBuffers(buffers: CellBuffers, fallback: boolean): void {
    const touched = new Set<Bucket>();
    for (let i = 0; i < buffers.count; i++) {
      const id = Number(buffers.ids[i]);
      const lod = buffers.lod[i];
      const page = buffers.atlasPage[i];
      const key = `${lod}:${page}`;
      const existing = residency.get(id);
      if (fallback) {
        // Rescue: move ONLY a cell that is CURRENTLY stranded on the grey
        // placeholder, and ONLY onto a textured coarse target. Three skips:
        //  - no residency: nothing is stranded for this id, so the rescue must
        //    never ADD it. Initial population is setBuffers' job; a coarse tile's
        //    margin ids (and any id the active-LOD refresh has not applied yet)
        //    must not materialise here, or the fallback would render cells the
        //    refresh never asked for.
        //  - target itself grey: a grey→grey move is pointless and could mask a
        //    real pending load.
        //  - already here, or already sharp: a textured cell is never downgraded.
        if (existing === undefined) continue;
        if (!targetWouldBeTextured(key)) continue;
        if (existing.bucket.key === key || bucketTextured(existing.bucket)) continue;
      } else if (existing !== undefined && existing.bucket.key !== key) {
        // Proactive: do NOT move a textured cell into a finer bucket that has no
        // page bound yet — that repaints it to the grey placeholder. Hold it on
        // its current (coarser, textured) bucket — the best-available unit — and
        // skip it this pass; it migrates on a later setBuffers once the finer page
        // binds (its x/y/w/h are LOD-independent, so the held coarse slot stays
        // correct). Only when the current bucket is itself grey: there is nothing
        // coarser to preserve, so fall through and migrate.
        if (bucketTextured(existing.bucket) && !targetWouldBeTextured(key)) {
          continue;
        }
      }
      if (existing !== undefined && existing.bucket.key !== key) {
        removeSlot(existing);
        touched.add(existing.bucket);
        residency.delete(id);
      }
      let res = residency.get(id);
      if (res === undefined) {
        let bucket = buckets.get(key);
        if (bucket === undefined) bucket = createBucket(key, lod, page);
        if (bucket.count === bucket.capacity) growBucket(bucket);
        res = { bucket, slot: bucket.count };
        bucket.count++;
        residency.set(id, res);
      }
      writeSlot(
        res.bucket,
        res.slot,
        id,
        buffers.positions[2 * i],
        buffers.positions[2 * i + 1],
        buffers.sizes[2 * i],
        buffers.sizes[2 * i + 1],
        buffers.atlasUv[4 * i],
        buffers.atlasUv[4 * i + 1],
        buffers.atlasUv[4 * i + 2],
        buffers.atlasUv[4 * i + 3],
      );
      touched.add(res.bucket);
    }
    for (const bucket of touched) {
      // A bucket emptied by id-migration (layout switch / LOD change / a rescue
      // vacating an evicted fine bucket) is reclaimed instead of lingering as an
      // invisible empty draw (PR26-7 / O1-4). markBucketDirty already no-ops the
      // mesh for count 0, but reclaiming frees its GPU geometry + material too.
      if (bucket.count === 0) reclaimBucket(bucket);
      else markBucketDirty(bucket);
    }
    publishCellDebug();
  }

  return {
    setBuffers(buffers: CellBuffers): void {
      applyBuffers(buffers, false);
    },

    applyCoarseFallback(buffers: CellBuffers): void {
      applyBuffers(buffers, true);
    },

    dropTile(lod: number, page: number): void {
      // v2 (D-33): the loader evicted this tile from its working set. Remove every
      // cell resident on the bucket, reclaim the bucket (GPU geometry/material +
      // its draw call), and forget the texture binding. This is what bounds the
      // resident set by the viewport instead of by total exploration — the v1
      // pager left evicted tiles' cells resident forever. The THREE.Texture is
      // owned + disposed by the loader; we only drop our binding to it.
      const key = `${lod}:${page}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) return;
      for (let slot = 0; slot < bucket.count; slot++) residency.delete(bucket.ids[slot]);
      reclaimBucket(bucket); // scene.remove + detach shared base + dispose per-instance attrs/material
      textures.delete(key);
      texturedPages.delete(key);
      publishCellDebug();
    },

    setAtlasTexture(lod: number, page: number, texture: THREE.Texture, isPlaceholder = false): void {
      const key = `${lod}:${page}`;
      textures.set(key, texture);
      // §0.3a: track whether a REAL page is bound for this key. The shared
      // placeholder (rebound on eviction/failure) is NOT a real texture, so it
      // clears the flag — a loaded-then-evicted page must not read as "bound" to
      // the never-grey guard. (uHasTex below stays 1 either way: the placeholder is
      // still sampled, it is just flat grey.)
      if (isPlaceholder) texturedPages.delete(key);
      else texturedPages.add(key);
      const bucket = buckets.get(key);
      if (bucket !== undefined) {
        bucket.material.uniforms.uAtlas.value = texture;
        bucket.material.uniforms.uHasTex.value = 1;
      }
      publishCellDebug();
    },

    setVisibility(visible: Uint8Array): void {
      visById = visible;
      for (const bucket of buckets.values()) {
        const arr = bucket.visibility.array as Uint8Array;
        for (let slot = 0; slot < bucket.count; slot++) {
          const id = bucket.ids[slot];
          arr[slot] = id < visible.length && visible[id] === 0 ? 0 : 255;
        }
        bucket.visibility.needsUpdate = true;
      }
    },

    pick(screenX: number, screenY: number): PickResult {
      if (camState === null || camViewport === null) return { cellId: null };
      const [wx, wy] = screenToWorld(camState, camViewport, screenX, screenY);
      const best = { id: -1, d2: Number.POSITIVE_INFINITY };
      for (const bucket of buckets.values()) {
        hitTestCells(
          wx,
          wy,
          bucket.ids,
          bucket.translation.array as Float32Array,
          bucket.size.array as Float32Array,
          bucket.count,
          best,
        );
      }
      // Fine-tier hit wins. On a MISS (zoomed out onto mosaic overview quads, or a
      // fine tile not yet streamed), fall back to the layout position table (T2-66):
      // the loader registered a scan that resolves a cell rect at ANY zoom. null when
      // no table is registered (pre-2.2 dataset) — then this is the pre-2.2 behaviour.
      if (best.id >= 0) return { cellId: best.id };
      if (coarsePickFallback !== null) return { cellId: coarsePickFallback(wx, wy) };
      return { cellId: null };
    },

    setCoarsePickFallback(fn: ((worldX: number, worldY: number) => number | null) | null): void {
      coarsePickFallback = fn;
    },

    dispose(): void {
      unsubscribe();
      // Full teardown: dispose every surviving bucket's geometry WITH the shared
      // base still attached. three's onGeometryDispose frees each attribute by
      // identity through a WeakMap and no-ops a second free (WebGLAttributes.remove
      // guards on `if (data)`), so the shared base buffers are freed exactly once
      // (by the first bucket) and the rest are harmless re-frees — and the whole
      // renderer is going away, so there are no survivors to protect (unlike the
      // mid-session reclaimBucket path, which MUST detach the base first).
      for (const bucket of buckets.values()) {
        world.scene.remove(bucket.mesh);
        bucket.geometry.dispose();
        bucket.material.dispose();
      }
      buckets.clear();
      residency.clear();
      textures.clear(); // textures themselves are owned + disposed by lod.ts
      texturedPages.clear();
    },

    residentCount(): number {
      return residency.size;
    },

    residentOnPage(lod: number, page: number): number {
      // Empty / reclaimed buckets are deleted from `buckets`, so a missing key
      // means zero resident cells on that page (O1-8 retain-until-bound).
      return buckets.get(`${lod}:${page}`)?.count ?? 0;
    },

    countPlaceholderInView(bbox: { xMin: number; xMax: number; yMin: number; yMax: number }): number {
      // Count cells on the grey placeholder whose rendered quad overlaps the view
      // rect (delegates to the shared placeholderInView — the same AABB the live
      // publishCellDebug uses). O(grey cells), DEV-only.
      return placeholderInView(bbox);
    },

    handleContextRestored(): void {
      // Drop every bucket's texture binding back to the pre-bind state. We set
      // uAtlas = null + uHasTex = 0 (NOT the placeholder): uHasTex<=0.5 makes the
      // shader render flat grey WITHOUT sampling uAtlas, so it does not matter
      // that the placeholder's own GPU upload is gone too — and createBucket
      // already starts buckets in exactly this state, so it is a known-safe value
      // for the sampler uniform. The dead THREE.Texture objects (disposed by the
      // tile-pyramid loader on loss) are forgotten from `textures` so no bucket
      // references a disposed handle; `texturedPages` clears so the never-grey
      // guard sees a clean slate as the loader re-binds real tile textures.
      // Geometry / per-cell positions are untouched (THREE re-uploads them),
      // preserving the view.
      for (const bucket of buckets.values()) {
        bucket.material.uniforms.uAtlas.value = null;
        bucket.material.uniforms.uHasTex.value = 0;
      }
      textures.clear();
      texturedPages.clear();
      publishCellDebug();
    },
  };
}
