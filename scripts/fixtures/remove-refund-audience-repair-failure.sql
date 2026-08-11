\set ON_ERROR_STOP on

DROP TRIGGER "migration_rehearsal_fail_refund_notification_delete"
  ON public."Notification";
DROP FUNCTION public."migration_rehearsal_fail_refund_notification_delete"();
