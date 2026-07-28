import { Button } from "@guestpost/ui"
import {
  ArrowRight,
  FileCheck2,
  Fingerprint,
  Landmark,
  Library,
  ShieldAlert,
  Store,
} from "lucide-react"
import Link from "next/link"
import { DocsArticle } from "../../components/docs-article"
import {
  DOCUMENTATION_PAGES,
  DOCUMENTATION_POLICY_LINKS,
  getDocumentationMetadata,
} from "../../lib/docs-registry"

export const metadata = getDocumentationMetadata("/docs")

const GUIDE_ICONS = {
  overview: Library,
  orders: FileCheck2,
  payments: Landmark,
  listings: Store,
  fraud: ShieldAlert,
  security: Fingerprint,
} as const

const guides = DOCUMENTATION_PAGES.filter((page) => page.href !== "/docs")

export default function DocsHomePage() {
  return (
    <DocsArticle docHref="/docs">
      <div className="rounded-2xl border bg-accent/35 p-5 text-sm leading-7 text-foreground/70">
        Documentation explains product behavior. The Terms, Privacy Policy,
        Refund Policy, and Acceptable Use Policy control where a summary and a
        contractual policy differ.
      </div>

      <h2>Browse operational guides</h2>
      <section className="grid gap-4 md:grid-cols-2">
        {guides.map((guide) => {
          const GuideIcon = GUIDE_ICONS[guide.icon]

          return (
            <article
              key={guide.href}
              className="group rounded-2xl border bg-card p-6 shadow-sm transition-[transform,border-color,box-shadow] duration-300 hover:-translate-y-1 hover:border-foreground/20 hover:shadow-md"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <GuideIcon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="font-body mt-6 text-xl">{guide.title}</h3>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {guide.description}
              </p>
              <Button asChild variant="outline" size="sm" className="mt-5">
                <Link href={guide.href}>
                  Read guide
                  <ArrowRight
                    className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1"
                    aria-hidden="true"
                  />
                </Link>
              </Button>
            </article>
          )
        })}
      </section>

      <h2>How to use these references</h2>
      <ul>
        <li>Check the ownership label before selecting a listing.</li>
        <li>
          Read the displayed service requirements and commercial terms before
          creating or accepting an order.
        </li>
        <li>
          Use the order timeline as the source of truth for current state and
          available actions.
        </li>
        <li>
          Keep support, cancellation, dispute, and fraud reports inside the
          authenticated platform whenever possible.
        </li>
      </ul>

      <h2>Controlling policies</h2>
      <p>
        These guides describe operational behavior. The applicable policy
        controls if a guide and contractual language differ.
      </p>
      <ul>
        {DOCUMENTATION_POLICY_LINKS.map((policy) => (
          <li key={policy.href}>
            <Link href={policy.href}>{policy.label}</Link>
          </li>
        ))}
      </ul>
    </DocsArticle>
  )
}
