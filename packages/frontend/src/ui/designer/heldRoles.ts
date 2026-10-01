// The designer's two-role rule (LAYOUT_DESIGNER D-xxxi; CONTRACT §3 and §8): which
// committed columns the roles draft CANNOT hold ([[T2-the-roles-draft-cannot-hold-a-column-s-second]]).
//
// ONE rule, read by both views. The Data view flags such a column on its row before
// anything is edited (`data.ts`, in `dataModel.heldRolesText`'s words); the review refuses a
// commit that sends roles, naming it (`layoutsCommit.composeCommit`). Seams L4 (#384) and
// L5 (#385) each built it; they were proved identical and merged here, so a change to what
// "cannot hold" means reaches the row and the refusal together. The words both use for a
// role live here too (`roleWord`), so the row and the refusal name a column's roles alike.
//
// In neither view's file, so both may import it. Pure: no React, node-test importable.
import type { ColumnRoles } from "../../generated/column_roles";
import type { RolesDraft } from "../admin/roles";

/** A role kind as a person reads it — the Role select's words (`dataModel.ROLE_OPTIONS`),
 *  plus `"pair"` for a column's coordinate-pair membership. */
const ROLE_WORD: Record<string, string> = {
  filename: "Filename",
  datetime: "Datetime",
  categorical: "Categorical",
  tag: "Tags",
  freeform: "Freeform (display only)",
  ignore: "Ignore",
  pair: "a coordinate pair",
};

export function roleWord(kind: string): string {
  return ROLE_WORD[kind] ?? kind;
}

/** The role kinds a `RolesDraft` holds in its ONE `choice` per column —
 *  `rolesDraftFromColumnRoles` assigns exactly these, in this order, last write wins. */
const CHOICE_KINDS = ["filename", "datetime", "categorical", "tag", "freeform"] as const;

/** A column the committed roles give more roles than the draft can hold. `"pair"` stands
 *  for the column's coordinate-pair membership, however many pairs use it. */
export interface HeldRoleConflict {
  /** Every role the committed map gives the column: its `choice` roles in the order
   *  `rolesDraftFromColumnRoles` assigns them, then `"pair"`. */
  declared: string[];
  /** The one the draft keeps. */
  kept: string;
  /** What a role commit compiled from the draft would drop. */
  dropped: string[];
}

/** The columns whose committed roles the draft CANNOT hold, keyed by column. The order is
 *  the fixed role-kind order `CHOICE_KINDS` gives — filename, datetime, categorical, tag,
 *  freeform — and, within a kind's list, the entry's position: a column comes out where
 *  its first `choice` role is met in that walk, not where the map's JSON happens to put it.
 *
 *  The draft keeps ONE role per column in `choice`, and a column's coordinate-pair
 *  membership separately, in `scatterPairs`/`geoPairs`. So a column is flagged when it
 *  carries two of those things:
 *    - two `choice` roles — categorical AND tag, datetime AND freeform, one kind twice.
 *      The seed keeps one (last write wins) and a role commit drops the rest. Measured
 *      shapes (2026-09-24, the item): categorical+tag, datetime+freeform;
 *    - a `choice` role AND a pair axis. `buildColumnRoles` drops a freeform role from an
 *      axis without a word, and `validateDraft` refuses a storing role on one, so the only
 *      commit left is one that sets the role to Ignore. Either way the pair stays and the
 *      other role goes.
 *
 *  NOT "a column carrying more than one fingerprint", which is how the L4 brief stated it,
 *  because that over-matches in two production-reachable shapes the draft holds EXACTLY:
 *  a column shared by two coordinate pairs (`sx` in `(sx, sy)` and `(sx, lon)` — two
 *  tuples, both kept in `scatterPairs`), and a column carrying the reserved `embedding`
 *  role beside another (`embedding` rides through the draft verbatim). Flagging either
 *  would tell someone a commit loses a role when it loses nothing.
 *
 *  `kept` for a `choice` conflict is read off the SEED rather than re-derived from the
 *  assignment order, so if `roles.ts` ever changes which one wins, this still names it. */
export function heldRoleConflicts(
  committed: ColumnRoles | null | undefined,
  seed: RolesDraft | null,
): Map<string, HeldRoleConflict> {
  const out = new Map<string, HeldRoleConflict>();
  if (committed === null || committed === undefined || seed === null) return out;
  const byColumn = new Map<string, string[]>();
  const note = (column: string, kind: string): void => {
    byColumn.set(column, [...(byColumn.get(column) ?? []), kind]);
  };
  for (const kind of CHOICE_KINDS) {
    const value = committed[kind];
    if (value === null || value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) note(entry.column, kind);
  }
  const axes = new Set([
    ...(committed.scatter ?? []).flatMap((p) => [p.x_column, p.y_column]),
    ...(committed.geographic ?? []).flatMap((g) => [g.lon_column, g.lat_column]),
  ]);
  for (const [column, kinds] of byColumn) {
    const onPair = axes.has(column);
    if (kinds.length + (onPair ? 1 : 0) < 2) continue;
    if (onPair) {
      out.set(column, { declared: [...kinds, "pair"], kept: "pair", dropped: [...kinds] });
      continue;
    }
    const kept = seed.choice[column] ?? "ignore";
    const dropped = [...kinds];
    const at = dropped.indexOf(kept);
    if (at >= 0) dropped.splice(at, 1);
    out.set(column, { declared: [...kinds], kept, dropped });
  }
  return out;
}
