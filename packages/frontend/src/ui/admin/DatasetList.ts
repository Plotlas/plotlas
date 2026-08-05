// Library board (design pass 1f): a gallery of dataset CARDS with a status pill,
// inline progress, a ⋯ action menu, and a first-run empty state (catalogue
// ui/admin required capabilities; R-25/R-26/R-27).
//
// Presentational: AdminScreen fetches the summaries and handles the client
// calls; the 409-while-running (and any other server message) arrives back as
// `error` text in the AdminScreen banner. Owner-action buttons render
// optimistically (identity-only JWT, D-24: authorization is never inferred
// client-side — the server's 403/409 answers are surfaced instead).
//
// State machines preserved: delete keeps the inline-confirm flow, relocated
// INSIDE the ⋯ menu popover (brief §2). Web re-ingest was removed (fix/reingest
// -safety): re-baking a committed dataset is CLI-only (`pixscope ingest`), so the
// card offers no re-ingest action.
//
// Seam-internal props. .ts + createElement, runtime imports bare-only (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createElement as h, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { DatasetSummary } from "../../api-client/types";
import { collectionName } from "../../api-client/types";
import { errText } from "../../api-client/errText";
import { PlotlasMark } from "../PlotlasMark.ts";
import { hasActiveJob } from "./datasetActivity.ts";
import { attributionCredit } from "../attributionCredit.ts";

export interface DatasetListProps {
  datasets: DatasetSummary[];
  /** The API client, used to fetch each ready card's cover thumbnail (T2-55). The
   *  cover route is auth-gated, so the fetch carries the bearer header and the blob is
   *  wrapped in an object URL — mirroring the cell-preview path (a bare `<img src>`
   *  would 401). */
  client: ApiClient;
  /** Dataset id with an action in flight (buttons disable). */
  busyId: string | null;
  onOpen: (dsId: string) => void;
  onDelete: (dsId: string) => void; // fired only after the inline confirm
  /** Open the full-screen add-layout WIZARD for a committed dataset (T2-92 Seam 1).
   *  Fired from the ⋯ menu's "Add layout" item; AdminScreen swaps in the AddLayoutWizard
   *  (RoleAssignmentForm pre-filled from the dataset's stored roles), replacing the old
   *  opaque inline type-checkbox picker. The wizard owns the enqueue + role override. */
  onAddLayout: (dsId: string) => void;
  /** Part B/D: commit a card's presentation edits. A null field CLEARS it (the name
   *  reverts to the raw `dataset_id`, the credit disappears) — the recovery path for a
   *  bad value. Presentation only: the id, its directory and any shared deep link are
   *  untouched.
   *
   *  RETURNS A PROMISE (§3): the editor stays open until it resolves, so a rejected
   *  write keeps the typed values on screen instead of discarding them. */
  onRename: (dsId: string, edits: DetailEdits) => Promise<void>;
  /** Route to the create wizard (empty-state CTA). */
  onNewDataset: () => void;
  /** Seam O3 (T2-104): open the activity panel from a ready-with-active-job card's
   *  "updating" badge. Optional — absent in the isolated component tests (the badge
   *  then renders inert). */
  onOpenActivity?: () => void;
  /** Anonymous public entry (D-34 consumer): render the READ-ONLY library — a visitor
   *  with no account browsing PUBLIC datasets. Suppresses every owner affordance (the
   *  ⋯ action menu and the activity "updating" badge) so a card shows only "Open", and
   *  swaps the first-run CLI empty state for the honest anonymous one. */
  readOnly?: boolean;
  /** Anonymous empty state's "Log in" affordance — opens the auth screen. Only used
   *  when `readOnly` and the public list is empty. */
  onLogin?: () => void;
}

