# Coding Standards

## TypeScript

- Strict mode enabled (`tsconfig.base.json`).
- Prefer `interface` over `type` for object shapes.
- Use `type` for unions, intersections, and utility types.
- No `any` — use `unknown` and type guards when the type is genuinely dynamic.
- Use `const` assertions (`as const`) for literal types and tuples.

## React

- Use functional components with hooks.
- Server components by default in Next.js app router; add `"use client"` only
  when interactivity is required.
- Use `cn()` from `@guestpost/ui` for conditional class names.
- Prefer `cva()` for component variants.

## Naming

- Files: `kebab-case.ts`, `PascalCase.tsx` for components.
- Exports: named exports only (no `export default` function components —
  use `export default` for pages and layouts in Next.js app router).
- Variables/functions: `camelCase`.
- Classes/types/interfaces: `PascalCase`.
- Constants: `UPPER_SNAKE_CASE` for magic values, `camelCase` for module-level
  constants that aren't truly constant.

## Imports

- Group: external → internal → relative.
- Sort within groups alphabetically.
- Biome organises imports automatically on save (via `assist.actions.source.organizeImports`).

## Formatting

- Handled entirely by Biome. See `biome.json` for exact settings.
- Formatting is frozen after the Repository Hardening phase — no
  repository-wide format changes.
- Formatting changes only accompany the code they modify.

## Linting

- Biome: general linting (recommended preset).
- ESLint: React Hooks rules only (until Biome replaces them).
- See `docs/TOOLCHAIN.md` for the full division of labour.
