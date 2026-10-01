// Library board (design pass 1f; the `LibraryCard` board, D-xxiv): a gallery of dataset
// CARDS with a status pill, inline progress, and a first-run empty state (catalogue
// ui/admin required capabilities; R-25/R-26/R-27).
//
// Presentational: AdminScreen fetches the summaries; every server message arrives back
// as `error` text in the AdminScreen banner.
//
// D-xxiv: a card is `Open` + `Edit` for its OWNER and `Open` alone for anyone else, and
// the ⋯ menu is gone. Everything it held now lives in the layout designer: `Edit
// details…` and `Delete` in Overview, `Add layout` on the Layouts tab. `Edit` is a
// display gate, not an authorization one — the API refuses a non-owner's writes
// regardless (D-24); it exists so nobody is shown a door that cannot open. Web re-ingest
// was removed earlier (fix/reingest-safety): re-baking is CLI-only (`pixscope ingest`).
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { DatasetSummary } from "../../api-client/types";
import { collectionName } from "../../api-client/types";
import { PlotlasMark } from "../PlotlasMark.ts";
import { mayOpenDesigner } from "../urlState.ts";
import { hasActiveJob } from "./datasetActivity.ts";
import { attributionCredit } from "../attributionCredit.ts";

export interface DatasetListProps {
  datasets: DatasetSummary[];
  /** The API client, used to fetch each ready card's cover thumbnail (T2-55). The
   *  cover route is auth-gated, so the fetch carries the bearer header and the blob is
   *  wrapped in an object URL — mirroring the cell-preview path (a bare `<img src>`
   *  would 401). */
  client: ApiClient;
  onOpen: (dsId: string) => void;
  /** Open a ready collection in the layout DESIGNER (seam L3), which lands on Overview.
   *  Offered on a card only when `username` owns it. */
  onEdit?: (dsId: string) => void;
  /** The signed-in user — whose cards get `Edit`. Null/absent ⇒ no card does. */
  username?: string | null;
  /** Route to the create wizard (empty-state CTA). */
  onNewDataset: () => void;
  /** Seam O3 (T2-104): open the activity panel from a ready-with-active-job card's
   *  "updating" badge. Optional — absent in the isolated component tests (the badge
   *  then renders inert). */
  onOpenActivity?: () => void;
  /** Anonymous public entry (D-34 consumer): render the READ-ONLY library — a visitor
   *  with no account browsing PUBLIC datasets. Suppresses every owner affordance (`Edit`
   *  and the activity "updating" badge) so a card shows only "Open", and swaps the
   *  first-run CLI empty state for the honest anonymous one. */
  readOnly?: boolean;
  /** Anonymous empty state's "Log in" affordance — opens the auth screen. Only used
   *  when `readOnly` and the public list is empty. */
  onLogin?: () => void;
}

/** Decide whether a dropdown should open UPWARD (T2-89). It opens downward by default
 *  (`top: 100%`), but near the bottom of its scroll container it is clipped. Flip up when
 *  there is not enough room BELOW the button inside the container AND there is more room
 *  above. All inputs are viewport-space rects (getBoundingClientRect); `menuHeight` is the
 *  dropdown's estimated height. Written for the library card's ⋯ menu, which D-xxiv
 *  retired; the activity pill's panel still uses it. Pure + exported for unit tests. */
export function shouldFlipMenu(
  buttonRect: { top: number; bottom: number },
  menuHeight: number,
  containerRect: { top: number; bottom: number },
): boolean {
  const spaceBelow = containerRect.bottom - buttonRect.bottom;
  const spaceAbove = buttonRect.top - containerRect.top;
  // Fits below → never flip (the default, keeps the common case unchanged). Otherwise
  // flip only if above has more room, so a menu taller than BOTH gaps opens toward the
  // roomier side rather than always flipping.
  if (spaceBelow >= menuHeight) return false;
  return spaceAbove > spaceBelow;
}

/** Status pill — the Phase-A outline chip (semantic color, 40%-alpha border,
 *  leading dot). Kept as a named export: the pill markup is exercised directly. */
export function statusChip(status: DatasetSummary["status"]): ReactElement {
  return h("span", { className: `status-chip status-${status}` }, status);
}

