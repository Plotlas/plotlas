// The activity context + provider (Seam O3): the ONE top-level poller that lives
// ABOVE App.tsx's auth/admin/viewer screen switch, so running ingest/add-layouts jobs
// stay visible and live from EVERY screen (the exact thing missing while the 1M v3
// bake churned invisibly for 24h — spike §5). It wraps the pure activityStore with
// useReducer, persists the tracked set to localStorage (a refresh reattaches), and runs
// one resilient getJob poll loop per active job (reusing jobPoll.pollJob's schedule).
//
// A default INERT context lets the pill/panel/AdminScreen mount WITHOUT a provider
// (the component unit + DOM tests render those in isolation) — they simply show
// nothing rather than crash.
//
// Stateful container — composed into App; its pure store/eta/checklist pieces are the
// unit-tested surface. .ts + createElement, runtime imports bare-only.
import { createElement as h, createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { ApiClient } from "../../api-client/client";
import { isApiError } from "../../api-client/client.ts";
import type { DatasetSummary } from "../../api-client/types";
import { pollJob } from "../admin/jobPoll.ts";
import {
  ACTIVITY_STORAGE_KEY,
  EMPTY_ACTIVITY_STATE,
  activityReducer,
  parseStoredActivity,
  pillSummary,
  runningJobs,
  serializeActivity,
} from "./activityStore.ts";
import type { ActivityAction, ActivityState, PillSummary, TrackedJob } from "./activityStore";

/** Wait after a transport error before restarting a job's poll loop — the always-on
 *  panel must survive a transient network blip (unlike the wizard's one-shot poll,
 *  which surfaces the error and stops). 5s comfortably exceeds a request round-trip. */
export const ACTIVITY_POLL_RETRY_MS = 5000;

/** How many CONSECUTIVE non-404 transport failures (with no successful poll in between)
 *  the resilient loop tolerates before giving up on a job and parking it as
 *  `unreachable`. At the 5s retry cadence that is ~25s of sustained unreachability —
 *  long enough to ride out a real blip, short enough not to spin a phantom "running"
 *  pill forever for a job that is genuinely gone in a way that never 404s. */
export const ACTIVITY_POLL_MAX_RETRIES = 5;

/** The STABLE action surface of the activity context — every method is a provider
 *  useCallback, so this object's identity never changes. Split from the live state
 *  below so that action-only consumers (the wizards' `register`, the Library's
 *  `adopt`/`open`) do NOT re-render on every progress tick. */
export interface ActivityActions {
  open(): void;
  close(): void;
  toggle(): void;
  /** A wizard registers the job it just enqueued (moment of submit). */
  register(dsId: string, jobId: string): void;
  /** Adopt any active_job_id from a listDatasets refresh (Library rediscovery). */
  adopt(datasets: DatasetSummary[]): void;
  /** Drop a job (user dismissed a terminal one). */
  dismiss(jobId: string): void;
}

/** The FREQUENTLY-CHANGING state surface (re-derived on every poll tick). Consumers of
 *  this (the pill + panel) must re-render on a change; action-only consumers read
 *  ActivityActions instead and stay put. */
export interface ActivityStateValue {
  jobs: TrackedJob[];
  /** The pill's label + tone, or null when the pill is hidden (nothing tracked). */
  summary: PillSummary | null;
  panelOpen: boolean;
}

/** The combined view (actions + state) for a consumer that needs both (the pill). */
export interface ActivityContextValue extends ActivityActions, ActivityStateValue {}

const INERT_ACTIONS: ActivityActions = {
  open() {},
  close() {},
  toggle() {},
  register() {},
  adopt() {},
  dismiss() {},
};

const INERT_STATE: ActivityStateValue = { jobs: [], summary: null, panelOpen: false };

// Two contexts so a progress tick (state) does NOT invalidate action-only consumers.
const ActivityActionsContext = createContext<ActivityActions>(INERT_ACTIONS);
const ActivityStateContext = createContext<ActivityStateValue>(INERT_STATE);

/** The STABLE action surface — the no-op INERT set when no provider is above (a
 *  component rendered in isolation stays inert, never crashes). Prefer this over
 *  `useActivity()` in a consumer that only FIRES actions (wizards, Library) so it does
 *  not re-render on every progress tick. */
export function useActivityActions(): ActivityActions {
  return useContext(ActivityActionsContext);
}

/** The live state surface (jobs / summary / panelOpen) — changes on every poll tick. */
export function useActivityState(): ActivityStateValue {
  return useContext(ActivityStateContext);
}

/** The combined context (actions + state), for a consumer that needs both (the pill).
 *  Subscribes to BOTH contexts, so it re-renders on a state tick — which the pill wants.
 *  The individual methods it returns are still stable references (they come from the
 *  action context), so destructuring one for an effect dep is safe. */
export function useActivity(): ActivityContextValue {
  return { ...useActivityActions(), ...useActivityState() };
}

function readStored(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode etc.): the panel still works in-memory.
  }
}

