import Link from "next/link"
import { Button } from "@guestpost/ui"
import { SiteHeader, SiteFooter, PORTAL_URL, PUBLISHER_URL } from "../components/site-chrome"
import {
  Shield,
  ShieldCheck,
  Zap,
  BarChart3,
  Users,
  Globe,
  Star,
  ArrowRight,
  CheckCircle2,
  ChevronRight
} from "lucide-react"

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main>
        <Hero />
        <TrustedBy />
        <Features />
        <HowItWorks />
        <Pricing />
        <WhyTrust />
        <CTA />
      </main>
      <SiteFooter />
    </div>
  )
}

function Hero() {
  return (
    <section className="relative overflow-hidden py-24 lg:py-32">
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-gradient-to-r from-primary/20 via-primary/10 to-transparent rounded-full blur-3xl" />
        <div className="absolute bottom-0 right-0 w-[600px] h-[600px] bg-blue-500/10 rounded-full blur-3xl" />
      </div>
      <div className="container flex flex-col items-center text-center gap-8">
        <div className="inline-flex items-center gap-2 rounded-full border bg-muted/50 px-4 py-1.5 text-sm font-medium">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span>Escrowed payments • Verified delivery</span>
        </div>
        <h1 className="max-w-4xl text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
          <span className="bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
            Build SEO Authority
          </span>
          <br />
          <span className="text-primary">at Scale</span>
        </h1>
        <p className="max-w-2xl text-xl text-muted-foreground leading-relaxed">
          A managed marketplace for guest posts and editorial links — vetted publishers,
          escrowed orders, and verified placements, all in one workflow.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 mt-4">
          <Button size="lg" className="gap-2" asChild>
            <a href={PORTAL_URL}>
              Get Started <ArrowRight className="h-4 w-4" />
            </a>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a href={PUBLISHER_URL}>
              Become a Publisher
            </a>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          Free to start • Funds escrowed until delivery is verified
        </p>
      </div>
    </section>
  )
}

