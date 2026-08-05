// DOM tier — anonymous public entry (D-34 consumer): the login-less demo front door.
// A visitor with NO account lands on the READ-ONLY public library (no login wall) and
// browses; the auth screen is reachable but off to the side. These tests pin the four
// behaviours the brief calls for at the component level (App.tsx itself is the vite
// composition root — it mounts the WebGL ViewerScreen and is never imported by the node
// runner, so the matrix is exercised over AdminScreen + AuthPanel, its two switchable
// leaves, exactly as the existing admin_screen.dom test does):
//   1. anonymous lands on the library (read-only), NOT a wall;
//   2. the chrome-hiding matrix (anon vs authed) — create / ⋯ menu / activity / logout;
//   3. the "Log in" and "browse without logging in" round-trip affordances;
//   4. the honest anonymous empty state (zero public datasets);
//   5. the no-bounce pin — an anonymous 401 never triggers the session-expiry route.
// The client-tier no-bounce guard (onAuthExpired never fires tokenless) is separately
// pinned in tests/client_auth_expiry.test.ts ("an anonymous 401 ... does NOT fire").
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { DatasetSummary } from "../../src/api-client/types.ts";
import { AdminScreen } from "../../src/ui/admin/AdminScreen.ts";
import { AuthPanel } from "../../src/ui/admin/AuthPanel.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// The public list the API returns to an anonymous caller (D-34): owner masked ("").
const PUBLIC_DATASET: DatasetSummary = {
  dataset_id: "rijks_pilot",
  dataset_version: 1,
  image_count: 42,
  ingest_timestamp: "2026-07-07T00:00:00Z",
  layout_ids: ["grid"],
  owner: "",
  status: "ready",
};

/** A ready card fetches its cover via global fetch (T2-55) — answer 404 so it falls back
 *  to the flat block instead of hitting the network (mirrors admin_screen.dom.test). */
function mockCoverFetch404(): void {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
}

function stubClient(datasets: DatasetSummary[], overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    async listDatasets(): Promise<DatasetSummary[]> {
      return datasets;
    },
    coverUrl(dsId: string): string {
      return `/api/datasets/${dsId}/cover`;
    },
    authHeaders(): Record<string, string> {
      return {};
    },
    ...overrides,
  } as unknown as ApiClient;
}

test("anonymous visitor lands on the read-only public library — no wall, no owner chrome", async () => {
  mockCoverFetch404();
  render(
    h(AdminScreen, {
      client: stubClient([PUBLIC_DATASET]),
      username: null, // anonymous
      onOpenDataset: () => {},
      onAuthExpired: () => {},
      onLogout: () => {},
      onLogin: () => {},
    }),
  );

  // Lands on the library (the effect-driven list load flips the count 0 → 1) — not a wall.
  await screen.findByText("1 dataset");
  assert.ok(screen.getByRole("heading", { name: "Library" }), "the library heading renders");

  // Read-only chrome: a "Log in" affordance is offered; every owner/authed affordance is hidden.
  assert.ok(screen.getByRole("button", { name: "Log in" }), "a Log in affordance is shown");
  assert.equal(screen.queryByRole("button", { name: "+ New dataset" }), null, "no create button");
  assert.equal(screen.queryByRole("button", { name: "Log out" }), null, "no Log out");
  assert.equal(screen.queryByText("ada"), null, "no username surfaced");

  // The card offers "Open" (read) but no ⋯ owner action menu (Add layout / Delete).
  assert.ok(screen.getByRole("button", { name: "Open" }), "the card can be opened");
  assert.equal(
    screen.queryByRole("button", { name: /^Actions for/ }),
    null,
    "no ⋯ owner action menu on a read-only card",
  );
});

