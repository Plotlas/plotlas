// The designer's LAYOUTS view and its REVIEW & COMMIT sheet (seam L5; LAYOUT_DESIGNER
// D-xxi … D-xxix; boards `Layouts`, `LayoutStates`, `RoleConsequences`, `CommitReview`,
// `DeleteConfirm`, `MobileLayouts`). The shell imports exactly two names from here:
//
//   LayoutsView   — a `DesignerView` (./contract.ts), rendered on the Layouts tab;
//   CommitReview  — a `CommitReviewView`: the sheet the bar's *Review & commit* opens.
//
// THE REVIEW IS THE ONLY DOOR TO A BAKE (D-xxi). Nothing on a card, a knob or a pair picker
// sends a job; `Re-bake` queues. The review states the price and starts EXACTLY ONE job —
// how it is composed, refused, predicted and reconciled is `layoutsCommit.ts`. Deleting a
// layout is the other job this view starts, and it is not part of the commit (D-xxii): its
// own one-click confirm, a 202 and a job id, and a card that says *deleting* until it lands.
//
// A job this view starts is REMEMBERED per collection (`layoutsCommit.JobRecord`), so its
// report is read back, its renames' names and defaults are moved, and a failure can put the
// committed changes back — even if the page was closed while it ran.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { JobStatus, LayoutInfo } from "../../api-client/types";
import { collectionName } from "../../api-client/types";
import { errText } from "../../api-client/errText";
import type { ColumnRoles } from "../../generated/column_roles";
import { useActivityActions } from "../activity/activityContext";
import { TERMINAL_JOB_STATES, pollJob } from "../admin/jobPoll";
import { describeBakedOptions } from "../layoutOptions";
import type { CommitReviewView, DesignerViewProps } from "./contract";
import {
  composeCommit,
  isBakeFamily,
  isLive,
  layoutFate,
  loadJobRecord,
  movePatch,
  preQueue,
  reconcile,
  renameMoves,
  saveJobRecord,
} from "./layoutsCommit";
import type { JobRecord, LayoutFate } from "./layoutsCommit";
import { InFlightCard, LiveCard, PickerCard, QueuedCard, UnavailableCard } from "./layoutsCards";
import { isNumericDtype } from "./Overview";
import { addBake, bakedFor, bakeKey, canonicalJson, derivePending, discardPending, hasEdits, outcomeFor, removeBake, restorePending, serializePending } from "./pending";
import type { BakeEntry, BakeFamily, PendingState } from "./pending";
import { producibleLayouts, rolesDraftFromColumnRoles } from "../admin/roles";

function errStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// The collection's job — OWNED by the shell's follower, read by every other surface
// ---------------------------------------------------------------------------

/** How long after a failed job read to read again — `pollJob`'s own ceiling (10 s), so a
 *  retry never polls faster than a healthy poll does. A UI timing, not a limit. */
const JOB_RETRY_MS = 10_000;

/** A finished record with nothing left to say or do is not kept. A done record with NO
 *  outcome is one whose report the user dismissed while a rename still waited (`dismiss`):
 *  once that rename has moved it has nothing left either, and would otherwise sit in memory
 *  and storage, rendering nothing, until the next job overwrote it. */
function settle(record: JobRecord | null): JobRecord | null {
  if (record === null) return null;
  const quiet =
    record.phase === "done" &&
    record.outcome !== "failed" &&
    (record.findings?.length ?? 0) === 0 &&
    record.moves.length === 0 &&
    (record.kind === "delete" || record.outcome === "finished" || record.outcome === undefined);
  return quiet ? null : record;
}

/** What the follower knows about the collection's job. */
interface JobState {
  record: JobRecord | null;
  /** The job being polled — ours while it runs, else the collection's active one. Kept
   *  after it lands, so a surface can still say how it ended. */
  status: JobStatus | null;
  pollError: string | null;
  moveError: string | null;
}

const NO_JOB: JobState = { record: null, status: null, pollError: null, moveError: null };

// THE CHANNEL. The follower (in the shell) and the surfaces that start or show a job (the
// review sheet, the Layouts view) are SIBLINGS: the shell renders them side by side, and a
// provider above them would be the shell's, which this seam does not own. So they talk
// through three DOM events on `window`, every one scoped by dataset id:
//   start — a surface started a job: here is its record. The follower adopts it.
//   state — the follower's record and status, sent on every change.
//   ask   — a surface just mounted: the follower answers with `state`.
// Nothing is stored in the channel. The record lives in the follower's component state —
// the AUTHORITY — and storage is its mirror, read once at mount. Before this, the record
// lived in storage alone: with none, or a full quota, a commit's record reached no other
// surface, the sheet said "It has landed." at once, and the report was never read; and a
// refused write handed the stale `running` copy back on every reload, landing the job again
// and again — 145 reloads in 3 s (review of #385, rounds 2 and 3).
const JOB_START = "plotlas:designer-job-start";
const JOB_STATE = "plotlas:designer-job-state";
const JOB_ASK = "plotlas:designer-job-ask";

function send(type: string, detail: unknown): void {
  if (typeof window === "undefined") return;
  // `window.CustomEvent`, not the global: under a DOM shim the global can be the runtime's
  // own class, which the shim's `dispatchEvent` refuses.
  window.dispatchEvent(new window.CustomEvent(type, { detail }));
}

function listen<T extends { datasetId: string }>(type: string, datasetId: string, on: (detail: T) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event): void => {
    const detail = (e as CustomEvent<T>).detail;
    if (detail !== null && typeof detail === "object" && detail.datasetId === datasetId) on(detail);
  };
  window.addEventListener(type, handler);
  return () => window.removeEventListener(type, handler);
}

interface OwnedJob extends JobState {
  /** Findings and outcome go; a rename still waiting for its new id stays (user review #4). */
  dismiss: () => void;
  /** Give up a rename that is still waiting: its label and default stay where they are. */
  dropMoves: () => void;
  /** Drop the record entirely — its commit has been put back into the model. */
  forget: () => void;
}

/** The ONE owner of the collection's job — `JobFollower`, rendered by the shell on every
 *  tab. It polls the job to a terminal state; when it lands, it reads the worker's report
 *  against the prediction (the report wins), keeps what disagrees, moves an adopted rename's
 *  name and default once its new id is live, and reloads. It has to be the shell's: a
 *  roles-only commit bumps no `dataset_version`, so the shell's own poll never re-reads the
 *  manifest after one (review of #385, R1). A job is landed ONCE and a landed job is never
 *  polled again, whatever any summary still says. */
