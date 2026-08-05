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

The token deliberately carries **no permissions**. Every authorization decision is a
server-side lookup at request time, so:

- revoking access takes effect immediately rather than at token expiry;
- a stolen token cannot grant more than the account currently has;
- there is no signed claim to tamper with, because there is no claim worth tampering
  with.

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
  files and never in a token.
- Static asset requests are gated by a scoped, `httponly` cookie whose lifetime mirrors
  the session.

## Account creation

**Signup is disabled by default in production.** With `APP_ENV=production` and no
explicit `ALLOW_SIGNUP`, account creation is refused. A self-hosted instance that wants
open registration must turn it on deliberately.

The default assumes the common case: an institution provisioning known users, not a
public site accepting arbitrary registrations.

## Rate limiting

The authentication routes are rate limited per client address, returning `429` with
`Retry-After`. Configurable via `AUTH_RATE_LIMIT` and `AUTH_RATE_LIMIT_WINDOW_SECONDS`.

**Two limitations, stated because they matter for how you deploy:**

1. **The limiter is in-process.** With more than one API replica, each replica keeps its
   own budget, so the effective limit is multiplied by the replica count. A single-API
   deployment — the documented topology — is unaffected.
2. **Client identity comes from the reverse proxy.** The limiter reads the address the
   proxy reports, and trusts it because the shipped reverse-proxy configuration is the
   only thing that can set it. **If you expose the API port directly, or place another
   proxy or CDN in front, that assumption no longer holds** and the header must be
   re-validated for your topology.

## What the edge exposes

The public deployment profile (`docker-compose.public.yml`) is deliberately reduced:

- **No worker and no job queue.** Ingest and upload cannot run. A public showcase host
  serves pre-built datasets and has no write path at all.
- The frontend is **built once and served as static files** — no development server is
  exposed.
- Security headers are set at the edge: HSTS, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and a framing-restrictive CSP.
- Dataset asset paths are jailed to the dataset directory; path traversal is rejected
  before any file is opened.

## Dependencies and reproducibility

- Python dependencies are **compiled lockfiles** installed with `--no-deps`, so the
  installed set is exactly what is pinned.
- Docker images pin explicit base-image tags.
- Automated dependency updates are enabled, and vulnerability alerts are triaged rather
  than auto-merged.

For auditors: what you audit is what you run, provided you build from a tagged release
and the lockfiles present in it.

## What is left to you

Plotlas is software, not a managed service. These are yours:

- **TLS** — the shipped edge configuration obtains certificates automatically, but the
  domain and DNS are yours.
- **Backups** — the application-state database holds accounts and ownership. Back it up.
  The dataset tree is reproducible from its inputs; the state database is not.
- **Host hardening** — OS patching, firewalling, SSH policy, and who can reach the
  machine.
- **Content responsibility** — Plotlas displays what you ingest. It performs no
  moderation, classification or filtering of any kind.

## Reporting a vulnerability

Please email **legal@plotlas.com** rather than opening a public issue, so a fix can ship
before the details are public.
