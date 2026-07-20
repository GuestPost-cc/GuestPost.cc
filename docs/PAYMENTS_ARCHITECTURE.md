# Payments and payouts architecture

## Non-negotiable ownership rule

Stripe and future providers move money. GuestPost's internal ledger determines
who owns it. A provider success response is evidence for a narrowly defined
state transition; it is never a replacement balance.

```text
Customer card
  -> DepositAttempt
  -> verified provider event
  -> DEPOSIT transaction + wallet credit (one database transaction)
  -> wallet purchase
  -> order/settlement
  -> publisher withdrawable balance
  -> Withdrawal + source allocations
  -> PayoutExecution
  -> provider bank confirmation
```

## Customer deposits

`DepositAttempt` is provider-neutral. It stores the customer method (`card`),
provider (`stripe`), public reference, gross amount, wallet credit, customer
fee, currency, idempotency key, external IDs, state, and the single ledger
transaction that credited the wallet.

The Stripe adapter may create/retrieve Checkout objects and verify Stripe
signatures. It cannot update `Wallet` or create a `Transaction`. `BillingService`
does that only after confirming all of the following from Stripe's server-side
object:

- mode matches the configured test/live key;
- payment is complete;
- currency, amount, wallet, and deposit-attempt metadata match server state;
- the provider event and deposit are not already processed;
- the wallet balance update and ledger row commit together.

The success page polls an authenticated endpoint by opaque public reference.
Its return URL carries no Stripe session identifier. It does not receive
internal wallet or transaction identifiers and cannot cause a credit.

Every public money-creation request requires a client idempotency key. Reusing
one with a different amount, currency, method, or destination fails with a
conflict instead of silently returning an unrelated financial object.

Chargebacks use the existing immediate wallet hold, shortfall alert, and
won/lost resolution flow. The related deposit state is also marked disputed or
charged back.

## Publisher recipients and methods

`PublisherProviderAccount` records provider onboarding state. A
`PayoutMethod` points to it and is the customer-visible destination choice.
For Stripe the saved method contains no raw bank credentials. Stripe-hosted
Express onboarding owns KYC and bank collection.

An account is usable only when all gates are true:

- details submitted;
- Transfers capability active;
- payouts enabled;
- GuestPost manual payout schedule configured;
- local account status `ENABLED`;
- account default currency is USD (the only currency supported in this phase).

Manual scheduling is intentional. It lets one GuestPost withdrawal map to one
Stripe Payout and one statement reference instead of relying on Stripe's
automatic batched payout schedule.

## Withdrawal traceability

Each new withdrawal receives a reference such as `GP-WD-...`, fee-policy
snapshot, gross amount, fee, net amount, and currency. Its source allocations
consume, FIFO:

1. an honest carry-forward bucket for balances that existed at migration;
2. exact post-cutover `SETTLEMENT_RELEASE` transactions, net of debt repayment.

Allocations retain settlement, order, and service type. Rejected or safely
reversed withdrawals release allocations without deleting their history.

## Stripe Connect execution states

| Local stage | Meaning | May complete withdrawal? |
|---|---|---|
| `CREATED` | No provider evidence yet | No |
| `TRANSFER_CREATED` | Transfer accepted; API is actively starting bank stage | No |
| `TRANSFER_RECOVERY_REQUIRED` | Transfer exists; resume bank stage with original idempotency key | No |
| `BANK_PAYOUT_CREATED` | Payout accepted; local finalization is not yet confirmed | No |
| `BANK_PAYOUT_PENDING` | Local state finalized; bank payout pending/in transit | No |
| `BANK_PAYOUT_RECOVERY_REQUIRED` | Payout failed/uncertain after transfer | No |
| `CANCEL_REQUESTED` | Provider cancellation/reversal is being reconciled | No |
| `CANCELLED_REVERSED` | Payout canceled and Transfer reversed | No |
| `BANK_PAID` | Stripe Payout is `paid` | Yes |

Transfer creation and bank-payout creation use separate stable idempotency keys.
The Transfer ID is persisted before the Payout call. A crash in between can be
resumed without sending another Transfer. Webhooks and status polling match the
Payout ID, and terminal updates use conditional/versioned database writes.
Cancellation is blocked while no provider outcome is recorded or while the API
is handing off between Transfer and Payout. Stale handoffs become explicit
recovery states after 15 minutes; they are never treated as failed funds that
can be restored locally.

## Fee policy and statements

Policy `stripe-initial-v1` promises:

- customer deposit gross = wallet credit;
- publisher withdrawal gross = bank-payout amount;
- customer/publisher fee = USD 0.00;
- Stripe fees are a platform expense.

Customer card statements request `GUESTPOST* WALLET ####`. Publisher bank
statements request compact `GPOST`/withdrawal-reference wording within provider
limits. UI and support material must say “may appear” because banks can replace
or truncate the descriptor.

## Current boundary and future ledger

The current `Transaction`/balance model remains authoritative for this rollout.
Before multi-currency or multiple providers are live at scale, introduce
balanced `FinancialAccount`, `LedgerEntry`, and `LedgerPosting` records plus a
clearing account per provider/currency. Do not mix currencies in one wallet or
publisher balance.
