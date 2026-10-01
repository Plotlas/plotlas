// Seam L5 §2d — the commit's pure core (src/ui/designer/layoutsCommit.ts): how a pending
// change becomes EXACTLY ONE job, what it refuses, what D-xxix pre-queues, and how the
// worker's report is read back.
//
// FIXTURES, and the production state each reproduces (the same three as
// ui_designer_pending.test.ts, read the same way):
//   - tests/designer_fixture/layout_manifest_2.10.json — the golden full fixture refreshed
//     to 2.10 by the real producer: every layout records `source_fingerprint`;
//   - tests/designer_fixture/layout_manifest_2.9.json — the same tree at 2.9: provenance,
//     no fingerprint, so `derived.baked` reads every layout UNCHECKED;
//   - tests/fixtures/golden_dataset_full_v2/layout_manifest.json — the committed 2.8
//     manifest, no provenance at all: every non-grid layout is `unknown`.
//   `layoutInfos()` builds `LayoutInfo` as api/routers/layouts.py `list_layouts` does with
//   no job in flight.
//
// The TWO-ROLE map is the one shape here not read off a fixture: it is the committed roles
// with a second role added to one column, exactly the two shapes measured in
// [[T2-the-roles-draft-cannot-hold-a-column-s-second]] (categorical AND tag; datetime AND
// freeform). `column_roles.schema.json` allows them and the CLI writes them.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { JobStatus, LayoutInfo } from "../src/api-client/types.ts";
import type { ColumnRoles } from "../src/generated/column_roles.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import { addBake, derivePending, seedPending, withDraft } from "../src/ui/designer/pending.ts";
import type { PendingState } from "../src/ui/designer/pending.ts";
import {
  composeCommit,
  knobConflicts,
  layoutFate,
  loadJobRecord,
  movePatch,
  preQueue,
  reconcile,
  recordsFingerprint,
  renameMoves,
  saveJobRecord,
} from "../src/ui/designer/layoutsCommit.ts";
import type { JobRecord } from "../src/ui/designer/layoutsCommit.ts";

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
const MANIFEST_28 = readFixture(new URL("../../../tests/fixtures/golden_dataset_full_v2/layout_manifest.json", import.meta.url));

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

const L210 = layoutInfos(MANIFEST_210);

function seeded(roles: ColumnRoles | undefined = MANIFEST_210.column_roles): PendingState {
  return seedPending(roles);
}

function edit(state: PendingState, change: (d: RolesDraft) => void): PendingState {
  const draft = JSON.parse(JSON.stringify(state.draft)) as RolesDraft;
  change(draft);
  return withDraft(state, draft);
}

const FORMAT = (d: RolesDraft): void => {
  d.datetimeFormat = "unix_seconds";
};
const SECOND_PAIR = (d: RolesDraft): void => {
  d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
};
const LOG_SCALE = (d: RolesDraft): void => {
  d.scatterPairs[0] = { ...d.scatterPairs[0], x_scale: "log", y_scale: "log" };
};

function compose(pending: PendingState, layouts: LayoutInfo[] = L210, extraRebakes: string[] = [], busy: string | null = null) {
  return composeCommit({ pending, derived: derivePending(pending, layouts), layouts, extraRebakes, busy });
}

/** The committed roles with a second role on one column — the item's measured shapes. */
function withSecondRole(kind: "tag" | "freeform"): ColumnRoles {
  const roles = JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles;
  if (kind === "tag") roles.tag = [...(roles.tag ?? []), { column: "group", label: "Group", delimiter: "|" }];
  else roles.freeform = [...(roles.freeform ?? []), { column: "captured", label: "Captured" }];
  return roles;
}

// --- 4. commit composition: one commit, one job ------------------------------------------

test("roles changed, nothing queued → ONE setColumnRoles carrying derived.roles, and no bake", () => {
  const pending = edit(seeded(), FORMAT);
  const plan = compose(pending);
  assert.equal(plan.kind, "roles");
  if (plan.kind !== "roles") return;
  assert.deepEqual(plan.roles, derivePending(pending, L210).roles);
  assert.equal(plan.roles.datetime?.format, "unix_seconds");
  assert.deepEqual(plan.prediction.stale, ["datetime"]);
  assert.deepEqual(plan.prediction.bakes, []);
});

