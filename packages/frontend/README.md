# frontend

Visualization UI for `image-viz`. Two layers:

- **`src/renderer/`** — framework-free Three.js + GLSL (`world`, `cells`, `lod`,
  `layout`). Knows nothing about React; never imports `ui/*`.
- **`src/ui/`** — React + Tailwind. Drives the renderer through its public
  interface only.
- **`src/api-client/`** — the single typed HTTP client. The only module that
  knows API URLs; holds no rendering state and never imports Three.js.

This is currently a **skeleton**: every catalogue interface/type is transcribed
verbatim and every factory throws `new Error("not implemented")`.

## Package layout

```
packages/frontend/
  package.json            # deps = allowed frontend list; scripts: gen:types, gen:check, typecheck, build, test
  tsconfig.json vite.config.ts index.html
  scripts/gen-types.mjs   # runs json-schema-to-typescript over column_roles
  src/
    main.tsx              # Vite bootstrap entry (not a catalogue module); mounts <App/>
    renderer/  world.ts cells.ts lod.ts layout.ts
    ui/        App.tsx MetadataPanel.tsx LayoutSwitcher.tsx TagControls.tsx
    api-client/ client.ts types.ts
    generated/ column_roles.ts                       # GENERATED — do not hand-edit
  tests/ frontend_skeleton.test.ts
```

## Generated types (decision D-16)

`src/generated/` is produced from the locked JSON Schemas by
`json-schema-to-typescript` — **only** `column_roles.schema.json`, because that
type is *consumed* directly (the metadata panel and tag controls read it), so a
generated type that provably matches the schema is exactly what's wanted.

```bash
npm run gen:types   # regenerate src/generated/*.ts from schemas/v1.1/
npm run gen:check   # CI diff-gate: fails if committed output drifts from schema
```

Do not hand-edit `src/generated/`. The diff-gate (`gen:check`) is the in-package
half of the CI gate; a repo-level workflow should invoke it (the workflow file
lives outside this package, so it is not created here).

Two schemas are deliberately **not** generated:

- `cell_record` — the renderer consumes cell records as struct-of-arrays typed
  buffers (`CellBuffers`), never as row objects.
- `layout_manifest` — the manifest is data the frontend *receives* over the
  network and must validate (notably range-checking `manifest_version`, which
  the v1.1 schema pins to the pattern `^1\.(0|1)$`). The working type is therefore the
  hand-written, validation-friendly mirror in `renderer/layout.ts`; a generated
  type would make that validation un-writeable and re-duplicate `ColumnRoles`.
  The schema's real enforcement for the manifest is **runtime** validation
  inside the api-client's `getManifest` (tracked in issue #4 — it validates the
  fetched JSON against `layout_manifest.schema.json` directly, not via a
  generated `.ts` type). A compile-time type, generated or not, is erased at
  runtime and cannot protect the running app from a malformed manifest. The
  D-16-vs-catalogue framing this resolves is tracked in issue #5.

`api-client/types.ts` is hand-authored for API request/response bodies that are
**not** in the schemas (`DatasetSummary`, `LayoutInfo`, `MetadataRow`,
`CreateDatasetRequest`/`Response`, `JobStatus`). It is
kept distinct from the generated types — no duplication. `ColumnRoles` is the one
shared type: it is imported from `src/generated/column_roles` everywhere
(`renderer/layout.ts`, `ui/TagControls.tsx`, `api-client/types.ts`) rather than
re-declared.

## Setup

```bash
npm install
```

## Running / building

```bash
npm run typecheck   # tsc --noEmit over src/
npm run build       # tsc --noEmit && vite build
```

## Testing

```bash
npm test            # node --test --experimental-strip-types tests/  (Node >= 22.6)
```
