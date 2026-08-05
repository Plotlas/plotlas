// Link safety for the schema v2.8 `url` column role.
//
// A column named in `column_roles.url` holds URLs, and the panel renders its value as an
// anchor instead of plain text. This module decides ONE thing: whether a given value may
// become a live link.
//
// It is separate and pure because it enforces a security rule the schema states
// normatively. A role map is operator-supplied configuration that travels INSIDE a
// dataset, and the values come from a user-supplied CSV — so a `javascript:` or `data:`
// target must be unrepresentable at the point of rendering, not merely discouraged in
// prose. Everything that is not an absolute http(s) URL resolves to null here, and null
// renders as the same inert text as any other field.
//
// Nothing here fetches, HEADs or validates the target: the application documents that it
// makes no outbound network calls, and link-checking would falsify that.

/** Only these may ever become a live link. `javascript:`, `data:`, `vbscript:`,
 *  protocol-relative `//host` and bare relative paths are all excluded — an absolute
 *  http(s) URL is the entire permitted set. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The href for a cell's value, or `null` when it must not be a link.
 *
 * Parses rather than pattern-matches: the URL parser is the authority on what a scheme
 * is, and a hand-rolled `startsWith("http")` would accept `http:evil` while missing
 * `HTTPS://`. Anything that is not a URL at all throws and resolves to null.
 */
export function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null;
}
