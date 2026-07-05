import {
  buildSettlementEligibilitySnapshot,
  evaluateSettlementEligibility,
} from "@guestpost/shared"

export async function evaluateSettlementEligibilityTx(
  tx: any,
  orderId: string,
) {
  const snapshot = await buildSettlementEligibilitySnapshot(tx, orderId)
  return evaluateSettlementEligibility(snapshot)
}
