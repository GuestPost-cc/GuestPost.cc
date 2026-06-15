/**
 * Phase 6.6 — channel-aware reply matrix + INTERNAL note coverage.
 *
 *   PUBLISHER channel: Customer R+W(PUBLIC), Publisher R+W(PUBLIC),
 *                      SUPER_ADMIN R+W(PUBLIC|INTERNAL),
 *                      FINANCE     R+W(PUBLIC|INTERNAL)
 *
 *   PLATFORM channel:  Customer R+W(PUBLIC), Assigned Ops R+W(PUBLIC|INTERNAL),
 *                      SUPER_ADMIN R+W(PUBLIC|INTERNAL),
 *                      FINANCE     R   ; W(INTERNAL only)
 *
 * Customers/publishers never write INTERNAL; their getTicket strips INTERNAL
 * rows before returning. Fan-out is recipient-set computed per channel +
 * visibility; the same user holding multiple roles dedupes to one notification.
 */
import { ForbiddenException, NotFoundException } from "@nestjs/common"
import {
  SupportService,
  resolveParticipantRole,
  buildActorSnapshot,
  type SupportActor,
} from "../support.service"

type Channel = "PUBLISHER" | "PLATFORM"

interface MockTicket {
  id: string
  organizationId: string
  userId: string
  orderId: string | null
  fulfillmentChannel: Channel | null
  assignedToUserId: string | null
  assignedPublisherId: string | null
  status: string
  subject: string
  description: string | null
}

function makeTicket(over: Partial<MockTicket> = {}): MockTicket {
  // Spread last so explicit nulls in `over` override defaults (avoiding the
  // `??` trap where over.field === null falls back to the default).
  return {
    id: "tkt1",
    organizationId: "orgA",
    userId: "customer1",
    orderId: "ord1",
    fulfillmentChannel: "PLATFORM",
    assignedToUserId: "ops1",
    assignedPublisherId: null,
    status: "OPEN",
    subject: "Help",
    description: null,
    ...over,
  }
}

function mockPrisma(opts: {
  ticket: MockTicket
  staff?: { superAdmins?: string[]; finance?: string[] }
  customerOrgMembers?: string[]
  publisherMembers?: string[]
  messages?: any[]
}) {
  const created: any[] = []
  return {
    _created: created,
    ticket: {
      findUnique: jest.fn().mockImplementation(async ({ where, include }: any) => {
        if (!include) return { ...opts.ticket }
        return {
          ...opts.ticket,
          organization: {
            memberships: (opts.customerOrgMembers ?? [opts.ticket.userId, "owner_orgA"]).map(
              (userId) => ({ userId, status: "ACTIVE" }),
            ),
          },
          assignedPublisher: opts.ticket.assignedPublisherId
            ? {
                publisherMemberships: (opts.publisherMembers ?? ["pubowner1"]).map((userId) => ({
                  userId,
                })),
              }
            : null,
        }
      }),
      findFirst: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...opts.ticket }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ ...opts.ticket }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    ticketMessage: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const row = { id: `msg_${created.length + 1}`, ...data }
        created.push(row)
        return row
      }),
    },
    staffMembership: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.role === "SUPER_ADMIN") {
          return (opts.staff?.superAdmins ?? ["admin1"]).map((userId) => ({ userId }))
        }
        if (where.role === "FINANCE") {
          return (opts.staff?.finance ?? ["fin1"]).map((userId) => ({ userId }))
        }
        return []
      }),
      findUnique: jest.fn(),
    },
    publisher: { findUnique: jest.fn() },
  }
}

function mockQueue() {
  const jobs: any[] = []
  return {
    _jobs: jobs,
    addJob: jest.fn().mockImplementation(async (..._args: any[]) => {
      jobs.push(_args)
    }),
  }
}

function mockAudit() {
  const rows: any[] = []
  return {
    _rows: rows,
    log: jest.fn().mockImplementation(async (params: any) => {
      rows.push(params)
    }),
  }
}

