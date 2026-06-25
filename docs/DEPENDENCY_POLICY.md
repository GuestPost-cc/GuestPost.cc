# Dependency Policy

## Principles

1. **Minimal surface**: only add a dependency when the cost of writing
   and maintaining the equivalent code exceeds the cost of the dependency.
2. **Locked versions**: `pnpm-lock.yaml` is committed. All dependency
   versions are frozen at install time.
3. **No floating ranges**: dependencies use exact versions or
   caret-compatible ranges. Avoid `*` and `latest`.
4. **Vendoring**: if a dependency is small, stable, and unlikely to change,
   consider vendoring it instead of adding a package.
5. **Audit regularly**: Dependabot weekly updates + `pnpm audit` in CI.

## Allowed dependency categories

- **Runtime**: Next.js, React, NestJS, Prisma, Redis, Zod, TanStack Query,
  Sentry, date-fns.
- **Dev**: TypeScript, ESLint, Biome, Turborepo, Playwright, Vitest,
  dependency-cruiser, Husky, lint-staged.
- **Infrastructure**: Docker images (Postgres, Redis).

## Prohibited dependencies

- [Leftpad](https://en.wikipedia.org/wiki/Npm_left-pad)-style single-function
  packages (write the function yourself).
- Abandoned or unmaintained packages.
- Packages with known CVEs that lack a fix release.

## Adding a dependency

1. Evaluate: is this package well-maintained, documented, and tested?
2. Check: does it introduce transitive dependencies with build scripts?
3. Approve: PR must be reviewed by a maintainer.
4. Add: `pnpm add <package>` (for runtime) or `pnpm add -D <package>` (for dev).
5. Pin: `pnpm-lock.yaml` captures the exact version.

## Removing a dependency

When removing a dependency, also check:
- `pnpm-lock.yaml` — does the prune remove transitive deps?
- `allowBuilds` in `pnpm-workspace.yaml` — can the build approval be removed?
- `onlyBuiltDependencies` in `package.json` — can it be removed?
- CI — does the configuration reference the removed package?
