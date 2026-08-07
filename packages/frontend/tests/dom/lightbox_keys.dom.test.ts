// DOM tier — T2-204 regression pin. The Lightbox is a MODAL, so it consumes the keys it
// acts on in the CAPTURE phase (Lightbox.ts). Before this fix its Escape was a plain
// window-BUBBLE listener, so ActivityPill's `document`-level Escape (which
// stopPropagations) fired first and SWALLOWED the close — one press dismissed the
// background pill and left the modal stuck open. Here a document-level Escape consumer
// stands in for the pill; the modal must still close, and keys the Lightbox does NOT own
// must still propagate (so the fix is a scoped consume, not a blanket swallow).
//
// `layouts: []` ⇒ no detail tier ⇒ detailForManifest() is null ⇒ no image fetch; the mock
// client only needs getMetadata (same minimal mount as url_column.dom.test.ts).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Lightbox } from "../../src/ui/Lightbox.ts";

afterEach(cleanup);

function mountLightbox(onClose: () => void): void {
  const client = { getMetadata: async () => [{ id: 7, fields: { title: "The Night Watch" } }] };
  const manifest = { layouts: [], column_roles: { filename: { column: "filename", label: "File" } } };
  const previewCache = { get: () => undefined, put: () => {}, clear: () => {} };
  render(
    h(Lightbox, {
      dataset: "ds",
      client,
      cellIds: [7],
      index: 0,
      onNavigate: () => {},
      onClose,
      onAuthExpired: () => {},
      manifest,
      previewCache,
      tagsTable: null,
    }),
  );
}

test("Lightbox Escape is consumed at capture — a document-level handler cannot swallow the close (T2-204)", async () => {
  let closed = 0;
  mountLightbox(() => {
    closed += 1;
  });
  await screen.findByRole("dialog"); // mounted ⇒ the capture keydown effect is registered

  // Stand-in for ActivityPill: a document-level (bubble) Escape consumer that stops the
  // event, exactly as the open pill panel does. If the Lightbox listened on window-BUBBLE
  // (the pre-fix behaviour), this would fire FIRST and the modal would never close.
  let pillSaw = 0;
  const pill = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      pillSaw += 1;
      e.stopPropagation();
    }
  };
  document.addEventListener("keydown", pill);
  try {
    fireEvent.keyDown(document.body, { key: "Escape" });
    assert.equal(closed, 1, "the modal closed on the first Escape");
    assert.equal(pillSaw, 0, "the document-level pill never saw Escape — the modal consumed it at capture");
  } finally {
    document.removeEventListener("keydown", pill);
  }
});

test("Lightbox does NOT consume a key it has no action for — it still propagates (no blanket swallow)", async () => {
  mountLightbox(() => {});
  await screen.findByRole("dialog");

  let sawOther = 0;
  const spy = (e: KeyboardEvent): void => {
    if (e.key === "z") sawOther += 1;
  };
  document.addEventListener("keydown", spy);
  try {
    fireEvent.keyDown(document.body, { key: "z" });
    assert.equal(sawOther, 1, "an unowned key reaches the document handler — capture consume is scoped to the modal's keys");
  } finally {
    document.removeEventListener("keydown", spy);
  }
});
