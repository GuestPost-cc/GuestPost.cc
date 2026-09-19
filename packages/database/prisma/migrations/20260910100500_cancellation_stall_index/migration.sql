-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "OrderCancellationRequest_stall_sweep_idx"
  ON public."OrderCancellationRequest"("status", "updatedAt", "id");
