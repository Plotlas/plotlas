// The shared per-stage progress checklist (Seam O3) — a GitHub-Actions-style step
// list, reused by BOTH the activity panel and the ingest/add-layouts wizard
// (JobProgressView) so there is ONE honest progress view. Given a JobProgress it
// renders: the top-level stages (prepare/thumbs/tags/detail) as a checklist, the
// per-layout `layout:*` stages as a committed/baking/queued/failed section, a concise
// aria-live current line, and the whole-job "≈ … (estimate)" ETA.
//
// NO-FAKE-PROGRESS is enforced here: a determinate bar renders ONLY where a stage has a
// real `total` (stageBarKind); otherwise an indeterminate shimmer. `now` is injected
// (default Date.now()) so the ETA math is deterministic under test.
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the node test
// runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { JobProgress, JobProgressStage } from "../../api-client/types";
import {
  formatDuration,
  isLayoutStage,
  layoutIdFromKey,
  stageBarKind,
  stageEtaSeconds,
  stageDurationSeconds,
  stageFraction,
  wholeJobEtaSeconds,
} from "./eta.ts";

/** The leading glyph for a stage's state (done ✓ / running ▸ / failed ✕ / pending •). */
export function stageStateIcon(state: JobProgressStage["state"]): string {
  switch (state) {
    case "done":
      return "✓";
    case "failed":
      return "✕";
    case "running":
      return "▸";
    default:
      return "•";
  }
}

