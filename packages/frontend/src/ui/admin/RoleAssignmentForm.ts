// Column-role assignment (board 1g, step 2 "Map roles"): the three-column table
// — column (mono) / role select / sample · effect — plus explicit scatter X/Y
// PAIRS (atomic per D-26 — never a per-column "scatter-x" dropdown that could
// leave a dangling axis) and the "This dataset will offer:" unlocks footer.
// Presentational over a RolesDraft; the wizard owns the state and compiles the
// draft via roles.buildColumnRoles. The server re-validates everything at
// ingest (D-11). Sample values come from csvHeader.parseFirstRowFor (pure, no
// network) and render `—` when unavailable.
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { ColumnRoleChoice, DatetimeFormat, GeoPairDraft, RolesDraft } from "./roles";
import { isLinkable, patchGeoPair, patchScatterPair } from "./roles";
import {
  DEFAULT_NORMALIZE,
  DEFAULT_OVERLAP,
  DEFAULT_PROJECTION,
  DEFAULT_SCALE,
  NORMALIZE_OPTIONS,
  OVERLAP_OPTIONS,
  PROJECTION_OPTIONS,
  SCALE_OPTIONS,
  scatterKnobLocks,
} from "../layoutOptions";
import type { KnobOption } from "../layoutOptions";

export interface RoleAssignmentFormProps {
  draft: RolesDraft;
  onChange: (draft: RolesDraft) => void;
  /** First-data-row sample per column (csvHeader.parseFirstRowFor); optional —
   *  a missing column renders `—`. Never sent to the server. */
  samples?: Record<string, string>;
  /** The layout types the assigned roles unlock, for the "This dataset will
   *  offer:" readout. The wizard computes this via roles.availableLayoutTypes
   *  (the single source of truth, brief §6) and passes it down — this
   *  presentational component takes no RUNTIME dependency on roles.ts (the node
   *  test runner cannot resolve extensionless src specifiers, so sibling value
   *  imports are forbidden here). Defaults to the grid floor (D-25). */
  unlocks?: string[];
}

const ROLE_OPTIONS: { value: ColumnRoleChoice; label: string }[] = [
  { value: "ignore", label: "Ignore" },
  { value: "filename", label: "Filename (join key)" },
  { value: "datetime", label: "Datetime" },
  { value: "categorical", label: "Categorical" },
  { value: "tag", label: "Tags" },
  { value: "freeform", label: "Freeform (display only)" },
];

const DATETIME_FORMAT_OPTIONS: { value: DatetimeFormat; label: string }[] = [
  { value: "iso8601", label: "ISO 8601 strings" },
  { value: "unix_seconds", label: "Unix epoch (seconds)" },
  { value: "unix_millis", label: "Unix epoch (milliseconds)" },
];

/** What a role does with the column — the "effect" half of the sample · effect
 *  cell (a plain-language hint; the server is the validator, D-11). */
const ROLE_EFFECT: Record<ColumnRoleChoice, string> = {
  ignore: "not used",
  filename: "joins metadata to images",
  datetime: "unlocks the datetime layout",
  categorical: "unlocks the categorical layout",
  tag: "adds tag filtering",
  freeform: "shown in the detail panel",
};

/** Human labels for the unlockable layout types (grid is the images-only floor). */
const LAYOUT_LABEL: Record<string, string> = {
  grid: "Grid",
  datetime: "Datetime",
  categorical: "Categorical",
  scatter: "Scatter",
  geographic: "Geographic",
};

// The per-family option defaults now live in ui/layoutOptions (DEFAULT_SCALE & co) so the
// picker and the viewer's describeBakedOptions cannot disagree about what "default" means.
// The wizard keeps a knob ABSENT (undefined) while it holds its default, so an untouched —
// or reset-to-default — pair never serializes an explicit value (preserving the manifest
// options-echo emission). Selecting the default clears the draft field; anything else
// declares it.

