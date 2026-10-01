"""Contract gate: the static edge serves every path a manifest declares, and nothing else.

WHY THIS EXISTS. Under ``/datasets/{ds_id}/`` the edge serves an ALLOW-list of path
prefixes and answers 404 for everything else, so build artifacts such as ``ingest.log``
and ``progress.json`` are not published with the dataset
(T2-publishing-a-dataset-publishes-its-build-log). The list lives in
``docker/Caddyfile.edge-snippets``. The paths it must admit come from the manifest the
pipeline writes. The two can drift apart without warning: a new kind of static asset in
the manifest gets a 404 from the edge, and a list widened by accident publishes the
build log again.

WHAT THIS DOES. It reads the allow-list out of the snippet, so the snippet stays the
only source. Then it requires that:

  * every static path in every committed v2 fixture manifest passes it (pyramid
    ``path``, ``positions_ref``, ``tags.path``, a file under ``detail.path_prefix``,
    and ``detail.path`` / ``edges.path`` if a fixture ever carries them);
  * the build artifacts and the files the viewer reads through ``/api`` do not pass it;
  * the list is WIRED: it is negated, and the matcher that holds it invokes a route
    that answers 404. Without this, deleting the ``invoke`` line would leave the list
    in place and every other test here green, while the edge served everything again.

WHAT THIS DOES NOT DO. It runs in ``test-py``, which has no Docker and no Caddy, so it
checks configuration, not behaviour. It does not prove that Caddy orders the 404 before
the ``forward_auth`` gate, or how it treats ``..`` in a path. The render gate's static
edge probe (``.github/workflows/render-gate.yml``) and the live claim
``build-artifacts-not-served`` (``scripts/claims/claims.json``) do that.

The pattern is compiled with Python's ``re``. For the syntax the snippet uses (anchors,
a negated class, an alternation), Python's ``re`` and Go's RE2 agree, and Caddy uses
RE2's unanchored match, which is ``re.search``. If someone writes RE2-only syntax,
the compile fails here and the test goes red.
"""

from __future__ import annotations

import functools
import json
import re
from dataclasses import dataclass
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SNIPPETS = REPO_ROOT / "docker" / "Caddyfile.edge-snippets"
FIXTURES = REPO_ROOT / "tests" / "fixtures"

# Files a dataset directory holds that the viewer never fetches from the static edge.
# The first two are the reason for the rule. The manifest, metadata, presentation and
# cover come through /api. The *.bak names are real: the operator's local rijks_pilot
# holds layout_manifest.json.bak and metadata.parquet.bak (seam brief, 2026-09-28).
# `atlas/` is the v1 tile tree, which the current viewer does not request. The last
# three share a name prefix with an allowed directory, so a list that lost its
# trailing `/` would admit them.
NOT_SERVED = (
    "ingest.log",
    "progress.json",
    "layout_manifest.json",
    "metadata.parquet",
    "presentation.json",
    "cover.webp",
    "layout_manifest.json.bak",
    "metadata.parquet.bak",
    "README.md",
    "atlas/page_0.webp",
    "tiles.bak",
    "detail.log",
    "tags_old.arrow",
)

# Every one of these kinds must occur in at least one fixture, or the test cannot
# notice that its prefix was dropped from the list.
REQUIRED_KINDS = ("pyramid", "positions_ref", "tags", "detail")

# Horizontal whitespace only. A Caddyfile directive is one line, and `\s` would let a
# pattern run on into the next line and read `}` as the directive's argument.
_WS = r"[ \t]*"
_SP = r"[ \t]+"


def _strip_comments(text: str) -> str:
    """Drop Caddyfile comments the way Caddy's lexer does: `#` starts a comment only at
    the start of a token and outside quotes. A `#` inside a token, such as a regex, is
    part of the token, and cutting there would check a truncated pattern."""
    out = []
    for line in text.splitlines():
        quote, prev = "", " "
        for i, ch in enumerate(line):
            if ch in "\"`" and prev != "\\" and quote in ("", ch):
                quote = "" if quote else ch
            elif ch == "#" and not quote and prev in " \t":
                line = line[:i]
                break
            prev = ch
        out.append(line)
    return "\n".join(out)


