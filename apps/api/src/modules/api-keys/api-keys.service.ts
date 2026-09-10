import * as crypto from "node:crypto"
import { withOrganizationOwnerRlsContext } from "@guestpost/database"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import type { DurableCurrentAuthority } from "../auth/current-authority.service"

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex")
}

const DEFAULT_API_KEY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000
const MAX_API_KEY_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

function generateApiKey(): { raw: string; hash: string } {
  const raw = `gp_${crypto.randomBytes(32).toString("hex")}`
  return { raw, hash: hashKey(raw) }
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private organizationOwnerContext(authority: DurableCurrentAuthority) {
    if (
      authority.userType !== "CUSTOMER" ||
      authority.customerRole !== "OWNER" ||
      !authority.organizationId
    ) {
      throw new ForbiddenException(
        "Only an active organization owner can manage API keys",
      )
    }

    return {
      actorId: authority.id,
      organizationId: authority.organizationId,
      actorKind: "CUSTOMER" as const,
      organizationRole: "OWNER" as const,
    }
  }

  async createKey(
    authority: DurableCurrentAuthority,
    name: string,
    permissions: string[],
    requestedExpiresAt?: string,
  ) {
    const context = this.organizationOwnerContext(authority)
    const { raw, hash } = generateApiKey()
    const now = new Date()
    const expiresAt = requestedExpiresAt
      ? new Date(requestedExpiresAt)
      : new Date(now.getTime() + DEFAULT_API_KEY_LIFETIME_MS)
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= now ||
      expiresAt.getTime() - now.getTime() > MAX_API_KEY_LIFETIME_MS
    ) {
      throw new BadRequestException(
        "API key expiry must be in the future and no more than 365 days away",
      )
    }

    const created = await withOrganizationOwnerRlsContext(
      this.prisma,
      context,
      async (tx) => {
        const key = await tx.apiKey.create({
          data: {
            organizationId: context.organizationId,
            createdByUserId: context.actorId,
            name,
            keyHash: hash,
            permissions,
            expiresAt,
          },
          select: {
            id: true,
            name: true,
            permissions: true,
            expiresAt: true,
            createdAt: true,
          },
        })

        await this.audit.log(
          {
            action: "API_KEY_CREATED",
            entityType: "ApiKey",
            metadata: { name, permissions, expiresAt: expiresAt.toISOString() },
            userId: context.actorId,
            organizationId: context.organizationId,
          },
          tx,
        )
        return key
      },
    )

    return {
      ...created,
      key: raw,
      message: "Store this key securely — it will not be shown again",
    }
  }

  async listKeys(authority: DurableCurrentAuthority) {
    const context = this.organizationOwnerContext(authority)
    return withOrganizationOwnerRlsContext(this.prisma, context, async (tx) =>
      tx.apiKey.findMany({
        where: { organizationId: context.organizationId },
        select: {
          id: true,
          name: true,
          permissions: true,
          lastUsedAt: true,
          expiresAt: true,
          createdAt: true,
          keyHash: false,
        },
        orderBy: { createdAt: "desc" },
      }),
    )
  }

  async revokeKey(id: string, authority: DurableCurrentAuthority) {
    const context = this.organizationOwnerContext(authority)

    return withOrganizationOwnerRlsContext(this.prisma, context, async (tx) => {
      const key = await tx.apiKey.findFirst({
        where: { id, organizationId: context.organizationId },
      })
      if (!key) throw new NotFoundException("API key not found")

      await tx.apiKey.delete({ where: { id } })

      await this.audit.log(
        {
          action: "API_KEY_REVOKED",
          entityType: "ApiKey",
          entityId: id,
          metadata: { name: key.name },
          userId: context.actorId,
          organizationId: context.organizationId,
        },
        tx,
      )

      return { message: "API key revoked" }
    })
  }
}
