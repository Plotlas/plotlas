"""The presentation record — ``presentation.json``, beside ``layout_manifest.json``.

The SECOND record in a dataset directory (decision D-xv, ``docs/design/INTAKE_REDESIGN.md``
§6c), and the API's alone to write. The two files have **one writer each**: the worker
writes ``layout_manifest.json`` — the reproducible bake record, what the bake produced and
the inputs it consumed — and the API writes ``presentation.json`` — the choices a human made
about how the dataset is SHOWN. Nothing here ever writes a manifest, so **D-15 stands
unamended**: a bake cannot clobber a display name and this module cannot clobber a bake, by
construction rather than by locking.

Three stores, three modules, and this is the third:

* ``db.py`` — read-only DuckDB/Parquet + the dataset-tree read helpers;
* ``appstate.py`` — the mutable app-state store (users, ``owner``, ``visibility``), whose
  own rule is that it persists nothing into the dataset tree;
* ``presentation.py`` (here) — the sole reader/writer of the one dataset-tree file the API
  owns. It lives beside them rather than inside either because the routers may not import
  one another and both ``routers/datasets.py`` and ``routers/search.py`` need it.

**Everything fails soft (D-xvi).** The record is keyed by identifiers the BAKE record owns
(``layout_id``, the raw column name), and the two files change independently: a
``default_layout`` naming a layout a re-bake dropped, a ``title_column`` naming a column a
metadata update removed, a ``columns`` entry for a column that no longer exists — each falls
back to the default and is **never an error and never a 500**. An absent file means exactly
today's behaviour: absent file = absent everything. A file that is corrupt, unreadable or
not a JSON object is treated as absent for READS and as untouchable for WRITES (it is never
overwritten by the migration — a hand-edit that went wrong is recoverable only while the
bytes survive).

**Validate on write, fall back on read.** ``jsonschema`` is deliberately not an API
dependency (``db.py`` says the same about the manifest), and the lean api image ships only
``packages/api`` — no ``schemas/`` directory — so nothing here can consult
``presentation.schema.json`` at runtime. The write path enforces the schema's rules in code
(``_FIELDS`` below); ``tests/test_presentation_schema_parity.py`` pins those rules against
the schema file so the two cannot drift silently.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any

from api import appstate

logger = logging.getLogger(__name__)

PRESENTATION_FILENAME = "presentation.json"

# The version of `schemas/v2/presentation.schema.json` this module writes. Its OWN version,
# not the manifest's: the two files have different writers and change for different reasons.
# A writer always emits it, so an absent version means "authored by something that was not
# this contract's writer" and is read as 1.x rather than as a positive claim.
PRESENTATION_VERSION = "1.0"

# `MAJOR.MINOR`, the shape `presentation.schema.json` `presentation_version` declares.
# Parsed rather than compared as a string so `1.10` sorts ABOVE `1.9` (it does not
# lexically), which is the whole point of reading it — see `_stamped_version`.
_VERSION_RE = re.compile(r"^(\d+)\.(\d+)$")
_OUR_VERSION = (
    int(PRESENTATION_VERSION.split(".")[0]),
    int(PRESENTATION_VERSION.split(".")[1]),
)

# The SHAPE of a layout identifier, transcribed from `layout_manifest.schema.json`
# `layoutEntry.layout_id` (and from `presentation.schema.json` `layoutIdKey`, which
# transcribes the same thing) so the file this module writes agrees with the file it is
# keyed by. It constrains the shape ONLY: whether the id RESOLVES to a baked layout is
# deliberately not checked here and must not be (D-xvi) — that lives in the other file.
_LAYOUT_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_LAYOUT_ID_MAX = 128

# The one shipped `render` kind. An ENUM rather than a boolean specifically so `email` and
# `image` slot in later without a second mechanism (D-xvii); ABSENT means plain text, and
# there is deliberately no explicit "text" member — two ways to say the same thing is the
# trap the enum exists to avoid.
_RENDER_KINDS = ("url",)

# The dataset-level scalars whose value lives in app-state TODAY for every deployment that
# predates this seam, and in this file afterwards. Ordered as they are written.
_MIGRATED_SCALARS = ("display_name", "attribution", "attribution_url")


class PresentationError(appstate.PresentationValueError):
    """A rejected presentation write — a bad value, an unknown key, or a tree that cannot
    be written. Subclasses app-state's ``PresentationValueError`` so the routers' existing
    422 mapping catches both without a second ``except`` clause; ``io_error`` marks the
    cases that are a property of the SERVER (a read-only mount) rather than of the request,
    which the router answers 409 instead."""

    def __init__(self, message: str, *, io_error: bool = False) -> None:
        super().__init__(message)
        self.io_error = io_error


# ---------------------------------------------------------------------------
# Read.
# ---------------------------------------------------------------------------


def _read(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    """``(record, problem)`` for one presentation file.

    ``(None, None)`` means there is no file — the overwhelmingly common case and a
    complete answer, not an error. ``(None, reason)`` means a file is THERE but unusable
    (unreadable, not JSON, not a JSON object). Callers that only read treat both as
    absent; the migration must tell them apart, because it may create the first and must
    never overwrite the second."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, None
    except OSError as exc:  # permissions, a directory in its place, an I/O error
        return None, f"cannot read ({type(exc).__name__}: {exc})"
    try:
        parsed = json.loads(text)
    except ValueError as exc:  # json.JSONDecodeError is a ValueError
        return None, f"not valid JSON ({exc})"
    if not isinstance(parsed, dict):
        return None, f"not a JSON object (got {type(parsed).__name__})"
    return parsed, None


