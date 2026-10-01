// The renderer's HEALTH observable (Seam R1 — docs/prompts/brief_renderer_recovery_seam.md).
//
// A renderer failure that never fires `webglcontextlost` used to be invisible: a missing
// WebGL 2, a throw inside the render loop and a layout whose tiles cannot be made
// renderable all left the user on a frozen or blank canvas, and the ONE error string the
// shell had ("Rendering was interrupted and could not recover. Reload the page to
// continue.") said the same thing about all of them. This module is where the renderer
// says which of those happened, so the shell can offer the action that matches.
//
// It follows `viewerStatus.ts` verbatim — a `subscribe(cb)` returning an unsubscribe,
// produced by the renderer, consumed by the UI, and it NEVER imports `ui/*`
// (module-map rule 4). Two properties it must hold, both learned from PR #279:
//
//  * Republishing an identical state is a NO-OP, compared BY VALUE. A failure re-raised
//    on every camera move otherwise re-renders the shell continuously and resets any
//    transient UI in it.
//  * `rendererControlState` is EXHAUSTIVE over the union with a `never` default. A
//    `default:` that returns a usable state silently means "the controls are live" for
//    any variant added later — a real defect, verified by adding a variant and watching
//    `tsc --noEmit` pass with exit 0.
//
// GL-free and framework-free: it holds no GPU handle and its only import is the shared
// `errText`, so the node tier drives every transition directly
// (tests/renderer_health.test.ts, tests/renderer_guard_scheduled.test.ts).
import { errText } from "../api-client/errText.ts";

/**
 * What went wrong, at the granularity the USER's next action depends on. There are
 * exactly four because there are exactly three actions worth offering (see
 * `recoveryAction`), and the two that end in "reload the page" arrive by different
 * routes and read differently on screen.
 *
 * - `webgl2-unavailable` — the context could not be created at all. three r169 asks the
 *   canvas for `'webgl2'` ONLY and throws when that returns null (measured 2026-08-20,
 *   node_modules/three/build/three.module.js:28966-28984), so `createWorld` classifies
 *   that throw rather than adding a capability probe of its own — a probe for a WebGL 1
 *   context could never fire, because three never asks for one.
 * - `render-loop-failed` — a throw INSIDE the animation loop. The stack exists; it just
 *   cannot draw, so rebuilding it is worth a try.
 * - `context-unrecoverable` — a `webglcontextlost` that never restored, declared by the
 *   loader's §0.6 watchdog (CONTEXT_RESTORE_TIMEOUT_MS). This is the one path `main`
 *   already surfaced, and its wording is pinned by `e2e/contextloss.spec.ts`.
 * - `layout-assets-failed` — this VIEW's tiles could not be made renderable. The stack
 *   is fine; nothing needs rebuilding.
 * - `boot-failed` — the boot chain ended before a renderer existed at all: the collection,
 *   its manifest or its canvas could not be had. Added for review R1-03, whose point is
 *   that these exits published NOTHING, leaving health pinned at `starting` — a state that
 *   renders both switching surfaces live and un-annotated while every tap is swallowed into
 *   a queue. Every terminal boot outcome now publishes, and this is the state they publish.
 *   Its remedy is a rebuild, which re-runs the whole boot chain — exactly the retry a
 *   transient 503 wants.
 *
 * Seam R2 adds one per GUARDED SCHEDULED SITE (`guardScheduledWork`, P2). A code per
 * site is the whole point: `guardRenderFrame` hard-codes `render-loop-failed`, which
 * blocks every control and offers only a full stack rebuild, so reusing it would let a
 * throw in a frame counter take the viewer down while the picture is fine.
 *
 * - `tile-stream-failed` — the loader's coalesced refresh threw. Streaming stops, but
 *   the stack draws whatever is already bound, so this is scoped to the VIEW.
 * - `context-restore-failed` — `webglcontextrestored` arrived and the loader could not
 *   rebind to it. The context is back and unusable: that is the stack.
 * - `status-emit-failed` / `overview-poll-failed` — a status read-out beside the canvas
 *   (`viewerStatus`'s coalesced emit, the 750 ms minimap poll). Nothing on the canvas is
 *   wrong and there is nothing for the user to do, which is what `recoveryAction`'s
 *   "none" says. `status-emit-failed` is named for the EMIT and not for the fps tick it
 *   used to wrap: `frameTick` is a push and some arithmetic and cannot throw, while every
 *   fallible thing (the O(N) in-view scan, the subscribers' own setState) runs inside
 *   `emit()` on a separate scheduled callback — so a guard on the tick could never fire.
 */
