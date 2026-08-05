// Catalogued viewer component (props verbatim — interface-catalogue.md).
//
// Fields come from getMetadata (scalar-only by design — D-21); tag chips come
// from the D-14 sidecar table, NEVER from getMetadata; the image preview is a
// plain <img> of the cell's full-resolution DETAIL-tier original (v2 / D-33 —
// addressed by dense cell id at /detail/{cell_id}.{ext}; the v1 atlas-page crop
// is gone). The catalogued props carry neither the sidecar table nor the preview,
// so the viewer shell provides both through MetadataPanelDataContext (plain data
// — renderToString-friendly).
//
// .ts + createElement, runtime imports bare-only: see LayoutSwitcher.ts (the
// node test runner cannot load JSX/.tsx or extensionless src specifiers).
import { createContext, createElement as h, useContext, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type { Table } from "apache-arrow";
import type { ApiClient } from "../api-client/client";
import type { MetadataRow } from "../api-client/types";
import { sourceUrl } from "./sourceLink";

export interface MetadataPanelProps {
  dataset: string;
  selectedCellId: number | null;
  client: ApiClient;
  /** Schema v2.8 `column_roles.url` from the manifest — the columns to render as links.
   *  Threaded from the viewer shell, which already holds the manifest. */
  urlColumns?: string[];
}

/** A full-resolution preview of one cell: the URL of its DETAIL-tier original
 *  (v2 / D-33), addressed by dense cell id. Resolved by the viewer shell (see
 *  ui/cellPreview.ts); null when the dataset baked no detail tier. */
export interface CellPreviewData {
  cellId: number;
  imageUrl: string;
}

export interface MetadataPanelData {
  /** The fetched D-14 tag sidecar table (shared with TagControls); null when
   *  the dataset has none or it failed to load. */
  tagsTable: Table | null;
  /** Preview for the CURRENTLY selected cell (or null). */
  preview: CellPreviewData | null;
}

export const MetadataPanelDataContext = createContext<MetadataPanelData>({
  tagsTable: null,
  preview: null,
});

/** The selected cell's tag values per tag column, read from the sidecar table
 *  (every non-`id` column is a tag list column by construction — D-14). */
export function tagValuesForId(table: Table, id: number): { column: string; values: string[] }[] {
  const idCol = table.getChild("id");
  if (idCol === null) return [];
  let row = -1;
  for (let i = 0; i < table.numRows; i++) {
    if (Number(idCol.get(i)) === id) {
      row = i;
      break;
    }
  }
  if (row === -1) return [];
  const out: { column: string; values: string[] }[] = [];
  for (const field of table.schema.fields) {
    if (field.name === "id") continue;
    const vec = table.getChild(field.name);
    if (vec === null) continue;
    const cell = vec.get(row) as Iterable<unknown> | null;
    const values: string[] = [];
    if (cell !== null && cell !== undefined) {
      for (const v of cell) {
        if (v !== null && v !== undefined) values.push(String(v));
      }
    }
    out.push({ column: field.name, values });
  }
  return out;
}

export interface MetadataPanelViewProps {
  selectedCellId: number | null;
  row: MetadataRow | null;
  loading: boolean;
  error: string | null;
  tagValues: { column: string; values: string[] }[];
  preview: CellPreviewData | null;
  /** Schema v2.8 `column_roles.url` — the names of columns whose values are links.
   *  Optional (absent ⇒ none), so every existing caller and test is unaffected. */
  urlColumns?: string[];
}

/** Presentational body of the panel (exported for GL-free smoke tests; the
 *  stateful MetadataPanel below fetches and then renders this). */
export function MetadataPanelView(props: MetadataPanelViewProps): ReactElement {
  if (props.selectedCellId === null) {
    return h(
      "section",
      { className: "metadata-panel metadata-panel-empty" },
      h("h3", { className: "panel-title" }, "Cell details"),
      h("p", { className: "muted" }, "Click a cell to inspect it."),
    );
  }
  const children: (ReactElement | null)[] = [
    h("h3", { className: "panel-title", key: "t" }, `Cell ${props.selectedCellId}`),
  ];
  if (props.preview !== null && props.preview.cellId === props.selectedCellId) {
    children.push(
      h(
        "div",
        {
          className: "cell-preview",
          style: { width: "160px", height: "160px", overflow: "hidden", position: "relative" },
          key: "p",
        },
        h("img", {
          src: props.preview.imageUrl,
          alt: `Cell ${props.selectedCellId} preview`,
          style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
        }),
      ),
    );
  }
  if (props.error !== null) {
    children.push(h("p", { className: "error-text", key: "e" }, props.error));
  } else if (props.loading) {
    children.push(h("p", { className: "muted", key: "l" }, "Loading metadata…"));
  } else if (props.row !== null) {
    const entries = Object.entries(props.row.fields);
    // Schema v2.8: hoist the url-column lookup into a Set ONCE — the flatMap below runs per
    // field on every panel render (selection change, loading flip, preview arrival), so a
    // per-field `[].includes` (array alloc + linear scan) is pure repeated waste.
    const urlSet = new Set(props.urlColumns ?? []);
    children.push(
      h(
        "dl",
        { className: "field-list", key: "f" },
        // Schema v2.8: a column named in `url` renders its value as an anchor IN PLACE —
        // one row per column exactly as before, so a link can never appear twice. The
        // `href` is null for anything that is not an absolute http(s) URL, and a null
        // href falls back to the identical plain text any other field would show.
        entries.flatMap(([name, value]) => {
          const href = urlSet.has(name) ? sourceUrl(value) : null;
          return [
            h("dt", { key: `dt-${name}` }, name),
            h(
              "dd",
              { key: `dd-${name}` },
              value === null
                ? "—"
                : href !== null
                  ? h(
                      "a",
                      // noopener/noreferrer are normative in the schema, not stylistic:
                      // the target comes from dataset content and must never get a
                      // handle on this window.
                      { href, target: "_blank", rel: "noopener noreferrer" },
                      // Link TEXT is the sanitized href, not the raw value, so the displayed
                      // text always equals the navigation target — a value the URL parser
                      // rewrites (embedded tab/newline, backslashes, `user@host` userinfo)
                      // cannot read as one host while the anchor points at another.
                      href,
                    )
                  : String(value),
            ),
          ];
        }),
      ),
    );
  } else {
    children.push(h("p", { className: "muted", key: "n" }, "No metadata for this cell."));
  }
  if (props.tagValues.some((t) => t.values.length > 0)) {
    children.push(
      h(
        "div",
        { className: "panel-tags", key: "g" },
        props.tagValues.flatMap((t) =>
          t.values.map((v) => h("span", { className: "chip chip-static", key: `${t.column}:${v}` }, v)),
        ),
      ),
    );
  }
  return h("section", { className: "metadata-panel" }, children);
}

export function MetadataPanel(props: MetadataPanelProps): ReactElement {
  const data = useContext(MetadataPanelDataContext);
  const [row, setRow] = useState<MetadataRow | null>(null);
  // Initialized from the mount-time selection so the very first render (and
  // renderToString) shows "Loading…" rather than a false "No metadata".
  const [loading, setLoading] = useState(props.selectedCellId !== null);
  const [error, setError] = useState<string | null>(null);

  const id = props.selectedCellId;
  // tagValuesForId is an O(numRows) scan of the sidecar table — memoized so it
  // runs once per selection change, not on every render (loading flips etc.).
  const tagValues = useMemo(
    () => (id !== null && data.tagsTable !== null ? tagValuesForId(data.tagsTable, id) : []),
    [data.tagsTable, id],
  );
  useEffect(() => {
    setRow(null);
    setError(null);
    if (id === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    props.client
      .getMetadata(props.dataset, [id])
      .then((rows) => {
        if (cancelled) return;
        setRow(rows[0] ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.dataset, id, props.client]);

  return h(MetadataPanelView, {
    selectedCellId: id,
    row,
    loading: id !== null && loading,
    error,
    tagValues,
    preview: data.preview,
    urlColumns: props.urlColumns,
  });
}
