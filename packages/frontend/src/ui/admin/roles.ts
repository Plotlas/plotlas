// The wizard's role-assignment model: a per-column draft the dropdowns edit,
// compiled into the column_roles JSON the API forwards to the pipeline. The
// CLIENT only shapes the object — the SERVER/pipeline is the validator (D-11);
// validateDraft below catches the structural mistakes the UI itself would
// otherwise submit blind (no filename column, an incomplete scatter pair, two
// datetime columns) PLUS the states the pipeline rejects or bakes degenerately
// (a column used as both a coordinate axis and a stored role, a pair whose two
// axes are the same column, an ingest-rejected knob combination).
//
// Pure, node-test importable: the one src VALUE import (./../layoutOptions, for
// the shared option defaults) is itself pure and pulls in no react/renderer.
import type { ColumnRoles } from "../../generated/column_roles";
import type { Presentation } from "../../generated/presentation";
import type { ColumnPresentationMap } from "../presentation";
import { DEFAULT_SCALE } from "../layoutOptions";

export type ColumnRoleChoice = "ignore" | "filename" | "datetime" | "categorical" | "tag" | "freeform";

export const DATETIME_FORMATS = ["iso8601", "unix_seconds", "unix_millis"] as const;
export type DatetimeFormat = (typeof DATETIME_FORMATS)[number];

/** Scatter pairs are atomic (an X without a Y is unrepresentable — D-26), so
 *  they are chosen as explicit pairs, not per-column dropdowns.
 *
 *  The four D-35 Seam G1 knobs (schema v2.3) are EDITED by the wizard's per-pair knob
 *  grid (Seam G3 / T2-125). A knob declared on the dataset's stored roles MUST survive
 *  the draft round-trip — the Add-Layout wizard re-POSTs the whole column_roles, and
 *  dropping a knob here would silently strip it from the committed manifest (2026-07-20
 *  review of the G1 seam). Absent stays absent (undefined), declared stays declared,
 *  verbatim. NB x_scale and y_scale always move TOGETHER: the pipeline rejects a mixed
 *  pair, so the picker exposes one Axis-scale knob writing both (T2-128 would split it). */
export interface ScatterPairDraft {
  x: string;
  y: string;
  label: string;
  x_scale?: "linear" | "log";
  y_scale?: "linear" | "log";
  normalize?: "fit" | "none";
  overlap?: "overdraw" | "jitter" | "aggregate";
}

/** Geographic pairs are atomic (a lon without a lat is unrepresentable — D-35 Seam G2), so —
 *  like scatter — they are chosen as explicit lon/lat pairs, not per-column dropdowns. The
 *  geographic family PROJECTS its degrees to a map (equirectangular | mercator) before the
 *  shared fit; there are NO scale knobs (degrees are degrees — D-35). Seam G3 (T2-125) is the
 *  editing surface. Absent projection/overlap stay ABSENT (undefined) so an untouched default
 *  never serializes an explicit value — preserving the manifest options-echo emission
 *  semantics, exactly like the scatter knobs. */
export interface GeoPairDraft {
  lon: string;
  lat: string;
  label: string;
  projection?: "equirectangular" | "mercator";
  overlap?: "overdraw" | "jitter" | "aggregate";
}

export interface RolesDraft {
  columns: string[]; // header order (parsed client-side, or typed free-text)
  choice: Record<string, ColumnRoleChoice>;
  datetimeFormat: DatetimeFormat;
  tagDelimiters: Record<string, string>; // per tag column; default ","
  scatterPairs: ScatterPairDraft[];
  // Human labels per column, seeded from the stored roles (2026-07-20 round-2
  // review): the wizard re-POSTs the WHOLE column_roles, so any label not carried
  // here is silently reset to its column name ("Accession number" -> "filename") in
  // the committed manifest — the labels feed search-hit and metadata-panel display.
  // Empty for a fresh ingest draft (buildColumnRoles then falls back to the
  // column-name defaults exactly as before). The wizard has no label-editing UI;
  // this is opaque carry, like the scatter knobs.
  labels: Record<string, string>;
  // The reserved `embedding` role (Phase 2), carried OPAQUELY for the same reason —
  // the draft cannot edit it, but dropping it on re-POST would strip it from the
  // committed manifest. Absent for drafts of datasets without one.
  embedding?: ColumnRoles["embedding"];
  // The columns whose values render as links. ORTHOGONAL to `choice`: "render as a link"
  // is a display MODIFIER layered on a shown column, not a role that replaces its storage.
  // A column is a link iff its name is in this list AND its choice is a shown scalar role
  // (freeform/categorical) — the roles ingest projects into metadata.parquet as a scalar
  // the panel can draw. EDITED by the wizard (the "render as link" checkbox), unlike the
  // opaque `embedding` carry. (Tag links are a tracked follow-on; datetime/coordinate
  // columns are not URL-bearing.)
  //
  // D-xvii moved where this LANDS, not what it means: `buildPresentation` compiles it into
  // `presentation.columns.<name>.render`, and `buildColumnRoles` no longer emits it at all.
  // It stays on the draft because the draft is the WIZARD's model — one table of per-column
  // decisions — and which file each decision ends up in is the compile step's business.
  url?: string[];
  // The `geographic` role (real-world lon/lat pairs — D-35 Seam G2) is now EDITED by the
  // wizard (Seam G3 / T2-125), decomposed into atomic geoPairs the Geographic section maps —
  // mirroring scatterPairs. buildColumnRoles re-emits roles.geographic from these; an empty
  // list emits no `geographic` key (absent stays absent) and an untouched pair serializes no
  // projection/overlap, so a re-POST still never strips or re-describes a committed geographic
  // layout's roles (the round-2 lossy-projection discipline). Replaces the G2 opaque carry.
  geoPairs: GeoPairDraft[];
}

