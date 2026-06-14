---
note_type: domain-memory
domain: infrastructure
project: guestpost-platform
updated: 2026-06-14
---

# Infrastructure

## Hosting model (2026-06-14)

Currently **laptop-only** for development. A 2GB VPS attempt at `103.42.5.163` (Ubuntu 24.04, BDIX-class provider) was provisioned + bootstrapped + populated with the full stack on 2026-06-14, then deleted same day — Next dev mode + nest --watch + tsx --watch + Docker (postgres/redis/mailpit) exceeded RAM and the first compiled request hung. The repo was scrubbed of VPS artifacts (`infrastructure/vps/`, `infrastructure/caddy/`, `infrastructure/docker/docker-compose.staging.yml`, per-app Dockerfiles, `scripts/vps-sync.sh`, `.env.vps.example`, README VPS section, plan-file Part 2 — all gone).

Shared dev/testing host is an **open question** (see `bedrock/Work/open-questions.md`): bigger VPS, cloud sandbox (Railway/Fly/Render), or production-build (`next build` once + `next start`) instead of dev mode to cut RAM. The image-based staging path was NOT tried — would be significantly cheaper at runtime.



## Docker Compose

`infrastructure/docker/docker-compose.yml`:
- **Traefik v3.3** — reverse proxy (:80, :8080 dashboard)
- **PostgreSQL 17 Alpine** — primary database (:5432)
- **Redis 7 Alpine** — cache + BullMQ queue (:6379)
- **MinIO** — S3-compatible object storage (:9000 API, :9001 console)
- **Mailpit** — dev SMTP server (:1025 SMTP, :8025 UI)

## Environment

- `.env.development` — dev env vars (loaded when `NODE_ENV=development`)
- `.env.example` — template with all required vars
- Runtime env validation at startup (required: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`)
- `NODE_ENV` guards production behaviors

## CI/CD

GitHub Actions:
- **main.yml** — on push to `main`: build, typecheck, test
- **pr.yml** — on PR to `main`: same checks

Steps: checkout → pnpm install → build deps → migrate DB → typecheck → Jest tests → build all

## Build System

- **pnpm 11** workspace monorepo
- **Turbo 2** for task orchestration (all apps + packages)
- 11 build targets across all apps/packages

## Dev Commands

- `pnpm dev:all` — compose + all apps (stable local stack)
- `pnpm -F @guestpost/api test` — unit tests
- `pnpm test:integration` — full money-loop e2e
- `pnpm test:concurrency` — parallel attack scenarios
- `pnpm test:load [users=1000] [concurrency=50]` — load test
- `pnpm seed` — DB seed script
