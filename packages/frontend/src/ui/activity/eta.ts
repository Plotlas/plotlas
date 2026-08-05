// Honest, measured-rate ETA math for the activity panel (Seam O3, spike §3). Pure
// functions over a JobProgress snapshot — no timers, no DOM — so the whole model is
// unit-tested with an injected `now`.
//
// The BINDING rule (spike §3, "NO FAKE PROGRESS"): an ETA is derived ONLY from a
// stage's OWN measured rate this run (elapsed / done). No total ⇒ no ETA; done==0 ⇒
// no ETA; degrade to null (the caller renders nothing) rather than fabricate. The
// whole-job number is explicitly an ESTIMATE that jumps at each stage boundary
// (rsync's `--info=progress2` lesson: an honest number that jumps beats a smooth
// fabrication) and NEVER drives a bar width or a percentage.
//
// Node-test importable (type-only src imports).
import type { JobProgress, JobProgressStage } from "../../api-client/types";

/** Key prefix the pipeline uses for the per-layout bake stages (`layout:{layout_id}`). */
export const LAYOUT_STAGE_PREFIX = "layout:";

/** True for a `layout:{layout_id}` per-layout bake stage (vs a top-level stage). */
export function isLayoutStage(stage: JobProgressStage): boolean {
  return stage.key.startsWith(LAYOUT_STAGE_PREFIX);
}

/** The `{layout_id}` a `layout:*` stage bakes (the raw key for a non-layout stage). */
export function layoutIdFromKey(key: string): string {
  return key.startsWith(LAYOUT_STAGE_PREFIX) ? key.slice(LAYOUT_STAGE_PREFIX.length) : key;
}

/** Whether a RUNNING stage renders a determinate bar (real `total`) or an
 *  indeterminate shimmer. Pure + exported so the NO-FAKE rule is unit-testable.
 *  A non-running stage has no bar ("none"). */
export function stageBarKind(stage: JobProgressStage): "determinate" | "indeterminate" | "none" {
  if (stage.state !== "running") return "none";
  return stage.total !== null && stage.total !== undefined && stage.total > 0
    ? "determinate"
    : "indeterminate";
}

/** Completion fraction in [0,1] for a stage with a REAL total, else null (NO-FAKE:
 *  a null total never yields a fraction). Clamped defensively. */
export function stageFraction(stage: JobProgressStage): number | null {
  if (stage.total === null || stage.total === undefined || stage.total <= 0) return null;
  return Math.max(0, Math.min(1, stage.done / stage.total));
}

/** Seconds of remaining work for a RUNNING stage from its OWN measured rate this run:
 *  `(now - t_start) * (total - done) / done`  ≡  remaining_units / (done/elapsed).
 *  Returns null unless the stage is running with a known total, a positive `done`, a
 *  start time, AND positive elapsed time (the NO-FAKE guards); 0 once `done >= total`.
 *  `nowMs` is Date.now()-style milliseconds; `t_start` is epoch SECONDS (the pipeline's
 *  unit). */
export function stageEtaSeconds(stage: JobProgressStage, nowMs: number): number | null {
  if (stage.state !== "running") return null;
  if (stage.total === null || stage.total === undefined) return null;
  if (stage.t_start === null || stage.t_start === undefined) return null;
  if (stage.done <= 0) return null;
  const remainingUnits = stage.total - stage.done;
  if (remainingUnits <= 0) return 0;
  const elapsedSec = nowMs / 1000 - stage.t_start;
  // No honest anchor yet: no time has elapsed, OR the pipeline's clock is AHEAD of ours
  // (server-vs-browser skew on a freshly-started stage with done>0). Returning null lets
  // the panel show nothing rather than a fabricated "≈ 0 s" while real work remains; a
  // later poll, once genuine elapsed accrues, yields the real rate.
  if (elapsedSec <= 0) return null;
  return (elapsedSec * remainingUnits) / stage.done;
}

/** Elapsed seconds of a COMPLETED stage (`t_end - t_start`), else null. */
export function stageDurationSeconds(stage: JobProgressStage): number | null {
  if (stage.t_start === null || stage.t_start === undefined) return null;
  if (stage.t_end === null || stage.t_end === undefined) return null;
  const d = stage.t_end - stage.t_start;
  return d >= 0 ? d : null;
}

/** Units/second learned this run from COMPLETED stages (total / duration), keyed by
 *  unit ("images"/"tiles"). The most-recently-completed stage of a unit wins. Only
 *  stages with a real positive total, both timestamps, and a positive duration
 *  contribute — the raw material for the whole-job estimate (spike §3). */
function completedUnitRates(progress: JobProgress): Map<string, number> {
  const rates = new Map<string, number>();
  for (const s of progress.stages) {
    if (s.state !== "done") continue;
    if (s.unit === null || s.unit === undefined) continue;
    if (s.total === null || s.total === undefined || s.total <= 0) continue;
    const dur = stageDurationSeconds(s);
    if (dur === null || dur <= 0) continue;
    rates.set(s.unit, s.total / dur);
  }
  return rates;
}

/** A whole-job "time remaining" ESTIMATE in seconds, or null when there is no honest
 *  basis (degrade to nothing). It sums:
 *    (a) the running stage's own-rate remaining (`stageEtaSeconds`) — the anchor, and
 *    (b) each PENDING stage whose total is known AND whose unit has a rate from a
 *        completed same-unit stage (`completedUnitRates`).
 *  Returns null when the running stage has no own-rate ETA (no anchor) — we never
 *  fabricate from zero signal, and pending stages with unknown totals (e.g. a QUEUED
 *  layout whose tile count is not yet computed) are simply omitted, so the number
 *  JUMPS UP as later stages start and gain a real total. This is deliberately a rough
 *  estimate the caller labels "≈ … (estimate)"; it NEVER drives a bar or a percentage.
 *  (Cross-stage same-unit rates are approximate — spike §3 measures up to ~5× spread
 *  between same-unit stages — which is precisely why the line is an explicit,
 *  re-derived-at-each-boundary estimate, not a fact.) */
export function wholeJobEtaSeconds(progress: JobProgress, nowMs: number): number | null {
  const running = progress.stages.find((s) => s.state === "running");
  if (running === undefined) return null;
  const anchor = stageEtaSeconds(running, nowMs);
  if (anchor === null) return null;
  let total = anchor;
  const rates = completedUnitRates(progress);
  for (const s of progress.stages) {
    if (s.state !== "queued") continue; // not-yet-started (the pipeline's pre-run state)
    if (s.total === null || s.total === undefined || s.total <= 0) continue;
    if (s.unit === null || s.unit === undefined) continue;
    const rate = rates.get(s.unit);
    if (rate === undefined || rate <= 0) continue;
    total += s.total / rate;
  }
  return total;
}

/** Human-scaled duration for the readouts ("45 s" / "5 min" / "1 h 3 min"). Whole
 *  seconds under a minute, whole minutes under an hour, else hours + minutes. The unit
 *  boundaries are at 60 (not 90) so the readout steps smoothly — "59 s" → "1 min" →
 *  "2 min" — instead of jumping straight from "89 s" to "2 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
