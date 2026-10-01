# The e2e tier — what it is for, and where each spec runs

Playwright specs that drive a **real browser** against a **running stack**. This is the
only tier that can see what actually reaches the canvas: the GL-free unit tests
(`npm run test`) and the jsdom DOM tests (`npm run test:dom`) do no layout and have no
WebGL, so three visual regressions have shipped past green unit tests in this repo's
history.

Full rationale and the decisions behind it: [`docs/plan/SCOPE_e2e-strategy.md`](../../../docs/plan/SCOPE_e2e-strategy.md).

---

## The one constraint that explains everything else

**These specs can only drive a DEVELOPMENT build.**

Every spec reads `window.__vizDebug` — directly, or through the `openViewer` /
`openViewerV2` helpers that wait on it before doing anything else. Every call site that
publishes it sits behind `vizDebugAvailable`, which is `import.meta.env.DEV`
(`src/renderer/debug.ts`). A `vite build` sets that `false`, so **a production bundle
never assigns `window.__vizDebug`** and every spec hangs on its first waiter.

Three consequences, all of which have cost real time:

- **You cannot point this suite at `app.plotlas.com`.** Not "it would be flaky" — it
  cannot work at all. The retired `e2e-nightly.yml` had an `E2E_BASE_URL` repo variable
  that was never set for its entire life, and this is why: its most obvious value was
  never a valid one.
- **You cannot point it at a local stack running the prod profile either.**
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml up` serves a built
  bundle. Check with `curl -s localhost:8080/ | grep @vite/client` — if that finds
  nothing, the suite will not run against it.
- **The Cloudflare / PMTiles Range question ([[T2-200]]) is not reachable by this suite**
  in any configuration, because answering it requires the production edge and therefore a
  production build. That needs a different instrument.

---

## Where the specs run

| Spec | Runs in | Asks |
|---|---|---|
| `render-gate.spec.ts` | `render-gate.yml` (every non-docs PR) | v2 loader live, real content drawn, zoom deepens the level, resident tile set stays bounded, never grey on a still camera; plus the auth-gated detail route |
| `contextloss.spec.ts` | same | a forced WebGL context loss recovers in place, and the watchdog prompts when it cannot |
| `renderer-transition.spec.ts` | same | the instant layout swap starts immediately, never blanks, and sharpens |
| `mobile-viewport.spec.ts` | same | the viewer contains itself at 390×844 |
| `mobile-pinch.spec.ts` | same | a real two-finger pinch changes the zoom |
| `narrow-cockpit.spec.ts` | same | narrow-screen layout model + desktop non-regression |
| `touch-surfaces.spec.ts` | same | hit areas, status bar and lightbox at both widths |
| `capture/hero.spec.ts` | nothing — `testIgnore`d | not a gate; a marketing asset generator, run deliberately via `capture.config.ts` |

**Every spec in this directory runs in a workflow that actually fires.** Keep it that way:
a spec parked in a workflow with no trigger reads as coverage in review while testing
nothing, which is exactly how `renderer-transition.spec.ts` went unexecuted for months and
accumulated three separate wrong beliefs about the API it was testing.

The gate boots its own compose stack and drives two committed fixtures:
`calib_small_v2` (256 cells, 1 layout, a coarse + a fine band) and
`golden_dataset_full_v2` (256 cells, 6 layouts, `z_cap` up to 3, a tags sidecar).

---

## What the PR gate structurally cannot cover

The committed fixtures are 256 solid-colour calibration squares. That is the right oracle
for "is this cell in the right place" and useless for anything else:

- **Scale** ([[T2-41]]) — tile fan-out, VRAM and load latency at 10k / 100k / 1M.
- **Real imagery** — photographic content, not flat colour.
- **The detail overlay ENGAGING** ([[T2-248]]) — neither committed fixture has both a
  `detail/` tier and `positions_ref`; they are exact complements, so the gate can only
  assert the overlay stays bounded, never that it turns on.
- **Gesture feel** — no CI tier gates this. The real-device pass is still the only one.

The first three are answered by **running the suite locally against a real dataset**.

---

## Running it locally against a big, real dataset

This is the [[T2-41]] scale check. It needs no public URL, no standing credential, and no
CI runner that can reach your machine.

**1. Bring up a dev-profile stack** (from the repo root — the BASE compose file, no prod
override, because of the constraint at the top of this file):

```bash
docker compose up -d --build
```

> **Run this from the checkout you actually mean to test.** `docker-compose.yml` mounts
> `.:/repo` into the `frontend` service, so compose serves whichever working tree it was
> invoked from. Starting the stack from `~/Repos/image-viz` and then driving specs from a
> worktree measures **main's frontend** while you believe you are measuring your branch —
> a silently wrong answer, not an error.

**2. Make sure the dataset is visible.** Under D-34 a dataset with no app-state row is
invisible to every caller, and a private one is visible only to its owner:

```bash
docker compose exec -T api python -m api.admin list-datasets
```

A `public` dataset needs no credentials — `helpers.authenticate` falls back to creating a
throwaway account, which can read public datasets. For a `private` one, set
`E2E_USERNAME` / `E2E_PASSWORD` to its owner.

**3. Run a spec.** There is no `npx` on the host in this project's environment (Node lives
in containers), so drive Playwright from its official image. The image tag **must match**
the `@playwright/test` version in `package.json`:

```bash
MSYS_NO_PATHCONV=1 docker run --rm --ipc=host -v "$PWD:/repo" -w /repo/packages/frontend/e2e -e E2E_DATASET=inat1m_v2 -e ZOOM_BATCHES=40 -e E2E_CHROMIUM_ARGS="--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox --ignore-gpu-blocklist" mcr.microsoft.com/playwright:v1.62.1-noble sh -c "npm ci && npx playwright test render-gate.spec.ts"
```

Notes on that command:

- `BASE_URL` is deliberately **not set** — `playwright.config.ts` already defaults to
  `http://host.docker.internal:8080`, which is how a container reaches the host's
  published caddy port. Set `BASE_URL` only when driving something else.
