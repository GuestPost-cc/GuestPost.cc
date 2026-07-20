import { isUniqueViolation } from "@guestpost/shared"
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import {
  getStripeClient,
  getStripeRecoveryClient,
  isStripeFeatureEnabled,
} from "../../common/stripe-client"
import { AuditService } from "../audit/audit.service"
import { PayoutEncryptionService } from "./payout-encryption.service"

@Injectable()
export class StripeConnectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encryption: PayoutEncryptionService,
  ) {}

  private async assertMember(userId: string, publisherId: string) {
    const member = await this.prisma.publisherMembership.findFirst({
      where: { userId, publisherId },
      select: { id: true },
    })
    if (!member) {
      throw new ForbiddenException("You do not own this publisher account")
    }
  }

  async getStatus(publisherId: string, userId: string) {
    await this.assertMember(userId, publisherId)
    const local = await this.prisma.publisherProviderAccount.findUnique({
      where: {
        publisherId_provider: { publisherId, provider: "stripe_connect" },
      },
    })
    return this.publicStatus(local)
  }

  async refreshStatus(publisherId: string, userId: string) {
    await this.assertMember(userId, publisherId)
    const local = await this.prisma.publisherProviderAccount.findUnique({
      where: {
        publisherId_provider: { publisherId, provider: "stripe_connect" },
      },
    })
    if (!local) throw new NotFoundException("Stripe account is not connected")
    return this.publicStatus(
      await this.syncAccount(local.providerAccountId, true),
    )
  }

  async createOnboardingLink(publisherId: string, userId: string) {
    await this.assertMember(userId, publisherId)
    if (!isStripeFeatureEnabled("connect")) {
      throw new BadRequestException("Stripe publisher payouts are not enabled")
    }
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
      select: { id: true, name: true, email: true, organizationId: true },
    })
    if (!publisher) throw new NotFoundException("Publisher not found")

    const stripe = getStripeClient("connect")
    let local = await this.prisma.publisherProviderAccount.findUnique({
      where: {
        publisherId_provider: { publisherId, provider: "stripe_connect" },
      },
    })
    if (!local) {
      const account = await stripe.accounts.create(
        {
          type: "express",
          email: publisher.email ?? undefined,
          capabilities: { transfers: { requested: true } },
          business_profile: {
            product_description: "GuestPost publisher marketplace services",
          },
          metadata: { publisher_id: publisher.id },
        },
        { idempotencyKey: `stripe-connect-account-${publisherId}` },
      )
      try {
        local = await this.prisma.publisherProviderAccount.create({
          data: {
            publisherId,
            provider: "stripe_connect",
            providerAccountId: account.id,
            status: "PENDING_ONBOARDING",
            country: account.country ?? null,
            defaultCurrency: account.default_currency?.toUpperCase() ?? null,
            lastSyncedAt: new Date(),
          },
        })
        await this.audit.log({
          action: "STRIPE_CONNECT_ACCOUNT_CREATED",
          entityType: "PublisherProviderAccount",
          entityId: local.id,
          metadata: { publisherId, provider: "stripe_connect" },
          userId,
          organizationId: publisher.organizationId,
        })
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        local = await this.prisma.publisherProviderAccount.findUnique({
          where: {
            publisherId_provider: { publisherId, provider: "stripe_connect" },
          },
        })
        if (!local || local.providerAccountId !== account.id) throw error
      }
    }

    const baseUrl = (
      process.env.NEXT_PUBLIC_PUBLISHER_URL ?? "http://localhost:3002"
    ).replace(/\/$/, "")
    const link = await stripe.accountLinks.create({
      account: local.providerAccountId,
      refresh_url: `${baseUrl}/dashboard/payout-methods?stripe=refresh`,
      return_url: `${baseUrl}/dashboard/payout-methods?stripe=return`,
      type: "account_onboarding",
    })
    // Account Link URLs are single-use credentials. Never persist or log one.
    return {
      url: link.url,
      expiresAt: new Date(link.expires_at * 1000).toISOString(),
    }
  }

  async syncAccount(providerAccountId: string, configurePayoutSchedule = true) {
    const stripe = getStripeRecoveryClient()
    const account = await stripe.accounts.retrieve(providerAccountId)
    if (account.deleted) throw new Error("Stripe connected account was deleted")
    const transfersEnabled = account.capabilities?.transfers === "active"
    const detailsSubmitted = account.details_submitted
    const payoutsEnabled = account.payouts_enabled
    const defaultCurrency = account.default_currency?.toUpperCase() ?? null
    const currencySupported = defaultCurrency === "USD"
    let payoutScheduleConfigured = false

    if (
      configurePayoutSchedule &&
      transfersEnabled &&
      detailsSubmitted &&
      payoutsEnabled &&
      currencySupported
    ) {
      const balanceSettings = (stripe as any).balanceSettings
      if (!balanceSettings?.update) {
        throw new Error("Stripe Balance Settings API is unavailable")
      }
      await balanceSettings.update(
        {
          payments: {
            payouts: {
              schedule: { interval: "manual" },
              statement_descriptor: "GPOST",
            },
          },
        },
        { stripeAccount: account.id },
      )
      payoutScheduleConfigured = true
    }

    const enabled =
      transfersEnabled &&
      detailsSubmitted &&
      payoutsEnabled &&
      currencySupported &&
      payoutScheduleConfigured
    const requirementsDue = [
      ...(account.requirements?.currently_due ?? []),
      ...(currencySupported ? [] : ["guestpost.currency.usd_required"]),
    ]
    const local = await this.prisma.publisherProviderAccount.update({
      where: {
        provider_providerAccountId: {
          provider: "stripe_connect",
          providerAccountId: account.id,
        },
      },
      data: {
        status: enabled
          ? "ENABLED"
          : detailsSubmitted
            ? "RESTRICTED"
            : "PENDING_ONBOARDING",
        country: account.country ?? null,
        defaultCurrency,
        transfersEnabled,
        payoutsEnabled,
        detailsSubmitted,
        payoutScheduleConfigured,
        requirementsDue,
        lastSyncedAt: new Date(),
      },
    })

    if (enabled) await this.ensurePayoutMethod(local)
    return local
  }

  private async ensurePayoutMethod(account: any) {
    const existing = await this.prisma.payoutMethod.findFirst({
      where: {
        publisherId: account.publisherId,
        providerAccountId: account.id,
      },
    })
    if (existing) {
      if (!existing.isActive) {
        await this.prisma.payoutMethod.update({
          where: { id: existing.id },
          data: { isActive: true },
        })
      }
      return
    }
    const { ciphertext, version } = this.encryption.encrypt({
      destinationManagedBy: "stripe",
    })
    const methodCount = await this.prisma.payoutMethod.count({
      where: { publisherId: account.publisherId, isActive: true },
    })
    await this.prisma.payoutMethod.create({
      data: {
        publisherId: account.publisherId,
        providerAccountId: account.id,
        type: "stripe_connect",
        label: "Stripe bank payout",
        details: ciphertext,
        displayDetails: {
          provider: "Stripe",
          country: account.country,
          currency: account.defaultCurrency,
        },
        encryptionKeyVersion: version,
        isDefault: methodCount === 0,
      },
    })
  }

  private publicStatus(account: any | null) {
    return {
      available: isStripeFeatureEnabled("connect"),
      connected: Boolean(account),
      status: account?.status ?? "NOT_CONNECTED",
      country: account?.country ?? null,
      defaultCurrency: account?.defaultCurrency ?? null,
      transfersEnabled: account?.transfersEnabled ?? false,
      payoutsEnabled: account?.payoutsEnabled ?? false,
      detailsSubmitted: account?.detailsSubmitted ?? false,
      requirementsDue: Array.isArray(account?.requirementsDue)
        ? account.requirementsDue
        : [],
      lastSyncedAt: account?.lastSyncedAt ?? null,
      feePolicy: {
        version: "stripe-initial-v1",
        publisherFee: 0,
        providerFeesPaidBy: "platform",
      },
    }
  }
}
