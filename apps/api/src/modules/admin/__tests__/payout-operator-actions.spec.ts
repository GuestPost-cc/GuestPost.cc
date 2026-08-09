import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { AdminController } from "../admin.controller"
import {
  ExecuteWithdrawalDto,
  PayoutOperatorReasonDto,
} from "../dto/admin-action-bodies.dto"

describe("Admin payout operator actions", () => {
  it("accepts a normalized 10..500 character reason and rejects missing bounds", async () => {
    const valid = plainToInstance(PayoutOperatorReasonDto, {
      reason: "  Provider evidence checked by Finance  ",
    })
    const tooShort = plainToInstance(PayoutOperatorReasonDto, {
      reason: " too short ",
    })
    const tooLong = plainToInstance(PayoutOperatorReasonDto, {
      reason: "x".repeat(501),
    })

    expect(valid.reason).toBe("Provider evidence checked by Finance")
    await expect(validate(valid)).resolves.toEqual([])
    expect(await validate(tooShort)).not.toEqual([])
    expect(await validate(tooLong)).not.toEqual([])
  })

  it("requires both the provider and bounded reason for an execute command", async () => {
    const valid = plainToInstance(ExecuteWithdrawalDto, {
      providerName: "stripe_connect",
      reason: "Exact payout destination and amount verified",
    })
    const missingReason = plainToInstance(ExecuteWithdrawalDto, {
      providerName: "stripe_connect",
    })

    await expect(validate(valid)).resolves.toEqual([])
    expect(await validate(missingReason)).not.toEqual([])
  })

  it("forwards the normalized operator reason to execute, retry, and cancel services", async () => {
    const payoutExecution = {
      executeWithdrawal: jest.fn().mockResolvedValue({ status: "PROCESSING" }),
      retryExecution: jest.fn().mockResolvedValue({ status: "PROCESSING" }),
      cancelExecution: jest.fn().mockResolvedValue({ status: "CANCELLED" }),
    }
    const controller = { payoutExecution }
    const user = { id: "finance-1" }
    const reason = "Exact provider evidence reviewed by Finance"

    await (AdminController.prototype.executePayout as any).call(
      controller,
      "wd-1",
      { providerName: "stripe_connect", reason },
      user,
    )
    await (AdminController.prototype.retryPayoutExecution as any).call(
      controller,
      "exec-1",
      { reason },
      user,
    )
    await (AdminController.prototype.cancelPayoutExecution as any).call(
      controller,
      "exec-2",
      { reason },
      user,
    )

    expect(payoutExecution.executeWithdrawal).toHaveBeenCalledWith(
      "wd-1",
      "stripe_connect",
      "finance-1",
      reason,
    )
    expect(payoutExecution.retryExecution).toHaveBeenCalledWith(
      "exec-1",
      "finance-1",
      reason,
    )
    expect(payoutExecution.cancelExecution).toHaveBeenCalledWith(
      "exec-2",
      "finance-1",
      reason,
    )
  })
})
