import {
  isWebsiteAddressListingTitle,
  validateWebsiteEnlistmentInput,
  validateWebsiteOrigin,
} from "../website-enlistment"

describe("website enlistment validation", () => {
  it.each([
    "https://example.com",
    "http://blog.example.co.uk/",
    "  https://news.example.com  ",
  ])("accepts a public root website URL: %s", (value) => {
    expect(validateWebsiteOrigin(value)).toBeNull()
  })

  it.each([
    "example.com",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com?preview=true",
    "https://example.com#section",
    "https://example.com:8443",
    "http://localhost:3000",
    "http://127.0.0.1",
    "https://invalid-.example.com",
    "https://invalid_domain.example.com",
  ])("rejects an unsafe or non-root website URL: %s", (value) => {
    expect(validateWebsiteOrigin(value)?.code).toBe("INVALID_WEBSITE_URL")
  })

  it.each([
    "example.com",
    "www.example.com",
    "https://example.com",
    "https://example.com/",
    "https://example.com/guest-posts",
  ])("recognizes a URL-like listing title: %s", (value) => {
    expect(isWebsiteAddressListingTitle(value)).toBe(true)
  })

  it("accepts a descriptive marketplace title", () => {
    expect(
      isWebsiteAddressListingTitle("Technology guest posts on Example"),
    ).toBe(false)
  })

  it("returns field-specific title and description issues", () => {
    const issues = validateWebsiteEnlistmentInput({
      url: "https://example.com",
      listingTitle: "example.com",
      description: "<script>alert(1)</script> Useful editorial description",
    })

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "listingTitle",
          code: "LISTING_TITLE_IS_WEBSITE_URL",
        }),
        expect.objectContaining({
          field: "description",
          code: "INVALID_LISTING_DESCRIPTION",
        }),
      ]),
    )
  })

  it("rejects unsafe optional website metadata", () => {
    const issues = validateWebsiteEnlistmentInput({
      url: "https://example.com",
      name: "<b>Example</b>",
      country: "United\nStates",
      listingTitle: "Technology guest posts on Example",
      description:
        "Editorial technology coverage for founders and software buyers.",
    })

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name" }),
        expect.objectContaining({ field: "country" }),
      ]),
    )
  })
})
