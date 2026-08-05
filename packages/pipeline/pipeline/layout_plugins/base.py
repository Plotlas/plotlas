"""The ``LayoutPlugin`` ABC and the shared role/result types every layout uses.

Owns the contract only; contains no layout-specific logic (module-map).
"""
from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

import jsonschema
import pyarrow as pa

if TYPE_CHECKING:
    from pipeline.atlas import ThumbnailCache


def _schema_dir() -> Path:
    """Locate the read-only ``schemas/v2/`` contract directory (the in-force MAJOR
    contract — decision D-33; ``schemas/v1/`` and ``schemas/v1.1/`` stay frozen as
    the historical contracts, read by nothing at runtime once a dataset is re-baked
    to v2). column_roles is carried into v2 with an unchanged shape, so
    ``ColumnRoles.from_config`` validates against the v2 copy.

    Search order: the ``IMAGE_VIZ_SCHEMA_DIR`` override; then upward from this
    file (works in `make test-py`, where the package is imported from the mounted
    repo); then upward from the cwd (covers `make test-pipeline`, where the code
    is imported from the baked image `/app` but the repo is mounted at the cwd
    `/repo`). The production worker image bundles ``schemas/`` and sets
    ``IMAGE_VIZ_SCHEMA_DIR`` to ``/schemas/v2`` (see docker/Dockerfile.worker), so
    the override resolves them with no repo mounted; compose mounts the live
    ``schemas/`` over that copy for dev.
    """
    override = os.environ.get("IMAGE_VIZ_SCHEMA_DIR")
    if override:
        return Path(override)
    for start in (Path(__file__).resolve(), Path.cwd().resolve()):
        for parent in (start, *start.parents):
            candidate = parent / "schemas" / "v2"
            if candidate.is_dir():
                return candidate
    raise RuntimeError(
        "could not locate schemas/v2/ (searched from "
        f"{Path(__file__).resolve()} and cwd {Path.cwd()}); set IMAGE_VIZ_SCHEMA_DIR"
    )


@lru_cache(maxsize=None)
def _column_roles_schema() -> dict:
    text = (_schema_dir() / "column_roles.schema.json").read_text(encoding="utf-8")
    return json.loads(text)


class Role(str, Enum):
    FILENAME = "filename"   # join key to the image set (decision D-25); replaces INDEX
    DATETIME = "datetime"
    CATEGORICAL = "categorical"
    SCATTER = "scatter"     # pre-computed 2-D coordinate pairs (decision D-26)
    GEOGRAPHIC = "geographic"  # real-world lon/lat pairs, projected to the plane (D-35 G2)
    TAG = "tag"
    FREEFORM = "freeform"
    URL = "url"             # columns whose values are links (schema v2.8); display only
    EMBEDDING = "embedding"


@dataclass(frozen=True)
class RoleEntry:
    column: str
    label: str


@dataclass(frozen=True)
class DatetimeRoleEntry(RoleEntry):
    format: str   # "iso8601" | "unix_seconds" | "unix_millis"


@dataclass(frozen=True)
class ScatterRoleEntry:
    """One pre-computed coordinate pair driving one scatter layout (D-26).
    NOT a ``RoleEntry`` subclass — there is no single ``column``; the pair is
    atomic (an X without a Y is unrepresentable, mirroring the v1.1 schema).

    The four knobs (D-35 Seam G1, schema v2.3) are DECLARED, never sniffed from the
    values, and default to today's behavior byte-for-byte. BOTH producer entry points
    enforce their preconditions (ingest_metadata; run_add_layouts via the parquet
    re-validation) — see ingest.validate_scatter_config / _validate_scatter_values:
      * ``x_scale`` / ``y_scale``: ``"linear"`` (default) | ``"log"`` — the per-axis
        scale applied before the fit (``"log"`` requires strictly-positive values;
        both axes must currently share ONE scale — mixed log/linear is rejected
        because the shared-scale fit would crush the logged axis, T2-128).
      * ``normalize``: ``"fit"`` (default, the aspect-fit) | ``"none"`` (T2-34
        pass-through — the author's ``[0,1]²`` coords preserved exactly up to one
        uniform ×0.95 scale into the placed band; requires values already in
        ``[0,1]``).
      * ``overlap``: ``"overdraw"`` (default) | ``"jitter"`` | ``"aggregate"`` — only
        ``"overdraw"`` is implemented (the others fail-fast at both entry points —
        D-35 G4)."""
    x_column: str
    y_column: str
    label: str
    x_scale: str = "linear"
    y_scale: str = "linear"
    normalize: str = "fit"
    overlap: str = "overdraw"