test("authenticated library keeps the owner chrome (the matrix contrast)", async () => {
  mockCoverFetch404();
  render(
    h(AdminScreen, {
      client: stubClient([{ ...PUBLIC_DATASET, owner: "ada" }]),
      username: "ada", // authenticated
      onOpenDataset: () => {},
      onAuthExpired: () => {},
      onLogout: () => {},
      onLogin: () => {},
    }),
  );

  await screen.findByText("1 dataset");
  // Every owner/authed affordance is present, and the anonymous "Log in" is NOT.
  assert.ok(screen.getByRole("button", { name: "+ New dataset" }), "create button present");
  assert.ok(screen.getByRole("button", { name: "Log out" }), "Log out present");
  assert.ok(screen.getByText("ada"), "username surfaced");
  assert.ok(screen.getByRole("button", { name: /^Actions for/ }), "⋯ owner action menu present");
  assert.equal(screen.queryByRole("button", { name: "Log in" }), null, "no Log in when authed");
});

test("the read-only library's 'Log in' opens the auth view", async () => {
  mockCoverFetch404();
  let logins = 0;
  render(
    h(AdminScreen, {
      client: stubClient([PUBLIC_DATASET]),
      username: null,
      onOpenDataset: () => {},
      onAuthExpired: () => {},
      onLogout: () => {},
      onLogin: () => {
        logins += 1;
      },
    }),
  );

  await screen.findByText("1 dataset");
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  assert.equal(logins, 1, "the Log in affordance routes to the auth view");
});

test("an anonymous library with ZERO public datasets shows an honest empty state, not a blank page", async () => {
  render(
    h(AdminScreen, {
      client: stubClient([]),
      username: null,
      onOpenDataset: () => {},
      onAuthExpired: () => {},
      onLogout: () => {},
      onLogin: () => {},
    }),
  );

  // The honest anonymous copy — not a blank page, and not the owner's CLI ingest hint.
  await screen.findByText("No public datasets yet");
  assert.equal(screen.queryByText(/pixscope ingest/), null, "no owner CLI hint for a visitor");
  assert.equal(screen.queryByRole("button", { name: "+ New dataset" }), null, "no create button");
  // The log-in affordance is offered (topbar + the empty-state panel).
  assert.ok(
    screen.getAllByRole("button", { name: "Log in" }).length >= 1,
    "the empty state offers the log-in affordance",
  );
});

test("an anonymous list 401 does NOT bounce to the expiry screen (no session to expire)", async () => {
  let expired = 0;
  const client = stubClient([], {
    async listDatasets(): Promise<DatasetSummary[]> {
      // Defensive: D-34 returns the public list (200) to an anonymous caller, but even a
      // stray 401 must never be read as a session expiry for a visitor who holds no token.
      throw { status: 401, detail: "Not authenticated" };
    },
  });
  render(
    h(AdminScreen, {
      client,
      username: null,
      onOpenDataset: () => {},
      onAuthExpired: () => {
        expired += 1;
      },
      onLogout: () => {},
      onLogin: () => {},
    }),
  );

  // The 401 surfaces as an error banner — it does NOT route to the expiry/login screen.
  await screen.findByText("Not authenticated");
  assert.equal(expired, 0, "anonymous browsing never triggers the session-expiry bounce");
});

test("the auth screen offers 'Browse without logging in' and invokes it (the demo front door)", () => {
  let browsed = 0;
  render(
    h(AuthPanel, {
      client: {} as unknown as ApiClient,
      onAuthenticated: () => {},
      onBrowseAnonymously: () => {
        browsed += 1;
      },
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Browse without logging in" }));
  assert.equal(browsed, 1, "browse-without-login routes back to the public library");
});

test("AuthPanel omits the anonymous front door when it is not wired (a pure login form)", () => {
  render(
    h(AuthPanel, {
      client: {} as unknown as ApiClient,
      onAuthenticated: () => {},
    }),
  );
  assert.equal(
    screen.queryByRole("button", { name: "Browse without logging in" }),
    null,
    "no anonymous affordance without onBrowseAnonymously",
  );
});
