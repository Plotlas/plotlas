import { defineConfig, devices } from "@playwright/test";

// Config for the marketing hero-loop capture (docs/launch/SEAM_hero-capture.md).
// SEPARATE from playwright.config.ts on purpose: the capture is an asset generator,
// not a gate — it runs for minutes against a real demo dataset, writes PNG frames to
// disk, and must never be collected by CI. The main config `testIgnore`s `capture/**`;
// this config is the only way in:
//
//   npx playwright test --config=capture.config.ts
//
// The viewport is the CAPTURE FRAME. 1200x675 logical at deviceScaleFactor 2 yields
// 2400x1350 physical pixels — 16:9 at 2x, so the loop stays crisp on a retina hero
// without encoding a needlessly huge source.
const extraArgs = (process.env.E2E_CHROMIUM_ARGS ?? "").split(" ").filter((a) => a.length > 0);

export default defineConfig({
  testDir: "./capture",
  // Minutes, not seconds: a few hundred frames, each waiting for tiles to settle.
  timeout: 30 * 60_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8080",
    headless: true,
    viewport: { width: 1200, height: 675 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
    trace: "off",
    video: "off",
    launchOptions: { args: extraArgs },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
