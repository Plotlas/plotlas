// Seam M2 §3.3 (SCOPE_mobile-viewer decision D1) — Tags on a narrow holder.
//
// Tags is a TOOL: you go to it deliberately, and it wants ROOM. SCOPE §1 measured
// `rijks_pilot`'s tag list at 2644 px scrolled against 644 px visible, so a 236 px rail
// makes it a soda straw and a peek-height sheet makes it worse. Hence the full screen —
// and hence the split from the Inspector, which is a RESPONSE and gets a sheet instead.
//
// It renders `TagControls` verbatim: this is a container (a surface + a labelled close),
// never a reimplementation of the chips, the mode switch or the retry affordance. The
// sidecar Table still arrives through `TagTableContext`, provided by ViewerScreen, so
// nothing about the tag pipeline changes shape for narrow screens.
//
// It fills `.canvas-holder`, not the viewport: the holder is the honest container (the
// status bar is a sibling BELOW it and must stay legible), and an inset-0 absolute box
// inside it needs no length unit at all — so there is no `vh`/`dvh` question to get
// wrong here.
import { createElement as h, useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { ColumnRoles } from "../generated/column_roles";
import type { TagSelection } from "../renderer/layout";
import { TagControls } from "./TagControls";

export interface TagsPanelProps {
  roles: ColumnRoles | null;
  selection: TagSelection;
  onChange: (selection: TagSelection) => void;
  rendererTagsFailed?: boolean;
  onRetryTags?: () => void;
  /** Seam R2 P1: forwarded verbatim to TagControls — the narrow surface must carry the
   *  same blocked treatment as the rail, or a phone visitor gets the refusal with no
   *  explanation at all. */
  blockedReason?: string | null;
  /** Dismiss the panel. Rendered as an explicit, labelled control — a full-screen
   *  surface with no visible way out is how a first-time visitor gets stuck. */
  onClose: () => void;
}

export function TagsPanel(props: TagsPanelProps): ReactElement {
  const panelRef = useRef<HTMLElement | null>(null);
  const { onClose } = props;

  // This is a DIALOG and it must own Escape (review #271 F1). Without this the key fell
  // straight through to ViewerScreen's window-level clear-selection (T2-204) and SILENTLY
  // emptied the selection behind a panel that stayed open — the user sees nothing happen,
  // then finds their selection gone. CAPTURE phase + stopPropagation so nothing layered
  // below ever sees it, which is the priority order T2-204 documents: modal > popover >
  // clear-selection. The Lightbox, a higher-priority modal, also binds in capture and is
  // not open at the same time as this.
  //
  // Keyed on `onClose`, which is an inline arrow at ViewerScreen's call site — so this
  // effect re-runs on every parent render. That is harmless HERE (rebinding a listener is
  // idempotent) and is precisely why the focus move below may not share it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // Focus moves INTO the panel on open and back to whatever opened it on close — the ☰
  // trigger, which `ViewerMenu` focuses before unmounting the row that was clicked, so
  // `document.activeElement` here is that button and not `<body>`. No focus TRAP: that is
  // a bigger commitment than this seam should make, and the panel covers the holder anyway.
  //
  // ON MOUNT AND UNMOUNT ONLY, and the empty dependency list is LOAD-BEARING — it is not
  // an omission. This effect focuses on SETUP, so sharing the Escape effect's `[onClose]`
  // made it re-run on every ViewerScreen render and drag focus back onto this container
  // each time. Measured in jsdom against this component (review of #267): move focus to a
  // control outside the panel, force ONE parent re-render, and `document.activeElement` is
  // `.tags-panel` again. Live that fires on every renderer-status tick and on every tag
  // chip toggled — so a finger in the tag filter loses the caret and the soft keyboard,
  // and a keyboard user cannot tab through the chips at all. `onClose` is deliberately not
  // read here; nothing in this effect calls it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, []);

  return h(
    "section",
    {
      ref: panelRef,
      className: "panel-float tags-panel",
      role: "dialog",
      "aria-label": "Tags",
      // Focusable as a container only (never in the tab order), so opening the panel can
      // move the reading position into it.
      tabIndex: -1,
    },
    h(
      "div",
      { className: "rail-header" },
      h("span", { className: "rail-title" }, "Tags"),
      h(
        "button",
        {
          type: "button",
          className: "btn ghost tags-panel-close",
          "aria-label": "Close tags",
          onClick: props.onClose,
        },
        "Done",
      ),
    ),
    h(
      "div",
      { className: "rail-body tags-panel-body" },
      h(TagControls, {
        roles: props.roles,
        selection: props.selection,
        onChange: props.onChange,
        rendererTagsFailed: props.rendererTagsFailed,
        onRetryTags: props.onRetryTags,
        blockedReason: props.blockedReason,
      }),
    ),
  );
}
