import { GoogleAnalyticsProvider } from "./google-analytics.provider"
import { GoogleAuthProvider } from "./google-auth.provider"
import { GoogleSearchConsoleProvider } from "./google-search-console.provider"
import type { ProviderRegistration } from "./provider.interface"

const registry = new Map<string, ProviderRegistration>()

function register(provider: string, registration: ProviderRegistration) {
  registry.set(provider, registration)
}

// Shared Google OAuth — requests both Search Console and Analytics scopes
// so a single "Connect Google" grants access to both services.
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
]

register("GOOGLE_SEARCH_CONSOLE", {
  name: "Google Search Console",
  scopes: GOOGLE_SCOPES,
  capabilities: {
    oauth: true,
    discovery: true,
    sync: true,
    backfill: true,
    incrementalScopes: true,
  },
  oauthProvider: new GoogleAuthProvider(GOOGLE_SCOPES),
  discoveryProvider: new GoogleSearchConsoleProvider(),
  syncProvider: new GoogleSearchConsoleProvider(),
})

register("GOOGLE_ANALYTICS", {
  name: "Google Analytics 4",
  scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  capabilities: {
    oauth: false,
    discovery: true,
    sync: true,
    backfill: true,
    incrementalScopes: false,
  },
  discoveryProvider: new GoogleAnalyticsProvider(),
  syncProvider: new GoogleAnalyticsProvider(),
})

export function getProvider(
  provider: string,
): ProviderRegistration | undefined {
  return registry.get(provider)
}

export function listProviders(): ProviderRegistration[] {
  return Array.from(registry.values())
}

export function hasProvider(provider: string): boolean {
  return registry.has(provider)
}
