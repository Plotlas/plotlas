// The recovery surface (Seam R1 P3) — taken from the abandoned #274 branch (plan step 7)
// and rewritten against `renderer/health.ts`.
//
// What `main` shows for EVERY renderer failure is one string: "Rendering was interrupted
// and could not recover. Reload the page to continue." A layout whose tiles 404'd, a
// browser with no WebGL 2 and a GPU reset are three different problems with three
// different remedies, and two of them do not need the page reloaded at all.
//
// So: one panel, one action, chosen from ONE field of the failure. `recoveryAction(code)`
// picks it, and the SAME call decides whether the layout switcher is blocked
// (`rendererControlState`) — the previous attempt keyed blockedness off `scope` and the
// button off `diagnosticCode`, with nothing enforcing that the two agree.
//
// What #274 had here and this does not: a "Copy diagnostics" button, whose payload was
// the withdrawn scheduler's queue/lane/cache counters (brief §6), and two help links. No
// property in §2 asks for either.
//
// .ts + createElement (no JSX): the node test runner strips types but cannot transform
// JSX — the constraint LayoutSwitcher.ts documents.
import { createElement as h } from "react";
import type { ReactElement } from "react";
import { recoveryAction } from "../renderer/health.ts";
import type { RendererFailure, RendererHealth } from "../renderer/health.ts";

export interface RendererRecoveryPanelProps {
  health: RendererHealth;
  /** Re-stream this layout — the stack is fine. */
  onRetryView(): void;
  /** Rebuild the renderer stack in place (ViewerScreen remounts it). */
  onRetryRenderer(): void;
  onReloadPage(): void;
}

/** What to say about each failure. Read with `recoveryAction` beside it: the sentence and
 *  the button are two halves of one remedy, so they are chosen from the same field. */
function message(failure: RendererFailure): string {
  switch (failure.code) {
    case "layout-assets-failed":
      return failure.layoutId === null
        ? "This view's images could not be loaded."
        : `This view's images could not be loaded (${failure.layoutId}).`;
    case "render-loop-failed":
      return "Rendering stopped unexpectedly. Rebuilding the viewer may bring it back.";
    // Seam R2 P2, site 1. Distinct from `layout-assets-failed`, which is "the tiles
    // could not be fetched": here the fetching itself stopped, so the view is frozen at
    // whatever is already drawn rather than empty.
    case "tile-stream-failed":
      return "This view stopped loading new images. Retrying it re-streams the view.";
    // Site 2: the browser gave the context back and the loader could not rebind to it,
    // so unlike an ordinary loss this one does not resolve itself.
    case "context-restore-failed":
      return "The graphics connection came back, but the viewer could not use it.";
    // Sites 3 and 4. Not reached while their action is "none" (the panel returns null
    // before asking for a message), but written honestly rather than left to a default:
    // if either is ever given an action, this is what it should say.
    case "status-emit-failed":
    case "overview-poll-failed":
      return "A viewer read-out stopped updating. The atlas itself is unaffected.";
    case "boot-failed":
      // The collection, its manifest or its canvas could not be had, so there is no
      // renderer to talk about — say what failed, and offer the rebuild, which re-runs the
      // whole boot. The underlying text renders below as `detail`, exactly as the banner
      // this replaces showed it.
      return "The viewer could not start.";
    case "webgl2-unavailable":
      return (
        "This viewer needs WebGL 2, and the browser could not start it. " +
        "Reload the page to try again, or check that hardware acceleration is enabled."
      );
    case "context-unrecoverable":
      // `main`'s wording, kept verbatim: e2e/contextloss.spec.ts's watchdog test waits
      // for role="alert" to contain /reload the page/i, and that test must pass
      // UNMODIFIED (brief P4).
      return "Rendering was interrupted and could not recover. Reload the page to continue.";
    default: {
      const unreachable: never = failure.code;
      return unreachable;
    }
  }
}

/** The one action offered, as [label, handler] — or null when there is none to offer. */
function action(props: RendererRecoveryPanelProps, failure: RendererFailure): [string, () => void] | null {
  const offered = recoveryAction(failure.code);
  switch (offered) {
    case "retry-view":
      return ["Retry this view", props.onRetryView];
    case "retry-renderer":
      return ["Retry renderer", props.onRetryRenderer];
    case "reload":
      return ["Reload page", props.onReloadPage];
    // Seam R2: a read-out died beside a canvas that is drawing correctly. There is no
    // button that would help, and this panel is a `role="alert"` — raising one over a
    // healthy picture to report an fps counter is the false alarm the whole recovery
    // seam exists to avoid. The guard has already latched the site off and the failure
    // is on the observable for anything that wants it.
    case "none":
      return null;
    default: {
      const unreachable: never = offered;
      return unreachable;
    }
  }
}

export function RendererRecoveryPanel(props: RendererRecoveryPanelProps): ReactElement | null {
  const { health } = props;
  if (health.kind === "starting" || health.kind === "ready") return null;
  if (health.kind === "context-lost") {
    // In-place recovery is already running (§0.6) and usually finishes in under a second:
    // a live `role="status"` region, never an alert, and no action to take.
    return h(
      "p",
      { className: "panel-float renderer-recovery-status", role: "status" },
      "Graphics connection interrupted — trying to recover this view.",
    );
  }
  const { failure } = health;
  const offered = action(props, failure);
  if (offered === null) return null; // nothing to offer, and nothing worth alerting about
  const [label, onClick] = offered;
  return h(
    "section",
    {
      className: "panel-float renderer-recovery-panel",
      role: "alert",
      // A stable hook so tests/e2e can address THIS alert region: a bare
      // getByRole("alert") is ambiguous whenever the API error banner (also role="alert")
      // is on screen, which is a strict-mode failure rather than a real assertion.
      "data-testid": "renderer-recovery-panel",
    },
    h("p", null, message(failure)),
    // The underlying error text, as the banner this replaces already showed it.
    failure.detail !== null ? h("p", { className: "renderer-recovery-detail" }, failure.detail) : null,
    h(
      "div",
      { className: "renderer-recovery-actions" },
      h("button", { type: "button", className: "btn", onClick }, label),
    ),
  );
}
