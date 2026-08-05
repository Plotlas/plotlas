// Lightbox (T2-25) — design-pass board 2b: a full-viewport overlay OVER the
// Explorer that shows the selected cell's DETAIL-tier original at full size, with
// a slim identity strip under the image and a full-height side inspector (all
// metadata fields). ←/→ navigate the current multi-selection, `i` toggles the
// inspector, `esc`/backdrop close, and "Locate on canvas" closes + selects + (via
// the T2-54 centerOnCell hook ViewerScreen wires) centers + highlights the cell.
//
// OVERLAY, NEVER A ROUTE (brief §1.3): ViewerScreen renders this inline in its own
// tree while keeping the whole renderer stack mounted, so opening/closing never
// unmounts the World — camera and selection survive close. No history/URL change.
//
// Image fetch reuses the cellPreview.ts path (brief §1.2 / §2): the DETAIL route
// is auth-gated (D-24), so a bare <img src> 401s — fetchCellPreview sends the
// identity bearer header and returns the blob, which we wrap in an object URL
// (NEVER a token in a URL). The resolved originals live in the SAME preview cache
// the inspector uses (brief DoD #2 — extend the existing cache, do not build a
// second): put() bounds the set + revokes the evicted/replaced/cleared URL, so the
// object-URL lifecycle is deterministic without a lightbox-local cache.
//
// .ts + createElement, runtime imports bare-only: see LayoutSwitcher.ts (the node
// test runner cannot load JSX/.tsx or extensionless src specifiers).
//
// NB — props beyond the brief's core list: `manifest` and `previewCache` are added
// because they are STRUCTURALLY required and cannot be derived from `dataset` +
// `client` alone: fetchCellPreview(client, manifest, id) needs the manifest to
// resolve the detail extension/presence, and DoD #2 requires reusing the SINGLE
// existing preview cache (a document-lifetime object-URL owner). Both are held by
// ViewerScreen already; passing them in keeps the cache single-owned and the
// lightbox a pure consumer. The lightbox's props are seam-internal (not catalogued,
// like StatusBar/Minimap/SelectionSummary).
import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { Table } from "apache-arrow";
import type { ApiClient } from "../api-client/client.ts";
import type { LayoutManifest } from "../renderer/layout.ts";
import { fetchCellPreview, detailForManifest } from "./cellPreview.ts";
import type { PreviewCache } from "./cellPreview.ts";
import { MetadataPanelView, tagValuesForId } from "./MetadataPanel.ts";
import type { CellPreviewData } from "./MetadataPanel.ts";
import type { MetadataRow } from "../api-client/types.ts";

export interface LightboxProps {
  dataset: string;
  client: ApiClient;
  /** The current selection to page through; a single id hides the nav arrows. */
  cellIds: number[];
  /** Index into `cellIds` of the cell on show. */
  index: number;
  /** Move the shown cell within `cellIds` (ViewerScreen owns the index state). */
  onNavigate: (index: number) => void;
  /** Close the overlay; ViewerScreen keeps the renderer stack + selection intact. */
  onClose: () => void;
  /** "Locate on canvas" (T2-71): ViewerScreen wires this to close + select + center
   *  + highlight the cell (via the T2-54 LayoutController.centerOnCell / pulseHighlight
   *  hooks). The lightbox stays a pure consumer — it just fires the cell id; what
   *  "locate" does is ViewerScreen's decision. Absent ⇒ button hidden. */
  onLocate?: (cellId: number) => void;
  /** A genuine 401 (detail fetch OR metadata) routes here — like every other API
   *  call (DoD #4). ViewerScreen passes its own onAuthExpired. */
  onAuthExpired: () => void;
  // ── structurally-required additions (see file header) ──
  /** The validated layout manifest — fetchCellPreview needs it to resolve the
   *  detail extension/presence. */
  manifest: LayoutManifest;
  /** The SINGLE preview cache ViewerScreen already owns (DoD #2): resolved
   *  originals are stored here so eviction/replace/clear revoke their object URLs. */
  previewCache: PreviewCache;
  /** The D-14 tag sidecar (shared with the inspector); null when absent/failed. */
  tagsTable: Table | null;
}

/** The keyboard actions the lightbox reduces raw keys to. Pure + exported so the
 *  key mapping (incl. end-clamping and the typing guard) is unit-testable without
 *  the DOM. */
export type LightboxKeyAction =
  | { kind: "none" }
  | { kind: "close" }
  | { kind: "toggle-panel" }
  | { kind: "navigate"; index: number };

export interface LightboxKeyContext {
  /** Number of cells in the selection (arrows are inert for < 2). */
  count: number;
  /** Currently-shown index into the selection. */
  index: number;
  /** True when the event target is a text input/textarea — keys are ignored
   *  (copies ViewerScreen's backtick-handler guard so typing is never hijacked). */
  typing: boolean;
}

