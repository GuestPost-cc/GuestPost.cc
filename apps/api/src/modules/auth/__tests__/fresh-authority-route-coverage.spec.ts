import { GUARDS_METADATA, MODULE_METADATA } from "@nestjs/common/constants"
import { APP_GUARD } from "@nestjs/core"
import { ActorTypeGuard } from "../../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../../common/guards/member-roles.guard"
import { OrderOwnershipGuard } from "../../../common/guards/order-ownership.guard"
import { StaffRolesGuard } from "../../../common/guards/staff-roles.guard"
import { OrdersController } from "../../orders/orders.controller"
import { PublisherPayoutsController } from "../../publisher-payouts/publisher-payouts.controller"
import { SettlementsController } from "../../settlements/settlements.controller"
import { SupportController } from "../../support/support.controller"
import { AuthGuard } from "../auth.guard"
import { AuthModule } from "../auth.module"
import { CurrentAuthorityGuard } from "../current-authority.guard"

function guardsOf(controller: any, handlerName: string): unknown[] {
  const handler = controller.prototype[handlerName]
  return [
    ...(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []),
    ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? []),
  ]
}

describe("fresh authority route inventory", () => {
  it("runs durable authority resolution after session authentication", () => {
    const metadata =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AuthModule) ?? []
    const globalGuards = metadata
      .filter((provider: any) => provider?.provide === APP_GUARD)
      .map((provider: any) => provider.useClass)

    expect(globalGuards).toEqual([AuthGuard, CurrentAuthorityGuard])
  })

  it.each([
    [OrdersController, "list", [ActorTypeGuard, MemberRolesGuard]],
    [OrdersController, "get", [ActorTypeGuard, OrderOwnershipGuard]],
    [
      OrdersController,
      "cancellationPreview",
      [ActorTypeGuard, OrderOwnershipGuard],
    ],
    [
      OrdersController,
      "requestCancellation",
      [ActorTypeGuard, OrderOwnershipGuard],
    ],
    [
      OrdersController,
      "respondToCancellation",
      [ActorTypeGuard, OrderOwnershipGuard],
    ],
    [SupportController, "listTickets", [ActorTypeGuard, MemberRolesGuard]],
    [SupportController, "getTicket", [ActorTypeGuard, MemberRolesGuard]],
    [SupportController, "addMessage", [ActorTypeGuard, MemberRolesGuard]],
    [SettlementsController, "get", [ActorTypeGuard, MemberRolesGuard]],
    [PublisherPayoutsController, "requestWithdrawal", [MemberRolesGuard]],
    [PublisherPayoutsController, "approveWithdrawal", [StaffRolesGuard]],
  ])("%p.%s declares its fresh authority guards", (controller, handlerName, requiredGuards) => {
    expect(guardsOf(controller, handlerName as string)).toEqual(
      expect.arrayContaining(requiredGuards as unknown[]),
    )
  })

  it("passes the durable publisher identity into payout read services", async () => {
    const payouts = {
      getBalance: jest.fn(),
      listWithdrawals: jest.fn(),
    }
    const controller = new PublisherPayoutsController(payouts as any, {} as any)
    const authority = { id: "owner-1", publisherId: "publisher-1" }

    controller.getBalance(authority)
    controller.listWithdrawals(authority, "25", "5")

    expect(payouts.getBalance).toHaveBeenCalledWith("publisher-1", "owner-1")
    expect(payouts.listWithdrawals).toHaveBeenCalledWith(
      "publisher-1",
      25,
      5,
      undefined,
      "owner-1",
    )
  })
})
