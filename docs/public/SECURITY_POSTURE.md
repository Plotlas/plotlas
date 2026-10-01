---
kind: reference
lifecycle: live
reviewed: 2026-08-03
anchors:
  - packages/api/api/
  - docker-compose.public.yml
  - docker/Caddyfile.public
  - docker/Caddyfile.edge-snippets
  - docker/Dockerfile.api
  - docker/Dockerfile.worker
  - .github/dependabot.yml
---
# Security posture

> **Audience:** whoever has to sign off on running Plotlas on your infrastructure.
>
> This describes what the software does, what it deliberately does not do, and what it
> leaves to you. It is written to be checked against the source in this repository, not
> taken on trust. Where something is a known limitation it is stated plainly rather than
> omitted.

## Identity and sessions

**Passwords** are hashed with **argon2** (`argon2-cffi`) and only ever stored hashed.
There is no password-recovery flow, no email-based reset, and no third-party identity
provider — accounts are local to your deployment.

**Sessions** are a signed token (JWT, HS256) whose claims are **`{sub, exp}` and nothing
else** — a username and an expiry. Default lifetime 24 hours, configurable via
`JWT_TTL_SECONDS`.

The token deliberately carries **no permissions**. Every API authorization decision is a
server-side lookup at request time, so on that path:

- revoking access takes effect immediately rather than at token expiry;
- a stolen token cannot grant more than the account currently has;
- there is no signed claim to tamper with, because there is no claim worth tampering
  with.

**The static-asset edge is the exception, and it is a deliberate trade.** Serving image
tiles means thousands of small range requests, and a database lookup on each one is the
difference between a fast atlas and an unusable one. That path checks a signature
instead — see *Access control* below — which means a credential already in a browser
keeps working until it expires, even after the permission behind it is withdrawn.
Immediate revocation holds for the API. For the bytes, a **new** request is re-checked
within **30 seconds** of un-publishing, and an owner's existing credential for a private
dataset lasts **up to an hour**.

**Those windows are about new requests, and caching extends them.** The edge marks every
dataset file publicly cacheable for a year, which is right for immutable tiles and wrong
for anything gated: a browser keeps what it already fetched, and **a shared cache or CDN
in front of the edge can store a private dataset's tiles and serve them to someone else
without the gate ever running.** If you put a cache in front of Plotlas, exclude
`/datasets/*` from it or mark those responses private there. We consider the header a
defect and intend to narrow it.

## The signing secret, and why a misconfigured deploy will not start

`JWT_SECRET` must be supplied by the environment. The source contains a visible
development fallback — deliberately visible, so nobody mistakes it for a secret.

**With `APP_ENV=production`, the application refuses to start** if `JWT_SECRET` is
missing, is the development fallback, or is shorter than 32 characters. The same guard
covers CORS: a missing, blank or wildcard `ALLOWED_ORIGINS` is also refused.

This is intentional. A misconfigured production deployment **crash-loops loudly** rather
than serving insecurely — the failure you can see, instead of the one you cannot.

## Access control

- Datasets are **private by default**; only the owner reads them.
- A dataset may be marked **public**, permitting unauthenticated reads of that dataset
  only.
- Ownership and visibility live in the application-state database, never in the dataset
  files and never in the session token. The one exception is the static-asset cookie
  below, which is a signed statement that the ownership check already passed.
- Static asset requests by a dataset's **owner** are gated by a second `httponly`
  cookie, **scoped to that one dataset's path and valid for a fixed one hour** —
  independent of the session's length, which is 24 hours by default and configurable.
  It is issued only after the ownership check, and the edge then accepts it **without a
  database read per request** — it verifies a signature instead, and works from a cached
  visibility answer that is never more than 30 seconds stale when serving (a denial
  re-checks sooner). That is what keeps asset delivery fast, and it is the trade-off. Two consequences, stated because they are the ones that matter:
  - the cookie stays valid for **up to an hour after sign-out or session expiry** —
    nothing revokes it early — so on a shared machine, close the browser;
  - a browser holding one when ownership changes keeps reading that dataset's files
    until it lapses.

  When it lapses in use, the browser silently re-opens the dataset's manifest, is issued
  a fresh one and retries once. **Anonymous visitors and signed-in non-owners reading a
  public dataset get no cookie at all** — those requests are authorized against the
  dataset's visibility, re-read at least every 30 seconds, so un-publishing takes effect
  within that window.

## Account creation

**Signup is disabled by default in production.** With `APP_ENV=production` and no
explicit `ALLOW_SIGNUP`, account creation is refused. A self-hosted instance that wants
open registration must turn it on deliberately.

The default assumes the common case: an institution provisioning known users, not a
public site accepting arbitrary registrations.

## Rate limiting

The authentication routes are rate limited per client address, returning `429` with
`Retry-After`. Configurable via `AUTH_RATE_LIMIT` and `AUTH_RATE_LIMIT_WINDOW_SECONDS`.

**Three limitations, stated because they matter for how you deploy:**

1. **The limiter is in-process.** Each API process keeps its own budget, so running
   several replicas — or several workers in one container — multiplies the effective
   limit by their number. The documented topology is a single API process with one
   worker, which is unaffected.
