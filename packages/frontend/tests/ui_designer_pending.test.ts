// Seam L3 §3 — the designer's pending-change model (src/ui/designer/pending.ts).
//
// THE ORACLE IS THE PIPELINE, not this model's own code. Every expected set below was
// produced on 2026-09-23 by running the worker's OWN classifiers —
// `_changed_role_columns`, `_classify_layout_staleness`, `_classify_unproducible_layouts`
// (packages/pipeline/pipeline/worker.py) — in the worker image on the same manifests with
// the same role edits, and is transcribed here. So a pass means "the prediction agrees
// with the authority it mirrors", not "the model agrees with itself".
//
// RE-DERIVED for seam L7, because that seam moved the staleness rule from a WHOLE-COLUMN
// test to a PER-ENTRY one on both sides at once (manifest 2.10 / LAYOUT_DESIGNER D-xxix).
// Three rows moved, all in the same direction: `geographic` left `stale` for `second_pair`,
// `repair` and `split`, because a second pair landing on `lon`/`lat` leaves the geographic
// layout's OWN two tuples exactly where they were. The re-derivation was measured, not
// predicted — the worker printed the table above and it is transcribed below unchanged.
//
// Two deliberate differences from the worker's raw report, both from the brief (§2b.4):
// grid is never classified (it reads no columns; the worker lists a pre-2.9 grid as
// unknown), and `unknown` is only reported while some column's role has changed (the
// worker lists every pre-2.9 entry on every run).
//
// FIXTURES, and the production state each reproduces:
//   - tests/designer_fixture/layout_manifest_2.10.json — the golden full fixture refreshed
//     to manifest 2.10 by the real producer (`pixscope refresh-manifest --force`; the
//     README beside it has the command). Every collection baked or refreshed since seam L7
//     looks like it: each layout records `source_fingerprint`.
//   - tests/designer_fixture/layout_manifest_2.9.json — the same tree at 2.9: provenance
//     recorded, fingerprint NOT. Every collection baked between L3 and L7 looks like it,
//     and `derived.baked` must report every one of its layouts UNCHECKED, never fresh.
//   - tests/fixtures/golden_dataset_full_v2/layout_manifest.json — the committed 2.8
//     manifest, unchanged: every pre-2.9 collection in production looks exactly like it.
//   - `layoutInfos()` builds `LayoutInfo` exactly as api/routers/layouts.py `list_layouts`
//     does from each committed manifest entry with no job in flight: state "live", rebake
//     null, `source_columns` and `source_fingerprint` via `.get` (absent → null, never []
//     or {}), options passed through. `committed_at` is null because there is no container
//     to stat here.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LayoutInfo } from "../src/api-client/types.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import {
  addBake,
  bakedFor,
  barSummary,
  canonicalJson,
  changedRoleColumns,
  datetimeFormatFor,
  derivePending,
  discardPending,
  hasEdits,
  loadPending,
  outcomeFor,
  pendingStorageKey,
  removeBake,
  savePending,
  seedPending,
  sendableDraft,
  serializePending,
  withDraft,
} from "../src/ui/designer/pending.ts";
import type { PendingDerivation, PendingState } from "../src/ui/designer/pending.ts";

type FixtureManifest = LayoutManifest & {
  layouts: (LayoutManifest["layouts"][number] & {
    source_columns?: string[];
    source_fingerprint?: Record<string, unknown[][]>;
  })[];
};

function readFixture(url: URL): FixtureManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FixtureManifest;
}

const MANIFEST_210 = readFixture(new URL("./designer_fixture/layout_manifest_2.10.json", import.meta.url));
const MANIFEST_29 = readFixture(new URL("./designer_fixture/layout_manifest_2.9.json", import.meta.url));
const MANIFEST_28 = readFixture(
  new URL("../../../tests/fixtures/golden_dataset_full_v2/layout_manifest.json", import.meta.url),
);

function layoutInfos(manifest: FixtureManifest): LayoutInfo[] {
  return manifest.layouts.map((l) => ({
    layout_id: l.layout_id,
    label: l.label,
    type: l.type,
    state: "live",
    rebake: null,
    committed_at: null,
    source_columns: l.source_columns ?? null,
    source_fingerprint: l.source_fingerprint ?? null,
    options: (l as { options?: Record<string, unknown> }).options ?? null,
  }));
}

function seeded(manifest: typeof MANIFEST_210): PendingState {
  return seedPending(manifest.column_roles);
}

/** Apply an edit to a copy of the seed draft, as L4 would (a whole new draft). */
function edit(state: PendingState, change: (d: RolesDraft) => void): PendingState {
  const draft = JSON.parse(JSON.stringify(state.draft)) as RolesDraft;
  change(draft);
  return withDraft(state, draft);
}

// The brief's edits (§3 test 1). `lon`/`lat` stand in for the brief's "z" and "w": they
// are the only other numeric columns in the fixture's parquet that a user can map
// (`id`, `width`, `height` are the pipeline's own and `GET .../columns` never lists them).
const EDITS: Record<string, (d: RolesDraft) => void> = {
  // changing `captured`'s format
  format: (d) => {
    d.datetimeFormat = "unix_seconds";
  },
  // a label edit — a role label and a pair label
  label: (d) => {
    d.labels.group = "Department";
    d.scatterPairs[0].label = "Embedding";
  },
  // removing `bucket`'s role (to Display only)
  drop_bucket: (d) => {
    d.choice.bucket = "freeform";
  },
  // adding a second scatter pair
  second_pair: (d) => {
    d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
  },
  // replacing the one pair with (sx, z): still one entry, so still id `scatter`
  repair: (d) => {
    d.scatterPairs = [{ x: "sx", y: "lon", label: "Scatter" }];
  },
  // replacing it with TWO pairs that each keep one axis: (sx, z) and (w, sy)
  split: (d) => {
    d.scatterPairs = [
      { x: "sx", y: "lon", label: "" },
      { x: "lat", y: "sy", label: "" },
    ];
  },
};

/** The worker's answers on the 2.10 manifest (see the header). Transcribed from the run
 *  of 2026-09-23, which printed one line per edit; the 2.9 fixture returns the identical
 *  table, because every key here names exactly ONE role entry, and the classifier consults
 *  the recorded `source_fingerprint` only to break a tie between several
 *  (`_locate_entry_fingerprints`).
 *
 *  RE-DERIVED A SECOND TIME, unchanged, after the 2026-09-23 review of PR #379 made that
 *  lookup return candidates instead of one entry; A THIRD TIME after the operator's review
 *  of the same PR moved `own` to the bake record and the match from the per-column union to
 *  the after-role ENTRIES; and A FOURTH TIME after its round-2 review narrowed the report to
 *  what the edit NEWLY stales. All six rows, byte for byte, every time — every edit in this
 *  table starts from a collection whose committed roles ARE the roles it was baked with, so
 *  nothing in it was already stale. */
const PIPELINE_210: Record<string, { changed: string[]; stale: string[]; renamed: Record<string, string>; orphaned: string[] }> = {
  format: { changed: ["captured"], stale: ["datetime"], renamed: {}, orphaned: [] },
  label: { changed: [], stale: [], renamed: {}, orphaned: [] },
  drop_bucket: { changed: ["bucket"], stale: ["categorical_bucket"], renamed: { categorical_group: "categorical" }, orphaned: ["categorical_bucket"] },
  // `lon`/`lat` changed — they gained a scatter role — but the geographic layout's own
  // two tuples are untouched, so nothing it was baked from moved (v2.10 per-entry rule).
  second_pair: { changed: ["lat", "lon"], stale: [], renamed: { scatter: "scatter_sx" }, orphaned: [] },
  repair: { changed: ["lon", "sx", "sy"], stale: ["scatter"], renamed: {}, orphaned: [] },
  split: { changed: ["lat", "lon", "sx", "sy"], stale: ["scatter"], renamed: {}, orphaned: ["scatter"] },
};

function derived210(name: string) {
  return derivePending(edit(seeded(MANIFEST_210), EDITS[name]), layoutInfos(MANIFEST_210));
}

// --- 1. the six edits on the refreshed 2.10 manifest ---------------------------------

test("the untouched seed round-trips: nothing changed, nothing pending", () => {
  const d = derivePending(seeded(MANIFEST_210), layoutInfos(MANIFEST_210));
  assert.deepEqual(d.changedColumns, []);
  assert.deepEqual(d.outcomes, []);
  assert.equal(d.isPending, false);
  assert.equal(d.problem, null);
});

test("changing captured's format stales exactly `datetime`", () => {
  const d = derived210("format");
  assert.deepEqual(d.changedColumns, ["captured"]);
  assert.deepEqual(
    d.outcomes.map((o) => o.layout_id),
    ["datetime"],
    "exactly one layout is affected",
  );
  assert.deepEqual(outcomeFor(d, "datetime"), {
    layout_id: "datetime",
    label: "By date",
    stale: true,
    renamedTo: null,
    orphaned: false,
    unknown: false,
  });
});

test("a label edit stales nothing and changes no column (D-xx)", () => {
  const d = derived210("label");
  assert.deepEqual(d.changedColumns, [], "a label is not in the fingerprint");
  assert.deepEqual(d.outcomes, []);
  assert.equal(d.invalidating, 0);
  // It is an edit (kept across a reload) but a FREE one: the bar prices nothing.
  assert.equal(hasEdits(edit(seeded(MANIFEST_210), EDITS.label)), true);
  assert.equal(barSummary(d).empty, true);
});

