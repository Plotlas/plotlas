// Seam R1 (docs/prompts/brief_renderer_recovery_seam.md) — the renderer's HEALTH
// observable, plus the render-loop detection point, pinned in the node tier.
//
// What this tier can and cannot see, so the pins are honest about which they are:
//
//  * `createWorld` needs a real WebGL context. Measured 2026-08-20 against
//    node_modules/three/build/three.module.js (r169, lines 28966-28984): the renderer
//    asks the canvas for `'webgl2'` ONLY and throws `Error creating WebGL context.`
//    when that returns null. So a fake canvas reaches — and only reaches — the
//    construction failure, which is exactly the first detection point; everything
//    after it in `createWorld` is unreachable from both test tiers.
//  * The render loop is therefore pinned through the exported `guardRenderFrame`
//    rather than through a live loop, the same extraction `createPointerInput`
//    already made for its own GL-unreachable bookkeeping (see world.ts's header).
//  * The DOM half of P1/P3/P5/P6 lives in tests/dom/renderer_recovery.dom.test.ts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createRendererHealth,
  failureCodeOf,
  failureResolvedBySwitch,
  layoutFailureFrom,
  recoveryAction,
  rendererControlState,
  rendererFailureFrom,
  rendererFailureError,
} from "../src/renderer/health.ts";
import type { RendererFailure, RendererHealth } from "../src/renderer/health.ts";
import { createWorld, guardRenderFrame } from "../src/renderer/world.ts";

/** The failure carried by a `failed` health, or a test failure if it is any other
 *  kind. Keeps every assertion below comparing STRINGS, never a whole object graph. */
function failureOf(health: RendererHealth): RendererFailure {
  assert.equal(health.kind, "failed", `expected a failed health, got '${health.kind}'`);
  return (health as { kind: "failed"; failure: RendererFailure }).failure;
}

// --- P1: the three failures that never fire `webglcontextlost` -----------------

