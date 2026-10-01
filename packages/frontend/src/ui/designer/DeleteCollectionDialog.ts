// The collection delete dialog (seam L3 §2b.6; LAYOUT_DESIGNER D-xxii as amended by
// D-xxviii; the right half of the `DeleteConfirm` board).
//
// Deletion is the fourth cost shape: free by the file test, but irreversible. So it never
// enters the pending set, it is confirmed on its own, and the friction is proportional to
// the loss: a collection asks you to type its NAME — the thing you know it by. (It was the
// id until D-xxviii made the id opaque; nobody should be asked to type a random string.)
// Case, spaces and punctuation are ignored in the match.
//
// It states what is lost in facts the API serves: the image count and the baked layouts.
// The board's "41.2 GB on disk" is omitted — no route serves a size — and filed as
// [[T2-no-route-serves-a-collection-s-size-on-disk]].
import { createElement as h, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { DatasetSummary } from "../../api-client/types";
import { collectionName } from "../../api-client/types";
import { errText } from "../../api-client/errText";

/** A name reduced to what the match compares: lowercased, with whitespace and
 *  punctuation removed. */
function confirmKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
}

/** Does `typed` confirm deleting a collection called `name`? Case, spaces and
 *  punctuation are ignored. A name that is ALL spaces and punctuation reduces to
 *  nothing, and an empty key must never match an empty input — so such a name has to be
 *  typed exactly. */
export function confirmsName(typed: string, name: string): boolean {
  const want = confirmKey(name);
  if (want === "") return typed.trim() !== "" && typed.trim() === name.trim();
  return confirmKey(typed) === want;
}

export interface DeleteCollectionDialogProps {
  client: ApiClient;
  dataset: DatasetSummary;
  /** How many layouts are baked (committed) — what the dialog says is lost. */
  bakedLayouts: number;
  onCancel: () => void;
  /** The DELETE returned 204: the collection is gone. The caller routes to the library. */
  onDeleted: () => void;
  onAuthExpired: () => void;
}

export function DeleteCollectionDialog(props: DeleteCollectionDialogProps): ReactElement {
  const { dataset } = props;
  const name = collectionName(dataset);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const matches = confirmsName(typed, name);

  async function confirm(): Promise<void> {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.deleteDataset(dataset.dataset_id);
      props.onDeleted();
    } catch (err) {
      if ((err as { status?: unknown }).status === 401) {
        props.onAuthExpired();
        return;
      }
      // The 409 while a job is in flight (and the read-only-fixture 409) carry their
      // reason in the detail; it is shown as the server wrote it.
      setError(errText(err));
      setBusy(false);
    }
  }

  const images = dataset.image_count.toLocaleString("en-US");
  const layouts = `${props.bakedLayouts} baked layout${props.bakedLayouts === 1 ? "" : "s"}`;
  return h(
    "div",
    {
      className: "designer-modal-scrim",
      onKeyDown: (e: { key: string }) => {
        if (e.key === "Escape" && !busy) props.onCancel();
      },
    },
    h(
      "div",
      {
        className: "designer-modal panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "delete-collection-title",
      },
      h(
        "div",
        { className: "designer-modal-head" },
        h("span", { className: "designer-danger-badge" }, "Delete collection"),
        h("h2", { id: "delete-collection-title", className: "designer-modal-title" }, `Delete “${name}”?`),
      ),
      h(
        "p",
        { className: "designer-modal-body" },
        h("span", { className: "designer-mono" }, images),
        ` images and ${layouts}. Originals, tiles, thumbnails, metadata and the presentation record all go. `,
        h("strong", null, "Any link you have shared stops working."),
      ),
      h(
        "label",
        { className: "field designer-confirm-field" },
        h("span", { className: "designer-kicker" }, "Type the collection's name to confirm"),
        h("input", {
          ref: inputRef,
          value: typed,
          placeholder: name,
          "aria-label": "Collection name to confirm",
          readOnly: busy,
          onChange: (e: { target: { value: string } }) => setTyped(e.target.value),
          onKeyDown: (e: { key: string }) => {
            if (e.key === "Enter") void confirm();
          },
        }),
        h("span", { className: "muted designer-hint" }, "Case, spaces and punctuation don't matter."),
      ),
      error !== null ? h("p", { className: "error-text", role: "alert" }, error) : null,
      h(
        "div",
        { className: "designer-modal-actions" },
        h("button", { type: "button", className: "btn ghost", disabled: busy, onClick: props.onCancel }, "Cancel"),
        h(
          "button",
          { type: "button", className: "btn danger", disabled: !matches || busy, onClick: () => void confirm() },
          busy ? "Deleting…" : "Delete collection",
        ),
      ),
    ),
  );
}
