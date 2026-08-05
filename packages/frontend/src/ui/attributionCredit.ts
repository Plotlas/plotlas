// A collection's source credit, rendered identically wherever it appears (Part D §2/§2b).
//
// One helper so the library card and the viewer footer apply the SAME two rules and
// cannot drift:
//   - emptiness is decided on the TRIMMED credit (a whitespace-only value is "unset", so
//     an empty credit line is never rendered — chrome pretending to be information); and
//   - the credit becomes an anchor ONLY when `url` is an absolute http(s) URL (sourceUrl,
//     the same allow-list as the url column role). Anything else stays plain text — a bad
//     target loses the LINK, never the credit. sourceUrl is computed ONCE here.
import { createElement as h } from "react";
import type { ReactElement } from "react";
import { sourceUrl } from "./sourceLink";

/** The label prefixing every credit. A collection's NAME and its source are routinely
 *  near-identical ("Rijksmuseum Collection" / "Rijksmuseum, Amsterdam"), so an unlabelled
 *  second line under the card title reads as a duplicate title rather than as provenance.
 *  The prefix is what makes it parse as a different KIND of fact. */
const CREDIT_LABEL = "Source";

/** The credit line as a `<p className>`: a muted `Source:` label followed by the credit
 *  (an anchor when `url` is http(s), else plain text). `null` when there is nothing to
 *  show.
 *
 *  The label sits OUTSIDE the anchor deliberately — it is our word, not the
 *  institution's, and underlining it would imply the link points at something called
 *  "Source". */
export function attributionCredit(
  attribution: string | null | undefined,
  url: string | null | undefined,
  className: string,
): ReactElement | null {
  const credit = (attribution ?? "").trim();
  if (credit === "") return null;
  const href = sourceUrl(url);
  return h(
    "p",
    { className, title: `${CREDIT_LABEL}: ${credit}` },
    h("span", { className: "credit-label" }, `${CREDIT_LABEL}: `),
    href !== null
      ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, credit)
      : credit,
  );
}