/** Approximate height (px) reserved for the ⋯ dropdown when deciding whether to flip
 *  it upward (T2-89). The menu is short (Add layout / Delete) but the
 *  delete-confirm expands it, so this is a generous estimate — a card in the bottom row
 *  whose menu would overflow the grid's scroll container by more than a hair flips up.
 *  Not a layout constraint (the menu is CSS-sized), only the flip THRESHOLD. */
export const CARD_MENU_EST_HEIGHT = 180;

/** Decide whether the ⋯ dropdown should open UPWARD (T2-89). The menu opens downward by
 *  default (`top: 100%`), but a card in the BOTTOM row has its menu clipped by the
 *  dataset-grid's `overflow: auto` scroll container. Flip up when there is not enough
 *  room BELOW the button inside the container AND there is more room above — so the
 *  lower items (Delete, etc.) stay reachable for every row incl. the last. All inputs
 *  are viewport-space rects (getBoundingClientRect); `menuHeight` is the dropdown's
 *  estimated height. Pure + exported for unit tests. */
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
  busy: boolean;
  menuOpen: boolean;
  /** Open the ⋯ dropdown UPWARD (T2-89) — set for a bottom-row card whose downward
   *  menu would be clipped by the grid's scroll container. */
  menuFlipUp: boolean;
  confirming: boolean;
  logOpen: boolean;
  onOpen: (dsId: string) => void;
  onDelete: (dsId: string) => void;
  onAddLayout: (dsId: string) => void;
  /** Part B: open this card's inline rename editor (from the ⋯ menu). */
  onStartRename: (dsId: string) => void;
  /** Part B: true while THIS card's rename editor is open. */
  renaming: boolean;
  /** Part B/D: commit the edits. A null field CLEARS it. */
  onSubmitRename: (dsId: string, edits: DetailEdits) => void;
  /** Part D §3: a write is in flight for THIS card — inputs disable, Save shows it. */
  renameBusy: boolean;
  /** Part D §3: why the last write failed, shown inline so the typed values survive. */
  renameError: string | null;
  /** Part B: close the rename editor without saving. */
  onCancelRename: () => void;
  /** Seam O3: open the activity panel from the "updating" badge. */
  onOpenActivity?: () => void;
  /** Anonymous public entry (D-34 consumer): READ-ONLY card — no ⋯ menu, no activity
   *  badge (owner/authenticated affordances). Only "Open" is offered. */
  readOnly?: boolean;
  setMenuOpen: (open: boolean) => void;
  /** Record the flip direction for this card's ⋯ dropdown (T2-89). */
  setMenuFlip: (up: boolean) => void;
  setConfirming: (open: boolean) => void;
  setLogOpen: (open: boolean) => void;
}

/** The ⋯ menu popover for a READY card: Add layout + Delete (delete keeps the
 *  inline-confirm, now living inside the popover — brief §2). Opens downward by
 *  default; flips UPWARD (`card-menu-up`) for a bottom-row card whose downward menu
 *  would be clipped by the grid's scroll container (T2-89 — the flip is decided at
 *  open time from the button + container rects, see the onClick). */
