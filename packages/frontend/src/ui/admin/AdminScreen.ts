// The admin surface container (catalogue ui/admin): dataset list (D-28 status
// chips, Open + Edit) + the create wizard, behind tabs. Fetches via the injected
// ApiClient only; never imports renderer/* (module rule — the admin surface has no
// canvas). Server messages (409-while-running, 403, 503) render verbatim from the
// ApiError detail; a 401 bubbles to onAuthExpired so the shell reroutes to login
// (brief §1.3).
//
// Seam L3 (D-xxiv): the card's ⋯ menu is gone, and with it this screen's delete,
// rename and full-surface add-layout paths. All three live in the layout designer —
// a ROUTE (`?edit=<id>`) that App owns, because state held here does not survive a
// reload.
//
// Stateful container — composed into App, never imported by node tests (its
// presentational pieces are tested directly).
import { createElement as h, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { DatasetSummary } from "../../api-client/types";
import { DatasetList } from "./DatasetList";
import { CreateDatasetWizard } from "./CreateDatasetWizard";
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
  /** Open a collection the signed-in user owns in the layout designer (seam L3). */
  onEditDataset: (dsId: string) => void;
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

  const { client, onAuthExpired } = props;
  // Anonymous public entry (D-34 consumer): a null username is a visitor with no account.
  // The library then renders READ-ONLY — public datasets only, every owner/authed
  // affordance hidden (create, the card's Edit, the activity pill/badge, logout).
  const readOnly = props.username === null;
  // Seam O3: adopt any active_job_id the list surfaces (the ready-while-baking
  // rediscovery), and let the Library "updating" badge open the activity panel. Read
  // the ACTION surface only (useActivityActions) — a stable object that never changes
  // identity — so neither `load` nor the whole Library re-renders on a poll tick.
  const { adopt: adoptJobs, open: openActivity } = useActivityActions();

  // Part D §2c: the activity panel holds only dataset IDS (the store must not depend on
  // the dataset list), so resolve names here — this screen already has the summaries.
  // An id the list does not carry — a collection created a moment ago, before the next
  // re-list — still goes through `collectionName`, so a MINTED id reads "Untitled
  // collection" rather than twelve hex characters (D-xxviii), and an authored one reads
  // as itself, which is the honest answer.
  // Indexed once per list change (not a linear scan per call): the panel resolves a name
  // per job row on every poll tick while a bake runs.
  const datasetsById = useMemo(
    () => new Map((datasets ?? []).map((d) => [d.dataset_id, d])),
    [datasets],
  );
  const nameFor = useCallback(
    (dsId: string): string => {
      const ds = datasetsById.get(dsId);
      return collectionName(ds ?? { dataset_id: dsId });
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
            onOpen: props.onOpenDataset,
            // D-xxiv: Edit opens the designer, which holds everything the ⋯ menu did.
            // Offered on the signed-in user's own cards only.
            onEdit: props.onEditDataset,
            username: props.username,
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
