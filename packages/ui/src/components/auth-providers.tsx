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
    <div className="grid gap-4">
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
      </div>
      {separator && (
        <div className="relative flex items-center py-1">
          <div className="flex-grow border-t border-white/10" />
          <span className="flex-shrink px-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#697386]">
            {separator}
          </span>
          <div className="flex-grow border-t border-white/10" />
        </div>
      )}
    </div>
  )
}