/** Initial draft for a parsed header: every column defaults to "freeform"
 *  ("display only" — kept, shown in the metadata panel, AND stored, so no
 *  uploaded column is silently dropped at ingest; T2-94/T2-92), EXCEPT an
 *  auto-guessed filename column (a column literally named filename/file/
 *  image/path, else the first column). The server re-validates roles (D-11). */
export function emptyDraft(columns: string[]): RolesDraft {
  const choice: Record<string, ColumnRoleChoice> = {};
  for (const c of columns) choice[c] = "freeform";
  const guess =
    columns.find((c) => ["filename", "file", "image", "path"].includes(c.trim().toLowerCase())) ??
    columns[0];
  if (guess !== undefined) choice[guess] = "filename";
  return { columns, choice, datetimeFormat: "iso8601", tagDelimiters: {}, scatterPairs: [], geoPairs: [], labels: {}, url: [] };
}

function columnsWith(draft: RolesDraft, role: ColumnRoleChoice): string[] {
  return draft.columns.filter((c) => draft.choice[c] === role);
}

/** The column the draft makes the datetime — the first in `columns`, if a draft
 *  `validateDraft` refuses makes two — or undefined. The one definition: the compile, the
 *  layout ids, the designer's role locks and its pending model all read it. */
export function datetimeColumn(draft: RolesDraft): string | undefined {
  return draft.columns.find((c) => draft.choice[c] === "datetime");
}

/** Role choices that STORE the column in their own family. A coordinate axis (scatter x/y,
 *  geographic lon/lat) is already stored as its coordinate, so ALSO giving it one of these
 *  projects the same column twice in ingest's enrichment SELECT (`_enrichment_select` walks
 *  the coordinate columns and these families separately) — which surfaces as a raw pyarrow
 *  `KeyError: Field "col" exists 2 times in schema`, NOT the D-11 named-column error, after
 *  the job has already been accepted. `freeform` is exempt: it is the DEFAULT choice every
 *  column starts with (T2-94) and buildColumnRoles already drops coordinate axes from it.
 *  `ignore` stores nothing. */
const STORING_CHOICES: readonly ColumnRoleChoice[] = ["filename", "datetime", "categorical", "tag"];

/** Role choices a `url` display modifier may be layered on (schema v2.8): a link renders a
 *  SHOWN SCALAR string, which is exactly what `freeform` and `categorical` store. One predicate
 *  so the wizard checkbox, validateDraft and buildColumnRoles can never disagree on what is
 *  linkable — and the tracked tag-link follow-on (PR252-1) is a one-line change here. */
export const LINKABLE_CHOICES: readonly ColumnRoleChoice[] = ["freeform", "categorical"];
export function isLinkable(choice: ColumnRoleChoice | undefined): boolean {
  return choice !== undefined && LINKABLE_CHOICES.includes(choice);
}

/** Index of the first repeated key and the earlier index it duplicates, else null. */
function firstDuplicate(keys: string[]): { first: number; repeat: number } | null {
  for (let i = 0; i < keys.length; i += 1) {
    const first = keys.indexOf(keys[i]);
    if (first !== i) return { first, repeat: i };
  }
  return null;
}

/** The UI-level structural check (the server re-validates everything, D-11).
 *  Returns a human-readable problem or null when submittable.
 *
 *  Beyond "is the shape complete", this catches the states the PIPELINE rejects (or bakes
 *  degenerately) but the form can otherwise express — so the user is told inline instead of
 *  losing a bake cycle to a backend error. */
