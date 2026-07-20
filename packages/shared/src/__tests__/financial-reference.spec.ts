import {
  compactFinancialReference,
  customerWalletStatementDescriptor,
  initialStripeFeeDisclosure,
  normalizeFinancialReference,
  publisherPayoutStatementDescriptor,
  STRIPE_INITIAL_FEE_POLICY_VERSION,
} from "../financial-reference"
import { createFinancialReference } from "../financial-reference-server"

describe("financial references", () => {
  it("creates opaque, typed public references without ambiguous characters", () => {
    const reference = createFinancialReference("DP")
    expect(reference).toMatch(/^GP-DP-[2-9A-HJ-NP-Z]{8}$/)
    expect(reference).not.toMatch(/[01IO]/)
  })

  it("normalizes external values to an ASCII allowlist", () => {
    expect(normalizeFinancialReference("  gp--dp-ä1 / <script>  ")).toBe(
      "GP-DP-A1SCRIPT",
    )
  })

  it("builds bounded customer and publisher descriptors", () => {
    const reference = "GP-WD-ABCD1234"
    expect(compactFinancialReference(reference)).toBe("1234")
    expect(customerWalletStatementDescriptor(reference)).toBe(
      "GUESTPOST* WALLET 1234",
    )
    expect(customerWalletStatementDescriptor(reference)).toHaveLength(22)
    expect(publisherPayoutStatementDescriptor(reference)).toBe("GP1234")
    expect(
      publisherPayoutStatementDescriptor(reference).length,
    ).toBeLessThanOrEqual(10)
  })

  it("never silently reduces the initial rollout amount", () => {
    expect(initialStripeFeeDisclosure(10_000)).toEqual({
      grossMinor: 10_000,
      platformFeeMinor: 0,
      providerFeeMinor: 0,
      customerOrPublisherFeeMinor: 0,
      netMinor: 10_000,
      feePolicyVersion: STRIPE_INITIAL_FEE_POLICY_VERSION,
    })
    expect(() => initialStripeFeeDisclosure(0)).toThrow()
  })
})
