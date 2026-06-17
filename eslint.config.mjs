// Phase 7.9 #30 — ESLint flat config (ESLint 9).
//
// Tight rule set on purpose:
//   - @eslint/js recommended (basic correctness)
//   - typescript-eslint recommended (TS-aware basics)
//   - eslint-plugin-react-hooks: ONLY rules-of-hooks
//
// Explicitly NOT enabled to avoid surfacing dozens of pre-existing
// warnings that don't belong in the Phase 7.9 PR:
//   - react-hooks/exhaustive-deps   (will surface many pre-existing
//     dependency-array misalignments — separate cleanup phase)
//   - next/core-web-vitals          (image-component nags, etc.)
//   - react/recommended             (jsx-key, no-unescaped-entities, etc.)
//   - Tailwind plugins              (className ordering)
//
// Future expansion is one config edit — when we're ready for a broader
// sweep, add the rule packs above + fix the surfaced violations as a
// dedicated PR.

import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"

export default tseslint.config(
  // 0. Ignore generated + vendored + build output.
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/packages/database/src/prisma/**", // Prisma-generated source
    ],
  },

  // 1. JS baseline.
  js.configs.recommended,

  // 2. TS baseline (uses typescript-eslint recommended config — does not
  //    require a tsconfig project graph, so it stays fast for monorepo
  //    lint runs).
  ...tseslint.configs.recommended,

  // 3. react-hooks/rules-of-hooks ONLY. exhaustive-deps deliberately off.
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Disable a few TS rules that flag pre-existing patterns we
      // don't want to touch in this PR. Keep the list small and
      // explicit so we know what we're choosing to defer.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "no-empty": "off",
      "no-empty-pattern": "off",
      "no-useless-escape": "off",
      "no-prototype-builtins": "off",
      "no-control-regex": "off",
      "no-async-promise-executor": "off",
      "no-cond-assign": "off",
      "no-undef": "off",        // TS handles this; plain JS files trip on globals
      "no-redeclare": "off",    // overload-style ts patterns
      "no-fallthrough": "off",
      "no-misleading-character-class": "off",
      "no-irregular-whitespace": "off",
      "no-self-assign": "off",
      "no-constant-binary-expression": "off",
      "no-constant-condition": "off",
      "no-sparse-arrays": "off",
      "no-useless-catch": "off",
    },
  },
)