test("bakes queued → ONE addLayouts: resolved ids, replace names every re-bake, the roles ride with it", () => {
  // A second pair queued as its own layout, plus D-xxix's pre-ticked re-bake of the
  // layout the format change stales. The new pair renames `scatter` → `scatter_sx`.
  let pending = edit(seeded(), (d) => {
    FORMAT(d);
    SECOND_PAIR(d);
  });
  pending = addBake(pending, { kind: "new", type: "scatter", source_columns: ["lon", "lat"] });
  const derived = derivePending(pending, L210);
  const ticked = preQueue(pending, derived).ticked;
  assert.deepEqual(ticked, ["datetime"]);
  const plan = compose(pending, L210, ticked);
  assert.equal(plan.kind, "bake");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request.layout_specs, ["scatter_lon", "datetime"], "EXPANDED ids, never a bare family");
  assert.deepEqual(plan.request.replace, ["datetime"]);
  assert.deepEqual(plan.request.column_roles, derived.roles);
  assert.equal(plan.request.column_roles?.datetime?.format, "unix_seconds");
  assert.equal("url" in (plan.request.column_roles ?? {}), false, "a link is presentation, never a role (D-xvii)");
});

test("a re-bake with no role edit sends no column_roles at all — the committed roles stand", () => {
  const plan = compose(addBake(seeded(), { kind: "rebake", layout_id: "datetime" }));
  assert.equal(plan.kind, "bake");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request, { layout_specs: ["datetime"], replace: ["datetime"] });
});

test("user #8: with nothing added by the review, the plan's bakes ARE derived.bakes — the model is not resolved twice", () => {
  const pending = addBake(edit(seeded(), FORMAT), { kind: "rebake", layout_id: "datetime" });
  const derived = derivePending(pending, L210);
  const plan = composeCommit({ pending, derived, layouts: L210, extraRebakes: [], busy: null });
  assert.equal(plan.bakes, derived.bakes, "the same array, not a second derivation's");
});

test("nothing pending composes nothing", () => {
  assert.equal(compose(seeded()).kind, "empty");
});

test("a job already in flight refuses the commit, and says why", () => {
  const plan = compose(edit(seeded(), FORMAT), L210, [], "A job is already running on this collection.");
  assert.equal(plan.kind, "refused");
  if (plan.kind === "refused") assert.ok(plan.reasons.includes("A job is already running on this collection."));
});

// --- 5. the two-role refusal -------------------------------------------------------------
//
// WHICH columns the draft cannot hold is `heldRoles.ts`'s rule; its cases, and the roles.ts
// behaviour behind them, are pinned in tests/ui_designer_held_roles.test.ts. Pinned here is
// what the COMMIT does with it (D-xxxi, option A): a commit that sends roles is refused,
// naming the column; one that sends none goes through.

for (const [kind, column, roles] of [
  ["tag", "group", ["categorical", "tag"]],
  ["freeform", "captured", ["datetime", "freeform"]],
] as const) {
  test(`a column with two roles (${roles.join(" + ")}) REFUSES the commit, naming ${column} — nothing is sent`, () => {
    const committed = withSecondRole(kind);
    // A real edit on another column, and a bake — the commit a user would actually try.
    const pending = addBake(
      edit(seeded(committed), (d) => {
        d.choice.caption = "categorical";
      }),
      { kind: "new", type: "categorical", source_columns: ["caption"] },
    );
    const plan = compose(pending);
    assert.equal(plan.kind, "refused");
    if (plan.kind !== "refused") return;
    const named = plan.reasons.filter((r) => r.includes(`“${column}”`) && r.includes("CLI"));
    assert.equal(named.length, 1, plan.reasons.join(" | "));
  });
}

/** The golden roles with one role added to a coordinate-pair axis — seam L4's second shape,
 *  which the CLI can write. */
function withRoleOnAxis(kind: "freeform" | "categorical", column: string): ColumnRoles {
  const roles = JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles;
  if (kind === "freeform") roles.freeform = [...(roles.freeform ?? []), { column, label: column }];
  else roles.categorical = [...(roles.categorical ?? []), { column, label: column }];
  return roles;
}

test("a FREEFORM role on a pair axis REFUSES a commit that sends roles, naming the role it would drop", () => {
  const plan = compose(addBake(edit(seeded(withRoleOnAxis("freeform", "sx")), FORMAT), { kind: "rebake", layout_id: "datetime" }));
  assert.equal(plan.kind, "refused");
  if (plan.kind === "refused") {
    assert.equal(
      plan.reasons.filter((r) => r.includes("“sx” carries Freeform (display only) and a coordinate pair") && r.includes("drop its Freeform (display only) role"))
        .length,
      1,
    );
  }
});

test("a STORING role on a pair axis: a re-bake alone sends no roles, so it is not refused", () => {
  // Option A (operator decision 2026-09-25): the worker bakes from the manifest's roles, the
  // axis role included.
  const alone = compose(addBake(seeded(withRoleOnAxis("categorical", "lon")), { kind: "rebake", layout_id: "datetime" }));
  assert.equal(alone.kind, "bake");
  if (alone.kind === "bake") assert.equal("column_roles" in alone.request, false);
});

