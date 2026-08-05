// Add-layout wizard (T2-92 Seam 1; design memo docs/spikes/spike_add_layout_wizard.md)
// — the "import wizard, images already loaded" replacement for the opaque add-layout
// type-checkboxes (T2-58's addLayoutPicker). It reuses the create wizard's
// RoleAssignmentForm over a draft PRE-FILLED from the dataset's stored column_roles
// (rolesDraftFromColumnRoles), lets the user re-map already-stored columns, gates the
// offered layouts on the assigned roles, and shows which layouts already exist
// (disabled) vs are new (checkbox) — submitting ONLY the new layout_ids so the bake
// never collision-errors (worker._guard_no_collision). The add-layouts route already
// accepts the column_roles override (client.addLayouts → AddLayoutsRequest.column_roles),
// so there is ZERO backend change.
//
// ★ Seam-1 LIMIT (surfaced in the UI copy): it can only re-map columns ALREADY stored
// in metadata.parquet (ingest stores only roled columns — the memo's root finding). On a
// fully-mapped dataset its realistic win is re-roling a stored column; mostly it makes
// clear WHY nothing new is available. Uploading/merging NEW metadata is Seam 2.
//
// Stateful container — composed into AdminScreen, never imported by node unit tests (its
// presentational pieces + pure roles/jobPoll modules are tested directly; the wizard
// itself is covered by the jsdom DOM tier, tests/dom/add_layout_wizard.dom.test.ts).
// All network through the injected ApiClient; server errors surface via ApiError.detail.
import { createElement as h, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { DatasetSummary, JobStatus } from "../../api-client/types";
import {
  availableLayoutTypes,
  buildColumnRoles,
  producibleLayouts,
  rolesDraftFromColumnRoles,
  validateDraft,
} from "./roles";
import type { RolesDraft } from "./roles";
import { RoleAssignmentForm } from "./RoleAssignmentForm";
import { JobProgressView } from "./JobProgress";
import { StepRail, stepStates } from "./stepRail";
import { createUnmountGuard, pollJob, TERMINAL_JOB_STATES } from "./jobPoll";
import { useActivityActions } from "../activity/activityContext";

export interface AddLayoutWizardProps {
  client: ApiClient;
  /** The committed dataset to add layouts to — supplies dataset_id and the baked
   *  layout_ids (existing-vs-new gating). */
  dataset: DatasetSummary;
  /** Called when the user leaves the wizard (done, or back). AdminScreen reloads. */
  onDone: () => void;
  onAuthExpired: () => void;
}

function errText(err: unknown): string {
  if (typeof err === "object" && err !== null && typeof (err as { detail?: unknown }).detail === "string") {
    return (err as { detail: string }).detail;
  }
  return err instanceof Error ? err.message : String(err);
}

function errStatus(err: unknown): number | null {
  if (typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

type Phase = "form" | "enqueuing" | "polling";

export function AddLayoutWizard(props: AddLayoutWizardProps): ReactElement {
  const { client, dataset, onAuthExpired } = props;
  const dsId = dataset.dataset_id;

  // Draft pre-filled from the dataset's stored roles: null while loading OR when the
  // dataset is images-only (no metadata to map). `loaded` distinguishes the two.
  const [draft, setDraft] = useState<RolesDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The new layout_ids ticked to bake.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  // StrictMode-safe "stop polling on unmount" guard (see jobPoll.createUnmountGuard —
  // the #133 progress-freeze fix the create wizard also uses).
  const [guard] = useState(createUnmountGuard);
  useEffect(() => guard.onMount(), [guard]);
  // Seam O3: register the enqueued bake with the global activity tracker (stable ref
  // from the action-only context — no re-render on progress ticks).
  const { register: registerJob } = useActivityActions();

  // Load the dataset's stored column_roles from the manifest (embedded, D-16). Any
  // committed layout's manifest carries the same dataset-level column_roles — grid is
  // the D-25 floor and always present, so read it (else the first layout).
  useEffect(() => {
    let live = true;
    void (async () => {
      const layoutId = dataset.layout_ids.includes("grid") ? "grid" : dataset.layout_ids[0];
      if (layoutId === undefined) {
        if (live) setLoadError("This dataset has no committed layouts to read roles from.");
        return;
      }
      try {
        const manifest = await client.getManifest(dsId, layoutId);
        if (!live) return;
        if (manifest.column_roles !== undefined) {
          setDraft(rolesDraftFromColumnRoles(manifest.column_roles));
        }
        setLoaded(true); // column_roles absent ⇒ images-only: loaded, but nothing to map
      } catch (err) {
        if (!live) return;
        if (errStatus(err) === 401) {
          onAuthExpired();
          return;
        }
        setLoadError(errText(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, dsId, dataset.layout_ids, onAuthExpired]);

  const availableTypes = useMemo(() => availableLayoutTypes(draft), [draft]);

  // Producible layouts split into already-baked (disabled) and new (checkbox). The
  // wizard only ever submits NEW ids (existing would collision-error at bake).
  const existingIds = useMemo(() => new Set(dataset.layout_ids), [dataset.layout_ids]);
  const producible = useMemo(() => (draft !== null ? producibleLayouts(draft) : []), [draft]);
  const newLayouts = producible.filter((l) => !existingIds.has(l.layout_id));
  const existingProducible = producible.filter((l) => existingIds.has(l.layout_id));
  const selectedNew = newLayouts.filter((l) => selectedIds.includes(l.layout_id));

  function toggleId(id: string): void {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit(): Promise<void> {
    if (draft === null) return;
    const specs = selectedNew.map((l) => l.layout_id);
    if (specs.length === 0) {
      setError("Tick at least one new layout to add.");
      return;
    }
    const problem = validateDraft(draft);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setPhase("enqueuing");
    try {
      const res = await client.addLayouts(dsId, {
        layout_specs: specs,
        column_roles: buildColumnRoles(draft),
      });
      setJobId(res.job_id);
      registerJob(dsId, res.job_id); // Seam O3: track it globally
      setPhase("polling");
      try {
        await pollJob(client, res.job_id, setJobStatus, { isCancelled: () => guard.isCancelled() });
      } catch (pollErr) {
        setPollError(errText(pollErr));
      }
    } catch (err) {
      if (errStatus(err) === 401) {
        onAuthExpired();
        return;
      }
      // 403 not-owner, 409 job-running / no-bundle, 422 empty specs — the server's
      // detail is the message (never a raw status).
      setError(errText(err));
      setPhase("form");
    }
  }

  const jobTerminal = jobStatus !== null && TERMINAL_JOB_STATES.has(jobStatus.state);
  const rail = h(StepRail, {
    states: stepStates({
      // Source is pre-satisfied (images already loaded) → always done; the flow lives in
      // Map-roles then Progress (memo §2). Map enqueuing to the rail's "uploading".
      phase: phase === "enqueuing" ? "uploading" : phase,
      hasMetadata: true,
      formStage: "roles",
      jobTerminal,
    }),
  });

  const backButton = (label: string): ReactElement =>
    h("button", { type: "button", className: "btn ghost", onClick: () => props.onDone() }, label);

  // ---- Progress (reuses JobProgressView + pollJob verbatim). ----
  if (phase === "polling" && jobId !== null) {
    return h(
      "div",
      { className: "wizard" },
      rail,
      h(JobProgressView, { jobId, status: jobStatus, pollError }),
      jobTerminal || pollError !== null
        ? h(
            "button",
            { type: "button", className: "btn pri", onClick: () => props.onDone() },
            "Back to Library",
          )
        : h("p", { className: "muted" }, "You can keep this open — polling backs off to every 10 s."),
    );
  }

  // ---- Load / images-only guards. ----
  if (loadError !== null) {
    return h(
      "div",
      { className: "wizard" },
      h("p", { className: "error-text", role: "alert" }, loadError),
      backButton("Back to Library"),
    );
  }
  if (!loaded) {
    return h("div", { className: "wizard" }, h("p", { className: "muted" }, "Loading dataset roles…"));
  }
  if (draft === null) {
    // Loaded, but the dataset stores no metadata columns (images-only). Nothing to map —
    // and the honest Seam-1 limit: new columns need new metadata (Seam 2).
    return h(
      "div",
      { className: "wizard" },
      rail,
      h(
        "section",
        { className: "wizard-step", "aria-label": "Add layout" },
        h("h4", { className: "wizard-step-title" }, "No metadata to map"),
        h(
          "p",
          { className: "muted" },
          "This dataset was built from images only, so there are no metadata columns to " +
            "arrange a layout by. Uploading metadata to unlock datetime / categorical / " +
            "scatter / geographic layouts is coming in a later update.",
        ),
      ),
      backButton("Back to Library"),
    );
  }

  // ---- Step 1: Map roles (RoleAssignmentForm pre-filled from the stored roles). ----
  const rolesStep = h(
    "section",
    { className: "wizard-step", "aria-label": "Map roles" },
    h("h4", { className: "wizard-step-title" }, "Map roles"),
    h(
      "p",
      { className: "muted" },
      "A layout arranges the images by a metadata column. These roles are what this " +
        "dataset already has — re-map a column below to make a new layout available. " +
        "(Only columns already stored can be re-mapped; adding a brand-new column needs " +
        "new metadata, coming later.)",
    ),
    h(RoleAssignmentForm, { draft, onChange: setDraft, unlocks: availableTypes }),
  );

  // ---- Step 2: Choose layouts — new (checkbox) vs already-baked (disabled). ----
  const layoutsStep = h(
    "section",
    { className: "wizard-step", "aria-label": "Choose layouts" },
    h("h4", { className: "wizard-step-title" }, "Choose layouts"),
    producible.length === 0
      ? h(
          "p",
          { className: "muted" },
          "Map a datetime, categorical, scatter, or geographic role above to make a layout available.",
        )
      : h(
          "div",
          { className: "addlayout-list" },
          ...newLayouts.map((l) =>
            h(
              "label",
              { key: l.layout_id, className: "checkbox-label" },
              h("input", {
                type: "checkbox",
                checked: selectedIds.includes(l.layout_id),
                onChange: () => toggleId(l.layout_id),
              }),
              h("span", null, l.label),
              h("span", { className: "muted addlayout-id" }, `${l.layout_id} · new`),
            ),
          ),
          ...existingProducible.map((l) =>
            h(
              "label",
              { key: l.layout_id, className: "checkbox-label addlayout-existing" },
              h("input", { type: "checkbox", checked: true, disabled: true, readOnly: true }),
              h("span", null, l.label),
              h("span", { className: "muted addlayout-id" }, `${l.layout_id} · already baked`),
            ),
          ),
        ),
    producible.length > 0 && newLayouts.length === 0
      ? h(
          "p",
          { className: "muted" },
          "Every layout your current roles produce is already baked. Re-map a column above to add a new one.",
        )
      : null,
  );

  return h(
    "div",
    { className: "wizard" },
    rail,
    rolesStep,
    layoutsStep,
    error !== null ? h("p", { className: "error-text", role: "alert" }, error) : null,
    h(
      "div",
      { className: "wizard-actions" },
      phase === "enqueuing"
        ? h("p", { className: "muted" }, "Starting the bake…")
        : h(
            "button",
            {
              type: "button",
              className: "btn pri",
              disabled: selectedNew.length === 0,
              onClick: () => void submit(),
            },
            selectedNew.length > 0
              ? `Add ${selectedNew.length} layout${selectedNew.length === 1 ? "" : "s"}`
              : "Add layouts",
          ),
      backButton("Cancel"),
    ),
  );
}
