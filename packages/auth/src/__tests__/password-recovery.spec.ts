const mockRequestPasswordReset = jest.fn().mockResolvedValue({ error: null })
const mockResetPassword = jest.fn().mockResolvedValue({ error: null })

jest.mock("../client/auth-client", () => ({
  authClient: {
    requestPasswordReset: mockRequestPasswordReset,
    resetPassword: mockResetPassword,
  },
}))

jest.mock("../client/session", () => ({
  getSession: jest.fn(),
}))

import { forgotPassword, resetPassword } from "../client/transport"

describe("password recovery transport", () => {
  beforeEach(() => {
    mockRequestPasswordReset.mockClear()
    mockResetPassword.mockClear()
  })

  it("uses the relative reset fallback outside a browser", async () => {
    await forgotPassword({
      email: "customer@example.com",
      redirectTo: "https://guestpost.example/reset-password",
    })

    expect(mockRequestPasswordReset).toHaveBeenCalledWith({
      email: "customer@example.com",
      redirectTo: "/reset-password",
    })
  })

  it("accepts an explicit same-origin reset URL in a browser", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { origin: "https://guestpost.example" } },
    })

    try {
      await forgotPassword({
        email: "customer@example.com",
        redirectTo: "https://guestpost.example/reset-password",
      })

      expect(mockRequestPasswordReset).toHaveBeenCalledWith({
        email: "customer@example.com",
        redirectTo: "https://guestpost.example/reset-password",
      })
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("submits the reset token and new password", async () => {
    await resetPassword({ token: "single-use-token", password: "NewPass!123" })

    expect(mockResetPassword).toHaveBeenCalledWith({
      newPassword: "NewPass!123",
      token: "single-use-token",
    })
  })
})