test("NOT refused: a commit that sends roles on a column shared by two pairs, or with embedding beside another role", () => {
  // The draft holds both exactly, so a role edit elsewhere loses nothing and goes out.
  const shared = JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles;
  shared.scatter = [...(shared.scatter ?? []), { x_column: "sx", y_column: "lon", label: "sx / lon" }];
  const embedded = JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles;
  embedded.embedding = { column: "caption", label: "Caption embedding", dim: 8 };
  for (const committed of [shared, embedded]) {
    const plan = compose(edit(seeded(committed), FORMAT));
    assert.equal(plan.kind, "roles", plan.kind === "refused" ? plan.reasons.join(" | ") : "");
  }
});

test("option A (operator 2026-09-25): a re-bake that sends NO column_roles is not refused on a two-role collection", () => {
  // The worker reads the manifest's own roles, so nothing can be lost.
  const plan = compose(addBake(seeded(withSecondRole("tag")), { kind: "rebake", layout_id: "datetime" }));
  assert.equal(plan.kind, "bake");
  if (plan.kind === "bake") assert.deepEqual(plan.request, { layout_specs: ["datetime"], replace: ["datetime"] });
});

test("option A: picking a pair on a two-role collection edits the draft, so that commit sends roles — refused", () => {
  const pending = addBake(
    edit(seeded(withSecondRole("tag")), (d) => {
      d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
    }),
    { kind: "new", type: "scatter", source_columns: ["lon", "lat"] },
  );
  const plan = compose(pending);
  assert.equal(plan.kind, "refused");
  if (plan.kind === "refused") assert.ok(plan.reasons.some((r) => r.includes("“group”")));
});

// --- the worker's pair-knob guard (D-xxx: only for a layout that records no fingerprint) ---

// A projection change, because the worker's VALUE gate also passes it on this tree (`lat`
// spans ±78°, inside Web Mercator's 85.05°; measured in test_knob_guard_fingerprint.py),
// while every scatter knob fails that gate first — so "the worker accepts it" is true of
// this edit end to end, not only of the knob guard.
const MERCATOR = (d: RolesDraft): void => {
  d.geoPairs[0] = { ...d.geoPairs[0], projection: "mercator" };
};

test("D-xxx: a knob change on a FINGERPRINTED pair rides a bake that does not re-bake it — and then reads stale", () => {
  // Every 2.10 layout records how it was baked. The worker lets this run through, so the
  // review must too: refusing it would block a commit the worker accepts.
  const pending = addBake(edit(seeded(), MERCATOR), { kind: "rebake", layout_id: "datetime" });
  const plan = compose(pending);
  assert.equal(plan.kind, "bake");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request.replace, ["datetime"], "the map is NOT re-baked");
  assert.equal(plan.request.column_roles?.geographic?.[0]?.projection, "mercator");
  // ...and why that is safe: once those roles are committed, the map's own record says it is
  // out of date, with nothing pending — the durable flag, not this edit's prediction.
  const after = derivePending(seedPending(plan.request.column_roles), L210);
  assert.deepEqual(
    after.baked.find((b) => b.layout_id === "geographic"),
    { layout_id: "geographic", checkable: true, staleColumns: ["lat", "lon"] },
  );
});

test("an UNFINGERPRINTED pair (2.9) with the same change is still refused up front, and says why", () => {
  // Baked before 2.10, the map records nothing, so the worker's guard still refuses the run
  // before any tile; sending it would only buy a failed job.
  const l29 = layoutInfos(MANIFEST_29);
  const pending = addBake(edit(seedPending(MANIFEST_29.column_roles), MERCATOR), { kind: "rebake", layout_id: "datetime" });
  const plan = compose(pending, l29);
  assert.equal(plan.kind, "refused");
  if (plan.kind === "refused") {
    const named = plan.reasons.filter(
      (r) => r.includes("map settings of “Location”") && r.includes("baked before layouts recorded") && r.includes("on its own first"),
    );
    assert.equal(named.length, 1, plan.reasons.join(" | "));
  }
  // ...and it composes once the map is re-baked in the same run.
  const ok = compose(pending, l29, ["geographic"]);
  assert.equal(ok.kind, "bake");
  if (ok.kind === "bake") assert.deepEqual(ok.request.replace, ["datetime", "geographic"]);
});

test("the same knob change ALONE is a roles-only commit — staying stale is legal (D-xxix)", () => {
  assert.equal(compose(edit(seeded(), LOG_SCALE)).kind, "roles");
});

