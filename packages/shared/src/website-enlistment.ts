export type WebsiteEnlistmentField =
  | "url"
  | "name"
  | "country"
  | "listingTitle"
  | "description"

export interface WebsiteEnlistmentIssue {
  field: WebsiteEnlistmentField
  code:
    | "INVALID_WEBSITE_URL"
    | "INVALID_LISTING_TITLE"
    | "LISTING_TITLE_IS_WEBSITE_URL"
    | "INVALID_LISTING_DESCRIPTION"
    | "INVALID_WEBSITE_METADATA"
  message: string
}

export const WEBSITE_URL_REQUIREMENTS =
  "Enter the public homepage URL using http:// or https://, without a path, query, login, or custom port."

export const LISTING_TITLE_URL_WARNING =
  "Use a descriptive marketplace title—not the website URL or domain. URL titles are rejected."

const HTML_TAG = /<\/?[a-z][^>]*>/i
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const SINGLE_LINE_CONTROL_CHARACTERS = /[\t\r\n]/
const IPV4_ADDRESS = /^(?:\d{1,3}\.){3}\d{1,3}$/
const DNS_HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/i

export function hasUnsafeMarketplaceText(
  value: string,
  options: { singleLine?: boolean } = {},
) {
  return (
    HTML_TAG.test(value) ||
    UNSAFE_CONTROL_CHARACTERS.test(value) ||
    (options.singleLine === true && SINGLE_LINE_CONTROL_CHARACTERS.test(value))
  )
}

export function validateWebsiteOrigin(
  value: string,
): WebsiteEnlistmentIssue | null {
  const input = typeof value === "string" ? value.trim() : ""
  if (input.length === 0 || input.length > 2048) {
    return {
      field: "url",
      code: "INVALID_WEBSITE_URL",
      message: WEBSITE_URL_REQUIREMENTS,
    }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return {
      field: "url",
      code: "INVALID_WEBSITE_URL",
      message: WEBSITE_URL_REQUIREMENTS,
    }
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  const hasPublicHostname =
    DNS_HOSTNAME.test(hostname) &&
    !IPV4_ADDRESS.test(hostname) &&
    !hostname.includes(":") &&
    hostname !== "localhost"
  const isRootPath = url.pathname === "" || url.pathname === "/"

  if (
    !["http:", "https:"].includes(url.protocol) ||
    !hasPublicHostname ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    !isRootPath ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return {
      field: "url",
      code: "INVALID_WEBSITE_URL",
      message: WEBSITE_URL_REQUIREMENTS,
    }
  }

  return null
}

export function isWebsiteAddressListingTitle(value: string) {
  const title = value.trim()
  if (title.length === 0 || /\s/.test(title)) return false

  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(title) ? title : `https://${title}`,
    )
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "")
    return hostname.includes(".")
  } catch {
    return false
  }
}

export function validateWebsiteEnlistmentInput(input: {
  url: string
  name?: string
  country?: string
  listingTitle: string
  description: string
}): WebsiteEnlistmentIssue[] {
  const issues: WebsiteEnlistmentIssue[] = []
  const urlIssue = validateWebsiteOrigin(input.url)
  if (urlIssue) issues.push(urlIssue)

  for (const field of ["name", "country"] as const) {
    const value = input[field]?.trim()
    if (
      value &&
      (value.length > 100 ||
        hasUnsafeMarketplaceText(value, { singleLine: true }))
    ) {
      issues.push({
        field,
        code: "INVALID_WEBSITE_METADATA",
        message:
          "Use 100 characters or fewer without HTML or control characters.",
      })
    }
  }

  const title =
    typeof input.listingTitle === "string" ? input.listingTitle.trim() : ""
  if (
    title.length < 3 ||
    title.length > 200 ||
    hasUnsafeMarketplaceText(title, { singleLine: true })
  ) {
    issues.push({
      field: "listingTitle",
      code: "INVALID_LISTING_TITLE",
      message:
        "Enter a descriptive title between 3 and 200 characters without HTML or control characters.",
    })
  } else if (isWebsiteAddressListingTitle(title)) {
    issues.push({
      field: "listingTitle",
      code: "LISTING_TITLE_IS_WEBSITE_URL",
      message: LISTING_TITLE_URL_WARNING,
    })
  }

  const description =
    typeof input.description === "string" ? input.description.trim() : ""
  if (
    description.length < 20 ||
    description.length > 500 ||
    hasUnsafeMarketplaceText(description)
  ) {
    issues.push({
      field: "description",
      code: "INVALID_LISTING_DESCRIPTION",
      message:
        "Describe the audience and editorial standards in 20–500 characters without HTML or control characters.",
    })
  }

  return issues
}
