// D-35 layout-option VOCABULARY (Seam G3 / T2-125): the human label + one-line honest
// microcopy per option VALUE, the "coming soon" (disabled) flags for the not-yet-built
// overlap modes, and describeBakedOptions — the viewer's baked-options summary (the
// manifest `options` echo, so an EXISTING bake is explainable, not just the next one
// configurable).
//
// The operator principle (D-35 §3, "the user decides; we inform"): an option value without
// an explanation is not an option. Every knob ships microcopy that states what the value
// does AND its honest trade.
//
// NB the long-form half — a "Layout options explained" page on plotlas.com that every
// option control deep-links to (docs/launch/INFO_SITE_REQUIREMENTS.md §6) — is D-35 Seam
// G5's deliverable and is deliberately NOT stubbed here. D-35's seam map schedules the UI
// links in G3, but the page does not exist yet, and a link to a placeholder (the in-repo
// docs 404 for any signed-in non-collaborator — this repo is private and dataset creation
// gates on get_current_user, not admin) is worse than none. G5 adds the anchors when it
// knows the real URLs and page structure; until then the microcopy IS the explanation.
//
// SHARED by the wizard's knob pickers (ui/admin/RoleAssignmentForm) and the viewer
// (ui/LayoutSwitcher). Pure + node-test importable: the only src import is TYPE-ONLY
// (elided before resolution), so nothing here pulls in react or the renderer at runtime.
import type { LayoutOptions } from "../renderer/layout";

// ---- per-family option DEFAULTS (the ONE definition; D-35) -----------------------------
// The wizard keeps a knob ABSENT (undefined) while it holds its default, so an untouched —
// or reset-to-default — pair never serializes an explicit value, preserving the manifest
// options-echo emission (a scatter layout emits `options` only when a knob is non-default;
// a geographic layout always emits its real projection). These constants are ALSO what
// describeBakedOptions falls back to when an echo is absent, so the picker and the viewer
// can never disagree about what "default" means. They mirror the pipeline dataclass
// defaults (pipeline/layout_plugins/base.py).
export const DEFAULT_SCALE = "linear";
export const DEFAULT_NORMALIZE = "fit";
export const DEFAULT_PROJECTION = "equirectangular";
export const DEFAULT_OVERLAP = "overdraw";

// ---- knob option descriptors ----------------------------------------------------------

export interface KnobOption<V extends string = string> {
  value: V;
  /** The dropdown label. */
  label: string;
  /** One plain-language sentence: what the value does AND its honest trade. */
  microcopy: string;
  /** A reserved-but-not-yet-implemented value (D-35 Seam G4): shown visible-but-DISABLED
   *  so the picker is honest ("coming"), never silently offering something ingest rejects. */
  disabled?: boolean;
}

/** Axis scale (scatter only) — writes BOTH column_roles scatterRoleEntry.x_scale AND
 *  .y_scale. Deliberately ONE knob rather than two: the pipeline REJECTS a mixed pair
 *  ("x_scale 'log' with y_scale 'linear' … is not supported: the shared-scale aspect fit
 *  assumes both axes share one unit system", pipeline/ingest.py `validate_scatter_config`),
 *  so two independent dropdowns could only ever offer states ingest fail-fasts on — the
 *  exact dishonesty KnobOption.disabled exists to prevent. A per-axis fit mode is the
 *  tracked design gap T2-128; when it lands this splits back into two knobs. */
export const SCALE_OPTIONS: readonly KnobOption<"linear" | "log">[] = [
  { value: "linear", label: "Linear", microcopy: "plots the raw values with even axis spacing (the default)." },
  { value: "log", label: "Log", microcopy: "spreads skewed positive values on both axes; axis spacing becomes logarithmic." },
];

/** Placement (scatter only) — column_roles scatterRoleEntry.normalize. */
export const NORMALIZE_OPTIONS: readonly KnobOption<"fit" | "none">[] = [
  { value: "fit", label: "Fit (auto)", microcopy: "auto-fits your points to the canvas, preserving aspect (the default)." },
  { value: "none", label: "None — already 0..1", microcopy: "your coordinates are used as-is; you own the projection." },
];

