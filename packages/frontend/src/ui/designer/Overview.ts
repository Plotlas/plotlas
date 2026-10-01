// The designer's OVERVIEW view (seam L3 §2b.5; LAYOUT_DESIGNER D-xix/D-xx/D-xxv; board
// `Main`) — the front door, where every entrance lands. It holds the collection's OWN
// facts: an identity header, two doors (Data, Layouts), and the presentation panel.
//
// EVERYTHING EDITABLE HERE IS FREE (D-xx). Each field PATCHes `.../presentation` as it is
// typed — only itself, so a name edit cannot clobber a credit changed elsewhere — and
// says "saved" when the write resolves. None of it ever reaches the commit bar. A server
// validation error shows on the field that caused it, with what was typed kept on screen.
//
// The three text fields and their validation MOVED here from the library card's inline
// details editor (D-xxiv retires that editor with the ⋯ menu): the same caps, the same
// trim, the same "blank clears it" rule, the same "send only what changed".
import { createElement as h, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ColumnListResponse, DatasetSummary, LayoutInfo } from "../../api-client/types";
import { collectionName } from "../../api-client/types";
import { errText } from "../../api-client/errText";
import type { Presentation } from "../../generated/presentation";
import type { RolesDraft } from "../admin/roles";
import type { DesignerViewProps } from "./contract";
import type { PendingDerivation } from "./pending";
import { DeleteCollectionDialog } from "./DeleteCollectionDialog";

/** The collection-level text fields (Part D §2/§2b), with the API's caps — mirrored so
 *  the input refuses what the server would, which still validates
 *  (`api/appstate.py` DISPLAY_NAME_MAX / ATTRIBUTION_MAX / ATTRIBUTION_URL_MAX). */
export const PRESENTATION_TEXT_FIELDS = [
  { name: "display_name" as const, label: "Collection name", max: 120 },
  { name: "attribution" as const, label: "Attribution", max: 200 },
  { name: "attribution_url" as const, label: "Attribution link", max: 500 },
] as const;

export type PresentationTextField = (typeof PRESENTATION_TEXT_FIELDS)[number]["name"];

/** Every dataset-level presentation scalar Overview edits. */
type ScalarField = PresentationTextField | "default_layout" | "title_column";

/** A typed value as the PATCH sends it: trimmed, and blank means CLEAR (null) — the
 *  recovery path for a bad value, exactly as the card editor did. */
export function normalizeFieldValue(raw: string): string | null {
  const value = raw.trim();
  return value === "" ? null : value;
}

/** How long typing must pause before a field saves. Every PATCH takes the dataset's
 *  write lock and rewrites `presentation.json` (a write that says nothing is still a
 *  write), so a save per keystroke is wasteful; a pause this short still reads as
 *  "saved as you type". A UI timing, not a ceiling — leaving the field saves at once. */
export const SAVE_PAUSE_MS = 600;

/** DuckDB types that hold numbers (`GET .../columns` reports the source's own type). */
const NUMERIC_DTYPE = /^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)\b/i;

export function isNumericDtype(dtype: string): boolean {
  return NUMERIC_DTYPE.test(dtype.trim());
}

/** Columns the working draft gives a real role — everything but Display only
 *  (freeform) and Ignored. A coordinate axis counts: it is stored as its coordinate. */
export function assignedColumns(draft: RolesDraft | null, columns: string[]): string[] {
  if (draft === null) return [];
  const axes = new Set([
    ...draft.scatterPairs.flatMap((p) => [p.x, p.y]),
    ...draft.geoPairs.flatMap((g) => [g.lon, g.lat]),
  ]);
  return columns.filter((c) => {
    const choice = draft.choice[c];
    return axes.has(c) || (choice !== undefined && choice !== "freeform" && choice !== "ignore");
  });
}

