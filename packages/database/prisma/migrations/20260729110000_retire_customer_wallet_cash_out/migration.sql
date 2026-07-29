-- Customer wallets are closed-loop spend balances. A legacy API path reduced
-- Wallet.availableBalance and inserted a wallet-backed WITHDRAWAL ledger row
-- without sending money through a payment provider. The application route is
-- retired, and this trigger is the database fail-closed boundary for stale
-- processes, accidental reintroduction, and unsafe application rollback.
--
-- This is deliberately a trigger rather than a validated table CHECK:
-- historical wallet-backed WITHDRAWAL rows remain available as incident
-- evidence and do not prevent this migration from deploying. Future inserts
-- and updates whose resulting row has this retired shape are rejected, and
-- historical evidence rows cannot be deleted.
--
-- Publisher payout reservations also use Transaction.type = WITHDRAWAL, but
-- they set publisherId and leave walletId NULL. Those legitimate ledger rows
-- remain permitted.
--
-- Prisma 7 does not wrap migrations in a transaction. Keep the function and
-- both enforcement triggers atomic so a failed deploy cannot leave only part
-- of the stale-writer boundary installed.
BEGIN;

CREATE FUNCTION "guard_customer_wallet_cash_out_retirement"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR (
      TG_OP = 'UPDATE'
      AND OLD."type" = 'WITHDRAWAL'
      AND OLD."walletId" IS NOT NULL
    )
  THEN
    RAISE EXCEPTION
      'Historical customer wallet cash-out ledger evidence cannot be rewritten or deleted'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'Transaction_customer_wallet_cash_out_evidence_immutable',
        HINT = 'Preserve the row and use a reviewed compensating workflow';
  ELSE
    RAISE EXCEPTION
      'Customer wallet cash-out ledger writes are retired'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'Transaction_customer_wallet_cash_out_retired',
        HINT = 'Use the reviewed return-to-original-payment-method workflow';
  END IF;
END;
$$;

CREATE TRIGGER "Transaction_customer_wallet_cash_out_retired_guard"
BEFORE INSERT OR UPDATE ON "Transaction"
FOR EACH ROW
WHEN (
  NEW."type" = 'WITHDRAWAL'
  AND NEW."walletId" IS NOT NULL
)
EXECUTE FUNCTION "guard_customer_wallet_cash_out_retirement"();

CREATE TRIGGER "Transaction_customer_wallet_cash_out_evidence_guard"
BEFORE UPDATE OR DELETE ON "Transaction"
FOR EACH ROW
WHEN (
  OLD."type" = 'WITHDRAWAL'
  AND OLD."walletId" IS NOT NULL
)
EXECUTE FUNCTION "guard_customer_wallet_cash_out_retirement"();

COMMIT;