export function validateDraft(draft: RolesDraft): string | null {
  if (draft.columns.length === 0) return "No metadata columns — add column names or remove the CSV.";
  const filename = columnsWith(draft, "filename");
  if (filename.length === 0) return "Choose which column holds the image filename (the join key).";
  if (filename.length > 1) return "Only one column can be the filename join key.";
  if (columnsWith(draft, "datetime").length > 1) return "At most one column can be the datetime.";

  for (const [i, pair] of draft.scatterPairs.entries()) {
    if (pair.x === "" || pair.y === "") return `Scatter pair ${i + 1} needs both an X and a Y column (the pair is atomic).`;
    if (pair.x === pair.y) {
      return `Scatter pair ${i + 1} uses "${pair.x}" for both axes — that plots a straight diagonal line, not a scatter. Pick two different columns.`;
    }
    // The pipeline rejects a mixed-scale pair outright ("the shared-scale aspect fit assumes
    // both axes share one unit system"), and a log scale is incompatible with pass-through.
    // The Axis-scale knob writes both axes together and locks the conflicting value, so these
    // only fire for a draft built outside it.
    const xScale = pair.x_scale ?? DEFAULT_SCALE;
    const yScale = pair.y_scale ?? DEFAULT_SCALE;
    if (xScale !== yScale) {
      return `Scatter pair ${i + 1} must use the same scale on both axes — the shared-scale aspect fit assumes one unit system, so declare log on both or neither (per-axis fit is tracked as T2-128).`;
    }
    if (xScale === "log" && pair.normalize === "none") {
      return `Scatter pair ${i + 1} cannot combine a log scale with pass-through placement — pass-through keeps your coordinates untouched, so apply the log upstream before normalizing into 0..1.`;
    }
  }

  for (const [i, pair] of draft.geoPairs.entries()) {
    if (pair.lon === "" || pair.lat === "") {
      return `Geographic pair ${i + 1} needs both a longitude and a latitude column (the pair is atomic).`;
    }
    if (pair.lon === pair.lat) {
      return `Geographic pair ${i + 1} uses "${pair.lon}" for both longitude and latitude — that places every image on one diagonal line, not a map. Pick two different columns.`;
    }
  }

  // Identical pairs bake byte-identical layouts under collision-suffixed ids — pure waste,
  // and ingest has no guard for it.
  const scatterDup = firstDuplicate(draft.scatterPairs.map((p) => JSON.stringify([p.x, p.y])));
  if (scatterDup !== null) {
    return `Scatter pairs ${scatterDup.first + 1} and ${scatterDup.repeat + 1} use the same two columns — they would bake two identical layouts.`;
  }
  const geoDup = firstDuplicate(draft.geoPairs.map((g) => JSON.stringify([g.lon, g.lat])));
  if (geoDup !== null) {
    return `Geographic pairs ${geoDup.first + 1} and ${geoDup.repeat + 1} use the same two columns — they would bake two identical maps.`;
  }

  // A coordinate axis that ALSO carries a storing role — named here, where we can point at
  // both uses, rather than as a pyarrow duplicate-field crash mid-job.
  const axisUse = new Map<string, string>();
  for (const p of draft.scatterPairs) {
    axisUse.set(p.x, "a scatter X axis");
    axisUse.set(p.y, "a scatter Y axis");
  }
  for (const g of draft.geoPairs) {
    axisUse.set(g.lon, "a geographic longitude");
    axisUse.set(g.lat, "a geographic latitude");
  }
  for (const [column, use] of axisUse) {
    const choice = draft.choice[column];
    if (choice !== undefined && STORING_CHOICES.includes(choice)) {
      return `"${column}" is ${use} and is also mapped as "${choice}" — a coordinate column is already stored as its coordinate. Set its role to Ignore, or use a different column for the pair.`;
    }
  }

  // Schema v2.8: a link (url) is a display modifier that can only be drawn on a SHOWN SCALAR
  // column — Freeform or Categorical. Marking a coordinate axis, a datetime/filename/tag or
  // an ignored column as a link would bake a `url` the panel can never render (its value is
  // not a shown string), so reject it here rather than dropping it silently on re-POST.
  for (const column of draft.url ?? []) {
    if (axisUse.has(column) || !isLinkable(draft.choice[column])) {
      return `"${column}" is set to render as a link, but only Freeform or Categorical columns can be links. Change its role, or turn off the link.`;
    }
  }
  return null;
}

