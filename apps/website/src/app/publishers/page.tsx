import { Button } from "@guestpost/ui"
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  FileCheck2,
  Globe2,
  ShieldCheck,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { SiteFooter, SiteHeader } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "For Publishers",
  description:
    "List controlled websites, review funded orders, deliver against recorded requirements, and follow a documented settlement path.",
  alternates: {
    canonical: "/publishers",
  },
}

const steps = [
  {
    icon: Globe2,
    title: "Prove site control",
    text: "Add a root website, complete the required ownership checks, and provide current listing information.",
  },
  {
    icon: FileCheck2,
    title: "Submit for review",
    text: "Define services, pricing, turnaround, and placement rules. Listings are reviewed before marketplace approval.",
  },
  {
    icon: ShieldCheck,
    title: "Accept clear work",
    text: "Review the funded order, customer brief, article responsibility, and recorded service terms before accepting.",
  },
  {
    icon: Banknote,
    title: "Deliver and settle",
    text: "Submit the publication evidence. Verification and the review state determine when funds become withdrawable.",
  },
] as const

const faqs = [
  {
    question: "What does it cost to list?",
    answer:
      "Creating an account and submitting a listing does not require a subscription. The applicable platform fee is disclosed in the publisher workflow and recorded with settlement.",
  },
  {
    question: "Can I decline an order?",
    answer:
      "Yes. Review the brief and service requirements before acceptance. Once accepted, cancellations follow the recorded order and cancellation policy.",
  },
  {
    question: "When does a balance become withdrawable?",
    answer:
      "After the required delivery verification, customer review or applicable review window, and settlement controls are complete. Holds may apply when a dispute, chargeback, fraud signal, or provider uncertainty is active.",
  },
  {
    question: "Which payout methods are available?",
    answer:
      "Availability depends on the currently enabled provider, account eligibility, currency, and rollout status. The publisher account is the source of truth; unavailable methods are not advertised as active.",
  },
  {
    question: "Who controls what is published?",
    answer:
      "The publisher controls its website and decides whether to accept an order. The publisher remains responsible for lawful, accurate, and policy-compliant publication on publisher-owned listings.",
  },
] as const

export default function PublishersPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative overflow-hidden border-b bg-primary text-primary-foreground">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_20%,rgba(110,231,183,.14),transparent_28rem)]" />
          <div className="container site-reveal relative grid gap-12 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-end lg:py-28">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-200/70">
                Publisher operations
              </p>
              <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[0.94] tracking-[-0.045em] sm:text-7xl">
                Turn controlled inventory into accountable revenue.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-primary-foreground/65">
                Receive structured orders backed by reserved funds, keep
                publication control, and move through verification and
                settlement without off-platform invoice chasing.
              </p>
              <Button
                size="lg"
                variant="secondary"
                asChild
                className="mt-9 rounded-xl"
              >
                <Link href="/signup?audience=publisher">
                  Create publisher workspace
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </div>
            <div className="grid gap-3 rounded-[1.75rem] border border-primary-foreground/12 bg-primary-foreground/5 p-5 backdrop-blur sm:p-7">
              {[
                "Website ownership verification",
                "Listing moderation before approval",
                "Order requirements recorded before acceptance",
                "Evidence-based delivery and dispute handling",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-center gap-3 rounded-xl bg-primary-foreground/6 px-4 py-3 text-sm text-primary-foreground/75"
                >
                  <BadgeCheck
                    className="h-4 w-4 shrink-0 text-emerald-200"
                    aria-hidden="true"
                  />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="container py-20 sm:py-24">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Publisher lifecycle
            </p>
            <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
              From site control to withdrawable balance.
            </h2>
          </div>
          <ol className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((step, index) => (
              <li
                key={step.title}
                className="relative rounded-2xl border bg-card p-6 transition-transform duration-300 hover:-translate-y-1"
              >
                <span className="absolute right-5 top-5 font-mono text-xs text-muted-foreground">
                  0{index + 1}
                </span>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                  <step.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-6 text-xl font-semibold">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {step.text}
                </p>
              </li>
            ))}
          </ol>
        </section>

        <section className="border-y bg-card py-20 sm:py-24">
          <div className="container grid gap-10 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Your responsibilities
              </p>
              <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
                Control stays with you. Accountability does too.
              </h2>
              <p className="mt-5 max-w-xl leading-7 text-muted-foreground">
                On publisher-owned listings, you are responsible for site
                control, accurate listing information, publication legality,
                intellectual-property compliance, and delivery against the
                accepted service.
              </p>
              <Link
                href="/legal/acceptable-use"
                className="mt-7 inline-flex items-center gap-2 text-sm font-semibold hover:text-accent-foreground"
              >
                Review marketplace standards
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="rounded-[1.75rem] bg-muted/55 p-7 sm:p-10">
              <h3 className="font-body text-xl font-semibold">
                GuestPost remains responsible for
              </h3>
              <ul className="mt-6 space-y-4">
                {[
                  "Moderation and marketplace access controls",
                  "Recording order scope and financial states",
                  "Delivery evidence and review workflows",
                  "Platform dispute, refund, and settlement operations",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm">
                    <ShieldCheck
                      className="mt-0.5 h-4 w-4 shrink-0 text-accent-foreground"
                      aria-hidden="true"
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="container max-w-4xl py-20 sm:py-24">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Publisher questions
            </p>
            <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
              Read before you list.
            </h2>
          </div>
          <div className="mt-10 space-y-3">
            {faqs.map((faq) => (
              <details
                key={faq.question}
                className="group rounded-2xl border bg-card px-5 py-4 open:shadow-sm sm:px-6"
              >
                <summary className="min-h-11 cursor-pointer content-center font-semibold marker:text-muted-foreground">
                  {faq.question}
                </summary>
                <p className="pb-3 pt-2 text-sm leading-7 text-muted-foreground">
                  {faq.answer}
                </p>
              </details>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Button size="lg" asChild className="rounded-xl">
              <Link href="/signup?audience=publisher">
                Start publisher onboarding
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
