// Seam M2 §3.1 (SCOPE_mobile-viewer, T2-202) — the ONE definition of "is this holder
// too narrow for the desktop cockpit?".
//
// Everything the narrow layout model does keys off this single question, so it is
// defined once, here, as pure functions over MEASURED lengths. ViewerScreen reads the
// lengths off the live DOM and drives it from M0's existing ResizeObserver on
// `.canvas-holder` — the HOLDER, not the viewport, because every floating rail lives
// inside that box and the holder is the honest container (a viewport query would be
// wrong the moment the viewer is not full-bleed).
//
// WHY THIS IS DERIVED AND NOT A BREAKPOINT. The cockpit stops working at
//
//     max( the top bar's own requirement , the rails' floor )
//
// and the first term is DATASET-DEPENDENT: it scales with the layout count, so
// `max-width: 700px` is already wrong for the next collection. SCOPE §1a measured
// `rijks_pilot` (5 layout tabs) needing ~855 px; a fifteen-layout collection needs far
// more, and nothing in a stylesheet can know that. So the top-bar term is MEASURED off
// the live bar (`measureTopbarFloor` below) rather than written down. The rails term is
// arithmetic over the rails' own declared widths.
//
// The only numbers that survive are the two rails' widths and the cockpit inset, and
// they are not picked here: `readCockpitLengths` reads them from the CSS custom
// properties `.viewer-screen` declares (`--rail-tags-w` / `--rail-inspector-w` /
// `--cockpit-inset`), which are the SAME declarations `.tag-rail` / `.inspector` size
// themselves from. The literals below are a fallback for an environment with no
// stylesheet applied (jsdom), are pinned against app.css in
// tests/dom/narrow_layout.dom.test.ts, and warn once at runtime if the live stylesheet
// ever disagrees with them.

/** The cockpit's fixed geometry, in CSS px — read from the stylesheet, not chosen. */
export interface CockpitLengths {
  /** The gap between a floating panel and the holder edge (`--cockpit-inset`). */
  inset: number;
  /** `.tag-rail` width (`--rail-tags-w`). */
  tagRailWidth: number;
  /** `.inspector` width (`--rail-inspector-w`). */
  inspectorWidth: number;
}

/** What the mode decision is made from: the lengths, the holder's live width, and the
 *  top bar's measured requirement (null until the desktop bar has been measured — see
 *  `measureTopbarFloor`). */
export interface CockpitMetrics extends CockpitLengths {
  /** `.canvas-holder` clientWidth. 0 means "not measured yet". */
  holderWidth: number;
  /** The narrowest holder the desktop TOP BAR fits in (`measureTopbarFloor`); null
   *  before the desktop bar has ever been measured. */
  topbarFloor: number | null;
}

// Fallbacks for `readCockpitLengths` when no stylesheet is applied. These MIRROR
// app.css `.viewer-screen`; the DOM-tier pin asserts they still match, and a mismatch
// against a live stylesheet warns below, so neither can drift silently.
export const FALLBACK_COCKPIT_LENGTHS: CockpitLengths = {
  inset: 14,
  tagRailWidth: 236,
  inspectorWidth: 272,
};

/** The narrowest holder in which the two floating rails still leave a usable atlas.
 *
 *  The two rails are `position: absolute` at opposite insets, so below
 *  `tags + inspector + 2·inset` they physically OVERLAP each other (SCOPE §1a L3
 *  measured 146 px of mutual overlap at 390 px). Overlap is the hard failure; the
 *  clear canvas BETWEEN them is the soft one, and it needs a floor too or the atlas
 *  becomes a slot between two panels.
 *
 *  That floor is derived, not picked: the atlas must be at least as wide as the widest
 *  thing floating on top of it. If someone widens the Inspector, this moves with it —
 *  which is the property a chosen number would not have. */
export function railsFloor(l: CockpitLengths): number {
  const overlapFloor = l.tagRailWidth + l.inspectorWidth + 2 * l.inset;
  return overlapFloor + Math.max(l.tagRailWidth, l.inspectorWidth);
}

/** The holder width below which the desktop cockpit no longer works. */
export function cockpitFloor(m: CockpitMetrics): number {
  return Math.max(railsFloor(m), m.topbarFloor ?? 0);
}

/** THE mode switch. `null` means NO INFORMATION — the holder has not been laid out yet,
 *  or an environment does no layout at all — and the caller must keep whatever mode it
 *  is in rather than treat that as an answer.
 *
 *  Returning `false` here instead was a real bug (review #271 F15): a ResizeObserver
 *  fires a 0-width observation whenever the holder is transiently detached from layout,
 *  and reading that as "wide" flipped an already-narrow viewer back to desktop, re-mounted
 *  both rails, and destroyed an open Tags panel until a real width flipped it back. The
 *  initial mode is still desktop — that is `useState(false)` in ViewerScreen, which is
 *  where "desktop is the primary target" belongs — but an absence of measurement must
 *  never MOVE the mode. */
export function isNarrowCockpit(m: CockpitMetrics): boolean | null {
  if (m.holderWidth <= 0) return null;
  return m.holderWidth < cockpitFloor(m);
}

/** The top bar's own requirement, as its parts. */
export interface TopbarParts {
  /** The nav pill's NON-ELASTIC width: everything except the collection name, which
   *  ellipsizes by design and is therefore not part of any floor (the dataset id is
   *  already its tooltip, so nothing is lost by truncating it). */
  navFixed: number;
  /** Every other pill's natural width. They are `flex: none`, so what they render at
   *  IS what they need. */
  otherPills: number[];
  /** The bar's flex `column-gap`. */
  gap: number;
  /** `holderWidth - barWidth` — the bar's left + right insets. */
  insets: number;
}

