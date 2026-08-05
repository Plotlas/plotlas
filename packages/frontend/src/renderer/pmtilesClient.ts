// PMTiles client wrapper for the v2 spatial tile pyramid (decision D-33).
//
// Each layout's whole pyramid is one immutable PMTiles container. The renderer's
// api-client (client.pyramidUrl) resolves it to the STATIC Caddy path
// (/datasets/{ds}/{pyramid.path}) once the manifest is cached — matching prod and
// skipping a per-range FastAPI hop — and falls back to GET
// /api/datasets/{ds}/pyramid/{layout_id}.pmtiles pre-manifest. Either endpoint
// answers HTTP Range with 206 Partial Content (Caddy file_server / Starlette
// FileResponse). The `pmtiles` npm client seeks individual {z}/{x}/{y} tiles inside
// that container via byte-range reads; we give it a custom Source that issues those
// reads with `fetch` so the bearer token (identity-only JWT, D-24) rides along —
// the static Caddy path ignores it, the dev FastAPI fallback requires it.
//
// This module is the thin transport boundary: it owns the AbortSignal-cancellable
// range fetch and the PMTiles handle, nothing else. Tile-body framing lives in
// tileBundle.ts; residency/level-selection in tilePyramid.ts.
//
// T2-09 residual (D-i addendum): these range reads hit the STATIC Caddy edge,
// which the D-A gate protects with a 1-hour `viz_ds` cookie re-issued on every
// authed manifest GET. On a stale tab (>1h on one dataset with no re-open) that
// cookie expires and every range read 401s at once (a whole viewport). The Source
// takes an optional single-flight `refreshCredential` capability: on a 401 it
// awaits ONE credential refresh (a manifest re-open re-issues the cookie) and
// retries the read ONCE. The refresh is coalesced + cooldown-guarded by the caller
// (the api-client), so a viewport of concurrent 401s shares one manifest GET and a
// still-401ing read after a fresh refresh falls through to the loader's normal
// failure path (T2-44 backoff) instead of looping.
import { EtagMismatch, PMTiles, SharedPromiseCache } from "pmtiles";
import type { RangeResponse, Source } from "pmtiles";

// PERF: the pmtiles default directory cache holds only ~100 entries. A large
// pyramid (100k -> 7 levels, 1M -> 8) has many leaf directories, so sustained
// panning can evict then re-fetch leaf dirs, adding intermittent 2x request
// amplification per tile. Size the cache generously — directory entries are
// small, and the container is immutable so cached dirs never go stale.
const PMTILES_DIR_CACHE_ENTRIES = 1024;

/** A decoded tile body (the raw bytes the PMTiles container stored for a
 *  {z}/{x}/{y}), or null when the container has no tile there (the loader then
 *  draws the parent — the one fallback rule). */
export type TileBytes = Uint8Array | null;

/** A single-flight static-edge credential refresh (T2-09 residual): re-issue the
 *  `viz_ds` cookie for the pyramid's dataset by re-opening its manifest, so a 401'd
 *  range read can retry ONCE. Resolves `true` when the credential was refreshed (a
 *  retry may proceed), `false` when it was NOT (cooldown in effect / re-open
 *  failed) — then the read fails through the loader's normal path. Concurrent 401s
 *  coalesce onto one refresh in the implementation (api-client). */
export type RefreshCredential = () => Promise<boolean>;

