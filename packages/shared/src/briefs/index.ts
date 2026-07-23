// Per-`ServiceType` brief Zod registry. Orders snapshot a parsed object onto
// Order.briefData at creation; later listing edits never alter the in-flight
// brief contract. The portal renders one form per serviceType from the same
// shape so client + server agree on field names.
//
// Field design principles for each schema:
//   - Required = the publisher genuinely cannot start without it.
//   - Optional = the publisher CAN start, but the customer is encouraged to
//     fill it in to reduce back-and-forth.
//   - `notes` is universal — every brief has one for the customer to leave
//     anything unstructured.
//   - All strings are .trim()'d and bounded.
//
// `validateBrief()` is the single entry point — never construct a brief
// payload by hand. Throws ZodError on failure; the API translates that to
// 400 with the issue path so the client can scroll to the offending field.

import { z } from "zod"
import {
  anchorTextSchema,
  makeText,
  notesSchema,
  targetKeywordsSchema,
  targetUrlSchema,
  wordCountSchema,
} from "./common"

export type { BriefFieldSpec, BriefFieldWidget } from "./fields"
export { BRIEF_FIELDS } from "./fields"

// ── GUEST_POST — a fresh article published on the publisher site with one
// or more links back to the customer's target URL.
const guestPostBriefSchema = z
  .object({
    kind: z.literal("GUEST_POST"),
    title: makeText("Title", { min: 5, max: 200 }),
    topic: makeText("Topic", { min: 10, max: 500 }),
    targetUrl: targetUrlSchema,
    anchorText: anchorTextSchema,
    targetKeywords: targetKeywordsSchema,
    wordCount: wordCountSchema,
    requireAuthorBio: z.boolean().optional(),
    niche: makeText("Niche", { min: 2, max: 80, required: false }),
    notes: notesSchema,
  })
  .strict()

// ── NICHE_EDIT — the publisher inserts the customer's link into an
// existing live article on their site. The existing URL is mandatory.
const nicheEditBriefSchema = z
  .object({
    kind: z.literal("NICHE_EDIT"),
    existingArticleUrl: targetUrlSchema,
    targetUrl: targetUrlSchema,
    anchorText: anchorTextSchema,
    placementContext: makeText("Placement context", {
      min: 1,
      max: 1000,
      required: false,
    }),
    notes: notesSchema,
  })
  .strict()

// ── EDITORIAL_LINK — an editorially placed contextual link, usually with
// a thesis/relevance pitch attached so the publisher can justify it.
const editorialLinkBriefSchema = z
  .object({
    kind: z.literal("EDITORIAL_LINK"),
    targetUrl: targetUrlSchema,
    anchorText: anchorTextSchema,
    topicalRelevance: makeText("Topical relevance", { min: 10, max: 1000 }),
    preferredPlacement: makeText("Preferred placement", {
      min: 1,
      max: 500,
      required: false,
    }),
    notes: notesSchema,
  })
  .strict()

// ── OUTREACH_LINK — campaign-style placement on third-party sites the
// publisher pitches; suggestedDomains hints which targets the customer
// pre-vetted (entirely optional).
const outreachLinkBriefSchema = z
  .object({
    kind: z.literal("OUTREACH_LINK"),
    targetUrl: targetUrlSchema,
    anchorText: anchorTextSchema,
    suggestedDomains: z
      .array(z.string().trim().min(1).max(253))
      .max(50, "Up to 50 suggested domains")
      .optional(),
    pitchAngle: makeText("Pitch angle", { min: 1, max: 1000, required: false }),
    notes: notesSchema,
  })
  .strict()

// ── LOCAL_CITATION — NAP (Name/Address/Phone) submitted to local directory
// sites. Address is structured to maximize directory acceptance rates.
const localCitationBriefSchema = z
  .object({
    kind: z.literal("LOCAL_CITATION"),
    businessName: makeText("Business name", { min: 2, max: 200 }),
    address: z.object({
      street: makeText("Street", { min: 1, max: 200 }),
      city: makeText("City", { min: 1, max: 100 }),
      region: makeText("State / region", { min: 1, max: 100 }),
      postalCode: makeText("Postal code", { min: 1, max: 20 }),
      country: makeText("Country", { min: 2, max: 80 }),
    }),
    phone: makeText("Phone", { min: 4, max: 40 }),
    website: targetUrlSchema.optional(),
    categoryHint: makeText("Business category", {
      min: 1,
      max: 120,
      required: false,
    }),
    hours: makeText("Hours of operation", {
      min: 1,
      max: 500,
      required: false,
    }),
    notes: notesSchema,
  })
  .strict()

