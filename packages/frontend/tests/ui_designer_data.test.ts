// Node tier — the Data view's pure model (seam L4, `ui/designer/dataModel.ts`).
//
// Only what the DOM tier cannot reach deterministically lives here. The manifest is
// tests/designer_fixture/layout_manifest_2.10.json, written by the real producer and only
// READ here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ColumnRoles } from "../src/generated/column_roles.ts";
import type { LayoutInfo } from "../src/api-client/types.ts";
import type { RolesDraft } from "../src/ui/admin/roles.ts";
import { rowConsequences } from "../src/ui/designer/dataModel.ts";
import { derivePending, seedPending, withDraft } from "../src/ui/designer/pending.ts";

const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("./designer_fixture/layout_manifest_2.10.json", import.meta.url)), "utf8"),
) as { column_roles: ColumnRoles; layouts: (LayoutInfo & { source_fingerprint?: Record<string, unknown[][]> })[] };

const LAYOUTS: LayoutInfo[] = MANIFEST.layouts.map((l) => ({
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

test("a committed tag column is never told it needs a bake, even when the model lists it", () => {
  // `derived.tags.unservedColumns` also names a committed tag column whose DELIMITER moved in
  // the draft. That column is served, split the way ingest split it, and no commit or bake
  // re-splits it (review of #384, F3) — so "needs a bake" would be false. The Data view no
  // longer lets a delimiter move (second review, #3) and makes an older build's saved draft
  // follow the committed one (round 4, #4), so this state is reachable only as that saved
  // draft before it is corrected, or from another writer — hence a pure pin.
  const seeded = seedPending(MANIFEST.column_roles);
  const draft = JSON.parse(JSON.stringify(seeded.draft)) as RolesDraft;
  draft.tagDelimiters.tags = ";";
  const derived = derivePending(withDraft(seeded, draft), LAYOUTS);
  assert.deepEqual(derived.tags.unservedColumns, ["tags"], "precondition: the model lists it");
  const lines = rowConsequences({
    row: { kind: "column", column: "tags", choice: "tag", group: "assigned" },
    layouts: LAYOUTS,
    derived,
    committed: MANIFEST.column_roles,
    draft,
    conflict: undefined,
  });
  assert.deepEqual(
    lines.map((l) => l.kind),
    [],
  );
});
