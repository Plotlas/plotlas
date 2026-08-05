import type { Page, APIRequestContext } from "@playwright/test";

// The v2 renderer-debug shape (renderer/debug.ts RendererDebugState) mirrored onto
// window.__vizDebug — the fields the browser gates assert on. A SUPERSET of what any
// one spec reads (the render gate ignores contextLosses/cameraCenter; the
// context-loss gate uses them), so both gates share this one definition instead of
// each re-declaring it.
export interface VizV2 {
  totalCells: number;
  placeholderCellsInView: number;
  selectedZ: number;
  zCap: number;
  maxZ: number;
  residentByZ: Record<number, number>;
  loadingTiles: number;
  contextLosses: number;
  cameraCenter: [number, number];
  cameraZoom: number;
}

// One recorder snapshot: a __vizDebug sample plus the ms offset since recording
// started (startRecorder spreads the live debug object and stamps `t`).
export type DebugSample = VizV2 & { t: number };

// A blank/uniform canvas screenshot zlib-compresses to ~1-3 KB; a real mosaic is
// tens of KB+. 10 KB cleanly separates blank from content — shared by both gates.
export const BLANK_PNG_BYTES = 10_000;

const TOKEN_KEY = "image-viz.token";
const USERNAME_KEY = "image-viz.username";

/** Authenticate against the target API and return a bearer token.
 *
 *  Two modes (D-34 read authorization made this matter — a logged-in user sees only
 *  the datasets they OWN plus PUBLIC ones, so a random throwaway user cannot see a
 *  fixture dataset that was file-mounted into the stack and owner-assigned out of
 *  band):
 *
 *  * `E2E_USERNAME` + `E2E_PASSWORD` set ⇒ LOG IN as that pre-provisioned user.
 *    The render-gate workflow signs this user up and `api.admin assign-owner`s the
 *    calib fixture to it before the specs run, so the dataset card renders. A live
 *    (nightly) target can point these at any user that owns — or can read — the
 *    driven dataset.
 *  * otherwise ⇒ create a THROWAWAY account via the unauthenticated signup (the same
 *    path the API's own integration tests use). Under D-34 such a user sees only
 *    PUBLIC datasets — fine for a showcase target, insufficient for a private
 *    fixture. */
export async function authenticate(
  request: APIRequestContext,
  baseURL: string,
): Promise<{ token: string; username: string }> {
  const envUser = process.env.E2E_USERNAME;
  const envPass = process.env.E2E_PASSWORD;
  if (envUser !== undefined && envUser !== "" && envPass !== undefined && envPass !== "") {
    const login = await request.post(`${baseURL}/api/auth/login`, {
      data: { username: envUser, password: envPass },
    });
    if (!login.ok()) {
      throw new Error(
        `login as E2E_USERNAME=${envUser} failed (${login.status()}): ${await login.text()} — ` +
          `was the user provisioned on the target stack (signup + api.admin assign-owner)?`,
      );
    }
    const body = (await login.json()) as { access_token: string };
    return { token: body.access_token, username: envUser };
  }

  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const username = `e2e_${stamp}`;
  const password = "e2e-Diag-Pw-123456";
  // The API's email validator rejects reserved TLDs (.local/.test). example.com is
  // accepted (the existing CLI/test accounts use it).
  const email = `${username}@example.com`;

  const signup = await request.post(`${baseURL}/api/auth/signup`, {
    data: { username, email, password },
  });
  if (!signup.ok()) throw new Error(`signup ${signup.status()}: ${await signup.text()}`);

  const login = await request.post(`${baseURL}/api/auth/login`, {
    data: { username, password },
  });
  if (!login.ok()) throw new Error(`login ${login.status()}: ${await login.text()}`);
  const body = (await login.json()) as { access_token: string };
  return { token: body.access_token, username };
}

/** Inject the bearer into localStorage (the App reads it on mount), load the app,
 *  and click the dataset card's "Open" button. Shared by both viewer-open waiters
 *  below — the ONE place the post-design-pass `.dataset-card[aria-label]` selector
 *  lives, so a future markup change is a single edit (duplicating this selector
 *  across specs is exactly the rot that broke these gates; T2-49). */
async function openDatasetCard(
  page: Page,
  auth: { token: string; username: string },
  datasetId: string,
): Promise<void> {
  await page.addInitScript(
    ([keyT, keyU, t, u]) => {
      localStorage.setItem(keyT, t);
      localStorage.setItem(keyU, u);
    },
    [TOKEN_KEY, USERNAME_KEY, auth.token, auth.username] as const,
  );
  await page.goto("/");
  // The library renders each dataset as a `.dataset-card` article (aria-label =
  // dataset id) with an "Open" button in its ready-state actions (ui/admin/
  // DatasetList.ts, post design-pass PRs #87-91 — the old `.dataset-row` list was
  // replaced by the card gallery). Select by exact aria-label so a dataset id that
  // is a substring of another can't mismatch.
  const card = page.locator(`.dataset-card[aria-label="${datasetId}"]`);
  await card.getByRole("button", { name: "Open" }).click();
  await page.locator("canvas.atlas-canvas").waitFor({ state: "visible" });
}

/** Open a dataset and wait for the renderer to publish a NON-EMPTY cell set
 *  (`totalCells > 0`) — correct for a fine-content dataset (renderer-transition's
 *  multi-layout bake opens with resident cells). */