/** The narrowest holder the DESKTOP top bar fits in.
 *
 *  This is the bar's MIN-CONTENT, not its uncompressed width — SCOPE §1a names those
 *  two separately for `rijks_pilot` (~855px vs ~1171px) and it is the first that decides
 *  whether the cockpit still works. The collection name is excluded because it is the
 *  one part designed to give way; everything else is either a control or the tab row,
 *  and neither may be truncated (a clipped tab is a layout the visitor cannot reach,
 *  which is the exact defect D2 rejected the scroll strip for).
 *
 *  `otherPills` is where the DATASET-DEPENDENCE lives: the tab row's natural width
 *  scales with the layout count, so a fifteen-layout collection produces a larger floor
 *  than a five-layout one from the same code, which is what no breakpoint could do. */
export function topbarFloorFrom(p: TopbarParts): number {
  const pills = [p.navFixed, ...p.otherPills];
  const content = pills.reduce((a, b) => a + b, 0) + Math.max(0, pills.length - 1) * p.gap;
  return content + p.insets;
}

let warnedLengths = false;

/** Read the cockpit's declared lengths off the live stylesheet.
 *
 *  The values live in ONE place — the `.viewer-screen` custom properties in app.css,
 *  which `.tag-rail` / `.inspector` also size themselves from — so this cannot drift
 *  from what is actually rendered. `FALLBACK_COCKPIT_LENGTHS` covers an environment
 *  with no stylesheet (jsdom applies none), and a live stylesheet that disagrees warns
 *  ONCE: that is the observation which would falsify the fallback. */
export function readCockpitLengths(el: Element): CockpitLengths {
  if (typeof getComputedStyle !== "function") return FALLBACK_COCKPIT_LENGTHS;
  const cs = getComputedStyle(el);
  const read = (prop: string, fallback: number): number => {
    const raw = cs.getPropertyValue(prop).trim();
    const value = raw === "" ? Number.NaN : Number.parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    if (value !== fallback && !warnedLengths) {
      warnedLengths = true;
      console.warn(
        `[viewer] app.css declares ${prop}: ${raw}, but viewerLayoutMode's fallback says ` +
          `${fallback}px. The live value wins; update FALLBACK_COCKPIT_LENGTHS (and its ` +
          `pin in tests/dom/narrow_layout.dom.test.ts) so the two agree.`,
      );
    }
    return value;
  };
  return {
    inset: read("--cockpit-inset", FALLBACK_COCKPIT_LENGTHS.inset),
    tagRailWidth: read("--rail-tags-w", FALLBACK_COCKPIT_LENGTHS.tagRailWidth),
    inspectorWidth: read("--rail-inspector-w", FALLBACK_COCKPIT_LENGTHS.inspectorWidth),
  };
}

/** Measure the DESKTOP top bar's requirement off the live DOM, or null when there is no
 *  desktop top bar to measure — narrow mode (it has no tab row) or a collection whose
 *  layouts have not loaded yet. Null means "carry the previous belief": the requirement
 *  has to survive the mode flip that removes the very bar it describes, or the viewer
 *  could never decide when to widen back out.
 *
 *  Every width here is read from a child's own rect, NEVER from the pill it sits in.
 *  That distinction is load-bearing and was measured: the nav pill has `min-width: 0`,
 *  so under pressure it shrinks past its own contents — at a 840px viewport it rendered
 *  35px wide with its back button laid out 15px OUTSIDE it (measured 2026-08-06 against
 *  golden_dataset_full_v2). A clipped child keeps its full layout rect, so summing the
 *  children stays correct in exactly the regime where reading the parent is wrong, and
 *  the answer needs no wide-window warm-up to be right. */
export function measureTopbarFloor(holder: Element): number | null {
  const bar = holder.querySelector(".cockpit-topbar");
  const nav = holder.querySelector(".topbar-nav");
  // `.topbar-layouts` is the marker for "the DESKTOP bar is rendered".
  if (bar === null || nav === null || bar.querySelector(".topbar-layouts") === null) return null;
  const holderWidth = holder.clientWidth;
  if (holderWidth <= 0) return null;

  const navStyle = getComputedStyle(nav);
  const navGap = Number.parseFloat(navStyle.columnGap) || 0;
  const navPad =
    (Number.parseFloat(navStyle.paddingLeft) || 0) + (Number.parseFloat(navStyle.paddingRight) || 0);
  // Only the title's WIDTH is excluded, never its GAP. The title ellipsizes to zero width
  // but it does not leave the flow, so the gap on each side of it is still spent — the
  // nav keeps every one of its `children.length - 1` gaps. Counting the gaps of the
  // filtered list instead lost one (~11px) and fired the switch that much narrower than
  // true min-content (review #271 F12).
  const navFixed =
    [...nav.children]
      .filter((el) => !el.classList.contains("viewer-title"))
      .reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) +
    Math.max(0, nav.children.length - 1) * navGap +
    navPad;

  const otherPills = [...bar.children]
    // The activity pill is TRANSIENT chrome — it exists only while a job runs — so it is
    // not part of the bar's minimum, and a job starting or ending is not a re-measure
    // trigger. Including it baked a stale width into the floor and could wedge the mode
    // at a borderline holder (review #271 F11): measured with the pill, the viewer stayed
    // narrow after the job ended. Excluded, the bar may clip briefly while a job runs —
    // the honest trade, and the smaller of the two failures.
    .filter((el) => el !== nav && !el.classList.contains("topbar-activity"))
    .map((el) => el.getBoundingClientRect().width);

  return topbarFloorFrom({
    navFixed,
    otherPills,
    gap: Number.parseFloat(getComputedStyle(bar).columnGap) || 0,
    insets: Math.max(0, holderWidth - bar.getBoundingClientRect().width),
  });
}