/** The layout families the data can offer, for the Data door (D-xxiii). Grid always.
 *  Datetime per datetime-roled column and categorical per categorical column, from the
 *  working draft. Scatter and geographic whenever at least two columns are NUMERIC —
 *  the pair is chosen on the layout card, so a family is offered because the data can
 *  support it, not because a pair already exists (which is what `availableLayoutTypes`
 *  gates on, and D-xxiii records as wrong). */
export function offeredFamilies(
  draft: RolesDraft | null,
  columns: ColumnListResponse | null,
): { family: string; count: number; pairOnLayout: boolean }[] {
  const out: { family: string; count: number; pairOnLayout: boolean }[] = [{ family: "grid", count: 1, pairOnLayout: false }];
  if (draft !== null) {
    const datetime = draft.columns.filter((c) => draft.choice[c] === "datetime").length;
    if (datetime > 0) out.push({ family: "datetime", count: datetime, pairOnLayout: false });
    const categorical = draft.columns.filter((c) => draft.choice[c] === "categorical").length;
    if (categorical > 0) out.push({ family: "categorical", count: categorical, pairOnLayout: false });
  }
  const numeric = (columns?.columns ?? []).filter((c) => isNumericDtype(c.dtype)).length;
  if (numeric >= 2) {
    out.push({ family: "scatter", count: 1, pairOnLayout: true });
    out.push({ family: "geographic", count: 1, pairOnLayout: true });
  }
  return out;
}

/** The Layouts door's state summary, from `LayoutInfo` and the pending prediction. */
export function layoutStateCounts(
  layouts: LayoutInfo[],
  derived: PendingDerivation,
): { live: number; baking: number; queued: number; stale: number; rebaking: number } {
  let live = 0;
  let baking = 0;
  let queued = 0;
  let rebaking = 0;
  for (const l of layouts) {
    const state = l.state ?? "live";
    if (state === "live") live += 1;
    else if (state === "baking") baking += 1;
    else queued += 1;
    if (state === "live" && l.rebake != null) rebaking += 1;
  }
  // The UNION by layout_id, never a sum: a layout that is DURABLY stale (its bake record
  // no longer matches the committed roles — `derived.baked`, manifest 2.10) and is ALSO
  // staled again by the open draft (`derived.outcomes`) is one stale layout, and adding
  // the two counts would make the pill read "2 stale" for it.
  const stale = new Set([
    ...derived.outcomes.filter((o) => o.stale).map((o) => o.layout_id),
    ...derived.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id),
  ]).size;
  return { live, baking, queued, stale, rebaking };
}

type FieldStatus = { state: "idle" | "saving" | "saved" | "error"; error: string | null };
const IDLE: FieldStatus = { state: "idle", error: null };

function storedText(dataset: DatasetSummary, presentation: Presentation, field: PresentationTextField): string | null {
  const fromRecord = presentation.dataset?.[field];
  const value = fromRecord !== undefined ? fromRecord : dataset[field];
  return value === undefined || value === null || value === "" ? null : value;
}

/** Remove a key whose value is null, so the local record says "absent" exactly as the
 *  server's `response_model_exclude_none` does. */
function withDatasetKey(presentation: Presentation, key: string, value: string | null): Presentation {
  const dataset = { ...(presentation.dataset ?? {}) } as Record<string, string>;
  if (value === null) delete dataset[key];
  else dataset[key] = value;
  return { ...presentation, dataset };
}

function statusNote(status: FieldStatus): ReactElement | null {
  if (status.state === "saving") return h("span", { className: "designer-field-status" }, "Saving…");
  if (status.state === "saved") return h("span", { className: "designer-field-status designer-saved" }, "Saved");
  return null;
}

export interface OverviewProps extends DesignerViewProps {
  /** The collection was deleted; the caller routes to the library. */
  onDeleted: () => void;
}