# The parsed-record cache. An explicit bounded OrderedDict rather than `@lru_cache` for
# one reason: THIS CACHE MUST BE INVALIDATED BY KEY, and `lru_cache` can only be cleared
# wholesale. See `load` for why a stat key alone is not enough here, and `_invalidate`
# for what closes it. Bounded like `db._MANIFEST_CACHE_MAX` and for the same reason — a
# long-lived uvicorn worker serves many datasets and the entries are small. Binding costs
# one re-parse and nothing else, so it is silent on purpose (AGENT_GUIDE Limits: "a
# bounded cache binds and costs a re-parse; silence is correct").
_PRESENTATION_CACHE_MAX = 256
_record_cache: "OrderedDict[tuple[str, int, int, int], tuple[dict[str, Any] | None, str | None]]" = (
    OrderedDict()
)


def _invalidate(path: Path) -> None:
    """Drop every cached parse of ``path``. Called by the two functions that CHANGE the
    file, which is what makes the cache exact for the process doing the changing.

    The stat key below cannot carry this on its own, and that is measured, not assumed.
    Five successive atomic writes of a SAME-LENGTH record, `mkstemp` + `os.replace` exactly
    as `write()` does it, on three filesystems (2026-09-09):

    | filesystem | distinct `(mtime_ns, size, ino)` | distinct `mtime_ns` | distinct inodes |
    |---|---|---|---|
    | overlayfs (the test image) | **3 of 5** | **2** | 2 |
    | tmpfs | 5 of 5 | **1** | 5 |
    | Windows bind mount | 5 of 5 | 5 | 5 |

    `st_mtime_ns` is the term that fails: it advanced twice in five writes on overlayfs and
    **not at all** on tmpfs. What rescues tmpfs is the inode, which `mkstemp` varies; what
    rescues overlayfs partially is the same thing, and there it alternated between two, so
    write 3 collided with write 1. Neither term is dependable alone, the mix that saves you
    differs per filesystem, and a PATCH followed by the read that renders its own response
    is exactly this pattern — not a narrow window, the common case.

    **`db.load_manifest` keys on `(path, mtime_ns, size)` with NO inode**, so on the tmpfs
    row above it would serve one cached value for all five writes. It survives because a
    manifest is rewritten minutes apart at a different size, not because the key is exact
    ([[T2-the-manifest-cache-key-is-not-exact-and-is-one]])."""
    prefix = str(path)
    for key in [k for k in _record_cache if k[0] == prefix]:
        del _record_cache[key]


def load(ds_dir: Path) -> dict[str, Any]:
    """The dataset's presentation record as stored, or ``{}`` when there is none.

    Never raises: an absent file is the normal case, and a corrupt one must degrade to
    today's behaviour rather than 500 a read. A corrupt file IS logged — it means an edit
    silently stopped taking effect, which is invisible from the outside otherwise.

    PERF: the parse is cached, for the reason ``db.load_manifest`` states about the
    manifest ("without the cache each range read re-opened and re-parsed this file"). This
    file is read on two paths that repeat: ``search`` resolves the url columns on EVERY
    request — one per tier-0 debounced keystroke, per user — and the listing reads one per
    dataset per ``GET /api/datasets``. Measured 2026-09-09 in the iv-test image, median of
    200 calls: 33.7 us uncached on an empty record and 17.7 ms on a 10,000-entry one,
    against ~1.6 us cached (the stat) either way.

    COHERENCY, which is the part that is not like the manifest. The key is
    ``(path, mtime_ns, size, ino)`` — the manifest's key plus the inode, because both
    writers replace atomically and an inode is a sharper discriminator than a timestamp —
    but on the measured filesystem it is still NOT exact (see ``_invalidate``: 2 distinct
    keys from 5 writes). So the stat key is the backstop, and ``write``/``discard``
    evicting by path is the primary mechanism. That makes the cache exact for every write
    this process makes, which is every route: uvicorn runs single-worker in all three
    compose profiles (no ``--workers`` flag in ``docker/Dockerfile.api``,
    ``docker-compose.yml`` or ``docker-compose.prod.yml``), so the API is one process.

    The residual, stated rather than hidden: a write by ANOTHER process — only
    ``api.admin``, the operator CLI — cannot evict this process's entry, so a stale record
    can be served until the file's stat key changes. That is bounded by one filesystem
    timestamp tick after the API's last read of that file, and the CLI is a
    human-initiated one-shot rather than something that fires inside a tick of a read. It
    is the same residual ``db.load_manifest`` already carries for the manifest.

    The cached record is SHARED, not copied: every caller here treats it read-only
    (``effective``/``effective_dataset``/``effective_columns`` build fresh dicts and never
    mutate their input, verified across all six call sites), and the WRITE path does not
    come through here at all — ``update`` and ``migrate`` call ``_read`` directly, so a
    read-modify-write can never merge onto a cache entry at all."""
    path = ds_dir / PRESENTATION_FILENAME
    try:
        st = path.stat()
    except FileNotFoundError:
        return {}  # no file: the overwhelmingly common case, and a complete answer
    except OSError as exc:
        # Anything else that cannot even be stat'ed — a permissions failure, a
        # non-directory in the path — is a file that is THERE but unusable, which
        # `_read` would have reported as a problem. Keep it loud for the same reason.
        logger.warning("Ignoring %s: cannot stat (%s: %s)", path, type(exc).__name__, exc)
        return {}

    key = (str(path), st.st_mtime_ns, st.st_size, st.st_ino)
    hit = _record_cache.get(key)
    if hit is None:
        hit = _read(path)
        _record_cache[key] = hit
        while len(_record_cache) > _PRESENTATION_CACHE_MAX:
            _record_cache.popitem(last=False)  # evict least-recently-used
    else:
        _record_cache.move_to_end(key)  # LRU touch
    record, problem = hit
    if problem is not None:
        logger.warning("Ignoring %s: %s", path, problem)
    return record if record is not None else {}


