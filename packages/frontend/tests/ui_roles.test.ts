// Tier-1: the wizard's RolesDraft -> column_roles compilation (the JSON the
// API forwards to the pipeline; the SERVER is the validator — D-11) and the
// layout_types gating (grid always; datetime/categorical/scatter unlock with
// their roles; scatter pairs are atomic per D-26).
import assert from "node:assert/strict";
import test from "node:test";

import {
  availableLayoutTypes,
  buildColumnRoles,
  emptyDraft,
  patchGeoPair,
  patchScatterPair,
  producibleLayouts,
  rolesDraftFromColumnRoles,
  validateDraft,
} from "../src/ui/admin/roles.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import type { ColumnRoles } from "../src/generated/column_roles.ts";

const HEADER = ["filename", "shot_date", "category", "tags", "notes", "umap_x", "umap_y"];

function fullDraft(): RolesDraft {
  const draft = emptyDraft(HEADER);
  draft.choice.shot_date = "datetime";
  draft.choice.category = "categorical";
  draft.choice.tags = "tag";
  draft.choice.notes = "freeform";
  draft.datetimeFormat = "unix_seconds";
  draft.tagDelimiters.tags = "|";
  draft.scatterPairs = [{ x: "umap_x", y: "umap_y", label: "UMAP" }];
  return draft;
}

test("emptyDraft guesses the filename column and defaults every other column to freeform (display-only)", () => {
  const draft = emptyDraft(HEADER);
  assert.equal(draft.choice.filename, "filename");
  // T2-94: non-filename columns default to freeform ("display only") — kept, shown,
  // AND stored, so no uploaded column is silently dropped at ingest — not "ignore".
  assert.equal(draft.choice.category, "freeform");
  assert.equal(draft.choice.notes, "freeform");
  assert.equal(draft.choice.umap_x, "freeform");
  // No recognizable name: the first column is the filename guess; the rest freeform.
  const other = emptyDraft(["pic", "x"]);
  assert.equal(other.choice.pic, "filename");
  assert.equal(other.choice.x, "freeform");
});

test("buildColumnRoles omits scatter-axis columns from freeform (no duplicate-column ingest)", () => {
  // With freeform the default, a column used ONLY as a scatter axis also carries the
  // freeform default; emitting it in both roles.scatter and roles.freeform would
  // duplicate the column in ingest's enrichment SELECT. It is stored as its scatter
  // coordinate, so buildColumnRoles drops scatter axes from freeform.
  const draft = emptyDraft(["filename", "umap_x", "umap_y", "notes"]);
  draft.scatterPairs = [{ x: "umap_x", y: "umap_y", label: "UMAP" }];
  const roles = buildColumnRoles(draft);
  assert.deepEqual(roles.freeform, [{ column: "notes", label: "notes" }]);
  assert.deepEqual(roles.scatter, [{ x_column: "umap_x", y_column: "umap_y", label: "UMAP" }]);
});

test("buildColumnRoles compiles datetime+format, multi-categorical, scatter pairs, tag+delimiter, freeform", () => {
  const roles = buildColumnRoles(fullDraft());
  assert.deepEqual(roles, {
    filename: { column: "filename", label: "Filename" },
    datetime: { column: "shot_date", label: "shot_date", format: "unix_seconds" },
    categorical: [{ column: "category", label: "category" }],
    tag: [{ column: "tags", label: "tags", delimiter: "|" }],
    freeform: [{ column: "notes", label: "notes" }],
    scatter: [{ x_column: "umap_x", y_column: "umap_y", label: "UMAP" }],
  });
});

test("empty families are omitted; tag delimiter defaults to ','", () => {
  const draft = emptyDraft(["filename", "tags"]);
  draft.choice.tags = "tag";
  const roles = buildColumnRoles(draft);
  assert.deepEqual(roles, {
    filename: { column: "filename", label: "Filename" },
    tag: [{ column: "tags", label: "tags", delimiter: "," }],
  });
  assert.ok(!("datetime" in roles));
  assert.ok(!("scatter" in roles));
});

