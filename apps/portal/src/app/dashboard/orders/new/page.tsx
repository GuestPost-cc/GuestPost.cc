import { redirect } from "next/navigation"

const SAFE_CAMPAIGN_ID = /^[A-Za-z0-9_-]{1,128}$/

type LegacyOrderSearchParams = Promise<
  Record<string, string | string[] | undefined>
>

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export default async function LegacyNewOrderPage({
  searchParams,
}: {
  searchParams: LegacyOrderSearchParams
}) {
  const params = await searchParams
  const requestedCampaignId =
    firstValue(params.campaignId) ?? firstValue(params.campaign)
  const campaignId =
    requestedCampaignId && SAFE_CAMPAIGN_ID.test(requestedCampaignId)
      ? requestedCampaignId
      : null

  const marketplaceParams = new URLSearchParams()
  if (campaignId) {
    marketplaceParams.set("campaignId", campaignId)
  }

  redirect(
    marketplaceParams.size > 0
      ? `/dashboard/marketplace?${marketplaceParams.toString()}`
      : "/dashboard/marketplace",
  )
}
