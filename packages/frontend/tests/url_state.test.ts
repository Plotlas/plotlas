// Deep links to a collection — the pure URL ↔ view translation and the decisions that sit
// on top of it (SCOPE_shareable-collections.md Part A).
//
// App.tsx is the vite composition root and is not importable here, which is exactly why
// the translation AND the routing decisions live in ui/urlState.ts. These tests pin the
// contract that makes a pasted link work (viewFromSearch / searchFromView), where an
// unopenable link lands a visitor (routeForUnavailable), and the history-dedup rule
// (pushUrlForView). The one App↔ViewerScreen INTEGRATION a node test can drive — a boot
// 404 handing the dataset back via onUnavailable — is pinned in
// tests/dom/deep_links.dom.test.ts; the App-level wiring itself (setView/popstate/
// continue-through) is untestable in this tier, tracked as backlog T2-197.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DATASET_PARAM,
  pushUrlForView,
  routeForUnavailable,
  sameView,
  searchFromView,
  viewFromSearch,
} from "../src/ui/urlState.ts";

test("no query string opens the library", () => {
  assert.deepEqual(viewFromSearch(""), { kind: "admin" });
  assert.deepEqual(viewFromSearch("?"), { kind: "admin" });
});

test("?d=<id> opens that collection in the viewer", () => {
  assert.deepEqual(viewFromSearch("?d=rijks_pilot"), { kind: "viewer", datasetId: "rijks_pilot" });
  // Leading "?" is optional — URLSearchParams accepts both, and callers pass
  // location.search verbatim.
  assert.deepEqual(viewFromSearch("d=rijks_pilot"), { kind: "viewer", datasetId: "rijks_pilot" });
});

test("the id is taken verbatim — no case-folding, no normalization", () => {
  // It is the app-state primary key AND the on-disk directory name. Any tidying here
  // would silently address a different collection than the link says.
  const v = viewFromSearch("?d=Rijks_Pilot");
  assert.deepEqual(v, { kind: "viewer", datasetId: "Rijks_Pilot" });
});

test("an empty or whitespace-only id falls back to the library, not a blank viewer", () => {
  assert.deepEqual(viewFromSearch("?d="), { kind: "admin" });
  assert.deepEqual(viewFromSearch("?d=%20%20"), { kind: "admin" });
});

test("surrounding whitespace is trimmed (links get copy-pasted with it)", () => {
  assert.deepEqual(viewFromSearch("?d=%20rijks_pilot%20"), {
    kind: "viewer",
    datasetId: "rijks_pilot",
  });
});

test("other query parameters are preserved when navigating", () => {
  // The app does not own the whole query string; eating an unrelated parameter would be
  // a silent data loss for anything else using it.
  const search = searchFromView({ kind: "viewer", datasetId: "rijks_pilot" }, "?utm=x");
  const params = new URLSearchParams(search ?? "");
  assert.equal(params.get("utm"), "x");
  assert.equal(params.get(DATASET_PARAM), "rijks_pilot");
});

test("returning to the library drops the dataset parameter but keeps the rest", () => {
  const search = searchFromView({ kind: "admin" }, "?d=rijks_pilot&utm=x");
  const params = new URLSearchParams(search ?? "");
  assert.equal(params.get(DATASET_PARAM), null);
  assert.equal(params.get("utm"), "x");
});

test("the library with no other parameters produces a clean empty query", () => {
  assert.equal(searchFromView({ kind: "admin" }, "?d=rijks_pilot"), "");
});

test("auth returns null — the URL must be LEFT ALONE so ?d= survives the login", () => {
  // This is the continue-through contract: a private collection bounces an anonymous
  // visitor to the login screen, and the link they clicked has to still be in the URL
  // afterwards or logging in drops them on the library instead of the collection.
  assert.equal(searchFromView({ kind: "auth" }, "?d=rijks_pilot"), null);
});

test("a round trip through the URL preserves the view", () => {
  for (const id of ["rijks_pilot", "a", "with-dash", "with.dot", "UPPER"]) {
    const view = { kind: "viewer", datasetId: id } as const;
    const search = searchFromView(view, "");
    assert.deepEqual(viewFromSearch(search ?? ""), view, `round trip failed for ${id}`);
  }
});

test("ids needing percent-encoding survive a round trip", () => {
  const view = { kind: "viewer", datasetId: "odd id&weird=x" } as const;
  const search = searchFromView(view, "");
  assert.deepEqual(viewFromSearch(search ?? ""), view);
});

// --- the failure-path table (scope §2). A shared link WILL be opened by someone logged
// out, or after the collection went private or was deleted. Each must land somewhere
// sane; a happy-path-only test does not close Part A.

test("unopenable link + anonymous → the login screen, because an account might help", () => {
  const route = routeForUnavailable("rijks_pilot", null);
  assert.deepEqual(route.view, { kind: "auth" });
  assert.equal(route.libraryNotice, null);
  assert.match(route.authNotice ?? "", /rijks_pilot/);
});

