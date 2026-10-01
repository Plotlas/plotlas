// The designer's DATA view — its pure half (seam L4; LAYOUT_DESIGNER D-xxiii/D-xxvii;
// boards `Data`, `RoleDensity`, `TagSidecar`, `RoleConsequences`).
//
// What the role table SHOWS, decided without React: which group each column lands in,
// which rows are coordinate-pair pointers, which layouts a column built, the words on the
// row for what an edit does to them, and the one data-loss defect the view must name
// rather than hide. `data.ts` draws it; everything here is node-test importable.
//
// It reads the pending model and never writes it — the one write, `withDraft`, is the
// view's, on a user's action (CONTRACT §3).
import type { ColumnRoles } from "../../generated/column_roles";
import type { LayoutInfo } from "../../api-client/types";
import { datetimeColumn } from "../admin/roles";
import type { ColumnRoleChoice, RolesDraft } from "../admin/roles";
import { roleWord } from "./heldRoles";
import type { HeldRoleConflict } from "./heldRoles";
import type { PendingDerivation } from "./pending";
import { bakedFor, outcomeFor } from "./pending";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The Role select — `ColumnRoleChoice`, and nothing else. There is deliberately no
 *  scatter or geographic choice: a coordinate pair IS a layout and is picked on the layout
 *  card (D-xxiii), which is also what makes the double-projection error unrepresentable.
 *  The words are the wizard's (RoleAssignmentForm), which does not export them. */
export const ROLE_OPTIONS: readonly { value: ColumnRoleChoice; label: string }[] = [
  { value: "ignore", label: "Ignore" },
  { value: "filename", label: "Filename (join key)" },
  { value: "datetime", label: "Datetime" },
  { value: "categorical", label: "Categorical" },
  { value: "tag", label: "Tags" },
  { value: "freeform", label: "Freeform (display only)" },
];

// ---------------------------------------------------------------------------
// What the stored column can take (review of #384, F2)
// ---------------------------------------------------------------------------

/** DuckDB's names for a parquet timestamp (`GET .../columns` reports the source's own
 *  type): TIMESTAMP, TIMESTAMP_S/_MS/_NS, TIMESTAMP WITH TIME ZONE. Not DATE. */
const TIMESTAMP_DTYPE = /^TIMESTAMP(?:_(?:S|MS|NS))?(?:\s+WITH\s+TIME\s+ZONE)?$/i;
/** DuckDB's name for a parquet list column: `<type>[]` — how `DESCRIBE` reports the
 *  `list<string>` ingest writes for a tag (measured: `tags` → `VARCHAR[]`). */
const LIST_DTYPE = /\[\]$/;

/** Why the worker would refuse `choice` on a column stored as `dtype`, or null when it
 *  would not (or the type is unknown — the column list failed — and the worker decides).
 *
 *  `set-roles` validates against the committed parquet (`worker.
 *  _validate_roles_against_parquet`): a tag must be a LIST and a datetime a TIMESTAMP. The
 *  parquet is written only by ingest and a roles commit never rewrites it, so a column is a
 *  list only if it was a tag at ingest, and a timestamp only if it was an iso8601 datetime
 *  there. Measured 2026-09-25 on a copy of golden_dataset_full_v2 (`pixscope set-roles`):
 *  `caption` (string) as a tag → "tag column is string in metadata.parquet, not a list";
 *  `group` (string) as the datetime → "... not a timestamp". */
export function roleLock(choice: ColumnRoleChoice, dtype: string | undefined): string | null {
  if (dtype === undefined) return null;
  if (choice === "tag" && !LIST_DTYPE.test(dtype.trim())) return "needs a list column — only a column split into tags at ingest is one";
  if (choice === "datetime" && !TIMESTAMP_DTYPE.test(dtype.trim())) {
    return "needs a timestamp column — only a column parsed as dates at ingest is one";
  }
  return null;
}

