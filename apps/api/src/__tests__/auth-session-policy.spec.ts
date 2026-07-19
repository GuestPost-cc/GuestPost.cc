import { buildAuthOptions } from "@guestpost/auth"
import { prisma } from "@guestpost/database"

describe("Better Auth session creation policy", () => {
  const beforeSessionCreate = () =>
    buildAuthOptions().databaseHooks.session.create.before

  afterEach(() => jest.restoreAllMocks())

  it("reads the portal header from database-hook context", async () => {
    jest.spyOn(prisma.user, "findUnique").mockResolvedValue({
      userType: "STAFF",
      banned: false,
      banExpires: null,
    } as any)

    const session = { id: "session-1", userId: "staff-1" }
    await expect(
      beforeSessionCreate()(session, {
        headers: new Headers({ "x-portal-type": "staff" }),
      }),
    ).resolves.toEqual({ data: session })
  })

  it("rejects a valid account at the wrong portal before creating a session", async () => {
    jest.spyOn(prisma.user, "findUnique").mockResolvedValue({
      userType: "CUSTOMER",
      banned: false,
      banExpires: null,
    } as any)

    await expect(
      beforeSessionCreate()(
        { id: "session-1", userId: "customer-1" },
        { headers: new Headers({ "x-portal-type": "staff" }) },
      ),
    ).rejects.toMatchObject({ body: { code: "WRONG_PORTAL" } })
  })

  it("rejects a suspended account before creating any portal session", async () => {
    jest.spyOn(prisma.user, "findUnique").mockResolvedValue({
      userType: "STAFF",
      banned: true,
      banExpires: null,
    } as any)

    await expect(
      beforeSessionCreate()(
        { id: "session-1", userId: "staff-1" },
        { headers: new Headers({ "x-portal-type": "staff" }) },
      ),
    ).rejects.toMatchObject({ body: { code: "ACCOUNT_SUSPENDED" } })
  })

  it("exposes only the non-sensitive banned flag in session user data", () => {
    const fields = buildAuthOptions().user.additionalFields
    expect(fields.banned).toEqual({
      type: "boolean",
      required: true,
      defaultValue: false,
      input: false,
    })
    expect(fields).not.toHaveProperty("banReason")
    expect(fields).not.toHaveProperty("banReasonCode")
  })
})
