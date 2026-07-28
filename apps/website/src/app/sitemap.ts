import type { MetadataRoute } from "next"
import { DOCUMENTATION_PAGES } from "../lib/docs-registry"
import {
  INDEXABLE_ROUTES,
  PUBLIC_CONTENT_UPDATED_AT,
  SITE_URL,
} from "../lib/site-config"

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [...INDEXABLE_ROUTES, ...DOCUMENTATION_PAGES]

  return routes.map((page) => {
    const path = "href" in page ? page.href : page.path

    return {
      url: `${SITE_URL}${path}`,
      lastModified: new Date(
        "updatedAt" in page ? page.updatedAt : PUBLIC_CONTENT_UPDATED_AT,
      ),
      changeFrequency: page.changeFrequency,
      priority: page.priority,
    }
  })
}
