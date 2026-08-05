import { test, expect } from "@playwright/test";
import {
  authenticate,
  openViewerV2,
  readViz,
  residentTotal,
  wheelZoom,
  waitForDrawn,
  canvasPngBytes,
  BLANK_PNG_BYTES,
  type VizV2,
} from "./helpers.ts";

// v2 spatial-tile-pyramid RENDER GATE (decision D-33).
//
// Drives the live stack (Caddy :8080 / caddy:80 on the compose net), loads a
// dataset, and asserts the pyramid's core correctness + SCALE invariants against
// window.__vizDebug (published by renderer/tilePyramid.ts + cells.ts):
//   1. the v2 loader is live — selectedZ / z_cap / maxZ are published;
//   2. the canvas renders REAL content (not blank / uniform grey);
//   3. zooming in DEEPENS the selected pyramid level (slippy-map selection);
//   4. the DRAWN tile set stays BOUNDED, independent of dataset size — the S3
//      guarantee. The v1 id-ordered pager violated this (resident grew with the
//      dataset, not the screen) → the 100k LOD2 OOM crash that drove the rework.
//      This is THE assertion that proves the pyramid holds at scale.
//   5. never-grey — placeholder-cells-in-view settles to ~0 on a still camera
//      (the coarse floor stays under the streaming fine tiles).
//
// Parameterized so the SAME gate runs at 10k (fast, CI-able) and at 100k/1M (the
// scale re-validation): E2E_DATASET picks the dataset, RESIDENT_TILE_CAP the bound.
// The v2 __vizDebug shape (VizV2) + its viewer helpers (openViewerV2 / readViz /
// wheelZoom / waitForDrawn / canvasPngBytes) are shared from ./helpers.ts with the
// context-loss gate — one definition, not a per-spec copy.

const DATASET = process.env.E2E_DATASET ?? "inat10k_v4";
// Drawn tiles for a viewport are a handful of coarse-floor + fine tiles; the bound
// proves the set does NOT scale with cell count (100k grid bakes ~1.5k fine tiles,
// 1M ~15k — a resident set in the low hundreds means the viewport, not the dataset,
// governs residency). Generous by default; tighten via env for a stricter gate.
const RESIDENT_TILE_CAP = Number(process.env.RESIDENT_TILE_CAP ?? "400");
// Wheel-zoom batches to drive the camera from fit toward the finest level. A
// deeper pyramid (100k → 7 levels) needs more than a shallow one (10k → 5), so
// this is tunable per scale.
const ZOOM_BATCHES = Number(process.env.ZOOM_BATCHES ?? "20");

