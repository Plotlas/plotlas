// The designer's commit bar (seam L3 §2b.3; LAYOUT_DESIGNER D-xx/D-xxi; boards `Main`,
// `RoleConsequences`, and the 390 px `MobileData` / `MobileLayouts`).
//
// It lives at DESIGNER level, identical on all three tabs, so switching tab can never
// quietly abandon a pending change. It counts ONLY what costs — at most two counts,
// invalidating role changes and bakes — each with one consequence line in
// RoleConsequences' words (the text comes from pending.ts `barSummary`, so the bar and
// its tests read one source). Free edits never appear here: they saved as they were
// typed. When nothing is pending it says so and prices nothing.
//
// Nothing here can start a bake. *Review & commit* calls `onReview`, which the shell
// supplies only when a review sheet exists (seam L5) — until then it is null and the
// button is disabled (D-xxi: every bake passes through the review).
//
// Presentational: .ts + createElement, node-test importable.
import { createElement as h } from "react";
import type { ReactElement } from "react";
import { barSummary } from "./pending";
import type { PendingDerivation } from "./pending";

export interface CommitBarProps {
  derived: PendingDerivation;
  /** Throw away every pending change (the draft returns to the committed roles). */
  onDiscard: () => void;
  /** Open the review sheet, or null when there is none to open. */
  onReview: (() => void) | null;
}

export function CommitBar(props: CommitBarProps): ReactElement {
  const bar = barSummary(props.derived);
  const counts: ReactElement[] = [];
  if (bar.invalidating !== null) {
    const { count, title, columns, consequence } = bar.invalidating;
    counts.push(
      h(
        "div",
        { key: "invalidating", className: "commit-count" },
        h(
          "p",
          { className: "commit-count-title" },
          h("span", { className: "commit-count-n" }, `${count} invalidating`),
          title.slice(`${count} invalidating`.length),
        ),
        h(
          "p",
          { className: "commit-count-line" },
          h("span", { className: "commit-count-cols" }, columns.join(", ")),
          ` · ${consequence}`,
        ),
      ),
    );
  }
  if (bar.bakes !== null) {
    const { count, title, consequence } = bar.bakes;
    const noun = `${count} bake${count === 1 ? "" : "s"}`;
    counts.push(
      h(
        "div",
        { key: "bakes", className: "commit-count" },
        h(
          "p",
          { className: "commit-count-title" },
          h("span", { className: "commit-count-n" }, noun),
          title.slice(noun.length),
        ),
        h("p", { className: "commit-count-line" }, consequence),
      ),
    );
  }

  const left = bar.empty
    ? h(
        "p",
        { className: "commit-empty" },
        "Nothing pending. Changes here save as you type — only role changes and bakes wait for a commit.",
      )
    : h(
        "div",
        { className: "commit-counts" },
        bar.problem !== null
          ? h("p", { key: "problem", className: "commit-problem", role: "alert" }, `Can't commit yet — ${bar.problem}`)
          : null,
        ...counts,
      );

  const canReview = !bar.empty && bar.problem === null && props.onReview !== null;
  return h(
    "footer",
    { className: "commit-bar", "aria-label": "Pending changes" },
    left,
    h(
      "div",
      { className: "commit-actions" },
      bar.empty
        ? null
        : h(
            "p",
            { className: "commit-note" },
            "Nothing has started. The atlas keeps serving what is live until you commit.",
          ),
      h(
        "button",
        { type: "button", className: "btn ghost", disabled: bar.empty, onClick: props.onDiscard },
        "Discard",
      ),
      h(
        "button",
        {
          type: "button",
          className: "btn pri commit-review",
          disabled: !canReview,
          title:
            props.onReview === null && !bar.empty
              ? "The review sheet arrives with the Layouts view"
              : undefined,
          onClick: () => props.onReview?.(),
        },
        "Review & commit ›",
      ),
    ),
  );
}
