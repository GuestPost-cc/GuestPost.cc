-- New staff-cleared fraud decisions must carry a bounded classification. The
-- historical append-only rows cannot be rewritten without inventing evidence,
-- so the constraint is NOT VALID: PostgreSQL enforces it for every new row
-- while preserving pre-classification history for forensic review.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE "DeliveryFraudFlagResolution"
  ADD CONSTRAINT "DeliveryFraudFlagResolution_staff_disposition_check"
  CHECK (
    "kind" <> 'STAFF_CLEARED'
    OR (
      COALESCE(
        jsonb_typeof("evidence" -> 'disposition') = 'string',
        FALSE
      )
      AND COALESCE("evidence" ->> 'disposition' IN (
        'FALSE_POSITIVE',
        'AUTHORIZED_REUSE',
        'RISK_ACCEPTED'
      ), FALSE)
      AND (
        NOT ("evidence" ? 'evidenceReference')
        OR "evidence" -> 'evidenceReference' = 'null'::jsonb
        OR (
          jsonb_typeof("evidence" -> 'evidenceReference') = 'string'
          AND char_length(btrim("evidence" ->> 'evidenceReference'))
            BETWEEN 1 AND 200
        )
      )
      AND (
        "evidence" ->> 'disposition' = 'FALSE_POSITIVE'
        OR (
          jsonb_typeof("evidence" -> 'evidenceReference') = 'string'
          AND char_length(btrim("evidence" ->> 'evidenceReference'))
            BETWEEN 1 AND 200
        )
      )
    )
  ) NOT VALID;

CREATE FUNCTION "guard_delivery_fraud_resolution_disposition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  disposition TEXT;
  evidence_reference TEXT;
BEGIN
  IF NEW."kind" <> 'STAFF_CLEARED' THEN
    RETURN NEW;
  END IF;

  disposition := NEW."evidence" ->> 'disposition';
  evidence_reference := btrim(
    COALESCE(NEW."evidence" ->> 'evidenceReference', '')
  );

  IF disposition IS NULL OR disposition NOT IN (
      'FALSE_POSITIVE',
      'AUTHORIZED_REUSE',
      'RISK_ACCEPTED'
    ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'staff-cleared fraud resolution requires a classified disposition';
  END IF;

  IF disposition IN ('AUTHORIZED_REUSE', 'RISK_ACCEPTED') THEN
    IF NEW."resolvedByRole" IS NULL
       OR NEW."resolvedByRole" NOT IN ('SUPER_ADMIN', 'FINANCE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'known delivery risk can be accepted only by Finance or Super Admin';
    END IF;
    IF evidence_reference = '' OR char_length(evidence_reference) > 200 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'known delivery risk requires a bounded evidence reference';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER "DeliveryFraudFlagResolution_classification_guard"
  BEFORE INSERT ON "DeliveryFraudFlagResolution"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_delivery_fraud_resolution_disposition"();

COMMIT;
