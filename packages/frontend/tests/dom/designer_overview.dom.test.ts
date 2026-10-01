// DOM tier — the designer's Overview (seam L3 §2b.5) and the collection delete dialog
// (§2b.6), over the golden full fixture (tests/dom/designerDom.ts).
//
// The presentation-panel pins MOVED here from the library card's inline details editor
// (tests/dom/presentation_ui.dom.test.ts, Part D §2/§3), because D-xxiv retired that
// editor and Overview is its home. The rules they protect are unchanged: send only the
// field that changed, blank clears, a failure keeps what was typed and says why beside
// it. What changed is WHEN a field saves: as you type (on a pause, or leaving the field),
// with a "Saved" acknowledgement, never through the commit bar (D-xx).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DesignerScreen } from "../../src/ui/designer/DesignerScreen.ts";
import { confirmsName } from "../../src/ui/designer/DeleteCollectionDialog.ts";
import { DS_ID, OWNER, designerClient, summary } from "./designerDom.ts";
import type { DesignerRecorder } from "./designerDom.ts";

function clearStorage(): void {
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
}
beforeEach(clearStorage);
afterEach(() => {
  cleanup();
  clearStorage();
});

function mount(rec: DesignerRecorder, onDeleted: (name: string) => void = () => {}): void {
  render(
    h(DesignerScreen, {
      client: rec.client,
      datasetId: DS_ID,
      tab: "overview",
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted,
      onAuthExpired: () => {},
    }),
  );
}

async function field(name: RegExp): Promise<HTMLInputElement> {
  return (await screen.findByRole("textbox", { name })) as HTMLInputElement;
}

/** Type into a field and leave it — leaving saves at once (no waiting out the pause). */
async function typeAndLeave(input: HTMLInputElement, value: string): Promise<void> {
  fireEvent.change(input, { target: { value } });
  await act(async () => {
    fireEvent.blur(input);
  });
}

// --- the identity header and the two doors ------------------------------------------

test("the identity header: the name, then ID with a copy button, count, version, last baked", async () => {
  mount(designerClient({ dataset: summary({ display_name: "Golden full" }) }));
  await screen.findByRole("heading", { name: "Golden full" });
  assert.ok(screen.getByText(DS_ID));
  assert.ok(screen.getByRole("button", { name: "Copy the collection ID" }));
  // "ingested" is the manifest's ingest_timestamp, which add-layouts carries forward; the
  // last BAKE is the newest layout's committed_at (the fake's container mtime). Each fact
  // is its OWN element, which is what lets CSS keep it whole at 390 px.
  const facts = [...document.querySelectorAll(".overview-tech-fact")].map((e) => e.textContent);
  assert.deepEqual(facts, ["· 256 images", "· v1", "· ingested 2026-07-29", "· last baked 2026-09-21"]);
  assert.ok(screen.getByRole("button", { name: "Delete collection…" }));
});

// --- Copy ID (review of #368, finding 4) ---------------------------------------------
// `navigator.clipboard` exists only in a secure context. A self-hosted instance served on a
// LAN address (http://192.168.1.20:8080) has none, and Copy used to do nothing at all.

/** Run `body` with `navigator.clipboard` set to `value` (undefined = absent, as over
 *  plain HTTP), restoring whatever was there after. */
async function withClipboard(value: unknown, body: () => Promise<void>): Promise<void> {
  const had = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", { value, configurable: true });
  try {
    await body();
  } finally {
    if (had !== undefined) Object.defineProperty(globalThis.navigator, "clipboard", had);
    else delete (globalThis.navigator as unknown as Record<string, unknown>).clipboard;
  }
}

test("Copy ID with NO Clipboard API (plain HTTP) selects the id and says how to copy it", async () => {
  await withClipboard(undefined, async () => {
    mount(designerClient());
    fireEvent.click(await screen.findByRole("button", { name: "Copy the collection ID" }));
    assert.ok(await screen.findByText("Press Ctrl+C (⌘C on Mac) to copy"), "never a silent no-op");
    assert.equal(globalThis.getSelection()?.toString(), DS_ID, "the id is selected, ready to copy by hand");
  });
});

test("Copy ID when the clipboard REFUSES the write falls back the same way", async () => {
  // A secure context whose clipboard write is refused (permission denied, document not
  // focused): the promise rejects.
  const refused = { writeText: () => Promise.reject(new Error("NotAllowedError")) };
  await withClipboard(refused, async () => {
    mount(designerClient());
    fireEvent.click(await screen.findByRole("button", { name: "Copy the collection ID" }));
    assert.ok(await screen.findByText("Press Ctrl+C (⌘C on Mac) to copy"));
    assert.equal(globalThis.getSelection()?.toString(), DS_ID);
  });
});

