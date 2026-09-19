import fs from "node:fs"
import path from "node:path"
import {
  runWithRlsRequestScope,
  setRlsRequestContext,
} from "@guestpost/database"
import { PrismaService } from "../common/prisma.service"

const originalEnforcement = process.env.RLS_ENFORCEMENT_ENABLED

describe("Prisma RLS proxy", () => {
  beforeEach(() => {
    process.env.RLS_ENFORCEMENT_ENABLED = "true"
  })

  afterEach(() => {
    if (originalEnforcement === undefined) {
      delete process.env.RLS_ENFORCEMENT_ENABLED
    } else {
      process.env.RLS_ENFORCEMENT_ENABLED = originalEnforcement
    }
  })

  it("routes generated delegates and interactive transactions through one contextualizer", async () => {
    const service = new PrismaService()
    const findUnique = jest.fn().mockResolvedValue({ id: "user-1" })
    const orderCount = jest.fn().mockResolvedValue(2)
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      user: { findUnique },
      order: { count: orderCount },
    }
    const transaction = jest
      .spyOn(service, "$transaction")
      .mockImplementation(async (operation: any) => operation(tx) as any)
    const prisma = service.asRlsAwareClient()

    await runWithRlsRequestScope(async () => {
      setRlsRequestContext({ workload: "PUBLIC" })
      await expect(
        prisma.user.findUnique({ where: { id: "user-1" } }),
      ).resolves.toEqual({ id: "user-1" })
      await expect(prisma.$transaction((tx) => tx.order.count())).resolves.toBe(
        2,
      )
    })

    expect(transaction).toHaveBeenCalledTimes(2)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } })
    expect(orderCount).toHaveBeenCalledTimes(1)
  })

  it("rejects array-form transactions and keeps production code on interactive form", () => {
    const prisma = new PrismaService().asRlsAwareClient()
    expect(() => (prisma.$transaction as any)([])).toThrow(
      "Array-form Prisma transactions are disabled under RLS",
    )

    const sourceRoot = path.resolve(__dirname, "..")
    const files: string[] = []
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") visit(target)
        } else if (entry.name.endsWith(".ts")) {
          files.push(target)
        }
      }
    }
    visit(sourceRoot)
    const offenders = files.filter((file) =>
      /\$transaction\s*\(\s*\[/.test(fs.readFileSync(file, "utf8")),
    )
    expect(offenders).toEqual([])
  })
})
