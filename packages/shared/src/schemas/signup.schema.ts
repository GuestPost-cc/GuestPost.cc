import { z } from "zod"

export const signupSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Valid email address required"),
  password: z.string().min(8, "At least 8 characters required"),
})

export type SignupInput = z.infer<typeof signupSchema>
