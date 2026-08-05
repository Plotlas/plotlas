// DOM tier — the source credit rides INSIDE the status bar (Part D polish).
//
// It used to render as a second floating strip of its own (`viewer-attribution
// panel-float`), which put two footers on the canvas. The operator asked for one footer,
// with the credit immediately left of the `plotlas` brand signature.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, render } from "@testing-library/react";
import { createElement as h } from "react";
import { StatusBar } from "../../src/ui/StatusBar.ts";
import type { ViewerStatus } from "../../src/ui/StatusBar.ts";
import { attributionCredit } from "../../src/ui/attributionCredit.ts";

afterEach(cleanup);

const STATUS: ViewerStatus = {
  layoutId: "grid",
  zoom: 1,
  inView: 42,
  loadingTiles: 0,
  tags: { status: "ok", highlighted: 0 },
  selectedCell: null,
  cursor: null,
  fps: 60,
};

test("no credit ⇒ the status bar renders exactly as before", () => {
  render(h(StatusBar, { status: STATUS }));
  assert.equal(document.querySelector(".status-credit"), null);
  assert.ok(document.querySelector(".status-brand"));
});

test("a credit renders INSIDE the status bar, not as a separate footer", () => {
  render(
    h(StatusBar, {
      status: STATUS,
      credit: attributionCredit("Rijksmuseum, Amsterdam", null, "status-item status-credit"),
    }),
  );
  const bar = document.querySelector(".status-bar");
  assert.ok(bar);
  // Inside the ONE footer — the whole point of the change.
  assert.ok(bar.querySelector(".status-credit"));
  // ...and there is no second floating strip left behind.
  assert.equal(document.querySelector(".viewer-attribution"), null);
  assert.equal(document.querySelectorAll("footer").length, 1);
});

test("the credit sits immediately LEFT of the brand signature", () => {
  render(
    h(StatusBar, {
      status: STATUS,
      credit: attributionCredit("Rijksmuseum, Amsterdam", null, "status-item status-credit"),
    }),
  );
  const items = [...document.querySelectorAll(".status-bar .status-item")];
  const creditIdx = items.findIndex((e) => e.classList.contains("status-credit"));
  const brandIdx = items.findIndex((e) => e.classList.contains("status-brand"));
  assert.ok(creditIdx >= 0 && brandIdx >= 0);
  assert.equal(brandIdx, creditIdx + 1, "credit must be the item directly before the brand");
});

test("a credit with a link keeps the anchor inside the bar", () => {
  render(
    h(StatusBar, {
      status: STATUS,
      credit: attributionCredit(
        "Rijksmuseum, Amsterdam",
        "https://www.rijksmuseum.nl",
        "status-item status-credit",
      ),
    }),
  );
  const a = document.querySelector(".status-bar .status-credit a");
  assert.ok(a);
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
});
