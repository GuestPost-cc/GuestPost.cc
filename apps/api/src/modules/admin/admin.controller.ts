import {
  CancellationRequestStatus,
  FulfillmentChannel,
  OrderStatus,
  SettlementStatus,
  WithdrawalStatus,
} from "@guestpost/database"
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import { Request, Response } from "express"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { Permissions } from "../../common/decorators/permissions.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { PermissionsGuard } from "../../common/guards/permissions.guard"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import {
  ListingServiceInput,
  UpdateListingServiceInput,
} from "../marketplace/dto/marketplace.dto"
import { MarketplaceService } from "../marketplace/marketplace.service"
import {
  CancelOrderDto,
  CreateCancellationRequestDto,
  FinanceApproveCancellationDto,
  ForceCancelOrderDto,
  RespondCancellationRequestDto,
  ReviewCancellationRequestDto,
} from "../orders/dto/order-cancellation.dto"
import { OrdersService } from "../orders/orders.service"
import { OrderCancellationService } from "../orders/services/order-cancellation.service"
import { OrderDisputeService } from "../orders/services/order-dispute.service"
import { OrderOperationsService } from "../orders/services/order-operations.service"
import { OrderReviewService } from "../orders/services/order-review.service"
import { DecryptPayoutMethodDto } from "../publisher-payouts/dto/decrypt-payout-method.dto"
import { PayoutExecutionService } from "../publisher-payouts/payout-execution.service"
import { PublisherPayoutsService } from "../publisher-payouts/publisher-payouts.service"
import { SettlementReasonDto } from "../settlements/dto/settlement-reason.dto"
import { SettlementsService } from "../settlements/settlements.service"
import { AddTicketMessageDto } from "../support/dto/add-ticket-message.dto"
import { SupportActor, SupportService } from "../support/support.service"
import { AdminService } from "./admin.service"
import { CommandCenterService } from "./command-center.service"
import {
  BulkRetryVerificationDto,
  CommitWebsiteImportDto,
  CreateStaffDto,
  ExecuteWithdrawalDto,
  ForceVerifyWebsitesDto,
  ManualVerifyDto,
  MarkPlatformPublishedDto,
  MarkVerifiedDto,
  PauseWebsiteDto,
  PreviewWebsiteImportDto,
  ReassignWebsiteDto,
  RejectVerificationDto,
  RequestReverifyDto,
  ResolveDisputeDto,
  RestoreUserDto,
  ReverseWithdrawalDto,
  SubmitPlatformContentDto,
  SuspendUserDto,
  ToggleListingFeaturedDto,
  ToggleListingVerifiedDto,
  UpdateListingStatusDto,
  UpdatePlatformFeeDto,
  UpdatePublisherTierDto,
  UpdateStaffRoleDto,
  UpdateSupportTicketStatusDto,
  UpdateUserRoleDto,
} from "./dto/admin-action-bodies.dto"
import {
  CreatePlatformWebsiteDto,
  UpdatePlatformWebsiteDto,
} from "./dto/create-platform-website.dto"
import { GetRevenueQueryDto } from "./dto/get-revenue-query.dto"
import { buildRevenueCsvFilename, streamRevenueCsv } from "./finance/csv-stream"
import { RevenueService } from "./finance/revenue.service"
import { FinanceWorkbenchService } from "./finance-workbench.service"
import { OperationsWorkbenchService } from "./operations-workbench.service"
import { ReconciliationService } from "./reconciliation.service"
import { AdminVerificationQueueService } from "./verification-queue.service"
import { websiteImportTemplateCsv } from "./website-import/csv-parser"
import { WebsiteImportService } from "./website-import/website-import.service"
import { WebsiteVerificationService } from "./website-verification.service"

// Build the staff actor from the authenticated user. The matrix lives in
// SupportService — this just hands it the role context. customerRole +
// publisherRole are intentionally left null for staff: they're acting in
// their staff capacity, not as a member of any org / publisher.
function staffActor(user: any): SupportActor {
  return {
    userId: user.id,
    kind: "STAFF",
    staffRole: user.staffRole ?? null,
    customerRole: null,
    publisherRole: null,
  }
}

function staffCancellationActor(user: any) {
  return {
    userId: user.id,
    kind: "STAFF" as const,
    staffRole: user.staffRole ?? null,
  }
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), max)
const parsePagination = (take?: string, skip?: string) => ({
  take: clamp(take ? parseInt(take, 10) || 50 : 50, 1, 100),
  skip: Math.max(0, skip ? parseInt(skip, 10) || 0 : 0),
})

