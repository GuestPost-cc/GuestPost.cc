-- Prove the final validation migration fails closed when retained immutable
-- STAFF_CLEARED history lacks the classified disposition it now requires.

-- NOT VALID constraints still protect new writes. Temporarily restore the
-- exact pre-constraint state and disable projection/append-only triggers so
-- this fixture can represent a row that existed before classification.
ALTER TABLE "DeliveryFraudFlagResolution" DISABLE TRIGGER USER;
ALTER TABLE "DeliveryFraudFlagResolution"
  DROP CONSTRAINT "DeliveryFraudFlagResolution_staff_disposition_check";

INSERT INTO "DeliveryFraudFlagResolution" (
  "id",
  "fraudFlagId",
  "orderId",
  "deliveryVersionId",
  "kind",
  "reason",
  "resolvedByUserId",
  "resolvedByRole",
  "evidence",
  "createdAt"
) VALUES (
  'migration-rehearsal-unsafe-staff-disposition',
  'migration-rehearsal-pre0940-fraud',
  'migration-rehearsal-settlement-order',
  'migration-rehearsal-settlement-delivery',
  'STAFF_CLEARED',
  'Historical row intentionally lacks the later disposition classification.',
  'migration-rehearsal-finance',
  'FINANCE',
  '{"source":"pre-classification-history"}'::jsonb,
  CURRENT_TIMESTAMP
);

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

ALTER TABLE "DeliveryFraudFlagResolution"
  ENABLE TRIGGER USER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "DeliveryFraudFlagResolution"
    WHERE "id" = 'migration-rehearsal-unsafe-staff-disposition'
  ) THEN
    RAISE EXCEPTION 'delivery fraud disposition negative fixture could not create its historical row';
  END IF;
END;
$$;
