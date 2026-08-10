import { renderAuthActionEmail } from "./layout.js"

export interface VerificationEmailContext {
  name: string | null
  url: string
}

export function renderVerificationEmail({
  name,
  url,
}: VerificationEmailContext): string {
  return renderAuthActionEmail({
    name,
    title: "Verify your email",
    introduction:
      "Please confirm your email address to start using GuestPost.cc.",
    actionLabel: "Verify email",
    url,
    expiry: "This single-use link expires in 24 hours.",
    ignoreMessage:
      "If you did not sign up for GuestPost.cc, you can safely ignore this email.",
  })
}
