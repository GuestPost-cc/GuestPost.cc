import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
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
//   - permissions: array of `domain:action` slugs (lowercase, ≤ 50 chars
//     each), max 32 entries
//
// We do NOT enforce an allowlist of permission strings here — the
// ApiKeysService stores them as opaque JSON and the consumer of the key
// checks them against its own contract. A future iteration could add a
// shared API_KEY_PERMISSIONS allowlist; until then, format validation
// blocks the obvious junk + oversize attacks.
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
  @Matches(/^[a-z0-9_]+:[a-z0-9_]+$/, {
    each: true,
    message: "Each permission must be a `domain:action` slug (lowercase letters, digits, underscores)",
  })
  permissions?: string[]
}
