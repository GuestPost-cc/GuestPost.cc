-- Marketplace taxonomy v2: a listing can have 1-7 normalized categories and
-- exactly one primary language/policy value. Existing policy fields remain
-- NULL until the inventory owner reviews them; application submission gates
-- prevent an unspecified listing from entering moderation.

CREATE TYPE "ListingLinkType" AS ENUM (
  'DOFOLLOW',
  'NOFOLLOW',
  'SPONSORED',
  'UGC'
);

CREATE TYPE "ListingLinkValidity" AS ENUM (
  'PERMANENT',
  'FIVE_YEARS',
  'ONE_YEAR',
  'SIX_MONTHS',
  'THREE_MONTHS'
);

ALTER TABLE "MarketplaceListing"
  ADD COLUMN "sportsGamingAllowed" BOOLEAN,
  ADD COLUMN "pharmacyAllowed" BOOLEAN,
  ADD COLUMN "cryptoAllowed" BOOLEAN,
  ADD COLUMN "backlinkCount" INTEGER,
  ADD COLUMN "linkType" "ListingLinkType",
  ADD COLUMN "linkValidity" "ListingLinkValidity",
  ADD COLUMN "googleNews" BOOLEAN,
  ADD COLUMN "markedSponsored" BOOLEAN,
  ADD COLUMN "foreignLanguageAllowed" BOOLEAN;

ALTER TABLE "MarketplaceListing"
  ADD CONSTRAINT "MarketplaceListing_backlinkCount_check"
  CHECK ("backlinkCount" IS NULL OR "backlinkCount" BETWEEN 1 AND 3);

CREATE TABLE "MarketplaceListingCategory" (
  "listingId" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketplaceListingCategory_pkey"
    PRIMARY KEY ("listingId", "categoryId")
);

CREATE INDEX "MarketplaceListingCategory_categoryId_listingId_idx"
  ON "MarketplaceListingCategory"("categoryId", "listingId");

ALTER TABLE "MarketplaceListingCategory"
  ADD CONSTRAINT "MarketplaceListingCategory_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "MarketplaceListing"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MarketplaceListingCategory"
  ADD CONSTRAINT "MarketplaceListingCategory_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "MarketplaceCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_marketplace_listing_category_limit"()
RETURNS TRIGGER AS $$
BEGIN
  -- Serialize category changes for the same listing so concurrent inserts
  -- cannot both observe six rows and exceed the invariant.
  PERFORM 1
  FROM "MarketplaceListing"
  WHERE "id" = NEW."listingId"
  FOR UPDATE;

  IF (
    SELECT COUNT(*)
    FROM "MarketplaceListingCategory"
    WHERE "listingId" = NEW."listingId"
  ) >= 7 THEN
    RAISE EXCEPTION 'A marketplace listing may have at most 7 categories'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MarketplaceListingCategory_max_seven"
BEFORE INSERT ON "MarketplaceListingCategory"
FOR EACH ROW
EXECUTE FUNCTION "enforce_marketplace_listing_category_limit"();

-- Only the reviewed taxonomy remains selectable. Historical categories stay
-- in the table so old relationships are never silently discarded.
UPDATE "MarketplaceCategory" SET "isActive" = FALSE;

