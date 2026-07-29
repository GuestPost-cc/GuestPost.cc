export const FINANCE_RUNTIME_MODES = [
  "normal",
  "recovery_only",
  "locked",
] as const

export type FinanceRuntimeMode = (typeof FINANCE_RUNTIME_MODES)[number]

export const FINANCE_OPERATION_KINDS = [
  "read",
  "new_liability",
  "operator_decision",
  "external_send",
  "manual_completion",
  "inbound_evidence",
  "recovery",
  "reconciliation",
] as const

export type FinanceOperationKind = (typeof FINANCE_OPERATION_KINDS)[number]

export type FinanceRuntimeModeResolution = {
  mode: FinanceRuntimeMode
  configured: boolean
  valid: boolean
}

/**
 * Production requires an explicit mode. A missing or malformed value becomes
 * `locked`; development and tests default to `normal` for local ergonomics.
 */
export function resolveFinanceRuntimeMode(
  rawMode: string | null | undefined,
  nodeEnv: string | null | undefined,
): FinanceRuntimeModeResolution {
  const normalized = rawMode?.trim().toLowerCase()
  if (
    normalized === "normal" ||
    normalized === "recovery_only" ||
    normalized === "locked"
  ) {
    return { mode: normalized, configured: true, valid: true }
  }
  if (!normalized && nodeEnv !== "production") {
    return { mode: "normal", configured: false, valid: true }
  }
  return {
    mode: "locked",
    configured: Boolean(normalized),
    valid: false,
  }
}

export function isFinanceOperationAllowed(
  mode: FinanceRuntimeMode,
  operation: FinanceOperationKind,
): boolean {
  if (operation === "read" || operation === "inbound_evidence") return true
  if (operation === "reconciliation") return mode !== "locked"
  if (mode === "normal") return true
  if (mode === "recovery_only") return operation === "recovery"
  return false
}

export class FinanceRuntimeModeError extends Error {
  readonly name = "FinanceRuntimeModeError"
  readonly code = "FINANCE_OPERATION_BLOCKED"

  constructor(
    readonly mode: FinanceRuntimeMode,
    readonly operation: FinanceOperationKind,
  ) {
    super(`Finance operation ${operation} is blocked while mode is ${mode}`)
  }
}

export function assertFinanceOperationAllowed(
  operation: FinanceOperationKind,
  input: {
    rawMode?: string | null
    nodeEnv?: string | null
  } = {},
): FinanceRuntimeMode {
  const resolution = resolveFinanceRuntimeMode(
    input.rawMode === undefined
      ? process.env.FINANCE_RUNTIME_MODE
      : input.rawMode,
    input.nodeEnv === undefined ? process.env.NODE_ENV : input.nodeEnv,
  )
  if (!isFinanceOperationAllowed(resolution.mode, operation)) {
    throw new FinanceRuntimeModeError(resolution.mode, operation)
  }
  return resolution.mode
}
