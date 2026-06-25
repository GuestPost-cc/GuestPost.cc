// Per-`ServiceType` field metadata for rendering. Both the editor
// (`apps/portal/src/components/BriefForm.tsx`) and the read-mode renderer
// (`packages/ui/src/components/brief-renderer.tsx`) read from this single
// registry so a new field added to a schema is reflected in both surfaces
// without duplicate edits.
//
// The Zod schemas in `./index.ts` are the source of truth for *validation*;
// this file is the source of truth for *presentation* (label, widget kind,
// helper text). The two are kept in lockstep manually — a new field on a
// brief schema should be added here at the same time.

import type { ServiceTypeKey } from "./index"

// Input widget the editor renders. Read-mode renderer uses the same kind
// to pick a formatting strategy (e.g. tags → chips, address → multi-line).
export type BriefFieldWidget =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "select"
  | "tags"
  | "address"

export interface BriefFieldSpec {
  name: string
  label: string
  widget: BriefFieldWidget
  required?: boolean
  placeholder?: string
  helper?: string
  options?: string[]
  minLength?: number
  maxLength?: number
  min?: number
  max?: number
}

export const BRIEF_FIELDS: Record<ServiceTypeKey, BriefFieldSpec[]> = {
  GUEST_POST: [
    {
      name: "title",
      label: "Article title",
      widget: "text",
      required: true,
      minLength: 5,
      maxLength: 200,
    },
    {
      name: "topic",
      label: "Topic / angle",
      widget: "textarea",
      required: true,
      minLength: 10,
      maxLength: 500,
    },
    { name: "targetUrl", label: "Target URL", widget: "url", required: true },
    {
      name: "anchorText",
      label: "Anchor text",
      widget: "text",
      required: true,
      maxLength: 200,
    },
    {
      name: "targetKeywords",
      label: "Target keywords",
      widget: "tags",
      helper: "Comma-separated, up to 20",
    },
    {
      name: "wordCount",
      label: "Word count",
      widget: "number",
      min: 50,
      max: 20000,
    },
    { name: "niche", label: "Niche", widget: "text", maxLength: 80 },
    {
      name: "notes",
      label: "Notes for the publisher",
      widget: "textarea",
      maxLength: 5000,
    },
  ],
  NICHE_EDIT: [
    {
      name: "existingArticleUrl",
      label: "Existing article URL",
      widget: "url",
      required: true,
      helper: "The publisher will insert your link into THIS article.",
    },
    {
      name: "targetUrl",
      label: "Your target URL",
      widget: "url",
      required: true,
    },
    {
      name: "anchorText",
      label: "Anchor text",
      widget: "text",
      required: true,
      maxLength: 200,
    },
    {
      name: "placementContext",
      label: "Placement context",
      widget: "textarea",
      maxLength: 1000,
    },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
  EDITORIAL_LINK: [
    { name: "targetUrl", label: "Target URL", widget: "url", required: true },
    {
      name: "anchorText",
      label: "Anchor text",
      widget: "text",
      required: true,
      maxLength: 200,
    },
    {
      name: "topicalRelevance",
      label: "Topical relevance",
      widget: "textarea",
      required: true,
      minLength: 10,
      maxLength: 1000,
    },
    {
      name: "preferredPlacement",
      label: "Preferred placement",
      widget: "text",
      maxLength: 500,
    },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
  OUTREACH_LINK: [
    { name: "targetUrl", label: "Target URL", widget: "url", required: true },
    {
      name: "anchorText",
      label: "Anchor text",
      widget: "text",
      required: true,
      maxLength: 200,
    },
    {
      name: "suggestedDomains",
      label: "Suggested domains",
      widget: "tags",
      helper: "Comma-separated; up to 50",
    },
    {
      name: "pitchAngle",
      label: "Pitch angle",
      widget: "textarea",
      maxLength: 1000,
    },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
  LOCAL_CITATION: [
    {
      name: "businessName",
      label: "Business name",
      widget: "text",
      required: true,
      minLength: 2,
      maxLength: 200,
    },
    { name: "address", label: "Address", widget: "address", required: true },
    {
      name: "phone",
      label: "Phone",
      widget: "text",
      required: true,
      maxLength: 40,
    },
    { name: "website", label: "Website URL", widget: "url" },
    {
      name: "categoryHint",
      label: "Business category",
      widget: "text",
      maxLength: 120,
    },
    {
      name: "hours",
      label: "Hours of operation",
      widget: "textarea",
      maxLength: 500,
    },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
  FOUNDATION_LINK: [
    { name: "targetUrl", label: "Target URL", widget: "url", required: true },
    {
      name: "anchorText",
      label: "Anchor text",
      widget: "text",
      required: true,
      maxLength: 200,
    },
    {
      name: "platforms",
      label: "Platforms",
      widget: "tags",
      helper: "Up to 20 — e.g. Medium, Tumblr, Quora",
    },
    {
      name: "profileBio",
      label: "Profile bio",
      widget: "textarea",
      maxLength: 2000,
    },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
  BLOG_ARTICLE: [
    {
      name: "topic",
      label: "Topic",
      widget: "textarea",
      required: true,
      minLength: 10,
      maxLength: 500,
    },
    {
      name: "wordCount",
      label: "Word count",
      widget: "number",
      required: true,
      min: 50,
      max: 20000,
    },
    { name: "targetKeywords", label: "Target keywords", widget: "tags" },
    {
      name: "tone",
      label: "Tone",
      widget: "select",
      options: ["NEUTRAL", "FORMAL", "CASUAL", "TECHNICAL", "FRIENDLY"],
    },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
  SEO_CONTENT: [
    {
      name: "contentType",
      label: "Content type",
      widget: "select",
      required: true,
      options: ["ARTICLE", "LANDING_PAGE", "PRODUCT", "COMPARISON"],
    },
    {
      name: "topic",
      label: "Topic",
      widget: "textarea",
      required: true,
      minLength: 10,
      maxLength: 500,
    },
    {
      name: "wordCount",
      label: "Word count",
      widget: "number",
      required: true,
      min: 50,
      max: 20000,
    },
    { name: "targetKeywords", label: "Target keywords", widget: "tags" },
    { name: "notes", label: "Notes", widget: "textarea", maxLength: 5000 },
  ],
}