export function RoleAssignmentForm(props: RoleAssignmentFormProps): ReactElement {
  const { draft } = props;
  const samples = props.samples ?? {};

  const setChoice = (column: string, choice: ColumnRoleChoice): void => {
    // Schema v2.8: the "render as link" flag only applies to a shown scalar column
    // (freeform/categorical). If this column moves to any other role, drop its link flag so
    // it cannot strand an unrenderable `url` that validateDraft (and the pipeline) reject.
    const canLink = isLinkable(choice);
    const url = canLink ? draft.url ?? [] : (draft.url ?? []).filter((c) => c !== column);
    props.onChange({ ...draft, choice: { ...draft.choice, [column]: choice }, url });
  };
  // Schema v2.8: toggle a column's orthogonal "render as link" flag (draft.url membership).
  const setUrl = (column: string, isLink: boolean): void => {
    const rest = (draft.url ?? []).filter((c) => c !== column);
    props.onChange({ ...draft, url: isLink ? [...rest, column] : rest });
  };
  const setDelimiter = (column: string, delimiter: string): void => {
    props.onChange({ ...draft, tagDelimiters: { ...draft.tagDelimiters, [column]: delimiter } });
  };
  const setPair = (i: number, patch: Partial<RolesDraft["scatterPairs"][number]>): void => {
    // patchScatterPair drops the carried G1 knobs when an axis is repointed (a knob
    // was declared for the ORIGINAL columns — round-2 review; see roles.ts).
    const pairs = draft.scatterPairs.map((p, j) => (j === i ? patchScatterPair(p, patch) : p));
    props.onChange({ ...draft, scatterPairs: pairs });
  };
  const setGeoPair = (i: number, patch: Partial<GeoPairDraft>): void => {
    // patchGeoPair drops the carried G2 projection/overlap when an axis is repointed
    // (mercator's |lat| limit was validated against the ORIGINAL lat column; see roles.ts).
    const pairs = draft.geoPairs.map((g, j) => (j === i ? patchGeoPair(g, patch) : g));
    props.onChange({ ...draft, geoPairs: pairs });
  };

  const anyDatetime = draft.columns.some((c) => draft.choice[c] === "datetime");
  const unlocks = props.unlocks ?? ["grid"];

  // One knob: a labelled <select> + the SELECTED value's plain-language microcopy, plus —
  // for a knob with reserved-but-unbuilt values (overlap's jitter/aggregate, D-35 G4) or a
  // value the rest of the pair rules out — a visible line per disabled value, so the UI is
  // ready and honest without offering something ingest rejects. `dflt` normalizes a pick of
  // the default back to ABSENT (undefined) so a reset-to-default never serializes an
  // explicit value (options-echo emission semantics). Presentational; onPick applies it.
  // (The long-form "Layout options explained" deep link is D-35 Seam G5's — see
  // ui/layoutOptions; the microcopy is the whole explanation until that page exists.)
  const knobControl = (args: {
    legend: string;
    ariaLabel: string;
    value: string;
    dflt: string;
    options: readonly KnobOption[];
    onPick: (v: string | undefined) => void;
    /** Values unavailable given the REST of this pair's state, keyed value -> reason (e.g.
     *  scatter `log` while placement is pass-through — ingest rejects the combination).
     *  Rendered exactly like the reserved "coming soon" values: visible but disabled, with
     *  the reason spelled out. Same honesty contract, computed per-pair. */
    locks?: Record<string, string>;
  }): ReactElement => {
    const selected = args.options.find((o) => o.value === args.value) ?? args.options[0];
    const lockOf = (o: KnobOption): string | undefined => args.locks?.[o.value];
    const isOff = (o: KnobOption): boolean => o.disabled === true || lockOf(o) !== undefined;
    // Both kinds of unavailability get a visible line, so the picker never disables
    // something without saying why.
    const notes = args.options
      .filter((o) => isOff(o))
      .map((o) => ({ value: o.value, text: `${o.label}: ${lockOf(o) ?? o.microcopy}` }));
    return h(
      "div",
      { className: "knob" },
      h(
        "label",
        { className: "knob-field" },
        h("span", { className: "knob-legend muted" }, args.legend),
        h(
          "select",
          {
            className: "role-select knob-select",
            value: args.value,
            "aria-label": args.ariaLabel,
            onChange: (e: { target: { value: string } }) =>
              args.onPick(e.target.value === args.dflt ? undefined : e.target.value),
          },
          args.options.map((o) => {
            const lock = lockOf(o);
            const suffix = lock !== undefined ? " (unavailable)" : o.disabled === true ? " (coming soon)" : "";
            return h(
              "option",
              { key: o.value, value: o.value, disabled: isOff(o), title: lock ?? o.microcopy },
              `${o.label}${suffix}`,
            );
          }),
        ),
      ),
      h("p", { className: "knob-help muted" }, selected.microcopy),
      notes.length > 0
        ? h(
            "ul",
            { className: "knob-coming" },
            notes.map((n) => h("li", { key: n.value, className: "muted" }, n.text)),
          )
        : null,
    );
  };

  const columnSelect = (value: string, onPick: (v: string) => void, ariaLabel: string): ReactElement =>
    h(
      "select",
      {
        className: "role-select",
        value,
        "aria-label": ariaLabel,
        onChange: (e: { target: { value: string } }) => onPick(e.target.value),
      },
      h("option", { value: "" }, "— column —"),
      draft.columns.map((c) => h("option", { key: c, value: c }, c)),
    );

  return h(
    "div",
    { className: "role-form" },
    h(
      "table",
      { className: "role-table" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col" }, "Column"),
          h("th", { scope: "col" }, "Role"),
          h("th", { scope: "col" }, "Sample · effect"),
        ),
      ),
      h(
        "tbody",
        null,
        draft.columns.map((column) => {
          const choice = draft.choice[column] ?? "ignore";
          const sample = samples[column];
          return h(
            "tr",
            { key: column, className: "role-row" },
            h("td", { className: "role-column-name" }, column),
            h(
              "td",
              { className: "role-cell" },
              h(
                "select",
                {
                  className: "role-select",
                  value: choice,
                  "aria-label": `Role for column ${column}`,
                  onChange: (e: { target: { value: string } }) =>
                    setChoice(column, e.target.value as ColumnRoleChoice),
                },
                ROLE_OPTIONS.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
              ),
              choice === "tag"
                ? h(
                    "label",
                    { className: "role-extra" },
                    "delimiter ",
                    h("input", {
                      className: "delimiter-input",
                      value: draft.tagDelimiters[column] ?? ",",
                      maxLength: 3,
                      "aria-label": `Tag delimiter for column ${column}`,
                      onChange: (e: { target: { value: string } }) =>
                        setDelimiter(column, e.target.value),
                    }),
                  )
                : null,
              // Schema v2.8: "render as link" is an ORTHOGONAL modifier, offered only on a
              // shown scalar column (freeform/categorical) — the value renders as an anchor
              // when it is an absolute http(s) URL (sourceUrl), plain text otherwise.
              isLinkable(choice)
                ? h(
                    "label",
                    { className: "role-extra role-url-toggle" },
                    h("input", {
                      type: "checkbox",
                      className: "role-url-checkbox",
                      checked: (draft.url ?? []).includes(column),
                      "aria-label": `Render column ${column} as a link`,
                      onChange: (e: { target: { checked: boolean } }) =>
                        setUrl(column, e.target.checked),
                    }),
                    " render as link",
                  )
                : null,
            ),
            h(
              "td",
              { className: "role-hint" },
              h(
                "span",
                { className: "role-sample" },
                sample !== undefined && sample !== "" ? sample : "—",
              ),
              h("span", { className: "role-effect muted" }, ` · ${ROLE_EFFECT[choice]}`),
            ),
          );
        }),
      ),
    ),
    anyDatetime
      ? h(
          "label",
          { className: "role-extra role-datetime-format" },
          "Datetime format ",
          h(
            "select",
            {
              className: "role-select",
              value: draft.datetimeFormat,
              "aria-label": "Datetime format",
              onChange: (e: { target: { value: string } }) =>
                props.onChange({ ...draft, datetimeFormat: e.target.value as DatetimeFormat }),
            },
            DATETIME_FORMAT_OPTIONS.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
          ),
        )
      : null,
    // ---- Scatter (x/y) — pre-computed planar coordinates (D-26), with per-pair knobs. ----
    h("h4", { className: "role-section-title" }, "Scatter layouts (x/y — pre-computed coordinates)"),
    draft.scatterPairs.length === 0
      ? h("p", { className: "muted" }, "None — add an x/y pair to unlock the scatter layout.")
      : h(
          "ul",
          { className: "role-rows" },
          draft.scatterPairs.map((pair, i) => {
            // ONE axis-scale value drives BOTH axes — the pipeline rejects a mixed pair, so
            // offering two dropdowns could only produce states ingest fail-fasts on. The
            // `?? pair.y_scale` fallback repairs a half-declared pair on the next pick.
            const scale = pair.x_scale ?? pair.y_scale ?? DEFAULT_SCALE;
            const normalize = pair.normalize ?? DEFAULT_NORMALIZE;
            const locks = scatterKnobLocks(scale, normalize);
            return h(
              "li",
              { key: i, className: "pair-row scatter-pair-row" },
              h(
                "div",
                { className: "role-row pair-main" },
                columnSelect(pair.x, (v) => setPair(i, { x: v }), `Scatter pair ${i + 1} X column`),
                columnSelect(pair.y, (v) => setPair(i, { y: v }), `Scatter pair ${i + 1} Y column`),
                h("input", {
                  className: "role-label-input",
                  placeholder: "label",
                  value: pair.label,
                  "aria-label": `Scatter pair ${i + 1} label`,
                  onChange: (e: { target: { value: string } }) => setPair(i, { label: e.target.value }),
                }),
                h(
                  "button",
                  {
                    type: "button",
                    className: "btn ghost",
                    onClick: () =>
                      props.onChange({
                        ...draft,
                        scatterPairs: draft.scatterPairs.filter((_, j) => j !== i),
                      }),
                  },
                  "Remove",
                ),
              ),
              h(
                "div",
                { className: "knob-grid" },
                knobControl({
                  legend: "Axis scale",
                  ariaLabel: `Scatter pair ${i + 1} axis scale`,
                  value: scale,
                  dflt: DEFAULT_SCALE,
                  options: SCALE_OPTIONS,
                  locks: locks.logLock !== null ? { log: locks.logLock } : undefined,
                  // Writes BOTH axes in one patch: "declare log on both axes or neither"
                  // (pipeline/ingest.py validate_scatter_config).
                  onPick: (v) =>
                    setPair(i, {
                      x_scale: v as "linear" | "log" | undefined,
                      y_scale: v as "linear" | "log" | undefined,
                    }),
                }),
                knobControl({
                  legend: "Placement",
                  ariaLabel: `Scatter pair ${i + 1} placement`,
                  value: normalize,
                  dflt: DEFAULT_NORMALIZE,
                  options: NORMALIZE_OPTIONS,
                  locks: locks.passThroughLock !== null ? { none: locks.passThroughLock } : undefined,
                  onPick: (v) => setPair(i, { normalize: v as "fit" | "none" | undefined }),
                }),
                knobControl({
                  legend: "Overlap",
                  ariaLabel: `Scatter pair ${i + 1} overlap`,
                  value: pair.overlap ?? DEFAULT_OVERLAP,
                  dflt: DEFAULT_OVERLAP,
                  options: OVERLAP_OPTIONS,
                  onPick: (v) => setPair(i, { overlap: v as "overdraw" | "jitter" | "aggregate" | undefined }),
                }),
              ),
            );
          }),
        ),
    h(
      "button",
      {
        type: "button",
        className: "btn ghost",
        onClick: () =>
          props.onChange({
            ...draft,
            scatterPairs: [...draft.scatterPairs, { x: "", y: "", label: "" }],
          }),
      },
      "Add scatter pair (X/Y)",
    ),
    // ---- Geographic (lat/long) — real-world coordinates projected to a map (D-35 G2). A
    // SEPARATE family: lon/lat + projection, no scale knobs (degrees are degrees). ----
    h("h4", { className: "role-section-title" }, "Geographic layouts (lat/long — real-world coordinates)"),
    draft.geoPairs.length === 0
      ? h("p", { className: "muted" }, "None — add a lat/long pair to unlock a map layout.")
      : h(
          "ul",
          { className: "role-rows" },
          draft.geoPairs.map((pair, i) =>
            h(
              "li",
              { key: i, className: "pair-row geo-pair-row" },
              h(
                "div",
                { className: "role-row pair-main" },
                columnSelect(pair.lon, (v) => setGeoPair(i, { lon: v }), `Geographic pair ${i + 1} longitude column`),
                columnSelect(pair.lat, (v) => setGeoPair(i, { lat: v }), `Geographic pair ${i + 1} latitude column`),
                h("input", {
                  className: "role-label-input",
                  placeholder: "label",
                  value: pair.label,
                  "aria-label": `Geographic pair ${i + 1} label`,
                  onChange: (e: { target: { value: string } }) => setGeoPair(i, { label: e.target.value }),
                }),
                h(
                  "button",
                  {
                    type: "button",
                    className: "btn ghost",
                    onClick: () =>
                      props.onChange({
                        ...draft,
                        geoPairs: draft.geoPairs.filter((_, j) => j !== i),
                      }),
                  },
                  "Remove",
                ),
              ),
              h(
                "div",
                { className: "knob-grid" },
                knobControl({
                  legend: "Projection",
                  ariaLabel: `Geographic pair ${i + 1} projection`,
                  value: pair.projection ?? DEFAULT_PROJECTION,
                  dflt: DEFAULT_PROJECTION,
                  options: PROJECTION_OPTIONS,
                  onPick: (v) => setGeoPair(i, { projection: v as "equirectangular" | "mercator" | undefined }),
                }),
                knobControl({
                  legend: "Overlap",
                  ariaLabel: `Geographic pair ${i + 1} overlap`,
                  value: pair.overlap ?? DEFAULT_OVERLAP,
                  dflt: DEFAULT_OVERLAP,
                  options: OVERLAP_OPTIONS,
                  onPick: (v) => setGeoPair(i, { overlap: v as "overdraw" | "jitter" | "aggregate" | undefined }),
                }),
              ),
            ),
          ),
        ),
    h(
      "button",
      {
        type: "button",
        className: "btn ghost",
        onClick: () =>
          props.onChange({
            ...draft,
            geoPairs: [...draft.geoPairs, { lon: "", lat: "", label: "" }],
          }),
      },
      "Add geographic pair (lat/long)",
    ),
    // "This dataset will offer:" — the unlocks readout comes from
    // availableLayoutTypes (the single source of truth, brief §6), rendered as
    // --ok outline chips, with the grid-floor note (D-25).
    h(
      "div",
      { className: "unlocks-strip" },
      h("span", { className: "unlocks-label muted" }, "This dataset will offer:"),
      h(
        "div",
        { className: "unlocks-chips" },
        unlocks.map((t) =>
          h("span", { key: t, className: "unlock-chip" }, LAYOUT_LABEL[t] ?? t),
        ),
      ),
      h("p", { className: "grid-floor-note muted" }, "Grid always works — images alone are a complete dataset."),
    ),
  );
}