export type RendererFailureCode =
  | "webgl2-unavailable"
  | "render-loop-failed"
  | "context-unrecoverable"
  | "layout-assets-failed"
  | "boot-failed"
  | "tile-stream-failed"
  | "context-restore-failed"
  | "status-emit-failed"
  | "overview-poll-failed";

/** The action offered to the user. One per failure, chosen from ONE field (the code) —
 *  the previous attempt keyed blockedness off `scope` and the button off a second field,
 *  with nothing enforcing that the two agree.
 *
 *  `none` (Seam R2) is not an absence of a decision, it IS one: a failed read-out has no
 *  remedy the user could apply, so offering "Retry renderer" over a canvas that is
 *  drawing correctly would be a lie — and, because the panel and the control gate both
 *  read this one field, it is also what keeps a dead frame counter from blocking every
 *  control in the shell. */
export type RendererAction = "retry-view" | "retry-renderer" | "reload" | "none";

export interface RendererFailure {
  code: RendererFailureCode;
  /** The layout whose assets failed, for a `layout-assets-failed` retry — it is the
   *  view being re-streamed. ALWAYS null for a renderer-scoped failure: a renderer that
   *  died while a layout happened to be booting did not die *of* that layout. */
  layoutId: string | null;
  /** The underlying error text, verbatim — the same `errText(err)` the generic banner
   *  this panel replaces already rendered on screen. Deliberately NOT redacted or
   *  truncated here: doing so would be a behaviour change no property in the brief asks
   *  for, and every length cap available to pick is one no test could drive. */
  detail: string | null;
}

/** The renderer's health. `starting` covers the whole boot — from the first fetch until
 *  the stack is up and drawing — and is deliberately treated as USABLE by
 *  `rendererControlState` (see there). */
export type RendererHealth =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "context-lost" }
  | { kind: "failed"; failure: RendererFailure };

/** What a stack-dependent control (the layout switcher, on either surface) may do. */
export interface RendererControlState {
  usable: boolean;
  /** Why it is blocked, for the control's own explanation. Non-null exactly when
   *  `usable` is false — a blocked control that cannot say why is the defect P5 exists
   *  to prevent, so the two travel together in one value. */
  reason: string | null;
}

// Both reasons name the STATE, not the control (Seam R2 P1). They used to end "switching
// views is unavailable", which was true of the only two surfaces R1 wired and a lie on
// every surface R2 adds: the ⤢ Fit button and the minimap do not switch anything. The
// blocked control still leads with its own tooltip (see `blockedControl`), so what this
// has to supply is the condition the user is in and how long it lasts.
const CONTEXT_LOST_REASON = "Reconnecting to the graphics context — viewer controls are unavailable until it returns.";
const RENDERER_DOWN_REASON = "The viewer's graphics stopped — viewer controls are unavailable until it recovers.";

/**
 * The single mapping from a failure to the action offered for it. Exhaustive with a
 * `never` default, so adding a code without deciding its action fails `tsc --noEmit`
 * instead of silently inheriting someone else's remedy.
 */