function useJobOwner(view: DesignerViewProps): OwnedJob {
  const dsId = view.dataset.dataset_id;
  // Storage is read ONCE, here: the mirror of a job started on an earlier visit.
  const [record, setRecordState] = useState<JobRecord | null>(() => loadJobRecord(dsId));
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Bumped to re-poll after a transient read error: a follower that stopped at the first
  // network blip would never see its job land.
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(view);
  latest.current = view;
  const recordRef = useRef(record);
  const landedIds = useRef(new Set<string>());

  /** Every change to the record is mirrored to storage; a refused write changes nothing. */
  const setRecord = useCallback(
    (next: JobRecord | null): void => {
      recordRef.current = next;
      setRecordState(next);
      saveJobRecord(dsId, next);
    },
    [dsId],
  );

  // A surface started a job: adopt its record.
  useEffect(
    () =>
      listen<{ datasetId: string; record: JobRecord }>(JOB_START, dsId, ({ record: started }) => {
        setRecord(started);
        setStatus(null);
        setPollError(null);
      }),
    [dsId, setRecord],
  );

  // Tell every surface; answer one that has just mounted.
  const state: JobState = { record, status, pollError, moveError };
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    send(JOB_STATE, { datasetId: dsId, ...state });
  }, [dsId, record, status, pollError, moveError]);
  useEffect(() => listen(JOB_ASK, dsId, () => send(JOB_STATE, { datasetId: dsId, ...stateRef.current })), [dsId]);

  const jobId = record?.phase === "running" ? record.jobId : (view.dataset.active_job_id ?? null);
  // Never a job this owner has landed. DEFENSIVE, and pinned by nothing: it matters only if
  // the poll key goes id → null → the same id, and no path does today. The shell reads the
  // summary only while a job is in flight, a finished job never reads active again, and the
  // lingering summary of user review #6 keeps the key's VALUE, so this effect never re-runs
  // for it (verification of #385, round 3, N7a: with this guard and `landed()`'s both
  // removed, every pin stays green).
  const pollId = jobId !== null && !landedIds.current.has(jobId) ? jobId : null;
  useEffect(() => {
    if (pollId === null) return; // the last status stays: how the job ended
    setPollError(null);
    setStatus((s) => (s?.job_id === pollId ? s : null));
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      });
    const landed = (final: JobStatus | null): void => {
      if (landedIds.current.has(pollId)) return; // once
      landedIds.current.add(pollId);
      const mine = recordRef.current;
      if (mine !== null && mine.phase === "running" && mine.jobId === pollId) {
        const r = reconcile(mine, final, latest.current.layouts);
        setRecord(settle({ ...mine, phase: "done", outcome: r.outcome, findings: r.findings, error: r.error }));
      }
      latest.current.reload();
    };
    pollJob(
      latest.current.client,
      pollId,
      (s) => {
        if (cancelled) return;
        setStatus(s);
        setPollError(null);
      },
      { sleep, isCancelled: () => cancelled },
    ).then(
      (final) => {
        if (!cancelled && TERMINAL_JOB_STATES.has(final.state)) landed(final);
      },
      (err: unknown) => {
        if (cancelled) return;
        const code = errStatus(err);
        if (code === 401) latest.current.onAuthExpired();
        // Gone: RQ drops a finished job after 500 s, so a page reopened later finds none.
        else if (code === 404) landed(null);
        else {
          // Anything else may pass: say so, and poll again at the backoff's ceiling.
          setPollError(errText(err));
          timer = setTimeout(() => setAttempt((n) => n + 1), JOB_RETRY_MS);
        }
      },
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dsId, pollId, attempt, setRecord]);

  // The SHELL can see a job end first. It reads the summary every 5 s while the poll above
  // backs off to 10, and a summary that no longer names the job takes `pollId` to null,
  // which cancels that poll before it reads the end. A job this owner holds a running
  // record for keeps its `pollId` whatever the summary says; one it follows from the
  // summary alone — started in another tab, by the CLI, or on a visit whose storage is gone
  // — does not, and nothing then re-read the designer: a roles-only job bumps no
  // `dataset_version`, so the shell's own poll never does (verification of #385, round 3,
  // N2). Its end is the summary's: land it, once, which reloads. There is no record to
  // reconcile, since a running record would have kept `pollId`.
  const followed = useRef<string | null>(null);
  useEffect(() => {
    const was = followed.current;
    followed.current = pollId;
    if (pollId !== null || was === null || landedIds.current.has(was)) return;
    landedIds.current.add(was);
    latest.current.reload();
  }, [pollId]);

  // A renamed layout keeps its name and its default — moved the moment its new id is LIVE.
  // The move leaves the record (in memory, the authority) before the PATCH is sent, so a
  // re-render cannot send it twice.
  useEffect(() => {
    const mine = recordRef.current;
    if (mine === null || mine.moves.length === 0) return;
    const live = new Set(view.layouts.filter(isLive).map((l) => l.layout_id));
    const moved = movePatch(mine.moves, view.presentation, live);
    if (moved === null) return;
    setRecord(settle({ ...mine, moves: mine.moves.filter((m) => !moved.applied.includes(m)) }));
    if (moved.patch.layouts === undefined && moved.patch.default_layout === undefined) return;
    view.client.setDatasetPresentation(dsId, moved.patch).then(
      () => {
        const now = latest.current;
        const again = movePatch(moved.applied, now.presentation, live);
        now.onPresentationChange(again?.next ?? moved.next);
        setMoveError(null);
      },
      (err: unknown) => {
        if (errStatus(err) === 401) latest.current.onAuthExpired();
        else setMoveError(`Couldn't move a renamed layout's name and default — ${errText(err)}`);
      },
    );
  }, [dsId, view.layouts, view.presentation, view.client, record, setRecord]);

  return {
    ...state,
    dismiss: () => {
      const mine = recordRef.current;
      setRecord(mine !== null && mine.moves.length > 0 ? { ...mine, phase: "done", outcome: undefined, findings: [], error: null } : null);
    },
    dropMoves: () => {
      const mine = recordRef.current;
      setRecord(mine === null ? null : settle({ ...mine, moves: [] }));
    },
    forget: () => setRecord(null),
  };
}

/** Every other surface's view of the collection's job: the follower's state, sent to it,
 *  and a way to hand the follower a job it has just started. */
function useJobState(view: DesignerViewProps): JobState & { start: (record: JobRecord) => void } {
  const dsId = view.dataset.dataset_id;
  const [state, setState] = useState<JobState>(NO_JOB);
  useEffect(() => {
    const stop = listen<JobState & { datasetId: string }>(JOB_STATE, dsId, (d) =>
      setState({ record: d.record, status: d.status, pollError: d.pollError, moveError: d.moveError }),
    );
    send(JOB_ASK, { datasetId: dsId });
    return stop;
  }, [dsId]);
  return {
    ...state,
    // Mirrored to storage HERE, before the hand-over, and not only by the follower that
    // hears it: a commit whose answer arrives after the designer has gone (browser Back
    // while the POST was on the wire) has no follower to hear it, and its model has already
    // left the pending store — without this copy the next visit could neither report the
    // job nor put the changes back (verification of #385, round 3, N1). The follower's own
    // write of the same record follows and changes nothing.
    start: (record) => {
      saveJobRecord(dsId, record);
      send(JOB_START, { datasetId: dsId, record });
    },
  };
}

/** Why no job can start on this collection now, or null. The API runs one job per
 *  collection and answers 409 to a second; this says so before anything is sent. */
function busyReason(view: DesignerViewProps, record: JobRecord | null): string | null {
  const inFlight =
    record?.phase === "running" ||
    view.dataset.active_job_id != null ||
    view.layouts.some((l) => !isLive(l) || l.rebake != null);
  return inFlight
    ? "A job is already running on this collection, and it takes one at a time — nothing has been sent. Commit once it lands; the cards show it landing."
    : null;
}

