import { Button } from "@guestpost/ui"
import { CheckCircle2 } from "lucide-react"
import type { Metadata } from "next"
import { SiteFooter, SiteHeader } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "Pricing — Pay Per Placement, No Subscription | GuestPost",
  description:
    "No subscriptions, no minimums. Customers pay the listed price per placement; publishers pay a platform fee only on completed, verified orders.",
}

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b py-20 text-center">
          <div className="container max-w-2xl">
            <h1 className="text-4xl font-bold tracking-tight">
              Simple, usage-based pricing
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              No subscriptions. No retainers. You pay per placement — and only
              for placements that are delivered and verified.
            </p>
          </div>
        </section>

        <section className="container grid gap-8 py-16 md:grid-cols-2">
          <div className="rounded-2xl border p-8">
            <h2 className="text-xl font-semibold">For Customers</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Brands, agencies, SEO teams
            </p>
            <div className="mt-6 text-4xl font-bold">
              Listed price
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                / placement
              </span>
            </div>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "The price on the listing is the price you pay — no hidden markups",
                "Funds held in escrow until delivery is verified",
                "Full refund path with disputes reviewed by our team",
                "Wallet deposits via Stripe (cards)",
                "Unlimited team members per organization",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> {t}
                </li>
              ))}
            </ul>
            <Button className="mt-8 w-full" asChild>
              <a href="/signup?audience=customer">Create account</a>
            </Button>
          </div>

          <div className="rounded-2xl border p-8">
            <h2 className="text-xl font-semibold">For Publishers</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Site owners and content teams
            </p>
            <div className="mt-6 text-4xl font-bold">
              20%
              <span className="text-base font-normal text-muted-foreground">
                {" "}
                platform fee on completed orders
              </span>
            </div>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Free to join, free to list — fee applies only when you get paid",
                "You set your own prices and accept orders you want",
                "Settlement protected by verified delivery + dual approval",
                "Withdraw via bank transfer, PayPal, or Wise",
                "Encrypted payout details with audited access controls",
              ].map((t) => (
                <li key={t} className="flex gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" /> {t}
                </li>
              ))}
            </ul>
            <Button className="mt-8 w-full" variant="outline" asChild>
              <a href="/signup?audience=publisher">Join as publisher</a>
            </Button>
          </div>
        </section>

        <section className="border-t bg-muted/30 py-16">
          <div className="container max-w-3xl">
            <h2 className="text-2xl font-bold">How the money flows</h2>
            <ol className="mt-6 space-y-3 text-sm text-muted-foreground">
              <li>
                <strong className="text-foreground">1. Deposit</strong> — you
                fund your organization wallet via Stripe.
              </li>
              <li>
                <strong className="text-foreground">2. Order</strong> — the
                placement price moves from your wallet into escrow.
              </li>
              <li>
                <strong className="text-foreground">3. Delivery</strong> — the
                publisher publishes; the placement is verified live.
              </li>
              <li>
                <strong className="text-foreground">4. Settlement</strong> —
                after your confirmation, the publisher receives their share
                (listed price minus the platform fee).
              </li>
              <li>
                <strong className="text-foreground">5. Protection</strong> —
                refunds and disputes reverse the flow before any publisher
                payout; chargebacks place automatic holds.
              </li>
            </ol>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
