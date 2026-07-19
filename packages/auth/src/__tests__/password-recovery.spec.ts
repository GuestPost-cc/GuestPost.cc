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

  it("calls Better Auth's request-password-reset endpoint", async () => {
    await forgotPassword({
      email: "customer@example.com",
      redirectTo: "https://guestpost.example/reset-password",
    })

    expect(mockRequestPasswordReset).toHaveBeenCalledWith({
      email: "customer@example.com",
      redirectTo: "https://guestpost.example/reset-password",
    })
  })

  it("submits the reset token and new password", async () => {
    await resetPassword({ token: "single-use-token", password: "NewPass!123" })

    expect(mockResetPassword).toHaveBeenCalledWith({
      newPassword: "NewPass!123",
      token: "single-use-token",
    })
  })
})
