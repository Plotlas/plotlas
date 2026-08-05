// DOM tier (D-35 Seam G3 / T2-125) — the knob PICKERS' interaction contract, which the
// pure renderToString smokes cannot see (they render markup; they never fire onChange).
//
// The invariant under test is the one the seam turns on: a knob left at — or RESET to — its
// family default must serialize NO explicit value, so the manifest options-echo emission
// stays intact (a scatter layout emits `options` only when a knob is non-default; a
// geographic layout always emits its real projection) and a wizard re-POST never invents a
// value ingest would then bake. That logic lives in the picker's onChange
// (`value === dflt ? undefined : value`), so only a DOM test reaches it.
//
// Also covers the two states the PIPELINE rejects: the Axis-scale knob writes BOTH axes in
// one patch (ingest refuses a mixed pair), and the log/pass-through conflict renders as a
// disabled option with a reason instead of a submittable trap.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RoleAssignmentForm } from "../../src/ui/admin/RoleAssignmentForm.ts";
import { buildColumnRoles, emptyDraft } from "../../src/ui/admin/roles.ts";
import type { RolesDraft } from "../../src/ui/admin/roles.ts";

afterEach(cleanup);

/** The form is controlled, so the test needs a real state owner to see successive edits. */
function mount(initial: RolesDraft): { latest: () => RolesDraft } {
  let latest = initial;
  function Harness(): ReactElement {
    const [draft, setDraft] = useState(initial);
    return h(RoleAssignmentForm, {
      draft,
      onChange: (d: RolesDraft) => {
        latest = d;
        setDraft(d);
      },
    });
  }
  render(h(Harness, null));
  return { latest: () => latest };
}

function scatterDraft(): RolesDraft {
  const draft = emptyDraft(["filename", "sx", "sy"]);
  draft.scatterPairs = [{ x: "sx", y: "sy", label: "S" }];
  return draft;
}

function pick(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

test("the Axis-scale knob writes BOTH axes (the pipeline rejects a mixed pair)", () => {
  const { latest } = mount(scatterDraft());
  pick("Scatter pair 1 axis scale", "log");

  const pair = latest().scatterPairs[0];
  assert.equal(pair.x_scale, "log");
  assert.equal(pair.y_scale, "log", "one knob must move both axes, never just X");
  assert.deepEqual(buildColumnRoles(latest()).scatter?.[0].x_scale, "log");
  assert.deepEqual(buildColumnRoles(latest()).scatter?.[0].y_scale, "log");
});

test("resetting a knob to its default serializes NO explicit value (the options-echo invariant)", () => {
  const { latest } = mount(scatterDraft());
  // Declare, then put it back — the round trip must leave the roles bare, not carry an
  // explicit "linear" that would flip the manifest into emitting an `options` echo.
  pick("Scatter pair 1 axis scale", "log");
  pick("Scatter pair 1 axis scale", "linear");

  const emitted = buildColumnRoles(latest()).scatter?.[0] ?? {};
  assert.ok(!("x_scale" in emitted), "a reset knob emitted an explicit x_scale");
  assert.ok(!("y_scale" in emitted), "a reset knob emitted an explicit y_scale");

  // Same for the other scatter knobs.
  pick("Scatter pair 1 placement", "none");
  pick("Scatter pair 1 placement", "fit");
  assert.ok(!("normalize" in (buildColumnRoles(latest()).scatter?.[0] ?? {})));
});

test("the log / pass-through conflict is disabled with a reason, not submittable", () => {
  const { latest } = mount(scatterDraft());

  // Choosing pass-through locks the log scale...
  pick("Scatter pair 1 placement", "none");
  const scaleOptions = screen.getByLabelText("Scatter pair 1 axis scale").querySelectorAll("option");
  const logOption = [...scaleOptions].find((o) => o.getAttribute("value") === "log");
  assert.ok(logOption?.hasAttribute("disabled"), "log stayed selectable under pass-through");
  assert.match(logOption?.textContent ?? "", /unavailable/);
  // ...and the reason is spelled out, not just greyed.
  assert.match(document.body.textContent ?? "", /apply any log scaling upstream/);

  // ...and symmetrically, a log scale locks pass-through.
  pick("Scatter pair 1 placement", "fit");
  pick("Scatter pair 1 axis scale", "log");
  const placementOptions = screen.getByLabelText("Scatter pair 1 placement").querySelectorAll("option");
  const noneOption = [...placementOptions].find((o) => o.getAttribute("value") === "none");
  assert.ok(noneOption?.hasAttribute("disabled"), "pass-through stayed selectable under a log scale");

  // Whatever the user did, the draft never reached a state the pipeline would reject.
  assert.equal(buildColumnRoles(latest()).scatter?.[0].normalize, undefined);
});

test("the reserved overlap modes stay disabled (D-35 G4 lands them, not this seam)", () => {
  mount(scatterDraft());
  const options = screen.getByLabelText("Scatter pair 1 overlap").querySelectorAll("option");
  const byValue = Object.fromEntries([...options].map((o) => [o.getAttribute("value"), o]));
  assert.ok(!byValue.overdraw.hasAttribute("disabled"));
  assert.ok(byValue.jitter.hasAttribute("disabled"));
  assert.ok(byValue.aggregate.hasAttribute("disabled"));
  assert.match(byValue.jitter.textContent ?? "", /coming soon/);
});

test("the geographic projection knob declares a non-default and clears back to absent", () => {
  const draft = emptyDraft(["filename", "lon", "lat"]);
  draft.geoPairs = [{ lon: "lon", lat: "lat", label: "Where" }];
  const { latest } = mount(draft);

  pick("Geographic pair 1 projection", "mercator");
  assert.equal(latest().geoPairs[0].projection, "mercator");
  assert.equal(buildColumnRoles(latest()).geographic?.[0].projection, "mercator");

  // Back to the family default ⇒ absent again: the pipeline then bakes (and echoes) its own
  // default, which is the same value — but the ROLES must not assert it.
  pick("Geographic pair 1 projection", "equirectangular");
  const emitted = buildColumnRoles(latest()).geographic?.[0] ?? {};
  assert.ok(!("projection" in emitted), "a reset projection emitted an explicit value");

  // Geographic has no scale knobs at all (degrees are degrees — D-35).
  assert.equal(screen.queryByLabelText("Geographic pair 1 axis scale"), null);
});
