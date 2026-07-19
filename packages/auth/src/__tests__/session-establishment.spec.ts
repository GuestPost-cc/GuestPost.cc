const mockSignInEmail = jest.fn()
const mockGetSession = jest.fn()

jest.mock("../client/auth-client", () => ({
  authClient: { signIn: { email: mockSignInEmail } },
}))

jest.mock("../client/session", () => ({
  getSession: mockGetSession,
}))

import { signIn } from "../client/transport"

describe("email sign-in session establishment", () => {
  beforeEach(() => {
    mockSignInEmail.mockReset()
    mockGetSession.mockReset()
    mockSignInEmail.mockResolvedValue({
      data: {
        user: {
          id: "user-1",
          email: "alice@example.com",
          emailVerified: true,
          name: "Alice",
        },
      },
      error: null,
    })
  })

  it("does not redirect callers when credentials pass but the cookie cannot be verified", async () => {
    mockGetSession.mockResolvedValue({ session: null, user: null })

    await expect(
      signIn({
        email: "alice@example.com",
        password: "correct-password",
        portal: "customer",
      }),
    ).rejects.toMatchObject({
      code: "SESSION_ESTABLISHMENT_FAILED",
      httpStatus: 503,
    })
  })

  it("returns authenticated only after the same user session round-trips", async () => {
    mockGetSession.mockResolvedValue({
      session: {
        id: "session-1",
        userId: "user-1",
        expiresAt: new Date("2026-07-20T00:00:00.000Z"),
      },
      user: {
        id: "user-1",
        email: "alice@example.com",
        emailVerified: true,
        name: "Alice",
        image: null,
        userType: "CUSTOMER",
        banned: false,
      },
    })

    await expect(
      signIn({
        email: "alice@example.com",
        password: "correct-password",
        portal: "customer",
      }),
    ).resolves.toMatchObject({
      status: "authenticated",
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", userType: "CUSTOMER", banned: false },
    })
  })
})