/** The per-layout row's committed/baking/queued/failed word (T2-104's exact ask). */
export function layoutStateLabel(state: JobProgressStage["state"]): string {
  switch (state) {
    case "done":
      return "committed";
    case "running":
      return "baking";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

/** A concise, informative line for the currently-running stage (or a terminal summary):
 *  label + live count + own-rate ETA. This is the VISIBLE current line; it updates every
 *  poll tick. It is NOT the announced region (its live count would make a screen reader
 *  re-read on every tick — see currentStatusAnnouncement). Pure + exported for unit tests. */
export function currentStatusLine(progress: JobProgress, nowMs: number): string {
  const running = progress.stages.find((s) => s.state === "running");
  if (running !== undefined) {
    const unit = running.unit ?? "";
    const count =
      running.total !== null && running.total !== undefined
        ? ` — ${running.done.toLocaleString()} / ${running.total.toLocaleString()}${unit !== "" ? ` ${unit}` : ""}`
        : "";
    const eta = stageEtaSeconds(running, nowMs);
    const etaText = eta !== null ? ` · ≈ ${formatDuration(eta)} left` : "";
    return `${running.label}${count}${etaText}`;
  }
  if (progress.stages.some((s) => s.state === "failed")) return "A stage failed.";
  if (progress.stages.length > 0 && progress.stages.every((s) => s.state === "done")) {
    return "All stages complete.";
  }
  return "Waiting…";
}

/** The coarse text for the aria-live region — the running stage's LABEL only (no live
 *  count/ETA), or a terminal summary. Because it changes only when the stage itself
 *  changes (a TRANSITION), a screen reader announces once per stage instead of on every
 *  count tick (the visible currentStatusLine carries the live detail sighted users see).
 *  Pure + exported for unit tests. */
export function currentStatusAnnouncement(progress: JobProgress): string {
  const running = progress.stages.find((s) => s.state === "running");
  if (running !== undefined) return `${running.label} — in progress`;
  if (progress.stages.some((s) => s.state === "failed")) return "A stage failed.";
  if (progress.stages.length > 0 && progress.stages.every((s) => s.state === "done")) {
    return "All stages complete.";
  }
  return "Waiting…";
}

/** A determinate/indeterminate progress bar for a running stage (reuses the shared
 *  .progress-track primitives). NO-FAKE: determinate width ONLY with a real fraction. */
function stageBar(stage: JobProgressStage, label: string): ReactElement | null {
  const kind = stageBarKind(stage);
  if (kind === "none") return null;
  const fraction = stageFraction(stage);
  return h(
    "div",
    {
      className: "progress-track activity-bar",
      role: "progressbar",
      "aria-label": kind === "determinate" ? label : `${label} (indeterminate)`,
    },
    kind === "determinate" && fraction !== null
      ? h("div", { className: "progress-fill", style: { width: `${Math.round(fraction * 100)}%` } })
      : h("div", { className: "progress-indeterminate" }),
  );
}

function countReadout(stage: JobProgressStage): ReactElement | null {
  if (stage.total === null || stage.total === undefined) return null;
  const unit = stage.unit !== null && stage.unit !== undefined ? ` ${stage.unit}` : "";
  return h(
    "span",
    { className: "activity-stage-count" },
    `${stage.done.toLocaleString()} / ${stage.total.toLocaleString()}${unit}`,
  );
}

function mainStageRow(stage: JobProgressStage, nowMs: number): ReactElement {
  const eta = stageEtaSeconds(stage, nowMs);
  const dur = stage.state === "done" ? stageDurationSeconds(stage) : null;
  return h(
    "li",
    { key: stage.key, className: `activity-stage activity-stage-${stage.state}` },
    h(
      "div",
      { className: "activity-stage-head" },
      h("span", { className: "activity-stage-icon", "aria-hidden": "true" }, stageStateIcon(stage.state)),
      h("span", { className: "activity-stage-label" }, stage.label),
      stage.state === "running" ? countReadout(stage) : null,
      stage.state === "running" && eta !== null
        ? h("span", { className: "activity-stage-eta" }, `≈ ${formatDuration(eta)}`)
        : null,
      dur !== null ? h("span", { className: "activity-stage-dur" }, formatDuration(dur)) : null,
    ),
    stageBar(stage, stage.label),
  );
}

function layoutRow(stage: JobProgressStage): ReactElement {
  const id = layoutIdFromKey(stage.key);
  return h(
    "li",
    { key: stage.key, className: `activity-layout activity-layout-${stage.state}` },
    h(
      "div",
      { className: "activity-layout-head" },
      h("span", { className: "activity-layout-icon", "aria-hidden": "true" }, stageStateIcon(stage.state)),
      h("span", { className: "activity-layout-label" }, id),
      h("span", { className: "activity-layout-state" }, layoutStateLabel(stage.state)),
      stage.state === "running" ? countReadout(stage) : null,
    ),
    stageBar(stage, `${id} bake`),
  );
}

export interface StageChecklistProps {
  progress: JobProgress;
  /** Injected clock (ms) for deterministic ETA under test; defaults to Date.now(). */
  now?: number;
}

export function StageChecklist(props: StageChecklistProps): ReactElement {
  const nowMs = props.now ?? Date.now();
  const { progress } = props;
  const mainStages = progress.stages.filter((s) => !isLayoutStage(s));
  const layoutStages = progress.stages.filter(isLayoutStage);
  const jobEta = wholeJobEtaSeconds(progress, nowMs);

  return h(
    "div",
    { className: "stage-checklist" },
    // Visible current line: the live label + count + ETA sighted users read (re-rendered
    // every tick). NOT announced — its live count would make a screen reader re-read on
    // every poll.
    h("p", { className: "activity-current" }, currentStatusLine(progress, nowMs)),
    // Separate, visually-hidden aria-live region carrying only the COARSE announcement
    // (stage label / terminal summary): its text changes on a stage TRANSITION, not on a
    // count tick, so a screen reader announces once per stage rather than continuously.
    h(
      "p",
      { className: "sr-only", role: "status", "aria-live": "polite" },
      currentStatusAnnouncement(progress),
    ),
    mainStages.length > 0
      ? h(
          "ul",
          { className: "activity-stages", "aria-label": "Stages" },
          mainStages.map((s) => mainStageRow(s, nowMs)),
        )
      : null,
    layoutStages.length > 0
      ? h(
          "div",
          { className: "activity-layouts" },
          h("p", { className: "activity-section-title" }, "Layouts"),
          h(
            "ul",
            { className: "activity-layout-rows", "aria-label": "Layouts" },
            layoutStages.map((s) => layoutRow(s)),
          ),
        )
      : null,
    // The whole-job estimate — ALWAYS labelled "estimate", NEVER a bare fact; absent
    // (degrade to nothing) when there is no honest basis (eta.wholeJobEtaSeconds).
    jobEta !== null
      ? h(
          "p",
          { className: "activity-eta" },
          `≈ ${formatDuration(jobEta)} remaining `,
          h("span", { className: "activity-eta-tag" }, "· estimate"),
        )
      : null,
  );
}
