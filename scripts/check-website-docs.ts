import { access, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  DOCUMENTATION_PAGES,
  DOCUMENTATION_SECTIONS,
} from "../apps/website/src/lib/docs-registry"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const docsAppDirectory = path.join(repositoryRoot, "apps/website/src/app/docs")

async function collectPageRoutes(
  directory: string,
  route = "/docs",
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const routes: string[] = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name === "page.tsx") {
      routes.push(route)
    }

    if (entry.isDirectory()) {
      routes.push(
        ...(await collectPageRoutes(
          path.join(directory, entry.name),
          `${route}/${entry.name}`,
        )),
      )
    }
  }

  return routes
}

async function checkDocumentationRegistry() {
  const errors: string[] = []
  const registeredRoutes = DOCUMENTATION_PAGES.map((page) => page.href)
  const sectionIds = new Set(
    DOCUMENTATION_SECTIONS.map((section) => section.id),
  )

  if (new Set(registeredRoutes).size !== registeredRoutes.length) {
    errors.push("Documentation registry contains duplicate routes.")
  }

  for (const page of DOCUMENTATION_PAGES) {
    if (!page.href.startsWith("/docs")) {
      errors.push(`Unsafe documentation route: ${page.href}`)
    }

    if (!sectionIds.has(page.section)) {
      errors.push(
        `Documentation route ${page.href} uses unknown section ${page.section}.`,
      )
    }

    const relativeRoute =
      page.href === "/docs" ? "" : page.href.replace(/^\/docs\//, "")
    const pageFile = path.join(docsAppDirectory, relativeRoute, "page.tsx")

    try {
      await access(pageFile)
    } catch {
      errors.push(`Registered documentation route has no page: ${page.href}`)
    }
  }

  const actualRoutes = await collectPageRoutes(docsAppDirectory)

  for (const route of actualRoutes) {
    if (
      !registeredRoutes.includes(route as (typeof registeredRoutes)[number])
    ) {
      errors.push(`Documentation page is missing from the registry: ${route}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }

  console.log(
    `Documentation registry is aligned with ${registeredRoutes.length} routes.`,
  )
}

void checkDocumentationRegistry().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Documentation registry validation failed.",
  )
  process.exitCode = 1
})
