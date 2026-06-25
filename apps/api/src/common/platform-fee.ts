import { Decimal } from "@prisma/client/runtime/client"

// Splits a gross amount into platform fee and net using exact Decimal math.
// Fee is rounded to cents; net is gross MINUS fee (never a second
// multiplication) so fee + net always equals gross exactly.
export function splitPlatformFee(
  gross: Decimal | number | string,
  feeFraction: number,
): { fee: Decimal; net: Decimal } {
  const g = new Decimal(gross)
  const fee = g
    .mul(new Decimal(feeFraction))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  return { fee, net: g.minus(fee) }
}

// Resolves the platform fee as a fraction (e.g. 0.20) for NEW settlements.
// Source priority: PlatformSettings row → PLATFORM_FEE_PERCENT env → 20%.
// Historical settlements are unaffected (rate is captured at creation time).
export async function resolvePlatformFeeFraction(prisma: any): Promise<number> {
  let pct = 20
  try {
    const settings = await prisma.platformSettings.findFirst()
    if (settings) {
      pct = Number(settings.platformFeePct)
    } else if (process.env.PLATFORM_FEE_PERCENT) {
      pct = Number(process.env.PLATFORM_FEE_PERCENT)
    }
  } catch {
    pct = Number(process.env.PLATFORM_FEE_PERCENT ?? 20)
  }
  if (!Number.isFinite(pct)) pct = 20
  pct = Math.min(Math.max(pct, 0), 100)
  return pct / 100
}