export function recoveryAction(code: RendererFailureCode): RendererAction {
  switch (code) {
    // The stack is fine — re-stream this view's assets.
    case "layout-assets-failed":
      return "retry-view";
    // The stack exists but cannot draw — rebuild it in place.
    case "render-loop-failed":
    // ...and a boot that never produced a stack: the rebuild re-runs the whole boot chain,
    // which is the retry a transient API failure needs.
    case "boot-failed":
      return "retry-renderer";
    // Seam R2 site 1: streaming died, the stack did not. Same remedy as above — the
    // loader's own re-stream — and the same escape, switching away.
    case "tile-stream-failed":
      return "retry-view";
    // Seam R2 site 2: the context came back and the loader could not rebind to it. A
    // rebuild is the one thing that re-runs that binding.
    case "context-restore-failed":
      return "retry-renderer";
    // Seam R2 sites 3 and 4: a read-out beside the canvas stopped updating. There is
    // nothing to offer — the picture is fine, and the guard has already stopped the
    // site re-arming, so a rebuild would only throw the user's session away.
    case "status-emit-failed":
    case "overview-poll-failed":
      return "none";
    // A context the browser would not create, and a context that never came back: a new
    // stack in the same page has nothing new to try, so the page itself is the retry.
    case "webgl2-unavailable":
    case "context-unrecoverable":
      return "reload";
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

/**
 * Whether a control that needs the renderer may be used, and why not when it may not.
 * EXHAUSTIVE over `RendererHealth` with a `never` default — see the module header.
 */
export function rendererControlState(health: RendererHealth): RendererControlState {
  switch (health.kind) {
    // Boot stays live and a tap is QUEUED (P6): disabling the switcher for an ordinary
    // healthy boot is worse than the rare wait, and `starting` spans every await in the
    // boot chain — including the tag sidecar, which is multi-MB on a real collection.
    case "starting":
    case "ready":
      return { usable: true, reason: null };
    // No GPU resources exist to swap into: a switch here is destructive.
    case "context-lost":
      return { usable: false, reason: CONTEXT_LOST_REASON };
    case "failed":
      // ONE field decides both halves: a control is blocked exactly when the remedy the
      // panel offers is a STACK-level one. A view-scoped failure keeps its stack, and
      // switching away from the broken view is the escape route — blocking it would trap
      // the user on the one view that does not work. A failure with NO action to offer
      // (Seam R2's read-outs) never touched the canvas at all, so blocking a control over
      // it would take the whole shell down for a frame counter.
      return stackRemedy(recoveryAction(health.failure.code))
        ? { usable: false, reason: RENDERER_DOWN_REASON }
        : { usable: true, reason: null };
    default: {
      const unreachable: never = health;
      return unreachable;
    }
  }
}

/** Whether an offered action means REPLACING the stack — the one axis "may a control be
 *  used" turns on. Exhaustive, so a new action has to decide this rather than inherit it. */
function stackRemedy(action: RendererAction): boolean {
  switch (action) {
    case "retry-renderer":
    case "reload":
      return true;
    case "retry-view":
    case "none":
      return false;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** Whether the failure now standing is about the STACK itself. The precedence rules below
 *  read this rather than "not layout-scoped", which was the same set until Seam R2 added a
 *  failure that is neither: an un-actionable read-out failure must not be treated as the
 *  most urgent truth there is and swallow a later context loss. Derived from the SAME one
 *  field as `recoveryAction`, so what blocks a control and what may overwrite what cannot
 *  drift apart. */
function stackFailureStanding(health: RendererHealth): boolean {
  return health.kind === "failed" && !rendererControlState(health).usable;
}

/**
 * Whether a SWITCH that just succeeded resolved the failure now standing.
 *
 * Only a layout-scoped one, and this is not a formality. `rendererControlState` leaves the
 * switcher LIVE under a layout failure so the user can escape by switching away, and the
 * controller has no manifest after a failed boot — so that escape routes through
 * `activate()`, which awaits a real `getManifest` round trip spanning many frames. The
 * render loop is live throughout (`world.start()` runs unconditionally at boot), so a throw
 * in that window halts the loop and publishes `render-loop-failed`. Testing only
 * `kind === "failed"` would then let the switch's own success erase it — and NOTHING
 * resumes a halted loop (the sole `resumeRenderLoop` call is bound to
 * `webglcontextrestored`, which a render-loop throw never fires). The user would be left on
 * a canvas frozen at its last frame that LOOKS healthy: tabs live, panel gone, fps still
 * ~60 from its own rAF ticker, read-outs still tracking the camera. The same erasure would
 * swallow the watchdog's terminal `context-unrecoverable`, which is that kind too.
 *
 * Keyed off `recoveryAction`, not a literal code: the failure a switch can resolve is
 * exactly the one whose offered action IS "retry this view", so the panel's button and this
 * predicate cannot drift apart, and a new code has to declare its action anyway.
 */

/**
 * Retract a standing `"none"`-action failure, because the site that reported it is running
 * again ([[T2-232]]).
 *
 * The latch and the health state need ONE owner. A `"none"` failure has no button, so
 * `failureResolvedBySwitch` is false for it and `retryView` is unreachable — nothing but
 * `markReady`/`markStarting` would ever clear it, and one throw in a background job left
 * `snapshot().kind === "failed"` for the rest of the session over a viewer that works.
 * Meanwhile the shell was already deciding, on the successful-switch path, that the switch
 * IS those sites' recovery event — releasing their latches and then, on the next line,
 * declining to retract the report that event makes obsolete.
 *
 * So this is called from the SAME place the latches are released, and only there. It
 * deliberately touches nothing else: a failure with an action attached is cleared by that
 * action, not by a background job coming back.
 */
export function clearResumedReadoutFailure(health: Pick<RendererHealthHandle, "snapshot" | "markReady">): void {
  const settled = health.snapshot();
  if (settled.kind !== "failed") return;
  if (recoveryAction(settled.failure.code) !== "none") return;
  health.markReady();
}

export function failureResolvedBySwitch(
  health: RendererHealth,
): health is Extract<RendererHealth, { kind: "failed" }> {
  return health.kind === "failed" && recoveryAction(health.failure.code) === "retry-view";
}

/** The narrowest health surface there is: report a failure, and nothing else. What a
 *  module that can only ever go WRONG needs — the tile loader's guarded sites can neither
 *  claim readiness nor read the state they are writing over, which is the same
 *  report-only constraint `WorldHealthSink` puts on the world. */
export type RendererFailureSink = Pick<RendererHealthHandle, "fail">;

/** One guarded SCHEDULED site (Seam R2 P2). */
export interface ScheduledGuardDeps {
  /** The work this site hands to its scheduler. */
  work(): void;
  /** THIS site's failure code. Not optional and not defaulted: `guardRenderFrame`
   *  hard-codes `render-loop-failed`, which routes to a full stack rebuild and blocks
   *  every stack-dependent control — correct for the render loop and wrong for all four
   *  sites here, so the code is the caller's decision to make. */
  code: RendererFailureCode;
  fail(failure: RendererFailure): void;
}

/** A guarded callable, plus the way back. */
export type ScheduledGuard = (() => void) & {
  /** Re-arm the site. The OWNER calls this at the point the condition that broke the site
   *  has passed — a restored context, a re-activated layout, an explicit retry. */
  reset(): void;
};

/**
 * Wrap the work a site SCHEDULES, so a throw becomes a named failure instead of one
 * throw per frame forever — then LATCH the site off UNTIL SOMETHING RECOVERS IT.
 *
 * This is deliberately not `guardRenderFrame`, and the difference is the anti-loop
 * mechanism. That guard's contract is its RE-THROW, justified solely by three's animation
 * chain re-arming on the line after it calls back (three.module.js:13516/13518) — only
 * the throw ends that chain. None of P2's four sites has that shape:
 *
 *   * the tile-loader's coalesced refresh is re-armed by `world.onCameraChange`, whose
 *     emit is a bare `for (const cb of callbacks) cb(...)` — a re-throw there aborts
 *     every LATER camera subscriber (the status observable, the minimap box);
 *   * the fps proxy and the overview poll are re-armed by their own chain and by the
 *     platform, so the latch is what has to stop them — and BOTH deliberately keep their
 *     scheduler running, so that `reset()` has something to resume;
 *   * a `webglcontextrestored` listener does not loop at all.
 *
 * **The latch is not permanent, and that is a correctness requirement, not a nicety.**
 * `fail()` legitimately DROPS reports — a layout-scoped one while the context is lost, any
 * `"none"` one over a standing failure — and this guard cannot know whether its publish
 * landed. A latch that outlived its cause therefore switched a site off for the life of
 * the page on the strength of a report nobody ever saw: a transient throw while the
 * context was lost left the tile loader deaf to the camera after the restore repaired
 * everything, which is a REGRESSION against `main`, where the unguarded throw self-healed
 * on the next camera move. So recovery re-arms the site, and recovery — not the publish —
 * is what the owner wires.
 *
 * The `console.error` is the floor underneath all of that: the guard neither re-throws nor
 * renders anything for a read-out code, so without it a site could die in total silence in
 * every surface at once, where `main` at least produced an uncaught exception.
 *
 * NOT a "bounded scheduler" (renderer-recovery-restart.md §What we are NOT building):
 * that is a 12-slot admission cap. This adds no cap, no lane, no queue and no ordering —
 * it wraps one callback and stops calling it after it throws.
 */
export function guardScheduledWork(deps: ScheduledGuardDeps): ScheduledGuard {
  let latched = false;
  const run = (): void => {
    if (latched) return;
    try {
      deps.work();
    } catch (err) {
      // Latch FIRST: `fail` can re-enter (a subscriber that renders can schedule), and a
      // second entry must not run the work again.
      latched = true;
      // The REPORTING half needs its own guard, because the no-re-throw contract above is
      // only worth what its weakest path is worth. `deps.fail` → `fail` → `set()` →
      // `for (const cb of subscribers) cb(next)` has no `try` of its own, and
      // `console.error` can be patched by a browser extension or an analytics shim — so a
      // throw HERE escaped `run()` straight back into `world.onCameraChange`'s emit loop
      // and killed every later camera subscriber, which is the exact outcome the contract
      // exists to prevent. Worse, the latch above has already fired, so the site would be
      // dead AND unreported.
      try {
        // LOG before publishing, and unconditionally — the publish may be dropped by
        // precedence, and this is the one report that never can be.
        console.error(`[renderer] ${deps.code}`, err);
        deps.fail({ code: deps.code, layoutId: null, detail: errText(err) });
      } catch {
        /* nothing left to do: the site is latched off and the report cannot be delivered */
      }
    }
  };
  return Object.assign(run, {
    reset: (): void => {
      latched = false;
    },
  });
}

/** The marker a renderer-scoped throw carries so the boot chain's catch can tell it from
 *  an ordinary layout/API error without matching on message text. */
interface CodedError extends Error {
  rendererFailureCode: RendererFailureCode;
}

// The codes that can be STAMPED ON AN ERROR and read back off one (`rendererFailureError`
// / `failureCodeOf`) — NOT the union. `boot-failed` is absent because nothing stamps it,
// and Seam R2's four are absent for the same reason: a guarded site publishes its failure
// directly, so a code here that no `rendererFailureError` call ever produces would be a
// list entry no code path can reach.
const CODES: readonly RendererFailureCode[] = [
  "webgl2-unavailable",
  "render-loop-failed",
  "context-unrecoverable",
  "layout-assets-failed",
];

/** Stamp a code onto a plain `Error` (not an `Error` subclass — `instanceof` across a
 *  subclass is a compile-target hazard, and the shell only ever asks for the code). */
export function rendererFailureError(code: RendererFailureCode, message?: string, cause?: unknown): Error {
  // `cause` is not decoration (review R1-06): without it the shell's console.error logs a
  // stack rooted HERE, in the classifier, instead of at the GL call that actually failed.
  const err = new Error(message ?? code, cause === undefined ? undefined : { cause }) as CodedError;
  err.rendererFailureCode = code;
  return err;
}

/** The renderer failure code an error carries, or null when it is an ordinary error. */
export function failureCodeOf(err: unknown): RendererFailureCode | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as Partial<CodedError>).rendererFailureCode;
  if (typeof code !== "string") return null;
  return CODES.includes(code as RendererFailureCode) ? (code as RendererFailureCode) : null;
}

/**
 * The failure to publish when BUILDING the stack threw. Always renderer-scoped: a
 * renderer that could not be constructed did not fail *of* whatever layout was booting.
 * `createWorld` classifies the one throw that actually happens (no WebGL 2); anything
 * else it could raise is unclassified, and "rebuild the stack" is the only remedy that
 * could help it — which is what `render-loop-failed` offers.
 */
export function rendererFailureFrom(err: unknown, detail: string | null): RendererFailure {
  return { code: failureCodeOf(err) ?? "render-loop-failed", layoutId: null, detail };
}

/**
 * The failure to publish when a LAYOUT ACTIVATION rejected. It is layout-scoped —
 * that is what the caller was doing — UNLESS the error carries a renderer code, which
 * is how a `createWorld` failure reaches the same catch: the boot chain builds the world
 * and activates the first layout in one async run. Scope follows the failure, never the
 * call site that caught it.
 */
export function layoutFailureFrom(err: unknown, layoutId: string, detail: string | null): RendererFailure {
  const code = failureCodeOf(err);
  if (code !== null) return { code, layoutId: null, detail };
  return { code: "layout-assets-failed", layoutId, detail };
}

/** The renderer-owned health surface. `subscribe` returns an unsubscribe and takes an
 *  immediate snapshot (the `viewerStatus.ts` contract).
 *
 *  PRECEDENCE LIVES HERE, not at the call sites (review R1-04/R1-07). It was the other way
 *  round, and the docblock said so — while `WorldHealthSink` deliberately withholds
 *  `snapshot`, so the very call site the rule was delegated to could not read the state it
 *  was supposed to reason about. Each transition below documents what it yields to; the two
 *  that report an EVENT (`markContextLost`/`markContextRestored`) are guarded, and the two
 *  that report a decision the caller just made (`markStarting`/`markReady`) are not. */
export interface RendererHealthHandle {
  subscribe(cb: (health: RendererHealth) => void): () => void;
  snapshot(): RendererHealth;
  /** A new stack is being built — the initial state, and the state a "Retry renderer"
   *  returns to while the shell rebuilds. Unconditional: it is a statement about a stack
   *  that is being replaced wholesale, so nothing it overwrites can still be true. */
  markStarting(): void;
  /** The stack is up and drawing. Unconditional, because it is a POSITIVE CLAIM only the
   *  shell can make — it activated the layout, or it completed a retry — and its call
   *  sites are each guarded by the thing they just did. It is deliberately NOT reachable
   *  from `WorldHealthSink`: the world can see a context come back, which is not the same
   *  as knowing the view it carries is renderable. */
  markReady(): void;
  /** `webglcontextlost` fired. Recovery is in-place and already works (§0.6); this only
   *  makes the window OBSERVABLE, so a control that cannot work during it says why.
   *
   *  Yields to a RENDERER-scoped failure (review R1-07): that failure carries an action
   *  the user still has to take, and replacing it with a passive "reconnecting" status
   *  takes the action off screen — where a later restore would publish `ready` over it and
   *  never give it back. It does take precedence over a LAYOUT-scoped failure, which
   *  deliberately leaves the switcher live: switching during a lost context is
   *  destructive, so the loss is the more urgent truth about what the controls may do. */
  markContextLost(): void;
  /** `webglcontextrestored` fired. Evidence about the CONTEXT and nothing else, so it
   *  applies only to the loss it ended (review R1-04). It used to be `markReady`, which
   *  cleared any standing failure — including the watchdog's terminal
   *  `context-unrecoverable` and a layout failure the restore did not fix. */
  markContextRestored(): void;
  /** Something failed. A RENDERER-scoped failure is unconditional — it is the most urgent
   *  truth there is about the stack. A LAYOUT-scoped one yields to a renderer-scoped
   *  failure and to a lost context, both of which are already standing when it lands.
   *
   *  That guard is not hypothetical (R1-05). The loader publishes a whole-view failure a
   *  full retry ladder (~7s) after the outage that caused it, and the stack can die
   *  inside that window — an unguarded overwrite would swap "Retry renderer" for "Retry
   *  this view" on a halted render loop nothing resumes, and re-open the switcher over a
   *  dead stack, because a layout failure is deliberately `usable`. */
  fail(failure: RendererFailure): void;
}

// There is deliberately NO `dispose()`, unlike `viewerStatus.ts`. A subscriber detaches
// with the unsubscribe `subscribe` returns, and the handle itself is per-component
// garbage once the shell unmounts — so a dispose would have exactly one plausible call
// site, an unmount cleanup, and that is a TRAP: `src/main.tsx` renders under
// `<StrictMode>`, whose simulated unmount would tear down an observable the immediately
// following mount re-uses (the handle is ref-held, so it is never re-created). The
// viewer's failure surface would then be permanently silent in dev.

/** Value equality over the union — the whole point is that a re-raised failure carrying
 *  a fresh object must not wake the shell (P2). */
function sameHealth(a: RendererHealth, b: RendererHealth): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "failed" || b.kind !== "failed") return true;
  return (
    a.failure.code === b.failure.code &&
    a.failure.layoutId === b.failure.layoutId &&
    a.failure.detail === b.failure.detail
  );
}

