-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "suggestionsIgnoredCollectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
