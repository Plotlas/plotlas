---
kind: reference
lifecycle: live
reviewed: 2026-08-03
anchors:
  - packages/api/api/
  - packages/pipeline/pipeline/
  - packages/frontend/src/
  - packages/frontend/index.html
  - docker/
  - docker-compose.yml
  - docker-compose.public.yml
---
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
image tiles on your own disk, and serves them to your own browser. **The application
makes no outbound network calls at runtime. There is no telemetry, no analytics, no
licence check, and no third-party service.**

Two things that are not the application do reach the network, both detailed under
[What leaves](#what-leaves): **starting or building** the stack installs frontend
packages from the npm registry, and **the public profile's edge** obtains and renews a
TLS certificate — which, being a renewal, it goes on doing for as long as that
deployment is up. Neither carries your images or your metadata. Run a local profile,
where the edge does no certificate work, and once built it runs disconnected.

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

Four things are read **for their value**. Three say nothing about you; the fourth, the
colour profile, is the one residual, and it is described below:

1. **The pixels**, to generate thumbnails and tiles.
2. **The EXIF orientation flag**, so that recorded pixel dimensions match what a viewer
   actually sees.
3. **The embedded colour profile**, kept on the click-through copy so wide-gamut images
   render correctly (see below).
4. **The stated resolution**, which travels into that copy with the profile.

One thing is read for its *names*: when building the click-through copy, Plotlas lists
which metadata blocks an image carries so it can remove them (below), and reports a
count — never the contents — of how many originals carried any. That count is written to
the dataset's own build log, `ingest.log`, and printed to your terminal when you build
from the command line. The log stays in the dataset directory, so the count travels
with the dataset when you copy it: a number, never a value from anyone's file. The
static edge does not serve that log, and the API returns part of it to the dataset's
owner only; both are described in *Where it is stored*.

An image the software cannot read is skipped rather than failing the build, and how
much detail you get depends on where it fails. Most unreadable files are rejected early,
while thumbnails are made: `ingest.log` then records **how many** were skipped, and the
names appear only in the build's console or container output. A file that reads at
thumbnail size and fails at full size is named in `ingest.log` itself.

**No other embedded metadata is read.** Not GPS coordinates, not capture timestamps,
not camera or device identifiers, not IPTC or XMP blocks. None of it reaches
`metadata.parquet`, none of it reaches a layout, and no search or filter can surface it.
The only image-derived values written to `metadata.parquet` are `id`, `filename`,
`width` and `height` — the base table `packages/pipeline/pipeline/ingest.py` builds
before your CSV is joined. Everything else in that file came from your CSV.

**Being read and being *republished* are different, and until 2026-09-24 this document
did not distinguish them.** The click-through **detail image** is a re-encode of your
original file, and the imaging library copies a source's EXIF and XMP into its output
unless told not to. It was not told not to, so those blocks — GPS included, where a
camera wrote one — travelled into the served copy. Plotlas never read them; it
republished the file that held them.

**Fixed:** the detail transcode now discards every block that came from your file —
including kinds no version of this software knows the name of, because it keeps a fixed
list rather than removing a fixed list. It keeps the pixels, the embedded colour profile
and the image's own geometry.

One thing to expect if you check the output with a tool like `exiftool`: **the file
still has a small EXIF block that the imaging library rebuilds itself** — the image's
dimensions, its colourspace, and its resolution. The resolution values are your file's
own, carried over rather than invented, so a 600 dpi scan still declares 600 dpi. What
is gone is everything that identifies a camera, a moment or a place: make and model,
serial numbers, capture timestamps, GPS, XMP and IPTC. The profile stays so that wide-gamut originals still render correctly, and that
is itself a trade worth stating: an ICC profile's text tags can name the device or the
person that produced it, so a custom profile travels with the image. Two more things to
know if this matters to you:

- **Datasets baked before that fix keep what they had.** Re-baking a dataset clears it;
  adding a layout or re-ingesting with `--detail-tier retain` does not, because both
  reuse the committed detail tier.
- **`--detail-tier skip` bakes no detail tier at all.** The atlas and tiles still
  render, and no copy of any original is written into the dataset or served. That is
  the setting for a collection whose originals you do not want republished in any form.

Tiles and thumbnails never carried metadata: they are drawn from decoded pixels held in
memory, which have no metadata to copy.

## Where it is stored

Everything lives on disk on the machine you run it on, in **three separate stores**,
deliberately kept apart:

**1. The dataset tree** — `/{DATA_ROOT}/datasets/{dataset_id}/`. A build writes it. It
changes afterwards in three ways, all of them yours: the application writes the
presentation file when someone edits display settings; a dataset's **owner** can add or
remove a layout, or change how columns are read, from the web, which re-runs a build
step and rewrites the manifest; and operator commands can do the same from a terminal
without re-baking. Nothing else writes here — not a visitor, not a background task:

| Path | Contents |
|---|---|
| `tiles/` | Pre-rendered image pyramids (PMTiles containers) |
| `detail/v{n}/` | One larger copy per image, for the click-through view |
| `metadata.parquet` | Your CSV, joined to image ids |
| `positions/`, `tags/` | Per-layout coordinates and the tag index |
| `layout_manifest.json` | What layouts exist and how to read them |
| `presentation.json` | **Editable.** The display choices a person made: the name shown, the credit line and its link, the default layout, layout and column labels, and which columns are hidden. Written by the application, never by the build |
| `cover.webp`, `ingest.log`, `progress.json` | The Library thumbnail, the build log for that dataset, and its build progress. The static edge serves none of them. The API serves the thumbnail to whoever may read the dataset, and part of the log to the dataset's owner only, as described below |

**2. The application-state database** — a SQLite file holding user accounts (`username`,
`email`, `password_hash`, `created_at`), dataset ownership and visibility, and the
bookkeeping that links a dataset to the upload it came from. Passwords are hashed with
**argon2**; the plaintext is never stored.

**3. The upload area** — `/{DATA_ROOT}/users/{username}/uploads/{upload_id}/`, and it is
the one most easily forgotten. **When images are uploaded through the web interface,
the originals are extracted here and stay here after the dataset is built.** They are
not swept on a schedule and are not removed when the dataset is deleted, because a
retained bundle is what a re-ingest reads from.

Two things follow, and both matter if your images carry embedded metadata:

- **Their bytes are never served.** No route returns an uploaded file's contents — the
  upload API exposes listings of names, sizes and checksums — and the static edge serves
  the dataset tree, not this one. One owner-only route reads *into* a bundle: when you
  are choosing which columns to use, it returns your CSV's column names, types and its
  first row, so you can see what you are picking. They are on your disk, not on the web.
- **They are untouched originals.** The metadata stripping described above applies to
  what Plotlas *builds*; it does not rewrite your files. If you want the originals gone
  after a build, delete that upload directory yourself.

Ingesting from a directory on the host instead (the command-line path) writes nothing
here: your images stay wherever they already were.

The separation that matters is structural: **authorization data never enters the dataset
tree.** Who owns a dataset and who may read it live only in the database, so copying a
dataset directory to another machine carries its images, its layouts and its credits —
and no permissions at all.

One detail worth knowing, because it is the kind a privacy review asks about: the build
log records the username the build ran as, as a label. It grants nothing. No code reads
it back as a permission.

The static edge serves files from these subdirectories of a dataset only: `tiles/`,
`positions/`, `tags/` and `detail/`. For any other path in the dataset directory it
answers 404, and it decides that before it examines a credential, so every caller gets
the same answer. That includes `ingest.log`, `progress.json`, `layout_manifest.json`,
`metadata.parquet`, `presentation.json`, `cover.webp`, and any other file an operator
leaves outside those subdirectories. The rule works by prefix, so a file left inside
one of them is served. The rule is in `docker/Caddyfile.edge-snippets`. Caddy reads that
file only when its container starts, so a deployment gets the rule when you recreate
the container after you update the file:
`docker compose -f <your compose file> up -d --force-recreate caddy`. A plain `up -d`
leaves the running container, and its old rule, in place, because the compose
configuration did not change.

The API reads some of those files from disk and answers for them, to whoever may read
the dataset. On a public dataset, that is anyone:

- The manifest, the presentation settings, and the thumbnail.
- The metadata, through `GET /api/datasets/{id}/metadata`. This is by design, because
  it is what the viewer's inspector shows. Hidden columns are included: hiding a column
  is a display choice, not a privacy control.

The build log and a failed build's error message go to the dataset's **owner** only.
`GET /api/jobs/{job_id}` answers anyone who may read the job's dataset, while the job
queue keeps that job. It first decides whether the caller owns the dataset, and only
for the owner does it then read the last 50 lines of `ingest.log` and, for a failed
build, the error message. Anyone else it answers gets the job's state and its
progress, which includes each build stage's name, counts, timings and whether it
finished or failed, with an empty log and no error message. The error message is treated like the log because it
is the exception's own text: when a build from a web upload fails, it can name the
upload directory, whose path holds the owner's username, and original filenames.

While a bake is queued or running, the dataset list still gives that job's id to every
caller who can see the dataset. The id reaches the job's state and progress, not its
log. The rule is in the API's code (`packages/api/api/routers/jobs.py`), not in a file
the edge reads, so a deployment gets it when its `api` container runs a version that
includes it. The whole log stays on disk in the dataset directory, where an operator
can read it.

## What leaves

**Nothing from the application, at runtime.** The two exceptions are the edge and the
build, both below, and neither carries your images or your metadata.

Verifiable in this tree:

```bash
# No outbound HTTP library is imported anywhere in the shipping Python.
grep -rE "^\s*(import|from)\s+(requests|httpx|aiohttp|urllib\.request|urllib3)" packages/ --include=*.py

# No external URL is referenced in application source.
grep -rnoE "https?://[a-zA-Z0-9.-]+" packages/api/api packages/pipeline/pipeline packages/frontend/src
```

**The first returns nothing**: no module in the application imports an HTTP client.
(Python's standard library is of course present in any image — the container health
check uses it to call the API's own `/api/health` on `localhost` — every five seconds
in the local profile, every fifteen in the public one. What the grep establishes is that
the application code itself never reaches for one.)

**The second returns two lines**, and both are text rather than calls: an example
address in the API's CORS error message (`api/main.py`) and a museum's URL in the help
text of the command that sets a dataset's credit link (`api/admin.py`). Read them, then
note that no code path fetches either.

The browser client makes **relative** requests only — they resolve to the server you
deployed, never to a third party.

Three honest caveats, so the claim is not broader than the evidence:

- **Build time is not run time.** Building the frontend downloads npm packages from a
  registry, and building the Docker images pulls base images. That is ordinary software
  installation and it happens on *your* machine. Note that **both profiles install
  frontend packages as part of bringing the stack up** — the local one to run a dev
  server, the public one to build the static bundle before the edge starts — so
  "starting it" and "building it" are the same act unless you supply a pre-built
  bundle.
- **The public profile's edge keeps talking to a certificate authority.** It obtains a
  certificate on first start and renews it periodically for as long as the deployment
  runs — that is what automatic HTTPS is. An **air-gapped deployment therefore uses a
  local profile** (plain HTTP, or HTTPS with a certificate you supply), builds once with
  network access or receives pre-built images, and then runs disconnected. The public
  profile cannot run disconnected indefinitely, because its certificate would expire.
- **Your browser is your own.** Plotlas serves HTML, JavaScript and images from your
  server. It embeds no third-party scripts, fonts, analytics or trackers, so a visiting
  browser contacts your host and nothing else.

## Who can see what

- Datasets are **private by default** and readable only by their owner.
- A dataset can be made **public**, which allows unauthenticated read access to that
  dataset alone.
- Authentication is a signed token carrying **identity only** — its claims are
  `{sub, exp}` and nothing more (`packages/api/api/appstate.py`), and it lasts 24 hours
  by default, configurable. Permissions are
  looked up server-side on every request; they are never carried in **this** token, so
  it cannot grant more than the server currently allows.
- Static asset delivery to a dataset's **owner** uses an additional `httponly` cookie,
  scoped to that dataset's path and valid for a fixed **one hour**, independent of the
  session's length. Unlike the session token above, this one **does** carry a
  permission: it is signed proof that ownership was checked when it was issued, and the
  edge serves that dataset's files on it **without a database read per request** — it
  checks a signature, and works from a cached answer to "is this dataset public" that is
  never more than 30 seconds stale on the serving path. That is the trade that keeps image delivery fast. The browser renews the
  cookie by re-opening the manifest; it stays valid for up to an hour after sign-out,
  because nothing clears it early. **Anonymous visitors and signed-in non-owners get no
  cookie at all**, including on a public dataset; an owner is issued one for their own
  dataset whether it is public or not.

## What this document does not cover

The **acquisition helpers** used to build the project's own demonstration collections
do fetch from museum and archive APIs — and they are **not part of what is published
here**. They are development tooling for this project's own datasets, kept out of the
published tree by an explicit allow-list (`scripts/publish/allowlist.txt`, which names
no `tools/` entry), and they are no part of the running application.

Note what the two commands above do and do not cover: they search the application source
under `packages/`. The two things that **do** reach the network live in `docker/` — the
public edge's certificate renewal and the frontend build — and both are named in the
caveats rather than left for a grep to find.

Operational concerns — backups, TLS certificates, host hardening — are deployment
matters covered in the install documentation, not data-flow properties of the software.
