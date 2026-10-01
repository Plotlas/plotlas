// The layout designer's PENDING-CHANGE MODEL (seam L3 §2b.4; LAYOUT_DESIGNER D-xx/D-xxi).
//
// What the commit bar counts, and what seams L4 (Data) and L5 (Layouts) write into. It
// holds exactly two kinds of pending thing, because those are the only two things that
// COST (D-xx — "if it is in the bar, it has a price"):
//
//   - a working ROLES DRAFT (`RolesDraft`, roles.ts), seeded from the committed
//     `column_roles`. L4 edits it. A role change is INVALIDATING: it writes the manifest
//     and stales the layouts built on the column. Committed by `POST .../column-roles`.
//   - a list of BAKE ENTRIES — a `new` layout, or a `rebake` of a committed one. L5
//     edits it. Committed by `POST .../layouts` (with `replace` for the re-bakes).
//
// Free edits — a name, a credit, a default layout, a cell title, a layout's or column's
// display label — never enter this model at all. They PATCH `.../presentation` as they
// are typed, and the bar never learns about them.
//
// THE FOUR OUTCOMES. Before anything is committed, the designer must say what a role
// edit does to every baked layout: stale, renamed, orphaned or unknown
// (`RoleConsequences`). The pipeline decides that AUTHORITATIVELY at the commit
// (`pipeline/worker.py`: `_role_fingerprints`, `_changed_role_columns`,
// `_classify_layout_staleness`, `_family_layout_names`, `_classify_unproducible_layouts`)
// and returns it on the finished job's `result`. This module PREDICTS it on every
// keystroke with the same rules, transcribed below function for function. It never asks
// the server — there is deliberately no dry-run endpoint — and L5 reconciles the
// prediction with the commit's own report.
//
// Pure: no React, no fetch, node-test importable. Storage access is injectable and every
// touch of it is guarded, because storage can be absent (private mode, sandboxed frames).
import type { ColumnRoles } from "../../generated/column_roles";
import type { LayoutInfo } from "../../api-client/types";
import type { ColumnPresentationMap } from "../presentation";
import { buildColumnRoles, datetimeColumn, producibleLayouts, rolesDraftFromColumnRoles, validateDraft } from "../admin/roles";
import type { DatetimeFormat, ProducibleLayout, RolesDraft } from "../admin/roles";
import type { KeyValueStore } from "../admin/uploadSession";
import { DEFAULT_NORMALIZE, DEFAULT_OVERLAP, DEFAULT_PROJECTION, DEFAULT_SCALE } from "../layoutOptions";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** A layout family a bake can ADD. Grid is never added: it is the always-present floor. */
export type BakeFamily = ProducibleLayout["type"];

/** One pending bake.
 *
 *  A `new` layout is identified by its family and its SOURCE COLUMNS — the same tuple a
 *  baked layout records as `source_columns` — and NOT by a layout id, because the id is
 *  not stable while roles are being edited: the family naming convention names a lone
 *  entry `categorical` and switches every entry to `categorical_<slug>` the moment a
 *  second appears (`_family_layout_names`). The id a `new` entry will bake under is
 *  RESOLVED from the working draft on every derivation (`ResolvedBake.layout_id`).
 *  `source_columns` is `[column]` for datetime/categorical and the pair, in axis order
 *  (x, y / lon, lat, de-duplicated), for scatter/geographic.
 *
 *  A `rebake` names a COMMITTED layout by id. D-xxi: re-bake queues; it does not start. */
export type BakeEntry =
  | { kind: "new"; type: BakeFamily; source_columns: string[] }
  | { kind: "rebake"; layout_id: string };

/** The whole model. Treat it as immutable: every function below returns a new state. */
export interface PendingState {
  /** The committed `column_roles` (the manifest's). null ⇒ an images-only collection. */
  committed: ColumnRoles | null;
  /** The draft exactly as the committed roles seed it — what Discard returns to. */
  seed: RolesDraft | null;
  /** The working draft L4 edits. null iff `committed` is null. */
  draft: RolesDraft | null;
  /** The pending bakes L5 edits, in the order they were queued. */
  bakes: BakeEntry[];
}

function cloneDraft(draft: RolesDraft | null): RolesDraft | null {
  return draft === null ? null : (JSON.parse(JSON.stringify(draft)) as RolesDraft);
}

/** The model for a collection with nothing pending. `presentationColumns` is the
 *  presentation record's `columns` map — `rolesDraftFromColumnRoles` reads its link
 *  flags. */
export function seedPending(
  committed: ColumnRoles | null | undefined,
  presentationColumns?: ColumnPresentationMap,
): PendingState {
  const roles = committed ?? null;
  const seed = roles !== null ? rolesDraftFromColumnRoles(roles, presentationColumns) : null;
  return { committed: roles, seed, draft: cloneDraft(seed), bakes: [] };
}

/** L4's write: replace the working draft wholesale. Build `draft` with roles.ts's own
 *  helpers (`patchScatterPair`, `patchGeoPair`, …) — this module does not re-implement
 *  them. A null draft is only valid for an images-only collection. */
export function withDraft(state: PendingState, draft: RolesDraft | null): PendingState {
  return { ...state, draft };
}

/** A stable identity for a bake entry — for React keys, de-duplication and removal. */
export function bakeKey(entry: BakeEntry): string {
  return entry.kind === "rebake"
    ? `rebake:${entry.layout_id}`
    : `new:${entry.type}:${JSON.stringify(entry.source_columns)}`;
}

/** L5's write: queue a bake. Queuing the same bake twice is a no-op. */
export function addBake(state: PendingState, entry: BakeEntry): PendingState {
  const key = bakeKey(entry);
  if (state.bakes.some((b) => bakeKey(b) === key)) return state;
  return { ...state, bakes: [...state.bakes, entry] };
}

/** L5's write: un-queue a bake (matched by `bakeKey`). */
export function removeBake(state: PendingState, entry: BakeEntry): PendingState {
  const key = bakeKey(entry);
  return { ...state, bakes: state.bakes.filter((b) => bakeKey(b) !== key) };
}

/** Discard everything pending: the draft returns to the seed and no bake is queued. */
export function discardPending(state: PendingState): PendingState {
  return { ...state, draft: cloneDraft(state.seed), bakes: [] };
}

/** Whether the model holds anything that is not the committed state — the test for
 *  whether it is worth persisting. Broader than "the bar shows a count": a draft that
 *  differs from the seed only in a role LABEL is an edit (and is kept across a reload),
 *  but it is a free one and prices nothing. */
export function hasEdits(state: PendingState): boolean {
  return state.bakes.length > 0 || canonicalJson(state.draft) !== canonicalJson(state.seed);
}

// ---------------------------------------------------------------------------
// The authority, transcribed (pipeline/worker.py)
// ---------------------------------------------------------------------------

/** One role entry, whichever family it belongs to. */
type RoleEntryValue =
  | NonNullable<ColumnRoles["filename"]>
  | NonNullable<ColumnRoles["datetime"]>
  | NonNullable<ColumnRoles["categorical"]>[number]
  | NonNullable<ColumnRoles["scatter"]>[number]
  | NonNullable<ColumnRoles["geographic"]>[number]
  | NonNullable<ColumnRoles["tag"]>[number]
  | NonNullable<ColumnRoles["embedding"]>;

/** `manifest.role_entry_fingerprints`: column → the fingerprint tuples THIS ONE role entry
 *  contributes, each JSON-encoded so two sets compare by value. The single definition of
 *  the tuple on this side; `roleFingerprints` (the per-column union), the stale prediction
 *  and the durable `baked` comparison are all built on it, so no tuple is written twice.
 *
 *  IN the tuple: the role kind; every knob that changes how the column is read (datetime
 *  format, tag delimiter, the scatter scale/normalize/overlap set, the geographic
 *  projection/overlap set, embedding dim); and for a PAIR, the partner column and the axis
 *  position — repointing a scatter's y changes what its x means.
 *  OUT of it: `label`. A label is a free edit and stales nothing (D-xx).
 *
 *  A knob the manifest omits is its DEFAULT here, exactly as `ColumnRoles.from_config`
 *  fills it before the worker fingerprints — so an explicit `"linear"` and an absent
 *  scale compare equal, as they do in the pipeline.
 *
 *  A SELF-PAIR returns ONE key carrying TWO tuples: a scatter over `(sx, sx)` still
 *  declares both axes on `sx`, while its `source_columns` de-duplicates to one name. */
