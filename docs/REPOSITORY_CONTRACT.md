# GuestPost.cc Repository Contract

This document is the engineering contract of the GuestPost.cc repository.
Every change—whether made by a human contributor or an automated agent—must
comply with it.

The original version of this document described a time-bounded repository
normalization freeze. Its blanket ban on runtime, security, schema, test, and
API changes is no longer a valid global rule: it would prohibit necessary
security and correctness fixes. Authorized product work may change those
surfaces when the change is scoped, reviewed, tested, documented, and
operationally reversible.

---

## 1. Project Philosophy

GuestPost.cc is a production monorepo with financial, marketplace, and multi-tenant systems. **Correctness is non-negotiable.** Every tool, script, and document added to this repository must exist to improve developer experience, maintainability, or repository governance — never at the expense of runtime behavior.

---

## 2. Repository Invariants

These invariants **must never** be violated:

| Invariant | Enforcement |
|-----------|-------------|
| Runtime changes are intentional, scoped, and covered by tests | CI + review |
| Business behavior has one documented source of truth | Tests + domain docs |
| Financial changes satisfy `docs/FINANCIAL_INVARIANTS.md` | PostgreSQL/provider evidence + Finance/Security review |
| Security, auth, and RBAC changes fail closed and never rely on client-only controls | Security tests + review |
| Schema changes are additive or use a two-release expand/contract plan | Migration replay + review |
| API contract changes preserve compatibility or have an explicit version/deprecation plan | Contract tests + review |
| Tests describe intended behavior and are never weakened merely to obtain a pass | Review |
| Application rollback remains possible after additive schema deployment | Release review |
| Every commit leaves the repository in a green state | Commit Gate |

---

## 3. Allowed vs Forbidden Changes

### Allowed

- Authorized runtime, business, financial, security, schema, and API fixes that
  satisfy their domain contracts and release gates
- Documentation (`.md` files)
- Developer tooling (scripts, configs)
- Formatting configuration (Biome, Prettier-compatible rules)
- Editor configuration (`.editorconfig`, `.gitattributes`)
- GitHub templates (issues, PRs, CODEOWNERS, Dependabot)
- CI repository-quality checks (not deployment behavior)
- Helper scripts (Node.js/TypeScript, cross-platform)
- Setup, validation, and health-check tooling
- Repository governance documents
- Dependency boundary tooling (dependency-cruiser)

### Forbidden

- Unrequested or unrelated behavior changes
- Weakening authentication, authorization, tenant isolation, auditability,
  idempotency, financial evidence, or reconciliation
- Destructive financial-data migrations without an approved expand/contract
  and recovery plan
- Direct production balance edits presented as a normal repair workflow
- Removing or relaxing test assertions merely to make a change pass
- Exposing credentials, private provider payloads, payout details, or personal
  data in source, logs, fixtures, screenshots, or public responses
- Repository-wide formatting, file moves, or refactors bundled into a
  functional fix without explicit scope
- Dependency changes that bypass `docs/DEPENDENCY_POLICY.md`

---

## 4. Litmus-Test Table

When considering a change, check this table:

| Change | Allowed? |
|--------|----------|
| Add a README to a package | ✅ |
| Fix a typo in documentation | ✅ |
| Add a setup script | ✅ |
| Add a health-check script | ✅ |
| Configure Biome formatting | ✅ |
| Add `.editorconfig` | ✅ |
| Add GitHub issue templates | ✅ |
| Add CODEOWNERS | ✅ |
| Add dependency-cruiser rules | ✅ |
| Run Biome format across the repository | ✅ (once, in Commit 2.5) |
| Add a pre-commit hook | ✅ |
| Add a CI repository check | ✅ |
| Fix a NestJS money-state bug with evidence-backed tests | ✅ |
| Add an additive Prisma model/migration for an authorized feature | ✅ |
| Add or retire an API endpoint with contract and rollout coverage | ✅ |
| Change financial behavior without PostgreSQL regression tests | ❌ |
| Weaken an assertion to conceal a regression | ❌ |
| Rename or move unrelated source during a bug fix | ❌ |
| Upgrade dependencies outside the dependency policy | ❌ |

---

## 5. Cross-Platform Mandate

Every new script or tool **must** work on:

- Windows
- Windows + WSL
- macOS (Intel + Apple Silicon)
- Linux (x86_64 + aarch64)

**Do not** use Bash-only constructs. Prefer:

- Node.js
- TypeScript
- tsx
- cross-env
- rimraf
- shx

**Do not** require GNU utilities (`grep`, `sed`, `awk`, `find`).

---

## 6. Lockfile Policy

