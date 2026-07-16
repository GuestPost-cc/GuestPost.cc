import { CancellationResponsibility } from "@guestpost/database"
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
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

const PUBLISHER_ROLES = ["PUBLISHER_OWNER"] as const
type PublisherRoleValue = (typeof PUBLISHER_ROLES)[number]

const STAFF_ROLES = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"] as const
type StaffRoleValue = (typeof STAFF_ROLES)[number]

const ALL_USER_ROLES = [
  ...CUSTOMER_ROLES,
  ...PUBLISHER_ROLES,
  ...STAFF_ROLES,
] as const

export class UpdateUserRoleDto {
  @IsString()
  @IsIn(ALL_USER_ROLES as unknown as string[])
  role!: CustomerRoleValue | PublisherRoleValue | StaffRoleValue
}

export class BanUserDto {
  @IsBoolean()
  banned!: boolean
}

export class UpdateStaffRoleDto {
  @IsString()
  @IsIn(STAFF_ROLES as unknown as string[])
  role!: StaffRoleValue
}

export class CreateStaffDto {
  @IsEmail()
  @MaxLength(254)
  email!: string

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string

  @IsString()
  @IsIn(STAFF_ROLES as unknown as string[])
  role!: StaffRoleValue

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/, {
    message:
      "Password must include uppercase, lowercase, number, and special character",
  })
  password!: string
}

const PUBLISHER_TIERS = ["NEW", "TRUSTED", "VERIFIED"] as const
type PublisherTierValue = (typeof PUBLISHER_TIERS)[number]

export class UpdatePublisherTierDto {
  @IsString()
  @IsIn(PUBLISHER_TIERS as unknown as string[])
  tier!: PublisherTierValue
}

// ── Verification queue ──────────────────────────────────────────────────────

const VERIFICATION_OVERRIDE_REASONS = [
  "CRAWLER_BLOCKED",
  "ROBOTS_TXT",
  "LOGIN_REQUIRED",
  "JS_RENDERING",
  "TEMPORARY_FAILURE",
  "OTHER",
] as const

export class MarkVerifiedDto {
  @IsString()
  @IsIn(VERIFICATION_OVERRIDE_REASONS as unknown as string[])
  reason!: (typeof VERIFICATION_OVERRIDE_REASONS)[number]

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  notes?: string
}

export class RejectVerificationDto {
  @IsString()
  @MinLength(10, {
    message: "Reason must be at least 10 characters for audit clarity",
  })
  @MaxLength(2_000)
  reason!: string
}

export class RequestReverifyDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ticketId?: string
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

  @ValidateIf((body: ResolveDisputeDto) => body.action === "REFUND")
  @IsEnum(CancellationResponsibility)
  responsibility?: CancellationResponsibility
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

// ── Platform configuration ───────────────────────────────────────────────────

// FIN-08: every PlatformSettings field update must carry a reason so finance
// reconciliation and internal accountability have a paper trail. The audit
// event emitted is generic (`PLATFORM_SETTINGS_UPDATED`) with a structured
// `{ field, oldValue, newValue, reason }` payload, so future settings (tax
// rate, payout threshold, etc.) reuse the same audit shape automatically.
export class UpdatePlatformFeeDto {
  // Fee must be 0–100 inclusive. Bounds check is in the DTO so a malformed
  // payload never reaches the service; the service still clamps for safety.
  @IsNumber()
  @Min(0)
  @Max(100)
  platformFeePct!: number

  @IsString()
  @MinLength(10, {
    message: "Reason must be at least 10 characters for audit clarity",
  })
  @MaxLength(2_000)
  reason!: string
}
