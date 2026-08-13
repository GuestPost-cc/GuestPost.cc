import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import {
  createSourceFile,
  isImportDeclaration,
  isStringLiteral,
  ScriptTarget,
} from "typescript"

// This is deliberately a narrow static boundary, not a runtime-lane contract.
// Runtime composition is covered behaviorally in worker-runtime.spec.ts. A
// top-level integration import would still construct secret-dependent adapters
// before a lane is selected, so keep that single forbidden-import assertion.
test("the worker entrypoint does not statically import integration workers", () => {
  const source = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8")
  const syntax = createSourceFile("index.ts", source, ScriptTarget.Latest, true)
  const staticImports = syntax.statements
    .filter(isImportDeclaration)
    .map((declaration) => declaration.moduleSpecifier)
    .filter(isStringLiteral)
    .map((specifier) => specifier.text)

  assert.equal(staticImports.includes("@guestpost/integrations/workers"), false)
})
