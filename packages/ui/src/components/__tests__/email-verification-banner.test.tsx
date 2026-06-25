/**
 * Phase 7.10 — EmailVerificationBanner presentational shell spec.
 *
 * Tests the @guestpost/ui shell only. Data wiring (auth context,
 * resend POST, toast, cooldown timer) lives in the per-app container
 * (apps/portal/src/components/email-verification-banner-container.tsx
 * for the reference implementation) and isn't covered here.
 */

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { EmailVerificationBanner } from "../email-verification-banner"

describe("EmailVerificationBanner", () => {
  it("renders the email and the default 'Resend email' label when ready", () => {
    const onResend = vi.fn()
    render(
      <EmailVerificationBanner email="alice@example.com" onResend={onResend} />,
    )
    expect(screen.getByText("alice@example.com")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Resend email" })).toBeEnabled()
  })

  it("renders 'Sending…' and disables the button while sending", () => {
    const onResend = vi.fn()
    render(
      <EmailVerificationBanner
        email="alice@example.com"
        sending
        onResend={onResend}
      />,
    )
    const button = screen.getByRole("button", { name: "Sending…" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onResend).not.toHaveBeenCalled()
  })

  it("renders 'Resend in Ns' and disables the button during cooldown", () => {
    const onResend = vi.fn()
    render(
      <EmailVerificationBanner
        email="alice@example.com"
        cooldownSeconds={42}
        onResend={onResend}
      />,
    )
    const button = screen.getByRole("button", { name: "Resend in 42s" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onResend).not.toHaveBeenCalled()
  })

  it("calls onResend exactly once when the button is clicked from the ready state", () => {
    const onResend = vi.fn()
    render(
      <EmailVerificationBanner email="alice@example.com" onResend={onResend} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Resend email" }))
    expect(onResend).toHaveBeenCalledTimes(1)
  })

  it("renders the role=status semantics for assistive tech", () => {
    render(
      <EmailVerificationBanner email="alice@example.com" onResend={() => {}} />,
    )
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("honors a custom message override", () => {
    render(
      <EmailVerificationBanner
        email="alice@example.com"
        onResend={() => {}}
        message={<>Custom copy for a different verification gate.</>}
      />,
    )
    expect(
      screen.getByText("Custom copy for a different verification gate."),
    ).toBeInTheDocument()
    // The default email text should not appear when message is overridden.
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument()
  })
})
