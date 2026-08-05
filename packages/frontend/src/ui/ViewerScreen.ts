// The viewer: canvas + renderer stack + the three catalogued components +
// the selection summary. App mounts this KEYED ON datasetId (D-31): switching
// datasets unmounts this component, whose cleanup disposes the whole stack —
// world.dispose() is what releases the lifetime camera subscriptions the
// tile-pyramid loader / LayoutController hold by design. Nothing here ever
// recreates the loader / LayoutController against a surviving World.
//
// Composition is exactly the catalogued factories: createWorld → createCells →
// createTilePyramid → createLayoutController; all data flows through the
// injected ApiClient (URLs only via its helpers).
//
// Stateful container — composed into App. Not imported by the NODE tier (it pulls
// THREE in); that tier tests the pieces directly, and this file's flow is the §4.5
// viewer flow test over the same pure handlers.
//
// It DOES mount in the JSDOM tier, contrary to what this header claimed until UI-S1.
// Measured 2026-07-31: createWorld throws without a WebGL context, the mount effect's
// own .catch turns that into the error banner, and the entire React shell renders —
// so tests/dom/viewer_panels.dom.test.ts drives the real component rather than a
// harness. The one interaction that mount cannot reach is SELECTING a cell:
// handleCanvasClick returns early while stackRef.current is null.
import { createElement as h, useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Table } from "apache-arrow";
import { createWorld, fitCamera, fitZoom } from "../renderer/world";
import type { Viewport, WorldHandle } from "../renderer/world";
import { createCells } from "../renderer/cells";
import type { Cells } from "../renderer/cells";
import { createTilePyramid } from "../renderer/tilePyramid";
import type { TilePyramid } from "../renderer/tilePyramid";
import { createLayoutController, shouldAutoFit } from "../renderer/layout";
import type { LayoutController, LayoutManifest, TagRenderState, TagSelection } from "../renderer/layout";
import { createViewerStatus } from "../renderer/viewerStatus";
import type { ViewerStatusHandle, RendererStatus } from "../renderer/viewerStatus";
import type { MinimapOverview } from "./Minimap";
import { METADATA_MAX_IDS } from "../api-client/client";
import type { ApiClient } from "../api-client/client";
import type { LayoutInfo, MetadataRow } from "../api-client/types";
import { collectionName } from "../api-client/types";
import { attributionCredit } from "./attributionCredit";
import { applyDocumentTitle } from "./documentTitle";
import { LayoutSwitcher } from "./LayoutSwitcher";
import { describeBakedOptions } from "./layoutOptions";
import { TagControls, TagTableContext } from "./TagControls";
import { MetadataPanel, MetadataPanelDataContext } from "./MetadataPanel";
import type { CellPreviewData } from "./MetadataPanel";
import { SelectionSummary } from "./SelectionSummary";
import {
  SearchResults,
  searchReducer,
  searchKeydown,
  unionBBoxFromRects,
  bandSnapBBox,
  initialSearchState,
} from "./SearchResults";
import type { SearchRow } from "./SearchResults";
import { DebugOverlay } from "./DebugOverlay";
import { publishCameraDrive, vizDebugAvailable } from "../renderer/debug.ts";
import { createPreviewCache, fetchCellPreview } from "./cellPreview";
import type { CellPreviewFetch } from "./cellPreview";
import { StatusBar } from "./StatusBar";
import type { TagStatusView, ViewerStatus } from "./StatusBar";
import { Minimap } from "./Minimap";
import { Lightbox, runLocate } from "./Lightbox";
import { PlotlasMark } from "./PlotlasMark";
import { ActivityPill } from "./activity/ActivityPill";

export interface ViewerScreenProps {
  datasetId: string;
  client: ApiClient;
  onBack: () => void;
  onAuthExpired: () => void;
  /** Deep links (SCOPE_shareable-collections Part A): the dataset could not be OPENED at
   *  all — the boot load 404'd. The API returns the same 404 for "no such dataset" and
   *  "private, not yours", so the caller decides where to land the visitor; this only
   *  reports that the collection is not viewable by them.
   *
   *  Scoped to BOOT failures on purpose. A transient error later in a session still
   *  shows the in-viewer banner — ejecting someone to the library mid-browse because one
   *  request blipped would be worse than the banner. Optional so existing mounts (and
   *  the DOM tests) are unaffected. */
  onUnavailable?: (datasetId: string) => void;
  // Open the full-resolution lightbox for a cell (brief §2): threaded to the
  // inspector's "View ⤢" button. The lightbox seam consumes this later; a
  // no-op / undefined consumer is fine for this seam.
  onViewFull?: (cellId: number) => void;
}

interface RendererStack {
  world: WorldHandle;
  cells: Cells;
  pyramid: TilePyramid;
  controller: LayoutController;
  status: ViewerStatusHandle;
}

/** A human-scaled zoom read-out for the status bar (T2-54): how many times more
 *  zoomed-IN than the whole-world fit the camera is (fit = 1×). The renderer's raw
 *  `zoom` is world units per screen px (smaller = more zoomed-in), which is not a
 *  friendly number; `fitZoom / zoom` turns it into a "×" factor. Rounds to 1 decimal
 *  under 10×, whole numbers above. Returns null when zoom/holder are unavailable. */
function zoomFactor(zoom: number | null, holder: HTMLElement | null): number | null {
  if (zoom === null || zoom <= 0 || holder === null) return null;
  const fit = fitZoom({
    width: Math.max(1, holder.clientWidth),
    height: Math.max(1, holder.clientHeight),
    devicePixelRatio: 1,
  });
  const factor = fit / zoom;
  return factor >= 10 ? Math.round(factor) : Math.round(factor * 10) / 10;
}

/** The world rect of the current camera view (mirrors renderer BBox). Small helper so
 *  the minimap's viewport box + the D-B in-view read use one derivation. */