export function createRendererHealth(): RendererHealthHandle {
  const subscribers = new Set<(health: RendererHealth) => void>();
  let health: RendererHealth = { kind: "starting" };

  function set(next: RendererHealth): void {
    // Value equality, not identity: a failure re-raised with a fresh object must not
    // wake the shell (see the module header).
    if (sameHealth(health, next)) return;
    health = next;
    // `next`, not the field (review R1-24). The loop is not re-entrancy-guarded, so a
    // subscriber that synchronously publishes from inside it would otherwise make every
    // later subscriber skip THIS value and see the newer one twice.
    for (const cb of subscribers) cb(next);
  }

  return {
    subscribe(cb: (health: RendererHealth) => void): () => void {
      subscribers.add(cb);
      cb(health); // immediate snapshot: no subscriber observes a "before first emit" gap
      return () => {
        subscribers.delete(cb);
      };
    },
    snapshot: () => health,
    markStarting: () => set({ kind: "starting" }),
    markReady: () => set({ kind: "ready" }),
    markContextLost: () => {
      // R1-07: a renderer-scoped failure outranks the loss — see the handle's docblock.
      // Read off the one field as everywhere else. This used to be the negation of
      // `failureResolvedBySwitch` ("not layout-scoped"), which was the same set until R2
      // added a third: a read-out failure is not about the stack, so it must NOT swallow
      // the loss the way a real stack failure does.
      if (stackFailureStanding(health)) return;
      set({ kind: "context-lost" });
    },
    markContextRestored: () => {
      // R1-04: evidence about the context, so it speaks only for the loss it ended.
      if (health.kind !== "context-lost") return;
      set({ kind: "ready" });
    },
    fail: (failure: RendererFailure) => {
      // R1-05: a LAYOUT-scoped failure yields to a lost context and to a renderer-scoped
      // failure — see the handle's docblock. Read off the SAME one field as everywhere
      // else (`recoveryAction`), so a new code cannot make this rule and the panel's
      // button disagree, and the mirror of markContextLost's rule above.
      const offered = recoveryAction(failure.code);
      // Seam R2: a failure with NO action to offer is the least urgent thing there is —
      // it reports a read-out beside the canvas. It never displaces a state that still
      // carries something for the user to do, because taking "Retry renderer" off screen
      // to say the fps counter stopped is strictly worse than saying nothing.
      if (offered === "none" && health.kind !== "starting" && health.kind !== "ready") return;
      const layoutScoped = offered === "retry-view";
      if (layoutScoped && health.kind === "context-lost") return;
      if (layoutScoped && stackFailureStanding(health)) return;
      set({ kind: "failed", failure });
    },
  };
}
