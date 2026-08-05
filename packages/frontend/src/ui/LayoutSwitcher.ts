// Catalogued viewer component (props verbatim — interface-catalogue.md).
//
// Why .ts + createElement (no JSX): the unit suite runs under node 22's
// type-stripping (`node --test --experimental-strip-types`), which can erase
// types but cannot transform JSX or load .tsx — and the brief's component
// smokes renderToString this file directly. Same constraint as the renderer's
// "no extensionless relative VALUE imports" rule: react is a bare npm specifier,
// and the ONE src-local value import (`./layoutOptions`) is a PURE type-free
// module the node-test ts-extension-resolver maps (`.ts` appended) — it pulls in
// no react/renderer at runtime.
import { createElement as h, Fragment } from "react";
import type { ReactElement } from "react";
import type { LayoutInfo } from "../api-client/types";
import { familyBadge } from "./layoutOptions";

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
}

/** One button per manifest layout (display order = manifest order). The two COORDINATE
 *  families are marked apart (D-35 G3): every tab carries a `data-family` hook and the
 *  geographic/scatter tabs get a small family badge, so a map layout reads distinct from an
 *  x/y scatter. Each tab's tooltip and — for the active layout — a caption surface the baked
 *  options (D-35 G3). Clicking a non-active layout calls onSwitch; App routes that to
 *  controller.switchTo(id) — an instant, camera-preserving swap. */
export function LayoutSwitcher(props: LayoutSwitcherProps): ReactElement {
  const summaryOf = (layoutId: string): string | null => props.bakedSummary?.[layoutId] ?? null;

  const nav = h(
    "nav",
    { className: "layout-switcher", "aria-label": "Layouts" },
    props.layouts.map((layout) => {
      const active = layout.layout_id === props.activeLayoutId;
      const badge = familyBadge(layout.type);
      const summary = summaryOf(layout.layout_id);
      // The tooltip carries family + baked options so it explains the layout on hover, even
      // without the caption (which only shows for the active layout).
      const title = `${layout.label} (${layout.type})${summary !== null ? ` — ${summary}` : ""}`;
      return h(
        "button",
        {
          key: layout.layout_id,
          type: "button",
          className: active ? "layout-tab layout-tab-active" : "layout-tab",
          "data-family": layout.type,
          "aria-pressed": active,
          title,
          onClick: () => {
            if (!active) props.onSwitch(layout.layout_id);
          },
        },
        badge !== null
          ? h("span", { className: "layout-tab-family", "aria-hidden": "true" }, badge)
          : null,
        layout.label,
      );
    }),
  );

  // Baked-options caption for the ACTIVE layout: "By location — equirectangular" /
  // "Dimensions (cm) — log × log, fit". Shown only when there is something to explain (a
  // scatter/geographic layout); a default-only or non-coordinate layout shows no caption.
  const activeLayout = props.layouts.find((l) => l.layout_id === props.activeLayoutId);
  const activeSummary = summaryOf(props.activeLayoutId);
  const caption =
    activeLayout !== undefined && activeSummary !== null
      ? h(
          "p",
          { className: "layout-baked-note muted", role: "note" },
          `${activeLayout.label} — ${activeSummary}`,
        )
      : null;

  return h(Fragment, null, nav, caption);
}
