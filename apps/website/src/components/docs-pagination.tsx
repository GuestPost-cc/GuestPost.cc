import { ArrowLeft, ArrowRight } from "lucide-react"
import Link from "next/link"
import type { DocumentationPage } from "../lib/docs-registry"

export function DocsPagination({
  previous,
  next,
}: {
  previous?: DocumentationPage
  next?: DocumentationPage
}) {
  if (!previous && !next) {
    return null
  }

  return (
    <nav
      aria-label="Documentation pagination"
      className="mt-14 grid gap-4 border-t pt-8 sm:grid-cols-2"
    >
      {previous ? (
        <Link
          href={previous.href}
          className="group rounded-2xl border bg-card p-5 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm"
        >
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            <ArrowLeft
              className="h-4 w-4 transition-transform group-hover:-translate-x-1"
              aria-hidden="true"
            />
            Previous
          </span>
          <span className="mt-2 block font-semibold text-foreground">
            {previous.navLabel}
          </span>
        </Link>
      ) : (
        <span className="hidden sm:block" aria-hidden="true" />
      )}

      {next && (
        <Link
          href={next.href}
          className="group rounded-2xl border bg-card p-5 text-left transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-sm sm:text-right"
        >
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground sm:justify-end">
            Next
            <ArrowRight
              className="h-4 w-4 transition-transform group-hover:translate-x-1"
              aria-hidden="true"
            />
          </span>
          <span className="mt-2 block font-semibold text-foreground">
            {next.navLabel}
          </span>
        </Link>
      )}
    </nav>
  )
}
