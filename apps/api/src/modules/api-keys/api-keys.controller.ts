import { Controller, Get, Post, Delete, Param, Body, UseGuards } from "@nestjs/common"
import { ApiKeysService } from "./api-keys.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"

@Controller("api-keys")
@UseGuards(MemberRolesGuard)
@MemberRoles("OWNER")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  create(
    @Body() body: { name: string; permissions?: string[] },
    @CurrentUser() user: any,
  ) {
    return this.apiKeys.createKey(user.organizationId, body.name, body.permissions ?? ["orders:read"], user.id)
  }

  @Get()
  list(@CurrentUser() user: any) {
    return this.apiKeys.listKeys(user.organizationId)
  }

  @Delete(":id")
  revoke(@Param("id") id: string, @CurrentUser() user: any) {
    return this.apiKeys.revokeKey(id, user.organizationId, user.id)
  }
}
