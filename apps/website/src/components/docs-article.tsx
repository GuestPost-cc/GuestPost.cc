import { CalendarDays, ChevronRight } from "lucide-react"
import Link from "next/link"
import {
  DOCUMENTATION_SECTIONS,
  type DocumentationHref,
  getDocumentationNeighbors,
  getDocumentationPage,
} from "../lib/docs-registry"
import { DocsPagination } from "./docs-pagination"

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`))
}

export function DocsArticle({
  docHref,
  children,
}: {
  docHref: DocumentationHref
  children: React.ReactNode
}) {
  const page = getDocumentationPage(docHref)
  const section = DOCUMENTATION_SECTIONS.find(
    (candidate) => candidate.id === page.section,
  )
  const { previous, next } = getDocumentationNeighbors(docHref)

  return (
    <div className="min-w-0">
      <nav
        aria-label="Breadcrumb"
        className="mb-8 text-sm text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link
              href="/"
              className="rounded-md underline-offset-4 hover:text-foreground hover:underline"
            >
              Home
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          {docHref === "/docs" ? (
            <li aria-current="page" className="font-medium text-foreground">
              Documentation
            </li>
          ) : (
            <>
              <li>
                <Link
                  href="/docs"
                  className="rounded-md underline-offset-4 hover:text-foreground hover:underline"
                >
                  Documentation
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="h-3.5 w-3.5" />
              </li>
              <li aria-current="page" className="font-medium text-foreground">
                {page.navLabel}
              </li>
            </>
          )}
        </ol>
      </nav>

      <header className="site-reveal border-b pb-9 sm:pb-10">
        <p className="text-xs font-semibold uppercase tracking-[0.17em] text-muted-foreground">
          {section?.label ?? "Documentation"}
        </p>
        <h1 className="mt-4 max-w-4xl text-4xl font-semibold leading-[0.98] tracking-[-0.04em] text-foreground sm:text-5xl lg:text-6xl">
          {page.title}
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
          {page.description}
        </p>
        <p className="mt-5 inline-flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          Updated{" "}
          <time dateTime={page.updatedAt}>
            {formatUpdatedAt(page.updatedAt)}
          </time>
        </p>
      </header>

      <article className="space-y-6 py-9 text-[0.98rem] leading-7 text-muted-foreground sm:py-12 [&_a]:font-medium [&_a]:text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline [&_h2]:mt-12 [&_h2]:scroll-mt-28 [&_h2]:border-t [&_h2]:pt-8 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-[-0.02em] [&_h2]:text-foreground [&_h3]:mt-8 [&_h3]:scroll-mt-28 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
        {children}
      </article>

      <DocsPagination previous={previous} next={next} />
    </div>
  )
}
