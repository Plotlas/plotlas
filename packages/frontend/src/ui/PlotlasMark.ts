// The Plotlas mark — the M4 "cluster" glyph (Design Pass boards 3b–3e, 5a).
// Five image-tiles drifting into a cluster: the embedding space. The apex tile
// is the ONLY accent, ever; the rest are neutral theme grays so the glyph
// recolors with the theme. Every in-app placement goes through this component —
// never inline the rects elsewhere, never ship an image asset in-app.
//
// Pure + no imports beyond react (createElement so the node test runner can
// import it — the repo builds UI as .ts + h(), never JSX/.tsx; see StatusBar.ts).
//
// Fills are the theme's semantic-neutral tokens, defined in theme/tokens.css
// (--border / --border-strong / --text-faint) plus --accent. Retune the mark's
// palette THERE, in one place — this component only names the roles.
import { createElement as h } from "react";
import type { ReactElement, SVGProps } from "react";

/** Displayed product version (mono status/footer signatures). No build-version
 *  source exists yet (package.json is a 0.0.0 stub), so this is the single
 *  hardcoded source of truth per brief §2.4; swap it for a real build version
 *  here when one lands. */
export const PLOTLAS_VERSION = "0.9";

// M4 "cluster": five image-tiles drifting into a cluster — the embedding space.
// Fills are THEME TOKENS: the apex tile is the only accent, ever.
// [x, y, w, h, rx, fill]
const FULL: Array<[number, number, number, number, number, string]> = [
  [3, 13, 4.6, 4.6, 1.2, "var(--border-strong)"],
  [8.6, 15.6, 4, 4, 1.1, "var(--text-faint)"],
  [6.4, 7.2, 4.6, 4.6, 1.2, "var(--text-faint)"],
  [13.2, 9.4, 4.2, 4.2, 1.1, "var(--text-faint)"],
  [14.4, 3, 6.4, 6.4, 1.7, "var(--accent)"], // apex
];
// Micro form for < 18px (favicon-scale): three tiles, larger, still apex-accent.
const MICRO: Array<[number, number, number, number, number, string]> = [
  [3.5, 12.5, 7, 7, 1.8, "var(--text-faint)"],
  [8, 4, 6, 6, 1.6, "var(--border-strong)"],
  [12.5, 10.5, 9, 9, 2.3, "var(--accent)"],
];

export interface PlotlasMarkProps {
  size?: number;                        // px, default 18
  variant?: "full" | "micro" | "muted"; // muted = empty states (no accent)
  /** Accessible name for STANDALONE use — when the mark is the ONLY Plotlas
   *  identifier in its context. Omit (the default) whenever the mark sits beside
   *  the visible "Plotlas" wordmark or inside an already-labelled control: it
   *  then renders decorative (aria-hidden) so a screen reader announces the name
   *  once, not twice. Every current placement is decorative. */
  label?: string;
}

export function PlotlasMark(props: PlotlasMarkProps): ReactElement {
  const size = props.size ?? 18;
  const variant = props.variant ?? (size < 18 ? "micro" : "full");
  const rects = variant === "micro" ? MICRO : FULL;
  // Decorative by default; a named image only when used standalone (see `label`).
  const a11y: SVGProps<SVGSVGElement> =
    props.label !== undefined
      ? { role: "img", "aria-label": props.label }
      : { "aria-hidden": true };
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      ...a11y,
    },
    ...rects.map(([x, y, w, h_, rx, fill], i) =>
      h("rect", {
        key: i,
        x,
        y,
        width: w,
        height: h_,
        rx,
        // muted = zero accent (empty states): the apex tile drops to the mid
        // neutral, every other tile to the faintest — "no accent until there's data".
        fill:
          variant === "muted"
            ? i === rects.length - 1
              ? "var(--border-strong)"
              : "var(--border)"
            : fill,
      }),
    ),
  );
}
