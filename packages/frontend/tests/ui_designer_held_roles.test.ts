// Node tier — the designer's one two-role rule (src/ui/designer/heldRoles.ts;
// LAYOUT_DESIGNER D-xxxi). Both views read it: the Data row's flag (pinned in
// tests/dom/designer_data.dom.test.ts §6) and the commit's refusal (pinned in
// tests/ui_designer_layouts_commit.test.ts §5 and tests/dom/designer_layouts.dom.test.ts §5).
//
// Seams L4 (`dataModel.heldRoleConflicts`) and L5 (`layoutsCommit.twoRoleColumns`) each
// built this rule. Before both copies were deleted, this file's first version ran them
// against the shared one on 5,000 seeded-random committed/seed pairs over a five-column set
// and all three answered identically (commit 0e0e11a5). What stays is the same comparison
// on fixed cases — one per branch the random run reached, each with its answer written out.
//
// THIS file owns the rule's cases, and the roles.ts behaviour the rule rests on (why an axis
// role is flagged, why a shared pair or an embedding is not). The commit test's §5 pins only
// what the commit does with the rule; the Data view's DOM test pins the row.
//
// Every committed map is the golden 2.10 roles (tests/designer_fixture, written by the real
// producer) with one or two roles added, shapes the CLI can write — two in "two choice
// roles AND an axis" and in the two-column order case; the seed is
// `rolesDraftFromColumnRoles` of it, as `seedPending` makes it.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ColumnRoles } from "../src/generated/column_roles.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import { buildColumnRoles, rolesDraftFromColumnRoles, validateDraft } from "../src/ui/admin/roles.ts";
import { heldRoleConflicts } from "../src/ui/designer/heldRoles.ts";
import { changedRoleColumns } from "../src/ui/designer/pending.ts";
import type { HeldRoleConflict } from "../src/ui/designer/heldRoles.ts";

const GOLDEN = (
  JSON.parse(readFileSync(fileURLToPath(new URL("./designer_fixture/layout_manifest_2.10.json", import.meta.url)), "utf8")) as {
    column_roles: ColumnRoles;
  }
).column_roles;

function golden(change: (roles: ColumnRoles) => void = () => {}): ColumnRoles {
  const roles = JSON.parse(JSON.stringify(GOLDEN)) as ColumnRoles;
  change(roles);
  return roles;
}

function held(committed: ColumnRoles | null | undefined, seed?: RolesDraft | null): [string, HeldRoleConflict][] {
  const draft = seed !== undefined ? seed : committed == null ? null : rolesDraftFromColumnRoles(committed);
  return [...heldRoleConflicts(committed, draft)];
}

const TAG_ON_GROUP = (r: ColumnRoles): void => {
  r.tag = [...(r.tag ?? []), { column: "group", label: "Group", delimiter: "|" }];
};
const FREEFORM_ON_CAPTURED = (r: ColumnRoles): void => {
  r.freeform = [...(r.freeform ?? []), { column: "captured", label: "Captured" }];
};
const FREEFORM_ON_SX = (r: ColumnRoles): void => {
  r.freeform = [...(r.freeform ?? []), { column: "sx", label: "sx" }];
};
const CATEGORICAL_ON_LON = (r: ColumnRoles): void => {
  r.categorical = [...(r.categorical ?? []), { column: "lon", label: "lon" }];
};
const SHARED_PAIR = (r: ColumnRoles): void => {
  r.scatter = [...(r.scatter ?? []), { x_column: "sx", y_column: "lon", label: "sx / lon" }];
};
const EMBEDDING_ON_CAPTION = (r: ColumnRoles): void => {
  r.embedding = { column: "caption", label: "Caption embedding", dim: 8 };
};

test("nothing to hold: the golden roles, and no roles or no seed at all", () => {
  assert.deepEqual(held(golden()), []);
  assert.deepEqual(held(null), []);
  assert.deepEqual(held(undefined), []);
  assert.deepEqual(held(golden(TAG_ON_GROUP), null), [], "no seed, no draft to fall short");
});

