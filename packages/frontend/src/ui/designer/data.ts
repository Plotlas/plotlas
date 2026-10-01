// The designer's DATA view (seam L4; LAYOUT_DESIGNER D-xx/D-xxiii/D-xxvi/D-xxvii; boards
// `Data`, `RoleDensity`, `ImagesOnlyData`, `TagSidecar`, `MobileData`) — what each column
// MEANS. The shell imports exactly one name from here, `DataView` (CONTRACT §1).
//
// TWO KINDS OF EDIT, and they never mix (D-xx):
//   - a column's DISPLAY LABEL, HIDDEN flag and RENDER-AS-LINK are free. Each PATCHes
//     `.../presentation` as it is made — that one key of that one column, nothing else —
//     and hands the shell the record as stored (`onPresentationChange`). None of it ever
//     reaches the pending model, so none of it reaches the bar.
//   - a ROLE is invalidating. It goes through `onPendingChange(withDraft(...))` and
//     nothing else: no PATCH, no bake. Nothing in this view can start a bake (D-xxi).
//
// `columns.source` decides the screen, never the column count (CONTRACT §2): an
// images-only collection gets its own screen, not an empty table.
//
// The pure half — groups, pointer rows, the row's consequence words, the two-role defect —
// is `dataModel.ts`; which columns have that defect is `heldRoles.ts`, the one rule the
// commit's refusal reads too. The structure follows Overview.ts.
import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { LayoutInfo } from "../../api-client/types";
import { errText } from "../../api-client/errText";
import { datetimeColumn, isLinkable } from "../admin/roles";
import type { ColumnRoleChoice, RolesDraft } from "../admin/roles";
import type { DesignerViewProps } from "./contract";
import { SAVE_PAUSE_MS, assignedColumns, normalizeFieldValue, offeredFamilies } from "./Overview";
import { bakedFor, sendableDraft, withDraft } from "./pending";
import { createFreeEdits, useField, withColumnKey } from "./dataEdits";
import type { FieldKey, FreeEdits } from "./dataEdits";
import {
  GROUPS,
  ROLE_OPTIONS,
  buildRows,
  bulkChoiceLock,
  choiceLock,
  groupCounts,
  groupOfChoice,
  groupOfRow,
  layoutsBuiltOn,
  provenanceUnknown,
  queuedOn,
  rowColumns,
  rowConsequences,
} from "./dataModel";
import type { Consequence, DataGroup, PairRowModel, RowModel } from "./dataModel";
import { heldRoleConflicts, roleWord } from "./heldRoles";
import type { HeldRoleConflict } from "./heldRoles";

/** The four future actions D-xxvi puts in the header: visible, disabled, and honestly
 *  marked — the `KnobOption.disabled` contract. They do nothing. */
const COMING_TITLE = "Coming — not built yet";

function futureActions(first: string): ReactElement {
  return h(
    "div",
    { className: "data-future" },
    h("button", { type: "button", className: "btn ghost", disabled: true, title: COMING_TITLE }, first),
    h("button", { type: "button", className: "btn ghost", disabled: true, title: COMING_TITLE }, "Add images…"),
    h("span", { className: "data-coming" }, "both coming"),
  );
}

function layoutStatePill(layout: LayoutInfo): ReactElement {
  const [className, text] = statePill(layout);
  return h("span", { className }, text);
}

export function DataView(props: DesignerViewProps): ReactElement {
  // `columns.source` decides. Only when the list could not be read at all does the
  // committed manifest stand in: no roles there means no metadata source.
  const imagesOnly =
    props.columns !== null ? props.columns.source === "images_only" : props.pending.draft === null;
  return imagesOnly || props.pending.draft === null ? h(ImagesOnlyData, props) : h(RoleTable, props);
}

// ---------------------------------------------------------------------------
// The images-only screen (`ImagesOnlyData`)
// ---------------------------------------------------------------------------

const UNLOCKS: { title: string; text: string }[] = [
  { title: "Datetime", text: "A column of dates." },
  { title: "Categorical", text: "A column of groups — a department, a species." },
  { title: "Scatter", text: "Two numeric columns, picked as a pair on the layout." },
  { title: "Geographic", text: "A longitude and a latitude column." },
  { title: "Tag filtering", text: "A column of delimited tags." },
  { title: "Titles and details", text: "Any column, shown in the inspector." },
];

