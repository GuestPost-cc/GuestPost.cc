import {
  assertFinanceOperationAllowed,
  type FinanceOperationKind,
  FinanceRuntimeModeError,
} from "@guestpost/shared"
import { ServiceUnavailableException } from "@nestjs/common"

/**
 * Nest boundary for the shared fail-closed finance policy. Public responses
 * expose only a stable code and actionable message, never the internal mode,
 * requested operation, configuration, or provider secrets.
 */
export function assertApiFinanceOperationAllowed(
  operation: FinanceOperationKind,
): void {
  try {
    assertFinanceOperationAllowed(operation)
  } catch (error) {
    if (!(error instanceof FinanceRuntimeModeError)) throw error
    throw new ServiceUnavailableException({
      statusCode: 503,
      error: "Finance operation temporarily unavailable",
      code: error.code,
      message:
        "This financial action is temporarily unavailable. Retry later or contact support.",
    })
  }
}