for (const [name, change, expected] of [
  [
    "two choice roles — categorical and tag: the seed keeps tag",
    TAG_ON_GROUP,
    [["group", { declared: ["categorical", "tag"], kept: "tag", dropped: ["categorical"] }]],
  ],
  [
    "two choice roles — datetime and freeform: the seed keeps freeform",
    FREEFORM_ON_CAPTURED,
    [["captured", { declared: ["datetime", "freeform"], kept: "freeform", dropped: ["datetime"] }]],
  ],
  [
    "one kind twice",
    (r: ColumnRoles) => void (r.categorical = [...(r.categorical ?? []), { column: "group", label: "Group again" }]),
    [["group", { declared: ["categorical", "categorical"], kept: "categorical", dropped: ["categorical"] }]],
  ],
  [
    "a choice role on a scatter axis: the pair is kept",
    FREEFORM_ON_SX,
    [["sx", { declared: ["freeform", "pair"], kept: "pair", dropped: ["freeform"] }]],
  ],
  [
    "a choice role on a geographic axis: the pair is kept",
    CATEGORICAL_ON_LON,
    [["lon", { declared: ["categorical", "pair"], kept: "pair", dropped: ["categorical"] }]],
  ],
  [
    "two choice roles AND an axis: both roles go",
    (r: ColumnRoles) => {
      r.categorical = [...(r.categorical ?? []), { column: "sy", label: "sy" }];
      r.freeform = [...(r.freeform ?? []), { column: "sy", label: "sy" }];
    },
    [["sy", { declared: ["categorical", "freeform", "pair"], kept: "pair", dropped: ["categorical", "freeform"] }]],
  ],
  [
    "two columns come out in role-kind order, datetime before categorical — the order the refusal names them",
    (r: ColumnRoles) => {
      TAG_ON_GROUP(r);
      FREEFORM_ON_CAPTURED(r);
    },
    [
      ["captured", { declared: ["datetime", "freeform"], kept: "freeform", dropped: ["datetime"] }],
      ["group", { declared: ["categorical", "tag"], kept: "tag", dropped: ["categorical"] }],
    ],
  ],
  [
    "NOT flagged: a column shared by two pairs — the draft keeps both",
    SHARED_PAIR,
    [],
  ],
  [
    "NOT flagged: the reserved embedding role beside another — carried verbatim",
    EMBEDDING_ON_CAPTION,
    [],
  ],
] as const) {
  test(`held roles: ${name}`, () => {
    assert.deepEqual(held(golden(change as (r: ColumnRoles) => void)), expected);
  });
}

test("held roles: `kept` is read off the SEED, not re-derived from the assignment order", () => {
  const committed = golden(TAG_ON_GROUP);
  const seed = rolesDraftFromColumnRoles(committed);
  assert.equal(seed.choice.group, "tag", "precondition: the seed keeps tag");
  seed.choice.group = "categorical";
  assert.deepEqual(held(committed, seed), [["group", { declared: ["categorical", "tag"], kept: "categorical", dropped: ["tag"] }]]);
  seed.choice.group = "ignore";
  assert.deepEqual(held(committed, seed), [["group", { declared: ["categorical", "tag"], kept: "ignore", dropped: ["categorical", "tag"] }]]);
});

// --- why: the roles.ts behaviour the rule rests on, measured rather than taken on trust -----

test("why a FREEFORM role on a pair axis is flagged: the seed keeps both, nothing refuses it, and compiling drops the role without a word", () => {
  const committed = golden(FREEFORM_ON_SX);
  const seed = rolesDraftFromColumnRoles(committed);
  assert.equal(seed.choice.sx, "freeform", "the seed keeps the role...");
  assert.ok(seed.scatterPairs.some((p) => p.x === "sx"), "...and the pair");
  assert.equal(validateDraft(seed), null, "nothing refuses it");
  assert.equal((buildColumnRoles(seed).freeform ?? []).some((e) => e.column === "sx"), false, "buildColumnRoles drops it");
  assert.deepEqual(changedRoleColumns(committed, buildColumnRoles(seed)), ["sx"], "so any role commit loses it");
});

test("why a STORING role on a pair axis is flagged: validateDraft refuses the draft, so the only commit re-roles it away", () => {
  const seed = rolesDraftFromColumnRoles(golden(CATEGORICAL_ON_LON));
  assert.equal(seed.choice.lon, "categorical");
  assert.match(validateDraft(seed) ?? "", /"lon" is a geographic longitude and is also mapped as "categorical"/);
});

test("why a shared pair and an embedding beside another role are NOT flagged: both round-trip through the draft exactly", () => {
  for (const change of [SHARED_PAIR, EMBEDDING_ON_CAPTION]) {
    const committed = golden(change);
    assert.deepEqual(changedRoleColumns(committed, buildColumnRoles(rolesDraftFromColumnRoles(committed))), []);
  }
});
