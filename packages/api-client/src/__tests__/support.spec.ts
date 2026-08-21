import { HttpClient } from "../client"
import { type AdminOpsStaffResponse, AdminService } from "../services/admin"
import {
  type StaffTicketDetail,
  SupportService,
  supportKeys,
  type TicketAssignmentMutationResponse,
  type TicketDetail,
  type TicketMessageDto,
} from "../services/support"

const capabilities = {
  canReply: true,
  canClose: true,
  canReopen: false,
  canPostInternal: false,
  canClaim: false,
  canReassign: false,
  allowedVisibilities: ["PUBLIC"],
  allowedStatuses: ["CLOSED"],
  readOnlyReason: null,
} satisfies TicketDetail["capabilities"]

const publicOpeningMessage = {
  id: "message-opening",
  content: "Where is my placement?",
  visibility: "PUBLIC",
  messageType: "MESSAGE",
  createdAt: "2026-08-14T01:00:00.000Z",
  sender: {
    party: "CUSTOMER",
    displayName: "You",
    isSelf: true,
  },
} satisfies TicketMessageDto

const publicReplyFromDeletedPublisher = {
  id: "message-reply",
  content: "The placement is being checked.",
  visibility: "PUBLIC",
  messageType: "MESSAGE",
  createdAt: "2026-08-14T02:00:00.000Z",
  sender: {
    party: "PUBLISHER",
    displayName: "Former publisher member",
    isSelf: false,
  },
} satisfies TicketMessageDto

const publicTicket = {
  id: "ticket-1",
  subject: "Placement status",
  status: "OPEN",
  fulfillmentChannel: "PUBLISHER",
  order: {
    id: "order-1",
    title: "Launch article",
    status: "ACCEPTED",
    type: "GUEST_POST",
    fulfillmentChannel: "PUBLISHER",
  },
  messageCount: 1,
  createdAt: "2026-08-14T01:00:00.000Z",
  updatedAt: "2026-08-14T02:00:00.000Z",
  capabilities,
  openingMessage: publicOpeningMessage,
  messages: [publicReplyFromDeletedPublisher],
  messagePage: { nextCursor: null, limit: 200 },
} satisfies TicketDetail

const staffTicket = {
  ...publicTicket,
  requester: { displayName: "Customer" },
  organization: { name: "Example Org" },
  assignedTo: null,
  assignedPublisher: { displayName: "Example Publisher" },
} satisfies StaffTicketDetail