function viewRectOf(world: WorldHandle): { xMin: number; yMin: number; xMax: number; yMax: number } {
  const s = world.getCameraState();
  const v = world.getViewport();
  const halfW = (v.width / 2) * s.zoom;
  const halfH = (v.height / 2) * s.zoom;
  return { xMin: s.center[0] - halfW, xMax: s.center[0] + halfW, yMin: s.center[1] - halfH, yMax: s.center[1] + halfH };
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

function measure(el: HTMLElement): Viewport {
  return {
    width: Math.max(1, el.clientWidth),
    height: Math.max(1, el.clientHeight),
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  };
}

// Search (T2-57). The debounce for the tier-0 keystroke search — long enough that a
// fast typist fires one request, short enough to feel live (spike §3.5 ~150ms). The
// tier-2 catch-all runs immediately on Enter (no debounce). The listbox/option ids
// wire the top-bar combobox input's aria-activedescendant to the results listbox,
// which since UI-S1 lives in the search DROPDOWN under the input — no longer in the
// Inspector. The wiring is by IDREF, so the move is position-independent: what it
// does depend on is that the ids RESOLVE, i.e. that aria-expanded /
// aria-activedescendant are only asserted while the listbox is actually rendered
// (see `searchListboxShown` below — a dropdown the user hid is not "expanded", and
// an activedescendant naming an unrendered option is a silent screen-reader break).
const SEARCH_DEBOUNCE_MS = 180;
const SEARCH_LISTBOX_ID = "search-results-listbox";
function searchOptionId(index: number): string {
  return `search-option-${index}`;
}

/** Re-open a collapsed panel on EVERY new selection (UI-S1). Keyed on the selection
 *  IDENTITY — each selection path hands `setSelectedIds` a freshly-built array, so a
 *  re-click of the same cell still re-fires — and deliberately NOT latched behind a
 *  "have we revealed yet" flag: the operator's reported bug was precisely a reveal
 *  that worked once ("it opened the first time, then I hid it, then clicking did
 *  nothing"). An EMPTY selection never reveals, so a background click that clears the
 *  selection does not force the Inspector open.
 *
 *  Exported as a hook rather than inlined because this is the one link a jsdom mount
 *  cannot drive: ViewerScreen mounts fine headless, but `handleCanvasClick` returns
 *  early while the renderer stack is null (no WebGL), so no test can produce a
 *  canvas-click selection. Extracting the rule makes it directly pinnable — the same
 *  move `bandSnapBBox` (T2-136) and `runLocate` (T2-71) made for their own
 *  jsdom-unreachable wiring steps. `setCollapsed` must be a STABLE setter (a
 *  `useState` setter is); an inline closure would re-fire this every render. */
export function useRevealOnSelection(
  selectedIds: number[],
  setCollapsed: (collapsed: boolean) => void,
): void {
  useEffect(() => {
    if (selectedIds.length === 0) return;
    setCollapsed(false);
  }, [selectedIds, setCollapsed]);
}

export function ViewerScreen(props: ViewerScreenProps): ReactElement {
  const { datasetId, client } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const stackRef = useRef<RendererStack | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  // Bounded LRU cache of resolved previews (each owns a revocable object URL, so
  // eviction / replace / clear revoke it — see createPreviewCache). Failures are
  // NOT cached, so a transient fetch error retries on the next click.
  const previewCacheRef = useRef(createPreviewCache());
  // Latest preview-requested cell: an earlier click's slow resolution must not
  // overwrite the preview of the cell selected after it.
  const previewRequestRef = useRef<number | null>(null);
  // False once this viewer has torn down (a keyed remount on dataset switch): an
  // in-flight preview fetch must not setState / mint an object URL after unmount.
  const mountedRef = useRef(true);
  // Monotonic ticket for summary fetches: only the latest request's response
  // (or error) may land — concurrent getMetadata calls can resolve out of order.
  const summarySeqRef = useRef(0);
  // Unsubscribe from the renderer status observable (set at stack build, called on
  // unmount and before rebuilding).
  const statusUnsubRef = useRef<(() => void) | null>(null);
  // Signature of the last minimap overview snapshot pushed to state, so refreshOverview
  // only setState when the resident coarse-tile set actually changes (not every poll).
  const overviewSigRef = useRef<string>("");

  const [layouts, setLayouts] = useState<LayoutInfo[]>([]);
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<LayoutManifest | null>(null);
  const [tagsTable, setTagsTable] = useState<Table | null>(null);
  const [tagSelection, setTagSelection] = useState<TagSelection>({ selected: [], mode: "or" });
  // T2-120 (Fix B/C): the renderer-side tag state (availability + honest match count),
  // pushed by the controller's setTagStateListener (async load/retry) and captured from
  // applyTags' return (sync). Drives the status-bar count + the TagControls retry.
  const [tagState, setTagState] = useState<TagRenderState | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [summaryRows, setSummaryRows] = useState<MetadataRow[]>([]);
  const [preview, setPreview] = useState<CellPreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Part B presentation, from app-state via GET /api/datasets/{id} — NOT the manifest,
  // so renaming or crediting a collection never needs a re-bake. Fetched alongside the
  // boot load and deliberately NON-FATAL: a failure here leaves the title as the id and
  // the credit hidden, which is exactly the un-named state. Chrome must never be able to
  // stop a collection from rendering.
  // Part D §2c: name the browser TAB after the collection. Owned here rather than in
  // App because this is where the resolved name lives, and ViewerScreen is keyed on
  // datasetId (D-31) so leaving the viewer unmounts it — the cleanup restores the app
  // title with no second component racing to set it. Only matters because Part A made
  // links shareable: a bookmarked ?d= tab used to read "Plotlas" and say nothing.
  const [presentation, setPresentation] = useState<{
    display_name?: string | null;
    attribution?: string | null;
    attribution_url?: string | null;
  } | null>(null);

  // Name the tab after the collection, restoring the app title when the viewer
  // unmounts. Runs on the RESOLVED name, so an unnamed collection shows its id here
  // exactly as it does everywhere else — one fallback rule, not two.
  const tabName = collectionName({
    dataset_id: datasetId,
    display_name: presentation?.display_name,
  });
  useEffect(() => {
    applyDocumentTitle(tabName);
    return () => applyDocumentTitle(null);
  }, [tabName]);

  // Part D §2c: name the viewer's own activity jobs after the collection — the panel
  // otherwise labels them by raw id, inconsistent with the library, which threads the
  // same resolver. ViewerScreen only knows THIS dataset's name, so a job for another
  // (adopted) dataset falls back to its id — the one fallback rule, as everywhere.
  const activityNameFor = useCallback(
    (dsId: string): string =>
      dsId === datasetId
        ? collectionName({ dataset_id: datasetId, display_name: presentation?.display_name })
        : dsId,
    [datasetId, presentation?.display_name],
  );

  // Live renderer status (T2-54): the ViewerStatus observable pushes zoom / in-view /
  // fps / loading-tile / cursor-cell here (coalesced to ~one update per frame by the
  // observable). null until the stack + first emit exist.
  const [rendererStatus, setRendererStatus] = useState<RendererStatus | null>(null);
  // Minimap overview imagery (T2-54): the resident coarse mosaic tiles + the layout
  // bbox, refreshed on layout activation and as coarse tiles bind. null ⇒ neutral
  // field (the minimap still shows the viewport box). Plus the live view rect for the
  // viewport box, updated with the renderer status.
  const [minimapOverview, setMinimapOverview] = useState<MinimapOverview | null>(null);
  const [minimapView, setMinimapView] = useState<{ xMin: number; yMin: number; xMax: number; yMax: number } | null>(null);
  // Dev-only renderer debug overlay, toggled with the backtick (`) key. The
  // whole surface is gated on vizDebugAvailable so a prod build neither binds the
  // key nor mounts the overlay for end users (renderer/debug.ts).
  const [showDebug, setShowDebug] = useState(false);
  // Collapse state for the two floating rails (component state only per the
  // brief — not persisted): collapsed to a 36px chevron button.
  const [tagsCollapsed, setTagsCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  // UI-S1: the search dropdown's OWN collapse state. Before this seam one flag
  // (inspectorCollapsed) governed both, because the results list was a third BODY of
  // the Inspector — hiding the Inspector hid the results and vice versa. They are now
  // two panels with two states, so each hides and shows without disturbing the other.
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  // Lightbox (T2-25) overlay state, hoisted here: `null` closed, else the index
  // into the CURRENT selection (selectedIds) of the cell on show. The overlay
  // renders inline in this component's tree, so opening/closing never unmounts the
  // renderer stack — camera + selection survive close. Only the index is stored;
  // `cellIds` is read from `selectedIds` at render so it tracks the live selection.
  const [lightbox, setLightbox] = useState<{ index: number } | null>(null);
  // Search (T2-57). `searchQuery` is the controlled input value; `searchState` (a
  // reducer) is the results-panel lifecycle. A monotonic ticket drops out-of-order
  // responses (fast typing); the debounce ref coalesces keystrokes into one tier-0
  // request. The input ref lets the `/` shortcut focus the box.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, searchDispatch] = useReducer(searchReducer, initialSearchState);
  const searchSeqRef = useRef(0);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // UI-S1: selecting a cell reveals the Inspector — the panel that shows what was
  // selected. Wired here, ONCE, off the selection itself rather than at each of the
  // three call sites that set it (canvas click, a results-row jump, the lightbox's
  // "locate"), so a fourth selection path cannot silently miss it.
  useRevealOnSelection(selectedIds, setInspectorCollapsed);

  useEffect(() => {
    if (!vizDebugAvailable) return;
    const onKey = (e: KeyboardEvent): void => {
      // Backtick toggles; ignore when typing into an input/textarea.
      const target = e.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (e.key === "`" && !typing) setShowDebug((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Enter opens the lightbox for the current selection (brief: "Enter on a
  // selected cell opens the overlay"), guarded like the backtick handler so it
  // never fires while typing. Opens at index 0 of the selection; the Lightbox's
  // own ←/→ page through the rest. No-op with nothing selected or already open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Enter") return;
      const target = e.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (typing) return;
      if (selectedIds.length === 0 || lightbox !== null) return;
      e.preventDefault();
      setLightbox({ index: 0 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds, lightbox]);

  // "/" focuses the search box (the kbd hint is rendered in the input placeholder),
  // ignored while already typing so "/" stays a literal character in a field (T2-57).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (typing) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cancel any pending debounced search on unmount (a keyed remount on dataset switch)
  // so a timer cannot fire a fetch/dispatch after teardown.
  useEffect(
    () => () => {
      if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current);
    },
    [],
  );

  function surface(err: unknown): void {
    if (errStatus(err) === 401) {
      props.onAuthExpired();
      return;
    }
    setError(errText(err));
  }

  // Snapshot the renderer's resident coarse mosaic tiles into the minimap overview
  // (T2-54). Only pushes state when the resident-tile SET changed (a cheap signature
  // over the layout bbox + tile addresses), so the periodic poll doesn't repaint the
  // minimap every tick. The renderer's CoarseOverview is structurally the minimap's
  // MinimapOverview, so it maps straight across.
  function refreshOverview(pyramid: TilePyramid): void {
    const ov = pyramid.coarseOverview();
    if (ov === null) {
      if (overviewSigRef.current !== "") {
        overviewSigRef.current = "";
        setMinimapOverview(null);
      }
      return;
    }
    const b = ov.layoutBBox;
    const sig = `${b.xMin},${b.yMin},${b.xMax},${b.yMax}|${ov.tiles
      .map((t) => `${t.bbox.xMin},${t.bbox.yMin}`)
      .sort()
      .join(";")}`;
    if (sig === overviewSigRef.current) return; // unchanged resident set — no repaint
    overviewSigRef.current = sig;
    setMinimapOverview({ layoutBBox: ov.layoutBBox, tiles: ov.tiles });
  }

  // Build the renderer stack once per mount — and the mount is keyed on
  // datasetId by App (D-31), so this is once per dataset.
  useEffect(() => {
    mountedRef.current = true; // (re)arm for this mount; the cleanup below sets it false
    let cancelled = false;
    let world: WorldHandle | null = null;
    let cells: Cells | null = null;
    let status: ViewerStatusHandle | null = null;
    let rafHandle: number | null = null;
    let overviewTimer: ReturnType<typeof setInterval> | null = null;

    // Part B: the collection's name + credit, fetched independently of the boot chain
    // and NEVER awaited by it. A failure here must not keep the canvas from rendering,
    // so this has its own catch that simply leaves the chrome in its un-named state.
    // An async IIFE, NOT `client.getDataset(...).catch(...)`: a promise-tail catch only
    // handles a REJECTION, so anything thrown synchronously by the call itself escapes
    // and takes the whole viewer down (caught in review by the DOM stubs, whose partial
    // clients have no getDataset — a TypeError raised before any promise exists). The
    // try/catch here covers both, which is what "non-fatal" has to mean.
    void (async () => {
      try {
        const summary = await client.getDataset(datasetId);
        if (!cancelled) {
          setPresentation({
            display_name: summary.display_name,
            attribution: summary.attribution,
            attribution_url: summary.attribution_url,
          });
        }
      } catch {
        /* chrome only — the id remains the title, the credit stays hidden */
      }
    })();

    (async () => {
      const layoutInfos = await client.listLayouts(datasetId);
      if (layoutInfos.length === 0) throw new Error("This dataset declares no layouts.");
      const firstLayout = layoutInfos[0].layout_id;
      // Validated at the client boundary (issue #4) before the renderer sees it.
      const mf = await client.getManifest(datasetId, firstLayout);
      if (cancelled) return;
      setLayouts(layoutInfos);
      setManifest(mf);
      setActiveLayoutId(firstLayout);

      // D-14 sidecar: fetched once per dataset; failure only disables tag
      // filtering (gap #8) — the canvas stays interactive.
      if (mf.tags !== undefined && mf.tags !== null) {
        try {
          const table = await client.fetchTags(client.tagsUrl(mf.dataset_id, mf.dataset_version));
          if (!cancelled) setTagsTable(table);
        } catch (tagErr) {
          console.error("[viewer] tag sidecar failed to load; tag filtering disabled", tagErr);
        }
      }
      if (cancelled) return;

      const canvas = canvasRef.current;
      const holder = holderRef.current;
      if (canvas === null || holder === null) return;
      world = createWorld(canvas, measure(holder));
      // DEV-only camera drive (window.__vizCamera): lets an external script move the
      // camera along a computed path — used by the hero-loop capture
      // (docs/launch/SEAM_hero-capture.md). No-op in a production build (the handle
      // is published only when import.meta.env.DEV, see renderer/debug.ts), and
      // withdrawn on teardown below so it never outlives this world.
      publishCameraDrive({
        get: () => {
          const s = world!.getCameraState();
          return { center: [s.center[0], s.center[1]], zoom: s.zoom };
        },
        set: (center, zoom) => world!.setCameraState({ center, zoom }),
        fitZoom: () => fitZoom(world!.getViewport()),
      });
      cells = createCells(world);
      const pyramid = createTilePyramid(world, cells, client, mf, () => {
        // In-place WebGL recovery timed out — the lost context never restored.
        // Surface a reload prompt rather than leave the user on a frozen/grey canvas.
        // Guarded on `cancelled` so a watchdog racing teardown can't setState after
        // unmount (world.dispose() also cancels the watchdog — this is belt-and-braces).
        if (!cancelled) {
          setError("Rendering was interrupted and could not recover. Reload the page to continue.");
        }
      });
      // Pass the concrete world handle so the controller's centerOnCell (T2-54/T2-71)
      // can drive the camera; every other controller method is camera-free.
      const controller = createLayoutController(cells, pyramid, client, world);
      // T2-120 (Fix B): the renderer pushes async tag-state changes here — the sidecar
      // resolving (or FAILING) on activate, and a retry settling. Set BEFORE activate so
      // an activate-time failure surfaces the retry affordance immediately.
      controller.setTagStateListener((st) => {
        if (cancelled) return;
        setTagState(st);
      });

      // The renderer-owned status observable (T2-54): zoom + view rect from the
      // camera, the in-view count from the controller's position table, the loader's
      // live loading/resident tile counts, cursor cell + fps. The UI subscribes below;
      // the renderer produces the numbers (boundary: no renderer→UI import).
      const worldRef = world;
      status = createViewerStatus({
        onCameraChange: (cb) => worldRef.onCameraChange(cb),
        countCellsInView: (view) => controller.countCellsInView(view),
        getLoadingTiles: () => pyramid.loadingTileCount(),
        getResidentTiles: () => pyramid.residentTileCount(),
      });
      const unsubStatus = status.subscribe((s) => {
        if (cancelled) return;
        setRendererStatus(s);
        // The viewport box tracks the same camera the status derives from.
        setMinimapView(viewRectOf(worldRef));
      });
      statusUnsubRef.current = unsubStatus;

      stackRef.current = { world, cells, pyramid, controller, status };
      await controller.activate(firstLayout);
      if (cancelled) return;
      world.start();

      // fps proxy (T2-54): drive frameTick from a mount-lifetime rAF loop. The render
      // loop (world.start) also runs on rAF, so this ticks at the same display cadence
      // — an accurate fps read without reaching into the renderer's private loop
      // (boundary). The observable only re-emits when the rounded fps changes, so this
      // is cheap. Cancelled on unmount.
      const tick = (): void => {
        if (cancelled || status === null) return;
        status.frameTick();
        rafHandle = window.requestAnimationFrame(tick);
      };
      rafHandle = window.requestAnimationFrame(tick);

      // Minimap overview (T2-54): snapshot the resident coarse mosaic tiles. Refresh
      // immediately (initial floor) and on a modest interval as coarse tiles bind —
      // NOT per frame (the coarse floor is static within a layout; per-frame setState
      // would thrash React). refreshOverview also runs on every layout switch.
      refreshOverview(pyramid);
      overviewTimer = setInterval(() => {
        if (!cancelled) refreshOverview(pyramid);
      }, 750);
    })().catch((err: unknown) => {
      if (cancelled) return;
      // Deep links (scope Part A): a 404 HERE means the collection could not be opened at
      // all — it does not exist, or it is private and not readable by this visitor (the
      // API returns the same 404 for both by design). A shared link landing on an empty
      // viewer with a banner is a dead end, so hand it back to App, which knows whether
      // logging in could help. Every other status keeps the in-viewer banner.
      if (errStatus(err) === 404 && props.onUnavailable !== undefined) {
        props.onUnavailable(datasetId);
        return;
      }
      surface(err);
    });

    const onResize = (): void => {
      const holder = holderRef.current;
      if (holder !== null && world !== null) world.resize(measure(holder));
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      stackRef.current = null;
      // Stop the fps rAF loop + the minimap-overview poll, and drop the status
      // observable (unsubscribe first so no emit lands after teardown, then dispose).
      if (rafHandle !== null) window.cancelAnimationFrame(rafHandle);
      if (overviewTimer !== null) clearInterval(overviewTimer);
      statusUnsubRef.current?.();
      statusUnsubRef.current = null;
      status?.dispose();
      // D-31 teardown: dispose Cells' GPU resources, then the World —
      // world.dispose() releases the tile-pyramid loader / LayoutController camera
      // subscriptions (documented at their subscription sites).
      publishCameraDrive(null); // withdraw the DEV camera drive before the world goes
      cells?.dispose();
      world?.dispose();
      mountedRef.current = false; // stop any in-flight preview fetch from touching state (#32)
      previewCacheRef.current.clear(); // revoke any cell-preview object URLs on unmount (#32)
    };
    // eslint-style note: datasetId/client are stable for this mount (keyed).
  }, [datasetId, client]);

  async function resolvePreview(cellId: number): Promise<void> {
    previewRequestRef.current = cellId;
    const cached = previewCacheRef.current.get(cellId);
    if (cached !== undefined) {
      setPreview(cached);
      return;
    }
    setPreview(null);
    if (manifest === null || activeLayoutId === null) return;
    // v2 (D-33): the click-through preview is the cell's DETAIL-tier original at
    // /detail/{id}.{ext}. That route is auth-gated, so a bare <img src> 401s (#32);
    // fetchCellPreview sends the identity bearer header and returns the blob, which
    // we wrap in an object URL (never a token in a URL — security). A later click
    // supersedes this one, so a slow fetch must not overwrite it; failures are NOT
    // cached, so they retry on the next click.
    let result: CellPreviewFetch;
    try {
      result = await fetchCellPreview(client, manifest, cellId);
    } catch {
      return; // transient fetch/decode error — not cached, so the next click retries
    }
    if (!mountedRef.current || previewRequestRef.current !== cellId) return; // torn down / superseded
    if (result.kind === "unauthorized") {
      props.onAuthExpired(); // a genuine auth expiry — route it like every other API call
      return;
    }
    if (result.kind !== "image") return; // no detail tier / no original for this cell → no preview
    // put() revokes any prior URL for this cell (same-cell race) and evicts+revokes
    // the LRU tail, so the object-URL set stays bounded and leak-free.
    const data: CellPreviewData = { cellId, imageUrl: URL.createObjectURL(result.blob) };
    previewCacheRef.current.put(data);
    setPreview(data);
  }

  // Hover → cursor cell id in the status bar (T2-54): the existing pick path, run on
  // pointer move. Picking is O(resident) and the status observable coalesces the
  // resulting emit to one per frame, so a fast move does not spam React. A miss (or a
  // drag in progress) clears the cursor cell.
  function handleCanvasMove(e: { clientX: number; clientY: number; buttons: number; currentTarget: HTMLElement }): void {
    const stack = stackRef.current;
    if (stack === null) return;
    if (e.buttons !== 0) {
      stack.status.setCursorCell(null); // dragging/panning — no meaningful hover
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const picked = stack.cells.pick(e.clientX - rect.left, e.clientY - rect.top).cellId;
    stack.status.setCursorCell(picked);
  }

  // Jump the camera to a world point the minimap reported (T2-54 click/drag-to-jump):
  // recenter at the current zoom (a pan, not a zoom change), clamped by setCameraState.
  function handleMinimapJump(worldX: number, worldY: number): void {
    const stack = stackRef.current;
    if (stack === null) return;
    stack.world.setCameraState({ center: [worldX, worldY] });
    setMinimapView(viewRectOf(stack.world));
  }

  // Fit the camera to a layout's bbox (T2-67). Defaults to the active layout (the
  // manual "fit view" button); D-B auto-fit passes the specific layout it is driving
  // so a stale-closure activeLayoutId can't fit the wrong one. A no-op when the layout
  // isn't in the manifest / nothing is active.
  function fitToLayout(layoutId: string | null): void {
    const stack = stackRef.current;
    if (stack === null || manifest === null || layoutId === null) return;
    const entry = manifest.layouts.find((l) => l.layout_id === layoutId);
    if (entry === undefined) return;
    const [xMin, yMin, xMax, yMax] = entry.bbox;
    stack.world.setCameraState(fitCamera({ xMin, yMin, xMax, yMax }, stack.world.getViewport()));
    setMinimapView(viewRectOf(stack.world));
  }
  function handleFitView(): void {
    fitToLayout(activeLayoutId);
  }

  function handleCanvasClick(e: {
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    currentTarget: HTMLElement;
  }): void {
    const stack = stackRef.current;
    if (stack === null) return;
    // Ignore clicks that ended a pan drag (the world's pointer handlers own
    // dragging; a >4px move is not a select).
    const down = pointerDownRef.current;
    if (down !== null && (Math.abs(e.clientX - down.x) > 4 || Math.abs(e.clientY - down.y) > 4)) {
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const picked = stack.cells.pick(px, py).cellId;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;

    let next: number[];
    if (picked === null) {
      next = additive ? selectedIds : []; // background click clears (plain)
    } else if (additive) {
      next = selectedIds.includes(picked)
        ? selectedIds.filter((id) => id !== picked)
        : [...selectedIds, picked];
    } else {
      next = [picked];
    }
    setSelectedIds(next);

    // Multi-select summary: ONE <=250-id call; past the cap the summary says
    // "first 250 of N" (D-13 — the client rejects over-cap batches). The seq
    // ticket drops out-of-order responses from rapid clicks.
    if (next.length > 1) {
      const seq = ++summarySeqRef.current;
      client
        .getMetadata(datasetId, next.slice(0, METADATA_MAX_IDS))
        .then((rows) => {
          if (summarySeqRef.current === seq) setSummaryRows(rows);
        })
        .catch((err: unknown) => {
          if (summarySeqRef.current === seq) surface(err);
        });
    } else {
      summarySeqRef.current += 1; // invalidate any in-flight summary response
      setSummaryRows([]);
    }

    if (picked !== null) {
      void resolvePreview(picked);
    }
  }

  function handleSwitch(layoutId: string): void {
    const stack = stackRef.current;
    if (stack === null) return;
    const prev = activeLayoutId;
    setActiveLayoutId(layoutId); // optimistic: highlight the target immediately
    previewCacheRef.current.clear(); // revoke object URLs (#32); detail is layout-independent but keep it simple
    stack.controller
      .switchTo(layoutId)
      .then(() => {
        // D-B auto-fit (T2-67): if the held camera would strand the user in empty
        // space on the new layout (zero cells in view), fit to the new layout's
        // bbox; otherwise HOLD (cross-layout region comparison). The new layout's
        // position table loads fire-and-forget, so give it a moment to bind before
        // reading countCellsInView (null while unready ⇒ shouldAutoFit false ⇒ hold);
        // re-read the overview afterwards so the minimap reflects the new floor.
        maybeAutoFit(layoutId);
      })
      .catch((err: unknown) => {
        // The switch failed — put the switcher back on the layout that is actually
        // active, unless a LATER click already retargeted it (then that click's own
        // resolution owns the state). A superseded switch resolves quietly (no
        // rejection), so only real failures land here.
        setActiveLayoutId((cur) => (cur === layoutId ? prev : cur));
        surface(err);
      });
  }

  // D-B auto-fit driver (T2-67): read the in-view count for the current camera against
  // the newly-active layout and fit only when it is zero. The position table binds
  // asynchronously after switchTo, so this retries a couple of times over ~400ms until
  // the count is derivable (non-null); once it is, it applies shouldAutoFit and stops.
  // A no-op if the layout changed again meanwhile (a rapid re-switch owns its own fit).
  function maybeAutoFit(layoutId: string, attempt = 0): void {
    const stack = stackRef.current;
    if (stack === null) return;
    refreshOverview(stack.pyramid);
    const inView = stack.controller.countCellsInView(viewRectOf(stack.world));
    if (inView === null && attempt < 3) {
      // Table not resident yet — retry shortly (bounded) so a slow static-edge fetch
      // still triggers the auto-fit for a genuinely-stranded switch.
      window.setTimeout(() => maybeAutoFit(layoutId, attempt + 1), 120);
      return;
    }
    if (shouldAutoFit(inView)) fitToLayout(layoutId);
  }

  function handleTagChange(selection: TagSelection): void {
    setTagSelection(selection);
    // T2-120 (Fix C): applyTags returns the honest match count + renderer-side status;
    // capture it for the status bar + the retry affordance (async outcomes of a failed
    // reload arrive later via setTagStateListener).
    const result = stackRef.current?.controller.applyTags(selection);
    if (result !== undefined) setTagState(result);
  }

  // T2-120 (Fix B): the tag rail's "retry" — re-apply the current selection, which
  // re-attempts the renderer-side sidecar load (un-latched). The eventual outcome
  // arrives via setTagStateListener; the synchronous state is captured immediately.
  function handleRetryTags(): void {
    const result = stackRef.current?.controller.applyTags(tagSelection);
    if (result !== undefined) setTagState(result);
  }

  // --- search (T2-57) ------------------------------------------------------

  // Run one search against the server (tier `default` on keystroke, `all` on Enter).
  // A monotonic ticket drops a superseded response; a 401 routes to re-auth like every
  // other call; any other failure surfaces in the panel's error state (not the banner).
  function runSearch(query: string, tier: "default" | "all"): void {
    const trimmed = query.trim();
    if (trimmed === "") {
      searchSeqRef.current += 1;
      searchDispatch({ type: "clear" });
      return;
    }
    const seq = ++searchSeqRef.current;
    searchDispatch({ type: "loading", query: trimmed, tier });
    client
      .search(datasetId, trimmed, tier)
      .then((resp) => {
        if (searchSeqRef.current !== seq) return; // superseded by a newer query
        searchDispatch({ type: "results", query: trimmed, tier, hits: resp.hits, capped: resp.capped });
      })
      .catch((err: unknown) => {
        if (searchSeqRef.current !== seq) return;
        if (errStatus(err) === 401) {
          props.onAuthExpired();
          return;
        }
        searchDispatch({ type: "error", query: trimmed, tier, message: errText(err) });
      });
  }

  // The controlled input's onChange: debounce the tier-0 keystroke search; an empty box
  // unmounts the dropdown entirely. Auto-expands the SEARCH DROPDOWN so the results are
  // visible (UI-S1: before this seam the same call expanded the INSPECTOR, because the
  // results list was the Inspector's body — the Inspector is now revealed by selecting a
  // cell instead, see useRevealOnSelection).
  function handleSearchInput(value: string): void {
    setSearchQuery(value);
    if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current);
    const trimmed = value.trim();
    if (trimmed === "") {
      searchSeqRef.current += 1;
      searchDispatch({ type: "clear" });
      return;
    }
    setSearchCollapsed(false);
    // Enter the searching state NOW, not when the debounced request fires: the panel
    // mounts as soon as the box is non-empty, so without this it renders its IDLE
    // prompt ("Type to search…") back at a user who is already typing for the whole
    // debounce window. runSearch re-dispatches this on fire, which is a no-op here.
    searchDispatch({ type: "loading", query: trimmed, tier: "default" });
    searchDebounceRef.current = setTimeout(() => runSearch(trimmed, "default"), SEARCH_DEBOUNCE_MS);
  }

  function clearSearch(): void {
    if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current);
    searchSeqRef.current += 1;
    setSearchQuery("");
    searchDispatch({ type: "clear" });
    searchInputRef.current?.blur();
  }

  // The WAI-ARIA combobox keys, focus staying in the input (searchKeydown is the pure
  // model): ↑/↓ move the active row, Enter jumps/snaps the active row OR (no active row)
  // runs the tier-2 catch-all, Escape clears. Non-owned keys fall through to the input.
  function handleSearchKeyDown(e: {
    key: string;
    preventDefault: () => void;
  }): void {
    const action = searchKeydown(e.key, searchState.rows.length, searchState.activeIndex);
    if (action === null) return;
    e.preventDefault();
    switch (action.type) {
      case "move":
        // ↓/↑ into the list re-reveals a hidden dropdown (UI-S1): arrowing to an option
        // the user cannot see would leave aria-activedescendant pointing at nothing.
        setSearchCollapsed(false);
        searchDispatch({ type: "move", index: action.index });
        break;
      case "activate":
        jumpToRow(searchState.rows[action.index]);
        break;
      case "submit":
        if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current);
        setSearchCollapsed(false); // a fresh catch-all search shows its own results
        runSearch(searchQuery, "all"); // the deliberate reach into descriptions (D-4)
        break;
      case "close":
        clearSearch();
        break;
    }
  }

  // The ACTIVE layout's manifest entry (T2-72 Seam 2), resolved ONCE per render: both the
  // category snap below (band extent) and the SearchResults count read-out (band count) key
  // off this SAME entry, so their agreement is one shared decision rather than two separate
  // lookups a reader must verify stay in step.
  const activeLayoutEntry = manifest?.layouts.find((l) => l.layout_id === activeLayoutId) ?? null;

  // Jump from a results row. A CELL row centers + pulses the cell (the shipped Locate
  // sequence, now list-driven) and selects it so the Inspector shows its metadata. A
  // CATEGORY row SNAPS to its band: preferentially the TRUE extent from the active
  // categorical layout's v2.5 annotations (T2-72 Seam 2), else the union bbox of its
  // member cells' rects (D-3 fallback), else centering the first member.
  function jumpToRow(row: SearchRow): void {
    const stack = stackRef.current;
    if (stack === null) return;
    if (row.kind === "cell") {
      runLocate(row.id, {
        close: () => {},
        select: () => {
          setSelectedIds([row.id]);
          summarySeqRef.current += 1;
          setSummaryRows([]);
          void resolvePreview(row.id);
        },
        center: (id) => stack.controller.centerOnCell(id),
        highlight: (id) => {
          setMinimapView(viewRectOf(stack.world));
          stack.controller.pulseHighlight(id);
        },
      });
      return;
    }
    // Category snap (T2-72 Seam 2): when the ACTIVE layout is this column's categorical
    // layout and its manifest entry carries band annotations, fly to the matched band's
    // TRUE extent. The band's own top-gutter strip holds its label, so fitting the extent
    // frames the whole category PLUS its label (the operator's stated ideal) — and fixes
    // the #172 capped-snap, where the ≤50 members cluster in the band's top strip and the
    // union bbox lands too zoomed. Absent / non-matching (pre-2.5 bake, a different
    // column's layout active, no exact-text band) ⇒ the D-3 positions-bbox fallback below,
    // byte-for-byte unchanged.
    const bandBBox = bandSnapBBox(row, activeLayoutEntry);
    if (bandBBox !== null) {
      stack.world.setCameraState(fitCamera(bandBBox, stack.world.getViewport()));
      setMinimapView(viewRectOf(stack.world));
      return;
    }
    const bbox = unionBBoxFromRects(row.memberIds, (id) => stack.controller.cellRect(id));
    if (bbox !== null) {
      stack.world.setCameraState(fitCamera(bbox, stack.world.getViewport()));
      setMinimapView(viewRectOf(stack.world));
    } else if (row.memberIds.length > 0) {
      const first = row.memberIds[0];
      if (stack.controller.centerOnCell(first)) stack.controller.pulseHighlight(first);
    }
  }

  // UI-S1 — the two conditions the combobox contract hangs off (§3):
  //  • the dropdown is MOUNTED while the box is non-empty and the user has not hidden it;
  //  • the LISTBOX only exists inside it in the `ready`-with-rows state (SearchResults
  //    renders a <p> for loading / error / no-results, no <ul role="listbox">).
  // aria-expanded must track the second, not the first — "expanded" means the popup is
  // displayed, and a dropdown the user hid is not — and aria-activedescendant must never
  // name an option id that is not in the document.
  const searchDropdownOpen = searchQuery !== "" && !searchCollapsed;
  const searchListboxShown =
    searchDropdownOpen && searchState.status === "ready" && searchState.rows.length > 0;

  const roles = manifest?.column_roles ?? null;
  // D-35 Seam G3 (T2-125): a per-layout summary of the BAKED shaping options (the manifest
  // `options` echo) keyed by layout_id, so the switcher can EXPLAIN each layout — the
  // projection a map baked, the scale/placement a scatter baked — not only configure the
  // next. describeBakedOptions returns null for families with no shaping options; a tiny
  // pure map over the layout list.
  const bakedSummary: Record<string, string | null> = {};
  for (const l of manifest?.layouts ?? []) {
    bakedSummary[l.layout_id] = describeBakedOptions(l.type, l.options);
  }
  const selectedCell = selectedIds.length === 1 ? selectedIds[0] : null;
  // T2-54: the renderer-owned values (zoom / in-view / loading tiles / cursor / fps)
  // now come LIVE from the ViewerStatus observable (rendererStatus); the shell still
  // fills what it owns (layout id, the tag read-out, selected cell). Null renderer
  // values (before the first emit, or no position table for in-view) still render as
  // "—" in StatusBar — the null-tolerant contract is preserved. zoom is shown as a
  // human-scaled factor (see zoomFactor) rather than the raw world-units-per-px.
  const rs = rendererStatus;
  // T2-120/T2-121 (Fix C): the honest tag read-out — status + REAL match count from the
  // controller (tagState), plus the selected-chip count the shell owns. Before the first
  // emit, fall back to 'none'/idle with the manifest's image_count as the denominator.
  const tags: TagStatusView = {
    status: tagState?.status ?? "none",
    selected: tagSelection.selected.length,
    matched: tagState?.matched ?? 0,
    total: tagState?.total ?? (manifest?.dataset_metadata.image_count ?? 0),
  };
  const status: ViewerStatus = {
    layoutId: activeLayoutId ?? "—",
    zoom: rs !== null ? zoomFactor(rs.zoom, holderRef.current) : null,
    inView: rs?.inView ?? null,
    loadingTiles: rs?.loadingTiles ?? 0,
    tags,
    selectedCell,
    cursor: rs != null && rs.cursorCell !== null ? `cell ${rs.cursorCell}` : null,
    fps: rs?.fps ?? null,
  };

  return h(
    "div",
    { className: "viewer-screen" },
    h(
      "div",
      { ref: holderRef, className: "canvas-holder" },
      h("canvas", {
        ref: canvasRef,
        className: "atlas-canvas",
        onPointerDown: (e: { clientX: number; clientY: number }) => {
          pointerDownRef.current = { x: e.clientX, y: e.clientY };
        },
        onPointerMove: handleCanvasMove,
        onClick: handleCanvasClick,
      }),
      vizDebugAvailable && showDebug ? h(DebugOverlay) : null,
      // Floating top bar: three panels — nav+identity · layout switcher · search.
      h(
        "header",
        { className: "cockpit-topbar" },
        h(
          "div",
          { className: "panel-float topbar-nav" },
          // Glyph-only brand mark (board 3b): no wordmark over the canvas. It shares
          // the back-navigation target, then a 1px divider fences it off from the nav.
          // `micro` is deliberate here (legible at this small size) — set explicitly
          // so it doesn't hinge on PlotlasMark's size<18 default.
          h(
            "button",
            {
              type: "button",
              className: "topbar-brand",
              title: "Plotlas — back to library",
              "aria-label": "Plotlas — back to library",
              onClick: props.onBack,
            },
            h(PlotlasMark, { size: 16, variant: "micro" }),
          ),
          h("span", { className: "topbar-divider", "aria-hidden": "true" }),
          h("button", { type: "button", className: "btn ghost", onClick: props.onBack }, "← Datasets"),
          // Part B: what the collection is CALLED, with the id as the tooltip so it
          // stays discoverable (it is what the deep link and the CLI use).
          h(
            "h2",
            { className: "viewer-title", title: datasetId },
            collectionName({ dataset_id: datasetId, display_name: presentation?.display_name }),
          ),
          h("span", { className: "topbar-count" }, `${manifest?.dataset_metadata.image_count ?? "—"}`),
        ),
        activeLayoutId !== null && layouts.length > 0
          ? h(
              "div",
              { className: "panel-float topbar-layouts" },
              h(LayoutSwitcher, { layouts, activeLayoutId, onSwitch: handleSwitch, bakedSummary }),
            )
          : null,
        // Search (T2-57): re-enabled (it was hidden in PR #167 until it worked). A live
        // combobox input drives tier-0 search on debounced keystroke; Enter reaches the
        // tier-2 catch-all. UI-S1: the results list is now this pill's OWN dropdown,
        // anchored under the input (`.search-dropdown`, absolutely positioned against
        // `.topbar-search`), not a body of the Inspector. The input owns the WAI-ARIA
        // combobox role + aria-activedescendant; "/" focuses it.
        h(
          "div",
          { className: "panel-float topbar-search" },
          h("input", {
            ref: searchInputRef,
            type: "search",
            className: "search-input",
            role: "combobox",
            "aria-label": "Search this dataset",
            "aria-expanded": searchListboxShown,
            // Gate aria-controls on the same derived flag as aria-expanded /
            // aria-activedescendant (#227): the listbox id only resolves while the
            // ready-with-rows listbox is actually rendered, so an IDREF to a
            // non-existent element is never advertised (collapsed / loading / error /
            // empty states render a <p>, not the <ul>).
            "aria-controls": searchListboxShown ? SEARCH_LISTBOX_ID : undefined,
            "aria-autocomplete": "list",
            "aria-activedescendant":
              searchListboxShown && searchState.activeIndex >= 0
                ? searchOptionId(searchState.activeIndex)
                : undefined,
            placeholder: "Search…  ( / )",
            value: searchQuery,
            onChange: (e: { currentTarget: { value: string } }) => handleSearchInput(e.currentTarget.value),
            onKeyDown: handleSearchKeyDown,
          }),
          // Re-show control for a dropdown the user hid while the query is still live —
          // the dropdown's equivalent of a rail's collapsed chevron, kept inside the pill
          // (the dropdown's own anchor) rather than floating loose over the canvas.
          searchQuery !== "" && searchCollapsed
            ? h(
                "button",
                {
                  type: "button",
                  className: "btn ghost search-reveal",
                  "aria-label": "Show search results",
                  "aria-expanded": false,
                  onClick: () => {
                    setSearchCollapsed(false);
                    // This button unmounts on click; move focus into the (persistent)
                    // combobox input so keyboard focus isn't dropped to <body> (#227).
                    searchInputRef.current?.focus();
                  },
                },
                "⌄",
              )
            : null,
          searchQuery !== ""
            ? h(
                "button",
                {
                  type: "button",
                  className: "btn ghost search-clear",
                  "aria-label": "Clear search",
                  onClick: clearSearch,
                },
                "×",
              )
            : null,
          // The dropdown itself: header + hide control mirroring the rails, body = the
          // SearchResults panel (unchanged — it still owns the listbox/option ids).
          searchDropdownOpen
            ? h(
                "div",
                { className: "panel-float search-dropdown" },
                h(
                  "div",
                  { className: "rail-header" },
                  h("span", { className: "rail-title" }, "Results"),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "btn ghost rail-toggle",
                      "aria-label": "Hide search results",
                      "aria-expanded": true,
                      onClick: () => {
                        setSearchCollapsed(true);
                        // Reset the active row (#227): the aria layer already reports no
                        // active option while hidden, so Enter must SUBMIT the catch-all,
                        // not activate a row the user can no longer see. Also move focus
                        // off this unmounting button back into the combobox input.
                        searchDispatch({ type: "move", index: -1 });
                        searchInputRef.current?.focus();
                      },
                    },
                    "⌃",
                  ),
                ),
                h(
                  "div",
                  { className: "rail-body search-dropdown-body" },
                  h(SearchResults, {
                    state: searchState,
                    listboxId: SEARCH_LISTBOX_ID,
                    optionId: searchOptionId,
                    onActivate: jumpToRow,
                    onHover: (index: number) => searchDispatch({ type: "move", index }),
                    activeLayout: activeLayoutEntry,
                  }),
                ),
              )
            : null,
        ),
        // Seam O3: the activity pill — running jobs stay visible mid-view (the inat10k
        // scatter / 1M-bake blind spot). `float` makes the pill OWN its panel-float
        // surface and return null (no empty box) when nothing is tracked.
        h(ActivityPill, { float: true, nameFor: activityNameFor }),
      ),
      error !== null
        ? h("p", { className: "panel-float error-banner-float error-text", role: "alert" }, error)
        : null,
      // Floating tag rail (left), collapsible to a 36px chevron button.
      tagsCollapsed
        ? h(
            "button",
            {
              type: "button",
              className: "panel-float rail-collapsed rail-collapsed-left",
              "aria-label": "Expand tags",
              "aria-expanded": false,
              onClick: () => setTagsCollapsed(false),
            },
            "›",
          )
        : h(
            "aside",
            { className: "panel-float tag-rail" },
            h(
              "div",
              { className: "rail-header" },
              h("span", { className: "rail-title" }, "Tags"),
              h(
                "button",
                {
                  type: "button",
                  className: "btn ghost rail-toggle",
                  "aria-label": "Collapse tags",
                  "aria-expanded": true,
                  onClick: () => setTagsCollapsed(true),
                },
                "‹",
              ),
            ),
            h(
              "div",
              { className: "rail-body" },
              h(
                TagTableContext.Provider,
                { value: tagsTable },
                h(TagControls, {
                  roles,
                  selection: tagSelection,
                  onChange: handleTagChange,
                  // T2-120 (Fix B): a RENDERER-side sidecar failure surfaces the retry
                  // affordance even when the UI-side chips (tagsTable) rendered fine.
                  rendererTagsFailed: tagState?.status === "unavailable",
                  onRetryTags: handleRetryTags,
                }),
              ),
            ),
          ),
      // Floating inspector (right), collapsible like the rail.
      inspectorCollapsed
        ? h(
            "button",
            {
              type: "button",
              className: "panel-float rail-collapsed rail-collapsed-right",
              "aria-label": "Expand inspector",
              "aria-expanded": false,
              onClick: () => setInspectorCollapsed(false),
            },
            "‹",
          )
        : h(
            "aside",
            { className: "panel-float inspector" },
            h(
              "div",
              { className: "rail-header" },
              h("span", { className: "rail-title" }, "Inspector"),
              h(
                "button",
                {
                  type: "button",
                  className: "btn ghost rail-toggle",
                  "aria-label": "Collapse inspector",
                  "aria-expanded": true,
                  onClick: () => setInspectorCollapsed(true),
                },
                "›",
              ),
            ),
            h(
              "div",
              { className: "rail-body inspector-body" },
              // UI-S1: metadata/summary ONLY, always. Search used to take this body over
              // as a third state (the spike §3.1 "Inspector-as-results-list"), which is
              // why one collapse flag governed both; the results list now has its own
              // dropdown under the search box, so a live query no longer displaces what
              // the user selected.
              selectedIds.length > 1
                ? h(SelectionSummary, {
                    count: selectedIds.length,
                    rows: summaryRows,
                    roles,
                    onClear: () => {
                      setSelectedIds([]);
                      setSummaryRows([]);
                    },
                  })
                : h(
                    MetadataPanelDataContext.Provider,
                    { value: { tagsTable, preview } },
                    h(MetadataPanel, {
                      dataset: datasetId,
                      selectedCellId: selectedCell,
                      client,
                      // Schema v2.8: the columns whose values render as links. The
                      // manifest is already held here, so no extra fetch.
                      urlColumns: manifest?.column_roles?.url,
                    }),
                  ),
              // View ⤢ button overlaying the preview's bottom-right: enabled when
              // a single cell's preview is resolved. Opens the lightbox at this
              // cell (index 0 of the single-cell selection) AND fires the optional
              // onViewFull prop so an external consumer, if any, still hears it.
              preview !== null && selectedCell !== null && preview.cellId === selectedCell
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "btn ghost view-full-btn",
                      "aria-label": `View cell ${selectedCell} full size`,
                      onClick: () => {
                        setLightbox({ index: 0 });
                        props.onViewFull?.(selectedCell);
                      },
                    },
                    "View ⤢",
                  )
                : null,
            ),
          ),
      // Fit-view control (T2-67): a floating button above the minimap that fits the
      // camera to the active layout's bbox. Ships regardless of the D-B auto-fit.
      h(
        "button",
        {
          type: "button",
          className: "panel-float fit-view-btn",
          "aria-label": "Fit view to layout",
          title: "Fit view",
          onClick: handleFitView,
        },
        "⤢ Fit",
      ),
      // Live minimap (T2-54): overview imagery (resident coarse mosaic) + a viewport
      // box driven by the camera + click/drag-to-jump. Degrades to a ground field +
      // box when no imagery is resident yet. `layoutId` (T2-88) tells the minimap when
      // to REBUILD its retained overview canvas — on a layout switch — vs. keep unioning
      // resident tiles into it (so the overview stays whole-world and never edge-blacks
      // as the live coarse floor is evicted at deep zoom).
      h(Minimap, {
        overview: minimapOverview,
        layoutId: activeLayoutId,
        view: minimapView,
        onJump: handleMinimapJump,
      }),
      // Lightbox (T2-25): a full-viewport overlay OVER the canvas. Rendered inline
      // so the renderer stack stays mounted (camera + selection survive close).
      // cellIds = the live selection; the index is clamped defensively in case the
      // selection shrank. manifest/previewCache/tagsTable/onAuthExpired are passed
      // through (see Lightbox's header on why the last three are needed). "Locate on
      // canvas" now closes → selects → centers (T2-54 centerOnCell) → pulses (T2-71).
      lightbox !== null && manifest !== null && selectedIds.length > 0
        ? h(Lightbox, {
            dataset: datasetId,
            client,
            manifest,
            previewCache: previewCacheRef.current,
            tagsTable,
            cellIds: selectedIds,
            index: Math.min(lightbox.index, selectedIds.length - 1),
            onNavigate: (i: number) => setLightbox({ index: i }),
            onClose: () => setLightbox(null),
            onAuthExpired: props.onAuthExpired,
            onLocate: (cellId: number) => {
              // "Locate on canvas" (T2-71): close → select → CENTER (T2-54
              // centerOnCell) → brief highlight PULSE, in that order (runLocate is the
              // pure sequencer). centerOnCell / pulseHighlight degrade gracefully when
              // the layout has no position table (center returns false ⇒ no pulse) —
              // the result is exactly today's close+select, no error.
              const stack = stackRef.current;
              runLocate(cellId, {
                close: () => setLightbox(null),
                select: () => {
                  setSelectedIds([cellId]);
                  summarySeqRef.current += 1;
                  setSummaryRows([]);
                  void resolvePreview(cellId);
                },
                center: (id) => stack !== null && stack.controller.centerOnCell(id),
                highlight: (id) => {
                  if (stack === null) return;
                  setMinimapView(viewRectOf(stack.world));
                  stack.controller.pulseHighlight(id); // reuses the tag-highlight path
                },
              });
            },
          })
        : null,
    ),
    // Part B/D §2b: source credit for the holding institution. It rides INSIDE the status
    // bar (immediately left of the brand signature) rather than as a second floating strip
    // — one footer, not two. Shared with the library card (attributionCredit): rendered
    // ONLY when set (an empty credit is chrome pretending to be information), an anchor when
    // attribution_url is an absolute http(s) URL, else plain text — a bad target loses the
    // LINK, never the credit.
    h(StatusBar, {
      status,
      credit: attributionCredit(
        presentation?.attribution,
        presentation?.attribution_url,
        "status-item status-credit",
      ),
    }),
  );
}
