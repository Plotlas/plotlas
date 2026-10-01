// What `derivePending` hands seam L4 (#384), pinned across #385's re-bake guard.
//
// L4's Data view renders `derived.outcomes`, `derived.baked`, `derived.tags` and — through
// `queuedOn` — the label and problem of each queued NEW bake in `derived.bakes`. #385 changes
// ONE rule in pending.ts — which roles a queued bake is named from when nothing is edited
// (`bakeNamingDraft`) — and must leave everything else it derives byte-identical. The golden
// file beside this test (ui_designer_pending_outputs.golden.json) was written by pending.ts
// BEFORE that change, in the commit that added this test; the test holds the code after it
// to that record, and lists the one difference it allows (`NOW_RESOLVES`).
//
// The bar's count-it-once change (operator, 2026-09-28) is held to the same record the same
// way: it changes ONE field, `invalidating`, and only where a pair entry changed. The second
// list (`NOW_COUNTS`) is every value it moves, derived by hand from each state's edit, and
// every other field — `outcomes`, `baked`, `tags`, `roles`, `changedColumns`, `isPending` —
// must still match the record byte for byte.
//
// THE STATES are the fixtures L4's tests read (packages/frontend/tests/ui_designer_data.test.ts
// and tests/dom/designer_data.dom.test.ts on #384), untouched and edited, plus L5's two-role
// collections. Every state queues a re-bake of each committed layout, so the rule that
// changed runs in every one of them. No state queues a NEW bake, so what the change did to
// new bakes is not held here: [[T2-the-pending-outputs-golden-never-queues-a-new]].
//
// Regenerate (only when a change to these outputs is intended, and say so in its commit):
//   UPDATE_GOLDEN=1 node --import ./tests/dom/ts-extension-resolver.mjs --test \
//     --experimental-strip-types tests/ui_designer_pending_outputs.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LayoutInfo } from "../src/api-client/types.ts";
import type { ColumnRoles } from "../src/generated/column_roles.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import { addBake, derivePending, seedPending, withDraft } from "../src/ui/designer/pending.ts";
import type { PendingState } from "../src/ui/designer/pending.ts";

interface FixtureManifest {
  column_roles?: ColumnRoles;
  layouts: { layout_id: string; label: string; type: string; source_columns?: string[]; source_fingerprint?: Record<string, unknown[][]> }[];
}

function read(url: URL): FixtureManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as FixtureManifest;
}

const M210 = read(new URL("./designer_fixture/layout_manifest_2.10.json", import.meta.url));
const M29 = read(new URL("./designer_fixture/layout_manifest_2.9.json", import.meta.url));
const M28 = read(new URL("../../../tests/fixtures/golden_dataset_full_v2/layout_manifest.json", import.meta.url));
const IMAGES_ONLY = read(new URL("../../../tests/fixtures/golden_dataset_images_only_v2/layout_manifest.json", import.meta.url));
const R210 = M210.column_roles as ColumnRoles;

function infos(manifest: FixtureManifest): LayoutInfo[] {
  return manifest.layouts.map((l) => ({
    layout_id: l.layout_id,
    label: l.label,
    type: l.type,
    state: "live",
    rebake: null,
    committed_at: null,
    source_columns: l.source_columns ?? null,
    source_fingerprint: l.source_fingerprint ?? null,
    options: null,
  }));
}

