import type { MetadataRoute } from "next"
import { SITE_DESCRIPTION, SITE_NAME } from "../lib/site-config"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#f7f5ef",
    theme_color: "#0c1b2a",
  }
}
