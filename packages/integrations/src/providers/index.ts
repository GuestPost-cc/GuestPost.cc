import { GoogleSearchConsoleProvider } from "./google-search-console.provider"
import type {
  IntegrationProviderBase,
  ProviderRegistry,
} from "./provider.interface"

const providers: Map<string, IntegrationProviderBase> = new Map()

function registerDefaultProviders() {
  const gsc = new GoogleSearchConsoleProvider()
  providers.set(gsc.name, gsc)
}

registerDefaultProviders()

export function getProvider(name: string): IntegrationProviderBase {
  const provider = providers.get(name)
  if (!provider) {
    throw new Error(`Unknown integration provider: ${name}`)
  }
  return provider
}

export function listProviders(): IntegrationProviderBase[] {
  return Array.from(providers.values())
}

export function hasProvider(name: string): boolean {
  return providers.has(name)
}

export const providerRegistry: ProviderRegistry = {
  get: getProvider,
  list: listProviders,
  has: hasProvider,
}