// Helpers
const customerActor = (
  orgId = "orgA",
  userId = "customer1",
  customerRole: "OWNER" | "MEMBER" = "OWNER",
): SupportActor => ({
  userId,
  kind: "CUSTOMER",
  organizationId: orgId,
  customerRole,
})
const publisherActor = (
  publisherId: string,
  userId = "pubowner1",
  publisherRole: "PUBLISHER_OWNER" | "PUBLISHER_MEMBER" = "PUBLISHER_OWNER",
): SupportActor => ({
  userId,
  kind: "PUBLISHER",
  publisherId,
  publisherRole,
})
const staffActor = (
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE",
  userId?: string,
): SupportActor => ({
  userId: userId ?? `staff_${staffRole.toLowerCase()}`,
  kind: "STAFF",
  staffRole,
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("SupportService.addMessage — reply matrix", () => {
  describe("CUSTOMER", () => {
    it("can post PUBLIC on their org's ticket", async () => {
      const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      const msg = await svc.addMessage(ticket.id, customerActor(), { content: "hi" })
      expect(msg.visibility).toBe("PUBLIC")
    })

    it("cannot post INTERNAL", async () => {
      const ticket = makeTicket()
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      await expect(
        svc.addMessage(ticket.id, customerActor(), { content: "secret", visibility: "INTERNAL" }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it("cannot read or reply to another org's ticket", async () => {
      const ticket = makeTicket({ organizationId: "orgB" })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      await expect(
        svc.addMessage(ticket.id, customerActor("orgA"), { content: "hi" }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  describe("FINANCE", () => {
    it("can post PUBLIC on a PUBLISHER ticket", async () => {
      const ticket = makeTicket({
        fulfillmentChannel: "PUBLISHER",
        assignedToUserId: null,
        assignedPublisherId: "pub1",
      })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      const msg = await svc.addMessage(ticket.id, staffActor("FINANCE"), { content: "billing reply" })
      expect(msg.visibility).toBe("PUBLIC")
    })

    it("CANNOT post PUBLIC on a PLATFORM ticket", async () => {
      const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      await expect(
        svc.addMessage(ticket.id, staffActor("FINANCE"), { content: "should fail" }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it("CAN post INTERNAL on a PLATFORM ticket (escape valve)", async () => {
      const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      const msg = await svc.addMessage(ticket.id, staffActor("FINANCE"), {
        content: "flag for admin",
        visibility: "INTERNAL",
      })
      expect(msg.visibility).toBe("INTERNAL")
    })
  })

  describe("OPERATIONS", () => {
    it("can post PUBLIC + INTERNAL on a ticket assigned to them", async () => {
      const ticket = makeTicket({ fulfillmentChannel: "PLATFORM", assignedToUserId: "opsA" })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)

      const pub = await svc.addMessage(ticket.id, staffActor("OPERATIONS", "opsA"), {
        content: "on it",
      })
      expect(pub.visibility).toBe("PUBLIC")

      const internal = await svc.addMessage(ticket.id, staffActor("OPERATIONS", "opsA"), {
        content: "fyi internal",
        visibility: "INTERNAL",
      })
      expect(internal.visibility).toBe("INTERNAL")
    })

    it("CANNOT post on a PLATFORM ticket assigned to another Ops (unassigned pool is read-only)", async () => {
      const ticket = makeTicket({ fulfillmentChannel: "PLATFORM", assignedToUserId: "opsA" })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      await expect(
        svc.addMessage(ticket.id, staffActor("OPERATIONS", "opsB"), { content: "claim" }),
      ).rejects.toBeInstanceOf(NotFoundException) // assertVisible refuses first
    })

    it("CANNOT post on unassigned platform pool until claimed", async () => {
      const ticket = makeTicket({ fulfillmentChannel: "PLATFORM", assignedToUserId: null })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      // Visible (unassigned pool), but reply is gated:
      await expect(
        svc.addMessage(ticket.id, staffActor("OPERATIONS", "opsB"), { content: "I'll take it" }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })
  })

  describe("PUBLISHER", () => {
    it("can post PUBLIC on a ticket assigned to their publisher", async () => {
      const ticket = makeTicket({
        fulfillmentChannel: "PUBLISHER",
        assignedToUserId: null,
        assignedPublisherId: "pub1",
      })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      const msg = await svc.addMessage(ticket.id, publisherActor("pub1"), { content: "on it" })
      expect(msg.visibility).toBe("PUBLIC")
    })

    it("CANNOT post INTERNAL", async () => {
      const ticket = makeTicket({
        fulfillmentChannel: "PUBLISHER",
        assignedPublisherId: "pub1",
      })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      await expect(
        svc.addMessage(ticket.id, publisherActor("pub1"), {
          content: "leak attempt",
          visibility: "INTERNAL",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it("CANNOT read or reply to a different publisher's ticket", async () => {
      const ticket = makeTicket({
        fulfillmentChannel: "PUBLISHER",
        assignedPublisherId: "pub1",
      })
      const prisma = mockPrisma({ ticket })
      const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
      await expect(
        svc.addMessage(ticket.id, publisherActor("pub2"), { content: "hi" }),
      ).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})

describe("SupportService.getTicket — INTERNAL message filtering", () => {
  it("strips INTERNAL messages for CUSTOMER actors", async () => {
    const ticket = makeTicket()
    const prisma = mockPrisma({ ticket })
    // Override findUnique to return both visibilities
    ;(prisma.ticket.findUnique as jest.Mock).mockImplementationOnce(async ({ where }: any) => ({
      ...ticket,
      user: { id: "u1" },
      messages: [
        { id: "m1", content: "hi", visibility: "PUBLIC", user: { id: "u1" } },
        { id: "m2", content: "internal", visibility: "INTERNAL", user: { id: "s1" } },
      ],
    }))
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    // For CUSTOMER, the prisma query passes `where: { visibility: "PUBLIC" }`
    // — assert via the call arg.
    await svc.getTicket(ticket.id, customerActor())
    const call = (prisma.ticket.findUnique as jest.Mock).mock.calls[0][0]
    expect(call.include.messages.where).toEqual({ visibility: "PUBLIC" })
  })

  it("does NOT filter for STAFF actors", async () => {
    const ticket = makeTicket()
    const prisma = mockPrisma({ ticket })
    ;(prisma.ticket.findUnique as jest.Mock).mockImplementationOnce(async () => ({
      ...ticket,
      user: { id: "u1" },
      messages: [],
    }))
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    await svc.getTicket(ticket.id, staffActor("FINANCE"))
    const call = (prisma.ticket.findUnique as jest.Mock).mock.calls[0][0]
    expect(call.include.messages.where).toBeUndefined()
  })
})

describe("SupportService.addMessage — notification fan-out", () => {
  it("PUBLIC reply on PLATFORM ticket: customer + assigned Ops + SUPER_ADMIN; NO Finance", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PLATFORM",
      assignedToUserId: "ops1",
      assignedPublisherId: null,
    })
    const prisma = mockPrisma({
      ticket,
      customerOrgMembers: ["customer1", "orgOwner"],
      staff: { superAdmins: ["admin1"], finance: ["fin1", "fin2"] },
    })
    const queue = mockQueue()
    const svc = new SupportService(prisma as any, queue as any, mockAudit() as any)
    await svc.addMessage(ticket.id, staffActor("SUPER_ADMIN", "admin1"), { content: "answer" })

    const recipients = queue._jobs.map((j) => j[2].userId).sort()
    expect(recipients).toEqual(["customer1", "ops1", "orgOwner"].sort())
    expect(recipients).not.toContain("fin1")
    expect(recipients).not.toContain("fin2")
  })

  it("PUBLIC reply on PUBLISHER ticket: customer + publisher members + SUPER_ADMIN + FINANCE", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PUBLISHER",
      assignedToUserId: null,
      assignedPublisherId: "pub1",
    })
    const prisma = mockPrisma({
      ticket,
      customerOrgMembers: ["customer1", "orgOwner"],
      publisherMembers: ["pubowner1", "pubmember"],
      staff: { superAdmins: ["admin1"], finance: ["fin1"] },
    })
    const queue = mockQueue()
    const svc = new SupportService(prisma as any, queue as any, mockAudit() as any)
    await svc.addMessage(ticket.id, staffActor("SUPER_ADMIN", "admin1"), { content: "reply" })

    const recipients = queue._jobs.map((j) => j[2].userId).sort()
    expect(recipients).toEqual(
      ["customer1", "orgOwner", "pubowner1", "pubmember", "fin1"].sort(),
    )
    // admin1 (the actor) is excluded — no self-notification.
    expect(recipients).not.toContain("admin1")
  })

  it("INTERNAL note on PLATFORM ticket: assigned Ops + SUPER_ADMIN + FINANCE; NO customer, NO publisher", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PLATFORM",
      assignedToUserId: "ops1",
    })
    const prisma = mockPrisma({
      ticket,
      customerOrgMembers: ["customer1"],
      staff: { superAdmins: ["admin1"], finance: ["fin1"] },
    })
    const queue = mockQueue()
    const svc = new SupportService(prisma as any, queue as any, mockAudit() as any)
    await svc.addMessage(ticket.id, staffActor("FINANCE", "fin1"), {
      content: "flag for admin",
      visibility: "INTERNAL",
    })

    const recipients = queue._jobs.map((j) => j[2].userId).sort()
    expect(recipients).toEqual(["admin1", "ops1"].sort())
    expect(recipients).not.toContain("customer1")
    expect(recipients).not.toContain("fin1") // actor excluded
  })

  it("INTERNAL note on PUBLISHER ticket: SUPER_ADMIN + FINANCE only; NO customer, NO publisher", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PUBLISHER",
      assignedToUserId: null,
      assignedPublisherId: "pub1",
    })
    const prisma = mockPrisma({
      ticket,
      customerOrgMembers: ["customer1"],
      publisherMembers: ["pubowner1"],
      staff: { superAdmins: ["admin1"], finance: ["fin1", "fin2"] },
    })
    const queue = mockQueue()
    const svc = new SupportService(prisma as any, queue as any, mockAudit() as any)
    await svc.addMessage(ticket.id, staffActor("SUPER_ADMIN", "admin1"), {
      content: "fyi finance",
      visibility: "INTERNAL",
    })

    const recipients = queue._jobs.map((j) => j[2].userId).sort()
    expect(recipients).toEqual(["fin1", "fin2"].sort())
    expect(recipients).not.toContain("customer1")
    expect(recipients).not.toContain("pubowner1")
    expect(recipients).not.toContain("admin1") // actor excluded
  })

  it("dedupes a user who holds multiple roles to a single notification (fixes Set<object>-identity bug)", async () => {
    // admin1 is both a SUPER_ADMIN and a customer org member.
    const ticket = makeTicket({
      fulfillmentChannel: "PLATFORM",
      assignedToUserId: "ops1",
    })
    const prisma = mockPrisma({
      ticket,
      customerOrgMembers: ["customer1", "admin1"], // admin1 wears both hats
      staff: { superAdmins: ["admin1"], finance: [] },
    })
    const queue = mockQueue()
    const svc = new SupportService(prisma as any, queue as any, mockAudit() as any)
    // Ops replies — admin1 should be notified ONCE despite holding two roles.
    await svc.addMessage(ticket.id, staffActor("OPERATIONS", "ops1"), { content: "update" })

    const recipients = queue._jobs.map((j) => j[2].userId)
    const admin1Count = recipients.filter((r) => r === "admin1").length
    expect(admin1Count).toBe(1)
  })
})

// ─── Phase 6.6.1 — participantRole + messageType ───────────────────────────

describe("resolveParticipantRole (pure helper)", () => {
  it("maps CUSTOMER actor → CUSTOMER", () => {
    expect(resolveParticipantRole(customerActor())).toBe("CUSTOMER")
  })
  it("maps PUBLISHER actor → PUBLISHER", () => {
    expect(resolveParticipantRole(publisherActor("pub1"))).toBe("PUBLISHER")
  })
  it("maps STAFF SUPER_ADMIN → ADMIN", () => {
    expect(resolveParticipantRole(staffActor("SUPER_ADMIN"))).toBe("ADMIN")
  })
  it("maps STAFF OPERATIONS → OPS", () => {
    expect(resolveParticipantRole(staffActor("OPERATIONS"))).toBe("OPS")
  })
  it("maps STAFF FINANCE → FINANCE", () => {
    expect(resolveParticipantRole(staffActor("FINANCE"))).toBe("FINANCE")
  })
  it("refuses STAFF actor without a staffRole (forces caller to gate first)", () => {
    expect(() =>
      resolveParticipantRole({ userId: "x", kind: "STAFF", staffRole: null }),
    ).toThrow(ForbiddenException)
  })
})

describe("SupportService.addMessage — participantRole + messageType snapshot", () => {
  it("CUSTOMER PUBLIC → (CUSTOMER, MESSAGE, PUBLIC)", async () => {
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
    const prisma = mockPrisma({ ticket })
    const audit = mockAudit()
    const svc = new SupportService(prisma as any, mockQueue() as any, audit as any)
    const msg = await svc.addMessage(ticket.id, customerActor(), { content: "hi" })
    expect(msg.participantRole).toBe("CUSTOMER")
    expect(msg.messageType).toBe("MESSAGE")
    expect(msg.visibility).toBe("PUBLIC")
    // Audit metadata mirrors the row so reports never disagree.
    expect(audit._rows[0].metadata.participantRole).toBe("CUSTOMER")
    expect(audit._rows[0].metadata.messageType).toBe("MESSAGE")
  })

  it("PUBLISHER PUBLIC → (PUBLISHER, MESSAGE, PUBLIC)", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PUBLISHER",
      assignedToUserId: null,
      assignedPublisherId: "pub1",
    })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const msg = await svc.addMessage(ticket.id, publisherActor("pub1"), { content: "ok" })
    expect(msg.participantRole).toBe("PUBLISHER")
    expect(msg.messageType).toBe("MESSAGE")
  })

  it("OPS PUBLIC on assigned ticket → (OPS, MESSAGE, PUBLIC)", async () => {
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM", assignedToUserId: "opsA" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const msg = await svc.addMessage(ticket.id, staffActor("OPERATIONS", "opsA"), {
      content: "fixing it",
    })
    expect(msg.participantRole).toBe("OPS")
    expect(msg.messageType).toBe("MESSAGE")
  })

  it("ADMIN PUBLIC → (ADMIN, MESSAGE, PUBLIC)", async () => {
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const msg = await svc.addMessage(ticket.id, staffActor("SUPER_ADMIN", "adm1"), {
      content: "stepping in",
    })
    expect(msg.participantRole).toBe("ADMIN")
    expect(msg.messageType).toBe("MESSAGE")
  })

  it("FINANCE PUBLIC on PUBLISHER → (FINANCE, MESSAGE, PUBLIC)", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PUBLISHER",
      assignedPublisherId: "pub1",
    })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const msg = await svc.addMessage(ticket.id, staffActor("FINANCE"), {
      content: "billing reply",
    })
    expect(msg.participantRole).toBe("FINANCE")
    expect(msg.messageType).toBe("MESSAGE")
    expect(msg.visibility).toBe("PUBLIC")
  })

  it("FINANCE INTERNAL on PLATFORM → (FINANCE, INTERNAL_NOTE, INTERNAL)", async () => {
    // The escape valve: Finance is read-only on PLATFORM tickets for the
    // customer thread, but INTERNAL is allowed. The triple captures that.
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
    const prisma = mockPrisma({ ticket })
    const audit = mockAudit()
    const svc = new SupportService(prisma as any, mockQueue() as any, audit as any)
    const msg = await svc.addMessage(ticket.id, staffActor("FINANCE"), {
      content: "Settlement amount looks off, flagging for admin.",
      visibility: "INTERNAL",
    })
    expect(msg.participantRole).toBe("FINANCE")
    expect(msg.messageType).toBe("INTERNAL_NOTE")
    expect(msg.visibility).toBe("INTERNAL")
    expect(audit._rows[0].action).toBe("TICKET_INTERNAL_NOTE_ADDED")
    expect(audit._rows[0].metadata.participantRole).toBe("FINANCE")
    expect(audit._rows[0].metadata.messageType).toBe("INTERNAL_NOTE")
  })

  it("OPS INTERNAL on assigned PLATFORM → (OPS, INTERNAL_NOTE, INTERNAL)", async () => {
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM", assignedToUserId: "opsA" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const msg = await svc.addMessage(ticket.id, staffActor("OPERATIONS", "opsA"), {
      content: "Publisher unresponsive — escalating",
      visibility: "INTERNAL",
    })
    expect(msg.participantRole).toBe("OPS")
    expect(msg.messageType).toBe("INTERNAL_NOTE")
  })

  it("snapshot is immutable: role at write time persists even when actor role would later differ", async () => {
    // Today the actor is OPS. Tomorrow they get promoted to SUPER_ADMIN. The
    // row written today must still say OPS — we never derive dynamically.
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM", assignedToUserId: "alice" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const msg = await svc.addMessage(ticket.id, staffActor("OPERATIONS", "alice"), {
      content: "Delivery verified",
    })
    expect(msg.participantRole).toBe("OPS")
    // The row in the DB is the snapshot — checked via the mock's _created log.
    expect(prisma._created[0].participantRole).toBe("OPS")
  })
})

// ─── Phase 6.6.2 — actorSnapshot ────────────────────────────────────────────

describe("buildActorSnapshot (pure helper)", () => {
  it("CUSTOMER OWNER → { kind:CUSTOMER, staffRole:null, organizationRole:OWNER, publisherRole:null }", () => {
    expect(buildActorSnapshot(customerActor("orgA", "c1", "OWNER"))).toEqual({
      kind: "CUSTOMER",
      staffRole: null,
      organizationRole: "OWNER",
      publisherRole: null,
    })
  })
  it("CUSTOMER MEMBER → organizationRole:MEMBER", () => {
    expect(buildActorSnapshot(customerActor("orgA", "c1", "MEMBER"))).toEqual({
      kind: "CUSTOMER",
      staffRole: null,
      organizationRole: "MEMBER",
      publisherRole: null,
    })
  })
  it("PUBLISHER PUBLISHER_OWNER → publisherRole:PUBLISHER_OWNER", () => {
    expect(buildActorSnapshot(publisherActor("pub1", "p1", "PUBLISHER_OWNER"))).toEqual({
      kind: "PUBLISHER",
      staffRole: null,
      organizationRole: null,
      publisherRole: "PUBLISHER_OWNER",
    })
  })
  it("PUBLISHER PUBLISHER_MEMBER → publisherRole:PUBLISHER_MEMBER", () => {
    expect(buildActorSnapshot(publisherActor("pub1", "p1", "PUBLISHER_MEMBER"))).toEqual({
      kind: "PUBLISHER",
      staffRole: null,
      organizationRole: null,
      publisherRole: "PUBLISHER_MEMBER",
    })
  })
  it("STAFF SUPER_ADMIN → staffRole:SUPER_ADMIN (note: participantRole collapses to ADMIN, snapshot preserves raw)", () => {
    expect(buildActorSnapshot(staffActor("SUPER_ADMIN"))).toEqual({
      kind: "STAFF",
      staffRole: "SUPER_ADMIN",
      organizationRole: null,
      publisherRole: null,
    })
  })
  it("STAFF OPERATIONS → staffRole:OPERATIONS (participantRole collapses to OPS)", () => {
    expect(buildActorSnapshot(staffActor("OPERATIONS"))).toEqual({
      kind: "STAFF",
      staffRole: "OPERATIONS",
      organizationRole: null,
      publisherRole: null,
    })
  })
  it("STAFF FINANCE → staffRole:FINANCE", () => {
    expect(buildActorSnapshot(staffActor("FINANCE"))).toEqual({
      kind: "STAFF",
      staffRole: "FINANCE",
      organizationRole: null,
      publisherRole: null,
    })
  })
  it("missing optional roles default to null (stable JSON shape)", () => {
    const bare: SupportActor = { userId: "u1", kind: "CUSTOMER", organizationId: "orgA" }
    expect(buildActorSnapshot(bare)).toEqual({
      kind: "CUSTOMER",
      staffRole: null,
      organizationRole: null,
      publisherRole: null,
    })
  })
})

describe("SupportService.addMessage — actorSnapshot persisted on row", () => {
  it("CUSTOMER OWNER → row carries { kind:CUSTOMER, organizationRole:OWNER }", async () => {
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    await svc.addMessage(ticket.id, customerActor("orgA", "c1", "OWNER"), { content: "hi" })
    expect(prisma._created[0].actorSnapshot).toEqual({
      kind: "CUSTOMER",
      staffRole: null,
      organizationRole: "OWNER",
      publisherRole: null,
    })
  })

  it("PUBLISHER PUBLISHER_MEMBER → row carries { kind:PUBLISHER, publisherRole:PUBLISHER_MEMBER }", async () => {
    const ticket = makeTicket({
      fulfillmentChannel: "PUBLISHER",
      assignedToUserId: null,
      assignedPublisherId: "pub1",
    })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    await svc.addMessage(ticket.id, publisherActor("pub1", "p1", "PUBLISHER_MEMBER"), {
      content: "on it",
    })
    expect(prisma._created[0].actorSnapshot).toEqual({
      kind: "PUBLISHER",
      staffRole: null,
      organizationRole: null,
      publisherRole: "PUBLISHER_MEMBER",
    })
  })

  it("STAFF FINANCE INTERNAL on PLATFORM → row carries { kind:STAFF, staffRole:FINANCE }", async () => {
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
    const prisma = mockPrisma({ ticket })
    const audit = mockAudit()
    const svc = new SupportService(prisma as any, mockQueue() as any, audit as any)
    await svc.addMessage(ticket.id, staffActor("FINANCE"), {
      content: "settlement amount off",
      visibility: "INTERNAL",
    })
    expect(prisma._created[0].actorSnapshot).toEqual({
      kind: "STAFF",
      staffRole: "FINANCE",
      organizationRole: null,
      publisherRole: null,
    })
    // Audit metadata mirrors the row.
    expect(audit._rows[0].metadata.actorSnapshot).toEqual({
      kind: "STAFF",
      staffRole: "FINANCE",
      organizationRole: null,
      publisherRole: null,
    })
  })

  it("captures raw staffRole even though participantRole collapses (SUPER_ADMIN → ADMIN)", async () => {
    // The forensic value: years later, "was this person SUPER_ADMIN or
    // something else at the time?" The snapshot answers without joining
    // StaffMembership history.
    const ticket = makeTicket({ fulfillmentChannel: "PLATFORM" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    await svc.addMessage(ticket.id, staffActor("SUPER_ADMIN", "adm1"), {
      content: "stepping in",
    })
    expect(prisma._created[0].participantRole).toBe("ADMIN")
    expect(prisma._created[0].actorSnapshot.staffRole).toBe("SUPER_ADMIN")
  })

  it("snapshot is immutable: stored as JSON copy, not a reference to the live actor", async () => {
    // If we ever mutate the actor object post-write (unlikely but defensible),
    // the row's snapshot must be unaffected. Verifies we're storing a value,
    // not holding a reference.
    const ticket = makeTicket({ fulfillmentChannel: "PUBLISHER", assignedPublisherId: "pub1" })
    const prisma = mockPrisma({ ticket })
    const svc = new SupportService(prisma as any, mockQueue() as any, mockAudit() as any)
    const actor = publisherActor("pub1", "p1", "PUBLISHER_OWNER")
    await svc.addMessage(ticket.id, actor, { content: "ok" })
    // Mutate the live actor after the write.
    ;(actor as any).publisherRole = "PUBLISHER_MEMBER"
    // The persisted row still reflects what was true at write time.
    expect(prisma._created[0].actorSnapshot.publisherRole).toBe("PUBLISHER_OWNER")
  })
})