/** The default layout: the presentation's, when it names a live layout — else the
 *  manifest's first (D-xvi). */
function defaultLayoutId(view: DesignerViewProps): string | null {
  const live = view.layouts.filter(isLive);
  const configured = view.presentation.dataset?.default_layout;
  if (configured !== undefined && live.some((l) => l.layout_id === configured)) return configured;
  return live[0]?.layout_id ?? null;
}

// ---------------------------------------------------------------------------
// What can be added (D-xxiii: a family is offered whenever the data can support it)
// ---------------------------------------------------------------------------

interface Offer {
  family: BakeFamily;
  /** Datetime / categorical: one entry per column that can bake now. Pair families: null
   *  (the card collects the pair). */
  entries: { entry: BakeEntry; label: string }[] | null;
  unavailable: string | null;
}

function numericColumns(view: DesignerViewProps): string[] {
  return (view.columns?.columns ?? []).filter((c) => isNumericDtype(c.dtype)).map((c) => c.name);
}

function offers(view: DesignerViewProps): Offer[] {
  const { pending, layouts } = view;
  const draft = pending.draft;
  const queued = new Set(pending.bakes.map(bakeKey));
  const noMetadata = "No metadata — a layout arranges images by a column, and this collection has none.";
  const single = (family: "datetime" | "categorical", need: string): Offer => {
    if (draft === null) return { family, entries: null, unavailable: noMetadata };
    const columns = draft.columns.filter((c) => draft.choice[c] === family);
    if (columns.length === 0) return { family, entries: null, unavailable: need };
    const entries: { entry: BakeEntry; label: string }[] = [];
    for (const column of columns) {
      const entry: BakeEntry = { kind: "new", type: family, source_columns: [column] };
      if (queued.has(bakeKey(entry))) continue;
      const resolved = derivePending({ ...pending, bakes: [entry] }, layouts).bakes[0];
      if (resolved.problem === null) entries.push({ entry, label: column });
    }
    return {
      family,
      entries,
      unavailable: entries.length > 0 ? null : `Every ${family} column already has a layout — re-bake one from its card.`,
    };
  };
  const numeric = numericColumns(view);
  const pair = (family: "scatter" | "geographic"): Offer => {
    if (draft === null) return { family, entries: null, unavailable: noMetadata };
    if (view.columns === null) {
      return { family, entries: null, unavailable: `The column list couldn't be read${view.columnsError !== null ? ` — ${view.columnsError}` : ""}.` };
    }
    if (numeric.length < 2) {
      return { family, entries: null, unavailable: `Needs two numeric columns — this collection has ${numeric.length}.` };
    }
    return { family, entries: null, unavailable: null };
  };
  return [
    single("datetime", "Needs a datetime column — map one in Data."),
    single("categorical", "Needs a categorical column — map one in Data."),
    pair("scatter"),
    pair("geographic"),
  ];
}

const FAMILY_TITLE: Record<BakeFamily, string> = {
  datetime: "Datetime",
  categorical: "Categorical",
  scatter: "Scatter",
  geographic: "Geographic",
};

const FAMILY_ACTION: Record<BakeFamily, string> = {
  datetime: "Add a timeline",
  categorical: "Add a grouping",
  scatter: "Add a scatter layout",
  geographic: "Add a map layout",
};

/** The committed layouts' fates under the working roles — one probe per layout, memoized
 *  on the model and the list. */
function useFates(view: DesignerViewProps): Map<string, LayoutFate> {
  return useMemo(() => {
    const out = new Map<string, LayoutFate>();
    for (const l of view.layouts) if (isLive(l)) out.set(l.layout_id, layoutFate(view.pending, view.layouts, l));
    return out;
  }, [view.pending, view.layouts]);
}

// ---------------------------------------------------------------------------
// The job banner — what our job is doing, and what its report said
// ---------------------------------------------------------------------------

/** Put a failed commit's changes back WITHOUT silently overwriting what was done since
 *  (review of #385, R2): nothing since → the committed model; only bakes queued since (the
 *  draft untouched) → the committed model with those bakes added after its own; the draft
 *  edited since → null, and the caller asks first, naming what would be replaced. */
export function restoreOnto(restored: PendingState, current: PendingState): PendingState | null {
  if (!hasEdits(current)) return restored;
  if (canonicalJson(current.draft) !== canonicalJson(current.seed)) return null;
  return current.bakes.reduce((model, entry) => addBake(model, entry), restored);
}