export function Overview(props: OverviewProps): ReactElement {
  const { dataset, presentation } = props;
  // The latest props, for async continuations: a save that resolves after ANOTHER field
  // saved must merge into the record as it now stands, not the one it started from.
  const latest = useRef(props);
  latest.current = props;

  const [values, setValues] = useState<Record<PresentationTextField, string>>(() => ({
    display_name: storedText(dataset, presentation, "display_name") ?? "",
    attribution: storedText(dataset, presentation, "attribution") ?? "",
    attribution_url: storedText(dataset, presentation, "attribution_url") ?? "",
  }));
  const [status, setStatus] = useState<Record<string, FieldStatus>>({});
  const [deleting, setDeleting] = useState(false);
  // Copy ID: "copied" when the Clipboard API took it; "manual" when it could not, and the
  // id has been selected for the user to copy by hand.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const idRef = useRef<HTMLElement | null>(null);
  function selectIdForManualCopy(): void {
    const el = idRef.current;
    const selection = globalThis.getSelection?.() ?? null;
    if (el !== null && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setCopyState("manual");
  }
  // One sequence number per field: only the LATEST write for a field may touch its
  // status — an earlier PATCH resolving late must not stamp "saved" over a later error.
  const seq = useRef<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const typed = useRef(values);
  typed.current = values;

  function mark(field: string, next: FieldStatus): void {
    setStatus((prev) => ({ ...prev, [field]: next }));
  }

  /** PATCH one field, and only if it differs from what is stored. */
  async function save(field: ScalarField, value: string | null, stored: string | null): Promise<void> {
    if (value === stored) {
      mark(field, IDLE);
      return;
    }
    const n = (seq.current[field] ?? 0) + 1;
    seq.current[field] = n;
    mark(field, { state: "saving", error: null });
    const { client } = latest.current;
    // Partial by key presence (routers/datasets.py): this one key, and nothing else.
    const patch: Partial<Record<ScalarField, string | null>> = {};
    patch[field] = value;
    try {
      const echo = await client.setDatasetPresentation(latest.current.dataset.dataset_id, patch);
      if (seq.current[field] !== n) return;
      const now = latest.current;
      if (field === "display_name" || field === "attribution" || field === "attribution_url") {
        // The echo carries the three scalars AS STORED (trimmed, blank → null).
        now.onDatasetChange({
          ...now.dataset,
          display_name: echo.display_name ?? null,
          attribution: echo.attribution ?? null,
          attribution_url: echo.attribution_url ?? null,
        });
        now.onPresentationChange(withDatasetKey(now.presentation, field, echo[field] ?? null));
      } else {
        now.onPresentationChange(withDatasetKey(now.presentation, field, value));
      }
      mark(field, { state: "saved", error: null });
    } catch (err) {
      if ((err as { status?: unknown }).status === 401) {
        latest.current.onAuthExpired();
        return;
      }
      if (seq.current[field] !== n) return;
      mark(field, { state: "error", error: errText(err) });
    }
  }

  function saveText(field: PresentationTextField): void {
    clearTimeout(timers.current[field]);
    delete timers.current[field];
    const now = latest.current;
    void save(field, normalizeFieldValue(typed.current[field]), storedText(now.dataset, now.presentation, field));
  }

  // Leaving the view (a tab switch) must not drop a pause-pending save.
  useEffect(
    () => () => {
      for (const field of Object.keys(timers.current) as PresentationTextField[]) saveText(field);
    },
    [],
  );

  const live = props.layouts.filter((l) => (l.state ?? "live") === "live");
  // When a bake last LANDED: the newest layout container's mtime (`committed_at`).
  // `ingest_timestamp` cannot say it — add-layouts carries it forward verbatim, so it dates
  // the first ingest (api/models.py LayoutInfo.committed_at). ISO strings compare in order.
  const lastBaked = live.reduce<string | null>(
    (latest, l) => (l.committed_at != null && (latest === null || l.committed_at > latest) ? l.committed_at : latest),
    null,
  );
  const name = collectionName(dataset);
  const counts = layoutStateCounts(props.layouts, props.derived);

  // ---- identity header ---------------------------------------------------------------
  const identity = h(
    "header",
    { className: "overview-identity" },
    h(
      "div",
      { className: "overview-identity-main" },
      h("h1", { className: "overview-name" }, name),
      h(
        "p",
        { className: "overview-tech" },
        h("span", null, "ID "),
        h("code", { className: "designer-mono", ref: idRef }, dataset.dataset_id),
        h(
          "button",
          {
            type: "button",
            className: "link-btn overview-copy",
            "aria-label": "Copy the collection ID",
            onClick: () => {
              // The Clipboard API exists only in a SECURE context (HTTPS, or localhost). A
              // self-hosted instance on a LAN address has none, and the call used to be
              // skipped by an optional chain with nothing said (review of #368, finding 4)
              // — for a 12-hex minted id nobody can retype. Absent or refused, the id is
              // SELECTED on screen instead, and the user is told to copy it.
              const clipboard = globalThis.navigator?.clipboard;
              if (clipboard === undefined || typeof clipboard.writeText !== "function") {
                selectIdForManualCopy();
                return;
              }
              clipboard.writeText(dataset.dataset_id).then(
                () => setCopyState("copied"),
                () => selectIdForManualCopy(),
              );
            },
          },
          copyState === "copied" ? "Copied" : "Copy",
        ),
        copyState === "manual"
          ? h("span", { className: "overview-copy-hint", role: "status" }, "Press Ctrl+C (⌘C on Mac) to copy")
          : null,
        // One span per `·` fact, each unbreakable, so a narrow screen wraps BETWEEN facts
        // and never inside one ("2026-09-" / "21" at 390 px).
        ...[
          `${dataset.image_count.toLocaleString("en-US")} images`,
          `v${dataset.dataset_version}`,
          `ingested ${dataset.ingest_timestamp.slice(0, 10)}`,
          ...(lastBaked !== null ? [`last baked ${lastBaked.slice(0, 10)}`] : []),
        ].map((fact) => h("span", { key: fact, className: "designer-mono overview-tech-fact" }, `· ${fact}`)),
      ),
    ),
    // D-xxii: quiet, and as far from the commit bar as the screen allows.
    h(
      "button",
      { type: "button", className: "btn ghost overview-delete", onClick: () => setDeleting(true) },
      "Delete collection…",
    ),
  );

  // ---- the two doors -------------------------------------------------------------------
  const columns = props.columns;
  const draft = props.pending.draft;
  const columnNames = columns?.columns.map((c) => c.name) ?? [];
  const dataSummary =
    props.columnsError !== null
      ? "columns unavailable"
      : columns === null
        ? "…"
        : columns.source === "images_only"
          ? "no metadata"
          : `${columnNames.length} column${columnNames.length === 1 ? "" : "s"} · ${assignedColumns(draft, columnNames).length} assigned`;
  const changed = props.derived.changedColumns;
  const roleChanges = props.derived.invalidating;
  const dataDoor = h(
    "section",
    { className: "overview-door card", "aria-label": "Data" },
    h(
      "div",
      { className: "overview-door-head" },
      h("h2", { className: "overview-door-title" }, "Data"),
      h("span", { className: "designer-mono muted" }, dataSummary),
      h("button", { type: "button", className: "btn ghost overview-open", onClick: () => props.onNavigate("data") }, "Open ›"),
    ),
    h(
      "p",
      { className: "overview-door-text" },
      "What you have given us — the metadata columns and what each one means. Also where new metadata and new images will be added.",
    ),
    props.columnsError !== null ? h("p", { className: "error-text" }, props.columnsError) : null,
    h("p", { className: "designer-kicker" }, "Offers"),
    h(
      "div",
      { className: "overview-chips" },
      offeredFamilies(draft, columns).map((o) =>
        h(
          "span",
          { key: o.family, className: "overview-offer", title: o.pairOnLayout ? "The pair is chosen on the layout card" : undefined },
          o.family === "categorical" && o.count > 1 ? `categorical × ${o.count}` : o.family,
          o.pairOnLayout ? h("span", { className: "overview-offer-note" }, " · pair on the layout") : null,
        ),
      ),
    ),
    props.derived.problem !== null
      ? h("p", { className: "overview-warn" }, `⚠ A role change is incomplete — ${props.derived.problem}`)
      : changed.length > 0
        ? h(
            "p",
            { className: "overview-warn" },
            // The bar's count, not the column count: one pair edit is one role change however
            // many columns it lists (CONTRACT §4; review of #400, finding 1).
            `⚠ ${roleChanges} role${roleChanges === 1 ? "" : "s"} changed and not committed — `,
            h("span", { className: "designer-mono" }, changed.join(", ")),
          )
        : null,
  );

  const pills: ReactElement[] = [h("span", { key: "live", className: "pill ready" }, `${counts.live} live`)];
  if (counts.baking > 0) pills.push(h("span", { key: "baking", className: "pill proc" }, `${counts.baking} baking`));
  if (counts.queued > 0) pills.push(h("span", { key: "queued", className: "pill designer-pill-quiet" }, `${counts.queued} queued`));
  if (counts.stale > 0) pills.push(h("span", { key: "stale", className: "pill designer-pill-warn" }, `${counts.stale} stale`));
  const bakingNow = props.layouts.filter((l) => l.state === "baking" || l.rebake === "baking").map((l) => l.label);
  const layoutsDoor = h(
    "section",
    { className: "overview-door card", "aria-label": "Layouts" },
    h(
      "div",
      { className: "overview-door-head" },
      h("h2", { className: "overview-door-title" }, "Layouts"),
      h("span", { className: "designer-mono muted" }, String(props.layouts.length)),
      h("button", { type: "button", className: "btn ghost overview-open", onClick: () => props.onNavigate("layouts") }, "Open ›"),
    ),
    h(
      "p",
      { className: "overview-door-text" },
      "What is built on top of it — every arrangement a visitor can switch between, and what each one costs to build.",
    ),
    h("p", { className: "designer-kicker" }, "State"),
    h("div", { className: "overview-chips" }, ...pills),
    bakingNow.length > 0 ? h("p", { className: "overview-door-text" }, `${bakingNow.join(", ")} ${bakingNow.length === 1 ? "is" : "are"} baking`) : null,
    counts.rebaking > 0
      ? h("p", { className: "muted" }, `${counts.rebaking} live layout${counts.rebaking === 1 ? " has" : "s have"} a re-bake pending — it keeps serving until the new one lands`)
      : null,
  );

  // ---- the presentation panel -----------------------------------------------------------
  const fallbackName = collectionName({ dataset_id: dataset.dataset_id, display_name: null });
  const textField = (field: (typeof PRESENTATION_TEXT_FIELDS)[number]): ReactElement => {
    const st = status[field.name] ?? IDLE;
    const placeholder =
      field.name === "display_name"
        ? `Leave empty to show “${fallbackName}”`
        : field.name === "attribution"
          ? "e.g. Rijksmuseum, Amsterdam"
          : "https://… (optional)";
    return h(
      "label",
      { key: field.name, className: "field overview-field" },
      h("span", { className: "overview-field-label" }, field.label, statusNote(st)),
      h("input", {
        type: "text",
        name: field.name,
        value: values[field.name],
        placeholder,
        maxLength: field.max,
        "aria-invalid": st.state === "error" ? "true" : undefined,
        onChange: (e: { target: { value: string } }) => {
          const value = e.target.value;
          setValues((prev) => ({ ...prev, [field.name]: value }));
          clearTimeout(timers.current[field.name]);
          timers.current[field.name] = setTimeout(() => saveText(field.name), SAVE_PAUSE_MS);
        },
        onBlur: () => saveText(field.name),
      }),
      st.state === "error" ? h("span", { className: "error-text overview-field-error", role: "alert" }, st.error) : null,
    );
  };

  const selectField = (
    field: "default_layout" | "title_column",
    label: string,
    hint: string,
    options: { value: string; label: string }[],
    noneLabel: string,
    disabled: boolean,
  ): ReactElement => {
    const st = status[field] ?? IDLE;
    const current = presentation.dataset?.[field] ?? "";
    const known = current === "" || options.some((o) => o.value === current);
    return h(
      "label",
      { key: field, className: "field overview-field" },
      h("span", { className: "overview-field-label" }, label, h("span", { className: "muted" }, ` — ${hint}`), statusNote(st)),
      h(
        "select",
        {
          name: field,
          value: current,
          disabled,
          onChange: (e: { target: { value: string } }) => {
            const value = e.target.value === "" ? null : e.target.value;
            void save(field, value, current === "" ? null : current);
          },
        },
        h("option", { value: "" }, noneLabel),
        // D-xvi: a value that no longer resolves is shown as what it is, never silently
        // swapped — the viewer falls back, and saying so is the honest control.
        known ? null : h("option", { value: current, disabled: true }, `${current} (no longer available — falls back)`),
        ...options.map((o) => h("option", { key: o.value, value: o.value }, o.label)),
      ),
      st.state === "error" ? h("span", { className: "error-text overview-field-error", role: "alert" }, st.error) : null,
    );
  };

  const firstLive = live[0];
  const columnEntries = Object.values(presentation.columns ?? {});
  const renamedColumns = columnEntries.filter((c) => (c.label ?? "").trim() !== "").length;
  const hiddenColumns = columnEntries.filter((c) => c.hidden === true).length;
  const panel = h(
    "section",
    { className: "overview-presentation card", "aria-label": "Presentation" },
    h(
      "div",
      { className: "overview-door-head" },
      h("h2", { className: "overview-door-title" }, "Presentation"),
      h("span", { className: "overview-saved-chip" }, "✓ saved as you type"),
      h("span", { className: "muted" }, "— none of this re-bakes anything, so none of it waits for a commit"),
    ),
    h(
      "div",
      { className: "overview-fields" },
      ...PRESENTATION_TEXT_FIELDS.map(textField),
      selectField(
        "default_layout",
        "Default layout",
        "what a visitor opens on",
        live.map((l) => ({ value: l.layout_id, label: l.label })),
        firstLive !== undefined ? `First layout (${firstLive.label})` : "First layout",
        live.length === 0,
      ),
      selectField(
        "title_column",
        "Cell title",
        "what heads an image in the inspector",
        columnNames.map((c) => ({ value: c, label: c })),
        "None — cells are titled by number",
        columns === null,
      ),
      h(
        "div",
        { className: "field overview-field" },
        h("span", { className: "overview-field-label" }, "Column display names & hidden columns"),
        h(
          "p",
          { className: "overview-pointer" },
          "Per column, in ",
          h("button", { type: "button", className: "link-btn", onClick: () => props.onNavigate("data") }, "Data"),
          h("span", { className: "designer-mono muted" }, ` — ${renamedColumns} renamed · ${hiddenColumns} hidden`),
        ),
      ),
    ),
    h(
      "p",
      { className: "muted overview-footnote" },
      "A layout's display name lives on its own card in Layouts, and a column's lives on its row in Data — you rename a thing where you can see it. What sits here is the handful of facts that belong to the collection itself.",
    ),
  );

  return h(
    "div",
    { className: "overview" },
    identity,
    h("div", { className: "overview-doors" }, dataDoor, layoutsDoor),
    panel,
    deleting
      ? h(DeleteCollectionDialog, {
          client: props.client,
          dataset,
          bakedLayouts: live.length,
          onCancel: () => setDeleting(false),
          onDeleted: props.onDeleted,
          onAuthExpired: props.onAuthExpired,
        })
      : null,
  );
}