test("knobConflicts matches the committed pair by columns, and exempts a replaced layout and a fingerprinted one", () => {
  const l29 = layoutInfos(MANIFEST_29);
  const next = derivePending(edit(seedPending(MANIFEST_29.column_roles), LOG_SCALE), l29).roles;
  const ids = new Set(l29.map((l) => l.layout_id));
  const none = new Set(l29.filter(recordsFingerprint).map((l) => l.layout_id));
  assert.equal(none.size, 0, "fixture premise: no 2.9 layout records a fingerprint");
  assert.deepEqual(knobConflicts(MANIFEST_29.column_roles ?? null, next, ids, new Set(), none), [
    { layout_id: "scatter", family: "scatter", columns: ["sx", "sy"], exact: true },
  ]);
  assert.deepEqual(knobConflicts(MANIFEST_29.column_roles ?? null, next, ids, new Set(["scatter"]), none), []);
  const all = new Set(L210.filter(recordsFingerprint).map((l) => l.layout_id));
  assert.equal(all.size, L210.length, "fixture premise: every 2.10 layout records one");
  assert.deepEqual(knobConflicts(MANIFEST_210.column_roles ?? null, next, ids, new Set(), all), []);
});

// A pair declared TWICE: the first layout baked before 2.10 at the committed knobs, the second
// re-baked since with different ones. The knobs compare against the pair's LAST entry
// ([[T2-the-stale-knob-guards-compare-a-pair-declared]]), so a change to the second alone is
// still refused, naming the first — whose settings did not change (review of #392, finding 1).
// test_knob_guard_fingerprint.py pins the worker's side of the same two cases.
const DECLARED_TWICE = {
  scatter: {
    entries: [
      { x_column: "sx", y_column: "sy", label: "Fitted" },
      { x_column: "sx", y_column: "sy", label: "Raw", normalize: "none" },
    ],
    patch: { x_scale: "log" },
    ids: ["scatter_sx", "scatter_sx-1"],
    columns: ["sx", "sy"],
  },
  geographic: {
    entries: [
      { lon_column: "lon", lat_column: "lat", label: "Flat" },
      { lon_column: "lon", lat_column: "lat", label: "Web map", projection: "mercator" },
    ],
    patch: { projection: "equirectangular" },
    ids: ["geographic_lon", "geographic_lon-1"],
    columns: ["lon", "lat"],
  },
} as const;

function declaredTwice(family: "scatter" | "geographic"): { committed: ColumnRoles; layouts: LayoutInfo[] } {
  const [first, second] = DECLARED_TWICE[family].ids;
  const committed = JSON.parse(JSON.stringify({ ...MANIFEST_210.column_roles, [family]: DECLARED_TWICE[family].entries })) as ColumnRoles;
  const unrecorded = layoutInfos(MANIFEST_29).find((l) => l.layout_id === family);
  const recorded = L210.find((l) => l.layout_id === family);
  assert.ok(unrecorded !== undefined && recorded !== undefined);
  const layouts = [...L210.filter((l) => l.type !== family), { ...unrecorded, layout_id: first }, { ...recorded, layout_id: second }];
  return { committed, layouts };
}

for (const family of ["scatter", "geographic"] as const) {
  test(`${family}: on a pair declared twice a conflict is not EXACT — the layout it names may be unchanged`, () => {
    const { committed, layouts } = declaredTwice(family);
    const next = JSON.parse(JSON.stringify(committed)) as Record<string, Record<string, unknown>[]>;
    Object.assign(next[family][1], DECLARED_TWICE[family].patch); // ONLY the second, fingerprinted, layout changes
    const conflict = { layout_id: DECLARED_TWICE[family].ids[0], family, columns: [...DECLARED_TWICE[family].columns], exact: false };
    assert.deepEqual(
      knobConflicts(
        committed,
        next as unknown as ColumnRoles,
        new Set(layouts.map((l) => l.layout_id)),
        new Set(),
        new Set(layouts.filter(recordsFingerprint).map((l) => l.layout_id)),
      ),
      // Both declarations differ from the last committed one, and both name the first.
      [conflict, conflict],
    );
  });
}

test("a pair the OVERRIDE declares a second time is not exact either", () => {
  // Committed once (2.9 `scatter` on sx/sy); the override adds a second declaration of the
  // same pair with other settings and leaves the first alone. The worker's side of this case
  // is in test_knob_guard_fingerprint.py.
  const l29 = layoutInfos(MANIFEST_29);
  const committed = MANIFEST_29.column_roles ?? null;
  assert.ok(committed !== null);
  const next = JSON.parse(JSON.stringify(committed)) as ColumnRoles;
  next.scatter = [...(next.scatter ?? []), { x_column: "sx", y_column: "sy", label: "Raw", normalize: "none" }];
  assert.deepEqual(knobConflicts(committed, next, new Set(l29.map((l) => l.layout_id)), new Set(), new Set()), [
    { layout_id: "scatter", family: "scatter", columns: ["sx", "sy"], exact: false },
  ]);
});

