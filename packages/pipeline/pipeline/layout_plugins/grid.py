"""Grid layout: arranges cells on a regular grid in normalized [0,1]^2."""
from __future__ import annotations

import math
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


class GridLayout(LayoutPlugin):
    name = "grid"

    def required_columns(self) -> list[Role]:
        return []  # the images-only floor: orders by id == sorted filename (D-25)

    def compute(
        self,
        meta: "pa.Table",
        roles: ColumnRoles | None,
        atlas: "ThumbnailCache",
        config: dict,
    ) -> LayoutResult:
        # Ordering is parameterizable (decision D-25): the default is id order
        # (= sorted filename), and a future additive `sorted`-by-column *view*
        # reuses this compute() by supplying a different order — no alternate is
        # built now. `roles`/`meta` are unused for the default grid (works with
        # roles=None — the images-only floor).
        ordered_ids = self._ordered_ids(packed_ids(atlas), meta, config)
        n = len(ordered_ids)
        cols = max(1, math.ceil(math.sqrt(n)))
        rows = max(1, math.ceil(n / cols))
        fill = float(config.get("fill", 0.9))  # leave a small gap between cells
        col_w, row_h = 1.0 / cols, 1.0 / rows
        w, h = col_w * fill, row_h * fill

        xs, ys = [], []
        for i in range(n):
            col, row = i % cols, i // cols
            xs.append((col + 0.5) * col_w)
            ys.append((row + 0.5) * row_h)
        ws, hs = [w] * n, [h] * n

        return LayoutResult(
            layout_id=self.name,
            layout_type="grid",
            label="Grid",
            cells=build_spatial_cells(ordered_ids, xs, ys, ws, hs),
            bbox=spatial_bbox(xs, ys, ws, hs),
            edges=None,
            # v2.9 provenance: EMPTY, and stated rather than defaulted. Grid places cells by
            # id (== sorted filename) and reads no metadata column at all — that is the whole
            # reason it is the images-only floor and the reason D-viii can make it optional.
            # So "depends on nothing" is grid's real, first-class answer, and a metadata
            # change never stales it. Written out explicitly because the field's default is
            # also `()`, and a silent default and a considered claim must not be the same
            # keystroke.
            source_columns=(),
            # v2.10: the same claim, one level down. Grid has no role ENTRY at all, so
            # there is no way-of-reading to record; `{}` is its honest value and it makes
            # grid CHECKABLE and never stale, rather than unchecked forever.
            source_fingerprint={},
        )

    def _ordered_ids(self, ids: list[int], meta: "pa.Table", config: dict) -> list[int]:
        """Reading order of the cells. Default: id order (= sorted filename, the
        guaranteed floor). The hook (`config['order']`, a permutation of ids) keeps
        a future `sorted`-by-column view able to reuse this layout; unused now."""
        order = config.get("order")
        return list(order) if order else ids