/** Compile the draft into the column_roles JSON (matches
 *  column_roles.schema.json / the generated ColumnRoles type). Empty families
 *  are omitted. Labels come from the draft's captured `labels` map (seeded from
 *  the stored roles — see RolesDraft), falling back to the column name (and
 *  "Filename" for the join key) exactly as before for fresh drafts. Throws on
 *  a draft validateDraft rejects. */
export function buildColumnRoles(draft: RolesDraft): ColumnRoles {
  const problem = validateDraft(draft);
  if (problem !== null) throw new Error(problem);
  const label = (c: string, fallback?: string): string => draft.labels[c] ?? fallback ?? c;

  const filenameCol = columnsWith(draft, "filename")[0];
  const roles: ColumnRoles = {
    filename: { column: filenameCol, label: label(filenameCol, "Filename") },
  };
  const datetime = datetimeColumn(draft);
  if (datetime !== undefined) {
    roles.datetime = { column: datetime, label: label(datetime), format: draft.datetimeFormat };
  }
  const categorical = columnsWith(draft, "categorical");
  if (categorical.length > 0) {
    roles.categorical = categorical.map((c) => ({ column: c, label: label(c) }));
  }
  const tags = columnsWith(draft, "tag");
  if (tags.length > 0) {
    roles.tag = tags.map((c) => ({
      column: c,
      label: label(c),
      delimiter: draft.tagDelimiters[c] ?? ",",
    }));
  }
  // freeform is now the DEFAULT non-filename role (T2-94), so a column chosen ONLY
  // as a scatter axis would ALSO carry the freeform default. Emitting it in both
  // roles.scatter AND roles.freeform would duplicate the column in ingest's
  // enrichment SELECT (_enrichment_select projects scatter- and freeform-columns
  // separately) — a duplicate-column error. A scatter axis is already stored as its
  // coordinate, so drop it from freeform.
  const scatterAxes = new Set(draft.scatterPairs.flatMap((p) => [p.x, p.y]));
  // D-35 Seam G2: geographic lon/lat are ALSO coordinate columns projected by ingest's
  // enrichment SELECT, so — like scatter axes — exclude them from freeform to avoid a
  // duplicate-column error (the geoPairs emit below re-emits them as their coordinate).
  const geoAxes = new Set(draft.geoPairs.flatMap((g) => [g.lon, g.lat]));
  const coordAxes = new Set([...scatterAxes, ...geoAxes]);
  const freeform = columnsWith(draft, "freeform").filter((c) => !coordAxes.has(c));
  if (freeform.length > 0) {
    roles.freeform = freeform.map((c) => ({ column: c, label: label(c) }));
  }
  // D-xvii: `url` used to be emitted HERE, into column_roles. It no longer is, and the
  // absence is the point — the bake only ever VALIDATED that role (nothing computed from
  // it, no cell moved), so it was presentation collected on the bake's input path. It is
  // now `presentation.columns.<name>.render`, compiled by buildPresentation below. This
  // function emits the BAKE's inputs only; a link is a display choice that needs nothing
  // but the CSV to exist, which is why it can be made before, during or after a bake.
  // The reserved embedding role rides through verbatim (opaque carry — see RolesDraft).
  if (draft.embedding !== undefined) {
    roles.embedding = draft.embedding;
  }

  // The geographic role (D-35 Seam G2) is compiled from the Geographic section's atomic
  // lon/lat pairs (Seam G3 / T2-125). Emitted ONLY when non-empty (absent stays absent);
  // projection/overlap pass through spread-conditional so an UNTOUCHED default serializes no
  // explicit value — the manifest options-echo emission stays intact (a geographic layout
  // always emits `options`; a scatter layout emits it only WHEN some knob is non-default,
  // and then carries all four keys).
  if (draft.geoPairs.length > 0) {
    roles.geographic = draft.geoPairs.map((g) => ({
      lon_column: g.lon,
      lat_column: g.lat,
      label: g.label !== "" ? g.label : `${g.lon} / ${g.lat}`,
      ...(g.projection !== undefined ? { projection: g.projection } : {}),
      ...(g.overlap !== undefined ? { overlap: g.overlap } : {}),
    }));
  }
  if (draft.scatterPairs.length > 0) {
    // The G1 knobs pass through verbatim — spread-conditional so an absent knob
    // stays ABSENT (not an own `undefined` key): the POSTed JSON and the round-trip
    // identity test both distinguish the two.
    roles.scatter = draft.scatterPairs.map((p) => ({
      x_column: p.x,
      y_column: p.y,
      label: p.label !== "" ? p.label : `${p.x} / ${p.y}`,
      ...(p.x_scale !== undefined ? { x_scale: p.x_scale } : {}),
      ...(p.y_scale !== undefined ? { y_scale: p.y_scale } : {}),
      ...(p.normalize !== undefined ? { normalize: p.normalize } : {}),
      ...(p.overlap !== undefined ? { overlap: p.overlap } : {}),
    }));
  }
  return roles;
}

