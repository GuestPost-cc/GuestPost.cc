import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from "@nestjs/common"
import type { DurableCurrentAuthority as CurrentAuthorityValue } from "../../modules/auth/current-authority.service"

export const CurrentAuthority = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentAuthorityValue => {
    const request = ctx.switchToHttp().getRequest()
    if (!request.currentAuthority) {
      throw new UnauthorizedException("Current authority was not resolved")
    }
    return request.currentAuthority
  },
)
