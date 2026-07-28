import { SiteFooter, SiteHeader } from "./site-chrome"

// Shared shell for text-heavy pages (about, contact, legal)
export function ProsePage({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative overflow-hidden border-b bg-card py-16 sm:py-20">
          <div
            className="absolute inset-0 opacity-30"
            style={{
              backgroundImage:
                "linear-gradient(rgba(12,27,42,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(12,27,42,.06) 1px, transparent 1px)",
              backgroundSize: "48px 48px",
              maskImage: "linear-gradient(to bottom, black, transparent)",
            }}
          />
          <div className="container site-reveal relative max-w-4xl">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              GuestPost reference
            </p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[0.96] tracking-[-0.04em] sm:text-6xl">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-5 max-w-3xl text-lg leading-8 text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>
        </section>
        <article className="container max-w-4xl space-y-6 py-12 text-[0.98rem] leading-7 text-muted-foreground sm:py-16 [&_a]:font-medium [&_a]:text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline [&_h2]:mt-12 [&_h2]:border-t [&_h2]:pt-8 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:mt-8 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_strong]:font-semibold [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6">
          {children}
        </article>
      </main>
      <SiteFooter />
    </div>
  )
}
