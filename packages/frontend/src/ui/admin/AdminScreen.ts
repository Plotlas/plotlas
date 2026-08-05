// The admin surface container (catalogue ui/admin): dataset list (D-28 status
// chips, open/delete/add-layout) + the create wizard, behind tabs. Fetches via
// the injected ApiClient only; never imports renderer/* (module rule — the
// admin surface has no canvas). Server messages (409-while-running, 403, 503)
// render verbatim from the ApiError detail; a 401 bubbles to onAuthExpired so
// the shell reroutes to login (brief §1.3).
//
// Stateful container — composed into App, never imported by node tests (its
// presentational pieces are tested directly).
import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { DatasetSummary } from "../../api-client/types";
import { DatasetList } from "./DatasetList";
import { CreateDatasetWizard } from "./CreateDatasetWizard";
import { AddLayoutWizard } from "./AddLayoutWizard";
import { hasActiveJob } from "./datasetActivity.ts";
import { PlotlasMark } from "../PlotlasMark.ts";
import { ActivityPill } from "../activity/ActivityPill";
import { useActivityActions } from "../activity/activityContext";
import { collectionName } from "../../api-client/types";
import { errText } from "../../api-client/errText";

/** The horizontal brand lockup (board 3b): glyph + "Plotlas" wordmark, pinned to
 *  the left of a library-topbar. The wordmark is a plain span (not a heading) so
 *  the section h1 ("Library" / "Add layout") stays the surface's sole heading. */
function brandLockup(): ReactElement {
  return h(
    "div",
    { className: "brand-lockup" },
    h(PlotlasMark, { size: 18 }),
    h("span", { className: "brand-wordmark" }, "Plotlas"),
  );
}

export interface AdminScreenProps {
  client: ApiClient;
  /** The signed-in username, or `null` for an ANONYMOUS visitor (D-34 consumer): the
   *  library then renders READ-ONLY (public datasets only), hiding every owner/authed
   *  affordance and offering "Log in" instead of the username + "Log out". */
  username: string | null;
  onOpenDataset: (dsId: string) => void;
  onAuthExpired: () => void;
  onLogout: () => void;
  /** Anonymous public entry (D-34 consumer): open the auth screen from the read-only
   *  library's "Log in" affordance. Only invoked when `username` is null. */
  onLogin: () => void;
  /** Deep links (SCOPE_shareable-collections Part A): a message explaining why the app
   *  landed on the library instead of the collection a link asked for — an unknown id,
   *  or one this visitor may not read (the API returns the same 404 for both, so this
   *  wording must never imply the collection exists). `null` = nothing to say. */
  notice?: string | null;
}

