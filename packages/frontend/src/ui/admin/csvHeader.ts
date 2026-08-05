// CLIENT-SIDE CSV header parsing (brief §0.5): the role-assignment dropdowns
// read the first row of the LOCAL File before/while uploading — there is no
// header-preview endpoint and none is needed; the server re-validates roles at
// ingest (D-11). Minimal quoting support: split on commas OUTSIDE double
// quotes, honor "" escapes; a malformed header (unbalanced quote) yields []
// and the wizard falls back to editable free-text column inputs.
//
// Pure, dependency-free, node-test importable.

/** Parse the header row out of CSV text (only the first line is examined).
 *  Returns [] for empty or malformed input. */
export function parseCsvHeader(text: string): string[] {
  if (text.length === 0) return [];

  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // Quoted fields may contain commas and even newlines.
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      fields.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      break; // end of the header row
    }
    current += ch;
    i += 1;
  }

  if (inQuotes) return []; // unbalanced quote: malformed header
  fields.push(current);

  const trimmed = fields.map((f) => f.trim());
  if (trimmed.every((f) => f === "")) return [];
  return trimmed;
}

/** Separator-aware variant for `.tsv` metadata files (uploads accept both). */
export function parseTsvHeader(text: string): string[] {
  if (text.length === 0) return [];
  const line = text.split(/\r?\n/, 1)[0];
  const fields = line.split("\t").map((f) => f.trim());
  if (fields.every((f) => f === "")) return [];
  return fields;
}

/** Pick the parser by filename extension (default CSV). */
export function parseHeaderFor(filename: string, text: string): string[] {
  return /\.tsv$/i.test(filename) ? parseTsvHeader(text) : parseCsvHeader(text);
}

/** Parse the FIRST DATA ROW (row 2) out of CSV text, honoring the same quoting
 *  rules as parseCsvHeader (commas outside quotes; "" escapes; a quoted field
 *  may span newlines). Returns [] when there is no data row or the row is
 *  malformed. Used only to show a SAMPLE value per column in the role table —
 *  never sent to the server (the ingest re-reads the file itself). */
export function parseCsvFirstRow(text: string): string[] {
  if (text.length === 0) return [];

  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let row = 0; // 0 = header, 1 = first data row
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (row === 1) current += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (row === 1) current += ch; // quoted fields may contain commas/newlines
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      if (row === 1) {
        fields.push(current);
        current = "";
      }
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      // A CR/LF ends the current UNquoted row. Consume the newline (and a
      // paired \n after \r) and advance the row counter.
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      i += 1;
      if (row === 1) break; // end of the first data row
      row = 1; // header consumed; the next row is the sample row
      continue;
    }
    if (row === 1) current += ch;
    i += 1;
  }

  if (inQuotes) return []; // unbalanced quote: malformed
  if (row !== 1) return []; // no data row at all
  fields.push(current);
  const trimmed = fields.map((f) => f.trim());
  // A wholly-empty data row (e.g. the header line ended the input, or a bare
  // blank second line) means "no sample row" — mirror parseCsvHeader.
  if (trimmed.every((f) => f === "")) return [];
  return trimmed;
}

/** Separator-aware first-data-row variant for `.tsv` metadata files. */
export function parseTsvFirstRow(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const row = lines[1];
  // A trailing newline yields a final "" element; treat a wholly-empty second
  // line as "no data row".
  if (row === "" && lines.length === 2) return [];
  return row.split("\t").map((f) => f.trim());
}

/** Parse a first-data-row sample map keyed by header name (brief §2 — the role
 *  table shows a sample value per column). Picks the parser by extension (same
 *  dialect as parseHeaderFor), pairs the header names to the first row's values
 *  positionally, and OMITS any column with no value (the caller renders `—`).
 *  Pure + no network — the ingest re-reads the file itself. */
export function parseFirstRowFor(filename: string, text: string): Record<string, string> {
  const header = parseHeaderFor(filename, text);
  if (header.length === 0) return {};
  const values = /\.tsv$/i.test(filename) ? parseTsvFirstRow(text) : parseCsvFirstRow(text);
  const samples: Record<string, string> = {};
  header.forEach((name, i) => {
    const v = values[i];
    if (v !== undefined && v !== "") samples[name] = v;
  });
  return samples;
}
