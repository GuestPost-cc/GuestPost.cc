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
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">
              {separator}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
