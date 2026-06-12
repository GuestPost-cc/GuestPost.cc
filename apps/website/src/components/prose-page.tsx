import { SiteHeader, SiteFooter } from "./site-chrome"

// Shared shell for text-heavy pages (about, contact, legal)
export function ProsePage({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b py-16">
          <div className="container max-w-3xl">
            <h1 className="text-4xl font-bold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-3 text-lg text-muted-foreground">{subtitle}</p>}
          </div>
        </section>
        <section className="container max-w-3xl space-y-6 py-12 text-sm leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1">
          {children}
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