test("v2 pyramid render gate — bounded, sharpening, never-grey", async ({ page, request, baseURL }) => {
  test.setTimeout(300_000); // headroom for the 100k run (full-canvas screenshots + settle)
  const auth = await authenticate(request, baseURL ?? "");
  await openViewerV2(page, auth, DATASET);

  // (1) v2 loader live -------------------------------------------------------
  const v0 = await readViz(page);
  expect(v0, "renderer published no __vizDebug").not.toBeNull();
  const viz0 = v0 as VizV2;
  console.log(
    `[gate:${DATASET}] initial selectedZ=${viz0.selectedZ} zCap=${viz0.zCap} maxZ=${viz0.maxZ} ` +
      `resident=${residentTotal(viz0)} totalCells=${viz0.totalCells}`,
  );
  expect(viz0.maxZ, "pyramid maxZ not published (v2 loader inactive?)").toBeGreaterThanOrEqual(0);
  expect(viz0.zCap, "z_cap not published").toBeGreaterThanOrEqual(0);
  expect(viz0.selectedZ, "no pyramid level selected after load").toBeGreaterThanOrEqual(0);

  // (2) renders real content -------------------------------------------------
  await waitForDrawn(page); // a tile is actually drawn before we sample pixels
  const bytes0 = await canvasPngBytes(page);
  console.log(`[gate:${DATASET}] initial canvas PNG bytes=${bytes0}`);
  expect(bytes0, "canvas looks blank / uniform on load (tiny PNG)").toBeGreaterThan(BLANK_PNG_BYTES);

  // (3)+(4) zoom in; track the level + the drawn-tile bound -------------------
  const initialZ = viz0.selectedZ;
  let maxResident = residentTotal(viz0);
  let maxLoading = viz0.loadingTiles;
  for (let i = 0; i < ZOOM_BATCHES; i++) {
    await wheelZoom(page, 1);
    const v = await readViz(page);
    if (v !== null) {
      maxResident = Math.max(maxResident, residentTotal(v));
      maxLoading = Math.max(maxLoading, v.loadingTiles);
    }
  }
  await page.waitForTimeout(4000); // let the final view settle (fetch + decode + bind)
  const vf = (await readViz(page)) as VizV2;
  console.log(
    `[gate:${DATASET}] after zoom selectedZ=${vf.selectedZ} resident=${residentTotal(vf)} ` +
      `maxResidentSeen=${maxResident} maxLoadingSeen=${maxLoading} placeholderInView=${vf.placeholderCellsInView}`,
  );

  // (3) zoom deepened the level (only when the pyramid has room below the start)
  if (viz0.maxZ > initialZ) {
    expect(vf.selectedZ, "zoom did not deepen the selected pyramid level").toBeGreaterThan(initialZ);
  }

  // (4) THE scale invariant: the drawn tile set is bounded, not dataset-scaled.
  expect(
    maxResident,
    `drawn tile set (${maxResident}) exceeded the viewport bound — residency is scaling with the dataset (the v1 crash pathology)`,
  ).toBeLessThan(RESIDENT_TILE_CAP);

  // (5) never-grey on a still camera -----------------------------------------
  expect(vf.placeholderCellsInView, "grey placeholder persists in view on a still camera").toBeLessThanOrEqual(2);

  // (6) DETAIL OVERLAY (T2-26, Seam D1) — additive-safety + the S1 draw-call bound.
  // The overlay draws each visible cell's baked detail original ON TOP of the pyramid
  // past a zoom gate. It must NEVER perturb the bounded-resident / never-grey /
  // sharpening invariants above (which still hold here, with the overlay wired in),
  // and its OWN drawn set is bounded by the in-view cap (config.maxOverlayCells = 400)
  // — the analytic S1 close-out (≤126 quads at the gate, shrinking as you zoom) made
  // observable. The counter is published on __vizDebug.overlayCells (detailOverlay.ts);
  // read it directly (helpers.ts VizV2 is out of this seam's file set).
  //
  // FIXTURE NOTE: the PR-blocking gate fixture (calib_small_v2) has a detail tier but
  // NO positions_ref, so the overlay GATES OFF (0) here BY DESIGN — the graceful-off,
  // additive-safe path (detail present, no per-cell rects to place). A positive
  // "overlay engages + sharpens" LIVE assertion needs a fixture carrying BOTH a detail
  // tier AND a positions table; no committed fixture has both today (calib/golden_v2/
  // dense have detail but no positions; golden_dataset_full_v2 has positions but was
  // baked --detail-tier skip). The engagement logic is fully covered by the unit tier
  // (tests/detail_overlay.test.ts); a real dataset (nightly E2E_DATASET) carries both
  // and engages — hence the BOUND below, not a hard 0, so this holds on both.
  const overlayCells = await page.evaluate(() => {
    const d = (window as unknown as { __vizDebug?: { overlayCells?: number } }).__vizDebug;
    return d !== undefined && typeof d.overlayCells === "number" ? d.overlayCells : null;
  });
  console.log(`[gate:${DATASET}] detail overlayCells=${overlayCells} (0 = gated off; calib_small_v2 has no positions_ref)`);
  expect(overlayCells, "detail overlay counter not published (detailOverlay.ts not wired?)").not.toBeNull();
  expect(overlayCells as number, "detail overlay is unbounded — the in-view cap (400) regressed").toBeLessThanOrEqual(400);
  expect(overlayCells as number, "detail overlay count is negative (impossible)").toBeGreaterThanOrEqual(0);

  // content still present at the deepest zoom. A strict PNG-byte gate is
  // unreliable HERE — a deep zoom into a few (possibly smooth) images is
  // legitimately low-entropy and compresses small — so the high-entropy COARSE
  // view above is the blank-catch, and deep-zoom correctness is asserted via
  // renderer state: fine tiles are drawn and nothing is grey (both already true
  // in vf). The byte size is logged as evidence only.
  const bytesF = await canvasPngBytes(page);
  console.log(`[gate:${DATASET}] final canvas PNG bytes=${bytesF}`);
  expect(residentTotal(vf), "no tiles drawn at the deepest zoom").toBeGreaterThan(0);
});

