import crypto from "node:crypto"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common"
import {
  makeOrder,
  makeOrganization,
  makePublisher,
  makeUser,
  makeWebsite,
} from "../factories"
import { createTestApp } from "../helpers/create-test-app"

jest.retryTimes(2)

async function addCustomerMembership(
  prisma: any,
  userId: string,
  organizationId: string,
) {
  await prisma.membership.create({
    data: { userId, organizationId, role: "OWNER", status: "ACTIVE" },
  })
}

async function addStaff(
  prisma: any,
  role: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE",
  name: string,
) {
  const user = await makeUser(prisma, { userType: "STAFF", name })
  await prisma.staffMembership.create({ data: { userId: user.id, role } })
  return user
}

describe("[INTEGRATION] Support messaging projections and commands", () => {
  it("paginates the public inbox by public activity without gaps, duplicates, or internal-note influence", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, {
        userType: "CUSTOMER",
        name: "Customer",
      })
      await addCustomerMembership(prisma, customer.id, organization.id)
      const administrator = await addStaff(
        prisma,
        "SUPER_ADMIN",
        "Support Admin",
      )
      const base = new Date("2026-08-13T00:00:00.000Z").getTime()
      const ticketRows = [
        { id: "public-list-alpha", createdOffset: 1_000 },
        { id: "public-list-beta", createdOffset: 2_000 },
        { id: "public-list-gamma", createdOffset: 3_000 },
        { id: "public-list-delta", createdOffset: 7_000 },
        { id: "public-list-epsilon", createdOffset: 6_000 },
      ]
      await prisma.ticket.createMany({
        data: ticketRows.map((row) => ({
          id: row.id,
          subject: `Ticket ${row.id}`,
          description: `Opening message for ${row.id}.`,
          userId: customer.id,
          organizationId: organization.id,
          fulfillmentChannel: "PLATFORM",
          createdAt: new Date(base + row.createdOffset),
          updatedAt: new Date(base + row.createdOffset),
        })),
      })
      await prisma.ticketMessage.createMany({
        data: [
          { id: "activity-alpha", ticketId: "public-list-alpha", at: 10_000 },
          { id: "activity-beta", ticketId: "public-list-beta", at: 9_000 },
          { id: "activity-gamma", ticketId: "public-list-gamma", at: 8_000 },
        ].map((row) => ({
          id: row.id,
          ticketId: row.ticketId,
          userId: customer.id,
          content: `Public activity for ${row.ticketId}`,
          visibility: "PUBLIC",
          participantRole: "CUSTOMER",
          messageType: "MESSAGE",
          actorSnapshot: {
            kind: "CUSTOMER",
            staffRole: null,
            organizationRole: "OWNER",
            publisherRole: null,
          },
          createdAt: new Date(base + row.at),
        })),
      })

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SupportService,
      } = require("../../../modules/support/support.service")
      const support: any = app.get(SupportService)
      await support.addMessage(
        "public-list-beta",
        {
          userId: administrator.id,
          kind: "STAFF",
          staffRole: "SUPER_ADMIN",
        },
        {
          clientMessageId: crypto.randomUUID(),
          content:
            "This newer internal investigation must not affect the public inbox.",
          visibility: "INTERNAL",
        },
      )

      const actor = {
        userId: customer.id,
        kind: "CUSTOMER",
        organizationId: organization.id,
        customerRole: "OWNER",
      }
      const pages: any[] = []
      let cursor: string | undefined
      do {
        const page = await support.listTickets(actor, { limit: 2, cursor })
        pages.push(page)
        cursor = page.nextCursor ?? undefined
      } while (cursor)

      expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1])
      expect(pages.map((page) => page.limit)).toEqual([2, 2, 2])
      expect(pages.slice(0, -1).every((page) => page.nextCursor)).toBe(true)
      expect(pages.at(-1).nextCursor).toBeNull()
      const items = pages.flatMap((page) => page.items)
      expect(items.map((item: any) => item.id)).toEqual([
        "public-list-alpha",
        "public-list-beta",
        "public-list-gamma",
        "public-list-delta",
        "public-list-epsilon",
      ])
      expect(new Set(items.map((item: any) => item.id)).size).toBe(5)
      expect(new Date(items[1].updatedAt).toISOString()).toBe(
        new Date(base + 9_000).toISOString(),
      )
      expect(JSON.stringify(items)).not.toContain(
        "newer internal investigation",
      )
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("keeps public pages private and ordered while preserving explicit sender parties", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const customerOrganization = await makeOrganization(prisma)
      const publisherOrganization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, {
        userType: "CUSTOMER",
        name: "Customer Alice",
      })
      await addCustomerMembership(prisma, customer.id, customerOrganization.id)
      const publisher = await makePublisher(prisma, {
        organizationId: publisherOrganization.id,
        name: "Example Publisher",
      })
      const publisherUser = await makeUser(prisma, {
        userType: "PUBLISHER",
        name: "Publisher Pat",
      })
      await prisma.publisherMembership.create({
        data: {
          userId: publisherUser.id,
          publisherId: publisher.id,
          role: "PUBLISHER_OWNER",
        },
      })
      const administrator = await addStaff(
        prisma,
        "SUPER_ADMIN",
        "Support Admin",
      )
      const finance = await addStaff(prisma, "FINANCE", "Finance User")

      const ticket = await prisma.ticket.create({
        data: {
          subject: "Placement status",
          description: "Please confirm the current placement status.",
          userId: customer.id,
          organizationId: customerOrganization.id,
          fulfillmentChannel: "PUBLISHER",
          assignedPublisherId: publisher.id,
        },
      })

      const base = new Date("2026-08-14T00:00:00.000Z").getTime()
      const publicMessages = Array.from({ length: 205 }, (_, index) => {
        const publisherAuthored = index >= 203
        return {
          id: `public-${String(index).padStart(3, "0")}`,
          ticketId: ticket.id,
          userId:
            index === 203
              ? null
              : publisherAuthored
                ? publisherUser.id
                : customer.id,
          content: `Public message ${index}`,
          visibility: "PUBLIC" as const,
          participantRole: publisherAuthored
            ? ("PUBLISHER" as const)
            : ("CUSTOMER" as const),
          messageType: "MESSAGE" as const,
          actorSnapshot: publisherAuthored
            ? {
                kind: "PUBLISHER",
                staffRole: null,
                organizationRole: null,
                publisherRole: "PUBLISHER_OWNER",
              }
            : {
                kind: "CUSTOMER",
                staffRole: null,
                organizationRole: "OWNER",
                publisherRole: null,
              },
          createdAt: new Date(base + index * 1_000),
        }
      })
      await prisma.ticketMessage.createMany({ data: publicMessages })
      await prisma.ticketMessage.create({
        data: {
          id: "internal-newest",
          ticketId: ticket.id,
          userId: administrator.id,
          content: "Internal investigation evidence",
          visibility: "INTERNAL",
          participantRole: "ADMIN",
          messageType: "INTERNAL_NOTE",
          actorSnapshot: {
            kind: "STAFF",
            staffRole: "SUPER_ADMIN",
            organizationRole: null,
            publisherRole: null,
          },
          createdAt: new Date(base + 1_000_000),
        },
      })

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SupportService,
      } = require("../../../modules/support/support.service")
      const support: any = app.get(SupportService)
      const customerActor = {
        userId: customer.id,
        kind: "CUSTOMER",
        organizationId: customerOrganization.id,
        customerRole: "OWNER",
      }
      const publisherActor = {
        userId: publisherUser.id,
        kind: "PUBLISHER",
        publisherId: publisher.id,
        publisherRole: "PUBLISHER_OWNER",
      }

      const firstPage = await support.getTicket(ticket.id, customerActor)
      expect(firstPage.messages).toHaveLength(200)
      expect(firstPage.messages[0].id).toBe("public-005")
      expect(firstPage.messages.at(-1).id).toBe("public-204")
      expect(
        firstPage.messages.every(
          (message: any) => message.visibility === "PUBLIC",
        ),
      ).toBe(true)
      expect(
        firstPage.messages.some(
          (message: any) => message.id === "internal-newest",
        ),
      ).toBe(false)
      expect(firstPage.messagePage).toMatchObject({ limit: 200 })
      expect(firstPage.messagePage.nextCursor).toEqual(expect.any(String))
      expect(firstPage.openingMessage.sender).toEqual({
        party: "CUSTOMER",
        displayName: "You",
        isSelf: true,
      })
      expect(firstPage.messages.at(-1).sender).toEqual({
        party: "PUBLISHER",
        displayName: "Publisher",
        isSelf: false,
      })
      expect(firstPage.messages.at(-2).sender).toEqual({
        party: "PUBLISHER",
        displayName: "Publisher",
        isSelf: false,
      })

      const olderPage = await support.getTicket(ticket.id, customerActor, {
        messageCursor: firstPage.messagePage.nextCursor,
      })
      expect(olderPage.messages.map((message: any) => message.id)).toEqual(
        Array.from(
          { length: 5 },
          (_, index) => `public-${String(index).padStart(3, "0")}`,
        ),
      )
      expect(olderPage.messagePage.nextCursor).toBeNull()
      const chronologicalIds = [
        ...olderPage.messages,
        ...firstPage.messages,
      ].map((message: any) => message.id)
      expect(new Set(chronologicalIds).size).toBe(205)
      expect(chronologicalIds).toEqual(
        Array.from(
          { length: 205 },
          (_, index) => `public-${String(index).padStart(3, "0")}`,
        ),
      )

      for (const key of [
        "description",
        "user",
        "requester",
        "organization",
        "assignedTo",
        "assignedPublisher",
      ]) {
        expect(firstPage).not.toHaveProperty(key)
      }
      for (const message of [firstPage.openingMessage, ...firstPage.messages]) {
        expect(message).not.toHaveProperty("user")
        expect(message).not.toHaveProperty("files")
        expect(message).not.toHaveProperty("participantRole")
        expect(message).not.toHaveProperty("actorSnapshot")
        expect(message).not.toHaveProperty("authorEvidence")
      }

      const publisherPage = await support.getTicket(ticket.id, publisherActor)
      expect(publisherPage.openingMessage.sender).toMatchObject({
        party: "CUSTOMER",
        isSelf: false,
      })
      expect(publisherPage.messages.at(-1).sender).toMatchObject({
        party: "PUBLISHER",
        isSelf: true,
      })
      expect(
        publisherPage.messages.some(
          (message: any) => message.visibility === "INTERNAL",
        ),
      ).toBe(false)

      const staffPage = await support.getTicket(ticket.id, {
        userId: administrator.id,
        kind: "STAFF",
        staffRole: "SUPER_ADMIN",
      })
      const internal = staffPage.messages.find(
        (message: any) => message.id === "internal-newest",
      )
      expect(internal).toMatchObject({
        visibility: "INTERNAL",
        messageType: "INTERNAL_NOTE",
        participantRole: "ADMIN",
        sender: { party: "SUPPORT", isSelf: true },
        authorEvidence: {
          userId: administrator.id,
          email: administrator.email,
        },
      })
      expect(staffPage.requester).toMatchObject({
        displayName: "Customer Alice",
        userId: customer.id,
        email: customer.email,
      })

      await expect(
        support.getTicket(ticket.id, {
          userId: finance.id,
          kind: "STAFF",
          staffRole: "FINANCE",
        }),
      ).rejects.toBeInstanceOf(ForbiddenException)
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("deduplicates exact commands and rejects mismatched key reuse or publisher order access", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const customerOrganization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, {
        userType: "CUSTOMER",
        name: "Customer",
      })
      await addCustomerMembership(prisma, customer.id, customerOrganization.id)
      await addStaff(prisma, "SUPER_ADMIN", "Support Admin")

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SupportService,
      } = require("../../../modules/support/support.service")
      const support: any = app.get(SupportService)
      const customerActor = {
        userId: customer.id,
        kind: "CUSTOMER",
        organizationId: customerOrganization.id,
        customerRole: "OWNER",
      }
      const clientRequestId = crypto.randomUUID()
      const first = await support.createTicket(customerActor, {
        clientRequestId,
        subject: "  Access café  ",
        description: "  Please help\r\nwith this support request.  ",
      })
      const replay = await support.createTicket(customerActor, {
        clientRequestId,
        subject: "Access café",
        description: "Please help\nwith this support request.",
      })
      expect(replay).toEqual(first)
      expect(await prisma.ticket.count({ where: { id: first.id } })).toBe(1)
      expect(
        await prisma.auditLog.count({
          where: { action: "TICKET_OPENED", entityId: first.id },
        }),
      ).toBe(1)
      await expect(
        support.createTicket(customerActor, {
          clientRequestId,
          subject: "Different request",
          description: "Please help with this different support request.",
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      const clientMessageId = crypto.randomUUID()
      const firstMessage = await support.addMessage(first.id, customerActor, {
        clientMessageId,
        content: "  Café\r\nreply  ",
      })
      const replayedMessage = await support.addMessage(
        first.id,
        customerActor,
        { clientMessageId, content: "Café\nreply" },
      )
      expect(replayedMessage).toEqual(firstMessage)
      expect(
        await prisma.ticketMessage.count({ where: { id: firstMessage.id } }),
      ).toBe(1)
      expect(
        await prisma.auditLog.count({
          where: { action: "TICKET_MESSAGE_ADDED", entityId: firstMessage.id },
        }),
      ).toBe(1)
      await expect(
        support.addMessage(first.id, customerActor, {
          clientMessageId,
          content: "A different reply",
        }),
      ).rejects.toBeInstanceOf(ConflictException)

      const publisherOrganization = await makeOrganization(prisma)
      const publisher = await makePublisher(prisma, {
        organizationId: publisherOrganization.id,
      })
      const publisherUser = await makeUser(prisma, { userType: "PUBLISHER" })
      await prisma.publisherMembership.create({
        data: {
          userId: publisherUser.id,
          publisherId: publisher.id,
          role: "PUBLISHER_OWNER",
        },
      })
      const website = await makeWebsite(prisma, {
        ownershipType: "PUBLISHER",
        publisherId: publisher.id,
      })
      const publisherOrder = await makeOrder(prisma, {
        organizationId: customerOrganization.id,
        customerId: customer.id,
        websiteId: website.id,
        fulfillmentChannel: "PUBLISHER",
      })
      const publisherActor = {
        userId: publisherUser.id,
        kind: "PUBLISHER",
        publisherId: publisher.id,
        publisherRole: "PUBLISHER_OWNER",
      }
      const publisherTicket = await support.createTicket(publisherActor, {
        clientRequestId: crypto.randomUUID(),
        subject: "Publisher order question",
        description: "Please clarify the requested placement details.",
        orderId: publisherOrder.id,
      })
      expect(
        await prisma.ticket.findUniqueOrThrow({
          where: { id: publisherTicket.id },
          select: { assignedPublisherId: true, organizationId: true },
        }),
      ).toEqual({
        assignedPublisherId: publisher.id,
        organizationId: customerOrganization.id,
      })
      await expect(
        support.createTicket(publisherActor, {
          clientRequestId: crypto.randomUUID(),
          subject: "General publisher question",
          description: "This must not create an unscoped publisher ticket.",
        }),
      ).rejects.toBeInstanceOf(BadRequestException)

      const foreignOrganization = await makeOrganization(prisma)
      const foreignPublisher = await makePublisher(prisma, {
        organizationId: foreignOrganization.id,
      })
      const foreignUser = await makeUser(prisma, { userType: "PUBLISHER" })
      await prisma.publisherMembership.create({
        data: {
          userId: foreignUser.id,
          publisherId: foreignPublisher.id,
          role: "PUBLISHER_OWNER",
        },
      })
      await expect(
        support.createTicket(
          {
            userId: foreignUser.id,
            kind: "PUBLISHER",
            publisherId: foreignPublisher.id,
            publisherRole: "PUBLISHER_OWNER",
          },
          {
            clientRequestId: crypto.randomUUID(),
            subject: "Foreign order question",
            description:
              "This publisher must not learn whether the order exists.",
            orderId: publisherOrder.id,
          },
        ),
      ).rejects.toBeInstanceOf(NotFoundException)

      const platformWebsite = await makeWebsite(prisma, {
        ownershipType: "PLATFORM",
      })
      const platformOrder = await makeOrder(prisma, {
        organizationId: customerOrganization.id,
        customerId: customer.id,
        websiteId: platformWebsite.id,
        fulfillmentChannel: "PLATFORM",
      })
      await expect(
        support.createTicket(publisherActor, {
          clientRequestId: crypto.randomUUID(),
          subject: "Platform order question",
          description: "A publisher must not join this Platform conversation.",
          orderId: platformOrder.id,
        }),
      ).rejects.toBeInstanceOf(NotFoundException)
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe("[INTEGRATION] Support and fulfillment assignment serialization", () => {
  it("releases CLOSED support on Operations demotion so a reopened general ticket can be claimed", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      await addCustomerMembership(prisma, customer.id, organization.id)
      const previousOwner = await addStaff(
        prisma,
        "OPERATIONS",
        "Previous Operations owner",
      )
      const nextOwner = await addStaff(
        prisma,
        "OPERATIONS",
        "Next Operations owner",
      )
      const administrator = await addStaff(
        prisma,
        "SUPER_ADMIN",
        "Administrator",
      )
      const ticket = await prisma.ticket.create({
        data: {
          subject: "Closed ticket awaiting possible reopen",
          description:
            "This ticket should return to the claim queue if reopened.",
          status: "CLOSED",
          userId: customer.id,
          organizationId: organization.id,
          fulfillmentChannel: "PLATFORM",
          assignedToUserId: previousOwner.id,
        },
      })

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AdminService } = require("../../../modules/admin/admin.service")
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SupportService,
      } = require("../../../modules/support/support.service")
      const administration: any = app.get(AdminService)
      const support: any = app.get(SupportService)

      await administration.updateStaffRole(previousOwner.id, "FINANCE", {
        id: administrator.id,
      })
      expect(
        await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
      ).toMatchObject({ status: "CLOSED", assignedToUserId: null })
      const offboardingAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: "STAFF_ROLE_UPDATE",
          userId: administrator.id,
        },
        orderBy: { createdAt: "desc" },
      })
      expect(offboardingAudit.metadata).toMatchObject({
        userId: previousOwner.id,
        releasedClosedSupportTickets: 1,
      })

      await support.updateExternalStatus(ticket.id, "OPEN", {
        userId: customer.id,
        kind: "CUSTOMER",
        organizationId: organization.id,
        customerRole: "OWNER",
      })
      const nextOwnerView = await support.getTicket(ticket.id, {
        userId: nextOwner.id,
        kind: "STAFF",
        staffRole: "OPERATIONS",
      })
      expect(nextOwnerView.capabilities).toMatchObject({
        canClaim: true,
        canReply: false,
      })
      await support.claimTicket(ticket.id, {
        userId: nextOwner.id,
        kind: "STAFF",
        staffRole: "OPERATIONS",
      })
      expect(
        await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
      ).toMatchObject({
        status: "OPEN",
        assignedToUserId: nextOwner.id,
      })
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("serializes Operations demotion against a CLOSED-ticket reopen without orphaning ownership", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      await addCustomerMembership(prisma, customer.id, organization.id)
      const operations = await addStaff(
        prisma,
        "OPERATIONS",
        "Operations owner",
      )
      const administrator = await addStaff(
        prisma,
        "SUPER_ADMIN",
        "Administrator",
      )
      const ticket = await prisma.ticket.create({
        data: {
          subject: "Concurrent offboarding and reopen",
          description:
            "The winning serialization order must remain safely routed.",
          status: "CLOSED",
          userId: customer.id,
          organizationId: organization.id,
          fulfillmentChannel: "PLATFORM",
          assignedToUserId: operations.id,
        },
      })

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AdminService } = require("../../../modules/admin/admin.service")
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SupportService,
      } = require("../../../modules/support/support.service")
      const administration: any = app.get(AdminService)
      const support: any = app.get(SupportService)
      const [demotion, reopen] = await Promise.allSettled([
        administration.updateStaffRole(operations.id, "FINANCE", {
          id: administrator.id,
        }),
        support.updateExternalStatus(ticket.id, "OPEN", {
          userId: customer.id,
          kind: "CUSTOMER",
          organizationId: organization.id,
          customerRole: "OWNER",
        }),
      ])
      expect(reopen.status).toBe("fulfilled")

      const [membership, currentTicket] = await Promise.all([
        prisma.staffMembership.findUniqueOrThrow({
          where: { userId: operations.id },
        }),
        prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
      ])
      expect(currentTicket.status).toBe("OPEN")
      if (demotion.status === "fulfilled") {
        expect(membership.role).toBe("FINANCE")
        expect(currentTicket.assignedToUserId).toBeNull()
      } else {
        expect(demotion.reason).toBeInstanceOf(ConflictException)
        expect(membership.role).toBe("OPERATIONS")
        expect(currentTicket.assignedToUserId).toBe(operations.id)
      }
    } finally {
      await cleanup()
    }
  }, 30_000)

  it("keeps order ticket ownership equal to the active assignment through claim, reply, status, and reassign races", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const organization = await makeOrganization(prisma)
      const customer = await makeUser(prisma, { userType: "CUSTOMER" })
      await addCustomerMembership(prisma, customer.id, organization.id)
      const operationsA = await addStaff(prisma, "OPERATIONS", "Operations A")
      const operationsB = await addStaff(prisma, "OPERATIONS", "Operations B")
      const administrator = await addStaff(
        prisma,
        "SUPER_ADMIN",
        "Administrator",
      )
      const website = await makeWebsite(prisma, { ownershipType: "PLATFORM" })
      const order = await makeOrder(prisma, {
        organizationId: organization.id,
        customerId: customer.id,
        websiteId: website.id,
        fulfillmentChannel: "PLATFORM",
      })

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        SupportService,
      } = require("../../../modules/support/support.service")
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const {
        OrderFulfillmentAssignmentService,
      } = require("../../../modules/orders/services/order-fulfillment-assignment.service")
      const support: any = app.get(SupportService)
      const assignments: any = app.get(OrderFulfillmentAssignmentService)
      const customerActor = {
        userId: customer.id,
        kind: "CUSTOMER",
        organizationId: organization.id,
        customerRole: "OWNER",
      }
      const operationsActor = (userId: string) => ({
        userId,
        kind: "STAFF",
        staffRole: "OPERATIONS",
      })

      const [createOutcome, claimOutcome] = await Promise.allSettled([
        support.createTicket(customerActor, {
          clientRequestId: crypto.randomUUID(),
          subject: "Concurrent Platform order support",
          description: "Please help with this Platform fulfillment order.",
          orderId: order.id,
        }),
        assignments.claim(order.id, operationsA.id, "OPERATIONS"),
      ])
      expect(createOutcome.status).toBe("fulfilled")
      expect(claimOutcome.status).toBe("fulfilled")

      const ticket = await prisma.ticket.findFirstOrThrow({
        where: { orderId: order.id },
      })
      let activeAssignment =
        await prisma.fulfillmentAssignment.findFirstOrThrow({
          where: {
            orderId: order.id,
            status: { in: ["ASSIGNED", "IN_PROGRESS"] },
          },
        })
      expect(ticket.assignedToUserId).toBe(activeAssignment.assignedToUserId)
      expect(activeAssignment.assignedToUserId).toBe(operationsA.id)

      const replyRace = await Promise.allSettled([
        support.addMessage(ticket.id, operationsActor(operationsA.id), {
          clientMessageId: crypto.randomUUID(),
          content: "I am checking the fulfillment state now.",
        }),
        assignments.reassign(order.id, operationsB.id, administrator.id),
      ])
      expect(replyRace[1].status).toBe("fulfilled")

      activeAssignment = await prisma.fulfillmentAssignment.findFirstOrThrow({
        where: {
          orderId: order.id,
          status: { in: ["ASSIGNED", "IN_PROGRESS"] },
        },
      })
      let routedTicket = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(activeAssignment.assignedToUserId).toBe(operationsB.id)
      expect(routedTicket.assignedToUserId).toBe(
        activeAssignment.assignedToUserId,
      )
      await expect(
        support.getTicket(ticket.id, operationsActor(operationsA.id)),
      ).rejects.toBeInstanceOf(NotFoundException)
      const messageCountAfterRace = await prisma.ticketMessage.count({
        where: { ticketId: ticket.id },
      })
      await expect(
        support.addMessage(ticket.id, operationsActor(operationsA.id), {
          clientMessageId: crypto.randomUUID(),
          content: "This stale assignment must be refused.",
        }),
      ).rejects.toBeInstanceOf(NotFoundException)
      expect(
        await prisma.ticketMessage.count({ where: { ticketId: ticket.id } }),
      ).toBe(messageCountAfterRace)
      await expect(
        support.getTicket(ticket.id, operationsActor(operationsB.id)),
      ).resolves.toMatchObject({ id: ticket.id })

      await assignments.reassign(order.id, operationsA.id, administrator.id)
      const statusRace = await Promise.allSettled([
        support.updateStatus(
          ticket.id,
          "WAITING_ON_CUSTOMER",
          operationsActor(operationsA.id),
        ),
        assignments.reassign(order.id, operationsB.id, administrator.id),
      ])
      expect(statusRace[1].status).toBe("fulfilled")

      activeAssignment = await prisma.fulfillmentAssignment.findFirstOrThrow({
        where: {
          orderId: order.id,
          status: { in: ["ASSIGNED", "IN_PROGRESS"] },
        },
      })
      routedTicket = await prisma.ticket.findUniqueOrThrow({
        where: { id: ticket.id },
      })
      expect(activeAssignment.assignedToUserId).toBe(operationsB.id)
      expect(routedTicket.assignedToUserId).toBe(
        activeAssignment.assignedToUserId,
      )
      await expect(
        support.getTicket(ticket.id, operationsActor(operationsA.id)),
      ).rejects.toBeInstanceOf(NotFoundException)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