export function roleEntryFingerprints(kind: string, entry: RoleEntryValue): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (column: string, fingerprint: unknown[]): void => {
    out.set(column, [...(out.get(column) ?? []), JSON.stringify(fingerprint)]);
  };
  if (kind === "scatter") {
    const sc = entry as NonNullable<ColumnRoles["scatter"]>[number];
    // `_SCATTER_KNOBS` — the keys of manifest._SCATTER_KNOB_DEFAULTS, in that order.
    const knobs = [
      sc.x_scale ?? DEFAULT_SCALE,
      sc.y_scale ?? DEFAULT_SCALE,
      sc.normalize ?? DEFAULT_NORMALIZE,
      sc.overlap ?? DEFAULT_OVERLAP,
    ];
    add(sc.x_column, ["scatter", "x", sc.y_column, ...knobs]);
    add(sc.y_column, ["scatter", "y", sc.x_column, ...knobs]);
  } else if (kind === "geographic") {
    const geo = entry as NonNullable<ColumnRoles["geographic"]>[number];
    // `_GEO_KNOBS` — the keys of manifest._GEO_KNOB_DEFAULTS, in that order.
    const knobs = [geo.projection ?? DEFAULT_PROJECTION, geo.overlap ?? DEFAULT_OVERLAP];
    add(geo.lon_column, ["geographic", "lon", geo.lat_column, ...knobs]);
    add(geo.lat_column, ["geographic", "lat", geo.lon_column, ...knobs]);
  } else if (kind === "datetime") {
    const dt = entry as NonNullable<ColumnRoles["datetime"]>;
    add(dt.column, ["datetime", dt.format]);
  } else if (kind === "tag") {
    const tag = entry as NonNullable<ColumnRoles["tag"]>[number];
    add(tag.column, ["tag", tag.delimiter]);
  } else if (kind === "embedding") {
    const emb = entry as NonNullable<ColumnRoles["embedding"]>;
    add(emb.column, ["embedding", emb.dim]);
  } else if (kind === "filename" || kind === "categorical" || kind === "freeform") {
    add((entry as { column: string }).column, [kind]);
  } else {
    // As in the pipeline: a role with no fingerprint would read as "this column is not
    // interpreted at all", which is a claim. A new role is added here, never defaulted.
    throw new Error(`roleEntryFingerprints: unknown role kind ${kind}`);
  }
  return out;
}

/** `(role kind, entry)` for every entry the map declares, in declaration order —
 *  `worker._role_entries`. The one place that walks a `ColumnRoles`' fields. */
function roleEntries(roles: ColumnRoles | null | undefined): [string, RoleEntryValue][] {
  if (roles === null || roles === undefined) return [];
  const out: [string, RoleEntryValue][] = [["filename", roles.filename]];
  if (roles.datetime != null) out.push(["datetime", roles.datetime]);
  for (const cat of roles.categorical ?? []) out.push(["categorical", cat]);
  for (const sc of roles.scatter ?? []) out.push(["scatter", sc]);
  for (const geo of roles.geographic ?? []) out.push(["geographic", geo]);
  for (const tag of roles.tag ?? []) out.push(["tag", tag]);
  for (const ff of roles.freeform ?? []) out.push(["freeform", ff]);
  if (roles.embedding != null) out.push(["embedding", roles.embedding]);
  return out;
}

/** `_role_fingerprints`: column → the set of ways the role map says that column is READ —
 *  the UNION over every entry, which is what a two-maps diff needs.
 *
 *  NOT what a layout RECORDS. `LayoutInfo.source_fingerprint` holds the subset ONE role
 *  entry contributes, because a union written into a bake record would never clear: a
 *  second scatter pair sharing an axis column, or a tag role added to a categorical
 *  column, would stale an untouched layout forever (D-xxix). */
export function roleFingerprints(roles: ColumnRoles | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [kind, entry] of roleEntries(roles)) {
    for (const [column, fingerprints] of roleEntryFingerprints(kind, entry)) {
      const set = out.get(column) ?? new Set<string>();
      for (const fingerprint of fingerprints) set.add(fingerprint);
      out.set(column, set);
    }
  }
  return out;
}

