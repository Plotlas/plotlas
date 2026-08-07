// Seam M2 §3.2 (SCOPE_mobile-viewer decision D2) — the narrow top bar's menu.
//
// On a narrow holder the top bar is `[← icon] [collection name] [count] [☰ …]` and this
// is the ☰: it holds the LAYOUTS and the SEARCH, because inside a popover there is no
// horizontal budget, so every layout lists vertically at a full-size row. That is what
// beats both the scroll strip (which shows 2 of 5 tabs with no hint the rest exist) and
// a native <select> (which cannot hold a search box).
//
// IT REUSES THE SHIPPED MENU, it does not invent a second one (SCOPE non-goal §4.9):
// `.card-menu-wrap` / `.card-menu-btn` / `.card-menu` / `.menu-item` from app.css, the
// `aria-haspopup="menu"` + `aria-expanded` trigger, and ActivityPill's popover-dismiss
// discipline (Escape closes and returns focus; a pointerdown outside dismisses). Only
// the narrow-mode sizing is new (`.viewer-menu*`).
//
// THE TRIGGER IS LABELLED, NOT A BARE GLYPH. Layout-switching IS the product's idea —
// same images, different arrangements — and `☰` advertises none of that (D2's one
// designed-against risk). So the trigger reads `☰ <active layout>`, which says both
// "there is a menu" and "this is what you are looking at".
//
// WHERE role="menu" SITS, and why the search is outside it. `role="menu"` may only
// contain menuitem/group/separator children, so a `role="combobox"` inside one is
// invalid ARIA — and the combobox contract (aria-expanded / aria-controls /
// aria-activedescendant, pinned by #227) is not something to quietly drop to fit a
// container role. So the POPOVER carries no role and the `role="menu"` is on the item
// list inside it; the search field is a sibling above that list, keeping its own
// contract byte-for-byte. The trigger still opens a real menu, so `aria-haspopup="menu"`
// is still true.
//
// SEAM M3 — TWO SECTIONS, BECAUSE THE MENU HOLDS TWO KINDS OF THING (operator,
// 2026-08-06). `Tags…` stays here — the rule for this menu is DESTINATIONS, not settings,
// and a filter is a destination — but it was filed under a heading that says
// "arrangements" and inside a `role="menu"` labelled "Views", so a screen reader called
// the filter a View and a sighted user got one undifferentiated list. Views and Filters
// are now separate labelled lists.
//
// They are two sibling `role="menu"` elements rather than one menu with `role="group"`
// children, and that is deliberate: M2's review (#271 F5) established that a heading must
// not sit inside a `role="menu"` at all, and each section needs a VISIBLE heading between
// the rows. Nesting groups would have put every heading back inside a menu; siblings keep
// each heading outside its own menu, so F5's invariant holds unchanged and each list still
// carries its own accessible name. The trigger's `aria-haspopup="menu"` is unaffected —
// the popover it opens carries no role of its own, exactly as before.
//
// .ts + createElement (no JSX): the node test runner strips types but cannot transform
// JSX — the same constraint LayoutSwitcher.ts documents.
import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import type { LayoutInfo } from "../api-client/types";