/** Seam O3 (T2-104): the "updating" badge for a READY card that has an ACTIVE job
 *  (re-ingest / add-layouts re-baking a committed dataset — the ready-while-baking
 *  blindspot). ADDITIVE — the status literal stays "ready"; this is a separate accent
 *  chip that opens the activity panel. A button (not a span) so it is keyboard/click
 *  reachable. Named export: the badge markup is exercised directly. */
export function updatingBadge(onOpen?: () => void): ReactElement {
  return h(
    "button",
    {
      type: "button",
      className: "status-chip status-updating updating-badge",
      title: "A job is updating this dataset — open the activity panel",
      onClick: () => onOpen?.(),
    },
    "updating",
  );
}

/** The plain flat --surface media block — the fallback when a dataset has no cover
 *  (baked before T2-55, or the fetch failed) and the base for the processing/error
 *  states (which have no committed grid pyramid to cover from yet). */
function cardMediaBlock(dimmed: boolean): ReactElement {
  return h("div", { className: dimmed ? "card-media card-media-dim" : "card-media", "aria-hidden": "true" });
}

/**
 * Fetch a dataset's Library-card COVER blob (T2-55) WITH the identity bearer header —
 * the cover route is auth-gated (D-24), so a bare `<img src>` (which sends no
 * Authorization header) would 401. Returns the raw blob on 200 (the caller wraps it in
 * an object URL, never a token in a URL) or null on any non-ok (a 404 = no cover baked,
 * the graceful-absence case). Throws only on a transient network error, which the caller
 * treats as "no cover" too. Exported + dependency-injected (client + global fetch) so the
 * auth-header contract is unit-testable without a DOM renderer — mirroring
 * `cellPreview.fetchCellPreview`.
 */
export async function fetchCover(
  client: ApiClient,
  dsId: string,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const res = await globalThis.fetch(client.coverUrl(dsId), { headers: client.authHeaders(), signal });
  if (!res.ok) return null; // 404 (no cover baked) / any non-ok → flat-block fallback
  return res.blob();
}

/** The media area at the top of a READY card (T2-55): fetches the dataset's cover via
 *  `fetchCover` (bearer-authed), wraps the blob in an object URL, and renders it as the
 *  card image. On a 404 (no cover baked) or any error it falls back to the flat surface
 *  block (graceful). The object URL is a document-lifetime resource, so it is REVOKED on
 *  unmount and whenever the dataset id changes (mirroring the cell-preview lifecycle).
 *  A superseded fetch (dataset changed mid-flight, or the component unmounted) is
 *  ABORTED on cleanup, and never sets state or leaks its URL. */
function CardMedia(props: { client: ApiClient; dsId: string }): ReactElement {
  const { client, dsId } = props;
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    const ac = new AbortController(); // cancel an in-flight fetch on unmount / dataset change
    setCoverUrl(null); // reset while (re)fetching so a prior dataset's cover never lingers
    void (async () => {
      try {
        const blob = await fetchCover(client, dsId, ac.signal);
        if (!live || blob === null) return; // superseded before decode, or no cover
        objectUrl = URL.createObjectURL(blob);
        setCoverUrl(objectUrl);
      } catch {
        // Aborted (superseded / unmounted) or a network/decode error → flat-block fallback.
      }
    })();
    return () => {
      live = false;
      ac.abort(); // stop an in-flight cover fetch rather than let it complete and be discarded
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl); // don't leak the blob
    };
  }, [client, dsId]);

  if (coverUrl === null) return cardMediaBlock(false);
  return h(
    "div",
    { className: "card-media card-media-cover" },
    h("img", { className: "card-cover-img", src: coverUrl, alt: "" }),
  );
}

function layoutChips(layoutIds: string[]): ReactElement | null {
  if (layoutIds.length === 0) return null;
  return h(
    "div",
    { className: "card-chips" },
    layoutIds.map((id) => h("span", { key: id, className: "layout-chip" }, id)),
  );
}

/** First-run empty state: a dashed panel with the muted brand mark, a CLI hint,
 *  and the accent CTA. The mark is `muted` (zero accent) — "no accent until there's
 *  data" — so the CTA button stays the only accent on the screen (brief §2.5). */
