import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards } from "@nestjs/common"
import { MarketplaceService } from "./marketplace.service"
import { Public } from "../auth/public.decorator"
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
  async getListing(@Param("slug") slug: string, @Query("userId") userId?: string) {
    return this.marketplaceService.getListing(slug, userId)
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
  @Get("stats")
  async getStats() {
    return this.marketplaceService.getMarketplaceStats()
  }

  @Get("recommendations")
  async getRecommendations(@Query() query: GetRecommendationsDto, @Query("userId") userId: string) {
    return this.marketplaceService.getRecommendations(userId, query)
  }

  // =============================================================================
  // PROTECTED ENDPOINTS - USER SPECIFIC
  // =============================================================================

  @Get("favorites")
  async getFavorites(@Query("userId") userId: string) {
    return this.marketplaceService.getFavorites(userId)
  }

  @Post("favorites")
  async addFavorite(@Body() body: CreateFavoriteDto & { userId: string }) {
    return this.marketplaceService.addFavorite(body.userId, body.listingId)
  }

  @Delete("favorites/:listingId")
  async removeFavorite(@Param("listingId") listingId: string, @Query("userId") userId: string) {
    await this.marketplaceService.removeFavorite(userId, listingId)
    return { success: true }
  }

  @Get("saved-lists")
  async getSavedLists(@Query("userId") userId: string) {
    return this.marketplaceService.getSavedLists(userId)
  }

  @Post("saved-lists")
  async createSavedList(@Body() body: CreateSavedListDto & { userId: string }) {
    return this.marketplaceService.createSavedList(body.userId, body)
  }

  @Post("saved-lists/:listId/items")
  async addToSavedList(
    @Param("listId") listId: string, 
    @Body() body: AddToSavedListDto & { userId: string }
  ) {
    return this.marketplaceService.addToSavedList(body.userId, listId, body)
  }

  @Delete("saved-lists/:listId/items/:listingId")
  async removeFromSavedList(
    @Param("listId") listId: string, 
    @Param("listingId") listingId: string,
    @Query("userId") userId: string
  ) {
    await this.marketplaceService.removeFromSavedList(userId, listId, listingId)
    return { success: true }
  }

  @Post("reviews")
  async createReview(@Body() body: CreateReviewDto & { userId: string }) {
    return this.marketplaceService.createReview(body.userId, body)
  }

  @Get("publisher/:publisherId/listings")
  async getPublisherListings(
    @Param("publisherId") publisherId: string, 
    @Query("userId") userId?: string
  ) {
    return this.marketplaceService.getPublisherListings(publisherId, userId)
  }

  // =============================================================================
  // PROTECTED ENDPOINTS - ORGANIZATION/PUBLISHER MANAGEMENT
  // =============================================================================

  @Post("listings")
  async createListing(@Body() body: CreateListingDto & { userId: string; organizationId: string }) {
    return this.marketplaceService.createListing(body.userId, body.organizationId, body)
  }

  @Put("listings/:id")
  async updateListing(
    @Param("id") id: string, 
    @Body() body: UpdateListingDto & { userId: string; organizationId: string }
  ) {
    return this.marketplaceService.updateListing(body.userId, body.organizationId, id, body)
  }

  @Delete("listings/:id")
  async deleteListing(@Param("id") id: string, @Body() body: { userId: string; organizationId: string }) {
    await this.marketplaceService.deleteListing(body.userId, body.organizationId, id)
    return { success: true }
  }
}