test("validateDraft: no filename / two datetimes / dangling scatter axis are named", () => {
  const noFilename = emptyDraft(["a", "b"]);
  noFilename.choice.a = "ignore";
  assert.match(validateDraft(noFilename) ?? "", /filename/);

  const twoDates = emptyDraft(["filename", "d1", "d2"]);
  twoDates.choice.d1 = "datetime";
  twoDates.choice.d2 = "datetime";
  assert.match(validateDraft(twoDates) ?? "", /one column can be the datetime/);

  const dangling = fullDraft();
  dangling.scatterPairs = [{ x: "umap_x", y: "", label: "" }];
  assert.match(validateDraft(dangling) ?? "", /both an X and a Y/);
  assert.throws(() => buildColumnRoles(dangling), /both an X and a Y/);

  assert.equal(validateDraft(fullDraft()), null);
});

test("availableLayoutTypes gates on assigned roles; grid is the unconditional floor", () => {
  assert.deepEqual(availableLayoutTypes(null), ["grid"]); // images-only
  assert.deepEqual(availableLayoutTypes(emptyDraft(HEADER)), ["grid"]);
  assert.deepEqual(availableLayoutTypes(fullDraft()), ["grid", "datetime", "categorical", "scatter"]);
});

// ---- T2-92 Seam 1: rolesDraftFromColumnRoles (the inverse) + producibleLayouts ----

test("rolesDraftFromColumnRoles round-trips through buildColumnRoles (the add-layout pre-fill)", () => {
  // Canonical roles — the shape ingest stores (labels normalized: filename -> "Filename",
  // every other family -> its column name). The add-layout wizard seeds its draft from
  // these; re-compiling the draft must reproduce them byte-for-byte (multi-categorical,
  // scatter pair, tag delimiter, freeform, datetime format all preserved).
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "Filename" },
    datetime: { column: "shot_date", label: "shot_date", format: "unix_seconds" },
    categorical: [
      { column: "kingdom", label: "kingdom" },
      { column: "phylum", label: "phylum" },
    ],
    tag: [{ column: "tags", label: "tags", delimiter: "|" }],
    freeform: [{ column: "notes", label: "notes" }],
    scatter: [{ x_column: "umap_x", y_column: "umap_y", label: "UMAP" }],
  };
  assert.deepEqual(buildColumnRoles(rolesDraftFromColumnRoles(roles)), roles);
});

test("human labels and the embedding role survive the draft round-trip verbatim (round-2 review)", () => {
  // Round-2 review finding: buildColumnRoles previously RESET every non-scatter
  // label to its normalized default ("Accession number" -> "Filename", "Object
  // type" -> "object_type") and dropped the reserved embedding role — the wizard
  // re-POSTs the whole column_roles, so one unrelated Add-Layout run destroyed the
  // display labels search hits and the metadata panel read. Labels + embedding now
  // carry opaquely, like the scatter knobs.
  const roles: ColumnRoles = {
    filename: { column: "objectnumber", label: "Accession number" },
    datetime: { column: "dating", label: "Date created", format: "iso8601" },
    categorical: [{ column: "object_type", label: "Object type" }],
    tag: [{ column: "materials", label: "Materials", delimiter: "|" }],
    freeform: [{ column: "notes", label: "Curator notes" }],
    embedding: { column: "clip_vec", label: "CLIP", dim: 512 },
  };
  assert.deepEqual(buildColumnRoles(rolesDraftFromColumnRoles(roles)), roles);
});

test("the geographic role survives the draft round-trip verbatim; absent stays absent (D-35 G2)", () => {
  // D-35 Seam G2: the wizard has no geographic-editing surface (that is Seam G3), so a
  // geographic role MUST ride OPAQUELY through the draft — a re-POST that dropped it would
  // silently strip a committed geographic layout's roles from the manifest (the same
  // lossy-projection class round 2 fixed for the scatter knobs + embedding). Declared
  // projection/overlap stay declared; an entry with neither keeps neither.
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "Filename" },
    geographic: [
      { lon_column: "lon", lat_column: "lat", label: "Location" },
      {
        lon_column: "home_lon",
        lat_column: "home_lat",
        label: "Home",
        projection: "mercator",
        overlap: "overdraw",
      },
    ],
  };
  assert.deepEqual(buildColumnRoles(rolesDraftFromColumnRoles(roles)), roles);

  // Absent stays ABSENT — a dataset with no geographic role must not gain an own
  // `geographic` key on the round-trip.
  const noGeo: ColumnRoles = { filename: { column: "filename", label: "Filename" } };
  const rebuilt = buildColumnRoles(rolesDraftFromColumnRoles(noGeo));
  assert.equal("geographic" in rebuilt, false);
});

// ---- D-35 Seam G3 (T2-125): the geographic family is now EDITED (geoPairs), not opaque ----

