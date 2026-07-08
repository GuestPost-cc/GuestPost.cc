import {
  connectCallbackRequestSchema,
  connectRequestSchema,
  IntegrationError,
  linkPropertyRequestSchema,
  triggerDiscoveryRequestSchema,
  triggerSyncRequestSchema,
} from "@guestpost/integrations"
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common"
import { Request } from "express"
import { Public } from "../../common/decorators/public.decorator"
import { IntegrationsService } from "./integrations.service"
import { OwnerResolver } from "./owner-resolver.service"

@Controller("integrations")
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsService,
    private readonly ownerResolver: OwnerResolver,
  ) {}

  @Post(":provider/connect")
  async initiateConnect(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = connectRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const { returnUrl } = parsed.data
    return this.service.initiateConnect(
      this.ownerResolver.resolve(req),
      provider,
      returnUrl ?? "/dashboard",
    )
  }

  @Public()
  @Get(":provider/callback")
  async handleCallback(
    @Param("provider") provider: string,
    @Query() query: unknown,
  ) {
    const parsed = connectCallbackRequestSchema.safeParse(query)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid callback params")
    }
    const { code, state, error } = parsed.data
    if (error) {
      throw new IntegrationError("OAUTH_ERROR", error)
    }
    return this.service.handleCallback(provider, code!, state!)
  }

  @Get()
  async listIntegrations(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("status") status?: string,
    @Query("provider") provider?: string,
    @Req() req?: Request,
  ) {
    return this.service.listIntegrations(
      this.ownerResolver.resolve(req!),
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    )
  }

  @Get(":integrationId")
  async getIntegration(
    @Param("integrationId") integrationId: string,
    @Req() req: Request,
  ) {
    return this.service.getIntegration(
      this.ownerResolver.resolve(req),
      integrationId,
    )
  }

  @Post(":integrationId/discover")
  async triggerDiscovery(
    @Param("integrationId") integrationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = triggerDiscoveryRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    return this.service.enqueueDiscovery(
      this.ownerResolver.resolve(req),
      integrationId,
    )
  }

  @Get(":integrationId/resources")
  async getCachedResources(
    @Param("integrationId") integrationId: string,
    @Req() req: Request,
  ) {
    return this.service.getCachedResources(
      this.ownerResolver.resolve(req),
      integrationId,
    )
  }

  @Post(":integrationId/link")
  async linkProperty(
    @Param("integrationId") integrationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = linkPropertyRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const { externalId, websiteId } = parsed.data
    return this.service.linkProperty(
      this.ownerResolver.resolve(req),
      integrationId,
      websiteId!,
      externalId!,
    )
  }

  @Delete(":integrationId/link/:websiteIntegrationId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkProperty(
    @Param("integrationId") integrationId: string,
    @Param("websiteIntegrationId") websiteIntegrationId: string,
    @Req() req: Request,
  ) {
    await this.service.unlinkProperty(
      this.ownerResolver.resolve(req),
      integrationId,
      websiteIntegrationId,
    )
  }

  @Post(":integrationId/sync")
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerSync(
    @Param("integrationId") integrationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = triggerSyncRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const { trigger, propertyUrl, startDate, endDate } = parsed.data
    return this.service.triggerSync(
      this.ownerResolver.resolve(req),
      integrationId,
      {
        trigger: trigger!,
        propertyUrl,
        startDate,
        endDate,
      },
    )
  }

  @Get(":integrationId/sync/history")
  async getSyncHistory(
    @Param("integrationId") integrationId: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("status") status?: string,
    @Query("trigger") trigger?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Req() req?: Request,
  ) {
    return this.service.getSyncHistory(
      this.ownerResolver.resolve(req!),
      integrationId,
      {
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
        filters: { status, trigger, dateFrom, dateTo },
      },
    )
  }

  @Get("syncs/:syncId")
  async getSyncStatus(@Param("syncId") syncId: string) {
    return this.service.getSyncStatus(syncId)
  }

  @Delete(":integrationId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @Param("integrationId") integrationId: string,
    @Req() req: Request,
  ) {
    await this.service.disconnect(
      this.ownerResolver.resolve(req),
      integrationId,
    )
  }
}