def _clean_str(value: Any) -> str | None:
    """A non-empty string, or None for anything else. The read-side guard against a
    hand-edited file: a wrong type must be ignored, never propagated into a response."""
    return value if isinstance(value, str) and value != "" else None


def _clean_columns(raw: Any) -> dict[str, dict[str, Any]]:
    """The ``columns`` map with every malformed entry dropped. Keys are raw column names
    (any non-empty string — a CSV header may contain anything); each value keeps only the
    keys this contract defines, and only when their type is right."""
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    for name, entry in raw.items():
        if not isinstance(name, str) or name == "" or not isinstance(entry, dict):
            continue
        cleaned: dict[str, Any] = {}
        label = _clean_str(entry.get("label"))
        if label is not None:
            cleaned["label"] = label
        render = _clean_str(entry.get("render"))
        if render in _RENDER_KINDS:
            cleaned["render"] = render
        if isinstance(entry.get("hidden"), bool):
            cleaned["hidden"] = entry["hidden"]
        # KEEP an entry that cleans to empty. Presence is the signal, not content: the
        # record's `columns` map is what `effective` consults to decide whether the
        # manifest's legacy `url` role still applies, and what the pipeline's
        # `drop_retired_roles` reads as ownership. Dropping `{}` here undid the tombstone
        # `apply_updates` writes when an owner clears a column's only setting, so the
        # cleared link came back on the very next read (review of PR #346, finding 1 —
        # this is the third place the "empty means gone" assumption lived).
        #
        # An entry whose keys are all UNUSABLE (`{"render": "bogus"}`) also lands here as
        # `{}`, and keeping it is right: the owner described the column, the value failed,
        # and D-xvi says fail soft — "described, nothing special" loses nothing, while
        # treating it as absent would silently restore a link they were editing away. A
        # non-dict entry is still dropped by the guard above; that is not an entry.
        out[name] = cleaned
    return out


def _clean_layouts(raw: Any) -> dict[str, dict[str, Any]]:
    """The ``layouts`` map with every malformed entry dropped. Keys are ``layout_id``s;
    an entry naming a layout the manifest does not carry is KEPT here and ignored by the
    consumer (D-xvi) — a re-bake may drop a layout and bring it back, and silently
    discarding the override on the way through would lose the user's choice for good."""
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    for layout_id, entry in raw.items():
        if not isinstance(layout_id, str) or not isinstance(entry, dict):
            continue
        label = _clean_str(entry.get("label"))
        if label is not None:
            out[layout_id] = {"label": label}
    return out


def legacy_url_columns(roles: dict[str, Any] | None) -> list[str]:
    """The pre-2.9 ``column_roles.url`` names carried by a committed manifest.

    Schema v2.9 removed the role (D-xvii): "this column's value is a link" is presentation
    — the bake only ever VALIDATED it, nothing was computed from it and no cell moved — so
    it lives in ``presentation.json`` as ``columns.<name>.render: "url"``. But four of the
    six real dataset trees carry the key today (measured 2026-09-07: ``rijks_pilot`` 2.7,
    ``smithsonian_art_200k`` / ``smithsonian_10k`` / ``google_landmarks_10k`` 2.8), and
    ``db.load_manifest`` returns the manifest VERBATIM and never re-validates it — so the
    key is still there to read, and reading it is what keeps the live demo's links working
    before anyone runs the migration.

    Robust to a hand-patched manifest — only string entries count — so a bad shape can
    neither crash a read (an unhashable dict entry) nor silently mis-classify (a bare
    string treated as a sequence of characters)."""
    if not isinstance(roles, dict):
        return []
    return [c for c in (roles.get("url") or []) if isinstance(c, str) and c != ""]


