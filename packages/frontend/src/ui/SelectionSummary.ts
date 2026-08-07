// Multi-select summary (brief §2, R-22): count + per-categorical-value counts
// + date range, computed from ONE <= 250-id getMetadata call. Past the cap the
// shell trims to the first 250 ids and this component says so ("summary over
// first 250 of N") — the client REJECTS over-cap calls by design (D-13).
//
// It owned the "Clear selection" button until T2-204. Clearing now has to be
// reachable for a SINGLE selection too (an unfloored pick means a click lands on a
// cell nearly everywhere, so background-click is no longer a reliable way to empty
// the selection), so the one button lives in the inspector's header — see ViewerScreen.
//
// Seam-internal props (not catalogued). Presentational: the shell fetches the
// rows. .ts + createElement, runtime imports bare-only: see LayoutSwitcher.ts.
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { MetadataRow } from "../api-client/types";
import type { ColumnRoles } from "../generated/column_roles";

export interface ValueCount {
  value: string;
  count: number;
}

export interface SelectionDigest {
  categorical: { column: string; label: string; counts: ValueCount[] }[];
  dateRange: { column: string; label: string; min: string; max: string } | null;
}

/** Aggregate fetched rows by the dataset's roles: per-categorical-value counts
 *  (value desc by count, then asc by value) and the datetime column's min/max.
 *  Pure — unit-tested directly. */
export function summarizeRows(
  rows: MetadataRow[],
  roles: ColumnRoles | null | undefined,
): SelectionDigest {
  const categorical = (roles?.categorical ?? []).map((role) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const v = row.fields[role.column];
      if (v === null || v === undefined) continue;
      const key = String(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      column: role.column,
      label: role.label || role.column,
      counts: [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
    };
  });

  let dateRange: SelectionDigest["dateRange"] = null;
  const dt = roles?.datetime ?? null;
  if (dt !== null && dt !== undefined) {
    const numeric = dt.format === "unix_seconds" || dt.format === "unix_millis";
    let min: string | number | null = null;
    let max: string | number | null = null;
    for (const row of rows) {
      const raw = row.fields[dt.column];
      if (raw === null || raw === undefined) continue;
      const v = numeric ? Number(raw) : String(raw);
      if (numeric && !Number.isFinite(v as number)) continue;
      if (min === null || v < min) min = v;
      if (max === null || v > max) max = v;
    }
    if (min !== null && max !== null) {
      dateRange = { column: dt.column, label: dt.label || dt.column, min: String(min), max: String(max) };
    }
  }
  return { categorical, dateRange };
}

export interface SelectionSummaryProps {
  /** Total selected cell count (may exceed rows.length when capped). */
  count: number;
  /** Rows fetched for the FIRST min(count, 250) selected ids. */
  rows: MetadataRow[];
  roles: ColumnRoles | null | undefined;
}

export function SelectionSummary(props: SelectionSummaryProps): ReactElement {
  const digest = summarizeRows(props.rows, props.roles);
  const capped = props.count > props.rows.length;
  return h(
    "section",
    { className: "selection-summary" },
    h("h3", { className: "panel-title" }, `${props.count} cells selected`),
    capped
      ? h("p", { className: "muted" }, `Summary over first ${props.rows.length} of ${props.count} (metadata is capped at 250 ids per call).`)
      : null,
    digest.categorical.map((cat) =>
      cat.counts.length > 0
        ? h(
            "div",
            { className: "summary-block", key: cat.column },
            h("h4", { className: "tag-column-label" }, cat.label),
            h(
              "ul",
              { className: "value-counts" },
              cat.counts.map((vc) => h("li", { key: vc.value }, `${vc.value}: ${vc.count}`)),
            ),
          )
        : null,
    ),
    digest.dateRange !== null
      ? h(
          "p",
          { className: "summary-block" },
          `${digest.dateRange.label}: ${digest.dateRange.min} – ${digest.dateRange.max}`,
        )
      : null,
  );
}
