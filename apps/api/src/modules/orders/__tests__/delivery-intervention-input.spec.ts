import { validate } from "class-validator"
import {
  ConfirmDeliveryFraudFlagDto,
  DeliveryInterventionReasonDto,
  OverrideDeliveryVerificationDto,
  ResolveDeliveryFraudFlagDto,
} from "../dto/delivery-intervention.dto"

describe("delivery intervention input", () => {
  it("requires a bounded substantive reason for manual decisions", async () => {
    const valid = Object.assign(new DeliveryInterventionReasonDto(), {
      reason: "Evidence was reviewed directly by Operations.",
    })
    const short = Object.assign(new DeliveryInterventionReasonDto(), {
      reason: "looks okay",
    })

    await expect(validate(valid)).resolves.toEqual([])
    await expect(validate(short)).resolves.not.toEqual([])
  })

  it("requires exact versions and a UUID for confirmed-fraud commands", async () => {
    const valid = Object.assign(new ConfirmDeliveryFraudFlagDto(), {
      reason: "Operations confirmed the delivery integrity violation.",
      expectedOrderVersion: 4,
      expectedVerificationVersion: 2,
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
    })
    const invalidOrderVersion = Object.assign(
      new ConfirmDeliveryFraudFlagDto(),
      {
        reason: "Operations confirmed the delivery integrity violation.",
        expectedOrderVersion: -1,
        expectedVerificationVersion: 2,
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      },
    )
    const invalidVerificationVersion = Object.assign(
      new ConfirmDeliveryFraudFlagDto(),
      {
        reason: "Operations confirmed the delivery integrity violation.",
        expectedOrderVersion: 4,
        expectedVerificationVersion: 1.5,
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      },
    )
    const invalidIdempotencyKey = Object.assign(
      new ConfirmDeliveryFraudFlagDto(),
      {
        reason: "Operations confirmed the delivery integrity violation.",
        expectedOrderVersion: 4,
        expectedVerificationVersion: 2,
        idempotencyKey: "not-a-uuid",
      },
    )

    await expect(validate(valid)).resolves.toEqual([])
    await expect(validate(invalidOrderVersion)).resolves.not.toEqual([])
    await expect(validate(invalidVerificationVersion)).resolves.not.toEqual([])
    await expect(validate(invalidIdempotencyKey)).resolves.not.toEqual([])
  })

  it("allowlists override targets and classified fraud dispositions", async () => {
    const override = Object.assign(new OverrideDeliveryVerificationDto(), {
      targetStatus: "VERIFIED",
      reason: "Evidence was reviewed directly by a Super Admin.",
    })
    const fraud = Object.assign(new ResolveDeliveryFraudFlagDto(), {
      disposition: "AUTHORIZED_REUSE",
      reason: "Finance confirmed the reuse against approved case evidence.",
      evidenceReference: "CASE-1024",
    })
    const unknown = Object.assign(new ResolveDeliveryFraudFlagDto(), {
      disposition: "CLEARED",
      reason: "This is intentionally long enough but remains unclassified.",
    })
    const riskWithoutReference = Object.assign(
      new ResolveDeliveryFraudFlagDto(),
      {
        disposition: "RISK_ACCEPTED",
        reason: "Finance accepted the risk without attaching case evidence.",
      },
    )
    const falsePositiveWithoutReference = Object.assign(
      new ResolveDeliveryFraudFlagDto(),
      {
        disposition: "FALSE_POSITIVE",
        reason: "Operations confirmed the signal was raised in error.",
      },
    )

    await expect(validate(override)).resolves.toEqual([])
    await expect(validate(fraud)).resolves.toEqual([])
    await expect(validate(falsePositiveWithoutReference)).resolves.toEqual([])
    await expect(validate(unknown)).resolves.not.toEqual([])
    await expect(validate(riskWithoutReference)).resolves.not.toEqual([])
  })
})