@dataclass(frozen=True)
class GeographicRoleEntry:
    """One real-world lon/lat coordinate pair driving one geographic layout (D-35 Seam
    G2 / T2-35). A FIRST-CLASS family DISTINCT from scatter (operator 2026-07-19): the
    columns MEAN longitude/latitude, so the plugin projects them (equirectangular or Web
    Mercator) before the shared scatter fit. Like ``ScatterRoleEntry`` this is NOT a
    ``RoleEntry`` subclass — the pair is atomic (a lon without a lat is unrepresentable).

    ``projection`` (``"equirectangular"`` default | ``"mercator"``) is the ONLY new
    pipeline step; there are NO scale knobs (degrees are degrees — D-35). ``overlap``
    (``"overdraw"`` default | ``"jitter"`` | ``"aggregate"``) mirrors the scatter field —
    only ``"overdraw"`` is implemented (the others fail-fast at ingest — D-35 G4).
    Value-level preconditions (lon in [-180,180], lat in [-90,90], and under mercator
    |lat| <= 85.051129) are enforced at ingest (D-11 fail-fast)."""
    lon_column: str
    lat_column: str
    label: str
    projection: str = "equirectangular"
    overlap: str = "overdraw"


@dataclass(frozen=True)
class TagRoleEntry(RoleEntry):
    delimiter: str


@dataclass(frozen=True)
class EmbeddingRoleEntry(RoleEntry):
    dim: int


@dataclass(frozen=True)
class ColumnRoles:
    """Validated, in-memory form of column_roles.schema.json (schemas/v1.1/).
    Built only when a metadata source is present; callers hold
    ``ColumnRoles | None`` and pass None for images-only datasets (decision D-25)."""
    filename: RoleEntry              # the join key to the image set (replaces index)
    datetime: DatetimeRoleEntry | None
    categorical: list[RoleEntry]
    tag: list[TagRoleEntry]
    freeform: list[RoleEntry]
    embedding: EmbeddingRoleEntry | None
    scatter: list[ScatterRoleEntry] = field(default_factory=list)  # D-26; default []
    geographic: list[GeographicRoleEntry] = field(default_factory=list)  # D-35 G2; default []
    # Columns whose values ARE links (schema v2.8). Just NAMES — the value is the URL,
    # and the panel already heads each field with the column name, so there is no label
    # to carry. Display only: drives no layout, no filter, no search. Declared LAST so
    # the positional order of the existing defaulted fields is untouched.
    url: list[str] = field(default_factory=list)

    @classmethod
    def from_config(cls, config: dict) -> "ColumnRoles":
        """Parse + validate a dict against column_roles.schema.json (now requires a
        ``filename`` role — the join key). Callers skip this entirely (and use None)
        when there is no metadata source.

        Raises ``jsonschema.ValidationError`` if ``config`` does not conform.
        ``ingest_metadata`` wraps that into ``ColumnRoleError`` so the pipeline
        surfaces a single role-error type (ingest.py owns value-level validation;
        this owns shape validation).
        """
        jsonschema.Draft202012Validator(_column_roles_schema()).validate(config)

        def _entry(spec: dict) -> RoleEntry:
            return RoleEntry(column=spec["column"], label=spec["label"])

        datetime_spec = config.get("datetime")
        datetime_role = (
            DatetimeRoleEntry(
                column=datetime_spec["column"],
                label=datetime_spec["label"],
                format=datetime_spec["format"],
            )
            if datetime_spec
            else None
        )

        embedding_spec = config.get("embedding")
        embedding_role = (
            EmbeddingRoleEntry(
                column=embedding_spec["column"],
                label=embedding_spec["label"],
                dim=embedding_spec["dim"],
            )
            if embedding_spec
            else None
        )

        return cls(
            filename=_entry(config["filename"]),
            datetime=datetime_role,
            categorical=[_entry(e) for e in config.get("categorical", [])],
            tag=[
                TagRoleEntry(column=e["column"], label=e["label"], delimiter=e["delimiter"])
                for e in config.get("tag", [])
            ],
            freeform=[_entry(e) for e in config.get("freeform", [])],
            url=list(config.get("url", [])),  # schema v2.8: bare column names
            embedding=embedding_role,
            scatter=[
                ScatterRoleEntry(
                    x_column=e["x_column"],
                    y_column=e["y_column"],
                    label=e["label"],
                    # D-35 Seam G1 knobs (schema v2.3): all optional, defaulting to
                    # today's behavior. The schema validates the enum membership;
                    # value-level checks (log => positive, none => in [0,1]) run at
                    # ingest (D-11 fail-fast).
                    x_scale=e.get("x_scale", "linear"),
                    y_scale=e.get("y_scale", "linear"),
                    normalize=e.get("normalize", "fit"),
                    overlap=e.get("overlap", "overdraw"),
                )
                for e in config.get("scatter", [])
            ],
            geographic=[
                GeographicRoleEntry(
                    lon_column=e["lon_column"],
                    lat_column=e["lat_column"],
                    label=e["label"],
                    # D-35 Seam G2 (schema v2.4): optional projection (default
                    # equirectangular) + overlap (default overdraw). The schema validates
                    # enum membership; value-level checks (lon/lat range; mercator |lat| <=
                    # 85.051129; unimplemented overlap) run at ingest (D-11 fail-fast).
                    projection=e.get("projection", "equirectangular"),
                    overlap=e.get("overlap", "overdraw"),
                )
                for e in config.get("geographic", [])
            ],
        )


