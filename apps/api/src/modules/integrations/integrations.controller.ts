import { IntegrationError } from "@guestpost/integrations"
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
import type {
  ConnectCallbackRequest,
  ConnectRequest,
  DisconnectRequest,
  LinkPropertyRequest,
  TriggerSyncRequest,
} from "./dto/integrations.dto"
import {
  ConnectCallbackRequestSchema,
  ConnectRequestSchema,
  DisconnectRequestSchema,
  LinkPropertyRequestSchema,
  TriggerSyncRequestSchema,
} from "./dto/integrations.dto"
import { IntegrationsService } from "./integrations.service"

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Post(":provider/connect")
  async initiateConnect(
    @Param("provider") provider: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = ConnectRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const data = parsed.data as ConnectRequest
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId) {
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    }
    return this.service.initiateConnect(publisherId, provider, data.returnUrl)
  }

  @Public()
  @Get(":provider/callback")
  async handleCallback(
    @Param("provider") provider: string,
    @Query() query: unknown,
  ) {
    const parsed = ConnectCallbackRequestSchema.safeParse(query)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid callback params")
    }
    const data = parsed.data as ConnectCallbackRequest
    if (data.error) {
      throw new IntegrationError("OAUTH_ERROR", data.error)
    }
    return this.service.handleCallback(provider, data.code, data.state)
  }

  @Get()
  async listIntegrations(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("status") status?: string,
    @Query("provider") provider?: string,
    @Req() req?: Request,
  ) {
    const publisherId =
      (req as any)?.user?.publisherId ?? (req as any)?.user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    return this.service.listIntegrations(
      publisherId,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    )
  }

  @Get("available")
  async discoverAvailableProperties(
    @Query("integrationId") integrationId: string,
    @Req() req: Request,
  ) {
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    return this.service.discoverAvailableProperties(publisherId, integrationId)
  }

  @Get(":integrationId")
  async getIntegration(
    @Param("integrationId") integrationId: string,
    @Req() req: Request,
  ) {
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    return this.service.getIntegration(publisherId, integrationId)
  }

  @Post(":integrationId/link")
  async linkProperty(
    @Param("integrationId") integrationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = LinkPropertyRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const data = parsed.data as LinkPropertyRequest
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    return this.service.linkProperty(
      publisherId,
      integrationId,
      data.websiteId,
      data.propertyUrl,
    )
  }

  @Post(":integrationId/sync")
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerSync(
    @Param("integrationId") integrationId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const parsed = TriggerSyncRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const data = parsed.data as TriggerSyncRequest
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    return this.service.triggerSync(publisherId, integrationId, data)
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
    const publisherId =
      (req as any)?.user?.publisherId ?? (req as any)?.user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    return this.service.getSyncHistory(publisherId, integrationId, {
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      filters: { status, trigger, dateFrom, dateTo },
    })
  }

  @Get("sync/:syncId")
  async getSyncStatus(@Param("syncId") syncId: string) {
    return this.service.getSyncStatus(syncId)
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(@Body() body: unknown, @Req() req: Request) {
    const parsed = DisconnectRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body")
    }
    const data = parsed.data as DisconnectRequest
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId)
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    await this.service.disconnect(publisherId, data.integrationId)
  }
}
