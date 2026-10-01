// DOM tier — the RoleAssignmentForm "render as link" toggle (schema v2.8). Two interactive
// handlers that no other test exercises: `setUrl` (the checkbox adds/removes a column from
// draft.url) and `setChoice` (moving a column OFF a linkable role drops its stale link flag so
// it cannot strand an unrenderable `url` that validateDraft would then block submit on).
// ui_roles.test.ts mutates draft.url directly and ui_components.test.ts uses static
// renderToString, so the click paths themselves are untested without this.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { RoleAssignmentForm } from "../../src/ui/admin/RoleAssignmentForm.ts";
import { emptyDraft, type RolesDraft } from "../../src/ui/admin/roles.ts";

afterEach(cleanup);

/** A draft with `homepage` mapped Freeform (a linkable, shown-scalar role). */
function freeformDraft(): RolesDraft {
  const draft = emptyDraft(["filename", "homepage"]);
  draft.choice.filename = "filename";
  draft.choice.homepage = "freeform";
  return draft;
}

test("ticking 'render as link' adds the column to draft.url", () => {
  let latest: RolesDraft | null = null;
  render(h(RoleAssignmentForm, { draft: freeformDraft(), onChange: (d) => { latest = d; } }));
  fireEvent.click(screen.getByLabelText("Render column homepage as a link"));
  assert.deepEqual(latest?.url, ["homepage"]);
});

test("unticking 'render as link' removes the column again", () => {
  const draft = freeformDraft();
  draft.url = ["homepage"];
  let latest: RolesDraft | null = null;
  render(h(RoleAssignmentForm, { draft, onChange: (d) => { latest = d; } }));
  fireEvent.click(screen.getByLabelText("Render column homepage as a link"));
  assert.deepEqual(latest?.url, []);
});

test("moving a linked column to a non-linkable role drops its link flag", () => {
  // The regression this guards: without setChoice dropping the flag, the checkbox unmounts
  // (only shown for freeform/categorical) yet draft.url still names the column, so validateDraft
  // blocks submit on a flag the user can no longer see to uncheck.
  const draft = freeformDraft();
  draft.url = ["homepage"];
  let latest: RolesDraft | null = null;
  render(h(RoleAssignmentForm, { draft, onChange: (d) => { latest = d; } }));
  fireEvent.change(screen.getByLabelText("Role for column homepage"), {
    target: { value: "datetime" },
  });
  assert.equal(latest?.choice.homepage, "datetime");
  assert.deepEqual(latest?.url, []);
});

test("the intake wizard sends the toggle as PRESENTATION, never inside column_roles", () => {
  // D-xvii. The full create flow (select → upload → finalize → createDataset) is driven
  // in upload_wizard_honesty.dom.test.ts and needs a whole sealed bundle to reach the
  // payload, so the ROUTING is pinned by reading the source instead — the same instrument
  // ViewerScreen's layout-tap pin uses. Without it, the toggle above is collected into a
  // draft nothing transmits, which is exactly how #251 shipped a dead feature.
  const src = readFileSync(new URL("../../src/ui/admin/CreateDatasetWizard.ts", import.meta.url), "utf8");
  assert.equal(src.split("presentation: csvFile !== null && draft !== null ? buildPresentation(draft) : undefined").length - 1, 1);
  assert.equal(src.includes("draft.url"), false, "the wizard never reaches into the draft's url list itself");
});

test("the wizard tells the user this one is not frozen at bake time", () => {
  // The operator's framing, in the UI: deciding a column is a URL "only needs the CSV to
  // exist". Every OTHER control on this form is a bake input, which teaches the user that
  // this one is too — so the difference has to be said, not implied.
  render(h(RoleAssignmentForm, { draft: freeformDraft(), onChange: () => {} }));
  const label = screen.getByLabelText("Render column homepage as a link").closest("label");
  assert.match(label?.getAttribute("title") ?? "", /without re-baking/);
});
