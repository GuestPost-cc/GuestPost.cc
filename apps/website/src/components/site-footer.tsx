import { Globe2, ShieldCheck } from "lucide-react"
import Link from "next/link"
import { FOOTER_DOCUMENTATION_LINKS } from "../lib/docs-registry"
import { BLOG_URL, PORTAL_URL } from "../lib/site-config"

const GROUPS = [
  {
    title: "Product",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/publishers", label: "For Publishers" },
      { href: PORTAL_URL, label: "Customer Portal", external: true },
      { href: "/signup", label: "Get started" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: BLOG_URL, label: "Journal", external: true },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Documentation",
    links: FOOTER_DOCUMENTATION_LINKS,
  },
  {
    title: "Legal",
    links: [
      { href: "/legal/terms", label: "Terms" },
      { href: "/legal/privacy", label: "Privacy" },
      { href: "/legal/refund-policy", label: "Refunds" },
      { href: "/legal/acceptable-use", label: "Acceptable use" },
      { href: "/legal/cookie-policy", label: "Cookies" },
    ],
  },
] as const

export function SiteFooter() {
  return (
    <footer className="border-t border-border/80 bg-primary text-primary-foreground">
      <div className="container py-10 sm:py-12">
        <div className="grid grid-cols-2 gap-x-8 gap-y-10 md:grid-cols-4 lg:grid-cols-[minmax(15rem,1.7fr)_repeat(4,minmax(0,1fr))] lg:gap-x-10">
          <div className="col-span-2 md:col-span-4 lg:col-span-1">
            <Link
              href="/"
              className="mb-3 inline-flex items-center gap-2.5 text-xl font-semibold"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-foreground/10">
                <Globe2
                  className="h-[1.15rem] w-[1.15rem]"
                  aria-hidden="true"
                />
              </span>
              GuestPost
            </Link>
            <p className="max-w-sm text-sm leading-6 text-primary-foreground/68 lg:max-w-xs">
              Accountable guest-post operations with verified delivery and
              controlled settlement.
            </p>
            <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary-foreground/15 px-3 py-1.5 text-xs text-primary-foreground/72">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Security-first by design
            </p>
          </div>

          {GROUPS.map((group) => (
            <div key={group.title}>
              <h2 className="font-body mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/48">
                {group.title}
              </h2>
              <ul className="space-y-2 text-sm text-primary-foreground/72">
                {group.links.map((link) => (
                  <li key={link.label}>
                    {"external" in link && link.external ? (
                      <a
                        href={link.href}
                        className="transition-colors hover:text-primary-foreground"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="transition-colors hover:text-primary-foreground"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-primary-foreground/12 pt-6 text-xs text-primary-foreground/55 sm:flex-row sm:items-center sm:justify-between">
          <span>
            &copy; {new Date().getFullYear()} GuestPost. All rights reserved.
          </span>
          <a
            href="mailto:security@guestpost.cc"
            className="inline-flex items-center gap-2 transition-colors hover:text-primary-foreground"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Report a security issue
          </a>
        </div>
      </div>
    </footer>
  )
}