describe("support API contract", () => {
  let client: HttpClient
  let support: SupportService

  beforeEach(() => {
    client = new HttpClient({ baseUrl: "https://api.example.test/api/v1" })
    support = new SupportService(client)
  })

  it("maps create input to the server description and order fields", async () => {
    const post = jest.spyOn(client, "post").mockResolvedValueOnce({
      id: "ticket-1",
      status: "OPEN",
      createdAt: "2026-08-14T01:00:00.000Z",
    })

    await support.createTicket({
      subject: "Placement status",
      message: "Where is my placement?",
      clientRequestId: "123e4567-e89b-42d3-a456-426614174001",
      orderId: "order-1",
    })

    expect(post).toHaveBeenCalledWith("/support/tickets", {
      json: {
        subject: "Placement status",
        description: "Where is my placement?",
        clientRequestId: "123e4567-e89b-42d3-a456-426614174001",
        orderId: "order-1",
      },
    })
  })

  it("uses the actor-neutral assigned-thread routes for publisher reads and replies", async () => {
    const get = jest.spyOn(client, "get").mockResolvedValueOnce(publicTicket)
    const post = jest
      .spyOn(client, "post")
      .mockResolvedValueOnce(publicReplyFromDeletedPublisher)

    await support.getTicket("ticket-1")
    await support.addMessage("ticket-1", {
      content: "The placement is being checked.",
      clientMessageId: "123e4567-e89b-42d3-a456-426614174002",
    })

    expect(get).toHaveBeenCalledWith("/support/tickets/ticket-1", {
      params: undefined,
    })
    expect(post).toHaveBeenCalledWith("/support/tickets/ticket-1/messages", {
      json: {
        content: "The placement is being checked.",
        clientMessageId: "123e4567-e89b-42d3-a456-426614174002",
        visibility: undefined,
      },
    })
  })

  it("maps the cursor-paginated public inbox and its narrowing filters", async () => {
    const page = {
      items: [publicTicket],
      nextCursor: "next-public-page",
      limit: 25,
    }
    const get = jest.spyOn(client, "get").mockResolvedValueOnce(page)

    await expect(
      support.listTickets({
        status: "OPEN",
        orderId: "order-1",
        cursor: "current-public-page",
        limit: 25,
      }),
    ).resolves.toEqual(page)

    expect(get).toHaveBeenCalledWith("/support/tickets", {
      params: {
        status: "OPEN",
        orderId: "order-1",
        cursor: "current-public-page",
        limit: 25,
      },
    })
  })

  it("passes an opaque older-message cursor without decoding it", async () => {
    const get = jest.spyOn(client, "get").mockResolvedValueOnce({
      ...publicTicket,
      messages: [],
      messagePage: { nextCursor: null, limit: 200 },
    })

    await support.getTicket("ticket-1", { messageCursor: "opaque.cursor_2" })

    expect(get).toHaveBeenCalledWith("/support/tickets/ticket-1", {
      params: { messageCursor: "opaque.cursor_2" },
    })
  })

  it("preserves caller-owned idempotency IDs verbatim across retries", async () => {
    const post = jest.spyOn(client, "post").mockResolvedValue({
      id: "ticket-1",
      status: "OPEN",
      createdAt: "2026-08-14T01:00:00.000Z",
    })
    const createIntent = {
      subject: "Placement status",
      message: "Where is my placement?",
      orderId: "order-1",
      clientRequestId: "123e4567-e89b-42d3-a456-426614174004",
    } as const

    await support.createTicket(createIntent)
    await support.createTicket(createIntent)

    expect(post).toHaveBeenNthCalledWith(1, "/support/tickets", {
      json: {
        subject: createIntent.subject,
        description: createIntent.message,
        clientRequestId: createIntent.clientRequestId,
        orderId: createIntent.orderId,
      },
    })
    expect(post).toHaveBeenNthCalledWith(2, "/support/tickets", {
      json: {
        subject: createIntent.subject,
        description: createIntent.message,
        clientRequestId: createIntent.clientRequestId,
        orderId: createIntent.orderId,
      },
    })
  })

  it("maps customer close and reopen commands to the restricted status body", async () => {
    const patch = jest.spyOn(client, "patch").mockResolvedValue({
      id: "ticket-1",
      status: "CLOSED",
      updatedAt: "2026-08-14T03:00:00.000Z",
      capabilities: { ...capabilities, canClose: false, canReopen: true },
    })

    await support.closeTicket("ticket-1")
    await support.reopenTicket("ticket-1")

    expect(patch).toHaveBeenNthCalledWith(
      1,
      "/support/tickets/ticket-1/status",
      { json: { status: "CLOSED" } },
    )
    expect(patch).toHaveBeenNthCalledWith(
      2,
      "/support/tickets/ticket-1/status",
      { json: { status: "OPEN" } },
    )
  })

  it("keeps public projections free of staff evidence and raw user fields", () => {
    expect(publicTicket).not.toHaveProperty("user")
    expect(publicTicket).not.toHaveProperty("organization")
    expect(publicTicket).not.toHaveProperty("assignedTo")
    expect(publicTicket).not.toHaveProperty("assignedPublisher")
    expect(publicTicket).not.toHaveProperty("description")

    for (const message of [
      publicTicket.openingMessage,
      ...publicTicket.messages,
    ]) {
      expect(message).not.toHaveProperty("user")
      expect(message).not.toHaveProperty("participantRole")
      expect(message).not.toHaveProperty("actorSnapshot")
      expect(message).not.toHaveProperty("authorEvidence")
      expect(message).not.toHaveProperty("files")
    }
  })

  it("carries party, self, and safe deleted-author presentation explicitly", () => {
    expect(publicTicket.openingMessage.sender).toEqual({
      party: "CUSTOMER",
      displayName: "You",
      isSelf: true,
    })
    expect(publicTicket.messages[0].sender).toEqual({
      party: "PUBLISHER",
      displayName: "Former publisher member",
      isSelf: false,
    })
  })

  it("uses one scoped query-key hierarchy for deterministic invalidation", () => {
    expect(supportKeys.list("publisher", { status: "OPEN" })).toEqual([
      "support",
      "publisher",
      "list",
      { status: "OPEN" },
    ])
    expect(supportKeys.detail("publisher", "ticket-1")).toEqual([
      "support",
      "publisher",
      "detail",
      "ticket-1",
    ])
    expect(supportKeys.order("publisher", "order-1")).toEqual([
      "support",
      "publisher",
      "order",
      "order-1",
    ])
  })
})

