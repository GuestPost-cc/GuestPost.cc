"use client"

import { Button } from "@guestpost/ui"
import { ArrowUpRight, Globe2, Menu, X } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { BLOG_URL } from "../lib/site-config"

const MAIN_NAV = [
  { href: "/publishers", label: "For Publishers" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Documentation" },
  { href: BLOG_URL, label: "Journal", external: true },
] as const

function isActivePath(pathname: string, href: string) {
  if (!href.startsWith("/")) return false
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SiteHeader() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/80 bg-background/90 backdrop-blur-xl">
      <div className="container flex h-[4.5rem] items-center justify-between">
        <Link
          href="/"
          className="group flex items-center gap-2.5 font-semibold tracking-tight"
          aria-label="GuestPost home"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-transform duration-300 group-hover:-rotate-3">
            <Globe2 className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
          </span>
          <span className="text-xl">GuestPost</span>
        </Link>

        <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
          {MAIN_NAV.map((item) =>
            "external" in item && item.external ? (
              <a
                key={item.label}
                href={item.href}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                aria-current={
                  isActivePath(pathname, item.href) ? "page" : undefined
                }
                className={`text-sm transition-colors ${
                  isActivePath(pathname, item.href)
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/login">Log in</Link>
          </Button>
          <Button size="sm" asChild className="rounded-lg px-4">
            <Link href="/signup">Get started</Link>
          </Button>
        </div>

        <button
          type="button"
          className="inline-flex h-11 w-11 items-center justify-center rounded-xl border bg-card transition-colors hover:bg-muted lg:hidden"
          onClick={() => setMobileOpen((open) => !open)}
          aria-expanded={mobileOpen}
          aria-controls="mobile-site-nav"
          aria-label={mobileOpen ? "Close navigation" : "Open navigation"}
        >
          {mobileOpen ? (
            <X className="h-5 w-5" aria-hidden="true" />
          ) : (
            <Menu className="h-5 w-5" aria-hidden="true" />
          )}
        </button>
      </div>

      <div
        id="mobile-site-nav"
        className={`overflow-hidden border-t bg-background transition-[max-height,padding] duration-300 lg:hidden ${
          mobileOpen ? "max-h-[30rem] py-4" : "max-h-0 py-0"
        }`}
      >
        <nav className="container grid gap-1" aria-label="Mobile primary">
          {MAIN_NAV.map((item) =>
            "external" in item && item.external ? (
              <a
                key={item.label}
                href={item.href}
                className="flex min-h-11 items-center justify-between rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setMobileOpen(false)}
              >
                {item.label}
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            ) : (
              <Link
                key={item.label}
                href={item.href}
                className={`flex min-h-11 items-center rounded-lg px-3 text-sm ${
                  isActivePath(pathname, item.href)
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
                onClick={() => setMobileOpen(false)}
              >
                {item.label}
              </Link>
            ),
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-4">
            <Button variant="outline" asChild>
              <Link href="/login" onClick={() => setMobileOpen(false)}>
                Log in
              </Link>
            </Button>
            <Button asChild>
              <Link href="/signup" onClick={() => setMobileOpen(false)}>
                Get started
              </Link>
            </Button>
          </div>
        </nav>
      </div>
    </header>
  )
}
