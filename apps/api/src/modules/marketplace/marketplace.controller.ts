import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, ParseEnumPipe } from "@nestjs/common"
import { ServiceType } from "@guestpost/database"
import { MarketplaceService } from "./marketplace.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { Public } from "../../common/decorators/public.decorator"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import {
  SearchListingsDto,
  CreateListingDto,
  UpdateListingDto,
  CreateReviewDto,
  CreateFavoriteDto,
  CreateSavedListDto,
  AddToSavedListDto,
  GetListingFiltersDto,
  GetRecommendationsDto,
  ListingServiceInput,
  UpdateListingServiceInput,
} from "./dto/marketplace.dto"

@Controller("marketplace")
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  // =============================================================================
  // PUBLIC ENDPOINTS
  // =============================================================================

  @Public()
  @Get("listings")
  async searchListings(@Query() query: SearchListingsDto) {
    return this.marketplaceService.searchListings(query)
  }

  @Public()
  @Get("listings/:slug")
  async getListing(@Param("slug") slug: string, @CurrentUser() user?: any) {
    return this.marketplaceService.getListing(slug, user?.id)
  }

  // Lightweight service-menu endpoint for the order-creation flow's service
  // picker — avoids re-fetching the full listing payload when the user has
  // already opened the detail page and just wants the (id, type, price, TAT,
  // availability) tuples to render the selector.
  @Public()
  @Get("listings/:slug/services")
  async getListingServices(@Param("slug") slug: string) {
    return this.marketplaceService.getListingServices(slug)
  }

  @Public()
  @Get("categories")
  async getCategories() {
    return this.marketplaceService.getCategories()
  }

  @Public()
  @Get("tags")
  async getTags() {
    return this.marketplaceService.getTags()
  }

  @Public()
  @Get("services")
  async getServices() {
    return this.marketplaceService.getServices()
  }

  @Public()
  @Get("search")
  async searchPublishers(
    @Query("q") query?: string,
    @Query("category") category?: string,
    @Query("minDR") minDR?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("sortBy") sortBy?: string,
  ) {
    // Phase 7: `type: "PUBLISHER_WEBSITE"` used to filter against the
    // deprecated ListingType enum. The post-Phase-7 contract is that ANY
    // APPROVED listing with ≥1 AVAILABLE service is a marketplace
    // placement; the search default returns all such listings.
    return this.marketplaceService.searchListings({
      query,
      category,
      minDR: minDR ? parseInt(minDR, 10) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      sortBy: sortBy as any,
    })
  }

  @Public()
  @Get("stats")
  async getStats() {
    return this.marketplaceService.getMarketplaceStats()
  }

  @Get("recommendations")
  async getRecommendations(@Query() query: GetRecommendationsDto, @CurrentUser() user: any) {
    return this.marketplaceService.getRecommendations(user.id, query)
  }

  // =============================================================================
  // PROTECTED ENDPOINTS - USER SPECIFIC
  // =============================================================================

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Get("favorites")
  async getFavorites(@CurrentUser() user: any) {
    return this.marketplaceService.getFavorites(user.id)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Post("favorites")
  async addFavorite(@Body() body: CreateFavoriteDto, @CurrentUser() user: any) {
    // Phase 7.12 (#17): thread body.serviceType through to the service.
    // When undefined, the service defaults to null (whole-listing favorite,
    // legacy behavior). When set, creates a service-scoped WAITLIST
    // notify-me favorite.
    return this.marketplaceService.addFavorite(user.id, body.listingId, body.serviceType ?? null)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Delete("favorites/:listingId")
  async removeFavorite(@Param("listingId") listingId: string, @CurrentUser() user: any) {
    await this.marketplaceService.removeFavorite(user.id, listingId)
    return { success: true }
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Delete("favorites/:listingId/services/:serviceType")
  async removeFavoriteService(
    @Param("listingId") listingId: string,
    // Phase 7.12 (#17 sibling): URL params are NOT covered by class-validator
    // DTOs, only @Body() is. ParseEnumPipe rejects an invalid enum value
    // with a clean 400 before the handler runs — without it, a malformed
    // serviceType like `FAKETYPE` would reach Prisma and fail at the SQL
    // layer with an uglier error.
    @Param("serviceType", new ParseEnumPipe(ServiceType)) serviceType: ServiceType,
    @CurrentUser() user: any,
  ) {
    await this.marketplaceService.removeFavoriteService(user.id, listingId, serviceType)
    return { success: true }
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Get("saved-lists")
  async getSavedLists(@CurrentUser() user: any) {
    return this.marketplaceService.getSavedLists(user.id)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Post("saved-lists")
  async createSavedList(@Body() body: CreateSavedListDto, @CurrentUser() user: any) {
    return this.marketplaceService.createSavedList(user.id, body)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Post("saved-lists/:listId/items")
  async addToSavedList(
    @Param("listId") listId: string, 
    @Body() body: AddToSavedListDto,
    @CurrentUser() user: any
  ) {
    return this.marketplaceService.addToSavedList(user.id, listId, body)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Delete("saved-lists/:listId/items/:listingId")
  async removeFromSavedList(
    @Param("listId") listId: string, 
    @Param("listingId") listingId: string,
    @CurrentUser() user: any
  ) {
    await this.marketplaceService.removeFromSavedList(user.id, listId, listingId)
    return { success: true }
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  @Post("reviews")
  async createReview(@Body() body: CreateReviewDto, @CurrentUser() user: any) {
    return this.marketplaceService.createReview(user.id, body)
  }

  @Get("publisher/:publisherId/listings")
  async getPublisherListings(
    @Param("publisherId") publisherId: string, 
    @CurrentUser() user?: any
  ) {
    return this.marketplaceService.getPublisherListings(publisherId, user?.id)
  }

  // =============================================================================
  // PROTECTED ENDPOINTS - ORGANIZATION/PUBLISHER MANAGEMENT
  // =============================================================================

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Post("listings")
  async createListing(@Body() body: CreateListingDto, @CurrentUser() user: any) {
    return this.marketplaceService.createListing(user.id, user.publisherId, body)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Put("listings/:id")
  async updateListing(
    @Param("id") id: string, 
    @Body() body: UpdateListingDto,
    @CurrentUser() user: any
  ) {
    return this.marketplaceService.updateListing(user.id, user.publisherId, id, body)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Delete("listings/:id")
  async deleteListing(@Param("id") id: string, @CurrentUser() user: any) {
    await this.marketplaceService.deleteListing(user.id, user.publisherId, id)
    return { success: true }
  }

  // ── Phase 6 lifecycle transitions (publisher-side) ────────────────────
  // Each maps 1:1 to a service-method. Status edits are publisher-membership
  // gated; admin uses /admin/marketplace/listings/:id/status for its own
  // approve/reject path.

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Post("listings/:id/submit")
  async submitListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.marketplaceService.submitListingForReview(user.id, user.publisherId, id)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Post("listings/:id/pause")
  async pauseListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.marketplaceService.pauseListing(user.id, user.publisherId, id)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Post("listings/:id/unpause")
  async unpauseListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.marketplaceService.unpauseListing(user.id, user.publisherId, id)
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Post("listings/:id/archive")
  async archiveListing(@Param("id") id: string, @CurrentUser() user: any) {
    return this.marketplaceService.archiveListing(user.id, user.publisherId, id)
  }

  // ── Per-service endpoints (publisher path) ──────────────────────────────
  // Listing's services are now first-class rows; these endpoints let the
  // publisher dashboard add, edit, and pause individual services without
  // touching the listing-level record. Platform listings use the admin
  // mirrors of these endpoints (admin.controller.ts).

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Post("listings/:id/services")
  async addService(
    @Param("id") listingId: string,
    @Body() body: ListingServiceInput,
    @CurrentUser() user: any,
  ) {
    return this.marketplaceService.addServiceToListing(
      { userId: user.id, activePublisherId: user.publisherId },
      listingId,
      body,
    )
  }

  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Put("listings/:id/services/:serviceId")
  async updateService(
    @Param("id") listingId: string,
    @Param("serviceId") serviceId: string,
    @Body() body: UpdateListingServiceInput,
    @CurrentUser() user: any,
  ) {
    return this.marketplaceService.updateServiceOnListing(
      { userId: user.id, activePublisherId: user.publisherId },
      listingId,
      serviceId,
      body,
    )
  }

  // Soft-disable. Hard delete is never offered to publishers — historical
  // orders' listingServiceId would orphan and break order detail rendering.
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("PUBLISHER")
  @MemberRoles("PUBLISHER_OWNER")
  @Delete("listings/:id/services/:serviceId")
  async pauseService(
    @Param("id") listingId: string,
    @Param("serviceId") serviceId: string,
    @CurrentUser() user: any,
  ) {
    return this.marketplaceService.pauseServiceOnListing(
      { userId: user.id, activePublisherId: user.publisherId },
      listingId,
      serviceId,
    )
  }
}