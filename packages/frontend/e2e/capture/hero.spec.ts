// Hero-loop capture — the marketing asset for plotlas.com's hero.
// Spec: docs/launch/SEAM_hero-capture.md
//
// NOT A GATE. This is an asset generator: it drives the real viewer along a computed
// camera path and writes one PNG per frame, which ffmpeg then encodes. The main
// playwright.config.ts `testIgnore`s `capture/**` so CI never collects it; run it
// deliberately with `--config=capture.config.ts`.
//
// WHY SCRIPTED rather than a screen recording:
//   * deterministic — no mouse jitter, no stray hover states, identical every run;
//   * re-runnable when the demo dataset changes (a new million-image corpus is under
//     consideration), which a hand-recorded take is not;
//   * and the loop CLOSES BY CONSTRUCTION: the path is a function of normalized time
//     with keyframe[last] === keyframe[0], so the final frame returns exactly to the
//     opening camera. A seamless loop is the single detail that separates a hero that
//     reads as crafted from one that visibly jumps every cycle.
//
// The storyboard (operator, 2026-08-03): open on the whole artist layout, dive until
// the artist band labels resolve, land on Rembrandt van Rijn, settle on The Night
// Watch, then pull back out to the opening frame.
import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { authenticate } from "../helpers.ts";

// --- the shot -----------------------------------------------------------------
//
// Coordinates are READ FROM THE BAKE, not guessed — verified 2026-08-03 against
// rijks_pilot (manifest 2.7):
//   * Rembrandt van Rijn is label rank #79 of the 500 emitted, 88 works, extent
//     [0.91844, 0.278204, 0.959453, 0.32195] in layout `categorical_artist`;
//   * The Night Watch is id 48985 (SK-C-5.jpg), whose cell sits at
//     x=0.938946 y=0.317794, w=0.003691 h=0.003543 — inside that extent, as it must be.
// Re-derive these if the dataset is re-baked; they are bake-specific, and a stale
// coordinate silently frames the wrong painting rather than failing.
const DATASET = process.env.CAPTURE_DATASET ?? "rijks_pilot";
const LAYOUT_LABEL = process.env.CAPTURE_LAYOUT ?? "Artist";

const BAND = { x0: 0.91844, y0: 0.278204, x1: 0.959453, y1: 0.32195 };
const NIGHT_WATCH = { x: 0.938946, y: 0.317794, w: 0.003691, h: 0.003543 };

const FPS = Number(process.env.CAPTURE_FPS ?? 30);
const OUT_DIR = process.env.CAPTURE_OUT ?? path.resolve("capture-frames");

/** Fractions of the viewport the subject should span at each rest point. Lower =
 *  tighter framing. Kept as named constants because they are the two aesthetic dials
 *  most likely to want adjusting after the operator sees a take. */
const BAND_FILL = 0.62;
const PAINTING_FILL = 0.55;

interface Shot {
  center: [number, number];
  /** Zoom in WORLD UNITS PER SCREEN PIXEL, or null for "the fit-the-world zoom". */
  zoom: number | null;
}

interface Leg {
  /** Seconds this leg lasts. A leg whose `to` equals its `from` is a hold. */
  seconds: number;
  to: Shot;
}

