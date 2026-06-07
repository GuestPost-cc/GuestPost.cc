import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@guestpost/ui", "@guestpost/shared", "@guestpost/api-client"],
}

export default nextConfig
