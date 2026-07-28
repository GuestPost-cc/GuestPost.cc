import { Button } from "@guestpost/ui"
import { FileQuestion } from "lucide-react"
import Link from "next/link"
import { SiteFooter, SiteHeader } from "../components/site-chrome"

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="container flex flex-1 items-center justify-center py-20">
        <div className="site-reveal max-w-xl text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
            <FileQuestion className="h-6 w-6" aria-hidden="true" />
          </span>
          <p className="mt-7 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Error 404
          </p>
          <h1 className="mt-4 text-5xl font-semibold tracking-tight">
            This page is not in the record.
          </h1>
          <p className="mt-5 leading-7 text-muted-foreground">
            The address may be outdated, or the page may have moved to a new
            part of the marketplace.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button asChild>
              <Link href="/">Return home</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/docs">Open documentation</Link>
            </Button>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
