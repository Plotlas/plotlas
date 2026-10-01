// DOM tier — Seam R1 P3: the user is offered the action that MATCHES the failure.
//
// Taken from the abandoned #274 branch (plan step 7) and rewritten against
// `renderer/health.ts`: #274's version drove the panel from `renderer/resilience.ts`,
// which does not exist on `main` and is not being rebuilt (brief §6). Its
// "Copy diagnostics" pin went with it — the payload it asserted was the withdrawn
// scheduler's queue/lane/cache counters.
//
// The pin is that each failure renders ITS OWN action and NO other. One field of the
// failure — its `code` — decides both the wording and the button, through
// `recoveryAction`; the previous attempt keyed blockedness off one field and the button
// off another with nothing enforcing that the two agree.
//
// `queryByRole(...) === null` is compared as a BOOLEAN, never as a node: passing a live
// node to assert.equal makes util.inspect walk the whole tree, and a test that hangs at
// 90s is indistinguishable from one that passed.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RendererRecoveryPanel } from "../../src/ui/RendererRecoveryPanel.ts";
import type { RendererFailureCode, RendererHealth } from "../../src/renderer/health.ts";

afterEach(cleanup);

interface Clicks {
  view: number;
  renderer: number;
  reload: number;
}

function show(health: RendererHealth): Clicks {
  const clicks: Clicks = { view: 0, renderer: 0, reload: 0 };
  render(
    h(RendererRecoveryPanel, {
      health,
      onRetryView: () => {
        clicks.view += 1;
      },
      onRetryRenderer: () => {
        clicks.renderer += 1;
      },
      onReloadPage: () => {
        clicks.reload += 1;
      },
    }),
  );
  return clicks;
}

function failed(code: RendererFailureCode, layoutId: string | null = null): RendererHealth {
  return { kind: "failed", failure: { code, layoutId, detail: null } };
}

/** Which of the three actions this render offers, by button name. */
function offered(): string[] {
  return ["Retry this view", "Retry renderer", "Reload page"].filter(
    (name) => screen.queryByRole("button", { name }) !== null,
  );
}

test("a layout-scoped failure offers Retry this view, and only that", () => {
  const clicks = show(failed("layout-assets-failed", "datetime"));
  assert.deepEqual(offered(), ["Retry this view"]);
  fireEvent.click(screen.getByRole("button", { name: "Retry this view" }));
  assert.deepEqual(clicks, { view: 1, renderer: 0, reload: 0 });
  // It says the VIEW failed — not that rendering stopped, which is what would send a
  // user with a perfectly healthy stack off to reload the page.
  assert.match(screen.getByRole("alert").textContent ?? "", /this view/i);
});

test("a render-loop failure offers Retry renderer, and only that", () => {
  const clicks = show(failed("render-loop-failed"));
  assert.deepEqual(offered(), ["Retry renderer"]);
  fireEvent.click(screen.getByRole("button", { name: "Retry renderer" }));
  assert.deepEqual(clicks, { view: 0, renderer: 1, reload: 0 });
});

test("an unrecoverable failure offers Reload page, and only that", () => {
  const clicks = show(failed("context-unrecoverable"));
  assert.deepEqual(offered(), ["Reload page"]);
  fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
  assert.deepEqual(clicks, { view: 0, renderer: 0, reload: 1 });
  // e2e/contextloss.spec.ts's watchdog test waits for role="alert" to contain
  // /reload the page/i — the wording `main` ships today. It is a CLAMP: this seam moved
  // where that text is produced, and it must still say the same thing.
  assert.match(screen.getByRole("alert").textContent ?? "", /reload the page/i);
});

test("a missing WebGL 2 says so, rather than that rendering was interrupted", () => {
  show(failed("webgl2-unavailable"));
  const text = screen.getByRole("alert").textContent ?? "";
  assert.match(text, /WebGL 2/);
  assert.deepEqual(offered(), ["Reload page"]);
});

test("a lost context is a non-blocking status, not an alert", () => {
  show({ kind: "context-lost" });
  assert.match(screen.getByRole("status").textContent ?? "", /recover/i);
  assert.equal(screen.queryByRole("alert") === null, true, "an in-progress recovery raised an alert");
  assert.deepEqual(offered(), [], "an in-progress recovery offered a recovery action");
});

test("a healthy renderer draws nothing at all", () => {
  for (const health of [{ kind: "starting" } as const, { kind: "ready" } as const]) {
    cleanup();
    show(health);
    assert.equal(screen.queryByRole("alert") === null, true, `${health.kind} rendered an alert`);
    assert.equal(screen.queryByRole("status") === null, true, `${health.kind} rendered a status`);
  }
});

test("the underlying error text survives onto the panel", () => {
  render(
    h(RendererRecoveryPanel, {
      health: {
        kind: "failed",
        failure: { code: "layout-assets-failed", layoutId: "grid", detail: "pyramid header 404" },
      },
      onRetryView: () => {},
      onRetryRenderer: () => {},
      onReloadPage: () => {},
    }),
  );
  // The generic banner this panel replaces rendered errText(err) verbatim; losing it
  // would make every renderer failure less diagnosable than the string it replaced.
  assert.match(screen.getByRole("alert").textContent ?? "", /pyramid header 404/);
});
