// Shared validators reused across multiple brief schemas. Kept here so the
// per-service files only encode what makes that service unique.

import { z } from "zod"

// Anchor text: the clickable phrase inserted in the destination article.
// Cap matches the legacy Order.anchorText 200-char column.
export const anchorTextSchema = z
  .string()
  .trim()
  .min(1, "Anchor text is required")
  .max(200, "Anchor text must be 200 characters or fewer")

// Target URL: the customer's link that the publisher will point to.
// `.url()` rejects javascript: / data: schemes; Zod uses WHATWG URL parsing.
export const targetUrlSchema = z
  .string()
  .trim()
  .url("Target URL must be a valid http(s) URL")
  .max(2048, "Target URL must be 2048 characters or fewer")
  .refine(
    (v) => v.startsWith("http://") || v.startsWith("https://"),
    "Target URL must use http or https",
  )

// Free-text "anything else the publisher should know" — capped at the same
// 5000-char limit the legacy Order.instructions column enforced. Optional.
export const notesSchema = z
  .string()
  .trim()
  .max(5000, "Notes must be 5000 characters or fewer")
  .optional()

// Comma-or-newline separated keywords are accepted in the UI but the schema
// stores a clean string array. Cap each keyword at 80 chars; cap list at 20.
export const targetKeywordsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "Keyword cannot be empty")
      .max(80, "Each keyword must be 80 characters or fewer"),
  )
  .max(20, "Up to 20 target keywords")
  .optional()

// Word count: positive integer with sane upper bound to reject typos
// (e.g. "100000000" → reject).
export const wordCountSchema = z
  .number()
  .int("Word count must be a whole number")
  .min(50, "Word count must be at least 50")
  .max(20000, "Word count must be 20000 or fewer")
  .optional()

// Sanitized free-text field for any "topic" / "context" prompt. The brief is
// rendered server-side as JSON, so we don't need HTML stripping — just a
// length cap and trim.
export function makeText(
  name: string,
  opts: { min?: number; max?: number; required?: boolean } = {},
) {
  const { min = 1, max = 1000, required = true } = opts
  const base = z
    .string()
    .trim()
    .min(min, `${name} must be at least ${min} characters`)
    .max(max, `${name} must be ${max} characters or fewer`)
  return required ? base : base.optional()
}
