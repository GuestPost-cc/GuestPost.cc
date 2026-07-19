import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { MultiSelect } from "../multi-select"

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
})

const options = Array.from({ length: 8 }, (_, index) => ({
  value: `category-${index + 1}`,
  label: `Category ${index + 1}`,
}))

function Harness() {
  const [value, setValue] = useState<string[]>([])
  return (
    <MultiSelect
      options={options}
      value={value}
      onValueChange={setValue}
      maxSelected={7}
      ariaLabel="Marketplace categories"
    />
  )
}

describe("MultiSelect selection limit", () => {
  it("selects up to seven values, blocks an eighth, and allows replacement", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(
      screen.getByRole("combobox", { name: "Marketplace categories" }),
    )
    const enabledOption = screen
      .getByText("Category 1")
      .closest("[role=option]")
    expect(enabledOption).toHaveAttribute("data-disabled", "false")
    expect(enabledOption).toHaveClass(
      "data-[disabled=true]:pointer-events-none",
    )
    expect(enabledOption).not.toHaveClass("data-[disabled]:pointer-events-none")

    for (let index = 1; index <= 7; index += 1) {
      await user.click(screen.getByText(`Category ${index}`))
    }

    expect(screen.getByText("7/7 selected")).toBeInTheDocument()
    const categoryEight = screen
      .getByText("Category 8")
      .closest("[role=option]")
    expect(categoryEight).toHaveAttribute("aria-disabled", "true")

    await user.click(screen.getByText("Category 1"))
    expect(categoryEight).not.toHaveAttribute("aria-disabled", "true")
    await user.click(screen.getByText("Category 8"))
    expect(screen.getByText("7/7 selected")).toBeInTheDocument()
  })
})
