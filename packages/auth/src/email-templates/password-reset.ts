import { renderAuthActionEmail } from "./layout.js"

export interface PasswordResetEmailContext {
  name: string | null
  url: string
}

export function renderPasswordResetEmail({
  name,
  url,
}: PasswordResetEmailContext): string {
  return renderAuthActionEmail({
    name,
    title: "Reset your GuestPost password",
    introduction: "We received a request to reset your password.",
    actionLabel: "Reset password",
    url,
    expiry: "This single-use link expires in one hour.",
    ignoreMessage:
      "If you did not request it, you can safely ignore this email and your password will remain unchanged.",
  })
}
