// T2-121 — the renderer TAG-HIGHLIGHT OVERLAY (re-scoped after the T2-120
// tier-visibility root-cause). The VISIBLE half of the tag filter: per-cell gold
// borders on the matching cells + a translucent dim over the rest, drawn from the
// client-resident position table (the v2.2 `positions_ref`, ~16 B/cell) OVER BOTH
// tiers at every zoom.
//
// WHY A NEW LAYER (T2-120's root cause): per-cell dim/highlight (`iVisibility`) lives
// ONLY in the fine-tier instanced pipeline (cells.ts). The coarse OVERVIEW tier is a
// single baked-mosaic `MeshBasicMaterial` quad (tilePyramid.drawOverview) that
// structurally CANNOT mark individual cells — so at normal browsing zoom on a large
// dataset the visible surface is the mosaic and a shader-attribute tweak never reaches
// the pixels the user sees. This overlay is positions-driven, not tier-coupled: it
// marks a cell's world rect regardless of which tier renders beneath it.
//
// PRIMARY vs SECONDARY (operator directive 2026-07-19, binding): accent BORDERS on the
// matches are the REQUIRED primary affordance — dimming non-matches alone is
// insufficient (low-contrast datasets like rijks_pilot's beige drawings make dim
// "barely noticeable"). Borders carry a MINIMUM on-screen size clamp: at overview zoom
// a cell is ~3 px and a hairline border vanishes, so a match stays a legible gold mark
// at any zoom; when the cell is large the border hugs the cell rect.
//
// SINGLE VISUAL SOURCE (no double-darkening): the tag selection is routed ENTIRELY
// through this overlay by layout.ts — it no longer calls cells.setVisibility on a tag
// selection (that fine-tier shader dim would both be invisible at browsing zoom AND
// double-darken against this overlay's dim). cells.setVisibility remains the Locate
// pulse's path (unchanged) and the #168 match-count plumbing is untouched.
//
// SPATIALLY CHUNKED (T2-127): the marks are drawn as one instanced mesh per (spatial bin ×
// treatment) rather than one world-spanning mesh per treatment. The overlay marks the WHOLE
// dataset — unlike the fine tier, whose instances are viewport-bounded by tile residency —
// so a single mesh (whose bounds cannot describe its instances, forcing frustumCulled=false)
// made the GPU walk all n instances every frame no matter how little was on screen. Per-bin
// meshes carry a TRUE bounding sphere, so THREE culls the off-screen bins and a zoomed-in
// view pays only for its own. See MARKER_CHUNK_TARGET / groupBoundingSphere.
//
// Like detailOverlay.ts this is a renderer module beside tilePyramid.ts / cells.ts: it
// never imports React/UI (module-map rule 4) and is created + driven by layout.ts (the
// LayoutController pushes the active position table + the selection). It self-tears-down
// on the World's dispose (symmetric with the tile-pyramid loader / detail overlay).
import * as THREE from "three";
import type { PositionTable } from "./cells.ts";
import type { CameraState, Viewport, World, WorldHandle } from "./world.ts";

// ---------------------------------------------------------------------------
// Config (ONE runtime-mutable object — the T2-101 settings-panel scaffolding
// pattern, mirroring DetailOverlayConfig so a future panel tunes both alike)
// ---------------------------------------------------------------------------

export interface HighlightOverlayConfig {
  /** Border colour — `--accent` #F0B429 (the theme's gold), as a raw sRGB hex. The
   *  shader writes it straight to the sRGB framebuffer (see hexToSrgbVec), so the mark
   *  reads as the exact CSS accent regardless of three's colour management. */
  accent: number;
  /** Non-matching cells' dim wash colour (near-black; barely tinted). */
  dimColor: number;
  /** Min on-screen marker size, CSS px (the legibility clamp): a match never renders
   *  below this on screen, so a ~3 px cell at overview zoom is still a legible gold
   *  mark. When the cell is larger than this the clamp is inert (border hugs the cell). */
  minMarkerPx: number;
  /** Border thickness, CSS px (constant on screen at every zoom). When the marker is
   *  small enough that a frame would not fit (minMarkerPx <= 2·borderPx) the mark fills
   *  solid — a gold dot — which the discard test yields for free. */
  borderPx: number;
  /** Border opacity (1 = opaque gold — maximum pop on low-contrast data). */
  borderAlpha: number;
  /** Dim opacity over non-matches (straight-alpha darken of the tier beneath). */
  dimAlpha: number;
}

