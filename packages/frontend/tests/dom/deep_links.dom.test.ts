// Deep links to a collection — the ViewerScreen ↔ App failure-path seam
// (SCOPE_shareable-collections.md Part A; §7 DoD: "a test that only covers the happy path
// does not close A").
//
// The PURE routing decisions (routeForUnavailable, pushUrlForView, viewFromSearch /
// searchFromView) are pinned in ../url_state.test.ts. This file pins the one INTEGRATION
// a node test can drive: ViewerScreen's boot load, on a 404, hands the dataset back to App
// via `onUnavailable` — and ONLY on a 404 (every other status keeps the in-viewer banner,
// and a mount with no `onUnavailable` consumer is unaffected). App itself (setView history
// writes, popstate, the continue-through) is the vite composition root and is not
// importable here — that residual is tracked as backlog T2-197.
//
// ViewerScreen DOES mount in jsdom (see viewer_panels.dom.test.ts): getContext→null makes
// THREE fail cleanly, so the shell renders and the boot effect's `.catch` runs — which is
// exactly the path under test. Here the boot rejects even earlier, at the first awaited
// call (listLayouts), so the renderer stack is never reached.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";

import { ViewerScreen } from "../../src/ui/ViewerScreen.ts";
import type { ApiClient } from "../../src/api-client/client.ts";

const realGetContext = HTMLCanvasElement.prototype.getContext;
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof realGetContext;
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
  cleanup();
});

/** An error shaped like the client's ApiError — errStatus reads a numeric `.status`. */
function apiError(status: number): Error {
  return Object.assign(new Error(`API error ${status}: boom`), { status });
}

/** A client whose dataset-existence probe (listLayouts) rejects with `status`. The boot
 *  awaits listLayouts first, so this is the branch that decides onUnavailable-vs-banner. */
function failingClient(status: number): ApiClient {
  return {
    async listLayouts(): Promise<never> {
      throw apiError(status);
    },
    // Boot reads the presentation record alongside the layout list (D-iv). The real
    // client never rejects here, so a stub must not either — this is the "no record"
    // answer, which is every collection committed before 2026-09-07.
    async getPresentation() {
      return {};
    },
    async getManifest(): Promise<never> {
      throw apiError(status);
    },
    async search() {
      return { query: "", hits: [], capped: false };
    },
    authHeaders() {
      return {};
    },
  } as unknown as ApiClient;
}

interface Handlers {
  onUnavailable?: (id: string) => void;
  onAuthExpired?: () => void;
}

function mountFailing(status: number, handlers: Handlers = {}): void {
  render(
    h(ViewerScreen, {
      datasetId: "rijks_pilot",
      client: failingClient(status),
      onBack: () => {},
      onAuthExpired: handlers.onAuthExpired ?? ((): void => {}),
      onUnavailable: handlers.onUnavailable,
    }),
  );
}

const alertShown = (): boolean => document.querySelector('[role="alert"]') !== null;

test("a 404 on boot hands the dataset back to App via onUnavailable", async () => {
  let unavailable: string | null = null;
  mountFailing(404, { onUnavailable: (id) => (unavailable = id) });
  await waitFor(() => assert.equal(unavailable, "rijks_pilot"));
});

test("a 404 does NOT route through onAuthExpired — it is not an expiry", async () => {
  let unavailable: string | null = null;
  let expired = false;
  mountFailing(404, {
    onUnavailable: (id) => (unavailable = id),
    onAuthExpired: () => (expired = true),
  });
  await waitFor(() => assert.equal(unavailable, "rijks_pilot"));
  assert.equal(expired, false);
});

test("a non-404 (500) keeps the in-viewer banner — onUnavailable is NOT called", async () => {
  let unavailable: string | null = null;
  mountFailing(500, { onUnavailable: (id) => (unavailable = id) });
  // The 500 surfaces as the in-viewer error banner (role="alert"); the bounce must not fire.
  await waitFor(() => assert.ok(alertShown()), { timeout: 2000 });
  assert.equal(unavailable, null);
});

test("a 404 with no onUnavailable consumer falls back to the in-viewer banner", async () => {
  // Existing mounts (and older DOM tests) pass no onUnavailable — they must be unaffected:
  // the 404 then takes the ordinary surface() path, not a crash.
  mountFailing(404, {});
  await waitFor(() => assert.ok(alertShown()), { timeout: 2000 });
});
