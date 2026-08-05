# Schema Changelog — v2

> **STATUS: LOCKED / IN-FORCE (2026-06-29).** `schemas/v2/` is the **in-force
> cross-package contract** (decision **D-33**, see
> [`docs/decisions/D-33-schema-v2-spatial-tile-pyramid.md`](../../docs/decisions/D-33-schema-v2-spatial-tile-pyramid.md)).
> It landed via the coordinated producer+consumer PR chain #63 (producer seam) →
> #66 (producer 1M-ready) → #68 (API seam) → #69 (frontend seam) → #72 (render
> fixes), per the Schema Discipline rule, and is live-verified rendering real
> datasets. The API enforces it: `api/db.py` `SUPPORTED_MANIFEST_MAJOR = 2`.
> `schemas/v1/` and `schemas/v1.1/` are now **frozen-historical** (superseded by
> v2 — retained only for any v1.x dataset not yet re-ingested; nothing reads them
> at runtime). The full design rationale, field-by-field spec, and cross-stack
> change map are in [`docs/plan/v2-schema-proposal.md`](../../docs/plan/v2-schema-proposal.md).

All schema changes are recorded here. Update this file on every schema version bump.

<!-- Format:
## [version] — YYYY-MM-DD
### Added / Changed / Removed
- description of change
-->

## Behaviour changes (NO shape change, NO version bump — but a RE-BAKE is required)

> Entries here change no field and bump no version, so every existing manifest stays
> valid and every consumer that reads the contract (rather than hard-coding values)
> keeps working — but the producer's emitted VALUES change, so a dataset must be
> **re-baked** to get the new behaviour, and a committed tree baked before the entry
> will FAIL `refresh-manifest`'s geometry gates until it is. Kept separate from
> Clarifications below precisely because those need no action and these do.
> The in-force major stays **2** (`SUPPORTED_MANIFEST_MAJOR = 2`).

- **2026-07-30** (D-36 seam H5, T2-142) — `layouts[].annotations.axes[].range` description:
  **a datetime histogram narrower than the frame is now CENTRED in it**, instead of starting at
  `margin` with all the unused band width left on the right. Since H1 the cell pitch comes from
  the CELL SIZE, not the band width (deliberately — deriving pitch from the band baked hairline
  columns with up to 95 % air between them), so a pitch-bound layout does not fill the band, and
  before H5 the leftover always accumulated on the right. Measured on `nasa` (224,990 rows over
  106.3 years, rung `month`/1): the drawn extent was `x = [0.040, 0.626]` — **58.5 % of the
  box**, a third of the frame empty on the right while the chart hugged the left edge.
  - ONE offset, `x_offset = max(0, (usable - drawn) / 2)` for
    `drawn = k_time·denom + min(N_last, k)·p_c`, applied to the placement **and** to `range`:
    `x_norm[i] = margin + x_offset + k_time·(bucket_start - base)` and
    `range = [margin + x_offset, margin + x_offset + k_time·denom]`. They are two descriptions of
    ONE line, so shifting them together is a **rigid translation**: the D-36 alignment invariant
    is mathematically invariant under it, every bin still lands on its own tick, and
    `domain`→`range` interpolation carries the shift with **no consumer change**. (That
    invariance is also why the T2-138 alignment pin cannot detect this seam at all — the producer
    tests carry a dedicated coupling pin instead.)
  - **Which bakes move:** those whose ink does not already fill the band. `x_offset` is exactly
    `0` when it does, leaving such a bake **bit-for-bit unchanged** — which is why the committed
    `tests/fixtures/golden_dataset_full_v2` is NOT re-baked by this seam.
  - **"Fills the band" is NOT the same as "the width term bound the pitch."** A width-bound bake
    whose LAST bin holds fewer than `k` images never fills the trailing block the width bound
    budgeted for, so it is genuinely narrow and genuinely centres:
    `range[1] + min(N_last, k)·p_c == 1 - margin - x_offset`, short of `1-margin`. Measured:
    41/37/1 images over three month bins solves `k = 4` width-bound yet draws only **70.94 %** of
    the box and shifts by 0.105. Do not infer "unchanged" from `width_bound`.
  - **Re-bake, not refresh.** Cells move, so `refresh-manifest` correctly refuses a pre-H5 tree at
    its Gate B position comparison — that gate is doing its job; the fix is `pixscope ingest`, not
    `--force`.

- **2026-07-28** (D-36 seam H2, T2-142) — `layouts[].annotations.axes[].range` description:
  **what a tick MARKS has changed, and this is the one a consumer must act on.** A datetime bin
  is now `k` images **wide** (uniform `k` across bins, cells wrapped row-major from the bottom
  in chronological order), and its tick is the **LEFT EDGE of that block** — where a histogram
  bar's boundary belongs — **not a column centre**. A cell sits at `tick + (col + 0.5)·p_c` for
  its 0-based `col` in `[0, k)`, so cells extend to the **right** of their tick and the LAST
  bin's cells extend `min(N_last, k)·p_c` past `range[1]`. A reader that assumes the pre-H2
  meaning mis-places every tick by half a cell at `k = 1` and by up to `k/2` cells above it.
  Consequences, all measured on this branch:
  - `range[1]` **never** reaches `1-margin` any more, in any regime. `range[1] +
    min(N_last, k)·p_c` equals `1-margin` exactly when the WIDTH term binds; the tick line
    itself always stops one block short. A columns-bind bake that emitted exactly `[0.04,
    0.96]` through H1 now emits e.g. `[0.04, 0.957055581]` (4000 works over 250 uniform years).
  - **`range` is no longer contained in `bbox_exact`.** `range[0]` sits `0.5·p_c - side/2` to
    the LEFT of `bbox_exact[0]` — the block's left edge is a bar boundary, the bbox starts at
    the first drawn IMAGE, half a cell pitch in and then half a drawn side back out — while
    `range[1]` sits *inside* `bbox_exact[2]` by `(min(N_last, k) - 0.5)·p_c + side/2`. A
    consumer that framed the union is still correct; one that asserted containment is not.
    **`min(N_last, k)`, not `k`**: the last bin reserves only as many pitches as it holds
    images, so the `k` form over-states the gap by up to a factor of `k` on a sparse-tailed
    collection — the ordinary shape. Measured on 3,000 images on one day plus 3 spread over
    900 days (`k = 9`, last bin holding ONE): the `k` form says 0.02565, the real gap is
    0.0026545. **Both gaps are in terms of the DRAWN `side`, not of `fill·p_c`**: the two
    differ wherever the tightest real bin spacing caps the side on a `_floor_interval` year
    clamp (measured 3.1x on that bake, 0.00056250 against 0.00018).
  - the time scale is now `k_time = (k + gutter)·p_c / min_interval`, where `p_c` is the
    per-image CELL pitch (in x **and** in y), `min_interval` is the **shortest real interval**
    the chosen rung can produce (a non-leap February for months) so a `k`-wide block provably
    fits every bin, and `gutter` (0.25 cell today, a module constant the operator tunes) is
    **residual** space left unfilled at each block's RIGHT end. Nothing is ever added to the
    LEFT of a block, so no bin can be pushed off its tick. `k` and `p_c` are solved jointly:
    `p_c = min(usable/((k+gutter)·denom/min_interval + k), box_h/maxᵢ ceil(Nᵢ/k))`, maximised
    over `k`, ties to the smaller `k`. **`k` is SOLVED, not searched to a ceiling.** The width
    bound is strictly decreasing in `k` and the height bound non-decreasing, so the optimum is
    the crossover — bisected, with `k > maxᵢ Nᵢ` excluded because it cannot help. An earlier
    draft searched `k ≤ 64`; that ceiling BOUND at scale and re-created the sliver this seam
    removes (1M images in one bucket wanted `k = 692` and baked 0.8 % of the band wide, cells
    10.8× smaller than the geometry allows), so it is gone.
  - **A single occupied bucket has a ZERO-length line, and the geometry says zero.** `denom`
    is no longer replaced by a fabricated `1.0` when every dated cell floors into one bucket:
    that placeholder was inert pre-H1 but became a real input to the width bound, budgeting
    room for a line that does not exist (measured on 256 images inside one second: cells 44 %
    smaller than the honest solve, and an operator log reporting 89 % of the box against a
    real 43.4 %). Such a layout shows no distribution over time; the producer now warns.
  - the **row pitch is now `p_c` too**, so a short histogram stays short instead of stretching
    to fill the box. Measured on 4000 works over 250 uniform years: bbox height 0.903 → 0.0467.
  - the gutter is spent at **every** bin boundary including `k = 1`, which costs `1/(1+gutter)`
    = 80 % of the pre-H2 cell size wherever the width term binds. That is the price of a bin
    boundary never looking like the gap between two images inside a bin (D-36 §7.1).
  - **UNDATED cells in the strip are drawn at their own size**, `≤` the histogram's. The strip
    band stays the reserved `y ∈ [0.96, 1]`; where its rows cannot fit at the histogram's cell
    size the STRIP's cells shrink. Previously they inherited that size and `band_strip`
    absorbed the density in its row pitch alone, so H2's larger cells hung past `y = 1` —
    measured, 100 photos over 11 weeks plus ONE undated reached 1.00983 and 50 + 50 reached
    1.029, where `spatial_bbox` clamps `bbox[3]` to 1.0 and the manifest under-reports the
    drawn footprint. Growing the band instead was implemented and rejected on measurement: it
    re-couples the PLACED geometry to the unplaced COUNT, shrinking every dated cell 1.90× at
    500 undated, 3.26× at 2000 and 11.07× at 19,800 — the regression seam U1 exists to prevent.
    **`bbox` is therefore the honest footprint again**, and a consumer framing it sees every
    cell. `missing_count` is unchanged.
  - **bar height is quantised to `k` images**, so bins holding `k` or fewer all draw one row
    and their counts are indistinguishable. Inherent to a uniform `k` (a per-bin `k` would make
    equal counts render at unequal heights, which is worse) and the price of cells large enough
    to see. The producer WARNS with the count of flattened bins rather than letting the chart
    under-report silently; exposing the trade as a knob is [[T2-151]].

  Why this seam exists, measured on 20,000 images with 60 % on one day over a 3-year span
  (H1 → H2): bbox `0.002814 × 0.959994` → `0.897288 × 0.959800`, drawn aspect **341.15 → 1.07**,
  cell side `6.67e-05 → 1.13e-03` (17.0×, i.e. 0.075 px → 1.275 px at a 1920×1080 Fit).
  **Assume every existing datetime layout moves, and re-bake it** — `refresh-manifest`'s bbox
  gate refuses a pre-H2 tree. Everything else a consumer relies on is unchanged: `x` is still
  exactly linear in **seconds**, `range` is still exactly the placement line, and every bin
  still lands on its own tick. Description only — **no field/shape change, no version bump**.
