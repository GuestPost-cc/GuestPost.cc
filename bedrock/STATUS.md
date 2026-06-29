---
note_type: knowledge-status
project: guestpost-platform
profile_hint: hybrid
ontology_model: 2
real_knowledge_path: /Users/shohan/Desktop/GuestPost/guestpost-platform/bedrock
local_pointer_path: ./bedrock
onboarding: complete
last_bootstrap: 2026-06-09T00:13:59Z
last_backfill_import: 2026-06-29
last_audit: 2026-06-29 (18/41 numbered findings closed — 19 open, 0 partial, 4 unchecked — see §12 remediation log for per-finding breakdown)
prior_audit: 2026-06-15 (31/31 closed 100%)
last_compaction: 2026-06-11
last_validation: 2026-06-28
last_validation_result: valid
last_doctor: 2026-06-28
last_doctor_result: healthy
framework_version: 0.4.16
last_system_refresh: 2026-06-28T18:00:00Z
---

# Knowledge Status: guestpost-platform

## Current State

- Profile hint: `hybrid`
- Ontology model: `2`
- Real knowledge path: `/Users/shohan/Desktop/GuestPost/guestpost-platform/bedrock`
- Local pointer path: `./bedrock`
- Onboarding: `complete`

## Activity

- Last bootstrap: `2026-06-09T00:13:59Z`
- Last backfill/import: `2026-06-11`
- Last project sync: `2026-06-29T11:32:21Z`
- Last phase landed: `Phase 8.10 — settlement TOCTOU guard + CSRF middleware + support ticket cap` on 2026-06-29
- **⚠️ Correction**: The audit header claimed 41/41 closed. Systematic codebase verification on 2026-06-29 found only **18 confirmed closed**, **19 still open**, **0 partial**, and **4 unchecked** (out of 41 numbered findings). STATUS.md and NOW.md updated accordingly.
- Last compaction: `2026-06-11`
- Last validation: `2026-06-11` (`valid`)
- Last doctor: `2026-06-11` (`healthy`)

## Health Warnings

- None.

## Historical Notes

- **Bedrock → OpenViking migration**: `scripts/migrate-bedrock.sh` existed to import
  Bedrock content into OpenViking for external knowledge indexing. It was a one-time
  migration utility and was intentionally removed from the repository after use.
  If a future migration is required, the script can be recovered from Git history
  (for example, `git show <commit>:scripts/migrate-bedrock.sh`) or reimplemented against the current
  OpenViking API.
