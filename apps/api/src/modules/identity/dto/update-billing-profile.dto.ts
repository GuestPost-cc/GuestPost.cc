import { isSafeFinancialDocumentText } from "@guestpost/shared"
import { Transform } from "class-transformer"
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  ValidateIf,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator"

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim().normalize("NFC") : value
const optionalTrim = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? null : trim({ value })
function IsSafeBillingText(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "isSafeBillingText",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && isSafeFinancialDocumentText(value)
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} contains unsafe or invisible control characters`
        },
      },
    })
  }
}

export class UpdateBillingProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @IsSafeBillingText()
  legalName: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  billingEmail?: string | null

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @IsSafeBillingText()
  addressLine1: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @IsSafeBillingText()
  addressLine2?: string | null

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsSafeBillingText()
  city: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @IsSafeBillingText()
  region?: string | null

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @IsSafeBillingText()
  postalCode: string

  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  countryCode: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9 ._/-]+$/)
  taxIdType?: string | null

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9 ._/-]+$/)
  @ValidateIf((dto: UpdateBillingProfileDto) => Boolean(dto.taxIdType))
  taxId?: string | null
}
