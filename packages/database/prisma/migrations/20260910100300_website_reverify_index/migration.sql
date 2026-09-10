CREATE INDEX CONCURRENTLY IF NOT EXISTS "Website_reverify_sweep_idx"
  ON public."Website"(
    "verificationStatus", "verificationMethod",
    "lastVerificationCheckAt", "id"
  );
