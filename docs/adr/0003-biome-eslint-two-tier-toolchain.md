# ADR 0003: Biome + ESLint Two-Tier Toolchain

**Status:** Accepted
**Date:** 2026-06-26
**Context:** The project needs code formatting, linting, and import
organisation. Previously relied on ESLint for everything (formatting
via Prettier + ESLint via recommended rules). Prettier introduces
config drift and slower formatting.
**Decision:** Use Biome as the primary toolchain for formatting,
general linting, and import organisation. Retain ESLint only for rules
Biome cannot yet replace: React Hooks (`rules-of-hooks`) and
type-aware TypeScript rules. See `docs/TOOLCHAIN.md` for the detailed
division of labour and ESLint exit strategy.
**Consequences:**
- Positive: Single binary for formatting + linting, ~10x faster than
  Prettier + ESLint, no config drift between tools.
- Negative: ESLint remains as a secondary dependency. Some rules may
  overlap — fixed by suppressing the ESLint equivalent when Biome's
  version is stable.
- See `docs/TOOLCHAIN.md` for the full ESLint exit strategy.
