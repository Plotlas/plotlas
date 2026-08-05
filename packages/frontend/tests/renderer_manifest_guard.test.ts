// Manifest guard: a manifest whose manifest_version major is not 2 is rejected
// with a clear error; "2.0" and "2.1" are accepted. v2 (decision D-33) is a
// clean break — v1.x majors are refused. (Full runtime schema validation is
// issue #4 in ApiClient.getManifest, not here.)
import assert from "node:assert/strict";
import test from "node:test";

import { checkManifestVersion, createLayoutController } from "../src/renderer/layout.ts";
import type { LayoutManifest } from "../src/renderer/layout.ts";
import { createFakeClient, createStubCells, createStubPyramid } from "./fake_client.ts";

function manifestWithVersion(version: string): LayoutManifest {
  return { manifest_version: version } as LayoutManifest;
}

test("checkManifestVersion accepts major 2, rejects everything else", () => {
  checkManifestVersion(manifestWithVersion("2.0"));
  checkManifestVersion(manifestWithVersion("2.1"));
  checkManifestVersion(manifestWithVersion("2.2")); // the positions_ref MINOR (v2.2)
  checkManifestVersion(manifestWithVersion("2.3")); // the scatter-knob `options` MINOR (v2.3)
  assert.throws(() => checkManifestVersion(manifestWithVersion("1.0")), /major version 2/);
  assert.throws(() => checkManifestVersion(manifestWithVersion("1.1")), /major version 2/);
  assert.throws(() => checkManifestVersion(manifestWithVersion("3.0")), /major version 2/);
  assert.throws(() => checkManifestVersion(manifestWithVersion("garbage")), /unparseable/);
});

async function activateWithVersion(version: string): Promise<void> {
  const client = createFakeClient(undefined, {
    doctorManifest: (m) => ({ ...m, manifest_version: version }),
  });
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(createStubCells(), createStubPyramid(manifest), client);
  await controller.activate("grid");
}

test("activate accepts every 2.x minor the pipeline has written", async () => {
  await activateWithVersion("2.0");
  await activateWithVersion("2.1");
  await activateWithVersion("2.2"); // the positions_ref MINOR (v2.2)
  await activateWithVersion("2.3"); // the scatter-knob `options` MINOR — the pipeline now writes 2.3
});

test("activate rejects a major-1 manifest with a clear error", async () => {
  await assert.rejects(activateWithVersion("1.0"), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /manifest_version '1\.0'/);
    assert.match(err.message, /major version 2/);
    return true;
  });
});

test("activate rejects an unknown layout id with a clear error", async () => {
  const client = createFakeClient();
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const controller = createLayoutController(createStubCells(), createStubPyramid(manifest), client);
  await assert.rejects(controller.activate("does-not-exist"), /layout 'does-not-exist'/);
});
