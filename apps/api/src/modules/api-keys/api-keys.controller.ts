import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common"
import { CurrentAuthority } from "../../common/decorators/current-authority.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import type { DurableCurrentAuthority } from "../auth/current-authority.service"
import { ApiKeysService } from "./api-keys.service"
import { CreateApiKeyDto } from "./dto/create-api-key.dto"

@Controller("api-keys")
@UseGuards(MemberRolesGuard)
@MemberRoles("OWNER")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  create(
    @Body() body: CreateApiKeyDto,
    @CurrentAuthority() authority: DurableCurrentAuthority,
  ) {
    const permissions = body.permissions?.length
      ? body.permissions
      : ["orders:read"]
    return this.apiKeys.createKey(
      authority,
      body.name,
      permissions,
      body.expiresAt,
    )
  }

  @Get()
  list(@CurrentAuthority() authority: DurableCurrentAuthority) {
    return this.apiKeys.listKeys(authority)
  }

  @Delete(":id")
  revoke(
    @Param("id") id: string,
    @CurrentAuthority() authority: DurableCurrentAuthority,
  ) {
    return this.apiKeys.revokeKey(id, authority)
  }
}
