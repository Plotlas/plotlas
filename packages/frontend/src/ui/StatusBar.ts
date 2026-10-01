// Docked status bar for the Explorer cockpit (Phase B). A dumb presentational
// component: every value arrives as a prop on a single `ViewerStatus` object,
// and a null value renders as an em dash (—). It NEVER imports renderer/* —
// the renderer-owned values (zoom / in-view / loading-tiles / cursor / fps) are
// wired by a later renderer seam; ViewerScreen passes null/0 for them today.
//
// .ts + createElement, runtime imports bare-only: see LayoutSwitcher.ts (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h } from "react";
import type { ReactElement } from "react";
import { PlotlasMark, PLOTLAS_VERSION } from "./PlotlasMark.ts";

/** The status-bar data model (brief §2 "ViewerStatus stub"). ViewerScreen fills
 *  what it already knows (layoutId, tags, selectedCell) and passes null/0 for
 *  renderer-owned values — the renderer hook is a later seam. */
export interface ViewerStatus {
  layoutId: string;
  zoom: number | null;
  inView: number | null;
  loadingTiles: number;
  tags: TagStatusView;
  selectedCell: number | null;
  cursor: string | null;
  fps: number | null;
  /** Seam R2 P3: the loader's tile reads are failing right now. Optional because it is
   *  the one field the shell can be missing (an older caller, a test double) and because
   *  absent must mean "nothing to report", never a claim either way. */
  tilesFailing?: boolean;
}

/** T2-120/T2-121 (Fix C): the tag read-out model. Replaces the old `highlighted`
 *  chip-count (which LIED — it counted selected chips, not matching cells). `status`
 *  comes from the renderer (TagRenderState): 'unavailable' shows that state instead of
 *  a false 0; 'ok' with a selection shows the honest "N of M match" (the visibility
 *  array's sum); idle / images-only fall back to the chip count. */
export interface TagStatusView {
  status: "ok" | "unavailable" | "none";
  selected: number; // chips the user has selected (0 ⇒ idle — nothing highlighted)
  matched: number; // cells the selection MATCHES (visibility sum) — the honest count
  total: number; // dense cell count (the "of M" denominator)
}

/** Render a numeric value, or an em dash when it is null (renderer not wired). */
function num(value: number | null): string {
  return value === null ? "—" : String(value);
}

/** T2-120/T2-121 (Fix C): the honest tag read-out. When the renderer-side sidecar is
 *  unavailable, say so (never a lying 0); with an active selection, report the REAL
 *  match count; otherwise the idle chip-count phrasing. */
function tagStatusText(t: TagStatusView): string {
  if (t.status === "unavailable") return "tags unavailable";
  if (t.status === "ok" && t.selected > 0) return `${t.matched} of ${t.total} match`;
  return `${t.selected} tags highlighted`;
}

/** Seam M3 §3.4: is the tag read-out saying anything? "0 tags highlighted" is the
 *  no-filter resting state and reports nothing; a selection ("N of M match" / "3 tags
 *  highlighted") and a sidecar failure ("tags unavailable") both do.
 *
 *  The narrow bar keeps only what a phone visitor needs, and app.css hides the IDLE
 *  case there — so a filter is announced exactly when there is one. The rule is over
 *  the DATA, never over a position or a measured width: no shrink ladder. */
export function tagStatusIdle(t: TagStatusView): boolean {
  return t.status !== "unavailable" && t.selected === 0;
}

export interface StatusBarProps {
  status: ViewerStatus;
  /** The collection's source credit (Part D polish), rendered in THIS footer just left
   *  of the brand signature rather than as a separate floating strip. Built by
   *  `attributionCredit` so the card and the footer share one set of rules; `null` (or
   *  absent) when the collection has no credit, and then nothing is rendered. */
  credit?: ReactElement | null;
}

/** The docked 26px status bar: a mono, muted read-out of the current view.
 *  Left group = layout id · zoom · in-view · loading tiles (accent when > 0) ·
 *  tags highlighted; right group = selected cell · cursor coords · fps.
 *
 *  Seam M3 §3.4 — EVERY item carries a semantic class of its own. That is the whole
 *  mechanism by which the narrow bar shows fewer read-outs: app.css hides the ones a
 *  phone visitor does not need, keyed on M2's `.cockpit-narrow` (the mode switch's only
 *  output to the stylesheet — there is no second definition of narrow here, and no
 *  position-based shrink ladder). Which items are cut, and why, is documented beside
 *  the rule in app.css; this component stays dumb and renders all of them. */
export function StatusBar(props: StatusBarProps): ReactElement {
  const s = props.status;
  return h(
    "footer",
    { className: "status-bar", role: "status", "aria-label": "Viewer status" },
    h(
      "div",
      { className: "status-group" },
      h("span", { className: "status-item status-layout" }, s.layoutId),
      h("span", { className: "status-item status-zoom" }, `zoom ${num(s.zoom)}×`),
      h("span", { className: "status-item status-inview" }, `${num(s.inView)} in view`),
      h(
        "span",
        {
          className:
            s.loadingTiles > 0 ? "status-item status-tiles status-loading" : "status-item status-tiles",
        },
        `loading ${s.loadingTiles} tiles`,
      ),
      // Seam R2 P3. A sibling of the loading count, in the footer that is ALREADY
      // `role="status"` and always mounted — so it is announced without a new live region
      // and without a new write cadence (the loader pushes only when the answer changes).
      // Deliberately NOT the recovery panel: that is a `role="alert"`, is view-scoped,
      // carries "Retry this view", and renders null for `ready` — which is exactly the
      // state this fires in. Rendered only when there is something to say; an absent
      // read-out is the resting state, not a claim that everything is fine.
      s.tilesFailing === true
        ? h("span", { className: "status-item status-tiles-failing" }, "images not loading")
        : null,
      h(
        "span",
        {
          className: [
            "status-item status-tags",
            s.tags.status === "unavailable" ? "status-tags-unavailable" : null,
            tagStatusIdle(s.tags) ? "status-tags-idle" : null,
          ]
            .filter((c) => c !== null)
            .join(" "),
        },
        tagStatusText(s.tags),
      ),
    ),
    h(
      "div",
      { className: "status-group" },
      h(
        "span",
        { className: "status-item status-selection" },
        s.selectedCell === null ? "no cell selected" : `cell ${s.selectedCell} selected`,
      ),
      h("span", { className: "status-item status-cursor" }, s.cursor === null ? "—" : s.cursor),
      h("span", { className: "status-item status-fps" }, `${num(s.fps)} fps`),
      // Part D polish: the source credit lives IN this footer, immediately left of the
      // brand signature — not in a second floating strip of its own. Rendered only when
      // set, via the shared helper, so card and footer cannot drift.
      props.credit ?? null,
      // Brand signature (board 3b): the micro mark + lowercase mono wordmark. The
      // only place `plotlas` is lowercased — a status-bar/footer signature.
      h(
        "span",
        { className: "status-item status-brand" },
        h(PlotlasMark, { size: 10, variant: "micro" }),
        `plotlas v${PLOTLAS_VERSION}`,
      ),
    ),
  );
}
