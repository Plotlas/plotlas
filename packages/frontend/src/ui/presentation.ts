// The fallback rules for the presentation record (D-xv/D-xvi/D-xvii/D-xviii).
//
// `presentation.json` is the second record in a dataset directory: what a human chose
// about how the collection is SHOWN, written by the API, never by the bake. Every key is
// optional, the whole file is optional, and — this is the part that shapes this module —
// its maps are keyed by identifiers the OTHER file owns (`layout_id`, the raw CSV column
// name), so the schema deliberately cannot check that a key resolves. A `title_column`
// naming a column a metadata update dropped, a label override for a layout a re-bake
// removed: both VALIDATE, and it is the consumer that resolves-or-falls-back.
//
// So every function here answers the same question in a different place — "what does the
// viewer show when the record says nothing, or says something that no longer resolves?" —
// and the answer is always today's behaviour, silently. They live together, and are
// imported rather than re-inlined, for the reason `collectionName` does (api-client/types):
// one fallback rule, so no surface can drift into showing a different thing.
//
// Pure and free of react, so the node unit tier can import it directly.
import type { LayoutInfo, MetadataRow } from "../api-client/types";
import type { ColumnPresentation, Presentation } from "../generated/presentation";

/** `presentation.columns` — per-column display, keyed by the RAW column name (the
 *  identifier the manifest keeps). Absent ⇒ every column is drawn exactly as today. */
export type ColumnPresentationMap = Presentation["columns"];

/** The presentation for ONE column, or undefined. A lookup, not a rule: the rules below
 *  each decide what an absent entry means for their own aspect. */
function entryFor(column: string, columns: ColumnPresentationMap): ColumnPresentation | undefined {
  return columns?.[column];
}

/**
 * The inspector's heading for a cell.
 *
 * Today every cell is headed `Cell {id}` — a pipeline-internal ordinal assigned by
 * filename order (D-25), meaningless to a viewer, NOT stable across a re-ingest, and the
 * one field on screen carrying no information about the image. When the record declares a
 * `title_column` and the row has a usable value there, that value is the heading.
 *
 * "Usable" is the whole function, because **a blank heading is worse than `Cell 4211`** —
 * it reads as broken rather than as technical. Everything below falls back:
 *   - no `title_column` declared (absent, null);
 *   - no row yet (still loading) or none at all;
 *   - the column is gone from the metadata — `fields[col]` is `undefined` (D-xvi's
 *     dangling case, and the reason this is a lookup rather than a validated join);
 *   - the value is null;
 *   - the value is an empty or whitespace-only string.
 * A number or boolean IS usable — an accession number is a legitimate title, and
 * `String(v)` is non-empty for both.
 */
export function cellTitle(
  cellId: number,
  row: MetadataRow | null,
  titleColumn?: string | null,
): string {
  const fallback = `Cell ${cellId}`;
  if (titleColumn === undefined || titleColumn === null || row === null) return fallback;
  const value = row.fields[titleColumn];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? fallback : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** What a metadata column is CALLED in the inspector: the declared label, else the raw
 *  column name exactly as today. The manifest keeps the raw name as the identifier, so the
 *  label is only ever a display string — nothing keys off it. */
export function columnLabel(column: string, columns: ColumnPresentationMap): string {
  const label = entryFor(column, columns)?.label;
  return label !== undefined && label.trim() !== "" ? label : column;
}

/** Is this column hidden from the inspector? PRESENTATIONAL ONLY, and deliberately so:
 *  the column stays in `metadata.parquet`, still comes back in `GET /api/metadata`'s
 *  fields, and is still searchable. Hiding it is not a privacy control and must never be
 *  relied on as one — the value is already on the wire when this decides not to draw it. */
export function isColumnHidden(column: string, columns: ColumnPresentationMap): boolean {
  return entryFor(column, columns)?.hidden === true;
}

/** Does this column's VALUE render as a link? `render: "url"` is where the old
 *  `column_roles.url` role went (D-xvii) — same normative rule, different file. Whether a
 *  particular value may BECOME a live link is `sourceLink.sourceUrl`'s decision, not this
 *  one: this only says the column was declared as link-bearing. */
export function isUrlColumn(column: string, columns: ColumnPresentationMap): boolean {
  return entryFor(column, columns)?.render === "url";
}

/**
 * The layout list with declared label overrides applied (D-xviii).
 *
 * Maps over the BAKE's layouts, so an override naming a layout that no longer exists
 * contributes nothing — a phantom switcher entry is unrepresentable rather than filtered
 * out afterwards. Everything else about the list is untouched: order, ids and types stay
 * the bake's, because they are what the renderer and the manifest key off.
 *
 * Returns the input array itself when no override applies, so the common case adds no new
 * identity for React (and for the effects downstream that depend on `layouts`).
 */
export function layoutsWithLabels(
  layouts: LayoutInfo[],
  overrides: Presentation["layouts"],
): LayoutInfo[] {
  if (overrides === undefined) return layouts;
  let changed = false;
  const relabelled = layouts.map((l) => {
    const label = overrides[l.layout_id]?.label;
    if (label === undefined || label.trim() === "" || label === l.label) return l;
    changed = true;
    return { ...l, label };
  });
  return changed ? relabelled : layouts;
}
