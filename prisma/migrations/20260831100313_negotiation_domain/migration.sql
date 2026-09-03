-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('ALWAYS_ON', 'DWELL_TIME', 'EXIT_INTENT', 'PAGE_REVISIT', 'COHORT_EMAIL');

-- CreateEnum
CREATE TYPE "CheckoutMechanism" AS ENUM ('DRAFT_ORDER');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "NegotiationSessionStatus" AS ENUM ('ACTIVE', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "NegotiationActor" AS ENUM ('CUSTOMER', 'BOT');

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "planHandle" TEXT;

-- CreateTable
CREATE TABLE "NegotiationSettings" (
    "shopId" TEXT NOT NULL,
    "maxDiscountPercent" DECIMAL(5,2) NOT NULL,
    "defaultLadderId" TEXT,
    "checkoutMechanism" "CheckoutMechanism" NOT NULL DEFAULT 'DRAFT_ORDER',
    "enabledTriggers" "TriggerType"[],
    "dwellTimeSeconds" INTEGER,
    "greetingTemplate" TEXT,
    "acceptedTemplate" TEXT,
    "floorReachedTemplate" TEXT,
    "rateLimitedTemplate" TEXT,
    "expiredTemplate" TEXT,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "widgetPosition" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationSettings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "Ladder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ladder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LadderStep" (
    "id" TEXT NOT NULL,
    "ladderId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "discountType" "DiscountType" NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "messageTemplate" TEXT,

    CONSTRAINT "LadderStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxDiscountPercentOverride" DECIMAL(5,2),
    "floorPriceOverride" DECIMAL(10,2),
    "ladderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegotiationSession" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT,
    "anonymousId" TEXT,
    "status" "NegotiationSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggerType" "TriggerType" NOT NULL,
    "currentRound" INTEGER NOT NULL DEFAULT 0,
    "startingPrice" DECIMAL(10,2) NOT NULL,
    "currentOfferPrice" DECIMAL(10,2),
    "ladderIdSnapshot" TEXT,
    "checkoutMechanism" "CheckoutMechanism" NOT NULL DEFAULT 'DRAFT_ORDER',
    "draftOrderId" TEXT,
    "draftOrderExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegotiationOffer" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "actor" "NegotiationActor" NOT NULL,
    "offerPrice" DECIMAL(10,2),
    "messageText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NegotiationOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferLink" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "productId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LadderStep_ladderId_stepNumber_key" ON "LadderStep"("ladderId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSettings_shopId_productId_variantId_key" ON "ProductSettings"("shopId", "productId", "variantId");

-- CreateIndex
CREATE INDEX "NegotiationSession_shopId_status_idx" ON "NegotiationSession"("shopId", "status");

-- CreateIndex
CREATE INDEX "NegotiationSession_expiresAt_idx" ON "NegotiationSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OfferLink_token_key" ON "OfferLink"("token");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_shopId_key_windowStart_key" ON "RateLimitBucket"("shopId", "key", "windowStart");

-- AddForeignKey
ALTER TABLE "NegotiationSettings" ADD CONSTRAINT "NegotiationSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSettings" ADD CONSTRAINT "NegotiationSettings_defaultLadderId_fkey" FOREIGN KEY ("defaultLadderId") REFERENCES "Ladder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ladder" ADD CONSTRAINT "Ladder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LadderStep" ADD CONSTRAINT "LadderStep_ladderId_fkey" FOREIGN KEY ("ladderId") REFERENCES "Ladder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSettings" ADD CONSTRAINT "ProductSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSettings" ADD CONSTRAINT "ProductSettings_ladderId_fkey" FOREIGN KEY ("ladderId") REFERENCES "Ladder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSession" ADD CONSTRAINT "NegotiationSession_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationOffer" ADD CONSTRAINT "NegotiationOffer_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "NegotiationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferLink" ADD CONSTRAINT "OfferLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateLimitBucket" ADD CONSTRAINT "RateLimitBucket_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
