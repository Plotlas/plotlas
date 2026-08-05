import type { Table } from "apache-arrow";
import type { ColumnRoles } from "../generated/column_roles";
import type { ApiClient } from "../api-client/client";
import type { Cells, CellsHandle, PositionTable } from "./cells.ts";
import { parsePositionsTable, hitTestPositionTable, countPositionsInView } from "./cells.ts";
import type { BBox, TilePyramid } from "./tilePyramid";
import type { WorldHandle } from "./world.ts";
import { cameraForCell } from "./world.ts";
import { createDetailOverlay } from "./detailOverlay.ts";
import type { DetailOverlay } from "./detailOverlay.ts";
import { createHighlightOverlay } from "./highlightOverlay.ts";
import type { HighlightOverlay } from "./highlightOverlay.ts";
import { createOverlayLayer } from "./overlayLayer.ts";
import type { OverlayLayer } from "./overlayLayer.ts";

// Hand-written mirror of schemas/v2/layout_manifest.schema.json — intentionally
// NOT generated (unlike column_roles). The manifest is data the frontend receives
// over the network and must validate: the renderer range-checks `manifest_version`
// and rejects majors it doesn't understand, which is why that field is `string`
// here even though the schema pins it to "2.x" (a generated literal type would
// make the check un-writeable). The real schema enforcement is runtime validation
// in getManifest against layout_manifest.schema.json (issue #4), not this
// compile-time type. v2 (decision D-33): the v1 shared `atlas` block + per-LOD
// quadtree index are GONE — each layout carries its own self-describing spatial
// tile PYRAMID (one PMTiles container, variable level count) + an optional detail
// tier. `ColumnRoles` is imported from src/generated/ (the schema-generated source
// of truth, D-16) rather than re-declared here, so the two never drift.
export interface LayoutManifest {
  manifest_version: string;
  dataset_id: string;
  dataset_version: number;
  layouts: LayoutEntry[];
  column_roles?: ColumnRoles; // optional (decision D-25); absent ⇒ images-only dataset
  tags?: TagsDecl | null; // per-dataset tag sidecar (decision D-14); absent ⇒ no tag columns
  dataset_metadata: DatasetMetadata;
}

export interface TagsDecl {
  path: string; // e.g. "tags/tags_v3.arrow" (version-stamped)
  format: "arrow"; // Arrow IPC/Feather only (apache-arrow JS cannot read Parquet)
}

export interface LayoutEntry {
  layout_id: string;
  label: string;
  // The renderer never branches on layout type — every layout renders identically
  // from its pyramid + bbox; `type` is UI-display + underlay-dispatch data only.
  // "geographic" (D-35 Seam G2) = real-world lon/lat projected to a map; it flows
  // through the same generic pyramid+bbox render path as every other type.
  type: "grid" | "datetime" | "categorical" | "scatter" | "geographic" | "umap" | "network" | "custom";
  bbox: [number, number, number, number];
  // v2.5 (T2-72 Seam 2): the FULL-PRECISION (unrounded) copy of `bbox`. `bbox` is 6-dp-rounded,
  // but the aggregate count chips re-derive pile occupancy by replicating the tiler's binning,
  // which used the unrounded bbox — so binning over `bbox` drifts on boundary tiles (PR #179).
  // Present on a 2.5 bake ⇒ the chips bin EXACTLY (and drop the ~ approximation); absent on a
  // pre-2.5 bake ⇒ the chips fall back to `bbox` and keep the honest approximation.
  bbox_exact?: [number, number, number, number];
  // v2 (D-33): this layout's self-describing spatial tile pyramid (one PMTiles
  // container, addressed {z}/{x}/{y}). REPLACES v1's tile_root + the shared atlas.
  pyramid: PyramidDescriptor;
  // v2.2 (T2-66/T2-48): the dataset-relative path of this layout's POSITION TABLE —
  // an uncompressed Arrow file of per-cell (x,y,w,h) rects, row index == dense cell id
  // (no id column). The renderer scans it to hit-test a cell at ANY zoom (the coarse
  // tier draws mosaic quads with no per-cell geometry to pick). Null/absent ⇒ the
  // layout baked no table (a pre-2.2 dataset) — the renderer keeps fine-tier-only
  // picking with no error.
  positions_ref?: string | null;
  // Optional deepest DETAIL tier (backlog T2-26): individual full-res originals
  // for click-through, resolved by dense cell id. Null/absent ⇒ no detail tier.
  detail?: DetailDescriptor | null;
  edges?: EdgesDecl | null; // per-layout edge list (decision D-20); null/absent for non-network layouts
  // v2.3 (D-35 Seam G1): echo of the layout-shaping options APPLIED at bake time —
  // present ONLY when a non-default knob was declared (a default bake omits it). The
  // renderer does not branch on it; it is surfaced to the UI so an existing bake is
  // explainable (D-35 Seam G3 / T2-125). Absent ⇒ all defaults.
  options?: LayoutOptions;
  // v2.5 (T2-69/T2-72 Seam 2): overlay annotations the DOM substrate renders — a
  // categorical layout's per-band `labels`, or a datetime layout's `axes` domain.
  // Absent ⇒ a layout with none (grid/scatter/geographic, a degenerate datetime span,
  // or a dataset baked pre-2.5) — the overlay renders no labels and derives the axis
  // domain from the Seam-1 getMetadata shim instead (graceful degradation).
  annotations?: LayoutAnnotations;
  // v2.6 (T2-140 / D-36 seam U1): how many of this layout's cells it could NOT place from
  // the column it arranges by — datetime's undated or unparseable dates, scatter/geographic's
  // null-or-non-finite coordinates, categorical's structurally-missing band. Every family
  // reports it and every FRESH 2.6 entry carries it, INCLUDING 0, so:
  //   0         => this producer counted and found none.
  //   undefined => a PRE-2.6 entry (add-layouts carries them forward byte-preserved under a
  //                re-stamped version). Nothing was counted — never render this as "0".
  // The cells are still drawn, but this number says HOW MANY, not WHERE: usually the
  // unplaced strip (y in [0.96, 1]), but scatter's `normalize: "none"` pass-through puts them
  // in a data-adjacent block anywhere in the canvas, categorical gives them a labelled band
  // inside the treemap, and datetime's legacy fallback grid parks them mid-canvas. To point
  // at them, read `type`/`annotations` as well. On the layout entry, not on an annotation: a
  // datetime layout that declines its axis may still have stripped its undated cells, and
  // scatter/geographic carry no annotations at all. NOT `LabelAnnotation.missing`, which is a
  // boolean band flag.
  missing_count?: number;
}

// v2.5 (T2-69/T2-72 Seam 2): the per-layout overlay annotations. Each family emits only
// its own key — a categorical layout emits `labels`, a datetime layout emits `axes`.
export interface LayoutAnnotations {
  labels?: LabelAnnotation[];
  axes?: AxisAnnotation[];
}

