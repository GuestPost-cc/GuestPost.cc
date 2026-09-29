import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GlobalLoadingBar } from "../global-loading-bar"

describe("GlobalLoadingBar", () => {
  afterEach(() => vi.useRealTimers())

  it("appears after the anti-flicker delay and disappears when activity ends", () => {
    vi.useFakeTimers()
    const { rerender } = render(<GlobalLoadingBar active />)

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(150))
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuetext",
      "Loading",
    )

    rerender(<GlobalLoadingBar active={false} />)
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("does not flash for activity that ends before the delay", () => {
    vi.useFakeTimers()
    const { rerender } = render(<GlobalLoadingBar active />)

    act(() => vi.advanceTimersByTime(149))
    rerender(<GlobalLoadingBar active={false} />)
    act(() => vi.advanceTimersByTime(1))

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })
})