2. **Client identity comes from the reverse proxy**, and is only as trustworthy as
   what sits in front of the API. Two deployment shapes change it in **opposite**
   directions, which is worth being precise about:
   - **An exposed API port is a bypass.** Every local profile — plain, HTTPS and
     prod-parity — publishes `api:8000` directly, so anyone who can reach that port can
     set the client-address header themselves and mint fresh budgets. That is a
     workstation convenience; do not build a deployment on those profiles. The public
     profile publishes no API port — only the edge is reachable — so the limit holds.
   - **An extra proxy or CDN in front over-restricts rather than bypasses.** The
     limiter reads the *rightmost* address in the forwarded header — the one the
     nearest hop wrote — so out of the box, an added layer makes every visitor behind
     it share a single budget. That fails safe: self-inflicted over-restriction,
     visible in the logs, rather than an opening.

     **The application has no setting for this; the edge does — and configuring it
     naively makes things worse rather than better.** The edge can be told which proxies
     to trust and asked to hand the API a single resolved client address, which restores
     per-visitor limiting. But with the obvious configuration the resolved address is
     the *leftmost* forwarded entry, which is the one a visitor can supply — so a forged
     header mints a fresh budget per request, turning fail-safe over-restriction into a
     genuine bypass. Caddy's `trusted_proxies_strict` is what makes the resolved address
     the nearest untrusted hop instead; measured on `caddy:2.11-alpine`, a forged prefix
     is ignored with it and honoured without it. **If you put a CDN in front, verify
     what address the API actually receives before trusting the limiter.** Until it is
     configured, the limit applies to your CDN rather than to its visitors, which is the
     safe direction to be wrong in.
3. **Everyone behind one address shares one budget.** That is what per-client-address
   limiting means, and it bites the deployment this software is aimed at: an institution
   whose staff all egress through a single NAT address gets ten sign-in attempts a
   minute between them, at the default. Raise `AUTH_RATE_LIMIT` for that topology.

## What the edge exposes

The public deployment profile (`docker-compose.public.yml`) is deliberately reduced:

- **No worker and no job queue.** Ingest and upload cannot run, and the dataset tree is
  mounted **read-only**. A public showcase host serves pre-built datasets and cannot
  write to them. Writable on that host, and worth knowing about before you sign
  anything:
  - the **application-state database** (accounts and ownership, with signup off unless
    you turn it on);
  - the edge's **certificate store and configuration**;
  - the edge's **access log, which records visitor IP addresses**. Three directives in
    the edge configuration bound it: the file rolls at 10 MiB, ten rolled files are kept
    (compressed), and rolled files are deleted after 30 days. **The 30 days applies to
    rolled files only** — the file being written is retired by size alone, so on a quiet
    host its entries can outlive that window. Change the directives if that does not
    suit you;
  - **container logs** for the long-running services, capped by size and not by age.
    The API's includes a request line per call;
  - the **frontend build**, which runs `npm` over a read-write mount of the frontend
    source to produce the static bundle — worth knowing because installing packages
    executes their install scripts. Build the bundle elsewhere if that is not acceptable
    on a public host.
- The frontend is **built once and served as static files** — no development server is
  exposed.
- Security headers are set at the edge: HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and a framing-restrictive CSP.
- Dataset asset paths are jailed to the dataset directory; path traversal is rejected
  before any file is opened.

## Dependencies and reproducibility

- Python dependencies come from **compiled lockfiles** (`docker/locks/*.lock.txt`),
  which pin the complete transitive closure — every line an exact `==`, readable in the
  files themselves. The application packages are then installed with `--no-deps`
  (`docker/Dockerfile.api`, `Dockerfile.worker`), so nothing re-resolves on top of the
  pinned set.
- Docker images pin explicit base-image tags.
- **Automated dependency updates** are enabled for npm, GitHub Actions, Docker images,
  compose, and the Python dependencies declared in each package's `pyproject.toml`.
  Updates arrive as pull requests and are reviewed; the repository has no workflow that
  merges one automatically.
- **The lockfiles are covered by a different control, and it is worth knowing why.**
  GitHub's dependency graph does not parse `docker/locks/*.lock.txt`, so the pinned
  transitive set — which is what the images actually install — raises no alert there.
  What covers it is a **`pip-audit` run over all three lockfiles**, weekly and on any
  pull request that touches one (`.github/workflows/security-audit.yml`).

For auditors: the Python layer is exactly reproducible — pin a commit, and the lockfiles
in it determine every Python package installed. **There is no tagged release to build
from yet**; the only tag in the repository marks a schema version. One layer below that
is not pinned as tightly: the Dockerfiles name base images by **tag**, not by digest, so
two builds of the same audited commit weeks apart can sit on different base layers. Pin
digests yourself if your audit requires it.

## What is left to you

Plotlas is software, not a managed service. These are yours:

- **TLS** — the **public** edge profile obtains and renews certificates automatically
  from a certificate authority; the domain and DNS are yours. The local profiles do not:
  one runs plain HTTP, and the HTTPS ones use a certificate you supply.
- **Backups** — two things are not reproducible from your inputs, and both are small.
  The **application-state database** holds accounts and ownership. Each dataset's
  **`presentation.json`** holds the display choices a person made: the name shown, the
  credit line and its link, layout and column labels. Everything else in the dataset
  tree can be rebuilt from the images and the CSV; those two cannot, and a rebuild
  without them comes back anonymous and uncredited.
- **Host hardening** — OS patching, firewalling, SSH policy, and who can reach the
  machine.
- **Content responsibility** — Plotlas displays what you ingest. It performs no
  moderation, classification or filtering of any kind.
- **What your image files carry** — the click-through copy of each original is
  re-encoded with its embedded metadata removed, so EXIF and XMP blocks (camera,
  timestamps, GPS) are not republished. Three things are still yours to check: datasets
  built before 2026-09-24 kept theirs until re-baked; `--detail-tier skip` bakes no copy
  of any original at all if you want none; and the **embedded colour profile is kept on
  purpose**, so wide-gamut images render correctly — a custom profile's text tags can
  name the device or person that made it. [`DATA_FLOW.md`](DATA_FLOW.md) has the detail.

## Reporting a vulnerability

Please email **legal@plotlas.com** rather than opening a public issue, so a fix can ship
before the details are public.
