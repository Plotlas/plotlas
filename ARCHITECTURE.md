# How Plotlas works

A high-level map of the system for two audiences: people **self-hosting** it, and people
**auditing** it before letting a collection near it. It describes the shape of the
system and where data goes — not the internals of any one module.

## The short version

Plotlas has three parts and data moves through them in one direction only:

```
images (+ optional metadata CSV)
        │
        ▼
   ┌──────────┐     prepared files      ┌─────────┐     HTTP      ┌──────────┐
   │ pipeline │ ──────────────────────► │   api   │ ◄───────────► │ frontend │
   └──────────┘   on your local disk    └─────────┘   same origin └──────────┘
     prepares                              serves                    renders
    (offline)                            (read-only)               (your browser)
```

- **pipeline** reads your images once and writes a self-contained folder of prepared
  files. It is the only component that ever writes collection data.
- **api** serves those files. It treats the collection as **read-only** and never
  modifies it.
- **frontend** is the viewer. It runs in your browser, talks only to your own api, and
  draws the collection with WebGL.

The frontend never talks to the pipeline, and nothing talks to anyone else's server.

## Two phases: prepare, then serve

**Preparing** happens once, offline, and is the expensive step. The pipeline walks your
image folder, assigns each image a stable id, optionally joins a metadata file **by
filename**, computes the spatial arrangements, and bakes a pyramid of pre-rendered
tiles — a coarse mosaic for the zoomed-out view, progressively sharper tiles as you go
in. Time and disk both scale with the number of images and their resolution.

**Serving** is cheap and read-only. Because every view was pre-rendered, browsing a
million-image collection streams only the handful of tiles covering the current
viewport, plus metadata for images you actually click.

Arrangements are computed **from your metadata only** — a date column, a category
column, coordinates you supply. Plotlas never inspects image content to decide where a
picture goes. There is no OCR, no classifier, and no embedding step.

## What ends up on disk, and where

Everything lives under a single root you control — an ordinary folder on your machine,
`./data` by default, or wherever you point `DATA_DIR`. It is a **bind mount, not a Docker
volume**, so your collections are visible in your file browser, back up by copying the
folder, and survive `docker compose down -v`. The root splits into two disjoint areas:

```
DATA_ROOT/
├── datasets/<collection-id>/     ← prepared collections (read-only in normal use)
│   ├── layout_manifest.json      ← describes the arrangements + tile pyramid
│   ├── metadata.parquet          ← your metadata, columnar, queried for the inspector
│   ├── tiles/                    ← the pre-rendered tile pyramid
│   ├── positions/                ← per-image coordinates for each arrangement
│   ├── tags/                     ← tag lookup used by filtering
│   ├── detail/                   ← full-resolution originals (optional; can be skipped)
│   └── cover.webp                ← thumbnail for the library listing
└── app-state/appstate.db         ← SQLite: accounts and collection ownership
```

Two things worth noting for an audit:

- A prepared collection is **self-contained and portable**. Paths inside the manifest
  are relative, so a collection folder can be copied to another host and served as-is.
- **Collection data and account data are deliberately separate.** The dataset tree holds
  no user or authorization information; ownership and visibility live only in the
  app-state database.

## Network posture

- **The running application makes no outbound network calls.** No telemetry, no
  analytics, no crash reporting, no licence or update checks, no third-party fonts,
  scripts, or CDNs. See *Verifying this yourself* below.
- **It runs air-gapped.** Building the container images needs the network (to fetch
  pinned dependencies); running them does not.
- **One way in.** A reverse proxy (Caddy) is the only component intended to be exposed.
  It serves the frontend, forwards API calls, and serves tile files directly with
  immutable caching. The API and the queue are not meant to be published to the
  internet. The Redis queue used during preparation binds to localhost only.
- **The browser talks to your own origin.** The frontend issues same-origin requests to
  your api; it has no external endpoints compiled into it.

## Accounts and access

- Passwords are hashed with **argon2**; plaintext is never stored.
- Sessions use an **identity-only JWT** — it carries who you are, not what you may do.
  Authorization is resolved server-side on every request.
- **Collections are private by default.** A collection is readable by its owner, or by
  anyone if it has been made public.
- Public collections can be read **without an account**, which is what makes a public
  demo possible without opening the whole instance.
- Requests for collection files are authorized at the edge before any bytes are served,
  and dataset ids are normalized and confined to the dataset root, so a crafted path
  cannot reach another collection or escape the data directory.

## What Plotlas does not do

- It does not analyse image content — no OCR, no classification, no embeddings.
- It does not send anything anywhere.
- It does not modify your original images. Preparation reads them and writes derived
  files elsewhere.
- It does not require an account to *self-host* — accounts exist to separate collections
  from one another on a shared instance.

## Verifying this yourself

You do not have to take the network claim on faith. From a clone:

```bash
# No HTTP client or raw socket in the serving or preparation code.
# Both return nothing:
grep -rnE "requests\.|httpx|urlopen|aiohttp|socket\." packages/api/api
grep -rnE "requests\.|httpx|urlopen|aiohttp|socket\." packages/pipeline/pipeline

# No external URL of any kind compiled into the viewer. Returns nothing:
grep -rnE "https?://" packages/frontend/src

# Every Python dependency is pinned to an exact version:
cat docker/locks/*.lock.txt
```

All three return no output on a clean checkout. Two notes so an unexpected hit does
not confuse you: the paths above are deliberately the **runtime** source
(`packages/api/api`, `packages/pipeline/pipeline`) rather than the whole package —
the test suites do use an HTTP client to exercise the API, which is normal and ships
in no image. And the only `urllib` import in the codebase is `urllib.parse`, which
parses URL *strings* and opens no sockets.

Pinned is not the same as safe, so those exact pins are also checked against the PyPI
advisory database — on any change to a lockfile, and weekly against newly published
advisories. All three were clean when this was written (2026-08-03). The lockfiles
*are* the images (`docker/Dockerfile.*` installs from them), so this audits what
actually ships rather than the version ranges we asked for. Run the same check
yourself:

```bash
python -m pip install pip-audit
pip-audit --no-deps -r docker/locks/api.lock.txt     # then worker.lock.txt, test.lock.txt
```

To confirm at runtime rather than by reading, run the stack with the network disabled
(`docker compose ... --network none` on the api container, or a host firewall rule) and
observe that browsing, searching and zooming all continue to work.

## Where to look next

| I want to… | Look at |
|---|---|
| Run it | [`README.md`](README.md) |
| Understand a package | `packages/*/README.md` |
| Know what is stored for a collection | the `datasets/<id>/` tree above |
| Check the data contract between components | `schemas/v2/` |
