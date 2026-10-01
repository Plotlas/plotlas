// Live minimap for the Explorer cockpit (T2-54). A CONTROLLED presentational
// component: ViewerScreen feeds it (a) an overview snapshot of the world (the
// resident coarse mosaic tiles + the layout bbox, sourced from the renderer via the
// stack — this component NEVER imports renderer/*), (b) the live camera view rect in
// world coords, and (c) an onJump callback. It paints the overview into a 2D
// <canvas> and overlays a viewport box driven by the camera; a click/drag maps back
// to world coords and calls onJump so the renderer centres the camera there.
//
// STABLE OVERVIEW (T2-88): the renderer's `coarseOverview()` returns only the tiles
// that are CURRENTLY resident, and the coarse floor is partially evicted at deep zoom
// (it is a bounded, viewport-scoped GPU set by design). Painting the minimap straight
// from that live set would make it ERODE toward the current view region as the user
// zooms/pans, and the un-painted rest read black. So the minimap keeps its OWN
// retained offscreen canvas that maps the whole layout bbox, and UNIONS each poll's
// resident tiles into it — it only monotonically COMPLETES, never erodes. The retained
// canvas is ground-filled (matching `--ground`, the app canvas surround) so sparse
// overviews (scatter/datetime, ~90% empty pads baked transparent by #111) read as
// ground, not black. It is rebuilt only when the active layout changes.
//
// Degrades gracefully: no overview imagery (a fresh activation / an all-fine dataset)
// still shows the frame + the viewport box over a ground field.
//
// Boundary: the renderer types are mirrored locally (a plain rect + an image list)
// so this UI module carries no renderer import — ViewerScreen adapts the renderer's
// CoarseOverview into these props.
//
// .ts + createElement, runtime imports bare-only: see LayoutSwitcher.ts (the node
// test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h, useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { blockedControl } from "./blockedControl";

