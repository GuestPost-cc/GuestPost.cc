-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "Website_reverify_sweep_idx"
  ON public."Website"(
    "verificationStatus", "verificationMethod",
    "lastVerificationCheckAt", "id"
  );