/** Why `option` cannot be chosen for `column`, or null — every refusal the Role select must
 *  show rather than offer (the `KnobOption.disabled` contract): what the worker refuses on
 *  the stored type (`roleLock`), and what `validateDraft` refuses outright — "At most one
 *  column can be the datetime." (second review of #384, #6). The column's current role is
 *  never locked. The join key's own lock is the caller's (it is not a validation rule). */
export function choiceLock(
  option: ColumnRoleChoice,
  column: string,
  dtype: string | undefined,
  draft: RolesDraft,
  // The datetime column (null: none), found ONCE per render by the caller: a `find` per
  // option per row made this O(n²) (round-4 review of #384). Required and null-for-none on
  // purpose — a default parameter re-runs the `find` whenever `undefined` is passed, which is
  // exactly the no-datetime case, and measured no faster at all.
  holder: string | null,
): string | null {
  if (option === (draft.choice[column] ?? "ignore")) return null;
  const typeLock = roleLock(option, dtype);
  if (typeLock !== null) return typeLock;
  if (option === "datetime" && holder !== null && holder !== column) {
    return `${holder} is the datetime, and a collection has one — move ${holder} off it first`;
  }
  return null;
}

/** `choiceLock` for a BULK change over `columns`: the first refusal any of them meets, plus
 *  the one only a bulk change can make — two or more columns made the datetime at once. */
