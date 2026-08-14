import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { mergeSupportTicketPages, SupportPanel } from "../support-panel"

describe("SupportPanel", () => {
  it("renders safe order-ticket context and the canonical waiting status", () => {
    render(
      <SupportPanel
        actorScope="customer"
        tickets={[
          {
            id: "ticket-1",
            subject: "مساعدة with a very-long-order-subject",
            status: "WAITING_ON_CUSTOMER",
            fulfillmentChannel: "PLATFORM",
          },
        ]}
        linkHref={(id) => `/support/${id}`}
      />,
    )

    expect(screen.getByText(/مساعدة/)).toHaveAttribute("dir", "auto")
    expect(screen.getByText("waiting on customer")).toBeInTheDocument()
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/support/ticket-1",
    )
  })

  it("appends cursor pages, deduplicates IDs, and keeps newer projections", () => {
    expect(
      mergeSupportTicketPages([
        {
          items: [
            { id: "newest", subject: "Newest" },
            { id: "overlap", subject: "Stale" },
          ],
        },
        {
          items: [
            { id: "overlap", subject: "Current" },
            { id: "oldest", subject: "Oldest" },
          ],
        },
      ]),
    ).toEqual([
      { id: "newest", subject: "Newest" },
      { id: "overlap", subject: "Current" },
      { id: "oldest", subject: "Oldest" },
    ])
  })
})
