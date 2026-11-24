-- CreateEnum
CREATE TYPE "DealBagStatus" AS ENUM ('OPEN', 'CHECKED_OUT', 'CLOSED');

-- AlterTable
ALTER TABLE "NegotiationSession" ADD COLUMN     "dealBagId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "multiDealDiscounts" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
ADD COLUMN     "multiDealNextMessage" TEXT,
ADD COLUMN     "multiDealSavedMessage" TEXT,
ADD COLUMN     "multiDealsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "DealBag" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT,
    "anonymousId" TEXT,
    "draftOrderId" TEXT NOT NULL,
    "checkoutUrl" TEXT NOT NULL,
    "extraDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "status" "DealBagStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealBag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealBag_shopId_customerId_idx" ON "DealBag"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "DealBag_shopId_anonymousId_idx" ON "DealBag"("shopId", "anonymousId");

-- CreateIndex
CREATE INDEX "NegotiationSession_dealBagId_idx" ON "NegotiationSession"("dealBagId");

-- AddForeignKey
ALTER TABLE "DealBag" ADD CONSTRAINT "DealBag_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NegotiationSession" ADD CONSTRAINT "NegotiationSession_dealBagId_fkey" FOREIGN KEY ("dealBagId") REFERENCES "DealBag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

