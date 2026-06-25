import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator"

// Phase 6.7 — Audit finding V-1 closure.
//
// Every inline `@Body() body: {...}` shape in AdminController is replaced
// with a DTO that the global ValidationPipe (`forbidNonWhitelisted: true`)
// enforces. Unknown keys are rejected; bounded strings prevent oversized
// payloads; enums prevent typo-driven 500s and arbitrary-state writes.
//
// One file (instead of one DTO per file) because these are tiny action
// bodies that travel together — having 17 separate one-property files
// hurts readability more than it helps.

// ── Role / tier mutations ──────────────────────────────────────────────────

// Customer-side organization roles (per Organization membership).
const CUSTOMER_ROLES = ["OWNER", "MEMBER"] as const
type CustomerRoleValue = (typeof CUSTOMER_ROLES)[number]

export class UpdateUserRoleDto {
  @IsString()
  @IsIn(CUSTOMER_ROLES as unknown as string[])
  role!: CustomerRoleValue
}

const STAFF_ROLES = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"] as const
type StaffRoleValue = (typeof STAFF_ROLES)[number]

export class UpdateStaffRoleDto {
  @IsString()
  @IsIn(STAFF_ROLES as unknown as string[])
  role!: StaffRoleValue
}

const PUBLISHER_TIERS = ["NEW", "TRUSTED", "VERIFIED"] as const
type PublisherTierValue = (typeof PUBLISHER_TIERS)[number]

export class UpdatePublisherTierDto {
  @IsString()
  @IsIn(PUBLISHER_TIERS as unknown as string[])
  tier!: PublisherTierValue
}

// ── Verification / fulfillment ─────────────────────────────────────────────

export class BulkRetryVerificationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  websiteIds!: string[]
}

const VERIFY_METHODS = [
  "MANUAL_CHECK",
  "ADMIN_OVERRIDE",
  "PUBLISHER_REPLY",
] as const

export class ManualVerifyDto {
  @IsString()
  @IsIn(VERIFY_METHODS as unknown as string[])
  method!: (typeof VERIFY_METHODS)[number]
}

export class SubmitPlatformContentDto {
  // Submitted content blob — bounded but allows real article-length bodies.
  // 200KB is the practical upper bound (~50k tokens of markdown/HTML).
  @IsString()
  @MinLength(1)
  @MaxLength(200_000)
  content!: string
}

export class MarkPlatformPublishedDto {
  // Live URL where the placement landed. Validates real URL shape so the
  // delivery-verification worker doesn't crash on bad input.
  @IsUrl({ require_protocol: true, require_tld: true })
  @MaxLength(2_048)
  url!: string
}

// ── Money / destructive actions ────────────────────────────────────────────

// Used by both refund and forceCancel. Reason is required for forensic
// review of every destructive financial action.
export class ReasonRequiredDto {
  @IsString()
  @MinLength(10, {
    message: "Reason must be at least 10 characters for audit clarity",
  })
  @MaxLength(2_000)
  reason!: string
}

// Withdrawal reverse — reason optional today (legacy compat); bound it.
export class ReverseWithdrawalDto {
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  reason?: string
}

// Provider names are kebab-case identifiers ("manual", "wise", "stripe").
// The service's PayoutProviderService rejects unknown providers — this DTO
// just bounds the string surface so a 10MB body or weird chars can't reach
// the service in the first place.
export class ExecuteWithdrawalDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/^[a-z][a-z0-9_-]*$/, {
    message:
      "providerName must be lowercase alphanumeric with hyphens/underscores",
  })
  providerName!: string
}

const DISPUTE_ACTIONS = ["RESTORE", "REFUND", "REJECT"] as const

export class ResolveDisputeDto {
  // Plain-English resolution copy that surfaces to the customer + publisher.
  @IsString()
  @MinLength(10)
  @MaxLength(5_000)
  resolution!: string

  @IsString()
  @IsIn(DISPUTE_ACTIONS as unknown as string[])
  action!: (typeof DISPUTE_ACTIONS)[number]
}

// ── Listing moderation ────────────────────────────────────────────────────

const LISTING_STATUSES = [
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "PAUSED",
  "ARCHIVED",
] as const

export class UpdateListingStatusDto {
  @IsString()
  @IsIn(LISTING_STATUSES as unknown as string[])
  status!: (typeof LISTING_STATUSES)[number]

  // SUPER_ADMIN-only override to approve listings whose website isn't
  // VERIFIED. The service enforces the SUPER_ADMIN gate.
  @IsOptional()
  @IsBoolean()
  force?: boolean
}

export class ToggleListingFeaturedDto {
  @IsBoolean()
  featured!: boolean
}

export class ToggleListingVerifiedDto {
  @IsBoolean()
  verified!: boolean
}

// ── Website management ────────────────────────────────────────────────────

export class ReassignWebsiteDto {
  // Required: NULL puts the website back in the shared unassigned-Ops pool;
  // a cuid string assigns to that Ops user. Omitting the field would be
  // ambiguous ("did you mean to reassign or not?") so we make it required.
  // class-validator allows `null` to pass @IsString when the field is
  // explicitly nullable — we use the @ValidateIf pattern below.
  @IsString()
  @MaxLength(50)
  @ValidateIf((_, v) => v !== null)
  managedByUserId!: string | null

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  reason?: string
}

export class PauseWebsiteDto {
  @IsBoolean()
  paused!: boolean
}

// ── Support ────────────────────────────────────────────────────────────────

const TICKET_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "WAITING_ON_CUSTOMER",
  "RESOLVED",
  "CLOSED",
] as const

export class UpdateSupportTicketStatusDto {
  @IsString()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status!: (typeof TICKET_STATUSES)[number]
}
