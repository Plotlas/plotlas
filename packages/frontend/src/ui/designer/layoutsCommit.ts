// The layout designer's COMMIT (seam L5 §2d; LAYOUT_DESIGNER D-xxi, D-xxix; CONTRACT §8):
// how everything pending becomes EXACTLY ONE job, what refuses to become one, what the
// commit predicts, and how the worker's report is read back against that prediction.
//
// The review sheet (`layouts.ts` `CommitReview`) renders this; this module decides. It is
// the part with no second chance — a commit that silently drops a role, or starts two
// jobs, cannot be taken back from the screen — so every rule is here, pure and
// node-testable, and none of it lives in a click handler.
//
//   roles changed, nothing to bake  → ONE `setColumnRoles(derived.roles)`         (202 + job)
//   anything to bake                → ONE `addLayouts({layout_specs, replace,
//                                        column_roles?})` — the roles ride with the
//                                        bake and land at its first layout's flip
//   anything else                   → nothing is sent
//
// Never two calls: the API refuses a second job while one is in flight, so a sequence of
// two could only be completed by a client that stayed open for hours.
//
// Pure: no React, no fetch. Storage access is injectable and guarded, as in pending.ts.
import type { AddLayoutsRequest, JobStatus, LayoutInfo } from "../../api-client/types";
import type { ColumnRoles } from "../../generated/column_roles";
import type { Presentation } from "../../generated/presentation";
import { rolesDraftFromColumnRoles, producibleLayouts } from "../admin/roles";
import type { KeyValueStore } from "../admin/uploadSession";
import { DEFAULT_NORMALIZE, DEFAULT_OVERLAP, DEFAULT_PROJECTION, DEFAULT_SCALE } from "../layoutOptions";
import { heldRoleConflicts, roleWord } from "./heldRoles";
import { bakedFor, bakeKey, canonicalJson, derivePending } from "./pending";
import type { BakeEntry, BakeFamily, PendingDerivation, PendingState, ResolvedBake } from "./pending";

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const BAKE_FAMILIES: readonly string[] = ["datetime", "categorical", "scatter", "geographic"];

export function isBakeFamily(type: string): type is BakeFamily {
  return BAKE_FAMILIES.includes(type);
}

/** A committed row: in the manifest. Absent `state` is an old server's committed row. */
export function isLive(layout: LayoutInfo): boolean {
  return (layout.state ?? "live") === "live";
}

/** The label a layout id goes by in `layouts`, else the id itself. */
function labelOf(layouts: readonly LayoutInfo[], id: string): string {
  return layouts.find((l) => l.layout_id === id)?.label ?? id;
}

