// Tier-1 (Phase C, brief §3.1): the CLIENT-SIDE first-data-row sample parser
// (§2 — the role table shows one sample value per column; parsed from the local
// File, never sent to the server). Same dialect rules as the header parse:
// commas outside quotes, "" escapes, TSV by extension; a missing row yields {}.
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCsvFirstRow,
  parseFirstRowFor,
  parseTsvFirstRow,
} from "../src/ui/admin/csvHeader.ts";

test("parseCsvFirstRow: normal row", () => {
  assert.deepEqual(parseCsvFirstRow("filename,date,category\nimg_000.png,2026-01-02,cats\n"), [
    "img_000.png",
    "2026-01-02",
    "cats",
  ]);
});

test("parseCsvFirstRow: quoted comma stays one field; escaped quotes decode", () => {
  assert.deepEqual(
    parseCsvFirstRow('filename,place,note\nimg.png,"Paris, France","say ""hi"""\n'),
    ["img.png", "Paris, France", 'say "hi"'],
  );
});

test("parseCsvFirstRow: reads row 2 even with no trailing newline", () => {
  assert.deepEqual(parseCsvFirstRow("a,b,c\n1,2,3"), ["1", "2", "3"]);
});

test("parseCsvFirstRow: header only (no data row) yields []", () => {
  assert.deepEqual(parseCsvFirstRow("filename,date\n"), []);
  assert.deepEqual(parseCsvFirstRow("filename,date"), []);
});

test("parseCsvFirstRow: empty input and unbalanced quote yield []", () => {
  assert.deepEqual(parseCsvFirstRow(""), []);
  assert.deepEqual(parseCsvFirstRow('a,b\nx,"broken\n'), []);
});

test("parseTsvFirstRow: tab-split second line; header-only yields []", () => {
  assert.deepEqual(parseTsvFirstRow("a\tb\tc\n1\t2\t3\n"), ["1", "2", "3"]);
  assert.deepEqual(parseTsvFirstRow("a\tb\tc\n"), []);
  assert.deepEqual(parseTsvFirstRow("a\tb\tc"), []);
});

test("parseFirstRowFor: keys samples by header name, picks parser by extension", () => {
  const csv = "filename,date,category\nimg_000.png,2026-01-02,cats\n";
  assert.deepEqual(parseFirstRowFor("meta.csv", csv), {
    filename: "img_000.png",
    date: "2026-01-02",
    category: "cats",
  });
  const tsv = "filename\tcategory\nimg.png\tdogs\n";
  assert.deepEqual(parseFirstRowFor("meta.tsv", tsv), { filename: "img.png", category: "dogs" });
});

test("parseFirstRowFor: omits columns with no value (caller renders —)", () => {
  // Row shorter than the header: the trailing column is omitted, not "".
  const csv = "filename,date,category\nimg.png,,\n";
  assert.deepEqual(parseFirstRowFor("meta.csv", csv), { filename: "img.png" });
  // No data row at all → empty map.
  assert.deepEqual(parseFirstRowFor("meta.csv", "filename,date\n"), {});
});