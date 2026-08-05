// Tier-1 (brief §3.5): the CLIENT-SIDE CSV header parser (§0.5 — no preview
// endpoint exists; the server re-validates at ingest, D-11). Includes the
// required quoted-comma case; malformed input falls back to [] (the wizard
// then offers free-text column inputs).
import assert from "node:assert/strict";
import test from "node:test";

import { parseCsvHeader, parseHeaderFor, parseTsvHeader } from "../src/ui/admin/csvHeader.ts";

test("plain comma-separated header", () => {
  assert.deepEqual(parseCsvHeader("filename,date,category,tags\nrow1..."), [
    "filename",
    "date",
    "category",
    "tags",
  ]);
});

test("quoted header containing a comma stays one field", () => {
  assert.deepEqual(parseCsvHeader('filename,"location, city",tags\n'), [
    "filename",
    "location, city",
    "tags",
  ]);
});

test("escaped double quotes inside a quoted field", () => {
  assert.deepEqual(parseCsvHeader('a,"say ""hi"", ok",c'), ["a", 'say "hi", ok', "c"]);
});

test("CRLF line endings stop at the header row", () => {
  assert.deepEqual(parseCsvHeader("a,b,c\r\n1,2,3\r\n"), ["a", "b", "c"]);
});

test("whitespace around names is trimmed; inner spaces survive", () => {
  assert.deepEqual(parseCsvHeader(" filename , shot location ,tags"), [
    "filename",
    "shot location",
    "tags",
  ]);
});

test("malformed header (unbalanced quote) yields [] — free-text fallback", () => {
  assert.deepEqual(parseCsvHeader('filename,"broken,tags\n'), []);
});

test("empty / blank input yields []", () => {
  assert.deepEqual(parseCsvHeader(""), []);
  assert.deepEqual(parseCsvHeader("\n"), []);
  assert.deepEqual(parseCsvHeader(",,"), []);
});

test("TSV headers split on tabs; parseHeaderFor picks by extension", () => {
  assert.deepEqual(parseTsvHeader("a\tb\tc\nrow"), ["a", "b", "c"]);
  assert.deepEqual(parseHeaderFor("meta.tsv", "a\tb\nrow"), ["a", "b"]);
  assert.deepEqual(parseHeaderFor("meta.csv", "a,b\nrow"), ["a", "b"]);
});
