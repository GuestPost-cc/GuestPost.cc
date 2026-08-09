import assert from "node:assert/strict"
import test from "node:test"

test("preserves an oversized HTTP 200 body as a retryable fetch error", async () => {
  const { fetchWithChain } = await import("../src/delivery-verification-fetch")
  const fetchUrl = async () =>
    new Response("x".repeat(5 * 1024 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "text/html" },
    })

  const result = await fetchWithChain(
    "https://example.com/published-article",
    fetchUrl,
  )

  assert.equal(result.status, 200)
  assert.equal(result.html, "")
  assert.match(result.error ?? "", /^BODY_TOO_LARGE:/)
})