/** Apply an edit to one scatter pair. Repointing an AXIS (x or y actually changing)
 *  DROPS the pair's carried D-35 G1 knobs (2026-07-20 round-2 review): a knob was
 *  declared for the ORIGINAL columns — e.g. a log validated as strictly-positive
 *  there — and silently riding onto a different column pair would mis-declare it.
 *  The wizard has no knob UI until Seam G3, so cleared knobs simply mean "defaults"
 *  for the new pair. Label edits (and no-op patches) keep the knobs. */
export function patchScatterPair(
  pair: ScatterPairDraft,
  patch: Partial<ScatterPairDraft>,
): ScatterPairDraft {
  const next = { ...pair, ...patch };
  const repointed =
    (patch.x !== undefined && patch.x !== pair.x) ||
    (patch.y !== undefined && patch.y !== pair.y);
  if (repointed) {
    delete next.x_scale;
    delete next.y_scale;
    delete next.normalize;
    delete next.overlap;
  }
  return next;
}

/** Apply an edit to one geographic pair. Repointing an AXIS (lon or lat actually changing)
 *  DROPS the pair's carried projection/overlap (the patchScatterPair precedent): a projection
 *  like `mercator` is validated against the ORIGINAL lat column's range (|lat| <= 85.051129),
 *  so silently riding it onto a different column could mis-declare it. Label edits (and no-op
 *  patches) keep the knobs; a cleared knob just means "defaults" for the new pair. */
export function patchGeoPair(pair: GeoPairDraft, patch: Partial<GeoPairDraft>): GeoPairDraft {
  const next = { ...pair, ...patch };
  const repointed =
    (patch.lon !== undefined && patch.lon !== pair.lon) ||
    (patch.lat !== undefined && patch.lat !== pair.lat);
  if (repointed) {
    delete next.projection;
    delete next.overlap;
  }
  return next;
}

/** layout_types the assigned roles unlock (brief §2: checkboxes gated on
 *  roles; grid is always available — the images-only floor, D-25). Pass null
 *  for an images-only dataset (no CSV). */
export function availableLayoutTypes(draft: RolesDraft | null): string[] {
  const types = ["grid"];
  if (draft !== null) {
    if (columnsWith(draft, "datetime").length > 0) types.push("datetime");
    if (columnsWith(draft, "categorical").length > 0) types.push("categorical");
    if (draft.scatterPairs.length > 0) types.push("scatter");
    if (draft.geoPairs.length > 0) types.push("geographic");
  }
  return types;
}

/** The pure INVERSE of buildColumnRoles: seed a RolesDraft from a dataset's stored
 *  column_roles (the manifest embeds them, D-16) so the add-layout wizard pre-fills the
 *  role table with what is ALREADY mapped ("import wizard, images already loaded" —
 *  add-layout memo §2 step 1). Column order is filename, then datetime, categorical,
 *  tag, freeform, then any scatter-only, then any geographic-only axis columns. A scatter
 *  pair is restored into scatterPairs and a geographic pair into geoPairs (there is no
 *  "scatter"/"geographic" ColumnRoleChoice — the pairs are atomic, D-26 / D-35 G2); a
 *  column that is ONLY a coordinate axis carries choice "ignore" (buildColumnRoles emits it
 *  from the pair, so it is never doubled into another family). datetimeFormat and per-column
 *  tag delimiters carry through.
 *
 *  buildColumnRoles(rolesDraftFromColumnRoles(roles)) reproduces `roles` FAITHFULLY —
 *  human labels captured per column and re-emitted verbatim (2026-07-20 round-2
 *  review: they were previously reset to normalized defaults, silently destroying
 *  e.g. "Accession number" -> "Filename" on any Add-Layout re-POST of a CLI-seeded
 *  dataset's roles), the D-35 G1 scatter knobs (x_scale/y_scale/normalize/overlap, v2.3)
 *  and the D-35 G2 geographic pairs (lon/lat + projection/overlap, v2.4) carried verbatim
 *  (declared stays declared, absent stays absent — so a re-POST never strips or re-describes
 *  a committed layout's roles), and the reserved `embedding` role (Phase 2) carried opaquely.
 *  Fresh drafts (emptyDraft) still produce the normalized-label defaults. */