// One categorical band label. The producer emits the DATA (text + world extent + member
// count); the overlay derives the display rank (area/count) and greedy-culls collisions
// per camera (the lean priority contract), and places the label in the empty gap beside
// the band — never over the images.
export interface LabelAnnotation {
  text: string; // the band's category value (may be "" for the structurally-missing bucket)
  extent: [number, number, number, number]; // world bbox [x_min,y_min,x_max,y_max] of the band region
  count: number; // member count — the default declutter rank + the counts-toggle source
  missing?: boolean; // true ONLY for the structurally-missing bucket (rendered muted "no label")
  priority?: number; // optional explicit rank override (reserved; the renderer ranks by count otherwise)
}

// One layout axis (currently only the datetime x-axis): a time domain mapped onto a world
// range, from which the overlay draws nice-tick marks across the visible sub-range.
export interface AxisAnnotation {
  // TOLERANT-READER typing (PR-180 review): the schema's producer-side enums are
  // "x"|"y" and "time", but the client validator deliberately accepts any non-empty
  // string here so a FUTURE minor's new scale (e.g. "linear", D-35 scatter/geo axes)
  // degrades to "axis not drawn" instead of failing the dataset open. Consumers filter
  // for the pairs they understand (producerTimeAxis: scale==="time" && orientation==="x").
  orientation: string; // producer emits "x" | "y"
  scale: string; // producer emits "time" (the only scale this minor)
  domain: [string, string]; // [start, end] ISO-8601 UTC datetime strings
  range: [number, number]; // the world-x sub-interval [lo, hi] the domain maps onto linearly
  // v2.7 (T2-142 / D-36 seam H3): the calendar bucketing rung the producer binned at.
  // ABSENT ⇒ a PRE-2.7 bake — fall back to the years-only tick ladder; never treat a
  // missing rung as a default. Present on every fresh datetime axis (there is no default
  // and it is never omitted-when-default), so presence is the only gate.
  interval?: AxisInterval;
  label: string;
}

// One rung of the producer's `_INTERVAL_LADDER` (v2.7). Together `kind`+`step` say how the
// bake bucketed time — `{kind:"month", step:3}` is quarters — so the overlay can tick the
// producer's OWN bin boundaries instead of a second ladder kept in sync by discipline (which
// is what failed: 25 producer rungs across six kinds against a years-only NICE_YEAR_STEPS).
// A bin boundary is `domain[0]` advanced by whole `step`-`kind` calendar steps; do NOT turn
// the rung into a fixed second count and step linearly — months and years vary in length
// while `range` is linear in seconds, and the two disagree by up to ~3 % on a month rung.
// CAVEAT: on a multi-year rung whose earliest bucket is in years 1..step-1 CE, the producer's
// `_floor_interval` clamps that first start to year 1 — OFF the step grid — so the first stride
// is short and a uniform walk from `domain[0]` drifts after it. Floor each boundary to the rung
// (boundaries past the first are on the natural grid) rather than striding from `domain[0]`.
// It does not dictate the tick rung: a COARSER tick rung falls inside a bin, which is fine
// (D-36 §7.4); this is the finest rung guaranteed to land on boundaries.
export interface AxisInterval {
  // TOLERANT-READER typing, like `AxisAnnotation.scale`: the schema's producer-side enum is
  // "second"|"minute"|"hour"|"day"|"month"|"year", but an unknown kind from a later minor is
  // preserved (validated only as a non-empty string), never a dataset-open failure. Unlike an
  // unknown `scale` — which makes the axis uninterpretable, so the consumer drops it — an
  // unknown kind only costs the bin-boundary tick refinement: the axis is still fully drawable
  // from `domain`/`range`, so degrade EXACTLY as for an ABSENT interval (fall back to the
  // years-only ladder, axis still drawn), NOT by skipping the axis.
  kind: string;
  step: number; // integer >= 1; a step of 1 is emitted explicitly, never implied
}

// v2.3/v2.4 (D-35 Seam G1/G2): the baked layout-shaping options. A SUPERSET shared
// across layout families: a scatter layout echoes the four scatter knobs it applied; a
// geographic layout (D-35 Seam G2) echoes `projection` (+ `overlap`). All keys optional.
// `projection` doubles as the geographic family's fit_transform.kind for the T2-86 underlay.
export interface LayoutOptions {
  x_scale?: "linear" | "log";
  y_scale?: "linear" | "log";
  normalize?: "fit" | "none";
  projection?: "equirectangular" | "mercator";
  overlap?: "overdraw" | "jitter" | "aggregate";
}

// v2 (D-33): the self-describing spatial tile pyramid for one layout. The level
// count is VARIABLE per dataset (replaces v1's fixed 3-LOD ceiling); the renderer
// reads `levels`, `tile_px`, `thumb_px`, `cap`, and `z_cap` and adapts.
export interface PyramidDescriptor {
  container: "pmtiles";
  path: string; // version-embedded, e.g. "tiles/grid/grid_v3.pmtiles"
  tile_px: 256 | 512 | 1024 | 2048;
  thumb_px: number; // mid-tier per-cell thumbnail edge (<= tile_px)
  cap: number; // max cells packed into one fine tile = floor(tile_px/thumb_px)^2
  levels: PyramidLevel[]; // coarsest first; z contiguous & increasing
  z_cap: number; // single source of truth: coarse iff z < z_cap, fine iff z >= z_cap
  // v2.5 (PR-180 review): the bake's TOTAL subsampled-out cell count across all fine
  // tiles. 0 ⇔ no over-cap tile exists — the overlay substrate then SKIPS its O(n)
  // pile re-derivation entirely. Absent on a pre-2.5 bake ⇒ derive (chunked) as before.
  dropped_total?: number;
}

export interface PyramidLevel {
  z: number; // web-map XYZ zoom; 2^z tiles per axis within the layout bbox
  tile_count: number; // tiles actually written at this level (sparse)
}

// v2 (D-33): how the renderer resolves a cell's full-resolution image for the
// deepest detail tier. Phase 1 implements mode "image_ref".
export interface DetailDescriptor {
  mode: "image_ref" | "pmtiles";
  path_prefix?: string; // mode "image_ref": cell originals live under this prefix
  path?: string; // mode "pmtiles": deep-zoom container path
  format?: "webp" | "jpeg" | "png"; // mode "image_ref": original encoding
}

export interface EdgesDecl {
  path: string;
  format: "arrow"; // Arrow IPC/Feather only (apache-arrow JS cannot read Parquet)
}

export interface DatasetMetadata {
  image_count: number;
  ingest_timestamp: string;
  source?: string; // optional metadata-source provenance (decision D-25); absent for images-only
}

export interface TagSelection {
  // Multi-tag highlight model (see gap analysis #4): the set of selected
  // (column, value) pairs and the combine mode the shader applies.
  selected: { column: string; value: string }[];
  mode: "and" | "or";
}

