# Schema Changelog

All schema changes are recorded here. Update this file on every schema version bump.

<!-- Format:
## [version] — YYYY-MM-DD
### Added / Changed / Removed
- description of change
-->

## [1.1] — 2026-06-13 — PR12-3 image_count semantics + T2-20 column wording (description-only; no version bump)

> No structural change — descriptions only, recorded per the CHANGELOG-gated
> schema-touch rule (seam 13 Work Package A, item 3). v1.1 remains the current
> locked contract; producers/consumers read the same shapes as before.

### Changed
- `layout_manifest.schema.json` — `dataset_metadata.image_count` description now
  pins the **decided** semantics (PR12-3): the count is **renderable (packed)
  cells**, i.e. images that successfully decoded and packed into the atlas.
  Undecodable images are skipped from the atlas and so are **not** counted, even
  though their metadata row is retained in `metadata.parquet` (the id set stays
  stable for the layout id-join). The field shape (`integer`, `minimum: 0`) is
  unchanged. The pipeline already computes this (`worker.run_ingest`:
  `image_count = len(packed_ids(atlas))`); this records the contract. The seam-13
  e2e acceptance harness (`tests/e2e/run_acceptance.py`) asserts it end-to-end by
  including one undecodable image and checking `image_count` excludes it while the
  metadata row survives.
- `column_roles.schema.json` — every role entry's `column` description (and the
  `embeddingRoleEntry.column`) now clarifies that `column` names the **source
  header** column, NOT any internal name the pipeline may store the data under —
  an enrichment column that shadows a reserved field is stored as `meta_<name>`,
  but the role entry still references the original header (T2-20). Description-only;
  the `string`/`minLength: 1` shape is unchanged.

## [1.1] — 2026-06-12 — D-29 uncompressed browser Arrow (description-only; no version bump)

> No structural change — descriptions only, recorded per the CHANGELOG-gated
> schema-touch rule. v1.1 remains the current locked contract.