test("emptyDraft initializes geoPairs to [] (the Geographic section starts empty)", () => {
  assert.deepEqual(emptyDraft(HEADER).geoPairs, []);
});

test("buildColumnRoles compiles geoPairs into the geographic role; geo axes are omitted from freeform", () => {
  // A column used ONLY as a geo axis (lon/lat) carries the freeform default; like scatter
  // axes it is stored as its coordinate, so buildColumnRoles must NOT also emit it in
  // freeform (that would duplicate the column in ingest's enrichment SELECT).
  const draft = emptyDraft(["filename", "lon", "lat", "notes"]);
  draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Location" }];
  const roles = buildColumnRoles(draft);
  assert.deepEqual(roles.geographic, [{ lon_column: "lon", lat_column: "lat", label: "Location" }]);
  assert.deepEqual(roles.freeform, [{ column: "notes", label: "notes" }]);
});

test("the geographic projection/overlap knobs survive the draft round-trip; an untouched pair stays bare", () => {
  // Mirrors the scatter-knob discipline: a DECLARED projection/overlap round-trips verbatim,
  // and a pair that declares neither must NOT materialize an own `projection`/`overlap` key
  // (so the manifest options-echo emission — geographic always echoes, but only its real
  // projection — is preserved, and a re-POST never invents a value ingest would then bake).
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "Filename" },
    geographic: [
      { lon_column: "lon", lat_column: "lat", label: "Location" },
      { lon_column: "home_lon", lat_column: "home_lat", label: "Home", projection: "mercator", overlap: "overdraw" },
    ],
  };
  const draft = rolesDraftFromColumnRoles(roles);
  // Seeded into geoPairs (not opaque), declared knobs captured, absent knobs absent.
  assert.deepEqual(draft.geoPairs[0], { lon: "lon", lat: "lat", label: "Location" });
  assert.equal(draft.geoPairs[1].projection, "mercator");
  const bare = draft.geoPairs[0] as Record<string, unknown>;
  assert.ok(!("projection" in bare) && !("overlap" in bare), "an undeclared pair grew a knob key");
  // A geo-axis-only column carries choice "ignore" and is listed (so the dropdowns show it).
  assert.equal(draft.choice.lon, "ignore");
  assert.equal(draft.choice.home_lat, "ignore");
  assert.ok(draft.columns.includes("home_lon"));
  // Full round-trip identity.
  assert.deepEqual(buildColumnRoles(draft), roles);
});

test("patchGeoPair drops projection/overlap when an axis is repointed, keeps them otherwise", () => {
  const pair = { lon: "lon", lat: "lat", label: "Location", projection: "mercator" as const, overlap: "overdraw" as const };
  // Repointing lat: mercator's |lat| limit was validated against the ORIGINAL lat column —
  // it must not silently ride onto a different column.
  const repointed = patchGeoPair(pair, { lat: "other_lat" });
  assert.equal(repointed.lat, "other_lat");
  for (const knob of ["projection", "overlap"]) {
    assert.ok(!(knob in repointed), `repoint left a stale '${knob}' knob`);
  }
  // A label edit (or a no-op axis patch) keeps the knobs.
  assert.equal(patchGeoPair(pair, { label: "Where" }).projection, "mercator");
  assert.equal(patchGeoPair(pair, { lon: "lon" }).overlap, "overdraw");
});

test("availableLayoutTypes unlocks geographic when a geo pair is declared", () => {
  const draft = emptyDraft(["filename", "lon", "lat"]);
  assert.deepEqual(availableLayoutTypes(draft), ["grid"]);
  draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Location" }];
  assert.deepEqual(availableLayoutTypes(draft), ["grid", "geographic"]);
});

test("producibleLayouts: geographic single pair keeps the bare id; multi pairs slug by lon_column", () => {
  const single = emptyDraft(["file", "lon", "lat"]);
  single.geoPairs = [{ lon: "lon", lat: "lat", label: "Location" }];
  assert.deepEqual(producibleLayouts(single), [{ layout_id: "geographic", type: "geographic", label: "Location" }]);

  const multi = emptyDraft(["file", "lon", "lat", "hlon", "hlat"]);
  multi.geoPairs = [
    { lon: "lon", lat: "lat", label: "Sightings" },
    { lon: "hlon", lat: "hlat", label: "Homes" },
  ];
  assert.deepEqual(
    producibleLayouts(multi).map((l) => l.layout_id),
    ["geographic_lon", "geographic_hlon"],
  );
  // An incomplete pair is skipped (it fails validateDraft and never bakes).
  const dangling = emptyDraft(["file", "lon", "lat"]);
  dangling.geoPairs = [{ lon: "lon", lat: "", label: "" }];
  assert.deepEqual(producibleLayouts(dangling), []);
});

