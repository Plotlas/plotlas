// Seam M2 §3.3 (SCOPE_mobile-viewer decision D1) — the Inspector on a narrow holder.
//
// The Inspector is a RESPONSE: you tapped an image and want to know what it is. Taking
// the whole screen with text is a jarring answer to a glance, and it hides the very
// image that was tapped — which is fault S3. So it is a bottom sheet with two heights:
// PEEK answers "what did I just tap" with the atlas still visible above it, FULL shows
// the metadata body. Selecting always lands on PEEK (see `useRevealOnSelection`).
//
// CONSTRAINT M-1 (SCOPE §3 D5 — the condition D5 was approved under) is satisfied in
// CSS, not here: `--sheet-peek-h` sizes this sheet's peek height AND lifts the minimap
// and the fit-view button clear of it, so the orientation instrument stays visible at
// peek WHATEVER that height is. The relationship is structural — no number governs it.
//
// IT HAS NO DRAG, DELIBERATELY. A dragged sheet needs pointer bookkeeping, and `ui/`
// holds none: M1 owns every pointer in this viewer (`WorldHandle.consumedGesture()` is
// the single source of truth for "was that a gesture") and the M2 checklist forbids
// `ui/` regaining any. So peek↔full is an explicit, labelled control. The consequence
// is that a finger that starts on the canvas cannot be intercepted by this sheet: the
// sheet listens for nothing. Drag FEEL is a real-device question (SCOPE D6) and can be
// added later against a renderer-owned gesture, not against a hand-rolled counter here.
import { createElement as h } from "react";
import type { ReactElement, ReactNode } from "react";
import { InspectorHeader } from "./InspectorHeader";

/** How much of the sheet is showing. `peek` is the only height a SELECTION may open it
 *  to; `full` is always a deliberate act by the user. */
export type SheetDetail = "peek" | "full";

export interface InspectorSheetProps {
  detail: SheetDetail;
  setDetail: (detail: SheetDetail) => void;
  /** How many cells are selected — threaded to the shared InspectorHeader. */
  selectionCount: number;
  onClear: () => void;
  /** Dismiss the sheet entirely (the shell's `inspectorCollapsed`). */
  onClose: () => void;
  /** The Inspector body — MetadataPanel / SelectionSummary, built by ViewerScreen so
   *  the sheet and the desktop rail render the SAME body from one branch. */
  children?: ReactNode;
}

export function InspectorSheet(props: InspectorSheetProps): ReactElement {
  const full = props.detail === "full";
  return h(
    "section",
    {
      className: full ? "panel-float inspector-sheet inspector-sheet-full" : "panel-float inspector-sheet",
      "aria-label": "Inspector",
    },
    h(
      "button",
      {
        type: "button",
        className: "sheet-grip",
        "aria-label": full ? "Shrink inspector to a peek" : "Expand inspector",
        "aria-expanded": full,
        onClick: () => props.setDetail(full ? "peek" : "full"),
      },
      h("span", { className: "sheet-grip-bar", "aria-hidden": "true" }),
    ),
    // The shipped header verbatim: the title, the ONE clear-selection control (T2-204)
    // and the dismiss. Reused rather than re-rendered so the sheet and the desktop rail
    // cannot drift into two different Clear behaviours.
    h(InspectorHeader, {
      selectionCount: props.selectionCount,
      onClear: props.onClear,
      onCollapse: props.onClose,
      // The sheet DISMISSES; it does not collapse to a chevron the way the desktop rail
      // does, so the shared header's default name would describe a control that is not
      // there, and `aria-expanded` would promise a re-expand that cannot happen
      // (review #271 F6).
      collapseLabel: "Close inspector",
      collapseExpanded: null,
      // …and it points the way the sheet actually goes. The rail's `›` was shipped here
      // unchanged and read as wrong on a real phone (operator, 2026-08-06): a sheet that
      // dismisses DOWNWARD under a control pointing SIDEWAYS contradicts its own motion.
      collapseGlyph: "⌄",
    }),
    h("div", { className: "rail-body inspector-body" }, props.children),
  );
}
