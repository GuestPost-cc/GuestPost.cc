import { z } from "zod"

export const resetPasswordSchema = z.object({
  password: z.string().min(8, "At least 8 characters required"),
})

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