export const DEFAULT_HIGHLIGHT_OVERLAY_CONFIG: HighlightOverlayConfig = {
  accent: 0xf0b429,
  dimColor: 0x0b0b0d,
  minMarkerPx: 6,
  borderPx: 1.75,
  borderAlpha: 1,
  dimAlpha: 0.5,
};

/** Explicit transparent draw order (THREE sorts transparent objects by renderOrder
 *  first, then distance). The coarse overview (z −1) and fine cells (z 0) both keep the
 *  default renderOrder 0; the detail overlay is 2. The dim sits ABOVE both tiers +
 *  detail so non-matches read dimmed on whichever tier shows; the borders sit above the
 *  dim so a min-clamped gold mark is never occluded by an adjacent cell's dim. */
export const RENDER_ORDER_HIGHLIGHT_DIM = 3;
export const RENDER_ORDER_HIGHLIGHT_BORDER = 4;

// ---------------------------------------------------------------------------
// Pure helpers (GL-free; unit-tested directly)
// ---------------------------------------------------------------------------

/** The min-size clamp, per axis (the marker vertex shader mirrors this exact formula in
 *  GLSL). A marker's world size is its cell size, floored so it never renders below
 *  `minMarkerPx` CSS px on screen. `zoom` is world units per CSS px (I-09). At overview
 *  zoom a ~3 px cell clamps UP to a legible mark; when the cell is large the clamp is
 *  inert. Pure + exported for unit tests. */
export function clampMarkerWorldSize(cellSize: number, zoom: number, minMarkerPx: number): number {
  return Math.max(cellSize, minMarkerPx * Math.max(0, zoom));
}

/** A marker's resulting ON-SCREEN size (CSS px) after the clamp — provably never below
 *  `minMarkerPx` for any positive zoom (the legibility guarantee the shader enforces).
 *  Pure + exported for unit tests. */
export function markerScreenPx(cellSize: number, zoom: number, minMarkerPx: number): number {
  if (zoom <= 0) return 0;
  return clampMarkerWorldSize(cellSize, zoom, minMarkerPx) / zoom;
}

/** Target instances per chunk group (T2-127 — the frustum-culling lever). The markers are
 *  STATIC per selection, so the only per-frame cost is how many instances the GPU's vertex
 *  stage walks; ONE world-spanning mesh per kind means it walks ALL n every frame however
 *  little is on screen. Splitting into spatial bins, each a mesh with a TRUE bounding
 *  volume, lets THREE frustum-cull the off-screen bins — a zoomed-in view then pays for
 *  its bins only. Smaller bins cull tighter but cost a draw call each; ~8k/bin keeps the
 *  draw-call count to a few hundred at 1M while cutting zoomed-in vertex work by 1–2
 *  orders of magnitude. */
export const MARKER_CHUNK_TARGET = 8192;

/** Cap on the chunk grid per axis (12 ⇒ ≤144 bins ⇒ ≤288 meshes). Bounds the draw-call
 *  count at OVERVIEW zoom, where every bin is on screen and culling cannot help. */
export const MARKER_CHUNK_MAX_GRID = 12;

/** The chunk grid (g ⇒ g×g spatial bins) for a cell count. 1 = no chunking: at or below
 *  the target the whole set is one mesh per kind, because the extra draw calls would not
 *  pay for themselves. Pure + exported for unit tests. */
export function chooseChunkGrid(
  cellCount: number,
  target: number = MARKER_CHUNK_TARGET,
  maxGrid: number = MARKER_CHUNK_MAX_GRID,
): number {
  if (target <= 0 || cellCount <= target) return 1;
  return Math.max(1, Math.min(maxGrid, Math.ceil(Math.sqrt(cellCount / target))));
}

