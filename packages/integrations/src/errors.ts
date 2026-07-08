export class IntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "IntegrationError"
  }
}

export class TokenExpiredError extends IntegrationError {
  constructor(details?: Record<string, unknown>) {
    super(
      "TOKEN_EXPIRED",
      "The OAuth token has expired. Please reconnect your account.",
      details,
    )
    this.name = "TokenExpiredError"
  }
}

export class ReauthRequiredError extends IntegrationError {
  constructor(details?: Record<string, unknown>) {
    super(
      "REAUTH_REQUIRED",
      "Full re-authorization is required. Please reconnect your account.",
      details,
    )
    this.name = "ReauthRequiredError"
  }
}

export class InvalidStateError extends IntegrationError {
  constructor(message = "Invalid or expired OAuth state") {
    super("INVALID_STATE", message)
    this.name = "InvalidStateError"
  }
}

export class IntegrationNotFoundError extends IntegrationError {
  constructor() {
    super("INTEGRATION_NOT_FOUND", "Integration not found")
    this.name = "IntegrationNotFoundError"
  }
}

export class WebsiteIntegrationNotFoundError extends IntegrationError {
  constructor() {
    super("WEBSITE_INTEGRATION_NOT_FOUND", "Website integration not found")
    this.name = "WebsiteIntegrationNotFoundError"
  }
}

export class PropertyNotFoundError extends IntegrationError {
  constructor() {
    super(
      "PROPERTY_NOT_FOUND",
      "Property not found in provider's accessible resources",
    )
    this.name = "PropertyNotFoundError"
  }
}

export class PropertyAlreadyLinkedError extends IntegrationError {
  constructor(linkedWebsiteUrl?: string) {
    super(
      "PROPERTY_ALREADY_LINKED",
      linkedWebsiteUrl
        ? `This property is already linked to ${linkedWebsiteUrl}`
        : "This property is already linked to another website",
      { linkedWebsiteUrl },
    )
    this.name = "PropertyAlreadyLinkedError"
  }
}

export class WebsiteAlreadyLinkedError extends IntegrationError {
  constructor(existingPropertyUrl?: string) {
    super(
      "WEBSITE_ALREADY_LINKED",
      existingPropertyUrl
        ? `This website already has a linked property (${existingPropertyUrl})`
        : "This website already has a linked property",
      { existingPropertyUrl },
    )
    this.name = "WebsiteAlreadyLinkedError"
  }
}

export class PermissionDeniedError extends IntegrationError {
  constructor() {
    super("PERMISSION_DENIED", "You do not have access to this integration")
    this.name = "PermissionDeniedError"
  }
}

export class SyncAlreadyRunningError extends IntegrationError {
  constructor() {
    super(
      "SYNC_ALREADY_RUNNING",
      "A sync is already in progress for this integration",
    )
    this.name = "SyncAlreadyRunningError"
  }
}

export class SyncNotFoundError extends IntegrationError {
  constructor() {
    super("SYNC_NOT_FOUND", "Sync job not found")
    this.name = "SyncNotFoundError"
  }
}

export class RateLimitedError extends IntegrationError {
  constructor(retryAfterSeconds?: number) {
    super("RATE_LIMITED", "Too many requests. Please try again later.", {
      retryAfterSeconds,
    })
    this.name = "RateLimitedError"
  }
}

export class ProviderRateLimitError extends IntegrationError {
  constructor(providerMessage?: string) {
    super(
      "PROVIDER_RATE_LIMIT",
      providerMessage ?? "Provider rate limit exceeded. Retry after delay.",
    )
    this.name = "ProviderRateLimitError"
  }
}

export class ProviderError extends IntegrationError {
  constructor(message: string, providerCode?: string) {
    super("PROVIDER_ERROR", message, { providerCode })
    this.name = "ProviderError"
  }
}

export class NoActiveCredentialError extends IntegrationError {
  constructor() {
    super(
      "NO_ACTIVE_CREDENTIAL",
      "No valid OAuth credential. Please reconnect your account.",
    )
    this.name = "NoActiveCredentialError"
  }
}

export class DiscoveryInProgressError extends IntegrationError {
  constructor() {
    super(
      "DISCOVERY_IN_PROGRESS",
      "A discovery job is already in progress for this integration",
    )
    this.name = "DiscoveryInProgressError"
  }
}