function quoted(labels: string[]): string {
  return labels.map((l) => `“${l}”`).join(", ");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The refusal the draft forces: a column with two roles
// ---------------------------------------------------------------------------

// WHICH columns, and the words for their roles, are `heldRoles.ts`'s — the rule and the
// words the Data row flags them with (D-xxxi).

// ---------------------------------------------------------------------------
// What the working roles do to a committed layout's id
// ---------------------------------------------------------------------------

/** What the WORKING roles do to a committed layout's id:
 *    produced — it re-bakes under its own id;
 *    renamed  — the same family and the same whole source tuple now bake under `to`
 *               (its family crossed one entry), so its next bake files it there;
 *    orphaned — nothing produces it. */
export type LayoutFate = { kind: "produced" } | { kind: "renamed"; to: string } | { kind: "orphaned" };

function probe(pending: PendingState, layouts: readonly LayoutInfo[], entry: BakeEntry): ResolvedBake {
  return derivePending({ ...pending, bakes: [entry] }, layouts).bakes[0];
}

/** `layoutFate`, answered by pending.ts's OWN resolution — a probe bake — so no naming rule
 *  is transcribed here a second time. Unlike `outcomes[].renamedTo` this answers with
 *  nothing edited too, which is what the card needs after a roles-only commit: the rename
 *  is then a fact about the committed roles, not about a pending edit. */
export function layoutFate(pending: PendingState, layouts: readonly LayoutInfo[], layout: LayoutInfo): LayoutFate {
  if (layout.type === "grid" || pending.draft === null) return { kind: "produced" };
  // With nothing edited the probe answers for the COMMITTED roles, not the seed: on a
  // collection that gives a column two roles the seed keeps one, and a fate read through it
  // called By date orphaned and Bucket renamed to bare `categorical` (verification of #385,
  // round 3, N3). pending.ts names queued bakes from the committed roles then
  // (`bakeNamingDraft`), so a fate the committed roles themselves imply — a second pair that
  // renames `scatter`, a role a roles-only commit took away — still reads as one.
  if (probe(pending, layouts, { kind: "rebake", layout_id: layout.layout_id }).problem === null) {
    return { kind: "produced" };
  }
  const sources = layout.source_columns;
  if (!isBakeFamily(layout.type) || !Array.isArray(sources) || sources.length === 0) return { kind: "orphaned" };
  const next = probe(pending, layouts, { kind: "new", type: layout.type, source_columns: sources });
  if (next.layout_id !== null && next.layout_id !== layout.layout_id) return { kind: "renamed", to: next.layout_id };
  return { kind: "orphaned" };
}

// ---------------------------------------------------------------------------
// D-xxix: the re-bakes the review pre-queues
// ---------------------------------------------------------------------------

export interface PreQueue {
  /** Newly staled by THIS edit, checkable, and re-bakeable under its own id: pre-ticked. */
  ticked: string[];
  /** Affected but UNCHECKED — `unknown`, or a bake record with no fingerprint. Never
   *  pre-queued: its answer is not knowable, so a re-bake is the user's call. */
  unchecked: string[];
  /** Newly staled, but this run cannot re-bake it under its own id. */
  cannot: { layout_id: string; reason: string }[];
}

/** Which re-bakes the review pre-queues (D-xxix, O-8 = C): every layout the pending change
 *  NEWLY stales (`outcomes[].stale` — an earlier commit's staleness is not this edit's to
 *  re-queue), ticked, unless it is unchecked or already queued. */
export function preQueue(pending: PendingState, derived: PendingDerivation): PreQueue {
  const queued = new Set(pending.bakes.map(bakeKey));
  const out: PreQueue = { ticked: [], unchecked: [], cannot: [] };
  for (const o of derived.outcomes) {
    if (queued.has(bakeKey({ kind: "rebake", layout_id: o.layout_id }))) continue;
    if (o.orphaned) {
      // Only a STALE orphan is listed: a pre-2.9 one (orphaned and unknown) is not known
      // to be stale, and the review already says it cannot be rebuilt.
      if (o.stale) {
        out.cannot.push({ layout_id: o.layout_id, reason: "nothing produces it any more — delete it, or restore the role in Data" });
      }
      continue;
    }
    if (o.renamedTo !== null) {
      if (o.stale) {
        out.cannot.push({ layout_id: o.layout_id, reason: `its next bake files it as ${o.renamedTo}, a new layout — queue that from Add` });
      }
      continue;
    }
    const unchecked = o.unknown || bakedFor(derived, o.layout_id)?.checkable === false;
    if (unchecked) out.unchecked.push(o.layout_id);
    else if (o.stale) out.ticked.push(o.layout_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The worker's knob guard, transcribed
// ---------------------------------------------------------------------------

/** A committed scatter/geographic layout whose pair a roles override re-describes without
 *  re-baking it. */
export interface KnobConflict {
  layout_id: string;
  family: "scatter" | "geographic";
  columns: [string, string];
  /** The pair is declared once in the committed roles and once in `next`, so it is
   *  `layout_id`'s OWN settings that changed. False on a pair declared more than once: the
   *  comparison is against the pair's last committed entry, so `layout_id` may be unchanged
   *  and must not be offered a re-bake as the way out (review of #392, finding 1). */
  exact: boolean;
}

type ScatterEntry = NonNullable<ColumnRoles["scatter"]>[number];
type GeoEntry = NonNullable<ColumnRoles["geographic"]>[number];

function scatterKnobs(e: ScatterEntry): string {
  return JSON.stringify([e.x_scale ?? DEFAULT_SCALE, e.y_scale ?? DEFAULT_SCALE, e.normalize ?? DEFAULT_NORMALIZE, e.overlap ?? DEFAULT_OVERLAP]);
}

function geoKnobs(e: GeoEntry): string {
  return JSON.stringify([e.projection ?? DEFAULT_PROJECTION, e.overlap ?? DEFAULT_OVERLAP]);
}

/** Whether a committed layout records `source_fingerprint` (manifest 2.10) — the
 *  `isinstance(..., dict)` test `worker._fingerprinted_layout_ids` applies. The API passes a
 *  dict through and anything else as null, so on this side an object is a record. */
export function recordsFingerprint(layout: LayoutInfo): boolean {
  const recorded = layout.source_fingerprint;
  return typeof recorded === "object" && recorded !== null && !Array.isArray(recorded);
}

/** `worker._guard_no_stale_scatter_config` + `_guard_no_stale_geographic_config`: an
 *  add-layouts run that carries a roles override REFUSES — before any tile is baked — when
 *  the override changes the knobs of a committed pair (matched by its column PAIR, the id
 *  being unstable across a family's one→many rename) whose layout the run does not replace,
 *  AND that layout records no fingerprint (`fingerprinted` lacks it — baked before manifest
 *  2.10). Nothing could then say its manifest contradicts the positions it serves.
 *
 *  A layout that records one says so itself, durably, so since D-xxx the worker lets the run
 *  through and the layout reads stale afterwards — as a roles-only commit (`run_set_roles`)
 *  always has, which is what D-xxix's "untick it and it stays stale" relies on. So on an older
 *  collection an unticked knob change is legal ALONE and refused beside a bake — the
 *  composition below refuses it up front, with the way out, rather than send a job that is
 *  certain to fail.
 *
 *  The worker's rule, exactly, and held to it by the vector both suites read
 *  (tests/designer_fixture/knob_guard_cases.json): with several committed layouts of a family
 *  on one pair, it refuses when ANY of them records no fingerprint and names that one (the
 *  last, when several do), while the knobs still compare against the pair's last entry —
 *  so on such a pair the one named may be unchanged, and `exact` is false.
 *  Knobs compare with their defaults filled, as `ColumnRoles.from_config` fills them. */
export function knobConflicts(
  committed: ColumnRoles | null,
  next: ColumnRoles | null,
  committedIds: ReadonlySet<string>,
  replace: ReadonlySet<string>,
  fingerprinted: ReadonlySet<string>,
): KnobConflict[] {
  if (committed === null || next === null) return [];
  const ids = producibleLayouts(rolesDraftFromColumnRoles(committed));
  const scatterIds = ids.filter((p) => p.type === "scatter").map((p) => p.layout_id);
  const geoIds = ids.filter((p) => p.type === "geographic").map((p) => p.layout_id);
  const guarded = new Set([...committedIds].filter((id) => !replace.has(id)));
  return [
    ...familyConflicts(
      "scatter",
      (committed.scatter ?? []).map((e, i) => [scatterIds[i], [e.x_column, e.y_column], scatterKnobs(e)]),
      (next.scatter ?? []).map((e) => [[e.x_column, e.y_column], scatterKnobs(e)]),
      guarded,
      fingerprinted,
    ),
    ...familyConflicts(
      "geographic",
      (committed.geographic ?? []).map((e, i) => [geoIds[i], [e.lon_column, e.lat_column], geoKnobs(e)]),
      (next.geographic ?? []).map((e) => [[e.lon_column, e.lat_column], geoKnobs(e)]),
      guarded,
      fingerprinted,
    ),
  ];
}

/** One family's half of `knobConflicts` — `worker._unfingerprinted_knob_change`, transcribed
 *  so that both families share it, as the worker's two guards do. `committed` is
 *  `[layout id, pair, knobs]` per committed role entry in declaration order (the id the
 *  committed roles give it; undefined past the end of what they produce), `next` is
 *  `[pair, knobs]` per override entry, `guarded` the committed layouts the run does NOT
 *  re-bake. Per pair ONE map entry: the knobs to compare against (the pair's LAST committed
 *  entry) and the layout to name (the last on the pair that records no fingerprint), null
 *  when every one records a fingerprint. `exact` as the worker computes it: the pair
 *  declared once on each side. */
function familyConflicts(
  family: KnobConflict["family"],
  committed: readonly [string | undefined, [string, string], string][],
  next: readonly [[string, string], string][],
  guarded: ReadonlySet<string>,
  fingerprinted: ReadonlySet<string>,
): KnobConflict[] {
  const onPair = new Map<string, [knobs: string, unchecked: string | null]>();
  for (const [id, pair, knobs] of committed) {
    if (id === undefined || !guarded.has(id)) continue;
    const key = JSON.stringify(pair);
    const [, unchecked] = onPair.get(key) ?? ["", null];
    onPair.set(key, [knobs, fingerprinted.has(id) ? unchecked : id]);
  }
  const declared = (pairs: [string, string][], key: string): number => pairs.filter((p) => JSON.stringify(p) === key).length;
  const out: KnobConflict[] = [];
  for (const [pair, knobs] of next) {
    const key = JSON.stringify(pair);
    const [committedKnobs, unchecked] = onPair.get(key) ?? ["", null];
    if (unchecked === null) continue; // nothing committed on the pair, or every layout on it reports itself
    if (knobs !== committedKnobs) {
      const exact = declared(committed.map(([, p]) => p), key) === 1 && declared(next.map(([p]) => p), key) === 1;
      out.push({ layout_id: unchecked, family, columns: pair, exact });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Composition — one commit, one job
// ---------------------------------------------------------------------------

/** One layout the commit bakes, as predicted. */
export interface PredictedBake {
  layout_id: string;
  label: string;
  /** The family, or "" when the list does not say. */
  type: string;
  source_columns: string[] | null;
  /** A re-bake of a committed layout (named in `replace`), not an addition. */
  replace: boolean;
}

/** What the commit predicts — kept so the worker's report can be read against it. */
export interface Prediction {
  changedColumns: string[];
  stale: string[];
  renamed: Record<string, string>;
  orphaned: string[];
  unknown: string[];
  unservedTags: string[];
  bakes: PredictedBake[];
}

/** Every plan carries the bakes it resolved, so a caller that also lists them (the review)
 *  reuses them instead of resolving the model a second time (user review #8). */
export type CommitPlan =
  | { kind: "refused"; reasons: string[]; bakes: ResolvedBake[] }
  | { kind: "empty"; bakes: ResolvedBake[] }
  | { kind: "roles"; roles: ColumnRoles; prediction: Prediction; bakes: ResolvedBake[] }
  | { kind: "bake"; request: AddLayoutsRequest; prediction: Prediction; bakes: ResolvedBake[] };

export interface ComposeInput {
  pending: PendingState;
  derived: PendingDerivation;
  /** `GET .../layouts?include_pending=true`, labels effective. */
  layouts: readonly LayoutInfo[];
  /** Re-bakes the REVIEW adds to the queued ones: pre-queued ones left ticked, and
   *  unchecked ones the user opted into. */
  extraRebakes: readonly string[];
  /** Why no job can start now (one is already in flight on this collection), or null. */
  busy: string | null;
}

/** Whether posting `derived.roles` would change the committed map. Any difference counts —
 *  a role label as well as a role — because whatever the draft holds is discarded once it
 *  is committed, so leaving a difference out of the payload would lose it. With nothing
 *  edited `derived.roles` IS the committed map (pending.ts), so this is false. */
export function rolesChanged(pending: PendingState, derived: PendingDerivation): boolean {
  return derived.roles !== null && canonicalJson(derived.roles) !== canonicalJson(pending.committed);
}

/** The bakes this commit runs: the queued entries, then the review's extra re-bakes, each
 *  resolved by pending.ts exactly as the bar resolves them. */
export function commitBakes(
  input: Pick<ComposeInput, "pending" | "layouts" | "extraRebakes"> & { derived?: PendingDerivation },
): ResolvedBake[] {
  const { pending, layouts } = input;
  const queued = new Set(pending.bakes.map(bakeKey));
  const extras: BakeEntry[] = input.extraRebakes
    .map((layout_id): BakeEntry => ({ kind: "rebake", layout_id }))
    .filter((e) => !queued.has(bakeKey(e)));
  // With nothing added, the model is the one `derived` was derived from — reuse its answer
  // rather than derive it again (user review #8).
  if (extras.length === 0) return input.derived?.bakes ?? derivePending(pending, layouts).bakes;
  return derivePending({ ...pending, bakes: [...pending.bakes, ...extras] }, layouts).bakes;
}

function predict(input: ComposeInput, bakes: ResolvedBake[], replace: ReadonlySet<string>): Prediction {
  const { derived, layouts } = input;
  const renamed: Record<string, string> = {};
  for (const o of derived.outcomes) if (o.renamedTo !== null) renamed[o.layout_id] = o.renamedTo;
  return {
    changedColumns: [...derived.changedColumns],
    stale: derived.outcomes.filter((o) => o.stale).map((o) => o.layout_id),
    renamed,
    orphaned: derived.outcomes.filter((o) => o.orphaned).map((o) => o.layout_id),
    unknown: derived.outcomes.filter((o) => o.unknown).map((o) => o.layout_id),
    unservedTags: [...derived.tags.unservedColumns],
    bakes: bakes.map((b) => {
      const id = b.layout_id ?? "";
      const committed = layouts.find((l) => l.layout_id === id && isLive(l));
      return b.entry.kind === "new"
        ? { layout_id: id, label: b.label, type: b.entry.type, source_columns: [...b.entry.source_columns], replace: false }
        : {
            layout_id: id,
            label: b.label,
            type: committed?.type ?? "",
            source_columns: committed?.source_columns ?? null,
            replace: replace.has(id),
          };
    }),
  };
}

/** Compose the commit. Every reason it cannot be sent is collected, so the review can name
 *  them all at once; any reason means NOTHING is sent. */
export function composeCommit(input: ComposeInput): CommitPlan {
  const { pending, derived, layouts } = input;
  const reasons: string[] = [];
  const changed = rolesChanged(pending, derived);

  // REFUSED OUTRIGHT, not "committed with a warning" — but only a commit that SENDS roles
  // (operator decision 2026-09-25, option A). The draft cannot hold the second role, so the
  // map it compiles has already lost it, and sending that map drops it. A commit that sends
  // no `column_roles` — a re-bake, a new layout from a declared pair — loses nothing: the
  // worker reads the manifest's own roles. Picking a pair edits the draft, so that commit
  // sends roles and is refused. The rule itself is unchanged (`heldRoleConflicts`, the Data
  // row's flag too); what changed is when it is consulted.
  if (changed) {
    for (const [column, { declared, kept, dropped }] of heldRoleConflicts(pending.committed, pending.seed)) {
      reasons.push(
        `“${column}” carries ${declared.map(roleWord).join(" and ")}, and the designer can hold only ${roleWord(kept)} — ` +
          `a role change committed from here would silently drop its ${dropped.map(roleWord).join(" and ")} role. ` +
          "Fix the roles with the CLI (`pixscope set-roles`) until the designer can carry both; a bake that changes no role is not affected.",
      );
    }
  }
  if (input.busy !== null) reasons.push(input.busy);
  if (derived.problem !== null) reasons.push(`The role change is incomplete — ${derived.problem}`);

  const bakes = commitBakes(input);
  for (const b of bakes) {
    if (b.problem !== null) reasons.push(`“${b.label}” can't bake as queued — ${b.problem}.`);
  }

  const committedIds = new Set(layouts.filter(isLive).map((l) => l.layout_id));
  const ids = [...new Set(bakes.map((b) => b.layout_id).filter((id): id is string => id !== null))];
  const replace = new Set(ids.filter((id) => committedIds.has(id)));

  if (bakes.length > 0 && changed) {
    const fingerprinted = new Set(layouts.filter((l) => isLive(l) && recordsFingerprint(l)).map((l) => l.layout_id));
    for (const c of knobConflicts(pending.committed, derived.roles, committedIds, replace, fingerprinted)) {
      const what = c.family === "scatter" ? "scatter settings" : "map settings";
      const label = labelOf(layouts, c.layout_id);
      const columns = c.columns.join(" / ");
      reasons.push(
        c.exact
          ? `This run changes the ${what} of “${label}” (${columns}) without re-baking it. ` +
              "It was baked before layouts recorded how they read their columns, so nothing could show it as out of date afterwards, " +
              "and the worker refuses that before baking anything. " +
              "Re-bake it in this run, or remove the queued bakes and commit the role change on its own first — which leaves it out of date with nothing to say so."
          : // A pair declared more than once: the worker cannot tell whose settings changed,
            // so neither can this, and “re-bake it” could send the user to re-bake a layout
            // that did not change (worker._stale_knob_refusal).
            `This run's ${what} on ${columns} — a pair declared more than once — differ from what is committed there, and “${label}” ` +
              "on that pair was baked before layouts recorded how they read their columns. The worker cannot tell which layout's " +
              `${what} changed, if any, and refuses before baking anything rather than risk leaving “${label}” out of date with ` +
              "nothing to say so. " +
              `Remove the queued bakes and commit the role change on its own first, then re-bake whichever layouts on ${columns} you changed.`,
      );
    }
  }

  if (reasons.length > 0) return { kind: "refused", reasons, bakes };
  if (bakes.length === 0) {
    if (!changed || derived.roles === null) return { kind: "empty", bakes };
    return { kind: "roles", roles: derived.roles, prediction: predict(input, bakes, replace), bakes };
  }
  const request: AddLayoutsRequest = {
    layout_specs: ids,
    replace: ids.filter((id) => replace.has(id)),
    ...(changed && derived.roles !== null ? { column_roles: derived.roles } : {}),
  };
  return { kind: "bake", request, prediction: predict(input, bakes, replace), bakes };
}

// ---------------------------------------------------------------------------
// A renamed layout keeps its name and its default
// ---------------------------------------------------------------------------

/** A rename this commit ADOPTS: committed layout `from` bakes under `to` from now on. */
export interface RenameMove {
  from: string;
  to: string;
}

/** The renames a bake of `bakeIds` adopts — each committed layout whose fate under the
 *  working roles is "renamed to Y" with Y among the ids this run bakes. Computed at the
 *  commit, from the model as committed. */
export function renameMoves(pending: PendingState, layouts: readonly LayoutInfo[], bakeIds: readonly string[]): RenameMove[] {
  const baking = new Set(bakeIds);
  const out: RenameMove[] = [];
  for (const layout of layouts) {
    if (!isLive(layout) || baking.has(layout.layout_id)) continue;
    const fate = layoutFate(pending, layouts, layout);
    if (fate.kind === "renamed" && baking.has(fate.to)) out.push({ from: layout.layout_id, to: fate.to });
  }
  return out;
}

/** The presentation PATCH that moves each adopted rename's label and default — for the
 *  moves whose new id is LIVE, and only those: a default pointing at a layout that has not
 *  landed falls back to the first layout for as long as the bake runs (D-xvi), and for good
 *  if it fails. A label already set on the new id is the owner's and is left alone. Null
 *  when there is nothing to write. */
export function movePatch(
  moves: readonly RenameMove[],
  presentation: Presentation,
  liveIds: ReadonlySet<string>,
): { applied: RenameMove[]; patch: { layouts?: Record<string, { label: string } | null>; default_layout?: string }; next: Presentation } | null {
  const applied: RenameMove[] = [];
  const layoutsPatch: Record<string, { label: string } | null> = {};
  const nextLayouts = { ...(presentation.layouts ?? {}) };
  let defaultLayout: string | undefined;
  for (const m of moves) {
    if (!liveIds.has(m.to)) continue;
    applied.push(m);
    const label = presentation.layouts?.[m.from]?.label;
    if (label !== undefined && label.trim() !== "" && (presentation.layouts?.[m.to]?.label ?? "") === "") {
      layoutsPatch[m.to] = { label };
      layoutsPatch[m.from] = null;
      nextLayouts[m.to] = { label };
      delete nextLayouts[m.from];
    }
    if (presentation.dataset?.default_layout === m.from) defaultLayout = m.to;
  }
  if (applied.length === 0) return null;
  const patch: { layouts?: Record<string, { label: string } | null>; default_layout?: string } = {};
  if (Object.keys(layoutsPatch).length > 0) patch.layouts = layoutsPatch;
  if (defaultLayout !== undefined) patch.default_layout = defaultLayout;
  const next: Presentation = { ...presentation };
  if (patch.layouts !== undefined) next.layouts = nextLayouts;
  if (defaultLayout !== undefined) next.dataset = { ...(presentation.dataset ?? {}), default_layout: defaultLayout };
  return { applied, patch, next };
}

// ---------------------------------------------------------------------------
// After it lands — the worker's report wins
// ---------------------------------------------------------------------------

export type JobKind = "roles" | "bake" | "delete";

/** A job this designer started, persisted per collection so that its report is read even
 *  if the page was closed and reopened while it ran. One per collection, because the API
 *  runs one job per collection at a time. */
export interface JobRecord {
  v: 1;
  jobId: string;
  kind: JobKind;
  /** running: not yet terminal. done: read back, kept until the user dismisses it. */
  phase: "running" | "done";
  /** The commit's prediction; null for a delete. */
  prediction: Prediction | null;
  /** Renames the commit adopts, applied as each new id goes live. */
  moves: RenameMove[];
  /** The model as committed (`serializePending`), to put back if nothing landed. */
  restore: string | null;
  /** The layout a delete removes. */
  deleting: string | null;
  outcome?: "finished" | "failed" | "expired";
  findings?: string[];
  error?: string | null;
}

export interface Reconciliation {
  outcome: "finished" | "failed" | "expired";
  /** Where the worker's report disagrees with the prediction. Each is a FINDING about the
   *  prediction, never hidden: since seam L7 both sides use the same per-entry rule. */
  findings: string[];
  /** The job's own error, when it failed. */
  error: string | null;
}

function differ(
  findings: string[],
  worker: Iterable<string>,
  predicted: Iterable<string>,
  name: (ids: string[]) => string,
  what: string,
): void {
  const w = new Set(worker);
  const p = new Set(predicted);
  const extra = sorted([...w].filter((x) => !p.has(x)));
  const missing = sorted([...p].filter((x) => !w.has(x)));
  if (extra.length > 0) findings.push(`The worker reports ${name(extra)} ${what}; the prediction did not.`);
  if (missing.length > 0) findings.push(`The prediction said ${name(missing)} would be ${what}; the worker does not report it.`);
}

/** Read the worker's report against the prediction. `status` null means the job is gone
 *  from the queue before it was read (RQ keeps a finished job's result for 500 s). */
export function reconcile(record: JobRecord, status: JobStatus | null, layouts: readonly LayoutInfo[]): Reconciliation {
  if (status === null) return { outcome: "expired", findings: [], error: null };
  if (status.state !== "finished") {
    return { outcome: "failed", findings: [], error: status.error ?? `The job ended ${status.state}.` };
  }
  const findings: string[] = [];
  const names = (ids: string[]): string => quoted(ids.map((id) => labelOf(layouts, id)));
  const result = status.result ?? null;
  const p = record.prediction;
  if (record.kind === "delete") {
    if (result !== null && "deleted" in result && result.deleted !== record.deleting) {
      findings.push(`The worker deleted ${result.deleted}, not ${record.deleting ?? "the layout asked for"}.`);
    }
    return { outcome: "finished", findings, error: null };
  }
  if (result === null || p === null) {
    findings.push("The job finished without a report to check the prediction against; the cards show the collection as it now stands.");
    return { outcome: "finished", findings, error: null };
  }
  if (record.kind === "roles" && "changed_columns" in result) {
    const cols = (ids: string[]): string => ids.join(", ");
    differ(findings, result.changed_columns, p.changedColumns, (ids) => `a changed role on ${cols(ids)}`, "changed");
    differ(findings, result.stale_layouts, p.stale, names, "stale");
    differ(findings, result.orphaned_layouts, p.orphaned, names, "orphaned");
    // The worker lists EVERY pre-2.9 entry as unknown, grid included; the prediction only
    // the layouts that read columns (CONTRACT §4). Compare on those.
    const grid = new Set(layouts.filter((l) => l.type === "grid").map((l) => l.layout_id));
    differ(findings, result.unknown_layouts.filter((id) => !grid.has(id)), p.unknown, names, "unchecked");
    const renames = (m: Record<string, string>): string[] => Object.entries(m).map(([a, b]) => `${a}→${b}`);
    differ(findings, renames(result.renamed_layouts), renames(p.renamed), (ids) => ids.join(", "), "renamed");
    differ(findings, result.unserved_tag_roles, p.unservedTags, (ids) => `the tag filter on ${ids.join(", ")}`, "declared but not served");
  } else if (record.kind === "bake" && "committed" in result) {
    differ(findings, result.committed, p.bakes.map((b) => b.layout_id), names, "committed");
    differ(findings, result.replaced, p.bakes.filter((b) => b.replace).map((b) => b.layout_id), names, "replaced");
  } else {
    findings.push("The job's report is not the shape this commit expects; the cards show the collection as it now stands.");
  }
  return { outcome: "finished", findings, error: null };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const JOB_STORAGE_PREFIX = "plotlas.designer.job.";

export function jobStorageKey(datasetId: string): string {
  return `${JOB_STORAGE_PREFIX}${datasetId}`;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** A `Prediction`, checked all the way down: every field the banner and `reconcile` read. */
function isPrediction(v: unknown): v is Prediction {
  if (!isRecord(v)) return false;
  const lists = ["changedColumns", "stale", "orphaned", "unknown", "unservedTags"] as const;
  if (!lists.every((k) => isStringArray(v[k]))) return false;
  if (!isRecord(v.renamed) || !Object.values(v.renamed).every((x) => typeof x === "string")) return false;
  return (
    Array.isArray(v.bakes) &&
    v.bakes.every(
      (b) =>
        isRecord(b) &&
        typeof b.layout_id === "string" &&
        typeof b.label === "string" &&
        typeof b.type === "string" &&
        (b.source_columns === null || isStringArray(b.source_columns)) &&
        typeof b.replace === "boolean",
    )
  );
}

/** A stored record, checked as deep as anything reads it. The follower renders on EVERY tab,
 *  so a record it cannot walk — `prediction: {}` from a build that changed `Prediction`
 *  but still writes `v: 1` — would take the whole designer down on every load, and never be
 *  dropped (user review #3; `restorePending` guards the pending model the same way). */
function isJobRecord(v: unknown): v is JobRecord {
  return (
    isRecord(v) &&
    v.v === 1 &&
    typeof v.jobId === "string" &&
    (v.kind === "roles" || v.kind === "bake" || v.kind === "delete") &&
    (v.phase === "running" || v.phase === "done") &&
    Array.isArray(v.moves) &&
    v.moves.every((m) => isRecord(m) && typeof m.from === "string" && typeof m.to === "string") &&
    (v.prediction === null || isPrediction(v.prediction)) &&
    (v.restore === null || typeof v.restore === "string") &&
    (v.deleting === null || typeof v.deleting === "string") &&
    (v.outcome === undefined || v.outcome === "finished" || v.outcome === "failed" || v.outcome === "expired") &&
    (v.findings === undefined || isStringArray(v.findings)) &&
    (v.error === undefined || v.error === null || typeof v.error === "string")
  );
}

/** The job record for this collection, or null. Never throws; a malformed record is
 *  removed as it is dropped. */
export function loadJobRecord(datasetId: string, store: KeyValueStore | null = defaultStore()): JobRecord | null {
  if (store === null) return null;
  try {
    const raw = store.getItem(jobStorageKey(datasetId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isJobRecord(parsed)) return parsed;
    store.removeItem(jobStorageKey(datasetId));
    return null;
  } catch {
    // Not JSON at all: dropped like any other malformed record, or every visit would parse
    // it again (verification of #385, round 3, N6). Storage that refused the read refuses
    // this too, and then there is nothing to drop.
    try {
      store.removeItem(jobStorageKey(datasetId));
    } catch {
      // unavailable
    }
    return null;
  }
}

/** Write the record, or remove it (null). Best-effort, like `savePending`. */
export function saveJobRecord(datasetId: string, record: JobRecord | null, store: KeyValueStore | null = defaultStore()): void {
  if (store === null) return;
  try {
    if (record === null) store.removeItem(jobStorageKey(datasetId));
    else store.setItem(jobStorageKey(datasetId), JSON.stringify(record));
  } catch {
    // Storage full / unavailable — and nothing is lost by it here: storage is only the
    // record's MIRROR. The record itself lives in the shell's job follower, which a surface
    // that starts a job hands it to directly (layouts.ts `useJobOwner`), so this page
    // follows, reconciles and moves renames exactly as it would with storage. What is lost
    // is the next visit's copy.
  }
}
