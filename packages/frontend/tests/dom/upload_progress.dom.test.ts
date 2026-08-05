// DOM tier (Seam O4): the upload byte-progress readout. Renders the aggregate percent
// bar (NO fake — a real bytes fraction), the settled-files count, the parts in flight, the
// retrying note, and the terminal per-file failure summary. Runs under jsdom via the
// test:dom script (react-dom + @testing-library over the createElement component).
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { UploadProgressView, batchPercent } from "../../src/ui/admin/UploadProgressView.ts";
import type { BatchSnapshot } from "../../src/ui/admin/uploadTransport.ts";

afterEach(() => cleanup());

function snap(over: Partial<BatchSnapshot> = {}): BatchSnapshot {
  return {
    totalFiles: 4,
    totalBytes: 400,
    settledOk: 1,
    failed: 0,
    loadedBytes: 150,
    inFlight: [{ name: "b.png", loadedBytes: 50, totalBytes: 100 }],
    retrying: [],
    ...over,
  };
}

test("batchPercent is a clamped, rounded bytes fraction", () => {
  assert.equal(batchPercent(snap()), 38); // 150/400 → 37.5 → 38
  assert.equal(batchPercent(snap({ loadedBytes: 0 })), 0);
  assert.equal(batchPercent(snap({ loadedBytes: 400 })), 100);
});

test("renders the aggregate percent bar, the settled count, and the in-flight file", () => {
  const { container } = render(h(UploadProgressView, { snapshot: snap() }));
  const bar = container.querySelector('[role="progressbar"]');
  assert.ok(bar, "a progressbar renders");
  assert.equal(bar?.getAttribute("aria-valuenow"), "38");
  const fill = bar?.querySelector(".progress-fill");
  assert.match(fill?.getAttribute("style") ?? "", /width:\s*38%/);
  assert.ok(screen.getByText(/1 of 4 files/), "the settled-files readout");
  assert.ok(screen.getByText("b.png"), "the in-flight file name");
});

test("shows a retrying note and a terminal failure summary", () => {
  render(
    h(UploadProgressView, {
      snapshot: snap({ retrying: [{ name: "c.png", attempt: 2, waitMs: 2000 }] }),
      failures: [{ name: "bad.png", status: "failed", error: { status: 409, detail: "conflict", guidance: "rename it and retry" } }],
    }),
  );
  assert.ok(screen.getByText(/Retrying c\.png \(attempt 2\)/));
  assert.ok(screen.getByText(/1 file could not be uploaded/));
  assert.ok(screen.getByText("rename it and retry"), "the 409 guidance is shown over the raw detail");
});