/** T2-120 (Fix B/C): the renderer-side tag state the UI reads after apply / load.
 *  `status` drives the TagControls affordance and the status bar's honest count:
 *   - `ok`          — the sidecar is resident; `matched`/`total` are real.
 *   - `unavailable` — the renderer-side sidecar load FAILED (retryable — the UI shows
 *                     a "Tag filtering unavailable — retry" affordance, not a lying 0).
 *   - `none`        — the dataset declares no tags (images-only, D-25); filtering is
 *                     legitimately unavailable and there is nothing to retry.
 *  `matched` is the visibility array's sum for the current selection (== `total` when
 *  the selection is empty or tags are absent); `total` is the dense cell count (the
 *  "of M" denominator). Exposed via applyTags' return AND setTagStateListener (async
 *  loads/retries push through the listener). Renderer-owned; no renderer→UI import. */
export interface TagRenderState {
  status: "ok" | "unavailable" | "none";
  matched: number;
  total: number;
}

export interface LayoutController {
  /** Fetch a layout's manifest and load its initial tiles. */
  activate(layoutId: string): Promise<void>;
  /** Switch layouts INSTANTLY, camera preserved: the loader keeps the old
   *  layout's coarse overview as a backdrop, streams the target layout's tiles
   *  coarse-first for the live view, and cells appear at their new positions as
   *  their tiles bind (no position tween — the D-10 animation was dropped; a
   *  switch costs one viewport stream, not a full fine-tier download). Rapid
   *  calls converge on the LAST target; a superseded call resolves quietly. */
  switchTo(layoutId: string): Promise<void>;
  /** Evaluate the selection against the resident id->tags table (loaded once
   *  from the tag sidecar) and upload the per-cell visibility buffer. O(n) per
   *  selection change, O(1) per frame (decisions D-08, D-14). Returns the resulting
   *  TagRenderState — the honest match count (visibility sum) + the renderer-side tag
   *  availability. T2-120 (Fix B): when the sidecar previously FAILED to load, this
   *  re-attempts the fetch in the background (retryable — the load is no longer latched
   *  dead) and reports `unavailable` meanwhile; the eventual outcome arrives via
   *  setTagStateListener. */
  applyTags(selection: TagSelection): TagRenderState;

  /** T2-120 (Fix B): subscribe to ASYNC tag-state changes the UI must reflect — the
   *  sidecar finishing (or failing) its load on activate, and a retry resolving (a
   *  success re-applies the remembered selection; a failure surfaces `unavailable`).
   *  Invoked with the current TagRenderState. ONE listener (a later call replaces it);
   *  the UI forwards it to TagControls (the retry affordance) + the status bar (the
   *  honest count). Renderer→UI stays decoupled: the UI reads state, never imported. */
  setTagStateListener(listener: (state: TagRenderState) => void): void;

  // ── cockpit hooks (T2-54 / T2-67 / T2-71), all reading the ACTIVE layout's
  //    position table (the v2.2 positions_ref the controller already loads). Each
  //    degrades gracefully to null / no-op when the table is absent. ──

  /** The world rect (centre + size) of cell `id` from the active layout's position
   *  table, or null when there is no table (pre-2.2 / images-only) or `id` is out of
   *  range. The minimap / centerOnCell read it; a null result is the graceful-absence
   *  signal (Locate then degrades to close+select). */
  cellRect(id: number): CellRect | null;

  /** How many cells' rects overlap the world `view` rect — the status bar's
   *  "in view" figure and the D-B auto-fit trigger. O(N) scan over the position
   *  table (the caller throttles it, see viewerStatus.ts); null when the active
   *  layout baked no table. */
  countCellsInView(view: BBox): number | null;

  /** Center the camera on cell `id` and zoom so the cell spans ~`fraction` of the
   *  viewport (default 1/3) — the catalogued renderer move behind the lightbox's
   *  "Locate on canvas" (T2-71) and any programmatic focus. Returns true when it
   *  drove the camera, false on graceful absence (no world handle wired, or no rect
   *  for `id`) so the caller can fall back. The camera is set INSTANTLY (world.ts has
   *  no tween — a layout switch is likewise an instant swap); the loader's own camera
   *  subscription then streams the newly-visible tiles. */
  centerOnCell(id: number, fraction?: number): boolean;

  /** Briefly HIGHLIGHT a single cell (T2-71 Locate cue): emphasize `id` and
   *  de-emphasize the rest for `ms` (default 1200), then restore the current tag
   *  selection's visibility. Reuses the existing tag-highlight visibility path
   *  (cells.setVisibility) — NOT a new shader — with a single-cell visible set and a
   *  timed restore. A no-op when nothing is active. */
  pulseHighlight(id: number, ms?: number): void;
}

/** A cell's world rect (centre + size), the position table's per-cell record shape,
 *  used by the minimap / centerOnCell (T2-54). */
export interface CellRect {
  x: number; // centre x
  y: number; // centre y
  w: number; // width
  h: number; // height
}

// ---------------------------------------------------------------------------
// Pure helpers (GL-free; unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * The renderer's only manifest-version duty (issue #4's full runtime schema
 * validation lives in ApiClient.getManifest): reject any manifest whose
 * `manifest_version` major is not 2 (v2 is a CLEAN BREAK — decision D-33; v1.x
 * manifests are not accepted, datasets are re-ingested). "2.0"/"2.1" pass;
 * "1.0"/"1.1" fail.
 */
export function checkManifestVersion(manifest: LayoutManifest): void {
  const version = manifest.manifest_version;
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major) || String(major) !== version.split(".")[0]) {
    throw new Error(
      `unparseable layout manifest_version '${version}' — expected '<major>.<minor>' with major 2`,
    );
  }
  if (major !== 2) {
    throw new Error(
      `unsupported layout manifest_version '${version}': this renderer implements major version 2`,
    );
  }
}

/**
 * Resident tag membership, parsed once per dataset from the D-14 sidecar.
 *
 * COLUMNAR over dense cell ids (T2-43). Cell ids are pinned contiguous-dense by
 * the v2 schema (0..cellCount-1), so instead of one JS `Set` per cell per column
 * (`Map<column, Map<id, Set<string>>>` — millions of heap objects at the 1M
 * target) each `(column, value)` pair owns ONE bitset: a `Uint8Array` with one
 * BIT per cell (`bitsets[column].get(value)[id >> 3] & (1 << (id & 7))`). Memory
 * is O(values × cells/8) packed bytes rather than O(cells) heap `Set`s, and a
 * highlight pass is a bitwise scan over a handful of typed arrays.
 *
 * Multi-valued cells (a cell listed under several values of one column) and
 * empty cells fall out naturally — a cell's bit is set in every value-bitset it
 * belongs to and in none it does not; unions are the bitwise OR of those arrays.
 *
 * Consumers go through the thin accessor API (`hasTag`, `countFor`, `bitsetFor`)
 * and never index the raw `Uint8Array`s, so the packing is an implementation
 * detail. This is the renderer-side (highlight) representation ONLY; the UI's
 * chip/value lists still read the raw Arrow `Table` directly (TagControls /
 * MetadataPanel), which is not the per-cell-Set hot spot this replaces.
 */
