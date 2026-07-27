import { permanentRedirect } from "next/navigation"
import { BLOG_URL } from "../../lib/site-config"

export default function BlogRedirectPage() {
  permanentRedirect(BLOG_URL)
}
