# docker

Dockerfile sources for each service. Build contexts are mounted from the repo root so each Dockerfile can reference shared code.

The four service Dockerfiles exist: `Dockerfile.api` (lean FastAPI), `Dockerfile.worker` (pipeline + libvips), and `Dockerfile.test` (combined regression net). Caddy and Redis run from upstream images pinned in `docker-compose.yml`.

## Conventions

- One Dockerfile per service, named `Dockerfile.<service>` or placed in a sub-directory.
- Base images pinned to a digest or minor version tag — never a major-only or `latest` tag (those are mutable upstream). In force today: `python:3.12-slim-bookworm`, `redis:7.4-alpine`, `caddy:2.8-alpine`, and the compose `frontend` service on `node:22.22-bookworm-slim` (minor-pinned; T2-77 replaced the floating major-only `node:22`). Bump the minor deliberately (verify, then update the tag); digest-pinning all bases is an optional further hardening.
- Published ports bind to the loopback interface where the service is unauthenticated. The compose `redis` service publishes `127.0.0.1:6379:6379` (T2-78) so host-local tooling still reaches the broker while it is not exposed on any external interface; inter-service traffic uses the compose network (`redis:6379`) regardless.

## Python dependency locks (`docker/locks/`)

Each Python image installs its deps from a compiled lockfile, not by re-resolving `pyproject.toml` from PyPI on every build (T2-74):

- `api.lock.txt` — the api runtime deps (`Dockerfile.api`).
- `worker.lock.txt` — the pipeline deps incl. the `[test]` extra (pytest) and the worker-process `rq`/`redis` (`Dockerfile.worker`).
- `test.lock.txt` — `api[test]` (adds pytest, httpx) plus the combined test image's extra tools (numpy, `jsonschema[format]`, pmtiles, `mypy` — the CI type-check gate, T2-81) (`Dockerfile.test`).

Each Dockerfile `COPY`s its lock and runs `pip install -r <lock>`, then installs its own package with `--no-deps` so the lock is the single source of resolved versions. `make locks` (re)compiles all three with `uv pip compile` **inside `python:3.12-slim-bookworm`** (the images' shared base, so resolution matches the runtime platform); the compile is deterministic — re-running produces no diff. **Regenerate the locks whenever a `packages/*/pyproject.toml` dependency changes** (`make locks`, then commit the updated `docker/locks/*.lock.txt`). The pyprojects keep their loose constraints — they are the input to the compile, and the lock is the pin.