test("Copy ID with a working clipboard copies the id and says Copied", async () => {
  const written: string[] = [];
  const clipboard = {
    writeText: async (text: string) => {
      written.push(text);
    },
  };
  await withClipboard(clipboard, async () => {
    mount(designerClient());
    fireEvent.click(await screen.findByRole("button", { name: "Copy the collection ID" }));
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Copy the collection ID" }).textContent, "Copied"));
    assert.deepEqual(written, [DS_ID]);
    assert.equal(screen.queryAllByText("Press Ctrl+C (⌘C on Mac) to copy").length, 0);
  });
});

test("the Data door: column and assigned counts, and what the data offers (D-xxiii)", async () => {
  mount(designerClient());
  const door = await screen.findByRole("region", { name: "Data" });
  // 10 declared columns; 9 carry a real role — `caption` is Display only.
  assert.match(door.textContent ?? "", /10 columns · 9 assigned/);
  const offers = within(door).getAllByText(/grid|datetime|categorical|scatter|geographic/i).map((e) => e.textContent);
  assert.ok(offers.includes("grid"));
  assert.ok(offers.includes("datetime"));
  assert.ok(offers.includes("categorical × 2"));
  // Four DOUBLE columns ⇒ scatter and geographic are offered, the pair picked on the card.
  assert.match(door.textContent ?? "", /scatter · pair on the layout/);
  assert.match(door.textContent ?? "", /geographic · pair on the layout/);
});

test("the Layouts door: the count and the state summary from LayoutInfo", async () => {
  mount(designerClient());
  const door = await screen.findByRole("region", { name: "Layouts" });
  assert.match(door.textContent ?? "", /6 live/);
  assert.doesNotMatch(door.textContent ?? "", /baking|queued|stale/);
});

// --- the presentation panel (moved from the card editor) -----------------------------

test("each field is seeded with its current value", async () => {
  mount(
    designerClient({
      dataset: summary({
        display_name: "Rijksmuseum Collection",
        attribution: "Rijksmuseum, Amsterdam",
        attribution_url: "https://www.rijksmuseum.nl",
      }),
    }),
  );
  assert.equal((await field(/Collection name/)).value, "Rijksmuseum Collection");
  assert.equal((await field(/^Attribution(?! link)/)).value, "Rijksmuseum, Amsterdam");
  assert.equal((await field(/Attribution link/)).value, "https://www.rijksmuseum.nl");
});

test("editing only the name PATCHes only the name — an attribution is never clobbered", async () => {
  const rec = designerClient({ dataset: summary({ attribution: "Rijksmuseum, Amsterdam" }) });
  mount(rec);
  await typeAndLeave(await field(/Collection name/), "  Golden full  ");
  assert.deepEqual(rec.patches, [{ display_name: "Golden full" }]);
  assert.ok(await screen.findByText("Saved"));
  // The header follows the stored name, without a re-fetch.
  assert.ok(screen.getByRole("heading", { name: "Golden full" }));
});

test("a blank field CLEARS it (null) — the recovery path for a bad value", async () => {
  const rec = designerClient({ dataset: summary({ display_name: "Typo McTypoface" }) });
  mount(rec);
  await typeAndLeave(await field(/Collection name/), "   ");
  assert.deepEqual(rec.patches, [{ display_name: null }]);
});

test("leaving a field without changing it writes nothing", async () => {
  const rec = designerClient({ dataset: summary({ display_name: "Kept" }) });
  mount(rec);
  const input = await field(/Collection name/);
  await act(async () => {
    fireEvent.blur(input);
  });
  assert.deepEqual(rec.patches, []);
});

test("a FAILED save keeps what was typed and shows the server's reason ON that field", async () => {
  const rec = designerClient({
    patch: () => {
      throw { status: 422, detail: "attribution_url: must be at most 500 characters" };
    },
  });
  mount(rec);
  const input = await field(/Attribution link/);
  await typeAndLeave(input, "https://example.org/too-long");
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /must be at most 500 characters/);
  assert.equal(input.value, "https://example.org/too-long", "the typed value survives");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  // Inline: the alert sits in the field that failed, not in a banner somewhere else.
  assert.ok(input.closest("label")?.contains(alert));
});

test("typing saves on a pause too, without leaving the field", async () => {
  const rec = designerClient();
  mount(rec);
  const input = await field(/^Attribution(?! link)/);
  fireEvent.change(input, { target: { value: "Smithsonian Open Access" } });
  assert.deepEqual(rec.patches, [], "not per keystroke");
  await waitFor(() => assert.deepEqual(rec.patches, [{ attribution: "Smithsonian Open Access" }]), { timeout: 2000 });
});