test("unopenable link + signed in → the library, because logging in again cannot help", () => {
  const route = routeForUnavailable("rijks_pilot", "dalew");
  assert.deepEqual(route.view, { kind: "admin" });
  assert.equal(route.authNotice, null);
  assert.match(route.libraryNotice ?? "", /rijks_pilot/);
});

test("neither message discloses whether the collection exists", () => {
  // SECURITY PIN, not style. The API deliberately answers a private-and-not-yours
  // collection with the same 404 as a missing one, so that a probe cannot enumerate
  // collections. Wording that said "you don't have permission" (implying it exists) or
  // "no such collection" (implying it doesn't) would leak through the UI what the API
  // refused to leak. Both messages must claim only unavailability TO THE VISITOR.
  const forbidden = /exists?|not found|no such|missing|deleted|permission|forbidden|private/i;
  for (const username of [null, "dalew"]) {
    const route = routeForUnavailable("rijks_pilot", username);
    const message = route.authNotice ?? route.libraryNotice ?? "";
    assert.doesNotMatch(message, forbidden, `leaky wording for username=${String(username)}`);
    assert.match(message, /available/i);
  }
});

test("the two outcomes are the ONLY outcomes — the 404 is genuinely ambiguous", () => {
  // If someone later adds a third branch keyed on "does it exist", this fails — which is
  // the point. The frontend cannot know, and must not act as though it does.
  const kinds = new Set([
    routeForUnavailable("x", null).view.kind,
    routeForUnavailable("x", "dalew").view.kind,
  ]);
  assert.deepEqual([...kinds].sort(), ["admin", "auth"]);
});

test("sameView distinguishes collections so Back is not a no-op", () => {
  assert.equal(sameView({ kind: "admin" }, { kind: "admin" }), true);
  assert.equal(
    sameView({ kind: "viewer", datasetId: "a" }, { kind: "viewer", datasetId: "a" }),
    true,
  );
  assert.equal(
    sameView({ kind: "viewer", datasetId: "a" }, { kind: "viewer", datasetId: "b" }),
    false,
  );
  assert.equal(sameView({ kind: "admin" }, { kind: "viewer", datasetId: "a" }), false);
});

// --- pushUrlForView: the history-write dedup rule. A duplicate entry (a push whose URL
// equals the one already showing) makes the first Back a silent no-op — the exact wart
// the deep-link seam is meant to avoid, and it bit the login continue-through because the
// old guard compared VIEWS, not the resulting URL.

const loc = (search: string, hash = "", pathname = "/"): { pathname: string; search: string; hash: string } =>
  ({ pathname, search, hash });

test("pushUrlForView: a real navigation returns the new URL", () => {
  assert.equal(
    pushUrlForView({ kind: "admin" }, { kind: "viewer", datasetId: "rijks_pilot" }, loc("")),
    "/?d=rijks_pilot",
  );
});

test("pushUrlForView: an unchanged view pushes nothing", () => {
  assert.equal(pushUrlForView({ kind: "admin" }, { kind: "admin" }, loc("")), null);
});

test("pushUrlForView: navigating to auth leaves the URL alone (the ?d= must survive)", () => {
  assert.equal(
    pushUrlForView({ kind: "viewer", datasetId: "x" }, { kind: "auth" }, loc("?d=x")),
    null,
  );
});

test("pushUrlForView: continue-through does NOT push a duplicate entry", () => {
  // The auth bounce left ?d=priv in the URL; logging in navigates auth→viewer{priv}, whose
  // URL is the one already showing. A push here would make the first Back dead.
  assert.equal(
    pushUrlForView({ kind: "auth" }, { kind: "viewer", datasetId: "priv" }, loc("?d=priv")),
    null,
  );
});

test("pushUrlForView: a normalized id resolving to the shown view pushes nothing", () => {
  // ?d=%20priv%20 trims to priv — the very view we are navigating to. No dup entry even
  // though the raw strings differ.
  assert.equal(
    pushUrlForView({ kind: "auth" }, { kind: "viewer", datasetId: "priv" }, loc("?d=%20priv%20")),
    null,
  );
});

test("pushUrlForView: an ordinary login from the library does not duplicate '/'", () => {
  assert.equal(pushUrlForView({ kind: "auth" }, { kind: "admin" }, loc("")), null);
});

test("pushUrlForView: a #hash on the URL is carried through a navigation", () => {
  assert.equal(
    pushUrlForView({ kind: "admin" }, { kind: "viewer", datasetId: "x" }, loc("", "#cell=42")),
    "/?d=x#cell=42",
  );
});

test("pushUrlForView: leaving the viewer drops ?d= but keeps other params and the hash", () => {
  assert.equal(
    pushUrlForView({ kind: "viewer", datasetId: "x" }, { kind: "admin" }, loc("?d=x&utm=a", "#foo")),
    "/?utm=a#foo",
  );
});
