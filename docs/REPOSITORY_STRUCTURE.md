# Repository Structure

```
.
├── apps/                       # Application packages
│   ├── admin/                  #   Admin dashboard (Next.js)
│   ├── api/                    #   NestJS API server
│   ├── portal/                 #   Customer portal (Next.js)
│   ├── publisher/              #   Publisher dashboard (Next.js)
│   ├── website/                #   Public website (Next.js)
│   └── worker/                 #   Background job worker
├── packages/                   # Shared packages
│   ├── api-client/             #   HTTP client for GuestPost API
│   ├── auth/                   #   Auth utilities + middleware
│   ├── database/               #   Prisma schema + generated client
│   ├── shared/                 #   Shared utilities, types, config
│   └── ui/                     #   Shared React component library
├── scripts/                    # Developer scripts
├── e2e/                        # Playwright E2E tests
├── infrastructure/             # Docker compose, deployment configs
├── docs/                       # Developer documentation
│   ├── adr/                    #   Architecture Decision Records
│   └── *.md                    #   Topical docs
├── bedrock/                    # AI-agent project cockpit (see below)
├── .github/                    # GitHub Actions, templates, CODEOWNERS
├── biome.json                  # Biome toolchain config
├── eslint.config.mjs           # ESLint config (React Hooks + TS rules)
├── .dependency-cruiser.js      # Dependency graph rules
├── turbo.json                  # Turborepo task orchestration
├── lint-staged.config.js       # Pre-commit hook tasks
└── package.json
```

## Design principles

- Apps depend on packages, never on other apps.
- Packages never depend on apps.
- UI packages never depend on `packages/database` directly.
- Scripts and E2E tests are standalone — never imported by apps.

## The `bedrock/` directory

`bedrock/` is an AI-agent project cockpit. It contains:
- `Memory/` — Durable project knowledge (architecture, decisions, data model)
- `Work/` — Current priorities, open questions, backlog
- `Views/` — Generated inspection views (audits, graphs)

Do not duplicate `bedrock/` content in `docs/`. Reference it instead.