/** The one remaining CROSS-KNOB rule ingest enforces once scale is a single knob: a log
 *  scale is incompatible with pass-through placement (pipeline/ingest.py — "log' is
 *  incompatible with normalize 'none' — pass-through preserves your normalized
 *  coordinates, so apply any scaling upstream before normalizing into [0,1]").
 *
 *  Returns the reason each conflicting VALUE is unavailable given the pair's current state,
 *  or null when it is selectable. The picker renders these as disabled options with the
 *  reason as microcopy — same honesty contract as the reserved overlap modes, but computed
 *  per-pair instead of static. Pure, so the rule is unit-testable without a DOM. */
export function scatterKnobLocks(
  scale: string,
  normalize: string,
): { logLock: string | null; passThroughLock: string | null } {
  const conflict = "not available together: pass-through keeps your coordinates untouched, so apply any log scaling upstream before normalizing into 0..1.";
  return {
    logLock: normalize === "none" ? conflict : null,
    passThroughLock: scale === "log" ? conflict : null,
  };
}

/** Map projection (geographic only) — column_roles geographicRoleEntry.projection. */
export const PROJECTION_OPTIONS: readonly KnobOption<"equirectangular" | "mercator">[] = [
  { value: "equirectangular", label: "Equirectangular", microcopy: "treats degrees evenly; shapes distort at high latitude." },
  { value: "mercator", label: "Mercator", microcopy: "the web-map look; areas stretch near the poles." },
];

/** Co-located-image handling — shared by both families. `jitter`/`aggregate` are D-35 Seam
 *  G4 reserved values that ingest fail-fasts on today, so the picker shows them DISABLED
 *  ("coming") — the UI is ready and honest without pretending they work. */
export const OVERLAP_OPTIONS: readonly KnobOption<"overdraw" | "jitter" | "aggregate">[] = [
  { value: "overdraw", label: "Overdraw", microcopy: "images draw over one another at their true positions (the default)." },
  { value: "jitter", label: "Jitter", disabled: true, microcopy: "coming — displaces images slightly from their true position so overlaps separate." },
  { value: "aggregate", label: "Aggregate", disabled: true, microcopy: "coming — shows one representative image with a count badge instead of overdrawing." },
];

// ---- baked-options display (the viewer surfaces what a layout ACTUALLY baked) ----------

/** A short human summary of a layout's BAKED shaping options (the manifest `options` echo),
 *  for the switcher tooltip/caption so an existing bake is explainable. Returns null for
 *  families with no shaping options (grid/datetime/categorical/…). A default scatter bake
 *  omits the echo (`options` undefined) but is still explainable as "auto-fit"; a geographic
 *  bake always echoes its projection. Mirrors the D-35 examples: a log scatter reads
 *  "log × log, fit"; a location layout reads "equirectangular".
 *
 *  Pure over `type` + the optional `options` echo — no renderer/manifest coupling beyond the
 *  LayoutOptions shape. */
export function describeBakedOptions(type: string, options: LayoutOptions | undefined): string | null {
  const overlapSuffix = (): string =>
    options?.overlap !== undefined && options.overlap !== DEFAULT_OVERLAP ? `, ${options.overlap}` : "";

  if (type === "geographic") {
    const projection = options?.projection ?? DEFAULT_PROJECTION;
    return `${projection}${overlapSuffix()}`;
  }
  if (type === "scatter") {
    if (options?.normalize === "none") return `pass-through${overlapSuffix()}`;
    const xLog = options?.x_scale === "log";
    const yLog = options?.y_scale === "log";
    if (!xLog && !yLog) return `auto-fit${overlapSuffix()}`;
    // The mixed branch is DEFENSIVE, not reachable: ingest rejects x_scale != y_scale, so no
    // manifest can echo one. It exists so a hand-edited or future per-axis echo (T2-128)
    // still reads honestly rather than being silently rounded to "log × log".
    const scale = xLog && yLog ? "log × log" : `${xLog ? "log" : "linear"} × ${yLog ? "log" : "linear"}`;
    return `${scale}, fit${overlapSuffix()}`;
  }
  return null;
}

// ---- family separation (the switcher shows geographic distinct from scatter) -----------

/** A short mono badge marking the two COORDINATE families apart in the layout switcher
 *  (D-35 G3: geographic visually distinct from scatter). Mirrors the wizard section names
 *  ("Geographic (lat/long)" / "Scatter (x/y)") so the vocabulary is consistent at every
 *  surface. null for families that need no badge (grid/datetime/categorical/…). */
export function familyBadge(type: string): string | null {
  if (type === "geographic") return "map";
  if (type === "scatter") return "x/y";
  return null;
}