export function rolesDraftFromColumnRoles(
  roles: ColumnRoles,
  presentationColumns?: ColumnPresentationMap,
): RolesDraft {
  const columns: string[] = [];
  const choice: Record<string, ColumnRoleChoice> = {};
  const labels: Record<string, string> = {};
  const assign = (column: string, c: ColumnRoleChoice, label?: string): void => {
    if (!(column in choice)) columns.push(column);
    choice[column] = c;
    if (label !== undefined) labels[column] = label;
  };

  assign(roles.filename.column, "filename", roles.filename.label);
  if (roles.datetime != null) assign(roles.datetime.column, "datetime", roles.datetime.label);
  for (const e of roles.categorical ?? []) assign(e.column, "categorical", e.label);
  for (const e of roles.tag ?? []) assign(e.column, "tag", e.label);
  for (const e of roles.freeform ?? []) assign(e.column, "freeform", e.label);
  // Schema v2.8: `url` is NOT restored as a choice — it is an orthogonal display modifier
  // carried in draft.url (below), so a link column keeps its real storing role here and is
  // never clobbered. (Older manifests co-emitted a link as freeform+url; that column is
  // picked up by the freeform pass above and its url flag is set from roles.url below.)

  const scatterPairs: ScatterPairDraft[] = (roles.scatter ?? []).map((s) => ({
    x: s.x_column,
    y: s.y_column,
    label: s.label,
    // G1 knobs (v2.3) carried verbatim — see ScatterPairDraft. Spread-conditional
    // so an absent knob does not materialize as an own `undefined` key.
    ...(s.x_scale !== undefined ? { x_scale: s.x_scale } : {}),
    ...(s.y_scale !== undefined ? { y_scale: s.y_scale } : {}),
    ...(s.normalize !== undefined ? { normalize: s.normalize } : {}),
    ...(s.overlap !== undefined ? { overlap: s.overlap } : {}),
  }));
  // Scatter-axis columns must appear in `columns` so the scatter X/Y dropdowns can list
  // them; a column used ONLY as an axis (not already roled above) has no standalone role.
  for (const s of roles.scatter ?? []) {
    for (const col of [s.x_column, s.y_column]) {
      if (!(col in choice)) assign(col, "ignore");
    }
  }

  const geoPairs: GeoPairDraft[] = (roles.geographic ?? []).map((g) => ({
    lon: g.lon_column,
    lat: g.lat_column,
    label: g.label,
    // G2 knobs (v2.4) carried verbatim — see GeoPairDraft. Spread-conditional so an absent
    // projection/overlap does not materialize as an own `undefined` key.
    ...(g.projection !== undefined ? { projection: g.projection } : {}),
    ...(g.overlap !== undefined ? { overlap: g.overlap } : {}),
  }));
  // Geo-axis columns must appear in `columns` so the lon/lat dropdowns can list them; a
  // column used ONLY as a geo axis (not already roled above) has no standalone role.
  for (const g of roles.geographic ?? []) {
    for (const col of [g.lon_column, g.lat_column]) {
      if (!(col in choice)) assign(col, "ignore");
    }
  }

  const tagDelimiters: Record<string, string> = {};
  for (const e of roles.tag ?? []) tagDelimiters[e.column] = e.delimiter;

  return {
    columns,
    choice,
    datetimeFormat: roles.datetime?.format ?? "iso8601",
    tagDelimiters,
    scatterPairs,
    geoPairs,
    labels,
    // Opaque carry (see RolesDraft) — spread-conditional so an absent role does not
    // materialize as an own `undefined` key.
    ...(roles.embedding !== undefined ? { embedding: roles.embedding } : {}),
    // The `url` display modifier, orthogonal to `choice`. Read from the PRESENTATION
    // record now, not from `column_roles` (D-xvii) — the second argument, absent for an
    // images-only or record-less dataset, in which case no column starts marked. Keep
    // only names that resolved to a SHOWN SCALAR role (freeform/categorical) above: a
    // stale link naming an unstored or non-scalar column is dropped on load, so it can
    // never later throw in validateDraft or offer a link the panel cannot draw. That
    // filter is now also the DANGLING-REFERENCE case (D-xvi) — the record may name a
    // column a metadata update removed, and dropping it here is the silent fallback.
    url: urlColumnsOf(presentationColumns).filter((c) => isLinkable(choice[c])),
  };
}

/** The columns a presentation record marks `render: "url"`. Sorted for a stable draft —
 *  object key order is insertion order, which is the record's authoring order rather than
 *  anything the user chose, and a draft that reorders itself between loads is noise in
 *  every diff of what the wizard would re-submit. */
