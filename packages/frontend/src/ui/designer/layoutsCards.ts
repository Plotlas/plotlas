// The layout designer's CARDS (seam L5 §2a–§2c; boards `Layouts`, `LayoutStates`,
// `RoleConsequences`, `MobileLayouts`). One rule carries every state: a SOLID card exists
// on disk; a DASHED card does not.
//
//   baked       solid, green pill — rename and make-default are free; a scatter or map
//               layout's settings are editable (a role change, seam L8), its columns are not
//   baking      solid, accent edge, real progress from the job's `layout:{id}` stage
//   queued      dashed — knobs still editable, Remove drops it
//   deleting    faded, struck through — still serving until the job lands
//   stale       accent border, a triangle (never a dot, which reads as baking), the reason
//               inside the card; Re-bake QUEUES
//   unavailable 55 % opacity, dashed, the reason on its face — shown, never hidden
//
// Nothing here can start a job. Every control either PATCHes the presentation record (a
// free edit, D-xx) or writes the pending model (D-xxi: `Re-bake` queues; the review is the
// only door to a bake). The one network write a card makes is its own delete, which the
// view confirms and sends (D-xxii).
import { createElement as h, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { JobStatus, LayoutInfo } from "../../api-client/types";
import { errText } from "../../api-client/errText";
import type { Presentation } from "../../generated/presentation";
import type { LayoutOptions } from "../../renderer/layout";
import { patchGeoPair, patchScatterPair } from "../admin/roles";
import type { GeoPairDraft, RolesDraft, ScatterPairDraft } from "../admin/roles";
import { stageBarKind, stageFraction } from "../activity/eta";
import {
  DEFAULT_NORMALIZE,
  DEFAULT_OVERLAP,
  DEFAULT_PROJECTION,
  DEFAULT_SCALE,
  NORMALIZE_OPTIONS,
  OVERLAP_OPTIONS,
  PROJECTION_OPTIONS,
  SCALE_OPTIONS,
  describeBakedOptions,
  scatterKnobLocks,
} from "../layoutOptions";
import type { KnobOption } from "../layoutOptions";
import type { DesignerViewProps } from "./contract";
import type { LayoutFate } from "./layoutsCommit";
import { addBake, bakeKey, locateEntry, removeBake, withDraft } from "./pending";
import type { BakeEntry, BakedStaleness, LayoutOutcome, PendingState, ResolvedBake } from "./pending";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** How long typing must pause before a rename saves — Overview's figure (SAVE_PAUSE_MS),
 *  for the same reason: every PATCH rewrites `presentation.json`. A UI timing, not a
 *  ceiling; leaving the field saves at once. */
const SAVE_PAUSE_MS = 600;

type Pill = "baked" | "stale" | "baking" | "queued" | "unchecked" | "orphaned" | "deleting" | "waiting" | "rebake";

const PILL_TEXT: Record<Pill, string> = {
  baked: "baked",
  stale: "⚠ stale",
  baking: "baking",
  queued: "queued",
  unchecked: "unchecked",
  orphaned: "can't re-bake",
  deleting: "deleting",
  waiting: "delete waiting",
  rebake: "re-bake queued",
};

const PILL_CLASS: Record<Pill, string> = {
  baked: "pill ready",
  stale: "pill layouts-pill-flag",
  baking: "pill proc",
  queued: "pill layouts-pill-dashed",
  unchecked: "pill layouts-pill-dashed",
  orphaned: "pill err layouts-pill-flag",
  deleting: "pill err",
  waiting: "pill err layouts-pill-dashed",
  rebake: "pill layouts-pill-dashed",
};

export function pill(kind: Pill): ReactElement {
  return h("span", { className: PILL_CLASS[kind], "data-pill": kind }, PILL_TEXT[kind]);
}

function columnsText(columns: readonly string[] | null | undefined): string {
  if (columns === null || columns === undefined) return "columns not recorded";
  return columns.length === 0 ? "no source columns" : `from ${columns.join(", ")}`;
}

/** The mono meta line under a card's name: family · source · baked date · options. */
function metaLine(type: string, columns: readonly string[] | null | undefined, extra: string[]): ReactElement {
  const parts = [type !== "" ? type : "layout", columnsText(columns), ...extra];
  return h("p", { className: "layouts-card-meta" }, parts.join(" · "));
}

function box(kind: "warn" | "err" | "info" | "quiet", ...children: (ReactElement | string | null)[]): ReactElement {
  return h("div", { className: `layouts-card-box layouts-card-box-${kind}` }, ...children);
}

/** A running stage's progress, NEVER a fabricated fraction: a determinate bar and a
 *  percentage only when the stage reports a total; otherwise an indeterminate bar. */
function progressBar(status: JobStatus | null, layoutId: string): ReactElement {
  const stage = status?.progress?.stages.find((s) => s.key === `layout:${layoutId}`) ?? null;
  const running = status?.progress?.stages.find((s) => s.state === "running") ?? null;
  let text: string;
  let determinate: number | null = null;
  if (stage !== null && stage.state === "running") {
    determinate = stageBarKind(stage) === "determinate" ? stageFraction(stage) : null;
    const count =
      stage.total !== null && stage.total !== undefined
        ? `${stage.done.toLocaleString("en-US")} / ${stage.total.toLocaleString("en-US")} ${stage.unit ?? ""}`.trim()
        : `${stage.done.toLocaleString("en-US")} ${stage.unit ?? ""}`.trim();
    text = determinate !== null ? `${Math.round(determinate * 100)}% · ${count}` : count;
  } else if (status === null) {
    text = "reading the job…";
  } else if (status.state === "queued") {
    text = "waiting for the worker";
  } else if (running !== null) {
    // The run's shared stages (thumbnails, tags) come before any layout's own.
    const count =
      running.total !== null && running.total !== undefined
        ? ` ${running.done.toLocaleString("en-US")} / ${running.total.toLocaleString("en-US")}`
        : "";
    text = `${running.label}${count} — shared by the whole run`;
  } else {
    text = "between stages";
  }
  return h(
    "div",
    { className: "layouts-progress" },
    h(
      "div",
      {
        className: "progress-track",
        role: "progressbar",
        "aria-label": determinate !== null ? "Bake progress" : "Bake progress (indeterminate)",
        ...(determinate !== null ? { "aria-valuenow": Math.round(determinate * 100), "aria-valuemin": 0, "aria-valuemax": 100 } : {}),
      },
      determinate !== null
        ? h("div", { className: "progress-fill", style: { width: `${Math.round(determinate * 100)}%` } })
        : h("div", { className: "progress-indeterminate" }),
    ),
    h("p", { className: "layouts-progress-text" }, text),
  );
}

// ---------------------------------------------------------------------------
// Knobs — layoutOptions.ts rendered, not restated
// ---------------------------------------------------------------------------

/** One knob: a labelled select, the selected value's microcopy, and a line for every value
 *  that is off — a reserved "coming" value or one the pair's other knob locks — so nothing
 *  is disabled without saying why. Picking the default writes ABSENT (undefined), so an
 *  untouched pair never serializes an explicit value. The same honesty contract as the
 *  wizard's pickers (RoleAssignmentForm). */
function knob(args: {
  legend: string;
  ariaLabel: string;
  value: string;
  dflt: string;
  options: readonly KnobOption[];
  locks?: Record<string, string>;
  disabled?: boolean;
  onPick: (v: string | undefined) => void;
}): ReactElement {
  const selected = args.options.find((o) => o.value === args.value) ?? args.options[0];
  const lockOf = (o: KnobOption): string | undefined => args.locks?.[o.value];
  const isOff = (o: KnobOption): boolean => o.disabled === true || lockOf(o) !== undefined;
  const notes = args.options.filter(isOff).map((o) => ({ value: o.value, text: `${o.label}: ${lockOf(o) ?? o.microcopy}` }));
  return h(
    "div",
    { className: "knob layouts-knob" },
    h(
      "label",
      { className: "knob-field" },
      h("span", { className: "knob-legend muted" }, args.legend),
      h(
        "select",
        {
          className: "role-select knob-select",
          value: args.value,
          disabled: args.disabled === true,
          "aria-label": args.ariaLabel,
          onChange: (e: { target: { value: string } }) => args.onPick(e.target.value === args.dflt ? undefined : e.target.value),
        },
        args.options.map((o) => {
          const lock = lockOf(o);
          const suffix = lock !== undefined ? " (unavailable)" : o.disabled === true ? " (coming soon)" : "";
          return h("option", { key: o.value, value: o.value, disabled: isOff(o), title: lock ?? o.microcopy }, `${o.label}${suffix}`);
        }),
      ),
    ),
    h("p", { className: "knob-help muted" }, selected.microcopy),
    notes.length > 0 ? h("ul", { className: "knob-coming" }, notes.map((n) => h("li", { key: n.value, className: "muted" }, n.text))) : null,
  );
}

type PairDraft = ScatterPairDraft | GeoPairDraft;

/** One knob control of a family: the draft keys it writes (the axis scale writes both), its
 *  default, its words and values, and what locks its values. A family's list of these is the
 *  ONE list of its knobs on the cards: the controls are drawn from it, and a put-back and a
 *  pending-change test walk exactly its keys (review of #397, round 3, finding 6). */
interface KnobSpec<P extends PairDraft> {
  keys: readonly (keyof P & string)[];
  dflt: string;
  legend: string;
  /** The select's accessible name after the card's: `{name} {aria}`. */
  aria: string;
  options: readonly KnobOption[];
  locks?: (pair: P) => Record<string, string> | undefined;
}

/** A knob's value on a pair: its first key the pair declares, else its default. */
function knobValue<P extends PairDraft>(spec: KnobSpec<P>, pair: P): string {
  for (const key of spec.keys) {
    const value = pair[key];
    if (typeof value === "string") return value;
  }
  return spec.dflt;
}

// ONE axis-scale value drives both axes: the pipeline rejects a mixed pair. A log scale and
// pass-through placement lock each other (`scatterKnobLocks`).
const scatterScale = (p: ScatterPairDraft): string => p.x_scale ?? p.y_scale ?? DEFAULT_SCALE;
const scatterPlacement = (p: ScatterPairDraft): string => p.normalize ?? DEFAULT_NORMALIZE;

const OVERLAP_KNOB = { keys: ["overlap"], dflt: DEFAULT_OVERLAP, legend: "Overlap", aria: "overlap", options: OVERLAP_OPTIONS } as const;

const SCATTER_KNOBS: readonly KnobSpec<ScatterPairDraft>[] = [
  {
    keys: ["x_scale", "y_scale"],
    dflt: DEFAULT_SCALE,
    legend: "Axis scale (both)",
    aria: "axis scale",
    options: SCALE_OPTIONS,
    locks: (p) => {
      const lock = scatterKnobLocks(scatterScale(p), scatterPlacement(p)).logLock;
      return lock !== null ? { log: lock } : undefined;
    },
  },
  {
    keys: ["normalize"],
    dflt: DEFAULT_NORMALIZE,
    legend: "Placement",
    aria: "placement",
    options: NORMALIZE_OPTIONS,
    locks: (p) => {
      const lock = scatterKnobLocks(scatterScale(p), scatterPlacement(p)).passThroughLock;
      return lock !== null ? { none: lock } : undefined;
    },
  },
  OVERLAP_KNOB,
];

const GEO_KNOBS: readonly KnobSpec<GeoPairDraft>[] = [
  { keys: ["projection"], dflt: DEFAULT_PROJECTION, legend: "Projection", aria: "projection", options: PROJECTION_OPTIONS },
  OVERLAP_KNOB,
];

/** A family's knob controls on one pair. Picking a default writes the key ABSENT (`knob`). */
function pairKnobs<P extends PairDraft>(specs: readonly KnobSpec<P>[], pair: P, name: string, onPatch: (p: Partial<P>) => void, disabled = false): ReactElement {
  return h(
    "div",
    { className: "knob-grid layouts-knobs" },
    ...specs.map((spec) =>
      knob({
        legend: spec.legend,
        ariaLabel: `${name} ${spec.aria}`,
        value: knobValue(spec, pair),
        dflt: spec.dflt,
        options: spec.options,
        locks: spec.locks?.(pair),
        disabled,
        onPick: (v) => onPatch(Object.fromEntries(spec.keys.map((key) => [key, v])) as Partial<P>),
      }),
    ),
  );
}

function columnSelect(value: string, columns: readonly string[], ariaLabel: string, onPick: (v: string) => void): ReactElement {
  return h(
    "select",
    { className: "role-select", value, "aria-label": ariaLabel, onChange: (e: { target: { value: string } }) => onPick(e.target.value) },
    h("option", { value: "" }, "— column —"),
    columns.map((c) => h("option", { key: c, value: c }, c)),
  );
}

const AXES = {
  scatter: { a: "X column", b: "Y column", noun: "scatter" },
  geographic: { a: "Longitude", b: "Latitude", noun: "map" },
} as const;

/** One coordinate family as the cards edit its pairs: where they live in the draft, a pair's
 *  two axis columns and how to write them, its patch (`roles.ts`: a repoint drops the knobs),
 *  and its knobs. The cards' code is written once against this, so a fix cannot land in one
 *  family's branch and miss the other's (review of #397, round 3, finding 7). */
interface PairFamily<P extends PairDraft> {
  type: "scatter" | "geographic";
  axes: { a: string; b: string; noun: string };
  knobs: readonly KnobSpec<P>[];
  pairs: (draft: RolesDraft) => P[];
  withPairs: (draft: RolesDraft, pairs: P[]) => RolesDraft;
  columns: (pair: P) => [string, string];
  /** A pair over `a`, `b` with this label and no knobs. */
  make: (a: string, b: string, label: string) => P;
  /** The patch that points the pair's two axes at `a`, `b`. */
  repoint: (a: string, b: string) => Partial<P>;
  patch: (pair: P, patch: Partial<P>) => P;
}

const SCATTER: PairFamily<ScatterPairDraft> = {
  type: "scatter",
  axes: AXES.scatter,
  knobs: SCATTER_KNOBS,
  pairs: (draft) => draft.scatterPairs,
  withPairs: (draft, pairs) => ({ ...draft, scatterPairs: pairs }),
  columns: (p) => [p.x, p.y],
  make: (x, y, label) => ({ x, y, label }),
  repoint: (x, y) => ({ x, y }),
  patch: patchScatterPair,
};

const GEOGRAPHIC: PairFamily<GeoPairDraft> = {
  type: "geographic",
  axes: AXES.geographic,
  knobs: GEO_KNOBS,
  pairs: (draft) => draft.geoPairs,
  withPairs: (draft, pairs) => ({ ...draft, geoPairs: pairs }),
  columns: (g) => [g.lon, g.lat],
  make: (lon, lat, label) => ({ lon, lat, label }),
  repoint: (lon, lat) => ({ lon, lat }),
  patch: patchGeoPair,
};

/** `use`, run with the descriptor of `type`'s family — the one place the two are told apart.
 *  Anything but "scatter" is geographic: only the two pair families reach here. */
function withFamily<R>(type: string, use: <P extends PairDraft>(family: PairFamily<P>) => R): R {
  return type === "scatter" ? use(SCATTER) : use(GEOGRAPHIC);
}

/** A pair's `source_columns`, through its family. */
function pairColumns<P extends PairDraft>(family: PairFamily<P>, pair: P): string[] {
  const [a, b] = family.columns(pair);
  return pairSource(a, b);
}

// ---------------------------------------------------------------------------
// The pair picker (D-xxiii) — a pair is picked on the card that will consume it
// ---------------------------------------------------------------------------

/** `[a, b]` de-duplicated, first-seen order — `source_columns` for a pair. */
export function pairSource(a: string, b: string): string[] {
  return [...new Set([a, b])];
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Queue a pair: TWO model writes, in this order — the pair into the draft, then the bake
 *  (CONTRACT §3). A pair the draft already declares (a committed layout's, say) is not
 *  declared twice: only the bake is queued, which is how a renamed layout's new id is
 *  baked. */
export function queuePair(pending: PendingState, family: "scatter" | "geographic", a: string, b: string): PendingState {
  const draft = pending.draft;
  if (draft === null) return pending;
  const next = withFamily(family, <P extends PairDraft>(f: PairFamily<P>) => {
    const pairs = f.pairs(draft);
    return pairs.some((p) => sameColumns(f.columns(p), [a, b])) ? draft : f.withPairs(draft, [...pairs, f.make(a, b, "")]);
  });
  return addBake(withDraft(pending, next), { kind: "new", type: family, source_columns: pairSource(a, b) });
}

/** Swap one queued entry for another IN PLACE — an axis repointed on its card must not
 *  send the card to the back of the queue. Built only from the model's own identity rule
 *  (`bakeKey`): if the new entry is already queued, the old one is simply removed. */
function replaceBake(state: PendingState, from: BakeEntry, to: BakeEntry): PendingState {
  const toKey = bakeKey(to);
  const fromKey = bakeKey(from);
  // A knob or a name changes no column, so the entry is the same one: nothing to swap. Without
  // this it found ITSELF already queued and was removed — a queued pair's knob un-queued it
  // (found by seam L8, driving a queued card's knobs beside a baked card's).
  if (toKey === fromKey) return state;
  if (state.bakes.some((b) => bakeKey(b) === toKey)) return removeBake(state, from);
  return { ...state, bakes: state.bakes.map((b) => (bakeKey(b) === fromKey ? to : b)) };
}

export interface PickerCardProps {
  family: "scatter" | "geographic";
  numericColumns: readonly string[];
  pending: PendingState;
  onPendingChange: (next: PendingState) => void;
  onCancel: () => void;
}

/** A pair being picked: dashed (nothing exists yet), two column selects. The moment both
 *  are chosen and differ, the pair is written and the bake queued, and this card is
 *  replaced by the queued entry's own card. */
export function PickerCard(props: PickerCardProps): ReactElement {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const axes = AXES[props.family];
  const name = `New ${axes.noun} layout`;
  const pick = (nextA: string, nextB: string): void => {
    setA(nextA);
    setB(nextB);
    if (nextA !== "" && nextB !== "" && nextA !== nextB) {
      props.onPendingChange(queuePair(props.pending, props.family, nextA, nextB));
      props.onCancel();
    }
  };
  return h(
    "article",
    { className: "layouts-card layouts-card-queued", "aria-label": name },
    h(
      "div",
      { className: "layouts-card-head" },
      pill("queued"),
      h("span", { className: "layouts-card-name" }, name),
      h("button", { type: "button", className: "btn ghost layouts-card-remove", onClick: props.onCancel }, "Remove"),
    ),
    h("p", { className: "layouts-card-meta" }, `${props.family} · pick its two columns`),
    h(
      "div",
      { className: "layouts-pair" },
      h("label", { className: "layouts-pair-field" }, h("span", { className: "knob-legend muted" }, axes.a), columnSelect(a, props.numericColumns, `${name} ${axes.a}`, (v) => pick(v, b))),
      h("label", { className: "layouts-pair-field" }, h("span", { className: "knob-legend muted" }, axes.b), columnSelect(b, props.numericColumns, `${name} ${axes.b}`, (v) => pick(a, v))),
    ),
    a !== "" && a === b ? h("p", { className: "error-text" }, "Pick two different columns — one column on both axes plots a line, not a layout.") : null,
    h("p", { className: "muted layouts-card-note" }, "Only numeric columns are listed. Nothing exists on disk yet; removing it costs nothing."),
  );
}

// ---------------------------------------------------------------------------
// A queued entry (dashed) — editable until its bake starts
// ---------------------------------------------------------------------------

export interface QueuedCardProps {
  bake: ResolvedBake;
  pending: PendingState;
  numericColumns: readonly string[];
  onPendingChange: (next: PendingState) => void;
  /** Set when this entry adopts a committed layout's new id (a renamed layout). */
  adopts: string | null;
}

export function QueuedCard(props: QueuedCardProps): ReactElement {
  const { bake, pending } = props;
  const entry = bake.entry;
  const name = bake.label;
  const draft = pending.draft;
  const remove = (): void => {
    let next = removeBake(pending, entry);
    // A pair queued FROM this card is dropped with it — the draft keeps no pair nobody
    // asked for. A pair the committed roles already declare stays: it is not this card's.
    if (entry.kind === "new" && draft !== null && pending.seed !== null && (entry.type === "scatter" || entry.type === "geographic")) {
      const seed = pending.seed;
      next = withFamily(entry.type, <P extends PairDraft>(f: PairFamily<P>) => {
        const ours = (p: P): boolean => sameColumns(pairColumns(f, p), entry.source_columns);
        return f.pairs(seed).some(ours) ? next : withDraft(next, f.withPairs(draft, f.pairs(draft).filter((p) => !ours(p))));
      });
    }
    props.onPendingChange(next);
  };

  let body: ReactElement | null = null;
  if (entry.kind === "new" && draft !== null && (entry.type === "scatter" || entry.type === "geographic")) {
    body = withFamily(entry.type, <P extends PairDraft>(f: PairFamily<P>): ReactElement | null => {
      const pairs = f.pairs(draft);
      const i = pairs.findIndex((p) => sameColumns(pairColumns(f, p), entry.source_columns));
      const pair = pairs[i];
      if (pair === undefined) return null;
      const locked = pending.seed !== null && f.pairs(pending.seed).some((p) => sameColumns(f.columns(p), f.columns(pair)));
      const write = (patch: Partial<P>): void => {
        const nextPair = f.patch(pair, patch);
        // `queuePair`'s rule: a pair the draft already declares — committed, or queued by
        // another card — is not declared twice; this card's own pair goes instead (user
        // review #2). Two identical pairs would make the family multi-entry and rename or
        // stale the committed layout.
        const taken = pairs.some((p, j) => j !== i && sameColumns(f.columns(p), f.columns(nextPair)));
        const nextDraft = f.withPairs(draft, taken ? pairs.filter((_, j) => j !== i) : pairs.map((p, j) => (j === i ? nextPair : p)));
        const nextEntry: BakeEntry = { kind: "new", type: f.type, source_columns: pairColumns(f, nextPair) };
        props.onPendingChange(replaceBake(withDraft(pending, nextDraft), entry, nextEntry));
      };
      return pairBody(
        name,
        f.axes,
        f.columns(pair),
        locked,
        props.numericColumns,
        (a, b) => write(f.repoint(a, b)),
        pair.label,
        (label) => write({ label } as Partial<P>),
        locked ? null : pairKnobs(f.knobs, pair, name, write),
      );
    });
  }
  const family = entry.kind === "new" ? entry.type : "re-bake";
  const source = entry.kind === "new" ? entry.source_columns : null;
  return h(
    "article",
    { className: "layouts-card layouts-card-queued", "aria-label": `Queued: ${name}` },
    h(
      "div",
      { className: "layouts-card-head" },
      pill("queued"),
      h("span", { className: "layouts-card-name" }, name),
      h("button", { type: "button", className: "btn ghost layouts-card-remove", onClick: remove }, "Remove"),
    ),
    metaLine(family, source, bake.layout_id !== null ? [`bakes as ${bake.layout_id}`] : []),
    props.adopts !== null
      ? box("info", `Adopts the new name of “${props.adopts}”: its name and its default move to this layout once it lands. Delete the old one afterwards — until you do, both read stale.`)
      : null,
    bake.problem !== null ? box("err", h("strong", null, "Can't bake as queued — "), bake.problem) : null,
    body,
    h("p", { className: "muted layouts-card-note" }, "Nothing exists on disk yet. Removing it costs nothing."),
  );
}

function pairBody(
  name: string,
  axes: { a: string; b: string },
  [a, b]: [string, string],
  locked: boolean,
  numeric: readonly string[],
  onAxes: (a: string, b: string) => void,
  label: string,
  onLabel: (label: string) => void,
  knobs: ReactElement | null,
): ReactElement {
  if (locked) {
    // Its settings are the committed entry's, and since seam L8 those are changed on that
    // layout's baked card; Data has no settings controls (review of #397, round 3, finding 3).
    return box("quiet", `${axes.a} ${a} · ${axes.b} ${b} — this pair is already declared, so its columns and settings are the committed ones. Its settings are changed on its baked card, under Live.`);
  }
  // A column list that no longer carries a picked column still shows it, so a select never
  // silently reads blank.
  const columns = [...new Set([...numeric, a, b].filter((c) => c !== ""))];
  return h(
    "div",
    { className: "layouts-pair-block" },
    h(
      "div",
      { className: "layouts-pair" },
      h("label", { className: "layouts-pair-field" }, h("span", { className: "knob-legend muted" }, axes.a), columnSelect(a, columns, `${name} ${axes.a}`, (v) => onAxes(v, b))),
      h("label", { className: "layouts-pair-field" }, h("span", { className: "knob-legend muted" }, axes.b), columnSelect(b, columns, `${name} ${axes.b}`, (v) => onAxes(a, v))),
      h(
        "label",
        { className: "layouts-pair-field" },
        h("span", { className: "knob-legend muted" }, "Name"),
        h("input", {
          className: "role-label-input",
          value: label,
          placeholder: `${a} / ${b}`,
          "aria-label": `${name} name`,
          onChange: (e: { target: { value: string } }) => onLabel(e.target.value),
        }),
      ),
    ),
    knobs,
  );
}

// ---------------------------------------------------------------------------
// A committed layout (solid)
// ---------------------------------------------------------------------------

export interface LiveCardProps {
  view: DesignerViewProps;
  layout: LayoutInfo;
  /** The bake's own label (the manifest's), under any presentation override. */
  bakeLabel: string;
  outcome: LayoutOutcome | undefined;
  baked: BakedStaleness | undefined;
  fate: LayoutFate;
  /** The live layout that has taken over this one's new id — an ADOPTED rename, whose old
   *  layout is now redundant — or null. */
  supersededBy: string | null;
  isDefault: boolean;
  rebakeQueued: boolean;
  /** The layout a delete job of ours is removing: "deleting", or "waiting" behind the queue. */
  deleting: "deleting" | "waiting" | null;
  /** Why Delete is refused right now, or null when it is offered. */
  deleteBlocked: string | null;
  status: JobStatus | null;
  onDelete: () => void;
}

/** The columns a stale layout reads that moved. */
function staleColumns(layout: LayoutInfo, changed: readonly string[]): string[] {
  const reads = layout.source_columns ?? [];
  const hit = reads.filter((c) => changed.includes(c));
  return hit.length > 0 ? hit : [...reads];
}

// ---------------------------------------------------------------------------
// A baked layout's settings (seam L8) — the committed entry it was baked from, edited
// ---------------------------------------------------------------------------

/** Where a baked scatter or map layout's settings live in the draft, or why they can't be
 *  changed here. */
type BakedPair =
  /** `draftIndex` is its pair in `draft.scatterPairs` / `draft.geoPairs`; `entryIndex` its
   *  committed entry, which is also the SEED's pair at that index (`rolesDraftFromColumnRoles`
   *  maps entries one to one, in order) — undefined when the committed roles declare the pair
   *  more than once and the draft holds one of them. */
  | { kind: "editable"; draftIndex: number; entryIndex: number | undefined }
  | { kind: "readonly"; reason: string }
  /** No roles at all (an images-only collection), so no scatter or map layout exists. */
  | { kind: "none" };

const READONLY_NO_RECORD =
  "Shown as baked, and read-only here: this layout was baked before layouts recorded their columns, so which declaration it was baked from can't be told. Re-baking it records that.";
const READONLY_TWICE =
  "Shown as baked, and read-only here: its pair is declared more than once, and the designer can't commit roles that declare one pair twice. Change them with the CLI (`pixscope set-roles`).";
const READONLY_TWICE_DRAFTED =
  "Shown as baked, and read-only here: your pending roles declare its pair more than once, which can't be committed. Discard puts the roles back.";
const READONLY_NOT_DRAFTED = "Shown as baked, and read-only here: your pending roles no longer declare its pair.";
const READONLY_NOT_COMMITTED =
  "Shown as baked, and read-only here: the committed roles no longer declare the pair it was baked from, so it has no entry of its own to change.";
/** While the layout's own re-bake runs: its settings as `shown` (the committed entry's, or the
 *  bake's own when there is no single committed entry), never the draft's, which the running
 *  bake does not use (review of #397, round 3, finding 4). */
function readonlyRebaking(shown: "committed" | "baked", pendingEdit: boolean): string {
  return (
    `Shown as ${shown}, and read-only while its re-bake is in the running job — a started bake runs to the end. They can be changed once it lands.` +
    (pendingEdit ? " Your pending change to these settings stays in your draft, for your next commit." : "")
  );
}

/** Each draft key a family's knobs write, with its default — walked straight off the knob
 *  list the controls are drawn from, so no second table of keys can miss one. */
function knobKeys<P extends PairDraft>(specs: readonly KnobSpec<P>[]): [keyof P & string, string][] {
  return specs.flatMap((spec) => spec.keys.map((key): [keyof P & string, string] => [key, spec.dflt]));
}

/** Whether two pairs read differently on any knob, defaults filled. */
function knobsDiffer<P extends PairDraft>(specs: readonly KnobSpec<P>[], a: P, b: P): boolean {
  return knobKeys(specs).some(([key, dflt]) => (a[key] ?? dflt) !== (b[key] ?? dflt));
}

/** Which committed entry a baked scatter or map layout was baked from: the ONE entry
 *  declaring its pair, as `pending.ts` `locateEntry` finds it — the same key and the same
 *  exactly-one rule the bar and the review price with (review of #397, round 3, finding 5).
 *
 *  A 2.10 bake record never changes that answer. With one candidate the entry is the
 *  layout's own even when the record no longer matches it — the layout is durably stale, and
 *  its settings are how the owner puts it right. With several, while the draft holds several
 *  too, no edit could be committed: `validateDraft` refuses any draft that declares a pair
 *  twice, so the settings are read-only, with why, however the records tell the entries
 *  apart (review of #397, finding 1 — and two layouts that recorded the SAME fingerprint
 *  would both have edited one entry, a guess).
 *
 *  The editable pair is the draft's ONE pair over these columns. The draft keeps the
 *  committed pairs in their committed order, and no control here adds or drops one (a queued
 *  pair is appended, and a pair already declared is never declared twice — `queuePair`), so
 *  any other count comes from another writer's draft, and says so. */
function bakedPair(layout: LayoutInfo, pending: PendingState): BakedPair {
  const { committed, draft } = pending;
  const sources = layout.source_columns;
  if (committed === null || draft === null) return { kind: "none" };
  if (!Array.isArray(sources) || sources.length === 0) return { kind: "readonly", reason: READONLY_NO_RECORD };
  const located = locateEntry(committed, layout.type, sources);
  const drafted = withFamily(layout.type, <P extends PairDraft>(f: PairFamily<P>) => f.pairs(draft).map((p) => pairColumns(f, p)));
  const inDraft = drafted.flatMap((columns, i) => (sameColumns(columns, sources) ? [i] : []));
  // ONE pair over its columns in the draft, and a committed one behind it, is this layout's —
  // also where the committed roles declared it twice and the draft dropped a duplicate: the
  // draft is valid again, and one pair is no guess. Its committed form, for a put-back, is the
  // committed entry when there is exactly one. Every other shape says why it is read-only;
  // none makes the settings vanish (review of #397, round 3, finding 2).
  if (located.candidates > 0 && inDraft.length === 1) return { kind: "editable", draftIndex: inDraft[0], entryIndex: located.index };
  if (located.candidates === 0) return { kind: "readonly", reason: READONLY_NOT_COMMITTED };
  if (inDraft.length === 0) return { kind: "readonly", reason: READONLY_NOT_DRAFTED };
  return { kind: "readonly", reason: located.candidates > 1 ? READONLY_TWICE : READONLY_TWICE_DRAFTED };
}

/** A knob put back to its COMMITTED value takes the committed form too — declared or absent —
 *  so an edit undone leaves no difference behind in the draft (brief §2a). `knob` writes a
 *  default as absent, and a CLI-authored entry can declare the default explicitly. With no
 *  single committed entry to return to, the patch stands as written. The keys are the
 *  family's knob list's own (`knobKeys`). */
function asCommitted<P extends PairDraft>(specs: readonly KnobSpec<P>[], next: P, committed: P | undefined): P {
  if (committed === undefined) return next;
  const out = { ...next };
  for (const [key, dflt] of knobKeys(specs)) {
    if ((next[key] ?? dflt) !== (committed[key] ?? dflt)) continue;
    if (committed[key] === undefined) delete out[key];
    else out[key] = committed[key];
  }
  return out;
}

/** A baked scatter or map layout's settings: the queued card's own controls (`pairKnobs`, on
 *  its family's knob list), on the committed entry it was baked from. An edit writes the DRAFT and nothing
 *  else — a knob-only patch, which never repoints an axis (so `patchScatterPair` keeps the
 *  pair) — and the card, the bar and the review then read what `derivePending` derives from
 *  it: this layout stale, its id unchanged, its re-bake pre-ticked (D-xxix).
 *
 *  Editable until its own re-bake starts, as a queued card is until its bake starts: while
 *  the running job holds it (`layout.rebake`), the settings are disabled, with why, and show
 *  the COMMITTED values, not the draft's, which the running bake does not use (review of
 *  #397, finding 3; round 3, finding 4). */
function BakedSettings(props: { view: DesignerViewProps; layout: LayoutInfo }): ReactElement | null {
  const { view, layout } = props;
  const { pending } = view;
  const draft = pending.draft;
  const seed = pending.seed;
  const where = bakedPair(layout, pending);
  if (where.kind === "none" || draft === null || seed === null) return null;
  const name = layout.label;
  return withFamily(layout.type, <P extends PairDraft>(f: PairFamily<P>): ReactElement => {
    // What it was baked with — the manifest's options echo — where no single entry is its own.
    const asBaked = (a: string, b: string, label: string): P => ({ ...f.make(a, b, label), ...((layout.options ?? {}) as Partial<P>) });
    let shown: P;
    let reason: string | null = null;
    // Only an editable card writes; a disabled control writes nothing, whatever event reaches it.
    let write: ((patch: Partial<P>) => void) | null = null;
    if (where.kind === "readonly") {
      shown = asBaked("", "", "");
      reason = where.reason;
    } else {
      const pairs = f.pairs(draft);
      const pair = pairs[where.draftIndex];
      const committed = where.entryIndex !== undefined ? f.pairs(seed)[where.entryIndex] : undefined;
      if (layout.rebake != null) {
        const [a, b] = f.columns(pair);
        shown = committed ?? asBaked(a, b, pair.label);
        reason = readonlyRebaking(committed !== undefined ? "committed" : "baked", knobsDiffer(f.knobs, pair, shown));
      } else {
        shown = pair;
        write = (patch) => {
          const next = asCommitted(f.knobs, f.patch(pair, patch), committed);
          view.onPendingChange(withDraft(pending, f.withPairs(draft, pairs.map((p, i) => (i === where.draftIndex ? next : p)))));
        };
      }
    }
    return h(
      "div",
      { className: "layouts-pair-block", role: "group", "aria-label": `${name} settings` },
      pairKnobs(f.knobs, shown, name, write ?? (() => {}), write === null),
      reason !== null
        ? box("quiet", reason)
        : // True both ways: an edit AWAY from what it was baked with stales it, and one back to
          // it — a durably stale layout's — un-stales it (review of #397, finding 5).
          h("p", { className: "muted layouts-card-note" }, "A setting other than the one it was baked with stales this layout until it is re-baked. Nothing starts until you commit it in the review."),
    );
  });
}

export function LiveCard(props: LiveCardProps): ReactElement {
  const { view, layout, outcome, baked, fate } = props;
  const id = layout.layout_id;
  const pendingStale = outcome?.stale === true;
  const durableStale = baked !== undefined && baked.staleColumns.length > 0;
  const unknown = outcome?.unknown === true;
  // Grid reads no column by construction, so its answer is certain whatever its record
  // says: a pre-2.9 grid records no provenance, which `derived.baked` reads as unchecked,
  // and offering "Re-bake to check" for it would sell a bake that cannot change anything.
  const unchecked = layout.type !== "grid" && (unknown || (baked !== undefined && !baked.checkable));
  const orphaned = outcome?.orphaned === true || (outcome === undefined && fate.kind === "orphaned");
  const renamedTo = outcome?.renamedTo ?? (fate.kind === "renamed" ? fate.to : null);
  const rebaking = layout.rebake ?? null;

  let kind: Pill = "baked";
  if (props.deleting !== null) kind = props.deleting;
  else if (rebaking === "baking") kind = "baking";
  else if (orphaned) kind = "orphaned";
  else if (pendingStale || durableStale) kind = "stale";
  else if (unchecked) kind = "unchecked";

  const classes = ["layouts-card"];
  if (props.deleting !== null) classes.push("layouts-card-deleting");
  else if (rebaking === "baking") classes.push("layouts-card-baking");
  else if (orphaned) classes.push("layouts-card-orphaned");
  else if (kind === "stale") classes.push("layouts-card-stale");

  const queueRebake = (): void => view.onPendingChange(addBake(view.pending, { kind: "rebake", layout_id: id }));
  const unqueueRebake = (): void => view.onPendingChange(removeBake(view.pending, { kind: "rebake", layout_id: id }));
  const canRebake = fate.kind === "produced" && props.deleting === null && rebaking === null;

  const boxes: ReactElement[] = [];
  if (props.deleting === "waiting") {
    boxes.push(box("quiet", "Waiting for the worker: another job — possibly another collection's bake — has it, and this delete starts when that finishes. Until then it keeps serving, and this collection takes no other change."));
  } else if (props.deleting === "deleting") {
    boxes.push(box("quiet", "Still on disk and still serving until the job lands — seconds of work, run as a job."));
  }
  // A pre-2.10 bake records no fingerprint, so the prediction ("this change stales it", from
  // its provenance) cannot be confirmed against the bake. Said in ONE box rather than a
  // "stales it" box beside a "can't tell" box (review of #385, R3b).
  const unconfirmed = pendingStale && !unknown && baked !== undefined && !baked.checkable;
  if (pendingStale) {
    const cols = staleColumns(layout, view.derived.changedColumns);
    boxes.push(
      box(
        "warn",
        h("span", { className: "layouts-mono" }, cols.join(", ")),
        unconfirmed
          ? " — your pending change stales it, if its tiles matched the roles as committed; its bake predates the record of how it read its columns, so that can't be confirmed. It keeps serving unchanged until you re-bake it."
          : " — your pending change stales it: its tiles no longer match what you declared. It keeps serving unchanged until you re-bake it.",
      ),
    );
  }
  if (durableStale) {
    boxes.push(
      box(
        "warn",
        h("span", { className: "layouts-mono" }, baked.staleColumns.join(", ")),
        " changed since this layout was baked. Serving unchanged until re-baked.",
      ),
    );
  }
  if (orphaned) {
    const reads = layout.source_columns ?? [];
    boxes.push(
      reads.length > 0
        ? box(
            "err",
            h("span", { className: "layouts-mono" }, reads.join(", ")),
            " no longer carry the role it was baked from. Serving unchanged; nothing can rebuild it — delete it, or restore the role.",
          )
        : box(
            "err",
            // Not "which role it lost": with no provenance, a lost role and a renamed family
            // look the same (review of #385, R3a).
            "The roles no longer produce this layout under its id. It was baked before layouts recorded their columns, so whether its family was renamed or it lost its role can't be told. Serving unchanged; it can't be re-baked in place.",
          ),
    );
  } else if (props.supersededBy !== null) {
    // Adopting a rename is a bake under the new id, then a delete of the old one; the
    // bake has landed. Until the delete, the two share one declared entry, so both read
    // stale (the duplicate rule, CONTRACT §4).
    boxes.push(
      box(
        "warn",
        "Superseded: its re-bake landed as ",
        h("span", { className: "layouts-mono" }, props.supersededBy),
        ", which carries its name and default now. Delete this one — until you do, both read stale.",
      ),
    );
  } else if (renamedTo !== null) {
    boxes.push(box("info", `Nothing is wrong: its next bake files it as `, h("span", { className: "layouts-mono" }, renamedTo), ` — its name and default go with it. No action needed.`));
  }
  if (unchecked && !orphaned && !unconfirmed) {
    const when = layout.committed_at != null ? `Baked ${layout.committed_at.slice(0, 10)}, before` : "Baked before";
    boxes.push(
      box(
        "quiet",
        unknown
          ? `${when} layouts recorded their columns, so Plotlas can't tell whether this change affects it. It is not marked stale — that would be a guess.`
          : `${when} layouts recorded how they read their columns, so Plotlas can't tell whether it still matches the roles. Re-bake once to make it checkable.`,
      ),
    );
  }
  if (rebaking === "baking") {
    boxes.push(progressBar(props.status, id));
    boxes.push(h("p", { key: "nocancel", className: "muted layouts-card-note" }, "No cancel — the bake has started, and a started bake runs to the end. The current tiles keep serving until the new ones land."));
  } else if (rebaking === "queued") {
    boxes.push(h("p", { key: "rq", className: "muted layouts-card-note" }, "Re-bake queued in the running job — it keeps serving until the new tiles land."));
  }

  const actions: ReactElement[] = [];
  if (props.rebakeQueued) {
    actions.push(pill("rebake"));
    actions.push(h("button", { key: "unq", type: "button", className: "btn ghost", onClick: unqueueRebake }, "Remove from queue"));
  } else if (canRebake && (kind === "stale" || kind === "unchecked")) {
    actions.push(
      h("button", { key: "rb", type: "button", className: "btn", onClick: queueRebake }, kind === "unchecked" ? "Re-bake to check" : "Re-bake"),
    );
  }
  if (orphaned) {
    actions.push(h("button", { key: "restore", type: "button", className: "btn ghost", onClick: () => view.onNavigate("data") }, "Restore role"));
  }

  const options = describeBakedOptions(layout.type, (layout.options ?? undefined) as LayoutOptions | undefined);
  return h(
    "article",
    { className: classes.join(" "), "aria-label": layout.label, "data-state": kind },
    h(
      "div",
      { className: "layouts-card-head" },
      pill(kind),
      h(LayoutName, { view, layout, bakeLabel: props.bakeLabel, locked: props.deleting !== null }),
      props.isDefault ? h("span", { className: "layouts-default" }, "★ Default") : null,
    ),
    metaLine(layout.type, layout.source_columns, [
      ...(layout.committed_at != null ? [`baked ${layout.committed_at.slice(0, 10)}`] : []),
      ...(options !== null ? [options] : []),
    ]),
    ...boxes,
    // Its settings, unless it is going away, nothing can re-bake it (orphaned: a setting would
    // price a bake that cannot run — review of #397, finding 2), or it is superseded: its
    // entry is its successor's now, and an edit here would stale that layout (round 3,
    // finding 1). Its box says so. Its source columns are never offered: a new pair is a new
    // layout, which is what Add is for.
    props.deleting === null && !orphaned && props.supersededBy === null && (layout.type === "scatter" || layout.type === "geographic")
      ? h(BakedSettings, { view, layout })
      : null,
    h(
      "div",
      { className: "layouts-card-actions" },
      ...actions,
      props.deleting === null && !props.isDefault ? h(MakeDefault, { view, layoutId: id }) : null,
      props.deleting === null
        ? h(
            "button",
            {
              type: "button",
              className: "link-btn layouts-card-delete",
              disabled: props.deleteBlocked !== null,
              title: props.deleteBlocked ?? undefined,
              onClick: props.onDelete,
            },
            "Delete…",
          )
        : null,
    ),
    props.deleting === null && props.deleteBlocked !== null ? h("p", { className: "muted layouts-card-note layouts-delete-reason" }, props.deleteBlocked) : null,
  );
}

// ---------------------------------------------------------------------------
// Free edits — PATCH as typed, never the bar (D-xx)
// ---------------------------------------------------------------------------

function withLayoutLabel(presentation: Presentation, id: string, label: string | null): Presentation {
  const layouts = { ...(presentation.layouts ?? {}) };
  if (label === null) delete layouts[id];
  else layouts[id] = { ...(layouts[id] ?? {}), label };
  return { ...presentation, layouts };
}

function LayoutName(props: { view: DesignerViewProps; layout: LayoutInfo; bakeLabel: string; locked: boolean }): ReactElement {
  const { view, layout } = props;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(layout.label);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(view);
  latest.current = view;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);
  /** The label on the wire: a second save of the same value is not sent while it is. */
  const sent = useRef<{ value: string | null } | null>(null);
  const typed = useRef(value);
  typed.current = value;

  async function save(): Promise<void> {
    clearTimeout(timer.current);
    const now = latest.current;
    const trimmed = typed.current.trim();
    // Blank, or the bake's own label, clears the override (the bake's label shows again).
    const override = trimmed === "" || trimmed === props.bakeLabel ? null : trimmed;
    const stored = now.presentation.layouts?.[layout.layout_id]?.label ?? null;
    if (override === stored) {
      setState("idle");
      return;
    }
    // Enter saves, and a browser that fires blur as the input goes away saves again —
    // before the first PATCH has come back, so `stored` still reads the old label and the
    // same write would go twice (user review #7). One write per value.
    if (sent.current !== null && sent.current.value === override) return;
    const mine = { value: override };
    sent.current = mine;
    const n = (seq.current += 1);
    setState("saving");
    try {
      await now.client.setDatasetPresentation(now.dataset.dataset_id, { layouts: { [layout.layout_id]: { label: override } } });
      if (seq.current !== n) return;
      latest.current.onPresentationChange(withLayoutLabel(latest.current.presentation, layout.layout_id, override));
      setState("saved");
      setError(null);
    } catch (err) {
      if ((err as { status?: unknown }).status === 401) {
        latest.current.onAuthExpired();
        return;
      }
      if (seq.current !== n) return;
      setState("error");
      setError(errText(err));
    } finally {
      // The guard covers the write IN FLIGHT, and only that. Once it has settled, a success
      // is in `stored` and a failure may be tried again — so the same label typed later,
      // after another tab cleared it, is a new write, not a silent no-op (verification of
      // #385, round 3, N4). `mine`, not the value: a later save may be on the wire now.
      if (sent.current === mine) sent.current = null;
    }
  }

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!editing) {
    return h(
      "span",
      { className: "layouts-card-name" },
      layout.label,
      state === "saved" ? h("span", { className: "designer-field-status designer-saved" }, " saved") : null,
      props.locked
        ? null
        : h(
            "button",
            {
              type: "button",
              className: "link-btn layouts-rename",
              "aria-label": `Rename ${layout.label}`,
              onClick: () => {
                setValue(layout.label);
                setEditing(true);
              },
            },
            "Rename",
          ),
    );
  }
  return h(
    "span",
    { className: "layouts-card-name" },
    h("input", {
      className: "layouts-rename-input",
      value,
      autoFocus: true,
      placeholder: props.bakeLabel,
      "aria-label": `Name for ${layout.layout_id}`,
      "aria-invalid": state === "error" ? "true" : undefined,
      onChange: (e: { target: { value: string } }) => {
        setValue(e.target.value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void save(), SAVE_PAUSE_MS);
      },
      onKeyDown: (e: { key: string }) => {
        if (e.key === "Enter") {
          void save();
          setEditing(false);
        }
      },
      onBlur: () => {
        void save();
        setEditing(false);
      },
    }),
    state === "saving" ? h("span", { className: "designer-field-status" }, "Saving…") : null,
    error !== null ? h("span", { className: "error-text", role: "alert" }, error) : null,
  );
}

function MakeDefault(props: { view: DesignerViewProps; layoutId: string }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(props.view);
  latest.current = props.view;
  async function make(): Promise<void> {
    setBusy(true);
    try {
      const now = latest.current;
      await now.client.setDatasetPresentation(now.dataset.dataset_id, { default_layout: props.layoutId });
      const after = latest.current;
      after.onPresentationChange({ ...after.presentation, dataset: { ...(after.presentation.dataset ?? {}), default_layout: props.layoutId } });
      setError(null);
    } catch (err) {
      if ((err as { status?: unknown }).status === 401) {
        latest.current.onAuthExpired();
        return;
      }
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return h(
    "span",
    { className: "layouts-make-default" },
    h("button", { type: "button", className: "btn ghost", disabled: busy, onClick: () => void make() }, "Make default"),
    error !== null ? h("span", { className: "error-text", role: "alert" }, error) : null,
  );
}

// ---------------------------------------------------------------------------
// A layout in flight that is not on disk yet
// ---------------------------------------------------------------------------

export interface InFlightCardProps {
  layout: LayoutInfo;
  /** What the job will bake it as, when this designer started the job. */
  predicted: { label: string; type: string; source_columns: string[] | null } | null;
  /** A bare FAMILY spec the job expands into several layouts ([[T2-a-family-spec-is-reported-under-the-family-name]]). */
  familySpec: boolean;
  status: JobStatus | null;
}

export function InFlightCard(props: InFlightCardProps): ReactElement {
  const { layout, predicted } = props;
  const baking = layout.state === "baking";
  if (props.familySpec) {
    // Not a layout: a request for every layout of a family, named by the family until each
    // one's own stage starts. Presented as what it is.
    return h(
      "article",
      { className: "layouts-card layouts-card-queued", "aria-label": `In this run: every ${layout.layout_id} layout` },
      h("div", { className: "layouts-card-head" }, pill(baking ? "baking" : "queued"), h("span", { className: "layouts-card-name" }, `Every ${layout.layout_id} layout its roles declare`)),
      h("p", { className: "muted layouts-card-note" }, "This run was asked for the whole family. Each layout appears here under its own name when its bake starts."),
    );
  }
  const name = layout.label !== layout.layout_id ? layout.label : predicted?.label ?? layout.layout_id;
  return h(
    "article",
    { className: baking ? "layouts-card layouts-card-baking" : "layouts-card layouts-card-queued", "aria-label": name, "data-state": baking ? "baking" : "queued" },
    h("div", { className: "layouts-card-head" }, pill(baking ? "baking" : "queued"), h("span", { className: "layouts-card-name" }, name)),
    metaLine(predicted?.type ?? layout.type, predicted?.source_columns ?? layout.source_columns, [`bakes as ${layout.layout_id}`]),
    baking ? progressBar(props.status, layout.layout_id) : null,
    h(
      "p",
      { className: "muted layouts-card-note" },
      baking
        ? "No cancel — the bake has started, and a started bake runs to the end. It appears in the atlas the moment it commits."
        : "In the running job, waiting for its turn. It appears in the atlas the moment its own bake commits.",
    ),
  );
}

// ---------------------------------------------------------------------------
// A family the data cannot support (yet)
// ---------------------------------------------------------------------------

export function UnavailableCard(props: { family: string; action: string; reason: string }): ReactElement {
  return h(
    "div",
    { className: "layouts-unavailable", "aria-label": `${props.action} — unavailable` },
    h("span", { className: "layouts-unavailable-family" }, props.family),
    h("span", { className: "layouts-unavailable-action" }, props.action, h("span", { "aria-hidden": "true" }, " 🔒")),
    h("span", { className: "layouts-unavailable-reason" }, props.reason),
  );
}