export function bulkChoiceLock(option: ColumnRoleChoice, columns: readonly string[], dtypes: ReadonlyMap<string, string>, draft: RolesDraft): string | null {
  if (option === "datetime" && columns.filter((c) => draft.choice[c] !== "datetime").length > 1) {
    return "a collection has one datetime column";
  }
  const holder = datetimeColumn(draft) ?? null;
  for (const c of columns) {
    const lock = choiceLock(option, c, dtypes.get(c), draft, holder);
    if (lock !== null) return lock;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Groups (D-xxvii: grouped by outcome, not by CSV order)
// ---------------------------------------------------------------------------

/** Assigned — a layout can be built from it (open on arrival). Display only — kept and
 *  shown, never places a cell (folded). Ignored — no role at all (folded). */
export type DataGroup = "assigned" | "display" | "ignored";

export const GROUPS: readonly DataGroup[] = ["assigned", "display", "ignored"];

export function groupOfChoice(choice: ColumnRoleChoice | undefined): DataGroup {
  if (choice === "freeform") return "display";
  if (choice === "ignore" || choice === undefined) return "ignored";
  return "assigned";
}

/** Every column a coordinate pair in the draft uses as an axis. */
export function axisColumns(draft: RolesDraft): Set<string> {
  return new Set([...draft.scatterPairs.flatMap((p) => [p.x, p.y]), ...draft.geoPairs.flatMap((g) => [g.lon, g.lat])]);
}

/** One column row of the table. */
export interface ColumnRowModel {
  kind: "column";
  column: string;
  choice: ColumnRoleChoice;
  group: DataGroup;
}

/** One read-only pointer row per coordinate pair (D-xxiii): the pair belongs to a layout
 *  and is edited on its card. */
export interface PairRowModel {
  kind: "pair";
  family: "scatter" | "geographic";
  /** Axis order: x, y / lon, lat. */
  columns: [string, string];
  label: string;
}

export type RowModel = ColumnRowModel | PairRowModel;

/** The table's rows, in the SERVED column order (`GET .../columns`, parquet order), with
 *  any column the draft names that the list does not (the list failed to load) appended
 *  in draft order. A column that is ONLY a coordinate axis — its choice is `ignore` because
 *  the pair stores it (`rolesDraftFromColumnRoles`) — is drawn by its pair's pointer row,
 *  not by a row of its own. Pair rows follow the column rows; all of them are Assigned. */
export function buildRows(draft: RolesDraft, names: readonly string[]): RowModel[] {
  const axes = axisColumns(draft);
  const rows: RowModel[] = [];
  for (const column of names) {
    const choice = draft.choice[column] ?? "ignore";
    if (axes.has(column) && choice === "ignore") continue;
    rows.push({ kind: "column", column, choice, group: groupOfChoice(choice) });
  }
  for (const p of draft.scatterPairs) {
    rows.push({ kind: "pair", family: "scatter", columns: [p.x, p.y], label: p.label });
  }
  for (const g of draft.geoPairs) {
    rows.push({ kind: "pair", family: "geographic", columns: [g.lon, g.lat], label: g.label });
  }
  return rows;
}

export function groupOfRow(row: RowModel): DataGroup {
  return row.kind === "pair" ? "assigned" : row.group;
}

/** The columns a row stands for. */
export function rowColumns(row: RowModel): string[] {
  return row.kind === "pair" ? [...new Set(row.columns)] : [row.column];
}

/** The chip counts, by COLUMN (a pair is two), from the WORKING draft. `assigned` is the
 *  same set `Overview.assignedColumns` counts for the Data door, so the two never disagree;
 *  the other two partition the rest. `all` is every column the table lists. */
export function groupCounts(
  draft: RolesDraft,
  names: readonly string[],
  assigned: readonly string[],
): { all: number; assigned: number; display: number; ignored: number } {
  const isAssigned = new Set(assigned);
  let display = 0;
  let ignored = 0;
  for (const c of names) {
    if (isAssigned.has(c)) continue;
    if (draft.choice[c] === "freeform") display += 1;
    else ignored += 1;
  }
  return { all: names.length, assigned: isAssigned.size, display, ignored };
}

// ---------------------------------------------------------------------------
// Which layouts a row built, and what the edit does to them
// ---------------------------------------------------------------------------

function isLive(layout: LayoutInfo): boolean {
  return (layout.state ?? "live") === "live";
}

/** The committed layouts built on a row: for a column, every live layout whose recorded
 *  `source_columns` names it; for a pair, the live layout of that family recorded over
 *  exactly that pair. Grid reads nothing and is never here. A layout baked before 2.9
 *  (`source_columns` null) cannot be placed on any row — that is `provenanceUnknown`. */
export function layoutsBuiltOn(row: RowModel, layouts: readonly LayoutInfo[]): LayoutInfo[] {
  return layouts.filter((l) => {
    if (!isLive(l) || l.type === "grid" || !Array.isArray(l.source_columns)) return false;
    if (row.kind === "column") return l.source_columns.includes(row.column);
    const want = [...new Set(row.columns)];
    return l.type === row.family && l.source_columns.length === want.length && want.every((c, i) => l.source_columns?.[i] === c);
  });
}

/** Live column-reading layouts that recorded no columns at all (baked before 2.9). */
export function provenanceUnknown(layouts: readonly LayoutInfo[]): LayoutInfo[] {
  return layouts.filter((l) => isLive(l) && l.type !== "grid" && !Array.isArray(l.source_columns));
}

/** One sentence on a row, and what kind of claim it is. `edit-*` is what THIS pending edit
 *  does (`derived.outcomes`); `baked-*` is the DURABLE verdict of the bake record
 *  (`derived.baked`). The two are disjoint by construction (CONTRACT §4) and are never
 *  worded as each other: a layout staled by an earlier commit is not blamed on this edit. */
export type ConsequenceKind =
  | "held-roles"
  | "edit-stale"
  | "edit-renamed"
  | "edit-orphaned"
  | "edit-unknown"
  | "baked-stale"
  | "tag-unserved"
  | "tag-last";

export interface Consequence {
  kind: ConsequenceKind;
  text: string;
}

/** The two-role defect, on its row, before anything is edited. */
export function heldRolesText(column: string, conflict: HeldRoleConflict): string {
  const declared = conflict.declared.map(roleWord).join(" and ");
  const dropped = conflict.dropped.map(roleWord).join(" and ");
  return (
    `This collection declares ${conflict.declared.length} roles for ${column} — ${declared}. ` +
    `The designer can hold one, so it keeps ${roleWord(conflict.kept)}; committing a role change would drop ${dropped}.`
  );
}

/** Everything the row says about layouts and the tag index, in RoleConsequences' and
 *  TagSidecar's words. Pure over the model the shell derived. */
export function rowConsequences(args: {
  row: RowModel;
  layouts: readonly LayoutInfo[];
  derived: PendingDerivation;
  committed: ColumnRoles | null | undefined;
  draft: RolesDraft | null;
  conflict: HeldRoleConflict | undefined;
  /** `layoutsBuiltOn(row, layouts)`, when the caller already has it. */
  built?: LayoutInfo[];
}): Consequence[] {
  const { row, derived } = args;
  const out: Consequence[] = [];
  if (args.conflict !== undefined && row.kind === "column") {
    out.push({ kind: "held-roles", text: heldRolesText(row.column, args.conflict) });
  }

  const built = args.built ?? layoutsBuiltOn(row, args.layouts);
  for (const layout of built) {
    // THIS EDIT (`outcomes`) — only what the pending edit newly does.
    const outcome = outcomeFor(derived, layout.layout_id);
    if (outcome !== undefined) {
      // An ORPHANED layout gets the orphan sentence alone. The model also marks it stale
      // (its entry is gone, so nothing declares what it was baked with), but "keeps serving
      // until re-baked" beside "can't be re-baked" contradicts itself, and the orphan
      // sentence already says its tiles are all it will ever have (review of #384, F6).
      //
      // A layout both STALE and RENAMED (the flags are not exclusive — `LayoutOutcome`) gets
      // one stale line that also names its new id: "not affected — nothing stale" beside a
      // stale line contradicted it (second review of #384, #4). Reachable from L5: change a
      // pair's knobs AND add a second pair of that family.
      if (outcome.stale && !outcome.orphaned) {
        const rename = outcome.renamedTo !== null ? ` — and that bake files it as ${outcome.renamedTo}` : "";
        out.push({
          kind: "edit-stale",
          text: `Stales ${layout.label}, which was baked from ${row.kind === "pair" ? "these columns" : "this column"}. It keeps serving until re-baked${rename}.`,
        });
      }
      if (outcome.renamedTo !== null && !outcome.stale) {
        out.push({
          kind: "edit-renamed",
          text: `${layout.label} is not affected — nothing stale. Its next bake files it as ${outcome.renamedTo}.`,
        });
      }
      if (outcome.orphaned) {
        out.push({
          kind: "edit-orphaned",
          text: `${layout.label} can't be re-baked — with this role gone, nothing can rebuild it. It keeps serving what it has.`,
        });
      }
    }
    // THE BAKE RECORD (`baked`) — durable, and not this edit's doing.
    const baked = bakedFor(derived, layout.layout_id);
    if (baked !== undefined && baked.staleColumns.length > 0) {
      out.push({
        kind: "baked-stale",
        text:
          `${layout.label} is already stale — its bake no longer matches the committed roles for ` +
          `${baked.staleColumns.join(", ")}, from an earlier commit, not this edit. It keeps serving until re-baked.`,
      });
    }
  }

  // A layout that recorded no columns cannot be placed on a row, and this edit cannot be
  // checked against it — said ONCE on every row the edit changed (a pre-2.9 collection
  // has every layout in this state), never promoted to stale.
  //
  // Such a layout matches no row, so its OTHER outcome would reach no row either — and the
  // bar still counts it (review of #384, F4: `group` → Freeform on the 2.8 golden tree reads
  // "2 layouts can't be re-baked" in the bar and nothing about them on the row). So the same
  // line names which of them the edit orphans or renames.
  const changed = rowColumns(row).some((c) => derived.changedColumns.includes(c));
  const unknownOutcomes = changed ? derived.outcomes.filter((x) => x.unknown) : [];
  const unknown = unknownOutcomes.map((x) => x.label);
  const orphaned = unknownOutcomes.filter((x) => x.orphaned).map((x) => x.label);
  const renamed = unknownOutcomes.filter((x) => x.renamedTo !== null).map((x) => `${x.label} would bake as ${x.renamedTo}`);
  const names = (labels: string[]): string =>
    labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const also =
    (orphaned.length === 0
      ? ""
      : unknown.length === 1
        ? " It can't be re-baked: these roles no longer produce it."
        : ` Of those, ${names(orphaned)} can't be re-baked: these roles no longer produce ${orphaned.length === 1 ? "it" : "them"}.`) +
    (renamed.length === 0 ? "" : ` ${names(renamed)}.`);
  if (unknown.length === 1) {
    out.push({
      kind: "edit-unknown",
      text: `${unknown[0]} is unchecked — it was baked before layouts recorded their columns, so this change can't be checked against it.${also}`,
    });
  } else if (unknown.length > 1) {
    out.push({
      kind: "edit-unknown",
      text: `${unknown.length} layouts are unchecked — ${unknown.join(", ")} were baked before layouts recorded their columns, so this change can't be checked against them.${also}`,
    });
  }

  if (row.kind === "column") out.push(...tagConsequences(row.column, args.committed, args.draft, derived));
  return out;
}

/** The tag row's two warnings (CONTRACT §4a), from `derived.tags` — which is already gated
 *  on an edited draft. PREDICTIONS, worded as such: after a roles-only commit the model
 *  goes quiet even though the filter is still empty
 *  ([[T2-a-tag-role-warning-is-not-durable-past-its-own]]), so nothing here may read as a
 *  standing status. */
function tagConsequences(
  column: string,
  committed: ColumnRoles | null | undefined,
  draft: RolesDraft | null,
  derived: PendingDerivation,
): Consequence[] {
  const out: Consequence[] = [];
  const committedTags = committed?.tag ?? [];
  // `unservedColumns` also names a committed tag column whose DELIMITER moved. That column is
  // served — split on the delimiter it had at ingest, which no commit or bake re-splits (F3)
  // — and this view no longer lets a delimiter move (second review of #384, #3), so a
  // committed tag column says nothing here rather than a false "needs a bake".
  if (derived.tags.unservedColumns.includes(column) && !committedTags.some((t) => t.column === column)) {
    out.push({
      kind: "tag-unserved",
      text:
        derived.bakeCount === 0
          ? "Filtering by this column needs a bake. Nothing is queued, so its filter would be empty until one runs."
          : "Filtering by this column needs a bake that rebuilds the tag index. Until one lands, its filter would be empty.",
    });
  }
  if (derived.tags.removesLastTagRole && draft !== null && committedTags.some((t) => t.column === column) && draft.choice[column] !== "tag") {
    out.push({
      kind: "tag-last",
      text:
        committedTags.length === 1
          ? "This is the collection's only tag column. Committing removes tag filtering from the atlas."
          : "The draft keeps none of the collection's tag columns. Committing removes tag filtering from the atlas.",
    });
  }
  return out;
}

/** Pending-queue bakes (L5's) that would build a layout FROM this row: on a pair row, a
 *  `new` entry of THAT family over exactly that pair; on a column row, a `new` datetime or
 *  categorical over that column. Matching columns alone put a queued scatter over `lon, lat`
 *  on the geographic pair's row too (review of #384, F7). */
export function queuedOn(row: RowModel, derived: PendingDerivation): { label: string; problem: string | null }[] {
  const tuple = JSON.stringify(rowColumns(row));
  return derived.bakes
    .filter((b) => {
      if (b.entry.kind !== "new") return false;
      const family: string = b.entry.type;
      const matchesFamily = row.kind === "pair" ? family === row.family : family === "datetime" || family === "categorical";
      return matchesFamily && JSON.stringify(b.entry.source_columns) === tuple;
    })
    .map((b) => ({ label: b.label, problem: b.problem }));
}
