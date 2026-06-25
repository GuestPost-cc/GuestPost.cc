# ADR 0004: Repository Hardening Phase

**Status:** Accepted
**Date:** 2026-06-26
**Context:** The repository grew organically through multiple feature
phases. Tooling, documentation, and governance were deferred in favour
of shipping. This created friction for new contributors, inconsistent
code style, no dependency governance, and no architecture enforcement.
**Decision:** Execute a dedicated DevEx phase (11 commits) to harden
the repository without changing any runtime behaviour. All changes are
pure tooling, documentation, and configuration.
**Consequences:**
- Positive: Consistent formatting, import sorting, linting,
  dependency graph enforcement, pre-commit hooks, developer scripts,
  ADRs, governance model, comprehensive docs.
- Negative: 11 commits of only meta-work — no feature value delivered.
  Large diff from the one-time Biome format pass risks merge conflicts
  with in-flight branches.
- Mitigation: All commits are independently revertible. The
  Repository Contract (`docs/REPOSITORY_CONTRACT.md`) freezes
  formatting after the normalisation pass.