test("validateDraft names a dangling geographic pair", () => {
  const draft = emptyDraft(["file", "lon", "lat"]);
  draft.geoPairs = [{ lon: "lon", lat: "", label: "" }];
  assert.match(validateDraft(draft) ?? "", /both a longitude and a latitude/);
  assert.throws(() => buildColumnRoles(draft), /both a longitude and a latitude/);
});

// ---- states the PIPELINE rejects or bakes degenerately, caught inline instead ------------

test("a coordinate axis ALSO mapped as a storing role is rejected (the duplicate-column crash)", () => {
  // Both families project the column separately in ingest's enrichment SELECT, which dies as
  // a raw pyarrow `KeyError: Field "lon" exists 2 times in schema` AFTER the job is accepted
  // — so it has to be named here, where both uses can be pointed at.
  for (const role of ["categorical", "tag", "datetime"] as const) {
    const draft = emptyDraft(["file", "lon", "lat"]);
    draft.choice["lon"] = role;
    draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Where" }];
    assert.match(validateDraft(draft) ?? "", /"lon" is a geographic longitude and is also mapped as/, role);
    assert.throws(() => buildColumnRoles(draft), /also mapped as/);
  }
  // Same for a scatter axis (the pre-existing twin of the same defect).
  const scatter = emptyDraft(["file", "sx", "sy"]);
  scatter.choice["sx"] = "categorical";
  scatter.scatterPairs = [{ x: "sx", y: "sy", label: "S" }];
  assert.match(validateDraft(scatter) ?? "", /"sx" is a scatter X axis/);
});

test("freeform stays EXEMPT — it is the default every column carries (T2-94)", () => {
  // The regression guard for the rule above: emptyDraft marks every column freeform, so
  // rejecting freeform would make every pair unsubmittable.
  const draft = emptyDraft(["file", "lon", "lat"]);
  assert.equal(draft.choice["lon"], "freeform");
  draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Where" }];
  assert.equal(validateDraft(draft), null);
  // ...and the axis is still dropped from the emitted freeform family.
  assert.equal(buildColumnRoles(draft).freeform, undefined);
});

test("a pair whose two axes are the SAME column is rejected (a line, not a plot/map)", () => {
  // Ingest bakes this happily — both range guards pass — producing perfectly collinear
  // coordinates presented as a map.
  const geo = emptyDraft(["file", "lat"]);
  geo.geoPairs = [{ lon: "lat", lat: "lat", label: "Where" }];
  assert.match(validateDraft(geo) ?? "", /for both longitude and latitude/);

  const scatter = emptyDraft(["file", "sx"]);
  scatter.scatterPairs = [{ x: "sx", y: "sx", label: "S" }];
  assert.match(validateDraft(scatter) ?? "", /for both axes/);
});

test("identical pairs are rejected (they would bake byte-identical duplicate layouts)", () => {
  const geo = emptyDraft(["file", "lon", "lat", "lat2"]);
  geo.geoPairs = [
    { lon: "lon", lat: "lat", label: "A" },
    { lon: "lon", lat: "lat", label: "B" },
  ];
  assert.match(validateDraft(geo) ?? "", /Geographic pairs 1 and 2 use the same two columns/);

  // A pair sharing ONE column is legitimate (two maps off one longitude) — not rejected.
  geo.geoPairs[1] = { lon: "lon", lat: "lat2", label: "B" };
  assert.equal(validateDraft(geo), null);

  const scatter = emptyDraft(["file", "sx", "sy"]);
  scatter.scatterPairs = [
    { x: "sx", y: "sy", label: "A" },
    { x: "sx", y: "sy", label: "B" },
  ];
  assert.match(validateDraft(scatter) ?? "", /Scatter pairs 1 and 2 use the same two columns/);
});

