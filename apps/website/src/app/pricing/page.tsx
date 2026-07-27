import { Button } from "@guestpost/ui"
import {
  ArrowRight,
  Check,
  CircleDollarSign,
  ReceiptText,
  ShieldCheck,
  WalletCards,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { SiteFooter, SiteHeader } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Understand GuestPost placement pricing, publisher fees, protected order balances, and settlement principles.",
  alternates: {
    canonical: "/pricing",
  },
}

const customerPrinciples = [
  "No monthly subscription is required",
  "Placement price and scope are shown before order submission",
  "Accepted orders are backed by reserved platform funds",
  "Cancellation and dispute rules remain linked to the order",
]

const publisherPrinciples = [
  "No charge to create an account or submit a listing",
  "The applicable platform fee is disclosed in the account workflow",
  "The order amount and settlement terms are recorded before acceptance",
  "Current payout availability is shown in the publisher account",
]

const flow = [
  {
    icon: WalletCards,
    title: "Fund",
    body: "Customers add funds through the payment option currently available in their account.",
  },
  {
    icon: CircleDollarSign,
    title: "Reserve",
    body: "The agreed amount is reserved against the order when the workflow requires funded acceptance.",
  },
  {
    icon: ShieldCheck,
    title: "Verify",
    body: "Delivery evidence and the review state determine whether settlement can proceed.",
  },
  {
    icon: ReceiptText,
    title: "Record",
    body: "Settlement, refund, dispute, and adjustment events remain part of the financial history.",
  },
] as const

export default function PricingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative overflow-hidden border-b bg-card">
          <div className="container site-reveal py-20 text-center sm:py-24">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Clear before commitment
            </p>
            <h1 className="mx-auto mt-5 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.045em] sm:text-7xl">
              Pricing follows the placement, not a subscription.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              Customers review the listed service price before ordering.
              Publishers review their applicable fee and settlement terms in the
              account workflow.
            </p>
          </div>
        </section>

        <section className="container grid gap-6 py-16 lg:grid-cols-2 lg:py-20">
          <PricingCard
            eyebrow="Customers"
            title="Pay per placement"
            description="The selected listing and service define the commercial starting point. Any applicable tax or additional charge must be disclosed before commitment."
            points={customerPrinciples}
            cta="Create customer workspace"
            href="/signup?audience=customer"
          />
          <PricingCard
            eyebrow="Publishers"
            title="Fee on completed work"
            description="The platform fee is not duplicated as a hard-coded marketing promise. The effective rate is displayed where the publisher reviews the order and settlement."
            points={publisherPrinciples}
            cta="Review publisher workflow"
            href="/publishers"
            muted
          />
        </section>

        <section className="border-y bg-muted/45 py-16 sm:py-20">
          <div className="container">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Money movement
              </p>
              <h2 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
                Four states, one recorded trail.
              </h2>
              <p className="mt-5 leading-7 text-muted-foreground">
                “Escrow” is not used here as a substitute for a regulated legal
                arrangement. The product describes what it actually does:
                reserve funds, verify delivery, and control settlement.
              </p>
            </div>
            <ol className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {flow.map((item, index) => (
                <li
                  key={item.title}
                  className="rounded-2xl border bg-background p-6 transition-transform duration-300 hover:-translate-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                      <item.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-6 text-xl font-semibold">{item.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    {item.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="container py-16 sm:py-20">
          <div className="grid gap-8 rounded-[2rem] bg-primary p-7 text-primary-foreground sm:p-10 lg:grid-cols-[1fr_auto] lg:items-center lg:p-14">
            <div>
              <h2 className="font-body text-3xl font-semibold">
                Need the policy details?
              </h2>
              <p className="mt-3 max-w-2xl leading-7 text-primary-foreground/65">
                Review cancellations, disputes, wallet credits, and refund
                handling before placing an order.
              </p>
            </div>
            <Button variant="secondary" asChild className="rounded-xl">
              <Link href="/legal/refund-policy">
                Read refund policy
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}

function PricingCard({
  eyebrow,
  title,
  description,
  points,
  cta,
  href,
  muted = false,
}: {
  eyebrow: string
  title: string
  description: string
  points: readonly string[]
  cta: string
  href: string
  muted?: boolean
}) {
  return (
    <article
      className={`rounded-[1.75rem] border p-7 sm:p-10 ${
        muted ? "bg-accent/45" : "bg-card"
      }`}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {eyebrow}
      </p>
      <h2 className="mt-5 text-4xl font-semibold tracking-tight">{title}</h2>
      <p className="mt-4 leading-7 text-muted-foreground">{description}</p>
      <ul className="mt-8 space-y-3">
        {points.map((point) => (
          <li key={point} className="flex items-start gap-3 text-sm">
            <Check
              className="mt-0.5 h-4 w-4 shrink-0 text-accent-foreground"
              aria-hidden="true"
            />
            {point}
          </li>
        ))}
      </ul>
      <Button
        variant={muted ? "default" : "outline"}
        asChild
        className="mt-9 rounded-xl"
      >
        <Link href={href}>
          {cta}
          <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
        </Link>
      </Button>
    </article>
  )
}