test("the default layout is a select over LIVE layouts, by label, and PATCHes only itself", async () => {
  const rec = designerClient();
  mount(rec);
  const select = (await screen.findByRole("combobox", { name: /Default layout/ })) as HTMLSelectElement;
  const labels = [...select.options].map((o) => o.textContent);
  assert.deepEqual(labels, ["First layout (Grid)", "Grid", "By date", "Scatter", "Group", "Bucket", "Location"]);
  await act(async () => {
    fireEvent.change(select, { target: { value: "categorical_group" } });
  });
  assert.deepEqual(rec.patches, [{ default_layout: "categorical_group" }]);
});

test("the cell title is a select over the columns GET .../columns returns", async () => {
  const rec = designerClient({ presentation: { dataset: { title_column: "caption" } } });
  mount(rec);
  const select = (await screen.findByRole("combobox", { name: /Cell title/ })) as HTMLSelectElement;
  assert.equal(select.value, "caption");
  assert.equal(select.options.length, 11, "a none option plus the ten declared columns");
  await act(async () => {
    fireEvent.change(select, { target: { value: "" } });
  });
  assert.deepEqual(rec.patches, [{ title_column: null }]);
});

test("free edits never reach the commit bar", async () => {
  const rec = designerClient();
  mount(rec);
  await typeAndLeave(await field(/Collection name/), "Golden full");
  const bar = screen.getByRole("contentinfo", { name: "Pending changes" });
  assert.match(bar.textContent ?? "", /Nothing pending/);
});

test("the pointer to Data says how many column names are set", async () => {
  mount(designerClient({ presentation: { columns: { group: { label: "Department" }, caption: { hidden: true } } } }));
  assert.ok(await screen.findByText(/1 renamed · 1 hidden/));
});

// --- the delete dialog (§2b.6) ---------------------------------------------------------

test("confirmsName ignores case, spaces and punctuation, and never matches an empty key", () => {
  assert.equal(confirmsName("smithsonian art 200k", "Smithsonian Art — 200k"), true);
  assert.equal(confirmsName("SmithsonianArt200k", "Smithsonian Art — 200k"), true);
  assert.equal(confirmsName("Smithsonian Art", "Smithsonian Art — 200k"), false);
  assert.equal(confirmsName("untitled collection", "Untitled collection"), true);
  assert.equal(confirmsName("", "Untitled collection"), false);
  assert.equal(confirmsName("", "—"), false, "a name of punctuation alone is typed exactly");
  assert.equal(confirmsName("—", "—"), true);
});

test("the dialog states what is lost, and deletes only once the NAME is typed", async () => {
  let deletedName: string | null = null;
  const rec = designerClient({ dataset: summary({ display_name: "Golden — Full" }) });
  mount(rec, (name) => {
    deletedName = name;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Delete collection…" }));
  const dialog = screen.getByRole("dialog", { name: "Delete “Golden — Full”?" });
  assert.match(dialog.textContent ?? "", /256 images and 6 baked layouts/);
  assert.match(dialog.textContent ?? "", /Any link you have shared stops working/);
  const confirm = within(dialog).getByRole("button", { name: "Delete collection" }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  // The id is NOT the confirmation any more (D-xxviii).
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: DS_ID } });
  assert.equal(confirm.disabled, true);
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "golden full" } });
  assert.equal(confirm.disabled, false);
  await act(async () => {
    fireEvent.click(confirm);
  });
  assert.deepEqual(rec.deletes, [DS_ID]);
  assert.equal(deletedName, "Golden — Full");
});

test("a 409 because a job is in flight shows its reason and deletes nothing", async () => {
  let deleted = false;
  const rec = designerClient({
    deleteDataset: async () => {
      throw { status: 409, detail: "Another job for this collection is still running" };
    },
  });
  mount(rec, () => {
    deleted = true;
  });
  fireEvent.click(await screen.findByRole("button", { name: "Delete collection…" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: DS_ID } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete collection" }));
  });
  assert.match(within(dialog).getByRole("alert").textContent ?? "", /still running/);
  assert.equal(deleted, false);
});

test("an unnamed minted collection is confirmed by typing “Untitled collection”", async () => {
  const minted = "3f9c2a71e0b4";
  const rec = designerClient({ dataset: summary({ dataset_id: minted }) });
  render(
    h(DesignerScreen, {
      client: rec.client,
      datasetId: minted,
      tab: "overview",
      username: OWNER,
      onNavigate: () => {},
      onBack: () => {},
      onOpenAtlas: () => {},
      onUnavailable: () => {},
      onDeleted: () => {},
      onAuthExpired: () => {},
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Delete collection…" }));
  const dialog = screen.getByRole("dialog", { name: "Delete “Untitled collection”?" });
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "untitled collection" } });
  assert.equal((within(dialog).getByRole("button", { name: "Delete collection" }) as HTMLButtonElement).disabled, false);
});