def effective_dataset(
    record: dict[str, Any], *, fallback: appstate.DatasetRecord | None = None
) -> dict[str, Any]:
    """The resolved ``dataset`` BLOCK alone — the dataset-level scalars, with the
    app-state fallback applied.

    ``display_name``/``attribution``/``attribution_url`` live in ``appstate.db`` for every
    deployment that predates this seam. The file's ``dataset`` block, when present, is the
    complete answer for all three; when the block is absent, the app-state row supplies
    them. The block — not the individual key — is the switch, because a per-key fallback
    would make CLEARING impossible: the file cannot represent "cleared" (the schema has no
    null, and blank means removed), so a cleared name would fall through and the app-state
    value would come back from the dead. Any write that touches the block seeds it from
    this fallback first, so taking ownership never loses a value (see ``apply_updates``).

    Split out of ``effective`` because THREE call sites want only this and paid for the
    whole record to get it: the listing's ``_summary_presentation`` (once per ready
    dataset AND once per pending one), the PATCH echo, and nothing else. They were running
    ``_clean_columns`` over every entry, ``_clean_layouts``, and ``legacy_url_columns``
    against the manifest, then discarding all of it — and with a client-written
    ``columns`` map that discarded work is proportional to what the client sent (review of
    PR #346, findings 15 and 8). Measured 2026-09-09, median of 200 calls on a 10,000-entry
    record: 30.1 ms through ``effective`` against 1.6 us through this. Returns a fresh
    dict; the input is never mutated."""
    dataset: dict[str, Any] = {}
    raw_dataset = record.get("dataset")
    if isinstance(raw_dataset, dict):
        for key in (*_MIGRATED_SCALARS, "default_layout", "title_column"):
            value = _clean_str(raw_dataset.get(key))
            if value is not None:
                dataset[key] = value
    elif fallback is not None:
        for key in _MIGRATED_SCALARS:
            value = getattr(fallback, key, None)
            if value is not None:
                dataset[key] = value
    return dataset


def effective_columns(
    record: dict[str, Any], *, roles: dict[str, Any] | None = None
) -> dict[str, dict[str, Any]]:
    """The resolved ``columns`` MAP alone — the stored entries, plus the legacy
    ``column_roles.url`` fallback.

    A committed manifest's ``url`` role appears here as ``columns.<name>.render: "url"``
    for any column the file does not already describe. Read-side only: the file on disk is
    untouched, which is exactly D-xvi's "validate on write, fall back on read". It is what
    makes the four live trees behave identically before and after
    ``api.admin migrate-presentation``.

    Split out of ``effective`` for the mirror of ``effective_dataset``'s reason: ``search``
    resolves the url columns on EVERY request and wants nothing but this map, so it was
    paying for ``_clean_layouts`` and the dataset block per keystroke. Returns a fresh
    dict; the input is never mutated."""
    columns = _clean_columns(record.get("columns"))
    for name in legacy_url_columns(roles):
        if name not in columns:
            columns[name] = {"render": "url"}
    return columns


def effective(
    record: dict[str, Any],
    *,
    roles: dict[str, Any] | None = None,
    fallback: appstate.DatasetRecord | None = None,
) -> dict[str, Any]:
    """The WHOLE presentation a consumer should act on: the stored record, plus the two
    fallbacks that exist only while the migration is incomplete (see ``effective_dataset``
    and ``effective_columns``, which own one rule each so there is no second copy of
    either).

    This full form is what ``GET /api/datasets/{id}/presentation`` serves — the one caller
    that genuinely needs all four keys. Returns a fresh dict; the input is never mutated."""
    return {
        "presentation_version": _clean_str(record.get("presentation_version"))
        or PRESENTATION_VERSION,
        "dataset": effective_dataset(record, fallback=fallback),
        "layouts": _clean_layouts(record.get("layouts")),
        "columns": effective_columns(record, roles=roles),
    }


def url_columns(columns: dict[str, dict[str, Any]]) -> set[str]:
    """The columns whose values are LINK TARGETS, from a resolved ``columns`` map.

    The one definition of "which columns are links". Takes the MAP rather than the whole
    effective record so the search route can reach it through ``effective_columns``
    without building the three keys it then throws away; ``effective(...)["columns"]``
    is the same value for a caller that already has the full record.

    Search excludes these columns: link targets are not human search text, their values
    are short (so they would classify title-like, i.e. tier-0), and their ``https`` prefix
    matches nearly every row."""
    return {name for name, entry in columns.items() if entry.get("render") == "url"}


# ---------------------------------------------------------------------------
# Write. The API is the file's ONLY writer (D-xv).
# ---------------------------------------------------------------------------