test("on a pair declared twice the review never offers to re-bake the layout it names", () => {
  const { committed, layouts } = declaredTwice("scatter");
  // The shape the designer can reach: the user removes the second declaration (an edited
  // draft that still declares a pair twice is refused as incomplete), riding a re-bake.
  const pending = addBake(
    edit(seedPending(committed), (d) => {
      d.scatterPairs.splice(1, 1);
    }),
    { kind: "rebake", layout_id: "datetime" },
  );
  const plan = compose(pending, layouts);
  assert.equal(plan.kind, "refused");
  if (plan.kind !== "refused") return;
  const named = plan.reasons.filter((r) => r.includes("a pair declared more than once") && r.includes("cannot tell"));
  assert.equal(named.length, 1, plan.reasons.join(" | "));
  assert.ok(!plan.reasons.some((r) => r.includes("Re-bake it in this run")), plan.reasons.join(" | "));
});

// The PARITY pin. packages/pipeline/tests/test_knob_guard_fingerprint.py runs the same
// vector through the worker's two guards, so neither side can refuse differently without
// one suite going red: never less than the worker (a job certain to fail), and since D-xxx
// never more (a commit the worker accepts, blocked). The vector's `about` is its format.
interface KnobCase {
  name: string;
  declare?: Partial<ColumnRoles>;
  layouts: { layout_id: string; from: "2.9" | "2.10"; entry?: string }[];
  edit: Record<string, Record<string, string>[]>;
  replace: string[];
  refuses: { scatter: string | null; geographic: string | null };
}

const KNOB_CASES = (
  JSON.parse(readFileSync(fileURLToPath(new URL("./designer_fixture/knob_guard_cases.json", import.meta.url)), "utf8")) as {
    cases: KnobCase[];
  }
).cases;
const BY_VERSION = { "2.9": MANIFEST_29, "2.10": MANIFEST_210 } as const;

for (const c of KNOB_CASES) {
  test(`knobConflicts refuses exactly what the worker's guards refuse: ${c.name}`, () => {
    const committed = { ...(JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles), ...(c.declare ?? {}) };
    const layouts = c.layouts.map(({ layout_id, from, entry }) => {
      const info = layoutInfos(BY_VERSION[from]).find((l) => l.layout_id === (entry ?? layout_id));
      assert.ok(info !== undefined, `${from} has no layout ${entry ?? layout_id}`);
      return { ...info, layout_id };
    });
    const next = JSON.parse(JSON.stringify(committed)) as Record<string, Record<string, unknown>[]>;
    for (const [family, patches] of Object.entries(c.edit)) patches.forEach((patch, i) => Object.assign(next[family][i], patch));
    const conflicts = knobConflicts(
      committed,
      next as unknown as ColumnRoles,
      new Set(layouts.map((l) => l.layout_id)),
      new Set(c.replace),
      new Set(layouts.filter(recordsFingerprint).map((l) => l.layout_id)),
    );
    // The worker raises on the first conflict per guard; this lists every one. They agree
    // when every conflict of a family names one layout, which the vector's cases do.
    const named = (family: string): string | null => {
      const ids = [...new Set(conflicts.filter((k) => k.family === family).map((k) => k.layout_id))];
      assert.ok(ids.length <= 1, `${family}: expected at most one layout named, got ${ids.join(", ")}`);
      return ids[0] ?? null;
    };
    assert.deepEqual({ scatter: named("scatter"), geographic: named("geographic") }, c.refuses);
  });
}

// --- 3. D-xxix pre-ticks -------------------------------------------------------------------

test("the review pre-ticks a re-bake of the layout this edit newly stales (2.10: checkable)", () => {
  const pending = edit(seeded(), FORMAT);
  const q = preQueue(pending, derivePending(pending, L210));
  assert.deepEqual(q, { ticked: ["datetime"], unchecked: [], cannot: [] });
});

test("an UNCHECKED layout is never pre-ticked — a 2.9 bake records no fingerprint", () => {
  const l29 = layoutInfos(MANIFEST_29);
  const pending = edit(seedPending(MANIFEST_29.column_roles), FORMAT);
  const q = preQueue(pending, derivePending(pending, l29));
  assert.deepEqual(q.ticked, []);
  assert.deepEqual(q.unchecked, ["datetime"]);
});

test("an UNKNOWN layout (2.8, no provenance) is never pre-ticked either", () => {
  const l28 = layoutInfos(MANIFEST_28);
  const pending = edit(seedPending(MANIFEST_28.column_roles), FORMAT);
  const q = preQueue(pending, derivePending(pending, l28));
  assert.deepEqual(q.ticked, []);
  assert.deepEqual(q.unchecked, ["datetime", "scatter", "categorical_group", "categorical_bucket", "geographic"]);
});

