import {
  issueFinancialDocumentForCommunication,
  normalizeFinancialMoney,
} from "../financial-document-outbox-core"
import {
  expectedFinancialDocumentKind,
  financialDocumentIdFromEventPayload,
  financialDocumentIssuerFromEnv,
  financialDocumentSnapshotSchema,
  formatFinancialDocumentNumber,
} from "../financial-documents"

describe("financial documents", () => {
  const paidOrderEvent = {
    type: "ORDER_PAYMENT_CAPTURED" as const,
    aggregateType: "Order",
    aggregateId: "order-1",
    organizationId: "org-1",
    title: "Payment received",
    message: "100.00 USD was paid.",
    dedupKey: "order:order-1:payment-captured",
    recipientUserIds: ["user-1"],
  }

  const personalDepositEvent = {
    type: "BILLING_DEPOSIT_SUCCEEDED" as const,
    aggregateType: "DepositAttempt",
    aggregateId: "deposit-1",
    organizationId: null,
    title: "Wallet deposit completed",
    message: "100.00 USD was added to your wallet.",
    dedupKey: "deposit:deposit-1:succeeded",
    recipientUserIds: ["user-1"],
  }

  function financialDocumentDb() {
    let winner: any = null
    const db = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: "order-1",
          customerId: "user-1",
          type: "GUEST_POST",
          amount: "100.00",
          currency: "USD",
          organization: {
            id: "org-1",
            name: "Acme",
            billingProfile: null,
            memberships: [{ userId: "owner-1" }],
          },
        }),
      },
      depositAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          organizationId: null,
          createdByUserId: "user-1",
          amount: "100.00",
          walletCredit: "100.00",
          currency: "USD",
          publicReference: "DP-PERSONAL-1",
          provider: "stripe",
          organization: null,
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          name: "Personal Customer",
          email: "personal@example.test",
        }),
      },
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: "refund-transaction-1",
          type: "REFUND",
          orderId: "order-1",
          amount: "100.00",
          currency: "USD",
          wallet: { organizationId: "org-1", currency: "USD" },
        }),
      },
      orderEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: "refund-event-1" }),
      },
      financialDocument: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockImplementation(async () => winner),
      },
      $executeRaw: jest
        .fn()
        .mockImplementation(async (_query: TemplateStringsArray, ...values) => {
          if (winner) return 0
          winner = {
            id: "document-winner",
            kind: values[1],
            numberPrefix: values[2],
            aggregateType: values[3],
            aggregateId: values[4],
            organizationId: values[5],
            relatedDocumentId: values[6],
            currency: values[7],
            subtotal: values[8],
            taxAmount: values[9],
            total: values[10],
            issuedAt: values[11],
            snapshot: JSON.parse(values[12]),
            dedupKey: values[13],
          }
          return 1
        }),
    }
    return {
      db,
      getWinner: () => winner,
      setWinner: (value: any) => (winner = value),
    }
  }

  it("maps only eligible customer financial events to attachments", () => {
    expect(expectedFinancialDocumentKind("ORDER_PAYMENT_CAPTURED")).toBe(
      "PAID_INVOICE",
    )
    expect(expectedFinancialDocumentKind("ORDER_REFUNDED")).toBe("CREDIT_NOTE")
    expect(expectedFinancialDocumentKind("SETTLEMENT_RELEASED")).toBeNull()
  })

  it("extracts a bounded document id only for eligible events", () => {
    expect(
      financialDocumentIdFromEventPayload("ORDER_PAYMENT_CAPTURED", {
        financialDocumentId: "document-1",
      }),
    ).toBe("document-1")
    expect(
      financialDocumentIdFromEventPayload("ORDER_ACCEPTED", {
        financialDocumentId: "document-1",
      }),
    ).toBeNull()
    expect(
      financialDocumentIdFromEventPayload("ORDER_PAYMENT_CAPTURED", {
        financialDocumentId: "",
      }),
    ).toBeNull()
  })

  it("formats stable sequential document numbers", () => {
    expect(
      formatFinancialDocumentNumber({
        kind: "PAID_INVOICE",
        numberPrefix: "gp",
        sequenceNumber: 42n,
        issuedAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toBe("GP-INV-2026-00000042")
  })

  it("normalizes exact money without silently rounding sub-cent values", () => {
    expect(normalizeFinancialMoney("42")).toBe("42.00")
    expect(normalizeFinancialMoney("42.5")).toBe("42.50")
    expect(normalizeFinancialMoney("42.5000")).toBe("42.50")
    expect(() => normalizeFinancialMoney("42.501")).toThrow(
      "sub-cent precision",
    )
    expect(() => normalizeFinancialMoney("-1")).toThrow("amount is invalid")
  })

  it("converges concurrent issuance on one database-arbitrated document", async () => {
    const { db } = financialDocumentDb()

    const [first, second] = await Promise.all([
      issueFinancialDocumentForCommunication(db, paidOrderEvent),
      issueFinancialDocumentForCommunication(db, paidOrderEvent),
    ])

    expect(first).toBe("document-winner")
    expect(second).toBe("document-winner")
    expect(db.$executeRaw).toHaveBeenCalledTimes(2)
    const sql = db.$executeRaw.mock.calls[0][0].join("?")
    expect(sql).toContain('ON CONFLICT ("dedupKey") DO NOTHING')
  })

  it("does not swallow a different dedup key colliding on aggregate identity", async () => {
    const { db } = financialDocumentDb()
    const aggregateConflict = Object.assign(
      new Error("unique aggregate identity conflict"),
      {
        code: "P2002",
        meta: {
          target: "FinancialDocument_kind_aggregateType_aggregateId_key",
        },
      },
    )
    db.$executeRaw.mockRejectedValueOnce(aggregateConflict)

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...paidOrderEvent,
        dedupKey: "order:order-1:payment-captured-another-command",
      }),
    ).rejects.toBe(aggregateConflict)
    expect(db.financialDocument.findUnique).not.toHaveBeenCalled()
  })

  it("fails closed when a deduplication key resolves to different immutable inputs", async () => {
    const { db, setWinner } = financialDocumentDb()
    setWinner({
      id: "conflicting-document",
      kind: "PAID_INVOICE",
      aggregateType: "Order",
      aggregateId: "another-order",
      organizationId: "org-1",
      currency: "USD",
      subtotal: "100.00",
      taxAmount: "0.00",
      total: "100.00",
    })

    await expect(
      issueFinancialDocumentForCommunication(db, paidOrderEvent),
    ).rejects.toThrow("conflicts with immutable inputs")
  })

  it.each([
    ["another tenant", { organizationId: "org-2" }],
    ["the wrong aggregate type", { aggregateType: "DepositAttempt" }],
  ])("rejects an event bound to %s", async (_, override) => {
    const { db } = financialDocumentDb()

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...paidOrderEvent,
        ...override,
      }),
    ).rejects.toThrow(/does not match source/)
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("rejects a publisher user from an order financial audience", async () => {
    const { db } = financialDocumentDb()

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...paidOrderEvent,
        recipientUserIds: ["user-1", "publisher-user-1"],
      }),
    ).rejects.toThrow("recipients are not authorized")
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("rejects an owner-only order audience that omits the payer", async () => {
    const { db } = financialDocumentDb()

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...paidOrderEvent,
        recipientUserIds: ["owner-1"],
      }),
    ).rejects.toThrow("principal recipient is missing")
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("issues a personal-wallet deposit receipt to the exact creator", async () => {
    const { db, getWinner } = financialDocumentDb()

    const id = await issueFinancialDocumentForCommunication(
      db,
      personalDepositEvent,
    )

    expect(id).toBe("document-winner")
    expect(getWinner()).toEqual(
      expect.objectContaining({
        aggregateType: "DepositAttempt",
        organizationId: null,
        snapshot: expect.objectContaining({
          recipient: expect.objectContaining({
            legalName: "Personal Customer",
            billingEmail: "personal@example.test",
          }),
        }),
      }),
    )
  })

  it.each([
    ["another organization", { organizationId: "org-2" }],
    ["another personal user", { recipientUserIds: ["user-2"] }],
    ["an empty audience", { recipientUserIds: [] }],
  ])("rejects a personal deposit receipt bound to %s", async (_, override) => {
    const { db } = financialDocumentDb()

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...personalDepositEvent,
        ...override,
      }),
    ).rejects.toThrow(
      /does not match source|not authorized|principal recipient/,
    )
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("falls back safely when a personal-wallet creator name is not invoice-safe", async () => {
    const { db, getWinner } = financialDocumentDb()
    db.user.findUnique.mockResolvedValue({
      name: "<script>Acme\u202E",
      email: "personal@example.test",
    })

    await issueFinancialDocumentForCommunication(db, personalDepositEvent)

    expect(getWinner()?.snapshot.recipient).toEqual(
      expect.objectContaining({
        legalName: "GuestPost.cc customer",
        billingEmail: "personal@example.test",
      }),
    )
  })

  it("binds a credit note to exact refund ledger and tenant evidence", async () => {
    const { db, getWinner } = financialDocumentDb()
    const id = await issueFinancialDocumentForCommunication(db, {
      ...paidOrderEvent,
      type: "ORDER_REFUNDED",
      dedupKey: "order:order-1:refunded",
      payload: {
        amount: "100.00",
        currency: "USD",
        refundTransactionId: "refund-transaction-1",
      },
    })

    expect(id).toBe("document-winner")
    expect(getWinner()).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        snapshot: expect.objectContaining({
          payment: expect.objectContaining({
            reference: "Refund refund-transaction-1",
          }),
        }),
      }),
    )
  })

  it.each([
    ["amount", { amount: "99.00" }],
    ["currency", { currency: "EUR" }],
    ["wallet tenant", { wallet: { organizationId: "org-2", currency: "USD" } }],
  ])("rejects tampered refund %s evidence", async (_, refundOverride) => {
    const { db } = financialDocumentDb()
    db.transaction.findUnique.mockResolvedValue({
      id: "refund-transaction-1",
      type: "REFUND",
      orderId: "order-1",
      amount: "100.00",
      currency: "USD",
      wallet: { organizationId: "org-1", currency: "USD" },
      ...refundOverride,
    })

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...paidOrderEvent,
        type: "ORDER_REFUNDED",
        dedupKey: "order:order-1:refunded",
        payload: {
          amount: "100.00",
          currency: "USD",
          refundTransactionId: "refund-transaction-1",
        },
      }),
    ).rejects.toThrow("refund ledger evidence does not match order")
  })

  it("rejects a credit note without matching REFUND_ISSUED ledger evidence", async () => {
    const { db } = financialDocumentDb()
    db.orderEvent.findFirst.mockResolvedValue(null)

    await expect(
      issueFinancialDocumentForCommunication(db, {
        ...paidOrderEvent,
        type: "ORDER_REFUNDED",
        dedupKey: "order:order-1:refunded",
        payload: {
          amount: "100.00",
          currency: "USD",
          refundTransactionId: "refund-transaction-1",
        },
      }),
    ).rejects.toThrow("refund ledger evidence does not match order")
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it("fails closed when production issuer data is incomplete", () => {
    expect(() =>
      financialDocumentIssuerFromEnv({ NODE_ENV: "production" }),
    ).toThrow("issuer configuration is incomplete")
  })

  it("requires an explicit production document-number prefix", () => {
    expect(() =>
      financialDocumentIssuerFromEnv({
        NODE_ENV: "production",
        INVOICE_ISSUER_LEGAL_NAME: "GuestPost.cc Inc.",
        INVOICE_ISSUER_ADDRESS_LINE_1: "100 Marketplace Avenue",
        INVOICE_ISSUER_CITY: "Austin",
        INVOICE_ISSUER_POSTAL_CODE: "78701",
        INVOICE_ISSUER_COUNTRY_CODE: "US",
        INVOICE_SUPPORT_EMAIL: "billing@guestpost.cc",
      }),
    ).toThrow("INVOICE_DOCUMENT_PREFIX")
  })

  it("uses an unmistakable non-production identity when unconfigured", () => {
    const issuer = financialDocumentIssuerFromEnv({ NODE_ENV: "test" })
    expect(issuer.environment).toBe("NON_PRODUCTION")
    expect(issuer.party.legalName).toContain("development sample")
  })

  it("allows a prefix-only development configuration to use the sample identity", () => {
    const issuer = financialDocumentIssuerFromEnv({
      NODE_ENV: "development",
      INVOICE_DOCUMENT_PREFIX: "GP",
    })
    expect(issuer.environment).toBe("NON_PRODUCTION")
    expect(issuer.numberPrefix).toBe("GP")
    expect(issuer.party.legalName).toContain("development sample")
  })

  it("normalizes multilingual billing text and rejects invisible controls", () => {
    const parsed = financialDocumentSnapshotSchema.parse({
      schemaVersion: 1,
      environment: "PRODUCTION",
      issuer: {
        legalName: "GuestPost.cc",
        billingEmail: "support@guestpost.cc",
        addressLine1: "1 Platform Way",
        city: "Austin",
        postalCode: "78701",
        countryCode: "US",
      },
      recipient: { legalName: "অ্যাকমে 株式会社 Пример شرکت می‌رود ক্‍ষ" },
      lineItems: [
        {
          description: "Guest post service",
          quantity: 1,
          unitAmount: "100.00",
          lineTotal: "100.00",
        },
      ],
      payment: {
        status: "PAID",
        method: "GuestPost.cc wallet",
        reference: "Order order-1",
      },
      tax: {
        label: "Tax",
        treatment: "NOT_SEPARATELY_CHARGED",
        note: "No tax was separately charged on this document.",
      },
      notes: [],
    })
    expect(parsed.recipient.legalName).toBe(
      "অ্যাকমে 株式会社 Пример شرکت می‌رود ক্‍ষ",
    )
    for (const legalName of [
      "Acme\u202Efdp.exe",
      "Acme\u200DCorp",
      "\u200Cشرکت",
    ]) {
      expect(() =>
        financialDocumentSnapshotSchema.parse({
          ...parsed,
          recipient: { legalName },
        }),
      ).toThrow("unsafe or invisible control")
    }
  })
})