function urlColumnsOf(columns: ColumnPresentationMap): string[] {
  if (columns === undefined) return [];
  return Object.entries(columns)
    .filter(([, entry]) => entry.render === "url")
    .map(([column]) => column)
    .sort();
}

/**
 * Compile the draft's DISPLAY choices into a presentation record (D-xvii) — the other
 * half of the payload `buildColumnRoles` used to carry alone.
 *
 * Today that is exactly the "render as link" toggle. It is separate from
 * `buildColumnRoles` because the two go to different FILES with different writers and
 * different costs: roles are bake inputs (changing one makes the tiles wrong), while a
 * link is inert — "the only thing the 'decide a URL' needs is the CSV to exist".
 *
 * Emits `{}` when the draft marks nothing, so an unset choice writes no keys rather than
 * an empty `columns` map: absent means absent, at every layer.
 *
 * NOT validated here beyond `validateDraft`'s linkable check, which the caller has
 * already run — the server is the validator (D-11), and this record's own contract is
 * validate-on-write, fall-back-on-read.
 */
export function buildPresentation(draft: RolesDraft): Presentation {
  const columns: NonNullable<Presentation["columns"]> = {};
  for (const column of draft.url ?? []) {
    if (isLinkable(draft.choice[column])) columns[column] = { render: "url" };
  }
  return Object.keys(columns).length > 0 ? { columns } : {};
}

/** A `render` entry as a PATCH sends it: `"url"` to mark the column a link, `null` to
 *  clear that key and leave the entry's other keys (a label) alone. */
export type ColumnRenderPatch = Record<string, { render: "url" | null }>;

/**
 * The `columns` PATCH that turns the STORED link flags into the draft's — or null when
 * nothing changed.
 *
 * The add-layout wizard cannot ride its link choices along with the bake: a bake never
 * writes the presentation record (D-xv), and `AddLayoutsRequest` carries no presentation
 * half. So the two halves of that wizard's submit go to two places, which is the file
 * boundary doing exactly what it exists to do — the roles cost a bake, the link flags do
 * not, and "the only thing the 'decide a URL' needs is the CSV to exist".
 *
 * Returns null for "no change" so an untouched wizard sends no PATCH at all. A write that
 * says nothing is still a write: it takes the dataset lock and rewrites the file.
 *
 * Clears with `{render: null}` rather than `{<column>: null}` — the latter removes the
 * whole entry, taking a label this wizard never edited with it.
 *
 * And it clears ONLY a column this draft has an opinion about — one whose role is linkable,
 * which is exactly the set the form draws a "render as link" checkbox for. Unticking that
 * box is the only way to say "not a link" here; everything else the record happens to carry
 * is a column the draft never modelled, and silence about it is not an untick.
 *
 * What it deliberately does NOT cover: re-roling a linked column away from
 * freeform/categorical inside this wizard. `RoleAssignmentForm.setChoice` drops the column
 * from `draft.url` in the same interaction, so by submit time that is indistinguishable from
 * a column that was never linkable, and it is left alone. That is the safer half of the
 * ambiguity — this PATCH goes BEFORE the enqueue, so clearing on a role change would erase
 * the flag even when the bake carrying that role change is then refused, and a surviving
 * `render: "url"` on a non-scalar column draws plain text rather than a broken link
 * (`sourceLink.sourceUrl` rejects anything that is not an absolute http(s) URL).
 */
export function columnRenderPatch(
  draft: RolesDraft,
  stored: ColumnPresentationMap,
): ColumnRenderPatch | null {
  const wanted = new Set(Object.keys(buildPresentation(draft).columns ?? {}));
  // Both sides of the diff must be the SAME population. `wanted` is filtered by
  // `isLinkable` (buildPresentation), so `had` is too — unfiltered, every stored
  // `render: "url"` the draft cannot model read as an untick: a link on a `tag` column
  // (reachable since the bake-time "url must be a stored scalar" guard was deleted with the
  // role — D-xvii — and no writer replaced it), or on a column the roles no longer carry at
  // all. `rolesDraftFromColumnRoles` drops both from `draft.url` on load, which is D-xvi
  // failing soft; the wizard then re-emitted that silence as `{col: {render: null}}` on a
  // submit that only ticked a layout. The erasure is PERMANENT, not merely wrong: the API
  // keeps an emptied entry as a tombstone (`presentation.apply_updates`, PR #346 review
  // finding 1), so the manifest's legacy `url` role no longer falls back through it, and on
  // a migrated tree the manifest key is already gone (PR #346 review finding 2).
  const had = new Set(urlColumnsOf(stored).filter((c) => isLinkable(draft.choice[c])));
  const patch: ColumnRenderPatch = {};
  for (const column of wanted) if (!had.has(column)) patch[column] = { render: "url" };
  for (const column of had) if (!wanted.has(column)) patch[column] = { render: null };
  return Object.keys(patch).length > 0 ? patch : null;
}