test("the two knob combinations ingest rejects are refused before submit", () => {
  // The Axis-scale knob writes both axes together and locks the conflicting value, so these
  // guard drafts built outside it (an older stored roles blob, a hand-built draft).
  const mixed = emptyDraft(["file", "sx", "sy"]);
  mixed.scatterPairs = [{ x: "sx", y: "sy", label: "S", x_scale: "log", y_scale: "linear" }];
  assert.match(validateDraft(mixed) ?? "", /same scale on both axes/);

  // An absent y_scale means the default (linear) — still mixed.
  const halfDeclared = emptyDraft(["file", "sx", "sy"]);
  halfDeclared.scatterPairs = [{ x: "sx", y: "sy", label: "S", x_scale: "log" }];
  assert.match(validateDraft(halfDeclared) ?? "", /same scale on both axes/);

  const logPassThrough = emptyDraft(["file", "sx", "sy"]);
  logPassThrough.scatterPairs = [
    { x: "sx", y: "sy", label: "S", x_scale: "log", y_scale: "log", normalize: "none" },
  ];
  assert.match(validateDraft(logPassThrough) ?? "", /cannot combine a log scale with pass-through/);

  // Log on BOTH axes with the default fit is the supported case — still accepted.
  const ok = emptyDraft(["file", "sx", "sy"]);
  ok.scatterPairs = [{ x: "sx", y: "sy", label: "S", x_scale: "log", y_scale: "log" }];
  assert.equal(validateDraft(ok), null);
});

test("a fresh draft (no stored roles) still emits the normalized-label defaults", () => {
  const draft = emptyDraft(["filename", "kind"]);
  draft.choice["kind"] = "categorical";
  const roles = buildColumnRoles(draft);
  assert.equal(roles.filename.label, "Filename");
  assert.equal(roles.categorical?.[0].label, "kind");
});

test("patchScatterPair drops carried knobs when an axis is repointed, keeps them otherwise (round-2 review)", () => {
  const pair = {
    x: "width_cm", y: "height_cm", label: "Dimensions",
    x_scale: "log" as const, y_scale: "log" as const,
  };
  // Repointing X: the log was declared (and positivity-validated) for width_cm —
  // it must not silently ride onto a different column.
  const repointed = patchScatterPair(pair, { x: "year" });
  assert.equal(repointed.x, "year");
  for (const knob of ["x_scale", "y_scale", "normalize", "overlap"]) {
    assert.ok(!(knob in repointed), `repoint left a stale '${knob}' knob`);
  }
  // A label edit (or a no-op axis patch) keeps the knobs.
  assert.equal(patchScatterPair(pair, { label: "Dims (cm)" }).x_scale, "log");
  assert.equal(patchScatterPair(pair, { x: "width_cm" }).y_scale, "log");
});

test("the D-35 G1 scatter knobs survive the draft round-trip verbatim (declared stays declared, absent stays absent)", () => {
  // The 2026-07-20 review's wizard fix: the Add-Layout wizard re-POSTs the whole
  // column_roles built from this round-trip — before the fix a declared knob
  // (e.g. normalize:"none") was silently STRIPPED from the committed manifest by an
  // unrelated add-layouts run. Entry 0 carries knobs; entry 1 is knob-free and must
  // stay knob-free (no own `undefined` keys materialized).
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "Filename" },
    scatter: [
      {
        x_column: "width_cm", y_column: "height_cm", label: "Dimensions (cm)",
        x_scale: "log", y_scale: "log", normalize: "fit", overlap: "overdraw",
      },
      { x_column: "umap_x", y_column: "umap_y", label: "UMAP" },
    ],
  };
  const rebuilt = buildColumnRoles(rolesDraftFromColumnRoles(roles));
  assert.deepEqual(rebuilt, roles);
  // deepEqual treats {k: undefined} and {} as equal in some harnesses — pin the
  // absent-stays-absent half explicitly via own-key checks.
  const bare = rebuilt.scatter?.[1] as Record<string, unknown>;
  for (const knob of ["x_scale", "y_scale", "normalize", "overlap"]) {
    assert.ok(!(knob in bare), `knob-free entry grew an own '${knob}' key`);
  }
});

