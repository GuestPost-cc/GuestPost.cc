import { readBodyWithCap, safeFetch } from "@guestpost/shared/dist/safe-fetch"

const MAX_PROVIDER_BODY_BYTES = 512 * 1024
const PROVIDER_TIMEOUT_MS = 15_000

export class DomainMetricProviderError extends Error {
  constructor(
    public readonly provider: "AHREFS" | "OPEN_PAGE_RANK",
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "DomainMetricProviderError"
  }
}

type Fetcher = typeof safeFetch

async function readJson(
  provider: "AHREFS" | "OPEN_PAGE_RANK",
  response: Response,
) {
  const body = await readBodyWithCap(response, MAX_PROVIDER_BODY_BYTES)
  if (response.status === 429) {
    throw new DomainMetricProviderError(
      provider,
      "RATE_LIMITED",
      `${provider} rate limit reached`,
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new DomainMetricProviderError(
      provider,
      "AUTHENTICATION_FAILED",
      `${provider} authentication failed`,
    )
  }
  if (!response.ok) {
    throw new DomainMetricProviderError(
      provider,
      "HTTP_ERROR",
      `${provider} returned HTTP ${response.status}`,
    )
  }
  try {
    return JSON.parse(body) as any
  } catch {
    throw new DomainMetricProviderError(
      provider,
      "INVALID_RESPONSE",
      `${provider} returned invalid JSON`,
    )
  }
}

export async function fetchAhrefsDomainRating(
  domain: string,
  apiKey: string,
  fetcher: Fetcher = safeFetch,
): Promise<number> {
  if (!apiKey.trim()) {
    throw new DomainMetricProviderError(
      "AHREFS",
      "NOT_CONFIGURED",
      "Ahrefs API key is not configured",
    )
  }
  const url = new URL("https://api.ahrefs.com/v3/public/domain-rating-free")
  url.searchParams.set("target", domain)
  const response = await fetcher(url.toString(), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  })
  const data = await readJson("AHREFS", response)
  const value = data?.domain_rating?.domain_rating
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new DomainMetricProviderError(
      "AHREFS",
      "INVALID_RESPONSE",
      "Ahrefs response did not contain a valid Domain Rating",
    )
  }
  return value
}

export type OpenPageRankResult = {
  domain: string
  found: boolean
  openPageRank: number | null
  globalRank: number | null
  referringDomains: number | null
  asOf: Date
}

export async function fetchOpenPageRanks(
  domains: string[],
  apiKey: string,
  fetcher: Fetcher = safeFetch,
): Promise<OpenPageRankResult[]> {
  const unique = [
    ...new Set(
      domains
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    ),
  ]
  if (unique.length === 0 || unique.length > 100) {
    throw new DomainMetricProviderError(
      "OPEN_PAGE_RANK",
      "INVALID_REQUEST",
      "OpenPageRank requires between 1 and 100 unique domains",
    )
  }
  if (!apiKey.trim()) {
    throw new DomainMetricProviderError(
      "OPEN_PAGE_RANK",
      "NOT_CONFIGURED",
      "OpenPageRank API key is not configured",
    )
  }
  const response = await fetcher(
    "https://openpagerank.keywordseverywhere.com/v1/domains/bulk",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domains: unique, include_history: false }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    },
  )
  const data = await readJson("OPEN_PAGE_RANK", response)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(data?.as_of) ||
    !Array.isArray(data?.results) ||
    !Array.isArray(data?.invalid) ||
    !Number.isSafeInteger(data?.count) ||
    data.count !== data.results.length ||
    data.count > unique.length ||
    data.invalid.some((value: unknown) => typeof value !== "string")
  ) {
    throw new DomainMetricProviderError(
      "OPEN_PAGE_RANK",
      "INVALID_RESPONSE",
      "OpenPageRank response shape was invalid",
    )
  }
  const asOf = new Date(`${data.as_of}T00:00:00.000Z`)
  if (
    !Number.isFinite(asOf.getTime()) ||
    asOf.toISOString().slice(0, 10) !== data.as_of ||
    asOf.getTime() > Date.now()
  ) {
    throw new DomainMetricProviderError(
      "OPEN_PAGE_RANK",
      "INVALID_RESPONSE",
      "OpenPageRank returned an invalid as-of date",
    )
  }

  const projected = new Map<string, OpenPageRankResult>()
  for (const row of data.results as any[]) {
    const responseDomain =
      typeof row?.domain === "string" ? row.domain.trim().toLowerCase() : ""
    // The provider reduces subdomains to their registered domain. Prefer an
    // exact match, then project a valid multi-label parent only onto inputs
    // that are its DNS descendants.
    const exactInputs = unique.filter((domain) => domain === responseDomain)
    const matchingInputs =
      exactInputs.length > 0 || !responseDomain.includes(".")
        ? exactInputs
        : unique.filter((domain) => domain.endsWith(`.${responseDomain}`))
    const score = row?.open_page_rank
    const rank = row?.rank
    const referringDomains = row?.referring_domains
    if (
      !responseDomain ||
      matchingInputs.length === 0 ||
      typeof row?.found !== "boolean" ||
      (row.found &&
        (typeof score !== "number" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 10)) ||
      (row.found &&
        rank != null &&
        (!Number.isSafeInteger(rank) || Number(rank) < 1)) ||
      (row.found &&
        referringDomains != null &&
        (!Number.isSafeInteger(referringDomains) ||
          Number(referringDomains) < 0))
    ) {
      throw new DomainMetricProviderError(
        "OPEN_PAGE_RANK",
        "INVALID_RESPONSE",
        "OpenPageRank returned an invalid metric value",
      )
    }
    for (const domain of matchingInputs) {
      if (projected.has(domain)) {
        throw new DomainMetricProviderError(
          "OPEN_PAGE_RANK",
          "INVALID_RESPONSE",
          "OpenPageRank returned duplicate results for a domain",
        )
      }
      projected.set(domain, {
        domain,
        found: row.found,
        openPageRank: row.found ? score : null,
        globalRank: row.found && rank != null ? Number(rank) : null,
        referringDomains:
          row.found && referringDomains != null
            ? Number(referringDomains)
            : null,
        asOf,
      })
    }
  }

  return unique.map(
    (domain) =>
      projected.get(domain) ?? {
        domain,
        found: false,
        openPageRank: null,
        globalRank: null,
        referringDomains: null,
        asOf,
      },
  )
}
