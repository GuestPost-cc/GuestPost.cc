import { z } from "zod"

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email address is required")
    .max(254, "Email address is too long")
    .email("Enter a valid email address"),
})

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
