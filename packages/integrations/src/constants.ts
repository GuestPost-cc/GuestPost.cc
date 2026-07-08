export const REDIS_KEYS = {
  OAUTH_STATE: "gp:oauth:state:",
  INTEGRATION_LOCK: "gp:integration:lock:",
  INTEGRATION_RATELIMIT: "gp:integration:ratelimit:",
  DISCOVERY_LOCK: "gp:discovery:lock:",
} as const

export const OAUTH_STATE_TTL_SECONDS = 600

export const GOOGLE_SEARCH_CONSOLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
]

export const TOKEN_REFRESH_BEFORE_EXPIRY_MINUTES = 30

export const SYNC_RATE_LIMIT = {
  CONNECT_PER_PUBLISHER_PER_HOUR: 5,
  MANUAL_SYNC_PER_INTEGRATION_PER_HOUR: 10,
} as const

export const POLL_CONFIG = {
  INITIAL_INTERVAL_MS: 2000,
  BACKOFF_AFTER_MS: 60000,
  MAX_INTERVAL_MS: 5000,
  MAX_DURATION_MS: 300000,
} as const
