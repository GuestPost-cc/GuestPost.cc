import {
  assertFinanceOperationAllowed,
  FINANCE_OPERATION_KINDS,
  FinanceRuntimeModeError,
  isFinanceOperationAllowed,
  resolveFinanceRuntimeMode,
} from "../finance-runtime-mode"

describe("finance runtime mode", () => {
  it("requires an explicit valid mode in production", () => {
    expect(resolveFinanceRuntimeMode(undefined, "production")).toEqual({
      mode: "locked",
      configured: false,
      valid: false,
    })
    expect(resolveFinanceRuntimeMode("unexpected", "production")).toEqual({
      mode: "locked",
      configured: true,
      valid: false,
    })
    expect(resolveFinanceRuntimeMode(undefined, "test").mode).toBe("normal")
  })

  it.each([
    ["normal", FINANCE_OPERATION_KINDS],
    [
      "recovery_only",
      ["read", "inbound_evidence", "recovery", "reconciliation"],
    ],
    ["locked", ["read", "inbound_evidence"]],
  ] as const)("enforces the %s operation matrix", (mode, allowed) => {
    for (const operation of FINANCE_OPERATION_KINDS) {
      expect(isFinanceOperationAllowed(mode, operation)).toBe(
        allowed.includes(operation as never),
      )
    }
  })

  it("throws a stable non-sensitive error when an operation is blocked", () => {
    expect(() =>
      assertFinanceOperationAllowed("external_send", {
        rawMode: "recovery_only",
        nodeEnv: "production",
      }),
    ).toThrow(
      expect.objectContaining<Partial<FinanceRuntimeModeError>>({
        name: "FinanceRuntimeModeError",
        code: "FINANCE_OPERATION_BLOCKED",
        mode: "recovery_only",
        operation: "external_send",
      }),
    )
  })
})