def _normalize_scalar(value: Any, *, field: str) -> str | None:
    """One dataset-level scalar, trimmed and length-checked through app-state's rules.

    ``appstate.PRESENTATION_LIMITS`` is the ONE authoritative home of the three caps
    (``DISPLAY_NAME_MAX``/``ATTRIBUTION_MAX``/``ATTRIBUTION_URL_MAX``); this module defers
    to it rather than re-declaring them, and the schema's ``maxLength``s — which say in
    their own descriptions that they TRANSCRIBE those constants — are pinned equal to it
    by ``tests/test_presentation_schema_parity.py``. Blank is CLEARED (None), which is
    what makes a bad name recoverable."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise PresentationError(f"{field} must be a string or null")
    return appstate.normalize_presentation_text(
        value, field=field, limit=appstate.PRESENTATION_LIMITS[field]
    )


def _normalize_layout_id(value: Any, *, field: str) -> str | None:
    """A ``layout_id``-shaped string, or None to clear. Shape only — whether the id names
    a layout the manifest carries is NOT checked and must not be (D-xvi): the manifest
    changes independently, so a dangling ``default_layout`` falls back to the first layout
    on READ instead of being refused on write."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise PresentationError(f"{field} must be a string or null")
    trimmed = value.strip()
    if trimmed == "":
        return None
    if len(trimmed) > _LAYOUT_ID_MAX or not _LAYOUT_ID_RE.match(trimmed):
        raise PresentationError(
            f"{field} must match {_LAYOUT_ID_RE.pattern} and be at most "
            f"{_LAYOUT_ID_MAX} characters (got {trimmed!r})"
        )
    return trimmed


