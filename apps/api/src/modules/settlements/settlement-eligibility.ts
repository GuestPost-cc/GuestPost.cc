import { evaluateLockedSettlementEligibility } from "@guestpost/shared"

export async function evaluateSettlementEligibilityTx(
  tx: any,
  orderId: string,
) {
  return evaluateLockedSettlementEligibility(tx, orderId)
}
