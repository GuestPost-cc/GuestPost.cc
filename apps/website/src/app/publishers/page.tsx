import type { Metadata } from "next"
import { Button } from "@guestpost/ui"
import { DollarSign, ShieldCheck, Clock, FileCheck2, Wallet, ArrowRight } from "lucide-react"
import { SiteHeader, SiteFooter, PUBLISHER_URL } from "../../components/site-chrome"

export const metadata: Metadata = {
  title: "For Publishers — Monetize Your Website | GuestPost",
  description:
    "List your websites, receive vetted guest post orders, and get paid on a protected settlement schedule. Free to join, no exclusivity.",
}

const steps = [
  { icon: FileCheck2, title: "Add your websites", text: "Register your sites and create listings with your own pricing. Our team reviews every listing before it goes live." },
  { icon: Clock, title: "Receive orders", text: "Customers order through the marketplace with funds already escrowed — no chasing invoices, no unpaid work." },
  { icon: ShieldCheck, title: "Deliver and get verified", text: "Publish the content, mark it delivered. Verification confirms the placement is live before settlement starts." },
  { icon: Wallet, title: "Settle and withdraw", text: "Your share lands in your withdrawable balance after dual approval. Withdraw by bank transfer, PayPal, or Wise." },
]

const faqs = [
  { q: "What does it cost to join?", a: "Nothing. Joining and listing are free — the platform takes a percentage of each completed order, deducted automatically at settlement. You set your own prices." },
  { q: "When do I get paid?", a: "Settlement begins once the customer confirms delivery (or the review window lapses). New publishers have a short payout-hold window for fraud protection; established publishers are upgraded to faster tiers." },
  { q: "What if a customer disputes an order?", a: "Disputes pause settlement while our operations team reviews. You'll see the dispute reason and can respond — most disputes resolve within days." },
  { q: "Do I keep control over what gets published?", a: "Completely. You accept or decline every order, and nothing goes live on your site except what you publish yourself." },
  { q: "Which payout methods are supported?", a: "Bank transfer, PayPal, and Wise. Payout details are stored encrypted and are visible only to you and — under audited access — the finance team." },
]

export default function PublishersPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b py-24 text-center">
          <div className="container max-w-3xl">
            <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
              Turn your website&apos;s authority into reliable revenue
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              GuestPost brings you vetted, prepaid guest post orders. Funds are escrowed before you lift a finger,
              and settlement is protected by a verified-delivery workflow.
            </p>
            <div className="mt-8 flex justify-center gap-4">
              <Button size="lg" asChild>
                <a href={PUBLISHER_URL}>Join as a Publisher <ArrowRight className="ml-2 h-4 w-4" /></a>
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Free to join · You set your prices · No exclusivity</p>
          </div>
        </section>

        <section className="container py-20">
          <h2 className="text-center text-3xl font-bold">How it works</h2>
          <div className="mt-12 grid gap-8 md:grid-cols-4">
            {steps.map((s, i) => (
              <div key={s.title} className="relative rounded-xl border p-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <s.icon className="h-5 w-5 text-primary" />
                </div>
                <div className="absolute right-4 top-4 text-4xl font-bold text-muted-foreground/10">{i + 1}</div>
                <h3 className="mt-4 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-y bg-muted/30 py-20">
          <div className="container grid items-center gap-12 md:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold">Payments built like a fintech, not a forum</h2>
              <ul className="mt-6 space-y-4 text-muted-foreground">
                <li className="flex gap-3"><DollarSign className="h-5 w-5 shrink-0 text-primary" /> Customer funds are captured into escrow before an order ever reaches you.</li>
                <li className="flex gap-3"><ShieldCheck className="h-5 w-5 shrink-0 text-primary" /> Every settlement and withdrawal is double-entry tracked and reconciled hourly.</li>
                <li className="flex gap-3"><Wallet className="h-5 w-5 shrink-0 text-primary" /> Payout details are AES-256 encrypted; raw access requires an audited, explicitly granted permission.</li>
              </ul>
            </div>
            <div className="rounded-xl border bg-background p-8">
              <h3 className="font-semibold">Earnings flow</h3>
              <ol className="mt-4 space-y-3 text-sm text-muted-foreground">
                <li>1. Order accepted — funds already escrowed</li>
                <li>2. Content published &amp; verified live</li>
                <li>3. Delivery confirmed → settlement created</li>
                <li>4. Dual approval → your share becomes withdrawable</li>
                <li>5. Withdraw → paid via your chosen method</li>
              </ol>
            </div>
          </div>
        </section>

        <section className="container max-w-3xl py-20">
          <h2 className="text-center text-3xl font-bold">Frequently asked questions</h2>
          <div className="mt-10 space-y-6">
            {faqs.map((f) => (
              <details key={f.q} className="group rounded-lg border p-5">
                <summary className="cursor-pointer font-medium marker:content-none">{f.q}</summary>
                <p className="mt-3 text-sm text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
          <div className="mt-12 text-center">
            <Button size="lg" asChild>
              <a href={PUBLISHER_URL}>Start earning <ArrowRight className="ml-2 h-4 w-4" /></a>
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
