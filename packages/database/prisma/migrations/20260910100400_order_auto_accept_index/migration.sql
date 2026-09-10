CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_auto_accept_sweep_idx"
  ON public."Order"("status", "autoAcceptAt", "id");