function ImagesOnlyData(props: DesignerViewProps): ReactElement {
  const grid = props.layouts.find((l) => l.type === "grid");
  const images = `${props.dataset.image_count.toLocaleString("en-US")} images`;
  return h(
    "section",
    { className: "data-view", "aria-label": "Data" },
    h(
      "div",
      { className: "data-header" },
      h("h2", { className: "designer-section-title" }, "Data"),
      h("span", { className: "data-facts" }, h("span", { className: "data-fact" }, "no metadata file"), h("span", { className: "data-fact" }, `· ${images}`)),
      futureActions("Add metadata…"),
    ),
    props.columnsError !== null ? h("p", { className: "error-text" }, props.columnsError) : null,
    h(
      "div",
      { className: "card data-empty" },
      h("h3", { className: "data-empty-title" }, "No metadata yet"),
      h(
        "p",
        { className: "data-empty-text" },
        "This collection is its images, and that is all the Grid layout needs. Metadata is a CSV with one row per image, joined by filename. It is what every other layout, and tag filtering, is built from.",
      ),
      h(
        "div",
        { className: "data-empty-cols" },
        h(
          "div",
          { className: "data-empty-col" },
          h("p", { className: "designer-kicker" }, "What you have now"),
          h(
            "div",
            { className: "data-have" },
            grid !== undefined ? layoutStatePill(grid) : null,
            h("span", { className: "data-have-title" }, grid?.label ?? "Grid"),
            h("span", { className: "data-have-text" }, "Every image, in filename order."),
          ),
          h(
            "div",
            { className: "data-have" },
            h("span", { className: "designer-mono data-have-title" }, "filename"),
            h("span", { className: "data-have-text" }, "Every image has one. It is what a metadata file would join on."),
          ),
        ),
        h(
          "div",
          { className: "data-empty-col" },
          h("p", { className: "designer-kicker" }, "What metadata would unlock"),
          h(
            "div",
            { className: "data-unlocks" },
            ...UNLOCKS.map((u) =>
              h("div", { key: u.title, className: "data-unlock" }, h("span", { className: "data-have-title" }, u.title), h("span", { className: "data-have-text" }, u.text)),
            ),
          ),
        ),
      ),
      h(
        "p",
        { className: "data-note" },
        h("strong", null, "Adding metadata to this collection is coming. "),
        "Until it lands, a collection with metadata starts as a new upload — this one stays as it is.",
      ),
    ),
    h(
      "div",
      { className: "data-footer" },
      h("span", { className: "muted" }, "This collection offers:"),
      h("span", { className: "overview-offer" }, "grid"),
      ...["datetime", "categorical", "scatter", "geographic"].map((f) =>
        h("span", { key: f, className: "data-offer-off" }, `${f} — needs metadata`),
      ),
      h("button", { type: "button", className: "btn ghost data-footer-go", onClick: () => props.onNavigate("layouts") }, "Go to Layouts ›"),
    ),
  );
}

// ---------------------------------------------------------------------------
// The role table (`Data`, `RoleDensity`, `TagSidecar`, `MobileData`)
// ---------------------------------------------------------------------------

type Chip = "all" | DataGroup | "changed";

const GROUP_TITLE: Record<DataGroup, string> = { assigned: "Assigned", display: "Display only", ignored: "Ignored" };
const GROUP_NOTE: Record<DataGroup, string> = {
  assigned: "the columns a layout can be built from; a coordinate pair is two columns on one row",
  display: "kept and shown in the detail panel, never used to place a cell. Rename or hide any of them here; both are free.",
  // NOT the board's "not stored at all": that is what Ignore means at first ingest. This
  // designer edits a BAKED collection, where a roles-only commit never rewrites
  // metadata.parquet (`run_set_roles`), the inspector reads every scalar column in it,
  // and the Data table lists only the columns a role names — so an ignored column leaves
  // this table and stays in the inspector. Hide is the control for the inspector.
  ignored: "no role. After the commit a column leaves this table, but its values stay in the collection and still show in the inspector — to hide one there, use Hide.",
};

/** What a role does with the column, when no layout is built on it. */
const ROLE_EFFECT: Record<ColumnRoleChoice, string> = {
  ignore: "no role — leaves this table on commit",
  filename: "joins metadata to images · required",
  datetime: "unlocks the datetime layout",
  categorical: "unlocks a categorical layout",
  tag: "adds tag filtering to every layout",
  freeform: "shown in the detail panel",
};

/** Why the tag delimiter is not an edit here: ingest applies it once (`string_split`), the
 *  parquet stores the resulting lists, every sidecar a bake writes is projected from them,
 *  and `set-roles` needs a tag column to be a list already — so no delimiter change can take
 *  effect, and committing one declares a split the stored lists never had (review of #384,
 *  F3; second review, #3). The datetime format is ingest-only for the same reason, and has
 *  no control here at all (D-xxxiii). */
const DELIMITER_TITLE =
  "Set at ingest — applied when the column was ingested. The stored tags were split then, and no commit or bake re-splits them.";

/** A role change as `withDraft` takes it. The draft's `url` (the wizard's link model) may
 *  only name a linkable column, or `validateDraft` refuses the draft — so moving a column
 *  away from Freeform/Categorical drops it there, exactly as RoleAssignmentForm.setChoice
 *  does, and moving it back restores it if the committed record had it, so a round trip
 *  leaves the draft equal to the seed. The link ITSELF is presentation and is untouched.
 *
 *  The datetime format and the tag delimiters are not this function's: the caller runs
 *  `sendableDraft` on the result (D-xxxiii; review of #394, finding 7). */
function draftWithChoices(draft: RolesDraft, seed: RolesDraft | null, changes: [string, ColumnRoleChoice][]): RolesDraft {
  const choice = { ...draft.choice };
  let url = [...(draft.url ?? [])];
  const seedUrl = seed?.url ?? [];
  for (const [column, next] of changes) {
    choice[column] = next;
    if (!isLinkable(next)) url = url.filter((c) => c !== column);
    else if (!url.includes(column) && seedUrl.includes(column)) url = [...url, column].sort();
  }
  return { ...draft, choice, url };
}

