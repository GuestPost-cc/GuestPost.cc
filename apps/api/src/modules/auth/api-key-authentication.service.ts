import { createHash } from "node:crypto"
import {
  setRlsRequestContext,
  withApiKeyValidationRlsContext,
} from "@guestpost/database"
import { Injectable, UnauthorizedException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { CurrentAuthorityService } from "./current-authority.service"

const API_KEY_PATTERN = /^gp_[a-f0-9]{64}$/

export interface ApiKeyPrincipal {
  keyId: string
  permissions: readonly string[]
  authority: Awaited<ReturnType<CurrentAuthorityService["resolveApiKeyOwner"]>>
}

@Injectable()
export class ApiKeyAuthenticationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async authenticate(rawKey: unknown): Promise<ApiKeyPrincipal> {
    if (typeof rawKey !== "string" || !API_KEY_PATTERN.test(rawKey)) {
      throw new UnauthorizedException("Invalid API key")
    }
    const keyHash = createHash("sha256").update(rawKey).digest("hex")
    const key = await withApiKeyValidationRlsContext(
      this.prisma,
      { keyHash },
      async (tx) => {
        const found = await tx.apiKey.findUnique({
          where: { keyHash },
          select: {
            id: true,
            organizationId: true,
            createdByUserId: true,
            permissions: true,
            expiresAt: true,
          },
        })
        if (!found?.createdByUserId) return null
        if (found.expiresAt && found.expiresAt <= new Date()) return null
        await tx.apiKey.update({
          where: { id: found.id },
          data: { lastUsedAt: new Date() },
        })
        return { ...found, createdByUserId: found.createdByUserId }
      },
    )
    if (!key) throw new UnauthorizedException("Invalid API key")

    setRlsRequestContext({
      workload: "AUTH_BOOTSTRAP",
      actorId: key.createdByUserId,
      actorKind: "CUSTOMER",
    })
    const authority = await this.authorities.resolveApiKeyOwner(
      key.createdByUserId,
      key.organizationId,
    )
    return {
      keyId: key.id,
      permissions: Object.freeze(
        Array.isArray(key.permissions)
          ? key.permissions.filter(
              (permission): permission is string =>
                typeof permission === "string",
            )
          : [],
      ),
      authority,
    }
  }
}