@dataclass(frozen=True)
class Edge:
    src: int
    dst: int
    weight: float


@dataclass(frozen=True)
class LayoutResult:
    layout_id: str
    layout_type: str                 # "grid" | "datetime" | "categorical" | ...
    label: str
    cells: pa.Table                  # id + the spatial fields (x, y, w, h) + reserved
                                     # nulls (SPATIAL_SCHEMA). v2: worker.run_ingest
                                     # hands this + the layout bbox to the per-layout
                                     # spatial pyramid baker (tiler.bake_pyramid), which
                                     # packs the cell thumbnails into per-tile mini-atlas
                                     # FINE tiles + mosaic COARSE tiles and emits the
                                     # u,v,uw,uh sub-rect per cell (no shared atlas page).
    bbox: tuple[float, float, float, float]   # x_min, y_min, x_max, y_max in [0,1]
    edges: list[Edge] | None         # only for network layouts (None in Phase 1)
    options: dict | None = None      # D-35 Seam G1 (schema v2.3): echo of the
                                     # layout-shaping options APPLIED at bake time
                                     # (scatter: x_scale/y_scale/normalize/overlap).
                                     # None (the default for every layout, and for a
                                     # scatter layout baked with all-default knobs) =>
                                     # manifest.py omits the `options` object, so a
                                     # default bake is byte-for-byte today's output.
    annotations: dict | None = None  # v2.5 (T2-69 / T2-72 Seam 2): OVERLAY annotations
                                     # the renderer draws in the DOM substrate — the
                                     # categorical treemap's per-band {text, extent,
                                     # count, missing?} labels, and the datetime layout's
                                     # {orientation, scale, domain, range, label} x-axis.
                                     # Each family emits only its own key ({"labels": [...]}
                                     # for categorical, {"axes": [...]} for datetime); grid/
                                     # scatter/geographic leave it None. None => manifest.py
                                     # omits the `annotations` object, so a layout with no
                                     # annotations is byte-for-byte its pre-2.5 form.
    missing_count: int = 0           # v2.6 (T2-140 / D-36 seam U1): how many cells this
                                     # layout could NOT place from the column it arranges
                                     # by — datetime's undated/unparseable images,
                                     # scatter/geographic's null-or-non-finite coordinates,
                                     # categorical's structurally-missing band. They are
                                     # still drawn; this is the number the viewer needs to
                                     # explain WHERE (see the schema — the count does not
                                     # promise a location). ALWAYS emitted by manifest.py,
                                     # INCLUDING 0 — same rule as `pyramid.dropped_total`.
                                     # 0 means "this producer counted and found none"; the
                                     # key is absent ONLY on a pre-2.6 entry, which is what
                                     # makes the presence gate actually decide something.
                                     # EVERY family must set it: 0 is a claim, not a
                                     # default-shaped silence, so a new plugin that leaves
                                     # it unset is asserting it places everything.
                                     # Deliberately on the LayoutResult, not on
                                     # `annotations`: a datetime layout that DECLINES its
                                     # axis still strips its undated cells, and
                                     # scatter/geographic emit no annotations at all.