export interface ViewerMenuProps {
  layouts: LayoutInfo[];
  activeLayoutId: string | null;
  onSwitch: (layoutId: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Open the full-screen Tags panel (§3.3). Optional so the menu is usable without a
   *  tags surface at all; ViewerScreen always supplies it, because the desktop rail is
   *  likewise always offered and `TagControls` renders its own disabled state for an
   *  images-only collection (D-25) — one behaviour, not a narrow-mode special case. */
  onOpenTags?: () => void;
  /** The top bar's search pill, MOVED here rather than duplicated — ViewerScreen builds
   *  exactly one of these and hands it to whichever surface owns it in this mode, so
   *  there is never a second combobox in the document. */
  search?: ReactNode;
  /** Seam M3 §3.3.1 — the per-layout BAKED-options summary, keyed by layout_id, exactly
   *  as `LayoutSwitcher` already receives it (ViewerScreen derives one object with
   *  `layoutOptions.describeBakedOptions`). A menu row has no horizontal budget to fight,
   *  so the summary is simply a second line: "By place / equirectangular".
   *
   *  This is the NARROW half of [[T2-131]](a) — on a phone the tab row does not exist, so
   *  the layouts are these rows, and without a summary the ☰ cannot say what each layout
   *  IS. It doubles as the fix for D2's one designed-against risk (a menu that explains
   *  itself). Optional: absent (or null per layout) ⇒ a plain single-line row, which is
   *  what a collection with no shaping options renders anyway. */
  bakedSummary?: Record<string, string | null>;
}

/** The narrow top bar's ☰ menu: every layout as a full-width row, plus search and the
 *  Tags panel. Closes on choose, on Escape (focus returns to the trigger), and on a
 *  pointerdown outside itself. */
export function ViewerMenu(props: ViewerMenuProps): ReactElement {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const { open, setOpen } = props;

  // Popover dismissal, bound only while open — the ActivityPill precedent verbatim.
  // NOTE this is not pointer BOOKKEEPING (M1 owns all of that): nothing here reads a
  // coordinate, counts a finger or decides whether a drag happened. It is a hit test on
  // one event, and it neither preventDefaults nor stops propagation, so a press that
  // lands on the canvas still reaches the canvas and M1's gesture model.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // This menu is a POPOVER and owns its dismiss key: without stopPropagation the
      // same press would also reach the window-level clear-selection (T2-204) and one
      // Escape would close the menu AND empty the inspector. A MODAL still wins — the
      // Lightbox binds Escape in the capture phase.
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    const onPointerDown = (e: Event): void => {
      const target = e.target as Node | null;
      if (wrapRef.current !== null && target !== null && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, setOpen]);

  const active = props.layouts.find((l) => l.layout_id === props.activeLayoutId);
  // The label is the whole point of the trigger (D2's discoverability risk). Falls back
  // to the generic word only before the layout list has loaded — never a bare glyph.
  const triggerLabel = active?.label ?? "Views";

  // ALL OR NOTHING: show the label only when it fits WHOLE, otherwise show the glyph alone
  // (operator, on a real phone 2026-08-06: "if text cannot fit, just the hamburger is
  // likely better (all I see is 'G...')"). Measured at 390x844 against rijks_pilot, the
  // label truncated on every layout name the collection ships except `Grid` — `Datetime`
  // wanted 57px and got 47, `Categorical: object type` wanted 146 and got 94 — because the
  // nav pill carries the collection title and takes 287 of the bar's 362px. A one-letter
  // stub plus an ellipsis reads as a rendering bug and carries no information, which is
  // strictly worse than the glyph it replaced.
  //
  // Measured, not a picked character budget: a name that fits stays, on any collection and
  // at any width. `aria-label` below ALWAYS names the active layout, so hiding the text
  // costs nothing to assistive tech — D2's affordance survives where it is load-bearing.
  //
  // Settled ONCE per (label, width) rather than in a feedback loop: hiding the label frees
  // width, which would make it "fit" again and oscillate. The effect un-hides, forces one
  // reflow, measures the honest overflow, then commits — a single settle step, so the
  // decision can never chase its own consequence.
  const labelRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const el = labelRef.current;
    if (el === null) return;
    const settle = (): void => {
      el.classList.remove("viewer-menu-label-hidden");
      // Read AFTER the class is gone so the measurement is of the label at its allotted
      // width, not of the collapsed box the previous decision produced.
      const truncated = el.scrollWidth > el.clientWidth + 1;
      if (truncated) el.classList.add("viewer-menu-label-hidden");
    };
    settle();
    // The holder resizing changes the allotment without changing the label, so re-settle.
    // `window.resize` only — ViewerScreen owns the holder's ResizeObserver (SCOPE §3.1,
    // "one observer, not a second one") and this must not add a competing one.
    window.addEventListener("resize", settle);
    return () => window.removeEventListener("resize", settle);
  }, [triggerLabel]);

  return h(
    "div",
    // `panel-float` is not decoration: every other top-bar group is frosted, and without
    // it the trigger painted var(--text-2) straight onto the atlas — measured ~1.7:1 over
    // bright imagery (review #271 F3). It also opts the wrap into
    // `.cockpit-topbar > .panel-float { min-width: 0 }`, which is what lets the trigger
    // shrink and its label ellipsize instead of growing past the clipped holder edge (F8).
    { className: "panel-float card-menu-wrap viewer-menu-wrap", ref: wrapRef },
    h(
      "button",
      {
        ref: btnRef,
        type: "button",
        className: "btn ghost card-menu-btn viewer-menu-btn",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        // Names what the menu actually holds. It gained a Filters section (see the file
        // header), so "Views and search" no longer described it.
        "aria-label": `Views, filters and search — showing ${triggerLabel}`,
        onClick: () => setOpen(!open),
      },
      h("span", { className: "viewer-menu-glyph", "aria-hidden": "true" }, "☰"),
      h("span", { className: "viewer-menu-trigger-label", ref: labelRef }, triggerLabel),
    ),
    open
      ? h(
          "div",
          { className: "card-menu viewer-menu" },
          props.search !== undefined
            ? h("div", { className: "viewer-menu-search" }, props.search)
            : null,
          // The section heading sits OUTSIDE the `role="menu"` element (review #271 F5):
          // a menu's children must be menuitem / menuitemradio / group / separator, and a
          // bare <p> inside one is invalid — assistive tech may skip it or mis-report the
          // item count. Visually identical; `aria-hidden` because the menu's own
          // `aria-label` already carries the same word.
          h("p", { className: "viewer-menu-section muted", "aria-hidden": "true" }, "Views"),
          h(
            "div",
            { className: "viewer-menu-items", role: "menu", "aria-label": "Views" },
            props.layouts.map((layout) => {
              const isActive = layout.layout_id === props.activeLayoutId;
              const summary = props.bakedSummary?.[layout.layout_id] ?? null;
              return h(
                "button",
                {
                  key: layout.layout_id,
                  type: "button",
                  className: isActive ? "menu-item viewer-menu-layout on" : "menu-item viewer-menu-layout",
                  role: "menuitemradio",
                  "aria-checked": isActive,
                  onClick: () => {
                    setOpen(false);
                    // Choosing unmounts the focused row, so focus would fall to <body>
                    // for a keyboard user (review #271 F7). The trigger is the stable
                    // landing spot — the same return the Escape path already does.
                    btnRef.current?.focus();
                    // A re-choose of the ACTIVE layout is a no-op switch, exactly as
                    // LayoutSwitcher's tab is — it closes the menu and nothing else.
                    if (!isActive) props.onSwitch(layout.layout_id);
                  },
                },
                h("span", { className: "viewer-menu-row-label" }, layout.label),
                // §3.3.1: the baked options as a SECOND LINE, not a hover tooltip. Only
                // when there is something to explain — a grid/datetime layout has no
                // shaping options and gets a plain one-line row.
                summary !== null ? h("span", { className: "viewer-menu-row-note" }, summary) : null,
              );
            }),
          ),
          // FILTERS — its own heading and its own named list (see the file header). A
          // filter is not an arrangement, and it must not be announced as one.
          props.onOpenTags !== undefined
            ? h(
                Fragment,
                null,
                // The separator rides the HEADING, not the list below it (review of #272,
                // finding #5). Bordering the list drew the hairline BETWEEN "Filters" and
                // "Tags…" — detaching the heading from its own item and visually grouping
                // it with the Views list above, which is the opposite of the sectioning
                // the operator asked for.
                h(
                  "p",
                  {
                    className: "viewer-menu-section viewer-menu-section-filters muted",
                    "aria-hidden": "true",
                  },
                  "Filters",
                ),
                h(
                  "div",
                  {
                    className: "viewer-menu-items viewer-menu-filters",
                    role: "menu",
                    "aria-label": "Filters",
                  },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "menu-item viewer-menu-tags",
                      role: "menuitem",
                      onClick: () => {
                        setOpen(false);
                        props.onOpenTags?.();
                      },
                    },
                    // No second line here, deliberately: the "Filters" heading is what
                    // differentiates this row, and a description would change the row's
                    // ACCESSIBLE NAME from "Tags…" — which two existing gates address it by.
                    h("span", { className: "viewer-menu-row-label" }, "Tags…"),
                  ),
                ),
              )
            : null,
        )
      : null,
  );
}
