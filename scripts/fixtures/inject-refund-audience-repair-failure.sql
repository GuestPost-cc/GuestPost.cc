-- Force a late statement in 20260811132000 to fail so the rehearsal can prove
-- that audit inserts, delivery suppression, and notification cleanup all roll
-- back together. The harness drops this trigger before the successful run.

\set ON_ERROR_STOP on

CREATE FUNCTION public."migration_rehearsal_fail_refund_notification_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'forced refund audience migration failure';
END
$$;

CREATE TRIGGER "migration_rehearsal_fail_refund_notification_delete"
  BEFORE DELETE ON public."Notification"
  FOR EACH ROW
  WHEN (OLD."eventId" = 'migration-refund-event')
  EXECUTE FUNCTION public."migration_rehearsal_fail_refund_notification_delete"();
