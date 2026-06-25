# Toolchain

## Overview

The repository uses a two-tier toolchain optimized for speed, correctness,
and minimal configuration surface:

| Concern | Tool | Why |
|---------|------|-----|
| Formatting | **Biome** | Single binary, fast, zero config drift |
| Import sorting | **Biome** | Built-in `organizeImports` |
| General linting | **Biome** | ~150 rules, most of `eslint:recommended` |
| Type-aware linting | **ESLint** | `typescript-eslint` with project graph |
| React Hooks linting | **ESLint** | `rules-of-hooks` (not in Biome yet) |
| Type checking | **TypeScript** (`tsc --noEmit`) | Via Turbo |
| Bundling | **Next.js** / **tsc** / **NestJS** | Per-package |

## Why ESLint still exists

Biome does not yet support:

- **Type-aware lint rules** — e.g., `@typescript-eslint/no-floating-promises`,
  `@typescript-eslint/no-misused-promises`, `@typescript-eslint/strict-boolean-expressions`.
  These require a TypeScript project graph, which Biome intentionally avoids
  for performance reasons.
- **React Hooks rules** — `rules-of-hooks` is the only active ESLint rule.
  `exhaustive-deps` is deferred (see `eslint.config.mjs`).
- **Framework-specific plugins** — `@next/eslint-plugin-next`,
  `eslint-plugin-tailwindcss`, etc. Not yet enabled.

## ESLint exit strategy

As Biome adds replacement rules, remove the corresponding ESLint rule and
its dependencies. Check availability at each major dependency upgrade:

1. `eslint-plugin-react-hooks/rules-of-hooks` — tracked upstream
   ([biome#2595](https://github.com/biomejs/biome/issues/2595))
2. `typescript-eslint` type-aware rules — Biome design doc
   ([biome#3276](https://github.com/biomejs/biome/issues/3276))

When all ESLint rules are removed:

- Delete `eslint.config.mjs`
- Remove `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks` from
  `devDependencies`
- Remove `"lint"` script from root `package.json`
- Simplify CI by removing the ESLint step
- Update `docs/vscode-recommendations.md` to demote ESLint extension

## Commands

| Command | What it does |
|---------|-------------|
| `pnpm lint` | ESLint only (React Hooks + type-aware rules) |
| `pnpm lint:format` | Biome check (format + lint + imports, read-only) |
| `pnpm format` | Biome auto-fix (format + lint + organize imports) |
| `pnpm typecheck` | `tsc --noEmit` via Turbo |
| `pnpm build` | Build all packages via Turbo |
| `pnpm check` | (future) Combined CI gate — see docs/ |

> Biome and ESLint rules overlap on several categories (unused vars,
> no-console, explicit-any). When both fire, fix the ESLint warning
> first — it typically has more context. Over time, disable the ESLint
> rule once Biome's equivalent is stable.

## Configuration files

- `biome.json` — Biome configuration (format, lint, organize imports)
- `eslint.config.mjs` — ESLint flat config (hooks, TS-aware rules)
- `.editorconfig` — Editor baseline (indent, EOL, charset)
- `tsconfig.base.json` — Shared TypeScript compiler options
- `.prettierrc` — NOT PRESENT. Biome replaces Prettier entirely.