/** A world rectangle in `[0,1]²` (mirrors the renderer BBox without importing it). */
export interface MinimapRect {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** The overview imagery the minimap paints: the active layout's world extent plus the
 *  resident coarse tiles, each an image source + the world rect it covers. Adapted by
 *  ViewerScreen from the renderer's `CoarseOverview` (kept structurally identical). */
export interface MinimapOverview {
  layoutBBox: MinimapRect;
  tiles: { bbox: MinimapRect; image: CanvasImageSource }[];
}

export interface MinimapProps {
  /** The overview imagery to draw (null/absent ⇒ ground field, box only). Each poll's
   *  CURRENTLY-RESIDENT coarse tiles; the minimap UNIONS them into its retained canvas
   *  (see the file header) so the overview completes and never erodes. */
  overview?: MinimapOverview | null;
  /** The active layout id (T2-88): the retained overview canvas is REBUILT (ground-
   *  filled + cleared) when this changes, so a layout switch does not union a new
   *  layout's tiles over the old layout's overview. A change of layout bbox is a
   *  secondary rebuild trigger (see the effect) so a same-id re-layout still resets. */
  layoutId?: string | null;
  /** The live camera view rect in world coords (null ⇒ no box drawn yet). */
  view?: MinimapRect | null;
  /** Fired with WORLD coords on click/drag; ViewerScreen centres the camera there. */
  onJump?: (worldX: number, worldY: number) => void;
  /** Seam R2 P1: why the renderer cannot serve a jump right now, or null/absent when it
   *  can. The minimap is a bare click/drag target with no other affordance, so on a dead
   *  renderer it would otherwise look live and drag the viewport box over a canvas that
   *  cannot follow. Presentation only — ViewerScreen refuses the jump against LIVE
   *  health, as `blockedControl` requires of every caller. */
  blockedReason?: string | null;
}

// The minimap canvas backing-store size (CSS box is 150×94 per app.css; a 2× backing
// store keeps the downscaled mosaic crisp without a per-frame cost — it repaints only
// when the overview changes).
const MM_W = 300;
const MM_H = 188;

// Fallback ground fill (T2-88) when the live `--ground` custom property cannot be read
// (server render / a detached canvas). Matches tokens.css `--ground` — the app + canvas
// surround — so an empty/sparse overview reads as ground, not the transparent canvas'
// black. `readGroundColor` prefers the LIVE computed value so a re-theme still cascades.
export const MINIMAP_GROUND_FALLBACK = "#0E1116";

/** Map a world rect into minimap pixel space given the layout bbox and the minimap
 *  pixel size. `[layoutBBox.xMin..xMax]` maps to `[0..width]` and y likewise (world y
 *  grows downward on screen, so the minimap keeps the same top-down orientation).
 *  Pure + exported for unit tests. */
export function worldRectToMinimap(
  rect: MinimapRect,
  layoutBBox: MinimapRect,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const lw = layoutBBox.xMax - layoutBBox.xMin || 1;
  const lh = layoutBBox.yMax - layoutBBox.yMin || 1;
  const x = ((rect.xMin - layoutBBox.xMin) / lw) * width;
  const y = ((rect.yMin - layoutBBox.yMin) / lh) * height;
  const w = ((rect.xMax - rect.xMin) / lw) * width;
  const h = ((rect.yMax - rect.yMin) / lh) * height;
  return { x, y, w, h };
}

/** Map a fractional minimap point (`[0,1]²` of the minimap box, from a click) back to
 *  WORLD coords within the layout bbox. The inverse of worldRectToMinimap's origin
 *  mapping. Pure + exported for unit tests. */
export function minimapFractionToWorld(
  fx: number,
  fy: number,
  layoutBBox: MinimapRect,
): { x: number; y: number } {
  const lw = layoutBBox.xMax - layoutBBox.xMin || 1;
  const lh = layoutBBox.yMax - layoutBBox.yMin || 1;
  return { x: layoutBBox.xMin + fx * lw, y: layoutBBox.yMin + fy * lh };
}

/** The minimal 2D-context surface the minimap paint helpers use (clear + fill an
 *  opaque ground + draw scaled images). A subset of CanvasRenderingContext2D, so the
 *  real context satisfies it and a fake is trivial to build in a unit test. */
export interface MinimapCtx {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void;
}

/** Fill the whole minimap area with the OPAQUE ground color (T2-88), so empty regions
 *  — a fresh/sparse overview, or the pads #111 baked transparent — read as the app
 *  ground rather than the transparent canvas' black. Used to (re)prime the retained
 *  overview canvas before tiles are unioned in. Pure + exported for unit tests. */
export function fillGround(ctx: MinimapCtx, color: string, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
}

/** Draw the overview mosaic tiles onto a 2D context, scaled into the layout bbox —
 *  WITHOUT clearing first (the UNION primitive: each poll's resident tiles are drawn
 *  over whatever the retained canvas already holds, so coverage only grows). A
 *  degenerate or non-drawable tile is skipped. Pure + exported for unit tests. */
export function paintTiles(
  ctx: Pick<MinimapCtx, "drawImage">,
  overview: MinimapOverview | null,
  width: number,
  height: number,
): void {
  if (overview === null || overview === undefined) return;
  for (const tile of overview.tiles) {
    const r = worldRectToMinimap(tile.bbox, overview.layoutBBox, width, height);
    // Guard against a zero/negative extent (a degenerate tile bbox).
    if (r.w <= 0 || r.h <= 0) continue;
    // Defensive: a source image could have been released between the snapshot and the
    // paint (e.g. a tab backgrounding closing an ImageBitmap) — skip it rather than
    // fault the whole minimap. The next refresh re-unions the live resident set.
    try {
      ctx.drawImage(tile.image, r.x, r.y, r.w, r.h);
    } catch {
      /* source no longer drawable — skip this tile */
    }
  }
}

/** Paint a FULL overview onto the minimap 2D context: ground-fill (T2-88) then draw
 *  the tiles, scaled into the layout bbox. The full (re)build primitive — used to prime
 *  the retained canvas on a layout change, and directly by the existing component
 *  smokes. `groundColor` defaults to the token fallback. Exported so the draw logic is
 *  unit-testable against a fake 2D context. */
export function paintOverview(
  ctx: MinimapCtx,
  overview: MinimapOverview | null,
  width: number,
  height: number,
  groundColor: string = MINIMAP_GROUND_FALLBACK,
): void {
  fillGround(ctx, groundColor, width, height);
  paintTiles(ctx, overview, width, height);
}

/** Read the app's live `--ground` custom property (so a re-theme cascades to the
 *  minimap fill), falling back to the token value when there is no DOM / the property
 *  is unset (server render, a detached node). `el` is any element in the document. */
export function readGroundColor(el: Element | null): string {
  if (el === null || typeof getComputedStyle !== "function") return MINIMAP_GROUND_FALLBACK;
  const v = getComputedStyle(el).getPropertyValue("--ground").trim();
  return v !== "" ? v : MINIMAP_GROUND_FALLBACK;
}

/** Identity key for the retained overview canvas (T2-88): the layout id plus its world
 *  bbox. A change in EITHER rebuilds the retained buffer — so switching layouts, or
 *  re-laying-out the same id into a different extent, resets the accumulated overview
 *  rather than unioning the new geometry over the old. The layout id is the first `|`-
 *  delimited field so `retainedIdentity` can compare ids alone. Pure + exported for
 *  unit tests. */
export function bboxKey(bbox: MinimapRect, layoutId: string | null): string {
  return `${layoutId ?? ""}|${bbox.xMin},${bbox.yMin},${bbox.xMax},${bbox.yMax}`;
}

/** The retained-canvas identity for this poll (T2-88), given the live `overview`, the
 *  active `layoutId`, and the identity the buffer currently holds (`current`). The rule
 *  that makes the overview COMPLETE rather than erode:
 *   - imagery present ⇒ the full `bboxKey` (id + bbox): a new id or a re-laid-out extent
 *     for the same id yields a new key ⇒ rebuild; an unchanged layout keeps the key ⇒
 *     the tiles union into the existing buffer.
 *   - imagery absent (no coarse tile yet, or teardown) ⇒ KEEP `current` when the active
 *     layout id still matches the buffer's id (a transient empty poll must NOT wipe
 *     accumulated coverage — that is the erosion we are preventing); but if the layout
 *     id changed (a switch whose new floor hasn't bound), return a fresh id-only key so
 *     the stale overview is cleared at once.
 *  Pure + exported for unit tests. */
export function retainedIdentity(
  overview: MinimapOverview | null,
  layoutId: string | null,
  current: string | null,
): string {
  if (overview !== null) return bboxKey(overview.layoutBBox, layoutId);
  const id = layoutId ?? "";
  const currentId = current !== null ? current.split("|", 1)[0] : null;
  // Same layout, just no imagery this poll → keep the current identity (no rebuild).
  if (current !== null && currentId === id) return current;
  // A switch (or first paint) with no imagery yet → an id-only key so a stale overview
  // is cleared now; it becomes the full bboxKey once the new floor's first tile binds.
  return `${id}|`;
}

/** The bottom-right overview minimap: a floating frame with a mono label, a painted
 *  overview canvas, and a live viewport box. Clicking (or dragging) maps the pointer
 *  to world coords via the layout bbox and calls onJump. */
export function Minimap(props: MinimapProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The RETAINED overview canvas (T2-88): a persistent offscreen buffer that maps the
  // whole layout bbox. Each poll's resident tiles are UNIONED into it (paintTiles) and
  // it is blitted onto the visible canvas, so the overview monotonically completes as
  // tiles bind and never erodes when the live resident set shrinks at deep zoom. It is
  // ground-filled and rebuilt when the active layout changes. Kept in a ref (survives
  // re-renders); recreated lazily so a server render (no document) is a no-op.
  const retainedRef = useRef<HTMLCanvasElement | null>(null);
  // The layout IDENTITY the retained canvas currently holds (from retainedIdentity):
  // a rebuild is triggered when it changes to a genuinely different layout. null until
  // the first paint.
  const retainedKeyRef = useRef<string | null>(null);
  const overview = props.overview ?? null;
  const layoutId = props.layoutId ?? null;
  const view = props.view ?? null;

  // Union the latest resident coarse tiles into the retained overview canvas, then
  // blit it onto the visible canvas. Rebuild (ground-fill + reset) the retained canvas
  // only when the active layout genuinely changes (see retainedIdentity), so a switch
  // never composites a new layout's tiles over the previous one. This runs each poll
  // `overview` changes; because within a layout it only ever ADDS coverage, the
  // overview monotonically completes instead of eroding with the live resident set.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof document === "undefined") return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const w = canvas.width;
    const hgt = canvas.height;
    const ground = readGroundColor(canvas);

    // Lazily create the retained offscreen canvas at the backing-store size.
    let retained = retainedRef.current;
    if (retained === null) {
      retained = document.createElement("canvas");
      retained.width = w;
      retained.height = hgt;
      retainedRef.current = retained;
    }
    const rctx = retained.getContext("2d");
    if (rctx === null) return;

    const nextKey = retainedIdentity(overview, layoutId, retainedKeyRef.current);
    if (nextKey !== retainedKeyRef.current) {
      // A genuinely different layout (or the first paint): ground-fill so the new
      // layout starts clean and empty regions read as ground, not transparent black.
      fillGround(rctx, ground, w, hgt);
      retainedKeyRef.current = nextKey;
    }
    // Union this poll's resident tiles into the retained buffer (no clear), so coverage
    // only grows. Then blit the retained buffer onto the visible canvas.
    paintTiles(rctx, overview, w, hgt);
    ctx.clearRect(0, 0, w, hgt);
    try {
      ctx.drawImage(retained, 0, 0);
    } catch {
      /* retained buffer not blittable yet — the next poll re-blits */
    }
  }, [overview, layoutId]);

  // The viewport box, positioned from the live camera view rect over the layout bbox.
  // In fractional (%) units so it tracks the CSS box regardless of the backing-store
  // size. Clamped to [0,1] so a view larger than the layout still shows a full box.
  let boxStyle: Record<string, string> | null = null;
  if (view !== null && overview !== null) {
    const r = worldRectToMinimap(view, overview.layoutBBox, 1, 1); // fractional
    const left = Math.max(0, Math.min(1, r.x));
    const top = Math.max(0, Math.min(1, r.y));
    const right = Math.max(0, Math.min(1, r.x + r.w));
    const bottom = Math.max(0, Math.min(1, r.y + r.h));
    boxStyle = {
      left: `${left * 100}%`,
      top: `${top * 100}%`,
      width: `${Math.max(0, right - left) * 100}%`,
      height: `${Math.max(0, bottom - top) * 100}%`,
    };
  }

  // Seam R2 P1 — the same helper both switching surfaces use, so the minimap cannot grow
  // a treatment of its own. `aria-disabled` is advisory on any element, so `blocked` is
  // what actually stops the jump here; the shell refuses it again on live health.
  const { blocked, ...blockedProps } = blockedControl(props.blockedReason, {
    className: "minimap panel-float",
  });

  const jump = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void => {
    if (blocked || props.onJump === undefined) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
    const fy = rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0;
    // Map into the layout bbox when we have one, else treat the minimap as the whole
    // [0,1]² world (a no-overview dataset still jumps somewhere sensible).
    const bbox: MinimapRect = overview !== null ? overview.layoutBBox : { xMin: 0, yMin: 0, xMax: 1, yMax: 1 };
    const world = minimapFractionToWorld(
      Math.max(0, Math.min(1, fx)),
      Math.max(0, Math.min(1, fy)),
      bbox,
    );
    props.onJump(world.x, world.y);
  };

  return h(
    "div",
    {
      ...blockedProps,
      "aria-label": "Overview minimap",
      // Click jumps; a drag (pointer held) re-jumps as it moves so the box follows.
      onClick: jump,
      onPointerMove: (e: { buttons: number; clientX: number; clientY: number; currentTarget: HTMLElement }) => {
        if (e.buttons === 1) jump(e); // primary button held ⇒ drag-to-jump
      },
    },
    h("span", { className: "minimap-label" }, "overview"),
    h("canvas", {
      ref: canvasRef,
      className: "minimap-canvas",
      width: MM_W,
      height: MM_H,
      "aria-hidden": true,
    }),
    // The live viewport box; absent (a neutral field) until the camera + overview
    // frame are known. Static-position fallback keeps the box visible pre-wire.
    boxStyle !== null
      ? h("div", { className: "minimap-view", style: boxStyle, "aria-hidden": true })
      : h("div", { className: "minimap-view", "aria-hidden": true }),
  );
}