function JobBanner(props: { view: DesignerViewProps; job: OwnedJob }): ReactElement | null {
  const { view, job } = props;
  const { record, status } = job;
  const [confirming, setConfirming] = useState(false);
  const label = (id: string): string => view.layouts.find((l) => l.layout_id === id)?.label ?? id;
  const parts: ReactElement[] = [];
  if (job.pollError !== null) parts.push(h("p", { key: "pe", className: "error-text" }, `Couldn't read the job — ${job.pollError}`));
  if (job.moveError !== null) parts.push(h("p", { key: "me", className: "error-text" }, job.moveError));
  if (record === null) return parts.length > 0 ? h("div", { className: "layouts-banner layouts-banner-err", role: "alert" }, ...parts) : null;
  if (record.phase === "running") {
    if (record.kind === "delete") return parts.length > 0 ? h("div", { className: "layouts-banner", role: "status" }, ...parts) : null;
    const what = record.kind === "roles" ? "The role change is committed" : `The bake is committed — ${plural(record.prediction?.bakes.length ?? 0, "layout")}, one run`;
    const state =
      status === null
        ? "reading the job…"
        : status.state === "queued"
          ? "waiting for the worker, which runs one job at a time"
          : status.state === "started"
            ? "running"
            : status.state;
    return h("div", { className: "layouts-banner", role: "status" }, h("p", null, h("strong", null, what), ` · ${state}. Everything live keeps serving until it lands.`), ...parts);
  }
  const lines: ReactElement[] = [];
  if (record.outcome === "failed") {
    const restorable = record.restore !== null && restorePending(record.restore, view.pending, view.manifest.dataset_version) !== null;
    lines.push(h("p", { key: "f" }, h("strong", null, record.kind === "delete" ? `Deleting “${label(record.deleting ?? "")}” failed` : "The job failed"), ` — ${record.error ?? "no reason was given"}.`));
    if (restorable) {
      const restored = (): PendingState | null =>
        record.restore !== null ? restorePending(record.restore, view.pending, view.manifest.dataset_version) : null;
      const put = (model: PendingState): void => {
        view.onPendingChange(model);
        setConfirming(false);
        job.forget(); // the commit is back in the model; so are any renames it would adopt
      };
      if (!confirming) {
        lines.push(
          h(
            "p",
            { key: "r" },
            "Nothing landed, so the changes you committed can be put back.",
            " ",
            h(
              "button",
              {
                type: "button",
                className: "btn",
                onClick: () => {
                  const back = restored();
                  if (back === null) return;
                  const merged = restoreOnto(back, view.pending);
                  if (merged !== null) put(merged);
                  else setConfirming(true);
                },
              },
              "Put the changes back",
            ),
          ),
        );
      } else {
        const d = view.derived;
        const since = [
          ...(d.invalidating > 0 ? [plural(d.invalidating, "role change")] : []),
          ...(d.bakeCount > 0 ? [`${plural(d.bakeCount, "bake")} queued`] : []),
        ];
        lines.push(
          h(
            "p",
            { key: "rc" },
            h("strong", null, "You have changed things since that commit"),
            ` (${since.length > 0 ? since.join(", ") : "an edit to the roles"}). Putting the committed changes back replaces them — both can't be kept, because both edit the roles.`,
            " ",
            h("button", { type: "button", className: "btn", onClick: () => { const back = restored(); if (back !== null) put(back); } }, "Replace my changes"),
            " ",
            h("button", { type: "button", className: "btn ghost", onClick: () => setConfirming(false) }, "Keep mine"),
          ),
        );
      }
    } else if (record.kind !== "delete") {
      lines.push(h("p", { key: "nr" }, "Part of it may have landed — the cards show the collection as it now stands. Queue what is missing again."));
    }
  } else if (record.outcome === "expired") {
    lines.push(h("p", { key: "x" }, "The job's report was gone before this screen could read it — the worker keeps one for about eight minutes. The cards show the collection as it now stands."));
  } else if ((record.findings?.length ?? 0) > 0) {
    lines.push(
      h("p", { key: "h" }, h("strong", null, "The worker's report disagrees with the prediction."), " The report wins — the cards follow it. The difference is a finding about the prediction:"),
      h("ul", { key: "l", className: "layouts-findings" }, (record.findings ?? []).map((f, i) => h("li", { key: i }, f))),
    );
  }
  // A report (a failure, an expiry, findings) is dismissed on its own; a rename still
  // waiting for its new id outlives that, and giving it up is its own, named action — a
  // Dismiss that silently took the move with it left the owner's label and default on the
  // superseded layout (user review #4).
  const hasReport = lines.length > 0;
  if (record.moves.length > 0) {
    lines.push(h("p", { key: "mv" }, `Waiting for ${record.moves.map((m) => m.to).join(", ")} to land, to move ${record.moves.length === 1 ? "its" : "their"} name and default across.`));
  }
  if (lines.length === 0 && parts.length === 0) return null;
  return h(
    "div",
    { className: record.outcome === "failed" ? "layouts-banner layouts-banner-err" : "layouts-banner layouts-banner-warn", role: "alert" },
    ...parts,
    ...lines,
    hasReport || record.moves.length === 0
      ? h("button", { type: "button", className: "btn ghost layouts-banner-dismiss", onClick: job.dismiss }, record.moves.length > 0 ? "Dismiss the report" : "Dismiss")
      : h(
          "button",
          { type: "button", className: "btn ghost layouts-banner-dismiss", onClick: job.dropMoves },
          "Don't move them — leave the name and default where they are",
        ),
  );
}

/** The collection's job, followed from the SHELL, on whichever tab is open: the one place a
 *  landed job is reconciled, its renames moved, and the designer reloaded (see
 *  `useJobOwner`). Renders the job banner — what the job is doing, and what its report
 *  said — above every view, so a finding is not lost because the Layouts tab was closed. */
export function JobFollower(view: DesignerViewProps): ReactElement {
  const job = useJobOwner(view);
  return h("div", { className: "layouts-follow" }, h(JobBanner, { view, job }));
}

// ---------------------------------------------------------------------------
// The layout delete dialog (D-xxii) — a click, not a typed name
// ---------------------------------------------------------------------------

