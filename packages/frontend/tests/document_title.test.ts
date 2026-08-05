// The browser tab title (Part D §2c).
//
// This only became a gap when Part A shipped: before deep links, nobody arrived at a
// tab cold. Now `?d=<id>` links get pasted and bookmarked, and every such tab read
// "Plotlas".
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { APP_TITLE, titleForCollection } from "../src/ui/documentTitle.ts";

test("no collection ⇒ the bare app title (library, auth)", () => {
  assert.equal(titleForCollection(null), APP_TITLE);
  assert.equal(titleForCollection(""), APP_TITLE);
  assert.equal(titleForCollection("   "), APP_TITLE);
});

test("a collection is named FIRST, app name as the suffix", () => {
  // A tab strip truncates from the right, and the whole point is telling several open
  // tabs apart — so the collection has to lead.
  assert.equal(
    titleForCollection("Rijksmuseum Collection"),
    "Rijksmuseum Collection · Plotlas",
  );
});

test("an unnamed collection shows its id, exactly as every other surface does", () => {
  // The caller passes the RESOLVED name, so there is one fallback rule, not two.
  assert.equal(titleForCollection("rijks_pilot"), "rijks_pilot · Plotlas");
});
