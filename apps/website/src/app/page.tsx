import { Button } from "@guestpost/ui"
import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Check,
  CircleDollarSign,
  FileCheck2,
  Fingerprint,
  LockKeyhole,
  ScanSearch,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { SiteFooter, SiteHeader } from "../components/site-chrome"
import styles from "./page.module.css"

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
}

const CONTROL_GATES = [
  {
    icon: FileCheck2,
    label: "Brief recorded",
    detail: "Scope and requirements stay attached to the order.",
  },
  {
    icon: LockKeyhole,
    label: "Balance reserved",
    detail: "Accepted work is backed by protected platform funds.",
  },
  {
    icon: ScanSearch,
    label: "Delivery verified",
    detail: "Publication evidence is checked before settlement.",
  },
  {
    icon: BadgeCheck,
    label: "Outcome recorded",
    detail: "Review, dispute, refund, and settlement events remain auditable.",
  },
] as const

const WORKFLOW = [
  {
    number: "01",
    title: "Choose with context",
    body: "Review ownership type, service requirements, pricing, turnaround, and available quality signals before ordering.",
  },
  {
    number: "02",
    title: "Lock the agreement",
    body: "The selected service, article responsibility, brief, price, and policy expectations are captured with the order.",
  },
  {
    number: "03",
    title: "Verify the delivery",
    body: "Publication evidence is checked against the agreed placement instead of relying on a completion message alone.",
  },
  {
    number: "04",
    title: "Resolve before release",
    body: "Review windows and disputes hold the workflow while evidence is assessed and the recorded policy is applied.",
  },
] as const

const SECURITY_POINTS = [
  {
    icon: Fingerprint,
    title: "Protected account access",
    body: "Secure sign-in, recovery controls, session revocation, and suspicious-activity checks protect customer and publisher access.",
  },
  {
    icon: ShieldCheck,
    title: "Controlled money events",
    body: "Funding, reservation, refunds, settlement, and withdrawals use explicit states and durable financial records.",
  },
  {
    icon: UserRoundCheck,
    title: "Human review where it matters",
    body: "Moderation, disputes, suspicious activity, and sensitive exceptions enter accountable review workflows.",
  },
] as const

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main>
        <Hero />
        <TrustRail />
        <Audience />
        <OrderWorkflow />
        <OwnershipModel />
        <Security />
        <CommercialModel />
        <DocumentationCallout />
        <FinalCallToAction />
      </main>
      <SiteFooter />
    </div>
  )
}

function Hero() {
  return (
    <section className={`${styles.hero} overflow-hidden`}>
      <div className="container relative grid items-center gap-14 py-20 lg:grid-cols-[1.08fr_0.92fr] lg:py-28">
        <div className={`${styles.reveal} max-w-3xl`}>
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border bg-background/75 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground shadow-sm backdrop-blur">
            <ShieldCheck className="h-4 w-4 text-accent-foreground" />
            Managed marketplace controls
          </p>
          <h1 className="text-[clamp(3.2rem,8vw,6.8rem)] font-semibold tracking-[-0.055em]">
            <span className="block leading-[0.9]">Guest-post work</span>
            <span className="mt-5 block text-[0.56em] leading-[1.08] italic tracking-[-0.04em] text-muted-foreground sm:mt-6">
              that holds up to scrutiny.
            </span>
          </h1>
          <p className="mt-8 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
            Discover reviewed inventory, record the agreement, verify the
            publication, and resolve exceptions through one accountable order
            workflow.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <Button size="lg" asChild className="h-12 rounded-xl px-6">
              <Link href="/signup?audience=customer">
                Start as a customer
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              asChild
              className="h-12 rounded-xl bg-background/70 px-6"
            >
              <Link href="/publishers">Explore publisher workflow</Link>
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {[
              "No subscription required",
              "Requirements captured",
              "Dispute-aware settlement",
            ].map((item) => (
              <span key={item} className="inline-flex items-center gap-2">
                <Check
                  className="h-4 w-4 text-accent-foreground"
                  aria-hidden="true"
                />
                {item}
              </span>
            ))}
          </div>
        </div>

        <aside
          className={`${styles.controlPanel} ${styles.reveal} ${styles.delayOne}`}
          aria-label="Order protection workflow"
        >
          <div className="flex items-center justify-between border-b border-primary-foreground/10 px-5 py-4 sm:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/45">
                Order control map
              </p>
              <p className="mt-1 text-sm text-primary-foreground/75">
                Four recorded gates
              </p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-300/10 px-3 py-1 text-xs text-emerald-200">
              <span className={styles.statusDot} />
              Protected path
            </span>
          </div>
          <ol className="divide-y divide-primary-foreground/10 px-5 sm:px-6">
            {CONTROL_GATES.map((gate, index) => (
              <li
                key={gate.label}
                className="grid grid-cols-[2.5rem_1fr_auto] items-start gap-3 py-5"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-foreground/8 text-emerald-200">
                  <gate.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span>
                  <strong className="block text-sm font-semibold text-primary-foreground">
                    {gate.label}
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-primary-foreground/55">
                    {gate.detail}
                  </span>
                </span>
                <span className="pt-2 font-mono text-[0.65rem] text-primary-foreground/30">
                  G{index + 1}
                </span>
              </li>
            ))}
          </ol>
          <div className="m-5 rounded-xl border border-emerald-200/15 bg-emerald-200/8 px-4 py-3 text-xs leading-5 text-emerald-100/80 sm:m-6">
            Settlement does not rely on a publisher marking an order complete.
            The recorded delivery and review state control what happens next.
          </div>
        </aside>
      </div>
    </section>
  )
}

