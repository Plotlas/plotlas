// The inspector rail's header: the "Inspector" title, the one clear-selection control,
// and the collapse toggle. The clear control shows for a SINGLE selection and a
// multi-select alike (T2-204; it used to live inside SelectionSummary, so it only
// existed past 2 cells). Extracted from ViewerScreen so this — the T2-204 UI deliverable
// — is mountable in jsdom: ViewerScreen itself drives a WebGL renderer and cannot produce
// a selection in a test. Presentational; the shell owns the selection and the clear.
import { createElement as h, useRef } from "react";
import type { ReactElement } from "react";

export interface InspectorHeaderProps {
  /** How many cells are selected — the Clear control renders only when > 0. */
  selectionCount: number;
  /** Empty the selection (ViewerScreen's clearSelection). */
  onClear: () => void;
  /** Collapse the inspector rail. */
  onCollapse: () => void;
  /** Accessible name for the dismiss control, and whether it reports an expanded state.
   *
   *  The desktop rail COLLAPSES: it shrinks to a chevron that brings it straight back, so
   *  "Collapse inspector" + `aria-expanded=true` is exactly right there. Seam M2's narrow
   *  bottom sheet reuses this header but its control DISMISSES — there is no chevron left
   *  behind, and nothing to re-expand — so a screen reader announcing "collapse, expanded"
   *  describes a control that does not exist (review #271 F6). Both default to today's
   *  behaviour, so the desktop rail is untouched. */
  collapseLabel?: string;
  /** `null` DROPS the attribute entirely, which is what a dismiss needs — `aria-expanded`
   *  on a control that has no collapsed state to return from is a false promise, and
   *  there is no correct boolean to give it. */
  collapseExpanded?: boolean | null;
  /** The control's GLYPH, for the same reason its label is parameterised. The desktop rail
   *  collapses SIDEWAYS, so `›` points the way the panel goes. The narrow bottom sheet
   *  dismisses DOWNWARD, and shipping the rail's `›` there pointed across a control that
   *  moves down — the operator read it as wrong on a real phone ("the hide button is not…
   *  correct (it should point down)"). A direction indicator that contradicts the motion is
   *  a lie about the affordance, not a decoration. Defaults to the rail's glyph. */
  collapseGlyph?: string;
}

export function InspectorHeader(props: InspectorHeaderProps): ReactElement {
  // Focus anchor for the Clear button, which unmounts the instant it empties the
  // selection; without moving focus first it would fall to <body> (T2-204 a11y). The
  // collapse toggle is always present, so it is the stable landing spot.
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  return h(
    "div",
    { className: "rail-header" },
    h("span", { className: "rail-title" }, "Inspector"),
    // Labelled "Clear" because the rail is 272px — the full name is the accessible one.
    props.selectionCount > 0
      ? h(
          "button",
          {
            type: "button",
            className: "btn ghost rail-clear",
            "aria-label": "Clear selection",
            title: "Clear selection (Esc)",
            onClick: () => {
              props.onClear();
              collapseRef.current?.focus();
            },
          },
          "Clear",
        )
      : null,
    h(
      "button",
      {
        ref: collapseRef,
        type: "button",
        className: "btn ghost rail-toggle",
        "aria-label": props.collapseLabel ?? "Collapse inspector",
        "aria-expanded":
          props.collapseExpanded === null ? undefined : (props.collapseExpanded ?? true),
        onClick: props.onCollapse,
      },
      props.collapseGlyph ?? "›",
    ),
  );
}
