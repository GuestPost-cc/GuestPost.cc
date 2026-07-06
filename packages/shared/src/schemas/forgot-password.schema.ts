import { z } from "zod"

export const forgotPasswordSchema = z.object({
  email: z.string().email("Valid email address required"),
})

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