test("removing bucket's role orphans categorical_bucket and renames categorical_group to categorical", () => {
  const d = derived210("drop_bucket");
  assert.deepEqual(d.changedColumns, ["bucket"]);
  const bucket = outcomeFor(d, "categorical_bucket");
  assert.equal(bucket?.orphaned, true, "nothing produces categorical_bucket any more");
  assert.equal(bucket?.renamedTo, null);
  assert.equal(bucket?.stale, true, "and it was built from the column that changed (the worker says so too)");
  const group = outcomeFor(d, "categorical_group");
  assert.equal(group?.renamedTo, "categorical", "the family dropped to one entry, so its id is bare again");
  assert.equal(group?.orphaned, false);
  assert.equal(group?.stale, false, "group's own role did not move");
});

test("adding a second scatter pair renames scatter to scatter_sx", () => {
  const d = derived210("second_pair");
  const scatter = outcomeFor(d, "scatter");
  assert.equal(scatter?.renamedTo, "scatter_sx");
  assert.equal(scatter?.stale, false, "sx and sy did not move");
  assert.equal(scatter?.orphaned, false);
});

test("re-pairing the one pair as (sx, z) is STALE only — the id `scatter` is still produced", () => {
  const d = derived210("repair");
  const scatter = outcomeFor(d, "scatter");
  assert.equal(scatter?.stale, true);
  assert.equal(scatter?.renamedTo, null);
  assert.equal(scatter?.orphaned, false);
});

test("splitting the pair into (sx, z) + (w, sy) is ORPHANED AND STALE, never a rename to scatter_sx (round-2 finding A)", () => {
  // The primary column `sx` still names a family member, `scatter_sx` — but that member
  // bakes sx against a DIFFERENT column. Only the whole tuple, in order, is a rename.
  const d = derived210("split");
  const scatter = outcomeFor(d, "scatter");
  assert.equal(scatter?.renamedTo, null, "a partial match is not a rename");
  assert.equal(scatter?.orphaned, true);
  assert.equal(scatter?.stale, true);
});

test("every one of the six edits matches the pipeline's own classification", () => {
  for (const [name, want] of Object.entries(PIPELINE_210)) {
    const d = derived210(name);
    assert.deepEqual(d.changedColumns, want.changed, `${name}: changed columns`);
    assert.deepEqual(d.outcomes.filter((o) => o.stale).map((o) => o.layout_id).sort(), [...want.stale].sort(), `${name}: stale`);
    assert.deepEqual(
      Object.fromEntries(d.outcomes.filter((o) => o.renamedTo !== null).map((o) => [o.layout_id, o.renamedTo])),
      want.renamed,
      `${name}: renamed`,
    );
    assert.deepEqual(d.outcomes.filter((o) => o.orphaned).map((o) => o.layout_id), want.orphaned, `${name}: orphaned`);
    assert.equal(d.outcomes.some((o) => o.unknown), false, `${name}: a 2.9 manifest has nothing unknown`);
  }
});

test("grid reads no columns and is none of the four, whatever changes", () => {
  for (const name of Object.keys(EDITS)) {
    assert.equal(outcomeFor(derived210(name), "grid"), undefined, name);
  }
});

// --- 2. the same edits on the committed 2.8 manifest ----------------------------------

test("on a 2.8 manifest every layout that reads columns is UNKNOWN, and none is stale", () => {
  const layouts = layoutInfos(MANIFEST_28);
  assert.ok(layouts.every((l) => l.source_columns === null), "the 2.8 fixture records no provenance");
  const reading = layouts.filter((l) => l.type !== "grid").map((l) => l.layout_id);
  for (const name of Object.keys(EDITS)) {
    if (name === "label") continue; // changes no column, so there is nothing to check
    const d = derivePending(edit(seeded(MANIFEST_28), EDITS[name]), layouts);
    assert.deepEqual(
      d.outcomes.filter((o) => o.unknown).map((o) => o.layout_id),
      reading,
      `${name}: every column-reading layout is unknown`,
    );
    assert.equal(d.outcomes.some((o) => o.stale), false, `${name}: unknown is never promoted to stale`);
    assert.equal(d.outcomes.some((o) => o.renamedTo !== null), false, `${name}: a rename needs provenance`);
  }
});

test("on a 2.8 manifest, nothing pending means NO outcome — not an 'unchecked' on every layout", () => {
  // `unknown` answers "can THIS change be checked against the layout?". With no change
  // there is no question, so a pre-2.9 collection opened and left alone — or given only a
  // free label edit — must show nothing. (The worker lists every pre-2.9 entry as unknown
  // on every run; the designer asks only while a column's role has changed.)
  const layouts = layoutInfos(MANIFEST_28);
  const untouched = derivePending(seeded(MANIFEST_28), layouts);
  assert.deepEqual(untouched.outcomes, [], "an untouched pre-2.9 collection");
  assert.equal(barSummary(untouched).empty, true);
  const labelOnly = derivePending(edit(seeded(MANIFEST_28), EDITS.label), layouts);
  assert.deepEqual(labelOnly.changedColumns, []);
  assert.deepEqual(labelOnly.outcomes, [], "a label-only edit on a pre-2.9 collection");
  assert.equal(barSummary(labelOnly).empty, true);
});

test("on a 2.8 manifest a vanished id is orphaned, as the pipeline reports it", () => {
  // PIPELINE (2.8, drop_bucket): orphaned [categorical_group, categorical_bucket].
  const d = derivePending(edit(seeded(MANIFEST_28), EDITS.drop_bucket), layoutInfos(MANIFEST_28));
  assert.deepEqual(d.outcomes.filter((o) => o.orphaned).map((o) => o.layout_id), ["categorical_group", "categorical_bucket"]);
});

test("the null-vs-[] distinction survives: [] is a positive 'reads nothing', null is unknown", () => {
  const layouts = layoutInfos(MANIFEST_210).map((l) =>
    l.layout_id === "datetime" ? { ...l, source_columns: [] as string[] } : l,
  );
  // Reproduces a v2.9 entry that recorded an EMPTY list (as grid does) on a reading type:
  // not a state the producer writes for datetime, which is exactly why it isolates the
  // rule — `[]` must read as "depends on nothing", not as "unknown".
  const d = derivePending(edit(seeded(MANIFEST_210), EDITS.format), layouts);
  assert.equal(outcomeFor(d, "datetime"), undefined);
});

// --- 2b. DURABLE staleness: `derived.baked` (seam L7 / manifest 2.10) -----------------
//
// The question `outcomes` cannot answer: NOT "what would this pending edit do?" but "does
// this layout's BAKE still match the roles as committed?". It is computed against
// `state.committed`, so it is true on a freshly loaded screen with nothing pending — which
// is the whole point of D-xxix, whose stale flag has to outlive the commit that caused it.

/** The committed roles with `captured` re-declared under another format — a collection
 *  where a roles-only commit has ALREADY landed and the datetime tiles were not re-baked.
 *  Seeding from these makes `state.committed` the post-commit map while the fixture's
 *  layouts still carry what the BAKE recorded. */
function committedAfterFormatChange(): PendingState {
  return seedPending({
    ...MANIFEST_210.column_roles!,
    datetime: { column: "captured", label: "Captured", format: "unix_seconds" },
  });
}

test("a committed format change leaves the datetime layout DURABLY stale, naming the column", () => {
  const d = derivePending(committedAfterFormatChange(), layoutInfos(MANIFEST_210));
  assert.equal(d.isPending, false, "nothing is pending — this is the reloaded screen");
  // ...and the PREDICTION says nothing, because this edit did not cause it (2026-09-24
  // round-2 review, N1). `outcomes[].stale` answers "what would this PENDING edit do?" —
  // a layout an EARLIER commit staled belongs to `derived.baked`, which is the field whose
  // job the durable verdict is. Between the two reviews this reported `["datetime"]`, and
  // the bar then blamed whatever the user was typing for damage done last week.
  assert.deepEqual(d.outcomes, []);
  assert.deepEqual(bakedFor(d, "datetime"), {
    layout_id: "datetime",
    checkable: true,
    staleColumns: ["captured"],
  });
  // Every other layout is checkable and fresh, grid included — `{}` is a positive "reads
  // no column", not a silence, so grid is never stale and never unchecked.
  assert.deepEqual(
    d.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id),
    ["datetime"],
  );
  assert.equal(d.baked.every((b) => b.checkable), true);
  assert.deepEqual(bakedFor(d, "grid"), { layout_id: "grid", checkable: true, staleColumns: [] });
});

test("on a 2.9 manifest every COLUMN-READING layout is UNCHECKED — but the grid is not", () => {
  // The production-shaped case for every collection baked between seams L3 and L7: it
  // records WHICH columns it read but not HOW. Absence is never a positive claim of
  // freshness — reading it as fresh would clear the flag on exactly the oldest bakes.
  //
  // GRID IS THE EXCEPTION, and not by special-casing (2026-09-23 review, finding 9): its
  // `source_columns` is `[]`, which the prediction and the pipeline both read as the
  // positive claim "reads nothing, so nothing can stale it". Reporting it as unchecked
  // made the durable view disagree with the other two about the one layout whose answer
  // is certain — on every collection in existence, until a refresh runs.
  const d = derivePending(
    seedPending({
      ...MANIFEST_29.column_roles!,
      datetime: { column: "captured", label: "Captured", format: "unix_seconds" },
    }),
    layoutInfos(MANIFEST_29),
  );
  assert.equal(
    layoutInfos(MANIFEST_29).every((l) => l.source_fingerprint == null),
    true,
    "fixture premise: the 2.9 tree records no fingerprint at all",
  );
  assert.equal(d.baked.length, 6);
  assert.deepEqual(
    d.baked.filter((b) => !b.checkable).map((b) => b.layout_id),
    ["datetime", "scatter", "categorical_group", "categorical_bucket", "geographic"],
  );
  assert.deepEqual(bakedFor(d, "grid"), { layout_id: "grid", checkable: true, staleColumns: [] });
  assert.equal(d.baked.every((b) => b.staleColumns.length === 0), true);
});

