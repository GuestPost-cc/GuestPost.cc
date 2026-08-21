import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  type OrderStakeholderUpdate,
  OrderStakeholderUpdates,
} from "../order-stakeholder-updates"

const occurredAt = "2026-08-15T10:30:00.000Z"

function update(
  overrides: Partial<OrderStakeholderUpdate> = {},
): OrderStakeholderUpdate {
  return {
    id: "decision-1",
    kind: "SECURITY_VIOLATION_CONFIRMED",
    occurredAt,
    status: "ACTION_REQUIRED",
    severity: "CRITICAL",
    title: "Delivery review completed",
    summary: "A corrected delivery is required before this order can continue.",
    ...overrides,
  }
}

describe("OrderStakeholderUpdates", () => {
  it("renders a semantic, persistent decision history newest first", () => {
    render(
      <OrderStakeholderUpdates
        updates={[
          update({
            id: "older",
            occurredAt: "2026-08-14T10:30:00.000Z",
          }),
          update({
            id: "newer",
            title: "Refund completed",
            kind: "CUSTOMER_REFUND_COMPLETED",
            occurredAt,
            status: "COMPLETED",
            severity: "SUCCESS",
          }),
        ]}
      />,
    )

    const list = screen.getByRole("list", {
      name: "Official order decisions",
    })
    const articles = within(list).getAllByRole("article")
    expect(articles[0]).toHaveAccessibleName("Refund completed")
    expect(articles[1]).toHaveAccessibleName("Delivery review completed")
    expect(articles[0].querySelector("time")).toHaveAttribute(
      "datetime",
      occurredAt,
    )
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("renders only financial effects supplied by the role-safe server", () => {
    render(
      <OrderStakeholderUpdates
        updates={[
          update({
            kind: "PUBLISHER_COMPENSATION_DECIDED",
            financialImpact: {
              currency: "USD",
              publisherCompensation: "125.40",
              debtApplied: "25.00",
              netPublisherCredit: "100.40",
            },
          }),
        ]}
      />,
    )

    expect(screen.getByText("125.40")).toBeInTheDocument()
    expect(screen.getByText("25.00")).toBeInTheDocument()
    expect(screen.getByText("100.40")).toBeInTheDocument()
    expect(screen.queryByText("Customer refund")).not.toBeInTheDocument()
  })

  it("keeps untrusted copy as plain text with safe bidirectional rendering", () => {
    render(
      <OrderStakeholderUpdates
        updates={[
          update({
            title: "مراجعة <script>alert(1)</script>",
            summary: "No markup is interpreted <img src=x onerror=alert(1)>",
          }),
        ]}
      />,
    )

    expect(screen.getByText(/مراجعة/)).toHaveAttribute("dir", "auto")
    expect(screen.getByText(/No markup is interpreted/)).toHaveAttribute(
      "dir",
      "auto",
    )
    expect(document.querySelector("script")).toBeNull()
    expect(document.querySelector("img")).toBeNull()
  })

  it("does not render an empty placeholder that could imply no decision after a fetch failure", () => {
    const { container } = render(<OrderStakeholderUpdates updates={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
