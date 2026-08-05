// Catalogued viewer component (props verbatim — interface-catalogue.md; the
// catalogue types `roles` as `ColumnRoles | null`: null for images-only
// datasets, decision D-25 — the controls render disabled).
//
// Tag VALUES (the chips) come from the D-14 sidecar table, never from
// getMetadata (D-21: MetadataRow.fields is scalar-only by design). The
// catalogued props carry no table, so the app shell provides the fetched
// sidecar Table through TagTableContext — a null context value (no `tags`
// declaration, or the sidecar failed to load — gap #8) also renders disabled.
//
// .ts + createElement, runtime imports bare-only: see LayoutSwitcher.ts (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createContext, createElement as h, useContext, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { Table } from "apache-arrow";
import type { ColumnRoles } from "../generated/column_roles";
import type { TagSelection } from "../renderer/layout";

export interface TagControlsProps {
  roles: ColumnRoles | null; // null for images-only datasets (decision D-25); controls render disabled
  selection: TagSelection;
  onChange: (selection: TagSelection) => void;
  // T2-120 (Fix B): the RENDERER-side tag sidecar failed to load (retryable). Distinct
  // from `table === null` (the UI-side chip fetch): the chips may render fine from the
  // UI fetch while the renderer's copy 401'd, so the highlight would silently no-op.
  // When true, a visible "Tag filtering unavailable — retry" affordance is shown so the
  // mismatch is not console-only. undefined ⇒ unknown (treated as ok — pre-wiring/tests).
  rendererTagsFailed?: boolean;
  // Re-attempt the renderer-side sidecar load (re-applies the current selection). Wired
  // to the retry affordance; absent ⇒ the affordance shows the message without a button.
  onRetryTags?: () => void;
}

/** The fetched D-14 tag sidecar table (id + one list<string> column per
 *  tag-role column), provided by the viewer shell. null ⇒ no sidecar (or it
 *  failed to load) ⇒ the controls render disabled. */
export const TagTableContext = createContext<Table | null>(null);

/** How many chips are visible per column before the filter box must narrow
 *  them (brief §0.6: most-frequent first). */
export const VISIBLE_CHIP_CAP = 50;

export interface TagChip {
  value: string;
  count: number;
}

/**
 * Derive the distinct value chips per tag column from the sidecar table,
 * ordered most-frequent first (ties: value asc). Returns the FULL list per
 * column; the component shows the first VISIBLE_CHIP_CAP after filtering.
 */
