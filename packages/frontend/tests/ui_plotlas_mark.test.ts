// Tier-1 component smoke (brief §3.5): react-dom/server renderToString, no jsdom.
// Pins the invariants the whole brand leans on — the apex tile is the ONLY accent
// (never in `muted`), the size→variant default, the micro/full tile counts — plus
// the a11y contract: decorative (aria-hidden) by default, a named image only when
// used standalone. These are pure-render properties of PlotlasMark; the per-surface
// placement choices (which size each caller passes) live in their own components.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { PlotlasMark, PLOTLAS_VERSION } from "../src/ui/PlotlasMark.ts";

/** How many <rect> tiles the mark drew. */
function rectCount(html: string): number {
  return (html.match(/<rect/g) ?? []).length;
}
/** How many tiles use the accent token — the apex is meant to be the only one. */
function accentCount(html: string): number {
  return (html.match(/var\(--accent\)/g) ?? []).length;
}

test("full variant: five tiles, exactly one accent (the apex)", () => {
  const html = renderToString(h(PlotlasMark, { size: 36 }));
  assert.equal(rectCount(html), 5);
  assert.equal(accentCount(html), 1, "the apex tile is the only accent");
});

test("micro variant: three tiles, still a single apex accent", () => {
  const html = renderToString(h(PlotlasMark, { size: 10, variant: "micro" }));
  assert.equal(rectCount(html), 3);
  assert.equal(accentCount(html), 1);
});

test("muted variant: full five-tile layout, no accent at all", () => {
  // "No accent until there's data" — the empty-state mark must never show yellow.
  const html = renderToString(h(PlotlasMark, { size: 36, variant: "muted" }));
  assert.equal(rectCount(html), 5, "muted keeps the full five-tile layout");
  assert.equal(accentCount(html), 0, "muted drops the apex accent");
});

test("variant defaults by size: <18px → micro (3 tiles), >=18px → full (5 tiles)", () => {
  // 16px (the viewer nav mark) falls under the micro threshold; 18px (the library
  // lockup) is the full-cluster boundary. Callers pass an explicit `variant` to override.
  assert.equal(rectCount(renderToString(h(PlotlasMark, { size: 16 }))), 3);
  assert.equal(rectCount(renderToString(h(PlotlasMark, { size: 18 }))), 5);
});

test("a11y: decorative by default, a named image only when standalone", () => {
  const bare = renderToString(h(PlotlasMark, { size: 18 }));
  assert.match(bare, /aria-hidden="true"/, "default mark is decorative (no double-announce)");
  assert.doesNotMatch(bare, /role="img"/, "no img role when decorative");

  const labelled = renderToString(h(PlotlasMark, { size: 18, label: "Plotlas" }));
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Plotlas"/);
  assert.doesNotMatch(labelled, /aria-hidden/, "a labelled mark is not hidden");
});

test("PLOTLAS_VERSION is a well-formed version string", () => {
  assert.match(PLOTLAS_VERSION, /^\d+\.\d+/);
});