// ── FOUNDATION_LINK — profile / Web 2.0 / forum-style backlinks; the
// platforms array hints which networks to target.
const foundationLinkBriefSchema = z
  .object({
    kind: z.literal("FOUNDATION_LINK"),
    targetUrl: targetUrlSchema,
    anchorText: anchorTextSchema,
    platforms: z
      .array(makeText("Platform", { min: 1, max: 60 }))
      .max(20, "Up to 20 platforms")
      .optional(),
    profileBio: makeText("Profile bio", { min: 1, max: 2000, required: false }),
    notes: notesSchema,
  })
  .strict()

// ── BLOG_ARTICLE — pure content delivery (no placement). No target URL,
// because the customer is buying writing, not a backlink.
const blogArticleBriefSchema = z
  .object({
    kind: z.literal("BLOG_ARTICLE"),
    topic: makeText("Topic", { min: 10, max: 500 }),
    wordCount: wordCountSchema.unwrap(), // promote to required here
    targetKeywords: targetKeywordsSchema,
    references: z
      .array(targetUrlSchema)
      .max(20, "Up to 20 references")
      .optional(),
    tone: z
      .enum(["NEUTRAL", "FORMAL", "CASUAL", "TECHNICAL", "FRIENDLY"])
      .optional(),
    notes: notesSchema,
  })
  .strict()

// ── SEO_CONTENT — SEO-optimized writing of various shapes. contentType
// drives different downstream templating.
const seoContentBriefSchema = z
  .object({
    kind: z.literal("SEO_CONTENT"),
    contentType: z.enum(["ARTICLE", "LANDING_PAGE", "PRODUCT", "COMPARISON"]),
    topic: makeText("Topic", { min: 10, max: 500 }),
    wordCount: wordCountSchema.unwrap(),
    targetKeywords: targetKeywordsSchema,
    internalLinks: z
      .array(targetUrlSchema)
      .max(20, "Up to 20 internal links")
      .optional(),
    notes: notesSchema,
  })
  .strict()

// Discriminated union on `kind`. ServiceType values that don't fit any of
// the discriminated members fail at the validateBrief layer below — there
// is no permissive catch-all, by design.
export const briefSchemas = {
  GUEST_POST: guestPostBriefSchema,
  NICHE_EDIT: nicheEditBriefSchema,
  EDITORIAL_LINK: editorialLinkBriefSchema,
  OUTREACH_LINK: outreachLinkBriefSchema,
  LOCAL_CITATION: localCitationBriefSchema,
  FOUNDATION_LINK: foundationLinkBriefSchema,
  BLOG_ARTICLE: blogArticleBriefSchema,
  SEO_CONTENT: seoContentBriefSchema,
} as const

// String literal type matching the Prisma ServiceType enum at the wire
// level (Prisma enums and TS enums don't share a type, so we don't import
// from @guestpost/database here to keep packages/shared free of DB deps).
export type ServiceTypeKey = keyof typeof briefSchemas

export type BriefData = {
  [K in ServiceTypeKey]: z.infer<(typeof briefSchemas)[K]>
}[ServiceTypeKey]

export class UnknownServiceTypeError extends Error {
  constructor(received: string) {
    super(`No brief schema registered for serviceType=${received}`)
    this.name = "UnknownServiceTypeError"
  }
}

// Single entry point. Validates that:
//   1. serviceType is a registered key.
//   2. The payload matches the registered Zod schema for that key.
//   3. The payload's `kind` discriminator matches serviceType (the schema
//      already enforces this via z.literal, but we also assert here so
//      callers who forget to set `kind` get a friendly error).
export function validateBrief(serviceType: string, data: unknown): BriefData {
  const schema = briefSchemas[serviceType as ServiceTypeKey]
  if (!schema) throw new UnknownServiceTypeError(serviceType)
  // Some callers send the payload without the `kind` field set — inject it
  // before validation so the discriminated literal passes.
  const withKind =
    data && typeof data === "object"
      ? { kind: serviceType, ...(data as Record<string, unknown>) }
      : data
  return schema.parse(withKind) as BriefData
}
export * from "./keywords"
