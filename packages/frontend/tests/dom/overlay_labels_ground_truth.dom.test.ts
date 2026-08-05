// T2-72 Seam 2 — GROUND-TRUTH gate for the ratified placement rule: band labels sit in
// the empty gaps beside their group, NEVER over the images.
//
// The PR-180 review found the prior tests were tautologies: the unit test compared the
// gap-slot formula to itself, and the dom test re-derived the slot with the same
// worldToScreen + gapFrac the code uses — NO image geometry appeared in either, so the
// actual guarantee ("provably never over an image") was uncovered. This test is the
// review's probe turned into a repo gate: it renders the REAL overlay layer over the REAL
// golden fixture (both baked categorical layouts — 342 cells of real treemap geometry from
// positions_ref) across a zoom × pan sweep, then asserts every drawn label's screen box
// intersects ZERO projected cell rects. If any of the load-bearing couplings drifts —
// labelGapFrac vs the producer's _REGION_FILL inset, the measure font vs the rendered
// font, labelHeightPx vs the line box, the visible-gutter clamp — a label lands on an
// image here and this fails with the exact box pair.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tableFromIPC } from "apache-arrow";

import { createOverlayLayer, worldToScreen } from "../../src/renderer/overlayLayer.ts";
import type { OverlayContext } from "../../src/renderer/overlayLayer.ts";
import { parsePositionsTable } from "../../src/renderer/cells.ts";
import type { PositionTable } from "../../src/renderer/cells.ts";
import type { LayoutManifest } from "../../src/renderer/layout.ts";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { CameraState, Viewport, World } from "../../src/renderer/world.ts";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../tests/fixtures/golden_dataset_full_v2/", import.meta.url),
);
const VP: Viewport = { width: 1000, height: 800, devicePixelRatio: 1 };

// A controllable rAF (the shared dom-test pattern) so repositions run deterministically.
let rafQueue: FrameRequestCallback[] = [];
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  rafQueue.push(cb);
  return rafQueue.length;
}) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
function flushRaf(): void {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(0);
}

function makeDomWorld(): { world: World; holder: HTMLElement; emit: (s: CameraState, v: Viewport) => void } {
  const holder = document.createElement("div");
  holder.className = "canvas-holder";
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);
  document.body.appendChild(holder);
  const subs = new Set<(s: CameraState, v: Viewport) => void>();
  const world = {
    scene: { add() {}, remove() {} },
    camera: {},
    renderer: { domElement: canvas },
    maxTextureSize: 4096,
    resize() {},
    onCameraChange(cb: (s: CameraState, v: Viewport) => void): () => void {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    start() {},
    dispose() {},
    onDispose() {},
    haltRenderLoop() {},
    resumeRenderLoop() {},
  } as unknown as World;
  return {
    world,
    holder,
    emit(s, v) {
      for (const cb of subs) cb(s, v);
    },
  };
}

const stubClient = { getMetadata: async () => [] } as unknown as ApiClient;

function loadFixturePositions(name: string): PositionTable {
  const bytes = readFileSync(join(FIXTURE_DIR, "positions", name));
  return parsePositionsTable(tableFromIPC(new Uint8Array(bytes)));
}

const manifest = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "layout_manifest.json"), "utf8"),
) as unknown as LayoutManifest;

/** Half-open screen-box intersection with a strictly-positive overlap area. */
function boxesOverlap(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

for (const layoutId of ["categorical_group", "categorical_bucket"]) {
  test(`ground truth (${layoutId}): no drawn label box intersects any REAL baked cell rect`, () => {
    const positions = loadFixturePositions(`${layoutId}_v1.arrow`);
    assert.ok(positions.count > 0, "fixture positions loaded");
    const w = makeDomWorld();
    const layer = createOverlayLayer(w.world, stubClient);
    layer.setContext({ manifest, layoutId, positions } as OverlayContext);
    layer.setCountsEnabled(true); // the longer "name (count)" text — the harder width case

    // Zooms from whole-layout overview into band interiors; a pan grid at each. The
    // deep-zoom cameras exercise the visible-gutter clamp path specifically.
    const zooms = [1 / 700, 1 / 1400, 1 / 2800, 1 / 5600];
    let drawnTotal = 0;
    for (const zoom of zooms) {
      for (let cyi = 0; cyi < 5; cyi++) {
        for (let cxi = 0; cxi < 5; cxi++) {
          const state: CameraState = {
            center: [0.1 + cxi * 0.2, 0.1 + cyi * 0.2],
            zoom,
          };
          w.emit(state, VP);
          flushRaf();
          const labels = [...w.holder.querySelectorAll<HTMLElement>(".overlay-band-label")].filter(
            (el) => el.style.display === "block",
          );
          drawnTotal += labels.length;
          for (const el of labels) {
            // The drawn box exactly as renderLabels placed it: left/top styles are the
            // clamped screenX/screenTop; translateX(-50%) centres the measured width.
            // Reconstruct conservatively from the declutter box the code itself used:
            // left ± the element's laid-out width is unavailable in jsdom, so use the
            // config's box height and re-measure the width with the SAME injected-free
            // measurer path the layer used (the char estimate in jsdom).
            const cx = Number.parseFloat(el.style.left);
            const top = Number.parseFloat(el.style.top);
            const text = el.textContent ?? "";
            const boxW = text.length * layer.config.labelCharPx + layer.config.labelPadPx;
            const box = {
              left: cx - boxW / 2,
              right: cx + boxW / 2,
              top,
              bottom: top + layer.config.labelHeightPx,
            };
            // Sweep EVERY baked cell rect of the layout, projected to this camera.
            for (let i = 0; i < positions.count; i++) {
              const [sx, sy] = worldToScreen(state, VP, positions.x[i], positions.y[i]);
              const hw = positions.w[i] / 2 / (state.zoom > 0 ? state.zoom : 1);
              const hh = positions.h[i] / 2 / (state.zoom > 0 ? state.zoom : 1);
              const cell = { left: sx - hw, right: sx + hw, top: sy - hh, bottom: sy + hh };
              assert.ok(
                !boxesOverlap(box, cell),
                `label "${text}" box ${JSON.stringify(box)} overlaps cell ${i} ` +
                  `${JSON.stringify(cell)} at zoom ${zoom} center ${state.center.join(",")}`,
              );
            }
          }
        }
      }
    }
    assert.ok(drawnTotal > 0, "the sweep actually drew labels (a vacuous pass is a broken sweep)");
    layer.dispose();
    w.holder.remove();
  });
}