function emptyState(onNewDataset: () => void): ReactElement {
  return h(
    "div",
    { className: "library-empty" },
    h(PlotlasMark, { size: 36, variant: "muted" }),
    h("p", { className: "empty-title" }, "Nothing plotted yet"),
    h(
      "p",
      { className: "muted" },
      "Point Plotlas at a folder to build your first atlas.",
    ),
    h(
      "code",
      { className: "cli-hint" },
      "pixscope ingest --images ./photos --dataset-id my_dataset",
    ),
    h(
      "button",
      { type: "button", className: "btn pri", onClick: onNewDataset },
      "+ New dataset",
    ),
  );
}

/** Anonymous public entry (D-34 consumer): the empty state for a visitor with NO account
 *  when the instance has published ZERO public datasets. An honest, friendly panel — not
 *  a blank page and not the owner's CLI hint (an anonymous visitor cannot ingest) — with
 *  the log-in affordance so they can sign in to see their own. */
function anonymousEmptyState(onLogin?: () => void): ReactElement {
  return h(
    "div",
    { className: "library-empty" },
    h(PlotlasMark, { size: 36, variant: "muted" }),
    h("p", { className: "empty-title" }, "No public datasets yet"),
    h(
      "p",
      { className: "muted" },
      "This Plotlas instance hasn’t published any public datasets yet. Check back soon — or log in to explore your own.",
    ),
    onLogin != null
      ? h("button", { type: "button", className: "btn pri", onClick: onLogin }, "Log in")
      : null,
  );
}

interface CardProps {
  ds: DatasetSummary;
  /** The API client, for the ready card's cover fetch (T2-55). */
  client: ApiClient;
  logOpen: boolean;
  onOpen: (dsId: string) => void;
  /** Open this collection in the designer — present only when the viewer owns it. */
  onEdit: ((dsId: string) => void) | null;
  /** Seam O3: open the activity panel from the "updating" badge. */
  onOpenActivity?: () => void;
  /** Anonymous public entry (D-34 consumer): READ-ONLY card — no `Edit`, no activity
   *  badge (owner/authenticated affordances). Only "Open" is offered. */
  readOnly?: boolean;
  setLogOpen: (open: boolean) => void;
}

/** A READY card's actions (`LibraryCard`): `Open` for everyone, and `Edit` beside it for
 *  the owner — two verbs, no popup. */
function readyActions(p: CardProps): ReactElement {
  return h(
    "div",
    { className: "card-actions" },
    h(
      "button",
      {
        type: "button",
        className: "btn pri",
        title: "Open in the viewer",
        onClick: () => p.onOpen(p.ds.dataset_id),
      },
      "Open",
    ),
    p.onEdit !== null
      ? h(
          "button",
          {
            type: "button",
            className: "btn",
            title: "Open in the layout designer",
            onClick: () => p.onEdit?.(p.ds.dataset_id),
          },
          "Edit",
        )
      : null,
    // Why `Edit` is here: a visitor who does not own the collection sees `Open` alone.
    p.onEdit !== null ? h("span", { className: "muted card-owner-note" }, "owner") : null,
  );
}

function processingActions(): ReactElement {
  return h(
    "div",
    { className: "card-actions" },
    h(
      "button",
      {
        type: "button",
        className: "btn ghost",
        disabled: true, // no action until the manifest commits (D-28)
        title: "Available once the dataset is ready",
      },
      "Open when ready",
    ),
  );
}

function errorActions(p: CardProps): ReactElement {
  return h(
    "div",
    { className: "card-actions" },
    h(
      "button",
      {
        type: "button",
        className: "btn ghost",
        "aria-expanded": p.logOpen,
        onClick: () => p.setLogOpen(!p.logOpen),
      },
      p.logOpen ? "Hide log" : "View log",
    ),
  );
}