function sameSet(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** `_changed_role_columns`: the columns whose role moved between two maps, sorted. A
 *  column that gained a role, lost one, or had one re-parameterised is changed; a column
 *  whose fingerprint set is identical is not — so a LABEL edit changes nothing. */
export function changedRoleColumns(
  before: ColumnRoles | null | undefined,
  after: ColumnRoles | null | undefined,
): string[] {
  return changedBetween(roleFingerprints(before), roleFingerprints(after));
}

/** `changedRoleColumns` over two `roleFingerprints` maps already built — `derivePending`
 *  keeps the committed one cached (`committedRoleUnits`). */
function changedBetween(old: Map<string, Set<string>>, next: Map<string, Set<string>>): string[] {
  const columns = new Set([...old.keys(), ...next.keys()]);
  // Sorted by UTF-16 code unit. Python's `sorted()` orders by code point; the two agree
  // for every string without astral-plane characters.
  return [...columns].filter((c) => !sameSet(old.get(c), next.get(c))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `tuple(dict.fromkeys(...))`: de-duplicate, keeping first-seen order — a scatter
 *  plotted against itself provenances as ONE column, in the manifest and here. */
function dedupe(columns: string[]): string[] {
  return [...new Set(columns)];
}

/** The key a family entry is looked up by: its type and its WHOLE source tuple, in order. */
function entryKey(type: string, sourceColumns: readonly string[]): string {
  return `${type}\u0000${JSON.stringify(sourceColumns)}`;
}

/** `_family_ids_by_source_columns` (plus datetime, for resolving a `new` bake):
 *  (layout type, the entry's whole source-column tuple) → the layout_id that entry bakes
 *  under NOW.
 *
 *  The ids are `producibleLayouts`' (roles.ts's transcription of `_family_layout_names`);
 *  the tuples are `_family_entries`', read off the compiled roles. The two lists walk the
 *  same entries in the same order — both derive from the draft's column order and pair
 *  order — and are zipped per family. A length mismatch means that stopped being true,
 *  and it THROWS rather than pair ids with the wrong entries: a wrong rename report is
 *  exactly the failure this model exists to prevent. */
function familyIdsBySourceColumns(draft: RolesDraft, roles: ColumnRoles): Map<string, string> {
  const ids = producibleLayouts(draft);
  const entries: Record<BakeFamily, string[][]> = {
    datetime: roles.datetime != null ? [[roles.datetime.column]] : [],
    categorical: (roles.categorical ?? []).map((e) => [e.column]),
    scatter: (roles.scatter ?? []).map((e) => dedupe([e.x_column, e.y_column])),
    geographic: (roles.geographic ?? []).map((e) => dedupe([e.lon_column, e.lat_column])),
  };
  const out = new Map<string, string>();
  for (const type of Object.keys(entries) as BakeFamily[]) {
    const familyIds = ids.filter((p) => p.type === type);
    if (familyIds.length !== entries[type].length) {
      throw new Error(
        `pending: producibleLayouts names ${familyIds.length} ${type} layout(s) but the compiled roles declare ${entries[type].length}`,
      );
    }
    entries[type].forEach((columns, i) => out.set(entryKey(type, columns), familyIds[i].layout_id));
  }
  return out;
}

/** THE DRAFT QUEUED BAKES ARE NAMED FROM WHEN NOTHING IS EDITED (#385; D-xxxi).
 *
 *  With nothing edited the working roles ARE the committed ones, and a bake that sends no
 *  roles is named by the worker from them. The seed is not always them: it holds ONE role
 *  per column, so a column that is also a tag or freeform role came back as that, and its
 *  layout family lost an entry. On the 2.10 fixture, with nothing edited, a re-bake of By
 *  date read "the new roles no longer produce it" when `captured` is datetime AND freeform,
 *  and so did Group and Bucket when `group` is categorical AND tag.
 *
 *  So every column the committed roles give a LAYOUT role (datetime, categorical) is set
 *  back to it; pairs are held exactly already. Where the seed holds the roles exactly this
 *  IS the seed, so a layout a roles-only commit orphaned or renamed still reads that way —
 *  as does one the committed roles themselves rename (a second pair beside it). Only ids
 *  are named from it; it is never committed. The seed is kept when this does not validate,
 *  and a column with two LAYOUT roles keeps one of them — both refuse as before. */
function bakeNamingDraft(draft: RolesDraft, committed: ColumnRoles | null): RolesDraft {
  if (committed === null) return draft;
  const choice: RolesDraft["choice"] = { ...draft.choice };
  if (committed.datetime != null) choice[committed.datetime.column] = "datetime";
  for (const c of committed.categorical ?? []) choice[c.column] = "categorical";
  if (canonicalJson(choice) === canonicalJson(draft.choice)) return draft;
  // No links: a link names no layout, and one on a column set back to datetime here is one
  // `validateDraft` refuses — a datetime + freeform `captured` rendered as a link fell back
  // to the lossy seed and refused By date's re-bake again (final verification of #385).
  const named = { ...draft, choice, url: [] };
  return validateDraft(named) === null ? named : draft;
}

/** The role kinds that produce a LAYOUT — `_LAYOUT_ROLE_KINDS`. */
const LAYOUT_ROLE_KINDS = new Set(["datetime", "categorical", "scatter", "geographic"]);

/** A comparable fingerprint, keyed by column with its tuples as a set. */
type Fingerprint = Map<string, Set<string>>;

/** `_entry_fingerprints_by_source_columns`: (layout type, the entry's WHOLE source-column
 *  tuple) → the entries that key names, each as the fingerprints that one entry
 *  contributes.
 *
 *  THE KEY COSTS NOTHING TO DERIVE, because `roleEntryFingerprints` is already keyed by
 *  column, in first-seen order, with duplicates collapsed by Map semantics — which is what
 *  `source_columns` is. So this does not re-implement the per-family column order or the
 *  `(sx, sx)` de-dupe; the 2026-09-23 review counted three hand-written copies of that rule
 *  per language, and a copy that drifts makes the lookup find no candidate, so every layout
 *  of that family reads stale for ever.
 *
 *  A LIST, NOT ONE ENTRY, BECAUSE THE KEY IS NOT UNIQUE: two entries of one family over the
 *  same columns in the same order are legal, and the naming convention hands the second a
 *  `-1` suffix, so `scatter_sx` and `scatter_sx-1` both provenance as `["sx","sy"]`.
 *
 *  Walks `roleEntries`, the one place that walks a `ColumnRoles`' fields. `grid` is not
 *  here: it has no role entry, and its `[]` provenance is the caller's positive claim. */
function entryFingerprintsBySourceColumns(roles: ColumnRoles | null | undefined): Map<string, Fingerprint[]> {
  const out = new Map<string, Fingerprint[]>();
  for (const [kind, entry] of roleEntries(roles)) {
    if (!LAYOUT_ROLE_KINDS.has(kind)) continue;
    const fingerprints = roleEntryFingerprints(kind, entry);
    const key = entryKey(kind, [...fingerprints.keys()]);
    out.set(key, [...(out.get(key) ?? []), comparableFingerprint(fingerprints)]);
  }
  return out;
}

/** A fingerprint map as an order-insensitive comparable — `_comparable_fingerprint`. */
function comparableFingerprint(fingerprints: Map<string, string[]>): Fingerprint {
  return new Map([...fingerprints].map(([column, fps]) => [column, new Set(fps)]));
}

/** A committed entry's `source_fingerprint` as the same comparable, or null when it records
 *  none (a pre-2.10 entry) — `_recorded_fingerprint`. Each recorded tuple is re-encoded
 *  exactly as `roleEntryFingerprints` encodes a live one.
 *
 *  GUARDED, because the API passes this block through WITHOUT re-validating it (an
 *  unexpected shape must not 500 the layout list), so a hand-edited manifest reaches here.
 *  A column whose value is not an array is DROPPED, exactly as Python's
 *  `_recorded_fingerprint` drops it — `.map` on a string would throw inside `derivePending`
 *  and the designer would not render at all. Dropping can only make the record match fewer
 *  declarations, i.e. read stale — never fresh. */
function recordedFingerprint(layout: LayoutInfo): Fingerprint | null {
  const recorded = layout.source_fingerprint;
  if (recorded === null || recorded === undefined || typeof recorded !== "object") return null;
  return new Map(
    Object.entries(recorded)
      .filter(([, tuples]) => Array.isArray(tuples))
      .map(([column, tuples]) => [column, new Set((tuples as unknown[]).map((t) => JSON.stringify(t)))]),
  );
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  if (a.size !== b.size) return false;
  for (const [column, fps] of a) if (!sameSet(fps, b.get(column))) return false;
  return true;
}

/** A comparable fingerprint as a string KEY, for the duplicate count — `_hashable`. */
function fingerprintKey(fingerprint: Fingerprint): string {
  return JSON.stringify([...fingerprint].map(([c, fps]) => [c, [...fps].sort()]).sort());
}

/** `_locate_entry_fingerprints` — the PRE-2.10 FALLBACK ONLY: which role entry a layout
 *  that recorded no fingerprint was baked from, inferred from its provenance alone, or
 *  undefined when that cannot be told (which the caller reads as STALE).
 *
 *  Exactly one candidate is the only answer this can give: with several, a layout with no
 *  bake record carries nothing that could tell them apart, and guessing would report a
 *  moved declaration as fresh. A 2.10 entry never reaches here — its own
 *  `source_fingerprint` IS what it was baked with. */
function locateEntryFingerprints(candidates: Fingerprint[]): Fingerprint | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** THE ENTRY LOCATOR, exported for the designer's baked card (seam L8; review of #397,
 *  round 3, finding 5), so the entry the card edits is the one the bar and the review price.
 *  Which of `roles`' entries of family `type` a layout whose provenance is `sourceColumns`
 *  names, by its index in the family's own list (`roles.scatter[i]`, `roles.geographic[i]`).
 *  Keyed exactly as `entryFingerprintsBySourceColumns` keys entries, and decided by the same
 *  exactly-one rule (`locateEntryFingerprints`). `candidates` is how many entries share the
 *  key: 0 when none declares it, and more than one when several do, which leaves `index`
 *  undefined, because nothing may be guessed. It only reads; nothing in this module calls
 *  it. */
export function locateEntry(
  roles: ColumnRoles | null | undefined,
  type: string,
  sourceColumns: readonly string[],
): { index: number | undefined; candidates: number } {
  const key = entryKey(type, sourceColumns);
  const found: { index: number; fingerprint: Fingerprint }[] = [];
  let index = -1;
  for (const [kind, entry] of roleEntries(roles)) {
    if (kind !== type) continue;
    index += 1;
    const fingerprints = roleEntryFingerprints(kind, entry);
    if (entryKey(kind, [...fingerprints.keys()]) === key) found.push({ index, fingerprint: comparableFingerprint(fingerprints) });
  }
  const own = locateEntryFingerprints(found.map((f) => f.fingerprint));
  return { index: found.find((f) => f.fingerprint === own)?.index, candidates: found.length };
}

/** `_own_fingerprint`: WHAT THIS LAYOUT WAS BAKED WITH.
 *
 *  THE BAKE RECORD WINS — that is what manifest 2.10 is for. Inferring it from the
 *  COMMITTED roles instead is wrong whenever the roles moved more than once between bakes:
 *  round-trip a datetime format `iso8601 → unix_seconds → iso8601` and the committed state
 *  says `unix_seconds` while the tiles are `iso8601`, so the prediction says stale while
 *  `derived.baked` says fresh — the three-way disagreement the seam exists to prevent
 *  (2026-09-23 review, finding 1). Only a pre-2.10 entry falls back to locating its entry. */
function ownFingerprint(layout: LayoutInfo, committedEntries: Map<string, Fingerprint[]>): Fingerprint | undefined {
  const recorded = recordedFingerprint(layout);
  if (recorded !== null) return recorded;
  const sources = layout.source_columns;
  return locateEntryFingerprints(committedEntries.get(entryKey(layout.type, sources ?? [])) ?? []);
}

/** Which of `layouts` the role map behind `declared` no longer declares what they were
 *  baked with — `_classify_layout_staleness`' second pass, shared by the prediction and the
 *  durable record so the two cannot diverge.
 *
 *  MATCHED AND COUNTED AGAINST ENTRIES, never against the per-column union. A union
 *  under-reports within a family: with two entries over one pair, changing only the first
 *  leaves the second contributing the old tuples, so the changed layout reads FRESH over
 *  tiles that no longer match it (2026-09-23 review, finding 2). Two layouts that recorded
 *  the same fingerprint need two entries still declaring it; if only one survives, one of
 *  them is stale and nothing can say which, so both are reported — over-reporting is the
 *  safe direction, and picking one arbitrarily would let the stale one read fresh. */
/** `a - b`, for the newly-staled test. */
function setDifference(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((v) => !b.has(v)));
}

function staleAgainstEntries(
  owned: { layout: LayoutInfo; own: Fingerprint }[],
  declared: Map<string, Fingerprint[]>,
): Set<string> {
  const demand = new Map<string, number>();
  for (const { layout, own } of owned) {
    const k = `${entryKey(layout.type, layout.source_columns ?? [])}\u0000${fingerprintKey(own)}`;
    demand.set(k, (demand.get(k) ?? 0) + 1);
  }
  const stale = new Set<string>();
  for (const { layout, own } of owned) {
    const key = entryKey(layout.type, layout.source_columns ?? []);
    const supply = (declared.get(key) ?? []).filter((c) => sameFingerprint(c, own)).length;
    if (supply < (demand.get(`${key}\u0000${fingerprintKey(own)}`) ?? 0)) stale.add(layout.layout_id);
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** What a pending role edit does to ONE committed layout. The flags are not exclusive —
 *  a pair family split into two pairs that each keep one old column is `orphaned` AND
 *  `stale` (the worker's round-2 finding A) — but `renamedTo` and `orphaned` are.
 *  Grid reads no columns and never appears here. */
export interface LayoutOutcome {
  layout_id: string;
  /** The layout's label as the caller passed it (pass effective labels — see
   *  `layoutsWithLabels` in ui/presentation.ts). */
  label: string;
  /** THIS EDIT stales it: its tiles no longer match what the draft declares, and they DID
   *  match what the committed roles declare. A layout an earlier commit already staled is
   *  not here — that is `derived.baked`'s job, and blaming the open edit for it would
   *  re-queue a re-bake the operator may have deliberately declined (D-xxix). The two
   *  fields are disjoint; a surface wanting every stale layout unions them. */
  stale: boolean;
  /** Untouched, but the new roles bake it under a different id (its family gained or
   *  lost a member). The new id. Null when not renamed. */
  renamedTo: string | null;
  /** The new roles cannot produce this id, and no entry with its exact source columns
   *  survives under another id. Nothing can re-bake it. */
  orphaned: boolean;
  /** Baked before layouts recorded their columns (`source_columns` null or absent), so
   *  this change cannot be checked against it. NEVER promoted to stale — that would be a
   *  guess. Only reported while some column's role has changed. */
  unknown: boolean;
}

/** DURABLE staleness for one committed layout: does its BAKE RECORD still match the
 *  COMMITTED roles? Independent of anything pending — it is true on a freshly loaded
 *  screen with no draft, which is the whole point (`LayoutOutcome.stale` answers the
 *  different question "what would this PENDING edit do?").
 *
 *  Computed from `LayoutInfo.source_fingerprint` (manifest 2.10) against
 *  `state.committed`: the layout is stale on a column when a tuple its bake recorded is no
 *  longer among the ways the committed roles read that column. */
export interface BakedStaleness {
  layout_id: string;
  /** False when the entry records NO fingerprint — it predates manifest 2.10. Then
   *  `staleColumns` is empty and NOTHING may claim the layout is fresh: it is UNCHECKED,
   *  which is a third answer, not a quiet "no". */
  checkable: boolean;
  /** The columns whose recorded reading the committed roles no longer declare, sorted.
   *  Empty when fresh AND when `checkable` is false — read the flag, not the length. */
  staleColumns: string[];
}

/** The FIFTH outcome of a role edit, which the four above do not cover: what a tag-role
 *  change does to the TAG INDEX. Tag filters are served from `tags/tags_v{N}.arrow`, which
 *  only a bake writes, so a roles-only commit can declare a filter with nothing behind it
 *  or remove the last one there is (the `TagSidecar` board). Predicted from the COMMITTED
 *  roles against the DRAFT.
 *
 *  The worker's `_classify_tag_sidecar` is the authority for `unservedColumns`' first case
 *  (a newly declared tag role) and reads the committed sidecar's actual schema, which a
 *  client cannot. This model predicts ONE CASE THE WORKER MISSES — a delimiter that moved,
 *  where the committed index was split on the old one and the column IS in the sidecar
 *  ([[T2-changing-a-tag-delimiter-reports-nothing]]). It also cannot see a sidecar that is
 *  missing or unreadable, which the worker counts as serving nothing. So: a superset on
 *  delimiters, a subset on file damage; the commit's own report still wins. */
export interface TagDerivation {
  /** Columns whose tag filter would be DECLARED BUT NOT SERVED until a bake — newly
   *  declared, or re-split on a new delimiter. Sorted. */
  unservedColumns: string[];
  /** True when this edit removes the collection's LAST tag role: tag filtering goes away
   *  from the atlas on commit, and the index file is left on disk, used by nothing. */
  removesLastTagRole: boolean;
}

/** A pending bake, resolved against the working draft. */
export interface ResolvedBake {
  entry: BakeEntry;
  key: string;
  /** The id it would bake under now, or null when it cannot be baked as queued. */
  layout_id: string | null;
  label: string;
  /** Why it cannot be baked as queued; null when it can. */
  problem: string | null;
}

/** Everything the bar and the views read. Recompute on every change; it is cheap. */
export interface PendingDerivation {
  /** `validateDraft`'s complaint about an EDITED draft, else null. While set, no roles can
   *  be committed, so the role outcomes below are empty and Review must stay closed. */
  problem: string | null;
  /** What a roles commit would send: `buildColumnRoles(draft)` once anything is edited,
   *  and the COMMITTED map while nothing is — so posting it on an untouched screen is a
   *  no-op rather than a silent drop of a column's second role, which the draft cannot
   *  represent ([[T2-the-roles-draft-cannot-hold-a-column-s-second]]). Null when there is
   *  nothing valid to send (images-only, or `problem`). */
  roles: ColumnRoles | null;
  /** The columns whose role the draft changes (`_changed_role_columns`). */
  changedColumns: string[];
  /** One entry per committed layout the edit affects, in the order `layouts` lists them. */
  outcomes: LayoutOutcome[];
  /** DURABLE staleness, one entry per committed layout INCLUDING grid, in list order —
   *  what the bake recorded against what the roles say now. Unlike `outcomes` this does
   *  not depend on the draft, so it is populated on a screen with nothing pending. Look
   *  one up with `bakedFor(derived, id)`. */
  baked: BakedStaleness[];
  /** What the pending edit does to the TAG INDEX (the fifth outcome). */
  tags: TagDerivation;
  bakes: ResolvedBake[];
  /** The bar's two counts. `invalidating` counts ROLE CHANGES by the unit the owner edits —
   *  one per pair entry added, removed or changed, and one per other column whose role moved
   *  (`roleChangeCount`) — not changed columns, which `changedColumns` lists. 0 when `roles`
   *  is null (nothing compiled to compare), and 0 exactly when `changedColumns` is empty.
   *  `bakeCount` counts queued bake entries. Free edits are neither. */
  invalidating: number;
  bakeCount: number;
  /** Whether the bar has anything to show at all. */
  isPending: boolean;
}

function isGrid(layout: LayoutInfo): boolean {
  return layout.type === "grid";
}

function committedLayouts(layouts: readonly LayoutInfo[]): LayoutInfo[] {
  // A pending row (`state` queued/baking) is not in the manifest yet, so a role edit
  // cannot stale it. Absent `state` is an old server's committed row.
  return layouts.filter((l) => (l.state ?? "live") === "live");
}

/** The role kinds whose one entry is a role over TWO columns. */
const PAIR_ROLE_KINDS = ["scatter", "geographic"] as const;

/** `["freeform"]` as `roleEntryFingerprints` encodes it. */
const FREEFORM_READING = JSON.stringify(["freeform"]);

function isPairKind(kind: unknown): boolean {
  return (PAIR_ROLE_KINDS as readonly unknown[]).includes(kind);
}

/** One role map as `roleChangeCount` and `changedColumns` compare it.
 *
 *  - `readings`: every column's readings — `roleFingerprints`, the one per-column union, so
 *    the count and `changedColumns` read the same set and a new role kind cannot drift
 *    between them (operator's review of #400, finding 8). A column's OWN readings are these
 *    minus its pair readings (`ownReadings`).
 *  - `pairs`: per family, each DISTINCT pair reading (fingerprint key → its columns), so a
 *    pair declared twice identically is one.
 *  - `axes`: every column that is a coordinate axis. */
interface RoleUnits {
  readings: Map<string, Set<string>>;
  pairs: Map<string, Map<string, string[]>>;
  axes: Set<string>;
}

function roleUnits(roles: ColumnRoles | null | undefined): RoleUnits {
  const pairs = new Map<string, Map<string, string[]>>();
  const axes = new Set<string>();
  for (const [kind, entry] of roleEntries(roles)) {
    if (!isPairKind(kind)) continue;
    const fingerprints = roleEntryFingerprints(kind, entry);
    const columns = [...fingerprints.keys()];
    const family = pairs.get(kind) ?? new Map<string, string[]>();
    family.set(fingerprintKey(comparableFingerprint(fingerprints)), columns);
    pairs.set(kind, family);
    for (const column of columns) axes.add(column);
  }
  return { readings: roleFingerprints(roles), pairs, axes };
}

/** A column's readings that are not a pair's, told by the reading's kind (its first element). */
function ownReadings(units: RoleUnits, column: string): Set<string> {
  return new Set([...(units.readings.get(column) ?? [])].filter((r) => !isPairKind((JSON.parse(r) as unknown[])[0])));
}

/** THE BAR'S COUNT: how many ROLE CHANGES `now` makes to `was`, counted by the unit the
 *  owner edits, not by column (operator, 2026-09-28: "Count it once"). Counted by column, one
 *  edit to a map's projection read "2 invalidating role changes", because both of a pair's
 *  columns read its settings, and so did adding one pair.
 *
 *  THE RULE (CONTRACT §4, "What the bar's count counts"):
 *
 *  - PAIR ENTRIES (scatter or geographic), MATCHED PER FAMILY: the larger of how many LEFT
 *    and how many ARRIVED — the fewest entry edits that turn the committed entries into the
 *    draft's. A pair added is 1, removed 1, with its settings changed 1, and REPLACED BY AN
 *    UNRELATED PAIR also 1: a removal and an addition in one family match as one entry
 *    repointed, as the pipeline reads it (a lone entry's layout keeps its id and goes stale).
 *    No designer control makes that swap. Entries compare by `fingerprintKey` (columns,
 *    axis order, knobs with defaults filled; never the label) as a SET of distinct
 *    readings, so declaration order does not matter, and a pair declared twice identically
 *    is ONE reading: `changedColumns` compares readings, so a copy that left beside it moves
 *    no column, and counting it would count a change the bar lists no column for (review of
 *    #400, finding 3). A valid draft cannot hold two entries with one key (`validateDraft`
 *    refuses a pair declared twice), so only a committed duplicate is affected.
 *  - PLUS ONE PER OTHER CHANGED COLUMN: a column in `changedColumns` that is an axis of no
 *    entry that left or arrived. Its choice, datetime format or tag delimiter moved, or the
 *    draft could not hold a second role it had (CONTRACT §3).
 *
 *  THE TWO EDGE CASES, decided:
 *
 *  - A column in TWO changed pairs counts in each pair and never on its own: 2.
 *  - A column whose OWN role changed AS WELL AS its pair counts in the pair, and AGAIN on its
 *    own unless the only change to its own role is losing `freeform` because it is now a
 *    coordinate axis. `buildColumnRoles` drops freeform from every axis, and a Display-only
 *    column IS freeform, so adding a pair over two Display-only columns is one change, not
 *    three. A role it gained, or any other role it lost (a categorical made Ignore, then
 *    paired), is its own edit: it orphans or renames a layout whatever the pair does.
 *
 *  It REGROUPS `changedColumns` and never adds to them, so it is 0 exactly when they are
 *  empty. Two things hold that, and the caller relies on both:
 *
 *  - `now` MUST BE A MAP THE DRAFT COMPILED TO (or, with nothing edited, the committed map).
 *    With no compiled map — images-only, a null draft, or a draft `validateDraft` refuses —
 *    there is nothing to compare the committed roles with, and `derivePending` does not call
 *    this at all: the count is 0, as `changedColumns` is. Called with an empty `now`, every
 *    committed pair counted as LEFT: an untouched collection whose committed roles the form
 *    refuses (a scatter against itself, a pair declared twice) read "1 invalidating role
 *    change" with no column, and a refused edit priced a phantom count beside its problem
 *    (operator's review of #400, findings 1–3).
 *  - THE GUARD below: with no changed column, nothing is counted. Over a compiled map the
 *    rule already gives 0 — a pair reading (`["scatter", "x", <partner>, …knobs]`) names its
 *    whole entry, so while every column reads as it did no distinct reading left or arrived —
 *    but the guard makes the bound a property of this function rather than of its caller.
 *    With some changed column the count is never 0, because such a column either had its own
 *    role move or is an axis of an entry that left or arrived, and a pair edit counts at
 *    least one. */
function roleChangeCount(was: RoleUnits, now: RoleUnits, changedColumns: readonly string[]): number {
  if (changedColumns.length === 0) return 0;
  let count = 0;
  // The axes of every entry that left or arrived: a changed column among them is the pair's.
  const pairAxes = new Set<string>();
  for (const kind of PAIR_ROLE_KINDS) {
    const had = was.pairs.get(kind) ?? new Map<string, string[]>();
    const has = now.pairs.get(kind) ?? new Map<string, string[]>();
    const left = [...had].filter(([key]) => !has.has(key));
    const arrived = [...has].filter(([key]) => !had.has(key));
    count += Math.max(left.length, arrived.length);
    for (const [, columns] of [...left, ...arrived]) for (const column of columns) pairAxes.add(column);
  }
  for (const column of changedColumns) {
    if (!pairAxes.has(column)) {
      count += 1;
      continue;
    }
    const had = ownReadings(was, column);
    const has = ownReadings(now, column);
    const gained = [...has].some((r) => !had.has(r));
    const lost = [...had].some((r) => !has.has(r) && !(r === FREEFORM_READING && now.axes.has(column)));
    if (gained || lost) count += 1;
  }
  return count;
}

/** Derive the bar and the per-layout outcomes from the model and the layout list
 *  (`GET .../layouts`, labels already made effective by the caller). */
export function derivePending(state: PendingState, layouts: readonly LayoutInfo[]): PendingDerivation {
  const committed = committedLayouts(layouts);
  const labelOf = (id: string): string => committed.find((l) => l.layout_id === id)?.label ?? id;
  const edited = canonicalJson(state.draft) !== canonicalJson(state.seed);
  // Validated whether or not it was edited: a CLI-authored map can seed a draft the form
  // would refuse (a scatter plotted against itself is legal to the pipeline), and
  // `buildColumnRoles` throws on one. Only an EDITED draft's problem is the user's to see.
  const draftProblem = state.draft !== null ? validateDraft(state.draft) : null;
  const problem = edited ? draftProblem : null;

  let roles: ColumnRoles | null = null;
  let changedColumns: string[] = [];
  // The committed side, cached: it moves only on commit or load, never on a keystroke
  // (operator's review of #400, finding 7). `after` stays empty with no compiled map.
  const before = committedRoleUnits(state.committed);
  let after: RoleUnits = NO_UNITS;
  const outcomes: LayoutOutcome[] = [];
  let producible = new Set<string>(["grid"]);
  let fresh = new Map<string, string>();
  // The draft queued bakes are named from: the draft, or with nothing edited the committed
  // roles' (`bakeNamingDraft`).
  let naming: RolesDraft | null = state.draft;

  if (state.draft !== null && draftProblem === null) {
    // THE COMPILED DRAFT, and THE ROLES THIS DERIVATION REPORTS, are not the same thing
    // when nothing has been edited (2026-09-24 round-2 review, N2).
    // `rolesDraftFromColumnRoles` cannot represent a column carrying two roles — `choice`
    // is last-write-wins and `freeform` is assigned after `tag` — so compiling an UNTOUCHED
    // seed produces a map that differs from the committed one, and the bar then reports an
    // invalidating role change on a screen nobody has touched. Reporting the COMMITTED map
    // when `!edited` makes `changedColumns`, `outcomes`, `isPending` and `tags` all say
    // "nothing", together, and makes `derived.roles` safe to POST (it is a no-op rather
    // than a silent drop of the second role).
    //
    // `compiled` is still what the DRAFT would bake, so the bake-id resolution below stays
    // self-consistent — zipping `producibleLayouts(draft)` against a map built from
    // anything else is what `familyIdsBySourceColumns`' length check throws on.
    //
    // The underlying data loss is NOT fixed here: `roles.ts` is consumed unchanged
    // (CONTRACT §3), and ANY commit the designer makes still drops a column's second role.
    // [[T2-the-roles-draft-cannot-hold-a-column-s-second]].
    const compiled = buildColumnRoles(state.draft);
    roles = edited ? compiled : state.committed;
    after = roles === state.committed ? before : roleUnits(roles);
    changedColumns = changedBetween(before.readings, after.readings);
    // `producible` and `fresh` feed `outcomes` only when edited (below), and the queued
    // bakes always — so with nothing edited they are named from the committed roles.
    const named = edited ? state.draft : bakeNamingDraft(state.draft, state.committed);
    naming = named;
    producible = new Set(["grid", ...producibleLayouts(named).map((p) => p.layout_id)]);
    fresh = familyIdsBySourceColumns(named, named === state.draft ? compiled : buildColumnRoles(named));
    // The PER-ENTRY staleness test (`_classify_layout_staleness`, manifest 2.10): what each
    // committed layout was BAKED with, against what the DRAFT still declares — matched and
    // counted against entries, never against a per-column union. `changedColumns` stays
    // whole-column: it answers "which columns changed?" for the bar's line, which is a
    // question about columns, not about layouts.
    const committedEntries = committedEntryFingerprints(state.committed);
    const draftEntries = entryFingerprintsBySourceColumns(roles);
    // `known && sources.length > 0` is the judgeable population: a non-list `source_columns`
    // is a pre-2.9 entry (unknown, never stale), and `[]` is the positive "reads nothing".
    // A layout with no locatable before-state gets `own === undefined` and is STALE — never
    // fresh, because absence is never a positive claim of freshness.
    const judgeable = committed.filter(
      (l) => !isGrid(l) && Array.isArray(l.source_columns) && l.source_columns.length > 0,
    );
    const owned = judgeable
      .map((layout) => ({ layout, own: ownFingerprint(layout, committedEntries) }))
      .filter((o): o is { layout: LayoutInfo; own: Fingerprint } => o.own !== undefined);
    const unlocatable = new Set(
      judgeable.filter((l) => !owned.some((o) => o.layout === l)).map((l) => l.layout_id),
    );
    // NEWLY staled, not "stale" (2026-09-24 round-2 review, N1). `own` is the BAKE RECORD,
    // so testing it against the draft alone also catches layouts an EARLIER commit already
    // staled — and `LayoutOutcome.stale`, `outcomeFor` and the bar all promise "what would
    // this PENDING edit do?". Reported that way, the bar blames an edit to `group` for a
    // datetime layout staled last week, and D-xxix would re-queue an already-stale layout
    // on every later unrelated commit, even after the operator removed it from the queue.
    //
    // So: stale under the draft AND NOT already stale under the committed roles. A round
    // trip back to what was baked still reads fresh (the record matches the draft), and a
    // layout that simply STAYS stale is carried by `derived.baked`, which is the field
    // whose job that is.
    const staleIds = setDifference(
      staleAgainstEntries(owned, draftEntries),
      staleAgainstEntries(owned, committedEntries),
    );

    // NO EDIT, NO OUTCOMES. `outcomes` answers "what would this PENDING edit do", so with
    // nothing edited there is nothing to answer — and the rename/orphan half must be
    // skipped too, not just the staleness half: `producible` came from
    // `producibleLayouts(state.draft)`, and an untouched LOSSY seed (a column carrying two
    // roles) no longer produces the layout whose role it dropped, which surfaced as a
    // phantom `orphaned` on a screen nobody had touched (2026-09-24 round-2 review, N2).
    // (With nothing edited it is named from the committed roles now — `bakeNamingDraft` —
    // but a pending edit's outcomes still have nothing to answer then.)
    for (const layout of edited ? committed : []) {
      if (isGrid(layout)) continue;
      const sources = layout.source_columns;
      const known = Array.isArray(sources);
      const stale = staleIds.has(layout.layout_id) || unlocatable.has(layout.layout_id);
      const unknown = !known && changedColumns.length > 0;
      // `_classify_unproducible_layouts`: a committed id the new roles do not produce is a
      // RENAME only when an entry of the same type with the WHOLE source tuple, in order,
      // now bakes under another id. Anything else — a partial match, no provenance — is
      // an orphan.
      let renamedTo: string | null = null;
      let orphaned = false;
      if (!producible.has(layout.layout_id)) {
        const next = known && sources.length > 0 ? fresh.get(entryKey(layout.type, sources)) : undefined;
        if (next !== undefined && next !== layout.layout_id) renamedTo = next;
        else orphaned = true;
      }
      if (stale || unknown || orphaned || renamedTo !== null) {
        outcomes.push({ layout_id: layout.layout_id, label: layout.label, stale, renamedTo, orphaned, unknown });
      }
    }
  }

  const committedIds = new Set(committed.map((l) => l.layout_id));
  const labelsById = new Map(
    naming !== null ? producibleLayouts(naming).map((p) => [p.layout_id, p.label] as const) : [],
  );
  const bakes: ResolvedBake[] = state.bakes.map((entry) => {
    const key = bakeKey(entry);
    if (entry.kind === "rebake") {
      if (!committedIds.has(entry.layout_id)) {
        return { entry, key, layout_id: null, label: entry.layout_id, problem: "not a baked layout of this collection" };
      }
      // Only a layout the working roles still produce can be re-baked under its own id.
      if (roles !== null && !producible.has(entry.layout_id)) {
        return { entry, key, layout_id: null, label: labelOf(entry.layout_id), problem: "the new roles no longer produce it" };
      }
      return { entry, key, layout_id: entry.layout_id, label: labelOf(entry.layout_id), problem: null };
    }
    const label = entry.source_columns.join(" / ");
    if (roles === null) {
      return { entry, key, layout_id: null, label, problem: draftProblem ?? "this collection has no roles to bake it from" };
    }
    const id = fresh.get(entryKey(entry.type, entry.source_columns));
    if (id === undefined) {
      return { entry, key, layout_id: null, label, problem: "the working roles do not declare it" };
    }
    if (committedIds.has(id)) {
      return { entry, key, layout_id: id, label: labelsById.get(id) ?? label, problem: "already baked — queue a re-bake instead" };
    }
    return { entry, key, layout_id: id, label: labelsById.get(id) ?? label, problem: null };
  });

  // Counted only over a compiled map: with none (images-only, a null draft, a refused draft)
  // nothing is compared, so nothing is counted — `problem` says what is wrong instead.
  const invalidating = roles !== null ? roleChangeCount(before, after, changedColumns) : 0;
  const bakeCount = bakes.length;
  return {
    problem,
    roles,
    changedColumns,
    outcomes,
    baked: bakedStaleness(state, layouts),
    tags: tagDerivation(state, roles, edited),
    bakes,
    invalidating,
    bakeCount,
    isPending: invalidating > 0 || bakeCount > 0 || problem !== null,
  };
}

/** The candidate map for the COMMITTED roles, memoized on their identity.
 *
 *  `derivePending` runs on every keystroke, and this map depends only on `state.committed`,
 *  which changes on commit or load and never on a keystroke (2026-09-23 review, finding
 *  11). A `WeakMap` keeps the cache exactly as long as the roles object lives, so a
 *  collection the user navigated away from is collected with it. Null roles (images-only)
 *  memoize to a shared empty map. */
const COMMITTED_ENTRIES = new WeakMap<ColumnRoles, Map<string, Fingerprint[]>>();
const NO_ENTRIES: Map<string, Fingerprint[]> = new Map();

function committedEntryFingerprints(roles: ColumnRoles | null | undefined): Map<string, Fingerprint[]> {
  if (roles === null || roles === undefined) return NO_ENTRIES;
  const hit = COMMITTED_ENTRIES.get(roles);
  if (hit !== undefined) return hit;
  const built = entryFingerprintsBySourceColumns(roles);
  COMMITTED_ENTRIES.set(roles, built);
  return built;
}

/** ...and the committed side of the role-change count and of `changedColumns`, memoized the
 *  same way and for the same reason (operator's review of #400, finding 7): rebuilt on every
 *  keystroke, it walked every committed entry twice. Null roles memoize to a shared empty
 *  one, which is also what `after` is while nothing compiles. */
const COMMITTED_UNITS = new WeakMap<ColumnRoles, RoleUnits>();
const NO_UNITS: RoleUnits = { readings: new Map(), pairs: new Map(), axes: new Set() };

function committedRoleUnits(roles: ColumnRoles | null | undefined): RoleUnits {
  if (roles === null || roles === undefined) return NO_UNITS;
  const hit = COMMITTED_UNITS.get(roles);
  if (hit !== undefined) return hit;
  const built = roleUnits(roles);
  COMMITTED_UNITS.set(roles, built);
  return built;
}

/** ...and the whole durable verdict, memoized on the identity of the LAYOUT LIST it was
 *  computed from (2026-09-24 round-2 review, N6). Memoizing only the entry map left the
 *  per-column union and every layout's verdict running on every keystroke, which is most
 *  of the cost and all of the point. `layouts` is the outer key because the shell hands
 *  down a new array only when it re-fetches; the roles object is the inner one, so a
 *  roles commit invalidates it as well. A `WeakMap` on each keeps both collectable. */
const BAKED_BY_LAYOUTS = new WeakMap<object, WeakMap<object, BakedStaleness[]>>();
const NO_ROLES_KEY: object = Object.freeze({});

/** `derived.baked`: what the BAKE recorded against what the COMMITTED roles say now.
 *  Deliberately not against the draft — this is the durable flag D-xxix needs to outlive
 *  the commit that caused it, so it must be the same answer on a screen with nothing
 *  pending as it was the moment the roles were committed.
 *
 *  The same rule the prediction uses, on the same two helpers, so the two cannot diverge:
 *  the bake record is `own`, and it is matched and COUNTED against the committed roles'
 *  ENTRIES rather than their per-column union — with two entries over one pair, a union
 *  leaves the changed layout reading fresh (2026-09-23 review, finding 2). */
function bakedStaleness(state: PendingState, layouts: readonly LayoutInfo[]): BakedStaleness[] {
  // Keyed on the list the CALLER passed, not on the filtered committed rows: the filter
  // builds a fresh array on every derivation, so keying on it never hits.
  const rolesKey: object = state.committed ?? NO_ROLES_KEY;
  const byRoles = BAKED_BY_LAYOUTS.get(layouts) ?? new WeakMap<object, BakedStaleness[]>();
  const hit = byRoles.get(rolesKey);
  if (hit !== undefined) return hit;
  const built = computeBakedStaleness(state, committedLayouts(layouts));
  byRoles.set(rolesKey, built);
  BAKED_BY_LAYOUTS.set(layouts, byRoles);
  return built;
}

function computeBakedStaleness(state: PendingState, committed: readonly LayoutInfo[]): BakedStaleness[] {
  const entries = committedEntryFingerprints(state.committed);
  const union = committedRoleUnits(state.committed).readings;
  // A `[]` provenance names no role entry — nothing is ever keyed `("grid", [])` — so grid
  // must not be in the population the entry match runs over (2026-09-24 round-2 review,
  // N5). It read fresh only because the `staleColumns` fallback happened to come out
  // empty; a hand-edited grid record already reported a column. The other two paths filter
  // exactly this way.
  const owned = committed
    .filter((l) => Array.isArray(l.source_columns) && l.source_columns.length > 0)
    .map((layout) => ({ layout, own: recordedFingerprint(layout) }))
    .filter((o): o is { layout: LayoutInfo; own: Fingerprint } => o.own !== null);
  const stale = staleAgainstEntries(owned, entries);
  return committed.map((layout) => {
    const recorded = recordedFingerprint(layout);
    // Absent is UNCHECKED, and `{}` is not absent: `{}` is a 2.10 producer saying "this
    // layout reads no column", which grid always says and which makes grid checkable and
    // never stale. `{}` is truthy in JS but `== null` catches only null/undefined, which
    // is the distinction that has to survive here.
    if (recorded === null) {
      // ...EXCEPT that a `[]` provenance already answers the question without a record
      // (2026-09-23 review, finding 9). Grid reads no column, so it cannot be stale — the
      // other two answers treat `[]` as that positive claim, and reporting every pre-2.10
      // collection's grid as "unchecked" made the durable view disagree with them about
      // the one layout whose answer is certain.
      const reads = Array.isArray(layout.source_columns) ? layout.source_columns.length : -1;
      return { layout_id: layout.layout_id, checkable: reads === 0, staleColumns: [] };
    }
    if (!stale.has(layout.layout_id)) {
      return { layout_id: layout.layout_id, checkable: true, staleColumns: [] };
    }
    // WHICH columns moved, for the row's line. The union is the informative subset — the
    // columns whose recorded reading the roles no longer declare at all. When it is empty
    // the layout is stale for the duplicate-entry reason (its declaration was consumed by
    // a sibling), and every column it reads is implicated, so name them all rather than
    // report "stale" with nothing beside it.
    const missing = [...recorded]
      .filter(([column, tuples]) => [...tuples].some((t) => !(union.get(column)?.has(t) ?? false)))
      .map(([column]) => column);
    // ...falling back to the record's own columns, and then to the layout's provenance. The
    // second fallback matters for a record that is present but says nothing — `{}` on a
    // column-reading layout, or a column whose tuple list is empty or malformed — which is
    // stale (it matches no declaration) and would otherwise be stale with no column named.
    const named = missing.length > 0 ? missing : [...recorded.keys()];
    const staleColumns = (named.length > 0 ? named : (layout.source_columns ?? [])).slice().sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return { layout_id: layout.layout_id, checkable: true, staleColumns };
  });
}

/** `derived.tags`: the tag index's two warnings, predicted. See `TagDerivation`. */
function tagDerivation(state: PendingState, roles: ColumnRoles | null, edited: boolean): TagDerivation {
  const committedTags = new Map((state.committed?.tag ?? []).map((t) => [t.column, t.delimiter]));
  // GATED ON `edited`, exactly as `problem` is, and for the same reason (2026-09-23 review,
  // finding 5). `rolesDraftFromColumnRoles` is lossy: `choice` is last-write-wins and
  // `freeform` is assigned after `tag`, so a CLI-authored column carrying BOTH seeds a
  // draft with no tag role at all. Ungated, that collection opened and left alone warns
  // "tag filtering goes away when you commit" — about an edit nobody made.
  if (!edited) return { unservedColumns: [], removesLastTagRole: false };
  // Null roles = images-only, or a draft that cannot compile: nothing is being declared,
  // so nothing can be predicted. A DRAFT PROBLEM must not read as "you removed every tag
  // role" — that is a claim about an edit the user has not finished making.
  if (roles === null) return { unservedColumns: [], removesLastTagRole: false };
  const draftTags = roles.tag ?? [];
  const unservedColumns = draftTags
    .filter((t) => committedTags.get(t.column) !== t.delimiter)
    .map((t) => t.column)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    unservedColumns,
    removesLastTagRole: committedTags.size > 0 && draftTags.length === 0,
  };
}

/** The outcome for one layout, or undefined when the pending edit leaves it alone. */
export function outcomeFor(derived: PendingDerivation, layoutId: string): LayoutOutcome | undefined {
  return derived.outcomes.find((o) => o.layout_id === layoutId);
}

/** The durable bake record's verdict for one layout, or undefined when it is not a
 *  committed layout of this collection. */
export function bakedFor(derived: PendingDerivation, layoutId: string): BakedStaleness | undefined {
  return derived.baked.find((b) => b.layout_id === layoutId);
}

// ---------------------------------------------------------------------------
// The bar's words (RoleConsequences)
// ---------------------------------------------------------------------------

function layoutsNoun(n: number): string {
  return `${n} layout${n === 1 ? "" : "s"}`;
}

/** The commit bar, as text. At most two counts, each with one consequence line, in
 *  `RoleConsequences`' wording:
 *
 *    stale    → "stales {Layout}"
 *    renamed  → "nothing stale"
 *    orphaned → "{n} layout(s) can't be re-baked"
 *    unknown  → "{n} layout(s) unchecked"
 *
 *  Several outcomes at once are joined with " · "; "nothing stale" is said only when no
 *  other outcome is. Nothing here prices anything: there is no measured estimate to
 *  show, and a guessed one would be worse than none. */
export interface BarSummary {
  /** Nothing pending: the bar says so and prices nothing. */
  empty: boolean;
  /** An edited draft that cannot be committed as it stands. */
  problem: string | null;
  invalidating: { count: number; title: string; columns: string[]; consequence: string } | null;
  bakes: { count: number; title: string; consequence: string } | null;
}

export function barSummary(derived: PendingDerivation): BarSummary {
  let invalidating: BarSummary["invalidating"] = null;
  if (derived.invalidating > 0) {
    const stale = derived.outcomes.filter((o) => o.stale).map((o) => o.label);
    const orphaned = derived.outcomes.filter((o) => o.orphaned).length;
    const unknown = derived.outcomes.filter((o) => o.unknown).length;
    const parts: string[] = [];
    if (stale.length > 0) parts.push(`stales ${stale.join(", ")}`);
    if (orphaned > 0) parts.push(`${layoutsNoun(orphaned)} can't be re-baked`);
    if (unknown > 0) parts.push(`${layoutsNoun(unknown)} unchecked`);
    const n = derived.invalidating;
    invalidating = {
      count: n,
      title: `${n} invalidating role change${n === 1 ? "" : "s"}`,
      columns: derived.changedColumns,
      consequence: parts.length > 0 ? parts.join(" · ") : "nothing stale",
    };
  }
  let bakes: BarSummary["bakes"] = null;
  if (derived.bakeCount > 0) {
    const n = derived.bakeCount;
    const blocked = derived.bakes.filter((b) => b.problem !== null).length;
    // Every queued bake goes in ONE add-layouts run (the layouts route takes a list).
    bakes = {
      count: n,
      title: `${n} bake${n === 1 ? "" : "s"} to run`,
      consequence: blocked > 0 ? `one run · ${blocked} can't bake as queued` : "one run",
    };
  }
  return {
    empty: !derived.isPending,
    problem: derived.problem,
    invalidating,
    bakes,
  };
}

// ---------------------------------------------------------------------------
// Persistence — a pending draft can be thirty edits, so a reload must not lose it
// ---------------------------------------------------------------------------

/** Per-collection localStorage key prefix. The full key is `prefix + dataset_id`. */
export const PENDING_STORAGE_PREFIX = "plotlas.designer.pending.";

export function pendingStorageKey(datasetId: string): string {
  return `${PENDING_STORAGE_PREFIX}${datasetId}`;
}

/** What is written: the edits, plus the BASE they were drafted against — the
 *  `dataset_version` AND the committed roles. Both, because either can move under a
 *  draft: a bake bumps the version, and a roles-only commit (`run_set_roles`) rewrites
 *  `column_roles` WITHOUT bumping it (worker.py: "dataset_version does NOT bump"). A
 *  draft whose base is gone describes edits to something that no longer exists, so it
 *  is dropped, silently. */
interface PersistedPending {
  v: 1;
  datasetVersion: number;
  base: string;
  draft: RolesDraft | null;
  bakes: BakeEntry[];
}

/** JSON with object keys sorted at every level — so two equal values always serialize
 *  equal, whatever order their keys were written in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

export function serializePending(state: PendingState, datasetVersion: number): string {
  const record: PersistedPending = {
    v: 1,
    datasetVersion,
    base: canonicalJson(state.committed),
    draft: state.draft,
    bakes: state.bakes,
  };
  return JSON.stringify(record);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural check on a persisted draft — enough that `validateDraft`/`buildColumnRoles`
 *  cannot trip over a malformed value from storage. */
function isRolesDraft(v: unknown): v is RolesDraft {
  return (
    isRecord(v) &&
    isStringArray(v.columns) &&
    isRecord(v.choice) &&
    typeof v.datetimeFormat === "string" &&
    isRecord(v.tagDelimiters) &&
    Array.isArray(v.scatterPairs) &&
    Array.isArray(v.geoPairs) &&
    isRecord(v.labels)
  );
}

function isBakeEntry(v: unknown): v is BakeEntry {
  if (!isRecord(v)) return false;
  if (v.kind === "rebake") return typeof v.layout_id === "string";
  return (
    v.kind === "new" &&
    (v.type === "datetime" || v.type === "categorical" || v.type === "scatter" || v.type === "geographic") &&
    isStringArray(v.source_columns)
  );
}

/** The datetime format a draft may send for `column` (D-xxxiii: "format" exists only at
 *  upload, so no view here offers one). The COMMITTED format when the committed roles
 *  already make `column` the datetime, and `iso8601` for any other column: only a column
 *  ingest stored as timestamps can take the role (`dataModel.roleLock`), and `iso8601` is
 *  the format that lays those out at their own dates. With no datetime column in the draft
 *  (`column` undefined) it is the committed one, which is what the seed holds, so moving the
 *  datetime off a column and back is not an edit. */
export function datetimeFormatFor(committed: ColumnRoles | null, column: string | undefined): DatetimeFormat {
  const declared = committed?.datetime;
  if (declared == null) return "iso8601";
  return column === undefined || column === declared.column ? declared.format : "iso8601";
}

/** `draft` with the two settings no view here edits put back to what a commit may send
 *  (review of #394, finding 7). The one place that does it: `restorePending` runs it on
 *  every restored draft, and the Data view after every role change, so a session and a
 *  reload always hold the same model.
 *
 *  - `datetimeFormat` → `datetimeFormatFor(committed, datetimeColumn(draft))` (D-xxxiii: no
 *    format control after ingest). Recomputed from the RESULT's datetime column, so the
 *    datetime moving onto a column and off again leaves nothing behind (finding 1).
 *  - each committed tag column's delimiter → its committed delimiter (the delimiter is
 *    applied at ingest and read-only here, CONTRACT §4a). A column the committed roles tag
 *    twice (the CLI accepts it) wants its LAST entry's, the one the seed keeps
 *    (`rolesDraftFromColumnRoles`, last write wins), or the correction is not idempotent
 *    (re-review of #394, N1). A column re-tagged after an earlier commit un-tagged it has no
 *    committed delimiter and keeps the draft's
 *    ([[T2-a-re-tagged-column-declares-a-delimiter-nobody]]).
 *
 *  Either can hold another value only in a draft saved by an older build: shown nowhere,
 *  marked changed, and sent on commit. Returns `draft` itself when nothing moves. */
export function sendableDraft(draft: RolesDraft, committed: ColumnRoles | null): RolesDraft {
  const datetimeFormat = datetimeFormatFor(committed, datetimeColumn(draft));
  const want: Record<string, string> = Object.fromEntries((committed?.tag ?? []).map((t) => [t.column, t.delimiter]));
  const moved = Object.entries(want).filter(([column, delimiter]) => draft.tagDelimiters[column] !== delimiter);
  if (draft.datetimeFormat === datetimeFormat && moved.length === 0) return draft;
  return { ...draft, datetimeFormat, tagDelimiters: { ...draft.tagDelimiters, ...Object.fromEntries(moved) } };
}

/** Rebuild a persisted model on top of a freshly seeded one, or null when the record is
 *  absent, malformed, or drafted against a base that has since moved. Never throws. */
export function restorePending(raw: string | null, fresh: PendingState, datasetVersion: number): PendingState | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  if (parsed.datasetVersion !== datasetVersion) return null;
  if (parsed.base !== canonicalJson(fresh.committed)) return null;
  const draft = parsed.draft;
  if (fresh.committed === null ? draft !== null : !isRolesDraft(draft)) return null;
  if (!Array.isArray(parsed.bakes) || !parsed.bakes.every(isBakeEntry)) return null;
  const restored: PendingState = {
    ...fresh,
    draft: draft === null ? null : sendableDraft(draft as RolesDraft, fresh.committed),
    bakes: parsed.bakes as BakeEntry[],
  };
  // The shape check above is not a guarantee that the model can WALK it. A draft can pass
  // it and still hold values `validateDraft` / `buildColumnRoles` dereference blind —
  // `scatterPairs: [null]` threw `Cannot read properties of null (reading 'x')` inside
  // render, and since the record was kept, on EVERY load. `v: 1` cannot catch it either:
  // a build that changes `RolesDraft` (seam L4 will) still writes `v: 1`. So restoring
  // means running the same two functions the shell will run on it, here, where a throw
  // can drop the record instead of taking the screen down.
  try {
    if (restored.draft !== null) validateDraft(restored.draft);
    derivePending(restored, []);
  } catch {
    return null;
  }
  return restored;
}

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage access itself can throw (sandboxed iframe etc.)
  }
}

