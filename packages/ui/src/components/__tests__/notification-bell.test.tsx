import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NotificationBell, type NotificationBellItem } from "../notification-bell"

const items: NotificationBellItem[] = [
  { id: "n1", type: "SETTLEMENT_RELEASED", message: "Settlement of 200 released", read: false, createdAt: new Date().toISOString() },
  { id: "n2", type: "WITHDRAWAL_APPROVED", message: "Withdrawal approved", read: true, createdAt: new Date(Date.now() - 3600_000).toISOString() },
]

function renderBell(overrides: Partial<Parameters<typeof NotificationBell>[0]> = {}) {
  const onMarkRead = vi.fn()
  const onMarkAllRead = vi.fn()
  render(
    <NotificationBell
      items={items}
      unreadCount={3}
      onMarkRead={onMarkRead}
      onMarkAllRead={onMarkAllRead}
      {...overrides}
    />,
  )
  return { onMarkRead, onMarkAllRead }
}

describe("NotificationBell", () => {
  it("shows the unread badge and an accessible label", () => {
    renderBell()
    expect(screen.getByRole("button", { name: /notifications \(3 unread\)/i })).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("caps the badge at 99+", () => {
    renderBell({ unreadCount: 250 })
    expect(screen.getByText("99+")).toBeInTheDocument()
  })

  it("opens the list and marks an unread item read on click", async () => {
    const user = userEvent.setup()
    const { onMarkRead } = renderBell()
    await user.click(screen.getByRole("button", { name: /notifications/i }))
    await user.click(await screen.findByText("Settlement of 200 released"))
    expect(onMarkRead).toHaveBeenCalledWith("n1")
  })

  it("does not mark already-read items again", async () => {
    const user = userEvent.setup()
    const { onMarkRead } = renderBell()
    await user.click(screen.getByRole("button", { name: /notifications/i }))
    await user.click(await screen.findByText("Withdrawal approved"))
    expect(onMarkRead).not.toHaveBeenCalled()
  })

  it("mark-all-read fires the callback", async () => {
    const user = userEvent.setup()
    const { onMarkAllRead } = renderBell()
    await user.click(screen.getByRole("button", { name: /notifications/i }))
    await user.click(await screen.findByRole("button", { name: /mark all read/i }))
    expect(onMarkAllRead).toHaveBeenCalledOnce()
  })

  it("renders the empty state without crashing", async () => {
    const user = userEvent.setup()
    renderBell({ items: [], unreadCount: 0 })
    await user.click(screen.getByRole("button", { name: /notifications/i }))
    expect(await screen.findByText(/no notifications/i)).toBeInTheDocument()
  })
})