// Phase 6.7 — Audit finding #2 remediation.
//
// IMPORTANT — RBAC contract for this controller:
//
//   Every handler MUST declare its own @StaffRoles(...). There is no
//   class-level fallback. The previous class-level @StaffRoles was a footgun:
//   StaffRolesGuard.canActivate returns `true` when no role metadata is
//   present, so the class-level grant + getAllAndOverride pattern meant a
//   handler missing its decorator silently inherited the broadest grant.
//
//   Without the class-level decorator, a missing per-handler @StaffRoles
//   would ALSO fail open — so the rule is: if you add a new route here, you
//   MUST add @StaffRoles(...). The lint sweep in __tests__/role-coverage.spec.ts
//   asserts this contract at test time.
//
// Role-allocation guide:
//
//   SUPER_ADMIN only          — high-blast-radius writes (force-cancel,
//                                force-approve, staff-role changes, audit
//                                logs), global users / organizations, and
//                                cross-staff assignment
//   SUPER_ADMIN + FINANCE     — money writes (refund, settlement approve /
//                                cancel, withdrawal lifecycle, payout
//                                execute / decrypt) + Finance-only reads
//                                (publishers, settlements, withdrawals)
//   SUPER_ADMIN + OPERATIONS  — fulfillment, listing moderation, manual
//                                verification, and dispute resolution
//   SUPER_ADMIN only          — website/listing inventory and service edits
//   ALL THREE                 — contextual order, dispute, cancellation,
//                                support, and platform-settings reads. These
//                                may include the minimum customer / publisher
//                                context needed to complete the work item, but
//                                do not grant access to a global directory.
@Controller("admin")
@UseGuards(StaffRolesGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly settlements: SettlementsService,
    private readonly payouts: PublisherPayoutsService,
    readonly _orders: OrdersService,
    private readonly dispute: OrderDisputeService,
    private readonly cancellation: OrderCancellationService,
    private readonly ops: OrderOperationsService,
    private readonly reconciliation: ReconciliationService,
    private readonly payoutExecution: PayoutExecutionService,
    private readonly marketplace: MarketplaceService,
    private readonly websiteVerification: WebsiteVerificationService,
    private readonly orderReview: OrderReviewService,
    private readonly support: SupportService,
    private readonly revenue: RevenueService,
    private readonly verificationQueue: AdminVerificationQueueService,
    private readonly commandCenter: CommandCenterService,
    private readonly financeWorkbench: FinanceWorkbenchService,
    private readonly operationsWorkbench: OperationsWorkbenchService,
    private readonly websiteImport: WebsiteImportService,
  ) {}

  @Get("command-center")
  @StaffRoles("SUPER_ADMIN")
  @Header("Cache-Control", "private, no-store, no-cache, must-revalidate")
  @Header("Pragma", "no-cache")
  getCommandCenter() {
    return this.commandCenter.getCommandCenter()
  }

  @Get("finance-workbench")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Header("Cache-Control", "private, no-store, no-cache, must-revalidate")
  @Header("Pragma", "no-cache")
  getFinanceWorkbench(@CurrentUser() user: any) {
    return this.financeWorkbench.getWorkbench(user.staffRole)
  }

  @Get("operations-workbench")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Header("Cache-Control", "private, no-store, no-cache, must-revalidate")
  @Header("Pragma", "no-cache")
  getOperationsWorkbench(@CurrentUser() user: any) {
    return this.operationsWorkbench.getWorkbench({
      id: user.id,
      staffRole: user.staffRole,
    })
  }

  // Recompute a publisher's trust score + tier from their full track record.
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Post("publishers/:id/recompute-trust")
  recomputePublisherTrust(@Param("id") id: string) {
    return this.orderReview.recomputePublisherTrust(id)
  }

  // ── Verification governance + review center ────────────────────────────────
  @StaffRoles("SUPER_ADMIN")
  @Get("websites/force-approved")
  forceApprovedReport(@CurrentUser() user: any) {
    return this.websiteVerification.forceApprovedReport(user.id)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Get("websites/verification")
  verificationReviewCenter(
    @Query("publisherId") publisherId?: string,
    @Query("domain") domain?: string,
    @Query("status") status?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.websiteVerification.reviewCenter({
      publisherId,
      domain,
      status,
      from,
      to,
    })
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Post("websites/verification/bulk-retry")
  bulkRetryVerification(
    @Body() body: BulkRetryVerificationDto,
    @CurrentUser() user: any,
  ) {
    return this.websiteVerification.bulkRetry(body.websiteIds, user.id)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Post("websites/:id/recompute-trust")
  recomputeTrust(@Param("id") id: string) {
    return this.websiteVerification.recomputeTrustScore(id)
  }

  // Financial drift detector — balances vs transaction history, stuck orders
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("reconciliation")
  runReconciliation() {
    return this.reconciliation.run()
  }

  // Phase 7.1 — PlatformRevenue dashboard. Category B (Financial); matches the
  // `reconciliation` precedent. Revenue inspection is a Finance concern with
  // no operational use case for Operations.
  @Get("finance/revenue")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  async getRevenue(@Query() query: GetRevenueQueryDto, @Res() res: Response) {
    try {
      const data = await this.revenue.getRevenue({
        from: query.from,
        to: query.to,
        groupBy: query.groupBy,
      })
      if (query.format === "csv") {
        const filename = buildRevenueCsvFilename({
          from: query.from,
          to: query.to,
          groupBy: query.groupBy,
        })
        streamRevenueCsv(res, data, filename)
        return
      }
      res.json(data)
    } catch (err) {
      // Date-range validation lives in the service; surface as 400 not 500.
      if (
        err instanceof Error &&
        /Invalid date|must be on or after/.test(err.message)
      ) {
        throw new BadRequestException(err.message)
      }
      throw err
    }
  }

  @Get("users")
  @StaffRoles("SUPER_ADMIN")
  listUsers(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("search") search?: string,
    @Query("userType") userType?: string,
    @Query("role") role?: string,
    @Query("status") status?: string,
    @CurrentUser() user?: any,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.admin.listUsers({
      take: t,
      skip: s,
      search,
      userType,
      role,
      status,
      _user: user,
    })
  }

  @Post("staff")
  @StaffRoles("SUPER_ADMIN")
  createStaff(@Body() body: CreateStaffDto, @CurrentUser() user: any) {
    return this.admin.createStaff(body, user)
  }

  @Get("staff/performance")
  @StaffRoles("SUPER_ADMIN")
  staffPerformance() {
    return this.admin.staffPerformance()
  }

  @Get("users/:id")
  @StaffRoles("SUPER_ADMIN")
  getUser(@Param("id") id: string, @CurrentUser() user?: any) {
    return this.admin.getUser(id, user)
  }

  @Patch("users/:id/role")
  @StaffRoles("SUPER_ADMIN")
  updateUserRole(
    @Param("id") id: string,
    @Body() body: UpdateUserRoleDto,
    @CurrentUser() user?: any,
  ) {
    const role = body.role
    return this.admin.updateUserRole(id, role, user)
  }

  @Patch("users/:id/staff-role")
  @StaffRoles("SUPER_ADMIN")
  updateStaffRole(
    @Param("id") id: string,
    @Body() body: UpdateStaffRoleDto,
    @CurrentUser() user?: any,
  ) {
    const role = body.role
    return this.admin.updateStaffRole(id, role, user)
  }

  @Post("users/:id/suspension")
  @StaffRoles("SUPER_ADMIN")
  suspendUser(
    @Param("id") id: string,
    @Body() body: SuspendUserDto,
    @CurrentUser() user?: any,
  ) {
    return this.admin.suspendUser(id, body, user)
  }

  @Post("users/:id/suspension/restore")
  @StaffRoles("SUPER_ADMIN")
  restoreUser(
    @Param("id") id: string,
    @Body() body: RestoreUserDto,
    @CurrentUser() user?: any,
  ) {
    return this.admin.restoreUser(id, body, user)
  }

  @Get("organizations")
  @StaffRoles("SUPER_ADMIN")
  listOrganizations(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @CurrentUser() user?: any,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    return this.admin.listOrganizations(t, s, user)
  }

  @Get("orders")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  listOrders(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("search") search?: string,
    @Query("status") status?: string,
    @Query("channel") channel?: string,
    @Query("focus") focus?: string,
    @CurrentUser() user?: any,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    const normalizedSearch = search?.trim()
    if (normalizedSearch && normalizedSearch.length > 200) {
      throw new BadRequestException(
        "Order search must be 200 characters or less",
      )
    }
    if (status && !Object.values(OrderStatus).includes(status as OrderStatus)) {
      throw new BadRequestException("Invalid order status")
    }
    if (
      channel &&
      !Object.values(FulfillmentChannel).includes(channel as FulfillmentChannel)
    ) {
      throw new BadRequestException("Invalid fulfillment channel")
    }
    const allowedFocus = ["all", "attention", "active", "completed"] as const
    if (
      focus &&
      !allowedFocus.includes(focus as (typeof allowedFocus)[number])
    ) {
      throw new BadRequestException("Invalid order focus")
    }
    return this.admin.listOrders({
      take: t,
      skip: s,
      search: normalizedSearch,
      status: status as OrderStatus | undefined,
      channel: channel as FulfillmentChannel | undefined,
      focus: focus as (typeof allowedFocus)[number] | undefined,
      user,
    })
  }

  @Get("orders/:id")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  getOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.getOrder(id, user)
  }

  @Post("orders/:id/manual-verify")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  manualVerify(
    @Param("id") id: string,
    @Body() body: ManualVerifyDto,
    @CurrentUser() user: any,
  ) {
    const method = body.method
    return this.admin.manualVerify(id, method, user.id)
  }

  // ── Verification queue ────────────────────────────────────────────────────
  @Get("verification-queue")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  listVerificationQueue() {
    return this.verificationQueue.listQueue()
  }

  @Post("verification-queue/:id/retry")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  retryVerification(@Param("id") id: string, @CurrentUser() user: any) {
    return this.verificationQueue.retry(id, user.id)
  }

  @Post("verification-queue/:id/mark-verified")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  markVerified(
    @Param("id") id: string,
    @Body() body: MarkVerifiedDto,
    @CurrentUser() user: any,
  ) {
    return this.verificationQueue.markVerified(
      id,
      user.id,
      user.staffRole,
      body.reason,
      body.notes,
    )
  }

  @Post("verification-queue/:id/reject")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  rejectVerification(
    @Param("id") id: string,
    @Body() body: RejectVerificationDto,
    @CurrentUser() user: any,
  ) {
    return this.verificationQueue.reject(
      id,
      user.id,
      user.staffRole,
      body.reason,
    )
  }

  @Post("verification-queue/:id/request-reverify")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  requestReverify(
    @Param("id") id: string,
    @Body() body: RequestReverifyDto,
    @CurrentUser() user: any,
  ) {
    return this.verificationQueue.requestReverify(
      id,
      user.id,
      user.staffRole,
      body.ticketId,
    )
  }

  @Get("disputes")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  listDisputes(
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.dispute.listDisputes({
      status,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    })
  }

  @Post("disputes/:id/review")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  reviewDispute(@Param("id") id: string, @CurrentUser() user: any) {
    return this.dispute.markUnderReview(id, user.id)
  }

  @Post("disputes/:id/resolve")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  resolveDispute(
    @Param("id") id: string,
    @Body() body: ResolveDisputeDto,
    @CurrentUser() user: any,
  ) {
    return this.dispute.resolveDispute(
      id,
      user.id,
      user.staffRole,
      body.resolution,
      body.action,
      body.responsibility,
    )
  }

  @Post("orders/:id/force-cancel")
  @StaffRoles("SUPER_ADMIN")
  forceCancelOrder(
    @Param("id") id: string,
    @Body() body: ForceCancelOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.forceCancel(id, user.id, body)
  }

  @Get("cancellation-requests")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  listCancellationRequests(
    @Query(
      "status",
      new ParseEnumPipe(CancellationRequestStatus, { optional: true }),
    )
    status?: CancellationRequestStatus,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const pagination = parsePagination(take, skip)
    return this.cancellation.listRequests({ status, ...pagination })
  }

  @Post("cancellation-requests/:id/review")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  reviewCancellationRequest(
    @Param("id") id: string,
    @Body() body: ReviewCancellationRequestDto,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.review(id, user.id, body)
  }

  @Post("cancellation-requests/:id/finance-approve")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  financeApproveCancellation(
    @Param("id") id: string,
    @Body() body: FinanceApproveCancellationDto,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.financeApprove(id, user.id, body)
  }

  @Post("orders/:id/decline")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  declinePlatformOrder(
    @Param("id") id: string,
    @Body() body: CancelOrderDto,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.decline(id, staffCancellationActor(user), body)
  }

  @Get("orders/:id/cancellation-preview")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  previewPlatformCancellation(
    @Param("id") id: string,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.preview(id, staffCancellationActor(user))
  }

  @Post("orders/:id/cancellation-requests")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  requestPlatformCancellation(
    @Param("id") id: string,
    @Body() body: CreateCancellationRequestDto,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.createRequest(
      id,
      staffCancellationActor(user),
      body,
    )
  }

  @Post("orders/:orderId/cancellation-requests/:requestId/respond")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  respondToPlatformCancellation(
    @Param("orderId") orderId: string,
    @Param("requestId") requestId: string,
    @Body() body: RespondCancellationRequestDto,
    @CurrentUser() user: any,
  ) {
    return this.cancellation.respond(
      orderId,
      requestId,
      staffCancellationActor(user),
      body,
    )
  }

  // ─── OPERATIONS FULFILLMENT ─────────────────────────

  @Get("orders/platform")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  listPlatformOrders(
    @Query("status") status?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @CurrentUser() user?: any,
  ) {
    const p = parsePagination(take, skip)
    return this.admin.listPlatformOrders(status, p.take, p.skip, user)
  }

  @Post("orders/:id/accept")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  acceptPlatformOrder(@Param("id") id: string, @CurrentUser() user: any) {
    return this.ops.acceptOrder(id, user.id, user.staffRole)
  }

  @Post("orders/:id/submit-content")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  submitPlatformContent(
    @Param("id") id: string,
    @Body() body: SubmitPlatformContentDto,
    @CurrentUser() user: any,
  ) {
    const content = body.content
    return this.ops.submitContent(id, user.id, user.staffRole, content)
  }

  @Post("orders/:id/submit-content-for-review")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  submitPlatformContentForReview(
    @Param("id") id: string,
    @Body() body: SubmitPlatformContentDto,
    @CurrentUser() user: any,
  ) {
    return this.ops.submitContentForReview(
      id,
      user.id,
      user.staffRole,
      body.content,
    )
  }

  @Post("orders/:id/mark-content-ready")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  markPlatformContentReady(@Param("id") id: string, @CurrentUser() user: any) {
    return this.ops.markContentReady(id, user.id, user.staffRole)
  }

  @Post("orders/:id/submit-for-review")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  submitPlatformForReview(@Param("id") id: string, @CurrentUser() user: any) {
    return this.ops.submitForReview(id, user.id, user.staffRole)
  }

  @Post("orders/:id/mark-published")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  markPlatformPublished(
    @Param("id") id: string,
    @Body() body: MarkPlatformPublishedDto,
    @CurrentUser() user: any,
  ) {
    const url = body.url
    return this.ops.markPublished(id, user.id, user.staffRole, url)
  }

  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("settlements")
  listSettlements(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("status") status?: string,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    const statuses = status
      ? status
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : []
    const allowed = new Set(Object.values(SettlementStatus))
    const invalid = statuses.find(
      (value) => !allowed.has(value as SettlementStatus),
    )
    if (invalid) {
      throw new BadRequestException(`Invalid settlement status: ${invalid}`)
    }
    return this.settlements.listSettlements(
      undefined,
      t,
      s,
      statuses as SettlementStatus[],
    )
  }

  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("settlements/:id")
  getSettlement(@Param("id") id: string) {
    return this.settlements.getSettlement(id)
  }

  @Post("settlements/orders/:orderId")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  createSettlement(
    @Param("orderId") orderId: string,
    @CurrentUser() user: any,
  ) {
    // Staff have no organization context — service resolves org from the order
    return this.settlements.createSettlement(orderId, null, user.id)
  }

  @Post("settlements/:id/admin-approve")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  adminApproveSettlement(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.adminApprove(
      id,
      body.reason,
      user.id,
      user.staffRole,
    )
  }

  @Post("settlements/:id/force-approve")
  @StaffRoles("SUPER_ADMIN")
  forceApproveSettlement(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.forceApprove(
      id,
      body.reason,
      user.id,
      user.staffRole,
    )
  }

  @Post("settlements/:id/cancel")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  cancelSettlement(
    @Param("id") id: string,
    @Body() body: SettlementReasonDto,
    @CurrentUser() user: any,
  ) {
    return this.settlements.cancelSettlement(id, user.id, body.reason)
  }

  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Get("withdrawals")
  listWithdrawals(
    @Query("take") take?: string,
    @Query("skip") skip?: string,
    @Query("status") status?: string,
  ) {
    const { take: t, skip: s } = parsePagination(take, skip)
    const statuses = status
      ? status
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : []
    const allowed = new Set(Object.values(WithdrawalStatus))
    const invalid = statuses.find(
      (value) => !allowed.has(value as WithdrawalStatus),
    )
    if (invalid) {
      throw new BadRequestException(`Invalid withdrawal status: ${invalid}`)
    }
    return this.payouts.listWithdrawals(
      undefined,
      t,
      s,
      statuses as WithdrawalStatus[],
    )
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

  // FAILED -> REVERSED: returns trapped funds to the publisher's withdrawable
  // balance after a hard provider failure. Refuses while any execution is
  // COMPLETED/PROCESSING (money may have moved).
  @Post("withdrawals/:id/reverse")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  reverseFailedWithdrawal(
    @Param("id") id: string,
    @Body() body: ReverseWithdrawalDto,
    @CurrentUser() user: any,
  ) {
    const reason = (body?.reason ?? "").trim()
    if (reason.length < 10) {
      throw new BadRequestException(
        "A reason of at least 10 characters is required to reverse a withdrawal",
      )
    }
    return this.payouts.reverseFailedWithdrawal(id, user.id, reason)
  }

  @Post("withdrawals/:id/execute")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  executePayout(
    @Param("id") id: string,
    @Body() body: ExecuteWithdrawalDto,
    @CurrentUser() user: any,
  ) {
    return this.payoutExecution.executeWithdrawal(
      id,
      body.providerName,
      user.id,
    )
  }

  @Get("withdrawals/:id/executions")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  getWithdrawalExecutions(@Param("id") id: string) {
    return this.payoutExecution.getExecutionsForWithdrawal(id)
  }

  @Post("payout-executions/:id/retry")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  retryPayoutExecution(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payoutExecution.retryExecution(id, user.id)
  }

  @Post("payout-executions/:id/cancel")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  cancelPayoutExecution(@Param("id") id: string, @CurrentUser() user: any) {
    return this.payoutExecution.cancelExecution(id, user.id)
  }

  // FIN-06: source IP + User-Agent for the decrypt audit event MUST come
  // from server-resolved request properties, NOT from client-spoofable
  // headers. Previous implementation read `x-forwarded-for` directly from
  // `@Headers("x-forwarded-for")`, which any client can forge — a malicious
  // actor could file a decrypt request and leave an arbitrary IP in the
  // audit log, covering their tracks for finance investigation. The fix:
  // `req.ip` reads the Express-resolved client IP, which under
  // `server.set("trust proxy", 1)` uses the FIRST hop in `X-Forwarded-For`
  // as set by our single trusted reverse proxy (see main.ts:97). An
  // attacker cannot bump `trust proxy` above 1 and cannot influence which
  // hop Express picks. `user-agent` stays informational-only (inherently
  // client-controlled and outside the spoofable-header threat model) but is
  // now read from the same Request object for consistency.
  @Post("payout-methods/:id/decrypt")
  @UseGuards(PermissionsGuard)
  @Permissions("FINANCIAL_DATA_DECRYPT")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  @Header("Cache-Control", "no-store, no-cache, must-revalidate")
  @Header("Pragma", "no-cache")
  decryptPayoutMethod(
    @Param("id") id: string,
    @Body() body: DecryptPayoutMethodDto,
    @CurrentUser() user: any,
    @Req() req: Request,
  ) {
    const ip = req.ip ?? "unknown"
    const userAgent = req.headers["user-agent"] ?? "unknown"
    return this.payouts.decryptPayoutMethod(
      id,
      user.id,
      body.reason,
      ip,
      userAgent,
    )
  }

  // ── Audit log browsing — staff-action forensics is SUPER_ADMIN-only ─────
  // Phase 7.7 A2: requestId filter added. EXACT-MATCH ONLY — never accept
  // contains/startsWith/endsWith operators here. RequestIds are identifiers,
  // not searchable text; substring search would seq-scan the index and
  // encourage operators to guess at IDs.
  @Get("audit-logs")
  @StaffRoles("SUPER_ADMIN")
  listAuditLogs(
    @Query("action") action?: string,
    @Query("entity") entity?: string,
    @Query("entityId") entityId?: string,
    @Query("actorId") actorId?: string,
    @Query("requestId") requestId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.admin.listAuditLogs({
      action,
      entityType: entity,
      entityId,
      userId: actorId,
      requestId,
      startDate,
      endDate,
      page: page ? parseInt(page, 10) || 1 : 1,
      limit: limit ? parseInt(limit, 10) || 50 : 50,
    })
  }

  // ── Platform configuration (FIN-08) ───────────────────────────────────
  // Reading the current singleton is a universal staff read — same shape as
  // `listPublishers` / `listOrders`.
  @Get("settings")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  getPlatformSettings() {
    return this.admin.getPlatformSettings()
  }

  // Fee changes are a money-risk lever — finance-controlled, not operations.
  // Same role gate as `publishers/:id/tier` and the other money-write routes.
  // Reason is required by the DTO and persisted into the audit event.
  @Patch("settings/platform-fee")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  updatePlatformFee(
    @Body() body: UpdatePlatformFeeDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.updatePlatformFee(body.platformFeePct, body.reason, {
      id: user.id,
    })
  }

  // ── Publisher directory ─────────────────────────────────────────────────
  @Get("publishers")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  listPublishers(
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.admin.listPublishers({
      search,
      page: page ? parseInt(page, 10) || 1 : 1,
      limit: limit ? parseInt(limit, 10) || 50 : 50,
    })
  }

  // Tier drives withdrawal hold windows (VERIFIED = no fraud hold) — that is
  // a money-risk lever, so it is finance-controlled, not operations.
  @Patch("publishers/:id/tier")
  @StaffRoles("SUPER_ADMIN", "FINANCE")
  updatePublisherTier(
    @Param("id") id: string,
    @Body() body: UpdatePublisherTierDto,
    @CurrentUser() user: any,
  ) {
    const tier = body.tier
    return this.admin.updatePublisherTier(id, tier, user)
  }

  // ── Support tickets ─────────────────────────────────────────────────────
  // Phase 6.6: every admin support endpoint delegates to SupportService with
  // the staff actor. Channel-aware visibility + the reply matrix (Finance is
  // read-only on PLATFORM tickets but can post internal notes; OPS can only
  // act on tickets assigned to them) are enforced server-side — there is
  // no longer a separate admin code path that bypasses the matrix. The
  // class-level role grant is gone (Phase 6.7) so we declare ALL THREE here;
  // the matrix slices the visible rows + reply gate per actor.
  @Get("support/tickets")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  listSupportTickets(
    @CurrentUser() user: any,
    @Query("status") status?: string,
    @Query("search") search?: string,
    @Query("channel") channel?: string,
    @Query("assignedToUserId") assignedToUserId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const normalizedChannel =
      channel === "PLATFORM" || channel === "PUBLISHER" ? channel : undefined
    return this.support.listTicketsDetailed(staffActor(user), {
      status,
      search,
      channel: normalizedChannel,
      assignedToUserId: assignedToUserId as any,
      page: page ? parseInt(page, 10) || 1 : 1,
      limit: limit ? parseInt(limit, 10) || 50 : 50,
    })
  }

  @Get("support/tickets/:id")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  getSupportTicket(@Param("id") id: string, @CurrentUser() user: any) {
    return this.support.getTicket(id, staffActor(user))
  }

  @Patch("support/tickets/:id/status")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  updateSupportTicketStatus(
    @Param("id") id: string,
    @Body() body: UpdateSupportTicketStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.support.updateStatus(id, body.status, staffActor(user))
  }

  @Post("support/tickets/:id/messages")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  addSupportTicketMessage(
    @Param("id") id: string,
    @Body() body: AddTicketMessageDto,
    @CurrentUser() user: any,
  ) {
    return this.support.addMessage(id, staffActor(user), {
      content: body.content,
      visibility: body.visibility,
    })
  }

  @Get("marketplace/listings")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  listMarketplaceListings(
    @Query("status") status?: string,
    @Query("type") type?: string,
    @Query("search") search?: string,
    @Query("ownerType") ownerType?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @CurrentUser() user?: any,
  ) {
    return this.admin.listMarketplaceListings({
      status,
      type,
      search,
      ownerType,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      user,
    })
  }

  @Get("marketplace/stats")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  getMarketplaceStats() {
    return this.admin.getMarketplaceStats()
  }

  // Staff listing preview — any status (for moderation of pending/draft/etc).
  @Get("marketplace/listings/by-slug/:slug")
  @StaffRoles("SUPER_ADMIN", "OPERATIONS", "FINANCE")
  getListingForStaff(@Param("slug") slug: string, @CurrentUser() user: any) {
    return this.marketplace.getListingForStaff(slug, user)
  }

  // Platform service inventory may be maintained by the assigned Operations
  // owner or Super Admin. MarketplaceService re-checks listing ownership and
  // assignment so this broader route role never grants Operations access to
  // publisher listings or another operator's platform site.
  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Post("marketplace/listings/:id/services")
  addPlatformListingService(
    @Param("id") listingId: string,
    @Body() body: ListingServiceInput,
    @CurrentUser() user: any,
  ) {
    return this.marketplace.addServiceToListing(
      { userId: user.id, isStaff: true, staffRole: user.staffRole },
      listingId,
      body,
    )
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Put("marketplace/listings/:id/services/:serviceId")
  updatePlatformListingService(
    @Param("id") listingId: string,
    @Param("serviceId") serviceId: string,
    @Body() body: UpdateListingServiceInput,
    @CurrentUser() user: any,
  ) {
    return this.marketplace.updateServiceOnListing(
      { userId: user.id, isStaff: true, staffRole: user.staffRole },
      listingId,
      serviceId,
      body,
    )
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Delete("marketplace/listings/:id/services/:serviceId")
  pausePlatformListingService(
    @Param("id") listingId: string,
    @Param("serviceId") serviceId: string,
    @CurrentUser() user: any,
  ) {
    return this.marketplace.pauseServiceOnListing(
      { userId: user.id, isStaff: true, staffRole: user.staffRole },
      listingId,
      serviceId,
    )
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Patch("marketplace/listings/:id/status")
  updateListingStatus(
    @Param("id") id: string,
    @Body() body: UpdateListingStatusDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.updateListingStatus(id, body.status, user, body.force)
  }

  @StaffRoles("SUPER_ADMIN")
  @Patch("marketplace/listings/:id/featured")
  toggleListingFeatured(
    @Param("id") id: string,
    @Body() body: ToggleListingFeaturedDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.toggleListingFeatured(id, body.featured, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Patch("marketplace/listings/:id/verified")
  toggleListingVerified(
    @Param("id") id: string,
    @Body() body: ToggleListingVerifiedDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.toggleListingVerified(id, body.verified, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Delete("marketplace/listings/:id")
  deleteListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.deleteListing(id, user)
  }

  // ─── WEBSITE MANAGEMENT ────────────────────────────

  @StaffRoles("SUPER_ADMIN")
  @Get("websites/import/template")
  downloadWebsiteImportTemplate(@Res() res: Response) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8")
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="publisher-websites-template.csv"',
    )
    res.setHeader("Cache-Control", "no-store")
    res.send(websiteImportTemplateCsv())
  }

  @StaffRoles("SUPER_ADMIN")
  @Post("websites/import/preview")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 2 * 1024 * 1024, files: 1 },
    }),
  )
  previewWebsiteImport(
    @UploadedFile()
    file: {
      originalname?: string
      buffer?: Buffer
      size?: number
      mimetype?: string
    },
    @Body() body: PreviewWebsiteImportDto,
    @CurrentUser() user: any,
  ) {
    return this.websiteImport.preview(file, body.publisherId, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Post("websites/import/:batchId/commit")
  commitWebsiteImport(
    @Param("batchId") batchId: string,
    @Body() body: CommitWebsiteImportDto,
    @CurrentUser() user: any,
  ) {
    return this.websiteImport.commit(batchId, body.idempotencyKey, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Get("websites/import/:batchId")
  getWebsiteImport(
    @Param("batchId") batchId: string,
    @CurrentUser() user: any,
  ) {
    return this.websiteImport.getBatch(batchId, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Get("websites/imports/history")
  listWebsiteImports(@CurrentUser() user: any) {
    return this.websiteImport.listBatches(user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Post("websites/force-verify")
  forceVerifyWebsites(
    @Body() body: ForceVerifyWebsitesDto,
    @CurrentUser() user: any,
  ) {
    return this.websiteVerification.forceVerifyWebsites(body, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Post("websites")
  createWebsite(
    @Body() body: CreatePlatformWebsiteDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.createPlatformWebsite(body, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Put("websites/:id")
  updateWebsite(
    @Param("id") id: string,
    @Body() body: UpdatePlatformWebsiteDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.updatePlatformWebsite(id, body, user)
  }

  // Phase 6.5: site-ownership reassignment + OPS staff picker for the admin
  // UI. Only SUPER_ADMIN can reassign or edit website fields; OPERATIONS may
  // create sites (auto-assigned to themselves) and manage the attached listing
  // services and integrations from the scoped site page.
  @StaffRoles("SUPER_ADMIN")
  @Patch("websites/:id/assign")
  assignWebsite(
    @Param("id") id: string,
    @Body() body: ReassignWebsiteDto,
    @CurrentUser() user: any,
  ) {
    return this.admin.reassignPlatformWebsite(id, body, user)
  }

  // Deliberately lives outside /users/:id. The old /users/ops path was
  // shadowed by that earlier dynamic route, which treated "ops" as a user ID
  // and returned 404 before this handler could run.
  @StaffRoles("SUPER_ADMIN")
  @Get("staff/operations")
  listOpsStaff() {
    return this.admin.listOperationsStaff()
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Get("websites")
  listWebsites(
    @Query("ownershipType") ownershipType?: string,
    @Query() pagination?: any,
    @CurrentUser() user?: any,
  ) {
    const p = parsePagination(pagination?.take, pagination?.skip)
    return this.admin.listWebsites(ownershipType, p.take, p.skip, user)
  }

  @StaffRoles("SUPER_ADMIN", "OPERATIONS")
  @Get("websites/:id")
  getWebsite(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.getWebsite(id, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Patch("websites/:id/pause")
  pauseWebsite(
    @Param("id") id: string,
    @Body() body: PauseWebsiteDto,
    @CurrentUser() user: any,
  ) {
    const paused = body.paused
    return this.admin.pauseWebsite(id, paused, user)
  }

  @StaffRoles("SUPER_ADMIN")
  @Delete("websites/:id")
  deleteWebsite(@Param("id") id: string, @CurrentUser() user: any) {
    return this.admin.deleteWebsite(id, user)
  }
}
