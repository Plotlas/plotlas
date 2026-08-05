// The upload byte-progress readout (Seam O4) — the wizard's "uploading" view. Renders the
// aggregated bytes/percent bar, a files-settled count, the few parts in flight (each with
// its own mini bar), any retrying note, and a terminal per-file failure summary. Reuses
// the shared .progress-track primitives + the activity stage-checklist visual language so
// the wizard's upload phase reads like the ingest phase that follows it.
//
// Presentational + pure (snapshot in, DOM out) — the transport (uploadTransport) owns the
// numbers; this only formats them. Seam-internal props. .ts + createElement, runtime
// imports bare/.ts only (the node test runner cannot load JSX/.tsx).
import { createElement as h } from "react";
import type { ReactElement } from "react";
import type { BatchSnapshot, PartOutcome } from "./uploadTransport";
import { formatBytes } from "./uploadSelection.ts";

export interface UploadProgressViewProps {
  snapshot: BatchSnapshot;
  /** Terminal per-file failures collected across the run (shown when the batch settles
   *  with failures — the run keeps going, then reports). */
  failures?: PartOutcome[];
  /** A short label for the phase, e.g. "Uploading" / "Sending remaining files". */
  label?: string;
}

/** The whole-batch percent (bytes-based; falls back to the file fraction when the
 *  selection is all zero-byte, which never happens for real images). Clamped to [0,100]. */
export function batchPercent(snapshot: BatchSnapshot): number {
  const raw =
    snapshot.totalBytes > 0
      ? snapshot.loadedBytes / snapshot.totalBytes
      : snapshot.totalFiles > 0
        ? snapshot.settledOk / snapshot.totalFiles
        : 0;
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}

function inFlightRow(part: { name: string; loadedBytes: number; totalBytes: number }): ReactElement {
  const pct = part.totalBytes > 0 ? Math.min(100, Math.round((part.loadedBytes / part.totalBytes) * 100)) : 0;
  return h(
    "li",
    { key: part.name, className: "upload-file" },
    h(
      "div",
      { className: "upload-file-head" },
      h("span", { className: "upload-file-name" }, part.name),
      h(
        "span",
        { className: "upload-file-count" },
        `${formatBytes(part.loadedBytes)} / ${formatBytes(part.totalBytes)}`,
      ),
    ),
    h(
      "div",
      { className: "progress-track upload-file-bar" },
      h("div", { className: "progress-fill", style: { width: `${pct}%` } }),
    ),
  );
}

export function UploadProgressView(props: UploadProgressViewProps): ReactElement {
  const { snapshot } = props;
  const pct = batchPercent(snapshot);
  const label = props.label ?? "Uploading";
  const failures = props.failures ?? [];

  return h(
    "section",
    { className: "upload-progress", "aria-label": "Upload progress" },
    // The aggregate bar + the settled-files / bytes readout.
    h(
      "div",
      { className: "upload-progress-head" },
      h("span", { className: "upload-progress-label" }, `${label} — ${snapshot.settledOk.toLocaleString()} of ${snapshot.totalFiles.toLocaleString()} files`),
      h(
        "span",
        { className: "upload-progress-bytes" },
        `${formatBytes(snapshot.loadedBytes)} / ${formatBytes(snapshot.totalBytes)} · ${pct}%`,
      ),
    ),
    h(
      "div",
      {
        className: "progress-track upload-progress-bar",
        role: "progressbar",
        "aria-valuenow": pct,
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-label": "Upload progress",
      },
      h("div", { className: "progress-fill", style: { width: `${pct}%` } }),
    ),
    // The parts currently in flight (bounded parallelism → a handful), each with its bar.
    snapshot.inFlight.length > 0
      ? h(
          "ul",
          { className: "upload-file-rows", "aria-label": "Files in flight" },
          snapshot.inFlight.map((p) => inFlightRow(p)),
        )
      : null,
    // A retrying note (a transient blip is being retried with backoff, not a failure).
    snapshot.retrying.length > 0
      ? h(
          "p",
          { className: "upload-retrying muted", role: "status", "aria-live": "polite" },
          `Retrying ${snapshot.retrying.map((r) => r.name).join(", ")} (attempt ${Math.max(...snapshot.retrying.map((r) => r.attempt))})…`,
        )
      : null,
    // Terminal per-file failures — collected, the run continued, now reported.
    failures.length > 0
      ? h(
          "div",
          { className: "upload-failures" },
          h("p", { className: "error-text" }, `${failures.length} file${failures.length === 1 ? "" : "s"} could not be uploaded:`),
          h(
            "ul",
            { className: "upload-failure-rows" },
            failures.map((f) =>
              h(
                "li",
                { key: f.name, className: "upload-failure" },
                h("span", { className: "upload-file-name" }, f.name),
                h("span", { className: "upload-failure-detail muted" }, f.error?.guidance ?? f.error?.detail ?? "failed"),
              ),
            ),
          ),
        )
      : null,
  );
}
