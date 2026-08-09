import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GoneException, RequestMethod } from "@nestjs/common"
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants"
import { ACTOR_TYPE_KEY } from "../../../common/decorators/actor-type.decorator"
import { MEMBER_ROLES_KEY } from "../../../common/decorators/member-roles.decorator"
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator"
import { ActorTypeGuard } from "../../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../../common/guards/member-roles.guard"
import { BillingController } from "../billing.controller"

describe("BillingController direct-deposit surface", () => {
  it("does not expose a direct wallet-credit method or route", () => {
    const controller = new BillingController({} as any)
    const source = readFileSync(
      join(__dirname, "..", "billing.controller.ts"),
      "utf8",
    )

    expect((controller as any).deposit).toBeUndefined()
    expect(source).not.toContain('wallet/:id/deposit"')
    expect(source).not.toContain("ENABLE_DIRECT_DEPOSIT")
  })

  it("exposes a read-only owner-scoped capability projection", () => {
    const capability = {
      available: false,
      code: "CARD_DEPOSITS_DISABLED",
    }
    const billing = {
      getDepositCapability: jest.fn().mockReturnValue(capability),
    }
    const controller = new BillingController(billing as any)
    const handler = BillingController.prototype.getDepositCapability

    expect(controller.getDepositCapability()).toBe(capability)
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "deposit-capability",
    )
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    )
    expect(Reflect.getMetadata(ACTOR_TYPE_KEY, handler)).toEqual(["CUSTOMER"])
    expect(Reflect.getMetadata(MEMBER_ROLES_KEY, handler)).toEqual(["OWNER"])
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(
      expect.arrayContaining([ActorTypeGuard, MemberRolesGuard]),
    )
  })
})

describe("BillingController ledger-read authorization", () => {
  it.each([
    ["wallet", BillingController.prototype.getWallet],
    ["transactions", BillingController.prototype.listTransactions],
  ])("keeps GET /billing/%s customer-owner-only with a fresh membership guard", (path, handler) => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path)
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.GET,
    )
    expect(Reflect.getMetadata(ACTOR_TYPE_KEY, handler)).toEqual(["CUSTOMER"])
    expect(Reflect.getMetadata(MEMBER_ROLES_KEY, handler)).toEqual(["OWNER"])
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(
      expect.arrayContaining([ActorTypeGuard, MemberRolesGuard]),
    )
  })
})

describe("BillingController customer cash-out containment", () => {
  it("returns an explicit gone response without delegating a money mutation", () => {
    const billing = { withdraw: jest.fn() }
    const controller = new BillingController(billing as any)

    let thrown: unknown
    try {
      ;(controller.withdraw as (...args: unknown[]) => never)(
        "wallet-1",
        { amount: 100, idempotencyKey: "caller-controlled-reference" },
        { id: "customer-1", organizationId: "org-1" },
      )
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(GoneException)
    expect((thrown as GoneException).getStatus()).toBe(410)
    expect((thrown as GoneException).getResponse()).toEqual({
      code: "CUSTOMER_WALLET_CASH_OUT_UNSUPPORTED",
      message:
        "Customer wallet cash-out is not supported. Contact support to request review of an eligible return to the original payment method.",
    })
    expect(billing.withdraw).not.toHaveBeenCalled()
  })

  it("remains authenticated, customer-only, and owner-only for legacy callers", () => {
    const handler = BillingController.prototype.withdraw

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      "wallet/:id/withdraw",
    )
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    )
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true)
    expect(Reflect.getMetadata(ACTOR_TYPE_KEY, handler)).toEqual(["CUSTOMER"])
    expect(Reflect.getMetadata(MEMBER_ROLES_KEY, handler)).toEqual(["OWNER"])
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(
      expect.arrayContaining([ActorTypeGuard, MemberRolesGuard]),
    )
  })
})
