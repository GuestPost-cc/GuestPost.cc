# Repository Hardening Report

> Generated: 2026-06-26
> Phase: DevEx Hardening (11 commits)

## Summary

The Repository Hardening phase delivered 11 commits of pure tooling,
documentation, and governance — zero runtime behaviour changes.

## Commits

| # | Commit | Files | Description |
|---|--------|-------|-------------|
| 0 | `227bf76` | 1 | **Repository Contract** — `docs/REPOSITORY_CONTRACT.md`, 20 sections |
| 1 | `bef30eb` | 3 | **Repository Configuration** — `.editorconfig`, `.gitattributes`, `docs/vscode-recommendations.md` |
| 2 | `da6e96e` | 5 | **Toolchain** — Biome 2.5, ESLint split, `docs/TOOLCHAIN.md` |
| 2.5 | `bcc8411` | 487 | **Normalization** — One-time Biome format pass, suppressed pre-existing patterns, security fix |
| 3 | `1e8a246` | 8 | **Guardrails** — dependency-cruiser, `repo:health`, `repo:check`, CI updates, circular dep fix |
| 4 | `6ab1996` | 8 | **Scripts** — setup, doctor, verify, clean, reset, check |
| 5 | `90e86e6` | 4 | **Hooks** — Husky + lint-staged pre-commit |
| 6 | `5a1d707` | 6 | **Governance** — CODEOWNERS, Dependabot, issue/PR templates, `GOVERNANCE.md` |
| 7 | `57dc295` | 4 | **ADRs** — `docs/adr/0001`–`0004` |
| 8 | `e470be2` | 4 | **Developer Docs** — CONTRIBUTING, SETUP, DEVELOPMENT, STRUCTURE |
| 9 | `6492fad` | 5 | **Reference Docs** — CODING_STANDARDS, TESTING, CI, CROSS_PLATFORM, MANIFEST |
| 10 | `5ddd276` | 2 | **Operations Docs** — SECURITY_GUIDELINES, DEPENDENCY_POLICY |
| **Total** | – | **537** | |

## Key deliverables

### Tooling
- Biome replaces Prettier for formatting (single binary, ~10x faster)
- ESLint retained for React Hooks + type-aware TS rules (with exit strategy)
- dependency-cruiser enforces 8 architecture boundary rules
- Husky + lint-staged for sub-20s pre-commit hooks
- `pnpm check` runs full gate in ~7s

### Architecture fixes
- Broken circular dependency: `packages/api-client/src/auth-redirect.ts` ↔ `client.ts`
- Fixed: `no-non-null-asserted-optional-chain` in `apps/portal/.../organization/page.tsx`

### Developer experience
- 6 Node.js scripts (setup, doctor, verify, clean, reset, check)
- Comprehensive developer documentation (14 new docs)
- ADR framework with 4 initial records
- CODEOWNERS + Dependabot + issue/PR templates

### CI
- Biome check added to all CI pipelines
- dependency-cruiser step added to all CI pipelines
- Expanded `globalEnv` in turbo.json

## State of the repository

| Metric | Before | After |
|--------|--------|-------|
| Formatter | Prettier | Biome |
| Lint tool | ESLint only | Biome + ESLint |
| Dependency checks | None | dependency-cruiser |
| Pre-commit hooks | None | Husky + lint-staged |
| Dev scripts | Shell scripts | Node.js scripts (cross-platform) |
| Developer docs | Minimal | 14 docs + 4 ADRs |
| CI checks | typecheck + lint + build | + Biome + dep-cruiser |
| Circular deps | Unknown | 0 (verified) |
| Governance | None | CODEOWNERS + Dependabot + templates |

## Future recommendations

1. **Enable ESLint type-aware rules** — requires a `tsconfig.json` project
   reference. Currently deferred to avoid noise.
2. **Reduce Biome suppressions** — as code areas are refactored, remove
   the corresponding `"off"` suppressions in `biome.json`.
3. **ESLint exit** — when Biome supports React Hooks rules and type-aware
   linting, remove ESLint entirely (see `docs/TOOLCHAIN.md`).
4. **Address open findings** — #5 (startup race), #6 (CI template DB),
   #7 (Prisma pool sizing).
