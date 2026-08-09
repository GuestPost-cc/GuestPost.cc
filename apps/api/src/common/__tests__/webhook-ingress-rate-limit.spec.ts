import { readFileSync } from "node:fs"
import { join } from "node:path"
import express from "express"
import request from "supertest"
import {
  createWebhookIngressLimiter,
  isSignedWebhookIngressRequest,
  SIGNED_WEBHOOK_INGRESS_PATHS,
  WEBHOOK_INGRESS_RATE_LIMIT_CEILING,
} from "../webhook-ingress-rate-limit"

function ingressRequest(method: string, originalUrl: string) {
  return { method, originalUrl }
}

function makeIngressApp(max = 2) {
  const app = express()
  app.set("trust proxy", 1)
  app.use(createWebhookIngressLimiter(max))
  app.use((_req, res) => res.status(204).end())
  return app
}

describe("signed webhook ingress rate limiting", () => {
  describe("exact route classification", () => {
    it.each(
      SIGNED_WEBHOOK_INGRESS_PATHS,
    )("classifies POST %s as signed webhook ingress", (path) => {
      expect(isSignedWebhookIngressRequest(ingressRequest("POST", path))).toBe(
        true,
      )
      expect(
        isSignedWebhookIngressRequest(
          ingressRequest("post", `${path}?provider_delivery=retry`),
        ),
      ).toBe(true)
    })

    it.each([
      ["GET", "/api/v1/billing/webhook/stripe"],
      ["PUT", "/api/v1/payout-webhooks/wise"],
      ["POST", "/api/v1/billing/webhook"],
      ["POST", "/api/v1/billing/webhook/stripe/"],
      ["POST", "/api/v1/billing/webhook/stripe-forged"],
      ["POST", "/api/v1/payout-webhooks/stripe_connect"],
      ["POST", "/api/v1/payout-webhooks/stripe_connect/"],
      ["POST", "/api/v1/payout-webhooks/stripe_connect/platform/"],
      ["POST", "/api/v1/payout-webhooks/stripe_connect/platform/extra"],
      ["POST", "/api/v1/payout-webhooks/stripe_connect/connected-forged"],
      ["POST", "/api/v1/payout-webhooks/wise/extra"],
      ["POST", "/api/v1/payout-webhooks/wiser"],
      ["POST", "/api/v1/payout-webhooks%2Fwise"],
      ["POST", "/API/v1/payout-webhooks/wise"],
    ])("does not exempt %s %s", (method, path) => {
      expect(isSignedWebhookIngressRequest(ingressRequest(method, path))).toBe(
        false,
      )
    })
  })

  it("enforces a finite per-IP budget on an exact signed path", async () => {
    const app = makeIngressApp()
    const path = "/api/v1/payout-webhooks/wise"

    await request(app)
      .post(path)
      .set("X-Forwarded-For", "198.51.100.10")
      .expect(204)
    await request(app)
      .post(path)
      .set("X-Forwarded-For", "198.51.100.10")
      .expect(204)
    const limited = await request(app)
      .post(path)
      .set("X-Forwarded-For", "198.51.100.10")
      .expect(429)

    expect(limited.body).toEqual({
      statusCode: 429,
      message: "Too many webhook requests from this IP, try again later",
    })

    await request(app)
      .post(path)
      .set("X-Forwarded-For", "198.51.100.11")
      .expect(204)
  })

  it("does not consume the dedicated budget for a near-prefix route", async () => {
    const app = makeIngressApp(1)
    const path = "/api/v1/payout-webhooks/wise/extra"

    await request(app).post(path).expect(204)
    await request(app).post(path).expect(204)
  })

  it.each([
    0,
    -1,
    1.5,
    Number.POSITIVE_INFINITY,
    10_001,
  ])("rejects invalid or excessive max %s", (max) => {
    expect(() => createWebhookIngressLimiter(max)).toThrow(RangeError)
  })

  it("accepts both configured limiter boundaries", () => {
    expect(() => createWebhookIngressLimiter(1)).not.toThrow()
    expect(() =>
      createWebhookIngressLimiter(WEBHOOK_INGRESS_RATE_LIMIT_CEILING),
    ).not.toThrow()
  })

  describe("main bootstrap wiring", () => {
    const source = readFileSync(join(__dirname, "..", "..", "main.ts"), "utf8")

    it("counts signed routes in the dedicated limiter and skips only those routes in billing/global fallbacks", () => {
      const dedicatedIndex = source.indexOf(
        "server.use(createWebhookIngressLimiter(envLimits.webhookIngress))",
      )
      const billingIndex = source.indexOf('"/api/v1/billing"', dedicatedIndex)
      const marketplaceIndex = source.indexOf("// Marketplace", billingIndex)
      const globalIndex = source.indexOf("// Global fallback", marketplaceIndex)
      const corsIndex = source.indexOf("const configuredOrigins", globalIndex)

      expect(dedicatedIndex).toBeGreaterThan(-1)
      expect(billingIndex).toBeGreaterThan(dedicatedIndex)
      expect(source.slice(billingIndex, marketplaceIndex)).toContain(
        "isSignedWebhookIngressRequest(req)",
      )
      expect(source.slice(billingIndex, marketplaceIndex)).not.toContain(
        "startsWith",
      )
      expect(source.slice(globalIndex, corsIndex)).toContain(
        "skip: isSignedWebhookIngressRequest",
      )
    })

    it("runs the limiter before body parsing and preserves raw-body capture for signature verification", () => {
      const limiterIndex = source.indexOf(
        "server.use(createWebhookIngressLimiter(envLimits.webhookIngress))",
      )
      const jsonParserIndex = source.indexOf("express.json({")

      expect(limiterIndex).toBeGreaterThan(-1)
      expect(jsonParserIndex).toBeGreaterThan(limiterIndex)
      expect(source.slice(jsonParserIndex)).toContain("req.rawBody = buf")
    })
  })
})