test("`{}` and an absent fingerprint are DIFFERENT: one is checkable, the other is not", () => {
  // `{}` is falsy in JS, so a truthiness test would collapse grid into the pre-2.10 case.
  const layouts = layoutInfos(MANIFEST_210).map((l) =>
    l.layout_id === "scatter" ? { ...l, source_fingerprint: null } : l,
  );
  const d = derivePending(seeded(MANIFEST_210), layouts);
  assert.equal(bakedFor(d, "grid")?.checkable, true, "{} is a recorded answer");
  assert.equal(bakedFor(d, "scatter")?.checkable, false, "absent is not an answer");
  assert.deepEqual(bakedFor(d, "scatter")?.staleColumns, [], "and it claims nothing either way");
});

test("a SECOND scatter pair sharing sx leaves the committed scatter layout NOT stale", () => {
  // The false-stale case the per-entry scope exists for. Committed `(sx, sy)`; the roles
  // now also declare `(sx, lon)`, so `sx`'s WHOLE role set gained a tuple — but the tuple
  // the scatter layout recorded is still there. Recording the union instead would stale a
  // layout whose pixels cannot have moved, and D-xxix would pre-tick its re-bake.
  const committed = seedPending({
    ...MANIFEST_210.column_roles!,
    scatter: [
      { x_column: "sx", y_column: "sy", label: "Scatter" },
      { x_column: "sx", y_column: "lon", label: "Second" },
    ],
  });
  const d = derivePending(committed, layoutInfos(MANIFEST_210));
  assert.deepEqual(bakedFor(d, "scatter"), { layout_id: "scatter", checkable: true, staleColumns: [] });
});

test("a TAG role added to a categorical column leaves that categorical layout NOT stale", () => {
  // The other false-stale case, and the one `_role_fingerprints`' own docstring
  // contemplates ("categorical AND tag, say"). `group`'s union gains `["tag","|"]`; the
  // treemap recorded `["categorical"]` and that is still declared.
  const committed = seedPending({
    ...MANIFEST_210.column_roles!,
    tag: [
      { column: "tags", label: "Tags", delimiter: "|" },
      { column: "group", label: "Group tags", delimiter: "|" },
    ],
  });
  const d = derivePending(committed, layoutInfos(MANIFEST_210));
  assert.deepEqual(bakedFor(d, "categorical_group"), {
    layout_id: "categorical_group",
    checkable: true,
    staleColumns: [],
  });
});

test("a layout whose own entry cannot be located in the committed roles is STALE, never fresh", () => {
  // The fail-safe, client-side. The recorded tuples are simply absent from the committed
  // map — a hand-edited manifest, or the roles moved on under it — so nothing can be
  // matched. The naive answer ("no tuple is missing, because none was found") would report
  // it fresh, which is the one answer that must never come out of silence.
  const committed = seedPending({
    ...MANIFEST_210.column_roles!,
    datetime: undefined,
    freeform: [
      { column: "caption", label: "Caption" },
      { column: "captured", label: "Captured" },
    ],
  } as NonNullable<typeof MANIFEST_210.column_roles>);
  const d = derivePending(committed, layoutInfos(MANIFEST_210));
  assert.deepEqual(bakedFor(d, "datetime")?.staleColumns, ["captured"]);
  assert.equal(bakedFor(d, "datetime")?.checkable, true, "it recorded a fingerprint; it just no longer matches");
});

test("the PREDICTION refuses to call a PRE-2.10 unlocatable layout fresh", () => {
  // The client half of `test_layout_lifecycle.py`'s
  // `test_set_roles_still_writes_when_the_committed_roles_no_longer_parse` fail-safe, on
  // the OUTCOMES path rather than the durable one — and now scoped to the population it
  // still applies to. A 2.10 layout never needs to be located at all: its own record says
  // what it was baked with (2026-09-23 review, finding 1). A PRE-2.10 one has nothing but
  // its provenance, and here the committed roles read `captured` as freeform, so there is
  // no entry to compare. The draft declares it a datetime again, so the layout is still
  // producible and the only question left is staleness. "Nothing was found, so nothing is
  // missing" would report it FRESH — the answer silence must never produce.
  const committed = seedPending({
    ...MANIFEST_210.column_roles!,
    datetime: undefined,
    freeform: [
      { column: "caption", label: "Caption" },
      { column: "captured", label: "Captured" },
    ],
  } as NonNullable<typeof MANIFEST_210.column_roles>);
  const state = edit(committed, (d) => {
    d.choice.captured = "datetime";
  });
  const preTwoTen = layoutInfos(MANIFEST_210).map((l) =>
    l.layout_id === "datetime" ? { ...l, source_fingerprint: null } : l,
  );
  const d = derivePending(state, preTwoTen);
  assert.deepEqual(d.changedColumns, ["captured"]);
  assert.equal(outcomeFor(d, "datetime")?.stale, true);
  assert.equal(outcomeFor(d, "datetime")?.orphaned, false, "the draft still produces it");
});

test("an UNRELATED edit is not blamed for staleness an EARLIER commit caused", () => {
  // 2026-09-24 round-2 review, N1. `own` is the bake record, so testing it against the
  // draft ALONE also catches whatever an earlier roles-only commit already staled. Here
  // `captured` was moved to `unix_seconds` and committed with no bake — datetime is
  // durably stale — and the user now edits only `group`. Reported against the draft alone
  // the bar reads "stales Categorical, Datetime", blaming this edit for last week's
  // damage; D-xxix would then re-queue that datetime re-bake on every later commit, even
  // after the operator removed it from the queue.
  const committed = seedPending({
    ...MANIFEST_210.column_roles!,
    datetime: { column: "captured", label: "Captured", format: "unix_seconds" },
  });
  const d = derivePending(
    edit(committed, (draft) => {
      draft.choice.group = "freeform";
    }),
    layoutInfos(MANIFEST_210),
  );

  assert.deepEqual(d.changedColumns, ["group"]);
  assert.deepEqual(
    d.outcomes.filter((o) => o.stale).map((o) => o.layout_id),
    ["categorical_group"],
    "only what THIS edit stales",
  );
  assert.equal(outcomeFor(d, "datetime"), undefined, "the pending edit leaves it alone");
  // ...and it is not lost: the DURABLE verdict still carries it, which is its job.
  assert.deepEqual(bakedFor(d, "datetime")?.staleColumns, ["captured"]);
  // The bar names only this edit's consequences. (`categorical_group` is also orphaned —
  // dropping the role is what makes its id unproducible — which is a separate outcome and
  // is unaffected by N1.)
  assert.equal(barSummary(d).invalidating?.consequence, "stales Group · 1 layout can't be re-baked");
});

test("an untouched collection whose roles the draft CANNOT hold reports nothing pending", () => {
  // 2026-09-24 round-2 review, N2. `rolesDraftFromColumnRoles` drops a column's second
  // role, so compiling an UNTOUCHED seed yields a map that differs from the committed one.
  // Gating only `tags` on `edited` left `changedColumns`, `invalidating`, `isPending` and
  // `outcomes` computed from that compiled seed: open a collection whose roles carry
  // datetime AND freeform on `captured`, touch nothing, and the bar read "1 invalidating
  // role change — stales Datetime".
  const roles = {
    ...MANIFEST_210.column_roles!,
    freeform: [
      { column: "caption", label: "Caption" },
      { column: "captured", label: "Captured" }, // ...as well as its datetime role
    ],
  };
  const state = seedPending(roles);
  assert.equal(state.draft?.choice.captured, "freeform", "premise: the seed lost the role");

  const d = derivePending(state, layoutInfos(MANIFEST_210));

  assert.deepEqual(d.changedColumns, [], "nothing was edited, so nothing changed");
  assert.deepEqual(d.outcomes, []);
  assert.equal(d.invalidating, 0);
  assert.equal(d.isPending, false);
  assert.equal(barSummary(d).empty, true);
  // `derived.roles` is the COMMITTED map, so posting it is a no-op rather than a silent
  // drop of the datetime role. The underlying data loss on a REAL edit is out of scope
  // here and filed: [[T2-the-roles-draft-cannot-hold-a-column-s-second]].
  assert.equal(d.roles?.datetime?.column, "captured");
});

