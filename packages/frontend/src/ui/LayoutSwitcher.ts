// Catalogued viewer component (props verbatim — interface-catalogue.md).
//
// Why .ts + createElement (no JSX): the unit suite runs under node 22's
// type-stripping (`node --test --experimental-strip-types`), which can erase
// types but cannot transform JSX or load .tsx — and the brief's component
// smokes renderToString this file directly. Same constraint as the renderer's
// "no extensionless relative VALUE imports" rule: react is a bare npm specifier,
// and both src-local value imports (`./layoutOptions`, `./blockedControl`) are
// PURE type-free modules the node-test ts-extension-resolver maps (`.ts`
// appended) — neither pulls in react/renderer at runtime.
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { LayoutInfo } from "../api-client/types";
import { familyBadge } from "./layoutOptions";
import { blockedControl } from "./blockedControl";

export interface LayoutSwitcherProps {
  layouts: LayoutInfo[];
  activeLayoutId: string;
  onSwitch: (layoutId: string) => void;
  // D-35 Seam G3 (T2-125): a per-layout summary of the BAKED shaping options (the manifest
  // `options` echo — e.g. "log × log, fit", "equirectangular"), keyed by layout_id, so an
  // EXISTING bake is explainable, not only the next one configurable. The viewer derives it
  // (ui/layoutOptions.describeBakedOptions over the manifest) and passes it down; this dumb
  // component only renders it (tab tooltip + a caption for the active layout). Absent/null
  // per layout ⇒ defaults / a family with no shaping options (no caption, plain tooltip).
  bakedSummary?: Record<string, string | null>;
  /** Seam R1 P5 — WHY switching is blocked right now, or null/absent when it is not.
   *  ViewerScreen derives it from `renderer/health.rendererControlState`, and passes the
   *  SAME string to the ☰ menu: below ~855px that menu is the only switcher, so a fix
   *  applied here alone leaves the dead control live on every phone.
   *
   *  The reason is the prop rather than a boolean so a blocked tab cannot render without
   *  its explanation. NOT blocked during boot — health is `starting` for the whole span
   *  between the layout list arriving and the stack existing (a multi-MB tag sidecar
   *  included), and a tap there is queued rather than refused. */
  blockedReason?: string | null;
}

/** One button per manifest layout (display order = manifest order). The two COORDINATE
 *  families are marked apart (D-35 G3): every tab carries a `data-family` hook and the
 *  geographic/scatter tabs get a small family badge, so a map layout reads distinct from an
 *  x/y scatter. Each tab shows its OWN baked options as a second line (D-35 G3, surfaced by
 *  Seam M3 §3.3.1 — see below). Clicking a non-active layout calls onSwitch; App routes that
 *  to controller.switchTo(id) — an instant, camera-preserving swap.
 *
 *  SEAM M3 §3.3.1 — this closes [[T2-131]], BOTH halves, by the fix that row itself names
 *  ("moving the summary into the tab itself, fixes both"):
 *
 *  (a) The summary used to exist for a NON-active layout only in the tab's `title`
 *      attribute, so a keyboard or touch user could not compare layouts before switching.
 *      It is now real CONTENT in every tab. The `title` stays — it is still the mouse
 *      affordance and it carries the family word the badge abbreviates — but nothing is
 *      reachable ONLY through it.
 *
 *  (b) The active-layout caption (`.layout-baked-note`) is GONE. It appeared and
 *      disappeared as the user switched between a coordinate layout and grid/datetime,
 *      changing `.topbar-layouts` height and therefore resizing the canvas on every such
 *      switch. Its information is not lost — the active tab now shows its own summary, and
 *      so does every other tab. The row's height is a `max` over all tabs, which does not
 *      depend on WHICH tab is active, so switching can no longer resize anything. */
export function LayoutSwitcher(props: LayoutSwitcherProps): ReactElement {
  const summaryOf = (layoutId: string): string | null => props.bakedSummary?.[layoutId] ?? null;

  return h(
    "nav",
    { className: "layout-switcher", "aria-label": "Layouts" },
    props.layouts.map((layout) => {
      const active = layout.layout_id === props.activeLayoutId;
      const badge = familyBadge(layout.type);
      const summary = summaryOf(layout.layout_id);
      // The tooltip still carries family + baked options for a mouse; it is no longer the
      // ONLY place either lives.
      const title = `${layout.label} (${layout.type})${summary !== null ? ` — ${summary}` : ""}`;
      // Seam R1 P5: aria-disabled + the reason + a styled class, from the one helper both
      // switching surfaces share. `blocked` is what actually refuses the click —
      // aria-disabled is advisory and a real click still arrives.
      const { blocked, ...blockedProps } = blockedControl(props.blockedReason, {
        className: active ? "layout-tab layout-tab-active" : "layout-tab",
        title,
      });
      return h(
        "button",
        {
          key: layout.layout_id,
          type: "button",
          ...blockedProps,
          "data-family": layout.type,
          "aria-pressed": active,
          onClick: () => {
            if (blocked) return;
            if (!active) props.onSwitch(layout.layout_id);
          },
        },
        h(
          "span",
          { className: "layout-tab-label" },
          badge !== null
            ? h("span", { className: "layout-tab-family", "aria-hidden": "true" }, badge)
            : null,
          layout.label,
        ),
        // The baked-options line. Rendered only when there is something to explain, so a
        // grid/datetime tab is not padded with an empty row; the tab row's height is the
        // max over all tabs either way, which is what makes it stable across switches.
        summary !== null ? h("span", { className: "layout-tab-note" }, summary) : null,
      );
    }),
  );
}
