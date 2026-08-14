import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import { HEADERS_METADATA } from "@nestjs/common/constants"
import { validate } from "class-validator"
import { ReassignTicketDto } from "../dto/reassign-ticket.dto"
import { SupportController } from "../support.controller"
import {
  buildActorSnapshot,
  resolveParticipantRole,
  type SupportActor,
  SupportService,
} from "../support.service"

const REQUEST_ID = "00000000-0000-4000-8000-000000000001"
const MESSAGE_ID = "00000000-0000-4000-8000-000000000002"

describe("reassignment command validation", () => {
  it("requires an explicit nullable expected owner", async () => {
    const missingExpectedOwner = Object.assign(new ReassignTicketDto(), {
      assignedToUserId: "ops-2",
      reason: "Move this ticket to the next Operations owner.",
    })
    const unassignedExpectedOwner = Object.assign(new ReassignTicketDto(), {
      assignedToUserId: "ops-2",
      expectedAssignedToUserId: null,
      reason: "Move this unassigned ticket to an Operations owner.",
    })

    expect(
      (await validate(missingExpectedOwner)).some(
        (error) => error.property === "expectedAssignedToUserId",
      ),
    ).toBe(true)
    await expect(validate(unassignedExpectedOwner)).resolves.toEqual([])
  })
})

const customer = (organizationId = "org-1", userId = "customer-1") =>
  ({
    userId,
    kind: "CUSTOMER",
    organizationId,
    customerRole: "OWNER",
  }) satisfies SupportActor

const publisher = (publisherId = "pub-1", userId = "publisher-1") =>
  ({
    userId,
    kind: "PUBLISHER",
    publisherId,
    publisherRole: "PUBLISHER_OWNER",
  }) satisfies SupportActor

const staff = (
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE",
  userId = staffRole === "SUPER_ADMIN"
    ? "admin-1"
    : staffRole === "OPERATIONS"
      ? "ops-1"
      : "finance-1",
) => ({ userId, kind: "STAFF", staffRole }) satisfies SupportActor