test("a ROUND TRIP back to the baked declaration is FRESH, on the prediction too", () => {
  // The client half of the pipeline's
  // `test_set_roles_a_round_trip_back_to_the_baked_declaration_is_FRESH` (2026-09-23
  // review, finding 1). The committed roles say `unix_seconds` — a roles-only commit that
  // landed with no bake — and the draft puts `captured` back to the `iso8601` the tiles
  // were actually baked from. Taking `own` from the COMMITTED roles makes the draft look
  // like a change away from `unix_seconds` and reports STALE, while `derived.baked` on the
  // same draft-once-committed reports FRESH. Reading the bake record makes both correct.
  const committed = seedPending({
    ...MANIFEST_210.column_roles!,
    datetime: { column: "captured", label: "Captured", format: "unix_seconds" },
  });
  const state = edit(committed, (d) => {
    d.datetimeFormat = "iso8601";
  });
  const d = derivePending(state, layoutInfos(MANIFEST_210));
  assert.deepEqual(d.changedColumns, ["captured"], "the column really does move again");
  assert.equal(outcomeFor(d, "datetime")?.stale ?? false, false, "back to what was baked");
});

// --- 2b-i. two layouts over the SAME pair (2026-09-23 review of PR #379) --------------
//
// `(type, source_columns)` is NOT a unique key for a role entry: two entries of one family
// over the same columns in the same order are legal, and the pipeline's naming convention
// hands the second a `-1` suffix. Looked up one-deep, the second overwrote the first and
// BOTH layouts were judged against ONE entry's tuples — reporting a layout whose knob had
// moved as FRESH. The tie is broken by the layout's own bake record.
//
// The two recorded fingerprints are TRANSCRIBED from the producer, printed by
// `manifest.role_entry_fingerprints` in the lean test image on 2026-09-23 for exactly these
// two role entries (the pipeline half of this pin bakes them:
// `test_set_roles_tells_two_layouts_over_the_SAME_pair_apart`). `normalize` rather than
// `x_scale` for the same reason the pipeline test records: the golden columns include 0.0,
// which a log scale refuses.
const DUPLICATE_PAIR_ROLES = {
  filename: { column: "filename", label: "Filename" },
  scatter: [
    { x_column: "sx", y_column: "sy", label: "Fitted" },
    { x_column: "sx", y_column: "sy", label: "Raw", normalize: "none" as const },
  ],
};

const DUPLICATE_PAIR_LAYOUTS: LayoutInfo[] = [
  { layout_id: "grid", label: "Grid", type: "grid", state: "live", source_columns: [], source_fingerprint: {} },
  {
    layout_id: "scatter_sx",
    label: "Fitted",
    type: "scatter",
    state: "live",
    source_columns: ["sx", "sy"],
    source_fingerprint: {
      sx: [["scatter", "x", "sy", "linear", "linear", "fit", "overdraw"]],
      sy: [["scatter", "y", "sx", "linear", "linear", "fit", "overdraw"]],
    },
  },
  {
    layout_id: "scatter_sx-1",
    label: "Raw",
    type: "scatter",
    state: "live",
    source_columns: ["sx", "sy"],
    source_fingerprint: {
      sx: [["scatter", "x", "sy", "linear", "linear", "none", "overdraw"]],
      sy: [["scatter", "y", "sx", "linear", "linear", "none", "overdraw"]],
    },
  },
];

// HOW THE COLLISION IS REACHED ON THIS SIDE, measured 2026-09-23. `validateDraft` REFUSES
// two scatter pairs over the same two columns ("Scatter pairs 1 and 2 use the same two
// columns — they would bake two identical layouts"), and `derivePending` computes no
// outcome at all while the draft is invalid — so a duplicate pair can only be COMMITTED by
// the CLI, and the seeded draft opens invalid. The reachable state is therefore: a
// CLI-authored collection whose committed roles collide, opened, and the draft repaired by
// deleting one pair. The committed roles still collide, both committed layouts are still
// looked up against them, and that is where the wrong entry used to be returned.
const DELETE_SECOND_PAIR = (d: RolesDraft): void => {
  d.scatterPairs = [d.scatterPairs[0]];
};
const DELETE_FIRST_PAIR = (d: RolesDraft): void => {
  d.scatterPairs = [d.scatterPairs[1]];
};

test("a committed duplicate pair: deleting the RAW pair stales only the layout baked from it", () => {
  const d = derivePending(
    edit(seedPending(DUPLICATE_PAIR_ROLES as never), DELETE_SECOND_PAIR),
    DUPLICATE_PAIR_LAYOUTS,
  );
  assert.equal(d.problem, null, "the repaired draft is valid, so outcomes are computed");
  assert.equal(outcomeFor(d, "scatter_sx-1")?.stale, true, "its declaration is gone");
  assert.equal(outcomeFor(d, "scatter_sx")?.stale, false, "the fitted pair still reads sx/sy the same way");
});

test("...and deleting the FITTED pair stales only the other one — the false-FRESH the review found", () => {
  // The discriminating direction. Judged against the WRONG entry (the last one written to
  // the key), `scatter_sx`'s check ran on the `none` tuples, found them still declared, and
  // reported a layout whose own declaration had just been deleted as FRESH.
  const d = derivePending(
    edit(seedPending(DUPLICATE_PAIR_ROLES as never), DELETE_FIRST_PAIR),
    DUPLICATE_PAIR_LAYOUTS,
  );
  assert.equal(outcomeFor(d, "scatter_sx")?.stale, true);
  assert.equal(outcomeFor(d, "scatter_sx-1")?.stale, false);
});

test("the prediction and the DURABLE record agree on a duplicate pair, before and after the commit", () => {
  // The §2b(5) property on the case that broke it: what the prediction says the edit will
  // do must be what `derived.baked` says once those roles are committed with no re-bake.
  const pending = derivePending(
    edit(seedPending(DUPLICATE_PAIR_ROLES as never), DELETE_FIRST_PAIR),
    DUPLICATE_PAIR_LAYOUTS,
  );
  const predictedStale = pending.outcomes.filter((o) => o.stale).map((o) => o.layout_id);

  const after = derivePending(
    seedPending({
      ...DUPLICATE_PAIR_ROLES,
      scatter: [{ x_column: "sx", y_column: "sy", label: "Raw", normalize: "none" as const }],
    } as never),
    DUPLICATE_PAIR_LAYOUTS,
  );
  const durablyStale = after.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id);

  assert.deepEqual(predictedStale, ["scatter_sx"]);
  assert.deepEqual(durablyStale, ["scatter_sx"], "the same layout, from the bake record alone");
  assert.deepEqual(bakedFor(after, "scatter_sx")?.staleColumns, ["sx", "sy"]);
  assert.equal(after.baked.every((b) => b.checkable), true);
});

test("two INDISTINGUISHABLE entries over one pair: losing one stales BOTH", () => {
  // DUPLICATES ARE COUNTED, not just matched (2026-09-23 review, finding 2). Two layouts
  // recorded the same fingerprint, so they need TWO entries still declaring it; delete one
  // pair and only one survives, so one of the two layouts is stale — and nothing can say
  // which, because they recorded the same thing. Both are reported.
  //
  // Tested against the per-column UNION this read `[]`: the surviving entry kept the union
  // populated, so a layout whose own declaration had just been deleted came back FRESH.
  // Over-reporting is the safe direction here; picking one arbitrarily would let the
  // genuinely stale layout read fresh.
  const fit = {
    sx: [["scatter", "x", "sy", "linear", "linear", "fit", "overdraw"]],
    sy: [["scatter", "y", "sx", "linear", "linear", "fit", "overdraw"]],
  };
  const roles = {
    filename: { column: "filename", label: "Filename" },
    scatter: [
      { x_column: "sx", y_column: "sy", label: "One" },
      { x_column: "sx", y_column: "sy", label: "Two" },
    ],
  };
  const layouts: LayoutInfo[] = [
    { layout_id: "scatter_sx", label: "One", type: "scatter", state: "live", source_columns: ["sx", "sy"], source_fingerprint: fit },
    { layout_id: "scatter_sx-1", label: "Two", type: "scatter", state: "live", source_columns: ["sx", "sy"], source_fingerprint: fit },
  ];
  const d = derivePending(edit(seedPending(roles as never), DELETE_SECOND_PAIR), layouts);
  assert.deepEqual(d.outcomes.filter((o) => o.stale).map((o) => o.layout_id), ["scatter_sx", "scatter_sx-1"]);
});

test("a PRE-2.10 layout sharing a pair with another entry cannot be told apart, so it is STALE", () => {
  // Rule 3 needs a bake record; a pre-2.10 entry has none. Unlocatable ⇒ stale, never
  // fresh — the same fail-safe one level down. `scatter_sx` here would otherwise be fresh
  // (the test two above), so the flip is the missing record and nothing else.
  const layouts: LayoutInfo[] = DUPLICATE_PAIR_LAYOUTS.map((l) =>
    l.layout_id === "scatter_sx" ? { ...l, source_fingerprint: null } : l,
  );
  const d = derivePending(
    edit(seedPending(DUPLICATE_PAIR_ROLES as never), DELETE_SECOND_PAIR),
    layouts,
  );
  assert.equal(outcomeFor(d, "scatter_sx")?.stale, true, "no record, two candidates ⇒ stale");
  assert.equal(outcomeFor(d, "scatter_sx-1")?.stale, true, "its own declaration is gone");
});

