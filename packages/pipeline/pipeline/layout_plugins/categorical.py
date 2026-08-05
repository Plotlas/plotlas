"""Categorical layout: groups cells by a categorical role into [0,1]^2 regions.

Each distinct value of the entry's categorical column gets a rectangular region
whose area is **proportional to its member count** (reconciliation #8) — a
dependency-free squarified treemap (Bruls-style greedy banding), so areas are
exact (trivially within the ±20% bound) and aspect ratios stay low (≤ ~4:1
where feasible). Members fill a sub-grid within their region; the inter-group
gap is preserved (``_REGION_FILL``). Missing values group under ``""``.
Deterministic: groups are keyed by sorted value; treemap placement orders them
by (count desc, key) — the standard squarify order, a pure function of the same
inputs (no RNG). Coordinates are explicit [0,1]^2 floats.

The categorical role is a multi-entry family (reconciliation #9): ``compute()``
reads ``roles.categorical[config["entry_index"]]`` (default 0) and the worker
invokes it once per entry — see worker.py's expansion convention.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from typing import TYPE_CHECKING

from pipeline.layout_plugins.base import (
    ColumnRoles,
    LayoutPlugin,
    LayoutResult,
    Role,
    build_spatial_cells,
    packed_ids,
    spatial_bbox,
)

if TYPE_CHECKING:
    import pyarrow as pa

    from pipeline.atlas import ThumbnailCache

# Fraction of each region the member sub-grid fills (the rest is inter-group gap).
_REGION_FILL = 0.9

# The STRUCTURAL sentinel for a missing category (v2.5 / T2-69). ``compute`` maps a
# cell whose categorical value is None (or has no metadata row) to this key, so the
# band grouped under it is EXACTLY the pipeline-known-missing cells — never a
# value-sniffed match on a real string like "unknown"/"anonymous" (those are genuine
# values and group honestly). The band's label annotation carries ``missing: true`` so
# the renderer styles it as a muted "no label" (the ratified 2026-07-21 ruling).
# NOTE (verification, PR-180 follow-up): the fresh-CSV ingest path CANNOT produce a genuine
# empty-string category value at all — DuckDB's ``read_csv_auto(..., all_varchar=true)`` maps
# both a blank field and an explicitly-quoted ``""`` to SQL NULL (executed and confirmed), so
# every member of this band is genuinely null-or-absent and ``missing: true`` is exact, not
# approximate. Only a hand-crafted Parquet could smuggle a real ``""`` in; it would then read
# "no label" — still honest.
_MISSING_KEY = ""

# Hard cap on emitted band labels (PR-180 review). One label per distinct value with NO cap
# let a high-cardinality categorical role (``artist``/``title``, rijks-shaped: ~10k distinct)
# balloon the manifest ~1 MB and add ~4 s of jsonschema time to EVERY manifest write (it runs
# per layout flip), while the renderer draws at most ``labelMaxCount`` (60) anyway and culls
# the rest per camera. The top ``_MAX_LABELS`` bands by count are emitted (placement order is
# already count-desc) — zoom-reveal keeps working for every emitted band — and the
# structurally-missing band is ALWAYS kept (its honesty is the point). The truncation is
# logged loudly, never silent. Mirrors ``maxItems`` on ``labels`` in
# schemas/v2/layout_manifest.schema.json — keep the two in sync.
_MAX_LABELS = 500

logger = logging.getLogger(__name__)


def _clamp01_round(value: float) -> float:
    """Clamp into [0,1] and round to 6 decimals — the tidy world-coord form the manifest
    emitter already uses for ``bbox`` — so a label ``extent`` stays in range (schema
    minimum 0 / maximum 1, the regions tile [0,1]^2 up to float error) and byte-stable
    across regens."""
    clamped = 0.0 if value < 0.0 else 1.0 if value > 1.0 else float(value)
    return round(clamped, 6)


def _worst_aspect(row: list[float], length: float) -> float:
    """Worst region aspect ratio if `row` (area shares) forms one band laid
    across a side of size `length`."""
    thickness = sum(row) / length
    worst = 1.0
    for share in row:
        extent = share / thickness
        ratio = extent / thickness if extent > thickness else thickness / extent
        worst = max(worst, ratio)
    return worst


def _proportional_regions(weights: list[float]) -> list[tuple[float, float, float, float]]:
    """Partition the unit square into one rectangle ``(x0, y0, w, h)`` per weight,
    with areas exactly proportional to the weights (squarified treemap, greedy
    banding in the given order). Deterministic — pure arithmetic, no RNG. Bands
    are laid across the shorter side of the remaining rectangle and a band
    accepts the next weight only while its worst aspect ratio does not worsen,
    which keeps regions ≤ ~4:1 where feasible."""
    total = float(sum(weights))
    shares = [w / total for w in weights]
    rects: list[tuple[float, float, float, float]] = []
    x0 = y0 = 0.0
    w_rem = h_rem = 1.0
    i = 0
    n = len(shares)
    while i < n:
        horizontal = w_rem <= h_rem            # band spans the (shorter) width
        length = w_rem if horizontal else h_rem
        row = [shares[i]]
        j = i + 1
        while j < n and _worst_aspect(row + [shares[j]], length) <= _worst_aspect(row, length):
            row.append(shares[j])
            j += 1
        thickness = sum(row) / length
        cursor = x0 if horizontal else y0
        for share in row:
            extent = share / thickness
            if horizontal:
                rects.append((cursor, y0, extent, thickness))
            else:
                rects.append((x0, cursor, thickness, extent))
            cursor += extent
        if horizontal:
            y0 += thickness
            h_rem -= thickness
        else:
            x0 += thickness
            w_rem -= thickness
        i = j
    return rects


class CategoricalLayout(LayoutPlugin):
    name = "categorical"

    def required_columns(self) -> list[Role]:
        return [Role.CATEGORICAL]

    def compute(
        self,
        meta: "pa.Table",
        roles: ColumnRoles | None,
        atlas: "ThumbnailCache",
        config: dict,
    ) -> LayoutResult:
        if roles is None or not roles.categorical:
            raise ValueError("categorical layout requires a categorical role")
        entry = roles.categorical[int(config.get("entry_index", 0))]

        ids = packed_ids(atlas)
        packed = set(ids)
        meta_ids = [int(v) for v in meta.column("id").to_pylist()]
        cat_raw = meta.column(entry.column).to_pylist()
        # Coerce every non-null value to ``str`` AT READ TIME (PR-180 review). The fresh-CSV
        # path is always VARCHAR (all_varchar=true), but the add-layouts roles-override path
        # can point the categorical role at a typed Parquet column (int/float/date/…) — the
        # worker gate is presence-only for categorical. Raw keys then (a) break
        # ``sorted(groups)`` on int+null mixes (str vs int compare) and (b) reach the label
        # annotation as non-string ``text``, failing the manifest's schema validation at the
        # END of an expensive bake (or json.dumps outright, for date/timestamp). str() keeps
        # the pre-2.5 ability to bake such columns AND gives them honest labels ("1950").
        # Build the packed id→category map AND find the first non-string value in ONE pass
        # (PR-180 review — an all-string column no longer takes a second full scan of the
        # column each bake). Detection spans the whole column, matching the column dtype it
        # stands in for, independent of the packed filter applied to the map.
        category_by_id: dict[int, str] = {}
        non_str: object = None
        for cid, val in zip(meta_ids, cat_raw):
            if non_str is None and val is not None and not isinstance(val, str):
                non_str = val
            if cid in packed:
                category_by_id[cid] = _MISSING_KEY if val is None else str(val)
        # The coercion SIGNAL (operator-blessed 2026-07-22: defaults + warnings, never
        # prohibition): when the column genuinely carries non-string values, say so ONCE,
        # naming the column and an example — a float column grouped by exact value is
        # usually a mis-declared role, but it is the user's call, so it bakes anyway.
        # Value-based detection (not Arrow-type-based) so e.g. dictionary-encoded string
        # columns never warn spuriously.
        if non_str is not None:
            logger.warning(
                "categorical layout %r: column %r is not string-typed (e.g. %r, %s); values "
                "are coerced to text for grouping and band labels. If exact-value bands are "
                "not what you want, point this role at a string column.",
                self.name,
                entry.column,
                non_str,
                type(non_str).__name__,
            )

        groups: dict[str, list[int]] = defaultdict(list)
        for cid in ids:
            # A packed id with no metadata row (never in category_by_id) is missing too.
            groups[category_by_id.get(cid, _MISSING_KEY)].append(cid)
        group_keys = sorted(groups)

        # Region areas proportional to member counts (recon. #8). Treemap
        # placement orders groups by (count desc, key) — deterministic; the
        # sorted-key tiebreak removes any dependence on insertion order.
        placement = sorted(group_keys, key=lambda k: (-len(groups[k]), k))
        regions = _proportional_regions([float(len(groups[k])) for k in placement])

        # id -> coordinates, reassembled into ids order at the end. Also capture, per
        # band, the LABEL annotation the renderer draws in the empty gap beside the band
        # (v2.5 / T2-69): the treemap region rect + the band's member count are computed
        # right here and were, until now, discarded. The label ``extent`` is the FULL
        # region rect [x0,y0,x1,y1] — the members fill only the inner ``_REGION_FILL``, so
        # the region's own margins carry no image and the renderer derives an image-free
        # gap-slot for the label from this extent (the ratified "never over the images"
        # placement rule).
        coords: dict[int, tuple[float, float, float, float]] = {}
        labels: list[dict] = []
        for key, (rx, ry, rw, rh) in zip(placement, regions):
            members = sorted(groups[key])
            m = len(members)
            label: dict = {
                "text": key,
                "extent": [
                    _clamp01_round(rx),
                    _clamp01_round(ry),
                    _clamp01_round(rx + rw),
                    _clamp01_round(ry + rh),
                ],
                "count": m,
            }
            if key == _MISSING_KEY:
                # The structurally-missing band (null/absent category) — flagged so the
                # renderer styles its label as a muted "no label". Omitted (not false) on
                # every real-valued band, mirroring the manifest's omit-when-default style.
                label["missing"] = True
            labels.append(label)
            # Aspect-aware sub-grid: pick columns so member cells stay near-square
            # inside a non-square region. (Label CAP applied after the loop — placement
            # itself always covers every band; only the annotation list is bounded.)
            s_cols = max(1, min(m, round(math.sqrt(m * rw / rh))))
            s_rows = math.ceil(m / s_cols)
            pad_w = rw * (1.0 - _REGION_FILL) / 2.0
            pad_h = rh * (1.0 - _REGION_FILL) / 2.0
            cell_w = rw * _REGION_FILL / s_cols
            cell_h = rh * _REGION_FILL / s_rows
            for j, cid in enumerate(members):
                s_col, s_row = j % s_cols, j // s_cols
                x = rx + pad_w + (s_col + 0.5) * cell_w
                y = ry + pad_h + (s_row + 0.5) * cell_h
                coords[cid] = (x, y, cell_w * 0.9, cell_h * 0.9)

        # Bound the emitted annotation list (see _MAX_LABELS). ``labels`` is in placement
        # order (count desc, key), so the head IS the top-N by member count; the
        # structurally-missing band is kept even past the cap (swapped for the smallest
        # kept band) — the "no label" bucket must never silently vanish.
        if len(labels) > _MAX_LABELS:
            total = len(labels)
            kept = labels[:_MAX_LABELS]
            overflow_missing = next((lab for lab in labels[_MAX_LABELS:] if lab.get("missing")), None)
            if overflow_missing is not None:
                kept[-1] = overflow_missing
            labels = kept
            logger.warning(
                "categorical layout %r: column %r has %d distinct values; emitting the top "
                "%d band labels by count (the renderer draws at most a few dozen per view "
                "anyway). Bands beyond the cap render unlabeled.",
                self.name,
                entry.column,
                total,
                len(labels),
            )

        xs = [coords[cid][0] for cid in ids]
        ys = [coords[cid][1] for cid in ids]
        ws = [coords[cid][2] for cid in ids]
        hs = [coords[cid][3] for cid in ids]

        return LayoutResult(
            layout_id=self.name,   # worker applies the multi-entry naming convention
            layout_type="categorical",
            label="By category",   # worker replaces with the role entry's label
            cells=build_spatial_cells(ids, xs, ys, ws, hs),
            bbox=spatial_bbox(xs, ys, ws, hs),
            edges=None,
            # v2.5 (T2-69 / T2-72 Seam 2): the per-band labels for the overlay substrate.
            # In placement order (count desc, key) so the renderer's most-prominent bands
            # lead; the renderer derives the display rank from area/count and greedy-culls
            # collisions per camera (the lean priority contract — no producer priority here).
            annotations={"labels": labels},
            # v2.6 (T2-140 / D-36 seam U1): the structurally-missing band's population —
            # the cells whose category column was null/absent. This family DOES give them a
            # home (a labelled band, not a strip), but the question the field answers is
            # "how many images could this layout not place FROM ITS COLUMN", and the answer
            # here is not zero. Reporting it keeps one number meaning one thing across
            # every family instead of making a reader walk `labels[].missing` for this one.
            missing_count=len(groups.get(_MISSING_KEY, ())),
        )
