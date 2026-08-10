import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  NotificationPreferencesForm,
  type NotificationPreferenceValue,
} from "../notification-preferences-form"

const preferences: NotificationPreferenceValue[] = [
  {
    category: "SECURITY",
    mutable: false,
    inApp: true,
    email: true,
  },
  {
    category: "ORDERS",
    mutable: true,
    inApp: true,
    email: true,
  },
]

describe("NotificationPreferencesForm", () => {
  it("locks mandatory categories and updates optional channels", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <NotificationPreferencesForm
        preferences={preferences}
        onChange={onChange}
        onSave={vi.fn()}
      />,
    )

    expect(
      screen.getByRole("switch", { name: "Security email notifications" }),
    ).toBeDisabled()
    await user.click(
      screen.getByRole("switch", { name: "Orders email notifications" }),
    )
    expect(onChange).toHaveBeenCalledWith([
      preferences[0],
      { ...preferences[1], email: false },
    ])
  })

  it("submits the current preference set", async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(
      <NotificationPreferencesForm
        preferences={preferences}
        onChange={vi.fn()}
        onSave={onSave}
      />,
    )
    await user.click(
      screen.getByRole("button", { name: "Save notification preferences" }),
    )
    expect(onSave).toHaveBeenCalledOnce()
  })
})