- Every `package.json` change **must** be accompanied by a corresponding `pnpm-lock.yaml` update.
- No `package.json` may be committed without an updated lockfile.
- Lockfile-only changes are forbidden unless intentionally updating dependencies (governed by the dependency freeze).

---

## 7. Dependency policy

The historical Repository Hardening dependency freeze is complete. Dependency
changes now follow `docs/DEPENDENCY_POLICY.md`, the lockfile policy above, CI
advisory floors, compatibility cohorts, and code-owner review.

---

## 8. Git History Policy

After Repository Normalization (Commit 2.5):

- No repository-wide formatting commits.
- No repository-wide import sorting commits.
- No whitespace-only PRs.
- Formatting changes should only occur in files being modified for other reasons.

---

## 9. Architecture Boundary Principles

- Applications never import other applications.
- Packages never import applications.
- The `database` package is infrastructure only — no app code may depend on Prisma internals directly.
- `shared` packages never depend on applications.
- Dependency direction always flows **inward**: apps → packages → infrastructure.

These principles are enforced by `dependency-cruiser` and verified by `pnpm repo:check`.

---

## 10. Repository Structure

- Application source files, packages, and modules must **not** be moved, renamed, or reorganized.
- Repository hardening is not a restructuring effort.
- Moving files solely for aesthetic reasons is **prohibited**.

---

## 11. Pre-Commit Hook Policy

- Hooks must complete in **under 20 seconds** on a typical feature branch.
- Hooks may only run: Biome formatting, ESLint (retained rules), and typecheck on changed packages.
- Hooks must **never** run: full test suites, Docker commands, or builds.

---

## 12. AI Scope Freeze

If unrelated improvements are discovered during execution, record them in `docs/TODO_REPOSITORY.md`. Do **not** implement them. Do **not** expand scope. Do **not** create additional commits.

---

## 13. Rollback Requirements

- Every commit must be **independently revertible**.
- No commit may depend on an unfinished later commit.
- Each commit must leave the repository in a **green state** (Commit Gate passes).
- If validation fails: **stop immediately**, fix within the current commit, never continue to later commits with a failing repository.

---

## 14. Stop Conditions

Execution must **stop immediately** if any of the following occur:

1. A change requires modifying runtime application code.
2. A change requires modifying Prisma schema or migrations.
3. A dependency upgrade outside the approved freeze becomes necessary.
4. A repository script cannot be implemented in a cross-platform manner.
5. Validation cannot be restored without violating this contract.

In any of those cases: **stop**, explain the issue, propose options, and wait for approval. Do not improvise workarounds.

---

## 15. Definition of Done (Every Commit)

Before a commit is considered complete:

- [ ] Commit Gate passes (see §17)
- [ ] Independently revertible
- [ ] Independently reviewable
- [ ] Documentation updated if required
- [ ] No runtime behavior changes
- [ ] No TODOs introduced
- [ ] No disabled checks
- [ ] No commented-out code
- [ ] No temporary workarounds

---

## 16. Commit Template

Every commit follows this exact process:

1. **Explain** WHY this commit exists.
2. **List** files that will change.
3. **Make** the changes.
4. **Run** Commit Gate validation.
5. **Report** results.
6. **Commit** only if validation passes.
7. **Summarize** what changed.
8. **Continue** to next commit (numerical order only).

---

## 17. Validation Gates

### Commit Gate (every commit)

```
pnpm biome check .
pnpm lint
pnpm typecheck
pnpm build
pnpm repo:health
```

`pnpm install` is only run when `package.json` or `pnpm-lock.yaml` changes.

### Phase Gate (after major milestones or before merging)

```
pnpm test
```

### Final Gate (before PR merge)

```
pnpm install --frozen-lockfile
pnpm biome check .
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm repo:health
pnpm repo:check
```

---

## 18. Repository Evolution Policy

Every PR must satisfy exactly **one** of these categories:

| Category | Description |
|----------|-------------|
| **Feature** | New capability |
| **Bug Fix** | Corrects a defect |
| **Security** | Addresses a vulnerability |
| **Performance** | Improves speed or resource usage |
| **Developer Experience** | Improves tooling, scripts, DX |
| **Documentation** | README, guides, standards |
| **Infrastructure** | CI/CD, Docker, deployment |
| **Dependencies** | Upgrade or swap of dependencies |

If a PR spans multiple categories, it should normally be split.

---

## 19. Execution Order

Commits must be completed **strictly in numerical order**. Do not skip ahead. Do not begin the next commit until the current commit passes its Commit Gate validation and has been committed.

---

## 20. Documentation Hierarchy

```
docs/             Quick-start, developer onboarding, practical usage
  |
docs/adr/         Decision summaries (links to bedrock for depth)
  |
bedrock/          Deep architecture, audits, history, detailed decisions
```

**Never duplicate bedrock content. Reference it.**