test("rolesDraftFromColumnRoles seeds the choice map, datetime format, delimiters, scatter pairs", () => {
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "Filename" },
    datetime: { column: "shot_date", label: "shot_date", format: "unix_millis" },
    categorical: [{ column: "kingdom", label: "kingdom" }],
    tag: [{ column: "tags", label: "tags", delimiter: ";" }],
    freeform: [{ column: "notes", label: "notes" }],
    scatter: [{ x_column: "umap_x", y_column: "umap_y", label: "UMAP" }],
  };
  const draft = rolesDraftFromColumnRoles(roles);
  assert.equal(draft.choice.filename, "filename");
  assert.equal(draft.choice.shot_date, "datetime");
  assert.equal(draft.choice.kingdom, "categorical");
  assert.equal(draft.choice.tags, "tag");
  assert.equal(draft.choice.notes, "freeform");
  // A column that is ONLY a scatter axis is "ignore" (it is emitted from scatterPairs,
  // never doubled into another family).
  assert.equal(draft.choice.umap_x, "ignore");
  assert.equal(draft.choice.umap_y, "ignore");
  assert.equal(draft.datetimeFormat, "unix_millis");
  assert.equal(draft.tagDelimiters.tags, ";");
  assert.deepEqual(draft.scatterPairs, [{ x: "umap_x", y: "umap_y", label: "UMAP" }]);
  // Every referenced column is listed (so the role table + scatter dropdowns can show it).
  assert.deepEqual(draft.columns, ["filename", "shot_date", "kingdom", "tags", "notes", "umap_x", "umap_y"]);
});

test("rolesDraftFromColumnRoles handles a minimal filename-only role map", () => {
  const roles: ColumnRoles = { filename: { column: "file", label: "Filename" } };
  const draft = rolesDraftFromColumnRoles(roles);
  assert.deepEqual(draft.columns, ["file"]);
  assert.equal(draft.choice.file, "filename");
  assert.deepEqual(draft.scatterPairs, []);
  assert.deepEqual(buildColumnRoles(draft), roles); // round-trips
});

test("producibleLayouts: grid excluded; datetime/single-categorical/single-scatter use bare ids", () => {
  const draft = emptyDraft(["file", "when", "kind", "sx", "sy"]);
  draft.choice.when = "datetime";
  draft.choice.kind = "categorical";
  draft.scatterPairs = [{ x: "sx", y: "sy", label: "S" }];
  assert.deepEqual(producibleLayouts(draft), [
    { layout_id: "datetime", type: "datetime", label: "when" },
    { layout_id: "categorical", type: "categorical", label: "kind" },
    { layout_id: "scatter", type: "scatter", label: "S" },
  ]);
  assert.ok(
    !producibleLayouts(draft).some((l) => l.layout_id === "grid"),
    "grid is the D-25 floor — never an addable layout",
  );
});

test("producibleLayouts: multi-entry families get {name}_{slug(column)} ids (matches the pipeline)", () => {
  const draft = emptyDraft(["file", "kingdom", "phylum", "ax", "ay", "bx", "by"]);
  draft.choice.kingdom = "categorical";
  draft.choice.phylum = "categorical";
  draft.scatterPairs = [
    { x: "ax", y: "ay", label: "UMAP" },
    { x: "bx", y: "by", label: "t-SNE" },
  ];
  // categorical distinguishing column = the column; scatter distinguishing column = x.
  assert.deepEqual(
    producibleLayouts(draft).map((l) => l.layout_id),
    ["categorical_kingdom", "categorical_phylum", "scatter_ax", "scatter_bx"],
  );
});

test("producibleLayouts: slug lowercases + collapses non [a-z0-9._-] runs (worker._slug twin)", () => {
  const draft = emptyDraft(["file", "Order (rank)", "Class Name"]);
  draft.choice["Order (rank)"] = "categorical";
  draft.choice["Class Name"] = "categorical";
  assert.deepEqual(
    producibleLayouts(draft).map((l) => l.layout_id),
    ["categorical_order-rank-", "categorical_class-name"],
  );
});

test("producibleLayouts: a slug collision appends -{i} so ids stay distinct (worker convention)", () => {
  const draft = emptyDraft(["file", "My-Col", "my col"]);
  draft.choice["My-Col"] = "categorical";
  draft.choice["my col"] = "categorical"; // both slug to "my-col"
  assert.deepEqual(
    producibleLayouts(draft).map((l) => l.layout_id),
    ["categorical_my-col", "categorical_my-col-1"],
  );
});

test("producibleLayouts: an incomplete scatter pair is skipped (it fails validateDraft, never bakes)", () => {
  const draft = emptyDraft(["file", "sx", "sy"]);
  draft.scatterPairs = [{ x: "sx", y: "", label: "" }];
  assert.deepEqual(producibleLayouts(draft), []);
});