/** Map a key to a lightbox action. `esc` closes; `i` toggles the panel; `←`/`→`
 *  step through the selection and CLAMP at the ends (no wrap); everything else —
 *  and anything typed into an input — is a no-op. Pure; unit-tested. */
export function lightboxKeyAction(key: string, ctx: LightboxKeyContext): LightboxKeyAction {
  if (ctx.typing) return { kind: "none" };
  if (key === "Escape") return { kind: "close" };
  if (key === "i" || key === "I") return { kind: "toggle-panel" };
  if (key === "ArrowLeft") {
    if (ctx.count < 2) return { kind: "none" };
    const next = Math.max(0, ctx.index - 1);
    return next === ctx.index ? { kind: "none" } : { kind: "navigate", index: next };
  }
  if (key === "ArrowRight") {
    if (ctx.count < 2) return { kind: "none" };
    const next = Math.min(ctx.count - 1, ctx.index + 1);
    return next === ctx.index ? { kind: "none" } : { kind: "navigate", index: next };
  }
  return { kind: "none" };
}

/** The ordered steps ViewerScreen runs for "Locate on canvas" (T2-71), extracted as
 *  a pure sequencer so the ORDER contract is unit-testable without the renderer
 *  stack. The steps are always: (1) close the lightbox, (2) single-select the cell,
 *  (3) CENTER the camera on it, (4) if centering succeeded, HIGHLIGHT it briefly.
 *  `center` returns whether it drove the camera (false on graceful absence — no
 *  position table / no world), and the pulse only runs when it did (a highlight with
 *  no camera move would be a disproportionate flash on a cell you can't see). Pure +
 *  exported for unit tests. */
export interface LocateActions {
  close: () => void;
  select: (cellId: number) => void;
  center: (cellId: number) => boolean;
  highlight: (cellId: number) => void;
}

export function runLocate(cellId: number, actions: LocateActions): void {
  actions.close();
  actions.select(cellId);
  const centered = actions.center(cellId);
  if (centered) actions.highlight(cellId);
}

/** True when a keyboard event originates from a text field (guard shared shape
 *  with ViewerScreen's backtick handler). */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
}

/** The image area's load state. In v2 the preview cache holds the DETAIL original
 *  itself (there is no separate thumbnail tier), so a cache hit shows the final
 *  image immediately; a miss streams it (loading), and a non-ok/decode failure is
 *  inline + retryable (never a dead overlay). */
export type LightboxImageState =
  | { kind: "loading"; blurUrl: string | null }
  | { kind: "image"; url: string }
  | { kind: "none" } // dataset baked no detail tier → no original to show
  | { kind: "failed" };

export interface LightboxIdentity {
  /** Filename from the cell's metadata row (mono); null until/if unknown. */
  filename: string | null;
}

export interface LightboxBodyProps {
  cellId: number;
  index: number;
  count: number;
  image: LightboxImageState;
  identity: LightboxIdentity;
  /** Object URL of the resolved original, for the "Download original" anchor
   *  (a blob download via the same object URL — no token in any URL). */
  downloadUrl: string | null;
  /** Suggested download filename (the cell's filename, else a cell-id fallback). */
  downloadName: string;
  panelOpen: boolean;
  /** Inspector field data (fetched by the container; reuses MetadataPanelView). */
  row: MetadataRow | null;
  metaLoading: boolean;
  metaError: string | null;
  tagValues: { column: string; values: string[] }[];
  /** Schema v2.8 `column_roles.url` — columns the inspector renders as links. */
  urlColumns?: string[];
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onTogglePanel: () => void;
  onRetry: () => void;
  onLocate: (() => void) | null;
}

/** Presentational lightbox body (exported for the GL-free renderToString smoke;
 *  the stateful Lightbox below fetches + wires keys, then renders this). */
