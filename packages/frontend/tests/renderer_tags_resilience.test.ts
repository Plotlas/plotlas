// T2-120 (Fix B + C): the renderer-side tag resilience the 49k rijks_pilot review
// exposed.
//
//  Fix B — ensureTags must NOT latch a failure forever. The old code set tagsLoaded
//    BEFORE the fetch, so any transient error (the 401 spiral) disabled tag filtering
//    permanently and console-only. Now a failure is RETRYABLE: the next applyTags (or
//    an explicit retry) re-attempts the load, and the failure is SURFACED to the UI via
//    setTagStateListener (status 'unavailable') instead of a silent no-op.
//
//  Fix C — applyTags returns the HONEST match count (the visibility array's sum), the
//    figure the status bar reports ("N of M match"), replacing the misleading chip
//    count. (The pure evaluation itself is proven exact in renderer_tags.test.ts; here
//    we prove the count reaches the controller's return / status model.)
//
// GL-free, over the committed golden fixture (10 cells: even ids carry [a,b], odd carry
// [b,c]) with a flaky client that fails the sidecar fetch a controllable number of times.
import assert from "node:assert/strict";
import test from "node:test";

import { createLayoutController } from "../src/renderer/layout.ts";
import type { TagRenderState, TagSelection } from "../src/renderer/layout.ts";
import type { ApiClient } from "../src/api-client/client.ts";
import { createFakeClient, createStubCells, createStubPyramid } from "./fake_client.ts";

function sel(mode: "and" | "or", ...values: string[]): TagSelection {
  return { mode, selected: values.map((value) => ({ column: "tags", value })) };
}

/** Wrap the disk-backed fake client so its tag-sidecar fetch FAILS the first
 *  `failFirst` calls (simulating the static-edge 401), then succeeds from disk. */
function flakyTagsClient(failFirst: number): { client: ApiClient; fetchCalls: () => number } {
  const base = createFakeClient();
  let calls = 0;
  const client: ApiClient = {
    ...base,
    async fetchTags(url: string, signal?: AbortSignal) {
      calls += 1;
      if (calls <= failFirst) throw new Error("tag sidecar fetch failed (simulated 401)");
      return base.fetchTags(url, signal);
    },
  };
  return { client, fetchCalls: () => calls };
}

test("Fix B: a failed sidecar load does NOT latch — it surfaces 'unavailable' and RETRIES on the next apply", async () => {
  const { client, fetchCalls } = flakyTagsClient(1); // first fetch throws, then succeeds
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const cells = createStubCells();
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);

  const states: TagRenderState[] = [];
  let resolveOk: () => void;
  const becameOk = new Promise<void>((r) => {
    resolveOk = r;
  });
  controller.setTagStateListener((st) => {
    states.push(st);
    if (st.status === "ok") resolveOk();
  });

  await controller.activate("grid"); // the FIRST sidecar fetch throws inside ensureTags
  assert.equal(fetchCalls(), 1, "the sidecar was attempted once during activate");

  // The failure is SURFACED (not console-only) and did not abort activation.
  assert.ok(
    states.some((s) => s.status === "unavailable"),
    "the renderer surfaced the tag-load failure to the UI listener",
  );

  // Un-latched: applying a selection RE-ATTEMPTS the load. The synchronous return still
  // reports 'unavailable' (nothing resident yet), but a retry is now in flight.
  const immediate = controller.applyTags(sel("or", "a"));
  assert.equal(immediate.status, "unavailable", "still unavailable at the instant of apply");
  assert.equal(cells.visibilityReceived.length, 0, "nothing applied while the sidecar is absent");

  await becameOk; // the retry's fetch (2nd call) succeeds and re-applies the remembered selection
  assert.equal(fetchCalls(), 2, "the failure was retryable — a second fetch was issued");
  // T2-121 single-source: the retry re-applies the remembered selection through the
  // highlight overlay (no World here → no overlay), NOT cells.setVisibility — so the proof
  // the retry took visible effect is the honest match count reaching the state listener
  // (the remembered 'or a' → the 5 even cells of 10). The overlay's own re-apply-on-retry
  // is covered in highlight_overlay.test.ts.
  assert.equal(cells.visibilityReceived.length, 0, "no shader dim applied on retry (routes to the overlay)");
  assert.deepEqual(states.at(-1), { status: "ok", matched: 5, total: 10 }, "final state is ok with the honest count");
});

test("Fix C: applyTags returns the HONEST match count (visibility sum), not the chip count", async () => {
  const client = createFakeClient(); // healthy
  const manifest = await client.getManifest("golden_dataset_v2", "grid");
  const cells = createStubCells();
  const controller = createLayoutController(cells, createStubPyramid(manifest), client);
  await controller.activate("grid");

  // 'or a' → the 5 even cells match (chip count would be 1 — the honest count is 5).
  assert.deepEqual(controller.applyTags(sel("or", "a")), { status: "ok", matched: 5, total: 10 });
  // 'or a,c' → every cell matches → 10 (chip count would be 2).
  assert.deepEqual(controller.applyTags(sel("or", "a", "c")), { status: "ok", matched: 10, total: 10 });
  // 'and a,c' → no cell carries both → 0 matches (chip count would be 2).
  assert.deepEqual(controller.applyTags(sel("and", "a", "c")), { status: "ok", matched: 0, total: 10 });
  // Empty selection → all visible → total.
  assert.deepEqual(controller.applyTags(sel("or")), { status: "ok", matched: 10, total: 10 });
});

test("Fix B/C: an images-only dataset reports status 'none' with a full match count and no retry", async () => {
  const client = createFakeClient(); // golden fixture DOES declare tags — doctor them away
  const raw = await client.getManifest("golden_dataset_v2", "grid");
  const noTags = { ...raw, tags: null };
  const noTagsClient: ApiClient = {
    ...client,
    async getManifest() {
      return noTags;
    },
  };
  const cells = createStubCells();
  const controller = createLayoutController(cells, createStubPyramid(noTags), noTagsClient);
  await controller.activate("grid");

  const state = controller.applyTags(sel("or", "a"));
  assert.equal(state.status, "none", "no sidecar declared ⇒ 'none' (nothing to retry)");
  assert.equal(state.matched, state.total, "everything is visible when there is nothing to filter");
  assert.equal(cells.visibilityReceived.length, 0, "images-only applyTags stays a visibility no-op");
});
