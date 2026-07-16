import { z } from "zod"

export const resetPasswordSchema = z.object({
  password: z
    .string()
    .min(1, "Password is required")
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be 128 characters or fewer")
    .refine((value) => value.trim().length > 0, "Password is required"),
})

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
