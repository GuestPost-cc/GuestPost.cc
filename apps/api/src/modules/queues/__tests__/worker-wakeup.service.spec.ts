import { WorkerWakeupService } from "../worker-wakeup.service"

const ORIGINAL_ENV = { ...process.env }
const originalFetch = global.fetch

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  global.fetch = originalFetch
})

describe("WorkerWakeupService", () => {
  it("does nothing when on-demand orchestration is not configured", async () => {
    delete process.env.WORKER_ON_DEMAND_TRIGGER_URL
    delete process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN
    global.fetch = jest.fn() as any

    await new WorkerWakeupService().wake("report/generate")

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("sends only a credentialed, identifier-free wake signal", async () => {
    process.env.NODE_ENV = "production"
    process.env.WORKER_ON_DEMAND_TRIGGER_URL =
      "https://api.northflank.com/v1/projects/p/jobs/worker/runs"
    process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN = "scoped-secret"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    }) as any

    await new WorkerWakeupService().wake("payout-webhook")

    expect(global.fetch).toHaveBeenCalledWith(
      new URL(process.env.WORKER_ON_DEMAND_TRIGGER_URL),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer scoped-secret",
        }),
        body: JSON.stringify({}),
      }),
    )
    const serialized = JSON.stringify((global.fetch as jest.Mock).mock.calls)
    expect(serialized).not.toContain("payout-webhook")
  })

  it("refuses plaintext production trigger URLs", async () => {
    process.env.NODE_ENV = "production"
    process.env.WORKER_ON_DEMAND_TRIGGER_URL =
      "http://api.northflank.com/job/run"
    process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN = "scoped-secret"
    global.fetch = jest.fn() as any

    await new WorkerWakeupService().wake("report/generate")

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("refuses to send the Northflank token to another HTTPS host", async () => {
    process.env.NODE_ENV = "production"
    process.env.WORKER_ON_DEMAND_TRIGGER_URL =
      "https://attacker.example/v1/projects/p/jobs/worker/runs"
    process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN = "scoped-secret"
    global.fetch = jest.fn() as any

    await new WorkerWakeupService().wake("report/generate")

    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("treats trigger failure as non-fatal because catch-up is durable", async () => {
    process.env.WORKER_ON_DEMAND_TRIGGER_URL = "https://jobs.example/run"
    process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN = "scoped-secret"
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as any

    await expect(
      new WorkerWakeupService().wake("report/generate"),
    ).resolves.toBeUndefined()
  })
})
