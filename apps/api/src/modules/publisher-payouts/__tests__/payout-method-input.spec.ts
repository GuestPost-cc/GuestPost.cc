import "reflect-metadata"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import { CreatePayoutMethodDto } from "../dto/create-payout-method.dto"
import { normalizePayoutMethodInput } from "../payout-method-input"

describe("payout method input", () => {
  it("normalizes an exact bank-transfer destination", () => {
    expect(
      normalizePayoutMethodInput({
        type: "bank_transfer",
        label: "  Main USD account  ",
        details: {
          bankName: "  Example Bank ",
          accountHolderName: " Publisher LLC ",
          accountNumber: " 12345678 ",
          swift: "ABCDEFGH",
        },
        isDefault: true,
      }),
    ).toEqual({
      type: "bank_transfer",
      label: "Main USD account",
      details: {
        bankName: "Example Bank",
        accountHolderName: "Publisher LLC",
        accountNumber: "12345678",
        swift: "ABCDEFGH",
      },
      isDefault: true,
    })
  })

  it.each([
    {
      type: "bank_transfer",
      label: "Bank",
      details: { accountNumber: "1234" },
    },
    {
      type: "paypal",
      label: "PayPal",
      details: { email: "not-an-email" },
    },
    {
      type: "wise",
      label: "Wise",
      details: { recipientId: "recipient-1", currency: "usd" },
    },
    {
      type: "paypal",
      label: "PayPal",
      details: { email: "owner@example.com", accountNumber: "1234" },
    },
  ])("rejects an incomplete or ambiguous rail-specific payload", (input) => {
    expect(() =>
      normalizePayoutMethodInput(input as CreatePayoutMethodDto),
    ).toThrow()
  })

  it("rejects nested properties through the HTTP validation contract", async () => {
    const input = plainToInstance(CreatePayoutMethodDto, {
      type: "paypal",
      label: "PayPal",
      details: {
        email: "owner@example.com",
        accessToken: "must-never-be-stored",
      },
    })

    const errors = await validate(input, {
      whitelist: true,
      forbidNonWhitelisted: true,
    })

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          property: "details",
          children: expect.arrayContaining([
            expect.objectContaining({ property: "accessToken" }),
          ]),
        }),
      ]),
    )
  })
})