- **2026-07-27** (D-36 seam H1, T2-142) — `layouts[].annotations.axes[].range` description:
  `range` is **no longer always** `[margin, 1-margin]`. It is `[margin, margin + k_time·denom]`,
  where the world-units-per-second scale `k_time` is derived from the column **pitch**, and the
  pitch is now the smaller of *one interval's share of the band* and *the deepest stack's share
  of the box* (`pitch = min(usable·avg_interval/denom, 1/max_stack)`; `k_time = pitch/avg_interval`
  — [`D-36`](../../docs/decisions/D-36-datetime-histogram-geometry-and-tick-lockstep.md)
  §"The geometry"). It still equals `[margin, 1-margin]` exactly whenever the column term binds
  — `S ≤ I/usable` where `I` is the intervals spanned, i.e. the histogram is **wider than it is
  deep** — and falls **short** of `1-margin` when the cell size sets the pitch instead: a
  deep-stacked histogram now packs its columns one cell-pitch **per interval** apart (two
  occupied buckets `m` intervals apart sit `m` pitches apart, since `x` stays linear in
  seconds) instead of spreading a few hairlines across a mostly empty box. Which term binds is
  about **peakedness, not span**: a broad span raises `I` and the interval length together and
  they cancel. Measured, **rijks (S/I = 1.30) and nasa (S/I = 2.23) are both stack-bound**, so
  their datetime layouts DO change — an earlier draft of this entry claimed they were
  columns-bind and unaffected. **Assume every existing datetime layout moves, and re-bake it.**
  Preserving existing bakes was never a requirement (operator, 2026-07-27 — it had been
  inferred from an early regression test and is disowned); the algebra happens to reduce term
  for term in the columns-bind branch, which is worth knowing but is not a promise. Three
  independent reasons a tree moves, so that "it should have been columns-bind" is never a
  reason to skip the re-bake: (1) the pitch itself, for any stack-bound layout; (2) undated
  cells — the column one parks in is now chosen once per BUCKET rather than once per cell, and
  the tie between two equidistant columns goes to the EARLIER one instead of to whichever cell
  came first in id order. Bucket starts sit on a regular calendar lattice, so ties are ordinary:
  measured on 2.6 % of sampled columns-bind fixtures carrying undated cells, moving those cells
  by up to 0.13 world units — 131,429× `refresh-manifest`'s positions tolerance, while its bbox
  gate rounds identically and stays blind, so **refresh will refuse these trees and a re-bake is
  the only remedy**; (3) any layout whose ladder rung has a real interval shorter than 0.85 of
  its average (the `_floor_interval` year clamp), where the drawn cell side is now capped at the
  tightest real column spacing so adjacent columns can no longer overlap — previously they could
  and did, by up to 41 % of a cell. (Reason 2 disappears when T2-140 lands in this same merge
  unit: undated cells move off the histogram entirely and stop having a parking column at all.)
  Everything a consumer relies on is unchanged — `x` is still exactly linear
  in **seconds**, `range` is still exactly the placement line (so every column still lands on
  its own tick), and both endpoints are still real occupied columns inside `bbox_exact`. (Use
  `bbox_exact`, not the 6-dp `bbox`, for that containment: `range` is emitted at 9 dp, so the
  rounded `bbox` can fall up to 5e-7 short of `range[1]` once a single bucket holds ~851k+
  cells. Equal-precision rounding was monotone, so this could not happen before.) A
  consumer that hard-codes `[0.04, 0.96]` instead of reading `range` breaks; one that reads
  `range` needs no change. `range` is also now emitted at **9 dp** rather than 6: the consumer
  rebuilds the placement line from these two numbers, so their rounding lands directly in the
  alignment error — at 6 dp that was up to 5e-7 (measured 3.2e-7 on a packed layout), most of
  the 1e-6 reproduction budget; at 9 dp it is ≤ 5e-10 and float32 cell storage (~3e-8) is again
  the only residual. A columns-bind layout still emits exactly `[0.04, 0.96]`. Description only
  — **no field/shape change, no version bump** (the
  producer's emitted VALUES change for deep-stacked datasets, so those must be re-baked to gain
  the tighter packing; existing 2.5 manifests stay valid and readable).

## Clarifications (description-only — NO shape change, NO version bump)