/** A world-space AABB over a group's member cell RECTS (centre ± half size). */
export interface MarkerBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** One drawn instanced group: the cells of ONE spatial bin under ONE treatment. Centres
 *  are (x,y) interleaved, sizes the cell (w,h) interleaved — both are zero-copy VIEWS into
 *  a single backing buffer per rebuild. `bounds` is the true world AABB of the member cell
 *  rects and becomes the mesh's bounding sphere, which is what makes the group cullable
 *  (see groupBoundingSphere for the min-clamp pad). */
export interface MarkerGroup {
  kind: "border" | "dim";
  centers: Float32Array;
  sizes: Float32Array;
  count: number;
  bounds: MarkerBounds;
}

/** Partition the position table into per-bin match / non-match instance groups.
 *
 *  Match = the selection's per-cell visibility array (1 = match, 0 = non-match — the SAME
 *  array the #168 count plumbing sums). A cell whose id is beyond the visibility array is
 *  a NON-match (a cell with no tag membership matches no specific selection).
 *
 *  NOTE the deliberate divergence from `cells.setVisibility`, whose boundary convention is
 *  the OPPOSITE ("out-of-range ⇒ keep visible", cells.ts §Boundary convention). There the
 *  array gates a DIM of the cell itself, so absent data must not hide a cell; here it
 *  selects a positive MARK, so absent data must not fabricate one. In practice both arrays
 *  are length `image_count` (evaluateTagSelection sizes by it) so the conventions never
 *  actually meet — this is defensive only, and deliberately defensive in opposite
 *  directions because the failure that matters differs.
 *
 *  Three O(n) passes (bin-count → prefix offsets → fill) into one exactly-sized backing
 *  buffer pair, then `subarray` views per group: no growth reallocation and no second copy
 *  of the ~16 B/cell payload. Pure + exported so the partition, the bin assignment and the
 *  per-group bounds are all tested without a GL context. */
