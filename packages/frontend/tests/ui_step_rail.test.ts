// Tier-1 (Phase C, brief §3.3): the wizard step rail is a pure VIEW over the
// existing phase — stepStates maps (phase, hasMetadata, formStage, jobTerminal)
// to each step's state, with no new state machine. StepRail's markup is smoked
// too (done → ✓ / active → aria-current).
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { StepRail, stepStates } from "../src/ui/admin/stepRail.ts";

test("form + source: source active, roles skipped (images-only), progress pending", () => {
  assert.deepEqual(
    stepStates({ phase: "form", hasMetadata: false, formStage: "source", jobTerminal: false }),
    { source: "active", roles: "skipped", progress: "pending" },
  );
});

test("form + source WITH metadata: roles pending (a real step), not skipped", () => {
  assert.deepEqual(
    stepStates({ phase: "form", hasMetadata: true, formStage: "source", jobTerminal: false }),
    { source: "active", roles: "pending", progress: "pending" },
  );
});

test("form + roles: source done, roles active, progress pending", () => {
  assert.deepEqual(
    stepStates({ phase: "form", hasMetadata: true, formStage: "roles", jobTerminal: false }),
    { source: "done", roles: "active", progress: "pending" },
  );
});

test("uploading: source+roles behind us; progress active (roles skipped when images-only)", () => {
  assert.deepEqual(
    stepStates({ phase: "uploading", hasMetadata: false, formStage: "source", jobTerminal: false }),
    { source: "done", roles: "skipped", progress: "active" },
  );
  assert.deepEqual(
    stepStates({ phase: "uploading", hasMetadata: true, formStage: "roles", jobTerminal: false }),
    { source: "done", roles: "done", progress: "active" },
  );
});

test("polling → terminal: progress flips done", () => {
  assert.deepEqual(
    stepStates({ phase: "polling", hasMetadata: true, formStage: "roles", jobTerminal: false }),
    { source: "done", roles: "done", progress: "active" },
  );
  assert.deepEqual(
    stepStates({ phase: "polling", hasMetadata: true, formStage: "roles", jobTerminal: true }),
    { source: "done", roles: "done", progress: "done" },
  );
});

test("StepRail markup: check circle for done, aria-current for active, all three labels", () => {
  const html = renderToString(
    h(StepRail, {
      states: stepStates({ phase: "form", hasMetadata: true, formStage: "roles", jobTerminal: false }),
    }),
  );
  assert.match(html, /Source/);
  assert.match(html, /Map roles/);
  assert.match(html, /Progress/);
  assert.match(html, /step-done/);
  assert.match(html, /✓/); // done marker
  assert.match(html, /aria-current="step"/); // the active step
});