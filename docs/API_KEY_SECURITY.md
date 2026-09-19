# API-key security contract

## Scope

API keys are organization-scoped credentials for customer automation. They do
not replace browser sessions, publisher authentication, or staff
authentication. They are accepted only on routes that declare an explicit
permission requirement; every other authenticated route denies API keys by
default.

The server accepts a key only in the `X-API-Key` header. The credential has the
shape `gp_` followed by 64 lowercase hexadecimal characters. Query-string
credentials are not supported. A request that presents an API key together
with a cookie or `Authorization` header is rejected as ambiguous.

## Lifecycle and authority

Only a currently active customer organization `OWNER` may manage keys:

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/v1/api-keys` | Create a key; the raw value is returned once |
| `GET` | `/api/v1/api-keys` | List metadata without the stored digest |
| `DELETE` | `/api/v1/api-keys/:id` | Revoke a key immediately |

Names must contain 3–100 characters. New keys default to the `orders:read`
permission and a 90-day expiry. A requested expiry must be in the future and
no more than 365 days away. The API stores only a SHA-256 digest and writes
audits for creation and revocation.

Authentication revalidates the key and its creator on every request. The key
must be unexpired, its creator must be unbanned and email-verified, and that
creator must still be an active owner of the exact organization recorded on
the key. Revocation, owner demotion/removal, organization deactivation, or user
suspension therefore takes effect on the next request. Interactive active-
context selection cannot move a key to another organization.

Existing rows without trustworthy `createdByUserId` evidence remain stored for
an additive migration but cannot authenticate. Rotate them; do not backfill a
guessed creator.

## Permission and route matrix

The permission catalog is closed and owned by
`packages/shared/src/api-key-permissions.ts`:

| Permission | API-key-enabled routes |
|---|---|
| `orders:read` | `GET /orders`, `GET /orders/:id`, `GET /orders/:id/events` |
| `orders:write` | `POST /orders`, `POST /orders/:id/submit-payment` |
| `reports:read` | `GET /reports`, `GET /reports/:id`, `GET /reports/orders/:id`, `GET /reports/campaigns/:id` |
| `reports:write` | `POST /reports/orders/:id/generate` |

Permissions are necessary but never sufficient: customer role checks,
organization ownership filters, current-authority resolution, response
projection, and PostgreSQL RLS still apply. Publisher and staff routes have no
API-key permission metadata and fail closed.

## Client transport rules

`@guestpost/api-client` accepts an `apiKey` option for server-side automation.
When present it:

- sends `X-API-Key` and omits browser credentials;
- requires the final request to use the configured API origin; and
- requires HTTPS, except for explicit loopback development origins.

The client checks these rules before `fetch`. Do not place API keys in browser
storage, URLs, logs, analytics, error metadata, or client-side bundles. Use a
secret manager, give each integration its own narrowly scoped key, rotate it
before expiry, and revoke it immediately when ownership or workload changes.

API-key syntax alone does not earn the authenticated rate-limit tier. Before
authentication it remains on the anonymous limiter, preventing arbitrary
`X-API-Key` values from increasing an attacker's request budget.

## Verification

The focused unit and contract coverage includes key creation/expiry, owner
authority, RLS lookup isolation, route opt-in and permission checks, ambiguous
credentials, rate-limit classification, and client origin/HTTPS/cookie
behavior. The complete GitHub gate additionally migrates PostgreSQL and runs
the destructive full-application RLS boundary matrix in an isolated database.

See `docs/RLS_ROLLOUT.md` for database policy and lockout-safe rollout, and
`docs/TESTING.md` for the commands and release gate.
