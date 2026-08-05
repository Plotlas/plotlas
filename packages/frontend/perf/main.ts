// Renderer perf harness (brief §1.1, §3) — NOT a CI gate; it is the manual
// acceptance bar for the §1.8 budget: 100,000 cells resident must hold
// >= 30 fps sustained (60 target) with pan/zoom interaction on a desktop GPU.
//
// It constructs a REAL World + Cells on a canvas (the only WebGL path in the
// renderer — unit tests are GL-free), synthesizes 100k cells entirely
// in-memory (a grid over [0,1]^2 + a handful of solid-color DataTexture atlas
// pages; NO network, NO file decode), uploads them through the real
// CellBuffers / setBuffers + setAtlasTexture API, runs a scripted pan/zoom
// sweep driving the camera, and reports avg fps, min fps, and frame-time p95
// both on the HUD and to console.log.
//
// PR26-11: the sweep runs TWICE — a warmup cycle (drives the camera but records
// no frames; absorbs shader-compile / texture-upload / JIT one-off costs) then a
// measured cycle that produces the reported fps. build+upload is timed and
// reported SEPARATELY, never folded into the fps sample.
//
// Run:  npm run perf   (then open the printed URL in a browser and read the HUD)
import * as THREE from "three";
import { createWorld, fitZoom } from "../src/renderer/world.ts";
import type { CameraState, Viewport } from "../src/renderer/world.ts";
import { createCells } from "../src/renderer/cells.ts";
import type { CellBuffers, CellsHandle } from "../src/renderer/cells.ts";

// ---- knobs ----------------------------------------------------------------
const TARGET_CELLS = 100_000;
const ATLAS_PAGES = 8; // draw calls are bounded by VISIBLE pages, not cells
const PAGE_TEXELS = 64; // DataTexture side; solid-color, so size is irrelevant
const SWEEP_MS = 10_000; // scripted (measured) interaction duration
// PR26-11: run ONE full warmup sweep cycle before measuring, then sample only the
// second cycle. The first sweep pays one-off costs that depress avg/min and aren't
// part of steady-state interaction — shader compile, per-page texture upload to the
// GPU, JIT warmup, lazy allocations. Driving the identical camera motion once first
// warms all of that so the reported numbers reflect sustained fps, not first-paint.
const WARMUP_MS = SWEEP_MS; // warm for a full cycle (same scripted motion)
const FPS_FLOOR = 30; // §1.8 acceptance bar

const hud = document.getElementById("hud") as HTMLDivElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

function viewport(): Viewport {
  return {
    width: Math.max(1, Math.floor(window.innerWidth)),
    height: Math.max(1, Math.floor(window.innerHeight)),
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  };
}

/** A solid-color RGBA DataTexture used as one atlas page (no decode, no I/O). */
function solidPage(r: number, g: number, b: number): THREE.DataTexture {
  const n = PAGE_TEXELS * PAGE_TEXELS;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[4 * i] = r;
    data[4 * i + 1] = g;
    data[4 * i + 2] = b;
    data[4 * i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, PAGE_TEXELS, PAGE_TEXELS, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.flipY = false; // match lod.ts upload convention
  return tex;
}

/**
 * Build one CellBuffers covering all TARGET_CELLS as a square grid over
 * [0,1]^2. Cells are striped across ATLAS_PAGES by row so several pages are
 * visible at once (exercising the multi-bucket draw path). All cells are LOD 0;
 * each samples its whole (solid) page, so atlasUv is the full [0,0,1,1] rect.
 */
function buildGrid(count: number, pages: number): { buffers: CellBuffers; cols: number } {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const n = cols * rows; // fill the grid fully (>= count)
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const half = 0.94; // slight gap between cells so they read as a grid

  const ids = new BigInt64Array(n);
  const positions = new Float32Array(n * 2);
  const sizes = new Float32Array(n * 2);
  const atlasPage = new Int32Array(n);
  const atlasUv = new Float32Array(n * 4);
  const lod = new Int8Array(n); // all zeros

  let i = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++, i++) {
      ids[i] = BigInt(i);
      positions[2 * i] = (col + 0.5) * cellW;
      positions[2 * i + 1] = (row + 0.5) * cellH;
      sizes[2 * i] = cellW * half;
      sizes[2 * i + 1] = cellH * half;
      atlasPage[i] = row % pages; // stripe by row -> many pages on screen at once
      atlasUv[4 * i] = 0;
      atlasUv[4 * i + 1] = 0;
      atlasUv[4 * i + 2] = 1;
      atlasUv[4 * i + 3] = 1;
    }
  }
  return {
    buffers: { ids, positions, sizes, atlasPage, atlasUv, lod, count: n },
    cols,
  };
}