- `MSYS_NO_PATHCONV=1` is required in Git Bash on Windows, or the `-v` path is rewritten
  and the mount silently fails.
- `E2E_CHROMIUM_ARGS` supplies software GL. A container has no GPU, so without it Chromium
  refuses a WebGL context and the canvas is blank. **This also means a containerised run
  measures logic, not GPU performance** — residency bounds and never-grey are meaningful;
  frame timings are not.
- `ZOOM_BATCHES` must grow with pyramid depth (10k ≈ 5 levels, 1M = 8). `RESIDENT_TILE_CAP`
  (default 400) is the bound asserting residency tracks the VIEWPORT, not the cell count.

### Worked example — `inat1m_v2`, measured 2026-08-23

```
[gate:inat1m_v2] initial selectedZ=1 zCap=7 maxZ=7 resident=0 totalCells=0
[gate:inat1m_v2] initial canvas PNG bytes=1020570
[gate:inat1m_v2] after zoom selectedZ=7 resident=32 maxResidentSeen=32 maxLoadingSeen=48 placeholderInView=0
[gate:inat1m_v2] detail overlayCells=2
  ✓  v2 pyramid render gate — bounded, sharpening, never-grey (2.2m)
```

Read that as: 8 pyramid levels; zooming reached the deepest; **32 resident tiles against a
cap of 400** at one million cells, which is the scale claim — residency is governed by the
viewport, not the collection; **zero grey cells in view**; a 1 MB canvas screenshot, so
real content is drawn; and the **detail overlay engaged** (`overlayCells=2`), which no
committed fixture can show.

### One expected failure on a PUBLIC dataset

`render-gate.spec.ts`'s second test asserts that an **unauthenticated** detail fetch is
rejected with a D-34 non-disclosure `404`. That is correct for the CI fixture, which is
private. Against a **public** dataset an unauthenticated read is supposed to return `200`,
so this test fails by design:

```
Error: unauthed detail fetch was NOT rejected with the D-34 non-disclosure 404
Expected: 404   Received: 200
```

That is the dataset's visibility, not a regression. Run the first test alone with
`--grep "pyramid render gate"` if the noise is unhelpful.

---

## Type-checking

This directory is its own TypeScript project (`tsconfig.json`) because `@playwright/test`
lives in its own `node_modules` and is unresolvable from `packages/frontend`. It runs in
`ci.yml`'s `test-frontend` job on every PR:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD/packages/frontend/e2e:/e2e" -w /e2e node:22 sh -c "npm ci && npm run typecheck"
```

**Know what it does and does not catch.** It catches a spec referencing a helper, export or
`VizV2` field that does not exist — which previously surfaced only after a full stack boot,
as a runtime `undefined is not a function`. It does **not** catch:

- a wrong belief about an API response shape, when the spec states it with an `as` cast —
  the compiler treats a cast as a promise, not a claim. `renderer-transition.spec.ts` read
  `{layouts: [...]}` as a bare array for months and `tsc` was happy;
- a URL that no longer exists, which is just a string;
- the duplicated `TOKEN_KEY` / `USERNAME_KEY` constants in `helpers.ts` ([[T2-249]]), which
  are duplicated on purpose so the suite never imports from `src`.

Only running the specs catches those. That is the point of this tier.
