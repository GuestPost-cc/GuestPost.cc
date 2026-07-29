import { RequestMethod } from "@nestjs/common"
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants"
import { MEMBER_ROLES_KEY } from "../../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../../common/guards/member-roles.guard"
import { PublisherPayoutsController } from "../publisher-payouts.controller"

describe("Publisher payout-method lifecycle routes", () => {
  it.each([
    ["deactivatePayoutMethod", "payout-methods/:id/deactivate"],
    ["reactivatePayoutMethod", "payout-methods/:id/reactivate"],
  ] as const)("%s remains an authenticated publisher-owner POST route", (handlerName, path) => {
    const handler = PublisherPayoutsController.prototype[handlerName]

    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path)
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    )
    expect(Reflect.getMetadata(MEMBER_ROLES_KEY, handler)).toEqual([
      "PUBLISHER_OWNER",
    ])
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual(
      expect.arrayContaining([MemberRolesGuard]),
    )
  })

  it.each([
    ["deactivatePayoutMethod", "deactivatePayoutMethod"],
    ["reactivatePayoutMethod", "reactivatePayoutMethod"],
  ] as const)("%s delegates with publisher and actor identity from the session", async (handlerName, serviceMethod) => {
    const payouts = {
      [serviceMethod]: jest.fn().mockResolvedValue({
        id: "pm-1",
        isActive: serviceMethod === "reactivatePayoutMethod",
        replayed: false,
      }),
    }
    const controller = new PublisherPayoutsController(payouts as any, {} as any)

    await controller[handlerName]("pm-1", {
      id: "owner-1",
      publisherId: "pub-1",
    })

    expect(payouts[serviceMethod]).toHaveBeenCalledWith(
      "pub-1",
      "owner-1",
      "pm-1",
    )
  })
})