/**
 * A pmtiles `Source` backed by `fetch` against a single immutable URL, attaching
 * the bearer header and translating an (offset, length) into a `Range` request.
 * One per layout pyramid; the URL embeds the dataset version so it is
 * immutable-cacheable.
 *
 * WHY THIS SENDS NO `If-Match` (T2-199, 2026-08-05). It used to. That header made
 * every range read bypass the browser cache entirely, and it broke tiles outright
 * after a collection was copied between hosts:
 *
 *   * The WHATWG Fetch Standard sets a request's cache mode to `no-store` — no
 *     cache read AND no cache write — whenever it carries `If-Match`, `If-Range`,
 *     `If-None-Match`, `If-Modified-Since` or `If-Unmodified-Since`. This Source
 *     passes no explicit `cache:` option, so that one header alone flipped the mode.
 *     RFC 9111 §4.3.2 says the same from the cache's side: "The If-Match and
 *     If-Unmodified-Since conditional header fields are not applicable to a cache."
 *     MEASURED before removal (40 x 64 KB re-read of a real archive): with the
 *     header 0/40 requests served from cache and 2572 KB over the network; without
 *     it 17/40 from cache and 1415 KB. ~45 % more bytes on every revisit.
 *   * Caddy's ETag is derived from mtime+size, so COPYING a dataset changes it while
 *     the bytes are identical. A client holding the old etag then got 412 on every
 *     tile. That is the documented backup path (ARCHITECTURE.md: "back up by copying
 *     the folder") and the demo-host transfer flow (RELEASE_READINESS §4).
 *   * `If-Range` is not a safer swap: same `no-store` override, and on a mismatch the
 *     server answers with the WHOLE archive as 200 — which the guard below rejects.
 *
 * The upstream pmtiles `FetchSource` reaches the same conclusion in its own comment
 * ("we don't send if match because: it disables browser caching completely
 * (Chromium) ... it requires a preflight request for every tile request").
 *
 * What replaces it: the response-etag comparison at the end of getBytes, which is
 * upstream's design. It detects the same archive-changed condition without a
 * conditional REQUEST header, so the cache keeps working — and recovers better,
 * because `EtagMismatch` makes the pmtiles client re-read its directories rather
 * than just failing the tile.
 *
 * Note this project makes the whole scenario near-unreachable anyway: a re-ingest
 * allocates a NEW `dataset_version` before writing and refuses to overwrite a
 * committed one (worker.py `_commit`: "version lives in every asset path, so new and
 * old versions never collide"), and `refresh-manifest` never touches tiles. A given
 * `_v{N}.pmtiles` URL is written once.
 *
 * Exported (as the `Source` it implements — see createRangeSource) so the 401 →
 * credential-refresh → retry behavior (T2-09 residual) can be unit-tested at the
 * range-read seam directly, without standing up a valid PMTiles container just to
 * reach getBytes through PMTiles.getZxy.
 */
export class FetchRangeSource implements Source {
  private readonly url: string;
  private readonly getAuthHeaders: () => Record<string, string>;
  private readonly refreshCredential: RefreshCredential | undefined;

  constructor(
    url: string,
    getAuthHeaders: () => Record<string, string>,
    refreshCredential?: RefreshCredential,
  ) {
    this.url = url;
    this.getAuthHeaders = getAuthHeaders;
    this.refreshCredential = refreshCredential;
  }