export interface ColumnarTags {
  /** Dense cell-id space these bitsets are sized for (0..cellCount-1). Empty
   *  cells and ids beyond the sidecar's rows simply have no bits set. */
  readonly cellCount: number;
  /** column -> value -> membership bitset (1 bit per cell id, packed LSB-first
   *  into a `Uint8Array` of ceil(cellCount/8) bytes). */
  readonly bitsets: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
}

/** True iff cell `id` carries `value` under `column`. Out-of-range ids and
 *  unknown column/value pairs are simply absent (false) — the same result the
 *  old per-cell `Set.has` gave. */
export function hasTag(tags: ColumnarTags, id: number, column: string, value: string): boolean {
  if (id < 0 || id >= tags.cellCount) return false;
  const bitset = tags.bitsets.get(column)?.get(value);
  if (bitset === undefined) return false;
  return (bitset[id >> 3] & (1 << (id & 7))) !== 0;
}

/** How many cells carry `value` under `column` (0 for an unknown pair). Counts
 *  set bits in the value's bitset — the columnar analogue of TagControls'
 *  chip counts, exposed so a consumer need not re-scan. */
export function countFor(tags: ColumnarTags, column: string, value: string): number {
  const bitset = tags.bitsets.get(column)?.get(value);
  if (bitset === undefined) return 0;
  let n = 0;
  for (let byte = 0; byte < bitset.length; byte++) {
    let b = bitset[byte];
    while (b !== 0) {
      b &= b - 1; // clear the lowest set bit (Kernighan population count)
      n++;
    }
  }
  return n;
}

/** The raw membership bitset for one `(column, value)` pair, or `undefined` if
 *  that pair never appears. Exposed so the highlight pass can OR/AND bitsets
 *  wholesale instead of calling `hasTag` per cell. Do not mutate it. */
export function bitsetFor(tags: ColumnarTags, column: string, value: string): Uint8Array | undefined {
  return tags.bitsets.get(column)?.get(value);
}

/**
 * Parse the tag sidecar table (`id` int64 + one list<string> column per
 * tag-role column) into the columnar `ColumnarTags` representation (T2-43): one
 * packed membership bitset per `(column, value)` pair over the dense id space.
 * One pass over the table; `cellCount` sizes every bitset (dense ids per the v2
 * schema). A row whose `id` falls outside `[0, cellCount)` is skipped defensively
 * (the sidecar is dense by construction, but it is untrusted network data).
 */
export function parseTagsTable(table: Table, tagColumns: string[], cellCount: number): ColumnarTags {
  const idCol = table.getChild("id");
  if (idCol === null) throw new Error("tag sidecar is missing the 'id' column");
  const byteLen = (cellCount + 7) >> 3;
  const bitsets = new Map<string, Map<string, Uint8Array>>();
  for (const column of tagColumns) {
    const vec = table.getChild(column);
    if (vec === null) continue; // declared but absent: treat as no values
    const values = new Map<string, Uint8Array>();
    for (let i = 0; i < table.numRows; i++) {
      const id = Number(idCol.get(i));
      if (id < 0 || id >= cellCount) continue; // out of the dense id space: skip
      const cell = vec.get(i) as Iterable<unknown> | null;
      if (cell === null || cell === undefined) continue; // empty cell: no bits
      const byteIdx = id >> 3;
      const mask = 1 << (id & 7);
      for (const v of cell) {
        if (v === null || v === undefined) continue;
        const value = String(v);
        let bitset = values.get(value);
        if (bitset === undefined) {
          bitset = new Uint8Array(byteLen);
          values.set(value, bitset);
        }
        bitset[byteIdx] |= mask; // idempotent: a duplicate (id,value) sets the same bit
      }
    }
    bitsets.set(column, values);
  }
  return { cellCount, bitsets };
}

/**
 * D-08 evaluation: selection -> one byte per cell id (dense 0..cellCount-1).
 * O(n) per selection change, O(1) per frame. Empty selection => all visible.
 * 0 means de-emphasized (the shader dims/desaturates) — never removed.
 *
 * Bitwise over the columnar bitsets (T2-43): identical semantics to the old
 * per-cell `Set` scan — `or` unions the selected value-bitsets, `and`
 * intersects them, an unknown `(column, value)` contributes an all-zero bitset
 * (matches nothing, exactly as `Set.has` returned false). `cellCount` here is
 * the caller's authoritative dense count (the manifest's image_count), which the
 * bitsets were sized for; the loop never reads past a bitset's end.
 */
export function evaluateTagSelection(
  tags: ColumnarTags,
  selection: TagSelection,
  cellCount: number,
): Uint8Array {
  const out = new Uint8Array(cellCount);
  if (selection.selected.length === 0) {
    out.fill(1);
    return out;
  }
  const and = selection.mode === "and";
  // Gather the selected pairs' bitsets once (undefined ⇒ the pair never appears ⇒
  // an implicit all-zero bitset — matches nothing).
  const selected = selection.selected.map((pair) => bitsetFor(tags, pair.column, pair.value));
  for (let id = 0; id < cellCount; id++) {
    const byteIdx = id >> 3;
    const mask = 1 << (id & 7);
    let visible = and;
    for (const bitset of selected) {
      const has = bitset !== undefined && (bitset[byteIdx] & mask) !== 0;
      if (and) {
        if (!has) {
          visible = false;
          break;
        }
      } else if (has) {
        visible = true;
        break;
      }
    }
    out[id] = visible ? 1 : 0;
  }
  return out;
}

function bboxOfEntry(entry: LayoutEntry): BBox {
  return { xMin: entry.bbox[0], yMin: entry.bbox[1], xMax: entry.bbox[2], yMax: entry.bbox[3] };
}

/**
 * The D-B auto-fit rule (T2-67, operator-decided 2026-07-05): after a layout switch,
 * auto-fit to the new layout's bbox ONLY when the camera would be staring at empty
 * space — i.e. the in-view cell count is exactly ZERO. A nonzero count HOLDS the
 * camera so a region can be compared across layouts. `inView` is the
 * `countCellsInView` read for the CURRENT camera against the NEW layout's table; null
 * (no position table yet / images-only) means "can't tell" ⇒ HOLD (the manual fit
 * button is always available). Pure + exported for unit tests. */
