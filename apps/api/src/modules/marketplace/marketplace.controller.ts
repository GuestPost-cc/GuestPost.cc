import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from "@nestjs/common"
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
  GetRecommendationsDto
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
    return this.marketplaceService.searchListings({
      query,
      category,
      minDR: minDR ? parseInt(minDR, 10) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      sortBy: sortBy as any,
      type: "PUBLISHER_WEBSITE",
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
    return this.marketplaceService.addFavorite(user.id, body.listingId)
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
}