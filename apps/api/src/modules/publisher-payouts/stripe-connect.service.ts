import { randomUUID } from "node:crypto"
import { isUniqueViolation } from "@guestpost/shared"
import {
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
} from "@guestpost/shared/dist/prisma-transaction-retry"
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { assertApiFinanceOperationAllowed } from "../../common/finance-runtime-mode"
import { PrismaService } from "../../common/prisma.service"
import {
  getStripeClient,
  getStripeRecoveryClient,
  isStripeFeatureEnabled,
} from "../../common/stripe-client"
import { AuditService } from "../audit/audit.service"
import {
  PayoutEncryptionService,
  payoutMethodEncryptionContext,
} from "./payout-encryption.service"
import { currentPayoutMethodRuntime } from "./payout-method-runtime"

const SERIALIZABLE_ATTEMPTS = 5

type StripeAccountSyncContext =
  | {
      source: "publisher_refresh"
      actorUserId: string
      publisherId: string
    }
  | {
      source: "webhook"
      payoutWebhookEventId: string
      claimAttempt: number
      claimLockedAt: string
    }

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

@Injectable()
export class StripeConnectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encryption: PayoutEncryptionService,
  ) {}

  private async assertMember(
    userId: string,
    publisherId: string,
    db: any = this.prisma,
  ) {
    const member = await db.publisherMembership.findFirst({
      where: {
        userId,
        publisherId,
        role: "PUBLISHER_OWNER",
        user: { banned: false, userType: "PUBLISHER" },
      },
      select: { id: true },
    })
    if (!member) {
      throw new ForbiddenException(
        "An active publisher owner account is required",
      )
    }
  }

  private async runSerializable<T>(
    operation: (tx: any) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: "Serializable",
        })
      } catch (error) {
        if (!isRetryablePrismaTransactionError(error)) throw error
        if (attempt === SERIALIZABLE_ATTEMPTS) {
          throw new ConflictException({
            code: "STRIPE_CONNECT_CONCURRENCY_RETRY",
            message:
              "Stripe payout state changed concurrently. Refresh and retry the operation.",
          })
        }
        await sleep(prismaTransactionRetryDelayMs(attempt))
      }
    }
    throw new ConflictException({
      code: "STRIPE_CONNECT_CONCURRENCY_RETRY",
      message:
        "Stripe payout state changed concurrently. Refresh and retry the operation.",
    })
  }

  private stripeUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: "STRIPE_CONNECT_UNAVAILABLE",
      message:
        "Stripe payout setup could not be confirmed. No withdrawal was submitted. Retry or refresh the provider status later.",
    })
  }

  private publisherStripeClient() {
    try {
      return getStripeClient("connect")
    } catch {
      throw this.stripeUnavailable()
    }
  }

  private async callStripeForContext<T>(
    context: StripeAccountSyncContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (context.source === "publisher_refresh") {
        throw this.stripeUnavailable()
      }
      throw error
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
    assertApiFinanceOperationAllowed("recovery")
    const local = await this.prisma.publisherProviderAccount.findUnique({
      where: {
        publisherId_provider: { publisherId, provider: "stripe_connect" },
      },
    })
    if (!local) throw new NotFoundException("Stripe account is not connected")
    return this.publicStatus(
      await this.syncAccount(
        local.providerAccountId,
        {
          source: "publisher_refresh",
          actorUserId: userId,
          publisherId,
        },
        true,
      ),
    )
  }

  async createOnboardingLink(publisherId: string, userId: string) {
    await this.assertMember(userId, publisherId)
    // Creating or extending a provider payout route is a normal-mode-only
    // liability operation. Gate before Stripe or local state can mutate.
    assertApiFinanceOperationAllowed("new_liability")
    if (!isStripeFeatureEnabled("connect")) {
      throw new BadRequestException("Stripe publisher payouts are not enabled")
    }
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
      select: { id: true, name: true, email: true, organizationId: true },
    })
    if (!publisher) throw new NotFoundException("Publisher not found")

    const stripe = this.publisherStripeClient()
    let local = await this.prisma.publisherProviderAccount.findUnique({
      where: {
        publisherId_provider: { publisherId, provider: "stripe_connect" },
      },
    })
    if (!local) {
      const account = await this.callStripeForContext(
        {
          source: "publisher_refresh",
          actorUserId: userId,
          publisherId,
        },
        () =>
          stripe.accounts.create(
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
          ),
      )
      const createLocalAccount = async (tx: any) => {
        // Stripe is outside the database transaction. Revalidate after that
        // external call so a removed/suspended owner cannot bind the route.
        await this.assertMember(userId, publisherId, tx)
        const created = await tx.publisherProviderAccount.create({
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
        await this.audit.log(
          {
            action: "STRIPE_CONNECT_ACCOUNT_CREATED",
            entityType: "PublisherProviderAccount",
            entityId: created.id,
            metadata: { publisherId, provider: "stripe_connect" },
            userId,
            organizationId: publisher.organizationId,
          },
          tx,
        )
        return created
      }
      try {
        local = await this.runSerializable(createLocalAccount)
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        local = await this.prisma.publisherProviderAccount.findUnique({
          where: {
            publisherId_provider: { publisherId, provider: "stripe_connect" },
          },
        })
        if (!local || local.providerAccountId !== account.id) throw error

        // A unique collision is a harmless concurrent replay only when the
        // exact local identity and its required creation audit both committed.
        const creationEvidence = await this.prisma.auditLog.findFirst({
          where: {
            action: "STRIPE_CONNECT_ACCOUNT_CREATED",
            entityType: "PublisherProviderAccount",
            entityId: local.id,
          },
          select: { id: true },
        })
        if (!creationEvidence) throw error
      }
    }

    if (!local) {
      throw new Error("Stripe account persistence did not return an account")
    }
    const baseUrl = (
      process.env.NEXT_PUBLIC_PUBLISHER_URL ?? "http://localhost:3002"
    ).replace(/\/$/, "")
    const link = await this.callStripeForContext(
      {
        source: "publisher_refresh",
        actorUserId: userId,
        publisherId,
      },
      () =>
        stripe.accountLinks.create({
          account: local.providerAccountId,
          refresh_url: `${baseUrl}/dashboard/payout-methods?stripe=refresh`,
          return_url: `${baseUrl}/dashboard/payout-methods?stripe=return`,
          type: "account_onboarding",
        }),
    )
    // The URL is a single-use routing credential. Recheck both actor authority
    // and the exact local/provider binding after Stripe creates it and
    // immediately before returning it. A revoked actor receives no URL.
    await this.runSerializable(async (tx) => {
      await this.assertMember(userId, publisherId, tx)
      const currentBinding = await tx.publisherProviderAccount.findUnique({
        where: {
          publisherId_provider: { publisherId, provider: "stripe_connect" },
        },
        select: { id: true, providerAccountId: true },
      })
      if (
        !currentBinding ||
        currentBinding.id !== local.id ||
        currentBinding.providerAccountId !== local.providerAccountId
      ) {
        throw new ConflictException({
          code: "STRIPE_ACCOUNT_BINDING_CHANGED",
          message:
            "Stripe account binding changed while creating the onboarding link",
        })
      }
    })
    // Account Link URLs are single-use credentials. Never persist or log one.
    return {
      url: link.url,
      expiresAt: new Date(link.expires_at * 1000).toISOString(),
    }
  }

  async syncAccount(
    providerAccountId: string,
    context: StripeAccountSyncContext,
    configurePayoutSchedule = true,
  ) {
    // Provider recovery can repair already-existing routing state in normal or
    // recovery-only mode. Locked mode must stop before Stripe or local writes.
    assertApiFinanceOperationAllowed("recovery")
    this.assertValidSyncContext(context)

    const localIdentity = await this.prisma.publisherProviderAccount.findUnique(
      {
        where: {
          provider_providerAccountId: {
            provider: "stripe_connect",
            providerAccountId,
          },
        },
        select: {
          id: true,
          publisherId: true,
          providerAccountId: true,
          lastSyncedAt: true,
        },
      },
    )
    if (!localIdentity) {
      throw new NotFoundException("Stripe account is not connected")
    }
    if (
      context.source === "publisher_refresh" &&
      context.publisherId !== localIdentity.publisherId
    ) {
      throw new ForbiddenException(
        "Stripe account does not belong to this publisher",
      )
    }
    if (context.source === "webhook") {
      // Do not touch Stripe for a forged/stale internal context. The same
      // authority is locked and revalidated in the persistence transaction.
      await this.readAndAssertWebhookSyncAuthority(
        this.prisma,
        context,
        localIdentity.providerAccountId,
      )
    }

    let stripe: ReturnType<typeof getStripeRecoveryClient>
    try {
      stripe = getStripeRecoveryClient()
    } catch (error) {
      if (context.source === "publisher_refresh") {
        throw this.stripeUnavailable()
      }
      throw error
    }
    const account = await this.callStripeForContext(context, () =>
      stripe.accounts.retrieve(providerAccountId),
    )
    if (account.id !== localIdentity.providerAccountId) {
      throw new ConflictException({
        code: "STRIPE_ACCOUNT_EVIDENCE_MISMATCH",
        message:
          "Stripe returned account evidence that does not match the saved payout account.",
      })
    }
    const stripeAccount = account as any
    const accountDeleted = stripeAccount.deleted === true
    const transfersEnabled =
      !accountDeleted && stripeAccount.capabilities?.transfers === "active"
    const detailsSubmitted =
      !accountDeleted && stripeAccount.details_submitted === true
    const payoutsEnabled =
      !accountDeleted && stripeAccount.payouts_enabled === true
    const defaultCurrency = accountDeleted
      ? null
      : (stripeAccount.default_currency?.toUpperCase() ?? null)
    const currencySupported = defaultCurrency === "USD"
    let payoutScheduleConfigured = false

    if (
      !accountDeleted &&
      configurePayoutSchedule &&
      transfersEnabled &&
      detailsSubmitted &&
      payoutsEnabled &&
      currencySupported
    ) {
      const balanceSettings = (stripe as any).balanceSettings
      if (!balanceSettings?.update) {
        if (context.source === "publisher_refresh") {
          throw this.stripeUnavailable()
        }
        throw new Error("Stripe Balance Settings API is unavailable")
      }
      await this.callStripeForContext(context, () =>
        balanceSettings.update(
          {
            payments: {
              payouts: {
                schedule: { interval: "manual" },
                statement_descriptor: "GPOST",
              },
            },
          },
          { stripeAccount: stripeAccount.id },
        ),
      )
      payoutScheduleConfigured = true
    }

    const enabled =
      !accountDeleted &&
      transfersEnabled &&
      detailsSubmitted &&
      payoutsEnabled &&
      currencySupported &&
      payoutScheduleConfigured
    const requirementsDue = accountDeleted
      ? ["guestpost.stripe.account_deleted"]
      : [
          ...(stripeAccount.requirements?.currently_due ?? []),
          ...(currencySupported ? [] : ["guestpost.currency.usd_required"]),
        ]
    const syncData = {
      status: accountDeleted
        ? ("DISABLED" as const)
        : enabled
          ? ("ENABLED" as const)
          : detailsSubmitted
            ? ("RESTRICTED" as const)
            : ("PENDING_ONBOARDING" as const),
      ...(accountDeleted ? { isActive: false } : {}),
      // A deleted Stripe response contains no country/currency. Preserve the
      // last-known local routing evidence instead of replacing it with null.
      ...(accountDeleted
        ? {}
        : {
            country: stripeAccount.country ?? null,
            defaultCurrency,
          }),
      transfersEnabled,
      payoutsEnabled,
      detailsSubmitted,
      payoutScheduleConfigured,
      requirementsDue,
      lastSyncedAt: new Date(),
    }

    const persist = () =>
      this.runSerializable(async (tx) => {
        if (context.source === "webhook") {
          await this.assertWebhookSyncAuthority(
            tx,
            context,
            localIdentity.providerAccountId,
          )
        } else {
          // Revalidate after Stripe retrieval/schedule configuration and in
          // the exact transaction that mutates managed routing state.
          await this.assertMember(context.actorUserId, context.publisherId, tx)
        }

        // Canonical managed-routing lock order is ProviderAccount ->
        // PayoutMethod. Updating the account first takes its row lock before
        // ensurePayoutMethod can read/create the managed method.
        const [local] = await tx.publisherProviderAccount.updateManyAndReturn({
          where: {
            id: localIdentity.id,
            lastSyncedAt: localIdentity.lastSyncedAt,
          },
          data: syncData,
        })
        if (!local) {
          throw new ConflictException({
            code: "STRIPE_ACCOUNT_SYNC_RACE",
            message:
              "Stripe account changed concurrently; retry the status refresh",
          })
        }
        if (
          local.publisherId !== localIdentity.publisherId ||
          local.provider !== "stripe_connect" ||
          local.providerAccountId !== localIdentity.providerAccountId
        ) {
          throw new Error(
            "Local Stripe account identity changed during refresh",
          )
        }

        if (enabled) await this.ensurePayoutMethod(local, tx)

        const publisher = await tx.publisher.findUnique({
          where: { id: local.publisherId },
          select: { organizationId: true },
        })
        if (!publisher) {
          throw new Error("Stripe account publisher no longer exists")
        }
        await this.audit.log(
          this.syncAuditInput(local, publisher.organizationId, context),
          tx,
        )
        return local
      })

    try {
      return await persist()
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      // A transaction that loses the managed-method insert race is rolled
      // back. Retry only after the exact provider-managed identity is visible;
      // unrelated unique violations remain failures.
      const racedMethod = await this.prisma.payoutMethod.findUnique({
        where: { providerAccountId: localIdentity.id },
        select: { id: true, publisherId: true, type: true, isActive: true },
      })
      if (!racedMethod) throw error
      this.assertManagedPayoutMethodIdentity(racedMethod, localIdentity)
      return persist()
    }
  }

  private assertValidSyncContext(context: StripeAccountSyncContext) {
    if (
      context.source === "publisher_refresh" &&
      (!context.actorUserId.trim() || !context.publisherId.trim())
    ) {
      throw new Error("Publisher refresh context is incomplete")
    }
    if (context.source === "webhook") {
      const claimLockedAt = new Date(context.claimLockedAt)
      if (
        !context.payoutWebhookEventId.trim() ||
        !Number.isSafeInteger(context.claimAttempt) ||
        context.claimAttempt < 1 ||
        Number.isNaN(claimLockedAt.getTime()) ||
        claimLockedAt.toISOString() !== context.claimLockedAt
      ) {
        throw new Error("Stripe webhook sync context is incomplete")
      }
    }
  }

  private syncAuditInput(
    account: any,
    organizationId: string,
    context: StripeAccountSyncContext,
  ) {
    const common = {
      entityType: "PublisherProviderAccount",
      entityId: account.id,
      organizationId,
      metadata: {
        publisherId: account.publisherId,
        provider: "stripe_connect",
        source: context.source,
        resultStatus: account.status,
        providerAccountActive: account.isActive,
      },
    }
    if (context.source === "publisher_refresh") {
      return {
        ...common,
        action: "STRIPE_CONNECT_ACCOUNT_REFRESHED_BY_PUBLISHER",
        userId: context.actorUserId,
      }
    }
    return {
      ...common,
      action: "STRIPE_CONNECT_ACCOUNT_SYNCED_FROM_WEBHOOK",
      userId: null,
      metadata: {
        ...common.metadata,
        payoutWebhookEventId: context.payoutWebhookEventId,
        webhookClaimAttempt: context.claimAttempt,
        webhookClaimLockedAt: context.claimLockedAt,
      },
    }
  }

  private async assertWebhookSyncAuthority(
    tx: any,
    context: Extract<StripeAccountSyncContext, { source: "webhook" }>,
    providerAccountId: string,
  ) {
    await tx.$queryRawUnsafe(
      'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
      context.payoutWebhookEventId,
    )
    await this.readAndAssertWebhookSyncAuthority(tx, context, providerAccountId)
  }

  private async readAndAssertWebhookSyncAuthority(
    db: any,
    context: Extract<StripeAccountSyncContext, { source: "webhook" }>,
    providerAccountId: string,
  ) {
    const event = await db.payoutWebhookEvent.findUnique({
      where: { id: context.payoutWebhookEventId },
      select: {
        provider: true,
        eventType: true,
        providerAccountExternalId: true,
        status: true,
        attempts: true,
        lockedAt: true,
      },
    })
    const expectedLockedAt = new Date(context.claimLockedAt)
    if (
      event?.provider !== "stripe_connect" ||
      event.eventType !== "account.updated" ||
      event.providerAccountExternalId !== providerAccountId ||
      event.status !== "PROCESSING" ||
      event.attempts !== context.claimAttempt ||
      !(event.lockedAt instanceof Date) ||
      event.lockedAt.getTime() !== expectedLockedAt.getTime()
    ) {
      throw new Error(
        "Stripe webhook event does not authorize this account refresh",
      )
    }
  }

  private async ensurePayoutMethod(account: any, db: any = this.prisma) {
    const existing = await db.payoutMethod.findUnique({
      where: { providerAccountId: account.id },
      select: { id: true, publisherId: true, type: true, isActive: true },
    })
    if (existing) {
      this.assertManagedPayoutMethodIdentity(existing, account)
      // A disabled method represents an explicit publisher/staff lifecycle
      // decision. Provider status refreshes must never silently reactivate it.
      return
    }

    const methodId = randomUUID()
    const methodType = "stripe_connect"
    const { ciphertext, version } = this.encryption.encrypt(
      { destinationManagedBy: "stripe" },
      payoutMethodEncryptionContext({
        id: methodId,
        publisherId: account.publisherId,
        type: methodType,
      }),
    )
    const methodCount = await db.payoutMethod.count({
      where: { publisherId: account.publisherId, isActive: true },
    })

    await db.payoutMethod.create({
      data: {
        id: methodId,
        publisherId: account.publisherId,
        providerAccountId: account.id,
        type: methodType,
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

  private assertManagedPayoutMethodIdentity(method: any, account: any) {
    if (
      method.publisherId !== account.publisherId ||
      method.type !== "stripe_connect"
    ) {
      throw new Error(
        "Managed payout method identity does not match its Stripe account",
      )
    }
  }

  private publicStatus(account: any | null) {
    const runtime = currentPayoutMethodRuntime()
    return {
      available: runtime.stripeConnectPayoutsEnabled,
      payoutActionsAvailable: runtime.newLiabilityOperationsEnabled,
      manualBankPayoutsAvailable:
        runtime.newLiabilityOperationsEnabled &&
        runtime.manualBankPayoutsEnabled &&
        !runtime.stripeConnectPayoutsEnabled,
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
