\set ON_ERROR_STOP on

DELETE FROM "AuditLog"
WHERE "id" = 'migration-rehearsal-conflicting-requester';
