import {
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from "../schemas"

describe("auth schemas", () => {
  describe("loginSchema", () => {
    it.each([
      [{ email: "", password: "secret" }, "email"],
      [{ email: "   ", password: "secret" }, "email"],
      [{ email: "invalid", password: "secret" }, "email"],
      [{ email: "user@example.com", password: "" }, "password"],
      [{ email: "user@example.com", password: "   " }, "password"],
    ])("rejects invalid login input %#", (input, field) => {
      const result = loginSchema.safeParse(input)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path[0] === field),
        ).toBe(true)
      }
    })

    it("trims a valid email without changing the password", () => {
      expect(
        loginSchema.parse({
          email: "  user@example.com  ",
          password: " valid password ",
        }),
      ).toEqual({
        email: "user@example.com",
        password: " valid password ",
      })
    })
  })

  describe("signupSchema", () => {
    const validSignup = {
      name: "Jane Smith",
      email: "jane@example.com",
      password: "secure-password",
      termsAccepted: true,
    }

    it.each([
      [{ ...validSignup, name: "" }, "name"],
      [{ ...validSignup, name: "   " }, "name"],
      [{ ...validSignup, email: "" }, "email"],
      [{ ...validSignup, password: "" }, "password"],
      [{ ...validSignup, password: "        " }, "password"],
      [{ ...validSignup, termsAccepted: false }, "termsAccepted"],
      [
        {
          name: validSignup.name,
          email: validSignup.email,
          password: validSignup.password,
        },
        "termsAccepted",
      ],
    ])("rejects invalid signup input %#", (input, field) => {
      const result = signupSchema.safeParse(input)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(
          result.error.issues.some((issue) => issue.path[0] === field),
        ).toBe(true)
      }
    })

    it("trims valid name and email values", () => {
      expect(
        signupSchema.parse({
          ...validSignup,
          name: "  Jane Smith  ",
          email: "  jane@example.com  ",
        }),
      ).toEqual(validSignup)
    })
  })

  it.each([
    "",
    "   ",
    "not-an-email",
  ])("rejects invalid forgot-password email %p", (email) => {
    expect(forgotPasswordSchema.safeParse({ email }).success).toBe(false)
  })

  it.each([
    "",
    "       ",
    "short",
  ])("rejects invalid reset password %p", (password) => {
    expect(resetPasswordSchema.safeParse({ password }).success).toBe(false)
  })
})
