import * as crypto from "node:crypto"
import {
  withApiKeyValidationRlsContext,
  withOrganizationOwnerRlsContext,
} from "@guestpost/database"
import {
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
  ) {
    const context = this.organizationOwnerContext(authority)
    const { raw, hash } = generateApiKey()

    await withOrganizationOwnerRlsContext(this.prisma, context, async (tx) => {
      await tx.apiKey.create({
        data: {
          organizationId: context.organizationId,
          name,
          keyHash: hash,
          permissions,
        },
      })

      await this.audit.log(
        {
          action: "API_KEY_CREATED",
          entityType: "ApiKey",
          metadata: { name, permissions },
          userId: context.actorId,
          organizationId: context.organizationId,
        },
        tx,
      )
    })

    return {
      name,
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

  async validateKey(rawKey: string): Promise<{
    valid: boolean
    permissions?: string[]
    organizationId?: string
  }> {
    const hash = hashKey(rawKey)
    return withApiKeyValidationRlsContext(
      this.prisma,
      { keyHash: hash },
      async (tx) => {
        const key = await tx.apiKey.findUnique({
          where: { keyHash: hash },
        })
        if (!key) return { valid: false }
        if (key.expiresAt && key.expiresAt < new Date()) {
          return { valid: false }
        }

        await tx.apiKey.update({
          where: { id: key.id },
          data: { lastUsedAt: new Date() },
        })

        return {
          valid: true,
          permissions: key.permissions as string[],
          organizationId: key.organizationId,
        }
      },
    )
  }
}