def _block(text: str, opener: str) -> str:
    """The body of the one block, at any indent, whose first line is ``opener {``."""
    starts = [
        m.end() for m in re.finditer(rf"^{_WS}{re.escape(opener)}{_WS}\{{{_WS}$", text, re.M)
    ]
    assert len(starts) == 1, (
        f"expected exactly one `{opener} {{` block in {SNIPPETS.name}, found {len(starts)}"
    )
    depth, i = 1, starts[0]
    while depth:
        assert i < len(text), f"unbalanced braces after `{opener}` in {SNIPPETS.name}"
        depth += {"{": 1, "}": -1}.get(text[i], 0)
        i += 1
    return text[starts[0] : i - 1]


def _top_level(body: str) -> str:
    """``body`` with the contents of every nested block removed: only the lines that sit
    directly in the block, each opener kept with an empty ``{}``."""
    out, depth = [], 0
    for ch in body:
        if ch == "}":
            depth -= 1
        if depth == 0:
            out.append(ch)
        if ch == "{":
            depth += 1
    return "".join(out)


@dataclass(frozen=True)
class _EdgeRule:
    allow: re.Pattern[str]  # the allow-list, as Caddy's path_regexp holds it
    matcher: str  # the named matcher that holds it, e.g. "@not_a_viewer_asset"
    matcher_body: str
    top_level: str  # (datasets_edge)'s own lines, nested blocks emptied
    text: str  # the whole snippet file, comments stripped


@functools.cache
def _edge_rule() -> _EdgeRule:
    """Parse the snippet once; every case reads the same result."""
    text = _strip_comments(SNIPPETS.read_text(encoding="utf-8"))
    body = _block(text, "(datasets_edge)")
    hits = re.findall(rf"^{_WS}(not{_SP})?path_regexp{_SP}(?:\S+{_SP})?(\S+){_WS}$", body, re.M)
    assert len(hits) == 1, (
        f"expected exactly one path_regexp (the allow-list) inside (datasets_edge), "
        f"found {len(hits)}: {hits}"
    )
    negated, pattern = hits[0]
    assert negated, (
        "the allow-list must be NEGATED (`not path_regexp ...`): its matcher selects "
        "what is NOT served. Without `not`, the viewer's assets get the 404 and every "
        "other file is served"
    )
    # Only a matcher declared DIRECTLY in (datasets_edge) counts. Inside handle_path the
    # rule is dead: the /datasets prefix is already stripped, so `path /datasets/*`
    # never matches, and forward_auth sorts before `invoke` there anyway.
    top_level = _top_level(body)
    declared = re.findall(rf"^{_WS}(@\w+){_WS}\{{\}}", top_level, re.M)
    holders = [name for name in declared if "path_regexp" in _block(body, name)]
    assert len(holders) == 1, (
        f"the allow-list must sit in one named matcher declared at the top level of "
        f"(datasets_edge), not inside handle_path or another block. Top-level matchers "
        f"holding it: {holders}"
    )
    matcher = holders[0]
    return _EdgeRule(re.compile(pattern), matcher, _block(body, matcher), top_level, text)


