// DOM tier — Part D: the presentation UI Part B stored but never surfaced.
//
// Three things Part B left half-done, each user-visible:
//   §2/§2b  attribution can be EDITED and SHOWN (card + optional link), not CLI-only
//   §2c     the display name replaces the raw id where a user reads it
//   §3      a FAILED edit keeps the typed values on screen instead of discarding them
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import type { ApiClient } from "../../src/api-client/client.ts";
import type { DatasetSummary } from "../../src/api-client/types.ts";
import { DatasetList } from "../../src/ui/admin/DatasetList.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const BASE: DatasetSummary = {
  dataset_id: "rijks_pilot",
  dataset_version: 1,
  image_count: 49048,
  ingest_timestamp: "2026-07-07T00:00:00Z",
  layout_ids: ["grid"],
  owner: "dalew",
  status: "ready",
};

function stubClient(): ApiClient {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  return {
    coverUrl: (dsId: string) => `/api/datasets/${dsId}/cover`,
    authHeaders: () => ({}),
  } as unknown as ApiClient;
}

// Partial: the editor sends ONLY the fields that changed (the API is partial-by-key).
type Edits = {
  display_name?: string | null;
  attribution?: string | null;
  attribution_url?: string | null;
};

function renderList(
  ds: DatasetSummary,
  onRename: (dsId: string, edits: Edits) => Promise<void> = async () => {},
): void {
  render(
    h(DatasetList, {
      datasets: [ds],
      client: stubClient(),
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onRename,
      onNewDataset: () => {},
    }),
  );
}

function openEditor(): void {
  fireEvent.click(screen.getByLabelText("Actions for rijks_pilot"));
  fireEvent.click(screen.getByText("Edit details…"));
}

// --- §2: attribution is shown on the card ----------------------------------

test("the card shows the attribution when set", () => {
  renderList({ ...BASE, attribution: "Rijksmuseum, Amsterdam" });
  assert.ok(screen.getByText("Rijksmuseum, Amsterdam"));
});

test("no attribution means no credit line at all", () => {
  // An empty credit line is chrome pretending to be information.
  renderList(BASE);
  assert.equal(screen.queryByText(/Rijksmuseum/), null);
  assert.equal(document.querySelector(".card-credit"), null);
});

test("a blank-string attribution is treated as unset", () => {
  renderList({ ...BASE, attribution: "   " });
  assert.equal(document.querySelector(".card-credit"), null);
});

// --- §2b: attribution may carry a link -------------------------------------

test("the credit becomes a link when attribution_url is an http(s) URL", () => {
  renderList({
    ...BASE,
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "https://www.rijksmuseum.nl",
  });
  const link = screen.getByRole("link", { name: "Rijksmuseum, Amsterdam" });
  assert.equal(link.getAttribute("href"), "https://www.rijksmuseum.nl/");
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("target"), "_blank");
});

test("a non-http(s) attribution_url loses the LINK, never the credit", () => {
  // The value comes from app-state a user controls, so the same allow-list as the
  // url column role applies — and the credit must survive a bad target.
  renderList({
    ...BASE,
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "javascript:alert(1)",
  });
  assert.equal(screen.queryByRole("link"), null);
  assert.ok(screen.getByText("Rijksmuseum, Amsterdam"));
});

test("an attribution_url with no attribution renders nothing", () => {
  // A link with no text to hang it on is not a credit.
  renderList({ ...BASE, attribution_url: "https://www.rijksmuseum.nl" });
  assert.equal(document.querySelector(".card-credit"), null);
});

// --- §2: the editor covers all three fields --------------------------------

test("the editor exposes name, attribution and attribution link", () => {
  renderList(BASE);
  openEditor();
  assert.ok(screen.getByLabelText("Name for rijks_pilot"));
  assert.ok(screen.getByLabelText("Attribution for rijks_pilot"));
  assert.ok(screen.getByLabelText("Attribution link for rijks_pilot"));
});

test("each field is seeded with its current value", () => {
  renderList({
    ...BASE,
    display_name: "Rijksmuseum Collection",
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "https://www.rijksmuseum.nl",
  });
  openEditor();
  assert.equal(
    (screen.getByLabelText("Name for rijks_pilot") as HTMLInputElement).value,
    "Rijksmuseum Collection",
  );
  assert.equal(
    (screen.getByLabelText("Attribution for rijks_pilot") as HTMLInputElement).value,
    "Rijksmuseum, Amsterdam",
  );
  assert.equal(
    (screen.getByLabelText("Attribution link for rijks_pilot") as HTMLInputElement).value,
    "https://www.rijksmuseum.nl",
  );
});

