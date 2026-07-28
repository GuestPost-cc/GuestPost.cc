import {
  DOCUMENTATION_PAGES,
  DOCUMENTATION_POLICY_LINKS,
} from "../../lib/docs-registry"
import {
  BLOG_URL,
  INDEXABLE_ROUTES,
  PUBLIC_CONTENT_UPDATED_AT,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "../../lib/site-config"

export const dynamic = "force-static"

function absoluteUrl(path: string) {
  return `${SITE_URL}${path}`
}

function linkList(paths: readonly string[]) {
  return paths.map((path) => `- ${absoluteUrl(path)}`).join("\n")
}

export function GET() {
  const primaryPaths = INDEXABLE_ROUTES.filter(
    (page) => !page.path.startsWith("/legal/"),
  ).map((page) => page.path)
  const documentationPaths = DOCUMENTATION_PAGES.map((page) => page.href)
  const policyPaths = DOCUMENTATION_POLICY_LINKS.map((policy) => policy.href)

  const body = [
    `# ${SITE_NAME}`,
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    `Canonical site: ${SITE_URL}`,
    `Independent publication: ${BLOG_URL}`,
    `Last updated: ${PUBLIC_CONTENT_UPDATED_AT}`,
    "",
    "## Primary pages",
    "",
    linkList(primaryPaths),
    "",
    "## Documentation",
    "",
    linkList(documentationPaths),
    "",
    "## Policies",
    "",
    linkList(policyPaths),
    "",
    "## Important distinctions",
    "",
    "- Platform-owned listings are managed operationally by GuestPost.",
    "- Publisher-owned listings are fulfilled by the independent publisher.",
    "- Search ranking, indexation, and other third-party SEO outcomes are not guaranteed.",
    "- Current prices, fees, payment methods, and payout availability are shown in the relevant account or order flow.",
    "- Policy pages control over summaries when language differs.",
    "",
  ].join("\n")

  return new Response(body, {
    headers: {
      "Cache-Control":
        "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
