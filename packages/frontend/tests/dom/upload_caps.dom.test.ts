// DOM tier (Seam A2): the wizard pre-flights against the DEPLOYMENT's upload caps.
// A selection nothing refuses by default is refused once the server advertises a
// MAX_UPLOAD_BUNDLE_BYTES it breaches — that is the whole seam — and a caps read that
// fails degrades to DEFAULT_UPLOAD_CAPS instead of blocking the upload. Runs under jsdom
// via test:dom. Assertions compare counts and text, never a raw node.
//
// Seam A3 moved WHICH cap demonstrates this. These specs were written against
// MAX_UPLOAD_PART_BYTES, which is no longer a pre-flight refusal at all: an over-cap
// file is chunked by the transport (`client.uploadPartWithProgress`), so a spec asserting
// it is refused would now be pinning a defect. The property under test is unchanged —
// this deployment's numbers reach the browser — and the whole-bundle byte cap is the
// remaining lever the pre-flight acts on.
//
// Seam L1 then reversed the DIRECTION these specs demonstrate it in. The server's bundle
// bound became live free disk, so there is no compiled-in ceiling for the fallback to
// mirror and `DEFAULT_UPLOAD_CAPS.maxBundleBytes` is null: the transition to assert is
// accepted-then-refused (a served ceiling ARRIVING), not refused-then-accepted. The
// specs that ran the other way were pinning a client-side invention which refused
// uploads the server would take, before the first byte — the L1 review's finding 6.
//
// The failure-path specs assert on the SETTLED state: the wizard's fallback is "leave
// DEFAULT_UPLOAD_CAPS in place", which is indistinguishable from "the read has not
// come back yet" if you only waitFor. So the stub hands back a settle marker and the
// specs await it (plus an act flush) before asserting. Measured 2026-08-28: without
// that marker, mutating the catch block to degrade to UNLIMITED caps left both specs
// GREEN — they were passing on the pre-settle frame.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { UploadCapsResponse } from "../../src/api-client/types.ts";
import { CreateDatasetWizard } from "../../src/ui/admin/CreateDatasetWizard.ts";
import { DEFAULT_UPLOAD_CAPS } from "../../src/ui/admin/uploadSelection.ts";
import { imagesInput, useWizardDomIsolation } from "./wizardDom.ts";

interface CapsStub {
  client: ApiClient;
  /** Resolves once getUploadCaps' promise has settled (fulfilled OR rejected). */
  settled: Promise<void>;
  /** How many times the wizard actually called getUploadCaps. */
  calls: () => number;
}

/** A client that serves the given caps (or rejects with the given Error). `listUploads`
 *  is the only other method the wizard can reach without a submit click. */
function capsClient(caps: UploadCapsResponse | Error): CapsStub {
  let markSettled = (): void => {};
  let calls = 0;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  const client = {
    async listUploads() {
      return [];
    },
    getUploadCaps(): Promise<UploadCapsResponse> {
      calls += 1;
      const answer =
        caps instanceof Error ? Promise.reject(caps) : Promise.resolve(caps);
      return answer.finally(markSettled) as Promise<UploadCapsResponse>;
    },
  } as unknown as ApiClient;
  return { client, settled, calls: () => calls };
}

/** Await the caps read AND the wizard's handling of it, so an assertion sees the
 *  settled caps rather than the initial frame.
 *
 *  BOUNDED, and that is the point (PR #316 review, finding 6). `settled` can only be
 *  resolved from inside the stub's getUploadCaps, so if a refactor drops or
 *  conditionalises the mount-time fetch this await would never return — and
 *  `test:dom` passes no `--test-timeout`, so node:test's default is Infinity. An
 *  un-run gate is indistinguishable from a passing one. The call-count assertion
 *  turns that hang into a named failure on the first tick; the timer is the backstop
 *  for a fetch that is issued but never settles. */
