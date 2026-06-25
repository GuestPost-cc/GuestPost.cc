/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependencies cause unpredictable build order, " +
        "harder-to-refactor modules, and can mask architectural rot. " +
        "Break the cycle by extracting the shared concern into a new module.",
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Orphaned modules are dead code. They may have been replaced, " +
        "moved, or were never finished. Review and either reintegrate " +
        "or delete.",
      from: {
        orphan: true,
        pathNot: [
          "\\.d\\.ts$",
          "\\.config\\.(ts|js|mjs)$",
          "next\\.config\\.ts$",
          "sentry\\.client\\.config\\.ts$",
          "instrumentation\\.ts$",
          "playwright\\.config\\.ts$",
        ],
      },
      to: {},
    },
    {
      name: "no-cross-app-deps",
      severity: "error",
      comment:
        "Applications must not depend on each other. Shared code " +
        "belongs in packages/. If an app needs code from another app, " +
        "extract it into a shared package.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/(?!\\1)([^/]+)/" },
    },
    {
      name: "no-app-dep-on-scripts",
      severity: "error",
      comment:
        "Scripts are standalone utilities. Applications should not " +
        "import from scripts/. Move shared logic into packages/.",
      from: { path: "^(apps|packages)/" },
      to: { path: "^scripts/" },
    },
    {
      name: "no-app-dep-on-e2e",
      severity: "error",
      comment:
        "E2e test helpers and fixtures must not leak into application " +
        "code. Keep them isolated.",
      from: { path: "^(apps|packages)/" },
      to: { path: "^e2e/" },
    },
    {
      name: "no-ui-dep-on-database",
      severity: "error",
      comment:
        "Frontend packages must not import the database package " +
        "directly. Use API client packages instead.",
      from: { path: "^(apps/(portal|admin|publisher|website)|packages/ui)/" },
      to: {
        path: "^packages/database/",
        pathNot: "^packages/database/src/prisma/",
      },
    },
    {
      name: "no-package-dep-on-app",
      severity: "error",
      comment:
        "Shared packages must not depend on application packages. " +
        "This would create an inverted dependency.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    exclude: {
      path: [
        "\\.d\\.ts$",
        "\\.json$",
        "\\.md$",
        "\\.css$",
        "node_modules",
        "\\.next",
        "dist",
        "\\.turbo",
      ],
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "default"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
}
