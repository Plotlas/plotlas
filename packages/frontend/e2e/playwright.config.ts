import { defineConfig, devices } from "@playwright/test";

// Drives the ALREADY-RUNNING stack (docker compose up). No managed webServer —
// the app is served by caddy. From inside the Playwright container the host's
// published caddy port is reachable as host.docker.internal:8080; override with
// BASE_URL when running elsewhere.
//
// E2E_CHROMIUM_ARGS: optional space-separated extra chromium launch flags. Empty
// by default (a real GPU / the nightly's live target needs nothing). CI's
// render-gate.yml sets the SwiftShader/ANGLE family here so headless WebGL comes up
// on a GPU-less GitHub runner (Chromium otherwise refuses a GL context there and the
// canvas is blank). Kept env-gated rather than hardcoded so non-CI runs are unchanged.
const extraArgs = (process.env.E2E_CHROMIUM_ARGS ?? "").split(" ").filter((a) => a.length > 0);

export default defineConfig({
  testDir: ".",
  // `capture/` holds the marketing hero-loop driver (docs/launch/SEAM_hero-capture.md).
  // It is a long-running asset generator against a REAL demo dataset — not a gate — so
  // it must never be collected by `npx playwright test` / CI. Run it deliberately via
  // its own config: `npx playwright test --config=capture.config.ts`.
  testIgnore: ["capture/**"],
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://host.docker.internal:8080",
    headless: true,
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    video: "off",
    launchOptions: { args: extraArgs },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
