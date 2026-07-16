import { Button } from "@guestpost/ui"
import { Globe } from "lucide-react"
import Link from "next/link"

export const PORTAL_URL =
  process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3001"
export const PUBLISHER_URL =
  process.env.NEXT_PUBLIC_PUBLISHER_URL ?? "http://localhost:3002"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-2 text-xl font-bold tracking-tight"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Globe className="h-5 w-5" />
          </div>
          GuestPost
        </Link>
        <nav className="flex items-center gap-8" aria-label="Main">
          <Link
            href="/publishers"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            For Publishers
          </Link>
          <Link
            href="/pricing"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Pricing
          </Link>
          <Link
            href="/blog"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Blog
          </Link>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" asChild>
              <a href={PUBLISHER_URL}>Publisher Login</a>
            </Button>
            <Button size="sm" asChild>
              <a href={PORTAL_URL}>Get Started</a>
            </Button>
          </div>
        </nav>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t py-16">
      <div className="container">
        <div className="grid gap-12 md:grid-cols-4">
          <div>
            <div className="flex items-center gap-2 text-xl font-bold mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Globe className="h-5 w-5" />
              </div>
              GuestPost
            </div>
            <p className="text-sm text-muted-foreground max-w-xs">
              The managed marketplace for guest posts and editorial links —
              escrowed payments, vetted publishers, verified placements.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/pricing" className="hover:text-foreground">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/publishers" className="hover:text-foreground">
                  For Publishers
                </Link>
              </li>
              <li>
                <a href={PORTAL_URL} className="hover:text-foreground">
                  Customer Portal
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/about" className="hover:text-foreground">
                  About
                </Link>
              </li>
              <li>
                <Link href="/blog" className="hover:text-foreground">
                  Blog
                </Link>
              </li>
              <li>
                <Link href="/contact" className="hover:text-foreground">
                  Contact
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Legal</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link href="/legal/privacy" className="hover:text-foreground">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/legal/terms" className="hover:text-foreground">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link
                  href="/legal/refund-policy"
                  className="hover:text-foreground"
                >
                  Refund Policy
                </Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-12 pt-8 border-t flex items-center justify-between text-sm text-muted-foreground">
          <span>
            &copy; {new Date().getFullYear()} GuestPost. All rights reserved.
          </span>
        </div>
      </div>
    </footer>
  )
}