test("a construction failure with no WebGL 2 is named as such, not as a layout problem", () => {
  // three throws its own error; `createWorld` classifies it, so the shell never has to.
  const canvas = {
    getContext: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;
  let thrown: unknown = null;
  try {
    createWorld(canvas, { width: 800, height: 600, devicePixelRatio: 1 });
  } catch (err) {
    thrown = err;
  }
  assert.equal(failureCodeOf(thrown), "webgl2-unavailable");

  // ...and carried through the boot chain's own catch WITHOUT being re-scoped to the
  // layout that happened to be booting. Scope is a property of the failure, not of
  // where it was caught.
  const failure = layoutFailureFrom(thrown, "grid", "boot");
  assert.equal(failure.code, "webgl2-unavailable");
  assert.equal(failure.layoutId, null);
  assert.equal(recoveryAction(failure.code), "reload");
});

test("a throw inside the render frame is caught once, published, and RE-THROWN", () => {
  const health = createRendererHealth();
  const published: string[] = [];
  health.subscribe((h) => published.push(h.kind === "failed" ? h.failure.code : h.kind));
  health.markReady();

  let halts = 0;
  let frames = 0;
  const frame = guardRenderFrame({
    render: () => {
      frames += 1;
      throw new Error("gl.drawElements: bad state");
    },
    halt: () => {
      halts += 1;
    },
    fail: (f) => health.fail(f),
  });

  // R1-01: the throw must LEAVE the guard. three's animation chain re-arms itself on the
  // line AFTER it calls our loop (three.module.js:13516-13518), so a swallowed throw keeps
  // a dead loop spinning forever — and it also robs devtools / window.onerror of the stack
  // (R1-14). Publishing is not a substitute for propagating.
  assert.throws(
    () => frame(),
    /gl\.drawElements: bad state/,
    "the guard swallowed the throw — three then re-arms the chain and the error is lost",
  );
  assert.equal(halts, 1, "the loop was not halted after the frame threw");
  assert.equal(failureOf(health.snapshot()).code, "render-loop-failed");
  assert.equal(recoveryAction("render-loop-failed"), "retry-renderer");

  // A caller that keeps driving the loop must not re-publish: the shell re-renders on
  // every publish, so a per-frame failure would reset any transient UI 60 times a second.
  assert.throws(() => frame());
  assert.equal(frames, 2, "the guard skipped the second frame instead of running it");
  assert.deepEqual(published, ["starting", "ready", "render-loop-failed"]);
});

// --- R1-01: rAF accounting, against a transcript of three's own animation chain -------

/** A countable fake `requestAnimationFrame`. `tick()` runs exactly the callbacks queued at
 *  that moment — one display frame — and returns whatever they threw, because a browser
 *  routes an exception from a rAF callback to `window.onerror` and keeps going. */
function fakeRaf() {
  const queue = new Map<number, () => void>();
  let nextId = 1;
  return {
    request(cb: () => void): number {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancel(id: number | null): void {
      if (id !== null) queue.delete(id);
    },
    get pending(): number {
      return queue.size;
    },
    tick(): unknown[] {
      const batch = [...queue.values()];
      queue.clear();
      const thrown: unknown[] = [];
      for (const cb of batch) {
        try {
          cb();
        } catch (err) {
          thrown.push(err);
        }
      }
      return thrown;
    },
  };
}

/**
 * three r169's animation chain, TRANSCRIBED from the installed build, because the
 * behaviour this pin accounts for cannot be reached any other way in a GL-free tier:
 *
 *   three.module.js:13514  function onAnimationFrame( time, frame ) {
 *   three.module.js:13516     animationLoop( time, frame );
 *   three.module.js:13518     requestId = context.requestAnimationFrame( onAnimationFrame );
 *   three.module.js:13524  start: if ( isAnimating === true ) return; ... isAnimating = true;
 *   three.module.js:13535  stop:  context.cancelAnimationFrame( requestId ); isAnimating = false;
 *   three.module.js:29838  setAnimationLoop( cb ): animationLoop = cb;
 *                          ( cb === null ) ? animation.stop() : animation.start();
 *
 * Two consequences, both load-bearing: the chain re-arms on the line AFTER our callback
 * returns — so only a THROW ends it, and cancelling from inside the callback cancels the id
 * of the frame already executing, which is a no-op — and `start()` early-returns while
 * `isAnimating` is true, so a halt that did not clear that flag makes a later resume build
 * a SECOND chain.
 *
 * A transcript is not the real thing: this pins OUR guard's arithmetic against three's
 * documented semantics. Only the browser tier runs three itself.
 */
function threeAnimationChain(raf: ReturnType<typeof fakeRaf>) {
  let isAnimating = false;
  let animationLoop: (() => void) | null = null;
  let requestId: number | null = null;

  function onAnimationFrame(): void {
    (animationLoop as () => void)();
    requestId = raf.request(onAnimationFrame);
  }

  return {
    setAnimationLoop(cb: (() => void) | null): void {
      animationLoop = cb;
      if (cb === null) {
        raf.cancel(requestId); // stop()
        isAnimating = false;
        return;
      }
      if (isAnimating) return; // start()
      requestId = raf.request(onAnimationFrame);
      isAnimating = true;
    },
  };
}

test("a halted render loop leaves no pending frame, and a resume draws exactly one per frame", () => {
  const raf = fakeRaf();
  const chain = threeAnimationChain(raf);
  const health = createRendererHealth();
  let renders = 0;
  let failNow = false;

  const frame = guardRenderFrame({
    render: () => {
      renders += 1;
      if (failNow) throw new Error("context lost mid-draw");
    },
    // world.ts's haltLoop, minus the disposed/running bookkeeping this pin does not model.
    halt: () => chain.setAnimationLoop(null),
    fail: (f) => health.fail(f),
  });

  chain.setAnimationLoop(frame); // world.start()
  assert.equal(raf.pending, 1, "starting the loop queued no frame");
  raf.tick();
  assert.equal(renders, 1);
  assert.equal(raf.pending, 1, "a healthy frame must re-arm the chain");

  // The frame throws. THE NUMBER: pending rAF callbacks after the halt.
  failNow = true;
  const thrown = raf.tick();
  assert.equal(thrown.length, 1, "the failure never reached the browser's error channel");
  assert.equal(
    raf.pending,
    0,
    "the animation chain SURVIVED the halt — three re-arms unless the callback throws, so a dead loop spins forever",
  );
  assert.equal(failureOf(health.snapshot()).code, "render-loop-failed");
  const rendersAtHalt = renders;
  raf.tick();
  assert.equal(renders, rendersAtHalt, "something is still driving frames after the halt");

  // ...and a resume must build exactly ONE chain. `start()` early-returns while isAnimating
  // is true, so the halt's `setAnimationLoop(null)` is NOT redundant with the throw: it is
  // what clears that flag. Without it this counts 2 renders per frame.
  failNow = false;
  chain.setAnimationLoop(frame); // resumeRenderLoop()
  assert.equal(raf.pending, 1);
  raf.tick();
  assert.equal(renders - rendersAtHalt, 1, "renders per frame after a resume");
  raf.tick();
  assert.equal(renders - rendersAtHalt, 2, "renders per frame after a resume (second frame)");
});

test("a layout whose assets cannot be made renderable is scoped to that layout", () => {
  const failure = layoutFailureFrom(new Error("pyramid range fetch failed"), "datetime", "404");
  assert.equal(failure.code, "layout-assets-failed");
  assert.equal(failure.layoutId, "datetime", "the retry has to know WHICH view to re-stream");
  assert.equal(failure.detail, "404");
  // The stack is fine — this is the one failure the user recovers from without
  // rebuilding anything, and the one that leaves the switcher live.
  assert.equal(recoveryAction(failure.code), "retry-view");
  assert.equal(rendererControlState({ kind: "failed", failure }).usable, true);
});

// --- P2: renderer-owned, observable, value-equal, exhaustively mapped ----------

test("republishing an identical health is a no-op; a changed failure publishes", () => {
  const health = createRendererHealth();
  const published: RendererHealth[] = [];
  const unsubscribe = health.subscribe((h) => published.push(h));
  assert.equal(published.length, 1, "subscribe owes an immediate snapshot (viewerStatus.ts convention)");

  health.markReady();
  health.markReady();
  assert.equal(published.length, 2, "an identical health re-published");

  const failure: RendererFailure = { code: "layout-assets-failed", layoutId: "grid", detail: null };
  health.fail(failure);
  health.fail({ ...failure }); // a DIFFERENT object with the same value
  assert.equal(published.length, 3, "an equal-by-value failure re-published (compared by identity?)");

  health.fail({ ...failure, layoutId: "datetime" });
  assert.equal(published.length, 4, "a genuinely different failure did NOT publish");

  unsubscribe();
  health.markStarting();
  assert.equal(published.length, 4, "unsubscribe did not detach the subscriber");
});

test("a construction failure that is NOT a missing WebGL 2 stays unclassified", () => {
  // R1-06. The try wrapped the whole `new THREE.WebGLRenderer(...)` and the catch labelled
  // every throw `webgl2-unavailable` — so a browser that CAN make a WebGL 2 context but
  // refused our attributes, or a throw inside three's own initGLContext, was told to
  // reload the page for a browser problem it does not have. It also made
  // `rendererFailureFrom`'s `?? "render-loop-failed"` fallback unreachable for every
  // construction throw, contradicting its own docstring.
  //
  // A canvas that HANDS OUT a webgl2 context which is not a GL implementation: three gets
  // past context acquisition and dies later, which is the real shape of the case.
  const canvas = {
    getContext: () => ({ getExtension: undefined }),
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
  } as unknown as HTMLCanvasElement;
  let thrown: unknown = null;
  try {
    createWorld(canvas, { width: 800, height: 600, devicePixelRatio: 1 });
  } catch (err) {
    thrown = err;
  }
  assert.notEqual(thrown, null, "three constructed a renderer from a non-GL context");
  assert.equal(failureCodeOf(thrown), null, "a non-context construction failure was labelled webgl2-unavailable");
  // ...so the shell offers the rebuild remedy rather than a reload that cannot help.
  assert.equal(rendererFailureFrom(thrown, null).code, "render-loop-failed");
});

test("a classified construction failure carries the original error as its cause", () => {
  // R1-06 secondary: without `cause` the console.error at the catch logs a stack rooted at
  // the classifier, not at the GL call that failed.
  const canvas = {
    getContext: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;
  try {
    createWorld(canvas, { width: 800, height: 600, devicePixelRatio: 1 });
    assert.fail("createWorld returned without a WebGL context");
  } catch (err) {
    assert.equal(failureCodeOf(err), "webgl2-unavailable");
    const cause = (err as { cause?: unknown }).cause;
    assert.equal(cause instanceof Error, true, "the coded error dropped the throw it classified");
    assert.match((cause as Error).message, /WebGL context/);
  }
});

test("the render-loop failure's detail comes from the shared errText", () => {
  // R1-25: world.ts had two verbatim copies of errText's fallback, which do NOT prefer the
  // server's `detail` field — so the same thrown ApiError read differently in the panel
  // than in the banner.
  const health = createRendererHealth();
  const frame = guardRenderFrame({
    render: () => {
      throw Object.assign(new Error("Request failed"), { detail: "tile 3/1/2 is not in the archive" });
    },
    halt: () => {},
    fail: (f) => health.fail(f),
  });
  assert.throws(() => frame());
  assert.equal(failureOf(health.snapshot()).detail, "tile 3/1/2 is not in the archive");
});

test("a subscriber that re-enters set() does not make the next one skip a value", () => {
  // R1-24: the notify loop re-read the mutable `health` field each iteration instead of the
  // value it was publishing, so a synchronous re-entrant transition made subscriber #2 miss
  // one value entirely and see the newer one twice.
  const health = createRendererHealth();
  const seen: string[] = [];
  let reentered = false;
  health.subscribe((h) => {
    if (h.kind === "ready" && !reentered) {
      reentered = true;
      health.markContextLost(); // re-enters set() from inside the notify loop
    }
  });
  health.subscribe((h) => seen.push(h.kind));
  health.markReady();
  assert.equal(seen[0], "starting", "the immediate snapshot on subscribe");
  assert.equal(
    seen.includes("ready"),
    true,
    "subscriber #2 never saw the value being published — it read the field, not the value",
  );
});

test("a context loss does not erase a failure the user still has to act on", () => {
  // R1-07. `markContextLost` overwrote whatever stood. A renderer-scoped failure carries an
  // ACTION — "Retry renderer" — and replacing it with the passive "reconnecting" status
  // takes that action off the screen; a later restore then publishes `ready` and it never
  // comes back, leaving a dead renderer looking healthy.
  const health = createRendererHealth();
  health.fail({ code: "render-loop-failed", layoutId: null, detail: "gl" });
  health.markContextLost();
  assert.equal(failureOf(health.snapshot()).code, "render-loop-failed", "a context loss erased a renderer failure");

  // ...but a LAYOUT failure deliberately leaves the switcher LIVE, and switching while the
  // context is lost is destructive — so the loss does take precedence over that one.
  const layout = createRendererHealth();
  layout.fail({ code: "layout-assets-failed", layoutId: "grid", detail: null });
  layout.markContextLost();
  assert.equal(layout.snapshot().kind, "context-lost", "a lost context left the switcher live");
});

test("a restored context clears the lost context and nothing else", () => {
  // R1-04. `world.ts` published `markReady()` from `webglcontextrestored`, which cleared any
  // standing failure — including the watchdog's terminal one. A restore is evidence about
  // the CONTEXT, not about whether a layout activated or a boot finished.
  const health = createRendererHealth();
  health.fail({ code: "context-unrecoverable", layoutId: null, detail: null });
  health.markContextRestored();
  assert.equal(failureOf(health.snapshot()).code, "context-unrecoverable", "a restore erased a terminal failure");

  // From `starting` it is likewise not a claim that boot finished.
  const booting = createRendererHealth();
  booting.markContextRestored();
  assert.equal(booting.snapshot().kind, "starting");

  // What it IS evidence for: the loss it ended.
  const lost = createRendererHealth();
  lost.markReady();
  lost.markContextLost();
  lost.markContextRestored();
  assert.equal(lost.snapshot().kind, "ready");
});

test("rendererControlState blocks exactly the states a layout switch cannot survive", () => {
  // Boot stays LIVE (P6: the tap is queued, not refused) — disabling the switcher for
  // an ordinary healthy boot is worse than the rare wait.
  assert.equal(rendererControlState({ kind: "starting" }).usable, true);
  assert.equal(rendererControlState({ kind: "starting" }).reason, null);
  assert.equal(rendererControlState({ kind: "ready" }).usable, true);

  // A lost context has no GPU resources to swap: switching there is destructive.
  const lost = rendererControlState({ kind: "context-lost" });
  assert.equal(lost.usable, false);
  assert.equal(typeof lost.reason, "string", "a blocked control must carry its reason");
  assert.ok((lost.reason ?? "").length > 0);

  // A renderer-scoped failure needs a new stack; a layout-scoped one does not, and
  // switching away is its escape route. BOTH read off the same one field.
  for (const code of ["webgl2-unavailable", "render-loop-failed", "context-unrecoverable"] as const) {
    const blocked = rendererControlState({ kind: "failed", failure: { code, layoutId: null, detail: null } });
    assert.equal(blocked.usable, false, `${code} left the switcher live`);
    assert.equal(typeof blocked.reason, "string", `${code} blocked the switcher with no reason`);
  }
  const layoutFailed = rendererControlState({
    kind: "failed",
    failure: { code: "layout-assets-failed", layoutId: "grid", detail: null },
  });
  assert.equal(layoutFailed.usable, true);
  assert.equal(layoutFailed.reason, null);
});

test("every failure code offers exactly one action, and every action is offered", () => {
  const codes = ["webgl2-unavailable", "render-loop-failed", "context-unrecoverable", "layout-assets-failed"] as const;
  const actions = codes.map((c) => recoveryAction(c));
  assert.deepEqual([...new Set(actions)].sort(), ["reload", "retry-renderer", "retry-view"]);
  // The blocked/live decision and the button both read `code` — there is no second
  // field for them to disagree about (P3).
  for (const code of codes) {
    const usable = rendererControlState({ kind: "failed", failure: { code, layoutId: null, detail: null } }).usable;
    assert.equal(usable, recoveryAction(code) === "retry-view", `${code}: blockedness disagreed with the action`);
  }
});

test("an error carrying no renderer code is not mistaken for one", () => {
  assert.equal(failureCodeOf(new Error("boom")), null);
  assert.equal(failureCodeOf(null), null);
  assert.equal(failureCodeOf({ rendererFailureCode: "not-a-code" }), null);
  assert.equal(failureCodeOf(rendererFailureError("context-unrecoverable")), "context-unrecoverable");
});

// --- P3 follow-up: a successful switch clears only what a switch can FIX -------

test("a switch that succeeds does not erase a failure it did not fix", () => {
  const health = createRendererHealth();

  // (1) Boot's `controller.activate(firstLayout)` rejects transiently. The switcher is
  //     deliberately left LIVE for this failure, because switching away IS the escape
  //     route — so a switch from here is the expected next thing to happen.
  health.fail({ code: "layout-assets-failed", layoutId: "grid", detail: "pyramid header 404" });
  assert.equal(failureResolvedBySwitch(health.snapshot()), true, "the escape switch cannot clear what it fixes");

  // (2) That escape switch routes through `activate()` (the controller holds no manifest
  //     after a failed boot), which AWAITS a `getManifest` round trip — many frames, not
  //     microtasks. `world.start()` ran unconditionally at boot, so the render loop is
  //     live in that window, and a throw in it halts the loop and publishes this:
  health.fail({ code: "render-loop-failed", layoutId: null, detail: "gl.drawElements: bad state" });

  // (3) The fetch resolves and the switch succeeds. The success is REAL — and it did not
  //     resume the halted loop; nothing does, because the only `resumeRenderLoop` call is
  //     bound to `webglcontextrestored`, which a render-loop throw never fires. Clearing
  //     the failure here leaves a canvas frozen on its last frame that LOOKS healthy:
  //     tabs live, panel unmounted, fps still ~60 (its own rAF ticker), zoom read-out and
  //     minimap box still tracking the camera. Numbers move, picture does not.
  assert.equal(
    failureResolvedBySwitch(health.snapshot()),
    false,
    "a successful switch erased a halted render loop",
  );

  // The watchdog's TERMINAL failure is kind 'failed' too, and is just as much not a
  // switch's to clear — testing the kind alone erases both.
  for (const code of ["context-unrecoverable", "webgl2-unavailable"] as const) {
    health.fail({ code, layoutId: null, detail: null });
    assert.equal(failureResolvedBySwitch(health.snapshot()), false, `a switch erased ${code}`);
  }

  // Nothing that is not a failure is "a failure a switch resolved" either.
  for (const kind of ["starting", "ready", "context-lost"] as const) {
    assert.equal(failureResolvedBySwitch({ kind }), false, `${kind} is not a failure at all`);
  }
});

test("what a switch may clear is the same one field the button reads", () => {
  // Keyed off `recoveryAction`, not a second copy of the code list: the failure a switch
  // resolves is exactly the one whose offered action IS "retry this view". A future code
  // cannot make the panel and this predicate disagree, and `recoveryAction`'s `never`
  // default still forces that decision to be made once.
  const codes = ["webgl2-unavailable", "render-loop-failed", "context-unrecoverable", "layout-assets-failed"] as const;
  for (const code of codes) {
    assert.equal(
      failureResolvedBySwitch({ kind: "failed", failure: { code, layoutId: null, detail: null } }),
      recoveryAction(code) === "retry-view",
      `${code}: what a switch clears disagreed with what the panel offers`,
    );
  }
});

test("a layout-scoped failure never displaces a renderer-scoped one, or a lost context", () => {
  // R1-05 made the LOADER a publisher, and it publishes LATE: a tile spends the whole
  // retry ladder (RETRY_ATTEMPT_BACKOFF_MS, ~7s) before its view is declared
  // unrenderable. That is 7s in which the stack itself can die — and an unguarded
  // `fail` would then replace "Retry renderer" with "Retry this view", offering a
  // re-stream on a halted render loop that nothing resumes and un-blocking the switcher
  // over a dead stack. Precedence is decided HERE and not at the call sites (R1-04/R1-07,
  // and `WorldHealthSink` withholds `snapshot` precisely so it cannot be decided there).
  const layout: RendererFailure = { code: "layout-assets-failed", layoutId: "grid", detail: "502" };

  for (const code of ["render-loop-failed", "context-unrecoverable", "webgl2-unavailable", "boot-failed"] as const) {
    const health = createRendererHealth();
    health.fail({ code, layoutId: null, detail: null });
    health.fail(layout);
    assert.equal(failureOf(health.snapshot()).code, code, `a layout failure displaced ${code}`);
  }

  // Same rule for a lost context: switching during one is destructive, so the loss is
  // the more urgent truth about what the controls may do (the mirror of markContextLost,
  // which already yields to a renderer-scoped failure and outranks a layout one).
  const lost = createRendererHealth();
  lost.markReady();
  lost.markContextLost();
  lost.fail(layout);
  assert.equal(lost.snapshot().kind, "context-lost", "a layout failure displaced a lost context");

  // ...and it still publishes over every state that is not one of those: a boot still
  // `starting`, a healthy `ready`, and a layout failure naming a different view.
  const booting = createRendererHealth();
  booting.fail(layout);
  assert.equal(failureOf(booting.snapshot()).code, "layout-assets-failed", "a boot-time layout failure was swallowed");

  const healthy = createRendererHealth();
  healthy.markReady();
  healthy.fail(layout);
  assert.equal(failureOf(healthy.snapshot()).code, "layout-assets-failed", "a layout failure was swallowed while ready");

  const restream = createRendererHealth();
  restream.fail({ ...layout, layoutId: "datetime" });
  restream.fail(layout);
  assert.equal(failureOf(restream.snapshot()).layoutId, "grid", "a second layout failure could not replace the first");
});