/** A layout the current draft can produce, for the add-layout wizard's Step 2 (memo
 *  §2). GRID is excluded — it is the always-present D-25 floor, never an *addable*
 *  layout. `layout_id` mirrors the pipeline's expanded-id naming convention
 *  (`pipeline.worker._family_layout_names`, transcribed): a SINGLE-entry family keeps
 *  the bare plugin name ("categorical"); a MULTI-entry family gets
 *  `{name}_{slug(distinguishing column)}` with "-{i}" appended on a slug collision. The
 *  wizard matches these against a dataset's already-baked layout_ids to show existing
 *  (disabled) vs new, and submits only the NEW ids — the bake hard-errors on an id that
 *  already exists (`worker._guard_no_collision`). */
export interface ProducibleLayout {
  layout_id: string;
  type: "datetime" | "categorical" | "scatter" | "geographic";
  label: string;
}

/** A column name as a layout_id slug — the transcribed twin of the pipeline's
 *  `worker._slug` (lowercase; runs outside [a-z0-9._-] collapsed to "-"). */
function layoutSlug(column: string): string {
  return column.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/** Expand one multi-entry family (categorical/scatter/geographic) into its (layout_id,
 *  label) list, applying the pipeline's exact single-vs-multi naming + collision suffixing
 *  (`worker._family_layout_names`). */
function familyLayoutIds(
  name: string,
  entries: { column: string; label: string }[],
): { layout_id: string; label: string }[] {
  const out: { layout_id: string; label: string }[] = [];
  const used = new Set<string>();
  const multi = entries.length > 1;
  entries.forEach(({ column, label }, i) => {
    let layoutId = name;
    if (multi) {
      const base = (layoutId = `${name}_${layoutSlug(column)}`);
      let suffix = i;
      while (used.has(layoutId)) {
        layoutId = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    used.add(layoutId);
    out.push({ layout_id: layoutId, label });
  });
  return out;
}

/** The layouts the draft can produce (grid excluded), each tagged with the layout_id
 *  the pipeline would assign — so the wizard can diff against a dataset's baked
 *  layout_ids. Mirrors buildColumnRoles' family selection + labels. */
export function producibleLayouts(draft: RolesDraft): ProducibleLayout[] {
  const out: ProducibleLayout[] = [];

  // datetime — single-compute; sole layout_id is the bare plugin name. Label = the
  // column name (buildColumnRoles).
  const datetimeCol = datetimeColumn(draft);
  if (datetimeCol !== undefined) {
    out.push({ layout_id: "datetime", type: "datetime", label: datetimeCol });
  }

  // categorical — one per categorical column; distinguishing column = the column; label
  // = the column name (buildColumnRoles).
  const categorical = columnsWith(draft, "categorical").map((c) => ({ column: c, label: c }));
  for (const { layout_id, label } of familyLayoutIds("categorical", categorical)) {
    out.push({ layout_id, type: "categorical", label });
  }

  // scatter — one per COMPLETE pair; distinguishing column = x_column; label = the pair
  // label else "x / y" (buildColumnRoles). Incomplete pairs are skipped (they fail
  // validateDraft and never bake).
  const scatter = draft.scatterPairs
    .filter((p) => p.x !== "" && p.y !== "")
    .map((p) => ({ column: p.x, label: p.label !== "" ? p.label : `${p.x} / ${p.y}` }));
  for (const { layout_id, label } of familyLayoutIds("scatter", scatter)) {
    out.push({ layout_id, type: "scatter", label });
  }

  // geographic — one per COMPLETE lon/lat pair; distinguishing column = lon_column (mirrors
  // worker._family_entries); label = the pair label else "lon / lat" (buildColumnRoles).
  // Incomplete pairs are skipped (they fail validateDraft and never bake).
  const geographic = draft.geoPairs
    .filter((g) => g.lon !== "" && g.lat !== "")
    .map((g) => ({ column: g.lon, label: g.label !== "" ? g.label : `${g.lon} / ${g.lat}` }));
  for (const { layout_id, label } of familyLayoutIds("geographic", geographic)) {
    out.push({ layout_id, type: "geographic", label });
  }

  return out;
}