test("the THREE agree on one edit: the prediction, the durable record, and the pipeline", () => {
  // `second_pair` — add a scatter pair over the fixture's own geographic columns. It is
  // PIPELINE_210's row (measured in the worker image), so the pipeline's answer is the
  // table itself; the prediction and the durable record are asserted against it here.
  assert.deepEqual(PIPELINE_210.second_pair.stale, [], "the pipeline: geographic is NOT stale");
  const predicted = derived210("second_pair");
  assert.equal(outcomeFor(predicted, "geographic")?.stale ?? false, false, "the prediction agrees");
  // ...and once those roles are COMMITTED, with no re-bake, the durable record agrees too.
  const afterCommit = derivePending(
    seedPending({
      ...MANIFEST_210.column_roles!,
      scatter: [
        { x_column: "sx", y_column: "sy", label: "Scatter" },
        { x_column: "lon", y_column: "lat", label: "lon / lat" },
      ],
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(bakedFor(afterCommit, "geographic"), {
    layout_id: "geographic",
    checkable: true,
    staleColumns: [],
  });
});

// --- 2c. the tag index's two warnings: `derived.tags` ---------------------------------

test("a newly declared tag role is DECLARED, NOT SERVED until a bake", () => {
  const d = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.choice.caption = "tag";
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(d.tags.unservedColumns, ["caption"]);
  assert.equal(d.tags.removesLastTagRole, false);
});

test("a tag role whose DELIMITER moved is also unserved — the index was split on the old one", () => {
  // The case the worker's `_classify_tag_sidecar` misses: `tags` IS a column of the
  // committed sidecar, so it reports nothing, while every value in it was split on `|`
  // ([[T2-changing-a-tag-delimiter-reports-nothing]]).
  const d = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.tagDelimiters.tags = ",";
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(d.tags.unservedColumns, ["tags"]);
  assert.equal(d.tags.removesLastTagRole, false);
});

test("an UNEDITED draft warns about nothing, even when the seed round trip loses a role", () => {
  // `rolesDraftFromColumnRoles` is lossy: `choice` is last-write-wins and `freeform` is
  // assigned AFTER `tag`, so a CLI-authored column carrying BOTH seeds a draft with no tag
  // role at all. Ungated, such a collection opened and left alone warned "tag filtering
  // goes away when you commit" — about an edit nobody made (2026-09-23 review, finding 5).
  // `problem` is already gated on `edited` for exactly this reason.
  const roles = {
    filename: { column: "filename", label: "F" },
    tag: [{ column: "kw", label: "Keywords", delimiter: ";" }],
    freeform: [{ column: "kw", label: "Keywords" }],
  };
  const state = seedPending(roles as never);
  assert.equal(state.draft?.choice.kw, "freeform", "premise: the round trip drops the tag role");

  const untouched = derivePending(state, []);
  assert.deepEqual(untouched.tags, { unservedColumns: [], removesLastTagRole: false });

  // ...and a REAL edit still reports it, so the gate is not a blanket mute.
  const edited = derivePending(
    edit(state, (d) => {
      d.labels.filename = "The file";
    }),
    [],
  );
  assert.equal(edited.tags.removesLastTagRole, true);
});

test("a MALFORMED recorded value never throws, and never reads fresh", () => {
  // The API types `source_fingerprint` as a bare `dict` and passes it through WITHOUT
  // re-validating it, deliberately — an unexpected shape must not 500 the layout list. So
  // a hand-edited manifest reaches the client, where `.map`/`.some` on a string threw a
  // TypeError inside `derivePending` and the designer did not render at all (2026-09-23
  // review, finding 6). Guarded, as Python's `_recorded_fingerprint` is.
  const malformed = layoutInfos(MANIFEST_210).map((l) =>
    l.layout_id === "datetime"
      ? { ...l, source_fingerprint: { captured: "datetime" } as unknown as Record<string, unknown[][]> }
      : l,
  );
  const d = derivePending(seeded(MANIFEST_210), malformed);
  // Dropping the malformed column leaves an EMPTY record, which matches no declaration, so
  // the layout is stale rather than fresh — never the answer silence produces.
  assert.equal(bakedFor(d, "datetime")?.checkable, true);
  assert.deepEqual(bakedFor(d, "datetime")?.staleColumns, ["captured"]);
  // The DURABLE verdict carries it; the prediction does not, because nothing was edited.
  assert.deepEqual(d.outcomes, []);
  // ...and every other layout is judged normally: one bad entry does not take the screen out.
  assert.deepEqual(bakedFor(d, "scatter"), { layout_id: "scatter", checkable: true, staleColumns: [] });
});

test("a record with an EMPTY tuple list reads stale, not fresh", () => {
  // `{"captured": []}` — a column recorded with no tuples. Tested against the per-column
  // union this read as fresh (`[].some(...)` is false): a record that says nothing was
  // taken as a record that says everything is fine. Matched against the roles' ENTRIES it
  // equals no declaration, so it is stale — the answer absence must always give. The
  // schema's `minItems: 1` keeps a pipeline-written tree out of this shape, but the API
  // passes the block through without re-validating it.
  const emptied = layoutInfos(MANIFEST_210).map((l) =>
    l.layout_id === "datetime" ? { ...l, source_fingerprint: { captured: [] } } : l,
  );
  const d = derivePending(seeded(MANIFEST_210), emptied);
  assert.equal(bakedFor(d, "datetime")?.checkable, true);
  assert.deepEqual(bakedFor(d, "datetime")?.staleColumns, ["captured"]);
  assert.deepEqual(d.outcomes, [], "durable, so the prediction does not claim it");
});

test("a GRID is never in the entry-match population, whatever its record says", () => {
  // 2026-09-24 round-2 review, N5. A `[]` provenance names no role entry — nothing is ever
  // keyed `("grid", [])` — so a grid that reaches the entry match has no candidate, is
  // counted stale, and then reports whatever columns its record happens to name. It read
  // fresh only because the `staleColumns` fallback came out empty on a WELL-FORMED record;
  // a hand-edited one exposes it immediately.
  const layouts = layoutInfos(MANIFEST_210).map((l) =>
    l.layout_id === "grid"
      ? { ...l, source_fingerprint: { x: [["categorical"]] } as Record<string, unknown[][]> }
      : l,
  );
  const d = derivePending(seeded(MANIFEST_210), layouts);
  assert.deepEqual(bakedFor(d, "grid"), { layout_id: "grid", checkable: true, staleColumns: [] });
});

test("the durable verdict is computed ONCE per (layouts, committed roles)", () => {
  // 2026-09-24 round-2 review, N6. `derivePending` runs on every keystroke; `baked` depends
  // only on the layout list and the COMMITTED roles, neither of which a keystroke touches.
  // Memoizing only the candidate map left the per-column union and every layout's verdict
  // running each time — most of the cost. Identity is the observable: the same inputs must
  // hand back the same array.
  const layouts = layoutInfos(MANIFEST_210);
  const state = seeded(MANIFEST_210);
  const first = derivePending(state, layouts);
  const second = derivePending(edit(state, (d) => { d.datetimeFormat = "unix_seconds"; }), layouts);
  assert.equal(second.baked, first.baked, "an edit to the DRAFT cannot change it");
  // ...and a different committed map does not reuse the cache.
  const other = derivePending(
    seedPending({ ...MANIFEST_210.column_roles!, datetime: { column: "captured", label: "C", format: "unix_millis" } }),
    layouts,
  );
  assert.notEqual(other.baked, first.baked);
  assert.deepEqual(other.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id), ["datetime"]);
});

test("removing the last tag role is reported, and an untouched collection reports neither", () => {
  const removed = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.choice.tags = "freeform";
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.equal(removed.tags.removesLastTagRole, true);
  assert.deepEqual(removed.tags.unservedColumns, []);
  const untouched = derivePending(seeded(MANIFEST_210), layoutInfos(MANIFEST_210));
  assert.deepEqual(untouched.tags, { unservedColumns: [], removesLastTagRole: false });
});

// --- 3. the bar -------------------------------------------------------------------

test("the bar says each outcome in RoleConsequences' words", () => {
  const stale = barSummary(derived210("format"));
  assert.equal(stale.invalidating?.title, "1 invalidating role change");
  assert.deepEqual(stale.invalidating?.columns, ["captured"]);
  assert.equal(stale.invalidating?.consequence, "stales By date");

  // renamed ALONE → "nothing stale". Every rename in the 2.9 fixture's edits comes with
  // a stale sibling, so this reproduces the RoleConsequences board's own case: a
  // collection baked at 2.9 with ONE categorical column (id bare `categorical`, provenance
  // ["group"]), whose owner makes a second, unread column (`caption`) categorical.
  const oneCat = { ...MANIFEST_210.column_roles!, categorical: [{ column: "group", label: "Group" }] };
  const oneCatLayouts: LayoutInfo[] = [
    { layout_id: "grid", label: "Grid", type: "grid", state: "live", source_columns: [] },
    { layout_id: "categorical", label: "By group", type: "categorical", state: "live", source_columns: ["group"] },
  ];
  const renamed = barSummary(
    derivePending(edit(seedPending(oneCat), (d) => { d.choice.caption = "categorical"; }), oneCatLayouts),
  );
  assert.deepEqual(renamed.invalidating?.columns, ["caption"]);
  assert.equal(renamed.invalidating?.consequence, "nothing stale");

  const orphanedAndStale = barSummary(derived210("split"));
  // TWO role changes, not four columns: the one pair was changed and a second arrived
  // (the bar counts the unit the owner edits — section 3b).
  assert.equal(orphanedAndStale.invalidating?.title, "2 invalidating role changes");
  assert.deepEqual(orphanedAndStale.invalidating?.columns, ["lat", "lon", "sx", "sy"]);
  // FOUR columns changed but only ONE layout is stale, and the bar says exactly that:
  // `lon`/`lat` gained a scatter role, which leaves `Location`'s own tuples untouched
  // (the v2.10 per-entry rule — the worker agrees, see PIPELINE_210.split).
  assert.equal(orphanedAndStale.invalidating?.consequence, "stales Scatter · 1 layout can't be re-baked");

  const unknown = barSummary(derivePending(edit(seeded(MANIFEST_28), EDITS.format), layoutInfos(MANIFEST_28)));
  assert.equal(unknown.invalidating?.consequence, "5 layouts unchecked");
});

test("the bar shows NO count for a pending free edit, and says nothing is pending", () => {
  const bar = barSummary(derived210("label"));
  assert.equal(bar.empty, true);
  assert.equal(bar.invalidating, null);
  assert.equal(bar.bakes, null);
});

test("the bar counts bakes separately, as one run, and never more than two counts", () => {
  let state = edit(seeded(MANIFEST_210), EDITS.format);
  state = addBake(state, { kind: "rebake", layout_id: "datetime" });
  state = addBake(state, { kind: "rebake", layout_id: "datetime" }); // queued twice = once
  const bar = barSummary(derivePending(state, layoutInfos(MANIFEST_210)));
  assert.equal(bar.invalidating?.count, 1);
  assert.equal(bar.bakes?.title, "1 bake to run");
  assert.equal(bar.bakes?.consequence, "one run");
});

// --- 3b. the bar counts the unit the owner edited, not the column ----------------------
//
// Operator, 2026-09-28: "Count it once." Counted by column, one edit to a pair read as two,
// because both of its columns read the pair's settings. Every expected count below is worked
// by hand from the rule (pending.ts `roleChangeCount`; CONTRACT §4, "What the bar's count
// counts"): one per pair entry added, removed or changed, plus one per other changed column.
// `changedColumns` is asserted beside each count, because it does not change: the bar still
// lists every column, and the Data view still counts them.

/** The 2.10 collection with two more Display-only (freeform) columns — the role every
 *  uploaded column starts with (roles.ts `emptyDraft`), so the usual state of a numeric
 *  column before anyone pairs it. */
const DISPLAY_ONLY = {
  ...MANIFEST_210.column_roles!,
  freeform: [
    ...(MANIFEST_210.column_roles!.freeform ?? []),
    { column: "width_cm", label: "Width (cm)" },
    { column: "height_cm", label: "Height (cm)" },
  ],
};

test("count once 1: a baked map's projection edit is ONE role change, and the bar still lists lat, lon", () => {
  const d = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.geoPairs[0].projection = "mercator";
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(d.changedColumns, ["lat", "lon"], "both columns read the pair's settings");
  assert.equal(d.invalidating, 1);
  const bar = barSummary(d);
  assert.equal(bar.invalidating?.title, "1 invalidating role change");
  assert.deepEqual(bar.invalidating?.columns, ["lat", "lon"]);
  assert.equal(bar.invalidating?.consequence, "stales Location");
});

test("count once 2: adding a scatter pair over two columns is ONE role change — axis-only columns, or two Display-only ones", () => {
  // The Layouts view's two writes (layoutsCards.ts `queuePair`): the pair into the draft,
  // the bake into the queue. The columns keep their choice.
  const add = (state: PendingState, x: string, y: string): PendingState =>
    addBake(
      edit(state, (draft) => {
        draft.scatterPairs.push({ x, y, label: "" });
      }),
      { kind: "new", type: "scatter", source_columns: [x, y] },
    );

  // `lon`/`lat` read nothing of their own (they are the map's axes, Ignore in the draft).
  const axisOnly = derivePending(add(seeded(MANIFEST_210), "lon", "lat"), layoutInfos(MANIFEST_210));
  assert.deepEqual(axisOnly.changedColumns, ["lat", "lon"]);
  assert.equal(axisOnly.invalidating, 1);
  assert.equal(barSummary(axisOnly).invalidating?.title, "1 invalidating role change");
  assert.equal(axisOnly.bakeCount, 1, "the bake is the bar's other count");

  // Display-only columns LOSE their freeform role as they join the pair (`buildColumnRoles`
  // drops freeform from every axis), so each column's own role changes too — as part of
  // the one pair edit, not as two more.
  const displayOnly = derivePending(add(seedPending(DISPLAY_ONLY), "width_cm", "height_cm"), layoutInfos(MANIFEST_210));
  assert.deepEqual(displayOnly.roles?.freeform?.map((f) => f.column), ["caption"], "premise: the compile dropped both");
  assert.deepEqual(displayOnly.changedColumns, ["height_cm", "width_cm"]);
  assert.equal(displayOnly.invalidating, 1);
  assert.equal(barSummary(displayOnly).invalidating?.title, "1 invalidating role change");
});

test("count once 3: two independent edits are TWO — a column's role, and one pair's setting", () => {
  const d = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.choice.bucket = "freeform";
      draft.geoPairs[0].projection = "mercator";
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(d.changedColumns, ["bucket", "lat", "lon"]);
  assert.equal(d.invalidating, 2);
  assert.equal(barSummary(d).invalidating?.title, "2 invalidating role changes");
});

test("count once 4: a column whose own role changed AS WELL AS its pair — the rule's two edge cases", () => {
  // (a) Its own role went on its own: `bucket` made Ignore (it was categorical), then paired
  // with `lat`. The categorical role is an edit of its own — it orphans Bucket whatever the
  // pair does — so the pair counts once and `bucket` once more: 2. (`lat` gained a scatter
  // reading and reads nothing of its own: it is the pair's.)
  const ownAndPair = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.choice.bucket = "ignore";
      draft.scatterPairs.push({ x: "bucket", y: "lat", label: "" });
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(ownAndPair.changedColumns, ["bucket", "lat"]);
  assert.equal(outcomeFor(ownAndPair, "categorical_bucket")?.orphaned, true, "premise: the categorical role's own consequence");
  assert.equal(ownAndPair.invalidating, 2);

  // ...and when the only change to its own role is the freeform the pair drops, it is the
  // pair's alone: the same edit over Display-only `width_cm` reads 1 (count once 2).
  const freeformOnly = derivePending(
    edit(seedPending(DISPLAY_ONLY), (draft) => {
      draft.scatterPairs.push({ x: "width_cm", y: "lat", label: "" });
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.deepEqual(freeformOnly.changedColumns, ["lat", "width_cm"]);
  assert.equal(freeformOnly.invalidating, 1);

  // (b) A column in TWO changed pairs counts in each and never on its own: `sx` is in
  // Scatter, whose scale moved, and in a new (sx, lon) pair — 2, not 3 columns, not 1.
  const twoPairs = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.scatterPairs[0] = { ...draft.scatterPairs[0], x_scale: "log", y_scale: "log" };
      draft.scatterPairs.push({ x: "sx", y: "lon", label: "" });
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.equal(twoPairs.problem, null, "premise: a valid draft");
  assert.deepEqual(twoPairs.changedColumns, ["lon", "sx", "sy"]);
  assert.equal(twoPairs.invalidating, 2);
});

test("count once 5: an edit put back is NOTHING — the count returns to 0 and the bar says Nothing pending", () => {
  const layouts = layoutInfos(MANIFEST_210);
  const mercator = edit(seeded(MANIFEST_210), (draft) => {
    draft.geoPairs[0].projection = "mercator";
  });
  assert.equal(derivePending(mercator, layouts).invalidating, 1, "premise: the edit counts");
  // Put back the way the baked card does it (the committed form: absent), and as an EXPLICIT
  // default, which declares the same reading in another form — an edited draft, still
  // nothing to commit.
  for (const [how, projection] of [["absent", undefined], ["explicit", "equirectangular"]] as const) {
    const back = edit(mercator, (draft) => {
      if (projection === undefined) delete draft.geoPairs[0].projection;
      else draft.geoPairs[0].projection = projection;
    });
    const d = derivePending(back, layouts);
    assert.deepEqual(d.changedColumns, [], how);
    assert.equal(d.invalidating, 0, how);
    assert.equal(d.isPending, false, how);
    assert.equal(barSummary(d).empty, true, `${how}: the bar says Nothing pending`);
  }
});

// A committed map may declare one pair twice (`pixscope set-roles` accepts it), and a stored
// draft may hold only one copy (CONTRACT §8, the baked card): one entry left, but every column
// still reads the same. The two copies are ONE reading, which is what the count compares
// (review of #400, finding 3).
const MAP_TWICE = {
  ...MANIFEST_210.column_roles!,
  geographic: [...MANIFEST_210.column_roles!.geographic!, { ...MANIFEST_210.column_roles!.geographic![0], label: "Again" }],
};

/** `MAP_TWICE` with the draft holding one copy, plus `change`. */
function oneCopyLeft(change: (d: RolesDraft) => void): PendingDerivation {
  return derivePending(
    edit(seedPending(MAP_TWICE), (draft) => {
      draft.geoPairs = [draft.geoPairs[0]];
      change(draft);
    }),
    layoutInfos(MANIFEST_210),
  );
}

test("count once 6: a pair declared twice losing one copy moves no column's reading, so it counts nothing", () => {
  // The count REGROUPS `changedColumns` and never adds to them — by the rule, not a guard.
  const d = oneCopyLeft(() => {});
  assert.equal(d.problem, null, "premise: one copy is a valid draft");
  assert.deepEqual(d.changedColumns, []);
  assert.equal(d.invalidating, 0);
  assert.equal(d.isPending, false);
});

test("count once 6b: beside a copy that left, a real edit counts ONCE — the copy is not a second change", () => {
  // Compared as a multiset, the copy that left counted as a pair edit as soon as anything
  // else changed: 2 for each of these, with the bar listing no column for the second.
  const projection = oneCopyLeft((draft) => {
    draft.geoPairs[0].projection = "mercator";
  });
  assert.deepEqual(projection.changedColumns, ["lat", "lon"]);
  assert.equal(projection.invalidating, 1, "one projection edit, as without the duplicate");

  const bucket = oneCopyLeft((draft) => {
    draft.choice.bucket = "freeform";
  });
  assert.deepEqual(bucket.changedColumns, ["bucket"], "the map's columns read as they did");
  assert.equal(bucket.invalidating, 1, "bucket's role, and nothing for the map");
});

test("count once 7: an UNTOUCHED collection whose committed roles the form refuses reads Nothing pending", () => {
  // Operator's review of #400, findings 1–2. Legal to the pipeline, refused by
  // `validateDraft`, so with nothing edited there is no compiled map (`roles` is null) and
  // nothing to compare the committed roles with. Compared with null anyway, every committed
  // pair counted as LEFT: "1 invalidating role change", no column, on a screen nobody touched.
  const selfPair = { ...MANIFEST_210.column_roles!, scatter: [{ x_column: "sx", y_column: "sx", label: "Self" }] };
  for (const [name, roles] of [["a scatter against itself", selfPair], ["a pair declared twice", MAP_TWICE]] as const) {
    const d = derivePending(seedPending(roles), layoutInfos(MANIFEST_210));
    assert.equal(d.roles, null, `${name}: premise — the form refuses the seed, so nothing compiles`);
    assert.equal(d.problem, null, `${name}: and nothing was edited, so there is no problem to show`);
    assert.equal(d.invalidating, 0, name);
    assert.equal(d.isPending, false, name);
    assert.equal(barSummary(d).empty, true, `${name}: the bar says Nothing pending`);
  }
});

test("count once 9: replacing a pair's columns with another pair's is ONE change, a repoint — even an unrelated pair", () => {
  // Operator's review of #400, finding 6: CONTRACT said "added, removed, or changed", which
  // read as 2 for a removal plus an addition. The count matches them per family as one entry
  // repointed, which is what the outcome says too: the lone entry's layout keeps its id and
  // goes stale. (No designer control makes this swap; a baked card's columns are read-only.)
  const unrelated = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.geoPairs = [{ lon: "sx", lat: "sy", label: "" }];
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.equal(unrelated.problem, null, "premise: a valid draft");
  assert.deepEqual(unrelated.changedColumns, ["lat", "lon", "sx", "sy"]);
  assert.deepEqual(outcomeFor(unrelated, "geographic"), {
    layout_id: "geographic",
    label: "Location",
    stale: true,
    renamedTo: null,
    orphaned: false,
    unknown: false,
  });
  assert.equal(unrelated.invalidating, 1, "Location repointed: one change");
  // ...and sharing one column (the worker oracle's `repair`) is the same one change.
  assert.equal(derived210("repair").invalidating, 1);
});

test("count once 8: a draft the form REFUSES counts nothing beside its problem", () => {
  // Operator's review of #400, finding 3: `lat` made Categorical while it is Location's
  // latitude. The problem shows; before the fix the bar ALSO read "2 invalidating role
  // changes" with no column — Location and Scatter counted as left.
  const d = derivePending(
    edit(seeded(MANIFEST_210), (draft) => {
      draft.choice.lat = "categorical";
    }),
    layoutInfos(MANIFEST_210),
  );
  assert.match(d.problem ?? "", /"lat" is a geographic latitude/, "premise: the form refuses it");
  assert.equal(d.roles, null);
  assert.equal(d.invalidating, 0);
  assert.equal(d.isPending, true, "pending because of the problem, which the bar shows");
  const bar = barSummary(d);
  assert.equal(bar.invalidating, null, "and no count beside it");
  assert.notEqual(bar.problem, null);
});

// --- the model's API -----------------------------------------------------------------

test("a `new` bake resolves to the id its source columns bake under NOW, and follows a rename", () => {
  // Queue a new scatter on (lon, lat) with only the committed pair beside it: two pairs,
  // so the new one is scatter_lon — and the committed `scatter` is renamed.
  let state = edit(seeded(MANIFEST_210), EDITS.second_pair);
  state = addBake(state, { kind: "new", type: "scatter", source_columns: ["lon", "lat"] });
  const d = derivePending(state, layoutInfos(MANIFEST_210));
  assert.equal(d.bakes[0].layout_id, "scatter_lon");
  assert.equal(d.bakes[0].problem, null);
  // Remove the pair from the draft and the queued bake can no longer be baked as queued.
  const gone = withDraft(state, seeded(MANIFEST_210).draft);
  assert.equal(derivePending(gone, layoutInfos(MANIFEST_210)).bakes[0].layout_id, null);
});

test("a re-bake of an orphaned layout cannot be baked under its own id", () => {
  let state = edit(seeded(MANIFEST_210), EDITS.drop_bucket);
  state = addBake(state, { kind: "rebake", layout_id: "categorical_bucket" });
  const d = derivePending(state, layoutInfos(MANIFEST_210));
  assert.equal(d.bakes[0].layout_id, null);
  assert.match(d.bakes[0].problem ?? "", /no longer produce/);
});

test("an incomplete edited draft reports its problem and prices no role outcome", () => {
  const state = edit(seeded(MANIFEST_210), (d) => {
    d.scatterPairs.push({ x: "lon", y: "", label: "" });
  });
  const d = derivePending(state, layoutInfos(MANIFEST_210));
  assert.match(d.problem ?? "", /needs both an X and a Y/);
  assert.deepEqual(d.outcomes, []);
  assert.equal(d.isPending, true);
  assert.equal(barSummary(d).problem, d.problem);
});

test("discard returns to the seed; remove un-queues", () => {
  let state = edit(seeded(MANIFEST_210), EDITS.format);
  state = addBake(state, { kind: "rebake", layout_id: "datetime" });
  assert.equal(removeBake(state, { kind: "rebake", layout_id: "datetime" }).bakes.length, 0);
  const discarded = discardPending(state);
  assert.equal(hasEdits(discarded), false);
  assert.deepEqual(changedRoleColumns(discarded.committed, derivePending(discarded, []).roles), []);
});

// --- persistence ---------------------------------------------------------------------

function memoryStore(): { store: Map<string, string>; api: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } } {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  };
}

// These three were built on `EDITS.format` until D-xxxiii: a restored draft's format is now
// put back to the committed one (below), so a format edit no longer survives a reload at all.
// `drop_bucket` is a role edit the Data view makes, and survives one.

test("a pending draft survives a reload for the same collection and version", () => {
  const { api } = memoryStore();
  const state = addBake(edit(seeded(MANIFEST_210), EDITS.drop_bucket), { kind: "rebake", layout_id: "datetime" });
  savePending("golden_dataset_full_v2", 1, state, api);
  const reloaded = loadPending("golden_dataset_full_v2", 1, seeded(MANIFEST_210), api);
  assert.deepEqual(reloaded.draft, state.draft);
  assert.deepEqual(reloaded.bakes, state.bakes);
});

test("the persisted draft is dropped, and removed, when dataset_version moved", () => {
  const { store, api } = memoryStore();
  savePending("ds", 1, edit(seeded(MANIFEST_210), EDITS.drop_bucket), api);
  const reloaded = loadPending("ds", 2, seeded(MANIFEST_210), api);
  assert.equal(hasEdits(reloaded), false, "the base it was drafted against is gone");
  assert.equal(store.has(pendingStorageKey("ds")), false, "and it cannot resurface");
});

test("the persisted draft is dropped when the committed ROLES moved without a version bump", () => {
  // run_set_roles re-declares column_roles and deliberately does NOT bump dataset_version
  // (worker.py). A draft keyed on the version alone would be re-applied to new roles.
  const { api } = memoryStore();
  savePending("ds", 1, edit(seeded(MANIFEST_210), EDITS.drop_bucket), api);
  const recommitted = seedPending({ ...MANIFEST_210.column_roles!, datetime: { column: "captured", label: "Captured", format: "unix_millis" } });
  assert.equal(hasEdits(loadPending("ds", 1, recommitted, api)), false);
});

// --- D-xxxiii: the restore path puts a saved draft's datetime format back ------------------

/** `captured`'s committed format moved by a roles-only commit — each is a real `pixscope
 *  set-roles` result on a copy of this tree (tests/dom/designer_data.dom.test.ts:
 *  FORMAT_MOVED and MILLIS), which changed that one key and nothing else. */
function withCommittedFormat(format: "iso8601" | "unix_seconds" | "unix_millis"): PendingState {
  const roles = MANIFEST_210.column_roles!;
  return seedPending({ ...roles, datetime: { ...roles.datetime!, format } });
}

test("a saved draft whose datetime format moved is put back to the committed one, and derives what the untouched screen does", () => {
  // Only a build before D-xxxiii (the Data view's format select) could save one. Restored as
  // it was, it is shown nowhere, counts as a change, and is sent on commit.
  const layouts = layoutInfos(MANIFEST_210);
  for (const committed of ["iso8601", "unix_seconds", "unix_millis"] as const) {
    for (const saved of ["iso8601", "unix_seconds", "unix_millis"] as const) {
      if (saved === committed) continue;
      const { api } = memoryStore();
      const fresh = withCommittedFormat(committed);
      savePending("ds", 1, edit(fresh, (d) => void (d.datetimeFormat = saved)), api);
      const restored = loadPending("ds", 1, withCommittedFormat(committed), api);
      const what = `${saved} saved over a committed ${committed}`;
      assert.equal(restored.draft?.datetimeFormat, committed, what);
      assert.equal(hasEdits(restored), false, what);
      // Everything L4 renders and the bar counts, exactly as with nothing stored.
      const { outcomes, baked, tags, changedColumns, roles, isPending } = derivePending(restored, layouts);
      const untouched = derivePending(fresh, layouts);
      assert.deepEqual(
        { outcomes, baked, tags, changedColumns, roles, isPending },
        {
          outcomes: untouched.outcomes,
          baked: untouched.baked,
          tags: untouched.tags,
          changedColumns: untouched.changedColumns,
          roles: untouched.roles,
          isPending: untouched.isPending,
        },
        what,
      );
    }
  }
});

test("a record the correction leaves with nothing pending is removed from storage, not re-read on every visit", () => {
  // Review of #394, finding 5. A record whose only edit was a moved format restored to
  // "Nothing pending", stayed in storage, and was re-parsed, corrected and validated on every
  // visit until the base moved — and nobody could clear it: with nothing pending there is no
  // Discard.
  const { store, api } = memoryStore();
  savePending("ds", 1, edit(withCommittedFormat("iso8601"), (d) => void (d.datetimeFormat = "unix_millis")), api);
  assert.equal(store.has(pendingStorageKey("ds")), true, "saved as an edit");
  const loaded = loadPending("ds", 1, withCommittedFormat("iso8601"), api);
  assert.equal(hasEdits(loaded), false);
  assert.equal(store.has(pendingStorageKey("ds")), false, "and then removed");
  // A record that still holds an edit is kept.
  savePending("ds", 1, edit(withCommittedFormat("iso8601"), (d) => {
    d.datetimeFormat = "unix_millis";
    EDITS.drop_bucket(d);
  }), api);
  loadPending("ds", 1, withCommittedFormat("iso8601"), api);
  assert.equal(store.has(pendingStorageKey("ds")), true, "an edit left after the correction keeps its record");
});

test("the correction touches the format alone: a saved role edit beside it survives, and is what a commit sends", () => {
  const { api } = memoryStore();
  const fresh = withCommittedFormat("iso8601");
  savePending("ds", 1, edit(fresh, (d) => {
    d.datetimeFormat = "unix_millis";
    EDITS.drop_bucket(d);
  }), api);
  const restored = loadPending("ds", 1, withCommittedFormat("iso8601"), api);
  assert.deepEqual(restored.draft, edit(fresh, EDITS.drop_bucket).draft);
  const d = derivePending(restored, layoutInfos(MANIFEST_210));
  assert.deepEqual(d.changedColumns, ["bucket"]);
  assert.equal(d.roles?.datetime?.format, "iso8601", "the commit sends the committed format");
});

test("datetimeFormatFor: the committed format on the committed datetime column, iso8601 on any other", () => {
  const roles = MANIFEST_210.column_roles!;
  const millis = { ...roles, datetime: { ...roles.datetime!, format: "unix_millis" as const } };
  assert.equal(datetimeFormatFor(millis, "captured"), "unix_millis", "the committed column keeps what was committed");
  assert.equal(datetimeFormatFor(millis, "modified"), "iso8601", "another column takes iso8601");
  // No datetime column in the draft: the seed's own value, which is the committed one — so a
  // two-role column the seed keeps as freeform does not read as an edit (see the DOM pin).
  assert.equal(datetimeFormatFor(millis, undefined), "unix_millis");
  assert.equal(datetimeFormatFor({ ...roles, datetime: undefined }, "captured"), "iso8601", "no committed datetime");
  assert.equal(datetimeFormatFor(null, undefined), "iso8601");
});

test("sendableDraft: the format follows the RESULT's datetime column, and each committed tag column its committed delimiter", () => {
  // Review of #394, finding 7: the one function the restore and every Data-view role change
  // run. The committed roles are FORMAT_MOVED's (captured at unix_seconds).
  const roles = { ...MANIFEST_210.column_roles!, datetime: { ...MANIFEST_210.column_roles!.datetime!, format: "unix_seconds" as const } };
  const seed = seedPending(roles).draft!;
  assert.equal(sendableDraft(seed, roles), seed, "the untouched seed is returned as it is");
  const off = (d: RolesDraft): RolesDraft => ({ ...d, choice: { ...d.choice, captured: "freeform" } });
  // Datetime moved onto `group`, then off again: nothing of the move is left.
  const onGroup = sendableDraft({ ...off(seed), choice: { ...off(seed).choice, group: "datetime" } }, roles);
  assert.equal(onGroup.datetimeFormat, "iso8601", "a column the committed roles do not make the datetime");
  const back = sendableDraft({ ...onGroup, choice: { ...onGroup.choice, group: "categorical", captured: "datetime" } }, roles);
  assert.equal(canonicalJson(back), canonicalJson(seed), "back where it started");
  // A committed tag column's delimiter is put back; a re-tagged column with none committed
  // keeps the draft's ([[T2-a-re-tagged-column-declares-a-delimiter-nobody]]).
  const tags = sendableDraft({ ...seed, tagDelimiters: { tags: ";", caption: "/" } }, roles);
  assert.deepEqual(tags.tagDelimiters, { tags: "|", caption: "/" });
});

// Re-review of #394, N1. The CLI accepts a map listing ONE column twice as a tag, with
// different delimiters. The seed keeps the LAST entry's delimiter (`rolesDraftFromColumnRoles`,
// last write wins), so the correction must want that one too: correcting towards each entry
// in turn wrote the first entry's, the next call the last one's back, and an undo that left
// only that delimiter different read as a phantom change on the column.
function tagsTwice(): NonNullable<typeof MANIFEST_210.column_roles> {
  const base = MANIFEST_210.column_roles!;
  return { ...base, tag: [...(base.tag ?? []), { column: "tags", label: "Tags, again", delimiter: ";" }] };
}

test("sendableDraft leaves alone the seed of a map that tags one column twice", () => {
  const roles = tagsTwice();
  const seed = seedPending(roles).draft!;
  assert.equal(seed.tagDelimiters.tags, ";", "the seed keeps the last entry's delimiter");
  assert.deepEqual(sendableDraft(seed, roles), seed, "the seed comes back unchanged");
});

test("sendableDraft is idempotent on a map that tags one column twice", () => {
  const roles = tagsTwice();
  const d = { ...seedPending(roles).draft!, tagDelimiters: { tags: "," } };
  const once = sendableDraft(d, roles);
  assert.deepEqual(sendableDraft(once, roles), once, "a second pass changes nothing");
  assert.equal(once.tagDelimiters.tags, ";");
});

test("nothing is persisted when nothing is pending, and a corrupt or absent store never throws", () => {
  const { store, api } = memoryStore();
  savePending("ds", 1, seeded(MANIFEST_210), api);
  assert.equal(store.size, 0);
  store.set(pendingStorageKey("ds"), "{not json");
  assert.equal(hasEdits(loadPending("ds", 1, seeded(MANIFEST_210), api)), false);
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  assert.doesNotThrow(() => savePending("ds", 1, edit(seeded(MANIFEST_210), EDITS.format), throwing));
  assert.equal(hasEdits(loadPending("ds", 1, seeded(MANIFEST_210), throwing)), false);
  assert.doesNotThrow(() => savePending("ds", 1, seeded(MANIFEST_210), null));
});

test("a stored draft that parses but cannot be walked is dropped and removed, never rendered", () => {
  // Found in review: `scatterPairs: [null]` passed the shape check, was restored, and
  // `validateDraft` threw `Cannot read properties of null (reading 'x')` inside render —
  // on every load, because the record was kept. Built from a real serialized record with
  // that one value corrupted: what a hand-edited store, or a build whose RolesDraft shape
  // differs under the same `v: 1`, leaves behind.
  const { store, api } = memoryStore();
  const good = JSON.parse(serializePending(edit(seeded(MANIFEST_210), EDITS.format), 1)) as {
    draft: RolesDraft & { scatterPairs: unknown[] };
  };
  good.draft.scatterPairs = [null];
  store.set(pendingStorageKey("ds"), JSON.stringify(good));
  let loaded: PendingState | null = null;
  assert.doesNotThrow(() => {
    loaded = loadPending("ds", 1, seeded(MANIFEST_210), api);
  });
  assert.equal(hasEdits(loaded as unknown as PendingState), false, "the fresh model is used instead");
  assert.equal(store.has(pendingStorageKey("ds")), false, "and the record is gone, so the next load is clean");
  assert.doesNotThrow(() => derivePending(loaded as unknown as PendingState, layoutInfos(MANIFEST_210)));
});

test("the storage record carries its base", () => {
  const raw = JSON.parse(serializePending(edit(seeded(MANIFEST_210), EDITS.format), 1)) as Record<string, unknown>;
  assert.equal(raw.v, 1);
  assert.equal(raw.datasetVersion, 1);
  assert.equal(typeof raw.base, "string");
});
