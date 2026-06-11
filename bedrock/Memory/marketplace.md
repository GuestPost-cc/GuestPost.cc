---
note_type: domain-memory
domain: marketplace
project: guestpost-platform
updated: 2026-06-11
---

# Marketplace

## Listing Discovery

Full marketplace with categories, tags, search history, AI recommendations, and fraud detection.

### Listing Statuses

`ListingStatus` enum governs listing lifecycle. `ListingFulfillmentType` defines service delivery model.

## Features

- Categories and tags for listing organization
- Reviews and favorites for social proof
- Saved lists for user curation
- Pricing tiers: fixed, starting_at, range, negotiable
- SEO metrics: domain rating (DR), traffic, referring domains, spam score
- AI-powered recommendations (`MarketplaceRecommendation`)
- Fraud detection flags (`MarketplaceFlag`)

## Key Models (17 total)

`MarketplaceCategory`, `MarketplaceTag`, `MarketplaceListing`, `MarketplaceListingTag`, `MarketplaceListingImage`, `MarketplacePricingTier`, `MarketplaceReview`, `MarketplaceFavorite`, `MarketplaceSavedList`, `MarketplaceSavedListItem`, `MarketplaceListingView`, `MarketplaceListingClick`, `MarketplaceSearchHistory`, `MarketplaceRecommendation`, `MarketplaceFlag`, `ListingFulfillmentRule`, `PublisherProfile`

## Key Files

- `apps/api/src/modules/marketplace/`
