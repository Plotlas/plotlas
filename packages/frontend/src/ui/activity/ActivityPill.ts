// The activity pill (Seam O3): the small, always-visible indicator mounted in BOTH
// top bars (Library `.library-topbar-actions` and the viewer `.cockpit-topbar`). It
// reads the shared activity context, shows the active job count (accent-dotted while
// anything runs), and toggles the anchored ActivityPanel. Hidden when nothing is
// tracked (zero-and-nothing-to-dismiss). Self-contained: drop `h(ActivityPill)` into
// any bar.
//
// .ts + createElement, runtime imports bare-only.
import { createElement as h, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { shouldFlipMenu } from "../admin/DatasetList.ts";
import { useActivityActions, useActivityState } from "./activityContext.ts";
import { ActivityPanel } from "./ActivityPanel.ts";

/** Generous height estimate for the flip decision (the panel grows with the job list).
 *  The pill sits at the top of the viewport, so in practice the panel opens downward;
 *  the flip only engages in a cramped viewport. Not a layout constraint. */
export const ACTIVITY_PANEL_EST_HEIGHT = 340;

export interface ActivityPillProps {
  /** Part D §2c: resolve a dataset id to the collection's name for the panel. Passed
   *  through to ActivityPanel; identity when absent. */
  nameFor?: (dsId: string) => string;
  /** In the viewer cockpit the pill OWNS its `.panel-float` surface (the fourth
   *  floating group) so it reads over the canvas and leaves NO empty box when hidden.
   *  In the Library bar (default) it is a plain inline chip. */
  float?: boolean;
}

export function ActivityPill(props: ActivityPillProps): ReactElement | null {
  // Split hooks: the ACTION surface is stable (so the Escape effect keys only on
  // panelOpen, not on every progress tick), while the live state drives the render.
  const { close, toggle, dismiss } = useActivityActions();
  const { summary, panelOpen, jobs } = useActivityState();
  const [flipUp, setFlipUp] = useState(false);
  // Refs for popover dismissal: the wrap bounds "inside" for the outside-click check;
  // the button is where keyboard focus returns when the panel closes.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // While the panel is open: Escape closes it AND returns focus to the pill (a keyboard
  // user must not be dropped onto <body>), and a pointerdown OUTSIDE the pill+panel
  // dismisses it (the popover convention the ⋯-menu precedent uses). Both are bound only
  // while open. `pointerdown` (not `click`) so a press on the pill itself — inside the
  // wrap — is left to the toggle without a double-fire.
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // The pill is a POPOVER — it owns its dismiss key. This listener is on
        // `document`, so without stopPropagation the Escape carries on to the
        // window-level selection-clear (T2-204) and one press would close the panel
        // AND empty the inspector. So consume it. A higher-priority MODAL still wins:
        // the Lightbox binds Escape in the CAPTURE phase (Lightbox.ts), so when it is
        // open its close runs before this document-bubble handler ever fires — one
        // press closes the modal you're looking at, not the pill behind it.
        e.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    };
    const onPointerDown = (e: Event): void => {
      const target = e.target as Node | null;
      if (wrapRef.current !== null && target !== null && !wrapRef.current.contains(target)) {
        close();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [panelOpen, close]);

  // Hidden when nothing is tracked (and nothing terminal to dismiss).
  if (summary === null) return null;

  const pillClass = [
    "activity-pill",
    summary.running ? "activity-pill-running" : "",
    summary.failed ? "activity-pill-failed" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");

  const wrapClass = props.float
    ? "activity-pill-wrap panel-float topbar-activity"
    : "activity-pill-wrap";

  return h(
    "div",
    { className: wrapClass, ref: wrapRef },
    h(
      "button",
      {
        ref: btnRef,
        type: "button",
        className: pillClass,
        "aria-haspopup": "dialog",
        "aria-expanded": panelOpen,
        "aria-label": `Activity: ${summary.text}`,
        onClick: (e: { currentTarget: HTMLElement }) => {
          // Decide the open direction from live geometry (DatasetList precedent):
          // measure the pill against the viewport so a cramped view flips upward.
          // Guarded for the server render (no getBoundingClientRect).
          if (!panelOpen && typeof e.currentTarget.getBoundingClientRect === "function") {
            const btn = e.currentTarget.getBoundingClientRect();
            const viewportH = typeof window !== "undefined" ? window.innerHeight : btn.bottom;
            setFlipUp(shouldFlipMenu(btn, ACTIVITY_PANEL_EST_HEIGHT, { top: 0, bottom: viewportH }));
          }
          toggle();
        },
      },
      summary.text,
    ),
    panelOpen
      ? h(ActivityPanel, { jobs, onDismiss: dismiss, flipUp, nameFor: props.nameFor })
      : null,
  );
}
