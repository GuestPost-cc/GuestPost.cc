import { DocsNavigation } from "../../components/docs-navigation"
import { SiteFooter, SiteHeader } from "../../components/site-chrome"

export default function DocsLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1 border-b">
        <div className="container grid min-w-0 gap-8 py-7 sm:py-10 lg:grid-cols-[16.5rem_minmax(0,1fr)] lg:gap-12 lg:py-14">
          <DocsNavigation />
          <div className="min-w-0 lg:border-l lg:pl-12">{children}</div>
        </div>
      </main>
      <SiteFooter />
    </div>
  )
}
