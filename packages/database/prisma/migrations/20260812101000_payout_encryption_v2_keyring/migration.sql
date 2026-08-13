-- Make payout encryption format v2 a hard write boundary without relabeling
-- historical v0/v1 ciphertext. Key identity is carried by the authenticated
-- p2 envelope; the integer columns identify only the envelope format.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
-- DDL below intentionally creates application functions and constraints in
-- public. Each function separately pins its execution-time search_path.
SET LOCAL search_path = public, pg_catalog, pg_temp;

-- Prevent a writer from racing the preflight/constraint validation window.
-- Reads remain available while this migration validates every ciphertext.
LOCK TABLE "PayoutMethod", "PayoutProvider" IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION "is_valid_legacy_payout_ciphertext"(ciphertext TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  decoded BYTEA;
  canonical TEXT;
BEGIN
  -- Historical v0/v1 envelopes are canonical base64 containing a 12-byte IV,
  -- a 16-byte GCM tag, and a bounded JSON object (at least two bytes) of
  -- authenticated ciphertext.
  IF LENGTH(ciphertext) < 40
     OR LENGTH(ciphertext) > 90000
     OR LENGTH(ciphertext) % 4 <> 0
     OR ciphertext !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
    RETURN FALSE;
  END IF;

  BEGIN
    decoded := decode(ciphertext, 'base64');
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF OCTET_LENGTH(decoded) < 30
     OR OCTET_LENGTH(decoded) > 65564 THEN
    RETURN FALSE;
  END IF;

  -- encode(bytea, 'base64') wraps long output. Removing only CR/LF yields the
  -- canonical, unwrapped representation accepted by the application parser.
  canonical := REPLACE(REPLACE(encode(decoded, 'base64'), E'\n', ''), E'\r', '');
  RETURN canonical = ciphertext;
END;
$$;

CREATE FUNCTION "is_valid_payout_v2_ciphertext"(ciphertext TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  key_id TEXT;
  encoded TEXT;
  decoded BYTEA;
  canonical TEXT;
BEGIN
  -- p2 keeps envelope format separate from an opaque, bounded key identity.
  -- Colons are delimiters and are therefore intentionally excluded from IDs.
  IF LENGTH(ciphertext) > 90068
     OR split_part(ciphertext, ':', 1) <> 'p2' THEN
    RETURN FALSE;
  END IF;

  key_id := split_part(ciphertext, ':', 2);
  IF key_id !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RETURN FALSE;
  END IF;

  encoded := SUBSTRING(
    ciphertext
    FROM LENGTH('p2:' || key_id || ':') + 1
  );

  -- This also rejects additional delimiters after the key ID.
  IF LENGTH(encoded) < 40
     OR LENGTH(encoded) > 90000
     OR LENGTH(encoded) % 4 <> 0
     OR encoded !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
    RETURN FALSE;
  END IF;

  BEGIN
    decoded := decode(encoded, 'base64');
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF OCTET_LENGTH(decoded) < 30
     OR OCTET_LENGTH(decoded) > 65564 THEN
    RETURN FALSE;
  END IF;

  canonical := REPLACE(REPLACE(encode(decoded, 'base64'), E'\n', ''), E'\r', '');
  RETURN canonical = encoded;
END;
$$;

COMMENT ON FUNCTION "is_valid_legacy_payout_ciphertext"(TEXT) IS
  'Validates canonical raw-base64 AES-GCM payout envelopes used by formats 0 and 1.';
COMMENT ON FUNCTION "is_valid_payout_v2_ciphertext"(TEXT) IS
  'Validates bounded p2:<opaque-key-id>:<canonical-base64> AES-GCM envelopes.';

-- Fail before installing constraints if historical data is corrupt or a
-- pre-cutover application wrote a version >1 using the old raw-base64 format.
-- No row is silently relabeled: v0/v1 remains v0/v1 and valid p2 is v2 only.
DO $$
DECLARE
  malformed RECORD;
BEGIN
  SELECT
    method."id",
    method."encryptionKeyVersion"
  INTO malformed
  FROM "PayoutMethod" AS method
  WHERE NOT (
    (
      method."encryptionKeyVersion" IN (0, 1)
      AND jsonb_typeof(method."details") = 'string'
      AND COALESCE(
        "is_valid_legacy_payout_ciphertext"(method."details" #>> '{}'),
        FALSE
      )
    )
    OR (
      method."encryptionKeyVersion" = 2
      AND jsonb_typeof(method."details") = 'string'
      AND COALESCE(
        "is_valid_payout_v2_ciphertext"(method."details" #>> '{}'),
        FALSE
      )
    )
  )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'payout encryption v2 migration blocked: payout method %s has an invalid envelope for format %s',
        malformed."id",
        malformed."encryptionKeyVersion"
      );
  END IF;

  SELECT
    provider."id",
    provider."configEncryptionKeyVersion"
  INTO malformed
  FROM "PayoutProvider" AS provider
  WHERE NOT (
    (
      provider."config" = '{}'::jsonb
      AND provider."configEncryptionKeyVersion" = 0
    )
    OR (
      provider."config" <> '{}'::jsonb
      AND provider."configEncryptionKeyVersion" IN (0, 1)
      AND jsonb_typeof(provider."config") = 'string'
      AND COALESCE(
        "is_valid_legacy_payout_ciphertext"(provider."config" #>> '{}'),
        FALSE
      )
    )
    OR (
      provider."config" <> '{}'::jsonb
      AND provider."configEncryptionKeyVersion" = 2
      AND jsonb_typeof(provider."config") = 'string'
      AND COALESCE(
        "is_valid_payout_v2_ciphertext"(provider."config" #>> '{}'),
        FALSE
      )
    )
  )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'payout encryption v2 migration blocked: payout provider %s has an invalid config envelope for format %s',
        malformed."id",
        malformed."configEncryptionKeyVersion"
      );
  END IF;
END;
$$;

-- Historical formats remain valid at rest so they can be read and upgraded by
-- the resumable rotation job. New triggers below make those rows immutable at
-- the ciphertext boundary until they are atomically rewritten as p2.
ALTER TABLE "PayoutMethod"
  ALTER COLUMN "encryptionKeyVersion" DROP DEFAULT,
  ADD CONSTRAINT "PayoutMethod_encryption_envelope_check"
  CHECK (
    (
      "encryptionKeyVersion" IN (0, 1)
      AND jsonb_typeof("details") = 'string'
      AND COALESCE(
        "is_valid_legacy_payout_ciphertext"("details" #>> '{}'),
        FALSE
      )
    )
    OR (
      "encryptionKeyVersion" = 2
      AND jsonb_typeof("details") = 'string'
      AND COALESCE(
        "is_valid_payout_v2_ciphertext"("details" #>> '{}'),
        FALSE
      )
    )
  );

-- Keep the earlier provider-config shape constraint in place. This stricter
-- constraint adds canonical envelopes and makes {} a format-0 sentinel only.
ALTER TABLE "PayoutProvider"
  ADD CONSTRAINT "PayoutProvider_encryption_envelope_check"
  CHECK (
    (
      "config" = '{}'::jsonb
      AND "configEncryptionKeyVersion" = 0
    )
    OR (
      "config" <> '{}'::jsonb
      AND "configEncryptionKeyVersion" IN (0, 1)
      AND jsonb_typeof("config") = 'string'
      AND COALESCE(
        "is_valid_legacy_payout_ciphertext"("config" #>> '{}'),
        FALSE
      )
    )
    OR (
      "config" <> '{}'::jsonb
      AND "configEncryptionKeyVersion" = 2
      AND jsonb_typeof("config") = 'string'
      AND COALESCE(
        "is_valid_payout_v2_ciphertext"("config" #>> '{}'),
        FALSE
      )
    )
  );

CREATE FUNCTION "guard_payout_method_encryption_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  details_changed BOOLEAN;
  format_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."encryptionKeyVersion" <> 2
       OR jsonb_typeof(NEW."details") <> 'string'
       OR NOT COALESCE(
         public."is_valid_payout_v2_ciphertext"(NEW."details" #>> '{}'),
         FALSE
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'new payout methods require a valid format-2 p2 ciphertext envelope';
    END IF;
    RETURN NEW;
  END IF;

  -- All three values are authenticated as v2 AAD. Keep this invariant local
  -- to the encryption guard as well as the older routing/liability guard so an
  -- unused legacy row cannot ever be rebound to a different AAD identity.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."publisherId" IS DISTINCT FROM OLD."publisherId"
     OR NEW."type" IS DISTINCT FROM OLD."type" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payout method encryption context identity is immutable';
  END IF;

  details_changed := NEW."details" IS DISTINCT FROM OLD."details";
  format_changed := NEW."encryptionKeyVersion"
    IS DISTINCT FROM OLD."encryptionKeyVersion";

  IF NEW."encryptionKeyVersion" < OLD."encryptionKeyVersion" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payout method encryption format cannot decrease';
  END IF;

  IF format_changed AND NOT details_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payout method ciphertext cannot be relabeled without re-encryption';
  END IF;

  IF details_changed THEN
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'payout method ciphertext changes require one aggregate version increment';
    END IF;

    IF NEW."encryptionKeyVersion" <> 2
       OR jsonb_typeof(NEW."details") <> 'string'
       OR NOT COALESCE(
         public."is_valid_payout_v2_ciphertext"(NEW."details" #>> '{}'),
         FALSE
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'payout method ciphertext changes must atomically upgrade to a valid format-2 p2 envelope';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutMethod_encryption_v2_guard"
BEFORE INSERT OR UPDATE ON "PayoutMethod"
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_method_encryption_v2"();

CREATE FUNCTION "guard_payout_provider_encryption_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  config_changed BOOLEAN;
  format_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."config" = '{}'::jsonb
       AND NEW."configEncryptionKeyVersion" = 0 THEN
      RETURN NEW;
    END IF;

    IF NEW."configEncryptionKeyVersion" <> 2
       OR jsonb_typeof(NEW."config") <> 'string'
       OR NOT COALESCE(
         public."is_valid_payout_v2_ciphertext"(NEW."config" #>> '{}'),
         FALSE
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'non-empty payout provider config requires a valid format-2 p2 ciphertext envelope';
    END IF;
    RETURN NEW;
  END IF;

  -- Both values are authenticated as v2 AAD and must not be rebound without
  -- decrypting/re-encrypting under a different logical provider identity.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."name" IS DISTINCT FROM OLD."name" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payout provider encryption context identity is immutable';
  END IF;

  config_changed := NEW."config" IS DISTINCT FROM OLD."config";
  format_changed := NEW."configEncryptionKeyVersion"
    IS DISTINCT FROM OLD."configEncryptionKeyVersion";

  IF NEW."configEncryptionKeyVersion" < OLD."configEncryptionKeyVersion" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payout provider config encryption format cannot decrease';
  END IF;

  IF format_changed AND NOT config_changed THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payout provider config cannot be relabeled without re-encryption';
  END IF;

  IF config_changed THEN
    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'payout provider config changes require one aggregate version increment';
    END IF;

    IF NEW."configEncryptionKeyVersion" <> 2
       OR jsonb_typeof(NEW."config") <> 'string'
       OR NOT COALESCE(
         public."is_valid_payout_v2_ciphertext"(NEW."config" #>> '{}'),
         FALSE
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'payout provider config changes must atomically use a valid format-2 p2 envelope';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "PayoutProvider_encryption_v2_guard"
BEFORE INSERT OR UPDATE ON "PayoutProvider"
FOR EACH ROW
EXECUTE FUNCTION "guard_payout_provider_encryption_v2"();

COMMIT;
