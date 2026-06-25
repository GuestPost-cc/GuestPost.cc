# VS Code Recommendations

> `.vscode/` is gitignored. This document is the canonical reference for
> recommended editor configuration.

## Extensions

### Required

| Extension | ID | Purpose |
|-----------|----|---------|
| Biome | `biomejs.biome` | Formatting + linting (primary) |
| ESLint | `dbaeumer.vscode-eslint` | ESLint integration (type-aware rules) |
| Tailwind CSS IntelliSense | `bradlc.vscode-tailwindcss` | Tailwind class completion |
| Prisma | `Prisma.prisma` | Prisma schema language support |
| Prettier | `esbenp.prettier-vscode` | Falls back when Biome cannot format (e.g., YAML, Markdown) |

### Recommended

| Extension | ID | Purpose |
|-----------|----|---------|
| Error Lens | `usernamehw.errorlens` | Inline diagnostic display |
| GitLens | `eamodio.gitlens` | Git blame annotations |
| Pretty TypeScript Errors | `yoavbls.pretty-ts-errors` | Human-readable TS error messages |
| Dotenv | `mikestead.dotenv` | `.env` syntax highlighting |
| YAML | `redhat.vscode-yaml` | YAML validation |
| JSON | `ZainChen.json` | JSON editing improvements |
| Docker | `ms-azuretools.vscode-docker` | Dockerfile + Compose support |
| GitHub Actions | `github.vscode-github-actions` | Workflow file validation |
| Playwright | `ms-playwright.playwright` | Test runner integration |

### Optional

| Extension | ID | Purpose |
|-----------|----|---------|
| Material Icon Theme | `PKief.material-icon-theme` | File icons |
| One Dark Pro | `zhuangtongfa.Material-theme` | Theme |
| Thunder Client | `rangav.vscode-thunder-client` | API testing |
| GraphQL | `graphql.vscode-graphql` | GraphQL syntax |
| Prettier | `esbenp.prettier-vscode` | Code formatter |

## Workspace Settings

Create `.vscode/settings.json` locally (gitignored):

```jsonc
{
  // Use Biome for formatting by default.
  "editor.defaultFormatter": "biomejs.biome",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.organizeImports.biome": "explicit",
    "source.fixAll.eslint": "explicit"
  },

  // ESLint: validate on save.
  "eslint.validate": [
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact"
  ],
  "eslint.run": "onType",
  "eslint.useFlatConfig": true,

  // Tailwind: autocomplete in the right contexts.
  "tailwindCSS.experimental.classRegex": [
    ["cva\\(([^)]*)\\)", "[\"'`]([^\"'`]*).*?[\"'`]"],
    ["cn\\(([^)]*)\\)", "[\"'`]([^\"'`]*).*?[\"'`]"]
  ],

  // TypeScript: use the workspace version.
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,

  // Files.
  "files.exclude": {
    "**/.next": true,
    "**/.turbo": true,
    "**/dist": true,
    "**/node_modules": true
  },
  "search.exclude": {
    "**/.next": true,
    "**/.turbo": true,
    "**/dist": true,
    "**/node_modules": true,
    "pnpm-lock.yaml": true
  }
}
```

## Extension Recommendations

Create `.vscode/extensions.json` locally (gitignored):

```jsonc
{
  "recommendations": [
    "biomejs.biome",
    "dbaeumer.vscode-eslint",
    "bradlc.vscode-tailwindcss",
    "Prisma.prisma",
    "esbenp.prettier-vscode"
  ]
}
```