function baseTicket(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-14T10:00:00.000Z")
  return {
    id: "ticket-1",
    subject: "Order publication help",
    description: "Please help with this publication order.",
    status: "OPEN",
    organizationId: "org-1",
    userId: "customer-1",
    orderId: "order-1",
    fulfillmentChannel: "PLATFORM",
    assignedToUserId: "ops-1",
    assignedPublisherId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function userFor(id: string | null) {
  if (!id) return null
  const userType = id.startsWith("publisher")
    ? "PUBLISHER"
    : id.startsWith("customer")
      ? "CUSTOMER"
      : "STAFF"
  return {
    id,
    name: `${userType.toLowerCase()} ${id}`,
    email: `${id}@example.test`,
    userType,
    banned: false,
  }
}

function makeHarness(
  options: {
    ticket?: Record<string, any>
    messages?: Array<Record<string, any>>
    order?: Record<string, any>
    fulfillmentAssignments?: Array<Record<string, any>>
    staffRoles?: Record<string, "SUPER_ADMIN" | "OPERATIONS" | "FINANCE">
    bannedUsers?: string[]
    userTypes?: Record<string, "CUSTOMER" | "PUBLISHER" | "STAFF">
  } = {},
) {
  const ticketRows = new Map<string, any>()
  const ticket = baseTicket(options.ticket)
  ticketRows.set(ticket.id, ticket)
  const messageRows = new Map<string, any>()
  for (const message of options.messages ?? [])
    messageRows.set(message.id, message)
  const staffRoles = {
    "admin-1": "SUPER_ADMIN",
    "ops-1": "OPERATIONS",
    "ops-2": "OPERATIONS",
    "finance-1": "FINANCE",
    ...options.staffRoles,
  } as Record<string, "SUPER_ADMIN" | "OPERATIONS" | "FINANCE">
  const banned = new Set(options.bannedUsers ?? [])
  const resolveUser = (id: string | null) => {
    const user = userFor(id)
    return user && options.userTypes?.[user.id]
      ? { ...user, userType: options.userTypes[user.id] }
      : user
  }
  const order: Record<string, any> | null = options.order
    ? {
        id: "order-1",
        organizationId: "org-1",
        status: "SUBMITTED",
        fulfillmentChannel: "PLATFORM",
        website: { ownershipType: "PLATFORM", publisherId: null },
        ...options.order,
      }
    : null
  const fulfillmentAssignments = options.fulfillmentAssignments ?? []
  const audit = { log: jest.fn().mockResolvedValue(undefined) }
  const queue = { addJob: jest.fn().mockResolvedValue(undefined) }

  const enrich = (row: any) => ({
    ...row,
    user: resolveUser(row.userId),
    organization: {
      id: row.organizationId,
      name: "Example customer",
      memberships: [
        { userId: "customer-1", status: "ACTIVE" },
        { userId: "customer-2", status: "ACTIVE" },
      ],
    },
    assignedTo: row.assignedToUserId
      ? {
          id: row.assignedToUserId,
          name: resolveUser(row.assignedToUserId)?.name,
        }
      : null,
    assignedPublisher: row.assignedPublisherId
      ? {
          id: row.assignedPublisherId,
          name: "Publisher brand",
          publisherMemberships: [
            { userId: "publisher-1" },
            { userId: "publisher-2" },
          ],
        }
      : null,
    order: row.orderId
      ? {
          id: row.orderId,
          title: "Order title",
          status: order?.status ?? "SUBMITTED",
          type: "GUEST_POST",
          fulfillmentChannel:
            order?.fulfillmentChannel ?? row.fulfillmentChannel,
          website: order?.website ?? { ownershipType: "PLATFORM" },
          dispute: order?.dispute ?? null,
          fulfillmentAssignments: fulfillmentAssignments.filter((assignment) =>
            ["ASSIGNED", "IN_PROGRESS"].includes(assignment.status),
          ),
        }
      : null,
  })

  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ticket.id }]),
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const value = resolveUser(where.id)
        return value ? { ...value, banned: banned.has(where.id) } : null
      }),
    },
    membership: {
      findUnique: jest.fn(async ({ where }: any) => ({
        role: "OWNER",
        status:
          where.userId_organizationId.organizationId === "org-1"
            ? "ACTIVE"
            : "PAUSED",
      })),
    },
    publisherMembership: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.userId_publisherId.publisherId === "pub-1"
          ? { role: "PUBLISHER_OWNER" }
          : null,
      ),
    },
    staffMembership: {
      findUnique: jest.fn(async ({ where }: any) => {
        const role = staffRoles[where.userId]
        return role
          ? {
              role,
              user: {
                name: resolveUser(where.userId)?.name,
                banned: banned.has(where.userId),
                userType: resolveUser(where.userId)?.userType,
              },
            }
          : null
      }),
      findMany: jest.fn(async ({ where }: any) =>
        Object.entries(staffRoles)
          .filter(([id, role]) => role === where.role && !banned.has(id))
          .map(([userId]) => ({ userId })),
      ),
    },
    order: {
      findUnique: jest.fn(async ({ where }: any) =>
        order && where.id === order.id
          ? {
              ...order,
              fulfillmentAssignments: fulfillmentAssignments.filter(
                (assignment) =>
                  ["ASSIGNED", "IN_PROGRESS"].includes(assignment.status),
              ),
            }
          : null,
      ),
    },
    fulfillmentAssignment: {
      findFirst: jest.fn(async ({ where }: any) => {
        const statuses = Array.isArray(where.status?.in)
          ? where.status.in
          : [where.status]
        return (
          fulfillmentAssignments
            .filter(
              (assignment) =>
                assignment.orderId === where.orderId &&
                statuses.includes(assignment.status),
            )
            .sort(
              (left, right) =>
                (right.assignedAt?.getTime?.() ?? 0) -
                (left.assignedAt?.getTime?.() ?? 0),
            )[0] ?? null
        )
      }),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    ticket: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const row = ticketRows.get(where.id) ?? null
        if (!row) return null
        return include ? enrich(row) : { ...row }
      }),
      findFirst: jest.fn(async ({ where, include }: any) => {
        const id = where.AND?.[0]?.id ?? ticket.id
        const row = ticketRows.get(id)
        if (!row) return null
        const messageWhere = include.messages.where ?? {}
        const rows = [...messageRows.values()]
          .filter(
            (message) =>
              message.ticketId === row.id &&
              (!messageWhere.visibility ||
                message.visibility === messageWhere.visibility),
          )
          .filter((message) => {
            if (!messageWhere.OR) return true
            const before = messageWhere.OR[0].createdAt.lt as Date
            const sameAt = messageWhere.OR[1].createdAt as Date
            const beforeId = messageWhere.OR[1].id.lt as string
            return (
              message.createdAt < before ||
              (message.createdAt.getTime() === sameAt.getTime() &&
                message.id < beforeId)
            )
          })
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id),
          )
          .slice(0, include.messages.take)
          .map((message) => ({
            ...message,
            user: resolveUser(message.userId),
          }))
        return { ...enrich(row), messages: rows }
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          ...data,
          orderId: data.orderId ?? null,
          status: "OPEN",
          createdAt: new Date("2026-08-14T11:00:00.000Z"),
          updatedAt: new Date("2026-08-14T11:00:00.000Z"),
        }
        ticketRows.set(row.id, row)
        return row
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const current = ticketRows.get(where.id)
        const row = { ...current, ...data, updatedAt: new Date() }
        ticketRows.set(where.id, row)
        return row
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    ticketMessage: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = messageRows.get(where.id)
        return row ? { ...row, user: resolveUser(row.userId) } : null
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          [...messageRows.values()]
            .filter(
              (message) =>
                message.ticketId === where.ticketId &&
                message.visibility === where.visibility,
            )
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                b.id.localeCompare(a.id),
            )[0] ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: data.id ?? `system-${messageRows.size + 1}`,
          createdAt: new Date(
            `2026-08-14T12:${String(messageRows.size).padStart(2, "0")}:00.000Z`,
          ),
          files: null,
          ...data,
          user: resolveUser(data.userId),
        }
        messageRows.set(row.id, row)
        return row
      }),
    },
  }
  prisma.$transaction = jest.fn(async (operation: (tx: any) => unknown) =>
    operation(prisma),
  )

  return {
    service: new SupportService(prisma, queue as any, audit as any),
    prisma,
    queue,
    audit,
    ticketRows,
    messageRows,
  }
}