/** The persisted model for this collection, or `fresh` when there is none worth
 *  restoring. A record drafted against a moved base is REMOVED as it is dropped, so it
 *  cannot resurface — and so is one the restore's correction (`sendableDraft`) leaves with
 *  nothing pending, which would otherwise be re-read on every visit with no Discard to
 *  clear it (review of #394, finding 5). */
export function loadPending(
  datasetId: string,
  datasetVersion: number,
  fresh: PendingState,
  store: KeyValueStore | null = defaultStore(),
): PendingState {
  if (store === null) return fresh;
  try {
    const raw = store.getItem(pendingStorageKey(datasetId));
    if (raw === null) return fresh;
    const restored = restorePending(raw, fresh, datasetVersion);
    if (restored === null || !hasEdits(restored)) store.removeItem(pendingStorageKey(datasetId));
    return restored ?? fresh;
  } catch {
    return fresh;
  }
}

/** Persist the model — or remove the record when nothing is left to keep. Best-effort:
 *  a full or absent store loses reload-survival, never the edits in memory. */
export function savePending(
  datasetId: string,
  datasetVersion: number,
  state: PendingState,
  store: KeyValueStore | null = defaultStore(),
): void {
  if (store === null) return;
  try {
    if (hasEdits(state)) store.setItem(pendingStorageKey(datasetId), serializePending(state, datasetVersion));
    else store.removeItem(pendingStorageKey(datasetId));
  } catch {
    // Storage full / unavailable — nothing actionable.
  }
}

/** Forget this collection's persisted model (after a commit, or a collection delete). */
export function clearPending(datasetId: string, store: KeyValueStore | null = defaultStore()): void {
  if (store === null) return;
  try {
    store.removeItem(pendingStorageKey(datasetId));
  } catch {
    // Nothing actionable.
  }
}
