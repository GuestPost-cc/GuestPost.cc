import { GoogleMetricsDisabledError } from "./errors"

/**
 * Google marketplace metrics are quarantined until provider resources are
 * cryptographically/transactionally bound to the Website canonical domain.
 *
 * This is intentionally a compile-time gate rather than an environment flag:
 * a missing or mistyped deployment variable must never re-enable ingestion.
 * Re-enabling requires replacing this boundary with the reviewed binding
 * implementation and its database constraints.
 */
export function assertGoogleMetricsEnabled(): void {
  throw new GoogleMetricsDisabledError()
}
