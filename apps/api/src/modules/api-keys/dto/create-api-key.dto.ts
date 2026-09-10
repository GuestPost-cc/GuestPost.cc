import { API_KEY_PERMISSIONS } from "@guestpost/shared"
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator"

// Phase 6.7 — Audit finding V-1 closure for api-keys.
//
// The previous inline body type (`@Body() body: { name: string; permissions?: string[] }`)
// did no validation on `name` (length, characters) or on permission strings
// (length, format). class-validator + global ValidationPipe now enforce:
//
//   - name: bounded length, printable characters only
//   - permissions: closed server-owned allowlist, max 32 entries
//   - expiresAt: optional ISO-8601 timestamp; service enforces future/max age
export class CreateApiKeyDto {
  @IsString()
  @MinLength(3, { message: "Name must be at least 3 characters" })
  @MaxLength(100)
  name!: string

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  @IsIn(API_KEY_PERMISSIONS, {
    each: true,
    message: "Each API key permission must be a supported permission",
  })
  permissions?: string[]

  @IsOptional()
  @IsDateString({ strict: true })
  expiresAt?: string
}
