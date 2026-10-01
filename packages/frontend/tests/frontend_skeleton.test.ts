// Tier-1 skeleton test (zero new dependencies — Node's built-in test runner).
// Run with: npm test  (node --test --experimental-strip-types tests/)
// Requires Node >= 22.6 for TypeScript type-stripping.
//
// Renderer factories are implemented (seam 11): they construct working,
// GL-free objects against stub collaborators. createWorld is the one factory
// that inherently needs a WebGL canvas, so it is asserted to fail for a GL
// reason — never the skeleton's "not implemented". The api-client factory is
// real (seam 12) and asserted method-complete below. The "types compile" half
// of Tier-1 is covered by `npm run typecheck` (tsc --noEmit over src/).
import assert from "node:assert/strict";
import test from "node:test";

import { createWorld } from "../src/renderer/world.ts";
import { createCells } from "../src/renderer/cells.ts";
import { createTilePyramid } from "../src/renderer/tilePyramid.ts";
import { createLayoutController } from "../src/renderer/layout.ts";
import { createApiClient } from "../src/api-client/client.ts";
import { LayoutSwitcher } from "../src/ui/LayoutSwitcher.ts";
import { MetadataPanel } from "../src/ui/MetadataPanel.ts";
import { TagControls } from "../src/ui/TagControls.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import type { World } from "../src/renderer/world.ts";

const NOT_IMPL = /not implemented/;

test("factories are exported as functions", () => {
  for (const fn of [createWorld, createCells, createTilePyramid, createLayoutController, createApiClient]) {
    assert.equal(typeof fn, "function");
  }
});

test("catalogued UI components are real (seam 12 — deeper smokes in ui_components.test.ts)", () => {
  for (const component of [LayoutSwitcher, MetadataPanel, TagControls]) {
    assert.equal(typeof component, "function");
  }
});

test("api-client factory builds a client with every catalogued method (seam 12)", () => {
  const client = createApiClient("http://localhost");
  const methods = [
    "listDatasets",
    "getDataset",
    "listLayouts",
    "getManifest",
    // D-xv: the presentation record, read on the same boot as the layout list.
    "getPresentation",
    // v2 (D-33): the pyramid container + detail-tier originals + the bearer
    // header builder replace tileUrl/tileIndexUrl/fetchTile/atlasUrl.
    "pyramidUrl",
    "detailUrl",
    "authHeaders",
    "tagsUrl",
    "fetchTags",
    "getMetadata",
    "createDataset",
    "getJob",
    "signup",
    "login",
    "me",
    // seam-12 additions (brief §2 route coverage: DELETE + uploads)
    "deleteDataset",
    "createUpload",
    "uploadPart",
    "finalizeUpload",
    "getUploadStatus",
    // Seam O4: XHR progress transport + the O2 resume surface the client consumes.
    "uploadPartWithProgress",
    "listUploads",
    "listUploadFiles",
    "checkUploadFiles",
  ] as const;
  for (const method of methods) {
    assert.equal(typeof client[method], "function", `ApiClient.${method}`);
  }
});

test("renderer factories construct working objects (GL-free)", () => {
  const world = {
    scene: { add() {}, remove() {} },
    camera: {},
    renderer: {},
    maxTextureSize: 4096,
    resize() {},
    onCameraChange: () => () => {},
    start() {},
    dispose() {},
  } as unknown as World;
  const client = {} as ApiClient; // never called during construction
  const manifest = {
    manifest_version: "2.1",
    dataset_id: "ds",
    dataset_version: 1,
    layouts: [],
    dataset_metadata: { image_count: 0, ingest_timestamp: "2026-01-01T00:00:00Z" },
  } as LayoutManifest;

  const cells = createCells(world);
  const pyramid = createTilePyramid(world, cells, client, manifest);
  const controller = createLayoutController(cells, pyramid, client);

  for (const method of ["setBuffers", "setAtlasTexture", "setVisibility", "pick", "dispose"] as const) {
    assert.equal(typeof cells[method], "function", `Cells.${method}`);
  }
  for (const method of ["onCameraChange", "activateLayout", "beginLayoutSwitch"] as const) {
    assert.equal(typeof pyramid[method], "function", `TilePyramid.${method}`);
  }
  for (const method of ["activate", "switchTo", "applyTags"] as const) {
    assert.equal(typeof controller[method], "function", `LayoutController.${method}`);
  }
  assert.deepEqual(cells.pick(0, 0), { cellId: null });
  assert.equal(pyramid.residentTileCount(), 0);
  assert.equal(pyramid.activeLayoutId(), null);
  cells.dispose();
});

test("createWorld needs a real WebGL canvas — fails for a GL reason, not 'not implemented'", () => {
  const fakeCanvas = {
    getContext: () => null,
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    style: {},
    width: 800,
    height: 600,
  } as unknown as HTMLCanvasElement;
  assert.throws(
    () => createWorld(fakeCanvas, { width: 800, height: 600, devicePixelRatio: 1 }),
    (err: unknown) => !NOT_IMPL.test(String(err)),
  );
});