function LayoutDeleteDialog(props: {
  layout: LayoutInfo;
  isDefault: boolean;
  defaultLabel: string | null;
  fallbackLabel: string | null;
  otherLive: number;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { layout } = props;
  const baked = layout.committed_at != null ? `Baked ${layout.committed_at.slice(0, 10)}. ` : "";
  return h(
    "div",
    {
      className: "designer-modal-scrim",
      onKeyDown: (e: { key: string }) => {
        if (e.key === "Escape" && !props.busy) props.onCancel();
      },
    },
    h(
      "div",
      { className: "designer-modal panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "delete-layout-title" },
      h(
        "div",
        { className: "designer-modal-head" },
        h("span", { className: "designer-danger-badge" }, "Delete layout"),
        h("h2", { id: "delete-layout-title", className: "designer-modal-title" }, `Delete “${layout.label}”?`),
      ),
      h(
        "p",
        { className: "designer-modal-body" },
        `${baked}This removes its tile pyramid and position table. Rebuilding it later costs a bake on this collection.`,
      ),
      h(
        "p",
        { className: "designer-modal-body layouts-delete-facts" },
        props.isDefault
          ? h("span", null, h("strong", null, "It is the default layout:"), ` visitors will open on “${props.fallbackLabel ?? "the first layout"}” instead.`)
          : props.defaultLabel !== null
            ? h("span", null, h("strong", null, props.defaultLabel), " is the default and is unaffected.")
            : null,
        ` Your other ${plural(props.otherLive, "live layout")} keep serving.`,
      ),
      h(
        "p",
        { className: "muted designer-hint" },
        "Starts the moment you confirm. It takes seconds of work, but it runs as a job, so the card reads Deleting until it lands — longer if another job has the worker. It does not join the pending changes, and there is no undo.",
      ),
      props.error !== null ? h("p", { className: "error-text", role: "alert" }, props.error) : null,
      h(
        "div",
        { className: "designer-modal-actions" },
        h("button", { type: "button", className: "btn ghost", disabled: props.busy, onClick: props.onCancel }, "Cancel"),
        h("button", { type: "button", className: "btn danger", disabled: props.busy, onClick: props.onConfirm }, props.busy ? "Deleting…" : "Delete layout"),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface Picker {
  key: number;
  family: "scatter" | "geographic";
}

export function LayoutsView(view: DesignerViewProps): ReactElement {
  const job = useJobState(view);
  const { register } = useActivityActions();
  const fates = useFates(view);
  const [pickers, setPickers] = useState<Picker[]>([]);
  const nextPicker = useRef(1);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { layouts, derived, pending } = view;
  const live = layouts.filter(isLive);
  const inFlight = layouts.filter((l) => !isLive(l));
  const defaultId = defaultLayoutId(view);
  const defaultLabel = live.find((l) => l.layout_id === defaultId)?.label ?? null;
  const busy = busyReason(view, job.record);
  const record = job.record;
  const deletingId = record?.phase === "running" && record.kind === "delete" ? record.deleting : null;
  const numeric = numericColumns(view);
  const bakeLabel = (id: string): string => view.manifest.layouts.find((l) => l.layout_id === id)?.label ?? id;
  const queuedRebakes = new Set(pending.bakes.filter((b) => b.kind === "rebake").map((b) => (b.kind === "rebake" ? b.layout_id : "")));

  // Which committed layout, if any, a queued `new` entry adopts the new id of.
  const adopting = new Map<string, string>();
  for (const l of live) {
    const fate = fates.get(l.layout_id);
    if (fate?.kind === "renamed") adopting.set(fate.to, l.label);
  }

  async function confirmDelete(): Promise<void> {
    const layout = live.find((l) => l.layout_id === deleteTarget);
    if (layout === undefined) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await view.client.deleteLayout(view.dataset.dataset_id, layout.layout_id);
      register(view.dataset.dataset_id, res.job_id);
      job.start({ v: 1, jobId: res.job_id, kind: "delete", phase: "running", prediction: null, moves: [], restore: null, deleting: layout.layout_id });
      // A re-bake queued for a layout that is going away could never run.
      if (queuedRebakes.has(layout.layout_id)) view.onPendingChange(removeBake(view.pending, { kind: "rebake", layout_id: layout.layout_id }));
      setDeleteTarget(null);
      view.reload();
    } catch (err) {
      if (errStatus(err) === 401) {
        view.onAuthExpired();
        return;
      }
      // The 409s (a job in flight, the last layout) carry their reason in the detail.
      setDeleteError(errText(err));
    } finally {
      setDeleteBusy(false);
    }
  }

  const deleteBlocked = (id: string): string | null => {
    if (live.length <= 1) return "The only layout — a collection keeps at least one. Delete the collection instead (Overview).";
    if (busy !== null && deletingId !== id) return "Refused while a job is running on this collection — it takes one at a time. Delete once it lands.";
    return null;
  };

  // ---- the head: intro and the Add row ----
  // `offers` probes the model once per candidate column — memoized on what it reads, so a
  // re-render that changes neither (a dialog opening, a picker) does not redo it (user #8).
  const addRow = useMemo(() => offers(view), [view.pending, view.layouts, view.columns, view.columnsError]);
  const head = h(
    "header",
    { className: "layouts-head" },
    h(
      "div",
      { className: "layouts-head-main" },
      h("h2", { className: "designer-section-title" }, "Layouts"),
      h(
        "p",
        { className: "muted layouts-intro" },
        "Every arrangement a visitor can switch between. One is the default",
        defaultLabel !== null ? ["; ", h("strong", { key: "d" }, defaultLabel), " is."] : ".",
      ),
    ),
    h(
      "div",
      { className: "layouts-add", role: "group", "aria-label": "Add a layout" },
      h("span", { className: "designer-kicker" }, "Add"),
      ...addRow.flatMap((o) => {
        if (o.unavailable !== null) return [];
        if (o.entries === null) {
          const family = o.family as "scatter" | "geographic";
          return [
            h(
              "button",
              {
                key: o.family,
                type: "button",
                className: "btn layouts-add-btn",
                onClick: () => setPickers((prev) => [...prev, { key: nextPicker.current++, family }]),
              },
              FAMILY_TITLE[o.family],
            ),
          ];
        }
        return o.entries.map(({ entry, label }) =>
          h(
            "button",
            {
              key: bakeKey(entry),
              type: "button",
              className: "btn layouts-add-btn",
              onClick: () => view.onPendingChange(addBake(view.pending, entry)),
            },
            `${FAMILY_TITLE[o.family]} · ${label}`,
          ),
        );
      }),
    ),
  );
  const unavailable = addRow.filter((o) => o.unavailable !== null);
  const note = h(
    "p",
    { className: "muted layouts-intro" },
    "A family is offered whenever the data can support it — Scatter and Geographic ask for their two columns inside the card, so you never have to go and prepare a pair first.",
  );

  // ---- live ----
  const liveIds = new Set(live.map((l) => l.layout_id));
  const liveCards = live.map((layout) => {
    const fate = fates.get(layout.layout_id) ?? { kind: "produced" as const };
    return h(LiveCard, {
      key: layout.layout_id,
      view,
      layout,
      bakeLabel: bakeLabel(layout.layout_id),
      outcome: outcomeFor(derived, layout.layout_id),
      baked: bakedFor(derived, layout.layout_id),
      fate,
      supersededBy: fate.kind === "renamed" && liveIds.has(fate.to) ? fate.to : null,
      isDefault: layout.layout_id === defaultId,
      rebakeQueued: queuedRebakes.has(layout.layout_id),
      deleting: deletingId === layout.layout_id ? (job.status?.state === "queued" ? "waiting" : "deleting") : null,
      deleteBlocked: deleteBlocked(layout.layout_id),
      status: job.status,
      onDelete: () => {
        setDeleteError(null);
        setDeleteTarget(layout.layout_id);
      },
    });
  });

  // ---- in flight ----
  const committedRoles: ColumnRoles | null = pending.committed;
  const familyIds = committedRoles !== null ? producibleLayouts(rolesDraftFromColumnRoles(committedRoles)).map((p) => p.layout_id) : [];
  const predicted = record?.prediction?.bakes ?? [];
  const flightCards = inFlight.map((layout) =>
    h(InFlightCard, {
      key: layout.layout_id,
      layout,
      predicted: predicted.find((b) => b.layout_id === layout.layout_id) ?? null,
      // A row named like a family is a FAMILY request only when nothing says otherwise:
      // this designer's own commit predicted what it bakes, and a lone categorical's id is
      // `categorical` — which the committed roles, pre-commit, need not produce (review of
      // #385, R5).
      familySpec:
        !predicted.some((b) => b.layout_id === layout.layout_id) &&
        isBakeFamily(layout.layout_id) &&
        layout.layout_id !== "datetime" &&
        !familyIds.includes(layout.layout_id),
      status: job.status,
    }),
  );
  const rebaking = live.filter((l) => l.rebake != null).length;

  // ---- queued (the model's new entries, then the pickers) ----
  const newBakes = derived.bakes.filter((b) => b.entry.kind === "new");
  const blockedRebakes = derived.bakes.filter((b) => b.entry.kind === "rebake" && b.problem !== null);
  const queuedCards = [
    ...newBakes.map((bake) =>
      h(QueuedCard, {
        key: bake.key,
        bake,
        pending,
        numericColumns: numeric,
        onPendingChange: view.onPendingChange,
        adopts: bake.layout_id !== null ? (adopting.get(bake.layout_id) ?? null) : null,
      }),
    ),
    ...pickers.map((p) =>
      h(PickerCard, {
        key: `picker-${p.key}`,
        family: p.family,
        numericColumns: numeric,
        pending,
        onPendingChange: view.onPendingChange,
        onCancel: () => setPickers((prev) => prev.filter((q) => q.key !== p.key)),
      }),
    ),
  ];

  const target = deleteTarget !== null ? live.find((l) => l.layout_id === deleteTarget) : undefined;
  const fallback = live.find((l) => l.layout_id !== deleteTarget)?.label ?? null;

  return h(
    "section",
    { className: "layouts", "aria-label": "Layouts" },
    head,
    note,
    unavailable.length > 0
      ? h(
          "div",
          { className: "layouts-unavailable-row" },
          unavailable.map((o) => h(UnavailableCard, { key: o.family, family: o.family, action: FAMILY_ACTION[o.family], reason: o.unavailable ?? "" })),
        )
      : null,
    // The job banner is the shell's (`JobFollower`), above every tab.
    derived.problem !== null ? h("p", { className: "layouts-banner layouts-banner-err", role: "alert" }, `A role change is incomplete — ${derived.problem}`) : null,
    h(
      "section",
      { className: "layouts-section", "aria-label": "Live layouts" },
      h("h3", { className: "designer-kicker layouts-section-title" }, `Live · ${live.length} — serving visitors now`),
      h("div", { className: "layouts-grid" }, ...liveCards),
      blockedRebakes.length > 0
        ? h(
            "ul",
            { className: "layouts-blocked" },
            blockedRebakes.map((b) => h("li", { key: b.key, className: "error-text" }, `Re-bake of “${b.label}” can't run as queued — ${b.problem}. `, h("button", { type: "button", className: "link-btn", onClick: () => view.onPendingChange(removeBake(view.pending, b.entry)) }, "Remove from queue"))),
          )
        : null,
    ),
    inFlight.length > 0 || rebaking > 0
      ? h(
          "section",
          { className: "layouts-section", "aria-label": "In flight" },
          h("h3", { className: "designer-kicker layouts-section-title" }, `In flight · ${inFlight.length + rebaking}`),
          h(
            "div",
            { className: "layouts-grid" },
            ...flightCards,
            h(
              "div",
              { className: "layouts-card layouts-card-note" },
              h(
                "p",
                null,
                `Your ${plural(live.length, "live layout")} keep serving for the whole run, and each new one appears the moment its own bake commits — not when the run ends. A bake never takes the atlas down.`,
              ),
            ),
          ),
        )
      : null,
    queuedCards.length > 0
      ? h(
          "section",
          { className: "layouts-section", "aria-label": "Queued" },
          h("h3", { className: "designer-kicker layouts-section-title" }, `Queued · ${queuedCards.length} — nothing on disk yet, still removable`),
          h("div", { className: "layouts-grid" }, ...queuedCards),
        )
      : null,
    target !== undefined
      ? h(LayoutDeleteDialog, {
          layout: target,
          isDefault: target.layout_id === defaultId,
          defaultLabel,
          fallbackLabel: fallback,
          otherLive: live.length - 1,
          busy: deleteBusy,
          error: deleteError,
          onCancel: () => setDeleteTarget(null),
          onConfirm: () => void confirmDelete(),
        })
      : null,
  );
}

// ---------------------------------------------------------------------------
// Review & commit (D-xxi, D-xxix)
// ---------------------------------------------------------------------------

/** A column's roles in a map, as the review's before → after line says them. */
function describeColumn(roles: ColumnRoles | null, column: string): string {
  if (roles === null) return "no role";
  const parts: string[] = [];
  if (roles.filename.column === column) parts.push("filename");
  if (roles.datetime?.column === column) parts.push(`datetime · ${roles.datetime.format}`);
  if ((roles.categorical ?? []).some((e) => e.column === column)) parts.push("categorical");
  for (const t of roles.tag ?? []) if (t.column === column) parts.push(`tag · split on “${t.delimiter}”`);
  if ((roles.freeform ?? []).some((e) => e.column === column)) parts.push("display only");
  for (const s of roles.scatter ?? []) {
    const opts = describeBakedOptions("scatter", s);
    if (s.x_column === column) parts.push(`scatter x of ${s.x_column} / ${s.y_column} (${opts})`);
    if (s.y_column === column) parts.push(`scatter y of ${s.x_column} / ${s.y_column} (${opts})`);
  }
  for (const g of roles.geographic ?? []) {
    const opts = describeBakedOptions("geographic", g);
    if (g.lon_column === column) parts.push(`longitude of ${g.lon_column} / ${g.lat_column} (${opts})`);
    if (g.lat_column === column) parts.push(`latitude of ${g.lon_column} / ${g.lat_column} (${opts})`);
  }
  return parts.length > 0 ? parts.join(" + ") : "no role";
}

function CommitReviewSheet(props: DesignerViewProps & { onClose: () => void }): ReactElement {
  const view = props;
  // Once sent, the sheet follows ITS job by id — never by the stored record, which a
  // storage that refuses writes never holds, and which read "It has landed." the moment a
  // queued job's commit was accepted (review of #385, round 2, item 5).
  const [sent, setSent] = useState<{ kind: "roles" | "bake"; labels: string[]; jobId: string } | null>(null);
  const job = useJobState(view);
  const { register } = useActivityActions();
  const { pending, derived, layouts } = view;
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [optedIn, setOptedIn] = useState<Set<string>>(() => new Set());
  const [phase, setPhase] = useState<"review" | "sending" | "sent">("review");
  const [error, setError] = useState<string | null>(null);

  const label = (id: string): string => layouts.find((l) => l.layout_id === id)?.label ?? id;
  const pre = preQueue(pending, derived);
  const ticked = pre.ticked.filter((id) => !unticked.has(id));
  const extraRebakes = [...ticked, ...pre.unchecked.filter((id) => optedIn.has(id))];
  const extraKey = extraRebakes.join("\u0000");
  const busy = busyReason(view, job.record);
  // ONE resolution of the model per change that can move it, and the plan's own bakes
  // listed — not a second `derivePending` for the list (user review #8).
  const plan = useMemo(
    () => composeCommit({ pending, derived, layouts, extraRebakes, busy }),
    // `extraRebakes` is rebuilt every render; its content is `extraKey`.
    [pending, derived, layouts, extraKey, busy],
  );
  const bakes = plan.bakes;
  const defaultId = defaultLayoutId(view);
  const liveLabels = layouts.filter(isLive).map((l) => l.label);

  async function commit(): Promise<void> {
    if (plan.kind !== "roles" && plan.kind !== "bake") return;
    setPhase("sending");
    setError(null);
    const dsId = view.dataset.dataset_id;
    try {
      const res = plan.kind === "roles" ? await view.client.setColumnRoles(dsId, plan.roles) : await view.client.addLayouts(dsId, plan.request);
      register(dsId, res.job_id);
      job.start({
        v: 1,
        jobId: res.job_id,
        kind: plan.kind,
        phase: "running",
        prediction: plan.prediction,
        moves: plan.kind === "bake" ? renameMoves(pending, layouts, plan.request.layout_specs) : [],
        restore: serializePending(pending, view.manifest.dataset_version),
        deleting: null,
      });
      setSent({ kind: plan.kind, labels: plan.prediction.bakes.map((b) => b.label), jobId: res.job_id });
      setPhase("sent");
      // What was committed leaves the model: it is in flight now, not pending. If nothing
      // lands, the record above can put it back.
      view.onPendingChange(discardPending(pending));
      view.reload();
    } catch (err) {
      if (errStatus(err) === 401) {
        view.onAuthExpired();
        return;
      }
      setError(errText(err));
      setPhase("review");
    }
  }

  const head = h(
    "div",
    { className: "layouts-review-head" },
    h(
      "div",
      null,
      h("h2", { id: "layouts-review-title", className: "designer-modal-title" }, phase === "sent" ? "Committed" : "Review & commit"),
      h(
        "p",
        { className: "layouts-review-sub" },
        `${collectionName(view.dataset)} · ${view.dataset.image_count.toLocaleString("en-US")} images · v${view.dataset.dataset_version}`,
      ),
    ),
    // Disabled while the commit is on the wire, like Back: closing then would unmount the
    // one place its answer — a job id, or a 409 — is shown (review of #385, R6).
    h("button", { type: "button", className: "btn ghost", "aria-label": "Close the review", disabled: phase === "sending", onClick: props.onClose }, "×"),
  );

  let body: (ReactElement | null)[];
  let footer: ReactElement;
  if (phase === "sent" && sent !== null) {
    // The state of THIS job, from the job itself.
    const status = job.status?.job_id === sent.jobId ? job.status : null;
    const state =
      status === null
        ? "Reading the job…"
        : status.state === "queued"
          ? "Waiting for the worker, which runs one job at a time."
          : status.state === "started"
            ? "Running."
            : status.state === "finished"
              ? "It has landed."
              : status.state === "failed"
                ? "The job failed — the note under the tab bar says why."
                : `Job ${status.state}.`;
    body = [
      h(
        "p",
        { key: "what" },
        sent.kind === "bake"
          ? `One run is queued: ${sent.labels.map((l) => `“${l}”`).join(", ")}. Each layout appears in the atlas the moment its own bake commits; everything live keeps serving until then.`
          : "The role change is queued. It rewrites the manifest and bakes nothing, so it lands in seconds once the worker reaches it.",
      ),
      h("p", { key: "state", role: "status" }, state),
      // The report and its findings are the shell's (`JobFollower`) to show, ONCE, above
      // every tab: a second banner here kept its own dismissed state (round 2, item 3).
    ];
    footer = h(
      "div",
      { className: "layouts-review-actions" },
      h("p", { className: "muted" }, "You can close this — the designer follows the job on every tab, and reloads when it lands."),
      h("button", { type: "button", className: "btn pri", onClick: props.onClose }, "Close"),
    );
  } else {
    const refused = plan.kind === "refused" ? plan.reasons : [];
    // ---- the role-change tier ----
    // ONE line per layout, from its combination of flags — the flags are not exclusive
    // (CONTRACT §4), and a line per flag printed contradictions: "can't be reproduced" beside
    // "can't be checked", "positions are wrong" beside "can't be known" (review of #385, R3).
    const outcomeLines = derived.outcomes.map((o) => {
      const layout = layouts.find((l) => l.layout_id === o.layout_id);
      const cols = (layout?.source_columns ?? []).join(", ");
      const checkable = bakedFor(derived, o.layout_id)?.checkable !== false;
      let lead: string;
      let rest: string;
      if (o.orphaned && o.unknown) {
        lead = `${o.label} is no longer produced under its id.`;
        rest = " It was baked before layouts recorded their columns, so whether its family was renamed or it lost its role can't be told. It keeps serving; it can't be re-baked in place.";
      } else if (o.orphaned) {
        lead = `${o.label} was built from ${cols !== "" ? cols : "a role"}, and no role produces it any more.`;
        rest = o.stale
          ? " This change also moves what it was baked from. No bake can rebuild it in place; it keeps serving what it has — delete it, or restore the role."
          : " No bake can reproduce it. It keeps serving what it has — delete it, or restore the role.";
      } else if (o.renamedTo !== null) {
        lead = o.stale ? `${o.label} was baked from ${cols}.` : `${o.label} is not affected.`;
        rest = o.stale
          ? ` Under the roles you declared its positions are wrong, and its family's naming changed: its next bake files it as ${o.renamedTo}, and its name and default move with it. It stays as it is until then.`
          : ` Its family's naming changed, so its next bake files it as ${o.renamedTo} instead of ${o.layout_id}. Its name and its default status move with it.`;
      } else if (o.stale && !checkable) {
        lead = `${o.label} was baked from ${cols}.`;
        rest = " Under the roles you declared its positions are wrong — if they matched the roles as committed, which a bake this old does not record, so that can't be confirmed. It stays as it is until re-baked, and re-baking it is your call.";
      } else if (o.stale) {
        lead = `${o.label} was baked from ${cols}.`;
        rest = " Under the roles you declared, its positions are wrong. It stays byte-for-byte as it is, flagged stale, until a re-bake replaces it — keeping its name and its id.";
      } else {
        lead = `${o.label} can't be checked.`;
        rest = " It was baked before layouts recorded their columns, so Plotlas can't tell whether this change affects it. It is not marked stale — that would be a guess.";
      }
      return h("li", { key: o.layout_id, "data-layout": o.layout_id }, h("strong", null, lead), rest);
    });
    // The warning heading only when a layout actually goes wrong (stale or orphaned); a
    // change that only renames, or that nothing was derived from, is not "makes tiles
    // wrong" (review of #385, R4).
    // An orphan that is also UNKNOWN (pre-2.9) is not known to be wrong at all — its line
    // says so — so it does not earn the warning (review of #385, round 2, item 2).
    const tilesWrong = derived.outcomes.some((o) => o.stale || (o.orphaned && !o.unknown));
    const anyUnknown = derived.outcomes.some((o) => o.unknown);
    const tierHeading = tilesWrong
      ? "⚠ Invalidating · makes tiles wrong"
      : anyUnknown
        ? "Role change · can't be checked against every layout"
        : "Role change · no layout goes stale";
    const tags = derived.tags;
    const carried = plan.kind === "bake" && plan.request.column_roles !== undefined;
    const invalidating =
      derived.changedColumns.length > 0
        ? h(
            "section",
            { key: "inv", className: "layouts-tier layouts-tier-invalidating", "aria-label": "Role changes" },
            h(
              "div",
              { className: "layouts-tier-head" },
              h("span", { className: tilesWrong ? "layouts-tier-badge layouts-tier-badge-warn" : "layouts-tier-badge layouts-tier-badge-quiet" }, tierHeading),
              // The bar's count (CONTRACT §4): one pair edit is one change, while the rows
              // below stay one per column (review of #400, finding 2).
              h("span", null, plural(derived.invalidating, "change")),
              h("span", { className: "layouts-tier-side" }, "instant to write · expensive to satisfy"),
            ),
            h(
              "ul",
              { className: "layouts-tier-rows" },
              derived.changedColumns.map((c) =>
                h(
                  "li",
                  { key: c, className: "layouts-tier-row" },
                  h("span", { className: "layouts-mono" }, c),
                  h("span", { className: "layouts-was" }, describeColumn(pending.committed, c)),
                  " → ",
                  h("span", null, describeColumn(derived.roles, c)),
                ),
              ),
            ),
            outcomeLines.length > 0 ? h("ul", { className: "layouts-consequences" }, ...outcomeLines) : h("p", { className: "layouts-consequences" }, "Nothing stale: no baked layout was derived from these columns the way they are now declared."),
            tags.unservedColumns.length > 0
              ? h("p", { className: "layouts-consequences" }, `The tag filter on ${tags.unservedColumns.join(", ")} is declared but not served until a bake re-stages the tag index${carried ? " — this run does, when its first layout lands." : "; this commit bakes nothing."}`)
              : null,
            tags.removesLastTagRole ? h("p", { className: "layouts-consequences" }, "Tag filtering goes away from the atlas when this lands: no tag role is left.") : null,
            h(
              "p",
              { className: "muted layouts-tier-foot" },
              "Writes ",
              h("span", { className: "layouts-mono" }, "layout_manifest.json"),
              " — the reproducible record of what a bake consumed. Roles live there because they decide where cells go. ",
              carried ? "This run writes it when its first layout lands." : plan.kind === "roles" ? "This commit bakes nothing." : "",
            ),
          )
        : null;

    // ---- the bake tier ----
    const rows: ReactElement[] = [];
    for (const b of bakes) {
      if (b.entry.kind === "rebake" && pre.ticked.includes(b.entry.layout_id)) continue;
      if (b.entry.kind === "rebake" && pre.unchecked.includes(b.entry.layout_id) && !pending.bakes.some((q) => bakeKey(q) === b.key)) continue;
      const rebake = b.entry.kind === "rebake";
      const detail = rebake ? "replaces it in place, keeping its name and its id" : `${b.entry.kind === "new" ? b.entry.type : ""} · from ${b.entry.kind === "new" ? b.entry.source_columns.join(" / ") : ""}`;
      rows.push(
        h("li", { key: b.key, className: "layouts-tier-row" }, h("span", { className: "layouts-chip" }, rebake ? "re-bake" : "new"), h("strong", null, b.label), h("span", { className: "muted" }, ` ${detail}`)),
      );
    }
    for (const id of pre.ticked) {
      const on = !unticked.has(id);
      rows.push(
        h(
          "li",
          { key: `pre-${id}`, className: "layouts-tier-row layouts-tier-row-pre" },
          h(
            "label",
            { className: "layouts-tick" },
            h("input", {
              type: "checkbox",
              checked: on,
              "aria-label": `Re-bake ${label(id)}`,
              onChange: () =>
                setUnticked((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                }),
            }),
            h("span", { className: "layouts-chip" }, "re-bake"),
            h("strong", null, label(id)),
            h("span", { className: "muted" }, " pre-queued — this change stales it"),
          ),
          on
            ? null
            : h(
                "p",
                { className: "layouts-untick" },
                `${label(id)} stays stale. It keeps serving the tiles it has — placed by the old reading of ${(layouts.find((l) => l.layout_id === id)?.source_columns ?? []).join(", ")} — and its card says so until you re-bake it.`,
              ),
        ),
      );
    }
    for (const id of pre.unchecked) {
      rows.push(
        h(
          "li",
          { key: `unc-${id}`, className: "layouts-tier-row" },
          h(
            "label",
            { className: "layouts-tick" },
            h("input", {
              type: "checkbox",
              checked: optedIn.has(id),
              "aria-label": `Re-bake ${label(id)} to check it`,
              onChange: () =>
                setOptedIn((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                }),
            }),
            h("span", { className: "layouts-chip" }, "unchecked"),
            h("strong", null, label(id)),
            h(
              "span",
              { className: "muted" },
              outcomeFor(derived, id)?.stale === true
                ? " not pre-queued — this change stales it, but its bake does not record how it read its columns, so that can't be confirmed; re-baking it is your call"
                : " not pre-queued — whether this change affects it can't be known, so re-baking it is your call",
            ),
          ),
        ),
      );
    }
    for (const c of pre.cannot) {
      rows.push(h("li", { key: `no-${c.layout_id}`, className: "layouts-tier-row muted" }, `${label(c.layout_id)} goes stale and can't be re-baked in this run: ${c.reason}.`));
    }
    const count = plan.kind === "bake" ? plan.request.layout_specs.length : bakes.length;
    const bakeTier =
      rows.length > 0
        ? h(
            "section",
            { key: "bake", className: "layouts-tier layouts-tier-bake", "aria-label": "Bakes" },
            h(
              "div",
              { className: "layouts-tier-head" },
              h("span", { className: "layouts-tier-badge" }, "● Bake · hours"),
              h("span", null, count > 0 ? `${plural(count, "layout")}, one run` : "nothing to bake"),
            ),
            h("ul", { className: "layouts-tier-rows" }, ...rows),
            count > 0
              ? h(
                  "ul",
                  { className: "layouts-facts" },
                  h("li", null, `Everything live keeps serving for the whole run: ${liveLabels.join(", ")}. Nothing goes dark.`),
                  h("li", null, "Each layout appears the moment its own bake commits — not all at the end."),
                  // The board's "a queued layout can be removed until its bake starts" is
                  // true of the queue BEFORE this commit, and served by nothing after it:
                  // no route takes a layout out of an enqueued run. Omitted, and filed.
                  h("li", null, "Once it starts, the run is one job: no layout can be taken out of it, and a started bake runs to the end."),
                  defaultId !== null ? h("li", null, `“${label(defaultId)}” stays the opening layout throughout.`) : null,
                )
              : null,
            count > 0 ? h("p", { className: "muted" }, "No time estimate: none is measured for this collection yet, and a guessed one would be worse than none.") : null,
          )
        : null;

    body = [
      h("p", { key: "lead", className: "layouts-review-lead" }, h("strong", null, "This is the only way a bake starts."), " Every route — the queue, a stale layout's Re-bake, a role change — arrives here first, so nothing long-running ever begins from a single click."),
      h("p", { key: "free", className: "layouts-review-free" }, "✓ Your free edits — the collection's name, a layout's name, the default layout — are already saved and are not listed here. If a change costs nothing, it never waits for a commit."),
      refused.length > 0
        ? h(
            "div",
            { key: "refused", className: "layouts-banner layouts-banner-err", role: "alert" },
            h("p", null, h("strong", null, "This can't be committed — nothing will be sent.")),
            h("ul", { className: "layouts-findings" }, refused.map((r, i) => h("li", { key: i }, r))),
          )
        : null,
      error !== null ? h("p", { key: "err", className: "error-text", role: "alert" }, error) : null,
      invalidating,
      bakeTier,
    ];
    const primary =
      plan.kind === "bake"
        ? `Start bake — ${plural(plan.request.layout_specs.length, "layout")}`
        : plan.kind === "roles"
          ? "Commit role change — no bake"
          : plan.kind === "refused"
            ? "Can't commit"
            : "Nothing to commit";
    footer = h(
      "div",
      { className: "layouts-review-actions" },
      h("p", { className: "muted" }, "You can close this and come back. Each layout appears in the atlas the moment it lands."),
      h("button", { type: "button", className: "btn ghost", disabled: phase === "sending", onClick: props.onClose }, "Back"),
      h(
        "button",
        {
          type: "button",
          className: "btn pri layouts-commit",
          disabled: phase === "sending" || (plan.kind !== "bake" && plan.kind !== "roles"),
          onClick: () => void commit(),
        },
        phase === "sending" ? "Starting…" : primary,
      ),
    );
  }

  return h(
    "div",
    {
      className: "designer-modal-scrim layouts-review-scrim",
      onKeyDown: (e: { key: string }) => {
        if (e.key === "Escape" && phase !== "sending") props.onClose();
      },
    },
    h(
      "div",
      { className: "panel layouts-review", role: "dialog", "aria-modal": "true", "aria-labelledby": "layouts-review-title" },
      head,
      h("div", { className: "layouts-review-body" }, ...body),
      footer,
    ),
  );
}

/** The review sheet the bar's *Review & commit* opens — the only door to a bake (D-xxi). */
export const CommitReview: CommitReviewView | null = CommitReviewSheet;