test("submitting sends ONLY the changed fields (unchanged omitted, cleared sent as null)", async () => {
  // Review fix (Finding 2): the editor diffs against the seeded values, so an untouched
  // field is not re-sent — a name edit can't clobber a field changed out-of-band.
  let seen: { dsId: string; edits: Edits } | null = null;
  renderList({ ...BASE, attribution: "Old credit" }, async (dsId, edits) => {
    seen = { dsId, edits };
  });
  openEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "Rijksmuseum Collection" }, // was unset ⇒ changed
  });
  fireEvent.change(screen.getByLabelText("Attribution for rijks_pilot"), {
    target: { value: "  " }, // was "Old credit" ⇒ cleared (null)
  });
  // attribution_url is left untouched (and was unset), so its key must NOT be sent.
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  assert.deepEqual(seen, {
    dsId: "rijks_pilot",
    edits: { display_name: "Rijksmuseum Collection", attribution: null },
  });
});

test("editing only the name leaves an existing attribution untouched (no clobber)", async () => {
  // Review fix (Finding 2): the old editor re-sent all three fields, so a name-only edit
  // would overwrite an attribution/link changed out-of-band since the list loaded.
  let seen: Edits | null = null;
  renderList(
    {
      ...BASE,
      attribution: "Rijksmuseum, Amsterdam",
      attribution_url: "https://www.rijksmuseum.nl",
    },
    async (_dsId, edits) => {
      seen = edits;
    },
  );
  openEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "New name" },
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  // Only the name is sent; attribution and attribution_url keys are absent entirely.
  assert.deepEqual(seen, { display_name: "New name" });
});

test("opening the editor and saving with NO change closes it without a write", async () => {
  // An empty diff must not become a 422 "provide at least one of…"; it is just a close.
  let called = false;
  renderList({ ...BASE, display_name: "Kept" }, async () => {
    called = true;
  });
  openEditor();
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  assert.equal(called, false); // onRename never invoked
  assert.equal(screen.queryByLabelText("Name for rijks_pilot"), null); // editor closed
});

// --- §3: a failed edit must not discard what was typed ---------------------

test("a FAILED save keeps the editor open with the typed values and the reason", async () => {
  renderList(BASE, async () => {
    throw { detail: "Not the dataset owner", status: 403 };
  });
  openEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "Typed but not saved" },
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });

  // The reason appears INLINE, beside the values it rejected.
  assert.ok(screen.getByText("Not the dataset owner"));
  // ...and the editor is still open, still holding what was typed.
  const input = screen.getByLabelText("Name for rijks_pilot") as HTMLInputElement;
  assert.equal(input.value, "Typed but not saved");
});

test("a SUCCESSFUL save closes the editor", async () => {
  renderList(BASE, async () => {});
  openEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "A real change" }, // a change, so the save actually runs
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  assert.equal(screen.queryByLabelText("Name for rijks_pilot"), null);
});

test("reopening the editor after a failure does not resurface the old error", async () => {
  let fail = true;
  renderList(BASE, async () => {
    if (fail) throw new Error("boom");
  });
  openEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "Changed" }, // a change, so the (failing) save actually runs
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  assert.ok(screen.getByText("boom"));
  fireEvent.click(screen.getByText("Cancel"));
  fail = false;
  openEditor();
  assert.equal(screen.queryByText("boom"), null);
});

test("while a save is in flight the inputs are read-only and Save reads “Saving…”", async () => {
  // Review gap: the busy window was untested. Inputs must be READ-ONLY (not disabled,
  // which blurs a keyboard user off the field — Finding 5) so a mid-request edit or
  // re-submit can't happen, and the button must announce the busy state.
  let release: (() => void) | null = null;
  renderList(
    BASE,
    () =>
      new Promise<void>((res) => {
        release = res;
      }),
  );
  openEditor();
  fireEvent.change(screen.getByLabelText("Name for rijks_pilot"), {
    target: { value: "In flight" },
  });
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  const input = screen.getByLabelText("Name for rijks_pilot") as HTMLInputElement;
  assert.equal(input.readOnly, true);
  assert.equal(input.disabled, false);
  assert.ok(screen.getByText("Saving…"));
  await act(async () => {
    release?.();
  });
  assert.equal(screen.queryByLabelText("Name for rijks_pilot"), null); // resolved ⇒ closed
});

