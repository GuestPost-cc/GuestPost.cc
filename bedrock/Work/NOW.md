# Current Focus
**Status: Maintenance & hardening** — RBAC audit complete, order workflow redesign implemented.

## Completed
- Full RBAC audit across 12 controllers (60+ endpoints) — Role Permission Matrix generated
- ActorTypeGuard, MemberRolesGuard, StaffRolesGuard, OrderOwnershipGuard all in place
- Business-action order endpoints replace generic PATCH /orders/:id/status (14 action endpoints)
- Settlement dual-approval (customer→admin→release) with version-based optimistic concurrency
- Platform fee standardized at 20% (was inconsistent: 10% vs 20%)
- Stripe webhook dummy mode removed (security fix C1)
- ActiveContext backfill script created at `scripts/backfill-active-context.ts`
- Shadow DB migration history fixed — `MarketplaceSavedList`/`MarketplaceSavedListItem` tables now in migration 5; all other missing tables (18) in migration 6

## Next Steps
1. Run `prisma migrate dev` to verify shadow DB no longer blocks (may still need `--create-only` or `prisma db push` on existing dev DBs)
2. Run `pnpm tsx scripts/backfill-active-context.ts` after database is migrated to populate ActiveContext for existing users
3. End-to-end multi-tenant test: create multi-org user → switch orgs → verify order isolation
4. Concurrency tests: 10 concurrent settlement approvals → exactly one succeeds
5. RBAC attack simulation: cross-org access attempts all blocked
6. Run `apps/worker` through security audit fixes (C2: verification worker auth)
