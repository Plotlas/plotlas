// Layout-switch contract (instant swap — the D-10 tween is DELETED).
// switchTo(layoutId) must:
//   * no-op against the layout already active OR already being switched to,
//   * bump the loader's stale-drop generation (beginLayoutSwitch) then hand the
//     whole switch to pyramid.activateLayout — NO staging fetch, NO position
//     tween, NO settle wait (the loader-side behaviour — condemned coarse
//     backdrop, viewport-bounded streaming — is covered in
//     tile_pyramid_loader.test.ts),
//   * converge under re-entrancy (H2): two rapid calls end on the LAST layout,
//     the superseded call resolving quietly,
//   * leave the controller retargetable after a FAILED switch (H5's contract:
//     the rejection reaches the caller; a retry of the same layout is not
//     swallowed as a no-op).
// Plus the cells-side ground truth the instant swap rests on: setBuffers places
// each cell AT its buffer position immediately.
import assert from "node:assert/strict";
import test from "node:test";

import { createLayoutController } from "../src/renderer/layout.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import { createCells } from "../src/renderer/cells.ts";
import {
  createFakeClient,
  createStubCells,
  createStubPyramid,
  createStubWorld,
} from "./fake_client.ts";
import type { StubPyramid } from "./fake_client.ts";

/** Fake client over the golden fixture, doctored to declare a second layout
 *  ("alt") identical to grid except for its id — enough for the controller,
 *  which only reads layout_id + bbox and delegates the rest to the pyramid. */
function twoLayoutClient(): ReturnType<typeof createFakeClient> {
  return createFakeClient(undefined, {
    doctorManifest: (m: LayoutManifest): LayoutManifest => ({
      ...m,
      layouts: [...m.layouts, { ...m.layouts[0], layout_id: "alt", label: "Alt" }],
    }),
  });
}

async function controllerOnGrid(): Promise<{
  controller: ReturnType<typeof createLayoutController>;
  pyramid: StubPyramid;
}> {
  const client = twoLayoutClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const pyramid = createStubPyramid(manifest);
  const controller = createLayoutController(createStubCells(), pyramid, client);
  await controller.activate("grid");
  return { controller, pyramid };
}

test("switchTo before anything is active is just an activation", async () => {
  const client = twoLayoutClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const pyramid = createStubPyramid(manifest);
  const controller = createLayoutController(createStubCells(), pyramid, client);

  await controller.switchTo("grid");
  assert.equal(pyramid.activations.length, 1, "activated once");
  assert.equal(pyramid.activations[0].layoutId, "grid");
  assert.equal(pyramid.switchStarts, 0, "no generation bump — this was an activate, not a switch");
});

test("same-layout switchTo is a no-op (no re-activation, no generation bump)", async () => {
  const { controller, pyramid } = await controllerOnGrid();
  await controller.switchTo("grid");
  assert.equal(pyramid.activations.length, 1, "still only the initial activation");
  assert.equal(pyramid.switchStarts, 0);
});

test("switchTo = beginLayoutSwitch + one activateLayout with the target's extent frame — nothing else", async () => {
  const { controller, pyramid } = await controllerOnGrid();

  await controller.switchTo("alt");

  assert.equal(pyramid.switchStarts, 1, "the stale-drop generation was bumped at switch entry");
  assert.equal(pyramid.activations.length, 2, "exactly one activation for the switch");
  const a = pyramid.activations[1];
  assert.equal(a.layoutId, "alt");
  // The frame is the target layout's full bbox — consumed only by the loader's
  // no-camera fallback (production derives the view from its own camera).
  assert.deepEqual(a.frame, { xMin: 0.025, yMin: 0.175, xMax: 0.975, yMax: 0.825 });
});

test("switchTo rejects an undeclared layout without touching the pyramid", async () => {
  const { controller, pyramid } = await controllerOnGrid();
  await assert.rejects(controller.switchTo("nope"), /layout 'nope'/);
  assert.equal(pyramid.switchStarts, 0);
  assert.equal(pyramid.activations.length, 1);
});

test("H2 re-entrancy: two rapid switchTo calls converge on the LAST layout; the superseded call is quiet", async () => {
  const { controller, pyramid } = await controllerOnGrid();

  // Hold the FIRST switch open inside activateLayout so the second lands mid-flight.
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  pyramid.activateGate = () => gate;
  const first = controller.switchTo("alt"); // in flight, gated

  pyramid.activateGate = null; // the second switch resolves immediately
  const second = controller.switchTo("grid");
  await second;
  release!(); // the first switch's activateLayout now settles — LATE
  await first; // must resolve QUIETLY (no rejection)

  // Both activations were issued in call order; the controller's state converged
  // on the LAST target: switching to "grid" again is a no-op, "alt" is not.
  assert.deepEqual(
    pyramid.activations.slice(1).map((a) => a.layoutId),
    ["alt", "grid"],
  );
  const activationsAfter = pyramid.activations.length;
  await controller.switchTo("grid");
  assert.equal(pyramid.activations.length, activationsAfter, "grid is the active layout — no-op");
  await controller.switchTo("alt");
  assert.equal(pyramid.activations.length, activationsAfter + 1, "alt re-activates — grid had won");
});

test("a FAILED switch rejects and leaves the controller retargetable (H5 contract)", async () => {
  const { controller, pyramid } = await controllerOnGrid();

  pyramid.failNextActivate = new Error("pyramid open failed");
  await assert.rejects(controller.switchTo("alt"), /pyramid open failed/);

  // The failed target must NOT be latched: retrying the SAME layout re-activates
  // (a latched target would swallow the retry as a same-layout no-op).
  await controller.switchTo("alt");
  assert.equal(pyramid.activations.at(-1)?.layoutId, "alt", "the retry re-activated the target");
});

test("cells render AT their buffer positions immediately (no tween): setBuffers then pick", () => {
  const { world, emit } = createStubWorld();
  const cells = createCells(world);
  cells.setBuffers({
    ids: BigInt64Array.from([0n]),
    positions: Float32Array.from([0.1, 0.1]),
    sizes: Float32Array.from([0.2, 0.2]), // half-extent 0.1 => spans [0,0.2]^2
    atlasPage: Int32Array.from([0]),
    atlasUv: Float32Array.from([0, 0, 1, 1]),
    lod: Int8Array.from([0]),
    count: 1,
  });
  // Make screen coords == world coords for picking (center 0, zoom 1, 0-size vp).
  emit({ center: [0, 0], zoom: 1 }, { width: 0, height: 0, devicePixelRatio: 1 });
  assert.equal(cells.pick(0.1, 0.1).cellId, 0, "the cell is at its position, instantly");

  // A re-apply with a NEW position (the same id arriving from another layout's
  // tile) moves it in the same call — the instant-swap ground truth.
  cells.setBuffers({
    ids: BigInt64Array.from([0n]),
    positions: Float32Array.from([0.8, 0.8]),
    sizes: Float32Array.from([0.2, 0.2]),
    atlasPage: Int32Array.from([0]),
    atlasUv: Float32Array.from([0, 0, 1, 1]),
    lod: Int8Array.from([0]),
    count: 1,
  });
  assert.equal(cells.pick(0.8, 0.8).cellId, 0, "moved to the new position immediately");
  assert.equal(cells.pick(0.1, 0.1).cellId, null, "left the old position");
  cells.dispose();
});
