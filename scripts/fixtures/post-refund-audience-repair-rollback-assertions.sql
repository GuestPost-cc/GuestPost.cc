-- Assertions run after the deliberately failed refund-audience migration.
-- Every write performed before the injected Notification failure must have
-- rolled back, including incident evidence that would otherwise be misleading.

\set ON_ERROR_STOP on

DO $$
DECLARE
  actual_statuses jsonb;
  audit_count integer;
  notification_count integer;
BEGIN
  SELECT jsonb_object_agg(delivery."id", delivery."status"::text)
    INTO actual_statuses
  FROM public."CommunicationDelivery" delivery
  WHERE delivery."eventId" = 'migration-refund-event';

  IF actual_statuses IS DISTINCT FROM jsonb_build_object(
    'migration-refund-delivery-pending', 'PENDING',
    'migration-refund-delivery-processing-pre', 'PROCESSING',
    'migration-refund-delivery-processing-post', 'PROCESSING',
    'migration-refund-delivery-sent', 'SENT',
    'migration-refund-delivery-uncertain', 'DELIVERY_UNCERTAIN',
    'migration-refund-delivery-null-user', 'PENDING',
    'migration-refund-delivery-inactive-owner', 'FAILED',
    'migration-refund-delivery-customer', 'PENDING',
    'migration-refund-delivery-active-owner', 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'failed refund repair left partial delivery changes: %', actual_statuses;
  END IF;

  SELECT count(*)
    INTO audit_count
  FROM public."AuditLog"
  WHERE "entityId" = 'migration-refund-event'
    AND "action" IN (
      'LEGACY_REFUND_AUDIENCE_DISCLOSURE_REVIEW_REQUIRED',
      'LEGACY_REFUND_AUDIENCE_PROJECTIONS_REPAIRED'
    );

  IF audit_count <> 0 THEN
    RAISE EXCEPTION 'failed refund repair exposed misleading audit rows: %', audit_count;
  END IF;

  SELECT count(*)
    INTO notification_count
  FROM public."Notification"
  WHERE "eventId" = 'migration-refund-event';

  IF notification_count <> 4 THEN
    RAISE EXCEPTION 'failed refund repair partially deleted notifications: %', notification_count;
  END IF;
END
$$;
