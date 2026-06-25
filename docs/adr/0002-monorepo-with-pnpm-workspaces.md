# ADR 0002: Monorepo with pnpm Workspaces

**Status:** Accepted
**Date:** 2026-06-26
**Context:** The project consists of multiple applications (portal,
publisher, admin, website, API, worker) and shared libraries (UI, shared,
database, auth, API client). Each needs independent versioning, build
pipelines, and deployment.
**Decision:** Use a pnpm workspace monorepo with Turborepo for task
orchestration. All packages live under `apps/` and `packages/`.
**Consequences:**
- Positive: Single source of truth for dependency versions, shared
  toolchain config, atomic cross-package refactors.
- Negative: Monorepo requires discipline around dependency boundaries
  (enforced by dependency-cruiser), larger `pnpm install` surface area,
  and more complex CI.
- Mitigation: Strict architecture boundaries enforced by
  dependency-cruiser (see `.dependency-cruiser.js`).
