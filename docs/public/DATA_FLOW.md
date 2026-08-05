# Data flow — what enters Plotlas, where it is stored, what leaves

> **Audience:** anyone evaluating Plotlas for an institution — a research group, a
> library, an archive — who needs to know what happens to their images and metadata.
>
> This document describes the **self-hosted application**: `packages/`, `docker/` and
> `schemas/` as published in this repository. Every claim below is checkable against
> that source, and the section that matters most — [What leaves](#what-leaves) — names
> the commands to check it with.

## The one-sentence version

Plotlas takes a folder of images and an optional CSV, turns them into pre-rendered
image tiles on your own disk, and serves them to your own browser. **It makes no
outbound network calls at runtime. There is no telemetry, no analytics, no licence
check, and no third-party service.** Run it with the network cable pulled and it works.

## What enters

Two inputs, both supplied by you:

| Input | Required | Notes |
|---|---|---|
| **A folder of images** | Yes | The dataset *is* the images. Each image becomes one cell, and its `id` is assigned by filename order. |
| **A metadata CSV** | No | Optional enrichment, joined to the images **by filename**. Unlocks date, category and tag layouts. Without it, the grid layout still works. |

Nothing else is ingested. There is no image-recognition step, no OCR, no embedding
model, no external enrichment lookup. Layouts are computed from the **columns you
supply**, never from the pixels.

### What is read from the image files themselves

Only two things:

1. **The pixels**, to generate thumbnails and tiles.
2. **The EXIF orientation flag**, so that recorded pixel dimensions match what a viewer
   actually sees.

**No other embedded metadata is extracted, stored, or served** — not GPS coordinates,
not capture timestamps, not camera or device identifiers, not IPTC or XMP blocks. If
your images carry location data in EXIF, Plotlas does not read it, does not put it in
the dataset, and cannot expose it.

The only image-derived values written to `metadata.parquet` are `id`, `filename`,
`width` and `height` (`packages/pipeline/pipeline/ingest.py`, `_RESERVED_COLUMNS`).
Everything else in that file came from your CSV.

## Where it is stored

Everything lives on disk on the machine you run it on. Two separate stores, deliberately
kept apart:

**1. The dataset tree** — `/{DATA_ROOT}/datasets/{dataset_id}/`, read-only once written:

| Path | Contents |
|---|---|
| `tiles/` | Pre-rendered image pyramids (PMTiles containers) |
| `detail/v{n}/` | One larger copy per image, for the click-through view |
| `metadata.parquet` | Your CSV, joined to image ids |
| `positions/`, `tags/` | Per-layout coordinates and the tag index |
| `layout_manifest.json` | What layouts exist and how to read them |
| `cover.webp`, `ingest.log` | Library thumbnail; the build log for that dataset |

**2. The application-state database** — a SQLite file, the only mutable store. It holds
user accounts (`username`, `email`, `password_hash`, `created_at`) and dataset ownership
and visibility. Passwords are hashed with **argon2**; the plaintext is never stored.

That separation is structural, not conventional: the dataset tree is served read-only,
and authorization data never enters it.

## What leaves

**Nothing, at runtime.**

The application makes no outbound connections. Verifiable in this tree:

```bash
# No outbound HTTP library is imported anywhere in the shipping Python.
grep -rE "^\s*(import|from)\s+(requests|httpx|aiohttp|urllib\.request|urllib3)" packages/ --include=*.py

# No external URL is referenced in application source.
grep -rnoE "https?://[a-zA-Z0-9.-]+" packages/api/api packages/pipeline/pipeline packages/frontend/src
```

Both return nothing. The browser client makes **relative** requests only — they resolve
to the server you deployed, never to a third party.

Two honest caveats, so the claim is not broader than the evidence:

- **Build time is not run time.** Building the frontend downloads npm packages from a
  registry, and building the Docker images pulls base images. That is ordinary software
  installation, it happens on *your* machine, and it does not recur while the
  application runs. An air-gapped deployment builds once with network access, or
  receives pre-built images, and then runs disconnected.
- **Your browser is your own.** Plotlas serves HTML, JavaScript and images from your
  server. It embeds no third-party scripts, fonts, analytics or trackers, so a visiting
  browser contacts your host and nothing else.

## Who can see what

- Datasets are **private by default** and readable only by their owner.
- A dataset can be made **public**, which allows unauthenticated read access to that
  dataset alone.
- Authentication is a short-lived signed token carrying **identity only** — its claims
  are `{sub, exp}` and nothing more (`packages/api/api/appstate.py`). Permissions are
  looked up server-side on every request; they are never carried in the token, so a
  token cannot grant more than the server currently allows.
- Static asset delivery uses an additional scoped, `httponly` cookie whose lifetime
  mirrors the session token.

## What this document does not cover

The **acquisition helpers** used to build the project's own demonstration collections
(which fetch from museum and archive APIs) are **not part of this repository**. They are
development tooling for the project's own datasets, not a product feature. Their absence
is why the no-outbound-calls statement above needs no caveat.

Operational concerns — backups, TLS certificates, host hardening — are deployment
matters covered in the install documentation, not data-flow properties of the software.
