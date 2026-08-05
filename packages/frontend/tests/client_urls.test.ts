// Tier-1: v2 URL composition. pyramidUrl prefers the STATIC Caddy path once the
// manifest is cached (immutable pyramid.path) and falls back to the FastAPI route
// (GET /api/datasets/{ds}/pyramid/{layout}.pmtiles) before it; detailUrl composes
// the FastAPI detail route (.../detail/{cell_id}.{ext}); tagsUrl composes the
// static tag-sidecar asset; authHeaders attaches the bearer. No double slashes.
// GL-free, dependency-free: mocked globalThis.fetch only.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiClient } from "../src/api-client/client.ts";

const FIXTURES_DIR = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));
const GOLDEN = join(FIXTURES_DIR, "golden_dataset_v2"); // legacy un-stamped detail block (`detail/`)
const IMAGES_ONLY = join(FIXTURES_DIR, "golden_dataset_images_only_v2");
const CALIB_SMALL = join(FIXTURES_DIR, "calib_small_v2"); // version-stamped detail block (`detail/v1/`)

function manifestJson(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, "layout_manifest.json"), "utf8"));
}

/** Install a fetch mock for the duration of one test. */
function withFetch(t: { after: (fn: () => void) => void }, handler: typeof fetch): void {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("pyramidUrl / detailUrl compose the v2 read routes; no double slashes", async (t) => {
  withFetch(t, (async () => jsonResponse(manifestJson(GOLDEN))) as typeof fetch);
  // Trailing slash on baseUrl must not produce a double slash.
  const client = createApiClient("http://edge/", () => "tok");
  await client.getManifest("golden_dataset_v2", "grid");

  // Manifest cached (getManifest above) -> the STATIC Caddy path from pyramid.path.
  const pyramid = client.pyramidUrl("golden_dataset_v2", "grid");
  assert.equal(pyramid, "http://edge/datasets/golden_dataset_v2/tiles/grid/grid_v1.pmtiles");

  // golden_dataset_v2's detail block is the LEGACY un-stamped `detail/` shape, so
  // detailUrl composes the un-versioned route (the immutable versioned route is only
  // taken when the manifest declares `detail/v{N}/` — see the next test).
  const detail = client.detailUrl("golden_dataset_v2", 7, "webp");
  assert.equal(detail, "http://edge/api/datasets/golden_dataset_v2/detail/7.webp");

  // A leading-dot extension is normalized.
  assert.equal(
    client.detailUrl("golden_dataset_v2", 3, ".jpeg"),
    "http://edge/api/datasets/golden_dataset_v2/detail/3.jpeg",
  );

  const tags = client.tagsUrl("golden_dataset_v2", 1);
  assert.equal(tags, "http://edge/datasets/golden_dataset_v2/tags/tags_v1.arrow");

  // coverUrl (T2-55): the auth-gated Library-card cover route, a pure builder (no
  // manifest) — the trailing-slash baseUrl must not produce a double slash.
  const cover = client.coverUrl("golden_dataset_v2");
  assert.equal(cover, "http://edge/api/datasets/golden_dataset_v2/cover");

  // T2-26: staticDetailUrl is the overlay's BURST path — the DB-free static edge, NOT
  // the /api detail route. golden's detail block is the legacy un-stamped `detail/`
  // prefix, so it composes the un-versioned STATIC path (still the edge).
  const staticDetail = client.staticDetailUrl("golden_dataset_v2", 7);
  assert.equal(staticDetail, "http://edge/datasets/golden_dataset_v2/detail/7.webp");

  for (const url of [pyramid, detail, tags, cover, staticDetail]) {
    assert.ok(!url.slice("http://".length).includes("//"), `double slash in ${url}`);
  }
});

test("detailUrl composes the VERSIONED immutable route when the manifest is version-stamped (T2-80)", async (t) => {
  // calib_small_v2's grid layout declares a version-stamped detail block
  // (`detail.path_prefix` == "detail/v1/"), which the producer bakes as
  // `detail/v{dataset_version}/`. Once the manifest is cached, detailUrl derives the
  // version from that prefix and composes the immutable versioned route — matching
  // the API's GET /api/datasets/{ds}/detail/v{version}/{cell_id}.{ext} (which
  // validates the URL's version against dataset_version, == 1 here by construction).
  withFetch(t, (async () => jsonResponse(manifestJson(CALIB_SMALL))) as typeof fetch);
  const client = createApiClient("http://edge", () => "tok");
  await client.getManifest("calib_small_v2", "grid");

  const detail = client.detailUrl("calib_small_v2", 7, "webp");
  assert.equal(detail, "http://edge/api/datasets/calib_small_v2/detail/v1/7.webp");
  // Leading-dot extension is still normalized on the versioned path.
  assert.equal(
    client.detailUrl("calib_small_v2", 3, ".jpeg"),
    "http://edge/api/datasets/calib_small_v2/detail/v1/3.jpeg",
  );
  assert.ok(!detail.slice("http://".length).includes("//"), `double slash in ${detail}`);

  // T2-26: staticDetailUrl composes the VERSIONED immutable STATIC path (the edge),
  // reusing the same version-prefix parse — the overlay's burst path for this dataset.
  const staticDetail = client.staticDetailUrl("calib_small_v2", 7);
  assert.equal(staticDetail, "http://edge/datasets/calib_small_v2/detail/v1/7.webp");
  assert.ok(!staticDetail.slice("http://".length).includes("//"), `double slash in ${staticDetail}`);
});

test("pyramidUrl falls back to the /api route pre-manifest; detailUrl falls back to the legacy route", () => {
  const client = createApiClient("http://edge");
  // No getManifest yet -> pyramidUrl cannot know the versioned static path, so it
  // composes the FastAPI fallback route (the token-gated dev path). detailUrl has no
  // cached manifest either, so it composes the LEGACY un-versioned route (T2-80 only
  // upgrades to the versioned route once a version-stamped manifest is cached).
  assert.equal(
    client.pyramidUrl("ds", "grid"),
    "http://edge/api/datasets/ds/pyramid/grid.pmtiles",
  );
  assert.equal(client.detailUrl("ds", 0, "png"), "http://edge/api/datasets/ds/detail/0.png");
  // T2-26: staticDetailUrl has no cached manifest either, so it falls back to the
  // authed /api detail route (the only pre-manifest option; the overlay never bursts
  // before a manifest is cached).
  assert.equal(client.staticDetailUrl("ds", 0), "http://edge/api/datasets/ds/detail/0.webp");
});

test("authHeaders attaches the bearer when a token is present, else nothing", () => {
  let token: string | null = "tok";
  const client = createApiClient("http://edge", () => token);
  assert.deepEqual(client.authHeaders(), { Authorization: "Bearer tok" });
  token = null;
  assert.deepEqual(client.authHeaders(), {});
  token = "";
  assert.deepEqual(client.authHeaders(), {});
});

test("tagsUrl refuses a dataset whose manifest declares no tags sidecar (D-14)", async (t) => {
  withFetch(t, (async () => jsonResponse(manifestJson(IMAGES_ONLY))) as typeof fetch);
  const client = createApiClient("http://edge");
  await client.getManifest("golden_dataset_images_only_v2", "grid");
  assert.throws(() => client.tagsUrl("golden_dataset_images_only_v2", 1), /no tags sidecar/);
});

test("positionsUrl composes the static asset when the layout declares positions_ref (v2.2)", async (t) => {
  // A doctored manifest that carries a positions_ref (the minimal golden fixture is
  // baked pre-2.2, so it has none — see the graceful-absence test below).
  const doctored = manifestJson(GOLDEN) as {
    layouts: { layout_id: string; positions_ref?: string }[];
  };
  doctored.layouts[0].positions_ref = "positions/grid_v1.arrow";
  withFetch(t, (async () => jsonResponse(doctored)) as typeof fetch);
  const client = createApiClient("http://edge/", () => "tok");
  await client.getManifest("golden_dataset_v2", "grid");

  const url = client.positionsUrl("golden_dataset_v2", "grid");
  assert.equal(url, "http://edge/datasets/golden_dataset_v2/positions/grid_v1.arrow");
  assert.ok(!url!.slice("http://".length).includes("//"), `double slash in ${url}`);
});

test("positionsUrl returns null when the layout declares no positions_ref (graceful absence)", async (t) => {
  // The committed minimal fixture is baked pre-2.2, so its grid layout carries no
  // positions_ref — the client returns null and the caller keeps fine-tier-only pick.
  withFetch(t, (async () => jsonResponse(manifestJson(GOLDEN))) as typeof fetch);
  const client = createApiClient("http://edge");
  await client.getManifest("golden_dataset_v2", "grid");
  assert.equal(client.positionsUrl("golden_dataset_v2", "grid"), null);
});

test("positionsUrl throws if the manifest for the dataset was never fetched", () => {
  const client = createApiClient("http://edge");
  assert.throws(() => client.positionsUrl("ds", "grid"), /has not been fetched yet/);
});