def _normalize_column_name(value: Any, *, field: str) -> str | None:
    """A raw metadata column name. No pattern and no cap — a CSV header may contain
    anything, and the bound is DERIVED from the field this overrides (``column_roles``
    ``roleEntry.column``, which has neither), not picked here."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise PresentationError(f"{field} must be a string or null")
    trimmed = value.strip()
    return trimmed or None


def _normalize_entry(
    entry: Any, *, allowed: dict[str, Any], where: str
) -> dict[str, Any]:
    """One ``columns``/``layouts`` entry, normalized key by key. KEY PRESENCE IS THE
    SIGNAL at every level: a key present is written, a key absent leaves whatever was
    there alone, and ``null``/blank removes it. An unknown key raises (→ 422 at the
    router) rather than being silently dropped — the schema is ``additionalProperties:
    false``, so accepting one would write a file that does not validate."""
    if not isinstance(entry, dict):
        raise PresentationError(f"{where} must be an object or null")
    unknown = set(entry) - set(allowed)
    if unknown:
        raise PresentationError(f"unknown key(s) in {where}: {sorted(unknown)}")
    out: dict[str, Any] = {}
    for key, value in entry.items():
        out[key] = allowed[key](value, field=f"{where}.{key}")
    return out


def _normalize_render(value: Any, *, field: str) -> str | None:
    if value is None:
        return None
    if value not in _RENDER_KINDS:
        raise PresentationError(
            f"{field} must be one of {list(_RENDER_KINDS)} or null (got {value!r})"
        )
    return str(value)


def _normalize_hidden(value: Any, *, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise PresentationError(f"{field} must be true, false or null")
    return value


def _normalize_free_label(value: Any, *, field: str) -> str | None:
    """A display label — for a column or a layout. Trimmed; blank clears. Deliberately
    UNCAPPED: the bound mirrors the field it overrides (``column_roles`` ``roleEntry.label``
    and the manifest's ``layoutEntry.label``, both ``minLength: 1`` with no maximum), so an
    override can say anything the bake could have said. Derived, not picked.

    The review of PR #346 (finding 8) argued the derivation does not hold, because
    ``roleEntry.label`` "is written by the bake from operator-controlled input, while this
    PATCH takes it from any authenticated owner". MEASURED against the source 2026-09-09,
    that asymmetry does not exist: ``models.CreateDatasetRequest.column_roles`` is typed
    ``dict | None`` with no validator, arrives from the same authenticated web caller, and
    is handed to ``queue.enqueue_ingest`` verbatim — so a ``roleEntry.label`` is exactly as
    unbounded, on exactly the same trust boundary. Capping here alone would close nothing,
    and it would make an override NARROWER than the label it overrides, which is a
    regression: a long bake-generated label would become un-editable.

    So the bound that is missing is on ``column_roles.schema.json`` ``roleEntry.label``,
    where BOTH writers would inherit it — a coordinated schema+pipeline change, not an
    API-local pick. Tracked as
    [[T2-a-metadata-column-label-is-unbounded-on-both]]. AGENT_GUIDE Limits: a picked
    replacement here is the same defect one order larger."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise PresentationError(f"{field} must be a string or null")
    return value.strip() or None


def _stamped_version(record: dict[str, Any]) -> str:
    """The ``presentation_version`` a rewrite of ``record`` should carry.

    NOT unconditionally ``PRESENTATION_VERSION``. ``apply_updates`` deep-copies the stored
    record, so every unknown top-level key a NEWER writer left survives the rewrite; a
    blanket stamp then relabels that 1.3 content as 1.0, and the file no longer validates
    (``presentation.schema.json`` is ``additionalProperties: false``, so those keys are
    only legal under the version that introduced them). An older API is then denying
    content it just preserved — review of PR #346, finding 12.

    So the stamp never moves DOWN: a stored minor above ours is kept, and ours is written
    for anything at or below it, absent, or malformed. That is safe because 1.x is
    additive by construction — the schema's ``pattern`` admits only ``1.<minor>``, so a
    minor bump can add optional keys and nothing else, and this writer's edits to the keys
    it does understand stay valid under any of them.

    A different MAJOR is the one case that refuses. This writer cannot know what a 2.x file
    means by the keys it shares, so merging into it could corrupt it and stamping it would
    lie about it; refusing leaves the operator's bytes on disk, the same posture ``update``
    already takes for a file it cannot parse. Contrast ``manifest.append_manifest_layouts``,
    which RE-stamps because the merged file may carry newer fields — the same premise, and
    the stamp there moves up, not down."""
    our_major, our_minor = _OUR_VERSION
    stored = _clean_str(record.get("presentation_version"))
    match = _VERSION_RE.match(stored) if stored is not None else None
    if stored is None or match is None:
        # Absent, or a shape no contract ever wrote. Nothing to preserve, so claim ours.
        return PRESENTATION_VERSION
    major, minor = int(match.group(1)), int(match.group(2))
    if major != our_major:
        raise PresentationError(
            f"{PRESENTATION_FILENAME} declares presentation_version {stored!r}, which this "
            f"API cannot write (it writes {PRESENTATION_VERSION}); upgrade the API or "
            f"remove the file on the server before writing",
            io_error=True,
        )
    return stored if minor > our_minor else PRESENTATION_VERSION


_COLUMN_KEYS = {
    "label": _normalize_free_label,
    "render": _normalize_render,
    "hidden": _normalize_hidden,
}
_LAYOUT_KEYS = {"label": _normalize_free_label}

# Every dataset-level key this writer accepts, with the normalizer that validates it. One
# table, so adding a field is one row rather than a parameter and two branches — the shape
# `appstate.PRESENTATION_LIMITS` already established for the three it grew out of.
_DATASET_KEYS = {
    "display_name": _normalize_scalar,
    "attribution": _normalize_scalar,
    "attribution_url": _normalize_scalar,
    "default_layout": _normalize_layout_id,
    "title_column": _normalize_column_name,
}


def apply_updates(
    record: dict[str, Any],
    updates: dict[str, Any],
    *,
    fallback: appstate.DatasetRecord | None = None,
) -> dict[str, Any]:
    """The stored record with ``updates`` applied — PURE, so the whole rule is testable
    without a filesystem. Raises ``PresentationError`` (→ 422, or → 409 for the one
    server-side case ``_stamped_version`` refuses) and touches nothing if any value is
    bad: the write is ALL-OR-NOTHING across fields, so a too-long name cannot leave a
    sibling half-written.

    **Key presence is the signal, values are the payload** — the semantics
    ``appstate.set_dataset_presentation`` established, carried over intact and extended one
    level down. A key present is written; a key absent is left alone; ``None`` or blank
    CLEARS (the key is REMOVED, because the schema has no null and no empty string — see
    ``minLength: 1``). Inside ``columns``/``layouts`` the same rule applies per entry:
    ``{"columns": {"src": {"render": "url"}}}`` touches only that column's ``render``,
    ``{"columns": {"src": null}}`` removes the whole entry, and a column not mentioned is
    untouched. That is what makes the PATCH partial AND able to undo a bad value, and it
    makes "nothing to set" unrepresentable rather than a runtime guard.

    ``fallback`` is the app-state row. When the update creates the ``dataset`` block for
    the first time, the block is SEEDED from it, because the block is what switches the
    app-state fallback off (see ``effective``) — without the seed, setting
    ``default_layout`` on an un-migrated dataset would silently drop its display name."""
    unknown = set(updates) - set(_DATASET_KEYS) - {"columns", "layouts"}
    if unknown:
        raise PresentationError(f"unknown presentation field(s): {sorted(unknown)}")

    # Normalize EVERYTHING before touching the record (all-or-nothing).
    dataset_updates = {
        field: _DATASET_KEYS[field](value, field=field)
        for field, value in updates.items()
        if field in _DATASET_KEYS
    }
    map_updates: dict[str, dict[str, Any]] = {}
    for map_key, allowed in (("columns", _COLUMN_KEYS), ("layouts", _LAYOUT_KEYS)):
        if map_key not in updates:
            continue
        raw = updates[map_key]
        if not isinstance(raw, dict):
            raise PresentationError(f"{map_key} must be an object")
        entries: dict[str, Any] = {}
        for name, entry in raw.items():
            key = (
                _normalize_layout_id(name, field=f"{map_key} key")
                if map_key == "layouts"
                else _normalize_column_name(name, field=f"{map_key} key")
            )
            if key is None:
                raise PresentationError(f"{map_key} key must be a non-empty string")
            entries[key] = (
                None
                if entry is None
                else _normalize_entry(entry, allowed=allowed, where=f"{map_key}.{key}")
            )
        map_updates[map_key] = entries

    out = json.loads(json.dumps(record)) if record else {}  # deep copy; never mutate input
    # The deep copy carries EVERY unknown top-level key through, so the stamp has to be
    # told what the file already claims rather than asserting ours over it (finding 12).
    out["presentation_version"] = _stamped_version(out)

    if dataset_updates:
        block = out.get("dataset")
        if not isinstance(block, dict):
            # First write of the block: carry the app-state fallback in, so taking
            # ownership of the three migrated scalars never loses one of them.
            block = {}
            if fallback is not None:
                for key in _MIGRATED_SCALARS:
                    value = getattr(fallback, key, None)
                    if value is not None:
                        block[key] = value
        for field, value in dataset_updates.items():
            if value is None:
                block.pop(field, None)
            else:
                block[field] = value
        out["dataset"] = block

    for map_key, entries in map_updates.items():
        current = out.get(map_key)
        current = dict(current) if isinstance(current, dict) else {}
        for name, entry in entries.items():
            if entry is None:
                current.pop(name, None)
                continue
            merged = dict(current.get(name) or {})
            for key, value in entry.items():
                if value is None:
                    merged.pop(key, None)
                else:
                    merged[key] = value
            if merged:
                current[name] = merged
            else:
                # KEEP the emptied entry. Removal is already expressible — `entry is
                # None` pops it, six lines up — so popping here too overloaded "clear
                # every key" with "forget this column", and the two are not the same
                # thing. `effective` re-applies the manifest's legacy `url` role to
                # exactly the columns the record does NOT describe, so a dropped entry
                # RESURRECTED the link: on rijks_pilot, unticking "render as link" sent
                # `{"render": null}`, popped the key, emptied the entry, wrote nothing,
                # and answered 200 while the column stayed a link — permanently, since
                # `migrate-presentation` copies the role and never removes it (review of
                # PR #346, finding 1).
                #
                # An empty entry is the tombstone that says "the owner has spoken about
                # this column: nothing special." It validates (`columnPresentation` sets
                # no `minProperties`), and it is what makes the pipeline's
                # `drop_retired_roles` ownership test — `name in columns` — true for a
                # column whose only setting was cleared. Without it, that guard and this
                # writer disagreed about what "described" means.
                current[name] = {}
        if current:
            out[map_key] = current
        else:
            out.pop(map_key, None)

    return out


def write(ds_dir: Path, record: dict[str, Any]) -> None:
    """Write ``presentation.json`` ATOMICALLY (temp + rename in the same directory), the
    same shape ``manifest._atomic_write_json`` uses for the other record. A half-written
    presentation file is worse than a stale one: the reader falls back to app-state and the
    dataset silently loses its name.

    Creates the dataset directory if it does not exist yet — a presentation choice only
    needs the METADATA to exist, not a bake (D-xvii), so this path must work before the
    worker has committed anything. That is safe against a bake in flight: ``worker._commit``
    MERGE-MOVES onto the dataset directory — ``mkdir(exist_ok=True)``, then ``_move_merge``
    for each item it STAGED, then an ``os.replace`` of the manifest for the atomic version
    flip. It touches nothing it did not stage, and it never stages this file, so
    ``presentation.json`` is left exactly where it was. Nothing in that sequence cares
    whether the directory already existed, which is why creating it here is safe at any
    moment — including between the commit's first and last step.

    That argument used to be made about ``_commit``'s whole-directory ``os.rename`` fast
    path ("taken only when the dataset directory does NOT exist"). That branch existed but
    could never run — its sole call site always passed ``keep_staging=True`` — so the
    invariant held for a reason unrelated to the one written down, and the two locks that
    would have ordered a directory-creating write against it are different Redis keys
    (``dataset-mutate:{id}`` vs ``ingest-commit:{id}``). The dead branch is removed by the
    pipeline half of this review (PR #346, finding 5); the paragraph above is the same
    claim restated on the code that actually runs, and it held before the deletion too.

    A directory holding only this file is not a dataset (``db.is_dataset`` keys on the
    manifest) and ``worker._read_current_version`` reads that same manifest, so an un-baked
    tree still gets ``dataset_version=1``.

    Raises ``PresentationError(io_error=True)`` when the tree cannot be written — the
    showcase profile mounts the content ``:ro`` on purpose, and that must surface as an
    actionable refusal rather than a 500."""
    path = ds_dir / PRESENTATION_FILENAME
    # Before the write, not after: an eviction that is skipped because the write raised
    # would leave the reader holding a record that may or may not still be on disk, and
    # this direction is only ever a wasted re-parse.
    _invalidate(path)
    try:
        ds_dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(ds_dir), suffix=".json.tmp")
        closed = False
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                closed = True  # fdopen took ownership; the `with` closes it
                json.dump(record, handle, indent=2, ensure_ascii=False)
                handle.write("\n")
            os.replace(tmp, path)
        except BaseException:
            # If `os.fdopen` itself raised, nothing ever took ownership of the descriptor
            # and unlinking the temp file leaks it for the life of the uvicorn worker
            # (review of PR #346, finding 13). Closing an fd `fdopen` DID adopt would be a
            # double close, so the flag records which side of that line we are on.
            if not closed:
                try:
                    os.close(fd)
                except OSError:
                    pass
            Path(tmp).unlink(missing_ok=True)
            raise
    except OSError as exc:
        raise PresentationError(
            f"cannot write {PRESENTATION_FILENAME} for this dataset "
            f"({type(exc).__name__}: {exc}) — the dataset tree may be mounted read-only",
            io_error=True,
        ) from exc


