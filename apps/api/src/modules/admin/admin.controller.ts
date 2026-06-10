import { Controller, Get, Param, Patch, Post, Put, Delete, Body, Query, UseGuards, BadRequestException } from "@nestjs/common"
import { AdminService } from "./admin.service"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { SettlementsService } from "../settlements/settlements.service"
import { PublisherPayoutsService } from "../publisher-payouts/publisher-payouts.service"
import { OrdersService } from "../orders/orders.service"
import { OrderDisputeService } from "../orders/services/order-dispute.service"
import { OrderOperationsService } from "../orders/services/order-operations.service"
import { SettlementReasonDto } from "../settlements/dto/settlement-reason.dto"
import { CreatePlatformWebsiteDto, UpdatePlatformWebsiteDto } from "./dto/create-platform-website.dto"
import { ReconciliationService } from "./reconciliation.service"

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max)
const parsePagination = (take?: string, skip?: string) => ({
  take: clamp(take ? parseInt(take, 10) || 50 : 50, 1, 100),
  skip: Math.max(0, skip ? parseInt(skip, 10) || 0 : 0),
})

@Controller("admin")
@UseGuards(StaffRolesGuard)
@StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly settlements: SettlementsService,
    private readonly payouts: PublisherPayoutsService,
    private readonly orders: OrdersService,
    private readonly dispute: OrderDisputeService,
    private readonly ops: OrderOperationsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // Financial drift detector — balances vs transaction history, stuck orders
  @Get("reconciliation")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  runReconciliation() {
    return this.reconciliation.run()
  }

  @Get("users")
  listUsers(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @CurrentUser() user?: any,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.admin.listUsers(t, s, user)
  }

  @Get("users/:id")
  getUser(@Param("id") id: string, @CurrentUser() user?: any) {
    return this.admin.getUser(id, user)
  }

  @Patch("users/:id/role")
  @StaffRoles("SUPER_ADMIN")
  updateUserRole(@Param("id") id: string, @Body("role") role: string, @CurrentUser() user?: any) {
    return this.admin.updateUserRole(id, role, user)
  }

  @Patch("users/:id/staff-role")
  @StaffRoles("SUPER_ADMIN")
  updateStaffRole(@Param("id") id: string, @Body("role") role: string, @CurrentUser() user?: any) {
    return this.admin.updateStaffRole(id, role, user)
  }

  @Get("organizations")
  listOrganizations(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @CurrentUser() user?: any,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.admin.listOrganizations(t, s, user)
  }

  @Get("orders")
  listOrders(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @CurrentUser() user?: any,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.admin.listOrders(t, s, user)
  }

  @Post("orders/:id/manual-verify")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  manualVerify(@Param("id") id: string, @Body("method") method: string, @CurrentUser() user: any) {
    return this.admin.manualVerify(id, method, user.id)
  }

  @Post("orders/:id/refund")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  refundOrder(@Param("id") id: string, @Body("reason") reason: string, @CurrentUser() user: any) {
    return this.admin.refundOrder(id, reason, user.id)
  }

  @Post("disputes/:id/resolve")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  resolveDispute(
    @Param("id") id: string,
    @Body("resolution") resolution: string,
    @Body("action") action: "RESTORE" | "REFUND" | "REJECT",
    @CurrentUser() user: any,
  ) {
    if (!action) throw new BadRequestException("action is required (RESTORE, REFUND, or REJECT)")
    return this.dispute.resolveDispute(id, user.id, user.role, resolution, action)
  }

  @Post("orders/:id/force-cancel")
  @StaffRoles("SUPER_ADMIN")
  forceCancelOrder(@Param("id") id: string, @Body("reason") reason: string, @CurrentUser() user: any) {
    return this.admin.forceCancelOrder(id, reason, user.id)
  }

  // ─── OPERATIONS FULFILLMENT ─────────────────────────

  @Get("orders/platform")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  listPlatformOrders(
    @Query("status") status?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const p = parsePagination(take, skip)
    return this.admin.listPlatformOrders(status, p.take, p.skip)
  }

  @Post("orders/:id/accept")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  acceptPlatformOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.ops.acceptOrder(id, user.id)
  }

  @Post("orders/:id/submit-content")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  submitPlatformContent(@Param("id") id: string, @Body("content") content: string, @CurrentUser() user: any) {
    return this.ops.submitContent(id, user.id, content)
  }

  @Post("orders/:id/mark-content-ready")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  markPlatformContentReady(@Param("id") id: string, @CurrentUser() user: any) {
    return this.ops.markContentReady(id, user.id)
  }

  @Post("orders/:id/submit-for-review")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  submitPlatformForReview(@Param("id") id: string, @CurrentUser() user: any) {
    return this.ops.submitForReview(id, user.id)
  }

  @Post("orders/:id/mark-published")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  markPlatformPublished(@Param("id") id: string, @Body("url") url: string, @CurrentUser() user: any) {
    return this.ops.markPublished(id, user.id, url)
  }

  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("settlements")
  listSettlements(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.settlements.listSettlements(undefined, t, s)
  }

  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("settlements/:id")
  getSettlement(@Param("id") id: string) {
    return this.settlements.getSettlement(id)
  }

  @Post("settlements/orders/:orderId")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  createSettlement(@Param("orderId") orderId: string, @CurrentUser() user: any) {
    // Staff have no organization context — service resolves org from the order
    return this.settlements.createSettlement(orderId, null, user.id)
  }

  @Post("settlements/:id/admin-approve")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  adminApproveSettlement(@Param("id") id: string, @CurrentUser() user: any) {
    return this.settlements.adminApprove(id, user.id, user.role)
  }

  @Post("settlements/:id/force-approve")
  @StaffRoles("SUPER_ADMIN")
  forceApproveSettlement(@Param("id") id: string, @CurrentUser() user: any) {
    return this.settlements.forceApprove(id, user.id, user.role)
  }

  @Post("settlements/:id/cancel")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  cancelSettlement(@Param("id") id: string, @Body() body: SettlementReasonDto, @CurrentUser() user: any) {
    return this.settlements.cancelSettlement(id, user.id, body.reason)
  }

  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("withdrawals")
  listWithdrawals(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.payouts.listWithdrawals(undefined, t, s)
  }

  @Patch("withdrawals/:id/approve")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  approveWithdrawal(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payouts.approveWithdrawal(id, user.id)
  }

  @Patch("withdrawals/:id/mark-paid")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  markWithdrawalPaid(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payouts.markWithdrawalPaid(id, user.id)
  }

  @Patch("withdrawals/:id/reject")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  rejectWithdrawal(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payouts.rejectWithdrawal(id, user.id)
  }

  @Get("marketplace/listings")
  listMarketplaceListings(
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.admin.listMarketplaceListings({
      status,
      type,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    })
  }

  @Get("marketplace/stats")
  getMarketplaceStats() {
    return this.admin.getMarketplaceStats()
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Patch("marketplace/listings/:id/status")
  updateListingStatus(@Param("id") id: string, @Body("status") status: string, @CurrentUser() user: any) {
    return this.admin.updateListingStatus(id, status, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Patch("marketplace/listings/:id/featured")
  toggleListingFeatured(@Param("id") id: string, @Body("featured") featured: boolean, @CurrentUser() user: any) {
    return this.admin.toggleListingFeatured(id, featured, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Patch("marketplace/listings/:id/verified")
  toggleListingVerified(@Param("id") id: string, @Body("verified") verified: boolean, @CurrentUser() user: any) {
    return this.admin.toggleListingVerified(id, verified, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Delete("marketplace/listings/:id")
  deleteListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.deleteListing(id, user)
  }

  // ─── WEBSITE MANAGEMENT ────────────────────────────

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Post("websites")
  createWebsite(@Body() body: CreatePlatformWebsiteDto, @CurrentUser() user: any) {
    return this.admin.createPlatformWebsite(body, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Put("websites/:id")
  updateWebsite(@Param("id") id: string, @Body() body: UpdatePlatformWebsiteDto, @CurrentUser() user: any) {
    return this.admin.updatePlatformWebsite(id, body, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  @Get("websites")
  listWebsites(@Query("ownershipType") ownershipType?: string, @Query() pagination?: any) {
    const p = parsePagination(pagination?.take, pagination?.skip)
    return this.admin.listWebsites(ownershipType, p.take, p.skip)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  @Get("websites/:id")
  getWebsite(@Param("id") id: string) {
    return this.admin.getWebsite(id)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Patch("websites/:id/pause")
  pauseWebsite(@Param("id") id: string, @Body("paused") paused: boolean, @CurrentUser() user: any) {
    return this.admin.pauseWebsite(id, paused, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Delete("websites/:id")
  deleteWebsite(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.deleteWebsite(id, user)
  }
}
