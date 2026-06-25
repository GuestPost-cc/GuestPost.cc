# ADR 0001: Record Architecture Decisions

**Status:** Accepted
**Date:** 2026-06-26
**Context:** The project needs a lightweight process for recording
architecturally significant decisions so that future contributors can
understand why the system is the way it is.
**Decision:** Use Architecture Decision Records (ADRs) as described by
Michael Nygard. Each ADR is a short markdown file in `docs/adr/` with a
unique sequential number.
**Consequences:**
- Positive: Clear audit trail of decisions, onboarding aid, bias for
  explicit deliberation over implicit choices.
- Negative: Overhead of writing ADRs for every change — mitigated by
  only requiring ADRs for decisions that are costly to reverse.