// (3a) AUTHED DETAIL FETCH — the browser-tier regression net for the PR #74 fix
// (ledger T2-38, resolved by PR #74). The per-cell detail original is served at a
// VISIBILITY-GATED route (`GET /api/datasets/{ds}/detail/{id}.{ext}`, D-24/D-34);
// the frontend (ui/cellPreview.fetchCellPreview) must fetch it WITH the identity
// bearer header, because a bare `<img src>` — which sends no Authorization header —
// is denied. The unit tier covers the header contract on the fetch helper
// (tests/cell_preview_fetch.test), but nothing exercised it in a real browser
// against the live gated API. This runs the exact
// `fetch(url, { headers: { Authorization: Bearer … } })` shape cellPreview uses,
// IN the page, and asserts:
//   * WITH the bearer  → 200 (the authed path the fix installed works end to end);
//   * WITHOUT it       → 404 (the route is genuinely gated — so the 200 above is
//                        the auth header's doing, i.e. a real regression net, not a
//                        route that happens to be open). D-34 changed the denial
//                        from 401 to the SAME 404 as a missing dataset: an anonymous
//                        read of a PRIVATE dataset must not disclose its existence
//                        (get_optional_user never 401s a credential-less request;
//                        may_read denies → non-disclosure 404). The fixture stays
//                        private in CI (only owner-assigned), so 404 — not 200 — is
//                        the gated answer here. Cell id 0 exists in every dataset
//                        (dense ids from 0). Detail format is webp for the calib
//                        fixture (manifest detail.format); overridable via env.
const DETAIL_CELL_ID = Number(process.env.E2E_DETAIL_CELL_ID ?? "0");
const DETAIL_EXT = process.env.E2E_DETAIL_EXT ?? "webp";

test("authed detail fetch — bearer 200, unauthed 404 (PR #74 net, D-34)", async ({ page, request, baseURL }) => {
  const auth = await authenticate(request, baseURL ?? "");
  // Load the app so the token is in localStorage and the page origin is set; the
  // fetch below runs in the page context, hitting the same relative /api route the
  // client composes (detailUrl → {base}/api/datasets/{ds}/detail/{id}.{ext}).
  await openViewerV2(page, auth, DATASET);

  const detailPath = `/api/datasets/${encodeURIComponent(DATASET)}/detail/${DETAIL_CELL_ID}.${DETAIL_EXT}`;
  const result = await page.evaluate(
    async ([path, token]) => {
      // `cache: "no-store"` on BOTH so each fetch actually reaches the auth-gated
      // server: the detail response is `Cache-Control: public, max-age=300`, so a
      // plain second fetch of the same URL would be served from the browser cache
      // (200) without ever hitting uvicorn — masking the 401. Do the bare (no-auth)
      // fetch FIRST, before any 200 body is even a cache candidate, as belt-and-braces.
      const bare = await fetch(path, { cache: "no-store" }); // no Authorization — the #74 bug shape
      const authed = await fetch(path, { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      return {
        authedStatus: authed.status,
        authedType: authed.headers.get("content-type"),
        bareStatus: bare.status,
      };
    },
    [detailPath, auth.token] as const,
  );
  console.log(
    `[gate:${DATASET}] detail authed=${result.authedStatus} (${result.authedType}) bare=${result.bareStatus}`,
  );
  expect(result.authedStatus, "authed detail fetch did not return 200 (PR #74 authed path broken?)").toBe(200);
  expect(result.authedType ?? "", "authed detail response is not an image").toContain("image");
  // D-34: an anonymous read of a PRIVATE dataset is the same 404 as a missing one
  // (non-disclosure) — a 200 here would mean the gate regressed (or the fixture was
  // published, which CI never does); a 401 would mean the pre-D-34 behaviour came back.
  expect(result.bareStatus, "unauthed detail fetch was NOT rejected with the D-34 non-disclosure 404 — the route is not visibility-gated").toBe(404);
});

// (3b) TAG assertion (T2-73's render-gate half) — SKIPPED for calib_small_v2 BY
// DESIGN. It would assert the tag sidecar loads and a highlight count appears, but
// the calibration recipe (tools/calibration/generate_calib.py) is images-only: it
// emits no `--metadata`, so the fixture's metadata.parquet carries no `tag` role and
// no tags_v{ver}.arrow sidecar is baked. The brief forbids extending the generator,
// so this half is intentionally not wired here. When a fixture that DOES carry a tag
// role drives this gate (e.g. a real dataset with a category column designated a tag
// per T2-73), fold the sidecar-loads + highlight-count assertion in at this point.
