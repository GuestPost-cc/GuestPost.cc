import { randomBytes } from "node:crypto"
import { normalizeFinancialReference } from "./financial-reference"

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

export type FinancialReferenceKind = "DP" | "WD" | "OR"

export function createFinancialReference(
  kind: FinancialReferenceKind,
  size = 8,
): string {
  const bytes = randomBytes(size)
  let token = ""
  for (const byte of bytes) token += ALPHABET[byte % ALPHABET.length]
  return normalizeFinancialReference(`GP-${kind}-${token}`, 32)
}