describe("admin support API contract", () => {
  it("passes orderId as an admin inbox narrowing filter", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const admin = new AdminService(client)
    const get = jest.spyOn(client, "get").mockResolvedValueOnce({
      items: [staffTicket],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    })

    await admin.listTickets({ orderId: "order-1", limit: 20 })

    expect(get).toHaveBeenCalledWith("/admin/support/tickets", {
      params: { orderId: "order-1", limit: 20 },
    })
  })

  it("returns the staff projection and preserves internal visibility", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const admin = new AdminService(client)
    const get = jest.spyOn(client, "get").mockResolvedValueOnce(staffTicket)
    const post = jest.spyOn(client, "post").mockResolvedValueOnce({
      ...publicReplyFromDeletedPublisher,
      visibility: "INTERNAL",
      messageType: "INTERNAL_NOTE",
      sender: {
        party: "SUPPORT",
        displayName: "You",
        isSelf: true,
      },
      participantRole: "OPS",
      actorSnapshot: {
        kind: "STAFF",
        staffRole: "OPERATIONS",
        organizationRole: null,
        publisherRole: null,
      },
      authorEvidence: { displayName: "Operations member" },
    } satisfies TicketMessageDto)

    const detail = await admin.getTicketDetail("ticket-1")
    await admin.addTicketMessage("ticket-1", {
      content: "Escalated to the placement team.",
      clientMessageId: "123e4567-e89b-42d3-a456-426614174003",
      visibility: "INTERNAL",
    })

    expect(detail).toEqual(staffTicket)
    expect(get).toHaveBeenCalledWith("/admin/support/tickets/ticket-1", {
      params: undefined,
    })
    expect(post).toHaveBeenCalledWith(
      "/admin/support/tickets/ticket-1/messages",
      {
        json: {
          content: "Escalated to the placement team.",
          clientMessageId: "123e4567-e89b-42d3-a456-426614174003",
          visibility: "INTERNAL",
        },
      },
    )
  })

  it("maps Operations claim to the dedicated bodyless admin command", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const admin = new AdminService(client)
    const patch = jest.spyOn(client, "patch").mockResolvedValueOnce({
      id: "ticket-1",
      assignedTo: { displayName: "You", userId: "operations-user-1" },
      capabilities: { ...capabilities, canClaim: false },
    })

    await admin.claimTicket("ticket-1")

    expect(patch).toHaveBeenCalledWith("/admin/support/tickets/ticket-1/claim")
  })

  it("maps assignment and unassignment to the Super Admin support command", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const admin = new AdminService(client)
    const response = {
      id: "ticket-1",
      assignedTo: null,
      capabilities: { ...capabilities, canReassign: true },
    } satisfies TicketAssignmentMutationResponse
    const patch = jest.spyOn(client, "patch").mockResolvedValue(response)

    await admin.reassignTicket("ticket-1", {
      assignedToUserId: "operations-user-2",
      expectedAssignedToUserId: "operations-user-1",
      reason: "Balance the terminal support workload.",
    })
    await admin.reassignTicket("ticket-1", {
      assignedToUserId: null,
      expectedAssignedToUserId: "operations-user-2",
      reason: "Return this ticket to the shared queue.",
    })

    expect(patch).toHaveBeenNthCalledWith(
      1,
      "/support/tickets/ticket-1/reassign",
      {
        json: {
          assignedToUserId: "operations-user-2",
          expectedAssignedToUserId: "operations-user-1",
          reason: "Balance the terminal support workload.",
        },
      },
    )
    expect(patch).toHaveBeenNthCalledWith(
      2,
      "/support/tickets/ticket-1/reassign",
      {
        json: {
          assignedToUserId: null,
          expectedAssignedToUserId: "operations-user-2",
          reason: "Return this ticket to the shared queue.",
        },
      },
    )
  })

  it("loads assignment candidates from the active Operations endpoint", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const admin = new AdminService(client)
    const candidates = [
      {
        id: "operations-user-2",
        name: "Second operator",
        email: "operator@example.test",
      },
    ] satisfies AdminOpsStaffResponse[]
    const get = jest.spyOn(client, "get").mockResolvedValueOnce(candidates)

    await expect(admin.listOpsStaff()).resolves.toEqual(candidates)
    expect(get).toHaveBeenCalledWith("/admin/staff/operations")
  })
})
