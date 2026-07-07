"use client"

import { ProviderButton } from "./provider-button"

export interface ProviderConfig {
  id: string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onClick: () => void
}

export interface AuthProvidersProps {
  providers: ProviderConfig[]
  separator?: string
}

export function AuthProviders({
  providers,
  separator = "OR",
}: AuthProvidersProps) {
  if (providers.length === 0) return null

  return (
    <div className="grid gap-3">
      {providers.map((provider) => (
        <ProviderButton
          key={provider.id}
          icon={provider.icon}
          onClick={provider.onClick}
        >
          {provider.label}
        </ProviderButton>
      ))}
      {separator && (
        <div className="relative flex items-center py-2">
          <div className="flex-grow border-t border-[#23252a]" />
          <span className="flex-shrink px-4 text-xs text-[#62666d] tracking-wider">
            {separator}
          </span>
          <div className="flex-grow border-t border-[#23252a]" />
        </div>
      )}
    </div>
  )
}