function actionMenu(p: CardProps): ReactElement {
  const { ds } = p;
  const menuClass = p.menuFlipUp ? "card-menu card-menu-up" : "card-menu";
  return h(
    "div",
    { className: "card-menu-wrap" },
    h(
      "button",
      {
        type: "button",
        className: "btn ghost card-menu-btn",
        disabled: p.busy,
        "aria-haspopup": "menu",
        "aria-expanded": p.menuOpen,
        "aria-label": `Actions for ${ds.dataset_id}`,
        onClick: (e: { currentTarget: HTMLElement }) => {
          const opening = !p.menuOpen;
          // Decide the open direction from live geometry (T2-89): measure the ⋯ button
          // against its scroll container (.dataset-grid) so a bottom-row menu flips up
          // instead of being clipped. Guarded for the server render (no getBounding
          // ClientRect / closest) — it just stays the default downward there.
          if (opening && typeof e.currentTarget.getBoundingClientRect === "function") {
            const btn = e.currentTarget.getBoundingClientRect();
            const scroller = e.currentTarget.closest(".dataset-grid");
            const container = scroller !== null ? scroller.getBoundingClientRect() : btn;
            p.setMenuFlip(shouldFlipMenu(btn, CARD_MENU_EST_HEIGHT, container));
          }
          p.setMenuOpen(opening);
          p.setConfirming(false);
        },
      },
      "⋯",
    ),
    p.menuOpen
      ? h(
          "div",
          { className: menuClass, role: "menu" },
          h(
            "button",
            {
              type: "button",
              className: "menu-item",
              role: "menuitem",
              disabled: p.busy,
              // Launches the full-screen AddLayoutWizard (T2-92 Seam 1) — AdminScreen
              // swaps it in for this dataset; the wizard owns roles + enqueue.
              onClick: () => {
                p.setMenuOpen(false);
                p.onAddLayout(ds.dataset_id);
              },
            },
            "Add layout",
          ),
          // Part B/D: edit name, credit and credit-link in place, without leaving the
          // library. Opens the inline editor below; the menu closes so the form is not
          // trapped inside a popup that shuts on the next click.
          h(
            "button",
            {
              type: "button",
              className: "menu-item",
              role: "menuitem",
              disabled: p.busy,
              onClick: () => {
                p.setMenuOpen(false);
                p.onStartRename(ds.dataset_id);
              },
            },
            "Edit details…",
          ),
          p.confirming
            ? h(
                "div",
                { className: "menu-confirm", role: "alertdialog" },
                // Part D §2c: name it as the card does — this is the one dialog where
                // you must be certain WHICH collection you are destroying, so it must
                // not use a different label from the card you just clicked.
                h("span", { className: "muted" }, `Delete “${collectionName(ds)}”?`),
                h(
                  "div",
                  { className: "menu-confirm-actions" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "btn danger",
                      disabled: p.busy,
                      onClick: () => {
                        p.setMenuOpen(false);
                        p.setConfirming(false);
                        p.onDelete(ds.dataset_id);
                      },
                    },
                    "Confirm delete",
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "btn ghost",
                      onClick: () => p.setConfirming(false),
                    },
                    "Cancel",
                  ),
                ),
              )
            : h(
                "button",
                {
                  type: "button",
                  className: "menu-item menu-item-danger",
                  role: "menuitem",
                  disabled: p.busy,
                  onClick: () => p.setConfirming(true),
                },
                "Delete",
              ),
        )
      : null,
  );
}

