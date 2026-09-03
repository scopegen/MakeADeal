-- CreateEnum
CREATE TYPE "RuleScopeType" AS ENUM ('ALL_PRODUCTS', 'COLLECTION', 'PRODUCT_GROUP');

-- DropForeignKey
ALTER TABLE "NegotiationSettings" DROP CONSTRAINT "NegotiationSettings_defaultLadderId_fkey";

-- DropForeignKey
ALTER TABLE "NegotiationSettings" DROP CONSTRAINT "NegotiationSettings_shopId_fkey";

-- DropForeignKey
ALTER TABLE "ProductSettings" DROP CONSTRAINT "ProductSettings_ladderId_fkey";

-- DropForeignKey
ALTER TABLE "ProductSettings" DROP CONSTRAINT "ProductSettings_shopId_fkey";

-- AlterTable
ALTER TABLE "NegotiationSession" ADD COLUMN     "ruleId" TEXT;

-- DropTable
DROP TABLE "NegotiationSettings";

-- DropTable
DROP TABLE "ProductSettings";

-- CreateTable
CREATE TABLE "NegotiationRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT,
    "scopeType" "RuleScopeType" NOT NULL DEFAULT 'ALL_PRODUCTS',
    "collectionId" TEXT,
    "collectionTitle" TEXT,
    "productIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxDiscountPercent" DECIMAL(5,2),
    "floorPriceOverride" DECIMAL(10,2),
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
    "headerTitle" TEXT,
    "headerSubtitle" TEXT,
    "launcherButtonText" TEXT,
    "sendButtonText" TEXT,
    "acceptButtonText" TEXT,
    "declineButtonText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegotiationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NegotiationRule_shopId_scopeType_idx" ON "NegotiationRule"("shopId", "scopeType");

-- AddForeignKey
ALTER TABLE "NegotiationRule" ADD CONSTRAINT "NegotiationRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationRule" ADD CONSTRAINT "NegotiationRule_defaultLadderId_fkey" FOREIGN KEY ("defaultLadderId") REFERENCES "Ladder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSession" ADD CONSTRAINT "NegotiationSession_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "NegotiationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