export function buildMarkerGroups(
  positions: PositionTable,
  visibility: Uint8Array,
  grid: number,
): MarkerGroup[] {
  const n = positions.count;
  if (n === 0) return [];
  const g = Math.max(1, Math.floor(grid));
  const { x, y, w, h } = positions;
  const isMatch = (i: number): boolean => i < visibility.length && visibility[i] !== 0;

  // Bin extent from the cell CENTRES. A cell RECT may straddle a bin edge — that is fine:
  // the per-group bounds below accumulate the true rects, so a group's culling volume
  // covers its members exactly however they straddle.
  let cMinX = Infinity;
  let cMinY = Infinity;
  let cMaxX = -Infinity;
  let cMaxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < cMinX) cMinX = x[i];
    if (x[i] > cMaxX) cMaxX = x[i];
    if (y[i] < cMinY) cMinY = y[i];
    if (y[i] > cMaxY) cMaxY = y[i];
  }
  // A degenerate span (every cell on one line / one point) collapses that axis onto bin 0.
  const spanX = cMaxX - cMinX;
  const spanY = cMaxY - cMinY;
  const sx = spanX > 0 ? g / spanX : 0;
  const sy = spanY > 0 ? g / spanY : 0;
  // Slot = bin*2 + (match ? 0 : 1): borders on even slots, dim on odd.
  const slotOf = (i: number): number => {
    const gx = sx === 0 ? 0 : Math.min(g - 1, Math.max(0, Math.floor((x[i] - cMinX) * sx)));
    const gy = sy === 0 ? 0 : Math.min(g - 1, Math.max(0, Math.floor((y[i] - cMinY) * sy)));
    return (gy * g + gx) * 2 + (isMatch(i) ? 0 : 1);
  };

  const slots = g * g * 2;
  const counts = new Int32Array(slots);
  for (let i = 0; i < n; i++) counts[slotOf(i)]++;

  // Prefix offsets into ONE backing pair; `cursor` walks each slot's span during the fill.
  const start = new Int32Array(slots);
  let running = 0;
  for (let s = 0; s < slots; s++) {
    start[s] = running;
    running += counts[s];
  }
  const cursor = Int32Array.from(start);
  const allCenters = new Float32Array(n * 2);
  const allSizes = new Float32Array(n * 2);
  const bounds = new Float64Array(slots * 4); // [minX, minY, maxX, maxY] per slot
  for (let s = 0; s < slots; s++) {
    bounds[s * 4] = Infinity;
    bounds[s * 4 + 1] = Infinity;
    bounds[s * 4 + 2] = -Infinity;
    bounds[s * 4 + 3] = -Infinity;
  }
  for (let i = 0; i < n; i++) {
    const s = slotOf(i);
    const k = cursor[s]++;
    const xi = x[i];
    const yi = y[i];
    const hw = w[i] / 2;
    const hh = h[i] / 2;
    allCenters[2 * k] = xi;
    allCenters[2 * k + 1] = yi;
    allSizes[2 * k] = w[i];
    allSizes[2 * k + 1] = h[i];
    const b = s * 4;
    if (xi - hw < bounds[b]) bounds[b] = xi - hw;
    if (yi - hh < bounds[b + 1]) bounds[b + 1] = yi - hh;
    if (xi + hw > bounds[b + 2]) bounds[b + 2] = xi + hw;
    if (yi + hh > bounds[b + 3]) bounds[b + 3] = yi + hh;
  }

  const groups: MarkerGroup[] = [];
  for (let s = 0; s < slots; s++) {
    const count = counts[s];
    if (count === 0) continue;
    const from = start[s];
    groups.push({
      kind: s % 2 === 0 ? "border" : "dim",
      centers: allCenters.subarray(from * 2, (from + count) * 2),
      sizes: allSizes.subarray(from * 2, (from + count) * 2),
      count,
      bounds: {
        minX: bounds[s * 4],
        minY: bounds[s * 4 + 1],
        maxX: bounds[s * 4 + 2],
        maxY: bounds[s * 4 + 3],
      },
    });
  }
  return groups;
}

/** A group's frustum-culling sphere: the world AABB of its cell rects PADDED for the
 *  min-size clamp — a border marker grows to `minMarkerPx` CSS px (= `minMarkerPx·zoom`
 *  world units), so it can reach `minMarkerPx·zoom/2` past its cell rect on every side.
 *  Pass `minMarkerPx` 0 for dim groups, which never clamp. Zoom-dependent, so the spheres
 *  refresh on each camera event alongside `uZoom` — O(groups), NOT O(cells). Conservative
 *  by construction (a superset of the drawn pixels), so culling can never drop a mark that
 *  would have been visible. Pure + exported for unit tests. */
export function groupBoundingSphere(
  bounds: MarkerBounds,
  zoom: number,
  minMarkerPx: number,
): { x: number; y: number; radius: number } {
  const pad = (minMarkerPx * Math.max(0, zoom)) / 2;
  const halfW = (bounds.maxX - bounds.minX) / 2 + pad;
  const halfH = (bounds.maxY - bounds.minY) / 2 + pad;
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    radius: Math.hypot(halfW, halfH),
  };
}

/** A hex colour's RAW sRGB [0,1] components (NO colour-space conversion). The overlay's
 *  raw ShaderMaterials write gl_FragColor straight to the sRGB output framebuffer (as
 *  cells.ts's shader does after its explicit OETF), so a UI accent defined in sRGB
 *  (#F0B429) must be passed through un-converted to appear as that exact colour — unlike
 *  THREE.Color(hex), which would linearise it. */
