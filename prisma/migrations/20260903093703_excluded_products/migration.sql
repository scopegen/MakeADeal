-- AlterTable
ALTER TABLE "NegotiationRule" ADD COLUMN     "excludedProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
