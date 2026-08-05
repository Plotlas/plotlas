// The browser tab's title (Part D §2c).
//
// This gap only exists BECAUSE Part A shipped. Before deep links, the tab was a place
// nobody arrived at cold: you opened the app and navigated. Now a `?d=<id>` link gets
// pasted into chat, bookmarked and reopened weeks later — and every one of those tabs
// said "Plotlas", telling the recipient nothing about what they are about to open.
//
// Pure title COMPUTATION here, side effect in `applyDocumentTitle`, so the format is
// unit-testable without a DOM.

/** The static title the app ships with (`index.html`), and the library's title. */
export const APP_TITLE = "Plotlas";

/**
 * The tab title for a view.
 *
 * `null` collection ⇒ the bare app title (the library, the auth screen). Otherwise
 * "<collection> · Plotlas": the collection FIRST, because a tab strip truncates from
 * the right and the whole point is telling several open tabs apart. The app name stays
 * as the suffix so a lone tab is still identifiably Plotlas.
 *
 * The caller passes the RESOLVED name (`collectionName(...)`), so an unnamed collection
 * shows its id here exactly as it does everywhere else — one fallback rule, not two.
 */
export function titleForCollection(collection: string | null): string {
  const name = (collection ?? "").trim();
  return name === "" ? APP_TITLE : `${name} · ${APP_TITLE}`;
}

/** Set the tab title, if there is a document. No-op under the node runner. */
export function applyDocumentTitle(collection: string | null): void {
  if (typeof document === "undefined") return;
  document.title = titleForCollection(collection);
}
