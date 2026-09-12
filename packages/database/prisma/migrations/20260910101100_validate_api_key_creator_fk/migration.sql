-- PostgreSQL validates existing rows without the stronger lock held by adding
-- and validating the foreign key in one step. New writes were already checked.
ALTER TABLE public."ApiKey"
  VALIDATE CONSTRAINT "ApiKey_createdByUserId_fkey";
