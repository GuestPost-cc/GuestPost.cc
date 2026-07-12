import {
  connectCallbackRequestSchema,
  connectRequestSchema,
  IntegrationError,
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
    @Res() res: Response,
  ) {
    const parsed = connectCallbackRequestSchema.safeParse(query)
    if (!parsed.success) {
      throw new IntegrationError("INVALID_REQUEST", "Invalid callback params", {
        issues: parsed.error.issues,
      })
    }
    const { code, state, error } = parsed.data

    // Redirect errors back to the publisher integrations page
    if (error) {
      return res.redirect(
        `/dashboard/integrations?error=${encodeURIComponent(error)}`,
      )
    }

    try {
      const result = await this.service.handleCallback(provider, code!, state!)
      // Redirect to the publisher app — discovery runs in the background
      return res.redirect(
        `${result.returnUrl}?connected=${result.externalAccountId}`,
      )
    } catch (err: any) {
      const msg = encodeURIComponent(err?.message ?? "OAuth callback failed")
      return res.redirect(`/dashboard/integrations?error=${msg}`)
    }
  }

  @Get()
  async listIntegrations(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
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

  @Post("connections/:externalAccountId/rediscover")
  @HttpCode(HttpStatus.ACCEPTED)
  async rediscover(
    @Param("externalAccountId") externalAccountId: string,
    @Req() req: Request,
  ) {
    return this.service.rediscover(
      this.ownerResolver.resolve(req),
      externalAccountId,
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
    const { trigger, websiteIntegrationId, startDate, endDate } = parsed.data
    return this.service.triggerSync(
      this.ownerResolver.resolve(req),
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