async function afterCapsSettle(stub: CapsStub): Promise<void> {
  assert.equal(
    stub.calls() >= 1,
    true,
    "the wizard never called getUploadCaps — the mount-time caps read is gone, so this spec would otherwise hang forever",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("getUploadCaps was called but never settled within 2s")),
      2000,
    );
  });
  try {
    await Promise.race([stub.settled, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// This deployment's advertised whole-bundle ceiling, and a selection over it. The number
// is the spec's own (it is an env value on a server, not a default): since seam L1 the
// fallback states no bundle-byte ceiling, so nothing here can be derived from it.
const ADVERTISED_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const OVER_ADVERTISED_BYTES = ADVERTISED_BUNDLE_BYTES + 1;

function renderWizard(client: ApiClient): HTMLElement {
  const { container } = render(
    h(CreateDatasetWizard, { client, onDone() {}, onAuthExpired() {} }),
  );
  return container;
}

function selectFile(container: HTMLElement, name: string, size: number): void {
  const file = new File([new Uint8Array([1])], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  fireEvent.change(imagesInput(container), { target: { files: [file] } });
}

/** How many "over the bundle limit" refusals are on screen (a count, not a node). */
function refusalCount(): number {
  return screen.queryAllByText(/bundle limit/).length;
}

useWizardDomIsolation(beforeEach, afterEach);

test("a served bundle cap makes the wizard refuse a selection nothing else refuses", async () => {
  const stub = capsClient({
    max_part_bytes: DEFAULT_UPLOAD_CAPS.maxPartBytes,
    max_bundle_bytes: ADVERTISED_BUNDLE_BYTES,
    max_entries: DEFAULT_UPLOAD_CAPS.maxEntries,
  });
  const container = renderWizard(stub.client);
  selectFile(container, "huge.png", OVER_ADVERTISED_BYTES);
  // Accepted on the first frame (the fallback knows no byte ceiling), then refused once
  // the served caps land — the TRANSITION is the seam, so assert both halves. Without the
  // first assertion this spec cannot tell a served refusal from a compiled-in one.
  assert.equal(refusalCount(), 0);
  await waitFor(() => assert.equal(refusalCount() >= 1, true));
});

test("a caps read that FAILS degrades to the compiled-in defaults, not to a guessed cap", async () => {
  // The L1 review's finding 6, at the DOM tier. This spec asserted the OPPOSITE — that a
  // 2 GiB-breaching selection was still refused after a failed read — which was correct
  // only while the server compiled in that same 2 GiB. Once its bound became free disk
  // the fallback was refusing, before the first byte, uploads the server would accept,
  // and `preSubmitProblem` made that refusal a hard submit gate. Degrading means the
  // check that has no basis is DROPPED, not run against a stand-in.
  //
  // **"not to a guessed cap" is half the title, and the OTHER half is "to the compiled-in
  // defaults" — which this spec stopped asserting.** Narrowed to the two lines below it
  // was equivalent to "maxBundleBytes is null": `refusalCount()` matches only the byte
  // message (the entry message says "whole-bundle ceiling", uploadSelection.ts), and the
  // button has no `disabled` binding, so its presence is unconditional. Mutating
  // DEFAULT_UPLOAD_CAPS to `{ maxPartBytes: 1, maxBundleBytes: null, maxEntries:
  // Number.MAX_SAFE_INTEGER }` — degrading to NO caps at all, exactly what the title
  // forbids — left it green (review of PR #304 round 3, finding 18). So the ceiling the
  // fallback still legitimately carries has to be exercised here too: the server really
  // does compile in MAX_UPLOAD_ENTRIES, so mirroring it is not inventing anything, and it
  // is the only cap of the three a DOM spec can observe (maxPartBytes is the transport's
  // chunk size, read by the api-client from its own caps fetch, and is not a pre-flight
  // refusal at all since seam A3).
  //
  // COST, because it is the most expensive spec in this directory and nobody should pay
  // it twice: the breach has to be real, so it is 1,000,001 file objects through the real
  // wizard. Measured 2026-09-05 — 208 ms to build them, 4,092 ms for the selection +
  // render pass (`addFiles`' dedupe Set, `buildImageSelection`, `fingerprintFiles`' sort
  // over 1M names), 448 MB peak heap, 4.4 s total. Cheaper equivalents were considered and
  // rejected: `preflightCaps` is already pinned directly at the unit tier
  // (ui_upload_selection.test.ts), and this tier's job is that the FALLBACK the wizard
  // actually holds after a failed read is the one with the ceiling in it.
  const stub = capsClient(new Error("caps route unreachable"));
  const container = renderWizard(stub.client);
  selectFile(container, "huge.png", OVER_ADVERTISED_BYTES);
  await afterCapsSettle(stub);
  // Half 1: no invented byte ceiling. A selection over the ceiling this deployment would
  // have advertised is accepted, because the fallback states none.
  assert.equal(refusalCount(), 0);
  assert.equal(screen.getAllByRole("button", { name: "Upload & create" }).length, 1);

  // Half 2: the ENTRY ceiling the fallback does carry is still enforced. Derived from the
  // fallback rather than written as a number, so a fallback that degrades to no ceiling
  // fails here rather than quietly accepting everything.
  const entryCap = DEFAULT_UPLOAD_CAPS.maxEntries;
  assert.equal(
    Number.isSafeInteger(entryCap) && entryCap <= 2_000_000,
    true,
    `the fallback's entry cap is ${entryCap}: a failed caps read has degraded to no entry ceiling, which is the "not to a guessed cap" half read backwards — the fallback must mirror the server's MAX_UPLOAD_ENTRIES, not drop it`,
  );
  const overCap: { name: string; size: number }[] = new Array(entryCap + 1);
  for (let i = 0; i < overCap.length; i += 1) overCap[i] = { name: `i${i}.png`, size: 1 };
  fireEvent.change(imagesInput(container), { target: { files: overCap } });
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(
    screen.queryAllByText(/file limit/).length,
    1,
    "a selection one file over the compiled-in entry ceiling was accepted after a failed caps read",
  );
});

test("a 200 with a malformed body is not HALF-ADOPTED", async () => {
  // The reachable-without-a-server-bug case: an intermediary cache, an older API build
  // or a renamed field yields a 200 whose body is not three usable numbers. Copying it
  // field by field would put `undefined` into the caps it lacks — disabling the entry
  // check — and apply the ones it carries, so this body's 8-byte `max_bundle_bytes`
  // would refuse every selection on the machine. capsFromServer is all-or-nothing, so
  // the tiny ceiling below must not reach the pre-flight at all.
  const stub = capsClient({ max_bundle_bytes: 8 } as unknown as UploadCapsResponse);
  const container = renderWizard(stub.client);
  selectFile(container, "modest.png", 4096);
  await afterCapsSettle(stub);
  assert.equal(refusalCount(), 0);
});

test("a failed caps read is announced on the console, not swallowed", async (t) => {
  // The degradation is invisible in the UI and looks exactly like a deployment that
  // really is capped at 100 MiB — the symptom the seam exists to remove. The console
  // line is the only way to tell "the caps route is down" from "these are the caps"
  // (PR #316 review, finding 1). Assert on the message text, never on a node.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.warn = original;
  });
  const stub = capsClient(new Error("caps route unreachable"));
  renderWizard(stub.client);
  await afterCapsSettle(stub);
  assert.equal(
    warnings.filter((w) => w.includes("[uploads] caps read failed")).length,
    1,
    `expected one caps-degradation warning, saw: ${JSON.stringify(warnings)}`,
  );
});

test("a failed caps read does not block an in-cap upload", async () => {
  const stub = capsClient(new Error("caps route unreachable"));
  const container = renderWizard(stub.client);
  selectFile(container, "a.png", 3);
  await afterCapsSettle(stub);
  assert.equal(screen.getAllByText("1 file(s) selected").length, 1);
  assert.equal(refusalCount(), 0);
  assert.equal(screen.getAllByRole("button", { name: "Upload & create" }).length, 1);
});
