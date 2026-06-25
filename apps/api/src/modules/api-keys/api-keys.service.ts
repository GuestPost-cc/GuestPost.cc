import * as crypto from "node:crypto"
import { Injectable, NotFoundException } from "@nestjs/common"
import type { PrismaService } from "../../common/prisma.service"
import type { AuditService } from "../audit/audit.service"

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

  async createKey(
    organizationId: string,
    name: string,
    permissions: string[],
    userId: string,
  ) {
    const { raw, hash } = generateApiKey()

    await this.prisma.apiKey.create({
      data: {
        organizationId,
        name,
        keyHash: hash,
        permissions,
      },
    })

    await this.audit.log({
      action: "API_KEY_CREATED",
      entityType: "ApiKey",
      metadata: { name, permissions },
      userId,
      organizationId,
    })

    return {
      name,
      key: raw,
      message: "Store this key securely — it will not be shown again",
    }
  }

  async listKeys(organizationId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { organizationId },
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
    })
    return keys
  }

  async revokeKey(id: string, organizationId: string, userId: string) {
    const key = await this.prisma.apiKey.findFirst({
      where: { id, organizationId },
    })
    if (!key) throw new NotFoundException("API key not found")

    await this.prisma.apiKey.delete({ where: { id } })

    await this.audit.log({
      action: "API_KEY_REVOKED",
      entityType: "ApiKey",
      entityId: id,
      metadata: { name: key.name },
      userId,
      organizationId,
    })

    return { message: "API key revoked" }
  }

  async validateKey(rawKey: string): Promise<{
    valid: boolean
    permissions?: string[]
    organizationId?: string
  }> {
    const hash = hashKey(rawKey)
    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: hash },
    })
    if (!key) return { valid: false }
    if (key.expiresAt && key.expiresAt < new Date()) return { valid: false }

    await this.prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() },
    })

    return {
      valid: true,
      permissions: key.permissions as string[],
      organizationId: key.organizationId,
    }
  }
}
