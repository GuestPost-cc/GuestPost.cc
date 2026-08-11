-- Assertions for the populated refund-audience migration fixture. The finance
-- rehearsal executes these both after the first migration and after an exact
-- rerun to prove idempotency against real PostgreSQL state.

\set ON_ERROR_STOP on

DO $$
DECLARE
  actual_statuses jsonb;
BEGIN
  SELECT jsonb_object_agg(delivery."id", delivery."status"::text)
    INTO actual_statuses
  FROM "CommunicationDelivery" delivery
  WHERE delivery."eventId" = 'migration-refund-event';

  IF actual_statuses IS DISTINCT FROM jsonb_build_object(
    'migration-refund-delivery-pending', 'SUPPRESSED',
    'migration-refund-delivery-processing-pre', 'SUPPRESSED',
    'migration-refund-delivery-processing-post', 'PROCESSING',
    'migration-refund-delivery-sent', 'SENT',
    'migration-refund-delivery-uncertain', 'DELIVERY_UNCERTAIN',
    'migration-refund-delivery-null-user', 'SUPPRESSED',
    'migration-refund-delivery-inactive-owner', 'SUPPRESSED',
    'migration-refund-delivery-customer', 'PENDING',
    'migration-refund-delivery-active-owner', 'PROCESSING'
  ) THEN
    RAISE EXCEPTION 'refund audience repair produced unexpected delivery statuses: %', actual_statuses;
  END IF;
END
$$;

DO $$
DECLARE
  remaining_notification_ids text[];
BEGIN
  SELECT array_agg(notification."id" ORDER BY notification."id")
    INTO remaining_notification_ids
  FROM "Notification" notification
  WHERE notification."eventId" = 'migration-refund-event';

  IF remaining_notification_ids IS DISTINCT FROM ARRAY[
    'migration-refund-notification-active-owner',
    'migration-refund-notification-customer'
  ]::text[] THEN
    RAISE EXCEPTION 'refund audience repair left an unauthorized notification: %', remaining_notification_ids;
  END IF;
END
$$;

DO $$
DECLARE
  incident_count integer;
  repair_count integer;
  incident_org text;
  repair_org text;
  terminal_count integer;
  suppressed_count integer;
  deleted_count integer;
BEGIN
  SELECT count(*), min("organizationId"),
         min(("metadata"->>'terminalUnauthorizedEmailCount')::integer)
    INTO incident_count, incident_org, terminal_count
  FROM "AuditLog"
  WHERE "action" = 'LEGACY_REFUND_AUDIENCE_DISCLOSURE_REVIEW_REQUIRED'
    AND "entityId" = 'migration-refund-event';

  SELECT count(*), min("organizationId"),
         min(("metadata"->>'preDispatchEmailSuppressed')::integer),
         min(("metadata"->>'inAppDeleted')::integer)
    INTO repair_count, repair_org, suppressed_count, deleted_count
  FROM "AuditLog"
  WHERE "action" = 'LEGACY_REFUND_AUDIENCE_PROJECTIONS_REPAIRED'
    AND "entityId" = 'migration-refund-event';

  IF incident_count <> 1 OR repair_count <> 1 THEN
    RAISE EXCEPTION 'refund audience repair audits are not idempotent: incident %, repair %', incident_count, repair_count;
  END IF;
  IF incident_org IS DISTINCT FROM 'migration-rehearsal-org'
     OR repair_org IS DISTINCT FROM 'migration-rehearsal-org' THEN
    RAISE EXCEPTION 'refund audience audits did not use canonical Order organization: incident %, repair %', incident_org, repair_org;
  END IF;
  IF terminal_count <> 3 OR suppressed_count <> 4 OR deleted_count <> 2 THEN
    RAISE EXCEPTION 'refund audience audit counts are wrong: terminal %, suppressed %, deleted %', terminal_count, suppressed_count, deleted_count;
  END IF;
END
$$;

DO $$
DECLARE
  event_status text;
  event_locked_at timestamp(3);
BEGIN
  SELECT "status"::text, "lockedAt"
    INTO event_status, event_locked_at
  FROM "CommunicationEvent"
  WHERE "id" = 'migration-refund-event';

  -- The post-dispatch PROCESSING row is immutable external-side-effect
  -- evidence. The migration must leave its parent untouched for operator
  -- reconciliation instead of making it sweepable.
  IF event_status IS DISTINCT FROM 'PROCESSING' OR event_locked_at IS NULL THEN
    RAISE EXCEPTION 'refund event with in-flight SMTP evidence was unexpectedly reconciled: status %, lockedAt %', event_status, event_locked_at;
  END IF;
END
$$;
