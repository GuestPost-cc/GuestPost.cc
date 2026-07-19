import { CURRENT_TERMS_VERSION } from "@guestpost/shared"

jest.mock("../client/auth-client", () => ({
  authClient: {
    signIn: { social: jest.fn().mockResolvedValue({ error: null }) },
  },
}))

import { authClient } from "../client/auth-client"
import { signInWithProvider } from "../client/oauth"

const social = authClient.signIn.social as jest.Mock

describe("Google OAuth flow intent", () => {
  beforeEach(() => social.mockClear())

  it("prevents login from implicitly creating an account", async () => {
    await signInWithProvider("google", {
      callbackURL: "https://guestpost.example/login",
      errorCallbackURL: "https://guestpost.example/login",
      portal: "customer",
      flow: "login",
    })

    expect(social).toHaveBeenCalledWith(
      expect.objectContaining({
        requestSignUp: false,
        additionalData: {
          authFlow: "login",
          portal: "customer",
        },
      }),
    )
  })

  it("carries versioned consent in protected OAuth signup state", async () => {
    await signInWithProvider("google", {
      callbackURL: "https://guestpost.example/login",
      errorCallbackURL: "https://guestpost.example/signup",
      portal: "publisher",
      flow: "signup",
      termsAccepted: true,
    })

    expect(social).toHaveBeenCalledWith(
      expect.objectContaining({
        requestSignUp: true,
        additionalData: {
          authFlow: "signup",
          portal: "publisher",
          termsAccepted: true,
          termsVersion: CURRENT_TERMS_VERSION,
        },
      }),
    )
  })

  it("refuses Google signup before Terms acceptance", async () => {
    await expect(
      signInWithProvider("google", {
        callbackURL: "https://guestpost.example/login",
        errorCallbackURL: "https://guestpost.example/signup",
        portal: "customer",
        flow: "signup",
        termsAccepted: false,
      }),
    ).rejects.toMatchObject({ code: "TERMS_REQUIRED" })
    expect(social).not.toHaveBeenCalled()
  })
})
