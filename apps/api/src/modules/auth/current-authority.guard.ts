import { setRlsRequestContext } from "@guestpost/database"
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { API_KEY_PERMISSIONS_KEY } from "../../common/decorators/api-key-permissions.decorator"
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator"
import { CurrentAuthorityService } from "./current-authority.service"
import { requiresEmailVerification } from "./email-verification-policy"

@Injectable()
export class CurrentAuthorityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest()
    // AuthGuard is registered immediately before this guard and binds this ID
    // to the verified session. Requiring it here prevents accidental use of
    // the durable resolver as an authentication mechanism.
    if (!request.authenticatedUserId) {
      throw new ForbiddenException("Authenticated session authority required")
    }
    const authority = await this.authorities.resolveRequest(request)

    if (request.apiKey) {
      const required = this.reflector.getAllAndOverride<readonly string[]>(
        API_KEY_PERMISSIONS_KEY,
        [context.getHandler(), context.getClass()],
      )
      if (!required?.length) {
        throw new ForbiddenException("API key is not allowed on this route")
      }
      const granted = new Set(request.apiKey.permissions)
      if (required.some((permission) => !granted.has(permission))) {
        throw new ForbiddenException("API key permission denied")
      }
    }

    if (authority.userType === "CUSTOMER") {
      setRlsRequestContext({
        workload: "API",
        actorId: authority.id,
        actorKind: "CUSTOMER",
        organizationId: authority.organizationId,
        organizationRole: authority.customerRole,
      })
    } else if (authority.userType === "PUBLISHER") {
      setRlsRequestContext({
        workload: "API",
        actorId: authority.id,
        actorKind: "PUBLISHER",
        publisherId: authority.publisherId,
        publisherRole: authority.publisherRole,
      })
    } else {
      setRlsRequestContext({
        workload: "API",
        actorId: authority.id,
        actorKind: "STAFF",
        staffRole: authority.staffRole,
        staffPermissions: authority.staffPermissions,
      })
    }

    if (!authority.emailVerified && requiresEmailVerification(request)) {
      throw new ForbiddenException("EMAIL_NOT_VERIFIED")
    }

    // Keep the cached object for non-authoritative presentation fields, but
    // overwrite every field that can grant tenant, actor, role or permission
    // access. Explicit nulls remove stale grants after deletion/demotion.
    request.user = {
      ...request.user,
      ...authority,
      staffPermissions: [...authority.staffPermissions],
    }
    request.currentAuthority = authority
    return true
  }
}
