# Multi-stage build for the GuestPost worker (pnpm monorepo).
# Build from the REPO ROOT:  docker build -f apps/worker/Dockerfile -t guestpost-worker .
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /repo
ENV NODE_OPTIONS=--max-old-space-size=2048 \
    PNPM_VERIFY_DEPS_BEFORE_RUN=false

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/database/package.json packages/database/
COPY packages/integrations/package.json packages/integrations/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @guestpost/worker...

COPY packages packages
COPY apps/worker apps/worker
# Prisma only needs a syntactically valid URL to generate the client; it does
# not connect to the database here. Keep the real DATABASE_URL runtime-only.
RUN DATABASE_URL=postgresql://guestpost:guestpost@127.0.0.1:5432/guestpost \
    pnpm --filter @guestpost/worker... build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=builder /repo .
# One image serves the realtime service and short-lived job modes. WORKER_MODE
# selects the runtime; see docs/WORKER_ARCHITECTURE.md.
CMD ["node", "apps/worker/dist/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD-SHELL if [ "$WORKER_MODE" = "scheduled" ] || [ "$WORKER_MODE" = "on-demand" ]; then exit 0; else wget -qO- "http://localhost:${WORKER_HEALTH_PORT:-3004}/health" || exit 1; fi