export function deriveTagChips(table: Table, columns: string[]): Map<string, TagChip[]> {
  const out = new Map<string, TagChip[]>();
  for (const column of columns) {
    const vec = table.getChild(column);
    if (vec === null) continue; // declared but absent in the sidecar: no chips
    const counts = new Map<string, number>();
    for (let i = 0; i < table.numRows; i++) {
      const cell = vec.get(i) as Iterable<unknown> | null;
      if (cell === null || cell === undefined) continue;
      for (const v of cell) {
        if (v === null || v === undefined) continue;
        const value = String(v);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const chips = [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    out.set(column, chips);
  }
  return out;
}

/** Immutably toggle one (column, value) pair in the selection. */
export function toggleTagValue(selection: TagSelection, column: string, value: string): TagSelection {
  const exists = selection.selected.some((p) => p.column === column && p.value === value);
  return {
    mode: selection.mode,
    selected: exists
      ? selection.selected.filter((p) => !(p.column === column && p.value === value))
      : [...selection.selected, { column, value }],
  };
}

function disabledNote(reason: string): ReactElement {
  return h(
    "section",
    { className: "tag-controls tag-controls-disabled", "aria-disabled": true },
    h("h3", { className: "panel-title" }, "Tags"),
    h("p", { className: "muted" }, reason),
  );
}

/** T2-120 (Fix B): the renderer-side-failure affordance — a visible "Tag filtering
 *  unavailable" line + a Retry button (when a handler is wired). role="status" so it
 *  reads as an actionable notice, not console-only. */
function retryBanner(onRetry?: () => void): ReactElement {
  return h(
    "div",
    { className: "tag-retry-banner", role: "status" },
    h("span", { className: "muted" }, "Tag filtering unavailable"),
    onRetry !== undefined
      ? h("button", { type: "button", className: "btn ghost tag-retry-btn", onClick: onRetry }, "Retry")
      : null,
  );
}

export function TagControls(props: TagControlsProps): ReactElement {
  const table = useContext(TagTableContext);
  const [filter, setFilter] = useState("");

  const tagRoles = props.roles?.tag ?? [];
  const chipsByColumn = useMemo(
    () =>
      table === null
        ? new Map<string, TagChip[]>()
        : deriveTagChips(table, tagRoles.map((t) => t.column)),
    // tagRoles derives from props.roles, which the shell holds in state — a
    // stable reference between renders, so it is the honest dependency here.
    [table, props.roles],
  );

  const rendererTagsFailed = props.rendererTagsFailed === true;

  if (props.roles === null || tagRoles.length === 0) {
    // Images-only dataset (D-25) or no tag-role columns: disabled by design.
    return disabledNote("This dataset has no tag metadata, so tag filtering is unavailable.");
  }
  if (table === null) {
    // No UI-side chips either (manifest declares no sidecar, or the UI fetch failed —
    // gap #8): disabled, the canvas stays interactive. If the RENDERER-side load failed
    // (T2-120), offer a retry rather than a dead-end note.
    if (rendererTagsFailed) {
      return h(
        "section",
        { className: "tag-controls tag-controls-disabled", "aria-disabled": true },
        h("h3", { className: "panel-title" }, "Tags"),
        retryBanner(props.onRetryTags),
      );
    }
    return disabledNote("Tag values are unavailable; tag filtering is disabled.");
  }

  const needle = filter.trim().toLowerCase();
  const isSelected = (column: string, value: string): boolean =>
    props.selection.selected.some((p) => p.column === column && p.value === value);

  return h(
    "section",
    { className: "tag-controls" },
    h("h3", { className: "panel-title" }, "Tags"),
    // T2-120 (Fix B): the chips rendered from the UI-side fetch, but the RENDERER's copy
    // failed — the highlight would silently no-op. Surface the mismatch + a retry above
    // the chips so it is visible, not console-only.
    rendererTagsFailed ? retryBanner(props.onRetryTags) : null,
    h(
      "div",
      { className: "tag-mode", role: "radiogroup", "aria-label": "Combine mode" },
      (["or", "and"] as const).map((mode) =>
        h(
          "button",
          {
            key: mode,
            type: "button",
            className: props.selection.mode === mode ? "mode-btn mode-btn-active" : "mode-btn",
            "aria-pressed": props.selection.mode === mode,
            onClick: () => props.onChange({ selected: props.selection.selected, mode }),
          },
          mode === "or" ? "Match any" : "Match all",
        ),
      ),
      props.selection.selected.length > 0
        ? h(
            "button",
            {
              type: "button",
              className: "mode-btn",
              onClick: () => props.onChange({ selected: [], mode: props.selection.mode }),
            },
            `Clear (${props.selection.selected.length})`,
          )
        : null,
    ),
    h("input", {
      type: "search",
      className: "tag-filter",
      placeholder: "Filter tag values…",
      "aria-label": "Filter tag values",
      value: filter,
      onChange: (e: { target: { value: string } }) => setFilter(e.target.value),
    }),
    tagRoles.map((role) => {
      const all = chipsByColumn.get(role.column) ?? [];
      const filtered = needle === "" ? all : all.filter((c) => c.value.toLowerCase().includes(needle));
      const visible = filtered.slice(0, VISIBLE_CHIP_CAP);
      return h(
        "div",
        { key: role.column, className: "tag-column" },
        h("h4", { className: "tag-column-label" }, role.label || role.column),
        h(
          "div",
          { className: "chip-row" },
          visible.map((chip) =>
            h(
              "button",
              {
                key: chip.value,
                type: "button",
                className: isSelected(role.column, chip.value) ? "chip chip-selected" : "chip",
                "aria-pressed": isSelected(role.column, chip.value),
                onClick: () => props.onChange(toggleTagValue(props.selection, role.column, chip.value)),
              },
              `${chip.value} (${chip.count})`,
            ),
          ),
          filtered.length > visible.length
            ? h("span", { className: "muted" }, `+${filtered.length - visible.length} more — refine the filter`)
            : null,
        ),
      );
    }),
  );
}
