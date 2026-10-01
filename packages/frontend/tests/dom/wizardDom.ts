// Shared DOM-tier helpers for the CreateDatasetWizard specs. NOT a spec file — the
// `test:dom` glob is `tests/dom/*.dom.test.ts`, so this is never collected as one
// (same reason `ts-extension-resolver.mjs` can live here).
//
// Extracted at the PR #316 review: `imagesInput`'s selector encodes the wizard's
// markup, and seam A3 (multi-archive) changes that `accept` attribute. Duplicated
// across spec files, that edit is two files, the second one found by a failing test
// rather than by grep.
import { act, cleanup } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { UploadCapsResponse } from "../../src/api-client/types.ts";

/** The wizard's images/archives file input. Selector deliberately in ONE place: it
 *  encodes `accept="image/*,.zip"`, which seam A3 will widen. */
export function imagesInput(container: HTMLElement): Element {
  const el = container.querySelector('input[type="file"][accept="image/*,.zip"]');
  if (el === null) throw new Error("expected the images file input");
  return el;
}

/** Clear localStorage, tolerating a runtime that has none. The wizard persists an
 *  upload session there, so a leaked entry makes the next spec offer Resume. */
export function clearStorage(): void {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
}

/** Give a spec's stub client a caps route that advertises the given ceilings, so the
 *  wizard's mount-time `getUploadCaps` resolves instead of throwing.
 *
 *  Seam L1 is why this exists. The server's bundle-byte bound became live free disk, so
 *  `DEFAULT_UPLOAD_CAPS.maxBundleBytes` is `null` and a client that cannot read the caps
 *  route refuses NOTHING on bytes — which is the point of that change. A DOM spec about a
 *  bundle-byte refusal therefore has to come from a deployment that states a ceiling;
 *  before L1 the compiled-in fallback supplied one to trip over, and specs relied on it.
 *  The numbers a spec passes are that deployment's env, not a default. */
export function servingCaps(client: ApiClient, caps: UploadCapsResponse): ApiClient {
  return {
    ...(client as unknown as Record<string, unknown>),
    getUploadCaps(): Promise<UploadCapsResponse> {
      return Promise.resolve(caps);
    },
  } as unknown as ApiClient;
}

/** Flush the mount-time caps read and React's handling of it, so an assertion sees the
 *  SERVED caps rather than the first frame's fallback.
 *
 *  Unbounded on purpose, unlike `upload_caps.dom.test.ts`'s `afterCapsSettle`: that file
 *  awaits a marker the stub resolves and needs a timeout so a dropped fetch cannot hang
 *  forever. Here the caps are already resolved before the flush, so a fetch the wizard
 *  never issues cannot block this — it fails the refusal assertion that follows, by name.
 *  Two ticks: one for the `await getUploadCaps()` continuation, one for the setState it
 *  schedules.
 *
 *  What is load-bearing here is the CALL SITE's `await`, not this body — measured, and
 *  worth writing down so nobody trusts the wrapper for more than it does. Emptying this
 *  function left all 231 DOM specs green (a caller `await`ing an async no-op still yields
 *  the microtasks the caps continuation needs), while deleting one `await
 *  settleServedCaps()` line failed that spec alone. The `act` wrapper stays because it
 *  puts the resulting setState inside an act scope — React's own requirement, and the
 *  same shape `afterCapsSettle` uses — not because the two ticks are doing the work. */
export async function settleServedCaps(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The standard per-spec isolation for wizard DOM specs: a clean storage before, and
 *  an unmounted tree plus clean storage after. Call at module scope, passing the
 *  runner's hooks (node:test's `beforeEach`/`afterEach` are not importable here in a
 *  way that binds to the calling file's suite). */
export function useWizardDomIsolation(
  beforeEach: (fn: () => void) => void,
  afterEach: (fn: () => void) => void,
): void {
  beforeEach(clearStorage);
  afterEach(() => {
    cleanup();
    clearStorage();
  });
}
