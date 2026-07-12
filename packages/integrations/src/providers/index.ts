import { GoogleAuthProvider } from "./google-auth.provider"
import { GoogleSearchConsoleProvider } from "./google-search-console.provider"
import type { ProviderRegistration } from "./provider.interface"

const registry = new Map<string, ProviderRegistration>()

function register(provider: string, registration: ProviderRegistration) {
  registry.set(provider, registration)
}

register("GOOGLE_SEARCH_CONSOLE", {
  name: "Google Search Console",
  scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  capabilities: {
    oauth: true,
    discovery: true,
    sync: true,
    backfill: true,
    incrementalScopes: false,
  },
  oauthProvider: new GoogleAuthProvider([
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]),
  discoveryProvider: new GoogleSearchConsoleProvider(),
  syncProvider: new GoogleSearchConsoleProvider(),
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