// ---- the free-edit fields: each subscribes to its own slot of the store (dataEdits.ts) ----

function StatusNote(props: { store: FreeEdits; column: string; field: FieldKey }): ReactElement | null {
  const { status } = useField(props.store, props.column, props.field);
  if (status.state === "saving") return h("span", { className: "designer-field-status" }, "Saving…");
  if (status.state === "saved") return h("span", { className: "designer-field-status designer-saved" }, "Saved");
  if (status.state === "error") return h("span", { className: "error-text data-field-error", role: "alert" }, status.error);
  return null;
}

/** A column's display-name field. It owns its keystrokes and its save pause, so typing
 *  redraws this input alone. While it is not being edited it FOLLOWS the store, so a record
 *  reloaded from elsewhere reaches it (second review of #384, #5); while it is, or after its
 *  save failed, what was typed stays on screen. */
function LabelInput(props: { store: FreeEdits; column: string }): ReactElement {
  const { store, column } = props;
  const field = useField(store, column, "label");
  const stored = (field.value as string | null) ?? "";
  const [text, setText] = useState(stored);
  const base = useRef(stored); // the stored value `text` last agreed with
  const dirty = useRef(false); // typed since the last save
  const typed = useRef(text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (!dirty.current && stored !== base.current && field.status.state !== "error") {
    base.current = stored;
    typed.current = stored;
    setText(stored);
  }
  function flush(): void {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current) return;
    dirty.current = false;
    const value = normalizeFieldValue(typed.current);
    base.current = value ?? "";
    store.save(column, "label", value);
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;
  // Leaving the view (a tab switch), or the row moving group, must not drop a pause-pending save.
  useEffect(() => () => flushRef.current(), []);
  return h("input", {
    type: "text",
    className: "role-label-input data-control",
    value: text,
    placeholder: column,
    "aria-label": `Display name for column ${column}`,
    onChange: (e: { target: { value: string } }) => {
      typed.current = e.target.value;
      dirty.current = true;
      setText(e.target.value);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => flushRef.current(), SAVE_PAUSE_MS);
    },
    onBlur: () => flush(),
  });
}

/** Hide — its next state is the opposite of what was last ASKED for, not of what landed. */
function HideToggle(props: { store: FreeEdits; column: string }): ReactElement {
  const { store, column } = props;
  const hidden = useField(store, column, "hidden").value === true;
  return h(
    "button",
    {
      type: "button",
      className: hidden ? "btn ghost data-hide data-hide-on" : "btn ghost data-hide",
      "aria-pressed": hidden,
      "aria-label": `Hide column ${column} in the inspector`,
      title: "Hidden from the inspector. Display only — the value is still in the data, and still searchable.",
      onClick: () => store.save(column, "hidden", store.current(column, "hidden") === true ? null : true),
    },
    hidden ? "hidden" : "shown",
  );
}

/** Render-as-link (D-xvii: a display choice, not a bake input) — drawn as last asked for. */
function LinkToggle(props: { store: FreeEdits; column: string }): ReactElement {
  const { store, column } = props;
  const isLink = useField(store, column, "render").value === "url";
  return h(
    "label",
    { className: "role-extra", title: "A display choice, not a bake input — it saves at once and re-bakes nothing." },
    h("input", {
      type: "checkbox",
      checked: isLink,
      "aria-label": `Render column ${column} as a link`,
      onChange: (e: { target: { checked: boolean } }) => store.save(column, "render", e.target.checked ? "url" : null),
    }),
    " link",
    h(StatusNote, { store, column, field: "render" }),
  );
}

// ---- a row as DATA, so an unchanged row is not redrawn (second review of #384, #8/#10) ----

type Option = { value: string; label: string; disabled: boolean };
type Effect =
  | { t: "built"; id: string; prefix: string; label: string; pill: [string, string]; unchecked: boolean }
  | { t: "queued"; label: string }
  | { t: "text"; text: string }
  | { t: "build-one" }
  | { t: "edit-there" };

interface ColumnRowView {
  column: string;
  selectable: boolean;
  selected: boolean;
  changed: boolean;
  twoRoles: boolean;
  sample: string | null;
  choice: ColumnRoleChoice;
  roleOptions: Option[];
  /** A tag row's delimiter: the committed one, or null when none survives to show. */
  delimiter: { committed: string | null } | null;
  linkable: boolean;
  effect: Effect[];
  consequences: Consequence[];
}

interface PairRowView {
  family: "scatter" | "geographic";
  a: string;
  b: string;
  changed: boolean;
  sample: string;
  effect: Effect[];
  consequences: Consequence[];
}

function statePill(layout: LayoutInfo): [string, string] {
  const state = layout.state ?? "live";
  if (state !== "live") return ["pill proc", state === "baking" ? "baking" : "queued"];
  if (layout.rebake === "baking") return ["pill proc", "re-baking"];
  if (layout.rebake === "queued") return ["pill proc", "re-bake queued"];
  return ["pill ready", "live"];
}

function lockedLabel(label: string, lock: string | null): string {
  return lock === null ? label : `${label} — unavailable: ${lock}`;
}

