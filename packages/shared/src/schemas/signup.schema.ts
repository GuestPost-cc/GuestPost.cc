import { z } from "zod"

export const signupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Full name is required")
    .max(100, "Full name must be 100 characters or fewer"),
  email: z
    .string()
    .trim()
    .min(1, "Email address is required")
    .max(254, "Email address is too long")
    .email("Enter a valid email address"),
  password: z
    .string()
    .min(1, "Password is required")
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be 128 characters or fewer")
    .refine((value) => value.trim().length > 0, "Password is required"),
  termsAccepted: z
    .boolean()
    .refine((value) => value, "You must accept the Terms of Service"),
})

export type SignupInput = z.infer<typeof signupSchema>
