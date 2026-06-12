import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@guestpost/ui"
import { Globe, Star, TrendingUp, ShieldCheck } from "lucide-react"
import { SiteHeader, SiteFooter, PORTAL_URL } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "Marketplace — Browse Guest Post & Link Placements | GuestPost",
  description:
    "Browse vetted websites for guest posts, niche edits, and editorial links. Platform-managed and publisher-owned inventory with transparent metrics and escrowed payments.",
}

// Refresh marketplace data every 5 minutes — listings change on moderation,
// not per-request
export const revalidate = 300

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"

interface PublicListing {
  id: string
  title: string
  slug: string
  shortDescription?: string | null
  description: string
  type: string
  fulfillmentType?: "INTERNAL" | "PUBLISHER" | "HYBRID"
  price: number | string
  currency: string
  domainRating?: number | null
  traffic?: number | null
  verified: boolean
  category?: { name: string } | null
}

async function getListings(q?: string, category?: string): Promise<{ listings: PublicListing[]; categories: Array<{ id: string; name: string; slug: string }> }> {
  const params = new URLSearchParams({ limit: "24" })
  if (q) params.set("search", q)
  if (category) params.set("category", category)
  try {
    const [listingsRes, categoriesRes] = await Promise.all([
      fetch(`${API}/api/v1/marketplace/listings?${params}`, { next: { revalidate: 300 } }),
      fetch(`${API}/api/v1/marketplace/categories`, { next: { revalidate: 3600 } }),
    ])
    const listings = listingsRes.ok ? (await listingsRes.json()).listings ?? [] : []
    const categories = categoriesRes.ok ? await categoriesRes.json() : []
    return { listings, categories: Array.isArray(categories) ? categories : [] }
  } catch {
    // API down: render the page shell rather than erroring the marketing site
    return { listings: [], categories: [] }
  }
}

function OwnershipBadge({ type }: { type?: string }) {
  if (type === "INTERNAL")
    return <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Platform</span>
  if (type === "HYBRID")
    return <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600">Hybrid</span>
  return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Publisher</span>
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>
}) {
  const { q, category } = await searchParams
  const { listings, categories } = await getListings(q, category)

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b bg-muted/30 py-16">
          <div className="container">
            <h1 className="text-4xl font-bold tracking-tight">Marketplace</h1>
            <p className="mt-3 max-w-2xl text-lg text-muted-foreground">
              Vetted placements across platform-managed and independent publisher websites.
              Every order is escrowed until delivery is verified.
            </p>
            <form className="mt-6 flex max-w-xl gap-2" action="/marketplace" method="get">
              <input
                type="search"
                name="q"
                defaultValue={q ?? ""}
                placeholder="Search by niche, keyword, or site..."
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                aria-label="Search listings"
              />
              <Button type="submit">Search</Button>
            </form>
            {categories.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  href="/marketplace"
                  className={`rounded-full border px-3 py-1 text-xs ${!category ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  All
                </Link>
                {categories.slice(0, 8).map((c) => (
                  <Link
                    key={c.id}
                    href={`/marketplace?category=${encodeURIComponent(c.slug)}`}
                    className={`rounded-full border px-3 py-1 text-xs ${category === c.slug ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {c.name}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="container py-12">
          {listings.length === 0 ? (
            <div className="flex flex-col items-center py-24 text-center">
              <Globe className="h-12 w-12 text-muted-foreground/40" />
              <h2 className="mt-4 text-xl font-semibold">No listings match</h2>
              <p className="mt-2 text-muted-foreground">Try a different search, or check back soon — new inventory is reviewed daily.</p>
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {listings.map((l) => (
                <div key={l.id} className="group flex flex-col rounded-xl border p-5 transition-shadow hover:shadow-md">
                  <div className="flex items-center gap-2">
                    {l.category && <span className="text-xs font-medium text-primary">{l.category.name}</span>}
                    <span className="text-xs text-muted-foreground">{l.type.replace(/_/g, " ")}</span>
                    <span className="ml-auto"><OwnershipBadge type={l.fulfillmentType} /></span>
                  </div>
                  <h3 className="mt-2 font-semibold leading-snug line-clamp-2">{l.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{l.shortDescription ?? l.description}</p>
                  <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
                    {typeof l.domainRating === "number" && (
                      <span className="inline-flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" /> DR {l.domainRating}</span>
                    )}
                    {typeof l.traffic === "number" && l.traffic > 0 && (
                      <span>{Intl.NumberFormat("en", { notation: "compact" }).format(l.traffic)} visits/mo</span>
                    )}
                    {l.verified && (
                      <span className="inline-flex items-center gap-1 text-green-600"><ShieldCheck className="h-3.5 w-3.5" /> Verified</span>
                    )}
                  </div>
                  <div className="mt-auto flex items-center justify-between pt-5">
                    <span className="text-lg font-bold">${Number(l.price).toFixed(0)}</span>
                    <Button size="sm" asChild>
                      <a href={`${PORTAL_URL}/dashboard/marketplace/${l.slug}`}>Order</a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="border-t bg-muted/30 py-16">
          <div className="container flex flex-col items-center text-center">
            <Star className="h-8 w-8 text-primary" />
            <h2 className="mt-4 text-2xl font-bold">Funds stay in escrow until your link is live and verified</h2>
            <p className="mt-2 max-w-xl text-muted-foreground">
              Publishers are paid only after delivery confirmation — disputes pause settlement automatically.
            </p>
            <Button className="mt-6" size="lg" asChild>
              <a href={PORTAL_URL}>Create your account</a>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