export function shouldAutoFit(inView: number | null): boolean {
  return inView === 0;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

// A layout switch is an INSTANT swap (no D-10 position tween, no staging fetch):
// switchTo bumps the loader's stale-drop generation (beginLayoutSwitch) and asks
// activateLayout to stream the TARGET layout's tiles for the live view. The
// loader keeps the OLD layout's coarse overview drawn as a backdrop until the new
// coarse floor binds (its `condemned` set), so nothing blanks; positions/sizes
// arrive per-tile through cells.setBuffers, which renders each cell at its new
// position immediately. The full-extent `frame` passed below is consumed by
// activateLayout ONLY in its no-camera fallback (the GL-free unit tests); once a
// camera has emitted — always, in production — the pyramid derives the streamed
// view from its own camera subscription.
// The optional `world` (T2-54) is the ONLY camera dependency — used solely by
// centerOnCell to drive setCameraState. It is optional so every existing
// 3-arg caller/test is unchanged (centerOnCell then returns false — graceful
// absence). The D-10 tween's `world` dep (which tracked the camera every frame) is
// still gone; this is a narrow, set-only camera handle, not a subscription.
export function createLayoutController(
  cells: Cells,
  pyramid: TilePyramid,
  client: ApiClient,
  world?: WorldHandle,
): LayoutController {
  if (typeof pyramid.activateLayout !== "function") {
    throw new Error(
      "createLayoutController requires the TilePyramid built by createTilePyramid (activation surface missing)",
    );
  }

  // cells.ts's renderer-internal surface (setCoarsePickFallback) — a GL-free test
  // double may omit it, so call through the optional cast.
  const cellsH = cells as Partial<CellsHandle> & Cells;

  // T2-26 detail overlay (renderer-only, purely additive): the layer that keeps
  // cells sharpening past the fine tier by drawing each visible cell's baked detail
  // original on top of the pyramid. Created ONLY when a World is wired (the
  // production 4-arg controller): it needs the scene + a camera subscription. It runs
  // off its OWN coalesced camera subscription and self-tears-down on world.dispose();
  // the controller only pushes the active manifest + position table (syncDetailOverlay
  // below). A 3-arg controller / GL-free test has no world ⇒ no overlay, unaffected.
  const overlay: DetailOverlay | null =
    world !== undefined ? createDetailOverlay(world, cellsH, client) : null;

  // T2-121 tag-highlight overlay (renderer-only, purely additive): the VISIBLE half of
  // the tag filter — gold borders on matching cells + a dim over the rest, drawn from
  // the active layout's position table OVER BOTH tiers at every zoom (the coarse mosaic
  // quad cannot mark cells — T2-120's root cause). Created ONLY with a World (needs the
  // scene + a camera subscription for the min-size clamp); a 3-arg / GL-free controller
  // has none → null, and the tag VISUAL is simply absent while the #168 match-count
  // plumbing still works. It self-tears-down on world.dispose(). The controller pushes
  // the position table (syncHighlightOverlay, in lockstep with the detail overlay) and
  // the selection (applyTags/reloadTags → setSelection).
  const highlight: HighlightOverlay | null =
    world !== undefined ? createHighlightOverlay(world) : null;

  // T2-72 Seam 1 overlay substrate (renderer-only, purely additive): the DOM "Layer A" over
  // the canvas — aggregate count CHIPS on scatter/geo piles (D-35 G4b, ON by default with a
  // self-owned toggle) + datetime AXES (T2-69). Created ONLY with a World (needs the canvas +
  // a camera subscription) AND the client (the axis domain is derived from getMetadata). It
  // reads the active layout's manifest entry + position table (syncOverlayLayer, in lockstep
  // with the other two overlays), runs off its own coalesced camera subscription, and
  // self-tears-down on world.dispose(). A 3-arg / GL-free controller has no world ⇒ null.
  const overlayLayer: OverlayLayer | null =
    world !== undefined ? createOverlayLayer(world, client) : null;

  let manifest: LayoutManifest | null = null;
  let activeLayoutId: string | null = null;
  // The layout the LATEST activate/switchTo call is driving toward. Differs from
  // activeLayoutId only while a switch is in flight — the same-layout no-op check
  // reads THIS, so a click back to A while A→B is still activating is honoured.
  let targetLayoutId: string | null = null;
  // Monotonic re-entrancy token (H2): every activate/switchTo bumps it and
  // re-checks after each await. Rapid calls converge on the LAST target — a
  // superseded call stops mutating controller state and resolves quietly.
  let opToken = 0;
  let tags: ColumnarTags | null = null;
  let tagsLoaded = false;
  // T2-120 (Fix B): the renderer-side sidecar load FAILED — a RETRYABLE state, NOT the
  // permanent latch the old code fell into (it set tagsLoaded=true BEFORE the fetch, so
  // any transient error — the 401 spiral — disabled tag filtering forever, console-only).
  // Distinct from `tags === null` on a no-sidecar dataset (a legitimate permanent
  // 'none'). tagsLoaded stays false while tagsFailed, so the next applyTags / an explicit
  // retry re-attempts the fetch. Logged ONCE (tagsFailureLogged), not once per retry.
  let tagsFailed = false;
  let tagsFailureLogged = false;
  let tagsReloadInFlight = false;
  // Single-flight the sidecar load itself (cf. positionsInFlight below): since success
  // now latches tagsLoaded AFTER the fetch (Fix B), a second ensureTags racing the first
  // — e.g. an activate overlapping a retry — would otherwise double-fetch, and a
  // later-resolving FAILURE could clobber the earlier SUCCESS. Concurrent callers join
  // the in-flight promise instead. Unreachable in today's flow (activate runs once,
  // reloadTags is guarded) but keeps the un-latched retry robust to future callers.
  let tagsInFlight: Promise<void> | null = null;
  // The UI's subscription to async tag-state changes (setTagStateListener). null until
  // the UI wires it (a GL-free / 3-arg controller test leaves it null — notify no-ops).
  let tagStateListener: ((state: TagRenderState) => void) | null = null;
  // T2-71 Locate pulse: the last applied tag selection (restored after a pulse) and a
  // token+timer so a rapid second pulse / a layout switch supersedes a pending restore.
  let lastSelection: TagSelection = { selected: [], mode: "or" };
  let pulseToken = 0;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  // T2-66/T2-48 (v2.2): the ACTIVE layout's position table (pick-at-any-zoom), and
  // which layout it was loaded for. Loaded once per layout on activate/switch; a
  // switch to a different layout re-fetches (single-flight below). null ⇒ no table
  // (pre-2.2 dataset, images-only, or a load failure) ⇒ fine-tier-only picking. The
  // client's fetchPositions is one-entry-bound (#99), so only the current layout's
  // decoded Table is retained; on a dataset switch the whole stack is remounted
  // (D-31) and a fresh cells starts with no fallback, so nothing leaks across
  // datasets.
  let positions: PositionTable | null = null;
  let positionsForLayout: string | null = null;
  let positionsInFlight: Promise<void> | null = null;
  let positionsInFlightLayout: string | null = null;
  // Monotonic token for the position-table load: each ensurePositions call bumps it,
  // and the async body only mutates state / clears the in-flight guard while it is
  // still the CURRENT load (a newer call — a switch — bumps it and wins). Avoids a
  // load referencing its own promise for the single-flight identity check.
  let positionsToken = 0;
  // Screen-size floor for the coarse-tier pick (CSS px): below this a cell is
  // un-aimable, so the position-table scan treats it as a miss. Keeps single-image
  // pick meaningful (you pick what you can see) and preserves the plain
  // click-clears-selection gesture at extreme zoom-out (see applyPickFallback).
  // Sanity of the value: a 100k grid fills a ~1200px viewport at ~3.8px/cell (still
  // pickable fully zoomed out); a 1M grid at ~1.2px/cell needs a ~3x zoom-in first.
  const COARSE_PICK_MIN_CSS_PX = 3;

  async function ensureTags(mf: LayoutManifest): Promise<void> {
    if (tagsLoaded) return;
    if (tagsInFlight !== null) return tagsInFlight; // a concurrent load is running — join it
    tagsInFlight = (async () => {
      try {
        if (mf.tags === undefined || mf.tags === null) {
          // Images-only / no tag columns (D-25): a legitimate permanent state (status
          // 'none'), NOT a failure. Latch it — there is nothing to retry; applyTags stays
          // a no-op that keeps every cell visible.
          tags = null;
          tagsLoaded = true;
          tagsFailed = false;
          return;
        }
        try {
          const url = client.tagsUrl(mf.dataset_id, mf.dataset_version);
          const table = await client.fetchTags(url);
          const tagColumns = (mf.column_roles?.tag ?? []).map((t) => t.column);
          // Bitsets are sized over the dense cell-id space (v2 schema): the manifest's
          // image_count is the authoritative count evaluateTagSelection also uses.
          tags = parseTagsTable(table, tagColumns, mf.dataset_metadata.image_count);
          tagsLoaded = true; // SUCCESS: latch the parsed table
          tagsFailed = false;
        } catch (err) {
          // T2-120 (Fix B) — gap #8, un-latched: do NOT mark tagsLoaded, so the next
          // applyTags / an explicit retry re-attempts the fetch (which itself rides the
          // credential-refresh path in client.fetchTags). Log ONCE (not once per retry),
          // and set tagsFailed so notifyTagsState surfaces a 'unavailable' affordance to
          // the UI instead of a silent, console-only, permanent disable.
          tags = null;
          tagsFailed = true;
          if (!tagsFailureLogged) {
            tagsFailureLogged = true;
            console.error("[layout] tag sidecar failed to load; tag filtering disabled (retryable)", err);
          }
        }
      } finally {
        tagsInFlight = null; // clear the single-flight guard whatever the outcome
      }
    })();
    return tagsInFlight;
  }

  /** T2-120 (Fix C): population count of a visibility array — the honest "matched"
   *  figure (cells the current selection highlights) the status bar reports. */
  function countVisible(visibility: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < visibility.length; i++) if (visibility[i] !== 0) n++;
    return n;
  }

  /** T2-120 (Fix B): the renderer-side tag availability — see TagRenderState. */
  function currentTagStatus(): "ok" | "unavailable" | "none" {
    if (tags !== null) return "ok";
    if (tagsFailed) return "unavailable";
    return "none";
  }

  /** The current TagRenderState: `status` + the honest match count for lastSelection.
   *  Cheap when tags are absent (matched == total, no evaluation). */
  function tagRenderState(): TagRenderState {
    const total = manifest === null ? 0 : manifest.dataset_metadata.image_count;
    const matched =
      tags !== null && manifest !== null
        ? countVisible(evaluateTagSelection(tags, lastSelection, total))
        : total;
    return { status: currentTagStatus(), matched, total };
  }

  /** Push the current tag state to the UI (async loads / retries only — applyTags
   *  returns its state synchronously). No-op (and no O(n) evaluation) without a
   *  listener, i.e. for GL-free / 3-arg controller tests. */
  function notifyTagsState(): void {
    if (tagStateListener === null) return;
    tagStateListener(tagRenderState());
  }

  /** T2-120 (Fix B): re-attempt a FAILED tag-sidecar load, then apply the remembered
   *  selection so the retry takes visible effect, and notify the UI. Single-flight; a
   *  no-op once tags are loaded (ensureTags short-circuits). Kicked by applyTags on a
   *  failed state and by the UI's explicit "retry" (which calls applyTags). */
  async function reloadTags(): Promise<void> {
    if (manifest === null || tagsReloadInFlight) return;
    tagsReloadInFlight = true;
    try {
      tagsLoaded = false; // allow ensureTags to run again (it re-latches on success)
      await ensureTags(manifest);
      if (tags !== null) {
        // T2-121: a successful retry re-applies the remembered selection through the
        // overlay (the single tag-visual source), not cells.setVisibility. An empty
        // remembered selection clears (nothing to distinguish).
        highlight?.setSelection(
          lastSelection.selected.length === 0
            ? null
            : evaluateTagSelection(tags, lastSelection, manifest.dataset_metadata.image_count),
        );
      }
    } finally {
      tagsReloadInFlight = false;
      notifyTagsState();
    }
  }

  /** Register the coarse-tier pick fallback (T2-66) on cells: on a fine-tier pick
   *  miss, scan `positions` (the active layout's table). Cleared (null) when there
   *  is no table for this layout, so picking degrades to fine-tier-only.
   *
   *  The scan is floored at COARSE_PICK_MIN_CSS_PX on screen (zoom is world units per
   *  CSS px, I-09): a cell smaller than that is un-aimable, so it is a MISS — which
   *  also keeps plain click-on-background-clears-selection reachable at extreme
   *  zoom-out on space-filling layouts (grid tiles the whole world, so without the
   *  floor EVERY coarse-zoom click would resolve some sub-pixel cell). */
  function applyPickFallback(): void {
    const table = positions;
    cellsH.setCoarsePickFallback?.(
      table === null
        ? null
        : (wx, wy, zoom) => hitTestPositionTable(wx, wy, table, COARSE_PICK_MIN_CSS_PX * zoom),
    );
    // The position table just changed (loaded / cleared / switched) — re-push it to the
    // detail overlay too (T2-26). Folded here because this fires at exactly the moments
    // the overlay's per-cell rects change; the overlay reads the manifest + table.
    syncDetailOverlay();
    // Same trigger for the tag-highlight overlay (T2-121): its marks are positions-driven,
    // so a load/clear/switch re-partitions them against the RETAINED selection. On a
    // switch this fires with `positions === null` FIRST (marks clear — no stale-layout
    // marks, #167), then again once the new table binds (marks rebuild at new positions).
    syncHighlightOverlay();
    // Same trigger for the overlay substrate (T2-72): pile chips + datetime axes are derived
    // from the active layout's position table, so a load/clear/switch rebuilds them. The
    // switch's positions===null pass clears the chips/axis DURING the swap window (no
    // stale-layout overlay, #167); the rebind pass re-derives for the new layout.
    syncOverlayLayer();
  }

  /** Push the active layout context (manifest + layout id + position table) to the overlay
   *  substrate (T2-72). No-op without a wired layer (a 3-arg / GL-free controller). Keyed on
   *  `positionsForLayout` so the layout id and the table are always the SAME layout's — the
   *  chips/axis never derive from a mismatched pair. Null (no manifest, or the swap-window
   *  clear where positionsForLayout is null, #167) clears the layer.
   *
   *  `positions` MAY be null with `positionsForLayout` set (PR-180 review): a layout with
   *  no positions_ref, or a FAILED table fetch. The context is still pushed — band labels
   *  and the producer axis are pure manifest data and must not silently vanish with the
   *  table; the overlay itself gates its chips (and the datetime shim) on a real table. */
  function syncOverlayLayer(): void {
    if (overlayLayer === null) return;
    if (manifest === null || positionsForLayout === null) {
      overlayLayer.setContext(null);
      return;
    }
    overlayLayer.setContext({ manifest, layoutId: positionsForLayout, positions });
  }

  /** Push the active layout's position table to the tag-highlight overlay (T2-121). No-op
   *  without a wired overlay (a 3-arg controller / GL-free test). The overlay retains the
   *  current selection and rebuilds against the new table (positions differ per layout;
   *  the selection is layout-invariant). Null positions ⇒ it clears its marks. */
  function syncHighlightOverlay(): void {
    highlight?.setContext(positions === null ? null : { positions });
  }

  /** Push the active layout context (manifest + position table) to the detail overlay
   *  (T2-26). No-op without a wired overlay (a 3-arg controller / GL-free test). The
   *  overlay engages only with BOTH a manifest carrying an image_ref detail tier AND a
   *  position table, so a positions-less (pre-2.2) or detail-less dataset never turns
   *  it on. Called on every positions change (via applyPickFallback) and once at
   *  activate end (the manifest is set after ensurePositions is kicked off). */
  function syncDetailOverlay(): void {
    if (overlay === null) return;
    overlay.setContext(manifest === null ? null : { manifest, positions });
  }

  /** Restore the SHADER's per-cell visibility to all-visible after a Locate pulse. The
   *  pulse (pulseHighlight) writes an all-but-one-dimmed array into cells' `visById`;
   *  this returns it to a clean all-visible state. Called both when a pulse ends normally
   *  AND when a layout switch cancels a pending pulse — the latter is load-bearing:
   *  newly-streamed cells read `visById` on arrival (cells.setBuffers), so a switch that
   *  only cancelled the restore timer would leave the NEW layout stuck dimmed.
   *
   *  T2-121: the tag SELECTION no longer drives cells.setVisibility (it routes through the
   *  highlight overlay — the single visual source), so the pulse is the only remaining
   *  writer of the shader dim and there is nothing tag-specific to restore TO: an active
   *  tag filter survives the pulse via the overlay (untouched here), and the shader simply
   *  returns to all-visible. (Previously this re-evaluated the tag selection into the
   *  shader; that would now double-darken against the overlay.) No-op when nothing is
   *  active. */
  function restorePulseVisibility(): void {
    if (manifest === null) return;
    const all = new Uint8Array(manifest.dataset_metadata.image_count);
    all.fill(1);
    cells.setVisibility(all);
  }

  /** Load the ACTIVE layout's position table (T2-66/T2-48, v2.2) and register the
   *  coarse-tier pick fallback. Single-flight PER LAYOUT: concurrent calls for the
   *  same layout share one fetch; a call for a DIFFERENT layout supersedes (a switch
   *  changes the table). A no-op when the table for `layoutId` is already resident.
   *  Absence (no positions_ref, or a fetch failure) leaves `positions` null and the
   *  fallback cleared — fine-tier-only picking, no error (graceful absence). */
  async function ensurePositions(mf: LayoutManifest, layoutId: string): Promise<void> {
    if (positionsForLayout === layoutId) {
      applyPickFallback(); // already loaded for this layout (re-assert on re-activate)
      return;
    }
    if (positionsInFlight !== null && positionsInFlightLayout === layoutId) {
      return positionsInFlight; // a concurrent load for the same layout — join it
    }
    const token = ++positionsToken;
    let url: string | null;
    try {
      // Guarded so the fire-and-forget callers (`void ensurePositions(...)`) can
      // never surface an unhandled rejection from the synchronous prefix: both call
      // paths fetch the manifest first, so a throw here (manifest not cached) is
      // theoretical — but degrade to fine-tier-only picking rather than reject.
      // State is left untouched (not marked loaded), so a later call may retry.
      url = client.positionsUrl(mf.dataset_id, layoutId);
    } catch (err) {
      console.error("[layout] position-table URL unavailable; pick-at-any-zoom disabled", err);
      return;
    }
    if (url === null) {
      // The layout declares no positions_ref (pre-2.2 dataset / images-only-esque):
      // clear any prior table + fallback so picking is fine-tier-only, with no error.
      positions = null;
      positionsForLayout = layoutId;
      applyPickFallback();
      return;
    }
    positionsInFlightLayout = layoutId;
    const load = (async (): Promise<void> => {
      try {
        const table = await client.fetchPositions(url);
        if (token !== positionsToken) return; // a newer load (a switch) superseded this
        positions = parsePositionsTable(table);
        positionsForLayout = layoutId;
        applyPickFallback();
      } catch (err) {
        // A failed position-table load only disables pick-at-coarse-zoom; the canvas
        // stays interactive and fine-tier picking still works (like the tag sidecar).
        console.error("[layout] position table failed to load; pick-at-any-zoom disabled", err);
        if (token === positionsToken) {
          positions = null;
          positionsForLayout = layoutId;
          applyPickFallback();
        }
      } finally {
        if (token === positionsToken) {
          positionsInFlight = null;
          positionsInFlightLayout = null;
        }
      }
    })();
    positionsInFlight = load;
    return load;
  }

  async function activate(layoutId: string): Promise<void> {
    const token = ++opToken;
    targetLayoutId = layoutId;
    try {
      const dsId = (manifest ?? pyramid.manifest).dataset_id;
      const fresh = await client.getManifest(dsId, layoutId);
      if (token !== opToken) return; // superseded by a newer activate/switch (H2)
      checkManifestVersion(fresh);
      const entry = fresh.layouts.find((l) => l.layout_id === layoutId);
      if (entry === undefined) {
        throw new Error(`layout '${layoutId}' is not declared by the manifest for '${fresh.dataset_id}'`);
      }
      await ensureTags(fresh);
      if (token !== opToken) return;
      await pyramid.activateLayout(fresh, layoutId, bboxOfEntry(entry));
      if (token !== opToken) return;
      // Load this layout's position table (pick-at-any-zoom, T2-66) + register the
      // coarse-pick fallback. Fire-and-forget: picking degrades to fine-tier-only
      // until it binds (or stays there on absence/failure); no need to block activate.
      void ensurePositions(fresh, layoutId);
      manifest = fresh;
      activeLayoutId = layoutId;
      syncDetailOverlay(); // push the new manifest now; the position table re-syncs when it binds
      // T2-120 (Fix B): surface the just-resolved tag state (ok / unavailable / none)
      // to the UI now that `manifest` is set — an activate-time sidecar failure shows
      // the retry affordance immediately, not only after the user interacts.
      notifyTagsState();
    } catch (err) {
      // The activation failed (not superseded): the switcher target falls back to
      // whatever is actually active, so a retry of the same layout is not a no-op.
      if (token === opToken) targetLayoutId = activeLayoutId;
      throw err;
    }
  }

  return {
    activate,

    async switchTo(layoutId: string): Promise<void> {
      if (manifest === null || activeLayoutId === null) {
        // Nothing active yet: a switch is just an activation.
        await activate(layoutId);
        return;
      }
      // No-op against the layout the controller is already ON or already
      // switching TO (targetLayoutId tracks the in-flight target, so a rapid
      // click back to the ORIGINAL layout mid-switch is honoured, not swallowed).
      if (layoutId === targetLayoutId) return;
      const entry = manifest.layouts.find((l) => l.layout_id === layoutId);
      if (entry === undefined) {
        throw new Error(`layout '${layoutId}' is not declared by the manifest for '${manifest.dataset_id}'`);
      }

      const token = ++opToken;
      targetLayoutId = layoutId;
      // Cancel any pending Locate-pulse restore AND undo the transient dim NOW. The
      // pulse left cells' `visById` as an all-but-one-dimmed array; newly-streamed
      // cells read visById on arrival (cells.setBuffers), so without restoring here the
      // NEW layout's cells would inherit that dim and render stuck-dimmed. Restore to
      // the current tag selection (restorePulseVisibility — NOT unconditionally
      // all-visible, so an active tag filter survives). Bumping the token also makes any
      // already-fired restore callback a no-op.
      pulseToken += 1;
      if (pulseTimer !== null) {
        clearTimeout(pulseTimer);
        pulseTimer = null;
        restorePulseVisibility();
      }
      // The old layout's position table no longer applies to the new layout's cells:
      // clear the fallback NOW (before the new table loads) so a click during the
      // switch never resolves an OLD-layout id at the new positions. Bump the load
      // token so an in-flight OLD-layout fetch that resolves during the switch cannot
      // re-register a stale table. ensurePositions below re-registers once the new
      // table binds (or leaves it cleared on absence).
      positionsToken++;
      positions = null;
      positionsForLayout = null;
      positionsInFlight = null;
      positionsInFlightLayout = null;
      applyPickFallback();
      try {
        // Drop in-flight OLD-layout tiles the moment the switch begins, so a late
        // response can never bind old-layout cells over the new view.
        pyramid.beginLayoutSwitch();
        // Instant swap: activateLayout keeps the old coarse overview as a backdrop
        // (condemned set), streams the target layout coarse-first for the LIVE
        // camera view, and cells.setBuffers places each cell at its new-layout
        // position as its tile binds. Nothing is staged, tweened, or waited on.
        await pyramid.activateLayout(manifest, layoutId, bboxOfEntry(entry));
        if (token !== opToken) return; // a later switch superseded this one (H2)
        // Load the target layout's position table + re-register the coarse-pick
        // fallback (fire-and-forget — picking is fine-tier-only until it binds).
        void ensurePositions(manifest, layoutId);
        activeLayoutId = layoutId;
      } catch (err) {
        if (token === opToken) targetLayoutId = activeLayoutId;
        throw err;
      }
    },

    applyTags(selection: TagSelection): TagRenderState {
      lastSelection = selection; // remember: async-retry re-apply AND layout-switch rebuild
      if (manifest === null) return { status: currentTagStatus(), matched: 0, total: 0 };
      const total = manifest.dataset_metadata.image_count;
      if (tags === null) {
        // No resident sidecar. If a prior load FAILED (retryable — Fix B), re-attempt in
        // the background; when it resolves, lastSelection is applied and the listener
        // pushes the real state. A 'none' dataset (images-only) has nothing to retry.
        // Meanwhile everything stays visible (matched == total) and the overlay is clear.
        if (tagsFailed) void reloadTags();
        highlight?.setSelection(null);
        return { status: currentTagStatus(), matched: total, total };
      }
      const visibility = evaluateTagSelection(tags, selection, total);
      // T2-121 SINGLE VISUAL SOURCE: route the tag visual through the highlight overlay
      // (gold borders on matches + dim on non-matches, over BOTH tiers at every zoom), NOT
      // cells.setVisibility — the fine-tier shader dim is invisible at browsing zoom (the
      // coarse mosaic can't mark cells; T2-120's root cause) AND would double-darken
      // against the overlay's dim. The #168 count plumbing is UNCHANGED: still evaluate +
      // countVisible for the honest figure the status bar reports. An EMPTY selection
      // matches every cell ⇒ nothing to distinguish ⇒ clear (no gold-on-everything);
      // matched == total, exactly as before.
      //
      // Only the EMPTY selection short-circuits. A non-empty selection that happens to
      // match everything still borders every cell, and one that matches nothing still dims
      // every cell — deliberately, because both are the honest picture ("all N match" /
      // "0 match", which the status line states in words). Suppressing either would make
      // the canvas lie about a real filter result; the loud-but-honest read is the point.
      highlight?.setSelection(selection.selected.length === 0 ? null : visibility);
      return { status: "ok", matched: countVisible(visibility), total };
    },

    setTagStateListener(listener: (state: TagRenderState) => void): void {
      tagStateListener = listener;
    },

    cellRect(id: number): CellRect | null {
      const table = positions;
      if (table === null || id < 0 || id >= table.count) return null;
      return { x: table.x[id], y: table.y[id], w: table.w[id], h: table.h[id] };
    },

    countCellsInView(view: BBox): number | null {
      const table = positions;
      if (table === null) return null; // no table ⇒ "not derivable" (the bar shows —)
      return countPositionsInView(table, view);
    },

    centerOnCell(id: number, fraction?: number): boolean {
      // Graceful absence: no camera handle wired (a 3-arg controller / test), or no
      // rect for this id (no table / out of range) → report false so the caller falls
      // back (Locate → close+select).
      if (world === undefined) return false;
      const table = positions;
      if (table === null || id < 0 || id >= table.count) return false;
      const rect = { xMin: table.x[id] - table.w[id] / 2, yMin: table.y[id] - table.h[id] / 2, xMax: table.x[id] + table.w[id] / 2, yMax: table.y[id] + table.h[id] / 2 };
      const cam = cameraForCell(rect, world.getViewport(), fraction);
      world.setCameraState(cam); // instant (no tween); the loader streams the new view
      return true;
    },

    pulseHighlight(id: number, ms = 1200): void {
      if (manifest === null) return; // nothing active yet
      const count = manifest.dataset_metadata.image_count;
      // Single-cell highlight via the EXISTING tag-visibility path (cells.setVisibility):
      // this cell visible (1), the rest de-emphasized (0) — the same shader dim the tag
      // filter uses, no new pass. Then restore the current tag selection after `ms`.
      const pulse = new Uint8Array(count); // all 0 (dimmed)
      if (id >= 0 && id < count) pulse[id] = 1; // the located cell stays bright
      cells.setVisibility(pulse);
      pulseToken += 1;
      const token = pulseToken;
      if (pulseTimer !== null) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => {
        pulseTimer = null;
        if (token !== pulseToken) return; // superseded (a newer pulse / a switch)
        // Restore the steady tag-selection visibility (empty selection ⇒ all visible).
        restorePulseVisibility();
      }, ms);
    },
  };
}
