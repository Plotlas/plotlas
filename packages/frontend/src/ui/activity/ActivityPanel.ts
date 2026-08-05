// The activity panel (Seam O3): the anchored popover the pill opens (the DatasetList
// ⋯-menu + viewport-flip precedent). One section per tracked job — dataset id, overall
// state chip, the shared StageChecklist (real per-stage bars, per-layout committed/
// baking/queued rows, honest ETA), a dismiss affordance for terminal jobs, and the
// ingest.log tail behind a disclosure for a FAILED job.
//
// Presentational: the pill owns open/close + the flip measurement and passes `jobs`,
// `flipUp`, and `onDismiss` down. .ts + createElement, runtime imports bare-only.
import { createElement as h, useState } from "react";
import type { ReactElement } from "react";
import type { JobStatus } from "../../api-client/types";
import { TERMINAL_JOB_STATES } from "../admin/jobPoll.ts";
import { StageChecklist } from "./stageChecklist.ts";
import type { TrackedJob } from "./activityStore";

/** Overall job label + status-chip tone from the RQ state (null status ⇒ queued).
 *  tone reuses the existing .status-{processing|ready|error} chip palette. Pure +
 *  exported for unit tests. */
export function jobOverall(status: JobStatus | null): {
  label: string;
  tone: "processing" | "ready" | "error";
} {
  if (status === null) return { label: "Queued", tone: "processing" };
  switch (status.state) {
    case "finished":
      return { label: "Done", tone: "ready" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "stopped":
    case "canceled":
      return { label: "Stopped", tone: "error" };
    case "queued":
      return { label: "Queued", tone: "processing" };
    default:
      return { label: "Processing", tone: "processing" };
  }
}

function isTerminal(status: JobStatus | null): boolean {
  return status !== null && TERMINAL_JOB_STATES.has(status.state);
}

/** The failed job's ingest.log tail behind a ▸ disclosure (mirrors JobProgress). */
function FailureDisclosure(props: { status: JobStatus }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const log = props.status.log_tail;
  if (log.length === 0) return null;
  return h(
    "div",
    { className: "log-disclosure" },
    h(
      "button",
      {
        type: "button",
        className: "link-btn",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
      },
      open ? "▾ hide log" : "▸ show log",
    ),
    open ? h("pre", { className: "log-tail" }, log.join("\n")) : null,
  );
}

function jobSection(
  job: TrackedJob,
  onDismiss: (jobId: string) => void,
  nameFor: (dsId: string) => string,
): ReactElement {
  // A job the poller gave up on reads with its own "Unreachable" chip (error tone) and,
  // like a terminal job, can be dismissed — it no longer polls or counts as active.
  const overall: { label: string; tone: "processing" | "ready" | "error" } = job.unreachable
    ? { label: "Unreachable", tone: "error" }
    : jobOverall(job.status);
  const terminal = isTerminal(job.status) || job.unreachable;
  const progress = job.status?.progress ?? null;
  // Resolve the collection name once (nameFor can be an O(n) lookup): the row uses it as
  // both its aria-label and its visible text, with the raw id kept as the tooltip.
  const name = nameFor(job.dsId);
  return h(
    "li",
    { key: job.jobId, className: "activity-job", "aria-label": name },
    h(
      "div",
      { className: "activity-job-head" },
      h("span", { className: "activity-job-ds", title: job.dsId }, name),
      h("span", { className: `status-chip status-${overall.tone}` }, overall.label),
      terminal
        ? h(
            "button",
            {
              type: "button",
              className: "link-btn activity-dismiss",
              onClick: () => onDismiss(job.jobId),
            },
            "Dismiss",
          )
        : null,
    ),
    progress !== null
      ? h(StageChecklist, { progress })
      : h(
          "p",
          { className: "muted activity-job-wait" },
          job.unreachable
            ? "Could not reach this job — it may still be running on the server."
            : terminal
              ? "No stage detail was recorded."
              : "Waiting for the first progress update…",
        ),
    // A failed RQ job: the last-line error, then the ingest.log tail on demand.
    job.status?.error != null && job.status.error !== ""
      ? h("p", { className: "error-text" }, job.status.error)
      : null,
    // A transport error while polling. A one-off blip is kept live ("Connection issue",
    // the job keeps polling); a job we GAVE UP on names it as the give-up reason.
    job.pollError !== null
      ? h(
          "p",
          { className: "muted activity-poll-error" },
          job.unreachable ? `Gave up polling: ${job.pollError}` : `Connection issue: ${job.pollError}`,
        )
      : null,
    job.status !== null && job.status.state === "failed"
      ? h(FailureDisclosure, { status: job.status })
      : null,
  );
}

export interface ActivityPanelProps {
  jobs: TrackedJob[];
  onDismiss: (jobId: string) => void;
  /** Part D §2c: resolve a dataset id to what the collection is CALLED. Optional and
   *  identity by default — the activity STORE holds only ids (it must not depend on
   *  the dataset list), so the caller that already has the summaries supplies this and
   *  a caller that does not simply shows the id, as before. */
  nameFor?: (dsId: string) => string;
  /** Open upward (flipped) when there is not enough room below the pill. */
  flipUp?: boolean;
}

export function ActivityPanel(props: ActivityPanelProps): ReactElement {
  return h(
    "div",
    {
      className: props.flipUp ? "activity-panel panel-float activity-panel-up" : "activity-panel panel-float",
      role: "dialog",
      "aria-label": "Active jobs",
    },
    h("h3", { className: "panel-title activity-panel-title" }, "Activity"),
    props.jobs.length === 0
      ? h("p", { className: "muted" }, "No active jobs.")
      : h(
          "ul",
          { className: "activity-job-list" },
          props.jobs.map((job) =>
            jobSection(job, props.onDismiss, props.nameFor ?? ((dsId) => dsId)),
          ),
        ),
  );
}