describe("support participant matrix and safe projection", () => {
  it("projects a customer reply with self identity but no raw evidence", async () => {
    const harness = makeHarness()
    const result = await harness.service.addMessage("ticket-1", customer(), {
      content: "  Hello support.  ",
      clientMessageId: MESSAGE_ID,
    })

    expect(result).toMatchObject({
      content: "Hello support.",
      sender: { party: "CUSTOMER", displayName: "You", isSelf: true },
    })
    expect(result).not.toHaveProperty("participantRole")
    expect(result).not.toHaveProperty("actorSnapshot")
    expect(result).not.toHaveProperty("authorEvidence")
    expect(result).not.toHaveProperty("user")
    const stored = [...harness.messageRows.values()][0]
    expect(stored).toMatchObject({
      participantRole: "CUSTOMER",
      messageType: "MESSAGE",
      actorSnapshot: { kind: "CUSTOMER", organizationRole: "OWNER" },
    })
  })

  it("rejects cross-tenant replies and all external internal notes", async () => {
    const harness = makeHarness()
    await expect(
      harness.service.addMessage("ticket-1", customer("org-2"), {
        content: "Cross tenant",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    await expect(
      harness.service.addMessage("ticket-1", customer(), {
        content: "Private note",
        visibility: "INTERNAL",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("allows only the assigned publisher tenant on publisher-channel tickets", async () => {
    const harness = makeHarness({
      ticket: {
        fulfillmentChannel: "PUBLISHER",
        assignedPublisherId: "pub-1",
        assignedToUserId: null,
      },
    })
    await expect(
      harness.service.addMessage("ticket-1", publisher(), {
        content: "Publisher response",
        clientMessageId: MESSAGE_ID,
      }),
    ).resolves.toMatchObject({ sender: { party: "PUBLISHER", isSelf: true } })
    await expect(
      harness.service.addMessage("ticket-1", publisher("pub-2"), {
        content: "Wrong publisher",
        clientMessageId: "00000000-0000-4000-8000-000000000003",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it("allows assigned Operations and Super Admin but fails Finance closed", async () => {
    const operations = makeHarness()
    await expect(
      operations.service.addMessage("ticket-1", staff("OPERATIONS"), {
        content: "Operations response",
        visibility: "INTERNAL",
        clientMessageId: MESSAGE_ID,
      }),
    ).resolves.toMatchObject({ participantRole: "OPS" })

    const admin = makeHarness()
    await expect(
      admin.service.addMessage("ticket-1", staff("SUPER_ADMIN"), {
        content: "Admin response",
        clientMessageId: MESSAGE_ID,
      }),
    ).resolves.toMatchObject({ participantRole: "ADMIN" })

    const finance = makeHarness()
    await expect(
      finance.service.addMessage("ticket-1", staff("FINANCE"), {
        content: "Finance must not see support",
        visibility: "INTERNAL",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)
    expect(finance.prisma.ticketMessage.create).not.toHaveBeenCalled()
  })

  it("requires an explicit claim before Operations can reply to an unassigned ticket", async () => {
    const harness = makeHarness({
      ticket: { orderId: null, assignedToUserId: null },
    })
    await expect(
      harness.service.addMessage("ticket-1", staff("OPERATIONS"), {
        content: "Premature response",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException)

    const claimed = await harness.service.claimTicket(
      "ticket-1",
      staff("OPERATIONS"),
    )
    expect(claimed).toMatchObject({
      assignedTo: { displayName: "You" },
      capabilities: { canReply: true, canClaim: false },
    })
    expect(claimed.assignedTo).not.toHaveProperty("userId")
  })

  it("fails Operations scope closed for a corrupt Platform row with a publisher owner", async () => {
    const harness = makeHarness({
      ticket: { assignedPublisherId: "pub-1", assignedToUserId: "ops-1" },
    })

    await expect(
      harness.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).rejects.toBeInstanceOf(NotFoundException)
    await expect(
      harness.service.addMessage("ticket-1", staff("OPERATIONS"), {
        content: "This corrupt cross-channel row must fail closed.",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException)

    await harness.service.listTicketsDetailed(staff("OPERATIONS"))
    expect(harness.prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignedPublisherId: null,
          OR: [
            { fulfillmentChannel: "PLATFORM" },
            { fulfillmentChannel: null, orderId: null },
          ],
          AND: [
            {
              OR: [{ assignedToUserId: "ops-1" }, { assignedToUserId: null }],
            },
          ],
        }),
      }),
    )
  })

  it("grandfathers only an unambiguous legacy general ticket into the Operations queue", async () => {
    const harness = makeHarness({
      ticket: {
        orderId: null,
        fulfillmentChannel: null,
        assignedPublisherId: null,
        assignedToUserId: null,
      },
    })

    await expect(
      harness.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({
      fulfillmentChannel: null,
      capabilities: { canClaim: true, canReply: false },
    })
    await expect(
      harness.service.claimTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({
      assignedTo: { displayName: "You" },
      capabilities: { canClaim: false, canReply: true },
    })

    const ambiguousOrderLinked = makeHarness({
      ticket: {
        fulfillmentChannel: null,
        assignedPublisherId: null,
        assignedToUserId: null,
      },
    })
    await expect(
      ambiguousOrderLinked.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it("uses the same clean Platform policy for the Super Admin channel filter", async () => {
    const harness = makeHarness()

    await harness.service.listTicketsDetailed(staff("SUPER_ADMIN"), {
      channel: "PLATFORM",
    })

    expect(harness.prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              assignedPublisherId: null,
              OR: [
                { fulfillmentChannel: "PLATFORM" },
                { fulfillmentChannel: null, orderId: null },
              ],
            },
          ],
        }),
      }),
    )
  })

  it("allows a ticket-only claim after fulfillment using Order then Ticket locks", async () => {
    const harness = makeHarness({
      ticket: { assignedToUserId: null },
      order: { status: "DELIVERED" },
      fulfillmentAssignments: [
        {
          id: "delivered-assignment",
          orderId: "order-1",
          assignedToUserId: "ops-2",
          status: "DELIVERED",
          assignedAt: new Date("2026-08-14T09:00:00.000Z"),
        },
      ],
    })

    await expect(
      harness.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({
      capabilities: { canClaim: true, canReply: false },
    })
    await expect(
      harness.service.claimTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({
      assignedTo: { displayName: "You" },
      capabilities: { canClaim: false, canReply: true },
    })
    expect(harness.prisma.fulfillmentAssignment.create).not.toHaveBeenCalled()
    expect(
      harness.prisma.fulfillmentAssignment.updateMany,
    ).not.toHaveBeenCalled()

    const lockSql = harness.prisma.$queryRaw.mock.calls.map((call: any[]) =>
      call[0].join("?"),
    )
    expect(
      lockSql.findIndex((sql: string) => sql.includes('"Order"')),
    ).toBeLessThan(lockSql.findIndex((sql: string) => sql.includes('"Ticket"')))
  })

  it("keeps active or still-claimable order tickets read-only", async () => {
    const claimableOrder = makeHarness({
      ticket: { assignedToUserId: null },
      order: { status: "SUBMITTED" },
    })
    await expect(
      claimableOrder.service.claimTicket("ticket-1", staff("OPERATIONS")),
    ).rejects.toBeInstanceOf(ConflictException)

    const activeAssignment = makeHarness({
      ticket: { assignedToUserId: null },
      order: { status: "DELIVERED" },
      fulfillmentAssignments: [
        {
          id: "active-assignment",
          orderId: "order-1",
          assignedToUserId: "ops-2",
          status: "IN_PROGRESS",
        },
      ],
    })
    await expect(
      activeAssignment.service.claimTicket("ticket-1", staff("OPERATIONS")),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it.each([
    ["PUBLISHED", true],
    ["COMPLETED", true],
    ["CANCELLED", true],
    ["REFUNDED", true],
    ["APPROVED", false],
  ])("projects terminal support ownership eligibility for %s", async (status, eligible) => {
    const harness = makeHarness({
      ticket: { assignedToUserId: null },
      order: { status },
    })
    await expect(
      harness.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({ capabilities: { canClaim: eligible } })
    await expect(
      harness.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
    ).resolves.toMatchObject({ capabilities: { canReassign: eligible } })
  })

  it("reassigns a post-fulfillment order ticket without changing fulfillment ownership", async () => {
    const harness = makeHarness({
      order: { status: "COMPLETED" },
      fulfillmentAssignments: [
        {
          id: "delivered-assignment",
          orderId: "order-1",
          assignedToUserId: "ops-1",
          status: "DELIVERED",
        },
      ],
    })

    await expect(
      harness.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
    ).resolves.toMatchObject({ capabilities: { canReassign: true } })
    await expect(
      harness.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: "ops-1",
          reason: "Move the active conversation before staff offboarding.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).resolves.toMatchObject({
      assignedTo: { userId: "ops-2" },
      capabilities: { canReassign: true },
    })
    expect(harness.ticketRows.get("ticket-1")).toMatchObject({
      assignedToUserId: "ops-2",
    })
    expect(harness.prisma.fulfillmentAssignment.create).not.toHaveBeenCalled()
    expect(
      harness.prisma.fulfillmentAssignment.updateMany,
    ).not.toHaveBeenCalled()
    expect(harness.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TICKET_REASSIGNED",
        metadata: expect.objectContaining({
          ownershipMode: "POST_FULFILLMENT_TICKET_ONLY",
          orderId: "order-1",
          orderStatus: "COMPLETED",
          fromAssignedToUserId: "ops-1",
          toAssignedToUserId: "ops-2",
        }),
      }),
      harness.prisma,
    )

    const lockSql = harness.prisma.$queryRaw.mock.calls.map((call: any[]) =>
      call[0].join("?"),
    )
    const orderLockIndex = lockSql.findIndex((sql: string) =>
      sql.includes('"Order"'),
    )
    const ticketLockIndex = lockSql.findIndex((sql: string) =>
      sql.includes('"Ticket"'),
    )
    expect(orderLockIndex).toBeGreaterThanOrEqual(0)
    expect(ticketLockIndex).toBeGreaterThan(orderLockIndex)
  })

  it("rejects a stale expected owner before target validation or writes", async () => {
    const harness = makeHarness({ order: { status: "COMPLETED" } })

    await expect(
      harness.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: null,
          reason: "This stale reassignment intent must not overwrite a winner.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "TICKET_ASSIGNMENT_CHANGED" }),
    })

    expect(harness.ticketRows.get("ticket-1")).toMatchObject({
      assignedToUserId: "ops-1",
    })
    expect(harness.prisma.ticket.update).not.toHaveBeenCalled()
    expect(harness.prisma.ticketMessage.create).not.toHaveBeenCalled()
    expect(harness.audit.log).not.toHaveBeenCalled()
    expect(harness.queue.addJob).not.toHaveBeenCalled()
    expect(
      harness.prisma.staffMembership.findUnique.mock.calls.some(
        ([query]: any[]) => query.where.userId === "ops-2",
      ),
    ).toBe(false)
  })

  it("keeps active or claimable order-ticket reassignment on fulfillment", async () => {
    const claimable = makeHarness({ order: { status: "APPROVED" } })
    await expect(
      claimable.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
    ).resolves.toMatchObject({ capabilities: { canReassign: false } })
    await expect(
      claimable.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: "ops-1",
          reason: "This must use fulfillment assignment instead.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(claimable.prisma.ticket.update).not.toHaveBeenCalled()

    const active = makeHarness({
      order: { status: "DELIVERED" },
      fulfillmentAssignments: [
        {
          id: "active-assignment",
          orderId: "order-1",
          assignedToUserId: "ops-1",
          status: "IN_PROGRESS",
        },
      ],
    })
    await expect(
      active.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
    ).resolves.toMatchObject({ capabilities: { canReassign: false } })
    await expect(
      active.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: "ops-1",
          reason: "Active assignment remains the ownership authority.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(active.prisma.ticket.update).not.toHaveBeenCalled()
  })

  it("uses the dispute previous status for claim, reassign, and capability eligibility", async () => {
    const activeDispute = makeHarness({
      ticket: { assignedToUserId: null },
      order: {
        status: "DISPUTED",
        dispute: { status: "OPEN", previousStatus: "APPROVED" },
      },
    })
    await expect(
      activeDispute.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({ capabilities: { canClaim: false } })
    await expect(
      activeDispute.service.claimTicket("ticket-1", staff("OPERATIONS")),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      activeDispute.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
    ).resolves.toMatchObject({ capabilities: { canReassign: false } })

    const deliveredDispute = makeHarness({
      ticket: { assignedToUserId: null },
      order: {
        status: "DISPUTED",
        dispute: { status: "UNDER_REVIEW", previousStatus: "DELIVERED" },
      },
    })
    await expect(
      deliveredDispute.service.getTicket("ticket-1", staff("OPERATIONS")),
    ).resolves.toMatchObject({ capabilities: { canClaim: true } })
    await expect(
      deliveredDispute.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
    ).resolves.toMatchObject({ capabilities: { canReassign: true } })
    await expect(
      deliveredDispute.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: null,
          reason: "Move the post-delivery dispute conversation safely.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).resolves.toMatchObject({ assignedTo: { userId: "ops-2" } })
    expect(deliveredDispute.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "TICKET_REASSIGNED",
        metadata: expect.objectContaining({
          orderStatus: "DISPUTED",
          effectiveOrderStatus: "DELIVERED",
          disputeStatus: "UNDER_REVIEW",
          disputePreviousStatus: "DELIVERED",
        }),
      }),
      deliveredDispute.prisma,
    )
  })

  it("fails disputed-order ownership commands closed without a live dispute", async () => {
    for (const dispute of [
      null,
      { status: "OPEN", previousStatus: null },
      { status: "RESOLVED", previousStatus: "DELIVERED" },
    ]) {
      const harness = makeHarness({
        ticket: { assignedToUserId: null },
        order: { status: "DISPUTED", dispute },
      })
      await expect(
        harness.service.getTicket("ticket-1", staff("OPERATIONS")),
      ).resolves.toMatchObject({ capabilities: { canClaim: false } })
      await expect(
        harness.service.getTicket("ticket-1", staff("SUPER_ADMIN")),
      ).resolves.toMatchObject({ capabilities: { canReassign: false } })
      await expect(
        harness.service.reassignTicket(
          "ticket-1",
          {
            assignedToUserId: "ops-2",
            expectedAssignedToUserId: null,
            reason: "Corrupt dispute state must fail safely without a handoff.",
          },
          staff("SUPER_ADMIN"),
        ),
      ).rejects.toBeInstanceOf(ConflictException)
    }
  })

  it("rechecks the terminal-ticket target as active, non-banned Operations", async () => {
    const harness = makeHarness({
      order: { status: "COMPLETED" },
      staffRoles: { "ops-2": "FINANCE" },
    })
    await expect(
      harness.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: "ops-1",
          reason: "A demoted target must not receive this conversation.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(harness.prisma.ticket.update).not.toHaveBeenCalled()
  })

  it("rejects a corrupt Operations membership attached to a non-staff user", async () => {
    const harness = makeHarness({
      order: { status: "COMPLETED" },
      userTypes: { "ops-2": "CUSTOMER" },
    })
    await expect(
      harness.service.reassignTicket(
        "ticket-1",
        {
          assignedToUserId: "ops-2",
          expectedAssignedToUserId: "ops-1",
          reason: "A non-staff principal must never receive support authority.",
        },
        staff("SUPER_ADMIN"),
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(harness.prisma.ticket.update).not.toHaveBeenCalled()
  })
})

describe("retry safety and lifecycle commands", () => {
  it("returns the exact message winner on replay and rejects payload drift", async () => {
    const harness = makeHarness()
    const first = await harness.service.addMessage("ticket-1", customer(), {
      content: "Retry-safe reply",
      clientMessageId: MESSAGE_ID,
    })
    const replay = await harness.service.addMessage("ticket-1", customer(), {
      content: "Retry-safe reply",
      clientMessageId: MESSAGE_ID,
    })
    expect(replay.id).toBe(first.id)
    expect(harness.prisma.ticketMessage.create).toHaveBeenCalledTimes(1)
    expect(harness.audit.log).toHaveBeenCalledTimes(1)

    await expect(
      harness.service.addMessage("ticket-1", customer(), {
        content: "Changed payload",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it("requires reopen before public replies but still permits authorized internal notes", async () => {
    const customerHarness = makeHarness({ ticket: { status: "CLOSED" } })
    await expect(
      customerHarness.service.addMessage("ticket-1", customer(), {
        content: "Reply while closed",
        clientMessageId: MESSAGE_ID,
      }),
    ).rejects.toBeInstanceOf(ConflictException)

    const adminHarness = makeHarness({ ticket: { status: "CLOSED" } })
    await expect(
      adminHarness.service.addMessage("ticket-1", staff("SUPER_ADMIN"), {
        content: "Internal follow-up",
        visibility: "INTERNAL",
        clientMessageId: MESSAGE_ID,
      }),
    ).resolves.toMatchObject({ visibility: "INTERNAL" })
  })

  it("makes same-target status retry a no-op and emits unique events for real transitions", async () => {
    const harness = makeHarness()
    const unchanged = await harness.service.updateExternalStatus(
      "ticket-1",
      "OPEN",
      customer(),
    )
    expect(unchanged.status).toBe("OPEN")
    expect(harness.prisma.ticketMessage.create).not.toHaveBeenCalled()

    const closed = await harness.service.updateExternalStatus(
      "ticket-1",
      "CLOSED",
      customer(),
    )
    expect(closed.status).toBe("CLOSED")
    const reopened = await harness.service.updateExternalStatus(
      "ticket-1",
      "OPEN",
      customer(),
    )
    expect(reopened.status).toBe("OPEN")
    const ids = [...harness.messageRows.values()].map((row) => row.id)
    expect(new Set(ids).size).toBe(2)
  })

  it("creates an idempotent normalized ticket and rejects changed request data", async () => {
    const harness = makeHarness()
    const input = {
      subject: "  General account help  ",
      description: "  Please help with my account access.  ",
      clientRequestId: REQUEST_ID,
    }
    const first = await harness.service.createTicket(customer(), input)
    const replay = await harness.service.createTicket(customer(), input)
    expect(replay).toEqual(first)
    expect(harness.prisma.ticket.create).toHaveBeenCalledTimes(1)

    await expect(
      harness.service.createTicket(customer(), {
        ...input,
        subject: "Different request",
      }),
    ).rejects.toBeInstanceOf(ConflictException)
    await expect(
      harness.service.createTicket(publisher(), input),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it("routes a delivered Platform order ticket to its latest active Operations owner", async () => {
    const harness = makeHarness({
      order: { status: "DELIVERED" },
      fulfillmentAssignments: [
        {
          id: "delivered-new",
          orderId: "order-1",
          assignedToUserId: "ops-2",
          status: "DELIVERED",
          assignedAt: new Date("2026-08-14T09:00:00.000Z"),
        },
        {
          id: "cancelled-newer",
          orderId: "order-1",
          assignedToUserId: "ops-1",
          status: "CANCELLED",
          assignedAt: new Date("2026-08-14T10:00:00.000Z"),
        },
      ],
    })

    const created = await harness.service.createTicket(customer(), {
      subject: "Delivered order follow-up",
      description: "Please help with this completed publication delivery.",
      orderId: "order-1",
      clientRequestId: REQUEST_ID,
    })
    expect(harness.ticketRows.get(created.id)).toMatchObject({
      fulfillmentChannel: "PLATFORM",
      assignedToUserId: "ops-2",
      assignedPublisherId: null,
    })
  })

  it("leaves delivered support unassigned for a corrupt non-staff Operations owner", async () => {
    const harness = makeHarness({
      order: { status: "DELIVERED" },
      userTypes: { "ops-2": "CUSTOMER" },
      fulfillmentAssignments: [
        {
          id: "delivered-corrupt-owner",
          orderId: "order-1",
          assignedToUserId: "ops-2",
          status: "DELIVERED",
          assignedAt: new Date("2026-08-14T09:00:00.000Z"),
        },
      ],
    })

    const created = await harness.service.createTicket(customer(), {
      subject: "Delivered order owner validation",
      description: "Please route this safely when owner authority is corrupt.",
      orderId: "order-1",
      clientRequestId: REQUEST_ID,
    })
    expect(harness.ticketRows.get(created.id)).toMatchObject({
      fulfillmentChannel: "PLATFORM",
      assignedToUserId: null,
      assignedPublisherId: null,
    })
  })
})

describe("bounded message history and privacy", () => {
  it("paginates public rows by stable keyset without internal rows consuming the page", async () => {
    const messages: Array<Record<string, any>> = Array.from(
      { length: 205 },
      (_, index) => ({
        id: `public-${String(index).padStart(3, "0")}`,
        ticketId: "ticket-1",
        userId: index % 2 ? "customer-1" : "admin-1",
        content: `public ${index}`,
        visibility: "PUBLIC",
        participantRole: index % 2 ? "CUSTOMER" : "ADMIN",
        messageType: "MESSAGE",
        actorSnapshot: null,
        files: { secret: true },
        createdAt: new Date(1_700_000_000_000 + index * 1_000),
      }),
    )
    messages.push(
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `internal-${index}`,
        ticketId: "ticket-1",
        userId: "admin-1",
        content: `internal ${index}`,
        visibility: "INTERNAL",
        participantRole: "ADMIN",
        messageType: "INTERNAL_NOTE",
        actorSnapshot: { kind: "STAFF", secret: "must-not-leak" },
        createdAt: new Date(1_800_000_000_000 + index * 1_000),
      })),
    )
    const harness = makeHarness({ messages })

    const first = await harness.service.getTicket("ticket-1", customer())
    expect(first.messages).toHaveLength(200)
    expect(
      first.messages.every((row: any) => row.visibility === "PUBLIC"),
    ).toBe(true)
    expect(first.messagePage.nextCursor).toEqual(expect.any(String))
    expect(first.messages[0].createdAt <= first.messages[199].createdAt).toBe(
      true,
    )

    const second = await harness.service.getTicket("ticket-1", customer(), {
      messageCursor: first.messagePage.nextCursor,
    })
    expect(second.messages).toHaveLength(5)
    expect(second.messagePage.nextCursor).toBeNull()
    const ids = [...first.messages, ...second.messages].map(
      (row: any) => row.id,
    )
    expect(new Set(ids).size).toBe(205)
    for (const row of [...first.messages, ...second.messages]) {
      expect(row).not.toHaveProperty("user")
      expect(row).not.toHaveProperty("files")
      expect(row).not.toHaveProperty("actorSnapshot")
    }
  })

  it("allow-lists staff actor snapshots and restricts raw identity to Super Admin", async () => {
    const message = {
      id: "message-1",
      ticketId: "ticket-1",
      userId: "customer-1",
      content: "Evidence",
      visibility: "PUBLIC",
      participantRole: "CUSTOMER",
      messageType: "MESSAGE",
      actorSnapshot: {
        kind: "CUSTOMER",
        organizationRole: "OWNER",
        secretFutureField: "do not serialize",
      },
      createdAt: new Date("2026-08-14T12:00:00.000Z"),
    }
    const adminHarness = makeHarness({ messages: [message] })
    const adminDetail = await adminHarness.service.getTicket(
      "ticket-1",
      staff("SUPER_ADMIN"),
    )
    expect(adminDetail.messages[0].actorSnapshot).toEqual({
      kind: "CUSTOMER",
      staffRole: null,
      organizationRole: "OWNER",
      publisherRole: null,
    })
    expect(adminDetail.messages[0].authorEvidence).toMatchObject({
      userId: "customer-1",
      email: "customer-1@example.test",
    })

    const opsHarness = makeHarness({ messages: [message] })
    const operationsDetail = await opsHarness.service.getTicket(
      "ticket-1",
      staff("OPERATIONS"),
    )
    expect(operationsDetail.messages[0].authorEvidence).not.toHaveProperty(
      "userId",
    )
    expect(operationsDetail.messages[0].authorEvidence).not.toHaveProperty(
      "email",
    )
  })

  it("does not notify a demoted or banned former Operations assignee", async () => {
    const harness = makeHarness({ staffRoles: { "ops-1": "FINANCE" } })
    await harness.service.addMessage("ticket-1", customer(), {
      content: "Public customer update",
      clientMessageId: MESSAGE_ID,
    })
    const recipients = harness.queue.addJob.mock.calls.map(
      (call) => call[2].userId,
    )
    expect(recipients).not.toContain("ops-1")
    expect(recipients).toContain("admin-1")
  })

  it("updates staff activity for an internal note without changing the public projection source", async () => {
    const harness = makeHarness()
    await harness.service.addMessage("ticket-1", staff("SUPER_ADMIN"), {
      content: "Internal activity should reorder the staff inbox only.",
      visibility: "INTERNAL",
      clientMessageId: MESSAGE_ID,
    })

    expect(harness.prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: "ticket-1" },
      data: { updatedAt: expect.any(Date) },
    })
  })

  it("runs authority and support reads in one repeatable snapshot and counts the opening request", async () => {
    const harness = makeHarness({ ticket: { orderId: null } })
    harness.prisma.ticket.findMany.mockResolvedValue([
      {
        ...baseTicket({ orderId: null }),
        user: userFor("customer-1"),
        organization: { id: "org-1", name: "Example customer" },
        assignedTo: { id: "ops-1", name: "Operations" },
        assignedPublisher: null,
        order: null,
        _count: { messages: 0 },
      },
    ])
    harness.prisma.ticket.count.mockResolvedValue(1)

    const page = await harness.service.listTicketsDetailed(staff("SUPER_ADMIN"))
    expect(page.items[0].messageCount).toBe(1)
    expect(harness.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "RepeatableRead" },
    )
  })
})

describe("support response cache policy", () => {
  it.each([
    "listTickets",
    "getTicket",
  ])("marks external %s responses private and no-store", (method) => {
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      (SupportController.prototype as any)[method],
    ) as Array<{ name: string; value: string }>
    expect(headers).toEqual(
      expect.arrayContaining([
        {
          name: "Cache-Control",
          value: "private, no-store, no-cache, must-revalidate",
        },
        { name: "Pragma", value: "no-cache" },
      ]),
    )
  })
})

describe("role snapshot helpers", () => {
  it("resolves current participant roles and rejects roleless staff", () => {
    expect(resolveParticipantRole(customer())).toBe("CUSTOMER")
    expect(resolveParticipantRole(publisher())).toBe("PUBLISHER")
    expect(resolveParticipantRole(staff("SUPER_ADMIN"))).toBe("ADMIN")
    expect(resolveParticipantRole(staff("OPERATIONS"))).toBe("OPS")
    expect(() =>
      resolveParticipantRole({ userId: "staff", kind: "STAFF" }),
    ).toThrow(ForbiddenException)
  })

  it("stores a stable allow-listed snapshot shape", () => {
    expect(buildActorSnapshot(customer())).toEqual({
      kind: "CUSTOMER",
      staffRole: null,
      organizationRole: "OWNER",
      publisherRole: null,
    })
  })
})
