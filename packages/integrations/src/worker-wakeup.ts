let nextWakeAllowedAt = 0
let inFlight: Promise<void> | null = null

/** Best-effort signal only; the BullMQ job must be committed first. */
export function wakeOnDemandWorker(): void {
  const urlValue = process.env.WORKER_ON_DEMAND_TRIGGER_URL?.trim()
  const token = process.env.WORKER_ON_DEMAND_TRIGGER_TOKEN?.trim()
  if (!urlValue || !token || inFlight || Date.now() < nextWakeAllowedAt) return

  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    return
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (process.env.NODE_ENV === "production" &&
      (url.protocol !== "https:" ||
        url.hostname !== "api.northflank.com" ||
        (url.port !== "" && url.port !== "443") ||
        !/^\/v1\/(?:teams\/[^/]+\/)?projects\/[^/]+\/jobs\/[^/]+\/runs\/?$/.test(
          url.pathname,
        )))
  ) {
    return
  }

  const debounceMs = Number(
    process.env.WORKER_ON_DEMAND_TRIGGER_DEBOUNCE_MS ?? 15_000,
  )
  nextWakeAllowedAt =
    Date.now() +
    (Number.isSafeInteger(debounceMs) && debounceMs > 0 ? debounceMs : 15_000)
  inFlight = fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (response) => {
      await response.body?.cancel().catch(() => undefined)
    })
    .catch(() => undefined)
    .finally(() => {
      inFlight = null
    })
}
