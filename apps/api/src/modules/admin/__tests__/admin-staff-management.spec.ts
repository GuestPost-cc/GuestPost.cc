import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common"
import { AdminService } from "../admin.service"

jest.mock("@better-auth/utils/password", () => ({
  hashPassword: jest.fn().mockResolvedValue("hashed-password"),
}))

jest.mock("../../../common/auth-context-cache", () => ({
  invalidateAuthContext: jest.fn(),
}))

describe("AdminService staff management", () => {
  let service: AdminService
  let prisma: any
  let audit: any

  beforeEach(() => {
    audit = { log: jest.fn().mockResolvedValue(undefined) }
    prisma = {
      user: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      account: { create: jest.fn() },
      staffMembership: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      fulfillmentAssignment: { findMany: jest.fn(), count: jest.fn() },
      auditLog: { findMany: jest.fn(), groupBy: jest.fn() },
      settlementApproval: { findMany: jest.fn() },
      withdrawal: { findMany: jest.fn() },
      session: { deleteMany: jest.fn() },
      $transaction: jest.fn(),
    }
    service = new AdminService(prisma, audit, {} as any)
  })

  it("creates a credential-backed staff account without customer or publisher provisioning", async () => {
    const createdAt = new Date("2026-07-17T00:00:00.000Z")
    const user = {
      id: "staff-1",
      email: "ops@example.com",
      name: "New Ops",
      userType: "STAFF",
      banned: false,
      createdAt,
    }
    prisma.user.create.mockResolvedValue(user)
    prisma.staffMembership.create.mockResolvedValue({
      id: "membership-1",
      userId: user.id,
      role: "OPERATIONS",
    })
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    )

    const result = await service.createStaff(
      {
        email: " OPS@Example.com ",
        name: "New Ops",
        role: "OPERATIONS",
        password: "StrongPassword1!",
      },
      { id: "admin-1" },
    )

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "ops@example.com",
        emailVerified: true,
        userType: "STAFF",
      }),
    })
    expect(prisma.account.create).toHaveBeenCalledWith({
      data: {
        accountId: user.id,
        providerId: "credential",
        userId: user.id,
        password: "hashed-password",
      },
    })
    expect(prisma.staffMembership.create).toHaveBeenCalledWith({
      data: { userId: user.id, role: "OPERATIONS" },
    })
    expect(result).toEqual(expect.objectContaining({ staffRole: "OPERATIONS" }))
  })

  it("prevents a Super Admin from changing their own role", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "admin-1",
      userType: "STAFF",
    })
    prisma.staffMembership.findUnique.mockResolvedValue({
      id: "membership-1",
      role: "SUPER_ADMIN",
    })

    await expect(
      service.updateStaffRole("admin-1", "OPERATIONS", { id: "admin-1" }),
    ).rejects.toThrow(ForbiddenException)
  })

  it("prevents demoting the last active Super Admin", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "admin-1",
      userType: "STAFF",
    })
    prisma.staffMembership.findUnique.mockResolvedValue({
      id: "membership-1",
      role: "SUPER_ADMIN",
    })
    prisma.user.count.mockResolvedValue(1)

    await expect(
      service.updateStaffRole("admin-1", "FINANCE", { id: "admin-2" }),
    ).rejects.toThrow(ConflictException)
  })

  it("prevents suspending Operations staff with active assignments", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "ops-1",
      userType: "STAFF",
      banned: false,
      staffMemberships: [{ id: "membership-1", role: "OPERATIONS" }],
    })
    prisma.fulfillmentAssignment.count.mockResolvedValue(2)
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    )

    await expect(
      service.suspendUser(
        "ops-1",
        {
          reasonCode: "STAFF_ACCESS_REMOVAL",
          internalNote: "Access review requires suspension",
        },
        { id: "admin-1" },
      ),
    ).rejects.toThrow(ConflictException)
    expect(prisma.user.update).not.toHaveBeenCalled()
  })

  it("suspends atomically and revokes every active session", async () => {
    const suspendedAt = new Date("2026-07-19T12:00:00.000Z")
    prisma.user.findUnique.mockResolvedValue({
      id: "customer-1",
      userType: "CUSTOMER",
      banned: false,
      staffMemberships: [],
    })
    prisma.user.update.mockResolvedValue({
      id: "customer-1",
      banned: true,
      banReasonCode: "SECURITY_RISK",
      banExpires: null,
      suspendedAt,
    })
    prisma.session.deleteMany.mockResolvedValue({ count: 3 })
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    )

    const result = await service.suspendUser(
      "customer-1",
      {
        reasonCode: "SECURITY_RISK",
        internalNote: "Confirmed credential compromise report",
      },
      { id: "admin-1" },
    )

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "customer-1" },
        data: expect.objectContaining({
          banned: true,
          banReasonCode: "SECURITY_RISK",
          suspendedByUserId: "admin-1",
        }),
      }),
    )
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "customer-1" },
    })
    expect(result.sessionsRevoked).toBe(3)
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_SUSPENDED",
        metadata: expect.objectContaining({ sessionsRevoked: 3 }),
      }),
      prisma,
    )
  })

  it("restores access without recreating revoked sessions", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "publisher-1",
      userType: "PUBLISHER",
      banned: true,
      banReasonCode: "TERMS_VIOLATION",
      banExpires: null,
    })
    prisma.user.update.mockResolvedValue({
      id: "publisher-1",
      banned: false,
    })
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback(prisma),
    )

    await service.restoreUser(
      "publisher-1",
      { internalNote: "Compliance review completed successfully" },
      { id: "admin-1" },
    )

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          banned: false,
          banReasonCode: null,
          suspendedByUserId: null,
        }),
      }),
    )
    expect(prisma.session.deleteMany).not.toHaveBeenCalled()
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "USER_RESTORED" }),
      prisma,
    )
  })

  it("prevents an administrator from suspending their own account", async () => {
    await expect(
      service.suspendUser(
        "admin-1",
        {
          reasonCode: "STAFF_ACCESS_REMOVAL",
          internalNote: "Self suspension must never be permitted",
        },
        { id: "admin-1" },
      ),
    ).rejects.toThrow(ForbiddenException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("does not convert a customer account into a publisher", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "customer-1",
      userType: "CUSTOMER",
    })

    await expect(
      service.updateUserRole("customer-1", "PUBLISHER_OWNER", {
        id: "admin-1",
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it("does not convert a publisher account into a customer", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "publisher-1",
      userType: "PUBLISHER",
    })

    await expect(
      service.updateUserRole("publisher-1", "OWNER", { id: "admin-1" }),
    ).rejects.toThrow(BadRequestException)
  })

  it("reports Operations sales and Finance handled volume separately", async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: "ops-1",
        email: "ops@example.com",
        name: "Ops",
        banned: false,
        createdAt: new Date(),
        staffMemberships: [{ role: "OPERATIONS", permissions: [] }],
      },
      {
        id: "finance-1",
        email: "finance@example.com",
        name: "Finance",
        banned: false,
        createdAt: new Date(),
        staffMemberships: [{ role: "FINANCE", permissions: [] }],
      },
    ])
    prisma.fulfillmentAssignment.findMany.mockResolvedValue([
      {
        orderId: "order-1",
        assignedToUserId: "ops-1",
        status: "DELIVERED",
        order: { amount: 125, currency: "USD", status: "COMPLETED" },
      },
    ])
    prisma.auditLog.findMany.mockResolvedValue([
      {
        userId: "ops-1",
        metadata: {
          orderId: "order-1",
          assignedToUserId: "ops-1",
          assignedByUserId: "ops-1",
        },
      },
    ])
    prisma.auditLog.groupBy.mockResolvedValue([])
    prisma.settlementApproval.findMany.mockResolvedValue([
      {
        approvedBy: "finance-1",
        settlement: {
          grossAmount: 300,
          order: { currency: "USD" },
        },
      },
    ])
    prisma.withdrawal.findMany.mockResolvedValue([{ approvedBy: "finance-1" }])

    const result = await service.staffPerformance()
    const ops = result.items.find((item) => item.id === "ops-1")
    const finance = result.items.find((item) => item.id === "finance-1")

    expect(ops?.metrics).toEqual(
      expect.objectContaining({
        claimed: 1,
        completed: 1,
        salesByCurrency: { USD: 125 },
      }),
    )
    expect(finance?.metrics).toEqual(
      expect.objectContaining({
        financeApprovals: 1,
        financeVolumeByCurrency: { USD: 300 },
        withdrawalsApproved: 1,
      }),
    )
  })
})
