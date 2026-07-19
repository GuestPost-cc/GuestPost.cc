export const AUTH_SESSION_OPTIONS = {
  expiresIn: 8 * 60 * 60,
  updateAge: 30 * 60,
  freshAge: 30 * 60,
} as const

export const AUTH_ACCOUNT_OPTIONS = {
  accountLinking: {
    disableImplicitLinking: true,
  },
} as const

export function googleProviderOptions() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    prompt: "select_account" as const,
    disableImplicitSignUp: true,
  }
}