function errText(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { detail?: unknown }).detail === "string") {
    return (err as { detail: string }).detail;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Injectable knobs for `pollOneJob` — the provider uses the defaults; tests inject a
 *  no-op `sleep` (and a small `maxRetries`) so the give-up path runs without real time. */
export interface PollLoopOptions {
  retryMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** One resilient poll loop for a single job. Reuses jobPoll.pollJob (2s→10s backoff,
 *  terminal-stop, StrictMode-safe cancel). On a 404 the RQ record is gone (expired) →
 *  drop the job. On any other transport error, note it and RESTART after a backoff (so
 *  a blip does not silently kill the always-on panel); `isCancelled` breaks the loop.
 *  After `maxRetries` CONSECUTIVE failures — a successful poll in between resets the
 *  streak — the loop GIVES UP and parks the job as `unreachable` rather than retrying
 *  forever behind a phantom "running" pill. Exported (with injectable timing) so the
 *  give-up path is unit-testable without real timers. */
export async function pollOneJob(
  client: ApiClient,
  jobId: string,
  dispatch: (a: ActivityAction) => void,
  isCancelled: () => boolean,
  opts: PollLoopOptions = {},
): Promise<void> {
  const retryMs = opts.retryMs ?? ACTIVITY_POLL_RETRY_MS;
  const maxRetries = opts.maxRetries ?? ACTIVITY_POLL_MAX_RETRIES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let consecutiveFailures = 0;
  while (!isCancelled()) {
    try {
      await pollJob(
        client,
        jobId,
        (status) => {
          consecutiveFailures = 0; // a poll landed — the job is reachable, reset the streak
          dispatch({ type: "update", jobId, status });
        },
        // Forward the (injectable) sleep so a test can drive the whole loop — the retry
        // backoff AND pollJob's inter-poll wait — without real timers. In production
        // `sleep` is the same setTimeout-based default pollJob would use anyway.
        { isCancelled, sleep },
      );
      return; // reached a terminal state (or was cancelled) — stop polling this job
    } catch (err) {
      if (isCancelled()) return;
      if (isApiError(err) && err.status === 404) {
        dispatch({ type: "remove", jobId }); // the job record is gone
        return;
      }
      consecutiveFailures += 1;
      const message = errText(err);
      if (consecutiveFailures >= maxRetries) {
        // Sustained unreachability (never a 404): give up rather than loop forever. The
        // job parks as `unreachable` — dismissable, no longer counted active or polled.
        dispatch({ type: "unreachable", jobId, message });
        return;
      }
      dispatch({ type: "pollError", jobId, message });
      await sleep(retryMs);
    }
  }
}

export interface ActivityProviderProps {
  client: ApiClient;
  // Optional so `h(ActivityProvider, { client }, screen)` type-checks (createElement
  // supplies children via the rest arg, not the props object).
  children?: ReactNode;
}

export function ActivityProvider(props: ActivityProviderProps): ReactElement {
  const { client } = props;

  // Rehydrate the tracked set from localStorage at mount → a refresh reattaches and
  // the poller resumes their live state.
  const [state, dispatch] = useReducer(activityReducer, EMPTY_ACTIVITY_STATE, (init): ActivityState =>
    activityReducer(init, { type: "restore", jobs: parseStoredActivity(readStored(ACTIVITY_STORAGE_KEY)) }),
  );
  const [panelOpen, setPanelOpen] = useState(false);

  // Persist identity (jobId + dsId) whenever the tracked SET changes. Keyed on the
  // serialized identity STRING (not `state`): a status-only poll tick mints a fresh
  // state object every few seconds per job but leaves the persisted id list unchanged,
  // so keying the effect on `state` re-wrote the SAME string to localStorage — a
  // synchronous main-thread write — on every tick (N jobs ⇒ N redundant writes per
  // cycle). Keying on the payload writes only on a real membership change.
  const persisted = serializeActivity(state);
  useEffect(() => {
    writeStored(ACTIVITY_STORAGE_KEY, persisted);
  }, [persisted]);

  // The set of jobs that still need polling (unknown-yet or non-terminal). The KEY is
  // the sorted id list, so the poll effect re-runs only on a membership change (a job
  // added / removed / gone terminal), not on every status tick.
  const pollIds = runningJobs(state).map((j) => j.jobId);
  const pollIdsKey = [...pollIds].sort().join(",");
  const pollIdsRef = useRef<string[]>(pollIds);
  pollIdsRef.current = pollIds;

  useEffect(() => {
    // Full (re)build on any membership change — StrictMode-safe: the dev
    // setup→cleanup→setup double-invoke cancels every loop in cleanup and the re-run
    // restarts exactly the current set, so no loop is ever leaked or doubled.
    const handles = pollIdsRef.current.map((jobId) => {
      const handle = { cancelled: false };
      void pollOneJob(client, jobId, dispatch, () => handle.cancelled);
      return handle;
    });
    return () => {
      for (const handle of handles) handle.cancelled = true;
    };
  }, [pollIdsKey, client]);

  const open = useCallback(() => setPanelOpen(true), []);
  const close = useCallback(() => setPanelOpen(false), []);
  const toggle = useCallback(() => setPanelOpen((o) => !o), []);
  const register = useCallback((dsId: string, jobId: string) => {
    dispatch({ type: "register", dsId, jobId });
  }, []);
  const adopt = useCallback((datasets: DatasetSummary[]) => {
    dispatch({ type: "adopt", datasets });
  }, []);
  const dismiss = useCallback((jobId: string) => {
    dispatch({ type: "remove", jobId });
  }, []);

  const summary = useMemo(() => pillSummary(state), [state]);
  // The action surface is memoized on its (all-stable) callbacks, so its identity holds
  // for the provider's lifetime — action-only consumers never re-render on a poll tick.
  const actions = useMemo<ActivityActions>(
    () => ({ open, close, toggle, register, adopt, dismiss }),
    [open, close, toggle, register, adopt, dismiss],
  );
  // The live state surface changes on every tick; only the pill + panel subscribe to it.
  const stateValue = useMemo<ActivityStateValue>(
    () => ({ jobs: state.jobs, summary, panelOpen }),
    [state.jobs, summary, panelOpen],
  );

  return h(
    ActivityActionsContext.Provider,
    { value: actions },
    h(ActivityStateContext.Provider, { value: stateValue }, props.children),
  );
}
