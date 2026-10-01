// The props contract between the designer SHELL (seam L3) and the views plugged into it
// (seam L4 `data.ts`, seam L5 `layouts.ts`). Documented for those seams in
// docs/design/layout-designer/CONTRACT.md — this file is the type, that one is the why.
//
// The shell owns every fetch a view needs to render, the pending-change model, and the
// commit bar. A view owns its own screen and writes back through the callbacks below. A
// view never re-fetches what it was handed, and never keeps a second copy of the pending
// model: two copies of thirty edits is how one of them gets lost.
//
// Types only — nothing here renders.
import type { ReactElement } from "react";
import type { ApiClient } from "../../api-client/client";
import type { ColumnListResponse, DatasetSummary, LayoutInfo } from "../../api-client/types";
import type { Presentation } from "../../generated/presentation";
import type { LayoutManifest } from "../../renderer/layout";
import type { DesignerTab } from "../urlState";
import type { PendingDerivation, PendingState } from "./pending";

/** What every designer view receives. */
export interface DesignerViewProps {
  client: ApiClient;
  /** The collection, already verified to belong to the signed-in user. Refreshed by
   *  `reload`; a rename made in Overview is reflected here immediately. */
  dataset: DatasetSummary;
  /** The committed layout manifest. Any layout's manifest carries the same dataset-level
   *  `column_roles`, `dataset_metadata` and `tags`; the shell reads the first live one. */
  manifest: LayoutManifest;
  /** `GET .../layouts?include_pending=true`: committed layouts first (state "live"), then
   *  the in-flight ones (state "queued"/"baking", label = id, type ""). Labels are the
   *  EFFECTIVE ones — presentation overrides applied (`layoutsWithLabels`). */
  layouts: LayoutInfo[];
  /** The effective presentation record (`GET .../presentation`); `{}` when there is none. */
  presentation: Presentation;
  /** `GET .../columns`. Null while loading or when the read failed (`columnsError`). Read
   *  `columns.source`, never `columns.columns.length`. */
  columns: ColumnListResponse | null;
  columnsError: string | null;
  /** The pending-change model. Never mutate it: build the next state with pending.ts's
   *  functions (`withDraft`, `addBake`, `removeBake`, `discardPending`) and hand it to
   *  `onPendingChange`. */
  pending: PendingState;
  /** `derivePending(pending, layouts)`, computed once by the shell per change. The four
   *  role-change outcomes per layout live here (`outcomeFor(derived, layout_id)`). */
  derived: PendingDerivation;
  /** Replace the pending model. The shell persists it (per collection, per base) and the
   *  commit bar re-prices from it. */
  onPendingChange: (next: PendingState) => void;
  /** A free edit landed: hand the shell the presentation record as it now stands, so
   *  every view (and the header's name) shows it without a re-fetch. Call it only after
   *  the PATCH resolved — the record is the SERVER's, not a draft.
   *
   *  Either the whole record, or an UPDATER `(prev) => next` the shell applies to its
   *  CURRENT record, as React's `setState` does. A view whose saves can land after it has
   *  unmounted, or after another view changed the record, passes an updater that applies
   *  only its own key — a whole record from a stale snapshot would overwrite what changed
   *  since (final review of #384). */
  onPresentationChange: (next: Presentation | ((prev: Presentation) => Presentation)) => void;
  /** The dataset summary changed (a PATCH echo, typically the name). */
  onDatasetChange: (next: DatasetSummary) => void;
  /** Re-read the dataset, layouts, manifest, presentation and columns — after a job a
   *  view started has landed. A draft whose base moved is dropped on the way. */
  reload: () => void;
  /** Switch the designer's tab. */
  onNavigate: (tab: DesignerTab) => void;
  /** A 401: the session is gone. */
  onAuthExpired: () => void;
}

/** A designer view: `DataView` in `data.ts` (seam L4), `LayoutsView` in `layouts.ts`
 *  (seam L5). */
export type DesignerView = (props: DesignerViewProps) => ReactElement;

/** The review sheet the bar's *Review & commit* opens (D-xxi: every bake passes through
 *  it). Seam L5 supplies it as `CommitReview` from `layouts.ts`; until then that export
 *  is null and the button stays disabled. `onClose` dismisses the sheet; after a commit,
 *  L5 also discards what it committed (`onPendingChange`) and calls `reload`. */
export type CommitReviewView = (props: DesignerViewProps & { onClose: () => void }) => ReactElement;