export function LightboxBody(props: LightboxBodyProps): ReactElement {
  const multi = props.count > 1;

  // ── image area ──
  let imageArea: ReactElement;
  if (props.image.kind === "image") {
    imageArea = h("img", {
      className: "lightbox-img",
      src: props.image.url,
      alt: `Cell ${props.cellId} full size`,
    });
  } else if (props.image.kind === "loading") {
    imageArea = h(
      "div",
      { className: "lightbox-img-loading" },
      props.image.blurUrl !== null
        ? h("img", {
            className: "lightbox-img lightbox-img-blur",
            src: props.image.blurUrl,
            alt: "",
            "aria-hidden": true,
          })
        : null,
      h("span", { className: "lightbox-loading-note muted" }, "Loading…"),
    );
  } else if (props.image.kind === "failed") {
    imageArea = h(
      "div",
      { className: "lightbox-img-failed" },
      h("p", { className: "error-text" }, "Couldn’t load this image."),
      h(
        "button",
        { type: "button", className: "btn ghost", onClick: props.onRetry },
        "Retry",
      ),
    );
  } else {
    imageArea = h(
      "div",
      { className: "lightbox-img-none" },
      h("p", { className: "muted" }, "No full-resolution original for this cell."),
    );
  }

  // ── slim identity strip under the image ──
  const identityStrip = h(
    "div",
    { className: "panel-float lightbox-identity" },
    h("span", { className: "lightbox-id-name" }, props.identity.filename ?? `cell ${props.cellId}`),
    props.downloadUrl !== null
      ? h(
          "a",
          {
            className: "lightbox-download",
            href: props.downloadUrl,
            download: props.downloadName,
          },
          "Download original ↗",
        )
      : null,
    h(
      "span",
      { className: "lightbox-id-count" },
      `${props.index + 1} / ${props.count} selected`,
    ),
  );

  // ── nav arrows on the image edges (hidden for a single selection) ──
  const arrows = multi
    ? [
        h(
          "button",
          {
            type: "button",
            className: "panel-float lightbox-nav lightbox-nav-prev",
            "aria-label": "Previous cell",
            disabled: props.index <= 0,
            onClick: props.onPrev,
            key: "prev",
          },
          "‹",
        ),
        h(
          "button",
          {
            type: "button",
            className: "panel-float lightbox-nav lightbox-nav-next",
            "aria-label": "Next cell",
            disabled: props.index >= props.count - 1,
            onClick: props.onNext,
            key: "next",
          },
          "›",
        ),
      ]
    : [];

  const imageColumn = h(
    "div",
    { className: "lightbox-image-col" },
    h("div", { className: "lightbox-image-area" }, imageArea, ...arrows),
    identityStrip,
  );

  // ── side inspector (full height) — reuses MetadataPanelView for the field grid
  //    + tag chips. preview:null suppresses its 160px thumbnail (the image lives
  //    in the image column), so we get title + fields + chips, no fork. ──
  const inspector = props.panelOpen
    ? h(
        "aside",
        { className: "panel-float lightbox-inspector" },
        h(
          "div",
          { className: "lightbox-inspector-head" },
          h("span", { className: "lightbox-inspector-title" }, `cell ${props.cellId}`),
          h("span", { className: "kbd-hint muted" }, "i to hide"),
        ),
        h(
          "div",
          { className: "lightbox-inspector-body" },
          h(MetadataPanelView, {
            selectedCellId: props.cellId,
            row: props.row,
            loading: props.metaLoading,
            error: props.metaError,
            tagValues: props.tagValues,
            urlColumns: props.urlColumns,
            preview: null as CellPreviewData | null,
          }),
        ),
        props.onLocate !== null
          ? h(
              "div",
              { className: "lightbox-inspector-foot" },
              h(
                "button",
                { type: "button", className: "btn ghost", onClick: props.onLocate },
                "Locate on canvas",
              ),
            )
          : null,
      )
    : null;

  return h(
    "div",
    {
      className: "lightbox-backdrop",
      role: "dialog",
      "aria-modal": true,
      "aria-label": `Cell ${props.cellId} full view`,
      // Backdrop click closes; clicks on the content region do not bubble to it.
      onClick: (e: { target: unknown; currentTarget: unknown }) => {
        if (e.target === e.currentTarget) props.onClose();
      },
    },
    h(
      "div",
      { className: "lightbox-content" },
      imageColumn,
      inspector,
      // Panel toggle + close chrome (top-right), always available.
      h(
        "div",
        { className: "lightbox-chrome" },
        h(
          "button",
          {
            type: "button",
            className: "panel-float lightbox-chrome-btn",
            "aria-label": props.panelOpen ? "Hide details" : "Show details",
            "aria-pressed": props.panelOpen,
            onClick: props.onTogglePanel,
          },
          "i",
        ),
        h(
          "button",
          {
            type: "button",
            className: "panel-float lightbox-chrome-btn lightbox-close",
            "aria-label": "Close",
            onClick: props.onClose,
          },
          "✕",
        ),
      ),
    ),
  );
}

