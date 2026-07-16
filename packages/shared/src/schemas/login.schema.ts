import { z } from "zod"

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email address is required")
    .max(254, "Email address is too long")
    .email("Enter a valid email address"),
  password: z
    .string()
    .min(1, "Password is required")
    .max(128, "Password must be 128 characters or fewer")
    .refine((value) => value.trim().length > 0, "Password is required"),
})

export type LoginInput = z.infer<typeof loginSchema>
