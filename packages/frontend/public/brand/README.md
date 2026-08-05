# Plotlas brand assets

The canonical brand raster assets, exported from the design source (the
`Design Pass` boards) and shared by this app, the repo `README.md`, and — later —
the informational website. Vite serves this folder at `/brand/*`.

| File | Use |
|------|-----|
| `plotlas-icon-512.png` | App icon (full glyph on the `#0E1116` tile); `apple-touch-icon`. |
| `plotlas-icon-32.png` | 32×32 favicon (full glyph tile). |
| `plotlas-favicon-16.png` | 16×16 favicon (micro glyph tile). |
| `plotlas-readme-1280x320.png` | README / website header banner. |

These are the **design-tool exports** — regenerate them from the design source when
the brand changes, and drop the updated PNGs back in here (do not hand-edit).

The **in-app** mark is a separate, theme-aware React component,
[`src/ui/PlotlasMark.ts`](../../src/ui/PlotlasMark.ts): it renders the same glyph with
CSS `var()` tokens so it recolors with the theme, in `full` / `micro` / `muted`
variants. Use the component for anything inside the app; use these PNGs for standalone
contexts (favicon, README, and raster-only surfaces like social / OpenGraph images).
