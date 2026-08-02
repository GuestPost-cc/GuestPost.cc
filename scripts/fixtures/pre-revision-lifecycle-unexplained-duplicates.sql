-- Negative 0960 populated-upgrade fixture. These requests have no
-- CONTENT_SUBMITTED event in either revision window, so the migration must
-- refuse to choose an authoritative request or install the unique index.

\set ON_ERROR_STOP on

INSERT INTO "Revision" (
  "id", "orderId", "notes", "status", "createdAt", "updatedAt"
) VALUES
  (
    'migration-rehearsal-unexplained-revision-one',
    'migration-rehearsal-settlement-order',
    'Unexplained active revision must remain blocked',
    'REQUESTED',
    CURRENT_TIMESTAMP - INTERVAL '6 days',
    CURRENT_TIMESTAMP - INTERVAL '6 days'
  ),
  (
    'migration-rehearsal-unexplained-revision-two',
    'migration-rehearsal-settlement-order',
    'Second unexplained active revision must fail preflight',
    'PENDING',
    CURRENT_TIMESTAMP - INTERVAL '5 days',
    CURRENT_TIMESTAMP - INTERVAL '5 days'
  );