### Changed
- `layout_manifest.schema.json` — the `tags.format` and `edges.format`
  descriptions now state the file is written **UNCOMPRESSED** (decision D-29):
  apache-arrow JS cannot decode compressed Arrow IPC record batches, and
  `pyarrow.feather.write_feather` defaults to LZ4. The enum (`["arrow"]`) is
  unchanged — compression is a property of the bytes, not the format name.
  Producer fix in the same PR: `ingest.py` `write_tags_sidecar` +
  `tests/fixtures/build_fixture.py` pass `compression="uncompressed"`; golden
  fixtures regenerated. quadfeather cell tiles were verified
  uncompressed-readable (renderer real-tile decode test, PR #26) — no change.
- `cell_record.schema.json` — description's version sentence corrected
  `1.0` → `1.1` (PR25-4: a verbatim-copy artifact from the v1.1 bump; the `$id`
  was already v1.1).

## [1.1] — 2026-06-11 — D-26 scatter layout (additive MINOR)

> **Lock status: v1.1 is locked on merge; v1.0 remains locked and frozen.**
> `schemas/v1.1/` is the current contract (the pipeline validates and writes
> against it); `schemas/v1/` stays untouched as the historical v1.0 contract for
> already-written datasets. This entry carries v1.0's full history forward below.

### Added
- `column_roles.schema.json` — new optional `scatter` property (default `[]`):
  an array of `scatterRoleEntry` objects, each
  `{ "x_column": str, "y_column": str, "label": str }` (all required,
  `minLength: 1`, `additionalProperties: false`). Declares pre-computed 2-D
  coordinate column pairs (UMAP/t-SNE/custom — decision D-26); each entry drives
  one scatter layout. The pair is atomic — an X without a Y is unrepresentable.
  **Why:** researchers arrive with their own embedding coordinates; D-26 makes
  them a first-class Phase-1 layout instead of waiting for Phase-2 computed UMAP.
- `layout_manifest.schema.json` — `layoutEntry.type` enum gains `"scatter"`
  (between `categorical` and `umap`). Scatter = Phase-1 *user-supplied*
  coordinates; `umap` stays reserved for Phase-2 *computed* embeddings.

### Changed
- `layout_manifest.schema.json` — `manifest_version` loosened from
  `const: "1.0"` to `pattern: "^1\.(0|1)$"`: a MINOR schema accepts every
  same-major document it understands, so existing v1.0 manifests stay valid;
  the pipeline now **writes** `"1.1"`.
- `cell_record.schema.json` — verbatim copy of v1.0 (`$id` aside). No shape
  change; tiles and tile readers are unaffected.
- Each file's `$id` updated to `schemas/v1.1/...`; the version sentence in the
  `column_roles` / `layout_manifest` descriptions updated to 1.1.

## [1.0] — revised 2026-06-07 — D-25 images-first input contract (RE-LOCKED)

> **Re-locked 2026-06-07.** `schemas/v1/` was briefly unlocked to apply the
> images-first input-contract correction (decision D-25) and then re-locked.
> These edits are *breaking* (a removal + renames), which the post-lock policy
> would normally route to `schemas/v2/`. They are applied **in place** instead
> because nothing is deployed and there are no downstream consumers yet: the
> 2026-05-29 lock froze a CSV/`index`-centric *input* model before the
> images-only floor (the product's actual floor — a folder of images, metadata
> optional) was validated, so that lock was premature. Correcting it now, while
> the pipeline is the only seam built, is the cheapest point. The *output*
> contract (`cell_record`) held up and is unchanged in shape. The MAJOR/MINOR
> policy below resumes from this re-lock for any future change.

### Changed
- `column_roles.schema.json` — the single required member is now `filename`
  (the join key to the image set, matched by basename), not `index`. The dataset
  *is* the images; the pipeline assigns each cell `id` (ordered by filename);
  metadata is optional enrichment joined by filename. Per-column descriptions
  de-CSV'd ("metadata source" rather than "source CSV").
- `layout_manifest.schema.json` — `column_roles` removed from the top-level
  `required` set (now optional; absent ⇒ images-only dataset). The
  `dataset_metadata` field `source_csv_path` is renamed to `source` (optional,
  source-format-agnostic) and dropped from `dataset_metadata.required`.
- `cell_record.schema.json` — the `id` description is corrected from "matching
  CSV row order" to pipeline-assigned (ordered by filename). **Description-only;
  the field shape (`int64`, required) is unchanged**, so cell tiles and tile
  readers are unaffected.

### Removed
- The `column_roles.index` role and its `required` status. Cell identity is
  pipeline-assigned and never user-supplied; a user-chosen ordering is a *layout*
  (a view) over the stable ids, not the id itself — a future **additive**
  `sorted` role can drive such views later without a breaking bump.

## [1.0] — 2026-05-29 — LOCKED (initial release)

> **Locked 2026-05-29.** `schemas/v1/` is now immutable. Additive changes
> (a nullable cell-record column or an optional manifest field) require
> `schemas/v1.1/` (MINOR); removing, renaming, or changing the type/nullability
> of any field requires `schemas/v2/` (MAJOR). See the Versioning policy below.

### Added
- Initial v1 contract, defined by the architect pass before implementation.
- `layout_manifest.schema.json` — root manifest: dataset id/version, manifest
  version, layouts (with type enum `grid|datetime|categorical|umap|network|custom`,
  reserving Phase 2 types), atlas config (page size, per-LOD cell sizes, path
  prefix), embedded column roles, optional nullable edges declaration, optional
  nullable `tags` sidecar declaration (decision D-14, mirroring `edges`),
  dataset metadata. Layout `bbox` coordinates constrained to normalized `[0,1]`.
- `cell_record.schema.json` — Arrow IPC cell record. Required non-nullable:
  `id` (int64), `x`/`y`/`w`/`h` (float32), `atlas_page` (int32),
  `atlas_u`/`atlas_v`/`atlas_w`/`atlas_h` (float32), `lod` (int8, 0/1/2).
  Reserved nullable: `color`, `cluster_id`, `edge_count`, `embedding_dim` (int32).
- `column_roles.schema.json` — `index` (required, exactly one), `datetime`
  (optional, ≤1), `categorical`/`tag`/`freeform` (0..N), `embedding` (optional,
  reserved for Phase 2 UMAP).
### Changed (pre-lock revisions, still folded into the unlocked v1.0)
- `edges` moved from the manifest top level into each `layoutEntry` (decision
  D-20): edges are a per-layout property (a dataset may carry more than one
  network layout), matching `LayoutResult.edges`. Removes a known future v2
  break. Optional + nullable; two layouts may share an edge file via the same
  `edges.path`.
- `tags.format` and the (now per-layout) `edges.format` enums tightened from
  `["arrow","parquet"]` to `["arrow"]` (appendix A2): the frontend decodes Arrow
  IPC/Feather only (apache-arrow JS cannot read Parquet).
- `layoutEntry.tile_root` description documents per-LOD tile trees (decision
  D-17): the renderer resolves `{tile_root}lod{n}/{z}/{x}/{y}.feather` and the
  per-LOD index `{tile_root}lod{n}/manifest.feather`, mirroring the atlas
  `{path_prefix}lod{lod}/…` convention. Description-only; no structural change.
  `cell_record` stays frozen (`lod` retained, constant per tree).
### Note on the `tags` addition (D-14)
- Decision D-14 framed the optional `tags` manifest entry as a MINOR bump
  (`schemas/v1.1/`). That framing assumes v1.0 is already locked. It is not:
  PROJECT_STATUS Phase 7 ("Lock schemas v1.0") has not yet run, and Phase 4 is
  explicitly the architect follow-up that patches the schemas *before* lock.
  The `tags` entry is therefore folded directly into v1.0 rather than spawning
  a near-duplicate `schemas/v1.1/` directory that would then itself be locked
  as the initial release. The MINOR-bump rule below applies to any optional
  field added *after* v1.0 is locked.

### Versioning policy
- Adding a nullable cell-record column or an optional manifest field is a MINOR
  bump (`schemas/v1.1/`), forward-compatible, with a coordinated producer+consumer PR.
- Removing, renaming, or changing the type/nullability of any field is a MAJOR
  bump (`schemas/v2/`).
