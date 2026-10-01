// The layout designer's SHELL (seam L3 §2b.2; LAYOUT_DESIGNER D-xix; boards `Main`,
// `MobileData`, `MobileLayouts`): one designer, three views, one bar.
//
// It owns everything the three views share, so none of them re-fetches or keeps a second
// copy of it: the collection (owner-verified before anything renders), the committed
// manifest, the layout list (with the in-flight rows), the presentation record, the
// column list, and the PENDING-CHANGE MODEL with its persistence. It hands each view the
// §0a props (./contract.ts; docs/design/layout-designer/CONTRACT.md) and draws the chrome
// and the commit bar around it. The bar is here, not in a view, so that switching tab can
// never quietly abandon a pending change.
//
// Stateful container, like AdminScreen — its pieces (CommitBar, Overview, pending.ts) are
// tested directly, and the whole is DOM-tested against a fake client.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { ColumnListResponse, DatasetSummary, LayoutInfo } from "../../api-client/types";
import { collectionName } from "../../api-client/types";
import { errText } from "../../api-client/errText";
import type { Presentation } from "../../generated/presentation";
import type { LayoutManifest } from "../../renderer/layout";
import { PlotlasMark } from "../PlotlasMark.ts";
import { layoutsWithLabels } from "../presentation";
import { mayOpenDesigner } from "../urlState";
import type { DesignerTab } from "../urlState";
import { CommitBar } from "./CommitBar";
import type { DesignerViewProps } from "./contract";
import { DataView } from "./data";
import { CommitReview, JobFollower, LayoutsView } from "./layouts";
import { Overview } from "./Overview";
import { clearPending, derivePending, discardPending, loadPending, savePending, seedPending } from "./pending";
import type { PendingState } from "./pending";

export interface DesignerScreenProps {
  client: ApiClient;
  datasetId: string;
  tab: DesignerTab;
  /** The signed-in user; the designer opens for the collection's owner only. */
  username: string | null;
  onNavigate: (tab: DesignerTab) => void;
  /** Back to the library. */
  onBack: () => void;
  /** Open this collection in the viewer. */
  onOpenAtlas: () => void;
  /** The collection cannot be opened here — not found, or not this user's. The caller
   *  routes through `routeForUnavailable`, whose wording discloses nothing. */
  onUnavailable: (datasetId: string) => void;
  /** The collection was deleted from Overview. */
  onDeleted: (name: string) => void;
  onAuthExpired: () => void;
  /** The in-flight poll's cadence. Production leaves it unset (IN_FLIGHT_REFRESH_MS);
   *  the DOM tests shorten it so a version bump lands in milliseconds, not seconds. */
  refreshMs?: number;
}

/** Re-read cadence while a layout is queued or baking — the same cadence the library's
 *  list refresh uses (AdminScreen LIST_REFRESH_MS), so a state pill here is never staler
 *  than the card it came from. */
const IN_FLIGHT_REFRESH_MS = 5000;

interface Loaded {
  dataset: DatasetSummary;
  layouts: LayoutInfo[];
  manifest: LayoutManifest;
  presentation: Presentation;
  columns: ColumnListResponse | null;
  columnsError: string | null;
}

function errStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function inFlight(layouts: LayoutInfo[]): number {
  return layouts.filter((l) => (l.state ?? "live") !== "live" || l.rebake != null).length;
}

const TABS: { tab: DesignerTab; label: string }[] = [
  { tab: "overview", label: "Overview" },
  { tab: "data", label: "Data" },
  { tab: "layouts", label: "Layouts" },
];

