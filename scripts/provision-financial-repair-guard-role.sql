-- Create the owner role required by the financial-repair migration before
-- application tables and functions exist. The migration grants only the
-- reviewed object/column privileges and revokes temporary schema CREATE.
-- Run as a trusted database administrator; no runtime identity may assume it.

\set ON_ERROR_STOP on

DO $financial_repair_guard_role$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_financial_repair_guard'
  ) THEN
    CREATE ROLE guestpost_financial_repair_guard
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$financial_repair_guard_role$;

ALTER ROLE guestpost_financial_repair_guard
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
