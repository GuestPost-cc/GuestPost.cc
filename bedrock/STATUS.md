---
note_type: knowledge-status
project: guestpost-platform
profile_hint: hybrid
ontology_model: 2
real_knowledge_path: /Users/shohan/Desktop/GuestPost/guestpost-platform/bedrock
local_pointer_path: ./bedrock
onboarding: complete
last_bootstrap: 2026-06-09T00:13:59Z
last_backfill_import: 2026-07-03
last_audit: 2026-07-03 (22/41 numbered findings confirmed closed — 17 open, 1 intentional, 1 documented, 3 unchecked — see §12 remediation log for per-finding breakdown; #9 DNS rebinding and #17 CI postgres drift closed via Sprint 1A/1B)
prior_audit: 2026-06-22 (41/41 "over-reported"; actual: 18/41 closed, 19 open, 4 unchecked)
last_compaction: 2026-06-11
last_validation: 2026-06-11
last_validation_result: valid
last_doctor: 2026-06-11
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
- Last project sync: `2026-07-02T22:26:38Z`
- Last phase landed: `Evidence-driven engineering assessment` on 2026-07-02 — generated automated counts, scoring rubric, risk register with file:line evidence across all 12 dimensions.
- Current audit state: **22 confirmed closed**, **17 still open**, **1 intentional**, **1 documented**, **3 unchecked** (out of 41 numbered findings). Phase A corrections applied: #8 (Redis) and #10 (Revenue SQL). Sprint 1A/1B closed #9 (DNS rebinding) and #17 (CI postgres drift).
- **⚠️ Correction**: The June-22 audit §12 remediation log had 6 stale entries (#8, #10, #16, #19, plus #9, #17 marked OPEN but CLOSED in code). The header claimed 41/41 closed; code verification found 18 confirmed closed. Post-Phase-A + Sprint 1A/1B: 22 confirmed closed.
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
