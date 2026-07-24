import assert from "node:assert/strict"
import test from "node:test"
import {
  DomainMetricProviderError,
  fetchAhrefsDomainRating,
  fetchOpenPageRanks,
} from "../src/domain-metrics/providers"

test("Ahrefs free adapter uses the fixed official host and bearer auth", async () => {
  let requestedUrl = ""
  let requestedInit: RequestInit | undefined
  const fetcher = async (url: string, init?: RequestInit) => {
    requestedUrl = url
    requestedInit = init
    return new Response(
      JSON.stringify({ domain_rating: { domain_rating: 72.4 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }

  const rating = await fetchAhrefsDomainRating(
    "example.com",
    "server-only-key",
    fetcher as any,
  )

  assert.equal(rating, 72.4)
  const url = new URL(requestedUrl)
  assert.equal(url.origin, "https://api.ahrefs.com")
  assert.equal(url.pathname, "/v3/public/domain-rating-free")
  assert.equal(url.searchParams.get("target"), "example.com")
  assert.equal(
    (requestedInit?.headers as Record<string, string>).Authorization,
    "Bearer server-only-key",
  )
})

test("Ahrefs adapter rejects invalid provider values", async () => {
  await assert.rejects(
    fetchAhrefsDomainRating(
      "example.com",
      "key",
      (async () =>
        new Response(
          JSON.stringify({ domain_rating: { domain_rating: 101 } }),
          { status: 200 },
        )) as any,
    ),
    (error: unknown) =>
      error instanceof DomainMetricProviderError &&
      error.code === "INVALID_RESPONSE",
  )
})

test("OpenPageRank adapter uses the official bearer-authenticated bulk endpoint", async () => {
  let requestedUrl = ""
  let requestedInit: RequestInit | undefined
  const fetcher = async (url: string, init?: RequestInit) => {
    requestedUrl = url
    requestedInit = init
    return new Response(
      JSON.stringify({
        as_of: "2026-07-01",
        count: 2,
        results: [
          {
            found: true,
            open_page_rank: 6.75,
            rank: 42,
            referring_domains: 1234,
            domain: "example.com",
          },
          {
            found: false,
            open_page_rank: null,
            rank: null,
            referring_domains: null,
            domain: "missing.example",
          },
        ],
        invalid: [],
      }),
      { status: 200 },
    )
  }

  const result = await fetchOpenPageRanks(
    ["Example.com", "missing.example", "example.com"],
    "opr-key",
    fetcher as any,
  )

  const url = new URL(requestedUrl)
  assert.equal(url.origin, "https://openpagerank.keywordseverywhere.com")
  assert.equal(url.pathname, "/v1/domains/bulk")
  assert.equal(requestedInit?.method, "POST")
  assert.equal(
    (requestedInit?.headers as Record<string, string>).Authorization,
    "Bearer opr-key",
  )
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    domains: ["example.com", "missing.example"],
    include_history: false,
  })
  assert.equal(
    (requestedInit?.headers as Record<string, string>)["Content-Type"],
    "application/json",
  )
  assert.deepEqual(
    result.map((item) => ({
      domain: item.domain,
      found: item.found,
      score: item.openPageRank,
      rank: item.globalRank,
      referringDomains: item.referringDomains,
      asOf: item.asOf.toISOString(),
    })),
    [
      {
        domain: "example.com",
        found: true,
        score: 6.75,
        rank: 42,
        referringDomains: 1234,
        asOf: "2026-07-01T00:00:00.000Z",
      },
      {
        domain: "missing.example",
        found: false,
        score: null,
        rank: null,
        referringDomains: null,
        asOf: "2026-07-01T00:00:00.000Z",
      },
    ],
  )
})

test("OpenPageRank adapter rejects oversized batches before a network call", async () => {
  let called = false
  const domains = Array.from({ length: 101 }, (_, index) => `d${index}.example`)
  await assert.rejects(
    fetchOpenPageRanks(domains, "key", (async () => {
      called = true
      return new Response("{}")
    }) as any),
    (error: unknown) =>
      error instanceof DomainMetricProviderError &&
      error.code === "INVALID_REQUEST",
  )
  assert.equal(called, false)
})

test("OpenPageRank adapter rejects untrusted response dates and domains", async () => {
  await assert.rejects(
    fetchOpenPageRanks(
      ["example.com"],
      "key",
      (async () =>
        new Response(
          JSON.stringify({
            as_of: "2999-01-01",
            count: 1,
            results: [
              {
                domain: "unrequested.example",
                found: true,
                open_page_rank: 5,
                rank: 10,
                referring_domains: 20,
              },
            ],
            invalid: [],
          }),
          { status: 200 },
        )) as any,
    ),
    (error: unknown) =>
      error instanceof DomainMetricProviderError &&
      error.code === "INVALID_RESPONSE",
  )

  await assert.rejects(
    fetchOpenPageRanks(
      ["example.com"],
      "key",
      (async () =>
        new Response(
          JSON.stringify({
            as_of: "2026-07-01",
            count: 1,
            results: [
              {
                domain: "unrequested.example",
                found: true,
                open_page_rank: 5,
                rank: 10,
                referring_domains: 20,
              },
            ],
            invalid: [],
          }),
          { status: 200 },
        )) as any,
    ),
    (error: unknown) =>
      error instanceof DomainMetricProviderError &&
      error.code === "INVALID_RESPONSE",
  )
})
