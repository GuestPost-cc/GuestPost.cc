import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { ForgotPasswordForm } from "../forgot-password-form"
import { LoginForm } from "../login-form"
import { SignupForm } from "../signup-form"

describe("auth forms", () => {
  it("does not submit empty login credentials and shows field errors", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<LoginForm onSubmit={onSubmit} />)

    await user.click(screen.getByRole("button", { name: "Sign in" }))

    expect(
      await screen.findByText("Email address is required"),
    ).toBeInTheDocument()
    expect(screen.getByText("Password is required")).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("requires Terms acceptance before submitting signup", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(
      <SignupForm
        onSubmit={onSubmit}
        termsHref="https://guestpost.cc/legal/terms"
      />,
    )

    await user.type(screen.getByLabelText("Full name"), "Jane Smith")
    await user.type(screen.getByLabelText("Email address"), "jane@example.com")
    await user.type(screen.getByLabelText("Password"), "secure-password")
    await user.click(screen.getByRole("button", { name: "Create account" }))

    expect(
      await screen.findByText("You must accept the Terms of Service"),
    ).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole("checkbox", {
        name: /I agree to the Terms of Service/i,
      }),
    )
    await user.click(screen.getByRole("button", { name: "Create account" }))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(
        {
          name: "Jane Smith",
          email: "jane@example.com",
          password: "secure-password",
          termsAccepted: true,
        },
        expect.anything(),
      )
    })
    expect(
      screen.getByRole("link", { name: "Terms of Service" }),
    ).toHaveAttribute("href", "https://guestpost.cc/legal/terms")
  })

  it("does not submit an empty forgot-password email", async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    render(<ForgotPasswordForm onSubmit={onSubmit} />)

    await user.click(screen.getByRole("button", { name: "Send Reset Link" }))

    expect(
      await screen.findByText("Email address is required"),
    ).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("announces server errors accessibly", () => {
    render(
      <LoginForm onSubmit={vi.fn()} error="Incorrect email or password." />,
    )

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Incorrect email or password.",
    )
  })
})
