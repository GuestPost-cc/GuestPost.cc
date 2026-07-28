import type { Metadata } from "next"

export const DOCUMENTATION_SECTIONS = [
  { id: "start", label: "Start here" },
  { id: "marketplace", label: "Marketplace" },
  { id: "payments", label: "Payments" },
  { id: "trust", label: "Trust and safety" },
] as const

export type DocumentationSectionId =
  (typeof DOCUMENTATION_SECTIONS)[number]["id"]

export type DocumentationIcon =
  | "overview"
  | "orders"
  | "payments"
  | "listings"
  | "fraud"
  | "security"

export type DocumentationPage = {
  href: `/docs${string}`
  title: string
  navLabel: string
  description: string
  section: DocumentationSectionId
  icon: DocumentationIcon
  updatedAt: string
  priority: number
  changeFrequency: "monthly" | "yearly"
  showInFooter: boolean
}

export const DOCUMENTATION_PAGES = [
  {
    href: "/docs",
    title: "Documentation",
    navLabel: "Overview",
    description:
      "Operational references for customers and publishers. Start with the workflow you are about to use.",
    section: "start",
    icon: "overview",
    updatedAt: "2026-07-28",
    priority: 0.8,
    changeFrequency: "monthly",
    showInFooter: true,
  },
  {
    href: "/docs/order-lifecycle",
    title: "Order lifecycle",
    navLabel: "Order lifecycle",
    description:
      "The order timeline records the agreement, the current owner of the next action, and the evidence behind each transition.",
    section: "marketplace",
    icon: "orders",
    updatedAt: "2026-07-28",
    priority: 0.7,
    changeFrequency: "monthly",
    showInFooter: true,
  },
  {
    href: "/docs/platform-owned-listings",
    title: "Platform-owned listings",
    navLabel: "Platform-owned listings",
    description:
      "What GuestPost owns, what we guarantee, and how settlement is handled for listings managed directly by GuestPost.",
    section: "marketplace",
    icon: "listings",
    updatedAt: "2026-07-28",
    priority: 0.7,
    changeFrequency: "monthly",
    showInFooter: false,
  },
  {
    href: "/docs/payments-and-settlement",
    title: "Payments and settlement",
    navLabel: "Payments and settlement",
    description:
      "Money states are explicit. Provider confirmation, platform records, and the order lifecycle must agree before balances change.",
    section: "payments",
    icon: "payments",
    updatedAt: "2026-07-28",
    priority: 0.7,
    changeFrequency: "monthly",
    showInFooter: false,
  },
  {
    href: "/docs/fraud-protection",
    title: "Fraud protection",
    navLabel: "Fraud protection",
    description:
      "Preventive controls, handling, and escalation guidance for suspected marketplace abuse.",
    section: "trust",
    icon: "fraud",
    updatedAt: "2026-07-28",
    priority: 0.7,
    changeFrequency: "monthly",
    showInFooter: false,
  },
  {
    href: "/docs/account-security",
    title: "Account security",
    navLabel: "Account security",
    description:
      "Protect the identity that controls orders, listings, support evidence, organization access, and financial actions.",
    section: "trust",
    icon: "security",
    updatedAt: "2026-07-28",
    priority: 0.7,
    changeFrequency: "monthly",
    showInFooter: true,
  },
] as const satisfies readonly DocumentationPage[]

export type DocumentationHref = (typeof DOCUMENTATION_PAGES)[number]["href"]

export const DOCUMENTATION_POLICY_LINKS = [
  { href: "/legal/terms", label: "Terms of Service" },
  { href: "/legal/privacy", label: "Privacy Policy" },
  { href: "/legal/refund-policy", label: "Refund Policy" },
  { href: "/legal/acceptable-use", label: "Acceptable Use" },
  { href: "/legal/cookie-policy", label: "Cookie Policy" },
] as const

export const FOOTER_DOCUMENTATION_LINKS = DOCUMENTATION_PAGES.filter(
  (page) => page.showInFooter,
).map((page) => ({
  href: page.href,
  label: page.href === "/docs" ? "Documentation" : page.navLabel,
}))

export function findDocumentationPage(href: string) {
  return DOCUMENTATION_PAGES.find((page) => page.href === href)
}

export function getDocumentationPage(href: DocumentationHref) {
  const page = findDocumentationPage(href)

  if (!page) {
    throw new Error(`Documentation page is not registered: ${href}`)
  }

  return page
}

export function getDocumentationNeighbors(href: DocumentationHref) {
  const index = DOCUMENTATION_PAGES.findIndex((page) => page.href === href)

  return {
    previous: index > 0 ? DOCUMENTATION_PAGES[index - 1] : undefined,
    next:
      index >= 0 && index < DOCUMENTATION_PAGES.length - 1
        ? DOCUMENTATION_PAGES[index + 1]
        : undefined,
  }
}

export function getDocumentationMetadata(href: DocumentationHref): Metadata {
  const page = getDocumentationPage(href)

  return {
    title: page.title,
    description: page.description,
    alternates: {
      canonical: page.href,
    },
  }
}
