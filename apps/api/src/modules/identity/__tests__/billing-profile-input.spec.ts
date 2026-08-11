import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { UpdateBillingProfileDto } from "../dto/update-billing-profile.dto"

const validInput = {
  legalName: "Cafe\u0301 株式会社",
  billingEmail: "accounts@example.com",
  addressLine1: "示例路 42号",
  city: "서울",
  postalCode: "100-0001",
  countryCode: "jp",
}

describe("UpdateBillingProfileDto Unicode safety", () => {
  it("accepts and NFC-normalizes printable multilingual billing identity", async () => {
    const input = plainToInstance(UpdateBillingProfileDto, {
      ...validInput,
      legalName: `${validInput.legalName} شرکت می‌رود ক্‍ষ`,
    })

    await expect(validate(input)).resolves.toEqual([])
    expect(input.legalName).toBe("Café 株式会社 شرکت می‌رود ক্‍ষ")
    expect(input.countryCode).toBe("JP")
  })

  it.each([
    "Acme <script>",
    "Acme\u202Eevil",
    "Acme\uD800",
    "Acme\u200DCorp",
    "\u200Cشرکت",
  ])("rejects unsafe legal-name text %p", async (legalName) => {
    const input = plainToInstance(UpdateBillingProfileDto, {
      ...validInput,
      legalName,
    })

    expect(await validate(input)).not.toHaveLength(0)
  })
})
