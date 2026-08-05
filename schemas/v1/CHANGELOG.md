# Schema Changelog

All schema changes are recorded here. Update this file on every schema version bump.

<!-- Format:
## [version] — YYYY-MM-DD
### Added / Changed / Removed
- description of change
-->

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