function TrustRail() {
  return (
    <section className="border-y bg-primary text-primary-foreground">
      <div className={`container ${styles.trustRailGrid}`}>
        {[
          ["01", "Listings reviewed"],
          ["02", "Funds reserved"],
          ["03", "Delivery evidenced"],
          ["04", "Settlement controlled"],
        ].map(([number, label]) => (
          <div key={label} className={styles.trustRailCell}>
            <span className="font-mono text-[0.65rem] text-emerald-200/65">
              {number}
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-primary-foreground/72">
              {label}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function Audience() {
  return (
    <section className="container py-20 sm:py-24">
      <div className="grid gap-6 lg:grid-cols-2">
        <article
          className={`${styles.editorialCard} ${styles.reveal} rounded-[1.75rem] border bg-card p-7 sm:p-10`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            For customers
          </p>
          <h2 className="mt-5 max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Buy a defined deliverable, not a promise in a spreadsheet.
          </h2>
          <p className="mt-5 max-w-xl leading-7 text-muted-foreground">
            Compare reviewed listings, preserve campaign context, and keep
            requirements, article history, delivery evidence, and support in the
            same order record.
          </p>
          <Button variant="outline" asChild className="mt-8 rounded-xl">
            <Link href="/signup?audience=customer">
              Create a customer workspace
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </article>

        <article
          className={`${styles.editorialCard} ${styles.reveal} ${styles.delayOne} rounded-[1.75rem] border bg-accent/55 p-7 sm:p-10`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-foreground/70">
            For publishers
          </p>
          <h2 className="mt-5 max-w-xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Receive funded, structured work with a recorded settlement path.
          </h2>
          <p className="mt-5 max-w-xl leading-7 text-foreground/68">
            Control your sites, services, pricing, and order acceptance while
            verified delivery and policy-based review replace invoice chasing.
          </p>
          <Button asChild className="mt-8 rounded-xl">
            <Link href="/publishers">
              See the publisher model
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </article>
      </div>
    </section>
  )
}

function OrderWorkflow() {
  return (
    <section className="border-y bg-card py-20 sm:py-24">
      <div className="container">
        <div className="grid gap-8 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              One controlled path
            </p>
            <h2 className="mt-5 text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
              Every transition should explain itself.
            </h2>
            <p className="mt-5 max-w-lg leading-7 text-muted-foreground">
              The workflow is designed around explicit checkpoints, not silent
              status changes. That gives customers, publishers, and support the
              same event history when something needs attention.
            </p>
          </div>

          <ol className={styles.workflowList}>
            {WORKFLOW.map((step) => (
              <li key={step.number} className={styles.workflowItem}>
                <span className="font-mono text-xs text-muted-foreground">
                  {step.number}
                </span>
                <div>
                  <h3 className="text-xl font-semibold">{step.title}</h3>
                  <p className="mt-2 leading-7 text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function OwnershipModel() {
  return (
    <section className="container py-20 sm:py-24">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Responsibility is visible
        </p>
        <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
          Know who owns the listing before you order.
        </h2>
        <p className="mt-5 leading-7 text-muted-foreground">
          Both inventory models use GuestPost controls, but operational
          responsibility is not represented as identical.
        </p>
      </div>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <article className="relative overflow-hidden rounded-[1.75rem] bg-primary p-7 text-primary-foreground sm:p-10">
          <span className="absolute right-6 top-6 rounded-full border border-primary-foreground/15 px-3 py-1 text-xs text-primary-foreground/60">
            GuestPost managed
          </span>
          <CircleDollarSign
            className="h-9 w-9 text-emerald-200"
            aria-hidden="true"
          />
          <h3 className="mt-8 text-3xl font-semibold">
            Platform-owned listings
          </h3>
          <p className="mt-4 max-w-xl leading-7 text-primary-foreground/68">
            GuestPost accepts operational responsibility for listing accuracy,
            fulfillment coordination, delivery verification, support handling,
            and the policy-defined remedy when the agreed placement is not
            delivered.
          </p>
          <p className="mt-6 border-t border-primary-foreground/12 pt-6 text-sm leading-6 text-primary-foreground/52">
            Search ranking, indexation, and third-party algorithmic outcomes are
            not placement guarantees.
          </p>
          <Link
            href="/docs/platform-owned-listings"
            className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-emerald-200 hover:text-emerald-100"
          >
            Read the responsibility model
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </article>

        <article className="rounded-[1.75rem] border bg-card p-7 sm:p-10">
          <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
            Independent publisher
          </span>
          <UserRoundCheck
            className="mt-8 h-9 w-9 text-accent-foreground"
            aria-hidden="true"
          />
          <h3 className="mt-5 text-3xl font-semibold">
            Publisher-owned listings
          </h3>
          <p className="mt-4 max-w-xl leading-7 text-muted-foreground">
            The publisher remains responsible for site control, listing
            representations, content and publication compliance, and delivery.
            GuestPost remains responsible for its own moderation, payment
            controls, evidence workflow, and dispute process.
          </p>
          <Link
            href="/legal/terms"
            className="mt-7 inline-flex items-center gap-2 text-sm font-semibold text-foreground hover:text-accent-foreground"
          >
            Review marketplace terms
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </article>
      </div>
    </section>
  )
}

function Security() {
  return (
    <section className={`${styles.securitySection} border-y py-20 sm:py-24`}>
      <div className="container">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Security is a product boundary
          </p>
          <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
            Controls belong in the workflow, not only in the policy.
          </h2>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {SECURITY_POINTS.map((point) => (
            <article
              key={point.title}
              className={`${styles.editorialCard} rounded-2xl border bg-background/82 p-7 backdrop-blur`}
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <point.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-6 text-xl font-semibold">{point.title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {point.body}
              </p>
            </article>
          ))}
        </div>
        <div className="mt-8 flex flex-col gap-3 rounded-2xl border bg-background/75 p-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            Found a security issue? Our disclosure channel is available without
            an account.
          </span>
          <a
            href="mailto:security@guestpost.cc"
            className="font-semibold text-foreground hover:text-accent-foreground"
          >
            security@guestpost.cc
          </a>
        </div>
      </div>
    </section>
  )
}

function CommercialModel() {
  return (
    <section className="container py-20 sm:py-24">
      <div className="grid overflow-hidden rounded-[2rem] border bg-card lg:grid-cols-[1.05fr_0.95fr]">
        <div className="p-7 sm:p-10 lg:p-14">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Commercial model
          </p>
          <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">
            Pay for the placement. See the terms before commitment.
          </h2>
          <p className="mt-5 max-w-2xl leading-7 text-muted-foreground">
            Customers do not need a monthly subscription. Listing price,
            applicable fees, service scope, and current payment availability are
            shown in the relevant order flow.
          </p>
          <Button asChild className="mt-8 rounded-xl">
            <Link href="/pricing">
              Review pricing principles
              <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="grid content-center gap-4 border-t bg-muted/45 p-7 sm:p-10 lg:border-l lg:border-t-0">
          {[
            "No monthly subscription required",
            "Publisher fee disclosed in the account workflow",
            "Order amount recorded before acceptance",
            "Refund and dispute rules linked before commitment",
          ].map((item) => (
            <div
              key={item}
              className="flex items-start gap-3 rounded-xl border bg-background px-4 py-4 text-sm"
            >
              <Check
                className="mt-0.5 h-4 w-4 shrink-0 text-accent-foreground"
                aria-hidden="true"
              />
              {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function DocumentationCallout() {
  return (
    <section className="border-y bg-card py-16">
      <div className="container flex flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex max-w-3xl items-start gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <BookOpen className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-sans text-2xl font-semibold">
              Understand the workflow before using it.
            </h2>
            <p className="mt-2 leading-7 text-muted-foreground">
              Documentation covers order stages, payments, listing ownership,
              verification, disputes, fraud controls, and account security.
            </p>
          </div>
        </div>
        <Button variant="outline" asChild className="shrink-0 rounded-xl">
          <Link href="/docs">Open documentation</Link>
        </Button>
      </div>
    </section>
  )
}

function FinalCallToAction() {
  return (
    <section className="container py-20 sm:py-24">
      <div
        className={`${styles.finalCta} rounded-[2rem] px-7 py-14 text-center sm:px-12 sm:py-20`}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/50">
          Start with the right role
        </p>
        <h2 className="mx-auto mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-primary-foreground sm:text-6xl">
          Put the agreement, evidence, and outcome in one place.
        </h2>
        <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
          <Button size="lg" variant="secondary" asChild className="rounded-xl">
            <Link href="/signup?audience=customer">
              Create customer workspace
            </Link>
          </Button>
          <Button
            size="lg"
            variant="outline"
            asChild
            className="rounded-xl border-primary-foreground/20 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
          >
            <Link href="/signup?audience=publisher">Join as a publisher</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
