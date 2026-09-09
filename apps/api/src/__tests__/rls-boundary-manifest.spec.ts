import fs from "node:fs"
import path from "node:path"
import { RLS_BOUNDARY_MODELS, RLS_MODEL_NAMES } from "@guestpost/database"

const schemaPath = path.resolve(
  __dirname,
  "../../../../packages/database/prisma/schema.prisma",
)

function schemaModels(): string[] {
  const schema = fs.readFileSync(schemaPath, "utf8")
  return [...schema.matchAll(/^model\s+([A-Za-z][A-Za-z0-9_]*)\s*{/gm)].map(
    (match) => match[1],
  )
}

describe("full RLS boundary manifest", () => {
  it("classifies every Prisma model exactly once", () => {
    const models = schemaModels()
    expect(models).toHaveLength(99)
    expect(new Set(RLS_MODEL_NAMES).size).toBe(RLS_MODEL_NAMES.length)
    expect([...RLS_MODEL_NAMES].sort()).toEqual(models.sort())
  })

  it("keeps authentication and authority roots explicit", () => {
    expect(RLS_BOUNDARY_MODELS.identity).toEqual(
      expect.arrayContaining([
        "User",
        "Session",
        "Account",
        "Verification",
        "ActiveContext",
      ]),
    )
    expect(RLS_BOUNDARY_MODELS.authority).toEqual(
      expect.arrayContaining([
        "Membership",
        "PublisherMembership",
        "StaffMembership",
      ]),
    )
  })
})