function readyActions(p: CardProps): ReactElement {
  return h(
    "div",
    { className: "card-actions" },
    h(
      "button",
      {
        type: "button",
        className: "btn pri",
        disabled: p.busy,
        title: "Open in the viewer",
        onClick: () => p.onOpen(p.ds.dataset_id),
      },
      "Open",
    ),
    // Anonymous public entry (D-34 consumer): the ⋯ menu carries owner actions
    // (Add layout / Delete), so it is omitted entirely for a read-only visitor.
    p.readOnly ? null : actionMenu(p),
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
    { className: errored ? "card dataset-card card-error" : "card dataset-card", "aria-label": ds.dataset_id },
    media,
    h(
      "div",
      { className: "card-head" },
      // Part B: show what the collection is CALLED, falling back to its id. The id
      // stays in the card's aria-label above and in the meta line below, so it never
      // becomes undiscoverable — it is what the deep link and the CLI both need.
      p.renaming
        ? detailsEditor(ds, p.onSubmitRename, p.onCancelRename, p.renameBusy, p.renameError)
        : h("span", { className: "card-name", title: ds.dataset_id }, collectionName(ds)),
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

/** The three presentation fields a card can edit (Part D §2/§2b). Ordered as they
 *  appear in the editor. `max` mirrors the API's caps — the server still validates. */
const DETAIL_FIELDS = [
  {
    name: "display_name" as const,
    label: "Name",
    placeholder: "Leave empty to show the id",
    max: 120,
  },
  {
    name: "attribution" as const,
    label: "Attribution",
    placeholder: "e.g. Rijksmuseum, Amsterdam",
    max: 200,
  },
  {
    name: "attribution_url" as const,
    label: "Attribution link",
    placeholder: "https://… (optional)",
    max: 500,
  },
] as const;

/** The presentation fields a card can edit — the keys of the API's PRESENTATION_LIMITS. */
export type PresentationField = "display_name" | "attribution" | "attribution_url";

/** A card's presentation edits: ONLY the fields the user actually changed
 *  (partial-by-key-presence, exactly what the API consumes). An omitted field is left
 *  alone — so a name edit never clobbers an attribution changed out-of-band — and a field
 *  present as `null` CLEARS it. */
export type DetailEdits = Partial<Record<PresentationField, string | null>>;

/** The inline details editor (Part B/D), shown in place of the card name.
 *
 *  Submitting a field EMPTY clears it — the name falls back to the raw id, the credit
 *  disappears. That is the recovery path for a bad value, so the placeholder says so
 *  rather than hiding it. Escape cancels, so the editor is never a trap.
 *
 *  Sends ONLY the fields whose value the user actually CHANGED (diffed against what the
 *  editor was seeded with), so a name edit cannot clobber an attribution changed
 *  out-of-band, and a future fourth field cannot silently render-but-not-save. Nothing
 *  changed ⇒ an empty edit, which the caller treats as a close.
 *
 *  §3: it does NOT close itself. The caller closes it only when the write RESOLVES, so
 *  a 403 or a dropped connection leaves the typed values on screen with the reason
 *  inline — instead of discarding them and showing a banner somewhere else. While the
 *  write is in flight the inputs are READ-ONLY rather than disabled: a disabled field
 *  blurs to <body>, losing a keyboard user's place, whereas read-only keeps focus while
 *  still blocking edits and re-submits. */
function detailsEditor(
  ds: DatasetSummary,
  onSubmit: (dsId: string, edits: DetailEdits) => void,
  onCancel: () => void,
  busy: boolean,
  error: string | null,
): ReactElement {
  return h(
    "form",
    {
      className: "card-rename",
      onSubmit: (e: { preventDefault: () => void; currentTarget: HTMLFormElement }) => {
        e.preventDefault();
        if (busy) return; // a save is already in flight (Enter in a read-only field)
        const read = (name: string): string | null => {
          const el = e.currentTarget.elements.namedItem(name);
          const value = el !== null ? (el as HTMLInputElement).value.trim() : "";
          return value === "" ? null : value;
        };
        // Diff each field against its seeded (server-stored) value; include only the
        // ones that changed. Derived from DETAIL_FIELDS so the payload cannot drift from
        // the rendered inputs.
        const edits: DetailEdits = {};
        for (const field of DETAIL_FIELDS) {
          const next = read(field.name);
          const raw = (ds[field.name] ?? "").trim();
          const seeded = raw === "" ? null : raw;
          if (next !== seeded) edits[field.name] = next;
        }
        onSubmit(ds.dataset_id, edits);
      },
    },
    ...DETAIL_FIELDS.map((field) =>
      h("input", {
        key: field.name,
        type: "text",
        name: field.name,
        className: "card-rename-input",
        defaultValue: ds[field.name] ?? "",
        placeholder: field.placeholder,
        "aria-label": `${field.label} for ${ds.dataset_id}`,
        autoFocus: field.name === "display_name",
        readOnly: busy,
        maxLength: field.max,
        onKeyDown: (e: { key: string; preventDefault: () => void }) => {
          if (e.key === "Escape" && !busy) {
            e.preventDefault();
            onCancel();
          }
        },
      }),
    ),
    // The failure reason lives IN the editor, beside the values it rejected — a
    // top-level banner would explain a form the user can no longer see.
    error !== null
      ? h("p", { className: "error-text", role: "alert", key: "err" }, error)
      : null,
    h(
      "button",
      { type: "submit", className: "btn small", disabled: busy },
      busy ? "Saving…" : "Save",
    ),
    h(
      "button",
      { type: "button", className: "btn ghost small", onClick: onCancel, disabled: busy },
      "Cancel",
    ),
  );
}

export function DatasetList(props: DatasetListProps): ReactElement {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // The card (if any) whose ⋯ dropdown should open UPWARD (T2-89 — a bottom-row card
  // whose downward menu would be clipped by the grid's scroll container).
  const [menuFlipUpId, setMenuFlipUpId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [logOpenId, setLogOpenId] = useState<string | null>(null);
  // Part D §3: the ONE card whose details editor is open — its id, whether a write is in
  // flight, and why the last write failed. A single object (not three parallel
  // useStates) so "which card, busy, error" is one fact: a save that resolves after the
  // user opened a DIFFERENT card's editor cannot close or stamp the wrong one, because
  // every async continuation guards on `editing?.dsId === dsId` before touching it.
  const [editing, setEditing] = useState<{
    dsId: string;
    busy: boolean;
    error: string | null;
  } | null>(null);

  if (props.datasets.length === 0) {
    // Anonymous public entry (D-34 consumer): a read-only visitor with zero public
    // datasets gets the honest anonymous empty state (+ log-in), not the owner's CLI hint.
    return props.readOnly ? anonymousEmptyState(props.onLogin) : emptyState(props.onNewDataset);
  }

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
          busy: props.busyId === ds.dataset_id,
          menuOpen: menuOpenId === ds.dataset_id,
          menuFlipUp: menuFlipUpId === ds.dataset_id,
          confirming: confirmingId === ds.dataset_id,
          logOpen: logOpenId === ds.dataset_id,
          onOpen: props.onOpen,
          onDelete: props.onDelete,
          onAddLayout: props.onAddLayout,
          onOpenActivity: props.onOpenActivity,
          readOnly: props.readOnly,
          renaming: editing?.dsId === ds.dataset_id,
          renameBusy: editing !== null && editing.dsId === ds.dataset_id && editing.busy,
          renameError:
            editing !== null && editing.dsId === ds.dataset_id ? editing.error : null,
          onStartRename: (dsId) => setEditing({ dsId, busy: false, error: null }),
          onCancelRename: () => setEditing(null),
          // §3: close ONLY when the write resolves. On failure the editor stays open with
          // the typed values and the reason inline. Each continuation guards on the dsId
          // it was launched for, so a save that settles after the user switched to a
          // DIFFERENT card's editor cannot close or stamp that other card.
          onSubmitRename: (dsId, edits) => {
            if (Object.keys(edits).length === 0) {
              setEditing(null); // nothing changed — close without a no-op write (422)
              return;
            }
            setEditing({ dsId, busy: true, error: null });
            void props
              .onRename(dsId, edits)
              .then(() => setEditing((cur) => (cur?.dsId === dsId ? null : cur)))
              .catch((err: unknown) =>
                setEditing((cur) =>
                  cur?.dsId === dsId ? { dsId, busy: false, error: errText(err) } : cur,
                ),
              );
          },
          setMenuOpen: (open) => {
            setMenuOpenId(open ? ds.dataset_id : null);
            if (!open) {
              setConfirmingId(null);
              setMenuFlipUpId(null); // reset the flip when the menu closes
            }
          },
          setMenuFlip: (up) => setMenuFlipUpId(up ? ds.dataset_id : null),
          setConfirming: (open) => setConfirmingId(open ? ds.dataset_id : null),
          setLogOpen: (open) => setLogOpenId(open ? ds.dataset_id : null),
        }),
      ),
    ),
  );
}