def update(
    ds_dir: Path,
    updates: dict[str, Any],
    *,
    fallback: appstate.DatasetRecord | None = None,
) -> dict[str, Any]:
    """Read-modify-write one dataset's presentation record, returning what was stored.

    NOT serialized against a concurrent writer by itself — EVERY caller that can race
    holds the per-dataset API-mutation lock (``queue.dataset_lock``) around it, which is
    the same lock DELETE and create already take. That is the PATCH route, create, and
    ``api.admin``'s ``set-*``/``migrate-presentation`` verbs: the CLI is documented to run
    as ``docker compose exec api …``, i.e. inside a live API, so it is a racing writer too
    and held no lock until the review of PR #346 (finding 4). There is no lock against the
    BAKE, and there deliberately does not need to be one: the bake never touches this file
    (D-xv)."""
    current, problem = _read(ds_dir / PRESENTATION_FILENAME)
    if problem is not None:
        # Refuse rather than overwrite: the operator's bytes are still on disk and a
        # hand-edit that went wrong is recoverable only while they are.
        raise PresentationError(
            f"{PRESENTATION_FILENAME} is present but unusable ({problem}); "
            f"fix or remove it on the server before writing",
            io_error=True,
        )
    record = apply_updates(current or {}, updates, fallback=fallback)
    write(ds_dir, record)
    return record