export function DesignerScreen(props: DesignerScreenProps): ReactElement {
  const { client, datasetId, username } = props;
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingState | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // The routing callbacks, read through a ref: App recreates them on every render, and a
  // load keyed on their identity would re-fetch everything on every tab switch.
  const route = useRef(props);
  route.current = props;
  const onAuthExpired = useCallback(() => route.current.onAuthExpired(), []);
  const onUnavailable = useCallback((id: string) => route.current.onUnavailable(id), []);

  // LOADS ARE SEQUENCED (review of #368, finding 2). Several can be in flight at once — a
  // view's `reload()`, the error banner's Retry, a poll tick that saw the version move —
  // and they finish in whatever order the network decides. Only the LATEST-STARTED one may
  // write state; an older one finishing late must not overwrite a newer result, least of
  // all the manifest the pending draft is based on. `loadSeq` numbers every call;
  // `loading` says one is in flight, so the poll does not start a second.
  const loadSeq = useRef(0);
  const loading = useRef(false);

  /** Read everything the views need. A draft whose base moved is dropped on the way
   *  (loadPending). The owner check runs BEFORE any other read, so a non-owner's link
   *  fetches nothing it is then told it cannot see. */
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    loading.current = true;
    // Still the call whose result should land? False once unmounted or superseded.
    const current = (): boolean => live.current && seq === loadSeq.current;
    try {
      const dataset = await client.getDataset(datasetId);
      if (!current()) return;
      if (!mayOpenDesigner(dataset.owner, username)) {
        onUnavailable(datasetId);
        return;
      }
      if (dataset.status !== "ready") {
        // The first-ingest entry has no backend yet (gap 7), so a collection with no
        // committed bake has nothing for the designer to hold.
        setLoadError("This collection has no baked layout yet. The designer opens once its first bake finishes.");
        return;
      }
      const [layouts, presentation, columns] = await Promise.all([
        client.listLayouts(datasetId, { includePending: true }),
        client.getPresentation(datasetId),
        client.listColumns(datasetId).then(
          (c): { ok: ColumnListResponse } | { err: unknown } => ({ ok: c }),
          (err: unknown) => ({ err }),
        ),
      ]);
      if (!current()) return;
      const firstLive = layouts.find((l) => (l.state ?? "live") === "live")?.layout_id ?? dataset.layout_ids[0];
      if (firstLive === undefined) {
        setLoadError("This collection has no baked layout to read its roles from.");
        return;
      }
      const manifest = await client.getManifest(datasetId, firstLive);
      if (!current()) return;
      if ("err" in columns && errStatus(columns.err) === 401) {
        onAuthExpired();
        return;
      }
      setData({
        dataset,
        layouts,
        manifest,
        presentation,
        columns: "ok" in columns ? columns.ok : null,
        columnsError: "err" in columns ? errText(columns.err) : null,
      });
      setPending(
        loadPending(datasetId, manifest.dataset_version, seedPending(manifest.column_roles, presentation.columns)),
      );
      setLoadError(null);
    } catch (err) {
      if (!current()) return;
      const status = errStatus(err);
      if (status === 401) onAuthExpired();
      else if (status === 404 || status === 403) onUnavailable(datasetId);
      else setLoadError(errText(err));
    } finally {
      if (seq === loadSeq.current) loading.current = false;
    }
  }, [client, datasetId, username, onUnavailable, onAuthExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  // While anything is queued or baking, keep the layout list (and the summary's version)
  // current. A version bump means a bake committed: re-read everything, which also drops
  // a draft drafted against the old base.
  const busy = data !== null && (inFlight(data.layouts) > 0 || data.dataset.active_job_id != null);
  const shownVersion = data?.dataset.dataset_version ?? null;
  const refreshMs = props.refreshMs ?? IN_FLIGHT_REFRESH_MS;
  useEffect(() => {
    if (!busy || shownVersion === null) return;
    const version = shownVersion;
    const timer = setInterval(() => {
      // A full load is already running (started by an earlier tick, a view's reload, or
      // Retry): this tick has nothing to add. `version` only moves when that load lands,
      // so without this every tick until then started ANOTHER load of the same data.
      if (loading.current) return;
      // The tick's own write is sequenced against full loads too (follow-up review of
      // #368). `loading` alone is not enough: a load that started AND finished while this
      // tick was on the wire leaves it false again, and the tick would then write a
      // dataset and layout list read BEFORE that load — wiping, say, the queued row an
      // Add-layouts reload had just brought in. Any load started since means this read is
      // stale, so it is dropped.
      const seqAtStart = loadSeq.current;
      void (async () => {
        try {
          const [dataset, layouts] = await Promise.all([
            client.getDataset(datasetId),
            client.listLayouts(datasetId, { includePending: true }),
          ]);
          if (!live.current || loading.current || loadSeq.current !== seqAtStart) return;
          if (dataset.dataset_version !== version) {
            void load();
            return;
          }
          setData((prev) => (prev === null ? prev : { ...prev, dataset, layouts }));
        } catch (err) {
          if (errStatus(err) === 401) onAuthExpired();
          // Anything else: keep what is on screen and try again next tick.
        }
      })();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [busy, shownVersion, refreshMs, client, datasetId, load, onAuthExpired]);

  const layouts = useMemo(
    () => (data === null ? [] : layoutsWithLabels(data.layouts, data.presentation.layouts)),
    [data],
  );
  const derived = useMemo(
    () => (pending === null ? null : derivePending(pending, layouts)),
    [pending, layouts],
  );

  const version = data?.manifest.dataset_version ?? 0;
  const onPendingChange = useCallback(
    (next: PendingState): void => {
      setPending(next);
      savePending(datasetId, version, next);
    },
    [datasetId, version],
  );

  if (data === null || pending === null || derived === null) {
    return h(
      "div",
      { className: "designer-screen" },
      h(
        "div",
        { className: "designer-loading" },
        loadError !== null
          ? h("p", { className: "error-text", role: "alert" }, loadError)
          : h("p", { className: "muted" }, "Loading the designer…"),
        h("button", { type: "button", className: "btn ghost", onClick: props.onBack }, "← Library"),
      ),
    );
  }

  const name = collectionName(data.dataset);
  const viewProps: DesignerViewProps = {
    client,
    dataset: data.dataset,
    manifest: data.manifest,
    layouts,
    presentation: data.presentation,
    columns: data.columns,
    columnsError: data.columnsError,
    pending,
    derived,
    onPendingChange,
    onPresentationChange: (next) => setData((prev) => (prev === null ? prev : { ...prev, presentation: typeof next === "function" ? next(prev.presentation) : next })),
    onDatasetChange: (next) => setData((prev) => (prev === null ? prev : { ...prev, dataset: next })),
    reload: () => void load(),
    onNavigate: props.onNavigate,
    onAuthExpired,
  };

  const baking = data.layouts.filter((l) => l.state === "baking" || l.rebake === "baking").length;
  const queued = inFlight(data.layouts) - baking;
  const header = h(
    "header",
    { className: "designer-topbar" },
    h(
      "button",
      { type: "button", className: "btn ghost designer-back", "aria-label": "Back to the library", onClick: props.onBack },
      "‹",
    ),
    h("div", { className: "brand-lockup designer-brand" }, h(PlotlasMark, { size: 18 }), h("span", { className: "brand-wordmark" }, "Plotlas")),
    h(
      "div",
      { className: "designer-title" },
      h("span", { className: "designer-kicker designer-title-kicker" }, "Layout designer"),
      h(
        "nav",
        { className: "designer-crumbs", "aria-label": "Breadcrumb" },
        h("button", { type: "button", className: "link-btn designer-crumb-library", onClick: props.onBack }, "Library"),
        h("span", { className: "designer-crumb-sep", "aria-hidden": "true" }, "›"),
        h("span", { className: "designer-crumb-name", "aria-current": "page" }, name),
      ),
    ),
    h(
      "div",
      { className: "designer-topbar-actions" },
      baking > 0
        ? h("span", { className: "pill proc designer-inflight" }, `${baking} baking`)
        : queued > 0
          ? h("span", { className: "pill designer-pill-quiet designer-inflight" }, `${queued} queued`)
          : null,
      h("span", { className: "designer-owner-pill" }, "owner only"),
      username !== null ? h("span", { className: "muted designer-user" }, username) : null,
      h("button", { type: "button", className: "btn", onClick: props.onOpenAtlas }, "Open atlas"),
    ),
  );

  const columnCount = data.columns !== null ? data.columns.columns.length : null;
  const staleCount = new Set([...derived.outcomes.filter((o) => o.stale).map((o) => o.layout_id), ...derived.baked.filter((b) => b.staleColumns.length > 0).map((b) => b.layout_id)]).size;
  const tabs = h(
    "div",
    { className: "designer-tabbar" },
    h(
      "div",
      { className: "seg designer-tabs", role: "tablist", "aria-label": "Designer views" },
      TABS.map(({ tab, label }) => {
        const count = tab === "data" ? columnCount : tab === "layouts" ? layouts.length : null;
        const badge =
          tab === "data" && derived.changedColumns.length > 0
            ? `${derived.changedColumns.length} changed`
            : tab === "layouts" && staleCount > 0
              ? `${staleCount} stale`
              : null;
        return h(
          "button",
          {
            key: tab,
            type: "button",
            role: "tab",
            "aria-selected": props.tab === tab,
            className: props.tab === tab ? "on designer-tab" : "designer-tab",
            onClick: () => props.onNavigate(tab),
          },
          label,
          count !== null ? h("span", { className: "designer-tab-count" }, String(count)) : null,
          badge !== null ? h("span", { className: "designer-tab-badge" }, badge) : null,
        );
      }),
    ),
    h(
      "p",
      { className: "designer-meta" },
      `${data.dataset.image_count.toLocaleString("en-US")} images · v${data.dataset.dataset_version} · ${
        data.manifest.dataset_metadata.source ?? "images only"
      }`,
    ),
  );

  const view =
    props.tab === "data"
      ? h(DataView, viewProps)
      : props.tab === "layouts"
        ? h(LayoutsView, viewProps)
        : h(Overview, {
            ...viewProps,
            onDeleted: () => {
              clearPending(datasetId);
              props.onDeleted(name);
            },
          });

  // A RELOAD that failed after the designer had loaded (review of #368, finding 3). The
  // screen keeps showing the last good data — it is still true as of when it was read — but
  // the user must be told it may be out of date, e.g. an Add-layouts enqueue that succeeded
  // while the refresh after it did not. Cleared by the next successful load.
  const reloadBanner =
    loadError !== null
      ? h(
          "div",
          { className: "designer-reload-error", role: "alert" },
          h("span", null, `Couldn't refresh this collection — ${loadError}. What you see may be out of date.`),
          h("button", { type: "button", className: "btn", onClick: () => void load() }, "Retry"),
        )
      : null;

  return h(
    "div",
    { className: "designer-screen" },
    header,
    tabs,
    reloadBanner,
    h(JobFollower, viewProps),
    h("main", { className: "designer-body" }, view),
    h(CommitBar, {
      derived,
      onDiscard: () => onPendingChange(discardPending(pending)),
      onReview: CommitReview !== null ? () => setReviewing(true) : null,
    }),
    reviewing && CommitReview !== null ? h(CommitReview, { ...viewProps, onClose: () => setReviewing(false) }) : null,
  );
}
