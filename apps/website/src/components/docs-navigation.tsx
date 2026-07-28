"use client"

import { ChevronDown, FileText, Scale } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useRef } from "react"
import {
  DOCUMENTATION_PAGES,
  DOCUMENTATION_POLICY_LINKS,
  DOCUMENTATION_SECTIONS,
  findDocumentationPage,
} from "../lib/docs-registry"

function NavigationLinks({
  pathname,
  onNavigate,
}: {
  pathname: string
  onNavigate?: () => void
}) {
  return (
    <nav aria-label="Documentation navigation">
      <div className="space-y-7">
        {DOCUMENTATION_SECTIONS.map((section) => {
          const pages = DOCUMENTATION_PAGES.filter(
            (page) => page.section === section.id,
          )

          return (
            <section key={section.id} aria-labelledby={`docs-${section.id}`}>
              <h2
                id={`docs-${section.id}`}
                className="mb-2 px-3 text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-muted-foreground"
              >
                {section.label}
              </h2>
              <ul className="space-y-1">
                {pages.map((page) => {
                  const isActive = pathname === page.href

                  return (
                    <li key={page.href}>
                      <Link
                        href={page.href}
                        aria-current={isActive ? "page" : undefined}
                        onClick={onNavigate}
                        className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-200 ${
                          isActive
                            ? "border-primary/15 bg-primary text-primary-foreground shadow-sm"
                            : "border-transparent text-muted-foreground hover:translate-x-0.5 hover:border-border hover:bg-card hover:text-foreground"
                        }`}
                      >
                        <FileText
                          className="h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{page.navLabel}</span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}

        <section aria-labelledby="docs-policies">
          <h2
            id="docs-policies"
            className="mb-2 px-3 text-[0.68rem] font-semibold uppercase tracking-[0.17em] text-muted-foreground"
          >
            Controlling policies
          </h2>
          <ul className="space-y-1">
            {DOCUMENTATION_POLICY_LINKS.map((policy) => (
              <li key={policy.href}>
                <Link
                  href={policy.href}
                  onClick={onNavigate}
                  className="flex min-h-11 items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color,transform] duration-200 hover:translate-x-0.5 hover:border-border hover:bg-card hover:text-foreground"
                >
                  <Scale className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{policy.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </nav>
  )
}

export function DocsNavigation() {
  const pathname = usePathname()
  const mobileNavigation = useRef<HTMLDetailsElement>(null)
  const currentPage = findDocumentationPage(pathname)

  function closeMobileNavigation() {
    mobileNavigation.current?.removeAttribute("open")
  }

  return (
    <>
      <details
        ref={mobileNavigation}
        className="group rounded-2xl border bg-card shadow-sm lg:hidden"
      >
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-[0.65rem] uppercase tracking-[0.16em] text-muted-foreground">
              Browse documentation
            </span>
            <span className="mt-0.5 block truncate">
              {currentPage?.navLabel ?? "Documentation"}
            </span>
          </span>
          <ChevronDown
            className="h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="border-t p-3">
          <NavigationLinks
            pathname={pathname}
            onNavigate={closeMobileNavigation}
          />
        </div>
      </details>

      <aside aria-label="Documentation navigation" className="hidden lg:block">
        <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-3">
          <div className="mb-7 px-3">
            <Link
              href="/docs"
              className="text-lg font-semibold tracking-[-0.02em] text-foreground"
            >
              Documentation
            </Link>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Product behavior, safeguards, and operational references.
            </p>
          </div>
          <NavigationLinks pathname={pathname} />
        </div>
      </aside>
    </>
  )
}
