import { BadRequestException } from "@nestjs/common"
import {
  type CreatePayoutMethodDto,
  LEGACY_PAYOUT_METHOD_TYPES,
} from "./dto/create-payout-method.dto"

type LegacyPayoutMethodType = (typeof LEGACY_PAYOUT_METHOD_TYPES)[number]

type NormalizedPayoutMethodInput = {
  type: LegacyPayoutMethodType
  label: string
  details: Record<string, string>
  isDefault: boolean
}

const DETAIL_FIELDS: Record<LegacyPayoutMethodType, readonly string[]> = {
  bank_transfer: [
    "bankName",
    "accountHolderName",
    "accountNumber",
    "routingNumber",
    "iban",
    "swift",
  ],
}

const REQUIRED_FIELDS: Record<LegacyPayoutMethodType, readonly string[]> = {
  bank_transfer: ["bankName", "accountHolderName", "accountNumber"],
}

const FIELD_LENGTHS: Record<string, readonly [number, number]> = {
  bankName: [2, 100],
  accountHolderName: [2, 100],
  accountNumber: [4, 64],
  routingNumber: [1, 32],
  iban: [4, 34],
  swift: [8, 11],
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const SWIFT = /^[A-Za-z0-9]{8}(?:[A-Za-z0-9]{3})?$/

function invalid(message: string): never {
  throw new BadRequestException({
    code: "PAYOUT_METHOD_INPUT_INVALID",
    message,
  })
}

function normalizedString(
  details: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = details[field]
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    invalid(`Payout method ${field} must be a string`)
  }
  const normalized = value.trim()
  const [minimum, maximum] = FIELD_LENGTHS[field] ?? [1, 191]
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    CONTROL_CHARACTERS.test(normalized)
  ) {
    invalid(`Payout method ${field} has an invalid length or format`)
  }
  return normalized
}

/**
 * Defense-in-depth validation for callers that bypass Nest's ValidationPipe.
 * Keep this rail-specific: accepting an unused secret field makes accidental
 * storage and destination ambiguity much harder to detect during review.
 */
export function normalizePayoutMethodInput(
  dto: CreatePayoutMethodDto,
): NormalizedPayoutMethodInput {
  const rawType = dto?.type
  const type =
    typeof rawType === "string"
      ? (rawType.trim() as LegacyPayoutMethodType)
      : undefined
  if (!type || !LEGACY_PAYOUT_METHOD_TYPES.includes(type)) {
    invalid(
      `Payout method type must be one of: ${LEGACY_PAYOUT_METHOD_TYPES.join(", ")}`,
    )
  }

  if (typeof dto.label !== "string") {
    invalid("Payout method label must be a string")
  }
  const label = dto.label.trim()
  if (
    label.length < 2 ||
    label.length > 100 ||
    CONTROL_CHARACTERS.test(label)
  ) {
    invalid("Payout method label must be between 2 and 100 characters")
  }
  if (dto.isDefault !== undefined && typeof dto.isDefault !== "boolean") {
    invalid("Payout method isDefault must be a boolean")
  }

  if (
    !dto.details ||
    typeof dto.details !== "object" ||
    Array.isArray(dto.details)
  ) {
    invalid("Payout method details must be an object")
  }
  const rawDetails = dto.details as Record<string, unknown>
  const allowedFields = new Set(DETAIL_FIELDS[type])
  const unknownField = Object.keys(rawDetails).find(
    (field) => !allowedFields.has(field),
  )
  if (unknownField) {
    invalid(`Payout method field ${unknownField} is not valid for ${type}`)
  }

  const details: Record<string, string> = {}
  for (const field of DETAIL_FIELDS[type]) {
    const value = normalizedString(rawDetails, field)
    if (value !== undefined) details[field] = value
  }
  for (const field of REQUIRED_FIELDS[type]) {
    if (!details[field]) {
      invalid(`Payout method ${field} is required for ${type}`)
    }
  }

  if (details.swift && !SWIFT.test(details.swift)) {
    invalid("Payout method swift has an invalid format")
  }

  return {
    type,
    label,
    details,
    isDefault: dto.isDefault ?? false,
  }
}