const EXTRA = Array.from({ length: 24 }, (_, i) => `extra_${String(i + 1).padStart(2, "0")}`);
const ROLES: Record<string, ColumnRoles> = {
  formatMoved: { ...R210, datetime: { ...R210.datetime!, format: "unix_seconds" } },
  wide: { ...R210, freeform: [...(R210.freeform ?? []), ...EXTRA.map((c) => ({ column: c, label: c }))] },
  untagged: { ...R210, tag: undefined, freeform: [...(R210.freeform ?? []), { column: "tags", label: "Tags" }] },
  twoTags: { ...R210, tag: [...(R210.tag ?? []), { column: "keywords", label: "Keywords", delimiter: "|" }] },
  modified: { ...R210, freeform: [...(R210.freeform ?? []), { column: "modified", label: "Modified" }] },
  twoRoles: {
    ...R210,
    tag: [...(R210.tag ?? []), { column: "group", label: "Group tags", delimiter: "|" }],
    freeform: [...(R210.freeform ?? []), { column: "captured", label: "Captured" }],
  },
  tagOnGroup: { ...R210, tag: [...(R210.tag ?? []), { column: "group", label: "Group", delimiter: "|" }] },
  freeformOnCaptured: { ...R210, freeform: [...(R210.freeform ?? []), { column: "captured", label: "Captured" }] },
  shared: { ...R210, scatter: [...(R210.scatter ?? []), { x_column: "sx", y_column: "lon", label: "Second" }] },
  onAxis: { ...R210, scatter: [...(R210.scatter ?? []), { x_column: "sx", y_column: "caption", label: "Second" }] },
};

type Change = (d: RolesDraft) => void;
const choice = (column: string, to: string): Change => (d) => {
  (d.choice as Record<string, string>)[column] = to;
};

/** name → [committed roles, layouts, the draft edit (none = untouched)]. */
const STATES: Record<string, [ColumnRoles | undefined, FixtureManifest, Change | null]> = {
  m210: [R210, M210, null],
  m29: [M29.column_roles, M29, null],
  m28: [M28.column_roles, M28, null],
  imagesOnly: [IMAGES_ONLY.column_roles, IMAGES_ONLY, null],
  ...Object.fromEntries(Object.entries(ROLES).map(([name, roles]) => [name, [roles, M210, null]])),
  freeformOnCapturedMoved: [{ ...ROLES.formatMoved, freeform: ROLES.freeformOnCaptured.freeform }, M210, null],
  "m210+newPair": [R210, M210, (d) => void d.scatterPairs.push({ x: "lon", y: "lat", label: "" })],
  "m210+format": [R210, M210, (d) => void (d.datetimeFormat = "unix_seconds")],
  "m210+bucketFreeform": [R210, M210, choice("bucket", "freeform")],
  "m210+tagsFreeform": [R210, M210, choice("tags", "freeform")],
  "m210+delimiter": [R210, M210, (d) => void (d.tagDelimiters.tags = ";")],
  "m210+logAndSecondPair": [
    R210,
    M210,
    (d) => {
      d.scatterPairs[0] = { ...d.scatterPairs[0], x_scale: "log", y_scale: "log" };
      d.scatterPairs.push({ x: "lon", y: "lat", label: "" });
    },
  ],
  "formatMoved+mercator": [ROLES.formatMoved, M210, (d) => void (d.geoPairs[0].projection = "mercator")],
  "formatMoved+iso": [ROLES.formatMoved, M210, (d) => void (d.datetimeFormat = "iso8601")],
  "m28+captionIgnore": [M28.column_roles, M28, choice("caption", "ignore")],
  "m28+groupFreeform": [M28.column_roles, M28, choice("group", "freeform")],
  "untagged+tagsTag": [ROLES.untagged, M210, choice("tags", "tag")],
  "twoTags+tagsFreeform": [ROLES.twoTags, M210, choice("tags", "freeform")],
  "modified+capturedFreeform": [ROLES.modified, M210, choice("captured", "freeform")],
  "twoRoles+format": [ROLES.twoRoles, M210, (d) => void (d.datetimeFormat = "unix_seconds")],
};

function state(roles: ColumnRoles | undefined, manifest: FixtureManifest, change: Change | null): PendingState {
  const seeded = seedPending(roles);
  let s = seeded;
  if (change !== null && seeded.draft !== null) {
    const draft = JSON.parse(JSON.stringify(seeded.draft)) as RolesDraft;
    change(draft);
    s = withDraft(seeded, draft);
  }
  return manifest.layouts.reduce((acc, l) => addBake(acc, { kind: "rebake", layout_id: l.layout_id }), s);
}