function RoleTable(props: DesignerViewProps): ReactElement {
  const draft = props.pending.draft as RolesDraft;
  const latest = useRef(props);
  latest.current = props;

  // ---- free edits: one store per view, each field subscribed to its own slot ------------
  const storeRef = useRef<FreeEdits | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createFreeEdits(props.presentation, {
      patch: (column, entry) => {
        const now = latest.current;
        return now.client.setDatasetPresentation(now.dataset.dataset_id, { columns: { [column]: entry } });
      },
      // A landed save applies ITS OWN KEY to the shell's CURRENT record — mounted or not. A
      // save can land after this view unmounted (a tab switch flushes a pending label), or
      // after Overview or another Data view changed the record; handing over this store's
      // copy overwrote those (round-4 review of #384, #3), and re-reading the server instead
      // raced later saves and rebuilt the pending model from storage (final review,
      // Regressions A and B). An updater merges; nothing is re-read.
      landed: (column, key, value) => latest.current.onPresentationChange((prev) => withColumnKey(prev, column, key, value)),
      authExpired: () => latest.current.onAuthExpired(),
      errorText: errText,
    });
  }
  const edits = storeRef.current;
  // The shell's record, however it changed — this view's own landings (merged by the shell),
  // a reload, a version bump, Overview. Fields not mid-save read it.
  useLayoutEffect(() => {
    edits.adopt(props.presentation);
  }, [props.presentation, edits]);

  const served = props.columns?.columns.map((c) => c.name) ?? [];
  const servedSet = new Set(served);
  const names = [...served, ...draft.columns.filter((c) => !servedSet.has(c))];
  const rows = buildRows(draft, names);
  const samples = new Map((props.columns?.columns ?? []).map((c) => [c.name, c.sample ?? null]));
  // The STORED type of each column — what `set-roles` validates a role against (F2).
  const dtypes = new Map((props.columns?.columns ?? []).map((c) => [c.name, c.dtype]));
  const conflicts = heldRoleConflicts(props.pending.committed, props.pending.seed);
  const changed = new Set(props.derived.changedColumns);

  const [filter, setFilter] = useState("");
  const [chip, setChip] = useState<Chip>("all");
  // Assigned open, the other two folded (D-xxvii) — except that a group holding a column
  // the draft cannot represent starts open, so that row is SEEN before anything is edited.
  const [open, setOpen] = useState<Record<DataGroup, boolean>>(() => {
    const flagged = new Set(rows.filter((r) => r.kind === "column" && conflicts.has(r.column)).map(groupOfRow));
    return { assigned: true, display: flagged.has("display"), ignored: flagged.has("ignored") };
  });
  // A narrowed view opens every group it narrowed to; this is what the user folded since
  // (second review of #384, #7 — the fold button did nothing while a filter was on). Reset
  // whenever the narrowing changes.
  const [narrowFolded, setNarrowFolded] = useState<Record<DataGroup, boolean>>(NONE_FOLDED);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkChoice, setBulkChoice] = useState<Record<DataGroup, ColumnRoleChoice>>({
    assigned: "freeform",
    display: "ignore",
    ignored: "freeform",
  });

  // ---- invalidating edits: through withDraft, and nothing else -----------------------
  function writeDraft(next: RolesDraft): void {
    const now = latest.current;
    now.onPendingChange(withDraft(now.pending, next));
  }

  function setRoles(changes: [string, ColumnRoleChoice][]): void {
    if (changes.length === 0) return;
    const now = latest.current;
    // `sendableDraft` puts the datetime format and the tag delimiters back to what a commit may
    // send — the rule the restore applies, so a session and a reload hold the same draft.
    writeDraft(sendableDraft(draftWithChoices(now.pending.draft as RolesDraft, now.pending.seed, changes), now.pending.committed));
    // Follow the row: a column moved into a folded group stays in sight — under a text filter
    // or the Changed chip too, where the fold is `narrowFolded` (round-4 review of #384, #5).
    // Under a GROUP chip (Assigned, Display only, Ignored) a row moved to another group
    // leaves the view: the chip asks for that group only.
    setOpen((prev) => {
      const next = { ...prev };
      for (const [, choice] of changes) next[groupOfChoice(choice)] = true;
      return next;
    });
    setNarrowFolded((prev) => {
      const next = { ...prev };
      for (const [, choice] of changes) next[groupOfChoice(choice)] = false;
      return next;
    });
  }

  function committedDelimiter(column: string): string | null {
    return props.pending.committed?.tag?.find((t) => t.column === column)?.delimiter ?? null;
  }

  // Row callbacks read only refs and stable setters, so a CACHED row element's handlers stay
  // correct however old the element is.
  const actions = useRef({
    role: (column: string, choice: ColumnRoleChoice) => setRoles([[column, choice]]),
    select: (column: string, on: boolean) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) next.add(column);
        else next.delete(column);
        return next;
      }),
    layouts: () => latest.current.onNavigate("layouts"),
  });
  actions.current.role = (column, choice) => setRoles([[column, choice]]);

  // ---- what is shown ----------------------------------------------------------------------
  const needle = filter.trim().toLowerCase();
  const matches = (row: RowModel): boolean => {
    const cols = rowColumns(row);
    if (chip === "changed" && !cols.some((c) => changed.has(c))) return false;
    if (chip !== "all" && chip !== "changed" && groupOfRow(row) !== chip) return false;
    if (needle === "") return true;
    return cols.some((c) => c.toLowerCase().includes(needle) || String(edits.current(c, "label") ?? "").toLowerCase().includes(needle));
  };
  // A narrowed view opens what it narrowed to: a filter that hides its only match inside a
  // folded group would read as "no such column".
  const narrowed = chip !== "all" || needle !== "";

  const assigned = assignedColumns(draft, names);
  const counts = groupCounts(draft, names, assigned);
  const chips: { chip: Chip; label: string; n: number }[] = [
    { chip: "all", label: "All", n: counts.all },
    { chip: "assigned", label: "Assigned", n: counts.assigned },
    { chip: "display", label: "Display only", n: counts.display },
    { chip: "ignored", label: "Ignored", n: counts.ignored },
    { chip: "changed", label: "Changed", n: props.derived.changedColumns.length },
  ];

  const unknownProvenance = provenanceUnknown(props.layouts).length > 0;
  const datetimeHolder = datetimeColumn(draft) ?? null; // once per render, not once per option per row

  // ---- one row, as data -----------------------------------------------------------------------
  function effectOf(row: RowModel, built: LayoutInfo[]): Effect[] {
    const parts: Effect[] = built.map((layout) => {
      const baked = bakedFor(props.derived, layout.layout_id);
      return {
        t: "built",
        id: layout.layout_id,
        prefix: row.kind === "pair" ? `${row.family === "geographic" ? "lon/lat" : "x/y"} of ` : "built ",
        label: layout.label,
        pill: statePill(layout),
        // Durable: the bake record cannot say whether it is out of date (pre-2.10). Never
        // shown as healthy (CONTRACT §4, `checkable`).
        unchecked: baked !== undefined && !baked.checkable,
      };
    });
    for (const q of queuedOn(row, props.derived)) parts.push({ t: "queued", label: q.label });
    if (parts.length === 0 && row.kind === "column") {
      if (row.choice === "datetime" || row.choice === "categorical") {
        // Before 2.9 no layout recorded its columns, so "none uses it" cannot be told —
        // and offering to build one would invite a duplicate of a layout that exists.
        parts.push(unknownProvenance ? { t: "text", text: "which layout reads it isn't recorded" } : { t: "build-one" });
      } else {
        parts.push({ t: "text", text: ROLE_EFFECT[row.choice] });
      }
    }
    if (row.kind === "pair") {
      if (parts.length === 0) parts.push({ t: "text", text: unknownProvenance ? "which layout uses it isn't recorded" : "no layout yet" });
      parts.push({ t: "edit-there" });
    }
    return parts;
  }

  function consequencesOf(row: RowModel, built: LayoutInfo[], conflict: HeldRoleConflict | undefined): Consequence[] {
    return rowConsequences({ row, layouts: props.layouts, derived: props.derived, committed: props.pending.committed, draft, conflict, built });
  }

  function columnView(row: Extract<RowModel, { kind: "column" }>, selectable: boolean): ColumnRowView {
    const { column, choice } = row;
    const built = layoutsBuiltOn(row, props.layouts);
    const conflict = conflicts.get(column);
    const dtype = dtypes.get(column);
    return {
      column,
      selectable,
      selected: selected.has(column),
      changed: changed.has(column),
      twoRoles: conflict !== undefined,
      sample: samples.get(column) ?? null,
      choice,
      // What the worker would refuse, and what `validateDraft` refuses, is shown disabled
      // with the reason — the `KnobOption.disabled` honesty contract (F2; second review #6).
      // The join key is fixed by the ingest; moving it is a re-ingest, not a role change.
      roleOptions: ROLE_OPTIONS.map((o) => {
        const lock = choiceLock(o.value, column, dtype, draft, datetimeHolder);
        return { value: o.value, label: lockedLabel(o.label, lock), disabled: (o.value === "filename" && choice !== "filename") || lock !== null };
      }),
      delimiter: choice === "tag" ? { committed: committedDelimiter(column) } : null,
      linkable: isLinkable(choice),
      effect: effectOf(row, built),
      consequences: consequencesOf(row, built, conflict),
    };
  }

  function pairView(row: PairRowModel): PairRowView {
    const [a, b] = row.columns;
    const built = layoutsBuiltOn(row, props.layouts);
    const sample = (c: string): string => samples.get(c) ?? "—";
    return {
      family: row.family,
      a,
      b,
      changed: row.columns.some((c) => changed.has(c)),
      sample: `${sample(a)}, ${sample(b)}`,
      effect: effectOf(row, built),
      consequences: consequencesOf(row, built, undefined),
    };
  }

  // ---- one row, drawn — cached by what it draws ---------------------------------------------
  // A save lands → the shell hands the record back → this view re-renders. The free-edit
  // fields read the store, not this render, so a row whose DATA is unchanged returns the very
  // element it returned last time and React skips its whole subtree. Measured at 500 columns
  // (second review of #384, #8): see the PR.
  const rowCache = useRef(new Map<string, { sig: string; el: ReactElement }>());
  function cached<V>(key: string, view: V, draw: (view: V) => ReactElement): ReactElement {
    const sig = JSON.stringify(view);
    const hit = rowCache.current.get(key);
    if (hit !== undefined && hit.sig === sig) return hit.el;
    const el = draw(view);
    rowCache.current.set(key, { sig, el });
    return el;
  }

  const store = edits;
  const act = actions.current;

  function cellLabel(text: string): ReactElement {
    return h("span", { className: "data-cell-label" }, text);
  }

  function drawEffect(parts: Effect[]): ReactElement[] {
    return parts.map((p, i) => {
      if (p.t === "built") {
        return h(
          "span",
          { key: `b-${p.id}`, className: "data-built" },
          p.prefix,
          h("strong", null, p.label),
          " ",
          h("span", { className: p.pill[0] }, p.pill[1]),
          p.unchecked
            ? h(
                "span",
                {
                  className: "pill designer-pill-quiet",
                  title: "Baked before layouts recorded how they read their columns, so whether it is out of date can't be told.",
                },
                "unchecked",
              )
            : null,
        );
      }
      if (p.t === "queued") {
        return h(
          "span",
          { key: `q-${p.label}`, className: "data-built data-queued" },
          "queues ",
          h("strong", null, p.label),
          " ",
          h("span", { className: "pill designer-pill-quiet" }, "queued"),
        );
      }
      if (p.t === "build-one") {
        return h(
          "span",
          { key: `n-${i}`, className: "muted" },
          "no layout uses it yet ",
          h("button", { type: "button", className: "link-btn", onClick: () => act.layouts() }, "Build one"),
        );
      }
      if (p.t === "edit-there") {
        return h(
          "span",
          { key: `e-${i}`, className: "muted" },
          " — ",
          h("button", { type: "button", className: "link-btn", onClick: () => act.layouts() }, "edit it there"),
        );
      }
      return h("span", { key: `t-${i}`, className: "muted" }, p.text);
    });
  }

  function drawConsequences(lines: Consequence[]): ReactElement | null {
    if (lines.length === 0) return null;
    return h(
      "ul",
      { className: "data-consequences" },
      ...lines.map((c, i) =>
        h(
          "li",
          {
            key: `${c.kind}-${i}`,
            className: c.kind === "held-roles" || c.kind === "edit-orphaned" ? "data-consequence data-consequence-alert" : "data-consequence",
            "data-kind": c.kind,
            role: c.kind === "held-roles" ? "note" : undefined,
          },
          "⚠ ",
          c.text,
        ),
      ),
    );
  }

  function drawColumnRow(v: ColumnRowView): ReactElement {
    const { column } = v;
    let options: ReactElement;
    // A date row has no options: its format was a parsing hint for the upload, and after
    // ingest a date is a role and nothing more (D-xxxiii).
    if (v.delimiter !== null) {
      // The COMMITTED delimiter when the committed roles declare the column a tag. For a
      // column re-tagged after an earlier commit un-tagged it, no delimiter survives to show:
      // a delimiter lives only in its `column_roles.tag[]` entry, which `set-roles` replaces
      // wholesale — so un-tagging ANY tag column drops it (the `tags` block holds only the
      // sidecar's path and format). None is claimed.
      options =
        v.delimiter.committed !== null
          ? h(
              "label",
              { className: "role-extra", title: DELIMITER_TITLE },
              "delimiter ",
              h("input", {
                className: "delimiter-input",
                value: v.delimiter.committed,
                readOnly: true,
                title: DELIMITER_TITLE,
                "aria-label": `Tag delimiter for column ${column}`,
              }),
              h("span", { className: "muted" }, "set at ingest"),
            )
          : h(
              "span",
              { className: "muted", title: DELIMITER_TITLE },
              "delimiter set at ingest — which one is no longer recorded",
            );
    } else if (v.linkable) {
      options = h(LinkToggle, { store, column });
    } else {
      options = h("span", { className: "muted" }, "—");
    }
    return h(
      "div",
      {
        key: `c-${column}`,
        className: v.changed || v.twoRoles ? "data-row data-row-changed" : "data-row",
        "data-column": column,
      },
      h(
        "div",
        { className: "data-cell data-cell-column" },
        v.selectable
          ? h("input", {
              type: "checkbox",
              className: "data-select",
              checked: v.selected,
              "aria-label": `Select column ${column}`,
              onChange: (e: { target: { checked: boolean } }) => act.select(column, e.target.checked),
            })
          : null,
        h("span", { className: "designer-mono data-column-name" }, column),
        v.changed ? h("span", { className: "data-changed" }, "changed") : null,
        v.twoRoles ? h("span", { className: "data-changed" }, "two roles") : null,
      ),
      h(
        "div",
        { className: "data-cell data-cell-shown" },
        cellLabel("Shown as"),
        h("div", { className: "data-shown" }, h(LabelInput, { store, column }), h(HideToggle, { store, column })),
        h(StatusNote, { store, column, field: "label" }),
        h(StatusNote, { store, column, field: "hidden" }),
      ),
      h(
        "div",
        { className: "data-cell data-cell-role" },
        cellLabel("Role"),
        h(
          "select",
          {
            className: "role-select data-control",
            value: v.choice,
            disabled: v.choice === "filename",
            title: v.choice === "filename" ? "The join key — every image was matched to its row by this column" : undefined,
            "aria-label": `Role for column ${column}`,
            onChange: (e: { target: { value: string } }) => act.role(column, e.target.value as ColumnRoleChoice),
          },
          v.roleOptions.map((o) => h("option", { key: o.value, value: o.value, disabled: o.disabled }, o.label)),
        ),
      ),
      h("div", { className: "data-cell data-cell-options" }, cellLabel("Options"), options),
      h(
        "div",
        { className: "data-cell data-cell-effect" },
        cellLabel("Sample · effect"),
        h("span", { className: "designer-mono data-sample" }, v.sample !== null && v.sample !== "" ? v.sample : "—"),
        h("span", { className: "muted" }, " · "),
        ...drawEffect(v.effect),
      ),
      drawConsequences(v.consequences),
    );
  }

  function drawPairRow(v: PairRowView): ReactElement {
    return h(
      "div",
      {
        key: `p-${v.family}-${v.a}-${v.b}`,
        className: v.changed ? "data-row data-row-pair data-row-changed" : "data-row data-row-pair",
        "data-pair": `${v.a},${v.b}`,
        "data-family": v.family,
      },
      h(
        "div",
        { className: "data-cell data-cell-column" },
        h("span", { className: "designer-mono data-column-name" }, `${v.a}, ${v.b}`),
        v.changed ? h("span", { className: "data-changed" }, "changed") : null,
      ),
      h("div", { className: "data-cell data-cell-shown" }, cellLabel("Shown as"), h("span", { className: "muted" }, "—")),
      h(
        "div",
        { className: "data-cell data-cell-role" },
        cellLabel("Role"),
        h("span", { className: "data-locked", title: "A pair is a layout: both columns are picked on its card (D-xxiii)" }, "Coordinate pair"),
      ),
      h("div", { className: "data-cell data-cell-options" }, cellLabel("Options"), h("span", { className: "muted" }, "on the layout")),
      h(
        "div",
        { className: "data-cell data-cell-effect" },
        cellLabel("Sample · effect"),
        h("span", { className: "designer-mono data-sample" }, v.sample),
        h("span", { className: "muted" }, " · "),
        ...drawEffect(v.effect),
      ),
      drawConsequences(v.consequences),
    );
  }

  function drawRow(row: RowModel, selectable: boolean): ReactElement {
    if (row.kind === "pair") return cached(`p-${row.family}-${row.columns.join("\u0000")}`, pairView(row), drawPairRow);
    return cached(`c-${row.column}`, columnView(row, selectable), drawColumnRow);
  }

  // ---- one group ------------------------------------------------------------------------------
  function groupSection(group: DataGroup): ReactElement | null {
    const inGroup = rows.filter((r) => groupOfRow(r) === group);
    const shown = inGroup.filter(matches);
    if (narrowed && shown.length === 0) return null;
    const isOpen = narrowed ? !narrowFolded[group] : open[group];
    const n = inGroup.reduce((sum, r) => sum + rowColumns(r).length, 0);
    const selectable = group !== "assigned";
    const shownColumns = shown.flatMap((r) => (r.kind === "column" ? [r.column] : []));
    const picked = shownColumns.filter((c) => selected.has(c));
    const allPicked = shownColumns.length > 0 && picked.length === shownColumns.length;
    const title = GROUP_TITLE[group];
    const bulkTo = bulkChoice[group];
    const bulkLock = picked.length > 0 ? bulkChoiceLock(bulkTo, picked, dtypes, draft) : null;
    return h(
      "section",
      { key: group, className: "data-group", "aria-label": title },
      h(
        "div",
        { className: "data-group-head" },
        h(
          "button",
          {
            type: "button",
            className: "data-group-toggle",
            "aria-expanded": isOpen,
            onClick: () =>
              narrowed
                ? setNarrowFolded((prev) => ({ ...prev, [group]: !prev[group] }))
                : setOpen((prev) => ({ ...prev, [group]: !prev[group] })),
          },
          h("span", { className: "data-group-caret", "aria-hidden": "true" }, isOpen ? "▾" : "▸"),
          h("span", { className: "data-group-title" }, title),
          h("span", { className: "designer-mono data-group-count" }, String(n)),
        ),
        h("span", { className: "muted data-group-note" }, `— ${GROUP_NOTE[group]}`),
        selectable && isOpen && shownColumns.length > 0
          ? h(
              "label",
              { className: "role-extra data-select-all" },
              h("input", {
                type: "checkbox",
                checked: allPicked,
                "aria-label": `Select every ${title} column`,
                onChange: (e: { target: { checked: boolean } }) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const c of shownColumns) {
                      if (e.target.checked) next.add(c);
                      else next.delete(c);
                    }
                    return next;
                  }),
              }),
              " all",
            )
          : null,
        group === "display" && shownColumns.length > 0
          ? h(
              "button",
              {
                type: "button",
                className: "btn ghost data-group-action",
                onClick: () => setRoles(shownColumns.map((c) => [c, "ignore"])),
              },
              `Set all ${shownColumns.length} to Ignore`,
            )
          : null,
      ),
      isOpen && picked.length > 0
        ? h(
            "div",
            { className: "data-bulk", role: "group", "aria-label": `Bulk role for ${title}` },
            h("span", { className: "data-bulk-count" }, `${picked.length} selected`),
            h(
              "label",
              { className: "role-extra" },
              `Set role for ${picked.length === 1 ? "it" : `all ${picked.length}`}:`,
              h(
                "select",
                {
                  className: "role-select",
                  value: bulkTo,
                  "aria-label": `Role for the selected ${title} columns`,
                  onChange: (e: { target: { value: string } }) =>
                    setBulkChoice((prev) => ({ ...prev, [group]: e.target.value as ColumnRoleChoice })),
                },
                ROLE_OPTIONS.filter((o) => o.value !== "filename").map((o) => {
                  const lock = bulkChoiceLock(o.value, picked, dtypes, draft);
                  return h("option", { key: o.value, value: o.value, disabled: lock !== null }, lockedLabel(o.label, lock));
                }),
              ),
            ),
            // The role picked may have become unavailable since — another column ticked after
            // it — and Apply must not apply what the select now shows disabled (round-4
            // review of #384, #1). Disabled, with why, and refused in the handler as well.
            h(
              "button",
              {
                type: "button",
                className: "btn pri",
                disabled: bulkLock !== null,
                title: bulkLock ?? undefined,
                onClick: () => {
                  if (bulkLock !== null) return;
                  setRoles(picked.map((c) => [c, bulkTo]));
                  setSelected(new Set());
                },
              },
              "Apply",
            ),
            bulkLock !== null ? h("span", { className: "muted" }, `${roleWord(bulkTo)} is unavailable: ${bulkLock}`) : null,
            h("button", { type: "button", className: "btn ghost", onClick: () => setSelected(new Set()) }, "Clear"),
          )
        : null,
      isOpen ? h("div", { className: "data-rows" }, ...shown.map((r) => drawRow(r, selectable))) : null,
    );
  }

  // ---- the screen ------------------------------------------------------------------------------
  const source = props.manifest.dataset_metadata.source ?? "metadata";
  const flagged = [...conflicts.keys()];
  return h(
    "section",
    { className: "data-view", "aria-label": "Data" },
    h(
      "div",
      { className: "data-header" },
      h("h2", { className: "designer-section-title" }, "Data"),
      h(
        "span",
        { className: "data-facts" },
        ...[source, `ingested ${props.dataset.ingest_timestamp.slice(0, 10)}`, `${names.length} column${names.length === 1 ? "" : "s"}`].map(
          (fact, i) => h("span", { key: fact, className: "data-fact" }, i === 0 ? fact : `· ${fact}`),
        ),
      ),
      futureActions("Replace metadata…"),
    ),
    h(
      "p",
      { className: "data-intro" },
      "What each column ",
      h("em", null, "means"),
      ". A role decides where cells go, so changing one after a bake makes that layout's tiles wrong — the row says which layout, and the bar below carries the cost. A display name is free and saves as you type.",
    ),
    props.columnsError !== null
      ? h("p", { className: "error-text" }, `Couldn't read the column list — ${props.columnsError}. Roles still come from the committed manifest; samples are unavailable.`)
      : null,
    flagged.length > 0
      ? h(
          "p",
          { className: "data-alert", role: "note" },
          `⚠ ${flagged.length === 1 ? "One column carries" : `${flagged.length} columns carry`} two roles the designer can hold only one of: `,
          h("span", { className: "designer-mono" }, flagged.join(", ")),
          ". Its row says which role a role change would drop.",
        )
      : null,
    h(
      "div",
      { className: "data-tools" },
      h("input", {
        type: "search",
        className: "role-label-input data-filter",
        value: filter,
        placeholder: `Filter ${names.length} columns`,
        "aria-label": "Filter columns",
        onChange: (e: { target: { value: string } }) => {
          setFilter(e.target.value);
          setNarrowFolded(NONE_FOLDED);
        },
      }),
      h(
        "div",
        { className: "chip-row data-chips", role: "group", "aria-label": "Show" },
        ...chips.map((c) =>
          h(
            "button",
            {
              key: c.chip,
              type: "button",
              className: chip === c.chip ? "chip chip-selected" : "chip",
              "aria-pressed": chip === c.chip,
              onClick: () => {
                setChip(c.chip);
                setNarrowFolded(NONE_FOLDED);
              },
            },
            `${c.label} ${c.n}`,
          ),
        ),
      ),
    ),
    h(
      "div",
      { className: "data-head", "aria-hidden": "true" },
      ...["Column", "Shown as", "Role", "Options", "Sample · effect"].map((t) => h("span", { key: t }, t)),
    ),
    ...GROUPS.map(groupSection),
    h(
      "div",
      { className: "data-footer" },
      h("span", { className: "muted" }, "These roles offer:"),
      // D-xxiii: scatter and geographic follow the DATA (≥ 2 numeric columns), never an
      // existing pair — `offeredFamilies`, not `availableLayoutTypes`.
      ...offeredFamilies(draft, props.columns).map((o) =>
        h(
          "span",
          { key: o.family, className: "overview-offer" },
          o.family === "categorical" && o.count > 1 ? `categorical × ${o.count}` : o.family,
        ),
      ),
      h("span", { className: "muted data-footer-note" }, "· Grid needs no metadata and is always available"),
      h("button", { type: "button", className: "btn ghost data-footer-go", onClick: () => props.onNavigate("layouts") }, "Go to Layouts ›"),
    ),
  );
}

const NONE_FOLDED: Record<DataGroup, boolean> = { assigned: false, display: false, ignored: false };
