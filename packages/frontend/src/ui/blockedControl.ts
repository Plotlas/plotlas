// One shared presentation for a control the renderer cannot currently serve (Seam R1 P5).
//
// There are two switching surfaces — the desktop tab row and the ☰ menu, which is the
// ONLY switcher below ~855px — and they must say the SAME thing for the same reason. The
// previous attempt gave each its own treatment, and the phone one shipped with a boolean
// `disabled` and no explanation at all.
//
// Three decisions live here so neither surface can make them differently:
//
//  * `aria-disabled`, never the native `disabled` attribute. A natively disabled button
//    is not focusable, carries no ARIA state, and browsers suppress its `title` — so
//    inside the ☰'s `role="menu"` every row vanished from keyboard and screen-reader
//    reach at once, leaving a menu with no operable item and no way to find out why.
//  * The REASON is the input, not a boolean, so a blocked control cannot render without
//    its explanation.
//  * A class the stylesheet actually styles. #279 shipped `is-disabled` with no CSS rule
//    behind it, so a blocked row was pixel-identical to a live one and still lit up under
//    the cursor. The rules live at the END of app.css (they have to out-order the shipped
//    `:hover:not(:disabled)` rules, which an aria-disabled control still matches) and are
//    pinned by tests/dom/renderer_recovery.dom.test.ts.
//
// `aria-disabled` does NOT stop a click, so every caller must also refuse the action —
// `blocked` says whether to.

/** The class both surfaces mark a blocked control with. Exported so the CSS pin asserts
 *  a rule for the SAME string the components render. */
export const BLOCKED_CONTROL_CLASS = "is-blocked";

export interface BlockedControlProps {
  className: string;
  title: string | undefined;
  /** `true` when blocked, and absent otherwise — React drops an undefined attribute, so
   *  a live control carries no ARIA state at all. */
  "aria-disabled": true | undefined;
  /** Whether the caller must refuse the action. `aria-disabled` is advisory only. */
  blocked: boolean;
}

/**
 * Presentation for one control. `reason` null/undefined ⇒ nothing changes: the control
 * keeps its own class and title exactly as it had them.
 */
export function blockedControl(
  reason: string | null | undefined,
  base: { className: string; title?: string },
): BlockedControlProps {
  if (reason === null || reason === undefined) {
    return { className: base.className, title: base.title, "aria-disabled": undefined, blocked: false };
  }
  return {
    className: `${base.className} ${BLOCKED_CONTROL_CLASS}`,
    // The control's own tooltip still leads; the reason is appended so the explanation is
    // reachable from the control itself rather than only from a panel elsewhere.
    title: base.title === undefined ? reason : `${base.title} — ${reason}`,
    "aria-disabled": true,
    blocked: true,
  };
}