/** Everything derivePending returns, the resolved bakes reduced to what a view reads. */
function outputs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, [roles, manifest, change]] of Object.entries(STATES)) {
    const { bakes, ...rest } = derivePending(state(roles, manifest, change), infos(manifest));
    out[name] = { ...rest, bakes: bakes.map((b) => ({ key: b.key, layout_id: b.layout_id, label: b.label, problem: b.problem })) };
  }
  return out;
}

const GOLDEN = new URL("./ui_designer_pending_outputs.golden.json", import.meta.url);

/** What the re-bake guard changes, and ALL it changes: with nothing edited on a collection
 *  whose seed dropped a column's second role, a re-bake of a layout on that column resolves
 *  to its own id instead of "the new roles no longer produce it". `onAxis` and `shared` are
 *  NOT here: their committed roles really do rename `scatter` (a second pair), and a re-bake
 *  of it is still refused. (A regenerated golden records these already: empty this then.) */
const NOW_RESOLVES: Record<string, string[]> = {
  twoRoles: ["datetime", "categorical_group", "categorical_bucket"],
  tagOnGroup: ["categorical_group", "categorical_bucket"],
  freeformOnCaptured: ["datetime"],
  freeformOnCapturedMoved: ["datetime"],
};

/** What counting role changes by the unit the owner edits, not by column, changes, and ALL
 *  it changes: the states whose edit touches a pair entry. Each value is that edit's count by
 *  hand, from the rule in pending.ts `roleChangeCount`; the record's per-column count is
 *  beside it. Every other state's edit is one column's own role, or two columns the draft
 *  cannot hold (`twoRoles+format`), so its count does not move. */
const NOW_COUNTS: Record<string, number> = {
  "m210+newPair": 1, // was 2 (lat, lon): one scatter entry arrived
  "m210+logAndSecondPair": 2, // was 4 (lat, lon, sx, sy): Scatter's scale changed, and a pair arrived
  "formatMoved+mercator": 1, // was 2 (lat, lon): Location's projection changed
};

type Bake = { key: string; layout_id: string | null; label: string; problem: string | null };

test("derivePending's outputs for L4's fixtures match the record pending.ts wrote before #385's re-bake guard", () => {
  const now = outputs() as Record<string, Record<string, unknown>>;
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(fileURLToPath(GOLDEN), JSON.stringify(now, null, 1) + "\n");
    return;
  }
  const before = JSON.parse(readFileSync(fileURLToPath(GOLDEN), "utf8")) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(now), Object.keys(before), "the same states");
  for (const [name, count] of Object.entries(NOW_COUNTS)) {
    assert.ok(name in before, `${name}: a listed state is a state`);
    assert.notEqual(before[name].invalidating, count, `${name}: a listed count is one the record does not already hold`);
  }
  for (const [name, then] of Object.entries(before)) {
    const { bakes: nowBakes, ...nowRest } = now[name];
    const { bakes: thenBakes, ...thenRest } = then;
    // `outcomes`, `baked` and `tags` — what L4 renders — and every other field but `bakes`,
    // with only the counts `NOW_COUNTS` lists moved (the key keeps its place in the record).
    const counted = name in NOW_COUNTS ? { ...thenRest, invalidating: NOW_COUNTS[name] } : thenRest;
    assert.equal(JSON.stringify(nowRest), JSON.stringify(counted), `${name}: everything but the bakes and the listed count is byte-identical`);
    const resolves = NOW_RESOLVES[name] ?? [];
    const expected = (thenBakes as Bake[]).map((b) => {
      const id = b.key.slice("rebake:".length);
      return resolves.includes(id) ? { ...b, layout_id: id, problem: null } : b;
    });
    assert.equal(JSON.stringify(nowBakes), JSON.stringify(expected), `${name}: the bakes changed exactly as listed`);
  }
});
