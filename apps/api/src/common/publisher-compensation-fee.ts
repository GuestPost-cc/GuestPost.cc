import { Decimal } from "@prisma/client/runtime/client"
import { resolvePlatformFeePolicy, splitPlatformFee } from "./platform-fee"

export interface PublisherCompensationFeeSnapshot {
  amount: Decimal
  maximumCompensation: Decimal
  basisPoints: number
  policyVersion: string
}

/** Resolve the immutable fee allocation used when publisher compensation is
 * funded from an order cancellation. Existing settlements are authoritative;
 * otherwise snapshot the current versioned settings row. */
export async function resolvePublisherCompensationFee(
  tx: any,
  grossAmount: Decimal | string | number,
  settlement?: any | null,
): Promise<PublisherCompensationFeeSnapshot> {
  const gross = new Decimal(grossAmount)
  if (settlement) {
    const fee = new Decimal(settlement.platformFee)
    const publisherAmount = new Decimal(settlement.publisherAmount)
    const basisPoints = settlement.platformFeeBps
    const policyVersion = settlement.feePolicyVersion
    if (
      !new Decimal(settlement.grossAmount).equals(gross) ||
      fee.isNegative() ||
      fee.greaterThan(gross) ||
      publisherAmount.isNegative() ||
      !fee.plus(publisherAmount).equals(gross) ||
      !Number.isInteger(basisPoints) ||
      basisPoints < 0 ||
      basisPoints > 10_000 ||
      typeof policyVersion !== "string" ||
      policyVersion.length === 0
    ) {
      throw new Error("Existing settlement fee evidence is incomplete")
    }
    return {
      amount: fee,
      maximumCompensation: publisherAmount,
      basisPoints,
      policyVersion,
    }
  }

  const policy = await resolvePlatformFeePolicy(tx)
  const { fee, net } = splitPlatformFee(gross, policy.fraction)
  return {
    amount: fee,
    maximumCompensation: net,
    basisPoints: policy.basisPoints,
    policyVersion: policy.policyVersion,
  }
}