test("capture the hero loop", async ({ page }, testInfo) => {
  // ---- open the viewer -------------------------------------------------------
  // Prefer an ANONYMOUS capture: it is what a visitor actually sees, and it keeps the
  // owner's username and owner-only affordances out of frame. Requires the dataset to
  // be public (D-34). Fall back to credentialed access for a private dataset.
  const baseURL = testInfo.project.use.baseURL as string;
  const anon = process.env.CAPTURE_ANON === "1";
  if (!anon) {
    const auth = await authenticate(page.request, baseURL);
    await page.addInitScript(
      ([t, u]) => {
        localStorage.setItem("image-viz.token", t);
        localStorage.setItem("image-viz.username", u);
      },
      [auth.token, auth.username] as const,
    );
  }
  await page.goto("/");
  const card = page.locator(`.dataset-card[aria-label="${DATASET}"]`);
  await card.getByRole("button", { name: "Open" }).click();
  await page.locator("canvas.atlas-canvas").waitFor({ state: "visible" });

  // The DEV camera drive (renderer/debug.ts publishCameraDrive). Its absence means the
  // stack was built for production — fail loudly rather than silently capture a static
  // frame for ten minutes.
  await page
    .waitForFunction(() => (window as unknown as { __vizCamera?: unknown }).__vizCamera !== undefined, undefined, {
      timeout: 30_000,
    })
    .catch(() => {
      throw new Error(
        "window.__vizCamera is not published — the capture needs a DEV build of the frontend " +
          "(import.meta.env.DEV). Point BASE_URL at the dev stack (make dev), not a production build.",
      );
    });

  await page.locator(".layout-switcher button", { hasText: LAYOUT_LABEL }).first().click();
  await waitForTiles(page);

  // ---- the path --------------------------------------------------------------
  const fit = await page.evaluate(() => (window as unknown as CamWin).__vizCamera!.fitZoom());
  const viewportW = (testInfo.project.use.viewport as { width: number }).width;

  const overview: Shot = { center: [0.5, 0.5], zoom: null };
  const band: Shot = {
    center: [(BAND.x0 + BAND.x1) / 2, (BAND.y0 + BAND.y1) / 2],
    zoom: (BAND.x1 - BAND.x0) / (BAND_FILL * viewportW),
  };
  const painting: Shot = {
    center: [NIGHT_WATCH.x, NIGHT_WATCH.y],
    zoom: NIGHT_WATCH.w / (PAINTING_FILL * viewportW),
  };

  // Legs are named so a change reads as a storyboard edit, not a magic-number tweak.
  const legs: Leg[] = [
    { seconds: 1.4, to: overview },  // hold: let the scale land
    { seconds: 3.6, to: band },      // dive: labels resolve on the way in
    { seconds: 2.6, to: painting },  // close in on the Night Watch
    { seconds: 2.0, to: painting },  // hold: let it read
    { seconds: 3.4, to: overview },  // pull back — returns to the opening frame
  ];

  const resolve = (s: Shot): { center: [number, number]; zoom: number } => ({
    center: s.center,
    zoom: s.zoom ?? fit,
  });

  // ---- pre-warm --------------------------------------------------------------
  // Walk the path once WITHOUT capturing so every tile the shot touches is decoded and
  // cached. Without this the first take records tiles popping in — the artefact a
  // hand-recording would also suffer, and the reason a second take always looks better.
  if (process.env.CAPTURE_PREWARM !== "0") {
    for (const leg of legs) {
      const shot = resolve(leg.to);
      await setCamera(page, shot.center, shot.zoom);
      await waitForTiles(page);
    }
    await setCamera(page, resolve(overview).center, resolve(overview).zoom);
    await waitForTiles(page);
  }

  // ---- capture ---------------------------------------------------------------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith(".png")) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  // Screenshot the CANVAS HOLDER, not the canvas: the band labels and count chips are
  // DOM in the overlay substrate, not GL. A canvas-only shot would omit exactly the
  // labels this storyboard is built around. The holder excludes the app chrome.
  const frameEl = page.locator(".canvas-holder");

  let frame = 0;
  let from = resolve(overview);
  for (const leg of legs) {
    const to = resolve(leg.to);
    const steps = Math.max(1, Math.round(leg.seconds * FPS));
    for (let i = 0; i < steps; i++) {
      // i/steps, NOT i/(steps-1): the leg's final position is the NEXT leg's first
      // frame, so no camera position is ever captured twice. The last leg therefore
      // stops one frame short of the opening frame — which is what makes the loop
      // close without a duplicated, stuttering frame at the seam.
      const t = smootherstep(i / steps);
      await setCamera(page, lerpCenter(from.center, to.center, t), lerpZoom(from.zoom, to.zoom, t));
      await page.waitForTimeout(16); // let the render loop present the new camera
      await frameEl.screenshot({ path: path.join(OUT_DIR, `frame_${String(frame).padStart(5, "0")}.png`) });
      frame++;
    }
    from = to;
  }

  const seconds = (frame / FPS).toFixed(1);
  console.log(`\ncaptured ${frame} frames (${seconds}s @ ${FPS}fps) -> ${OUT_DIR}`);
  console.log("encode:\n" + encodeHint(OUT_DIR, FPS));
});

// --- helpers ------------------------------------------------------------------

interface CamWin {
  __vizCamera?: {
    get(): { center: [number, number]; zoom: number };
    set(center: [number, number], zoom: number): void;
    fitZoom(): number;
  };
  __vizDebug?: { loadingTiles?: number };
}

async function setCamera(page: import("@playwright/test").Page, center: [number, number], zoom: number): Promise<void> {
  await page.evaluate(
    ([cx, cy, z]) => {
      (window as unknown as CamWin).__vizCamera!.set([cx, cy], z);
    },
    [center[0], center[1], zoom] as const,
  );
}

/** Wait until no tile fetch is in flight, so a frame is never sampled mid-load. */
async function waitForTiles(page: import("@playwright/test").Page, timeoutMs = 30_000): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const d = (window as unknown as CamWin).__vizDebug;
        return d !== undefined && (d.loadingTiles ?? 0) === 0;
      },
      undefined,
      { timeout: timeoutMs },
    )
    .catch(() => {
      /* a slow tier can keep one fetch pending; capture anyway rather than abort a long run */
    });
}

/** Ease in and out with continuous acceleration (Perlin's smootherstep). Plain
 *  smoothstep still shows a faint kick at the ends at this duration. */
function smootherstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function lerpCenter(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Interpolate zoom GEOMETRICALLY (constant ratio per unit time), not linearly.
 *  Zoom is a scale factor: a linear ramp from 8e-4 to 6e-6 spends almost the whole
 *  leg visually parked at the wide end and then lurches. Interpolating in log space
 *  makes the dive feel like one continuous motion — the single most important line
 *  in this file for how the shot reads. */
function lerpZoom(a: number, b: number, t: number): number {
  return a * Math.pow(b / a, t);
}

function encodeHint(dir: string, fps: number): string {
  return [
    `  ffmpeg -y -framerate ${fps} -i "${path.join(dir, "frame_%05d.png")}" \\`,
    `    -c:v libx264 -pix_fmt yuv420p -crf 20 -movflags +faststart -an hero.mp4`,
    `  ffmpeg -y -framerate ${fps} -i "${path.join(dir, "frame_%05d.png")}" \\`,
    `    -c:v libvpx-vp9 -crf 34 -b:v 0 -an hero.webm`,
    `  ffmpeg -y -i hero.mp4 -frames:v 1 -q:v 3 hero-poster.jpg`,
  ].join("\n");
}
