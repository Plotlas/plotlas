// Tier-1 tests for the Lightbox (T2-25): (1) a react-dom/server renderToString
// smoke of the presentational body (loading state + a populated state with a
// fields row), and (2) the pure keyboard reducer (←/→ clamp at the ends, esc →
// close, and the typing guard). No jsdom, no testing-library, no new deps — the
// body + reducer are createElement/.ts so the node runner can import them.
// Model: ui_cockpit.test.ts / ui_components.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";

import { LightboxBody, lightboxKeyAction } from "../src/ui/Lightbox.ts";
import type { LightboxBodyProps } from "../src/ui/Lightbox.ts";
import type { MetadataRow } from "../src/api-client/types.ts";

// ---------------------------------------------------------------------------
// LightboxBody — renderToString smoke (loading + populated)
// ---------------------------------------------------------------------------

function baseBodyProps(overrides: Partial<LightboxBodyProps> = {}): LightboxBodyProps {
  return {
    cellId: 7,
    index: 0,
    count: 1,
    image: { kind: "loading", blurUrl: null },
    identity: { filename: null },
    downloadUrl: null,
    downloadName: "cell-7",
    panelOpen: true,
    row: null,
    metaLoading: true,
    metaError: null,
    tagValues: [],
    onPrev: () => {},
    onNext: () => {},
    onClose: () => {},
    onTogglePanel: () => {},
    onRetry: () => {},
    onLocate: null,
    ...overrides,
  };
}

test("LightboxBody loading state: shows the loading note + a dialog role, no image, no arrows (single selection)", () => {
  const html = renderToString(h(LightboxBody, baseBodyProps()));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /Loading…/);
  // No resolved <img> yet, and a single-cell selection hides the nav arrows.
  assert.doesNotMatch(html, /lightbox-img-blur/); // no blur-up source when nothing cached
  assert.doesNotMatch(html, /lightbox-nav-prev/);
  // The inspector is open, showing its "i to hide" hint + the mono cell header.
  assert.match(html, /i to hide/);
  assert.match(html, /cell 7/);
});

test("LightboxBody populated state: full image, a fields row, identity strip, download, and nav arrows (multi)", () => {
  const row: MetadataRow = { id: 3, fields: { filename: "img_003.png", note: null } };
  const html = renderToString(
    h(
      LightboxBody,
      baseBodyProps({
        cellId: 3,
        index: 1,
        count: 4,
        image: { kind: "image", url: "blob:orig-3" },
        identity: { filename: "img_003.png" },
        downloadUrl: "blob:orig-3",
        downloadName: "img_003.png",
        row,
        metaLoading: false,
        tagValues: [{ column: "tags", values: ["a", "b"] }],
        onLocate: () => {},
      }),
    ),
  );
  // Image area shows the resolved original.
  assert.match(html, /class="lightbox-img"[^>]*src="blob:orig-3"/);
  // The field grid is MetadataPanelView's renderer (reused, not forked): title +
  // the field name + the null em-dash.
  assert.match(html, /Cell 3/);
  assert.match(html, /img_003\.png/);
  assert.match(html, /note/);
  assert.match(html, /—/);
  // Tag chips from the sidecar values.
  assert.match(html, /chip chip-static[^>]*>a</);
  assert.match(html, /chip chip-static[^>]*>b</);
  // Identity strip: filename · download anchor to the object URL · "2 / 4 selected".
  assert.match(html, /Download original ↗/);
  assert.match(html, /href="blob:orig-3"/);
  assert.match(html, /2 \/ 4 selected/);
  // A multi-selection shows the nav arrows; at index 1 of 4, neither end-disabled.
  assert.match(html, /lightbox-nav-prev/);
  assert.match(html, /lightbox-nav-next/);
  // Locate button present when onLocate is wired.
  assert.match(html, /Locate on canvas/);
});

