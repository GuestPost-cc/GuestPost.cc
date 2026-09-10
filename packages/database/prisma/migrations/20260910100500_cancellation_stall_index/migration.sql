CREATE INDEX CONCURRENTLY IF NOT EXISTS "OrderCancellationRequest_stall_sweep_idx"
  ON public."OrderCancellationRequest"("status", "updatedAt", "id");
