import { HttpClient } from "../client"
import { type DeliveryProofResponse, OrdersService } from "../services/orders"

describe("orders API contract", () => {
  it("preserves the canonical customer-manual delivery verification method", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const orders = new OrdersService(client)
    const proof = {
      hasDelivery: true,
      publishedUrl: "https://publisher.example/article",
      articleTitle: "Verified placement",
      screenshotUrl: null,
      verificationStatus: "FAILED",
      interventionStatus: "NONE",
      submittedAt: "2026-08-15T00:00:00.000Z",
      deliveredBy: "Publisher",
      verifyMethod: "CUSTOMER_MANUAL",
      autoAcceptAt: null,
      verifiedAt: "2026-08-15T01:00:00.000Z",
      pageTitle: "Verified placement",
      results: null,
      securityReview: null,
      capabilities: {
        canConfirm: false,
        canManualAccept: false,
        blockedReason: "WRONG_STATUS",
      },
    } satisfies DeliveryProofResponse
    const get = jest.spyOn(client, "get").mockResolvedValueOnce(proof)

    await expect(orders.deliveryProof("order-1")).resolves.toEqual(proof)
    expect(get).toHaveBeenCalledWith("/orders/order-1/delivery-proof")
  })
})