WITH taxonomy(name, sort_order) AS (
  SELECT item.name, item.ordinality::INTEGER
  FROM jsonb_array_elements_text(
    '[
      "Agriculture & Farming",
      "Animals & Pets",
      "Artificial Intelligence & AI Tools",
      "Arts, Photography & Videography",
      "Astrology",
      "Automobiles & Cars",
      "Aviation & Aerospace",
      "Banking & Finance",
      "Beauty",
      "Blockchain, Crypto & Web3",
      "Books & Literature",
      "Business",
      "Casino (Gambling)",
      "CBD & Hemp",
      "Charity & Non-Profit",
      "Computers & Consumer Electronics",
      "Construction & Repairs",
      "Crafts and DIY",
      "Culture & Society",
      "Cybersecurity",
      "Digital Marketing & Advertising",
      "E-commerce",
      "Education",
      "Electric Vehicles (EV)",
      "Energy (Oil, Gas & Nuclear)",
      "Entertainment, Movies & TV",
      "Environment & Nature",
      "Fashion",
      "Fintech",
      "Food & Beverages",
      "Football (Soccer)",
      "For Men",
      "For Women",
      "Gaming",
      "Gardening and Lawn Care",
      "General",
      "Golf",
      "Graphics & Design",
      "Health & Fitness",
      "Hobbies & Leisure",
      "Home & Decor",
      "Home Improvement",
      "Home Services",
      "Human Resources (HR)",
      "Industrial Equipment & Machinery",
      "Insurance",
      "Internet & Telecom",
      "Jobs & Employment",
      "Kids & Children",
      "Legal",
      "Lifestyle",
      "Local & City Guides",
      "Magazines & Newspapers",
      "Manufacturing & Industry",
      "Meditation",
      "Mental Health",
      "Mobile",
      "Music & Instruments",
      "News, Media & Magazines",
      "Nutrition & Supplements",
      "Other (Miscellaneous)",
      "Outdoors",
      "Parenting & Family",
      "Personal Development & Motivation",
      "Pharmacy",
      "Politics",
      "Real Estate",
      "Relationships",
      "Renewable Energy & Solar",
      "Review Sites",
      "SaaS",
      "Science",
      "Senior & Elder Care",
      "Services & Consulting",
      "Shopping",
      "Social Media",
      "Software Development",
      "Spirituality",
      "Sports",
      "Startups & Entrepreneurship",
      "Technology & Gadgets",
      "Tourism & Travel",
      "Trading (Forex & Stocks)",
      "Transport & Logistics",
      "Web Development",
      "Wedding & Event Planning",
      "Yoga & Wellness"
    ]'::jsonb
  ) WITH ORDINALITY AS item(name, ordinality)
), normalized AS (
  SELECT
    name,
    sort_order,
    trim(BOTH '-' FROM regexp_replace(
      regexp_replace(lower(name), '&', ' and ', 'g'),
      '[^a-z0-9]+', '-', 'g'
    )) AS slug
  FROM taxonomy
)
INSERT INTO "MarketplaceCategory" (
  "id", "name", "slug", "sortOrder", "isActive", "createdAt", "updatedAt"
)
SELECT
  'marketplace-category-v2-' || md5(name),
  name,
  slug,
  sort_order,
  TRUE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM normalized
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "sortOrder" = EXCLUDED."sortOrder",
  "isActive" = TRUE,
  "updatedAt" = CURRENT_TIMESTAMP;

-- Preserve every existing category assignment before removing the legacy
-- single-category foreign key.
INSERT INTO "MarketplaceListingCategory" ("listingId", "categoryId")
SELECT "id", "categoryId"
FROM "MarketplaceListing"
WHERE "categoryId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Map the three legacy seed categories to their closest reviewed taxonomy
-- values. Production-only custom categories remain attached but inactive
-- until an owner chooses one of the reviewed categories.
WITH mapping(old_slug, new_slug) AS (
  VALUES
    ('technology', 'technology-and-gadgets'),
    ('health-wellness', 'health-and-fitness'),
    ('finance', 'banking-and-finance')
)
INSERT INTO "MarketplaceListingCategory" ("listingId", "categoryId")
SELECT link."listingId", replacement."id"
FROM "MarketplaceListingCategory" link
JOIN "MarketplaceCategory" legacy ON legacy."id" = link."categoryId"
JOIN mapping ON mapping.old_slug = legacy."slug"
JOIN "MarketplaceCategory" replacement ON replacement."slug" = mapping.new_slug
ON CONFLICT DO NOTHING;

WITH legacy_ids AS (
  SELECT "id"
  FROM "MarketplaceCategory"
  WHERE "slug" IN ('technology', 'health-wellness', 'finance')
)
DELETE FROM "MarketplaceListingCategory"
WHERE "categoryId" IN (SELECT "id" FROM legacy_ids);

ALTER TABLE "MarketplaceListing"
  DROP CONSTRAINT "MarketplaceListing_categoryId_fkey";

DROP INDEX "MarketplaceListing_categoryId_idx";

ALTER TABLE "MarketplaceListing" DROP COLUMN "categoryId";
