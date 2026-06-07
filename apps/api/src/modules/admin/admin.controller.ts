import { Controller, Get, Param, Patch, Post, Delete, Body, Query, UseGuards, BadRequestException } from "@nestjs/common"
import { AdminService } from "./admin.service"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { SettlementsService } from "../settlements/settlements.service"
import { PublisherPayoutsService } from "../publisher-payouts/publisher-payouts.service"

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
  ) {}

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

  @Get("settlements")
  listSettlements() {
    return this.settlements.listSettlements()
  }

  @Get("settlements/:id")
  getSettlement(@Param("id") id: string) {
    return this.settlements.getSettlement(id)
  }

  @Get("withdrawals")
  listWithdrawals() {
    return this.payouts.listWithdrawals()
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

  @Post("settlements/orders/:orderId")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  createSettlement(@Param("orderId") orderId: string, @CurrentUser() user: any) {
    return this.settlements.createSettlement(orderId, user.organizationId, user.id)
  }

  @Post("settlements/:id/approve")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  approveSettlement(@Param("id") id: string, @CurrentUser() user: any) {
    return this.settlements.approveSettlement(id, user.id)
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

  @Patch("marketplace/listings/:id/status")
  updateListingStatus(@Param("id") id: string, @Body("status") status: string, @CurrentUser() user: any) {
    return this.admin.updateListingStatus(id, status, user)
  }

  @Patch("marketplace/listings/:id/featured")
  toggleListingFeatured(@Param("id") id: string, @Body("featured") featured: boolean, @CurrentUser() user: any) {
    return this.admin.toggleListingFeatured(id, featured, user)
  }

  @Patch("marketplace/listings/:id/verified")
  toggleListingVerified(@Param("id") id: string, @Body("verified") verified: boolean, @CurrentUser() user: any) {
    return this.admin.toggleListingVerified(id, verified, user)
  }

  @Delete("marketplace/listings/:id")
  deleteListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.deleteListing(id, user)
  }
}