def discard(ds_dir: Path) -> None:
    """Undo a presentation write that created the dataset directory, when the create it
    was written for never reached the queue.

    Deliberately TIMID: it removes ``presentation.json`` and then ``rmdir``s the directory,
    which fails harmlessly if anything else is in it. It is never a recursive delete — the
    only path that removes a dataset TREE is DELETE's tombstone rename, and a rollback
    helper must not be a second one. Best effort: a failure here leaves an inert file in a
    directory the listing already ignores (`db.is_dataset` keys on the manifest), which is
    strictly better than failing the request a second time."""
    path = ds_dir / PRESENTATION_FILENAME
    _invalidate(path)  # this REMOVES the file; a cached parse of it is now a lie
    try:
        path.unlink(missing_ok=True)
        ds_dir.rmdir()
    except OSError as exc:
        logger.warning("Could not roll back %s: %s", path, exc)


# ---------------------------------------------------------------------------
# The migration off app-state (D-i / T2-presentation-does-not-travel-with-the-dataset).
# ---------------------------------------------------------------------------


def migrate(
    ds_dir: Path,
    *,
    record: appstate.DatasetRecord | None,
    roles: dict[str, Any] | None,
) -> tuple[str, list[str]]:
    """Move one dataset's presentation INTO its own directory. Returns
    ``(outcome, details)`` where outcome is ``"migrated" | "current" | "skipped"``.

    Idempotent, additive, and it NEVER DELETES ANYTHING:

    * a value already in the file WINS and is left exactly as it is — re-running writes
      nothing, and an operator's later edit is never reverted by a second run;
    * the app-state row is not touched. Those columns stay as the FALLBACK the read path
      uses for an un-migrated dataset (``effective``), and as the only copy a rollback to
      the previous release would find. They are the fallback, not the source: after this
      runs, the file's ``dataset`` block is what answers, and nothing writes those columns
      again;
    * the manifest is not touched either — this module never writes ``layout_manifest.json``
      (D-xv), so a committed ``column_roles.url`` is COPIED out, not moved. See
      ``api.admin migrate-presentation``'s help for what that means for the four live trees
      that carry it.

    A tree that cannot be written — a read-only mount, a missing directory, a corrupt
    presentation file — is reported and skipped with the row left intact. One failure never
    aborts the run."""
    if not ds_dir.is_dir():
        return "skipped", ["no dataset directory on disk"]
    current, problem = _read(ds_dir / PRESENTATION_FILENAME)
    if problem is not None:
        return "skipped", [f"{PRESENTATION_FILENAME} is unusable ({problem})"]

    updates: dict[str, Any] = {}
    details: list[str] = []
    existing = current or {}

    # The three app-state scalars, only when the file does not already own them (the block
    # is the switch — see `effective`), and only the ones that are actually set.
    if not isinstance(existing.get("dataset"), dict) and record is not None:
        for field in _MIGRATED_SCALARS:
            value = getattr(record, field, None)
            if value is not None:
                updates[field] = value
                details.append(f"{field}={value!r}")

    # The pre-2.9 `column_roles.url` role (D-xvii), per column the file does not describe.
    columns = _clean_columns(existing.get("columns"))
    column_updates = {
        name: {"render": "url"}
        for name in legacy_url_columns(roles)
        if name not in columns
    }
    if column_updates:
        updates["columns"] = column_updates
        details.append(f"render=url for {sorted(column_updates)}")

    if not updates:
        return "current", []
    try:
        update(ds_dir, updates, fallback=record)
    except PresentationError as exc:
        return "skipped", [str(exc)]
    return "migrated", details
