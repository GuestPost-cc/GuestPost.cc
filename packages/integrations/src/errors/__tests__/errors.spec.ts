import {
  IntegrationError,
  IntegrationNotFoundError,
  InvalidStateError,
  NoActiveCredentialError,
  PermissionDeniedError,
  PropertyAlreadyLinkedError,
  PropertyNotFoundError,
  ProviderError,
  ProviderRateLimitError,
  RateLimitedError,
  ReauthRequiredError,
  SyncAlreadyRunningError,
  SyncNotFoundError,
  TokenExpiredError,
  WebsiteAlreadyLinkedError,
  WebsiteIntegrationNotFoundError,
} from ".."

describe("IntegrationError", () => {
  it("creates error with code, message, and details", () => {
    const error = new IntegrationError("TEST_CODE", "Test message", {
      foo: "bar",
    })
    expect(error.code).toBe("TEST_CODE")
    expect(error.message).toBe("Test message")
    expect(error.details).toEqual({ foo: "bar" })
    expect(error.name).toBe("IntegrationError")
  })

  it("creates error without details", () => {
    const error = new IntegrationError("TEST_CODE", "Test message")
    expect(error.details).toBeUndefined()
  })
})

describe("TokenExpiredError", () => {
  it("has correct code and message", () => {
    const error = new TokenExpiredError()
    expect(error.code).toBe("TOKEN_EXPIRED")
    expect(error.message).toBe(
      "The OAuth token has expired. Please reconnect your account.",
    )
    expect(error.name).toBe("TokenExpiredError")
  })

  it("accepts optional details", () => {
    const error = new TokenExpiredError({ integrationId: "abc123" })
    expect(error.details).toEqual({ integrationId: "abc123" })
  })

  it("extends IntegrationError", () => {
    const error = new TokenExpiredError()
    expect(error).toBeInstanceOf(IntegrationError)
  })
})

describe("ReauthRequiredError", () => {
  it("has correct code and message", () => {
    const error = new ReauthRequiredError()
    expect(error.code).toBe("REAUTH_REQUIRED")
    expect(error.message).toBe(
      "Full re-authorization is required. Please reconnect your account.",
    )
    expect(error.name).toBe("ReauthRequiredError")
  })

  it("extends IntegrationError", () => {
    const error = new ReauthRequiredError()
    expect(error).toBeInstanceOf(IntegrationError)
  })
})

describe("InvalidStateError", () => {
  it("has correct default message", () => {
    const error = new InvalidStateError()
    expect(error.code).toBe("INVALID_STATE")
    expect(error.message).toBe("Invalid or expired OAuth state")
    expect(error.name).toBe("InvalidStateError")
  })

  it("accepts custom message", () => {
    const error = new InvalidStateError("Custom state error")
    expect(error.message).toBe("Custom state error")
  })
})

describe("IntegrationNotFoundError", () => {
  it("has correct code and message", () => {
    const error = new IntegrationNotFoundError()
    expect(error.code).toBe("INTEGRATION_NOT_FOUND")
    expect(error.message).toBe("Integration not found")
  })
})

describe("NoActiveCredentialError", () => {
  it("has correct code and message", () => {
    const error = new NoActiveCredentialError()
    expect(error.code).toBe("NO_ACTIVE_CREDENTIAL")
    expect(error.message).toBe(
      "No valid OAuth credential. Please reconnect your account.",
    )
  })
})

describe("PropertyNotFoundError", () => {
  it("has correct code and message", () => {
    const error = new PropertyNotFoundError()
    expect(error.code).toBe("PROPERTY_NOT_FOUND")
    expect(error.message).toBe(
      "Property not found in provider's accessible resources",
    )
  })
})

describe("PropertyAlreadyLinkedError", () => {
  it("includes linkedWebsiteUrl in message when provided", () => {
    const error = new PropertyAlreadyLinkedError("https://example.com")
    expect(error.code).toBe("PROPERTY_ALREADY_LINKED")
    expect(error.message).toContain("https://example.com")
    expect(error.details?.linkedWebsiteUrl).toBe("https://example.com")
  })

  it("uses generic message when no URL provided", () => {
    const error = new PropertyAlreadyLinkedError()
    expect(error.message).toBe(
      "This property is already linked to another website",
    )
  })
})

describe("WebsiteAlreadyLinkedError", () => {
  it("includes existingPropertyUrl when provided", () => {
    const error = new WebsiteAlreadyLinkedError("https://google.com/site")
    expect(error.code).toBe("WEBSITE_ALREADY_LINKED")
    expect(error.message).toContain("https://google.com/site")
    expect(error.details?.existingPropertyUrl).toBe("https://google.com/site")
  })
})

describe("PermissionDeniedError", () => {
  it("has correct code and message", () => {
    const error = new PermissionDeniedError()
    expect(error.code).toBe("PERMISSION_DENIED")
    expect(error.message).toBe("You do not have access to this integration")
  })
})

describe("SyncAlreadyRunningError", () => {
  it("has correct code and message", () => {
    const error = new SyncAlreadyRunningError()
    expect(error.code).toBe("SYNC_ALREADY_RUNNING")
    expect(error.message).toBe(
      "A sync is already in progress for this integration",
    )
  })
})

describe("SyncNotFoundError", () => {
  it("has correct code and message", () => {
    const error = new SyncNotFoundError()
    expect(error.code).toBe("SYNC_NOT_FOUND")
    expect(error.message).toBe("Sync job not found")
  })
})

describe("RateLimitedError", () => {
  it("has correct code and message", () => {
    const error = new RateLimitedError(60)
    expect(error.code).toBe("RATE_LIMITED")
    expect(error.message).toBe("Too many requests. Please try again later.")
    expect(error.details?.retryAfterSeconds).toBe(60)
  })

  it("works without retryAfterSeconds", () => {
    const error = new RateLimitedError()
    expect(error.details?.retryAfterSeconds).toBeUndefined()
  })
})

describe("ProviderRateLimitError", () => {
  it("has correct code and default message", () => {
    const error = new ProviderRateLimitError()
    expect(error.code).toBe("PROVIDER_RATE_LIMIT")
    expect(error.message).toBe(
      "Provider rate limit exceeded. Retry after delay.",
    )
  })

  it("includes provider message when provided", () => {
    const error = new ProviderRateLimitError("Quota exceeded for today")
    expect(error.message).toBe("Quota exceeded for today")
  })
})

describe("ProviderError", () => {
  it("has correct code and message", () => {
    const error = new ProviderError("Service unavailable")
    expect(error.code).toBe("PROVIDER_ERROR")
    expect(error.message).toBe("Service unavailable")
  })

  it("includes provider code in details", () => {
    const error = new ProviderError("Rate limit", "rate_limit_exceeded")
    expect(error.details?.providerCode).toBe("rate_limit_exceeded")
  })
})

describe("WebsiteIntegrationNotFoundError", () => {
  it("has correct code and message", () => {
    const error = new WebsiteIntegrationNotFoundError()
    expect(error.code).toBe("WEBSITE_INTEGRATION_NOT_FOUND")
    expect(error.message).toBe("Website integration not found")
  })
})
