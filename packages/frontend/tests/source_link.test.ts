// Link safety for the schema v2.8 `url` column role.
//
// One property: a value becomes a live link ONLY if it is an absolute http(s) URL.
// The role map and the values both travel inside a dataset, so this is a security
// boundary, not formatting.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sourceUrl } from "../src/ui/sourceLink.ts";

test("an absolute http(s) URL is a link", () => {
  assert.equal(
    sourceUrl("https://www.rijksmuseum.nl/en/collection/SK-C-5"),
    "https://www.rijksmuseum.nl/en/collection/SK-C-5",
  );
  assert.equal(sourceUrl("http://example.org/x"), "http://example.org/x");
});

test("a dangerous scheme NEVER becomes a link", () => {
  // Values come from an operator-supplied CSV. If a crafted row could emit
  // javascript:/data:, opening someone else's collection would be enough to run it.
  for (const value of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(sourceUrl(value), null, `${value} must not become a link`);
  }
});

test("relative, protocol-relative and malformed values are refused", () => {
  assert.equal(sourceUrl("/local/path"), null);
  assert.equal(sourceUrl("//evil.example/x"), null);
  assert.equal(sourceUrl("not a url"), null);
  assert.equal(sourceUrl("www.example.org"), null); // no scheme ⇒ not absolute
});

test("empty, blank and non-string values are refused", () => {
  assert.equal(sourceUrl(""), null);
  assert.equal(sourceUrl("   "), null);
  assert.equal(sourceUrl(null), null);
  assert.equal(sourceUrl(undefined), null);
  assert.equal(sourceUrl(42), null);
});

test("surrounding whitespace is tolerated — CSV values carry it", () => {
  assert.equal(sourceUrl("  https://example.org/x  "), "https://example.org/x");
});
