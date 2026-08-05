// Job-progress polling (brief §2: poll getJob at 2s, backing off to 10s; stop
// on a terminal state; the component shows state + log_tail). Extracted from
// the React effect so the schedule is unit-testable with an injected sleep —
// no timers in tests, no jsdom.
//
// Node-test importable (type-only src imports).
import type { ApiClient } from "../../api-client/client";
import type { JobStatus } from "../../api-client/types";

/** RQ states that end a job (jobs router serves RQ's state string verbatim).
 *  Everything else (queued/started/deferred/scheduled) keeps polling. */
export const TERMINAL_JOB_STATES = new Set(["finished", "failed", "stopped", "canceled"]);

export interface PollJobOptions {
  initialIntervalMs?: number; // default 2000
  maxIntervalMs?: number; // default 10000
  backoffFactor?: number; // default 1.5 (2s, 3s, 4.5s, 6.75s, 10s, 10s, ...)
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Return true to stop polling early (component unmount). */
  isCancelled?: () => boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A React-effect cancellation guard for the wizard's "stop polling once the
 *  wizard unmounts" cleanup, HARDENED against React 18 StrictMode's DEV
 *  mount→cleanup→mount effect double-invoke.
 *
 *  The wizard registers `onMount` as its `useEffect` body: the setup ARMS the guard
 *  (polling honored) and returns the teardown that CANCELS it (polling stops).
 *  StrictMode runs setup→cleanup→setup at mount; a guard that only cancelled on
 *  cleanup would be left stuck cancelled for the whole session — so `pollJob`'s
 *  `isCancelled()` would be true from the very first tick and the poll would give
 *  up after ONE `getJob`, before a just-enqueued job reaches a terminal state. The
 *  progress screen would then freeze on "Processing…" while the job finishes in the
 *  background (the fast-completion freeze a 94-image bake hits: done in seconds, yet
 *  the wizard never transitions to "done"). Re-arming on every setup makes the
 *  resting state after the double-invoke `armed`, not cancelled. */
export interface UnmountGuard {
  /** useEffect body: (re)arm the guard and return the teardown that cancels it. */
  onMount(): () => void;
  isCancelled(): boolean;
}

export function createUnmountGuard(): UnmountGuard {
  let cancelled = false;
  return {
    onMount() {
      cancelled = false; // (re)arm on (re)mount — StrictMode runs cleanup-then-setup
      return () => {
        cancelled = true; // real unmount: stop polling
      };
    },
    isCancelled: () => cancelled,
  };
}

/**
 * Poll getJob until a terminal state (or cancellation), reporting every status
 * through onUpdate. Resolves with the last status seen. Transport errors
 * propagate to the caller (the component surfaces them and stops).
 */
export async function pollJob(
  client: ApiClient,
  jobId: string,
  onUpdate: (status: JobStatus) => void,
  opts: PollJobOptions = {},
): Promise<JobStatus> {
  const initial = opts.initialIntervalMs ?? 2000;
  const max = opts.maxIntervalMs ?? 10000;
  const factor = opts.backoffFactor ?? 1.5;
  const sleep = opts.sleep ?? defaultSleep;
  const isCancelled = opts.isCancelled ?? (() => false);

  let interval = initial;
  for (;;) {
    const status = await client.getJob(jobId);
    onUpdate(status);
    if (TERMINAL_JOB_STATES.has(status.state) || isCancelled()) return status;
    await sleep(interval);
    if (isCancelled()) return status;
    interval = Math.min(max, interval * factor);
  }
}