function hexToSrgbVec(hex: number): THREE.Vector3 {
  return new THREE.Vector3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Shared vertex shader (both meshes). The marker is a unit quad (position −0.5..0.5)
// scaled to the per-axis marker size = max(cell size, minPx·zoom) and translated to the
// cell centre — the min-size clamp done ON THE GPU from a `uZoom` uniform (updated per
// camera event, O(1)) so the CPU never rebuilds geometry on pan/zoom. `uMinPx` is 0 for
// the dim mesh (exact cell footprint, no clamp) and the config min for the borders.
const MARKER_VERTEX_SHADER = /* glsl */ `
  precision highp float;
  attribute vec2 iCenter;
  attribute vec2 iCellSize;
  uniform float uZoom;   // world units per CSS px (I-09)
  uniform float uMinPx;  // min marker size (CSS px); 0 => no clamp (dim)
  varying vec2 vQuadUv;  // 0..1 across the marker
  varying vec2 vMarkerPx; // marker's on-screen size (CSS px), per axis
  void main() {
    vec2 markerSize = max(iCellSize, vec2(uMinPx * uZoom));
    vQuadUv = position.xy + 0.5;
    vMarkerPx = markerSize / max(uZoom, 1e-20);
    vec2 p = iCenter + position.xy * markerSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
  }
`;

// Border: draw a `uBorderPx`-thick gold FRAME (constant screen px), transparent
// interior. When the marker is min-clamped small enough that no interior remains
// (minMarkerPx <= 2·borderPx) every fragment is within the border ⇒ a solid gold dot —
// the desired degradation at overview zoom, for free. gl_FragColor is written in sRGB to
// match the framebuffer (see hexToSrgbVec). `discard` aliases like the rest of the
// scene (renderer antialias:false) — consistent with the cells/mosaic edges.
const BORDER_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uBorderPx;
  varying vec2 vQuadUv;
  varying vec2 vMarkerPx;
  void main() {
    vec2 dPx = min(vQuadUv, 1.0 - vQuadUv) * vMarkerPx; // px distance to the nearest v/h edge
    if (min(dPx.x, dPx.y) > uBorderPx) discard;         // interior of a large marker → transparent
    gl_FragColor = vec4(uColor, uAlpha);
  }
`;

// Dim: a flat translucent dark quad over each non-matching cell (straight-alpha darken
// of the tier beneath). No clamp (uMinPx = 0) so it covers exactly the cell footprint —
// non-matches tile into a uniform wash; matches (drawn above, un-dimmed + bordered) pop.
const DIM_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  uniform vec3 uColor;
  uniform float uAlpha;
  void main() {
    gl_FragColor = vec4(uColor, uAlpha);
  }
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the LayoutController pushes on activate / switch / positions-bind: the active
 *  layout's position table (per-cell world rects). null clears the marks (a layout
 *  switch nulls it before the new table binds, so no stale-layout marks — #167). */
export interface HighlightContext {
  positions: PositionTable | null;
}

export interface HighlightOverlay {
  /** The single runtime-mutable config (T2-101 scaffolding). */
  readonly config: HighlightOverlayConfig;
  /** Push the active layout's position table (null on switch-clear / images-only / no
   *  table). Rebuilds the markers against the RETAINED selection (positions differ per
   *  layout; the selection is layout-invariant). */
  setContext(ctx: HighlightContext | null): void;
  /** Push the tag selection's per-cell match array (1 = match, 0 = non-match), or null
   *  to CLEAR (empty selection / images-only / tags unavailable). Rebuilds against the
   *  RETAINED positions. */
  setSelection(visibility: Uint8Array | null): void;
  dispose(): void;
  /** Matching cells with a gold border marker drawn. */
  matchCount(): number;
  /** Non-matching cells with a dim quad drawn. */
  dimCount(): number;
  /** Whether the overlay is currently drawing (a selection AND a positions table). */
  isActive(): boolean;
}

// ---------------------------------------------------------------------------
// Factory (GL; exercised via the GL-free stub world in node tests)
// ---------------------------------------------------------------------------

export function createHighlightOverlay(
  world: World,
  config: HighlightOverlayConfig = { ...DEFAULT_HIGHLIGHT_OVERLAY_CONFIG },
): HighlightOverlay {
  const worldH = world as Partial<WorldHandle> & World;

  // Retained context: positions (layout-specific) + the selection's visibility
  // (layout-invariant). Either changing rebuilds the meshes; both must be present (and the
  // selection non-empty) for the overlay to draw.
  let positions: PositionTable | null = null;
  let visibility: Uint8Array | null = null;

  /** One drawn mesh per (spatial bin × kind) — see MARKER_CHUNK_TARGET. Empty while the
   *  overlay is inactive. `bounds` is retained per mesh so the culling sphere can be
   *  re-padded for the min-size clamp on each camera event without touching geometry. */
  interface MarkerMesh {
    mesh: THREE.Mesh;
    kind: "border" | "dim";
    bounds: MarkerBounds;
  }
  let meshes: MarkerMesh[] = [];

  let lastZoom = 1; // world units per CSS px; the real world emits immediately on subscribe
  let disposed = false;

  // ONE material per kind, SHARED by every chunk mesh of that kind: chunking multiplies
  // meshes, NOT GL state. So a camera event writes 2 uniforms (not one per chunk), adjacent
  // chunk draws need no material switch, and a rebuild re-uses the already-compiled
  // programs instead of constructing ShaderMaterials on every selection change.
  //
  // NOTE (T2-101 scaffolding): the uniforms below SNAPSHOT `config` at construction. The
  // exposed `config` object stays mutable for a future settings panel, but a mutation only
  // takes effect on the next rebuild() — a panel must therefore re-push the selection (or
  // gain an explicit reconfigure) rather than expect a live uniform write. Same contract as
  // DetailOverlayConfig.
  function makeMaterial(kind: "border" | "dim"): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      vertexShader: MARKER_VERTEX_SHADER,
      fragmentShader: kind === "border" ? BORDER_FRAGMENT_SHADER : DIM_FRAGMENT_SHADER,
      uniforms:
        kind === "border"
          ? {
              uZoom: { value: lastZoom },
              uMinPx: { value: config.minMarkerPx },
              uColor: { value: hexToSrgbVec(config.accent) },
              uAlpha: { value: config.borderAlpha },
              uBorderPx: { value: config.borderPx },
            }
          : {
              uZoom: { value: lastZoom },
              uMinPx: { value: 0 }, // dim: exact cell footprint, no min-size clamp
              uColor: { value: hexToSrgbVec(config.dimColor) },
              uAlpha: { value: config.dimAlpha },
            },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide, // the y-flipped camera reverses winding (cf. cells.ts / drawOverview)
      blending: THREE.NormalBlending,
      premultipliedAlpha: false, // straight alpha (uColor is un-premultiplied)
    });
    return material;
  }

  const borderMaterial = makeMaterial("border");
  const dimMaterial = makeMaterial("dim");

  /** Build one instanced marker mesh for a chunk group. Each mesh gets its OWN tiny base
   *  quad (4 verts + index) rather than a shared one — so disposing a mesh's geometry frees
   *  only its own attributes (avoiding the shared-base free hazard cells.ts's reclaimBucket
   *  has to detach around); the per-instance centre/size attributes are zero-copy views
   *  into the rebuild's single backing buffer.
   *
   *  The mesh is FRUSTUM-CULLED (T2-127) against an explicitly-set bounding sphere. THREE
   *  would otherwise compute bounds from the unit base quad — which describes none of the
   *  instances — which is why a single world-spanning mesh had to opt OUT of culling and
   *  pay all n instances every frame. A per-chunk true bound turns that into "pay for the
   *  chunks actually on screen". */
  function buildMesh(group: MarkerGroup): MarkerMesh {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
    );
    geometry.setAttribute("iCenter", new THREE.InstancedBufferAttribute(group.centers, 2));
    geometry.setAttribute("iCellSize", new THREE.InstancedBufferAttribute(group.sizes, 2));
    geometry.instanceCount = group.count;
    // Set explicitly so THREE never falls back to computeBoundingSphere() (which measures
    // the base quad, not the instances). applyZoom() re-pads it on each camera event.
    geometry.boundingSphere = new THREE.Sphere();
    const mesh = new THREE.Mesh(geometry, group.kind === "border" ? borderMaterial : dimMaterial);
    mesh.frustumCulled = true; // the point of chunking — see the doc comment above
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = group.kind === "border" ? RENDER_ORDER_HIGHLIGHT_BORDER : RENDER_ORDER_HIGHLIGHT_DIM;
    world.scene.add(mesh);
    return { mesh, kind: group.kind, bounds: group.bounds };
  }

  /** Remove + free every drawn mesh. The two materials are SHARED across rebuilds and
   *  outlive them — only dispose() frees those. */
  function clearMeshes(): void {
    for (const m of meshes) {
      world.scene.remove(m.mesh);
      m.mesh.geometry.dispose();
    }
    meshes = [];
  }

  /** Total instances drawn for one kind, summed across that kind's chunk meshes. */
  function countOfKind(kind: "border" | "dim"): number {
    let n = 0;
    for (const m of meshes) {
      if (m.kind === kind) n += (m.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
    }
    return n;
  }

  /** Rebuild the marks from the current (positions, visibility). Inactive — no positions,
   *  no selection, or an empty table — clears. Full rebuild (not incremental): a selection
   *  / layout change is user-driven and infrequent, and costs one O(n) partition plus the
   *  ~16 B/cell buffers.
   *
   *  Per FRAME the CPU work is zero (static instanced buffers; two uniform writes per
   *  CAMERA event). The GPU still walks the instances of every chunk the frustum keeps —
   *  which is exactly why the marks are chunked (T2-127): a zoomed-in view culls down to
   *  its own bins instead of paying all n. The residual un-culled cost is OVERVIEW zoom,
   *  where every bin is legitimately on screen (tracked in the T2-127 ledger row). */
  function rebuild(): void {
    if (disposed) return;
    clearMeshes();
    if (positions === null || visibility === null || positions.count === 0) return;
    const groups = buildMarkerGroups(positions, visibility, chooseChunkGrid(positions.count));
    for (const group of groups) meshes.push(buildMesh(group));
    applyZoom();
  }

  /** Push the live zoom to the GPU: the two shared uZoom uniforms (driving the on-GPU
   *  min-size clamp, sampled every frame) and each chunk's culling sphere, whose pad grows
   *  with that clamp. O(chunks) per camera event — never O(cells), and no geometry rebuild. */
  function applyZoom(): void {
    borderMaterial.uniforms.uZoom.value = lastZoom;
    dimMaterial.uniforms.uZoom.value = lastZoom;
    for (const m of meshes) {
      const sphere = m.mesh.geometry.boundingSphere;
      if (sphere === null) continue;
      const s = groupBoundingSphere(m.bounds, lastZoom, m.kind === "border" ? config.minMarkerPx : 0);
      sphere.center.set(s.x, s.y, 0);
      sphere.radius = s.radius;
    }
  }

  const unsubscribe = world.onCameraChange((state: CameraState, _viewport: Viewport) => {
    lastZoom = state.zoom;
    applyZoom();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    clearMeshes();
    // The shared per-kind materials outlive rebuilds, so they are freed HERE (not in
    // clearMeshes) — once, at teardown.
    borderMaterial.dispose();
    dimMaterial.dispose();
    positions = null;
    visibility = null;
  }

  // Self-manage teardown on the World's dispose (symmetric with detailOverlay.ts):
  // ViewerScreen calls world.dispose() on the per-dataset unmount (D-31), which fires
  // this — so layout.ts needs no explicit dispose call.
  worldH.onDispose?.(dispose);

  return {
    config,
    setContext(ctx: HighlightContext | null): void {
      if (disposed) return;
      positions = ctx?.positions ?? null;
      rebuild();
    },
    setSelection(vis: Uint8Array | null): void {
      if (disposed) return;
      visibility = vis;
      rebuild();
    },
    dispose,
    matchCount(): number {
      return countOfKind("border");
    },
    dimCount(): number {
      return countOfKind("dim");
    },
    isActive(): boolean {
      return meshes.length > 0;
    },
  };
}