class LayoutPlugin(ABC):
    name: str   # "grid" | "datetime" | "categorical" | "umap" | "network" | "custom"

    @abstractmethod
    def required_columns(self) -> list[Role]:
        """Roles that must be present for this layout to compute."""
        ...

    @abstractmethod
    def compute(
        self,
        meta: pa.Table,
        roles: ColumnRoles | None,
        atlas: "ThumbnailCache",
        config: dict,
    ) -> LayoutResult:
        """
        Pure function: metadata + roles + the renderable-cell set + config ->
        LayoutResult. Produces explicit normalized [0,1]^2 coordinates per cell —
        never implicit grid indices. Must not read images or write files.

        ``atlas`` is the v2 ``ThumbnailCache`` (the decoded-once per-cell thumbnail
        cache). Layouts use it only via ``packed_ids(atlas)`` to get the renderable
        cell ids (the non-skipped images); the parameter name is kept ``atlas`` so
        the layout plugins did not change signature across the v2 rework. The ids
        are DENSE [0, image_count) — the worker remaps decode-failed gaps away
        before computing layouts (the v2 contiguous-dense cell_record contract).

        `roles` is None for images-only datasets (decision D-25); grid ignores it
        (it orders cells by id == sorted filename), while datetime/categorical read
        their declared enrichment column from `meta` (joined by filename). A layout
        whose required_columns() are unmet is skipped by the worker, so grid (which
        requires none) is always available — the guaranteed floor.

        Emits the spatial fields only (id, x, y, w, h, reserved nulls — see
        build_spatial_cells). worker.run_ingest hands the result + bbox to the
        per-layout spatial pyramid baker (tiler.bake_pyramid).
        """
        ...


# --- shared layout plumbing -------------------------------------------------
# Generic assembly used by every concrete layout — NOT layout-specific algorithm
# logic (which lives in each layout module). Owns the LOD-independent subset of
# cell_record.schema.json that a layout determines.

SPATIAL_SCHEMA = pa.schema(
    [
        ("id", pa.int64()),
        ("x", pa.float32()),
        ("y", pa.float32()),
        ("w", pa.float32()),
        ("h", pa.float32()),
        ("color", pa.int32()),          # reserved, nullable (all-null in v1)
        ("cluster_id", pa.int32()),     # reserved, nullable
        ("edge_count", pa.int32()),     # reserved, nullable
        ("embedding_dim", pa.int32()),  # reserved, nullable
    ]
)


def _clamp01(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else float(value)


def packed_ids(atlas: "ThumbnailCache") -> list[int]:
    """The renderable cell ids (images that decoded to a thumbnail), ascending. A
    layout positions exactly these. v2: reads ``ThumbnailCache.ids`` (the v1
    AtlasResult-by-LOD is gone)."""
    return sorted(atlas.ids)


def build_spatial_cells(
    ids: list[int],
    xs: list[float],
    ys: list[float],
    ws: list[float],
    hs: list[float],
) -> pa.Table:
    """Assemble the LOD-independent spatial cell table (SPATIAL_SCHEMA). Centers
    and extents are clamped into [0,1]; reserved columns are all-null."""
    n = len(ids)
    arrays = [
        pa.array([int(i) for i in ids], pa.int64()),
        pa.array([_clamp01(v) for v in xs], pa.float32()),
        pa.array([_clamp01(v) for v in ys], pa.float32()),
        pa.array([_clamp01(v) for v in ws], pa.float32()),
        pa.array([_clamp01(v) for v in hs], pa.float32()),
        pa.array([None] * n, pa.int32()),
        pa.array([None] * n, pa.int32()),
        pa.array([None] * n, pa.int32()),
        pa.array([None] * n, pa.int32()),
    ]
    return pa.Table.from_arrays(arrays, schema=SPATIAL_SCHEMA)


def spatial_bbox(
    xs: list[float],
    ys: list[float],
    ws: list[float],
    hs: list[float],
) -> tuple[float, float, float, float]:
    """World-space bbox [x_min, y_min, x_max, y_max] of all cell footprints
    (center ± extent/2), clamped to [0,1]^2."""
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (
        _clamp01(min(x - w / 2 for x, w in zip(xs, ws))),
        _clamp01(min(y - h / 2 for y, h in zip(ys, hs))),
        _clamp01(max(x + w / 2 for x, w in zip(xs, ws))),
        _clamp01(max(y + h / 2 for y, h in zip(ys, hs))),
    )