test("MEASURED (review of #385, R3): what the shared model says about each contradiction the review printed", () => {
  // R3b — on 2.9, a format change: the prediction says STALE (its provenance locates its
  // entry) and NOT unknown; "can't be known" came from the durable record (`checkable`
  // false), a different question. No model inconsistency: two fields, both true.
  const l29 = layoutInfos(MANIFEST_29);
  const d29 = derivePending(edit(seedPending(MANIFEST_29.column_roles), FORMAT), l29);
  const o29 = d29.outcomes.find((o) => o.layout_id === "datetime");
  assert.deepEqual({ stale: o29?.stale, unknown: o29?.unknown }, { stale: true, unknown: false });
  assert.equal(d29.baked.find((b) => b.layout_id === "datetime")?.checkable, false);
  // R3a — on 2.8, a second scatter pair: the pre-2.9 scatter is BOTH orphaned and unknown,
  // as pending.ts documents ("its id is provably gone, and which of rename or orphan it is
  // cannot be told").
  const l28 = layoutInfos(MANIFEST_28);
  const d28 = derivePending(edit(seedPending(MANIFEST_28.column_roles), SECOND_PAIR), l28);
  const o28 = d28.outcomes.find((o) => o.layout_id === "scatter");
  assert.deepEqual({ orphaned: o28?.orphaned, unknown: o28?.unknown, stale: o28?.stale }, { orphaned: true, unknown: true, stale: false });
});

test("a layout already queued for a re-bake is not pre-queued a second time", () => {
  const pending = addBake(edit(seeded(), FORMAT), { kind: "rebake", layout_id: "datetime" });
  assert.deepEqual(preQueue(pending, derivePending(pending, L210)).ticked, []);
});

// --- 7. a renamed layout keeps its name and its default -------------------------------------

test("baking the new id of a renamed layout adopts the rename", () => {
  const pending = edit(seeded(), SECOND_PAIR);
  const scatter = L210.find((l) => l.layout_id === "scatter");
  assert.ok(scatter !== undefined);
  assert.deepEqual(layoutFate(pending, L210, scatter), { kind: "renamed", to: "scatter_sx" });
  assert.deepEqual(renameMoves(pending, L210, ["scatter_sx", "scatter_lon"]), [{ from: "scatter", to: "scatter_sx" }]);
  assert.deepEqual(renameMoves(pending, L210, ["scatter_lon"]), [], "not baked in this run → nothing adopted");
});

test("N3: nothing edited on a two-role collection — every committed layout is produced, not what the lossy seed would bake", () => {
  const fates = (roles: ColumnRoles): Record<string, string> =>
    Object.fromEntries(L210.map((l) => [l.layout_id, layoutFate(seeded(roles), L210, l).kind]));
  const produced = Object.fromEntries(L210.map((l) => [l.layout_id, "produced"]));
  // Through the seed, `categorical_group` was orphaned and `categorical_bucket` renamed to
  // bare `categorical` (categorical + tag), and `datetime` orphaned (datetime + freeform).
  assert.deepEqual(fates(withSecondRole("tag")), produced);
  assert.deepEqual(fates(withSecondRole("freeform")), produced);
});

test("N3: ...and only there — on a collection the seed holds exactly, an untouched model still reports a roles-only commit's orphan and rename", () => {
  // `set-roles` took the categorical role off `group`: its layout is orphaned, and Bucket's
  // family dropped to one entry, so its next bake files it as bare `categorical`.
  const roles = JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles;
  roles.categorical = (roles.categorical ?? []).filter((c) => c.column !== "group");
  const pending = seeded(roles);
  const fate = (id: string): unknown => layoutFate(pending, L210, L210.find((l) => l.layout_id === id)!);
  assert.deepEqual(fate("categorical_group"), { kind: "orphaned" });
  assert.deepEqual(fate("categorical_bucket"), { kind: "renamed", to: "categorical" });
});

test("D-xxxi: datetime AND freeform on `captured`, nothing edited — re-baking By date is ONE addLayouts, no roles, no refusal", () => {
  const plan = compose(addBake(seeded(withSecondRole("freeform")), { kind: "rebake", layout_id: "datetime" }));
  assert.equal(plan.kind, "bake", plan.kind === "refused" ? plan.reasons.join(" / ") : "");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request, { layout_specs: ["datetime"], replace: ["datetime"] });
  assert.equal("column_roles" in plan.request, false, "the worker re-bakes from the manifest's own roles");
});

test("D-xxxi: ...and with that `captured` rendered as a link — the designer offers it, showing `captured` as freeform — still ONE addLayouts, no roles, no refusal", () => {
  // The link rides in the seed (`draft.url`, from the presentation). Named back to datetime,
  // `captured` is no linkable column, and `validateDraft` refused the naming draft over it.
  const pending = seedPending(withSecondRole("freeform"), { captured: { render: "url" } });
  assert.deepEqual(pending.seed?.url, ["captured"], "precondition: the link is in the seed");
  const plan = compose(addBake(pending, { kind: "rebake", layout_id: "datetime" }));
  assert.equal(plan.kind, "bake", plan.kind === "refused" ? plan.reasons.join(" / ") : "");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request, { layout_specs: ["datetime"], replace: ["datetime"] });
  assert.equal("column_roles" in plan.request, false);
});