function errStatus(err: unknown): number | null {
  if (typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

/** Refresh cadence for the list while there is active work. */
const LIST_REFRESH_MS = 5000;

/** Whether the Library list should keep auto-refreshing (R-14/R-26 + Seam O3 / T2-104):
 *  TRUE while any dataset is still processing (a first bake) OR a "ready" dataset has an
 *  active job re-baking it (`hasActiveJob`). The latter never satisfies
 *  status==="processing", so INCLUDING it is what keeps the ready-while-baking "updating"
 *  badge (and the newly-committed layout chips) live — the 5s re-list clears them when the
 *  server stops reporting the job, instead of the badge sticking until the user navigates
 *  away and back. The active-job test is shared with the DatasetList badge (see
 *  `hasActiveJob`) so the gate and the badge cannot drift. Pure + exported for unit tests. */
export function hasActiveWork(datasets: DatasetSummary[] | null): boolean {
  return datasets?.some((d) => d.status === "processing" || hasActiveJob(d)) ?? false;
}

export function AdminScreen(props: AdminScreenProps): ReactElement {
  const [tab, setTab] = useState<"list" | "create">("list");
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null); // null = first load pending
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // T2-92 Seam 1: the dataset whose full-screen add-layout wizard is open (null = none).
  // Set from the ⋯ menu; the AddLayoutWizard owns the roles + enqueue and takes over the
  // whole surface, like the create wizard.
  const [addLayoutTarget, setAddLayoutTarget] = useState<DatasetSummary | null>(null);

  const { client, onAuthExpired } = props;
  // Anonymous public entry (D-34 consumer): a null username is a visitor with no account.
  // The library then renders READ-ONLY — public datasets only, every owner/authed
  // affordance hidden (create, the card ⋯ menu, the activity pill/badge, logout).
  const readOnly = props.username === null;
  // Seam O3: adopt any active_job_id the list surfaces (the ready-while-baking
  // rediscovery), and let the Library "updating" badge open the activity panel. Read
  // the ACTION surface only (useActivityActions) — a stable object that never changes
  // identity — so neither `load` nor the whole Library re-renders on a poll tick.
  const { adopt: adoptJobs, open: openActivity } = useActivityActions();

  // Part D §2c: the activity panel holds only dataset IDS (the store must not depend on
  // the dataset list), so resolve names here — this screen already has the summaries.
  // An id the list does not carry falls back to itself, which is the honest answer.
  // Indexed once per list change (not a linear scan per call): the panel resolves a name
  // per job row on every poll tick while a bake runs.
  const datasetsById = useMemo(
    () => new Map((datasets ?? []).map((d) => [d.dataset_id, d])),
    [datasets],
  );
  const nameFor = useCallback(
    (dsId: string): string => {
      const ds = datasetsById.get(dsId);
      return ds !== undefined ? collectionName(ds) : dsId;
    },
    [datasetsById],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await client.listDatasets();
      setDatasets(list);
      // Anonymous visitors never track jobs — job adoption is an activity surface, and
      // the anonymous list is public-only (no jobs the visitor owns), so skip it.
      if (!readOnly) adoptJobs(list); // pick up any ready-with-active-job dataset's job
      setError(null);
    } catch (err) {
      // Anonymous browsing must NEVER trigger the session-expiry bounce (brief §3): a
      // visitor presented no token, so there is no session to expire. The client's
      // signalAuthExpiredIf401 already no-ops tokenless, but AdminScreen inspects the
      // status directly here — so guard it too. Anonymous `listDatasets` returns the
      // public list (200) per D-34; a defensive 401 surfaces as an error, not a bounce.
      if (errStatus(err) === 401 && !readOnly) {
        onAuthExpired();
        return;
      }
      setError(errText(err));
      setDatasets((prev) => prev ?? []);
    }
  }, [client, onAuthExpired, adoptJobs, readOnly]);

  useEffect(() => {
    if (tab === "list") void load();
  }, [tab, load]);

  // R-14/R-26 + Seam O3 (T2-104): re-list while there is active work — any dataset still
  // processing OR a "ready" dataset with an active re-bake (active_job_id). See
  // hasActiveWork for the ready-while-baking rationale.
  //
  // Termination contract: this loop stops ONLY when the server stops reporting the work —
  // a dataset leaves "processing" and its active_job_id clears at the job's terminal
  // state (the D-28 status + active_job_id are re-derived from RQ on each list read). No
  // client-side max-duration cap is imposed BY DESIGN: a legitimate re-bake can run for
  // many minutes and the list payload is stable between status transitions, so any
  // time-box or "stop when unchanged" heuristic would truncate the refresh mid-bake and
  // strand the badge — the very staleness R1 fixes. A worker that dies without clearing
  // active_job_id would leave the 5s poll running; that is the server's contract to honor
  // (owner-open job reads, api/routers/jobs.py), not something this gate should second-guess.
  const anyActive = hasActiveWork(datasets);
  useEffect(() => {
    if (tab !== "list" || !anyActive) return;
    const timer = setInterval(() => void load(), LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [tab, anyActive, load]);

  /** Run an owner action against `dsId` with the card busy, re-listing on success.
   *
   *  `rethrow` (Part D §3) lets a CALLER own the failure instead of the top-level
   *  banner. The card's details editor needs that: it must keep the typed values on
   *  screen and show the reason inline, which it cannot do if the rejection is
   *  swallowed here and the promise resolves as though the write had succeeded. The
   *  401 bounce stays global either way — a dead session is not a form-level problem. */
  async function withBusy(
    dsId: string,
    action: () => Promise<void>,
    rethrow = false,
  ): Promise<void> {
    setBusyId(dsId);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      if (errStatus(err) === 401) {
        onAuthExpired();
        return;
      }
      if (rethrow) throw err;
      setError(errText(err)); // e.g. the delete 409: "An ingest job ... is still running"
    } finally {
      setBusyId(null);
    }
  }

  // Library header: title + mono dataset count on the left; the accent
  // "+ New dataset" CTA on the right REPLACES the old tabs — creating a dataset
  // routes to the wizard rather than being a tab (brief §2, board 1f). While the
  // wizard is open the CTA becomes a "← Library" back affordance.
  const count = datasets?.length ?? 0;
  const header = h(
    "header",
    { className: "library-topbar" },
    brandLockup(),
    h(
      "div",
      { className: "library-heading" },
      h("h1", { className: "library-title" }, tab === "list" ? "Library" : "New dataset"),
      tab === "list"
        ? h("span", { className: "library-count" }, `${count} dataset${count === 1 ? "" : "s"}`)
        : null,
    ),
    // Anonymous public entry (D-34 consumer): a read-only visitor sees only a "Log in"
    // affordance here — the activity pill, "+ New dataset", username, and "Log out" are
    // all authenticated-only and hidden. Authenticated: today's chrome, unchanged.
    readOnly
      ? h(
          "div",
          { className: "library-topbar-actions" },
          h("button", { type: "button", className: "btn pri", onClick: props.onLogin }, "Log in"),
        )
      : h(
          "div",
          { className: "library-topbar-actions" },
          h(ActivityPill, { nameFor }), // Seam O3: always-visible job indicator
          tab === "list"
            ? h(
                "button",
                { type: "button", className: "btn pri", onClick: () => setTab("create") },
                "+ New dataset",
              )
            : h(
                "button",
                { type: "button", className: "btn ghost", onClick: () => setTab("list") },
                "← Library",
              ),
          h("span", { className: "muted library-user" }, props.username),
          h("button", { type: "button", className: "link-btn", onClick: props.onLogout }, "Log out"),
        ),
  );

  // T2-92 Seam 1: the full-screen add-layout wizard takes over the whole surface for the
  // chosen dataset (like the create wizard), with its own back-to-Library header.
  if (addLayoutTarget !== null) {
    const leave = (): void => {
      setAddLayoutTarget(null);
      void load(); // refresh statuses / layout chips after an enqueue
    };
    return h(
      "div",
      { className: "admin-screen" },
      h(
        "header",
        { className: "library-topbar" },
        brandLockup(),
        h(
          "div",
          { className: "library-heading" },
          h("h1", { className: "library-title" }, "Add layout"),
          // Part D §2c: the name, with the id as the tooltip so it stays discoverable.
          h(
            "span",
            { className: "muted", title: addLayoutTarget.dataset_id },
            collectionName(addLayoutTarget),
          ),
        ),
        h(
          "div",
          { className: "library-topbar-actions" },
          h(ActivityPill, { nameFor }), // Seam O3: the indicator persists on the add-layout surface too
          h("button", { type: "button", className: "btn ghost", onClick: leave }, "← Library"),
          h("span", { className: "muted library-user" }, props.username),
          h("button", { type: "button", className: "link-btn", onClick: props.onLogout }, "Log out"),
        ),
      ),
      error !== null ? h("p", { className: "error-text error-banner", role: "alert" }, error) : null,
      h(AddLayoutWizard, { client, dataset: addLayoutTarget, onDone: leave, onAuthExpired }),
    );
  }

  return h(
    "div",
    { className: "admin-screen" },
    header,
    error !== null ? h("p", { className: "error-text error-banner", role: "alert" }, error) : null,
    // Deep links (scope Part A): why we are on the library rather than the collection the
    // link named. `status`, not `alert` — this is an explanation, not a failure the
    // visitor caused, and it must not steal focus from the library they can still browse.
    props.notice != null && props.notice !== ""
      ? h("p", { className: "muted error-banner", role: "status" }, props.notice)
      : null,
    tab === "list"
      ? datasets === null
        ? h("p", { className: "muted" }, "Loading datasets…")
        : h(DatasetList, {
            datasets,
            client, // T2-55: DatasetList fetches each ready card's cover thumbnail
            busyId,
            onOpen: props.onOpenDataset,
            onDelete: (dsId: string) => void withBusy(dsId, () => client.deleteDataset(dsId)),
            // Part B: rename/credit in place from the card's ⋯ menu. `null` clears a field.
            // Merge the PATCH RESPONSE (the server's stored, trimmed values) into the card
            // right away, so a write that committed is never shown as failed just because
            // the follow-up re-list blips — load()'s own error goes to the top banner and
            // would otherwise leave the OLD name on the card. withBusy still re-lists (and
            // it's idempotent), but the card no longer depends on it succeeding.
            // Part D §3: RETURNS the promise so the editor stays open until the write
            // resolves (and shows its error inline on failure) instead of closing
            // optimistically and discarding what was typed.
            onRename: (dsId: string, edits) =>
              withBusy(
                dsId,
                async () => {
                  const updated = await client.setDatasetPresentation(dsId, edits);
                  setDatasets((prev) =>
                    prev?.map((d) =>
                      d.dataset_id === dsId
                        ? {
                            ...d,
                            display_name: updated.display_name ?? null,
                            attribution: updated.attribution ?? null,
                            attribution_url: updated.attribution_url ?? null,
                          }
                        : d,
                    ) ?? prev,
                  );
                },
                true, // §3: the editor owns this failure, not the top-level banner
              ),
            // T2-92 Seam 1: open the full-screen add-layout wizard for this dataset
            // (roles pre-filled from the manifest; the wizard owns the enqueue). Replaces
            // the old inline type-checkbox picker.
            onAddLayout: (dsId: string) =>
              setAddLayoutTarget(datasets.find((d) => d.dataset_id === dsId) ?? null),
            onNewDataset: () => setTab("create"),
            // Seam O3: the ready-with-active-job "updating" badge opens the panel — an
            // activity surface, so it (and readOnly's card chrome) is gated for anonymous.
            onOpenActivity: readOnly ? undefined : openActivity,
            // Anonymous public entry (D-34 consumer): read-only cards + anonymous empty
            // state (with the log-in affordance).
            readOnly,
            onLogin: props.onLogin,
          })
      : h(CreateDatasetWizard, {
          client,
          onDone: () => {
            setTab("list");
            void load();
          },
          onAuthExpired,
        }),
  );
}
