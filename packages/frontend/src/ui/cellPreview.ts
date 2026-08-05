// Resolve a clicked cell's full-resolution preview (MetadataPanel).
//
// v2 (decision D-33): the renderer no longer crops an atlas page — the click-
// through preview is the cell's individual DETAIL-tier original, addressed by
// DENSE cell id at `GET /api/datasets/{ds}/detail/{cell_id}.{ext}`. The extension
// comes from the layout's `detail.format` (mode `image_ref`). When the dataset
// baked no detail tier (no layout declares an `image_ref` detail block), there is
// no preview — the panel simply shows none.
//
// This is a pure URL resolution from the manifest — no tile scan, no round-trip
// to find a UV rect (the v1 cost). The detail route is auth-gated, so the viewer
// shell (ViewerScreen.resolvePreview) fetches this URL WITH the identity bearer
// header and hands MetadataPanel's <img> an object URL — a bare <img src> would
// 401 (#32). An absent original for a cell just yields no preview.
import type { ApiClient } from "../api-client/client";
import type { DetailDescriptor, LayoutEntry, LayoutManifest } from "../renderer/layout";
import type { CellPreviewData } from "./MetadataPanel";

/** Default detail-image extension when a detail block omits `format`. */
const DEFAULT_DETAIL_EXT = "webp";

/**
 * The detail descriptor the renderer can resolve into a per-cell image URL: the
 * first layout with an `image_ref` detail block (Phase 1; `pmtiles` mode is
 * reserved). Returns null when no layout declares one — the dataset has no detail
 * tier, so there is no click-through preview. Pure + exported for unit tests.
 */
export function detailForManifest(manifest: LayoutManifest): DetailDescriptor | null {
  for (const layout of manifest.layouts as LayoutEntry[]) {
    const detail = layout.detail;
    if (detail !== undefined && detail !== null && detail.mode === "image_ref") return detail;
  }
  return null;
}

/**
 * Resolve a clicked cell's preview to the detail-tier original URL, or null when
 * the dataset baked no `image_ref` detail tier. v2: no tile scan and no fetch —
 * the URL is composed from the dense cell id + the layout's `detail.format`, and
 * the <img> resolves it (gracefully 404-ing when that cell's original is absent).
 */
export function resolveCellPreview(
  client: ApiClient,
  manifest: LayoutManifest,
  _layoutId: string,
  cellId: number,
): CellPreviewData | null {
  const detail = detailForManifest(manifest);
  if (detail === null) return null;
  const ext = detail.format ?? DEFAULT_DETAIL_EXT;
  return {
    cellId,
    imageUrl: client.detailUrl(manifest.dataset_id, cellId, ext),
  };
}

/** The outcome of fetching a cell's detail-tier original. The caller owns the
 *  object-URL lifecycle (it holds the React state + supersede guards), so this
 *  hands back the raw blob on success and a tagged status otherwise:
 *   - `none`         — no `image_ref` detail tier baked; there is no preview.
 *   - `unauthorized` — a 401; the caller routes it to onAuthExpired like every
 *                      other API call (the detail route is auth-gated — D-24).
 *   - `absent`       — a non-ok (typically 404): the cell has no baked original.
 *                      Not an error, and not cached, so the next click retries.
 *   - `image`        — the decoded blob, to be wrapped in an object URL. */
export type CellPreviewFetch =
  | { kind: "none" }
  | { kind: "unauthorized" }
  | { kind: "absent" }
  | { kind: "image"; blob: Blob };

/**
 * Fetch a clicked cell's DETAIL-tier original WITH the identity bearer header
 * (#32): the route is auth-gated, so a bare `<img src>` — which sends no
 * Authorization header — 401s. Returns the raw blob (the caller wraps it in an
 * object URL, never a token in a URL), or a tagged status. Throws only on a
 * transient network/decode error, which the caller does not cache so a later
 * click retries. Exported + dependency-injected (client + global fetch) so the
 * auth-header contract is unit-testable without the GL-bound viewer shell.
 */
export async function fetchCellPreview(
  client: ApiClient,
  manifest: LayoutManifest,
  cellId: number,
  signal?: AbortSignal,
): Promise<CellPreviewFetch> {
  const resolved = resolveCellPreview(client, manifest, "", cellId);
  if (resolved === null) return { kind: "none" }; // no detail tier → no network round-trip
  const res = await globalThis.fetch(resolved.imageUrl, { headers: client.authHeaders(), signal });
  if (res.status === 401) return { kind: "unauthorized" };
  if (!res.ok) return { kind: "absent" };
  return { kind: "image", blob: await res.blob() };
}

/** Default cap for the viewer's per-cell preview cache. Each entry pins a decoded
 *  original (via an object URL) in memory, so the set is bounded — without a cap a
 *  click-through of the whole dataset would retain every viewed original. */
export const PREVIEW_CACHE_MAX = 16;

/** A bounded LRU cache of cell previews. Every entry owns an object URL — a
 *  document-lifetime resource — so eviction, same-cell replacement, and clear()
 *  all REVOKE the outgoing URL; otherwise each clicked cell would leak a blob
 *  (#32). `get` refreshes recency so a revisited cell is not the next evicted. */
export interface PreviewCache {
  get(cellId: number): CellPreviewData | undefined;
  put(data: CellPreviewData): void;
  clear(): void;
  readonly size: number;
}

export function createPreviewCache(max: number = PREVIEW_CACHE_MAX): PreviewCache {
  const map = new Map<number, CellPreviewData>();
  return {
    get(cellId: number): CellPreviewData | undefined {
      const hit = map.get(cellId);
      if (hit !== undefined) {
        // Move to the most-recent end so a revisited cell survives eviction.
        map.delete(cellId);
        map.set(cellId, hit);
      }
      return hit;
    },
    put(data: CellPreviewData): void {
      const prior = map.get(data.cellId);
      if (prior !== undefined) URL.revokeObjectURL(prior.imageUrl); // replace same cell: don't leak
      map.delete(data.cellId);
      map.set(data.cellId, data);
      while (map.size > max) {
        const oldest = map.keys().next().value as number; // size>max ⇒ at least one entry
        const evicted = map.get(oldest);
        if (evicted !== undefined) URL.revokeObjectURL(evicted.imageUrl);
        map.delete(oldest);
      }
    },
    clear(): void {
      for (const p of map.values()) URL.revokeObjectURL(p.imageUrl);
      map.clear();
    },
    get size(): number {
      return map.size;
    },
  };
}
