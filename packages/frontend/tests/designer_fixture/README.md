# The golden full fixture, refreshed by the real producer

Two manifests, made the same way and kept for opposite reasons:

| file | what it reproduces |
|---|---|
| `layout_manifest_2.10.json` | **every collection baked or refreshed since seam L7** — each layout records `source_fingerprint`, so the designer can say whether its bake is out of date |
| `layout_manifest_2.9.json` | **every collection baked between seams L3 and L7** — `source_columns` present, `source_fingerprint` absent, i.e. the "records no fingerprint" case, which is `checkable: false` and must never read as *fresh* |

The 2.8 half of the same tests reads
`tests/fixtures/golden_dataset_full_v2/layout_manifest.json` unchanged, because every
pre-2.9 collection in production looks exactly like it.

Neither file was written by hand, and `tests/fixtures/` was never written to.

## `layout_manifest_2.9.json`

The pending-change model (`src/ui/designer/pending.ts`) predicts what a role edit does to
each baked layout from `layoutEntry.source_columns`, which manifest **2.9** added. No
committed fixture carries it: every `tests/fixtures/*/layout_manifest.json` is 2.8 or older.
So this file was made by running the **real producer** on a copy of
`tests/fixtures/golden_dataset_full_v2`.

Made 2026-09-21 (seam L3), from the repo root in Git Bash, against a worker image built
from this branch:

```bash
MSYS_NO_PATHCONV=1 docker build -f docker/Dockerfile.worker -t iv-worker-l3 .
TMP=$(mktemp -d) && cp -r tests/fixtures/golden_dataset_full_v2 "$TMP/"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$TMP"):/out" iv-worker-l3 \
  pixscope refresh-manifest --dataset-id golden_dataset_full_v2 --output-root /out --force
cp "$TMP/golden_dataset_full_v2/layout_manifest.json" packages/frontend/tests/designer_fixture/layout_manifest_2.9.json
```

`--force` is required: without it `refresh-manifest` refuses, because the 2.8 manifest
already carries the 2.5 enrichment ("nothing to do"). The refresh changed exactly two
things, checked with `diff` against the committed 2.8 file: `manifest_version` `2.8` →
`2.9`, and a `source_columns` list on each of the six layouts (`grid` `[]`, `datetime`
`["captured"]`, `scatter` `["sx","sy"]`, `categorical_group` `["group"]`,
`categorical_bucket` `["bucket"]`, `geographic` `["lon","lat"]`). `dataset_version` stays 1.

**This file is kept, not replaced.** It is the production-shaped "records no fingerprint"
case for every collection baked between L3 and L7, and `derived.baked` must report all six
of its layouts `checkable: false` — never *fresh*.

## `layout_manifest_2.10.json`

Seam L7 added `layoutEntry.source_fingerprint` (manifest **2.10**) — *how* each layout read
its columns. Made 2026-09-23 the same way, from the same 2.8 source, against a worker image
built from this branch:

```bash
MSYS_NO_PATHCONV=1 docker build -f docker/Dockerfile.worker -t iv-worker-l7 .
TMP=$(mktemp -d) && cp -r tests/fixtures/golden_dataset_full_v2 "$TMP/"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$TMP"):/out" iv-worker-l7 \
  pixscope refresh-manifest --dataset-id golden_dataset_full_v2 --output-root /out --force
cp "$TMP/golden_dataset_full_v2/layout_manifest.json" packages/frontend/tests/designer_fixture/layout_manifest_2.10.json
```

Because the source is the **2.8** manifest, the diff against it shows `source_columns`
appearing as well as `source_fingerprint`. Against `layout_manifest_2.9.json` it shows
exactly the 2.10 delta, checked with `diff`: `manifest_version` `2.9` → `2.10`, and a
`source_fingerprint` object on each of the six layouts —

| layout | `source_fingerprint` |
|---|---|
| `grid` | `{}` — reads no column, so no way of reading is recorded |
| `datetime` | `{"captured": [["datetime", "iso8601"]]}` |
| `scatter` | `{"sx": [["scatter","x","sy","linear","linear","fit","overdraw"]], "sy": [["scatter","y","sx", …]]}` |
| `categorical_group` | `{"group": [["categorical"]]}` |
| `categorical_bucket` | `{"bucket": [["categorical"]]}` |
| `geographic` | `{"lat": [["geographic","lat","lon","equirectangular","overdraw"]], "lon": [["geographic","lon","lat", …]]}` |

`dataset_version` stays 1. The run reported `Recorded how 6 layout(s) read their columns`:
every layout in this tree carries a `positions_ref`, so refresh's per-cell reproduction
gate (Gate B) ran on all six and the fingerprints are **checked, not asserted** —
`--assume-roles-unchanged` was not needed and must never be implied.

The knobs in the scatter and geographic tuples are the defaults `ColumnRoles.from_config`
fills in for entries that declare none, which is why an entry written as just
`{x_column, y_column, label}` still fingerprints with four of them.

## `knob_guard_cases.json` — written by hand, and why that is safe

Unlike the two manifests, this file IS hand-written: it holds **cases**, not producer
output. It is the vector for LAYOUT_DESIGNER D-xxx — which add-layouts roles overrides the
worker's stale-knob guards refuse — and it is read by **two** suites:
`packages/pipeline/tests/test_knob_guard_fingerprint.py` runs every case through
`_guard_no_stale_scatter_config` / `_guard_no_stale_geographic_config`, and
`tests/ui_designer_layouts_commit.test.ts` runs it through `layoutsCommit.knobConflicts`.
So neither the worker nor the designer can change what it refuses without the other suite
going red.

Every committed manifest a case describes is assembled from the two real manifests above,
entry by entry: `from: "2.10"` takes the entry that records `source_fingerprint`,
`from: "2.9"` the one that records none. A mix is a state production reaches — `add-layouts
--replace X` on a pre-2.10 tree records a fingerprint for X and carries every other entry
byte-preserved — and the guards read only a layout's id and whether it records one. The
file's own `about` block is the format.

### Why it lives here, and not beside `datetime_tick_vector.json`

The repo's other two-suite vector is `tests/fixtures/datetime_tick_vector.json`, with its
Python half in `tests/contract/`. This one stays here, beside the two manifests, on purpose
(review of #392, finding 4, 2026-09-28):

- **Its cases are not standalone data.** The tick vector carries everything it asserts. Every
  case here is assembled from `layout_manifest_2.9.json` and `layout_manifest_2.10.json`, so
  moving the vector alone would still leave the Python half reading this directory, and
  would split one fixture set across two.
- **Moving the manifests too is the churn the move would buy.** They are read by nine
  frontend test files (`tests/ui_designer_*.test.ts` and `tests/dom/designer*`), and their
  provenance commands above name this path. The pipeline suite reads the 2.9 manifest for
  more than the vector as well: `test_knob_guard_fingerprint.py`'s end-to-end refusal and
  `test_add_layouts.py`'s replace pin, both on the golden tree.
- **`tests/contract/` is architect-tier** (AGENT_GUIDE, "How You Are Being Used"). The tick
  vector's Python half says so of itself. Promoting this one there is a placement decision
  for that tier, not a side effect of a review fix.

So `packages/pipeline/tests/` reads `packages/frontend/tests/designer_fixture/`, which
nothing did before #392. Both directories ship in the public repo (`packages` is on the
publish allow-list whole), so no build that has one lacks the other.
