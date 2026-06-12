# Multi-stage build for the GuestPost API (pnpm monorepo).
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile -t guestpost-api .
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /repo
ENV NODE_OPTIONS=--max-old-space-size=2048 \
    PNPM_VERIFY_DEPS_BEFORE_RUN=false

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/shared/package.json packages/shared/
COPY packages/auth/package.json packages/auth/
COPY packages/billing/package.json packages/billing/
COPY packages/notifications/package.json packages/notifications/
COPY packages/reporting/package.json packages/reporting/
RUN pnpm install --frozen-lockfile --filter @guestpost/api...

COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @guestpost/database exec prisma generate \
 && pnpm --filter @guestpost/api... build

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=builder /repo .
EXPOSE 4000
# Fail-fast env validation runs at boot (DATABASE_URL, REDIS_URL, JWT_SECRET,
# QUEUE_SIGNING_SECRET, TRUSTED_ORIGINS are required in production).
CMD ["node", "apps/api/dist/main.js"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/v1/health || exit 1