export async function openViewer(
  page: Page,
  auth: { token: string; username: string },
  datasetId: string,
): Promise<void> {
  await openDatasetCard(page, auth, datasetId);
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __vizDebug?: { totalCells: number } }).__vizDebug;
      return d !== undefined && d.totalCells > 0;
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** Open a dataset and wait for the v2 loader to have STREAMED — signalled by
 *  `__vizDebug.maxZ >= 0` (the pyramid was published), NOT by `totalCells > 0`: a
 *  dataset that opens at a COARSE level draws the overview mesh with ZERO resident
 *  cells (calib_small_v2 opens coarse), so totalCells stays 0 until a fine-level
 *  zoom — waiting on it would always time out. Used by the render gate + the
 *  context-loss gate (both drive the coarse-opening calib stack). */
export async function openViewerV2(
  page: Page,
  auth: { token: string; username: string },
  datasetId: string,
): Promise<void> {
  await openDatasetCard(page, auth, datasetId);
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __vizDebug?: { maxZ?: number } }).__vizDebug;
      return d !== undefined && typeof d.maxZ === "number" && d.maxZ >= 0;
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** One snapshot of window.__vizDebug as a DEEP copy — the renderer mutates the live
 *  object in place (debug.ts), so a JSON clone is needed for a baseline that must
 *  not drift after later mutations. null if the renderer hasn't published yet. */
export async function readViz(page: Page): Promise<VizV2 | null> {
  return page.evaluate(() => {
    const d = (window as unknown as { __vizDebug?: unknown }).__vizDebug;
    return d === undefined ? null : (JSON.parse(JSON.stringify(d)) as VizV2);
  });
}

/** Total DRAWN tiles across all pyramid levels (sum of residentByZ). */
export function residentTotal(v: VizV2): number {
  return Object.values(v.residentByZ ?? {}).reduce((a, b) => a + b, 0);
}

/** Zoom in by dispatching WheelEvents at the canvas centre (Playwright's
 *  mouse.wheel does not reliably reach the world's `{passive:false}` handler). */
export async function wheelZoom(page: Page, batches: number, deltaY = -400, gapMs = 90): Promise<void> {
  const canvas = page.locator("canvas.atlas-canvas");
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("canvas has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < batches; i++) {
    await page.evaluate(
      ([x, y, dy]) => {
        const c = document.querySelector("canvas.atlas-canvas");
        c?.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      },
      [cx, cy, deltaY] as const,
    );
    await page.waitForTimeout(gapMs);
  }
}

/** Wait until at least one tile is DRAWN (sum(residentByZ) > 0) so a pixel/state
 *  check is not sampled on an empty pre-load frame. */
export async function waitForDrawn(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const d = (window as unknown as { __vizDebug?: { residentByZ?: Record<number, number> } }).__vizDebug;
      if (d === undefined || d.residentByZ === undefined) return false;
      return Object.values(d.residentByZ).reduce((a, b) => a + b, 0) > 0;
    },
    undefined,
    { timeout: timeoutMs },
  );
}

/** PNG byte length of a screenshot of just the canvas element (the COMPOSITED
 *  pixels the browser presents — a WebGL readPixels outside the render frame reads
 *  blank). A blank/uniform canvas compresses to a few KB; a real mosaic is far
 *  larger. Pair with BLANK_PNG_BYTES to separate blank from content. */
export async function canvasPngBytes(page: Page): Promise<number> {
  const shot = await page.locator("canvas.atlas-canvas").screenshot();
  return shot.length;
}

/** Install an in-page recorder that snapshots window.__vizDebug every
 *  `intervalMs`. Decoupled from the driver, so it captures the full timeline
 *  across whatever input we dispatch (zoom/switch) without concurrent evaluate
 *  races. Pair with stopRecorder. */
export async function startRecorder(page: Page, intervalMs = 80): Promise<void> {
  await page.evaluate((iv) => {
    const w = window as unknown as { __rec?: unknown[]; __recTimer?: number };
    w.__rec = [];
    const start = performance.now();
    w.__recTimer = window.setInterval(() => {
      const d = (window as unknown as { __vizDebug?: Record<string, unknown> }).__vizDebug;
      if (d !== undefined) (w.__rec as unknown[]).push({ t: Math.round(performance.now() - start), ...d });
    }, iv);
  }, intervalMs);
}

/** Stop the recorder and return the captured timeline. */
export async function stopRecorder(page: Page): Promise<DebugSample[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __rec?: DebugSample[]; __recTimer?: number };
    if (w.__recTimer !== undefined) window.clearInterval(w.__recTimer);
    return w.__rec ?? [];
  });
}

/** Switch layout by clicking its tab in the viewer's layout switcher by label. */
export async function switchLayout(page: Page, label: string): Promise<void> {
  await page.locator(".layout-switcher button", { hasText: label }).first().click();
}

/** §0.6: force a WebGL context loss on the live canvas via the WEBGL_lose_context
 *  extension, stashing the extension on `window.__loseCtx` for the paired
 *  restore. Returns false if the canvas / context / extension is unavailable
 *  (so the test can fail with a clear reason instead of a vague timeout). */
export async function forceContextLoss(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector("canvas.atlas-canvas") as HTMLCanvasElement | null;
    if (c === null) return false;
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl === null) return false;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext === null) return false;
    (window as unknown as { __loseCtx?: WEBGL_lose_context }).__loseCtx = ext;
    ext.loseContext();
    return true;
  });
}

/** §0.6: restore the context lost by `forceContextLoss` (fires
 *  webglcontextrestored). Returns false if no prior loss was forced. */
export async function forceContextRestore(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ext = (window as unknown as { __loseCtx?: WEBGL_lose_context }).__loseCtx;
    if (ext === undefined) return false;
    ext.restoreContext();
    return true;
  });
}
