\set ON_ERROR_STOP on

DELETE FROM "Revision"
WHERE "id" IN (
  'migration-rehearsal-unexplained-revision-one',
  'migration-rehearsal-unexplained-revision-two'
);
