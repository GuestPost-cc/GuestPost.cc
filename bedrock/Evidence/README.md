# Historical Evidence

Files in this directory are point-in-time audit artifacts. They are retained for
traceability, but their verdicts describe the cited commit and date only. They
must not be used as evidence that the current branch, current database, or
deployed production system is safe.

For current financial controls and release gates, use:

- `bedrock/Memory/billing-payments.md`
- `bedrock/Memory/publisher-payouts.md`
- `docs/FINANCIAL_INVARIANTS.md`
- `docs/PRODUCTION_RUNBOOK.md`
- `docs/FINANCIAL_INCIDENT_QUERIES.md`

Before a money-flow release, rerun the current automated suites, rehearse all
migrations on a recent sanitized production clone, verify that no PostgreSQL
constraint remains unvalidated, and record the exact commit and evidence.