function TrustedBy() {
  return (
    <section className="border-y py-12 bg-muted/30">
      <div className="container">
        <p className="text-center text-sm text-muted-foreground mb-8">
          Powering guest post campaigns for industry leaders
        </p>
        <div className="flex flex-wrap items-center justify-center gap-12 opacity-60">
          {['TechCrunch', 'Forbes', 'Entrepreneur', 'HubSpot', 'Moz'].map((brand) => (
            <span key={brand} className="text-xl font-semibold text-muted-foreground">
              {brand}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

function Features() {
  const features = [
    {
      icon: <Globe className="h-6 w-6" />,
      title: "Publisher Discovery",
      description: "Browse vetted publishers with domain ratings, real traffic data, and topical relevance — every listing reviewed before it can sell.",
    },
    {
      icon: <Zap className="h-6 w-6" />,
      title: "Automated Outreach",
      description: "Send personalized outreach at scale with AI-generated templates that convert. Track every email and follow-up.",
    },
    {
      icon: <BarChart3 className="h-6 w-6" />,
      title: "Performance Analytics",
      description: "Monitor DA growth, referral traffic, and ROI in real-time. Get weekly reports delivered to your inbox.",
    },
    {
      icon: <Shield className="h-6 w-6" />,
      title: "Quality Guaranteed",
      description: "Every link comes with a 12-month guarantee. Past clients get priority placement and exclusive rates.",
    },
    {
      icon: <Users className="h-6 w-6" />,
      title: "Dedicated Account Manager",
      description: "Work with SEO experts who understand your niche. Custom strategies and white-label reporting available.",
    },
    {
      icon: <CheckCircle2 className="h-6 w-6" />,
      title: "One-Click Reporting",
      description: "Generate beautiful client reports in one click. Impress stakeholders with live dashboards and milestone tracking.",
    },
  ]

  return (
    <section id="features" className="py-24">
      <div className="container">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
            Everything you need to win at guest posting
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            From discovery to publication, we handle the complexity so you can focus on strategy.
          </p>
        </div>
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div 
              key={feature.title} 
              className="group relative rounded-2xl border bg-card p-8 shadow-sm hover:shadow-lg hover:border-primary/20 transition-all duration-300"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary mb-6 group-hover:scale-110 transition-transform">
                {feature.icon}
              </div>
              <h3 className="font-semibold text-lg mb-2">{feature.title}</h3>
              <p className="text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function HowItWorks() {
  const steps = [
    {
      number: "01",
      title: "Tell us your goals",
      description: "Share your target keywords, DA requirements, and budget. Our team curates a publisher list just for you.",
    },
    {
      number: "02", 
      title: "Approve or customize",
      description: "Review your matched publishers with traffic data, pricing, and turnaround time. Swap any that don't fit.",
    },
    {
      number: "03",
      title: "We create & place",
      description: "Our writers craft authentic content and coordinate with publishers. You approve before anything goes live.",
    },
    {
      number: "04",
      title: "Track & celebrate",
      description: "Watch your backlinks index, DA grow, and traffic climb. All metrics in one dashboard with auto-reporting.",
    },
  ]

  return (
    <section id="how-it-works" className="py-24 bg-muted/30">
      <div className="container">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
            From pitch to publish in 14 days
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Our streamlined process gets you quality backlinks without the headache.
          </p>
        </div>
        <div className="grid gap-8 lg:grid-cols-4">
          {steps.map((step, i) => (
            <div key={step.number} className="relative">
              <div className="flex flex-col items-center text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-2xl font-bold mb-6">
                  {step.number}
                </div>
                <h3 className="font-semibold text-lg mb-2">{step.title}</h3>
                <p className="text-muted-foreground text-sm">{step.description}</p>
              </div>
              {i < steps.length - 1 && (
                <div className="hidden lg:block absolute top-8 left-[60%] w-[80%] border-t border-dashed border-muted-foreground/30" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function Pricing() {
  const plans = [
    {
      name: "Starter",
      price: "499",
      description: "Perfect for small agencies and freelancers",
      features: [
        "5 guest posts per month",
        "DA 30+ publishers only",
        "Basic analytics dashboard",
        "Email support",
      ],
      cta: "Start Free Trial",
      popular: false,
    },
    {
      name: "Professional",
      price: "1,299",
      description: "For growing agencies with active campaigns",
      features: [
        "15 guest posts per month",
        "DA 50+ publishers",
        "Advanced analytics + reports",
        "Dedicated account manager",
        "Custom outreach templates",
      ],
      cta: "Start Free Trial",
      popular: true,
    },
    {
      name: "Enterprise",
      price: "Custom",
      description: "For teams with scale requirements",
      features: [
        "Unlimited guest posts",
        "Any DA range available",
        "White-label reporting",
        "API access",
        "SLA guarantee",
      ],
      cta: "Contact Sales",
      popular: false,
    },
  ]

  return (
    <section id="pricing" className="py-24">
      <div className="container">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
            Simple, transparent pricing
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Every plan includes access to our full publisher network. No hidden fees.
          </p>
        </div>
        <div className="grid gap-8 lg:grid-cols-3 max-w-5xl mx-auto">
          {plans.map((plan) => (
            <div 
              key={plan.name}
              className={`relative rounded-2xl border bg-card p-8 shadow-sm ${
                plan.popular ? 'border-primary shadow-lg ring-1 ring-primary/20' : ''
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-primary px-4 py-1 text-sm font-medium text-primary-foreground">
                  Most Popular
                </div>
              )}
              <div className="mb-6">
                <h3 className="font-semibold text-xl mb-2">{plan.name}</h3>
                <p className="text-muted-foreground text-sm">{plan.description}</p>
              </div>
              <div className="mb-6">
                <span className="text-4xl font-bold">${plan.price}</span>
                {plan.price !== "Custom" && <span className="text-muted-foreground">/month</span>}
              </div>
              <ul className="space-y-3 mb-8">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3 text-sm">
                    <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <Button className="w-full" variant={plan.popular ? "default" : "outline"}>
                {plan.cta} <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// Value cards instead of fabricated testimonials — never invent people or
// quotes for a money platform pre-launch (trust + legal liability)
function WhyTrust() {
  const points = [
    {
      icon: ShieldCheck,
      title: "Your money is escrowed",
      body: "Order funds are captured into escrow and released to the publisher only after the placement is verified live and you confirm delivery.",
    },
    {
      icon: CheckCircle2,
      title: "Every listing is reviewed",
      body: "Publishers can't sell until our team reviews their listing. No PBNs, no surprise placements — real sites with real editorial standards.",
    },
    {
      icon: BarChart3,
      title: "Disputes pause settlement",
      body: "If something goes wrong after delivery, open a dispute — settlement freezes automatically while our team reviews, with full refund where upheld.",
    },
  ]
  return (
    <section className="py-24 bg-muted/30">
      <div className="container">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
            Built like a fintech, not a forum
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Link building usually runs on trust and spreadsheets. We replaced that with escrow, verification, and accountability.
          </p>
        </div>
        <div className="grid gap-8 md:grid-cols-3">
          {points.map((p) => (
            <div key={p.title} className="rounded-2xl bg-card p-8 shadow-sm">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10">
                <p.icon className="h-5 w-5 text-primary" />
              </div>
              <h3 className="mt-5 font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function CTA() {
  return (
    <section className="py-24">
      <div className="container">
        <div className="relative rounded-3xl bg-primary px-8 py-16 text-primary-foreground overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/90 to-primary" />
          <div className="absolute right-0 bottom-0 w-1/2 h-full opacity-20">
            <div className="absolute bottom-0 right-0 w-96 h-96 bg-white/20 rounded-full blur-3xl" />
          </div>
          <div className="relative max-w-2xl mx-auto text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">
              Ready to build your SEO authority?
            </h2>
            <p className="text-primary-foreground/80 text-lg mb-8">
              Start building authority on a marketplace where every order is escrowed and every placement is verified.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" variant="secondary" className="gap-2" asChild>
                <a href={PORTAL_URL}>
                  Start Free Trial <ArrowRight className="h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" className="bg-transparent border-primary-foreground/30 text-primary-foreground hover:bg-primary-foreground/10">
                Schedule Demo
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

