import { BadRequestException } from "@nestjs/common"
import { GUARDS_METADATA } from "@nestjs/common/constants"
import { ACTOR_TYPE_KEY } from "../../../common/decorators/actor-type.decorator"
import { MEMBER_ROLES_KEY } from "../../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../../common/guards/member-roles.guard"
import { OrderOwnershipGuard } from "../../../common/guards/order-ownership.guard"
import { OrdersController } from "../orders.controller"

describe("OrdersController publisher content RBAC", () => {
  it("requires an authorized publisher member and order ownership for article submission", () => {
    const handler = OrdersController.prototype.submitContentForReview
    const roles = Reflect.getMetadata(MEMBER_ROLES_KEY, handler)
    const actorTypes = Reflect.getMetadata(ACTOR_TYPE_KEY, handler)
    const guards = Reflect.getMetadata(GUARDS_METADATA, handler)

    expect(roles).toEqual(["PUBLISHER_OWNER", "PUBLISHER_MEMBER"])
    expect(actorTypes).toEqual(["PUBLISHER"])
    expect(guards).toEqual(
      expect.arrayContaining([MemberRolesGuard, OrderOwnershipGuard]),
    )
  })

  it("enforces the shared 200,000-character article ceiling", () => {
    const fulfillment = { submitContentForReview: jest.fn() }
    const controller = new OrdersController(
      {} as any,
      {} as any,
      fulfillment as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )
    const user = {
      id: "publisher-user-1",
      publisherId: "publisher-1",
    }

    controller.submitContentForReview(
      "order-1",
      { content: "a".repeat(200_000) },
      user,
    )
    expect(fulfillment.submitContentForReview).toHaveBeenCalledTimes(1)

    expect(() =>
      controller.submitContentForReview(
        "order-1",
        { content: "a".repeat(200_001) },
        user,
      ),
    ).toThrow(BadRequestException)
    expect(fulfillment.submitContentForReview).toHaveBeenCalledTimes(1)
  })
})