test("D-xxxi: categorical AND tag on `group`, nothing edited — re-baking Group and Bucket is ONE addLayouts, no roles, no refusal", () => {
  let pending = seeded(withSecondRole("tag"));
  pending = addBake(pending, { kind: "rebake", layout_id: "categorical_group" });
  pending = addBake(pending, { kind: "rebake", layout_id: "categorical_bucket" });
  const plan = compose(pending);
  assert.equal(plan.kind, "bake", plan.kind === "refused" ? plan.reasons.join(" / ") : "");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request, {
    layout_specs: ["categorical_group", "categorical_bucket"],
    replace: ["categorical_group", "categorical_bucket"],
  });
  assert.equal("column_roles" in plan.request, false, "the worker re-bakes from the manifest's own roles");
});

test("D-xxxi: ...a NEW grouping there is named from the committed roles too — categorical_bucket, not bare `categorical`", () => {
  // Only Group's grouping was baked (an add-layouts run took that one spec). The seed keeps
  // `group` as tag, which left the family ONE entry and named Bucket's bare `categorical`.
  const layouts = L210.filter((l) => l.layout_id !== "categorical_bucket");
  const plan = compose(addBake(seeded(withSecondRole("tag")), { kind: "new", type: "categorical", source_columns: ["bucket"] }), layouts);
  assert.equal(plan.kind, "bake", plan.kind === "refused" ? plan.reasons.join(" / ") : "");
  if (plan.kind !== "bake") return;
  assert.deepEqual(plan.request.layout_specs, ["categorical_bucket"]);
  assert.equal("column_roles" in plan.request, false);
});

test("D-xxxi: ...and only the seed's loss is undone — committed roles that rename `scatter` still refuse its re-bake, and its card says renamed", () => {
  // L4's fixture: `caption` is freeform AND a second scatter axis. The seed is lossy (the
  // compile drops the freeform role), but the COMMITTED roles declare two scatter pairs, so
  // they bake the first as `scatter_sx`, and `scatter` is not theirs to re-bake.
  const roles = JSON.parse(JSON.stringify(MANIFEST_210.column_roles)) as ColumnRoles;
  roles.scatter = [...(roles.scatter ?? []), { x_column: "sx", y_column: "caption", label: "Second" }];
  const plan = compose(addBake(seeded(roles), { kind: "rebake", layout_id: "scatter" }));
  assert.equal(plan.kind, "refused");
  if (plan.kind === "refused") assert.ok(plan.reasons.some((r) => r.includes("no longer produce it")));
  const scatter = L210.find((l) => l.layout_id === "scatter");
  assert.ok(scatter !== undefined);
  assert.deepEqual(layoutFate(seeded(roles), L210, scatter), { kind: "renamed", to: "scatter_sx" });
});

test("an adopted rename moves the label and a matching default — once the new id is live", () => {
  const presentation = {
    layouts: { scatter: { label: "Embedding" }, datetime: { label: "Timeline" } },
    dataset: { default_layout: "scatter", display_name: "Golden" },
  };
  const moves = [{ from: "scatter", to: "scatter_sx" }];
  assert.equal(movePatch(moves, presentation, new Set(["scatter"])), null, "nothing moves before the new id lands");
  const moved = movePatch(moves, presentation, new Set(["scatter", "scatter_sx"]));
  assert.ok(moved !== null);
  assert.deepEqual(moved.patch, {
    layouts: { scatter_sx: { label: "Embedding" }, scatter: null },
    default_layout: "scatter_sx",
  });
  assert.deepEqual(moved.next.layouts, { datetime: { label: "Timeline" }, scatter_sx: { label: "Embedding" } });
  assert.equal(moved.next.dataset?.default_layout, "scatter_sx");
  assert.equal(moved.next.dataset?.display_name, "Golden");
});

test("once an adopted rename lands, the old and new layouts BOTH read stale until the old one is deleted", () => {
  // The state the designer's copy warns about: the commit baked scatter_sx beside the
  // committed `scatter`, and both recorded the same fingerprint. One declared entry cannot
  // supply two demands, so pending.ts reports both — the safe direction (CONTRACT §4).
  const roles = derivePending(edit(seeded(), SECOND_PAIR), L210).roles;
  assert.ok(roles !== null);
  const scatter = L210.find((l) => l.layout_id === "scatter");
  assert.ok(scatter !== undefined);
  const lonLat = {
    lon: [["scatter", "x", "lat", "linear", "linear", "fit", "overdraw"]],
    lat: [["scatter", "y", "lon", "linear", "linear", "fit", "overdraw"]],
  };
  const landed: LayoutInfo[] = [
    ...L210,
    { ...scatter, layout_id: "scatter_sx" },
    { ...scatter, layout_id: "scatter_lon", label: "lon / lat", source_columns: ["lon", "lat"], source_fingerprint: lonLat },
  ];
  const baked = derivePending(seedPending(roles), landed).baked;
  const stale = baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id);
  assert.deepEqual(stale, ["scatter", "scatter_sx"]);
  // ...and deleting the old one clears it.
  const afterDelete = derivePending(seedPending(roles), landed.filter((l) => l.layout_id !== "scatter")).baked;
  assert.equal(afterDelete.filter((b) => b.staleColumns.length > 0).length, 0);
});

