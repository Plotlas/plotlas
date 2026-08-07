// DOM tier — the inspector header's clear-selection control (T2-204). The control was
// moved out of SelectionSummary (which rendered only past 2 cells) so a SINGLE selection
// is clearable too; extracted into InspectorHeader so that deliverable is mountable in
// jsdom (ViewerScreen drives a WebGL renderer and can't produce a selection in a test).
// Pins: it renders for one selection, hides at zero, fires onClear, and — since the
// button unmounts the instant the selection empties — moves focus to the collapse toggle
// rather than dropping it to <body>.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { InspectorHeader } from "../../src/ui/InspectorHeader.ts";

afterEach(cleanup);

const clearButton = (): HTMLElement | null => screen.queryByRole("button", { name: "Clear selection" });

test("Clear renders for a SINGLE selection (T2-204 — not just a multi-select)", () => {
  render(h(InspectorHeader, { selectionCount: 1, onClear: () => {}, onCollapse: () => {} }));
  assert.ok(clearButton(), "Clear is present with one cell selected");
});

test("Clear is hidden when nothing is selected", () => {
  render(h(InspectorHeader, { selectionCount: 0, onClear: () => {}, onCollapse: () => {} }));
  assert.equal(clearButton(), null, "no Clear control with an empty selection");
});

test("activating Clear fires onClear", () => {
  let cleared = 0;
  render(h(InspectorHeader, { selectionCount: 3, onClear: () => (cleared += 1), onCollapse: () => {} }));
  fireEvent.click(clearButton() as HTMLElement);
  assert.equal(cleared, 1);
});

test("activating Clear moves focus to the collapse toggle (no focus drop to <body>) (T2-204 a11y)", () => {
  render(h(InspectorHeader, { selectionCount: 1, onClear: () => {}, onCollapse: () => {} }));
  fireEvent.click(clearButton() as HTMLElement);
  assert.equal(
    document.activeElement,
    screen.getByRole("button", { name: "Collapse inspector" }),
    "focus landed on the always-present collapse toggle, not <body>",
  );
});