export function Lightbox(props: LightboxProps): ReactElement {
  const { client, manifest, previewCache, dataset } = props;
  const onAuthExpired = props.onAuthExpired;
  const cellId = props.cellIds[props.index];

  const hasDetail = detailForManifest(manifest) !== null;
  const [panelOpen, setPanelOpen] = useState(true);
  // Resolved original for the shown cell (from the shared cache or a fresh fetch).
  const [image, setImage] = useState<LightboxImageState>(() => {
    const cached = previewCache.get(cellId);
    return cached !== undefined
      ? { kind: "image", url: cached.imageUrl }
      : hasDetail
        ? { kind: "loading", blurUrl: null }
        : { kind: "none" };
  });
  const [row, setRow] = useState<MetadataRow | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);
  // Bump to force a re-fetch of the same cell on Retry (failures aren't cached —
  // same policy as resolvePreview).
  const [retryTick, setRetryTick] = useState(0);
  // Latest requested cell: a slow fetch for a cell we've navigated away from must
  // not overwrite the current image (mirrors ViewerScreen.previewRequestRef).
  const requestRef = useRef<number>(cellId);

  const tagValues =
    props.tagsTable !== null ? tagValuesForId(props.tagsTable, cellId) : [];

  // ── resolve the DETAIL original for the shown cell ──
  useEffect(() => {
    requestRef.current = cellId;
    const cached = previewCache.get(cellId);
    if (cached !== undefined) {
      setImage({ kind: "image", url: cached.imageUrl });
      return;
    }
    if (!hasDetail) {
      setImage({ kind: "none" });
      return;
    }
    // No cached original to blur up from (v2's cache IS the original) → plain load.
    setImage({ kind: "loading", blurUrl: null });
    const ctrl = new AbortController();
    (async () => {
      let result;
      try {
        result = await fetchCellPreview(client, manifest, cellId, ctrl.signal);
      } catch {
        if (requestRef.current === cellId) setImage({ kind: "failed" }); // retryable
        return;
      }
      if (requestRef.current !== cellId) return; // navigated away — drop
      if (result.kind === "unauthorized") {
        onAuthExpired(); // a genuine auth expiry — route it like every other call (DoD #4)
        return;
      }
      if (result.kind === "image") {
        const data: CellPreviewData = {
          cellId,
          imageUrl: URL.createObjectURL(result.blob),
        };
        previewCache.put(data); // shared cache: bounds + revokes prior/evicted URLs
        setImage({ kind: "image", url: data.imageUrl });
      } else {
        setImage({ kind: "none" }); // absent original / no detail tier
      }
    })();
    return () => ctrl.abort();
  }, [cellId, client, manifest, previewCache, hasDetail, retryTick, onAuthExpired]);

  // ── inspector fields via getMetadata (same source as MetadataPanel) ──
  useEffect(() => {
    let cancelled = false;
    setRow(null);
    setMetaError(null);
    setMetaLoading(true);
    client
      .getMetadata(dataset, [cellId])
      .then((rows) => {
        if (cancelled) return;
        setRow(rows[0] ?? null);
        setMetaLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (errStatus(err) === 401) {
          onAuthExpired(); // route a metadata 401 like every other call (DoD #4)
          return;
        }
        setMetaError(err instanceof Error ? err.message : String(err));
        setMetaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, dataset, client, onAuthExpired]);

  // ── keyboard: ←/→ nav, `i` toggle, `esc` close (typing-guarded) ──
  const onNavigate = props.onNavigate;
  const onClose = props.onClose;
  const count = props.cellIds.length;
  const index = props.index;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = lightboxKeyAction(e.key, {
        count,
        index,
        typing: isTypingTarget(e.target),
      });
      if (action.kind === "none") return;
      e.preventDefault();
      if (action.kind === "close") onClose();
      else if (action.kind === "toggle-panel") setPanelOpen((v) => !v);
      else if (action.kind === "navigate") onNavigate(action.index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, index, onNavigate, onClose]);

  const filename = row !== null ? filenameOf(row) : null;
  const downloadUrl = image.kind === "image" ? image.url : null;
  const downloadName = filename ?? `cell-${cellId}`;
  const onLocate = props.onLocate;

  const retry = useCallback(() => setRetryTick((t) => t + 1), []);

  return h(LightboxBody, {
    cellId,
    index: props.index,
    count,
    image,
    identity: { filename },
    downloadUrl,
    downloadName,
    panelOpen,
    row,
    metaLoading,
    metaError,
    tagValues,
    // Schema v2.8: the container already holds the manifest (it needs it for the
    // detail-tier preview), so the link columns cost no extra fetch.
    urlColumns: manifest.column_roles?.url,
    onPrev: () => onNavigate(Math.max(0, props.index - 1)),
    onNext: () => onNavigate(Math.min(count - 1, props.index + 1)),
    onClose,
    onTogglePanel: () => setPanelOpen((v) => !v),
    onRetry: retry,
    onLocate: onLocate !== undefined ? () => onLocate(cellId) : null,
  });
}

/** The cell's filename from its metadata row, if the dataset carries one. The
 *  `filename` role is the join key (D-25) and is always present when metadata is,
 *  but images-only datasets may lack it — fall back to null. */
function filenameOf(row: MetadataRow): string | null {
  const v = row.fields.filename;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The HTTP status carried by an ApiError, or null (same shape as ViewerScreen's
 *  errStatus — the client attaches `.status` to its thrown errors). */
function errStatus(err: unknown): number | null {
  if (typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}
