# GuestPost.cc Repository Contract

This document is the **constitution** of the GuestPost.cc repository. Every change — whether made by a human contributor or an automated agent — must comply with the rules defined here.

---

## 1. Project Philosophy

GuestPost.cc is a production monorepo with financial, marketplace, and multi-tenant systems. **Correctness is non-negotiable.** Every tool, script, and document added to this repository must exist to improve developer experience, maintainability, or repository governance — never at the expense of runtime behavior.

---

## 2. Repository Invariants

These invariants **must never** be violated:

| Invariant | Enforcement |
|-----------|-------------|
| Runtime behavior is identical before and after every commit | Commit Gate + review |
| Business logic is never modified | Commit Gate + review |
| Financial calculations are never modified | Commit Gate + review |
| Security, auth, RBAC are never modified | Commit Gate + review |
| Database schema and migrations are never modified | Commit Gate + review |
| API contracts (endpoints, DTOs, response shapes) are never modified | Commit Gate + review |
| Test assertions are never modified | Review |
| Every commit is independently revertible | Review |
| Every commit leaves the repository in a green state | Commit Gate |

---

## 3. Allowed vs Forbidden Changes

### Allowed

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

- Runtime application code (controllers, services, guards, interceptors, modules, providers)
- Business logic (order, marketplace, publisher, settlement, payout, verification workflows)
- Financial logic (wallet, fees, commissions, accounting, reconciliation, refunds, version locking, idempotency)
- Security logic (auth, RBAC, permissions, encryption, JWT, Better Auth, audit logging, secrets)
- Database schema (Prisma models, migrations, indexes, constraints)
- API contracts (endpoints, DTOs, response/request structures)
- Test assertions or business expectations
- Source file moves, renames, or reorganization
- Dependency upgrades outside the approved freeze
- Performance optimization
- Architecture refactors

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
| Change a NestJS service | ❌ |
| Modify a Prisma model | ❌ |
| Add a new API endpoint | ❌ |
| Fix a lint warning in application code | ❌ |
| Rename a package | ❌ |
| Move source files to a different directory | ❌ |
| Upgrade Next.js or NestJS | ❌ |
| Modify test assertions | ❌ |

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

## 7. Dependency Freeze

During the Repository Hardening phase, **no dependency upgrades** are permitted except:

- Biome
- Husky
- lint-staged
- dependency-cruiser
- Editor tooling (`.editorconfig`, `.gitattributes`, etc.)

All other dependency changes are out of scope.

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