test("a save resolving after the user opened another card's editor does not corrupt it", async () => {
  // Review fix (Finding 1): the per-card save continuation guards on the dsId it was
  // launched for, so a save that settles after the user switched to a DIFFERENT card
  // cannot close it (discarding input) or stamp it with the first card's error.
  const A: DatasetSummary = { ...BASE, dataset_id: "ds_a" };
  const B: DatasetSummary = { ...BASE, dataset_id: "ds_b" };
  let releaseA: (() => void) | null = null;
  const onRename = (dsId: string): Promise<void> =>
    dsId === "ds_a"
      ? new Promise<void>((res) => {
          releaseA = res;
        })
      : Promise.resolve();
  render(
    h(DatasetList, {
      datasets: [A, B],
      client: stubClient(),
      busyId: null,
      onOpen: () => {},
      onDelete: () => {},
      onAddLayout: () => {},
      onRename,
      onNewDataset: () => {},
    }),
  );
  // Open A's editor, change its name, Save — A's write hangs.
  fireEvent.click(screen.getByLabelText("Actions for ds_a"));
  fireEvent.click(screen.getByText("Edit details…"));
  fireEvent.change(screen.getByLabelText("Name for ds_a"), { target: { value: "Renamed A" } });
  await act(async () => {
    fireEvent.click(screen.getByText("Save"));
  });
  // While A saves, open B's editor (its ⋯ is not disabled) and type into it.
  fireEvent.click(screen.getByLabelText("Actions for ds_b"));
  fireEvent.click(screen.getByText("Edit details…"));
  fireEvent.change(screen.getByLabelText("Name for ds_b"), { target: { value: "Typed into B" } });
  // A's write resolves last; its continuation must leave B's editor alone.
  await act(async () => {
    releaseA?.();
  });
  const bInput = screen.getByLabelText("Name for ds_b") as HTMLInputElement;
  assert.equal(bInput.value, "Typed into B"); // not discarded
  assert.equal(screen.queryByRole("alert"), null); // and no A-error leaked onto B
});

// --- §2c: the display name replaces the raw id -----------------------------

test("the delete confirmation names the collection, not its id", () => {
  // The one dialog where you must be certain WHICH collection you are destroying must
  // not label it differently from the card you just clicked.
  renderList({ ...BASE, display_name: "Rijksmuseum Collection" });
  fireEvent.click(screen.getByLabelText("Actions for rijks_pilot"));
  fireEvent.click(screen.getByText("Delete"));
  // Scoped to the confirm dialog — the card heading shows the name too, so an
  // unscoped query would pass even if the dialog still said the raw id.
  const dialog = screen.getByRole("alertdialog");
  assert.match(dialog.textContent ?? "", /Rijksmuseum Collection/);
  assert.doesNotMatch(dialog.textContent ?? "", /rijks_pilot/);
});

test("an unnamed collection still shows its id in the delete confirmation", () => {
  renderList(BASE);
  fireEvent.click(screen.getByLabelText("Actions for rijks_pilot"));
  fireEvent.click(screen.getByText("Delete"));
  assert.match(screen.getByRole("alertdialog").textContent ?? "", /rijks_pilot/);
});

// --- Part D polish: the credit is LABELLED, and lives in the one footer ---------

test("the card credit is prefixed with Source:", () => {
  // A collection's name and its source are routinely near-identical ("Rijksmuseum
  // Collection" / "Rijksmuseum, Amsterdam"), so an unlabelled second line reads as a
  // duplicate title. The prefix is what makes it parse as provenance.
  renderList({ ...BASE, attribution: "Rijksmuseum, Amsterdam" });
  const credit = document.querySelector(".card-credit");
  assert.ok(credit);
  assert.match(credit.textContent ?? "", /^Source:\s*Rijksmuseum, Amsterdam$/);
});

test("the Source: label is NOT part of the link", () => {
  // "Source" is our word, not the institution's — underlining it would imply the link
  // points at something called "Source".
  renderList({
    ...BASE,
    attribution: "Rijksmuseum, Amsterdam",
    attribution_url: "https://www.rijksmuseum.nl",
  });
  const link = screen.getByRole("link", { name: "Rijksmuseum, Amsterdam" });
  assert.doesNotMatch(link.textContent ?? "", /Source/);
  assert.ok(document.querySelector(".credit-label"));
});

test("the full credit stays available as a tooltip when the line is clipped", () => {
  // .card-credit is one clipped line so a long institution name cannot make the card
  // taller than its siblings; the value must remain readable somehow.
  renderList({ ...BASE, attribution: "Rijksmuseum, Amsterdam" });
  assert.equal(
    document.querySelector(".card-credit")?.getAttribute("title"),
    "Source: Rijksmuseum, Amsterdam",
  );
});