> Prose/description edits recorded here per the Schema Discipline rule ("any change
> here requires a CHANGELOG entry"). None change a data shape, add/remove/retype a
> field, bump the version, **or change what the producer emits** — so they need no
> coordinated producer/consumer code change and no re-bake.

- **2026-07-27** ([PR #186], T2-138) — `layouts[].annotations.axes[].range` / `.domain`
  descriptions: the datetime plugin now buckets on **nice CALENDAR boundaries** (an
  auto-picked interval — second/minute/hour/day/month/quarter/year/decade/…) and places each
  cell at its bucket's floored calendar **start**, so `domain` = `[first bucket start, last
  bucket start]` and `range` = the placement band `[margin, 1-margin]` now describe **exactly**
  the line the placement uses. Consequence for a consumer: **every** column lands on its own
  tick, so the previously-documented "interior ticks may sit up to half a `ceil(sqrt(n))`
  column pitch from their column" residual is **gone** (a reader that budgeted a half-pitch
  tolerance can drop it; residual error is float32 cell-coord storage only, ~3e-8). Both
  endpoints remain real occupied columns, so `range` still lies inside the layout bbox.
  Description only — **no field/shape change, no version bump** (the producer's emitted
  VALUES change, so datasets must be re-baked to gain the alignment; existing 2.5 manifests
  stay valid and readable).
- **2026-07-11** ([PR #142]) — `layouts[].detail.path_prefix` description: corrected
  the "the renderer does NOT read it" note. It stays true of the lightbox /
  click-through consumer (which uses the fixed `/api/.../detail/{id}.{ext}` route), but
  the **T2-26 renderer detail overlay** now reads `path_prefix` to compose the DB-free
  static-edge burst URL `/datasets/{ds}/{path_prefix}/{id}.{ext}` (api-client
  `staticDetailUrl`). Description only — no field/shape change.

## [2.8] — 2026-08-04 — `column_roles.url`: mark a column as a link (MINOR)

> **MINOR bump** within major 2 (`SUPPORTED_MANIFEST_MAJOR` stays 2). Scope
> [`SCOPE_Part-C_url-role_v3`](../../docs/plan/SCOPE_Part-C_url-role_v3.md). The pipeline
> writes `manifest_version "2.8"`. Purely additive, and landed as a coordinated producer +
> consumer change in one PR per the Schema Discipline rule.

### Added

- **`column_roles.url`** — an array of **column names** whose values are links. Default
  `[]`. The metadata panel renders each named column's value as an anchor instead of plain
  text.

Just names. There is nothing to synthesize (the column already holds the URL) and no
`label` to carry (the panel already heads every field with the column's own name, and the
link text is the value). A list, like `freeform`/`tag`, so a dataset can mark a source page
*and* a licence page at no extra cost.

### What this role does NOT do

`url` is an **orthogonal display modifier, not a role of its own**: it is layered on a column
that already carries a storing/display role (`categorical` or `freeform`) — the column still
lives in `metadata.parquet` and appears in `/api/metadata`'s `fields` like any other; naming
it in `url` changes only how it is **drawn**. It is NOT co-emitted as `freeform`, so a
`categorical` column can be a link without being double-projected at ingest.

It is not a template engine. If a URL must be derived from another column, the metadata
producer derives it into a column — outside the app. (Adding such a column to an
already-baked dataset needs no re-bake: `metadata.parquet` is standalone and the API
re-`DESCRIBE`s on mtime/size change. See [[T2-198]].)

### Producer obligations (normative)

- Every name in `url` MUST also be a `categorical` or `freeform` column, so its value is
  actually stored in `metadata.parquet` (the enrichment SELECT does not project `url`
  itself). Ingest and add-layouts **reject** a `url` naming an otherwise-unstored column — a
  link the frontend could never draw.
- `url` holds bare column NAMES, so a name repointed on a reserved-name collision (stored as
  `meta_<name>`) MUST be repointed in `url` too, exactly like its storing role.

### Consumer obligations (normative)

- A value is a **live link only if it parses as an absolute `http(s)` URL**. Everything
  else — `javascript:`, `data:`, relative, protocol-relative, malformed — renders as the
  same inert text any other field would show. Both the role map and the values travel
  inside a dataset, so a hostile target must be unrepresentable at the point of rendering,
  not merely discouraged here.
- Links carry `target="_blank"` and `rel="noopener noreferrer"`.
- Render **in place**, one row per column — never an extra row, which would show the value
  twice.
- A `url` column is **excluded from text search** — its values are link targets, not human
  search text (short URLs would otherwise classify title-like and match nearly every row).
- **Never** fetch, HEAD or otherwise validate the target; the application documents that it
  makes no outbound network calls.

## [2.7] — 2026-07-29 — `layouts[].annotations.axes[].interval`: the bucketing rung the producer binned at (MINOR)

> **MINOR bump** within major 2 (`SUPPORTED_MANIFEST_MAJOR` stays 2). Ledger **T2-142**,
> D-36 seam **H3**. The pipeline writes `manifest_version "2.7"`. Purely additive — no field
> removed or retyped — and landed as a coordinated producer + consumer change in one PR per
> the Schema Discipline rule. Readers gate on **field presence**, never on `manifest_version`.
> **No geometry moves and no re-bake is required for correctness**: this seam adds a field and
> changes nothing about where a cell is placed. (The committed
> `tests/fixtures/golden_dataset_full_v2` IS re-baked, so the contract gate sees the field end
> to end; only `layout_manifest.json` moved, `positions/*.arrow` and `tiles/**` byte-identical.)

### Added
- `layouts[].annotations.axes[].interval` — the `{kind, step}` **calendar bucketing rung** the
  datetime layout actually binned at, e.g. `{"kind": "month", "step": 3}` for quarters. `kind`
  is one of `second | minute | hour | day | month | year` (a closed enum at write time);
  `step` is an integer `>= 1`.

  **Why.** The producer owns a 25-rung `_INTERVAL_LADDER` and the renderer owned
  `overlayLayer.NICE_YEAR_STEPS` — **years only**. They were maintained separately with nothing
  checking one against the other, so T2-138's guarantee (a bin's block left edge lands on its
  own tick) only *bit* where the two happened to coincide: a dataset binned by month or day got
  a correct but **unlabelled** axis. Making the two agree by discipline is what failed. Emitting
  the rung makes lock-step **structural** — the renderer draws ticks at bin boundaries it was
  *told* about instead of re-deriving a ladder. Measured off the ladder on this branch
  (2026-07-29): 25 rungs over six kinds — `second`x4, `minute`x4, `hour`x4, `day`x1, `month`x2,
  `year`x10, coarsest `('year', 1000)`. There is deliberately **no `week`** rung (the only
  sub-month unit that does not nest under its parent; D-36 designs it out) and no millennium.
  Do not read "coincide" as "the year rungs were already safe": `NICE_YEAR_STEPS` carries five
  values the producer never picks (20, 200, 2000, 5000, 10000), and year rungs lined up only
  because the producer's fine rungs happen to divide the renderer's coarse steps for realistic
  `n`. That accident is what this field removes.

  **It does NOT dictate the tick rung.** Tick density is a screen-space decision, and a
  *coarser* tick rung simply falls inside a bin — what a weekly histogram with monthly gridlines
  does (D-36 §7.4, and the "nesting is a preference, not a correctness property" correction).
  `interval` is the **finest** rung guaranteed to land on bin boundaries.

  **How to use it.** A bucket start is the rung's calendar floor of the instant, anchored at
  year 0 / month 1 / midnight, and `domain[0]` **is** the first occupied bucket start — so
  successive bin boundaries are `domain[0]` advanced by `step` `kind`s and mapped through
  `domain` → `range`. **Do not convert the rung to a fixed number of seconds and step
  linearly:** months and years vary in length while `range` is linear in *seconds*, and the two
  disagree by up to ~3 % within a month rung (28 vs 31 days). **Caveat — the year-1 clamp:** on a
  multi-year rung whose first occupied bucket is in years 1..step-1 CE, `_floor_interval` clamps
  that start to year 1 (OFF the step grid), so the first stride is short and a uniform walk from
  `domain[0]` drifts after it. Boundaries past the first are on the natural grid, so floor each
  candidate to the rung rather than striding from `domain[0]`.

  **Always emitted with the axis, so absence means one thing.** There is no default and it is
  never omitted-when-default (the `missing_count` rule, not the `options` rule). **ABSENT ⇒ the
  entry was baked before 2.7** — a fresh pre-2.7 bake, or a pre-2.7 entry `add-layouts` carried
  forward byte-preserved under a re-stamped version — and a reader must then keep its own
  years-only ladder. That is the contract D-36 seam **H4** implements against.

  **It rides on the AXIS, not the layout entry** — the opposite placement from `missing_count`,
  and for the opposite reason: it describes the tick line and has no meaning without one. Note
  that is a claim about TICKS, not about bucketing. Of the three causes that make the producer
  DECLINE its axis, `degenerate span` and `calendar overflow` take the legacy equal-time grid
  and never select a rung at all — but **`single occupied bucket` runs the calendar branch and
  DOES select one** (measured 2026-07-29: 256 images inside 0.255 s pick `('second', 1)`, are
  logged as such, and still emit the `{"axes": []}` declined marker). The rung is dropped there
  because a one-bucket histogram has no drawable extent and therefore nothing to tick, not
  because nothing was binned.

  **Forward-compat, close to the rule `scale` carries — but not identical:** the `kind` enum
  constrains the PRODUCER at write time, and a reader meeting an unrecognized kind from a later
  MINOR must never reject the manifest. But it must **not skip the axis** the way an unknown
  `scale` does: an unknown `scale` makes the axis uninterpretable, whereas an unknown rung only
  costs the bin-boundary tick refinement — the axis is still drawable from `domain`/`range`, so
  the reader degrades **exactly as for an ABSENT interval** (fall back to its own years-only
  ladder, axis still drawn), per the promise that a v2-major reader accepts any `2.MINOR`. The
  api-client validator therefore checks `kind` as a non-empty *string* and `step` as an integer
  `>= 1`, leaving the closed enum to the schema.

## [2.6] — 2026-07-27 — `layouts[].missing_count`: the count of cells a layout could not place (MINOR)

> **MINOR bump** within major 2 (`SUPPORTED_MANIFEST_MAJOR` stays 2). Ledger **T2-140**,
> D-36 seam **U1**. The pipeline writes `manifest_version "2.6"`. Readers gate on **field
> presence**, never on `manifest_version`. Additive for any reader; see **Removed** below for
> the one shape that changed WITHIN the unreleased 2.6 draft.
> (Version allocation note: D-36's contract sketch also pencilled 2.6 for seam H3's
> `axes[].interval`. U1 lands first and takes 2.6; H3 moves to 2.7.)

### Added
- `layouts[].missing_count` — non-negative **integer COUNT** of the cells THIS LAYOUT could
  not place from the column it arranges by. **Every family reports it, and every FRESH 2.6
  entry carries it, `0` included** — the same always-emit rule `pyramid.dropped_total` has
  used since 2.5. It is `optional` in the schema for exactly one reason: `add-layouts` carries
  pre-2.6 entries forward byte-preserved under a re-stamped version. So the presence gate
  decides one thing cleanly — **`0` means "counted, found none"; ABSENT means "this entry
  predates 2.6"**, and a reader must never render an absent key as a positive claim of zero.

  What counts as unplaceable, per family: the datetime layout's images whose datetime column
  was null, absent, or **unparseable**; the scatter/geographic families' cells whose
  coordinates are not **finite** (a null coordinate and a `NaN` both count —
  `_placement.partition_placed` gates on finiteness, not nullity); the categorical layout's
  **structurally-missing band** (the same population `annotations.labels[].missing` flags).
  Note that is wider than "no value recorded": a malformed date or a `NaN` is data that is
  present but unusable, which is a different thing for a user to act on.

  **It says HOW MANY, not WHERE.** Usually those cells are drawn in the unplaced strip
  (`y ∈ [0.96, 1]`), but scatter's `normalize: "none"` pass-through uses a data-adjacent block
  that can sit anywhere, the categorical family gives them a labelled band inside the treemap,
  and the datetime layout's legacy fallback grid still parks them mid-canvas. A consumer that
  wants to point at them must read the layout `type` and `annotations` too.

  **It rides on the LAYOUT ENTRY, not on an annotation.** Two reasons, and they are the whole
  point of where it sits. (1) A datetime layout that **declines** its axis (the `"axes": []`
  marker) may still have stripped its undated cells, so a count living on the axis would
  vanish exactly when the viewer has *only* an unexplained strip to show. Measured, of the
  three decline causes only **single occupied column** strips — it is reached inside the
  calendar branch; *degenerate span* and *calendar overflow* take the legacy fallback grid,
  where the undated cells stay mid-canvas. One case is enough: the count has to survive a
  declined axis, and on the axis it could not. (2) `scatter` and `geographic` have had
  unplaced strips since long before this contract and emit no annotations at all; on the
  layout entry they report the count too, and "cells this layout could not place" reads
  identically in every family.

  **It is deliberately NOT `annotations.labels[].missing`.** That field is a `boolean` FLAG on
  a categorical band meaning "this band IS the structurally-missing bucket". This one is an
  `integer` COUNT on the layout. Different name, different object, different type — the
  earlier draft of this MINOR called it `annotations.axes[].missing`, one word away from the
  boolean and a sibling annotation type in the same object; renamed here so no reader has to
  learn that `missing` means two things.

  **No geometry moves in `scatter`/`geographic`/`categorical`** — their strips and bands are
  unchanged and always were; only the count is newly *reported*, so `refresh-manifest`
  derives it without a re-bake. Two caveats on that upgrade path, both measured against
  `worker.run_refresh_manifest` and neither of them cosmetic:
  - It needs **`--force`** on any tree already at 2.5+. The refusal guard fires on
    `version >= (2,5) AND ("bbox_exact" in layout ...)`, and `bbox_exact` is on every fresh
    2.5 entry — so a plain run on `rijks_pilot`/`nasa` exits with "nothing to do", which is
    now false.
  - Refresh is still **all-or-nothing across layouts** ([[T2-141]]), so on a dataset that also
    carries a `datetime` layout the run dies on that layout — its geometry moved under U1/H1
    and Gate A refuses — and the other families gain nothing. Those datasets need the re-bake
    below regardless; the no-re-bake path is real only for trees with no datetime layout.

### Removed
- `layouts[].annotations.axes[].missing` — the integer count added by the FIRST draft of this
  same 2.6 MINOR, superseded by `layouts[].missing_count` above. Renamed (it sat one word from
  `annotations.labels[].missing`, a `boolean`, in a sibling annotation type of the same
  object) and moved (an axis the producer declines cannot carry it, and scatter/geographic
  emit no annotations at all). **2.6 was never released** — `main` is at 2.5 — so no published
  shape changed and no consumer read it. But `$defs.axisAnnotation` is
  `additionalProperties: false`, so a tree baked from the interim U1 producer is now
  schema-INVALID: `add-layouts` on it fails inside `_validate_manifest` **after** baking its
  new pyramid. Recovery is a re-bake, or hand-deleting the `missing` key from each axis object
  (`refresh-manifest --force` also rebuilds `annotations`, where its Gate A permits).

### Behaviour change — RE-BAKE REQUIRED (datetime layouts)
Emitting the count is the small half. The producer change behind it (T2-140) is that an
**undated image is no longer drawn at a date**:

- Undated cells leave the histogram for the **unplaced strip**, the absolute band
  `y ∈ [0.96, 1]` (`_placement.band_strip`) that scatter and geographic already use for a
  cell with a missing coordinate. Previously they were PARKED in the dated column nearest the
  middle of the placement line — an x the emitted axis maps to a real instant, i.e. the
  viewer showed an undated photo as though it were taken on a specific date.
  **Nothing is dropped**: every image is still a row in the positions table and still drawn
  (a layout physically cannot carry fewer rows than the image count today — the positions
  table has no `id` column; that is [[T2-139]], and it gates the "omit them entirely" option,
  seam U2).
- The histogram's usable HEIGHT is therefore `0.96`, not `1` — the strip's band is reserved
  **unconditionally**, whether or not any image is undated, so the geometry depends on
  neither the count of undated images nor their presence. Both `pitch`'s stack term and
  `row_h` are over that same shortened box (`min(usable·avg/denom, 0.96/max_stack)` and
  `0.96/max_stack`); the columns-bind boundary moves from `max_stack ≤ I/usable` to
  `max_stack ≤ 0.96·I/usable`.
- `max_stack` now counts **dated** bins only, and the interval-ladder budget
  (`5·√n`) is sized from the **dated** count. Both were previously fed the total, so the
  number of images with no date set the scale of the time axis *and* the bucket rung.
  Measured on the pre-U1 plugin, all with 2000 undated images added: 4000 works over 250
  uniform years went from `[0.04, 0.96]` to `[0.04, 0.163511385]` (extent 7.4× narrower,
  cell `side` 0.003141 → 0.000422); 3000 works over the same 250 years to
  `[0.04, 0.163756935]`; 3000 photos over 900 days from `[0.04, 0.273693611]` to
  `[0.04, 0.053865075]`, 16.9×. And separately, 19,800 undated beside 200 photos over 200
  days dragged the rung from `('month', 1)`/7 columns to `('hour', 12)`/200 one-image
  columns, 638× smaller cells.

**Consequence for existing trees.** Every datetime layout moves, but not all of them the same
way. A **stack-bound** layout scales by exactly 0.96 in `pitch`, `row_h`, cell `side` and
`range` span. A **columns-bind** layout keeps its `x`, its `range` AND its cell `side` — only
the stack `y` moves: columns-bind means `column_term ≤ box_h/max_stack`, so `box_h` is
excluded from the `min` that sets `pitch`, and `side = fill·min(pitch, row_h, 2·margin)` is
unchanged with it. Verified on 4000 works over 250 uniform years: base and branch both bake
`side = 0.003140575485303998` and byte-identical `bbox` x-endpoints
(`0.0384297122711529` / `0.9615702877288472`); only the y half moves
(`0.029679712271152896, 0.9703202877288472` → `0.028429712271152922, 0.9315702877288471`).
The one sliver that changes REGIME is `0.96/max_stack < column_term ≤ 1/max_stack`, which was
columns-bind and is now stack-bound. `refresh-manifest` will refuse every moved tree at its
bbox gate (correctly — the recompute disagrees with the committed framing), and a **re-bake
is the only remedy**. Measured on the committed
`tests/fixtures/golden_dataset_full_v2`: `range` `[0.04, 0.297539898]` → `[0.04,
0.287238302]`, `bbox_exact` `[0.026290322580645162, 0.0024193548387096645,
0.3112495752380157, 0.9975806451612903]` → `[0.026838709677419356, 0.0023225806451613075,
0.3003995922284951, 0.9576774193548386]`, `domain` unchanged.

Everything a consumer relies on is unchanged: `x` is still exactly linear in **seconds**,
`range` is still exactly the placement line (every column still lands on its own tick), and
both endpoints are still real occupied columns inside `bbox_exact`.

## [2.5] — 2026-07-21 — per-layout `annotations`: categorical band labels + datetime axis domain (MINOR)

> **MINOR bump** within major 2 (forward-compatible — no field removed or retyped;
> `SUPPORTED_MANIFEST_MAJOR` stays 2). The pipeline writes `manifest_version "2.5"`.
> Additive, landed via the coordinated producer+consumer PR (this seam) per the
> Schema Discipline rule. Ledger **T2-69** (labels) / **T2-72** Seam 2 (the annotations
> contract + DOM overlay substrate). Rides the T2-72 Seam 1 substrate (PR #179 /
> `feat/overlay-substrate`). Premise gate ratified by the operator 2026-07-21
> (`docs/spikes/spike_labels_aggregate_premise.md`).

### Why
Seam 1 shipped the DOM overlay substrate + a datetime axis whose time domain was
DERIVED render-time by sampling real dates via `getMetadata` (a shim — it couples to
the datetime plugin's linear time→x mapping, flagged at its derivation site). And two
plugins compute rich structure they then THROW AWAY: the categorical treemap computes a
per-category rectangle + member count (`categorical.py`, discarded at ~:131-150) and the
datetime layout computes `t_min`/`t_max` (`datetime_layout.py`, discarded at ~:73-80).
Seam 2 surfaces both into the manifest so the renderer can label categorical bands (the
ratified map convention — label everything, small bands reveal on zoom, labels sit in the
empty gaps beside their group, never over the images; only the structurally-missing bucket
renders muted) and draw the datetime axis from a REAL producer domain instead of the shim.

### Added
- **`layout_manifest.schema.json` — `layoutEntry.annotations`** (optional object,
  `minProperties: 1` — never emitted empty; new `$defs/layoutAnnotations` +
  `labelAnnotation` + `axisAnnotation`). Two arrays, each emitted by the family that owns it:
  - **`annotations.labels[]`** (categorical) — `{text, extent, count, missing?, priority?}`:
    - **`text`** (required): the band's category value, verbatim (data is king). MAY be the
      empty string for the structurally-missing bucket.
    - **`extent`** (required): the band's world bbox `[x_min, y_min, x_max, y_max]` in `[0,1]^2`
      — the treemap region INCLUDING its image-free inter-group gutter, from which the renderer
      derives the empty gap-slot the label sits in (never over images — ratified placement rule).
    - **`count`** (required): the band's member count — the renderer's default declutter rank
      (area == count for the treemap, by construction) and the source of the counts-in-label
      viewer toggle.
    - **`missing?`** (optional bool): true ONLY for the structurally-MISSING bucket (the
      categorical plugin's own null-value sentinel — pipeline-known missingness, NEVER
      value-sniffed). The renderer styles that band's label as a muted grey "no label".
    - **`priority?`** (optional number): reserved explicit declutter-rank override for future
      curation (the LEAN priority contract, ratified 2026-07-21: producer emits `label + bbox +
      count`, the renderer derives rank + greedy-culls per camera; this override is kept for later).
  - **`annotations.axes[]`** (datetime) — `{orientation, scale, domain, range, label}`:
    - **`orientation`** (`"x"`|`"y"`): the datetime layout maps time→x, so it emits `"x"`.
    - **`scale`** (`"time"`): `domain` is a datetime pair; the renderer draws calendar-nice ticks.
      **Forward-compat rule (review rider):** the enum constrains the PRODUCER; a READER hitting an
      unrecognized scale (a later minor's `"linear"`) must SKIP that axis, never reject the manifest.
    - **`domain`** (`[start, end]` ISO-8601 UTC strings): the axis endpoints (chosen over an epoch
      number for manifest readability; ancient years included). `start`→`range[0]`, `end`→`range[1]`.
    - **`range`** (`[lo, hi]` in `[0,1]`): the world-x sub-interval `domain` maps onto linearly.
      **Semantics restated by T2-138 (no field change, no version bump — see the note below):**
      `domain` = `[first bucket start, last bucket start]` and `range` = the placement band
      `[margin, 1-margin]`, together describing EXACTLY the line the placement uses, so every
      column lands on its own tick.
    - **`label`**: the datetime role's human label.
    - **The declined-axis marker (review rider):** a datetime layout that CONSIDERS and REFUSES its
      axis (degenerate span, single occupied column, or the R1 calendar-overflow guard) emits the
      EXPLICIT `{"axes": []}` — never omits `annotations` — so a reader can distinguish "pre-2.5
      bake, derive your own domain via the getMetadata shim" (absent) from "the producer declined"
      (empty array, shim FORBIDDEN — it would resurrect exactly the axis the producer refused,
      e.g. year-52,000 ticks from a malformed unix_seconds role).
  - **`labels` cap (review rider):** `maxItems: 500`, mirrored by the producer's `_MAX_LABELS` —
    a high-cardinality categorical column (10k+ distinct values) otherwise balloons the manifest
    ~1 MB and adds seconds of jsonschema time to every manifest write (which runs per layout flip).
    The producer emits the top-500 bands by count (the structurally-missing band always kept) and
    logs the truncation loudly; the renderer draws at most a few dozen per view regardless.
- **`layout_manifest.schema.json` — `pyramidDescriptor.dropped_total`** (optional integer ≥ 0,
  review rider): the bake's total subsampled-out cell count across all fine tiles — the tiler
  always computed this (`PyramidResult.dropped_total`) and discarded it manifest-side. `0` ⇔ no
  over-cap tile exists, letting the viewer SKIP its O(n) render-time pile re-derivation for the
  common no-pile layout instead of scanning 1M cells to find nothing. Absent on a pre-2.5 bake.
- **`layout_manifest.schema.json` — `layoutEntry.bbox_exact`** (optional array of 4 numbers in
  `[0,1]`): the FULL-PRECISION (unrounded float64) copy of `bbox`. **Why (chip-count exactness):**
  the PR #179 adversarial verification ground-truthed that the aggregate count chips (Seam 1)
  re-derive each pile's occupancy by transcribing the tiler's `_tile_xy` binning over
  `positions_ref` — but the tiler binned cell centres against the UNROUNDED layout bbox, while
  `bbox` is `round(v, 6)`, so boundary cells attribute to the adjacent tile vs the bake (measured:
  rijks scatter **17,403 re-derived vs 17,405 baked**, ≈5 % worst-tile drift; every counted cell
  real, attribution-only). `bbox_exact` carries the exact bbox the tiler used, so a 2.5-aware chip
  derivation bins IDENTICALLY to the bake and the chip counts drop their `~` approximation. Emitted
  on **every** layoutEntry of a 2.5 bake; absent on a pre-2.5 bake — the consumer falls back to the
  rounded `bbox` and keeps the honest approximation (graceful degradation). It is NOT used for camera
  framing (that reads `bbox`) — binning-exactness only, so `bbox` is unchanged for every other reader.

### Emission — what a 2.5 stamp does and does NOT guarantee
> **Corrected by the PR-180 review** (the earlier text here claimed an annotation-free dataset is
> "byte-for-byte its pre-2.5 form" — false on both sides, disproven by this PR's own code and
> fixture; a version stamp is NOT a field guarantee in either direction).
- A **fresh 2.5 bake** emits, on EVERY layoutEntry: `bbox_exact` + `pyramid.dropped_total`
  (unconditionally — so no fresh 2.5 manifest is byte-identical to its 2.4 form); plus
  `annotations.labels` on categorical layouts and `annotations.axes` on datetime layouts (a real
  axis, or the explicit `[]` declined marker). Grid / scatter / geographic emit no `annotations`.
- An **`append_manifest_layouts` run (add-layouts)** carries every PRIOR entry forward
  **byte-preserved** while re-stamping `manifest_version` — so a manifest stamped `"2.5"` can
  legitimately hold pre-2.5 entries with NONE of the new fields, and an existing categorical
  layout does NOT gain labels from add-layouts (that needs a full re-bake).
- **Therefore: readers MUST gate on FIELD PRESENCE, never on `manifest_version`.** Every consumer
  in this repo does (`bbox_exact !== undefined`, `annotations?.labels`, `pyramid.dropped_total`
  presence); future consumers inherit the rule via the schema descriptions.
- The comprehensive fixture **`golden_dataset_full_v2` was regenerated** through the real pipeline
  (its categorical×2 layouts gain `labels`, its datetime layout gains a snapped `axes` domain,
  every layout gains `bbox_exact` + `pyramid.dropped_total`, stamp → `"2.5"`) so the contract gate
  exercises the new emission end-to-end (its categorical columns carry no nulls, so no fixture band
  is `missing` — the missing-bucket path is covered by a producer unit test). Every other committed
  fixture is unchanged and stays valid (annotations are optional).

### Graceful absence (no consumer breaks)
- Every addition is optional/additive; a consumer that does not read them is unaffected. The API
  serves the manifest VERBATIM (major-2 gate only), so it accepts `"2.5"` with no change. Consumer:
  the frontend extends the hand-mirrored `LayoutEntry` (`renderer/layout.ts` — new `annotations`
  + `LayoutAnnotations`/`LabelAnnotation`/`AxisAnnotation` types) and the tolerant
  `validateLayoutManifest` (`api-client/client.ts` — a permissive `checkAnnotations`), and the
  overlay substrate (`renderer/overlayLayer.ts`) renders band labels in the gaps + REPLACES the
  Seam-1 datetime-domain shim with the producer `annotations.axes` (falling back to the shim ONLY
  when `annotations.axes` is ABSENT — a pre-2.5 datetime dataset; the explicit `[]` declined
  marker suppresses it — graceful degradation; the tick RENDER path is unchanged). The
  generated `column_roles.ts` type is unaffected (annotations live on the hand-mirrored manifest,
  not in column_roles). No new UI behaviour beyond the labels + counts toggle this seam.
- **Reader forward-compat (review rider):** the client validator treats `axis.scale` /
  `axis.orientation` as open strings (structure strict, VALUE-set open) and the consumer filters
  for the pairs it understands (`scale === "time" && orientation === "x"`) — so a FUTURE minor
  adding `scale: "linear"` (the D-35 scatter/geo axes) degrades to "that axis not drawn" instead
  of failing the entire dataset open, honouring the version promise above. The schema keeps the
  closed enums as the PRODUCER's write gate.

## [2.4] — 2026-07-20 — geographic layout family (lon/lat + projection) + `options.projection` echo (MINOR)

> **MINOR bump** within major 2 (forward-compatible — no field removed or retyped;
> `SUPPORTED_MANIFEST_MAJOR` stays 2). The pipeline writes `manifest_version "2.4"`.
> Additive, landed via the coordinated producer+consumer PR (this seam) per the
> Schema Discipline rule. Decision **[D-35](../../docs/decisions/D-35-geographic-scatter-layout-options.md)**
> Seam **G2**; ledger **T2-35** (geographic bundle core). Stacked on the G1 branch
> (v2.3); the geographic role + projection are the second of the two declared families.

### Why
Raw lon/lat need a real map, not the scatter x/y fit approximating one. D-35 makes
**geographic a FIRST-CLASS layout FAMILY distinct from scatter** (operator 2026-07-19):
scatter x/y are already-planar coordinates, but lon/lat MEAN longitude/latitude, so the
pipeline must **project** them (equirectangular or Web Mercator) before placing. Modelling
that as a scatter `normalize` value would conflate two different intents; a separate
`geographic` role keeps the families cleanly separated at every surface (roles contract,
wizard, switcher) and gives geographic its own options (projection; NO scale knobs —
degrees are degrees) while REUSING the shared scatter placement machinery downstream
(median-centred aspect fit → T2-85 north-up → unplaced strip → tiler) so there is one
place the box geometry lives.

### Added
- **`column_roles.schema.json` — new top-level `geographic` array** (`geographicRoleEntry`
  items — additive; absent = today's behavior, and a scatter-only dataset is byte-for-byte
  unchanged). Each entry is an atomic lon/lat pair driving one geographic layout:
  - **`lon_column` / `lat_column`** (required): the source columns carrying longitude in
    `[-180, 180]` and latitude in `[-90, 90]`. Values must parse as finite floats; empty/null
    marks the cell unplaced (the strip). Ingest fail-fasts (D-11) on an out-of-range value
    naming the column + offending value.
  - **`projection`** (`"equirectangular"` (default) | `"mercator"`): the map projection
    applied before the shared fit. Equirectangular (plate carrée — x=lon, y=lat, 1°=1°, what
    the implicit scatter fit already approximates, valid to the poles) or Web Mercator (the
    familiar web-map shape, `y = ln(tan(π/4 + φ/2))`, conformal but area-exaggerating toward
    the poles, limited to `|lat| <= 85.051129`). **BOTH ship** (D-35 Decision 4); the default
    is a §6.1 bless item (equirectangular as proposed). Under `mercator`, ingest additionally
    fail-fasts on `|lat| > 85.051129` (the Web-Mercator clip latitude — NO silent clamp,
    §6.2 as proposed). There are **NO scale knobs** on the geographic family.
  - **`overlap`** (`"overdraw"` (default) | `"jitter"` | `"aggregate"`): mirrors the scatter
    field — only `"overdraw"` implemented; `"jitter"`/`"aggregate"` are RESERVED and fail-fast
    at ingest (D-35 Seam G4).
- **`layout_manifest.schema.json` — `layoutEntry.type` enum gains `"geographic"`** (additive
  enum value; the renderer treats every layout generically from its pyramid + bbox, so it flows
  with no branch). **`layoutEntry.options` gains `projection`** (`"equirectangular"` | `"mercator"`)
  — the applied projection, echoed so the UI can EXPLAIN the map and a future T2-86 continent
  underlay can dispatch its projection. This `projection` is the geographic family's
  `fit_transform.kind` (deep-dive spike §3) — the MODE-NAME echo: a reader reconstructs the
  applied transform's kind ∈ {identity, aspect_fit, mercator, equirectangular} from `type` + the
  echoed fields (geographic ⇒ `options.projection`; scatter ⇒ `options.normalize`). Consistent with
  the G1-hardening scoping (see [2.3]), it is the fully PARAMETERIZED transform record
  (kind/domain/scale/offset) — NOT this mode-name echo — that gives the underlay BY-CONSTRUCTION
  alignment; that parameterized record is its own later work (T2-86), and this seam builds NO
  underlay/annotation, only records the kind so it can be derived. A geographic layout **always**
  emits `options` (projection is load-bearing); a scatter layout still emits it only when a
  non-default knob was declared (byte-stable default bakes).

### Byte-stability (no geographic role ⇒ no change)
- A dataset with no `geographic` role serializes exactly as before (the `geographic` array is
  omitted when empty), bakes no geographic layout, and — with default scatter knobs — is
  byte-for-byte its pre-2.3 form. The extraction of the shared placement helper (`_placement`)
  from `scatter.py` is a **pure refactor**: `scatter.py`'s output is unchanged (G1's unit tests +
  the refreshed golden fixture, whose grid/datetime/scatter/categorical layouts re-bake identically,
  prove it). `manifest_version` advances to `"2.4"` for FRESH bakes exactly as the pipeline has
  always stamped the latest minor.

### Graceful absence (no consumer breaks)
- Every addition is optional/additive; a consumer that does not read them is unaffected. The API
  serves the manifest VERBATIM (major-2 gate only), so it accepts `"2.4"` with no change. Consumer:
  the frontend regenerates `src/generated/column_roles.ts` (the D-16 gen-types gate — gaining the
  `geographic` array type) and extends the hand-mirrored `LayoutEntry.type` union + `LayoutOptions`
  (`projection`) + `validateLayoutManifest` (the `"geographic"` type enum + the tolerant
  `options.projection` check). No UI behavior change this seam — the wizard/switcher/map surface is
  D-35 Seam G3 (T2-125).

## [2.3] — 2026-07-20 — explicit scatter knobs (per-axis scale, normalize pass-through, overlap field) + per-layout `options` echo (MINOR)

> **MINOR bump** within major 2 (forward-compatible — no field removed or retyped;
> `SUPPORTED_MANIFEST_MAJOR` stays 2). The pipeline writes `manifest_version "2.3"`.
> Additive, landed via the coordinated producer+consumer PR (this seam) per the
> Schema Discipline rule. Decision **[D-35](../../docs/decisions/D-35-geographic-scatter-layout-options.md)**
> Seam **G1**; ledger **T2-34** (pass-through), **T2-118a** (the reworked #169
> log transform, now a DECLARED knob).

### Why
PR #169 (T2-118a) shipped an IMPLICIT scatter transform: natural-log any axis whose
values were all strictly positive. The review found the trigger conflates *positive*
with *multiplicative* — a positive-quadrant REGIONAL geographic scatter (Japan, India,
most of Eurasia) would silently log-warp its map, and positive ADDITIVE axes (years,
offsets) misfire too. The root problem was structural: the scatter role carried no
declaration of what its columns MEAN, so code could only *sniff values* where it needed
to *know intent*. D-35 ratifies **knobs, never sniffing** — every data-meaning-dependent
behavior is an explicit, schema-recorded option with a safe default — and **the user
decides; we inform** (fail-fast with a clear message naming the column and offending
value, never a silent fallback). The log transform returns as a DECLARED per-axis
`scale`; T2-34's pass-through joins as `normalize: "none"`; the `overlap` field lands now
(only `overdraw` implemented) so D-35 Seam G4 needs no further schema bump.

### Added
- **`column_roles.schema.json` — `scatterRoleEntry` gains four optional knobs**
  (all optional ⇒ additive; absent = today's behavior byte-for-byte). Every
  precondition below is enforced at **BOTH producer entry points** — a fresh CSV
  ingest (`ingest_metadata`) AND an add-layouts roles override
  (`run_add_layouts` via the parquet re-validation) — the override path is the
  natural way to apply a knob to an existing dataset (2026-07-20 seam review):
  - **`x_scale` / `y_scale`** (`"linear"` (default) | `"log"`): the per-axis scale
    applied BEFORE the fit. `"log"` (natural log) spreads a heavy multiplicative tail;
    it REQUIRES strictly-positive values on that axis over the rows that PLACE (a row
    missing either coordinate is unplaced and exempt — validation mirrors placement) —
    fail-fast (D-11) naming the column and the EXACT offending value (repr-precise:
    a value one ULP past a bound never prints as in-range). NEVER auto-selected from
    value shape. **Both axes must currently share one scale**: mixed `log`/`linear`
    fail-fasts, because the shared-scale aspect fit assumes commensurable axes and
    would crush the logged one (~144× measured; per-axis fit tracked as T2-128).
  - **`normalize`** (`"fit"` (default) | `"none"`): `"fit"` is today's aspect-preserving,
    median-centred auto-fit (with the T2-85 north-up inversion); `"none"` is PASS-THROUGH
    (T2-34) — the author's already-normalized `[0,1]^2` coordinates preserved EXACTLY up
    to ONE uniform ×0.95 scale on both axes into the placed band (operator-directed
    resolution, 2026-07-20). No per-axis warp, no re-centring, no north-up inversion —
    the author owns projection, aspect, and orientation. Cell size under pass-through
    derives from the OCCUPIED extent (count-only sizing would dwarf a sub-region
    placement and collapse the tiler's cell-size z-ceiling — ~97% fine-tier subsampling
    measured on a regional-geo shape), and the missing-coordinate strip is an ADJACENT
    BLOCK one gutter below the occupied extent, never intermixed with real datapoints
    (round-2 review, 2026-07-20: an absolute far-corner band let ONE missing-coordinate
    cell blow the layout bbox to ~850× the data — a fit-view smudge — and the
    extent-derived cell size made that band a hairline; with canvas-spanning data the
    block falls back to the bottom band `y > 0.95`, adjacent in exactly that case).
    `"none"` REQUIRES both axis columns' placing values within `[0,1]` — fail-fast naming
    the column and exact offending value. Declaring `"none"` together with a `"log"` axis
    scale is contradictory (log would push a `[0,1]` value out of range) and fail-fasts —
    a declared log is never silently dropped.
  - **`overlap`** (`"overdraw"` (default) | `"jitter"` | `"aggregate"`): how co-located
    images present. Only `"overdraw"` (today's behavior) is IMPLEMENTED; `"jitter"` and
    `"aggregate"` are RESERVED contract values (so D-35 Seam G4 adds no schema bump) that
    fail-fast at both entry points ("overlap '<v>' … is not implemented yet (coming —
    D-35 G4)") rather than being silently ignored.
- **`layout_manifest.schema.json` — `layoutEntry.options`** (optional object,
  `minProperties: 1` — never emitted empty): an ECHO of the layout-shaping options
  APPLIED at bake time (`x_scale` / `y_scale` / `normalize` / `overlap` as applied for a
  scatter layout), so the UI can EXPLAIN an existing bake, not only configure the next
  one. The property set is a SUPERSET shared across layout families (the geographic
  family, D-35 Seam G2, extends the SAME object with `projection` — a coordinated MINOR
  at that seam — landed in [2.4]), shaped to reconcile with the deep-dive spike's `fit_transform`
  direction: G2's `projection` echo is the mode-name `fit_transform.kind`, while the fully
  PARAMETERIZED transform record (kind/domain/scale/offset) is its OWN later work (T2-86); it
  is that record, not this mode-name echo, that gives the T2-86 underlay by-construction
  alignment. **Emitted ONLY when a NON-DEFAULT knob was declared** — a
  default bake omits the object entirely, so pre-2.3 manifests and default bakes are
  byte-identical.
- **`append_manifest_layouts` now RE-STAMPS `manifest_version`** to the current minor on
  an add-layouts merge (previously carried the committed value verbatim): an appended
  entry may carry current-minor fields (this `options` echo), so the merged file must
  self-describe as what it actually contains. Consumers are major-only — behavior-neutral.

### Byte-stability (absent knobs ⇒ no change)
- A scatter role with no knobs serializes to exactly `{x_column, y_column, label}` (the
  producer emits a knob key only when it is non-default), and a layout baked with all
  defaults emits no `options` object. The committed golden fixtures are NOT regenerated by
  this MINOR and stay valid unchanged; the contract gate (which validates the static
  fixtures and checks only `manifest_version` major 2) stays green. `manifest_version`
  advances to `"2.3"` for FRESH bakes exactly as the pipeline has always stamped the latest
  minor (the committed fixtures already lag — e.g. `golden_dataset_v2` is `"2.1"`).

### Graceful absence (no consumer breaks)
- Every new field is optional; a consumer that does not read them is unaffected. The API
  serves the manifest VERBATIM (major-2 gate only; `api/db.py` does not re-validate against
  the schema — jsonschema is deliberately not an API dependency), so it accepts `"2.3"` with
  no change. Consumer: the frontend regenerates `src/generated/column_roles.ts` (the D-16
  gen-types gate) and extends the hand-mirrored `LayoutEntry` + `validateLayoutManifest`
  (`api-client/client.ts`) to TOLERATE the optional `options` key (absent is fine; unknown
  keys preserved for G2's `projection`). The wizard's roles round-trip
  (`ui/admin/roles.ts`) carries the four knobs VERBATIM — the Add-Layout wizard re-POSTs
  the whole `column_roles`, so a knob dropped there would silently strip the committed
  manifest (found + fixed in the 2026-07-20 seam review; declared stays declared, absent
  stays absent, pinned by the round-trip identity test). The round-2 review (2026-07-20)
  extended the same faithfulness to the REST of the projection: human LABELS are captured
  per column and re-emitted verbatim (previously reset to normalized defaults —
  "Accession number" → "Filename" — on any re-POST of a CLI-seeded dataset's roles; they
  feed search-hit + metadata-panel display), the reserved `embedding` role is carried
  opaquely (previously stripped), and repointing a scatter axis in the wizard DROPS the
  pair's carried knobs (a knob was declared — and validated — for the original columns).
  Producer-side, `run_add_layouts` rejects a roles override that changes the KNOBS of an
  already-committed scatter pair (never re-baked there ⇒ the manifest would contradict
  the baked positions and their `options` echo; pair-matched, so the single→multi
  layout-id naming transition cannot mask it). No knob-EDITING surface this seam — the
  wizard/switcher surface is D-35 Seam G3 (T2-125).

## [2.2] — 2026-07-06 — per-layout position table (`positions_ref`) for pick-at-any-zoom (MINOR)

> **LOCKED / IN-FORCE.** **MINOR bump** within major 2 (forward-compatible — no
> field removed or retyped, `SUPPORTED_MANIFEST_MAJOR` stays 2). The pipeline writes
> `manifest_version "2.2"`. Additive, architect-approved shape; landed via a
> coordinated producer+consumer PR (this seam) per the Schema Discipline rule. Ledger
> **T2-66** (pick/select at any zoom) / **T2-48** (the shared position-table enabler).

### Why
The renderer can only pick a cell where per-cell geometry is resident — the FINE
tier (`z >= z_cap`). Zoomed out, the canvas draws mosaic COARSE overview quads (one
per tile), so there is nothing per-cell to hit-test and `cells.hitTestCells`
(`frontend/src/renderer/cells.ts`) returns a miss — you cannot select an image until
near-max zoom. A per-layout id→(x,y,w,h) table resident in the renderer lets the pick
path resolve a cell rectangle at ANY zoom (coarse tier included), and is the shared
enabler for the live minimap and box/lasso multi-select (T2-48).

### Added
- **`layout_manifest.schema.json` — `layoutEntry.positions_ref`** (optional, nullable
  `string`): the dataset-relative path of this layout's POSITION TABLE — an
  UNCOMPRESSED Arrow IPC (Feather) file (decision D-29) with four float32 columns
  `x, y, w, h`, the SAME normalized [0,1]^2 cell rects the fine-tier cell records carry
  (sourced from the layout result, never re-derived). **No `id` column**: the row index
  IS the dense cell id (row i == cell id i over the contiguous-dense `[0, image_count)`
  space the v2 cell_record `id` contract pins), which is smaller on disk and
  unambiguous. Version-embedded filename (e.g. `positions/grid_v3.arrow`) so it is
  immutable-cacheable, exactly like the tag sidecar (`tags/tags_v{ver}.arrow`) and the
  pyramid container. Authored PER LAYOUT (each layout places the same cell at a
  different (x,y)), distinct from the one-per-dataset tag sidecar. Served statically by
  the Caddy edge under `/datasets/{ds_id}/positions/...`, gated by the same D-A
  `forward_auth` cookie as every other `/datasets/*` asset — **no API change** (the gate
  keys on `{ds_id}`, not the asset path). Size: ~16 bytes/cell → ~16 MB/layout at 1M.

### Graceful absence (no consumer breaks)
- **Absent or null ⇒ fine-tier-only picking, no error.** A dataset baked before this
  MINOR carries no `positions_ref`; the renderer keeps its exact pre-2.2 behaviour
  (pick only where the fine tier is resident). Producer: `pipeline.ingest`
  (`write_positions_table`, the sidecar-writing sibling of `write_tags_sidecar`, D-29
  uncompressed) + `pipeline.manifest` (`_layout_entry` sets the ref) + `pipeline.worker`
  (`run_ingest` per-layout commit + `run_add_layouts` — added layouts get a table,
  carried-forward layouts keep their existing refs byte-preserved). Consumer:
  `frontend/src/api-client/client.ts` (`positionsUrl` / `fetchPositions`, mirroring the
  tag sidecar single-flight + one-entry-bound + 401-credential-refresh path) +
  `frontend/src/renderer/tilePyramid.ts` (per-layout fetch/cache, released on dataset
  switch; registers a coarse-pick fallback on `cells.ts`) +
  `frontend/src/renderer/cells.ts` (the pick path calls the fallback on a fine-tier
  miss, reusing `hitTestCells` for identical overlap resolution) +
  `frontend/src/renderer/layout.ts` (the `positions_ref` field on the manifest mirror).
  The renderer's runtime manifest validator (`validateLayoutManifest`,
  `checkManifestVersion`) already accepts any `2.x`, so `2.2` passes; the generated
  `column_roles` type is unaffected.

### Follow-up (recorded)
- The renderer's coarse-tier pick over the position table is a **linear O(N) scan** of
  the typed arrays per click (fine at 10k, measurable at 1M). It is structured behind a
  small function so a **spatial index** (e.g. a grid/quadtree) can replace it later with
  NO schema or on-disk change — the table shape is the same. Owner: a follow-up renderer
  seam (the W1/W4 selection work that consumes this table).

## [2.1 addendum] — 2026-07-06 — coarse tile ALPHA pad documented (DOCUMENTATION ONLY, no version bump)

> **No version bump; no field added, removed, or retyped.** `manifest_version`
> stays `"2.1"` and `SUPPORTED_MANIFEST_MAJOR` stays 2. This records a
> producer↔consumer semantic that `tile.schema.json` previously abstracted as
> "a WebP image" (Seam A, decision D-iv, PR #111). It is deliberately NOT gated on
> `manifest_version`: a consumer keys this on the tile bytes (alpha channel present
> or not), never on the manifest, and the emitted manifest is byte-unchanged — so a
> bump would be a misleading signal and would needlessly churn every manifest
> fixture + the `manifest_version == "2.1"` assertions. Logged here per the Schema
> Discipline rule (record every change to a `schemas/v2/*.json` file).

### Changed (description clarified — no field added, removed, or retyped)
- **`tile.schema.json` — coarse tile**: documented that the COARSE (mosaic) tile
  body is an RGBA WebP with a fully TRANSPARENT pad (alpha 0) and OPAQUE cells, RGB
  kept STRAIGHT (un-premultiplied), and that a consumer composites it with
  straight-alpha over-blending OVER the layout ground rather than painting an opaque
  black pad. Purely additive: a 3-band or fully-opaque coarse tile (legacy/dense-only
  bakes) renders identically because the straight over-blend degenerates to
  passthrough at alpha 1, so no consumer that already reads the coarse WebP breaks.
  The FINE mini-atlas stays 3-band opaque (its pad slots are never sampled). Producer:
  `pipeline.tiler._build_spatial_render` / `_shrink_children_to_parent`; consumer:
  `frontend/src/renderer/tilePyramid.ts` `drawOverview` + `decodeImageTextureReal`
  (straight decode + `NormalBlending`).

## [2.1] — 2026-06-27 — subsample reconciliation + documented tile body framing (MINOR)

> **LOCKED / IN-FORCE.** **MINOR bump** within major 2 (forward-compatible — no
> field added or removed, `SUPPORTED_MANIFEST_MAJOR` stays 2). Two clarifications
> the v2 producer seam (PR #63) surfaced under adversarial review. The pipeline
> writes `manifest_version "2.1"`. Landed via the #63/#66/#68/#69/#72 PR chain.

### Changed (descriptions tightened — no field added or removed)
- **`cell_record.schema.json` — `id`**: split the conflated invariant into TWO.
  (1) id **NUMBERING** stays HARD — `[0, image_count)` with no holes in the integer
  space (the renderer's id-indexed dense buffers depend on it; decode-failures consume
  no id). (2) fine-tile **PLACEMENT** is RELAXED — an id MAY be absent from every fine
  tile, but ONLY if the tile that would have held it recorded the cell among its
  `subsampled.dropped` count. A subsampled id keeps its dense numbering + metadata row
  and is reachable via the detail tier; the renderer initializes such an unpositioned
  cell as INVISIBLE (not visible at 0,0). This reconciles coincident-point subsampling
  (degenerate scatter at the deepest level) with the dense-id contract that the v2 gate
  previously asserted hollowly (every committed fixture was N << cap, so subsampling
  never fired).
- **`layout_manifest.schema.json` — `dataset_metadata.image_count`**: restated to match —
  `image_count` = decoded + id-assigned cell count; when subsampling occurred the
  fine-tile id union is a STRICT SUBSET of `[0, image_count)`; the id NUMBERING still has
  no holes. Also `manifest_version` description: the pipeline writes `"2.1"`.
- **`tile.schema.json`**:
  - **DOCUMENTED the tile body byte framing** (was previously undocumented — review
    finding PMT-1): a FINE tile body is `[uint32 BIG-ENDIAN image_len][WebP mini-atlas
    bytes][Arrow IPC record table bytes]`; a COARSE tile body is the raw WebP image
    (no prefix). Repointed the former dangling "(see encoding)" references to this new
    framing text. Producer: `pipeline.tiler._pack_fine_body` / `unpack_fine_body`.
  - **`fineTile.subsampled.dropped` is now the documented home** for the per-tile dropped
    count, with its on-disk channel pinned: the count rides the FINE tile's Arrow record
    table at the SCHEMA level (`table.schema.metadata[b"subsampled.dropped"]` = decimal
    string); absent ⇒ nothing dropped. The contract gate asserts
    `|distinct fine-tile ids| + sum(subsampled.dropped) == image_count`.
- **`layout_manifest.schema.json` (`detail.mode` / `detail.path_prefix` / `detail`) +
  `cell_record.schema.json` (`detail_ref`)**: aligned the DETAIL-tier resolution prose with
  the IMPLEMENTED behaviour (frontend seam, PR #69 review). The renderer resolves the
  click-through preview by DENSE cell id at the fixed API route
  `GET /api/datasets/{ds}/detail/{cell_id}.{ext}` (reading only `detail.format` for the
  extension); the API composes `{detail.path_prefix}/{cell_id}.{ext}` SERVER-SIDE
  (`api/routers/tiles.py`). `path_prefix` is therefore a server-side storage prefix, not a
  renderer input, and `cell_record.detail_ref` is RESERVED/unused by the current consumer
  (kept for a future arbitrary-path mode). No field added, removed, or retyped — and no
  producer/api code change: this documents what producer (`pipeline.manifest` /
  `worker._DETAIL_DIR`) and api already do; the previous prose described a never-built
  "renderer reads detail_ref" model.

## [2.0] — 2026-06-26 — D-33 spatial tile-pyramid contract (MAJOR; renderer rework)

> **LOCKED / IN-FORCE.** **MAJOR bump. CLEAN REWRITE, NO v1.x back-compat.** v1.x datasets are
> re-ingested (no users — decision D-33). The v2 contract replaces the shared
> id-ordered global atlas + fixed 3-level LOD model with a **per-layout,
> self-describing spatial tile pyramid** (web-map XYZ). This is the cross-package
> contract for the renderer rework documented in
> [`docs/plan/renderer-rework-plan.md`](../../docs/plan/renderer-rework-plan.md)
> (PR #60), which replaces the id-ordered atlas pager and its ~14 fighting guards.

### Why (the diagnosis the rework cures)
The v1.x pipeline baked thumbnails (32/128/512px) into shared 4096² atlas pages
in **image-id order**; a tile carried only pointers `(id, x/y/w/h, atlas_page,
atlas_uv, lod)` into that one id-ordered atlas. Because on-screen cells are
id-arbitrary, "which atlas pages does this view need?" fans out across the whole
atlas — one `inat_100k` viewport quadrant touches **228 of 1,563 LOD2 pages
(~15 GB VRAM)** against a ~32-page (~2 GB) ceiling
([`renderer-rework-plan.md`](../../docs/plan/renderer-rework-plan.md) §1). v2 stores
pixels **by space, per layout**, so a fixed screen overlaps a fixed, small number
of uniform tiles — the working set is bounded by construction.

### Added
- **`layout_manifest.schema.json` — `layoutEntry.pyramid`** (required): a
  **self-describing spatial tile pyramid** per layout (`$defs/pyramidDescriptor`).
  Carries `container` (`pmtiles`), `path` (the version-embedded PMTiles container),
  `tile_px` (default 512), `thumb_px` (default 64, per-dataset bake-time param from
  env `IMAGE_VIZ_TILE_THUMB_PX`), `cap` (`floor(tile_px/thumb_px)^2`), an ordered
  **variable-length** `levels` list (each `{z, tile_count}`), and `z_cap` (required — the
  **single source of truth** for the coarse/fine boundary: a level is coarse iff `z <
  z_cap`, fine iff `z >= z_cap`, so the tile type is derived, never stored per level).
  This **replaces** the fixed global `atlas` block — the level count is no longer pinned
  at 3.
- **`layout_manifest.schema.json` — `layoutEntry.detail`** (optional, nullable): the
  deepest DETAIL tier (backlog T2-26) — declares how a cell's individual full-res
  original is resolved (`mode` ∈ `image_ref`|`pmtiles`).
- **`tile.schema.json`** (NEW FILE): documents the **hybrid tile types** — a COARSE
  tile is a single down-rendered MOSAIC composite image (no per-cell records); a FINE
  tile is a self-contained MINI-ATLAS image plus a per-cell record list. No v1.x
  equivalent (v1 had no self-contained tiles).
- **`cell_record.schema.json` — `detail_ref`** (reserved, nullable `utf8`): per-image
  reference for the detail tier. **`level`** (reserved, nullable, **unbounded** int):
  the pyramid z (replaces `lod`).

### Changed
- **`layout_manifest.schema.json` — `manifest_version`** pattern `^1\.(0|1)$`
  → `^2\.(0|[1-9][0-9]*)$`. v2 readers reject v1.x manifests (clean break).
- **`layout_manifest.schema.json` — top-level `required`** drops `atlas` (removed);
  adds nothing else required at root (`pyramid` is required *within* each layout).
- **`cell_record.schema.json` — UV fields renamed/re-scoped**: `atlas_u/atlas_v/
  atlas_w/atlas_h` → **`u/v/uw/uh`**, now a sub-rect into the **tile's own
  mini-atlas** (not a shared global atlas page). Required set becomes
  `id, x, y, w, h, u, v, uw, uh`.
- **`column_roles.schema.json`** — **shape UNCHANGED**; only `$id` and the version
  sentence bump to 2.0. The metadata join (cell `id` ↔ source `filename`) and every
  role (`datetime`/`categorical`/`scatter`/`tag`/`freeform`/`embedding`) are preserved
  verbatim (D-33 preserves the metadata-join). Carried into `schemas/v2/` (rather than
  `$ref`-ing v1.1) so the v2 directory is a self-contained MAJOR contract.

### Clarified / pinned (no field added or removed — descriptions tightened)
- **`cell_record.id` is pinned CONTIGUOUS DENSE `[0, image_count)`** (and
  `dataset_metadata.image_count` is restated as both the count and the exclusive id upper
  bound). This is the contract the renderer's id-indexed dense buffers already depend on
  (`renderer/layout.ts` `evaluateTagSelection` / `buildTargetField`); a baker that dropped a
  decode-failed id would corrupt them. Made explicit so the v2 per-layout tile baker keeps
  ids gap-free.
- **Cross-field invariants the schema cannot express, deferred to a CONTRACT TEST** (noted
  in `pyramidDescriptor.$comment` / the `thumb_px` description): `thumb_px <= tile_px`; and
  `cap == floor(tile_px/thumb_px)^2`. The architect-owned gate
  `tests/contract/test_fixture_conforms_schemas.py` must assert these when re-targeted to
  v2. (The coarse/fine partition is **no longer** such an invariant: `z_cap` is the single
  stored boundary and per-level tile type is derived from it — there is no `band` field to
  diverge, so nothing to assert.)

### Removed
- **`layout_manifest.schema.json` — the whole `atlas` block** (`atlasConfig`:
  `page_size_px`, `path_prefix`, `format`, `lod_levels` with `minItems`/`maxItems` = 3).
  v2 has no shared global atlas; pixels live in per-layout pyramids. The fixed
  3-level LOD ceiling (AGENT_GUIDE "The LOD ceiling is fixed at exactly 3 levels")
  is **gone** — this is the structural change that required the MAJOR bump.
- **`layout_manifest.schema.json` — `layoutEntry.tile_root`** (the per-LOD quadtree
  index root `{tile_root}lod{n}/{z}/{x}/{y}.feather`). Replaced by
  `pyramid.path` (one PMTiles container per layout) + `{layout}/{z}/{x}/{y}`.
- **`cell_record.schema.json` — `atlas_page`** (int32) and **`lod`** (int8, enum
  `{0,1,2}`). No global page index in v2 (the tile IS the texture); the level is the
  variable, unbounded `level` field.

### Rejected alternatives (recorded)
- **Loose `{z}/{x}/{y}` tile files** instead of PMTiles — rejected: at 1M images ×
  ~10 layouts the file count explodes (the 512px tier alone was 156k files at 1M;
  [`renderer-rework-plan.md`](../../docs/plan/renderer-rework-plan.md) §4). PMTiles is
  one range-served immutable file per layer.
- **Additive `schemas/v1.2/`** (a 4th LOD level) — rejected: a genuine pyramid has a
  **variable** band count, which the v1.x `lod_levels minItems/maxItems = 3` and
  `cell_record.lod ∈ {0,1,2}` cannot express. Removing those pins is a removal/retype
  ⇒ MAJOR, not additive (per the v1.0 versioning policy and AGENT_GUIDE).
- **Full per-layout re-pack of all three pixel tiers (32/128/512px)** — rejected on
  cost: 9.4× today's storage. v2 adopts the HYBRID (drop the 512px tier — 88% of
  footprint; spatially re-pack 32+128px per layout; serve deep zoom from individual
  images) at ~1.2× today's storage (§4).

### Migration
- **Re-ingest.** No back-compat shim and no in-place upgrade. The pipeline re-bakes
  per-layout pyramids; the API serves them; the renderer is rewritten on the kept
  instanced core. Acceptable because there are no users (D-33). `schemas/v1/` and
  `schemas/v1.1/` stay frozen as the historical contract for any v1.x dataset that is
  not re-ingested; nothing reads them at runtime once a dataset is re-baked to v2.

### Versioning policy (in force from the v2 lock, 2026-06-29)
- Adding a new nullable cell-record column or an optional manifest field is a MINOR
  bump (`schemas/v2.1/`), forward-compatible, with a coordinated producer+consumer PR.
- Removing, renaming, or changing the type/nullability of any field is a MAJOR bump
  (`schemas/v3/`).
