# Multi-stage build for the GuestPost worker (pnpm monorepo).
# Build from the REPO ROOT:  docker build -f apps/worker/Dockerfile -t guestpost-worker .
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /repo
ENV NODE_OPTIONS=--max-old-space-size=2048 \
    PNPM_VERIFY_DEPS_BEFORE_RUN=false

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @guestpost/worker...

COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @guestpost/database exec prisma generate \
 && pnpm --filter @guestpost/worker... build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=builder /repo .
# Exactly ONE worker instance per queue deployment unless every instance runs
# identical code — stale duplicate consumers swallow jobs (see runbook).
CMD ["node", "apps/worker/dist/index.js"]
