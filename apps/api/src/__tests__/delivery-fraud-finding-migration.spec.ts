import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationPath = path.join(
  repoRoot,
  "packages/database/prisma/migrations/20260815120000_delivery_fraud_findings/migration.sql",
)

describe("confirmed delivery-fraud finding migration contract", () => {
  const sql = fs.readFileSync(migrationPath, "utf8")

  function extractGuard(functionName: string): string {
    const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = sql.match(
      new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION public\\."${escapedName}"\\(\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\n\\$\\$;`,
      ),
    )

    expect(match).not.toBeNull()
    return match?.[1] ?? ""
  }

  function extractFunctionHeader(functionName: string): string {
    const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = sql.match(
      new RegExp(
        `CREATE(?: OR REPLACE)? FUNCTION public\\."${escapedName}"\\(\\)([\\s\\S]*?)AS \\$\\$`,
      ),
    )

    expect(match).not.toBeNull()
    return match?.[1] ?? ""
  }

  it("stores bounded, identity-bound, idempotent append-only evidence", () => {
    expect(sql).toContain(
      'CREATE TYPE public."DeliveryFraudFindingOutcome" AS ENUM',
    )
    expect(sql).toContain("'CONFIRMED_FRAUD'")
    expect(sql).toContain('"internalReason" VARCHAR(1000) NOT NULL')
    expect(sql).toMatch(
      /"internalReason" = btrim\("internalReason"\)[\s\S]*BETWEEN 20 AND 1000/,
    )
    expect(sql).toContain('"idempotencyKey" UUID NOT NULL')
    expect(sql).toContain('"requestFingerprint" CHAR(64) NOT NULL')
    expect(sql).toContain('"cancellationRequestId" TEXT NOT NULL')
    expect(sql).toMatch(/\^\[0-9a-f\]\{64\}\$/)
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "DeliveryFraudFinding_fraudFlagId_key"',
    )
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "DeliveryFraudFinding_decidedByUserId_idempotencyKey_key"',
    )
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "OrderCancellationRequest_refundTransactionId_key"',
    )
    expect(sql).toContain(
      "a refund transaction cannot be linked to more than one cancellation request",
    )
    expect(sql).toMatch(
      /FOREIGN KEY \("fraudFlagId"\) REFERENCES public\."DeliveryFraudFlag"\("id"\)[\s\S]*ON DELETE RESTRICT/,
    )
    expect(sql).toMatch(
      /FOREIGN KEY \("cancellationRequestId"\) REFERENCES public\."OrderCancellationRequest"\("id"\)[\s\S]*ON DELETE RESTRICT/,
    )
  })

  it("requires and locks a same-order, nonterminal cancellation handoff", () => {
    const findingGuard = extractGuard("guard_delivery_fraud_finding")
    const handoffLockAt = findingGuard.indexOf(
      'FROM public."OrderCancellationRequest" AS cancellation_request',
    )
    const authorityLockAt = findingGuard.indexOf(
      'FROM public."StaffMembership" AS membership',
    )

    expect(sql).toContain('public."OrderCancellationRequest",')
    expect(handoffLockAt).toBeGreaterThanOrEqual(0)
    expect(findingGuard).toContain(
      'cancellation_request."id" = NEW."cancellationRequestId"',
    )
    expect(findingGuard).toContain(
      'cancellation_request."orderId" = NEW."orderId"',
    )
    expect(findingGuard).toContain("FOR SHARE OF cancellation_request")
    expect(findingGuard).toContain(
      "cancellation_request_status NOT IN (\n    'UNDER_REVIEW',\n    'PENDING_FINANCE',\n    'ESCALATED'",
    )
    expect(findingGuard).toContain(
      "cancellation_request_status = 'PENDING_FINANCE'",
    )
    expect(findingGuard).toContain(
      "cancellation_request_resolution IS DISTINCT FROM 'FULL_REFUND'",
    )
    expect(findingGuard).toContain(
      "cancellation_request_responsibility = 'UNDETERMINED'",
    )
    expect(findingGuard).toContain(
      "confirmed fraud requires a complete pending Finance full-refund review",
    )
    expect(handoffLockAt).toBeLessThan(authorityLockAt)
  })

  it("keeps a linked cancellation on the full-refund path through canonical Finance approval", () => {
    const handoffGuard = extractGuard(
      "guard_confirmed_fraud_cancellation_handoff",
    )
    const orderLockAt = handoffGuard.indexOf('FROM public."Order" AS order_row')
    const findingCheckAt = handoffGuard.indexOf(
      'FROM public."DeliveryFraudFinding" AS finding',
    )
    const refundLockAt = handoffGuard.indexOf(
      'FROM public."Transaction" AS refund',
    )

    expect(sql).toMatch(
      /CREATE TRIGGER "OrderCancellationRequest_confirmed_fraud_guard"[\s\S]*BEFORE UPDATE OR DELETE ON public\."OrderCancellationRequest"/,
    )
    expect(sql).toMatch(
      /CREATE TRIGGER "OrderCancellationRequest_confirmed_fraud_truncate_guard"[\s\S]*BEFORE TRUNCATE ON public\."OrderCancellationRequest"/,
    )
    expect(handoffGuard).toContain('finding."cancellationRequestId" = OLD."id"')
    expect(handoffGuard).toContain("FOR UPDATE OF order_row")
    expect(orderLockAt).toBeGreaterThanOrEqual(0)
    expect(findingCheckAt).toBeGreaterThan(orderLockAt)
    expect(handoffGuard).toContain(
      "NEW.\"status\" NOT IN ('ESCALATED', 'PENDING_FINANCE')",
    )
    expect(handoffGuard).toContain(
      "NEW.\"status\" NOT IN ('PENDING_FINANCE', 'APPROVED')",
    )
    expect(handoffGuard).not.toContain("'REJECTED', 'DISPUTED'")
    expect(handoffGuard).toContain(
      "NEW.\"resolution\" IS DISTINCT FROM 'FULL_REFUND'",
    )
    expect(handoffGuard).toContain(
      "membership.\"role\" IN ('FINANCE', 'SUPER_ADMIN')",
    )
    expect(handoffGuard).toContain("refund.\"type\" = 'REFUND'")
    expect(handoffGuard).toContain('refund."amount" = locked_order_amount')
    expect(handoffGuard).toContain("FOR SHARE OF refund")
    expect(refundLockAt).toBeGreaterThan(orderLockAt)
    expect(handoffGuard).toContain(
      'IS DISTINCT FROM NEW."responsibility"::TEXT',
    )
    expect(handoffGuard).toContain("ELSIF OLD.\"status\" = 'APPROVED' THEN")
    expect(handoffGuard).toContain(
      "approved confirmed fraud cancellation evidence is append-only",
    )
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public."guard_confirmed_fraud_cancellation_handoff"() FROM PUBLIC',
    )
  })

  it("defers confirmed-fraud terminal validation until the complete Finance transaction commits", () => {
    const terminalGuard = extractGuard(
      "assert_confirmed_fraud_terminal_outcome",
    )

    expect(sql).toContain("current_amount NUMERIC;")
    expect(sql).not.toContain("current_amount NUMERIC(19, 4);")
    expect(sql).toMatch(
      /CREATE CONSTRAINT TRIGGER "Order_confirmed_fraud_terminal_outcome_guard"[\s\S]*AFTER INSERT OR UPDATE ON public\."Order"[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
    )
    expect(terminalGuard).toContain('FROM public."Order" AS order_row')
    expect(terminalGuard).toContain(
      "current_status IS DISTINCT FROM 'REFUNDED'",
    )
    expect(terminalGuard).toContain(
      "current_payment_status IS DISTINCT FROM 'REFUNDED'",
    )
    expect(terminalGuard).toContain(
      "cancellation_request.\"status\" IS DISTINCT FROM 'APPROVED'",
    )
    expect(terminalGuard).toContain(
      "cancellation_request.\"resolution\" IS DISTINCT FROM 'FULL_REFUND'",
    )
    expect(terminalGuard).toContain(
      'refund."amount" IS DISTINCT FROM current_amount',
    )
    expect(terminalGuard).toContain(
      'refund."currency" IS DISTINCT FROM current_currency',
    )
    expect(terminalGuard).toContain(
      "IS DISTINCT FROM current_refund_responsibility",
    )
    expect(terminalGuard).toContain(
      "current_status IN ('CANCELLED', 'REFUNDED', 'COMPLETED')",
    )
    expect(terminalGuard).toContain(
      "confirmed fraud refund requires its exact linked approved Finance evidence",
    )
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public."assert_confirmed_fraud_terminal_outcome"() FROM PUBLIC',
    )
  })

  it("pins and freezes the canonical refund transaction evidence", () => {
    const refundGuard = extractGuard("guard_confirmed_fraud_refund_transaction")
    const orderLockAt = refundGuard.indexOf('FROM public."Order" AS order_row')
    const approvedLinkCheckAt = refundGuard.indexOf(
      'FROM public."OrderCancellationRequest" AS cancellation_request',
      orderLockAt,
    )

    expect(sql).toContain(
      'CONSTRAINT "OrderCancellationRequest_refundTransactionId_fkey"',
    )
    expect(sql).toMatch(
      /FOREIGN KEY \("refundTransactionId"\) REFERENCES public\."Transaction"\("id"\)[\s\S]*ON DELETE RESTRICT ON UPDATE RESTRICT/,
    )
    expect(sql).toContain(
      "cancellation refund evidence contains an orphan transaction reference",
    )
    expect(refundGuard).toContain(
      'finding."cancellationRequestId" = cancellation_request."id"',
    )
    expect(refundGuard).toContain(
      'cancellation_request."refundTransactionId" = OLD."id"',
    )
    expect(refundGuard).toContain('ORDER BY order_row."id"')
    expect(refundGuard).toContain("FOR UPDATE OF order_row")
    expect(orderLockAt).toBeGreaterThanOrEqual(0)
    expect(approvedLinkCheckAt).toBeGreaterThan(orderLockAt)
    expect(refundGuard).toContain(
      "confirmed fraud refund ledger evidence is append-only",
    )
    expect(sql).toMatch(
      /CREATE TRIGGER "Transaction_confirmed_fraud_refund_guard"[\s\S]*BEFORE UPDATE OR DELETE ON public\."Transaction"/,
    )
    expect(sql).toMatch(
      /CREATE TRIGGER "Transaction_confirmed_fraud_refund_truncate_guard"[\s\S]*BEFORE TRUNCATE ON public\."Transaction"/,
    )
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public."guard_confirmed_fraud_refund_transaction"() FROM PUBLIC',
    )
  })

  it("fences first, then rejects stale or mismatched order and delivery facts", () => {
    const findingGuard = extractGuard("guard_delivery_fraud_finding")
    const fenceAt = findingGuard.indexOf('UPDATE public."Order"')
    const resolutionAt = findingGuard.indexOf(
      'FROM public."DeliveryFraudFlagResolution"',
    )

    expect(fenceAt).toBeGreaterThanOrEqual(0)
    expect(findingGuard).toContain(
      'current_order_version IS DISTINCT FROM NEW."expectedOrderVersion"',
    )
    expect(findingGuard).toContain(
      'current_verification_version IS DISTINCT FROM NEW."expectedVerificationVersion"',
    )
    expect(findingGuard).toContain('delivery."orderId" = NEW."orderId"')
    expect(findingGuard).not.toContain("active_delivery_version_id")
    expect(findingGuard).not.toContain('delivery."supersededByVersion" IS NULL')
    expect(resolutionAt).toBeGreaterThan(fenceAt)
  })

  it("rejects new findings after an unrelated terminal order outcome", () => {
    const findingGuard = extractGuard("guard_delivery_fraud_finding")

    expect(findingGuard).toContain(
      'RETURNING order_row."version", order_row."status"::TEXT',
    )
    expect(findingGuard).toContain(
      "current_order_status IN ('CANCELLED', 'REFUNDED', 'COMPLETED')",
    )
    expect(findingGuard).toContain(
      "confirmed fraud cannot be created after a terminal order outcome",
    )
  })

  it("requires the exact current hold and deliberately retains it", () => {
    const findingGuard = extractGuard("guard_delivery_fraud_finding")

    expect(findingGuard).toMatch(
      /FROM public\."DeliveryFraudHold" AS hold[\s\S]*hold\."fraudFlagId" = NEW\."fraudFlagId"[\s\S]*hold\."orderId" = NEW\."orderId"[\s\S]*hold\."deliveryVersionId" = NEW\."deliveryVersionId"[\s\S]*hold\."type" = flag_type[\s\S]*hold\."createdAt" = flag_created_at/,
    )
    expect(findingGuard).not.toMatch(/DELETE FROM public\."DeliveryFraudHold"/)
    expect(sql).toMatch(
      /CREATE TRIGGER "DeliveryFraudFinding_guard"[\s\S]*BEFORE INSERT OR UPDATE OR DELETE/,
    )
    expect(sql).toMatch(
      /CREATE TRIGGER "DeliveryFraudFinding_truncate_guard"[\s\S]*BEFORE TRUNCATE/,
    )
  })

  it("authorizes only a locked, live Operations or Super Admin identity", () => {
    const findingGuard = extractGuard("guard_delivery_fraud_finding")

    expect(findingGuard).toContain('membership."role" = NEW."decidedByRole"')
    expect(findingGuard).toContain(
      "membership.\"role\" IN ('OPERATIONS', 'SUPER_ADMIN')",
    )
    expect(findingGuard).not.toContain(
      "membership.\"role\" IN ('OPERATIONS', 'SUPER_ADMIN', 'FINANCE')",
    )
    expect(findingGuard).toContain("decider.\"userType\" = 'STAFF'")
    expect(findingGuard).toContain('NOT decider."banned"')
    expect(findingGuard).toContain("FOR SHARE OF membership, decider")
  })

  it("pins trigger lookup and exposes no default PUBLIC write surface", () => {
    const findingHeader = extractFunctionHeader("guard_delivery_fraud_finding")
    const resolutionHeader = extractFunctionHeader(
      "guard_delivery_fraud_resolution",
    )
    const handoffHeader = extractFunctionHeader(
      "guard_confirmed_fraud_cancellation_handoff",
    )
    const terminalHeader = extractFunctionHeader(
      "assert_confirmed_fraud_terminal_outcome",
    )
    const refundHeader = extractFunctionHeader(
      "guard_confirmed_fraud_refund_transaction",
    )
    expect(findingHeader).toContain("SECURITY INVOKER")
    expect(findingHeader).toContain(
      "SET search_path = pg_catalog, public, pg_temp",
    )
    expect(resolutionHeader).toContain("SECURITY INVOKER")
    expect(resolutionHeader).toContain(
      "SET search_path = pg_catalog, public, pg_temp",
    )
    expect(handoffHeader).toContain("SET search_path = pg_catalog")
    expect(terminalHeader).toContain("SET search_path = pg_catalog")
    expect(refundHeader).toContain("SET search_path = pg_catalog")
    expect(sql).toContain(
      'REVOKE ALL ON TABLE public."DeliveryFraudFinding" FROM PUBLIC',
    )
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public."guard_delivery_fraud_finding"() FROM PUBLIC',
    )
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public."guard_delivery_fraud_resolution"() FROM PUBLIC',
    )
  })

  it("makes finding and resolution mutually exclusive behind the same fence", () => {
    const findingGuard = extractGuard("guard_delivery_fraud_finding")
    const resolutionGuard = extractGuard("guard_delivery_fraud_resolution")
    const findingFenceAt = findingGuard.indexOf('UPDATE public."Order"')
    const findingResolutionCheckAt = findingGuard.indexOf(
      'FROM public."DeliveryFraudFlagResolution"',
    )
    const resolutionFenceAt = resolutionGuard.indexOf('UPDATE public."Order"')
    const resolutionFindingCheckAt = resolutionGuard.indexOf(
      'FROM public."DeliveryFraudFinding"',
    )
    const resolutionHoldDeleteAt = resolutionGuard.indexOf(
      'DELETE FROM public."DeliveryFraudHold"',
    )

    expect(findingResolutionCheckAt).toBeGreaterThan(findingFenceAt)
    expect(resolutionFindingCheckAt).toBeGreaterThan(resolutionFenceAt)
    expect(resolutionHoldDeleteAt).toBeGreaterThan(resolutionFindingCheckAt)
    expect(resolutionGuard).toContain("NEW.\"kind\" = 'LINK_RESTORED'")
    expect(resolutionGuard).toContain(
      "membership.\"role\" IN ('SUPER_ADMIN', 'OPERATIONS', 'FINANCE')",
    )
  })

  it("locks and revalidates staff clearance authority before releasing the hold", () => {
    const resolutionGuard = extractGuard("guard_delivery_fraud_resolution")
    const authorityLockAt = resolutionGuard.indexOf(
      'FROM public."StaffMembership" AS membership',
    )
    const holdDeleteAt = resolutionGuard.indexOf(
      'DELETE FROM public."DeliveryFraudHold"',
    )

    expect(authorityLockAt).toBeGreaterThanOrEqual(0)
    expect(resolutionGuard).toContain(
      'membership."role" = NEW."resolvedByRole"',
    )
    expect(resolutionGuard).toContain("resolver.\"userType\" = 'STAFF'")
    expect(resolutionGuard).toContain('NOT resolver."banned"')
    expect(resolutionGuard).toContain("FOR SHARE OF membership, resolver")
    expect(holdDeleteAt).toBeGreaterThan(authorityLockAt)
  })
})
