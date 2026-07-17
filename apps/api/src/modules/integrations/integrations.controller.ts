import {
  connectCallbackRequestSchema,
  connectRequestSchema,
  IntegrationError,
  linkPropertyRequestSchema,
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
  Res,
} from "@nestjs/common"
import { Request, Response } from "express"
import { Public } from "../../common/decorators/public.decorator"
import { IntegrationsApiService } from "./integrations.service"
import { OwnerResolver } from "./owner-resolver.service"

@Controller("integrations")
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsApiService,
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
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body", {
        issues: parsed.error.issues,
      })
    }
    const { returnUrl, platformWebsiteId } = parsed.data
    return this.service.initiateConnect(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      provider,
      returnUrl ?? "/dashboard",
    )
  }

  @Public()
  @Get(":provider/callback")
  async handleCallback(
    @Param("provider") provider: string,
    @Query() query: unknown,
    @Res() res: Response,
  ) {
    const parsed = connectCallbackRequestSchema.safeParse(query)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid callback params", {
        issues: parsed.error.issues,
      })
    }
    const { code, state, error } = parsed.data

    if (error) {
      const result = await this.service.handleCallbackError(
        provider,
        state!,
        error,
      )
      return res.redirect(result.redirectUrl)
    }

    const result = await this.service.handleCallback(provider, code!, state!)
    return res.redirect(result.redirectUrl)
  }

  @Get()
  async listIntegrations(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("platformWebsiteId") platformWebsiteId?: string,
    @Req() req?: Request,
  ) {
    return this.service.listIntegrations(
      await this.ownerResolver.resolve(req!, platformWebsiteId),
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    )
  }

  @Get(":integrationId")
  async getIntegration(
    @Param("integrationId") integrationId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.getIntegration(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      integrationId,
    )
  }

  @Post("connections/:externalAccountId/rediscover")
  @HttpCode(HttpStatus.ACCEPTED)
  async rediscover(
    @Param("externalAccountId") externalAccountId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.rediscover(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      externalAccountId,
    )
  }

  @Post(":integrationId/discover")
  @HttpCode(HttpStatus.ACCEPTED)
  async discover(
    @Param("integrationId") integrationId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.discover(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      integrationId,
    )
  }

  @Get(":integrationId/resources")
  async listResources(
    @Param("integrationId") integrationId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.listResources(
      await this.ownerResolver.resolve(req, platformWebsiteId),
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
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body", {
        issues: parsed.error.issues,
      })
    }
    return this.service.linkProperty(
      await this.ownerResolver.resolve(req, parsed.data.websiteId),
      integrationId,
      parsed.data.websiteId!,
      parsed.data.externalResourceId!,
    )
  }

  @Delete(":integrationId/link/:websiteIntegrationId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkProperty(
    @Param("integrationId") integrationId: string,
    @Param("websiteIntegrationId") websiteIntegrationId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    await this.service.unlinkProperty(
      await this.ownerResolver.resolve(req, platformWebsiteId),
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
      throw new IntegrationError("INVALID_REQUEST", "Invalid request body", {
        issues: parsed.error.issues,
      })
    }
    const {
      trigger,
      websiteIntegrationId,
      startDate,
      endDate,
      platformWebsiteId,
    } = parsed.data
    return this.service.triggerSync(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      integrationId,
      {
        trigger: trigger!,
        websiteIntegrationId,
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
    @Query("platformWebsiteId") platformWebsiteId?: string,
    @Req() req?: Request,
  ) {
    return this.service.getSyncHistory(
      await this.ownerResolver.resolve(req!, platformWebsiteId),
      integrationId,
      {
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
        filters: { status, trigger, dateFrom, dateTo },
      },
    )
  }

  @Get("syncs/:syncId")
  async getSyncStatus(
    @Param("syncId") syncId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.getSyncStatus(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      syncId,
    )
  }

  @Delete(":integrationId")
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(
    @Param("integrationId") integrationId: string,
    @Query("platformWebsiteId") platformWebsiteId: string | undefined,
    @Req() req: Request,
  ) {
    await this.service.disconnect(
      await this.ownerResolver.resolve(req, platformWebsiteId),
      integrationId,
    )
  }
}
