// Deep links to a collection (SCOPE_shareable-collections.md Part A).
//
// The app's whole navigation state is ONE value — which screen, and for the viewer
// which dataset. This module is the pure translation between that value and the
// query string, kept out of App.tsx so it is unit-testable (App.tsx is the vite
// composition root and is deliberately not imported by node tests).
//
// WHY A QUERY PARAM, NOT A PATH SEGMENT. `/d/<id>` would need an SPA rewrite in the
// Caddyfile, and that file is where the T2-09 dataset-auth gate lives. Buying a
// prettier URL with a change to the authorization surface is a bad trade. `?d=<id>`
// needs no server change at all: the edge already serves index.html at `/`.
//
// WHAT IS DELIBERATELY NOT HERE (scope §2 non-goals): zoom, pan, layout, filter,
// search and selection state. Only WHICH collection is addressable. That boundary is
// the point — it is where a seam like this sprawls.

/** The app's navigation state. Owned here so App.tsx and the tests share one type. */
export type View =
  | { kind: "admin" }
  | { kind: "viewer"; datasetId: string }
  | { kind: "auth" };

/** The query parameter carrying the dataset id. Short because it is meant to be
 *  pasted into chat windows and slide decks. */
export const DATASET_PARAM = "d";

/** The view a URL asks for. Unknown/empty ⇒ the library.
 *
 *  The id is taken VERBATIM — no normalization, no case-folding, no aliasing. It is
 *  the app-state primary key and the on-disk directory name, and the API is the only
 *  thing entitled to decide whether it resolves. Trimming whitespace is the one
 *  exception: it comes from copy-paste, not from the user meaning it.
 *
 *  `auth` is never produced here. It is a transient screen you are routed TO, not a
 *  place a link points at — see `searchFromView`. */
export function viewFromSearch(search: string): View {
  // `new URLSearchParams(string)` never throws — the WHATWG form-urlencoded parser is
  // total and decodes leniently (a lone `%`, `%zz`, `&&` etc. pass through literally),
  // unlike `decodeURIComponent`. A malformed query string yields a params object, not a
  // crash; an absent or blank `d` already falls through to the library below.
  const params = new URLSearchParams(search);
  const raw = params.get(DATASET_PARAM);
  if (raw === null) return { kind: "admin" };
  const datasetId = raw.trim();
  if (datasetId === "") return { kind: "admin" };
  return { kind: "viewer", datasetId };
}

/** The query string for a view, preserving any OTHER parameters already present so
 *  this never silently eats query state it does not own.
 *
 *  Returns `null` for `auth`, meaning "leave the URL alone". That is not an
 *  oversight: the auth screen is reached by bouncing off a collection you could not
 *  open, and the `?d=` that got you there must SURVIVE so logging in can continue
 *  through to it (see App's handleAuthenticated). Rewriting the URL on the way to the
 *  login screen would strip exactly the intent the visitor is trying to act on. */
export function searchFromView(view: View, currentSearch = ""): string | null {
  if (view.kind === "auth") return null;
  // `new URLSearchParams(string)` never throws (see viewFromSearch).
  const params = new URLSearchParams(currentSearch);
  if (view.kind === "viewer") params.set(DATASET_PARAM, view.datasetId);
  else params.delete(DATASET_PARAM);
  const q = params.toString();
  return q === "" ? "" : `?${q}`;
}

/** Where a visitor lands when a deep link cannot be opened, and what they are told. */
export type UnavailableRoute =
  | { view: { kind: "auth" }; authNotice: string; libraryNotice: null }
  | { view: { kind: "admin" }; authNotice: null; libraryNotice: string };

/** Decide where a link to an unopenable collection lands.
 *
 *  THE CONSTRAINT THAT SHAPES THIS: the API answers a private collection the caller may
 *  not read with the SAME 404 as a collection that does not exist
 *  (api/routers/datasets.py — "its existence is not disclosed"). The frontend therefore
 *  cannot tell "no such collection" from "not yours", and must not invent a distinction
 *  it does not have. So there are exactly TWO outcomes, and they branch on the one thing
 *  we do know — whether signing in could possibly change the answer:
 *
 *    anonymous  → the login screen. An account MIGHT grant access, and `?d=` stays in the
 *                 URL so a successful login continues through to the collection.
 *    signed in  → the library. Signing in again cannot help; there is nothing to offer.
 *
 *  Both messages say only that it is not available TO YOU. Neither confirms or denies
 *  that the collection exists — the wording is part of the security property, not
 *  decoration, and is pinned by tests. */
export function routeForUnavailable(datasetId: string, username: string | null): UnavailableRoute {
  if (username === null) {
    return {
      view: { kind: "auth" },
      authNotice: `“${datasetId}” isn’t available to browse without an account.`,
      libraryNotice: null,
    };
  }
  return {
    view: { kind: "admin" },
    authNotice: null,
    libraryNotice: `“${datasetId}” isn’t available.`,
  };
}

/** True when two views address the same place — used to avoid pushing a duplicate
 *  history entry when a re-render produces an equal view (which would make Back
 *  appear to do nothing). */
export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "viewer" && b.kind === "viewer") return a.datasetId === b.datasetId;
  return true;
}

/** The URL `setView` should `pushState` for a transition from `current` to `next`, or
 *  `null` to leave history untouched. Kept here (not inline in App) so the dedup rule is
 *  unit-testable. Returns `null` when:
 *
 *    - the view is unchanged (`sameView`), or
 *    - `next` is `auth` (`searchFromView` returns `null` — the URL is left alone so a
 *      bounced `?d=` survives the login), or
 *    - the browser's current URL ALREADY shows `next`. This is the continue-through case:
 *      the auth bounce left `?d=X` in the URL, and logging in navigates auth→viewer{X},
 *      whose URL is the one already displayed — pushing an identical entry would make the
 *      next Back a silent no-op. Comparing the VIEW the current URL resolves to (not the
 *      raw string) also dedups a normalized id (`?d=%20X%20` ⇒ `?d=X`) that maps here.
 *
 *  Any `#hash` on the current URL is carried through — `searchFromView` already preserves
 *  the other query params; only the `d` param and the view are ours to change. */
export function pushUrlForView(
  current: View,
  next: View,
  loc: { pathname: string; search: string; hash: string },
): string | null {
  if (sameView(current, next)) return null;
  const search = searchFromView(next, loc.search);
  if (search === null) return null;
  if (sameView(viewFromSearch(loc.search), next)) return null;
  return `${loc.pathname}${search}${loc.hash}`;
}
