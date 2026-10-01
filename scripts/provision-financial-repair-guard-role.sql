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
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_financial_repair_staging'
  ) THEN
    CREATE ROLE guestpost_financial_repair_staging
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$financial_repair_guard_role$;

ALTER ROLE guestpost_financial_repair_guard
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE guestpost_financial_repair_staging
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- A production migrator runs as guestpost_schema_owner, which must be a
-- member of the new function owner to transfer trigger-function ownership.
-- Fresh CI databases may not have the complete role topology yet; the full
-- provisioner creates and reconciles this exact edge after migrations there.
DO $financial_repair_guard_membership$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guestpost_schema_owner') THEN
    EXECUTE 'GRANT guestpost_financial_repair_guard TO guestpost_schema_owner WITH INHERIT FALSE, SET TRUE';
  END IF;
END
$financial_repair_guard_membership$;
