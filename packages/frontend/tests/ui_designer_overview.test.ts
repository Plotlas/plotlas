// Seam L7 — the Layouts door's state summary (`src/ui/designer/Overview.ts`).
//
// The stale pill now has TWO sources: the durable bake record (`derived.baked`, manifest
// 2.10) and the open draft's prediction (`derived.outcomes`). They overlap by design — a
// layout already stale from a committed roles change is staled again by an edit to the
// same column — so the count is a UNION BY `layout_id`, never a sum.
//
// The manifest is `tests/designer_fixture/layout_manifest_2.10.json`, made by the real
// producer (see the README beside it).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LayoutInfo } from "../src/api-client/types.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import { layoutStateCounts } from "../src/ui/designer/Overview.ts";
import { derivePending, seedPending, withDraft } from "../src/ui/designer/pending.ts";

const MANIFEST = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./designer_fixture/layout_manifest_2.10.json", import.meta.url)),
    "utf8",
  ),
) as LayoutManifest & {
  layouts: (LayoutManifest["layouts"][number] & {
    source_columns?: string[];
    source_fingerprint?: Record<string, unknown[][]>;
  })[];
};

function layoutInfos(): LayoutInfo[] {
  return MANIFEST.layouts.map((l) => ({
    layout_id: l.layout_id,
    label: l.label,
    type: l.type,
    state: "live",
    rebake: null,
    committed_at: null,
    source_columns: l.source_columns ?? null,
    source_fingerprint: l.source_fingerprint ?? null,
  }));
}

/** The collection AFTER a roles-only commit that moved `captured`'s format and baked
 *  nothing (D-xxix). The datetime layout's bake record no longer matches the committed
 *  roles, so it is DURABLY stale with nothing pending. */
function committedAfterFormatChange() {
  return seedPending({
    ...MANIFEST.column_roles!,
    datetime: { column: "captured", label: "Captured", format: "unix_seconds" },
  });
}

test("a durably stale layout counts once, with nothing pending", () => {
  const derived = derivePending(committedAfterFormatChange(), layoutInfos());
  assert.deepEqual(
    derived.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id),
    ["datetime"],
    "premise: exactly one layout is durably stale",
  );
  assert.equal(derived.isPending, false, "premise: the bar prices nothing");
  assert.deepEqual(derived.outcomes, [], "premise: and the prediction claims nothing");
  // The pill still shows it: a count taken from `outcomes` alone would report 0 stale for
  // a collection whose datetime layout does not match its own declaration.
  assert.equal(layoutStateCounts(layoutInfos(), derived).stale, 1);
});

test("a durably stale layout and a newly staled one are counted TOGETHER", () => {
  // The two sources are DISJOINT since the 2026-09-24 round-2 review (N1): `outcomes`
  // reports only what the pending edit NEWLY stales, and a layout that was already stale
  // stays in `baked` alone. The union is therefore what makes the pill complete — a count
  // from either source alone under-reports — and it stays a `Set` rather than a sum
  // because that is the only form that is still correct if the two ever overlap again.
  const state = committedAfterFormatChange(); // datetime: durably stale, nothing pending
  const draft = JSON.parse(JSON.stringify(state.draft)) as RolesDraft;
  draft.choice.group = "freeform"; // ...and this edit stales a DIFFERENT layout
  const derived = derivePending(withDraft(state, draft), layoutInfos());

  assert.deepEqual(
    derived.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id),
    ["datetime"],
    "premise: one durably stale",
  );
  assert.deepEqual(
    derived.outcomes.filter((o) => o.stale).map((o) => o.layout_id),
    ["categorical_group"],
    "premise: and a different one newly staled",
  );
  assert.equal(layoutStateCounts(layoutInfos(), derived).stale, 2);
});

test("the pending prediction still counts on its own, on a layout with no durable flag", () => {
  // The pre-L7 behaviour, unchanged: a fresh collection with an open edit.
  const state = seedPending(MANIFEST.column_roles);
  const draft = JSON.parse(JSON.stringify(state.draft)) as RolesDraft;
  draft.datetimeFormat = "unix_seconds";
  const derived = derivePending(withDraft(state, draft), layoutInfos());
  assert.equal(derived.baked.every((b) => b.staleColumns.length === 0), true, "premise: nothing durable");
  assert.equal(layoutStateCounts(layoutInfos(), derived).stale, 1);
  // ...and the other counts are untouched by any of this.
  assert.deepEqual(layoutStateCounts(layoutInfos(), derived), {
    live: 6,
    baking: 0,
    queued: 0,
    stale: 1,
    rebaking: 0,
  });
});