@functools.cache
def _static_paths() -> list[tuple[str, str, str]]:
    """-> (fixture, kind, dataset-relative path) for every static asset a v2 fixture
    manifest declares, as the viewer's ``assetUrl`` callers would request it."""
    manifests = sorted(FIXTURES.glob("*_v2/layout_manifest.json"))
    assert len(manifests) >= 4, f"expected the v2 fixture manifests, found {manifests}"
    out: list[tuple[str, str, str]] = []
    for path in manifests:
        fixture = path.parent.name
        manifest = json.loads(path.read_text(encoding="utf-8"))
        tags = manifest.get("tags")
        if tags:
            out.append((fixture, "tags", tags["path"]))
        for layout in manifest["layouts"]:
            out.append((fixture, "pyramid", layout["pyramid"]["path"]))
            if layout.get("positions_ref"):
                out.append((fixture, "positions_ref", layout["positions_ref"]))
            detail = layout.get("detail") or {}
            if detail.get("path_prefix"):
                # The overlay composes {path_prefix}/{cell_id}.{ext} (staticDetailUrl).
                prefix = detail["path_prefix"].rstrip("/")
                out.append((fixture, "detail", f"{prefix}/0.{detail.get('format', 'webp')}"))
            if detail.get("path"):
                out.append((fixture, "detail.path", detail["path"]))
            edges = layout.get("edges") or {}
            if edges.get("path"):
                out.append((fixture, "edges", edges["path"]))
    return out


def test_every_kind_of_static_asset_is_exercised() -> None:
    kinds = {kind for _, kind, _ in _static_paths()}
    missing = [k for k in REQUIRED_KINDS if k not in kinds]
    assert not missing, (
        f"no v2 fixture declares a {missing} path, so dropping that prefix from the "
        f"edge allow-list would go unnoticed here"
    )


@pytest.mark.parametrize(
    ("fixture", "kind", "rel"), _static_paths(), ids=lambda v: str(v)
)
def test_edge_serves_every_declared_static_path(fixture: str, kind: str, rel: str) -> None:
    allow = _edge_rule().allow
    url_path = f"/datasets/{fixture}/{rel}"
    assert allow.search(url_path), (
        f"{fixture}'s manifest declares {kind} `{rel}`, which the static edge allow-list "
        f"`{allow.pattern}` in {SNIPPETS.name} does not admit: the viewer would get a 404. "
        f"If the pipeline now emits this kind of asset, add its prefix to the list"
    )


@pytest.mark.parametrize("rel", NOT_SERVED)
def test_edge_does_not_serve_build_artifacts(rel: str) -> None:
    allow = _edge_rule().allow
    url_path = f"/datasets/some_dataset/{rel}"
    assert not allow.search(url_path), (
        f"the static edge allow-list `{allow.pattern}` admits `{rel}`, which the viewer "
        f"never fetches statically: publishing a dataset would publish it"
    )


def test_the_allow_list_is_wired_to_a_404() -> None:
    rule = _edge_rule()
    assert re.search(rf"^{_WS}path{_SP}/datasets/\*{_WS}$", rule.matcher_body, re.M), (
        f"{rule.matcher} must also match `path /datasets/*`, or it could fire outside "
        f"the dataset edge"
    )
    # Top level only, for the reason in _edge_rule: an `invoke` nested in handle_path
    # runs after forward_auth and sees the stripped path.
    invoked = re.findall(
        rf"^{_WS}invoke{_SP}{re.escape(rule.matcher)}{_SP}(\S+){_WS}$", rule.top_level, re.M
    )
    assert len(invoked) == 1, (
        f"(datasets_edge) must `invoke {rule.matcher} <route>` exactly once, at its top "
        f"level, found {len(invoked)}. Without it the allow-list is declared but never "
        f"applied, and the edge serves every file in the dataset directory"
    )
    route = _block(rule.text, f"&({invoked[0]})")
    assert re.search(rf"^{_WS}respond{_SP}404{_WS}$", route, re.M), (
        f"the named route &({invoked[0]}) must `respond 404`, found: {route.strip()!r}"
    )


def test_comments_are_stripped_the_way_caddy_strips_them() -> None:
    # `#` inside a token (a regex) and inside quotes is not a comment.
    assert _strip_comments("\tnot path_regexp ^/a#b/ # why") == "\tnot path_regexp ^/a#b/ "
    assert _strip_comments('\trespond "a # b" 404') == '\trespond "a # b" 404'
    assert _strip_comments("# whole line\n\tfile_server") == "\n\tfile_server"
