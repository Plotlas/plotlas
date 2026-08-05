// Ingest progress (board 1g, step 3 "Progress"): RQ state + the ingest.log tail
// (the API's fallback signal when RQ state is unavailable). Presentational — the
// wizard drives polling via jobPoll.ts and feeds the latest JobStatus down.
//
// Seam O3 (T2-56): the `%` signal the contract lacked now EXISTS as real per-stage
// fractions (JobStatus.progress, the O1 channel). When present, this view renders the
// shared StageChecklist (real determinate bars ONLY where a stage has a total, honest
// ETAs); the OLD indeterminate bar + bucketed bakeTimeEstimate copy remain ONLY as the
// pre-first-progress fallback (a just-enqueued job before the worker writes stage 1, or
// a pre-O1 job). NO-FAKE-PROGRESS is preserved — the checklist never fabricates a bar.
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the node
// test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import type { JobStatus } from "../../api-client/types";
import { PlotlasMark } from "../PlotlasMark.ts";
import { StageChecklist } from "../activity/stageChecklist.ts";

export interface JobProgressViewProps {
  jobId: string;
  status: JobStatus | null; // null until the first getJob answers
  pollError: string | null; // transport error from polling, if any
  // Images detected in the upload bundle (brief §2): shown FIRST, then a bake-time
  // warning tied to it. null/absent ⇒ the generic wait copy (count not yet known).
  imageCount?: number | null;
}

const STATE_LABEL: Record<string, string> = {
  queued: "Queued…",
  started: "Processing…",
  deferred: "Waiting on another job…",
  scheduled: "Scheduled…",
  finished: "Finished — the dataset is ready.",
  failed: "Failed.",
  stopped: "Stopped.",
  canceled: "Canceled.",
};

const TERMINAL_STATES = new Set(["finished", "failed", "stopped", "canceled"]);

/** A COARSE, honest ingest-time range keyed to the number of images detected — NOT
 *  an ETA (JobStatus carries no completion fraction, T2-56; never fabricate a precise
 *  time or %). Bucketed by order of magnitude; the caller's copy always hedges
 *  ("typically takes …"). Pure. */
export function bakeTimeEstimate(imageCount: number): string {
  if (imageCount <= 1_000) return "a few minutes";
  if (imageCount <= 50_000) return "several minutes to an hour";
  if (imageCount <= 250_000) return "roughly one to a few hours";
  return "several hours or more";
}

/** The non-terminal wait copy: the count FIRST, then a bake-time warning tied to it
 *  (brief §2). Falls back to the generic honest-wait line when the count is unknown
 *  (null). Pure — the render just prints it. */
export function waitCopy(imageCount: number | null): string {
  const tail = "You can leave — it keeps running; the Library shows live status.";
  if (imageCount === null) {
    return `Ingest can take minutes to hours at this scale. ${tail}`;
  }
  const noun = imageCount === 1 ? "image" : "images";
  return `${imageCount.toLocaleString()} ${noun} detected — baking typically takes ${bakeTimeEstimate(imageCount)}. ${tail}`;
}

export function JobProgressView(props: JobProgressViewProps): ReactElement {
  const [logOpen, setLogOpen] = useState(false);
  const state = props.status?.state ?? null;
  const terminal = state !== null && TERMINAL_STATES.has(state);
  const hasLog = props.status !== null && props.status.log_tail.length > 0;
  // Seam O3 (T2-56): real per-stage progress when the O1 channel has written it.
  const progress = props.status?.progress ?? null;

  return h(
    "section",
    { className: "job-progress" },
    h("h3", { className: "panel-title" }, "Ingest"),
    // The mark IS the spinner (board 3d): the five tiles stagger their opacity in
    // a loop (CSS `.plotlas-spinner`, apex last), sitting above the state/bar.
    // Only while the job runs — a looping spinner past a terminal state is noise.
    !terminal
      ? h(
          "div",
          { className: "plotlas-spinner", "aria-hidden": "true" },
          h(PlotlasMark, { size: 44 }),
        )
      : null,
    // Large readout: the state label (no fabricated `%` — real fractions live in the
    // per-stage checklist below).
    h(
      "p",
      { className: state !== null ? `progress-state job-state-${state}` : "progress-state muted" },
      state !== null ? (STATE_LABEL[state] ?? state) : "Fetching job status…",
    ),
    // With real progress: the shared stage checklist (determinate bars ONLY where a
    // stage has a total, honest ETAs). Without it (pre-first-progress / pre-O1 job):
    // the OLD indeterminate bar + count-tied wait copy — the honest fallback.
    progress !== null
      ? h(StageChecklist, { progress })
      : !terminal
        ? h(
            "div",
            {
              className: "progress-track",
              role: "progressbar",
              "aria-label": "Ingest progress (indeterminate)",
            },
            h("div", { className: "progress-indeterminate" }),
          )
        : null,
    props.status?.error != null ? h("p", { className: "error-text" }, props.status.error) : null,
    props.pollError !== null ? h("p", { className: "error-text" }, props.pollError) : null,
    // The honest-wait copy (brief §2, step 3): the image count FIRST, then a bake-time
    // warning tied to it. Shown ONLY as the pre-first-progress fallback — once real
    // stages arrive the checklist's ETA supersedes it. Leaving is safe either way.
    !terminal && progress === null
      ? h("p", { className: "wait-copy muted" }, waitCopy(props.imageCount ?? null))
      : null,
    // Log tail behind a ▸ show log disclosure.
    hasLog
      ? h(
          "div",
          { className: "log-disclosure" },
          h(
            "button",
            {
              type: "button",
              className: "link-btn",
              "aria-expanded": logOpen,
              onClick: () => setLogOpen(!logOpen),
            },
            logOpen ? "▾ hide log" : "▸ show log",
          ),
          logOpen
            ? h("pre", { className: "log-tail" }, (props.status?.log_tail ?? []).join("\n"))
            : null,
        )
      : null,
  );
}