test("a default that points elsewhere, and a label the new id already has, are left alone", () => {
  const moved = movePatch(
    [{ from: "scatter", to: "scatter_sx" }],
    { layouts: { scatter: { label: "Embedding" }, scatter_sx: { label: "Mine" } }, dataset: { default_layout: "datetime" } },
    new Set(["scatter_sx"]),
  );
  assert.ok(moved !== null);
  assert.deepEqual(moved.patch, {});
});

// --- 6. the worker's report wins -----------------------------------------------------------

function runningRecord(kind: "roles" | "bake", pending: PendingState, extra: string[] = []): JobRecord {
  const plan = compose(pending, L210, extra);
  assert.ok(plan.kind === kind, `composed ${plan.kind}`);
  return {
    v: 1,
    jobId: "job-1",
    kind,
    phase: "running",
    prediction: plan.kind === "roles" || plan.kind === "bake" ? plan.prediction : null,
    moves: [],
    restore: null,
    deleting: null,
  };
}

function finished(result: JobStatus["result"]): JobStatus {
  return { job_id: "job-1", state: "finished", dataset_id: "golden_dataset_full_v2", log_tail: [], result };
}

const ROLES_RESULT = {
  dataset_id: "golden_dataset_full_v2",
  dataset_version: "1",
  manifest_version: "2.10",
  changed_columns: ["captured"],
  stale_layouts: ["datetime"],
  unknown_layouts: [],
  orphaned_layouts: [],
  renamed_layouts: {},
  unserved_tag_roles: [],
  stale_tag_sidecar: null,
};

test("a roles report that AGREES with the prediction yields no finding", () => {
  const r = reconcile(runningRecord("roles", edit(seeded(), FORMAT)), finished(ROLES_RESULT), L210);
  assert.deepEqual(r, { outcome: "finished", findings: [], error: null });
});

test("a roles report that DISAGREES surfaces as a finding naming the layout, never swallowed", () => {
  const r = reconcile(
    runningRecord("roles", edit(seeded(), FORMAT)),
    finished({ ...ROLES_RESULT, stale_layouts: ["datetime", "categorical_group"] }),
    L210,
  );
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0], /worker reports “Group” stale; the prediction did not/);
});

test("a bake report missing a predicted layout is a finding", () => {
  const record = runningRecord("bake", addBake(seeded(), { kind: "rebake", layout_id: "datetime" }));
  const r = reconcile(record, finished({ dataset_version: "2", committed: [], replaced: [], failed: [] }), L210);
  assert.equal(r.findings.length, 2, r.findings.join(" | "));
  assert.ok(r.findings.every((f) => f.includes("“By date”")));
});

test("a failed job reports its own error; a job gone from the queue reports that", () => {
  const record = runningRecord("roles", edit(seeded(), FORMAT));
  const failed = reconcile(record, { ...finished(null), state: "failed", error: "ColumnRoleError: nope" }, L210);
  assert.deepEqual(failed, { outcome: "failed", findings: [], error: "ColumnRoleError: nope" });
  assert.equal(reconcile(record, null, L210).outcome, "expired");
});

// --- persistence ---------------------------------------------------------------------------

function memoryStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test("a job record round-trips through storage, and a malformed one is dropped", () => {
  const store = memoryStore();
  const record = runningRecord("roles", edit(seeded(), FORMAT));
  saveJobRecord("ds", record, store);
  assert.deepEqual(loadJobRecord("ds", store), record);
  store.setItem("plotlas.designer.job.ds", JSON.stringify({ v: 1, jobId: 7 }));
  assert.equal(loadJobRecord("ds", store), null);
  assert.equal(store.data.size, 0, "the malformed record is removed");
  saveJobRecord("ds", null, store);
  assert.equal(loadJobRecord("ds", store), null);
});

test("N6: a stored job record that is not JSON at all is removed too, not parsed again on every visit", () => {
  const store = memoryStore();
  store.setItem("plotlas.designer.job.ds", "{\"v\":1,\"jobId\":"); // a write cut short
  assert.equal(loadJobRecord("ds", store), null);
  assert.equal(store.data.size, 0, "the unparseable record is removed");
});
