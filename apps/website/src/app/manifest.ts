import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GuestPost",
    short_name: "GuestPost",
    description:
      "Managed guest-post placements with verified delivery and controlled settlement.",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f5ef",
    theme_color: "#0c1b2a",
  }
}
