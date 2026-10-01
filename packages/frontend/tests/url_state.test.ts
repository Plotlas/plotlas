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
  isDesignerTabSwitch,
  mayOpenDesigner,
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

// --- the designer route (seam L3 §2b.1). `?edit=<id>` + `&view=data|layouts`; Overview
// is the default and writes no `view`, a reload returns to the same tab, and a
// non-owner is sent to the library with the same non-disclosing notice a viewer link
// gets.

test("?edit=<id>&view=layouts round-trips through the URL", () => {
  const view = { kind: "designer", datasetId: "golden_dataset_full_v2", tab: "layouts" } as const;
  const search = searchFromView(view, "");
  assert.equal(search, "?edit=golden_dataset_full_v2&view=layouts");
  assert.deepEqual(viewFromSearch(search ?? ""), view);
  for (const tab of ["overview", "data", "layouts"] as const) {
    const v = { kind: "designer", datasetId: "3f9c2a71e0b4", tab } as const;
    assert.deepEqual(viewFromSearch(searchFromView(v, "") ?? ""), v, `round trip failed for ${tab}`);
  }
});

test("Overview is the default and writes no view parameter", () => {
  assert.equal(searchFromView({ kind: "designer", datasetId: "ds", tab: "overview" }, ""), "?edit=ds");
  assert.deepEqual(viewFromSearch("?edit=ds"), { kind: "designer", datasetId: "ds", tab: "overview" });
  // An explicit-overview or unknown tab lands on Overview, where every entrance lands.
  assert.deepEqual(viewFromSearch("?edit=ds&view=overview"), { kind: "designer", datasetId: "ds", tab: "overview" });
  assert.deepEqual(viewFromSearch("?edit=ds&view=bogus"), { kind: "designer", datasetId: "ds", tab: "overview" });
});

test("a reload keeps the tab: the URL written for a tab is the URL read back", () => {
  // The reload IS viewFromSearch(location.search) at App mount — so this is the reload.
  const onData = searchFromView({ kind: "designer", datasetId: "ds", tab: "data" }, "?utm=x") ?? "";
  assert.deepEqual(viewFromSearch(onData), { kind: "designer", datasetId: "ds", tab: "data" });
  assert.equal(new URLSearchParams(onData).get("utm"), "x", "other parameters survive");
});

test("moving between viewer and designer never leaves the other's address behind", () => {
  assert.equal(searchFromView({ kind: "viewer", datasetId: "ds" }, "?edit=ds&view=layouts"), "?d=ds");
  assert.equal(searchFromView({ kind: "designer", datasetId: "ds", tab: "data" }, "?d=ds"), "?edit=ds&view=data");
  assert.equal(searchFromView({ kind: "admin" }, "?edit=ds&view=data&utm=a"), "?utm=a");
});

test("a blank ?edit= falls back like a blank ?d= does", () => {
  assert.deepEqual(viewFromSearch("?edit=%20"), { kind: "admin" });
  assert.deepEqual(viewFromSearch("?edit=&d=ds"), { kind: "viewer", datasetId: "ds" });
});

test("sameView tells designer tabs apart; a tab switch is a REPLACE, not a push", () => {
  const overview = { kind: "designer", datasetId: "ds", tab: "overview" } as const;
  const layouts = { kind: "designer", datasetId: "ds", tab: "layouts" } as const;
  assert.equal(sameView(overview, { ...overview }), true);
  assert.equal(sameView(overview, layouts), false);
  assert.equal(isDesignerTabSwitch(overview, layouts), true);
  // Entering or leaving the designer, or switching collection, is a real navigation.
  assert.equal(isDesignerTabSwitch({ kind: "admin" }, overview), false);
  assert.equal(isDesignerTabSwitch(overview, { kind: "admin" }), false);
  assert.equal(isDesignerTabSwitch(overview, { kind: "designer", datasetId: "other", tab: "layouts" }), false);
  assert.equal(pushUrlForView(overview, layouts, loc("?edit=ds")), "/?edit=ds&view=layouts");
});

test("only the owner may open the designer; anyone else is routed through routeForUnavailable", () => {
  assert.equal(mayOpenDesigner("dalew", "dalew"), true);
  assert.equal(mayOpenDesigner("dalew", "someone_else"), false);
  assert.equal(mayOpenDesigner("dalew", null), false, "an anonymous visitor owns nothing");
  assert.equal(mayOpenDesigner("", ""), false, "an unowned (CLI-seeded) collection is nobody's to edit");
  assert.equal(mayOpenDesigner(undefined, "dalew"), false);
  // A signed-in non-owner lands on the LIBRARY, with the non-disclosing notice.
  const route = routeForUnavailable("ds", "someone_else");
  assert.deepEqual(route.view, { kind: "admin" });
  assert.match(route.libraryNotice ?? "", /isn’t available/);
});
