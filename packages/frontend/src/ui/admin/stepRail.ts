// The wizard's 3-step rail (board 1g): Source · Map roles · Progress. This is a
// VIEW over the existing wizard phase — NOT a new state machine (brief §2/§3.3).
// `stepStates` is a pure mapping from (phase, whether a metadata file is in play,
// whether the job has reached a terminal state) to each step's visual state, and
// StepRail renders it. Both are unit-tested directly.
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the node
// test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h } from "react";
import type { ReactElement } from "react";

/** The three wizard steps, in rail order. */
export const WIZARD_STEPS = ["source", "roles", "progress"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** A step is `done` (a check circle), `active` (accent-filled number), or
 *  `pending` (outline number). `skipped` is a pending variant for the Map-roles
 *  step of an images-only dataset (no metadata to map) — still shown, dimmed. */
export type StepState = "done" | "active" | "pending" | "skipped";

/** Where the user is inside the single `form` phase: still on the source inputs,
 *  or mapping roles (a metadata file has been chosen and parsed). Derived in the
 *  wizard from existing state (csvFile + draft) — not a new phase. */
export type FormStage = "source" | "roles";

export interface StepStatesInput {
  /** The wizard's existing phase (CreateDatasetWizard `Phase`). */
  phase: "form" | "uploading" | "polling";
  /** True once a metadata file is chosen — makes Map-roles a real (not skipped) step. */
  hasMetadata: boolean;
  /** Within the `form` phase, whether the user has advanced to role mapping. */
  formStage: FormStage;
  /** True when the polled job has reached a terminal RQ state (Progress done). */
  jobTerminal: boolean;
}

/** Pure map from wizard phase → per-step state (brief §3.3). No timers, no DOM. */
export function stepStates(input: StepStatesInput): Record<WizardStep, StepState> {
  const rolesResting: StepState = input.hasMetadata ? "pending" : "skipped";

  if (input.phase === "form") {
    if (input.formStage === "roles") {
      // Source captured; the user is mapping roles (only reachable with metadata).
      return { source: "done", roles: "active", progress: "pending" };
    }
    return { source: "active", roles: rolesResting, progress: "pending" };
  }

  // uploading / polling: source + roles are behind us; progress carries the flow.
  const roles: StepState = input.hasMetadata ? "done" : "skipped";
  const progress: StepState = input.jobTerminal ? "done" : "active";
  return { source: "done", roles, progress };
}

const STEP_LABEL: Record<WizardStep, string> = {
  source: "Source",
  roles: "Map roles",
  progress: "Progress",
};

export interface StepRailProps {
  states: Record<WizardStep, StepState>;
}

/** The step rail: a done step shows an --ok check circle, the active step an
 *  accent-filled number, pending/skipped an outline number (skipped dimmed). */
export function StepRail(props: StepRailProps): ReactElement {
  return h(
    "ol",
    { className: "step-rail", "aria-label": "Ingest steps" },
    WIZARD_STEPS.map((step, i) => {
      const state = props.states[step];
      return h(
        "li",
        {
          key: step,
          className: `step step-${state}`,
          "aria-current": state === "active" ? "step" : undefined,
        },
        h(
          "span",
          { className: "step-marker", "aria-hidden": "true" },
          state === "done" ? "✓" : String(i + 1),
        ),
        h("span", { className: "step-label" }, STEP_LABEL[step]),
      );
    }),
  );
}