// --- schema v2.8: `url` is an ORTHOGONAL display modifier, not a role -----------
//
// A link is a modifier layered on a shown scalar column (freeform/categorical), carried in
// draft.url separately from `choice`. The add-layout wizard REBUILDS column_roles wholesale,
// so the round trip must preserve BOTH the column's storing role and its link flag — and,
// unlike the earlier co-emit model, must NOT clobber a storing role or double-project it.

test("a freeform link column round-trips (freeform role kept, link flag preserved)", () => {
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "File" },
    freeform: [
      { column: "title", label: "Title" },
      { column: "source_url", label: "Source url" },
    ],
    url: ["source_url"],
  };
  const draft = rolesDraftFromColumnRoles(roles);
  // Orthogonal: the column keeps its freeform role AND carries the link flag (not "url").
  assert.equal(draft.choice.source_url, "freeform");
  assert.equal(draft.choice.title, "freeform");
  assert.deepEqual(draft.url, ["source_url"]);

  const rebuilt = buildColumnRoles(draft);
  assert.deepEqual(rebuilt.url, ["source_url"]);
  assert.ok(rebuilt.freeform?.some((e) => e.column === "source_url"));
  assert.ok(rebuilt.freeform?.some((e) => e.column === "title"));
});

test("a dataset with no url role emits no url key (pre-2.8 round-trips unchanged)", () => {
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "File" },
    freeform: [{ column: "title", label: "Title" }],
  };
  const rebuilt = buildColumnRoles(rolesDraftFromColumnRoles(roles));
  assert.equal("url" in rebuilt, false);
});

test("flagging a freeform column as a link emits freeform + url", () => {
  const draft = emptyDraft(["filename", "homepage"]);
  draft.choice.filename = "filename";
  draft.choice.homepage = "freeform";
  draft.url = ["homepage"];
  const roles = buildColumnRoles(draft);
  assert.deepEqual(roles.url, ["homepage"]);
  assert.ok(roles.freeform?.some((e) => e.column === "homepage"));
});

test("a CATEGORICAL column can be a link without being duplicated into freeform", () => {
  // The point of the orthogonal redesign: a link is a display modifier on ANY shown scalar
  // column, so a categorical column can render as a link and still drive its layout — and it
  // must NOT be co-emitted as freeform (which would double-project the column at ingest).
  const draft = emptyDraft(["filename", "museum"]);
  draft.choice.filename = "filename";
  draft.choice.museum = "categorical";
  draft.url = ["museum"];
  const roles = buildColumnRoles(draft);
  assert.deepEqual(roles.url, ["museum"]);
  assert.ok(roles.categorical?.some((e) => e.column === "museum"));
  assert.equal(roles.freeform?.some((e) => e.column === "museum") ?? false, false);
});

test("a categorical link column round-trips (categorical role kept, not clobbered)", () => {
  const roles: ColumnRoles = {
    filename: { column: "filename", label: "File" },
    categorical: [{ column: "museum", label: "Museum" }],
    url: ["museum"],
  };
  const draft = rolesDraftFromColumnRoles(roles);
  assert.equal(draft.choice.museum, "categorical"); // NOT clobbered to a link "role"
  assert.deepEqual(draft.url, ["museum"]);
  const rebuilt = buildColumnRoles(draft);
  assert.ok(rebuilt.categorical?.some((e) => e.column === "museum"));
  assert.deepEqual(rebuilt.url, ["museum"]);
});

test("a link on a non-displayed column is rejected by validateDraft", () => {
  const draft = emptyDraft(["filename", "shot_date"]);
  draft.choice.filename = "filename";
  draft.choice.shot_date = "datetime";
  draft.url = ["shot_date"];
  assert.match(validateDraft(draft) ?? "", /only Freeform or Categorical/);
});

test("a stale link naming a non-scalar column is dropped on load (no clobber, no throw)", () => {
  // Previously the url pass overwrote `choice`, so a url on the filename column bricked the
  // wizard (validateDraft then reported a missing filename). Now the flag is dropped on load.
  const roles: ColumnRoles = {
    filename: { column: "image_url", label: "Image" },
    url: ["image_url"],
  };
  const draft = rolesDraftFromColumnRoles(roles);
  assert.equal(draft.choice.image_url, "filename"); // role intact, not clobbered
  assert.deepEqual(draft.url, []); // stale link dropped
  const rebuilt = buildColumnRoles(draft); // must not throw
  assert.equal("url" in rebuilt, false);
});
