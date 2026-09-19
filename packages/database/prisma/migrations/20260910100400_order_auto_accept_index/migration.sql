-- Intentionally no IF NOT EXISTS; see the invalid-index recovery runbook.
CREATE INDEX CONCURRENTLY "Order_auto_accept_sweep_idx"
  ON public."Order"("status", "autoAcceptAt", "id");