function datasetCard(p: CardProps): ReactElement {
  const { ds } = p;
  const processing = ds.status === "processing";
  const errored = ds.status === "error";
  const meta = processing || errored
    ? `${ds.status} · created ${ds.ingest_timestamp}`
    : `${ds.image_count} images · v${ds.dataset_version}${ds.owner !== "" ? ` · ${ds.owner}` : ""}`;

  // Ready cards render the cover thumbnail (T2-55); processing/error cards have no
  // committed grid pyramid yet, so they keep the flat surface block (dimmed while
  // processing). CardMedia is a component (owns the fetch/objectURL lifecycle), so it
  // is created via `h(CardMedia, …)` — never called as a plain function.
  const media = processing || errored
    ? cardMediaBlock(processing)
    : h(CardMedia, { client: p.client, dsId: ds.dataset_id });

  return h(
    "article",
    // Named as the card names it (D-xxviii: a minted id is never a name, to a screen
    // reader either). The id stays discoverable as the name's tooltip and in Overview.
    { className: errored ? "card dataset-card card-error" : "card dataset-card", "aria-label": collectionName(ds) },
    media,
    h(
      "div",
      { className: "card-head" },
      // Part B: show what the collection is CALLED (collectionName: the display name,
      // else an authored id, else "Untitled collection" for a minted one).
      h("span", { className: "card-name", title: ds.dataset_id }, collectionName(ds)),
      statusChip(ds.status),
      // Seam O3 (T2-104): a "ready" dataset with an active job is being re-baked —
      // additively flag it (the status literal is unchanged) and let the badge open
      // the activity panel. `hasActiveJob` is shared with AdminScreen's refresh gate
      // (hasActiveWork) so this badge and the 5s auto-refresh cannot drift apart.
      // Anonymous public entry (D-34 consumer): the badge is an activity surface, so it
      // is suppressed for a read-only visitor (no activity panel to open).
      !p.readOnly && ds.status === "ready" && hasActiveJob(ds)
        ? updatingBadge(p.onOpenActivity)
        : null,
    ),
    // Part D §2: the source credit, under the name. Rendered ONLY when set — an empty
    // credit line is chrome pretending to be information. Becomes an anchor when
    // attribution_url is an absolute http(s) URL (§2b); a bad target loses the LINK,
    // never the credit. Shared with the viewer footer (attributionCredit) so both apply
    // one trim + link-safety rule.
    attributionCredit(ds.attribution, ds.attribution_url, "card-credit"),
    h("p", { className: "card-meta" }, meta),
    // Processing: an INDETERMINATE shimmer bar — never a fake %. The list
    // endpoint carries no progress fraction (brief §1f: never a fake bar).
    processing
      ? h(
          "div",
          { className: "progress-track", role: "progressbar", "aria-label": "Ingest progress (indeterminate)" },
          h("div", { className: "progress-indeterminate" }),
        )
      : null,
    // Error: the state is the only per-dataset signal the list endpoint carries
    // (no error string on DatasetSummary); the reveal exposes the log surface.
    errored && p.logOpen
      ? h(
          "pre",
          { className: "log-tail" },
          "Ingest did not finish. Inspect the job on the server (ingest.log); to retry, delete this dataset and create it again, or re-bake with the CLI (pixscope ingest).",
        )
      : null,
    layoutChips(ds.layout_ids),
    // Anonymous visitors get NO card actions on an errored card (PR #178 review
    // LOW-1): errorActions reveals the operator log tail + CLI/delete guidance —
    // operator affordances, meaningless and confusing to a read-only visitor.
    processing
      ? processingActions()
      : errored
        ? p.readOnly
          ? null
          : errorActions(p)
        : readyActions(p),
  );
}

export function DatasetList(props: DatasetListProps): ReactElement {
  const [logOpenId, setLogOpenId] = useState<string | null>(null);

  if (props.datasets.length === 0) {
    // Anonymous public entry (D-34 consumer): a read-only visitor with zero public
    // datasets gets the honest anonymous empty state (+ log-in), not the owner's CLI hint.
    return props.readOnly ? anonymousEmptyState(props.onLogin) : emptyState(props.onNewDataset);
  }

  const username = props.username ?? null;
  return h(
    "div",
    { className: "dataset-grid" },
    props.datasets.map((ds) =>
      h(
        "div",
        { key: ds.dataset_id },
        datasetCard({
          ds,
          client: props.client,
          logOpen: logOpenId === ds.dataset_id,
          onOpen: props.onOpen,
          onEdit:
            !props.readOnly && props.onEdit !== undefined && mayOpenDesigner(ds.owner, username)
              ? props.onEdit
              : null,
          onOpenActivity: props.onOpenActivity,
          readOnly: props.readOnly,
          setLogOpen: (open) => setLogOpenId(open ? ds.dataset_id : null),
        }),
      ),
    ),
  );
}

