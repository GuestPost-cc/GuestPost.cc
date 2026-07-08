import { IntegrationProvider } from "@guestpost/integrations"
import type { LucideIcon } from "lucide-react"
import { BarChart3, Globe, Search } from "lucide-react"
import { cn } from "../../../lib/utils"
import { Badge } from "../../badge"

interface ProviderMeta {
  label: string
  icon: LucideIcon
  color: string
  displayOrder: number
  comingSoon: boolean
  supportsDiscovery: boolean
  supportsSync: boolean
  supportsMetrics: boolean
  documentationUrl?: string
}

const PROVIDER_METADATA: Record<IntegrationProvider, ProviderMeta> = {
  [IntegrationProvider.GOOGLE_SEARCH_CONSOLE]: {
    label: "Google Search Console",
    icon: Search,
    color: "text-blue-500",
    displayOrder: 1,
    comingSoon: false,
    supportsDiscovery: true,
    supportsSync: true,
    supportsMetrics: false,
    documentationUrl: "https://search.google.com/search-console/about",
  },
  [IntegrationProvider.GOOGLE_ANALYTICS]: {
    label: "Google Analytics",
    icon: BarChart3,
    color: "text-orange-500",
    displayOrder: 2,
    comingSoon: true,
    supportsDiscovery: false,
    supportsSync: false,
    supportsMetrics: true,
  },
  [IntegrationProvider.BING_WEBMASTER]: {
    label: "Bing Webmaster",
    icon: Globe,
    color: "text-sky-500",
    displayOrder: 3,
    comingSoon: true,
    supportsDiscovery: false,
    supportsSync: false,
    supportsMetrics: false,
  },
}

interface ProviderBadgeProps {
  provider: IntegrationProvider
  className?: string
}

function ProviderBadge({ provider, className }: ProviderBadgeProps) {
  const meta = PROVIDER_METADATA[provider]
  if (!meta) {
    return <Badge variant="outline">{provider}</Badge>
  }
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn("gap-1.5", className)}>
      <Icon className={cn("h-3.5 w-3.5", meta.color)} aria-hidden="true" />
      <span>{meta.label}</span>
    </Badge>
  )
}

export type { ProviderBadgeProps }
export { PROVIDER_METADATA, ProviderBadge }