interface SweepKey {
  t: number; // 0..1 along the sweep
  center: [number, number];
  zoomFactor: number; // multiple of fitZoom (1 = whole world fits; <1 = zoomed in)
}

// Scripted pan/zoom: start zoomed out (whole world), zoom in to the center,
// orbit while zoomed, then zoom back out. Linear-interpolated between keys.
const KEYS: SweepKey[] = [
  { t: 0.0, center: [0.5, 0.5], zoomFactor: 1.0 },
  { t: 0.15, center: [0.5, 0.5], zoomFactor: 0.25 },
  { t: 0.35, center: [0.3, 0.35], zoomFactor: 0.12 },
  { t: 0.55, center: [0.7, 0.4], zoomFactor: 0.12 },
  { t: 0.75, center: [0.6, 0.7], zoomFactor: 0.2 },
  { t: 0.9, center: [0.5, 0.5], zoomFactor: 0.5 },
  { t: 1.0, center: [0.5, 0.5], zoomFactor: 1.0 },
];

function sampleSweep(progress: number, fit: number): Partial<CameraState> {
  const p = Math.min(1, Math.max(0, progress));
  let a = KEYS[0];
  let b = KEYS[KEYS.length - 1];
  for (let k = 0; k < KEYS.length - 1; k++) {
    if (p >= KEYS[k].t && p <= KEYS[k + 1].t) {
      a = KEYS[k];
      b = KEYS[k + 1];
      break;
    }
  }
  const span = b.t - a.t || 1;
  const u = (p - a.t) / span;
  const lerp = (x: number, y: number) => x + (y - x) * u;
  return {
    center: [lerp(a.center[0], b.center[0]), lerp(a.center[1], b.center[1])],
    zoom: fit * lerp(a.zoomFactor, b.zoomFactor),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

function main(): void {
  let world: ReturnType<typeof createWorld>;
  try {
    world = createWorld(canvas, viewport());
  } catch (err) {
    hud.innerHTML = `<span class="fail">WebGL unavailable: ${String(err)}</span>\nThe perf harness needs a real GPU/browser context.`;
    return;
  }

  const cells: CellsHandle = createCells(world);

  // Atlas pages: a handful of solid colors so cells are visibly distinct.
  const palette: [number, number, number][] = [
    [220, 80, 80],
    [80, 200, 120],
    [80, 140, 230],
    [230, 200, 70],
    [200, 90, 220],
    [70, 210, 210],
    [240, 150, 80],
    [160, 170, 190],
  ];
  const pages = Math.min(ATLAS_PAGES, palette.length);
  for (let p = 0; p < pages; p++) {
    cells.setAtlasTexture(0, p, solidPage(...palette[p]));
  }

  const t0build = performance.now();
  const { buffers } = buildGrid(TARGET_CELLS, pages);
  cells.setBuffers(buffers);
  const buildMs = performance.now() - t0build;
  const resident = cells.residentCount();

  world.resize(viewport());
  world.setCameraState(sampleSweep(0, fitZoom(world.getViewport())));
  world.start();

  window.addEventListener("resize", () => world.resize(viewport()));

  // ---- frame-time / fps measurement over the scripted sweep ----
  // PR26-11: two phases. WARMUP drives the identical camera motion but records
  // NOTHING (it pays the one-off shader/upload/JIT costs); MEASURE records frame
  // times over the second, steady-state sweep. build+upload is reported separately
  // (it is a setup cost, never folded into the fps sample).
  const frameMs: number[] = [];
  let started = false;
  let startTime = 0;
  let last = performance.now();
  let finished = false;

  function loop(now: number): void {
    const dt = now - last;
    last = now;

    if (!started) {
      // Skip the very first frame (includes upload/compile spikes) and anchor the
      // clock; the warmup phase that follows absorbs the remaining first-cycle costs.
      started = true;
      startTime = now;
      requestAnimationFrame(loop);
      return;
    }

    const elapsed = now - startTime;
    const warming = elapsed < WARMUP_MS;
    // Progress cycles 0->1 within EACH phase, so the warmup and the measured sweep
    // drive identical camera motion (the GPU sees the same frames warm vs cold).
    const progress = warming ? elapsed / WARMUP_MS : (elapsed - WARMUP_MS) / SWEEP_MS;
    const fit = fitZoom(world.getViewport());
    world.setCameraState(sampleSweep(progress, fit));
    if (!warming) {
      frameMs.push(dt); // sample only the measured (second) cycle
    }

    // live HUD
    const fpsNow = dt > 0 ? 1000 / dt : 0;
    hud.innerHTML =
      `<b>image-viz renderer perf</b>\n` +
      `cells resident : ${resident.toLocaleString()}\n` +
      `atlas pages    : ${pages}\n` +
      `build+upload   : ${buildMs.toFixed(0)} ms (excluded from fps)\n` +
      `phase          : ${warming ? "warmup (not sampled)" : "measuring"}\n` +
      `sweep          : ${Math.min(100, progress * 100).toFixed(0)}%\n` +
      `fps (live)     : ${fpsNow.toFixed(0)}`;

    if (!warming && progress >= 1 && !finished) {
      finished = true;
      report();
      return;
    }
    requestAnimationFrame(loop);
  }

  function report(): void {
    const sorted = [...frameMs].sort((a, b) => a - b);
    const total = frameMs.reduce((s, x) => s + x, 0);
    const avgFps = frameMs.length > 0 ? 1000 / (total / frameMs.length) : 0;
    const worstFrame = sorted[sorted.length - 1] ?? 0; // longest frame
    const minFps = worstFrame > 0 ? 1000 / worstFrame : 0;
    const p95 = percentile(sorted, 0.95);
    // "≥ 30 fps sustained" (§1.8): gate on the 95th-percentile frame time, so a
    // single hitch (GC, a texture upload) doesn't fail an otherwise-smooth run.
    // min fps is still reported as a diagnostic for the worst-case spike.
    const p95Fps = p95 > 0 ? 1000 / p95 : 0;
    const pass = p95Fps >= FPS_FLOOR;

    const summary = {
      cellsResident: resident,
      atlasPages: pages,
      frames: frameMs.length,
      warmupMs: WARMUP_MS, // PR26-11: first sweep cycle, excluded from the sample
      sweepMs: SWEEP_MS,
      buildUploadMs: Number(buildMs.toFixed(0)), // setup cost, reported separately
      avgFps: Number(avgFps.toFixed(1)),
      minFps: Number(minFps.toFixed(1)),
      p95Fps: Number(p95Fps.toFixed(1)),
      frameTimeP95Ms: Number(p95.toFixed(2)),
      budgetFloorFps: FPS_FLOOR,
      pass,
    };
    // Machine-readable line + human table to the console.
    console.log("[perf] result", JSON.stringify(summary));
    console.table(summary);

    hud.innerHTML =
      `<b>image-viz renderer perf — DONE</b>\n` +
      `cells resident : ${resident.toLocaleString()}\n` +
      `atlas pages    : ${pages}\n` +
      `build+upload   : ${buildMs.toFixed(0)} ms (excluded)\n` +
      `frames sampled : ${frameMs.length} (post-warmup)\n` +
      `avg fps        : ${avgFps.toFixed(1)}\n` +
      `min fps        : ${minFps.toFixed(1)}\n` +
      `p95 fps        : ${p95Fps.toFixed(1)}\n` +
      `frame p95      : ${p95.toFixed(2)} ms\n` +
      `budget (p95>=30): ${pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'}\n` +
      `\n(numbers also in console; record them + hardware in the PR)`;
  }

  requestAnimationFrame(loop);
}

main();