test("LightboxBody failure state: inline retry, never a dead overlay", () => {
  const html = renderToString(h(LightboxBody, baseBodyProps({ image: { kind: "failed" } })));
  assert.match(html, /Couldn’t load/);
  assert.match(html, /Retry/);
});

test("LightboxBody none state (detail_tier=skip): graceful 'no original', no download affordance", () => {
  // T2-46: with no detail tier baked the lightbox still opens (metadata + nav work)
  // and degrades to a clear 'no original' message — never a broken <img> or a dead
  // overlay. downloadUrl is null (nothing to download), so no download anchor renders.
  const html = renderToString(
    h(LightboxBody, baseBodyProps({ image: { kind: "none" }, downloadUrl: null })),
  );
  assert.match(html, /No full-resolution original for this cell\./);
  assert.doesNotMatch(html, /class="lightbox-img"/); // no image element
  assert.doesNotMatch(html, /Download original/); // no download affordance without an original
});

test("LightboxBody hides the inspector (and its footer) when the panel is closed", () => {
  const html = renderToString(
    h(LightboxBody, baseBodyProps({ panelOpen: false, onLocate: () => {} })),
  );
  assert.doesNotMatch(html, /lightbox-inspector-title/);
  assert.doesNotMatch(html, /Locate on canvas/);
  // Chrome (toggle + close) is always available even with the panel hidden.
  assert.match(html, /aria-label="Show details"/);
  assert.match(html, /aria-label="Close"/);
});

// ---------------------------------------------------------------------------
// lightboxKeyAction — pure keyboard reducer
// ---------------------------------------------------------------------------

test("lightboxKeyAction: esc closes; i toggles the panel", () => {
  const ctx = { count: 3, index: 1, typing: false };
  assert.deepEqual(lightboxKeyAction("Escape", ctx), { kind: "close" });
  assert.deepEqual(lightboxKeyAction("i", ctx), { kind: "toggle-panel" });
  assert.deepEqual(lightboxKeyAction("I", ctx), { kind: "toggle-panel" });
});

test("lightboxKeyAction: ←/→ step and CLAMP at the ends (no wrap)", () => {
  // Mid-range: both directions move.
  assert.deepEqual(lightboxKeyAction("ArrowLeft", { count: 3, index: 1, typing: false }), {
    kind: "navigate",
    index: 0,
  });
  assert.deepEqual(lightboxKeyAction("ArrowRight", { count: 3, index: 1, typing: false }), {
    kind: "navigate",
    index: 2,
  });
  // At the left end, ArrowLeft clamps (no action); at the right end, ArrowRight clamps.
  assert.deepEqual(lightboxKeyAction("ArrowLeft", { count: 3, index: 0, typing: false }), {
    kind: "none",
  });
  assert.deepEqual(lightboxKeyAction("ArrowRight", { count: 3, index: 2, typing: false }), {
    kind: "none",
  });
});

test("lightboxKeyAction: arrows are inert for a single-cell selection", () => {
  assert.deepEqual(lightboxKeyAction("ArrowLeft", { count: 1, index: 0, typing: false }), {
    kind: "none",
  });
  assert.deepEqual(lightboxKeyAction("ArrowRight", { count: 1, index: 0, typing: false }), {
    kind: "none",
  });
});

test("lightboxKeyAction: every key is a no-op while typing (guard matches ViewerScreen)", () => {
  const typing = { count: 3, index: 1, typing: true };
  for (const key of ["Escape", "i", "ArrowLeft", "ArrowRight", "x"]) {
    assert.deepEqual(lightboxKeyAction(key, typing), { kind: "none" }, key);
  }
});

test("lightboxKeyAction: unrelated keys are ignored", () => {
  assert.deepEqual(lightboxKeyAction("x", { count: 3, index: 1, typing: false }), { kind: "none" });
  assert.deepEqual(lightboxKeyAction("Enter", { count: 3, index: 1, typing: false }), { kind: "none" });
});
