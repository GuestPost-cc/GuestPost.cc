import { render, screen } from "@testing-library/react"
import { LayoutDashboard, Store } from "lucide-react"
import { describe, expect, it } from "vitest"
import { NavItem } from "../nav-item"

describe("NavItem", () => {
  it("renders children text", () => {
    render(
      <NavItem icon={LayoutDashboard} href="/dashboard">
        Overview
      </NavItem>,
    )
    expect(screen.getByText("Overview")).toBeInTheDocument()
  })

  it("renders the icon", () => {
    const { container } = render(
      <NavItem icon={Store} href="/marketplace">
        Marketplace
      </NavItem>,
    )
    const svg = container.querySelector("svg")
    expect(svg).toBeInTheDocument()
  })

  it("renders as an anchor element", () => {
    render(
      <NavItem icon={LayoutDashboard} href="/dashboard">
        Overview
      </NavItem>,
    )
    const link = screen.getByText("Overview").closest("a")
    expect(link).toBeInTheDocument()
  })

  it("sets the href on the anchor", () => {
    render(
      <NavItem icon={LayoutDashboard} href="/dashboard">
        Overview
      </NavItem>,
    )
    const link = screen.getByText("Overview").closest("a")
    expect(link).toHaveAttribute("href", "/dashboard")
  })

  describe("active state styles", () => {
    it("applies active classes when isActive is true", () => {
      render(
        <NavItem icon={LayoutDashboard} href="/dashboard" isActive>
          Overview
        </NavItem>,
      )
      const link = screen.getByText("Overview").closest("a")
      expect(link?.className).toContain("bg-primary/10")
      expect(link?.className).toContain("text-primary")
      expect(link?.className).not.toContain("hover:bg-surface-1")
    })

    it("applies default classes when isActive is false", () => {
      render(
        <NavItem icon={LayoutDashboard} href="/dashboard" isActive={false}>
          Overview
        </NavItem>,
      )
      const link = screen.getByText("Overview").closest("a")
      expect(link?.className).not.toContain("bg-primary/10")
      expect(link?.className).not.toContain("text-primary")
    })

    it("applies default classes when isActive is not set", () => {
      render(
        <NavItem icon={LayoutDashboard} href="/dashboard">
          Overview
        </NavItem>,
      )
      const link = screen.getByText("Overview").closest("a")
      expect(link?.className).toContain("text-muted-foreground")
      expect(link?.className).toContain("hover:bg-surface-1")
      expect(link?.className).toContain("hover:text-foreground")
    })
  })

  describe("styling constants", () => {
    it("always has rounded-md, text-sm, and font-medium", () => {
      render(
        <NavItem icon={LayoutDashboard} href="/dashboard">
          Overview
        </NavItem>,
      )
      const link = screen.getByText("Overview").closest("a")
      expect(link?.className).toContain("rounded-md")
      expect(link?.className).toContain("text-sm")
      expect(link?.className).toContain("font-medium")
    })

    it("has transition-all duration-200 for smooth hover", () => {
      render(
        <NavItem icon={LayoutDashboard} href="/dashboard">
          Overview
        </NavItem>,
      )
      const link = screen.getByText("Overview").closest("a")
      expect(link?.className).toContain("transition-all")
      expect(link?.className).toContain("duration-200")
    })
  })

  describe("className merging", () => {
    it("merges additional class names", () => {
      render(
        <NavItem
          icon={LayoutDashboard}
          href="/dashboard"
          className="extra-class"
        >
          Overview
        </NavItem>,
      )
      const link = screen.getByText("Overview").closest("a")
      expect(link?.className).toContain("extra-class")
    })
  })
})