  getKey(): string {
    return this.url;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ): Promise<RangeResponse> {
    const doFetch = (): Promise<Response> => {
      // Auth headers are rebuilt per attempt so a token refresh is picked up; the
      // static edge ignores the bearer and gates on the `viz_ds` cookie (which
      // rides same-origin automatically), so the retry's win is the fresh cookie.
      const headers: Record<string, string> = {
        ...this.getAuthHeaders(),
        Range: `bytes=${offset}-${offset + length - 1}`,
      };
      // NO `If-Match` here — deliberately. See the block comment above getBytes.
      return fetch(this.url, { headers, signal });
    };
    let res = await doFetch();
    // T2-09 residual (D-i addendum): a 401 on the static edge means the stale-tab
    // `viz_ds` cookie expired. Refresh the credential (single-flight — a whole
    // viewport of tiles expiring together shares ONE manifest re-open) and retry
    // ONCE. A refusal (cooldown / failed re-open) or a post-refresh 401 falls
    // through to the throw below → the loader's bounded retry / coarse fallback.
    // A fetch aborted mid-flight rejects (never resolves with 401), so the only
    // supersede to guard is one landing DURING the awaited refresh — re-check the
    // signal after it and skip the retry fetch if so.
    if (
      res.status === 401 &&
      this.refreshCredential !== undefined &&
      (await this.refreshCredential())
    ) {
      if (signal?.aborted === true) {
        // Superseded (a pan/zoom/layout-switch) while the refresh was in flight —
        // do not issue the retry; let the aborted-load path drop this read.
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }
      res = await doFetch();
    }
    // The pmtiles client does NOT re-slice `data` — it trusts this Source to
    // return EXACTLY the requested [offset, offset+length) bytes (its own
    // FetchSource throws on a non-compliant 200). So:
    //   * 206 Partial Content — the body IS the requested range. Correct.
    //   * 200 OK — the server ignored Range and returned the WHOLE file. That is
    //     only the requested slice when offset==0 AND the whole file fits within
    //     `length` (a tiny container read in one shot). Otherwise the body is NOT
    //     the slice and feeding it to the tile/directory decoder corrupts reads —
    //     so mirror the library and reject it loudly rather than silently mis-read.
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`pyramid range fetch failed: ${res.status} ${res.statusText} for ${this.url}`);
    }
    const data = await res.arrayBuffer();
    if (res.status === 200 && (offset > 0 || data.byteLength > length)) {
      throw new Error(
        `pyramid range fetch got 200 (server ignored Range) with ${data.byteLength} bytes for a ` +
          `${length}-byte read at offset ${offset}; the body is not the requested slice. ${this.url} ` +
          `must support HTTP range requests (206 Partial Content).`,
      );
    }
    const respEtag = res.headers.get("etag") ?? undefined;
    // Archive-changed detection, upstream's way (T2-199): compare the etag the server
    // ECHOED against the one the caller expected, instead of asking the server to
    // enforce it with `If-Match`. Throwing `EtagMismatch` is not an error path — the
    // pmtiles client catches it in getZxy/getMetadata, drops its cached header +
    // directories, and retries the read ONCE with `cache: "reload"`, which is a
    // stronger recovery than a 412 (that just fails the tile).
    //
    // Only compare when BOTH sides have an etag: a server that omits it is not a
    // mismatch, and inventing one would break every read.
    if (etag !== undefined && respEtag !== undefined && respEtag !== etag) {
      throw new EtagMismatch(
        `pyramid etag changed for ${this.url} (expected ${etag}, got ${respEtag})`,
      );
    }
    const cacheControl = res.headers.get("cache-control") ?? undefined;
    const expires = res.headers.get("expires") ?? undefined;
    return { data, etag: respEtag, cacheControl, expires };
  }
}

/** Build the `fetch`-backed pmtiles `Source` for `url` (bearer header + range
 *  request + the T2-09 401→refresh→retry). Exposed for unit tests of the retry
 *  seam; production wraps it in a PMTiles handle via openPyramidArchive. */
export function createRangeSource(
  url: string,
  getAuthHeaders: () => Record<string, string>,
  refreshCredential?: RefreshCredential,
): Source {
  return new FetchRangeSource(url, getAuthHeaders, refreshCredential);
}

/** Handle to one layout's pyramid container, opened lazily. Wraps the pmtiles
 *  archive reader and exposes a single typed `getTile(z, x, y)` returning the raw
 *  tile body (or null on a miss). */
export interface PyramidArchive {
  /** Fetch the raw body of tile {z}/{x}/{y}, or null when the container holds no
   *  tile there (the loader falls back to the parent). AbortSignal-cancellable. */
  getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<TileBytes>;
}

/**
 * Open a layout's PMTiles pyramid at `url`, attaching the bearer header to every
 * range read. The header set is read fresh per request (via `getAuthHeaders`) so
 * a token refresh is picked up without recreating the archive. `refreshCredential`
 * (T2-09 residual) is an optional single-flight static-edge cookie refresh: on a
 * 401 the range read re-issues the `viz_ds` cookie and retries once — see
 * FetchRangeSource. Omitted ⇒ a 401 fails straight through (the prior behavior).
 */
export function openPyramidArchive(
  url: string,
  getAuthHeaders: () => Record<string, string>,
  refreshCredential?: RefreshCredential,
): PyramidArchive {
  const pmtiles = new PMTiles(
    new FetchRangeSource(url, getAuthHeaders, refreshCredential),
    new SharedPromiseCache(PMTILES_DIR_CACHE_ENTRIES),
  );
  return {
    async getTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<TileBytes> {
      const range: RangeResponse | undefined = await pmtiles.getZxy(z, x, y, signal);
      if (range === undefined) return null; // no tile at this address → draw the parent
      return new Uint8Array(range.data);
    },
  };
}
