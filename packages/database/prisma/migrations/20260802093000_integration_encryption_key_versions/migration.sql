-- Persist the master-key version that authenticated both OAuth token fields.
-- Existing ciphertext was produced by the only historical key derivation (v1),
-- so the additive backfill is deterministic; malformed envelopes fail closed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

LOCK TABLE "ExternalAccount" IN SHARE MODE;

CREATE FUNCTION "is_valid_integration_ciphertext"(ciphertext TEXT, key_version INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  decoded BYTEA;
  canonical TEXT;
  encoded TEXT;
  expected_prefix TEXT;
BEGIN
  IF key_version IS NULL OR key_version < 1 THEN
    RETURN FALSE;
  END IF;

  -- Version 1 is the historical raw-base64 envelope. Version 2+ carries a
  -- database-readable prefix, which prevents an old v1 application image from
  -- replacing a rotated row while silently retaining its newer version label.
  IF key_version = 1 THEN
    encoded := ciphertext;
  ELSE
    expected_prefix := 'v' || key_version::TEXT || ':';
    IF LEFT(ciphertext, LENGTH(expected_prefix)) <> expected_prefix THEN
      RETURN FALSE;
    END IF;
    encoded := SUBSTRING(ciphertext FROM LENGTH(expected_prefix) + 1);
  END IF;

  IF LENGTH(encoded) < 40
     OR LENGTH(ciphertext) > 524320
     OR LENGTH(encoded) % 4 <> 0
     OR encoded !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
    RETURN FALSE;
  END IF;

  BEGIN
    decoded := decode(encoded, 'base64');
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- AES-GCM envelope: 12-byte IV + 16-byte tag + at least one byte of
  -- authenticated ciphertext. PostgreSQL's encoder wraps long base64 lines,
  -- so remove only its canonical CR/LF wrapping before equality comparison.
  IF OCTET_LENGTH(decoded) < 29 THEN
    RETURN FALSE;
  END IF;
  canonical := REPLACE(REPLACE(encode(decoded, 'base64'), E'\n', ''), E'\r', '');
  RETURN canonical = encoded;
END
$$;

DO $$
DECLARE
  malformed RECORD;
BEGIN
  SELECT "id" INTO malformed
  FROM "ExternalAccount"
  WHERE
    NOT (
      -- The 20260718120000 transition deliberately retained missing legacy
      -- credentials as an ERROR account with two empty sentinels. It carries
      -- no key provenance and may only be repaired by a fresh OAuth callback.
      "status" = 'ERROR'
      AND "encryptedAccessToken" = ''
      AND "encryptedRefreshToken" = ''
    )
    AND (
      NOT "is_valid_integration_ciphertext"("encryptedAccessToken", 1)
      OR NOT "is_valid_integration_ciphertext"("encryptedRefreshToken", 1)
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'integration encryption migration blocked: account %s has a malformed legacy ciphertext envelope',
        malformed."id"
      );
  END IF;
END
$$;

-- Backfill the only historical derivation as version 1, then deliberately
-- leave the column without a default. Every future credential writer must
-- persist the version returned by encrypt(); a database default could silently
-- mislabel v2+ ciphertext as v1.
ALTER TABLE "ExternalAccount"
  ADD COLUMN "encryptionKeyVersion" INTEGER;

UPDATE "ExternalAccount" SET "encryptionKeyVersion" = 1;

ALTER TABLE "ExternalAccount"
  ALTER COLUMN "encryptionKeyVersion" SET NOT NULL;

ALTER TABLE "ExternalAccount"
  ADD CONSTRAINT "ExternalAccount_encryption_key_version_check"
  CHECK ("encryptionKeyVersion" >= 1);

ALTER TABLE "ExternalAccount"
  ADD CONSTRAINT "ExternalAccount_token_envelope_check"
  CHECK (
    (
      "status" = 'ERROR'
      AND "encryptedAccessToken" = ''
      AND "encryptedRefreshToken" = ''
      AND "encryptionKeyVersion" = 1
    )
    OR (
      "is_valid_integration_ciphertext"("encryptedAccessToken", "encryptionKeyVersion")
      AND "is_valid_integration_ciphertext"("encryptedRefreshToken", "encryptionKeyVersion")
    )
  );

CREATE FUNCTION "guard_external_account_token_rotation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  access_changed BOOLEAN;
  refresh_changed BOOLEAN;
  version_changed BOOLEAN;
BEGIN
  access_changed := NEW."encryptedAccessToken" IS DISTINCT FROM OLD."encryptedAccessToken";
  refresh_changed := NEW."encryptedRefreshToken" IS DISTINCT FROM OLD."encryptedRefreshToken";
  version_changed := NEW."encryptionKeyVersion" IS DISTINCT FROM OLD."encryptionKeyVersion";

  -- Access and refresh tokens share one persisted key version. Re-encrypting
  -- both, even when the provider returns the same refresh token, prevents a
  -- crash from leaving a mixed-version credential pair.
  IF access_changed <> refresh_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'external account token ciphertexts must rotate together';
  END IF;

  IF version_changed AND NOT (access_changed AND refresh_changed) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'external account key version cannot be relabeled without rotating both ciphertexts';
  END IF;

  IF NEW."encryptionKeyVersion" < OLD."encryptionKeyVersion" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'external account encryption key version cannot decrease';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "ExternalAccount_token_rotation_guard"
  BEFORE UPDATE OF "encryptedAccessToken", "encryptedRefreshToken", "encryptionKeyVersion"
  ON "ExternalAccount"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_external_account_token_rotation"();

CREATE FUNCTION "guard_external_account_owner_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."externalUserId" IS DISTINCT FROM OLD."externalUserId"
     OR NEW."ownerType" IS DISTINCT FROM OLD."ownerType"
     OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'external account provider and owner identity is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ExternalAccount_owner_identity_guard"
  BEFORE UPDATE OF "provider", "externalUserId", "ownerType", "ownerId"
  ON "ExternalAccount"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_external_account_owner_identity"();

COMMIT;
